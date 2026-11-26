import { isDeepStrictEqual } from "node:util";
import { configure, type AgentChange, type Tx } from "@earendil-works/pi-durable";
import { isEffectiveExternalReadOnly, type EnvNodeDescriptor, type ProjectRecord, type RolePreset, type TicketRecord } from "@kulo/protocol";
import {
  assertAgentDispatchAvailable,
  resolveAgentDispatch,
  resolveRoleOrDirectClient,
} from "./agent-routing.js";
import type { chatRoutingData } from "./chat-submissions.js";
import { inferDispatchWorkspace } from "./dispatch-workspace-infer.js";
import { canSwitchEnvDuringRecovery } from "./env-routing-policy.js";
import { assertExternalAgentScope } from "./external-agent-tools.js";
import { assertProjectBinding, KuloProjectsDoc, ProjectError } from "./projects.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import {
  isActiveSettingsConversation,
  SettingsAssistantDoc,
  settingsTopicId,
} from "./settings-assistant.js";
import { KuloSettingsDoc } from "./settings.js";
import {
  ensureDefaultRootTopic,
  hasPendingWorkspaceApply,
  isOrchestratorConversation,
  KuloStateDoc,
  releaseProjectWrite,
  ticketsShareWriteScope,
  type KuloDurableState,
  type WorkerRecoveryEntryData,
} from "./state.js";
import { attachDispatchedTicketToBoardInTx } from "./task-boards.js";
import { assertRecoveryGuard, sameRecoveryScope } from "./task-recovery.js";
import {
  androidTargetsOf,
  areTicketDevicesOnline,
  checkDispatchAdmission,
  slugifyDispatchTitle,
  type DispatchAgentEnvPlan,
  type DispatchDomainPlan,
  type DispatchSourceContext,
  type ResolvedDispatchWorkspace,
} from "./ticket-dispatch-plan.js";
import { validateReviewTargetTicket } from "./ticket-review-pack.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import type { DispatchTicketParams } from "./tools-router.js";
import type { KuloUploadStore } from "./uploads.js";

export {
  androidTargetsOf,
  areTicketDevicesOnline,
  checkDispatchAdmission,
  findPendingMergeBlocker,
  parseDispatchSchedule,
  resolveDispatchAgentAndEnv,
  resolveDispatchDomain,
  resolveDispatchWorkspaceAndModel,
  slugifyDispatchTitle,
  type DispatchAgentEnvPlan,
  type DispatchDomainPlan,
  type DispatchSourceContext,
  type ResolvedDispatchWorkspace,
} from "./ticket-dispatch-plan.js";

export type TicketDispatchDraft = Omit<TicketRecord, "workerConversationId" | "activeTaskId">;

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

/** The Worker, its configuration and the task that can run it become visible in the same commit. */
export async function createDispatchedTicket(
  tx: Tx,
  state: KuloDurableState,
  draft: TicketDispatchDraft,
  task: ReturnType<typeof createWorkerTicketTask>,
  agent?: AgentChange,
): Promise<TicketRecord> {
  const worker = await tx.createConversation({ ownership: { kind: "ownerless" } });
  if (agent) await configure(tx, worker.id, agent);
  const taskId = await tx.createTask(
    task,
    {
      ticketId: draft.id,
      runEpoch: draft.runEpoch,
      promptOverride: null,
      ...(draft.inputAttachmentIds?.length ? { attachmentIds: draft.inputAttachmentIds } : {}),
    },
    { ownership: { kind: "conversation" }, background: true },
  );
  const ticket = { ...draft, workerConversationId: Number(worker.id), activeTaskId: Number(taskId) };
  state.tickets[ticket.id] = ticket;
  state.commandIndex[ticket.commandId] = ticket.id;
  state.conversationToTicket[String(worker.id)] = ticket.id;
  return ticket;
}

export function bindDispatchedAttachments(uploads: KuloUploadStore, ticket: Readonly<TicketRecord>): void {
  // A replay can supply different attachment IDs. Only the original, authorized inputs are committed on the ticket.
  if (!ticket.inputAttachmentIds?.length) return;
  uploads.bindAttachments(ticket.inputAttachmentIds, `conversation:${ticket.workerConversationId}`);
  uploads.bindAttachments(ticket.inputAttachmentIds, `ticket:${ticket.id}`);
}

