import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import {
  CONNECTOR_MAX_BATCH_BYTES,
  CONNECTOR_MAX_BATCH_EVENTS,
  CONNECTOR_MAX_TEXT_CHARS,
  isSensitiveNotificationPayload,
  type ConnectorBatchAck,
  type ConnectorEventBatch,
  type ConnectorPermissionState,
  type ConnectorSourceConfig,
  type ConnectorSourceStatus,
  type RawConnectorEvent,
} from "@kulo/protocol";
import { extractNotificationPlist } from "./bplist.js";

const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;
const DEFAULT_POLL_MS = 4_000;
const REJECT_BACKOFF_MS = 15_000;
const WATCH_DEBOUNCE_MS = 400;

interface StoredCursor {
  sourceEpoch: string;
  lastRecId: number;
  updatedAt: number;
}

interface CursorFile {
  version: 1;
  cursors: Record<string, StoredCursor>;
}

interface NotificationRow {
  recId: number;
  appIdentifier: string;
  deliveredDate: number | null;
  data: Uint8Array;
}

export interface MacOsNotificationSensorOptions {
  envId: string;
  envName: string;
  privateDir: string;
  platform?: NodeJS.Platform;
  databasePath?: string;
  pollIntervalMs?: number;
  onStatus: (status: ConnectorSourceStatus) => void;
  onBatch: (batch: ConnectorEventBatch) => void;
}

const KNOWN_APP_LABELS: Readonly<Record<string, string>> = {
  "com.tencent.xinWeChat": "微信",
  "com.tencent.qq": "QQ",
  "com.tencent.WeWorkMac": "企业微信",
  "com.alibaba.DingTalkMac": "钉钉",
  "com.electron.lark": "飞书",
  "com.bytedance.feishu": "飞书",
  "com.readdle.SparkDesktop": "Spark",
  "com.readdle.SparkDesktop.appstore": "Spark",
  "com.apple.mail": "邮件",
  "com.apple.MobileSMS": "信息",
  "com.apple.iCal": "日历",
  "com.apple.reminders": "提醒事项",
  "com.tinyspeck.slackmacgap": "Slack",
  "ru.keepcoder.Telegram": "Telegram",
  "com.hnc.Discord": "Discord",
  "com.google.antigravity": "Antigravity",
  "com.todesktop.230313mzl4w4u92": "Cursor",
};

export function friendlyAppLabel(appId: string): string {
  const known = KNOWN_APP_LABELS[appId];
  if (known) return known;
  const parts = appId.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? appId;
}

export function resolveMacOsNotificationDbPath(options: { homeDir?: string; tmpDir?: string } = {}): string {
  const homeDir = options.homeDir ?? os.homedir();
  const sequoiaPath = path.join(homeDir, "Library", "Group Containers", "group.com.apple.usernoted", "db2", "db");
  if (fs.existsSync(sequoiaPath)) return sequoiaPath;
  const rawTmp = options.tmpDir ?? process.env.TMPDIR;
  if (rawTmp) {
    const cleanTmp = path.resolve(rawTmp);
    if (path.basename(cleanTmp) === "T") {
      const legacyPath = path.join(path.dirname(cleanTmp), "0", "com.apple.notificationcenter", "db2", "db");
      if (fs.existsSync(legacyPath)) return legacyPath;
    }
  }
  return sequoiaPath;
}

function appleTimestampToMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallbackMs;
  const seconds = raw > 1e11 ? raw / 1e9 : raw;
  const ms = Math.round(APPLE_EPOCH_OFFSET_MS + seconds * 1000);
  if (!Number.isSafeInteger(ms) || ms < 946_684_800_000 || ms > 4_102_444_800_000) return fallbackMs;
  return ms;
}

function errnoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

function isPermissionError(error: unknown): boolean {
  const code = errnoCode(error);
  if (code === "EACCES" || code === "EPERM") return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return msg.includes("operation not permitted") || msg.includes("permission denied") || msg.includes("unable to open database");
}

