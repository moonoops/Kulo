import {
  EXTERNAL_AGENT_MEMORY_MODE_CAPABILITY,
  EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY,
  isEffectiveExternalReadOnly,
  isPersonalExternalAgentKind,
  type ExternalAgentInputAttachment,
  type ExternalAgentKind,
  type ExternalAgentRequest,
  type ExternalMemoryMode,
  type ExternalWorkspaceMode,
  type KuloLanguage,
  type TicketRecord,
} from "@kulo/protocol";

export const DEFAULT_EXTERNAL_AGENT_ROLE_PROMPT =
  "Follow repository conventions, verify changes with real checks, report actual outcomes and file paths, and hand back to Kulo if scope expansion or cross-agent collaboration is needed.";
const DEFAULT_EXTERNAL_AGENT_ROLE_PROMPT_ZH =
  "遵循仓库既有约定与任务边界，完成改动后执行真实检查验证，向主 Agent 汇报具体结论、改动路径与验证证据；若需扩大范围或跨智能体协作，及时交回主 Agent 决策。";

export function defaultExternalAgentRolePrompt(language?: KuloLanguage): string {
  return language === "en" ? DEFAULT_EXTERNAL_AGENT_ROLE_PROMPT : DEFAULT_EXTERNAL_AGENT_ROLE_PROMPT_ZH;
}

export function isDefaultExternalAgentRolePrompt(raw: string | undefined): boolean {
  const trimmed = raw?.trim();
  return Boolean(
    trimmed &&
      (trimmed === DEFAULT_EXTERNAL_AGENT_ROLE_PROMPT || trimmed === DEFAULT_EXTERNAL_AGENT_ROLE_PROMPT_ZH),
  );
}

export function defaultExternalAgentWhenToUse(kind: string, language?: KuloLanguage): string {
  const personal = isPersonalExternalAgentKind(kind);
  if (language === "en") {
    return personal
      ? "Tasks explicitly assigned to this agent by the user."
      : "Code implementation, refactoring, debugging, and verification delegated and reviewed by the coordinator.";
  }
  return personal
    ? "仅在用户明确点名该智能体时委派执行。"
    : "复杂代码实现、重构排障与终端验证，由主 Agent 拆解派发并在交卷后验收。";
}

