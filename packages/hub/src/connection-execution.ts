import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { ConnectionRecordView, ConnectionSecrets, ConnectionUseOperation, ConnectionUseResult } from "@kulo/protocol";
import { LocalConnectionApplications, type ConnectionApplicationBackend } from "./connection-applications.js";
import {
  SSH_KEYSCAN_LINE,
  classifySshScanFailure,
  computeSshKnownHostsFingerprint,
  formatSshHostFingerprints,
  normalizeSshPrivateKey,
} from "./connection-ssh-diagnostics.js";

const MAX_OUTPUT = 128_000;
const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;
export interface ConnectionHostScan { fingerprint: string; lines: string[] }
export interface ConnectionSshProbeResult { exitCode: number; stderr: string; output: string }
export interface ConnectionExecutionBackend {
  scan(connection: ConnectionRecordView, signal?: AbortSignal): Promise<ConnectionHostScan>;
  trust(connection: ConnectionRecordView, scan: ConnectionHostScan): Promise<void>;
  hasTrustedHost?(connection: ConnectionRecordView, expectedFingerprint?: string): boolean;
  clearTrustedHost?(connection: ConnectionRecordView): void;
  probeSsh?(connection: ConnectionRecordView, secrets: ConnectionSecrets, signal?: AbortSignal): Promise<ConnectionSshProbeResult>;
  execute(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: ConnectionUseOperation, signal?: AbortSignal): Promise<ConnectionUseResult>;
}

function fail(message: string, code = "connection_execution_failed"): never {
  throw Object.assign(new Error(message), { code, status: 400 });
}
function alias(connection: ConnectionRecordView): string {
  return `kulo-connection-${createHash("sha256").update(`${connection.host}:${connection.port ?? 22}`).digest("hex").slice(0, 24)}`;
}
/** Quotes a path passed to OpenSSH `-o` options so spaces (e.g. `Application Support`) are not split and `%` stays literal. */
function sshConfigPath(label: string, filePath: string): string {
  if (!filePath || /["\x00-\x1f\x7f]/.test(filePath)) fail(`${label}无效。`, "connection_storage_invalid");
  return `"${filePath.replaceAll("%", "%%")}"`;
}
function safeProcessEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
    LANG: "C",
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}
interface CaptureOptions { signal?: AbortSignal; timeoutMs: number; environment?: NodeJS.ProcessEnv; input?: string }
interface CaptureResult { stdout: string; stderr: string; output: string; exitCode: number }
function capture(binary: string, args: string[], options: CaptureOptions): Promise<CaptureResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: options.environment ?? safeProcessEnv(), stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", output = "", settled = false, stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, options.timeoutMs);
    timer.unref();
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdout = (stdout + text).slice(-MAX_OUTPUT);
      output = (output + text).slice(-MAX_OUTPUT);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderr = (stderr + text).slice(-MAX_OUTPUT);
      output = (output + text).slice(-MAX_OUTPUT);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true; cleanup();
      reject(Object.assign(new Error("本机未能启动连接程序，请检查 SSH 依赖。"), { code: "connection_program_unavailable", status: 503 }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true; cleanup();
      if (stopped || options.signal?.aborted) reject(Object.assign(new Error("连接操作已取消或超时。"), { code: "connection_cancelled", status: 409 }));
      else resolve({ stdout, stderr, output, exitCode: code ?? 1 });
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => { /* The authentication program may reject input before consuming all of it. */ });
      child.stdin?.end(options.input.endsWith("\n") ? options.input : `${options.input}\n`);
    }
    // Abort may arrive between the preflight and listener registration.
    if (options.signal?.aborted) stop();
  });
}

const ASKPASS_SOURCE = `#!/usr/bin/env node
const net = require('node:net');
const socket = net.createConnection(process.env.KULO_CONNECTION_ASKPASS_SOCKET);
let result = '';
socket.setTimeout(5000, () => { socket.destroy(); process.exit(1); });
socket.once('connect', () => socket.write(JSON.stringify({token:process.env.KULO_CONNECTION_ASKPASS_TOKEN,prompt:process.argv[2] || ''}) + '\\n'));
socket.on('data', chunk => { result += chunk; if (result.length > 131072) {socket.destroy();process.exit(1);} });
socket.on('end', () => { process.stdout.write(result); });
socket.on('error', () => process.exit(1));
`;

async function stopAgent(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1_000);
    timer.unref();
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

