import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { KULO_VERSION, type SearchFailure, type SearchPlanView } from "@kulo/protocol";
import { proxyFetch } from "./http-transport.js";

export interface SearchMcpOptions {
  plan: SearchPlanView;
  apiKey?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  stateDir?: string;
}
export type SearchMcpResult = Pick<CallToolResult, "content" | "structuredContent" | "isError">;
export interface SearchMcpSession {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>): Promise<SearchMcpResult>;
}

const MESSAGES: Record<SearchFailure["kind"], string> = {
  auth: "搜索服务凭证无效或没有访问权限。", quota: "搜索服务额度不足。", rate_limit: "搜索服务请求过于频繁，请稍后重试。",
  unsupported_tool: "此搜索连接没有提供所需的 MCP 工具。", invalid_request: "搜索请求参数不受此服务支持。",
  network: "无法连接搜索服务，请检查网络与代理。", timeout: "搜索服务响应超时。", no_results: "未检索到可引用的网页来源。",
  ungrounded: "搜索服务没有返回可验证的网页来源。", upstream: "搜索服务返回了无效或不完整的结果。", unknown: "搜索服务暂不可用。",
};

export class SearchAdapterError extends Error {
  readonly failure: SearchFailure;
  constructor(failure: SearchFailure) { super(failure.message); this.name = "SearchAdapterError"; this.failure = failure; }
}
export function searchAdapterFailure(kind: SearchFailure["kind"], extra: Partial<Omit<SearchFailure, "kind" | "message">> = {}): SearchAdapterError {
  return new SearchAdapterError({ kind, message: MESSAGES[kind], retryable: ["rate_limit", "network", "timeout", "upstream", "unknown"].includes(kind), ...extra });
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function errorText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (value instanceof Error) return `${value.name}: ${value.message} ${errorText(value.cause, depth + 1)}`.slice(0, 5000);
  const object = record(value);
  if (object) return [object.message, object.code, record(object.error)?.message, record(object.error)?.code].filter((item) => typeof item === "string").join(" ").slice(0, 5000);
  return typeof value === "string" ? value.slice(0, 5000) : "";
}

export function classifySearchMcpError(error: unknown): SearchAdapterError {
  if (error instanceof SearchAdapterError) return error;
  const object = record(error);
  const text = errorText(error);
  const number = object?.status ?? object?.statusCode ?? object?.code;
  const status = typeof number === "number" && number >= 400 && number <= 599 ? number : Number(/\b(?:HTTP\s*)?(400|401|402|403|404|408|409|429|5\d\d)\b/.exec(text)?.[1]) || undefined;
  let kind: SearchFailure["kind"] = "unknown";
  if (/quota|credit|insufficient|billing|payment required/i.test(text) || status === 402) kind = "quota";
  else if (status === 401 || status === 403 || /unauthoriz|authentication|invalid.api.key|access.denied/i.test(text)) kind = "auth";
  else if (status === 429 || /rate.limit|too.many.requests|bot.check|captcha/i.test(text)) kind = "rate_limit";
  else if (object?.code === -32601 || /unknown tool|tool.*not.found|not.support.*tool|method.not.found/i.test(text)) kind = "unsupported_tool";
  else if (object?.code === -32602 || status === 400 || /invalid.argument|invalid.param|validation/i.test(text)) kind = "invalid_request";
  else if (object?.code === -32001 || status === 408 || /timeout|timed.out|TimeoutError/i.test(text)) kind = "timeout";
  else if (/no (?:web )?results|no matching results|empty results/i.test(text)) kind = "no_results";
  else if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|connection.*(?:closed|error)|socket/i.test(text)) kind = "network";
  else if (status || error instanceof SyntaxError || /invalid.response|truncat|incomplete/i.test(text)) kind = "upstream";
  const extra: Partial<SearchFailure> = status ? { upstreamStatus: status } : {};
  const knownCode = /\b(invalid_api_key|insufficient_quota|rate_limit_exceeded|unauthorized|invalid_request|unsupported_parameter|quota_exceeded)\b/.exec(text)?.[1];
  if (knownCode) extra.upstreamCode = knownCode;
  const requestId = object?.requestId ?? object?.request_id;
  if (typeof requestId === "string" && /^(?:req_[A-Za-z0-9_-]{8,100}|[a-f\d]{16,64}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.test(requestId)) extra.requestId = requestId;
  return searchAdapterFailure(kind, extra);
}

