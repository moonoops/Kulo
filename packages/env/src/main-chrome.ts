import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { runAgentCli, type AgentCliRunner } from "./agent-cli.js";

export interface MainChromeFlowTab { id: number; url: string }
export interface MainChromeFlowConnection {
  status: "ready" | "needs_connection" | "needs_review";
  tabs: MainChromeFlowTab[];
  message?: string;
}
export interface MainChromeAgentBrowserConnection {
  request(command: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface MainChromeFlowSessionOptions {
  rootDir: string;
  runner?: AgentCliRunner;
  connectionFactory?: (rootDir: string, signal?: AbortSignal) => Promise<MainChromeAgentBrowserConnection>;
}

const MAX_RESULT = 2 * 1024 * 1024;
const MAX_MEDIA = 250 * 1024 * 1024;
const MEDIA_CHUNK = 512 * 1024;
const AGENT_BROWSER_VERSION = "0.43.0";
const PROJECT_PATH = /^((?:\/fx\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?tools\/flow)?\/project\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/edit\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\/?$/i;
function flowUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443"
      || url.hostname !== "flow.google.com" && !(url.hostname === "labs.google" && /^\/fx\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?tools\/flow(?:\/|$)/i.test(url.pathname))) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}
function flowProject(value: string): { url: string; root: string } | null {
  const canonical = flowUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical); const project = PROJECT_PATH.exec(url.pathname);
  return project ? { url: canonical, root: url.origin + project[1] } : null;
}
function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Main Chrome storage must be a private directory");
  fs.chmodSync(directory, 0o700);
}
function readSidecar(file: string): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 128) throw new Error("Invalid agent-browser daemon identity");
    return fs.readFileSync(descriptor, "utf8").trim();
  } finally { fs.closeSync(descriptor); }
}
function envelope(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent-browser receipt");
  const reply = value as { success?: unknown; data?: unknown };
  if (reply.success !== true || !reply.data || typeof reply.data !== "object" || Array.isArray(reply.data)) throw new Error("agent-browser did not confirm the operation");
  return reply.data as Record<string, unknown>;
}
class FlowTabSelectionError extends Error {
  constructor(readonly status: "needs_connection" | "needs_review", message: string) { super(message); }
}

/** Pinned to agent-browser 0.43.0's newline-JSON daemon protocol. Connecting directly
 * after explicit CLI attachment prevents passive checks from respawning a daemon
 * and re-requesting Chrome permission. Each request uses one socket and no retry. */
