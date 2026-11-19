import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry, ROOT_CONVERSATION_ID, ToolResultEntry, UserEntry,
  type Conversation, type ConversationId, type EntryId, type EntryRecord, type Harness,
} from "@earendil-works/pi-durable";
import type { TopicSummary } from "@kulo/protocol";
import { KuloProjectsDoc } from "./projects.js";
import { KuloStateDoc, isOrchestratorConversation } from "./state.js";
import { SettingsAssistantDoc, isActiveSettingsConversation, settingsTopicId } from "./settings-doc.js";
import { ContentPublicationEntry, KuloUserEntry } from "./ui-cards.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";

const PAGE_SIZE = 200;
const MAX_QUERY_CHARS = 256;
const MAX_OUTPUT_CHARS = 16_000;
const SCHEMA_VERSION = 1;
const INVITATION_CLEANUP = "device-invitation-redaction-v1";

export type HistoryRole = "user" | "assistant" | "tool_result";
export type HistoryScope = "conversation" | "project";
export interface HistorySearchInput {
  query: string;
  scope?: HistoryScope;
  mode?: "phrase" | "keywords";
  after?: number;
  before?: number;
  limit?: number;
  cursor?: string;
  maxChars?: number;
}
export interface HistoryReadInput {
  conversationId?: number;
  entryId: number;
  offset?: number;
  limit?: number;
}
export interface HistorySource {
  conversationId: number;
  entryId: number;
  topicId: string;
  topicTitle: string;
  kind: string;
  role: HistoryRole;
  createdAt: number;
  historical: true;
}
export interface HistorySearchMatch extends HistorySource {
  excerpt: string;
  totalLength: number;
}
export interface HistorySearchResult {
  matches: HistorySearchMatch[];
  nextCursor?: string;
}
export interface HistoryReadResult extends HistorySource {
  text: string;
  offset: number;
  totalLength: number;
  nextOffset?: number;
  attachments?: Array<{ id: string; name: string }>;
}
export class HistoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

interface SourceText {
  text: string;
  searchable: string;
  role: HistoryRole;
  createdAt: number;
  attachments?: Array<{ id: string; name: string }>;
}
interface ScopeView {
  topics: Map<number, TopicSummary>;
  signature: string;
}
interface SearchCursor { version: 1; signature: string; entryId: number; conversationId: number }
interface IndexedRow { conversation_id: number; entry_id: number }

const normalized = (text: string): string => text.normalize("NFKC").toLocaleLowerCase();
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
function number(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HistoryError(400, "invalid_history_input", label + "无效。");
  }
  return value;
}
function modelText(entry: EntryRecord): string {
  return (entry.model ?? []).flatMap((message) => typeof message.content === "string"
    ? [message.content]
    : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
}
function timestamp(entry: EntryRecord): number {
  const data = entry.data;
  const candidate = data && typeof data === "object" && !Array.isArray(data) && typeof data.createdAt === "number"
    ? data.createdAt : entry.model?.[0]?.timestamp;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
}

/** Read original text, never a model's thinking or positional system instructions. */
export function historyEntryText(entry: EntryRecord): SourceText | undefined {
  let text: string;
  let role: HistoryRole;
  let attachments: SourceText["attachments"];
  if (KuloUserEntry.is(entry)) {
    text = entry.data.text;
    attachments = entry.data.attachments.map(({ id, name }) => ({ id, name }));
    role = "user";
  } else if (UserEntry.is(entry)) {
    text = modelText(entry);
    role = "user";
  } else if (AssistantEntry.is(entry)) {
    if (entry.model?.some((message) => message.role === "assistant" && ["aborted", "error", "deferred"].includes(message.stopReason))) return undefined;
    text = modelText(entry);
    role = "assistant";
  } else if (ToolResultEntry.is(entry)) {
    const message = entry.model?.[0];
    // Recalled evidence is already indexed at its original entry; indexing it again amplifies duplicates.
    if (message?.role !== "toolResult" || ["kulo_history_search", "kulo_history_read"].includes(message.toolName)) return undefined;
    text = modelText(entry);
    role = "tool_result";
  } else if (VoiceTranscriptEntry.is(entry)) {
    text = entry.data.text;
    role = entry.data.role;
  } else if (ContentPublicationEntry.is(entry)) {
    const markdown = entry.data.parts.flatMap((part) => part.type === "markdown" ? [part.text] : []);
    text = markdown.length ? markdown.join("\n\n") : entry.data.fallbackText;
    role = "assistant";
  } else if (entry.kind === "kulo.worker_relay") {
    text = modelText(entry);
    if (!text && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
      text = [entry.data.summary, entry.data.deliverable, entry.data.question].filter((value): value is string => typeof value === "string" && !!value).join("\n\n");
    }
    role = "assistant";
  } else return undefined;
  const searchable = [text, ...(attachments ?? []).map((item) => item.name)].filter(Boolean).join("\n");
  if (!searchable) return undefined;
  return { text, searchable, role, createdAt: timestamp(entry), ...(attachments?.length ? { attachments } : {}) };
}

function historyIndexFile(stateDir: string): string {
  const file = path.join(stateDir, "conversation-history.sqlite");
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new HistoryError(409, "history_index_invalid", "历史索引路径不是普通文件。");
  return file;
}

function historyIndexVersion(database: DatabaseSync): number {
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  if (version > SCHEMA_VERSION) throw new HistoryError(409, "history_index_version", "历史索引来自较新版本的 Kulo。");
  return version;
}

/** Mark the cache before rewriting Durable. An interrupted startup can still detect the stale index. */
export function invalidateDeviceInvitationSearchIndex(stateDir: string): void {
  const filename = historyIndexFile(stateDir);
  if (!fs.existsSync(filename)) return;
  const database = new DatabaseSync(filename);
  try {
    historyIndexVersion(database);
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='history_maintenance'").get()) {
      database.prepare("DELETE FROM history_maintenance WHERE name=?").run(INVITATION_CLEANUP);
    }
  } finally { database.close(); }
}

