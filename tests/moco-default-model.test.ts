import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHubConfig } from "../packages/hub/src/config";
import { MocoHub } from "../packages/hub/src/hub";
import { MocoStateDoc } from "../packages/hub/src/state";

const directories: string[] = [];
const hubs: MocoHub[] = [];

function tempState(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-default-model-"));
  directories.push(directory);
  return directory;
}

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    path.basename(String(file)) === ".env" ? false : exists(file),
  );
  vi.stubEnv("MOCO_MODEL", "");
  vi.stubEnv("MOCO_DEFAULT_PROVIDER", "");
  vi.stubEnv("MOCO_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("MOCO_HINDSIGHT_API_KEY", "");
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("default model selection", () => {
  it("starts unselected while preserving explicit environment defaults and empty overrides", () => {
    expect(resolveHubConfig().model).toMatchObject({ defaultModel: "" });
    expect(resolveHubConfig().model.defaultProvider || "").toBe("");
    vi.stubEnv("MOCO_MODEL", "configured-model");
    vi.stubEnv("MOCO_DEFAULT_PROVIDER", "api-configured");
    expect(resolveHubConfig().model).toMatchObject({
      defaultProvider: "api-configured", defaultModel: "configured-model",
    });
    expect(resolveHubConfig({ model: { defaultProvider: "", defaultModel: "" } }).model)
      .toMatchObject({ defaultProvider: "", defaultModel: "" });
  });

  it("persists a provider without selecting its first model and keeps clearing durable across restart", async () => {
    const stateDir = tempState();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "configured-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const init = {
      models,
      config: { stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    };
    const first = await openTestHub(init);
    hubs.push(first);
    const initial = first.getSettingsView().blocks.model;
    expect(initial.value.defaultModel).toBe("");
    const selectedProvider = await first.updateSettingsBlock("model", initial.revision, {
      ...initial.value,
      defaultProvider: "api-configured", defaultModel: "", gatewayDisabled: true,
      customProviders: [{ id: "api-configured", name: "Configured", api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "configured-model" }] }],
    });
    expect(selectedProvider.settings.blocks.model.value).toMatchObject({
      defaultProvider: "api-configured", defaultModel: "", gatewayDisabled: true,
    });
    const cleared = await first.updateSettingsBlock("model", selectedProvider.settings.blocks.model.revision, {
      defaultProvider: "", defaultModel: "",
    });
    expect(cleared.settings.blocks.model.value).toMatchObject({
      defaultProvider: "", defaultModel: "", gatewayDisabled: true,
    });
    await first.close();
    const second = await openTestHub(init);
    hubs.push(second);
    expect(second.getSettingsView().blocks.model.value).toMatchObject({
      defaultProvider: "", defaultModel: "", gatewayDisabled: true,
    });
  });

  it("rejects unconfigured sends before changing drafts or recording the request, then accepts the same request after selection", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "configured-model" }] });
    faux.setResponses([() => fauxAssistantMessage([fauxText("ok")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const hub = await openTestHub({
      models,
      config: { stateDir: tempState(), enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    });
    hubs.push(hub);
    const draft = await hub.createTopic();
    const before = (await hub.listTopics()).find((topic) => topic.id === draft.id);
    const options = { topicId: draft.id, requestId: "request-after-selection" };
    await expect(hub.sendUserMessage("send after choosing", options))
      .rejects.toMatchObject({ code: "model_not_selected", message: "请先选择供应商和模型，再发送消息。" });
    expect((await hub.listTopics()).find((topic) => topic.id === draft.id)).toEqual(before);
    expect((await hub.getTopicView(draft.id)).messages).toEqual([]);
    const state = await hub.harness.snapshot(MocoStateDoc);
    expect(state?.processedCommands?.[`req:${draft.id}:${options.requestId}`]).toBeUndefined();
    const block = hub.getSettingsView().blocks.model;
    await hub.updateSettingsBlock("model", block.revision, {
      defaultProvider: "openai", defaultModel: "configured-model", thinkingLevel: "off",
    });
    await expect(hub.sendUserMessage("send after choosing", options)).resolves.toBeDefined();
    expect((await hub.harness.snapshot(MocoStateDoc))?.processedCommands?.[`req:${draft.id}:${options.requestId}`])
      .toBeDefined();
  });

  it("preserves explicit legacy gateway selection and its configured models on restart", async () => {
    const stateDir = tempState();
    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "configured-model" }] });
    models.setProvider(faux.provider);
    const first = await openTestHub({ models, config: {
      stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
      model: { defaultModel: "configured-model", gatewayName: "Configured gateway",
        gatewayModels: [{ id: "configured-model", name: "Configured model" }] },
    } });
    hubs.push(first);
    expect(first.getSettingsView().blocks.model.value).toMatchObject({
      defaultModel: "configured-model", gatewayName: "Configured gateway",
      gatewayModels: [{ id: "configured-model", name: "Configured model" }],
    });
    await first.close();
    const second = await openTestHub({ models, config: {
      stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false }, model: { defaultModel: "" },
    } });
    hubs.push(second);
    expect(second.getSettingsView().blocks.model.value.defaultModel).toBe("configured-model");
    expect(second.getSettingsView().blocks.model.value.gatewayModels).toHaveLength(1);
  });
});