function isSchemaCompatible(db: DatabaseSync): boolean {
  const recordCols = new Set(
    (db.prepare("PRAGMA table_info('record')").all() as Array<{ name?: unknown }>)
      .map((row) => (typeof row.name === "string" ? row.name : "")),
  );
  const appCols = new Set(
    (db.prepare("PRAGMA table_info('app')").all() as Array<{ name?: unknown }>)
      .map((row) => (typeof row.name === "string" ? row.name : "")),
  );
  return recordCols.has("rec_id") &&
    recordCols.has("app_id") &&
    recordCols.has("data") &&
    appCols.has("app_id") &&
    appCols.has("identifier");
}

export class MacOsNotificationSensor {
  readonly #options: MacOsNotificationSensorOptions;
  readonly #platform: NodeJS.Platform;
  readonly #connectorsDir: string;
  readonly #cursorFilePath: string;
  readonly #pollIntervalMs: number;

  #hubId = "default";
  #enabled = false;
  #mutedApps = new Set<string>();
  #permission: ConnectorPermissionState = "unavailable";
  #lastEventAt?: number;
  #lastError?: string;
  #cursors: Record<string, StoredCursor> = {};
  #inFlight: { batchId: string; streamId: string; sourceEpoch: string; cursorAfter: number } | null = null;
  #watcher: fs.FSWatcher | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #debounceTimer: NodeJS.Timeout | null = null;
  #backoffUntil = 0;
  #scanning = false;
  #closed = false;

  constructor(options: MacOsNotificationSensorOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#connectorsDir = path.join(options.privateDir, "connectors");
    this.#cursorFilePath = path.join(this.#connectorsDir, "cursors.json");
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.#loadCursors();
    if (this.#platform === "darwin") {
      this.#permission = this.#probePermissionOnly();
    }
  }

