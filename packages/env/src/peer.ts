import http from "node:http";
import https from "node:https";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import {
  KULO_VERSION,
  compareAuthorityTuples,
  isAuthorityHigher,
  isClusterTopology,
  type AuthorityTuple,
  type ClusterConflictBackupNotice,
  type ClusterFailoverCandidate,
  type ClusterFailoverOffer,
  type ClusterHandoverDirective,
  type ClusterLocalStatusView,
  type ClusterNodeStatus,
  type ClusterSyncAvailableNotification,
  type ClusterSyncStatus,
  type ClusterTopology,
  type DeviceChatInvitation,
  type DeviceInterconnectionView,
  type DevicePeerConfig,
} from "@kulo/protocol";
import { DeviceRoleTransitions, type PreparedDeviceRoleChange } from "./device-role-transitions.js";
import { LocalInstanceOwner } from "./local-instance.js";
import { claimDevicePeer } from "./peer-runtime-owner.js";
import {
  authenticatedPeerHub,
  deviceHostUnreachable,
  getPeerConfigPath,
  invalidDeviceInvitation,
  localPeerProxyToken,
  normalizePeerHubUrl,
  readPeerConfig,
  updatePeerConfig,
  validatePeerConfig,
} from "./peer-config.js";
export { getPeerConfigPath, readPeerConfig, savePeerConfig, removePeerConfig, installDevicePeer, normalizePeerHubUrl, updatePeerConfig } from "./peer-config.js";
import { KuloEnvAgent } from "./agent.js";
import {
  ClusterNonceGuard,
  createClusterAuthHeader,
  isLoopbackSocket,
  probeUrlsHappyEyeballs,
} from "./cluster-security.js";
import {
  buildOfflineJoinedDeviceView,
  buildPeerLocalClusterStatus,
  equalPeerToken,
  forwardPeerRequestHeaders,
  readPeerBoundedBody,
  readPeerJoinRequest,
  schedulePeerAfterResponse as scheduleAfterResponse,
  startPeerAfterResponse,
} from "./peer-http-helpers.js";
import { tryServeLocalWebAsset } from "./peer-static.js";

const CLUSTER_AUTH_HEADER = "x-kulo-cluster-auth";
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 15_000;
const CLUSTER_PROBE_TIMEOUT_MS = 5_000;
const ALLOWED_REMOTE_CLUSTER_ROUTES = new Set([
  "GET /_kulo/cluster/status",
  "POST /_kulo/cluster/prepare-promote",
  "POST /_kulo/cluster/promote",
  "POST /_kulo/cluster/handover-accept",
]);

export interface StandbyHostBridge {
  getStandbyPublicKey(): string | undefined;
  getIdentityPublicKey(): string | undefined;
  ensureSyncKeys(): Promise<{ standbyPublicKey: string; identityPublicKey: string }>;
  configureStandby(input: {
    hubId: string;
    nodeId: string;
    primaryUrl: string;
    primaryNodeId: string;
    primaryIdentityPublicKey?: string;
    epoch: number;
    syncToken: string;
    onStatus: (status: ClusterSyncStatus) => void;
    onRevoked: () => void;
  }): void;
  notifySyncAvailable(notice: ClusterSyncAvailableNotification): void;
  syncForHandover(input: {
    primaryUrl: string;
    primaryNodeId: string;
    primaryIdentityPublicKey?: string;
    epoch: number;
    targetGeneration: number;
    syncToken: string;
  }): Promise<void>;
  getSyncStatus(): ClusterSyncStatus;
  canPromote(): boolean;
  resolveClusterClientSecret(nodeId: string): string | undefined;
  resolveClusterSyncSecret(nodeId: string): string | undefined;
  isRevokedDevice(nodeId: string): boolean;
  preparePromotion(input: { targetEpoch: number; reason: "failover" | "handover" }): Promise<void>;
  readConflictNotice?(): ClusterConflictBackupNotice | null;
  clearConflictNotice?(): void;
  wipeStandby(reason: string): Promise<void>;
  close(): Promise<void>;
}

export interface DevicePeerRuntime {
  url: string;
  port: number;
  authToken: string;
  /** Initial Env registration and authenticated access to the shared conversation API. */
  ready: Promise<void>;
  /** Actively verify or recover the outbound Env and Hub connection (for example after OS wake from sleep). */
  probeConnection(): void;
  /** Hot-switch upstream Hub origin without restarting the local listener. */
  switchHub(nextHubUrl: string): void;
  close(): Promise<void>;
}

const equalToken = equalPeerToken;
const readBoundedBody = readPeerBoundedBody;
const readPeerJoin = readPeerJoinRequest;
const startAfterResponse = startPeerAfterResponse;
const requestHeaders = forwardPeerRequestHeaders;

export interface StartDevicePeerOptions {
  runtimeOwner?: LocalInstanceOwner;
  port?: number;
  configPath?: string;
  authToken?: string;
  webDistDir?: string;
  protectedPaths?: string[];
  allowLeave?: boolean;
  onLeave?: () => Promise<void> | void;
  roleTransitions?: DeviceRoleTransitions;
  heartbeatIdleMs?: number;
  heartbeatTimeoutMs?: number;
  /** Optional warm-standby controller injected by full Desktop / CLI runtimes. */
  standbyHost?: StandbyHostBridge;
  /** Callback fired whenever local cluster topology or active Hub changes. */
  onClusterUpdate?: (config: DevicePeerConfig) => void;
  /** Override probe cadence and offline grace window for deterministic testing. */
  failoverProbeIntervalMs?: number;
  failoverOfflineThresholdMs?: number;
  failoverMinFailedRounds?: number;
  resumeGraceMs?: number;
  /** Pure TCP/TLS connect timeout for proxied upstream HTTP requests (default: 15_000ms). */
  proxyConnectTimeoutMs?: number;
  onLog?: (message: string) => void;
}

export async function startDevicePeer(configValue: DevicePeerConfig, options: StartDevicePeerOptions = {}): Promise<DevicePeerRuntime> {
  const config = validatePeerConfig(configValue);
  const resolvedConfigPath = path.resolve(options.configPath ?? getPeerConfigPath());
  const owner = claimDevicePeer(config, resolvedConfigPath);
  try { return await listenDevicePeer(config, resolvedConfigPath, owner, options); }
  catch (error) { owner.close(); throw error; }
}

