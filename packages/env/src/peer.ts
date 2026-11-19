import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { parseDeviceJoinInput, type DeviceChatInvitation, type DeviceInterconnectionView, type DevicePeerConfig } from "@moco/protocol";
import { DeviceRoleTransitions, type PreparedDeviceRoleChange } from "./device-role-transitions.js";
import { LocalInstanceOwner } from "./local-instance.js";
import { claimDevicePeer } from "./peer-runtime-owner.js";
import { authenticatedPeerHub, deviceHostUnreachable, getPeerConfigPath, invalidDeviceInvitation, readPeerConfig, validatePeerConfig } from "./peer-config.js";
export { getPeerConfigPath, readPeerConfig, savePeerConfig, removePeerConfig, installDevicePeer, normalizePeerHubUrl } from "./peer-config.js";
import { MocoEnvAgent } from "./agent.js";
import { collectDeviceSystemInfo } from "./device-info.js";

const STATIC_MIME_BY_EXT: Record<string, string> = {
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
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export interface DevicePeerRuntime {
  url: string;
  port: number;
  /** Initial Env registration and authenticated access to the shared conversation API. */
  ready: Promise<void>;
  close(): Promise<void>;
}

function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readPeerJoin(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > 256 * 1024) throw Object.assign(new Error("接入请求过长。"), { status: 413 });
    chunks.push(data);
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
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

function startAfterResponse(response: http.ServerResponse, change: PreparedDeviceRoleChange): void {
  response.shouldKeepAlive = false;
  response.once("finish", change.start);
  response.once("close", change.start);
  if (response.destroyed) { void change.start(); return; }
  response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(change.receipt));
}

function requestHeaders(headers: http.IncomingHttpHeaders, hub: URL, token: string): http.OutgoingHttpHeaders {
  const forwarded = { ...headers };
  for (const name of ["authorization", "cookie", "proxy-authorization", "proxy-connection", "x-forwarded-host", "x-forwarded-proto"]) {
    delete forwarded[name];
  }
  forwarded.host = hub.host;
  forwarded.authorization = `Bearer ${token}`;
  if (forwarded.origin) forwarded.origin = hub.origin;
  return forwarded;
}

function tryServeLocalWebAsset(webDistDir: string | undefined, pathname: string, method: string | undefined, response: http.ServerResponse): boolean {
  if (!webDistDir || (method !== "GET" && method !== "HEAD") || !fs.existsSync(webDistDir)) return false;
  const canonicalRoot = fs.realpathSync(webDistDir);
  const indexHtmlPath = path.join(canonicalRoot, "index.html");
  if (!fs.existsSync(indexHtmlPath)) return false;
  const relativeReq = pathname === "/"
    ? "index.html"
    : pathname === "/favicon.ico" && !fs.existsSync(path.join(canonicalRoot, "favicon.ico"))
      ? "favicon-32.png"
      : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(canonicalRoot, relativeReq);
  const rel = path.relative(canonicalRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let fileToServe = candidate;
  if (!fs.existsSync(fileToServe) || !fs.statSync(fileToServe).isFile()) {
    if (!path.extname(pathname)) fileToServe = indexHtmlPath;
    else return false;
  }
  const canonicalFile = fs.realpathSync(fileToServe);
  const canonicalRel = path.relative(canonicalRoot, canonicalFile);
  if (canonicalRel.startsWith("..") || path.isAbsolute(canonicalRel)) return false;
  const ext = path.extname(canonicalFile).toLowerCase();
  const stat = fs.statSync(canonicalFile);
  response.writeHead(200, {
    "content-type": STATIC_MIME_BY_EXT[ext] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") {
    response.end();
    return true;
  }
  const stream = fs.createReadStream(canonicalFile);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  });
  response.on("close", () => stream.destroy());
  stream.pipe(response);
  return true;
}

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
  onLog?: (message: string) => void;
}

export async function startDevicePeer(configValue: DevicePeerConfig, options: StartDevicePeerOptions = {}): Promise<DevicePeerRuntime> {
  const config = validatePeerConfig(configValue);
  const resolvedConfigPath = path.resolve(options.configPath ?? getPeerConfigPath());
  const owner = claimDevicePeer(config, resolvedConfigPath);
  try { return await listenDevicePeer(config, resolvedConfigPath, owner, options); }
  catch (error) { owner.close(); throw error; }
}