/** Authentication material travels over pipes into a dedicated native agent or a private, short-lived socket. */
export class LocalConnectionExecutor implements ConnectionExecutionBackend {
  readonly #directory: string;
  readonly #fetch: typeof fetch;
  readonly #applications: ConnectionApplicationBackend;
  readonly #platform: NodeJS.Platform;
  constructor(options: { stateDir: string; fetch?: typeof fetch; applications?: ConnectionApplicationBackend; platform?: NodeJS.Platform }) {
    this.#directory = path.join(options.stateDir, "connection-runtime");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#platform = options.platform ?? process.platform;
    this.#applications = options.applications ?? new LocalConnectionApplications({ stateDir: options.stateDir, platform: this.#platform });
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
  clearTrustedHost(connection: ConnectionRecordView): void {
    if (connection.kind !== "ssh") return;
    try { fs.rmSync(this.#knownHosts(connection), { force: true }); } catch { /* Best-effort cleanup of stale known-hosts. */ }
  }
  async scan(connection: ConnectionRecordView, signal?: AbortSignal): Promise<ConnectionHostScan> {
    if (connection.kind !== "ssh" || !connection.host || connection.host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(connection.host)) fail("请先填写有效的 SSH 主机地址。");
    const result = await capture("ssh-keyscan", ["-T", "5", "-p", String(connection.port ?? 22), "--", connection.host], { timeoutMs: 10_000, signal });
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
  async #executeSsh(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: Extract<ConnectionUseOperation, { kind: "ssh" }>, signal?: AbortSignal): Promise<CaptureResult> {
    if (connection.kind !== "ssh" || !connection.host || !connection.username) fail("SSH 连接资料不完整。");
    if (!secrets.password && !secrets.privateKey) fail("此连接缺少 SSH 登录凭据。");
    if (this.#platform === "win32") fail("此环境暂不支持安全的 SSH 凭据注入。", "connection_ssh_platform_unavailable");
    if (!operation.command.trim() || operation.command.length > 32_000 || operation.command.includes("\0")) fail("SSH 命令无效。");
    const timeout = operation.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) fail("SSH 超时范围无效。");
    const knownHostsPath = this.#knownHosts(connection);
    if (!fs.existsSync(knownHostsPath) || fs.lstatSync(knownHostsPath).isSymbolicLink()) fail("请先在连接授权页确认服务器指纹。", "connection_host_untrusted");
    const knownHostsOption = sshConfigPath("SSH 已知主机路径", knownHostsPath);
    this.#prepare();
    // sockaddr_un paths are short on macOS; using stateDir here silently truncates long paths.
    const control = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kulo-connection-"));
    fs.chmodSync(control, 0o700);
    const socketPath = path.join(control, "a.sock");
    const scriptPath = path.join(control, "askpass.cjs");
    const executablePath = path.join(control, "askpass");
    const token = randomBytes(32).toString("hex");
    // The script contains no secret; the runtime directory is outside every Worker filesystem grant.
    fs.writeFileSync(scriptPath, ASKPASS_SOURCE, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(executablePath, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700, flag: "wx" });
    let requests = 0;
    const server = net.createServer((socket) => {
      let input = "";
      socket.setTimeout(5_000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("data", (part) => {
        input += part;
        if (input.length > 8_192) { socket.destroy(); return; }
        if (!input.includes("\n")) return;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n"))) as { token?: unknown; prompt?: unknown };
          if (request.token !== token || typeof request.prompt !== "string" || ++requests > 3) { socket.destroy(); return; }
          const value = /passphrase/i.test(request.prompt) ? secrets.passphrase : secrets.password;
          if (!value || /[\r\n]/.test(value)) { socket.destroy(); return; }
          socket.end(`${value}\n`);
        } catch { socket.destroy(); }
      });
    });
    let agent: ChildProcess | undefined;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { try { fs.chmodSync(socketPath, 0o600); server.removeListener("error", reject); resolve(); } catch { reject(new Error("无法创建安全认证通道。")); } }); });
      const environment: NodeJS.ProcessEnv = { ...safeProcessEnv(), SSH_ASKPASS: executablePath, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "kulo:0",
        KULO_CONNECTION_ASKPASS_SOCKET: socketPath, KULO_CONNECTION_ASKPASS_TOKEN: token };
      let identityArgs = ["-o", "IdentityAgent=none", "-o", "PubkeyAuthentication=no"];
      if (secrets.privateKey) {
        const agentSocket = path.join(control, "agent.sock");
        if (/[\s"%\x00-\x1f\x7f]/.test(agentSocket)) fail("SSH 认证通道路径无效。", "connection_storage_invalid");
        agent = spawn("ssh-agent", ["-D", "-a", agentSocket, "-t", String(Math.ceil(timeout / 1000) + 15)], { env: safeProcessEnv(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        let agentError = false;
        agent.once("error", () => { agentError = true; });
        agent.stderr?.resume();
        for (let attempt = 0; attempt < 100 && !fs.existsSync(agentSocket) && !agentError; attempt++) {
          signal?.throwIfAborted();
          if (agent.exitCode !== null && agent.exitCode !== undefined) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        if (!fs.existsSync(agentSocket) || agentError) fail("无法启动本机安全 SSH 认证服务。", "connection_agent_unavailable");
        fs.chmodSync(agentSocket, 0o600);
        environment.SSH_AUTH_SOCK = agentSocket;
        const added = await capture("ssh-add", ["-t", String(Math.ceil(timeout / 1000) + 15), "-"], { environment, input: normalizeSshPrivateKey(secrets.privateKey), timeoutMs: 10_000, signal });
        if (added.exitCode !== 0) fail("SSH 私钥或私钥口令无效。", "connection_key_invalid");
        const identities = await capture("ssh-add", ["-L"], { environment, timeoutMs: 5_000, signal });
        const publicKeys = identities.stdout.trim().split(/\r?\n/);
        if (identities.exitCode !== 0 || publicKeys.length !== 1 || !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(publicKeys[0]!)) fail("SSH 身份加载失败。", "connection_key_invalid");
        const publicFile = path.join(control, "identity.pub");
        fs.writeFileSync(publicFile, `${publicKeys[0]!.split(" ").slice(0, 2).join(" ")}\n`, { mode: 0o600, flag: "wx" });
        identityArgs = ["-o", `IdentityAgent=${agentSocket}`, "-i", publicFile];
      }
      const args = ["-F", "/dev/null", "-o", "LogLevel=ERROR", "-o", "BatchMode=no", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsOption}`,
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=${alias(connection)}`, "-o", "IdentitiesOnly=yes", ...identityArgs,
        "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "PermitLocalCommand=no",
        "-o", "NumberOfPasswordPrompts=1", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
        "-o", secrets.privateKey ? "PreferredAuthentications=publickey" : "PreferredAuthentications=password", "-o", "KbdInteractiveAuthentication=no",
        "-p", String(connection.port ?? 22), "-l", connection.username, "--", connection.host, operation.command];
      return await capture("ssh", args, { signal, timeoutMs: timeout, environment });
    } finally {
      if (agent) await stopAgent(agent);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(control, { recursive: true, force: true });
    }
  }
  async #http(connection: ConnectionRecordView, secrets: ConnectionSecrets, operation: Extract<ConnectionUseOperation, { kind: "http" }>, signal?: AbortSignal): Promise<ConnectionUseResult> {
    if (connection.kind === "ssh" || !connection.url) fail("此连接未配置 API 或站点地址。");
    const base = new URL(connection.url);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) fail("连接地址必须是无凭据的 HTTPS 地址。");
    if (!operation.path.startsWith("/") || operation.path.startsWith("//") || /[\x00-\x20\x7f\\]/.test(operation.path) || operation.path.length > 4_096) fail("请求必须使用连接站点内的相对路径。");
    const target = new URL(operation.path, base);
    if (target.origin !== base.origin || target.username || target.password) fail("连接凭据不能发送到其他站点。");
    const method = operation.method ?? "GET";
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) || operation.body !== undefined && (typeof operation.body !== "string" || operation.body.length > 64_000) || (method === "GET" || method === "HEAD") && operation.body !== undefined) fail("HTTP 请求参数无效。");
    const headers = new Headers({ Accept: "application/json, text/plain;q=0.9" });
    for (const [name, value] of Object.entries(operation.headers ?? {})) {
      if (!/^(accept|content-type|if-match|if-none-match)$/i.test(name) || typeof value !== "string" || value.length > 1_024 || /[\r\n]/.test(value)) fail("请求头不在允许范围内。");
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
      const name = connection.headerName ?? "X-API-Key";
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name) || /^(host|cookie|set-cookie|proxy-authorization|connection|content-length|transfer-encoding)$/i.test(name) || !secrets.apiKey || /[\r\n]/.test(secrets.apiKey)) fail("API 认证信息无效。");
      headers.set(name, secrets.apiKey);
    } else {
      if (!secrets.apiKey || /[\r\n]/.test(secrets.apiKey)) fail("API Key 缺失或无效。");
      headers.set("Authorization", `Bearer ${secrets.apiKey}`);
    }
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    let response: Response;
    try { response = await this.#fetch(target, { method, headers, body: operation.body, redirect: "error", signal: requestSignal }); }
    catch { fail("连接请求未完成，请检查网络或授权状态。", "connection_http_failed"); }
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
