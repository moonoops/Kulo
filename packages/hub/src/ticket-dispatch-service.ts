import {
  BACKGROUND_CONTEXT,
  withoutAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import { canonicalExecutionPath, type EnvManager } from "@kulo/env";
import type {
  AgentAssignment,
  AgentDispatchIntent,
  BuiltinThinkingEffort,
  ThinkingEffort,
  TicketCardView,
  TicketRecord,
} from "@kulo/protocol";
import { capturedAgentIntent, extractAgentDispatchIntent } from "./agent-routing.js";
import { chatRoutingData } from "./chat-submissions.js";
import {
  assistantEntryHasBrowserCall,
  type ComputerBrowserTransferPort,
} from "./computer-session-transfer.js";
import type { KuloConnections } from "./connections.js";
import { redactCredentialData } from "./credential-redaction.js";
import { collectCoordinatorEvidencePaths, formatEvidenceManifest } from "./dispatch-evidence-manifest.js";
import { inferDispatchWorkspace, isDedicatedRemoteRoot } from "./dispatch-workspace-infer.js";
import { reconcileTopicRoutingTarget } from "./env-routing-policy.js";
import { WORKER_MAX_TURNS } from "./run-health-policy.js";
import type {
  HubRuntimeGates,
  InlineDispatchWaiters,
  LiveSettingsStore,
  TurnContextReader,
} from "./hub-kernel-ports.js";
import {
  KuloProjects,
  KuloProjectsDoc,
  ProjectError,
} from "./projects.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import {
  isActiveSettingsConversation,
  SettingsAssistantDoc,
  settingsTopicId,
} from "./settings-assistant.js";
import {
  CoordinatorEventEntry,
  isLegacyInternalUserEntry,
  isOrchestratorConversation,
  isRecoveryInputBoundary,
  KuloStateDoc,
  MediaRelayEntry,
  ticketsShareWriteScope,
  toTicketCardView,
  WorkerRecoveryEntry,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
} from "./state.js";
import { assertRecoveryGuard } from "./task-recovery.js";
import { validateReviewTargetTicket } from "./ticket-review-pack.js";
import {
  admitDispatchInTx,
  bindDispatchedAttachments,
  checkDispatchAdmission,
  findPendingMergeBlocker,
  parseDispatchSchedule,
  resolveDispatchAgentAndEnv,
  resolveDispatchDomain,
  resolveDispatchWorkspaceAndModel,
  type DispatchSourceContext,
} from "./ticket-dispatch.js";
import type { DispatchTicketModelOutcome, DispatchTicketParams } from "./tools-router.js";
import { parseUserEntryContent, type KuloUploadStore } from "./uploads.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export interface TicketDispatchWorkerOps {
  workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  resolveWorkerAgent: (
    providerOpt: string | undefined,
    modelId: string,
    desiredThinking: ThinkingEffort,
  ) => { model: { provider: string; modelId: string }; thinkingLevel: BuiltinThinkingEffort };
  workerTools: (options: {
    executionDomain: "computer" | "android" | undefined;
    androidTargetIds: readonly string[];
    allowSubagents: boolean;
    readOnly?: boolean;
    hasProject?: boolean;
  }) => Pick<AgentChange, "extensions" | "tools">;
  discardTicketStagedWorkspace: (ticket: Readonly<TicketRecord>) => Promise<unknown>;
}

export interface TicketDispatchServiceDeps {
  harness: Harness;
  getRootConversation: () => Conversation;
  inlineDispatchWaitMs: number;
  envManager: EnvManager;
  projects: KuloProjects;
  uploads: KuloUploadStore;
  connectionManager: KuloConnections;
  liveSettings: LiveSettingsStore;
  runtimeGates: HubRuntimeGates;
  inlineWaiters: InlineDispatchWaiters;
  turnContext: TurnContextReader;
  computerTransfer?: ComputerBrowserTransferPort;
  workerOps: TicketDispatchWorkerOps;
}

export class TicketDispatchService {
  readonly #deps: TicketDispatchServiceDeps;

  constructor(deps: TicketDispatchServiceDeps) {
    this.#deps = deps;
  }

