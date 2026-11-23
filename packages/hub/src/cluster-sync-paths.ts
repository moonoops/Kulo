import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SYNC_META_FILE = "cluster-sync-meta.json";

export const CLUSTER_SYNC_SQLITE_DBS = ["kulo.sqlite", "assistant.sqlite", "memory.sqlite"] as const;
export type ClusterSyncSqliteDbName = (typeof CLUSTER_SYNC_SQLITE_DBS)[number];
export const CLUSTER_SYNC_SQLITE_SET: ReadonlySet<string> = new Set(CLUSTER_SYNC_SQLITE_DBS);
export const CLUSTER_SYNC_SQLITE_WAL_SHM: readonly string[] = CLUSTER_SYNC_SQLITE_DBS.flatMap((n) => [`${n}-wal`, `${n}-shm`]);
export const CLUSTER_SYNC_STALE_SQLITE_ARTIFACTS: readonly string[] = [
  ...CLUSTER_SYNC_SQLITE_DBS,
  ...CLUSTER_SYNC_SQLITE_WAL_SHM,
  "kulo.sqlite.redaction-pending",
  "memory.sqlite.redaction-pending",
  "conversation-history.sqlite",
  "conversation-history.sqlite-wal",
  "conversation-history.sqlite-shm",
  "backups",
];
export const CLUSTER_CONFLICT_CORE_FILES: readonly string[] = [
  ...CLUSTER_SYNC_SQLITE_DBS,
  ...CLUSTER_SYNC_SQLITE_WAL_SHM,
  "devices.json",
  "connections.json",
  SYNC_META_FILE,
];
export const CLUSTER_BUILTIN_MEMORY_CAPABILITY = "builtin-memory-v1";
export const BUILTIN_MEMORY_FAILOVER_PAUSE_FILE = "memory.sqlite.failover-paused";
export const SUPPORTED_STANDBY_SYNC_CAPABILITIES: ReadonlySet<string> = new Set([CLUSTER_BUILTIN_MEMORY_CAPABILITY]);

export function parseReplicaBuiltinMemoryMeta(raw: unknown): { clearTargetEpoch: number; appliedClearEpoch: number; lastAppliedSeq: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.clearTargetEpoch !== "number" || typeof r.appliedClearEpoch !== "number" || typeof r.lastAppliedSeq !== "number") return undefined;
  return { clearTargetEpoch: r.clearTargetEpoch, appliedClearEpoch: r.appliedClearEpoch, lastAppliedSeq: r.lastAppliedSeq };
}

export function verifyStagedManifestBuiltinMemory(
  stageDir: string,
  manifest: { requiredCapabilities?: string[]; builtinMemoryMeta?: { clearTargetEpoch: number; appliedClearEpoch: number } },
): void {
  for (const cap of manifest.requiredCapabilities ?? []) {
    if (!SUPPORTED_STANDBY_SYNC_CAPABILITIES.has(cap)) {
      throw new Error(`当前备用主机不支持同步能力：${cap}`);
    }
  }
  const check = verifyReplicaBuiltinMemoryMeta(stageDir, manifest.builtinMemoryMeta);
  if (!check.ok) {
    throw new Error(`同步快照内置记忆校验失败（${check.reason ?? "unverified"}）。`);
  }
}