export function isEphemeralTableWorkspaceDir(
  workspaceDir: string | undefined,
  ticketId: string | undefined,
): boolean {
  const cleanDir = workspaceDir?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanId = ticketId?.trim();
  if (!cleanDir || !cleanId) return false;
  const escapedId = cleanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|/)table/${escapedId}(?:-[a-z0-9-]{1,28})?$`, "i").test(cleanDir);
}

export function isLightweightStandaloneExternalTask(params: {
  ticket: Readonly<TicketRecord>;
  effectiveReadOnly: boolean;
  allowSubagents: boolean;
  memoryEnabled: boolean;
  hasConnections: boolean;
}): boolean {
  const { ticket, effectiveReadOnly, allowSubagents, memoryEnabled, hasConnections } = params;
  return (
    !ticket.projectId &&
    !ticket.schedule &&
    effectiveReadOnly &&
    !ticket.parentTicketId &&
    !ticket.reviewTicketId &&
    !ticket.boardId &&
    !(ticket.inputAttachmentIds?.length) &&
    !allowSubagents &&
    !memoryEnabled &&
    !hasConnections &&
    isEphemeralTableWorkspaceDir(ticket.workspaceDir, ticket.id)
  );
}

export interface MaterializedExternalAttachment {
  id?: string;
  name: string;
  mimeType: string;
  path: string;
  size?: number;
  sha256?: string;
}

export interface ExternalAgentPromptInput {
  ticket: Readonly<TicketRecord>;
  bindingKind?: ExternalAgentKind;
  instructions?: string;
  workspaceMode: ExternalWorkspaceMode;
  projectName?: string;
  recalledMemory?: string;
  boardContext?: string;
  reviewContext?: string;
  materialized: ReadonlyArray<MaterializedExternalAttachment>;
  followUp?: string;
  localEnvId?: string;
  allowSubagents?: boolean;
  memoryEnabled?: boolean;
  memoryMode?: ExternalMemoryMode;
  hasConnections?: boolean;
  taskTools?: boolean;
}

export interface BuiltExternalAgentPrompt {
  developerInstructions: string;
  userPrompt: string;
  combinedPrompt: string;
}

export interface BudgetedExternalContextSections {
  reviewContext?: string;
  boardContext?: string;
  contextSummary?: string;
  recalledMemory?: string;
}

const TOTAL_CONTEXT_BUDGET = 16_000;
const REVIEW_CONTEXT_MAX = 6_000;
const BOARD_CONTEXT_MAX = 3_000;
const CONTEXT_SUMMARY_MAX = 4_000;
const RECALLED_MEMORY_MAX = 3_500;
const DEVELOPER_INSTRUCTIONS_MAX = 24_000;
const MAX_IMAGE_CANDIDATES = 8;
const IMAGE_MIME_SET = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const XML_RESERVED_TAG_RE = /<(?=\/?(?:task|context_summary|task_board|review_pack|recalled_memory|attachments|follow_up|kulo_instructions|kulo_worker_project)\b)/gi;

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeXmlContent(value: string): string {
  return value.replace(XML_RESERVED_TAG_RE, "&lt;");
}

export function stripMemoryContextHeader(raw: string): string {
  return raw
    .replace(/^\[KULO_MEMORY_CONTEXT[^\]]*\]\r?\n(?:Historical shared project work records[^\r\n]*:\r?\n)?/i, "")
    .trim();
}

export function fitSectionBudget(raw: string | undefined, cap: number, remaining: number, suffix: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || remaining <= 0) return undefined;
  const budget = Math.min(cap, remaining);
  if (trimmed.length <= budget) return trimmed;
  if (budget <= suffix.length + 16) return undefined;
  return `${trimmed.slice(0, budget - suffix.length).trimEnd()}${suffix}`;
}

export function budgetExternalContextSections(input: {
  reviewContext?: string;
  boardContext?: string;
  contextSummary?: string;
  recalledMemory?: string;
  memoryEnabled?: boolean;
}): BudgetedExternalContextSections {
  let remaining = TOTAL_CONTEXT_BUDGET;
  const take = (raw: string | undefined, cap: number, suffix: string): string | undefined => {
    const fitted = fitSectionBudget(raw, cap, remaining, suffix);
    if (fitted) remaining -= fitted.length;
    return fitted;
  };
  const reviewContext = take(input.reviewContext, REVIEW_CONTEXT_MAX, "\n[Truncated]");
  const boardContext = take(input.boardContext, BOARD_CONTEXT_MAX, "\n[Truncated]");
  const contextSummary = take(input.contextSummary, CONTEXT_SUMMARY_MAX, "\n[Truncated]");
  const cleanedMemory = input.recalledMemory ? stripMemoryContextHeader(input.recalledMemory) : undefined;
  const recalledMemory = take(
    cleanedMemory,
    RECALLED_MEMORY_MAX,
    input.memoryEnabled ? "\n[Truncated; call kulo_memory_recall for more]" : "\n[Truncated]",
  );
  return {
    ...(reviewContext ? { reviewContext } : {}),
    ...(boardContext ? { boardContext } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(recalledMemory ? { recalledMemory } : {}),
  };
}

function normalizeImageMime(raw: string): string | undefined {
  const base = raw.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  const normalized = base === "image/jpg" ? "image/jpeg" : base;
  return IMAGE_MIME_SET.has(normalized) ? normalized : undefined;
}

export function selectImageAttachmentCandidates(
  materialized: ReadonlyArray<MaterializedExternalAttachment>,
): ExternalAgentInputAttachment[] {
  const results: ExternalAgentInputAttachment[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const item of materialized) {
    if (results.length >= MAX_IMAGE_CANDIDATES) break;
    const mimeType = normalizeImageMime(item.mimeType);
    if (!mimeType || !item.path) continue;
    if (item.id && seenIds.has(item.id)) continue;
    if (seenPaths.has(item.path)) continue;
    if (item.id) seenIds.add(item.id);
    seenPaths.add(item.path);
    results.push({
      ...(item.id ? { id: item.id } : {}),
      name: item.name,
      mimeType,
      path: item.path,
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
    });
  }
  return results;
}

function buildWorkspaceSection(
  ticket: Readonly<TicketRecord>,
  workspaceMode: ExternalWorkspaceMode,
  projectName?: string,
): string {
  const effectiveReadOnly = workspaceMode === "read_only" || isEffectiveExternalReadOnly(ticket);
  const notesPath = ticket.scratchDir ? `${ticket.scratchDir}/notes` : "scratch/notes";
  if (ticket.projectId) {
    const projectLine = `Project: ${projectName ?? ticket.projectId} (project_id=${ticket.projectId})`;
    if (effectiveReadOnly) {
      return [
        projectLine,
        `Workspace Mode: read_only — inspect and analyze only; never modify project files. Write any notes or long standalone audit reports only to ${notesPath}, or return them directly in your final response / kulo_task_report(deliverable).`,
      ].join("\n");
    }
    if (workspaceMode === "staged") {
      return [
        projectLine,
        "Workspace Mode: staged clone — your current working directory is an isolated staged working copy. Edit and run checks strictly inside the current working directory; the coordinator will review and merge your diff.",
      ].join("\n");
    }
    return [
      projectLine,
      `Workspace Mode: direct — bound directly to project directory (${ticket.workspaceDir}). Keep edits strictly within authorized scope.`,
    ].join("\n");
  }
  if (effectiveReadOnly) {
    return `Workspace Mode: read_only — standalone task directory (${ticket.workspaceDir}). Inspect and analyze only; never modify files. Write any notes or long standalone reports only to ${notesPath}, or return them directly in your final response / kulo_task_report(deliverable).`;
  }
  return `Workspace Mode: standalone task directory (${ticket.workspaceDir}).`;
}

function buildCrossDeviceGuard(
  ticket: Readonly<TicketRecord>,
  localEnvId = "local",
  taskTools = true,
): string {
  const isHubHost = (id: string | undefined) => id === localEnvId || (localEnvId === "local" && id === "local");
  const crossDeviceSender =
    isHubHost(ticket.envId) &&
    (ticket.envBinding === undefined || ticket.envBinding === "hub_local") &&
    ticket.senderSource &&
    !isHubHost(ticket.senderSource.deviceId)
      ? ticket.senderSource
      : undefined;
  if (!crossDeviceSender) return "";
  const blockedAction = taskTools
    ? "immediately report blocked"
    : `immediately stop and state what prerequisite on "${crossDeviceSender.name}" is blocking you`;
  return `Cross-Device Guard: Requested from user device "${crossDeviceSender.name}" (${crossDeviceSender.deviceId}), executing on Hub "local". Never read Hub host personal folders (e.g. ~/Desktop, ~/Downloads) as user files; if the task requires "${crossDeviceSender.name}" local files, ports, apps, or browser state, ${blockedAction}.`;
}

function buildDeveloperInstructions(params: {
  ticket: Readonly<TicketRecord>;
  bindingKind?: ExternalAgentKind;
  instructions?: string;
  workspaceMode: ExternalWorkspaceMode;
  projectName?: string;
  localEnvId?: string;
  allowSubagents: boolean;
  memoryEnabled: boolean;
  memoryMode?: ExternalMemoryMode;
  hasConnections: boolean;
  taskTools: boolean;
  lightweight: boolean;
}): string {
  const {
    ticket,
    bindingKind,
    instructions,
    workspaceMode,
    projectName,
    localEnvId,
    allowSubagents,
    memoryEnabled,
    memoryMode,
    hasConnections,
    taskTools,
    lightweight,
  } = params;
  const isGrokBot = bindingKind === "grok-bot";
  const effectiveReadOnly = workspaceMode === "read_only" || isEffectiveExternalReadOnly(ticket);
  if (isGrokBot || lightweight) {
    const sections: string[] = [
      effectiveReadOnly
        ? "Read-only mode: delegated task from Kulo. Reply directly without modifying files."
        : "Delegated task from Kulo. Reply directly with your findings or answer.",
    ];
    const rolePrompt = instructions?.trim();
    if (rolePrompt && !isDefaultExternalAgentRolePrompt(rolePrompt)) sections.push(rolePrompt);
    const crossDeviceGuard = buildCrossDeviceGuard(ticket, localEnvId, false);
    if (crossDeviceGuard) sections.push(crossDeviceGuard);
    const compact = sections.filter(Boolean).join("\n\n");
    if (compact.length <= DEVELOPER_INSTRUCTIONS_MAX) return compact;
    return `${compact.slice(0, DEVELOPER_INSTRUCTIONS_MAX - 16).trimEnd()}\n[Truncated]`;
  }

  const sections: string[] = [
    "You are an external specialist agent executing a bounded task delegated by Kulo's coordinator. Your final output and any workspace changes will be reviewed by the coordinator before final delivery.",
  ];
  const rolePrompt = instructions?.trim();
  if (rolePrompt) sections.push(rolePrompt);
  sections.push(buildWorkspaceSection(ticket, workspaceMode, projectName));
  const crossDeviceGuard = buildCrossDeviceGuard(ticket, localEnvId, taskTools);
  if (crossDeviceGuard) sections.push(crossDeviceGuard);

  const reportingLines = [
    "Reporting Contract:",
    "- For routine text-only answers, return a concise technical summary of actual changes or findings, exact file paths, and real verification results directly in your final response.",
    "- If blocked, state concrete evidence and what prerequisite or decision is needed.",
  ];
  if (taskTools) {
    reportingLines.push(
      "- Use `kulo_task_report` when reporting milestone progress, a blocking question (`state=\"blocked\"` with `question`), staging artifact files (`files`), or delivering a structured final report (`state=\"ready\"` / `\"failed\"`).",
      "- After calling `kulo_task_report` with `state=\"ready\"`, `\"blocked\"`, or `\"failed\"`, end your turn immediately with one brief sentence; do not repeat the full report or make further edits.",
      "- For long standalone design proposals or multi-section audit reports, save the full Markdown document in your scratch notes directory and stage it via `kulo_task_report` `files`, keeping your text summary to core conclusions and trade-offs.",
      "- Use `kulo_task_context` if you need to re-check task scope, workspace mode, or scratch paths.",
    );
  }
  sections.push(reportingLines.join("\n"));

  const optionalTools: string[] = [];
  if (taskTools && allowSubagents) {
    optionalTools.push(
      "- Collaboration (`kulo_agents`, `kulo_request_collaboration`, `kulo_child_task`): prefer solving directly with your own tools unless another Kulo agent's distinct capability or specialization is clearly needed. Reuse `request_id` on retry. If `kulo_request_collaboration` returns `requiresParentYield: true`, immediately stop and hand back to the coordinator — never poll `kulo_child_task` in a loop.",
    );
  }
  if (taskTools && memoryEnabled) {
    optionalTools.push(
      memoryMode === "builtin"
        ? "- Shared Project Memory (`kulo_memory_recall`, `kulo_memory_ingest`): query shared project history when needed or record newly verified non-secret project findings."
        : "- Shared Project Memory (`kulo_memory_recall`, `kulo_memory_search_pages`, `kulo_memory_read_page`, `kulo_memory_ingest`, `kulo_memory_reflect`): query shared project history when needed or record newly verified non-secret project findings.",
    );
  }
  if (taskTools && hasConnections) {
    optionalTools.push(
      "- Authorized Connections (`kulo_connections`, `kulo_connection_use`): inspect and invoke connections authorized for this task without requesting raw credentials.",
    );
  }
  if (optionalTools.length > 0) {
    sections.push(["Optional Kulo MCP Tools:", ...optionalTools].join("\n"));
  }

  const combined = sections.filter(Boolean).join("\n\n");
  if (combined.length <= DEVELOPER_INSTRUCTIONS_MAX) return combined;
  return `${combined.slice(0, DEVELOPER_INSTRUCTIONS_MAX - 16).trimEnd()}\n[Truncated]`;
}

