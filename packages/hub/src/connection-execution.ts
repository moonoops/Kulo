import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ConnectionRecordView, ConnectionSecrets, ConnectionUseOperation, ConnectionUseResult, ExecutionTrustMode } from "@kulo/protocol";
import { LocalConnectionApplications, type ConnectionApplicationBackend } from "./connection-applications.js";
import {
  MAX_SAFE_HTTP_REDIRECTS,
  SAFE_HTTP_REDIRECT_STATUSES,
  isCloudMetadataHostOrIp,
  isPrivateOrLoopbackHost,
  prepareSafeHttpRedirect,
} from "./net-policy.js";
import {
  MAX_SSH_CAPTURE_OUTPUT,
  captureSshProcess,
  prepareSshAuthSession,
  sshConnectionAlias,
  type SshCaptureResult,
} from "./connection-ssh-auth.js";
import {
  SSH_KEYSCAN_LINE,
  classifySshScanFailure,
  computeSshKnownHostsFingerprint,
  formatSshHostFingerprints,
} from "./connection-ssh-diagnostics.js";

const MAX_OUTPUT = MAX_SSH_CAPTURE_OUTPUT;
const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;
const MAX_SSH_TIMEOUT_MS = 600_000;
const FORBIDDEN_CUSTOM_HTTP_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-connection",
]);
export interface ConnectionHostScan { fingerprint: string; lines: string[] }
export interface ConnectionSshProbeResult { exitCode: number; stderr: string; output: string }
export interface ConnectionExecutionBackend {
  scan(connection: ConnectionRecordView, signal?: AbortSignal): Promise<ConnectionHostScan>;
  trust(connection: ConnectionRecordView, scan: ConnectionHostScan): Promise<void>;
  hasTrustedHost?(connection: ConnectionRecordView, expectedFingerprint?: string): boolean;
  trustedHostPath?(connection: ConnectionRecordView, expectedFingerprint?: string): string | undefined;
  clearTrustedHost?(connection: ConnectionRecordView): void;
  probeSsh?(connection: ConnectionRecordView, secrets: ConnectionSecrets, signal?: AbortSignal): Promise<ConnectionSshProbeResult>;
  execute(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: ConnectionUseOperation, signal?: AbortSignal): Promise<ConnectionUseResult>;
}

function fail(message: string, code = "connection_execution_failed"): never {
  throw Object.assign(new Error(message), { code, status: 400 });
}

function alias(connection: ConnectionRecordView): string {
  return sshConnectionAlias(connection.host ?? "", connection.port ?? 22);
}

