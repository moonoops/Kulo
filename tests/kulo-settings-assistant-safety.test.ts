import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { SettingsAssistantContext } from "@kulo/protocol";
import { KuloHub } from "../packages/hub/src/hub";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-assistant";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineEntry, type ConversationId } from "@earendil-works/pi-durable";

const resources: Array<() => Promise<void> | void> = [];
const context: SettingsAssistantContext = { module: "workers", hasUnsavedChanges: false, appearance: "light", clientId: "safety-client" };

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-settings-safety-"));
  resources.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "openai", models: [{ id: "settings-model" }, { id: "second-model" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(faux));
  faux.setResponses(Array.from({ length: 12 }, () => () => fauxAssistantMessage([fauxText("设置助手回复。")])));
  const hub = await openTestHub({ models, config: {
    stateDir, enableLocalEnv: false, watchdogMinutes: 0, maxConcurrentWorkers: 2,
    model: { defaultProvider: "openai", defaultModel: "settings-model", thinkingLevel: "off", apiKey: "" }, memory: { enabled: false },
  } });
  resources.push(() => hub.close());
  return { hub, faux, models };
}

async function idle(hub: KuloHub) {
  await vi.waitFor(async () => {
    const snapshot = await hub.settingsAssistant.getSnapshot();
    expect(snapshot.live.busy).toBe(false);
    expect(snapshot.messages.some((message) => message.role === "assistant")).toBe(true);
  }, { timeout: 5000, interval: 20 });
}

async function start(hub: KuloHub) {
  await hub.settingsAssistant.send("检查设置", context, "initial");
  await idle(hub);
}

