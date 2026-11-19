import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { validateAppearanceCustomization, type SettingsAssistantContext, type SettingsAssistantSnapshot } from "@kulo/protocol";
import { KuloHub } from "../packages/hub/src/hub";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-assistant";
import { openTestHub } from "./helpers/secure-hub";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider";

const resources: Array<() => void | Promise<void>> = [];
const initial = validateAppearanceCustomization({ name: "原字体", fonts: { ui: "Arial" } });
const context: SettingsAssistantContext = { module: "appearance", appearance: "dark", appearanceCustomization: initial, hasUnsavedChanges: false, clientId: "appearance-owner" };
const config = { name: "阅读方案", fonts: { chat: "Georgia", code: "Menlo" } };

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-appearance-flow-"));
  resources.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "appearance-model" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  const init: Parameters<typeof openTestHub>[0] = { models, config: {
    stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "appearance-model", thinkingLevel: "off", apiKey: "" },
  } };
  return { provider, init };
}
async function open(init: Parameters<typeof openTestHub>[0]) {
  const hub = await openTestHub(init);
  resources.push(() => hub.close());
  return hub;
}
async function settled(hub: KuloHub, text = "方案已准备") {
  let snapshot: SettingsAssistantSnapshot;
  await vi.waitFor(async () => {
    snapshot = await hub.settingsAssistant.getSnapshot();
    expect(snapshot.live.busy).toBe(false);
    expect(snapshot.messages.some((message) => message.role === "assistant" && message.text.includes(text))).toBe(true);
  }, { timeout: 8_000, interval: 25 });
  return snapshot!;
}
function toolNames(ctx: TranscriptContext) {
  return [...new Set([...(ctx.tools?.map((tool) => tool.name) ?? []), ...ctx.messages.flatMap((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) ? message.toolsAdded.map((tool) => tool.name) : [])])];
}
function proposalResponses(provider: ReturnType<typeof fauxProvider>, trace: TranscriptContext[] = []) {
  provider.setResponses([
    (ctx) => { trace.push(ctx); return fauxAssistantMessage([fauxToolCall("kulo_settings_read", { section: "appearance" })], { stopReason: "toolUse" }); },
    (ctx) => { trace.push(ctx); return fauxAssistantMessage([fauxToolCall("kulo_appearance_propose", { config: JSON.stringify(config) })], { stopReason: "toolUse" }); },
    (ctx) => { trace.push(ctx); return fauxAssistantMessage([fauxText("方案已准备，请预览后应用。")]); },
  ]);
}

