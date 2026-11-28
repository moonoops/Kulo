import { translate as t } from "../../kulo-i18n";
import type { ExternalAgentContextUsage, TicketCardView, TicketRecord, TicketStatus, TopicSummary } from "@kulo/protocol";

export function formatExternalTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  const rounded = Math.round(tokens);
  if (rounded >= 1_000_000) {
    const m = rounded / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (rounded >= 1_000) {
    const k = rounded / 1_000;
    return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(rounded);
}

export function formatExternalContextUsage(
  usage: ExternalAgentContextUsage | undefined,
): string | undefined {
  if (!usage || typeof usage.usedTokens !== "number" || !Number.isFinite(usage.usedTokens) || usage.usedTokens < 0) {
    return undefined;
  }
  const usedLabel = formatExternalTokenCount(usage.usedTokens);
  const hasKnownWindow =
    typeof usage.contextWindow === "number" &&
    Number.isFinite(usage.contextWindow) &&
    usage.contextWindow > 0;
  if (!hasKnownWindow) {
    return t(`上下文 ${usedLabel}`, `Context ${usedLabel}`);
  }
  const windowLabel = formatExternalTokenCount(usage.contextWindow!);
  const percent =
    typeof usage.percent === "number" && Number.isFinite(usage.percent)
      ? Math.max(0, Math.min(100, Math.round(usage.percent)))
      : Math.max(0, Math.min(100, Math.round((usage.usedTokens / usage.contextWindow!) * 100)));
  return t(
    `上下文 ${usedLabel} / ${windowLabel} (${percent}%)`,
    `Context ${usedLabel} / ${windowLabel} (${percent}%)`,
  );
}

export function formatExternalSessionMode(mode: string | undefined): string | undefined {
  const clean = mode?.trim();
  if (!clean) return undefined;
  return t(`模式 ${clean}`, `Mode ${clean}`);
}

export type TaskTone = "ask" | "run" | "fail" | "done" | "wait";
export type TaskTiming = Pick<TicketRecord, "status" | "createdAt" | "updatedAt" | "startedRunningAt" | "accumulatedRunningMs" | "completedAt" | "queuedAt" | "waiting">;

export function compactTaskPaths(text: string, ticket: Pick<TicketRecord, "workspaceDir" | "scratchDir">): string {
  const roots = [[ticket.workspaceDir, t("工作目录", "Working directory")], [ticket.scratchDir, t("草稿目录", "Scratch directory")]] as const;
  return roots.flatMap(([root, label]) => root ? [{ root, label }] : [])
    .sort((a, b) => b.root.length - a.root.length)
    .reduce((value, { root, label }) => value.replaceAll(root, label), text);
}

export function taskIsRecovering(ticket: Pick<TicketCardView, "status" | "recovery">): boolean {
  return ticket.status === "failed" && ticket.recovery?.state === "recovering";
}

export function isTaskUnfinished(ticket: Pick<TicketCardView, "status">): boolean {
  return ["queued", "running", "pausing", "waiting", "blocked"].includes(ticket.status);
}

export function ticketHasPendingWorkspaceApply(
  ticket: Pick<TicketRecord, "status" | "workspaceStaging" | "externalExecution">,
): boolean {
  if (ticket.status === "stopped" || ticket.status === "closed") return false;
  return Boolean(
    (ticket.workspaceStaging?.mode === "staged" &&
      !ticket.workspaceStaging.appliedAt &&
      !ticket.workspaceStaging.discardedAt &&
      ticket.workspaceStaging.stagedDiff?.hasChanges) ||
      (ticket.externalExecution?.workspaceMode === "staged" &&
        !ticket.externalExecution.stagedAppliedAt &&
        ticket.externalExecution.stagedDiff?.hasChanges),
  );
}

export function taskStatusLabel(ticket: Pick<TicketCardView, "status" | "waiting" | "cleanupPending" | "recovery" | "externalAgentKind" | "pendingWorkspaceApply">): string {
  if (ticket.cleanupPending) return t("清理待确认", "Cleanup pending");
  if (taskIsRecovering(ticket)) return t("恢复中", "Recovering");
  if (ticket.status === "failed" && ticket.recovery?.state === "exhausted") return t("需处理", "Needs attention");
  if (ticket.status === "ready" && ticket.pendingWorkspaceApply) return t("待合入", "Pending merge");
  return ticket.status === "waiting" ? ticketWaitLabel(ticket.waiting) : ticketStatusLabel(ticket.status);
}

export function ticketTone(status: TicketStatus): TaskTone {
  if (status === "running" || status === "pausing") return "run";
  if (status === "blocked") return "ask";
  if (status === "failed") return "fail";
  if (status === "ready") return "done";
  return "wait";
}

export function ticketWaitLabel(waiting: TicketCardView["waiting"]): string {
  switch (waiting?.reason) {
    case "user": return t("等待确认", "Awaiting confirmation");
    case "coordinator": return t("主脑研判中", "Coordinating");
    case "connection": return t("等待连接", "Waiting for connection");
    case "env": return t("等待设备", "Waiting for device");
    case "time": return t("等待时间", "Waiting for scheduled time");
    case "external": return t("等待外部结果", "Waiting for external result");
    case "project": return t("等待项目", "Waiting for project");
    default: return t("等待中", "Waiting");
  }
}

export function ticketStatusLabel(status: TicketStatus): string {
  return ({
    running: t("运行中", "Running"), queued: t("排队中", "Queued"), pausing: t("暂停中", "Pausing"), waiting: t("等待中", "Waiting"),
    blocked: t("问题待确认", "Needs your decision"), ready: t("已完成", "Completed"), failed: t("失败", "Failed"), stopped: t("已停止", "Stopped"), closed: t("已关闭", "Closed"),
  } satisfies Record<TicketStatus, string>)[status];
}

export function taskNeedsAttention(ticket: TicketCardView): boolean {
  return Boolean(
    ticket.cleanupPending ||
      ticket.pendingWorkspaceApply ||
      (ticket.status === "failed" && !taskIsRecovering(ticket)) ||
      ticket.status === "blocked" ||
      (ticket.status === "waiting" && ticket.waiting?.reason === "user"),
  );
}

export function taskCompletedAt(ticket: TicketCardView): number | undefined {
  return ticket.completedAt ?? (ticket.status === "ready" && ticket.latestReport?.state === "ready" ? ticket.latestReport.at : undefined);
}

export function taskHasExpired(ticket: TicketCardView, now: number, hours: number | null): boolean {
  if (hours === null || ticket.status !== "ready" || taskNeedsAttention(ticket)) return false;
  const completed = taskCompletedAt(ticket);
  return completed !== undefined && now >= completed + hours * 3_600_000;
}

export function taskRunningMs(ticket: TaskTiming, now: number): number | undefined {
  const active = ticket.status === "running" || ticket.status === "pausing";
  if (ticket.accumulatedRunningMs === undefined && (!active || ticket.startedRunningAt === undefined)) return undefined;
  return Math.max(0, ticket.accumulatedRunningMs ?? 0) +
    (active && ticket.startedRunningAt !== undefined ? Math.max(0, now - ticket.startedRunningAt) : 0);
}

function duration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("不到 1 分钟", "Less than a minute");
  if (minutes < 60) return minutes + t(" 分钟", " min");
  const remainder = minutes % 60;
  return Math.floor(minutes / 60) + t(" 小时", " hr") + (remainder ? " " + remainder + t(" 分钟", " min") : "");
}

