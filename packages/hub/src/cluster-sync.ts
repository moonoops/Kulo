/**
 * Warm-Standby Tiered Incremental Sync Engine (Phase 2).
 *
 * - Primary (`ClusterSyncService`):
 *   - Persists monotonically increasing `generation` & `vaultRevision` in `cluster-sync-meta.json`.
 *   - Debounced 15s (30s max) snapshots using `node:sqlite` online `backup()` for both
 *     `kulo.sqlite` and `assistant.sqlite` (zero-overhead when no remote Standbys exist).
 *   - Compact 16-byte truncated SHA-256 per 4KB SQLite page (gzipped) for minimal delta transfers.
 *   - End-to-end authenticated encryption (`encryptClusterEnvelope`: Ed25519 + X25519 + AES-256-GCM)
 *     for every sync payload (manifest, SQLite pages, Tier 3 files, Vault, and Tier 4 upload chunks).
 *
 * - Standby (`StandbyReplicator`):
 *   - Pulls incremental SQLite pages, Tier 3 files, and Vault into `standby/staging/`,
 *     verifying full SHA-256 + `PRAGMA quick_check` + Vault atomic generation barrier before
 *     committing to `standby/replica/`.
 *   - If system Keychain is temporarily locked, stores the verified `vault-envelope.enc`
 *     alongside that generation so SQLite and Vault never diverge.
 *   - Background newest-first resumable `uploads/` sync (synchronously flushed on Planned Handover).
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import type { BuiltinMemoryClusterMeta, ClusterSyncStatus } from "@kulo/protocol";
import {
  CLUSTER_AUTH_HEADER,
  createClusterAuthHeader,
  decryptKeyMaterialWithKek,
  encryptClusterEnvelope,
  encryptKeyMaterialWithKek,
  generateClusterNodeKeyMaterial,
  verifyAndDecryptClusterEnvelope,
  type ClusterEncryptedEnvelope,
  type ClusterNodeKeyMaterial,
} from "@kulo/env";
import {
  ConnectionVaultError,
  LocalConnectionVault,
  createStandbyVaultNamespace,
  getOrCreateClusterKek,
  runWithClusterKeyLock,
  type ConnectionSecretFields,
  type ConnectionVaultKeyStore,
} from "./connection-vault.js";
import {
  CLUSTER_BUILTIN_MEMORY_CAPABILITY, CLUSTER_SYNC_SQLITE_DBS, CLUSTER_SYNC_SQLITE_SET,
  SYNC_META_FILE, TIER3_FIXED_FILES, collectTrustedSshConnectionIds, collectTrustedSshKnownHostsFiles,
  enforceConnectionRuntimePermissions, isSafeSyncRelativePath, isTrustedSshKnownHostsPath,
  parseReplicaBuiltinMemoryMeta, shouldSkipTempFile, shouldSkipUploadEntry, verifyStagedManifestBuiltinMemory,
  walkRegularFiles, type ClusterSyncSqliteDbName,
} from "./cluster-sync-paths.js";

export { isSafeSyncRelativePath };
export const CLUSTER_SYNC_PAGE_SIZE = 4096;
export const CLUSTER_SYNC_MAX_PAGES_PER_REQUEST = 512;
export const CLUSTER_SYNC_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const PAGE_HASH_TRUNCATED_BYTES = 16;
const SNAPSHOT_TTL_MS = 120_000;
const MAX_RETAINED_SNAPSHOTS = 2;
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_ROOT_DIR = ".cluster-sync-snapshots";

export class ClusterSyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClusterSyncHttpError";
  }
}

export interface ClusterSyncMeta {
  version: 1;
  generation: number;
  vaultRevision: number;
}

export interface ClusterSyncSqliteEntry {
  name: ClusterSyncSqliteDbName;
  size: number;
  sha256: string;
  pageSize: number;
  pageCount: number;
  pageHashesGzipBase64: string;
}

export interface ClusterSyncFileEntry {
  path: string;
  size: number;
  sha256: string;
  mtimeMs: number;
}

export interface ClusterSyncManifest {
  version: 1;
  hubId: string;
  primaryNodeId: string;
  clusterEpoch: number;
  generation: number;
  createdAt: number;
  vaultRevision: number;
  vaultCount: number;
  sqlite: ClusterSyncSqliteEntry[];
  files: ClusterSyncFileEntry[];
  uploads: ClusterSyncFileEntry[];
  requiredCapabilities?: string[];
  requiredDbs?: ClusterSyncSqliteDbName[];
  builtinMemoryMeta?: BuiltinMemoryClusterMeta;
}

export interface ClusterSyncSqlitePagesResponse {
  generation: number;
  db: ClusterSyncSqliteDbName;
  pageSize: number;
  totalSize: number;
  chunks: Array<{ page: number; dataBase64: string }>;
}

export interface ClusterSyncFileChunkResponse {
  generation: number;
  path: string;
  offset: number;
  totalSize: number;
  sha256: string;
  dataBase64: string;
}

export interface ClusterSyncVaultPayload {
  version: 1;
  generation: number;
  vaultRevision: number;
  entries: Array<{ ref: string; fields: ConnectionSecretFields }>;
}

export interface StandbyReplicaState {
  version: 1;
  hubId: string;
  primaryNodeId: string;
  epoch: number;
  generation: number;
  vaultRevision: number;
  syncedAt: number;
  pendingVaultEnvelope: boolean;
  uploadsComplete: boolean;
  builtinMemoryMeta?: BuiltinMemoryClusterMeta;
}

export interface EnsureClusterKeysOptions {
  dataDir: string;
  hubStateDir: string;
  standbyDir: string;
  keyStore?: ConnectionVaultKeyStore;
}

function writeFileAtomic(filePath: string, content: Buffer | string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(filePath, mode); } catch { /* ignore */ }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export async function ensureLocalClusterKeys(options: EnsureClusterKeysOptions): Promise<ClusterNodeKeyMaterial> {
  const dataDir = path.resolve(options.dataDir);
  const keyFile = path.join(path.resolve(options.standbyDir), "sync-key.enc");
  const aadContext = `sync-key:${dataDir}`;
  return runWithClusterKeyLock({ dataDir, hubStateDir: options.hubStateDir, keyStore: options.keyStore }, async () => {
    const exists = fs.existsSync(keyFile);
    const kek = await getOrCreateClusterKek({ dataDir, hubStateDir: options.hubStateDir, keyStore: options.keyStore, create: !exists });
    try {
      if (exists) {
        const stat = fs.lstatSync(keyFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("节点同步密钥文件类型无效。");
        return decryptKeyMaterialWithKek(fs.readFileSync(keyFile, "utf8"), kek, aadContext);
      }
      const generated = generateClusterNodeKeyMaterial();
      writeFileAtomic(keyFile, encryptKeyMaterialWithKek(generated, kek, aadContext), 0o600);
      return generated;
    } finally { kek.fill(0); }
  });
}

export function readSyncMeta(stateDir: string): ClusterSyncMeta {
  const filePath = path.join(stateDir, SYNC_META_FILE);
  if (!fs.existsSync(filePath)) {
    return { version: 1, generation: 0, vaultRevision: 0 };
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { version: 1, generation: 0, vaultRevision: 0 };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ClusterSyncMeta>;
    const generation = typeof parsed.generation === "number" && Number.isSafeInteger(parsed.generation) && parsed.generation >= 0
      ? parsed.generation : 0;
    const vaultRevision = typeof parsed.vaultRevision === "number" && Number.isSafeInteger(parsed.vaultRevision) && parsed.vaultRevision >= 0
      ? parsed.vaultRevision : 0;
    return { version: 1, generation, vaultRevision };
  } catch {
    return { version: 1, generation: 0, vaultRevision: 0 };
  }
}

export function writeSyncMeta(stateDir: string, meta: ClusterSyncMeta): void {
  writeFileAtomic(path.join(stateDir, SYNC_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
}

export function readReplicaState(replicaDir: string): StandbyReplicaState | null {
  const filePath = path.join(replicaDir, "replica-state.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StandbyReplicaState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.hubId !== "string" ||
      typeof parsed.primaryNodeId !== "string" ||
      typeof parsed.epoch !== "number" ||
      typeof parsed.generation !== "number" ||
      typeof parsed.vaultRevision !== "number" ||
      typeof parsed.syncedAt !== "number"
    ) {
      return null;
    }
    const builtinMemoryMeta = parseReplicaBuiltinMemoryMeta(parsed.builtinMemoryMeta);
    return {
      version: 1,
      hubId: parsed.hubId,
      primaryNodeId: parsed.primaryNodeId,
      epoch: parsed.epoch,
      generation: parsed.generation,
      vaultRevision: parsed.vaultRevision,
      syncedAt: parsed.syncedAt,
      pendingVaultEnvelope: Boolean(parsed.pendingVaultEnvelope),
      uploadsComplete: Boolean(parsed.uploadsComplete),
      ...(builtinMemoryMeta ? { builtinMemoryMeta } : {}),
    };
  } catch {
    return null;
  }
}

function sha256File(filePath: string): { size: number; sha256: string; mtimeMs: number } {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Invalid regular file: ${filePath}`);
  }
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size: stat.size, sha256: hash.digest("hex"), mtimeMs: Math.floor(stat.mtimeMs) };
}

function computeSqlitePageHashes(
  filePath: string,
  pageSize = CLUSTER_SYNC_PAGE_SIZE,
): { size: number; sha256: string; pageCount: number; pageHashes: Buffer } {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Invalid SQLite snapshot file: ${filePath}`);
  }
  const pageCount = Math.ceil(stat.size / pageSize);
  const pageHashes = Buffer.allocUnsafe(pageCount * PAGE_HASH_TRUNCATED_BYTES);
  const fullHash = createHash("sha256");
  const pageBuf = Buffer.allocUnsafe(pageSize);
  const fd = fs.openSync(filePath, "r");
  try {
    for (let page = 0; page < pageCount; page++) {
      const offset = page * pageSize;
      const toRead = Math.min(pageSize, stat.size - offset);
      const read = fs.readSync(fd, pageBuf, 0, toRead, offset);
      const slice = pageBuf.subarray(0, read);
      fullHash.update(slice);
      const digest = createHash("sha256").update(slice).digest();
      digest.copy(pageHashes, page * PAGE_HASH_TRUNCATED_BYTES, 0, PAGE_HASH_TRUNCATED_BYTES);
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    size: stat.size,
    sha256: fullHash.digest("hex"),
    pageCount,
    pageHashes,
  };
}

function verifySqliteQuickCheck(filePath: string): void {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed: ${String(row?.quick_check ?? "unknown")}`);
    }
  } finally {
    db.close();
  }
}

function safeResolveUnder(rootDir: string, relPath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, relPath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ClusterSyncHttpError(400, "invalid_sync_path", "同步文件路径越界。");
  }
  return target;
}

interface RetainedSnapshot {
  generation: number;
  dir: string;
  manifest: ClusterSyncManifest;
  vaultEntries: Array<{ ref: string; fields: ConnectionSecretFields }>;
  refCount: number;
  supersededAt?: number;
}

export interface ClusterSyncServiceOptions {
  stateDir: string;
  getHubId: () => string;
  getPrimaryNodeId: () => string;
  getClusterEpoch: () => number;
  hasRemoteStandbys: () => boolean;
  getEffectiveIdentityDir: () => string;
  backupAssistantLedger?: (destPath: string) => Promise<boolean>;
  backupSqliteDb?: (name: Exclude<ClusterSyncSqliteDbName, "kulo.sqlite">, destPath: string) => Promise<boolean>;
  getBuiltinMemoryMeta?: () => BuiltinMemoryClusterMeta | undefined;
  readVaultEntries: () => Promise<Array<{ ref: string; fields: ConnectionSecretFields }>>;
  getSenderKeys: () => ClusterNodeKeyMaterial;
  resolveStandbyPublicKey: (nodeId: string) => string | undefined;
  notifySyncAvailable: (generation: number, vaultRevision: number) => void;
  debounceMs?: number;
  maxDelayMs?: number;
}

export class ClusterSyncService {
  readonly #opts: ClusterSyncServiceOptions;
  readonly #snapshotRoot: string;
  readonly #debounceMs: number;
  readonly #maxDelayMs: number;
  readonly #snapshots = new Map<number, RetainedSnapshot>();
  readonly #uploadHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  #meta: ClusterSyncMeta;
  #dirty = false;
  #firstDirtyAt: number | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #maxDelayTimer: ReturnType<typeof setTimeout> | null = null;
  #evictTimer: ReturnType<typeof setInterval> | null = null;
  #buildChain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: ClusterSyncServiceOptions) {
    this.#opts = options;
    this.#snapshotRoot = path.join(path.resolve(options.stateDir), SNAPSHOT_ROOT_DIR);
    this.#debounceMs = options.debounceMs ?? 15_000;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#meta = readSyncMeta(options.stateDir);
    this.#cleanupOrphanSnapshots();
  }

  #generationClearEpochs = new Map<number, number>();
  getClearEpochForGeneration(generation: number): number { return this.#generationClearEpochs.get(generation) ?? -1; }
  get currentGeneration(): number {
    return this.#meta.generation;
  }

  get currentVaultRevision(): number {
    return this.#meta.vaultRevision;
  }

  start(): void {
    if (this.#closed) return;
    if (!this.#evictTimer) {
      this.#evictTimer = setInterval(() => this.#evictExpiredSnapshots(), 30_000);
      this.#evictTimer.unref?.();
    }
    if (this.#opts.hasRemoteStandbys() && this.#snapshots.size === 0) {
      void this.triggerBaseline().catch((error) => {
        console.error("[ClusterSync] baseline snapshot failed:", error instanceof Error ? error.message : String(error));
      });
    }
  }

  markDirty(kind: "sqlite" | "assistant" | "memory" | "vault" | "files" | "uploads", options?: { immediate?: boolean }): void {
    if (this.#closed) return;
    if (kind === "vault") {
      this.#meta = { ...this.#meta, vaultRevision: this.#meta.vaultRevision + 1 };
      try { writeSyncMeta(this.#opts.stateDir, this.#meta); } catch { /* Persist on next snapshot build */ }
    }
    this.#dirty = true;
    if (!this.#opts.hasRemoteStandbys()) return;
    if (options?.immediate) { void this.flushNow().catch((e) => console.error("[ClusterSync] immediate flush failed:", e instanceof Error ? e.message : String(e))); return; }
    this.#scheduleDebouncedBuild();
  }

  /** Called when a Standby is newly enabled or comes online and needs an immediate baseline (P1-3). */
  async triggerBaseline(): Promise<ClusterSyncManifest | null> {
    if (this.#closed || !this.#opts.hasRemoteStandbys()) return null;
    if (this.#snapshots.size > 0 && !this.#dirty) {
      const latest = this.#getLatestSnapshot();
      if (latest) {
        this.#opts.notifySyncAvailable(latest.generation, latest.manifest.vaultRevision);
        return latest.manifest;
      }
    }
    return this.flushNow();
  }

  async flushNow(): Promise<ClusterSyncManifest> {
    if (this.#closed) {
      throw new ClusterSyncHttpError(503, "sync_service_closed", "同步服务正在关闭。");
    }
    this.#clearScheduleTimers();
    let built: ClusterSyncManifest | undefined;
    const task = this.#buildChain.then(async () => {
      built = await this.#buildSnapshot();
    });
    this.#buildChain = task.then(() => undefined, () => undefined);
    await task;
    return built!;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearScheduleTimers();
    if (this.#evictTimer) {
      clearInterval(this.#evictTimer);
      this.#evictTimer = null;
    }
    await this.#buildChain.catch(() => undefined);
    for (const snap of this.#snapshots.values()) {
      this.#zeroVaultEntries(snap.vaultEntries);
      fs.rmSync(snap.dir, { recursive: true, force: true });
    }
    this.#snapshots.clear();
    fs.rmSync(this.#snapshotRoot, { recursive: true, force: true });
  }

  async serveManifest(targetNodeId: string, requestNonce: string): Promise<ClusterEncryptedEnvelope> {
    const pubKey = this.#requireStandbyPublicKey(targetNodeId);
    let snap = this.#getLatestSnapshot();
    if (!snap) {
      await this.flushNow();
      snap = this.#getLatestSnapshot();
    }
    if (!snap) {
      throw new ClusterSyncHttpError(503, "sync_snapshot_unavailable", "同步快照尚未就绪。");
    }
    return this.#sealForStandby({
      plaintext: Buffer.from(JSON.stringify(snap.manifest), "utf8"),
      generation: snap.generation,
      targetNodeId,
      requestNonce,
      resourceId: "manifest",
      recipientX25519PublicKey: pubKey,
    });
  }

  async serveSqlitePages(
    targetNodeId: string,
    requestNonce: string,
    body: { generation?: unknown; db?: unknown; pages?: unknown },
  ): Promise<ClusterEncryptedEnvelope> {
    const pubKey = this.#requireStandbyPublicKey(targetNodeId);
    const generation = typeof body.generation === "number" && Number.isSafeInteger(body.generation) ? body.generation : -1;
    const dbName = typeof body.db === "string" && CLUSTER_SYNC_SQLITE_SET.has(body.db) ? (body.db as ClusterSyncSqliteDbName) : null;
    if (!dbName || !Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > CLUSTER_SYNC_MAX_PAGES_PER_REQUEST) {
      throw new ClusterSyncHttpError(400, "invalid_sqlite_pages_request", "无效的数据库增量页请求。");
    }
    const pages: number[] = [];
    for (const raw of body.pages) {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
        throw new ClusterSyncHttpError(400, "invalid_sqlite_page_index", "无效的数据库页编号。");
      }
      pages.push(raw);
    }

    return this.#withSnapshot(generation, async (snap) => {
      const entry = snap.manifest.sqlite.find((item) => item.name === dbName);
      if (!entry) {
        throw new ClusterSyncHttpError(404, "sqlite_db_not_found", "指定数据库不存在于当前快照中。");
      }
      const dbPath = path.join(snap.dir, dbName);
      const chunks: Array<{ page: number; dataBase64: string }> = [];
      const fd = fs.openSync(dbPath, "r");
      try {
        const buf = Buffer.allocUnsafe(entry.pageSize);
        for (const page of pages) {
          if (page >= entry.pageCount) {
            throw new ClusterSyncHttpError(400, "sqlite_page_out_of_range", "请求的数据库页超出范围。");
          }
          const offset = page * entry.pageSize;
          const len = Math.min(entry.pageSize, entry.size - offset);
          const read = fs.readSync(fd, buf, 0, len, offset);
          chunks.push({ page, dataBase64: buf.subarray(0, read).toString("base64") });
        }
      } finally {
        fs.closeSync(fd);
      }
      const payload: ClusterSyncSqlitePagesResponse = {
        generation: snap.generation,
        db: dbName,
        pageSize: entry.pageSize,
        totalSize: entry.size,
        chunks,
      };
      return this.#sealForStandby({
        plaintext: Buffer.from(JSON.stringify(payload), "utf8"),
        generation: snap.generation,
        targetNodeId,
        requestNonce,
        resourceId: `sqlite-pages:${dbName}`,
        recipientX25519PublicKey: pubKey,
      });
    });
  }

  async serveFile(
    targetNodeId: string,
    requestNonce: string,
    query: { generation: number; relPath: string; offset?: number; length?: number },
  ): Promise<ClusterEncryptedEnvelope> {
    const pubKey = this.#requireStandbyPublicKey(targetNodeId);
    if (!isSafeSyncRelativePath(query.relPath)) {
      throw new ClusterSyncHttpError(400, "invalid_sync_path", "同步文件路径无效。");
    }
    return this.#withSnapshot(query.generation, async (snap) => {
      const isUpload = query.relPath.startsWith("uploads/");
      const manifestEntry = isUpload
        ? snap.manifest.uploads.find((f) => f.path === query.relPath)
        : snap.manifest.files.find((f) => f.path === query.relPath);
      if (!manifestEntry) {
        throw new ClusterSyncHttpError(404, "sync_file_not_found", "同步文件不存在于当前快照中。");
      }
      const absPath = isUpload
        ? safeResolveUnder(this.#opts.stateDir, query.relPath)
        : safeResolveUnder(path.join(snap.dir, "files"), query.relPath);
      if (!fs.existsSync(absPath)) {
        throw new ClusterSyncHttpError(404, "sync_file_not_found", "同步文件已不存在。");
      }
      const stat = fs.lstatSync(absPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ClusterSyncHttpError(403, "invalid_sync_file", "不允许同步符号链接或非普通文件。");
      }
      const offset = query.offset ?? 0;
      const requestedLength = query.length ?? Math.min(stat.size - offset, CLUSTER_SYNC_UPLOAD_CHUNK_BYTES);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) {
        throw new ClusterSyncHttpError(416, "invalid_range", "文件偏移超出范围。");
      }
      const maxChunk = Math.max(0, Math.min(requestedLength, CLUSTER_SYNC_UPLOAD_CHUNK_BYTES, stat.size - offset));
      const data = Buffer.allocUnsafe(maxChunk);
      if (maxChunk > 0) {
        const fd = fs.openSync(absPath, "r");
        try {
          const read = fs.readSync(fd, data, 0, maxChunk, offset);
          if (read < maxChunk) {
            throw new ClusterSyncHttpError(409, "file_changed_during_read", "同步文件读取期间发生变更。");
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      const payload: ClusterSyncFileChunkResponse = {
        generation: snap.generation,
        path: query.relPath,
        offset,
        totalSize: stat.size,
        sha256: manifestEntry.sha256,
        dataBase64: data.toString("base64"),
      };
      return this.#sealForStandby({
        plaintext: Buffer.from(JSON.stringify(payload), "utf8"),
        generation: snap.generation,
        targetNodeId,
        requestNonce,
        resourceId: `file:${query.relPath}:${offset}`,
        recipientX25519PublicKey: pubKey,
      });
    });
  }

  async serveVault(
    targetNodeId: string,
    requestNonce: string,
    generation: number,
  ): Promise<ClusterEncryptedEnvelope> {
    const pubKey = this.#requireStandbyPublicKey(targetNodeId);
    return this.#withSnapshot(generation, async (snap) => {
      const payload: ClusterSyncVaultPayload = {
        version: 1,
        generation: snap.generation,
        vaultRevision: snap.manifest.vaultRevision,
        entries: snap.vaultEntries,
      };
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      try {
        return this.#sealForStandby({
          plaintext,
          generation: snap.generation,
          targetNodeId,
          requestNonce,
          resourceId: "vault",
          recipientX25519PublicKey: pubKey,
        });
      } finally {
        plaintext.fill(0);
      }
    });
  }

  #requireStandbyPublicKey(nodeId: string): string {
    const pubKey = this.#opts.resolveStandbyPublicKey(nodeId);
    if (!pubKey) {
      throw new ClusterSyncHttpError(409, "standby_key_missing", "备用主机尚未上报加密公钥，请稍后重试。");
    }
    return pubKey;
  }

  #sealForStandby(input: {
    plaintext: Buffer;
    generation: number;
    targetNodeId: string;
    requestNonce: string;
    resourceId: string;
    recipientX25519PublicKey: string;
  }): ClusterEncryptedEnvelope {
    const senderKeys = this.#opts.getSenderKeys();
    return encryptClusterEnvelope({
      plaintext: input.plaintext,
      hubId: this.#opts.getHubId(),
      epoch: this.#opts.getClusterEpoch(),
      generation: input.generation,
      senderNodeId: this.#opts.getPrimaryNodeId(),
      targetNodeId: input.targetNodeId,
      requestNonce: input.requestNonce,
      resourceId: input.resourceId,
      recipientX25519PublicKey: input.recipientX25519PublicKey,
      senderEd25519PrivateDerB64: senderKeys.ed25519PrivateDerB64,
    });
  }

  #scheduleDebouncedBuild(): void {
    const now = Date.now();
    if (this.#firstDirtyAt === null) {
      this.#firstDirtyAt = now;
    }
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#runScheduledBuild();
    }, this.#debounceMs);
    this.#debounceTimer.unref?.();

    if (!this.#maxDelayTimer) {
      const remaining = Math.max(0, this.#maxDelayMs - (now - this.#firstDirtyAt));
      this.#maxDelayTimer = setTimeout(() => {
        this.#maxDelayTimer = null;
        void this.#runScheduledBuild();
      }, remaining);
      this.#maxDelayTimer.unref?.();
    }
  }

  #clearScheduleTimers(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#maxDelayTimer) {
      clearTimeout(this.#maxDelayTimer);
      this.#maxDelayTimer = null;
    }
    this.#firstDirtyAt = null;
  }

  async #runScheduledBuild(): Promise<void> {
    if (this.#closed || !this.#dirty || !this.#opts.hasRemoteStandbys()) return;
    this.#clearScheduleTimers();
    const task = this.#buildChain.then(async () => {
      if (this.#closed || !this.#dirty || !this.#opts.hasRemoteStandbys()) return;
      await this.#buildSnapshot();
    });
    this.#buildChain = task.then(() => undefined, () => undefined);
    await task.catch((error) => {
      console.error("[ClusterSync] snapshot build failed:", error instanceof Error ? error.message : String(error));
    });
  }

  async #buildSnapshot(): Promise<ClusterSyncManifest> {
    if (this.#closed) {
      throw new ClusterSyncHttpError(503, "sync_service_closed", "同步服务正在关闭。");
    }
    const nextGeneration = this.#meta.generation + 1;
    const nextMeta: ClusterSyncMeta = {
      version: 1,
      generation: nextGeneration,
      vaultRevision: this.#meta.vaultRevision,
    };
    this.#meta = nextMeta;
    this.#dirty = false;
    writeSyncMeta(this.#opts.stateDir, nextMeta);

    fs.mkdirSync(this.#snapshotRoot, { recursive: true, mode: 0o700 });
    const snapDir = path.join(this.#snapshotRoot, `gen-${nextGeneration}-${randomBytes(4).toString("hex")}`);
    fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    const filesSnapDir = path.join(snapDir, "files");
    fs.mkdirSync(filesSnapDir, { recursive: true, mode: 0o700 });

    try {
      // 1. Read Vault entries at the exact snapshot point-in-time.
      const vaultEntries = await this.#opts.readVaultEntries();

      // 2. Online SQLite backups via node:sqlite `backup()` (WAL-safe, P0-3 / P1-3).
      const sqliteEntries: ClusterSyncSqliteEntry[] = [];
      const pushSqlite = (name: ClusterSyncSqliteDbName, dst: string) => {
        const hashed = computeSqlitePageHashes(dst, CLUSTER_SYNC_PAGE_SIZE);
        sqliteEntries.push({
          name, size: hashed.size, sha256: hashed.sha256, pageSize: CLUSTER_SYNC_PAGE_SIZE,
          pageCount: hashed.pageCount, pageHashesGzipBase64: gzipSync(hashed.pageHashes).toString("base64"),
        });
      };
      const kuloDbSrc = path.join(this.#opts.stateDir, "kulo.sqlite");
      if (fs.existsSync(kuloDbSrc)) {
        const dst = path.join(snapDir, "kulo.sqlite");
        await backupSqliteFileOnline(kuloDbSrc, dst);
        pushSqlite("kulo.sqlite", dst);
      }
      for (const extraDb of ["assistant.sqlite", "memory.sqlite"] as const) {
        const dst = path.join(snapDir, extraDb);
        const backed = this.#opts.backupSqliteDb
          ? await this.#opts.backupSqliteDb(extraDb, dst)
          : extraDb === "assistant.sqlite" && this.#opts.backupAssistantLedger
            ? await this.#opts.backupAssistantLedger(dst)
            : false;
        if (backed && fs.existsSync(dst)) pushSqlite(extraDb, dst);
      }

      // 3. Tier 3 point-in-time files (fixed allowlist + identity/** + skills/**).
      const tier3Entries: ClusterSyncFileEntry[] = [];
      for (const name of TIER3_FIXED_FILES) {
        const src = path.join(this.#opts.stateDir, name);
        if (!fs.existsSync(src)) continue;
        let st: fs.Stats;
        try { st = fs.lstatSync(src); } catch { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        const dst = safeResolveUnder(filesSnapDir, name);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(src, dst);
        const info = sha256File(dst);
        tier3Entries.push({ path: name, size: info.size, sha256: info.sha256, mtimeMs: info.mtimeMs });
      }

      const identityDir = this.#opts.getEffectiveIdentityDir();
      for (const item of walkRegularFiles(identityDir, "identity", { skipNames: shouldSkipTempFile })) {
        const dst = safeResolveUnder(filesSnapDir, item.relPath);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(item.absPath, dst);
        const info = sha256File(dst);
        tier3Entries.push({ path: item.relPath, size: info.size, sha256: info.sha256, mtimeMs: info.mtimeMs });
      }

      const skillsDir = path.join(this.#opts.stateDir, "skills");
      for (const item of walkRegularFiles(skillsDir, "skills", { skipNames: shouldSkipTempFile })) {
        const dst = safeResolveUnder(filesSnapDir, item.relPath);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(item.absPath, dst);
        const info = sha256File(dst);
        tier3Entries.push({ path: item.relPath, size: info.size, sha256: info.sha256, mtimeMs: info.mtimeMs });
      }

      const trustedSshIds = collectTrustedSshConnectionIds(safeResolveUnder(filesSnapDir, "connections.json"));
      for (const item of collectTrustedSshKnownHostsFiles(this.#opts.stateDir, trustedSshIds)) {
        const dst = safeResolveUnder(filesSnapDir, item.relPath);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(item.absPath, dst);
        fs.chmodSync(dst, 0o600);
        const info = sha256File(dst);
        tier3Entries.push({ path: item.relPath, size: info.size, sha256: info.sha256, mtimeMs: info.mtimeMs });
      }

      // 4. Tier 4 uploads/** manifest (cached SHA-256, sorted newest first).
      const uploadsDir = path.join(this.#opts.stateDir, "uploads");
      const uploadFiles = walkRegularFiles(uploadsDir, "uploads", { skipNames: shouldSkipUploadEntry });
      const activeUploadKeys = new Set<string>();
      const uploadEntries: ClusterSyncFileEntry[] = [];
      for (const item of uploadFiles) {
        activeUploadKeys.add(item.relPath);
        const cached = this.#uploadHashCache.get(item.relPath);
        let sha: string;
        if (cached && cached.size === item.size && cached.mtimeMs === item.mtimeMs) {
          sha = cached.sha256;
        } else {
          const info = sha256File(item.absPath);
          sha = info.sha256;
          this.#uploadHashCache.set(item.relPath, { size: info.size, mtimeMs: info.mtimeMs, sha256: sha });
        }
        uploadEntries.push({ path: item.relPath, size: item.size, sha256: sha, mtimeMs: item.mtimeMs });
      }
      for (const key of [...this.#uploadHashCache.keys()]) {
        if (!activeUploadKeys.has(key)) this.#uploadHashCache.delete(key);
      }
      uploadEntries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));

      const builtinMemoryMeta = this.#opts.getBuiltinMemoryMeta?.();
      const hasMemoryDb = sqliteEntries.some((s) => s.name === "memory.sqlite");
      const manifest: ClusterSyncManifest = {
        version: 1,
        hubId: this.#opts.getHubId(),
        primaryNodeId: this.#opts.getPrimaryNodeId(),
        clusterEpoch: this.#opts.getClusterEpoch(),
        generation: nextGeneration,
        createdAt: Date.now(),
        vaultRevision: nextMeta.vaultRevision,
        vaultCount: vaultEntries.length,
        sqlite: sqliteEntries,
        files: tier3Entries,
        uploads: uploadEntries,
        ...(hasMemoryDb ? { requiredCapabilities: [CLUSTER_BUILTIN_MEMORY_CAPABILITY], requiredDbs: sqliteEntries.map((s) => s.name) } : {}),
        ...(builtinMemoryMeta ? { builtinMemoryMeta } : {}),
      };

      const now = Date.now();
      for (const existing of this.#snapshots.values()) {
        if (existing.supersededAt === undefined) existing.supersededAt = now;
      }
      this.#snapshots.set(nextGeneration, {
        generation: nextGeneration,
        dir: snapDir,
        manifest,
        vaultEntries,
        refCount: 0,
      });
      this.#generationClearEpochs.set(nextGeneration, manifest.builtinMemoryMeta?.appliedClearEpoch ?? 0);
      if (this.#generationClearEpochs.size > 32) this.#generationClearEpochs.delete(this.#generationClearEpochs.keys().next().value!);
      this.#evictExpiredSnapshots();
      this.#opts.notifySyncAvailable(nextGeneration, nextMeta.vaultRevision);
      return manifest;
    } catch (error) {
      fs.rmSync(snapDir, { recursive: true, force: true });
      throw error;
    }
  }

  #getLatestSnapshot(): RetainedSnapshot | undefined {
    let best: RetainedSnapshot | undefined;
    for (const snap of this.#snapshots.values()) {
      if (!best || snap.generation > best.generation) best = snap;
    }
    return best;
  }

  async #withSnapshot<T>(generation: number, fn: (snap: RetainedSnapshot) => Promise<T>): Promise<T> {
    const snap = this.#snapshots.get(generation);
    if (!snap) {
      throw new ClusterSyncHttpError(410, "generation_expired", "请求的同步快照已过期，请重新获取清单。");
    }
    snap.refCount += 1;
    try {
      return await fn(snap);
    } finally {
      snap.refCount = Math.max(0, snap.refCount - 1);
      this.#evictExpiredSnapshots();
    }
  }

  #evictExpiredSnapshots(): void {
    const now = Date.now();
    const sorted = [...this.#snapshots.values()].sort((a, b) => b.generation - a.generation);
    for (let i = 0; i < sorted.length; i++) {
      const snap = sorted[i]!;
      if (snap.refCount > 0) continue;
      const beyondCount = i >= MAX_RETAINED_SNAPSHOTS;
      const expired = i >= 1 && snap.supersededAt !== undefined && now - snap.supersededAt > SNAPSHOT_TTL_MS;
      if (beyondCount || expired) {
        this.#snapshots.delete(snap.generation);
        this.#zeroVaultEntries(snap.vaultEntries);
        fs.rmSync(snap.dir, { recursive: true, force: true });
      }
    }
  }

  #cleanupOrphanSnapshots(): void {
    if (!fs.existsSync(this.#snapshotRoot)) return;
    try {
      fs.rmSync(this.#snapshotRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  #zeroVaultEntries(entries: Array<{ ref: string; fields: ConnectionSecretFields }>): void {
    entries.length = 0;
  }
}

async function backupSqliteFileOnline(sourcePath: string, destPath: string): Promise<void> {
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    await sqliteBackup(db, destPath, { rate: 256 });
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/*  Standby Replicator                                                        */
/* -------------------------------------------------------------------------- */

export interface StandbyReplicatorConfig {
  dataDir: string;
  hubStateDir: string;
  standbyDir: string;
  hubId: string;
  nodeId: string;
  syncToken: string;
  getPrimaryUrl: () => string;
  getPrimaryNodeId: () => string;
  getPrimaryIdentityPublicKey: () => string | undefined;
  getClusterEpoch: () => number;
  getNodeKeys: () => Promise<ClusterNodeKeyMaterial>;
  keyStore?: ConnectionVaultKeyStore;
  onStatusChange?: (status: ClusterSyncStatus) => void;
  onRevoked?: () => void;
  pollIntervalMs?: number;
}

export class StandbyReplicator {
  readonly #cfg: StandbyReplicatorConfig;
  readonly #replicaDir: string;
  readonly #stagingRoot: string;
  readonly #stopController = new AbortController();
  #running = false;
  #stopped = false;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #syncInFlight: Promise<StandbyReplicaState | null> | null = null;
  #uploadInFlight: Promise<void> | null = null;
  #pendingSync = false;
  #lastStatus: ClusterSyncStatus = { state: "pending", syncedGeneration: 0 };
  #lastManifest: ClusterSyncManifest | null = null;

  constructor(config: StandbyReplicatorConfig) {
    this.#cfg = config;
    this.#replicaDir = path.join(path.resolve(config.standbyDir), "replica");
    this.#stagingRoot = path.join(path.resolve(config.standbyDir), "staging");
    const existing = readReplicaState(this.#replicaDir);
    if (existing) {
      this.#lastStatus = {
        state: existing.pendingVaultEnvelope ? "error" : "synced",
        syncedGeneration: existing.generation,
        syncedAt: existing.syncedAt,
        ...(existing.pendingVaultEnvelope ? { vaultPending: true, error: "系统密钥库已锁定，凭据待解锁写入。" } : {}),
      };
    }
  }

  get replicaDir(): string {
    return this.#replicaDir;
  }

  get status(): ClusterSyncStatus {
    return { ...this.#lastStatus };
  }

  start(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    this.#cleanupStaleStaging();
    const pollMs = this.#cfg.pollIntervalMs ?? 60_000;
    this.#pollTimer = setInterval(() => {
      void this.triggerSync();
    }, pollMs);
    this.#pollTimer.unref?.();
    void this.triggerSync();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    this.#stopController.abort();
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    await this.#syncInFlight?.catch(() => undefined);
    await this.#uploadInFlight?.catch(() => undefined);
  }

  triggerSync(): Promise<StandbyReplicaState | null> {
    if (this.#stopped) return Promise.resolve(null);
    if (this.#syncInFlight) {
      this.#pendingSync = true;
      return this.#syncInFlight;
    }
    const run = this.#performSync({ flushUploads: false }).finally(() => {
      if (this.#syncInFlight === run) this.#syncInFlight = null;
      if (this.#pendingSync && !this.#stopped) {
        this.#pendingSync = false;
        void this.triggerSync();
      }
    });
    this.#syncInFlight = run;
    return run;
  }

  /**
   * Synchronous catch-up used during Planned Handover (P0-10):
   * guarantees both core SQLite/Vault/Tier3 generation >= `minGeneration` AND all `uploads/**`
   * are fully replicated and SHA-256 verified before the Standby accepts promotion.
   */
  async syncForHandover(minGeneration: number): Promise<StandbyReplicaState> {
    if (this.#stopped) throw new Error("备用主机同步器已停止。");
    if (this.#syncInFlight) {
      await this.#syncInFlight.catch(() => undefined);
    }
    const state = await this.#performSync({ flushUploads: true, minGeneration });
    if (!state) {
      throw new Error("切回前同步未能完成，请重试。");
    }
    if (state.generation < minGeneration) {
      throw new Error(`同步代次落后（本地 ${state.generation} < 目标 ${minGeneration}）。`);
    }
    if (!state.uploadsComplete) {
      throw new Error("附件同步未完成，无法无损切回。");
    }
    return state;
  }

  async wipeStandby(): Promise<void> {
    await this.stop();
    const standbyDir = path.resolve(this.#cfg.standbyDir);
    fs.rmSync(standbyDir, { recursive: true, force: true });
    this.#updateStatus({ state: "pending", syncedGeneration: 0 });
  }

  #updateStatus(status: ClusterSyncStatus): void {
    this.#lastStatus = { ...status };
    try {
      this.#cfg.onStatusChange?.({ ...status });
    } catch {
      // Ignore callback error
    }
  }

  #cleanupStaleStaging(): void {
    if (!fs.existsSync(this.#stagingRoot)) return;
    const now = Date.now();
    try {
      for (const entry of fs.readdirSync(this.#stagingRoot)) {
        const full = path.join(this.#stagingRoot, entry);
        try {
          const st = fs.lstatSync(full);
          if (now - st.mtimeMs > STALE_STAGING_MS || entry.startsWith("gen-")) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch {
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    } catch {
      // Best-effort
    }
  }

  async #performSync(options: { flushUploads: boolean; minGeneration?: number }): Promise<StandbyReplicaState | null> {
    const prev = readReplicaState(this.#replicaDir);
    const prevGen = prev?.generation ?? 0;
    this.#updateStatus({
      state: "syncing",
      syncedGeneration: prevGen,
      ...(prev?.syncedAt ? { syncedAt: prev.syncedAt } : {}),
      ...(this.#lastStatus.pendingUploadFiles !== undefined ? { pendingUploadFiles: this.#lastStatus.pendingUploadFiles } : {}),
    });

    try {
      const keys = await this.#cfg.getNodeKeys();
      const senderIdentityPub = this.#cfg.getPrimaryIdentityPublicKey();
      if (!senderIdentityPub) {
        throw new Error("缺少主机身份公钥，无法验证同步通道。");
      }

      let attempts = 0;
      while (attempts < 2) {
        attempts += 1;
        const manifest = await this.#fetchEncryptedJson<ClusterSyncManifest>(
          "GET",
          "/api/cluster/sync/manifest",
          undefined,
          "manifest",
          keys,
          senderIdentityPub,
        );
        this.#lastManifest = manifest;

        const minEpoch = this.#cfg.getClusterEpoch();
        if (manifest.hubId !== this.#cfg.hubId) {
          throw new Error("同步清单集群标识不匹配。");
        }
        if (manifest.clusterEpoch < minEpoch) {
          throw new Error("拒绝低代次主机的过期同步清单。");
        }
        if (
          prev &&
          prev.hubId === manifest.hubId &&
          (manifest.clusterEpoch < prev.epoch ||
            (manifest.clusterEpoch === prev.epoch && manifest.generation < prev.generation))
        ) {
          throw new Error("拒绝回退到旧代次的同步快照。");
        }

        const coreAlreadySynced = Boolean(
          prev &&
          prev.hubId === manifest.hubId &&
          prev.epoch === manifest.clusterEpoch &&
          prev.generation === manifest.generation &&
          !prev.pendingVaultEnvelope &&
          (options.minGeneration === undefined || prev.generation >= options.minGeneration),
        );

        let nextState: StandbyReplicaState;
        if (coreAlreadySynced && prev) {
          nextState = { ...prev };
        } else {
          try {
            nextState = await this.#stageAndCommitCore(manifest, prev, keys, senderIdentityPub);
          } catch (error) {
            if (error instanceof ClusterSyncHttpError && error.status === 410 && attempts < 2) {
              continue;
            }
            throw error;
          }
        }

        const missingUploads = this.#countMissingUploads(manifest);
        if (options.flushUploads) {
          await this.#syncUploads(manifest, keys, senderIdentityPub);
          const remaining = this.#countMissingUploads(manifest);
          nextState = { ...nextState, uploadsComplete: remaining === 0 };
          writeFileAtomic(path.join(this.#replicaDir, "replica-state.json"), `${JSON.stringify(nextState, null, 2)}\n`, 0o600);
          this.#updateStatus({
            state: nextState.pendingVaultEnvelope ? "error" : "synced",
            syncedGeneration: nextState.generation,
            latestGeneration: manifest.generation,
            syncedAt: nextState.syncedAt,
            pendingUploadFiles: remaining,
            ...(nextState.pendingVaultEnvelope ? { vaultPending: true, error: "系统密钥库已锁定，凭据待解锁写入。" } : {}),
          });
        } else {
          nextState = { ...nextState, uploadsComplete: missingUploads === 0 };
          writeFileAtomic(path.join(this.#replicaDir, "replica-state.json"), `${JSON.stringify(nextState, null, 2)}\n`, 0o600);
          this.#updateStatus({
            state: nextState.pendingVaultEnvelope ? "error" : "synced",
            syncedGeneration: nextState.generation,
            latestGeneration: manifest.generation,
            syncedAt: nextState.syncedAt,
            pendingUploadFiles: missingUploads,
            ...(nextState.pendingVaultEnvelope ? { vaultPending: true, error: "系统密钥库已锁定，凭据待解锁写入。" } : {}),
          });
          if (missingUploads > 0 && !this.#uploadInFlight && !this.#stopped) {
            this.#uploadInFlight = this.#syncUploads(manifest, keys, senderIdentityPub)
              .then(() => {
                const rem = this.#countMissingUploads(manifest);
                const latest = readReplicaState(this.#replicaDir);
                if (latest && latest.generation === manifest.generation) {
                  const updated: StandbyReplicaState = { ...latest, uploadsComplete: rem === 0 };
                  writeFileAtomic(path.join(this.#replicaDir, "replica-state.json"), `${JSON.stringify(updated, null, 2)}\n`, 0o600);
                }
                this.#updateStatus({
                  ...this.#lastStatus,
                  pendingUploadFiles: rem,
                });
              })
              .catch(() => {
                // Background uploads retry on next cycle
              })
              .finally(() => {
                this.#uploadInFlight = null;
              });
          }
        }
        return nextState;
      }
      return null;
    } catch (error) {
      if (error instanceof ClusterSyncHttpError && error.status === 403 && error.code === "standby_revoked") {
        await this.wipeStandby();
        this.#cfg.onRevoked?.();
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#updateStatus({
        state: "error",
        syncedGeneration: prevGen,
        ...(prev?.syncedAt ? { syncedAt: prev.syncedAt } : {}),
        error: message,
      });
      return null;
    }
  }

  async #stageAndCommitCore(
    manifest: ClusterSyncManifest,
    prev: StandbyReplicaState | null,
    keys: ClusterNodeKeyMaterial,
    senderIdentityPub: string,
  ): Promise<StandbyReplicaState> {
    fs.mkdirSync(this.#stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = path.join(this.#stagingRoot, `gen-${manifest.generation}-${randomBytes(4).toString("hex")}`);
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });

    try {
      // 1. Reconstruct SQLite databases via page-level diff
      for (const dbEntry of manifest.sqlite) {
        const stagedDb = path.join(stageDir, dbEntry.name);
        const existingDb = path.join(this.#replicaDir, dbEntry.name);
        await this.#syncSqliteDatabase(manifest.generation, dbEntry, existingDb, stagedDb, keys, senderIdentityPub);
      }

      // 2. Sync Tier 3 files
      for (const fileEntry of manifest.files) {
        if (!isSafeSyncRelativePath(fileEntry.path)) {
          throw new Error(`同步清单包含非法路径：${fileEntry.path}`);
        }
        const stagedFile = safeResolveUnder(stageDir, fileEntry.path);
        fs.mkdirSync(path.dirname(stagedFile), { recursive: true, mode: 0o700 });
        const existingFile = safeResolveUnder(this.#replicaDir, fileEntry.path);
        if (fs.existsSync(existingFile)) {
          try {
            const existingInfo = sha256File(existingFile);
            if (existingInfo.size === fileEntry.size && existingInfo.sha256 === fileEntry.sha256) {
              fs.copyFileSync(existingFile, stagedFile);
              continue;
            }
          } catch {
            // Re-fetch cleanly
          }
        }
        const qs = new URLSearchParams({ generation: String(manifest.generation), path: fileEntry.path });
        const resp = await this.#fetchEncryptedJson<ClusterSyncFileChunkResponse>(
          "GET",
          `/api/cluster/sync/file?${qs.toString()}`,
          undefined,
          `file:${fileEntry.path}:0`,
          keys,
          senderIdentityPub,
        );
        const content = Buffer.from(resp.dataBase64, "base64");
        if (content.length !== fileEntry.size) {
          throw new Error(`文件 ${fileEntry.path} 长度校验失败。`);
        }
        const actualSha = createHash("sha256").update(content).digest("hex");
        if (actualSha !== fileEntry.sha256) {
          throw new Error(`文件 ${fileEntry.path} 摘要校验失败。`);
        }
        writeFileAtomic(stagedFile, content, 0o600);
      }

      // 3. Vault Single-Generation Atomic Barrier (P0-6)
      const needsVaultFetch =
        !prev ||
        prev.vaultRevision !== manifest.vaultRevision ||
        prev.pendingVaultEnvelope ||
        (!fs.existsSync(path.join(this.#replicaDir, "connection-vault.json")) && manifest.vaultCount > 0);

      let pendingVaultEnvelope = false;
      let vaultAction: "copy-existing" | "write-staged-vault" | "write-staged-envelope" = "copy-existing";
      if (needsVaultFetch) {
        const qs = new URLSearchParams({ generation: String(manifest.generation) });
        const { envelope, plaintext } = await this.#fetchAndDecryptEnvelope(
          "GET",
          `/api/cluster/sync/vault?${qs.toString()}`,
          undefined,
          "vault",
          keys,
          senderIdentityPub,
        );
        let payload: ClusterSyncVaultPayload;
        try {
          payload = JSON.parse(plaintext.toString("utf8")) as ClusterSyncVaultPayload;
        } finally {
          plaintext.fill(0);
        }
        if (payload.version !== 1 || payload.generation !== manifest.generation || !Array.isArray(payload.entries)) {
          throw new Error("凭据同步数据格式无效。");
        }
        const stagedVault = new LocalConnectionVault({
          stateDir: stageDir,
          helperStateDir: this.#cfg.hubStateDir,
          namespaceOverride: createStandbyVaultNamespace(this.#cfg.dataDir),
          keyStore: this.#cfg.keyStore,
        });
        try {
          await stagedVault.replaceAllEntries(payload.entries);
          vaultAction = "write-staged-vault";
        } catch (error) {
          if (
            error instanceof ConnectionVaultError &&
            (error.code === "connection_vault_locked" || error.code === "connection_vault_unavailable")
          ) {
            // Keychain locked while screen asleep: atomically persist verified signed E2E envelope
            // alongside this generation so SQLite never advances ahead of Vault (P0-6).
            writeFileAtomic(path.join(stageDir, "vault-envelope.enc"), JSON.stringify(envelope), 0o600);
            pendingVaultEnvelope = true;
            vaultAction = "write-staged-envelope";
          } else {
            throw error;
          }
        }
      }

      // 4. Commit staged generation into `standby/replica/`
      verifyStagedManifestBuiltinMemory(stageDir, manifest);
      fs.mkdirSync(this.#replicaDir, { recursive: true, mode: 0o700 });
      const presentDbs = new Set(manifest.sqlite.map((s) => s.name));
      for (const reqDb of manifest.requiredDbs ?? []) {
        if (!presentDbs.has(reqDb)) throw new Error(`同步快照缺少必需数据库：${reqDb}`);
      }
      for (const dbName of CLUSTER_SYNC_SQLITE_DBS) {
        const dst = path.join(this.#replicaDir, dbName);
        if (presentDbs.has(dbName)) fs.renameSync(path.join(stageDir, dbName), dst);
        else fs.rmSync(dst, { force: true });
      }

      const presentTier3 = new Set(manifest.files.map((f) => f.path));
      for (const fileEntry of manifest.files) {
        const src = safeResolveUnder(stageDir, fileEntry.path);
        const dst = safeResolveUnder(this.#replicaDir, fileEntry.path);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.renameSync(src, dst);
        if (isTrustedSshKnownHostsPath(fileEntry.path)) fs.chmodSync(dst, 0o600);
      }
      // Prune deleted Tier 3 fixed files + identity/** + skills/** + connection-runtime/**
      for (const fixed of TIER3_FIXED_FILES) {
        if (!presentTier3.has(fixed)) {
          fs.rmSync(path.join(this.#replicaDir, fixed), { force: true });
        }
      }
      for (const sub of ["identity", "skills", "connection-runtime"] as const) {
        const subDir = path.join(this.#replicaDir, sub);
        for (const existing of walkRegularFiles(subDir, sub)) {
          if (!presentTier3.has(existing.relPath)) {
            fs.rmSync(existing.absPath, { force: true });
          }
        }
      }
      enforceConnectionRuntimePermissions(this.#replicaDir);

      const replicaVaultPath = path.join(this.#replicaDir, "connection-vault.json");
      const replicaEnvelopePath = path.join(this.#replicaDir, "vault-envelope.enc");
      if (vaultAction === "write-staged-vault") {
        const stagedVaultPath = path.join(stageDir, "connection-vault.json");
        if (fs.existsSync(stagedVaultPath)) {
          fs.renameSync(stagedVaultPath, replicaVaultPath);
        } else {
          fs.rmSync(replicaVaultPath, { force: true });
        }
        fs.rmSync(replicaEnvelopePath, { force: true });
      } else if (vaultAction === "write-staged-envelope") {
        fs.renameSync(path.join(stageDir, "vault-envelope.enc"), replicaEnvelopePath);
      }

      const nextState: StandbyReplicaState = {
        version: 1,
        hubId: manifest.hubId,
        primaryNodeId: manifest.primaryNodeId,
        epoch: manifest.clusterEpoch,
        generation: manifest.generation,
        vaultRevision: manifest.vaultRevision,
        syncedAt: Date.now(),
        pendingVaultEnvelope,
        uploadsComplete: this.#countMissingUploads(manifest) === 0,
        ...(manifest.builtinMemoryMeta ? { builtinMemoryMeta: manifest.builtinMemoryMeta } : {}),
      };
      writeFileAtomic(path.join(this.#replicaDir, "replica-state.json"), `${JSON.stringify(nextState, null, 2)}\n`, 0o600);
      return nextState;
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  async #syncSqliteDatabase(
    generation: number,
    entry: ClusterSyncSqliteEntry,
    existingPath: string,
    stagedPath: string,
    keys: ClusterNodeKeyMaterial,
    senderIdentityPub: string,
  ): Promise<void> {
    const remoteHashes = gunzipSync(Buffer.from(entry.pageHashesGzipBase64, "base64"));
    if (remoteHashes.length !== entry.pageCount * PAGE_HASH_TRUNCATED_BYTES) {
      throw new Error(`数据库 ${entry.name} 页哈希长度异常。`);
    }

    let localHashes: Buffer | null = null;
    let localPageCount = 0;
    if (fs.existsSync(existingPath)) {
      try {
        const local = computeSqlitePageHashes(existingPath, entry.pageSize);
        if (local.size === entry.size && local.sha256 === entry.sha256) {
          fs.copyFileSync(existingPath, stagedPath);
          verifySqliteQuickCheck(stagedPath);
          return;
        }
        fs.copyFileSync(existingPath, stagedPath);
        localHashes = local.pageHashes;
        localPageCount = local.pageCount;
      } catch {
        fs.rmSync(stagedPath, { force: true });
      }
    }

    const diffPages: number[] = [];
    for (let page = 0; page < entry.pageCount; page++) {
      const start = page * PAGE_HASH_TRUNCATED_BYTES;
      const end = start + PAGE_HASH_TRUNCATED_BYTES;
      if (
        !localHashes ||
        page >= localPageCount ||
        !remoteHashes.subarray(start, end).equals(localHashes.subarray(start, end))
      ) {
        diffPages.push(page);
      }
    }

    const applyPages = async (pagesToFetch: number[]): Promise<void> => {
      if (!fs.existsSync(stagedPath)) {
        fs.closeSync(fs.openSync(stagedPath, "w", 0o600));
      }
      const fd = fs.openSync(stagedPath, "r+");
      try {
        for (let i = 0; i < pagesToFetch.length; i += CLUSTER_SYNC_MAX_PAGES_PER_REQUEST) {
          const batch = pagesToFetch.slice(i, i + CLUSTER_SYNC_MAX_PAGES_PER_REQUEST);
          const resp = await this.#fetchEncryptedJson<ClusterSyncSqlitePagesResponse>(
            "POST",
            "/api/cluster/sync/sqlite-pages",
            { generation, db: entry.name, pages: batch },
            `sqlite-pages:${entry.name}`,
            keys,
            senderIdentityPub,
          );
          for (const chunk of resp.chunks) {
            const buf = Buffer.from(chunk.dataBase64, "base64");
            fs.writeSync(fd, buf, 0, buf.length, chunk.page * entry.pageSize);
          }
        }
        fs.ftruncateSync(fd, entry.size);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    };

    await applyPages(diffPages);
    let actual = sha256File(stagedPath);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
      // One full-page fallback rebuild before failing the generation.
      fs.rmSync(stagedPath, { force: true });
      const allPages = Array.from({ length: entry.pageCount }, (_, i) => i);
      await applyPages(allPages);
      actual = sha256File(stagedPath);
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
        throw new Error(`数据库 ${entry.name} 全量校验失败。`);
      }
    }
    verifySqliteQuickCheck(stagedPath);
  }

  #countMissingUploads(manifest: ClusterSyncManifest): number {
    let missing = 0;
    for (const item of manifest.uploads) {
      const target = safeResolveUnder(this.#replicaDir, item.path);
      if (!fs.existsSync(target)) {
        missing += 1;
        continue;
      }
      try {
        const st = fs.lstatSync(target);
        if (!st.isFile() || st.size !== item.size) missing += 1;
      } catch {
        missing += 1;
      }
    }
    return missing;
  }

  async #syncUploads(
    manifest: ClusterSyncManifest,
    keys: ClusterNodeKeyMaterial,
    senderIdentityPub: string,
  ): Promise<void> {
    const present = new Set(manifest.uploads.map((u) => u.path));
    // Prune deleted uploads
    const uploadsRoot = path.join(this.#replicaDir, "uploads");
    for (const existing of walkRegularFiles(uploadsRoot, "uploads", { skipNames: shouldSkipUploadEntry })) {
      if (!present.has(existing.relPath)) {
        fs.rmSync(existing.absPath, { force: true });
      }
    }

    const queue = [...manifest.uploads];
    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !this.#stopped) {
        const item = queue.shift()!;
        if (!isSafeSyncRelativePath(item.path)) continue;
        const dst = safeResolveUnder(this.#replicaDir, item.path);
        if (fs.existsSync(dst)) {
          try {
            const info = sha256File(dst);
            if (info.size === item.size && info.sha256 === item.sha256) continue;
          } catch {
            // Re-download
          }
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        const partFile = `${dst}.part`;
        let offset = 0;
        if (fs.existsSync(partFile)) {
          try {
            const st = fs.lstatSync(partFile);
            if (st.isFile() && !st.isSymbolicLink() && st.size <= item.size) {
              offset = st.size;
            } else {
              fs.rmSync(partFile, { force: true });
            }
          } catch {
            fs.rmSync(partFile, { force: true });
          }
        }
        while (offset < item.size || (item.size === 0 && offset === 0)) {
          if (this.#stopped) return;
          const length = Math.min(CLUSTER_SYNC_UPLOAD_CHUNK_BYTES, item.size - offset);
          const qs = new URLSearchParams({
            generation: String(manifest.generation),
            path: item.path,
            offset: String(offset),
            length: String(length),
          });
          const resp = await this.#fetchEncryptedJson<ClusterSyncFileChunkResponse>(
            "GET",
            `/api/cluster/sync/file?${qs.toString()}`,
            undefined,
            `file:${item.path}:${offset}`,
            keys,
            senderIdentityPub,
          );
          const buf = Buffer.from(resp.dataBase64, "base64");
          const fd = fs.openSync(partFile, offset === 0 ? "w" : "a", 0o600);
          try {
            if (buf.length > 0) fs.writeSync(fd, buf, 0, buf.length);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          offset += buf.length;
          if (item.size === 0) break;
          if (buf.length === 0) throw new Error(`附件 ${item.path} 下载中断。`);
        }
        const verified = sha256File(partFile);
        if (verified.size !== item.size || verified.sha256 !== item.sha256) {
          fs.rmSync(partFile, { force: true });
          throw new Error(`附件 ${item.path} 校验失败。`);
        }
        fs.renameSync(partFile, dst);
      }
    };

    const concurrency = Math.min(2, Math.max(1, queue.length));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  async #fetchEncryptedJson<T>(
    method: "GET" | "POST",
    pathWithQuery: string,
    body: unknown,
    expectedResourceId: string,
    keys: ClusterNodeKeyMaterial,
    senderIdentityPub: string,
  ): Promise<T> {
    const { plaintext } = await this.#fetchAndDecryptEnvelope(
      method,
      pathWithQuery,
      body,
      expectedResourceId,
      keys,
      senderIdentityPub,
    );
    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  async #fetchAndDecryptEnvelope(
    method: "GET" | "POST",
    pathWithQuery: string,
    body: unknown,
    expectedResourceId: string,
    keys: ClusterNodeKeyMaterial,
    senderIdentityPub: string,
  ): Promise<{ envelope: ClusterEncryptedEnvelope; plaintext: Buffer }> {
    const primaryUrl = this.#cfg.getPrimaryUrl().replace(/\/$/, "");
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const { header, nonce } = createClusterAuthHeader({
      secret: this.#cfg.syncToken,
      nodeId: this.#cfg.nodeId,
      method,
      pathWithQuery,
      body: serializedBody,
    });
    const res = await fetch(`${primaryUrl}${pathWithQuery}`, {
      method,
      headers: {
        [CLUSTER_AUTH_HEADER]: header,
        ...(serializedBody !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      signal: AbortSignal.any([this.#stopController.signal, AbortSignal.timeout(30_000)]),
    });
    const raw = await res.text();
    if (!res.ok) {
      let code = "sync_http_error";
      let message = `同步请求失败（HTTP ${res.status}）`;
      try {
        const parsed = JSON.parse(raw) as { code?: string; error?: string };
        if (parsed.code) code = parsed.code;
        if (parsed.error) message = parsed.error;
      } catch {
        // Keep fallback message
      }
      throw new ClusterSyncHttpError(res.status, code, message);
    }
    const envelope = JSON.parse(raw) as ClusterEncryptedEnvelope;
    const plaintext = verifyAndDecryptClusterEnvelope({
      envelope,
      expectedHubId: this.#cfg.hubId,
      expectedMinEpoch: this.#cfg.getClusterEpoch(),
      expectedTargetNodeId: this.#cfg.nodeId,
      expectedRequestNonce: nonce,
      expectedResourceId,
      expectedSenderIdentityPublicKey: senderIdentityPub,
      recipientX25519PrivateDerB64: keys.x25519PrivateDerB64,
    });
    return { envelope, plaintext };
  }
}
