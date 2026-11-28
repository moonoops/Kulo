import type { ChatAttachment } from "./domain.js";
import type { OverflowReportAsset, TicketSubagentSummary } from "./task-boards.js";

export type TicketStatus =
  | "queued"
  | "running"
  | "pausing"
  | "waiting"
  | "blocked"
  | "ready"
  | "failed"
  | "stopped"
  | "closed";

export type TicketClosureKind = "obsolete" | "superseded";

export type WorkerReportState = "progress" | "blocked" | "ready" | "failed";

export interface WorkerReportRecord {
  state: WorkerReportState;
  summary: string;
  deliverable?: string;
  /** Privately staged artifacts awaiting the main Agent's review; these are not chat publications. */
  attachments?: ChatAttachment[];
  /** System overflow slot when deliverable exceeds the ingress bound; internal review only (never published directly). */
  overflowAsset?: OverflowReportAsset;
  /** Recorded when a read-only external agent mutated files via native tools/shell. */
  readOnlyViolation?: import("./external-agents.js").ReadOnlyViolationSummary;
  question?: string;
  /** Optional structured choice suggestions when reporting state='blocked'. */
  options?: string[];
  at: number;
}

export interface TicketClosureRecord {
  kind: TicketClosureKind;
  reason: string;
  replacementTicketId?: string;
  at: number;
}

export interface TicketRecoveryRecord {
  state: "recovering" | "exhausted";
  attempts: number;
  startedAt: number;
  deadlineAt: number;
  nextAttemptAt?: number;
  lastError?: string;
  notifiedAt?: number;
  /** Shared budget owner when a replacement continues an earlier attempt. */
  rootTicketId?: string;
}

export interface TicketSchedule {
  executeAt: number;
  repeatEverySeconds?: number;
  nextRunAt: number | null;
  deletedAt?: number;
}

export type TicketEnvBinding =
  | "project"
  | "workspace_dir"
  | "topic_target"
  | "message_target"
  | "message_named"
  | "agent_bound"
  | "sender_local"
  | "hub_local"
  | "pool_fallback";

export type DispatchTargetScope = "hub_local" | "sender_device";

export interface TicketWorkspaceStaging {
  mode: import("./external-agents.js").ExternalWorkspaceMode;
  stagedCwd?: string;
  stagedDiff?: import("./external-agents.js").StagedWorkspaceDiffSummary;
  appliedAt?: number;
  appliedDigest?: string;
  discardedAt?: number;
  warnings?: string[];
}

export interface TicketOutwardAction {
  runEpoch: number;
  kind: "connection" | "media" | "voice" | "shell" | "host_action" | "external_bash";
  label: string;
  at: number;
}

export interface InheritedBrowserSession {
  envId: string;
  sessionId: string;
}

export type TicketQuotaPauseKind =
  | "provider_quota"
  | "external_quota"
  | "rate_limit_exhausted"
  | "usage_cap";

export interface TicketQuotaPause {
  kind: TicketQuotaPauseKind;
  provider?: string;
  modelId?: string;
  externalClientId?: string;
  /** Sanitized via connectionManager.redact(redactSecrets(...)) and <= 240 chars. */
  errorMessage: string;
  pausedAt: number;
  resetsAt?: number;
}

export type TicketRunHealthStuckKind = "doom_loop" | "judge_stuck";

export interface TicketRunHealthStuck {
  kind: TicketRunHealthStuckKind;
  /** Sanitized via connectionManager.redact(redactSecrets(...)) and <= 240 chars. */
  reason: string;
  at: number;
}

export interface TicketModelEscalation {
  runEpoch: number;
  activatedAtTurn: number;
  escalatedModel: {
    provider?: string;
    modelId: string;
    thinkingLevel?: import("./domain.js").RoleThinkingEffort;
  };
  /** Sanitized via connectionManager.redact(redactSecrets(...)) and <= 240 chars. */
  reason: string;
}

export interface TicketResumeOverrideRequest {
  commandId?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: import("./domain.js").RoleThinkingEffort;
  note?: string;
}

export interface TicketResumeOverrideResponse {
  ticket: TicketCardView;
  resumed: boolean;
  warning?: string;
}

