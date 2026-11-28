import fs from "node:fs";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import http from "node:http";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CLUSTER_AUTH_HEADER,
  ClusterNonceGuard,
  DeviceRoleTransitions,
  localListenerOrigin,
  parseClusterAuthHeader,
  renderPeerInstaller,
  saveClusterMembership,
  type ClusterNodeKeyMaterial,
  type LocalInstanceOwner,
} from "@kulo/env";
import {
  KULO_VERSION,
  type ClusterClientSummary,
  type ClusterNodeStatus,
  type DeviceChatInvitation,
  type DevicePeerConfig,
  type ClientToHubMessage,
  type HubToClientMessage,
  type NativeAppPermissionKind,
} from "@kulo/protocol";
import type { ConnectionVaultKeyStore } from "./connection-vault.js";
import { ClusterSyncHttpError, ClusterSyncService, ensureLocalClusterKeys } from "./cluster-sync.js";
import {
  ClusterFenceMonitor,
  archiveDivergedHubForConflict,
  resolveClusterPaths,
  type ClusterPaths,
} from "./cluster-lifecycle.js";
import { openNativePermissionSettings } from "./connection-native-apps.js";
import { IdentityFilesError } from "./identity-files.js";
import { PersonalityError } from "./personality.js";
import { UsageCapsError } from "./usage-caps.js";
import { MEMORY_LLM_BRIDGE_PATH, MemoryLlmBridgeError } from "./memory-llm-bridge.js";
import { MemoryServiceError } from "./memory-service.js";
import { ExtensionError } from "./extensions.js";
import { ExtensionPackageError } from "./extension-packages.js";
import { VoiceError } from "./voice-service.js";
import { VoiceCallsError } from "./voice-calls.js";
import { SearchError } from "./search.js";
import { ConversationQueryError } from "./conversation-query.js";
import { SkillError } from "./skills.js";
import { CapabilityError } from "./capabilities.js";
import { AgentConfigurationError } from "./agent-configuration.js";
import type { KuloHub } from "./hub.js";
import { topicActivity } from "./topic-activity.js";
import { SettingsUpdateError } from "./settings.js";
import { createMediaHttpHandler } from "./media-http.js";
import { snapshotChatUploadScope } from "./chat-attachment-deliveries.js";
import type { HubHttpRouteContext } from "./http/context.js";
import { authenticateHttpPrincipal, isDirectLocalHttpRequest, resolveHubRequestAuthority } from "./http/authority.js";
import { handleCapabilitiesRoutes } from "./http/capabilities-routes.js";
import { handleDevicesAndClusterRoutes } from "./http/devices-cluster-routes.js";
import { handleProjectsRoutes } from "./http/projects-routes.js";
import { handleSettingsProvidersRoutes } from "./http/settings-providers-routes.js";
import { handleSystemPermissionsRoutes, handleUiCardRoutes } from "./http/system-ui-routes.js";
import { handleVoiceAssistantConnectionsRoutes } from "./http/voice-assistant-connections-routes.js";
import { handleWorkspaceRoutes } from "./http/workspace-routes.js";
import { UiCardError } from "./ui-cards.js";
import { DeviceConnectionError, DeviceInterconnectionManager } from "./devices.js";
import { isTicketUnfinished } from "./state.js";
import { createDeviceSshRuntime } from "./http/device-ssh-routes.js";
import { ProjectError } from "./projects.js";
import { TaskDeliverableError } from "./task-deliverables.js";
import { MobileConnector, type MobileConnectorOptions, type MobileConnectorStatus } from "./mobile-connector.js";
import { attachComputerPreviewSocket } from "./computer-preview-socket.js";

export interface KuloHubServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly localUrl: string;
  readonly envWsUrl: string;
  readonly clientWsUrl: string;
  /** Actively check cluster fence and peers (for example after OS wake from sleep). */
  probeConnection(): void;
  close(): Promise<void>;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function resolveDefaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../web/dist");
}

async function conversationQueryContext<T>(req: http.IncomingMessage, res: http.ServerResponse, run: (context: Context) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort); res.once("close", abort);
  try { return await run(withAbortSignal(controller.signal, BACKGROUND_CONTEXT)); }
  finally { req.off("aborted", abort); res.off("close", abort); }
}

async function readRawBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw Object.assign(new Error("Request payload exceeds size limit"), { status: 413 });
    }
    chunks.push(buf);
  }
  return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const buf = await readRawBody(req, maxBytes);
  if (buf.byteLength === 0) return {};
  return JSON.parse(buf.toString("utf8"));
}

