import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { MocoHub, MocoStateDoc, startMocoHubServer } from "@moco/hub";
import type { ChatAttachment, ChatDisplayItem, ClientToHubMessage, DeviceInvitation, DevicePeerConfig, HubToClientMessage, MessagePart, UiActionInput, UiActionReceipt, UiCardInput, UiCardSnapshot } from "@moco/protocol";
import WebSocket from "ws";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { ContentPublicationEntry, type ContentPublicationData } from "../packages/hub/src/ui-cards.js";
import { UserEntry, type JsonObject } from "@earendil-works/pi-durable";

const NODE_TOKEN = "moco-rich-chat-node-test-token";
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_AUTH_TOKEN", "MOCO_ENV_TOKENS", "MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function form(title = "处理方式"): UiCardInput {
  return { title, actions: [{ id: "submit", label: "提交", kind: "submit" }], spec: { root: "card", elements: {
    card: { type: "Card", props: {}, children: ["name", "submit"] },
    name: { type: "TextField", props: { field: "name", label: "名称", required: true, maxLength: 30 } },
    submit: { type: "Button", props: { actionId: "submit", label: "提交" } },
  } } };
}
function toolNames(context: TranscriptContext): string[] {
  return [...new Set([...(context.tools?.map((tool) => tool.name) ?? []), ...context.messages.flatMap((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) ? message.toolsAdded.map((tool) => tool.name) : [])])];
}
function parts(messages: Array<{ parts?: MessagePart[] }>): MessagePart[] { return messages.flatMap((message) => message.parts ?? []); }

async function fixture(existingDir?: string) {
  const stateDir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-rich-chat-"));
  if (!existingDir) cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "rich-chat-model" }] });
  provider.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage([fauxText("已收到。")])));
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, envTokens: { "rich-chat-node": NODE_TOKEN }, workerEnvIds: [],
    stateDir, identityDir: path.join(stateDir, "identity"), enableLocalEnv: true,
    watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "rich-chat-model", thinkingLevel: "off", apiKey: "" },
  } });
  let hubClosed = false;
  cleanup.push(async () => { if (!hubClosed) { hubClosed = true; await hub.close(); } });
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  let serverClosed = false;
  cleanup.push(async () => { if (!serverClosed) { serverClosed = true; await server.close(); } });
  const request = (pathname: string, method = "GET", body?: unknown, token = HUB_TEST_ADMIN_TOKEN, headers: Record<string, string> = {}) => fetch(`${server.url}${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const close = async () => {
    if (!serverClosed) { serverClosed = true; await server.close(); }
    if (!hubClosed) { hubClosed = true; await hub.close(); }
  };
  return { stateDir, hub, server, provider, request, close };
}

async function client(f: Awaited<ReturnType<typeof fixture>>, token = HUB_TEST_ADMIN_TOKEN) {
  const ws = new WebSocket(f.server.clientWsUrl, { headers: { Authorization: `Bearer ${token}` } });
  const received: HubToClientMessage[] = [];
  ws.on("message", (raw) => received.push(JSON.parse(raw.toString()) as HubToClientMessage));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  cleanup.push(() => new Promise<void>((resolve) => { if (ws.readyState === WebSocket.CLOSED) return resolve(); ws.once("close", resolve); ws.close(); }));
  const wait = async (type: HubToClientMessage["type"], requestId?: string) => {
    let message: HubToClientMessage | undefined;
    await vi.waitFor(() => { message = received.find((item) => item.type === type && (requestId === undefined || "requestId" in item && item.requestId === requestId)); expect(message).toBeDefined(); }, { timeout: 5000, interval: 15 });
    return message!;
  };
  await wait("hub.snapshot");
  return { received, wait, send: (message: ClientToHubMessage) => ws.send(JSON.stringify(message)) };
}

async function settled(f: Awaited<ReturnType<typeof fixture>>, topicId: string, predicate: (view: Awaited<ReturnType<MocoHub["getTopicView"]>>) => boolean) {
  let result!: Awaited<ReturnType<MocoHub["getTopicView"]>>;
  await vi.waitFor(async () => { result = await f.hub.getTopicView(topicId); expect(result.live.busy).toBe(false); expect(predicate(result)).toBe(true); }, { timeout: 7000, interval: 20 });
  return result;
}

function websocketStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("WS authentication timeout")); }, 4000);
    ws.once("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); resolve(response.statusCode ?? 0); });
    ws.once("open", () => { clearTimeout(timer); ws.close(); resolve(101); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function pair(f: Awaited<ReturnType<typeof fixture>>, name: string): Promise<DevicePeerConfig> {
  const enabled = await f.request("/api/devices", "PATCH", { enabled: true }); expect(enabled.status).toBe(200); await enabled.arrayBuffer();
  const address = Object.values(os.networkInterfaces()).flat().find((item) => item && !item.internal && item.family === "IPv4")?.address;
  if (!address) throw new Error("Device integration tests require a local non-loopback IPv4 interface");
  const invitationResponse = await f.request("/api/devices/invitations", "POST", { name, hubUrl: `http://${address}:${f.server.port}` });
  expect(invitationResponse.status).toBe(201);
  const invitation = await invitationResponse.json() as DeviceInvitation;
  const inviteToken = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)?.[1];
  expect(inviteToken).toBeDefined();
  const response = await f.request("/api/devices/pair", "POST", { inviteToken, info: { hostname: "test-device", platform: "linux", arch: "x64", release: "test", cpu: "test", memoryBytes: 1024, ips: ["10.23.0.8"] } }, "");
  expect(response.status).toBe(200);
  return response.json() as Promise<DevicePeerConfig>;
}

