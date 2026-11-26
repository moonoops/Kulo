import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseHTML } from "linkedom";
import { stripTrackingSearchParams, type WebPageResult, type WebSource } from "@kulo/protocol";
import {
  isCloudMetadataHostOrIp,
  isFakeIpAddress,
  isPrivateOrLoopbackHost,
  isRestrictedPublicAddress,
} from "./net-policy.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 48_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
class WebAddressError extends Error {}

export function normalizeWebSourceUrl(
  value: unknown,
  options?: { allowPrivateNetwork?: boolean },
): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isCloudMetadataHostOrIp(host)) return undefined;
  if (!options?.allowPrivateNetwork) {
    if (
      host === "localhost" ||
      /\.(?:localhost|local|internal|lan|home)$/.test(host) ||
      (!host.includes(".") && !isIP(host.replace(/^\[|\]$/g, ""))) ||
      isRestrictedPublicAddress(host)
    ) {
      return undefined;
    }
  }
  stripTrackingSearchParams(url);
  return url.toString();
}

export function validatePublicWebUrl(value: string, options?: { allowPrivateNetwork?: boolean }): URL {
  const normalized = normalizeWebSourceUrl(value, options);
  if (!normalized) {
    throw new WebAddressError(
      options?.allowPrivateNetwork
        ? "只能读取非云元数据地址的 HTTP 或 HTTPS 网页。"
        : "只能读取公开的 HTTP 或 HTTPS 网页。",
    );
  }
  return new URL(normalized);
}

