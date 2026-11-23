/**
 * Multi-Hub Cluster Lifecycle: Promotion, Crash Recovery, Pre-Start Fence,
 * Runtime Mutual Fence Monitor, and StandbyHostBridge Factory (Phase 3).
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  isAuthorityHigher,
  type ClusterConflictBackupNotice,
  type ClusterHubEndpoint,
  type ClusterNodeStatus,
  type ClusterSyncAvailableNotification,
  type ClusterSyncStatus,
  type ClusterTopology,
  type DevicePeerConfig,
} from "@kulo/protocol";
import {
  CLUSTER_AUTH_HEADER,
  HUB_STATE_LOCK_FILES,
  KULO_RUNTIME_INSTANCE_FILES,
  createClusterAuthHeader,
  probeUrlsHappyEyeballs,
  readClusterMembership,
  readOrCreateNodeIdentity,
  removePeerConfig,
  saveClusterMembership,
  savePeerConfig,
  verifyAndDecryptClusterEnvelope,
  type ClusterEncryptedEnvelope,
  type ClusterMembership,
  type ClusterNodeKeyMaterial,
  type StandbyHostBridge,
} from "@kulo/env";
import {
  LocalConnectionVault,
  createStandbyVaultNamespace,
  type ConnectionSecretFields,
  type ConnectionVaultKeyStore,
} from "./connection-vault.js";
import {
  StandbyReplicator,
  ensureLocalClusterKeys,
  readReplicaState,
  readSyncMeta,
  type ClusterSyncVaultPayload,
} from "./cluster-sync.js";
import { MANAGED_IDENTITY_DIRECTORY_KEY } from "./identity-files.js";
import {
  BUILTIN_MEMORY_FAILOVER_PAUSE_FILE,
  CLUSTER_CONFLICT_CORE_FILES,
  CLUSTER_SYNC_SQLITE_DBS,
  CLUSTER_SYNC_SQLITE_WAL_SHM,
  CLUSTER_SYNC_STALE_SQLITE_ARTIFACTS,
  enforceConnectionRuntimePermissions,
  verifyReplicaBuiltinMemoryMeta,
} from "./cluster-sync-paths.js";

const MAX_ARCHIVED_BACKUPS = 3;
const PRE_START_PROBE_TIMEOUT_MS = 3_000;
const FENCE_INTERVAL_MS = 15_000;

/** Local host-owned Hub entries that must NEVER be overwritten or deleted during promotion. */
const PRESERVED_LOCAL_HUB_ENTRIES = new Set([
  ".secure", "managed-hindsight", "memory-llm-bridge.json", "voice", "cache",
  "runtime-token", "device-id", "workspace", "extensions", ".kulo-hub.lock",
  ...KULO_RUNTIME_INSTANCE_FILES, ...HUB_STATE_LOCK_FILES,
]);

export interface ClusterPaths {
  dataDir: string;
  hubStateDir: string;
  peerConfigPath: string;
  nodeIdentityPath: string;
  clusterMembershipPath: string;
  clusterTransitionPath: string;
  standbyDir: string;
  standaloneBackupsDir: string;
  clusterConflictBackupsDir: string;
  conflictNoticePath: string;
}

export function resolveClusterPaths(
  dataDir: string,
  options: { hubStateDir?: string; peerConfigPath?: string } = {},
): ClusterPaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    hubStateDir: path.resolve(options.hubStateDir ?? path.join(root, "hub")),
    peerConfigPath: path.resolve(options.peerConfigPath ?? path.join(root, "peer.json")),
    nodeIdentityPath: path.join(root, "node-identity.json"),
    clusterMembershipPath: path.join(root, "cluster-membership.json"),
    clusterTransitionPath: path.join(root, "cluster-transition.json"),
    standbyDir: path.join(root, "standby"),
    standaloneBackupsDir: path.join(root, "standalone-backups"),
    clusterConflictBackupsDir: path.join(root, "cluster-conflict-backups"),
    conflictNoticePath: path.join(root, "cluster-conflict-notice.json"),
  };
}

/** Absolute paths to add to `extraProtectedPaths` so Workers & ExternalAgents cannot read cluster secrets (P0-8). */
export function getClusterProtectedPaths(paths: ClusterPaths): string[] {
  return [
    paths.standbyDir,
    paths.standaloneBackupsDir,
    paths.clusterConflictBackupsDir,
    paths.nodeIdentityPath,
    paths.clusterMembershipPath,
    paths.clusterTransitionPath,
    paths.conflictNoticePath,
    paths.peerConfigPath,
  ];
}

interface StoredDeviceLite {
  id: string;
  name: string;
  envToken: string;
  clientToken: string;
  rootDir: string;
  pairedAt?: number;
  standby?: boolean;
  standbyPriority?: number;
  syncToken?: string;
  standbyPublicKey?: string;
  identityPublicKey?: string;
  listenPort?: number;
  info?: { ips?: string[] };
}

interface DevicesFileLite {
  version: 1;
  hubId: string;
  enabled: boolean;
  localName?: string;
  localNodeId?: string;
  legacyLocalNodeId?: string;
  clusterEpoch?: number;
  primaryNodeId?: string;
  preferredPrimaryNodeId?: string;
  identityPublicKey?: string;
  revokedIds?: string[];
  devices: StoredDeviceLite[];
  [key: string]: unknown;
}

