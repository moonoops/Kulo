import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { RolePreset, TicketCardView, TicketRecord } from "@kulo/protocol";
import type { KuloActionConfirmations, PendingActionConfirmation } from "./action-confirmations.js";
import { writeDeliveryReceipt, type DeliveryIntent } from "./delivery-receipts.js";
import { KuloProjectsDoc, ProjectError } from "./projects.js";
import {
  KuloStateDoc,
  isTicketUnfinished,
  recordProcessedCommand,
  releaseSlot,
  toTicketCardView,
  transitionTicketStatus,
  type KuloDurableState,
} from "./state.js";
import { sameRecoveryScope } from "./task-recovery.js";
import type { KuloUiCards } from "./ui-cards.js";

export interface AdmittedTicketStop {
  epoch: number;
  previousEpoch: number;
  activeTaskId?: number;
  stoppedReason: string;
  priorWaitingCardId?: string;
}

export interface DirectStopTarget {
  ticketId: string;
  reason: string;
}

export interface FinalizeTicketStopDeps {
  harness: Harness;
  actionConfirmations: KuloActionConfirmations;
  uiCards: KuloUiCards;
  getRoles: () => Record<string, RolePreset>;
  clearComputerHandoff: (ticketId: string) => void;
  cancelConnectionRequests: (ticketId: string) => void;
  stopChildTicket: (childId: string, reason: string, context: Context) => Promise<TicketCardView>;
  stopMediaJobs: (ticketId: string) => Promise<void>;
  releaseTicketExecution: (ticket: Readonly<TicketRecord>) => Promise<{ cleanupPending: boolean }>;
  untrackWorker: (ticketId: string, previousEpoch: number) => void;
  resumeIfReady: (cleanupPending: boolean) => void;
  broadcastTickets: (context: Context) => Promise<void>;
}

/**
 * Tickets eligible for direct stop from a decision card, handoff cancel, or fallback steer.
 * Excludes settled `ready`/`closed` tickets so stale cards never overwrite completed work or drop staged diffs.
 */
export function canDirectStopTicket(ticket: Readonly<TicketRecord>): boolean {
  return isTicketUnfinished(ticket) || ticket.recovery?.state === "recovering" || ticket.schedule?.nextRunAt != null;
}

/**
 * Identifies whether clicking `actionId` on a card-bound confirmation represents an atomic direct-stop action.
 */
export function resolveDirectStopCardTarget(
  pending: Readonly<PendingActionConfirmation> | undefined,
  actionId: string,
): DirectStopTarget | undefined {
  const logical = pending?.actionMap[actionId];
  if (!pending || !logical || logical === "manual") return undefined;
  if (pending.payload.kind === "ticket_decision") {
    const chosen = pending.payload.options.find((opt) => opt.id === logical);
    if (chosen?.action === "stop") {
      return {
        ticketId: pending.payload.ticketId,
        reason: chosen.value?.trim() || chosen.label || "手动停止",
      };
    }
    return undefined;
  }
  if (pending.payload.kind === "computer_handoff" && logical === "cancel") {
    return {
      ticketId: pending.payload.ticketId,
      reason: "用户跳过人工接管并停止任务",
    };
  }
  return undefined;
}

/**
 * Identifies whether a legacy/outbox `ticket.steer` with `decisionOptionId` targets a direct-stop option.
 */
export function resolveSteerDirectStopReason(
  ticket: Readonly<TicketRecord>,
  linkedPending: Readonly<PendingActionConfirmation> | undefined,
  decisionOptionId: string,
  text: string,
): string | undefined {
  const waitingOption = ticket.waiting?.options?.find((opt) => opt.id === decisionOptionId);
  const confirmationOption = linkedPending?.payload.kind === "ticket_decision" &&
    (linkedPending.status === "pending" || linkedPending.status === "pending_orchestrator")
    ? linkedPending.payload.options.find((opt) => opt.id === decisionOptionId)
    : undefined;
  const isComputerHandoffCancel = linkedPending?.payload.kind === "computer_handoff" &&
    linkedPending.status === "pending" &&
    decisionOptionId === "cancel";
  if (isComputerHandoffCancel) return "用户跳过人工接管并停止任务";
  const stopOption = waitingOption?.action === "stop"
    ? waitingOption
    : confirmationOption?.action === "stop"
      ? confirmationOption
      : undefined;
  if (!stopOption) return undefined;
  return text.trim() || stopOption.value?.trim() || stopOption.label || "手动停止";
}

