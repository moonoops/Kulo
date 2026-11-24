import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import {
  HTML_ARTIFACT_BROWSER_CSP, HTML_ARTIFACT_CSP,
  HTML_DIAGRAM_BROWSER_CSP, HTML_DIAGRAM_CSP,
  htmlArtifactBrowserDocument, htmlArtifactDocument, htmlDiagramBrowserDocument, isHtmlArtifact,
} from "@kulo/protocol";
import {
  MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES, MEDIA_UPLOAD_LIMITS,
  KuloUploadStore, UploadError, VISION_IMAGE_MIMES,
  type LoadedUpload, type UploadPresentationInput,
} from "./uploads.js";
import { MediaThumbnailCache } from "./media-thumbnails.js";

export interface MediaHttpOptions {
  uploads: KuloUploadStore;
  thumbnailsDir?: string;
  thumbnailCache?: MediaThumbnailCache;
  authenticate: (req: IncomingMessage, url: URL) => string | undefined;
  isPrincipalActive?: (principalId: string) => boolean;
  canReadScope?: (principalId: string, scopeId: string) => boolean | Promise<boolean>;
  resolveScopeChecker?: (principalId: string) => Promise<(scopeId: string) => boolean>;
  sessionTtlMs?: number;
  now?: () => number;
}

