import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import WebSocket from "ws";
import { KuloHub, KuloStateDoc, startKuloHubServer } from "@kulo/hub";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-assistant";
import type { ChatAttachment, ClientToHubMessage, HubToClientMessage, SettingsAssistantContext, SettingsAssistantSnapshot } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN, withHubTestAuth } from "./helpers/hub-auth";

const resources: Array<() => Promise<void> | void> = [];
const context: SettingsAssistantContext = {
  module: "workers", hasUnsavedChanges: false, appearance: "light", clientId: "flow-test-client",
};

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-settings-flow-"));
  resources.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "settings-model", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(routeSettingsTitleRequests(provider));
  const init = {
    models,
    config: {
      authToken: HUB_TEST_ADMIN_TOKEN,
      stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"), enableLocalEnv: true,
      maxConcurrentWorkers: 2, watchdogMinutes: 0, memory: { enabled: false },
      model: { defaultProvider: "openai", defaultModel: "settings-model", thinkingLevel: "off" as const, apiKey: "" },
    },
  };
  return { provider, init };
}

async function openHub(init: Parameters<typeof KuloHub.open>[0]) {
  const hub = await openTestHub(init);
  resources.push(() => hub.close());
  return hub;
}

async function openClient(hub: KuloHub) {
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  resources.push(() => server.close());
  const ws = new WebSocket(withHubTestAuth(server.clientWsUrl));
  const received: HubToClientMessage[] = [];
  ws.on("message", (raw) => received.push(JSON.parse(raw.toString()) as HubToClientMessage));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  resources.push(() => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", resolve); ws.close();
  }));
  const wait = async <T extends HubToClientMessage["type"]>(type: T, predicate: (message: Extract<HubToClientMessage, { type: T }>) => boolean = () => true) => {
    let found: Extract<HubToClientMessage, { type: T }> | undefined;
    await vi.waitFor(() => {
      found = received.find((message) => message.type === type && predicate(message as Extract<HubToClientMessage, { type: T }>)) as typeof found;
      expect(found, `WS ${type}`).toBeDefined();
    }, { timeout: 8_000, interval: 20 });
    return found!;
  };
  await wait("hub.snapshot");
  return { received, wait, send: (message: ClientToHubMessage) => ws.send(JSON.stringify(message)) };
}

async function settled(hub: KuloHub, predicate: (snapshot: SettingsAssistantSnapshot) => boolean) {
  let snapshot: SettingsAssistantSnapshot;
  await vi.waitFor(async () => {
    snapshot = await hub.settingsAssistant.getSnapshot();
    expect(snapshot.live.busy).toBe(false);
    expect(predicate(snapshot)).toBe(true);
  }, { timeout: 10_000, interval: 30 });
  return snapshot!;
}

