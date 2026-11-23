/**
 * Local-first built-in memory SQLite store (`memory.sqlite`, Node 22 built-in `node:sqlite`).
 * Pure leaf module: zero `Harness` I/O; strict application-level dual-bank logical isolation.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import type {
  BuiltinMemoryCategory,
  BuiltinMemoryDurability,
  BuiltinMemoryEvidenceLevel,
  BuiltinMemoryScopeKind,
  BuiltinMemorySource,
  BuiltinMemoryStatus,
  MemoryBank,
} from "@kulo/protocol";
import { matchesForgottenTerm } from "./memory-forget.js";
import {
  blobToFloat32,
  buildSafeFtsMatchQuery,
  computeMemoryContentHash,
  dotProduct,
  extractMemoryIdentifiers,
  float32ToBlob,
  l2Normalize,
  normalizeMemoryText,
  rankAndFoldAuthorizedCandidates,
  tokenizeForMemoryFts,
  type BuiltinMemoryRecallHit,
  type ScorableMemoryRow,
} from "./builtin-memory-query.js";

export {
  buildSafeFtsMatchQuery,
  computeMemoryContentHash,
  extractMemoryIdentifiers,
  isChitchatRecallQuery,
  normalizeMemoryText,
  tokenizeForMemoryFts,
  type BuiltinMemoryRecallHit,
} from "./builtin-memory-query.js";

const SCHEMA_VERSION = 1;
const MAX_ACTIVE_PER_BANK = 5_000;
const FTS_CANDIDATE_LIMIT = 36;
const EXACT_CANDIDATE_LIMIT = 24;
const VECTOR_CANDIDATE_LIMIT = 36;
const VECTOR_MIN_COSINE = 0.52;

export class BuiltinMemoryStoreError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "INVALID_ARGUMENT" | "BLOCKED" | "CLOSED" | "UNSUPPORTED_SCHEMA" | "EPOCH_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "BuiltinMemoryStoreError";
  }
}

export interface BuiltinMemoryRetainInput {
  callerRole: "router" | "worker";
  bank: MemoryBank;
  scopeKind: BuiltinMemoryScopeKind;
  projectId?: string;
  topicId?: string;
  conversationId?: number;
  ticketId?: string;
  source: BuiltinMemorySource;
  sourceId: string;
  sourceEntryId?: number;
  evidenceLevel: BuiltinMemoryEvidenceLevel;
  category: BuiltinMemoryCategory;
  status?: BuiltinMemoryStatus;
  supersedesId?: string;
  durability?: BuiltinMemoryDurability;
  importance?: number;
  content: string;
  embedding?: Float32Array;
  embeddingModel?: string;
  expectedAppliedClearEpoch?: number;
  now?: number;
}

export interface BuiltinMemoryRetainResult {
  id: string;
  seq: number;
  inserted: boolean;
  bank: MemoryBank;
}

export interface BuiltinMemoryTopicLiveState {
  deleted: boolean;
  projectId?: string | null;
}

export interface BuiltinMemoryRecallScope {
  callerRole: "router" | "worker";
  bank: MemoryBank;
  projectId?: string;
  topicId?: string;
  scopeFilter?: BuiltinMemoryScopeKind;
  limit?: number;
  excludeIds?: ReadonlySet<string>;
  resolveTopicState?: (topicId: string) => BuiltinMemoryTopicLiveState | undefined;
  queryVector?: Float32Array;
  embeddingModel?: string;
  now?: number;
}

export interface BuiltinMemoryStoreOptions {
  stateDir: string;
  fileName?: string;
}

interface MemoryRow extends ScorableMemoryRow {
  seq: number;
  conversation_id: number | null;
  ticket_id: string | null;
  source: BuiltinMemorySource;
  source_id: string;
  source_entry_id: number | null;
  status: BuiltinMemoryStatus;
  supersedes_id: string | null;
  tokens_text: string;
  identifiers_text: string;
  embedding_model: string | null;
  last_accessed_at: number;
  access_count: number;
}

interface VectorEntry {
  id: string;
  model: string;
  vector: Float32Array;
}

export class BuiltinMemoryStore {
  readonly #dbPath: string;
  #db: DatabaseSync | null = null;
  #serial: Promise<void> = Promise.resolve();
  #closed = false;
  #onWrite?: () => void;
  #vectorCache: Record<MemoryBank, Map<string, VectorEntry> | null> = { private: null, shared: null };

  constructor(options: BuiltinMemoryStoreOptions) {
    this.#dbPath = path.join(path.resolve(options.stateDir), options.fileName ?? "memory.sqlite");
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  setOnWrite(hook: (() => void) | undefined): void {
    this.#onWrite = hook;
  }

  #enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#serial.then(async () => {
      if (this.#closed) throw new BuiltinMemoryStoreError("CLOSED", "内置记忆库已关闭。");
      return await work();
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Serializes maintenance work (e.g. startup secret scrub) on the store queue while memory.sqlite is closed. */
  runExclusiveUnopened<T>(work: () => Promise<T> | T): Promise<T> {
    return this.#enqueue(async () => {
      if (this.#db) {
        try { this.#db.close(); } catch { /* ignore */ }
        this.#db = null;
      }
      this.#vectorCache.private = null;
      this.#vectorCache.shared = null;
      return await work();
    });
  }

  #open(): DatabaseSync {
    if (this.#db) return this.#db;
    fs.mkdirSync(path.dirname(this.#dbPath), { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.#dbPath);
    const db = new DatabaseSync(this.#dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;");
    this.#migrate(db);
    if (!existed) {
      try { fs.chmodSync(this.#dbPath, 0o600); } catch { /* best-effort */ }
    }
    this.#db = db;
    return db;
  }

  #migrate(db: DatabaseSync): void {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const current = row?.value ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) {
      throw new BuiltinMemoryStoreError("UNSUPPORTED_SCHEMA", `Unsupported memory.sqlite schema version ${current}`);
    }
    if (current < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          bank TEXT NOT NULL CHECK (bank IN ('private', 'shared')),
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'topic')),
          project_id TEXT,
          topic_id TEXT,
          conversation_id INTEGER,
          ticket_id TEXT,
          source TEXT NOT NULL CHECK (source IN ('flush', 'tool', 'worklog', 'external_report')),
          source_id TEXT NOT NULL UNIQUE,
          source_entry_id INTEGER,
          evidence_level TEXT NOT NULL CHECK (evidence_level IN ('user_decision', 'assistant_proposal', 'external_reference', 'ticket_outcome')),
          category TEXT NOT NULL CHECK (category IN ('commitment', 'decision', 'fact', 'worklog')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'superseded')),
          supersedes_id TEXT,
          durability TEXT NOT NULL CHECK (durability IN ('permanent', 'temporary')),
          importance REAL NOT NULL DEFAULT 0.6,
          content TEXT NOT NULL,
          tokens_text TEXT NOT NULL,
          identifiers_text TEXT NOT NULL DEFAULT '',
          content_hash TEXT NOT NULL,
          embedding BLOB,
          embedding_model TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          CHECK ((bank = 'private' AND scope_kind IN ('global', 'project', 'topic')) OR (bank = 'shared' AND scope_kind = 'project' AND project_id IS NOT NULL AND length(project_id) > 0)),
          CHECK (scope_kind != 'topic' OR (topic_id IS NOT NULL AND length(topic_id) > 0)),
          CHECK (scope_kind != 'project' OR (project_id IS NOT NULL AND length(project_id) > 0))
        );
        CREATE INDEX IF NOT EXISTS idx_memories_bank_active ON memories(bank, status, project_id, scope_kind, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_embed_queue ON memories(embedding_model, updated_at DESC) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_memories_source_purge ON memories(topic_id, project_id, conversation_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, bank UNINDEXED, tokens_text, tokenize = 'unicode61 remove_diacritics 2');
      `);
      db.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES('secure-delete', 1);");
      const setMeta = db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)");
      setMeta.run("schema_version", String(SCHEMA_VERSION));
      setMeta.run("applied_clear_epoch", "0");
      setMeta.run("embedding_model", "");
      setMeta.run("embedding_dim", "0");
      setMeta.run("last_applied_seq", "0");
    } else {
      db.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES('secure-delete', 1);");
    }
  }

  #getMetaInt(db: DatabaseSync, key: string, fallback = 0): number {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
    const parsed = row?.value !== undefined ? Number(row.value) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }

  #setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  #ensureVectorCache(db: DatabaseSync, bank: MemoryBank): Map<string, VectorEntry> {
    if (this.#vectorCache[bank]) return this.#vectorCache[bank]!;
    const map = new Map<string, VectorEntry>();
    const rows = db
      .prepare("SELECT id, embedding, embedding_model FROM memories WHERE bank = ? AND status = 'active' AND embedding IS NOT NULL AND embedding_model IS NOT NULL")
      .all(bank) as Array<{ id: string; embedding: Uint8Array; embedding_model: string }>;
    for (const row of rows) {
      const vec = blobToFloat32(row.embedding);
      if (vec) map.set(row.id, { id: row.id, model: row.embedding_model, vector: vec });
    }
    this.#vectorCache[bank] = map;
    return map;
  }

  async getMetaSnapshot(): Promise<{ appliedClearEpoch: number; lastAppliedSeq: number; activePrivate: number; activeShared: number }> {
    return this.#enqueue(() => {
      if (!this.#db && !fs.existsSync(this.#dbPath)) {
        return { appliedClearEpoch: 0, lastAppliedSeq: 0, activePrivate: 0, activeShared: 0 };
      }
      const db = this.#open();
      const appliedClearEpoch = this.#getMetaInt(db, "applied_clear_epoch", 0);
      const lastAppliedSeq = this.#getMetaInt(db, "last_applied_seq", 0);
      const counts = db.prepare("SELECT bank, COUNT(*) AS cnt FROM memories WHERE status = 'active' GROUP BY bank").all() as Array<{ bank: MemoryBank; cnt: number }>;
      let activePrivate = 0;
      let activeShared = 0;
      for (const row of counts) {
        if (row.bank === "private") activePrivate = Number(row.cnt);
        else if (row.bank === "shared") activeShared = Number(row.cnt);
      }
      return { appliedClearEpoch, lastAppliedSeq, activePrivate, activeShared };
    });
  }

  async retain(input: BuiltinMemoryRetainInput): Promise<BuiltinMemoryRetainResult> {
    if (input.callerRole === "worker" && input.bank !== "shared") {
      throw new BuiltinMemoryStoreError("FORBIDDEN", "Worker 禁止写入个人私有记忆库。");
    }
    if (input.callerRole === "router" && input.bank !== "private") {
      throw new BuiltinMemoryStoreError("FORBIDDEN", "主脑禁止向项目共享记忆库写入内容。");
    }
    const projectId = input.projectId?.trim() || undefined;
    const topicId = input.topicId?.trim() || undefined;
    if (input.bank === "shared" && (!projectId || input.scopeKind !== "project")) {
      throw new BuiltinMemoryStoreError("FORBIDDEN", "项目共享记忆必须绑定具体项目。");
    }
    if (input.scopeKind === "project" && !projectId) throw new BuiltinMemoryStoreError("INVALID_ARGUMENT", "项目级记忆缺少 projectId。");
    if (input.scopeKind === "topic" && !topicId) throw new BuiltinMemoryStoreError("INVALID_ARGUMENT", "话题级记忆缺少 topicId。");
    const content = normalizeMemoryText(input.content);
    if (!content) throw new BuiltinMemoryStoreError("INVALID_ARGUMENT", "记忆内容不能为空。");
    const sourceId = input.sourceId.trim();
    if (!sourceId) throw new BuiltinMemoryStoreError("INVALID_ARGUMENT", "记忆来源标识不能为空。");

    const tokensText = tokenizeForMemoryFts(content).join(" ");
    const identifiersText = extractMemoryIdentifiers(content).join(" ");
    const contentHash = computeMemoryContentHash(content);
    const durability: BuiltinMemoryDurability =
      input.durability ?? (input.category === "commitment" || input.category === "decision" || input.scopeKind === "global" ? "permanent" : "temporary");
    const importance = Math.min(1, Math.max(0.1, input.importance ?? (durability === "permanent" ? 0.75 : 0.55)));
    const status: BuiltinMemoryStatus = input.status ?? "active";
    const normVec = input.embedding ? l2Normalize(input.embedding) : null;
    const embeddingBlob = normVec ? float32ToBlob(normVec) : null;
    const embeddingModel = normVec && input.embeddingModel ? input.embeddingModel : null;

    return this.#enqueue(() => {
      const db = this.#open();
      const now = input.now ?? Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          input.expectedAppliedClearEpoch !== undefined &&
          this.#getMetaInt(db, "applied_clear_epoch", 0) !== input.expectedAppliedClearEpoch
        ) {
          throw new BuiltinMemoryStoreError("EPOCH_MISMATCH", "内置记忆清空版本已变更，已放弃写入。");
        }
        const existing = db.prepare("SELECT id, seq, bank, content_hash FROM memories WHERE source_id = ?").get(sourceId) as
          | { id: string; seq: number; bank: MemoryBank; content_hash: string }
          | undefined;
        const findSupersedeTargets = (rawTargetId: string, excludeId?: string): Array<{ id: string }> => {
          const clean = rawTargetId.trim();
          if (!clean) return [];
          const flushPrefix = `flush:${clean}:`;
          const rows = db.prepare(`
            SELECT id FROM memories
            WHERE bank = ? AND status = 'active'
              AND (id = ? OR source_id = ? OR substr(source_id, 1, ?) = ?)
          `).all(input.bank, clean, clean, flushPrefix.length, flushPrefix) as Array<{ id: string }>;
          return excludeId ? rows.filter((row) => row.id !== excludeId) : rows;
        };

        let recordId: string;
        let seq: number;
        let inserted = false;
        let clearedStaleEmbedding = false;
        let mutated = false;
        if (existing) {
          if (existing.bank !== input.bank) {
            throw new BuiltinMemoryStoreError("FORBIDDEN", "禁止跨记忆库覆盖同源记忆记录。");
          }
          recordId = existing.id;
          const contentChanged = existing.content_hash !== contentHash;
          clearedStaleEmbedding = contentChanged && !embeddingBlob;
          db.prepare(`
            UPDATE memories SET scope_kind = ?, project_id = ?, topic_id = ?, conversation_id = ?, ticket_id = ?,
              evidence_level = ?, category = ?, status = ?, supersedes_id = ?, durability = ?, importance = ?,
              content = ?, tokens_text = ?, identifiers_text = ?, content_hash = ?,
              embedding = CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN NULL ELSE embedding END,
              embedding_model = CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN NULL ELSE embedding_model END,
              updated_at = ?, last_accessed_at = ?
            WHERE id = ?
          `).run(
            input.scopeKind, projectId ?? null, topicId ?? null, input.conversationId ?? null, input.ticketId ?? null,
            input.evidenceLevel, input.category, status, input.supersedesId ?? null, durability, importance,
            content, tokensText, identifiersText, contentHash,
            embeddingBlob, embeddingBlob, contentChanged ? 1 : 0,
            embeddingModel, embeddingModel, contentChanged ? 1 : 0,
            now, now, recordId,
          );
          db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(recordId);
          if (status === "active" && tokensText) {
            db.prepare("INSERT INTO memories_fts(memory_id, bank, tokens_text) VALUES(?, ?, ?)").run(recordId, input.bank, tokensText);
          }
          seq = existing.seq;
          mutated = true;
        } else if (status === "resolved") {
          const targets = input.supersedesId ? findSupersedeTargets(input.supersedesId) : [];
          for (const target of targets) {
            db.prepare("UPDATE memories SET status = 'resolved', updated_at = ? WHERE id = ?").run(now, target.id);
            db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(target.id);
            this.#vectorCache[input.bank]?.delete(target.id);
          }
          mutated = targets.length > 0;
          recordId = targets[0]?.id ?? "";
          seq = this.#getMetaInt(db, "last_applied_seq", 0);
        } else {
          recordId = randomUUID();
          const info = db.prepare(`
            INSERT INTO memories (
              id, bank, scope_kind, project_id, topic_id, conversation_id, ticket_id, source, source_id, source_entry_id,
              evidence_level, category, status, supersedes_id, durability, importance, content, tokens_text, identifiers_text,
              content_hash, embedding, embedding_model, created_at, updated_at, last_accessed_at, access_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `).run(
            recordId, input.bank, input.scopeKind, projectId ?? null, topicId ?? null, input.conversationId ?? null, input.ticketId ?? null,
            input.source, sourceId, input.sourceEntryId ?? null, input.evidenceLevel, input.category, status, input.supersedesId ?? null,
            durability, importance, content, tokensText, identifiersText, contentHash, embeddingBlob, embeddingModel, now, now, now,
          );
          seq = Number(info.lastInsertRowid);
          inserted = true;
          mutated = true;
          if (status === "active" && tokensText) {
            db.prepare("INSERT INTO memories_fts(memory_id, bank, tokens_text) VALUES(?, ?, ?)").run(recordId, input.bank, tokensText);
          }
        }

        if (input.supersedesId && (existing || status !== "resolved")) {
          const nextTargetStatus: BuiltinMemoryStatus = status === "resolved" ? "resolved" : "superseded";
          const targets = findSupersedeTargets(input.supersedesId, recordId || undefined);
          for (const target of targets) {
            db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(nextTargetStatus, now, target.id);
            db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(target.id);
            this.#vectorCache[input.bank]?.delete(target.id);
            mutated = true;
          }
        }

        this.#evictOverflowLocked(db, input.bank);
        if (seq > 0) {
          this.#setMeta(db, "last_applied_seq", String(Math.max(this.#getMetaInt(db, "last_applied_seq", 0), seq)));
        }
        db.exec("COMMIT");

        const cache = this.#vectorCache[input.bank];
        if (cache && recordId) {
          if (status === "active" && normVec && embeddingModel) cache.set(recordId, { id: recordId, model: embeddingModel, vector: normVec });
          else if (status !== "active" || clearedStaleEmbedding) cache.delete(recordId);
        }
        if (mutated) this.#onWrite?.();
        return { id: recordId, seq, inserted, bank: input.bank };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  #evictOverflowLocked(db: DatabaseSync, bank: MemoryBank): void {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM memories WHERE bank = ? AND status = 'active'").get(bank) as { cnt: number };
    const excess = Number(row.cnt) - MAX_ACTIVE_PER_BANK;
    if (excess <= 0) return;
    const victims = db.prepare(`
      SELECT id FROM memories WHERE bank = ? AND status = 'active'
      ORDER BY CASE durability WHEN 'temporary' THEN 0 ELSE 1 END ASC, access_count ASC, last_accessed_at ASC, updated_at ASC
      LIMIT ?
    `).all(bank, excess) as Array<{ id: string }>;
    const delRow = db.prepare("DELETE FROM memories WHERE id = ?");
    const delFts = db.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
    for (const v of victims) {
      delFts.run(v.id);
      delRow.run(v.id);
      this.#vectorCache[bank]?.delete(v.id);
    }
  }

  #isRowAuthorized(row: MemoryRow, scope: BuiltinMemoryRecallScope): { allowed: boolean; effectiveProjectId?: string } {
    if (row.bank !== scope.bank || row.status !== "active") return { allowed: false };
    if (scope.excludeIds?.has(row.id)) return { allowed: false };
    if (row.bank === "shared") {
      if (!row.project_id) return { allowed: false };
      if (scope.callerRole === "worker") {
        if (!scope.projectId || row.project_id !== scope.projectId) return { allowed: false };
      } else if (scope.scopeFilter === "project" || (scope.scopeFilter === undefined && scope.projectId)) {
        if (scope.projectId && row.project_id !== scope.projectId) return { allowed: false };
      }
      return { allowed: true, effectiveProjectId: row.project_id };
    }
    let effectiveProjectId = row.project_id ?? undefined;
    if (row.topic_id && scope.resolveTopicState) {
      const live = scope.resolveTopicState(row.topic_id);
      if (live?.deleted) return { allowed: false };
      if (live !== undefined) effectiveProjectId = live.projectId ?? undefined;
    }
    if (scope.scopeFilter === "global") {
      return row.scope_kind === "global" ? { allowed: true, effectiveProjectId } : { allowed: false };
    }
    if (scope.scopeFilter === "topic") {
      return row.scope_kind === "topic" && scope.topicId && row.topic_id === scope.topicId ? { allowed: true, effectiveProjectId } : { allowed: false };
    }
    if (scope.scopeFilter === "project") {
      return row.scope_kind !== "global" && scope.projectId && effectiveProjectId === scope.projectId ? { allowed: true, effectiveProjectId } : { allowed: false };
    }
    if (row.scope_kind === "global") return { allowed: true, effectiveProjectId };
    if (row.scope_kind === "project") {
      if (!scope.projectId && !scope.topicId) return { allowed: true, effectiveProjectId };
      return scope.projectId && effectiveProjectId === scope.projectId ? { allowed: true, effectiveProjectId } : { allowed: false };
    }
    // scope_kind === "topic"
    if (!scope.projectId && !scope.topicId) return { allowed: true, effectiveProjectId };
    return scope.topicId && row.topic_id === scope.topicId ? { allowed: true, effectiveProjectId } : { allowed: false };
  }

  #buildAuthSqlFilter(scope: BuiltinMemoryRecallScope, alias = "m"): { clause: string; params: Array<string | number>; impossible?: boolean } {
    const params: Array<string | number> = [];
    if (scope.bank === "shared") {
      if (scope.callerRole === "worker" || scope.scopeFilter === "project" || (scope.scopeFilter === undefined && scope.projectId)) {
        if (!scope.projectId) return { clause: "1 = 0", params, impossible: true };
        params.push(scope.projectId);
        return { clause: `${alias}.project_id = ?`, params };
      }
      return { clause: `${alias}.project_id IS NOT NULL`, params };
    }
    if (scope.scopeFilter === "global") return { clause: `${alias}.scope_kind = 'global'`, params };
    if (scope.scopeFilter === "topic") {
      if (!scope.topicId) return { clause: "1 = 0", params, impossible: true };
      params.push(scope.topicId);
      return { clause: `${alias}.scope_kind = 'topic' AND ${alias}.topic_id = ?`, params };
    }
    if (scope.scopeFilter === "project") {
      if (!scope.projectId) return { clause: "1 = 0", params, impossible: true };
      params.push(scope.projectId);
      return { clause: `${alias}.scope_kind IN ('project', 'topic') AND ${alias}.project_id = ?`, params };
    }
    if (!scope.projectId && !scope.topicId) return { clause: "1 = 1", params };
    const branches: string[] = [`${alias}.scope_kind = 'global'`];
    if (scope.projectId) {
      branches.push(`(${alias}.scope_kind = 'project' AND ${alias}.project_id = ?)`);
      params.push(scope.projectId);
    }
    if (scope.topicId) {
      branches.push(`(${alias}.scope_kind = 'topic' AND ${alias}.topic_id = ?)`);
      params.push(scope.topicId);
    }
    return { clause: `(${branches.join(" OR ")})`, params };
  }

  async recall(query: string, scope: BuiltinMemoryRecallScope): Promise<BuiltinMemoryRecallHit[]> {
    if (scope.callerRole === "worker" && scope.bank !== "shared") throw new BuiltinMemoryStoreError("FORBIDDEN", "Worker 禁止读取个人私有记忆库。");
    if (scope.callerRole === "worker" && !scope.projectId) throw new BuiltinMemoryStoreError("FORBIDDEN", "非项目独立任务禁止访问共享项目记忆库。");
    if (scope.bank === "shared" && scope.scopeFilter === "project" && !scope.projectId) throw new BuiltinMemoryStoreError("INVALID_ARGUMENT", "未绑定项目时不能按 project 作用域检索共享记忆。");
    const cleanQuery = normalizeMemoryText(query);
    if (!cleanQuery) return [];
    const limit = Math.min(20, Math.max(1, scope.limit ?? 6));

    return this.#enqueue(() => {
      if (!this.#db && !fs.existsSync(this.#dbPath)) return [];
      const db = this.#open();
      const now = scope.now ?? Date.now();
      const authSql = this.#buildAuthSqlFilter(scope, "m");
      if (authSql.impossible) return [];

      const ftsRankMap = new Map<string, number>();
      const rowById = new Map<string, MemoryRow>();
      const effectiveProjectById = new Map<string, string | undefined>();
      const ftsMatch = buildSafeFtsMatchQuery(cleanQuery);
      if (ftsMatch) {
        const sql = `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id WHERE memories_fts MATCH ? AND m.bank = ? AND m.status = 'active' AND ${authSql.clause} ORDER BY bm25(memories_fts) ASC LIMIT ?`;
        const rows = db.prepare(sql).all(ftsMatch, scope.bank, ...authSql.params, FTS_CANDIDATE_LIMIT * 2) as unknown as MemoryRow[];
        let rank = 0;
        for (const row of rows) {
          const auth = this.#isRowAuthorized(row, scope);
          if (!auth.allowed) continue;
          rank += 1;
          ftsRankMap.set(row.id, rank);
          rowById.set(row.id, row);
          effectiveProjectById.set(row.id, auth.effectiveProjectId);
          if (rank >= FTS_CANDIDATE_LIMIT) break;
        }
      }

      const queryIdentifiers = extractMemoryIdentifiers(cleanQuery, 12);
      const exactHitIds = new Set<string>();
      if (queryIdentifiers.length > 0) {
        const identClauses: string[] = [];
        const identParams: Array<string | number> = [];
        for (const ident of queryIdentifiers) {
          if (ident.length >= 4) {
            identClauses.push("(instr(' ' || m.identifiers_text || ' ', ?) > 0 OR instr(lower(m.content), ?) > 0)");
            identParams.push(` ${ident} `, ident);
          } else {
            identClauses.push("instr(' ' || m.identifiers_text || ' ', ?) > 0");
            identParams.push(` ${ident} `);
          }
        }
        const sql = `SELECT m.* FROM memories m WHERE m.bank = ? AND m.status = 'active' AND ${authSql.clause} AND (${identClauses.join(" OR ")}) ORDER BY m.updated_at DESC LIMIT ?`;
        const rows = db.prepare(sql).all(scope.bank, ...authSql.params, ...identParams, EXACT_CANDIDATE_LIMIT * 2) as unknown as MemoryRow[];
        let exactCount = 0;
        for (const row of rows) {
          const auth = this.#isRowAuthorized(row, scope);
          if (!auth.allowed) continue;
          const idTokens = row.identifiers_text ? new Set(row.identifiers_text.split(" ")) : undefined;
          const lowerContent = row.content.toLocaleLowerCase("en-US");
          if (!queryIdentifiers.some((ident) => (idTokens?.has(ident) ?? false) || (ident.length >= 4 && lowerContent.includes(ident)))) continue;
          exactHitIds.add(row.id);
          rowById.set(row.id, row);
          effectiveProjectById.set(row.id, auth.effectiveProjectId);
          exactCount += 1;
          if (exactCount >= EXACT_CANDIDATE_LIMIT) break;
        }
      }

      const vecRankMap = new Map<string, number>();
      if (scope.queryVector && scope.embeddingModel) {
        const normQuery = l2Normalize(scope.queryVector);
        if (normQuery) {
          const cache = this.#ensureVectorCache(db, scope.bank);
          const scoredVec: Array<{ id: string; cos: number }> = [];
          for (const entry of cache.values()) {
            if (entry.model !== scope.embeddingModel || scope.excludeIds?.has(entry.id)) continue;
            const cos = dotProduct(normQuery, entry.vector);
            if (cos >= VECTOR_MIN_COSINE) scoredVec.push({ id: entry.id, cos });
          }
          scoredVec.sort((a, b) => b.cos - a.cos);
          const fetchRow = db.prepare("SELECT * FROM memories WHERE id = ? AND bank = ? AND status = 'active'");
          let rank = 0;
          for (const cand of scoredVec) {
            let row = rowById.get(cand.id);
            if (!row) {
              const fetched = fetchRow.get(cand.id, scope.bank) as unknown as MemoryRow | undefined;
              if (!fetched) continue;
              const auth = this.#isRowAuthorized(fetched, scope);
              if (!auth.allowed) continue;
              row = fetched;
              rowById.set(row.id, row);
              effectiveProjectById.set(row.id, auth.effectiveProjectId);
            }
            rank += 1;
            vecRankMap.set(row.id, rank);
            if (rank >= VECTOR_CANDIDATE_LIMIT) break;
          }
        }
      }

      if (rowById.size === 0) return [];
      const selected = rankAndFoldAuthorizedCandidates({
        rows: rowById.values(),
        ftsRankMap,
        vecRankMap,
        exactHitIds,
        effectiveProjectById,
        callerRole: scope.callerRole,
        bank: scope.bank,
        projectId: scope.projectId,
        topicId: scope.topicId,
        limit,
        now,
      });
      const touch = db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
      for (const hit of selected) touch.run(now, hit.id);
      return selected;
    });
  }

  async clearAll(targetEpoch: number): Promise<{ removedRecords: number; appliedClearEpoch: number }> {
    return this.#enqueue(() => {
      const db = this.#open();
      let removedRecords = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        removedRecords = Number((db.prepare("SELECT COUNT(*) AS cnt FROM memories").get() as { cnt: number }).cnt);
        db.exec("DELETE FROM memories_fts; DELETE FROM memories;");
        const nextEpoch = Math.max(this.#getMetaInt(db, "applied_clear_epoch", 0), targetEpoch);
        this.#setMeta(db, "applied_clear_epoch", String(nextEpoch));
        this.#setMeta(db, "last_applied_seq", "0");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec("VACUUM;");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      this.#vectorCache.private = null;
      this.#vectorCache.shared = null;
      this.#onWrite?.();
      return { removedRecords, appliedClearEpoch: this.#getMetaInt(db, "applied_clear_epoch", targetEpoch) };
    });
  }

  async forgetPrivateTerm(term: string): Promise<{ removedRecords: number; removedIds: string[] }> {
    return this.#enqueue(() => {
      if (!this.#db && !fs.existsSync(this.#dbPath)) return { removedRecords: 0, removedIds: [] };
      const db = this.#open();
      const rows = db.prepare("SELECT id, content FROM memories WHERE bank = 'private'").all() as Array<{ id: string; content: string }>;
      const matchedIds = rows.filter((row) => matchesForgottenTerm(row.content, term)).map((row) => row.id);
      if (matchedIds.length === 0) return { removedRecords: 0, removedIds: [] };
      db.exec("BEGIN IMMEDIATE");
      try {
        const delFts = db.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
        const delMem = db.prepare("DELETE FROM memories WHERE id = ?");
        for (const id of matchedIds) {
          delFts.run(id);
          delMem.run(id);
          this.#vectorCache.private?.delete(id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      this.#onWrite?.();
      return { removedRecords: matchedIds.length, removedIds: matchedIds };
    });
  }

  async purgeScope(scope: { topicId?: string; projectId?: string; conversationIds?: readonly number[] }): Promise<{ removedRecords: number; removedIds: string[] }> {
    return this.#enqueue(() => {
      if (!this.#db && !fs.existsSync(this.#dbPath)) return { removedRecords: 0, removedIds: [] };
      const db = this.#open();
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (scope.topicId) { clauses.push("topic_id = ?"); params.push(scope.topicId); }
      if (scope.projectId) { clauses.push("project_id = ?"); params.push(scope.projectId); }
      if (scope.conversationIds?.length) {
        clauses.push(`conversation_id IN (${scope.conversationIds.map(() => "?").join(", ")})`);
        params.push(...scope.conversationIds);
      }
      if (clauses.length === 0) return { removedRecords: 0, removedIds: [] };
      const targets = db.prepare(`SELECT id, bank FROM memories WHERE ${clauses.join(" OR ")}`).all(...params) as Array<{ id: string; bank: MemoryBank }>;
      if (targets.length === 0) return { removedRecords: 0, removedIds: [] };
      db.exec("BEGIN IMMEDIATE");
      try {
        const delFts = db.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
        const delMem = db.prepare("DELETE FROM memories WHERE id = ?");
        for (const row of targets) {
          delFts.run(row.id);
          delMem.run(row.id);
          this.#vectorCache[row.bank]?.delete(row.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      this.#onWrite?.();
      return { removedRecords: targets.length, removedIds: targets.map((t) => t.id) };
    });
  }

  async reassignTopicProject(topicId: string, nextProjectId: string | null): Promise<number> {
    return this.#enqueue(() => {
      if (!this.#db && !fs.existsSync(this.#dbPath)) return 0;
      const db = this.#open();
      const info = db
        .prepare("UPDATE memories SET project_id = ?, scope_kind = CASE WHEN ? IS NULL AND scope_kind = 'project' THEN 'topic' ELSE scope_kind END WHERE bank = 'private' AND topic_id = ?")
        .run(nextProjectId, nextProjectId, topicId);
      const changed = Number(info.changes ?? 0);
      if (changed > 0) this.#onWrite?.();
      return changed;
    });
  }

  /** Rebinds stored private memories from an archived root conversation to its new archived topicId. */
  async rebindConversationTopic(conversationId: number, fromTopicId: string, toTopicId: string): Promise<number> {
    return this.#enqueue(() => {
      if (!this.#db && !fs.existsSync(this.#dbPath)) return 0;
      const db = this.#open();
      const info = db
        .prepare("UPDATE memories SET topic_id = ? WHERE conversation_id = ? AND topic_id = ?")
        .run(toTopicId, conversationId, fromTopicId);
      const changed = Number(info.changes ?? 0);
      if (changed > 0) this.#onWrite?.();
      return changed;
    });
  }

  async backupTo(destPath: string): Promise<boolean> {
    return this.#enqueue(async () => {
      if (!fs.existsSync(this.#dbPath) && !this.#db) return false;
      const db = this.#open();
      await sqliteBackup(db, destPath, { rate: 256 });
      return true;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#serial;
    if (this.#db) {
      try { this.#db.close(); } catch { /* ignore */ }
      this.#db = null;
    }
    this.#vectorCache.private = null;
    this.#vectorCache.shared = null;
  }
}