interface ClusterTransitionLog {
  version: 1;
  action: "promote";
  hubId: string;
  nodeId: string;
  targetEpoch: number;
  reason: "failover" | "handover";
  stage: "archiving" | "copying" | "vault" | "finalizing";
  startedAt: number;
  primaryIdentityPublicKey?: string;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readDevicesFile(filePath: string): DevicesFileLite | null {
  const parsed = readJsonSafe<DevicesFileLite>(filePath);
  if (!parsed || parsed.version !== 1 || typeof parsed.hubId !== "string" || !Array.isArray(parsed.devices)) {
    return null;
  }
  return parsed;
}

function pruneOldBackups(parentDir: string, prefix: string, maxKeep = MAX_ARCHIVED_BACKUPS): void {
  if (!fs.existsSync(parentDir)) return;
  try {
    const dirs = fs.readdirSync(parentDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const abs = path.join(parentDir, name);
        let mtime = 0;
        try { mtime = fs.lstatSync(abs).mtimeMs; } catch { /* ignore */ }
        return { name, abs, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const stale of dirs.slice(maxKeep)) {
      fs.rmSync(stale.abs, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

function copyTreeNonDestructive(srcDir: string, dstDir: string, options?: { skipNames?: Set<string> }): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (options?.skipNames?.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      copyTreeNonDestructive(src, dst);
    } else if (st.isFile()) {
      fs.copyFileSync(src, dst);
      if (process.platform !== "win32") {
        try { fs.chmodSync(dst, 0o600); } catch { /* ignore */ }
      }
    }
  }
}

function normalizeManagedIdentityBackups(identityDir: string): void {
  const backupsDir = path.join(identityDir, ".backups");
  if (!fs.existsSync(backupsDir)) return;
  try {
    for (const name of fs.readdirSync(backupsDir)) {
      if (!name.endsWith(".bak.json")) continue;
      const abs = path.join(backupsDir, name);
      const parsed = readJsonSafe<Record<string, unknown>>(abs);
      if (parsed && typeof parsed.directoryIdentity === "string" && parsed.directoryIdentity !== MANAGED_IDENTITY_DIRECTORY_KEY) {
        parsed.directoryIdentity = MANAGED_IDENTITY_DIRECTORY_KEY;
        writeJsonAtomic(abs, parsed);
      }
    }
  } catch {
    // Non-fatal
  }
}

function verifySqliteFile(filePath: string): void {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== "ok") {
      throw new Error(`数据库完整性校验失败：${path.basename(filePath)}`);
    }
  } finally {
    db.close();
  }
}

export function readConflictBackupNotice(paths: ClusterPaths): ClusterConflictBackupNotice | null {
  const parsed = readJsonSafe<ClusterConflictBackupNotice>(paths.conflictNoticePath);
  if (!parsed || typeof parsed.id !== "string" || typeof parsed.createdAt !== "number" || typeof parsed.epoch !== "number") return null;
  return parsed;
}

export function clearConflictBackupNotice(paths: ClusterPaths): void {
  fs.rmSync(paths.conflictNoticePath, { force: true });
}

export interface ApplyReplicaPromotionOptions {
  nodeId: string;
  targetEpoch: number;
  reason: "failover" | "handover";
  primaryIdentityPublicKey?: string;
  keyStore?: ConnectionVaultKeyStore;
}

/**
 * Crash-idempotent promotion of `standby/replica/` into `<dataDir>/hub/`.
 * Non-destructively copies replica files so an interrupted promotion can always be replayed cleanly.
 */
export async function applyReplicaForPromotion(
  paths: ClusterPaths,
  options: ApplyReplicaPromotionOptions,
): Promise<{ hubId: string; epoch: number; archivedStandalonePath?: string }> {
  const replicaDir = path.join(paths.standbyDir, "replica");
  const replicaState = readReplicaState(replicaDir);
  if (!replicaState) {
    throw new Error("本地备用同步数据尚未就绪，无法提升为主机。");
  }
  const replicaDb = path.join(replicaDir, "kulo.sqlite");
  if (!fs.existsSync(replicaDb)) throw new Error("备用副本缺少核心数据库，无法提升为主机。");
  for (const dbName of CLUSTER_SYNC_SQLITE_DBS) {
    const dbFile = path.join(replicaDir, dbName);
    if (fs.existsSync(dbFile)) verifySqliteFile(dbFile);
  }
  const memoryMetaCheck = verifyReplicaBuiltinMemoryMeta(replicaDir, replicaState.builtinMemoryMeta);
  if (!memoryMetaCheck.ok && options.reason === "handover") {
    throw new Error(`备用副本内置记忆状态未同步完成（${memoryMetaCheck.reason}），请等待同步完成后重试。`);
  }
  const replicaDevices = readDevicesFile(path.join(replicaDir, "devices.json"));
  if (!replicaDevices || replicaDevices.hubId !== replicaState.hubId) {
    throw new Error("备用副本缺少有效的集群设备配置。");
  }

  const keys = await ensureLocalClusterKeys({
    dataDir: paths.dataDir,
    hubStateDir: paths.hubStateDir,
    standbyDir: paths.standbyDir,
    keyStore: options.keyStore,
  });

  const writeTransition = (stage: ClusterTransitionLog["stage"]) => {
    const log: ClusterTransitionLog = {
      version: 1,
      action: "promote",
      hubId: replicaState.hubId,
      nodeId: options.nodeId,
      targetEpoch: options.targetEpoch,
      reason: options.reason,
      stage,
      startedAt: Date.now(),
      ...(options.primaryIdentityPublicKey ? { primaryIdentityPublicKey: options.primaryIdentityPublicKey } : {}),
    };
    writeJsonAtomic(paths.clusterTransitionPath, log);
  };

  let archivedStandalonePath: string | undefined;

  // Stage 1: Archive non-matching standalone Hub data (including old mobile-connect/ per P2-3)
  writeTransition("archiving");
  fs.mkdirSync(paths.hubStateDir, { recursive: true, mode: 0o700 });
  const existingHubDevices = readDevicesFile(path.join(paths.hubStateDir, "devices.json"));
  const existingHubDb = path.join(paths.hubStateDir, "kulo.sqlite");
  const hasStandaloneForeignHub =
    (existingHubDevices && existingHubDevices.hubId !== replicaState.hubId) ||
    (!existingHubDevices && fs.existsSync(existingHubDb));

  if (hasStandaloneForeignHub) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveDir = path.join(paths.standaloneBackupsDir, `hub-${stamp}`);
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(paths.hubStateDir)) {
      if (PRESERVED_LOCAL_HUB_ENTRIES.has(entry)) continue;
      const src = path.join(paths.hubStateDir, entry);
      const dst = path.join(archiveDir, entry);
      fs.renameSync(src, dst);
    }
    archivedStandalonePath = archiveDir;
    pruneOldBackups(paths.standaloneBackupsDir, "hub-");
  }

