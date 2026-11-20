import fs from "node:fs";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import http from "node:http";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { DeviceRoleTransitions, localListenerOrigin, renderPeerInstaller, type LocalInstanceOwner } from "@kulo/env";
import {
  CUSTOM_PROVIDER_APIS,
  KULO_VERSION,
  formatDeviceChatInvitation,
  normalizeKuloLanguage,
  normalizeVertexConfig,
  isDesktopSystemPermissions,
  parseDeviceJoinInput,
  type DeviceChatInvitation,
  type DevicePeerConfig,
  type DesktopSystemPermissions,
  type ClientToHubMessage,
  type IdentityFile,
  type CustomProviderApi,
  type DiscoverModelsRequest,
  type HubToClientMessage,
  type ModelProbeRequest,
  type SettingsBlockName,
  type ConnectionSaveRequest,
  type ConnectionPrepareRequest,
  type NativeAppPermissionKind,
  type ExtensionOperationRequest,
} from "@kulo/protocol";
import { openNativePermissionSettings } from "./connection-native-apps.js";
import { IdentityFilesError, getIdentityTemplate } from "./identity-files.js";
import { PersonalityError } from "./personality.js";
import { MemoryServiceError } from "./memory-service.js";
import { ExtensionError } from "./extensions.js";
import { ExtensionPackageError } from "./extension-packages.js";
import { VoiceError } from "./voice-service.js";
import { VoiceCallsError } from "./voice-calls.js";
import { SearchError } from "./search.js";
import { ConversationQueryError, decodeConversationTopicId } from "./conversation-query.js";
import { SkillError } from "./skills.js";
import { CapabilityError } from "./capabilities.js";
import type { KuloHub } from "./hub.js";
import { topicActivity } from "./topic-activity.js";
import { SettingsUpdateError } from "./settings.js";
import { createMediaHttpHandler } from "./media-http.js";
import { snapshotChatUploadScope } from "./chat-attachment-deliveries.js";
import { handleImageConfigurationHttp } from "./image-configuration-http.js";
import { handleModelConfigurationHttp } from "./model-configuration-http.js";
import { MAINSTREAM_PROVIDER_PRESETS } from "./providers.js";
import { UiCardError } from "./ui-cards.js";
import { DeviceConnectionError, DeviceInterconnectionManager } from "./devices.js";
import { isTicketUnfinished } from "./state.js";
import { DeviceSshConnector } from "./device-ssh.js";
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

async function readJsonBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
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
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

