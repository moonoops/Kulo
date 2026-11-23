import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import type { ConnectorEventBatch, RawConnectorEvent } from "@kulo/protocol";

const SCHEMA_VERSION = 2;
const MAX_AUTOMATION_BACKUPS = 50;
const RAW_BODY_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const DEDUPE_WINDOW_MS = 30_000;
const SHORT_BODY_DEDUPE_WINDOW_MS = 5_000;
const SHORT_BODY_MAX_CHARS = 6;

export interface StoredAssistantEvent {
  id: string;
  envId: string;
  driverId: string;
  streamId: string;
  sourceEpoch: string;
  nativeEventId: string;
  eventVersion: string;
  appId: string;
  appLabel: string;
  threadHint?: string;
  sender?: string;
  title: string;
  subtitle?: string;
  body: string;
  occurredAt: number;
  receivedAt: number;
  snapshotRef?: string;
}

export interface HaSentinelStateRow {
  entityId: string;
  unavailableSince?: number;
  offlineAlertedAt?: number;
  lowBatteryAlertedAt?: number;
  doorOpenSince?: number;
  lastCameraTriageAt?: number;
  updatedAt: number;
}

export interface HaAutomationBackupRow {
  id: string;
  automationId: string;
  alias: string;
  previousConfigJson?: string;
  appliedConfigJson: string;
  createdAt: number;
}

export interface StoredAssistantDigest {
  id: string;
  createdAt: number;
  appId: string;
  appLabel: string;
  threadHint?: string;
  category: string;
  disposition: "noise" | "archive" | "notify_brain";
  urgency: "low" | "normal" | "high";
  digest: string;
  eventIds: string[];
  situationKey: string;
}

export interface AssistantLedgerOptions {
  stateDir: string;
  fileName?: string;
  rawBodyTtlMs?: number;
}

