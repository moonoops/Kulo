import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { CapabilityConfigurationInput, SettingsAssistantContext } from "@kulo/protocol";
import { KuloHub } from "../packages/hub/src/hub.js";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-assistant.js";

const cleanups: Array<() => void | Promise<void>> = [];
const context: SettingsAssistantContext = { module: "capabilities", appearance: "light", hasUnsavedChanges: false, clientId: "undo-client" };
const dummyKey = "synthetic-workspace-undo-key";
const answer = () => fauxAssistantMessage([fauxText("已处理。")]);
const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(directory?: string) {
  const root = directory ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-workspace-undo-")));
  if (!directory) cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "undo-model" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  let respond: () => ReturnType<typeof answer> = answer;
  provider.setResponses(Array.from({ length: 80 }, () => () => respond()));
  const hub = await openTestHub({ models, config: {
    stateDir: path.join(root, "state"), identityDir: path.join(root, "identity"), localEnvRoot: path.join(root, "runtime"),
    enableLocalEnv: false, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "undo-model", thinkingLevel: "off", apiKey: "" },
  } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await hub.close(); } };
  cleanups.push(close);
  let request = 0;
  const tool = async (id: string, name: string, args: Record<string, unknown>) => {
    let phase = 0;
    respond = () => ++phase === 1 ? call("kulo_capabilities_read", {}, `read-${++request}`) : phase === 2 ? call(name, args, id) : answer();
    await hub.settingsAssistant.send("执行已授权配置", context, `request-${++request}`);
    await vi.waitFor(async () => {
      const snapshot = await hub.settingsAssistant.getSnapshot();
      expect(phase).toBeGreaterThanOrEqual(3);
      expect(snapshot.live.busy).toBe(false);
      expect(snapshot.actions.some((action) => action.id === id)).toBe(true);
    }, { timeout: 8_000, interval: 20 });
    return (await hub.settingsAssistant.getSnapshot()).actions.find((action) => action.id === id)!;
  };
  return { hub, directory: root, close, tool };
}

async function configure(hub: KuloHub, commandId: string, extra: Partial<CapabilityConfigurationInput> = {}) {
  return hub.capabilities.configure({ commandId, name: "原名称", adapter: "openai-image", modelId: "gpt-image-2.6-flare", ...extra });
}

async function authenticate(hub: KuloHub, id: string, secret = dummyKey) {
  const input = await hub.capabilities.requestInput(id, "secret", context.clientId);
  await hub.capabilities.submitInput(input.id, context.clientId, { secret });
}