export function taskDurationLabel(ticket: TaskTiming, now: number): string | undefined {
  if (ticket.status === "queued") return duration(now - (ticket.queuedAt ?? ticket.createdAt));
  if (ticket.status === "waiting" || ticket.status === "blocked") {
    return ticket.waiting ? duration(now - ticket.waiting.since) : undefined;
  }
  const elapsed = taskRunningMs(ticket, now);
  return elapsed === undefined ? undefined : duration(elapsed);
}

export function taskTimeLabel(ticket: TaskTiming, now: number): string {
  const elapsed = taskDurationLabel(ticket, now);
  if (ticket.status === "queued") return t("已排队 ", "Queued for ") + elapsed!;
  if (ticket.status === "waiting" || ticket.status === "blocked") {
    return elapsed ? t("已等待 ", "Waiting for ") + elapsed : t("等待中", "Waiting");
  }
  if (elapsed === undefined) return ticket.status === "running" || ticket.status === "pausing" ? t("运行中", "Running") : t("用时未记录", "Duration not recorded");
  return (ticket.status === "running" || ticket.status === "pausing" ? t("已运行 ", "Running for ") : t("用时 ", "Took ")) + elapsed;
}

export function taskSummary(ticket: TicketCardView): string {
  return ticket.userSummary?.trim() || ticket.title;
}

export function taskRank(ticket: TicketCardView): number {
  if (taskNeedsAttention(ticket)) return 0;
  if (taskIsRecovering(ticket)) return 1;
  if (ticket.status === "running" || ticket.status === "pausing") return 1;
  if (ticket.status === "queued") return 2;
  if (ticket.status === "waiting") return 3;
  return 4;
}

export function normalizeTaskTopicId(topicId?: string): string {
  return topicId ?? "root";
}

export function sameTaskRecoveryScope(
  a: Pick<TicketCardView, "originTopicId" | "projectId">,
  b: Pick<TicketCardView, "originTopicId" | "projectId">,
): boolean {
  return normalizeTaskTopicId(a.originTopicId) === normalizeTaskTopicId(b.originTopicId) && a.projectId === b.projectId;
}

export function collectSupersededFailureIds(tickets: readonly TicketCardView[]): Set<string> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const superseded = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.status === "closed" || ticket.status === "stopped" || !ticket.supersedes?.length) continue;
    const visited = new Set<string>([ticket.id]);
    const pending = [...ticket.supersedes];
    while (pending.length) {
      const ancestorId = pending.pop()!;
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);
      const ancestor = byId.get(ancestorId);
      if (!ancestor || !sameTaskRecoveryScope(ticket, ancestor)) continue;
      if (ancestor.status === "failed") superseded.add(ancestor.id);
      if (ancestor.supersedes?.length) pending.push(...ancestor.supersedes);
    }
  }
  return superseded;
}

