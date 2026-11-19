import { translate as t } from "../../kulo-i18n";
import type { LiveStreamState, TicketCardView } from "@kulo/protocol";
import type { CatState } from "../../components/cat-motion";
import { describeLocalizedKuloError } from "../../kulo-error";
import { taskCompletedAt, taskIsRecovering, taskNeedsAttention, taskStatusLabel } from "../tasks/task-model";
import type { AgentTerminalEntry } from "./agent-terminal-state";

export interface AgentProfileActivity {
  state: CatState;
  label: string;
  detail?: string;
  tone?: "success" | "danger";
  eventId?: string;
  eventAt?: number;
}

export interface AgentProfileCompletion {
  eventId: string;
  eventAt: number;
}

export function agentProfileCompletions({ tickets, entries }: {
  tickets: readonly TicketCardView[];
  entries: readonly AgentTerminalEntry[];
}): AgentProfileCompletion[] {
  const completions = new Map<string, AgentProfileCompletion>();
  for (const entry of entries) {
    if (entry.outcome !== "completed") continue;
    const eventId = entry.eventId ?? `${entry.id}:completed`;
    completions.set(eventId, { eventId, eventAt: entry.eventAt ?? 0 });
  }
  for (const ticket of tickets) {
    if (ticket.status !== "ready") continue;
    const eventAt = taskCompletedAt(ticket) ?? ticket.latestReport?.at ?? ticket.updatedAt;
    const eventId = `ticket:${ticket.id}:completed:${eventAt}`;
    completions.set(eventId, { eventId, eventAt });
  }
  return [...completions.values()].sort((a, b) => b.eventAt - a.eventAt);
}

export function agentProfileActivity({ connected, live, tickets, entries, replyActive = Boolean(live?.streamingText) }: {
  connected: boolean;
  live?: LiveStreamState;
  tickets: readonly TicketCardView[];
  entries: readonly AgentTerminalEntry[];
  replyActive?: boolean;
}): AgentProfileActivity {
  if (!connected) return { state: "offline", label: t("连接中…", "Connecting…") };
  if (live?.busy) {
    if (live.retrying) return { state: "idle", label: t("正在重试", "Retrying") };
    if (live.activeTools.length) return { state: "working", label: t("正在执行", "Executing"), detail: live.activeTools.at(-1)!.name };
    return live.streamingText && replyActive ? { state: "speaking", label: t("正在回复", "Replying") } : { state: "thinking", label: t("正在思考", "Thinking") };
  }
  const failure = live?.runFailure && describeLocalizedKuloError(live.runFailure);
  if (failure && !failure.isUserAbort) return { state: "error", label: t("执行失败", "Execution failed"), detail: failure.title, tone: "danger" };
  const attention = tickets.find(taskNeedsAttention);
  if (attention) {
    if (attention.status === "failed" && !attention.cleanupPending) return { state: "error", label: t("执行失败", "Execution failed"), detail: attention.title, tone: "danger" };
    return { state: "waiting", label: attention.cleanupPending || attention.pendingWorkspaceApply ? taskStatusLabel(attention) : attention.status === "blocked" ? t("需要处理", "Needs attention") : t("等待确认", "Awaiting confirmation"), detail: attention.title };
  }
  const working = tickets.find((ticket) => ticket.status === "running" || ticket.status === "pausing" || taskIsRecovering(ticket));
  if (working) return { state: "working", label: taskIsRecovering(working) ? t("恢复中", "Recovering") : working.status === "pausing" ? t("正在暂停", "Pausing") : t("正在执行", "Executing"), detail: working.title };
  const last = entries.at(-1);
  if (failure?.isUserAbort) return { state: "idle", label: t("已停止", "Stopped") };
  if (last?.outcome === "failed" || last?.tone === "error") return { state: "error", label: t("执行失败", "Execution failed"), detail: last.text, tone: "danger" };
  const waiting = tickets.find((ticket) => ticket.status === "waiting");
  if (waiting) return { state: "idle", label: waiting.waiting?.reason === "connection" ? t("等待连接", "Waiting for connection") : taskStatusLabel(waiting), detail: waiting.title };
  if (tickets.some((ticket) => ticket.status === "queued")) return { state: "idle", label: t("等待执行", "Waiting to run") };
  // Only structured settlements establish success; a closed journal row is not a completed task.
  const completion = agentProfileCompletions({ tickets, entries: last?.outcome === "completed" ? [last] : [] })[0];
  if (last?.outcome === "stopped" && (!completion || (last.eventAt ?? 0) >= completion.eventAt)) return { state: "idle", label: t("已停止", "Stopped") };
  if (completion) return { state: "success", label: t("已完成", "Completed"), tone: "success", ...completion };
  return { state: "idle", label: t("等待任务", "Waiting for a task") };
}