/** Verifies that a replicated `memory.sqlite` matches the expected clear epoch when present in replica metadata. */
export function verifyReplicaBuiltinMemoryMeta(
  replicaDir: string,
  meta?: { clearTargetEpoch: number; appliedClearEpoch: number },
): { ok: boolean; reason?: string } {
  if (!meta) return { ok: true };
  if (meta.appliedClearEpoch < meta.clearTargetEpoch) {
    return { ok: false, reason: "primary_clear_incomplete" };
  }
  const dbPath = path.join(replicaDir, "memory.sqlite");
  if (!fs.existsSync(dbPath)) {
    return meta.clearTargetEpoch === 0 ? { ok: true } : { ok: false, reason: "memory_db_missing" };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'applied_clear_epoch'").get() as { value?: string } | undefined;
    const applied = Number(row?.value ?? 0);
    if (!Number.isSafeInteger(applied) || applied < meta.clearTargetEpoch) {
      return { ok: false, reason: "replica_clear_epoch_behind" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "memory_db_unreadable" };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export const TIER3_FIXED_FILES = [
  "devices.json",
  "connections.json",
  "state-version.json",
  "models-cache.json",
  "model-metadata-cache.json",
  "android-notification-decisions.json",
  "device-ssh-known-hosts",
  SYNC_META_FILE,
] as const;

export const CONNECTION_KNOWN_HOSTS_PATH = /^connection-runtime\/connection-[a-f0-9-]{16,64}\.known-hosts$/;
const CONNECTION_KNOWN_HOSTS_FILENAME = /^(connection-[a-f0-9-]{16,64})\.known-hosts$/;
export const MAX_SYNC_KNOWN_HOSTS_BYTES = 64 * 1024;

export function isTrustedSshKnownHostsPath(relPath: string): boolean {
  return CONNECTION_KNOWN_HOSTS_PATH.test(relPath);
}

export function isSafeSyncRelativePath(relPath: string): boolean {
  if (!relPath || relPath.length > 512 || relPath.includes("\0") || relPath.includes("\\")) return false;
  if (relPath.startsWith("/") || relPath.endsWith("/")) return false;
  const parts = relPath.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return false;
  if ((TIER3_FIXED_FILES as readonly string[]).includes(relPath)) return true;
  if (CONNECTION_KNOWN_HOSTS_PATH.test(relPath)) return true;
  if (relPath.startsWith("identity/") || relPath.startsWith("skills/") || relPath.startsWith("uploads/")) {
    return parts.length >= 2;
  }
  return false;
}

export function shouldSkipTempFile(name: string): boolean {
  return name.endsWith(".tmp") || name.endsWith(".part") || name.endsWith(".lock") || name === ".DS_Store";
}

export function shouldSkipUploadEntry(name: string): boolean {
  return shouldSkipTempFile(name) || name === "drafts" || name === ".incomplete";
}

export function walkRegularFiles(
  rootDir: string,
  prefix: string,
  options: { skipNames?: (name: string) => boolean } = {},
): Array<{ relPath: string; absPath: string; size: number; mtimeMs: number }> {
  const results: Array<{ relPath: string; absPath: string; size: number; mtimeMs: number }> = [];
  if (!fs.existsSync(rootDir)) return results;
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(rootDir);
  } catch {
    return results;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return results;

  const visit = (dirAbs: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (options.skipNames?.(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (st.isDirectory()) {
        visit(abs, rel);
      } else if (st.isFile()) {
        results.push({ relPath: `${prefix}/${rel}`, absPath: abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
  };
  visit(rootDir, "");
  return results;
}

/** Reads the snapshot's `connections.json` and extracts IDs of SSH connections with an explicit trusted fingerprint. */
export function collectTrustedSshConnectionIds(connectionsJsonPath: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(connectionsJsonPath)) return ids;
  try {
    const raw = JSON.parse(fs.readFileSync(connectionsJsonPath, "utf8")) as {
      connections?: Record<string, { kind?: unknown; trustedHostFingerprint?: unknown }>;
    };
    for (const [id, rec] of Object.entries(raw?.connections ?? {})) {
      if (
        /^connection-[a-f0-9-]{16,64}$/.test(id) &&
        rec?.kind === "ssh" &&
        typeof rec.trustedHostFingerprint === "string" &&
        rec.trustedHostFingerprint.length > 0
      ) {
        ids.add(id);
      }
    }
  } catch {
    // Ignore malformed snapshot; no SSH known-hosts will be synced.
  }
  return ids;
}

/** Collects allowlisted, bounded, non-symlink `.known-hosts` files matching trusted SSH records in `connections.json`. */
export function collectTrustedSshKnownHostsFiles(
  stateDir: string,
  trustedIds: ReadonlySet<string>,
): Array<{ relPath: string; absPath: string; size: number; mtimeMs: number }> {
  if (trustedIds.size === 0) return [];
  const runtimeDir = path.join(stateDir, "connection-runtime");
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(runtimeDir);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const results: Array<{ relPath: string; absPath: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    const match = CONNECTION_KNOWN_HOSTS_FILENAME.exec(entry.name);
    if (!match || !trustedIds.has(match[1]!)) continue;
    const absPath = path.join(runtimeDir, entry.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(absPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > MAX_SYNC_KNOWN_HOSTS_BYTES) continue;
    results.push({
      relPath: `connection-runtime/${entry.name}`,
      absPath,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    });
  }
  return results;
}

export function enforceConnectionRuntimePermissions(rootDir: string): void {
  const runtimeDir = path.join(rootDir, "connection-runtime");
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(runtimeDir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || process.platform === "win32") return;
  fs.chmodSync(runtimeDir, 0o700);
  for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
    if (!CONNECTION_KNOWN_HOSTS_FILENAME.test(entry.name)) continue;
    const abs = path.join(runtimeDir, entry.name);
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && !st.isSymbolicLink()) fs.chmodSync(abs, 0o600);
    } catch {
      // Best-effort permission normalization.
    }
  }
}
