import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { COMPUTER_USE_MAX_RESULT, isComputerUseRequest, isComputerUseResult, type ComputerUseRequest, type ComputerUseResult, type ComputerPreviewTarget, type ComputerPreviewUpdate, type DesktopSystemPermissions, type SystemPermissionState } from "@moco/protocol";
import { AgentCliError, runAgentCli, type AgentCliInvocation, type AgentCliRunner } from "./agent-cli.js";
import { ComputerPreviewService } from "./computer-preview.js";

export interface ComputerUseServiceOptions {
  rootDir: string;
  platform?: NodeJS.Platform;
  runner?: AgentCliRunner;
  browserEnabled?: boolean;
  desktopEnabled?: boolean;
}

export function computerUseConfiguration(value = process.env.MOCO_COMPUTER_USE): { browserEnabled: boolean; desktopEnabled: boolean } {
  const tools = (value ?? "browser,desktop").split(",").map((item) => item.trim()).filter(Boolean);
  if (tools.some((item) => item !== "browser" && item !== "desktop")) throw new Error("MOCO_COMPUTER_USE accepts browser,desktop only");
  return { browserEnabled: tools.includes("browser"), desktopEnabled: tools.includes("desktop") };
}

type BrowserSession = { refs: Set<string>; cleanupRequired: boolean; previewReady?: boolean };
type DesktopSession = { app: string; windowId?: string; refs: Set<string> };
type NativeEnvelope = { success?: boolean; ok?: boolean; data?: unknown; result?: unknown; error?: unknown; code?: unknown; checks?: unknown; summary?: unknown };

const SUPPORTED = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);
const MAX_BROWSER_SESSIONS = 2;
const MAX_DESKTOP_SESSIONS = 16;
const OUTPUT_CHARACTERS = 48_000;
const inheritedEnvironment = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY",
  "SystemRoot", "WINDIR", "windir", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "HOMEDRIVE", "HOMEPATH",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "MOCO_AGENT_BROWSER_PATH", "MOCO_AGENT_DESKTOP_PATH",
];

function privateDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Computer-use storage must be a private directory");
  fs.chmodSync(directory, 0o700);
  return directory;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function references(value: unknown, desktop: boolean): Set<string> {
  const refs = new Set<string>();
  if (!desktop) {
    const data = object(value);
    const mapped = object(data?.refs);
    if (mapped) for (const key of Object.keys(mapped)) if (/^@?e[0-9]+$/.test(key)) refs.add(key.replace(/^@/, ""));
    return refs;
  }
  const stack: unknown[] = [object(value)?.tree];
  let visited = 0;
  while (stack.length && visited++ < 50_000) {
    const current = stack.pop();
    if (Array.isArray(current)) { stack.push(...current); continue; }
    const node = object(current);
    if (!node) continue;
    if (typeof node.ref_id === "string" && /^@s[a-zA-Z0-9_-]+:e[0-9]+$/.test(node.ref_id)) refs.add(node.ref_id);
    if (Array.isArray(node.children)) stack.push(node.children);
  }
  return refs;
}

export class ComputerUseService {
  readonly rootDir: string;
  readonly #platform: NodeJS.Platform;
  readonly #runner: AgentCliRunner;
  readonly #browserEnabled: boolean;
  readonly #desktopEnabled: boolean;
  readonly #browser = new Map<string, BrowserSession>();
  readonly #desktop = new Map<string, DesktopSession>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #browserConfig: string;
  readonly #browserSocketDirectory: string;
  readonly #journal: string;
  readonly #fences = new Map<string, number>();
  readonly #previews: ComputerPreviewService;
  #lifecycle = new AbortController();
  #generation = 0;
  #closed = false;
  #suspending?: Promise<void>;
  #cleanupFailed = false;
  #recovery?: Promise<void>;