async function listenDevicePeer(
  initialConfig: DevicePeerConfig,
  resolvedConfigPath: string,
  owner: LocalInstanceOwner,
  options: StartDevicePeerOptions,
): Promise<DevicePeerRuntime> {
  const roleTransitions = options.roleTransitions ?? new DeviceRoleTransitions({ configPath: resolvedConfigPath, startHub: options.onLeave });
  const canSwitchRole = roleTransitions.canLeave;
  let currentConfig: DevicePeerConfig = initialConfig;
  let activeHub = new URL(initialConfig.hubUrl);
  const standbyHost = options.standbyHost;
  const nonceGuard = new ClusterNonceGuard(60_000, 10_000);

  // Pre-warm standby keypair if host runtime supports warm standby so env.register advertises public keys.
  if (standbyHost) {
    await standbyHost.ensureSyncKeys().catch((error: unknown) => {
      options.onLog?.(`Standby sync key init deferred: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const webSockets = new Set<WebSocket>();
  const sockets = new Set<Socket>();
  const activeUpstreams = new Set<http.ClientRequest>();
  let httpAgent = new http.Agent({ keepAlive: true });
  let httpsAgent = new https.Agent({ keepAlive: true });
  const proxyConnectTimeoutMs = options.proxyConnectTimeoutMs ?? DEFAULT_PROXY_CONNECT_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true });
  let port = 0;
  let listenHost: "127.0.0.1" | "0.0.0.0" = Boolean(standbyHost && currentConfig.standby?.enabled) ? "0.0.0.0" : "127.0.0.1";
  let listenerTransition: Promise<void> = Promise.resolve();
  let initiallyReady = false;
  let readinessError: string | undefined;
  let readinessRetry: NodeJS.Timeout | undefined;
  let readinessProbe: Promise<void> | undefined;
  let retryAttempt = 0;
  let closed = false;
  let promoting = false;

  // Mutual-exclusion lease for concurrent promotion across multiple standbys.
  let promoteLease: { holder: AuthorityTuple; expiresAt: number } | undefined;

  // Awake-time consecutive failure tracking (P1-2: immune to OS sleep wall-clock jumps).
  const probeIntervalMs = options.failoverProbeIntervalMs ?? 5_000;
  const offlineThresholdMs = options.failoverOfflineThresholdMs ?? 30_000;
  const minFailedRounds = options.failoverMinFailedRounds ?? 3;
  const resumeGraceMs = options.resumeGraceMs ?? 8_000;

  let lastTickAt = Date.now();
  let resumeGraceUntil = 0;
  let consecutivePrimaryProbeFailures = 0;
  let awakeOfflineSince: number | undefined;
  let probeInFlight: Promise<void> | undefined;
  let observedClusterNodes = new Map<string, { status: ClusterNodeStatus; url: string; observedAt: number }>();
  let failoverOffer: ClusterFailoverOffer | undefined;
  let standbySyncStatus: ClusterSyncStatus | undefined = standbyHost?.getSyncStatus();

  const isStandbyEnabled = (): boolean => Boolean(standbyHost && currentConfig.standby?.enabled);

  const localAuthToken = options.authToken?.trim() || localPeerProxyToken(initialConfig);
  const isAuthorizedLocal = (request: http.IncomingMessage, parsed: URL): boolean => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    return equalToken(bearer ?? parsed.searchParams.get("token") ?? undefined, localAuthToken);
  };
  const isLocalControl = (request: http.IncomingMessage): boolean =>
    !request.headers.forwarded && !request.headers["x-forwarded-for"] && !request.headers["x-real-ip"] &&
    !request.headers["x-forwarded-host"] && !request.headers["x-forwarded-proto"] &&
    isLoopbackSocket(request.socket.remoteAddress);

  const allowedLocalRequest = (request: http.IncomingMessage): boolean => {
    if (!isLoopbackSocket(request.socket.remoteAddress)) return false;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host ?? "") || !request.url?.startsWith("/") ||
        request.url.startsWith("//") || request.url.includes("\\")) return false;
    const origin = request.headers.origin;
    if (origin && !hosts.some((host) => origin === `http://${host}`)) return false;
    return request.headers["sec-fetch-site"] !== "cross-site";
  };

  const upstreamTarget = (request: http.IncomingMessage): URL | null => {
    if (!allowedLocalRequest(request)) return null;
    try {
      const target = new URL(request.url!, activeHub);
      return target.origin === activeHub.origin ? target : null;
    } catch {
      return null;
    }
  };

  const myAuthorityTuple = (epochOverride?: number): AuthorityTuple => {
    const cluster = currentConfig.cluster;
    return {
      epoch: epochOverride ?? cluster?.epoch ?? 1,
      isPreferredPrimary: Boolean(cluster && cluster.preferredPrimaryNodeId === currentConfig.deviceId),
      nodeId: currentConfig.deviceId,
    };
  };

  const buildLocalNodeStatus = (): ClusterNodeStatus => {
    const cluster = currentConfig.cluster;
    const syncStatus = standbyHost?.getSyncStatus() ?? standbySyncStatus;
    const role = isStandbyEnabled() ? "standby" : "peer";
    return {
      version: 1,
      hubId: cluster?.hubId ?? activeHub.origin,
      nodeId: currentConfig.deviceId,
      name: currentConfig.name,
      role,
      active: false,
      epoch: cluster?.epoch ?? 1,
      primaryNodeId: cluster?.primaryNodeId ?? "local",
      preferredPrimaryNodeId: cluster?.preferredPrimaryNodeId ?? cluster?.primaryNodeId ?? "local",
      isPreferredPrimary: Boolean(cluster && cluster.preferredPrimaryNodeId === currentConfig.deviceId),
      ...(syncStatus?.syncedAt !== undefined ? { syncedAt: syncStatus.syncedAt } : {}),
      ...(syncStatus?.syncedGeneration !== undefined ? { syncedGeneration: syncStatus.syncedGeneration } : {}),
      ...(syncStatus?.state ? { syncState: syncStatus.state } : {}),
      canPromote: Boolean(isStandbyEnabled() && standbyHost?.canPromote() && !promoting && roleTransitions.canLeave),
      handoverInProgress: promoting,
      ...(standbyHost?.getIdentityPublicKey() ? { identityPublicKey: standbyHost.getIdentityPublicKey() } : {}),
    };
  };

  const persistConfigUpdate = (mutator: (prev: DevicePeerConfig) => DevicePeerConfig): void => {
    currentConfig = mutator(currentConfig);
    try {
      updatePeerConfig((disk) => mutator(disk), resolvedConfigPath);
    } catch {
      // During staged startup before activation, connection.json may not exist yet.
    }
    options.onClusterUpdate?.(currentConfig);
  };

  const probeClusterNode = async (
    urls: readonly string[],
    secret: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; status: ClusterNodeStatus }> => {
    const result = await probeUrlsHappyEyeballs(urls, async (origin, attemptSignal) => {
      const pathWithQuery = "/_kulo/cluster/status";
      const { header } = createClusterAuthHeader({
        secret,
        nodeId: currentConfig.deviceId,
        method: "GET",
        pathWithQuery,
      });
      const response = await fetch(`${origin}${pathWithQuery}`, {
        method: "GET",
        redirect: "error",
        headers: { [CLUSTER_AUTH_HEADER]: header },
        signal: attemptSignal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as ClusterNodeStatus;
      if (!data || data.version !== 1 || typeof data.nodeId !== "string" || typeof data.epoch !== "number") {
        throw new Error("Invalid cluster status payload");
      }
      if (currentConfig.cluster?.hubId && data.hubId !== currentConfig.cluster.hubId) {
        throw new Error("Cluster hubId mismatch");
      }
      return data;
    }, { timeoutMs: CLUSTER_PROBE_TIMEOUT_MS, staggerMs: 150, signal });
    return { url: result.url, status: result.value };
  };

  const currentPrimaryUrls = (): string[] => {
    const cluster = currentConfig.cluster;
    const primary = cluster?.hubs.find((entry) => entry.nodeId === cluster.primaryNodeId);
    const urls = [...(primary?.urls ?? [])];
    if (!urls.includes(activeHub.origin)) urls.unshift(activeHub.origin);
    return urls;
  };

  const isPrimaryCurrentlyReachable = async (): Promise<boolean> => {
    const urls = currentPrimaryUrls();
    try {
      await probeUrlsHappyEyeballs(urls, async (origin, signal) => {
        const pathWithQuery = "/_kulo/cluster/status";
        const { header } = createClusterAuthHeader({
          secret: currentConfig.clientToken,
          nodeId: currentConfig.deviceId,
          method: "GET",
          pathWithQuery,
        });
        const response = await fetch(`${origin}${pathWithQuery}`, {
          method: "GET",
          redirect: "error",
          headers: { [CLUSTER_AUTH_HEADER]: header },
          signal,
        });
        if (response.ok) {
          const data = await response.json() as ClusterNodeStatus;
          if (
            data &&
            data.version === 1 &&
            typeof data.nodeId === "string" &&
            typeof data.epoch === "number" &&
            (!currentConfig.cluster?.hubId || data.hubId === currentConfig.cluster.hubId) &&
            data.active &&
            (!currentConfig.cluster || data.nodeId === currentConfig.cluster.primaryNodeId)
          ) {
            return true;
          }
        }
        // Only fall back to legacy /api/devices if the host responded at HTTP level without /_kulo/cluster/status.
        if (response.status === 404 || response.status === 405 || response.status === 501) {
          const legacy = await fetch(`${origin}/api/devices`, {
            redirect: "error",
            headers: { authorization: `Bearer ${currentConfig.clientToken}` },
            signal,
          });
          if (legacy.ok) return true;
        }
        throw new Error(`HTTP ${response.status}`);
      }, { timeoutMs: CLUSTER_PROBE_TIMEOUT_MS, staggerMs: 150 });
      return true;
    } catch {
      return false;
    }
  };

  const buildStandbyConfigForBridge = () => {
    if (!standbyHost || !currentConfig.standby?.enabled || !currentConfig.cluster) return;
    const cluster = currentConfig.cluster;
    const primaryHub = cluster.hubs.find((entry) => entry.nodeId === cluster.primaryNodeId);
    standbyHost.configureStandby({
      hubId: cluster.hubId,
      nodeId: currentConfig.deviceId,
      primaryUrl: activeHub.origin,
      primaryNodeId: cluster.primaryNodeId,
      ...(primaryHub?.identityPublicKey ? { primaryIdentityPublicKey: primaryHub.identityPublicKey } : {}),
      epoch: cluster.epoch,
      syncToken: currentConfig.standby.syncToken,
      onStatus: (status) => {
        standbySyncStatus = status;
        agent?.sendSyncStatus(status);
      },
      onRevoked: () => {
        void revokeLocalStandby("standby_revoked_by_primary");
      },
    });
  };

  let agent: KuloEnvAgent;

  const scheduleRebindListener = (desiredHost: "127.0.0.1" | "0.0.0.0") => {
    if (desiredHost === listenHost || closed || !port) return;
    listenerTransition = listenerTransition.then(async () => {
      if (closed || desiredHost === listenHost || !port) return;
      for (const ws of webSockets) ws.terminate();
      webSockets.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, desiredHost, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        listenHost = desiredHost;
      } catch (error) {
        options.onLog?.(`监听地址切换失败（${desiredHost}:${port}）: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise<void>((resolve) => server.listen(port, listenHost, () => resolve()));
      }
    });
  };

  const revokeLocalStandby = async (reason: string): Promise<void> => {
    standbySyncStatus = undefined;
    if (currentConfig.standby) {
      persistConfigUpdate((prev) => {
        const next = { ...prev };
        delete next.standby;
        return next;
      });
    }
    await standbyHost?.wipeStandby(reason).catch(() => {});
    scheduleRebindListener("127.0.0.1");
  };

  const switchHub = (nextHubUrl: string): void => {
    if (closed) return;
    const normalized = normalizePeerHubUrl(nextHubUrl);
    const changed = normalized !== activeHub.origin;
    activeHub = new URL(normalized);
    persistConfigUpdate((prev) => ({ ...prev, hubUrl: normalized }));
    consecutivePrimaryProbeFailures = 0;
    awakeOfflineSince = undefined;
    failoverOffer = undefined;
    readinessError = undefined;
    retryAttempt = 0;
    const nextEnvUrl = new URL("/ws/env", activeHub);
    nextEnvUrl.protocol = activeHub.protocol === "https:" ? "wss:" : "ws:";
    agent.switchHub(nextEnvUrl.toString());
    if (changed) {
      // Abort in-flight HTTP proxy requests to the previous primary and flush keep-alive pools
      // so pending calls (such as /api/media/session) immediately fail over to the new primary.
      for (const req of [...activeUpstreams]) {
        req.destroy(new Error("Cluster primary changed"));
      }
      httpAgent.destroy();
      httpsAgent.destroy();
      httpAgent = new http.Agent({ keepAlive: true });
      httpsAgent = new https.Agent({ keepAlive: true });
      // Force active local browser WS proxies to reconnect immediately and fetch fresh hub.snapshot + media cookie.
      for (const ws of [...webSockets]) {
        try { ws.close(1001, "Cluster primary changed"); } catch { ws.terminate(); }
      }
    }
    buildStandbyConfigForBridge();
    void probeSharedUi();
  };

  const applyClusterTopology = (topology: ClusterTopology): void => {
    const existing = currentConfig.cluster;
    if (existing && existing.hubId === topology.hubId && topology.epoch < existing.epoch) {
      return;
    }
    const selfInHubs = topology.hubs.find((entry) => entry.nodeId === currentConfig.deviceId);
    const wasStandby = Boolean(currentConfig.standby?.enabled);
    persistConfigUpdate((prev) => ({
      ...prev,
      cluster: topology,
    }));
    if (wasStandby && (!selfInHubs || selfInHubs.role !== "standby")) {
      void revokeLocalStandby("removed_from_cluster_standbys");
      return;
    }
    buildStandbyConfigForBridge();
    if (isStandbyEnabled()) scheduleRebindListener("0.0.0.0");
  };

  const handleClusterHandoverDirective = (directive: ClusterHandoverDirective): void => {
    if (currentConfig.cluster?.hubId && directive.hubId !== currentConfig.cluster.hubId) return;
    if (currentConfig.cluster && directive.epoch <= currentConfig.cluster.epoch) return;
    const urls = directive.newPrimaryUrls.filter(Boolean);
    if (!urls.length) return;
    void probeClusterNode(urls, currentConfig.clientToken)
      .then(({ url }) => switchHub(url))
      .catch(() => {
        switchHub(urls[0]!);
      });
  };

  const acquirePromotionConsensus = async (targetEpoch: number): Promise<void> => {
    const cluster = currentConfig.cluster;
    if (!cluster || !currentConfig.standby?.syncToken) return;
    const candidateTuple = myAuthorityTuple(targetEpoch);
    const otherStandbys = cluster.hubs.filter(
      (entry) => entry.nodeId !== currentConfig.deviceId && entry.nodeId !== cluster.primaryNodeId && entry.urls.length > 0,
    );
    await Promise.all(otherStandbys.map(async (peerHub) => {
      try {
        const body = JSON.stringify({
          hubId: cluster.hubId,
          epoch: targetEpoch,
          nodeId: currentConfig.deviceId,
          isPreferredPrimary: candidateTuple.isPreferredPrimary,
          leaseMs: 10_000,
        });
        await probeUrlsHappyEyeballs(peerHub.urls, async (origin, signal) => {
          const pathWithQuery = "/_kulo/cluster/prepare-promote";
          const { header } = createClusterAuthHeader({
            secret: currentConfig.standby!.syncToken,
            nodeId: currentConfig.deviceId,
            method: "POST",
            pathWithQuery,
            body,
          });
          const res = await fetch(`${origin}${pathWithQuery}`, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json", [CLUSTER_AUTH_HEADER]: header },
            body,
            signal,
          });
          if (res.status === 409) {
            const payload = await res.json().catch(() => ({})) as { error?: string; activeUrl?: string };
            if (payload.activeUrl) switchHub(payload.activeUrl);
            throw Object.assign(new Error(payload.error ?? "另一台备用主机正在切换为主机。"), { status: 409, code: "promote_conflict" });
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return true;
        }, { timeoutMs: CLUSTER_PROBE_TIMEOUT_MS, staggerMs: 150 });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "promote_conflict") throw error;
        // Unreachable sibling standbys do not block explicit user-confirmed failover.
      }
    }));
  };

  const executeLocalPromotion = async (input: {
    targetEpoch?: number;
    reason: "failover" | "handover";
    requestedId?: string;
    requirePrimaryOffline?: boolean;
  }): Promise<PreparedDeviceRoleChange> => {
    if (!isStandbyEnabled() || !standbyHost) {
      throw Object.assign(new Error("当前设备未启用备用主机。"), { status: 409, code: "standby_not_enabled" });
    }
    if (!standbyHost.canPromote()) {
      throw Object.assign(new Error("备用主机数据尚未同步就绪，请稍后再试。"), { status: 409, code: "standby_not_ready" });
    }
    if (promoting) {
      throw Object.assign(new Error("正在切换为主机，请稍候。"), { status: 409, code: "role_switch_busy" });
    }
    if (input.requirePrimaryOffline && await isPrimaryCurrentlyReachable()) {
      throw Object.assign(new Error("当前主设备仍在线，无需切换。请检查发起设备的网络连接。"), { status: 409, code: "primary_still_reachable" });
    }
    const baseEpoch = currentConfig.cluster?.epoch ?? 1;
    const targetEpoch = input.targetEpoch && input.targetEpoch > baseEpoch ? input.targetEpoch : baseEpoch + 1;
    if (input.reason === "failover") {
      await acquirePromotionConsensus(targetEpoch);
    }
    promoting = true;
    const change = roleTransitions.promote(
      currentConfig,
      async () => {
        try {
          await standbyHost.preparePromotion({ targetEpoch, reason: input.reason });
        } catch (error) {
          promoting = false;
          throw error;
        }
      },
      input.requestedId,
    );
    return change;
  };

  const executeRemotePromotion = async (targetNodeId: string): Promise<{ epoch: number; url: string }> => {
    const cluster = currentConfig.cluster;
    const target = cluster?.hubs.find((entry) => entry.nodeId === targetNodeId && entry.role === "standby");
    if (!cluster || !target || !target.urls.length) {
      throw Object.assign(new Error("找不到指定的备用主机。"), { status: 404, code: "standby_not_found" });
    }
    const body = JSON.stringify({ hubId: cluster.hubId, requestedBy: currentConfig.deviceId });
    const { url, value } = await probeUrlsHappyEyeballs(target.urls, async (origin, signal) => {
      const pathWithQuery = "/_kulo/cluster/promote";
      const { header } = createClusterAuthHeader({
        secret: currentConfig.clientToken,
        nodeId: currentConfig.deviceId,
        method: "POST",
        pathWithQuery,
        body,
      });
      const res = await fetch(`${origin}${pathWithQuery}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", [CLUSTER_AUTH_HEADER]: header },
        body,
        signal,
      });
      const payload = await res.json().catch(() => ({})) as { error?: string; code?: string; epoch?: number; status?: string };
      if (!res.ok) {
        throw Object.assign(new Error(payload.error ?? `备用主机拒绝切换（HTTP ${res.status}）。`), {
          status: res.status,
          code: payload.code ?? "remote_promote_failed",
        });
      }
      return payload;
    }, { timeoutMs: 20_000, staggerMs: 150 });

    // Wait briefly for the promoted Standby to finish restarting as Active Hub, then hot-switch.
    const deadline = Date.now() + 25_000;
    const expectedEpoch = typeof value.epoch === "number" ? value.epoch : cluster.epoch + 1;
    while (Date.now() < deadline && !closed) {
      try {
        const probed = await probeClusterNode(target.urls, currentConfig.clientToken);
        if (probed.status.active && probed.status.epoch >= expectedEpoch) {
          switchHub(probed.url);
          return { epoch: probed.status.epoch, url: probed.url };
        }
      } catch {
        // Still restarting listener on the promoted host.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    switchHub(url);
    return { epoch: expectedEpoch, url };
  };

  const buildLocalClusterStatus = (): ClusterLocalStatusView =>
    buildPeerLocalClusterStatus({
      currentConfig,
      activeHub,
      standbyEnabled: isStandbyEnabled(),
      primaryOnline: agent.registered && !readinessError,
      failoverOffer,
      syncStatus: standbyHost?.getSyncStatus() ?? standbySyncStatus,
      conflictBackupNotice: standbyHost?.readConflictNotice?.() ?? null,
    });

  const offlineJoinedView = (reason: string, local: boolean): DeviceInterconnectionView =>
    buildOfflineJoinedDeviceView({
      currentConfig,
      activeHub,
      standbyEnabled: isStandbyEnabled(),
      hasStandbyHost: Boolean(standbyHost),
      syncStatus: standbyHost?.getSyncStatus() ?? standbySyncStatus,
      observedClusterNodes,
      reason,
      local,
      canSwitchRole,
      primaryUrls: currentPrimaryUrls(),
      failoverOffer,
    });

  const runClusterMonitorSweep = async (): Promise<void> => {
    if (closed || promoting) return;
    const now = Date.now();
    // Wall-clock jump detection: if system slept between ticks, grant 8s recovery grace to prevent false alarms.
    if (now - lastTickAt > probeIntervalMs + 5_000) {
      resumeGraceUntil = Math.max(resumeGraceUntil, now + resumeGraceMs);
      consecutivePrimaryProbeFailures = 0;
      awakeOfflineSince = undefined;
      failoverOffer = undefined;
      lastTickAt = now;
      return;
    }
    lastTickAt = now;

    if (agent.registered && !readinessError) {
      consecutivePrimaryProbeFailures = 0;
      awakeOfflineSince = undefined;
      failoverOffer = undefined;
      return;
    }
    if (now < resumeGraceUntil) return;

    const cluster = currentConfig.cluster;
    if (!cluster || cluster.hubs.length === 0) return;

    // 1. Try all URLs of the current primary concurrently (Happy Eyeballs: LAN + Tailscale).
    const primaryUrls = currentPrimaryUrls();
    try {
      const { url, status } = await probeClusterNode(primaryUrls, currentConfig.clientToken);
      if (status.active) {
        if (url !== activeHub.origin) switchHub(url);
        consecutivePrimaryProbeFailures = 0;
        awakeOfflineSince = undefined;
        failoverOffer = undefined;
        return;
      }
    } catch {
      // Primary unreachable on all known URLs.
    }

    // 2. Probe all other cluster hubs concurrently: auto-follow any higher-authority Active Hub!
    const currentAuthority: AuthorityTuple = {
      epoch: cluster.epoch,
      isPreferredPrimary: cluster.primaryNodeId === cluster.preferredPrimaryNodeId,
      nodeId: cluster.primaryNodeId,
    };
    const otherHubs = cluster.hubs.filter((entry) => entry.nodeId !== cluster.primaryNodeId && entry.nodeId !== currentConfig.deviceId);
    let winningActive: { url: string; status: ClusterNodeStatus; authority: AuthorityTuple } | undefined;

    await Promise.all(otherHubs.map(async (candidate) => {
      if (!candidate.urls.length) return;
      try {
        const probed = await probeClusterNode(candidate.urls, currentConfig.clientToken);
        observedClusterNodes.set(candidate.nodeId, { status: probed.status, url: probed.url, observedAt: Date.now() });
        if (probed.status.active) {
          const authority: AuthorityTuple = {
            epoch: probed.status.epoch,
            isPreferredPrimary: probed.status.isPreferredPrimary,
            nodeId: probed.status.nodeId,
          };
          if (isAuthorityHigher(authority, currentAuthority)) {
            if (!winningActive || isAuthorityHigher(authority, winningActive.authority)) {
              winningActive = { url: probed.url, status: probed.status, authority };
            }
          }
        }
      } catch {
        // Candidate unreachable.
      }
    }));

    if (winningActive) {
      switchHub(winningActive.url);
      return;
    }

    // 3. Increment awake consecutive failure tracking; surface manual failover offer only after threshold.
    consecutivePrimaryProbeFailures += 1;
    if (awakeOfflineSince === undefined) awakeOfflineSince = now;
    if (consecutivePrimaryProbeFailures < minFailedRounds || now - awakeOfflineSince < offlineThresholdMs) {
      return;
    }

    const candidates: ClusterFailoverCandidate[] = [];
    if (isStandbyEnabled() && standbyHost) {
      const selfSync = standbyHost.getSyncStatus();
      candidates.push({
        nodeId: currentConfig.deviceId,
        name: currentConfig.name,
        urls: [],
        syncedAt: selfSync.syncedAt,
        syncedGeneration: selfSync.syncedGeneration,
        syncState: selfSync.state,
        reachable: true,
        isSelf: true,
        canPromote: standbyHost.canPromote() && !promoting && roleTransitions.canLeave,
      });
    }
    for (const hubEntry of otherHubs) {
      const observed = observedClusterNodes.get(hubEntry.nodeId);
      const fresh = Boolean(observed && Date.now() - observed.observedAt < 20_000);
      candidates.push({
        nodeId: hubEntry.nodeId,
        name: hubEntry.name,
        urls: hubEntry.urls,
        syncedAt: observed?.status.syncedAt ?? hubEntry.lastSyncedAt,
        syncedGeneration: observed?.status.syncedGeneration ?? hubEntry.syncedGeneration,
        syncState: observed?.status.syncState ?? hubEntry.syncState,
        reachable: fresh,
        isSelf: false,
        canPromote: Boolean(fresh && observed?.status.canPromote),
      });
    }

    const promotable = candidates.filter((entry) => entry.reachable && entry.canPromote);
    if (promotable.length > 0) {
      const primaryEntry = cluster.hubs.find((entry) => entry.nodeId === cluster.primaryNodeId);
      failoverOffer = {
        offlinePrimaryNodeId: cluster.primaryNodeId,
        offlinePrimaryName: primaryEntry?.name ?? activeHub.host,
        offlineSince: awakeOfflineSince,
        candidates,
      };
    } else {
      failoverOffer = undefined;
    }
  };

  const handleRemoteClusterRequest = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const rawUrl = request.url ?? "";
    if (!rawUrl.startsWith("/_kulo/cluster/") || rawUrl.includes("\\") || rawUrl.includes("?")) {
      response.writeHead(403, { connection: "close" }).end("Forbidden");
      return;
    }
    // Reject browser cross-site / cookie / proxy-forwarded requests on non-loopback cluster RPCs.
    if (
      request.headers.origin ||
      request.headers.cookie ||
      request.headers.forwarded ||
      request.headers["x-forwarded-for"] ||
      request.headers["x-real-ip"] ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.writeHead(403, { connection: "close" }).end("Forbidden");
      return;
    }
    const routeKey = `${request.method ?? ""} ${rawUrl}`;
    if (!ALLOWED_REMOTE_CLUSTER_ROUTES.has(routeKey)) {
      response.writeHead(403, { connection: "close" }).end("Forbidden");
      return;
    }
    if (!isStandbyEnabled() || !standbyHost) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify({ error: "当前设备未启用备用主机。", code: "standby_disabled" }));
      return;
    }
    const bodyBuf = request.method === "POST" ? await readBoundedBody(request, 64 * 1024) : Buffer.alloc(0);
    const authHeader = typeof request.headers[CLUSTER_AUTH_HEADER] === "string" ? request.headers[CLUSTER_AUTH_HEADER] : undefined;

    if (routeKey === "GET /_kulo/cluster/status") {
      const auth = nonceGuard.verifyAndConsume({
        headerValue: authHeader,
        method: "GET",
        pathWithQuery: rawUrl,
        resolveSecret: (nodeId) => {
          if (standbyHost.isRevokedDevice(nodeId)) return undefined;
          return standbyHost.resolveClusterClientSecret(nodeId) ?? standbyHost.resolveClusterSyncSecret(nodeId);
        },
      });
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ error: "Unauthorized", code: auth.reason }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify(buildLocalNodeStatus()));
      return;
    }

    if (routeKey === "POST /_kulo/cluster/prepare-promote") {
      const auth = nonceGuard.verifyAndConsume({
        headerValue: authHeader,
        method: "POST",
        pathWithQuery: rawUrl,
        body: bodyBuf,
        resolveSecret: (nodeId) => {
          if (standbyHost.isRevokedDevice(nodeId)) return undefined;
          return standbyHost.resolveClusterSyncSecret(nodeId);
        },
      });
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ error: "Unauthorized", code: auth.reason }));
        return;
      }
      let payload: { hubId?: string; epoch?: number; nodeId?: string; isPreferredPrimary?: boolean; leaseMs?: number };
      try { payload = JSON.parse(bodyBuf.toString("utf8")); }
      catch {
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "无效的切主租约请求。" }));
        return;
      }
      if (!payload.hubId || payload.hubId !== currentConfig.cluster?.hubId || typeof payload.epoch !== "number" || payload.nodeId !== auth.nodeId) {
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "切主租约参数不匹配。" }));
        return;
      }
      const requester: AuthorityTuple = {
        epoch: payload.epoch,
        isPreferredPrimary: payload.isPreferredPrimary === true,
        nodeId: auth.nodeId,
      };
      const now = Date.now();
      if (promoting) {
        const localTuple = myAuthorityTuple((currentConfig.cluster?.epoch ?? 1) + 1);
        if (compareAuthorityTuples(localTuple, requester) >= 0) {
          response.writeHead(409, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ error: "本机具有更高优先级且正在切换为主机。", code: "promote_conflict" }));
          return;
        }
      }
      if (promoteLease && promoteLease.expiresAt > now && compareAuthorityTuples(promoteLease.holder, requester) > 0) {
        response.writeHead(409, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "另一台更高优先级的备用主机已取得切主租约。", code: "promote_conflict" }));
        return;
      }
      promoteLease = { holder: requester, expiresAt: now + Math.min(Math.max(payload.leaseMs ?? 10_000, 2_000), 20_000) };
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify({ granted: true, expiresAt: promoteLease.expiresAt }));
      return;
    }

    if (routeKey === "POST /_kulo/cluster/promote") {
      const auth = nonceGuard.verifyAndConsume({
        headerValue: authHeader,
        method: "POST",
        pathWithQuery: rawUrl,
        body: bodyBuf,
        resolveSecret: (nodeId) => {
          if (standbyHost.isRevokedDevice(nodeId)) return undefined;
          return standbyHost.resolveClusterClientSecret(nodeId);
        },
      });
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ error: "Unauthorized", code: auth.reason }));
        return;
      }
      try {
        const nextEpoch = (currentConfig.cluster?.epoch ?? 1) + 1;
        const change = await executeLocalPromotion({
          targetEpoch: nextEpoch,
          reason: "failover",
          requirePrimaryOffline: true,
        });
        scheduleAfterResponse(response, change.start);
        response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ ...change.receipt, epoch: nextEpoch }));
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "promote_failed";
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "切换为主机失败。", code }));
      }
      return;
    }

    if (routeKey === "POST /_kulo/cluster/handover-accept") {
      const auth = nonceGuard.verifyAndConsume({
        headerValue: authHeader,
        method: "POST",
        pathWithQuery: rawUrl,
        body: bodyBuf,
        resolveSecret: (nodeId) => {
          if (nodeId !== currentConfig.cluster?.primaryNodeId) return undefined;
          return currentConfig.standby?.syncToken;
        },
      });
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ error: "Unauthorized", code: auth.reason }));
        return;
      }
      let payload: { hubId?: string; targetEpoch?: number; finalGeneration?: number; primaryUrl?: string };
      try { payload = JSON.parse(bodyBuf.toString("utf8")); }
      catch {
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "无效的交接请求。" }));
        return;
      }
      if (
        !currentConfig.cluster ||
        payload.hubId !== currentConfig.cluster.hubId ||
        typeof payload.targetEpoch !== "number" ||
        payload.targetEpoch <= currentConfig.cluster.epoch ||
        typeof payload.finalGeneration !== "number" ||
        !currentConfig.standby?.syncToken
      ) {
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "交接参数无效或纪元过期。" }));
        return;
      }
      try {
        const primaryHub = currentConfig.cluster.hubs.find((entry) => entry.nodeId === currentConfig.cluster!.primaryNodeId);
        await standbyHost.syncForHandover({
          primaryUrl: payload.primaryUrl ? normalizePeerHubUrl(payload.primaryUrl) : activeHub.origin,
          primaryNodeId: currentConfig.cluster.primaryNodeId,
          ...(primaryHub?.identityPublicKey ? { primaryIdentityPublicKey: primaryHub.identityPublicKey } : {}),
          epoch: currentConfig.cluster.epoch,
          targetGeneration: payload.finalGeneration,
          syncToken: currentConfig.standby.syncToken,
        });
        const change = await executeLocalPromotion({
          targetEpoch: payload.targetEpoch,
          reason: "handover",
          requirePrimaryOffline: false,
        });
        // Await actual Hub startup completion before replying 200 so old primary only demotes once new primary is live!
        // Close listener response after replying 202 OR confirm activation; because startHub swaps this same server port,
        // reply 202 first and let old primary verify new primary is active on /_kulo/cluster/status.
        scheduleAfterResponse(response, change.start);
        response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ accepted: true, targetEpoch: payload.targetEpoch, transitionId: change.receipt.id }));
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "备用主机无法完成交接。" }));
      }
    }
  };

  const isSameHub = async (input: DeviceChatInvitation): Promise<boolean> => {
    const sameOrigin = input.hubUrl === activeHub.origin;
    if (!sameOrigin && (!input.hubId || !agent.registered)) return false;
    let identity: Awaited<ReturnType<typeof authenticatedPeerHub>>;
    try { identity = await authenticatedPeerHub(currentConfig, sameOrigin ? 8_000 : 2_000); }
    catch (error) {
      if (!sameOrigin || (error && typeof error === "object" && "code" in error && error.code === "device_invitation_invalid")) return false;
      throw error;
    }
    if (sameOrigin && input.hubId && input.hubId !== identity.hubId) throw invalidDeviceInvitation();
    if (!sameOrigin && (identity.hubId !== input.hubId || !identity.hubUrls.includes(input.hubUrl))) return false;
    await probeSharedUi().catch(() => { throw deviceHostUnreachable(); });
    if (!agent.registered) throw deviceHostUnreachable();
    return true;
  };

  const server = http.createServer((request, response) => {
    // Hard socket-level boundary for non-loopback traffic (P0-9): never expose UI, static assets, or proxy routes.
    if (!isLoopbackSocket(request.socket.remoteAddress)) {
      void handleRemoteClusterRequest(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { connection: "close" }).end();
        else response.destroy();
      });
      return;
    }

    // Loopback cluster status / RPC also allowed when local loopback probes cluster endpoints directly (e.g. same-host tests).
    if (request.url?.startsWith("/_kulo/cluster/") && request.headers[CLUSTER_AUTH_HEADER]) {
      void handleRemoteClusterRequest(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { connection: "close" }).end();
        else response.destroy();
      });
      return;
    }

    const target = upstreamTarget(request);
    if (!target) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!target.pathname.startsWith("/api/") && !target.pathname.startsWith("/_kulo/") && !target.pathname.startsWith("/ws/") && !target.pathname.startsWith("/connect/")) {
      if (tryServeLocalWebAsset(options.webDistDir, target.pathname, request.method, response)) return;
    }
    if (request.method === "GET" && target.pathname === "/_kulo/peer-status") {
      if (!isAuthorizedLocal(request, target)) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        deviceId: currentConfig.deviceId,
        hubUrl: activeHub.origin,
        ready: initiallyReady && agent.registered && !readinessError,
        error: readinessError,
        pid: process.pid,
        cluster: buildLocalClusterStatus(),
      }));
      return;
    }
    if (request.method === "GET" && target.pathname === "/_kulo/instance") {
      const status = { role: "joined" as const, hubUrl: activeHub.origin, ready: initiallyReady && agent.registered && !readinessError, error: readinessError };
      const verified = !closed && (owner.proveLocalIdentity(request, response, localAuthToken, status) ||
        options.runtimeOwner?.proveLocalIdentity(request, response, localAuthToken, status));
      response.writeHead(verified ? 200 : 403, { "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "GET" && target.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, version: KULO_VERSION }));
      return;
    }
    if (target.pathname.startsWith("/api/") && !isAuthorizedLocal(request, target)) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (["/api/devices/join", "/api/devices/leave", "/api/devices/role-transition", "/api/devices/cluster-status", "/api/devices/promote"].includes(target.pathname) && !isLocalControl(request)) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "请在本机操作设备连接。" }));
      return;
    }
    if (request.method === "GET" && target.pathname === "/api/devices/cluster-status") {
      const localStatus = buildLocalClusterStatus();
      if (!localStatus.primaryOnline) {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(localStatus));
        return;
      }
      void (async () => {
        let merged = localStatus;
        try {
          const upstreamRes = await fetch(new URL("/api/devices/cluster-status", activeHub), {
            method: "GET",
            redirect: "error",
            headers: { authorization: `Bearer ${currentConfig.clientToken}` },
            signal: AbortSignal.timeout(3_000),
          });
          if (upstreamRes.ok) {
            const upstream = await upstreamRes.json() as Partial<ClusterLocalStatusView>;
            merged = {
              ...localStatus,
              ...(upstream.failbackOffer ? { failbackOffer: upstream.failbackOffer } : {}),
              ...(!localStatus.conflictBackupNotice && upstream.conflictBackupNotice
                ? { conflictBackupNotice: upstream.conflictBackupNotice }
                : {}),
            };
          }
        } catch {
          // Non-fatal: keep local status view if upstream status probe fails.
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(merged));
      })();
      return;
    }
    if (request.method === "DELETE" && target.pathname === "/api/devices/cluster-conflict-notice") {
      if (!isLocalControl(request)) {
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "请在本机操作设备连接。" }));
        return;
      }
      standbyHost?.clearConflictNotice?.();
      if (!agent.registered || readinessError) {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      // Fall through to proxy DELETE to upstream Hub so Hub's notice is also cleared.
    }
    if (request.method === "POST" && target.pathname === "/api/devices/promote") {
      void (async () => {
        const raw = await readBoundedBody(request, 32 * 1024);
        let body: { targetNodeId?: unknown } = {};
        if (raw.length > 0) {
          try { body = JSON.parse(raw.toString("utf8")); }
          catch { throw Object.assign(new Error("切换请求格式无效。"), { status: 400 }); }
        }
        const targetNodeId = typeof body.targetNodeId === "string" && body.targetNodeId.trim()
          ? body.targetNodeId.trim()
          : currentConfig.deviceId;
        if (targetNodeId === currentConfig.deviceId) {
          const header = request.headers["x-kulo-transition-id"];
          const transitionId = typeof header === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(header) ? header : undefined;
          const change = await executeLocalPromotion({
            reason: "failover",
            requestedId: transitionId,
            requirePrimaryOffline: false,
          });
          startAfterResponse(response, change);
          return;
        }
        const switched = await executeRemotePromotion(targetNodeId);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ delegated: true, targetNodeId, status: "ready", targetRole: "joined", epoch: switched.epoch, hubUrl: switched.url }));
      })().catch((error: unknown) => {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "切换主机失败。", code }));
      });
      return;
    }
    if (request.method === "GET" && target.pathname === "/api/devices/role-transition") {
      const change = roleTransitions.lookup(target.searchParams.get("id") ?? "");
      response.writeHead(change ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(change ?? { error: "未找到这次运行模式切换。" }));
      return;
    }
    if (request.method === "POST" && target.pathname === "/api/devices/leave") {
      if (!canSwitchRole) {
        response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "当前运行模式不支持在线退出主机。" }));
        return;
      }
      try {
        const header = request.headers["x-kulo-transition-id"];
        const change = roleTransitions.leave(currentConfig, typeof header === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(header) ? header : undefined);
        startAfterResponse(response, change);
      } catch (error) {
        response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "当前无法切换运行模式。" }));
      }
      return;
    }
    if (request.method === "POST" && target.pathname === "/api/devices/join") {
      void (async () => {
        const { input, force, rootDir } = await readPeerJoin(request);
        if ([`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(input.hubUrl)) {
          throw Object.assign(new Error("无法将设备接入自己的本机入口。"), { status: 400 });
        }
        const header = request.headers["x-kulo-transition-id"];
        const id = typeof header === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(header) ? header : undefined;
        const checkTasks = async () => {
          if (!force && agent.hasActiveExecution) throw Object.assign(new Error("本机正在执行任务，切换主机会中断执行。"), { code: "local_tasks_running" });
        };
        const change = roleTransitions.join(input, checkTasks, id, rootDir ?? currentConfig.rootDir, { config: currentConfig, isSameHub: () => isSameHub(input) });
        startAfterResponse(response, change);
      })().catch((error: unknown) => {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: status < 500 && error instanceof Error ? error.message : "无法处理设备接入请求。", code }));
      });
      return;
    }
    if (request.method === "GET" && target.pathname === "/api/devices") {
      const local = isLocalControl(request);
      const upstreamUrl = new URL(target.toString());
      upstreamUrl.searchParams.delete("token");
      void (async () => {
        try {
          const upstreamRes = await fetch(upstreamUrl, {
            method: "GET",
            redirect: "error",
            headers: { authorization: `Bearer ${currentConfig.clientToken}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (upstreamRes.ok) {
            const data = await upstreamRes.json() as DeviceInterconnectionView;
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({
              ...data,
              currentDeviceKnown: local,
              canSwitchRole: canSwitchRole && local,
              canManageHub: Boolean(data.canManageHub) && local,
              canManageStandby: Boolean(data.canManageStandby) && local,
            }));
            return;
          }
          if (upstreamRes.status === 401 || upstreamRes.status === 403) {
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify(offlineJoinedView("主机已移除此设备或已关闭设备互联，请断开连接以恢复独立运行。", local)));
            return;
          }
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(offlineJoinedView(`主机响应异常（HTTP ${upstreamRes.status}），可重试或断开连接恢复独立运行。`, local)));
        } catch {
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(offlineJoinedView(readinessError ?? `无法连接主机 ${activeHub.origin}，请检查主机是否在线或断开连接恢复独立运行。`, local)));
        }
      })();
      return;
    }
    target.searchParams.delete("token");
    const isHttps = activeHub.protocol === "https:";
    const transport = isHttps ? https : http;
    const agentForRequest = isHttps ? httpsAgent : httpAgent;
    let connectTimer: NodeJS.Timeout | undefined;
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    const upstream = transport.request(target, {
      method: request.method,
      headers: requestHeaders(request.headers, activeHub, currentConfig.clientToken),
      agent: agentForRequest,
    }, (upstreamResponse) => {
      clearConnectTimer();
      const headers = { ...upstreamResponse.headers };
      delete headers["set-cookie"];
      if (headers.location?.startsWith(activeHub.origin)) {
        const location = new URL(headers.location);
        if (location.origin === activeHub.origin) headers.location = `${location.pathname}${location.search}${location.hash}`;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });
    activeUpstreams.add(upstream);
    const cleanupUpstream = () => {
      clearConnectTimer();
      activeUpstreams.delete(upstream);
    };
    upstream.once("close", cleanupUpstream);
    if (proxyConnectTimeoutMs > 0) {
      upstream.once("socket", (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => {
          connectTimer = undefined;
          upstream.destroy(new Error("Upstream connection timed out"));
        }, proxyConnectTimeoutMs);
        connectTimer.unref();
        const connectedEvent = isHttps ? "secureConnect" : "connect";
        socket.once(connectedEvent, clearConnectTimer);
        socket.once("error", clearConnectTimer);
        socket.once("close", clearConnectTimer);
      });
    }
    upstream.on("error", () => {
      cleanupUpstream();
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "无法连接主脑，请检查主脑及网络连接。" }));
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket, head) => {
    // Hard socket-level boundary (P0-9): Standby never accepts remote WebSocket upgrades.
    if (!isLoopbackSocket(request.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const target = upstreamTarget(request);
    const allowedSocketPath = target && (
      target.pathname === "/ws/client" ||
      target.pathname === "/ws/computer-preview" ||
      /^\/api\/voice\/calls\/[^/]+\/socket$/.test(target.pathname)
    );
    if (!target || !allowedSocketPath) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!isAuthorizedLocal(request, target)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    target.protocol = activeHub.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.delete("token");
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${currentConfig.clientToken}`, origin: activeHub.origin } });
    webSockets.add(upstream);
    const timeout = setTimeout(() => {
      upstream.terminate();
      socket.destroy();
    }, 10_000);
    upstream.once("open", () => {
      clearTimeout(timeout);
      wss.handleUpgrade(request, socket, head, (client) => {
        webSockets.add(client);
        client.on("message", (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on("message", (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        client.on("close", () => {
          webSockets.delete(client);
          upstream.close();
        });
        upstream.on("close", () => client.close(1001));
        client.on("error", () => upstream.terminate());
      });
    });
    upstream.on("error", () => {
      clearTimeout(timeout);
      socket.destroy();
    });
    upstream.once("close", () => {
      clearTimeout(timeout);
      webSockets.delete(upstream);
      if (!socket.destroyed) socket.destroy();
    });
    socket.once("close", () => upstream.terminate());
  });

  const envUrl = new URL("/ws/env", activeHub);
  envUrl.protocol = activeHub.protocol === "https:" ? "wss:" : "ws:";
  const protectedPaths = Array.from(new Set([
    path.dirname(resolvedConfigPath),
    ...(options.protectedPaths ?? []).map((entry) => path.resolve(entry)),
  ]));

  // Construct KuloEnvAgent before binding the port so invalid workspace configs never leak a listening socket;
  // `agent.start()` runs only AFTER `server.listen()` resolves so `getListenPort()` always reports the bound port.
  agent = new KuloEnvAgent({
    hubUrl: envUrl.toString(),
    envId: currentConfig.deviceId,
    name: currentConfig.name,
    rootDir: currentConfig.rootDir,
    authToken: currentConfig.envToken,
    protectedPaths,
    getListenPort: () => (port > 0 ? port : undefined),
    warmStandbyCapable: Boolean(standbyHost),
    getClusterEpoch: () => currentConfig.cluster?.epoch,
    getStandbyPublicKey: () => standbyHost?.getStandbyPublicKey(),
    getIdentityPublicKey: () => standbyHost?.getIdentityPublicKey(),
    onClusterTopology: (topology) => {
      if (isClusterTopology(topology)) applyClusterTopology(topology);
    },
    onStandbyAuth: (standby) => {
      if (!standbyHost) return;
      if (!standby.enabled) {
        void revokeLocalStandby("standby_disabled");
        return;
      }
      const activate = (pub: string, idPub?: string) => {
        persistConfigUpdate((prev) => ({
          ...prev,
          standby: {
            enabled: true,
            syncToken: standby.syncToken,
            publicKey: pub,
            ...(idPub ? { identityPublicKey: idPub } : {}),
          },
        }));
        scheduleRebindListener("0.0.0.0");
        buildStandbyConfigForBridge();
      };
      const cachedPub = standbyHost.getStandbyPublicKey();
      if (cachedPub) {
        activate(cachedPub, standbyHost.getIdentityPublicKey());
      } else {
        void standbyHost.ensureSyncKeys()
          .then(({ standbyPublicKey, identityPublicKey }) => activate(standbyPublicKey, identityPublicKey))
          .catch(() => { /* retry on next register */ });
      }
    },
    onSyncAvailable: (notice) => {
      if (isStandbyEnabled()) standbyHost?.notifySyncAvailable(notice);
    },
    onStandbyWipe: (reason) => {
      void revokeLocalStandby(reason);
    },
    onClusterHandover: (directive) => {
      handleClusterHandoverDirective(directive);
    },
    onConnectionStateChange: (registered) => {
      if (registered) {
        consecutivePrimaryProbeFailures = 0;
        awakeOfflineSince = undefined;
        failoverOffer = undefined;
      }
    },
    ...(options.heartbeatIdleMs !== undefined ? { heartbeatIdleMs: options.heartbeatIdleMs } : {}),
    ...(options.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
    onLog: options.onLog,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? currentConfig.localPort ?? 7788, listenHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动本机 Kulo 访问入口。");
  port = address.port;
  try {
    server.once("close", owner.publish(address));
    if (options.runtimeOwner) server.once("close", options.runtimeOwner.publish(address));
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  if (standbyHost) {
    try {
      await standbyHost.ensureSyncKeys();
    } catch {
      // Keychain may be temporarily locked; keys will be loaded when unlocked
    }
  }
  if (isStandbyEnabled()) {
    buildStandbyConfigForBridge();
  }

  const verifySharedUi = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/topics`, {
      redirect: "error",
      headers: { authorization: `Bearer ${localAuthToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new Error("执行端已连接，但无法访问主脑对话，请检查主脑及网络连接。"); });
    if (!response.ok) throw new Error(`执行端已连接，但主脑拒绝了界面访问（HTTP ${response.status}）。`);
    const data: unknown = await response.json().catch(() => { throw new Error("主脑对话接口未返回有效数据。"); });
    if (!data || typeof data !== "object" || !Array.isArray((data as { items?: unknown }).items)) {
      throw new Error("主脑对话接口未返回有效数据。");
    }
  };
  const recordReadinessError = (error: unknown) => {
    const message = error instanceof Error ? error.message : "设备连接失败。";
    if (readinessError !== message) options.onLog?.(message);
    readinessError = message;
  };
  const probeSharedUi = (): Promise<void> => {
    if (readinessProbe) return readinessProbe;
    const probe = verifySharedUi();
    readinessProbe = probe;
    void probe.then(() => {
      readinessProbe = undefined;
      initiallyReady = true;
      readinessError = undefined;
      retryAttempt = 0;
    }, (error: unknown) => {
      readinessProbe = undefined;
      recordReadinessError(error);
      if (closed) return;
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryAttempt++, 4));
      readinessRetry = setTimeout(() => {
        readinessRetry = undefined;
        void probeSharedUi();
      }, delay);
      readinessRetry.unref();
    });
    return probe;
  };

  const clusterMonitorTimer = setInterval(() => {
    if (closed || probeInFlight) return;
    probeInFlight = runClusterMonitorSweep().finally(() => { probeInFlight = undefined; });
  }, probeIntervalMs);
  clusterMonitorTimer.unref();

  const ready = agent.start().then(probeSharedUi);
  ready.catch((error: unknown) => {
    if (!closed) recordReadinessError(error);
  });

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    authToken: localAuthToken,
    ready,
    probeConnection() {
      if (closed) return;
      // Grant 8s network recovery grace on OS wake from sleep (P1-2).
      const now = Date.now();
      resumeGraceUntil = Math.max(resumeGraceUntil, now + resumeGraceMs);
      lastTickAt = now;
      consecutivePrimaryProbeFailures = 0;
      awakeOfflineSince = undefined;
      failoverOffer = undefined;
      agent.probeConnection();
      if (!initiallyReady || readinessError) {
        if (readinessRetry) {
          clearTimeout(readinessRetry);
          readinessRetry = undefined;
        }
        retryAttempt = 0;
        void probeSharedUi();
      }
    },
    switchHub,
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(clusterMonitorTimer);
        if (readinessRetry) clearTimeout(readinessRetry);
        await listenerTransition.catch(() => {});
        for (const req of [...activeUpstreams]) req.destroy();
        httpAgent.destroy();
        httpsAgent.destroy();
        for (const ws of webSockets) ws.terminate();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
        wss.close();
        const results = await Promise.allSettled([
          standbyHost?.close(),
          agent.stop(),
          new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        ]);
        owner.close();
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
      return closing;
    },
  };
}

export async function runInstalledPeer(configPath = getPeerConfigPath()): Promise<DevicePeerRuntime> {
  const config = readPeerConfig(configPath);
  if (!config) throw new Error("尚未加入主脑，请先运行设备接入命令。");
  return startDevicePeer(config, { configPath, onLog: (message) => console.log(message) });
}

export { renderPeerInstaller } from "./peer-installer.js";