  // Stage 2: Clean stale SQLite WAL/SHM/cache/backups & non-destructively copy replica -> hub/
  writeTransition("copying");
  for (const stale of CLUSTER_SYNC_STALE_SQLITE_ARTIFACTS) {
    fs.rmSync(path.join(paths.hubStateDir, stale), { recursive: true, force: true });
  }
  // Remove stale managed identity/skills/connection-runtime directories before copying exact replicated snapshot
  for (const dir of ["identity", "skills", "connection-runtime"] as const) fs.rmSync(path.join(paths.hubStateDir, dir), { recursive: true, force: true });

  const skipOnCopy = new Set([
    "replica-state.json", "connection-vault.json", "vault-envelope.enc", ".connection-vault.lock",
    "devices.json", "uploads", ...CLUSTER_SYNC_SQLITE_WAL_SHM,
  ]);
  copyTreeNonDestructive(replicaDir, paths.hubStateDir, { skipNames: skipOnCopy });
  if (!memoryMetaCheck.ok) {
    fs.writeFileSync(path.join(paths.hubStateDir, BUILTIN_MEMORY_FAILOVER_PAUSE_FILE), `${memoryMetaCheck.reason ?? "unverified"}\n`, { mode: 0o600 });
  } else {
    fs.rmSync(path.join(paths.hubStateDir, BUILTIN_MEMORY_FAILOVER_PAUSE_FILE), { force: true });
  }
  normalizeManagedIdentityBackups(path.join(paths.hubStateDir, "identity"));
  enforceConnectionRuntimePermissions(paths.hubStateDir);

  const replicaUploads = path.join(replicaDir, "uploads");
  if (fs.existsSync(replicaUploads)) {
    copyTreeNonDestructive(replicaUploads, path.join(paths.hubStateDir, "uploads"));
  }

  // Stage 3: Re-encrypt Vault into target Hub's LocalConnectionVault (P0-6)
  writeTransition("vault");
  const vaultEnvelopePath = path.join(replicaDir, "vault-envelope.enc");
  const replicaVaultPath = path.join(replicaDir, "connection-vault.json");
  let vaultEntries: Array<{ ref: string; fields: ConnectionSecretFields }> | null = null;

  if (fs.existsSync(vaultEnvelopePath)) {
    const envelope = readJsonSafe<ClusterEncryptedEnvelope>(vaultEnvelopePath);
    if (!envelope) throw new Error("待解密的备用凭据信封损坏。");
    const senderPub =
      options.primaryIdentityPublicKey ??
      replicaDevices.identityPublicKey ??
      replicaDevices.devices.find((d) => d.id === replicaState.primaryNodeId)?.identityPublicKey;
    if (!senderPub) {
      throw new Error("缺少原主机签名公钥，无法验证待解密凭据信封。");
    }
    const plaintext = verifyAndDecryptClusterEnvelope({
      envelope,
      expectedHubId: replicaState.hubId,
      expectedMinEpoch: replicaState.epoch,
      expectedTargetNodeId: options.nodeId,
      expectedResourceId: "vault",
      expectedSenderIdentityPublicKey: senderPub,
      recipientX25519PrivateDerB64: keys.x25519PrivateDerB64,
    });
    try {
      const payload = JSON.parse(plaintext.toString("utf8")) as ClusterSyncVaultPayload;
      if (payload.version !== 1 || !Array.isArray(payload.entries)) {
        throw new Error("凭据信封载荷格式无效。");
      }
      vaultEntries = payload.entries;
    } finally {
      plaintext.fill(0);
    }
  } else if (fs.existsSync(replicaVaultPath)) {
    const standbyVault = new LocalConnectionVault({
      stateDir: replicaDir,
      helperStateDir: paths.hubStateDir,
      namespaceOverride: createStandbyVaultNamespace(paths.dataDir),
      keyStore: options.keyStore,
    });
    vaultEntries = await standbyVault.entries();
  }