export interface MediaHttpHandler {
  (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  revoke(principalId?: string): void;
  close(): void;
}

interface MediaSession { principalId: string; expiresAt: number }
const COOKIE_NAME = "kulo_media";

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

/** Only one byte range is supported; multiple and invalid ranges are rejected rather than mis-served. */
export function parseMediaRange(value: string, size: number): { start: number; end: number } | null {
  if (value.length > 128 || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

interface MediaFileTarget {
  filePath: string;
  expectedSize?: number;
  mimeType: string;
  dispositionName: string;
  inline: boolean;
  etag: string;
  cacheControl: string;
  vary?: string;
}

function encodedFilename(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function thumbnailFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}.webp`;
}

function ifNoneMatchHeader(req: IncomingMessage): string | undefined {
  const value = req.headers["if-none-match"];
  return Array.isArray(value) ? value.join(", ") : value;
}

export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const target = etag.startsWith("W/") ? etag.slice(2).trim() : etag;
  for (const part of trimmed.split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    const opaque = candidate.startsWith("W/") ? candidate.slice(2).trim() : candidate;
    if (opaque === target) return true;
  }
  return false;
}

function writeNotModified(
  res: ServerResponse,
  options: { etag: string; cacheControl: string; vary?: string },
): void {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": options.cacheControl,
    etag: options.etag,
    ...(options.vary ? { vary: options.vary } : {}),
  };
  res.writeHead(304, headers);
  res.end();
}

function originalMediaTarget(loaded: LoadedUpload, download: boolean): MediaFileTarget {
  const { record } = loaded;
  const cacheableImage = !download && record.kind === "image" && VISION_IMAGE_MIMES.has(record.mimeType);
  const inline = !download && (cacheableImage || record.kind === "audio" || record.kind === "video");
  return {
    filePath: loaded.filePath,
    expectedSize: record.size,
    mimeType: record.mimeType,
    dispositionName: record.name,
    inline,
    etag: `"${record.sha256 ?? `${record.id}-${record.size}`}"`,
    cacheControl: cacheableImage ? "private, no-cache" : "private, no-store",
    ...(cacheableImage ? {} : { vary: "Authorization, Cookie" }),
  };
}

async function serveMediaFile(req: IncomingMessage, res: ServerResponse, target: MediaFileTarget): Promise<void> {
  const handle = await fs.promises.open(target.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (target.expectedSize !== undefined ? stat.size !== target.expectedSize : stat.size <= 0)) {
      throw new UploadError("资源文件不可用", 500);
    }
    if (!req.headers.range && matchesIfNoneMatch(ifNoneMatchHeader(req), target.etag)) {
      writeNotModified(res, target);
      return;
    }
    const headers: Record<string, string> = {
      "content-type": target.mimeType,
      "content-disposition": `${target.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename(target.dispositionName)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": target.cacheControl,
      "accept-ranges": "bytes",
      etag: target.etag,
      ...(target.vary ? { vary: target.vary } : {}),
    };
    const rangeHeader = req.method === "GET" && (!req.headers["if-range"] || req.headers["if-range"] === target.etag) ? req.headers.range : undefined;
    const range = rangeHeader === undefined ? undefined : parseMediaRange(rangeHeader, stat.size);
    if (range === null) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}`, "content-length": "0" });
      res.end();
      return;
    }
    if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["content-length"] = String(range ? range.end - range.start + 1 : stat.size);
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = fs.createReadStream(target.filePath, { fd: handle.fd, autoClose: false, ...(range ?? {}) });
    try { await pipeline(stream, res); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!req.aborted && code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ECONNRESET" && code !== "EPIPE") throw error;
    }
  } finally { await handle.close(); }
}

export async function serveUploadedAsset(req: IncomingMessage, res: ServerResponse, loaded: LoadedUpload, download = false): Promise<void> {
  await serveMediaFile(req, res, originalMediaTarget(loaded, download));
}

async function serveHtmlPreview(req: IncomingMessage, res: ServerResponse, loaded: LoadedUpload, browser = false): Promise<void> {
  if (!isHtmlArtifact(loaded.record)) throw new UploadError("此文件不支持 HTML 预览", 415);
  if (loaded.record.size > MAX_UPLOAD_BYTES) throw new UploadError("HTML 文件最大支持 25 MiB", 413);
  const handle = await fs.promises.open(loaded.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== loaded.record.size) throw new UploadError("资源文件不可用", 500);
    const document = await handle.readFile("utf8");
    const standalone = browser || req.headers["sec-fetch-dest"] === "document";
    const diagram = loaded.record.presentation === "diagram";
    const bytes = Buffer.from(
      diagram
        ? (standalone ? htmlDiagramBrowserDocument(document, loaded.record.name) : document)
        : (standalone ? htmlArtifactBrowserDocument(document, loaded.record.name) : htmlArtifactDocument(document)),
    );
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": bytes.length,
      "content-disposition": `inline; filename*=UTF-8''${encodedFilename(loaded.record.name)}`,
      "content-security-policy": diagram
        ? (standalone ? HTML_DIAGRAM_BROWSER_CSP : HTML_DIAGRAM_CSP)
        : (standalone ? HTML_ARTIFACT_BROWSER_CSP : HTML_ARTIFACT_CSP),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
      vary: "Authorization, Cookie",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } finally { await handle.close(); }
}

async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const maximum = Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 64 * 1024;
  if (Number(req.headers["content-length"]) > maximum) throw new UploadError("Base64 上传过大，请使用文件上传", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new UploadError("Base64 上传过大，请使用文件上传", 413);
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new UploadError("无效的上传内容", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UploadError("无效的上传内容", 400);
  return parsed as Record<string, unknown>;
}

/** This handler is deliberately independent of the management/API/WS authenticator. */
export function createMediaHttpHandler(options: MediaHttpOptions): MediaHttpHandler {
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? 30 * 60 * 1000;
  if (!Number.isFinite(ttl) || ttl < 1000 || ttl > 24 * 60 * 60 * 1000) throw new Error("Invalid media session lifetime");
  const sessions = new Map<string, MediaSession>();
  const ownsThumbnails = !options.thumbnailCache && Boolean(options.thumbnailsDir);
  const thumbnails = options.thumbnailCache ?? (options.thumbnailsDir
    ? new MediaThumbnailCache({ dir: options.thumbnailsDir, uploadsDir: options.uploads.dir, now })
    : undefined);
  const active = (principal: string) => options.isPrincipalActive?.(principal) ?? true;
  const authorizeRead = async (loaded: LoadedUpload, principal: string): Promise<boolean> => {
    if (options.uploads.isUploadOwner(loaded.record, principal)) return true;
    const scopes = loaded.record.referenceScopes ?? [];
    if (scopes.length === 0) return false;
    if (options.resolveScopeChecker) {
      const canRead = await options.resolveScopeChecker(principal);
      return scopes.some(canRead);
    }
    if (options.canReadScope) {
      for (const scope of scopes) {
        if (await options.canReadScope(principal, scope)) return true;
      }
      return false;
    }
    return true;
  };
  const fromCookie = (req: IncomingMessage): string | undefined => {
    const raw = req.headers.cookie;
    if (!raw || raw.length > 8192) return undefined;
    const id = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]{48})(?:;|$)`).exec(raw)?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expiresAt <= now() || !active(session.principalId)) {
      if (id) sessions.delete(id);
      return undefined;
    }
    return session.principalId;
  };
  const principalForRead = (req: IncomingMessage, url: URL) => {
    const principal = options.authenticate(req, url) ?? fromCookie(req);
    return principal && active(principal) ? principal : undefined;
  };
  const handler: MediaHttpHandler = Object.assign(async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const isUpload = req.method === "POST" && url.pathname === "/api/uploads";
    const isSession = req.method === "POST" && url.pathname === "/api/media/session";
    const asset = (req.method === "GET" || req.method === "HEAD") ? /^\/api\/uploads\/([^/]+)(\/meta|\/preview|\/view)?$/.exec(url.pathname) : null;
    if (!isUpload && !isSession && !asset) return false;
    try {
      if (isSession) {
        const bearerUrl = new URL(url);
        bearerUrl.searchParams.delete("token");
        const principal = /^Bearer\s+\S+$/i.test(req.headers.authorization ?? "") ? options.authenticate(req, bearerUrl) : undefined;
        if (!principal || !active(principal)) { json(res, 401, { error: "Unauthorized" }); return true; }
        if (req.headers.origin) {
          let sameOrigin = false;
          const protocol = Boolean((req.socket as { encrypted?: boolean }).encrypted) || req.headers["x-forwarded-proto"] === "https" ? "https:" : "http:";
          try {
            const origin = new URL(req.headers.origin);
            sameOrigin = origin.host === req.headers.host && origin.protocol === protocol && origin.origin === req.headers.origin;
          } catch { /* An invalid Origin is rejected. */ }
          if (!sameOrigin) { json(res, 403, { error: "无效的资源会话来源" }); return true; }
        }
        for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
        if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
        const id = crypto.randomBytes(24).toString("hex");
        const expiresAt = now() + ttl;
        sessions.set(id, { principalId: principal, expiresAt });
        const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted) || req.headers["x-forwarded-proto"] === "https";
        res.setHeader("set-cookie", `${COOKIE_NAME}=${id}; Path=/api/uploads/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${encrypted ? "; Secure" : ""}`);
        json(res, 200, { expiresAt, limits: MEDIA_UPLOAD_LIMITS });
        return true;
      }
      if (isUpload) {
        // A read-only media cookie never authorizes uploads.
        const principal = options.authenticate(req, url);
        if (!principal || !active(principal)) { json(res, 401, { error: "Unauthorized" }); return true; }
        const uploadId = req.headers["x-upload-id"];
        if (uploadId !== undefined && (typeof uploadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(uploadId))) throw new UploadError("无效的上传标识", 400);
        const idempotencyKey = uploadId === undefined ? undefined : `upload:${JSON.stringify([principal, uploadId])}`;
        const presentation = url.searchParams.get("presentation") ?? undefined;
        if (presentation !== undefined && presentation !== "voice") throw new UploadError("无效的附件展示类型", 400);
        const rawDuration = url.searchParams.get("recordedDuration");
        const recordedDuration = rawDuration === null ? undefined : rawDuration.trim() ? Number(rawDuration) : NaN;
        const voice: UploadPresentationInput = { presentation: presentation as "voice" | undefined, recordedDuration };
        const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
        const rawFile = url.searchParams.has("name") || req.headers["x-file-name"] !== undefined;
        if (contentType.split(";")[0]?.trim() === "application/json" && !rawFile) {
          const body = await readSmallJson(req);
          const raw = typeof body.dataBase64 === "string" ? body.dataBase64.trim() : "";
          const dataUrl = /^data:([^;,\s]+)?(?:;[^,]+)?,([\s\S]+)$/i.exec(raw);
          const encoded = (dataUrl ? dataUrl[2] ?? "" : raw).replace(/\s+/g, "");
          if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new UploadError("无效的 Base64 文件内容", 400);
          const bytes = Buffer.from(encoded, "base64");
          if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError("Base64 上传最大支持 25 MiB，请使用文件上传", 413);
          const attachment = options.uploads.saveUpload({ name: typeof body.name === "string" ? body.name : undefined, mimeType: typeof body.mimeType === "string" ? body.mimeType : dataUrl?.[1], bytes, ownerId: principal, idempotencyKey, ...voice });
          json(res, 201, { attachment });
          return true;
        }
        if (Number(req.headers["content-length"]) > MAX_VIDEO_UPLOAD_BYTES) throw new UploadError("文件最大支持 250 MiB", 413);
        let name = url.searchParams.get("name") ?? undefined;
        if (!name && typeof req.headers["x-file-name"] === "string") {
          try { name = decodeURIComponent(req.headers["x-file-name"]); } catch { throw new UploadError("无效的文件名编码", 400); }
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort);
        res.once("close", abort);
        if (req.aborted) abort();
        try {
          const attachment = await options.uploads.saveUploadStream({ name, mimeType: url.searchParams.get("mimeType") ?? (contentType.split(";")[0]?.trim() || undefined), stream: req.iterator({ destroyOnReturn: false }), ownerId: principal, signal: controller.signal, idempotencyKey, ...voice });
          if (!req.readableEnded) req.resume();
          json(res, 201, { attachment });
        } finally { req.off("aborted", abort); res.off("close", abort); }
        return true;
      }
      const principal = principalForRead(req, url);
      if (!principal) { json(res, 401, { error: "Unauthorized" }); return true; }
      let id: string;
      try { id = decodeURIComponent(asset![1]!); } catch { throw new UploadError("无效的资源标识", 400); }
      const loaded = options.uploads.getUpload(id);
      if (!loaded) { json(res, 404, { error: "Attachment not found" }); return true; }
      if (loaded.record.internalOnly) { json(res, 403, { error: "内部资源不可直接访问" }); return true; }
      if (!await authorizeRead(loaded, principal)) {
        json(res, 403, { error: "无权访问此资源" });
        return true;
      }
      if (asset![2] === "/preview" || asset![2] === "/view") {
        await serveHtmlPreview(req, res, loaded, asset![2] === "/view");
        return true;
      }
      if (asset![2] === "/meta") {
        if (req.method === "HEAD") { res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }); res.end(); }
        else json(res, 200, { attachment: options.uploads.toChatAttachment(loaded.record) });
        return true;
      }
      const download = url.searchParams.get("download") === "1";
      const wantThumb = !download && url.searchParams.get("variant") === "thumb" && thumbnails !== undefined;
      const original = originalMediaTarget(loaded, download);
      const ifNoneMatch = ifNoneMatchHeader(req);
      if (!req.headers.range && ifNoneMatch) {
        if (!wantThumb) {
          if (matchesIfNoneMatch(ifNoneMatch, original.etag)) {
            writeNotModified(res, original);
            return true;
          }
        } else {
          const fastThumbEtag = thumbnails.fastEtag(loaded.record);
          if (fastThumbEtag && matchesIfNoneMatch(ifNoneMatch, fastThumbEtag)) {
            writeNotModified(res, { etag: fastThumbEtag, cacheControl: "private, no-cache" });
            return true;
          }
          if (thumbnails.isDeterministicBypass(loaded.record) && matchesIfNoneMatch(ifNoneMatch, original.etag)) {
            writeNotModified(res, original);
            return true;
          }
        }
      }
      if (wantThumb) {
        const hit = await thumbnails.getOrCreate(loaded);
        if (req.aborted) return true;
        if (hit) {
          const thumbTarget: MediaFileTarget = {
            filePath: hit.filePath,
            expectedSize: hit.size,
            mimeType: hit.mimeType,
            dispositionName: thumbnailFilename(loaded.record.name),
            inline: true,
            etag: hit.etag,
            cacheControl: "private, no-cache",
          };
          try {
            await serveMediaFile(req, res, thumbTarget);
            return true;
          } catch (error) {
            if (res.headersSent) throw error;
          }
        }
      }
      await serveMediaFile(req, res, original);
      return true;
    } catch (error) {
      if (req.aborted) return true;
      if (error instanceof UploadError) {
        if (!res.headersSent) {
          if (!req.complete && req.method === "POST") {
            res.setHeader("connection", "close");
            req.resume();
          }
          json(res, error.status, { error: error.message });
        } else res.destroy(error);
        return true;
      }
      throw error;
    }
  }, {
    revoke(principalId?: string) {
      for (const [id, session] of sessions) if (principalId === undefined || session.principalId === principalId) sessions.delete(id);
    },
    close() {
      sessions.clear();
      if (ownsThumbnails) thumbnails?.close();
    },
  });
  return handler;
}
