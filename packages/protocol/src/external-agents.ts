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
]);

export function isBlockedCustomAcpExecutableName(filePath: string): boolean {
  const normalized = filePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) return true;
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const base = (lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized)
    .replace(/\.(?:exe|cmd|bat|com)$/i, "")
    .toLowerCase();
  if (!base) return true;
  return BLOCKED_CUSTOM_ACP_EXECUTABLES.has(base);
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

export interface ExternalAgentServiceTierInfo {
  id: string;
  name?: string;
  description?: string;
}

export type ExternalAgentEffortCapability = "unknown" | "unsupported" | "supported";

export interface ExternalAgentModelInfo {
  id: string;
  name: string;
  efforts?: string[];
  effortCapability?: ExternalAgentEffortCapability;
  serviceTiers?: ExternalAgentServiceTierInfo[];
  defaultServiceTier?: string;
  isDefault?: boolean;
}

export const FALLBACK_EXTERNAL_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["adaptive", "low", "medium", "high", "max", "none"],
  codex: ["low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high", "xhigh"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  cursor: ["low", "medium", "high"],
  opencode: ["low", "medium", "high"],
  "gemini-cli": ["low", "medium", "high"],
  kiro: ["low", "medium", "high"],
  copilot: ["low", "medium", "high"],
  dsh: ["low", "medium", "high"],
  acp: ["low", "medium", "high"],
};

export interface ExternalModelEffortPolicy {
  capability: ExternalAgentEffortCapability;
  showSelector: boolean;
  efforts: string[];
  usesFallback: boolean;
}

export function resolveExternalModelEffortPolicy(
  modelInfo: Pick<ExternalAgentModelInfo, "efforts" | "effortCapability"> | undefined,
  kind?: ExternalAgentKind | string,
  siblingModels?: ReadonlyArray<Pick<ExternalAgentModelInfo, "efforts" | "effortCapability">>,
): ExternalModelEffortPolicy {
  if (modelInfo?.effortCapability === "unsupported") {
    return { capability: "unsupported", showSelector: false, efforts: [], usesFallback: false };
  }
  const explicitEfforts = Array.isArray(modelInfo?.efforts)
    ? [...new Set(modelInfo.efforts.map((item) => item.trim()).filter(Boolean))]
    : [];
  if (explicitEfforts.length > 0) {
    return { capability: "supported", showSelector: true, efforts: explicitEfforts, usesFallback: false };
  }
  if (
    modelInfo &&
    modelInfo.effortCapability === undefined &&
    siblingModels?.some(
      (sibling) =>
        sibling.effortCapability === "supported" ||
        (Array.isArray(sibling.efforts) && sibling.efforts.some((item) => Boolean(item.trim()))),
    )
  ) {
    return { capability: "unsupported", showSelector: false, efforts: [], usesFallback: false };
  }
  const fallback = FALLBACK_EXTERNAL_EFFORTS[kind ?? ""] ?? ["low", "medium", "high"];
  return { capability: "unknown", showSelector: true, efforts: [...fallback], usesFallback: true };
}

export interface ExternalAgentContextUsage {
  /** Number of context tokens currently in use (>= 0; supports 0). */
  usedTokens: number;
  /** Context window size in tokens when known (> 0). */
  contextWindow?: number;
  /** Rounded usage percentage [0, 100]; strictly omitted when contextWindow is unknown or <= 0. */
  percent?: number;
  /** Capture timestamp in milliseconds. */
  updatedAt: number;
}

export function normalizeExternalContextUsage(input: {
  usedTokens?: unknown;
  contextWindow?: unknown;
  updatedAt?: unknown;
}): ExternalAgentContextUsage | undefined {
  if (typeof input.usedTokens !== "number" || !Number.isFinite(input.usedTokens) || input.usedTokens < 0) {
    return undefined;
  }
  const usedTokens = Math.round(input.usedTokens);
  const rawWindow = input.contextWindow;
  const contextWindow =
    typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.round(rawWindow)
      : undefined;
  const percent =
    contextWindow !== undefined
      ? Math.max(0, Math.min(100, Math.round((usedTokens / contextWindow) * 100)))
      : undefined;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) && input.updatedAt > 0
      ? Math.round(input.updatedAt)
      : Date.now();
  return {
    usedTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(percent !== undefined ? { percent } : {}),
    updatedAt,
  };
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

export const EXTERNAL_CLIENT_KIND_LABELS: Readonly<Record<ExternalAgentKind, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  grok: "Grok Build",
  cursor: "Cursor Agent",
  opencode: "OpenCode",
  "gemini-cli": "Gemini CLI",
  kiro: "Kiro CLI",
  copilot: "GitHub Copilot",
  dsh: "DeepSeek Harness",
  acp: "自定义 ACP",
  "grok-bot": "Grok Bot",
  dots: "ChatGPT Dots",
  muse: "Meta Muse",
};

