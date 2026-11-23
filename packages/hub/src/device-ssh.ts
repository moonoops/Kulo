import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { INSTALL_STAGE_MARKER } from "@kulo/env";
import type {
  DeviceSshAddRequest,
  DeviceSshOnboardingStage,
  DeviceSshOnboardingStatus,
} from "@kulo/protocol";
import {
  captureSshProcess,
  prepareSshAuthSession,
  type PreparedSshAuthSession,
} from "./connection-ssh-auth.js";
import { classifySshExecutionFailure } from "./connection-ssh-diagnostics.js";
import type { DeviceSshConnectionEvent, ResolvedDeviceSshCredential } from "./connections.js";
import {
  NO_NODE_MARKER,
  POSIX_PREPARE_COMMAND,
  PREPARE_MARKER,
  WINDOWS_PREPARE_COMMAND,
  buildPosixNodeBootstrapCommand,
  buildWindowsNodeBootstrapCommand,
  extractBootstrapError,
  parseNoNodeMarker,
  resolveManagedNodeTarget,
} from "./device-ssh-node.js";

const CONNECTION_ID_RE = /^connection-[a-f0-9-]{16,64}$/;
const TUNNEL_READY = "KULO-TUNNEL-READY";
const TUNNEL_READY_EXPR = `console.log('${TUNNEL_READY}');process.stdin.resume()`;
const NODE_BOOTSTRAP_TIMEOUT_MS = 240_000;
const INSTALL_REMOTE_TIMEOUT_MS = 330_000;
const CANCELLING_WAIT_MS = 3_500;
const INSTALL_STAGE_SET = new Set<DeviceSshOnboardingStage>(["downloading-peer", "installing-deps", "pairing"]);

export type RemoteSshShell = "cmd" | "powershell" | "git-bash";

export interface DeviceSshRecord {
  deviceId: string;
  connectionId: string;
  remotePort: number;
  remoteNodePath: string;
  remoteShell?: RemoteSshShell;
  name?: string;
  rootDir?: string;
}

/** Legacy record format preserved only so startup restore can surface a clean migration message. */
export interface LegacyDeviceSshRecord {
  deviceId: string;
  target: { host: string; port?: number; user?: string };
  remotePort: number;
  remoteNodePath: string;
  remoteShell?: "cmd" | "powershell";
  request?: unknown;
}

export type StoredDeviceSshRecord = DeviceSshRecord | LegacyDeviceSshRecord;

export interface DeviceSshCredentialProvider {
  resolveVerified(connectionId: string): Promise<ResolvedDeviceSshCredential>;
  resolveForRestore(connectionId: string): Promise<ResolvedDeviceSshCredential>;
}

export interface DeviceSshConnectorOptions {
  hubPort: number | (() => number);
  credentials: DeviceSshCredentialProvider;
  findBoundDevice?: (connectionId: string) => { id: string; name: string } | undefined;
  createInvitation: (request: {
    name?: string;
    rootDir?: string;
    hubUrl: string;
    kind: "ssh";
  }) => Promise<{ deviceId: string; inviteToken: string }>;
  onError?: (deviceId: string, message: string) => void;
  onAddFailed?: (deviceId: string, message: string) => void;
  redact?: (text: string) => string;
  platform?: NodeJS.Platform;
}

interface Tunnel {
  record: DeviceSshRecord;
  child?: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
  attempts: number;
  reconnect: boolean;
  stopped: boolean;
  pausedForReverify: boolean;
  connected: boolean;
}

interface ActiveAdd {
  controller: AbortController;
  cancelling: boolean;
  done: Promise<void>;
  progress: DeviceSshOnboardingStatus;
}

const PAUSED_REVERIFY_CODES = new Set([
  "connection_host_untrusted",
  "connection_host_mismatch",
  "connection_not_found",
  "connection_ssh_unverified",
  "connection_credential_missing",
  "invalid_connection",
]);

function fail(message: string, code = "device_ssh_error", status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function isCredentialDeviceSshRecord(value: unknown): value is DeviceSshRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.connectionId === "string" && CONNECTION_ID_RE.test(rec.connectionId);
}

export function validateDeviceSshAddRequest(value: DeviceSshAddRequest): DeviceSshAddRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("请选择已验证的 SSH 凭据。");
  const connectionId = typeof value.connectionId === "string" ? value.connectionId.trim() : "";
  if (!CONNECTION_ID_RE.test(connectionId)) fail("请选择有效的 SSH 凭据。");
  const name = typeof value.name === "string" ? value.name.trim() : undefined;
  if (name && (name.length > 100 || /[\x00-\x1f\x7f]/.test(name))) fail("设备名称无效。");
  const rootDir = typeof value.rootDir === "string" ? value.rootDir.trim() : undefined;
  if (rootDir && (rootDir.length > 4096 || /[\x00-\x1f\x7f]/.test(rootDir))) fail("设备工作目录无效。");
  return { connectionId, ...(name ? { name } : {}), ...(rootDir ? { rootDir } : {}) };
}