const VALID_BLOCKS: readonly SettingsBlockName[] = [
  "presentation",
  "executor",
  "roles",
  "model",
  "identity",
  "memory",
];

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
  hub.setAndroidHubIdentity(devices.hubId);
  if (devices.enabled && options.host === undefined) host = "0.0.0.0";
  let actualPort = requestedPort;
  let closing = false;
  let listenerTransition: Promise<void> = Promise.resolve();
  const deviceClients = new Map<WebSocket, string>();
  const sshDevices = new DeviceSshConnector({
    stateDir: hub.config.stateDir,
    hubPort: () => actualPort,
    createInvitation: async (request) => {
      const result = devices.createInvitation({ ...request, allowLoopback: true });
      return { deviceId: result.invitation.deviceId, inviteToken: result.inviteToken };
    },
    onError: (id, message) => devices.setError(id, message),
    onAddFailed: (id) => devices.remove(id),
  });
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
    }, options: options.mobileConnector });
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

  const authenticatedDevice = (req: http.IncomingMessage, parsedUrl: URL): string | undefined => {
    const headerToken = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const queryToken = parsedUrl.searchParams.get("token");
    const expected = Buffer.from(authToken);
    for (const token of [headerToken, queryToken]) {
      if (!token || token.length > 8192) continue;
      const supplied = Buffer.from(token);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return "local";
    }
    for (const token of [headerToken, queryToken]) {
      const id = devices.authenticateClient(token ?? undefined);
      if (id) return id;
    }
    return undefined;
  };
  const isAuthorizedHttp = (req: http.IncomingMessage, parsedUrl: URL): boolean => authenticatedDevice(req, parsedUrl) !== undefined;

  const mediaHttp = createMediaHttpHandler({
    uploads: hub.uploads,
    authenticate: authenticatedDevice,
    isPrincipalActive: (principal) => principal === "local" || (devices.enabled && devices.view(actualPort, `http://localhost:${actualPort}`).devices.some((device) => device.id === principal)),
    canReadScope: async (_principal, scope) => (await snapshotChatUploadScope(hub.harness, BACKGROUND_CONTEXT))(scope),
  });

  const currentDevice = (req: http.IncomingMessage, url: URL): string => authenticatedDevice(req, url) ?? "local";
  const requestOrigin = (req: http.IncomingMessage): string => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host ?? `localhost:${actualPort}`}`;
  const isDirectLocalRequest = (req: http.IncomingMessage) => !req.headers.forwarded && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"] &&
    req.headers["sec-fetch-site"] !== "cross-site" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const hasLocalDeviceControl = (req: http.IncomingMessage, url: URL) => isDirectLocalRequest(req) && authenticatedDevice(req, url) === "local";
  const deviceView = (req: http.IncomingMessage, url: URL) => {
    const id = currentDevice(req, url);
    const currentDeviceKnown = id !== "local" || isDirectLocalRequest(req);
    const canSwitchRole = roleTransitions.canJoin && id === "local" && currentDeviceKnown;
    return { ...devices.view(actualPort, requestOrigin(req), id), currentDeviceKnown, canSwitchRole };
  };
  const guardRemoteTasks = async (ids: string[] | undefined, force: boolean) => {
    const board = await hub.getBoardSnapshot();
    const running = board.tickets.filter((t) => t.envId !== "local" && (!ids || ids.includes(t.envId)) && ["running", "queued", "blocked", "pausing", "waiting"].includes(t.status));
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
      mediaHttp.revoke();
      sshDevices.cancelPending();
      await Promise.all([...voiceClients.values()].filter((call) => call.principal !== "local").map((call) => hub.voiceCalls.end(call.id, call.principal)));
      for (const [client, deviceId] of deviceClients) if (deviceId !== "local") client.close(4003, "Device interconnection disabled");
      for (const client of mobileProbeWss.clients) client.close(4003, "Device interconnection disabled");
    } else {
      void sshDevices.restore(devices.sshRecords).catch((error: unknown) => {
        console.error("恢复 SSH 设备失败:", error instanceof Error ? error.message : String(error));
      });
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
    devices.remove(id);
    mediaHttp.revoke(id);
    sshDevices.remove(id);
    await Promise.all([...voiceClients.values()].filter((call) => call.principal === id).map((call) => hub.voiceCalls.end(call.id, call.principal)));
    for (const [client, deviceId] of deviceClients) if (deviceId === id) client.close(4001, "Device removed");
    for (const client of mobileProbeWss.clients) client.close(4001, "Device removed");
  };
  const resolvePrincipalForClient = (clientId?: string): string => {
    if (!clientId) return "local";
    for (const [ws, registered] of settingsClients) {
      if (registered === clientId) return deviceClients.get(ws) ?? "local";
    }
    return "local";
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
      return {
        ...devices.view(actualPort, `http://127.0.0.1:${actualPort}`, principal),
        currentDeviceKnown: true,
        canSwitchRole: roleTransitions.canJoin && principal === "local",
      };
    },
    setEnabled: async (enabled, force = false) => {
      await applyInterconnectionEnabled(enabled, force, false);
      return {
        ...devices.view(actualPort, `http://127.0.0.1:${actualPort}`, "local"),
        currentDeviceKnown: true,
        canSwitchRole: roleTransitions.canJoin,
      };
    },
    rename: async (deviceId, name) => {
      devices.rename(deviceId, name);
      return {
        ...devices.view(actualPort, `http://127.0.0.1:${actualPort}`, "local"),
        currentDeviceKnown: true,
        canSwitchRole: roleTransitions.canJoin,
      };
    },
    createInvitation: async ({ hubUrl, name }) => {
      if (!devices.enabled) await applyInterconnectionEnabled(true, false, false);
      const localView = devices.view(actualPort, `http://127.0.0.1:${actualPort}`, "local");
      const targetUrl = hubUrl?.trim() || localView.hubUrls[0];
      if (!targetUrl) throw new DeviceConnectionError("未找到其他设备可访问的本机网络地址。");
      const { invitation } = devices.createInvitation({ hubUrl: targetUrl, name });
      return { id: invitation.id, deviceId: invitation.deviceId, hubUrl: targetUrl, expiresAt: invitation.expiresAt };
    },
    scanSsh: async (req) => sshDevices.scan(req),
    addSsh: async (scanId) => {
      const record = await sshDevices.add(scanId);
      devices.recordSsh(record);
      return devices.view(actualPort, `http://127.0.0.1:${actualPort}`, "local").devices.find((d) => d.id === record.deviceId);
    },
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
  const unsubscribeHub = hub.subscribe({
    onVoice: (snapshot) => broadcastToAllClients({ type: "hub.voice", snapshot }),
    onCapabilities: (snapshot) => broadcastToAllClients({ type: "hub.capabilities", snapshot: { ...snapshot, inputs: [] } }),
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
    onTopicView: (topicId, messages, live) => {
      const activity = topicActivity(messages, live);
      const signature = JSON.stringify(activity);
      if (lastTopicActivities.get(topicId) !== signature) {
        lastTopicActivities.set(topicId, signature);
        broadcastToAllClients({ type: "hub.topic_activity", topicId, activity });
      }
      broadcastTopicView(
        topicId,
        { type: "hub.messages", topicId, messages, historyBefore: hub.getTopicHistoryBefore(topicId) },
        { type: "hub.live", topicId, live },
      );
    },
    onTopics: (topics) => {
      const existing = new Set(topics.map((topic) => topic.id));
      for (const topicId of lastTopicActivities.keys()) if (!existing.has(topicId)) lastTopicActivities.delete(topicId);
      broadcastToAllClients({ type: "hub.topics", topics });
    },
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
    const sourceDeviceKnown = principal !== "local" || isDirectLocalRequest(req);
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
        send({
          type: "hub.snapshot", ...snapshot, ...board, messages: view.messages, live: view.live, historyBefore: view.historyBefore,
          topicActivities: { ...snapshot.topicActivities, [view.topicId]: topicActivity(view.messages, view.live) },
          selectionVersion: requested.version, supportsPing: true,
          deliveryIdentity: { hubId: devices.hubId, principalId: deviceClients.get(ws)! },
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

      const sendAck = (extra?: {
        topicId?: string;
        ticketId?: string;
        deduplicated?: boolean;
        submissionId?: number;
        delivery?: "queued" | "accepted";
      }) => {
        if (!reqId && !cmdId) return;
        send({
          type: "hub.ack",
          action,
          ...(reqId ? { requestId: reqId } : {}),
          ...(cmdId ? { commandId: cmdId } : {}),
          ...(extra?.topicId ?? ctxTopicId
            ? { topicId: extra?.topicId ?? ctxTopicId }
            : {}),
          ...(extra?.ticketId ?? ctxTicketId
            ? { ticketId: extra?.ticketId ?? ctxTicketId }
            : {}),
          ...(extra?.deduplicated ? { deduplicated: true } : {}),
          ...(extra?.submissionId === undefined ? {} : { submissionId: extra.submissionId }),
          ...(extra?.delivery ? { delivery: extra.delivery } : {}),
        });
      };

      try {
        if (!clientTopics.has(ws) && msg.type !== "state.sync" && msg.type !== "client.ping") {
          throw new ProjectError(503, "client_snapshot_unavailable", "中枢会话尚未就绪，请稍后重试。");
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
            await hub.settingsAssistant.send(msg.content, msg.context, reqId, msg.attachments, deviceClients.get(ws) ?? "local", msg.expectedTopicId);
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
                send({ type: "hub.messages", topicId: view.topicId, messages: view.messages, historyBefore: view.historyBefore, selectionVersion: requested.version });
                send({ type: "hub.live", topicId: view.topicId, live: view.live, selectionVersion: requested.version });
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
            ctxTopicId = targetTopic;
            const source = sourceDeviceKnown ? devices.chatMessageSource(principal) : undefined;
            if (principal !== "local" && !source) throw new DeviceConnectionError("设备互联已关闭或配对已失效。", 403);
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
            ctxTopicId = targetTopic;
            sendAck(await hub.deliverClientMessage({ ...msg, topicId: targetTopic }, deviceClients.get(ws) ?? "local"));
            break;
          }
          case "ticket.steer":
          case "ticket.retry":
          case "ticket.stop":
          case "ticket.close":
          case "schedule.stop":
          case "schedule.delete": {
            sendAck(await hub.deliverClientMessage(msg, deviceClients.get(ws) ?? "local"));
            break;
          }
          case "ticket.inspect": {
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
        sendJson(res, 200, devices.pair(body));
        return;
      }

      if (await mediaHttp(req, res, parsedUrl)) return;

      if (pathname.startsWith("/api/")) {
        if (!isAuthorizedHttp(req, parsedUrl)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        const systemPermissionsRoute = /^\/api\/envs\/([^/]+)\/system-permissions(\/guide)?$/.exec(pathname);
        if (systemPermissionsRoute) {
          res.setHeader("cache-control", "no-store");
          if (req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin && req.headers.origin !== requestOrigin(req)) {
            throw new DeviceConnectionError("请在 Kulo 中检查和授权系统权限。", 403, "system_permissions_origin_required");
          }
          const guide = Boolean(systemPermissionsRoute[2]);
          if (req.method !== (guide ? "POST" : "GET")) {
            sendJson(res, 405, { error: "此系统权限接口不支持该操作。", code: "system_permissions_method_not_allowed" });
            return;
          }
          let envId: string;
          try { envId = decodeURIComponent(systemPermissionsRoute[1]!); }
          catch { throw new DeviceConnectionError("设备标识无效。", 400, "system_permissions_invalid_device"); }
          if (!envId || envId.length > 256 || /[\x00-\x1f\x7f]/.test(envId)) throw new DeviceConnectionError("设备标识无效。", 400, "system_permissions_invalid_device");
          if (guide) {
            const body = await readJsonObject(req, 1024);
            if (Object.keys(body).some((key) => key !== "kind") || body.kind !== "accessibility" && body.kind !== "screen") {
              throw new DeviceConnectionError("请选择需要授权的桌面权限。", 400, "system_permissions_invalid_request");
            }
          }
          const descriptor = hub.envManager.getEnvDescriptor(envId);
          if (!descriptor) throw new DeviceConnectionError("未找到此设备，请刷新设备列表。", 404, "system_permissions_device_not_found");
          if (!descriptor.online) throw new DeviceConnectionError("设备已离线，请连接后重新检查。", 503, "system_permissions_device_offline");
          if (descriptor.platform !== "darwin") {
            if (guide) throw new DeviceConnectionError("此设备不支持 macOS 系统权限引导。", 409, "system_permissions_unsupported");
            sendJson(res, 200, { platform: descriptor.platform,
              permissions: [{ kind: "accessibility", state: "unsupported" }, { kind: "screen", state: "unsupported" }],
            } satisfies DesktopSystemPermissions);
            return;
          }
          if (!descriptor.capabilities.includes("agent-desktop")) throw new DeviceConnectionError("请在目标设备启用桌面操作后重新检查。", 409, "system_permissions_desktop_disabled");
          const controller = new AbortController();
          const onClose = () => { if (!res.writableEnded) controller.abort(); };
          res.once("close", onClose);
          try {
            const result = await hub.envManager.requestComputerUse(envId, { tool: "desktop", action: guide ? "permission-guide" : "permissions" }, controller.signal)
              .catch(() => { throw new DeviceConnectionError("设备未能确认权限状态，请检查连接后重试；旧版本设备需要先更新。", 503, "system_permissions_device_unavailable"); });
            if (!result.ok) {
              const updateRequired = ["INVALID_INPUT", "CLI_INVALID_OUTPUT", "INVALID_TOOL_OUTPUT"].includes(result.error?.code ?? "");
              throw new DeviceConnectionError(updateRequired ? "目标设备尚不支持此权限操作，请更新设备后重试。" : guide ? "未能开启系统权限引导，请在目标设备检查系统设置后重试。" : "未能检查系统权限，请检查目标设备的桌面工具后重试。", 502,
                updateRequired ? "system_permissions_update_required" : "system_permissions_check_failed");
            }
            if (!isDesktopSystemPermissions(result.data) || result.data.platform !== descriptor.platform || (guide ? result.data.guide === undefined : result.data.guide !== undefined)) {
              throw new DeviceConnectionError("目标设备返回的权限状态无效，请更新设备后重新检查。", 502, "system_permissions_invalid_response");
            }
            if (!res.destroyed) sendJson(res, 200, result.data);
          } finally { res.off("close", onClose); }
          return;
        }

        if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) {
          res.setHeader("cache-control", "no-store");
          if (pathname === "/api/voice" && req.method === "GET") {
            const snapshot = await hub.voice.snapshot();
            sendJson(res, 200, snapshot);
            if (snapshot.asr.enabled && snapshot.asr.status === "unprepared") void hub.voice.prepareAsr().catch((error: unknown) => console.warn("[KuloVoice]", hub.connectionManager.redact(error instanceof Error ? error.message : String(error))));
            return;
          }
          if (pathname === "/api/voice" && req.method === "PUT") {
            const body = await readJsonObject(req);
            for (const section of [body.tts, body.call]) {
              const key = section && typeof section === "object" && "apiKey" in section ? section.apiKey : undefined;
              if (typeof key === "string" && [authToken, ...Object.values(hub.config.envTokens ?? {})].includes(key.trim())) throw new VoiceError(400, "invalid_voice_credential", "语音服务需要独立的 API Key。");
            }
            sendJson(res, 200, await hub.voice.configure(body as never));
            return;
          }
          if (pathname === "/api/voice/asr/prepare" && req.method === "POST") {
            await hub.voice.prepareAsr();
            sendJson(res, 200, await hub.voice.snapshot());
            return;
          }
          if (pathname === "/api/voice/call/probe" && req.method === "POST") {
            sendJson(res, 200, await hub.voice.probeCall());
            return;
          }
          if (pathname === "/api/voice/transcribe" && req.method === "POST") {
            const body = await readJsonObject(req);
            if (Object.keys(body).some((key) => !["assetId", "topicId", "projectId", "clientId"].includes(key)) || typeof body.assetId !== "string" || (body.topicId !== undefined && typeof body.topicId !== "string")) throw new VoiceError(400, "invalid_voice_transcription", "语音转文字请求无效。");
            const attachment = await hub.transcribeVoiceAsset(body.assetId, { topicId: body.topicId as string | undefined, principalId: currentDevice(req, parsedUrl) });
            sendJson(res, 200, { transcript: attachment.transcript });
            return;
          }
          if (pathname === "/api/voice/synthesize" && req.method === "POST") {
            const body = await readJsonObject(req);
            if (Object.keys(body).some((key) => !["text", "clientId", "preview"].includes(key)) || typeof body.text !== "string" || (body.preview !== undefined && typeof body.preview !== "boolean")) throw new VoiceError(400, "invalid_voice_synthesis", "语音合成请求无效。");
            const controller = new AbortController();
            const onClose = () => { if (!res.writableEnded) controller.abort(); };
            res.once("close", onClose);
            try {
              const audio = await hub.voice.synthesize(body.text, controller.signal, { preview: body.preview === true });
              if (!res.destroyed) { res.writeHead(200, { "content-type": audio.mimeType, "content-length": audio.bytes.length, "x-content-type-options": "nosniff" }); res.end(audio.bytes); }
            } finally { res.off("close", onClose); }
            return;
          }
          if (pathname === "/api/voice/calls" && req.method === "POST") {
            const body = await readJsonObject(req);
            if (Object.keys(body).some((key) => !["topicId", "projectId", "clientId", "commandId"].includes(key)) || typeof body.topicId !== "string" || typeof body.clientId !== "string" || typeof body.commandId !== "string") throw new VoiceError(400, "invalid_voice_call", "通话请求无效。");
            sendJson(res, 201, await hub.voiceCalls.create({ topicId: body.topicId, clientId: body.clientId, commandId: body.commandId, principalId: currentDevice(req, parsedUrl) }));
            return;
          }
          const callRoute = /^\/api\/voice\/calls\/([^/]+)$/.exec(pathname);
          if (callRoute && req.method === "DELETE") {
            await hub.voiceCalls.end(decodeURIComponent(callRoute[1]!), currentDevice(req, parsedUrl));
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 404, { error: "语音接口不存在" });
          return;
        }

        if (pathname === "/api/connections" || pathname.startsWith("/api/connections/")) {
          res.setHeader("cache-control", "no-store");
          if (pathname === "/api/connections" && req.method === "GET") {
            const clientId = parsedUrl.searchParams.get("clientId") ?? undefined;
            if (clientId && (clientId.length > 160 || /[\x00-\x20\x7f]/.test(clientId))) throw Object.assign(new Error("窗口标识无效。"), { status: 400 });
            sendJson(res, 200, { ...(await hub.connectionManager.snapshot(clientId)), localHost: hasLocalDeviceControl(req, parsedUrl) });
            return;
          }
          if (pathname === "/api/connections" && req.method === "POST") {
            sendJson(res, 201, { connection: await hub.connectionManager.save(await readJsonObject(req, 5 * 1024 * 1024) as unknown as ConnectionSaveRequest) });
            return;
          }
          if (pathname === "/api/connections/prepare" && req.method === "POST") {
            sendJson(res, 201, await hub.connectionManager.prepare(await readJsonObject(req) as unknown as ConnectionPrepareRequest));
            return;
          }
          if (pathname === "/api/connections/permission-settings") {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "此系统权限接口不支持该操作。", code: "connection_permission_settings_method_not_allowed" });
              return;
            }
            if (req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin && req.headers.origin !== requestOrigin(req)) {
              throw Object.assign(new Error("请在 Kulo 中打开系统权限设置。"), { status: 403, code: "connection_permission_settings_origin_required" });
            }
            if (!hasLocalDeviceControl(req, parsedUrl)) {
              throw Object.assign(new Error("请在主脑 Mac 上打开系统设置完成授权。"), { status: 403, code: "connection_permission_settings_remote" });
            }
            const body = await readJsonObject(req, 1024);
            if (Object.keys(body).some((key) => key !== "kind") || (body.kind !== "full-disk-access" && body.kind !== "automation")) {
              throw Object.assign(new Error("系统权限类型无效。"), { status: 400, code: "connection_app_invalid_parameters" });
            }
            await (options.openNativePermissionSettings
              ? options.openNativePermissionSettings(body.kind)
              : openNativePermissionSettings(body.kind));
            sendJson(res, 200, { ok: true });
            return;
          }
          const input = /^\/api\/connections\/inputs\/([^/]+)\/(submit|cancel)$/.exec(pathname);
          if (input && req.method === "POST") {
            const body = await readJsonObject(req, 5 * 1024 * 1024);
            if (typeof body.clientId !== "string" || !body.clientId || body.clientId.length > 160) throw Object.assign(new Error("窗口标识无效。"), { status: 400 });
            const id = decodeURIComponent(input[1]!);
            if (input[2] === "submit") sendJson(res, 200, { connection: await hub.connectionManager.submitInput(id, body.clientId, body as unknown as ConnectionSaveRequest) });
            else { await hub.connectionManager.cancelInput(id, body.clientId); sendJson(res, 200, { ok: true }); }
            return;
          }
          const connection = /^\/api\/connections\/([^/]+)(?:\/(test|trust))?$/.exec(pathname);
          if (connection) {
            const id = decodeURIComponent(connection[1]!);
            if (!connection[2] && req.method === "DELETE") {
              await hub.removeConnection(id);
              sendJson(res, 200, { ok: true });
              return;
            }
            if (connection[2] === "test" && req.method === "POST") {
              sendJson(res, 200, await hub.connectionManager.test(id));
              return;
            }
            if (connection[2] === "trust" && req.method === "POST") {
              const body = await readJsonObject(req);
              if (typeof body.fingerprint !== "string") throw Object.assign(new Error("服务器指纹无效。"), { status: 400 });
              sendJson(res, 200, { connection: await hub.connectionManager.trust(id, body.fingerprint) });
              return;
            }
          }
          sendJson(res, 404, { error: "连接操作不存在。" });
          return;
        }

        if (pathname === "/api/mobile/connection" && req.method === "GET") {
          if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
          const deviceId = currentDevice(req, parsedUrl);
          if (deviceId !== "local") requireMobileConnector(req);
          const status = await mobileConnector.status();
          const metadata = mobileMetadata(status);
          sendJson(res, 200, { ...(deviceId === "local" ? metadata : devices.mobileProfile(deviceId, metadata)), tailscale: status.tailscale });
          return;
        }
        if (pathname === "/api/mobile/connection/login" && req.method === "POST") {
          if (currentDevice(req, parsedUrl) !== "local") throw new DeviceConnectionError("请在主脑设备上配置远程连接。", 403);
          if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
          sendJson(res, 200, { authURL: await mobileConnector.login() });
          return;
        }
        if (pathname === "/api/mobile/invitations" && req.method === "POST") {
          if (currentDevice(req, parsedUrl) !== "local") throw new DeviceConnectionError("请在主脑设备上添加手机。", 403);
          if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
          const body = await readJsonObject(req);
          const metadata = mobileMetadata(await mobileConnector.status());
          sendJson(res, 201, devices.createMobileInvitation({ name: body.name, ...metadata }));
          return;
        }
        if (pathname.startsWith("/api/mobile/invitations/") && req.method === "DELETE") {
          if (currentDevice(req, parsedUrl) !== "local") throw new DeviceConnectionError("请在主脑设备上管理手机邀请。", 403);
          devices.cancelMobileInvitation(decodeURIComponent(pathname.slice("/api/mobile/invitations/".length)));
          sendJson(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/mobile/connection/lease" && req.method === "POST") {
          requireMobileConnector(req);
          const id = currentDevice(req, parsedUrl);
          devices.mobileProfile(id, mobileMetadata(await mobileConnector.status()));
          if (res.destroyed || req.aborted) return;
          const lease = randomBytes(32).toString("base64url");
          hub.envManager.setDeviceConnectionLease(id, lease);
          sendJson(res, 200, { lease });
          return;
        }
        if (pathname === "/api/mobile/probe/media" && req.method === "GET") {
          requireMobileConnector(req);
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
          res.end("Kulo mobile transport media probe.\n".repeat(2048));
          return;
        }

        const uiRoute = /^\/api\/ui\/cards\/([^/]+)(\/actions)?$/.exec(pathname);
        if (uiRoute) {
          const cardId = decodeURIComponent(uiRoute[1]!);
          if (req.method === "GET" && !uiRoute[2]) {
            const card = await hub.uiCards.get(cardId);
            if (!card) throw new UiCardError("ui_card_not_found", "卡片不存在。", 404);
            sendJson(res, 200, { card });
            return;
          }
          if (req.method === "POST" && uiRoute[2]) {
            const body = await readJsonBody(req, 128 * 1024) as import("@kulo/protocol").UiActionInput;
            if (!body || body.cardId !== cardId) throw new UiCardError("invalid_ui_action", "卡片操作格式无效。");
            sendJson(res, 200, await hub.submitUiAction(body));
            return;
          }
        }

        if (pathname === "/api/devices" && req.method === "GET") {
          sendJson(res, 200, deviceView(req, parsedUrl));
          return;
        }
        if (pathname === "/api/devices" && req.method === "PATCH") {
          if (currentDevice(req, parsedUrl) !== "local") throw new DeviceConnectionError("请在主脑设备上管理互联开关。", 403);
          const body = await readJsonBody(req) as { enabled?: unknown; force?: unknown };
          if (typeof body?.enabled !== "boolean") throw new DeviceConnectionError("互联开关状态无效。");
          await setInterconnectionFromHttp(res, body.enabled, body.force === true);
          sendJson(res, 200, deviceView(req, parsedUrl));
          return;
        }
        if (pathname === "/api/devices/chat-invitations" && req.method === "POST") {
          if (!hasLocalDeviceControl(req, parsedUrl)) {
            throw new DeviceConnectionError("请在主机上的 Kulo 复制接入指令。", 403);
          }
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
          return;
        }
        if (pathname === "/api/devices/role-transition" && req.method === "GET") {
          if (!hasLocalDeviceControl(req, parsedUrl)) throw new DeviceConnectionError("请在本机查看角色切换。", 403);
          const transition = roleTransitions.lookup(parsedUrl.searchParams.get("id") ?? "");
          if (!transition) throw new DeviceConnectionError("未找到这次运行模式切换。", 404);
          sendJson(res, 200, transition);
          return;
        }
        if (pathname === "/api/devices/join" && req.method === "POST") {
          if (!hasLocalDeviceControl(req, parsedUrl)) throw new DeviceConnectionError("请在本地客户端执行主机接入操作。", 403);
          const body = await readJsonBody(req) as { input?: unknown; token?: unknown; force?: unknown; rootDir?: unknown };
          if (typeof body?.input !== "string" || !body.input.trim()) throw new DeviceConnectionError("请粘贴设备接入命令或输入主机地址。");
          let parsed: DeviceChatInvitation;
          try {
            parsed = parseDeviceJoinInput(body.input, typeof body.token === "string" ? body.token : undefined);
          } catch (error) {
            throw new DeviceConnectionError(error instanceof Error ? error.message : "无效的设备接入命令。", 400);
          }
          const id = req.headers["x-kulo-transition-id"];
          if (body.rootDir !== undefined && (typeof body.rootDir !== "string" || !body.rootDir.trim() || body.rootDir.length > 4096 || body.rootDir.includes("\0"))) throw new DeviceConnectionError("设备工作目录无效。", 400);
          const change = await prepareJoinPeer(parsed, body.force === true, typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : undefined, body.rootDir as string | undefined);
          res.shouldKeepAlive = false;
          res.setHeader("Connection", "close");
          res.once("finish", change.start);
          res.once("close", change.start);
          if (res.destroyed) change.start();
          else sendJson(res, 202, change.receipt);
          return;
        }
        if (pathname === "/api/devices/invitations" && req.method === "POST") {
          const body = await readJsonBody(req) as { name?: unknown; hubUrl?: unknown };
          if (!body || typeof body !== "object") throw new DeviceConnectionError("添加设备请求无效。");
          sendJson(res, 201, devices.createInvitation({ name: body.name, hubUrl: body.hubUrl }).invitation);
          return;
        }
        if (pathname.startsWith("/api/devices/invitations/") && req.method === "DELETE") {
          devices.cancelInvitation(decodeURIComponent(pathname.slice("/api/devices/invitations/".length)));
          sendJson(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/devices/ssh/scan" && req.method === "POST") {
          if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
          sendJson(res, 200, await sshDevices.scan(await readJsonBody(req) as never));
          return;
        }
        if (pathname === "/api/devices/ssh" && req.method === "POST") {
          if (!devices.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
          const body = await readJsonBody(req) as { scanId?: unknown };
          if (typeof body?.scanId !== "string") throw new DeviceConnectionError("请选择已验证指纹的 SSH 设备。");
          const record = await sshDevices.add(body.scanId);
          devices.recordSsh(record);
          sendJson(res, 201, deviceView(req, parsedUrl).devices.find((d) => d.id === record.deviceId));
          return;
        }
        if (/^\/api\/devices\/[^/]+$/.test(pathname)) {
          const id = decodeURIComponent(pathname.slice("/api/devices/".length));
          if (req.method === "PATCH") {
            const body = await readJsonBody(req) as { name?: unknown };
            devices.rename(id, body?.name);
            sendJson(res, 200, deviceView(req, parsedUrl));
            return;
          }
          if (req.method === "DELETE") {
            await performRemoveDevice(id, parsedUrl.searchParams.get("force") === "true");
            sendJson(res, 200, { ok: true });
            return;
          }
        }

        if (pathname === "/api/conversations/search" && req.method === "GET") {
          res.setHeader("cache-control", "no-store");
          sendJson(res, 200, await conversationQueryContext(req, res, (context) => hub.searchConversations({ query: parsedUrl.searchParams.get("q") ?? "",
            ...(parsedUrl.searchParams.has("topicId") ? { topicId: parsedUrl.searchParams.get("topicId")! } : {}),
            ...(parsedUrl.searchParams.has("cursor") ? { cursor: parsedUrl.searchParams.get("cursor")! } : {}),
            ...(parsedUrl.searchParams.has("limit") ? { limit: Number(parsedUrl.searchParams.get("limit")) } : {}),
          }, context)));
          return;
        }
        const messageWindowRoute = /^\/api\/topics\/([^/]+)\/messages\/([^/]+)$/.exec(pathname);
        if (messageWindowRoute && req.method === "GET") {
          res.setHeader("cache-control", "no-store");
          const topicId = decodeConversationTopicId(messageWindowRoute[1]!);
          sendJson(res, 200, await conversationQueryContext(req, res, (context) => hub.getTopicMessageWindow(topicId, Number(messageWindowRoute[2]), context)));
          return;
        }
        const conversationFilesRoute = /^\/api\/topics\/([^/]+)\/files$/.exec(pathname);
        if (conversationFilesRoute && req.method === "GET") {
          res.setHeader("cache-control", "no-store");
          const topicId = decodeConversationTopicId(conversationFilesRoute[1]!);
          sendJson(res, 200, await conversationQueryContext(req, res, (context) => hub.listTopicFiles(topicId, {
            ...(parsedUrl.searchParams.has("cursor") ? { cursor: parsedUrl.searchParams.get("cursor")! } : {}),
            ...(parsedUrl.searchParams.has("limit") ? { limit: Number(parsedUrl.searchParams.get("limit")) } : {}),
          }, context)));
          return;
        }
        const historyRoute = /^\/api\/topics\/([^/]+)\/messages$/.exec(pathname);
        if (historyRoute && req.method === "GET") {
          sendJson(res, 200, await hub.getTopicHistory(decodeURIComponent(historyRoute[1]!), Number(parsedUrl.searchParams.get("before"))));
          return;
        }

        if (pathname === "/api/capabilities" && req.method === "GET") {
          sendJson(res, 200, await hub.getCapabilitiesSnapshot(parsedUrl.searchParams.get("clientId") ?? undefined));
          return;
        }
        if (pathname === "/api/capabilities/computer-use" && req.method === "PUT") {
          const body = await readJsonObject(req);
          const allowed = ["browserEnabled", "desktopEnabled", "expectedRevision", "commandId"];
          if (Object.keys(body).some((key) => !allowed.includes(key))
            || typeof body.browserEnabled !== "boolean"
            || typeof body.desktopEnabled !== "boolean"
            || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
            || typeof body.commandId !== "string") {
            throw new CapabilityError(400, "invalid_computer_use", "电脑操控开关参数无效。");
          }
          res.setHeader("cache-control", "no-store");
          sendJson(res, 200, await hub.configureComputerUse({
            browserEnabled: body.browserEnabled,
            desktopEnabled: body.desktopEnabled,
            expectedRevision: body.expectedRevision as number,
            commandId: body.commandId,
          }));
          return;
        }
        if (await handleImageConfigurationHttp(hub, req, res, parsedUrl, readJsonObject, sendJson)) return;
        if (await handleModelConfigurationHttp(hub.modelConfiguration, req, res, parsedUrl, readJsonObject, sendJson)) return;
        if (pathname === "/api/skills" && req.method === "GET") {
          res.setHeader("cache-control", "no-store");
          sendJson(res, 200, await hub.skills.snapshot());
          return;
        }
        const skillRoute = /^\/api\/skills\/([^/]+)$/.exec(pathname);
        if (skillRoute && (req.method === "PATCH" || req.method === "DELETE")) {
          const body = await readJsonObject(req);
          const editing = req.method === "PATCH";
          const allowed = editing ? ["enabled", "audiences", "expectedRevision", "commandId"] : ["expectedRevision", "commandId"];
          if (Object.keys(body).some((key) => !allowed.includes(key)) ||
              !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 ||
              typeof body.commandId !== "string" || editing && typeof body.enabled !== "boolean") {
            throw new SkillError(400, "invalid_skill_request", "技能操作参数无效。");
          }
          let id: string;
          try { id = decodeURIComponent(skillRoute[1]!); }
          catch { throw new SkillError(400, "invalid_skill_request", "技能标识无效。"); }
          if (!id || id.length > 256 || /[\x00-\x1f\x7f/\\]/.test(id)) throw new SkillError(400, "invalid_skill_request", "技能标识无效。");
          const snapshot = await hub.skills.manage({ id, action: editing ? body.enabled ? "enable" : "disable" : "remove",
            expectedRevision: body.expectedRevision as number, commandId: body.commandId,
            ...(editing && body.audiences !== undefined ? { audiences: body.audiences as never } : {}) });
          res.setHeader("cache-control", "no-store");
          sendJson(res, 200, snapshot);
          return;
        }
        if (pathname === "/api/extensions" && req.method === "GET") {
          sendJson(res, 200, await hub.extensions.snapshot(parsedUrl.searchParams.get("clientId") ?? undefined));
          return;
        }
        const extensionOperationRoute = /^\/api\/extensions\/([^/]+)\/operations$/.exec(pathname);
        if (extensionOperationRoute && req.method === "POST") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !["operation", "expectedRevision", "commandId", "clientId"].includes(key))) {
            sendJson(res, 400, { error: "扩展操作参数无效。" });
            return;
          }
          sendJson(res, 200, await hub.extensions.request({ ...body, id: decodeURIComponent(extensionOperationRoute[1]!) } as unknown as ExtensionOperationRequest));
          return;
        }
        if (pathname === "/api/search" && req.method === "GET") {
          sendJson(res, 200, await hub.search.snapshot());
          return;
        }
        if (pathname === "/api/search/plans" && req.method === "POST") {
          const body = await readJsonObject(req);
          const apiKey = body.apiKey;
          if (typeof apiKey === "string" && [authToken, ...Object.values(hub.config.envTokens ?? {})].some((token) => token && token === apiKey.trim())) {
            throw new ProjectError(400, "invalid_search_credential", "搜索服务需要独立的 API Key。");
          }
          await hub.search.configure(body as never);
          sendJson(res, 200, await hub.search.snapshot());
          return;
        }
        if (pathname === "/api/search/order" && req.method === "PATCH") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !["ids", "expectedRevision"].includes(key)) || !Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
            throw new ProjectError(400, "invalid_search_order", "搜索方案排序无效。");
          }
          sendJson(res, 200, await hub.search.reorder(body.ids as string[], body.expectedRevision as number));
          return;
        }
        const searchPlanRoute = /^\/api\/search\/plans\/([^/]+)(\/test)?$/.exec(pathname);
        if (searchPlanRoute && req.method === "DELETE" && !searchPlanRoute[2]) {
          await hub.search.remove(decodeURIComponent(searchPlanRoute[1]!), Number(parsedUrl.searchParams.get("expectedRevision")));
          sendJson(res, 200, await hub.search.snapshot());
          return;
        }
        if (searchPlanRoute?.[2] && req.method === "POST") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => key !== "expectedRevision")) throw new ProjectError(400, "invalid_search_test", "搜索测试参数无效。");
          const controller = new AbortController();
          const onClose = () => { if (!res.writableEnded) controller.abort(); };
          res.once("close", onClose);
          try {
            const result = await hub.search.test(decodeURIComponent(searchPlanRoute[1]!), body.expectedRevision as number, controller.signal);
            if (!res.destroyed) sendJson(res, 200, { snapshot: await hub.search.snapshot(), result });
          } finally { res.off("close", onClose); }
          return;
        }
        const capabilityInput = /^\/api\/capabilities\/inputs\/([^/]+)(\/browser)?$/.exec(pathname);
        if (capabilityInput && req.method === "POST") {
          const body = await readJsonObject(req);
          if (typeof body.clientId !== "string" || !body.clientId.trim() || body.clientId.length > 120 ||
            (body.secret !== undefined && typeof body.secret !== "string") || (body.cancel !== undefined && typeof body.cancel !== "boolean") ||
            Object.keys(body).some((key) => !["clientId", "secret", "cancel"].includes(key))) throw new ProjectError(400, "invalid_capability_input", "配置输入无效。");
          if (capabilityInput[2] && body.secret !== undefined) throw new ProjectError(400, "invalid_capability_input", "浏览器登录不接受密钥。");
          await hub.capabilities.submitInput(decodeURIComponent(capabilityInput[1]!), body.clientId, {
            ...(typeof body.secret === "string" ? { secret: body.secret } : {}), ...(typeof body.cancel === "boolean" ? { cancel: body.cancel } : {}),
          });
          sendJson(res, 200, await hub.getCapabilitiesSnapshot(body.clientId));
          return;
        }

        if (pathname === "/api/projects/directories" && req.method === "GET") {
          const deviceId = parsedUrl.searchParams.get("deviceId")?.trim();
          if (!deviceId) throw new ProjectError(400, "invalid_device", "请选择设备。");
          sendJson(res, 200, await hub.envManager.listProjectDirectories(deviceId, parsedUrl.searchParams.get("path") ?? undefined));
          return;
        }
        if (pathname === "/api/projects" && req.method === "GET") {
          sendJson(res, 200, { projects: await hub.projects.list() });
          return;
        }
        if (pathname === "/api/projects" && req.method === "POST") {
          const body = await readJsonObject(req);
          if (typeof body.name !== "string" || typeof body.deviceId !== "string" || typeof body.workspaceDir !== "string" ||
            (body.commandId !== undefined && typeof body.commandId !== "string") ||
            (body.createDirectory !== undefined && typeof body.createDirectory !== "boolean")) {
            throw new ProjectError(400, "invalid_project", "项目名称、设备和目录无效。");
          }
          const project = await hub.projects.create({ name: body.name, deviceId: body.deviceId, workspaceDir: body.workspaceDir,
            commandId: body.commandId as string | undefined ?? randomUUID(), createDirectory: body.createDirectory as boolean | undefined });
          sendJson(res, 201, { project });
          return;
        }
        const projectRoute = /^\/api\/projects\/([^/]+)$/.exec(pathname);
        if (projectRoute && req.method === "PATCH") {
          const body = await readJsonObject(req);
          if (body.deviceId !== undefined || body.workspaceDir !== undefined) throw new ProjectError(400, "project_binding_tool_required", "请通过 Kulo 重新关联项目目录。");
          if ((body.name !== undefined && typeof body.name !== "string") || (body.notes !== undefined && typeof body.notes !== "string") ||
            (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1))) {
            throw new ProjectError(400, "invalid_project", "项目修改参数无效。");
          }
          const project = await hub.projects.patch(decodeURIComponent(projectRoute[1]!), {
            name: body.name as string | undefined, notes: body.notes as string | undefined, expectedRevision: body.expectedRevision as number | undefined,
          });
          sendJson(res, 200, { project });
          return;
        }
        if (projectRoute && req.method === "DELETE") {
          const body = await readJsonObject(req) as { stopTasks?: boolean };
          if (body.stopTasks !== undefined && typeof body.stopTasks !== "boolean") throw new ProjectError(400, "invalid_project", "删除参数无效。");
          sendJson(res, 200, await hub.projects.remove(decodeURIComponent(projectRoute[1]!), { stopTasks: body.stopTasks }));
          return;
        }

        // Topics API
        if (req.method === "GET" && pathname === "/api/topics") {
          sendJson(res, 200, { items: await hub.listTopics() });
          return;
        }

        if (req.method === "POST" && pathname === "/api/topics") {
          const body = (await readJsonObject(req)) as { title?: string; projectId?: string | null };
          if (body.title !== undefined && typeof body.title !== "string") throw new ProjectError(400, "invalid_topic", "会话名称无效。");
          if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== "string") throw new ProjectError(400, "invalid_project", "项目无效。");
          const topic = await hub.createTopic(body.title, undefined, body.projectId);
          sendJson(res, 200, topic);
          return;
        }

        if (
          req.method === "POST" &&
          pathname.startsWith("/api/topics/") &&
          pathname.endsWith("/retry")
        ) {
          const topicId = decodeURIComponent(
            pathname.slice("/api/topics/".length, -"/retry".length),
          );
          const out = await hub.retryTurn(topicId, `retry:${Date.now()}`);
          sendJson(res, 200, out);
          return;
        }

        if (req.method === "PATCH" && pathname.startsWith("/api/topics/")) {
          const id = decodeURIComponent(pathname.slice("/api/topics/".length));
          const body = (await readJsonBody(req)) as {
            title?: string;
            pinned?: boolean;
            archived?: boolean;
          };
          const updated = await hub.patchTopic(id, body);
          sendJson(res, 200, updated);
          return;
        }

        if (req.method === "DELETE" && pathname.startsWith("/api/topics/")) {
          const id = decodeURIComponent(pathname.slice("/api/topics/".length));
          const body = await readJsonObject(req) as { stopTasks?: boolean };
          if (body.stopTasks !== undefined && typeof body.stopTasks !== "boolean") throw new ProjectError(400, "invalid_project", "删除参数无效。");
          const result = await hub.deleteTopic(id, undefined, { stopTasks: body.stopTasks });
          sendJson(res, 200, result);
          return;
        }

        // Usage Stats API
        if (req.method === "GET" && pathname === "/api/usage") {
          const rawRange = parsedUrl.searchParams.get("range");
          const range =
            rawRange === "7" || rawRange === "30" ? rawRange : "today";
          sendJson(res, 200, await hub.computeUsageStats(range));
          return;
        }

        if (req.method === "GET" && pathname === "/api/scheduled-tasks") {
          sendJson(res, 200, { tasks: await hub.listScheduledTasks() });
          return;
        }
        const scheduleRoute = /^\/api\/scheduled-tasks\/([^/]+)(\/stop)?$/.exec(pathname);
        if (scheduleRoute) {
          const id = decodeURIComponent(scheduleRoute[1]!);
          if (req.method === "POST" && scheduleRoute[2]) {
            sendJson(res, 200, { task: await hub.stopScheduledTask(id) });
            return;
          }
          if (req.method === "DELETE" && !scheduleRoute[2]) {
            await hub.deleteScheduledTask(id);
            sendJson(res, 200, { ok: true });
            return;
          }
        }

        const deliverableRoute = /^\/api\/tickets\/([^/]+)\/deliverables(?:\/([^/]+))?$/.exec(pathname);
        if (req.method === "GET" && deliverableRoute) {
          const ticketId = decodeURIComponent(deliverableRoute[1]!);
          res.setHeader("cache-control", "no-store");
          const controller = new AbortController();
          const abort = () => controller.abort();
          req.once("aborted", abort); res.once("close", abort);
          const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
          try {
            if (!deliverableRoute[2]) {
              sendJson(res, 200, await hub.listTicketDeliverables(ticketId, context));
            } else {
              const { file, bytes } = await hub.readTicketDeliverable(ticketId, decodeURIComponent(deliverableRoute[2]), context);
              res.writeHead(200, {
                "content-type": file.mimeType,
                "content-length": bytes.byteLength,
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
                "x-content-type-options": "nosniff",
                "content-security-policy": "default-src 'none'; sandbox",
              });
              res.end(bytes);
            }
          } finally {
            req.off("aborted", abort); res.off("close", abort);
          }
          return;
        }

        // Ticket Retry API
        if (
          req.method === "POST" &&
          pathname.startsWith("/api/tickets/") &&
          pathname.endsWith("/retry")
        ) {
          const ticketId = decodeURIComponent(
            pathname.slice("/api/tickets/".length, -"/retry".length),
          );
          const card = await hub.retryTicket(ticketId);
          sendJson(res, 200, { ticket: card });
          return;
        }

        // Settings API
        if (req.method === "GET" && pathname === "/api/settings") {
          sendJson(res, 200, hub.getSettingsView());
          return;
        }

        if (req.method === "POST" && pathname.startsWith("/api/external-clients/") && pathname.endsWith("/refresh")) {
          const encoded = pathname.slice("/api/external-clients/".length, -"/refresh".length);
          if (!encoded || encoded.includes("/")) {
            sendJson(res, 404, { error: "Invalid external client path" });
            return;
          }
          const out = await hub.refreshExternalClientModels(decodeURIComponent(encoded));
          sendJson(res, 200, out);
          return;
        }

        if (req.method === "DELETE" && pathname.startsWith("/api/external-clients/")) {
          const encoded = pathname.slice("/api/external-clients/".length);
          if (!encoded || encoded.includes("/")) {
            sendJson(res, 404, { error: "Invalid external client path" });
            return;
          }
          const expectedRaw = parsedUrl.searchParams.get("expectedRevision");
          const expectedRevision = expectedRaw !== null && expectedRaw !== "" ? Number(expectedRaw) : undefined;
          const out = await hub.removeExternalClient(
            decodeURIComponent(encoded),
            Number.isSafeInteger(expectedRevision) ? expectedRevision : undefined,
          );
          sendJson(res, 200, out);
          return;
        }

        if (req.method === "POST" && pathname === "/api/settings/rollback") {
          const body = (await readJsonBody(req)) as {
            toRevision?: number;
            expectedGlobalRevision?: number;
          };
          const out = await hub.rollbackSettings(
            Number(body.toRevision),
            Number(body.expectedGlobalRevision),
          );
          sendJson(res, 200, out);
          return;
        }

        if (req.method === "POST" && pathname.startsWith("/api/settings/")) {
          const block = pathname.slice("/api/settings/".length) as SettingsBlockName;
          if (!VALID_BLOCKS.includes(block)) {
            sendJson(res, 404, { error: `Unknown settings block '${block}'` });
            return;
          }
          const body = (await readJsonBody(req)) as {
            expectedRevision?: number;
            value?: unknown;
          };
          const out = await hub.updateSettingsBlock(
            block,
            Number(body.expectedRevision),
            body.value,
          );
          sendJson(res, 200, out);
          return;
        }

        // Identity & Relationship API
        if (req.method === "GET" && pathname === "/api/personality") {
          sendJson(res, 200, await hub.personality.snapshot());
          return;
        }
        if (req.method === "POST" && pathname === "/api/personality/settings") {
          const body = await readJsonObject(req);
          sendJson(res, 200, await hub.personality.updateSettings(Number(body.expectedRevision), body));
          return;
        }
        if (req.method === "GET" && pathname === "/api/personality/identity") {
          const language = normalizeKuloLanguage(parsedUrl.searchParams.get("lang"));
          sendJson(res, 200, await hub.personality.readIdentity(language ? { language } : undefined));
          return;
        }
        if (req.method === "GET" && pathname === "/api/personality/identity/preset") {
          const language =
            normalizeKuloLanguage(parsedUrl.searchParams.get("lang")) ??
            hub.getSettingsView().blocks.presentation.value.language ??
            "en";
          sendJson(res, 200, { content: getIdentityTemplate("identity-agreement.md", language) });
          return;
        }
        if (req.method === "POST" && pathname === "/api/personality/identity/dismiss") {
          const body = await readJsonObject(req);
          if (typeof body.id !== "string") throw new ProjectError(400, "invalid_proposal", "修改建议无效。");
          await hub.personality.dismissIdentityProposal(body.id);
          sendJson(res, 200, await hub.personality.snapshot());
          return;
        }
        if (req.method === "POST" && pathname === "/api/personality/relationship") {
          sendJson(res, 200, await hub.personality.saveRelationship(await readJsonObject(req) as unknown as import("@kulo/protocol").RelationshipWriteRequest));
          return;
        }
        if (req.method === "POST" && pathname === "/api/personality/relationship/rollback") {
          sendJson(res, 200, await hub.personality.rollbackRelationship(await readJsonObject(req) as unknown as import("@kulo/protocol").RelationshipRollbackRequest));
          return;
        }
        if (req.method === "GET" && pathname === "/api/personality/recent-work") {
          sendJson(res, 200, await hub.getRecentWork(parsedUrl.searchParams.get("topicId") ?? undefined));
          return;
        }
        if (req.method === "POST" && pathname === "/api/personality/recent-work/refresh") {
          const body = await readJsonObject(req);
          if (body.topicId !== undefined && typeof body.topicId !== "string") throw new ProjectError(400, "invalid_topic", "会话无效。");
          sendJson(res, 200, await hub.getRecentWork(body.topicId as string | undefined));
          return;
        }
        if (req.method === "GET" && pathname === "/api/identity/files") {
          sendJson(res, 200, await hub.identityFiles.list());
          return;
        }

        if (req.method === "GET" && pathname === "/api/identity/file") {
          const file = parsedUrl.searchParams.get("file") as IdentityFile | null;
          const language = normalizeKuloLanguage(parsedUrl.searchParams.get("lang"));
          sendJson(res, 200, await hub.identityFiles.read(file, language ? { language } : undefined));
          return;
        }

        if (req.method === "GET" && pathname === "/api/identity/backup") {
          const file = parsedUrl.searchParams.get("file");
          const backupId = parsedUrl.searchParams.get("backupId");
          sendJson(res, 200, await hub.identityFiles.readBackup(file, backupId));
          return;
        }

        if (req.method === "POST" && pathname === "/api/identity/save") {
          const body = await readJsonBody(req);
          sendJson(res, 200, await hub.identityFiles.save(body));
          return;
        }

        if (req.method === "POST" && pathname === "/api/identity/rollback") {
          const body = await readJsonBody(req);
          sendJson(res, 200, await hub.identityFiles.rollback(body));
          return;
        }

        if (pathname === "/api/memory/service" && req.method === "GET") {
          sendJson(res, 200, await hub.memoryService.snapshot(parsedUrl.searchParams.get("clientId") ?? undefined));
          return;
        }
        if (pathname === "/api/memory/service/prepare" && req.method === "POST") {
          const body = await readJsonObject(req);
          sendJson(res, 200, await hub.memoryService.prepare(body as unknown as import("@kulo/protocol").MemoryServicePrepareRequest));
          return;
        }
        if (pathname === "/api/memory/service/connection" && req.method === "POST") {
          const body = await readJsonObject(req);
          sendJson(res, 200, await hub.memoryService.updateConnection(body as unknown as import("@kulo/protocol").MemoryConnectionUpdateRequest));
          return;
        }
        if (pathname === "/api/memory/service/connection/probe" && req.method === "POST") {
          const body = await readJsonObject(req);
          sendJson(res, 200, await hub.memoryService.updateConnection(body as unknown as import("@kulo/protocol").MemoryConnectionUpdateRequest, true));
          return;
        }
        if (pathname === "/api/memory/service/enabled" && req.method === "POST") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !["enabled", "expectedRevision"].includes(key))) throw new MemoryServiceError(400, "invalid_memory_request", "启用设置字段无效。");
          sendJson(res, 200, await hub.memoryService.setEnabled(body.enabled as boolean, body.expectedRevision as number));
          return;
        }
        if (pathname === "/api/memory/service/knowledge-guidance" && req.method === "POST") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !["enabled", "expectedRevision"].includes(key))) throw new MemoryServiceError(400, "invalid_memory_request", "知识整理指引字段无效。");
          sendJson(res, 200, await hub.memoryService.setKnowledgeGuidanceEnabled(body.enabled as boolean, body.expectedRevision as number));
          return;
        }
        const memoryInput = pathname.match(/^\/api\/memory\/service\/inputs\/([^/]+)$/);
        if (memoryInput && req.method === "POST") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !["clientId", "secret", "cancel"].includes(key))) throw new MemoryServiceError(400, "invalid_memory_input", "保密输入字段无效。");
          sendJson(res, 200, await hub.memoryService.submitInput(decodeURIComponent(memoryInput[1]!), body.clientId as string, { secret: body.secret as string | undefined, cancel: body.cancel as boolean | undefined }));
          return;
        }
        const memoryDecision = pathname.match(/^\/api\/memory\/service\/jobs\/([^/]+)\/decision$/);
        if (memoryDecision && req.method === "POST") {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !["clientId", "decision"].includes(key))) throw new MemoryServiceError(400, "invalid_memory_decision", "确认字段无效。");
          sendJson(res, 200, await hub.memoryService.decide(decodeURIComponent(memoryDecision[1]!), body.clientId as string, body.decision as "confirm" | "reject"));
          return;
        }
        if (req.method === "POST" && pathname === "/api/memory/probe") {
          const result = await hub.probeMemory();
          sendJson(res, 200, result);
          return;
        }

        if (req.method === "POST" && pathname === "/api/model/probe") {
          const body = (await readJsonBody(req)) as ModelProbeRequest;
          const result = await hub.probeModel(body);
          sendJson(res, 200, result);
          return;
        }

        // Providers & OAuth API
        if (req.method === "GET" && pathname === "/api/providers") {
          sendJson(res, 200, {
            providers: await hub.listProviders(),
            presets: MAINSTREAM_PROVIDER_PRESETS.map(({ id, name, api, baseUrl }) => ({ id, name, api, baseUrl })),
          });
          return;
        }

        if (req.method === "POST" && pathname === "/api/providers/discover-models") {
          const body = (await readJsonBody(req)) as Partial<DiscoverModelsRequest>;
          const api = body.api;
          if (
            typeof api !== "string" ||
            !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)
          ) {
            sendJson(res, 400, { error: "无效的 API 协议类型" });
            return;
          }
          const vertex = api === "google-vertex"
            ? { vertexProject: body.vertexProject, vertexLocation: body.vertexLocation } : undefined;
          const result = await hub.discoverProviderModels({
            ...(typeof body.providerId === "string" && body.providerId.trim()
              ? { providerId: body.providerId.trim() }
              : {}),
            ...(typeof body.preset === "string" && body.preset.trim()
              ? { preset: body.preset.trim() }
              : {}),
            api: api as CustomProviderApi,
            ...vertex,
            ...(typeof body.baseUrl === "string" && body.baseUrl.trim()
              ? { baseUrl: body.baseUrl.trim() }
              : {}),
            ...(typeof body.apiKey === "string" && body.apiKey.trim()
              ? { apiKey: body.apiKey.trim() }
              : {}),
            ...(body.refreshMetadata === true ? { refreshMetadata: true } : {}),
          });
          sendJson(res, 200, result);
          return;
        }

        if (req.method === "POST" && pathname === "/api/providers/resolve-model") {
          const body = (await readJsonBody(req)) as Partial<import("@kulo/protocol").ResolveModelMetadataRequest>;
          const api = body.api;
          const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
          if (!modelId) {
            sendJson(res, 400, { error: "请填写模型 ID" });
            return;
          }
          if (
            typeof api !== "string" ||
            !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)
          ) {
            sendJson(res, 400, { error: "无效的 API 协议类型" });
            return;
          }
          const result = await hub.resolveModelMetadata({
            modelId,
            api: api as CustomProviderApi,
            ...(typeof body.providerId === "string" && body.providerId.trim()
              ? { providerId: body.providerId.trim() }
              : {}),
            ...(typeof body.preset === "string" && body.preset.trim()
              ? { preset: body.preset.trim() }
              : {}),
            ...(typeof body.baseUrl === "string" && body.baseUrl.trim()
              ? { baseUrl: body.baseUrl.trim() }
              : {}),
            ...(body.refreshMetadata === true ? { refreshMetadata: true } : {}),
          });
          sendJson(res, 200, result);
          return;
        }

        if (pathname.startsWith("/api/providers/oauth/")) {
          const rest = pathname.slice("/api/providers/oauth/".length);
          if (req.method === "GET" && !rest.includes("/")) {
            const sessionId = decodeURIComponent(rest);
            const session = hub.getProviderOAuth(sessionId);
            if (!session) {
              sendJson(res, 404, { error: "OAuth session not found" });
              return;
            }
            sendJson(res, 200, { session });
            return;
          }
          if (req.method === "POST" && rest.endsWith("/respond")) {
            const sessionId = decodeURIComponent(rest.slice(0, -"/respond".length));
            const body = (await readJsonBody(req)) as {
              promptId?: unknown;
              value?: unknown;
            };
            const session = await hub.respondProviderOAuth(
              sessionId,
              typeof body.promptId === "string" ? body.promptId : undefined,
              typeof body.value === "string" ? body.value : String(body.value ?? ""),
            );
            sendJson(res, 200, { session });
            return;
          }
          if (req.method === "POST" && rest.endsWith("/cancel")) {
            const sessionId = decodeURIComponent(rest.slice(0, -"/cancel".length));
            const session = hub.cancelProviderOAuth(sessionId);
            if (!session) {
              sendJson(res, 404, { error: "OAuth session not found" });
              return;
            }
            sendJson(res, 200, { session });
            return;
          }
        }

        if (pathname.startsWith("/api/providers/")) {
          const rest = pathname.slice("/api/providers/".length);
          if (req.method === "POST" && rest.endsWith("/api-key")) {
            const id = decodeURIComponent(rest.slice(0, -"/api-key".length));
            const body = (await readJsonBody(req)) as { apiKey?: unknown };
            const provider = await hub.setProviderApiKey(
              id,
              typeof body.apiKey === "string" ? body.apiKey : "",
            );
            sendJson(res, 200, { provider });
            return;
          }
          if (req.method === "DELETE" && rest.endsWith("/auth")) {
            const id = decodeURIComponent(rest.slice(0, -"/auth".length));
            const provider = await hub.logoutProvider(id);
            sendJson(res, 200, { ok: true, provider });
            return;
          }
          if (req.method === "POST" && rest.endsWith("/refresh")) {
            const id = decodeURIComponent(rest.slice(0, -"/refresh".length));
            const provider = await hub.refreshProviderModels(id);
            sendJson(res, 200, { provider });
            return;
          }
          if (req.method === "POST" && rest.endsWith("/oauth/start")) {
            const id = decodeURIComponent(rest.slice(0, -"/oauth/start".length));
            const session = await hub.startProviderOAuth(id);
            sendJson(res, 200, { session });
            return;
          }
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
      if (err instanceof DeviceConnectionError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof IdentityFilesError || err instanceof PersonalityError || err instanceof MemoryServiceError || err instanceof ExtensionError || err instanceof ExtensionPackageError || err instanceof VoiceError || err instanceof VoiceCallsError || err instanceof SkillError || err instanceof CapabilityError || err instanceof ConversationQueryError) {
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
  const httpServer = http.createServer(handleHttp);

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
          isPrincipalActive: () => principal === "local" || (devices.enabled && devices.view(actualPort, `http://localhost:${actualPort}`).devices.some((device) => device.id === principal)),
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
      try {
        httpServer.once("close", hub.localInstance.publish(bound));
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
  if (devices.enabled) void sshDevices.restore(devices.sshRecords).catch((error: unknown) => {
    console.error("恢复 SSH 设备失败:", error instanceof Error ? error.message : String(error));
  });

  return {
    get host() { return host; },
    port: actualPort,
    url: advertised.origin,
    localUrl: localListenerOrigin(addr),
    clientWsUrl: `ws://${advertised.host}/ws/client`,
    envWsUrl: `ws://${advertised.host}/ws/env`,
    close: async () => {
      closing = true;
      hub.bindDeviceController(undefined);
      await mobileConnector.close();
      mediaHttp.close();
      await listenerTransition;
      sshDevices.close();
      unsubscribeHub();
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