  /** Dispatch a durable Worker Ticket onto Kulo's table. */
  async dispatchTicket(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TicketCardView> {
    return (await this.#dispatchTicketInternal(params, context)).card;
  }

  async #dispatchTicketInternal(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{
    card: TicketCardView;
    browserSessionInherited?: boolean;
    browserSessionInheritReason?: string;
  }> {
    const {
      harness,
      getRootConversation,
      inlineDispatchWaitMs,
      envManager,
      projects,
      uploads,
      connectionManager,
      liveSettings,
      runtimeGates,
      turnContext,
      computerTransfer,
      workerOps,
    } = this.#deps;

    params = redactCredentialData(params, (text) => connectionManager.redact(text));
    const inputs = await turnContext.currentControlInputs(params.originConversationId, context, params.originToolTaskId);
    const recoveryGuard = inputs[0] && WorkerRecoveryEntry.is(inputs[0]) ? inputs[0].data : undefined;
    const originConversationId = params.originConversationId ?? Number(getRootConversation().id);
    const settingsSnapshotLive = liveSettings.get();
    const activeRoles = settingsSnapshotLive.roles;
    const activeExternalClients = settingsSnapshotLive.externalClients;
    const activeLanguage = settingsSnapshotLive.presentation.language;
    const existingState = await harness.snapshot(KuloStateDoc, context);
    const modelDispatch = !params.parentTicketId && params.originToolTaskId !== undefined;
    const selectedInput = params.sourceRequestId
      ? inputs.find((input) => chatRoutingData(input).requestId === params.sourceRequestId)
      : inputs[0];
    if (params.sourceRequestId && (!modelDispatch || !selectedInput)) {
      throw new ProjectError(409, "source_message_unavailable", "请使用当前待处理消息的 requestId 指定任务来源。");
    }
    const dispatchSource: DispatchSourceContext = modelDispatch
      ? await this.agentDispatchSource(
          params.originConversationId,
          params.originToolTaskId,
          context,
          params.sourceRequestId ? selectedInput?.id : undefined,
        )
      : { intent: undefined, entryId: undefined, inheritedAssignment: undefined, input: undefined, continuing: false };
    const rawSender = chatRoutingData(modelDispatch ? selectedInput ?? dispatchSource.input : undefined);

    const prior = checkDispatchAdmission({
      state: existingState,
      paused: settingsSnapshotLive.executor.paused,
      params,
      originConversationId,
      dispatchSource,
      activeRoles,
      externalClients: activeExternalClients,
      language: activeLanguage,
    });
    if (prior) {
      bindDispatchedAttachments(uploads, prior);
      return {
        card: toTicketCardView(prior, activeRoles),
        ...(params.inheritBrowserSession ? { browserSessionInherited: Boolean(prior.inheritedBrowserSession) } : {}),
      };
    }

    const executeAt = parseDispatchSchedule(params.executeAt, params.repeatEverySeconds, Boolean(recoveryGuard));
    if (existingState) assertRecoveryGuard(existingState, recoveryGuard);
    if (recoveryGuard && !params.projectId && !params.workspaceDir) {
      params.workspaceDir = existingState!.tickets[recoveryGuard.ticketId]!.workspaceDir;
    }

    const connectionIds = [...new Set(params.connectionIds ?? [])];
    let connectionRevisions: Record<string, number> = {};
    if (connectionIds.length > 32 || connectionIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("任务连接授权无效。");
    }
    if (connectionIds.length) {
      const available = (await connectionManager.snapshot()).connections;
      const known = new Set(available.map((connection) => connection.id));
      if (connectionIds.some((id) => !known.has(id))) throw new Error("任务引用了不存在的连接。");
      connectionRevisions = Object.fromEntries(
        available
          .filter((connection) => connectionIds.includes(connection.id))
          .map((connection) => [connection.id, connection.revision]),
      );
    }

    const settingsSnapshot = await harness.snapshot(SettingsAssistantDoc, context);
    const projectsSnapshot = params.reviewTicketId?.trim()
      ? await harness.snapshot(KuloProjectsDoc, context)
      : undefined;
    const reviewTarget = params.reviewTicketId?.trim()
      ? validateReviewTargetTicket(existingState, projectsSnapshot, settingsSnapshot, originConversationId, params.reviewTicketId)
      : undefined;
    if (reviewTarget && params.projectId?.trim() && reviewTarget.projectId && params.projectId.trim() !== reviewTarget.projectId) {
      throw new ProjectError(409, "review_project_mismatch", "评审工单指定的项目与被评审任务所属项目不一致。");
    }
    const originIsSettings =
      !isOrchestratorConversation(originConversationId, existingState) &&
      isActiveSettingsConversation(originConversationId, settingsSnapshot);
    const resolvedOriginTopicId = originIsSettings
      ? settingsTopicId(originConversationId)
      : existingState?.conversationToTopic?.[String(originConversationId)] ?? "root";
    const originTopic = originIsSettings ? undefined : existingState?.topics?.[resolvedOriginTopicId];
    if (originTopic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
    const sender = originTopic
      ? { ...rawSender, targetDeviceId: reconcileTopicRoutingTarget(rawSender.targetDeviceId, originTopic.targetDeviceId, true) }
      : rawSender;
    if (
      sender.source &&
      dispatchSource.continuing &&
      Object.values(existingState?.tickets ?? {}).some(
        (ticket) =>
          ticket.originTopicId === resolvedOriginTopicId &&
          !ticket.parentTicketId &&
          !["stopped", "closed"].includes(ticket.status),
      )
    ) {
      throw new ProjectError(409, "continue_existing_ticket", "请使用 kulo_steer 继续所指的原工单，沿用其执行设备和任务范围。");
    }
    if (params.workspaceMode !== undefined && !["staged", "direct", "read_only"].includes(params.workspaceMode)) {
      throw new ProjectError(400, "invalid_workspace_mode", "工作区隔离模式无效。");
    }
    if (modelDispatch && params.workspaceMode === "direct" && envManager.getExecutionTrustMode() !== "trusted") {
      throw new ProjectError(400, "invalid_workspace_mode", "项目写任务在隔离沙箱模式下默认在隔离副本（staged）中执行，模型不能直接指定 direct 模式。");
    }
    if (params.targetScope !== undefined && !["hub_local", "sender_device"].includes(params.targetScope)) {
      throw new ProjectError(400, "invalid_target_scope", "任务目标位置参数无效。");
    }
    const contextSummary = params.contextSummary?.trim()
      ? connectionManager.redact(params.contextSummary.trim()).slice(0, 16_000)
      : undefined;
    const inputAttachmentIds = [...new Set((params.attachmentIds ?? []).map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))];
    if (inputAttachmentIds.length > 16 || (params.attachmentIds ?? []).some((id) => typeof id !== "string" || !id.trim())) {
      throw new ProjectError(400, "invalid_attachments", "派单附件标识无效或超过数量上限。");
    }
    if (inputAttachmentIds.length > 0) {
      const allowedScopes = new Set([`conversation:${originConversationId}`]);
      for (const existingTicket of Object.values(existingState?.tickets ?? {})) {
        if (
          (existingTicket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === originConversationId &&
          (existingTicket.originTopicId ?? "root") === resolvedOriginTopicId
        ) {
          allowedScopes.add(`ticket:${existingTicket.id}`);
          allowedScopes.add(`conversation:${existingTicket.workerConversationId}`);
        }
      }
      for (const id of inputAttachmentIds) {
        const loaded = uploads.getUpload(id);
        if (!loaded) throw new ProjectError(400, "attachment_not_found", `附件 '${id}' 不存在或已失效。`);
        if (loaded.record.internalOnly) {
          throw new ProjectError(403, "internal_overflow_asset_not_dispatchable", "内部工具溢出资产仅限当前对话主 Agent 审阅，不可转发给后台任务。");
        }
        if (params.originToolTaskId !== undefined && !uploads.canReadUpload(id, `agent:${originConversationId}`, (scope) => allowedScopes.has(scope))) {
          throw new ProjectError(403, "attachment_forbidden", "当前对话无权将该附件传递给后台任务。");
        }
      }
    }

    const recoveryTicket = recoveryGuard ? existingState?.tickets[recoveryGuard.ticketId] : undefined;
    const envs = envManager.listEnvs();
    const localEnvId = envManager.localEnvId;
    const localEnv = envManager.getEnvDescriptor(localEnvId);
    const priorUserTurns = modelDispatch && !recoveryTicket
      ? await turnContext.recentPriorUserTurns(
          params.originConversationId,
          context,
          params.originToolTaskId,
          new Set(inputs.map((entry) => entry.id)),
        )
      : [];

    const activeBrowserEnvId =
      params.inheritBrowserSession && !originIsSettings
        ? computerTransfer?.activeOrchestratorBrowserEnvId(resolvedOriginTopicId)
        : undefined;

    const domain = resolveDispatchDomain({
      params,
      sender,
      dispatchSource,
      recoveryTicket,
      originTopic,
      reviewTarget,
      inputAttachmentIds,
      priorUserTurns,
      envs,
      activeRoles,
      activeBrowserEnvId,
      getEnvDescriptor: (id) => envManager.getEnvDescriptor(id),
    });

    let project = domain.projectId ? await projects.get(domain.projectId, context) : undefined;
    const plan = resolveDispatchAgentAndEnv({
      params,
      domain,
      project,
      modelDispatch,
      recoveryTicket,
      originTopic,
      inputs,
      sender,
      dispatchSource,
      envs,
      localEnvId,
      localEnv,
      activeRoles,
      activeExternalClients,
      activeLanguage,
      getEnvDescriptor: (id) => envManager.getEnvDescriptor(id),
      isLocalEnv: (id) => envManager.isLocalEnv(id),
      executionTrustMode: envManager.getExecutionTrustMode(),
      inheritedBrowserEnvId: !params.envId?.trim() && !domain.projectId ? activeBrowserEnvId : undefined,
      pickDefaultWorkerEnvId: () => envManager.pickDefaultWorkerEnvId(),
    });

    if (project && envManager.getEnvDescriptor(project.deviceId)?.online) {
      project = await projects.ensureAuthorized(project.id, context);
    }

    const workspace = resolveDispatchWorkspaceAndModel({
      params,
      domain,
      plan,
      project,
      reviewTarget,
      existingState,
      sender,
      envs,
      getEnvDescriptor: (id) => envManager.getEnvDescriptor(id),
      isLocalEnv: (id) => envManager.isLocalEnv(id),
      executionTrustMode: envManager.getExecutionTrustMode(),
      activeExternalClients,
      defaultProvider: settingsSnapshotLive.model.defaultProvider,
      defaultModel: settingsSnapshotLive.model.defaultModel,
      defaultThinkingLevel: settingsSnapshotLive.model.thinkingLevel,
    });

    const evidencePaths = modelDispatch && !plan.externalBinding && domain.executionDomain === "computer"
      ? await this.#coordinatorEvidencePaths(originConversationId, inputs, plan.targetEnvId, project?.deviceId ?? originTopic?.targetDeviceId, context)
      : [];
    const evidenceLine = formatEvidenceManifest(evidencePaths);
    if (evidenceLine) params = { ...params, assignment: [params.assignment?.trim(), evidenceLine].filter(Boolean).join("\n") };
    let isRemoteDedicatedRoot = isDedicatedRemoteRoot({ isLocal: envManager.isLocalEnv(plan.targetEnvId), rootDir: envManager.getEnvDescriptor(plan.targetEnvId)?.rootDir });
    const inferred = !project && !params.workspaceDir?.trim() && domain.executionDomain === "computer"
      ? inferDispatchWorkspace({ envRootDir: workspace.cleanRoot, isReadOnly: workspace.isReadOnly, texts: [params.goal, params.scope, params.acceptance], coordinatorReadPaths: evidencePaths, isRemoteDedicatedRoot })
      : undefined;
    const requestedDir = params.workspaceDir?.trim() || (inferred && inferred.kind !== "default" ? inferred.dir : undefined);
    if (!project && requestedDir) {
      const requested = {
        envId: plan.targetEnvId,
        workspaceDir: envManager.isLocalEnv(plan.targetEnvId) ? canonicalExecutionPath(requestedDir) : requestedDir,
      } as TicketRecord;
      const overlap = (await projects.list(context)).find((p) =>
        ticketsShareWriteScope(requested, { envId: p.deviceId, workspaceDir: p.workspaceDir } as TicketRecord),
      );
      // A whole-root read-only fallback quietly yields to the isolated default when projects live under it.
      if (overlap && inferred?.kind === "env_root_readonly" && !params.workspaceDir?.trim()) isRemoteDedicatedRoot = false;
      else if (overlap) {
        throw new ProjectError(400, "project_required", `该目录属于项目 ${overlap.name}，请使用 project_id 派单。`, { projectId: overlap.id });
      }
    }

    const workerAgent = plan.externalBinding
      ? undefined
      : workerOps.resolveWorkerAgent(workspace.workerProviderOpt, workspace.workerModelId, workspace.desiredThinking);
    const workerAgentConfig: AgentChange | undefined = workerAgent
      ? {
          model: workerAgent.model,
          thinkingLevel: workerAgent.thinkingLevel,
          ...workerOps.workerTools({
            executionDomain: domain.executionDomain,
            androidTargetIds: domain.androidDeviceIds,
            allowSubagents: Boolean(plan.rolePreset?.allowSubagents),
            readOnly: workspace.isReadOnly,
            hasProject: Boolean(project),
          }),
          maxTurns: WORKER_MAX_TURNS,
        }
      : undefined;

    const requestedBrowserInherit = params.inheritBrowserSession === true;
    const browserTransferRequest = requestedBrowserInherit
      ? {
          requested: true,
          candidate: !originIsSettings
            ? computerTransfer?.inspectOrchestratorBrowserForTransfer(resolvedOriginTopicId, plan.targetEnvId)
            : undefined,
          hasSameTurnBrowserCall:
            modelDispatch && params.originToolTaskId !== undefined
              ? await this.#hasSameTurnBrowserCall(originConversationId, params.originToolTaskId, context)
              : false,
        }
      : undefined;

    const originConv = (await harness.conversation(originConversationId as ConversationId, context)) ?? getRootConversation();
    const supersededStagedToDiscard: TicketRecord[] = [];
    const commitOutcome = await originConv.commit(
      (tx) =>
        admitDispatchInTx(tx, {
          params,
          originConversationId,
          originIsSettings,
          modelDispatch,
          dispatchSource,
          sender,
          recoveryGuard,
          executeAt,
          contextSummary,
          inputAttachmentIds,
          connectionIds,
          connectionRevisions,
          project,
          domain,
          plan,
          workspace,
          defaultAgentName: liveSettings.get().presentation.agentName,
          inlineDispatchWaitMs,
          liveRoles: liveSettings.get().roles,
          liveMaxSubagentsPerTicket: liveSettings.get().executor.maxSubagentsPerTicket,
          listEnvs: () => envManager.listEnvs(),
          getEnvDescriptor: (id) => envManager.getEnvDescriptor(id),
          redact: (text) => connectionManager.redact(text),
          prepareWorkerEnv: (envId, workspaceDir, opts) => envManager.createWorkerExecutionEnv(envId, workspaceDir, opts),
          workerTicketTask: workerOps.workerTicketTask,
          workerAgentConfig,
          supersededStagedToDiscard,
          inferredReadPaths: evidencePaths,
          isRemoteDedicatedRoot,
          browserTransferRequest,
        }),
      context,
    );
    const admitted = commitOutcome.ticket;
    let browserSessionInherited = commitOutcome.browserSessionInherited;
    let browserSessionInheritReason = commitOutcome.browserSessionInheritReason;

    if (commitOutcome.pendingBrowserTransfer) {
      const swapped = Boolean(
        computerTransfer?.commitOrchestratorBrowserTransferToTicket({
          topicId: commitOutcome.pendingBrowserTransfer.topicId,
          expectedSessionId: commitOutcome.pendingBrowserTransfer.sessionId,
          envId: commitOutcome.pendingBrowserTransfer.envId,
          ticketId: admitted.id,
          workerConversationId: admitted.workerConversationId,
          runEpoch: admitted.runEpoch,
        }),
      );
      if (!swapped) {
        await harness.commit(async (tx) => {
          const live = (await tx.doc(KuloStateDoc)).tickets[admitted.id];
          if (live?.inheritedBrowserSession?.sessionId === commitOutcome.pendingBrowserTransfer!.sessionId) {
            delete live.inheritedBrowserSession;
          }
        }, context).catch(() => {});
        browserSessionInherited = false;
        browserSessionInheritReason = "transfer_commit_race";
      }
    }

    if (supersededStagedToDiscard.length > 0) {
      await Promise.allSettled(supersededStagedToDiscard.map((old) => workerOps.discardTicketStagedWorkspace(old)));
    }
    bindDispatchedAttachments(uploads, admitted);
    runtimeGates.resumeIfNotRecovering();
    await runtimeGates.broadcastTickets(context);
    return {
      card: toTicketCardView(admitted, activeRoles, activeExternalClients),
      ...(browserSessionInherited !== undefined ? { browserSessionInherited } : {}),
      ...(browserSessionInheritReason ? { browserSessionInheritReason } : {}),
    };
  }

  async #hasSameTurnBrowserCall(
    originConversationId: number,
    toolTaskId: number,
    context: Context,
  ): Promise<boolean> {
    const { harness } = this.#deps;
    const conversation = await harness.conversation(originConversationId as ConversationId, context);
    if (!conversation) return false;
    let current = toolTaskId;
    let assistantId: number | undefined;
    for (let depth = 0; depth < 16; depth++) {
      const task = await harness.commit((tx) => tx.task(current as never), context);
      const input = task?.input as { kind?: string; assistant?: number; parent?: number } | undefined;
      if (input?.kind === "model" && typeof input.assistant === "number") {
        assistantId = input.assistant;
        break;
      }
      if (input?.kind !== "nested" || typeof input.parent !== "number") break;
      current = input.parent;
    }
    if (assistantId === undefined) return false;
    const page = await conversation.entries(
      { minEntryId: assistantId as EntryId, maxEntryId: assistantId as EntryId },
      1,
      undefined,
      context,
    );
    return assistantEntryHasBrowserCall(page.items.find((item) => Number(item.id) === assistantId));
  }

  /** Absolute paths the coordinator read/edited this turn, only when its tools ran on the dispatch target Env. */
  async #coordinatorEvidencePaths(
    originConversationId: number,
    inputs: readonly EntryRecord[],
    targetEnvId: string,
    boundEnvId: string | undefined,
    context: Context,
  ): Promise<string[]> {
    const { harness, envManager, connectionManager } = this.#deps;
    let coordinatorEnvId = boundEnvId;
    if (!coordinatorEnvId) {
      try { coordinatorEnvId = envManager.pickDefaultEnvId(); } catch { return []; }
    }
    if (coordinatorEnvId !== targetEnvId || !inputs.length) return [];
    const conversation = await harness.conversation(originConversationId as ConversationId, context);
    if (!conversation) return [];
    const minEntryId = Math.min(...inputs.map((entry) => Number(entry.id)));
    const page = await conversation.entries({ minEntryId: minEntryId as EntryId }, 200, undefined, context);
    return collectCoordinatorEvidencePaths(page.items, { redact: (text) => connectionManager.redact(text) });
  }

