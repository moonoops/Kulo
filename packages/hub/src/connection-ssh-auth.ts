import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ConnectionSecrets } from "@kulo/protocol";
import { normalizeSshPrivateKey } from "./connection-ssh-diagnostics.js";

export const MAX_SSH_CAPTURE_OUTPUT = 128_000;
const MAX_SSH_LINE_BUFFER = 4_096;

export interface SshCaptureOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  input?: string;
  /** Keep input verbatim instead of appending a trailing newline (e.g. single-line JSON protocol). */
  rawInput?: boolean;
  /** Keep stdin open after writing input so EOF on stop/abort signals the remote process to clean up. */
  keepStdinOpen?: boolean;
  /** Optional streaming callback invoked for each newline-delimited stdout line. */
  onStdoutLine?: (line: string) => void;
}

export interface SshCaptureResult {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
}

export interface PrepareSshAuthOptions {
  host: string;
  port?: number;
  username: string;
  secrets: ConnectionSecrets;
  knownHostsPath: string;
  timeoutMs: number;
  forwardingMode: "none" | "reverse-tunnel";
  reverseForward?: { remotePort: number; hubPort: number };
  disablePty?: boolean;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

export interface PreparedSshAuthSession {
  environment: NodeJS.ProcessEnv;
  /** Hardened OpenSSH arguments up to and including `-- <host>` (excluding the remote command). */
  args: string[];
  /** Idempotently destroys active askpass sockets, stops temporary ssh-agent, and removes temp dir. */
  cleanup: () => Promise<void>;
}

function fail(message: string, code = "connection_execution_failed", status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

export function sshConnectionAlias(host: string, port = 22): string {
  return `kulo-connection-${createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 24)}`;
}

/** Quotes a path passed to OpenSSH `-o` options so spaces (e.g. `Application Support`) are not split and `%` stays literal. */
export function sshConfigPath(label: string, filePath: string): string {
  if (!filePath || /["\x00-\x1f\x7f]/.test(filePath)) fail(`${label}无效。`, "connection_storage_invalid");
  return `"${filePath.replaceAll("%", "%%")}"`;
}

export function safeSshProcessEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
    LANG: "C",
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

export function captureSshProcess(
  binary: string,
  args: string[],
  options: SshCaptureOptions,
): Promise<SshCaptureResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: options.environment ?? safeSshProcessEnv(),
      stdio: [options.input !== undefined || options.keepStdinOpen ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "", stderr = "", output = "", settled = false, stopped = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stdoutDecoder = options.onStdoutLine ? new StringDecoder("utf8") : undefined;
    let stdoutLineBuffer = "";
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      if (options.keepStdinOpen && child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
        graceTimer = setTimeout(terminate, 2_500);
        graceTimer.unref();
        return;
      }
      terminate();
    };
    const timer = setTimeout(stop, options.timeoutMs);
    timer.unref();
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdout = (stdout + text).slice(-MAX_SSH_CAPTURE_OUTPUT);
      output = (output + text).slice(-MAX_SSH_CAPTURE_OUTPUT);
      if (options.onStdoutLine && stdoutDecoder) {
        const parts = (stdoutLineBuffer + stdoutDecoder.write(data)).split(/\r?\n/);
        stdoutLineBuffer = (parts.pop() ?? "").slice(-MAX_SSH_LINE_BUFFER);
        for (const line of parts) options.onStdoutLine(line);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderr = (stderr + text).slice(-MAX_SSH_CAPTURE_OUTPUT);
      output = (output + text).slice(-MAX_SSH_CAPTURE_OUTPUT);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error("本机未能启动连接程序，请检查 SSH 依赖。"), { code: "connection_program_unavailable", status: 503 }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.onStdoutLine && stdoutDecoder) {
        const tail = (stdoutLineBuffer + stdoutDecoder.end()).trim();
        stdoutLineBuffer = "";
        if (tail) options.onStdoutLine(tail);
      }
      if (stopped || options.signal?.aborted) {
        reject(Object.assign(new Error("连接操作已取消或超时。"), { code: "connection_cancelled", status: 409 }));
      } else {
        resolve({ stdout, stderr, output, exitCode: code ?? 1 });
      }
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => { /* The remote or auth program may exit before reading all stdin. */ });
      const payload = options.rawInput || options.input.endsWith("\n") ? options.input : `${options.input}\n`;
      if (options.keepStdinOpen) child.stdin?.write(payload);
      else child.stdin?.end(payload);
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
  if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1_000);
    timer.unref();
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Prepares an isolated, short-lived SSH authentication channel (private askpass Unix socket + optional
 * temporary ssh-agent). On any internal failure during setup, self-cleans before rethrowing.
 */
export async function prepareSshAuthSession(options: PrepareSshAuthOptions): Promise<PreparedSshAuthSession> {
  const platform = options.platform ?? process.platform;
  if (!options.host || !options.username) fail("SSH 连接资料不完整。");
  if (!options.secrets.password && !options.secrets.privateKey) fail("此连接缺少 SSH 登录凭据。");
  if (platform === "win32") fail("此环境暂不支持安全的 SSH 凭据注入。", "connection_ssh_platform_unavailable");
  const port = options.port ?? 22;
  if (!validPort(port)) fail("SSH 端口无效。");
  if (options.forwardingMode === "reverse-tunnel") {
    const rf = options.reverseForward;
    if (!rf || !validPort(rf.remotePort) || !validPort(rf.hubPort)) fail("SSH 转发端口无效。");
  }
  if (!fs.existsSync(options.knownHostsPath) || fs.lstatSync(options.knownHostsPath).isSymbolicLink()) {
    fail("请先在「授权凭据」中确认服务器指纹。", "connection_host_untrusted", 409);
  }
  const knownHostsOption = sshConfigPath("SSH 已知主机路径", options.knownHostsPath);

  // sockaddr_un paths are short on macOS; using stateDir here silently truncates long paths.
  const control = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kulo-connection-"));
  fs.chmodSync(control, 0o700);
  const socketPath = path.join(control, "a.sock");
  const scriptPath = path.join(control, "askpass.cjs");
  const executablePath = path.join(control, "askpass");
  const token = randomBytes(32).toString("hex");

  let agent: ChildProcess | undefined;
  let serverListening = false;
  let cleaned = false;
  const activeSockets = new Set<net.Socket>();
  let requests = 0;

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    let input = "";
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (part) => {
      input += part;
      if (input.length > 8_192) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      try {
        const request = JSON.parse(input.slice(0, input.indexOf("\n"))) as { token?: unknown; prompt?: unknown };
        if (request.token !== token || typeof request.prompt !== "string" || ++requests > 3) {
          socket.destroy();
          return;
        }
        const value = /passphrase/i.test(request.prompt) ? options.secrets.passphrase : options.secrets.password;
        if (!value || /[\r\n]/.test(value)) { socket.destroy(); return; }
        socket.end(`${value}\n`);
      } catch {
        socket.destroy();
      }
    });
  });

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const socket of activeSockets) socket.destroy();
    activeSockets.clear();
    try {
      if (agent) await stopAgent(agent);
    } finally {
      if (serverListening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(control, { recursive: true, force: true });
    }
  };

  try {
    options.signal?.throwIfAborted();
    // The script contains no secret; the runtime directory is outside every Worker filesystem grant.
    fs.writeFileSync(scriptPath, ASKPASS_SOURCE, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(
      executablePath,
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}' "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        serverListening = true;
        try {
          fs.chmodSync(socketPath, 0o600);
          server.removeListener("error", reject);
          resolve();
        } catch {
          reject(new Error("无法创建安全认证通道。"));
        }
      });
    });

    const environment: NodeJS.ProcessEnv = {
      ...safeSshProcessEnv(),
      SSH_ASKPASS: executablePath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "kulo:0",
      KULO_CONNECTION_ASKPASS_SOCKET: socketPath,
      KULO_CONNECTION_ASKPASS_TOKEN: token,
    };

    let identityArgs = ["-o", "IdentityAgent=none", "-o", "PubkeyAuthentication=no"];
    if (options.secrets.privateKey) {
      const agentSocket = path.join(control, "agent.sock");
      if (/[\s"%\x00-\x1f\x7f]/.test(agentSocket)) fail("SSH 认证通道路径无效。", "connection_storage_invalid");
      const keyTtl = String(Math.ceil(options.timeoutMs / 1000) + 15);
      agent = spawn("ssh-agent", ["-D", "-a", agentSocket, "-t", keyTtl], {
        env: safeSshProcessEnv(),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let agentError = false;
      agent.once("error", () => { agentError = true; });
      agent.stderr?.resume();
      for (let attempt = 0; attempt < 100 && !fs.existsSync(agentSocket) && !agentError; attempt++) {
        options.signal?.throwIfAborted();
        if (agent.exitCode !== null && agent.exitCode !== undefined) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      if (!fs.existsSync(agentSocket) || agentError) fail("无法启动本机安全 SSH 认证服务。", "connection_agent_unavailable", 503);
      fs.chmodSync(agentSocket, 0o600);
      environment.SSH_AUTH_SOCK = agentSocket;
      const added = await captureSshProcess("ssh-add", ["-t", keyTtl, "-"], {
        environment,
        input: normalizeSshPrivateKey(options.secrets.privateKey),
        timeoutMs: 10_000,
        signal: options.signal,
      });
      if (added.exitCode !== 0) fail("SSH 私钥或私钥口令无效。", "connection_key_invalid");
      const identities = await captureSshProcess("ssh-add", ["-L"], {
        environment,
        timeoutMs: 5_000,
        signal: options.signal,
      });
      const publicKeys = identities.stdout.trim().split(/\r?\n/);
      if (
        identities.exitCode !== 0 ||
        publicKeys.length !== 1 ||
        !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(publicKeys[0]!)
      ) {
        fail("SSH 身份加载失败。", "connection_key_invalid");
      }
      const publicFile = path.join(control, "identity.pub");
      fs.writeFileSync(publicFile, `${publicKeys[0]!.split(" ").slice(0, 2).join(" ")}\n`, { mode: 0o600, flag: "wx" });
      identityArgs = ["-o", `IdentityAgent=${agentSocket}`, "-i", publicFile];
    }

    const forwardingArgs = options.forwardingMode === "reverse-tunnel"
      ? [
          "-o", "ClearAllForwardings=no",
          "-o", "ExitOnForwardFailure=yes",
          "-R", `127.0.0.1:${options.reverseForward!.remotePort}:127.0.0.1:${options.reverseForward!.hubPort}`,
        ]
      : ["-o", "ClearAllForwardings=yes"];

    const args = [
      "-F", "/dev/null",
      ...(options.disablePty ? ["-T"] : []),
      ...(options.forwardingMode === "reverse-tunnel" ? ["-a", "-x"] : []),
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=no",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsOption}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", `HostKeyAlias=${sshConnectionAlias(options.host, port)}`,
      "-o", "IdentitiesOnly=yes",
      ...identityArgs,
      ...forwardingArgs,
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "PermitLocalCommand=no",
      "-o", "NumberOfPasswordPrompts=1",
      "-o", "ConnectTimeout=10",
      "-o", `ServerAliveInterval=${options.serverAliveIntervalSec ?? 10}`,
      "-o", `ServerAliveCountMax=${options.serverAliveCountMax ?? 2}`,
      "-o", options.secrets.privateKey ? "PreferredAuthentications=publickey" : "PreferredAuthentications=password",
      "-o", "KbdInteractiveAuthentication=no",
      "-p", String(port),
      "-l", options.username,
      "--",
      options.host,
    ];

    return { environment, args, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