/**
 * Phase 1 (pure in-tx admission) for stopping a ticket.
 * Callers on the `submitUiAction` path must omit `commandId` and `intent` so `UiCardsDoc.receipts`
 * remains the sole idempotency domain and retries can finish Phase 2 via `KuloProjectsDoc.cancellations`.
 */
export async function admitTicketStopInTx(
  tx: Tx,
  params: {
    ticketId: string;
    reason: string | undefined;
    commandId?: string;
    intent?: DeliveryIntent;
    deleteSchedule?: boolean;
  },
): Promise<AdmittedTicketStop> {
  const state = await tx.doc(KuloStateDoc);
  const t = state.tickets[params.ticketId]!;
  const previousEpoch = t.runEpoch;
  const previousTaskId = t.activeTaskId;
  const priorWaitingCardId = t.waiting?.cardId;
  if (params.commandId) {
    recordProcessedCommand(state, params.commandId, params.ticketId, "stop");
  }
  t.runEpoch += 1;
  const now = Date.now();
  transitionTicketStatus(t, "stopped", now);
  const previousRecovery = t.recovery;
  t.recovery = undefined;
  const suppressLineage = (origin: Readonly<TicketRecord>, prior: NonNullable<TicketRecord["recovery"]>) => {
    const rootId = prior.rootTicketId ?? origin.id;
    for (const related of Object.values(state.tickets)) {
      if (
        related.id !== origin.id &&
        sameRecoveryScope(origin, related) &&
        related.recovery?.startedAt === prior.startedAt &&
        (related.recovery.rootTicketId ?? related.id) === rootId
      ) {
        related.recovery = undefined;
        related.autoRecoverySuppressed = true;
        related.updatedAt = now;
      }
    }
  };
  if (previousRecovery) {
    t.autoRecoverySuppressed = true;
    suppressLineage(t, previousRecovery);
  }
  if (t.supersedes?.length) {
    const visited = new Set<string>([t.id]);
    const pending = [...t.supersedes];
    while (pending.length) {
      const ancestorId = pending.pop()!;
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);
      const ancestor = state.tickets[ancestorId];
      if (!ancestor || !sameRecoveryScope(t, ancestor)) continue;
      if (ancestor.supersedes?.length) pending.push(...ancestor.supersedes);
      if (ancestor.recovery) {
        const ancestorPrior = ancestor.recovery;
        ancestor.recovery = undefined;
        ancestor.autoRecoverySuppressed = true;
        ancestor.updatedAt = now;
        suppressLineage(ancestor, ancestorPrior);
      }
    }
  }
  t.stoppedReason = params.reason?.trim() || "Stopped by user";
  t.activeTaskId = undefined;
  t.waiting = undefined;
  delete t.quotaPause;
  delete t.runHealthStuck;
  if (t.schedule) t.schedule.nextRunAt = null;
  if (params.deleteSchedule) {
    if (!t.schedule) throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
    t.schedule.deletedAt ??= Date.now();
    t.schedule.nextRunAt = null;
  }
  t.resumePrompt = undefined;
  t.resumeAttachmentIds = undefined;
  t.wakePending = undefined;
  t.cleanupPending = true;
  t.updatedAt = Date.now();
  const projects = await tx.doc(KuloProjectsDoc);
  projects.cancellations ??= {};
  projects.cancellations[params.ticketId] = {
    ...(t.projectId ? { projectId: t.projectId } : {}),
    reason: t.stoppedReason,
    requestedAt: t.updatedAt,
  };
  if (params.intent) {
    await writeDeliveryReceipt(tx, params.intent, { ticketId: params.ticketId }, "admitted", {
      mode: "stop",
      reason: t.stoppedReason,
      epoch: t.runEpoch,
      previousEpoch,
      ...(previousTaskId === undefined ? {} : { taskId: previousTaskId }),
    });
  }
  return {
    epoch: t.runEpoch,
    previousEpoch,
    ...(previousTaskId === undefined ? {} : { activeTaskId: previousTaskId }),
    stoppedReason: t.stoppedReason,
    ...(priorWaitingCardId ? { priorWaitingCardId } : {}),
  };
}

