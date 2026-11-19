import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { localDaemon } from "@earendil-works/pi-env";
import WebSocket from "ws";
import { canonicalExecutionPath, createWorkerSandbox, nativeProtectedPaths, workerIsolationCapabilities, type WorkerSandbox } from "./isolation.js";
import { ExternalAgentService, isExternalAgentRequest } from "./external-agents.js";
import type { ExternalAgentMcpInvocation } from "./external-agent-mcp.js";
import { randomBytes } from "node:crypto";
import { ProjectDirectoryRegistry } from "./project-directories.js";
import { StagedWorkspaceService } from "./staged-workspace-service.js";
import { cleanupRecordedExecutions, hasOrphanedExecution } from "./worker-supervisor.js";
import { collectDeviceSystemInfo } from "./device-info.js";
import { FlowBrowserService } from "./browser.js";
import { ComputerUseService, computerUseConfiguration } from "./computer-use.js";
import { StreamResumeBuffer } from "./stream-resume.js";
import {
  STREAM_RESUME_CAPABILITY,
  STREAM_RESUME_GRACE_MS,
  decodeSequencedStreamChunk,
  decodeStreamChunk,
  encodeSequencedStreamChunk,
  encodeStreamChunk,
  type StreamResumeState,
  isComputerUseRequest,
  isComputerUseResult,
  isComputerPreviewTarget,
  isComputerPreviewUpdate,
  COMPUTER_PREVIEW_MAX_DATA,
  type EnvToHubControlMessage,
  type HubToEnvControlMessage,
  type ProjectEnvRequest,
  type BrowserRequest,
  type ComputerUseRequest,
  type ComputerPreviewTarget,
  type ComputerPreviewUpdate,
} from "@kulo/protocol";