/** A derived index; Durable remains the authority for both text and visibility. */
export class KuloConversationHistory {
  readonly #harness: Harness;
  readonly #db: DatabaseSync;
  #tail: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(options: { harness: Harness; stateDir: string }) {
    this.#harness = options.harness;
    fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const filename = historyIndexFile(options.stateDir);
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, "wx", 0o600));
    this.#db = new DatabaseSync(filename);
    try {
      const version = historyIndexVersion(this.#db);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      this.#db.exec([
        "CREATE TABLE IF NOT EXISTS history_entries (rowid INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, created_at INTEGER NOT NULL, normalized TEXT NOT NULL, UNIQUE(conversation_id, entry_id));",
        "CREATE INDEX IF NOT EXISTS history_entries_scope ON history_entries(conversation_id, entry_id DESC);",
        "CREATE VIRTUAL TABLE IF NOT EXISTS history_search USING fts5(normalized, content='history_entries', content_rowid='rowid', tokenize='trigram');",
        "CREATE TRIGGER IF NOT EXISTS history_insert AFTER INSERT ON history_entries BEGIN INSERT INTO history_search(rowid, normalized) VALUES (new.rowid, new.normalized); END;",
        "CREATE TRIGGER IF NOT EXISTS history_delete AFTER DELETE ON history_entries BEGIN INSERT INTO history_search(history_search, rowid, normalized) VALUES ('delete', old.rowid, old.normalized); END;",
        "CREATE TRIGGER IF NOT EXISTS history_update AFTER UPDATE ON history_entries BEGIN INSERT INTO history_search(history_search, rowid, normalized) VALUES ('delete', old.rowid, old.normalized); INSERT INTO history_search(rowid, normalized) VALUES (new.rowid, new.normalized); END;",
        "CREATE TABLE IF NOT EXISTS history_cursors (conversation_id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL);",
        "CREATE TABLE IF NOT EXISTS history_maintenance (name TEXT PRIMARY KEY);",
        "CREATE TEMP TABLE history_scope (conversation_id INTEGER PRIMARY KEY);",
      ].join("\n"));
      if (version !== SCHEMA_VERSION) this.#db.exec("PRAGMA user_version=" + SCHEMA_VERSION);
      if (!this.#db.prepare("SELECT 1 FROM history_maintenance WHERE name=?").get(INVITATION_CLEANUP)) {
        if (version !== 0) {
          // The old index kept lowercased invitations, including unlabelled echoes. Reindex from scrubbed Durable history.
          this.#db.exec(`
            PRAGMA secure_delete=ON;
            BEGIN IMMEDIATE;
            DELETE FROM history_entries;
            DELETE FROM history_cursors;
            INSERT INTO history_search(history_search) VALUES ('rebuild');
            COMMIT;
            VACUUM;
          `);
          const result = this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (result?.busy !== 0) throw new HistoryError(409, "history_index_busy", "历史索引正在使用，请稍后重试。");
        }
        this.#db.prepare("INSERT OR IGNORE INTO history_maintenance(name) VALUES (?)").run(INVITATION_CLEANUP);
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  async #serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closing) throw new HistoryError(409, "history_closed", "历史服务已关闭。");
    const pending = this.#tail.then(run, run);
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #scope(caller: number, requested: HistoryScope, context: Context): Promise<ScopeView> {
    number(caller, "主会话编号", 1);
    const state = await this.#harness.snapshot(KuloStateDoc, context);
    if (!isOrchestratorConversation(caller as ConversationId, state)) {
      const settings = await this.#harness.snapshot(SettingsAssistantDoc, context);
      if (!isActiveSettingsConversation(caller, settings)) {
        throw new HistoryError(403, "history_forbidden", "只有主脑可以检索对话历史。");
      }
      if (requested === "project") throw new HistoryError(403, "history_project_required", "当前会话没有关联项目。");
      const stored = settings?.conversations?.[String(caller)]?.view;
      const synthetic: TopicSummary = {
        id: settingsTopicId(caller),
        conversationId: caller,
        title: stored?.title || "设置对话",
        createdAt: stored?.createdAt ?? 0,
        updatedAt: stored?.updatedAt ?? 0,
      };
      const topics = new Map<number, TopicSummary>([[caller, synthetic]]);
      return { topics, signature: digest(JSON.stringify([caller, requested, null, [caller]])) };
    }
    const topicId = state?.conversationToTopic?.[String(caller)] ?? (caller === Number(ROOT_CONVERSATION_ID) ? "root" : undefined);
    const own = topicId && state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
    if (!own || own.deletedAt !== undefined || own.conversationId !== caller) throw new HistoryError(403, "history_forbidden", "当前会话不可用。");
    const projects = await this.#harness.snapshot(KuloProjectsDoc, context);
    if (own.projectId) {
      const project = projects?.projects[own.projectId];
      if (!project || project.deletedAt !== undefined) throw new HistoryError(403, "history_forbidden", "当前会话所属项目不可用。");
    }
    const topics = new Map<number, TopicSummary>();
    if (requested === "project") {
      if (!own.projectId) throw new HistoryError(403, "history_project_required", "当前会话没有关联项目。");
      for (const topic of Object.values(state?.topics ?? {})) {
        if (topic.projectId === own.projectId && topic.deletedAt === undefined &&
          isOrchestratorConversation(topic.conversationId as ConversationId, state)) topics.set(topic.conversationId, topic);
      }
    } else topics.set(caller, own);
    const ids = [...topics.keys()].sort((left, right) => left - right);
    return { topics, signature: digest(JSON.stringify([caller, requested, own.projectId ?? null, ids])) };
  }

  async #conversation(id: number, context: Context): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (!conversation) throw new HistoryError(404, "history_not_found", "历史会话不存在。");
    return conversation;
  }

  #put(conversationId: number, entry: EntryRecord): void {
    const source = historyEntryText(entry);
    if (!source) return;
    this.#db.prepare("INSERT INTO history_entries(conversation_id,entry_id,created_at,normalized) VALUES (?,?,?,?) ON CONFLICT(conversation_id,entry_id) DO UPDATE SET created_at=excluded.created_at, normalized=excluded.normalized WHERE history_entries.normalized<>excluded.normalized OR history_entries.created_at<>excluded.created_at")
      .run(conversationId, Number(entry.id), source.createdAt, normalized(source.searchable));
  }

  async #sync(id: number, conversation: Conversation, context: Context): Promise<void> {
    const latest = (await conversation.entries({}, 1, undefined, context)).items[0];
    let after = (this.#db.prepare("SELECT entry_id FROM history_cursors WHERE conversation_id=?").get(id) as { entry_id: number } | undefined)?.entry_id ?? 0;
    const cutoff = latest ? Number(latest.id) : 0;
    if (cutoff < after) {
      this.#db.prepare("DELETE FROM history_entries WHERE conversation_id=?").run(id);
      this.#db.prepare("DELETE FROM history_cursors WHERE conversation_id=?").run(id);
      after = 0;
    }
    while (after < cutoff) {
      context.abortSignal?.throwIfAborted();
      const page = await conversation.entries({ minEntryId: (after + 1) as EntryId, maxEntryId: cutoff as EntryId, order: "ascending" }, PAGE_SIZE, undefined, context);
      if (!page.items.length) throw new HistoryError(409, "history_changed", "历史记录已变化，请重新检索。");
      const next = Number(page.items.at(-1)!.id);
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of page.items) this.#put(id, entry);
        this.#db.prepare("INSERT INTO history_cursors(conversation_id,entry_id) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET entry_id=excluded.entry_id").run(id, next);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
      after = next;
    }
  }

  async #entry(conversation: Conversation, id: number, context: Context): Promise<EntryRecord | undefined> {
    const page = await conversation.entries({ minEntryId: id as EntryId, maxEntryId: id as EntryId }, 1, undefined, context);
    return page.items.find((entry) => Number(entry.id) === id);
  }

  #source(conversationId: number, entry: EntryRecord, text: SourceText, topic: TopicSummary): HistorySource {
    return { conversationId, entryId: Number(entry.id), topicId: topic.id, topicTitle: topic.title,
      kind: entry.kind, role: text.role, createdAt: text.createdAt, historical: true };
  }

  async search(callerConversationId: number, input: HistorySearchInput, context: Context = BACKGROUND_CONTEXT): Promise<HistorySearchResult> {
    if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > MAX_QUERY_CHARS || input.query.includes("\0") ||
      input.scope !== undefined && !["conversation", "project"].includes(input.scope) || input.mode !== undefined && !["phrase", "keywords"].includes(input.mode)) {
      throw new HistoryError(400, "invalid_history_input", "检索内容或范围无效。");
    }
    const query = normalized(input.query.trim());
    const terms = input.mode === "keywords" ? [...new Set(query.split(/\s+/).filter(Boolean))] : [query];
    const limit = input.limit === undefined ? 10 : number(input.limit, "结果数量", 1, 50);
    const maxChars = input.maxChars === undefined ? 8000 : number(input.maxChars, "回填预算", 1, MAX_OUTPUT_CHARS);
    if (input.after !== undefined) number(input.after, "开始时间", 0);
    if (input.before !== undefined) number(input.before, "结束时间", 0);
    if (input.after !== undefined && input.before !== undefined && input.after >= input.before) throw new HistoryError(400, "invalid_history_input", "检索时间范围无效。");
    return this.#serial(async () => {
      const scope = input.scope ?? "conversation";
      const view = await this.#scope(callerConversationId, scope, context);
      const signature = digest(JSON.stringify([view.signature, query, input.mode ?? "phrase", input.after, input.before]));
      let position: Pick<SearchCursor, "entryId" | "conversationId"> | undefined;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== "string" || input.cursor.length > 1024) throw new HistoryError(400, "invalid_history_cursor", "历史分页位置无效。");
        let candidate: unknown;
        try { candidate = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
        catch { throw new HistoryError(400, "invalid_history_cursor", "历史分页位置无效。"); }
        const cursor = candidate as Partial<SearchCursor> | null;
        if (!cursor || cursor.version !== 1 || cursor.signature !== signature || !Number.isSafeInteger(cursor.entryId) || cursor.entryId! < 1 ||
          !Number.isSafeInteger(cursor.conversationId) || !view.topics.has(cursor.conversationId!)) throw new HistoryError(409, "history_cursor_changed", "检索范围已变化，请重新检索。");
        position = { entryId: cursor.entryId!, conversationId: cursor.conversationId! };
      }
      const conversations = new Map<number, Conversation>();
      for (const id of view.topics.keys()) {
        const conversation = await this.#conversation(id, context);
        conversations.set(id, conversation);
        await this.#sync(id, conversation, context);
      }
      this.#db.exec("DELETE FROM history_scope");
      const insertScope = this.#db.prepare("INSERT INTO history_scope(conversation_id) VALUES (?)");
      for (const id of view.topics.keys()) insertScope.run(id);
      const indexedTerms = terms.filter((term) => Array.from(term).length >= 3);
      const where = ["e.conversation_id IN (SELECT conversation_id FROM history_scope)"];
      const args: Array<string | number> = [];
      if (indexedTerms.length) {
        where.push("history_search MATCH ?");
        args.push(indexedTerms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(" AND "));
      }
      for (const term of terms) { where.push("instr(e.normalized,?)>0"); args.push(term); }
      if (input.after !== undefined) { where.push("e.created_at>=?"); args.push(input.after); }
      if (input.before !== undefined) { where.push("e.created_at<?"); args.push(input.before); }
      const matches: HistorySearchMatch[] = [];
      let remaining = maxChars;
      let nextCursor: string | undefined;
      for (;;) {
        context.abortSignal?.throwIfAborted();
        const clauses = [...where];
        const parameters = [...args];
        if (position) {
          clauses.push("(e.entry_id<? OR (e.entry_id=? AND e.conversation_id<?))");
          parameters.push(position.entryId, position.entryId, position.conversationId);
        }
        const join = indexedTerms.length ? " JOIN history_search ON history_search.rowid=e.rowid" : "";
        const rows = this.#db.prepare("SELECT e.conversation_id,e.entry_id FROM history_entries e" + join + " WHERE " + clauses.join(" AND ") + " ORDER BY e.entry_id DESC,e.conversation_id DESC LIMIT 100").all(...parameters) as unknown as IndexedRow[];
        if (!rows.length) break;
        let exhausted = true;
        for (const row of rows) {
          position = { entryId: row.entry_id, conversationId: row.conversation_id };
          const conversation = conversations.get(row.conversation_id)!;
          const entry = await this.#entry(conversation, row.entry_id, context);
          const source = entry && historyEntryText(entry);
          // Credentials can be redacted after the derived index was built. Always re-read the owning source.
          if (!entry || !source) {
            this.#db.prepare("DELETE FROM history_entries WHERE conversation_id=? AND entry_id=?").run(row.conversation_id, row.entry_id);
            continue;
          }
          this.#put(row.conversation_id, entry);
          if (!terms.every((term) => normalized(source.searchable).includes(term))) continue;
          const at = terms.reduce((found, term) => Math.min(found, normalized(source.searchable).indexOf(term)), source.searchable.length);
          const from = Math.max(0, at - 120);
          const excerpt = source.searchable.slice(from, from + Math.min(720, remaining));
          matches.push({ ...this.#source(row.conversation_id, entry, source, view.topics.get(row.conversation_id)!), excerpt, totalLength: source.text.length });
          remaining -= excerpt.length;
          if (matches.length >= limit || remaining <= 0) {
            nextCursor = Buffer.from(JSON.stringify({ version: 1, signature, ...position } satisfies SearchCursor)).toString("base64url");
            exhausted = false;
            break;
          }
        }
        if (!exhausted || rows.length < 100) break;
      }
      if ((await this.#scope(callerConversationId, scope, context)).signature !== view.signature) throw new HistoryError(409, "history_scope_changed", "会话范围已变化，请重新检索。");
      return { matches, ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  async read(callerConversationId: number, input: HistoryReadInput, context: Context = BACKGROUND_CONTEXT): Promise<HistoryReadResult> {
    if (!input) throw new HistoryError(400, "invalid_history_input", "历史原文位置无效。");
    const entryId = number(input.entryId, "历史记录编号", 1);
    const target = input.conversationId === undefined ? callerConversationId : number(input.conversationId, "历史会话编号", 1);
    const offset = input.offset === undefined ? 0 : number(input.offset, "原文偏移", 0);
    const limit = input.limit === undefined ? 6000 : number(input.limit, "原文长度", 1, MAX_OUTPUT_CHARS);
    return this.#serial(async () => {
      const scope: HistoryScope = target === callerConversationId ? "conversation" : "project";
      const view = await this.#scope(callerConversationId, scope, context);
      const topic = view.topics.get(target);
      if (!topic) throw new HistoryError(403, "history_forbidden", "不能读取当前会话及所属项目以外的历史。");
      const entry = await this.#entry(await this.#conversation(target, context), entryId, context);
      const source = entry && historyEntryText(entry);
      if (!entry || !source) throw new HistoryError(404, "history_not_found", "历史原文不存在或不可回填。");
      if (offset > source.text.length) throw new HistoryError(400, "invalid_history_offset", "原文偏移超出记录长度。");
      if ((await this.#scope(callerConversationId, scope, context)).signature !== view.signature) throw new HistoryError(409, "history_scope_changed", "会话范围已变化，请重新读取。");
      const text = source.text.slice(offset, offset + limit);
      const nextOffset = offset + text.length;
      return { ...this.#source(target, entry, source, topic), text, offset, totalLength: source.text.length,
        ...(nextOffset < source.text.length ? { nextOffset } : {}), ...(source.attachments ? { attachments: source.attachments } : {}) };
    });
  }

  close(): Promise<void> {
    this.#closing ??= this.#tail.then(() => { this.#db.close(); });
    return this.#closing;
  }
}
