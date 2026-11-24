import { randomUUID } from "node:crypto";
import {
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  ChatAttachment,
  ChatReplyReference,
  ExecutionTrustMode,
  RolePreset,
  TicketCardView,
  TicketRecord,
} from "@kulo/protocol";
import {
  legacyDeliveryConflict,
  writeDeliveryReceipt,
  type DeliveryIntent,
} from "./delivery-receipts.js";
import { userDisplayEntry } from "./hub-chat-pipeline.js";
import { assertProjectBinding, KuloProjectsDoc, ProjectError } from "./projects.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import {
  isActiveSettingsConversation,
  parseSettingsTopicConversationId,
  SettingsAssistantDoc,
} from "./settings-assistant.js";
import {
  getActiveStagedCwd,
  hasActiveSubagents,
  hasPendingWorkspaceApply,
  isActiveRootConversation,
  isTicketUnfinished,
  KuloStateDoc,
  recordProcessedCommand,
  releaseProjectWrite,
  releaseSlot,
  toTicketCardView,
  transitionTicketStatus,
  type WorkerRecoveryEntryData,
} from "./state.js";
import { pruneClosedSubagentsInTx, settlePendingSubagentsInTx } from "./subagent-runner.js";
import { assertRecoveryGuard, sameRecoveryScope } from "./task-recovery.js";
import type { CloseTicketParams, SteerTicketParams } from "./tools-router.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export interface AdmitTicketSteerOutcome {
  card: TicketCardView;
  created: boolean;
  injected: boolean;
  interruptTarget?: { envId: string; runId: string };
}

