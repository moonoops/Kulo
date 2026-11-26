import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, bool, int, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  KULO_DISPATCH_DESCRIPTION,
  KULO_DISPATCH_EXECUTE_AT_DESCRIPTION,
  KULO_DISPATCH_GOAL_DESCRIPTION,
  KULO_DISPATCH_REPEAT_EVERY_DESCRIPTION,
  KULO_STOP_DESCRIPTION,
} from "./prompts/tool-descriptions.js";
import type { Context } from "@earendil-works/chord/context";
import {
  IDENTITY_FILES,
  AGENT_TASK_KINDS,
  type AgentTaskKind,
  type AgentExpressionState,
  type AgentFace,
  type ChatAttachment,
  type ChatReplyReference,
  type IdentityFile,
  type IdentityList,
  type IdentityRead,
  type IdentitySaved,
  type ExternalWorkspaceMode,
  type IdentityProposal,
  type RelationshipWriteRequest,
  type EnvNodeDescriptor,
  type HindsightMemoryConfig,
  type SlotSummary,
  type StagedWorkspaceApplyResult,
  type StagedWorkspaceDiffDetail,
  type ThinkingEffort,
  type TicketCardView,
  type TicketClosureKind,
  type TicketWaitOption,
  type WorkerInspectResult,
} from "@kulo/protocol";
import { isMainOrchestratorApi } from "./settings-doc.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import { createHindsightTools } from "./tools-memory.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { MemoryCallerContext } from "./hindsight.js";
import type { ForgottenTermEntry, MemoryForgetOutcome } from "./memory-forget.js";
import { createWebSearchTool } from "./tools-search.js";
import { createWebFetchTool, type WebFetchToolOptions } from "./tools-worker.js";
import type { KuloSearch } from "./search.js";
import { createConnectionTools, type ConnectionToolController } from "./tools-connections.js";
import { createHostActionDecideTool, createHostActionTool, type HostActionController } from "./tools-host-action.js";

export interface DispatchTicketParams {
  commandId: string;
  title: string;
  userSummary?: string;
  goal: string;
  scope: string;
  acceptance?: string;
  assignment?: string;
  contextSummary?: string;
  attachmentIds?: string[];
  workspaceMode?: ExternalWorkspaceMode;
  role?: string;
  providerOverride?: string;
  modelOverride?: string;
  taskKind?: AgentTaskKind;
  thinkingLevel?: ThinkingEffort;
  envId?: string;
  targetScope?: import("@kulo/protocol").DispatchTargetScope;
  executionDomain?: "computer" | "android";
  androidDeviceIds?: string[];
  workspaceDir?: string;
  projectId?: string;
  connectionIds?: string[];
  supersedes?: Array<{
    ticketId: string;
    reason: string;
  }>;
  originConversationId?: number;
  originToolTaskId?: number;
  sourceRequestId?: string;
  parentTicketId?: string;
  parentExternalRequest?: { runId: string; runEpoch: number; requestId: string; fingerprint: string };
  executeAt?: string;
  repeatEverySeconds?: number;
  inlineWaitMs?: number;
  boardId?: string;
  boardTitle?: string;
  reviewTicketId?: string;
  inheritBrowserSession?: boolean;
}

export interface BoardToolParams {
  action: "search" | "read" | "write";
  query?: string;
  includeArchived?: boolean;
  boardId?: string;
  commandId?: string;
  boardTitle?: string;
  goal?: string;
  ticketId?: string;
  kind?: "verified" | "decision" | "constraint" | "handoff" | "correction";
  note?: string;
  supersedesSeq?: number;
  status?: "active" | "archived";
}

export interface DispatchTicketModelOutcome {
  ticket: TicketCardView;
  inlineDelivery?: {
    state: import("@kulo/protocol").WorkerReportState;
    summary: string;
    deliverable?: string | null;
    sources?: import("@kulo/protocol").WebSource[];
    stagedDiff?: import("@kulo/protocol").StagedWorkspaceDiffSummary;
    stagedAssets?: Array<{ id: string; name: string; mimeType: string }>;
  };
  blockedByPendingMerge?: {
    ticketId: string;
    title: string;
  };
  browserSessionInherited?: boolean;
  browserSessionInheritReason?: string;
}

export interface SteerTicketParams {
  commandId: string;
  ticketId: string;
  text: string;
  replyTo?: ChatReplyReference;
  attachments?: ChatAttachment[];
  decisionOptionId?: string;
  principalId?: string;
  originConversationId?: number;
  originToolTaskId?: number;
  resetRecovery?: boolean;
  interrupt?: boolean;
  /** Internal Hub-initiated system resume (never exposed to HTTP/WS/LLM); bypasses free-text agent-intent parsing. */
  internalResume?: boolean;
}

export interface ApplyStagedChangesParams {
  commandId: string;
  ticketId: string;
  paths?: string[];
  allowConflicts?: boolean;
  askUser?: boolean;
  originConversationId?: number;
}