async function readJsonObject(req: http.IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await readJsonBody(req, maxBytes); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ProjectError(400, "invalid_request", "请求 JSON 格式无效。");
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectError(400, "invalid_request", "请求参数必须是对象。");
  }
  return value as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) { if (!res.writableEnded && !res.destroyed) res.end(); return; }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function webUiContentSecurityPolicy(html: string): string {
  const inlineHashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]!) && match[2]!.trim())
    .map((match) => `'sha256-${createHash("sha256").update(match[2]!).digest("base64")}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${inlineHashes.length ? ` ${inlineHashes.join(" ")}` : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' about:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

function streamStaticFile(filePath: string, res: http.ServerResponse, headers: http.OutgoingHttpHeaders): void {
  const stream = fs.createReadStream(filePath);
  res.on("close", () => stream.destroy());
  stream.once("open", () => {
    if (!res.headersSent) res.writeHead(200, headers);
    stream.pipe(res);
  });
  stream.once("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end("Internal Server Error");
    } else {
      res.destroy();
    }
  });
}

export interface KuloHubServerOptions {
  runtimeOwner?: LocalInstanceOwner;
  host?: string;
  port?: number;
  webDistDir?: string;
  mobileConnector?: MobileConnectorOptions;
  peerConfigPath?: string;
  peerRootDir?: string;
  onJoinPeer?: (config: DevicePeerConfig) => Promise<void> | void;
  roleTransitions?: DeviceRoleTransitions;
  openNativePermissionSettings?: (kind: NativeAppPermissionKind) => Promise<void>;
  clusterPaths?: ClusterPaths;
  clusterKeyStore?: ConnectionVaultKeyStore;
  clusterSyncDebounceMs?: number;
  clusterSyncMaxDelayMs?: number;
  clusterFenceIntervalMs?: number;
}

export async function startKuloHubServer(
  hub: KuloHub,
  options: KuloHubServerOptions = {},
): Promise<KuloHubServer> {
  const roleTransitions = options.roleTransitions ?? new DeviceRoleTransitions({
    startPeer: options.onJoinPeer, configPath: options.peerConfigPath, rootDir: options.peerRootDir,
  });
  let host = options.host ?? hub.config.host;
  const requestedPort = options.port ?? hub.config.port;
  const authToken = hub.config.authToken;
  if (!authToken || /[^\x21-\x7e]/.test(authToken) || authToken.length > 8192) {
    throw new Error("启动 Hub 前必须配置有效的管理密钥 KULO_AUTH_TOKEN。");
  }
  if (Object.values(hub.config.envTokens ?? {}).some((token) => token === authToken)) {
    throw new Error("Env 节点密钥不能与 Hub 管理密钥相同。");
  }
  const webDistDir = options.webDistDir ?? resolveDefaultWebDistDir();
  const devices = new DeviceInterconnectionManager(hub.config.stateDir, hub.envManager, Object.keys(hub.config.envTokens).length > 0);
  const clusterPaths = options.clusterPaths ?? resolveClusterPaths(path.dirname(hub.config.stateDir), {
    hubStateDir: hub.config.stateDir,
    peerConfigPath: options.peerConfigPath,
  });
  if (devices.legacyLocalNodeId) {
    hub.uploads.setLegacyLocalPrincipal(devices.legacyLocalNodeId);
  }
  hub.setClusterHostContext({
    localNodeId: devices.localNodeId,
    legacyLocalNodeId: devices.legacyLocalNodeId,
  });
  hub.setAndroidHubIdentity(devices.hubId);
  if (devices.enabled && options.host === undefined) host = "0.0.0.0";
  let actualPort = requestedPort;
  let closing = false;
  let listenerTransition: Promise<void> = Promise.resolve();
  let clusterKeys: ClusterNodeKeyMaterial | null = null;
  const clusterNonceGuard = new ClusterNonceGuard();

  const ensurePrimaryClusterKeys = async (): Promise<ClusterNodeKeyMaterial> => {
    if (!clusterKeys) {
      clusterKeys = await ensureLocalClusterKeys({
        dataDir: clusterPaths.dataDir,
        hubStateDir: clusterPaths.hubStateDir,
        standbyDir: clusterPaths.standbyDir,
        keyStore: options.clusterKeyStore,
      });
    }
    return clusterKeys;
  };

  const isClusterActive = (): boolean => devices.hasRemoteStandbys() || devices.localNodeId !== "local";

  const persistPrimaryClusterMembership = (origin = `http://127.0.0.1:${actualPort}`): void => {
    if (!isClusterActive() || devices.localNodeId === "local") return;
    const topology = devices.buildClusterTopology(actualPort, origin);
    const selfRec = devices.getSelfDeviceRecord();
    try {
      saveClusterMembership(clusterPaths.clusterMembershipPath, {
        version: 1,
        hubId: devices.hubId,
        nodeId: devices.localNodeId,
        myRole: "primary",
        epoch: devices.clusterEpoch,
        primaryNodeId: devices.primaryNodeId,
        preferredPrimaryNodeId: devices.preferredPrimaryNodeId,
        ...(selfRec?.syncToken
          ? { selfTokens: { envToken: selfRec.envToken, clientToken: selfRec.clientToken, syncToken: selfRec.syncToken } }
          : {}),
        hubs: topology.hubs,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error("[Cluster] persist cluster-membership failed:", error instanceof Error ? error.message : String(error));
    }
  };

  const clusterSync = new ClusterSyncService({
    stateDir: hub.config.stateDir,
    getHubId: () => devices.hubId,
    getPrimaryNodeId: () => devices.primaryNodeId,
    getClusterEpoch: () => devices.clusterEpoch,
    hasRemoteStandbys: () => devices.hasRemoteStandbys(),
    getEffectiveIdentityDir: () => hub.getEffectiveIdentityDir(),
    backupSqliteDb: (name, destPath) => hub.backupSyncSqlite(name, destPath), getBuiltinMemoryMeta: () => hub.memoryRuntime.builtinMemory.getClusterMeta(),
    readVaultEntries: async () => (await hub.connectionManager.localVault?.entries()) ?? [],
    getSenderKeys: () => {
      if (!clusterKeys) throw new ClusterSyncHttpError(503, "cluster_keys_unavailable", "主机同步密钥尚未就绪。");
      return clusterKeys;
    },
    resolveStandbyPublicKey: (nodeId) => devices.getStandbyRecord(nodeId)?.standbyPublicKey,
    notifySyncAvailable: (generation, vaultRevision) => {
      for (const standby of devices.listRemoteStandbys()) {
        hub.envManager.notifySyncAvailable(standby.id, {
          epoch: devices.clusterEpoch,
          generation,
          dbRevision: generation,
          ledgerRevision: generation,
          vaultRevision,
          filesRevision: generation,
          uploadsRevision: generation,
        });
      }
    },
    ...(options.clusterSyncDebounceMs !== undefined ? { debounceMs: options.clusterSyncDebounceMs } : {}),
    ...(options.clusterSyncMaxDelayMs !== undefined ? { maxDelayMs: options.clusterSyncMaxDelayMs } : {}),
  });

  hub.setOnClusterDirty((kind, opts) => clusterSync.markDirty(kind, opts), () => devices.hasRemoteStandbys());
  devices.setOnWrite(() => clusterSync.markDirty("files"));
  hub.setClusterCloseHook(async () => {
    await clusterSync.close();
  });

  hub.envManager.setClusterHandlers({
    getRegistrationPayload: (envId) => {
      if (!isClusterActive()) return undefined;
      const topology = devices.buildClusterTopology(actualPort, `http://127.0.0.1:${actualPort}`);
      const standbyRec = devices.getStandbyRecord(envId);
      return {
        cluster: topology,
        ...(standbyRec?.syncToken ? { standby: { enabled: true, syncToken: standbyRec.syncToken } } : {}),
      };
    },
    onSyncStatus: (envId, status) => {
      devices.updateStandbySyncStatus(envId, status); if (devices.hasRemoteStandbys() && devices.listRemoteStandbys().every((s) => { const st = devices.getStandbySyncStatus(s.id); return st?.state === "synced" && st.syncedGeneration !== undefined && clusterSync.getClearEpochForGeneration(st.syncedGeneration) >= hub.memoryRuntime.builtinMemory.getClusterMeta().clearTargetEpoch; })) hub.memoryRuntime.builtinMemory.setReplicaClearConfirmed(true);
    },
    onPeerRegistered: (envId) => {
      if (!isClusterActive()) return;
      const topology = devices.buildClusterTopology(actualPort, `http://127.0.0.1:${actualPort}`);
      persistPrimaryClusterMembership();
      hub.envManager.broadcastClusterTopology(topology);
      if (devices.getStandbyRecord(envId)) {
        void ensurePrimaryClusterKeys()
          .then(() => clusterSync.triggerBaseline())
          .catch((error) => console.error("[ClusterSync] standby connect baseline failed:", error instanceof Error ? error.message : String(error)));
      }
    },
  });

  const buildClusterClientSummary = (): ClusterClientSummary | undefined => {
    if (!isClusterActive()) return undefined;
    return {
      hubId: devices.hubId,
      epoch: devices.clusterEpoch,
      primaryNodeId: devices.primaryNodeId,
      preferredPrimaryNodeId: devices.preferredPrimaryNodeId,
      isPreferredPrimary: devices.primaryNodeId === devices.preferredPrimaryNodeId,
      standbyCount: devices.listRemoteStandbys().length,
    };
  };

  const fenceMonitor = new ClusterFenceMonitor({
    getHubId: () => devices.hubId,
    getLocalNodeId: () => devices.localNodeId,
    getLocalEpoch: () => devices.clusterEpoch,
    getLocalPrimaryNodeId: () => devices.primaryNodeId,
    getPreferredPrimaryNodeId: () => devices.preferredPrimaryNodeId,
    getSelfClientToken: () => devices.getSelfDeviceRecord()?.clientToken,
    getRemoteClusterHubs: () => isClusterActive() ? devices.buildClusterTopology(actualPort, `http://127.0.0.1:${actualPort}`).hubs : [],
    onHigherAuthorityDetected: async ({ activePrimaryUrl, status }) => {
      if (closing || !roleTransitions.canJoin) return;
      const selfRec = devices.getSelfDeviceRecord();
      if (!selfRec?.syncToken) return;
      archiveDivergedHubForConflict(clusterPaths, {
        remoteEpoch: status.epoch,
        remotePrimaryNodeId: status.primaryNodeId,
        remotePrimaryName: status.name,
      });
      const topology = devices.buildClusterTopology(actualPort, `http://127.0.0.1:${actualPort}`);
      const nextHubs = topology.hubs.map((h) => ({
        ...h,
        role: (h.nodeId === status.primaryNodeId ? "primary" : "standby") as "primary" | "standby",
        priority: h.nodeId === status.primaryNodeId ? 0 : Math.max(1, h.priority),
      }));
      const nextTopology = {
        ...topology,
        epoch: status.epoch,
        primaryNodeId: status.primaryNodeId,
        preferredPrimaryNodeId: status.preferredPrimaryNodeId,
        updatedAt: Date.now(),
        hubs: nextHubs,
      };
      const peerConfig: DevicePeerConfig = {
        version: 1,
        deviceId: devices.localNodeId,
        name: selfRec.name,
        hubUrl: activePrimaryUrl,
        envToken: selfRec.envToken,
        clientToken: selfRec.clientToken,
        rootDir: selfRec.rootDir || options.peerRootDir || hub.config.localEnvRoot || hub.config.stateDir,
        cluster: nextTopology,
        ...(selfRec.standbyPublicKey ? {
          standby: {
            enabled: true,
            syncToken: selfRec.syncToken,
            publicKey: selfRec.standbyPublicKey,
            ...(selfRec.identityPublicKey ? { identityPublicKey: selfRec.identityPublicKey } : {}),
          },
        } : {}),
      };
      saveClusterMembership(clusterPaths.clusterMembershipPath, {
        version: 1,
        hubId: devices.hubId,
        nodeId: devices.localNodeId,
        myRole: "standby",
        epoch: status.epoch,
        primaryNodeId: status.primaryNodeId,
        preferredPrimaryNodeId: status.preferredPrimaryNodeId,
        selfTokens: { envToken: selfRec.envToken, clientToken: selfRec.clientToken, syncToken: selfRec.syncToken },
        hubs: nextHubs,
        updatedAt: Date.now(),
      });
      fenceMonitor.stop();
      await clusterSync.close();
      const change = roleTransitions.demoteToPeer(peerConfig);
      void change.start();
    },
    ...(options.clusterFenceIntervalMs !== undefined ? { intervalMs: options.clusterFenceIntervalMs } : {}),
  });
  const deviceClients = new Map<WebSocket, string>();
  const sshDeviceRuntime = createDeviceSshRuntime({
    connections: hub.connectionManager,
    devices,
    hubPort: () => actualPort,
    ensureEnabled: async () => { await applyInterconnectionEnabled(true, false, false); },
  });
  const sshDevices = sshDeviceRuntime.connector;
  hub.envManager.protectPaths([webDistDir]);

  const clientTopics = new Map<WebSocket, string>();
  const incrementalTicketClients = new WeakSet<WebSocket>();
  const settingsClients = new Map<WebSocket, string>();
  const clientWss = new WebSocketServer({ noServer: true });
  const envWss = new WebSocketServer({ noServer: true });
  const mobileProbeWss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const voiceClients = new Map<WebSocket, { id: string; principal: string }>();
  const previewWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const previewClients = new Map<WebSocket, { principal: string; dispose: () => void }>();
  let mobileHttpServer: http.Server | undefined;
  let mobileHttpStarting: Promise<string> | undefined;
  let mobileConnectorRestoreTimer: ReturnType<typeof setTimeout> | undefined;
  let mobileConnectorRestoreAttempt = 0;
  const nonRetryableMobileConnectorCodes = new Set([
    "connector_closed",
    "connector_not_built",
    "connector_listener_state_invalid",
    "connector_listener_changed",
  ]);
  const cancelMobileConnectorRestore = () => {
    if (mobileConnectorRestoreTimer) {
      clearTimeout(mobileConnectorRestoreTimer);
      mobileConnectorRestoreTimer = undefined;
    }
    mobileConnectorRestoreAttempt = 0;
  };
  const scheduleMobileConnectorRestore = (delayMs?: number) => {
    if (closing || !devices.enabled || !devices.hasMobileClients() || mobileConnectorRestoreTimer) return;
    const waitMs = delayMs ?? Math.min(30_000, 2_000 * 2 ** Math.min(mobileConnectorRestoreAttempt, 4));
    mobileConnectorRestoreAttempt++;
    mobileConnectorRestoreTimer = setTimeout(() => {
      mobileConnectorRestoreTimer = undefined;
      restoreMobileConnector();
    }, waitMs);
    mobileConnectorRestoreTimer.unref?.();
  };
  const mobileConnector = new MobileConnector({ stateDir: hub.config.stateDir, hubId: devices.hubId,
    upstream: () => {
      if (closing) return Promise.reject(new DeviceConnectionError("Hub 正在关闭。", 503));
      if (mobileHttpStarting) return mobileHttpStarting;
      mobileHttpStarting = new Promise<string>((resolve, reject) => {
        mobileHttpServer = http.createServer(handleHttp);
        mobileHttpServer.on("upgrade", handleUpgrade);
        mobileHttpServer.once("error", (error) => { mobileHttpStarting = undefined; reject(error); });
        mobileHttpServer.listen(0, "127.0.0.1", () => {
          const address = mobileHttpServer!.address();
          if (!address || typeof address === "string") return reject(new Error("Mobile upstream unavailable"));
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
      return mobileHttpStarting;
    }, options: options.mobileConnector, onUnexpectedExit: () => scheduleMobileConnectorRestore(1_000) });
  const restoreMobileConnector = () => {
    if (closing || !devices.enabled || !devices.hasMobileClients()) return;
    if (mobileConnectorRestoreTimer) {
      clearTimeout(mobileConnectorRestoreTimer);
      mobileConnectorRestoreTimer = undefined;
    }
    void mobileConnector.ensure().then(() => {
      mobileConnectorRestoreAttempt = 0;
    }, (error: unknown) => {
      if (closing || !devices.enabled || !devices.hasMobileClients()) return;
      const code = error instanceof DeviceConnectionError ? error.code : undefined;
      console.error("恢复手机安全连接失败:", error instanceof Error ? error.message : String(error));
      if (!code || !nonRetryableMobileConnectorCodes.has(code)) {
        scheduleMobileConnectorRestore();
      }
    });
  };
  const isMobileConnector = (req: http.IncomingMessage): boolean => {
    const address = req.socket.remoteAddress;
    const supplied = req.headers["x-kulo-connector"] ?? req.headers["x-moco-connector"];
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") || typeof supplied !== "string") return false;
    const actual = Buffer.from(supplied), expected = Buffer.from(mobileConnector.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const requireMobileConnector = (req: http.IncomingMessage) => {
    if (!isMobileConnector(req)) throw new DeviceConnectionError("请通过手机安全连接入口访问。", 403, "mobile_tls_required");
    if (!devices.enabled) throw new DeviceConnectionError("设备互联已关闭。", 403, "device_interconnection_disabled");
  };
  const mobileMetadata = (status: MobileConnectorStatus) => ({
    version: 1 as const, hubId: devices.hubId,
    hubName: devices.view(actualPort, `http://127.0.0.1:${actualPort}`).hubName,
    spkiSHA256: status.spkiSHA256, candidates: status.candidates,
  });
  mobileProbeWss.on("connection", (ws) => {
    const timeout = setTimeout(() => ws.close(1000, "Probe timeout"), 10_000);
    ws.once("message", (data, binary) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (binary || bytes.byteLength > 1024) { ws.close(1003, "Invalid probe"); return; }
      ws.send(bytes.toString());
    });
    ws.once("close", () => clearTimeout(timeout));
  });

  const requestOrigin = (req: http.IncomingMessage): string => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host ?? `localhost:${actualPort}`}`;
  const requestAuthority = (req: http.IncomingMessage, url: URL) =>
    resolveHubRequestAuthority({ req, parsedUrl: url, hubAdminToken: authToken, devices, requestOrigin, isMobileConnector: isMobileConnector(req) });
  const authenticatedDevice = (req: http.IncomingMessage, parsedUrl: URL): string | undefined =>
    authenticateHttpPrincipal(req, parsedUrl, authToken, devices).principalId;
  const isAuthorizedHttp = (req: http.IncomingMessage, parsedUrl: URL): boolean => authenticatedDevice(req, parsedUrl) !== undefined;

  const mediaHttp = createMediaHttpHandler({
    uploads: hub.uploads, thumbnailsDir: path.join(hub.config.stateDir, "cache", "thumbnails"),
    authenticate: authenticatedDevice,
    isPrincipalActive: (principal) => devices.isLocalPrincipal(principal) || devices.isActivePairedPrincipal(principal),
    resolveScopeChecker: () => snapshotChatUploadScope(hub.harness, BACKGROUND_CONTEXT),
  });

  const currentDevice = (req: http.IncomingMessage, url: URL): string => authenticatedDevice(req, url) ?? devices.localNodeId;
  const isDirectLocalRequest = isDirectLocalHttpRequest;
  const hasLocalDeviceControl = (req: http.IncomingMessage, url: URL) => requestAuthority(req, url).isHubLocalDisplay;
  const hasOwnerHubControl = (req: http.IncomingMessage, url: URL) => requestAuthority(req, url).hasOwnerHubControl;
  const deviceView = (req: http.IncomingMessage, url: URL) => {
    const auth = requestAuthority(req, url);
    const id = auth.principalId ?? devices.localNodeId;
    const currentDeviceKnown = !devices.isLocalPrincipal(id) || isDirectLocalRequest(req);
    const canSwitchRole = roleTransitions.canJoin && devices.isLocalPrincipal(id) && currentDeviceKnown;
    return {
      ...devices.view(actualPort, requestOrigin(req), id),
      currentDeviceKnown,
      canSwitchRole,
      canManageHub: auth.hasOwnerHubControl,
      canManageStandby: auth.canManageStandby,
    };
  };
  const guardRemoteTasks = async (ids: string[] | undefined, force: boolean) => {
    const board = await hub.getBoardSnapshot();
    const running = board.tickets.filter((t) => !devices.isLocalPrincipal(t.envId) && (!ids || ids.includes(t.envId)) && ["running", "queued", "blocked", "pausing", "waiting"].includes(t.status));
    if (running.length && !force) throw new DeviceConnectionError("这些设备上仍有任务，继续操作将中断任务。", 409, "remote_tasks_running");
    for (const task of running) await hub.stopTicket(task.id, "设备互联已关闭或设备已移除");
  };
  const scheduleListenerTransition = (desiredHost: string) => {
    if (desiredHost === host) return;
    listenerTransition = listenerTransition.then(async () => {
      if (closing || desiredHost === host) return;
      for (const client of clientWss.clients) client.terminate();
      for (const client of envWss.clients) client.terminate();
      for (const [ws, client] of previewClients) { client.dispose(); ws.terminate(); }
      previewClients.clear();
      for (const client of voiceWss.clients) client.terminate();
      for (const client of mobileProbeWss.clients) client.terminate();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      const previousHost = host;
      try {
        await listenOn(desiredHost, actualPort);
        host = desiredHost;
      } catch (error) {
        devices.setEnabled(false);
        cancelMobileConnectorRestore();
        await mobileConnector.stop();
        await listenOn(previousHost, actualPort);
        console.error("设备互联监听地址切换失败:", error instanceof Error ? error.message : String(error));
      }
    });
  };
  const applyInterconnectionEnabled = async (enabled: boolean, force: boolean, deferListener = false): Promise<{ changedListener: boolean }> => {
    if (enabled === devices.enabled) return { changedListener: false };
    if (!enabled) await guardRemoteTasks(undefined, force);
    devices.setEnabled(enabled);
    if (!enabled) {
      cancelMobileConnectorRestore();
      mediaHttp.revoke();
      sshDevices.cancelPending();
      await Promise.all([...voiceClients.values()].filter((call) => !devices.isLocalPrincipal(call.principal)).map((call) => hub.voiceCalls.end(call.id, call.principal)));
      for (const [client, deviceId] of deviceClients) if (!devices.isLocalPrincipal(deviceId)) client.close(4003, "Device interconnection disabled");
      for (const client of mobileProbeWss.clients) client.close(4003, "Device interconnection disabled");
      await mobileConnector.stop();
    } else {
      void sshDevices.restore(devices.sshRecords).catch((error: unknown) => {
        console.error("恢复 SSH 设备失败:", error instanceof Error ? error.message : String(error));
      });
      restoreMobileConnector();
    }
    const desiredHost = options.host ?? (enabled ? "0.0.0.0" : hub.config.host);
    const changedListener = desiredHost !== host;
    if (changedListener && !deferListener) {
      setTimeout(() => scheduleListenerTransition(desiredHost), 20);
    }
    return { changedListener };
  };
  const setInterconnectionFromHttp = async (res: http.ServerResponse, enabled: boolean, force = false) => {
    const { changedListener } = await applyInterconnectionEnabled(enabled, force, true);
    if (!changedListener) return;
    const rebind = () => {
      res.off("finish", rebind);
      res.off("close", rebind);
      setTimeout(() => scheduleListenerTransition(options.host ?? (devices.enabled ? "0.0.0.0" : hub.config.host)), 10);
    };
    if (res.destroyed) { rebind(); return; }
    // Deliver the response before replacing the listener on this port.
    res.shouldKeepAlive = false;
    res.setHeader("Connection", "close");
    res.once("finish", rebind);
    res.once("close", rebind);
  };
  const performRemoveDevice = async (id: string, force: boolean): Promise<void> => {
    await guardRemoteTasks([id], force);
    const wasStandby = Boolean(devices.getStandbyRecord(id));
    if (wasStandby) {
      hub.envManager.sendStandbyWipe(id, "device_removed");
    }
    devices.remove(id);
    if (isClusterActive()) {
      const topology = devices.buildClusterTopology(actualPort, `http://127.0.0.1:${actualPort}`);
      persistPrimaryClusterMembership();
      hub.envManager.broadcastClusterTopology(topology);
    }
    mediaHttp.revoke(id);
    sshDevices.remove(id);
    await Promise.all([...voiceClients.values()].filter((call) => call.principal === id).map((call) => hub.voiceCalls.end(call.id, call.principal)));
    for (const [client, deviceId] of deviceClients) if (deviceId === id) client.close(4001, "Device removed");
    for (const client of mobileProbeWss.clients) client.close(4001, "Device removed");
  };
  const resolvePrincipalForClient = (clientId?: string): string => {
    if (!clientId) return devices.localNodeId;
    for (const [ws, registered] of settingsClients) {
      if (registered === clientId) return deviceClients.get(ws) ?? devices.localNodeId;
    }
    return devices.localNodeId;
  };
  const guardJoinTasks = async (stopConfirmedTasks: boolean) => {
    const board = await hub.getBoardSnapshot();
    const affected = board.tickets.filter(isTicketUnfinished);
    if (affected.length && !stopConfirmedTasks) {
      const titles = affected.slice(0, 3).map((ticket) => `「${hub.connectionManager.redact(ticket.title)}」`).join("、");
      const tasks = affected.length > 3 ? `${titles}等 ${affected.length} 个任务` : titles;
      throw new DeviceConnectionError(`接入后将停止${tasks}。`, 409, "local_tasks_running");
    }
    for (const ticket of affected) await hub.stopTicket(ticket.id, "本机已确认接入其他主机");
  };
  const prepareJoinPeer = async (input: DeviceChatInvitation, force: boolean, id?: string, rootDir?: string) => {
    if (!roleTransitions.canJoin) throw new DeviceConnectionError("当前运行模式不支持直接切换接入其他主机。", 409);
    const localView = devices.view(actualPort, `http://127.0.0.1:${actualPort}`);
    if (localView.hubUrls.includes(input.hubUrl) || input.hubUrl === `http://127.0.0.1:${actualPort}` || input.hubUrl === `http://localhost:${actualPort}`) {
      throw new DeviceConnectionError("这条邀请来自本机。请在要接入的另一台 Kulo 中发送。", 400, "device_self_join");
    }
    if (!force) await guardJoinTasks(false);
    return roleTransitions.join(input, () => guardJoinTasks(force), id, rootDir);
  };
  hub.bindDeviceController({
    view: (clientId) => {
      const principal = resolvePrincipalForClient(clientId);
      const isLocal = devices.isLocalPrincipal(principal);
      const hasControl = isLocal || devices.isActivePairedPrincipal(principal);
      return {
        ...devices.view(actualPort, `http://127.0.0.1:${actualPort}`, principal),
        currentDeviceKnown: true,
        canSwitchRole: roleTransitions.canJoin && isLocal,
        canManageHub: hasControl,
        canManageStandby: hasControl && !devices.isSshPrincipal(principal),
      };
    },
    setEnabled: async (enabled, force = false) => {
      await applyInterconnectionEnabled(enabled, force, false);
      return {
        ...devices.view(actualPort, `http://127.0.0.1:${actualPort}`, devices.localNodeId),
        currentDeviceKnown: true,
        canSwitchRole: roleTransitions.canJoin,
      };
    },
    rename: async (deviceId, name) => {
      devices.rename(deviceId, name);
      return {
        ...devices.view(actualPort, `http://127.0.0.1:${actualPort}`, devices.localNodeId),
        currentDeviceKnown: true,
        canSwitchRole: roleTransitions.canJoin,
      };
    },
    createInvitation: async ({ hubUrl, name }) => {
      if (!devices.enabled) await applyInterconnectionEnabled(true, false, false);
      const localView = devices.view(actualPort, `http://127.0.0.1:${actualPort}`, devices.localNodeId);
      const targetUrl = hubUrl?.trim() || localView.hubUrls[0];
      if (!targetUrl) throw new DeviceConnectionError("未找到其他设备可访问的本机网络地址。");
      const { invitation } = devices.createInvitation({ hubUrl: targetUrl, name });
      return { id: invitation.id, deviceId: invitation.deviceId, hubUrl: targetUrl, expiresAt: invitation.expiresAt };
    },
    inspectSshCredential: (connectionId) => sshDeviceRuntime.inspectSshCredential(connectionId),
    addSsh: (request) => sshDeviceRuntime.addSshFromController(request),
    removeDevice: async (deviceId, force = false) => {
      await performRemoveDevice(deviceId, force);
    },
    canSwitchRole: () => roleTransitions.canJoin,
    joinPeer: roleTransitions.canJoin ? prepareJoinPeer : undefined,
    roleStatus: (id) => roleTransitions.lookup(id),
    canResumeJoin: (id, hubUrl) => roleTransitions.canResumeJoin(id, hubUrl),
    resumeJoin: async (id, hubUrl, force) => {
      if (!force) await guardJoinTasks(false);
      return roleTransitions.resumeJoin(id, hubUrl, () => guardJoinTasks(force));
    },
  });

  const broadcastToAllClients = (msg: HubToClientMessage) => {
    const encoded = JSON.stringify(msg);
    for (const ws of clientTopics.keys()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(encoded);
      }
    }
  };

  const broadcastTopicView = (
    topicId: string,
    messages: HubToClientMessage & { type: "hub.messages" },
    live: HubToClientMessage & { type: "hub.live" },
  ) => {
    const msgEncoded = JSON.stringify(messages);
    const liveEncoded = JSON.stringify(live);
    for (const [ws, subscribedTopic] of clientTopics.entries()) {
      if (ws.readyState === ws.OPEN && subscribedTopic === topicId) {
        ws.send(msgEncoded);
        ws.send(liveEncoded);
      }
    }
  };

  const lastTopicActivities = new Map<string, string>();
  const inspectedTickets = new Map<WebSocket, string>();
  const assistantStreamClients = new Set<{ res: http.ServerResponse; heartbeat: NodeJS.Timeout }>();
  const broadcastAssistantSse = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...assistantStreamClients]) {
      if (client.res.writableEnded || client.res.destroyed) {
        clearInterval(client.heartbeat);
        assistantStreamClients.delete(client);
        continue;
      }
      try {
        client.res.write(frame);
      } catch {
        clearInterval(client.heartbeat);
        assistantStreamClients.delete(client);
      }
    }
  };

  const unsubscribeHub = hub.subscribe({
    onVoice: (snapshot) => broadcastToAllClients({ type: "hub.voice", snapshot }),
    onCapabilities: (snapshot) => broadcastToAllClients({ type: "hub.capabilities", snapshot: { ...snapshot, inputs: [] } }), onBuiltinMemory: (state) => broadcastToAllClients({ type: "hub.builtin_memory", state }),
    onUiCard: (card) => {
      const encoded = JSON.stringify({ type: "hub.ui_card", card });
      for (const [ws, topicId] of clientTopics) {
        if (ws.readyState === ws.OPEN && topicId === card.topicId) ws.send(encoded);
      }
      if (card.topicId?.startsWith("settings-")) {
        for (const ws of settingsClients.keys()) {
          if (ws.readyState === ws.OPEN) ws.send(encoded);
        }
      }
    },
    onTopicView: (topicId, messages, live, conversationId) => {
      const activity = topicActivity(messages, live);
      const signature = JSON.stringify(activity);
      if (lastTopicActivities.get(topicId) !== signature) {
        lastTopicActivities.set(topicId, signature);
        broadcastToAllClients({ type: "hub.topic_activity", topicId, activity });
      }
      const convField = conversationId === undefined ? {} : { conversationId };
      broadcastTopicView(topicId, { type: "hub.messages", topicId, ...convField, messages, historyBefore: hub.getTopicHistoryBefore(topicId) }, { type: "hub.live", topicId, ...convField, live });
    },
    onNotification: (event) => {
      broadcastToAllClients({ type: "hub.notification", event });
      if (event.kind === "assistant_alert" || event.urgency === "high" || event.urgency === "critical") broadcastAssistantSse("assistant_alert", { event });
    },
    onTopics: (topics) => {
      const existing = new Set(topics.map((topic) => topic.id));
      for (const topicId of lastTopicActivities.keys()) if (!existing.has(topicId)) lastTopicActivities.delete(topicId);
      broadcastToAllClients({ type: "hub.topics", topics });
      const proactive = topics.filter((topic) => topic.origin === "proactive" && !topic.deletedAt);
      if (proactive.length > 0) broadcastAssistantSse("proactive_topics", { topics: proactive });
    },
    onAssistantItems: (assistantRevision, items) => { broadcastToAllClients({ type: "hub.assistant_items", assistantRevision, items }); broadcastAssistantSse("assistant_items", { assistantRevision, items }); },
    onProjects: (projects) => broadcastToAllClients({ type: "hub.projects", projects }),
    onTicketDelta: (delta, snapshot) => {
      let incremental: string | undefined;
      let full: string | undefined;
      for (const ws of clientTopics.keys()) {
        if (ws.readyState !== ws.OPEN) continue;
        if (incrementalTicketClients.has(ws)) {
          ws.send(incremental ??= JSON.stringify({ type: "hub.ticket_delta", ...delta }));
        } else {
          if (full === undefined) {
            const { tickets, slots } = snapshot();
            full = JSON.stringify({ type: "hub.tickets", tickets, slots });
          }
          ws.send(full);
        }
      }
    },
    onTicketTelemetry: (telemetry) => {
      const encoded = JSON.stringify({
        type: "hub.ticket_telemetry",
        ticketId: telemetry.ticketId,
        runEpoch: telemetry.runEpoch,
        ...(telemetry.sessionId ? { sessionId: telemetry.sessionId } : {}),
        ...(telemetry.contextUsage ? { contextUsage: telemetry.contextUsage } : {}),
        ...(telemetry.activeSessionMode ? { activeSessionMode: telemetry.activeSessionMode } : {}),
      });
      for (const [ws, ticketId] of inspectedTickets.entries()) {
        if (ws.readyState === ws.OPEN && ticketId === telemetry.ticketId) ws.send(encoded);
      }
    },
    onEnvs: (envs) => {
      broadcastToAllClients({ type: "hub.envs", envs });
    },
    onExpression: (expression) => {
      broadcastToAllClients({ type: "hub.expression", expression });
    },
    onSettings: (settings) => {
      broadcastToAllClients({ type: "hub.settings", settings });
    },
    onSettingsAssistant: (snapshot) => {
      const encoded = JSON.stringify({ type: "hub.settings_assistant", snapshot });
      for (const ws of settingsClients.keys()) if (ws.readyState === ws.OPEN) ws.send(encoded);
    },
  });

  clientWss.on("connection", (ws, req) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const initialTopic = parsedUrl.searchParams.get("topic")?.trim() || "root";
    if (parsedUrl.searchParams.get("ticketDeltas") === "1") incrementalTicketClients.add(ws);
    const initialVersion = Number(parsedUrl.searchParams.get("selectionVersion"));
    let selection = { topicId: initialTopic, version: Number.isSafeInteger(initialVersion) && initialVersion >= 0 ? initialVersion : 0 };
    let initialized = false;
    const principal = currentDevice(req, parsedUrl);
    const sourceDeviceKnown = !devices.isLocalPrincipal(principal) || isDirectLocalRequest(req);
    deviceClients.set(ws, principal);

    const send = (msg: HubToClientMessage) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const formatHubErrorMessage = (err: unknown) => {
      if (err instanceof Error && err.name === "SessionFailed") {
        return "本地会话存储连接异常，请重启 Kulo 后重试。";
      }
      return hub.connectionManager.redact(err instanceof Error ? err.message : String(err));
    };

    const isCurrent = (requested: typeof selection) => requested === selection && ws.readyState === ws.OPEN && !closing;
    const publishSnapshot = async (requested: typeof selection, topicId: string) => {
      const snapshot = await hub.getFullClientSnapshot(topicId);
      if (!isCurrent(requested)) return;
      let published: string | undefined;
      await hub.publishCurrentTopicView(snapshot.activeTopicId, (view) => {
        if (!isCurrent(requested)) return;
        const board = hub.getCurrentTicketBoard();
        if (requested.topicId !== view.topicId) selection = { ...requested, topicId: view.topicId };
        clientTopics.set(ws, view.topicId);
        const clusterSummary = buildClusterClientSummary();
        send({
          type: "hub.snapshot", ...snapshot, ...board, activeConversationId: view.conversationId, messages: view.messages, live: view.live, historyBefore: view.historyBefore,
          topicActivities: { ...snapshot.topicActivities, [view.topicId]: topicActivity(view.messages, view.live) },
          selectionVersion: requested.version, supportsPing: true,
          deliveryIdentity: { hubId: devices.hubId, principalId: deviceClients.get(ws)! },
          ...(clusterSummary ? { cluster: clusterSummary } : {}),
        });
        published = view.topicId;
      });
      return published;
    };

    const readAndSendSnapshot = async (): Promise<string | undefined> => {
      while (ws.readyState === ws.OPEN && !closing) {
        const requested = selection;
        try {
          const published = await publishSnapshot(requested, requested.topicId);
          if (published) return published;
        }
        catch (error) {
          if (!isCurrent(requested)) continue;
          if (requested.topicId === "root" || !(error instanceof ProjectError) ||
            !["topic_not_found", "topic_deleted", "project_not_found", "project_binding_pending"].includes(error.code)) throw error;
          const published = await publishSnapshot(requested, "root");
          if (published) return published;
        }
      }
    };
    let snapshotInFlight: Promise<string | undefined> | undefined;
    const sendSnapshot = () => snapshotInFlight ??= readAndSendSnapshot().finally(() => { snapshotInFlight = undefined; });

    ws.on("message", async (raw) => {
      // Older clients can subscribe on transport open, before their first snapshot is ready.
      if (!initialized) await firstSnapshot;
      if (ws.readyState !== ws.OPEN || closing) return;
      let msg: ClientToHubMessage;
      try {
        msg = JSON.parse(raw.toString("utf8")) as ClientToHubMessage;
      } catch {
        send({
          type: "hub.error",
          code: "malformed_json",
          message: "Malformed JSON message",
        });
        return;
      }

      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        send({
          type: "hub.error",
          code: "invalid_message",
          message: "Invalid WebSocket message envelope",
        });
        return;
      }

      const action = msg.type;
      const reqId =
        "requestId" in msg && typeof msg.requestId === "string" && msg.requestId.trim()
          ? msg.requestId.trim()
          : undefined;
      const cmdId =
        "commandId" in msg && typeof msg.commandId === "string" && msg.commandId.trim()
          ? msg.commandId.trim()
          : undefined;
      let ctxTopicId =
        "topicId" in msg && typeof msg.topicId === "string" && msg.topicId.trim()
          ? msg.topicId.trim()
          : undefined;
      const ctxTicketId =
        "ticketId" in msg && typeof msg.ticketId === "string" && msg.ticketId.trim()
          ? msg.ticketId.trim()
          : undefined;

      const sendAck = (extra?: { topicId?: string; conversationId?: number; ticketId?: string; deduplicated?: boolean; submissionId?: number; delivery?: "queued" | "accepted" }) => {
        if (!reqId && !cmdId) return;
        send({
          type: "hub.ack",
          action,
          ...(reqId ? { requestId: reqId } : {}),
          ...(cmdId ? { commandId: cmdId } : {}),
          ...(extra?.topicId ?? ctxTopicId ? { topicId: extra?.topicId ?? ctxTopicId } : {}),
          ...(extra?.conversationId === undefined ? {} : { conversationId: extra.conversationId }),
          ...(extra?.ticketId ?? ctxTicketId ? { ticketId: extra?.ticketId ?? ctxTicketId } : {}),
          ...(extra?.deduplicated ? { deduplicated: true } : {}),
          ...(extra?.submissionId === undefined ? {} : { submissionId: extra.submissionId }),
          ...(extra?.delivery ? { delivery: extra.delivery } : {}),
        });
      };

      try {
        if (!clientTopics.has(ws) && msg.type !== "state.sync" && msg.type !== "client.ping") {
          throw new ProjectError(503, "client_snapshot_unavailable", "中枢会话尚未就绪，请稍后重试。");
        }
        if (
          hub.isHandoverBarrierActive &&
          msg.type !== "state.sync" &&
          msg.type !== "client.ping" &&
          msg.type !== "topic.select" &&
          msg.type !== "ticket.inspect" &&
          msg.type !== "settings.assistant.subscribe" &&
          msg.type !== "settings.assistant.context" &&
          msg.type !== "chat.abort"
        ) {
          throw new ProjectError(503, "cluster_handover_in_progress", "主机正在切换，请稍候。");
        }
        switch (msg.type) {
          case "settings.assistant.subscribe":
          case "settings.assistant.context": {
            const existingClient = settingsClients.get(ws);
            if (existingClient && existingClient !== msg.context.clientId) throw new Error("设置助手客户端标识不可更改。");
            hub.settingsAssistant.updateContext(msg.context);
            settingsClients.set(ws, msg.context.clientId);
            if (msg.type === "settings.assistant.subscribe") send({ type: "hub.settings_assistant", snapshot: await hub.settingsAssistant.getSnapshot(), ...(reqId ? { requestId: reqId } : {}) });
            sendAck();
            break;
          }
          case "settings.assistant.send": {
            const existingClient = settingsClients.get(ws);
            if (existingClient && existingClient !== msg.context.clientId) throw new Error("设置助手客户端标识不可更改。");
            settingsClients.set(ws, msg.context.clientId);
            await hub.settingsAssistant.send(msg.content, msg.context, reqId, msg.attachments, deviceClients.get(ws) ?? devices.localNodeId, msg.expectedTopicId);
            sendAck();
            break;
          }
          case "settings.assistant.abort": {
            await hub.settingsAssistant.abort(msg.expectedTopicId);
            sendAck();
            break;
          }
          case "settings.assistant.new": {
            if (!settingsClients.has(ws)) throw new Error("请先连接设置助手。");
            await hub.settingsAssistant.newConversation(msg.expectedTopicId, reqId);
            sendAck();
            break;
          }
          case "settings.assistant.select": {
            if (!settingsClients.has(ws)) throw new Error("请先连接设置助手。");
            await hub.settingsAssistant.selectConversation(msg.topicId, msg.expectedTopicId, reqId);
            sendAck();
            break;
          }
          case "settings.assistant.delete": {
            if (!settingsClients.has(ws)) throw new Error("请先连接设置助手。");
            await hub.settingsAssistant.deleteConversation(msg.topicId, msg.expectedTopicId, reqId);
            sendAck();
            break;
          }
          case "settings.assistant.action": {
            if (settingsClients.get(ws) !== msg.clientId) throw new Error("请先连接设置助手。");
            await hub.settingsAssistant.decide(msg.actionId, msg.decision, msg.clientId, msg.error, msg.expectedTopicId);
            sendAck();
            break;
          }
          case "topic.select": {
            if (typeof msg.topicId !== "string" || !msg.topicId.trim() ||
              msg.selectionVersion !== undefined && (!Number.isSafeInteger(msg.selectionVersion) || msg.selectionVersion < 0)) {
              throw new ProjectError(400, "invalid_topic_selection", "会话选择无效。");
            }
            if (msg.selectionVersion !== undefined && msg.selectionVersion < selection.version) { sendAck(); break; }
            const requested = { topicId: msg.topicId, version: msg.selectionVersion ?? selection.version + 1 };
            selection = requested;
            try {
              await hub.getTopicView(requested.topicId);
              if (isCurrent(requested)) await hub.publishCurrentTopicView(requested.topicId, (view) => {
                if (!isCurrent(requested)) return;
                clientTopics.set(ws, view.topicId);
                send({ type: "hub.topic_activity", topicId: view.topicId, activity: topicActivity(view.messages, view.live) });
                send({ type: "hub.messages", topicId: view.topicId, conversationId: view.conversationId, messages: view.messages, historyBefore: view.historyBefore, selectionVersion: requested.version });
                send({ type: "hub.live", topicId: view.topicId, conversationId: view.conversationId, live: view.live, selectionVersion: requested.version });
              });
            }
            catch (error) {
              if (!isCurrent(requested)) { sendAck(); break; }
              selection = { ...requested, topicId: clientTopics.get(ws) ?? "root" };
              throw error;
            }
            sendAck();
            break;
          }
          case "chat.send": {
            if (msg.targetDeviceId !== undefined && (typeof msg.targetDeviceId !== "string" ||
              msg.targetDeviceId.length > 256 || /[\u0000-\u001f]/.test(msg.targetDeviceId))) {
              throw new ProjectError(400, "invalid_device_target", "设备目标无效。");
            }
            const targetTopic = msg.topicId || selection.topicId;
            ctxTopicId = targetTopic; const sendCid = settingsClients.get(ws); if (sendCid) hub.settingsAssistant.noteTopicClient(targetTopic, sendCid);
            const source = sourceDeviceKnown ? devices.chatMessageSource(principal) : undefined;
            if (!devices.isLocalPrincipal(principal) && !source) throw new DeviceConnectionError("设备互联已关闭或配对已失效。", 403);
            const [deduplicated, receipt] = await Promise.all([
              reqId ? hub.hasSubmittedRequest(targetTopic, reqId) : Promise.resolve(false),
              hub.deliverClientMessage({ ...msg, topicId: targetTopic }, principal, BACKGROUND_CONTEXT, source),
            ]);
            sendAck({ ...receipt, deduplicated: receipt.deduplicated || deduplicated });
            break;
          }
          case "chat.abort":
          case "chat.retry": {
            const targetTopic = msg.topicId || selection.topicId;
            ctxTopicId = targetTopic; if (msg.type === "chat.retry") { const retryCid = settingsClients.get(ws); if (retryCid) hub.settingsAssistant.noteTopicClient(targetTopic, retryCid); }
            sendAck(await hub.deliverClientMessage({ ...msg, topicId: targetTopic }, deviceClients.get(ws) ?? devices.localNodeId));
            break;
          }
          case "ticket.steer":
          case "ticket.retry":
          case "ticket.stop":
          case "ticket.close":
          case "schedule.stop":
          case "schedule.delete":
          case "assistant.item_action": {
            sendAck(await hub.deliverClientMessage(msg, deviceClients.get(ws) ?? devices.localNodeId));
            break;
          }
          case "ticket.inspect": {
            inspectedTickets.set(ws, msg.ticketId);
            const detail = await hub.inspectTicketDetail(msg.ticketId);
            send({ type: "hub.ticket_detail", ...detail });
            sendAck({ ticketId: msg.ticketId });
            break;
          }
          case "state.sync": {
            ctxTopicId = selection.topicId;
            sendAck({ topicId: await sendSnapshot() });
            break;
          }
          case "client.ping":
            sendAck();
            break;
          default:
            throw Object.assign(new Error("当前中枢不支持此操作，请更新并重新启动中枢。"), { code: "unsupported_action" });
        }
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err && typeof err.code === "string"
            ? err.code
            : undefined;
        const declaredStatus = err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : undefined;
        const sqliteCode = err && typeof err === "object" && "errcode" in err && typeof err.errcode === "number" ? err.errcode & 0xff : undefined;
        const transient = err instanceof Error && (err.name === "SessionFailed" ||
          Boolean(code && ["SQLITE_BUSY", "SQLITE_LOCKED", "EIO", "ENOSPC", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) ||
          code === "ERR_SQLITE_ERROR" && sqliteCode !== undefined && [5, 6, 10, 13].includes(sqliteCode));
        const status = declaredStatus !== undefined && Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
          ? declaredStatus : transient ? 503 : 400;
        send({
          type: "hub.error",
          message: formatHubErrorMessage(err),
          ...(code ? { code } : err instanceof Error && err.name === "SessionFailed" ? { code: "session_failed" } : {}),
          status,
          retryable: status === 408 || status === 429 || status >= 500,
          action,
          ...(reqId ? { requestId: reqId } : {}),
          ...(cmdId ? { commandId: cmdId } : {}),
          ...(ctxTopicId ? { topicId: ctxTopicId } : {}),
          ...(ctxTicketId ? { ticketId: ctxTicketId } : {}),
        });
      }
    });

    ws.once("close", () => {
      deviceClients.delete(ws);
      clientTopics.delete(ws);
      inspectedTickets.delete(ws);
      const clientId = settingsClients.get(ws);
      settingsClients.delete(ws);
      if (clientId && ![...settingsClients.values()].includes(clientId)) hub.settingsAssistant.forgetContext(clientId);
    });

    const firstSnapshot = sendSnapshot().catch((err: unknown) => {
      const code = err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : err instanceof Error && err.name === "SessionFailed" ? "session_failed" : undefined;
      send({
        type: "hub.error", action: "state.sync", message: formatHubErrorMessage(err),
        ...(code ? { code } : {}), status: err instanceof Error && err.name === "SessionFailed" ? 503 : 500, retryable: true,
      });
    }).finally(() => { initialized = true; });
  });

  envWss.on("connection", (ws) => {
    hub.envManager.handleEnvWebSocket(ws);
  });

  const tryServeStaticAsset = (pathname: string, res: http.ServerResponse): boolean => {
    if (!fs.existsSync(webDistDir)) return false;
    const canonicalRoot = fs.realpathSync(webDistDir);
    const indexHtmlPath = path.join(canonicalRoot, "index.html");
    if (!fs.existsSync(indexHtmlPath)) return false;

    const relativeReq =
      pathname === "/"
        ? "index.html"
        : pathname === "/favicon.ico" && !fs.existsSync(path.join(canonicalRoot, "favicon.ico"))
          ? "favicon-32.png"
          : pathname.replace(/^\/+/, "");
    const candidate = path.resolve(canonicalRoot, relativeReq);
    const rel = path.relative(canonicalRoot, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return false;
    }

    let fileToServe = candidate;
    if (!fs.existsSync(fileToServe) || !fs.statSync(fileToServe).isFile()) {
      if (!path.extname(pathname)) {
        fileToServe = indexHtmlPath;
      } else {
        return false;
      }
    }

    const canonicalFile = fs.realpathSync(fileToServe);
    const canonicalRel = path.relative(canonicalRoot, canonicalFile);
    if (canonicalRel.startsWith("..") || path.isAbsolute(canonicalRel)) {
      return false;
    }

    const ext = path.extname(canonicalFile).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const cacheHeader =
      ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    if (ext === ".html") {
      const html = fs.readFileSync(canonicalFile, "utf8");
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": cacheHeader,
        "content-security-policy": webUiContentSecurityPolicy(html),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end(html);
      return true;
    }
    streamStaticFile(canonicalFile, res, {
      "content-type": mime,
      "cache-control": cacheHeader,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    return true;
  };

  const devicesClusterRouteDeps = {
    devices, sshDevices, mobileConnector, roleTransitions, clusterSync, fenceMonitor, clusterPaths,
    peerRootDir: options.peerRootDir,
    getActualPort: () => actualPort,
    isClusterActive, ensurePrimaryClusterKeys, persistPrimaryClusterMembership,
    requireMobileConnector, mobileMetadata, deviceView, setInterconnectionFromHttp,
    prepareJoinPeer, performRemoveDevice,
  };
  const handleAssistantStreamRoute = async (ctx: HubHttpRouteContext): Promise<boolean> => {
    if (ctx.pathname !== "/api/assistant/stream" || ctx.req.method !== "GET") return false;
    const { req, res } = ctx;
    res.setHeader("cache-control", "no-store");
    const initial = await hub.getAssistantItemsSnapshot();
    if (closing || res.writableEnded || res.destroyed) return true;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`event: assistant_items\ndata: ${JSON.stringify(initial)}\n\n`);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
      }
    }, 20_000);
    heartbeat.unref();
    const entry = { res, heartbeat };
    assistantStreamClients.add(entry);
    const cleanup = () => {
      clearInterval(heartbeat);
      assistantStreamClients.delete(entry);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    return true;
  };
  const apiRouteHandlers: ReadonlyArray<(ctx: HubHttpRouteContext) => Promise<boolean>> = [
    handleSystemPermissionsRoutes,
    handleAssistantStreamRoute,
    handleVoiceAssistantConnectionsRoutes,
    handleUiCardRoutes,
    (ctx) => handleDevicesAndClusterRoutes(ctx, devicesClusterRouteDeps),
    handleCapabilitiesRoutes,
    handleProjectsRoutes,
    handleWorkspaceRoutes,
    handleSettingsProvidersRoutes,
  ];

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    try {
      if (req.method === "GET" && pathname === "/_kulo/instance") {
        const verified = !closing && options.runtimeOwner?.proveLocalIdentity(req, res, authToken, { role: "hub" });
        res.writeHead(verified ? 200 : 403, { "cache-control": "no-store" }).end();
        return;
      }
      if (req.method === "GET" && pathname === "/api/health") {
        if (!closing) hub.localInstance.proveLocalIdentity(req, res, authToken);
        sendJson(res, 200, {
          ok: true,
          version: KULO_VERSION,
        });
        return;
      }

      if (req.method === "POST" && pathname === MEMORY_LLM_BRIDGE_PATH) {
        if (closing || !hub.memoryLlmBridge.authenticate(req)) {
          sendJson(res, 401, { error: { code: "bridge_unauthorized", message: "未授权的记忆模型桥接请求。", retryable: false } });
          return;
        }
        const abortController = new AbortController();
        const abortOnDisconnect = () => { if (!res.writableEnded) abortController.abort(); };
        res.once("close", abortOnDisconnect);
        try {
          const body = await readJsonBody(req, 4 * 1024 * 1024);
          const result = await hub.memoryLlmBridge.handleCall(body, abortController.signal);
          sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof MemoryLlmBridgeError) {
            sendJson(res, error.status, { error: error.body });
          } else if (error instanceof SyntaxError) {
            sendJson(res, 400, { error: { code: "invalid_request", message: "请求 JSON 格式无效。", retryable: false } });
          } else {
            sendJson(res, 500, { error: { code: "upstream_error", message: hub.connectionManager.redact(error instanceof Error ? error.message : "记忆模型调用失败。"), retryable: true } });
          }
        } finally {
          res.off("close", abortOnDisconnect);
        }
        return;
      }

      if (pathname === "/api/mobile/info" && req.method === "GET") {
        requireMobileConnector(req);
        sendJson(res, 200, mobileMetadata(await mobileConnector.status()));
        return;
      }
      if (pathname === "/api/mobile/pair" && req.method === "POST") {
        requireMobileConnector(req);
        let body: unknown;
        try { body = await readJsonBody(req, 32 * 1024); }
        catch (error) {
          if (error instanceof SyntaxError) throw new DeviceConnectionError("手机配对请求 JSON 无效。", 400, "mobile_invalid_request");
          throw error;
        }
        const metadata = mobileMetadata(await mobileConnector.status());
        const profile = devices.pairMobile(body, metadata.spkiSHA256);
        sendJson(res, 200, { ...profile, hubName: metadata.hubName, candidates: metadata.candidates });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/connect/")) {
        if (!devices.enabled) throw new DeviceConnectionError("设备互联已关闭。", 403);
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-content-type-options", "nosniff");
        if (pathname === "/connect/install.sh" || pathname === "/connect/install.ps1") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(renderPeerInstaller(pathname.endsWith(".sh") ? "posix" : "powershell"));
          return;
        }
        if (pathname === "/connect/peer.mjs") {
          const bundle = fileURLToPath(new URL("../../env/dist/peer.mjs", import.meta.url));
          if (!fs.existsSync(bundle)) throw new DeviceConnectionError("设备接入程序尚未构建，请先运行 pnpm build。", 503);
          streamStaticFile(bundle, res, {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          });
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/devices/pair") {
        const body = await readJsonBody(req, 32 * 1024);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new DeviceConnectionError("配对请求无效。");
        res.setHeader("cache-control", "no-store");
        const topology = isClusterActive() ? devices.buildClusterTopology(actualPort, requestOrigin(req)) : undefined;
        sendJson(res, 200, devices.pair(body, topology));
        return;
      }

      if (pathname === "/_kulo/cluster/status" && req.method === "GET") {
        const authHeader = typeof req.headers[CLUSTER_AUTH_HEADER] === "string" ? req.headers[CLUSTER_AUTH_HEADER] : undefined;
        const auth = clusterNonceGuard.verifyAndConsume({
          headerValue: authHeader,
          method: "GET",
          pathWithQuery: req.url ?? pathname,
          resolveSecret: (nodeId) => devices.resolveClientSecret(nodeId) ?? devices.resolveSyncSecret(nodeId),
        });
        if (!auth.ok) {
          sendJson(res, 401, { error: "Unauthorized", code: auth.reason });
          return;
        }
        const localView = devices.view(actualPort, requestOrigin(req));
        const status: ClusterNodeStatus = {
          version: 1,
          hubId: devices.hubId,
          nodeId: devices.localNodeId,
          name: localView.hubName,
          role: "primary",
          active: !closing,
          epoch: devices.clusterEpoch,
          primaryNodeId: devices.primaryNodeId,
          preferredPrimaryNodeId: devices.preferredPrimaryNodeId,
          isPreferredPrimary: devices.primaryNodeId === devices.preferredPrimaryNodeId,
          syncedGeneration: clusterSync.currentGeneration,
          canPromote: false,
          handoverInProgress: hub.isHandoverBarrierActive,
          ...(devices.identityPublicKey ? { identityPublicKey: devices.identityPublicKey } : {}),
        };
        sendJson(res, 200, status);
        return;
      }

      if (pathname.startsWith("/api/cluster/sync/")) {
        const authHeader = typeof req.headers[CLUSTER_AUTH_HEADER] === "string" ? req.headers[CLUSTER_AUTH_HEADER] : undefined;
        const parsedAuth = parseClusterAuthHeader(authHeader);
        if (!parsedAuth) {
          sendJson(res, 401, { error: "Unauthorized", code: "invalid_auth_header" });
          return;
        }
        const rawBody = req.method === "POST" ? await readRawBody(req, 512 * 1024) : undefined;
        if (!devices.getStandbyRecord(parsedAuth.nodeId)) {
          sendJson(res, 403, { error: "该设备未获授权或已取消备用主机资格。", code: "standby_revoked" });
          return;
        }
        const auth = clusterNonceGuard.verifyAndConsume({
          headerValue: authHeader,
          method: req.method ?? "GET",
          pathWithQuery: req.url ?? pathname,
          body: rawBody,
          resolveSecret: (nodeId) => devices.resolveSyncSecret(nodeId),
        });
        if (!auth.ok) {
          sendJson(res, 401, { error: "Unauthorized", code: auth.reason });
          return;
        }
        await ensurePrimaryClusterKeys();
        if (pathname === "/api/cluster/sync/manifest" && req.method === "GET") {
          sendJson(res, 200, await clusterSync.serveManifest(auth.nodeId, auth.nonce));
          return;
        }
        if (pathname === "/api/cluster/sync/sqlite-pages" && req.method === "POST") {
          let body: { generation?: unknown; db?: unknown; pages?: unknown };
          try {
            body = rawBody && rawBody.byteLength > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
          } catch {
            throw new ClusterSyncHttpError(400, "invalid_json", "同步页请求 JSON 无效。");
          }
          sendJson(res, 200, await clusterSync.serveSqlitePages(auth.nodeId, auth.nonce, body));
          return;
        }
        if (pathname === "/api/cluster/sync/file" && req.method === "GET") {
          const generation = Number(parsedUrl.searchParams.get("generation"));
          const relPath = parsedUrl.searchParams.get("path") ?? "";
          const rawOffset = parsedUrl.searchParams.get("offset");
          const rawLength = parsedUrl.searchParams.get("length");
          const offset = rawOffset !== null ? Number(rawOffset) : undefined;
          const length = rawLength !== null ? Number(rawLength) : undefined;
          sendJson(res, 200, await clusterSync.serveFile(auth.nodeId, auth.nonce, {
            generation,
            relPath,
            ...(offset !== undefined ? { offset } : {}),
            ...(length !== undefined ? { length } : {}),
          }));
          return;
        }
        if (pathname === "/api/cluster/sync/vault" && req.method === "GET") {
          const generation = Number(parsedUrl.searchParams.get("generation"));
          sendJson(res, 200, await clusterSync.serveVault(auth.nodeId, auth.nonce, generation));
          return;
        }
        sendJson(res, 404, { error: "同步接口不存在。" });
        return;
      }

      if (await mediaHttp(req, res, parsedUrl)) return;

      const haTtsRoute = /^\/_ha-tts\/([a-f0-9]{64})$/.exec(pathname);
      if (haTtsRoute) {
        hub.haLanAudio.handleRequest(req, res, haTtsRoute[1]!);
        return;
      }

      if (pathname.startsWith("/api/")) {
        if (!isAuthorizedHttp(req, parsedUrl)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        if (
          hub.isHandoverBarrierActive &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "") &&
          !pathname.startsWith("/api/cluster/") &&
          pathname !== "/api/devices/cluster-status"
        ) {
          sendJson(res, 503, { error: "主机正在切换，请稍候。", code: "cluster_handover_in_progress" });
          return;
        }
        const authority = requestAuthority(req, parsedUrl);
        const routeCtx: HubHttpRouteContext = {
          hub, req, res, parsedUrl, pathname, authority, readJsonObject, readJsonBody, sendJson,
          requestOrigin, currentDevice, hasLocalDeviceControl, hasOwnerHubControl, conversationQueryContext,
          isHubSecret: (candidate) => [authToken, ...Object.values(hub.config.envTokens ?? {})].some((token) => Boolean(token) && token === candidate.trim()),
          openNativePermissionSettings: (kind) => options.openNativePermissionSettings ? options.openNativePermissionSettings(kind) : openNativePermissionSettings(kind),
        };

        for (const handleRoute of apiRouteHandlers) {
          if (await handleRoute(routeCtx)) return;
        }

        sendJson(res, 404, { error: "API route not found" });
        return;
      }

      if (req.method === "GET") {
        if (tryServeStaticAsset(pathname, res)) {
          return;
        }
        if (pathname === "/") {
          res.writeHead(503, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          });
          res.end("Kulo Web UI 尚未构建，请先在仓库根目录运行 `pnpm build`。");
          return;
        }
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      if (err instanceof SearchError) {
        sendJson(res, err.status, { error: err.message, code: err.code,
          ...(err.failure ? { failure: err.failure } : {}),
          ...(err.attempts ? { attempts: err.attempts } : {}) });
        return;
      }
      if (err instanceof TaskDeliverableError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProjectError) {
        sendJson(res, err.status, { error: err.message, code: err.code, ...err.details });
        return;
      }
      if (err instanceof UiCardError) {
        sendJson(res, err.status, { error: err.message, code: err.code, ...(err.card ? { card: err.card } : {}) });
        return;
      }
      if (err instanceof ClusterSyncHttpError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof DeviceConnectionError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof IdentityFilesError || err instanceof PersonalityError || err instanceof UsageCapsError || err instanceof MemoryServiceError || err instanceof ExtensionError || err instanceof ExtensionPackageError || err instanceof VoiceError || err instanceof VoiceCallsError || err instanceof SkillError || err instanceof CapabilityError || err instanceof AgentConfigurationError || err instanceof ConversationQueryError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof SettingsUpdateError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      const sessionFailed = err instanceof Error && err.name === "SessionFailed";
      const status =
        typeof (err as { status?: unknown })?.status === "number"
          ? ((err as { status: number }).status)
          : sessionFailed ? 503 : 500;
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      const connectionCode = (pathname === "/api/connections" || pathname.startsWith("/api/connections/")) &&
        typeof code === "string" && /^connection_[a-z0-9_]+$/.test(code) ? code : undefined;
      const deviceCode = pathname === "/api/devices/join" && typeof code === "string" &&
        ["device_invitation_invalid", "device_host_unreachable", "local_tasks_running", "role_switch_busy"].includes(code) ? code : undefined;
      sendJson(res, status, {
        error: sessionFailed ? "本地会话存储连接异常，请重启 Kulo 后重试。" : hub.connectionManager.redact(err instanceof Error ? err.message : String(err)),
        ...(sessionFailed ? { code: "session_failed" } : connectionCode ? { code: connectionCode } : deviceCode ? { code: deviceCode } : {}),
      });
    }
  };
  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res).catch((err) => { console.error("[KuloHttp]", err instanceof Error ? err.message : String(err)); if (!res.writableEnded && !res.destroyed) res.end(); });
  });

  const handleUpgrade = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (parsedUrl.pathname === "/ws/computer-preview") {
      const principal = authenticatedDevice(req, parsedUrl);
      let sameOrigin = true;
      if (req.headers.origin) {
        try { sameOrigin = new URL(req.headers.origin).origin === new URL(requestOrigin(req)).origin; } catch { sameOrigin = false; }
      }
      if (closing || !principal || !sameOrigin) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
      const topicId = parsedUrl.searchParams.get("topicId") ?? "root";
      if (!topicId || topicId.length > 160 || /[\x00-\x20\x7f]/.test(topicId)) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
      if ([...previewClients.values()].filter((client) => client.principal === principal).length >= 4) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); socket.destroy(); return;
      }
      previewWss.handleUpgrade(req, socket, head, (ws) => {
        deviceClients.set(ws, principal);
        const dispose = attachComputerPreviewSocket(ws, hub, topicId, {
          isPrincipalActive: () => devices.isLocalPrincipal(principal) || (devices.enabled && devices.view(actualPort, `http://localhost:${actualPort}`).devices.some((device) => device.id === principal)),
        });
        previewClients.set(ws, { principal, dispose });
        ws.once("close", () => { dispose(); previewClients.delete(ws); deviceClients.delete(ws); });
      });
      return;
    }

    const voiceRoute = /^\/api\/voice\/calls\/([^/]+)\/socket$/.exec(parsedUrl.pathname);
    if (voiceRoute) {
      const principal = authenticatedDevice(req, parsedUrl);
      let sameOrigin = true;
      if (req.headers.origin) {
        try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
      }
      if (!principal || !sameOrigin) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
      voiceWss.handleUpgrade(req, socket, head, (ws) => {
        const id = decodeURIComponent(voiceRoute[1]!);
        voiceClients.set(ws, { id, principal });
        ws.once("close", () => voiceClients.delete(ws));
        void hub.voiceCalls.attach(id, principal, ws).catch((error: unknown) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message: hub.connectionManager.redact(error instanceof Error ? error.message : "通话连接失败。") }));
          ws.close(1011, "Voice connection failed");
        });
      });
      return;
    }

    if (parsedUrl.pathname === "/ws/mobile-probe") {
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const role = parsedUrl.searchParams.get("role");
      const id = role === "env" ? devices.authenticateEnv(token) : role === "client" ? devices.authenticateClient(token) : undefined;
      if (!isMobileConnector(req) || !devices.enabled || !id) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
      }
      mobileProbeWss.handleUpgrade(req, socket, head, (ws) => mobileProbeWss.emit("connection", ws, req));
      return;
    }

    if (parsedUrl.pathname === "/ws/client") {
      let sameOrigin = true;
      if (req.headers.origin) {
        try { sameOrigin = new URL(req.headers.origin).origin === new URL(requestOrigin(req)).origin; } catch { sameOrigin = false; }
      }
      if (!isAuthorizedHttp(req, parsedUrl) || !sameOrigin) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        clientWss.emit("connection", ws, req);
      });
      return;
    }

    if (parsedUrl.pathname === "/ws/env") {
      envWss.handleUpgrade(req, socket, head, (ws) => {
        envWss.emit("connection", ws, req);
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  };
  httpServer.on("upgrade", handleUpgrade);

  async function listenOn(address: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, address, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });
    const bound = httpServer.address();
    if (bound && typeof bound !== "string") {
      const lanReachable = address === "0.0.0.0" || address === "::" || (address !== "127.0.0.1" && address !== "::1" && address !== "localhost");
      hub.setLanHttpEndpoint(() => ({ lanReachable, port: bound.port }));
      try {
        httpServer.once("close", () => hub.setLanHttpEndpoint(undefined));
        httpServer.once("close", hub.localInstance.publish(bound));
        httpServer.once("close", hub.memoryLlmBridge.publish(bound.port));
        if (options.runtimeOwner) httpServer.once("close", options.runtimeOwner.publish(bound));
      }
      catch (error) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        throw error;
      }
    }
  }
  await listenOn(host, requestedPort);

  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to resolve KuloHubServer listening port");
  }
  actualPort = addr.port;
  const advertised = new URL(localListenerOrigin({ address: host, port: actualPort }));
  if (devices.enabled) {
    void sshDevices.restore(devices.sshRecords).catch((error: unknown) => {
      console.error("恢复 SSH 设备失败:", error instanceof Error ? error.message : String(error));
    });
    restoreMobileConnector();
  }
  if (isClusterActive()) {
    persistPrimaryClusterMembership(advertised.origin);
    void ensurePrimaryClusterKeys()
      .then(() => clusterSync.start())
      .catch((error: unknown) => {
        console.error("[ClusterSync] init keys failed:", error instanceof Error ? error.message : String(error));
      });
    fenceMonitor.start();
  }

  return {
    get host() { return host; },
    port: actualPort,
    url: advertised.origin,
    localUrl: localListenerOrigin(addr),
    clientWsUrl: `ws://${advertised.host}/ws/client`,
    envWsUrl: `ws://${advertised.host}/ws/env`,
    probeConnection: () => {
      if (closing) return;
      void fenceMonitor.checkNow();
    },
    close: async () => {
      closing = true;
      cancelMobileConnectorRestore();
      fenceMonitor.stop();
      hub.setOnClusterDirty(undefined);
      devices.setOnWrite(undefined);
      hub.envManager.setClusterHandlers(undefined);
      await clusterSync.close();
      hub.bindDeviceController(undefined);
      await mobileConnector.close();
      mediaHttp.close();
      await listenerTransition;
      sshDevices.close();
      unsubscribeHub();
      for (const client of [...assistantStreamClients]) {
        clearInterval(client.heartbeat);
        try { client.res.end(); } catch { /* ignore */ }
      }
      assistantStreamClients.clear();
      for (const ws of clientWss.clients) {
        try {
          ws.close(1001, "Server closing");
        } catch {
          // ignore
        }
      }
      clientWss.close();
      for (const [ws, client] of previewClients) { client.dispose(); ws.terminate(); }
      previewClients.clear();
      previewWss.close();
      for (const ws of voiceWss.clients) ws.terminate();
      voiceWss.close();
      for (const ws of envWss.clients) ws.terminate();
      envWss.close();
      for (const ws of mobileProbeWss.clients) ws.terminate();
      mobileProbeWss.close();
      if (mobileHttpStarting) await mobileHttpStarting.catch(() => {});
      if (mobileHttpServer?.listening) {
        mobileHttpServer.closeAllConnections();
        await new Promise<void>((resolve) => mobileHttpServer!.close(() => resolve()));
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
