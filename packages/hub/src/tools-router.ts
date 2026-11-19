import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
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
  type WorkerInspectResult,
} from "@kulo/protocol";
import { isMainOrchestratorApi } from "./settings-doc.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import { createHindsightTools } from "./tools-memory.js";
import { createWebSearchTool } from "./tools-search.js";
import { createWebFetchTool } from "./tools-worker.js";
import type { KuloSearch } from "./search.js";
import { createConnectionTools, type ConnectionToolController } from "./tools-connections.js";

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
}

export interface DispatchTicketModelOutcome {
  ticket: TicketCardView;
  inlineDelivery?: {
    state: import("@kulo/protocol").WorkerReportState;
    summary: string;
    deliverable?: string | null;
    sources?: import("@kulo/protocol").WebSource[];
    stagedDiff?: import("@kulo/protocol").StagedWorkspaceDiffSummary;
  };
  blockedByPendingMerge?: {
    ticketId: string;
    title: string;
  };
}

export interface SteerTicketParams {
  commandId: string;
  ticketId: string;
  text: string;
  replyTo?: ChatReplyReference;
  attachments?: ChatAttachment[];
  principalId?: string;
  originConversationId?: number;
  originToolTaskId?: number;
  resetRecovery?: boolean;
  interrupt?: boolean;
}

export interface ApplyStagedChangesParams {
  commandId: string;
  ticketId: string;
  paths?: string[];
  allowConflicts?: boolean;
  originConversationId?: number;
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
  showDeviceInvitation?(conversationId: number, callId: string): Promise<void>;
  dispatchTicket(params: DispatchTicketParams, context: Context): Promise<TicketCardView>;
  dispatchTicketForModel?(params: DispatchTicketParams, context: Context): Promise<DispatchTicketModelOutcome>;
  steerTicket(params: SteerTicketParams, context: Context): Promise<TicketCardView>;
  stopTicket(ticketId: string, reason: string | undefined, context: Context,
    commandId?: string, origin?: { conversationId: number; toolTaskId: number }): Promise<TicketCardView>;
  closeTicket(params: CloseTicketParams, context: Context): Promise<TicketCardView>;
  inspectWorker(ticketId: string, context: Context): Promise<WorkerInspectResult>;
  respondExternalAgentPermission?(ticketId: string, permissionId: string, choiceId: string, runEpoch: number, context: Context): Promise<WorkerInspectResult>;
  confirmExternalAgentPermission?(
    ticketId: string,
    permissionId: string,
    choiceId: string,
    runEpoch: number,
    source: { conversationId: number; callId: string },
    context: Context,
  ): Promise<WorkerInspectResult | Record<string, unknown>>;
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
  setAgentExpression(
    face: AgentFace | "auto",
    cue: string | undefined,
    context: Context,
  ): Promise<AgentExpressionState | null>;
}