export function externalClientDisplayName(
  client: Pick<ExternalClientConnection, "kind" | "label" | "agentRef">,
): string {
  if (client.kind === "acp") {
    return client.label?.trim() || client.agentRef?.trim() || EXTERNAL_CLIENT_KIND_LABELS[client.kind];
  }
  return EXTERNAL_CLIENT_KIND_LABELS[client.kind];
}

export const DIRECT_EXTERNAL_CLIENT_ROLE_PREFIX = "client:";

export function directExternalClientRoleId(clientId: string): string {
  return `${DIRECT_EXTERNAL_CLIENT_ROLE_PREFIX}${clientId}`;
}

export function parseDirectExternalClientRoleId(roleId: string | undefined): string | undefined {
  if (typeof roleId !== "string" || !roleId.startsWith(DIRECT_EXTERNAL_CLIENT_ROLE_PREFIX)) return undefined;
  const clientId = roleId.slice(DIRECT_EXTERNAL_CLIENT_ROLE_PREFIX.length).trim();
  return clientId || undefined;
}

export function isDirectExternalClientRoleId(roleId: string | undefined): boolean {
  return parseDirectExternalClientRoleId(roleId) !== undefined;
}

export function externalClientConnectionId(binding: Pick<ExternalAgentBinding, "kind" | "envId" | "agentRef">): string {
  const ref = typeof binding.agentRef === "string" ? binding.agentRef.trim() : "";
  const raw = ref ? `${binding.kind}:${binding.envId}:${ref}` : `${binding.kind}:${binding.envId}`;
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 180);
}

