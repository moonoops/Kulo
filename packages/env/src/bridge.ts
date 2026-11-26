import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalExecutionPath, workerIsolationCapabilities, type WorkerExecutionOptions, type WorkerNetworkPolicy } from "./isolation.js";
import { EXTERNAL_AGENT_NODE_CAPABILITIES, ExternalAgentService, isExternalAgentRequest, isExternalAgentResponse, type ExternalAgentToolHandler } from "./external-agents.js";
import { ProjectDirectoryRegistry, type AuthorizeDirectoryInput } from "./project-directories.js";
import { StagedWorkspaceService } from "./staged-workspace-service.js";
import { cleanupRecordedExecutions } from "./worker-supervisor.js";
import { FlowBrowserService } from "./browser.js";
import { ComputerUseService, computerUseConfiguration } from "./computer-use.js";
import { HostActionService } from "./host-actions.js";
import { collectDeviceSystemInfo } from "./device-info.js";
import { MacOsNotificationSensor } from "./connectors/macos-notifications.js";
import { SparkMailConnector } from "./connectors/spark-mail.js";
import { StreamResumeBuffer } from "./stream-resume.js";
import { primeLoginShellPath } from "./trusted-execution.js";
import {
  createBridgeExecutionEnv,
  createBridgeWorkerExecutionEnv,
  invalidateAllWorkerConnections,
  pickBridgeDefaultWorkerEnvId,
  releaseBridgeWorkerEnv,
  retireIdleWorkerConnections,
  scopeHostActionForTarget,
  type BridgeExecutionContext,
  type WorkerConnectionEntry,
} from "./bridge-execution-env.js";
import { executeComputerUseWithCompat } from "./computer-use-compat.js";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  Connection,
  localDaemon,
  sshConnection,
  type SshTarget,
} from "@earendil-works/pi-env";
import type { WebSocket } from "ws";
import {
  STREAM_RESUME_CAPABILITY, STREAM_RESUME_GRACE_MS,
  CONNECTORS_CAPABILITY,
  CONNECTOR_MAX_BATCH_BYTES,
  EXTERNAL_AGENT_QUOTA_CAPABILITY, EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY,
  LEGACY_MIGRATION_EXECUTION_TRUST_MODE,
  TRUSTED_HOST_EXECUTION_CAPABILITY,
  hasTrustedHostExecutionCapability,
  type ExecutionTrustMode,
  isClusterSyncStatus,
  type ClusterHandoverDirective,
  type ClusterSyncAvailableNotification,
  type ClusterSyncStatus,
  type ClusterTopology,
  isConnectorCallRequest,
  isConnectorEventBatch,
  isConnectorSourceStatus,
  type ConnectorBatchAck,
  type ConnectorCallRequest,
  type ConnectorCallResult,
  type ConnectorEventBatch,
  type ConnectorSourceConfig,
  type ConnectorSourceStatus,
  decodeSequencedStreamChunk,
  decodeStreamChunk,
  encodeSequencedStreamChunk,
  encodeStreamChunk,
  type StreamResumeState,
  isDeviceSystemInfo,
  EXTERNAL_AGENT_KINDS,
  EXTERNAL_AGENT_MCP_TOOL_NAMES,
  type ExternalAgentMcpToolName,
  isComputerUseResult,
  isHostActionRequest,
  isHostActionResult,
  HOST_ACTION_MAX_RESULT,
  isComputerPreviewInputEvent,
  isComputerPreviewTarget,
  isComputerPreviewUpdate,
  COMPUTER_USE_MAX_RESULT,
  isAndroidRequest,
  isAndroidResult,
  isAndroidEnvStatus,
  isAndroidCancel,
  isAndroidControlResult,
  isAndroidNotificationClassification,
  isAndroidNotificationClassificationResult,
  type AndroidNotificationClassification,
  type AndroidNotificationClassificationResult,
  type AndroidRequest,
  type AndroidResult,
  type AndroidCancel,
  type AndroidControlResult,
  type ExternalAgentRequest,
  type ExternalAgentResponse,
  redactSensitiveText,
  type EnvNodeDescriptor,
  type EnvToHubControlMessage,
  type HubToEnvControlMessage,
  type ProjectDirectoryGrant,
  type ProjectDirectoryListing,
  type ProjectEnvRequest,
  type StagedWorkspaceApplyResult,
  type StagedWorkspaceDiffDetail,
  type StagedWorkspacePrepareResult,
  type BrowserRequest,
  type BrowserResult,
  type ComputerUseRequest,
  type ComputerUseResult,
  type HostActionRequest,
  type HostActionResult,
  type ComputerPreviewInputEvent,
  type ComputerPreviewTarget,
  type ComputerPreviewUpdate,
} from "@kulo/protocol";

const STDIO_RELAY_PATH = fileURLToPath(new URL("../bin/stdio-relay.mjs", import.meta.url));
export const BRIDGE_EXTERNAL_AGENT_TOOL_ALLOWLIST: readonly ExternalAgentMcpToolName[] = EXTERNAL_AGENT_MCP_TOOL_NAMES;
const BRIDGE_EXTERNAL_AGENT_TOOL_SET = new Set<string>(BRIDGE_EXTERNAL_AGENT_TOOL_ALLOWLIST);

function sameToken(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string" || !actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function checkedBrowserResult(raw: unknown, profileRef: string, jobId?: string): BrowserResult {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Flow browser response");
  const value = raw as BrowserResult;
  if (value.profileRef !== profileRef || jobId !== undefined && value.jobId !== jobId ||
      !["ready", "needs_login", "running", "completed", "needs_review", "stopped"].includes(value.status) ||
      value.message !== undefined && (typeof value.message !== "string" || value.message.length > 2000) ||
      value.remoteId !== undefined && (typeof value.remoteId !== "string" || value.remoteId.length > 200) ||
      value.submitted !== undefined && typeof value.submitted !== "boolean" ||
      value.data !== undefined && (typeof value.data !== "string" || value.data.length > 1_398_104 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) ||
      value.data !== undefined && (!Number.isSafeInteger(value.offset) || value.offset! < 0) ||
      value.file !== undefined && (typeof value.file.name !== "string" || value.file.name.length > 255 || /[\\/\x00-\x1f]/.test(value.file.name) || value.file.mimeType !== "video/mp4" || !Number.isSafeInteger(value.file.size) || value.file.size < 12 || value.file.size > 250 * 1024 * 1024)) throw new Error("Invalid Flow browser response");
  if (value.remoteUrl !== undefined) {
    const url = new URL(value.remoteUrl);
    if (url.protocol !== "https:" || !["flow.google.com", "labs.google"].includes(url.hostname) || url.username || url.password) throw new Error("Invalid Flow task URL");
  }
  return { status: value.status, profileRef, ...(jobId ? { jobId } : {}), ...(value.remoteId ? { remoteId: String(value.remoteId).slice(0, 200) } : {}),
    ...(value.submitted !== undefined ? { submitted: value.submitted } : {}),
    ...(value.remoteUrl ? { remoteUrl: value.remoteUrl } : {}), ...(value.message ? { message: value.message } : {}),
    ...(value.file ? { file: { name: value.file.name, mimeType: value.file.mimeType, size: value.file.size } } : {}),
    ...(value.data !== undefined ? { data: value.data, offset: value.offset } : {}),
    ...(Array.isArray(value.models) ? { models: value.models.filter((model) => typeof model === "string" && model.length <= 200).slice(0, 100) } : {}) };
}

interface ActiveStream {
  streamId: number;
  tcpSocket: net.Socket;
  ready: boolean;
  readyTimer: NodeJS.Timeout;
  workspaceDir?: string;
  scratchDir?: string;
  projectId?: string;
  executionKey?: string;
  resumeBuffer?: StreamResumeBuffer;
  ackTimer?: NodeJS.Timeout;
  pausedForDisconnect?: boolean;
}

interface RemoteWsPeer {
  descriptor: EnvNodeDescriptor;
  ws: WebSocket | null;
  connection: Connection | null;
  connectionsByMode: Map<ExecutionTrustMode, Connection>;
  streams: Map<number, ActiveStream>;
  nextStreamId: number;
  connectionLease?: string;
  connectionState: "online" | "reconnecting" | "offline";
  streamResumeSupported: boolean;
  graceTimer?: NodeJS.Timeout;
  missedPings: number;
  pendingCloseStreamIds: Set<number>;
  unackedTotalBytes: number;
}

interface PendingComputerRequest {
  envId: string;
  request: ComputerUseRequest;
  ws?: WebSocket;
  controller: AbortController;
  resolve: (result: ComputerUseResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
}

interface PendingHostActionRequest {
  envId: string;
  request: HostActionRequest;
  ws?: WebSocket;
  controller: AbortController;
  resolve: (result: HostActionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
}

interface PendingAndroidRequest {
  envId: string;
  ws: WebSocket;
  request: AndroidRequest;
  resolve: (result: AndroidResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
}

interface PendingAndroidControl {
  envId: string;
  ws: WebSocket;
  request: AndroidCancel;
  resolve: (result: AndroidControlResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SshPeer {
  descriptor: EnvNodeDescriptor;
  connection: Connection;
}

export interface EnvManagerOptions {
  /** Enable a built-in local execution environment on the Hub host itself. */
  enableLocal?: boolean;
  /** Stable identifier for the local execution environment (defaults to `"local"` for single-host compatibility). */
  localEnvId?: string;
  /** Root directory for the built-in local execution environment. */
  localRootDir?: string;
  /** Optional display name for the built-in local env. */
  localName?: string;
  projectGrantFile?: string;
  browserService?: FlowBrowserService;
  computerUseService?: ComputerUseService;
  /** @deprecated Management credentials are never accepted for Env registration. */
  authToken?: string;
  /** Credentials provisioned by the Hub administrator and bound to one Env ID. */
  envTokens?: Record<string, string>;
  /** Remote Envs whose isolation deployment was approved by the administrator. */
  workerEnvIds?: string[];
  workerNetwork?: WorkerNetworkPolicy;
  getProtectedPaths?: () => string[];
  /** Exact core runtime state files protected in both trusted and sandboxed modes. */
  getCoreProtectedPaths?: () => string[];
  /** Dynamic internal secret env var names (e.g. custom Hindsight API key env names) stripped from all subprocesses. */
  getBlockedEnvNames?: () => Iterable<string>;
  /** Optional initial execution trust mode (defaults to conservative sandboxed until hydrated). */
  initialExecutionTrustMode?: ExecutionTrustMode;
  /** Grace window in ms to keep stream-resume-v1 peers alive across brief disconnects (default: 20_000). */
  streamResumeGraceMs?: number;
  /** Interval in ms for Hub keepalive pings to remote WebSocket env nodes (default: 15_000). */
  pingIntervalMs?: number;
  /** Consecutive unanswered ping intervals before terminating a silent remote WebSocket (default: 3; 0 disables). */
  maxMissedPings?: number;
  /** Stable Hub identifier used to scope connector cursors on paired Envs. */
  hubId?: string;
  /** Optional override for local macOS notification database path (primarily for tests). */
  localNotificationsDbPath?: string;
  /** Callback fired whenever the list or status of environments changes. */
  onChange?: (envs: EnvNodeDescriptor[]) => void;
}

/**
 * Manages both local and remote `Pi Env` execution environments for Kulo Hub.
 * Remote `kulo env` nodes connect outbound via WebSocket and speak the native
 * Rust `pi-env` framed binary protocol over multiplexed streams.
 */
export class EnvManager {
  readonly #options: EnvManagerOptions;
  readonly #computerConfiguration: ReturnType<typeof computerUseConfiguration> | undefined;
  readonly #bridgeSecret = randomBytes(24).toString("hex");
  readonly #hubInstanceId = randomBytes(16).toString("hex");
  readonly #streamResumeGraceMs: number;
  #bridgeServer: net.Server | null = null;
  #bridgePort = 0;

  #localConnection: Connection | null = null;
  #localDescriptor: EnvNodeDescriptor | null = null;
  #localEnvId: string;
  #clusterHandlers?: {
    getRegistrationPayload?: (envId: string) => { cluster?: ClusterTopology; standby?: { enabled: boolean; syncToken: string } } | undefined;
    onSyncStatus?: (envId: string, status: ClusterSyncStatus) => void;
    onPeerRegistered?: (envId: string, descriptor: EnvNodeDescriptor) => void;
  };

  readonly #wsPeers = new Map<string, RemoteWsPeer>();
  readonly #sshPeers = new Map<string, SshPeer>();
  readonly #workerConnections = new Map<string, WorkerConnectionEntry>();
  readonly #retiredWorkerConnections = new Set<WorkerConnectionEntry>();
  #localProjects: ProjectDirectoryRegistry | null = null;
  #localStagedWorkspaces: StagedWorkspaceService | null = null;
  #localExternalAgents: ExternalAgentService | null = null;
  #externalAgentToolHandler?: ExternalAgentToolHandler;
  readonly #externalAgentRequests = new Map<string, { envId: string; ws: WebSocket; request: ExternalAgentRequest; resolve: (result: ExternalAgentResponse) => void; reject: (error: Error) => void; finish: () => void }>();
  readonly #externalToolRequests = new Map<WebSocket, Set<string>>();
  #localBrowser: FlowBrowserService | null = null;
  #localComputer: ComputerUseService | null = null;
  #localHostActions: HostActionService | null = null;
  readonly #computerRequests = new Map<string, PendingComputerRequest>();
  readonly #hostActionRequests = new Map<string, PendingHostActionRequest>();
  readonly #computerPreviews = new Map<string, { envId: string; ws?: WebSocket; lease?: string; listener: (update: ComputerPreviewUpdate) => void; stop?: () => void }>();
  readonly #androidRequests = new Map<string, PendingAndroidRequest>();
  readonly #androidControls = new Map<string, PendingAndroidControl>();
  #notificationClassifier?: (request: AndroidNotificationClassification, signal: AbortSignal) => Promise<AndroidNotificationClassificationResult>;
  readonly #notificationControllers = new Map<WebSocket, Map<string, { bindingId: string; controller: AbortController }>>();
  #hubId: string;
  #localNotificationSensor: MacOsNotificationSensor | null = null;
  readonly #localSparkConnector = new SparkMailConnector();
  readonly #connectorCalls = new Map<string, { envId: string; ws: WebSocket; resolve: (result: ConnectorCallResult) => void; timer: NodeJS.Timeout }>();
  #connectorConfig: ConnectorSourceConfig = { driverId: "macos-notifications", enabled: false, mutedApps: [] };
  readonly #connectorStatuses = new Map<string, ConnectorSourceStatus>();
  #connectorHandlers?: {
    onStatus?: (envId: string, status: ConnectorSourceStatus) => void;
    onEvents?: (envId: string, batch: ConnectorEventBatch) => Promise<ConnectorBatchAck> | ConnectorBatchAck;
  };
  readonly #browserRequests = new Map<string, { envId: string; profileRef: string; jobId?: string; resolve: (result: BrowserResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #projectRequests = new Map<string, { envId: string; resolve: (value: NonNullable<Extract<EnvToHubControlMessage, {type:"env.project_result"}>["result"]>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #pendingRevocations = new Map<string, Set<string>>();
  readonly #revokedProjects = new Set<string>();
  readonly #cleanupTasks = new Set<Promise<boolean>>();
  readonly #additionalProtectedPaths = new Set<string>();
  readonly #deviceTokens = new Map<string, string>();
  readonly #deviceConnectionLeases = new Map<string, string>();
  readonly #deviceDisplayNames = new Map<string, string>();
  readonly #revokedDeviceIds = new Set<string>();
  #remoteConnectionsEnabled = true;
  #executionTrustMode: ExecutionTrustMode;
  #executionTrustModeRevision = 1;
  #trustModeHydrated = false;
  #pingTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: EnvManagerOptions = {}) {
    const tokens = Object.values(options.envTokens ?? {});
    if (tokens.some((token) => typeof token !== "string" || !token.trim()) || new Set(tokens).size !== tokens.length) {
      throw new Error("Each Env identity requires a non-empty, unique node credential");
    }
    this.#options = options;
    this.#executionTrustMode = options.initialExecutionTrustMode ?? LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
    this.#trustModeHydrated = options.initialExecutionTrustMode !== undefined;
    const initialLocalId = options.localEnvId?.trim();
    this.#localEnvId = initialLocalId && /^[a-zA-Z0-9_-]{1,100}$/.test(initialLocalId) ? initialLocalId : "local";
    this.#hubId = options.hubId?.trim() || "kulo-hub";
    this.#streamResumeGraceMs = options.streamResumeGraceMs ?? STREAM_RESUME_GRACE_MS;
    this.#computerConfiguration = options.computerUseService ? undefined : computerUseConfiguration();
  }

