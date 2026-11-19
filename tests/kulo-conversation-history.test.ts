import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { CompactionEntry, Harness, ToolResultEntry, UserEntry, createRegistry, type Conversation, type EntryDraft, type EntryId } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ProjectRecord, TopicSummary } from "@kulo/protocol";
import { KuloConversationHistory } from "../packages/hub/src/conversation-history.js";
import { createHistoryToolsExtension } from "../packages/hub/src/tools-history.js";
import { wrapRedactedStorage } from "../packages/hub/src/credential-redaction.js";
import { KuloStateDoc, ensureDefaultRootTopic } from "../packages/hub/src/state.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { ContentPublicationEntry, KuloUserEntry } from "../packages/hub/src/ui-cards.js";
import { VoiceTranscriptEntry } from "../packages/hub/src/voice-transcripts.js";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(options: { directory?: string; redact?: (text: string) => string } = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "kulo-full-history-"));
  if (!options.directory) cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "history-test", models: [{ id: "test" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  let history!: KuloConversationHistory;
  const extension = createHistoryToolsExtension(() => history);
  const toolSearchExt = createToolSearchExtension();
  registry.install(extension);
  registry.install(toolSearchExt);
  const storage = await openNodeSqliteStorage(path.join(directory, "durable.sqlite"));
  const harness = await Harness.open(options.redact ? wrapRedactedStorage(storage, options.redact) : storage,
    { models, registry, settings: { compaction: { enabled: false } } }, context);
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "history-test", modelId: "test" }, extensions: [extension, toolSearchExt] } });
  await harness.commit(async (tx) => { ensureDefaultRootTopic(await tx.doc(KuloStateDoc)); }, context);
  history = new KuloConversationHistory({ harness, stateDir: directory });
  cleanup.push(() => history.close());
  async function topic(title: string, projectId?: string) {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "history-test", modelId: "test" }, extensions: [extension] } }, context);
    const record: TopicSummary = { id: "topic-" + conversation.id, conversationId: Number(conversation.id), title, projectId: projectId ?? null, createdAt: 1, updatedAt: 1 };
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.topics![record.id] = record;
      state.conversationToTopic![String(conversation.id)] = record.id;
    }, context);
    return { conversation, record };
  }
  async function project(id: string) {
    const record: ProjectRecord = { id, name: id, deviceId: "local", workspaceDir: "/project/" + id, directoryId: id, revision: 1, grantRevision: 1, notes: "", createdAt: 1, updatedAt: 1 };
    await harness.commit(async (tx) => { (await tx.doc(KuloProjectsDoc)).projects[id] = record; }, context);
    return record;
  }
  return { directory, harness, root, history, faux, topic, project };
}

async function append(conversation: Conversation, entry: EntryDraft) {
  await (await conversation.submit({ type: "write", entry }, context)).wait(context);
  return (await conversation.entries({}, 1, undefined, context)).items[0]!.id;
}
function user(text: string, timestamp = 1000): EntryDraft {
  return { kind: UserEntry.kind, model: [{ role: "user", content: text, timestamp }] };
}