describe("rich chat through real Hub and HTTP/WS", () => {
  it("paginates long mixed history without overlap and refreshes old cards from their newest durable state", async () => {
    const f = await fixture();
    const other = await f.hub.createTopic("隔离的话题");
    const expectedIds: number[] = [];
    const asset = f.hub.uploads.saveUpload({ name: "history.txt", mimeType: "text/plain", bytes: Buffer.from("history attachment"), ownerId: "local" });
    f.hub.uploads.bindAttachments([asset], `conversation:${Number(f.hub.rootConversation.id)}`, "local");
    const append = async (from: number, to: number) => {
      const ids = await f.hub.harness.commit(async (tx) => {
        const ids: number[] = [];
        for (let index = from; index < to; index++) {
          const part: MessagePart = index === 91 ? { partId: `history-${index}`, type: "code", code: "const history = true;", language: "ts" }
            : index === 151 ? { partId: `history-${index}`, type: "file", assetId: asset.id }
            : { partId: `history-${index}`, type: "markdown", text: `history-${index}` };
          const entry = await tx.appendEntry(ContentPublicationEntry, f.hub.rootConversation.id, { data: { parts: [part], fallbackText: `history-${index}` } as ContentPublicationData & JsonObject });
          ids.push(Number(entry.id));
        }
        return ids;
      }, BACKGROUND_CONTEXT);
      expectedIds.push(...ids);
    };
    await append(0, 5);
    const card = await f.hub.uiCards.show(form("历史中的卡片"), { conversationId: Number(f.hub.rootConversation.id), callId: "history-card", topicId: "root" });
    expectedIds.push(card.sourceEntryId!);
    await append(5, 135);
    const otherConversation = await f.hub.harness.conversation(other.conversationId as typeof f.hub.rootConversation.id, BACKGROUND_CONTEXT);
    await f.hub.harness.commit(async (tx) => {
      await tx.appendEntry(ContentPublicationEntry, otherConversation!.id, { data: { parts: [{ partId: "private-other-topic", type: "markdown", text: "other-topic-only" }], fallbackText: "other-topic-only" } as ContentPublicationData & JsonObject });
    }, BACKGROUND_CONTEXT);
    await append(135, 270);

    const ws = await client(f);
    const snapshot = ws.received.find((message): message is Extract<HubToClientMessage, { type: "hub.snapshot" }> => message.type === "hub.snapshot")!;
    expect(snapshot.historyBefore).toBeGreaterThan(card.sourceEntryId!);
    expect(snapshot.messages.some((message) => message.id === card.sourceEntryId)).toBe(false);
    ws.send({ type: "topic.select", topicId: "root", requestId: "history-select" });
    const selected = await ws.wait("hub.messages") as Extract<HubToClientMessage, { type: "hub.messages" }>;
    expect(selected.historyBefore).toBe(snapshot.historyBefore);

    type HistoryPage = { messages: ChatDisplayItem[]; hasMore: boolean; beforeEntryId?: number };
    const combined = [...snapshot.messages];
    let before = snapshot.historyBefore!;
    let pages = 0;
    let oldCardUrl = "";
    for (; pages < 10; pages++) {
      const pathname = `/api/topics/root/messages?before=${before}`;
      const response = await f.request(pathname);
      expect(response.status).toBe(200);
      const page = await response.json() as HistoryPage;
      const ids = page.messages.map((message) => message.id);
      expect(ids).toEqual([...ids].sort((left, right) => left - right));
      expect(ids.every((id) => id < before)).toBe(true);
      expect(page.messages.length).toBeLessThanOrEqual(120);
      if (parts(page.messages).some((part) => part.type === "ui" && part.cardId === card.cardId)) {
        oldCardUrl = pathname;
        expect(parts(page.messages).find((part) => part.type === "ui")).toMatchObject({ card: { status: "ready", revision: 1 } });
      }
      combined.unshift(...page.messages);
      if (!page.hasMore) { expect(page.beforeEntryId).toBeUndefined(); break; }
      expect(page.beforeEntryId).toBeGreaterThan(0);
      expect(page.beforeEntryId).toBeLessThan(before);
      before = page.beforeEntryId!;
    }
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThan(10);
    const ids = combined.map((message) => message.id);
    expect(ids).toEqual(expectedIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(combined)).not.toContain("other-topic-only");
    expect(parts(combined).find((part) => part.type === "code")).toMatchObject({ code: "const history = true;" });
    expect(parts(combined).find((part) => part.type === "file")).toMatchObject({ asset });

    const input: UiActionInput = { cardId: card.cardId, revision: 1, actionId: card.actions[0]!.id, values: { name: "历史卡片的新提交" }, commandId: "submit-old-history-card" };
    const submitted = await f.request(`/api/ui/cards/${card.cardId}/actions`, "POST", input);
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json() as UiActionReceipt;
    const refreshed = await f.request(oldCardUrl);
    expect(refreshed.status).toBe(200);
    const oldPage = await refreshed.json() as HistoryPage;
    expect(parts(oldPage.messages).find((part) => part.type === "ui")).toMatchObject({ card: { ...receipt.card, status: "submitted", committedState: input.values } });

    for (const invalid of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1%3Bdrop"]) {
      expect((await f.request(`/api/topics/root/messages?before=${invalid}`)).status).toBe(400);
    }
    expect((await f.request("/api/topics/root/messages")).status).toBe(400);
    for (const token of ["", NODE_TOKEN]) expect((await f.request(`/api/topics/root/messages?before=${snapshot.historyBefore}`, "GET", undefined, token)).status).toBe(401);
    const beginning = await f.request("/api/topics/root/messages?before=1");
    expect(beginning.status).toBe(200); expect(await beginning.json()).toEqual({ messages: [], hasMore: false });
  });

  it.each(["root", "topic"])("offers a durable copy action in the %s chat without issuing a credential", async (target) => {
    const f = await fixture();
    const topic = target === "root" ? { id: "root", conversationId: Number(f.hub.rootConversation.id) } : await f.hub.createTopic("接入笔记本");
    const privateLabel = "private-test-device-label";
    if (target === "topic") {
      f.hub.connectionManager.rememberSecrets([privateLabel]);
      expect((await f.request("/api/devices/local", "PATCH", { name: `书房 ${privateLabel}` })).status).toBe(200);
      const model = f.hub.getSettingsView().blocks.model;
      await f.hub.updateSettingsBlock("model", model.revision, { ...model.value, thinkingLevel: "off" });
    }
    const before = await (await f.request("/api/devices")).json();
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "moco_device_invite", limit: 3 })], { stopReason: "toolUse" }),
      (context) => {
        expect(toolNames(context)).toContain("moco_device_invite");
        return fauxAssistantMessage([fauxToolCall("moco_device_invite", {})], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moco_device_invite");
        expect(result).toMatchObject({ content: [{ type: "text", text: '{"status":"shown"}' }] });
        return fauxAssistantMessage([fauxText("复制后粘贴到笔记本的 Moco。")]);
      },
    ]);
    await f.hub.sendUserMessage("让我的笔记本接进来", { topicId: topic.id });
    const completed = await settled(f, topic.id, (view) => view.messages.some((message) => message.text === "复制后粘贴到笔记本的 Moco。"));
    const card = parts(completed.messages).find((part) => part.type === "device-invitation");
    expect(card).toEqual({ type: "device-invitation", partId: expect.any(String), hubId: before.hubId, hubName: f.hub.connectionManager.redact(before.hubName) });
    expect(JSON.stringify(completed.messages)).not.toContain(privateLabel);
    const after = await (await f.request("/api/devices")).json();
    expect(after.enabled).toBe(before.enabled);
    expect(after.devices.map((device: { id: string }) => device.id)).toEqual(before.devices.map((device: { id: string }) => device.id));
    await f.close();
    const restarted = await fixture(f.stateDir);
    const restored = await restarted.hub.getTopicView(topic.id);
    expect(parts(restored.messages).filter((part) => part.type === "device-invitation")).toEqual([card]);
  });

  it.each(["root", "topic"])("publishes, updates and submits a %s card with a recoverable durable receipt", async (target) => {
    const f = await fixture();
    const topic = target === "root" ? { id: "root", conversationId: Number(f.hub.rootConversation.id) } : await f.hub.createTopic("交互卡片");
    const visibleTools: string[][] = [];
    let shown!: UiCardSnapshot;
    f.provider.setResponses([
      (context) => { visibleTools.push(toolNames(context)); return fauxAssistantMessage([fauxToolCall("moco_ui_show", form())], { stopReason: "toolUse" }); },
      async (context) => {
        visibleTools.push(toolNames(context));
        shown = (await f.hub.uiCards.snapshot(topic.conversationId))[0]!;
        return fauxAssistantMessage([fauxToolCall("moco_ui_update", { card_id: shown.cardId, revision: shown.revision, ...form("已更新方案") })], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([fauxText("请选择处理方式。")]),
    ]);
    const ws = await client(f);
    ws.send({ type: "chat.send", topicId: topic.id, content: "生成卡片", requestId: "create-card" });
    await ws.wait("hub.ack", "create-card");
    const initial = await settled(f, topic.id, (view) => parts(view.messages).some((part) => part.type === "ui" && part.card?.revision === 2));
    expect(visibleTools[0]).toEqual(expect.arrayContaining(["moco_ui_show", "tool_search"]));
    expect(visibleTools[1]).toEqual(expect.arrayContaining(["moco_ui_show", "moco_ui_update"]));
    const uiParts = parts(initial.messages).filter((part): part is Extract<MessagePart, { type: "ui" }> => part.type === "ui");
    expect(uiParts).toHaveLength(1);
    const card = uiParts[0]!.card!;
    expect(card).toMatchObject({ cardId: shown.cardId, title: "已更新方案", revision: 2, status: "ready", originConversationId: topic.conversationId });
    expect(card.actions[0]!.fields).toMatchObject([{ name: "name", type: "string", required: true, maxLength: 30 }]);
    let actionRequests = 0;
    f.provider.setResponses([(context) => { actionRequests++; expect(JSON.stringify(context.messages)).toContain("来自卡片的选择"); return fauxAssistantMessage([fauxText("已按你的选择继续。")]); }]);
    const input: UiActionInput = { cardId: card.cardId, revision: card.revision, actionId: card.actions[0]!.id, values: { name: "来自卡片的选择" }, commandId: "ui-command" };
    const invalidRoute = await f.request(`/api/ui/cards/${card.cardId}/actions`, "POST", { ...input, originConversationId: topic.conversationId + 1000 });
    expect(invalidRoute.status).toBe(400);
    const response = await f.request(`/api/ui/cards/${card.cardId}/actions`, "POST", input);
    expect(response.status).toBe(200);
    const receipt = await response.json() as UiActionReceipt;
    expect(receipt).toMatchObject({ status: "submitted", revision: 3, card: { committedState: input.values } });
    const after = await settled(f, topic.id, (view) => view.messages.some((message) => message.text.includes("已按你的选择继续")) && parts(view.messages).some((part) => part.type === "ui" && part.card?.status === "submitted"));
    expect(parts(after.messages).filter((part) => part.type === "ui")).toHaveLength(1);
    expect(after.messages.some((message) => message.text.startsWith('{"type":"moco.ui.action"'))).toBe(false);
    const repeated = await f.request(`/api/ui/cards/${card.cardId}/actions`, "POST", input);
    expect(repeated.status).toBe(200); expect(await repeated.json()).toMatchObject({ ...receipt, deduplicated: true });
    expect(actionRequests).toBe(1);
    const origin = await f.hub.harness.conversation(card.originConversationId as typeof f.hub.rootConversation.id, BACKGROUND_CONTEXT);
    expect((await origin!.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("moco.ui.action"))).toHaveLength(1);
    const conflict = await f.request(`/api/ui/cards/${card.cardId}/actions`, "POST", { ...input, commandId: "stale-new-command" });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "ui_revision_conflict", card: receipt.card });
    const current = await f.request(`/api/ui/cards/${card.cardId}`);
    expect(current.status).toBe(200); expect(await current.json()).toEqual({ card: receipt.card });
    await f.close();
    const restored = await fixture(f.stateDir);
    const refreshed = await restored.hub.getTopicView(topic.id);
    expect(parts(refreshed.messages).find((part) => part.type === "ui")).toMatchObject({ card: receipt.card });
    const restoredRetry = await restored.request(`/api/ui/cards/${card.cardId}/actions`, "POST", input);
    expect(restoredRetry.status).toBe(200); expect(await restoredRetry.json()).toMatchObject({ ...receipt, deduplicated: true });
  });

  it.each(["root", "topic"])("keeps published attachments and final text in the same %s response across streaming and reload", async (target) => {
    const f = await fixture();
    const topic = target === "root" ? { id: "root", conversationId: Number(f.hub.rootConversation.id) } : await f.hub.createTopic("附件与正文");
    const workspace = path.join(f.stateDir, "workspace");
    fs.writeFileSync(path.join(workspace, "first.txt"), "first attachment");
    fs.writeFileSync(path.join(workspace, "second.txt"), "second attachment");
    let finish!: () => void;
    const pendingAnswer = new Promise<void>((resolve) => { finish = resolve; });
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "moco_publish_asset", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([
        fauxToolCall("moco_publish_asset", { path: "first.txt", caption: "第一份附件" }),
        fauxToolCall("moco_publish_asset", { path: "second.txt", caption: "第二份附件" }),
      ], { stopReason: "toolUse" }),
      async () => { await pendingAnswer; return fauxAssistantMessage([fauxText("文件已发送，可以打开或保存。")]); },
    ]);
    await f.hub.sendUserMessage("把文件发给我", { topicId: topic.id });
    let responseId!: number;
    let publicationIds!: number[];
    try {
      await vi.waitFor(async () => {
        const view = await f.hub.getTopicView(topic.id);
        const publications = view.messages.filter((message) => message.parts?.some((part) => part.type === "file"));
        expect(publications).toHaveLength(2);
        responseId = view.messages.find((message) => message.role === "user")!.id;
        publicationIds = publications.map((message) => message.id);
        expect(publications.map((message) => message.responseId)).toEqual([responseId, responseId]);
        expect(view.live).toMatchObject({ busy: true, responseId });
      }, { timeout: 7000, interval: 20 });
    } finally { finish(); }
    const completed = await settled(f, topic.id, (view) => view.messages.some((message) => message.text === "文件已发送，可以打开或保存。"));
    expect(completed.messages.filter((message) => message.role === "assistant").every((message) => message.responseId === responseId)).toBe(true);
    expect(parts(completed.messages).filter((part) => part.type === "file").map((part) => part.caption)).toEqual(["第一份附件", "第二份附件"]);
    expect(completed.live.responseId).toBeUndefined();
    const history = await f.hub.getTopicHistory(topic.id, completed.messages.at(-1)!.id + 1);
    expect(history.messages.filter((message) => publicationIds.includes(message.id)).map((message) => message.responseId)).toEqual([responseId, responseId]);
    await f.close();
    const restored = await fixture(f.stateDir);
    const refreshed = await restored.hub.getTopicView(topic.id);
    expect(refreshed.messages.filter((message) => publicationIds.includes(message.id)).map((message) => message.responseId)).toEqual([responseId, responseId]);
    expect(refreshed.messages.find((message) => message.text === "文件已发送，可以打开或保存。")?.responseId).toBe(responseId);
  });

  it("orders a slow asset publication before a later card, and refuses state-directory siblings", async () => {
    const f = await fixture();
    const workspace = path.join(f.stateDir, "workspace");
    fs.writeFileSync(path.join(workspace, "result.txt"), "ready artifact");
    fs.writeFileSync(path.join(f.stateDir, "private-state.txt"), "state sibling");
    const original = f.hub.uploads.saveUploadStream.bind(f.hub.uploads);
    vi.spyOn(f.hub.uploads, "saveUploadStream").mockImplementationOnce(async (input) => { await new Promise((resolve) => setTimeout(resolve, 35)); return original(input); });
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "moco_publish_asset", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("moco_publish_asset", { path: "result.txt" }), fauxToolCall("moco_ui_show", form())], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("结果已就绪。")]),
    ]);
    await f.hub.sendUserMessage("发布产物并生成选择卡");
    const view = await settled(f, "root", (value) => parts(value.messages).some((part) => part.type === "file") && parts(value.messages).some((part) => part.type === "ui"));
    expect(parts(view.messages).filter((part) => part.type === "file" || part.type === "ui").map((part) => part.type)).toEqual(["file", "ui"]);
    const asset = parts(view.messages).find((part) => part.type === "file") as Extract<MessagePart, { assetId: string }>;
    expect(await (await f.request(asset.asset!.url)).text()).toBe("ready artifact");
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("moco_publish_asset", { path: path.join(f.stateDir, "private-state.txt") }), fauxToolCall("moco_ui_show", form("失败后仍可继续"))], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("该资源无法发布。")]),
    ]);
    await f.hub.sendUserMessage("尝试受保护目录");
    const rejected = await settled(f, "root", (value) => value.messages.some((message) => message.text.includes("该资源无法发布")));
    expect(parts(rejected.messages).filter((part) => part.type === "file")).toHaveLength(1);
    expect(parts(rejected.messages).filter((part) => part.type === "ui")).toHaveLength(2);
    const publicationResults = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult" && message.toolName === "moco_publish_asset");
    expect(publicationResults.at(-1)).toMatchObject({ isError: true });
    expect(JSON.stringify(publicationResults.at(-1)!.content)).toContain("资源必须位于当前工作区内");
  });

  it("limits a media cookie to authenticated GET/HEAD/Range and rejects anonymous and node credentials", async () => {
    const f = await fixture();
    const upload = await f.request("/api/uploads", "POST", { name: "sample.txt", mimeType: "text/plain", dataBase64: Buffer.from("abcdefghij").toString("base64") });
    expect(upload.status).toBe(201);
    const { attachment } = await upload.json() as { attachment: ChatAttachment };
    const session = await f.request("/api/media/session", "POST");
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect(session.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const read = await f.request(attachment.url, "GET", undefined, "", { cookie });
    expect(read.status).toBe(200); expect(await read.text()).toBe("abcdefghij");
    const head = await f.request(attachment.url, "HEAD", undefined, "", { cookie });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe("");
    const range = await f.request(attachment.url, "GET", undefined, "", { cookie, range: "bytes=2-5" });
    expect(range.status).toBe(206); expect(range.headers.get("content-range")).toBe("bytes 2-5/10"); expect(await range.text()).toBe("cdef");
    for (const [pathname, method] of [["/api/uploads", "POST"], ["/api/settings", "GET"], ["/api/media/session", "POST"]]) expect((await f.request(pathname!, method!, undefined, "", { cookie })).status).toBe(401);
    expect(await websocketStatus(f.server.clientWsUrl, { cookie })).toBe(401);
    for (const token of ["", NODE_TOKEN]) {
      expect((await f.request(attachment.url, "GET", undefined, token)).status).toBe(401);
      expect((await f.request("/api/media/session", "POST", undefined, token)).status).toBe(401);
      expect((await f.request(`/api/uploads/${attachment.id}/meta`, "GET", undefined, token)).status).toBe(401);
    }
    expect((await f.request(`/api/media/session?token=${HUB_TEST_ADMIN_TOKEN}`, "POST", undefined, "")).status).toBe(401);
    expect((await f.request("/api/media/session", "POST", undefined, HUB_TEST_ADMIN_TOKEN, { origin: "https://invalid.example" })).status).toBe(403);
  });

  it("shares published attachments across paired devices, isolates drafts and replaces forged client metadata", async () => {
    const f = await fixture();
    const deviceA = await pair(f, "设备 A");
    const deviceB = await pair(f, "设备 B");
    const upload = await f.request("/api/uploads", "POST", { name: "real.txt", mimeType: "text/plain", dataBase64: Buffer.from("real metadata").toString("base64") }, deviceA.clientToken);
    expect(upload.status).toBe(201);
    const { attachment } = await upload.json() as { attachment: ChatAttachment };
    expect((await f.request(attachment.url, "GET", undefined, deviceA.clientToken)).status).toBe(200);
    expect((await f.request(attachment.url, "GET", undefined, deviceB.clientToken)).status).toBe(403);
    const second = await client(f, deviceB.clientToken);
    second.send({ type: "chat.send", content: "偷读草稿", attachments: [attachment], requestId: "unpublished-ref" });
    await second.wait("hub.error", "unpublished-ref");
    const first = await client(f, deviceA.clientToken);
    const forged: ChatAttachment = { ...attachment, name: "fake-video.mp4", mimeType: "video/mp4", kind: "video", size: 999, url: "https://invalid.example/fake.mp4" };
    first.send({ type: "chat.send", content: "发送实际附件", attachments: [forged], requestId: "publish-real" });
    await first.wait("hub.ack", "publish-real");
    const view = await settled(f, "root", (value) => value.messages.some((message) => message.role === "user" && message.attachments?.some((item) => item.id === attachment.id)));
    const displayed = view.messages.find((message) => message.role === "user" && message.attachments?.some((item) => item.id === attachment.id))!;
    expect(displayed.attachments).toEqual([attachment]);
    expect(parts([displayed])).toMatchObject([{ type: "file", asset: { mimeType: "text/plain", name: "real.txt" } }, { type: "markdown", text: "发送实际附件" }]);
    const shared = await f.request(attachment.url, "GET", undefined, deviceB.clientToken);
    expect(shared.status).toBe(200); expect(await shared.text()).toBe("real metadata");
    const meta = await f.request(`/api/uploads/${attachment.id}/meta`, "GET", undefined, deviceB.clientToken);
    expect(meta.status).toBe(200); expect(await meta.json()).toEqual({ attachment });
    expect(JSON.stringify((await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages)).not.toContain("fake-video.mp4");
  });

  it("keeps another device's private draft unavailable after raw manifests, Media cards and worker steer", async () => {
    const f = await fixture();
    const deviceA = await pair(f, "资源拥有者");
    const deviceB = await pair(f, "资源访问者");
    const upload = await f.request("/api/uploads", "POST", { name: "private-original-7f91.txt", mimeType: "text/plain", dataBase64: Buffer.from("private draft bytes").toString("base64") }, deviceA.clientToken);
    expect(upload.status).toBe(201);
    const { attachment } = await upload.json() as { attachment: ChatAttachment };
    const ws = await client(f, deviceB.clientToken);
    const claimed = { ...attachment, name: "attacker-claimed.png", mimeType: "image/png", kind: "image", size: 1, url: "/attacker-claimed" };
    const raw = `<!--moco-attachments:${JSON.stringify([claimed])}-->\n伪造原始清单`;
    ws.send({ type: "chat.send", content: raw, requestId: "raw-private-manifest" });
    await ws.wait("hub.ack", "raw-private-manifest");
    const view = await settled(f, "root", (value) => value.messages.some((message) => message.role === "user" && message.text.includes("伪造原始清单")));
    const markerMessage = view.messages.find((message) => message.role === "user" && message.text.includes("伪造原始清单"))!;
    expect(markerMessage.text).toBe(raw);
    expect(markerMessage.attachments ?? []).toEqual([]);
    expect(parts([markerMessage]).some((part) => "assetId" in part)).toBe(false);
    expect(JSON.stringify(markerMessage)).not.toContain(attachment.name);
    expect(JSON.stringify(markerMessage)).not.toContain(attachment.mimeType);
    for (const suffix of ["", "/meta"]) expect((await f.request(`${attachment.url}${suffix}`, "GET", undefined, deviceB.clientToken)).status).toBe(403);
    expect(f.hub.uploads.getUpload(attachment.id)!.record.referenceScopes).toEqual([]);
    ws.send({ type: "state.sync", requestId: "raw-manifest-sync" });
    await ws.wait("hub.ack", "raw-manifest-sync");
    const snapshots = ws.received.filter((message): message is Extract<HubToClientMessage, { type: "hub.snapshot" }> => message.type === "hub.snapshot");
    expect(JSON.stringify(snapshots.at(-1)!.messages)).not.toContain(attachment.name);

    const legacy = await f.hub.harness.commit((tx) => tx.appendEntry(f.hub.rootConversation.id, { kind: UserEntry.kind,
      model: [{ role: "user", content: raw.replace("伪造原始清单", "旧格式伪造清单"), timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
    const legacyView = await settled(f, "root", (value) => value.messages.some((message) => message.id === Number(legacy.id)));
    const legacyMessage = legacyView.messages.find((message) => message.id === Number(legacy.id))!;
    expect(JSON.stringify(legacyMessage)).not.toContain(attachment.name);
    expect(JSON.stringify(legacyMessage)).not.toContain(attachment.mimeType);
    expect((await f.request(attachment.url, "GET", undefined, deviceB.clientToken)).status).toBe(403);
    expect(f.hub.uploads.getUpload(attachment.id)!.record.referenceScopes).toEqual([]);

    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("moco_ui_show", { title: "不能引用的私有资源", actions: [], spec: { root: "private-media", elements: { "private-media": { type: "Media", props: { assetId: attachment.id } } } } })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("私有资源不可用。")]),
    ]);
    ws.send({ type: "chat.send", content: "尝试在生成卡片引用资源", requestId: "private-media-card" });
    await ws.wait("hub.ack", "private-media-card");
    await settled(f, "root", (value) => value.messages.some((message) => message.text.includes("私有资源不可用")));
    expect(await f.hub.uiCards.snapshot(Number(f.hub.rootConversation.id))).toEqual([]);
    const cardResults = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult" && message.toolName === "moco_ui_show");
    expect(cardResults.at(-1)).toMatchObject({ isError: true });
    expect((await f.request(attachment.url, "GET", undefined, deviceB.clientToken)).status).toBe(403);
    expect(f.hub.uploads.getUpload(attachment.id)!.record.referenceScopes).toEqual([]);

    const worker = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const ticketId = "T-private-draft-steer";
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.tickets[ticketId] = { id: ticketId, commandId: "seed-private-draft-steer", title: "待恢复任务", goal: "等待执行设备", scope: "测试工作区", role: "coder", status: "waiting", envId: "rich-chat-node", workspaceDir: path.join(f.stateDir, "workspace", "private-draft-steer"), workerConversationId: Number(worker.id), runEpoch: 1, createdAt: Date.now(), updatedAt: Date.now(), waiting: { reason: "env", since: Date.now() }, originTopicId: "root", originConversationId: Number(f.hub.rootConversation.id) };
      state.conversationToTicket[String(worker.id)] = ticketId;
    }, BACKGROUND_CONTEXT);
    ws.send({ type: "ticket.steer", ticketId, text: "请读取这个未发布附件", attachments: [attachment], commandId: "steal-private-draft" });
    let outcome: HubToClientMessage | undefined;
    await vi.waitFor(() => { outcome = ws.received.find((message) => (message.type === "hub.ack" || message.type === "hub.error") && message.commandId === "steal-private-draft"); expect(outcome).toBeDefined(); }, { timeout: 5000, interval: 15 });
    expect(outcome!.type).toBe("hub.error");
    const state = await f.hub.harness.snapshot(MocoStateDoc, BACKGROUND_CONTEXT);
    expect(state!.tickets[ticketId]!.resumeAttachmentIds).toBeUndefined();
    expect(state!.processedCommands?.["steal-private-draft"]).toBeUndefined();
    expect((await f.request(attachment.url, "GET", undefined, deviceB.clientToken)).status).toBe(403);
    expect(f.hub.uploads.getUpload(attachment.id)!.record.referenceScopes).toEqual([]);
  });
});
