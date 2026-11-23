import { randomBytes } from "node:crypto";
import type http from "node:http";
import {
  createClusterAuthHeader,
  probeUrlsHappyEyeballs,
  readOrCreateNodeIdentity,
  saveClusterMembership,
  type DeviceRoleTransitions,
  type PreparedDeviceRoleChange,
} from "@kulo/env";
import {
  formatDeviceChatInvitation,
  parseDeviceJoinInput,
  type ClusterLocalStatusView,
  type ClusterNodeStatus,
  type DeviceChatInvitation,
  type DeviceInterconnectionView,
  type DevicePeerConfig,
  type MobileConnectionMetadata,
} from "@kulo/protocol";
import {
  clearConflictBackupNotice,
  readConflictBackupNotice,
  type ClusterFenceMonitor,
  type ClusterPaths,
} from "../cluster-lifecycle.js";
import type { ClusterSyncService } from "../cluster-sync.js";
import type { DeviceSshAddRequest } from "@kulo/protocol";
import type { DeviceSshConnector } from "../device-ssh.js";
import { toDeviceSshHttpError } from "./device-ssh-routes.js";
import { DeviceConnectionError, type DeviceInterconnectionManager } from "../devices.js";
import type { MobileConnector, MobileConnectorStatus } from "../mobile-connector.js";
import type { HubHttpRouteContext } from "./context.js";

const CLUSTER_AUTH_HEADER = "x-kulo-cluster-auth";

export interface DevicesClusterRoutesDeps {
  devices: DeviceInterconnectionManager;
  sshDevices: DeviceSshConnector;
  mobileConnector: MobileConnector;
  roleTransitions: DeviceRoleTransitions;
  clusterSync: ClusterSyncService;
  fenceMonitor: ClusterFenceMonitor;
  clusterPaths: ClusterPaths;
  peerRootDir?: string;
  getActualPort: () => number;
  isClusterActive: () => boolean;
  ensurePrimaryClusterKeys: () => Promise<{ x25519PublicKey: string; ed25519PublicKey: string }>;
  persistPrimaryClusterMembership: (origin?: string) => void;
  requireMobileConnector: (req: http.IncomingMessage) => void;
  mobileMetadata: (status: MobileConnectorStatus) => MobileConnectionMetadata;
  deviceView: (req: http.IncomingMessage, url: URL) => DeviceInterconnectionView;
  setInterconnectionFromHttp: (res: http.ServerResponse, enabled: boolean, force?: boolean) => Promise<void>;
  prepareJoinPeer: (input: DeviceChatInvitation, force: boolean, id?: string, rootDir?: string) => Promise<PreparedDeviceRoleChange>;
  performRemoveDevice: (id: string, force: boolean) => Promise<void>;
}

