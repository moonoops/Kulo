export const EXTERNAL_AGENT_KINDS = ["codex", "claude-code", "antigravity", "dsh", "grok-bot", "dots", "muse"] as const;
export type ExternalAgentKind = typeof EXTERNAL_AGENT_KINDS[number];

export const EXTERNAL_AGENT_MCP_TOOL_NAMES = [
  "moco_task_context",
  "moco_task_report",
  "moco_agents",
  "moco_request_collaboration",
  "moco_child_task",
  "moco_memory_recall",
  "moco_memory_search_pages",
  "moco_memory_read_page",
  "moco_memory_ingest",
  "moco_memory_reflect",
  "moco_connections",
  "moco_connection_use",
] as const;
export type ExternalAgentMcpToolName = typeof EXTERNAL_AGENT_MCP_TOOL_NAMES[number];

export type WorkerExecutionPhase =
  | "starting"
  | "investigating"
  | "editing"
  | "verifying"
  | "responding"
  | "waiting_permission";

export type ExternalAgentUncertainReason = "timeout" | "disconnect" | "env_restart" | "closed";

export interface ReadOnlyViolationSummary {
  mutatedPaths: string[];
  totalCount: number;
  discardedFromClone: boolean;
}

export interface ExternalAgentCapabilities {
  resume: boolean;
  cancel: boolean;
  models: boolean;
  permissions: boolean;
  collaboration: boolean;
  terminalEvidence: "native" | "observed" | "none";
}

export interface ExternalAgentBinding {
  kind: ExternalAgentKind;
  envId: string;
  executable?: string;
  agentRef?: string;
  cdpUrl?: string;
  experimental?: boolean;
  version?: string;
  verifiedAt?: number;
  capabilities?: ExternalAgentCapabilities;
}

export interface ExternalAgentCatalogItem {
  kind: ExternalAgentKind;
  label: string;
  status: "supported" | "experimental" | "reserved";
  guide: string;
  instructions: string;
}

export interface ExternalAgentModelInfo {
  id: string;
  name: string;
  efforts?: string[];
  isDefault?: boolean;
}

export interface ExternalClientConnection {
  id: string;
  kind: ExternalAgentKind;
  envId: string;
  label?: string;
  executable?: string;
  agentRef?: string;
  cdpUrl?: string;
  experimental?: boolean;
  version?: string;
  verifiedAt?: number;
  capabilities?: ExternalAgentCapabilities;
  models: ExternalAgentModelInfo[];
  updatedAt: number;
}

export function externalClientConnectionId(binding: Pick<ExternalAgentBinding, "kind" | "envId" | "agentRef">): string {
  const ref = typeof binding.agentRef === "string" ? binding.agentRef.trim() : "";
  const raw = ref ? `${binding.kind}:${binding.envId}:${ref}` : `${binding.kind}:${binding.envId}`;
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 180);
}

export interface ExternalAgentDetection {
  kind: ExternalAgentKind;
  installed: boolean;
  executable?: string;
  version?: string;
  authenticated: boolean | null;
  models: ExternalAgentModelInfo[];
  capabilities: ExternalAgentCapabilities;
  error?: string;
}

export interface ExternalAgentRuntimeEvent {
  sequence: number;
  at: number;
  type: "message" | "tool" | "permission" | "state" | "error";
  text: string;
}

export interface ExternalAgentPermission {
  id: string;
  title: string;
  choices: Array<{ id: string; label: string }>;
}

export type ExternalWorkspaceMode = "staged" | "direct" | "read_only";

export interface StagedWorkspaceDiffSummary {
  hasChanges: boolean;
  added: string[];
  modified: string[];
  deleted: string[];
  conflictFiles: string[];
  emptyDirsAdded?: string[];
  emptyDirsDeleted?: string[];
  modeChanged?: string[];
  sensitivePaths?: string[];
  unifiedPreview: string;
  truncated: boolean;
}

export interface StagedWorkspaceDiffDetail extends StagedWorkspaceDiffSummary {
  diff: string;
  filteredPath?: string;
}

export interface StagedWorkspaceApplyResult {
  appliedAdded: string[];
  appliedModified: string[];
  appliedDeleted: string[];
  cleanedUp: boolean;
}

export interface ExternalAgentPendingReportFile {
  originalPath: string;
  snapshotPath: string;
  name?: string;
  mimeType?: string;
  caption?: string;
  size: number;
  sha256: string;
}

export interface ExternalAgentPendingReport {
  reportId: string;
  state: "progress" | "blocked" | "ready" | "failed";
  summary: string;
  deliverable?: string;
  question?: string;
  files?: ExternalAgentPendingReportFile[];
  at: number;
}