describe("capability workspace undo", () => {
  it("undoes same-connection preferences without changing credentials and deduplicates concurrent undo and replay", async () => {
    const f = await fixture();
    const cap = await configure(f.hub, "create-prefs");
    await authenticate(f.hub, cap.id);
    const connection = await f.hub.capabilities.connection(cap.connectionId);
    const action = await f.tool("preferences", "kulo_capability_configure", { config: JSON.stringify({
      id: cap.id, name: "修改后名称", adapter: "openai-image", modelId: cap.modelId, allowTaskGeneration: false, maxOutputs: 2,
    }) });
    expect(action).toMatchObject({ status: "applied", canUndo: true, requiresConfirmation: false });
    await expect(f.hub.settingsAssistant.decide(action.id, "undo", "foreign-client")).rejects.toThrow("另一台浏览器");
    await Promise.all([f.hub.settingsAssistant.decide(action.id, "undo", context.clientId), f.hub.settingsAssistant.decide(action.id, "undo", context.clientId)]);
    const restored = (await f.hub.capabilities.snapshot()).capabilities[0]!;
    expect(restored).toMatchObject({ name: "原名称", allowTaskGeneration: true, maxOutputs: 1, enabled: true });
    expect(await f.hub.capabilities.connection(cap.connectionId)).toEqual(connection);
    expect(await f.hub.capabilities.apiKey(cap.connectionId)).toBe(dummyKey);
    const revision = (await f.hub.capabilities.snapshot()).revision;
    const replayed = await f.tool(action.id, "kulo_capability_configure", { config: JSON.stringify({
      id: cap.id, name: "修改后名称", adapter: "openai-image", modelId: cap.modelId, allowTaskGeneration: false, maxOutputs: 2,
    }) });
    expect(replayed).toMatchObject({ status: "undone", canUndo: false });
    expect((await f.hub.capabilities.snapshot()).revision).toBe(revision);
    expect(JSON.stringify(await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))).not.toContain(dummyKey);
  });

  it("reverses nondefault enable/disable and declines undo when defaults change", async () => {
    const f = await fixture();
    const primary = await configure(f.hub, "primary");
    const secondary = await configure(f.hub, "secondary", { name: "备用", enabled: false });
    expect(await f.tool("enable-secondary", "kulo_capability_manage", { id: secondary.id, action: "enable" })).toMatchObject({ canUndo: true });
    await f.hub.settingsAssistant.decide("enable-secondary", "undo", context.clientId);
    expect((await f.hub.capabilities.snapshot()).capabilities.find((cap) => cap.id === secondary.id)).toMatchObject({ enabled: false, isDefault: false });
    expect(await f.tool("disable-primary", "kulo_capability_manage", { id: primary.id, action: "disable" })).toMatchObject({ canUndo: false });
    expect((await f.hub.capabilities.snapshot()).capabilities.find((cap) => cap.id === primary.id)).toMatchObject({ enabled: false, isDefault: false });
  });

  it("does not advertise undo for model, origin or default changes, creation or removal", async () => {
    const f = await fixture();
    const primary = await configure(f.hub, "first-unsafe");
    const secondary = await configure(f.hub, "second-unsafe");
    expect(await f.tool("model-change", "kulo_capability_configure", { config: JSON.stringify({ id: secondary.id, name: "另一个模型", adapter: "openai-image", modelId: "gpt-image-1.5" }) })).toMatchObject({ status: "applied", canUndo: false });
    expect(await f.tool("origin-change", "kulo_capability_configure", { config: JSON.stringify({ id: secondary.id, name: "另一服务", adapter: "openai-image", modelId: "gpt-image-1.5", baseUrl: "https://other.example/v1" }) })).toMatchObject({ status: "applied", canUndo: false });
    expect(await f.tool("default-change", "kulo_capability_configure", { config: JSON.stringify({ id: secondary.id, name: "新默认", adapter: "openai-image", modelId: "gpt-image-1.5", baseUrl: "https://other.example/v1", isDefault: true }) })).toMatchObject({ status: "applied", canUndo: false });
    expect(await f.tool("new-capability", "kulo_capability_configure", { config: JSON.stringify({ name: "新增", adapter: "gemini-image", modelId: "gemini-2.5-flash-image" }) })).toMatchObject({ status: "applied", canUndo: false });
    expect(await f.tool("remove-capability", "kulo_capability_manage", { id: primary.id, action: "remove" })).toMatchObject({ status: "pending", canUndo: false, requiresConfirmation: true });
    await f.hub.settingsAssistant.decide("remove-capability", "reject", context.clientId);
    expect((await f.hub.capabilities.snapshot()).capabilities.some((cap) => cap.id === primary.id)).toBe(true);
  });

  it.each(["target", "catalog", "credential"])("refuses undo after a later %s change", async (change) => {
    const f = await fixture();
    const cap = await configure(f.hub, `create-stale-${change}`);
    await authenticate(f.hub, cap.id);
    expect(await f.tool("edit-stale", "kulo_capability_configure", { config: JSON.stringify({ id: cap.id, name: "已编辑", adapter: "openai-image", modelId: cap.modelId }) })).toMatchObject({ canUndo: true });
    if (change === "target") {
      const current = (await f.hub.capabilities.snapshot()).capabilities[0]!;
      await configure(f.hub, "later-edit", { id: cap.id, expectedRevision: current.revision, name: "并发修改" });
    } else if (change === "catalog") await configure(f.hub, "later-catalog", { name: "新增能力" });
    else await authenticate(f.hub, cap.id, "synthetic-replacement-key");
    const later = await f.hub.capabilities.snapshot();
    await expect(f.hub.settingsAssistant.decide("edit-stale", "undo", context.clientId)).rejects.toMatchObject({ status: 409, code: "capability_revision_conflict" });
    expect(await f.hub.capabilities.snapshot()).toEqual(later);
  });

  it("persists the inverse and client binding across a Hub restart", async () => {
    const f = await fixture();
    const cap = await configure(f.hub, "create-restart");
    expect(await f.tool("edit-restart", "kulo_capability_configure", { config: JSON.stringify({ id: cap.id, name: "重启前修改", adapter: "openai-image", modelId: cap.modelId }) })).toMatchObject({ canUndo: true });
    await f.close();
    const reopened = await fixture(f.directory);
    reopened.hub.settingsAssistant.updateContext(context);
    await reopened.hub.settingsAssistant.decide("edit-restart", "undo", context.clientId);
    expect((await reopened.hub.capabilities.snapshot()).capabilities[0]?.name).toBe("原名称");
    expect((await reopened.hub.settingsAssistant.getSnapshot()).actions.find((action) => action.id === "edit-restart")).toMatchObject({ status: "undone", canUndo: false });
  });

  it("recovers the original inverse when the resource committed before its action receipt", async () => {
    const f = await fixture();
    await configure(f.hub, "ack-primary");
    const secondary = await configure(f.hub, "ack-secondary");
    const apply = f.hub.capabilities.setEnabled.bind(f.hub.capabilities);
    vi.spyOn(f.hub.capabilities, "setEnabled").mockImplementationOnce(async (...args) => { await apply(...args); throw new Error("synthetic receipt gap"); });
    expect(await f.tool("ack-gap", "kulo_capability_manage", { id: secondary.id, action: "disable" })).toMatchObject({ status: "failed", canUndo: false });
    expect((await f.hub.capabilities.snapshot()).capabilities.find((cap) => cap.id === secondary.id)?.enabled).toBe(false);
    expect(await f.tool("ack-gap", "kulo_capability_manage", { id: secondary.id, action: "disable" })).toMatchObject({ status: "applied", canUndo: true });
    await f.hub.settingsAssistant.decide("ack-gap", "undo", context.clientId);
    expect((await f.hub.capabilities.snapshot()).capabilities.find((cap) => cap.id === secondary.id)?.enabled).toBe(true);
  });

  it("undoes Skill enable/disable with catalog CAS and preserves builtin and hidden capability guards", async () => {
    const f = await fixture();
    expect(await f.tool("disable-html-skill", "kulo_skill_manage", { id: "interactive-html", action: "disable" })).toMatchObject({ status: "applied", canUndo: true });
    await Promise.all([f.hub.settingsAssistant.decide("disable-html-skill", "undo", context.clientId), f.hub.settingsAssistant.decide("disable-html-skill", "undo", context.clientId)]);
    expect((await f.hub.skills.snapshot()).skills.find((skill) => skill.id === "interactive-html")?.enabled).toBe(true);
    expect(await f.tool("disable-html-again", "kulo_skill_manage", { id: "interactive-html", action: "disable" })).toMatchObject({ canUndo: true });
    const current = await f.hub.skills.snapshot();
    await f.hub.skills.manage({ commandId: "concurrent-skill", id: "genui-cards", action: "disable", expectedRevision: current.revision });
    await expect(f.hub.settingsAssistant.decide("disable-html-again", "undo", context.clientId)).rejects.toMatchObject({ status: 409, code: "skill_revision_conflict" });
    expect(await f.tool("scope-change", "kulo_skill_manage", { id: "interactive-html", action: "enable", audiences: ["chat"] })).toMatchObject({ status: "applied", canUndo: false });
    expect(await f.tool("disable-hidden", "kulo_skill_manage", { id: "image-generation", action: "disable" })).toMatchObject({ status: "failed", canUndo: false });
    const catalog = await f.hub.skills.snapshot();
    await expect(f.hub.skills.manage({ id: "genui-cards", action: "remove", commandId: "remove-builtin", expectedRevision: catalog.revision })).rejects.toMatchObject({ code: "builtin_skill_managed" });
  });

  it("rejects another client replaying an existing workspace command", async () => {
    const f = await fixture();
    const cap = await configure(f.hub, "client-primary");
    await f.tool("client-bound", "kulo_capability_configure", { config: JSON.stringify({ id: cap.id, name: "已保存", adapter: "openai-image", modelId: cap.modelId }) });
    const foreign = { ...context, clientId: "foreign-client" };
    f.hub.settingsAssistant.updateContext(foreign);
    await f.hub.harness.commit(async (tx) => { (await tx.doc(SettingsAssistantDoc)).turnContext = foreign; }, BACKGROUND_CONTEXT);
    const run = vi.fn();
    await expect(f.hub.settingsAssistant.workspaceAction("client-bound", "覆盖", [], run)).rejects.toThrow("另一台浏览器");
    expect(run).not.toHaveBeenCalled();
  });
});