/**
 * Phase 2 (out-of-tx async cleanup, must be called inside `#queueTicketOperation(ticketId)`).
 */
export async function finalizeTicketStop(
  deps: FinalizeTicketStopDeps,
  params: {
    ticketId: string;
    reason: string | undefined;
    epoch: number;
    previousEpoch: number;
    activeTaskId?: number;
    priorWaitingCardId?: string;
    snapshot: Readonly<KuloDurableState> | undefined;
    ticket: Readonly<TicketRecord>;
    intent?: DeliveryIntent;
  },
  context: Context,
): Promise<TicketCardView> {
  const { ticketId, reason, epoch, previousEpoch, activeTaskId, priorWaitingCardId, snapshot, ticket, intent } = params;
  deps.clearComputerHandoff(ticketId);
  deps.cancelConnectionRequests(ticketId);
  // Stop unfinished descendants top-down through each child's ticket queue (parent -> child DAG cannot deadlock).
  const childStops = await Promise.allSettled(
    Object.values(snapshot?.tickets ?? {})
      .filter((child) => child.id !== ticketId && child.parentTicketId === ticketId && (isTicketUnfinished(child) || child.cleanupPending))
      .map((child) => deps.stopChildTicket(child.id, reason ?? "父任务已停止", context)),
  );
  const childCleanupPending = childStops.some((result) => result.status === "rejected" || result.value.cleanupPending);
  for (const result of childStops) {
    if (result.status === "rejected") console.error(`[KuloChildCleanup:${ticketId}]`, result.reason);
  }
  await deps.stopMediaJobs(ticketId);
  const conversations = [
    ticket.workerConversationId,
    ...Object.values(snapshot?.subagents ?? {})
      .filter((s) => s.ticketId === ticketId)
      .map((s) => s.conversationId),
  ];
  await Promise.all(
    conversations.map(async (id) => {
      const conversation = await deps.harness.conversation(id as ConversationId, context);
      if (conversation) await conversation.abort(context, { background: true });
    }),
  );
  if (typeof activeTaskId === "number") await deps.harness.abortTask(activeTaskId as never, context);
  const stoppedSnapshot = (await deps.harness.snapshot(KuloStateDoc, context))?.tickets[ticketId] ?? ticket;
  const cleanup = await deps.releaseTicketExecution(stoppedSnapshot);
  const card = await deps.harness.commit(async (tx) => {
    const state = await tx.doc(KuloStateDoc);
    const t = state.tickets[ticketId]!;
    if (t.runEpoch === epoch) {
      for (const sub of Object.values(state.subagents ?? {})) if (sub.ticketId === ticketId) sub.state = "stopped";
      t.waiting = undefined;
      t.cleanupPending = cleanup.cleanupPending || childCleanupPending;
      if (!t.cleanupPending) {
        if (t.workspaceStaging && !t.workspaceStaging.appliedAt && !t.workspaceStaging.discardedAt) {
          t.workspaceStaging.discardedAt = Date.now();
          delete t.workspaceStaging.stagedCwd;
          delete t.workspaceStaging.stagedDiff;
        }
        if (t.externalExecution && !t.externalExecution.stagedAppliedAt) {
          delete t.externalExecution.stagedCwd;
          delete t.externalExecution.stagedDiff;
        }
      }
      releaseSlot(state, ticketId);
      const projects = await tx.doc(KuloProjectsDoc);
      delete projects.cancellations?.[ticketId];
    }
    await writeDeliveryReceipt(
      tx,
      intent,
      { ticketId },
      "complete",
      priorWaitingCardId ? { priorWaitingCardId } : {},
    );
    return toTicketCardView(t, deps.getRoles());
  }, context);
  let tailError: unknown;
  try {
    await deps.actionConfirmations.settlePendingForTicket(ticketId, "任务已停止", undefined, context);
  } catch (error) {
    tailError ??= error;
  }
  if (priorWaitingCardId) {
    try {
      await deps.uiCards.settle(priorWaitingCardId, { status: "cancelled", resultSummary: "任务已停止" });
    } catch (error) {
      tailError ??= error;
    }
  }
  deps.untrackWorker(ticketId, previousEpoch);
  deps.resumeIfReady(Boolean(card.cleanupPending));
  try {
    await deps.broadcastTickets(context);
  } catch (error) {
    tailError ??= error;
  }
  if (tailError !== undefined) throw tailError;
  return card;
}
