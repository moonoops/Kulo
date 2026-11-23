import type http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  parseDeviceJoinInput,
  type ClusterConflictBackupNotice,
  type ClusterFailoverOffer,
  type ClusterLocalStatusView,
  type ClusterNodeStatus,
  type ClusterSyncStatus,
  type DeviceChatInvitation,
  type DeviceInterconnectionView,
  type DevicePeerConfig,
  type InterconnectedDevice,
} from "@kulo/protocol";
import { collectDeviceSystemInfo } from "./device-info.js";
import type { PreparedDeviceRoleChange } from "./device-role-transitions.js";
import { invalidDeviceInvitation } from "./peer-config.js";

export function equalPeerToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function readPeerBoundedBody(request: http.IncomingMessage, maxBytes = 256 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > maxBytes) throw Object.assign(new Error("请求体过长。"), { status: 413 });
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

export async function readPeerJoinRequest(request: http.IncomingMessage) {
  const raw = await readPeerBoundedBody(request, 256 * 1024);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { throw Object.assign(new Error("接入请求格式无效。"), { status: 400 }); }
  if (!body || typeof body.input !== "string") throw Object.assign(invalidDeviceInvitation(), { status: 400 });
  if (body.rootDir !== undefined && (typeof body.rootDir !== "string" || !body.rootDir.trim() || body.rootDir.length > 4096 || /[\x00-\x1f]/.test(body.rootDir))) {
    throw Object.assign(new Error("设备工作目录无效。"), { status: 400 });
  }
  let input: DeviceChatInvitation;
  try { input = parseDeviceJoinInput(body.input, typeof body.token === "string" ? body.token : undefined); }
  catch { throw Object.assign(invalidDeviceInvitation(), { status: 400 }); }
  return { input, force: body.force === true, rootDir: body.rootDir as string | undefined };
}

export function schedulePeerAfterResponse(response: http.ServerResponse, start: () => unknown): void {
  let scheduled = false;
  const trigger = () => {
    if (scheduled) return;
    scheduled = true;
    response.off("finish", trigger);
    response.off("close", trigger);
    setTimeout(() => { void start(); }, 25);
  };
  response.shouldKeepAlive = false;
  response.once("finish", trigger);
  response.once("close", trigger);
  if (response.destroyed) trigger();
}

export function startPeerAfterResponse(response: http.ServerResponse, change: PreparedDeviceRoleChange): void {
  schedulePeerAfterResponse(response, change.start);
  if (response.destroyed) return;
  response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(change.receipt));
}

export function forwardPeerRequestHeaders(headers: http.IncomingHttpHeaders, hub: URL, token: string): http.OutgoingHttpHeaders {
  const hadProxyHeaders = Boolean(
    headers.forwarded ||
    headers["x-forwarded-for"] ||
    headers["x-real-ip"] ||
    headers["x-forwarded-host"] ||
    headers["x-forwarded-proto"],
  );
  const forwarded = { ...headers };
  for (const name of ["authorization", "cookie", "proxy-authorization", "proxy-connection", "x-forwarded-host", "x-forwarded-proto"]) {
    delete forwarded[name];
  }
  if (hadProxyHeaders && !forwarded["x-forwarded-for"]) {
    forwarded["x-forwarded-for"] = "127.0.0.1";
  }
  forwarded.host = hub.host;
  forwarded.authorization = `Bearer ${token}`;
  if (forwarded.origin) forwarded.origin = hub.origin;
  return forwarded;
}

export function buildPeerLocalClusterStatus(input: {
  currentConfig: DevicePeerConfig;
  activeHub: URL;
  standbyEnabled: boolean;
  primaryOnline: boolean;
  failoverOffer?: ClusterFailoverOffer;
  syncStatus?: ClusterSyncStatus;
  conflictBackupNotice?: ClusterConflictBackupNotice | null;
}): ClusterLocalStatusView {
  const { currentConfig, activeHub, standbyEnabled, primaryOnline, failoverOffer, syncStatus, conflictBackupNotice } = input;
  const cluster = currentConfig.cluster;
  const clusterActive = Boolean(cluster || standbyEnabled);
  const primaryHub = cluster?.hubs.find((entry) => entry.nodeId === cluster.primaryNodeId);
  const primaryName = primaryHub?.name ?? (clusterActive ? activeHub.host : undefined);
  return {
    enabled: clusterActive,
    ...(cluster?.hubId ? { hubId: cluster.hubId } : {}),
    nodeId: currentConfig.deviceId,
    role: standbyEnabled ? "standby" : "peer",
    epoch: cluster?.epoch ?? 1,
    primaryNodeId: cluster?.primaryNodeId,
    preferredPrimaryNodeId: cluster?.preferredPrimaryNodeId,
    primaryOnline,
    ...(primaryName ? { primaryName } : {}),
    ...(!primaryOnline && failoverOffer ? { failoverOffer } : {}),
    ...(standbyEnabled && syncStatus ? { syncStatus } : {}),
    ...(conflictBackupNotice ? { conflictBackupNotice } : {}),
  };
}