export function remoteNodeCommand(nodePath: string, shell?: RemoteSshShell): string {
  if (typeof nodePath !== "string" || !nodePath || nodePath.length > 4096 || /[\x00-\x1f\x7f]/.test(nodePath)) {
    throw new Error("保存的设备 Node.js 路径无效。");
  }
  if (shell !== undefined && shell !== "cmd" && shell !== "powershell" && shell !== "git-bash") {
    throw new Error("保存的设备 SSH Shell 无效。");
  }
  if (shell === "cmd" || shell === "powershell") {
    if ((!/^[a-zA-Z]:[\\/]/.test(nodePath) && !nodePath.startsWith("\\\\")) || !path.win32.isAbsolute(nodePath) || /"/.test(nodePath) || (shell === "cmd" && /[%!]/.test(nodePath))) {
      throw new Error("保存的设备 Node.js 路径无效。");
    }
    return shell === "powershell" ? `& '${nodePath.replaceAll("'", "''")}'` : `"${nodePath}"`;
  }
  if (shell === "git-bash") {
    if (!path.posix.isAbsolute(nodePath) && !path.win32.isAbsolute(nodePath)) {
      throw new Error("保存的设备 Node.js 路径无效。");
    }
    return `'${nodePath.replaceAll("'", "'\\''")}'`;
  }
  if (!path.posix.isAbsolute(nodePath)) throw new Error("保存的设备 Node.js 路径无效。");
  return `'${nodePath.replaceAll("'", "'\\''")}'`;
}

/**
 * Wraps a short, shell-safe JS expression for `node -e` across POSIX, Windows `cmd`, PowerShell 5.1/7, and Git Bash.
 * Enforces zero whitespace, double quotes, `$`, backticks, or backslashes so no shell modifies the payload.
 */
export function buildRemoteNodeEvalCommand(nodePath: string, expression: string, shell?: RemoteSshShell): string {
  if (!expression || /["$`\\\s\x00-\x1f\x7f]/.test(expression)) {
    throw new Error("远端 Node 执行表达式包含不受支持的字符。");
  }
  return `${remoteNodeCommand(nodePath, shell)} -e "${expression}"`;
}

export function buildRemoteNodeBase64Command(nodePath: string, script: string, shell?: RemoteSshShell): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return buildRemoteNodeEvalCommand(nodePath, `eval(Buffer.from('${b64}','base64').toString())`, shell);
}

/**
 * Reads a single `\n`-delimited JSON line from stdin (never waiting for EOF, which Windows sshd may omit),
 * optionally watches stdin EOF/close (`watchStdin: true`) so SSH timeout or cancel cleanly terminates the entire
 * installer process group, fetches the installer over the reverse tunnel, passes inviteToken via KULO_PEER_INVITE
 * env var (zero argv exposure), and cleans up the temp dir in finally.
 */