  if (vaultEntries !== null) {
    const hubVault = new LocalConnectionVault({
      stateDir: paths.hubStateDir,
      keyStore: options.keyStore,
    });
    await hubVault.replaceAllEntries(vaultEntries);
  }

  // Stage 4: Rewrite devices.json, cluster-membership.json, remove peer.json & transition log
  writeTransition("finalizing");
  const nextDevices: DevicesFileLite = {
    ...replicaDevices,
    enabled: true,
    localNodeId: options.nodeId,
    primaryNodeId: options.nodeId,
    clusterEpoch: options.targetEpoch,
    identityPublicKey: keys.ed25519PublicKey,
    devices: replicaDevices.devices.map((d) => {
      if (d.id === options.nodeId) {
        return {
          ...d,
          standby: true,
          standbyPublicKey: keys.x25519PublicKey,
          identityPublicKey: keys.ed25519PublicKey,
        };
      }
      return d;
    }),
  };
  const selfRec = nextDevices.devices.find((d) => d.id === options.nodeId);
  if (selfRec?.name) {
    nextDevices.localName = selfRec.name;
  }
  writeJsonAtomic(path.join(paths.hubStateDir, "devices.json"), nextDevices);

  const existingMembership = readClusterMembership(paths.clusterMembershipPath);
  const existingHubMap = new Map((existingMembership?.hubs ?? []).map((h) => [h.nodeId, h]));
  const updatedHubs: ClusterHubEndpoint[] = [];
  let standbyPrio = 1;
  for (const d of nextDevices.devices) {
    if (!d.pairedAt || !d.standby) continue;
    const prev = existingHubMap.get(d.id);
    const role: ClusterHubEndpoint["role"] = d.id === options.nodeId ? "primary" : "standby";
    updatedHubs.push({
      nodeId: d.id,
      name: d.name,
      role,
      priority: role === "primary" ? 0 : (d.standbyPriority ?? standbyPrio++),
      urls: prev?.urls ?? [],
      online: d.id === options.nodeId ? true : (prev?.online ?? false),
      ...(d.standbyPublicKey ? { standbyPublicKey: d.standbyPublicKey } : prev?.standbyPublicKey ? { standbyPublicKey: prev.standbyPublicKey } : {}),
      ...(d.identityPublicKey ? { identityPublicKey: d.identityPublicKey } : prev?.identityPublicKey ? { identityPublicKey: prev.identityPublicKey } : {}),
    });
  }

  const nextMembership: ClusterMembership = {
    version: 1,
    hubId: replicaState.hubId,
    nodeId: options.nodeId,
    myRole: "primary",
    epoch: options.targetEpoch,
    primaryNodeId: options.nodeId,
    preferredPrimaryNodeId: nextDevices.preferredPrimaryNodeId ?? options.nodeId,
    ...(selfRec?.syncToken
      ? { selfTokens: { envToken: selfRec.envToken, clientToken: selfRec.clientToken, syncToken: selfRec.syncToken } }
      : existingMembership?.selfTokens
        ? { selfTokens: existingMembership.selfTokens }
        : {}),
    hubs: updatedHubs,
    updatedAt: Date.now(),
  };
  saveClusterMembership(paths.clusterMembershipPath, nextMembership);

  removePeerConfig(paths.peerConfigPath);
  fs.rmSync(paths.clusterTransitionPath, { force: true });

  return {
    hubId: replicaState.hubId,
    epoch: options.targetEpoch,
    ...(archivedStandalonePath ? { archivedStandalonePath } : {}),
  };
}

/**
 * Replays any unfinished promotion recorded in `cluster-transition.json` before startup.
 */
export async function recoverInterruptedClusterTransition(
  paths: ClusterPaths,
  options: { keyStore?: ConnectionVaultKeyStore } = {},
): Promise<{ recovered: boolean }> {
  const log = readJsonSafe<ClusterTransitionLog>(paths.clusterTransitionPath);
  if (!log || log.version !== 1 || log.action !== "promote") {
    return { recovered: false };
  }
  const hubDevices = readDevicesFile(path.join(paths.hubStateDir, "devices.json"));
  const alreadyFinalized =
    !fs.existsSync(paths.peerConfigPath) &&
    hubDevices?.hubId === log.hubId &&
    hubDevices?.primaryNodeId === log.nodeId &&
    (hubDevices?.clusterEpoch ?? 0) >= log.targetEpoch;

  if (alreadyFinalized) {
    fs.rmSync(paths.clusterTransitionPath, { force: true });
    return { recovered: true };
  }
  await applyReplicaForPromotion(paths, {
    nodeId: log.nodeId,
    targetEpoch: log.targetEpoch,
    reason: log.reason,
    primaryIdentityPublicKey: log.primaryIdentityPublicKey,
    keyStore: options.keyStore,
  });
  return { recovered: true };
}

/* -------------------------------------------------------------------------- */
/*  Pre-Start Fence & Conflict Backup (P1-6 / P2-1)                           */
/* -------------------------------------------------------------------------- */

