import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { getMessageParts, type ChatAttachment, type ChatDisplayItem, type ConversationFile, type ConversationFilesPage, type ConversationMessageWindow, type ConversationSearchInput, type ConversationSearchMatch, type ConversationSearchPage, type TopicSummary } from "@moco/protocol";
import { isRecoveryInputBoundary } from "./state.js";
import { CONVERSATION_QUERY_PAGE_SIZE, ConversationQueryIndex, foldQueryText, isVisibleMessage, messageText, queryFingerprint } from "./conversation-query-index.js";

const MAX_QUERY_LENGTH = 256;
const MAX_CURSOR_LENGTH = 2048;
const MAX_TOPIC_LENGTH = 160;

export class ConversationQueryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ConversationQueryError"; }
}

export interface ConversationQuerySource {
  topics(context: Context): Promise<TopicSummary[]>;
  conversation(id: number, context: Context): Promise<Conversation | undefined>;
  project(entries: readonly EntryRecord[], conversationId: number, context: Context): Promise<ChatDisplayItem[]>;
  attachment(assetId: string, conversationId: number): ChatAttachment | undefined;
  redactionRevision(): number;
}

type QueryCursor = { version: 1; signature: string; topicId: string; kind?: "topic" | "message"; messageId: number; assetId?: string };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ConversationQueryError(400, "invalid_conversation_query", `${label}无效。`);
  return value;
}
function validTopicId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_TOPIC_LENGTH || /[\x00-\x20\x7f/]/.test(value)) throw new ConversationQueryError(400, "invalid_conversation_query", "会话编号无效。");
  return value;
}
export function decodeConversationTopicId(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new ConversationQueryError(400, "invalid_conversation_query", "会话编号无效。"); }
  return validTopicId(decoded);
}
function pageSize(value: unknown, fallback: number): number { return value === undefined ? fallback : validInteger(value, "结果数量", 100); }
function scopeSignature(topics: TopicSummary[]): string {
  return hash(topics.map((topic) => [topic.id, topic.conversationId, topic.title, Boolean(topic.archived), topic.projectId ?? null]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}
function decodeCursor(value: string | undefined, signature: string): QueryCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ConversationQueryError(400, "invalid_conversation_cursor", "分页位置无效。");
  let candidate: unknown;
  try { candidate = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new ConversationQueryError(400, "invalid_conversation_cursor", "分页位置无效。"); }
  const cursor = candidate as Partial<QueryCursor> | null;
  if (!cursor || cursor.version !== 1 || typeof cursor.signature !== "string" || typeof cursor.topicId !== "string" || !Number.isSafeInteger(cursor.messageId) || cursor.messageId! < 0 || cursor.kind !== undefined && cursor.kind !== "topic" && cursor.kind !== "message" || cursor.assetId !== undefined && (typeof cursor.assetId !== "string" || cursor.assetId.length > 160)) {
    throw new ConversationQueryError(400, "invalid_conversation_cursor", "分页位置无效。");
  }
  if (cursor.signature !== signature) throw new ConversationQueryError(409, "conversation_query_changed", "查询范围已变化，请重新搜索。");
  return cursor as QueryCursor;
}
function encodeCursor(cursor: QueryCursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function searchOrder(left: Pick<ConversationSearchMatch, "kind" | "messageId" | "topicId">, right: Pick<ConversationSearchMatch, "kind" | "messageId" | "topicId">): number {
  return Number(left.kind === "message") - Number(right.kind === "message") || (right.messageId ?? 0) - (left.messageId ?? 0) || left.topicId.localeCompare(right.topicId);
}
function fileOrder(left: ConversationFile, right: ConversationFile): number { return right.messageId - left.messageId || left.asset.id.localeCompare(right.asset.id); }
function excerpt(text: string, query: string): string {
  const display = text.normalize("NFKC");
  const at = foldQueryText(display).indexOf(query);
  const from = Math.max(0, at - 90);
  const to = Math.min(display.length, from + 360);
  return `${from ? "…" : ""}${display.slice(from, to)}${to < display.length ? "…" : ""}`;
}

export class ConversationQueries {
  readonly #index: ConversationQueryIndex;

  constructor(readonly source: ConversationQuerySource) {
    this.#index = new ConversationQueryIndex({
      project: source.project,
      conversation: async (id, context) => {
        const conversation = await source.conversation(id, context);
        if (!conversation) throw new ConversationQueryError(404, "conversation_not_found", "会话记录不存在。");
        return conversation;
      },
    });
  }

  async #topics(topicId: string | undefined, context: Context): Promise<TopicSummary[]> {
    const topics = await this.source.topics(context);
    this.#index.retain(topics);
    if (topicId === undefined) return topics;
    validTopicId(topicId);
    const topic = topics.find((item) => item.id === topicId);
    if (!topic) throw new ConversationQueryError(404, "conversation_not_found", "会话不存在或已删除。");
    return [topic];
  }

  async #unchanged(topics: TopicSummary[], topicId: string | undefined, context: Context): Promise<void> {
    if (scopeSignature(await this.#topics(topicId, context)) !== scopeSignature(topics)) throw new ConversationQueryError(409, "conversation_query_changed", "会话范围已变化，请重新查询。");
  }

  async #withCurrentRedaction<T>(context: Context, query: (revision: number) => Promise<T>): Promise<T> {
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const revision = this.source.redactionRevision();
      const result = await query(revision);
      if (this.source.redactionRevision() === revision) return result;
    }
  }

  async search(input: ConversationSearchInput, context: Context = BACKGROUND_CONTEXT): Promise<ConversationSearchPage> {
    if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > MAX_QUERY_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.query)) throw new ConversationQueryError(400, "invalid_conversation_query", "请输入有效的搜索内容。");
    return this.#withCurrentRedaction(context, (revision) => this.#search(input, revision, context));
  }

  async #search(input: ConversationSearchInput, revision: number, context: Context): Promise<ConversationSearchPage> {
    const query = foldQueryText(input.query.trim());
    const limit = pageSize(input.limit, 30);
    const topics = await this.#topics(input.topicId, context);
    const signature = hash(["search", scopeSignature(topics), query, input.topicId ?? null]);
    const cursor = decodeCursor(input.cursor, signature);
    if (cursor && (cursor.kind === undefined || cursor.assetId !== undefined || !topics.some((topic) => topic.id === cursor.topicId))) throw new ConversationQueryError(400, "invalid_conversation_cursor", "分页位置无效。");
    const items: ConversationSearchMatch[] = [];
    const collect = (item: ConversationSearchMatch) => {
      if (cursor && searchOrder(item, { ...cursor, kind: cursor.kind! }) <= 0) return;
      items.push(item);
      items.sort(searchOrder);
      if (items.length > limit + 1) items.pop();
    };
    const source = (topic: TopicSummary) => ({
      topicId: topic.id, topicTitle: topic.title,
      ...(topic.archived ? { archived: true } : {}), ...(topic.projectId ? { projectId: topic.projectId } : {}),
    });
    for (const topic of topics) {
      if (foldQueryText(topic.title).includes(query)) collect({ ...source(topic), kind: "topic", excerpt: topic.title });
    }
    if (items.length <= limit) await this.#index.visit(topics, revision, {
      fingerprint: queryFingerprint(query),
      within: (first, last) => {
        if (cursor?.kind === "message" && first > cursor.messageId) return false;
        const threshold = items[limit];
        return !threshold || threshold.messageId !== undefined && last >= threshold.messageId;
      },
      collect: (topic, messages) => {
        for (const item of messages) {
          const text = messageText(item);
          if (foldQueryText(text).includes(query)) collect({ ...source(topic), kind: "message", messageId: item.id, role: item.role,
            ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}), excerpt: excerpt(text, query) });
        }
      },
    }, context);
    await this.#unchanged(topics, input.topicId, context);
    const hasMore = items.length > limit;
    if (hasMore) items.pop();
    const last = items.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ version: 1, signature, topicId: last.topicId, kind: last.kind, messageId: last.messageId ?? 0 }) } : {}) };
  }

  async messageWindow(topicId: string, messageId: number, context: Context = BACKGROUND_CONTEXT): Promise<ConversationMessageWindow> {
    validInteger(messageId, "消息位置");
    const topics = await this.#topics(validTopicId(topicId), context);
    const topic = topics[0]!;
    const conversation = await this.source.conversation(topic.conversationId, context);
    if (!conversation) throw new ConversationQueryError(404, "conversation_not_found", "会话记录不存在。");
    const [older, newer] = await Promise.all([
      conversation.entries({ maxEntryId: messageId as EntryId }, 61, undefined, context),
      conversation.entries({ minEntryId: (messageId + 1) as EntryId, order: "ascending" }, 30, undefined, context),
    ]);
    const entries = [...older.items].reverse().concat(newer.items);
    const ids = new Set(entries.map((entry) => Number(entry.id)));
    // A boundary just outside this window may suppress recovery-only assistant output inside it.
    let prefix: EntryRecord | undefined;
    if (!entries.some((entry) => Number(entry.id) <= messageId && isRecoveryInputBoundary(entry)) && entries[0] && Number(entries[0].id) > 1) {
      const query = { maxEntryId: (Number(entries[0].id) - 1) as EntryId };
      let page = await conversation.entries(query, CONVERSATION_QUERY_PAGE_SIZE, undefined, context);
      for (;;) {
        context.abortSignal?.throwIfAborted();
        prefix = page.items.find(isRecoveryInputBoundary);
        if (prefix || !page.next) break;
        page = await conversation.entries(query, CONVERSATION_QUERY_PAGE_SIZE, page.next, context);
      }
    }
    const messages = (await this.source.project(prefix ? [prefix, ...entries] : entries, topic.conversationId, context)).filter((item) => ids.has(item.id) && isVisibleMessage(item));
    if (!messages.some((item) => item.id === messageId)) throw new ConversationQueryError(404, "conversation_message_not_found", "原消息不存在或已不可用。");
    await this.#unchanged(topics, topicId, context);
    return { topicId, messageId, messages, ...(older.next && older.items.at(-1) ? { beforeEntryId: Number(older.items.at(-1)!.id) } : {}), hasMore: Boolean(older.next) };
  }

  async files(topicId: string, input: { cursor?: string; limit?: number } = {}, context: Context = BACKGROUND_CONTEXT): Promise<ConversationFilesPage> {
    return this.#withCurrentRedaction(context, (revision) => this.#files(topicId, input, revision, context));
  }

  async #files(topicId: string, input: { cursor?: string; limit?: number }, revision: number, context: Context): Promise<ConversationFilesPage> {
    const topics = await this.#topics(validTopicId(topicId), context);
    const topic = topics[0]!;
    const limit = pageSize(input.limit, 50);
    const signature = hash(["files", scopeSignature(topics)]);
    const cursor = decodeCursor(input.cursor, signature);
    if (cursor && (cursor.topicId !== topicId || typeof cursor.assetId !== "string" || cursor.kind !== undefined)) throw new ConversationQueryError(400, "invalid_conversation_cursor", "分页位置无效。");
    const assets = new Map<string, ConversationFile>();
    await this.#index.visit(topics, revision, {
      within: () => true,
      collect: (_topic, messages) => {
        for (const item of messages) {
          for (const part of getMessageParts(item)) {
            if (!("assetId" in part)) continue;
            const asset = this.source.attachment(part.assetId, topic.conversationId);
            if (!asset || (assets.get(asset.id)?.messageId ?? -1) >= item.id) continue;
            assets.set(asset.id, { asset, messageId: item.id, role: item.role,
              ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}) });
          }
        }
      },
    }, context);
    await this.#unchanged(topics, topicId, context);
    const all = [...assets.values()].sort(fileOrder);
    const remaining = cursor ? all.filter((item) => fileOrder(item, { messageId: cursor.messageId, asset: { id: cursor.assetId! } } as ConversationFile) > 0) : all;
    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    return { items, total: all.length, ...(remaining.length > limit && last ? { nextCursor: encodeCursor({ version: 1, signature, topicId, messageId: last.messageId, assetId: last.asset.id }) } : {}) };
  }
}
