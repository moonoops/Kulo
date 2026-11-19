import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  acceptHostKey,
  connectSsh,
  RemoteExecutionEnv,
  scanHostKey,
  sshArguments,
  type SshTarget,
} from "@earendil-works/pi-env";
import type { DeviceSshRequest, DeviceSshScan } from "@kulo/protocol";

const SCAN_LIFETIME_MS = 5 * 60_000;
const TUNNEL_READY = "KULO-TUNNEL-READY";

export interface DeviceSshRecord {
  deviceId: string;
  target: SshTarget;
  remotePort: number;
  remoteNodePath: string;
  remoteShell?: "cmd" | "powershell";
  request: DeviceSshRequest;
}

export interface DeviceSshConnectorOptions {
  stateDir: string;
  hubPort: number | (() => number);
  createInvitation: (request: {
    name?: string;
    rootDir?: string;
    hubUrl: string;
    kind: "ssh";
  }) => Promise<{ deviceId: string; inviteToken: string }>;
  onError?: (deviceId: string, message: string) => void;
  onAddFailed?: (deviceId: string, message: string) => void;
}

interface PendingScan {
  request: DeviceSshRequest;
  target: SshTarget;
  lines: string[];
  expiresAt: number;
}

interface Tunnel {
  record: DeviceSshRecord;
  child?: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
  attempts: number;
  reconnect: boolean;
  stopped: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function validateDeviceSshRequest(value: DeviceSshRequest): DeviceSshRequest {
  if (!value || typeof value !== "object") throw new Error("请填写 SSH 连接信息。");
  const rawHost = typeof value.host === "string" ? value.host.trim() : "";
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (!host || host.length > 253 || (!net.isIP(host) && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host))) {
    throw new Error("SSH 主机名或 IP 无效。");
  }
  const user = typeof value.user === "string" ? value.user.trim() : undefined;
  if (user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]{0,127}$/.test(user)) throw new Error("SSH 用户名无效。");
  const port = value.port ?? 22;
  if (!validPort(port)) throw new Error("SSH 端口必须在 1 到 65535 之间。");
  const name = typeof value.name === "string" ? value.name.trim() : undefined;
  if (name && (name.length > 100 || /[\x00-\x1f\x7f]/.test(name))) throw new Error("设备名称无效。");
  const rootDir = typeof value.rootDir === "string" ? value.rootDir.trim() : undefined;
  if (rootDir && (rootDir.length > 4096 || /[\x00-\x1f\x7f]/.test(rootDir))) throw new Error("设备工作目录无效。");
  let hubUrl: URL;
  try { hubUrl = new URL(value.hubUrl); } catch { throw new Error("主脑地址无效。"); }
  if (!["http:", "https:"].includes(hubUrl.protocol) || hubUrl.username || hubUrl.password || hubUrl.search || hubUrl.hash || hubUrl.pathname !== "/") {
    throw new Error("主脑地址应为 HTTP 或 HTTPS 服务地址。");
  }
  return { host, port, ...(user ? { user } : {}), ...(name ? { name } : {}), ...(rootDir ? { rootDir } : {}), hubUrl: hubUrl.origin };
}