function toolNames(ctx: TranscriptContext): string[] {
  return Array.from(new Set([
    ...(ctx.tools?.map((tool) => tool.name) ?? []),
    ...ctx.messages.flatMap((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
      ? message.toolsAdded.map((tool) => tool.name) : []),
  ]));
}

describe("settings assistant through the client protocol", () => {
  it("passes image bytes and file excerpts to the model, persists attachments, and deduplicates accepted retries", async () => {
    const { provider, init } = makeFixture();
    const receivedContents: unknown[] = [];
    provider.setResponses([(ctx) => {
      receivedContents.push([...ctx.messages].reverse().find((message) => message.role === "user")?.content);
      return fauxAssistantMessage([fauxText("已检查附件中的配置。")]);
    }]);
    const hub = await openHub(init);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
    const image = hub.uploads.saveUpload({ name: "settings.png", bytes: png, ownerId: "local" });
    const file = hub.uploads.saveUpload({ name: "settings.json", mimeType: "application/json", bytes: Buffer.from('{"maxConcurrentWorkers":3}'), ownerId: "local" });
    const attachments = [image, file];
    const client = await openClient(hub);
    const request: ClientToHubMessage = {
      type: "settings.assistant.send", content: "参考这些配置", context, requestId: "settings-with-attachments",
      attachments: attachments.map((asset) => ({ ...asset, name: "forged-name.txt", url: "https://invalid.example/forged" })),
    };
    client.send(request);
    await client.wait("hub.ack", (message) => message.requestId === request.requestId);
    const snapshot = await settled(hub, (value) => value.messages.some((message) => message.text.includes("已检查附件")));
    expect(snapshot.messages.find((message) => message.role === "user")).toMatchObject({ text: "参考这些配置", attachments });
    expect(receivedContents).toHaveLength(1);
    expect(receivedContents[0]).toEqual(expect.arrayContaining([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]));
    expect(JSON.stringify(receivedContents[0])).toContain('maxConcurrentWorkers');
    expect(JSON.stringify(receivedContents[0])).not.toContain("forged-name");
    for (const attachment of attachments) {
      expect(hub.uploads.getUpload(attachment.id)?.record.referenceScopes).toContain(`conversation:${snapshot.topicId!.slice("settings-".length)}`);
    }
    expect(hub.uploads.cleanupDrafts(Date.now() + 1)).toBe(0);
    client.send(request);
    await vi.waitFor(() => expect(client.received.filter((message) => message.type === "hub.ack" && message.requestId === request.requestId)).toHaveLength(2));
    expect((await hub.settingsAssistant.getSnapshot()).messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(receivedContents).toHaveLength(1);
    expect((await hub.getTopicView("root")).messages).toEqual([]);
    await hub.close();
    const reopened = await openHub(init);
    expect((await reopened.settingsAssistant.getSnapshot()).messages).toEqual(snapshot.messages);
    for (const attachment of attachments) expect(reopened.uploads.getUpload(attachment.id)).not.toBeNull();
  });

  it("accepts attachment-only messages and leaves audio files as references without transcription", async () => {
    const { provider, init } = makeFixture();
    const receivedContents: unknown[] = [];
    provider.setResponses([(ctx) => {
      receivedContents.push([...ctx.messages].reverse().find((message) => message.role === "user")?.content);
      return fauxAssistantMessage([fauxText("已收到参考文件。")]);
    }]);
    const hub = await openHub(init);
    const transcribe = vi.spyOn(hub, "transcribeVoiceAsset");
    const audio = hub.uploads.saveUpload({ name: "reference.mp3", mimeType: "audio/mpeg", bytes: Buffer.from("ID3-reference-audio"), ownerId: "local" });
    const file = hub.uploads.saveUpload({ name: "instructions.txt", bytes: Buffer.from("配置参考内容"), ownerId: "local" });
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.send", content: "", attachments: [file, audio], context, requestId: "attachment-only" });
    await client.wait("hub.ack", (message) => message.requestId === "attachment-only");
    const snapshot = await settled(hub, (value) => value.messages.some((message) => message.text.includes("已收到参考文件")));
    expect(snapshot.messages.find((message) => message.role === "user")).toMatchObject({ text: "", attachments: [file, audio] });
    expect(JSON.stringify(receivedContents)).toContain("配置参考内容");
    expect(JSON.stringify(receivedContents)).toContain("reference.mp3");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects empty, malformed, missing, and unauthorized attachment inputs without admitting a message", async () => {
    const { provider, init } = makeFixture();
    const calls = vi.fn(() => fauxAssistantMessage([fauxText("不应调用模型。")]));
    provider.setResponses([calls]);
    const hub = await openHub(init);
    const privateFile = hub.uploads.saveUpload({ name: "private.txt", bytes: Buffer.from("private"), ownerId: context.clientId });
    const client = await openClient(hub);
    for (const [requestId, content, attachments, expectedCode] of [
      ["empty", " ", [], undefined],
      ["malformed", "检查设置", {}, undefined],
      ["missing", "检查设置", [{ ...privateFile, id: "att_missing_asset" }], "attachment_not_found"],
      ["foreign", "检查设置", [privateFile], "attachment_forbidden"],
      ["null-attachment", "检查设置", [null], "attachment_not_found"],
    ] as const) {
      client.send({ type: "settings.assistant.send", content, context, attachments: attachments as unknown as ChatAttachment[], requestId });
      const failure = await client.wait("hub.error", (message) => message.requestId === requestId);
      if (expectedCode) expect(failure.code).toBe(expectedCode);
      expect((await hub.settingsAssistant.getSnapshot()).messages).toEqual([]);
    }
    expect(calls).not.toHaveBeenCalled();
    expect(hub.uploads.getUpload(privateFile.id)?.record.referenceScopes).toEqual([]);
  });

  it("starts a new settings conversation and reloads its complete configuration history across pages", async () => {
    const { provider, init } = makeFixture();
    const nextContexts: string[] = [];
    provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("kulo_settings_update", {
        block: "executor", changes: JSON.stringify({ maxConcurrentWorkers: 3 }), title: "并发上限改为 3",
      })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("旧上下文已完成。")]),
      (ctx) => { nextContexts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage([fauxText("全新上下文。")]); },
    ]);
    const hub = await openHub(init);
    const client = await openClient(hub);
    const other = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe-sessions" });
    other.send({ type: "settings.assistant.subscribe", context: { ...context, clientId: "other-session-client" }, requestId: "subscribe-other" });
    await client.wait("hub.ack", (message) => message.requestId === "subscribe-sessions");
    await other.wait("hub.ack", (message) => message.requestId === "subscribe-other");
    client.send({ type: "settings.assistant.send", content: "settings-old-request-marker", context, expectedTopicId: null, requestId: "old-send" });
    await client.wait("hub.ack", (message) => message.requestId === "old-send");
    const original = await settled(hub, (value) => value.messages.some((message) => message.text.includes("旧上下文已完成")));
    const applied = hub.getSettingsView();
    expect(applied.blocks.executor.value.maxConcurrentWorkers).toBe(3);
    expect(original.actions).toHaveLength(1);
    const counts = [client.received.length, other.received.length];
    client.send({ type: "settings.assistant.new", expectedTopicId: original.topicId, requestId: "new-settings-conversation" });
    await client.wait("hub.ack", (message) => message.requestId === "new-settings-conversation");
    const empty = await hub.settingsAssistant.getSnapshot();
    expect(empty).toMatchObject({ messages: [], actions: [], live: { busy: false } });
    expect(empty.topicId).toMatch(/^settings-\d+$/);
    expect(empty.topicId).not.toBe(original.topicId);
    expect(empty.conversations).toHaveLength(2);
    expect(empty.conversations.find((item) => item.topicId === original.topicId)).toMatchObject({ module: "workers" });
    const originalTitle = empty.conversations.find((item) => item.topicId === original.topicId)!.title;
    expect(originalTitle.length).toBeLessThanOrEqual(24);
    expect("settings-old-request-marker".startsWith(originalTitle)).toBe(true);
    await vi.waitFor(() => {
      for (const [index, current] of [client, other].entries()) {
        expect(current.received.slice(counts[index]).some((message) => message.type === "hub.settings_assistant" && message.snapshot.topicId === empty.topicId && message.snapshot.messages.length === 0 && message.snapshot.conversations.length === 2)).toBe(true);
      }
    });
    expect(hub.getSettingsView()).toEqual(applied);
    await expect(hub.settingsAssistant.send("过期窗口发来的请求", context, "stale-send", [], "local", original.topicId)).rejects.toThrow("设置对话已更新");
    await expect(hub.settingsAssistant.decide(original.actions[0]!.id, "undo", context.clientId, undefined, original.topicId)).rejects.toThrow("设置对话已更新");
    // A retry of an accepted input stays deduplicated after changing conversations.
    await hub.settingsAssistant.send("settings-old-request-marker", context, "old-send", [], "local", original.topicId);
    expect((await hub.settingsAssistant.getSnapshot()).messages).toEqual([]);
    client.send({ type: "settings.assistant.send", content: "从这里重新开始", context: { ...context, module: "machines" }, expectedTopicId: empty.topicId, requestId: "fresh-send" });
    await client.wait("hub.ack", (message) => message.requestId === "fresh-send");
    const fresh = await settled(hub, (value) => value.messages.some((message) => message.text.includes("全新上下文")));
    expect(fresh.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["从这里重新开始"]);
    expect(fresh.actions).toEqual([]);
    expect(nextContexts).toHaveLength(1);
    expect(nextContexts[0]).not.toContain("settings-old-request-marker");
    expect(nextContexts[0]).not.toContain("旧上下文已完成");
    expect(fresh.conversations.find((item) => item.topicId === fresh.topicId)).toMatchObject({ title: "从这里重新开始", module: "machines" });
    client.send({ type: "settings.assistant.select", topicId: original.topicId!, expectedTopicId: fresh.topicId, requestId: "load-settings-history" });
    await client.wait("hub.ack", (message) => message.requestId === "load-settings-history");
    const loaded = await hub.settingsAssistant.getSnapshot();
    expect(loaded.messages).toEqual(original.messages);
    expect(loaded.actions).toEqual(original.actions);
    expect(hub.getSettingsView()).toEqual(applied);
    // Replaying a previously committed create/select does not move a newer selection.
    await hub.settingsAssistant.newConversation(original.topicId, "new-settings-conversation");
    expect((await hub.settingsAssistant.getSnapshot()).topicId).toBe(original.topicId);
    await hub.settingsAssistant.decide(original.actions[0]!.id, "undo", context.clientId, undefined, original.topicId);
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(2);
    await hub.settingsAssistant.selectConversation(fresh.topicId!, original.topicId);
    await hub.settingsAssistant.selectConversation(original.topicId!, fresh.topicId);
    expect((await hub.settingsAssistant.getSnapshot()).actions[0]).toMatchObject({ status: "undone", canUndo: false });
    expect((await hub.getTopicView("root")).messages).toEqual([]);
  });

  it("keeps credential-save receipts out of session titles and safely rebuilds legacy history metadata", async () => {
    const { provider, init } = makeFixture();
    provider.setResponses([() => fauxAssistantMessage([fauxText("连接信息已保存。")])]);
    let hub = await openTestHub(init);
    resources.push(() => hub.close());
    const password = "settings-title-dummy-password-93025";
    const credentialContext = { ...context, module: "connections" as const };
    await hub.settingsAssistant.send(`请记住账号：demo@example.test，密码：${password}，网站 https://example.test/login`, credentialContext, "title-credential-import");
    const original = await settled(hub, (snapshot) => snapshot.messages.some((message) => message.text.includes("连接信息已保存")));
    const title = original.conversations.find((conversation) => conversation.topicId === original.topicId)!.title;
    expect(title).toContain("demo@example.test");
    expect(title.length).toBeLessThanOrEqual(24);
    expect(title).not.toContain("已安全保存");
    expect(title).not.toContain("connection-");
    expect(JSON.stringify(original)).not.toContain(password);
    await hub.settingsAssistant.newConversation(original.topicId, "new-after-credential-title");
    const fresh = await hub.settingsAssistant.getSnapshot();
    await hub.settingsAssistant.selectConversation(original.topicId!, fresh.topicId);
    expect((await hub.settingsAssistant.getSnapshot()).messages).toEqual(original.messages);
    await hub.harness.commit(async (tx) => { delete (await tx.doc(SettingsAssistantDoc)).conversations; }, BACKGROUND_CONTEXT);
    await hub.close();
    hub = await openTestHub(init);
    const recovered = await hub.settingsAssistant.getSnapshot();
    expect(recovered.conversations.find((conversation) => conversation.topicId === original.topicId)?.title).toBe(title);
    expect(recovered.messages).toEqual(original.messages);
    expect(JSON.stringify(recovered)).not.toContain(password);
  });

  it("persists every settings session and action through restart and permits new sessions without a model", async () => {
    const { provider, init } = makeFixture();
    provider.setResponses([() => fauxAssistantMessage([fauxText("重启前的回复。")])]);
    let hub = await openTestHub(init);
    resources.push(() => hub.close());
    await hub.settingsAssistant.send("历史设置需求", context, "before-new");
    const original = await settled(hub, (value) => value.messages.some((message) => message.text.includes("重启前的回复")));
    const action = await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "保存配置记录", "persisted-action");
    const model = hub.getSettingsView().blocks.model;
    await hub.updateSettingsBlock("model", model.revision, { ...model.value, defaultProvider: "", defaultModel: "" });
    await hub.settingsAssistant.newConversation(original.topicId, "new-before-restart");
    const fresh = await hub.settingsAssistant.getSnapshot();
    expect(fresh.messages).toEqual([]);
    await hub.close();
    hub = await openTestHub(init);
    expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: fresh.topicId, messages: [], actions: [], live: { busy: false } });
    expect((await hub.settingsAssistant.getSnapshot()).conversations).toHaveLength(2);
    await hub.settingsAssistant.newConversation(original.topicId, "new-before-restart");
    expect((await hub.settingsAssistant.getSnapshot()).conversations).toHaveLength(2);
    await hub.settingsAssistant.selectConversation(original.topicId!, fresh.topicId);
    const loaded = await hub.settingsAssistant.getSnapshot();
    expect(loaded.messages).toEqual(original.messages);
    expect(loaded.actions).toContainEqual(action);
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(3);
    await expect(hub.settingsAssistant.newConversation(undefined as unknown as null)).rejects.toThrow("无效的设置对话标识");
  });

  it("keeps all settings sessions out of main topics, projects, and their loading routes", async () => {
    const { init } = makeFixture();
    const hub = await openHub(init);
    const ordinary = await hub.createTopic("主聊天话题");
    const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-settings-project-")));
    resources.push(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
    const project = await hub.projects.create({ commandId: "session-isolation-project", name: "主聊天项目", deviceId: "local", workspaceDir });
    const projectTopic = await hub.createTopic("项目话题", BACKGROUND_CONTEXT, project.id);
    const topicIds = (await hub.listTopics()).map((topic) => topic.id);
    const projectTopics = (await hub.projects.listTopics(project.id)).map((topic) => topic.id);
    await hub.settingsAssistant.newConversation(null, "isolated-first");
    const first = (await hub.settingsAssistant.getSnapshot()).topicId!;
    await hub.settingsAssistant.newConversation(first, "isolated-second");
    const second = (await hub.settingsAssistant.getSnapshot()).topicId!;
    await hub.settingsAssistant.selectConversation(first, second, "isolated-load");
    expect((await hub.listTopics()).map((topic) => topic.id)).toEqual(topicIds);
    expect((await hub.projects.listTopics(project.id)).map((topic) => topic.id)).toEqual(projectTopics);
    const snapshot = await hub.getFullClientSnapshot("root");
    expect(snapshot.topics.map((topic) => topic.id)).toEqual(topicIds);
    expect(snapshot.projects.map((item) => item.id)).toEqual([project.id]);
    for (const topic of [first, second]) {
      await expect(hub.getTopicView(topic)).rejects.toMatchObject({ code: "topic_not_found" });
      await expect(hub.getTopicHistory(topic, 1_000_000)).rejects.toMatchObject({ code: "topic_not_found" });
    }
    const ordinaryConversationId = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!.topics![ordinary.id]!.conversationId;
    for (const target of ["root", ordinary.id, projectTopic.id, `settings-${Number(hub.rootConversation.id)}`, `settings-${ordinaryConversationId}`]) {
      await expect(hub.settingsAssistant.selectConversation(target, first)).rejects.toThrow();
    }
    await expect(hub.settingsAssistant.newConversation(second)).rejects.toThrow("设置对话已更新");
    await expect(hub.settingsAssistant.selectConversation(second, second)).rejects.toThrow("设置对话已更新");
    await hub.settingsAssistant.selectConversation(second, first);
    await hub.settingsAssistant.selectConversation(first, second, "isolated-load");
    expect((await hub.settingsAssistant.getSnapshot()).topicId).toBe(second);
    expect((await hub.settingsAssistant.getSnapshot()).conversations).toHaveLength(2);
  });

  it("deletes inactive and active settings sessions without changing applied configuration or background work", async () => {
    const { provider, init } = makeFixture();
    provider.setResponses(Array.from({ length: 4 }, () => () => fauxAssistantMessage([fauxText("设置请求已处理。")])));
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe-delete" });
    await client.wait("hub.ack", (message) => message.requestId === "subscribe-delete");
    await hub.settingsAssistant.send("检查智能体并发参数", context, "before-delete");
    const original = await settled(hub, (snapshot) => snapshot.messages.some((message) => message.text.includes("设置请求已处理")));
    await hub.settingsAssistant.read("workers");
    await hub.settingsAssistant.update("executor", '{"maxConcurrentWorkers":3}', "保存并发配置", "delete-applied-action");
    await hub.settingsAssistant.newConversation(original.topicId, "delete-new-session");
    await hub.settingsAssistant.send("继续检查其他配置", context, "after-new");
    const active = await settled(hub, (snapshot) => snapshot.messages.some((message) => message.text.includes("设置请求已处理")));
    const settings = hub.getSettingsView();
    const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const board = await hub.getBoardSnapshot();
    client.send({ type: "settings.assistant.delete", topicId: original.topicId!, expectedTopicId: active.topicId, requestId: "delete-inactive" });
    await client.wait("hub.ack", (message) => message.requestId === "delete-inactive");
    const afterInactive = await hub.settingsAssistant.getSnapshot();
    expect(afterInactive).toMatchObject({ topicId: active.topicId, messages: active.messages, actions: active.actions });
    expect(afterInactive.conversations.map((item) => item.topicId)).toEqual([active.topicId]);
    expect(hub.getSettingsView()).toEqual(settings);
    expect(await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT)).toEqual(state);
    expect((await hub.getBoardSnapshot()).tickets).toEqual(board.tickets);
    await expect(hub.settingsAssistant.selectConversation(original.topicId!, active.topicId)).rejects.toThrow("设置历史对话不存在");
    await hub.settingsAssistant.deleteConversation(active.topicId!, active.topicId, "delete-active");
    const blank = await hub.settingsAssistant.getSnapshot();
    expect(blank).toMatchObject({ topicId: null, messages: [], actions: [], conversations: [], live: { busy: false } });
    await hub.settingsAssistant.deleteConversation(original.topicId!, active.topicId, "delete-inactive");
    await hub.settingsAssistant.deleteConversation(active.topicId!, active.topicId, "delete-active");
    expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: null, conversations: [] });
    expect(hub.getSettingsView()).toEqual(settings);
  });

  it("persists deletion tombstones through restart and refuses remigration, stale deletion and main-chat targets", async () => {
    const { init } = makeFixture();
    let hub = await openTestHub(init);
    resources.push(() => hub.close());
    await hub.settingsAssistant.newConversation(null, "delete-first");
    const first = (await hub.settingsAssistant.getSnapshot()).topicId!;
    await hub.settingsAssistant.newConversation(first, "delete-second");
    const second = (await hub.settingsAssistant.getSnapshot()).topicId!;
    await expect(hub.settingsAssistant.deleteConversation(first, first)).rejects.toThrow("设置对话已更新");
    await expect(hub.settingsAssistant.deleteConversation("root", second)).rejects.toThrow("无效的设置对话标识");
    await expect(hub.settingsAssistant.deleteConversation(`settings-${Number(hub.rootConversation.id)}`, second)).rejects.toThrow("设置历史对话不存在");
    await hub.settingsAssistant.deleteConversation(first, second, "remove-first");
    await hub.settingsAssistant.deleteConversation(second, second, "remove-second");
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      state.archivedConversationIds = [Number(first.slice(9)), Number(second.slice(9))];
      delete state.conversations;
    }, BACKGROUND_CONTEXT);
    await hub.close();
    hub = await openTestHub(init);
    expect(await hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: null, conversations: [] });
    for (const id of [first, second]) await expect(hub.settingsAssistant.selectConversation(id, null)).rejects.toThrow("设置历史对话不存在");
    const ids = await hub.settingsAssistant.conversationIds();
    expect(ids).toEqual(expect.arrayContaining([Number(first.slice(9)), Number(second.slice(9))]));
    expect((await hub.listTopics()).map((item) => item.id)).toEqual(["root"]);
  });

  it("recovers legacy archived transcripts and exposes their surviving action receipts only as historical records", async () => {
    const { provider, init } = makeFixture();
    provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("kulo_settings_update", { block: "executor", changes: '{"maxConcurrentWorkers":3}', title: "历史并发配置" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("已完成历史配置。")]),
    ]);
    let hub = await openTestHub(init);
    resources.push(() => hub.close());
    await hub.settingsAssistant.send("旧版设置会话", context, "legacy-send");
    const original = await settled(hub, (value) => value.messages.some((message) => message.text.includes("已完成历史配置")));
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      state.archivedConversationIds = [state.conversationId!];
      state.conversationId = null;
      state.actions = [];
      state.turnContext = null;
      state.observedRevisions = {};
      delete state.conversations;
    }, BACKGROUND_CONTEXT);
    await hub.close();
    hub = await openTestHub(init);
    const history = await hub.settingsAssistant.getSnapshot();
    expect(history.conversations).toHaveLength(1);
    expect(history.conversations[0]).toMatchObject({ topicId: original.topicId, title: "旧版设置会话" });
    await hub.settingsAssistant.selectConversation(original.topicId!, null);
    const recovered = await hub.settingsAssistant.getSnapshot();
    expect(recovered.messages).toEqual(original.messages);
    expect(recovered.actions).toContainEqual(expect.objectContaining({ title: "历史并发配置", historical: true, requiresConfirmation: false, canUndo: false }));
    await expect(hub.settingsAssistant.decide(recovered.actions[0]!.id, "undo", context.clientId)).rejects.toThrow("历史回执仅供查看");
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(3);
  });

  it("correlates subscription snapshots and rejects unsupported actions rather than silently waiting", async () => {
    const { init } = makeFixture();
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe-correlated" });
    const snapshot = await client.wait("hub.settings_assistant", (message) => message.requestId === "subscribe-correlated");
    expect(snapshot.snapshot.topicId).toBeNull();
    await client.wait("hub.ack", (message) => message.requestId === "subscribe-correlated");
    for (const action of ["settings.assistant.unknown", "unknown.future-action"]) {
      client.send({ type: action, requestId: `unsupported-${action}` } as unknown as ClientToHubMessage);
      const failure = await client.wait("hub.error", (message) => message.requestId === `unsupported-${action}`);
      expect(failure).toMatchObject({ code: "unsupported_action", action });
    }
    expect((await hub.settingsAssistant.getSnapshot()).topicId).toBeNull();
  });

  it("opens and changes pages without a model request or conversation, and preserves a rejected first-install draft", async () => {
    const { provider, init } = makeFixture();
    let calls = 0;
    provider.setResponses([() => { calls++; return fauxAssistantMessage([fauxText("已连接。")]); }]);
    const hub = await openHub({ ...init, config: { ...init.config, model: { ...init.config.model, defaultProvider: "", defaultModel: "" } } });
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe" });
    const initial = await client.wait("hub.settings_assistant");
    expect(initial.snapshot).toMatchObject({ topicId: null, messages: [], actions: [], live: { busy: false } });
    client.send({ type: "settings.assistant.context", context: { ...context, module: "appearance" }, requestId: "change-page" });
    await client.wait("hub.ack", (message) => message.requestId === "change-page");
    expect(calls).toBe(0);
    expect((await hub.settingsAssistant.getSnapshot()).topicId).toBeNull();
    client.send({ type: "settings.assistant.send", content: "保留这段草稿", context, requestId: "first-draft" });
    const failure = await client.wait("hub.error", (message) => message.requestId === "first-draft");
    expect(failure.action).toBe("settings.assistant.send");
    expect(failure.code).toBe("model_not_selected");
    expect((await hub.settingsAssistant.getSnapshot()).messages).toEqual([]);
    expect((await hub.getTopicView("root")).messages).toEqual([]);
    const model = hub.getSettingsView().blocks.model;
    await hub.updateSettingsBlock("model", model.revision, { ...model.value, defaultProvider: "openai", defaultModel: "settings-model", thinkingLevel: "off" });
    client.send({ type: "settings.assistant.send", content: "保留这段草稿", context, requestId: "first-draft" });
    await client.wait("hub.ack", (message) => message.requestId === "first-draft");
    const snapshot = await settled(hub, (value) => value.messages.some((message) => message.role === "assistant" && message.text.includes("已连接")));
    expect(snapshot.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("applies a safe change, keeps main chat isolated, and undoes only its own fields after a later edit", async () => {
    const { provider, init } = makeFixture();
    const observedTools: string[][] = [];
    provider.setResponses([
      (ctx) => {
        observedTools.push(toolNames(ctx));
        return fauxAssistantMessage([fauxToolCall("kulo_settings_update", {
          block: "executor", changes: JSON.stringify({ maxConcurrentWorkers: 3 }), title: "并发上限改为 3",
        })], { stopReason: "toolUse" });
      },
      (ctx) => { observedTools.push(toolNames(ctx)); return fauxAssistantMessage([fauxText("并发上限已改为 3。")]); },
      () => fauxAssistantMessage([fauxText("普通聊天回复。")]),
    ]);
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe" });
    await client.wait("hub.ack", (message) => message.requestId === "subscribe");
    client.send({ type: "settings.assistant.send", content: "把并发上限改成 3", context, requestId: "set-concurrency" });
    await client.wait("hub.ack", (message) => message.requestId === "set-concurrency");
    const snapshot = await settled(hub, (value) => value.actions.some((action) => action.status === "applied"));
    const action = snapshot.actions.find((value) => value.status === "applied")!;
    expect(action).toMatchObject({ requiresConfirmation: false, canUndo: true });
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(3);
    for (const names of observedTools) {
      expect(names).toContain("kulo_settings_update");
      expect(names).toContain("tool_search");
      expect(names.some((name) => /kulo_report|kulo_subagent|^bash$|^write$|^edit$/.test(name))).toBe(false);
    }
    const settingsDoc1 = await hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConv1 = (await hub.harness.conversation(settingsDoc1!.conversationId as never, BACKGROUND_CONTEXT))!;
    const settingsAgent1 = await settingsConv1.agent(BACKGROUND_CONTEXT);
    expect(settingsAgent1.deferred.map((t) => t.name)).toEqual(expect.arrayContaining(["kulo_dispatch", "read"]));
    expect(settingsAgent1.callable.some((t) => /kulo_report|kulo_subagent|^bash$|^write$|^edit$/.test(t.name))).toBe(false);
    expect((await hub.listTopics()).map((topic) => topic.id)).toEqual(["root"]);
    expect((await hub.getTopicView("root")).messages).toEqual([]);
    const block = hub.getSettingsView().blocks.executor;
    await hub.updateSettingsBlock("executor", block.revision, { ...block.value, watchdogMinutes: 7 });
    client.send({ type: "settings.assistant.action", actionId: action.id, decision: "undo", clientId: context.clientId, requestId: "undo" });
    await client.wait("hub.ack", (message) => message.requestId === "undo");
    expect(hub.getSettingsView().blocks.executor.value).toMatchObject({ maxConcurrentWorkers: 2, watchdogMinutes: 7 });
    client.send({ type: "chat.send", topicId: "root", content: "普通聊天", requestId: "main-chat" });
    await client.wait("hub.ack", (message) => message.requestId === "main-chat");
    await client.wait("hub.messages", (message) => message.messages.some((item) => item.text.includes("普通聊天回复")));
    expect((await hub.settingsAssistant.getSnapshot()).messages.some((message) => message.text.includes("普通聊天"))).toBe(false);
  });

  it("requires confirmation before removing a connection and deduplicates repeated confirmation", async () => {
    const { provider, init } = makeFixture();
    init.config.model = { ...init.config.model, ...{
      customProviders: [{ id: "api-removable", name: "测试连接", api: "openai-completions" as const, baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "unused" }] }],
    } };
    provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("kulo_settings_remove_connection", { provider_id: "api-removable" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("请确认删除测试连接。")]),
    ]);
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe" });
    await client.wait("hub.ack", (message) => message.requestId === "subscribe");
    client.send({ type: "settings.assistant.send", content: "删除测试连接", context: { ...context, module: "models" }, requestId: "delete-connection" });
    const pending = await settled(hub, (value) => value.actions.some((action) => action.status === "pending" && action.requiresConfirmation));
    const action = pending.actions.find((value) => value.status === "pending")!;
    expect(hub.getSettingsView().blocks.model.value.customProviders).toHaveLength(1);
    client.send({ type: "settings.assistant.action", actionId: action.id, decision: "confirm", clientId: context.clientId, requestId: "confirm-delete" });
    await client.wait("hub.ack", (message) => message.requestId === "confirm-delete");
    expect(hub.getSettingsView().blocks.model.value.customProviders).toHaveLength(0);
    const revision = hub.getSettingsView().globalRevision;
    client.send({ type: "settings.assistant.action", actionId: action.id, decision: "confirm", clientId: context.clientId, requestId: "confirm-delete-again" });
    await client.wait("hub.ack", (message) => message.requestId === "confirm-delete-again");
    expect(hub.getSettingsView().globalRevision).toBe(revision);
  });

  it("protects a draft started after sending while the model is still generating", async () => {
    const { provider, init } = makeFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    provider.setResponses([
      async () => {
        entered = true;
        await gate;
        return fauxAssistantMessage([fauxToolCall("kulo_settings_update", {
          block: "executor", changes: JSON.stringify({ maxConcurrentWorkers: 3 }), title: "调整并发",
        })], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([fauxText("请先处理未保存的修改。")]),
    ]);
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe" });
    await client.wait("hub.ack", (message) => message.requestId === "subscribe");
    client.send({ type: "settings.assistant.send", content: "修改并发", context, requestId: "draft-race" });
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5_000 });
    client.send({ type: "settings.assistant.context", context: { ...context, hasUnsavedChanges: true }, requestId: "draft-started" });
    await client.wait("hub.ack", (message) => message.requestId === "draft-started");
    release();
    const snapshot = await settled(hub, (value) => value.messages.some((message) => message.role === "assistant" && message.text.includes("未保存")));
    expect(hub.getSettingsView().blocks.executor.value.maxConcurrentWorkers).toBe(2);
    expect(snapshot.actions.some((action) => action.status === "applied")).toBe(false);
  });

  it("restores settings history without generating a reply and keeps the tool boundary after restart", async () => {
    const { provider, init } = makeFixture();
    let calls = 0;
    const tools: string[][] = [];
    provider.setResponses(Array.from({ length: 3 }, () => (ctx: TranscriptContext) => {
      calls++; tools.push(toolNames(ctx)); return fauxAssistantMessage([fauxText("设置会话回复。")]);
    }));
    const first = await openHub(init);
    await first.settingsAssistant.send("设置会话第一条", context, "persisted-send");
    const before = await settled(first, (snapshot) => snapshot.messages.some((message) => message.role === "assistant"));
    await first.close();
    const second = await openHub(init);
    const restored = await second.settingsAssistant.getSnapshot();
    expect(restored.messages).toEqual(before.messages);
    expect(calls).toBe(1);
    const model = second.getSettingsView().blocks.model;
    await second.updateSettingsBlock("model", model.revision, { ...model.value, thinkingLevel: "off" });
    await second.settingsAssistant.send("继续设置会话", { ...context, module: "models" }, "after-restart");
    await settled(second, (snapshot) => snapshot.messages.filter((message) => message.role === "assistant").length === 2);
    expect(calls).toBe(2);
    for (const names of tools) {
      expect(names).toContain("kulo_settings_read");
      expect(names).toContain("tool_search");
      expect(names.some((name) => /kulo_report|kulo_subagent|^bash$|^write$|^edit$/.test(name))).toBe(false);
    }
    const settingsDoc2 = await second.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConv2 = (await second.harness.conversation(settingsDoc2!.conversationId as never, BACKGROUND_CONTEXT))!;
    const settingsAgent2 = await settingsConv2.agent(BACKGROUND_CONTEXT);
    expect(settingsAgent2.deferred.map((t) => t.name)).toEqual(expect.arrayContaining(["kulo_dispatch", "read"]));
    expect(settingsAgent2.callable.some((t) => /kulo_report|kulo_subagent|^bash$|^write$|^edit$/.test(t.name))).toBe(false);
    expect((await second.getTopicView("root")).messages).toEqual([]);
  });

  it("dispatches background worker tasks from settings chat and relays results back to the same settings conversation", async () => {
    const { provider, init } = makeFixture();
    provider.setResponses([
      () => fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "kulo_dispatch", limit: 3 }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([
        fauxToolCall("kulo_dispatch", {
          command_id: "cmd-env-check",
          title: "检查本机 Node 环境",
          goal: "检查运行环境并汇报状态",
          scope: "只读检查本机环境",
          role: "scout",
        }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("已为你派发环境检查任务。")]),
      () => fauxAssistantMessage([
        fauxToolCall("kulo_report", {
          state: "ready",
          summary: "Node v22 环境正常，端口可用。",
        }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("本机 Node 环境检查已通过，可以继续配置。")]),
    ]);
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "subscribe" });
    await client.wait("hub.ack", (message) => message.requestId === "subscribe");
    client.send({ type: "settings.assistant.send", content: "帮我检查一下本机运行环境", context, requestId: "dispatch-from-settings" });
    await client.wait("hub.ack", (message) => message.requestId === "dispatch-from-settings");

    const finalSnapshot = await settled(
      hub,
      (snapshot) => snapshot.messages.some((message) => message.role === "assistant" && message.text.includes("本机 Node 环境检查已通过")),
    );
    expect(finalSnapshot.messages.some((message) => message.role === "dispatch")).toBe(true);
    expect((await hub.getTopicView("root")).messages).toEqual([]);
    const board = await hub.getBoardSnapshot();
    expect(board.tickets[0]?.originTopicId).toBe(finalSnapshot.topicId);
  });

  it("seals pasted device pairing commands with join_ref and executes confirmed join without exposing pairing tokens", async () => {
    const { provider, init } = makeFixture();
    const secretToken = "unit-fixture-device-invitation-0000000000001";
    const pastedInstructions = [
      "macOS / Linux:",
      `curl -fsSL 'http://host.example.test:7788/connect/install.sh' | sh -s -- 'http://host.example.test:7788' '${secretToken}'`,
      "",
      "Windows PowerShell:",
      `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'http://host.example.test:7788/connect/install.ps1').Content)) 'http://host.example.test:7788' '${secretToken}'`,
    ].join("\n");

    const seenUserTexts: string[] = [];
    const seenToolSets: string[][] = [];
    provider.setResponses([
      (ctx) => {
        seenToolSets.push(toolNames(ctx));
        const userMsg = [...ctx.messages].reverse().find((m) => m.role === "user");
        const text = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(userMsg?.content ?? "");
        seenUserTexts.push(text);
        const match = /join_ref=(join_[a-f0-9]+)/.exec(text);
        expect(match).not.toBeNull();
        return fauxAssistantMessage([
          fauxToolCall("kulo_devices_join", { join_ref: match![1]! }),
        ], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([fauxText("已识别主机接入指令，请在卡片中确认接入 host.example.test:7788。")]),
    ]);

    const hub = await openHub(init);
    let joinedWith: { hubUrl: string; inviteToken: string } | undefined;
    const server = await startKuloHubServer(hub, {
      host: "127.0.0.1",
      port: 0,
      onJoinPeer: () => {},
    });
    resources.push(() => server.close());
    hub.bindDeviceController({
      view: () => ({
        enabled: false,
        role: "hub",
        hubId: "local-hub",
        hubName: "LocalHost",
        currentDeviceId: "local",
        canSwitchRole: true,
        hubUrls: [],
        devices: [{ id: "local", name: "LocalHost", kind: "local", status: "online", rootDir: init.config.localEnvRoot }],
      }),
      setEnabled: async () => { throw new Error("unused"); },
      rename: async () => { throw new Error("unused"); },
      createInvitation: async () => { throw new Error("unused"); },
      inspectSshCredential: () => ({ eligible: false, reason: "unused" }),
      addSsh: async () => undefined,
      removeDevice: async () => {},
      canSwitchRole: () => true,
      joinPeer: async (input, _force, id) => {
        return {
          receipt: { id, targetRole: "joined", status: "switching" },
          start: async () => { joinedWith = input; },
          cancel: () => {},
        };
      },
    });

    const machinesContext: SettingsAssistantContext = { ...context, module: "machines" };
    await hub.settingsAssistant.send(pastedInstructions, machinesContext, "join-send");
    const pending = await settled(hub, (snapshot) => snapshot.actions.some((action) => action.status === "pending" && action.requiresConfirmation));

    expect(seenToolSets[0]).toEqual(expect.arrayContaining(["kulo_settings_read", "kulo_devices_manage", "kulo_devices_join", "kulo_devices_leave"]));
    expect(seenUserTexts[0]).not.toContain(secretToken);
    expect(seenUserTexts[0]).toContain("join_ref=join_");
    expect(JSON.stringify(pending)).not.toContain(secretToken);

    const action = pending.actions.find((item) => item.status === "pending")!;
    await hub.settingsAssistant.decide(action.id, "confirm", machinesContext.clientId, undefined, pending.topicId);
    await vi.waitFor(() => expect(joinedWith).toEqual({ hubUrl: "http://host.example.test:7788", inviteToken: secretToken }));
    const after = await hub.settingsAssistant.getSnapshot();
    expect(after.actions.find((item) => item.id === action.id)?.status).toBe("submitted");
  });

  it("emits a fresh settings snapshot with prior history and live.busy before acknowledging send", async () => {
    const { provider, init } = makeFixture();
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    provider.setResponses([
      () => fauxAssistantMessage([fauxText("第一轮回复。")]),
      async () => {
        await secondGate;
        return fauxAssistantMessage([fauxText("第二轮回复。")]);
      },
    ]);
    const hub = await openHub(init);
    const client = await openClient(hub);
    client.send({ type: "settings.assistant.subscribe", context, requestId: "sub-fresh" });
    await client.wait("hub.settings_assistant", (message) => message.requestId === "sub-fresh");

    client.send({ type: "settings.assistant.send", content: "第一轮问题", context, requestId: "send-1" });
    await client.wait("hub.ack", (message) => message.requestId === "send-1");
    await settled(hub, (snapshot) => snapshot.messages.some((item) => item.text.includes("第一轮回复")));

    const beforeSecondCount = client.received.length;
    client.send({ type: "settings.assistant.send", content: "第二轮问题", context, requestId: "send-2" });
    await client.wait("hub.ack", (message) => message.requestId === "send-2");

    const framesForSecond = client.received.slice(beforeSecondCount);
    const ackIndex = framesForSecond.findIndex((message) => message.type === "hub.ack" && message.requestId === "send-2");
    expect(ackIndex).toBeGreaterThan(0);
    const snapshotsBeforeAck = framesForSecond
      .slice(0, ackIndex)
      .filter((message): message is Extract<HubToClientMessage, { type: "hub.settings_assistant" }> => message.type === "hub.settings_assistant");
    expect(snapshotsBeforeAck.length).toBeGreaterThan(0);
    const latestBeforeAck = snapshotsBeforeAck.at(-1)!.snapshot;
    expect(latestBeforeAck.live.busy).toBe(true);
    expect(latestBeforeAck.messages.map((item) => item.text)).toEqual(
      expect.arrayContaining(["第一轮问题", "第一轮回复。", "第二轮问题"]),
    );

    releaseSecond();
    await settled(hub, (snapshot) => snapshot.messages.some((item) => item.text.includes("第二轮回复")));
  });

  it("allows joined peers to add SSH devices through the Hub, resolves section=current per client, isolates per-turn KuloUserEntry source, and restricts settings kulo_host_action to read-only inspect", async () => {
    const { provider, init } = makeFixture();
    const seenPrompts: string[] = [];
    const seenToolResults: Array<{ name: string; isError: boolean; text: string }> = [];
    let turn = 0;

    const extractSystemPrompt = (ctx: TranscriptContext) => {
      const kuloSections = ctx.messages
        .filter((m): m is Extract<typeof m, { role: "system" }> => m.role === "system")
        .map((m) => m.sections?.kulo_settings)
        .filter((value): value is string => typeof value === "string");
      return kuloSections.at(-1) ?? ctx.systemPrompt ?? "";
    };

    provider.setResponses([
      // Turn 1 (Macbook joined peer): read current, check enable idempotency, try disable (blocked), propose ssh add
      (ctx) => {
        turn += 1;
        seenPrompts.push(extractSystemPrompt(ctx));
        return fauxAssistantMessage([
          fauxToolCall("kulo_settings_read", { section: "current" }),
          fauxToolCall("kulo_devices_manage", { action: "enable" }),
          fauxToolCall("kulo_devices_manage", { action: "disable" }),
          fauxToolCall("kulo_devices_ssh_add", { connection_id: "connection-kulostation", name: "KuloStation" }),
        ], { stopReason: "toolUse" });
      },
      (ctx) => {
        for (const msg of ctx.messages) {
          if (msg.role === "toolResult") {
            const text = typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : JSON.stringify(part))).join("\n")
                : JSON.stringify(msg.content);
            seenToolResults.push({ name: msg.toolName, isError: Boolean(msg.isError), text });
          }
        }
        return fauxAssistantMessage([fauxText("已通过主机 MacMini 准备接入 KuloStation，请确认卡片。")]);
      },
      // Turn 2 (MacMini hub window): discover kulo_host_action, run read-only inspect (allowed) + mutating run (rejected)
      (ctx) => {
        turn += 1;
        seenPrompts.push(extractSystemPrompt(ctx));
        return fauxAssistantMessage([
          fauxToolCall("tool_search", { query: "kulo_host_action", limit: 3 }),
        ], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([
        fauxToolCall("kulo_host_action", { action: "inspect", scope: "summary", filter: String(process.pid), limit: 5 }),
        fauxToolCall("kulo_host_action", { action: "run", summary: "非法变更", commands: ["echo nope"] }),
      ], { stopReason: "toolUse" }),
      (ctx) => {
        for (const msg of ctx.messages) {
          if (msg.role === "toolResult" && msg.toolName === "kulo_host_action") {
            const text = typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : JSON.stringify(part))).join("\n")
                : JSON.stringify(msg.content);
            seenToolResults.push({ name: msg.toolName, isError: Boolean(msg.isError), text });
          }
        }
        return fauxAssistantMessage([fauxText("只读诊断完成。")]);
      },
    ]);

    const hub = await openHub(init);
    const macbookContext: SettingsAssistantContext = {
      module: "machines", hasUnsavedChanges: false, appearance: "dark", clientId: "win-macbook",
    };
    const macminiContext: SettingsAssistantContext = {
      module: "machines", hasUnsavedChanges: false, appearance: "light", clientId: "win-macmini",
    };

    hub.bindDeviceController({
      view: (clientId) => {
        const isMacbook = clientId === "win-macbook";
        return {
          enabled: true,
          role: isMacbook ? "joined" : "hub",
          hubId: "hub-macmini",
          hubName: "MacMini",
          primaryNodeId: "local",
          currentDeviceId: isMacbook ? "macbook-peer" : "local",
          currentDeviceKnown: true,
          canSwitchRole: true,
          canManageHub: true,
          canManageStandby: true,
          hubUrls: ["http://192.0.2.2:7788"],
          devices: [
            { id: "local", name: "MacMini", kind: "local", status: "online", rootDir: init.config.localEnvRoot },
            { id: "macbook-peer", name: "Macbook", kind: "peer", status: "online", rootDir: "/Users/demo/Kulo" },
          ],
        };
      },
      setEnabled: async () => { throw new Error("should not call setEnabled"); },
      rename: async () => { throw new Error("unused"); },
      createInvitation: async () => { throw new Error("unused"); },
      inspectSshCredential: (connectionId) => (
        connectionId === "connection-kulostation"
          ? {
              eligible: true,
              connection: {
                id: "connection-kulostation",
                name: "KuloStation",
                kind: "ssh",
                category: "server",
                status: "verified",
                hasCredential: true,
                host: "192.0.2.50",
                port: 22,
                username: "demo",
                hostFingerprint: "SHA256:test",
                createdAt: 1,
                updatedAt: 1,
              },
            }
          : { eligible: false, reason: "not found" }
      ),
      addSsh: async () => undefined,
      removeDevice: async () => {},
      canSwitchRole: () => true,
    });

    // Turn 1 from joined peer Macbook
    await hub.settingsAssistant.send("在 KuloStation 安装 kulo，并连接上本机", macbookContext, "peer-ssh-1", [], "macbook-peer");
    const afterPeerTurn = await settled(hub, (snapshot) =>
      snapshot.messages.some((item) => item.role === "assistant" && item.text.includes("已通过主机 MacMini")),
    );

    const pendingSsh = afterPeerTurn.actions.find((a) => a.status === "pending" && a.title.includes("KuloStation"));
    expect(pendingSsh).toBeDefined();
    expect(pendingSsh?.title).toContain("通过主机 MacMini");
    expect(pendingSsh?.changes).toContain("执行主机：MacMini");

    const readCurrent = seenToolResults.find((r) => r.name === "kulo_settings_read");
    expect(readCurrent?.isError).toBe(false);
    expect(readCurrent?.text).toContain('"role":"joined"');
    expect(readCurrent?.text).toContain('"currentDeviceId":"macbook-peer"');

    const enableRes = seenToolResults.find((r) => r.name === "kulo_devices_manage" && !r.isError);
    expect(enableRes?.text).toContain("设备互联已开启");
    const disableRes = seenToolResults.find((r) => r.name === "kulo_devices_manage" && r.isError);
    expect(disableRes?.text).toContain("kulo_devices_leave");

    // promptContext reflects Macbook client + MacMini Hub host
    expect(seenPrompts[0]).toContain('"clientDevice":{"id":"macbook-peer","name":"Macbook"');
    expect(seenPrompts[0]).toContain('"hubHost":{"id":"local","name":"MacMini"}');

    // Turn 2 from Hub MacMini in the same settings conversation
    await hub.settingsAssistant.send("查一下本机进程并尝试执行命令", macminiContext, "hub-inspect-2", [], "local");
    await settled(hub, (snapshot) =>
      snapshot.messages.some((item) => item.role === "assistant" && item.text.includes("只读诊断完成")),
    );
    expect(turn).toBe(2);
    expect(seenPrompts[1]).toContain('"clientDevice":{"id":"local","name":"MacMini"');

    // kulo_host_action inspect succeeds while mutating run is rejected in Settings Assistant
    const hostActionResults = seenToolResults.filter((r) => r.name === "kulo_host_action");
    expect(hostActionResults.some((r) => !r.isError && r.text.includes('"ok":true'))).toBe(true);
    expect(hostActionResults.some((r) => r.isError && r.text.includes("只读诊断"))).toBe(true);

    // Per-turn immutable KuloUserEntry source metadata does not clobber earlier turns across windows
    const settingsDoc = await hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const conv = (await hub.harness.conversation(settingsDoc!.conversationId as never, BACKGROUND_CONTEXT))!;
    const entries = await conv.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    const userEntries = entries.items.filter((e) => e.kind === "kulo.user");
    const turn1Entry = userEntries.find((e) => (e.data as { requestId?: string } | undefined)?.requestId === "peer-ssh-1");
    const turn2Entry = userEntries.find((e) => (e.data as { requestId?: string } | undefined)?.requestId === "hub-inspect-2");
    expect(turn1Entry?.data).toMatchObject({ source: { deviceId: "macbook-peer", name: "Macbook", kind: "computer" } });
    expect(turn2Entry?.data).toMatchObject({ source: { deviceId: "local", name: "MacMini", kind: "computer" } });
  });
});
