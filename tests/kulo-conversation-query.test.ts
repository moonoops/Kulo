import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, ToolResultEntry, UserEntry, type Conversation, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { KuloStateDoc, startKuloHubServer } from "@kulo/hub";
import type { ChatAttachment, ConversationFilesPage, ConversationMessageWindow, ConversationSearchPage, ProjectRecord } from "@kulo/protocol";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { ContentPublicationEntry, KuloUserEntry } from "../packages/hub/src/ui-cards.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { WorkerRecoveryEntry } from "../packages/hub/src/state.js";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_AUTH_TOKEN", "KULO_ENV_TOKENS", "KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(existingDir?: string) {
  const stateDir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "kulo-user-query-"));
  if (!existingDir) cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "query-test" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { authToken: HUB_TEST_ADMIN_TOKEN, stateDir, identityDir: path.join(stateDir, "identity"),
    workerEnvIds: [], enableLocalEnv: true, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "query-test", thinkingLevel: "off", apiKey: "" },
  } });
  cleanup.push(() => hub.close());
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  let closingServer: Promise<void> | undefined;
  const closeServer = () => closingServer ??= server.close();
  cleanup.push(closeServer);
  const request = (pathname: string, token = HUB_TEST_ADMIN_TOKEN) => fetch(`${server.url}${pathname}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const root = hub.rootConversation.id;
  async function user(text: string, conversationId: ConversationId = root) {
    return Number((await hub.harness.commit((tx) => tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: text, timestamp: Date.now() }] }), BACKGROUND_CONTEXT)).id);
  }
  async function publication(text: string, conversationId: ConversationId = root, assets: ChatAttachment[] = []) {
    return Number((await hub.harness.commit((tx) => tx.appendEntry(ContentPublicationEntry, conversationId, { data: {
      parts: [{ partId: "text", type: "markdown", text }, ...assets.map((asset) => ({ partId: asset.id, type: asset.kind, assetId: asset.id }))], fallbackText: text,
    } as JsonObject }), BACKGROUND_CONTEXT)).id);
  }
  async function fill(count: number, conversationId: ConversationId = root) {
    await hub.harness.commit(async (tx) => { for (let index = 0; index < count; index++) await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: `后续日常消息 ${index}`, timestamp: Date.now() }] }); }, BACKGROUND_CONTEXT);
  }
  function upload(name: string, conversationId: ConversationId = root) {
    const asset = hub.uploads.saveUpload({ name, mimeType: "text/plain", bytes: Buffer.from("example contents"), ownerId: "local" });
    hub.uploads.bindAttachments([asset], `conversation:${Number(conversationId)}`, "local");
    return asset;
  }
  return { hub, server, root, request, user, publication, fill, upload, stateDir,
    close: async () => { await closeServer(); await hub.close(); } };
}

describe("user conversation queries", () => {
  it("searches persisted text beyond the live window and locates its exact message after compaction", async () => {
    const f = await fixture();
    const first = await f.user("最早要求：灯光色温保持 2700K，预算优先。 ");
    await f.fill(270);
    await f.hub.harness.commit((tx) => tx.appendEntry(CompactionEntry, f.root, { data: { reason: "manual" }, head: first as never, model: [{ role: "user", content: "旧对话已经压缩。", timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
    expect((await f.hub.getTopicView("root")).messages.some((item) => item.id === first)).toBe(false);
    const response = await f.request("/api/conversations/search?q=2700k");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.json() as ConversationSearchPage;
    expect(page.items).toEqual([expect.objectContaining({ kind: "message", topicId: "root", messageId: first, role: "user", excerpt: expect.stringContaining("2700K") })]);
    const target = await f.request(`/api/topics/root/messages/${first}`);
    expect(target.status).toBe(200);
    const window = await target.json() as ConversationMessageWindow;
    expect(window).toMatchObject({ topicId: "root", messageId: first });
    expect(window.messages.some((item) => item.id === first)).toBe(true);
    expect(window.messages.length).toBeLessThanOrEqual(91);
  });

  it("searches titles, archived topics and body text with stable bounded pagination and optional topic scope", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("灯光方案检索");
    await f.hub.patchTopic(topic.id, { archived: true });
    const ids: number[] = [];
    for (let index = 0; index < 5; index++) ids.push(await f.user(`灯光 检索样本 ${index}`));
    const other = await f.publication("灯光 对比结果", topic.conversationId as ConversationId);
    const found: ConversationSearchPage["items"] = [];
    let cursor: string | undefined;
    do {
      const response = await f.request(`/api/conversations/search?q=灯光&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const page = await response.json() as ConversationSearchPage;
      expect(page.items.length).toBeLessThanOrEqual(2);
      found.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    expect(found.filter((item) => item.kind === "message").map((item) => item.messageId)).toEqual([other, ...ids.reverse()]);
    expect(found.find((item) => item.kind === "topic")).toMatchObject({ topicId: topic.id, archived: true });
    expect(new Set(found.map((item) => `${item.topicId}:${item.kind}:${item.messageId}`)).size).toBe(found.length);
    const scoped = await (await f.request(`/api/conversations/search?q=灯光&topicId=${topic.id}`)).json() as ConversationSearchPage;
    expect(scoped.items.every((item) => item.topicId === topic.id)).toBe(true);
    const first = await (await f.request("/api/conversations/search?q=灯光&limit=1")).json() as ConversationSearchPage;
    expect((await f.request(`/api/conversations/search?q=其他&cursor=${first.nextCursor}`)).status).toBe(409);
    await f.hub.deleteTopic(topic.id);
    expect((await f.request(`/api/conversations/search?q=灯光&cursor=${first.nextCursor}`)).status).toBe(409);
    expect((await (await f.request("/api/conversations/search?q=灯光")).json() as ConversationSearchPage).items.every((item) => item.topicId !== topic.id)).toBe(true);
  });

  it("indexes every conversation file with exact deduplication, hydrated metadata and source messages", async () => {
    const f = await fixture();
    const first = f.upload("最早的文档.txt");
    const second = f.upload("上传的附件.txt");
    const inaccessible = f.hub.uploads.saveUpload({ name: "其他会话私有附件.txt", mimeType: "text/plain", bytes: Buffer.from("other"), ownerId: "other-owner" });
    f.hub.uploads.bindAttachments([inaccessible], "conversation:987654");
    await f.publication("早期成果", f.root, [first]);
    await f.fill(240);
    const userId = Number((await f.hub.harness.commit((tx) => tx.appendEntry(KuloUserEntry, f.root, { data: { kuloContentVersion: 1, text: "查看这些附件", attachments: [second] } }), BACKGROUND_CONTEXT)).id);
    const latest = await f.publication("再次引用早期成果", f.root, [first, inaccessible]);
    const result = await (await f.request("/api/topics/root/files?limit=1")).json() as ConversationFilesPage;
    expect(result).toMatchObject({ total: 2, items: [{ asset: { id: first.id, name: first.name }, messageId: latest, role: "assistant" }] });
    expect(result.nextCursor).toBeDefined();
    const next = await (await f.request(`/api/topics/root/files?limit=1&cursor=${result.nextCursor}`)).json() as ConversationFilesPage;
    expect(next).toMatchObject({ total: 2, items: [{ asset: { id: second.id }, messageId: userId, role: "user" }] });
    expect(next.nextCursor).toBeUndefined();
    expect(JSON.stringify([result, next])).not.toContain(inaccessible.name);
    const match = await f.hub.searchConversations({ query: first.name });
    expect(match.items.some((item) => item.messageId === latest)).toBe(true);
  });

  it("excludes system, tools, worker/settings conversations and deleted project topics", async () => {
    const f = await fixture();
    const hidden = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "openai", modelId: "query-test" } } }, BACKGROUND_CONTEXT);
    await f.user("不应出现的私有线索", hidden.id);
    const toolId = Number((await f.hub.harness.commit((tx) => tx.appendEntry(ToolResultEntry, f.root, { model: [{ role: "toolResult", toolName: "read", toolCallId: "private-read", isError: false, content: [{ type: "text", text: "不应出现的私有线索" }], timestamp: Date.now() }] }), BACKGROUND_CONTEXT)).id);
    await f.hub.harness.commit((tx) => tx.appendEntry(AssistantEntry, f.root, { model: [{ ...fauxAssistantMessage([fauxText("普通回复")]), content: [{ type: "thinking", thinking: "不应出现的私有线索" }, fauxText("普通回复")] }] }), BACKGROUND_CONTEXT);
    const topic = await f.hub.createTopic("失效项目");
    await f.user("不应出现的私有线索", topic.conversationId as ConversationId);
    await f.hub.harness.commit(async (tx) => {
      (await tx.doc(KuloStateDoc)).topics![topic.id]!.projectId = "deleted-project";
      (await tx.doc(KuloProjectsDoc)).projects["deleted-project"] = { id: "deleted-project", name: "已删除项目", deletedAt: Date.now() } as ProjectRecord;
    }, BACKGROUND_CONTEXT);
    expect((await f.hub.searchConversations({ query: "不应出现" })).items).toEqual([]);
    expect((await f.request(`/api/topics/root/messages/${toolId}`)).status).toBe(404);
    expect((await f.request(`/api/topics/${topic.id}/files`)).status).toBe(404);
    expect((await f.request(`/api/conversations/search?q=私有&topicId=topic-${hidden.id}`)).status).toBe(404);
  });

  it("keeps recovery-only messages hidden across scan-page boundaries and rereads redaction", async () => {
    const f = await fixture();
    let hiddenId = 0;
    await f.hub.harness.commit(async (tx) => {
      await tx.appendEntry(WorkerRecoveryEntry, f.root, { data: { ticketId: "recover", rootTicketId: "recover", startedAt: Date.now(), attempt: 1, runEpoch: 1 } });
      for (let index = 0; index < 220; index++) hiddenId = Number((await tx.appendEntry(AssistantEntry, f.root, { model: [fauxAssistantMessage([fauxText(`恢复过程的隐藏文本 ${index}`)])] })).id);
    }, BACKGROUND_CONTEXT);
    expect((await f.hub.searchConversations({ query: "隐藏文本" })).items).toEqual([]);
    expect((await f.request(`/api/topics/root/messages/${hiddenId}`)).status).toBe(404);
    const id = await f.user("后续约定 protected-original-phrase");
    expect((await f.hub.searchConversations({ query: "protected-original-phrase" })).items).toHaveLength(1);
    const redact = f.hub.connectionManager.redact.bind(f.hub.connectionManager);
    vi.spyOn(f.hub.connectionManager, "redact").mockImplementation((text) => redact(text).replaceAll("protected-original-phrase", "[已隐藏]"));
    expect((await f.hub.searchConversations({ query: "protected-original-phrase" })).items).toEqual([]);
    expect(JSON.stringify(await f.hub.getTopicMessageWindow("root", id))).not.toContain("protected-original-phrase");
  });

  it("rejects legacy worker receipts and process-only assistants while preserving file and UI messages", async () => {
    const f = await fixture();
    const hidden: number[] = [];
    for (const prefix of ["[KULO_WORKER_RELAY]", "[KULO_WORKER_WATCHDOG]"]) {
      const asset = f.upload(`${prefix.includes("RELAY") ? "relay" : "watchdog"}-receipt.txt`);
      hidden.push(Number((await f.hub.harness.commit((tx) => tx.appendEntry(KuloUserEntry, f.root, { data: {
        kuloContentVersion: 1, text: `${prefix} 后台自动回执`, attachments: [asset],
      } }), BACKGROUND_CONTEXT)).id));
    }
    await f.hub.harness.commit(async (tx) => {
      hidden.push(Number((await tx.appendEntry(AssistantEntry, f.root, { model: [{ ...fauxAssistantMessage([]), content: [{ type: "thinking", thinking: "后台自动回执的内部处理" }] }] })).id));
      hidden.push(Number((await tx.appendEntry(AssistantEntry, f.root, { model: [{ ...fauxAssistantMessage([]), content: [{ type: "toolCall", id: "process-only-tool", name: "read", arguments: { path: "process-only.txt" } }] }] })).id));
    }, BACKGROUND_CONTEXT);
    expect((await f.hub.searchConversations({ query: "后台自动回执" })).items).toEqual([]);
    expect((await f.hub.searchConversations({ query: "receipt.txt" })).items).toEqual([]);
    expect(await f.hub.listTopicFiles("root")).toMatchObject({ total: 0, items: [] });
    for (const id of hidden) expect((await f.request(`/api/topics/root/messages/${id}`)).status).toBe(404);

    const asset = f.upload("visible-file-only.txt");
    const fileId = await f.publication("", f.root, [asset]);
    const card = await f.hub.uiCards.show({ title: "可见交互", actions: [], spec: { root: "text", elements: { text: { type: "Text", props: { text: "可见交互内容" } } } } }, {
      conversationId: Number(f.root), callId: "visible-ui", topicId: "root",
    });
    const uiId = Number((await f.hub.harness.commit((tx) => tx.appendEntry(ContentPublicationEntry, f.root, { data: {
      parts: [{ partId: "ui-only", type: "ui", cardId: card.cardId, fallbackText: "" }], fallbackText: "",
    } as JsonObject }), BACKGROUND_CONTEXT)).id);
    expect((await f.hub.getTopicMessageWindow("root", fileId)).messages).toContainEqual(expect.objectContaining({ id: fileId, role: "assistant", text: "", parts: expect.arrayContaining([expect.objectContaining({ type: "file", assetId: asset.id })]) }));
    expect((await f.hub.getTopicMessageWindow("root", uiId)).messages).toContainEqual(expect.objectContaining({ id: uiId, role: "assistant", text: "", parts: expect.arrayContaining([expect.objectContaining({ type: "ui", cardId: card.cardId })]) }));
    expect(await f.hub.listTopicFiles("root")).toMatchObject({ total: 1, items: [{ messageId: fileId, asset: { id: asset.id } }] });
  });

  it("reads only candidate pages after indexing, includes new entries immediately and honors changed redaction", async () => {
    const f = await fixture();
    const old = await f.user("原始记录中提到薄荷绿，配色代号 meadow-vellum-73。");
    await f.fill(1200);
    const prototype: Conversation = Object.getPrototypeOf(f.hub.rootConversation);
    const entries = prototype.entries;
    let entriesRead = 0;
    vi.spyOn(prototype, "entries").mockImplementation(async function (this: Conversation, ...args) {
      const page = await entries.apply(this, args);
      entriesRead += page.items.length;
      return page;
    });
    expect((await f.hub.searchConversations({ query: "薄荷绿" })).items[0]?.messageId).toBe(old);
    expect(entriesRead).toBeGreaterThanOrEqual(1201);
    entriesRead = 0;
    expect((await f.hub.searchConversations({ query: "没有此条搜索内容" })).items).toEqual([]);
    expect(entriesRead).toBeLessThan(20);
    for (const query of ["薄", "薄荷", "薄荷绿"]) {
      expect((await f.hub.searchConversations({ query })).items[0]?.messageId).toBe(old);
    }
    const first = await f.hub.searchConversations({ query: "后续", limit: 30 });
    entriesRead = 0;
    const second = await f.hub.searchConversations({ query: "后续", limit: 30, cursor: first.nextCursor });
    expect(second.items).toHaveLength(30);
    expect(second.items.every((item) => item.messageId! < first.items.at(-1)!.messageId!)).toBe(true);
    expect(entriesRead).toBeLessThan(450);
    const newId = await f.user("刚刚写入的测量结果🌿");
    expect((await f.hub.searchConversations({ query: "🌿" })).items[0]?.messageId).toBe(newId);
    f.hub.connectionManager.rememberSecrets(["meadow-vellum-73"]);
    expect((await f.hub.searchConversations({ query: "meadow-vellum-73" })).items).toEqual([]);
    expect((await f.hub.searchConversations({ query: "[已隐藏]" })).items[0]?.messageId).toBe(old);
  });

  it("uses current attachment scopes and topic titles even when a page's entries have not changed", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("暖色设计旧稿");
    const asset = f.hub.uploads.saveUpload({ name: "暖色明细草案.txt", mimeType: "text/plain", bytes: Buffer.from("example"), ownerId: "local" });
    const id = await f.publication("装修交付", topic.conversationId as ConversationId, [asset]);
    const title = (await f.hub.searchConversations({ query: "暖色", limit: 1 })).items[0];
    expect(title).toMatchObject({ kind: "topic", topicId: topic.id });
    expect(await f.hub.listTopicFiles(topic.id)).toMatchObject({ total: 0 });
    expect((await f.hub.searchConversations({ query: asset.name })).items).toEqual([]);
    f.hub.uploads.bindAttachments([asset], `conversation:${topic.conversationId}`, "local");
    expect((await f.hub.searchConversations({ query: asset.name })).items[0]?.messageId).toBe(id);
    expect(await f.hub.listTopicFiles(topic.id)).toMatchObject({ total: 1, items: [{ messageId: id }] });
    const oldCursor = (await f.hub.searchConversations({ query: "暖色", limit: 1 })).nextCursor;
    await f.hub.patchTopic(topic.id, { title: "冷色设计新稿" });
    await expect(f.hub.searchConversations({ query: "暖色", limit: 1, cursor: oldCursor })).rejects.toMatchObject({ status: 409 });
    expect((await f.hub.searchConversations({ query: asset.name })).items[0]?.topicTitle).toBe("冷色设计新稿");
    await f.hub.deleteTopic(topic.id);
    expect((await f.hub.searchConversations({ query: asset.name })).items).toEqual([]);
  });

  it("keeps completed pages when typing cancels a search and rebuilds from Durable after restarting", async () => {
    const f = await fixture();
    const id = await f.user("保留的历史查询记录");
    await f.fill(510);
    const controller = new AbortController();
    const starts: number[] = [];
    const prototype: Conversation = Object.getPrototypeOf(f.hub.rootConversation);
    const read = prototype.entries;
    const spy = vi.spyOn(prototype, "entries").mockImplementation(async function (this: Conversation, ...args) {
      const query = args[0];
      if (query.order === "ascending" && query.minEntryId !== undefined) {
        starts.push(Number(query.minEntryId));
        if (starts.length === 2) controller.abort(new Error("search replaced"));
      }
      return read.apply(this, args);
    });
    await expect(f.hub.searchConversations({ query: "新输入搜索" }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow();
    const previousStart = starts[0];
    starts.length = 0;
    await f.hub.searchConversations({ query: "新输入搜索词" });
    expect(starts[0]).toBeGreaterThan(previousStart!);
    spy.mockRestore();
    await f.close();
    const restored = await fixture(f.stateDir);
    expect((await restored.hub.searchConversations({ query: "保留的历史" })).items[0]?.messageId).toBe(id);
  });

  it("authenticates and rejects invalid input and cross-query cursors", async () => {
    const f = await fixture();
    expect((await f.request("/api/conversations/search?q=example", "")).status).toBe(401);
    expect((await f.request("/api/topics/root/files", "")).status).toBe(401);
    for (const route of ["/api/conversations/search?q=", "/api/conversations/search?q=x&limit=0", "/api/conversations/search?q=x&limit=101", "/api/conversations/search?q=x&cursor=broken", "/api/topics/root/messages/1.2", "/api/topics/root/messages/-1", "/api/topics/root/files?limit=NaN", "/api/topics/%E0/files", "/api/topics/%2F/files"]) expect((await f.request(route)).status, route).toBe(400);
    expect((await f.request(`/api/conversations/search?q=${"a".repeat(257)}`)).status).toBe(400);
    expect((await f.request("/api/topics/root/messages/99999999")).status).toBe(404);
    expect((await f.hub.searchConversations({ query: '" OR *' })).items).toEqual([]);
  });
});