  async dispatchTicketForModel(
    params: DispatchTicketParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<DispatchTicketModelOutcome> {
    const { harness, inlineDispatchWaitMs, liveSettings, runtimeGates, inlineWaiters } = this.#deps;
    const dispatched = await this.#dispatchTicketInternal(params, context);
    const card = dispatched.card;
    const browserInheritMeta = {
      ...(dispatched.browserSessionInherited !== undefined ? { browserSessionInherited: dispatched.browserSessionInherited } : {}),
      ...(dispatched.browserSessionInheritReason ? { browserSessionInheritReason: dispatched.browserSessionInheritReason } : {}),
    };
    const initialState = await harness.snapshot(KuloStateDoc, context);
    const initialTicket = initialState?.tickets[card.id];
    const configuredWaitMs = initialTicket?.externalExecution
      ? 0
      : params.inlineWaitMs !== undefined
        ? Math.max(0, Math.min(30_000, Math.trunc(params.inlineWaitMs)))
        : inlineDispatchWaitMs;
    const initialBlocker = findPendingMergeBlocker(initialState, initialTicket);
    if (initialTicket?.deliveryClaim === "claimed_inline" && initialTicket.inlineResult) {
      return {
        ticket: toTicketCardView(initialTicket, liveSettings.get().roles),
        inlineDelivery: cloneJson(initialTicket.inlineResult),
        ...browserInheritMeta,
      };
    }
    if (initialTicket?.deliveryClaim !== "inline_waiting" || configuredWaitMs <= 0) {
      return {
        ticket: card,
        ...(initialBlocker ? { blockedByPendingMerge: initialBlocker } : {}),
        ...browserInheritMeta,
      };
    }

    await inlineWaiters.wait({
      ticketId: card.id,
      timeoutMs: configuredWaitMs,
      abortSignal: context.abortSignal,
      isClosed: () => runtimeGates.isClosed(),
      shouldWakeImmediately: async () => {
        const snap = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const cur = snap?.tickets[card.id];
        return !cur || cur.deliveryClaim !== "inline_waiting" || cur.status === "stopped" || cur.status === "closed" || cur.status === "failed";
      },
    });

    const outcome = await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const current = state.tickets[card.id];
      if (!current) return { ticket: card, escalatedNow: false };
      if (current.deliveryClaim === "claimed_inline" && current.inlineResult) {
        return {
          ticket: toTicketCardView(current, liveSettings.get().roles),
          inlineDelivery: cloneJson(current.inlineResult),
          escalatedNow: false,
        };
      }
      let escalatedNow = false;
      if (current.deliveryClaim === "inline_waiting") {
        current.deliveryClaim = "escalated";
        current.updatedAt = Date.now();
        escalatedNow = true;
      }
      return {
        ticket: toTicketCardView(current, liveSettings.get().roles),
        escalatedNow,
        blockedByPendingMerge: findPendingMergeBlocker(state, current),
      };
    }, withoutAbortSignal(context));