export interface AskUserForTicketParams {
  ticketId: string;
  question: string;
  options?: TicketWaitOption[];
  showCard?: boolean;
}

export interface CloseTicketParams {
  commandId: string;
  ticketId: string;
  kind: TicketClosureKind;
  reason: string;
  replacementTicketId?: string;
  originConversationId?: number;
  originToolTaskId?: number;
}

export interface OrchestratorController {
  connections?: ConnectionToolController;
  hostActions?: HostActionController;
  webFetchContext?: Omit<WebFetchToolOptions, "getSearch">;
  showDeviceInvitation?(conversationId: number, callId: string): Promise<void>;
  dispatchTicket(params: DispatchTicketParams, context: Context): Promise<TicketCardView>;
  dispatchTicketForModel?(params: DispatchTicketParams, context: Context): Promise<DispatchTicketModelOutcome>;
  steerTicket(params: SteerTicketParams, context: Context): Promise<TicketCardView>;
  stopTicket(ticketId: string, reason: string | undefined, context: Context,
    commandId?: string, origin?: { conversationId: number; toolTaskId: number }): Promise<TicketCardView>;
  closeTicket(params: CloseTicketParams, context: Context): Promise<TicketCardView>;
  inspectWorker(ticketId: string, context: Context): Promise<WorkerInspectResult>;
  respondExternalAgentPermission?(ticketId: string, permissionId: string, choiceId: string, runEpoch: number, context: Context): Promise<WorkerInspectResult>;
  handleExternalAgentPermission?(
    input: {
      ticketId: string;
      permissionId: string;
      choiceId?: string;
      runEpoch: number;
      mode: "decide" | "ask_user";
      reason?: string;
    },
    source: { conversationId: number; callId: string },
    context: Context,
  ): Promise<WorkerInspectResult | Record<string, unknown>>;
  askUserForTicket?(
    params: AskUserForTicketParams,
    source: { conversationId: number; callId: string },
    context: Context,
  ): Promise<Record<string, unknown>>;
  inspectStagedDiff?(ticketId: string, filePath: string | undefined, context: Context): Promise<StagedWorkspaceDiffDetail>;
  applyStagedChanges?(params: ApplyStagedChangesParams, context: Context): Promise<StagedWorkspaceApplyResult>;
  applyStagedChangesFromTool?(
    params: ApplyStagedChangesParams,
    source: { conversationId: number; callId: string },
    context: Context,
  ): Promise<StagedWorkspaceApplyResult | Record<string, unknown>>;
  getBoardSnapshot(context: Context): Promise<{
    tickets: TicketCardView[];
    slots: SlotSummary;
    envs: EnvNodeDescriptor[];
  }>;
  readIdentityFiles(file?: IdentityFile): Promise<IdentityList | IdentityRead>;
  proposeIdentity(content: string, summary: string): Promise<IdentityProposal>;
  updateRelationship(request: RelationshipWriteRequest): Promise<IdentitySaved>;
  getForgottenTerms?(): Promise<ForgottenTermEntry[]>;
  forgetMemory?(
    term: string,
    reason: string | undefined,
    caller: MemoryCallerContext,
    signal?: AbortSignal,
  ): Promise<MemoryForgetOutcome>;
  setAgentExpression(
    face: AgentFace | "auto",
    cue: string | undefined,
    context: Context,
  ): Promise<AgentExpressionState | null>;
  handleBoardTool?(
    params: BoardToolParams,
    source: { conversationId: number },
    context: Context,
  ): Promise<Record<string, unknown>>;
}