export function buildOfflineJoinedDeviceView(input: {
  currentConfig: DevicePeerConfig;
  activeHub: URL;
  standbyEnabled: boolean;
  hasStandbyHost: boolean;
  syncStatus?: ClusterSyncStatus;
  observedClusterNodes: ReadonlyMap<string, { status: ClusterNodeStatus; url: string; observedAt: number }>;
  reason: string;
  local: boolean;
  canSwitchRole: boolean;
  primaryUrls: string[];
  failoverOffer?: ClusterFailoverOffer;
}): DeviceInterconnectionView {
  const {
    currentConfig, activeHub, standbyEnabled, hasStandbyHost, syncStatus,
    observedClusterNodes, reason, local, canSwitchRole, primaryUrls, failoverOffer,
  } = input;
  const cluster = currentConfig.cluster;
  const devices: InterconnectedDevice[] = [];
  if (cluster) {
    for (const hubEntry of cluster.hubs) {
      const isSelf = hubEntry.nodeId === currentConfig.deviceId;
      const observed = observedClusterNodes.get(hubEntry.nodeId);
      const selfSync = isSelf && standbyEnabled ? syncStatus : undefined;
      const status: InterconnectedDevice["status"] = isSelf
        ? "online"
        : observed && Date.now() - observed.observedAt < 30_000
          ? "online"
          : "offline";
      devices.push({
        id: hubEntry.nodeId,
        name: hubEntry.name,
        kind: hubEntry.role === "primary" ? "local" : "reverse-ws",
        status,
        rootDir: isSelf ? currentConfig.rootDir : "",
        ...(isSelf ? { info: collectDeviceSystemInfo() } : {}),
        clusterRole: hubEntry.role,
        isPreferredPrimary: hubEntry.nodeId === cluster.preferredPrimaryNodeId,
        warmStandbyCapable: true,
        ...(selfSync
          ? { syncStatus: selfSync }
          : observed?.status.syncState
            ? {
                syncStatus: {
                  state: observed.status.syncState,
                  syncedAt: observed.status.syncedAt,
                  syncedGeneration: observed.status.syncedGeneration,
                },
              }
            : hubEntry.syncState
              ? {
                  syncStatus: {
                    state: hubEntry.syncState,
                    syncedAt: hubEntry.lastSyncedAt,
                    syncedGeneration: hubEntry.syncedGeneration,
                    ...(hubEntry.syncError ? { error: hubEntry.syncError } : {}),
                  },
                }
              : {}),
      });
    }
    if (!devices.some((entry) => entry.id === currentConfig.deviceId)) {
      devices.push({
        id: currentConfig.deviceId,
        name: currentConfig.name,
        kind: "reverse-ws",
        status: "online",
        rootDir: currentConfig.rootDir,
        info: collectDeviceSystemInfo(),
        clusterRole: "peer",
        warmStandbyCapable: hasStandbyHost,
      });
    }
  } else {
    devices.push(
      { id: "hub", name: activeHub.host, kind: "local", status: "offline", rootDir: "", clusterRole: "primary" },
      { id: currentConfig.deviceId, name: currentConfig.name, kind: "reverse-ws", status: "offline", rootDir: currentConfig.rootDir, info: collectDeviceSystemInfo(), clusterRole: "peer" },
    );
  }
  const primaryHub = cluster?.hubs.find((entry) => entry.nodeId === cluster.primaryNodeId);
  return {
    enabled: true,
    role: "joined",
    hubId: cluster?.hubId ?? activeHub.origin,
    hubName: primaryHub?.name ?? activeHub.host,
    currentDeviceId: currentConfig.deviceId,
    currentDeviceKnown: local,
    canSwitchRole: canSwitchRole && local,
    canManageHub: false,
    canManageStandby: false,
    primaryNodeId: cluster?.primaryNodeId,
    preferredPrimaryNodeId: cluster?.preferredPrimaryNodeId,
    clusterEpoch: cluster?.epoch,
    hubError: reason,
    hubUrls: primaryUrls,
    devices,
    ...(failoverOffer ? { failoverOffer } : {}),
  };
}
