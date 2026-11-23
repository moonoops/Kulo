import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { submitAutomaticChatInput } from "./chat-control.js";
import { canSwitchEnvDuringRecovery } from "./env-routing-policy.js";
import {
  formatRecoveryExhaustedRelayMessage,
  formatWorkerRecoveryMessage,
  formatWorkerWatchdogMessage,
} from "./prompts.js";
import { SettingsAssistantDoc, isSettingsTopicDeleted } from "./settings-assistant.js";
import {
  KuloStateDoc,
  WorkerRecoveryEntry,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
  type WorkerRecoveryEntryData,
} from "./state.js";
import {
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_REVIEW_INTERVAL_MS,
  planLegacyFailureRecovery,
  recoveryLeaf,
  recoveryWaitSummary,
  resolveSupersededTickets,
  type createFailureRecoveryTask,
} from "./task-recovery.js";
import { injectEventToolsInTx } from "./tool-surface.js";

export interface TrackedWorkerRuntime {
  ticketId: string;
  workerConversationId: number;
  runEpoch: number;
  lastActivityAt: number;
  detachObserver?: () => void;
}

export interface HubWatchdogDeps {
  harness: Harness;
  getRootConversation: () => Conversation;
  revokeTicketConnections: (ticketId: string) => void;
  isClosed: () => boolean;
  isHandoverBarrierActive: () => boolean;
  getWatchdogMinutes: () => number;
  checkIntervalMs: number;
  stallMsOverride?: number;
}

export class HubWatchdog {
  readonly #deps: HubWatchdogDeps;
  readonly #trackedWorkers = new Map<string, TrackedWorkerRuntime>();
  readonly #lastWatchdogAlertAt = new Map<string, number>();
  #watchdogTimer: ReturnType<typeof setInterval> | null = null;
  #watchdogTickInFlight = false;

  constructor(deps: HubWatchdogDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#watchdogTimer || this.#deps.isClosed()) return;
    this.#watchdogTimer = setInterval(() => {
      if (this.#deps.isHandoverBarrierActive()) return;
      void this.checkNow();
    }, this.#deps.checkIntervalMs);
    this.#watchdogTimer.unref?.();
  }