export function expandClearAllTicketIds(
  allTickets: readonly TicketCardView[],
  visibleTickets: readonly TicketCardView[],
): string[] {
  const byId = new Map(allTickets.map((ticket) => [ticket.id, ticket]));
  const ids = visibleTickets.map((ticket) => ticket.id);
  const seen = new Set(ids);
  for (const ticket of visibleTickets) {
    if (!ticket.supersedes?.length) continue;
    const visited = new Set<string>([ticket.id]);
    const pending = [...ticket.supersedes];
    while (pending.length) {
      const ancestorId = pending.pop()!;
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);
      const ancestor = byId.get(ancestorId);
      if (!ancestor || ancestor.status === "closed" || !sameTaskRecoveryScope(ticket, ancestor)) continue;
      if (ancestor.supersedes?.length) pending.push(...ancestor.supersedes);
      if (ancestor.status === "failed" && !seen.has(ancestor.id)) {
        seen.add(ancestor.id);
        ids.push(ancestor.id);
      }
    }
  }
  return ids;
}

export interface GroupedTaskCards {
  current: TicketCardView[];
  other: TicketCardView[];
}

export function groupVisibleTaskCards(
  visible: readonly TicketCardView[],
  activeTopicId: string,
): GroupedTaskCards {
  const current: TicketCardView[] = [];
  const other: TicketCardView[] = [];
  const normalizedActive = normalizeTaskTopicId(activeTopicId);
  for (const ticket of visible) {
    if (normalizeTaskTopicId(ticket.originTopicId) === normalizedActive) current.push(ticket);
    else other.push(ticket);
  }
  return { current, other };
}

export function buildTopicTitleMap(
  topics?: readonly TopicSummary[],
  mainChatTitle?: string,
): ReadonlyMap<string, string> | undefined {
  const cleanMain = mainChatTitle?.trim();
  if (!topics && !cleanMain) return undefined;
  const titles = new Map<string, string>();
  for (const topic of topics ?? []) {
    if (topic.deletedAt !== undefined) continue;
    if (topic.master || topic.id === "root") {
      const label = cleanMain || topic.title.trim();
      if (label) {
        titles.set(topic.id, label);
        if (topic.master && !titles.has("root")) titles.set("root", label);
      }
      continue;
    }
    const label = topic.title.trim();
    if (label) titles.set(topic.id, label);
  }
  if (cleanMain && !titles.has("root")) titles.set("root", cleanMain);
  return titles;
}

export function visibleTaskCards(tickets: readonly TicketCardView[], now: number, hours: number | null, protectedIds: ReadonlySet<string> = new Set()): TicketCardView[] {
  const supersededFailures = collectSupersededFailureIds(tickets);
  return tickets
    .filter(
      (ticket) =>
        ticket.status !== "closed" &&
        (!supersededFailures.has(ticket.id) || protectedIds.has(ticket.id)) &&
        (!taskHasExpired(ticket, now, hours) || protectedIds.has(ticket.id)),
    )
    .sort((a, b) => taskRank(a) - taskRank(b) ||
      (a.status === "ready" && b.status === "ready" ? (taskCompletedAt(b) ?? b.createdAt) - (taskCompletedAt(a) ?? a.createdAt) : b.createdAt - a.createdAt) ||
      a.id.localeCompare(b.id));
}

export function scopeTickets(tickets: readonly TicketCardView[], scope: "topic" | "project" | "all", activeTopicId: string, activeProjectId?: string): TicketCardView[] {
  if (scope === "all") return [...tickets];
  if (scope === "project" && activeProjectId) return tickets.filter(ticket => ticket.projectId === activeProjectId);
  return tickets.filter(ticket => normalizeTaskTopicId(ticket.originTopicId) === normalizeTaskTopicId(activeTopicId));
}

export interface TaskRow {
  ticket: TicketCardView;
  present: boolean;
  enter: boolean;
  instantExit?: boolean;
}

/** Keep exiting rows next to their former successor until their space has collapsed. */
export function reconcileTaskRows(previous: readonly TaskRow[], desired: readonly TicketCardView[], freshIds: ReadonlySet<string>): TaskRow[] {
  const ids = new Set(desired.map(ticket => ticket.id));
  const existing = new Map(previous.map(row => [row.ticket.id, row]));
  const rows: TaskRow[] = desired.map(ticket => ({ ticket, present: true, enter: existing.get(ticket.id)?.enter ?? freshIds.has(ticket.id) }));
  for (let index = 0; index < previous.length; index++) {
    const row = previous[index]!;
    if (ids.has(row.ticket.id)) continue;
    const nextId = previous.slice(index + 1).find(next => ids.has(next.ticket.id))?.ticket.id;
    const nextIndex = nextId ? rows.findIndex(next => next.ticket.id === nextId) : -1;
    rows.splice(nextIndex < 0 ? rows.length : nextIndex, 0, { ...row, present: false });
  }
  return rows;
}
