import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { MobileConnectionCandidate } from "@kulo/protocol";
import { DeviceConnectionError } from "./devices.js";
import { buildAugmentedHostPath } from "./host-path.js";

export interface MobileConnectorStatus {
  hubId: string;
  spkiSHA256: string;
  candidates: MobileConnectionCandidate[];
  tailscale: { mode: "system" | "embedded" | "unavailable"; state: string; loginAvailable: boolean };
}

export interface MobileConnectorOptions {
  binaryPath?: string;
  listen?: string;
  /** An explicit verified system-node list; omission discovers the local CLI. */
  systemTailscaleOrigins?: string[];
  enableTailscale?: boolean;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

function unavailable(code: string): DeviceConnectionError {
  return new DeviceConnectionError("手机安全连接暂不可用，请检查连接器后重试。", 503, code);
}

function tailnetIp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  return /^fd7a:115c:a1e0:[\da-f:]+$/i.test(value);
}

/** Read the existing daemon; this never runs up/login or modifies its preferences. */
export async function discoverSystemTailscale(): Promise<{ known: boolean; origins: string[] }> {
  const commands = process.platform === "darwin"
    ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"] : ["tailscale"];
  for (const command of commands) {
    const result = await new Promise<string | undefined>((resolve) => {
      execFile(command, ["status", "--json"], { timeout: 3_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, PATH: buildAugmentedHostPath() } },
        (error, stdout) => resolve(error ? undefined : stdout));
    });
    if (!result) continue;
    let status: { BackendState?: unknown; TailscaleIPs?: unknown };
    try { status = JSON.parse(result); } catch { continue; }
    if (typeof status.BackendState !== "string") continue;
    if (status.BackendState !== "Running") return { known: true, origins: [] };
    if (!Array.isArray(status.TailscaleIPs)) continue;
    const ips = status.TailscaleIPs.filter(tailnetIp);
    if (ips.length) return { known: true, origins: ips.map((ip) => `https://${ip.includes(":") ? `[${ip}]` : ip}`) };
  }
  return { known: false, origins: [] };
}

/** Owns only the bundled process and its private IPC, never the system daemon. */
export class MobileConnector {
  readonly token = randomBytes(32).toString("base64url");
  readonly #pending = new Map<string, Pending>();
  readonly #options: MobileConnectorOptions;
  readonly #stateDir: string;
  readonly #hubId: string;
  readonly #upstream: () => Promise<string>;
  readonly #onUnexpectedExit?: () => void;
  #child?: ChildProcessWithoutNullStreams;
  #initializing?: Promise<MobileConnectorStatus>;
  #stopping?: Promise<void>;
  #status?: MobileConnectorStatus;
  #authURL = "";
  #closed = false;
  #abortingStart = false;
  #generation = 0;
  #sequence = 0;
  #systemOrigins: string[] = [];
  #systemCheckedAt = 0;
  #systemRefresh?: Promise<void>;

  constructor(input: { stateDir: string; hubId: string; upstream: () => Promise<string>; options?: MobileConnectorOptions; onUnexpectedExit?: () => void }) {
    this.#stateDir = path.join(input.stateDir, "mobile-connect");
    this.#hubId = input.hubId;
    this.#upstream = input.upstream;
    this.#options = input.options ?? {};
    this.#onUnexpectedExit = input.onUnexpectedExit;
  }