export function createOrchestratorToolsExtension(
  controller: OrchestratorController,
  sections: ReturnType<typeof import("./prompts.js").createOrchestratorSections>,
  getMemoryConfig: () => HindsightMemoryConfig,
  getSearch?: () => KuloSearch,
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
    description:
      "Dispatch authorized work as a durable Worker Ticket. Project/bound tasks lock to their configured Env; set target_scope='hub_local' for location-independent compute/research/attachment work or target_scope='sender_device' for sender-machine files/ports/GUI. Set execution_domain='android' for phone-only work or list android_device_ids for mixed tasks. Reuse command_id on retry.",
    parameters: obj({
      command_id: str({ description: "Idempotency key; reuse on retry." }),
      title: str({ description: "Short user-visible title (8–18 chars / 3–6 words; no internal IDs or paths)." }),
      user_summary: opt(str({ description: "One-sentence panel summary." })),
      goal: str({ description: "Clear task objective." }),
      scope: str({ description: "Authorized files/modules and exclusions." }),
      acceptance: opt(str({ description: "Verification criteria." })),
      assignment: opt(str({ description: "Extra Worker instructions." })),
      context_summary: opt(str({ description: "Redacted task context (no private identity or secrets)." })),
      attachment_ids: opt(arr(str(), { maxItems: 16, description: "Chat attachment IDs (att_...) to pass." })),
      workspace_mode: opt(oneOf(["staged", "read_only"], { description: "Project workspace isolation mode ('staged' default for review-before-merge, or 'read_only')." })),
      target_scope: opt(oneOf(["hub_local", "sender_device"], { description: "For ungrouped computer tasks without explicit env_id: 'hub_local' for location-independent research/writing/uploaded attachments; 'sender_device' when accessing the sender machine's local files, ports, browser, or desktop." })),
      execute_at: opt(str({ description: "ISO 8601 timestamp with timezone for scheduled execution." })),
      repeat_every_seconds: opt(num({ description: "Positive integer interval in seconds (requires execute_at)." })),
      role: opt(str({ description: "Worker or external Agent role ID." })),
      provider_override: opt(str({ description: "Provider ID override for built-in Workers." })),
      model_override: opt(str({ description: "Model ID override for built-in Workers." })),
      task_kind: opt(oneOf(AGENT_TASK_KINDS, { description: "Task kind for default Agent routing." })),
      thinking_level: opt(oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"], { description: "Thinking effort override." })),
      env_id: opt(str({ description: "Explicit user-named or bound target device ID; omit to resolve from project_id or target_scope." })),
      execution_domain: opt(oneOf(["computer", "android"], { description: "'android' for phone-only Worker; 'computer' for filesystem/project work." })),
      source_request_id: opt(str({ description: "requestId from [KULO_MESSAGE_SOURCE] when disambiguating multi-device turns." })),
      android_device_ids: opt(arr(str(), { maxItems: 8, description: "Authorized Android device IDs." })),
      project_id: opt(str({ description: "Target project ID." })),
      connection_ids: opt(arr(str({ description: "Saved connection IDs to grant (never secret values)." }))),
      workspace_dir: opt(str({ description: "Explicit absolute working directory; omit for isolated table/<ticket>." })),
      inline_wait_ms: opt(num({ description: "Optional inline wait window (0–15000 ms) when slots are free; fast ready outcomes return inline without duplicate relay." })),
      supersedes: opt(arr(obj({ ticket_id: str(), reason: str() }), { description: "Failed/obsolete tickets replaced once this ticket succeeds." })),
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
      };
      const outcome = controller.dispatchTicketForModel
        ? await controller.dispatchTicketForModel(dispatchParams, context)
        : { ticket: await controller.dispatchTicket(dispatchParams, context) };
      const payload = {
        ticket: outcome.ticket,
        ...(outcome.inlineDelivery ? { inline_delivery: outcome.inlineDelivery } : {}),
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
      "Send a follow-up instruction or answer a blocked question to an existing background Ticket. If running, injects seamlessly at the Worker's next step boundary (Auto-Steer); if blocked or settled (and not human-stopped), wakes and resumes the Worker.",
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
    description:
      "Immediately stop a Ticket upon explicit human request. Human-stopped tickets never auto-resume.",
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

  const statusTool = defineTool({
    name: "kulo_status",
    description:
      "Inspect current time and Hub timezone, Kulo's table tickets, slot usage, and connected execution nodes. Read before translating relative scheduling requests such as tomorrow morning into execute_at.",
    replay: "safe",
    parameters: obj({}),
    execute: async (_args, api, context) => {
      const board = await controller.getBoardSnapshot(context);
      return {
        output: [{ type: "text", text: JSON.stringify({ ...board, current_time: new Date(api.now()).toISOString(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, null, 2) }],
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
    description: "Relay the user's decision for an actual native client permission request. First use kulo_inspect and preserve its run_epoch and exact permission/choice IDs. The client owns its permission policy; present its original choices without changing them or deciding on the user's behalf. 关键词：外部智能体权限审批 授权决定 允许拒绝",
    deferred: true,
    parameters: obj({ ticket_id: str(), run_epoch: num(), permission_id: str(), choice_id: str() }),
    execute: async (args, api, context) => {
      if (!(await isMainOrchestratorApi(api, context)).allowed || (!controller.confirmExternalAgentPermission && !controller.respondExternalAgentPermission)) {
        return { isError: true, output: [{ type: "text" as const, text: "Only the Kulo Orchestrator may relay native Agent permission decisions." }] };
      }
      const result = controller.confirmExternalAgentPermission
        ? await controller.confirmExternalAgentPermission(
            args.ticket_id,
            args.permission_id,
            args.choice_id,
            args.run_epoch,
            { conversationId: Number(api.conversationId), callId: api.callId },
            context,
          )
        : await controller.respondExternalAgentPermission!(args.ticket_id, args.permission_id, args.choice_id, args.run_epoch, context);
      return { output: [{ type: "text" as const, text: JSON.stringify(result) }] };
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
      "Merge reviewed Worker or external Agent staged workspace changes back into the authorized project directory and clean up the isolated staged clone. If conflictFiles or [HIGH-SENSITIVITY PATHS] are reported, ask the user first before merging (and set allow_conflicts=true only on explicit user confirmation). 关键词：合并暂存改动 应用代码补丁 落地工作区修改",
    deferred: true,
    parameters: obj({
      command_id: str({ description: "Unique idempotency key for this staged merge." }),
      ticket_id: str({ description: "Settled Ticket ID whose staged changes were reviewed." }),
      paths: opt(arr(str(), { description: "Optional subset of relative file paths to apply; omit to apply all staged changes." })),
      allow_conflicts: opt(bool({ description: "Only set true after explicit user confirmation when source files changed concurrently." })),
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

  const hindsightTools = createHindsightTools({
    getMemoryConfig,
    defaultBank: "private",
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
      statusTool,
      inspectTool,
      ...(controller.respondExternalAgentPermission ? [externalPermissionTool] : []),
      ...(controller.inspectStagedDiff ? [inspectStagedDiffTool] : []),
      ...(controller.applyStagedChanges ? [applyStagedChangesTool] : []),
      identityReadTool,
      identityProposalTool,
      relationshipUpdateTool,
      expressionTool,
      createWebFetchTool(getSearch),
      createWebSearchTool(getSearch),
      ...hindsightTools,
      ...(controller.connections ? createConnectionTools(controller.connections, "orchestrator") : []),
    ],
  });
}