export const INSTALL_REMOTE = `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
function readLine(){return new Promise((res,rej)=>{let buf='',done=false;const t=setTimeout(()=>{if(!done){done=true;process.stdin.destroy();rej(new Error('等待设备配对参数超时。'));}},10000);const onEnd=()=>{if(!done){done=true;clearTimeout(t);if(buf.trim())res(buf.trim());else rej(new Error('未收到设备配对参数。'));}};const onErr=e=>{if(!done){done=true;clearTimeout(t);rej(e);}};const onData=c=>{if(done)return;buf+=c.toString('utf8');if(Buffer.byteLength(buf,'utf8')>16384){done=true;clearTimeout(t);process.stdin.destroy();rej(new Error('设备配对参数过长。'));return;}const i=buf.indexOf('\\n');if(i!==-1){done=true;clearTimeout(t);process.stdin.off('data',onData);process.stdin.off('end',onEnd);process.stdin.off('error',onErr);res(buf.slice(0,i).replace(/\\r$/,''));}};process.stdin.on('data',onData);process.stdin.once('end',onEnd);process.stdin.once('error',onErr);process.stdin.resume();});}
(async()=>{
  const raw=await readLine();
  const cfg=JSON.parse(raw);
  if(!cfg||typeof cfg.hubUrl!=='string'||typeof cfg.inviteToken!=='string')throw new Error('设备配对参数无效。');
  const win=process.platform==='win32';
  const watchStdin=cfg.watchStdin===true;
  const drain=()=>{};
  const fetchAc=new AbortController();
  let cancelled=false,finished=false,activeChild=null,killTimer=null;
  const killChild=()=>{
    const ch=activeChild;
    if(!ch||!ch.pid||ch.exitCode!==null||ch.signalCode!==null)return;
    if(win){
      const root=process.env.SystemRoot||process.env.windir;
      const tk=root?path.join(root,'System32','taskkill.exe'):'taskkill.exe';
      const k=cp.spawn(tk,['/pid',String(ch.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
      k.on('error',()=>{try{ch.kill();}catch{}});
      return;
    }
    try{process.kill(-ch.pid,'SIGTERM');}catch{try{ch.kill('SIGTERM');}catch{}}
    if(!killTimer){
      killTimer=setTimeout(()=>{try{process.kill(-ch.pid,'SIGKILL');}catch{try{ch.kill('SIGKILL');}catch{}}},1000);
      killTimer.unref();
    }
  };
  const cancel=()=>{if(finished||cancelled)return;cancelled=true;fetchAc.abort();killChild();};
  process.on('SIGTERM',cancel);
  process.on('SIGINT',cancel);
  process.on('SIGHUP',cancel);
  if(watchStdin){
    process.stdin.on('data',drain);
    process.stdin.once('end',cancel);
    process.stdin.once('close',cancel);
    process.stdin.once('error',cancel);
    if(typeof process.stdin.unref==='function')process.stdin.unref();
    if(process.stdin.readableEnded||process.stdin.destroyed)cancel();
  }else{
    process.stdin.pause();
    process.stdin.destroy();
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kulo-join-'));
  try{
    if(cancelled)throw new Error('设备安装已取消。');
    if(!win)fs.chmodSync(dir,0o700);
    const installer=path.join(dir,win?'install.ps1':'install.sh');
    const resp=await fetch(new URL(win?'/connect/install.ps1':'/connect/install.sh',cfg.hubUrl),{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),fetchAc.signal])});
    if(!resp.ok)throw new Error('无法下载设备安装程序：HTTP '+resp.status);
    fs.writeFileSync(installer,await resp.text(),{mode:0o700});
    if(cancelled)throw new Error('设备安装已取消。');
    const cmd=win?'powershell.exe':'sh';
    const args=win?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',installer,cfg.hubUrl]:[installer,cfg.hubUrl];
    const env={...process.env,KULO_PEER_INVITE:cfg.inviteToken,KULO_INSTALL_PROGRESS:'1'};
    const pk=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
    env[pk]=path.dirname(process.execPath)+path.delimiter+(env[pk]||'');
    const child=cp.spawn(cmd,args,{stdio:['ignore','pipe','pipe'],detached:!win,windowsHide:true,env});
    activeChild=child;
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    if(cancelled)killChild();
    const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});
    finished=true;
    if(killTimer){clearTimeout(killTimer);killTimer=null;}
    if(cancelled)throw new Error('设备安装已取消。');
    if(code!==0)throw new Error('设备安装程序退出：'+code);
  }finally{
    finished=true;
    if(killTimer){clearTimeout(killTimer);killTimer=null;}
    process.off('SIGTERM',cancel);
    process.off('SIGINT',cancel);
    process.off('SIGHUP',cancel);
    process.stdin.off('data',drain);
    process.stdin.off('end',cancel);
    process.stdin.off('close',cancel);
    process.stdin.off('error',cancel);
    try{process.stdin.destroy();}catch{}
    fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e&&e.message?e.message:String(e));process.exitCode=1;});
`.trim();

function parsePreparedPayload(stdout: string): { port: number; nodePath: string; platform: string } {
  const lines = stdout.split(/\r?\n/);
  const markerLine = lines.find((line) => line.startsWith(PREPARE_MARKER));
  if (!markerLine) throw new Error("无法读取设备的 Node.js 环境信息。");
  let parsed: { port?: unknown; nodePath?: unknown; platform?: unknown };
  try { parsed = JSON.parse(markerLine.slice(PREPARE_MARKER.length)); } catch { throw new Error("无法读取设备的 Node.js 环境信息。"); }
  if (typeof parsed.port !== "number" || !validPort(parsed.port)) throw new Error("设备返回了无效的连接端口。");
  if (typeof parsed.nodePath !== "string" || !parsed.nodePath) throw new Error("设备未返回 Node.js 的完整路径。");
  if (typeof parsed.platform !== "string" || !parsed.platform) throw new Error("设备未返回操作系统类型。");
  return { port: parsed.port, nodePath: parsed.nodePath, platform: parsed.platform };
}

function summarizeScriptFailure(stdout: string, stderr: string, fallback: string): string {
  const text = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ");
  return text ? text.slice(0, 400) : fallback;
}

export class DeviceSshConnector {
  readonly #options: DeviceSshConnectorOptions;
  readonly #platform: NodeJS.Platform;
  readonly #tunnels = new Map<string, Tunnel>();
  readonly #activeAdds = new Map<string, ActiveAdd>();
  readonly #bootstraps = new Set<AbortController>();
  #generation = 0;
  #closed = false;

  constructor(options: DeviceSshConnectorOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
  }