export async function handleDevicesAndClusterRoutes(
  ctx: HubHttpRouteContext,
  deps: DevicesClusterRoutesDeps,
): Promise<boolean> {
  const { hub, req, res, parsedUrl, pathname, authority, readJsonObject, readJsonBody, sendJson, requestOrigin, currentDevice } = ctx;
  const {
    devices, sshDevices, mobileConnector, roleTransitions, clusterSync, fenceMonitor, clusterPaths,
    getActualPort, isClusterActive, ensurePrimaryClusterKeys, persistPrimaryClusterMembership,
    requireMobileConnector, mobileMetadata, deviceView, setInterconnectionFromHttp, prepareJoinPeer, performRemoveDevice,
  } = deps;
  const actualPort = getActualPort();

  const assertOwnerHubControl = (message: string, code = "device_owner_control_required") => {
    if (!authority.hasOwnerHubControl) throw new DeviceConnectionError(message, 403, code);
  };
  const assertDesktopOrHostOwner = (message: string, code = "device_owner_control_required") => {
    if (!authority.hasOwnerHubControl || authority.isMobilePrincipal || authority.isSshPrincipal) {
      throw new DeviceConnectionError(message, 403, code);
    }
  };

  if (pathname === "/api/mobile/connection" && req.method === "GET") {
    if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
    const deviceId = currentDevice(req, parsedUrl);
    if (authority.isMobilePrincipal) {
      requireMobileConnector(req);
      const status = await mobileConnector.status();
      const metadata = mobileMetadata(status);
      sendJson(res, 200, { ...devices.mobileProfile(deviceId, metadata), tailscale: status.tailscale });
      return true;
    }
    assertOwnerHubControl("请通过受信任的 Kulo 客户端查看手机连接配置。");
    const status = await mobileConnector.status();
    sendJson(res, 200, { ...mobileMetadata(status), tailscale: status.tailscale });
    return true;
  }
  if (pathname === "/api/mobile/connection/login" && req.method === "POST") {
    assertDesktopOrHostOwner("请通过受信任的桌面端或主机配置远程连接。");
    if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
    sendJson(res, 200, { authURL: await mobileConnector.login() });
    return true;
  }
  if (pathname === "/api/mobile/invitations" && req.method === "POST") {
    assertDesktopOrHostOwner("请通过受信任的桌面端或主机添加手机。");
    if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
    const body = await readJsonObject(req);
    const metadata = mobileMetadata(await mobileConnector.status());
    sendJson(res, 201, devices.createMobileInvitation({ name: body.name, ...metadata }));
    return true;
  }
  if (pathname.startsWith("/api/mobile/invitations/") && req.method === "DELETE") {
    assertDesktopOrHostOwner("请通过受信任的桌面端或主机管理手机邀请。");
    devices.cancelMobileInvitation(decodeURIComponent(pathname.slice("/api/mobile/invitations/".length)));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (pathname === "/api/mobile/connection/lease" && req.method === "POST") {
    requireMobileConnector(req);
    const id = currentDevice(req, parsedUrl);
    devices.mobileProfile(id, mobileMetadata(await mobileConnector.status()));
    if (res.destroyed || req.aborted) return true;
    const lease = randomBytes(32).toString("base64url");
    hub.envManager.setDeviceConnectionLease(id, lease);
    sendJson(res, 200, { lease });
    return true;
  }
  if (pathname === "/api/mobile/probe/media" && req.method === "GET") {
    requireMobileConnector(req);
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    res.end("Kulo mobile transport media probe.\n".repeat(2048));
    return true;
  }

  if (pathname === "/api/devices" && req.method === "GET") {
    sendJson(res, 200, deviceView(req, parsedUrl));
    return true;
  }
  if (pathname === "/api/devices" && req.method === "PATCH") {
    if (!authority.isHubLocalDisplay) throw new DeviceConnectionError("请在主脑设备上管理互联开关。", 403);
    const body = await readJsonBody(req) as { enabled?: unknown; force?: unknown };
    if (typeof body?.enabled !== "boolean") throw new DeviceConnectionError("互联开关状态无效。");
    await setInterconnectionFromHttp(res, body.enabled, body.force === true);
    sendJson(res, 200, deviceView(req, parsedUrl));
    return true;
  }
  if (pathname === "/api/devices/chat-invitations" && req.method === "POST") {
    assertOwnerHubControl("请通过受信任的 Kulo 客户端复制接入指令。");
    const body = await readJsonObject(req, 4 * 1024);
    if (typeof body.enable !== "boolean" || typeof body.hubId !== "string") throw new DeviceConnectionError("接入邀请请求无效。");
    if (body.hubId !== devices.hubId) throw new DeviceConnectionError("这条邀请卡属于其他主机。", 409, "device_host_changed");
    if (!devices.enabled && !body.enable) throw new DeviceConnectionError("请开启设备互联后复制。", 409, "device_interconnection_disabled");
    const localView = devices.view(actualPort, `http://127.0.0.1:${actualPort}`);
    const hubUrl = localView.hubUrls[0];
    if (!hubUrl) throw new DeviceConnectionError("未找到其他设备可访问的本机网络地址。", 409, "device_address_unavailable");
    if (!devices.enabled) await setInterconnectionFromHttp(res, true);
    const { invitation, inviteToken } = devices.createInvitation({ hubUrl });
    const instruction = formatDeviceChatInvitation({ hubUrl, inviteToken, hubId: devices.hubId, hubName: hub.connectionManager.redact(localView.hubName) });
    sendJson(res, 201, { instruction, expiresAt: invitation.expiresAt });
    return true;
  }
  if (pathname === "/api/devices/role-transition" && req.method === "GET") {
    if (!authority.isHubLocalDisplay) throw new DeviceConnectionError("请在本机查看角色切换。", 403);
    const transition = roleTransitions.lookup(parsedUrl.searchParams.get("id") ?? "");
    if (!transition) throw new DeviceConnectionError("未找到这次运行模式切换。", 404);
    sendJson(res, 200, transition);
    return true;
  }
  if (pathname === "/api/devices/join" && req.method === "POST") {
    if (!authority.isHubLocalDisplay) throw new DeviceConnectionError("请在本地客户端执行主机接入操作。", 403);
    const body = await readJsonBody(req) as { input?: unknown; token?: unknown; force?: unknown; rootDir?: unknown };
    if (typeof body?.input !== "string" || !body.input.trim()) throw new DeviceConnectionError("请粘贴设备接入命令或输入主机地址。");
    let parsed: DeviceChatInvitation;
    try { parsed = parseDeviceJoinInput(body.input, typeof body.token === "string" ? body.token : undefined); }
    catch (error) { throw new DeviceConnectionError(error instanceof Error ? error.message : "无效的设备接入命令。", 400); }
    const id = req.headers["x-kulo-transition-id"];
    if (body.rootDir !== undefined && (typeof body.rootDir !== "string" || !body.rootDir.trim() || body.rootDir.length > 4096 || body.rootDir.includes("\0"))) {
      throw new DeviceConnectionError("设备工作目录无效。", 400);
    }
    const change = await prepareJoinPeer(parsed, body.force === true, typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : undefined, body.rootDir as string | undefined);
    res.shouldKeepAlive = false;
    res.setHeader("Connection", "close");
    res.once("finish", change.start);
    res.once("close", change.start);
    if (res.destroyed) change.start();
    else sendJson(res, 202, change.receipt);
    return true;
  }
  if (pathname === "/api/devices/invitations" && req.method === "POST") {
    assertOwnerHubControl("请通过受信任的 Kulo 客户端添加设备。");
    const body = await readJsonBody(req) as { name?: unknown; hubUrl?: unknown };
    if (!body || typeof body !== "object") throw new DeviceConnectionError("添加设备请求无效。");
    sendJson(res, 201, devices.createInvitation({ name: body.name, hubUrl: body.hubUrl }).invitation);
    return true;
  }
  if (pathname.startsWith("/api/devices/invitations/") && req.method === "DELETE") {
    assertOwnerHubControl("请通过受信任的 Kulo 客户端取消设备邀请。");
    devices.cancelInvitation(decodeURIComponent(pathname.slice("/api/devices/invitations/".length)));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (pathname === "/api/devices/ssh" && req.method === "POST") {
    assertOwnerHubControl("请通过受信任的 Kulo 客户端添加 SSH 设备。");
    if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
    const body = await readJsonBody(req) as DeviceSshAddRequest;
    try {
      const record = await sshDevices.add(body);
      devices.recordSsh(record);
      sendJson(res, 201, deviceView(req, parsedUrl).devices.find((d) => d.id === record.deviceId));
    } catch (error) {
      throw toDeviceSshHttpError(error);
    }
    return true;
  }
  if (pathname === "/api/devices/cluster-status" && req.method === "GET") {
    const localView = devices.view(actualPort, requestOrigin(req));
    const failbackOffer = devices.getFailbackOffer();
    const conflictNotice = readConflictBackupNotice(clusterPaths);
    const statusView: ClusterLocalStatusView = {
      enabled: isClusterActive(),
      hubId: devices.hubId,
      nodeId: devices.localNodeId,
      role: isClusterActive() ? "primary" : "standalone",
      epoch: devices.clusterEpoch,
      primaryNodeId: devices.primaryNodeId,
      preferredPrimaryNodeId: devices.preferredPrimaryNodeId,
      primaryOnline: true,
      primaryName: localView.hubName,
      ...(failbackOffer ? { failbackOffer } : {}),
      ...(conflictNotice ? { conflictBackupNotice: conflictNotice } : {}),
    };
    sendJson(res, 200, statusView);
    return true;
  }
  if (pathname === "/api/devices/cluster-conflict-notice" && req.method === "DELETE") {
    assertOwnerHubControl("请通过受信任的 Kulo 客户端清除该提示。");
    clearConflictBackupNotice(clusterPaths);
    sendJson(res, 200, { ok: true });
    return true;
  }
  const standbyRoute = /^\/api\/devices\/([^/]+)\/standby$/.exec(pathname);
  if (standbyRoute && req.method === "POST") {
    if (!authority.canManageStandby) {
      throw new DeviceConnectionError("请通过受信任的 Kulo 交互客户端管理备用主机。", 403, "standby_local_control_required");
    }
    const targetId = decodeURIComponent(standbyRoute[1]!);
    const body = await readJsonObject(req, 4 * 1024);
    if (typeof body.enabled !== "boolean") throw new DeviceConnectionError("备用主机开关参数无效。");
    const keys = await ensurePrimaryClusterKeys();
    const myNodeId = devices.localNodeId !== "local"
      ? devices.localNodeId
      : readOrCreateNodeIdentity(clusterPaths.nodeIdentityPath);
    const result = devices.setDeviceStandby(targetId, body.enabled, {
      nodeId: myNodeId,
      standbyPublicKey: keys.x25519PublicKey,
      identityPublicKey: keys.ed25519PublicKey,
      listenPort: actualPort,
      origin: requestOrigin(req),
    });
    if (result.legacyLocalNodeId) await hub.migrateLegacyLocalNode(result.legacyLocalNodeId);
    hub.setClusterHostContext({ localNodeId: devices.localNodeId, legacyLocalNodeId: devices.legacyLocalNodeId });
    persistPrimaryClusterMembership(requestOrigin(req));
    if (body.enabled) {
      clusterSync.start();
      fenceMonitor.start();
      void clusterSync.triggerBaseline().catch((error) => {
        console.error("[ClusterSync] baseline after setStandby failed:", error instanceof Error ? error.message : String(error));
      });
    }
    sendJson(res, 200, deviceView(req, parsedUrl));
    return true;
  }
  if (pathname === "/api/cluster/handover" && req.method === "POST") {
    if (!authority.canManageStandby) {
      throw new DeviceConnectionError("请通过受信任的 Kulo 交互客户端执行主机切换。", 403, "handover_control_required");
    }
    if (!roleTransitions.canJoin) throw new DeviceConnectionError("当前运行模式不支持切换主机。", 409, "handover_unsupported");
    const body = await readJsonObject(req, 8 * 1024);
    const force = body.force === true;
    const targetNodeId = typeof body.targetNodeId === "string" && body.targetNodeId.trim()
      ? body.targetNodeId.trim()
      : (devices.preferredPrimaryNodeId !== devices.primaryNodeId ? devices.preferredPrimaryNodeId : "");
    if (!targetNodeId || devices.isLocalPrincipal(targetNodeId)) {
      throw new DeviceConnectionError("请选择要切换的目标备用主机。", 400, "invalid_handover_target");
    }
    const targetRecord = devices.getStandbyRecord(targetNodeId);
    if (!targetRecord || !targetRecord.syncToken) throw new DeviceConnectionError("目标设备不是已启用的备用主机。", 404, "standby_not_found");
    const targetEnv = hub.envManager.getEnvDescriptor(targetNodeId);
    if (!targetEnv?.online) throw new DeviceConnectionError("目标备用主机当前离线，无法无损切换。", 409, "standby_offline");
    const topology = devices.buildClusterTopology(actualPort, requestOrigin(req));
    const targetHub = topology.hubs.find((h) => h.nodeId === targetNodeId);
    const targetUrls = targetHub?.urls ?? [];
    if (targetUrls.length === 0) throw new DeviceConnectionError("未找到目标备用主机的可访问地址。", 409, "standby_address_unavailable");
    const activeWork = await hub.inspectActiveWorkForHandover();
    if (activeWork.busy && !force) {
      sendJson(res, 409, { error: "当前有正在进行的对话或任务，是否停止并切换主机？", code: "handover_busy", ...activeWork });
      return true;
    }
    if (activeWork.busy && force) await hub.abortActiveWorkForHandover(10_000);
    await ensurePrimaryClusterKeys();
    const targetEpoch = devices.clusterEpoch + 1;
    const primaryUrl = devices.localHubUrls(actualPort, requestOrigin(req))[0] ?? `http://127.0.0.1:${actualPort}`;
    fenceMonitor.stop();
    hub.beginHandoverBarrier(30_000);
    try {
      const finalManifest = await clusterSync.flushNow();
      const acceptBody = JSON.stringify({ hubId: devices.hubId, targetEpoch, finalGeneration: finalManifest.generation, primaryUrl });
      const acceptPath = "/_kulo/cluster/handover-accept";
      const accepted = await probeUrlsHappyEyeballs(
        targetUrls,
        async (origin, signal) => {
          const { header } = createClusterAuthHeader({ secret: targetRecord.syncToken!, nodeId: devices.localNodeId, method: "POST", pathWithQuery: acceptPath, body: acceptBody });
          const r = await fetch(`${origin}${acceptPath}`, { method: "POST", headers: { "content-type": "application/json", [CLUSTER_AUTH_HEADER]: header }, body: acceptBody, signal });
          if (!r.ok) throw new Error((await r.text().catch(() => "")) || `HTTP ${r.status}`);
          return origin;
        },
        { timeoutMs: 25_000, staggerMs: 150 },
      );
      if (!accepted) throw new DeviceConnectionError("目标备用主机未能完成切回前同步，原主机已恢复服务。", 502, "handover_accept_failed");
      const newPrimaryUrl = accepted.url;
      const selfRec = devices.getSelfDeviceRecord();
      if (!selfRec?.syncToken) throw new DeviceConnectionError("本机缺少集群同步凭证，无法切回。", 500, "handover_self_credentials_missing");
      const deadline = Date.now() + 15_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        try {
          const statusPath = "/_kulo/cluster/status";
          const { header } = createClusterAuthHeader({ secret: selfRec.clientToken, nodeId: devices.localNodeId, method: "GET", pathWithQuery: statusPath });
          const check = await fetch(`${newPrimaryUrl}${statusPath}`, { method: "GET", headers: { [CLUSTER_AUTH_HEADER]: header }, signal: AbortSignal.timeout(2_500) });
          if (check.ok) {
            const st = (await check.json()) as Partial<ClusterNodeStatus>;
            if (st.hubId === devices.hubId && st.role === "primary" && st.active && (st.epoch ?? 0) >= targetEpoch) { confirmed = true; break; }
          }
        } catch { /* retry until new primary listener comes up */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!confirmed) throw new DeviceConnectionError("目标主机启动确认超时，原主机已恢复服务。", 504, "handover_activation_timeout");
      hub.envManager.broadcastClusterHandover({
        hubId: devices.hubId, epoch: targetEpoch, newPrimaryNodeId: targetNodeId,
        newPrimaryUrls: [newPrimaryUrl, ...targetUrls.filter((u) => u !== newPrimaryUrl)],
      });
      const nextHubs = topology.hubs.map((h) => ({
        ...h, role: (h.nodeId === targetNodeId ? "primary" : "standby") as "primary" | "standby",
        priority: h.nodeId === targetNodeId ? 0 : Math.max(1, h.priority),
      }));
      const nextTopology = { ...topology, epoch: targetEpoch, primaryNodeId: targetNodeId, updatedAt: Date.now(), hubs: nextHubs };
      const peerConfig: DevicePeerConfig = {
        version: 1, deviceId: devices.localNodeId, name: selfRec.name, hubUrl: newPrimaryUrl,
        envToken: selfRec.envToken, clientToken: selfRec.clientToken,
        rootDir: selfRec.rootDir || deps.peerRootDir || hub.config.localEnvRoot || hub.config.stateDir,
        cluster: nextTopology,
        ...(selfRec.standbyPublicKey ? {
          standby: {
            enabled: true, syncToken: selfRec.syncToken, publicKey: selfRec.standbyPublicKey,
            ...(selfRec.identityPublicKey ? { identityPublicKey: selfRec.identityPublicKey } : {}),
          },
        } : {}),
      };
      saveClusterMembership(clusterPaths.clusterMembershipPath, {
        version: 1, hubId: devices.hubId, nodeId: devices.localNodeId, myRole: "standby", epoch: targetEpoch,
        primaryNodeId: targetNodeId, preferredPrimaryNodeId: devices.preferredPrimaryNodeId,
        selfTokens: { envToken: selfRec.envToken, clientToken: selfRec.clientToken, syncToken: selfRec.syncToken },
        hubs: nextHubs, updatedAt: Date.now(),
      });
      await clusterSync.close();
      const change = roleTransitions.demoteToPeer(peerConfig);
      let demoteScheduled = false;
      const startDemote = () => {
        if (demoteScheduled) return;
        demoteScheduled = true;
        res.off("finish", startDemote);
        res.off("close", startDemote);
        setTimeout(() => { void change.start(); }, 25);
      };
      res.shouldKeepAlive = false;
      res.setHeader("Connection", "close");
      res.once("finish", startDemote);
      res.once("close", startDemote);
      if (res.destroyed) startDemote();
      else sendJson(res, 202, { ok: true, targetNodeId, newPrimaryUrl, epoch: targetEpoch, receipt: change.receipt });
      return true;
    } catch (error) {
      hub.releaseHandoverBarrier();
      if (isClusterActive()) fenceMonitor.start();
      throw error;
    }
  }
  if (/^\/api\/devices\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.slice("/api/devices/".length));
    if (req.method === "PATCH") {
      assertOwnerHubControl("请通过受信任的 Kulo 客户端重命名设备。");
      const body = await readJsonBody(req) as { name?: unknown };
      devices.rename(id, body?.name);
      sendJson(res, 200, deviceView(req, parsedUrl));
      return true;
    }
    if (req.method === "DELETE") {
      assertOwnerHubControl("请通过受信任的 Kulo 客户端移除设备。");
      await performRemoveDevice(id, parsedUrl.searchParams.get("force") === "true");
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  return false;
}