export async function admitTicketSteerInTx(
  tx: Tx,
  input: {
    params: Readonly<SteerTicketParams>;
    cleanCmdId?: string;
    intent?: DeliveryIntent;
    recoveryGuard?: WorkerRecoveryEntryData;
    workerConv: Conversation;
    prompt: string;
    modelPrompt: string;
    replyTo?: ChatReplyReference;
    preparedContent: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    preparedAttachments: ChatAttachment[];
    attachmentIds: readonly string[];
    activeRoles: Readonly<Record<string, RolePreset>>;
    isParking: (ticketId: string) => boolean;
    isTicketDevicesOnline: (ticket: Readonly<TicketRecord>) => boolean;
    resolveExecutionMode?: (ticket: Readonly<TicketRecord>) => ExecutionTrustMode;
    workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  },
): Promise<AdmitTicketSteerOutcome> {
  const {
    params,
    cleanCmdId,
    intent,
    recoveryGuard,
    workerConv,
    prompt,
    modelPrompt,
    replyTo,
    preparedContent,
    preparedAttachments,
    attachmentIds,
    activeRoles,
    isParking,
    isTicketDevicesOnline,
    workerTicketTask,
  } = input;

  const state = await tx.doc(KuloStateDoc);
  const t = state.tickets[params.ticketId];
  if (!t || t.status === "stopped" || t.status === "closed") {
    throw new ProjectError(409, "ticket_stopped", "任务已停止，不能恢复。");
  }
  if (t.schedule) {
    const settingsDoc = await tx.doc(SettingsAssistantDoc);
    const settingsConv = parseSettingsTopicConversationId(t.originTopicId);
    if (settingsConv !== null) {
      if (!isActiveSettingsConversation(settingsConv, settingsDoc)) {
        throw new ProjectError(404, "topic_deleted", "定时任务所属会话已删除。");
      }
    } else {
      const origin = state.topics?.[t.originTopicId ?? "root"];
      if (!origin || origin.deletedAt !== undefined) {
        throw new ProjectError(404, "topic_deleted", "定时任务所属会话已删除。");
      }
    }
  }
  if (cleanCmdId && state.processedCommands?.[cleanCmdId]) {
    legacyDeliveryConflict();
  }
  assertRecoveryGuard(state, recoveryGuard);
  if (params.resetRecovery) {
    const prior = t.recovery;
    if (prior) {
      for (const related of Object.values(state.tickets)) {
        if (related.recovery?.startedAt === prior.startedAt && related.recovery.rootTicketId === prior.rootTicketId) {
          related.recovery = undefined;
        }
      }
    }
    t.recovery = undefined;
    t.autoRecoverySuppressed = undefined;
  }
  if (t.projectId) {
    const project = assertProjectBinding(await tx.doc(KuloProjectsDoc), t.projectId);
    if (project.grantRevision !== t.grantRevision || project.directoryId !== t.directoryId || project.deviceId !== t.envId) {
      throw new ProjectError(409, "project_binding_changed", "项目位置已改变，请创建新任务。");
    }
  }
  recordProcessedCommand(state, cleanCmdId, t.id, "steer");
  await writeDeliveryReceipt(tx, intent, { ticketId: t.id });

  if (!t.externalExecution && t.status === "running" && !t.waiting && !isParking(t.id) && isTicketDevicesOnline(t)) {
    await workerConv.submit(tx, {
      type: "input",
      content: preparedContent,
      entry: userDisplayEntry(`【主控补充引导】\n${prompt}`, preparedAttachments, undefined, replyTo),
      whenBusy: "steer",
      requestId: `kulo:steer:${cleanCmdId ?? randomUUID()}`,
    });
    t.updatedAt = Date.now();
    return { card: toTicketCardView(t, activeRoles), created: false, injected: true };
  }

  if (replyTo) {
    // A parked worker receives this context on resume; keep its user-facing reply visible immediately without duplicating model input.
    const display = userDisplayEntry(`【主控补充引导】\n${prompt}`, preparedAttachments, { createdAt: Date.now() }, replyTo);
    await tx.appendEntry(workerConv.id, display);
  }
  t.resumePrompt = [t.resumePrompt, `[Follow-Up / Resume Instructions]\n${modelPrompt}`].filter(Boolean).join("\n\n");
  t.resumeAttachmentIds = [...new Set([...(t.resumeAttachmentIds ?? []), ...attachmentIds])];
  t.updatedAt = Date.now();
  if (t.externalExecution && t.status === "running") {
    t.wakePending = true;
    let interruptTarget: { envId: string; runId: string } | undefined;
    if (params.interrupt && t.externalExecution.runId) {
      t.externalExecution.interruptPending = true;
      interruptTarget = { envId: t.envId, runId: t.externalExecution.runId };
    }
    return { card: toTicketCardView(t, activeRoles), created: false, injected: false, interruptTarget };
  }
  if (t.schedule?.nextRunAt != null && t.schedule.nextRunAt > Date.now()) {
    return { card: toTicketCardView(t, activeRoles), created: false, injected: false };
  }
  if (t.status === "queued") {
    return { card: toTicketCardView(t, activeRoles), created: false, injected: false };
  }
  t.wakePending = true;
  if (t.status === "pausing" || (t.status === "running" && isParking(t.id))) {
    return { card: toTicketCardView(t, activeRoles), created: false, injected: false };
  }
  if (!isTicketDevicesOnline(t) || t.cleanupPending || hasActiveSubagents(state, t.id)) {
    transitionTicketStatus(t, "waiting", Date.now());
    t.waiting = { reason: "env", since: Date.now(), detail: t.cleanupPending ? "等待确认旧执行已清理" : "等待执行设备上线" };
    return { card: toTicketCardView(t, activeRoles), created: false, injected: false };
  }
  const nextEpoch = t.runEpoch + 1;
  if (t.externalExecution) {
    delete t.externalExecution.runId;
    delete t.externalExecution.pendingPermissions;
  }
  const taskId = await tx.createTask(
    workerTicketTask,
    { ticketId: t.id, runEpoch: nextEpoch, promptOverride: t.resumePrompt, attachmentIds: t.resumeAttachmentIds },
    { ownership: { kind: "conversation" }, conversationId: (t.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, background: true },
  );
  t.runEpoch = nextEpoch;
  const priorMode = state.ticketExecutionModes?.[t.id]?.mode;
  const resolvedMode = input.resolveExecutionMode ? input.resolveExecutionMode(t) : priorMode;
  if (resolvedMode) {
    state.ticketExecutionModes ??= {};
    state.ticketExecutionModes[t.id] = { runEpoch: nextEpoch, mode: resolvedMode };
  }
  transitionTicketStatus(t, "queued", Date.now());
  t.activeTaskId = Number(taskId);
  t.waiting = undefined;
  if (t.schedule) t.schedule.nextRunAt = null;
  t.resumePrompt = undefined;
  t.resumeAttachmentIds = undefined;
  t.wakePending = undefined;
  t.latestReport = { state: "progress", summary: "已收到补充要求，等待执行。", at: Date.now() };
  return { card: toTicketCardView(t, activeRoles), created: true, injected: false };
}

export interface AdmitTicketCloseOutcome {
  card: TicketCardView;
  changed: boolean;
  stagedToDiscard?: TicketRecord;
}

export async function admitTicketCloseInTx(
  tx: Tx,
  input: {
    params: Readonly<CloseTicketParams>;
    cleanCmdId?: string;
    intent?: DeliveryIntent;
    recoveryGuard?: WorkerRecoveryEntryData;
    activeRoles: Readonly<Record<string, RolePreset>>;
  },
): Promise<AdmitTicketCloseOutcome> {
  const { params, cleanCmdId, intent, recoveryGuard, activeRoles } = input;
  const state = await tx.doc(KuloStateDoc);
  const t = state.tickets[params.ticketId];
  if (!t) throw new Error(`Ticket '${params.ticketId}' not found`);
  if (params.originConversationId !== undefined) {
    const callerTopicId = state.conversationToTopic?.[String(params.originConversationId)];
    const callerTopic = callerTopicId ? state.topics?.[callerTopicId] : undefined;
    const isGlobalCaller = isActiveRootConversation(params.originConversationId, state) || Boolean(callerTopic?.master && callerTopic.deletedAt === undefined);
    const sameConv = (t.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === params.originConversationId;
    const sameProject = Boolean(callerTopic?.projectId && t.projectId === callerTopic.projectId);
    if (!isGlobalCaller && !sameConv && !sameProject) {
      throw new ProjectError(403, "ticket_scope_denied", "不能跨会话关闭其他对话的任务。");
    }
  }
  if (cleanCmdId && state.processedCommands?.[cleanCmdId]) {
    legacyDeliveryConflict();
  }
  assertRecoveryGuard(state, recoveryGuard);
  if (recoveryGuard && params.kind !== "superseded") {
    throw new Error("未解决的失败不能在自动恢复中忽略。");
  }
  if (t.status === "closed" && params.originConversationId === undefined) {
    await writeDeliveryReceipt(tx, intent, { ticketId: params.ticketId });
    return { card: toTicketCardView(t, activeRoles), changed: false };
  }
  if (isTicketUnfinished(t)) {
    throw new Error(`Ticket '${params.ticketId}' is still ${t.status}; stop it or wait until settled before closing.`);
  }
  if (t.status === "stopped" && params.originConversationId !== undefined) {
    throw new Error(`Ticket '${params.ticketId}' is human-stopped; cannot overwrite as closed.`);
  }
  if (params.kind === "superseded" && !params.replacementTicketId) {
    throw new Error("replacementTicketId is required when kind='superseded'");
  }
  if (params.kind === "superseded") {
    const replacement = state.tickets[params.replacementTicketId!];
    if (!replacement || replacement.status !== "ready" || !sameRecoveryScope(t, replacement) || !replacement.supersedes?.includes(t.id)) {
      throw new Error("替代任务尚未成功完成。");
    }
  }

  recordProcessedCommand(state, cleanCmdId, params.ticketId, "close");
  await writeDeliveryReceipt(tx, intent, { ticketId: params.ticketId });
  const now = Date.now();
  let stagedToDiscard: TicketRecord | undefined;
  if (!t.cleanupPending && (getActiveStagedCwd(t) || hasPendingWorkspaceApply(t))) {
    stagedToDiscard = cloneJson(t);
    if (t.workspaceStaging && !t.workspaceStaging.appliedAt) {
      t.workspaceStaging.discardedAt = now;
      delete t.workspaceStaging.stagedCwd;
      delete t.workspaceStaging.stagedDiff;
    }
    if (t.externalExecution && !t.externalExecution.stagedAppliedAt) {
      delete t.externalExecution.stagedCwd;
      delete t.externalExecution.stagedDiff;
    }
  }
  transitionTicketStatus(t, "closed", now);
  settlePendingSubagentsInTx(state, t.id, now);
  if (t.schedule) t.schedule.nextRunAt = null;
  releaseProjectWrite(state, t.id, { force: !t.cleanupPending });
  const prior = t.recovery;
  t.recovery = undefined;
  if (prior && (prior.rootTicketId ?? t.id) === t.id) {
    for (const related of Object.values(state.tickets)) {
      if (related.recovery?.rootTicketId === t.id && related.recovery.startedAt === prior.startedAt) {
        related.recovery = undefined;
        related.autoRecoverySuppressed = true;
      }
    }
  }
  t.closure = {
    kind: params.kind,
    reason: params.reason.trim(),
    ...(params.replacementTicketId ? { replacementTicketId: params.replacementTicketId } : {}),
    at: now,
  };
  t.updatedAt = now;
  pruneClosedSubagentsInTx(state);
  return { card: toTicketCardView(t, activeRoles), changed: true, stagedToDiscard };
}

export async function admitParkTicketStartInTx(
  tx: Tx,
  ticketId: string,
  expectedEpoch: number,
  nextEpoch: number,
  preservedWait: NonNullable<TicketRecord["waiting"]>,
): Promise<boolean> {
  const state = await tx.doc(KuloStateDoc);
  const t = state.tickets[ticketId];
  if (!t || t.runEpoch !== expectedEpoch || !isTicketUnfinished(t) || t.status === "waiting" || t.status === "blocked") {
    return false;
  }
  t.runEpoch = nextEpoch;
  if (state.ticketExecutionModes?.[ticketId]) {
    state.ticketExecutionModes[ticketId] = { runEpoch: nextEpoch, mode: state.ticketExecutionModes[ticketId]!.mode };
  }
  transitionTicketStatus(t, "pausing", Date.now());
  t.waiting = t.waiting && t.waiting.reason !== "project" ? t.waiting : preservedWait;
  t.updatedAt = Date.now();
  return true;
}

export async function admitParkTicketFinishInTx(
  tx: Tx,
  input: {
    ticketId: string;
    epoch: number;
    cleanupPending: boolean;
    workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  },
): Promise<void> {
  const state = await tx.doc(KuloStateDoc);
  const t = state.tickets[input.ticketId];
  if (!t || t.runEpoch !== input.epoch || t.status !== "pausing") return;
  for (const sub of Object.values(state.subagents ?? {})) {
    if (sub.ticketId === input.ticketId && !["ready", "failed", "stopped"].includes(sub.state ?? "")) {
      sub.state = "waiting";
    }
  }
  transitionTicketStatus(t, "waiting", Date.now());
  if (t.deliveryClaim === "inline_waiting") {
    t.deliveryClaim = "escalated";
  }
  t.activeTaskId = undefined;
  t.cleanupPending = input.cleanupPending;
  t.updatedAt = Date.now();
  releaseSlot(state, input.ticketId);
  if (t.waiting?.reason === "time") {
    const id = await tx.createTask(
      input.workerTicketTask,
      { ticketId: input.ticketId, runEpoch: t.runEpoch, promptOverride: null },
      { ownership: { kind: "conversation" }, conversationId: (t.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, background: true },
    );
    t.activeTaskId = Number(id);
  }
}
