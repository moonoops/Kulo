import type { MobileConnectionCandidate } from "./mobile-connect.js";

export const CLUSTER_FAILOVER_CAPABILITY = "cluster-failover-v1" as const;
export const WARM_STANDBY_CAPABILITY = "warm-standby-v1" as const;

export type ClusterRole = "primary" | "standby" | "peer";
export type ClusterSyncState = "synced" | "syncing" | "error" | "pending";

export interface AuthorityTuple {
  epoch: number;
  isPreferredPrimary: boolean;
  nodeId: string;
}

/**
 * Total ordering for cluster primary authority.
 * Higher epoch always wins; on equal epoch (concurrent failover during partition),
 * preferred primary wins; final deterministic tiebreaker is lexicographical nodeId.
 */
export function compareAuthorityTuples(left: AuthorityTuple, right: AuthorityTuple): number {
  if (left.epoch !== right.epoch) return left.epoch > right.epoch ? 1 : -1;
  const leftPref = left.isPreferredPrimary ? 1 : 0;
  const rightPref = right.isPreferredPrimary ? 1 : 0;
  if (leftPref !== rightPref) return leftPref > rightPref ? 1 : -1;
  if (left.nodeId === right.nodeId) return 0;
  return left.nodeId > right.nodeId ? 1 : -1;
}

export function isAuthorityHigher(candidate: AuthorityTuple, current: AuthorityTuple): boolean {
  return compareAuthorityTuples(candidate, current) > 0;
}

export interface ClusterSyncStatus {
  state: ClusterSyncState;
  syncedAt?: number;
  syncedGeneration?: number;
  latestGeneration?: number;
  pendingUploadFiles?: number;
  pendingUploadBytes?: number;
  vaultPending?: boolean;
  error?: string;
}

export interface ClusterHubEndpoint {
  nodeId: string;
  name: string;
  role: "primary" | "standby";
  priority: number;
  urls: string[];
  standbyPublicKey?: string;
  identityPublicKey?: string;
  mobile?: {
    spkiSHA256: string;
    candidates: MobileConnectionCandidate[];
  };
  online: boolean;
  syncState?: ClusterSyncState;
  lastSyncedAt?: number;
  syncedGeneration?: number;
  syncError?: string;
}

export interface ClusterTopology {
  version: 1;
  hubId: string;
  epoch: number;
  primaryNodeId: string;
  preferredPrimaryNodeId: string;
  updatedAt: number;
  hubs: ClusterHubEndpoint[];
}

export interface ClusterNodeStatus {
  version: 1;
  hubId: string;
  nodeId: string;
  name: string;
  role: ClusterRole;
  active: boolean;
  epoch: number;
  primaryNodeId: string;
  preferredPrimaryNodeId: string;
  isPreferredPrimary: boolean;
  syncedAt?: number;
  syncedGeneration?: number;
  syncState?: ClusterSyncState;
  canPromote?: boolean;
  handoverInProgress?: boolean;
  identityPublicKey?: string;
}

export interface ClusterFailoverCandidate {
  nodeId: string;
  name: string;
  urls: string[];
  syncedAt?: number;
  syncedGeneration?: number;
  syncState?: ClusterSyncState;
  reachable: boolean;
  isSelf: boolean;
  canPromote: boolean;
}

export interface ClusterFailoverOffer {
  offlinePrimaryNodeId: string;
  offlinePrimaryName: string;
  offlineSince: number;
  candidates: ClusterFailoverCandidate[];
}

export interface ClusterFailbackOffer {
  preferredPrimaryNodeId: string;
  preferredPrimaryName: string;
  syncedAt?: number;
  ready: boolean;
}

export interface ClusterConflictBackupNotice {
  id: string;
  createdAt: number;
  epoch: number;
}

export interface ClusterLocalStatusView {
  enabled: boolean;
  hubId?: string;
  nodeId?: string;
  role: "primary" | "standby" | "peer" | "standalone";
  epoch: number;
  primaryNodeId?: string;
  preferredPrimaryNodeId?: string;
  primaryOnline: boolean;
  primaryName?: string;
  failoverOffer?: ClusterFailoverOffer;
  failbackOffer?: ClusterFailbackOffer;
  syncStatus?: ClusterSyncStatus;
  conflictBackupNotice?: ClusterConflictBackupNotice;
}

export interface ClusterClientSummary {
  hubId: string;
  epoch: number;
  primaryNodeId: string;
  preferredPrimaryNodeId: string;
  isPreferredPrimary: boolean;
  standbyCount: number;
}

export interface ClusterSyncAvailableNotification {
  epoch: number;
  generation: number;
  dbRevision: number;
  ledgerRevision: number;
  vaultRevision: number;
  filesRevision: number;
  uploadsRevision: number;
}

export interface ClusterHandoverDirective {
  hubId: string;
  epoch: number;
  newPrimaryNodeId: string;
  newPrimaryUrls: string[];
}

export interface ClusterStandbyPeerConfig {
  enabled: boolean;
  syncToken: string;
  publicKey: string;
  identityPublicKey?: string;
}

