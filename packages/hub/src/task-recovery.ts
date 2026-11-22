import { defineTask } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { TicketOutwardAction, TicketRecord, TicketRecoveryRecord } from "@kulo/protocol";
import { redactSecrets } from "@kulo/protocol";
import { KuloStateDoc, releaseProjectWrite, transitionTicketStatus, type KuloDurableState } from "./state.js";
import type { WorkerRecoveryEntryData } from "./state.js";

export const RECOVERY_WINDOW_MS = 10 * 60_000;
export const RECOVERY_REVIEW_INTERVAL_MS = 60_000;
export const MAX_RECOVERY_ATTEMPTS = 2;
const MAX_TICKET_OUTWARD_ACTIONS = 16;

export function appendTicketOutwardAction(
  ticket: TicketRecord,
  entry: Omit<TicketOutwardAction, "at"> & { at?: number },
): boolean {
  const label = redactSecrets(entry.label).trim().slice(0, 160);
  if (!label) return false;
  const existing = ticket.outwardActions ?? [];
  if (existing.some((item) => item.runEpoch === entry.runEpoch && item.kind === entry.kind && item.label === label)) {
    return false;
  }
  const next: TicketOutwardAction = {
    runEpoch: entry.runEpoch,
    kind: entry.kind,
    label,
    at: entry.at ?? Date.now(),
  };
  ticket.outwardActions = [...existing, next].slice(-MAX_TICKET_OUTWARD_ACTIONS);
  return true;
}

export function epochOutwardActions(ticket: Pick<TicketRecord, "outwardActions">, runEpoch: number): TicketOutwardAction[] {
  return (ticket.outwardActions ?? []).filter((item) => item.runEpoch === runEpoch);
}

export function formatOutwardActionsSummary(actions: readonly TicketOutwardAction[]): string {
  const labels = [...new Set(actions.map((item) => item.label))].slice(0, 6);
  const suffix = actions.length > labels.length ? ` 等共 ${actions.length} 项` : "";
  return `本轮执行在失败前已发起不可自动重放的外部动作（${labels.join("、")}${suffix}），系统已阻止后台自动重试。请先核实外部实际状态，再决定继续还是重新操作。`;
}

export function beginTicketRecovery(ticket: TicketRecord, now: number): TicketRecoveryRecord {
  ticket.recovery ??= { state: "recovering", attempts: 0, startedAt: now,
    deadlineAt: now + RECOVERY_WINDOW_MS, nextAttemptAt: now, rootTicketId: ticket.id };
  return ticket.recovery;
}

export function sameRecoveryScope(a: Pick<TicketRecord, "originTopicId" | "projectId">, b: Pick<TicketRecord, "originTopicId" | "projectId">): boolean {
  return (a.originTopicId ?? "root") === (b.originTopicId ?? "root") && a.projectId === b.projectId;
}

/** Only a verified ready replacement can retire the failed attempts in its lineage. */
export function resolveSupersededTickets(state: KuloDurableState, completed: TicketRecord, now: number): void {
  if (completed.status !== "ready") return;
  const visited = new Set([completed.id]);
  const pending = [...(completed.supersedes ?? [])];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const old = state.tickets[id];
    if (!old || !sameRecoveryScope(old, completed)) continue;
    pending.push(...(old.supersedes ?? []));
    if (old.status !== "failed" && old.status !== "ready") continue;
    transitionTicketStatus(old, "closed", now);
    if (old.workspaceStaging && !old.workspaceStaging.appliedAt && !old.workspaceStaging.discardedAt) {
      old.workspaceStaging.discardedAt = now;
      delete old.workspaceStaging.stagedCwd;
      delete old.workspaceStaging.stagedDiff;
    }
    if (old.externalExecution && !old.externalExecution.stagedAppliedAt) {
      delete old.externalExecution.stagedCwd;
      delete old.externalExecution.stagedDiff;
    }
    releaseProjectWrite(state, old.id, { force: true });
    old.closure = { kind: "superseded", replacementTicketId: completed.id,
      reason: "替代方案已完成", at: now };
    old.recovery = undefined;
    old.updatedAt = now;
  }
  completed.recovery = undefined;
}

type ReplacementLookup = (ticketId: string) => TicketRecord[];