describe("complete conversation history", () => {
  it("finds an old original beyond 100 entries and beyond the current compacted context", async () => {
    const f = await fixture();
    const first = await append(f.root, user("最早约定：协议端口使用 43127，方案乙因恢复成本被否决。"));
    for (let i = 0; i < 125; i++) await append(f.root, user("后续日常交流 " + i, 2000 + i));
    const recent = await append(f.root, user("现在继续最近的工作。", 5000));
    await append(f.root, { kind: CompactionEntry.kind, head: recent, data: { reason: "manual" }, model: [{ role: "user", content: "此前的聊天已总结，只留下任务概况。", timestamp: 6000 }] });
    expect(JSON.stringify((await f.root.context(context)).messages)).not.toContain("43127");
    const result = await f.history.search(Number(f.root.id), { query: "协议端口" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ entryId: Number(first), conversationId: Number(f.root.id), historical: true, role: "user" });
    expect((await f.history.read(Number(f.root.id), { entryId: Number(first) })).text).toContain("43127");
  });

  it("preserves long tool output and returns bounded exact pages with source IDs", async () => {
    const f = await fixture();
    const text = "完整工具输出\n" + "日志内容 ".repeat(1100) + "\n关键原值：0.003125\n结束";
    const id = await append(f.root, { kind: ToolResultEntry.kind, data: { diagnostics: [] }, model: [{ role: "toolResult", toolName: "read", toolCallId: "read-source", isError: false, content: [{ type: "text", text }], timestamp: 1100 }] });
    expect((await f.history.search(Number(f.root.id), { query: "0.003125", maxChars: 240 })).matches[0]?.excerpt).toContain("0.003125");
    let offset = 0, combined = "";
    for (;;) {
      const page = await f.history.read(Number(f.root.id), { entryId: Number(id), offset, limit: 300 });
      expect(page).toMatchObject({ historical: true, entryId: Number(id), role: "tool_result", totalLength: text.length });
      expect(page.text.length).toBeLessThanOrEqual(300);
      combined += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(combined).toBe(text);
    await expect(f.history.read(Number(f.root.id), { entryId: Number(id), offset: text.length + 1 })).rejects.toMatchObject({ code: "invalid_history_offset" });
  });

  it("supports Chinese short phrases, keyword conjunctions, dates and stable pagination", async () => {
    const f = await fixture();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(Number(await append(f.root, user("中文任务 参数 alpha 记录 " + i, 1000 + i * 1000))));
    await append(f.root, user("仅有 alpha，缺少另一个词。", 9000));
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.history.search(Number(f.root.id), { query: "任务 alpha", mode: "keywords", after: 2000, before: 7000, limit: 2, cursor });
      seen.push(...page.matches.map((item) => item.entryId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids.slice(1, 6).reverse());
    expect(new Set(seen).size).toBe(seen.length);
    const short = await f.history.search(Number(f.root.id), { query: "任务", maxChars: 15 });
    expect(short.matches.map((item) => item.excerpt).join("").length).toBeLessThanOrEqual(15);
    await expect(f.history.search(Number(f.root.id), { query: "任务", cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "invalid_history_cursor" });
    await expect(f.history.search(Number(f.root.id), { query: "任务", after: 7000, before: 2000 })).rejects.toMatchObject({ code: "invalid_history_input" });
    expect((await f.history.search(Number(f.root.id), { query: '" OR *' })).matches).toEqual([]);
  });

  it("keeps the derived cursor across reopen and reads only the new tail", async () => {
    const f = await fixture();
    const first = await append(f.root, user("需要长期保留的原始决定"));
    await f.history.search(Number(f.root.id), { query: "原始决定" });
    await f.history.close();
    const next = Number(await append(f.root, user("后来新增的决定")));
    const calls: Array<{ minEntryId?: EntryId; order?: string }> = [];
    const original = f.harness.conversation.bind(f.harness);
    vi.spyOn(f.harness, "conversation").mockImplementation(async (...args) => {
      const conversation = await original(...args);
      return conversation && new Proxy(conversation, { get(target, key) {
        if (key === "entries") return (...parameters: Parameters<Conversation["entries"]>) => { calls.push(parameters[0]); return target.entries(...parameters); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    const reopened = new KuloConversationHistory({ harness: f.harness, stateDir: f.directory }); cleanup.push(() => reopened.close());
    expect((await reopened.search(Number(f.root.id), { query: "决定" })).matches.map((item) => item.entryId)).toEqual([next, Number(first)]);
    expect(calls.filter((query) => query.order === "ascending")).toMatchObject([{ minEntryId: Number(first) + 1 }]);
    calls.length = 0;
    await reopened.search(Number(f.root.id), { query: "决定" });
    expect(calls.filter((query) => query.order === "ascending")).toEqual([]);
  });

  it("retains old search references after the Durable Harness itself is reopened", async () => {
    const first = await fixture();
    const entryId = Number(await append(first.root, user("跨进程恢复后仍需读取：原始参数 0.0625。")));
    const before = await first.history.search(Number(first.root.id), { query: "原始参数" });
    await first.history.close(); await first.harness.close(context);
    const next = await fixture({ directory: first.directory });
    expect(Number(next.root.id)).toBe(Number(first.root.id));
    expect((await next.history.search(Number(next.root.id), { query: "原始参数" })).matches).toEqual(before.matches);
    expect((await next.history.read(Number(next.root.id), { entryId })).text).toContain("0.0625");
    await append(next.root, user("恢复以后新增的另一项参数。"));
    expect((await next.history.search(Number(next.root.id), { query: "参数" })).matches).toHaveLength(2);
  });

  it("limits project recall to live topics in the caller's currently bound project", async () => {
    const f = await fixture(); await f.project("project-a"); await f.project("project-b");
    const a = await f.topic("当前项目", "project-a"), sibling = await f.topic("同项目旧会话", "project-a"), other = await f.topic("另一个项目", "project-b");
    const local = Number(await append(a.conversation, user("同一检索词：本会话")));
    const shared = Number(await append(sibling.conversation, user("同一检索词：同项目")));
    const foreign = Number(await append(other.conversation, user("同一检索词：其他项目")));
    expect((await f.history.search(Number(a.conversation.id), { query: "同一检索词" })).matches.map((item) => item.entryId)).toEqual([local]);
    expect((await f.history.search(Number(a.conversation.id), { query: "同一检索词", scope: "project" })).matches.map((item) => item.entryId)).toEqual([shared, local]);
    expect((await f.history.read(Number(a.conversation.id), { conversationId: Number(sibling.conversation.id), entryId: shared })).text).toContain("同项目");
    await expect(f.history.read(Number(a.conversation.id), { conversationId: Number(other.conversation.id), entryId: foreign })).rejects.toMatchObject({ code: "history_forbidden" });
    const firstPage = await f.history.search(Number(a.conversation.id), { query: "同一检索词", scope: "project", limit: 1 });
    await f.harness.commit(async (tx) => { (await tx.doc(KuloStateDoc)).topics![sibling.record.id]!.projectId = "project-b"; }, context);
    expect((await f.history.search(Number(a.conversation.id), { query: "同一检索词", scope: "project" })).matches.map((item) => item.entryId)).toEqual([local]);
    await expect(f.history.search(Number(a.conversation.id), { query: "同一检索词", scope: "project", cursor: firstPage.nextCursor })).rejects.toMatchObject({ code: "history_cursor_changed" });
    await expect(f.history.read(Number(a.conversation.id), { conversationId: Number(sibling.conversation.id), entryId: shared })).rejects.toMatchObject({ code: "history_forbidden" });
    await f.harness.commit(async (tx) => { (await tx.doc(KuloProjectsDoc)).projects["project-a"]!.deletedAt = 10; }, context);
    await expect(f.history.search(Number(a.conversation.id), { query: "同一检索词" })).rejects.toMatchObject({ code: "history_forbidden" });
  });

  it("rejects deleted, settings and worker callers and never indexes system or compaction summaries", async () => {
    const f = await fixture();
    const deleted = await f.topic("待删除");
    const id = Number(await append(deleted.conversation, user("删除后不可见的历史")));
    await f.history.search(Number(deleted.conversation.id), { query: "不可见" });
    await f.harness.commit(async (tx) => { (await tx.doc(KuloStateDoc)).topics![deleted.record.id]!.deletedAt = 20; }, context);
    await expect(f.history.read(Number(deleted.conversation.id), { entryId: id })).rejects.toMatchObject({ code: "history_forbidden" });
    const worker = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await f.harness.commit(async (tx) => { (await tx.doc(KuloStateDoc)).conversationToTicket[String(worker.id)] = "worker-private"; }, context);
    await expect(f.history.search(Number(worker.id), { query: "任何历史" })).rejects.toMatchObject({ code: "history_forbidden" });
    const settings = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await expect(f.history.search(Number(settings.id), { query: "任何历史" })).rejects.toMatchObject({ code: "history_forbidden" });
    const system = await append(f.root, { kind: "pi.system", model: [{ role: "system", content: "敏感系统规则不属于聊天历史", timestamp: 1 }] });
    await append(f.root, { kind: "kulo.memory-context", model: [{ role: "user", content: "私有召回不作为历史事实再次索引", timestamp: 2 }] });
    expect((await f.history.search(Number(f.root.id), { query: "系统规则" })).matches).toEqual([]);
    await expect(f.history.read(Number(f.root.id), { entryId: Number(system) })).rejects.toMatchObject({ code: "history_not_found" });
  });

  it("re-reads the redacted owning source before returning a cached search hit", async () => {
    let hides = false;
    const f = await fixture({ redact: (text) => hides ? text.replaceAll("synthetic-sensitive-value", "[REDACTED]") : text });
    const id = Number(await append(f.root, user("旧资料 synthetic-sensitive-value 已进入历史。")));
    expect((await f.history.search(Number(f.root.id), { query: "synthetic-sensitive-value" })).matches).toHaveLength(1);
    hides = true;
    expect((await f.history.search(Number(f.root.id), { query: "synthetic-sensitive-value" })).matches).toEqual([]);
    const read = await f.history.read(Number(f.root.id), { entryId: id });
    expect(read.text).toContain("[REDACTED]"); expect(read.text).not.toContain("synthetic-sensitive-value");
    const derived = new DatabaseSync(path.join(f.directory, "conversation-history.sqlite"), { readOnly: true });
    try { expect(JSON.stringify(derived.prepare("SELECT normalized FROM history_entries").all())).not.toContain("synthetic-sensitive-value"); }
    finally { derived.close(); }
  });

  it("indexes published text, voice and user attachment names without loading attachment bytes", async () => {
    const f = await fixture();
    const voice = Number(await append(f.root, { kind: VoiceTranscriptEntry.kind, data: { callId: "call-one", role: "user", text: "电话里确认了准确阈值", createdAt: 1200 } }));
    const published = Number(await append(f.root, { kind: ContentPublicationEntry.kind, data: { parts: [{ partId: "part-one", type: "markdown", text: "交付正文包含最终决定" }], fallbackText: "备用正文", createdAt: 1300 } }));
    const attached = Number(await append(f.root, { kind: KuloUserEntry.kind, data: { kuloContentVersion: 1, text: "请查附件", attachments: [{ id: "att_test_123", name: "参数原稿.txt", kind: "file", mimeType: "text/plain", size: 5 }] }, model: [{ role: "user", content: "请查附件", timestamp: 1400 }] }));
    expect((await f.history.search(Number(f.root.id), { query: "准确阈值" })).matches[0]?.entryId).toBe(voice);
    expect((await f.history.search(Number(f.root.id), { query: "最终决定" })).matches[0]?.entryId).toBe(published);
    expect((await f.history.search(Number(f.root.id), { query: "参数原稿" })).matches[0]?.entryId).toBe(attached);
    expect((await f.history.read(Number(f.root.id), { entryId: attached })).attachments).toEqual([{ id: "att_test_123", name: "参数原稿.txt" }]);
  });

  it("offers history tools independently of the optional compression plugin", async () => {
    const f = await fixture();
    const original = Number(await append(f.root, user("早期记录的端口是 51891。")));
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_history_search kulo_history_read", limit: 5 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("kulo_history_search", { query: "51891" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("kulo_history_read", { entry_id: original })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已按原始记录确认。")]),
    ]);
    await (await f.root.submit({ type: "input", content: "回查早期参数。" }, context)).wait(context);
    await f.root.waitForIdle(context);
    const entries = await f.root.entries({}, 20, undefined, context);
    const results = entries.items
      .filter(ToolResultEntry.is)
      .map((entry) => entry.model?.[0])
      .filter((message) => message?.role === "toolResult" && message.toolName !== "tool_search");
    expect(results).toHaveLength(2);
    const payloads = results.map((message) => JSON.parse(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")));
    expect(payloads.find((value) => typeof value.text === "string")).toMatchObject({ historical: true, entryId: original });
    expect(payloads.find((value) => Array.isArray(value.matches)).matches[0]).toMatchObject({ historical: true, entryId: original });
    expect(JSON.stringify(results)).toContain("51891");
    expect(results.every((message) => !message.isError)).toBe(true);
  });
});
