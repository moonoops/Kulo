import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import {
  resolveRolePresetFromPool,
  type TicketCardView,
  type TicketRecord,
} from "@kulo/protocol";
import type { KuloActionConfirmations } from "./action-confirmations.js";
import {
  assertAgentDispatchAvailable,
  extractAgentDispatchIntent,
  resolveAgentDispatch,
  resolveRoleOrDirectClient,
} from "./agent-routing.js";
import { submitAutomaticChatInput } from "./chat-control.js";
import { formatComputerHandoffResumePrompt } from "./computer-handoff.js";
import type { KuloConnections } from "./connections.js";
import {
  assertValidReplyReference,
  clientDeliveryIntent,
  legacyDeliveryConflict,
  writeDeliveryReceipt,
  type DeliveryIntent,
  type DeliveryReceipt,
} from "./delivery-receipts.js";
import { executeApprovedHostAction } from "./host-action-execution.js";
import { replyContext } from "./hub-chat-pipeline.js";
import type { HubComputerController } from "./hub-computer-controller.js";
import type { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import type { HubHostActions } from "./hub-host-actions.js";
import type {
  HubRuntimeGates,
  LiveSettingsStore,
  TurnContextReader,
} from "./hub-kernel-ports.js";
import type { HubWatchdog } from "./hub-watchdog.js";
import type { KuloMediaJobs } from "./media-jobs.js";
import { KuloProjects, ProjectError } from "./projects.js";
import { formatUserTaskInstructionMessage } from "./prompts.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import { classifyTicketOutcome, recordTicketOutcomeToWorkingMemory } from "./working-memory.js";
import {
  CoordinatorEventEntry,
  isAutomaticSystemInputEntry,
  isLegacyAutonomousUserEntry,
  isTicketUnfinished,
  KuloStateDoc,
  recordProcessedCommand,
  toTicketCardView,
  WorkerRecoveryEntry,
} from "./state.js";
import { assertRecoveryGuard } from "./task-recovery.js";
import { admitTicketCloseInTx, admitTicketSteerInTx } from "./ticket-control-tx.js";
import type { TicketDispatchService } from "./ticket-dispatch-service.js";
import { areTicketDevicesOnline } from "./ticket-dispatch.js";
import type { TicketReconciler } from "./ticket-reconciler.js";
import type { TicketStagedApplyService } from "./ticket-staged-apply.js";
import {
  admitTicketStopInTx,
  canDirectStopTicket,
  finalizeTicketStop,
  resolveSteerDirectStopReason,
  type FinalizeTicketStopDeps,
} from "./ticket-stop.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import type { CloseTicketParams, SteerTicketParams } from "./tools-router.js";
import type { KuloUiCards } from "./ui-cards.js";
import type { KuloUploadStore } from "./uploads.js";

export interface TicketControlPorts {
  turnContext: TurnContextReader;
  reconciler: TicketReconciler;
  watchdog: Pick<HubWatchdog, "untrack">;
  computer: Pick<HubComputerController, "clearHandoff">;
  hostActions: Pick<HubHostActions, "execDeps">;
  stagedApply: Pick<TicketStagedApplyService, "discardTicketStagedWorkspace">;
  ticketDispatch: Pick<TicketDispatchService, "agentDispatchSource">;
  mediaJobs: () => KuloMediaJobs;
  workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  transcribeVoiceAsset: (
    assetId: string,
    opts: { topicId: string; principalId: string },
    context: Context,
  ) => Promise<unknown>;
}

export interface TicketControlServiceDeps {
  harness: Harness;
  envManager: EnvManager;
  projects: KuloProjects;
  uploads: KuloUploadStore;
  connectionManager: KuloConnections;
  actionConfirmations: KuloActionConfirmations;
  uiCards: KuloUiCards;
  liveSettings: LiveSettingsStore;
  delivery: HubDeliveryCoordinator;
  runtimeGates: HubRuntimeGates;
  ports: TicketControlPorts;
}

export class TicketControlService {
  readonly #deps: TicketControlServiceDeps;

  constructor(deps: TicketControlServiceDeps) {
    this.#deps = deps;
  }

  #ticketDevicesOnline(ticket: Readonly<TicketRecord>): boolean {
    return areTicketDevicesOnline(ticket, (id) => this.#deps.envManager.getEnvDescriptor(id));
  }

  async receiptTicket(receipt: Readonly<DeliveryReceipt>, context: Context): Promise<TicketCardView> {
    const ticketId = String(receipt.ack.ticketId);
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new Error(`Stored delivery refers to a missing ticket '${ticketId}'`);
    return toTicketCardView(ticket, this.#deps.liveSettings.get().roles);
  }

  async #replayStopReceipt(receipt: Readonly<DeliveryReceipt>, context: Context): Promise<TicketCardView> {
    const ticketId = String(receipt.ack.ticketId);
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new Error(`Stored delivery refers to a missing ticket '${ticketId}'`);
    if (ticket.status === "stopped") {
      await this.#deps.actionConfirmations.settlePendingForTicket(ticketId, "任务已停止", undefined, context);
      const priorWaitingCardId = typeof receipt.continuation.priorWaitingCardId === "string"
        ? receipt.continuation.priorWaitingCardId
        : undefined;
      if (priorWaitingCardId) {
        await this.#deps.uiCards.settle(priorWaitingCardId, { status: "cancelled", resultSummary: "任务已停止" });
      }
      await this.#deps.runtimeGates.broadcastTickets(context);
    }
    return toTicketCardView(ticket, this.#deps.liveSettings.get().roles);
  }

  async retryTicket(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
    commandId?: string,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "ticket.retry", ticketId, commandId });
    return this.#deps.delivery.withDelivery(
      intent, context,
      () => this.#deps.delivery.queueTicket(ticketId, () => this.#steerTicket({
        commandId: commandId?.trim() || `retry-${ticketId}-${Date.now()}`,
        ticketId,
        text: "The user requested a retry of this ticket. Diagnose the prior failure or blocker, continue execution within scope, and report verified results.",
        resetRecovery: true,
        internalResume: true,
      }, context, intent)),
      (receipt) => this.receiptTicket(receipt, context),
    );
  }

  async steerTicket(
    params: SteerTicketParams,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    assertValidReplyReference(params.replyTo);
    const intent = suppliedIntent ?? clientDeliveryIntent({
      type: "ticket.steer", ticketId: params.ticketId, commandId: params.commandId,
      text: params.text, attachments: params.attachments, replyTo: params.replyTo,
      ...(params.decisionOptionId ? { decisionOptionId: params.decisionOptionId } : {}),
      ...(params.resetRecovery ? { resetRecovery: true } : {}),
      ...(params.interrupt ? { interrupt: true } : {}),
    }, params.principalId);
    return this.#deps.delivery.withDelivery(
      intent, context,
      (receipt) => this.#deps.delivery.queueTicket(params.ticketId, () => this.#steerTicket(params, context, intent, receipt)),
      (receipt) => this.receiptTicket(receipt, context),
    );
  }

  async #steerTicket(
    params: SteerTicketParams,
    context: Context,
    intent?: DeliveryIntent,
    prior?: Readonly<DeliveryReceipt>,
  ): Promise<TicketCardView> {
    const { harness, envManager, projects, uploads, connectionManager, actionConfirmations, uiCards, liveSettings, runtimeGates, ports } = this.#deps;
    const recoveryGuard = await ports.turnContext.currentRecoveryGuard(params.originConversationId, context, params.originToolTaskId);
    if (params.attachments?.some((asset) => uploads.getUpload(asset.id)?.record.internalOnly)) {
      throw Object.assign(new Error("内部资源不可作为普通附件发送。"), { code: "attachment_forbidden", status: 403 });
    }
    if (params.principalId && params.attachments?.some((asset) => !uploads.canReadUpload(asset.id, params.principalId!))) {
      throw Object.assign(new Error("无权引用此附件。"), { code: "attachment_forbidden", status: 403 });
    }
    const cleanCmdId = params.commandId?.trim();
    const snapshot = await harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[params.ticketId];
    if (!ticket) throw new Error(`Ticket '${params.ticketId}' not found`);
    // P0-1: Resume an interrupted direct stop previously admitted through a decision-stop ticket.steer replay.
    if (prior?.phase === "admitted" && (prior.continuation.mode === "stop" || ticket.status === "stopped")) {
      const stopReason = typeof prior.continuation.reason === "string" && prior.continuation.reason.trim()
        ? prior.continuation.reason
        : params.text;
      return this.#stopTicket(params.ticketId, stopReason, context, cleanCmdId, undefined, intent, prior);
    }
    let effectiveText = params.text;
    const live = liveSettings.get();
    if (params.originConversationId === undefined && params.decisionOptionId) {
      const linkedPending = ticket.waiting?.requestId
        ? await actionConfirmations.getById(ticket.waiting.requestId, context)
        : undefined;
      const stopReason = resolveSteerDirectStopReason(ticket, linkedPending, params.decisionOptionId, params.text);
      if (stopReason) {
        if (canDirectStopTicket(ticket)) {
          return this.#stopTicket(params.ticketId, stopReason, context, cleanCmdId, undefined, intent, prior);
        }
        // P0-4: Never overwrite an already-settled (e.g. ready/closed) ticket to stopped.
        if (linkedPending && (linkedPending.status === "pending" || linkedPending.status === "pending_orchestrator")) {
          await actionConfirmations.resolveProgrammatically(linkedPending.id, {
            status: "denied", selectedChoiceId: params.decisionOptionId,
            resultSummary: ticket.status === "closed" ? "任务已关闭" : "任务已完成", markExecuted: true,
          }, context);
        }
        await harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId: params.ticketId }), context);
        return toTicketCardView(ticket, live.roles);
      }
    }
    if (params.originConversationId === undefined && ticket.waiting?.requestId) {
      const pending = await actionConfirmations.getById(ticket.waiting.requestId, context);
      if (pending && pending.payload.kind === "computer_handoff" && pending.status === "pending") {
        ports.computer.clearHandoff(params.ticketId);
        await actionConfirmations.resolveProgrammatically(pending.id, {
          status: "approved", selectedChoiceId: "confirm", resultSummary: "已在任务详情完成人工接管", markExecuted: true,
        }, context);
        effectiveText = formatComputerHandoffResumePrompt({
          action: "done", target: pending.payload.target, reason: pending.payload.reason,
          manualInstruction: params.decisionOptionId ? undefined : params.text,
        });
      }
      if (pending && pending.payload.kind === "host_action" && (pending.status === "pending" || pending.status === "pending_orchestrator")) {
        const payload = pending.payload;
        if (params.decisionOptionId === "confirm") {
          const resolved = await actionConfirmations.resolveProgrammatically(pending.id, {
            status: "approved", selectedChoiceId: "confirm", resultSummary: "已在任务详情允许", markExecuted: false,
          }, context);
          if (resolved) {
            const exec = await executeApprovedHostAction(ports.hostActions.execDeps(), resolved, { actorLabel: "用户", context });
            effectiveText = exec.status === "executed"
              ? `${exec.summaryText}\n请基于实际执行结果继续验证并完成当前任务。`
              : exec.status === "failed"
                ? `${exec.summaryText}\n请基于实际执行结果继续处理或向主智能体汇报。`
                : `本机操作「${payload.summary}」已发出或已处理完成（未重复执行）。请先通过只读方式核验当前状态再继续。`;
          }
        } else if (params.decisionOptionId === "cancel") {
          await actionConfirmations.resolveProgrammatically(pending.id, {
            status: "denied", selectedChoiceId: "cancel", resultSummary: "已在任务详情拒绝", markExecuted: true,
          }, context);
          effectiveText = `用户拒绝了在 ${payload.envName} (${payload.envId}) 上执行的本机操作「${payload.summary}」。请勿再次尝试同一操作，改用其他方案或直接向主智能体汇报。`;
        } else {
          // User typed custom manual text in Task Detail for a pending host_action -> hand off to Main Agent!
          const protectedManual = await connectionManager.processText(params.text.trim(), {
            requestId: cleanCmdId ? `task-manual:${pending.id}:${cleanCmdId}` : undefined,
          });
          const manualText = connectionManager.redact(protectedManual.text.trim());
          if (pending.cardId) {
            await uiCards.settle(pending.cardId, { status: "submitted", resultSummary: "已在任务详情补充说明" });
            await actionConfirmations.resolveFromUiSubmit(
              pending.cardId,
              Object.entries(pending.actionMap).find(([, logical]) => logical === "manual")?.[0] ?? "",
              { instruction: manualText },
              context,
            );
          }
          const originConvId = (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId;
          const originConv = await harness.conversation(originConvId, context);
          const updatedCard = await harness.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const liveTicket = state.tickets[params.ticketId];
            if (!liveTicket) throw new Error(`Ticket '${params.ticketId}' not found`);
            recordProcessedCommand(state, cleanCmdId, liveTicket.id, "steer");
            await writeDeliveryReceipt(tx, intent, { ticketId: liveTicket.id });
            const now = Date.now();
            liveTicket.waiting = {
              reason: "coordinator", since: now, detail: manualText || liveTicket.waiting?.detail,
              waitToken: `host-action-req:${pending.id}`, requestId: pending.id,
            };
            liveTicket.updatedAt = now;
            if (originConv) {
              await injectEventToolsInTx(tx, originConv.id, ["kulo_host_action_decide"]);
              await submitAutomaticChatInput(tx, originConv, {
                type: "input",
                content: connectionManager.redact(
                  formatUserTaskInstructionMessage({
                    title: liveTicket.title,
                    ticketId: liveTicket.id,
                    requestId: pending.id,
                    manualText,
                  }),
                ),
                whenBusy: "followUp",
                requestId: `kulo:task-manual:${pending.id}:${cleanCmdId ?? randomUUID()}`,
                entry: {
                  kind: CoordinatorEventEntry.kind,
                  data: {
                    eventKind: "user_task_instruction",
                    requestId: pending.id,
                    ticketId: liveTicket.id,
                    manualText,
                    createdAt: now,
                  },
                },
              });
            }
            return toTicketCardView(liveTicket, live.roles);
          }, context);
          runtimeGates.resumeIfNotRecovering();
          await runtimeGates.broadcastTickets(context);
          return updatedCard;
        }
      }
    }
    if (ticket.waiting?.requestId || ticket.waiting?.cardId) {
      const targetId = ticket.waiting.requestId ?? ticket.waiting.cardId!;
      const pending = await actionConfirmations.getById(targetId, context);
      if (pending && pending.payload.kind === "ticket_decision" && (pending.status === "pending" || pending.status === "pending_orchestrator")) {
        await actionConfirmations.resolveProgrammatically(pending.id, {
          status: "approved", selectedChoiceId: params.decisionOptionId ?? "chat",
          resultSummary: params.originConversationId !== undefined ? "已通过对话处理" : "已在任务详情确认", markExecuted: true,
        }, context);
      } else if (!pending && ticket.waiting.cardId) {
        await uiCards.settle(ticket.waiting.cardId, {
          status: "submitted", resultSummary: params.originConversationId !== undefined ? "已通过对话处理" : "已在任务详情确认",
        });
      }
    }

    const isUserFreeTextSteer =
      params.originConversationId === undefined &&
      !params.internalResume &&
      !params.decisionOptionId &&
      effectiveText === params.text;
    const assignmentSource = params.originConversationId !== undefined
      ? await ports.ticketDispatch.agentDispatchSource(params.originConversationId, params.originToolTaskId, context)
      : isUserFreeTextSteer
        ? { intent: extractAgentDispatchIntent(effectiveText, live.roles, envManager.listEnvs(), live.externalClients) }
        : {};
    if (assignmentSource.intent) {
      const choice = resolveAgentDispatch({
        roles: live.roles, externalClients: live.externalClients, language: live.presentation.language,
        intent: assignmentSource.intent, requestedRole: ticket.role,
        taskKind: ticket.agentAssignment?.taskKind, projectId: ticket.projectId, envId: ticket.envId, trustedManual: true,
      });
      const boundRole = resolveRoleOrDirectClient(ticket.role, live.roles, live.externalClients, live.presentation.language)
        ?? resolveRolePresetFromPool(live.roles, ticket.role).preset;
      const sameLegacyInternalRole = !ticket.externalExecution && !boundRole?.external && boundRole?.id === choice.role;
      if (choice.role !== ticket.role && !sameLegacyInternalRole) {
        throw new ProjectError(409, "agent_binding_conflict", `该任务固定由「${boundRole?.label ?? ticket.role}」执行。本次点名了其他 Agent，请创建对应的新任务，不能通过继续操作更换执行者。`);
      }
      assertAgentDispatchAvailable(boundRole, { envs: envManager.listEnvs(), envId: ticket.envId });
    }
    if (ticket.externalExecution && params.attachments?.length && (!ticket.scratchDir || params.attachments.some((att) => typeof att?.id !== "string" || !uploads.getUpload(att.id)))) {
      throw new ProjectError(400, "external_agent_attachments_unsupported", "外部智能体附件需要有效受管上传及任务草稿箱支持。");
    }
    if (cleanCmdId && snapshot?.processedCommands?.[cleanCmdId]) legacyDeliveryConflict();
    if (snapshot) assertRecoveryGuard(snapshot, recoveryGuard);
    if (recoveryGuard && recoveryGuard.ticketId !== params.ticketId) throw new Error("自动恢复只能推进当前失败任务。");
    if (ticket.status === "stopped" || ticket.status === "closed") {
      throw new ProjectError(409, "ticket_stopped", `Ticket '${params.ticketId}' was explicitly stopped or closed and cannot auto-resume.`);
    }
    if (ticket.projectId) {
      const project = await projects.get(ticket.projectId, context);
      if (project.grantRevision !== ticket.grantRevision || project.workspaceDir !== ticket.workspaceDir || project.deviceId !== ticket.envId || project.directoryId !== ticket.directoryId) {
        throw new ProjectError(409, "project_binding_changed", "项目位置已改变，请创建新任务。");
      }
      if (envManager.getEnvDescriptor(ticket.envId)?.online) await projects.ensureAuthorized(project.id, context);
    }
    const workerConv = await harness.conversation(ticket.workerConversationId as ConversationId, context);
    if (!workerConv) throw new Error(`Worker conversation for '${params.ticketId}' not found`);
    if (cleanCmdId && await harness.commit((tx) => tx.submissionByRequest(workerConv.id, `kulo:steer:${cleanCmdId}`), context)) legacyDeliveryConflict();

    const attachmentIds = uploads.resolveAttachments(params.attachments).map((item) => item.record.id);
    const protectedMessage = await connectionManager.processText(effectiveText, {
      requestId: cleanCmdId ? `steer:${ticket.id}:${cleanCmdId}` : undefined, replyText: params.replyTo?.text,
    });
    const prompt = protectedMessage.text.trim() || "请查看补充附件并继续原任务。";
    const replyTo = params.replyTo
      ? { messageId: params.replyTo.messageId, role: params.replyTo.role, text: connectionManager.redact(params.replyTo.text), ...(params.replyTo.excerpt ? { excerpt: true } : {}) }
      : undefined;
    const modelPrompt = replyContext(prompt, replyTo);
    for (const { record } of uploads.resolveAttachments(params.attachments)) {
      if (record.kind === "audio") {
        await ports.transcribeVoiceAsset(record.id, { topicId: ticket.originTopicId ?? "root", principalId: params.principalId || envManager.localEnvId }, context);
      }
    }
    const prepared = uploads.buildMultimodalContent(`【主控补充引导】\n${modelPrompt}`, params.attachments);
    const { card, created, injected, interruptTarget } = await harness.commit(
      (tx) =>
        admitTicketSteerInTx(tx, {
          params, cleanCmdId, intent, recoveryGuard, workerConv, prompt, modelPrompt, replyTo,
          preparedContent: prepared.content, preparedAttachments: prepared.attachments, attachmentIds,
          activeRoles: liveSettings.get().roles,
          isParking: (id) => ports.reconciler.isParking(id),
          isTicketDevicesOnline: (t) => this.#ticketDevicesOnline(t),
          workerTicketTask: ports.workerTicketTask,
        }),
      context,
    );
    uploads.bindAttachments(params.attachments, `conversation:${Number(workerConv.id)}`, params.principalId);
    if (interruptTarget && envManager.getEnvDescriptor(interruptTarget.envId)?.online) {
      await envManager.requestExternalAgent(interruptTarget.envId, { operation: "cancel", runId: interruptTarget.runId }).catch(() => {});
    }
    if (created || injected) runtimeGates.resumeIfNotRecovering();
    if (!created && !injected && card.status === "waiting" && envManager.getEnvDescriptor(card.envId)?.online) {
      void ports.reconciler.queueEnvReconcile();
    }
    await runtimeGates.broadcastTickets(context);
    return card;
  }

  async stopTicket(
    ticketId: string,
    reason: string | undefined,
    context: Context = BACKGROUND_CONTEXT,
    commandIdOrOrigin?: string | { conversationId: number; toolTaskId: number },
    originArgument?: { conversationId: number; toolTaskId: number },
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    const commandId = typeof commandIdOrOrigin === "string" ? commandIdOrOrigin : undefined;
    const origin = typeof commandIdOrOrigin === "object" ? commandIdOrOrigin : originArgument;
    const intent = suppliedIntent ?? clientDeliveryIntent({ type: "ticket.stop", ticketId, commandId, reason });
    return this.#deps.delivery.withDelivery(
      intent, context,
      (receipt) => this.#deps.delivery.queueTicket(ticketId, () => this.#stopTicket(ticketId, reason, context, commandId, origin, intent, receipt)),
      (receipt) => this.#replayStopReceipt(receipt, context),
    );
  }

  async stopTicketDirect(ticketId: string, reason: string | undefined, context: Context): Promise<TicketCardView> {
    return this.#stopTicket(ticketId, reason, context, undefined, undefined);
  }

  async settleStaleTicketConfirmations(ticketId: string): Promise<void> {
    if (this.#deps.runtimeGates.isClosed()) return;
    const ticket = (await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[ticketId];
    if (!ticket || isTicketUnfinished(ticket)) return;
    const summary = ticket.status === "stopped" ? "任务已停止" : ticket.status === "closed" ? "任务已关闭" : "任务已结束";
    await this.#deps.actionConfirmations.settlePendingForTicket(
      ticketId, summary, ticket.status === "ready" ? { excludeKinds: ["staged_apply"] } : undefined, BACKGROUND_CONTEXT,
    );
  }

  finalizeTicketStopDeps(): FinalizeTicketStopDeps {
    const { harness, actionConfirmations, uiCards, liveSettings, connectionManager, delivery, runtimeGates, ports } = this.#deps;
    return {
      harness,
      actionConfirmations,
      uiCards,
      getRoles: () => liveSettings.get().roles,
      clearComputerHandoff: (id: string) => { ports.computer.clearHandoff(id); },
      cancelConnectionRequests: (id: string) => { connectionManager.cancelRequests(id); },
      stopChildTicket: (childId: string, childReason: string, ctx: Context) =>
        delivery.queueTicket(childId, () => this.#stopTicket(childId, childReason, ctx, undefined, undefined)),
      stopMediaJobs: async (id: string) => {
        const mediaJobs = ports.mediaJobs();
        for (const job of await mediaJobs.list({ ticketId: id })) {
          if (!["completed", "failed", "stopped"].includes(job.status)) await mediaJobs.stop(job.id);
        }
      },
      releaseTicketExecution: (t: Readonly<TicketRecord>) => ports.reconciler.releaseTicketExecution(t),
      untrackWorker: (id: string, prevEpoch: number) => { ports.watchdog.untrack(id, prevEpoch); },
      resumeIfReady: (cleanupPending: boolean) => { if (!cleanupPending) runtimeGates.resumeIfNotRecovering(); },
      broadcastTickets: (ctx: Context) => runtimeGates.broadcastTickets(ctx),
    };
  }

  async #stopTicket(
    ticketId: string,
    reason: string | undefined,
    context: Context,
    commandId: string | undefined,
    origin: { conversationId: number; toolTaskId: number } | undefined,
    intent?: DeliveryIntent,
    prior?: Readonly<DeliveryReceipt>,
    deleteSchedule = false,
  ): Promise<TicketCardView> {
    const { harness, actionConfirmations, liveSettings, ports } = this.#deps;
    const controlInput = await ports.turnContext.currentControlInput(origin?.conversationId, context, origin?.toolTaskId);
    if (controlInput && WorkerRecoveryEntry.is(controlInput)) {
      throw new ProjectError(409, "recovery_stop_denied", "自动恢复回合不能自行停止任务，请保留现有执行或请求用户决定。");
    }
    if (controlInput && (isAutomaticSystemInputEntry(controlInput) || isLegacyAutonomousUserEntry(controlInput))) {
      throw new ProjectError(409, "automatic_stop_denied", "后台巡检和回报不能代替用户停止任务。请纠偏，或让 Worker 汇报实际阻塞与所需权限。");
    }
    const snapshot = await harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new Error(`Ticket '${ticketId}' not found`);
    const removeSchedule = (current: TicketRecord) => {
      if (!deleteSchedule) return;
      if (!current.schedule) throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
      current.schedule.deletedAt ??= Date.now();
      current.schedule.nextRunAt = null;
      current.updatedAt = Date.now();
    };
    if (deleteSchedule && (ticket.status === "closed" || (ticket.status === "ready" && ticket.schedule?.repeatEverySeconds === undefined))) {
      return harness.commit(async (tx) => {
        const current = (await tx.doc(KuloStateDoc)).tickets[ticketId]!;
        removeSchedule(current);
        await writeDeliveryReceipt(tx, intent, { ticketId });
        return toTicketCardView(current, liveSettings.get().roles);
      }, context);
    }
    if (prior?.phase === "admitted" && ticket.runEpoch !== Number(prior.continuation.epoch)) {
      await harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
      return toTicketCardView(ticket, liveSettings.get().roles);
    }
    if (prior?.phase !== "admitted" && commandId && snapshot?.processedCommands?.[commandId]) legacyDeliveryConflict();
    if (ticket.status === "stopped" && !ticket.cleanupPending) {
      await harness.commit(async (tx) => {
        if (deleteSchedule) removeSchedule((await tx.doc(KuloStateDoc)).tickets[ticketId]!);
        await writeDeliveryReceipt(tx, intent, { ticketId });
      }, context);
      await actionConfirmations.settlePendingForTicket(ticketId, "任务已停止", undefined, context);
      return toTicketCardView(ticket, liveSettings.get().roles);
    }
    let epoch: number;
    let previousEpoch: number;
    let activeTaskId: number | undefined;
    let priorWaitingCardId = ticket.waiting?.cardId;
    if (prior?.phase === "admitted") {
      epoch = Number(prior.continuation.epoch);
      previousEpoch = Number(prior.continuation.previousEpoch ?? ticket.runEpoch);
      activeTaskId = typeof prior.continuation.taskId === "number" ? prior.continuation.taskId : undefined;
    } else if (ticket.status === "stopped") {
      previousEpoch = ticket.runEpoch - 1;
      activeTaskId = ticket.activeTaskId;
      epoch = await harness.commit(async (tx) => {
        if (deleteSchedule) removeSchedule((await tx.doc(KuloStateDoc)).tickets[ticketId]!);
        await writeDeliveryReceipt(tx, intent, { ticketId }, "admitted", {
          mode: "stop", reason: ticket.stoppedReason ?? (reason?.trim() || "Stopped by user"),
          epoch: ticket.runEpoch, previousEpoch: ticket.runEpoch - 1,
        });
        return ticket.runEpoch;
      }, context);
    } else {
      const admitted = await harness.commit(
        (tx) => admitTicketStopInTx(tx, { ticketId, reason, commandId, intent, deleteSchedule }),
        context,
      );
      epoch = admitted.epoch;
      previousEpoch = admitted.previousEpoch;
      activeTaskId = admitted.activeTaskId;
      priorWaitingCardId = admitted.priorWaitingCardId ?? priorWaitingCardId;
    }
    const stoppedCard = await finalizeTicketStop(this.finalizeTicketStopDeps(), {
      ticketId, reason, epoch, previousEpoch,
      ...(activeTaskId === undefined ? {} : { activeTaskId }),
      ...(priorWaitingCardId ? { priorWaitingCardId } : {}),
      snapshot, ticket, intent,
    }, context);
    const postState = await harness.snapshot(KuloStateDoc, context);
    const stoppedTicket = postState?.tickets[ticketId];
    if (stoppedTicket) {
      void recordTicketOutcomeToWorkingMemory(
        harness,
        (text) => this.#deps.connectionManager.redact(text),
        stoppedTicket,
        "ticket_stopped",
        { detail: reason?.trim() || stoppedTicket.stoppedReason },
        context,
      ).catch(() => {});
    }
    return stoppedCard;
  }

  async closeTicket(
    params: CloseTicketParams,
    context: Context = BACKGROUND_CONTEXT,
    suppliedIntent?: DeliveryIntent,
  ): Promise<TicketCardView> {
    const intent = suppliedIntent ?? clientDeliveryIntent({
      type: "ticket.close", ticketId: params.ticketId, commandId: params.commandId,
      kind: params.kind, reason: params.reason, replacementTicketId: params.replacementTicketId,
    });
    return this.#deps.delivery.withDelivery(
      intent, context,
      () => this.#deps.delivery.queueTicket(params.ticketId, () => this.#closeTicket(params, context, intent)),
      (receipt) => this.receiptTicket(receipt, context),
    );
  }

  async #closeTicket(params: CloseTicketParams, context: Context, intent?: DeliveryIntent): Promise<TicketCardView> {
    const { harness, actionConfirmations, liveSettings, runtimeGates, ports } = this.#deps;
    const recoveryGuard = await ports.turnContext.currentRecoveryGuard(params.originConversationId, context, params.originToolTaskId);
    const activeRoles = liveSettings.get().roles;
    const cleanCmdId = params.commandId?.trim();
    const { card, changed, stagedToDiscard } = await harness.commit(
      (tx) => admitTicketCloseInTx(tx, { params, cleanCmdId, intent, recoveryGuard, activeRoles }),
      context,
    );
    if (stagedToDiscard) {
      await ports.stagedApply.discardTicketStagedWorkspace(stagedToDiscard);
      runtimeGates.resumeIfNotRecovering();
    }
    if (changed) {
      await actionConfirmations.settlePendingForTicket(params.ticketId, "任务已关闭", undefined, context);
      await runtimeGates.broadcastTickets(context);
      const postState = await harness.snapshot(KuloStateDoc, context);
      const closedTicket = postState?.tickets[params.ticketId];
      if (closedTicket) {
        const outcome = classifyTicketOutcome(closedTicket, { closureKind: params.kind });
        if (outcome) {
          void recordTicketOutcomeToWorkingMemory(
            harness,
            (text) => this.#deps.connectionManager.redact(text),
            closedTicket,
            outcome,
            { detail: params.reason },
            context,
          ).catch(() => {});
        }
      }
    }
    return card;
  }

  async stopScheduledTask(ticketId: string, context: Context = BACKGROUND_CONTEXT, intent?: DeliveryIntent): Promise<TicketCardView> {
    return this.#deps.delivery.withDelivery(
      intent, context,
      (receipt) => this.#deps.delivery.queueTicket(ticketId, async () => {
        const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
        const ticket = state?.tickets[ticketId];
        if (!ticket?.schedule || (ticket.schedule.deletedAt !== undefined && receipt?.phase !== "admitted")) {
          throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
        }
        if (ticket.status === "closed" || (ticket.status === "stopped" && !ticket.cleanupPending)) {
          await this.#deps.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
          return toTicketCardView(ticket, this.#deps.liveSettings.get().roles);
        }
        return this.#stopTicket(ticketId, "用户停止定时任务", context, undefined, undefined, intent, receipt);
      }),
      (receipt) => this.#replayStopReceipt(receipt, context),
    );
  }

  async deleteScheduledTask(ticketId: string, context: Context = BACKGROUND_CONTEXT, intent?: DeliveryIntent): Promise<void> {
    return this.#deps.delivery.withDelivery(
      intent, context,
      (receipt) => this.#deps.delivery.queueTicket(ticketId, async () => {
        const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
        const ticket = state?.tickets[ticketId];
        if (!ticket?.schedule) throw new ProjectError(404, "schedule_not_found", "定时任务不存在。");
        if (ticket.schedule.deletedAt !== undefined && receipt?.phase !== "admitted") {
          await this.#deps.harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
          return;
        }
        await this.#stopTicket(ticketId, "用户停止定时任务", context, undefined, undefined, intent, receipt, true);
        await this.#deps.runtimeGates.broadcastTickets(context);
      }),
      async (receipt) => {
        await this.#replayStopReceipt(receipt, context);
      },
    );
  }
}
