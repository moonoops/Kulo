import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import { escapeUntrustedText, type TicketCardView, type TicketRecord } from "@kulo/protocol";
import { submitAutomaticChatInput } from "./chat-control.js";
import type { KuloConnections } from "./connections.js";
import type { HubComputerController } from "./hub-computer-controller.js";
import type { HubConnectionsBridge } from "./hub-connections-bridge.js";
import type { HubHostActions } from "./hub-host-actions.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import type { HubWatchdog } from "./hub-watchdog.js";
import type { KuloMediaJobs } from "./media-jobs.js";
import { KuloProjects, ProjectError } from "./projects.js";
import {
  formatConnectionRequestMessage,
  formatWorkerInitialPrompt,
  formatWorkerRelayMessage,
} from "./prompts.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import { isSettingsTopicDeleted, SettingsAssistantDoc } from "./settings-assistant.js";
import {
  CoordinatorEventEntry,
  getEffectiveWorkspaceDir,
  hasPendingWorkspaceApply,
  isTicketUnfinished,
  KuloStateDoc,
  releaseSlot,
  WorkerRelayEntry,
} from "./state.js";
import { admitParkTicketFinishInTx, admitParkTicketStartInTx } from "./ticket-control-tx.js";
import { androidTargetsOf, areTicketDevicesOnline } from "./ticket-dispatch.js";
import type { TicketStagedApplyService } from "./ticket-staged-apply.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import type { SteerTicketParams } from "./tools-router.js";
import { computeCapDeferredDueAt, type KuloUsageCaps } from "./usage-caps.js";

export interface TicketReconcilerPorts {
  watchdog: Pick<HubWatchdog, "untrack">;
  computer: Pick<HubComputerController, "buildTicketSessionCleanupTasks">;
  hostActions: Pick<HubHostActions, "relayRequest">;
  connectionsBridge: Pick<HubConnectionsBridge, "resumeConnectionDecision">;
  stagedApply: Pick<TicketStagedApplyService, "discardTicketStagedWorkspace">;
  mediaJobs: () => KuloMediaJobs;
  workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  notifyInlineWaiters: (ticketId: string) => void;
  ensureTopicWatchedByConversation: (conversationId: number, context: Context) => Promise<void>;
  broadcastProjects: () => Promise<void>;
  steerTicket: (params: SteerTicketParams, context: Context) => Promise<TicketCardView>;
}

export interface TicketReconcilerDeps {
  harness: Harness;
  envManager: EnvManager;
  projects: KuloProjects;
  connectionManager: KuloConnections;
  usageCaps: KuloUsageCaps;
  runtimeGates: HubRuntimeGates;
  ports: TicketReconcilerPorts;
}

export class TicketReconciler {
  readonly #deps: TicketReconcilerDeps;
  #envTransition: Promise<void> = Promise.resolve();
  #waitTransition: Promise<void> = Promise.resolve();
  readonly #parkingTickets = new Map<string, Promise<void>>();

  constructor(deps: TicketReconcilerDeps) {
    this.#deps = deps;
  }

  isParking(ticketId: string): boolean {
    return this.#parkingTickets.has(ticketId);
  }

  #ticketDevicesOnline(ticket: Readonly<TicketRecord>): boolean {
    return areTicketDevicesOnline(ticket, (id) => this.#deps.envManager.getEnvDescriptor(id));
  }

  scheduledWakeDeferUntil(ticket: Readonly<TicketRecord>, now: number): number | null {
    if (!ticket.schedule) return null;
    const status = this.#deps.usageCaps.isCappedFor("schedule");
    if (!status.capped || status.resetAt == null) return null;
    return computeCapDeferredDueAt(ticket, status.resetAt, now);
  }