function normalizeForDedupe(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function computeDedupeKey(event: RawConnectorEvent): string {
  const bodyNorm = normalizeForDedupe(event.body).slice(0, 120);
  const senderNorm = normalizeForDedupe(event.sender ?? event.title).slice(0, 80);
  const threadPart = bodyNorm.length <= SHORT_BODY_MAX_CHARS ? normalizeForDedupe(event.threadHint ?? "") : "";
  return createHash("sha256")
    .update([event.appId.toLowerCase(), senderNorm, threadPart, bodyNorm].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

function buildFtsTrigramQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/"/g, "").trim())
    .filter((part) => part.length >= 3);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

export class AssistantLedger {
  readonly #dbPath: string;
  readonly #rawBodyTtlMs: number;
  #db: DatabaseSync | null = null;
  #serial: Promise<void> = Promise.resolve();
  #closed = false;
  #onWrite?: () => void;

  constructor(options: AssistantLedgerOptions) {
    const dir = path.resolve(options.stateDir);
    this.#dbPath = path.join(dir, options.fileName ?? "assistant.sqlite");
    this.#rawBodyTtlMs = options.rawBodyTtlMs ?? RAW_BODY_TTL_MS;
  }

  setOnWrite(hook: (() => void) | undefined): void {
    this.#onWrite = hook;
  }

  async backupTo(destPath: string): Promise<boolean> {
    return this.#enqueue(async () => {
      if (!fs.existsSync(this.#dbPath) && !this.#db) return false;
      const db = this.#open();
      await sqliteBackup(db, destPath, { rate: 256 });
      return true;
    });
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  #enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Assistant ledger is closed"));
    const next = this.#serial.then(fn, fn);
    this.#serial = next.then(() => undefined, () => undefined);
    return next;
  }

  #open(): DatabaseSync {
    if (this.#db) return this.#db;
    const dir = path.dirname(this.#dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.#dbPath)) {
      const st = fs.lstatSync(this.#dbPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error("Assistant ledger path must be a regular file");
      }
    } else {
      fs.closeSync(fs.openSync(this.#dbPath, "wx", 0o600));
    }
    const db = new DatabaseSync(this.#dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      PRAGMA foreign_keys = ON;
    `);
    try { fs.chmodSync(this.#dbPath, 0o600); } catch { /* ignore */ }

    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const currentVersion = Number(versionRow?.user_version ?? 0);
    if (currentVersion > SCHEMA_VERSION) {
      db.close();
      throw new Error(`Unsupported assistant.sqlite schema version ${currentVersion}`);
    }
    if (currentVersion < 1) {
      db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          env_id TEXT NOT NULL,
          driver_id TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          source_epoch TEXT NOT NULL,
          native_event_id TEXT NOT NULL,
          event_version TEXT NOT NULL,
          app_id TEXT NOT NULL,
          app_label TEXT NOT NULL,
          thread_hint TEXT,
          sender TEXT,
          title TEXT NOT NULL,
          subtitle TEXT,
          body TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          dedupe_key TEXT NOT NULL,
          body_pruned_at INTEGER,
          snapshot_ref TEXT,
          UNIQUE(stream_id, source_epoch, native_event_id, event_version)
        );
        CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events (dedupe_key, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_events_received ON events (received_at);

        CREATE TABLE IF NOT EXISTS digests (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          app_id TEXT NOT NULL,
          app_label TEXT NOT NULL,
          thread_hint TEXT,
          category TEXT NOT NULL,
          disposition TEXT NOT NULL,
          urgency TEXT NOT NULL,
          digest TEXT NOT NULL,
          event_ids_json TEXT NOT NULL,
          situation_key TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_digests_created ON digests (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_digests_situation ON digests (situation_key, created_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(
          digest_id UNINDEXED,
          digest,
          app_label,
          thread_hint,
          category,
          tokenize = 'trigram'
        );
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
    if (currentVersion < 2) {
      const eventCols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name?: string }>;
      const hasSnapshotRef = eventCols.some((col) => col.name === "snapshot_ref");
      db.exec(`
        BEGIN;
        ${hasSnapshotRef ? "" : "ALTER TABLE events ADD COLUMN snapshot_ref TEXT;"}
        CREATE TABLE IF NOT EXISTS ha_sentinel_state (
          entity_id TEXT PRIMARY KEY,
          unavailable_since INTEGER,
          offline_alerted_at INTEGER,
          low_battery_alerted_at INTEGER,
          door_open_since INTEGER,
          last_camera_triage_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ha_automation_backups (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          previous_config_json TEXT,
          applied_config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ha_auto_backups_created ON ha_automation_backups (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ha_auto_backups_auto_id ON ha_automation_backups (automation_id, created_at DESC);
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `);
    }
    this.#db = db;
    return db;
  }

  ingestBatch(
    envId: string,
    batch: ConnectorEventBatch,
    redact: (value: string) => string,
    now = Date.now(),
  ): Promise<{ inserted: StoredAssistantEvent[]; deduplicatedCount: number }> {
    return this.#enqueue(() => {
      const db = this.#open();
      const inserted: StoredAssistantEvent[] = [];
      let deduplicatedCount = 0;

      const checkExact = db.prepare(
        "SELECT id FROM events WHERE stream_id = ? AND source_epoch = ? AND native_event_id = ? AND event_version = ? LIMIT 1",
      );
      const checkCrossEnv = db.prepare(
        "SELECT id, env_id FROM events WHERE dedupe_key = ? AND occurred_at BETWEEN ? AND ? LIMIT 1",
      );
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO events (
          id, env_id, driver_id, stream_id, source_epoch, native_event_id, event_version,
          app_id, app_label, thread_hint, sender, title, subtitle, body,
          occurred_at, received_at, dedupe_key, snapshot_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec("BEGIN");
      try {
        for (const raw of batch.events) {
          const exact = checkExact.get(batch.streamId, batch.sourceEpoch, raw.nativeEventId, raw.eventVersion) as { id?: string } | undefined;
          if (exact?.id) {
            deduplicatedCount += 1;
            continue;
          }
          const title = redact(raw.title).slice(0, 1_000);
          const subtitle = raw.subtitle !== undefined ? redact(raw.subtitle).slice(0, 1_000) : undefined;
          const body = redact(raw.body).slice(0, 4_000);
          const sender = raw.sender !== undefined ? redact(raw.sender).slice(0, 256) : undefined;
          const threadHint = raw.threadHint !== undefined ? redact(raw.threadHint).slice(0, 256) : undefined;
          const appLabel = (raw.appLabel || raw.appId).slice(0, 200);
          const snapshotRef = typeof raw.snapshotRef === "string" && raw.snapshotRef.trim() ? raw.snapshotRef.trim().slice(0, 160) : undefined;
          const dedupeKey = computeDedupeKey({ ...raw, title, subtitle, body, sender, threadHint });
          const shortBody = normalizeForDedupe(body).length <= SHORT_BODY_MAX_CHARS;
          const windowMs = shortBody ? SHORT_BODY_DEDUPE_WINDOW_MS : DEDUPE_WINDOW_MS;
          const cross = checkCrossEnv.get(dedupeKey, raw.occurredAt - windowMs, raw.occurredAt + windowMs) as { id?: string; env_id?: string } | undefined;
          if (cross?.id && cross.env_id !== envId) {
            deduplicatedCount += 1;
            continue;
          }
          const id = `evt-${randomUUID()}`;
          const changes = insertStmt.run(
            id,
            envId,
            batch.driverId,
            batch.streamId,
            batch.sourceEpoch,
            raw.nativeEventId,
            raw.eventVersion,
            raw.appId,
            appLabel,
            threadHint ?? null,
            sender ?? null,
            title,
            subtitle ?? null,
            body,
            raw.occurredAt,
            now,
            dedupeKey,
            snapshotRef ?? null,
          ).changes;
          if (Number(changes) > 0) {
            inserted.push({
              id,
              envId,
              driverId: batch.driverId,
              streamId: batch.streamId,
              sourceEpoch: batch.sourceEpoch,
              nativeEventId: raw.nativeEventId,
              eventVersion: raw.eventVersion,
              appId: raw.appId,
              appLabel,
              ...(threadHint ? { threadHint } : {}),
              ...(sender ? { sender } : {}),
              title,
              ...(subtitle ? { subtitle } : {}),
              body,
              occurredAt: raw.occurredAt,
              receivedAt: now,
              ...(snapshotRef ? { snapshotRef } : {}),
            });
          } else {
            deduplicatedCount += 1;
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
      if (inserted.length > 0) this.#onWrite?.();
      return { inserted, deduplicatedCount };
    });
  }

  recordDigest(input: Omit<StoredAssistantDigest, "id">, redact: (value: string) => string): Promise<StoredAssistantDigest> {
    return this.#enqueue(() => {
      const db = this.#open();
      const id = `dig-${randomUUID()}`;
      const cleanDigest = redact(input.digest).slice(0, 400);
      const cleanThread = input.threadHint ? redact(input.threadHint).slice(0, 256) : undefined;
      const cleanCategory = input.category.slice(0, 64);
      const cleanSituationKey = redact(input.situationKey).slice(0, 160);
      db.exec("BEGIN");
      try {
        db.prepare(`
          INSERT INTO digests (
            id, created_at, app_id, app_label, thread_hint, category, disposition, urgency, digest, event_ids_json, situation_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          input.createdAt,
          input.appId,
          input.appLabel,
          cleanThread ?? null,
          cleanCategory,
          input.disposition,
          input.urgency,
          cleanDigest,
          JSON.stringify(input.eventIds),
          cleanSituationKey,
        );
        db.prepare(`
          INSERT INTO digests_fts (digest_id, digest, app_label, thread_hint, category)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, cleanDigest, input.appLabel, cleanThread ?? "", cleanCategory);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
      this.#onWrite?.();
      return {
        ...input,
        id,
        digest: cleanDigest,
        ...(cleanThread ? { threadHint: cleanThread } : {}),
        category: cleanCategory,
        situationKey: cleanSituationKey,
      };
    });
  }

  recentDigests(options: { sinceMs?: number; limit?: number; includeNoise?: boolean } = {}): Promise<{ items: StoredAssistantDigest[]; truncated: boolean }> {
    return this.#enqueue(() => {
      const db = this.#open();
      const sinceMs = options.sinceMs ?? 0;
      const limit = Math.max(1, Math.min(200, options.limit ?? 60));
      const rows = db.prepare(`
        SELECT id, created_at, app_id, app_label, thread_hint, category, disposition, urgency, digest, event_ids_json, situation_key
        FROM digests
        WHERE created_at >= ? ${options.includeNoise ? "" : "AND disposition != 'noise'"}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sinceMs, limit + 1) as Array<Record<string, unknown>>;
      const truncated = rows.length > limit;
      const items = rows.slice(0, limit).map(mapDigestRow);
      return { items, truncated };
    });
  }

  searchDigests(options: { query?: string; appId?: string; sinceMs?: number; limit?: number } = {}): Promise<StoredAssistantDigest[]> {
    return this.#enqueue(() => {
      const db = this.#open();
      const limit = Math.max(1, Math.min(50, options.limit ?? 20));
      const sinceMs = options.sinceMs ?? 0;
      const rawQuery = options.query?.trim() ?? "";
      const appFilter = options.appId?.trim() || undefined;

      if (!rawQuery) {
        const rows = db.prepare(`
          SELECT id, created_at, app_id, app_label, thread_hint, category, disposition, urgency, digest, event_ids_json, situation_key
          FROM digests
          WHERE created_at >= ? ${appFilter ? "AND (app_id = ? OR app_label = ?)" : ""}
          ORDER BY created_at DESC
          LIMIT ?
        `).all(...(appFilter ? [sinceMs, appFilter, appFilter, limit] : [sinceMs, limit])) as Array<Record<string, unknown>>;
        return rows.map(mapDigestRow);
      }

      const terms = rawQuery.split(/\s+/).filter(Boolean).slice(0, 6);
      const useFts = terms.every((term) => term.length >= 3);
      if (useFts) {
        const ftsExpr = buildFtsTrigramQuery(rawQuery);
        if (ftsExpr) {
          const rows = db.prepare(`
            SELECT d.id, d.created_at, d.app_id, d.app_label, d.thread_hint, d.category, d.disposition, d.urgency, d.digest, d.event_ids_json, d.situation_key
            FROM digests_fts f
            JOIN digests d ON d.id = f.digest_id
            WHERE digests_fts MATCH ? AND d.created_at >= ? ${appFilter ? "AND (d.app_id = ? OR d.app_label = ?)" : ""}
            ORDER BY d.created_at DESC
            LIMIT ?
          `).all(...(appFilter ? [ftsExpr, sinceMs, appFilter, appFilter, limit] : [ftsExpr, sinceMs, limit])) as Array<Record<string, unknown>>;
          return rows.map(mapDigestRow);
        }
      }

      // Trigram FTS5 cannot match 1-2 character terms (e.g. "开会"); fall back to exact substring instr().
      const clauses = terms.map(() => "(instr(lower(digest), ?) > 0 OR instr(lower(app_label), ?) > 0 OR instr(lower(COALESCE(thread_hint, '')), ?) > 0 OR instr(lower(category), ?) > 0)");
      const params: Array<string | number> = [sinceMs];
      for (const term of terms) {
        const lowered = term.toLowerCase();
        params.push(lowered, lowered, lowered, lowered);
      }
      if (appFilter) params.push(appFilter, appFilter);
      params.push(limit);

      const rows = db.prepare(`
        SELECT id, created_at, app_id, app_label, thread_hint, category, disposition, urgency, digest, event_ids_json, situation_key
        FROM digests
        WHERE created_at >= ? AND ${clauses.join(" AND ")} ${appFilter ? "AND (app_id = ? OR app_label = ?)" : ""}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...params) as Array<Record<string, unknown>>;
      return rows.map(mapDigestRow);
    });
  }

  readEventsByIds(eventIds: readonly string[], redact: (value: string) => string): Promise<StoredAssistantEvent[]> {
    return this.#enqueue(() => {
      const ids = [...new Set(eventIds.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
      if (ids.length === 0) return [];
      const db = this.#open();
      const placeholders = ids.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT id, env_id, driver_id, stream_id, source_epoch, native_event_id, event_version,
               app_id, app_label, thread_hint, sender, title, subtitle, body, occurred_at, received_at, snapshot_ref
        FROM events
        WHERE id IN (${placeholders})
        ORDER BY occurred_at ASC
      `).all(...ids) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        envId: String(row.env_id),
        driverId: String(row.driver_id),
        streamId: String(row.stream_id),
        sourceEpoch: String(row.source_epoch),
        nativeEventId: String(row.native_event_id),
        eventVersion: String(row.event_version),
        appId: String(row.app_id),
        appLabel: String(row.app_label),
        ...(typeof row.thread_hint === "string" ? { threadHint: redact(row.thread_hint) } : {}),
        ...(typeof row.sender === "string" ? { sender: redact(row.sender) } : {}),
        title: redact(String(row.title ?? "")),
        ...(typeof row.subtitle === "string" ? { subtitle: redact(row.subtitle) } : {}),
        body: redact(String(row.body ?? "")),
        occurredAt: Number(row.occurred_at),
        receivedAt: Number(row.received_at),
        ...(typeof row.snapshot_ref === "string" && row.snapshot_ref ? { snapshotRef: row.snapshot_ref } : {}),
      }));
    });
  }

  getAllHaSentinelStates(): Promise<HaSentinelStateRow[]> {
    return this.#enqueue(() => {
      const db = this.#open();
      const rows = db.prepare(`
        SELECT entity_id, unavailable_since, offline_alerted_at, low_battery_alerted_at,
               door_open_since, last_camera_triage_at, updated_at
        FROM ha_sentinel_state
      `).all() as Array<Record<string, unknown>>;
      return rows.map(mapHaSentinelStateRow);
    });
  }

  upsertHaSentinelState(state: HaSentinelStateRow): Promise<void> {
    return this.#enqueue(() => {
      const db = this.#open();
      db.prepare(`
        INSERT INTO ha_sentinel_state (
          entity_id, unavailable_since, offline_alerted_at, low_battery_alerted_at,
          door_open_since, last_camera_triage_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          unavailable_since = excluded.unavailable_since,
          offline_alerted_at = excluded.offline_alerted_at,
          low_battery_alerted_at = excluded.low_battery_alerted_at,
          door_open_since = excluded.door_open_since,
          last_camera_triage_at = excluded.last_camera_triage_at,
          updated_at = excluded.updated_at
      `).run(
        state.entityId,
        state.unavailableSince ?? null,
        state.offlineAlertedAt ?? null,
        state.lowBatteryAlertedAt ?? null,
        state.doorOpenSince ?? null,
        state.lastCameraTriageAt ?? null,
        state.updatedAt,
      );
      this.#onWrite?.();
    });
  }

  deleteHaSentinelState(entityId: string): Promise<void> {
    return this.#enqueue(() => {
      const db = this.#open();
      const res = db.prepare("DELETE FROM ha_sentinel_state WHERE entity_id = ?").run(entityId);
      if (Number(res.changes) > 0) this.#onWrite?.();
    });
  }

  recordHaAutomationBackup(input: {
    automationId: string;
    alias: string;
    previousConfigJson?: string;
    appliedConfigJson: string;
    now?: number;
  }): Promise<HaAutomationBackupRow> {
    return this.#enqueue(() => {
      const db = this.#open();
      const id = `habak-${randomUUID().slice(0, 12)}`;
      const createdAt = input.now ?? Date.now();
      db.exec("BEGIN");
      try {
        db.prepare(`
          INSERT INTO ha_automation_backups (
            id, automation_id, alias, previous_config_json, applied_config_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          id,
          input.automationId,
          input.alias.slice(0, 200),
          input.previousConfigJson ?? null,
          input.appliedConfigJson,
          createdAt,
        );
        // Keep only the latest 50 backups to prevent unbounded growth.
        db.prepare(`
          DELETE FROM ha_automation_backups
          WHERE id NOT IN (
            SELECT id FROM ha_automation_backups ORDER BY created_at DESC LIMIT ?
          )
        `).run(MAX_AUTOMATION_BACKUPS);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
      this.#onWrite?.();
      return {
        id,
        automationId: input.automationId,
        alias: input.alias.slice(0, 200),
        ...(input.previousConfigJson !== undefined ? { previousConfigJson: input.previousConfigJson } : {}),
        appliedConfigJson: input.appliedConfigJson,
        createdAt,
      };
    });
  }

  getHaAutomationBackup(options: { backupId?: string; automationId?: string } = {}): Promise<HaAutomationBackupRow | undefined> {
    return this.#enqueue(() => {
      const db = this.#open();
      let row: Record<string, unknown> | undefined;
      if (options.backupId) {
        row = db.prepare(`
          SELECT id, automation_id, alias, previous_config_json, applied_config_json, created_at
          FROM ha_automation_backups WHERE id = ? LIMIT 1
        `).get(options.backupId) as Record<string, unknown> | undefined;
      } else if (options.automationId) {
        row = db.prepare(`
          SELECT id, automation_id, alias, previous_config_json, applied_config_json, created_at
          FROM ha_automation_backups WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1
        `).get(options.automationId) as Record<string, unknown> | undefined;
      } else {
        row = db.prepare(`
          SELECT id, automation_id, alias, previous_config_json, applied_config_json, created_at
          FROM ha_automation_backups ORDER BY created_at DESC LIMIT 1
        `).get() as Record<string, unknown> | undefined;
      }
      return row ? mapHaAutomationBackupRow(row) : undefined;
    });
  }

  listHaAutomationBackups(limit = 20): Promise<HaAutomationBackupRow[]> {
    return this.#enqueue(() => {
      const db = this.#open();
      const bounded = Math.max(1, Math.min(MAX_AUTOMATION_BACKUPS, limit));
      const rows = db.prepare(`
        SELECT id, automation_id, alias, previous_config_json, applied_config_json, created_at
        FROM ha_automation_backups ORDER BY created_at DESC LIMIT ?
      `).all(bounded) as Array<Record<string, unknown>>;
      return rows.map(mapHaAutomationBackupRow);
    });
  }

  countDigestsSince(sinceMs: number): Promise<number> {
    return this.#enqueue(() => {
      const db = this.#open();
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM digests WHERE created_at >= ?").get(sinceMs) as { cnt?: number } | undefined;
      return Number(row?.cnt ?? 0);
    });
  }

  hasAnyRecords(): Promise<boolean> {
    return this.#enqueue(() => {
      if (!fs.existsSync(this.#dbPath)) return false;
      const db = this.#open();
      const row = db.prepare("SELECT 1 AS ok FROM digests LIMIT 1").get() as { ok?: number } | undefined;
      return Boolean(row?.ok);
    });
  }

  pruneExpiredBodies(now = Date.now()): Promise<number> {
    return this.#enqueue(() => {
      if (!fs.existsSync(this.#dbPath)) return 0;
      const db = this.#open();
      const cutoff = now - this.#rawBodyTtlMs;
      const res = db.prepare(
        "UPDATE events SET body = '', subtitle = NULL, snapshot_ref = NULL, body_pruned_at = ? WHERE body_pruned_at IS NULL AND received_at < ?",
      ).run(now, cutoff);
      const changes = Number(res.changes);
      if (changes > 0) this.#onWrite?.();
      return changes;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#serial.catch(() => {});
    if (this.#db) {
      try { this.#db.close(); } catch { /* ignore */ }
      this.#db = null;
    }
  }
}

function mapHaSentinelStateRow(row: Record<string, unknown>): HaSentinelStateRow {
  return {
    entityId: String(row.entity_id),
    ...(typeof row.unavailable_since === "number" ? { unavailableSince: row.unavailable_since } : {}),
    ...(typeof row.offline_alerted_at === "number" ? { offlineAlertedAt: row.offline_alerted_at } : {}),
    ...(typeof row.low_battery_alerted_at === "number" ? { lowBatteryAlertedAt: row.low_battery_alerted_at } : {}),
    ...(typeof row.door_open_since === "number" ? { doorOpenSince: row.door_open_since } : {}),
    ...(typeof row.last_camera_triage_at === "number" ? { lastCameraTriageAt: row.last_camera_triage_at } : {}),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function mapHaAutomationBackupRow(row: Record<string, unknown>): HaAutomationBackupRow {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    alias: String(row.alias ?? ""),
    ...(typeof row.previous_config_json === "string" ? { previousConfigJson: row.previous_config_json } : {}),
    appliedConfigJson: String(row.applied_config_json ?? "{}"),
    createdAt: Number(row.created_at ?? 0),
  };
}

function mapDigestRow(row: Record<string, unknown>): StoredAssistantDigest {
  let eventIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.event_ids_json ?? "[]")) as unknown;
    if (Array.isArray(parsed)) eventIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    eventIds = [];
  }
  const disp = String(row.disposition ?? "archive");
  const urgency = String(row.urgency ?? "low");
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    appId: String(row.app_id),
    appLabel: String(row.app_label),
    ...(typeof row.thread_hint === "string" ? { threadHint: row.thread_hint } : {}),
    category: String(row.category ?? "general"),
    disposition: disp === "noise" || disp === "notify_brain" ? disp : "archive",
    urgency: urgency === "high" || urgency === "normal" ? urgency : "low",
    digest: String(row.digest ?? ""),
    eventIds,
    situationKey: String(row.situation_key ?? ""),
  };
}