export interface ExternalAgentRun {
  id: string;
  taskId: string;
  runEpoch: number;
  kind: ExternalAgentKind;
  sessionId?: string;
  state: "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "uncertain";
  uncertainReason?: ExternalAgentUncertainReason;
  phase?: WorkerExecutionPhase;
  touchedFiles?: string[];
  text: string;
  events: ExternalAgentRuntimeEvent[];
  permissions: ExternalAgentPermission[];
  nextSequence: number;
  /** True only after native terminal evidence and owned process cleanup are confirmed. */
  quiescent?: boolean;
  stagedCwd?: string;
  scratchNotesDir?: string;
  stagedDiff?: StagedWorkspaceDiffSummary;
  readOnlyViolation?: ReadOnlyViolationSummary;
  /** Unacknowledged offline moco_task_report entries buffered locally on Env until Hub consumes & ACKs them. */
  pendingReports?: ExternalAgentPendingReport[];
  error?: string;
}

export type ExternalAgentRequest =
  | { operation: "detect"; kind: ExternalAgentKind; executable?: string }
  | { operation: "probe"; binding: ExternalAgentBinding; modelId?: string }
  | { operation: "run"; binding: ExternalAgentBinding; taskId: string; runEpoch: number; requestId: string; prompt: string; cwd: string; workspaceMode?: ExternalWorkspaceMode; modelId?: string; thinkingLevel?: string; sessionId?: string; readOnly: boolean; allowSubagents: boolean; taskTools?: boolean; hasConnections?: boolean; memoryEnabled?: boolean; projectId?: string; directoryId?: string; grantRevision?: number; timeoutMs: number; mcpServers?: Array<{ name: string; url: string; headers?: Array<{ name: string; value: string }> }> }
  | { operation: "inspect"; runId: string; afterSequence?: number; compact?: boolean; ackReportIds?: string[] }
  | { operation: "diff"; taskId: string; filePath?: string }
  | { operation: "apply"; taskId: string; projectId: string; directoryId?: string; grantRevision?: number; paths?: string[]; allowConflicts?: boolean }
  | { operation: "cancel"; runId: string }
  | { operation: "respond"; runId: string; permissionId: string; choiceId: string }
  | { operation: "close"; runId: string; discardStaged?: boolean };

export type ExternalAgentResponse =
  | { type: "detection"; detection: ExternalAgentDetection }
  | { type: "run"; run: ExternalAgentRun }
  | { type: "diff"; diff: StagedWorkspaceDiffDetail }
  | { type: "apply"; applied: StagedWorkspaceApplyResult };

export interface AgentConfigurationDraft {
  id: string;
  revision: number;
  clientId: string;
  settingsRevision: number;
  agentId?: string;
  binding: ExternalAgentBinding;
  label: string;
  whenToUse: string;
  prompt: string;
  modelId?: string;
  thinkingLevel?: string;
  readOnly: boolean;
  allowSubagents: boolean;
  dispatchPolicy?: import("./agent-routing.js").AgentDispatchPolicy;
  detection?: ExternalAgentDetection;
  verification?: { at: number; level: "protocol" | "roundtrip"; version?: string; sessionId?: string };
  updatedAt: number;
}

export interface AgentConfigurationWorkspace {
  catalog: ExternalAgentCatalogItem[];
  devices: Array<{ id: string; name: string; online: boolean }>;
  projects?: Array<{ id: string; name: string; envId: string }>;
  agents: Array<{ id: string; label: string; enabled: boolean; binding: ExternalAgentBinding; dispatchPolicy?: import("./agent-routing.js").AgentDispatchPolicy }>;
  draft?: AgentConfigurationDraft;
}

export interface ExternalTicketExecution {
  binding: ExternalAgentBinding;
  modelId?: string;
  thinkingLevel?: string;
  workspaceMode?: ExternalWorkspaceMode;
  stagedCwd?: string;
  stagedDiff?: StagedWorkspaceDiffSummary;
  stagedAppliedAt?: number;
  lastActivityAt?: number;
  interruptPending?: boolean;
  runId?: string;
  sessionId?: string;
  lastSequence?: number;
  phase?: WorkerExecutionPhase;
  touchedFiles?: string[];
  uncertainReason?: ExternalAgentUncertainReason;
  readOnlyViolation?: ReadOnlyViolationSummary;
  explicitReadyReport?: import("./domain.js").WorkerReportRecord & { runEpoch: number; version: number };
  explicitReportVersion?: number;
  consumedPendingReportIds?: string[];
  pendingPermissions?: ExternalAgentPermission[];
  notifiedPermissions?: string[];
  instructions?: string;
  allowSubagents?: boolean;
  children?: Record<string, { taskId: string; fingerprint: string }>;
}