function formatAttachmentBlock(materialized: ReadonlyArray<MaterializedExternalAttachment>): string {
  if (!materialized.length) return "";
  const lines = materialized.map((item) => `- ${escapeXmlContent(item.name)} (${escapeXmlContent(item.mimeType)}): ${item.path}`);
  return `<attachments>\n${lines.join("\n")}\n</attachments>`;
}

export function buildExternalAgentPrompt(params: ExternalAgentPromptInput): BuiltExternalAgentPrompt {
  const {
    ticket,
    bindingKind = ticket.externalExecution?.binding.kind,
    instructions,
    workspaceMode,
    projectName,
    recalledMemory,
    boardContext,
    reviewContext,
    materialized,
    followUp,
    localEnvId,
    allowSubagents = Boolean(ticket.externalExecution?.allowSubagents),
    memoryEnabled = false,
    memoryMode,
    hasConnections = Boolean(ticket.connectionIds?.length),
    taskTools = true,
  } = params;
  const effectiveReadOnly = workspaceMode === "read_only" || isEffectiveExternalReadOnly(ticket);
  const clientSupportsMcp = bindingKind !== "grok-bot";
  const effectiveAllowSubagents = clientSupportsMcp && allowSubagents;
  const effectiveMemoryEnabled = clientSupportsMcp && Boolean(ticket.projectId) && memoryEnabled;
  const effectiveHasConnections = clientSupportsMcp && hasConnections;
  const lightweight =
    clientSupportsMcp &&
    isLightweightStandaloneExternalTask({
      ticket,
      effectiveReadOnly,
      allowSubagents: effectiveAllowSubagents,
      memoryEnabled: effectiveMemoryEnabled,
      hasConnections: effectiveHasConnections,
    });
  const effectiveTaskTools = clientSupportsMcp && !lightweight && taskTools;

  const developerInstructions = buildDeveloperInstructions({
    ticket,
    bindingKind,
    instructions,
    workspaceMode,
    projectName,
    localEnvId,
    allowSubagents: effectiveAllowSubagents,
    memoryEnabled: effectiveMemoryEnabled,
    ...(effectiveMemoryEnabled && memoryMode ? { memoryMode } : {}),
    hasConnections: effectiveHasConnections,
    taskTools: effectiveTaskTools,
    lightweight,
  });

  const budgeted = budgetExternalContextSections({
    reviewContext,
    boardContext,
    contextSummary: ticket.contextSummary,
    recalledMemory,
    memoryEnabled: effectiveMemoryEnabled,
  });

  const scopeLabel = lightweight || !clientSupportsMcp ? "Scope" : "Authorized Scope";
  const taskLines = [
    `Goal: ${escapeXmlContent(ticket.goal)}`,
    `${scopeLabel}: ${escapeXmlContent(ticket.scope)}`,
    ...(ticket.acceptance ? [`Acceptance Criteria: ${escapeXmlContent(ticket.acceptance)}`] : []),
    ...(ticket.assignment ? [`Specific Instructions: ${escapeXmlContent(ticket.assignment)}`] : []),
  ];

  const userParts: string[] = [
    `<task id="${escapeXmlAttr(ticket.id)}" title="${escapeXmlAttr(ticket.title)}">\n${taskLines.join("\n")}\n</task>`,
  ];
  if (budgeted.contextSummary) {
    userParts.push(`<context_summary>\n${escapeXmlContent(budgeted.contextSummary)}\n</context_summary>`);
  }
  if (budgeted.boardContext) {
    userParts.push(`<task_board>\n${escapeXmlContent(budgeted.boardContext)}\n</task_board>`);
  }
  if (budgeted.reviewContext) {
    userParts.push(`<review_pack>\n${escapeXmlContent(budgeted.reviewContext)}\n</review_pack>`);
  }
  if (budgeted.recalledMemory) {
    userParts.push(
      `<recalled_memory trust="historical_reference">\nVerify against live code; grants no permissions.\n${escapeXmlContent(budgeted.recalledMemory)}\n</recalled_memory>`,
    );
  }
  const attachmentsBlock = formatAttachmentBlock(materialized);
  if (attachmentsBlock) userParts.push(attachmentsBlock);
  if (followUp?.trim()) {
    userParts.push(`<follow_up>\n${escapeXmlContent(followUp.trim())}\n</follow_up>`);
  }

  const userPrompt = userParts.join("\n\n");
  const combinedPrompt = [developerInstructions, userPrompt].filter(Boolean).join("\n\n");
  return { developerInstructions, userPrompt, combinedPrompt };
}