async function probeRemoteClusterNode(
  url: string,
  nodeId: string,
  clientSecret: string,
  timeoutMs = PRE_START_PROBE_TIMEOUT_MS,
): Promise<ClusterNodeStatus | null> {
  const pathWithQuery = "/_kulo/cluster/status";
  const { header } = createClusterAuthHeader({
    secret: clientSecret,
    nodeId,
    method: "GET",
    pathWithQuery,
  });
  const res = await fetch(`${url.replace(/\/$/, "")}${pathWithQuery}`, {
    method: "GET",
    headers: { [CLUSTER_AUTH_HEADER]: header },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Partial<ClusterNodeStatus>;
  if (
    typeof body.hubId !== "string" ||
    typeof body.nodeId !== "string" ||
    (body.role !== "primary" && body.role !== "standby" && body.role !== "peer") ||
    typeof body.epoch !== "number"
  ) {
    return null;
  }
  return body as ClusterNodeStatus;
}

export function archiveDivergedHubForConflict(
  paths: ClusterPaths,
  options: { remoteEpoch: number; remotePrimaryNodeId: string; remotePrimaryName?: string },
): string | undefined {
  const kuloDb = path.join(paths.hubStateDir, "kulo.sqlite");
  if (!fs.existsSync(kuloDb)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(paths.clusterConflictBackupsDir, `conflict-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  // Archive only compact core state files (NO duplicate `uploads/` copies, P2-1).
  for (const name of CLUSTER_CONFLICT_CORE_FILES) {
    const src = path.join(paths.hubStateDir, name);
    if (!fs.existsSync(src)) continue;
    try {
      const st = fs.lstatSync(src);
      if (st.isFile() && !st.isSymbolicLink()) {
        fs.copyFileSync(src, path.join(backupDir, name));
      }
    } catch {
      // Best-effort
    }
  }
  pruneOldBackups(paths.clusterConflictBackupsDir, "conflict-");
  const notice: ClusterConflictBackupNotice = {
    id: path.basename(backupDir),
    createdAt: Date.now(),
    epoch: options.remoteEpoch,
  };
  writeJsonAtomic(paths.conflictNoticePath, notice);
  return backupDir;
}

export type PreStartFenceResult =
  | { action: "start_hub" }
  | { action: "start_peer"; peerConfig: DevicePeerConfig; activePrimaryUrl: string; conflictBackupPath?: string };

/**
 * Runs strictly BEFORE `KuloHub.open()` and `sshDevices.restore()` (P1-6).
 * - Standalone hosts (no cluster membership & no remote standbys): returns `start_hub` in 0ms.
 * - Cluster hosts: probes known cluster hubs with a 3s timeout; if a higher-authority Active Primary
 *   exists for the same `hubId`, automatically demotes this host to a Standby Peer to reverse-sync.
 */
export async function runPreStartFence(
  paths: ClusterPaths,
  options: { defaultRootDir: string; probeTimeoutMs?: number } = { defaultRootDir: process.cwd() },
): Promise<PreStartFenceResult> {
  const membership = readClusterMembership(paths.clusterMembershipPath);
  const hubDevices = readDevicesFile(path.join(paths.hubStateDir, "devices.json"));

  const hasClusterConfig = Boolean(
    membership ||
    (hubDevices && hubDevices.localNodeId && hubDevices.devices.some((d) => d.pairedAt && d.standby && d.id !== hubDevices.localNodeId)),
  );
  if (!hasClusterConfig) {
    return { action: "start_hub" };
  }

  const hubId = membership?.hubId ?? hubDevices?.hubId;
  const myNodeId = membership?.nodeId ?? hubDevices?.localNodeId ?? readOrCreateNodeIdentity(paths.nodeIdentityPath);
  if (!hubId || !myNodeId) return { action: "start_hub" };

  const selfRec = hubDevices?.devices.find((d) => d.id === myNodeId && d.pairedAt);
  const selfTokens = membership?.selfTokens ?? (
    selfRec?.syncToken
      ? { envToken: selfRec.envToken, clientToken: selfRec.clientToken, syncToken: selfRec.syncToken }
      : undefined
  );
  if (!selfTokens) {
    return { action: "start_hub" };
  }

  const localEpoch = Math.max(membership?.epoch ?? 1, hubDevices?.clusterEpoch ?? 1);
  const localPrimaryNodeId = hubDevices?.primaryNodeId ?? membership?.primaryNodeId ?? myNodeId;
  const preferredPrimaryNodeId = membership?.preferredPrimaryNodeId ?? hubDevices?.preferredPrimaryNodeId ?? myNodeId;
  const localAuthority = {
    epoch: localEpoch,
    isPreferredPrimary: localPrimaryNodeId === preferredPrimaryNodeId,
    nodeId: localPrimaryNodeId,
  };

  // Collect candidate URLs from membership + devices.json
  const candidateUrls: string[] = [];
  for (const hub of membership?.hubs ?? []) {
    if (hub.nodeId === myNodeId) continue;
    for (const url of hub.urls) {
      if (!candidateUrls.includes(url)) candidateUrls.push(url);
    }
  }
  for (const d of hubDevices?.devices ?? []) {
    if (d.id === myNodeId || !d.pairedAt || !d.standby || !d.listenPort) continue;
    for (const ip of d.info?.ips ?? []) {
      const origin = `http://${ip.includes(":") ? `[${ip}]` : ip}:${d.listenPort}`;
      if (!candidateUrls.includes(origin)) candidateUrls.push(origin);
    }
  }
  if (candidateUrls.length === 0) {
    return { action: "start_hub" };
  }

  const timeoutMs = options.probeTimeoutMs ?? PRE_START_PROBE_TIMEOUT_MS;
  let probed: { url: string; value: ClusterNodeStatus } | null = null;
  try {
    probed = await probeUrlsHappyEyeballs(
      candidateUrls,
      async (url) => {
        const status = await probeRemoteClusterNode(url, myNodeId, selfTokens.clientToken, timeoutMs);
        if (!status || status.hubId !== hubId || status.role !== "primary") {
          throw new Error("not_active_primary");
        }
        const remoteNodeId = status.primaryNodeId ?? status.nodeId;
        const remoteAuthority = {
          epoch: status.epoch,
          isPreferredPrimary: status.isPreferredPrimary,
          nodeId: remoteNodeId,
        };
        if (!isAuthorityHigher(remoteAuthority, localAuthority)) {
          throw new Error("not_higher_authority");
        }
        return status;
      },
      { timeoutMs, staggerMs: 120 },
    );
  } catch {
    probed = null;
  }

  if (!probed) {
    return { action: "start_hub" };
  }

  const remoteStatus = probed.value;
  const activePrimaryUrl = probed.url;
  const activePrimaryNodeId = remoteStatus.primaryNodeId ?? remoteStatus.nodeId;

  // Check if local hub/kulo.sqlite may contain un-replicated local edits
  const replicaState = readReplicaState(path.join(paths.standbyDir, "replica"));
  const localSyncMeta = readSyncMeta(paths.hubStateDir);
  let conflictBackupPath: string | undefined;
  if (
    fs.existsSync(path.join(paths.hubStateDir, "kulo.sqlite")) &&
    (!replicaState || localSyncMeta.generation > replicaState.generation || localEpoch === remoteStatus.epoch)
  ) {
    conflictBackupPath = archiveDivergedHubForConflict(paths, {
      remoteEpoch: remoteStatus.epoch,
      remotePrimaryNodeId: activePrimaryNodeId,
    });
  }

  const nextTopology: ClusterTopology = {
    version: 1,
    hubId,
    epoch: remoteStatus.epoch,
    primaryNodeId: activePrimaryNodeId,
    preferredPrimaryNodeId: remoteStatus.preferredPrimaryNodeId ?? preferredPrimaryNodeId,
    updatedAt: Date.now(),
    hubs: buildDemotedHubList(membership?.hubs ?? [], activePrimaryNodeId, activePrimaryUrl, myNodeId, hubDevices),
  };

  const myName = hubDevices?.localName ?? selfRec?.name ?? "主脑";
  const myPubKey = selfRec?.standbyPublicKey ?? membership?.hubs.find((h) => h.nodeId === myNodeId)?.standbyPublicKey ?? "";
  const myIdPubKey = selfRec?.identityPublicKey ?? hubDevices?.identityPublicKey;
  const peerConfig: DevicePeerConfig = {
    version: 1,
    deviceId: myNodeId,
    name: myName,
    hubUrl: activePrimaryUrl,
    envToken: selfTokens.envToken,
    clientToken: selfTokens.clientToken,
    rootDir: selfRec?.rootDir || options.defaultRootDir,
    cluster: nextTopology,
    ...(myPubKey ? {
      standby: {
        enabled: true,
        syncToken: selfTokens.syncToken,
        publicKey: myPubKey,
        ...(myIdPubKey ? { identityPublicKey: myIdPubKey } : {}),
      },
    } : {}),
  };

  savePeerConfig(peerConfig, paths.peerConfigPath);
  saveClusterMembership(paths.clusterMembershipPath, {
    version: 1,
    hubId,
    nodeId: myNodeId,
    myRole: "standby",
    epoch: remoteStatus.epoch,
    primaryNodeId: activePrimaryNodeId,
    preferredPrimaryNodeId: nextTopology.preferredPrimaryNodeId,
    selfTokens,
    hubs: nextTopology.hubs,
    updatedAt: Date.now(),
  });

  return {
    action: "start_peer",
    peerConfig,
    activePrimaryUrl,
    ...(conflictBackupPath ? { conflictBackupPath } : {}),
  };
}

function buildDemotedHubList(
  existing: readonly ClusterHubEndpoint[],
  activePrimaryNodeId: string,
  activePrimaryUrl: string,
  myNodeId: string,
  hubDevices: DevicesFileLite | null,
): ClusterHubEndpoint[] {
  const byId = new Map<string, ClusterHubEndpoint>();
  for (const h of existing) {
    byId.set(h.nodeId, { ...h, urls: [...h.urls] });
  }
  for (const d of hubDevices?.devices ?? []) {
    if (!d.pairedAt || !d.standby) continue;
    const prev = byId.get(d.id);
    const urls = [...(prev?.urls ?? [])];
    if (d.listenPort) {
      for (const ip of d.info?.ips ?? []) {
        const origin = `http://${ip.includes(":") ? `[${ip}]` : ip}:${d.listenPort}`;
        if (!urls.includes(origin)) urls.push(origin);
      }
    }
    byId.set(d.id, {
      nodeId: d.id,
      name: d.name,
      role: d.id === activePrimaryNodeId ? "primary" : "standby",
      priority: d.id === activePrimaryNodeId ? 0 : (d.standbyPriority ?? 1),
      urls,
      online: d.id === activePrimaryNodeId ? true : (prev?.online ?? false),
      ...(d.standbyPublicKey ? { standbyPublicKey: d.standbyPublicKey } : prev?.standbyPublicKey ? { standbyPublicKey: prev.standbyPublicKey } : {}),
      ...(d.identityPublicKey ? { identityPublicKey: d.identityPublicKey } : prev?.identityPublicKey ? { identityPublicKey: prev.identityPublicKey } : {}),
    });
  }
  const active = byId.get(activePrimaryNodeId);
  if (active) {
    active.role = "primary";
    active.priority = 0;
    active.online = true;
    if (!active.urls.includes(activePrimaryUrl)) active.urls.unshift(activePrimaryUrl);
  } else {
    byId.set(activePrimaryNodeId, {
      nodeId: activePrimaryNodeId,
      name: "主机",
      role: "primary",
      priority: 0,
      urls: [activePrimaryUrl],
      online: true,
    });
  }
  const self = byId.get(myNodeId);
  if (self) self.role = "standby";
  return [...byId.values()];
}

/* -------------------------------------------------------------------------- */
/*  Active Hub Mutual Fence Monitor (15s periodic + wake checkNow)            */
/* -------------------------------------------------------------------------- */

export interface ClusterFenceMonitorOptions {
  getHubId: () => string;
  getLocalNodeId: () => string;
  getLocalEpoch: () => number;
  getLocalPrimaryNodeId: () => string;
  getPreferredPrimaryNodeId: () => string;
  getSelfClientToken: () => string | undefined;
  getRemoteClusterHubs: () => ClusterHubEndpoint[];
  onHigherAuthorityDetected: (input: { activePrimaryUrl: string; status: ClusterNodeStatus }) => Promise<void> | void;
  intervalMs?: number;
}

export class ClusterFenceMonitor {
  readonly #opts: ClusterFenceMonitorOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight = false;
  #triggered = false;
  #closed = false;

  constructor(options: ClusterFenceMonitorOptions) {
    this.#opts = options;
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => {
      void this.checkNow();
    }, this.#opts.intervalMs ?? FENCE_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async checkNow(): Promise<void> {
    if (this.#closed || this.#inFlight || this.#triggered) return;
    const myNodeId = this.#opts.getLocalNodeId();
    const clientToken = this.#opts.getSelfClientToken();
    if (!clientToken || myNodeId === "local") return;
    const hubs = this.#opts.getRemoteClusterHubs().filter((h) => h.nodeId !== myNodeId && h.urls.length > 0);
    if (hubs.length === 0) return;

    this.#inFlight = true;
    try {
      const hubId = this.#opts.getHubId();
      const localPrimaryNodeId = this.#opts.getLocalPrimaryNodeId();
      const localAuthority = {
        epoch: this.#opts.getLocalEpoch(),
        isPreferredPrimary: localPrimaryNodeId === this.#opts.getPreferredPrimaryNodeId(),
        nodeId: localPrimaryNodeId,
      };
      const urls = hubs.flatMap((h) => h.urls);
      let found: { url: string; value: ClusterNodeStatus } | null = null;
      try {
        found = await probeUrlsHappyEyeballs(
          urls,
          async (url) => {
            const status = await probeRemoteClusterNode(url, myNodeId, clientToken, 2_500);
            if (!status || status.hubId !== hubId || status.role !== "primary") {
              throw new Error("not_active_primary");
            }
            const remoteAuthority = {
              epoch: status.epoch,
              isPreferredPrimary: status.isPreferredPrimary,
              nodeId: status.primaryNodeId ?? status.nodeId,
            };
            if (!isAuthorityHigher(remoteAuthority, localAuthority)) {
              throw new Error("not_higher_authority");
            }
            return status;
          },
          { timeoutMs: 2_500, staggerMs: 120 },
        );
      } catch {
        found = null;
      }
      if (found && !this.#closed && !this.#triggered) {
        this.#triggered = true;
        await this.#opts.onHigherAuthorityDetected({ activePrimaryUrl: found.url, status: found.value });
      }
    } catch {
      // Ignore transient network errors during fence checks
    } finally {
      this.#inFlight = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  StandbyHostBridge Factory (Injected into @kulo/env `startDevicePeer`)     */
/* -------------------------------------------------------------------------- */

export interface CreateStandbyHostBridgeOptions {
  paths: ClusterPaths;
  keyStore?: ConnectionVaultKeyStore;
  pollIntervalMs?: number;
}

export function createStandbyHostBridge(options: CreateStandbyHostBridgeOptions): StandbyHostBridge {
  const { paths } = options;
  let cachedKeys: ClusterNodeKeyMaterial | null = null;
  let replicator: StandbyReplicator | null = null;
  let activeConfig: {
    hubId: string;
    nodeId: string;
    primaryUrl: string;
    primaryNodeId: string;
    primaryIdentityPublicKey?: string;
    epoch: number;
    syncToken: string;
    onStatus: (status: ClusterSyncStatus) => void;
    onRevoked: () => void;
  } | null = null;

  const ensureKeys = async (): Promise<ClusterNodeKeyMaterial> => {
    if (!cachedKeys) {
      cachedKeys = await ensureLocalClusterKeys({
        dataDir: paths.dataDir,
        hubStateDir: paths.hubStateDir,
        standbyDir: paths.standbyDir,
        keyStore: options.keyStore,
      });
    }
    return cachedKeys;
  };

  const readReplicaDevices = (): DevicesFileLite | null => {
    return readDevicesFile(path.join(paths.standbyDir, "replica", "devices.json"));
  };

  return {
    getStandbyPublicKey() {
      return cachedKeys?.x25519PublicKey;
    },
    getIdentityPublicKey() {
      return cachedKeys?.ed25519PublicKey;
    },
    async ensureSyncKeys() {
      const keys = await ensureKeys();
      return {
        standbyPublicKey: keys.x25519PublicKey,
        identityPublicKey: keys.ed25519PublicKey,
      };
    },
    configureStandby(input) {
      const needsRestart =
        !replicator ||
        !activeConfig ||
        activeConfig.hubId !== input.hubId ||
        activeConfig.nodeId !== input.nodeId ||
        activeConfig.syncToken !== input.syncToken;
      activeConfig = { ...input };
      if (needsRestart) {
        const previous = replicator;
        if (previous) void previous.stop();
        replicator = new StandbyReplicator({
          dataDir: paths.dataDir,
          hubStateDir: paths.hubStateDir,
          standbyDir: paths.standbyDir,
          hubId: input.hubId,
          nodeId: input.nodeId,
          syncToken: input.syncToken,
          getPrimaryUrl: () => activeConfig?.primaryUrl ?? input.primaryUrl,
          getPrimaryNodeId: () => activeConfig?.primaryNodeId ?? input.primaryNodeId,
          getPrimaryIdentityPublicKey: () => activeConfig?.primaryIdentityPublicKey ?? input.primaryIdentityPublicKey,
          getClusterEpoch: () => activeConfig?.epoch ?? input.epoch,
          getNodeKeys: ensureKeys,
          keyStore: options.keyStore,
          onStatusChange: (status) => activeConfig?.onStatus(status),
          onRevoked: () => activeConfig?.onRevoked(),
          pollIntervalMs: options.pollIntervalMs,
        });
        replicator.start();
      } else {
        void replicator?.triggerSync();
      }
    },
    notifySyncAvailable(_notice: ClusterSyncAvailableNotification) {
      void replicator?.triggerSync();
    },
    async syncForHandover(input) {
      if (activeConfig) {
        activeConfig = {
          ...activeConfig,
          primaryUrl: input.primaryUrl,
          primaryNodeId: input.primaryNodeId,
          ...(input.primaryIdentityPublicKey ? { primaryIdentityPublicKey: input.primaryIdentityPublicKey } : {}),
          epoch: input.epoch,
          syncToken: input.syncToken,
        };
      }
      if (!replicator) {
        throw new Error("备用主机同步器未初始化。");
      }
      await replicator.syncForHandover(input.targetGeneration);
    },
    getSyncStatus(): ClusterSyncStatus {
      if (replicator) return replicator.status;
      const state = readReplicaState(path.join(paths.standbyDir, "replica"));
      if (state) {
        return {
          state: state.pendingVaultEnvelope ? "error" : "synced",
          syncedGeneration: state.generation,
          syncedAt: state.syncedAt,
          ...(state.pendingVaultEnvelope ? { vaultPending: true } : {}),
        };
      }
      return { state: "pending", syncedGeneration: 0 };
    },
    canPromote(): boolean {
      const replicaDir = path.join(paths.standbyDir, "replica");
      const state = readReplicaState(replicaDir);
      if (!state) return false;
      if (activeConfig && state.hubId !== activeConfig.hubId) return false;
      return fs.existsSync(path.join(replicaDir, "kulo.sqlite"));
    },
    resolveClusterClientSecret(nodeId: string): string | undefined {
      const devices = readReplicaDevices();
      if (!devices) return undefined;
      if (devices.revokedIds?.includes(nodeId)) return undefined;
      return devices.devices.find((d) => d.id === nodeId && d.pairedAt)?.clientToken;
    },
    resolveClusterSyncSecret(nodeId: string): string | undefined {
      const devices = readReplicaDevices();
      if (!devices) return undefined;
      if (devices.revokedIds?.includes(nodeId)) return undefined;
      return devices.devices.find((d) => d.id === nodeId && d.pairedAt && d.standby)?.syncToken;
    },
    isRevokedDevice(nodeId: string): boolean {
      const devices = readReplicaDevices();
      return Boolean(devices?.revokedIds?.includes(nodeId));
    },
    async preparePromotion(input) {
      if (replicator) {
        await replicator.stop();
        replicator = null;
      }
      const nodeId = activeConfig?.nodeId ?? readOrCreateNodeIdentity(paths.nodeIdentityPath);
      await applyReplicaForPromotion(paths, {
        nodeId,
        targetEpoch: input.targetEpoch,
        reason: input.reason,
        primaryIdentityPublicKey: activeConfig?.primaryIdentityPublicKey,
        keyStore: options.keyStore,
      });
    },
    readConflictNotice: () => readConflictBackupNotice(paths),
    clearConflictNotice: () => clearConflictBackupNotice(paths),
    async wipeStandby(_reason: string) {
      if (replicator) { await replicator.wipeStandby(); replicator = null; }
      else fs.rmSync(paths.standbyDir, { recursive: true, force: true });
    },
    async close() {
      if (replicator) { await replicator.stop(); replicator = null; }
    },
  };
}