  constructor(options: ComputerUseServiceOptions) {
    this.rootDir = privateDirectory(path.resolve(options.rootDir));
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? runAgentCli;
    this.#browserEnabled = options.browserEnabled ?? false;
    this.#desktopEnabled = options.desktopEnabled ?? false;
    const namespace = createHash("sha256").update(this.rootDir).digest("hex").slice(0,20);
    // macOS TMPDIR is often too long for Unix sockets, even with short session ids.
    this.#browserSocketDirectory = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `mab-${namespace.slice(0,12)}`);
    const downloads = privateDirectory(path.join(this.rootDir, "downloads"));
    this.#browserConfig = path.join(this.rootDir, "browser.json");
    const descriptor = fs.openSync(this.#browserConfig, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ headed: false, autoConnect: false, noWebmcp: true, noAutoDialog: true, allowFileAccess: false, idleTimeout: "5m", maxOutput: OUTPUT_CHARACTERS, downloadPath: downloads })); }
    finally { fs.closeSync(descriptor); }
    this.#previews = new ComputerPreviewService({
      rootDir: this.rootDir,
      runner: this.#runner,
      browserInvocation: (sessionId) => this.#browser.get(sessionId)?.previewReady && !this.#browser.get(sessionId)!.cleanupRequired
        ? { args: this.#browserArgs(sessionId), cwd: this.rootDir, env: this.#environment("browser") } : undefined,
      desktopTarget: (sessionId) => this.#desktop.get(sessionId),
      desktopEnvironment: () => this.#environment("desktop"),
      queueDesktop: (work) => {
        const previous = this.#queues.get("desktop") ?? Promise.resolve();
        const tail = previous.then(work).then(() => undefined, () => undefined);
        this.#queues.set("desktop", tail);
        void tail.then(() => { if (this.#queues.get("desktop") === tail) this.#queues.delete("desktop"); });
      },
    });
    this.#journal = path.join(this.rootDir, "browser-sessions.json");
    this.#loadJournal();
    if (this.#browser.size) void this.#recover().catch(() => {});
  }

  capabilities(): string[] {
    if (!SUPPORTED.has(this.#platform)) return [];
    return [...(this.#browserEnabled ? ["agent-browser"] : []), ...(this.#desktopEnabled ? ["agent-desktop"] : [])];
  }

  subscribePreview(target: ComputerPreviewTarget, listener: (update: ComputerPreviewUpdate) => void): () => void {
    if (this.#closed || this.#suspending || !SUPPORTED.has(this.#platform) || !(target.tool === "browser" ? this.#browserEnabled : this.#desktopEnabled)) {
      listener({ state: "unavailable", message: "当前设备无法预览" });
      return () => {};
    }
    return this.#previews.subscribe(target, listener);
  }

  async request(request: ComputerUseRequest, isActive: () => boolean = () => true, signal?: AbortSignal): Promise<ComputerUseResult> {
    if (!isComputerUseRequest(request)) throw new Error("Invalid computer-use request");
    const generation = this.#generation;
    const fenceKey = "sessionId" in request ? `${request.tool}:${request.sessionId}` : undefined;
    const fence = fenceKey ? this.#fences.get(fenceKey) ?? 0 : 0;
    const queue = request.tool === "desktop" ? "desktop" : "sessionId" in request ? `browser:${request.sessionId}` : "browser:status";
    const previous = this.#queues.get(queue) ?? Promise.resolve();
    const work = previous.then(async () => {
      if (this.#closed || this.#suspending || generation !== this.#generation || !isActive() || signal?.aborted
        || request.action !== "close" && fenceKey && fence !== (this.#fences.get(fenceKey) ?? 0)) {
        return this.#error(request, "OPERATION_CANCELLED", "The computer-use session is no longer active");
      }
      if (!SUPPORTED.has(this.#platform)) return this.#error(request, "PLATFORM_NOT_SUPPORTED", "This Env has no native agent-browser or agent-desktop driver; Android requires a separate driver");
      if (request.action !== "close" && !(request.tool === "browser" ? this.#browserEnabled : this.#desktopEnabled)) return this.#error(request, "CAPABILITY_DISABLED", `Enable ${request.tool} in MOCO_COMPUTER_USE on the target Env`);
      const combined = signal ? AbortSignal.any([this.#lifecycle.signal, signal]) : this.#lifecycle.signal;
      try {
        if (request.tool === "browser" && request.action !== "status") {
          if (this.#recovery) await this.#recovery.catch(() => {});
          if (request.action !== "close" && [...this.#browser.values()].some((session) => session.cleanupRequired)) {
            try { await this.#recover(); }
            catch { return this.#error(request, "CLEANUP_PENDING", "A previous managed browser operation is uncertain; close its session before continuing"); }
          }
        }
        const value = await this.#execute(request, () => !this.#closed && generation === this.#generation && isActive() && !combined.aborted, combined);
        if (!isComputerUseResult(value, request)) return this.#error(request, "INVALID_TOOL_OUTPUT", "The native tool returned an invalid or oversized response");
        return value;
      } catch (error) {
        if (request.tool === "desktop" && request.action === "snapshot") this.#previews.clearDesktop(request.sessionId, "unavailable");
        if ("sessionId" in request) {
          const session = request.tool === "browser" ? this.#browser.get(request.sessionId) : this.#desktop.get(request.sessionId);
          session?.refs.clear();
          if (fenceKey) this.#fences.set(fenceKey, (this.#fences.get(fenceKey) ?? 0) + 1);
          if (request.tool === "browser" && session) { (session as BrowserSession).cleanupRequired = true; this.#cleanupFailed = true; }
        }
        if (error instanceof AgentCliError) return this.#error(request, error.code, error.message + (request.tool === "browser" && "sessionId" in request && this.#browser.has(request.sessionId) ? "; managed browser cleanup is required" : ""));
        return this.#error(request, "OPERATION_FAILED", "The native tool did not confirm the operation; observe before retrying");
      }
    });
    const tail = work.then(() => undefined, () => undefined);
    this.#queues.set(queue, tail);
    void tail.then(() => { if (this.#queues.get(queue) === tail) this.#queues.delete(queue); });
    return work;
  }

  #loadJournal(): void {
    try {
      const info = fs.lstatSync(this.#journal);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Managed browser journal must be a regular private file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const descriptor = fs.openSync(this.#journal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > 16_384 || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Managed browser journal must be private");
      const value = object(JSON.parse(fs.readFileSync(descriptor, "utf8")));
      if (!value || Object.keys(value).some((key) => key !== "version" && key !== "sessions") || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_BROWSER_SESSIONS || new Set(value.sessions).size !== value.sessions.length
        || value.sessions.some((session) => typeof session !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session))) throw new Error("Invalid managed browser journal");
      for (const sessionId of value.sessions as string[]) this.#browser.set(sessionId, { refs: new Set(), cleanupRequired: true });
    } finally { fs.closeSync(descriptor); }
  }

  #persistJournal(): void {
    const temporary = this.#journal + ".tmp-" + randomBytes(8).toString("hex");
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ version: 1, sessions: [...this.#browser.keys()] }));
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.#journal);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  #forgetBrowser(sessionId: string): void {
    const session = this.#browser.get(sessionId);
    if (!session) return;
    this.#browser.delete(sessionId);
    try { this.#persistJournal(); }
    catch (error) { session.cleanupRequired = true; this.#browser.set(sessionId, session); throw error; }
    this.#previews.close({ tool: "browser", sessionId });
    this.#cleanupFailed = [...this.#browser.values()].some((entry) => entry.cleanupRequired);
  }

  #recover(): Promise<void> {
    if (this.#recovery) return this.#recovery;
    const sessions = [...this.#browser].filter(([, session]) => session.cleanupRequired).map(([id]) => id);
    const work = (async () => {
      const results = await Promise.allSettled(sessions.map(async (sessionId) => {
        const raw = await this.#runner({ tool: "agent-browser", args: [...this.#browserArgs(sessionId), "close"], cwd: this.rootDir, env: this.#environment("browser"), timeoutMs: 5000 });
        const result = this.#native({ tool: "browser", action: "close", sessionId }, raw);
        if (result.failure) throw new Error("Managed browser cleanup was not confirmed");
        this.#forgetBrowser(sessionId);
      }));
      this.#cleanupFailed = results.some((result) => result.status === "rejected");
      if (this.#cleanupFailed) throw new Error("Managed browser sessions could not be closed");
    })();
    this.#recovery = work;
    void work.finally(() => { if (this.#recovery === work) this.#recovery = undefined; }).catch(() => {});
    return work;
  }

  #environment(tool: ComputerUseRequest["tool"]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of inheritedEnvironment) if (process.env[key] !== undefined) env[key] = process.env[key];
    if (tool === "browser") {
      env.AGENT_BROWSER_SOCKET_DIR = privateDirectory(this.#browserSocketDirectory);
      if (process.platform === "win32") env.AGENT_BROWSER_NAMESPACE = createHash("sha256").update(this.rootDir).digest("hex").slice(0,20);
      env.AGENT_BROWSER_NO_VERSION_CHECK = "1";
      env.AGENT_BROWSER_DEFAULT_TIMEOUT = "20000";
      env.AGENT_BROWSER_STREAM_QUALITY = "40";
      env.AGENT_BROWSER_STREAM_MAX_WIDTH = "960";
      env.AGENT_BROWSER_STREAM_MAX_HEIGHT = "640";
      const executable = process.env.MOCO_BROWSER_EXECUTABLE_PATH ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH;
      if (executable) env.AGENT_BROWSER_EXECUTABLE_PATH = executable;
    } else env.AGENT_DESKTOP_HOME = privateDirectory(path.join(this.rootDir, "desktop"));
    return env;
  }

  async #call(request: ComputerUseRequest, args: string[], active: () => boolean, signal: AbortSignal, input?: string): Promise<unknown> {
    if (!active()) throw new AgentCliError("CLI_ABORTED", "The computer-use operation was cancelled");
    const invocation: AgentCliInvocation = {
      tool: request.tool === "browser" ? "agent-browser" : "agent-desktop", args, cwd: this.rootDir, env: this.#environment(request.tool), signal, timeoutMs: 30_000,
      ...(input !== undefined ? { input } : {}),
    };
    const value = await this.#runner(invocation);
    if (!active()) throw new AgentCliError("CLI_ABORTED", "The computer-use operation was cancelled; observe before retrying");
    let encoded: string | undefined;
    try { encoded = JSON.stringify(value); } catch { /* Only a JSON envelope can cross the Env transport. */ }
    if (!encoded || Buffer.byteLength(encoded) > COMPUTER_USE_MAX_RESULT - 4096) throw new AgentCliError("CLI_OUTPUT_LIMIT", "The native tool returned an invalid or oversized response");
    return value;
  }

  #result(request: ComputerUseRequest, data: unknown): ComputerUseResult {
    return { tool: request.tool, action: request.action, ...("sessionId" in request ? { sessionId: request.sessionId } : {}), platform: this.#platform, ok: true, data };
  }

  #error(request: ComputerUseRequest, code: string, message: string): ComputerUseResult {
    return { tool: request.tool, action: request.action, ...("sessionId" in request ? { sessionId: request.sessionId } : {}), platform: this.#platform, ok: false, error: { code, message: message.slice(0,2000) } };
  }

  #native(request: ComputerUseRequest, value: unknown, batch = false): { data?: unknown; failure?: ComputerUseResult } {
    let envelope = value;
    if (batch) {
      if (!Array.isArray(value) || value.length !== 1) throw new AgentCliError("CLI_INVALID_OUTPUT", "The browser returned an invalid batch response");
      envelope = value[0];
    }
    const native = object(envelope) as NativeEnvelope | undefined;
    const successful = request.tool === "browser" ? native?.success : native?.ok;
    if (!native || typeof successful !== "boolean") throw new AgentCliError("CLI_INVALID_OUTPUT", "The native tool returned an invalid response");
    if (!successful) {
      const detail = object(native.error);
      const code = typeof detail?.code === "string" ? detail.code : typeof native.code === "string" ? native.code : "NATIVE_OPERATION_FAILED";
      let message = typeof detail?.message === "string" ? detail.message : typeof native.error === "string" ? native.error : "The native tool did not complete the operation";
      if ("text" in request && request.text) message = message.split(request.text).join("[input omitted]");
      return { failure: this.#error(request, code.slice(0,128), message) };
    }
    return { data: batch ? native.result : native.data };
  }

  async #execute(request: ComputerUseRequest, active: () => boolean, signal: AbortSignal): Promise<ComputerUseResult> {
    if (request.tool === "desktop" && (request.action === "permissions" || request.action === "permission-guide")) {
      if (this.#platform !== "darwin") return this.#result(request, {
        platform: this.#platform,
        permissions: [{ kind: "accessibility", state: "unsupported" }, { kind: "screen", state: "unsupported" }],
      } satisfies DesktopSystemPermissions);
      let guide: DesktopSystemPermissions["guide"];
      if (request.action === "permission-guide") {
        const opened = this.#native(request, await this.#call(request, ["permissions", "--guide"], active, signal));
        if (opened.failure) return opened.failure;
        const state = object(opened.data)?.guide;
        if (state !== "started" && state !== "already_running" && state !== "not_needed") {
          throw new AgentCliError("CLI_INVALID_OUTPUT", "The permission guide did not confirm its state; check System Settings before retrying");
        }
        guide = state;
      }
      const checked = this.#native(request, await this.#call(request, ["permissions"], active, signal));
      if (checked.failure) return checked.failure;
      const data = object(checked.data);
      const permission = (key: string): SystemPermissionState => {
        const state = object(data?.[key])?.state;
        if (typeof state !== "string" || !state || state.length > 64) throw new AgentCliError("CLI_INVALID_OUTPUT", "The desktop driver returned an invalid permission state");
        return ["granted", "not-determined", "denied", "restricted", "unsupported"].includes(state) ? state as SystemPermissionState : "unknown";
      };
      return this.#result(request, {
        platform: this.#platform,
        permissions: [{ kind: "accessibility", state: permission("accessibility") }, { kind: "screen", state: permission("screen_recording") }],
        ...(guide ? { guide } : {}),
      } satisfies DesktopSystemPermissions);
    }
    if (request.action === "status") {
      const native = await this.#call(request, request.tool === "browser" ? ["--config", this.#browserConfig, "--json", "doctor", "--quick", "--offline"] : ["status"], active, signal);
      if (request.tool === "browser") {
        const report = object(native);
        if (typeof report?.success !== "boolean" || !Array.isArray(report.checks)) throw new AgentCliError("CLI_INVALID_OUTPUT", "The browser returned an invalid diagnostic response");
        return this.#result(request, { configured: true, installed: true, diagnosticsPassed: report.success, executionVerified: false, cleanupPending: this.#cleanupFailed || Boolean(this.#recovery), checks: report.checks, summary: report.summary });
      }
      const result = this.#native(request, native);
      return result.failure ?? this.#result(request, { configured: true, installed: true, status: result.data });
    }
    if (request.tool === "browser") return this.#executeBrowser(request, active, signal);
    return this.#executeDesktop(request, active, signal);
  }

  #browserArgs(sessionId: string): string[] { return ["--config", this.#browserConfig, "--session", sessionId, "--json", "--idle-timeout", "5m", "--max-output", String(OUTPUT_CHARACTERS)]; }

  async #executeBrowser(request: Extract<ComputerUseRequest, { tool: "browser"; sessionId: string }>, active: () => boolean, signal: AbortSignal): Promise<ComputerUseResult> {
    let session = this.#browser.get(request.sessionId);
    if (request.action === "close" && !session) return this.#result(request, { closed: true });
    if (request.action === "open" && !session) {
      if (this.#browser.size >= MAX_BROWSER_SESSIONS) return this.#error(request, "SESSION_LIMIT", "Close an existing browser session before opening another");
      session = { refs: new Set(), cleanupRequired: false };
      this.#browser.set(request.sessionId, session);
      // Journal before spawning: a detached daemon may outlive this Env process.
      try { this.#persistJournal(); }
      catch (error) { this.#browser.delete(request.sessionId); throw error; }
    }
    if (!session) return this.#error(request, "SESSION_NOT_FOUND", "Open a browser session before using it");
    if ("ref" in request && request.ref !== undefined && !session.refs.has(request.ref.replace(/^@/, ""))) return this.#error(request, "REF_NOT_AUTHORIZED", "Take a fresh snapshot in this browser session before acting on a ref");
    const args = this.#browserArgs(request.sessionId);
    let input: string | undefined;
    const batch = request.action === "fill" || request.action === "type";
    switch (request.action) {
      case "open": args.push("open", request.url); break;
      case "snapshot": args.push("snapshot", "-i", "-c"); break;
      case "get-url": args.push("get", "url"); break;
      case "get-text": args.push("get", "text", "body"); break;
      case "click": args.push("click", `@${request.ref.replace(/^@/, "")}`); break;
      case "fill": case "type":
        args.push("batch", "--omit-command");
        input = JSON.stringify([[request.action, `@${request.ref.replace(/^@/, "")}`, "--", request.text]]);
        break;
      case "scroll":
        args.push("scroll", request.direction, String(request.amount ?? 500));
        break;
      case "wait":
        if (request.timeoutMs !== undefined) args.push("--timeout", String(request.timeoutMs));
        if (request.ref !== undefined) args.push("wait", `@${request.ref.replace(/^@/, "")}`);
        else args.push("wait", "--text", request.text!);
        break;
      case "back": case "forward": case "close": args.push(request.action); break;
    }
    if (!["get-url", "get-text"].includes(request.action)) session.refs.clear();
    const value = await this.#call(request, args, active, signal, input);
    const native = this.#native(request, value, batch);
    if (native.failure) return native.failure;
    if (request.action === "open") session.previewReady = true;
    if (request.action === "close") this.#forgetBrowser(request.sessionId);
    if (request.action === "snapshot") session.refs = references(native.data, false);
    if (request.action !== "close") this.#previews.changed({ tool: "browser", sessionId: request.sessionId });
    return this.#result(request, batch ? { actionAccepted: true, observationRequired: true } : native.data);
  }

  async #executeDesktop(request: Extract<ComputerUseRequest, { tool: "desktop"; sessionId: string }>, active: () => boolean, signal: AbortSignal): Promise<ComputerUseResult> {
    if (request.action === "close") {
      this.#previews.close({ tool: "desktop", sessionId: request.sessionId });
      const state = path.join(this.rootDir, "desktop", "sessions", request.sessionId);
      fs.rmSync(state, { recursive: true, force: true });
      this.#desktop.delete(request.sessionId);
      return this.#result(request, { closed: true });
    }
    if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(request.app)) {
      return this.#error(request, "INVALID_INPUT", "Use an application name without bidirectional control characters");
    }
    // Native app grants apply to the fixed application broker, including when a desktop driver is installed.
    if (this.#platform === "darwin" && new Set(["messages", "信息", "消息", "com.apple.mobilesms", "com.apple.ichat", "mail", "邮件", "com.apple.mail"]).has(request.app.trim().toLowerCase())) {
      return this.#error(request, "APPLICATION_CONNECTION_REQUIRED", "Use the connected Messages or Mail application through moco_connection_use");
    }
    if ("text" in request && Buffer.byteLength(request.text) > 10_000) return this.#error(request, "INVALID_INPUT", "Desktop text input exceeds 10,000 UTF-8 bytes");
    const session = this.#desktop.get(request.sessionId);
    if (request.action !== "snapshot" && request.action !== "wait" && (!session || session.app !== request.app || !("ref" in request) || !session.refs.has(request.ref))) {
      return this.#error(request, "REF_NOT_AUTHORIZED", "Take a fresh snapshot of this app in the same desktop session before acting on a ref");
    }
    if ((request.action === "snapshot" || request.action === "wait") && !session && this.#desktop.size >= MAX_DESKTOP_SESSIONS) return this.#error(request, "SESSION_LIMIT", "Close an existing desktop session before opening another");
    const args = ["--session", request.sessionId];
    let input: string | undefined;
    if (request.action === "snapshot" || request.action === "wait") {
      session?.refs.clear();
      this.#desktop.delete(request.sessionId);
      if (session?.app !== request.app) this.#previews.clearDesktop(request.sessionId, "connecting");
      // Keep read-only labels so the next observation can verify an action's effect.
      args.push("snapshot", "--app", request.app, "--compact");
      if (request.action === "wait") {
        args.push("-w", request.text, "--wait-timeout", String(request.timeoutMs ?? 5_000));
      }
    } else if (request.action === "scroll") {
      session!.refs.clear();
      args.push("scroll", request.ref, "--direction", request.direction, "--amount", String(request.amount ?? 3));
    } else {
      session!.refs.clear();
      args.push(request.action, request.ref);
      if ("text" in request) { args.push("--stdin"); input = request.text; }
    }
    const native = this.#native(request, await this.#call(request, args, active, signal, input));
    if (native.failure) {
      if (request.action === "snapshot" || request.action === "wait") this.#previews.clearDesktop(request.sessionId, "unavailable");
      return native.failure;
    }
    if (request.action === "snapshot" || request.action === "wait") {
      const id = object(object(native.data)?.window)?.id;
      this.#desktop.set(request.sessionId, { app: request.app, ...(typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id) ? { windowId: id } : {}), refs: references(native.data, true) });
    }
    this.#previews.changed({ tool: "desktop", sessionId: request.sessionId });
    return this.#result(request, (request.action === "snapshot" || request.action === "wait") ? native.data : { actionAccepted: true, observationRequired: true });
  }

  suspend(): Promise<void> {
    if (this.#suspending) return this.#suspending;
    this.#generation++;
    this.#previews.suspend();
    this.#lifecycle.abort();
    const desktopSessions = [...this.#desktop.keys()];
    for (const session of this.#browser.values()) { session.cleanupRequired = true; session.refs.clear(); }
    for (const session of this.#desktop.values()) session.refs.clear();
    const work = (async () => {
      const closed = await Promise.allSettled([this.#recover(), ...desktopSessions.map(async (sessionId) => {
        fs.rmSync(path.join(this.rootDir, "desktop", "sessions", sessionId), { recursive: true, force: true });
        this.#desktop.delete(sessionId);
      })]);
      this.#cleanupFailed = closed.some((result) => result.status === "rejected");
      if (this.#cleanupFailed) throw new Error("Managed browser sessions could not be closed");
    })();
    this.#suspending = work;
    void work.finally(() => { this.#suspending = undefined; this.#lifecycle = new AbortController(); }).catch(() => {});
    return work;
  }

  async close(): Promise<void> { this.#closed = true; await this.suspend(); }
}