export function deriveConnectedExternalClients(
  roles: Readonly<Record<string, import("./domain.js").RolePreset>> | undefined,
  savedClients?: Readonly<Record<string, ExternalClientConnection>>,
): ExternalClientConnection[] {
  const map = new Map<string, ExternalClientConnection>();
  for (const [id, client] of Object.entries(savedClients ?? {})) {
    map.set(id, client);
  }
  for (const role of Object.values(roles ?? {})) {
    if (!role.external) continue;
    const id = role.externalClientId?.trim() || externalClientConnectionId(role.external);
    if (map.has(id)) continue;
    map.set(id, {
      id,
      kind: role.external.kind,
      envId: role.external.envId,
      ...(role.external.kind === "acp" && role.label ? { label: role.label } : {}),
      ...(role.external.executable ? { executable: role.external.executable } : {}),
      ...(role.external.kind === "acp" && role.external.acpArgs?.length ? { acpArgs: [...role.external.acpArgs] } : {}),
      ...(role.external.agentRef ? { agentRef: role.external.agentRef } : {}),
      ...(role.external.cdpUrl ? { cdpUrl: role.external.cdpUrl } : {}),
      ...(role.external.experimental !== undefined ? { experimental: role.external.experimental } : {}),
      ...(role.external.version ? { version: role.external.version } : {}),
      ...(role.external.verifiedAt !== undefined ? { verifiedAt: role.external.verifiedAt } : {}),
      ...(role.external.capabilities ? { capabilities: role.external.capabilities } : {}),
      models: [],
      updatedAt: 0,
    });
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const EXTERNAL_AGENT_QUOTA_CAPABILITY = "external-agent-quota" as const;
export const EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY = "external-agent-structured-dispatch" as const;
export const EXTERNAL_AGENT_MEMORY_MODE_CAPABILITY = "external-memory-mode-v1" as const;

export interface ExternalAgentInputAttachment {
  id?: string;
  name: string;
  mimeType: string;
  path: string;
  size?: number;
  sha256?: string;
}

export const EXTERNAL_AGENT_QUOTA_SUPPORTED_KINDS = [
  "codex",
  "claude-code",
  "grok",
] as const;

export type QuotaSupportedExternalAgentKind = typeof EXTERNAL_AGENT_QUOTA_SUPPORTED_KINDS[number];

export function isQuotaSupportedExternalAgentKind(kind: unknown): kind is QuotaSupportedExternalAgentKind {
  return typeof kind === "string" && (EXTERNAL_AGENT_QUOTA_SUPPORTED_KINDS as readonly string[]).includes(kind);
}

export type ExternalAgentQuotaStatus =
  | "ok"
  | "api_key_billing"
  | "unauthenticated"
  | "device_offline"
  | "env_outdated"
  | "unsupported"
  | "unavailable";

export type ExternalAgentQuotaSeverity = "normal" | "warning" | "exhausted";

export interface ExternalAgentQuotaWindow {
  /** Stable key within a snapshot, e.g. "primary", "secondary", "five_hour", "seven_day", "model:opus". */
  id: string;
  /** Concise non-PII label, e.g. "5h", "7d", "Opus 7d". */
  label: string;
  /** Used percentage clamped to [0, 100]. */
  usedPercent: number;
  /** Optional rolling window duration in minutes (e.g. 300, 10080). */
  windowMinutes?: number;
  /** Optional Unix timestamp in milliseconds when the window resets. */
  resetsAt?: number;
  /** Optional normalized severity. */
  severity?: ExternalAgentQuotaSeverity;
  /** Optional bucket group name for multi-bucket accounts. */
  bucketLabel?: string;
}

export interface ExternalAgentQuotaCredits {
  hasCredits: boolean;
  unlimited?: boolean;
  /** Whitelisted non-PII currency/balance summary, e.g. "$12.50" or "$3.60 / $20.00". */
  balanceText?: string;
  usedPercent?: number;
  isExtraUsage?: boolean;
}

/** Env -> Hub normalized quota snapshot (strictly free of email/accountId/tokens). */
export interface ExternalAgentQuotaProbeResult {
  kind: ExternalAgentKind;
  status: Exclude<ExternalAgentQuotaStatus, "device_offline" | "env_outdated">;
  source: "live" | "passive_run";
  fetchedAt: number;
  planLabel?: string;
  ordinaryUsageAllowed?: boolean;
  windows: ExternalAgentQuotaWindow[];
  credits?: ExternalAgentQuotaCredits;
  error?: string;
}

/** Hub -> Web per-client quota view model. */
export interface ExternalClientQuotaItem {
  clientId: string;
  kind: ExternalAgentKind;
  label: string;
  envId: string;
  envName: string;
  deviceOnline: boolean;
  canRefresh: boolean;
  status: ExternalAgentQuotaStatus;
  source?: "live" | "passive_run";
  fetchedAt?: number;
  stale: boolean;
  refreshError?: string;
  planLabel?: string;
  ordinaryUsageAllowed?: boolean;
  windows: ExternalAgentQuotaWindow[];
  credits?: ExternalAgentQuotaCredits;
  error?: string;
}

export interface ExternalClientQuotasView {
  serverTime: number;
  softTtlMs: number;
  minRefreshCooldownMs: number;
  items: ExternalClientQuotaItem[];
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
  autoExecPaths?: string[];
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
  /** Latest passively captured quota snapshot observed during this external run (never blocks run settlement). */
  latestQuota?: ExternalAgentQuotaProbeResult;
  /** Latest read-only context usage telemetry reported by the external client (kept in-memory until receipt merge/settlement). */
  contextUsage?: ExternalAgentContextUsage;
  /** Read-only active session mode reported by the external client (never auto-switched by Kulo). */
  activeSessionMode?: string;
  error?: string;
}

export type ExternalAgentRequest =
  | { operation: "detect"; kind: ExternalAgentKind; executable?: string }
  | { operation: "probe"; binding: ExternalAgentBinding; modelId?: string }
  | { operation: "quota"; binding: ExternalAgentBinding }
  | { operation: "run"; binding: ExternalAgentBinding; taskId: string; runEpoch: number; requestId: string; prompt: string; developerInstructions?: string; attachments?: ExternalAgentInputAttachment[]; cwd: string; workspaceMode?: ExternalWorkspaceMode; modelId?: string; thinkingLevel?: string; serviceTier?: string; sessionId?: string; readOnly: boolean; allowSubagents: boolean; taskTools?: boolean; hasConnections?: boolean; memoryEnabled?: boolean; memoryMode?: "hindsight" | "builtin"; projectId?: string; directoryId?: string; grantRevision?: number; timeoutMs: number; mcpServers?: Array<{ name: string; url: string; headers?: Array<{ name: string; value: string }> }> }
  | { operation: "inspect"; runId: string; afterSequence?: number; compact?: boolean; ackReportIds?: string[] }
  | { operation: "diff"; taskId: string; filePath?: string }
  | { operation: "apply"; taskId: string; projectId: string; directoryId?: string; grantRevision?: number; paths?: string[]; allowConflicts?: boolean }
  | { operation: "cancel"; runId: string }
  | { operation: "respond"; runId: string; permissionId: string; choiceId: string }
  | { operation: "close"; runId: string; discardStaged?: boolean };

export type ExternalAgentResponse =
  | { type: "detection"; detection: ExternalAgentDetection }
  | { type: "quota"; quota: ExternalAgentQuotaProbeResult }
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
  agentId?: string;
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
  serviceTier?: string;
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
  /** Effective read-only intent propagated across Hub, MCP tools, child dispatches, and native drivers. */
  effectiveReadOnly?: boolean;
  allowSubagents?: boolean;
  children?: Record<string, { taskId: string; fingerprint: string }>;
  /** Read-only context usage telemetry piggybacked on existing receipt merges or terminal settlement. */
  contextUsage?: ExternalAgentContextUsage;
  /** Read-only active session mode observed from the external client. */
  activeSessionMode?: string;
}

export function isEffectiveExternalReadOnly(
  ticket: { readOnly?: boolean; externalExecution?: Pick<ExternalTicketExecution, "workspaceMode" | "effectiveReadOnly"> } | undefined,
): boolean {
  return Boolean(
    ticket?.readOnly ||
      ticket?.externalExecution?.effectiveReadOnly ||
      ticket?.externalExecution?.workspaceMode === "read_only",
  );
}