function ownRuntimeProtectedPaths(): string[] {
  const envPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = [envPackage, path.join(envPackage, "node_modules"), path.resolve(envPackage, "../../node_modules")];
  for (const sibling of ["cli", "protocol"]) paths.push(path.resolve(envPackage, "..", sibling));
  try {
    const protocolEntry = createRequire(import.meta.url).resolve("@kulo/protocol");
    paths.push(path.resolve(path.dirname(protocolEntry), ".."));
  } catch (error) {
    // Installed peers bundle the protocol into their own protected runtime.
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  for (let current = envPackage; current !== path.dirname(current); current = path.dirname(current)) {
    if (path.basename(current) === "node_modules") paths.push(current);
  }
  return [...new Set(paths.filter((entry) => fs.existsSync(entry)))];
}

export interface KuloEnvAgentOptions {
  /** Hub WebSocket URL, e.g. `ws://127.0.0.1:7788/ws/env` or `wss://hub.example.com/ws/env` */
  hubUrl: string;
  /** Unique environment ID, e.g. `macbook`, `mac-mini`, `mostation` */
  envId: string;
  /** Human-readable label shown in UI */
  name?: string;
  /** Root working directory for isolated ticket workspaces on this machine */
  rootDir: string;
  /** Node-specific credential; never use the Hub management token. */
  authToken?: string;
  protectedPaths?: string[];
  projectGrantFile?: string;
  browserService?: FlowBrowserService;
  computerUseService?: ComputerUseService;
  externalAgentService?: ExternalAgentService;
  /** Optional extra capability tags, e.g. `["macos-gui"]` */
  capabilities?: string[];
  /** Auto-reconnect when disconnected (default: true) */
  reconnect?: boolean;
  /** Grace window in ms to keep daemons and sessions alive during brief disconnects (default: 20_000). */
  streamResumeGraceMs?: number;
  onLog?: (msg: string) => void;
}

/**
 * Outbound Execution Environment Agent (`kulo env`).
 * Connects from any PC / Mac mini / Linux server to `kulo-hub` and spawns
 * the official `@earendil-works/pi-env` native Rust daemon (`localDaemon()`) on demand.
 */
export class KuloEnvAgent {
  readonly #options: KuloEnvAgentOptions;
  readonly #rootDir: string;
  readonly #launchProtectedPaths: string[];
  #ws: WebSocket | null = null;
  readonly #daemons = new Map<number, ChildProcessWithoutNullStreams>();
  readonly #workerSandboxes = new Map<number, WorkerSandbox>();
  readonly #streamScopes = new Map<number, { workspaceDir?: string; scratchDir?: string; projectId?: string }>();
  readonly #streamBuffers = new Map<number, StreamResumeBuffer>();
  readonly #streamAckTimers = new Map<number, NodeJS.Timeout>();
  readonly #cleaningStreams = new Map<number, Promise<boolean>>();
  readonly #streamResumeGraceMs: number;
  #hubInstanceId?: string;
  #streamResumeNegotiated = false;
  #graceTimer: NodeJS.Timeout | null = null;
  #unackedTotalBytes = 0;
  readonly #projectDirectories: ProjectDirectoryRegistry;
  readonly #stagedWorkspaces: StagedWorkspaceService;
  readonly #browser: FlowBrowserService;
  readonly #computer: ComputerUseService;
  readonly #externalAgents: ExternalAgentService;
  readonly #externalTools = new Map<string, { ws: WebSocket; scope: ExternalAgentMcpInvocation; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #computerRequests = new Map<string, { ws: WebSocket; controller: AbortController }>();
  readonly #computerPreviews = new Map<string, { ws: WebSocket; stop: () => void; pending?: ComputerPreviewUpdate; flushTimer?: NodeJS.Timeout }>();
  #registered = false;
  #controlQueue: Promise<void> = Promise.resolve();
  #stopped = false;
  #reconnectAttempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #registeredWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  get registered(): boolean { return this.#registered && this.#ws?.readyState === WebSocket.OPEN; }

  get hasActiveExecution(): boolean { return this.#daemons.size > 0 || this.#externalAgents.hasActiveRuns; }

  constructor(options: KuloEnvAgentOptions) {
    this.#options = options;
    this.#streamResumeGraceMs = options.streamResumeGraceMs ?? STREAM_RESUME_GRACE_MS;
    this.#rootDir = path.resolve(options.rootDir);
    this.#launchProtectedPaths = [
      path.resolve(".env"),
      path.resolve(process.env.KULO_PEER_CONFIG?.trim() || path.join(os.homedir(), ".kulo", "connection.json")),
    ];
    fs.mkdirSync(this.#rootDir, { recursive: true });
    this.#projectDirectories = new ProjectDirectoryRegistry({ deviceId: options.envId, filePath: options.projectGrantFile ?? path.join(this.#rootDir, ".kulo-env", "project-grants.json"), scratchRoot: path.join(this.#rootDir, "scratch"), getProtectedPaths: () => [...this.#launchProtectedPaths, ...ownRuntimeProtectedPaths(), ...(this.#options.protectedPaths ?? [])] });
    this.#stagedWorkspaces = new StagedWorkspaceService({ projectRegistry: this.#projectDirectories });
    this.#browser = options.browserService ?? new FlowBrowserService({ rootDir: path.join(this.#projectDirectories.privateDirectory, "browser") });
    this.#launchProtectedPaths.push(this.#browser.rootDir);
    this.#computer = options.computerUseService ?? new ComputerUseService({ rootDir: path.join(this.#projectDirectories.privateDirectory, "computer-use"), ...computerUseConfiguration() });
    this.#launchProtectedPaths.push(this.#computer.rootDir);
    this.#externalAgents = options.externalAgentService ?? new ExternalAgentService({ envId: options.envId, rootDir: this.#rootDir, projectRegistry: this.#projectDirectories, toolHandler: invocation => this.#requestExternalTool(invocation) });
  }

  /** Start the agent and resolve once initial registration with Hub completes. */
  async start(): Promise<void> {
    this.#stopped = false;
    await cleanupRecordedExecutions(path.join(this.#projectDirectories.privateDirectory, "executions"));
    await this.#externalAgents.recover?.();
    return new Promise<void>((resolve, reject) => {
      this.#registeredWaiters.push({ resolve, reject });
      this.#connect();
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const waiter of this.#registeredWaiters.splice(0)) {
      waiter.reject(new Error("Env agent stopped"));
    }
    this.#cancelComputerRequests();
    if (this.#graceTimer) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    await this.#externalAgents.close();
    await this.#killAllDaemons();
    const browserCleanup = Promise.allSettled([this.#browser.suspend(), this.#computer.suspend()]);
    if (this.#ws) {
      const ws = this.#ws;
      this.#ws = null;
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000, "Env agent stopping");
      });
    }
    if ((await browserCleanup).some((result) => result.status === "rejected")) throw new Error("Some owned browser or desktop sessions could not close");
  }

  #connect(): void {
    if (this.#stopped) return;

    const ws = new WebSocket(this.#options.hubUrl);
    this.#ws = ws;
    this.#registered = false;

    ws.on("open", () => {
      this.#reconnectAttempt = 0;
      const defaultCaps =
        process.platform === "darwin" ? ["fs", "bash", "macos-gui"] : ["fs", "bash"];
      const capabilities = Array.from(
        new Set([...defaultCaps, STREAM_RESUME_CAPABILITY, "external-agents", ...workerIsolationCapabilities(), ...(this.#options.capabilities ?? []).filter((capability) => !["flow-browser", "agent-browser", "agent-desktop"].includes(capability)), ...(this.#browser.available ? ["flow-browser"] : []), ...this.#computer.capabilities()]),
      );
      const activeStreams: StreamResumeState[] = [];
      for (const streamId of this.#daemons.keys()) {
        const buffer = this.#streamBuffers.get(streamId);
        activeStreams.push({ streamId, rxSeq: buffer?.rxSeq ?? 0 });
      }

      this.#sendControl(ws, {
        type: "env.register",
        envId: this.#options.envId,
        name: this.#options.name ?? `${this.#options.envId} (${os.hostname()})`,
        rootDir: this.#rootDir,
        platform: process.platform,
        arch: process.arch,
        capabilities,
        token: this.#options.authToken,
        info: collectDeviceSystemInfo(),
        ...(this.#hubInstanceId ? { hubInstanceId: this.#hubInstanceId } : {}),
        ...(activeStreams.length ? { activeStreams } : {}),
      });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        try {
          const buf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (this.#streamResumeNegotiated) {
            const { streamId, seq, payload } = decodeSequencedStreamChunk(buf);
            const child = this.#daemons.get(streamId);
            const buffer = this.#streamBuffers.get(streamId);
            if (child && !child.killed && buffer) {
              const accepted = buffer.acceptIncoming(seq, payload);
              if (accepted.status === "deliver") {
                child.stdin.write(accepted.payload);
                this.#scheduleStreamAck(ws, streamId, buffer, accepted.shouldAckNow);
              } else if (accepted.status === "gap") {
                void this.#stopStream(streamId, true).catch(() => {});
              }
            }
          } else {
            const { streamId, payload } = decodeStreamChunk(buf);
            const child = this.#daemons.get(streamId);
            if (child && !child.killed) {
              child.stdin.write(payload);
            }
          }
        } catch {
          // ignore malformed binary frame
        }
        return;
      }

      let msg: HubToEnvControlMessage;
      try {
        msg = JSON.parse(data.toString("utf8")) as HubToEnvControlMessage;
      } catch {
        return;
      }

      if (msg.type === "hub.registered") {
        if (msg.envId !== this.#options.envId || ws !== this.#ws) return;
        if (this.#graceTimer) {
          clearTimeout(this.#graceTimer);
          this.#graceTimer = null;
        }
        const hubRestarted = Boolean(this.#hubInstanceId && msg.hubInstanceId && this.#hubInstanceId !== msg.hubInstanceId);
        this.#hubInstanceId = msg.hubInstanceId;
        this.#streamResumeNegotiated = Boolean(msg.streamResumeSupported);
        this.#registered = true;
        this.#log(`Registered env '${msg.envId}' -> ${this.#rootDir}`);

        if (hubRestarted) {
          void this.#browser.suspend().catch(() => {});
          void this.#computer.suspend().catch(() => {});
          void this.#killAllDaemons(true).catch(() => {});
        } else {
          const resumedMap = new Map((msg.resumedStreams ?? []).map((entry) => [entry.streamId, entry.rxSeq]));
          const toClose = new Set<number>(msg.closeStreams ?? []);
          for (const streamId of this.#daemons.keys()) {
            if (!resumedMap.has(streamId)) toClose.add(streamId);
          }
          for (const streamId of toClose) {
            void this.#stopStream(streamId, true).catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Worker cleanup failed"));
          }
          for (const [streamId, hubRxSeq] of resumedMap) {
            const buffer = this.#streamBuffers.get(streamId);
            if (!buffer) continue;
            const { freedBytes, frames } = buffer.replayFrom(hubRxSeq);
            this.#unackedTotalBytes = Math.max(0, this.#unackedTotalBytes - freedBytes);
            for (const frame of frames) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeSequencedStreamChunk(streamId, frame.seq, frame.payload));
              }
            }
          }
        }

        for (const waiter of this.#registeredWaiters.splice(0)) {
          waiter.resolve();
        }
      } else if (msg.type === "hub.ping") {
        this.#sendControl(ws, { type: "env.pong", ts: msg.ts });
      } else if (msg.type === "hub.open_stream") {
        this.#spawnDaemonStream(ws, msg);
      } else if (msg.type === "hub.stream_ack") {
        const buffer = this.#streamBuffers.get(msg.streamId);
        if (buffer && Number.isSafeInteger(msg.rxSeq)) {
          const freed = buffer.ackOutgoing(msg.rxSeq);
          this.#unackedTotalBytes = Math.max(0, this.#unackedTotalBytes - freed);
        }
      } else if (msg.type === "hub.external_agent_request") {
        void this.#handleExternalAgentRequest(ws, msg);
      } else if (msg.type === "hub.external_agent_tool_result") {
        const pending = this.#externalTools.get(msg.requestId);
        if (!pending || pending.ws !== ws || ws !== this.#ws || pending.scope.runId !== msg.runId || pending.scope.taskId !== msg.taskId || pending.scope.runEpoch !== msg.runEpoch) return;
        clearTimeout(pending.timer); this.#externalTools.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(msg.error.slice(0, 2000))); else pending.resolve(msg.result);
      } else if (msg.type === "hub.project_request") {
        this.#controlQueue = this.#controlQueue.then(() => this.#handleProjectRequest(ws, msg.requestId, msg.request)).catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Project control request failed"));
      } else if (msg.type === "hub.browser_request") {
        void this.#handleBrowserRequest(ws, msg.requestId, msg.request);
      } else if (msg.type === "hub.computer_request") {
        void this.#handleComputerRequest(ws, msg.requestId, msg.request);
      } else if (msg.type === "hub.computer_preview_subscribe") {
        this.#subscribeComputerPreview(ws, msg.subscriptionId, msg.target);
      } else if (msg.type === "hub.computer_preview_unsubscribe") {
        const preview = this.#computerPreviews.get(msg.subscriptionId);
        if (preview?.ws === ws) {
          this.#computerPreviews.delete(msg.subscriptionId);
          if (preview.flushTimer) clearTimeout(preview.flushTimer);
          preview.stop();
        }
      } else if (msg.type === "hub.computer_cancel") {
        if (ws === this.#ws && this.#registered && typeof msg.requestId === "string") {
          const pending = this.#computerRequests.get(msg.requestId);
          if (pending?.ws === ws) pending.controller.abort();
        }
      } else if (msg.type === "hub.close_stream") {
        void this.#stopStream(msg.streamId, true).catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Worker cleanup failed"));
      }
    });

    ws.on("close", (code, reasonBuf) => {
      for (const [id, pending] of this.#externalTools) if (pending.ws === ws) { clearTimeout(pending.timer); this.#externalTools.delete(id); pending.reject(new Error("Hub disconnected before task tool result was confirmed")); }
      const isCurrentSocket = ws === this.#ws;
      if (isCurrentSocket) {
        this.#registered = false;
        this.#cancelComputerRequests(ws);
      }

      const immediateRevokeOrStop =
        this.#stopped ||
        code === 1000 ||
        code === 4001 ||
        code === 4002 ||
        code === 4003 ||
        this.#options.reconnect === false ||
        !this.#streamResumeNegotiated ||
        this.#streamResumeGraceMs <= 0;

      if (immediateRevokeOrStop) {
        if (this.#graceTimer) {
          clearTimeout(this.#graceTimer);
          this.#graceTimer = null;
        }
        if (isCurrentSocket) {
          void this.#browser.suspend().catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Flow browser cleanup failed"));
          void this.#computer.suspend().catch(() => this.#log("Computer-use session cleanup failed"));
        }
        void this.#killAllDaemons().catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Worker cleanup failed"));
      } else if (isCurrentSocket && !this.#graceTimer) {
        // Hold active daemons, browser, and computer sessions alive for the 20s reconnect grace window.
        this.#graceTimer = setTimeout(() => {
          this.#graceTimer = null;
          if (this.#registered && this.#ws?.readyState === WebSocket.OPEN) return;
          void this.#browser.suspend().catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Flow browser cleanup failed"));
          void this.#computer.suspend().catch(() => this.#log("Computer-use session cleanup failed"));
          void this.#killAllDaemons().catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Worker cleanup failed"));
        }, this.#streamResumeGraceMs);
        this.#graceTimer.unref();
      }

      if (this.#stopped) return;

      const reason = reasonBuf.toString("utf8");
      if (code === 4001 || code === 4002) {
        const err = new Error(`Hub rejected env registration (${code}): ${reason}`);
        for (const waiter of this.#registeredWaiters.splice(0)) {
          waiter.reject(err);
        }
        return;
      }

      if (this.#options.reconnect === false) {
        const err = new Error(`Connection to Hub closed (${code}): ${reason}`);
        for (const waiter of this.#registeredWaiters.splice(0)) {
          waiter.reject(err);
        }
        return;
      }

      const attempt = this.#reconnectAttempt++;
      const delayMs = attempt === 0 ? 300 : Math.min(15_000, 800 * 2 ** Math.min(attempt - 1, 4));
      this.#log(`Disconnected from Hub (${code}). Reconnecting in ${delayMs}ms...`);
      this.#reconnectTimer = setTimeout(() => this.#connect(), delayMs);
      this.#reconnectTimer.unref();
    });

    ws.on("error", (err) => {
      this.#log(`WebSocket error: ${err.message}`);
    });
  }

  #spawnDaemonStream(ws: WebSocket, message: Extract<HubToEnvControlMessage, { type: "hub.open_stream" }>): void {
    const { streamId, daemonToken } = message;
    if (this.#daemons.has(streamId)) {
      this.#sendControl(ws, { type: "env.stream_closed", streamId, error: "Duplicate execution stream" });
      return;
    }
    let command: readonly string[];
    let workerSandbox: WorkerSandbox | undefined;
    try {
      if (message.workspaceDir) {
        if (hasOrphanedExecution(path.join(this.#projectDirectories.privateDirectory, "executions"), canonicalExecutionPath(message.workspaceDir))) throw new Error("Previous Worker execution cleanup is pending");
        let rootDir = canonicalExecutionPath(this.#rootDir);
        if (message.projectId && message.stagedTaskId) {
          rootDir = this.#stagedWorkspaces.validateStagedCwd(message.stagedTaskId, message.projectId, message.workspaceDir, message.grantRevision).stagedDir;
          if (message.scratchDir) this.#projectDirectories.validateScratch(message.scratchDir);
        } else if (message.projectId) {
          rootDir = this.#projectDirectories.validate(message.projectId, message.workspaceDir, message.grantRevision).workspaceDir;
          if (message.scratchDir) this.#projectDirectories.validateScratch(message.scratchDir);
        }
        if (!message.projectId) {
          this.#projectDirectories.assertUnregistered(message.workspaceDir);
          if (message.scratchDir) this.#projectDirectories.assertUnregistered(message.scratchDir);
        }
        for (const requested of message.projectId ? [] : [message.workspaceDir, ...(message.scratchDir ? [message.scratchDir] : [])]) {
          const relative = path.relative(rootDir, canonicalExecutionPath(requested));
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error("Worker execution path is outside this Env's registered root");
          }
        }
        for (const id of this.#cleaningStreams.keys()) {
          if (this.#streamScopes.get(id)?.workspaceDir === canonicalExecutionPath(message.workspaceDir)) throw new Error("Previous Worker execution cleanup is pending");
        }
        workerSandbox = createWorkerSandbox({
          workspaceDir: message.workspaceDir,
          workspaceRoot: rootDir,
          managedScratchRoot: this.#projectDirectories.scratchRoot,
          scratchDir: message.scratchDir,
          projectId: message.projectId,
          grantRevision: message.grantRevision,
          readOnly: message.readOnly,
          controlRoot: path.join(this.#projectDirectories.privateDirectory, "executions"),
          protectedPaths: nativeProtectedPaths([
            path.join(this.#rootDir, ".kulo-state"),
            path.join(this.#rootDir, ".env"),
            this.#projectDirectories.privateDirectory,
            ...this.#launchProtectedPaths,
            ...ownRuntimeProtectedPaths(),
            ...(this.#options.protectedPaths ?? []),
            ...(message.protectedPaths ?? []),
          ]),
          network: message.network,
        });
        command = workerSandbox.command;
      } else {
        if (message.readOnly || message.network?.offline || message.projectId || message.stagedTaskId) {
          throw new Error("Sandboxed or constrained execution stream requires workspaceDir");
        }
        command = [localDaemon()];
      }
    } catch (err) {
      this.#sendControl(ws, {
        type: "env.stream_closed",
        streamId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const [executable, ...args] = command;
    const child = spawn(executable!, [...args, "serve", "--token", daemonToken], {
      cwd: workerSandbox?.workspaceDir ?? this.#rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.platform === "win32" ? `${path.dirname(process.execPath)};${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0` : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: workerSandbox ? path.join(workerSandbox.temporaryDir, "home") : os.homedir(),
        TMPDIR: workerSandbox ? path.join(workerSandbox.temporaryDir, "tmp") : os.tmpdir(),
        LANG: "en_US.UTF-8",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", WINDIR: process.env.WINDIR ?? "C:\\Windows", TEMP: workerSandbox ? path.join(workerSandbox.temporaryDir, "tmp") : os.tmpdir(), TMP: workerSandbox ? path.join(workerSandbox.temporaryDir, "tmp") : os.tmpdir(), ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" } : {}),
      },
    });

    this.#daemons.set(streamId, child);
    this.#streamScopes.set(streamId, { workspaceDir: workerSandbox?.workspaceDir, scratchDir: message.scratchDir ? canonicalExecutionPath(message.scratchDir) : undefined, projectId: message.projectId });
    if (workerSandbox) this.#workerSandboxes.set(streamId, workerSandbox);
    const streamBuffer = this.#streamResumeNegotiated ? new StreamResumeBuffer() : undefined;
    if (streamBuffer) this.#streamBuffers.set(streamId, streamBuffer);
    this.#sendControl(ws, { type: "env.stream_ready", streamId });

    child.stdout.on("data", (chunk: Buffer) => {
      const activeWs = this.#ws;
      if (streamBuffer) {
        const enqueued = streamBuffer.enqueueOutgoing(chunk, this.#unackedTotalBytes);
        if (!enqueued.ok) {
          this.#log(`[pi-env:${streamId}] Outgoing unacked buffer limit exceeded; stopping stream.`);
          void this.#stopStream(streamId, true).catch(() => {});
          return;
        }
        this.#unackedTotalBytes += enqueued.payload.byteLength;
        if (activeWs && this.#registered && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(encodeSequencedStreamChunk(streamId, enqueued.seq, enqueued.payload));
        }
      } else if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(encodeStreamChunk(streamId, chunk));
      }
    });

    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      const trimmed = text.trim();
      if (trimmed) this.#log(`[pi-env:${streamId}] ${trimmed}`);
    });

    const onExit = (code: number | null, err?: Error) => {
      if (!this.#daemons.has(streamId)) return;
      this.#daemons.delete(streamId);
      const ackTimer = this.#streamAckTimers.get(streamId);
      if (ackTimer) {
        clearTimeout(ackTimer);
        this.#streamAckTimers.delete(streamId);
      }
      const existingBuf = this.#streamBuffers.get(streamId);
      if (existingBuf) {
        this.#unackedTotalBytes = Math.max(0, this.#unackedTotalBytes - existingBuf.clear());
        this.#streamBuffers.delete(streamId);
      }
      const sandbox = this.#workerSandboxes.get(streamId);
      if (sandbox) {
        void sandbox.cleanup().then((pending) => { if (!pending) { this.#workerSandboxes.delete(streamId); this.#streamScopes.delete(streamId); } }).catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Worker cleanup failed"));
      } else this.#streamScopes.delete(streamId);
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        this.#sendControl(this.#ws, {
          type: "env.stream_closed",
          streamId,
          code,
          error: err?.message,
        });
      }
    };

    child.on("error", (err) => onExit(null, err));
    child.on("close", (code) => onExit(code));
  }

  async #handleExternalAgentRequest(ws: WebSocket, message: Extract<HubToEnvControlMessage, { type: "hub.external_agent_request" }>): Promise<void> {
    if (ws !== this.#ws || !this.#registered || this.#stopped || ws.readyState !== ws.OPEN) return;
    if (!/^[a-f0-9]{32}$/.test(message.requestId) || !isExternalAgentRequest(message.request)) return;
    try {
      const result = await this.#externalAgents.request(message.request);
      if (ws === this.#ws && this.#registered && !this.#stopped) this.#sendControl(ws, { type: "env.external_agent_result", requestId: message.requestId, result });
    } catch (error) {
      if (ws === this.#ws) this.#sendControl(ws, { type: "env.external_agent_result", requestId: message.requestId, error: error instanceof Error ? error.message.slice(0, 2000) : "External agent request failed" });
    }
  }

  async #requestExternalTool(scope: ExternalAgentMcpInvocation): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || !this.#registered || this.#stopped || ws.readyState !== ws.OPEN) throw new Error("Hub is offline; task tool request was not sent");
    if (this.#externalTools.size >= 32) throw new Error("External task tool request limit reached");
    const requestId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#externalTools.delete(requestId); reject(new Error("Hub task tool request timed out; inspect task state before retrying")); }, 45_000); timer.unref();
      this.#externalTools.set(requestId, { ws, scope, resolve, reject, timer });
      this.#sendControl(ws, { type: "env.external_agent_tool_request", requestId, ...scope });
    });
  }

  async #handleProjectRequest(ws: WebSocket, requestId: string, request: ProjectEnvRequest): Promise<void> {
    if (ws !== this.#ws || ws.readyState !== ws.OPEN) return;
    try {
      if (!request || typeof request !== "object") throw new Error("Invalid project control request");
      let result;
      if (request.action === "list") result = this.#projectDirectories.list(request.path);
      else if (request.action === "authorize") result = this.#projectDirectories.authorize(request);
      else if (request.action === "staged_prepare") result = this.#stagedWorkspaces.prepare(request);
      else if (request.action === "staged_diff") result = this.#stagedWorkspaces.diff(request.taskId, request.filePath);
      else if (request.action === "staged_apply") result = this.#stagedWorkspaces.apply(request);
      else if (request.action === "staged_discard") result = this.#stagedWorkspaces.discard(request.taskId, request.projectId);
      else if (request.action === "revoke" || request.action === "cleanup") {
        if (request.action === "revoke") {
          this.#projectDirectories.revoke(request.projectId);
          this.#stagedWorkspaces.discardProject(request.projectId);
        }
        const selected = [...this.#streamScopes].filter(([, scope]) => request.action === "revoke"
          ? scope.projectId === request.projectId
          : scope.workspaceDir === canonicalExecutionPath(request.workspaceDir) && (request.scratchDir === undefined || scope.scratchDir === canonicalExecutionPath(request.scratchDir)));
        const externalPending = request.action === "revoke" ? await this.#externalAgents.stopProject(request.projectId) : false;
        const pending = await Promise.all(selected.map(([id]) => this.#stopStream(id)));
        const recordedPending = await cleanupRecordedExecutions(path.join(this.#projectDirectories.privateDirectory, "executions"), request.action === "revoke" ? { projectId: request.projectId } : { workspaceDir: canonicalExecutionPath(request.workspaceDir), ...(request.scratchDir ? { scratchDir: canonicalExecutionPath(request.scratchDir) } : {}) });
        result = { cleanupPending: externalPending || pending.some(Boolean) || recordedPending };
      } else throw new Error("Unknown project control action");
      this.#sendControl(ws, { type: "env.project_result", requestId, result });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const errorCode =
        code === "project_directory_unavailable" || code === "staged_workspace_conflict" || code === "staged_workspace_oversized"
          ? code
          : undefined;
      this.#sendControl(ws, { type: "env.project_result", requestId, error: error instanceof Error ? error.message : "Project control request failed", ...(errorCode ? { errorCode } : {}) });
    }
  }

  async #handleBrowserRequest(ws: WebSocket, requestId: string, request: BrowserRequest): Promise<void> {
    if (ws !== this.#ws || !this.#registered || this.#stopped || ws.readyState !== ws.OPEN) return;
    try {
      const result = await this.#browser.request(request, () => ws === this.#ws && this.#registered && !this.#stopped && ws.readyState === ws.OPEN);
      this.#sendControl(ws, { type: "env.browser_result", requestId, result });
    } catch {
      this.#sendControl(ws, { type: "env.browser_result", requestId, error: "Flow browser operation failed; check the original job before retrying" });
    }
  }

  async #handleComputerRequest(ws: WebSocket, requestId: string, request: ComputerUseRequest): Promise<void> {
    if (ws !== this.#ws || !this.#registered || this.#stopped || ws.readyState !== ws.OPEN) return;
    if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId) || !isComputerUseRequest(request)) {
      if (typeof requestId === "string" && /^[a-f0-9]{32}$/.test(requestId)) this.#sendControl(ws, { type: "env.computer_result", requestId, error: "Invalid computer-use request" });
      return;
    }
    if (this.#computerRequests.has(requestId)) return;
    if (this.#computerRequests.size >= 32) {
      this.#sendControl(ws, { type: "env.computer_result", requestId, error: "Computer-use request limit reached" });
      return;
    }
    const controller = new AbortController();
    this.#computerRequests.set(requestId, { ws, controller });
    const active = () => ws === this.#ws && this.#registered && !this.#stopped && ws.readyState === ws.OPEN && !controller.signal.aborted;
    try {
      const result = await this.#computer.request(request, active, controller.signal);
      if (!active()) return;
      if (!isComputerUseResult(result, request)) throw new Error("Invalid computer-use result");
      this.#sendControl(ws, { type: "env.computer_result", requestId, result });
    } catch {
      if (active()) this.#sendControl(ws, { type: "env.computer_result", requestId, error: "Computer-use operation was not confirmed; observe the target before retrying" });
    } finally {
      if (this.#computerRequests.get(requestId)?.controller === controller) this.#computerRequests.delete(requestId);
    }
  }

  #cancelComputerRequests(ws?: WebSocket): void {
    for (const [id, preview] of this.#computerPreviews) {
      if (ws && preview.ws !== ws) continue;
      this.#computerPreviews.delete(id);
      if (preview.flushTimer) clearTimeout(preview.flushTimer);
      preview.stop();
    }
    for (const [id, pending] of this.#computerRequests) {
      if (ws && pending.ws !== ws) continue;
      pending.controller.abort();
      this.#computerRequests.delete(id);
    }
  }

  #subscribeComputerPreview(ws: WebSocket, subscriptionId: string, target: ComputerPreviewTarget): void {
    if (ws !== this.#ws || !this.#registered || this.#stopped || ws.readyState !== ws.OPEN
      || typeof subscriptionId !== "string" || !/^[a-f0-9]{32}$/.test(subscriptionId) || !isComputerPreviewTarget(target)) return;
    if (this.#computerPreviews.has(subscriptionId)) return;
    if (this.#computerPreviews.size >= 16) {
      this.#sendControl(ws, { type: "env.computer_preview", subscriptionId, update: { state: "unavailable", message: "预览数量已达上限" } });
      return;
    }
    const preview: { ws: WebSocket; stop: () => void; pending?: ComputerPreviewUpdate; flushTimer?: NodeJS.Timeout } = { ws, stop: () => {} };
    this.#computerPreviews.set(subscriptionId, preview);
    const active = () => this.#computerPreviews.get(subscriptionId) === preview && ws === this.#ws && this.#registered && !this.#stopped && ws.readyState === ws.OPEN;
    const flush = () => {
      preview.flushTimer = undefined;
      if (!active()) { preview.pending = undefined; return; }
      if (!preview.pending) return;
      if (ws.bufferedAmount > COMPUTER_PREVIEW_MAX_DATA) {
        preview.flushTimer = setTimeout(flush, 100);
        preview.flushTimer.unref();
        return;
      }
      const update = preview.pending;
      preview.pending = undefined;
      this.#sendControl(ws, { type: "env.computer_preview", subscriptionId, update });
    };
    try {
      preview.stop = this.#computer.subscribePreview(target, (update) => {
        if (!active() || !isComputerPreviewUpdate(update)) return;
        if (update.frame) {
          // Keep only the newest frame so a one-shot desktop capture survives congestion.
          preview.pending = update;
          if (!preview.flushTimer) flush();
          return;
        }
        preview.pending = undefined;
        if (preview.flushTimer) { clearTimeout(preview.flushTimer); preview.flushTimer = undefined; }
        this.#sendControl(ws, { type: "env.computer_preview", subscriptionId, update });
      });
    } catch {
      this.#computerPreviews.delete(subscriptionId);
      if (preview.flushTimer) clearTimeout(preview.flushTimer);
      this.#sendControl(ws, { type: "env.computer_preview", subscriptionId, update: { state: "unavailable", message: "无法订阅设备画面" } });
    }
  }

  #scheduleStreamAck(ws: WebSocket, streamId: number, buffer: StreamResumeBuffer, immediate: boolean): void {
    const flush = () => {
      const timer = this.#streamAckTimers.get(streamId);
      if (timer) {
        clearTimeout(timer);
        this.#streamAckTimers.delete(streamId);
      }
      if (!buffer.needsAck()) return;
      const activeWs = this.#ws ?? ws;
      if (activeWs.readyState === WebSocket.OPEN) {
        this.#sendControl(activeWs, { type: "env.stream_ack", streamId, rxSeq: buffer.rxSeq });
        buffer.markAckSent();
      }
    };
    if (immediate) {
      flush();
    } else if (!this.#streamAckTimers.has(streamId)) {
      const timer = setTimeout(flush, 400);
      timer.unref();
      this.#streamAckTimers.set(streamId, timer);
    }
  }

  #stopStream(streamId: number, notifyClosed = false): Promise<boolean> {
    const existing = this.#cleaningStreams.get(streamId);
    if (existing) return existing;
    const cleanup = (async () => {
      const ackTimer = this.#streamAckTimers.get(streamId);
      if (ackTimer) {
        clearTimeout(ackTimer);
        this.#streamAckTimers.delete(streamId);
      }
      const existingBuf = this.#streamBuffers.get(streamId);
      if (existingBuf) {
        this.#unackedTotalBytes = Math.max(0, this.#unackedTotalBytes - existingBuf.clear());
        this.#streamBuffers.delete(streamId);
      }
      const child = this.#daemons.get(streamId);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const sandbox = this.#workerSandboxes.get(streamId);
      const pending = sandbox ? await sandbox.cleanup() : false;
      if (child && child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2_500); timer.unref(); })]);
      }
      const childPending = Boolean(child && child.exitCode === null && child.signalCode === null);
      if (!pending && !childPending) {
        this.#daemons.delete(streamId);
        this.#workerSandboxes.delete(streamId);
        this.#streamScopes.delete(streamId);
        if (notifyClosed && this.#ws && this.#ws.readyState === WebSocket.OPEN) {
          this.#sendControl(this.#ws, { type: "env.stream_closed", streamId });
        }
      }
      return pending || childPending;
    })();
    this.#cleaningStreams.set(streamId, cleanup);
    void cleanup.finally(() => this.#cleaningStreams.delete(streamId)).catch((error: unknown) => this.#log(error instanceof Error ? error.message : "Worker cleanup failed"));
    return cleanup;
  }

  async #killAllDaemons(notifyClosed = false): Promise<void> {
    await Promise.all([...new Set([...this.#daemons.keys(), ...this.#workerSandboxes.keys()])].map((id) => this.#stopStream(id, notifyClosed)));
  }

  #sendControl(ws: WebSocket, msg: EnvToHubControlMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  #log(msg: string): void {
    this.#options.onLog?.(msg);
  }
}