export function createOrchestratorToolsExtension(
  controller: OrchestratorController,
  sections: ReturnType<typeof import("./prompts.js").createOrchestratorSections>,
  getMemoryConfig: () => HindsightMemoryConfig,
  getSearch?: () => KuloSearch,
  builtinMemoryTools: readonly ToolRegistration[] = [],
) {
  const deviceInviteTool = defineTool({
    name: "kulo_device_invite",
    description: "Show a copy-invitation button when the user explicitly wants another computer running Kulo to join this Hub (do not trigger on quoted invite strings inside user questions). Clicking creates the invitation for the user to paste into the other Kulo's chat. 关键词：邀请设备 配对码 接入电脑 手机互联",
    parameters: obj({}),
    deferred: true,
    replay: "safe",
    execute: async (_args, api, context) => {
      const { allowed, isSettings, state } = await isMainOrchestratorApi(api, context);
      const topicId = state?.conversationToTopic?.[String(api.conversationId)];
      if (!allowed || isSettings || (topicId && state?.topics?.[topicId]?.deletedAt) || !controller.showDeviceInvitation) {
        return { isError: true, output: [{ type: "text", text: "请从主会话邀请设备加入。" }] };
      }
      await controller.showDeviceInvitation(Number(api.conversationId), api.callId);
      return { output: [{ type: "text", text: JSON.stringify({ status: "shown" }) }] };
    },
  });
  const dispatchTool = defineTool({
    name: "kulo_dispatch",
    description: KULO_DISPATCH_DESCRIPTION,
    parameters: obj({
      command_id: str({ description: "Idempotency key; reuse on retry." }),
      title: str({ description: "Short user-visible title (8–18 chars / 3–6 words; no internal IDs or paths)." }),
      user_summary: opt(str({ description: "One-sentence panel summary." })),
      goal: str({ description: KULO_DISPATCH_GOAL_DESCRIPTION }),
      scope: str({ description: "Authorized files/modules and exclusions." }),
      acceptance: opt(str({ description: "Verification criteria." })),
      assignment: opt(str({ description: "Extra Worker instructions." })),
      context_summary: opt(str({ description: "Redacted task context (no private identity or secrets)." })),
      attachment_ids: opt(arr(str(), { maxItems: 16, description: "Chat attachment IDs (att_...) to pass." })),
      workspace_mode: opt(oneOf(["direct", "staged", "read_only"], { description: "Workspace mode: 'direct' (default in trusted mode), 'staged' (isolated copy), or 'read_only' (audits/Q&A)." })),
      target_scope: opt(oneOf(["hub_local", "sender_device"], { description: "For ungrouped tasks without env_id: 'hub_local' (research/writing/attachments) or 'sender_device' (sender files/ports/browser/desktop)." })),
      execute_at: opt(str({ description: KULO_DISPATCH_EXECUTE_AT_DESCRIPTION })),
      repeat_every_seconds: opt(num({ description: KULO_DISPATCH_REPEAT_EVERY_DESCRIPTION })),
      role: opt(str({ description: "Worker or external Agent role ID." })),
      provider_override: opt(str({ description: "Provider ID override for built-in Workers." })),
      model_override: opt(str({ description: "Model ID override for built-in Workers." })),
      task_kind: opt(oneOf(AGENT_TASK_KINDS, { description: "Task kind for default Agent routing." })),
      thinking_level: opt(oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"], { description: "Thinking effort override ('low'/'medium' preferred for interactive UI tasks when role is 'auto')." })),
      env_id: opt(str({ description: "Explicit target device ID; omit to infer from project_id/target_scope." })),
      execution_domain: opt(oneOf(["computer", "android"], { description: "'android' for phone-only Worker; 'computer' for filesystem/project work." })),
      source_request_id: opt(str({ description: "requestId from [KULO_MESSAGE_SOURCE] when disambiguating multi-device turns." })),
      android_device_ids: opt(arr(str(), { maxItems: 8, description: "Authorized Android device IDs." })),
      project_id: opt(str({ description: "Target project ID." })),
      connection_ids: opt(arr(str({ description: "Saved connection IDs to grant (never secret values)." }))),
      workspace_dir: opt(str({ description: "Explicit absolute working directory; omit for isolated table/<ticket>." })),
      inline_wait_ms: opt(int({ minimum: 0, maximum: 30_000, description: "Inline wait (0–30000 ms) for fast built-in Workers; ignored for external Agents." })),
      supersedes: opt(arr(obj({ ticket_id: str(), reason: str() }), { description: "Failed/obsolete tickets replaced once this ticket succeeds." })),
      board_id: opt(str({ description: "TaskBoard ID to link." })),
      board_title: opt(str({ description: "New TaskBoard title (multi-ticket only)." })),
      review_ticket_id: opt(str({ description: "Settled ticket ID to review (read-only)." })),
      inherit_browser_session: opt(bool({ description: "Set true to transfer this chat's active browser session (page & login state) to the Worker (requires trusted mode, writable built-in computer Worker, immediate slot, non-auto-connect session)." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const dispatchParams: DispatchTicketParams = {
        commandId: args.command_id,
        title: args.title,
        userSummary: args.user_summary,
        goal: args.goal,
        scope: args.scope,
        acceptance: args.acceptance,
        assignment: args.assignment,
        contextSummary: args.context_summary,
        attachmentIds: args.attachment_ids,
        workspaceMode: args.workspace_mode as ExternalWorkspaceMode | undefined,
        executeAt: args.execute_at,
        repeatEverySeconds: args.repeat_every_seconds,
        role: args.role,
        providerOverride: args.provider_override,
        modelOverride: args.model_override,
        taskKind: args.task_kind,
        thinkingLevel: args.thinking_level as ThinkingEffort | undefined,
        envId: args.env_id,
        targetScope: args.target_scope,
        executionDomain: args.execution_domain,
        androidDeviceIds: args.android_device_ids,
        projectId: args.project_id,
        connectionIds: args.connection_ids,
        workspaceDir: args.workspace_dir,
        inlineWaitMs: args.inline_wait_ms,
        supersedes: args.supersedes?.map((s) => ({
          ticketId: s.ticket_id,
          reason: s.reason,
        })),
        originConversationId: Number(api.conversationId),
        originToolTaskId: Number(api.taskId),
        sourceRequestId: args.source_request_id,
        ...(args.board_id?.trim() ? { boardId: args.board_id.trim() } : {}),
        ...(args.board_title?.trim() ? { boardTitle: args.board_title.trim() } : {}),
        ...(args.review_ticket_id?.trim() ? { reviewTicketId: args.review_ticket_id.trim() } : {}),
        ...(args.inherit_browser_session !== undefined ? { inheritBrowserSession: args.inherit_browser_session } : {}),
      };
      const outcome = controller.dispatchTicketForModel
        ? await controller.dispatchTicketForModel(dispatchParams, context)
        : { ticket: await controller.dispatchTicket(dispatchParams, context) };
      const payload = {
        ticket: outcome.ticket,
        ...(outcome.inlineDelivery ? { inline_delivery: outcome.inlineDelivery } : {}),
        ...(outcome.browserSessionInherited !== undefined ? { browser_session_inherited: outcome.browserSessionInherited } : {}),
        ...(outcome.browserSessionInheritReason ? { browser_session_inherit_reason: outcome.browserSessionInheritReason } : {}),
        ...(outcome.blockedByPendingMerge
          ? {
              blocked_by_pending_merge: {
                ticket_id: outcome.blockedByPendingMerge.ticketId,
                title: outcome.blockedByPendingMerge.title,
                hint: "An earlier ticket on this project still has unmerged staged changes holding the project write lock. Inspect and apply it via kulo_inspect_staged_diff / kulo_apply_staged_changes, steer it in place, or close/discard it via kulo_close before this queued write ticket can run.",
              },
            }
          : {}),
      };
      return {
        output: [{ type: "text", text: JSON.stringify(payload) }],
        details: {
          ticket: outcome.ticket,
          ...(outcome.inlineDelivery?.sources?.length ? { sources: outcome.inlineDelivery.sources } : {}),
        } as never,
      };
    },
  });

  const steerTool = defineTool({
    name: "kulo_steer",
    description:
      "Send follow-up guidance or a blocker answer to an existing Ticket (auto-steers if running; resumes if blocked/settled and not stopped). Never use to end/cancel a task—call kulo_stop.",
    parameters: obj({
      command_id: str({ description: "Unique idempotency key for this follow-up." }),
      ticket_id: str({ description: "Target Ticket ID (e.g. T-0001)." }),
      text: str({ description: "Follow-up direction, constraint, or answer to blocker." }),
      interrupt: opt(bool({ description: "For a stalled running external Agent ticket, cancel the active native turn immediately and resume its session with this corrective instruction." })),
    }),
    execute: async (args, api, context) => {
      const card = await controller.steerTicket(
        {
          commandId: args.command_id,
          ticketId: args.ticket_id,
          text: args.text,
          interrupt: args.interrupt,
          originConversationId: Number(api.conversationId),
          originToolTaskId: Number(api.taskId),
        },
        context,
      );
      return {
        output: [{ type: "text", text: JSON.stringify({ ticket: card }) }],
        details: { ticket: card } as never,
      };
    },
  });

  const stopTool = defineTool({
    name: "kulo_stop",
    description: KULO_STOP_DESCRIPTION,
    parameters: obj({
      ticket_id: str({ description: "Ticket ID to stop." }),
      reason: opt(str({ description: "Optional short reason." })),
    }),
    execute: async (args, api, context) => {
      const card = await controller.stopTicket(args.ticket_id, args.reason, context, undefined, {
        conversationId: Number(api.conversationId), toolTaskId: Number(api.taskId),
      });
      return {
        output: [{ type: "text", text: JSON.stringify({ ticket: card }) }],
        details: { ticket: card } as never,
      };
    },
  });

  const closeTool = defineTool({
    name: "kulo_close",
    description:
      "Administratively close an obsolete or superseded settled non-running Ticket (never close a waiting ticket prematurely while replacement or external dependency is still pending). 关键词：关闭工单 清理已完成工单 归档废弃任务",
    deferred: true,
    parameters: obj({
      command_id: str(),
      ticket_id: str(),
      kind: oneOf(["obsolete", "superseded"]),
      reason: str(),
      replacement_ticket_id: opt(str()),
    }),
    execute: async (args, api, context) => {
      const card = await controller.closeTicket(
        {
          commandId: args.command_id,
          originConversationId: Number(api.conversationId),
          originToolTaskId: Number(api.taskId),
          ticketId: args.ticket_id,
          kind: args.kind as TicketClosureKind,
          reason: args.reason,
          replacementTicketId: args.replacement_ticket_id,
        },
        context,
      );
      return {
        output: [{ type: "text", text: JSON.stringify({ ticket: card }) }],
        details: { ticket: card } as never,
      };
    },
  });

  const statusTicketPriority = (ticket: TicketCardView): number => {
    if (ticket.status === "waiting" || ticket.status === "blocked") return 0;
    if (ticket.status === "running" || ticket.status === "pausing") return 1;
    if (ticket.status === "queued") return 2;
    if (ticket.pendingWorkspaceApply) return 3;
    if (ticket.status === "failed" || ticket.status === "stopped") return 4;
    if (ticket.status === "ready") return 5;
    return 6;
  };
  const clipStatusText = (value: string | undefined, max: number): string | undefined => {
    if (!value) return undefined;
    const clean = value.replace(/\s+/g, " ").trim();
    if (!clean) return undefined;
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  };
  const compactStatusTicket = (ticket: TicketCardView) => {
    const report = ticket.latestReport;
    const compactReport = report
      ? {
          state: report.state,
          summary: clipStatusText(report.summary, 200) ?? "",
          ...(report.question ? { question: clipStatusText(report.question, 200) } : {}),
          at: report.at,
          hasDeliverable: Boolean(report.deliverable?.trim()),
          ...(report.overflowAsset ? { overflowAsset: report.overflowAsset } : {}),
        }
      : undefined;
    return {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      role: ticket.role,
      envId: ticket.envId,
      ...(ticket.executionDomain ? { executionDomain: ticket.executionDomain } : {}),
      ...(ticket.externalAgentKind ? { externalAgentKind: ticket.externalAgentKind } : {}),
      ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
      ...(ticket.originTopicId ? { originTopicId: ticket.originTopicId } : {}),
      ...(ticket.boardId ? { boardId: ticket.boardId } : {}),
      ...(ticket.reviewTicketId ? { reviewTicketId: ticket.reviewTicketId } : {}),
      ...(ticket.pendingWorkspaceApply ? { pendingWorkspaceApply: true } : {}),
      ...(ticket.waiting ? { waiting: ticket.waiting } : {}),
      ...(ticket.schedule ? { schedule: ticket.schedule } : {}),
      ...(ticket.stoppedReason ? { stoppedReason: clipStatusText(ticket.stoppedReason, 200) } : {}),
      ...(ticket.recovery ? { recovery: ticket.recovery } : {}),
      ...(ticket.subagentSummary ? { subagentSummary: ticket.subagentSummary } : {}),
      ...(ticket.androidDeviceIds?.length ? { androidDeviceIds: ticket.androidDeviceIds } : {}),
      updatedAt: ticket.updatedAt,
      ...(compactReport ? { latestReport: compactReport } : {}),
    };
  };
  const compactStatusEnv = (env: EnvNodeDescriptor) => ({
    id: env.id,
    name: env.name,
    online: env.online,
    platform: env.platform,
    arch: env.arch,
    ...(env.executionKind ? { executionKind: env.executionKind } : {}),
    capabilities: env.capabilities,
    rootDir: env.rootDir,
    ...(env.android
      ? {
          android: {
            enabled: env.android.enabled,
            paused: env.android.paused,
          },
        }
      : {}),
  });

  const statusTool = defineTool({
    name: "kulo_status",
    description:
      "Inspect current time/timezone, compact table tickets (default top 15 non-closed; use kulo_inspect for full details), slots, and execution nodes.",
    replay: "safe",
    parameters: obj({
      include_closed: opt(bool({ description: "Include closed tickets (default false)." })),
      limit: opt(num({ description: "Max tickets (1–50, default 15)." })),
    }),
    execute: async (args, api, context) => {
      const board = await controller.getBoardSnapshot(context);
      const includeClosed = args.include_closed === true;
      const limit = args.limit !== undefined && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(50, Math.trunc(args.limit)))
        : 15;
      const filtered = includeClosed
        ? board.tickets
        : board.tickets.filter((ticket) => ticket.status !== "closed");
      const ordered = [...filtered].sort(
        (a, b) =>
          statusTicketPriority(a) - statusTicketPriority(b) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id),
      );
      const selected = ordered.slice(0, limit).map(compactStatusTicket);
      const payload = {
        tickets: selected,
        total_tickets: filtered.length,
        truncated: ordered.length > selected.length,
        slots: board.slots,
        envs: board.envs.map(compactStatusEnv),
        current_time: new Date(api.now()).toISOString(),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      return {
        output: [{ type: "text", text: JSON.stringify(payload) }],
      };
    },
  });

  const inspectTool = defineTool({
    name: "kulo_inspect",
    description:
      "Read-only lightweight inspection of a Worker ticket's live generation stream, active tool calls, run failures, and latest 10 transcript entries. Use upon [KULO_WORKER_WATCHDOG] or when the user asks what a running Worker is doing. 关键词：查看工单详情 运行进度 子任务日志 检查工单",
    deferred: true,
    replay: "safe",
    parameters: obj({
      ticket_id: str({ description: "Ticket ID to inspect (e.g. T-0001)." }),
    }),
    execute: async (args, _api, context) => {
      const detail = await controller.inspectWorker(args.ticket_id, context);
      return {
        output: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
      };
    },
  });

  const externalPermissionTool = defineTool({
    name: "kulo_external_permission",
    description: "Handle a local external Agent's native permission request (main Agent only). Evaluate it against the user's real goal first: call `mode='decide'` (default) with exact `choice_id` to approve/reject directly (prefer single-use allow over permanent global grants, and settle any open card), or call `mode='ask_user'` (omit `choice_id`) to present an interactive confirmation card (native choices + manual input) when risky or needing user choice. 关键词：外部智能体权限审批 授权决定 允许拒绝",
    deferred: true,
    parameters: obj({
      ticket_id: str(),
      run_epoch: num(),
      permission_id: str(),
      mode: opt(oneOf(["decide", "ask_user"])),
      choice_id: opt(str({ description: "Required when mode='decide' (default): exact native choice ID." })),
      reason: opt(str({ description: "Optional concise risk summary shown to the user when mode='ask_user'." })),
    }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed || (!controller.handleExternalAgentPermission && !controller.respondExternalAgentPermission)) {
        return { isError: true, output: [{ type: "text" as const, text: "Only the Kulo Orchestrator may handle native Agent permission decisions." }] };
      }
      const mode = args.mode ?? "decide";
      if (mode === "decide" && !args.choice_id?.trim()) {
        return { isError: true, output: [{ type: "text" as const, text: "mode='decide' 时必须提供有效的 choice_id。" }] };
      }
      const result = controller.handleExternalAgentPermission
        ? await controller.handleExternalAgentPermission(
            {
              ticketId: args.ticket_id,
              permissionId: args.permission_id,
              ...(args.choice_id?.trim() ? { choiceId: args.choice_id.trim() } : {}),
              runEpoch: args.run_epoch,
              mode,
              ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
            },
            { conversationId: Number(api.conversationId), callId: api.callId },
            context,
          )
        : await controller.respondExternalAgentPermission!(args.ticket_id, args.permission_id, args.choice_id!.trim(), args.run_epoch, context);
      return { output: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  });

  const ticketAskUserTool = defineTool({
    name: "kulo_ticket_ask_user",
    description:
      "Escalate a waiting/blocked Worker Ticket to the user ONLY when the main Agent genuinely needs human judgment or risk consent. Provide a concise question in the active conversation language (no internal IDs/logs) and concrete clickable options (e.g. 允许/拒绝 or discrete solution choices; set action='stop' on any option that cancels/declines/ends the ticket directly); shows an interactive card with options + manual input by default and syncs Task Detail without blocking chat. 关键词：向用户确认 任务决策卡片 升级用户确认",
    deferred: true,
    parameters: obj({
      ticket_id: str({ description: "Target waiting/blocked Ticket ID." }),
      question: str({ description: "Concise user-facing question in the active conversation language." }),
      options: opt(
        arr(
          obj({
            id: str({ minLength: 1, maxLength: 64 }),
            label: str({ minLength: 1, maxLength: 120 }),
            tone: opt(oneOf(["primary", "secondary", "danger"])),
            value: opt(str({ maxLength: 400 })),
            action: opt(oneOf(["reply", "stop"], { description: "'reply' (default) resumes the Worker with this choice; set 'stop' for options that cancel/decline/end this ticket directly without waking the Worker." })),
          }),
          { maxItems: 11, description: "Optional quick-action buttons shown alongside manual input." },
        ),
      ),
      show_card: opt(bool({ description: "Default true: show interactive decision card in chat; set false to ask purely via text while still syncing Task Detail." })),
    }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed || !controller.askUserForTicket) {
        return { isError: true, output: [{ type: "text" as const, text: "Only the Kulo Orchestrator may escalate a ticket to the user." }] };
      }
      const outcome = await controller.askUserForTicket(
        {
          ticketId: args.ticket_id,
          question: args.question,
          ...(args.options?.length ? { options: args.options as TicketWaitOption[] } : {}),
          ...(args.show_card !== undefined ? { showCard: args.show_card } : {}),
        },
        { conversationId: Number(api.conversationId), callId: api.callId },
        context,
      );
      return { output: [{ type: "text" as const, text: JSON.stringify(outcome) }] };
    },
  });

  const inspectStagedDiffTool = defineTool({
    name: "kulo_inspect_staged_diff",
    description:
      "Inspect the isolated staged workspace diff produced by a Worker or external Agent Ticket before merging back into the real project directory. Omit file_path for the overall summary and preview, or specify file_path for a file's full unified diff. 关键词：查看暂存改动 代码差异 diff 审查补丁",
    deferred: true,
    replay: "safe",
    parameters: obj({
      ticket_id: str({ description: "Staged Ticket ID (e.g. T-0001)." }),
      file_path: opt(str({ description: "Optional relative path inside the project workspace to inspect its complete diff." })),
    }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed || !controller.inspectStagedDiff) {
        return { isError: true, output: [{ type: "text" as const, text: "Only the Kulo Orchestrator may inspect staged workspace diffs." }] };
      }
      const detail = await controller.inspectStagedDiff(args.ticket_id, args.file_path, context);
      return { output: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] };
    },
  });

  const applyStagedChangesTool = defineTool({
    name: "kulo_apply_staged_changes",
    description:
      "Merge reviewed Worker or external Agent staged workspace changes back into the authorized project directory and clean up the isolated staged clone. Executes directly with main-Agent authority once you have verified the diff; set `ask_user=true` only when you want user confirmation first (e.g. risky changes or unresolved concurrent conflicts). 关键词：合并暂存改动 应用代码补丁 落地工作区修改",
    deferred: true,
    parameters: obj({
      command_id: str({ description: "Unique idempotency key for this staged merge." }),
      ticket_id: str({ description: "Settled Ticket ID whose staged changes were reviewed." }),
      paths: opt(arr(str(), { description: "Optional subset of relative file paths to apply; omit to apply all staged changes." })),
      allow_conflicts: opt(bool({ description: "Set true when overriding concurrent source-file conflicts after review." })),
      ask_user: opt(bool({ description: "Optional: set true to present a confirmation card before merging." })),
    }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed || (!controller.applyStagedChangesFromTool && !controller.applyStagedChanges)) {
        return { isError: true, output: [{ type: "text" as const, text: "Only the Kulo Orchestrator may apply staged workspace changes." }] };
      }
      const applyInput: ApplyStagedChangesParams = {
        commandId: args.command_id,
        ticketId: args.ticket_id,
        paths: args.paths,
        allowConflicts: args.allow_conflicts,
        askUser: args.ask_user,
        originConversationId: Number(api.conversationId),
      };
      const applied = controller.applyStagedChangesFromTool
        ? await controller.applyStagedChangesFromTool(applyInput, { conversationId: Number(api.conversationId), callId: api.callId }, context)
        : await controller.applyStagedChanges!(applyInput, context);
      return { output: [{ type: "text" as const, text: JSON.stringify(applied, null, 2) }] };
    },
  });

  const identityReadTool = defineTool({
    name: "kulo_identity_read",
    description:
      "Read Kulo's Identity Agreement ('identity-agreement.md') or Working Relationship ('relationship.md') (Orchestrator only). Identity changes require `kulo_identity_propose` and user confirmation; explicit user relationship edits use `kulo_relationship_update`. 关键词：读取身份协议 协作关系 身份文档 人设",
    deferred: true,
    replay: "safe",
    parameters: obj({
      file: opt(
        oneOf(IDENTITY_FILES, {
          description: "Specific document to read ('identity-agreement.md' or 'relationship.md'), or omit to list metadata for both.",
        }),
      ),
    }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed) {
        return {
          isError: true,
          output: [{ type: "text", text: "Forbidden: identity and relationship files are accessible only to the Kulo Orchestrator." }],
        };
      }
      const data = await controller.readIdentityFiles(args.file as IdentityFile | undefined);
      const addTools = await resolveDeferredAddTools(api, context, [
        "kulo_identity_propose",
        "kulo_relationship_update",
      ]);
      return {
        output: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        ...(addTools.length ? { control: { addTools } } : {}),
      };
    },
  });

  const identityProposalTool = defineTool({
    name: "kulo_identity_propose",
    description: "Propose a complete revised Identity Agreement as a reviewable diff without overwriting the active file; ask the user to review and confirm in Identity & Memory. 关键词：修改身份协议 人设提案 自我介绍 语气性格",
    deferred: true,
    parameters: obj({ content: str(), summary: str() }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed) return { isError: true, output: [{ type: "text" as const, text: "Forbidden: only the Kulo Orchestrator may propose identity changes." }] };
      const proposal = await controller.proposeIdentity(args.content, args.summary);
      return { output: [{ type: "text" as const, text: JSON.stringify({ proposal, requiresUserConfirmation: true }) }] };
    },
  });

  const relationshipUpdateTool = defineTool({
    name: "kulo_relationship_update",
    description: "Save relationship.md when the user explicitly asks to remember or correct their preferences or background. First read relationship.md for its current version. Autonomous maintenance uses the configured schedule. Cannot change identity or principles. 关键词：更新协作关系 记住偏好 相处习惯 称呼背景",
    deferred: true,
    parameters: obj({ content: str(), summary: str(), expected_directory_revision: num(), expected_sha256: str({ description: "SHA-256 from the last read, or 'missing' when sha256 is null." }) }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed) return { isError: true, output: [{ type: "text" as const, text: "Forbidden: only the Kulo Orchestrator may edit working relationship." }] };
      const saved = await controller.updateRelationship({ content: args.content, summary: args.summary,
        expected: { directoryRevision: args.expected_directory_revision, sha256: args.expected_sha256 === "missing" ? null : args.expected_sha256 } });
      return { output: [{ type: "text" as const, text: JSON.stringify(saved) }] };
    },
  });

  const expressionTool = defineTool({
    name: "kulo_expression",
    description:
      "Update Kulo's live LED matrix avatar expression in the sidebar ('idle' | 'thinking' | 'working' | 'happy' | 'waiting' | 'error' | 'auto') with an optional short mood cue (<= 24 chars). 关键词：头像表情 猫咪表情 情绪心情 状态提示",
    deferred: true,
    parameters: obj({
      face: oneOf(["idle", "thinking", "working", "happy", "waiting", "error", "auto"]),
      cue: opt(str({ description: "Optional short mood cue (<= 24 chars)." })),
    }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed) {
        return {
          isError: true,
          output: [{ type: "text", text: "Forbidden: Only Kulo Orchestrator may update avatar expression." }],
        };
      }
      const next = await controller.setAgentExpression(
        args.face as AgentFace | "auto",
        args.cue,
        context,
      );
      return {
        output: [{ type: "text", text: JSON.stringify({ expression: next ?? { face: "auto" } }) }],
      };
    },
  });

  const boardTool = defineTool({
    name: "kulo_task_board",
    description:
      "Search, read, or update coordinator-verified Task Boards that connect multi-ticket workstreams across long conversations (never create boards for trivial one-off tasks). Use action='search' to recall older workstreams, 'read' to inspect verified decisions/constraints, or 'write' (with command_id) after reviewing Worker reports to promote verified conclusions or archive/reopen a board. 关键词：交接板 协作板 历史任务脉络 继续上次任务 归档看板 task board handoff",
    deferred: true,
    parameters: obj({
      action: oneOf(["search", "read", "write"], { description: "'search' | 'read' | 'write'." }),
      query: opt(str({ description: "For action='search': keywords, project/topic phrase, or ticket/board ID." })),
      include_archived: opt(bool({ description: "For action='search': include archived boards (default true)." })),
      board_id: opt(str({ description: "Target TaskBoard ID (e.g. 'B-0001') for 'read' or updating an existing board." })),
      command_id: opt(str({ description: "Required for action='write': unique idempotency key." })),
      board_title: opt(str({ description: "For action='write': title (<= 60 chars) when lazily creating or renaming a board." })),
      goal: opt(str({ description: "For action='write': concise mission goal (<= 240 chars)." })),
      ticket_id: opt(str({ description: "For action='write': optional reviewed Ticket ID to link and attach deterministic file/artifact anchors." })),
      kind: opt(oneOf(["verified", "decision", "constraint", "handoff", "correction"], { description: "For action='write': entry category (default 'verified')." })),
      note: opt(str({ description: "For action='write': coordinator-verified concise takeaway (<= 320 chars; no secrets)." })),
      supersedes_seq: opt(num({ description: "For action='write': optional older entry seq number superseded by this new note." })),
      status: opt(oneOf(["active", "archived"], { description: "For action='write': set 'archived' when finished or 'active' to reopen." })),
    }),
    execute: async (args, api, context) => {
      const main = await isMainOrchestratorApi(api, context);
      if (!main.allowed || main.isSettings || !controller.handleBoardTool) {
        return { isError: true, output: [{ type: "text" as const, text: "Only the Kulo main chat Orchestrator may manage Task Boards." }] };
      }
      const res = await controller.handleBoardTool(
        {
          action: args.action,
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.include_archived !== undefined ? { includeArchived: args.include_archived } : {}),
          ...(args.board_id !== undefined ? { boardId: args.board_id } : {}),
          ...(args.command_id !== undefined ? { commandId: args.command_id } : {}),
          ...(args.board_title !== undefined ? { boardTitle: args.board_title } : {}),
          ...(args.goal !== undefined ? { goal: args.goal } : {}),
          ...(args.ticket_id !== undefined ? { ticketId: args.ticket_id } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(args.supersedes_seq !== undefined ? { supersedesSeq: args.supersedes_seq } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
        },
        { conversationId: Number(api.conversationId) },
        context,
      );
      return { output: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    },
  });

  const hindsightTools = createHindsightTools({
    getMemoryConfig,
    defaultBank: "private",
    ...(controller.getForgottenTerms ? { getForgottenTerms: () => controller.getForgottenTerms!() } : {}),
    ...(controller.forgetMemory ? { forgetMemory: (term, reason, caller, signal) => controller.forgetMemory!(term, reason, caller, signal) } : {}),
  });

  return defineExtension({
    name: "kulo-orchestrator",
    sections,
    tools: [
      ...(controller.showDeviceInvitation ? [deviceInviteTool] : []),
      dispatchTool,
      steerTool,
      stopTool,
      closeTool,
      ...(controller.handleBoardTool ? [boardTool] : []),
      statusTool,
      inspectTool,
      ...(controller.respondExternalAgentPermission ? [externalPermissionTool] : []),
      ...(controller.askUserForTicket ? [ticketAskUserTool] : []),
      ...(controller.inspectStagedDiff ? [inspectStagedDiffTool] : []),
      ...(controller.applyStagedChanges ? [applyStagedChangesTool] : []),
      identityReadTool,
      identityProposalTool,
      relationshipUpdateTool,
      expressionTool,
      createWebFetchTool({ getSearch, ...controller.webFetchContext }),
      createWebSearchTool(getSearch),
      ...hindsightTools,
      ...builtinMemoryTools,
      ...(controller.connections ? createConnectionTools(controller.connections, "orchestrator") : []),
      ...(controller.hostActions
        ? [createHostActionTool(controller.hostActions, "orchestrator"), createHostActionDecideTool(controller.hostActions)]
        : []),
    ],
  });
}