    if (outcome.escalatedNow && !runtimeGates.isClosed()) {
      await runtimeGates.broadcastTickets(withoutAbortSignal(context));
    }
    if (outcome.inlineDelivery) {
      return { ticket: outcome.ticket, inlineDelivery: outcome.inlineDelivery, ...browserInheritMeta };
    }
    return {
      ticket: outcome.ticket,
      ...(outcome.blockedByPendingMerge ? { blockedByPendingMerge: outcome.blockedByPendingMerge } : {}),
      ...browserInheritMeta,
    };
  }

  async #readEntryAgentIntent(
    conversation: Awaited<ReturnType<Harness["conversation"]>>,
    sourceEntryId: number,
    context: Context,
  ): Promise<AgentDispatchIntent | undefined> {
    if (!conversation || !Number.isSafeInteger(sourceEntryId) || sourceEntryId < 1) return undefined;
    const page = await conversation.entries(
      { minEntryId: sourceEntryId as EntryId, maxEntryId: sourceEntryId as EntryId },
      1,
      undefined,
      context,
    );
    const entry = page.items.find((item) => Number(item.id) === sourceEntryId);
    if (!entry) return undefined;
    if (isLegacyInternalUserEntry(entry)) return undefined;
    if (CoordinatorEventEntry.is(entry)) {
      const manualText = entry.data.eventKind === "user_task_instruction" ? (entry.data.manualText ?? "") : "";
      const live = this.#deps.liveSettings.get();
      return manualText ? extractAgentDispatchIntent(manualText, live.roles, this.#deps.envManager.listEnvs(), live.externalClients) : undefined;
    }
    const data = entry.data as Record<string, unknown> | undefined;
    if (data && Object.hasOwn(data, "agentDispatchIntent")) {
      return capturedAgentIntent(data.agentDispatchIntent);
    }
    const message = entry.model?.find((item) => item.role === "user");
    const text = typeof data?.text === "string"
      ? data.text
      : message?.role === "user"
        ? parseUserEntryContent(message.content).text
        : "";
    const live = this.#deps.liveSettings.get();
    return text ? extractAgentDispatchIntent(text, live.roles, this.#deps.envManager.listEnvs(), live.externalClients) : undefined;
  }

  async agentDispatchSource(
    conversationId: number | undefined,
    toolTaskId: number | undefined,
    context: Context,
    selectedInput?: EntryId,
  ): Promise<DispatchSourceContext> {
    if (conversationId === undefined) return {};
    const { harness, liveSettings, envManager } = this.#deps;
    const conversation = await harness.conversation(conversationId as ConversationId, context);
    if (!conversation) {
      throw new ProjectError(409, "agent_assignment_source_missing", "无法核对这次任务的原始用户消息，请重新发起指派。");
    }
    let assistant: number | undefined = selectedInput;
    if (toolTaskId !== undefined && assistant === undefined) {
      let current = toolTaskId;
      for (let depth = 0; depth < 16; depth++) {
        const task = await harness.commit((tx) => tx.task(current as never), context);
        const input = task?.input as { kind?: string; assistant?: number; parent?: number } | undefined;
        if (input?.kind === "model" && typeof input.assistant === "number") {
          assistant = input.assistant;
          break;
        }
        if (input?.kind !== "nested" || typeof input.parent !== "number") {
          throw new ProjectError(409, "agent_assignment_source_missing", "无法核对派单工具对应的用户消息。");
        }
        current = input.parent;
      }
      if (assistant === undefined) {
        throw new ProjectError(409, "agent_assignment_source_missing", "派单上下文层级无效，请重新发起指派。");
      }
    }
    // Original journal entries survive compaction. Limit to this tool's assistant entry so a later queued user turn cannot rebind it.
    let cursor: Parameters<typeof conversation.entries>[2];
    let continuing = false;
    let input: EntryRecord | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await conversation.entries(assistant === undefined ? {} : { maxEntryId: assistant as EntryId }, 200, cursor, context);
      for (const entry of [...page.items].sort((a, b) => Number(b.id) - Number(a.id))) {
        if (!isRecoveryInputBoundary(entry)) continue;
        if (MediaRelayEntry.is(entry) || isLegacyInternalUserEntry(entry)) {
          return { entryId: Number(entry.id), input, continuing };
        }
        if (CoordinatorEventEntry.is(entry)) {
          const live = liveSettings.get();
          if (entry.data.eventKind === "user_task_instruction") {
            const manualText = entry.data.manualText?.trim() ?? "";
            const intent = manualText
              ? extractAgentDispatchIntent(manualText, live.roles, envManager.listEnvs(), live.externalClients)
              : undefined;
            if (intent) {
              return { entryId: Number(entry.id), intent, input: input ?? entry, continuing };
            }
          }
          if (entry.data.ticketId) {
            const state = await harness.snapshot(KuloStateDoc, context);
            let ticket = state?.tickets[entry.data.ticketId];
            const ancestors = new Set<string>();
            while (ticket?.parentTicketId && !ancestors.has(ticket.id)) {
              ancestors.add(ticket.id);
              ticket = state?.tickets[ticket.parentTicketId] ?? ticket;
              if (ancestors.has(ticket.id)) break;
            }
            const assignment = ticket?.agentAssignment;
            const shouldInherit = Boolean(assignment && (assignment.source === "explicit" || assignment.source === "manual"));
            return {
              entryId: Number(entry.id),
              input,
              continuing,
              ...(shouldInherit && assignment ? { inheritedAssignment: cloneJson(assignment) } : {}),
            };
          }
          return { entryId: Number(entry.id), input, continuing };
        }
        if (WorkerRelayEntry.is(entry) || WorkerRecoveryEntry.is(entry) || WorkerWatchdogEntry.is(entry)) {
          const state = await harness.snapshot(KuloStateDoc, context);
          let ticket = state?.tickets[entry.data.ticketId];
          const ancestors = new Set<string>();
          while (ticket?.parentTicketId && !ancestors.has(ticket.id)) {
            ancestors.add(ticket.id);
            ticket = state?.tickets[ticket.parentTicketId] ?? ticket;
            if (ancestors.has(ticket.id)) break;
          }
          const relaySettledReady = WorkerRelayEntry.is(entry) && entry.data.state === "ready";
          const assignment = ticket?.agentAssignment;
          if (relaySettledReady && assignment?.source === "explicit" && assignment.sourceEntryId !== undefined) {
            const originIntent = await this.#readEntryAgentIntent(conversation, assignment.sourceEntryId, context);
            if (originIntent && originIntent.targets.length > 1) {
              return { entryId: Number(entry.id), intent: originIntent, input, continuing, relaySettledReady: true };
            }
          }
          const shouldInherit = Boolean(assignment && (assignment.source === "explicit" || assignment.source === "manual"));
          return {
            entryId: Number(entry.id),
            input,
            continuing,
            ...(relaySettledReady ? { relaySettledReady: true } : {}),
            ...(shouldInherit && assignment ? { inheritedAssignment: cloneJson(assignment) } : {}),
          };
        }
        input ??= entry;
        const data = entry.data as Record<string, unknown> | undefined;
        const message = entry.model?.find((item) => item.role === "user");
        const text = typeof data?.text === "string"
          ? data.text
          : message?.role === "user"
            ? parseUserEntryContent(message.content).text
            : "";
        const live = liveSettings.get();
        const intent = data && Object.hasOwn(data, "agentDispatchIntent")
          ? capturedAgentIntent(data.agentDispatchIntent)
          : extractAgentDispatchIntent(text, live.roles, envManager.listEnvs(), live.externalClients);
        if (!intent && !continuing && /^(?:请|帮我)?\s*(?:继续(?:执行|处理|推进|完成|原任务|这个任务)?|接着(?:做|执行|处理)?|重试(?:一下|这个任务)?|再试(?:一次|一下)?|continue|retry)[\s,，。.!！]*$/i.test(text.trim())) {
          continuing = true;
          continue;
        }
        if (!intent && continuing) {
          const state = await harness.snapshot(KuloStateDoc, context);
          const assignments = Object.values(state?.tickets ?? {})
            .filter((ticket) => ticket.originConversationId === conversationId && ticket.agentAssignment?.sourceEntryId === Number(entry.id))
            .flatMap((ticket) => (ticket.agentAssignment ? [ticket.agentAssignment] : []));
          const byAgent = new Map(assignments.map((assignment) => [assignment.agentId, assignment]));
          if (byAgent.size > 1) {
            throw new ProjectError(409, "agent_selection_required", "此前任务由多个 Agent 分工，请明确要继续哪一个任务或 Agent。");
          }
          const inheritedAssignment = byAgent.values().next().value as AgentAssignment | undefined;
          if (inheritedAssignment) return { entryId: Number(entry.id), inheritedAssignment: cloneJson(inheritedAssignment), input, continuing };
        }
        return { entryId: Number(entry.id), intent, input, continuing };
      }
      if (!page.next) {
        if (toolTaskId !== undefined) {
          throw new ProjectError(409, "agent_assignment_source_missing", "原始派发消息已不可用，请重新说明任务和指定 Agent。");
        }
        return {};
      }
      cursor = page.next;
    }
    throw new ProjectError(409, "agent_assignment_source_missing", "原始指派消息过远，无法安全核对，请重新说明要使用的 Agent。");
  }
}