  getExecutionTrustMode(): ExecutionTrustMode {
    return this.#executionTrustMode;
  }

  getExecutionTrustModeRevision(): number {
    return this.#executionTrustModeRevision;
  }

  isTrustModeHydrated(): boolean {
    return this.#trustModeHydrated;
  }

  setExecutionTrustMode(mode: ExecutionTrustMode, revision?: number): void {
    const changed = this.#executionTrustMode !== mode;
    this.#executionTrustMode = mode;
    if (revision !== undefined && Number.isSafeInteger(revision) && revision >= 1) {
      this.#executionTrustModeRevision = revision;
    } else if (changed) {
      this.#executionTrustModeRevision += 1;
    }
    this.#trustModeHydrated = true;
    if (changed) {
      retireIdleWorkerConnections(this.#workerConnections, this.#retiredWorkerConnections, this.#cleanupTasks);
    }
    for (const peer of this.#wsPeers.values()) {
      if (
        peer.connectionState === "online" &&
        peer.ws &&
        peer.descriptor.executionKind === "pi-env" &&
        hasTrustedHostExecutionCapability(peer.descriptor.capabilities)
      ) {
        this.#sendControl(peer.ws, {
          type: "hub.execution_trust_mode",
          mode: this.#executionTrustMode,
          revision: this.#executionTrustModeRevision,
        });
      }
    }
    if (changed) this.#notifyChange();
  }

  retireIdleWorkerEnvironments(): void {
    retireIdleWorkerConnections(this.#workerConnections, this.#retiredWorkerConnections, this.#cleanupTasks);
  }

  get localEnvId(): string {
    return this.#localEnvId;
  }

  isLocalEnv(envId: string): boolean {
    return envId === this.#localEnvId;
  }

  /** Promote the local environment ID in place (e.g., when upgrading from standalone `"local"` to a cluster `nodeId`). */
  setLocalEnvId(nextId: string): void {
    const clean = nextId.trim();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(clean) || clean === this.#localEnvId) return;
    const previous = this.#localEnvId;
    this.#localEnvId = clean;
    if (this.#localDescriptor) {
      this.#localDescriptor = { ...this.#localDescriptor, id: clean };
    }
    const previousName = this.#deviceDisplayNames.get(previous);
    if (previousName !== undefined) {
      this.#deviceDisplayNames.delete(previous);
      if (!this.#deviceDisplayNames.has(clean)) this.#deviceDisplayNames.set(clean, previousName);
    }
    const previousSensorStatus = this.#connectorStatuses.get(`${previous}:macos-notifications`);
    if (previousSensorStatus) {
      this.#connectorStatuses.delete(`${previous}:macos-notifications`);
      this.#connectorStatuses.set(`${clean}:macos-notifications`, previousSensorStatus);
    }
    for (const entry of this.#workerConnections.values()) {
      if (entry.envId === previous) entry.envId = clean;
    }
    this.#notifyChange();
  }

  setClusterHandlers(handlers?: {
    getRegistrationPayload?: (envId: string) => { cluster?: ClusterTopology; standby?: { enabled: boolean; syncToken: string } } | undefined;
    onSyncStatus?: (envId: string, status: ClusterSyncStatus) => void;
    onPeerRegistered?: (envId: string, descriptor: EnvNodeDescriptor) => void;
  }): void {
    this.#clusterHandlers = handlers;
  }

  broadcastClusterTopology(topology: ClusterTopology): void {
    for (const peer of this.#wsPeers.values()) {
      if (peer.connectionState === "online" && peer.ws && peer.ws.readyState === peer.ws.OPEN && peer.descriptor.executionKind === "pi-env") {
        const standby = this.#clusterHandlers?.getRegistrationPayload?.(peer.descriptor.id)?.standby;
        this.#sendControl(peer.ws, {
          type: "hub.cluster_topology",
          topology,
          ...(standby ? { standby } : {}),
        });
      }
    }
  }

  notifySyncAvailable(envId: string, notice: ClusterSyncAvailableNotification): boolean {
    const peer = this.#wsPeers.get(envId);
    if (!peer || peer.connectionState !== "online" || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) return false;
    this.#sendControl(peer.ws, { type: "hub.sync_available", notice });
    return true;
  }

  sendStandbyWipe(envId: string, reason: string): boolean {
    const peer = this.#wsPeers.get(envId);
    if (!peer || peer.connectionState !== "online" || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) return false;
    this.#sendControl(peer.ws, { type: "hub.standby_wipe", reason });
    return true;
  }

  broadcastClusterHandover(directive: ClusterHandoverDirective): void {
    for (const peer of this.#wsPeers.values()) {
      if (peer.connectionState === "online" && peer.ws && peer.ws.readyState === peer.ws.OPEN && peer.descriptor.executionKind === "pi-env") {
        this.#sendControl(peer.ws, { type: "hub.cluster_handover", directive });
      }
    }
  }

  get hubInstanceId(): string {
    return this.#hubInstanceId;
  }

  setHubId(hubId: string): void {
    const normalized = hubId.trim();
    if (!normalized) return;
    this.#hubId = normalized;
    this.#localNotificationSensor?.setHubIdentity(normalized);
  }

  setConnectorHandlers(handlers?: {
    onStatus?: (envId: string, status: ConnectorSourceStatus) => void;
    onEvents?: (envId: string, batch: ConnectorEventBatch) => Promise<ConnectorBatchAck> | ConnectorBatchAck;
  }): void {
    this.#connectorHandlers = handlers;
  }

  setConnectorConfig(config: ConnectorSourceConfig): void {
    this.#connectorConfig = {
      driverId: config.driverId,
      enabled: Boolean(config.enabled),
      mutedApps: [...new Set(config.mutedApps.map((item) => item.trim()).filter(Boolean))].slice(0, 256),
    };
    this.#localNotificationSensor?.configure(this.#connectorConfig);
    for (const peer of this.#wsPeers.values()) {
      if (
        peer.connectionState === "online" &&
        peer.ws &&
        peer.descriptor.executionKind === "pi-env" &&
        peer.descriptor.capabilities.includes(CONNECTORS_CAPABILITY)
      ) {
        this.#sendControl(peer.ws, { type: "hub.connector_config", config: this.#connectorConfig });
      }
    }
  }

