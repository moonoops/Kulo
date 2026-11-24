import path from "node:path";
import { ROOT_CONVERSATION_ID, type EntryRecord } from "@earendil-works/pi-durable";
import {
  LEGACY_MIGRATION_EXECUTION_TRUST_MODE,
  externalClientConnectionId,
  isEffectiveExternalReadOnly,
  isPersonalExternalAgentKind,
  isWorkerEnvReady,
  resolveEffectiveExecutionMode,
  type AgentAssignment,
  type AgentDispatchIntent,
  type EnvNodeDescriptor,
  type ExecutionTrustMode,
  type ExternalAgentBinding,
  type ExternalClientConnection,
  type ExternalWorkspaceMode,
  type KuloLanguage,
  type ProjectRecord,
  type RolePreset,
  type ThinkingEffort,
  type TicketEnvBinding,
  type TicketRecord,
} from "@kulo/protocol";
import {
  assertAgentDispatchAvailable,
  namedDispatchDevices,
  resolveAgentDispatch,
  resolveRoleOrDirectClient,
} from "./agent-routing.js";
import { chatRoutingData } from "./chat-submissions.js";
import {
  detectSenderLocalSignals,
  hasExplicitSenderReference,
  hasWorkerIsolation,
  resolveComputerEnvBinding,
  resolveNamedOrContextualEnv,
  type NamedOrContextualEnvResolution,
  type PriorUserDeviceTurn,
} from "./env-routing-policy.js";
import { ProjectError } from "./projects.js";
import {
  hasPendingWorkspaceApply,
  ticketsShareWriteScope,
  type KuloDurableState,
} from "./state.js";
import type { DispatchTicketParams } from "./tools-router.js";

export type DurableTopicRecord = NonNullable<KuloDurableState["topics"]>[string];

export interface DispatchSourceContext {
  intent?: AgentDispatchIntent;
  entryId?: number;
  inheritedAssignment?: AgentAssignment;
  relaySettledReady?: boolean;
  input?: EntryRecord;
  continuing?: boolean;
}

export function slugifyDispatchTitle(title: string): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
  return ascii || "task";
}

export function androidTargetsOf(ticket: Readonly<TicketRecord>): string[] {
  return ticket.androidDeviceIds ?? (ticket.executionDomain === "android" ? [ticket.envId] : []);
}

export function areTicketDevicesOnline(
  ticket: Readonly<TicketRecord>,
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined,
): boolean {
  return (
    Boolean(getEnvDescriptor(ticket.envId)?.online) &&
    androidTargetsOf(ticket).every((id) => {
      const device = getEnvDescriptor(id);
      return Boolean(device?.online && device.executionKind === "native-device" && device.android?.enabled && !device.android.paused);
    })
  );
}

export function findPendingMergeBlocker(
  state: Readonly<KuloDurableState> | undefined,
  current: Readonly<TicketRecord> | undefined,
): { ticketId: string; title: string } | undefined {
  if (!state || !current || current.readOnly || current.executionDomain === "android" || current.status !== "queued") {
    return undefined;
  }
  const blocker = Object.values(state.tickets).find(
    (other) => other.id !== current.id && hasPendingWorkspaceApply(other) && ticketsShareWriteScope(current, other),
  );
  return blocker ? { ticketId: blocker.id, title: blocker.title } : undefined;
}