  isAddingConnection(connectionId: string): boolean {
    return this.#activeAdds.has(connectionId);
  }

  listOnboardingProgress(): DeviceSshOnboardingStatus[] {
    const entries: DeviceSshOnboardingStatus[] = [];
    for (const active of this.#activeAdds.values()) {
      if (!active.cancelling) entries.push({ ...active.progress });
    }
    return entries;
  }

  #assertActive(generation: number, signal?: AbortSignal): void {
    if (this.#closed || generation !== this.#generation || signal?.aborted) {
      fail("设备接入已取消。", "device_ssh_cancelled", 409);
    }
  }

  async #waitForCancelling(existing: ActiveAdd, signal?: AbortSignal): Promise<void> {
    if (!existing.cancelling) fail("正在通过此 SSH 凭据接入设备，请稍候。", "device_ssh_adding", 409);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        existing.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CANCELLING_WAIT_MS);
          timer.unref();
          if (signal) {
            if (signal.aborted) { resolve(); return; }
            onAbort = () => resolve();
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) fail("设备接入已取消。", "device_ssh_cancelled", 409);
  }

  #redact(text: string, inviteToken?: string): string {
    const withoutInvite = inviteToken ? text.replaceAll(inviteToken, "[配对凭证]") : text;
    return this.#options.redact ? this.#options.redact(withoutInvite) : withoutInvite;
  }

  #classifyTransportFailure(
    resolved: ResolvedDeviceSshCredential,
    input: { error?: unknown; exitCode?: number; stderr?: string; output?: string },
  ): Error {
    const diag = classifySshExecutionFailure({
      error: input.error,
      exitCode: input.exitCode,
      stderr: input.stderr,
      output: input.output,
      host: resolved.connection.host,
      authMethod: resolved.secrets.privateKey ? "private-key" : "password",
      platform: this.#platform,
    });
    return Object.assign(new Error(diag.message), { code: diag.code, status: diag.code === "connection_cancelled" ? 408 : 400 });
  }

  async #execSsh(
    resolved: ResolvedDeviceSshCredential,
    remoteCommand: string,
    options: {
      timeoutMs: number;
      input?: string;
      rawInput?: boolean;
      keepStdinOpen?: boolean;
      onStdoutLine?: (line: string) => void;
      signal?: AbortSignal;
    },
  ) {
    const auth = await prepareSshAuthSession({
      host: resolved.connection.host!,
      port: resolved.connection.port ?? 22,
      username: resolved.connection.username!,
      secrets: resolved.secrets,
      knownHostsPath: resolved.knownHostsPath,
      timeoutMs: options.timeoutMs,
      forwardingMode: "none",
      disablePty: true,
      platform: this.#platform,
      signal: options.signal,
    });
    try {
      return await captureSshProcess("ssh", [...auth.args, remoteCommand], {
        environment: auth.environment,
        timeoutMs: options.timeoutMs,
        input: options.input,
        rawInput: options.rawInput,
        keepStdinOpen: options.keepStdinOpen,
        onStdoutLine: options.onStdoutLine,
        signal: options.signal,
      });
    } finally {
      await auth.cleanup();
    }
  }

  async #detectWindowsShell(resolved: ResolvedDeviceSshCredential, signal: AbortSignal): Promise<RemoteSshShell> {
    const probe = await this.#execSsh(resolved, "echo %OS% $PSVersionTable.PSVersion", {
      timeoutMs: 15_000,
      signal,
    });
    if (probe.exitCode === 255) throw this.#classifyTransportFailure(resolved, probe);
    if (probe.stdout.includes("Windows_NT")) return "cmd";
    if (!probe.stdout.includes(".PSVersion")) return "powershell";
    return "git-bash";
  }

  async #bootstrapWindowsNode(
    resolved: ResolvedDeviceSshCredential,
    signal: AbortSignal,
    onStage?: (stage: DeviceSshOnboardingStage) => void,
    priorPosix?: { stdout: string; stderr: string },
  ): Promise<{ port: number; nodePath: string; platform: string }> {
    const win = await this.#execSsh(resolved, WINDOWS_PREPARE_COMMAND, { timeoutMs: 30_000, signal });
    if (win.exitCode === 255) throw this.#classifyTransportFailure(resolved, win);
    if (win.exitCode === 0 && win.stdout.includes(PREPARE_MARKER)) {
      return parsePreparedPayload(win.stdout);
    }
    if (win.exitCode === 127 && win.stderr.includes("KULO-NO-NODE")) {
      const probe = parseNoNodeMarker(win.stderr);
      if (!probe) fail("远端主机未找到 Node.js，请先安装 Node.js 22.19 或更新版本。", "device_ssh_node_missing", 400);
      const target = resolveManagedNodeTarget(probe);
      onStage?.("installing-node");
      const boot = await this.#execSsh(resolved, buildWindowsNodeBootstrapCommand(target), {
        timeoutMs: NODE_BOOTSTRAP_TIMEOUT_MS,
        signal,
      });
      if (boot.exitCode === 255) throw this.#classifyTransportFailure(resolved, boot);
      if (boot.exitCode !== 0 || !boot.stdout.includes(PREPARE_MARKER)) {
        const reason = extractBootstrapError(boot.stderr) ?? summarizeScriptFailure(
          boot.stdout,
          boot.stderr,
          "自动安装远端 Node.js 失败，请检查远端主机网络后重试，或手动安装 Node.js 22.19 或更新版本。",
        );
        fail(reason, "device_ssh_node_bootstrap_failed", 400);
      }
      return parsePreparedPayload(boot.stdout);
    }
    const fallback = summarizeScriptFailure(
      win.stdout,
      win.stderr,
      "无法读取设备的 Node.js 环境信息，请确认已安装 Node.js 22.19 或更新版本。",
    );
    const reason = priorPosix ? summarizeScriptFailure(priorPosix.stdout, priorPosix.stderr, fallback) : fallback;
    fail(reason, "device_ssh_prepare_failed", 400);
  }

  async #prepareRemote(
    resolved: ResolvedDeviceSshCredential,
    signal: AbortSignal,
    onStage?: (stage: DeviceSshOnboardingStage) => void,
  ): Promise<{ port: number; nodePath: string; remoteShell?: RemoteSshShell }> {
    const posix = await this.#execSsh(resolved, POSIX_PREPARE_COMMAND, { timeoutMs: 30_000, signal });
    if (posix.exitCode === 255) throw this.#classifyTransportFailure(resolved, posix);
    let prepared: { port: number; nodePath: string; platform: string };
    if (posix.exitCode === 0 && posix.stdout.includes(PREPARE_MARKER)) {
      prepared = parsePreparedPayload(posix.stdout);
    } else if (posix.exitCode === 127 && (posix.stderr.includes(NO_NODE_MARKER) || posix.stderr.includes("KULO-NO-NODE"))) {
      const probe = parseNoNodeMarker(posix.stderr);
      if (!probe) {
        fail("远端主机未找到 Node.js，请先安装 Node.js 22.19 或更新版本。", "device_ssh_node_missing", 400);
      }
      if (probe.os === "win32") {
        // Git Bash sshd on Windows: check Windows paths first, then bootstrap managed Windows Node if still missing.
        prepared = await this.#bootstrapWindowsNode(resolved, signal, onStage);
      } else {
        const target = resolveManagedNodeTarget(probe);
        onStage?.("installing-node");
        const boot = await this.#execSsh(resolved, buildPosixNodeBootstrapCommand(target), {
          timeoutMs: NODE_BOOTSTRAP_TIMEOUT_MS,
          signal,
        });
        if (boot.exitCode === 255) throw this.#classifyTransportFailure(resolved, boot);
        if (boot.exitCode !== 0 || !boot.stdout.includes(PREPARE_MARKER)) {
          const reason = extractBootstrapError(boot.stderr) ?? summarizeScriptFailure(
            boot.stdout,
            boot.stderr,
            "自动安装远端 Node.js 失败，请检查远端主机网络后重试，或手动安装 Node.js 22.19 或更新版本。",
          );
          fail(reason, "device_ssh_node_bootstrap_failed", 400);
        }
        prepared = parsePreparedPayload(boot.stdout);
      }
    } else {
      // Fallback for Windows sshd whose DefaultShell is cmd.exe or PowerShell (no `sh`).
      prepared = await this.#bootstrapWindowsNode(resolved, signal, onStage, posix);
    }
    const remoteShell = prepared.platform === "win32"
      ? await this.#detectWindowsShell(resolved, signal)
      : undefined;
    remoteNodeCommand(prepared.nodePath, remoteShell);
    return { port: prepared.port, nodePath: prepared.nodePath, ...(remoteShell ? { remoteShell } : {}) };
  }

  async add(raw: DeviceSshAddRequest, options?: { signal?: AbortSignal }): Promise<DeviceSshRecord> {
    if (this.#closed) fail("设备连接服务已关闭。", "device_ssh_closed", 503);
    const generation = this.#generation;
    const request = validateDeviceSshAddRequest(raw);
    if (options?.signal?.aborted) fail("设备接入已取消。", "device_ssh_cancelled", 409);
    const existing = this.#activeAdds.get(request.connectionId);
    if (existing) {
      await this.#waitForCancelling(existing, options?.signal);
      if (this.#closed || generation !== this.#generation) fail("设备接入已取消。", "device_ssh_cancelled", 409);
      if (this.#activeAdds.has(request.connectionId)) {
        fail("正在通过此 SSH 凭据接入设备，请稍候。", "device_ssh_adding", 409);
      }
    }
    const bound = this.#options.findBoundDevice?.(request.connectionId);
    if (bound) {
      fail(`此 SSH 凭据已关联设备「${bound.name}」，请勿重复添加。`, "device_ssh_credential_bound", 409);
    }
    const bootstrapController = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const startedAt = Date.now();
    const active: ActiveAdd = {
      controller: bootstrapController,
      cancelling: false,
      done,
      progress: { connectionId: request.connectionId, stage: "probing", startedAt, updatedAt: startedAt },
    };
    this.#activeAdds.set(request.connectionId, active);
    this.#bootstraps.add(bootstrapController);
    const setStage = (stage: DeviceSshOnboardingStage, nextDeviceId?: string) => {
      active.progress.stage = stage;
      active.progress.updatedAt = Date.now();
      if (nextDeviceId) active.progress.deviceId = nextDeviceId;
    };
    const onExternalAbort = () => {
      active.cancelling = true;
      bootstrapController.abort();
    };
    options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options?.signal?.aborted) onExternalAbort();
    let deviceId: string | undefined;
    let inviteToken: string | undefined;
    try {
      this.#assertActive(generation, bootstrapController.signal);
      const resolved = await this.#options.credentials.resolveVerified(request.connectionId);
      this.#assertActive(generation, bootstrapController.signal);
      const prepared = await this.#prepareRemote(resolved, bootstrapController.signal, setStage);
      this.#assertActive(generation, bootstrapController.signal);
      const hubUrl = `http://127.0.0.1:${prepared.port}`;
      const displayName = request.name ?? resolved.connection.name;
      const invitation = await this.#options.createInvitation({
        name: displayName,
        rootDir: request.rootDir,
        hubUrl,
        kind: "ssh",
      });
      deviceId = invitation.deviceId;
      inviteToken = invitation.inviteToken;
      this.#assertActive(generation, bootstrapController.signal);
      setStage("opening-tunnel", deviceId);
      const record: DeviceSshRecord = {
        deviceId,
        connectionId: request.connectionId,
        remotePort: prepared.port,
        remoteNodePath: prepared.nodePath,
        ...(prepared.remoteShell ? { remoteShell: prepared.remoteShell } : {}),
        ...(request.name ? { name: request.name } : {}),
        ...(request.rootDir ? { rootDir: request.rootDir } : {}),
      };
      const tunnel: Tunnel = {
        record,
        attempts: 0,
        reconnect: false,
        stopped: false,
        pausedForReverify: false,
        connected: false,
      };
      this.#tunnels.set(deviceId, tunnel);
      await this.#openTunnel(tunnel, resolved, bootstrapController.signal);
      this.#assertActive(generation, bootstrapController.signal);
      setStage("downloading-peer");
      const installCmd = buildRemoteNodeBase64Command(record.remoteNodePath, INSTALL_REMOTE, record.remoteShell);
      const installResult = await this.#execSsh(resolved, installCmd, {
        timeoutMs: INSTALL_REMOTE_TIMEOUT_MS,
        input: `${JSON.stringify({ hubUrl, inviteToken, watchStdin: true })}\n`,
        rawInput: true,
        keepStdinOpen: true,
        onStdoutLine: (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith(INSTALL_STAGE_MARKER)) return;
          const stage = trimmed.slice(INSTALL_STAGE_MARKER.length).trim() as DeviceSshOnboardingStage;
          if (INSTALL_STAGE_SET.has(stage)) setStage(stage);
        },
        signal: bootstrapController.signal,
      });
      if (installResult.exitCode === 255) throw this.#classifyTransportFailure(resolved, installResult);
      if (installResult.exitCode !== 0) {
        fail(summarizeScriptFailure(installResult.stdout, installResult.stderr, `设备安装程序退出：${installResult.exitCode}`), "device_ssh_install_failed", 400);
      }
      this.#assertActive(generation, bootstrapController.signal);
      if (tunnel.stopped) fail("设备接入已取消。", "device_ssh_cancelled", 409);
      tunnel.reconnect = true;
      return record;
    } catch (error) {
      if (deviceId) this.remove(deviceId);
      const aborted = bootstrapController.signal.aborted || options?.signal?.aborted || this.#closed || generation !== this.#generation
        || (error instanceof Error && error.name === "AbortError");
      const code = aborted ? "device_ssh_cancelled" : errorCodeOf(error);
      const rawMessage = aborted ? "设备接入已取消。" : messageOf(error);
      const safeDetail = this.#redact(rawMessage, inviteToken);
      if (deviceId) {
        if (this.#options.onAddFailed) this.#options.onAddFailed(deviceId, safeDetail);
        else this.#options.onError?.(deviceId, safeDetail);
      }
      if (aborted) {
        throw Object.assign(new Error(safeDetail), { code: "device_ssh_cancelled", status: 409 });
      }
      if (code && (code.startsWith("connection_") || code.startsWith("device_ssh_"))) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
        throw Object.assign(new Error(safeDetail), { code, status });
      }
      throw Object.assign(new Error(`SSH 设备接入失败：${safeDetail}`), { code: "device_ssh_add_failed", status: 400 });
    } finally {
      options?.signal?.removeEventListener("abort", onExternalAbort);
      this.#bootstraps.delete(bootstrapController);
      if (this.#activeAdds.get(request.connectionId) === active) {
        this.#activeAdds.delete(request.connectionId);
      }
      resolveDone();
    }
  }

  async #openTunnel(tunnel: Tunnel, initialResolved?: ResolvedDeviceSshCredential, signal?: AbortSignal): Promise<void> {
    if (this.#closed || tunnel.stopped || signal?.aborted) fail("设备连接已取消。", "device_ssh_cancelled", 409);
    const hubPort = typeof this.#options.hubPort === "function" ? this.#options.hubPort() : this.#options.hubPort;
    if (!validPort(tunnel.record.remotePort) || !validPort(hubPort)) fail("SSH 转发端口无效。", "device_ssh_invalid_port", 400);
    const resolved = initialResolved ?? await this.#options.credentials.resolveForRestore(tunnel.record.connectionId);
    if (this.#closed || tunnel.stopped || signal?.aborted || this.#tunnels.get(tunnel.record.deviceId) !== tunnel) {
      fail("设备连接已取消。", "device_ssh_cancelled", 409);
    }
    const remoteCommand = buildRemoteNodeEvalCommand(tunnel.record.remoteNodePath, TUNNEL_READY_EXPR, tunnel.record.remoteShell);
    const auth: PreparedSshAuthSession = await prepareSshAuthSession({
      host: resolved.connection.host!,
      port: resolved.connection.port ?? 22,
      username: resolved.connection.username!,
      secrets: resolved.secrets,
      knownHostsPath: resolved.knownHostsPath,
      timeoutMs: 45_000,
      forwardingMode: "reverse-tunnel",
      reverseForward: { remotePort: tunnel.record.remotePort, hubPort },
      disablePty: true,
      serverAliveIntervalSec: 15,
      serverAliveCountMax: 3,
      platform: this.#platform,
      signal,
    });
    if (this.#closed || tunnel.stopped || signal?.aborted || this.#tunnels.get(tunnel.record.deviceId) !== tunnel) {
      await auth.cleanup();
      fail("设备连接已取消。", "device_ssh_cancelled", 409);
    }
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", [...auth.args, remoteCommand], {
        stdio: ["pipe", "pipe", "pipe"],
        env: auth.environment,
        windowsHide: true,
      });
      tunnel.child = child;
      let ready = false;
      let settled = false;
      let stdout = "";
      let stderr = "";
      const finishAuth = () => { void auth.cleanup(); };
      const cleanupListeners = () => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const failStart = (error: Error) => {
        cleanupListeners();
        finishAuth();
        if (settled) return;
        settled = true;
        reject(error);
      };
      const onAbort = signal
        ? () => {
            child.stdin.end();
            child.kill();
            failStart(Object.assign(new Error("设备接入已取消。"), { code: "device_ssh_cancelled", status: 409 }));
          }
        : undefined;
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        child.kill();
        failStart(Object.assign(new Error("SSH 反向隧道建立超时。"), { code: "connection_cancelled", status: 408 }));
      }, 45_000);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString("utf8")).slice(-2048);
        if (!ready && stdout.includes(TUNNEL_READY)) {
          ready = true;
          settled = true;
          tunnel.connected = true;
          tunnel.attempts = 0;
          cleanupListeners();
          // Authentication and -R forwarding succeeded; destroy temporary askpass/ssh-agent immediately.
          finishAuth();
          resolve();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
      child.once("error", (error) => {
        failStart(Object.assign(new Error(`无法启动 SSH：${error.message}`), { code: "connection_program_unavailable", status: 503 }));
      });
      child.once("close", (code) => {
        cleanupListeners();
        finishAuth();
        if (tunnel.child === child) tunnel.child = undefined;
        tunnel.connected = false;
        const classified = code === 255
          ? this.#classifyTransportFailure(resolved, { exitCode: code, stderr })
          : new Error(stderr.trim() ? this.#redact(stderr.trim()) : `SSH 连接已断开（${code ?? "无退出码"}）。`);
        if (!ready) failStart(classified);
        if (ready && tunnel.reconnect && !tunnel.stopped && !tunnel.pausedForReverify && !this.#closed) {
          this.#options.onError?.(tunnel.record.deviceId, classified.message);
          this.#scheduleReconnect(tunnel);
        }
      });
      if (signal?.aborted) onAbort?.();
    });
  }

  #handleTunnelFailure(tunnel: Tunnel, error: unknown): void {
    if (tunnel.stopped || this.#closed) return;
    const code = errorCodeOf(error);
    if (code && PAUSED_REVERIFY_CODES.has(code)) {
      tunnel.pausedForReverify = true;
      this.#options.onError?.(tunnel.record.deviceId, this.#redact(messageOf(error)));
      return;
    }
    if (code === "connection_vault_locked") {
      this.#options.onError?.(tunnel.record.deviceId, "本机凭据库已锁定，解锁系统密钥库后将自动重连。");
      this.#scheduleReconnect(tunnel);
      return;
    }
    this.#options.onError?.(tunnel.record.deviceId, this.#redact(messageOf(error)));
    this.#scheduleReconnect(tunnel);
  }

  #scheduleReconnect(tunnel: Tunnel, immediate = false): void {
    if (tunnel.stopped || tunnel.pausedForReverify || this.#closed) return;
    if (tunnel.timer) {
      if (!immediate) return;
      clearTimeout(tunnel.timer);
      tunnel.timer = undefined;
    }
    const delay = immediate ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(tunnel.attempts++, 5));
    tunnel.timer = setTimeout(() => {
      tunnel.timer = undefined;
      if (tunnel.stopped || tunnel.pausedForReverify || this.#closed) return;
      void this.#openTunnel(tunnel).catch((error) => this.#handleTunnelFailure(tunnel, error));
    }, delay);
    tunnel.timer.unref();
  }

  handleConnectionChanged(event: DeviceSshConnectionEvent): void {
    for (const tunnel of this.#tunnels.values()) {
      if (tunnel.record.connectionId !== event.connectionId || tunnel.stopped) continue;
      if (event.type === "identity-changed" || event.type === "host-mismatch") {
        tunnel.pausedForReverify = true;
        if (tunnel.timer) { clearTimeout(tunnel.timer); tunnel.timer = undefined; }
        tunnel.connected = false;
        tunnel.child?.stdin.end();
        tunnel.child?.kill();
        this.#options.onError?.(
          tunnel.record.deviceId,
          event.type === "host-mismatch"
            ? "关联的 SSH 服务器指纹已变更，请在「授权凭据」重新核对并信任指纹。"
            : "关联的 SSH 凭据地址或配置已变更，请在「授权凭据」重新验证连接。",
        );
      } else if (event.type === "credentials-rotated") {
        if (!tunnel.connected && !tunnel.child && !tunnel.pausedForReverify) {
          tunnel.attempts = 0;
          this.#scheduleReconnect(tunnel, true);
        }
      } else if (event.type === "verified") {
        if (tunnel.pausedForReverify || (!tunnel.connected && !tunnel.child)) {
          tunnel.pausedForReverify = false;
          tunnel.attempts = 0;
          this.#scheduleReconnect(tunnel, true);
        }
      }
    }
  }

  async restore(records: readonly StoredDeviceSshRecord[]): Promise<void> {
    if (this.#closed) fail("设备连接服务已关闭。", "device_ssh_closed", 503);
    await Promise.all(records.map(async (stored) => {
      if (!isCredentialDeviceSshRecord(stored)) {
        this.#options.onError?.(
          stored.deviceId,
          "此 SSH 设备使用旧版连接方式，请移除后在「授权凭据」添加并验证 SSH 凭据再重新接入。",
        );
        return;
      }
      let tunnel: Tunnel | undefined;
      try {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(stored.deviceId) || !validPort(stored.remotePort)) {
          throw new Error("保存的 SSH 设备连接无效。");
        }
        remoteNodeCommand(stored.remoteNodePath, stored.remoteShell);
        this.remove(stored.deviceId);
        tunnel = {
          record: stored,
          attempts: 0,
          reconnect: true,
          stopped: false,
          pausedForReverify: false,
          connected: false,
        };
        this.#tunnels.set(stored.deviceId, tunnel);
        await this.#openTunnel(tunnel);
      } catch (error) {
        if (tunnel) this.#handleTunnelFailure(tunnel, error);
        else this.#options.onError?.(stored.deviceId, this.#redact(messageOf(error)));
      }
    }));
  }

  remove(deviceId: string): void {
    const tunnel = this.#tunnels.get(deviceId);
    if (!tunnel) return;
    tunnel.stopped = true;
    tunnel.connected = false;
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.child?.stdin.end();
    tunnel.child?.kill();
    this.#tunnels.delete(deviceId);
  }

  cancelPending(): void {
    this.#generation++;
    for (const active of this.#activeAdds.values()) active.cancelling = true;
    for (const controller of this.#bootstraps) controller.abort();
    this.#bootstraps.clear();
    for (const id of [...this.#tunnels.keys()]) this.remove(id);
  }

  close(): void {
    this.#closed = true;
    this.cancelPending();
  }
}
