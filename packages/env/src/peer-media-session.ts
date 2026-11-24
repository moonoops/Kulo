import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { forwardPeerRequestHeaders } from "./peer-http-helpers.js";

const COOKIE_NAME = "kulo_media";
const COOKIE_ID_RE = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]{48})(?:;|$)`);
const SET_COOKIE_ID_RE = new RegExp(`^${COOKIE_NAME}=([a-f0-9]{48})(?:;|$)`);
const READABLE_UPLOAD_PATH_RE = /^\/api\/uploads\/[^/?#]+(?:\/meta|\/preview|\/view)?$/;
const MAX_MEDIA_SESSIONS = 256;
const MAX_SESSION_BODY_BYTES = 64 * 1024;
const CLEAR_MEDIA_COOKIE = `${COOKIE_NAME}=; Path=/api/uploads/; HttpOnly; SameSite=Strict; Max-Age=0`;

interface PeerMediaSessionEntry {
  upstreamCookie: string;
  expiresAt: number;
  hubOrigin: string;
  generation: number;
}

export interface ResolvedPeerMediaRead {
  handle: string;
  upstreamCookie: string;
}

export function isReadableMediaUploadRoute(method: string | undefined, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!READABLE_UPLOAD_PATH_RE.test(pathname) || pathname.includes("..")) return false;
  return true;
}

export function forwardPeerMediaCookieHeaders(
  headers: http.IncomingHttpHeaders,
  hub: URL,
  upstreamCookie: string,
): http.OutgoingHttpHeaders {
  const forwarded = forwardPeerRequestHeaders(headers, hub, "placeholder");
  delete forwarded.authorization;
  forwarded.cookie = upstreamCookie;
  return forwarded;
}

function extractUpstreamMediaCookieId(setCookieHeader: string | string[] | undefined): string | undefined {
  if (!setCookieHeader) return undefined;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    const firstPart = raw.split(";")[0]?.trim() ?? "";
    const match = SET_COOKIE_ID_RE.exec(firstPart);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export class PeerMediaSessionStore {
  readonly #sessions = new Map<string, PeerMediaSessionEntry>();
  readonly #now: () => number;
  #generation = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get generation(): number {
    return this.#generation;
  }

  get size(): number {
    return this.#sessions.size;
  }

  invalidateAll(): void {
    this.#sessions.clear();
    this.#generation += 1;
  }

  evict(handle: string): void {
    this.#sessions.delete(handle);
  }

  parseHandle(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader || cookieHeader.length > 8_192) return undefined;
    return COOKIE_ID_RE.exec(cookieHeader)?.[1];
  }

  resolveForRead(
    request: http.IncomingMessage,
    pathname: string,
    activeHubOrigin: string,
  ): ResolvedPeerMediaRead | undefined {
    if (!isReadableMediaUploadRoute(request.method, pathname)) return undefined;
    const handle = this.parseHandle(request.headers.cookie);
    if (!handle) return undefined;
    const entry = this.#sessions.get(handle);
    if (!entry) return undefined;
    if (
      entry.generation !== this.#generation ||
      entry.hubOrigin !== activeHubOrigin ||
      entry.expiresAt <= this.#now()
    ) {
      this.#sessions.delete(handle);
      return undefined;
    }
    return { handle, upstreamCookie: entry.upstreamCookie };
  }

  mintFromUpstream(input: {
    setCookieHeader: string | string[] | undefined;
    bodyJson: unknown;
    hubOrigin: string;
    expectedGeneration: number;
  }): string | undefined {
    if (input.expectedGeneration !== this.#generation) return undefined;
    const upstreamId = extractUpstreamMediaCookieId(input.setCookieHeader);
    if (!upstreamId) return undefined;
    if (!input.bodyJson || typeof input.bodyJson !== "object" || Array.isArray(input.bodyJson)) return undefined;
    const rawExpires = (input.bodyJson as { expiresAt?: unknown }).expiresAt;
    const now = this.#now();
    if (typeof rawExpires !== "number" || !Number.isFinite(rawExpires) || rawExpires <= now + 1_000) {
      return undefined;
    }
    const maxExpires = now + 24 * 60 * 60 * 1_000;
    const expiresAt = Math.min(rawExpires, maxExpires);

    for (const [id, entry] of this.#sessions) {
      if (entry.expiresAt <= now || entry.generation !== this.#generation) {
        this.#sessions.delete(id);
      }
    }
    if (this.#sessions.size >= MAX_MEDIA_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest) this.#sessions.delete(oldest);
    }

    const handle = crypto.randomBytes(24).toString("hex");
    const ttlSec = Math.max(1, Math.floor((expiresAt - now) / 1_000));
    this.#sessions.set(handle, {
      upstreamCookie: `${COOKIE_NAME}=${upstreamId}`,
      expiresAt,
      hubOrigin: input.hubOrigin,
      generation: this.#generation,
    });
    return `${COOKIE_NAME}=${handle}; Path=/api/uploads/; HttpOnly; SameSite=Strict; Max-Age=${ttlSec}`;
  }
}

export interface ProxyPeerHttpOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  target: URL;
  activeHub: URL;
  clientToken: string;
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  activeUpstreams: Set<http.ClientRequest>;
  proxyConnectTimeoutMs: number;
  mediaSessions: PeerMediaSessionStore;
  mediaRead?: ResolvedPeerMediaRead;
}

export function proxyPeerHttpRequest(options: ProxyPeerHttpOptions): void {
  const {
    request,
    response,
    target,
    activeHub,
    clientToken,
    httpAgent,
    httpsAgent,
    activeUpstreams,
    proxyConnectTimeoutMs,
    mediaSessions,
    mediaRead,
  } = options;

  target.searchParams.delete("token");
  const isHttps = activeHub.protocol === "https:";
  const transport = isHttps ? https : http;
  const agentForRequest = isHttps ? httpsAgent : httpAgent;
  const isMediaSessionMint = request.method === "POST" && target.pathname === "/api/media/session";
  const generationBefore = mediaSessions.generation;
  const hubOriginBefore = activeHub.origin;

  const outgoingHeaders = mediaRead
    ? forwardPeerMediaCookieHeaders(request.headers, activeHub, mediaRead.upstreamCookie)
    : forwardPeerRequestHeaders(request.headers, activeHub, clientToken);

  let connectTimer: NodeJS.Timeout | undefined;
  const clearConnectTimer = () => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }
  };

  const upstream = transport.request(
    target,
    {
      method: request.method,
      headers: outgoingHeaders,
      agent: agentForRequest,
    },
    (upstreamResponse) => {
      clearConnectTimer();
      const status = upstreamResponse.statusCode ?? 502;
      const headers: http.OutgoingHttpHeaders = { ...upstreamResponse.headers };
      const rawSetCookie = upstreamResponse.headers["set-cookie"];
      delete headers["set-cookie"];
      if (typeof headers.location === "string" && headers.location.startsWith(activeHub.origin)) {
        const location = new URL(headers.location);
        if (location.origin === activeHub.origin) {
          headers.location = `${location.pathname}${location.search}${location.hash}`;
        }
      }

      if (mediaRead && status === 401) {
        mediaSessions.evict(mediaRead.handle);
        headers["set-cookie"] = CLEAR_MEDIA_COOKIE;
      }

      if (isMediaSessionMint && status === 200) {
        const chunks: Buffer[] = [];
        let total = 0;
        let overflowed = false;
        upstreamResponse.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_SESSION_BODY_BYTES) {
            overflowed = true;
            upstreamResponse.destroy();
            return;
          }
          chunks.push(buf);
        });
        upstreamResponse.on("end", () => {
          if (overflowed || response.headersSent || response.destroyed) {
            if (!response.headersSent && !response.destroyed) {
              response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
              response.end(JSON.stringify({ error: "主脑媒体会话响应过大。" }));
            }
            return;
          }
          if (generationBefore !== mediaSessions.generation) {
            response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ error: "主脑已切换，请重试媒体会话。" }));
            return;
          }
          const rawBody = Buffer.concat(chunks);
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(rawBody.toString("utf8"));
          } catch {
            parsedBody = undefined;
          }
          const mintedCookie = mediaSessions.mintFromUpstream({
            setCookieHeader: rawSetCookie,
            bodyJson: parsedBody,
            hubOrigin: hubOriginBefore,
            expectedGeneration: generationBefore,
          });
          if (mintedCookie) {
            headers["set-cookie"] = mintedCookie;
          }
          delete headers["transfer-encoding"];
          headers["content-length"] = String(rawBody.length);
          response.writeHead(200, headers);
          response.end(rawBody);
        });
        upstreamResponse.on("error", () => {
          if (!response.headersSent && !response.destroyed) {
            response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ error: "无法连接主脑，请检查主脑及网络连接。" }));
          }
        });
        return;
      }

      response.writeHead(status, headers);
      upstreamResponse.pipe(response);
    },
  );

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
}