/** Pi Env disables forwarding; this dedicated connection restores it for the reverse listener. */
function remoteNodeCommand(nodePath: string, shell?: "cmd" | "powershell"): string {
  if (typeof nodePath !== "string" || !nodePath || nodePath.length > 4096 || /[\x00-\x1f\x7f]/.test(nodePath)) throw new Error("保存的设备 Node.js 路径无效。");
  if (shell !== undefined && shell !== "cmd" && shell !== "powershell") throw new Error("保存的设备 SSH Shell 无效。");
  if (shell) {
    if ((!/^[a-zA-Z]:[\\/]/.test(nodePath) && !nodePath.startsWith("\\\\")) || !path.win32.isAbsolute(nodePath) || /"/.test(nodePath) || (shell === "cmd" && /[%!]/.test(nodePath))) throw new Error("保存的设备 Node.js 路径无效。");
    return shell === "powershell" ? `& '${nodePath.replaceAll("'", "''")}'` : `"${nodePath}"`;
  }
  if (!path.posix.isAbsolute(nodePath)) throw new Error("保存的设备 Node.js 路径无效。");
  return `'${nodePath.replaceAll("'", "'\\''")}'`;
}

export function deviceTunnelArguments(target: SshTarget, remotePort: number, hubPort: number, nodePath: string, shell?: "cmd" | "powershell"): string[] {
  if (!validPort(remotePort) || !validPort(hubPort)) throw new Error("SSH 转发端口无效。");
  const nodeCommand = remoteNodeCommand(nodePath, shell);
  const original = sshArguments(target);
  const args: string[] = [];
  for (let i = 0; i < original.length; i++) {
    if (original[i] === "-o" && original[i + 1]?.startsWith("ClearAllForwardings=")) {
      i++;
      continue;
    }
    if (original[i] === "--") {
      args.push(
        "-o", "ClearAllForwardings=no",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveCountMax=3",
        "-R", `127.0.0.1:${remotePort}:127.0.0.1:${hubPort}`,
      );
    }
    args.push(original[i]!);
  }
  // A command starts only after ExitOnForwardFailure succeeds, so its marker proves forwarding is ready.
  args.push(`${nodeCommand} -e "console.log('${TUNNEL_READY}');process.stdin.resume()"`);
  return args;
}

const PREPARE_REMOTE = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('接入设备需要 Node.js 22.19 或更新版本。');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kulo-join-'));
fs.chmodSync(directory, 0o700);
const server = net.createServer();
server.once('error', error => { fs.rmSync(directory, {recursive:true, force:true}); throw error; });
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  server.close(() => console.log(JSON.stringify({directory, port, nodePath:process.execPath})));
});
`;

// Credentials travel in a private file over Pi Env, never inside the SSH command or bootstrap source.
const INSTALL_REMOTE = `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
(async () => {
  const configFile = process.argv[1];
  const directory = path.dirname(configFile);
  fs.chmodSync(configFile, 0o600);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const windows = process.platform === 'win32';
  const installer = path.join(directory, windows ? 'install.ps1' : 'install.sh');
  try {
    const response = await fetch(new URL(windows ? '/connect/install.ps1' : '/connect/install.sh', config.hubUrl), {redirect:'error', signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('无法下载设备安装程序：HTTP ' + response.status);
    fs.writeFileSync(installer, await response.text(), {mode:0o700});
    const command = windows ? 'powershell.exe' : 'sh';
    const args = windows ? ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',installer,config.hubUrl,config.inviteToken] : [installer,config.hubUrl,config.inviteToken];
    const environment = {...process.env};
    const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
    environment[pathKey] = path.dirname(process.execPath) + path.delimiter + (environment[pathKey] || '');
    const child = cp.spawn(command, args, {stdio:['ignore','pipe','pipe'], windowsHide:true, env:environment});
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const exit = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
    if (exit !== 0) throw new Error('设备安装程序退出：' + exit);
  } finally {
    fs.rmSync(directory, {recursive:true, force:true});
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

export class DeviceSshConnector {
  readonly #options: DeviceSshConnectorOptions;
  readonly #scans = new Map<string, PendingScan>();
  readonly #tunnels = new Map<string, Tunnel>();
  readonly #bootstraps = new Set<{ close(): void }>();
  #generation = 0;
  #closed = false;

  constructor(options: DeviceSshConnectorOptions) {
    this.#options = options;
  }

  #assertGeneration(generation: number): void {
    if (this.#closed || generation !== this.#generation) throw new Error("设备接入已取消。");
  }

  #target(request: DeviceSshRequest): SshTarget {
    const identity = createHash("sha256").update(JSON.stringify([request.host, request.port ?? 22, request.user ?? ""])).digest("hex").slice(0, 24);
    return {
      host: request.host,
      port: request.port ?? 22,
      ...(request.user ? { user: request.user } : {}),
      knownHostsFile: path.join(this.#options.stateDir, "device-ssh-known-hosts"),
      hostKeyAlias: `kulo-${identity}`,
    };
  }

  async scan(raw: DeviceSshRequest): Promise<DeviceSshScan> {
    if (this.#closed) throw new Error("设备连接服务已关闭。");
    const generation = this.#generation;
    const request = validateDeviceSshRequest(raw);
    for (const [id, scan] of this.#scans) if (scan.expiresAt <= Date.now()) this.#scans.delete(id);
    if (this.#scans.size >= 32) throw new Error("待确认的 SSH 连接过多，请稍后重试。");
    const target = this.#target(request);
    fs.mkdirSync(this.#options.stateDir, { recursive: true, mode: 0o700 });
    const result = await scanHostKey(target);
    this.#assertGeneration(generation);
    if (!result.lines.length || !result.fingerprints.length) throw new Error("SSH 主机未返回可验证的指纹。");
    const scanId = randomBytes(24).toString("hex");
    this.#scans.set(scanId, { request, target, lines: result.lines, expiresAt: Date.now() + SCAN_LIFETIME_MS });
    return { scanId, fingerprints: [...result.fingerprints] };
  }

  async add(scanId: string): Promise<DeviceSshRecord> {
    if (this.#closed) throw new Error("设备连接服务已关闭。");
    const generation = this.#generation;
    const scan = this.#scans.get(scanId);
    this.#scans.delete(scanId);
    if (!scan || scan.expiresAt <= Date.now()) throw new Error("SSH 指纹确认已过期或已使用，请重新连接。");
    await acceptHostKey(scan.target, scan.lines);
    this.#assertGeneration(generation);
    const { connection, remote } = await connectSsh({ ...scan.target, loginShell: true });
    this.#bootstraps.add(connection);
    const env = new RemoteExecutionEnv({ connection, id: `kulo:ssh-bootstrap:${scanId}`, cwd: remote.home });
    let directory: string | undefined;
    let deviceId: string | undefined;
    let inviteToken: string | undefined;
    try {
      this.#assertGeneration(generation);
      const prepared = await this.#exec(env, ["node", "-e", PREPARE_REMOTE], 30_000);
      let result: { directory?: unknown; port?: unknown; nodePath?: unknown };
      try { result = JSON.parse(prepared.trim()); } catch { throw new Error("无法读取设备的 Node.js 环境信息。"); }
      if (typeof result.directory !== "string" || typeof result.port !== "number" || !validPort(result.port)) throw new Error("设备返回了无效的连接信息。");
      if (typeof result.nodePath !== "string") throw new Error("设备未返回 Node.js 的完整路径。");
      const remoteShell = remote.platform === "windows" ? remote.shell ?? "cmd" : undefined;
      remoteNodeCommand(result.nodePath, remoteShell);
      directory = result.directory;
      this.#assertGeneration(generation);
      const hubUrl = `http://127.0.0.1:${result.port}`;
      const invitation = await this.#options.createInvitation({ name: scan.request.name, rootDir: scan.request.rootDir, hubUrl, kind: "ssh" });
      deviceId = invitation.deviceId;
      inviteToken = invitation.inviteToken;
      this.#assertGeneration(generation);
      const record: DeviceSshRecord = { deviceId, target: scan.target, remotePort: result.port, remoteNodePath: result.nodePath, ...(remoteShell ? { remoteShell } : {}), request: scan.request };
      const tunnel: Tunnel = { record, attempts: 0, reconnect: false, stopped: false };
      this.#tunnels.set(deviceId, tunnel);
      await this.#openTunnel(tunnel);
      this.#assertGeneration(generation);
      const joinPath = await env.joinPath([directory, "join.json"], BACKGROUND_CONTEXT);
      if (!joinPath.ok) throw new Error(`无法准备设备配对文件：${joinPath.error.message}`);
      this.#assertGeneration(generation);
      const write = await env.writeFile(joinPath.value, JSON.stringify({ hubUrl, inviteToken }), BACKGROUND_CONTEXT);
      if (!write.ok) throw new Error(`无法写入设备配对信息：${write.error.message}`);
      this.#assertGeneration(generation);
      await this.#exec(env, [record.remoteNodePath, "-e", INSTALL_REMOTE, joinPath.value], 300_000);
      directory = undefined;
      this.#assertGeneration(generation);
      if (tunnel.stopped) throw new Error("设备接入已取消。");
      tunnel.reconnect = true;
      return record;
    } catch (error) {
      if (deviceId) this.remove(deviceId);
      const detail = inviteToken ? messageOf(error).replaceAll(inviteToken, "[配对凭证]") : messageOf(error);
      if (deviceId) {
        if (this.#options.onAddFailed) this.#options.onAddFailed(deviceId, detail);
        else this.#options.onError?.(deviceId, detail);
      }
      throw new Error(`SSH 设备接入失败：${detail}`);
    } finally {
      try {
        if (directory) await env.remove(directory, { recursive: true, force: true }, BACKGROUND_CONTEXT);
      } finally {
        this.#bootstraps.delete(connection);
        connection.close();
      }
    }
  }

  async #exec(env: RemoteExecutionEnv, argv: string[], timeoutMs: number): Promise<string> {
    let output = "";
    const result = await env.exec(argv, { timeout: timeoutMs, onOutput: (chunk) => { output = (output + chunk).slice(-32_768); } }, BACKGROUND_CONTEXT);
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.exitCode !== 0) throw new Error(output.trim() || "设备上的命令执行失败；请确认已安装 Node.js 22.19 或更新版本。");
    return output;
  }

  #openTunnel(tunnel: Tunnel): Promise<void> {
    if (this.#closed || tunnel.stopped) return Promise.reject(new Error("设备连接已取消。"));
    const hubPort = typeof this.#options.hubPort === "function" ? this.#options.hubPort() : this.#options.hubPort;
    const args = deviceTunnelArguments(tunnel.record.target, tunnel.record.remotePort, hubPort, tunnel.record.remoteNodePath, tunnel.record.remoteShell);
    return new Promise((resolve, reject) => {
      const child = spawn(tunnel.record.target.ssh ?? "ssh", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C", LANG: "C" } });
      tunnel.child = child;
      let ready = false;
      let settled = false;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill(); fail(new Error("SSH 界面转发连接超时。")); }, 45_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString("utf8")).slice(-2048);
        if (!ready && stdout.includes(TUNNEL_READY)) {
          ready = true;
          settled = true;
          clearTimeout(timer);
          tunnel.attempts = 0;
          resolve();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
      child.once("error", (error) => fail(new Error(`无法启动 SSH：${error.message}`)));
      child.once("close", (code) => {
        clearTimeout(timer);
        if (tunnel.child === child) tunnel.child = undefined;
        const detail = stderr.trim() || `SSH 连接已断开（${code ?? "无退出码"}）。`;
        if (!ready) fail(new Error(detail));
        if (ready && tunnel.reconnect && !tunnel.stopped && !this.#closed) {
          this.#options.onError?.(tunnel.record.deviceId, detail);
          this.#scheduleReconnect(tunnel);
        }
      });
    });
  }

  #scheduleReconnect(tunnel: Tunnel): void {
    if (tunnel.timer || tunnel.stopped || this.#closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(tunnel.attempts++, 5));
    tunnel.timer = setTimeout(() => {
      tunnel.timer = undefined;
      void this.#openTunnel(tunnel).catch((error) => {
        if (tunnel.stopped || this.#closed) return;
        this.#options.onError?.(tunnel.record.deviceId, messageOf(error));
        this.#scheduleReconnect(tunnel);
      });
    }, delay);
    tunnel.timer.unref();
  }

  async restore(records: readonly DeviceSshRecord[]): Promise<void> {
    if (this.#closed) throw new Error("设备连接服务已关闭。");
    await Promise.all(records.map(async (stored) => {
      let tunnel: Tunnel | undefined;
      try {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(stored.deviceId) || !validPort(stored.remotePort)) throw new Error("保存的 SSH 设备连接无效。");
        remoteNodeCommand(stored.remoteNodePath, stored.remoteShell);
        const request = validateDeviceSshRequest(stored.request);
        const record = { ...stored, request, target: this.#target(request) };
        this.remove(record.deviceId);
        tunnel = { record, attempts: 0, reconnect: true, stopped: false };
        this.#tunnels.set(record.deviceId, tunnel);
        await this.#openTunnel(tunnel);
      } catch (error) {
        this.#options.onError?.(stored.deviceId, messageOf(error));
        if (tunnel) this.#scheduleReconnect(tunnel);
      }
    }));
  }

  remove(deviceId: string): void {
    const tunnel = this.#tunnels.get(deviceId);
    if (!tunnel) return;
    tunnel.stopped = true;
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.child?.stdin.end();
    tunnel.child?.kill();
    this.#tunnels.delete(deviceId);
  }

  cancelPending(): void {
    this.#generation++;
    this.#scans.clear();
    for (const connection of this.#bootstraps) connection.close();
    this.#bootstraps.clear();
    for (const id of this.#tunnels.keys()) this.remove(id);
  }

  close(): void {
    this.#closed = true;
    this.cancelPending();
  }
}