export function recoveryLeaf(state: Readonly<KuloDurableState>, root: TicketRecord, lookup?: ReplacementLookup): TicketRecord {
  let current = root;
  const visited = new Set([root.id]);
  for (;;) {
    const candidates = lookup ? lookup(current.id) : Object.values(state.tickets).filter(ticket => ticket.supersedes?.includes(current.id));
    const replacements = candidates.filter(ticket => sameRecoveryScope(root, ticket) &&
      ticket.status !== "closed" && ticket.status !== "stopped" && !visited.has(ticket.id));
    replacements.sort((a, b) => Number(b.status !== "failed") - Number(a.status !== "failed") || b.createdAt - a.createdAt);
    const next = replacements[0];
    if (!next) return current;
    current = next;
    visited.add(next.id);
  }
}

export function recoveryWaitSummary(ticket: TicketRecord): string {
  if (ticket.status === "queued") return "替代方案仍在排队，目标尚未完成。";
  const labels = { user: "等待用户确认", coordinator: "主脑研判中", env: "等待设备", time: "等待约定时间", external: "等待外部结果",
    project: "等待项目可用", connection: "等待连接授权" } as const;
  const label = ticket.waiting ? labels[ticket.waiting.reason] : "等待继续执行";
  const detail = ticket.waiting?.detail?.trim();
  return `替代方案仍在${label}${detail ? `：${detail}` : ""}，目标尚未完成。`;
}

export function isSilentRecoveryFailure(state: Readonly<KuloDurableState>, ticket: TicketRecord, lookup?: ReplacementLookup): boolean {
  if (ticket.status !== "failed" || !ticket.recovery) return false;
  if (ticket.recovery.state === "recovering") return true;
  const target = recoveryLeaf(state, ticket, lookup);
  return (
    target.status === "blocked" ||
    (target.status === "waiting" &&
      (target.waiting?.reason === "user" || target.waiting?.reason === "coordinator"))
  );
}

export function assertRecoveryGuard(state: Readonly<KuloDurableState>, guard: WorkerRecoveryEntryData | undefined): void {
  if (!guard) return;
  const root = state.tickets[guard.rootTicketId];
  const ticket = state.tickets[guard.ticketId];
  if (!root?.recovery || root.status === "closed" || root.status === "stopped" || root.status === "ready" ||
      root.recovery.state !== "recovering" || root.recovery.startedAt !== guard.startedAt ||
      root.recovery.attempts !== guard.attempt || !ticket || ticket.runEpoch !== guard.runEpoch ||
      ticket.status !== "failed" || recoveryLeaf(state, root).id !== ticket.id) {
    throw new Error("自动恢复请求已过期，任务已由其他操作接手。");
  }
}

export function createFailureRecoveryTask(deps: {
  review: (ticketId: string, startedAt: number, context: Context) => Promise<number | null>;
  onChanged?: (context: Context) => Promise<void>;
}) {
  return defineTask<{ ticketId: string; startedAt: number }, { phase: "review" }, null>({
    name: "kulo.failure_recovery", version: 1, initial: () => ({ phase: "review" }),
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
    phases: {
      review: async (task, runtime, context) => {
        const snapshot = await runtime.snapshot(KuloStateDoc, context);
        const ticket = snapshot?.tickets[task.input.ticketId];
        if (!ticket?.recovery || ticket.recovery.startedAt !== task.input.startedAt ||
            ticket.status === "closed" || ticket.status === "stopped" || ticket.status === "ready") {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        let nextAt: number | null;
        try {
          nextAt = await deps.review(task.input.ticketId, task.input.startedAt, context);
        } catch (error) {
          const message = redactSecrets(error instanceof Error ? error.message : String(error));
          console.error("[KuloTaskRecovery]", message);
          nextAt = runtime.now() + RECOVERY_REVIEW_INTERVAL_MS;
          await runtime.commit(async tx => {
            const state = await tx.doc(KuloStateDoc);
            const current = state.tickets[task.input.ticketId];
            if (current?.recovery?.startedAt !== task.input.startedAt || ["closed", "stopped", "ready"].includes(current.status)) { nextAt = null; return; }
            current.recovery.lastError = message.slice(0, 1000);
            current.recovery.attempts = Math.min(MAX_RECOVERY_ATTEMPTS, current.recovery.attempts + 1);
            current.recovery.nextAttemptAt = nextAt!;
            if (runtime.now() >= current.recovery.deadlineAt) {
              current.recovery.state = "exhausted";
              current.recovery.nextAttemptAt = undefined;
              nextAt = null;
            }
            current.updatedAt = runtime.now();
            return undefined;
          }, context);
          await deps.onChanged?.(context);
        }
        await runtime.commit(async () => nextAt === null
          ? { status: "terminal", outcome: { status: "completed", result: null } }
          : { status: "sleeping", until: Math.max(runtime.now() + 100, nextAt), checkpoint: { phase: "review" } }, context);
      },
    },
  });
}