export function checkDispatchAdmission(input: {
  state: Readonly<KuloDurableState> | undefined;
  paused: boolean;
  params: Readonly<DispatchTicketParams>;
  originConversationId: number;
  dispatchSource: DispatchSourceContext;
  activeRoles: Readonly<Record<string, RolePreset>>;
  externalClients?: Readonly<Record<string, ExternalClientConnection>>;
  language?: KuloLanguage;
}): TicketRecord | undefined {
  const { state, paused, params, originConversationId, dispatchSource, activeRoles, externalClients, language } = input;
  const existingId = state && Object.hasOwn(state.commandIndex, params.commandId) ? state.commandIndex[params.commandId] : undefined;
  const prior = existingId ? state?.tickets[existingId] : undefined;
  if (!prior) {
    if (paused) throw new Error("新任务派发当前已暂停，请先在「设置 -> 并发与运行」中恢复处理。");
    if (typeof params.commandId !== "string" || !params.commandId.trim() || ["__proto__", "constructor", "prototype"].includes(params.commandId)) {
      throw new ProjectError(400, "invalid_command_id", "派单标识无效。");
    }
    return undefined;
  }
  if ((prior.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== originConversationId || prior.parentTicketId !== params.parentTicketId) {
    throw new ProjectError(409, "dispatch_command_conflict", "该派单标识已用于其他任务，请使用新的标识。");
  }
  if (dispatchSource.intent || dispatchSource.inheritedAssignment) {
    const choice = resolveAgentDispatch({
      roles: activeRoles, externalClients, language, ...dispatchSource,
      requestedRole: prior.role, taskKind: prior.agentAssignment?.taskKind ?? params.taskKind,
      projectId: prior.projectId, envId: prior.envId, trustedManual: true,
    });
    if (choice.role !== prior.role) {
      throw new ProjectError(409, "agent_binding_conflict", "该派单标识已经绑定其他 Agent，请为新的用户指派创建新任务。");
    }
  }
  return prior;
}

export function parseDispatchSchedule(
  executeAtRaw: string | undefined,
  repeatEverySeconds: number | undefined,
  hasRecoveryGuard: boolean,
): number | undefined {
  const executeAt = executeAtRaw === undefined ? undefined : Date.parse(executeAtRaw);
  if (
    executeAtRaw !== undefined &&
    (typeof executeAtRaw !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(executeAtRaw) ||
      !Number.isSafeInteger(executeAt) || executeAt! < 0)
  ) {
    throw new ProjectError(400, "invalid_schedule", "执行时间必须是带时区的有效 ISO 8601 时间。");
  }
  if (
    repeatEverySeconds !== undefined &&
    (executeAt === undefined || !Number.isSafeInteger(repeatEverySeconds) || repeatEverySeconds <= 0 ||
      repeatEverySeconds * 1000 > 8_640_000_000_000_000 - executeAt)
  ) {
    throw new ProjectError(400, "invalid_schedule", "重复间隔必须是正整数秒，并指定首次执行时间。");
  }
  if (hasRecoveryGuard && executeAt !== undefined) {
    throw new ProjectError(403, "recovery_schedule_denied", "自动恢复不能新建定时计划。");
  }
  return executeAt;
}

export interface DispatchDomainPlan {
  fixedTargetId?: string;
  fixedTarget?: EnvNodeDescriptor;
  proposedEnv?: string;
  namedEnvResolution?: NamedOrContextualEnvResolution;
  namedEnv?: string;
  namedAgent: boolean;
  executionDomain: "android" | "computer";
  androidDeviceIds: string[];
  projectId?: string;
}

export function resolveDispatchDomain(input: {
  params: Readonly<DispatchTicketParams>;
  sender: ReturnType<typeof chatRoutingData>;
  dispatchSource: DispatchSourceContext;
  recoveryTicket?: Readonly<TicketRecord>;
  originTopic?: Readonly<DurableTopicRecord>;
  reviewTarget?: Readonly<TicketRecord>;
  inputAttachmentIds: readonly string[];
  priorUserTurns: readonly PriorUserDeviceTurn[];
  envs: readonly EnvNodeDescriptor[];
  activeRoles: Readonly<Record<string, RolePreset>>;
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
}): DispatchDomainPlan {
  const { params, sender, dispatchSource, recoveryTicket, originTopic, reviewTarget, inputAttachmentIds, priorUserTurns, envs, activeRoles, getEnvDescriptor } = input;
  if (params.executionDomain !== undefined && !["android", "computer"].includes(params.executionDomain)) {
    throw new ProjectError(400, "invalid_execution_domain", "任务执行类型无效。");
  }
  const fixedTargetId = recoveryTicket
    ? (originTopic?.targetDeviceId || undefined)
    : (sender.targetDeviceId ?? originTopic?.targetDeviceId) || undefined;
  const fixedTarget = fixedTargetId ? getEnvDescriptor(fixedTargetId) : undefined;
  const proposedEnv = params.envId?.trim() || undefined;
  const namedEnvResolution = resolveNamedOrContextualEnv({
    currentText: sender.text, priorUserTurns, envs, proposedEnvId: proposedEnv,
    targetScope: params.targetScope, isRecovery: Boolean(recoveryTicket),
  });
  const namedEnv = namedEnvResolution?.envId;
  if (namedEnvResolution?.source === "current" && fixedTargetId && fixedTargetId !== namedEnv) {
    throw new ProjectError(409, "target_device_conflict", "消息中指定的设备与所选执行设备不同，请核对实际目标。");
  }
  const domainEnv = fixedTargetId ?? recoveryTicket?.envId ?? namedEnv ??
    (!sender.source || sender.source.deviceId === proposedEnv ? proposedEnv : undefined);
  const requestedProject = params.projectId?.trim() || reviewTarget?.projectId || (recoveryTicket ? recoveryTicket.projectId : originTopic?.projectId) || undefined;
  const namedAgent = Boolean(
    dispatchSource.intent || dispatchSource.inheritedAssignment?.source === "explicit" || dispatchSource.inheritedAssignment?.source === "manual",
  );
  const namedComputerAgent = dispatchSource.intent?.targets.some(({ kind, agentId }) => kind || (agentId && activeRoles[agentId]?.external)) ||
    (dispatchSource.inheritedAssignment && activeRoles[dispatchSource.inheritedAssignment.agentId]?.external);
  const inferSourcePhone =
    !domainEnv && !requestedProject && !namedComputerAgent && params.targetScope !== "hub_local" &&
    inputAttachmentIds.length === 0 && sender.source?.kind === "android";
  const executionDomain = params.executionDomain ?? recoveryTicket?.executionDomain ??
    (inferSourcePhone || getEnvDescriptor(domainEnv ?? "")?.executionKind === "native-device" ? "android" : "computer");
  const androidDeviceIds = [...new Set(params.androidDeviceIds ?? recoveryTicket?.androidDeviceIds ?? [])];
  if (androidDeviceIds.length > 8 || androidDeviceIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) {
    throw new ProjectError(400, "invalid_android_targets", "任务手机范围无效。");
  }
  if (executionDomain === "android" && (params.projectId?.trim() || params.workspaceDir?.trim())) {
    throw new ProjectError(400, "android_workspace_denied", "纯手机任务不使用电脑项目或工作目录。");
  }
  return {
    fixedTargetId, fixedTarget, proposedEnv, namedEnvResolution, namedEnv, namedAgent,
    executionDomain, androidDeviceIds, projectId: executionDomain === "android" ? undefined : requestedProject,
  };
}

export interface DispatchAgentEnvPlan {
  routingEnv?: string;
  routing: ReturnType<typeof resolveAgentDispatch>;
  roleId: string;
  rolePreset?: RolePreset;
  externalBinding?: ExternalAgentBinding;
  targetEnvId: string;
  envBinding: TicketEnvBinding;
  waitForSource: boolean;
  agentEnv?: string;
  sourceEnv?: string;
}

export function resolveDispatchAgentAndEnv(input: {
  params: Readonly<DispatchTicketParams>;
  domain: DispatchDomainPlan;
  project?: Readonly<ProjectRecord>;
  modelDispatch: boolean;
  recoveryTicket?: Readonly<TicketRecord>;
  originTopic?: Readonly<DurableTopicRecord>;
  inputs: readonly EntryRecord[];
  sender: ReturnType<typeof chatRoutingData>;
  dispatchSource: DispatchSourceContext;
  envs: readonly EnvNodeDescriptor[];
  localEnvId: string;
  localEnv?: EnvNodeDescriptor;
  activeRoles: Readonly<Record<string, RolePreset>>;
  activeExternalClients?: Readonly<Record<string, ExternalClientConnection>>;
  activeLanguage?: KuloLanguage;
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
  isLocalEnv: (id: string) => boolean;
  executionTrustMode?: ExecutionTrustMode;
  pickDefaultWorkerEnvId: () => string;
}): DispatchAgentEnvPlan {
  const {
    params, domain, project, modelDispatch, recoveryTicket, originTopic, inputs, sender, dispatchSource,
    envs, localEnvId, localEnv, activeRoles, activeExternalClients, activeLanguage, getEnvDescriptor, isLocalEnv, executionTrustMode, pickDefaultWorkerEnvId,
  } = input;
  const { fixedTargetId, fixedTarget, proposedEnv, namedEnvResolution, namedEnv, namedAgent, executionDomain, androidDeviceIds } = domain;
  const trustMode = executionTrustMode ?? LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
  const localReady = Boolean(localEnv?.online && isWorkerEnvReady(localEnv, trustMode, { isLocal: true }));

  if (project && namedEnvResolution?.source === "current" && namedEnv !== project.deviceId) {
    throw new ProjectError(409, "project_binding_conflict", "消息中指定的设备与项目所属设备不同，请核对实际目标。");
  }
  if (!project && modelDispatch && !recoveryTicket && fixedTargetId && fixedTarget?.executionKind !== "native-device") {
    if (proposedEnv && proposedEnv !== fixedTargetId) {
      const lockedName = fixedTarget?.name ?? fixedTargetId;
      throw new ProjectError(409, "target_device_conflict", `当前会话已锁定执行设备「${lockedName}」(${fixedTargetId})，不能改派到 ${proposedEnv}；请先切换或解除会话目标设备。`);
    }
    if (!proposedEnv && params.targetScope === "sender_device" && sender.source?.kind === "computer" && sender.source.deviceId !== fixedTargetId) {
      const lockedName = fixedTarget?.name ?? fixedTargetId;
      throw new ProjectError(409, "target_device_conflict", `当前会话已锁定执行设备「${lockedName}」(${fixedTargetId})，不能按发信设备改派到「${sender.source.name}」；请先切换或解除会话目标设备。`);
    }
  }
  const boundEnv = project?.deviceId ?? fixedTargetId ?? recoveryTicket?.envId ?? namedEnv;
  const sourceEnv = !boundEnv && sender.source?.kind === executionDomain &&
    (!isLocalEnv(sender.source.deviceId) || getEnvDescriptor(localEnvId)) ? sender.source.deviceId : undefined;
  const sourceRootDir = sourceEnv ? getEnvDescriptor(sourceEnv)?.rootDir : undefined;
  const senderLocalSignals = Boolean(
    sourceEnv && executionDomain === "computer" &&
    detectSenderLocalSignals({ userMessage: sender.text, goal: params.goal, scope: params.scope, senderRootDir: sourceRootDir }),
  );
  // Scope default Agent selection to the Hub-verified target, never to a model guess.
  const proposedRole = resolveRoleOrDirectClient(params.role, activeRoles, activeExternalClients, activeLanguage);
  if (!namedAgent && proposedRole?.external) {
    if (boundEnv && !project && proposedRole.external.envId !== boundEnv) {
      throw new ProjectError(409, "agent_device_conflict", `指定的外部 Agent「${proposedRole.label}」绑定在设备 ${proposedRole.external.envId}，与当前目标设备 ${boundEnv} 不一致。`);
    }
    if (sourceEnv && (params.targetScope === "sender_device" || senderLocalSignals) && proposedRole.external.envId !== sourceEnv) {
      throw new ProjectError(409, "agent_device_conflict", `该任务涉及发信设备「${sender.source?.name}」本地环境，不能改派到绑定其他设备的外部 Agent「${proposedRole.label}」。`);
    }
  }
  const routingEnv = boundEnv ?? (
    params.originToolTaskId === undefined
      ? proposedEnv
      : namedAgent
        ? undefined
        : proposedRole?.external
          ? proposedRole.external.envId
          : executionDomain === "computer" && params.targetScope === "hub_local" && !senderLocalSignals && localReady
            ? localEnvId
            : sourceEnv
  );
  const selectionRoles = androidDeviceIds.length || executionDomain === "android"
    ? Object.fromEntries(Object.entries(activeRoles).map(([id, role]) => [id, role.external ? { ...role, dispatchPolicy: undefined } : role]))
    : activeRoles;
  const routing = resolveAgentDispatch({
    roles: selectionRoles, externalClients: activeExternalClients, language: activeLanguage, ...dispatchSource,
    requestedRole: params.role, taskKind: params.taskKind, workspaceMode: params.workspaceMode,
    projectId: project?.id, envId: routingEnv, trustedManual: params.originToolTaskId === undefined,
  });
  const roleId = routing.role;
  const rolePreset = resolveRoleOrDirectClient(roleId, activeRoles, activeExternalClients, activeLanguage);
  const externalBinding = rolePreset?.external;
  const explicitAgentDevice = externalBinding && (routing.source === "explicit" || routing.source === "manual") ? externalBinding.envId : undefined;
  if (modelDispatch && !params.sourceRequestId && !boundEnv && !explicitAgentDevice && inputs.some((inp) =>
    chatRoutingData(inp).source?.deviceId !== sender.source?.deviceId)) {
    throw new ProjectError(409, "source_device_ambiguous", "本轮有来自不同设备的消息，请为本次任务填写对应的 source_request_id。");
  }
  if (externalBinding && rolePreset && (!externalBinding.verifiedAt || isPersonalExternalAgentKind(externalBinding.kind))) {
    throw new ProjectError(409, "external_agent_unverified", `指定的外部 Agent「${rolePreset.label}」尚未完成稳定任务通信验证，请在智能体设置页继续配置。`);
  }
  if (externalBinding && rolePreset && proposedEnv && proposedEnv !== externalBinding.envId) {
    throw new ProjectError(400, "agent_device_conflict", `指定的 Agent「${rolePreset.label}」已绑定其他执行设备，请明确选择同设备的 Agent。`);
  }
  if (externalBinding && (executionDomain === "android" || androidDeviceIds.length || (project && project.deviceId !== externalBinding.envId))) {
    throw new ProjectError(400, "agent_project_conflict", "外部智能体必须使用其绑定电脑上的授权项目。");
  }

  let targetEnvId: string;
  let envBinding: TicketEnvBinding;
  let waitForSource: boolean;
  if (executionDomain === "computer") {
    const resolved = resolveComputerEnvBinding({
      projectDeviceId: project?.deviceId, explicitWorkspaceDir: params.workspaceDir?.trim() || undefined,
      messageTargetDeviceId: !recoveryTicket ? sender.targetDeviceId : undefined,
      topicTargetDeviceId: originTopic?.targetDeviceId, namedEnvId: namedEnv,
      explicitAgentDeviceId: explicitAgentDevice, externalBindingDeviceId: externalBinding?.envId,
      recoveryTicket, sourceEnvId: sourceEnv, sourceRootDir, proposedEnvId: proposedEnv,
      targetScope: params.targetScope, userMessage: sender.text, goal: params.goal, scope: params.scope,
      localEnv, executionTrustMode: trustMode, pickFallbackEnvId: pickDefaultWorkerEnvId,
    });
    if (resolved.conflictWithSource) {
      throw new ProjectError(409, "source_device_conflict", `该消息默认在「${sender.source?.name}」上处理。请省略 env_id，或根据用户明确指定的设备重新派单。`);
    }
    if (!boundEnv && (!proposedEnv || proposedEnv === sourceEnv) && sourceEnv && resolved.envId === sourceEnv && !hasExplicitSenderReference(sender.text)) {
      const briefTargets = [...new Set(namedDispatchDevices(`${params.goal}\n${params.scope}`, envs).filter((ids) => ids.length === 1).map((ids) => ids[0]!))];
      if (briefTargets.length === 1 && briefTargets[0] !== sourceEnv) {
        const intended = getEnvDescriptor(briefTargets[0]!)?.name ?? briefTargets[0]!;
        throw new ProjectError(409, "target_device_mismatch", `工单内容指向设备「${intended}」，但未传入目标 env_id 而默认落到了发信设备「${sender.source?.name}」。请确认用户意图后显式传入目标设备的 env_id，避免误派到发信设备。`);
      }
    }
    targetEnvId = resolved.envId;
    envBinding = resolved.envBinding;
    waitForSource = resolved.waitForSource;
  } else {
    if (sourceEnv && !explicitAgentDevice && proposedEnv && proposedEnv !== sourceEnv) {
      throw new ProjectError(409, "source_device_conflict", `该消息默认在「${sender.source?.name}」上处理。请省略 env_id，或根据用户明确指定的设备重新派单。`);
    }
    const initialEnv = (!explicitAgentDevice && sourceEnv ? sourceEnv : proposedEnv) ?? recoveryTicket?.envId ?? namedEnv;
    targetEnvId = initialEnv ?? fixedTargetId ?? androidDeviceIds[0] ?? pickDefaultWorkerEnvId();
    envBinding = !recoveryTicket && sender.targetDeviceId ? "message_target"
      : originTopic?.targetDeviceId ? "topic_target"
      : namedEnv ? "message_named"
      : sourceEnv ? "sender_local" : "pool_fallback";
    waitForSource = Boolean(sourceEnv && !explicitAgentDevice);
  }

  const agentEnv = project?.deviceId ?? targetEnvId ?? fixedTargetId;
  assertAgentDispatchAvailable(rolePreset, { envs, envId: agentEnv, allowOffline: waitForSource });
  return { routingEnv, routing, roleId, rolePreset, externalBinding, targetEnvId, envBinding, waitForSource, agentEnv, sourceEnv };
}

export interface ResolvedDispatchWorkspace {
  pathApi: typeof path.posix | typeof path.win32;
  sep: string;
  cleanRoot: string;
  scratchRoot: string;
  requestedReadOnly: boolean;
  isReadOnly: boolean;
  builtInWorkspaceMode?: ExternalWorkspaceMode;
  externalWorkspaceMode?: ExternalWorkspaceMode;
  effectiveExecutionMode: ExecutionTrustMode;
  nativeThinking?: string;
  providerOverride?: string;
  modelOverride?: string;
  workerProviderOpt?: string;
  workerModelId: string;
  desiredThinking: ThinkingEffort;
}

export function resolveDispatchWorkspaceAndModel(input: {
  params: Readonly<DispatchTicketParams>;
  domain: DispatchDomainPlan;
  plan: DispatchAgentEnvPlan;
  project?: Readonly<ProjectRecord>;
  reviewTarget?: Readonly<TicketRecord>;
  existingState?: Readonly<KuloDurableState>;
  sender: ReturnType<typeof chatRoutingData>;
  envs: readonly EnvNodeDescriptor[];
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
  isLocalEnv?: (id: string) => boolean;
  executionTrustMode?: ExecutionTrustMode;
  activeExternalClients?: Readonly<Record<string, ExternalClientConnection>>;
  defaultProvider?: string;
  defaultModel: string;
  defaultThinkingLevel: ThinkingEffort;
}): ResolvedDispatchWorkspace {
  const { params, domain, plan, project, reviewTarget, existingState, sender, envs, getEnvDescriptor, isLocalEnv, executionTrustMode, activeExternalClients, defaultProvider, defaultModel, defaultThinkingLevel } = input;
  const { fixedTargetId, fixedTarget, proposedEnv, executionDomain, androidDeviceIds } = domain;
  const { routing, rolePreset, externalBinding, targetEnvId, sourceEnv } = plan;
  const hubTrustMode = executionTrustMode ?? LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
  const targetIsLocal = Boolean(isLocalEnv?.(targetEnvId) || targetEnvId === "local");

  if (project && proposedEnv && proposedEnv !== project.deviceId) {
    throw new ProjectError(400, "project_binding_conflict", "执行设备必须与项目所属设备一致。");
  }
  const pathApi = project?.platform === "win32" || /^[A-Za-z]:[\\/]|^\\\\/.test(project?.workspaceDir ?? "") ? path.win32 : path.posix;
  if (project && params.workspaceDir?.trim() && pathApi.normalize(params.workspaceDir.trim()) !== pathApi.normalize(project.workspaceDir)) {
    throw new ProjectError(400, "project_binding_conflict", "工作目录必须与项目授权目录一致。");
  }
  const targetDescriptor = getEnvDescriptor(targetEnvId);
  if (targetEnvId === sourceEnv && !targetDescriptor) {
    throw new ProjectError(409, "source_env_unavailable", `发信设备「${sender.source?.name}」的执行环境尚未连接。请启动该设备的 Kulo 执行环境，或指定其他设备。`);
  }
  const targetTrustMode = resolveEffectiveExecutionMode({
    hubTrustMode,
    descriptor: targetDescriptor,
    isLocal: targetIsLocal,
  });
  if (params.workspaceMode === "direct" && targetTrustMode !== "trusted") {
    throw new ProjectError(400, "invalid_workspace_mode", "目标设备当前处于隔离沙箱或未支持本机信任协议，不能使用 direct 模式。");
  }
  if (targetEnvId === sourceEnv && executionDomain === "android" && androidDeviceIds.some((id) => id !== sourceEnv)) {
    throw new ProjectError(409, "target_device_conflict", "当前手机任务默认使用发信手机。要操作其他手机，请明确指定目标设备。");
  }
  if (executionDomain === "android" && !androidDeviceIds.length) androidDeviceIds.push(targetEnvId);
  if (executionDomain === "android" ? targetDescriptor?.executionKind !== "native-device" : targetDescriptor?.executionKind === "native-device") {
    throw new ProjectError(400, "execution_domain_mismatch", "任务执行类型与目标设备不符。");
  }
  if (executionDomain === "android" && !androidDeviceIds.includes(targetEnvId)) {
    throw new ProjectError(400, "invalid_android_targets", "纯手机任务必须包含主目标手机。");
  }
  for (const id of androidDeviceIds) {
    const phone = getEnvDescriptor(id);
    if (phone?.executionKind !== "native-device" || !phone.capabilities.includes("android-native-v1")) {
      throw new ProjectError(409, "android_device_unavailable", `手机 ${id} 尚未接入原生控制协议。`);
    }
  }
  if (fixedTargetId) {
    if (fixedTarget?.executionKind === "native-device") {
      if (!androidDeviceIds.length || androidDeviceIds.some((id) => id !== fixedTargetId) || (executionDomain === "android" && targetEnvId !== fixedTargetId)) {
        throw new ProjectError(403, "target_device_conflict", "任务必须使用当前会话明确选择的手机。");
      }
    } else if (targetEnvId !== fixedTargetId || executionDomain !== "computer") {
      throw new ProjectError(403, "target_device_conflict", "任务必须使用当前会话明确选择的电脑。");
    }
  }
  if (!targetDescriptor && !project) {
    throw new Error(`Execution environment '${targetEnvId}' is not registered. Available: ${envs.map((e) => e.id).join(", ")}`);
  }

  const sep = project ? pathApi.sep : targetDescriptor?.platform === "win32" ? "\\" : "/";
  const cleanRoot = executionDomain === "android" ? "" : (targetDescriptor?.rootDir ?? pathApi.dirname(project!.workspaceDir)).replace(/[\\/]+$/, "");
  const scratchRoot = project?.scratchRoot ?? `${cleanRoot}${sep}scratch`;
  const parent = params.parentTicketId ? existingState?.tickets[params.parentTicketId] : undefined;
  if (params.parentTicketId && (!parent?.externalExecution || parent.status !== "running" || !parent.externalExecution.allowSubagents || parent.envId !== targetEnvId || parent.projectId !== project?.id)) {
    throw new ProjectError(403, "external_parent_invalid", "子任务的父级执行资格或项目范围已失效。");
  }
  const requestedReadOnly = Boolean(reviewTarget || rolePreset?.readOnly || routing.readOnly || (parent && isEffectiveExternalReadOnly(parent)) || params.workspaceMode === "read_only");
  // Native clients own their tool permissions; a task's read-only request is not a host-enforced write guarantee.
  const isReadOnly = !externalBinding && requestedReadOnly;
  const defaultWriteWorkspaceMode: ExternalWorkspaceMode = targetTrustMode === "trusted" ? "direct" : "staged";
  const builtInWorkspaceMode: ExternalWorkspaceMode | undefined =
    externalBinding || executionDomain === "android" || !project ? undefined : requestedReadOnly ? "read_only" : params.workspaceMode ?? defaultWriteWorkspaceMode;
  const externalWorkspaceMode: ExternalWorkspaceMode | undefined =
    !externalBinding || !project ? undefined : requestedReadOnly ? "read_only" : params.workspaceMode ?? defaultWriteWorkspaceMode;
  const requireOsIsolation = !externalBinding && executionDomain === "computer" && Boolean(isReadOnly || builtInWorkspaceMode === "staged");
  const effectiveExecutionMode = resolveEffectiveExecutionMode({
    hubTrustMode,
    descriptor: targetDescriptor,
    isLocal: targetIsLocal,
    requireOsIsolation,
  });
  if (
    !externalBinding &&
    executionDomain === "computer" &&
    targetDescriptor?.online &&
    !isWorkerEnvReady(targetDescriptor, effectiveExecutionMode, { isLocal: targetIsLocal, requireOsIsolation })
  ) {
    throw new ProjectError(
      409,
      "worker_isolation_unavailable",
      requireOsIsolation
        ? `目标执行设备「${targetDescriptor.name}」缺少原生隔离后端，无法兑现该任务的只读或隔离副本约束。`
        : `目标执行设备「${targetDescriptor.name}」未启用沙箱隔离能力，无法运行内置后台 Worker。`,
    );
  }

  let nativeThinking: string | undefined;
  if (externalBinding && rolePreset) {
    if (rolePreset.thinkingLevel && rolePreset.thinkingLevel !== "auto") {
      nativeThinking = rolePreset.thinkingLevel;
    } else if (params.thinkingLevel) {
      const clientId = rolePreset.externalClientId?.trim() || externalClientConnectionId(externalBinding);
      const clientModels = activeExternalClients?.[clientId]?.models ?? [];
      const targetModel = rolePreset.modelId
        ? clientModels.find((m) => m.id === rolePreset.modelId)
        : clientModels.find((m) => m.isDefault) ?? clientModels[0];
      const efforts = targetModel?.efforts ?? [];
      if (efforts.includes(params.thinkingLevel)) nativeThinking = params.thinkingLevel;
      else if (params.thinkingLevel === "off" && efforts.includes("none")) nativeThinking = "none";
    }
  }
  const providerOverride = !externalBinding && params.providerOverride?.trim() ? params.providerOverride.trim() : undefined;
  const modelOverride = !externalBinding && params.modelOverride?.trim() ? params.modelOverride.trim() : undefined;
  const workerProviderOpt = providerOverride || rolePreset?.provider?.trim() || defaultProvider;
  const workerModelId = modelOverride || rolePreset?.modelId?.trim() || defaultModel;
  const desiredThinking: ThinkingEffort =
    params.thinkingLevel ?? (rolePreset?.thinkingLevel && rolePreset.thinkingLevel !== "auto" ? rolePreset.thinkingLevel : defaultThinkingLevel);
  return {
    pathApi, sep, cleanRoot, scratchRoot, requestedReadOnly, isReadOnly, builtInWorkspaceMode, externalWorkspaceMode, effectiveExecutionMode,
    nativeThinking, providerOverride, modelOverride, workerProviderOpt, workerModelId, desiredThinking,
  };
}