export function webSourceId(url: string): string {
  return `source-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

export async function readWebResponseText(response: Response, limit = MAX_BODY_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("网页响应超过大小限制。");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("网页响应超过大小限制。");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel(); reader.releaseLock(); }
}

async function pinnedRequest(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  allowPrivateNetwork = false,
): Promise<Response> {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isCloudMetadataHostOrIp(host)) {
    throw new WebAddressError("已阻止访问受保护的云元数据地址。");
  }
  let proxy: URL | undefined;
  try { proxy = resolveHttpProxyUrlForTarget(url); }
  catch { throw new Error("HTTP 代理配置无效，请检查代理地址。"); }
  // In trusted mode with an active HTTP proxy for a non-private host, let the proxy resolve DNS
  // (avoids Clash/Mihomo Fake-IP failures while still blocking cloud metadata on every redirect hop).
  if (allowPrivateNetwork && proxy && !isPrivateOrLoopbackHost(host)) {
    return bufferedNodeRequest(url, init, signal, undefined);
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (allowPrivateNetwork) {
    if (!addresses.length || addresses.some((item) => isCloudMetadataHostOrIp(item.address))) {
      throw new WebAddressError("网页域名解析到了受限云元数据地址。");
    }
    if (proxy && addresses.every((item) => isFakeIpAddress(item.address))) {
      return bufferedNodeRequest(url, init, signal, undefined);
    }
    return bufferedNodeRequest(url, init, signal, addresses[0]!);
  }
  if (!addresses.length || addresses.some((item) => isRestrictedPublicAddress(item.address))) {
    // Fake-IP answers from a local proxy cannot be pinned safely, but a remote extractor can read the public hostname.
    if (addresses.length && addresses.every((item) => isFakeIpAddress(item.address))) throw new Error("网页域名使用代理 Fake-IP DNS，请配置 Tavily 正文提取或可解析公网地址的 DNS。");
    throw new WebAddressError("网页域名解析到了受限地址，请检查地址或代理 DNS 设置。");
  }
  const selected = addresses[0]!;
  return bufferedNodeRequest(url, init, signal, selected);
}

async function bufferedNodeRequest(url: URL, init: RequestInit, signal: AbortSignal, selected?: { address: string; family: number }, maxBodyBytes = MAX_BODY_BYTES): Promise<Response> {
  let proxy: URL | undefined;
  try { proxy = resolveHttpProxyUrlForTarget(url); }
  catch { throw new Error("HTTP 代理配置无效，请检查代理地址。"); }
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  if (agent && selected) {
    const connect = agent.connect.bind(agent);
    agent.connect = (request, options) => connect(request, options.secureEndpoint
      ? { ...options, host: selected.address, servername: url.hostname.replace(/^\[|\]$/g, "") }
      : { ...options, host: selected.address });
  }
  const headers = new Headers(init.headers);
  headers.set("accept-encoding", "identity");
  return new Promise<Response>((resolve, reject) => {
    // Pin the checked DNS result through the socket lookup when direct/sandboxed; omit lookup when proxied without a pinned IP.
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method ?? "GET", headers: Object.fromEntries(headers), signal,
      ...(agent ? { agent } : {}),
      ...(selected
        ? {
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
              else callback(null, selected.address, selected.family);
            },
          }
        : {}),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let length = 0;
      incoming.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBodyBytes) { incoming.destroy(new Error("服务响应超过大小限制。")); return; }
        chunks.push(chunk);
      });
      incoming.once("error", (error) => { agent?.destroy(); reject(error); });
      incoming.once("end", () => {
        try {
          let bytes = Buffer.concat(chunks);
          const encoding = incoming.headers["content-encoding"]?.toLowerCase();
          const options = { maxOutputLength: maxBodyBytes };
          if (encoding === "gzip") bytes = gunzipSync(bytes, options);
          else if (encoding === "br") bytes = brotliDecompressSync(bytes, options);
          else if (encoding === "deflate") bytes = inflateSync(bytes, options);
          else if (encoding && encoding !== "identity") throw new Error("不支持此网页的压缩格式。");
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined && !["content-length", "content-encoding"].includes(key)) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = incoming.statusCode ?? 502;
          resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(bytes), { status, headers: responseHeaders }));
        } catch { reject(new Error("未能解码网页响应，或响应超过大小限制。")); }
        finally { agent?.destroy(); }
      });
    });
    request.once("error", (error) => { agent?.destroy(); reject(signal.aborted ? signal.reason : error); });
    if (typeof init.body === "string") request.write(init.body);
    request.end();
  });
}

/** Configured service endpoints are user-owned connections; redirects never receive their credentials. */
export async function serviceApiFetch(value: string | URL, init: RequestInit, options: { maxResponseBytes?: number; timeoutMs?: number } = {}): Promise<Response> {
  const url = value instanceof URL ? value : new URL(value);
  let proxy: URL | undefined;
  try { proxy = resolveHttpProxyUrlForTarget(url); }
  catch { throw new Error("搜索服务的 HTTP 代理配置无效。"); }
  if (!proxy) return fetch(url, { ...init, redirect: "error" });
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return bufferedNodeRequest(url, init, signal, undefined, options.maxResponseBytes);
}

export const searchApiFetch = serviceApiFetch;

export async function safeWebRequest(
  value: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; allowPrivateNetwork?: boolean } = {},
): Promise<{ response: Response; url: string }> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const allowPrivateNetwork = Boolean(options.allowPrivateNetwork);
  let url = validatePublicWebUrl(value, { allowPrivateNetwork });
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const init: RequestInit = { signal, redirect: "manual", headers: {
      "User-Agent": "Kulo-Agent/0.3", Accept: "text/markdown, text/html, text/plain, application/json;q=0.8",
    } };
    // An injected transport is trusted by the owning caller and is used for deterministic fixtures.
    const response = options.fetch ? await options.fetch(url, init) : await pinnedRequest(url, init, signal, allowPrivateNetwork);
    if (!REDIRECTS.has(response.status)) return { response, url: url.toString() };
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("网页重定向缺少目标地址。");
    if (redirects === 5) throw new Error("网页重定向次数过多。");
    let redirected: URL;
    try { redirected = new URL(location, url); } catch { throw new Error("网页重定向地址无效。"); }
    url = validatePublicWebUrl(redirected.toString(), { allowPrivateNetwork });
  }
  throw new Error("网页重定向次数过多。");
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function elementMarkdown(node: { nodeType: number; nodeName: string; textContent: string | null; childNodes: unknown; getAttribute?: (name: string) => string | null }, base: string, allowPrivateNetwork = false): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return "";
  const tag = node.nodeName.toLowerCase();
  if (["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "button", "svg", "iframe"].includes(tag)) return "";
  if (tag === "pre") return `\n\n\`\`\`\n${node.textContent?.trim() ?? ""}\n\`\`\`\n\n`;
  const children = Array.from(node.childNodes as ArrayLike<typeof node>).map((child) => elementMarkdown(child, base, allowPrivateNetwork)).join("");
  if (tag === "a") {
    const href = node.getAttribute?.("href");
    let url: string | undefined;
    try { url = href ? normalizeWebSourceUrl(new URL(href, base).toString(), { allowPrivateNetwork }) : undefined; } catch { /* Relative links without a valid base remain text. */ }
    const label = children.trim().replace(/[\[\]]/g, "");
    return url && label ? `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})` : children;
  }
  if (tag === "img") return "";
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${children.trim()}\n\n`;
  if (tag === "br") return "\n";
  if (tag === "li") return `\n- ${children.trim()}`;
  if (tag === "td" || tag === "th") return `${children.trim()} | `;
  if (["p", "div", "article", "section", "main", "ul", "ol", "blockquote", "tr"].includes(tag)) return `\n\n${children.trim()}\n\n`;
  return children;
}

export function extractReadablePage(
  raw: string,
  value: string,
  mimeType = "text/html",
  options?: { allowPrivateNetwork?: boolean },
): WebPageResult {
  const allowPrivateNetwork = Boolean(options?.allowPrivateNetwork);
  const url = validatePublicWebUrl(value, { allowPrivateNetwork }).toString();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error("网页响应超过大小限制。");
  let title = new URL(url).hostname;
  let content: string;
  if (/html|xhtml/i.test(mimeType)) {
    const { document } = parseHTML(raw);
    title = document.title?.trim() || document.querySelector("h1")?.textContent?.trim() || title;
    for (const element of document.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,iframe,object,embed")) element.remove();
    const article = new Readability(document.cloneNode(true) as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 100, keepClasses: false }).parse();
    const selected = article?.content ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : document.querySelector("article,main,[role=main]") ?? document.body ?? document.documentElement;
    if (article?.title?.trim()) title = article.title.trim();
    content = cleanText(elementMarkdown(selected, url, allowPrivateNetwork));
    if (!content) content = cleanText(article?.textContent ?? selected.textContent ?? "");
  } else if (/^text\/|(?:json|xml)/i.test(mimeType)) {
    content = cleanText(raw);
    const markdownTitle = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    if (markdownTitle) title = markdownTitle;
  } else throw new Error("此地址不是可读取的文本网页。");
  if (!content) throw new Error("未能提取网页正文，页面可能需要浏览器渲染。");
  const truncated = content.length > MAX_CONTENT_CHARS;
  content = content.slice(0, MAX_CONTENT_CHARS);
  const source: WebSource = { id: webSourceId(url), title: title.slice(0, 500), url, snippet: content.slice(0, 600), fetchedAt: Date.now() };
  return { url, title: source.title, content, truncated, sources: [source] };
}

export function sanitizeSearchSuggestions(html: string): string {
  if (!html.trim() || html.length > 24_000) return "";
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const element of document.querySelectorAll("script,iframe,object,embed,link,base,form,input,textarea,button,video,audio,meta,svg,math")) element.remove();
  const unsafeCss = (value: string) => /\\|@import|@font-face|url\s*\(|image(?:-set)?\s*\(/i.test(value.replace(/\/\*[\s\S]*?\*\//g, ""));
  for (const element of document.querySelectorAll("*")) {
    if (element.localName === "style" && unsafeCss(element.textContent ?? "")) { element.remove(); continue; }
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ["srcdoc", "formaction", "action"].includes(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
      if (attribute.name.toLowerCase() === "style" && unsafeCss(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.localName === "a") {
      const href = normalizeWebSourceUrl(element.getAttribute("href"));
      if (href) { element.setAttribute("href", href); element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer"); }
      else element.removeAttribute("href");
    }
    // The provider widget is static markup. Keep it independent of external requests, including responsive image URLs.
    element.removeAttribute("src");
    element.removeAttribute("srcset");
    element.removeAttribute("poster");
  }
  return document.body.innerHTML.slice(0, 24_000);
}

export async function fetchWebPage(options: {
  url: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  tavily?: { baseUrl: string; apiKey: string };
  allowPrivateNetwork?: boolean;
}): Promise<WebPageResult> {
  const allowPrivateNetwork = Boolean(options.allowPrivateNetwork);
  const parsed = validatePublicWebUrl(options.url, { allowPrivateNetwork });
  const url = parsed.toString();
  const isPrivateTarget = isPrivateOrLoopbackHost(parsed.hostname);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
  let directError: unknown;
  try {
    const result = await safeWebRequest(url, { signal, fetch: options.fetch, allowPrivateNetwork });
    if (!result.response.ok) {
      await result.response.body?.cancel();
      throw new Error(`网页读取失败（HTTP ${result.response.status}）。`);
    }
    const type = result.response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/html";
    return extractReadablePage(await readWebResponseText(result.response), result.url, type, { allowPrivateNetwork });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WebAddressError) throw error;
    directError = error;
  }
  // Private/loopback URLs must NEVER fall back to cloud extractors (Exa/Tavily).
  if (!options.tavily || isPrivateTarget) throw directError;
  const endpoint = `${options.tavily.baseUrl.replace(/\/$/, "")}/extract`;
  const response = await (options.fetch ?? searchApiFetch)(endpoint, {
    method: "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${options.tavily.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url], format: "markdown", extract_depth: "advanced", include_images: false }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`网页提取失败（HTTP ${response.status}）。`); }
  let data: unknown;
  try { data = JSON.parse(await readWebResponseText(response)); } catch { signal.throwIfAborted(); throw new Error("网页提取服务返回了无效响应。"); }
  const results = data && typeof data === "object" && "results" in data ? (data as { results?: unknown }).results : undefined;
  const match = Array.isArray(results) ? results.find((item: unknown) => item && typeof item === "object" && typeof (item as { raw_content?: unknown }).raw_content === "string" && normalizeWebSourceUrl((item as { url?: unknown }).url) === url) : undefined;
  if (!match || !match.raw_content.trim()) throw new Error("网页提取服务未能读取此页面。");
  return extractReadablePage(match.raw_content, url, "text/markdown");
}

const REMOTE_FETCH_NODE_SCRIPT = `
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dns = require("node:dns/promises");
const zlib = require("node:zlib");
const MAX_BYTES = 2 * 1024 * 1024;
const META_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "metadata.azure.internal", "instance-data", "instance-data.ec2.internal"]);
function isMeta(raw) {
  const s = String(raw || "").trim().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "").toLowerCase();
  if (!s || META_HOSTS.has(s)) return true;
  const m = /^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/.exec(s);
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  const mapped = m && net.isIP(m[1]) === 4
    ? m[1]
    : h
      ? ((hi, lo) => ((hi >> 8) & 255) + "." + (hi & 255) + "." + ((lo >> 8) & 255) + "." + (lo & 255))(parseInt(h[1], 16), parseInt(h[2], 16))
      : null;
  const v4 = net.isIP(s) === 4 ? s : mapped;
  if (v4) {
    const [a, b, c, d] = v4.split(".").map(Number);
    return (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200) || a === 0;
  }
  if (net.isIP(s) === 6) {
    if (s === "::" || s === "0:0:0:0:0:0:0:0" || /^fd00:0?ec2:(?:0:){0,5}:?0?254$/i.test(s)) return true;
    const first = parseInt(s.split(":")[0] || "0", 16);
    if (Number.isFinite(first) && (first & 0xffc0) === 0xfe80) return true;
  }
  return false;
}
async function fetchOnce(targetUrl) {
  const u = new URL(targetUrl);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("无效的 HTTP/HTTPS 地址");
  const host = u.hostname.replace(/^\\[|\\]$/g, "");
  if (isMeta(host)) throw new Error("已阻止访问受保护的云元数据地址。");
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isMeta(a.address))) throw new Error("目标地址解析到了受保护的云元数据地址。");
  const sel = addrs[0];
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https.request : http.request)(u, {
      method: "GET",
      headers: { "User-Agent": "Kulo-Agent/0.3", Accept: "text/markdown, text/html, text/plain, application/json;q=0.8", "Accept-Encoding": "identity" },
      lookup: (_h, opts, cb) => opts.all ? cb(null, [{ address: sel.address, family: sel.family }]) : cb(null, sel.address, sel.family),
      timeout: 18000,
    }, (res) => {
      const chunks = [];
      let len = 0;
      res.on("data", (c) => {
        len += c.length;
        if (len > MAX_BYTES) { res.destroy(new Error("网页响应超过大小限制。")); return; }
        chunks.push(c);
      });
      res.once("error", reject);
      res.once("end", () => {
        try {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          if (enc === "gzip") buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_BYTES });
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_BYTES });
          else if (enc === "deflate") buf = zlib.inflateSync(buf, { maxOutputLength: MAX_BYTES });
          resolve({ status: res.statusCode || 502, headers: res.headers, body: buf.toString("utf8") });
        } catch (err) { reject(err); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("远端设备网页读取超时。")));
    req.once("error", reject);
    req.end();
  });
}
(async () => {
  let cur = process.argv[1];
  for (let i = 0; i <= 5; i++) {
    const res = await fetchOnce(cur);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!res.headers.location || i === 5) throw new Error("网页重定向失败或次数过多。");
      cur = new URL(res.headers.location, cur).toString();
      continue;
    }
    process.stdout.write(JSON.stringify({ status: res.status, finalUrl: cur, contentType: String(res.headers["content-type"] || "text/html").split(";")[0].trim().toLowerCase(), body: res.body }));
    return;
  }
})().catch((err) => { process.stderr.write(String(err && err.message ? err.message : err)); process.exit(1); });
`;

/**
 * Fetches a private/loopback URL directly from a remote execution environment so remote Workers
 * read the target device's own localhost/LAN instead of the Hub machine's localhost.
 */
export async function fetchWebPageViaEnv(options: {
  exec: (command: readonly string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  url: string;
  signal?: AbortSignal;
}): Promise<WebPageResult> {
  const parsed = validatePublicWebUrl(options.url, { allowPrivateNetwork: true });
  const res = await options.exec(
    ["node", "-e", REMOTE_FETCH_NODE_SCRIPT, parsed.toString()],
    { timeoutMs: 22_000, signal: options.signal },
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `远端设备网页读取失败（退出码 ${res.exitCode}）。`);
  }
  let payload: { status?: number; finalUrl?: string; contentType?: string; body?: string };
  try {
    payload = JSON.parse(res.stdout) as typeof payload;
  } catch {
    throw new Error("远端设备返回了无效的网页响应。");
  }
  if (typeof payload.status !== "number" || payload.status < 200 || payload.status >= 300) {
    throw new Error(`远端设备网页读取失败（HTTP ${payload.status ?? "unknown"}）。`);
  }
  return extractReadablePage(
    payload.body ?? "",
    payload.finalUrl ?? parsed.toString(),
    payload.contentType ?? "text/html",
    { allowPrivateNetwork: true },
  );
}