async function listenDevicePeer(config: DevicePeerConfig, resolvedConfigPath: string, owner: LocalInstanceOwner, options: StartDevicePeerOptions): Promise<DevicePeerRuntime> {
  const roleTransitions = options.roleTransitions ?? new DeviceRoleTransitions({ configPath: resolvedConfigPath, startHub: options.onLeave });
  const canSwitchRole = roleTransitions.canLeave;
  const hub = new URL(config.hubUrl);
  const webSockets = new Set<WebSocket>();
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let port = 0;
  let initiallyReady = false;
  let readinessError: string | undefined;
  let readinessRetry: NodeJS.Timeout | undefined;
  let readinessProbe: Promise<void> | undefined;
  let retryAttempt = 0;
  let closed = false;
  const allowedRequest = (request: http.IncomingMessage): boolean => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host ?? "") || !request.url?.startsWith("/") ||
        request.url.startsWith("//") || request.url.includes("\\")) return false;
    const origin = request.headers.origin;
    if (origin && !hosts.some((host) => origin === `http://${host}`)) return false;
    return request.headers["sec-fetch-site"] !== "cross-site";
  };
  const isAuthorizedLocal = (request: http.IncomingMessage, parsed: URL): boolean => {
    if (!options.authToken) return true;
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    return equalToken(bearer ?? parsed.searchParams.get("token") ?? undefined, options.authToken);
  };
  const isLocalControl = (request: http.IncomingMessage): boolean =>
    !request.headers.forwarded && !request.headers["x-forwarded-for"] && !request.headers["x-real-ip"] &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  const isSameHub = async (input: DeviceChatInvitation): Promise<boolean> => {
    const sameOrigin = input.hubUrl === hub.origin;
    if (!sameOrigin && (!input.hubId || !agent.registered)) return false;
    let identity: Awaited<ReturnType<typeof authenticatedPeerHub>>;
    try { identity = await authenticatedPeerHub(config, sameOrigin ? 8_000 : 2_000); }
    catch (error) {
      // A revoked device can pair again. An offline old Hub must not block joining a different one.
      if (!sameOrigin || (error && typeof error === "object" && "code" in error && error.code === "device_invitation_invalid")) return false;
      throw error;
    }
    if (sameOrigin && input.hubId && input.hubId !== identity.hubId) throw invalidDeviceInvitation();
    if (!sameOrigin && (identity.hubId !== input.hubId || !identity.hubUrls.includes(input.hubUrl))) return false;
    await probeSharedUi().catch(() => { throw deviceHostUnreachable(); });
    if (!agent.registered) throw deviceHostUnreachable();
    return true;
  };
  const upstreamTarget = (request: http.IncomingMessage): URL | null => {
    if (!allowedRequest(request)) return null;
    try {
      const target = new URL(request.url!, hub);
      // WHATWG URL parsing treats backslashes as slashes for HTTP URLs. Credentials may
      // only be attached after both raw-path and parsed-origin validation.
      return target.origin === hub.origin ? target : null;
    } catch {
      return null;
    }
  };
  const offlineJoinedView = (reason: string, local: boolean): DeviceInterconnectionView => ({
    enabled: true,
    role: "joined",
    hubId: hub.origin,
    hubName: hub.host,
    currentDeviceId: config.deviceId,
    currentDeviceKnown: local,
    canSwitchRole: canSwitchRole && local,
    hubError: reason,
    hubUrls: [hub.origin],
    devices: [
      { id: "hub", name: hub.host, kind: "local", status: "offline", rootDir: "" },
      { id: config.deviceId, name: config.name, kind: "reverse-ws", status: "offline", rootDir: config.rootDir, info: collectDeviceSystemInfo() },
    ],
  });
  const server = http.createServer((request, response) => {
    const target = upstreamTarget(request);
    if (!target) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!target.pathname.startsWith("/api/") && !target.pathname.startsWith("/_moco/") && !target.pathname.startsWith("/ws/") && !target.pathname.startsWith("/connect/")) {
      if (tryServeLocalWebAsset(options.webDistDir, target.pathname, request.method, response)) return;
    }
    if (request.method === "GET" && target.pathname === "/_moco/peer-status") {
      if (!isAuthorizedLocal(request, target)) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ deviceId: config.deviceId, hubUrl: config.hubUrl, ready: initiallyReady && agent.registered && !readinessError, error: readinessError, pid: process.pid }));
      return;
    }
    if (request.method === "GET" && target.pathname === "/_moco/instance") {
      const status = { role: "joined" as const, hubUrl: config.hubUrl, ready: initiallyReady && agent.registered && !readinessError, error: readinessError };
      const verified = !closed && (owner.proveLocalIdentity(request, response, options.authToken, status) ||
        options.runtimeOwner?.proveLocalIdentity(request, response, options.authToken, status));
      response.writeHead(verified ? 200 : 403, { "cache-control": "no-store" }).end();
      return;
    }
    if (target.pathname.startsWith("/api/") && !isAuthorizedLocal(request, target)) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (["/api/devices/join", "/api/devices/leave", "/api/devices/role-transition"].includes(target.pathname) && !isLocalControl(request)) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "请在本机操作设备连接。" }));
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
        const header = request.headers["x-moco-transition-id"];
        const change = roleTransitions.leave(config, typeof header === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(header) ? header : undefined);
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
        const header = request.headers["x-moco-transition-id"];
        const id = typeof header === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(header) ? header : undefined;
        const checkTasks = async () => {
          if (!force && agent.hasActiveExecution) throw Object.assign(new Error("本机正在执行任务，切换主机会中断执行。"), { code: "local_tasks_running" });
        };
        const change = roleTransitions.join(input, checkTasks, id, rootDir ?? config.rootDir, { config, isSameHub: () => isSameHub(input) });
        startAfterResponse(response, change);
      })().catch((error: unknown) => {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: status < 500 && error instanceof Error ? error.message : "无法处理设备接入请求。", code }));
      });
      return;
    }
    if (request.method === "GET" && target.pathname === "/api/devices" && (canSwitchRole || Boolean(options.webDistDir))) {
      const local = isLocalControl(request);
      const upstreamUrl = new URL(target.toString());
      upstreamUrl.searchParams.delete("token");
      void (async () => {
        try {
          const upstreamRes = await fetch(upstreamUrl, {
            method: "GET",
            redirect: "error",
            headers: { authorization: `Bearer ${config.clientToken}` },
            signal: AbortSignal.timeout(8_000),
          });
          if (upstreamRes.ok) {
            const data = await upstreamRes.json() as DeviceInterconnectionView;
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ ...data, currentDeviceKnown: local, canSwitchRole: canSwitchRole && local }));
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
          response.end(JSON.stringify(offlineJoinedView(readinessError ?? `无法连接主机 ${hub.origin}，请检查主机是否在线或断开连接恢复独立运行。`, local)));
        }
      })();
      return;
    }
    target.searchParams.delete("token");
    const transport = hub.protocol === "https:" ? https : http;
    const upstream = transport.request(target, {
      method: request.method,
      headers: requestHeaders(request.headers, hub, config.clientToken),
    }, (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers["set-cookie"];
      if (headers.location?.startsWith(hub.origin)) {
        const location = new URL(headers.location);
        if (location.origin === hub.origin) headers.location = `${location.pathname}${location.search}${location.hash}`;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
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
    target.protocol = hub.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.delete("token");
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${config.clientToken}`, origin: hub.origin } });
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
  const envUrl = new URL("/ws/env", hub);
  envUrl.protocol = hub.protocol === "https:" ? "wss:" : "ws:";
  const protectedPaths = Array.from(new Set([
    path.dirname(resolvedConfigPath),
    ...(options.protectedPaths ?? []).map((entry) => path.resolve(entry)),
  ]));
  const agent = new MocoEnvAgent({
    hubUrl: envUrl.toString(),
    envId: config.deviceId,
    name: config.name,
    rootDir: config.rootDir,
    authToken: config.envToken,
    protectedPaths,
    onLog: options.onLog,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? config.localPort ?? 7788, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动本机 Moco 访问入口。");
  port = address.port;
  try {
    server.once("close", owner.publish(address));
    if (options.runtimeOwner) server.once("close", options.runtimeOwner.publish(address));
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const verifySharedUi = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/topics`, {
      redirect: "error",
      headers: options.authToken ? { authorization: `Bearer ${options.authToken}` } : undefined,
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
      // A temporary Hub outage must not permanently poison a saved device connection.
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryAttempt++, 4));
      readinessRetry = setTimeout(() => {
        readinessRetry = undefined;
        void probeSharedUi();
      }, delay);
      readinessRetry.unref();
    });
    return probe;
  };
  const ready = agent.start().then(probeSharedUi);
  ready.catch((error: unknown) => {
    if (!closed) recordReadinessError(error);
  });
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    ready,
    close() {
      closing ??= (async () => {
        closed = true;
        if (readinessRetry) clearTimeout(readinessRetry);
        for (const ws of webSockets) ws.terminate();
        for (const socket of sockets) socket.destroy();
        wss.close();
        const results = await Promise.allSettled([agent.stop(), new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()))]);
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

export function renderPeerInstaller(platform: "posix" | "powershell"): string {
  if (platform === "powershell") {
    return `param([Parameter(Mandatory=$true)][string]$HubUrl, [Parameter(Mandatory=$true)][string]$InviteToken)\n$ErrorActionPreference = 'Stop'\n& node -e "if(process.versions.node.split('.').map(Number)[0]<22||(process.versions.node.startsWith('22.')&&Number(process.versions.node.split('.')[1])<19))process.exit(1)"\nif ($LASTEXITCODE -ne 0) { throw 'Moco requires Node.js 22.19 or newer.' }\n$Runtime = Join-Path $HOME '.moco/runtime'\nNew-Item -ItemType Directory -Force $Runtime | Out-Null\nInvoke-WebRequest -MaximumRedirection 0 -Uri ($HubUrl.TrimEnd('/') + '/connect/peer.mjs') -OutFile (Join-Path $Runtime 'peer.mjs.download')\nMove-Item -Force (Join-Path $Runtime 'peer.mjs.download') (Join-Path $Runtime 'peer.mjs')\n& npm install --prefix $Runtime --omit=dev --ignore-scripts --no-audit --no-fund 'undici@8.12.4' '@anthropic-ai/claude-agent-sdk@0.3.326' '@earendil-works/pi-env@1.5.2' 'ws@8.22.2' 'agent-browser@0.43.0' 'agent-desktop@1.3.1'\nif ($LASTEXITCODE -ne 0) { throw 'Moco runtime dependency installation failed.' }\n& node (Join-Path $Runtime 'peer.mjs') install --hub $HubUrl --invite $InviteToken\nif ($LASTEXITCODE -ne 0) { throw 'Moco device pairing failed.' }\n`;
  }
  return `#!/bin/sh\nset -eu\numask 077\nMOCO_PEER_HUB_URL=\${1:?Missing Hub URL}\nMOCO_PEER_INVITE=\${2:?Missing invitation}\ncommand -v node >/dev/null 2>&1 || { echo 'Moco requires Node.js 22.19 or newer.' >&2; exit 1; }\nnode -e "if(process.versions.node.split('.').map(Number)[0]<22||(process.versions.node.startsWith('22.')&&Number(process.versions.node.split('.')[1])<19))process.exit(1)" || { echo 'Moco requires Node.js 22.19 or newer.' >&2; exit 1; }\nMOCO_PEER_RUNTIME=\"\$HOME/.moco/runtime\"\nmkdir -p \"\$MOCO_PEER_RUNTIME\"\nchmod 700 \"\$HOME/.moco\" \"\$MOCO_PEER_RUNTIME\"\ncurl -fsS \"\$MOCO_PEER_HUB_URL/connect/peer.mjs\" -o \"\$MOCO_PEER_RUNTIME/peer.mjs.download\"\nmv \"\$MOCO_PEER_RUNTIME/peer.mjs.download\" \"\$MOCO_PEER_RUNTIME/peer.mjs\"\nnpm install --prefix \"\$MOCO_PEER_RUNTIME\" --omit=dev --ignore-scripts --no-audit --no-fund 'undici@8.12.4' '@anthropic-ai/claude-agent-sdk@0.3.326' '@earendil-works/pi-env@1.5.2' 'ws@8.22.2' 'agent-browser@0.43.0' 'agent-desktop@1.3.1'\nnode \"\$MOCO_PEER_RUNTIME/peer.mjs\" install --hub \"\$MOCO_PEER_HUB_URL\" --invite \"\$MOCO_PEER_INVITE\"\n`;
}