export interface TicketRecord {
  id: string;
  commandId: string;
  title: string;
  userSummary?: string;
  goal: string;
  scope: string;
  acceptance?: string;
  assignment?: string;
  contextSummary?: string;
  inputAttachmentIds?: string[];
  role: string;
  providerOverride?: string;
  modelOverride?: string;
  thinkingOverride?: import("./domain.js").RoleThinkingEffort;
  modelEscalation?: TicketModelEscalation;
  quotaPause?: TicketQuotaPause;
  runHealthStuck?: TicketRunHealthStuck;
  status: TicketStatus;
  envId: string;
  /** Authoritative binding category for `envId`; undefined on legacy tickets defaults to locked. */
  envBinding?: TicketEnvBinding;
  /** Set once the Worker uses device-local GUI/browser tools (`kulo_browser` / `kulo_desktop`). */
  deviceStateTouched?: boolean;
  /** Managed browser session transferred from Orchestrator chat on dispatch (durable across Hub restarts). */
  inheritedBrowserSession?: InheritedBrowserSession;
  /** Authenticated message sender metadata when dispatched from a paired device. */
  senderSource?: { deviceId: string; name: string };
  executionDomain?: "computer" | "android";
  androidDeviceIds?: string[];
  workspaceDir: string;
  scratchDir?: string;
  readOnly?: boolean;
  workerConversationId: number;
  workspaceStaging?: TicketWorkspaceStaging;
  externalExecution?: import("./external-agents.js").ExternalTicketExecution;
  agentAssignment?: import("./agent-routing.js").AgentAssignment;
  parentTicketId?: string;
  activeTaskId?: number;
  runEpoch: number;
  createdAt: number;
  updatedAt: number;
  startedRunningAt?: number;
  /** Settled execution segments; add the current running/pausing segment separately. */
  accumulatedRunningMs?: number;
  completedAt?: number;
  latestReport?: WorkerReportRecord;
  stoppedReason?: string;
  closure?: TicketClosureRecord;
  recovery?: TicketRecoveryRecord;
  /** A user dismissed the recovery lineage while this alternative was still running. */
  autoRecoverySuppressed?: boolean;
  /** Real harness-recorded outward side effects (never model text) used to block blind auto-retry. */
  outwardActions?: TicketOutwardAction[];
  supersedes?: string[];
  originTopicId?: string; originConversationId?: number;
  finalRelayPending?: boolean;
  projectId?: string;
  projectRevision?: number;
  directoryId?: string;
  grantRevision?: number;
  waiting?: import("./projects.js").TicketWait;
  queuedAt?: number;
  cleanupPending?: boolean;
  resumePrompt?: string;
  wakePending?: boolean;
  resumeAttachmentIds?: string[];
  /** Connection IDs authorized by the main model for this ticket; never secret values. */
  connectionIds?: string[];
  connectionRevisions?: Record<string, number>;
  schedule?: TicketSchedule;
  /** Durable single-delivery CAS state for A2-lite inline dispatch fast lane. */
  deliveryClaim?: "inline_waiting" | "claimed_inline" | "escalated";
  inlineResult?: {
    state: WorkerReportRecord["state"]; summary: string; deliverable?: string | null;
    sources?: import("./search.js").WebSource[];
    stagedDiff?: import("./external-agents.js").StagedWorkspaceDiffSummary;
    stagedAssets?: Array<{ id: string; name: string; mimeType: string }>;
  };
  /** Optional TaskBoard ID linking multi-ticket collaborative work. */
  boardId?: string;
  /** Optional upstream ticket ID reviewed in read-only mode by this ticket. */
  reviewTicketId?: string;
}

export interface TicketCardView {
  externalAgentKind?: import("./external-agents.js").ExternalAgentKind;
  externalClientId?: string;
  externalModelId?: string;
  providerOverride?: string;
  modelOverride?: string;
  thinkingOverride?: import("./domain.js").RoleThinkingEffort;
  quotaPause?: TicketQuotaPause;
  runHealthStuck?: TicketRunHealthStuck;
  pendingWorkspaceApply?: boolean;
  subagentSummary?: TicketSubagentSummary;
  boardId?: string;
  reviewTicketId?: string;
  id: string;
  title: string;
  userSummary?: string;
  role: string;
  roleLabel: string;
  status: TicketStatus;
  envId: string;
  executionDomain?: "computer" | "android";
  androidDeviceIds?: string[];
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
  startedRunningAt?: number;
  accumulatedRunningMs?: number;
  completedAt?: number;
  queuedAt?: number;
  latestReport?: WorkerReportRecord;
  stoppedReason?: string;
  closure?: TicketClosureRecord;
  recovery?: TicketRecoveryRecord;
  supersedes?: string[];
  originTopicId?: string;
  projectId?: string;
  waiting?: import("./projects.js").TicketWait;
  cleanupPending?: boolean;
  schedule?: TicketSchedule;
}