  queueWaitReconcile(): Promise<void> {
    this.#waitTransition = this.#waitTransition.then(async () => {
      const { harness, runtimeGates, ports } = this.#deps;
      if (runtimeGates.isClosed()) return;
      let state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      // A result can arrive before the Worker commits its wait; recover that edge from durable job state.
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if (!(ticket.waiting?.reason === "external" || ticket.waiting?.reason === "user") || !isTicketUnfinished(ticket)) continue;
        for (const id of ticket.waiting.externalJobIds ?? []) {
          const job = await ports.mediaJobs().get(id);
          if (!["completed", "failed", "stopped", "needs_user", "needs_reconciliation"].includes(job.status)) continue;
          await harness.commit(async (tx) => {
            const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
            if (!current || !isTicketUnfinished(current) ||
              !(current.waiting?.reason === "external" || current.waiting?.reason === "user") || !current.waiting.externalJobIds?.includes(id)) return;
            if (["needs_user", "needs_reconciliation"].includes(job.status)) {
              current.waiting.reason = "user";
              current.waiting.detail = job.error ?? "媒体作业需要处理。";
              current.latestReport = { state: "blocked", summary: current.waiting.detail, question: current.waiting.detail, at: Date.now() };
            } else {
              current.waiting.externalJobIds = current.waiting.externalJobIds.filter((item) => item !== id);
              current.wakePending = true;
              current.resumePrompt = [current.resumePrompt, `媒体作业 ${id} 的状态为 ${job.status}，使用原作业结果，不要重新提交。`].filter(Boolean).join("\n");
              current.resumeAttachmentIds = [...new Set([...(current.resumeAttachmentIds ?? []), ...job.assets.map((asset) => asset.id)])];
            }
          }, BACKGROUND_CONTEXT);
        }
      }
      state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if (ticket.status !== "running" && ticket.status !== "pausing") continue;
        const waiting = ticket.waiting ?? (ticket.latestReport?.state === "blocked"
          ? { reason: "coordinator" as const, since: Date.now(), detail: ticket.latestReport.question ?? ticket.latestReport.summary } : undefined);
        if (waiting) await this.parkTicket(ticket.id, waiting);
      }
      if (!runtimeGates.isRecovering()) {
        const after = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(after?.tickets ?? {})) {
          if (ticket.status === "waiting" && ticket.wakePending) await this.resumeWaitingTicket(ticket.id, BACKGROUND_CONTEXT);
        }
      }
      const connections = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      for (const ticket of Object.values(connections?.tickets ?? {})) {
        if (ticket.status === "waiting" && ticket.waiting?.reason === "connection") await this.relayConnectionRequest(ticket.id);
        if (ticket.status === "waiting" && ticket.waiting?.reason === "coordinator" && ticket.waiting.waitToken?.startsWith("host-action-req:")) {
          await ports.hostActions.relayRequest(ticket.id);
        }
      }
    }).catch((error) => { console.error("[KuloWaitReconcile]", error); });
    return this.#waitTransition;
  }

  queueEnvReconcile(): Promise<void> {
    this.#envTransition = this.#envTransition.then(async () => {
      const { harness, envManager, projects, runtimeGates, ports } = this.#deps;
      if (runtimeGates.isClosed()) return;
      const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      for (const ticket of Object.values(state?.tickets ?? {})) {
        if (!isTicketUnfinished(ticket)) continue;
        const online = this.#ticketDevicesOnline(ticket);
        if (ticket.externalExecution && ticket.status === "running") continue;
        if (!online && ["running", "queued", "pausing"].includes(ticket.status)) {
          await this.parkTicket(ticket.id, { reason: "env", since: Date.now(), detail: "等待执行设备上线" });
        }
      }
      for (const env of envManager.listEnvs()) {
        if (!env.online) continue;
        try { if (env.executionKind !== "native-device") await projects.reconcileDevice(env.id); }
        catch (error) { console.error(`[KuloProjects:reconcile:${env.id}]`, error); }
        const current = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(current?.tickets ?? {})) {
          if ((ticket.envId !== env.id && !androidTargetsOf(ticket).includes(env.id)) || !ticket.cleanupPending || current?.slots.holders.includes(ticket.id)) continue;
          const cleanup = await this.releaseTicketExecution(ticket, { park: Boolean(ticket.waiting) && isTicketUnfinished(ticket) });
          await harness.commit(async (tx) => {
            const next = await tx.doc(KuloStateDoc);
            const t = next.tickets[ticket.id];
            if (!t || t.runEpoch !== ticket.runEpoch) return;
            t.cleanupPending = cleanup.cleanupPending;
            if (
              !cleanup.cleanupPending &&
              (t.status === "stopped" || t.status === "closed" || (t.status === "ready" && !hasPendingWorkspaceApply(t)))
            ) {
              if (t.workspaceStaging && !t.workspaceStaging.appliedAt && !t.workspaceStaging.discardedAt) {
                t.workspaceStaging.discardedAt = Date.now();
                delete t.workspaceStaging.stagedCwd;
                delete t.workspaceStaging.stagedDiff;
              }
              if ((t.status === "stopped" || t.status === "closed") && t.externalExecution && !t.externalExecution.stagedAppliedAt) {
                delete t.externalExecution.stagedCwd;
                delete t.externalExecution.stagedDiff;
              }
            }
            if (!cleanup.cleanupPending && !["running", "pausing"].includes(t.status)) releaseSlot(next, t.id);
          }, BACKGROUND_CONTEXT);
        }
        const waiting = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        for (const ticket of Object.values(waiting?.tickets ?? {})) {
          if ((ticket.envId === env.id || androidTargetsOf(ticket).includes(env.id)) && this.#ticketDevicesOnline(ticket) && ticket.status === "waiting" && !ticket.cleanupPending &&
            (ticket.wakePending || ticket.waiting?.reason === "env" || (ticket.waiting?.reason === "time" && (ticket.waiting.until ?? 0) <= Date.now()))) {
            await this.resumeWaitingTicket(ticket.id, BACKGROUND_CONTEXT);
          }
        }
      }
      await ports.broadcastProjects();
      await runtimeGates.broadcastTickets(BACKGROUND_CONTEXT);
    }).catch((error) => { console.error("[KuloEnvReconcile]", error); });
    return this.#envTransition;
  }

  async relayConnectionRequest(ticketId: string): Promise<void> {
    const { harness, connectionManager, runtimeGates, ports } = this.#deps;
    const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = state?.tickets[ticketId];
    if (!ticket || ticket.status !== "waiting" || ticket.waiting?.reason !== "connection" || !ticket.waiting.waitToken) return;
    const request = await connectionManager.getRequest(ticket.waiting.waitToken);
    if (!request) return;
    if (request.status !== "pending") {
      await ports.connectionsBridge.resumeConnectionDecision(request.id, request.status === "approved", BACKGROUND_CONTEXT);
      return;
    }
    const origin = await harness.conversation((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, BACKGROUND_CONTEXT);
    if (!origin) return;
    await harness.commit(async (tx) => {
      await injectEventToolsInTx(tx, origin.id, ["kulo_connections", "kulo_connection_decide", "kulo_connection_grant"]);
      return submitAutomaticChatInput(tx, origin, {
        type: "input",
        content: connectionManager.redact(formatConnectionRequestMessage(JSON.stringify({ requestId: request.id, ticketId, connectionId: request.connectionId, reason: request.reason }))),
        whenBusy: "followUp",
        requestId: `kulo:connection-request:${request.id}`,
        entry: {
          kind: CoordinatorEventEntry.kind,
          data: {
            eventKind: "connection_request",
            requestId: request.id,
            ticketId,
            connectionId: request.connectionId,
            createdAt: Date.now(),
          },
        },
      });
    }, BACKGROUND_CONTEXT);
    await runtimeGates.broadcastTickets(BACKGROUND_CONTEXT);
  }

  async releaseTicketExecution(ticket: Readonly<TicketRecord>, options: { park?: boolean } = {}): Promise<{ cleanupPending: boolean }> {
    const { harness, envManager, connectionManager, ports } = this.#deps;
    try {
      let externalCleanupPending = false;
      const runId = ticket.externalExecution?.runId;
      if (runId) {
        // Close must still be attempted if startup has not reached a cancellable native session.
        await Promise.allSettled([envManager.requestExternalAgent(ticket.envId, { operation: "cancel", runId })]);
        const discardStaged = Boolean(["stopped", "closed"].includes(ticket.status) && ticket.externalExecution?.stagedCwd && !ticket.externalExecution.stagedAppliedAt);
        const [closed] = await Promise.allSettled([envManager.requestExternalAgent(ticket.envId, { operation: "close", runId, ...(discardStaged ? { discardStaged: true } : {}) })]);
        externalCleanupPending = closed!.status !== "fulfilled" || closed.value.type !== "run" ||
          closed.value.run.id !== runId || closed.value.run.taskId !== ticket.id || closed.value.run.quiescent !== true;
      }
      if (ticket.externalExecution) {
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        externalCleanupPending ||= Object.values(state?.tickets ?? {}).some((child) => child.parentTicketId === ticket.id &&
          (child.cleanupPending || (["stopped", "closed", "pausing"].includes(ticket.status) && isTicketUnfinished(child))));
      }
      const effectiveWorkspaceDir = getEffectiveWorkspaceDir(ticket);
      const shouldDiscardBuiltInStaged = Boolean(
        !ticket.externalExecution &&
          (["stopped", "closed"].includes(ticket.status) || (ticket.status === "ready" && !hasPendingWorkspaceApply(ticket))) &&
          ticket.workspaceStaging?.mode === "staged" && !ticket.workspaceStaging.appliedAt &&
          !ticket.workspaceStaging.discardedAt && ticket.workspaceStaging.stagedCwd,
      );
      const computerCloseTasks = ports.computer.buildTicketSessionCleanupTasks(ticket.id, options);
      const [connection, worker, ...computer] = await Promise.allSettled([
        connectionManager.revoke(ticket.id),
        ticket.externalExecution || ticket.executionDomain === "android"
          ? Promise.resolve({ cleanupPending: externalCleanupPending })
          : (async () => {
              const envRelease = await envManager.releaseWorkerExecutionEnv(ticket.envId, effectiveWorkspaceDir, { scratchDir: ticket.scratchDir });
              const stagedPending = !envRelease.cleanupPending && shouldDiscardBuiltInStaged
                ? await ports.stagedApply.discardTicketStagedWorkspace(ticket)
                : false;
              return { cleanupPending: envRelease.cleanupPending || stagedPending };
            })(),
        ...androidTargetsOf(ticket).map(async (deviceId) => {
          const result = await envManager.cancelAndroid(deviceId, {
            version: 1,
            controlId: `retire-${createHash("sha256").update(`${ticket.id}:${ticket.runEpoch}:${deviceId}:${options.park ? "park" : "stop"}`).digest("hex")}`,
            ticketId: ticket.id, runEpoch: ticket.runEpoch,
            reason: options.park ? "task_epoch_parked" : "task_epoch_retired",
          });
          if (!result.quiescent && !(options.park && result.epochQuiescent === true && result.resourcesRetained === true)) {
            throw new Error("手机任务尚未确认静止。");
          }
        }),
        ...computerCloseTasks,
      ]);
      if (worker!.status === "rejected") throw worker!.reason;
      return { cleanupPending: connection!.status === "rejected" || worker!.value.cleanupPending || computer.some((result) => result.status === "rejected") };
    } catch (error) {
      console.error(`[KuloCleanup:${ticket.id}]`, error);
      return { cleanupPending: true };
    }
  }

  parkTicket(ticketId: string, waiting: NonNullable<TicketRecord["waiting"]>): Promise<void> {
    const existing = this.#parkingTickets.get(ticketId);
    if (existing) return existing;
    const transition = this.#parkTicketNow(ticketId, waiting);
    this.#parkingTickets.set(ticketId, transition);
    void transition.finally(() => {
      if (this.#parkingTickets.get(ticketId) === transition) this.#parkingTickets.delete(ticketId);
    }).catch((error) => console.error(`[KuloPause:${ticketId}]`, error));
    return transition;
  }

  async #parkTicketNow(ticketId: string, waiting: NonNullable<TicketRecord["waiting"]>): Promise<void> {
    const { harness, runtimeGates, ports } = this.#deps;
    const context = BACKGROUND_CONTEXT;
    const snapshot = await harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || ["waiting", "blocked"].includes(ticket.status)) return;
    const epoch = ticket.runEpoch + 1;
    const preservedWait = ticket.waiting && ticket.waiting.reason !== "project" ? ticket.waiting : waiting;
    const admitted = await harness.commit(
      (tx) => admitParkTicketStartInTx(tx, ticketId, ticket.runEpoch, epoch, preservedWait),
      context,
    );
    if (!admitted) return;
    const conversations = [
      ticket.workerConversationId,
      ...Object.values(snapshot?.subagents ?? {}).filter((s) => s.ticketId === ticketId).map((s) => s.conversationId),
    ];
    await Promise.all(conversations.map(async (id) => {
      const conversation = await harness.conversation(id as ConversationId, context);
      if (conversation) await conversation.abort(context, { background: true });
    }));
    if (ticket.activeTaskId !== undefined) await harness.abortTask(ticket.activeTaskId as never, context);
    const cleanup = await this.releaseTicketExecution(ticket, { park: true });
    await harness.commit(
      (tx) => admitParkTicketFinishInTx(tx, { ticketId, epoch, cleanupPending: cleanup.cleanupPending, workerTicketTask: ports.workerTicketTask }),
      context,
    );
    this.#parkingTickets.delete(ticketId);
    ports.watchdog.untrack(ticketId, ticket.runEpoch);
    const parked = await harness.snapshot(KuloStateDoc, context);
    if (parked?.tickets[ticketId]?.wakePending) await this.resumeWaitingTicket(ticketId, context);
    const isBlockedCoordinatorWait = preservedWait.reason === "coordinator" && !preservedWait.waitToken?.startsWith("host-action-req:");
    if ((preservedWait.reason === "user" && !preservedWait.waitToken?.startsWith("host-action:")) || isBlockedCoordinatorWait) {
      const latest = await harness.snapshot(KuloStateDoc, context);
      const settingsLatest = await harness.snapshot(SettingsAssistantDoc, context);
      const originTopic = latest?.topics?.[ticket.originTopicId ?? "root"];
      const originDeleted = isSettingsTopicDeleted(ticket.originTopicId, settingsLatest) || Boolean(originTopic?.deletedAt);
      if (latest?.tickets[ticketId]?.runEpoch === epoch && !latest.tickets[ticketId]?.wakePending && !originDeleted) {
        const current = latest.tickets[ticketId]!;
        const report = current.latestReport?.state === "blocked" ? current.latestReport : undefined;
        const question = report?.question ?? preservedWait.detail ?? "请确认下一步";
        const origin = await harness.conversation((ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId, context);
        if (origin) {
          await ports.ensureTopicWatchedByConversation(Number(origin.id), context);
          await harness.commit(async (tx) => {
            if (isBlockedCoordinatorWait) await injectEventToolsInTx(tx, origin.id, ["kulo_inspect", "kulo_ticket_ask_user"]);
            return submitAutomaticChatInput(tx, origin, {
              type: "input",
              content: isBlockedCoordinatorWait
                ? formatWorkerRelayMessage({
                    ticketId, title: current.title, role: current.role,
                    report: report ?? { state: "blocked", summary: question, question, at: Date.now() },
                  })
                : `[KULO_WORKER_RELAY]\nTicket ${escapeUntrustedText(ticket.title)} is waiting on user confirmation: ${escapeUntrustedText(question)}\nRelay this single question concisely in the active conversation language without exposing internal IDs.`,
              whenBusy: "followUp",
              requestId: isBlockedCoordinatorWait ? `kulo:relay:${ticketId}:${epoch}` : `kulo:wait-user:${ticketId}:${epoch}`,
              entry: {
                kind: WorkerRelayEntry.kind,
                data: {
                  ticketId, title: current.title, role: current.role, state: "blocked",
                  summary: report?.summary ?? question, question, deliverable: report?.deliverable ?? null,
                },
              },
            });
          }, context);
        }
        runtimeGates.resumeIfNotRecovering();
      }
    }
    if (preservedWait.reason === "connection") await this.relayConnectionRequest(ticketId);
    if (preservedWait.reason === "coordinator" && preservedWait.waitToken?.startsWith("host-action-req:")) {
      await ports.hostActions.relayRequest(ticketId);
    }
    ports.notifyInlineWaiters(ticketId);
    await runtimeGates.broadcastTickets(context);
  }

  async resumeWaitingTicket(ticketId: string, context: Context): Promise<void> {
    const { harness, runtimeGates, ports } = this.#deps;
    const state = await harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket || ticket.status !== "waiting" || ((ticket.waiting?.reason === "user" || ticket.waiting?.reason === "connection" || ticket.waiting?.reason === "coordinator") && !ticket.wakePending) || ticket.cleanupPending) return;
    if (!ticket.wakePending && ticket.schedule?.nextRunAt != null && hasPendingWorkspaceApply(ticket)) return;
    if (ticket.schedule?.nextRunAt != null && ticket.schedule.nextRunAt > Date.now()) return;
    if (!ticket.wakePending && ticket.waiting?.until !== undefined && ticket.waiting.until > Date.now()) return;
    if (!ticket.wakePending && ticket.schedule) {
      const deferUntil = this.scheduledWakeDeferUntil(ticket, Date.now());
      if (deferUntil != null && deferUntil > Date.now()) {
        await harness.commit(async (tx) => {
          const live = (await tx.doc(KuloStateDoc)).tickets[ticketId];
          if (!live || live.runEpoch !== ticket.runEpoch || live.status !== "waiting" || !live.schedule) return;
          live.schedule.nextRunAt = deferUntil;
          live.waiting = { reason: "time", since: Date.now(), until: deferUntil, detail: "已达后台用量上限，推迟至额度重置后继续" };
          live.updatedAt = Date.now();
        }, context);
        await runtimeGates.broadcastTickets(context);
        return;
      }
    }
    if (!this.#ticketDevicesOnline(ticket)) {
      if (ticket.waiting?.reason === "time") {
        await harness.commit(async (tx) => {
          const t = (await tx.doc(KuloStateDoc)).tickets[ticketId];
          if (t?.runEpoch === ticket.runEpoch && t.status === "waiting") {
            t.waiting = { reason: "env", since: Date.now(), detail: "定时已到，等待执行设备上线" };
            t.activeTaskId = undefined;
          }
        }, context);
      }
      return;
    }
    try {
      await ports.steerTicket({
        ticketId,
        commandId: `wake:${ticketId}:${ticket.runEpoch}`,
        text: ticket.schedule?.nextRunAt != null
          ? `Scheduled execution time reached. Execute this run per your authorized mandate—inspect current state and any unconfirmed side-effect results first so prior side effects are not repeated.\n\n${formatWorkerInitialPrompt(ticket)}`
          : ticket.executionDomain === "android"
            ? "Wait condition satisfied. Re-observe the target Android phone first and verify prior action receipts and current screen state before continuing; never replay completed or uncertain side effects."
            : "Wait condition satisfied. Incorporate any follow-up instructions, inspect workspace file changes and unconfirmed tool results first, and continue without repeating completed side effects.",
      }, context);
    } catch (error) {
      await harness.commit(async (tx) => {
        const current = (await tx.doc(KuloStateDoc)).tickets[ticketId];
        if (current?.runEpoch === ticket.runEpoch && current.status === "waiting" && current.waiting) {
          current.waiting.detail = `恢复失败：${error instanceof Error ? error.message : String(error)}`;
          current.updatedAt = Date.now();
        }
      }, context);
      if (!(error instanceof ProjectError)) console.error(`[KuloResume:${ticketId}]`, error);
    }
  }
}