describe("appearance customization through the registered settings assistant", () => {
  it("registers real tools, reads browser-scoped preferences, and records an apply/undo receipt without changing hub settings", async () => {
    const { provider, init } = fixture();
    const trace: TranscriptContext[] = []; proposalResponses(provider, trace);
    const hub = await open(init);
    const settings = hub.getSettingsView();
    await hub.settingsAssistant.send("根据当前字体创建阅读外观", context, "appearance-propose");
    const snapshot = await settled(hub);
    expect(toolNames(trace[0]!)).toEqual(expect.arrayContaining(["kulo_settings_read", "kulo_appearance_propose"]));
    expect(JSON.stringify(trace[1]!.messages.filter((message) => message.role === "toolResult"))).toContain("原字体");
    expect(snapshot.actions).toHaveLength(1);
    const action = snapshot.actions[0]!;
    expect(action).toMatchObject({ kind: "appearance-customization", clientId: context.clientId, status: "pending", requiresConfirmation: true, canUndo: false,
      customization: { name: config.name, useDefaultColors: true, fonts: { ui: "Arial", chat: "Georgia", code: "Menlo" } }, previousCustomization: initial });
    expect(hub.getSettingsView()).toEqual(settings);
    await expect(hub.settingsAssistant.decide(action.id, "client-applied", "another-client")).rejects.toThrow("另一台浏览器");
    await hub.settingsAssistant.decide(action.id, "confirm", context.clientId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]?.status).toBe("pending");
    await hub.settingsAssistant.decide(action.id, "client-applied", context.clientId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "applied", canUndo: true });
    await hub.settingsAssistant.decide(action.id, "undo", context.clientId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "undone", canUndo: false });
    await hub.close();
    const reopened = await open(init);
    expect((await reopened.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "undone", customization: action.customization, previousCustomization: initial });
  });

  it("rejects a proposal without applying it and preserves pending cards for same-window acknowledgement after reopen", async () => {
    const { provider, init } = fixture(); proposalResponses(provider);
    const hub = await open(init);
    await hub.settingsAssistant.send("创建字体方案", context, "reopen-proposal");
    const snapshot = await settled(hub);
    const action = snapshot.actions[0]!;
    await hub.close();
    const reopened = await open(init);
    expect((await reopened.settingsAssistant.getSnapshot()).actions[0]).toEqual(action);
    await expect(reopened.settingsAssistant.decide(action.id, "client-applied", context.clientId)).rejects.toThrow("原窗口尚未连接");
    reopened.settingsAssistant.updateContext(context);
    await reopened.settingsAssistant.decide(action.id, "reject", context.clientId);
    expect((await reopened.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "rejected", canUndo: false });
  });

  it("keeps appearance tools outside other settings pages and checks the current page before accessing them", async () => {
    const { provider, init } = fixture();
    const names: string[][] = [];
    provider.setResponses([(ctx) => { names.push(toolNames(ctx)); return fauxAssistantMessage([fauxText("已读取智能体页面。")]); }]);
    const hub = await open(init);
    await hub.settingsAssistant.send("检查当前页面", { ...context, module: "workers" }, "workers-only");
    await settled(hub, "已读取智能体页面");
    expect(names[0]).not.toContain("kulo_appearance_read");
    expect(names[0]).not.toContain("kulo_appearance_propose");
    await expect(hub.settingsAssistant.readAppearanceCustomization()).rejects.toThrow("回到发起配置");
    await expect(hub.settingsAssistant.proposeAppearanceCustomization(validateAppearanceCustomization(config), "cross-page")).rejects.toThrow("回到发起配置");
  });

  it("blocks tools when the current page has unsaved edits or changes during the request", async () => {
    const { provider, init } = fixture();
    const trace: TranscriptContext[] = []; proposalResponses(provider, trace);
    const hub = await open(init);
    const dirty = { ...context, hasUnsavedChanges: true };
    await hub.settingsAssistant.send("创建字体方案", dirty, "dirty-proposal");
    const snapshot = await settled(hub);
    expect(snapshot.actions).toEqual([]);
    expect(JSON.stringify(trace[2]!.messages.filter((message) => message.role === "toolResult"))).toContain("未保存修改");
    await expect(hub.settingsAssistant.configurationContext("appearance")).rejects.toThrow("未保存修改");
    hub.settingsAssistant.updateContext({ ...context, module: "models" });
    await expect(hub.settingsAssistant.configurationContext("appearance")).rejects.toThrow("回到发起配置");
  });

  it("recovers a read-only appearance card from an older conversation's actual tool receipt", async () => {
    const { provider, init } = fixture(); proposalResponses(provider);
    const hub = await open(init);
    await hub.settingsAssistant.send("创建字体方案", context, "history-proposal");
    const original = await settled(hub);
    await hub.settingsAssistant.newConversation(original.topicId, "leave-proposal");
    const current = await hub.settingsAssistant.getSnapshot();
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      delete state.conversations![original.topicId!.slice("settings-".length)];
    }, BACKGROUND_CONTEXT);
    await hub.close();
    const reopened = await open(init);
    await reopened.settingsAssistant.selectConversation(original.topicId!, current.topicId, "restore-history");
    const restored = await reopened.settingsAssistant.getSnapshot();
    expect(restored.actions[0]).toMatchObject({ kind: "appearance-customization", customization: original.actions[0]!.customization, historical: true, requiresConfirmation: false, canUndo: false });
    await expect(reopened.settingsAssistant.decide(restored.actions[0]!.id, "client-applied", context.clientId)).rejects.toThrow("历史回执仅供查看");
  });
});
