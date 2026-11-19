import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHubConfig } from "../packages/hub/src/config";
import { MocoHub } from "../packages/hub/src/hub";
import { MocoSettingsDoc } from "../packages/hub/src/settings";
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

  it("disables moco-gateway by default on fresh install unless explicitly configured via env or overrides", async () => {
    expect(resolveHubConfig().model.gatewayDisabled).toBe(true);
    vi.stubEnv("MOCO_API_KEY", "sk-env-gateway-key");
    expect(resolveHubConfig().model.gatewayDisabled).toBeUndefined();
    vi.stubEnv("MOCO_API_KEY", "");

    const hub = await openTestHub({
      config: { stateDir: tempState(), enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    });
    hubs.push(hub);
    expect(hub.getSettingsView().blocks.model.value.gatewayDisabled).toBe(true);
    const catalog = await hub.listProviders();
    expect(catalog.some((p) => p.id === "moco-gateway")).toBe(false);
  });

  it("cascades cleanup to worker roles and voice bindings when removing a provider or model", async () => {
    const hub = await openTestHub({
      config: { stateDir: tempState(), enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    });
    hubs.push(hub);
    const initial = hub.getSettingsView();
    const added = await hub.updateSettingsBlock("model", initial.blocks.model.revision, {
      ...initial.blocks.model.value,
      defaultProvider: "api-demo",
      defaultModel: "demo-chat",
      customProviders: [{
        id: "api-demo",
        name: "Demo",
        api: "openai-completions",
        baseUrl: "https://demo.example/v1",
        models: [
          { id: "demo-chat", purpose: "chat" },
          { id: "demo-tts", purpose: "tts", protocolAdapter: "openai-speech", voices: ["alloy"] },
          { id: "demo-live", purpose: "live", protocolAdapter: "openai-realtime", voices: ["marin"] },
        ],
      }],
    });
    // Voice TTS & Live auto-bind to real configured models while staying disabled.
    const voiceAfterAdd = await hub.voice.snapshot();
    expect(voiceAfterAdd.tts).toMatchObject({ enabled: false, providerId: "api-demo", modelId: "demo-tts", voice: "alloy" });
    expect(voiceAfterAdd.call).toMatchObject({ enabled: false, providerId: "api-demo", modelId: "demo-live", voice: "marin" });

    // Bind a worker role to api-demo/demo-chat.
    const rolesRev = added.settings.blocks.roles.revision;
    const roleMap = { ...added.settings.blocks.roles.value };
    const firstRoleId = Object.keys(roleMap)[0]!;
    roleMap[firstRoleId] = { ...roleMap[firstRoleId]!, provider: "api-demo", modelId: "demo-chat", thinkingLevel: "high" };
    await hub.updateSettingsBlock("roles", rolesRev, roleMap);

    // Delete the custom provider and verify role, default model, and voice bindings clean up cleanly.
    const afterRemove = await hub.updateSettingsBlock("model", added.settings.blocks.model.revision, {
      ...added.settings.blocks.model.value,
      customProviders: [],
    });
    expect(afterRemove.settings.blocks.model.value.defaultProvider).toBe("");
    expect(afterRemove.settings.blocks.model.value.defaultModel).toBe("");
    const cleanedRole = afterRemove.settings.blocks.roles.value[firstRoleId]!;
    expect(cleanedRole.provider).toBeUndefined();
    expect(cleanedRole.modelId).toBeUndefined();
    expect(cleanedRole.thinkingLevel).toBe("auto");

    const voiceAfterRemove = await hub.voice.snapshot();
    expect(voiceAfterRemove.tts).toMatchObject({ enabled: false, modelId: "", voice: "" });
    expect(voiceAfterRemove.tts.providerId).toBeUndefined();
    expect(voiceAfterRemove.call).toMatchObject({ enabled: false, modelId: "", voice: "" });
    expect(voiceAfterRemove.call.providerId).toBeUndefined();
  });

  it("migrates legacy untouched empty moco-gateway to disabled on reopen while preserving configured gateways", async () => {
    const emptyDir = tempState();
    const first = await openTestHub({
      config: { stateDir: emptyDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    });
    await first.harness.commit(async (tx) => {
      const doc = await tx.doc(MocoSettingsDoc);
      delete doc.gatewayMigratedV2;
      delete doc.model.gatewayDisabled;
    }, BACKGROUND_CONTEXT);
    await first.close();

    const reopenedEmpty = await openTestHub({
      config: { stateDir: emptyDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    });
    hubs.push(reopenedEmpty);
    expect(reopenedEmpty.getSettingsView().blocks.model.value.gatewayDisabled).toBe(true);
    expect((await reopenedEmpty.listProviders()).some((p) => p.id === "moco-gateway")).toBe(false);

    // A legacy DB where the user DID configure gatewayModels keeps moco-gateway enabled.
    const usedDir = tempState();
    const usedFirst = await openTestHub({
      config: {
        stateDir: usedDir,
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { gatewayDisabled: false, gatewayModels: [{ id: "legacy-chat" }] },
      },
    });
    await usedFirst.harness.commit(async (tx) => {
      const doc = await tx.doc(MocoSettingsDoc);
      delete doc.gatewayMigratedV2;
    }, BACKGROUND_CONTEXT);
    await usedFirst.close();

    const reopenedUsed = await openTestHub({
      config: { stateDir: usedDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } },
    });
    hubs.push(reopenedUsed);
    expect(reopenedUsed.getSettingsView().blocks.model.value.gatewayDisabled).toBeUndefined();
    expect((await reopenedUsed.listProviders()).some((p) => p.id === "moco-gateway")).toBe(true);
  });
});
