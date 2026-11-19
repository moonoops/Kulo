import { translate as t } from "../../kulo-i18n";
import type { ChatDisplayItem, LiveStreamState, TicketCardView } from "@kulo/protocol";
import { describeLocalizedKuloError } from "../../kulo-error";
import { taskStatusLabel, taskSummary } from "../tasks/task-model";

export interface AgentTerminalEntry {
  id: string;
  text: string;
  tone: "info" | "thinking" | "tool" | "output" | "done" | "error";
  outcome?: "completed" | "failed" | "stopped" | "closed";
  eventId?: string;
  /** Receipt time for live settlements, or the task's recorded settlement time. */
  eventAt?: number;
}

type Settlement = { outcome: NonNullable<AgentTerminalEntry["outcome"]>; eventId?: string; eventAt?: number };

export interface AgentTerminalState {
  topicId: string;
  entries: readonly AgentTerminalEntry[];
  sequence: number;
  messagesSeen: readonly number[];
  messagesLoaded: boolean;
  liveLoaded: boolean;
  busy: boolean;
  stage?: string;
  stageEntryId?: string;
  tools: Record<string, { name: string; ended: boolean; order: number; output?: string; outputEntryId?: string }>;
  activeToolIds: readonly string[];
  latestReplyId?: number;
  settledReplyId?: number;
  failure?: string;
  thinking?: string;
  replying?: boolean;
  retry?: string;
  ticketsSeen?: Record<string, string>;
}

function compact(value: string, length = 100): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(-length);
}