  getConnectorStatuses(): ConnectorSourceStatus[] {
    const result: ConnectorSourceStatus[] = [];
    if (this.#localNotificationSensor) {
      result.push(this.#localNotificationSensor.status);
    }
    for (const [envId, peer] of this.#wsPeers) {
      if (peer.connectionState !== "online") continue;
      const status = this.#connectorStatuses.get(`${envId}:macos-notifications`);
      if (status) result.push(status);
    }
    return result;
  }

  async callConnector(envId: string, request: ConnectorCallRequest, timeoutMs = 20_000): Promise<ConnectorCallResult> {
    if (!isConnectorCallRequest(request)) {
      return { ok: false, code: "invalid_request", error: "连接器请求格式无效" };
    }
    if (this.isLocalEnv(envId)) {
      if (!this.#localDescriptor) {
        return { ok: false, code: "env_unavailable", error: "本机执行环境未启用" };
      }
      return this.#localSparkConnector.invoke(request);
    }
    const peer = this.#wsPeers.get(envId);
    if (!peer || peer.connectionState !== "online" || !peer.ws || peer.descriptor.executionKind !== "pi-env") {
      return { ok: false, code: "env_offline", error: `设备 ${envId} 当前不在线` };
    }
    if (!peer.descriptor.capabilities.includes(CONNECTORS_CAPABILITY)) {
      return { ok: false, code: "connectors_unsupported", error: `设备 ${peer.descriptor.name} 需要更新至新版 Kulo` };
    }
    const ws = peer.ws;
    const requestId = `cc-${randomBytes(8).toString("hex")}`;
    return new Promise<ConnectorCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#connectorCalls.delete(requestId);
        resolve({ ok: false, code: "timeout", error: "连接器调用超时" });
      }, timeoutMs);
      timer.unref();
      this.#connectorCalls.set(requestId, { envId, ws, resolve, timer });
      try {
        this.#sendControl(ws, { type: "hub.connector_call", requestId, request });
      } catch {
        clearTimeout(timer);
        this.#connectorCalls.delete(requestId);
        resolve({ ok: false, code: "send_failed", error: "发送连接器调用失败" });
      }
    });
  }

  async #dispatchConnectorBatch(envId: string, batch: ConnectorEventBatch): Promise<ConnectorBatchAck> {
    if (!this.#connectorHandlers?.onEvents) {
      return {
        batchId: batch.batchId,
        driverId: batch.driverId,
        streamId: batch.streamId,
        sourceEpoch: batch.sourceEpoch,
        cursorAfter: batch.cursorAfter,
        status: "rejected",
        code: "assistant_unavailable",
      };
    }
    try {
      return await this.#connectorHandlers.onEvents(envId, batch);
    } catch {
      return {
        batchId: batch.batchId,
        driverId: batch.driverId,
        streamId: batch.streamId,
        sourceEpoch: batch.sourceEpoch,
        status: "rejected",
        code: "ingest_failed",
      };
    }
  }

  getConnectionState(envId: string): "online" | "reconnecting" | "offline" {
    if (this.isLocalEnv(envId)) return this.#localDescriptor?.online ? "online" : "offline";
    const peer = this.#wsPeers.get(envId);
    if (peer) return peer.connectionState;
    if (this.#sshPeers.has(envId)) return "online";
    return "offline";
  }

  async start(): Promise<void> {
    if (this.#bridgeServer) return;

    // 1. Start internal loopback TCP bridge for pi-env `Connection` stdio-relay processes
    const server = net.createServer((socket) => this.#handleRelaySocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to bind internal EnvManager loopback bridge");
    }
    this.#bridgeServer = server;
    this.#bridgePort = addr.port;

    // 2. Optionally initialize built-in local Pi Env daemon
    if (this.#options.enableLocal !== false) {
      void primeLoginShellPath();
      const rootDir = path.resolve(this.#options.localRootDir ?? process.cwd());
      const localId = this.#localEnvId;
      const getCoreProtected = () => [
        ...(this.#options.getCoreProtectedPaths?.() ?? []),
        ...this.#additionalProtectedPaths,
      ];
      this.#localProjects = new ProjectDirectoryRegistry({
        deviceId: localId,
        filePath: this.#options.projectGrantFile ?? path.join(rootDir, ".kulo-env", "project-grants.json"),
        scratchRoot: path.join(rootDir, "scratch"),
        getProtectedPaths: () => [...(this.#options.getProtectedPaths?.() ?? []), ...this.#additionalProtectedPaths],
        getCoreProtectedPaths: getCoreProtected,
        getExecutionTrustMode: () => this.#executionTrustMode,
      });
      this.#localStagedWorkspaces = new StagedWorkspaceService({ projectRegistry: this.#localProjects });
      this.#localBrowser = this.#options.browserService ?? new FlowBrowserService({ rootDir: path.join(this.#localProjects.privateDirectory, "browser") });
      this.#additionalProtectedPaths.add(this.#localBrowser.rootDir);
      this.#localComputer = this.#options.computerUseService ?? new ComputerUseService({ rootDir: path.join(this.#localProjects.privateDirectory, "computer-use"), getExecutionTrustMode: () => this.#executionTrustMode, ...this.#computerConfiguration });
      this.#additionalProtectedPaths.add(this.#localComputer.rootDir);
      this.#localHostActions = new HostActionService({
        controlRoot: path.join(this.#localProjects.privateDirectory, "executions"),
        getProtectedPaths: () => [
          ...(this.#options.getProtectedPaths?.() ?? []),
          ...this.#additionalProtectedPaths,
          this.#localProjects!.privateDirectory,
        ],
        getCoreProtectedPaths: () => [...getCoreProtected(), this.#localProjects!.privateDirectory],
        getExecutionTrustMode: () => this.#executionTrustMode,
        getBlockedEnvNames: () => this.#options.getBlockedEnvNames?.() ?? [],
      });
      this.#localExternalAgents = new ExternalAgentService({ envId: localId, rootDir, projectRegistry: this.#localProjects, getExecutionTrustMode: () => this.#executionTrustMode, getBlockedEnvNames: () => this.#options.getBlockedEnvNames?.() ?? [], toolHandler: this.#externalAgentToolHandler });
      await this.#localExternalAgents.recover();
      await cleanupRecordedExecutions(path.join(this.#localProjects.privateDirectory, "executions"));
      this.#localConnection = new Connection({
        command: [localDaemon()],
      });
      const now = Date.now();
      this.#localDescriptor = {
        id: localId,
        name: this.#options.localName ?? (os.hostname() || "Local"),
        kind: "local",
        online: true,
        platform: process.platform,
        arch: process.arch,
        rootDir,
        executionKind: "pi-env",
        capabilities: [...(process.platform === "darwin" ? ["fs", "bash", "macos-local", CONNECTORS_CAPABILITY] : ["fs", "bash"]), TRUSTED_HOST_EXECUTION_CAPABILITY, ...EXTERNAL_AGENT_NODE_CAPABILITIES, "host-actions", ...workerIsolationCapabilities(), ...(this.#localBrowser.available ? ["flow-browser"] : []), ...this.#localComputer.capabilities()],
        connectedAt: now,
        lastSeenAt: now,
        info: collectDeviceSystemInfo(),
      };
      if (process.platform === "darwin") {
        const localSensor = new MacOsNotificationSensor({
          envId: localId,
          envName: this.#localDescriptor.name,
          privateDir: this.#localProjects.privateDirectory,
          ...(this.#options.localNotificationsDbPath ? { databasePath: this.#options.localNotificationsDbPath } : {}),
          onStatus: (status) => {
            this.#connectorStatuses.set(`${this.#localEnvId}:${status.driverId}`, status);
            this.#connectorHandlers?.onStatus?.(this.#localEnvId, status);
          },
          onBatch: (batch) => {
            void this.#dispatchConnectorBatch(this.#localEnvId, batch).then((ack) => {
              localSensor.handleAck(ack);
            });
          },
        });
        localSensor.setHubIdentity(this.#hubId);
        this.#localNotificationSensor = localSensor;
        this.#connectorStatuses.set(`${this.#localEnvId}:macos-notifications`, localSensor.status);
        if (this.#connectorConfig.enabled) {
          localSensor.configure(this.#connectorConfig);
        }
      }
    }

    // 3. Keepalive ping loop for remote WebSocket env nodes
    const pingIntervalMs = this.#options.pingIntervalMs ?? 15_000;
    const maxMissedPings = this.#options.maxMissedPings ?? 3;
    this.#pingTimer = setInterval(() => {
      const now = Date.now();
      for (const peer of this.#wsPeers.values()) {
        if (!peer.ws || peer.ws.readyState !== peer.ws.OPEN) continue;
        if (maxMissedPings > 0 && peer.missedPings >= maxMissedPings) {
          peer.ws.terminate();
          continue;
        }
        peer.missedPings += 1;
        this.#sendControl(peer.ws, { type: "hub.ping", ts: now });
      }
    }, pingIntervalMs);
    this.#pingTimer.unref();
  }

  /** Register an optional SSH-backed Pi Env node (`@earendil-works/pi-env` native SSH). */
  registerSshEnv(config: {
    id: string;
    name: string;
    rootDir: string;
    target: SshTarget;
    platform?: string;
    arch?: string;
  }): void {
    const ssh = sshConnection(config.target);
    const now = Date.now();
    this.#sshPeers.set(config.id, {
      connection: ssh.connection,
      descriptor: {
        id: config.id,
        name: config.name,
        kind: "ssh",
        online: true,
        platform: config.platform ?? "linux",
        arch: config.arch ?? "x64",
        rootDir: config.rootDir,
        executionKind: "pi-env",
        capabilities: ["fs", "bash", "ssh"],
        connectedAt: now,
        lastSeenAt: now,
      },
    });
    this.#notifyChange();
  }

  /** Attach an incoming `/ws/env` WebSocket connection from a `KuloEnvAgent`. */
  handleEnvWebSocket(ws: WebSocket): void {
    let boundEnvId: string | null = null;
    let boundLease: string | undefined;

    const touchPeerActivity = () => {
      if (this.#closed || !boundEnvId) return;
      const currentLease = this.#deviceConnectionLeases.get(boundEnvId);
      if (currentLease !== undefined && !sameToken(boundLease, currentLease)) {
        ws.close(4009, "Stale connection lease");
        return;
      }
      const peer = this.#wsPeers.get(boundEnvId);
      if (!peer || peer.ws !== ws) return;
      peer.missedPings = 0;
      peer.descriptor.lastSeenAt = Date.now();
    };
    ws.on("ping", touchPeerActivity);
    ws.on("pong", touchPeerActivity);

    ws.on("message", (data, isBinary) => {
      if (this.#closed) {
        ws.close(1001, "Hub shutting down");
        return;
      }
      if (boundEnvId) {
        const currentLease = this.#deviceConnectionLeases.get(boundEnvId);
        if (currentLease !== undefined && !sameToken(boundLease, currentLease)) {
          ws.close(4009, "Stale connection lease");
          return;
        }
        // A replaced socket must not reclaim the identity before its close handshake ends.
        if (this.#wsPeers.get(boundEnvId)?.ws !== ws) return;
      }
      if (isBinary) {
        if (!boundEnvId) return;
        const peer = this.#wsPeers.get(boundEnvId);
        if (!peer || peer.ws !== ws) return;
        peer.missedPings = 0;
        peer.descriptor.lastSeenAt = Date.now();
        try {
          const buf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (peer.streamResumeSupported) {
            const { streamId, seq, payload } = decodeSequencedStreamChunk(buf);
            const stream = peer.streams.get(streamId);
            if (stream && stream.ready && stream.resumeBuffer && !stream.tcpSocket.destroyed) {
              const accepted = stream.resumeBuffer.acceptIncoming(seq, payload);
              if (accepted.status === "deliver") {
                stream.tcpSocket.write(accepted.payload);
                this.#scheduleStreamAck(peer, stream, accepted.shouldAckNow);
              } else if (accepted.status === "gap") {
                this.#abortSingleStream(peer, streamId, "Stream sequence gap detected");
              }
            }
          } else {
            const { streamId, payload } = decodeStreamChunk(buf);
            const stream = peer.streams.get(streamId);
            if (stream && stream.ready && !stream.tcpSocket.destroyed) {
              stream.tcpSocket.write(payload);
            }
          }
        } catch {
          // Ignore malformed frame
        }
        return;
      }

      let msg: EnvToHubControlMessage;
      const frameBytes = Buffer.byteLength(data.toString("utf8"));
      if (boundEnvId && this.#wsPeers.get(boundEnvId)?.descriptor.executionKind === "native-device" &&
          frameBytes > 1024 * 1024 + 4096) {
        ws.close(4002, "Android control frame too large");
        return;
      }
      if (boundEnvId && frameBytes > CONNECTOR_MAX_BATCH_BYTES + 16_384) {
        const rawText = data.toString("utf8");
        if (rawText.includes('"env.connector_events"')) {
          const batchIdMatch = /"batchId"\s*:\s*"([^"]{1,160})"/.exec(rawText);
          const streamIdMatch = /"streamId"\s*:\s*"([^"]{1,256})"/.exec(rawText);
          const epochMatch = /"sourceEpoch"\s*:\s*"([^"]{1,160})"/.exec(rawText);
          if (batchIdMatch?.[1] && streamIdMatch?.[1] && epochMatch?.[1]) {
            this.#sendControl(ws, {
              type: "hub.connector_ack",
              ack: {
                batchId: batchIdMatch[1],
                driverId: "macos-notifications",
                streamId: streamIdMatch[1],
                sourceEpoch: epochMatch[1],
                status: "rejected",
                code: "batch_too_large",
              },
            });
          }
          return;
        }
      }
      try {
        msg = JSON.parse(data.toString("utf8")) as EnvToHubControlMessage;
      } catch {
        ws.close(1003, "Invalid JSON control frame");
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        ws.close(4002, "Invalid control frame");
        return;
      }

      if (msg.type === "env.register") {
        if (!this.#remoteConnectionsEnabled) {
          ws.close(4003, "Device interconnection disabled");
          return;
        }
        const envId = typeof msg.envId === "string" ? msg.envId.trim() : "";
        if (!envId || envId === "local" || this.isLocalEnv(envId)) {
          ws.close(4002, "Invalid or reserved envId");
          return;
        }
        if (boundEnvId && boundEnvId !== envId) {
          ws.close(4002, "Env identity cannot change on a live connection");
          return;
        }
        const expectedToken = this.#remoteConnectionsEnabled && !this.#revokedDeviceIds.has(envId) ? this.#deviceTokens.get(envId) ?? this.#options.envTokens?.[envId] : undefined;
        if (!sameToken(msg.token, expectedToken) || sameToken(msg.token, this.#options.authToken)) {
          ws.close(4001, "Unauthorized Env identity");
          return;
        }
        const expectedLease = this.#deviceConnectionLeases.get(envId);
        if (expectedLease !== undefined && !sameToken(msg.connectionLease, expectedLease)) {
          ws.close(4009, "Stale connection lease");
          return;
        }
        if (typeof msg.name !== "string" || msg.name.length > 100 || typeof msg.rootDir !== "string" || msg.rootDir.length > 4096 ||
            typeof msg.platform !== "string" || typeof msg.arch !== "string" || !Array.isArray(msg.capabilities) || msg.capabilities.length > 100 ||
            msg.capabilities.some((capability) => typeof capability !== "string" || capability.length > 100) ||
            (msg.executionKind !== undefined && msg.executionKind !== "pi-env" && msg.executionKind !== "native-device") ||
            (msg.connectionLease !== undefined && (typeof msg.connectionLease !== "string" || !msg.connectionLease || msg.connectionLease.length > 256 || /\s/.test(msg.connectionLease))) ||
            (msg.hubInstanceId !== undefined && (typeof msg.hubInstanceId !== "string" || msg.hubInstanceId.length > 128)) ||
            (msg.listenPort !== undefined && (!Number.isInteger(msg.listenPort) || msg.listenPort < 1 || msg.listenPort > 65535)) ||
            (msg.clusterEpoch !== undefined && (!Number.isSafeInteger(msg.clusterEpoch) || msg.clusterEpoch < 1)) ||
            (msg.standbyPublicKey !== undefined && (typeof msg.standbyPublicKey !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(msg.standbyPublicKey))) ||
            (msg.identityPublicKey !== undefined && (typeof msg.identityPublicKey !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(msg.identityPublicKey))) ||
            (msg.activeStreams !== undefined && (!Array.isArray(msg.activeStreams) || msg.activeStreams.length > 256 ||
              msg.activeStreams.some((s) => !s || typeof s !== "object" || !Number.isSafeInteger(s.streamId) || s.streamId < 1 || !Number.isSafeInteger(s.rxSeq) || s.rxSeq < 0))) ||
            (msg.info !== undefined && !isDeviceSystemInfo(msg.info))) {
          ws.close(4002, "Invalid device metadata");
          return;
        }
        const executionKind = msg.executionKind ?? "pi-env";
        if (executionKind === "native-device" && msg.capabilities.some((capability) => capability !== "android-device")) {
          ws.close(4002, "Unsupported native device capability");
          return;
        }
        const capabilities = executionKind === "native-device" || msg.capabilities.length ? msg.capabilities : ["fs", "bash"];
        const supportsResume = executionKind === "pi-env" && capabilities.includes(STREAM_RESUME_CAPABILITY);
        const connectorsSupported = executionKind === "pi-env" && capabilities.includes(CONNECTORS_CAPABILITY);
        const reportedActiveStreams: StreamResumeState[] = msg.activeStreams ?? [];

        boundEnvId = envId;
        boundLease = msg.connectionLease;
        const now = Date.now();
        let peer = this.#wsPeers.get(envId);

        const canResumeExisting = Boolean(
          peer &&
          peer.connectionState === "reconnecting" &&
          supportsResume &&
          peer.streamResumeSupported &&
          msg.hubInstanceId === this.#hubInstanceId &&
          executionKind === (peer.descriptor.executionKind ?? "pi-env"),
        );

        let resumedStreams: StreamResumeState[] | undefined;
        let closeStreams: number[] = [];

        if (peer && canResumeExisting) {
          if (peer.graceTimer) {
            clearTimeout(peer.graceTimer);
            peer.graceTimer = undefined;
          }
          peer.ws = ws;
          peer.connectionState = "online";
          peer.missedPings = 0;
          peer.connectionLease = msg.connectionLease;
          peer.descriptor = {
            id: envId,
            name: msg.name || envId,
            kind: "reverse-ws",
            online: true,
            platform: msg.platform,
            arch: msg.arch,
            rootDir: msg.rootDir,
            executionKind,
            capabilities,
            connectedAt: peer.descriptor.connectedAt,
            lastSeenAt: now,
            ...(msg.info ? { info: msg.info } : {}),
            ...(msg.listenPort !== undefined ? { listenPort: msg.listenPort } : {}),
            ...(msg.standbyPublicKey ? { standbyPublicKey: msg.standbyPublicKey } : {}),
            ...(msg.identityPublicKey ? { identityPublicKey: msg.identityPublicKey } : {}),
            ...(msg.clusterEpoch !== undefined ? { clusterEpoch: msg.clusterEpoch } : {}),
          };

          const envStreamMap = new Map(reportedActiveStreams.map((s) => [s.streamId, s.rxSeq]));
          resumedStreams = [];
          const closeSet = new Set<number>(peer.pendingCloseStreamIds);

          for (const [streamId] of envStreamMap) {
            const hubStream = peer.streams.get(streamId);
            if (hubStream && hubStream.ready && hubStream.resumeBuffer && !hubStream.tcpSocket.destroyed && !peer.pendingCloseStreamIds.has(streamId)) {
              resumedStreams.push({ streamId, rxSeq: hubStream.resumeBuffer.rxSeq });
            } else {
              closeSet.add(streamId);
            }
          }
          for (const [streamId, hubStream] of [...peer.streams]) {
            if (!envStreamMap.has(streamId)) {
              clearTimeout(hubStream.readyTimer);
              if (hubStream.ackTimer) clearTimeout(hubStream.ackTimer);
              if (hubStream.resumeBuffer) {
                peer.unackedTotalBytes = Math.max(0, peer.unackedTotalBytes - hubStream.resumeBuffer.clear());
              }
              peer.streams.delete(streamId);
              if (!hubStream.ready) hubStream.tcpSocket.end("ERR:Remote daemon exited during disconnect\n");
              else hubStream.tcpSocket.destroy();
            }
          }
          closeStreams = [...closeSet];

          const clusterPayload = executionKind === "pi-env" ? this.#clusterHandlers?.getRegistrationPayload?.(envId) : undefined;
          const supportsTrusted = executionKind === "pi-env" && hasTrustedHostExecutionCapability(capabilities);
          this.#sendControl(ws, {
            type: "hub.registered",
            envId,
            ...(connectorsSupported ? { hubId: this.#hubId, connectorsSupported: true } : {}),
            hubInstanceId: this.#hubInstanceId,
            streamResumeSupported: true,
            resumedStreams,
            ...(closeStreams.length ? { closeStreams } : {}),
            ...(clusterPayload?.cluster ? { cluster: clusterPayload.cluster } : {}),
            ...(clusterPayload?.standby ? { standby: clusterPayload.standby } : {}),
            ...(supportsTrusted
              ? { executionTrustMode: this.#executionTrustMode, executionTrustModeRevision: this.#executionTrustModeRevision }
              : {}),
          });
          if (connectorsSupported) {
            this.#sendControl(ws, { type: "hub.connector_config", config: this.#connectorConfig });
          }

          // Replay Hub's unacked outgoing frames and lift TCP backpressure
          for (const { streamId } of resumedStreams) {
            const hubStream = peer.streams.get(streamId);
            if (!hubStream?.resumeBuffer) continue;
            const envRxSeq = envStreamMap.get(streamId) ?? 0;
            const { freedBytes, frames } = hubStream.resumeBuffer.replayFrom(envRxSeq);
            peer.unackedTotalBytes = Math.max(0, peer.unackedTotalBytes - freedBytes);
            for (const frame of frames) {
              if (ws.readyState === ws.OPEN) {
                ws.send(encodeSequencedStreamChunk(streamId, frame.seq, frame.payload));
              }
            }
            if (hubStream.pausedForDisconnect && !hubStream.tcpSocket.destroyed) {
              hubStream.pausedForDisconnect = false;
              hubStream.tcpSocket.resume();
            }
          }
        } else {
          if (peer) {
            if (peer.graceTimer) {
              clearTimeout(peer.graceTimer);
              peer.graceTimer = undefined;
            }
            this.#cancelAndroidNotificationClassification(envId);
            this.#failAndroidRequests(envId, "Android device reconnected before confirming the operation");
            this.#failBrowserRequests(envId, "Browser device reconnected before confirming the operation");
            this.#failComputerRequests(envId, "Computer-use device reconnected before confirming the operation");
            this.#failHostActionRequests(envId, "Device reconnected before confirming the host action");
            this.#failProjectRequests(envId, "Project device reconnected before confirming the operation");
            this.#failExternalAgentRequests(envId, "External agent device reconnected before confirming the operation");
            // Tear down previous socket & streams if replacing stale connection
            if (peer.ws && peer.ws !== ws) {
              try {
                peer.ws.close(4000, "Replaced by newer connection");
              } catch {
                // ignore
              }
            }
            closeStreams = [...new Set([...reportedActiveStreams.map((s) => s.streamId), ...peer.pendingCloseStreamIds])];
            peer.pendingCloseStreamIds.clear();
            this.#failAllStreams(peer, "Reconnected");
            if (executionKind !== (peer.descriptor.executionKind ?? "pi-env")) {
              peer.connection?.close();
              peer.connection = null;
            }
            for (const conn of peer.connectionsByMode.values()) conn.close();
            peer.connectionsByMode.clear();
            peer.ws = ws;
            peer.connectionState = "online";
            peer.missedPings = 0;
            peer.streamResumeSupported = supportsResume;
            peer.unackedTotalBytes = 0;
            peer.connectionLease = msg.connectionLease;
            peer.descriptor = {
              id: envId,
              name: msg.name || envId,
              kind: "reverse-ws",
              online: true,
              platform: msg.platform,
              arch: msg.arch,
              rootDir: msg.rootDir,
              executionKind,
              capabilities,
              connectedAt: now,
              lastSeenAt: now,
              ...(msg.info ? { info: msg.info } : {}),
              ...(msg.listenPort !== undefined ? { listenPort: msg.listenPort } : {}),
              ...(msg.standbyPublicKey ? { standbyPublicKey: msg.standbyPublicKey } : {}),
              ...(msg.identityPublicKey ? { identityPublicKey: msg.identityPublicKey } : {}),
              ...(msg.clusterEpoch !== undefined ? { clusterEpoch: msg.clusterEpoch } : {}),
            };
          } else {
            closeStreams = reportedActiveStreams.map((s) => s.streamId);
            peer = {
              descriptor: {
                id: envId,
                name: msg.name || envId,
                kind: "reverse-ws",
                online: true,
                platform: msg.platform,
                arch: msg.arch,
                rootDir: msg.rootDir,
                executionKind,
                capabilities,
                connectedAt: now,
                lastSeenAt: now,
                ...(msg.info ? { info: msg.info } : {}),
                ...(msg.listenPort !== undefined ? { listenPort: msg.listenPort } : {}),
                ...(msg.standbyPublicKey ? { standbyPublicKey: msg.standbyPublicKey } : {}),
                ...(msg.identityPublicKey ? { identityPublicKey: msg.identityPublicKey } : {}),
                ...(msg.clusterEpoch !== undefined ? { clusterEpoch: msg.clusterEpoch } : {}),
              },
              ws,
              connection: null,
              connectionsByMode: new Map(),
              streams: new Map(),
              nextStreamId: 1,
              connectionLease: msg.connectionLease,
              connectionState: "online",
              streamResumeSupported: supportsResume,
              missedPings: 0,
              pendingCloseStreamIds: new Set(),
              unackedTotalBytes: 0,
            };
            this.#wsPeers.set(envId, peer);
          }
          if (executionKind === "pi-env" && !peer.connection) {
            peer.connection = new Connection({
              command: [process.execPath, STDIO_RELAY_PATH, String(this.#bridgePort), envId, this.#bridgeSecret],
            });
          }

          const clusterPayload = executionKind === "pi-env" ? this.#clusterHandlers?.getRegistrationPayload?.(envId) : undefined;
          const supportsTrusted = executionKind === "pi-env" && hasTrustedHostExecutionCapability(capabilities);
          this.#sendControl(ws, {
            type: "hub.registered",
            envId,
            ...(connectorsSupported ? { hubId: this.#hubId, connectorsSupported: true } : {}),
            ...(supportsResume
              ? {
                  hubInstanceId: this.#hubInstanceId,
                  streamResumeSupported: true,
                  ...(closeStreams.length ? { closeStreams } : {}),
                }
              : {}),
            ...(clusterPayload?.cluster ? { cluster: clusterPayload.cluster } : {}),
            ...(clusterPayload?.standby ? { standby: clusterPayload.standby } : {}),
            ...(supportsTrusted
              ? { executionTrustMode: this.#executionTrustMode, executionTrustModeRevision: this.#executionTrustModeRevision }
              : {}),
          });
          if (connectorsSupported) {
            this.#sendControl(ws, { type: "hub.connector_config", config: this.#connectorConfig });
          }
        }

        this.#clusterHandlers?.onPeerRegistered?.(envId, this.#displayDescriptor(peer.descriptor));
        const pendingRevocations = this.#pendingRevocations.get(envId);
        if (executionKind === "pi-env" && pendingRevocations?.size) {
          void Promise.all([...pendingRevocations].map((projectId) => this.revokeProjectDirectory(envId, projectId)))
            .then(() => this.#notifyChange())
            .catch((error: unknown) => console.error("[KuloEnv:revocation]", error instanceof Error ? error.message : "Project revocation failed"));
        }
        this.#notifyChange();
        return;
      }

      if (!boundEnvId) {
        ws.close(4003, "Must register first");
        return;
      }

      const peer = this.#wsPeers.get(boundEnvId);
      if (!peer || peer.ws !== ws) return;
      peer.missedPings = 0;
      peer.descriptor.lastSeenAt = Date.now();

      if (msg.type === "env.sync_status") {
        if (peer.descriptor.executionKind !== "pi-env" || !isClusterSyncStatus(msg.status)) {
          ws.close(4002, "Invalid cluster sync status");
          return;
        }
        this.#clusterHandlers?.onSyncStatus?.(boundEnvId, msg.status);
        return;
      }

      if (msg.type === "env.android_status") {
        if (peer.descriptor.executionKind !== "native-device" || !isAndroidEnvStatus(msg.status)) {
          ws.close(4002, "Invalid Android capability status");
          return;
        }
        peer.descriptor.android = JSON.parse(JSON.stringify(msg.status));
        if (!msg.status.enabled || msg.status.paused || !msg.status.grants.includes("notifications"))
          for (const item of this.#notificationControllers.get(ws)?.values() ?? []) item.controller.abort();
        peer.descriptor.capabilities = ["android-device", "android-native-v1", ...msg.status.capabilities.map((capability) => `android:${capability.action}`)];
        this.#notifyChange();
      } else if (msg.type === "env.notification_classify") {
        if (peer.descriptor.executionKind !== "native-device" || !isAndroidNotificationClassification(msg.request) || msg.request.deviceId !== boundEnvId) {
          ws.close(4002, "Invalid Android notification request"); return;
        }
        const request = msg.request;
        let pending = this.#notificationControllers.get(ws);
        if (!pending) { pending = new Map(); this.#notificationControllers.set(ws, pending); }
        if (pending.has(request.requestId)) return;
        const controller = new AbortController();
        const current = () => this.#wsPeers.get(request.deviceId)?.ws === ws && this.#remoteConnectionsEnabled && !this.#revokedDeviceIds.has(request.deviceId) &&
          (this.#deviceConnectionLeases.get(request.deviceId) === undefined || sameToken(boundLease, this.#deviceConnectionLeases.get(request.deviceId))) &&
          peer.descriptor.android?.enabled && !peer.descriptor.android.paused && peer.descriptor.android.grants.includes("notifications");
        const { ruleText: _rules, defaultRule: _default, notification: _notification, ...identity } = request;
        const errorResult = (error: string): AndroidNotificationClassificationResult => ({ ...identity,
          decisionId: "notification-" + createHash("sha256").update([request.hubId, request.deviceId, String(request.ruleRevision), request.notificationId, request.notificationVersion].join("\0")).digest("hex"), error });
        if (!current() || pending.size >= 2) {
          this.#sendControl(ws, { type: "hub.notification_decision", result: errorResult(current() ? "notification_rate_limited" : "notification_permission_required") }); return;
        }
        pending.set(request.requestId, { bindingId: request.bindingId, controller });
        const abort = () => {
          controller.abort();
          if (pending!.get(request.requestId)?.controller === controller) pending!.delete(request.requestId);
          if (!pending!.size && this.#notificationControllers.get(ws) === pending) this.#notificationControllers.delete(ws);
        }; ws.once("close", abort);
        void Promise.resolve().then(() => this.#notificationClassifier ? this.#notificationClassifier(request, controller.signal) : errorResult("notification_model_required"))
          .then(result => {
            if (!current() || controller.signal.aborted) return;
            if (!isAndroidNotificationClassificationResult(result, request) || result.decisionId !== errorResult("invalid").decisionId) result = errorResult("notification_model_invalid_output");
            this.#sendControl(ws, { type: "hub.notification_decision", result });
          }).catch(() => {
            if (current() && !controller.signal.aborted) this.#sendControl(ws, { type: "hub.notification_decision", result: errorResult("notification_model_unavailable") });
          }).finally(() => {
            ws.off("close", abort);
            if (pending!.get(request.requestId)?.controller === controller) pending!.delete(request.requestId);
            if (!pending!.size && this.#notificationControllers.get(ws) === pending) this.#notificationControllers.delete(ws);
          });
      } else if (msg.type === "env.notification_cancel") {
        const pending = this.#notificationControllers.get(ws)?.get(msg.requestId);
        if (pending?.bindingId === msg.bindingId) pending.controller.abort();
      } else if (msg.type === "env.connector_call_result") {
        const pending = this.#connectorCalls.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId || pending.ws !== ws) return;
        clearTimeout(pending.timer);
        this.#connectorCalls.delete(msg.requestId);
        if (data.toString("utf8").length > CONNECTOR_MAX_BATCH_BYTES * 2) {
          pending.resolve({ ok: false, code: "result_too_large", error: "连接器返回数据超出大小限制" });
          return;
        }
        const res = msg.result;
        if (!res || typeof res !== "object" || typeof res.ok !== "boolean") {
          pending.resolve({ ok: false, code: "invalid_result", error: "连接器返回格式无效" });
          return;
        }
        pending.resolve(res);
      } else if (msg.type === "env.android_result") {
        const pending = this.#androidRequests.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId || pending.ws !== ws) return;
        if (!isAndroidResult(msg.result, pending.request)) {
          this.#finishAndroidRequest(msg.requestId, undefined, new Error("Invalid Android operation response"));
        } else this.#finishAndroidRequest(msg.requestId, msg.result);
      } else if (msg.type === "env.android_control_result") {
        const pending = this.#androidControls.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId || pending.ws !== ws) return;
        if (!isAndroidControlResult(msg.result) || msg.result.controlId !== pending.request.controlId ||
            msg.result.ticketId !== pending.request.ticketId || msg.result.runEpoch !== pending.request.runEpoch) {
          this.#finishAndroidControl(msg.requestId, undefined, new Error("Invalid Android stop response"));
        } else this.#finishAndroidControl(msg.requestId, msg.result);
      } else if (msg.type === "env.computer_preview") {
        const preview = this.#computerPreviews.get(msg.subscriptionId);
        if (!preview || preview.envId !== boundEnvId || preview.ws !== ws) return;
        const lease = this.#deviceConnectionLeases.get(boundEnvId!);
        if (lease !== undefined && !sameToken(preview.lease, lease)) return;
        if (!isComputerPreviewUpdate(msg.update)) {
          this.#endComputerPreview(msg.subscriptionId, { state: "closed", message: "设备返回的画面无效" });
          return;
        }
        preview.listener(msg.update);
      } else if (msg.type === "env.external_agent_result") {
        const pending = this.#externalAgentRequests.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId || pending.ws !== ws) return;
        pending.finish();
        if (msg.error) pending.reject(new Error(redactSensitiveText(msg.error).slice(0, 2000)));
        else {
          const result = msg.result;
          const request = pending.request;
          const valid = isExternalAgentResponse(result) && data.toString("utf8").length < 1_500_000 && (
            result.type === "detection"
              ? (request.operation === "detect" && result.detection.kind === request.kind || request.operation === "probe" && result.detection.kind === request.binding.kind)
              : result.type === "quota"
                ? request.operation === "quota" && result.quota.kind === request.binding.kind
                : result.type === "diff"
                  ? request.operation === "diff"
                  : result.type === "apply"
                    ? request.operation === "apply"
                    : result.type === "run"
                      ? (request.operation === "run"
                          ? result.run.id === request.requestId && result.run.taskId === request.taskId && result.run.runEpoch === request.runEpoch && result.run.kind === request.binding.kind
                          : "runId" in request && result.run.id === request.runId)
                      : false
          );
          if (valid) pending.resolve(result); else pending.reject(new Error("Invalid external agent response"));
        }
      } else if (msg.type === "env.external_agent_tool_request") {
        if (!boundEnvId || !this.#externalAgentToolHandler || !/^[a-f0-9]{32}$/.test(msg.requestId) || typeof msg.runId !== "string" || typeof msg.taskId !== "string" || !Number.isSafeInteger(msg.runEpoch)
          || typeof msg.cwd !== "string" || typeof msg.allowSubagents !== "boolean"
          || !BRIDGE_EXTERNAL_AGENT_TOOL_SET.has(msg.name)
          || !msg.args || typeof msg.args !== "object" || Array.isArray(msg.args) || data.toString("utf8").length > 130_000) return;
        let pending = this.#externalToolRequests.get(ws); if (!pending) this.#externalToolRequests.set(ws, pending = new Set());
        if (pending.has(msg.requestId) || pending.size >= 32) return; pending.add(msg.requestId);
        const envId = boundEnvId;
        const invocation = { runId: msg.runId, taskId: msg.taskId, runEpoch: msg.runEpoch, cwd: msg.cwd, allowSubagents: msg.allowSubagents, name: msg.name, args: msg.args, envId };
        void this.#externalAgentToolHandler(invocation).then(result => {
          if (this.#wsPeers.get(envId)?.ws === ws && !this.#closed) this.#sendControl(ws, { type: "hub.external_agent_tool_result", requestId: msg.requestId, runId: msg.runId, taskId: msg.taskId, runEpoch: msg.runEpoch, result });
        }, (error: unknown) => {
          if (this.#wsPeers.get(envId)?.ws === ws && !this.#closed) this.#sendControl(ws, { type: "hub.external_agent_tool_result", requestId: msg.requestId, runId: msg.runId, taskId: msg.taskId, runEpoch: msg.runEpoch, error: redactSensitiveText(error instanceof Error ? error.message : "Kulo task tool failed").slice(0, 2000) });
        }).finally(() => pending!.delete(msg.requestId));
      } else if (msg.type === "env.connector_status") {
        if (peer.descriptor.executionKind !== "pi-env" || !isConnectorSourceStatus(msg.status)) return;
        const normalized: ConnectorSourceStatus = {
          ...msg.status,
          envId: boundEnvId,
          envName: peer.descriptor.name,
          platform: peer.descriptor.platform,
        };
        this.#connectorStatuses.set(`${boundEnvId}:${normalized.driverId}`, normalized);
        this.#connectorHandlers?.onStatus?.(boundEnvId, normalized);
      } else if (msg.type === "env.connector_events") {
        if (peer.descriptor.executionKind !== "pi-env") return;
        const rawBatch = msg.batch as Partial<ConnectorEventBatch> | undefined;
        if (!isConnectorEventBatch(rawBatch)) {
          if (rawBatch && typeof rawBatch.batchId === "string" && typeof rawBatch.streamId === "string" && typeof rawBatch.sourceEpoch === "string") {
            this.#sendControl(ws, {
              type: "hub.connector_ack",
              ack: {
                batchId: rawBatch.batchId.slice(0, 160),
                driverId: "macos-notifications",
                streamId: rawBatch.streamId.slice(0, 256),
                sourceEpoch: rawBatch.sourceEpoch.slice(0, 160),
                status: "rejected",
                code: "invalid_batch",
              },
            });
          }
          return;
        }
        const envId = boundEnvId;
        void this.#dispatchConnectorBatch(envId, rawBatch).then((ack) => {
          if (this.#wsPeers.get(envId)?.ws === ws && !this.#closed) {
            this.#sendControl(ws, { type: "hub.connector_ack", ack });
          }
        });
      } else if (msg.type === "env.computer_result") {
        const pending = this.#computerRequests.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId || pending.ws !== ws) return;
        if (msg.error) this.#finishComputerRequest(msg.requestId, undefined, new Error("Computer-use device could not confirm the operation; observe the target before retrying"));
        else if (!isComputerUseResult(msg.result, pending.request) || msg.result.platform !== peer.descriptor.platform
          || data.toString("utf8").length > COMPUTER_USE_MAX_RESULT + 4096) {
          this.#finishComputerRequest(msg.requestId, undefined, new Error("Invalid computer-use response"));
        } else this.#finishComputerRequest(msg.requestId, msg.result);
      } else if (msg.type === "env.host_action_result") {
        const pending = this.#hostActionRequests.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId || pending.ws !== ws) return;
        if (msg.error) this.#finishHostActionRequest(msg.requestId, undefined, new Error(redactSensitiveText(msg.error).slice(0, 2000)));
        else if (!isHostActionResult(msg.result, pending.request) || msg.result.platform !== peer.descriptor.platform
          || data.toString("utf8").length > HOST_ACTION_MAX_RESULT + 4096) {
          this.#finishHostActionRequest(msg.requestId, undefined, new Error("Invalid host action response"));
        } else this.#finishHostActionRequest(msg.requestId, msg.result);
      } else if (msg.type === "env.browser_result") {
        const pending = this.#browserRequests.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId) return;
        clearTimeout(pending.timer); this.#browserRequests.delete(msg.requestId);
        if (msg.error) pending.reject(new Error("Flow browser device could not complete the operation"));
        else {
          try { pending.resolve(checkedBrowserResult(msg.result, pending.profileRef, pending.jobId)); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error("Invalid browser response")); }
        }
      } else if (msg.type === "env.project_result") {
        const pending = this.#projectRequests.get(msg.requestId);
        if (!pending || pending.envId !== boundEnvId) return;
        clearTimeout(pending.timer);
        this.#projectRequests.delete(msg.requestId);
        if (msg.error) {
          const allowedCodes = new Set(["project_directory_unavailable", "staged_workspace_conflict", "staged_workspace_oversized"]);
          pending.reject(Object.assign(new Error(msg.error.slice(0, 2000)), msg.errorCode && allowedCodes.has(msg.errorCode) ? { code: msg.errorCode } : {}));
        }
        else if (msg.result && typeof msg.result === "object") pending.resolve(msg.result);
        else pending.reject(new Error("Env returned an invalid project response"));
      } else if (msg.type === "env.stream_ready") {
        const stream = peer.streams.get(msg.streamId);
        if (stream && !stream.ready) {
          clearTimeout(stream.readyTimer);
          stream.ready = true;
          stream.tcpSocket.write("OK\n");
        }
      } else if (msg.type === "env.stream_ack") {
        const stream = peer.streams.get(msg.streamId);
        if (stream?.resumeBuffer && Number.isSafeInteger(msg.rxSeq)) {
          const freed = stream.resumeBuffer.ackOutgoing(msg.rxSeq);
          peer.unackedTotalBytes = Math.max(0, peer.unackedTotalBytes - freed);
        }
      } else if (msg.type === "env.stream_closed") {
        peer.pendingCloseStreamIds.delete(msg.streamId);
        const stream = peer.streams.get(msg.streamId);
        if (stream) {
          clearTimeout(stream.readyTimer);
          if (stream.ackTimer) clearTimeout(stream.ackTimer);
          if (stream.resumeBuffer) {
            peer.unackedTotalBytes = Math.max(0, peer.unackedTotalBytes - stream.resumeBuffer.clear());
          }
          peer.streams.delete(msg.streamId);
          if (!stream.ready) {
            stream.tcpSocket.end(`ERR:${msg.error ?? "Remote daemon failed to start"}\n`);
          } else {
            stream.tcpSocket.end();
          }
        }
      }
    });

    ws.on("close", (code) => {
      if (!boundEnvId) return;
      const peer = this.#wsPeers.get(boundEnvId);
      if (peer && peer.ws === ws) {
        const intentionalOrRevoked =
          this.#closed ||
          !this.#remoteConnectionsEnabled ||
          this.#revokedDeviceIds.has(boundEnvId) ||
          code === 1000 ||
          code === 4000 ||
          code === 4001 ||
          code === 4002 ||
          code === 4003 ||
          code === 4009;
        const canGraceReconnect =
          !intentionalOrRevoked &&
          peer.streamResumeSupported &&
          peer.descriptor.executionKind !== "native-device" &&
          this.#streamResumeGraceMs > 0;

        this.#failBrowserRequests(boundEnvId, "Browser device disconnected before confirming the operation");
        this.#failComputerRequests(boundEnvId, "Computer-use device disconnected before confirming the operation");
        this.#failHostActionRequests(boundEnvId, "Device disconnected before confirming the host action");
        this.#failAndroidRequests(boundEnvId, "Android device disconnected before confirming the operation");
        this.#failProjectRequests(boundEnvId, "Project device disconnected before confirming the operation");
        this.#failExternalAgentRequests(boundEnvId, "External agent device disconnected; inspect the existing run after reconnecting");
        this.#externalToolRequests.delete(ws);

        if (canGraceReconnect) {
          peer.ws = null;
          peer.missedPings = 0;
          peer.connectionState = "reconnecting";
          // Preserve descriptor.online = true during the 20s grace window so prompt caches & assertions stay stable.
          for (const stream of peer.streams.values()) {
            if (!stream.tcpSocket.destroyed) {
              stream.tcpSocket.pause();
              stream.pausedForDisconnect = true;
            }
          }
          if (peer.graceTimer) clearTimeout(peer.graceTimer);
          const envIdForTimer = boundEnvId;
          peer.graceTimer = setTimeout(() => this.#expirePeerGrace(envIdForTimer, peer), this.#streamResumeGraceMs);
          peer.graceTimer.unref();
        } else {
          if (peer.graceTimer) {
            clearTimeout(peer.graceTimer);
            peer.graceTimer = undefined;
          }
          peer.ws = null;
          peer.missedPings = 0;
          peer.connectionState = "offline";
          peer.descriptor.online = false;
          this.#failAllStreams(peer, "Env WebSocket disconnected");
          this.#notifyChange();
        }
      }
    });

    ws.on("error", () => {
      // Handled by close
    });
  }

  /** List all known execution environments (local + remote). */
  setDeviceCredential(id: string, token: string): void {
    const otherTokens = [
      ...Object.entries(this.#options.envTokens ?? {}).filter(([envId]) => envId !== id).map(([, value]) => value),
      ...[...this.#deviceTokens].filter(([envId]) => envId !== id).map(([, value]) => value),
    ];
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || id === "local" || this.isLocalEnv(id) || !token || /\s/.test(token) || sameToken(token, this.#options.authToken) || otherTokens.some((other) => sameToken(token, other))) {
      throw new Error("Invalid device credential");
    }
    const previous = this.#deviceTokens.get(id) ?? this.#options.envTokens?.[id];
    this.#deviceTokens.set(id, token);
    if (previous !== undefined && !sameToken(previous, token)) {
      this.#failComputerRequests(id, "Computer-use device credential changed");
      this.#failHostActionRequests(id, "Device credential changed");
      this.#failAndroidRequests(id, "Android device credential changed");
      this.#failExternalAgentRequests(id, "External agent device credential changed");
      const peer = this.#wsPeers.get(id);
      if (peer) {
        peer.descriptor.online = false;
        peer.ws?.close(4001, "Device credential changed");
      }
    }
  }

  isNodeCredential(token: string): boolean {
    return [...Object.values(this.#options.envTokens ?? {}), ...this.#deviceTokens.values()].some((candidate) => sameToken(token, candidate));
  }

  /** Issuing a new route lease fences both pending registrations and already-bound sockets. */
  setDeviceConnectionLease(envId: string, lease: string): void {
    if (this.#closed) throw new Error("Env manager is closed");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(envId) || envId === "local" || this.isLocalEnv(envId) || typeof lease !== "string" || !lease || lease.length > 256 || /\s/.test(lease)) {
      throw new Error("Invalid device connection lease");
    }
    this.#deviceConnectionLeases.set(envId, lease);
    if (this.#wsPeers.get(envId)?.connectionLease !== lease) {
      this.#cancelAndroidNotificationClassification(envId);
      this.#failComputerRequests(envId, "Computer-use device connection lease changed");
      this.#failHostActionRequests(envId, "Device connection lease changed");
      this.#failAndroidRequests(envId, "Android device connection lease changed");
      this.#failExternalAgentRequests(envId, "External agent device connection lease changed");
    }
  }

  setRemoteConnectionsEnabled(enabled: boolean): void {
    this.#remoteConnectionsEnabled = enabled;
    if (!enabled) {
      this.invalidateWorkerEnvironments();
      for (const peer of this.#wsPeers.values()) {
        if (peer.graceTimer) {
          clearTimeout(peer.graceTimer);
          peer.graceTimer = undefined;
        }
        this.#cancelAndroidNotificationClassification(peer.descriptor.id);
        this.#failBrowserRequests(peer.descriptor.id, "Device interconnection disabled");
        this.#failComputerRequests(peer.descriptor.id, "Device interconnection disabled");
        this.#failHostActionRequests(peer.descriptor.id, "Device interconnection disabled");
        this.#failAndroidRequests(peer.descriptor.id, "Device interconnection disabled");
        this.#failExternalAgentRequests(peer.descriptor.id, "Device interconnection disabled");
        peer.connectionState = "offline";
        peer.descriptor.online = false;
        peer.connection?.close();
        this.#failAllStreams(peer, "Device interconnection disabled");
        peer.ws?.close(4003, "Device interconnection disabled");
      }
      this.#notifyChange();
    }
  }

  removeDevice(id: string): void {
    this.#cancelAndroidNotificationClassification(id);
    this.#failBrowserRequests(id, "Browser device removed");
    this.#failComputerRequests(id, "Computer-use device removed");
    this.#failHostActionRequests(id, "Device removed");
    this.#failExternalAgentRequests(id, "External agent device removed before confirming the operation");
    this.#failAndroidRequests(id, "Android device removed");
    this.#deviceTokens.delete(id);
    this.#deviceConnectionLeases.delete(id);
    this.#deviceDisplayNames.delete(id);
    this.#revokedDeviceIds.add(id);
    const peer = this.#wsPeers.get(id);
    if (peer) {
      if (peer.graceTimer) {
        clearTimeout(peer.graceTimer);
        peer.graceTimer = undefined;
      }
      peer.connectionState = "offline";
      peer.descriptor.online = false;
      this.#wsPeers.delete(id);
      peer.connection?.close();
      this.#failAllStreams(peer, "Device removed");
      peer.ws?.close(4001, "Device removed");
    }
    const ssh = this.#sshPeers.get(id);
    ssh?.connection.close();
    this.#sshPeers.delete(id);
    this.invalidateWorkerEnvironments();
    this.#notifyChange();
  }

  #androidPeer(envId: string): RemoteWsPeer & { ws: WebSocket } {
    if (this.#closed) throw new Error("Env manager is closed");
    if (!this.#remoteConnectionsEnabled || this.#revokedDeviceIds.has(envId)) throw new Error("Android device authorization has been revoked");
    const peer = this.#wsPeers.get(envId);
    if (peer?.descriptor.executionKind !== "native-device") throw new Error("Android operations require a native Android device");
    if (!peer.descriptor.online || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) throw new Error("Android device is offline");
    const lease = this.#deviceConnectionLeases.get(envId);
    if (lease !== undefined && !sameToken(peer.connectionLease, lease)) throw new Error("Android device connection lease changed");
    return peer as RemoteWsPeer & { ws: WebSocket };
  }

  /** Native actions travel over the authenticated Env connection, never the Pi daemon tunnel. */
  async requestAndroid(envId: string, input: AndroidRequest, signal?: AbortSignal): Promise<AndroidResult> {
    if (!isAndroidRequest(input) || input.deviceId !== envId) throw new Error("Invalid Android operation request");
    if (signal?.aborted) throw Object.assign(new Error("Android operation cancelled"), { name: "AbortError" });
    const request: AndroidRequest = JSON.parse(JSON.stringify(input));
    const peer = this.#androidPeer(envId);
    if (!peer.descriptor.android?.capabilities.some((capability) => capability.action === request.action)) {
      throw new Error("Android capability is not ready on this device");
    }
    const remaining = Math.floor(request.deadline - Date.now());
    if (remaining <= 0 || remaining > 120_000) throw new Error("Android operation deadline is invalid or expired");
    if (this.#androidRequests.size >= 32) throw new Error("Android operation limit reached");
    const requestId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const cancel = () => this.#finishAndroidRequest(requestId, undefined,
        Object.assign(new Error("Android operation cancelled; its outcome must be reconciled before retrying"), { name: "AbortError" }), true);
      const timer = setTimeout(() => this.#finishAndroidRequest(requestId, undefined,
        new Error("Android operation was not confirmed before its deadline; do not repeat a modifying action"), true), remaining);
      timer.unref();
      this.#androidRequests.set(requestId, { envId, ws: peer.ws, request, resolve, reject, timer,
        removeAbort: () => signal?.removeEventListener("abort", cancel) });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      const budgetMs = Math.floor(request.deadline - Date.now());
      if (budgetMs < 1 || budgetMs > 120_000) {
        this.#finishAndroidRequest(requestId, undefined, new Error("Android operation deadline is invalid or expired"));
        return;
      }
      try { this.#sendControl(peer.ws, { type: "hub.android_request", requestId, request, budgetMs }); }
      catch { this.#finishAndroidRequest(requestId, undefined, new Error("Android operation could not be sent; its outcome is unconfirmed")); }
    });
  }

  setAndroidNotificationClassifier(handler: ((request: AndroidNotificationClassification, signal: AbortSignal) => Promise<AndroidNotificationClassificationResult>) | undefined): void {
    this.#notificationClassifier = handler;
    if (!handler) for (const entries of this.#notificationControllers.values()) for (const pending of entries.values()) pending.controller.abort();
  }

  #cancelAndroidNotificationClassification(envId: string): void {
    const ws = this.#wsPeers.get(envId)?.ws;
    if (ws) for (const pending of this.#notificationControllers.get(ws)?.values() ?? []) pending.controller.abort();
  }

  async cancelAndroid(envId: string, input: AndroidCancel, timeoutMs = 5_000): Promise<AndroidControlResult> {
    if (!isAndroidCancel(input) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid Android stop request");
    const request: AndroidCancel = JSON.parse(JSON.stringify(input));
    const peer = this.#androidPeer(envId);
    if (this.#androidControls.size >= 32) throw new Error("Android stop request limit reached");
    const requestId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#finishAndroidControl(requestId, undefined,
        new Error("Android stop has not confirmed that native work is quiescent")), timeoutMs);
      timer.unref();
      this.#androidControls.set(requestId, { envId, ws: peer.ws, request, resolve, reject, timer });
      try { this.#sendControl(peer.ws, { type: "hub.android_cancel", requestId, request }); }
      catch { this.#finishAndroidControl(requestId, undefined, new Error("Android stop could not be sent")); }
    });
  }

  #finishAndroidRequest(id: string, result?: AndroidResult, error?: Error, cancel = false): void {
    const pending = this.#androidRequests.get(id);
    if (!pending) return;
    this.#androidRequests.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort();
    if (error) {
      if (cancel && this.#wsPeers.get(pending.envId)?.ws === pending.ws) {
        const controlId = "cancel-" + createHash("sha256").update(JSON.stringify([
          pending.request.ticketId, pending.request.runEpoch, pending.request.operationId,
        ])).digest("hex");
        const request: AndroidCancel = { version: 1, controlId,
          ticketId: pending.request.ticketId, runEpoch: pending.request.runEpoch, reason: "Operation cancelled or deadline expired" };
        // Confirmation is separate from rejecting the caller; lack of one must not mean native work stopped.
        void this.cancelAndroid(pending.envId, request).catch(() => {});
      }
      pending.reject(error);
    } else pending.resolve(result!);
  }

  #finishAndroidControl(id: string, result?: AndroidControlResult, error?: Error): void {
    const pending = this.#androidControls.get(id);
    if (!pending) return;
    this.#androidControls.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(result!);
  }

  #failAndroidRequests(envId: string, message: string): void {
    for (const [id, pending] of this.#androidRequests) {
      if (pending.envId === envId) this.#finishAndroidRequest(id, undefined, new Error(message));
    }
    for (const [id, pending] of this.#androidControls) {
      if (pending.envId === envId) this.#finishAndroidControl(id, undefined, new Error(message));
    }
  }

  setExternalAgentToolHandler(handler: ExternalAgentToolHandler | undefined): void {
    this.#externalAgentToolHandler = handler;
    this.#localExternalAgents?.setToolHandler(handler);
  }

  async requestExternalAgent(envId: string, request: ExternalAgentRequest, signal?: AbortSignal): Promise<ExternalAgentResponse> {
    if (this.#closed) throw new Error("Env manager is closed");
    this.#assertPiEnv(envId);
    if (!isExternalAgentRequest(request) || JSON.stringify(request).length > 300_000) throw new Error("Invalid external agent control request");
    if ((request.operation === "run" || request.operation === "probe" || request.operation === "quota") && request.binding.envId !== envId) throw new Error("External agent binding belongs to another device");
    if ((request.operation === "run" || request.operation === "probe" || request.operation === "quota") && !this.isLocalEnv(envId) && !this.#options.workerEnvIds?.includes(envId) && !this.#deviceTokens.has(envId)) throw new Error(`Env '${envId}' has not been approved for isolated Worker execution`);
    if (signal?.aborted) throw new Error("External agent request was aborted");
    if (this.isLocalEnv(envId)) {
      if (!this.#localExternalAgents) throw new Error("Local external agent runtime is not enabled");
      return this.#localExternalAgents.request(request, signal);
    }
    const peer = this.#wsPeers.get(envId);
    if (!peer?.descriptor.online || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) throw new Error(`External agent device '${envId}' is offline`);
    if (!peer.descriptor.capabilities.includes("external-agents")) throw new Error("The selected device must update its Kulo Env before connecting external agents");
    if (request.operation === "quota" && !peer.descriptor.capabilities.includes(EXTERNAL_AGENT_QUOTA_CAPABILITY)) throw new Error("The selected device must update its Kulo Env before checking external agent quotas");
    if (request.operation === "run" && (request.developerInstructions !== undefined || request.attachments !== undefined) && !peer.descriptor.capabilities.includes(EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY)) throw new Error("The selected device must update its Kulo Env before using structured external agent dispatch");
    if (this.#externalAgentRequests.size >= 32) throw new Error("External agent control request limit reached");
    const ws = peer.ws;
    const requestId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#externalAgentRequests.delete(requestId); };
      const abort = () => { finish(); reject(new Error("External agent control request aborted; inspect the existing run before retrying")); };
      const timer = setTimeout(() => { finish(); reject(new Error("External agent control acknowledgement timed out; inspect the existing run before retrying")); }, request.operation === "probe" || request.operation === "detect" ? 60_000 : 15_000); timer.unref();
      this.#externalAgentRequests.set(requestId, { envId, ws, request, resolve, reject, finish });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.#sendControl(ws, { type: "hub.external_agent_request", requestId, request }); }
      catch (error) { finish(); reject(error); }
    });
  }

  #failExternalAgentRequests(envId: string, message: string): void {
    for (const pending of [...this.#externalAgentRequests.values()]) if (pending.envId === envId) { pending.finish(); pending.reject(new Error(message)); }
    for (const [id, pending] of [...this.#connectorCalls.entries()]) {
      if (pending.envId === envId) {
        clearTimeout(pending.timer);
        this.#connectorCalls.delete(id);
        pending.resolve({ ok: false, code: "env_disconnected", error: message });
      }
    }
  }

  async #projectRequest(envId: string, request: ProjectEnvRequest): Promise<NonNullable<Extract<EnvToHubControlMessage, { type: "env.project_result" }>["result"]>> {
    if (this.#closed) throw new Error("Env manager is closed");
    this.#assertPiEnv(envId);
    const peer = this.#wsPeers.get(envId);
    if (!peer?.descriptor.online || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) throw new Error(`Project device '${envId}' is offline`);
    const requestId = randomBytes(16).toString("hex");
    const timeoutMs = request.action.startsWith("staged_") ? 60_000 : 15_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#projectRequests.delete(requestId);
        reject(new Error("Project device did not confirm the operation in time"));
      }, timeoutMs);
      timer.unref();
      this.#projectRequests.set(requestId, { envId, resolve, reject, timer });
      this.#sendControl(peer.ws!, { type: "hub.project_request", requestId, request });
    });
  }

  async requestBrowser(envId: string, request: BrowserRequest): Promise<BrowserResult> {
    if (this.#closed) throw new Error("Env manager is closed");
    this.#assertPiEnv(envId);
    if (!request || typeof request.profileRef !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.profileRef) || JSON.stringify(request).length > 2 * 1024 * 1024) throw new Error("Invalid browser control request");
    if ("takeover" in request && (request.action !== "check" || typeof request.takeover !== "boolean")) throw new Error("Invalid Flow browser takeover");
    const descriptor = this.getEnvDescriptor(envId);
    if (!descriptor?.online) throw new Error("Flow browser device is offline");
    if (!descriptor.capabilities.includes("flow-browser")) throw new Error("This device has no Flow browser capability");
    if (this.isLocalEnv(envId)) {
      if (!this.#localBrowser) throw new Error("Local Flow browser is unavailable");
      return this.#localBrowser.request(request, () => !this.#closed);
    }
    const peer = this.#wsPeers.get(envId);
    if (!peer?.ws || peer.ws.readyState !== peer.ws.OPEN) throw new Error("Flow requires an authenticated browser Env connection");
    const requestId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#browserRequests.delete(requestId);
        reject(new Error("Flow browser did not confirm the operation; check the original job before retrying"));
      }, 60_000);
      timer.unref();
      this.#browserRequests.set(requestId, { envId, profileRef: request.profileRef, ...("jobId" in request ? { jobId: request.jobId } : {}), resolve, reject, timer });
      this.#sendControl(peer.ws!, { type: "hub.browser_request", requestId, request });
    });
  }

  async requestComputerUse(envId: string, request: ComputerUseRequest, signal?: AbortSignal): Promise<ComputerUseResult> {
    return executeComputerUseWithCompat({
      closed: this.#closed, descriptor: this.getEnvDescriptor(envId), request, targetMode: this.#executionTrustMode, isLocal: this.isLocalEnv(envId), signal,
      sendRpc: (scopedRequest, timeoutMs, rpcSignal) => this.#dispatchComputerUseRpc(envId, scopedRequest, timeoutMs, rpcSignal),
    });
  }
  #dispatchComputerUseRpc(envId: string, scopedRequest: ComputerUseRequest, timeoutMs: number, signal?: AbortSignal): Promise<ComputerUseResult> {
    if (this.#closed) throw new Error("Env manager is closed");
    if (signal?.aborted) throw Object.assign(new Error("Computer-use operation cancelled"), { name: "AbortError" });
    if (this.#computerRequests.size >= 32) throw new Error("Computer-use request limit reached");
    const peer = this.isLocalEnv(envId) ? undefined : this.#wsPeers.get(envId);
    if (this.isLocalEnv(envId) ? !this.#localComputer : !peer?.ws || peer.ws.readyState !== peer.ws.OPEN) throw new Error("Computer use requires the target device's authenticated Env connection");
    const expectedLease = this.#deviceConnectionLeases.get(envId);
    if (peer && expectedLease !== undefined && !sameToken(peer.connectionLease, expectedLease)) throw new Error("Computer-use device connection lease changed");
    const requestId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const cancel = () => this.#finishComputerRequest(requestId, undefined, Object.assign(new Error("Computer-use operation cancelled; observe the target before retrying"), { name: "AbortError" }));
      const timer = setTimeout(() => this.#finishComputerRequest(requestId, undefined, new Error("Computer-use operation was not confirmed in time; observe the target before retrying")), timeoutMs);
      timer.unref();
      const pending: PendingComputerRequest = { envId, request: scopedRequest, ...(peer?.ws ? { ws: peer.ws } : {}), controller, resolve, reject, timer, removeAbort: () => signal?.removeEventListener("abort", cancel) };
      this.#computerRequests.set(requestId, pending);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      if (pending.ws) this.#sendControl(pending.ws, { type: "hub.computer_request", requestId, request: scopedRequest });
      else {
        const active = () => !this.#closed && this.#computerRequests.get(requestId) === pending && !controller.signal.aborted;
        void Promise.resolve().then(() => { if (!active()) throw new Error("Computer-use operation cancelled"); return this.#localComputer!.request(scopedRequest, active, controller.signal); })
          .then((result) => { if (!active()) return; if (!isComputerUseResult(result, scopedRequest)) this.#finishComputerRequest(requestId, undefined, new Error("Invalid computer-use response")); else this.#finishComputerRequest(requestId, result); },
            () => this.#finishComputerRequest(requestId, undefined, new Error("Computer-use device could not confirm the operation; observe the target before retrying")));
      }
    });
  }

  async requestHostAction(envId: string, request: HostActionRequest, signal?: AbortSignal): Promise<HostActionResult> {
    if (this.#closed) throw new Error("Env manager is closed");
    if (!isHostActionRequest(request)) throw new Error("Invalid host action request");
    if (signal?.aborted) throw Object.assign(new Error("Host action cancelled"), { name: "AbortError" });
    const descriptor = this.getEnvDescriptor(envId);
    if (!descriptor?.online) throw new Error(`目标设备 '${envId}' 当前离线`);
    if (descriptor.executionKind === "native-device" || !["darwin", "linux", "win32"].includes(descriptor.platform)) {
      throw new Error("当前设备不支持本机诊断或运维操作");
    }
    if (!descriptor.capabilities.includes("host-actions")) {
      throw new Error("目标设备端版本尚未支持本机诊断或运维操作，请更新该设备上的 Kulo 客户端");
    }
    if (this.#hostActionRequests.size >= 16) throw new Error("Host action request limit reached");
    const peer = this.isLocalEnv(envId) ? undefined : this.#wsPeers.get(envId);
    if (this.isLocalEnv(envId) ? !this.#localHostActions : !peer?.ws || peer.ws.readyState !== peer.ws.OPEN) {
      throw new Error("本机操作需要目标设备的有效节点连接");
    }
    const expectedLease = this.#deviceConnectionLeases.get(envId);
    if (peer && expectedLease !== undefined && !sameToken(peer.connectionLease, expectedLease)) {
      throw new Error("Device connection lease changed");
    }
    const scopedRequest = scopeHostActionForTarget(request, this.#executionTrustMode, descriptor.capabilities, this.isLocalEnv(envId));
    const requestId = randomBytes(16).toString("hex");
    const timeoutMs = scopedRequest.kind === "run" ? Math.min((scopedRequest.timeoutMs ?? 120_000) + 15_000, 620_000) : 20_000;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const cancel = () => this.#finishHostActionRequest(requestId, undefined, Object.assign(new Error("本机操作已取消"), { name: "AbortError" }));
      const timer = setTimeout(() => this.#finishHostActionRequest(requestId, undefined, new Error("本机操作超时未响应")), timeoutMs);
      timer.unref();
      const pending: PendingHostActionRequest = {
        envId,
        request: scopedRequest,
        ...(peer?.ws ? { ws: peer.ws } : {}),
        controller,
        resolve,
        reject,
        timer,
        removeAbort: () => signal?.removeEventListener("abort", cancel),
      };
      this.#hostActionRequests.set(requestId, pending);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      if (pending.ws) {
        this.#sendControl(pending.ws, { type: "hub.host_action_request", requestId, request: scopedRequest });
      } else {
        const active = () => !this.#closed && this.#hostActionRequests.get(requestId) === pending && !controller.signal.aborted;
        void Promise.resolve().then(() => {
          if (!active()) throw new Error("本机操作已取消");
          return this.#localHostActions!.execute(scopedRequest, controller.signal);
        }).then((result) => {
          if (!active()) return;
          if (!isHostActionResult(result, scopedRequest)) this.#finishHostActionRequest(requestId, undefined, new Error("Invalid host action response"));
          else this.#finishHostActionRequest(requestId, result);
        }, (error: unknown) => {
          this.#finishHostActionRequest(
            requestId,
            undefined,
            error instanceof Error ? error : new Error("本机操作执行失败"),
          );
        });
      }
    });
  }

  #finishHostActionRequest(requestId: string, result?: HostActionResult, error?: Error): void {
    const pending = this.#hostActionRequests.get(requestId);
    if (!pending) return;
    this.#hostActionRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort();
    if (error) {
      pending.controller.abort();
      if (pending.ws && pending.ws.readyState === pending.ws.OPEN) {
        this.#sendControl(pending.ws, { type: "hub.host_action_cancel", requestId });
      }
      pending.reject(error);
    } else {
      pending.resolve(result!);
    }
  }

  #failHostActionRequests(envId: string, message: string): void {
    for (const [id, pending] of this.#hostActionRequests) {
      if (pending.envId === envId) this.#finishHostActionRequest(id, undefined, new Error(message));
    }
  }

  async closeComputerUseSession(envId: string, sessionId: string): Promise<void> {
    const descriptor = this.getEnvDescriptor(envId);
    if (!descriptor?.online || this.#closed) return;
    const tools = (["browser", "desktop"] as const).filter((tool) => descriptor.capabilities.includes(tool === "browser" ? "agent-browser" : "agent-desktop"));
    await Promise.all(tools.map((tool) => this.requestComputerUse(envId, { tool, action: "close", sessionId })));
  }

  subscribeComputerPreview(envId: string, target: ComputerPreviewTarget, listener: (update: ComputerPreviewUpdate) => void): () => void {
    if (this.#closed) throw new Error("Env manager is closed");
    if (!isComputerPreviewTarget(target)) throw new Error("Invalid computer preview target");
    const descriptor = this.getEnvDescriptor(envId);
    if (!descriptor?.online || descriptor.executionKind === "native-device" || !["darwin", "linux", "win32"].includes(descriptor.platform)) throw new Error("Computer preview device is unavailable");
    if (!descriptor.capabilities.includes(`agent-${target.tool}`)) throw new Error("Computer preview capability is disabled");
    if (this.#computerPreviews.size >= 16) throw new Error("Computer preview subscription limit reached");
    const peer = this.isLocalEnv(envId) ? undefined : this.#wsPeers.get(envId);
    if (this.isLocalEnv(envId) ? !this.#localComputer : !peer?.ws || peer.ws.readyState !== peer.ws.OPEN) throw new Error("Computer preview requires an authenticated Env connection");
    const lease = this.#deviceConnectionLeases.get(envId);
    if (peer && (this.#revokedDeviceIds.has(envId) || !this.#remoteConnectionsEnabled || lease !== undefined && !sameToken(peer.connectionLease, lease))) throw new Error("Computer preview device authorization changed");
    const subscriptionId = randomBytes(16).toString("hex");
    const preview: { envId: string; ws?: WebSocket; lease?: string; listener: (update: ComputerPreviewUpdate) => void; stop?: () => void } = { envId, ...(peer?.ws ? { ws: peer.ws, lease: peer.connectionLease } : {}), listener };
    this.#computerPreviews.set(subscriptionId, preview);
    try {
      if (preview.ws) this.#sendControl(preview.ws, { type: "hub.computer_preview_subscribe", subscriptionId, target });
      else preview.stop = this.#localComputer!.subscribePreview(target, (update) => {
        if (this.#computerPreviews.get(subscriptionId) === preview && isComputerPreviewUpdate(update)) listener(update);
      });
    } catch (error) {
      this.#endComputerPreview(subscriptionId);
      throw error;
    }
    return () => this.#endComputerPreview(subscriptionId);
  }

  sendComputerPreviewInput(envId: string, target: ComputerPreviewTarget, event: ComputerPreviewInputEvent): boolean {
    if (this.#closed || !isComputerPreviewTarget(target) || !isComputerPreviewInputEvent(event) || target.tool !== "browser") return false;
    const descriptor = this.getEnvDescriptor(envId);
    if (!descriptor?.online || !descriptor.capabilities.includes("agent-browser")) return false;
    if (this.isLocalEnv(envId)) return this.#localComputer?.sendPreviewInput(target, event) ?? false;
    const peer = this.#wsPeers.get(envId);
    const lease = this.#deviceConnectionLeases.get(envId);
    if (!peer?.ws || peer.ws.readyState !== peer.ws.OPEN || this.#revokedDeviceIds.has(envId) || !this.#remoteConnectionsEnabled || (lease !== undefined && !sameToken(peer.connectionLease, lease))) return false;
    try { this.#sendControl(peer.ws, { type: "hub.computer_preview_input", target, event }); return true; }
    catch { return false; }
  }

  #endComputerPreview(subscriptionId: string, update?: ComputerPreviewUpdate): void {
    const preview = this.#computerPreviews.get(subscriptionId);
    if (!preview) return;
    this.#computerPreviews.delete(subscriptionId);
    preview.stop?.();
    if (preview.ws && preview.ws.readyState === preview.ws.OPEN) this.#sendControl(preview.ws, { type: "hub.computer_preview_unsubscribe", subscriptionId });
    if (update) preview.listener(update);
  }

  #finishComputerRequest(requestId: string, result?: ComputerUseResult, error?: Error): void {
    const pending = this.#computerRequests.get(requestId);
    if (!pending) return;
    this.#computerRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort();
    if (error) {
      pending.controller.abort();
      if (pending.ws) {
        try { this.#sendControl(pending.ws, { type: "hub.computer_cancel", requestId }); }
        catch { /* The disconnected Env also cancels its in-flight operations. */ }
      }
      pending.reject(error);
    } else pending.resolve(result!);
  }

  #failComputerRequests(envId: string, message: string): void {
    for (const [id, preview] of this.#computerPreviews) {
      if (preview.envId === envId) this.#endComputerPreview(id, { state: "closed", message: "设备画面连接已断开" });
    }
    for (const [id, pending] of this.#computerRequests) {
      if (pending.envId === envId) this.#finishComputerRequest(id, undefined, new Error(message));
    }
  }

  #failBrowserRequests(envId: string, message: string): void {
    for (const [id, pending] of this.#browserRequests) {
      if (pending.envId !== envId) continue;
      clearTimeout(pending.timer); this.#browserRequests.delete(id); pending.reject(new Error(message));
    }
  }

  #failProjectRequests(envId: string, message: string): void {
    for (const [id, pending] of this.#projectRequests) {
      if (pending.envId !== envId) continue;
      clearTimeout(pending.timer); this.#projectRequests.delete(id); pending.reject(new Error(message));
    }
  }

  #assertPiEnv(envId: string): void {
    if (this.getEnvDescriptor(envId)?.executionKind === "native-device") {
      throw new Error(`Native device '${envId}' does not support Pi Env execution`);
    }
  }

  async listProjectDirectories(envId: string, directory?: string): Promise<ProjectDirectoryListing> {
    if (this.isLocalEnv(envId)) {
      if (!this.#localProjects) throw new Error("Local project environment is not enabled");
      return { ...this.#localProjects.list(directory), deviceId: this.#localEnvId };
    }
    const result = await this.#projectRequest(envId, { action: "list", ...(directory ? { path: directory } : {}) });
    if (!("entries" in result) || result.deviceId !== envId || !Array.isArray(result.entries)) throw new Error("Project device returned an invalid directory list");
    return result;
  }

  async authorizeProjectDirectory(envId: string, input: AuthorizeDirectoryInput): Promise<ProjectDirectoryGrant> {
    if (this.isLocalEnv(envId)) {
      if (!this.#localProjects) throw new Error("Local project environment is not enabled");
      const grant = this.#localProjects.authorize(input);
      this.#revokedProjects.delete(JSON.stringify([envId, input.projectId]));
      return grant;
    }
    const result = await this.#projectRequest(envId, { action: "authorize", ...input });
    if (!("directoryId" in result) || result.projectId !== input.projectId || !result.workspaceDir || !Number.isSafeInteger(result.revision)) throw new Error("Project device returned an invalid directory grant");
    this.#revokedProjects.delete(JSON.stringify([envId, input.projectId]));
    return result;
  }

  async prepareStagedWorkspace(
    envId: string,
    input: { taskId: string; projectId: string; sourceDir: string; directoryId?: string; grantRevision?: number; fresh?: boolean },
  ): Promise<StagedWorkspacePrepareResult> {
    this.#assertPiEnv(envId);
    if (this.isLocalEnv(envId)) {
      if (!this.#localStagedWorkspaces) throw new Error("Local staged workspace service is not enabled");
      return this.#localStagedWorkspaces.prepare(input);
    }
    const result = await this.#projectRequest(envId, { action: "staged_prepare", ...input });
    if (!("stagedCwd" in result) || typeof result.stagedCwd !== "string") {
      throw new Error("Project device returned an invalid staged prepare result");
    }
    return result;
  }

  async inspectStagedWorkspaceDiff(
    envId: string,
    taskId: string,
    filePath?: string,
  ): Promise<StagedWorkspaceDiffDetail> {
    this.#assertPiEnv(envId);
    if (this.isLocalEnv(envId)) {
      if (!this.#localStagedWorkspaces) throw new Error("Local staged workspace service is not enabled");
      return this.#localStagedWorkspaces.diff(taskId, filePath);
    }
    const result = await this.#projectRequest(envId, {
      action: "staged_diff",
      taskId,
      ...(filePath?.trim() ? { filePath: filePath.trim() } : {}),
    });
    if (!("diff" in result) || typeof result.diff !== "string") {
      throw new Error("Project device returned an invalid staged diff result");
    }
    return result;
  }

  async applyStagedWorkspaceChanges(
    envId: string,
    input: { taskId: string; projectId: string; directoryId?: string; grantRevision?: number; paths?: string[]; allowConflicts?: boolean },
  ): Promise<StagedWorkspaceApplyResult> {
    this.#assertPiEnv(envId);
    if (this.isLocalEnv(envId)) {
      if (!this.#localStagedWorkspaces) throw new Error("Local staged workspace service is not enabled");
      return this.#localStagedWorkspaces.apply(input);
    }
    const result = await this.#projectRequest(envId, { action: "staged_apply", ...input });
    if (!("cleanedUp" in result) || typeof result.cleanedUp !== "boolean") {
      throw new Error("Project device returned an invalid staged apply result");
    }
    return result;
  }

  async discardStagedWorkspace(
    envId: string,
    taskId: string,
    projectId?: string,
  ): Promise<{ discarded: boolean }> {
    this.#assertPiEnv(envId);
    if (this.isLocalEnv(envId)) {
      if (!this.#localStagedWorkspaces) return { discarded: false };
      return this.#localStagedWorkspaces.discard(taskId, projectId);
    }
    const result = await this.#projectRequest(envId, {
      action: "staged_discard",
      taskId,
      ...(projectId ? { projectId } : {}),
    });
    if (!("discarded" in result) || typeof result.discarded !== "boolean") {
      throw new Error("Project device returned an invalid staged discard result");
    }
    return result;
  }

  async revokeProjectDirectory(envId: string, projectId: string): Promise<{ cleanupPending: boolean }> {
    this.#assertPiEnv(envId);
    this.#revokedProjects.add(JSON.stringify([envId, projectId]));
    if (this.isLocalEnv(envId)) {
      this.#localProjects?.revoke(projectId);
      this.#localStagedWorkspaces?.discardProject(projectId);
      const externalPending = await this.#localExternalAgents?.stopProject(projectId);
      const entries = [...this.#workerConnections.values()].filter((entry) => entry.envId === envId && entry.projectId === projectId);
      const results = await Promise.all(entries.map((entry) => this.releaseWorkerExecutionEnv(envId, entry.cwd)));
      const recordedPending = this.#localProjects ? await cleanupRecordedExecutions(path.join(this.#localProjects.privateDirectory, "executions"), { projectId }) : false;
      return { cleanupPending: externalPending || results.some((result) => result.cleanupPending) || recordedPending };
    }
    let ids = this.#pendingRevocations.get(envId);
    if (!ids) this.#pendingRevocations.set(envId, ids = new Set());
    ids.add(projectId);
    const peer = this.#wsPeers.get(envId);
    if (!peer || peer.connectionState !== "online" || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) {
      if (peer) {
        for (const [streamId, stream] of [...peer.streams]) {
          if (stream.projectId === projectId) {
            peer.pendingCloseStreamIds.add(streamId);
            this.#abortSingleStream(peer, streamId, "Project execution revoked during disconnect");
          }
        }
      }
      return { cleanupPending: true };
    }
    const result = await this.#projectRequest(envId, { action: "revoke", projectId });
    if (!("cleanupPending" in result) || typeof result.cleanupPending !== "boolean") throw new Error("Invalid project revocation response");
    if (!result.cleanupPending) ids.delete(projectId);
    return result;
  }

  #executionContext(): BridgeExecutionContext {
    return {
      closed: this.#closed,
      localEnvId: this.#localEnvId,
      localDescriptor: this.#localDescriptor ?? undefined,
      localConnection: this.#localConnection,
      localProjects: this.#localProjects,
      localStagedWorkspaces: this.#localStagedWorkspaces,
      bridgePort: this.#bridgePort,
      bridgeSecret: this.#bridgeSecret,
      stdioRelayPath: STDIO_RELAY_PATH,
      workerEnvIds: this.#options.workerEnvIds,
      workerNetwork: this.#options.workerNetwork,
      deviceTokens: this.#deviceTokens,
      revokedProjects: this.#revokedProjects,
      workerConnections: this.#workerConnections,
      retiredWorkerConnections: this.#retiredWorkerConnections,
      cleanupTasks: this.#cleanupTasks,
      executionTrustMode: this.#executionTrustMode,
      isLocalEnv: (id) => this.isLocalEnv(id),
      assertPiEnv: (id) => this.#assertPiEnv(id),
      getEnvDescriptor: (id) => this.getEnvDescriptor(id),
      hasWsPeer: (id) => this.#wsPeers.has(id),
      getWsPeerDescriptor: (id) => this.#wsPeers.get(id)?.descriptor,
      getWsPeerConnection: (id, mode) => {
        const peer = this.#wsPeers.get(id);
        if (!peer) return null;
        if (!hasTrustedHostExecutionCapability(peer.descriptor.capabilities)) return peer.connection;
        let conn = peer.connectionsByMode.get(mode);
        if (!conn) {
          conn = new Connection({
            command: [
              process.execPath,
              STDIO_RELAY_PATH,
              String(this.#bridgePort),
              id,
              this.#bridgeSecret,
              JSON.stringify({ executionMode: mode }),
            ],
          });
          peer.connectionsByMode.set(mode, conn);
        }
        return conn;
      },
      getSshPeerConnection: (id) => this.#sshPeers.get(id)?.connection ?? null,
      getSandboxProtectedPaths: () => [...new Set([...(this.#options.getProtectedPaths?.() ?? []), ...this.#additionalProtectedPaths])],
      getCoreProtectedPaths: () => [...new Set([...(this.#options.getCoreProtectedPaths?.() ?? []), ...this.#additionalProtectedPaths])],
      getBlockedEnvNames: () => this.#options.getBlockedEnvNames?.() ?? [],
      abortRemoteStreams: (id, cwd, scratchDir, executionKey) => {
        const peer = this.#wsPeers.get(id);
        if (!peer || peer.connectionState !== "online" || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) {
          if (peer) {
            for (const [streamId, stream] of [...peer.streams]) {
              if (
                stream.workspaceDir === cwd &&
                (!scratchDir || stream.scratchDir === scratchDir) &&
                (!executionKey || stream.executionKey === executionKey)
              ) {
                peer.pendingCloseStreamIds.add(streamId);
                this.#abortSingleStream(peer, streamId, "Worker stopped during disconnect");
              }
            }
          }
          return true;
        }
        return false;
      },
      requestRemoteCleanup: async (id, cwd, scratchDir, executionKey) => {
        const peer = this.#wsPeers.get(id);
        const supportsKey = Boolean(peer && hasTrustedHostExecutionCapability(peer.descriptor.capabilities));
        const result = await this.#projectRequest(id, {
          action: "cleanup",
          workspaceDir: cwd,
          ...(scratchDir ? { scratchDir } : {}),
          ...(supportsKey && executionKey ? { executionKey } : {}),
        });
        if (!("cleanupPending" in result) || typeof result.cleanupPending !== "boolean") throw new Error("Invalid Worker cleanup response");
        return { cleanupPending: result.cleanupPending };
      },
    };
  }

  async releaseWorkerExecutionEnv(
    envId: string,
    cwd: string,
    options?: { scratchDir?: string; executionMode?: ExecutionTrustMode; executionKey?: string },
  ): Promise<{ cleanupPending: boolean }> {
    return releaseBridgeWorkerEnv(this.#executionContext(), envId, cwd, options);
  }

  listEnvs(): EnvNodeDescriptor[] {
    const result: EnvNodeDescriptor[] = [];
    if (this.#localDescriptor) {
      result.push(this.#displayDescriptor(this.#localDescriptor));
    }
    for (const peer of this.#wsPeers.values()) {
      result.push(this.#displayDescriptor(peer.descriptor));
    }
    for (const ssh of this.#sshPeers.values()) {
      result.push(this.#displayDescriptor(ssh.descriptor));
    }
    return result;
  }

  /** Look up one environment descriptor by ID. */
  getEnvDescriptor(envId: string): EnvNodeDescriptor | undefined {
    if (this.isLocalEnv(envId) && this.#localDescriptor) {
      return this.#displayDescriptor(this.#localDescriptor);
    }
    const wsPeer = this.#wsPeers.get(envId);
    if (wsPeer) return this.#displayDescriptor(wsPeer.descriptor);
    const sshPeer = this.#sshPeers.get(envId);
    if (sshPeer) return this.#displayDescriptor(sshPeer.descriptor);
    return undefined;
  }

  /** Display aliases do not change node identity or its self-reported system name. */
  setDeviceDisplayName(id: string, name: string | undefined): void {
    const resolvedId = id === "local" ? this.#localEnvId : id;
    if (this.#deviceDisplayNames.get(resolvedId) === name) return;
    if (name === undefined) this.#deviceDisplayNames.delete(resolvedId);
    else this.#deviceDisplayNames.set(resolvedId, name);
    this.#notifyChange();
  }

  #displayDescriptor(descriptor: EnvNodeDescriptor): EnvNodeDescriptor {
    return { ...descriptor, name: this.#deviceDisplayNames.get(descriptor.id) ?? descriptor.name };
  }

  /** Pick default environment ID when dispatch omits `envId`: prefer active remote if local disabled, else local envId or first online. */
  pickDefaultEnvId(): string {
    if (this.#localDescriptor?.online) return this.#localEnvId;
    for (const peer of this.#wsPeers.values()) {
      if (peer.descriptor.online && peer.descriptor.executionKind !== "native-device") return peer.descriptor.id;
    }
    for (const ssh of this.#sshPeers.values()) {
      if (ssh.descriptor.online) return ssh.descriptor.id;
    }
    if (this.#localDescriptor) return this.#localEnvId;
    for (const peer of this.#wsPeers.values()) {
      if (peer.descriptor.executionKind !== "native-device") return peer.descriptor.id;
    }
    throw new Error("No execution environment (kulo-env) is currently registered with Hub");
  }

  pickDefaultWorkerEnvId(): string {
    return pickBridgeDefaultWorkerEnvId(this.#executionContext());
  }

  /** Create a Worker `ExecutionEnv` bound to `envId`, `cwd`, and the negotiated execution trust mode. */
  createWorkerExecutionEnv(envId: string, cwd: string, options: WorkerExecutionOptions = {}): ExecutionEnv {
    return createBridgeWorkerExecutionEnv(this.#executionContext(), envId, cwd, options);
  }

  invalidateWorkerEnvironments(): void {
    invalidateAllWorkerConnections(this.#workerConnections, this.#cleanupTasks, undefined, this.#retiredWorkerConnections);
  }

  protectPaths(paths: readonly string[]): void {
    const canonicalPaths = paths.map(canonicalExecutionPath);
    let changed = false;
    for (const protectedPath of canonicalPaths) {
      if (this.#additionalProtectedPaths.has(protectedPath)) continue;
      this.#additionalProtectedPaths.add(protectedPath);
      changed = true;
    }
    if (changed) {
      invalidateAllWorkerConnections(this.#workerConnections, this.#cleanupTasks, (entry) => entry.executionMode === "sandboxed", this.#retiredWorkerConnections);
      this.retireIdleWorkerEnvironments();
    }
  }

  /** Build a `Pi Durable` `ExecutionEnv` bound to `envId` and `cwd`. */
  createExecutionEnv(
    envId: string,
    cwd: string,
    options?: { sandboxed?: boolean; readOnly?: boolean; offline?: boolean; executionMode?: ExecutionTrustMode },
  ): ExecutionEnv {
    return createBridgeExecutionEnv(this.#executionContext(), envId, cwd, options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of this.#computerPreviews.keys()) this.#endComputerPreview(id, { state: "closed" });
    this.#deviceConnectionLeases.clear();
    this.setAndroidNotificationClassifier(undefined);
    this.setConnectorHandlers(undefined);
    this.#localNotificationSensor?.close();
    this.#localNotificationSensor = null;
    for (const id of this.#androidRequests.keys()) this.#finishAndroidRequest(id, undefined, new Error("Env manager closed before Android operation completed"));
    for (const id of this.#androidControls.keys()) this.#finishAndroidControl(id, undefined, new Error("Env manager closed before Android stop was confirmed"));
    for (const id of this.#computerRequests.keys()) this.#finishComputerRequest(id, undefined, new Error("Env manager closed before computer-use operation completed"));
    for (const id of this.#hostActionRequests.keys()) this.#finishHostActionRequest(id, undefined, new Error("Env manager closed before host action completed"));
    for (const pending of this.#browserRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Env manager closed before browser operation completed")); }
    this.#browserRequests.clear();
    for (const pending of [...this.#externalAgentRequests.values()]) { pending.finish(); pending.reject(new Error("Env manager closed; inspect existing external runs before retrying")); }
    for (const [id, pending] of [...this.#connectorCalls.entries()]) {
      clearTimeout(pending.timer);
      this.#connectorCalls.delete(id);
      pending.resolve({ ok: false, code: "env_manager_closed", error: "Env manager closed" });
    }
    const browserCleanup = Promise.allSettled([this.#localBrowser?.close(), this.#localComputer?.close(), this.#localHostActions?.suspend(), this.#localExternalAgents?.close()]);
    this.invalidateWorkerEnvironments();
    await Promise.all(this.#cleanupTasks);
    for (const [id, pending] of this.#projectRequests) {
      clearTimeout(pending.timer);
      this.#projectRequests.delete(id);
      pending.reject(new Error("Env manager closed before project operation completed"));
    }
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    this.#localConnection?.close();
    this.#localConnection = null;

    for (const peer of this.#wsPeers.values()) {
      if (peer.graceTimer) {
        clearTimeout(peer.graceTimer);
        peer.graceTimer = undefined;
      }
      peer.connectionState = "offline";
      peer.descriptor.online = false;
      peer.connection?.close();
      for (const conn of peer.connectionsByMode.values()) conn.close();
      peer.connectionsByMode.clear();
      this.#failAllStreams(peer, "Hub shutting down");
      if (peer.ws) {
        try {
          peer.ws.close(1001, "Hub shutting down");
        } catch {
          // ignore
        }
      }
    }
    for (const ssh of this.#sshPeers.values()) {
      ssh.connection.close();
    }
    if (this.#bridgeServer) {
      const srv = this.#bridgeServer;
      this.#bridgeServer = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    if ((await browserCleanup).some((result) => result.status === "rejected")) throw new Error("Some owned browser or desktop sessions could not close");
  }

  #handleRelaySocket(tcpSocket: net.Socket): void {
    let headerBuf = Buffer.alloc(0);
    let attachedPeer: RemoteWsPeer | null = null;
    let attachedStreamId = 0;

    const onData = (chunk: Buffer) => {
      if (attachedPeer) {
        const stream = attachedPeer.streams.get(attachedStreamId);
        if (!stream || attachedPeer.descriptor.executionKind === "native-device") {
          tcpSocket.destroy();
          return;
        }
        this.#sendStreamPayload(attachedPeer, stream, chunk);
        return;
      }

      headerBuf = Buffer.concat([headerBuf, chunk]);
      const nl = headerBuf.indexOf(0x0a);
      if (nl === -1) {
        if (headerBuf.byteLength > 4096) {
          tcpSocket.destroy();
        }
        return;
      }

      const line = headerBuf.subarray(0, nl).toString("utf8");
      const remainder = headerBuf.subarray(nl + 1);
      headerBuf = Buffer.alloc(0);

      let parsed: { envId?: string; secret?: string; daemonToken?: string; projectId?: string; grantRevision?: number; stagedTaskId?: string; readOnly?: boolean; workspaceDir?: string; scratchDir?: string; protectedPaths?: string[]; network?: { localConnectPorts?: number[]; localListenPorts?: number[]; offline?: boolean }; executionMode?: ExecutionTrustMode; executionKey?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        tcpSocket.end("ERR:Malformed handshake\n");
        return;
      }

      if (parsed.secret !== this.#bridgeSecret || !parsed.envId || !parsed.daemonToken) {
        tcpSocket.end("ERR:Unauthorized relay handshake\n");
        return;
      }

      const peer = this.#wsPeers.get(parsed.envId);
      if (!peer || !peer.ws || peer.ws.readyState !== peer.ws.OPEN) {
        tcpSocket.end(`ERR:Env '${parsed.envId}' is offline\n`);
        return;
      }
      if (peer.descriptor.executionKind === "native-device") {
        tcpSocket.end("ERR:Native device does not support Pi Env execution\n");
        return;
      }

      const streamId = peer.nextStreamId++;
      attachedPeer = peer;
      attachedStreamId = streamId;

      const readyTimer = setTimeout(() => {
        peer.streams.delete(streamId);
        tcpSocket.end("ERR:Timed out waiting for remote pi-env daemon ready\n");
      }, 15_000);
      readyTimer.unref();

      const streamEntry: ActiveStream = {
        streamId,
        tcpSocket,
        ready: false,
        readyTimer,
        workspaceDir: parsed.workspaceDir,
        scratchDir: parsed.scratchDir,
        projectId: parsed.projectId,
        executionKey: parsed.executionKey,
        ...(peer.streamResumeSupported ? { resumeBuffer: new StreamResumeBuffer() } : {}),
      };
      peer.streams.set(streamId, streamEntry);

      const supportsTrusted = hasTrustedHostExecutionCapability(peer.descriptor.capabilities);
      const forwardExecutionMode =
        (parsed.executionMode === "trusted" || parsed.executionMode === "sandboxed") && supportsTrusted
          ? parsed.executionMode
          : undefined;
      this.#sendControl(peer.ws, {
        type: "hub.open_stream",
        streamId,
        daemonToken: parsed.daemonToken,
        ...(parsed.projectId ? { projectId: parsed.projectId, grantRevision: parsed.grantRevision } : {}),
        ...(parsed.stagedTaskId ? { stagedTaskId: parsed.stagedTaskId } : {}),
        ...(parsed.readOnly !== undefined ? { readOnly: parsed.readOnly } : {}),
        ...(parsed.workspaceDir ? { workspaceDir: parsed.workspaceDir } : {}),
        ...(parsed.scratchDir ? { scratchDir: parsed.scratchDir } : {}),
        ...(parsed.protectedPaths ? { protectedPaths: parsed.protectedPaths } : {}),
        ...(parsed.network ? { network: parsed.network } : {}),
        ...(forwardExecutionMode ? { executionMode: forwardExecutionMode } : {}),
        ...(supportsTrusted && parsed.executionKey ? { executionKey: parsed.executionKey } : {}),
      });

      if (remainder.byteLength > 0) {
        // Queue any trailing stdin bytes once stream is ready
        const checkForward = () => {
          const liveStream = peer.streams.get(streamId);
          if (liveStream && peer.descriptor.executionKind !== "native-device") {
            this.#sendStreamPayload(peer, liveStream, remainder);
          }
        };
        setImmediate(checkForward);
      }
    };

    tcpSocket.on("data", onData);

    const cleanup = () => {
      if (attachedPeer && attachedStreamId) {
        const existing = attachedPeer.streams.get(attachedStreamId);
        if (existing) {
          clearTimeout(existing.readyTimer);
          if (existing.ackTimer) clearTimeout(existing.ackTimer);
          if (existing.resumeBuffer) {
            attachedPeer.unackedTotalBytes = Math.max(0, attachedPeer.unackedTotalBytes - existing.resumeBuffer.clear());
          }
          attachedPeer.streams.delete(attachedStreamId);
          if (attachedPeer.ws && attachedPeer.ws.readyState === attachedPeer.ws.OPEN) {
            this.#sendControl(attachedPeer.ws, {
              type: "hub.close_stream",
              streamId: attachedStreamId,
            });
          } else if (attachedPeer.connectionState === "reconnecting") {
            attachedPeer.pendingCloseStreamIds.add(attachedStreamId);
          }
        }
      }
    };

    tcpSocket.on("close", cleanup);
    tcpSocket.on("error", cleanup);
  }

  #sendStreamPayload(peer: RemoteWsPeer, stream: ActiveStream, chunk: Buffer): void {
    if (peer.streamResumeSupported && stream.resumeBuffer) {
      const enqueued = stream.resumeBuffer.enqueueOutgoing(chunk, peer.unackedTotalBytes);
      if (!enqueued.ok) {
        this.#abortSingleStream(peer, stream.streamId, "Stream unacked buffer exceeded limit");
        return;
      }
      peer.unackedTotalBytes += enqueued.payload.byteLength;
      if (peer.ws && peer.ws.readyState === peer.ws.OPEN) {
        peer.ws.send(encodeSequencedStreamChunk(stream.streamId, enqueued.seq, enqueued.payload));
      } else if (!stream.pausedForDisconnect && !stream.tcpSocket.destroyed) {
        stream.tcpSocket.pause();
        stream.pausedForDisconnect = true;
      }
    } else if (peer.ws && peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(encodeStreamChunk(stream.streamId, chunk));
    }
  }

  #scheduleStreamAck(peer: RemoteWsPeer, stream: ActiveStream, immediate: boolean): void {
    if (!stream.resumeBuffer) return;
    const flush = () => {
      if (stream.ackTimer) {
        clearTimeout(stream.ackTimer);
        stream.ackTimer = undefined;
      }
      if (!stream.resumeBuffer?.needsAck()) return;
      if (peer.ws && peer.ws.readyState === peer.ws.OPEN) {
        this.#sendControl(peer.ws, {
          type: "hub.stream_ack",
          streamId: stream.streamId,
          rxSeq: stream.resumeBuffer.rxSeq,
        });
        stream.resumeBuffer.markAckSent();
      }
    };
    if (immediate) {
      flush();
    } else if (!stream.ackTimer) {
      stream.ackTimer = setTimeout(flush, 400);
      stream.ackTimer.unref();
    }
  }

  #abortSingleStream(peer: RemoteWsPeer, streamId: number, reason: string): void {
    const stream = peer.streams.get(streamId);
    if (!stream) return;
    clearTimeout(stream.readyTimer);
    if (stream.ackTimer) clearTimeout(stream.ackTimer);
    if (stream.resumeBuffer) {
      peer.unackedTotalBytes = Math.max(0, peer.unackedTotalBytes - stream.resumeBuffer.clear());
    }
    peer.streams.delete(streamId);
    if (!stream.ready) stream.tcpSocket.end(`ERR:${reason}\n`);
    else stream.tcpSocket.destroy();
    if (peer.ws && peer.ws.readyState === peer.ws.OPEN) {
      this.#sendControl(peer.ws, { type: "hub.close_stream", streamId });
    }
  }

  #expirePeerGrace(envId: string, peer: RemoteWsPeer): void {
    if (this.#wsPeers.get(envId) !== peer || peer.connectionState !== "reconnecting") return;
    peer.graceTimer = undefined;
    peer.connectionState = "offline";
    peer.descriptor.online = false;
    this.#failAllStreams(peer, "Env reconnect grace period expired");
    this.#notifyChange();
  }

  #failAllStreams(peer: RemoteWsPeer, reason: string): void {
    for (const stream of peer.streams.values()) {
      clearTimeout(stream.readyTimer);
      if (stream.ackTimer) clearTimeout(stream.ackTimer);
      if (stream.resumeBuffer) {
        peer.unackedTotalBytes = Math.max(0, peer.unackedTotalBytes - stream.resumeBuffer.clear());
      }
      if (!stream.ready) {
        stream.tcpSocket.end(`ERR:${reason}\n`);
      } else {
        stream.tcpSocket.destroy();
      }
    }
    peer.streams.clear();
    peer.unackedTotalBytes = 0;
  }

  #sendControl(ws: WebSocket, msg: HubToEnvControlMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  #notifyChange(): void {
    this.#options.onChange?.(this.listEnvs());
  }
}