  stopTimer(): void {
    if (this.#watchdogTimer) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }

  drainDetachers(): Array<() => void> {
    const detachers: Array<() => void> = [];
    for (const rec of this.#trackedWorkers.values()) {
      if (rec.detachObserver) detachers.push(rec.detachObserver);
    }
    this.#trackedWorkers.clear();
    this.#lastWatchdogAlertAt.clear();
    return detachers;
  }

  touchActivity(ticketId: string): void {
    const tracked = this.#trackedWorkers.get(ticketId);
    if (tracked) tracked.lastActivityAt = Date.now();
  }

  getLastActivityAt(ticketId: string): number | undefined {
    return this.#trackedWorkers.get(ticketId)?.lastActivityAt;
  }

  async trackRunning(
    ticketId: string,
    workerConversationId: number,
    runEpoch: number,
  ): Promise<void> {
    if (this.#deps.isClosed()) return;
    const ticket = (
      await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT)
    )?.tickets[ticketId];
    if (
      this.#deps.isClosed() ||
      !ticket ||
      ticket.runEpoch !== runEpoch ||
      ticket.status !== "running"
    ) {
      return;
    }
    if (ticket.externalExecution) {
      this.#trackedWorkers.get(ticketId)?.detachObserver?.();
      this.#trackedWorkers.delete(ticketId);
      return;
    }
    const prev = this.#trackedWorkers.get(ticketId);
    if (
      prev &&
      prev.runEpoch === runEpoch &&
      prev.workerConversationId === workerConversationId
    ) {
      prev.lastActivityAt = Date.now();
      return;
    }
    if (prev) {
      prev.detachObserver?.();
      this.#trackedWorkers.delete(ticketId);
    }

    const rec: TrackedWorkerRuntime = {
      ticketId,
      workerConversationId,
      runEpoch,
      lastActivityAt: Date.now(),
    };
    this.#trackedWorkers.set(ticketId, rec);

    void this.#deps.harness
      .observeConversation(
        workerConversationId as ConversationId,
        {
          advance: () => {
            rec.lastActivityAt = Date.now();
          },
          end: () => {},
        },
        BACKGROUND_CONTEXT,
        { min: 1, max: 1 },
      )
      .then((obs) => {
        if (this.#deps.isClosed() || this.#trackedWorkers.get(ticketId) !== rec) {
          obs.detach();
          return;
        }
        rec.detachObserver = () => obs.detach();
      })
      .catch(() => {
        // Conversation might already be gone or harness closing
      });
  }

  untrack(ticketId: string, throughEpoch?: number): void {
    const prev = this.#trackedWorkers.get(ticketId);
    if (prev && throughEpoch !== undefined && prev.runEpoch > throughEpoch) return;
    this.#deps.revokeTicketConnections(ticketId);
    if (prev) {
      prev.detachObserver?.();
      this.#trackedWorkers.delete(ticketId);
    }
  }

  async checkNow(): Promise<void> {
    if (this.#deps.isClosed() || this.#watchdogTickInFlight) return;
    const watchdogMinutes = this.#deps.getWatchdogMinutes();
    if (watchdogMinutes <= 0 && this.#deps.stallMsOverride === undefined) {
      return;
    }

    this.#watchdogTickInFlight = true;
    try {
      const stallMs =
        this.#deps.stallMsOverride ?? Math.max(1, watchdogMinutes) * 60_000;
      const longRunMs = Math.max(stallMs * 3, 15 * 60_000);
      const state = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      if (!state || this.#deps.isClosed()) return;

      const now = Date.now();
      for (const id of [...this.#trackedWorkers.keys()]) {
        const ticket = state.tickets[id];
        if (!ticket || ticket.status !== "running") {
          this.untrack(id);
        }
      }

      for (const ticket of Object.values(state.tickets)) {
        if (ticket.status !== "running") continue;
        if (
          ticket.externalExecution &&
          (ticket.externalExecution.pendingPermissions?.length ?? 0) > 0
        ) {
          continue;
        }

        let tracked: TrackedWorkerRuntime | undefined;
        if (!ticket.externalExecution) {
          tracked = this.#trackedWorkers.get(ticket.id);
          if (!tracked || tracked.runEpoch !== ticket.runEpoch) {
            await this.trackRunning(
              ticket.id,
              ticket.workerConversationId,
              ticket.runEpoch,
            );
            tracked = this.#trackedWorkers.get(ticket.id);
          }
        }

        const startedAt =
          ticket.startedRunningAt ?? ticket.updatedAt ?? ticket.createdAt;
        const lastActivityAt = Math.max(
          ticket.externalExecution
            ? (ticket.externalExecution.lastActivityAt ?? 0)
            : (tracked?.lastActivityAt ?? 0),
          startedAt,
          ticket.latestReport?.at ?? 0,
        );
        const idleMs = Math.max(0, now - lastActivityAt);
        const runningMs = Math.max(0, now - startedAt);

        let reason: "stalled" | "long_running" | null = null;
        let cooldownMs = stallMs;
        if (idleMs >= stallMs) {
          reason = "stalled";
          cooldownMs = stallMs;
        } else if (runningMs >= longRunMs) {
          reason = "long_running";
          cooldownMs = longRunMs;
        }
        if (!reason) continue;

        const dedupKey = `${ticket.id}:${ticket.runEpoch}:${reason}`;
        const lastAlert = this.#lastWatchdogAlertAt.get(dedupKey) ?? 0;
        if (now - lastAlert < cooldownMs) continue;

        this.#lastWatchdogAlertAt.set(dedupKey, now);

        const idleSec = Math.round(idleMs / 1000);
        const runningSec = Math.round(runningMs / 1000);
        const originConvId = (ticket.originConversationId ??
          Number(ROOT_CONVERSATION_ID)) as ConversationId;
        const originConv =
          (await this.#deps.harness.conversation(originConvId, BACKGROUND_CONTEXT)) ??
          this.#deps.getRootConversation();

        const watchdogPrompt = formatWorkerWatchdogMessage({
          ticketId: ticket.id,
          title: ticket.title,
          role: ticket.role,
          ...(ticket.externalExecution
            ? { externalKind: ticket.externalExecution.binding.kind }
            : {}),
          reason,
          idleSec,
          runningSec,
        });

        await this.#deps.harness.commit(async (tx) => {
          await injectEventToolsInTx(tx, originConv.id, ["kulo_inspect"]);
          await submitAutomaticChatInput(tx, originConv, {
            type: "input",
            content: watchdogPrompt,
            whenBusy: "followUp",
            requestId: `kulo:watchdog:${ticket.id}:${ticket.runEpoch}:${reason}:${now}`,
            entry: {
              kind: WorkerWatchdogEntry.kind,
              data: {
                ticketId: ticket.id,
                title: ticket.title,
                role: ticket.role,
                reason,
                idleSec,
                runningSec,
                runEpoch: ticket.runEpoch,
              },
            },
          });
        }, BACKGROUND_CONTEXT);
      }
    } catch {
      // Best-effort periodic watchdog check
    } finally {
      this.#watchdogTickInFlight = false;
    }
  }
}

export interface HubFailureRecoveryDeps {
  harness: Harness;
  getRootConversation: () => Conversation;
  failureRecoveryTask: ReturnType<typeof createFailureRecoveryTask>;
  isClosed: () => boolean;
  isRecovering: () => boolean;
  isExecutorPaused: () => boolean;
  broadcastTickets: (context: Context) => Promise<void>;
}

export class HubFailureRecovery {
  readonly #deps: HubFailureRecoveryDeps;

  constructor(deps: HubFailureRecoveryDeps) {
    this.#deps = deps;
  }

  async startLegacyRecovery(context: Context): Promise<void> {
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const settingsDoc = await tx.doc(SettingsAssistantDoc);
      const now = Date.now();
      const tasks = planLegacyFailureRecovery(
        state,
        (topicId) => isSettingsTopicDeleted(topicId, settingsDoc),
        now,
      );
      for (const item of tasks) {
        await tx.createTask(
          this.#deps.failureRecoveryTask,
          { ticketId: item.ticketId, startedAt: item.startedAt },
          {
            ownership: { kind: "conversation" },
            conversationId: (item.originConversationId ??
              Number(ROOT_CONVERSATION_ID)) as ConversationId,
            background: true,
          },
        );
      }
    }, context);
  }

  async review(
    ticketId: string,
    startedAt: number,
    context: Context,
  ): Promise<number | null> {
    if (this.#deps.isClosed()) return null;
    if (this.#deps.isRecovering() || this.#deps.isExecutorPaused()) {
      return Date.now() + 30_000;
    }
    const snapshot = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const settingsSnapshot = await this.#deps.harness.snapshot(
      SettingsAssistantDoc,
      context,
    );
    const root = snapshot?.tickets[ticketId];
    if (
      !root?.recovery ||
      root.recovery.startedAt !== startedAt ||
      ["closed", "stopped", "ready"].includes(root.status) ||
      isSettingsTopicDeleted(root.originTopicId, settingsSnapshot) ||
      snapshot?.topics?.[root.originTopicId ?? "root"]?.deletedAt
    ) {
      return null;
    }
    const origin =
      (await this.#deps.harness.conversation(
        (root.originConversationId ??
          Number(ROOT_CONVERSATION_ID)) as ConversationId,
        context,
      )) ?? this.#deps.getRootConversation();
    let nextAt: number | null = Date.now() + 30_000;
    await origin.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const current = state.tickets[ticketId];
      const recovery = current?.recovery;
      if (
        !current ||
        !recovery ||
        recovery.startedAt !== startedAt ||
        ["closed", "stopped", "ready"].includes(current.status)
      ) {
        nextAt = null;
        return;
      }
      const target = recoveryLeaf(state, current);
      const now = Date.now();
      if (target.status === "ready") {
        resolveSupersededTickets(state, target, now);
        nextAt = null;
        return;
      }
      if (
        target.status === "blocked" ||
        (target.status === "waiting" &&
          (target.waiting?.reason === "user" ||
            target.waiting?.reason === "coordinator"))
      ) {
        // The Worker's blocker relay already handed this decision to the coordinator/user.
        recovery.state = "exhausted";
        recovery.notifiedAt ??= target.latestReport?.at ?? now;
        recovery.nextAttemptAt = undefined;
        nextAt = null;
      } else if (target.status === "running" || target.status === "pausing") {
        return;
      } else if (now >= recovery.deadlineAt) {
        recovery.state = "exhausted";
        recovery.nextAttemptAt = undefined;
        nextAt = null;
        if (recovery.notifiedAt) return;
        const failed = target.status === "failed";
        const reportTicket = failed ? target : current;
        const summary = failed
          ? (target.latestReport?.summary ?? "自动恢复未能完成任务。")
          : recoveryWaitSummary(target);
        await submitAutomaticChatInput(tx, origin, {
          type: "input",
          whenBusy: "followUp",
          requestId: `kulo:recovery-exhausted:${ticketId}:${startedAt}`,
          content: formatRecoveryExhaustedRelayMessage({
            title: reportTicket.title,
            summary,
            ...(!failed ? { replacementStatus: target.status } : {}),
          }),
          entry: {
            kind: WorkerRelayEntry.kind,
            data: {
              ticketId: reportTicket.id,
              title: reportTicket.title,
              role: reportTicket.role,
              state: "failed",
              summary,
              deliverable: null,
              question: null,
            },
          },
        });
        recovery.notifiedAt = now;
      } else if (target.status !== "failed") {
        nextAt = Math.min(now + 30_000, recovery.deadlineAt);
        return;
      } else {
        if (recovery.attempts >= MAX_RECOVERY_ATTEMPTS) {
          nextAt = recovery.deadlineAt;
          return;
        }
        if (
          recovery.nextAttemptAt !== undefined &&
          now < recovery.nextAttemptAt
        ) {
          nextAt = Math.min(recovery.nextAttemptAt, recovery.deadlineAt);
          return;
        }
        recovery.attempts++;
        recovery.nextAttemptAt = Math.min(
          now + RECOVERY_REVIEW_INTERVAL_MS,
          recovery.deadlineAt,
        );
        const guard: WorkerRecoveryEntryData = {
          ticketId: target.id,
          rootTicketId: ticketId,
          startedAt,
          attempt: recovery.attempts,
          runEpoch: target.runEpoch,
        };
        const topicTargetDeviceId =
          state.topics?.[target.originTopicId ?? "root"]?.targetDeviceId;
        await injectEventToolsInTx(tx, origin.id, ["kulo_inspect"]);
        await submitAutomaticChatInput(tx, origin, {
          type: "input",
          whenBusy: "followUp",
          requestId: `kulo:recovery:${ticketId}:${startedAt}:${recovery.attempts}`,
          content: formatWorkerRecoveryMessage({
            ticketId: target.id,
            title: target.title,
            summary: target.latestReport?.summary ?? "execution incomplete",
            attempt: recovery.attempts,
            maxAttempts: MAX_RECOVERY_ATTEMPTS,
            deviceLocked: !canSwitchEnvDuringRecovery(
              target,
              topicTargetDeviceId,
            ),
            envId: target.envId,
          }),
          entry: { kind: WorkerRecoveryEntry.kind, data: guard },
        });
        nextAt = recovery.nextAttemptAt;
      }
      current.updatedAt = now;
      for (const related of Object.values(state.tickets)) {
        if (
          related.id !== current.id &&
          related.recovery?.rootTicketId === ticketId &&
          related.recovery.startedAt === startedAt
        ) {
          related.recovery = { ...recovery };
          related.updatedAt = now;
        }
      }
    }, context);
    await this.#deps.broadcastTickets(context);
    return nextAt;
  }
}