export function updateAgentTerminal(previous: AgentTerminalState | null, update: {
  topicId: string;
  messages?: readonly ChatDisplayItem[];
  live?: LiveStreamState;
  tickets?: readonly TicketCardView[];
}): AgentTerminalState {
  const initial = !previous || previous.topicId !== update.topicId;
  const state: AgentTerminalState = initial ? {
    topicId: update.topicId, entries: [], sequence: 0, messagesSeen: [], messagesLoaded: false,
    liveLoaded: false, busy: false, tools: {}, activeToolIds: [],
  } : { ...previous, entries: [...previous.entries], tools: { ...previous.tools } };
  const settledFields = (id: string, settlement?: Settlement) => settlement ? {
    outcome: settlement.outcome,
    eventId: settlement.eventId ?? `${id}:${settlement.outcome}`,
    eventAt: settlement.eventAt ?? Date.now(),
  } : {};
  const append = (text: string, tone: AgentTerminalEntry["tone"], settlement?: Settlement): string => {
    const id = `${state.topicId}:${++state.sequence}`;
    state.entries = [...state.entries, { id, text, tone, ...settledFields(id, settlement) }].slice(-80);
    return id;
  };
  const stage = (key: string, text: string, tone: AgentTerminalEntry["tone"], settlement?: Settlement) => {
    if (state.stage === key && state.entries.some((entry) => entry.id === state.stageEntryId)) {
      state.entries = state.entries.map((entry) => entry.id === state.stageEntryId ? { ...entry, text, tone, ...settledFields(entry.id, settlement) } : entry);
    } else state.stageEntryId = append(text, tone, settlement);
    state.stage = key;
  };
  const tool = (callId: string, name: string) => {
    if (!state.tools[callId]) {
      stage(`tool:${callId}`, t(`调用工具 · ${compact(name)}`, `Tool call · ${compact(name)}`), "tool");
      state.tools[callId] = { name, ended: false, order: state.sequence };
    }
  };

  if (update.live?.busy && !state.busy) {
    append(t("开始执行", "Started execution"), "info");
    state.stage = undefined;
    state.failure = undefined;
    state.thinking = undefined;
    state.replying = false;
  }

  if (update.messages) {
    const lastUserIndex = update.messages.findLastIndex((message) => message.role === "user");
    const recent = state.messagesLoaded ? update.messages : update.messages.slice(lastUserIndex >= 0 ? lastUserIndex : -1);
    for (const message of recent) {
      if (state.messagesSeen.includes(message.id) || message.role !== "assistant") continue;
      if (message.thinking && message.thinking !== state.thinking) {
        stage(`message-thinking:${message.id}`, t(`思考中 · ${compact(message.thinking)}`, `Thinking · ${compact(message.thinking)}`), "thinking");
        state.thinking = message.thinking;
      }
      for (const call of message.toolCalls ?? []) tool(call.id, call.name);
      if (message.text.trim()) {
        state.latestReplyId = message.id;
        state.failure = undefined;
        stage(`message-reply:${message.id}`, t("生成回复", "Generating reply"), "output");
      }
    }
    state.messagesSeen = update.messages.map((message) => message.id).slice(-200);
    state.messagesLoaded = true;
  }

  if (update.live) {
    const live = update.live;
    if (live.retrying) {
      const retry = `${live.retrying.attempt}:${live.retrying.at}`;
      if (state.retry !== retry) stage(`retry:${retry}`, t(`重试 · 第 ${live.retrying.attempt} 次`, `Retry · Attempt ${live.retrying.attempt}`), "info");
      state.retry = retry;
    }
    if (live.streamingThinking && live.streamingThinking !== state.thinking) stage("thinking", t(`思考中 · ${compact(live.streamingThinking)}`, `Thinking · ${compact(live.streamingThinking)}`), "thinking");
    else if (!live.streamingThinking && live.busy && !live.activeTools.length && !live.streamingText && !live.retrying) stage("thinking", t("思考中", "Thinking"), "thinking");
    for (const active of live.activeTools) {
      tool(active.callId, active.name);
      const output = active.outputTail && compact(active.outputTail);
      if (output && state.tools[active.callId]!.output !== output) {
        const prior = state.tools[active.callId]!;
        let outputEntryId = prior.outputEntryId;
        const text = t(`工具输出 · ${output}`, `Tool output · ${output}`);
        if (outputEntryId && state.entries.some((entry) => entry.id === outputEntryId)) {
          state.entries = state.entries.map((entry) => entry.id === outputEntryId ? { ...entry, text } : entry);
        } else outputEntryId = append(text, "output");
        state.tools[active.callId] = { ...prior, output, outputEntryId, order: state.sequence };
      }
    }
    const activeIds = new Set(live.activeTools.map((active) => active.callId));
    for (const callId of live.busy ? state.activeToolIds : Object.keys(state.tools)) {
      const ended = state.tools[callId];
      if (ended && !ended.ended && !activeIds.has(callId)) {
        stage(`tool-end:${callId}`, t(`调用结束 · ${compact(ended.name)}`, `Tool finished · ${compact(ended.name)}`), "tool");
        state.tools[callId] = { ...ended, ended: true, order: state.sequence };
      }
    }
    state.activeToolIds = [...activeIds];
    if (live.streamingText && !state.replying) stage("reply", t("生成回复", "Generating reply"), "output");
    if (!live.busy) {
      if (live.runFailure) {
        const signature = JSON.stringify(live.runFailure);
        if (signature !== state.failure) {
          const error = describeLocalizedKuloError(live.runFailure);
          stage("settled", error.isUserAbort ? t("已停止", "Stopped") : t(`执行失败 · ${compact(error.title)}`, `Execution failed · ${compact(error.title)}`), error.isUserAbort ? "info" : "error", { outcome: error.isUserAbort ? "stopped" : "failed" });
          state.failure = signature;
        }
        state.settledReplyId = state.latestReplyId;
      } else if (!state.failure && (state.busy || state.latestReplyId !== undefined && state.latestReplyId !== state.settledReplyId)) {
        stage("settled", t("执行完成", "Execution completed"), "done", { outcome: "completed" });
        state.settledReplyId = state.latestReplyId;
      }
    }
    state.busy = live.busy;
    state.thinking = live.streamingThinking;
    state.replying = Boolean(live.streamingText);
    state.liveLoaded = true;
  }

  if (update.tickets) {
    const matching = update.tickets.filter((ticket) => (ticket.originTopicId ?? "root") === update.topicId);
    const signatures = Object.fromEntries(matching.map((ticket) => [ticket.id,
      JSON.stringify([ticket.status, taskStatusLabel(ticket), taskSummary(ticket), ticket.latestReport?.at ?? null, ticket.stoppedReason ?? null])]));
    const shown = state.ticketsSeen ? matching.filter((ticket) => state.ticketsSeen![ticket.id] !== signatures[ticket.id]) : [
      ...matching.filter((ticket) => ["queued", "running", "pausing", "waiting", "blocked"].includes(ticket.status)).sort((a, b) => a.updatedAt - b.updatedAt).slice(-5),
      ...matching.filter((ticket) => ["ready", "failed", "stopped", "closed"].includes(ticket.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1),
    ].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const ticket of shown) {
      const summary = taskSummary(ticket);
      const detail = summary === ticket.title ? ticket.title : `${ticket.title} · ${summary}`;
      const outcome = ticket.status === "ready" ? "completed" : ticket.status === "failed" ? "failed" : ticket.status === "stopped" ? "stopped" : ticket.status === "closed" ? "closed" : undefined;
      const eventAt = ticket.status === "ready" ? ticket.completedAt ?? ticket.latestReport?.at ?? ticket.updatedAt : ticket.updatedAt;
      append(`${taskStatusLabel(ticket)} · ${compact(detail)}`,
        ticket.status === "failed" ? "error" : ticket.status === "ready" ? "done" : "info",
        outcome ? { outcome, eventAt, eventId: `ticket:${ticket.id}:${outcome}:${eventAt}` } : undefined);
    }
    state.ticketsSeen = signatures;
  }
  const active = new Set(state.activeToolIds);
  const recentTools = Object.entries(state.tools).filter(([id]) => !active.has(id))
    .sort((a, b) => b[1].order - a[1].order).slice(0, 80);
  state.tools = Object.fromEntries([...recentTools, ...Object.entries(state.tools).filter(([id]) => active.has(id))]);
  return state;
}