const NODE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const BASE64URL_KEY_RE = /^[A-Za-z0-9_-]{32,256}$/;

export function isValidClusterOrigin(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      (parsed.pathname === "/" || parsed.pathname === "") && parsed.port !== "0" &&
      parsed.origin === raw;
  } catch {
    return false;
  }
}

export function isClusterSyncStatus(value: unknown): value is ClusterSyncStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  if (!["synced", "syncing", "error", "pending"].includes(String(status.state))) return false;
  for (const field of ["syncedAt", "syncedGeneration", "latestGeneration", "pendingUploadFiles", "pendingUploadBytes"] as const) {
    if (status[field] !== undefined && (typeof status[field] !== "number" || !Number.isSafeInteger(status[field]) || (status[field] as number) < 0)) {
      return false;
    }
  }
  if (status.vaultPending !== undefined && typeof status.vaultPending !== "boolean") return false;
  if (status.error !== undefined && (typeof status.error !== "string" || status.error.length > 1000)) return false;
  return true;
}

export function isClusterHubEndpoint(value: unknown): value is ClusterHubEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hub = value as Record<string, unknown>;
  if (typeof hub.nodeId !== "string" || !NODE_ID_RE.test(hub.nodeId)) return false;
  if (typeof hub.name !== "string" || !hub.name.trim() || hub.name.length > 100 || /[\x00-\x1f\x7f]/.test(hub.name)) return false;
  if (hub.role !== "primary" && hub.role !== "standby") return false;
  if (typeof hub.priority !== "number" || !Number.isSafeInteger(hub.priority) || hub.priority < 0 || hub.priority > 1000) return false;
  if (!Array.isArray(hub.urls) || hub.urls.length > 64 || !hub.urls.every(isValidClusterOrigin)) return false;
  if (typeof hub.online !== "boolean") return false;
  if (hub.standbyPublicKey !== undefined && (typeof hub.standbyPublicKey !== "string" || !BASE64URL_KEY_RE.test(hub.standbyPublicKey))) return false;
  if (hub.identityPublicKey !== undefined && (typeof hub.identityPublicKey !== "string" || !BASE64URL_KEY_RE.test(hub.identityPublicKey))) return false;
  if (hub.syncState !== undefined && !["synced", "syncing", "error", "pending"].includes(String(hub.syncState))) return false;
  if (hub.lastSyncedAt !== undefined && (typeof hub.lastSyncedAt !== "number" || !Number.isSafeInteger(hub.lastSyncedAt) || hub.lastSyncedAt < 0)) return false;
  if (hub.syncedGeneration !== undefined && (typeof hub.syncedGeneration !== "number" || !Number.isSafeInteger(hub.syncedGeneration) || hub.syncedGeneration < 0)) return false;
  if (hub.syncError !== undefined && (typeof hub.syncError !== "string" || hub.syncError.length > 1000)) return false;
  if (hub.mobile !== undefined) {
    if (!hub.mobile || typeof hub.mobile !== "object" || Array.isArray(hub.mobile)) return false;
    const mobile = hub.mobile as Record<string, unknown>;
    if (typeof mobile.spkiSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(mobile.spkiSHA256)) return false;
    if (!Array.isArray(mobile.candidates) || mobile.candidates.length > 32) return false;
    for (const candidate of mobile.candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const item = candidate as Record<string, unknown>;
      if ((item.route !== "lan" && item.route !== "tailscale") || !isValidClusterOrigin(item.origin)) return false;
    }
  }
  return true;
}

export function isClusterTopology(value: unknown): value is ClusterTopology {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const topology = value as Record<string, unknown>;
  return topology.version === 1 &&
    typeof topology.hubId === "string" && NODE_ID_RE.test(topology.hubId) &&
    typeof topology.epoch === "number" && Number.isSafeInteger(topology.epoch) && topology.epoch >= 1 &&
    typeof topology.primaryNodeId === "string" && NODE_ID_RE.test(topology.primaryNodeId) &&
    typeof topology.preferredPrimaryNodeId === "string" && NODE_ID_RE.test(topology.preferredPrimaryNodeId) &&
    typeof topology.updatedAt === "number" && Number.isSafeInteger(topology.updatedAt) && topology.updatedAt >= 0 &&
    Array.isArray(topology.hubs) && topology.hubs.length <= 32 &&
    topology.hubs.every(isClusterHubEndpoint);
}

export function isClusterStandbyPeerConfig(value: unknown): value is ClusterStandbyPeerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cfg = value as Record<string, unknown>;
  return typeof cfg.enabled === "boolean" &&
    typeof cfg.syncToken === "string" && cfg.syncToken.length >= 16 && cfg.syncToken.length <= 512 && !/\s/.test(cfg.syncToken) &&
    typeof cfg.publicKey === "string" && BASE64URL_KEY_RE.test(cfg.publicKey) &&
    (cfg.identityPublicKey === undefined || (typeof cfg.identityPublicKey === "string" && BASE64URL_KEY_RE.test(cfg.identityPublicKey)));
}