describe("settings assistant safety boundaries", () => {
  it("leaves Hindsight connection and enable changes to the left connection form", async () => {
    const { hub } = await fixture(); await start(hub);
    const before = hub.getSettingsView().blocks.memory;
    await expect(hub.settingsAssistant.update("memory", '{"enabled":true}', "启用长期记忆", "memory-switch")).rejects.toThrow("专用操作");
    expect(hub.getSettingsView().blocks.memory).toEqual(before);
  });

  it("updates and undoes completed-task display including the explicit forever value", async () => {
    const { hub } = await fixture(); await start(hub);
    await hub.settingsAssistant.read("workers");
    const action = await hub.settingsAssistant.update("executor", '{"completedTaskDisplayHours":null}', "一直显示完成任务", "display-forever");
    expect(hub.getSettingsView().blocks.executor.value.completedTaskDisplayHours).toBeNull();
    expect(action.changes).toContain("已完成任务显示时长：3 小时 → 一直显示");
    await hub.settingsAssistant.decide(action.id, "undo", context.clientId);
    expect(hub.getSettingsView().blocks.executor.value.completedTaskDisplayHours).toBe(3);
    await hub.settingsAssistant.read("workers");
    await expect(hub.settingsAssistant.update("executor", '{"completedTaskDisplayHours":2}', "无效时长", "invalid-display")).rejects.toThrow("已完成任务显示时长");
    await expect(hub.settingsAssistant.update("executor", '{"completedTaskDisplayHours":"3"}', "无效类型", "invalid-display-type")).rejects.toThrow("类型无效");
    expect(hub.getSettingsView().blocks.executor.value.completedTaskDisplayHours).toBe(3);
  });

  it("updates and undoes the archive policy with validated values", async () => {
    const { hub } = await fixture(); await start(hub);
    await hub.settingsAssistant.read("workers");
    const action = await hub.settingsAssistant.update("executor", '{"autoArchiveEnabled":false,"autoArchiveDays":14}', "调整自动归档", "archive-policy");
    expect(hub.getSettingsView().blocks.executor.value).toMatchObject({ autoArchiveEnabled: false, autoArchiveDays: 14 });
    expect(action.changes).toContain("自动归档：开启 → 关闭");
    expect(action.changes).toContain("未活动天数：7 天 → 14 天");
    await hub.settingsAssistant.decide(action.id, "undo", context.clientId);
    expect(hub.getSettingsView().blocks.executor.value).toMatchObject({ autoArchiveEnabled: true, autoArchiveDays: 7 });
    await hub.settingsAssistant.read("workers");
    await expect(hub.settingsAssistant.update("executor", '{"autoArchiveEnabled":"false"}', "无效开关", "archive-bad-type")).rejects.toThrow("类型无效");
    await expect(hub.settingsAssistant.update("executor", '{"autoArchiveDays":0}', "无效天数", "archive-bad-days")).rejects.toThrow();
  });

  it("accepts archive page context and reads only archived topic summaries", async () => {
    const { hub } = await fixture();
    const archived = await hub.createTopic("设置中可还原的话题");
    await hub.patchTopic(archived.id, { archived: true });
    await hub.createTopic("活跃的话题");
    await hub.settingsAssistant.send("查看归档", { ...context, module: "archives" }, "archives-context");
    await idle(hub);
    expect(await hub.settingsAssistant.read()).toMatchObject({ conversations: [{ id: archived.id, title: archived.title }] });
    const result = await hub.settingsAssistant.read() as { conversations: unknown[] };
    expect(result.conversations).toHaveLength(1);
  });

  it("accepts system permission context without querying or requesting OS access from the assistant", async () => {
    const { hub } = await fixture();
    const native = vi.spyOn(hub.envManager, "requestComputerUse");
    await hub.settingsAssistant.send("检查系统权限", { ...context, module: "permissions" }, "permissions-context");
    await idle(hub);
    const result = await hub.settingsAssistant.read() as { note: string };
    expect(result.note).toContain("confirmed directly by the user");
    expect(result.note).toContain("cannot request");
    expect(native).not.toHaveBeenCalled();
    const action = await hub.settingsAssistant.clientAction("navigate", { module: "permissions" }, "open-permissions");
    expect(action).toMatchObject({ kind: "navigate", module: "permissions", status: "pending", clientId: context.clientId });
    expect(native).not.toHaveBeenCalled();
  });

  it("refuses stale observed revisions instead of overwriting a later manual save", async () => {
    const { hub } = await fixture(); await start(hub);
    await hub.settingsAssistant.read("workers");
    const original = hub.getSettingsView().blocks.executor;
    await hub.updateSettingsBlock("executor", original.revision, { ...original.value, maxConcurrentWorkers: 4 });
    await expect(hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "stale-change")).rejects.toThrow("已被其他操作更新");
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(4);
    expect((await hub.settingsAssistant.getSnapshot()).actions).toEqual([]);
    await hub.settingsAssistant.read("workers");
    await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "fresh-change");
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(3);
  });

  it("does not overwrite the same field during undo and deduplicates successful undo", async () => {
    const { hub } = await fixture(); await start(hub);
    await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "set-three");
    let block = hub.getSettingsView().blocks.executor;
    await hub.updateSettingsBlock("executor", block.revision, { ...block.value, maxConcurrentWorkers: 5 });
    await expect(hub.settingsAssistant.decide("set-three", "undo", context.clientId)).rejects.toThrow("相关设置已被修改");
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(5);
    block = hub.getSettingsView().blocks.executor;
    await hub.updateSettingsBlock("executor", block.revision, { ...block.value, maxConcurrentWorkers: 3 });
    await hub.settingsAssistant.decide("set-three", "undo", context.clientId);
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(2);
    const revision = hub.getSettingsView().globalRevision;
    await hub.settingsAssistant.decide("set-three", "undo", context.clientId);
    expect(hub.getSettingsView().globalRevision).toBe(revision);
  });

  it("validates allowed paths and types and blocks invented model/role selections", async () => {
    const { hub } = await fixture(); await start(hub);
    const revision = hub.getSettingsView().globalRevision;
    await expect(hub.settingsAssistant.update("model", '{"apiKey":"synthetic-test-value"}', "不允许凭证", "secret")).rejects.toThrow("专用操作");
    await expect(hub.settingsAssistant.update("executor", '{"paused":"false"}', "无效开关", "bad-bool")).rejects.toThrow("类型无效");
    await expect(hub.settingsAssistant.update("model", '{"defaultModel":"invented-model"}', "不存在模型", "bad-model")).rejects.toThrow("有效模型");
    await expect(hub.settingsAssistant.update("model", '{"thinkingLevel":"invented-level"}', "不存在思考档位", "bad-thinking")).rejects.toThrow("不支持");
    const roleId = Object.keys(hub.getSettingsView().blocks.roles.value)[0]!;
    await expect(hub.settingsAssistant.update("roles", JSON.stringify({ [`${roleId}.provider`]: "invented-provider" }), "不存在角色供应商", "bad-role-provider")).rejects.toThrow("有效模型");
    await expect(hub.settingsAssistant.update("roles", JSON.stringify({ [`${roleId}.modelId`]: "invented-model" }), "不存在角色模型", "bad-role-model")).rejects.toThrow("有效模型");
    await expect(hub.settingsAssistant.update("roles", JSON.stringify({ [`${roleId}.thinkingLevel`]: "invented-level" }), "不存在角色思考档位", "bad-role-thinking")).rejects.toThrow("不支持");
    expect(hub.getSettingsView().globalRevision).toBe(revision);
    expect(JSON.stringify(await hub.settingsAssistant.getSnapshot())).not.toContain("synthetic-test-value");
  });

  it("preserves live dirty context on a duplicate request that carries an old clean context", async () => {
    const { hub } = await fixture(); await start(hub);
    hub.settingsAssistant.updateContext({ ...context, hasUnsavedChanges: true });
    await hub.settingsAssistant.send("检查设置", context, "initial");
    await expect(hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "dirty-after-retry")).rejects.toThrow("尚未保存");
    hub.settingsAssistant.updateContext({ ...context, module: "identity", hasUnsavedChanges: true });
    await expect(hub.settingsAssistant.update("presentation", '{"agentName":"另一名称"}', "修改名称", "dirty-identity")).rejects.toThrow("尚未保存");
  });

  it("acknowledges admitted requests after the selected model is cleared while retaining the long-lived conversation", async () => {
    const { hub } = await fixture(); await start(hub);
    const original = await hub.settingsAssistant.getSnapshot();
    const model = hub.getSettingsView().blocks.model;
    await hub.updateSettingsBlock("model", model.revision, { ...model.value, defaultModel: "" });
    await expect(hub.settingsAssistant.send("检查设置", context, "initial")).resolves.toBeUndefined();
    await expect(hub.settingsAssistant.send("检查设置", context, "initial")).resolves.toBeUndefined();
    await expect(hub.settingsAssistant.send("新的请求", context, "new-without-model")).rejects.toMatchObject({ code: "model_not_selected" });
    expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: original.topicId, messages: original.messages });
  });

  it("returns an already committed tool action even when the replay client is now dirty or disconnected", async () => {
    const { hub } = await fixture(); await start(hub);
    const action = await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "replayed-tool");
    const revision = hub.getSettingsView().globalRevision;
    hub.settingsAssistant.updateContext({ ...context, hasUnsavedChanges: true });
    expect(await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "replayed-tool")).toEqual(action);
    hub.settingsAssistant.forgetContext(context.clientId);
    expect(await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "改为 3", "replayed-tool")).toEqual(action);
    expect(hub.getSettingsView().globalRevision).toBe(revision);
  });

  it("binds browser actions to their client and preserves pending actions across reconnecting to the long-lived session", async () => {
    const { hub } = await fixture(); await start(hub);
    await expect(hub.settingsAssistant.clientAction("navigate", { module: "appearance", intent: "add-api" }, "invalid-navigation")).rejects.toThrow("不匹配");
    const action = await hub.settingsAssistant.clientAction("appearance", { appearance: "dark" }, "dark-mode");
    expect(action).toMatchObject({ kind: "appearance", status: "pending", requiresConfirmation: false, previousAppearance: "light", clientId: context.clientId });
    await expect(hub.settingsAssistant.decide(action.id, "client-applied", "another-client")).rejects.toThrow("另一台浏览器");
    await hub.settingsAssistant.decide(action.id, "client-applied", context.clientId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "applied", canUndo: true });
    await hub.settingsAssistant.decide(action.id, "undo", context.clientId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "undone", canUndo: false });
    await hub.settingsAssistant.clientAction("navigate", { module: "models", intent: "add-api" }, "open-api");
    const conversationId = (await hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))!.conversationId;
    const before = await hub.settingsAssistant.getSnapshot();
    hub.settingsAssistant.forgetContext(context.clientId);
    hub.settingsAssistant.updateContext({ ...context, module: "models" });
    expect(await hub.settingsAssistant.getSnapshot()).toEqual(before);
    expect(await hub.settingsAssistant.conversationIds()).toContain(conversationId);
  });

  it("retains browser action history without replaying unacknowledged actions when loading an older session", async () => {
    const { hub } = await fixture(); await start(hub);
    const original = await hub.settingsAssistant.getSnapshot();
    await hub.settingsAssistant.clientAction("appearance", { appearance: "dark" }, "pending-old-appearance");
    await hub.settingsAssistant.clientAction("navigate", { module: "models" }, "pending-old-navigation");
    const settings = hub.getSettingsView();
    await hub.settingsAssistant.newConversation(original.topicId, "leave-pending-browser-actions");
    const fresh = await hub.settingsAssistant.getSnapshot();
    await hub.settingsAssistant.selectConversation(original.topicId!, fresh.topicId);
    const restored = await hub.settingsAssistant.getSnapshot();
    expect(restored.actions).toHaveLength(2);
    for (const action of restored.actions) expect(action).toMatchObject({ status: "failed", canUndo: false, error: "已切换设置对话，请重新发起操作。" });
    await hub.settingsAssistant.decide("pending-old-appearance", "client-applied", context.clientId, undefined, original.topicId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]?.status).toBe("failed");
    expect(hub.getSettingsView()).toEqual(settings);
  });

  it("rejects an old tab's stop request without aborting the newer session", async () => {
    const { hub, faux } = await fixture();
    await hub.settingsAssistant.newConversation(null, "abort-old-session");
    const oldTopicId = (await hub.settingsAssistant.getSnapshot()).topicId;
    await hub.settingsAssistant.newConversation(oldTopicId, "abort-new-session");
    const activeTopicId = (await hub.settingsAssistant.getSnapshot()).topicId;
    let release!: () => void;
    let requested = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => { requested = true; await gate; return fauxAssistantMessage([fauxText("新会话回复。")]); }]);
    try {
      await hub.settingsAssistant.send("新会话正在处理", context, "new-session-in-flight", [], "local", activeTopicId);
      await vi.waitFor(() => expect(requested).toBe(true));
      await expect(hub.settingsAssistant.abort(oldTopicId)).rejects.toThrow("设置对话已更新");
      expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: activeTopicId, live: { busy: true } });
      const stopping = hub.settingsAssistant.abort(activeTopicId);
      release();
      await stopping;
      expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: activeTopicId, live: { busy: false } });
    } finally { release(); }
  });

  it("keeps snapshots and stop responsive while a workspace operation is awaiting external I/O", async () => {
    const { hub } = await fixture();
    await hub.settingsAssistant.send("检查能力配置", { ...context, module: "capabilities" }, "workspace-io-context");
    await idle(hub);
    const activeTopicId = (await hub.settingsAssistant.getSnapshot()).topicId;
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = hub.settingsAssistant.workspaceAction("gated-workspace-check", "检查能力", [], async () => { started = true; await gate; return { checked: true }; });
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      let snapshotLoaded = false;
      let stopped = false;
      const reading = hub.settingsAssistant.getSnapshot().then((snapshot) => { expect(snapshot.topicId).toBe(activeTopicId); snapshotLoaded = true; });
      const stopping = hub.settingsAssistant.abort(activeTopicId).then(() => { stopped = true; });
      await vi.waitFor(() => { expect(snapshotLoaded).toBe(true); expect(stopped).toBe(true); }, { timeout: 1000, interval: 10 });
      await reading;
      await stopping;
    } finally { release(); await running; }
  });

  it("does not publish an old watch snapshot after a newer settings session is selected", async () => {
    const { hub } = await fixture(); await start(hub);
    const original = await hub.settingsAssistant.getSnapshot();
    const emitted: Array<string | null> = [];
    resources.push(hub.subscribe({ onSettingsAssistant: (snapshot) => emitted.push(snapshot.topicId) }));
    const snapshot = hub.harness.snapshot.bind(hub.harness);
    let release!: () => void;
    let captured = false;
    let resumed = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(hub.harness, "snapshot").mockImplementation(async (...args) => {
      const value = await snapshot(...args);
      if (args[0] === SettingsAssistantDoc && !captured) {
        captured = true;
        await gate;
        resumed = true;
      }
      return value;
    });
    try {
      const tick = defineEntry("test.settings-history-tick");
      await hub.harness.commit(async (tx) => {
        await tx.appendEntry(tick, Number(original.topicId!.slice("settings-".length)) as ConversationId, {});
      }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(captured).toBe(true));
      await hub.settingsAssistant.newConversation(original.topicId, "new-while-watch-pending");
      const fresh = await hub.settingsAssistant.getSnapshot();
      const afterSwitch = emitted.length;
      release();
      await vi.waitFor(() => expect(resumed).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(emitted.slice(afterSwitch)).not.toContain(original.topicId);
      expect(emitted.at(-1)).toBe(fresh.topicId);
    } finally { release(); spy.mockRestore(); }
  });

  it("rejects a second input and session switching while busy without changing the active semantic page", async () => {
    const { hub, faux } = await fixture();
    await hub.settingsAssistant.newConversation(null, "busy-inactive-session");
    const inactiveTopicId = (await hub.settingsAssistant.getSnapshot()).topicId!;
    await hub.settingsAssistant.newConversation(inactiveTopicId, "busy-active-session");
    let release!: () => void;
    let requested = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([
      async () => { requested = true; await gate; return fauxAssistantMessage([fauxToolCall("kulo_settings_read", {})], { stopReason: "toolUse" }); },
      () => fauxAssistantMessage([fauxText("已检查智能体设置。")]),
    ]);
    await hub.settingsAssistant.send("检查这里", context, "first-in-flight");
    await vi.waitFor(() => expect(requested).toBe(true));
    const active = await hub.settingsAssistant.getSnapshot();
    await expect(hub.settingsAssistant.newConversation(active.topicId)).rejects.toThrow("请先停止当前请求");
    await expect(hub.settingsAssistant.deleteConversation(active.topicId!, active.topicId)).rejects.toThrow("请先停止当前请求");
    await hub.settingsAssistant.deleteConversation(inactiveTopicId, active.topicId, "delete-inactive-while-busy");
    expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: active.topicId, live: { busy: true } });
    await expect(hub.settingsAssistant.selectConversation(active.topicId!, active.topicId)).rejects.toThrow("请先停止当前请求");
    expect((await hub.settingsAssistant.getSnapshot()).topicId).toBe(active.topicId);
    await expect(hub.settingsAssistant.send("第二条", { ...context, module: "models" }, "second-in-flight")).rejects.toThrow();
    expect((await hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))!.turnContext!.module).toBe("workers");
    release(); await idle(hub);
    const snapshot = await hub.settingsAssistant.getSnapshot();
    expect(snapshot.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(snapshot.messages.some((message) => message.text.includes("第二条"))).toBe(false);
  });

  it("uses a changed default model only on the following request", async () => {
    const { hub, faux } = await fixture();
    const requestedModels: string[] = [];
    faux.setResponses([
      (_ctx, _opts, _state, model) => {
        requestedModels.push(model.id);
        return fauxAssistantMessage([fauxToolCall("kulo_settings_update", { block: "model", changes: '{"defaultModel":"second-model"}', title: "切换默认模型" })], { stopReason: "toolUse" });
      },
      (_ctx, _opts, _state, model) => { requestedModels.push(model.id); return fauxAssistantMessage([fauxText("默认模型已切换。")]); },
      (_ctx, _opts, _state, model) => { requestedModels.push(model.id); return fauxAssistantMessage([fauxText("使用新默认模型。")]); },
    ]);
    await hub.settingsAssistant.send("把默认模型切换到第二个", { ...context, module: "models" }, "change-model");
    await idle(hub);
    expect(hub.getSettingsView().blocks.model.value.defaultModel).toBe("second-model");
    expect(requestedModels).toEqual(["settings-model", "settings-model"]);
    await hub.settingsAssistant.send("继续", context, "next-model-turn");
    await vi.waitFor(() => expect(requestedModels).toEqual(["settings-model", "settings-model", "second-model"]));
    await hub.settingsAssistant.abort();
  });

  it("allows another subscribed window to confirm shared settings and cleans credentials once without offering undo", async () => {
    const { hub, models } = await fixture(); await start(hub);
    const block = hub.getSettingsView().blocks.model;
    await hub.updateSettingsBlock("model", block.revision, { ...block.value, customProviders: [
      { id: "api-delete", name: "待移除连接", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "unused" }] },
    ] });
    const action = await hub.settingsAssistant.removeConnection("api-delete", "remove-connection");
    hub.settingsAssistant.forgetContext(context.clientId);
    const other = { ...context, clientId: "new-window", module: "models" as const };
    hub.settingsAssistant.updateContext({ ...other, hasUnsavedChanges: true });
    await expect(hub.settingsAssistant.decide(action.id, "confirm", other.clientId)).rejects.toThrow("尚未保存");
    hub.settingsAssistant.updateContext(other);
    const logout = vi.spyOn(models, "logout").mockResolvedValue(undefined);
    await hub.settingsAssistant.decide(action.id, "confirm", other.clientId);
    await hub.settingsAssistant.decide(action.id, "confirm", other.clientId);
    expect(logout).toHaveBeenCalledExactlyOnceWith("api-delete");
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "applied", canUndo: false });
    expect(hub.getSettingsView().blocks.model.value.customProviders).toEqual([]);
  });

  it("stops an in-flight generation while retaining the same conversation and its history", async () => {
    const { hub, faux } = await fixture();
    let release!: () => void;
    let requested = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => {
      requested = true; await gate;
      return fauxAssistantMessage([fauxToolCall("kulo_settings_update", { block: "executor", changes: '{"maxConcurrentWorkers":3}', title: "已取消的改动" })], { stopReason: "toolUse" });
    }]);
    await hub.settingsAssistant.send("生成期间停止", context, "abort-running");
    const originalTopicId = (await hub.settingsAssistant.getSnapshot()).topicId;
    await vi.waitFor(() => expect(requested).toBe(true));
    const aborting = hub.settingsAssistant.abort();
    release(); await aborting;
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(2);
    const stopped = await hub.settingsAssistant.getSnapshot();
    expect(stopped.topicId).toBe(originalTopicId);
    expect(stopped.messages.some((message) => message.role === "user" && message.text === "生成期间停止")).toBe(true);
    expect(stopped.actions).toEqual([]);
    await hub.settingsAssistant.send("继续原设置对话", context, "continue-after-abort");
    expect((await hub.settingsAssistant.getSnapshot()).topicId).toBe(originalTopicId);
    await hub.settingsAssistant.abort();
  });
});