  get status(): ConnectorSourceStatus {
    return {
      driverId: "macos-notifications",
      envId: this.#options.envId,
      envName: this.#options.envName,
      platform: this.#platform,
      enabled: this.#enabled,
      permission: this.#permission,
      mutedApps: [...this.#mutedApps].sort(),
      ...(this.#lastEventAt !== undefined ? { lastEventAt: this.#lastEventAt } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  setHubIdentity(hubId: string): void {
    const normalized = hubId.trim();
    if (!normalized || normalized === this.#hubId) return;
    this.#hubId = normalized;
    this.#inFlight = null;
  }

  configure(config: ConnectorSourceConfig): void {
    if (this.#closed || config.driverId !== "macos-notifications") return;
    this.#mutedApps = new Set(config.mutedApps.map((item) => item.trim()).filter(Boolean));
    const wasEnabled = this.#enabled;
    this.#enabled = config.enabled && this.#platform === "darwin";
    this.#backoffUntil = 0;
    if (!this.#enabled) {
      this.#stopLoop();
      this.#inFlight = null;
      this.#lastError = undefined;
      if (this.#platform === "darwin") {
        this.#permission = this.#probePermissionOnly();
      }
      this.#emitStatus();
      return;
    }
    if (!wasEnabled) {
      this.#inFlight = null;
    }
    this.#startLoop();
    void this.scanNow();
  }

  handleAck(ack: ConnectorBatchAck): void {
    if (this.#closed || ack.driverId !== "macos-notifications") return;
    if (!this.#inFlight || this.#inFlight.batchId !== ack.batchId) return;
    const inflight = this.#inFlight;
    this.#inFlight = null;
    if (ack.status === "accepted") {
      if (ack.streamId === inflight.streamId && ack.sourceEpoch === inflight.sourceEpoch) {
        this.#saveCursor(inflight.sourceEpoch, inflight.cursorAfter);
        this.#backoffUntil = 0;
        // Immediately check if more notifications accumulated while in-flight.
        void this.scanNow();
      }
      return;
    }
    this.#backoffUntil = Date.now() + REJECT_BACKOFF_MS;
    this.#lastError = ack.code ? `批次被拒 (${ack.code})` : "批次被中枢拒绝";
    this.#emitStatus();
  }

  async scanNow(): Promise<void> {
    if (this.#closed || !this.#enabled || this.#scanning || this.#inFlight) return;
    if (Date.now() < this.#backoffUntil) return;
    this.#scanning = true;
    try {
      await this.#runScan();
    } finally {
      this.#scanning = false;
    }
  }

  close(): void {
    this.#closed = true;
    this.#stopLoop();
    this.#inFlight = null;
  }

  #cursorKey(): string {
    return `${this.#hubId}\0${this.#options.envId}\0macos-notifications`;
  }

  #streamId(): string {
    return `macos-notifications:${this.#options.envId}`;
  }

  #dbPath(): string {
    return this.#options.databasePath ?? resolveMacOsNotificationDbPath();
  }

  #loadCursors(): void {
    try {
      if (!fs.existsSync(this.#cursorFilePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.#cursorFilePath, "utf8")) as Partial<CursorFile>;
      if (parsed?.version !== 1 || !parsed.cursors || typeof parsed.cursors !== "object") return;
      this.#cursors = parsed.cursors;
    } catch {
      this.#cursors = {};
    }
  }

  #saveCursor(sourceEpoch: string, lastRecId: number): void {
    this.#cursors[this.#cursorKey()] = {
      sourceEpoch,
      lastRecId,
      updatedAt: Date.now(),
    };
    try {
      fs.mkdirSync(this.#connectorsDir, { recursive: true, mode: 0o700 });
      const tmpPath = `${this.#cursorFilePath}.tmp-${process.pid}`;
      const payload: CursorFile = { version: 1, cursors: this.#cursors };
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, this.#cursorFilePath);
    } catch {
      // Best-effort persistence; next ack retries cleanly.
    }
  }

  #probePermissionOnly(): ConnectorPermissionState {
    if (this.#platform !== "darwin") return "unavailable";
    const dbPath = this.#dbPath();
    try {
      const stat = fs.statSync(dbPath);
      if (!stat.isFile()) return "unsupported_schema";
    } catch (error) {
      return errnoCode(error) === "ENOENT" ? "database_missing" : "full_disk_access_required";
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;");
      return isSchemaCompatible(db) ? "granted" : "unsupported_schema";
    } catch (error) {
      return isPermissionError(error) ? "full_disk_access_required" : "error";
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  async #withReadableDb<T>(fn: (db: DatabaseSync, stat: fs.Stats) => T): Promise<T> {
    const dbPath = this.#dbPath();
    const stat = fs.statSync(dbPath);
    if (!stat.isFile()) {
      throw Object.assign(new Error("Notification database path is not a regular file"), { kuloPermission: "unsupported_schema" as const });
    }
    let direct: DatabaseSync | null = null;
    try {
      direct = new DatabaseSync(dbPath, { readOnly: true });
      direct.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;");
      direct.exec("BEGIN");
      try {
        const result = fn(direct, stat);
        direct.exec("COMMIT");
        return result;
      } catch (inner) {
        try { direct.exec("ROLLBACK"); } catch { /* ignore */ }
        throw inner;
      }
    } catch (directError) {
      try { direct?.close(); } catch { /* ignore */ }
      direct = null;
      // Fallback: when readOnly WAL mapping cannot create -shm in a read-only dir,
      // attempt SQLite online backup into Env's protected private directory and remove immediately.
      const errMsg = directError instanceof Error ? directError.message.toLowerCase() : "";
      const shouldFallbackBackup = errMsg.includes("readonly") || errMsg.includes("shm") || errMsg.includes("disk i/o");
      if (!shouldFallbackBackup) throw directError;
      fs.mkdirSync(this.#connectorsDir, { recursive: true, mode: 0o700 });
      const snapPath = path.join(this.#connectorsDir, `usernoted-snap-${randomUUID()}.db`);
      let source: DatabaseSync | null = null;
      let snap: DatabaseSync | null = null;
      try {
        source = new DatabaseSync(dbPath, { readOnly: true });
        await backup(source, snapPath);
        snap = new DatabaseSync(snapPath, { readOnly: true });
        snap.exec("PRAGMA query_only = ON;");
        return fn(snap, stat);
      } finally {
        try { snap?.close(); } catch { /* ignore */ }
        try { source?.close(); } catch { /* ignore */ }
        for (const suffix of ["", "-wal", "-shm"]) {
          try { fs.rmSync(`${snapPath}${suffix}`, { force: true }); } catch { /* ignore */ }
        }
      }
    } finally {
      try { direct?.close(); } catch { /* ignore */ }
    }
  }

  async #runScan(): Promise<void> {
    const prevPermission = this.#permission;
    const prevError = this.#lastError;
    let scanResult: {
      sourceEpoch: string;
      maxRecId: number;
      rows: NotificationRow[];
      resetBaseline: boolean;
      gapDetected: boolean;
    };
    try {
      scanResult = await this.#withReadableDb((db, stat) => {
        if (!isSchemaCompatible(db)) {
          throw Object.assign(new Error("Unsupported macOS notification database schema"), { kuloPermission: "unsupported_schema" as const });
        }
        const bounds = db.prepare("SELECT COALESCE(MIN(rec_id), 0) AS minId, COALESCE(MAX(rec_id), 0) AS maxId FROM record").get() as {
          minId?: number;
          maxId?: number;
        };
        const minRecId = Number(bounds.minId ?? 0);
        const maxRecId = Number(bounds.maxId ?? 0);
        const sourceEpoch = `${stat.dev}:${stat.ino}:${minRecId}`;
        const saved = this.#cursors[this.#cursorKey()];

        if (!saved) {
          return { sourceEpoch, maxRecId, rows: [], resetBaseline: true, gapDetected: false };
        }
        let afterRecId = saved.lastRecId;
        let gapDetected = false;
        if (saved.sourceEpoch !== sourceEpoch || maxRecId < saved.lastRecId) {
          // Database rotated or cleared: avoid historical storm by starting from max - 20 at most.
          afterRecId = Math.max(0, maxRecId - 20);
          gapDetected = true;
        }
        if (maxRecId <= afterRecId) {
          return { sourceEpoch, maxRecId, rows: [], resetBaseline: false, gapDetected: false };
        }

        const hasDeliveredDate = (db.prepare("PRAGMA table_info('record')").all() as Array<{ name?: string }>)
          .some((col) => col.name === "delivered_date");
        const sql = hasDeliveredDate
          ? "SELECT r.rec_id AS recId, a.identifier AS appIdentifier, r.delivered_date AS deliveredDate, r.data AS data FROM record r JOIN app a ON r.app_id = a.app_id WHERE r.rec_id > ? ORDER BY r.rec_id ASC LIMIT ?"
          : "SELECT r.rec_id AS recId, a.identifier AS appIdentifier, NULL AS deliveredDate, r.data AS data FROM record r JOIN app a ON r.app_id = a.app_id WHERE r.rec_id > ? ORDER BY r.rec_id ASC LIMIT ?";
        const rawRows = db.prepare(sql).all(afterRecId, CONNECTOR_MAX_BATCH_EVENTS) as Array<{
          recId: unknown;
          appIdentifier: unknown;
          deliveredDate: unknown;
          data: unknown;
        }>;
        const rows: NotificationRow[] = [];
        for (const row of rawRows) {
          const recId = Number(row.recId);
          if (!Number.isSafeInteger(recId) || recId <= 0) continue;
          const appIdentifier = typeof row.appIdentifier === "string" ? row.appIdentifier.trim() : "";
          const data = row.data instanceof Uint8Array ? row.data : Buffer.isBuffer(row.data) ? new Uint8Array(row.data) : null;
          if (!appIdentifier || !data) continue;
          rows.push({
            recId,
            appIdentifier,
            deliveredDate: typeof row.deliveredDate === "number" ? row.deliveredDate : null,
            data,
          });
        }
        return { sourceEpoch, maxRecId, rows, resetBaseline: false, gapDetected };
      });
      this.#permission = "granted";
      this.#lastError = undefined;
    } catch (error) {
      const explicit = error && typeof error === "object" && "kuloPermission" in error
        ? (error as { kuloPermission?: ConnectorPermissionState }).kuloPermission
        : undefined;
      if (explicit) {
        this.#permission = explicit;
      } else if (errnoCode(error) === "ENOENT") {
        this.#permission = "database_missing";
      } else if (isPermissionError(error)) {
        this.#permission = "full_disk_access_required";
      } else {
        this.#permission = "error";
      }
      this.#lastError = error instanceof Error ? error.message.slice(0, 300) : "通知库读取失败";
      if (this.#permission !== prevPermission || this.#lastError !== prevError) {
        this.#emitStatus();
      }
      return;
    }

    if (this.#permission !== prevPermission || this.#lastError !== prevError) {
      this.#emitStatus();
    }

    if (scanResult.resetBaseline) {
      this.#saveCursor(scanResult.sourceEpoch, scanResult.maxRecId);
      return;
    }
    if (scanResult.rows.length === 0) return;

    const now = Date.now();
    const events: RawConnectorEvent[] = [];
    let cursorAfter = scanResult.rows[0]!.recId;
    let estimatedBytes = 512;

    for (const row of scanResult.rows) {
      const parsed = extractNotificationPlist(row.data);
      const appId = (parsed?.appId && parsed.appId.includes(".") ? parsed.appId : row.appIdentifier).slice(0, 255);
      const title = parsed?.title ?? "";
      const subtitle = parsed?.subtitle ?? "";
      const body = parsed?.body ?? "";
      const filtered =
        !parsed ||
        (!title && !subtitle && !body) ||
        this.#mutedApps.has(appId) ||
        isSensitiveNotificationPayload({ appId, title, subtitle, body });

      if (filtered) {
        cursorAfter = row.recId;
        continue;
      }

      const event: RawConnectorEvent = {
        nativeEventId: String(row.recId),
        eventVersion: "1",
        appId,
        appLabel: friendlyAppLabel(appId),
        ...(parsed.threadId ? { threadHint: parsed.threadId } : {}),
        ...(title ? { sender: title.slice(0, 256) } : {}),
        title: title.slice(0, 1_000),
        ...(subtitle ? { subtitle: subtitle.slice(0, 1_000) } : {}),
        body: body.slice(0, CONNECTOR_MAX_TEXT_CHARS),
        occurredAt: appleTimestampToMs(row.deliveredDate, now),
        fidelity: "notification",
      };
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 16;
      if (events.length > 0 && estimatedBytes + eventBytes > CONNECTOR_MAX_BATCH_BYTES - 4_096) {
        break;
      }
      events.push(event);
      estimatedBytes += eventBytes;
      cursorAfter = row.recId;
    }

    if (events.length === 0) {
      // Advance past rows that were all filtered (OTP / muted / empty) so we never rescan them.
      const lastScanned = scanResult.rows[scanResult.rows.length - 1]!.recId;
      this.#saveCursor(scanResult.sourceEpoch, lastScanned);
      return;
    }

    const batchId = `nb-${randomUUID()}`;
    const batch: ConnectorEventBatch = {
      batchId,
      driverId: "macos-notifications",
      streamId: this.#streamId(),
      sourceEpoch: scanResult.sourceEpoch,
      cursorAfter: String(cursorAfter),
      events,
      ...(scanResult.gapDetected ? { gapDetected: true } : {}),
    };
    this.#inFlight = {
      batchId,
      streamId: batch.streamId,
      sourceEpoch: batch.sourceEpoch,
      cursorAfter,
    };
    this.#lastEventAt = now;
    this.#options.onBatch(batch);
  }

  #startLoop(): void {
    if (!this.#pollTimer) {
      this.#pollTimer = setInterval(() => {
        void this.scanNow();
      }, this.#pollIntervalMs);
      this.#pollTimer.unref();
    }
    if (!this.#watcher) {
      const dir = path.dirname(this.#dbPath());
      try {
        if (fs.existsSync(dir)) {
          this.#watcher = fs.watch(dir, () => {
            if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
            this.#debounceTimer = setTimeout(() => {
              this.#debounceTimer = null;
              void this.scanNow();
            }, WATCH_DEBOUNCE_MS);
            this.#debounceTimer.unref();
          });
          this.#watcher.on("error", () => {
            try { this.#watcher?.close(); } catch { /* ignore */ }
            this.#watcher = null;
          });
        }
      } catch {
        this.#watcher = null;
      }
    }
  }

  #stopLoop(): void {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#watcher) {
      try { this.#watcher.close(); } catch { /* ignore */ }
      this.#watcher = null;
    }
  }

  #emitStatus(): void {
    this.#options.onStatus(this.status);
  }
}