export async function admitDispatchInTx(
  tx: Tx,
  input: {
    params: Readonly<DispatchTicketParams>;
    originConversationId: number;
    originIsSettings: boolean;
    modelDispatch: boolean;
    dispatchSource: DispatchSourceContext;
    sender: ReturnType<typeof chatRoutingData>;
    recoveryGuard?: WorkerRecoveryEntryData;
    executeAt?: number;
    contextSummary?: string;
    inputAttachmentIds: readonly string[];
    connectionIds: readonly string[];
    connectionRevisions: Readonly<Record<string, number>>;
    project?: Readonly<ProjectRecord>;
    domain: DispatchDomainPlan;
    plan: DispatchAgentEnvPlan;
    workspace: ResolvedDispatchWorkspace;
    defaultAgentName: string;
    inlineDispatchWaitMs: number;
    liveRoles: Readonly<Record<string, RolePreset>>;
    liveMaxSubagentsPerTicket: number;
    listEnvs: () => EnvNodeDescriptor[];
    getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
    redact: (text: string) => string;
    prepareWorkerEnv?: (envId: string, workspaceDir: string, opts: { scratchDir?: string; projectId?: string; grantRevision?: number; readOnly: boolean; executionMode?: import("@kulo/protocol").ExecutionTrustMode; executionKey?: string }) => void;
    workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
    workerAgentConfig?: AgentChange;
    supersededStagedToDiscard: TicketRecord[];
    /** Absolute paths the coordinator inspected on the target Env this turn (pure data, used for read-only inference). */
    inferredReadPaths?: readonly string[];
    isRemoteDedicatedRoot?: boolean;
  },
): Promise<TicketRecord> {
  const {
    params, originConversationId, originIsSettings, modelDispatch, dispatchSource, sender, recoveryGuard,
    executeAt, contextSummary, inputAttachmentIds, connectionIds, connectionRevisions, project, domain, plan, workspace,
    defaultAgentName, inlineDispatchWaitMs, liveRoles, liveMaxSubagentsPerTicket, listEnvs, getEnvDescriptor, redact,
    prepareWorkerEnv, workerTicketTask, workerAgentConfig, supersededStagedToDiscard,
  } = input;
  const { executionDomain, androidDeviceIds } = domain;
  const { routingEnv, routing, roleId, rolePreset, externalBinding, targetEnvId, envBinding, waitForSource, agentEnv } = plan;
  const { pathApi, sep, cleanRoot, scratchRoot, requestedReadOnly, isReadOnly, builtInWorkspaceMode, externalWorkspaceMode, nativeThinking, providerOverride, modelOverride } = workspace;

  const state = await tx.doc(KuloStateDoc);
  const currentSettings = await tx.doc(SettingsAssistantDoc);
  ensureDefaultRootTopic(state, defaultAgentName);
  const projectsDoc = await tx.doc(KuloProjectsDoc);
  if (project) assertProjectBinding(projectsDoc, project.id, project.revision);
  const isSettingsOrigin = !isOrchestratorConversation(originConversationId, state) && isActiveSettingsConversation(originConversationId, currentSettings);
  if (!isSettingsOrigin) {
    if (originIsSettings) throw new ProjectError(404, "topic_deleted", "会话已删除。");
    const currentTopic = state.topics?.[state.conversationToTopic?.[String(originConversationId)] ?? "root"];
    if (currentTopic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
  }
  const settings = await tx.doc(KuloSettingsDoc);
  const duplicate = checkDispatchAdmission({
    state,
    paused: settings.executor.paused,
    params,
    originConversationId,
    dispatchSource,
    activeRoles: settings.roles,
    externalClients: settings.externalClients,
    language: settings.presentation.language,
  });
  if (duplicate) return cloneJson(duplicate);
  const currentRoles = settings.roles;
  const currentExternalClients = settings.externalClients;
  const currentSelection = androidDeviceIds.length || executionDomain === "android"
    ? Object.fromEntries(Object.entries(currentRoles).map(([id, role]) => [id, role.external ? { ...role, dispatchPolicy: undefined } : role]))
    : currentRoles;
  const currentRouting = resolveAgentDispatch({
    roles: currentSelection,
    externalClients: currentExternalClients,
    language: settings.presentation.language,
    ...dispatchSource,
    requestedRole: params.role,
    taskKind: params.taskKind,
    workspaceMode: params.workspaceMode,
    projectId: project?.id,
    envId: routingEnv,
    trustedManual: params.originToolTaskId === undefined,
  });
  const currentResolvedRole = resolveRoleOrDirectClient(roleId, currentRoles, currentExternalClients, settings.presentation.language);
  if (currentRouting.role !== roleId || !isDeepStrictEqual(currentResolvedRole, rolePreset)) {
    throw new ProjectError(409, "agent_configuration_changed", "派单期间智能体或默认承接范围已改变，请读取最新配置后重新指派。");
  }
  assertAgentDispatchAvailable(currentResolvedRole, { envs: listEnvs(), envId: agentEnv, allowOffline: waitForSource });
  assertRecoveryGuard(state, recoveryGuard);
  if (recoveryGuard) {
    const failed = state.tickets[recoveryGuard.ticketId]!;
    const topicTargetDeviceId = originIsSettings ? undefined : state.topics?.[state.conversationToTopic?.[String(originConversationId)] ?? "root"]?.targetDeviceId;
    const allowFallbackEnv = canSwitchEnvDuringRecovery(failed, topicTargetDeviceId) && !externalBinding && !project;
    if (
      !params.supersedes?.some((old) => old.ticketId === failed.id) ||
      (!allowFallbackEnv && targetEnvId !== failed.envId) ||
      (project?.id ?? undefined) !== failed.projectId ||
      (failed.readOnly && !isReadOnly) ||
      executionDomain !== (failed.executionDomain ?? "computer") ||
      androidDeviceIds.some((id) => !androidTargetsOf(failed).includes(id)) ||
      connectionIds.some((id) => !failed.connectionIds?.includes(id))
    ) {
      throw new Error("替代方案必须关联原任务并保持原设备、项目、连接和只读授权边界。");
    }
    if (params.workspaceDir?.trim() && pathApi.normalize(params.workspaceDir) !== pathApi.normalize(failed.workspaceDir)) {
      throw new Error("自动恢复不能扩大原任务的工作目录。");
    }
  }

  const originTopicId = isSettingsOrigin
    ? settingsTopicId(originConversationId)
    : state.conversationToTopic?.[String(originConversationId)] ?? "root";
  const ticketNum = state.nextTicketNumber++;
  const ticketId = `T-${String(ticketNum).padStart(4, "0")}`;
  const workspaceDir = executionDomain === "android"
    ? ""
    : project?.workspaceDir || params.workspaceDir?.trim() || (() => {
      const inferred = inferDispatchWorkspace({
        envRootDir: cleanRoot, isReadOnly, texts: [params.goal, params.scope, params.acceptance],
        coordinatorReadPaths: input.inferredReadPaths, isRemoteDedicatedRoot: input.isRemoteDedicatedRoot,
      });
      return inferred.kind === "default" ? `${cleanRoot}${sep}table${sep}${ticketId}-${slugifyDispatchTitle(params.title)}` : inferred.dir;
    })();
  const scratchDir = executionDomain === "android" ? undefined : `${scratchRoot}${sep}${ticketId}`;

  const now = Date.now();
  const supersededIds: string[] = [];
  if (params.supersedes?.length) {
    for (const sup of params.supersedes) {
      const old = state.tickets[sup.ticketId];
      if (!old || !["ready", "failed"].includes(old.status) || !sameRecoveryScope(old, { originTopicId, projectId: project?.id })) {
        throw new Error("只能替代同一会话和项目中已完成或失败的任务。");
      }
      if (!supersededIds.includes(old.id)) supersededIds.push(old.id);
    }
  }

  const configuredWaitMs = params.inlineWaitMs !== undefined
    ? Math.max(0, Math.min(30_000, Math.trunc(params.inlineWaitMs)))
    : inlineDispatchWaitMs;
  const candidateWriteTicket = {
    envId: targetEnvId,
    workspaceDir,
    ...(project ? { directoryId: project.directoryId } : {}),
    readOnly: isReadOnly,
    executionDomain,
    ...(androidDeviceIds.length ? { androidDeviceIds } : {}),
  } as TicketRecord;

  // Supersedes deadlock breaker: discard superseded pending-merge staged copies and release their project write lock.
  if (!isReadOnly && executionDomain !== "android" && supersededIds.length > 0) {
    for (const oldId of supersededIds) {
      const old = state.tickets[oldId];
      if (!old || !hasPendingWorkspaceApply(old) || !ticketsShareWriteScope(candidateWriteTicket, old)) continue;
      supersededStagedToDiscard.push(cloneJson(old));
      if (old.workspaceStaging && !old.workspaceStaging.appliedAt) {
        old.workspaceStaging.discardedAt = now;
        delete old.workspaceStaging.stagedCwd;
        delete old.workspaceStaging.stagedDiff;
      }
      if (old.externalExecution && !old.externalExecution.stagedAppliedAt) {
        delete old.externalExecution.stagedCwd;
        delete old.externalExecution.stagedDiff;
      }
      releaseProjectWrite(state, old.id, { force: true });
      old.updatedAt = now;
    }
  }

  const writeConflictExists =
    executionDomain !== "android" &&
    !isReadOnly &&
    Object.values(state.tickets).some(
      (other) =>
        (other.status === "running" ||
          other.status === "pausing" ||
          (!supersededIds.includes(other.id) && hasPendingWorkspaceApply(other))) &&
        ticketsShareWriteScope(candidateWriteTicket, other),
    );
  const eligibleInline =
    modelDispatch &&
    !externalBinding &&
    configuredWaitMs > 0 &&
    executeAt === undefined &&
    !recoveryGuard &&
    !settings.executor.paused &&
    state.slots.holders.length < settings.executor.maxConcurrentWorkers &&
    areTicketDevicesOnline(candidateWriteTicket, getEnvDescriptor) &&
    !writeConflictExists;

  const reviewTargetInTx = params.reviewTicketId?.trim()
    ? validateReviewTargetTicket(state, projectsDoc, currentSettings, originConversationId, params.reviewTicketId)
    : undefined;
  const resolvedBoardId = attachDispatchedTicketToBoardInTx(
    state, projectsDoc, currentSettings,
    {
      ticketId, ticketTitle: params.title.trim(), ticketGoal: params.goal.trim(), ticketProjectId: project?.id,
      originConversationId, originTopicId, requestedBoardId: params.boardId, requestedBoardTitle: params.boardTitle,
      reviewTicket: reviewTargetInTx, now,
    },
    redact,
  );
  const recoveryState = supersededIds.map((id) => state.tickets[id]?.recovery).find((v) => v?.state === "recovering");
  const sourceEntryId = dispatchSource.inheritedAssignment?.sourceEntryId ?? dispatchSource.entryId;
  const draft: TicketDispatchDraft = {
    id: ticketId,
    commandId: params.commandId,
    ...(resolvedBoardId ? { boardId: resolvedBoardId } : {}),
    ...(reviewTargetInTx ? { reviewTicketId: reviewTargetInTx.id } : {}),
    title: params.title.trim(),
    ...(params.userSummary?.trim() ? { userSummary: params.userSummary.trim() } : {}),
    goal: params.goal.trim(),
    scope: params.scope.trim(),
    ...(params.acceptance?.trim() ? { acceptance: params.acceptance.trim() } : {}),
    ...(params.assignment?.trim() ? { assignment: params.assignment.trim() } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(inputAttachmentIds.length ? { inputAttachmentIds: [...inputAttachmentIds] } : {}),
    role: roleId,
    ...(providerOverride ? { providerOverride } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(routing.source !== "legacy"
      ? {
          agentAssignment: {
            agentId: roleId, source: routing.source,
            ...(routing.taskKind ? { taskKind: routing.taskKind } : {}),
            ...(routing.requestedName ? { requestedName: routing.requestedName } : {}),
            ...(sourceEntryId === undefined ? {} : { sourceEntryId }),
          },
        }
      : {}),
    ...(params.parentTicketId ? { parentTicketId: params.parentTicketId } : {}),
    ...(builtInWorkspaceMode === "staged" || builtInWorkspaceMode === "direct" ? { workspaceStaging: { mode: builtInWorkspaceMode } } : {}),
    ...(externalBinding
      ? {
          externalExecution: {
            binding: cloneJson(externalBinding),
            ...(externalWorkspaceMode ? { workspaceMode: externalWorkspaceMode } : {}),
            ...(requestedReadOnly ? { effectiveReadOnly: true } : {}),
            ...(rolePreset?.modelId?.trim() ? { modelId: rolePreset.modelId.trim() } : {}),
            ...(nativeThinking && nativeThinking !== "auto" ? { thinkingLevel: nativeThinking } : {}),
            ...(rolePreset?.serviceTier?.trim() ? { serviceTier: rolePreset.serviceTier.trim() } : {}),
            instructions: rolePreset?.prompt?.trim() ?? "",
            allowSubagents: Boolean(rolePreset?.allowSubagents),
          },
        }
      : {}),
    status: executeAt === undefined ? "queued" : "waiting",
    envId: targetEnvId,
    envBinding,
    ...(sender.source ? { senderSource: { deviceId: sender.source.deviceId, name: sender.source.name } } : {}),
    executionDomain,
    ...(androidDeviceIds.length ? { androidDeviceIds } : {}),
    workspaceDir,
    ...(scratchDir ? { scratchDir } : {}),
    readOnly: isReadOnly,
    ...(connectionIds.length ? { connectionIds: [...connectionIds], connectionRevisions: { ...connectionRevisions } } : {}),
    ...(project ? { projectId: project.id, projectRevision: project.revision, directoryId: project.directoryId, grantRevision: project.grantRevision } : {}),
    runEpoch: 1,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    accumulatedRunningMs: 0,
    ...(executeAt !== undefined
      ? {
          schedule: { executeAt, nextRunAt: executeAt, ...(params.repeatEverySeconds !== undefined ? { repeatEverySeconds: params.repeatEverySeconds } : {}) },
          waiting: { reason: "time" as const, since: now, until: executeAt, detail: "等待定时执行" },
        }
      : {}),
    ...(supersededIds.length > 0 ? { supersedes: supersededIds } : {}),
    ...(recoveryState ? { recovery: { ...recoveryState } } : {}),
    deliveryClaim: eligibleInline ? "inline_waiting" : "escalated",
    originTopicId,
    originConversationId,
  };

  if (params.parentTicketId) {
    const request = params.parentExternalRequest;
    if (!request) throw new Error("外部协作缺少已认证的父任务请求。");
    const currentParent = assertExternalAgentScope(
      { envId: targetEnvId, taskId: params.parentTicketId, runId: request.runId, runEpoch: request.runEpoch },
      state.tickets,
    );
    const currentRole = liveRoles[currentParent.role];
    const childRole = liveRoles[roleId];
    if (
      !currentParent.externalExecution!.allowSubagents || !currentRole?.allowSubagents || currentRole.enabled === false ||
      !childRole || childRole.enabled === false || (currentParent.readOnly && !isReadOnly) || (isEffectiveExternalReadOnly(currentParent) && !requestedReadOnly) ||
      currentParent.projectId !== draft.projectId || currentParent.workspaceDir !== workspaceDir ||
      connectionIds.some((id) => !currentParent.connectionIds?.includes(id))
    ) {
      throw new Error("协作请求超出父任务当前的授权范围。");
    }
    const children = currentParent.externalExecution!.children ?? {};
    const prior = children[request.requestId];
    if (prior) {
      throw new Error(prior.fingerprint === request.fingerprint ? "该协作请求已有子任务，请读取原任务。" : "该协作编号已用于另一份任务。");
    }
    if (Object.keys(children).length >= liveMaxSubagentsPerTicket) throw new Error("当前任务已达到子智能体上限。");
    currentParent.externalExecution!.children = { ...children, [request.requestId]: { taskId: ticketId, fingerprint: request.fingerprint } };
  }

  if (!externalBinding && executionDomain !== "android" && builtInWorkspaceMode !== "staged" && getEnvDescriptor(targetEnvId)?.online) {
    prepareWorkerEnv?.(targetEnvId, workspaceDir, {
      scratchDir, projectId: project?.id, grantRevision: project?.grantRevision, readOnly: isReadOnly,
      executionMode: workspace.effectiveExecutionMode,
      executionKey: ticketId,
    });
  }
  const created = await createDispatchedTicket(
    tx, state, draft, workerTicketTask,
    workerAgentConfig ? { ...workerAgentConfig, ...(executionDomain !== "android" ? { cwd: workspaceDir } : {}) } : undefined,
  );
  state.ticketExecutionModes ??= {};
  state.ticketExecutionModes[created.id] = {
    runEpoch: created.runEpoch,
    mode: workspace.effectiveExecutionMode,
  };
  if (connectionIds.length > 0 && created.workerConversationId && executionDomain !== "android") {
    await injectEventToolsInTx(tx, created.workerConversationId, ["kulo_connections", "kulo_connection_use"]);
  }
  return created;
}