export async function openMainChromeAgentBrowser(rootDir: string, signal?: AbortSignal, runner: AgentCliRunner = runAgentCli): Promise<MainChromeAgentBrowserConnection> {
  const socketDirectory = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "kulo-flow-"));
  fs.chmodSync(socketDirectory, 0o700);
  const session = "f" + randomBytes(6).toString("hex");
  const config = path.join(socketDirectory, "config.json");
  fs.writeFileSync(config, JSON.stringify({ json: true, idleTimeout: "5m", pinTab: false }), { mode: 0o600 });
  let pid: number | undefined;
  let ended = false;
  let closing: Promise<void> | undefined;
  const identity = (): boolean => {
    try {
      const current = Number(readSidecar(path.join(socketDirectory, session + ".pid")));
      if (!Number.isSafeInteger(current) || current < 1 || pid !== undefined && current !== pid
        || readSidecar(path.join(socketDirectory, session + ".version")) !== AGENT_BROWSER_VERSION) return false;
      process.kill(current, 0);
      pid ??= current;
      return true;
    } catch { return false; }
  };
  const request = (command: Record<string, unknown>, requestSignal?: AbortSignal, timeoutMs = 45_000): Promise<unknown> => {
    if (ended || !identity() || requestSignal?.aborted) return Promise.reject(new Error("Main Chrome daemon connection was lost"));
    const encoded = JSON.stringify({ ...command, id: randomBytes(16).toString("hex") }) + "\n";
    if (Buffer.byteLength(encoded) > MAX_RESULT) return Promise.reject(new Error("Main Chrome input exceeds its limit"));
    return new Promise((resolve, reject) => {
      let socket: net.Socket;
      if (process.platform === "win32") {
        let port: number;
        try { port = Number(readSidecar(path.join(socketDirectory, session + ".port"))); }
        catch { reject(new Error("Main Chrome daemon port is unavailable")); return; }
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { reject(new Error("Invalid Main Chrome daemon port")); return; }
        socket = net.createConnection({ host: "127.0.0.1", port });
      } else {
        const file = path.join(socketDirectory, session + ".sock");
        try { if (!fs.lstatSync(file).isSocket()) throw new Error("Invalid socket"); }
        catch { reject(new Error("Main Chrome daemon socket is unavailable")); return; }
        socket = net.createConnection(file);
      }
      const chunks: Buffer[] = []; let size = 0; let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return; settled = true;
        clearTimeout(timer); requestSignal?.removeEventListener("abort", abort); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error("Main Chrome operation was cancelled; observe before retrying"));
      const timer = setTimeout(() => finish(new Error("Main Chrome operation was not confirmed; observe before retrying")), timeoutMs); timer.unref();
      requestSignal?.addEventListener("abort", abort, { once: true });
      if (requestSignal?.aborted) { abort(); return; }
      socket.once("connect", () => { if (!identity()) finish(new Error("Main Chrome daemon changed")); else socket.write(encoded); });
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESULT) { finish(new Error("Main Chrome output exceeds its limit")); return; }
        chunks.push(chunk);
        const all = Buffer.concat(chunks); const newline = all.indexOf(10);
        if (newline < 0) return;
        try {
          if (all.subarray(newline + 1).toString("utf8").trim() || command.action !== "close" && !identity()) throw new Error("Invalid receipt");
          finish(undefined, envelope(JSON.parse(all.subarray(0, newline).toString("utf8"))));
        } catch { finish(new Error("Main Chrome operation was not confirmed")); }
      });
      socket.once("error", () => finish(new Error("Main Chrome daemon connection was lost")));
      socket.once("close", () => { if (!settled) finish(new Error("Main Chrome receipt was lost; observe before retrying")); });
    });
  };
  const detach = async () => {
    if (ended) return;
    const dispose = () => { ended = true; fs.rmSync(socketDirectory, { recursive: true, force: true }); };
    const ownerAlive = () => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    if (!identity()) {
      if (!ownerAlive() && !fs.existsSync(path.join(socketDirectory, session + ".pid"))) { dispose(); return; }
      throw new Error("Main Chrome daemon identity changed; its connection could not detach");
    }
    try {
      const result = await request({ action: "close" }, undefined, 5000) as { closed?: unknown };
      if (result.closed !== true) throw new Error("Main Chrome detach was not confirmed");
      dispose();
    } catch {
      if (!ownerAlive()) { dispose(); return; }
      // Keep the socket namespace and captured owner so an explicit close/open
      // can reconcile an uncertain detach without starting a second connection.
      throw new Error("Main Chrome connection could not detach; retry closing before reconnecting");
    }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    const work = detach(); closing = work;
    void work.finally(() => { if (closing === work) closing = undefined; }).catch(() => {});
    return work;
  };
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "KULO_AGENT_BROWSER_PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.AGENT_BROWSER_SOCKET_DIR = socketDirectory;
    env.AGENT_BROWSER_NO_VERSION_CHECK = "1";
    const base = ["--json", "--session", session, "--config", config];
    // An unbound --pin-tab attachment creates a new blank tab. First inspect the
    // existing targets, then pin the unique verified Flow project instead.
    const initial = envelope(await runner({ tool: "agent-browser", args: [...base, "--auto-connect", "tab", "list"], cwd: rootDir, env, signal, timeoutMs: 35_000 }));
    if (!identity()) throw new Error("agent-browser daemon version or identity is unavailable");
    if (signal?.aborted) throw new Error("Main Chrome connection was cancelled");
    if (!Array.isArray(initial.tabs) || initial.tabs.length > 100) throw new Error("Invalid Main Chrome tabs");
    const projects = initial.tabs.filter((value): value is { targetId: string; url: string } => {
      if (!value || typeof value !== "object") return false;
      const tab = value as Record<string, unknown>;
      return typeof tab.url === "string" && Boolean(flowProject(tab.url)) && typeof tab.targetId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(tab.targetId);
    });
    if (projects.length !== 1) throw new FlowTabSelectionError(projects.length ? "needs_review" : "needs_connection", projects.length
      ? "请在主 Chrome 保留唯一的本次 Flow 项目后重新连接。" : "请在主 Chrome 打开原 Flow 项目后重新连接。");
    const selected = projects[0]!;
    const pinned = envelope(await runner({ tool: "agent-browser", args: [...base, "--pin-tab", "tab", selected.targetId], cwd: rootDir, env, signal, timeoutMs: 15_000 }));
    if (!identity() || pinned.targetId !== selected.targetId || flowUrl(pinned.url) !== flowUrl(selected.url) || pinned.revived || pinned.dialogBlocked) throw new Error("Main Chrome Flow target changed during connection");
    if (signal?.aborted) throw new Error("Main Chrome connection was cancelled");
    return { request, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** Only fixed application DOM programs enter this Env-private adapter. */
export class MainChromeFlowSession {
  readonly #options: MainChromeFlowSessionOptions;
  readonly #rootDir: string;
  readonly #targets = new Map<number, string>();
  readonly #handles = new Map<string, number>();
  readonly #downloadAttempts = new Set<string>();
  readonly #downloadSources = new Map<string, string>();
  readonly #cleanups = new Set<MainChromeAgentBrowserConnection>();
  #client?: MainChromeAgentBrowserConnection;
  #abort?: AbortController;
  #opening?: Promise<void>;
  #queue: Promise<unknown> = Promise.resolve();
  #state: MainChromeFlowConnection = { status: "needs_connection", tabs: [], message: "请在主 Chrome 启用远程调试并授权连接 Flow 项目。" };
  #closed = false;
  #generation = 0;
  #nextHandle = 1;

  constructor(options: MainChromeFlowSessionOptions) {
    this.#options = options;
    this.#rootDir = path.resolve(options.rootDir);
    privateDirectory(this.#rootDir);
  }
  #snapshot(): MainChromeFlowConnection { return { ...this.#state, tabs: this.#state.tabs.map((tab) => ({ ...tab })) }; }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#queue.then(operation);
    this.#queue = work.then(() => undefined, () => undefined);
    return work;
  }
  async #lost(client: MainChromeAgentBrowserConnection): Promise<void> {
    if (this.#client !== client) return;
    this.#client = undefined; this.#abort?.abort(); this.#abort = undefined;
    this.#state = { status: "needs_connection", tabs: [], message: "主 Chrome 连接已断开，请重新授权连接原 Flow 项目。" };
    await this.#cleanup(client);
  }
  async #cleanup(client: MainChromeAgentBrowserConnection): Promise<void> {
    this.#cleanups.add(client);
    await client.close();
    this.#cleanups.delete(client);
  }
  async #request(command: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const client = this.#client;
    if (!client || this.#closed) throw new Error("Main Chrome Flow is not connected");
    try {
      const result = await client.request(command, this.#abort?.signal, timeoutMs);
      if (this.#client !== client || this.#closed || !result || typeof result !== "object" || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT) throw new Error("Invalid Main Chrome reply");
      return result as Record<string, unknown>;
    } catch {
      await this.#lost(client).catch(() => {});
      throw new Error("Main Chrome Flow operation was not confirmed; reconnect before continuing");
    }
  }
  async #refresh(): Promise<void> {
    const value = await this.#request({ action: "tab_list" });
    if (!Array.isArray(value.tabs) || value.tabs.length > 100) throw new Error("Invalid Main Chrome tabs");
    const tabs: MainChromeFlowTab[] = [];
    for (const raw of value.tabs) {
      if (!raw || typeof raw !== "object") throw new Error("Invalid Main Chrome tab");
      const entry = raw as Record<string, unknown>; const url = flowUrl(entry.url);
      if (!url) continue;
      if (typeof entry.targetId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.targetId)) throw new Error("Invalid Main Chrome target");
      let id = this.#handles.get(entry.targetId);
      if (!id) { id = this.#nextHandle++; this.#handles.set(entry.targetId, id); this.#targets.set(id, entry.targetId); }
      tabs.push({ id, url });
    }
    this.#state = tabs.length ? { status: "ready", tabs } : { status: "needs_connection", tabs: [], message: "请在主 Chrome 打开原 Flow 项目，再重新连接。" };
  }
  async open(): Promise<MainChromeFlowConnection> {
    if (this.#closed) throw new Error("Main Chrome Flow session is closed");
    if (this.#opening || this.#state.status === "ready") return this.#snapshot();
    const generation = ++this.#generation;
    this.#state = { status: "needs_connection", tabs: [], message: "请在 chrome://inspect/#remote-debugging 启用远程调试，并允许 Kulo 连接。" };
    const work = this.#serialize(async () => {
      const previous = this.#client; this.#client = undefined; this.#abort?.abort();
      if (previous) await this.#cleanup(previous);
      for (const client of this.#cleanups) await this.#cleanup(client);
      const abort = new AbortController(); this.#abort = abort;
      const client = await (this.#options.connectionFactory
        ? this.#options.connectionFactory(this.#rootDir, abort.signal)
        : openMainChromeAgentBrowser(this.#rootDir, abort.signal, this.#options.runner));
      if (this.#closed || generation !== this.#generation) { await this.#cleanup(client); return; }
      this.#client = client;
      await this.#refresh();
    }).catch(async (error: unknown) => {
      if (this.#client && generation === this.#generation) await this.#lost(this.#client).catch(() => {});
      if (!this.#closed && generation === this.#generation) this.#state = { status: error instanceof FlowTabSelectionError ? error.status : "needs_connection", tabs: [], message: error instanceof FlowTabSelectionError ? error.message : "尚未连接主 Chrome，请确认已启用远程调试并允许连接原 Flow 项目。" };
    });
    this.#opening = work;
    void work.finally(() => { if (this.#opening === work) this.#opening = undefined; });
    return this.#snapshot();
  }
  async check(): Promise<MainChromeFlowConnection> {
    if (this.#closed) throw new Error("Main Chrome Flow session is closed");
    if (this.#opening || !this.#client) return this.#snapshot();
    try { await this.#serialize(() => this.#refresh()); }
    catch { if (this.#client) await this.#lost(this.#client).catch(() => {}); }
    return this.#snapshot();
  }
  async #bind(tabId: number): Promise<MainChromeFlowTab> {
    const tab = this.#state.tabs.find((entry) => entry.id === tabId); const target = this.#targets.get(tabId);
    if (this.#state.status !== "ready" || !tab || !target) throw new Error("Main Chrome Flow tab is not authorized");
    const result = await this.#request({ action: "tab_switch", tabId: target });
    if (result.targetId !== target || flowUrl(result.url) !== tab.url || result.revived || result.dialogBlocked) {
      this.#state = { status: "needs_review", tabs: [], message: "Flow 标签页已变化，请核对原项目后继续。" };
      throw new Error("Main Chrome Flow tab is outside the authorized scope");
    }
    return tab;
  }
  async #evaluate<T>(tab: MainChromeFlowTab, trustedCode: string, input: unknown, projectRoot?: string): Promise<T> {
    if (typeof trustedCode !== "string" || trustedCode.length > 64 * 1024) throw new Error("Invalid application Flow code");
    let encoded: string;
    try { encoded = JSON.stringify(input ?? null); } catch { throw new Error("Invalid Main Chrome input"); }
    if (Buffer.byteLength(encoded) > MAX_RESULT) throw new Error("Main Chrome input exceeds its limit");
    const nonce = randomBytes(16).toString("hex");
    const script = `(async () => {
      const canonical = () => location.origin + location.pathname;
      const expected = ${JSON.stringify(tab.url)};
      const nonce = ${JSON.stringify(nonce)};
      if (canonical() !== expected) return { nonce, status: 'scope_changed' };
      const input = JSON.parse(${JSON.stringify(encoded)});
      const value = await (${trustedCode})(input);
      const url = canonical();
      const root = ${JSON.stringify(projectRoot ?? null)};
      const inScope = root === null ? url === expected : url.replace(/\\/$/, '') === root || url.startsWith(root + '/edit/') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\/?$/i.test(url.slice(root.length + 6));
      return { nonce, status: inScope ? 'ok' : 'scope_changed', value: value === undefined ? null : value, url };
    })()`;
    const data = await this.#request({ action: "evaluate", script });
    const reply = data.result as { nonce?: unknown; status?: unknown; value?: T; url?: unknown } | undefined;
    if (!reply || reply.nonce !== nonce) {
      if (this.#client) await this.#lost(this.#client).catch(() => {});
      throw new Error("Main Chrome returned an invalid Flow receipt");
    }
    if (reply.status !== "ok" || projectRoot && (!flowProject(String(reply.url)) || flowProject(String(reply.url))!.root !== projectRoot)) {
      this.#state = { status: "needs_review", tabs: [], message: "Flow 标签页已变化，请核对原项目后继续。" };
      throw new Error("Main Chrome Flow tab is outside the authorized scope");
    }
    if (projectRoot && typeof reply.url === "string") this.#state.tabs = this.#state.tabs.map((entry) => entry.id === tab.id ? { ...entry, url: reply.url as string } : entry);
    return reply.value as T;
  }
  async run<T>(tabId: number, trustedCode: string, input?: unknown): Promise<T> {
    return this.#serialize(async () => this.#evaluate<T>(await this.#bind(tabId), trustedCode, input));
  }
  async evaluate<T>(tabId: number, trustedCode: string, input?: unknown): Promise<T> { return this.run<T>(tabId, trustedCode, input); }
  async runProjectNavigation<T>(tabId: number, projectUrl: string, trustedCode: string, input?: unknown): Promise<{ url: string; value: T }> {
    const project = flowProject(projectUrl);
    if (!project || project.url.replace(/\/$/, "") !== project.root) throw new Error("Flow navigation requires the authorized project root");
    return this.#serialize(async () => {
      const authorized = this.#state.tabs.find((tab) => tab.id === tabId);
      if (!authorized || flowProject(authorized.url)?.root !== project.root) throw new Error("Flow project navigation is not authorized");
      const value = await this.#evaluate<T>(await this.#bind(tabId), trustedCode, input, project.root);
      const tab = this.#state.tabs.find((entry) => entry.id === tabId)!;
      return { url: tab.url, value };
    });
  }
  async navigateProject(tabId: number, projectUrl: string): Promise<{ url: string }> {
    const project = flowProject(projectUrl);
    if (!project || project.url.replace(/\/$/, "") !== project.root) throw new Error("Flow navigation requires the authorized project root");
    return this.#serialize(async () => {
      const tab = await this.#bind(tabId);
      if (flowProject(tab.url)?.root !== project.root) throw new Error("Flow project navigation is not authorized");
      await this.#request({ action: "navigate", url: project.url, waitUntil: "domcontentloaded" });
      const result = await this.#request({ action: "url" });
      if (flowUrl(result.url) !== project.url) {
        this.#state = { status: "needs_review", tabs: [] };
        throw new Error("Main Chrome Flow tab is outside the authorized scope");
      }
      this.#state.tabs = this.#state.tabs.map((entry) => entry.id === tabId ? { ...entry, url: project.url } : entry);
      return { url: project.url };
    });
  }
  async download(tabId: number, trustedCode: string, destination: string, input?: unknown): Promise<FlowMediaDownloadResult> {
    const tab = this.#state.tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error("Main Chrome Flow tab is not authorized");
    const key = createHash("sha256").update(JSON.stringify([tabId, tab.url, trustedCode, input ?? null])).digest("hex");
    if (!this.#downloadAttempts.has(key)) {
      this.#downloadAttempts.add(key);
      const receipt = await this.run<{ delivered?: unknown; source?: unknown }>(tabId, trustedCode, input);
      if (receipt?.delivered === true && typeof receipt.source === "string" && receipt.source.length < 8192) this.#downloadSources.set(key, receipt.source);
    }
    const source = this.#downloadSources.get(key);
    if (!source) return pendingMedia();
    let url: URL;
    try { url = new URL(source); } catch { return pendingMedia(); }
    if (url.username || url.password) return pendingMedia();
    if (url.protocol === "https:" && (!url.port || url.port === "443") && (url.hostname === "flow-content.google" || url.hostname === "storage.googleapis.com" || url.hostname.endsWith(".googleusercontent.com"))) {
      return downloadFlowMedia(source, destination, { expectedMediaUrl: url.origin + url.pathname, allowedHosts: [url.hostname], signal: this.#abort?.signal });
    }
    if (url.protocol !== "blob:" || url.origin !== new URL(tab.url).origin) return pendingMedia();
    return this.#downloadBlob(tabId, source, destination);
  }
  async #downloadBlob(tabId: number, source: string, destination: string): Promise<FlowMediaDownloadResult> {
    const slot = "__kuloMedia_" + randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const temporary = destination + ".download-" + randomBytes(12).toString("hex");
    let descriptor: number | undefined;
    try {
      mediaStorage(() => {
        const parent = fs.lstatSync(path.dirname(destination));
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Invalid Flow output storage");
      });
      const prepared = await this.evaluate<{ ready: boolean; size?: number }>(tabId, `async (input) => {
        const url = new URL(input.source);
        if (url.protocol !== 'blob:' || url.origin !== location.origin) return { ready: false };
        const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', cache: 'no-store' });
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!response.ok || !response.body || !['', 'video/mp4', 'application/octet-stream'].includes(mime) || Number(response.headers.get('content-length')) > input.limit) { await response.body?.cancel(); return { ready: false }; }
        const reader = response.body.getReader(); const parts = []; let size = 0;
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > input.limit) { await reader.cancel(); return { ready: false }; } parts.push(value); }
        } finally { reader.releaseLock(); }
        if (size < 12) return { ready: false };
        globalThis[input.slot] = { nonce: input.nonce, source: input.source, blob: new Blob(parts, { type: mime }) };
        return { ready: true, size };
      }`, { source, slot, nonce, limit: MAX_MEDIA });
      if (!prepared?.ready || !Number.isSafeInteger(prepared.size) || prepared.size! < 12 || prepared.size! > MAX_MEDIA) return pendingMedia();
      descriptor = mediaStorage(() => fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
      let offset = 0;
      while (offset < prepared.size!) {
        const chunk = await this.evaluate<{ nonce: string; offset: number; size: number; data: string }>(tabId, `async (input) => {
          const state = globalThis[input.slot];
          if (!state || state.nonce !== input.nonce || state.source !== input.source || state.blob.size !== input.size) return null;
          const bytes = new Uint8Array(await state.blob.slice(input.offset, input.offset + input.length).arrayBuffer());
          let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          return { nonce: state.nonce, offset: input.offset, size: state.blob.size, data: btoa(binary) };
        }`, { source, slot, nonce, size: prepared.size, offset, length: MEDIA_CHUNK });
        if (!chunk || chunk.nonce !== nonce || chunk.offset !== offset || chunk.size !== prepared.size || typeof chunk.data !== "string"
          || chunk.data.length > Math.ceil(MEDIA_CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) return pendingMedia();
        const bytes = Buffer.from(chunk.data, "base64");
        if (bytes.length !== Math.min(MEDIA_CHUNK, prepared.size! - offset)) return pendingMedia();
        mediaStorage(() => fs.writeFileSync(descriptor!, bytes)); offset += bytes.length;
      }
      mediaStorage(() => fs.closeSync(descriptor!)); descriptor = undefined;
      return finalizeMedia(temporary, destination);
    } catch (error) { if (error instanceof FlowMediaStorageError) throw error; return pendingMedia(); }
    finally {
      if (this.#client && !this.#closed) await this.evaluate(tabId, `(input) => { const state = globalThis[input.slot]; if (state?.nonce === input.nonce) delete globalThis[input.slot]; return true; }`, { slot, nonce }).catch(() => {});
      mediaStorage(() => { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); });
    }
  }
  async close(): Promise<void> {
    this.#closed = true; this.#generation++; this.#abort?.abort();
    const client = this.#client; this.#client = undefined;
    this.#state = { status: "needs_connection", tabs: [] };
    if (client) this.#cleanups.add(client);
    const results = await Promise.allSettled([...this.#cleanups].map((pending) => this.#cleanup(pending)));
    if (results.some((result) => result.status === "rejected")) throw new Error("Main Chrome Flow connection could not detach");
  }
}

export interface FlowMediaDownloadOptions {
  expectedMediaUrl: string;
  allowedHosts: readonly string[];
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}
export type FlowMediaDownloadResult = { status: "completed"; file: { name: string; mimeType: "video/mp4"; size: number; sha256?: string } }
  | { status: "pending"; message: string };
function pendingMedia(): FlowMediaDownloadResult { return { status: "pending", message: "视频下载尚未完成，请在 Flow 页面确认产物及下载权限后继续；未重新生成。" }; }
class FlowMediaStorageError extends Error {}
function mediaStorage<T>(operation: () => T): T {
  try { return operation(); } catch { throw new FlowMediaStorageError("Flow output storage is unavailable"); }
}
function finalizeMedia(temporary: string, destination: string): FlowMediaDownloadResult {
  return mediaStorage(() => {
    const descriptor = fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let size = 0; const hash = createHash("sha256"); const header = Buffer.alloc(12);
    try {
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size < 12 || info.size > MAX_MEDIA) return pendingMedia();
      size = info.size;
      fs.readSync(descriptor, header, 0, header.length, 0);
      if (header.toString("ascii", 4, 8) !== "ftyp") return pendingMedia();
      const buffer = Buffer.alloc(64 * 1024); let offset = 0;
      while (offset < size) {
        const bytes = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytes) return pendingMedia();
        hash.update(buffer.subarray(0, bytes)); offset += bytes;
      }
      if (fs.fstatSync(descriptor).size !== size) return pendingMedia();
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, destination);
    return { status: "completed", file: { name: path.basename(destination), mimeType: "video/mp4", size, sha256: hash.digest("hex") } };
  });
}

/** Downloads only the selected DOM media URL, with no browser credentials or API fallback. */
export async function downloadFlowMedia(url: string, destination: string, options: FlowMediaDownloadOptions): Promise<FlowMediaDownloadResult> {
  const pending = pendingMedia;
  const validate = (value: string): URL | null => {
    try {
      const target = new URL(value);
      if (target.protocol !== "https:" || target.username || target.password || target.port && target.port !== "443" || !options.allowedHosts.includes(target.hostname)
        || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target.hostname) || /(?:^|\.)(?:localhost|local|internal)$/i.test(target.hostname)) return null;
      return target;
    } catch { return null; }
  };
  let target = validate(url); const expected = validate(options.expectedMediaUrl);
  if (!target || !expected || target.origin + target.pathname !== expected.origin + expected.pathname) return pending();
  const limit = MAX_MEDIA;
  const temporary = destination + ".download-" + randomBytes(12).toString("hex");
  let descriptor: number | undefined;
  try {
    mediaStorage(() => {
      const parent = fs.lstatSync(path.dirname(destination));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Invalid Flow output storage");
    });
    let response: Response | undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await (options.fetch ?? globalThis.fetch)(target, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "video/mp4" }, signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location"); await response.body?.cancel();
      target = location ? validate(new URL(location, target).href) : null;
      if (!target || redirects === 3) return pending();
    }
    if (!response?.ok || !response.body || Number(response.headers.get("content-length")) > limit) { await response?.body?.cancel(); return pending(); }
    descriptor = mediaStorage(() => fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
    let size = 0; let header = Buffer.alloc(0); const hash = createHash("sha256");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("Flow media exceeds its limit");
      if (header.length < 12) header = Buffer.concat([header, Buffer.from(chunk).subarray(0, 12 - header.length)]);
      hash.update(chunk);
      mediaStorage(() => fs.writeFileSync(descriptor!, chunk));
    }
    mediaStorage(() => fs.closeSync(descriptor!)); descriptor = undefined;
    if (size < 12 || header.toString("ascii", 4, 8) !== "ftyp") return pending();
    mediaStorage(() => fs.renameSync(temporary, destination));
    return { status: "completed", file: { name: path.basename(destination), mimeType: "video/mp4", size, sha256: hash.digest("hex") } };
  } catch (error) { if (error instanceof FlowMediaStorageError) throw error; return pending(); }
  finally { mediaStorage(() => { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }); }
}