  async status(): Promise<MobileConnectorStatus> {
    await this.ensure();
    await this.#refreshSystemNode();
    this.#acceptStatus(await this.#rpc("status"));
    if (!this.#status) throw unavailable("connector_invalid_status");
    this.#saveListenerPort();
    return structuredClone(this.#status);
  }

  ensure(): Promise<MobileConnectorStatus> {
    if (this.#closed) return Promise.reject(unavailable("connector_closed"));
    if (this.#initializing) return this.#initializing;
    if (!this.#stopping && this.#child && this.#status) return Promise.resolve(structuredClone(this.#status));
    const starting = this.#start();
    this.#initializing = starting;
    void starting.finally(() => { if (this.#initializing === starting) this.#initializing = undefined; }).catch(() => {});
    return starting;
  }

  async login(): Promise<string> {
    await this.ensure();
    this.#acceptStatus(await this.#rpc("beginLogin"));
    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.#authURL) return this.#authURL;
      if (this.#closed) throw unavailable("connector_closed");
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.#acceptStatus(await this.#rpc("status"));
    }
    throw new DeviceConnectionError("登录链接仍在准备，请重试。", 503, "tailscale_login_pending");
  }

  async stop(): Promise<void> {
    this.#generation++;
    if (this.#stopping) {
      await this.#stopping;
      return;
    }
    const child = this.#child;
    this.#status = undefined;
    this.#authURL = "";
    const stopping = (async () => {
      if (child) {
        try { await this.#rpc("stop", undefined, 2_000); } catch { /* The owned process is killed below if IPC is already gone. */ }
        if (child.exitCode === null) child.kill("SIGTERM");
        if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
          child.once("exit", () => { clearTimeout(timeout); resolve(); });
        });
      }
      this.#failPending(unavailable(this.#closed ? "connector_closed" : "connector_stopped"));
      if (this.#child === child) this.#child = undefined;
    })();
    this.#stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = undefined;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.stop();
  }

  async #start(): Promise<MobileConnectorStatus> {
    const generation = this.#generation;
    if (this.#stopping) await this.#stopping;
    if (this.#closed || this.#generation !== generation) {
      throw unavailable(this.#closed ? "connector_closed" : "connector_stopped");
    }
    const executable = this.#options.binaryPath ?? process.env.KULO_CONNECTOR_PATH?.trim() ??
      fileURLToPath(new URL(`../native/kulo-connector-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
    if (!fs.existsSync(executable)) {
      throw new DeviceConnectionError("手机连接器尚未构建，请运行 Kulo-mobile 的阶段 2 构建。", 503, "connector_not_built");
    }
    const upstream = await this.#upstream();
    const systemTailscaleOrigins = this.#options.systemTailscaleOrigins ?? (await discoverSystemTailscale()).origins;
    this.#systemOrigins = systemTailscaleOrigins;
    this.#systemCheckedAt = Date.now();
    if (this.#closed || this.#generation !== generation) {
      throw unavailable(this.#closed ? "connector_closed" : "connector_stopped");
    }
    const child = spawn(executable, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    // stderr is drained without forwarding raw upstream diagnostics or enrollment URLs.
    child.stderr.resume();
    child.stdin.on("error", () => this.#processEnded(child));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.length > 128 * 1024) { child.kill(); return; }
      let message: { id?: string; ok?: boolean; result?: unknown; error?: unknown; event?: string; data?: unknown };
      try { message = JSON.parse(line); } catch { child.kill(); return; }
      if (message.event === "state") { this.#acceptStatus(message.data); return; }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(unavailable("connector_request_failed"));
    });
    child.once("error", () => this.#processEnded(child));
    child.once("exit", () => { lines.close(); this.#processEnded(child); });
    try {
      this.#acceptStatus(await this.#rpc("start", { upstream, hubId: this.#hubId, stateDir: this.#stateDir,
        connectorToken: this.token, listen: this.#listenerAddress(), systemTailscaleOrigins }));
      if (this.#closed || this.#generation !== generation) {
        throw unavailable(this.#closed ? "connector_closed" : "connector_stopped");
      }
      if (this.#options.enableTailscale !== false) this.#acceptStatus(await this.#rpc("ensureTailscale"));
      if (this.#closed || this.#generation !== generation) {
        throw unavailable(this.#closed ? "connector_closed" : "connector_stopped");
      }
      if (!this.#status) throw unavailable("connector_invalid_status");
      this.#saveListenerPort();
      return structuredClone(this.#status);
    } catch (error) {
      this.#abortingStart = true;
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        this.#processEnded(child);
      } finally {
        this.#abortingStart = false;
      }
      throw error;
    }
  }

  #processEnded(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child) return;
    const unexpected = !this.#closed && !this.#stopping && !this.#abortingStart && this.#status !== undefined;
    this.#child = undefined;
    this.#status = undefined;
    this.#authURL = "";
    this.#failPending(unavailable(this.#closed ? "connector_closed" : "connector_stopped"));
    if (unexpected) this.#onUnexpectedExit?.();
  }

  #listenerAddress(): string {
    if (this.#options.listen !== undefined) return this.#options.listen;
    const file = path.join(this.#stateDir, "listener.json");
    if (!fs.existsSync(file)) return "0.0.0.0:0";
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Invalid listener state");
      const { port } = JSON.parse(fs.readFileSync(file, "utf8")) as { port: number };
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid listener state");
      return `0.0.0.0:${port}`;
    } catch { throw unavailable("connector_listener_state_invalid"); }
  }

  #saveListenerPort(): void {
    if (this.#options.listen !== undefined) return;
    const candidate = this.#status?.candidates.find((entry) => entry.route === "lan");
    if (!candidate) return;
    const port = Number(new URL(candidate.origin).port || "443");
    const file = path.join(this.#stateDir, "listener.json");
    if (fs.existsSync(file)) {
      if (this.#listenerAddress() !== `0.0.0.0:${port}`) throw unavailable("connector_listener_changed");
      return;
    }
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ port }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  }

  async #refreshSystemNode(): Promise<void> {
    if (this.#options.enableTailscale === false || this.#options.systemTailscaleOrigins !== undefined) return;
    if (this.#systemRefresh) return this.#systemRefresh;
    if (Date.now() - this.#systemCheckedAt < 15_000) return;
    this.#systemCheckedAt = Date.now();
    const refresh = (async () => {
      const { known, origins } = await discoverSystemTailscale();
      // Only a confirmed stopped/logged-out state clears an already advertised system node.
      if (!known || JSON.stringify(origins) === JSON.stringify(this.#systemOrigins)) return;
      this.#acceptStatus(await this.#rpc("ensureTailscale", { systemTailscaleOrigins: origins }));
      this.#systemOrigins = origins;
    })();
    this.#systemRefresh = refresh;
    try { await refresh; } finally { if (this.#systemRefresh === refresh) this.#systemRefresh = undefined; }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  #rpc(op: string, params?: unknown, timeout = 10_000): Promise<unknown> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.stdin.destroyed) return Promise.reject(unavailable("connector_stopped"));
    return new Promise((resolve, reject) => {
      const id = String(++this.#sequence);
      const timer = setTimeout(() => { this.#pending.delete(id); reject(unavailable("connector_timeout")); }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, params }) + "\n", (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id); clearTimeout(timer); reject(unavailable("connector_stopped"));
      });
    });
  }

  #acceptStatus(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const input = value as MobileConnectorStatus & { authURL?: unknown };
    if (input.hubId !== this.#hubId || !/^[a-f0-9]{64}$/.test(input.spkiSHA256) || !Array.isArray(input.candidates) ||
      input.candidates.length > 32 || !input.tailscale || !["system", "embedded", "unavailable"].includes(input.tailscale.mode) ||
      typeof input.tailscale.state !== "string" || typeof input.tailscale.loginAvailable !== "boolean") return;
    const candidates: MobileConnectionCandidate[] = [];
    for (const candidate of input.candidates) {
      if (!candidate || !["lan", "tailscale"].includes(candidate.route) || typeof candidate.origin !== "string") return;
      let origin: URL;
      try { origin = new URL(candidate.origin); } catch { return; }
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return;
      candidates.push({ route: candidate.route, origin: origin.origin });
    }
    if (this.#status && this.#status.spkiSHA256 !== input.spkiSHA256) return;
    this.#status = { hubId: this.#hubId, spkiSHA256: input.spkiSHA256, candidates, tailscale: { ...input.tailscale } };
    this.#authURL = "";
    if (typeof input.authURL === "string") {
      try {
        const url = new URL(input.authURL);
        if (url.protocol === "https:" && !url.username && !url.password &&
          (url.hostname === "tailscale.com" || url.hostname.endsWith(".tailscale.com"))) this.#authURL = url.href;
      } catch { /* Only the fixed official login origin is accepted. */ }
    }
  }
}