const require = createRequire(import.meta.url);
function packageBin(name: string): string {
  const manifestPath = require.resolve(`${name}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
  if (!bin) throw searchAdapterFailure("unsupported_tool");
  const root = path.dirname(manifestPath);
  const entry = path.resolve(root, bin);
  if (path.relative(root, entry).startsWith("..") || !existsSync(entry)) throw searchAdapterFailure("unsupported_tool");
  return entry;
}

async function duckConfig(options: SearchMcpOptions): Promise<{ directory: string; temporary: boolean }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.plan.id) || ["__proto__", "constructor", "prototype"].includes(options.plan.id)) throw searchAdapterFailure("invalid_request");
  const temporary = !options.stateDir;
  const directory = options.stateDir ? path.join(options.stateDir, "search-mcp", "duckduckgo", options.plan.id) : await fs.mkdtemp(path.join(os.tmpdir(), "kulo-search-duck-"));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const config = {
    allowBrowserCookies: false, ssrf: { trustEnvProxy: false, allowRanges: [] },
    provider: "duckduckgo", webSearch: { enabled: true, allowedProviders: ["duckduckgo"] },
    searchRouting: { providers: ["duckduckgo"] }, maxInlineContentChars: 100_000,
    tools: { sourceCheck: { enabled: false } }, fetch: { defaultMode: "readable", allowedModes: ["readable", "raw"] },
    fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false }, githubClone: { enabled: false }, githubPrIssue: { enabled: false },
    geminiWeb: { enabled: false }, image: { enabled: false },
  };
  const file = path.join(directory, "web-search.json");
  const staging = path.join(directory, `web-search.${process.pid}.${randomUUID()}.tmp`);
  try { await fs.writeFile(staging, JSON.stringify(config), { mode: 0o600, flag: "wx" }); await fs.rename(staging, file); }
  finally { await fs.rm(staging, { force: true }); }
  return { directory, temporary };
}

export function searchMcpStdioEnvironment(options: SearchMcpOptions, directory?: string): Record<string, string> {
  const result: Record<string, string> = {};
  // The SDK merges its default environment even with an explicit env. Override every default, then add a small whitelist.
  for (const name of DEFAULT_INHERITED_ENV_VARS) result[name] = "";
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_CTYPE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[name]; if (value && !value.startsWith("()")) result[name] = value;
  }
  if (directory) result.PI_CODING_AGENT_DIR = directory;
  if (options.plan.adapter === "brave") {
    result.BRAVE_API_KEY = options.apiKey ?? "";
    result.BRAVE_MCP_TRANSPORT = "stdio";
    result.BRAVE_MCP_ENABLED_TOOLS = "brave_llm_context brave_web_search";
    result.BRAVE_MCP_LOG_LEVEL = "error";
  }
  return result;
}

export function duckProxyForTarget(url: string): string {
  try { return resolveHttpProxyUrlForTarget(url)?.href ?? ""; }
  catch { throw searchAdapterFailure("network"); }
}

export async function withSearchMcp<T>(options: SearchMcpOptions, run: (session: SearchMcpSession) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted();
  const transportAbort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, transportAbort.signal]) : transportAbort.signal;
  let bodyFailure: SearchAdapterError | undefined;
  const failBody = () => { bodyFailure = searchAdapterFailure("upstream"); transportAbort.abort(bodyFailure); return bodyFailure; };
  if ((options.plan.adapter === "tavily" || options.plan.adapter === "brave") && !options.apiKey) throw searchAdapterFailure("auth");
  const client = new Client({ name: "kulo-search", version: KULO_VERSION }, { capabilities: {} });
  let remote: StreamableHTTPClientTransport | undefined;
  let config: Awaited<ReturnType<typeof duckConfig>> | undefined;
  let closing = false;
  let cleanupSignal: AbortSignal | undefined;
  try {
    let transport;
    if (options.plan.adapter === "exa" || options.plan.adapter === "tavily") {
      const endpoint = new URL(options.plan.baseUrl ?? (options.plan.adapter === "exa" ? "https://mcp.exa.ai/mcp" : "https://mcp.tavily.com/mcp"));
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw searchAdapterFailure("invalid_request");
      const http: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const target = new URL(request.url);
        if (target.origin !== endpoint.origin) throw searchAdapterFailure("auth");
        const signals = closing ? [cleanupSignal!] : [request.signal, signal];
        const response = await (options.fetch ?? proxyFetch)(request, { signal: AbortSignal.any(signals), redirect: "error" });
        if (!response.ok && !(response.status === 405 && (closing || request.method === "GET"))) {
          let message = "";
          if (response.body) {
            const reader = response.body.getReader();
            const bytes: Uint8Array[] = []; let total = 0;
            try { while (total < 4096) { const next = await reader.read(); if (next.done) break; const bounded = next.value.slice(0, 4096 - total); bytes.push(bounded); total += bounded.length; } }
            finally { await reader.cancel(); reader.releaseLock(); }
            message = Buffer.concat(bytes).toString("utf8");
          }
          throw classifySearchMcpError({ status: response.status, message, requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") });
        }
        if (!response.body) return response;
        const maximum = 2 * 1024 * 1024;
        if (Number(response.headers.get("content-length")) > maximum) { await response.body.cancel(); throw failBody(); }
        let length = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          length += chunk.byteLength;
          if (length > maximum) throw failBody();
          controller.enqueue(chunk);
        } }));
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      const headers: Record<string, string> = options.apiKey ? options.plan.adapter === "exa" ? { "x-api-key": options.apiKey } : { Authorization: `Bearer ${options.apiKey}` } : {};
      remote = new StreamableHTTPClientTransport(endpoint, { fetch: http, requestInit: { headers, redirect: "error" }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
      transport = remote;
    } else {
      if (options.plan.adapter === "duckduckgo") config = await duckConfig(options);
      const bin = packageBin(options.plan.adapter === "brave" ? "@brave/brave-search-mcp-server" : "pi-web-access");
      let bootstrap = fileURLToPath(new URL("./search-mcp-stdio.js", import.meta.url));
      let args: string[] = [];
      if (!existsSync(bootstrap)) { bootstrap = bootstrap.replace(/\.js$/, ".ts"); args = ["--import", require.resolve("tsx")]; }
      args.push(bootstrap, bin);
      const stdio = new StdioClientTransport({ command: process.execPath, args, env: searchMcpStdioEnvironment(options, config?.directory), cwd: path.dirname(bin), stderr: "pipe", maxBufferSize: 2 * 1024 * 1024 });
      stdio.stderr?.on("data", () => { /* Official servers can echo upstream errors; keep credential-bearing diagnostics off the Hub log. */ });
      transport = stdio;
    }
    await client.connect(transport, { signal, timeout: 15_000 });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await client.listTools({ ...(cursor ? { cursor } : {}) }, { signal, timeout: 15_000 });
      tools.push(...result.tools); cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor) throw searchAdapterFailure("upstream");
    return await run({ tools, async call(name, args) {
      signal.throwIfAborted();
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 30_000, maxTotalTimeout: 30_000 }) as SearchMcpResult;
      if (result.isError) throw classifySearchMcpError(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      return result as SearchMcpResult;
    } });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (bodyFailure) throw bodyFailure;
    throw classifySearchMcpError(error);
  } finally {
    closing = true; cleanupSignal = AbortSignal.timeout(1500);
    if (remote?.sessionId) {
      try { await remote.terminateSession(); }
      catch (error) { console.warn("[KuloSearchMCP] Session cleanup failed", options.plan.id, classifySearchMcpError(error).failure.kind); }
    }
    try { await client.close(); }
    finally { if (config?.temporary) await fs.rm(config.directory, { recursive: true, force: true }); }
  }
}
