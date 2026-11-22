import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";

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

function peerHtmlCsp(html: string): string {
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

export function tryServeLocalWebAsset(
  webDistDir: string | undefined,
  pathname: string,
  method: string | undefined,
  response: http.ServerResponse,
): boolean {
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
  if (ext === ".html") {
    const html = fs.readFileSync(canonicalFile, "utf8");
    response.writeHead(200, {
      "content-type": STATIC_MIME_BY_EXT[ext] ?? "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(html)),
      "cache-control": "no-cache",
      "content-security-policy": peerHtmlCsp(html),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : html);
    return true;
  }
  const stat = fs.statSync(canonicalFile);
  response.writeHead(200, {
    "content-type": STATIC_MIME_BY_EXT[ext] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "cache-control": "public, max-age=31536000, immutable",
    "referrer-policy": "no-referrer",
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
