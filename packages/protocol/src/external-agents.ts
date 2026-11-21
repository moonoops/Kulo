export const AUTO_SCAN_EXTERNAL_AGENT_KINDS = [
  "codex",
  "claude-code",
  "antigravity",
  "grok",
  "cursor",
  "opencode",
  "gemini-cli",
  "kiro",
  "copilot",
  "dsh",
] as const;

export const SUPPORTED_EXTERNAL_AGENT_KINDS = [
  ...AUTO_SCAN_EXTERNAL_AGENT_KINDS,
  "acp",
] as const;

export const PERSONAL_EXTERNAL_AGENT_KINDS = [
  "grok-bot",
  "dots",
  "muse",
] as const;

export const EXTERNAL_AGENT_KINDS = [
  ...SUPPORTED_EXTERNAL_AGENT_KINDS,
  ...PERSONAL_EXTERNAL_AGENT_KINDS,
] as const;
export type ExternalAgentKind = typeof EXTERNAL_AGENT_KINDS[number];

export const ASSISTANT_CONFIGURABLE_EXTERNAL_AGENT_KINDS = [
  ...AUTO_SCAN_EXTERNAL_AGENT_KINDS,
  ...PERSONAL_EXTERNAL_AGENT_KINDS,
] as const;

export function isSupportedExternalAgentKind(kind: unknown): kind is typeof SUPPORTED_EXTERNAL_AGENT_KINDS[number] {
  return typeof kind === "string" && (SUPPORTED_EXTERNAL_AGENT_KINDS as readonly string[]).includes(kind);
}

export function isAutoScanExternalAgentKind(kind: unknown): kind is typeof AUTO_SCAN_EXTERNAL_AGENT_KINDS[number] {
  return typeof kind === "string" && (AUTO_SCAN_EXTERNAL_AGENT_KINDS as readonly string[]).includes(kind);
}

export function isPersonalExternalAgentKind(kind: unknown): kind is typeof PERSONAL_EXTERNAL_AGENT_KINDS[number] {
  return typeof kind === "string" && (PERSONAL_EXTERNAL_AGENT_KINDS as readonly string[]).includes(kind);
}

export const CUSTOM_ACP_MAX_ARGS = 16;
export const CUSTOM_ACP_MAX_ARG_LENGTH = 256;

const BLOCKED_CUSTOM_ACP_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "env",
  "sudo",
  "nohup",
  "xargs",
  "open",
  "launchctl",
  "osascript",
  "cmd",
  "powershell",
  "pwsh",
  "awk",
  "gawk",
  "sed",
  "expect",
  "deno",
  "bun",
  "bunx",
  "npx",
  "pnpx",
  "dlx",
  "uvx",
  "pipx",
  "corepack",
  "tsx",
  "ts-node",
]);

const BLOCKED_CUSTOM_ACP_RUNTIME_PATTERN = /^(?:node|nodejs|python|pypy|perl|ruby|php)(?:\d+(?:\.\d+)*)?$/i;

export function isBlockedCustomAcpExecutableName(filePath: string): boolean {
  const normalized = filePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) return true;
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const base = (lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized)
    .replace(/\.(?:exe|cmd|bat|com)$/i, "")
    .toLowerCase();
  if (!base) return true;
  return BLOCKED_CUSTOM_ACP_EXECUTABLES.has(base) || BLOCKED_CUSTOM_ACP_RUNTIME_PATTERN.test(base);
}

export function isValidCustomAcpAgentRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) &&
    !["constructor", "prototype", "__proto__"].includes(value)
  );
}

export function validateCustomAcpArgs(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "自定义 ACP 启动参数必须是字符串数组。" };
  }
  if (value.length > CUSTOM_ACP_MAX_ARGS) {
    return { ok: false, error: `自定义 ACP 启动参数最多允许 ${CUSTOM_ACP_MAX_ARGS} 项。` };
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { ok: false, error: "自定义 ACP 启动参数必须全部为字符串。" };
    }
    if (/[\x00-\x1f\x7f]/.test(item)) {
      return { ok: false, error: "自定义 ACP 启动参数不能包含控制字符。" };
    }
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > CUSTOM_ACP_MAX_ARG_LENGTH) {
      return { ok: false, error: `每项自定义 ACP 启动参数不能为空且不能超过 ${CUSTOM_ACP_MAX_ARG_LENGTH} 字符。` };
    }
    normalized.push(trimmed);
  }
  return { ok: true, value: normalized };
}

export interface AcpRegistryTemplate {
  id: string;
  name: string;
  version: string;
  description?: string;
  suggestedArgs: string[];
  suggestedBinary?: string;
  requiresLocalInstall: boolean;
}

export const EXTERNAL_AGENT_MCP_TOOL_NAMES = [
  "kulo_task_context",
  "kulo_task_report",
  "kulo_agents",
  "kulo_request_collaboration",
  "kulo_child_task",
  "kulo_memory_recall",
  "kulo_memory_search_pages",
  "kulo_memory_read_page",
  "kulo_memory_ingest",
  "kulo_memory_reflect",
  "kulo_connections",
  "kulo_connection_use",
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
  acpArgs?: string[];
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
  acpArgs?: string[];
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

export function isBundledClaudeSdkExecutable(filePath?: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (/(?:^|\/)@anthropic-ai[+/]claude-agent-sdk(?:-[^/]+)?(?:\/|$)/.test(normalized)) return true;
  if (/\.app\/Contents\/(?:Resources|Frameworks)\/.*claude-agent-sdk/.test(normalized)) return true;
  return false;
}

export interface ExternalAgentDetection {
  kind: ExternalAgentKind;
  installed: boolean;
  desktopAppInstalled?: boolean;
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
  /** Unacknowledged offline kulo_task_report entries buffered locally on Env until Hub consumes & ACKs them. */
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

export interface ExternalAgentScanCandidate {
  kind: ExternalAgentKind;
  label: string;
  status: "supported" | "experimental" | "reserved";
  envId: string;
  envName: string;
  online: boolean;
  installed: boolean;
  desktopAppInstalled?: boolean;
  authenticated?: boolean | null;
  alreadyConnected: boolean;
  connectedClientId?: string;
  connectedVerified?: boolean;
  executable?: string;
  version?: string;
  error?: string;
}

export interface ExternalAgentScanResult {
  scannedAt: number;
  devices: Array<{ id: string; name: string; online: boolean }>;
  candidates: ExternalAgentScanCandidate[];
}

export interface ExternalAgentQuickConnectRequest {
  kind: ExternalAgentKind;
  envId: string;
  commandId: string;
  runTest?: boolean;
  executable?: string;
  acpArgs?: string[];
  agentRef?: string;
  cdpUrl?: string;
  experimental?: boolean;
  label?: string;
  whenToUse?: string;
  prompt?: string;
  modelId?: string;
  thinkingLevel?: string;
  allowSubagents?: boolean;
  dispatchPolicy?: import("./agent-routing.js").AgentDispatchPolicy;
}

export interface ExternalAgentQuickConnectResult {
  agentId: string;
  clientId: string;
  kind: ExternalAgentKind;
  envId: string;
  label: string;
  enabled: boolean;
  verificationLevel: "protocol" | "roundtrip";
  version?: string;
  modelsCount: number;
  settings: import("./domain.js").KuloSettingsView;
}

export interface ExternalAgentVerifyClientResult {
  clientId: string;
  verifiedAt: number;
  verificationLevel: "roundtrip";
  version?: string;
  modelsCount: number;
  enabledRoleIds: string[];
  settings: import("./domain.js").KuloSettingsView;
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
  recentEvents?: ExternalAgentRuntimeEvent[];
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