/** Authentication material travels over pipes into a dedicated native agent or a private, short-lived socket. */
export class LocalConnectionExecutor implements ConnectionExecutionBackend {
  readonly #directory: string;
  readonly #fetch: typeof fetch;
  readonly #applications: ConnectionApplicationBackend;
  readonly #platform: NodeJS.Platform;
  readonly #getExecutionTrustMode?: () => ExecutionTrustMode;
  constructor(options: {
    stateDir: string;
    fetch?: typeof fetch;
    applications?: ConnectionApplicationBackend;
    platform?: NodeJS.Platform;
    getExecutionTrustMode?: () => ExecutionTrustMode;
  }) {
    this.#directory = path.join(options.stateDir, "connection-runtime");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#platform = options.platform ?? process.platform;
    this.#applications = options.applications ?? new LocalConnectionApplications({ stateDir: options.stateDir, platform: this.#platform });
    this.#getExecutionTrustMode = options.getExecutionTrustMode;
  }
  #prepare(): void {
    if (fs.existsSync(this.#directory) && (fs.lstatSync(this.#directory).isSymbolicLink() || !fs.statSync(this.#directory).isDirectory())) fail("连接运行目录无效。", "connection_storage_invalid");
    fs.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.#directory, 0o700);
  }
  #knownHosts(connection: ConnectionRecordView): string {
    if (!/^connection-[a-f0-9-]{16,64}$/.test(connection.id)) fail("连接标识无效。");
    return path.join(this.#directory, `${connection.id}.known-hosts`);
  }
  hasTrustedHost(connection: ConnectionRecordView, expectedFingerprint?: string): boolean {
    if (connection.kind !== "ssh" || !connection.host) return false;
    let filePath: string;
    try { filePath = this.#knownHosts(connection); } catch { return false; }
    let stat: fs.Stats;
    try { stat = fs.lstatSync(filePath); } catch { return false; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_KNOWN_HOSTS_BYTES) return false;
    let content: string;
    try { content = fs.readFileSync(filePath, "utf8"); } catch { return false; }
    const fingerprint = computeSshKnownHostsFingerprint(content, alias(connection));
    if (!fingerprint) return false;
    return expectedFingerprint ? fingerprint === expectedFingerprint : true;
  }
  trustedHostPath(connection: ConnectionRecordView, expectedFingerprint?: string): string | undefined {
    if (!this.hasTrustedHost(connection, expectedFingerprint)) return undefined;
    return this.#knownHosts(connection);
  }
  clearTrustedHost(connection: ConnectionRecordView): void {
    if (connection.kind !== "ssh") return;
    try { fs.rmSync(this.#knownHosts(connection), { force: true }); } catch { /* Best-effort cleanup of stale known-hosts. */ }
  }
  async scan(connection: ConnectionRecordView, signal?: AbortSignal): Promise<ConnectionHostScan> {
    if (connection.kind !== "ssh" || !connection.host || connection.host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(connection.host)) fail("请先填写有效的 SSH 主机地址。");
    const result = await captureSshProcess("ssh-keyscan", ["-T", "5", "-p", String(connection.port ?? 22), "--", connection.host], { timeoutMs: 10_000, signal });
    const keys = result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = SSH_KEYSCAN_LINE.exec(line);
      return match ? [{ algorithm: match[1]!, data: match[2]! }] : [];
    });
    if (!keys.length) {
      const classified = classifySshScanFailure({ host: connection.host, platform: this.#platform });
      fail(classified.message, classified.code);
    }
    const unique = [...new Map(keys.map((key) => [`${key.algorithm} ${key.data}`, key])).values()];
    return {
      fingerprint: formatSshHostFingerprints(unique),
      lines: unique.map((key) => `${alias(connection)} ${key.algorithm} ${key.data}`),
    };
  }
  async trust(connection: ConnectionRecordView, scan: ConnectionHostScan): Promise<void> {
    this.#prepare();
    if (!scan.lines.length || scan.lines.some((line) => !line.startsWith(`${alias(connection)} `) || /[\r\n]/.test(line))) fail("服务器指纹确认无效。");
    const destination = this.#knownHosts(connection);
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, `${scan.lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  async probeSsh(connection: ConnectionRecordView, secrets: ConnectionSecrets, signal?: AbortSignal): Promise<ConnectionSshProbeResult> {
    const result = await this.#executeSsh(connection, secrets, { kind: "ssh", command: "exit 0", timeoutMs: 15_000 }, signal);
    return { exitCode: result.exitCode, stderr: result.stderr, output: result.output };
  }
  async execute(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: ConnectionUseOperation, signal?: AbortSignal): Promise<ConnectionUseResult> {
    signal?.throwIfAborted();
    if (operation.kind === "information") fail("资料读取需要通过任务的连接授权。", "connection_application_operation_invalid");
    if (operation.kind === "mcp" || connection.kind === "mcp") fail("MCP 连接须通过受管 MCP 连接池执行。", "connection_mcp_operation_invalid");
    if (connection.kind === "app") {
      if (!connection.appId || operation.kind !== "app") fail("请使用该应用提供的操作。", "connection_application_operation_invalid");
      return this.#applications.execute(connection.appId, secrets, operation, signal);
    }
    if (operation.kind === "app") fail("此连接不是预置应用。", "connection_application_operation_invalid");
    if (connection.kind === "custom") fail("此凭据尚未配置对应的执行方式。", "connection_adapter_unavailable");
    if (operation.kind === "http") return this.#http(connection, secrets, operation, signal);
    const result = await this.#executeSsh(connection, secrets, operation, signal);
    return { kind: "ssh", output: result.output, exitCode: result.exitCode };
  }
  async #executeSsh(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: Extract<ConnectionUseOperation, { kind: "ssh" }>, signal?: AbortSignal): Promise<SshCaptureResult> {
    if (connection.kind !== "ssh" || !connection.host || !connection.username) fail("SSH 连接资料不完整。");
    if (!secrets.password && !secrets.privateKey) fail("此连接缺少 SSH 登录凭据。");
    if (this.#platform === "win32") fail("此环境暂不支持安全的 SSH 凭据注入。", "connection_ssh_platform_unavailable");
    if (!operation.command.trim() || operation.command.length > 32_000 || operation.command.includes("\0")) fail("SSH 命令无效。");
    const timeout = operation.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_SSH_TIMEOUT_MS) fail("SSH 超时范围无效。");
    const knownHostsPath = this.#knownHosts(connection);
    this.#prepare();
    const session = await prepareSshAuthSession({
      host: connection.host,
      port: connection.port ?? 22,
      username: connection.username,
      secrets,
      knownHostsPath,
      timeoutMs: timeout,
      forwardingMode: "none",
      platform: this.#platform,
      signal,
    });
    try {
      return await captureSshProcess("ssh", [...session.args, operation.command], {
        signal,
        timeoutMs: timeout,
        environment: session.environment,
      });
    } finally {
      await session.cleanup();
    }
  }
  async #http(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: Extract<ConnectionUseOperation, { kind: "http" }>, signal?: AbortSignal): Promise<ConnectionUseResult> {
    if (connection.kind === "ssh" || !connection.url) fail("此连接未配置 API 或站点地址。");
    const trusted = this.#getExecutionTrustMode?.() === "trusted";
    const base = new URL(connection.url);
    if (base.username || base.password || base.search || base.hash) fail("连接地址必须是无凭据的有效地址。");
    if (isCloudMetadataHostOrIp(base.hostname)) fail("连接地址受安全策略阻止。", "connection_http_blocked");
    if (base.protocol === "http:") {
      if (!trusted || !isPrivateOrLoopbackHost(base.hostname)) {
        fail(
          !trusted && isPrivateOrLoopbackHost(base.hostname)
            ? "当前处于隔离沙箱模式，不允许执行内网 HTTP 连接；请改用 HTTPS 或切回本机信任模式。"
            : "连接地址必须是无凭据的 HTTPS 地址。",
          "connection_http_restricted",
        );
      }
    } else if (base.protocol !== "https:") {
      fail("连接地址必须是无凭据的 HTTPS 地址。");
    }
    if (!operation.path.startsWith("/") || operation.path.startsWith("//") || /[\x00-\x20\x7f\\]/.test(operation.path) || operation.path.length > 4_096) fail("请求必须使用连接站点内的相对路径。");
    const target = new URL(operation.path, base);
    if (target.origin !== base.origin || target.username || target.password) fail("连接凭据不能发送到其他站点。");
    const method = operation.method ?? "GET";
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) || operation.body !== undefined && (typeof operation.body !== "string" || operation.body.length > 64_000) || (method === "GET" || method === "HEAD") && operation.body !== undefined) fail("HTTP 请求参数无效。");
    const authHeaderName = connection.authType === "header" ? (connection.headerName ?? "X-API-Key") : undefined;
    const authHeaderLower = authHeaderName?.toLowerCase();
    const headers = new Headers({ Accept: "application/json, text/plain;q=0.9" });
    for (const [name, value] of Object.entries(operation.headers ?? {})) {
      const lower = name.toLowerCase();
      const allowedCustom = trusted
        ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name) && !FORBIDDEN_CUSTOM_HTTP_HEADERS.has(lower) && lower !== authHeaderLower
        : /^(accept|content-type|if-match|if-none-match)$/i.test(name);
      if (!allowedCustom || typeof value !== "string" || value.length > 1_024 || /[\r\n]/.test(value)) fail("请求头不在允许范围内。");
      headers.set(name, value);
    }
    if (operation.body !== undefined && !headers.has("Content-Type")) {
      let isJson = false;
      try { JSON.parse(operation.body); isJson = true; } catch { /* A plain-text request body is valid too. */ }
      headers.set("Content-Type", isJson ? "application/json" : "text/plain; charset=utf-8");
    }
    if ((connection.authType ?? (connection.kind === "account" ? "basic" : "bearer")) === "basic") {
      if (!connection.username || !secrets.password || connection.username.includes(":")) fail("账号密码不完整。");
      headers.set("Authorization", `Basic ${Buffer.from(`${connection.username}:${secrets.password}`).toString("base64")}`);
    } else if (connection.authType === "header") {
      const name = authHeaderName ?? "X-API-Key";
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name) || /^(host|cookie|set-cookie|proxy-authorization|connection|content-length|transfer-encoding)$/i.test(name) || !secrets.apiKey || /[\r\n]/.test(secrets.apiKey)) fail("API 认证信息无效。");
      headers.set(name, secrets.apiKey);
    } else {
      if (!secrets.apiKey || /[\r\n]/.test(secrets.apiKey)) fail("API Key 缺失或无效。");
      headers.set("Authorization", `Bearer ${secrets.apiKey}`);
    }
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    let response: Response;
    if (!trusted) {
      try { response = await this.#fetch(target, { method, headers, body: operation.body, redirect: "error", signal: requestSignal }); }
      catch { fail("连接请求未完成，请检查网络或授权状态。", "connection_http_failed"); }
    } else {
      let currentUrl = target;
      let currentMethod: string = method;
      let currentHeaders = headers;
      let currentBody: RequestInit["body"] = operation.body;
      let finalResponse: Response | undefined;
      for (let hop = 0; hop <= MAX_SAFE_HTTP_REDIRECTS; hop++) {
        try {
          finalResponse = await this.#fetch(currentUrl, {
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            redirect: "manual",
            signal: requestSignal,
          });
        } catch {
          fail("连接请求未完成，请检查网络或授权状态。", "connection_http_failed");
        }
        if (!SAFE_HTTP_REDIRECT_STATUSES.has(finalResponse.status)) break;
        const location = finalResponse.headers.get("location");
        await finalResponse.body?.cancel().catch(() => undefined);
        if (hop === MAX_SAFE_HTTP_REDIRECTS) {
          fail("HTTP 重定向次数过多。", "connection_redirect_limit");
        }
        const next = prepareSafeHttpRedirect({
          status: finalResponse.status,
          location,
          currentUrl,
          initialOrigin: base.origin,
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          authHeaderName,
        });
        if (next.url.protocol === "http:" && !isPrivateOrLoopbackHost(next.url.hostname)) {
          fail("重定向目标不允许降级到公网明文 HTTP。", "connection_redirect_blocked");
        } else if (next.url.protocol !== "https:" && next.url.protocol !== "http:") {
          fail("重定向目标协议无效。", "connection_redirect_blocked");
        }
        currentUrl = next.url;
        currentMethod = next.method;
        currentHeaders = next.headers;
        currentBody = next.body;
        finalResponse = undefined;
      }
      if (!finalResponse) fail("HTTP 重定向次数过多。", "connection_redirect_limit");
      response = finalResponse;
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (size < MAX_OUTPUT) {
          const next = await reader.read();
          if (next.done) break;
          const part = next.value.subarray(0, MAX_OUTPUT - size);
          chunks.push(part); size += part.byteLength;
          if (size >= MAX_OUTPUT) { await reader.cancel(); break; }
        }
      } finally { reader.releaseLock(); }
    }
    return { kind: "http", status: response.status, output: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
}