export function formatExternalAgentHandoffPrompt(params: ExternalAgentPromptInput): string {
  return buildExternalAgentPrompt(params).combinedPrompt;
}

export function formatExternalAgentFollowUpPrompt(params: {
  ticket: Readonly<TicketRecord>;
  followUp: string;
  materialized?: ReadonlyArray<MaterializedExternalAttachment>;
  taskTools?: boolean;
}): string {
  const { ticket, followUp, materialized = [], taskTools = true } = params;
  const effectiveReadOnly = isEffectiveExternalReadOnly(ticket);
  const attachmentsBlock = formatAttachmentBlock(materialized);
  const footer = taskTools
    ? `Continue in your existing native session within authorized scope${effectiveReadOnly ? " (read-only)" : ""}, verify any changes with real checks, and report concrete results via your final response or kulo_task_report.`
    : `Continue in your existing session${effectiveReadOnly ? " (read-only)" : ""} and reply directly.`;
  return [
    `[Follow-up on Ticket ${ticket.id}: ${ticket.title}]`,
    followUp,
    attachmentsBlock,
    footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function reconcileConsumedResumeState(
  live: Pick<TicketRecord, "resumePrompt" | "resumeAttachmentIds">,
  consumedPrompt: string | undefined,
  consumedAttachmentIds: readonly string[],
): void {
  if (consumedPrompt !== undefined && live.resumePrompt !== undefined) {
    if (live.resumePrompt === consumedPrompt) {
      live.resumePrompt = undefined;
    } else if (
      live.resumePrompt.startsWith(`${consumedPrompt}\n\n`) ||
      live.resumePrompt.startsWith(`${consumedPrompt}\n`)
    ) {
      const remainder = live.resumePrompt.slice(consumedPrompt.length).replace(/^\n+/, "");
      live.resumePrompt = remainder || undefined;
    }
  }
  if (consumedAttachmentIds.length > 0 && live.resumeAttachmentIds?.length) {
    const consumedSet = new Set(consumedAttachmentIds);
    const remaining = live.resumeAttachmentIds.filter((id) => !consumedSet.has(id));
    live.resumeAttachmentIds = remaining.length > 0 ? remaining : undefined;
  }
}

export function buildExternalAgentRunRequest(params: {
  ticket: Readonly<TicketRecord>;
  runEpoch: number;
  runId: string;
  isResumingNativeSession: boolean;
  followUpText?: string;
  projectName?: string;
  recalledMemory?: string;
  boardContext?: string;
  reviewContext?: string;
  materialized: ReadonlyArray<MaterializedExternalAttachment>;
  localEnvId?: string;
  hasConnections: boolean;
  memoryEnabled: boolean;
  memoryMode?: ExternalMemoryMode | "none";
  envCapabilities?: readonly string[];
  timeoutMs?: number;
}): Extract<ExternalAgentRequest, { operation: "run" }> {
  const external = params.ticket.externalExecution!;
  const effectiveReadOnly = isEffectiveExternalReadOnly(params.ticket);
  const workspaceMode: ExternalWorkspaceMode =
    external.workspaceMode === "read_only" || external.workspaceMode === "direct"
      ? external.workspaceMode
      : effectiveReadOnly
        ? "read_only"
        : "staged";
  const supportsStructured = Boolean(params.envCapabilities?.includes(EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY));
  const supportsMemoryMode = Boolean(params.envCapabilities?.includes(EXTERNAL_AGENT_MEMORY_MODE_CAPABILITY));
  const clientSupportsMcp = external.binding.kind !== "grok-bot";
  const effectiveAllowSubagents = clientSupportsMcp && Boolean(external.allowSubagents);
  const requestedMemoryMode: ExternalMemoryMode | "none" = params.memoryMode ?? (params.memoryEnabled ? "hindsight" : "none");
  // Old Env nodes without `external-memory-mode-v1` reject unknown `memoryMode` fields and would expose Hindsight-only tools;
  // omit `memoryMode` and keep `memoryEnabled: false` when built-in memory is active on an older Env.
  const canUseRequestedMemory =
    requestedMemoryMode === "hindsight"
      ? true
      : requestedMemoryMode === "builtin"
        ? supportsMemoryMode
        : false;
  const effectiveMemoryEnabled = clientSupportsMcp && Boolean(params.ticket.projectId) && canUseRequestedMemory;
  const wireMemoryMode: ExternalMemoryMode | undefined =
    effectiveMemoryEnabled && supportsMemoryMode && requestedMemoryMode !== "none" ? requestedMemoryMode : undefined;
  const effectiveHasConnections = clientSupportsMcp && params.hasConnections;
  const lightweight =
    clientSupportsMcp &&
    isLightweightStandaloneExternalTask({
      ticket: params.ticket,
      effectiveReadOnly,
      allowSubagents: effectiveAllowSubagents,
      memoryEnabled: effectiveMemoryEnabled,
      hasConnections: effectiveHasConnections,
    });
  const effectiveTaskTools = clientSupportsMcp && !lightweight;
  const built = buildExternalAgentPrompt({
    ticket: params.ticket,
    bindingKind: external.binding.kind,
    instructions: external.instructions,
    workspaceMode,
    projectName: params.projectName,
    recalledMemory: params.recalledMemory,
    boardContext: params.boardContext,
    reviewContext: params.reviewContext,
    materialized: params.materialized,
    followUp: params.followUpText,
    localEnvId: params.localEnvId,
    allowSubagents: effectiveAllowSubagents,
    memoryEnabled: effectiveMemoryEnabled,
    ...(effectiveMemoryEnabled && requestedMemoryMode !== "none" ? { memoryMode: requestedMemoryMode } : {}),
    hasConnections: effectiveHasConnections,
    taskTools: effectiveTaskTools,
  });
  const followUpPrompt = params.isResumingNativeSession
    ? formatExternalAgentFollowUpPrompt({
        ticket: params.ticket,
        followUp: params.followUpText!.trim(),
        materialized: params.materialized,
        taskTools: effectiveTaskTools,
      })
    : undefined;
  const imageAttachments = supportsStructured ? selectImageAttachmentCandidates(params.materialized) : [];
  const prompt = params.isResumingNativeSession
    ? followUpPrompt!
    : supportsStructured
      ? built.userPrompt
      : built.combinedPrompt;

  return {
    operation: "run",
    binding: external.binding,
    taskId: params.ticket.id,
    runEpoch: params.runEpoch,
    requestId: params.runId,
    prompt,
    ...(supportsStructured ? { developerInstructions: built.developerInstructions } : {}),
    ...(supportsStructured && imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
    cwd: params.ticket.workspaceDir,
    ...(external.workspaceMode ? { workspaceMode: external.workspaceMode } : {}),
    ...(external.modelId ? { modelId: external.modelId } : {}),
    ...(external.thinkingLevel ? { thinkingLevel: external.thinkingLevel } : {}),
    ...(external.serviceTier ? { serviceTier: external.serviceTier } : {}),
    ...(external.sessionId ? { sessionId: external.sessionId } : {}),
    readOnly: effectiveReadOnly,
    allowSubagents: effectiveAllowSubagents,
    taskTools: effectiveTaskTools,
    ...(effectiveHasConnections ? { hasConnections: true } : {}),
    ...(effectiveMemoryEnabled ? { memoryEnabled: true } : {}),
    ...(wireMemoryMode ? { memoryMode: wireMemoryMode } : {}),
    projectId: params.ticket.projectId,
    directoryId: params.ticket.directoryId,
    grantRevision: params.ticket.grantRevision,
    timeoutMs: params.timeoutMs ?? 30 * 60_000,
  };
}
