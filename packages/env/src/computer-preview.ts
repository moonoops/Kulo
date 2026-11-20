import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { COMPUTER_PREVIEW_MAX_DATA, isComputerPreviewTarget, isComputerPreviewUpdate, type ComputerPreviewTarget, type ComputerPreviewUpdate } from "@kulo/protocol";
import type { AgentCliInvocation, AgentCliRunner } from "./agent-cli.js";

interface PreviewEntry {
  target: ComputerPreviewTarget;
  listeners: Set<(update: ComputerPreviewUpdate) => void>;
  update: ComputerPreviewUpdate;
  controller: AbortController;
  socket?: WebSocket;
  starting?: boolean;
  capturing?: boolean;
  captureAgain?: boolean;
  desktopBinding?: string;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempt?: number;
}

interface PreviewOptions {
  rootDir: string;
  runner: AgentCliRunner;
  browserInvocation(sessionId: string): Omit<AgentCliInvocation, "tool" | "timeoutMs" | "signal"> | undefined;
  browserDisconnectMessage?(sessionId: string): string | undefined;
  desktopTarget(sessionId: string): { app: string; windowId?: string } | undefined;
  desktopEnvironment(): NodeJS.ProcessEnv;
  queueDesktop(work: () => Promise<void>): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class ComputerPreviewService {
  readonly #options: PreviewOptions;
  readonly #entries = new Map<string, PreviewEntry>();

  constructor(options: PreviewOptions) { this.#options = options; }

  subscribe(target: ComputerPreviewTarget, listener: (update: ComputerPreviewUpdate) => void): () => void {
    if (!isComputerPreviewTarget(target)) throw new Error("Invalid computer preview target");
    const key = `${target.tool}:${target.sessionId}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= 16) throw new Error("Computer preview subscription limit reached");
      entry = { target: { ...target }, listeners: new Set(), update: { state: "connecting" }, controller: new AbortController() };
      this.#entries.set(key, entry);
    }
    entry.listeners.add(listener);
    listener(entry.update);
    this.changed(target);
    return () => {
      entry!.listeners.delete(listener);
      if (!entry!.listeners.size && this.#entries.get(key) === entry) this.#dispose(key, entry!);
    };
  }

  changed(target: ComputerPreviewTarget): void {
    const entry = this.#entries.get(`${target.tool}:${target.sessionId}`);
    if (!entry) return;
    if (target.tool === "browser") void this.#browser(entry);
    else this.#desktop(entry);
  }

  clearDesktop(
    sessionId: string,
    state: "connecting" | "unavailable",
    detail?: { message?: string; permissionRequired?: "accessibility" | "screen" },
  ): void {
    const entry = this.#entries.get(`desktop:${sessionId}`);
    if (!entry) return;
    entry.desktopBinding = undefined;
    this.#publish(entry, {
      state,
      ...(state === "unavailable"
        ? {
            message: detail?.message ?? "无法确认当前目标窗口",
            ...(detail?.permissionRequired ? { permissionRequired: detail.permissionRequired } : {}),
          }
        : {}),
    });
  }

  close(target: ComputerPreviewTarget): void {
    const key = `${target.tool}:${target.sessionId}`;
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#publish(entry, { state: "closed" });
    this.#dispose(key, entry);
  }

  suspend(): void {
    for (const entry of [...this.#entries.values()]) this.close(entry.target);
  }

  #dispose(key: string, entry: PreviewEntry): void {
    this.#entries.delete(key);
    entry.controller.abort();
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.socket?.terminate();
    entry.listeners.clear();
  }

  #publish(entry: PreviewEntry, update: ComputerPreviewUpdate): void {
    if (entry.controller.signal.aborted || !isComputerPreviewUpdate(update)) return;
    entry.update = update;
    for (const listener of entry.listeners) listener(update);
  }

  async #browser(entry: PreviewEntry): Promise<void> {
    if (entry.starting || entry.socket || entry.reconnectTimer || entry.controller.signal.aborted) return;
    const invocation = this.#options.browserInvocation(entry.target.sessionId);
    if (!invocation) return;
    entry.starting = true;
    try {
      const raw = record(await this.#options.runner({ ...invocation, tool: "agent-browser", args: [...invocation.args, "stream", "status"], signal: entry.controller.signal, timeoutMs: 5000 }));
      if (entry.controller.signal.aborted) return;
      const status = record(raw?.data);
      const port = status?.port;
      if (raw?.success !== true || status?.enabled !== true || !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
        this.#publish(entry, { state: "unavailable", message: "浏览器画面流不可用" });
        this.#reconnect(entry);
        return;
      }
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=5`, { maxPayload: COMPUTER_PREVIEW_MAX_DATA + 16_384, handshakeTimeout: 5000, perMessageDeflate: false });
      entry.socket = socket;
      socket.on("open", () => { entry.reconnectAttempt = 0; });
      socket.on("message", (bytes, binary) => {
        if (binary || entry.controller.signal.aborted) return;
        let message: Record<string, unknown> | undefined;
        try { message = record(JSON.parse(bytes.toString())); }
        catch { this.#publish(entry, { state: "unavailable", message: "浏览器画面格式无效" }); socket.terminate(); return; }
        if (message?.type === "frame") {
          const data = message.data;
          const timestamp = record(message.metadata)?.timestamp;
          const update: ComputerPreviewUpdate = { state: "live", frame: { mimeType: "image/jpeg", data: typeof data === "string" ? data : "", capturedAt: typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : Date.now() } };
          if (!isComputerPreviewUpdate(update)) {
            this.#publish(entry, { state: "unavailable", message: "浏览器画面格式无效" });
            socket.terminate();
            return;
          }
          this.#publish(entry, update);
          if (Number.isSafeInteger(message.seq) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ack", seq: message.seq }));
        } else if (message?.type === "status" && message.connected === false) {
          this.#publish(entry, { state: "unavailable", message: this.#options.browserDisconnectMessage?.(entry.target.sessionId) ?? "浏览器画面连接已断开" });
        } else if (message?.type === "status" && message.connected === true && entry.update.state === "unavailable") {
          this.#publish(entry, { state: "connecting" });
        }
      });
      socket.on("error", () => this.#publish(entry, { state: "unavailable", message: "浏览器画面连接失败" }));
      socket.on("close", () => {
        if (entry.socket === socket) entry.socket = undefined;
        this.#publish(entry, { state: "unavailable", message: this.#options.browserDisconnectMessage?.(entry.target.sessionId) ?? "浏览器画面连接已断开" });
        this.#reconnect(entry);
      });
    } catch {
      this.#publish(entry, { state: "unavailable", message: "无法读取浏览器画面" });
      this.#reconnect(entry);
    } finally { entry.starting = false; }
  }

  #reconnect(entry: PreviewEntry): void {
    if (entry.controller.signal.aborted || entry.reconnectTimer || !this.#options.browserInvocation(entry.target.sessionId)) return;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      void this.#browser(entry);
    }, Math.min(5000, 500 * 2 ** Math.min(entry.reconnectAttempt ?? 0, 4)));
    entry.reconnectAttempt = (entry.reconnectAttempt ?? 0) + 1;
    entry.reconnectTimer.unref();
  }

  #desktop(entry: PreviewEntry): void {
    if (entry.controller.signal.aborted) return;
    const target = this.#options.desktopTarget(entry.target.sessionId);
    if (!target) return;
    const binding = `${target.app}\0${target.windowId ?? ""}`;
    if (entry.desktopBinding !== binding) {
      entry.desktopBinding = binding;
      this.#publish(entry, { state: "connecting" });
    }
    if (entry.capturing) { entry.captureAgain = true; return; }
    if (!target.windowId) {
      this.#publish(entry, { state: "unavailable", message: "当前应用没有可预览的目标窗口" });
      return;
    }
    entry.capturing = true;
    this.#options.queueDesktop(async () => {
      let temporary: string | undefined;
      try {
        if (entry.controller.signal.aborted) return;
        const current = this.#options.desktopTarget(entry.target.sessionId);
        if (current?.app !== target.app || current.windowId !== target.windowId) return;
        temporary = fs.mkdtempSync(path.join(this.#options.rootDir, "preview-"));
        const filename = path.join(temporary, "window.png");
        const native = record(await this.#options.runner({ tool: "agent-desktop", args: ["--session", entry.target.sessionId, "screenshot", "--app", target.app, "--window-id", target.windowId!, filename], cwd: this.#options.rootDir, env: this.#options.desktopEnvironment(), signal: entry.controller.signal, timeoutMs: 5000 }));
        if (entry.controller.signal.aborted) return;
        if (native?.ok !== true) {
          const code = record(native?.error)?.code;
          this.#publish(entry, { state: "unavailable", message: code === "PERM_DENIED" ? "需要录屏权限才能预览窗口" : "当前窗口无法截图", ...(code === "PERM_DENIED" ? { permissionRequired: "screen" as const } : {}) });
          return;
        }
        const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let data: string;
        try {
          const stat = fs.fstatSync(descriptor);
          if (!stat.isFile() || stat.size < 8 || stat.size > COMPUTER_PREVIEW_MAX_DATA * 3 / 4) throw new Error("Invalid preview image");
          const bytes = fs.readFileSync(descriptor);
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid PNG preview");
          data = bytes.toString("base64");
        } finally { fs.closeSync(descriptor); }
        const after = this.#options.desktopTarget(entry.target.sessionId);
        if (after?.app === target.app && after.windowId === target.windowId) this.#publish(entry, { state: "live", frame: { mimeType: "image/png", data, capturedAt: Date.now() } });
      } catch {
        this.#publish(entry, { state: "unavailable", message: "无法读取目标窗口截图" });
      } finally {
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
        entry.capturing = false;
        if (entry.captureAgain) { entry.captureAgain = false; this.#desktop(entry); }
      }
    });
  }
}
