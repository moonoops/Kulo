import {
  AssistantEntry,
  CompactionEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationView,
  type EntryRecord,
  type LiveState,
} from "@earendil-works/pi-durable";
import {
  getUiSpecFields,
  isInternalCoordinatorPromptText,
  isSilentCoordinatorReplyText,
  redactSensitiveText,
  sanitizeMarkdownTrackingLinks,
  type ChatAttachment,
  type ChatDisplayItem,
  type ChatReplyReference,
  type LiveStreamState,
  type UiActionReceipt,
  type VoiceCallTranscriptTurn,
  type WebSource,
  type WorkerInspectEntrySummary,
} from "@kulo/protocol";
import { chatReceiptData } from "./chat-submissions.js";
import { redactCredentialData } from "./credential-redaction.js";
import { BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS, MemoryContextRevocationEntry } from "./builtin-memory-entries.js";
import { isContextSyncEntry } from "./recent-work-sync.js";
import { resolveResponseContext } from "./response-context.js";
import { nativeSearchEvidence, sanitizeSearchSources, selectCitedSources } from "./search-sources.js";
import {
  CoordinatorEventEntry,
  MediaRelayEntry,
  WorkerRecoveryEntry,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
  isRecoveryInputBoundary,
} from "./state.js";
import { ContentPublicationEntry, KuloUserEntry, UiActionEntry } from "./ui-cards.js";
import { buildLiveToolActionMeta, classifyToolAction, finalizeToolActionMeta } from "./tool-step-summary.js";
import { parseUserEntryContent } from "./uploads.js";
import { VoiceCallSummaryEntry, formatVoiceCallSummaryText } from "./voice-call-summary.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

const DISPATCH_TOOL_LABELS: Readonly<Record<string, string>> = {
  kulo_dispatch: "派发任务",
  kulo_steer: "推进任务",
  kulo_stop: "停止任务",
  kulo_close: "收口任务",
};

const SILENT_UI_TOOLS = new Set([
  "kulo_dispatch",
  "kulo_steer",
  "kulo_stop",
  "kulo_close",
  "kulo_task_board",
  "kulo_status",
  "kulo_inspect",
  "kulo_expression",
]);

export function entryTimestamp(entry: EntryRecord): number | undefined {
  const rec = entry as unknown as { createdAt?: unknown; at?: unknown };
  if (typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)) return rec.createdAt;
  if (typeof rec.at === "number" && Number.isFinite(rec.at)) return rec.at;
  const message = entry.model?.[0] as { timestamp?: unknown } | undefined;
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (ContentPublicationEntry.is(entry) && typeof entry.data.createdAt === "number" && Number.isFinite(entry.data.createdAt)) {
    return entry.data.createdAt;
  }
  if (VoiceCallSummaryEntry.is(entry) && typeof entry.data.endedAt === "number" && Number.isFinite(entry.data.endedAt)) {
    return entry.data.endedAt;
  }
  return undefined;
}

export function summarizeEntryForInspect(entry: EntryRecord): WorkerInspectEntrySummary {
  const id = Number(entry.id);
  const createdAt = entryTimestamp(entry);

  if (UserEntry.is(entry) || KuloUserEntry.is(entry)) {
    const raw = entry.model?.[0] as { content?: unknown } | undefined;
    const text =
      typeof raw?.content === "string"
        ? raw.content
        : Array.isArray(raw?.content)
          ? raw.content
              .map((b) =>
                b && typeof b === "object" && "text" in b && typeof b.text === "string"
                  ? b.text
                  : "",
              )
              .filter(Boolean)
              .join(" ")
          : "";
    const trimmed = text.replace(/\s+/g, " ").trim();
    return {
      id,
      kind: "user",
      summary: trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed || "(用户消息)",
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (AssistantEntry.is(entry)) {
    const raw = entry.model?.[0] as
      | { content?: Array<{ type?: string; text?: string; name?: string }> }
      | undefined;
    const texts: string[] = [];
    const calls: string[] = [];
    for (const block of raw?.content ?? []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text.trim());
      } else if (block.type === "toolCall" && typeof block.name === "string") {
        calls.push(block.name);
      }
    }
    const parts: string[] = [];
    if (calls.length > 0) parts.push(`[调用: ${calls.join(", ")}]`);
    if (texts.length > 0) parts.push(texts.join(" ").replace(/\s+/g, " "));
    const summary = parts.join(" ").trim() || "(助手响应)";
    return {
      id,
      kind: "assistant",
      summary: summary.length > 240 ? `${summary.slice(0, 240)}...` : summary,
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (ToolResultEntry.is(entry)) {
    const raw = entry.model?.[0] as
      | { toolName?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const name = raw?.toolName ?? "tool";
    if (BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS.has(name)) {
      return {
        id,
        kind: "tool_result",
        summary: raw?.isError ? `${name}: error` : `${name}: ok`,
        ...(createdAt ? { createdAt } : {}),
      };
    }
    const errTag = raw?.isError ? " (ERROR)" : "";
    const snippet = Array.isArray(raw?.content)
      ? raw.content
          .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const combined = snippet ? `${name}${errTag}: ${snippet}` : `${name}${errTag}`;
    return {
      id,
      kind: "tool_result",
      summary: combined.length > 220 ? `${combined.slice(0, 220)}...` : combined,
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (CompactionEntry.is(entry)) {
    return {
      id,
      kind: "compaction",
      summary: "已压缩早期上下文",
      ...(createdAt ? { createdAt } : {}),
    };
  }

  const kindTag = (entry as { kind?: unknown }).kind;
  return {
    id,
    kind: "other",
    summary: typeof kindTag === "string" ? kindTag : "entry",
    ...(createdAt ? { createdAt } : {}),
  };
}

export interface DisplayMessageOptions {
  includeToolResults?: boolean;
  redactToolText?: (text: string) => string;
  resolveConnectionLabel?: (connectionId: string) => string | undefined;
}

export function extractDisplayMessages(
  entries: readonly EntryRecord[],
  options: DisplayMessageOptions = {},
): ChatDisplayItem[] {
  const items: ChatDisplayItem[] = [];
  const pendingToolCalls = new Map<string, NonNullable<ChatDisplayItem["toolCalls"]>[number]>();
  const redactToolText = options.redactToolText ?? redactSensitiveText;
  let toolOutputRemaining = 32_768;
  let pendingSources: WebSource[] = [];
  let pendingSearchSuggestions: string[] = [];
  let recoveryTurn = false;
  const uiCommands = new Map(
    entries.filter(UiActionEntry.is).map((entry) => [
      String(entry.data.commandId),
      entry.data.receipt as unknown as UiActionReceipt,
    ]),
  );
  const voiceTurnsByCall = new Map<string, VoiceCallTranscriptTurn[]>();

  for (const entry of entries) {
    if (WorkerRecoveryEntry.is(entry)) {
      recoveryTurn = true;
      continue;
    }
    if (isRecoveryInputBoundary(entry)) recoveryTurn = false;
    if (recoveryTurn && (AssistantEntry.is(entry) || ToolResultEntry.is(entry))) continue;
    if (entry.kind === "kulo.memory-context" || entry.kind === MemoryContextRevocationEntry.kind || isContextSyncEntry(entry)) continue;
    const createdAt = entryTimestamp(entry);

    if (VoiceTranscriptEntry.is(entry)) {
      const safeText = redactToolText(String(entry.data.text ?? "")).trim();
      if (safeText && typeof entry.data.callId === "string" && entry.data.callId) {
        let list = voiceTurnsByCall.get(entry.data.callId);
        if (!list) {
          list = [];
          voiceTurnsByCall.set(entry.data.callId, list);
        }
        list.push({
          ...(typeof entry.data.itemId === "string" && entry.data.itemId ? { id: entry.data.itemId } : {}),
          role: entry.data.role === "assistant" ? "assistant" : "user",
          text: safeText,
          ...(typeof entry.data.createdAt === "number" && Number.isFinite(entry.data.createdAt)
            ? { createdAt: entry.data.createdAt }
            : {}),
          ...(entry.data.incomplete === true ? { incomplete: true } : {}),
        });
      }
      continue;
    }

    if (VoiceCallSummaryEntry.is(entry)) {
      const data = entry.data;
      const callId = typeof data.callId === "string" ? data.callId : "";
      const durationMs = typeof data.durationMs === "number" && Number.isFinite(data.durationMs) ? Math.max(0, Math.floor(data.durationMs)) : 0;
      const turnCount = typeof data.turnCount === "number" && Number.isFinite(data.turnCount) ? Math.max(0, Math.floor(data.turnCount)) : 0;
      const delegatedTicketIds = Array.isArray(data.delegatedTicketIds)
        ? data.delegatedTicketIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];
      const matchedTurns = callId ? voiceTurnsByCall.get(callId) : undefined;
      const inlineTurns =
        matchedTurns && matchedTurns.length > 0 && matchedTurns.length >= turnCount && matchedTurns.length <= 32
          ? matchedTurns
          : undefined;
      const summaryCreatedAt = createdAt ?? (typeof data.endedAt === "number" ? data.endedAt : undefined);
      items.push({
        id: Number(entry.id),
        role: "system_note",
        ...(callId ? { voiceCallId: callId } : {}),
        text: formatVoiceCallSummaryText({ durationMs, turnCount, delegatedTicketIds }),
        voiceSummary: {
          callId,
          durationMs,
          turnCount,
          delegatedTicketIds,
          ...(typeof data.startedAt === "number" && Number.isFinite(data.startedAt) ? { startedAt: data.startedAt } : {}),
          ...(typeof data.endedAt === "number" && Number.isFinite(data.endedAt) ? { endedAt: data.endedAt } : {}),
          ...(inlineTurns ? { turns: inlineTurns } : {}),
        },
        ...(summaryCreatedAt !== undefined ? { createdAt: summaryCreatedAt } : {}),
      });
      continue;
    }

    if (ContentPublicationEntry.is(entry)) {
      const sources = selectCitedSources(
        entry.data.parts.filter((part) => part.type === "markdown").map((part) => part.text).join("\n") ||
          entry.data.fallbackText,
        pendingSources,
      );
      items.push({
        id: Number(entry.id),
        role: "assistant",
        text: entry.data.fallbackText,
        parts: entry.data.parts,
        ...(sources.length
          ? {
              sources,
              ...(pendingSearchSuggestions.length ? { searchSuggestions: pendingSearchSuggestions } : {}),
            }
          : {}),
        ...(createdAt ? { createdAt } : {}),
      });
      continue;
    }

    if (WorkerWatchdogEntry.is(entry) || MediaRelayEntry.is(entry) || CoordinatorEventEntry.is(entry)) {
      continue;
    }

    if (WorkerRelayEntry.is(entry)) {
      const d = entry.data;
      pendingSources = sanitizeSearchSources([...pendingSources, ...sanitizeSearchSources(d.sources)]);
      if (d.searchSuggestions) {
        pendingSearchSuggestions = [
          ...new Set([
            ...pendingSearchSuggestions,
            ...d.searchSuggestions.filter((value) => typeof value === "string" && value.length <= 24_000),
          ]),
        ].slice(-4);
      }
      continue;
    }

    if (CompactionEntry.is(entry)) {
      items.push({
        id: entry.id as number,
        role: "system_note",
        text: "已压缩早期上下文",
        ...(createdAt ? { createdAt } : {}),
      });
      continue;
    }

    if (ToolResultEntry.is(entry)) {
      const msg = entry.model?.[0] as
        | {
            role?: string;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            details?: { sources?: unknown; searchSuggestions?: unknown };
            content?: Array<{ type?: string; text?: string }>;
          }
        | undefined;
      if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
        const call = pendingToolCalls.get(msg.toolCallId);
        if (call && call.name === msg.toolName) {
          if (call.actionMeta) {
            call.actionMeta = finalizeToolActionMeta(call.actionMeta, {
              name: call.name,
              isError: Boolean(msg.isError),
              content: msg.content,
              details: msg.details,
              redactText: redactToolText,
            });
          }
          if (options.includeToolResults) {
            if (BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS.has(call.name)) {
              call.result = {
                text: msg.isError ? "error" : "ok",
                isError: Boolean(msg.isError),
                ...(createdAt ? { createdAt } : {}),
              };
            } else {
              const output = Array.isArray(msg.content)
                ? msg.content.filter((part) => part.type === "text" && typeof part.text === "string")
                : [];
              const limit = Math.min(4096, toolOutputRemaining);
              let text = "";
              let truncated = false;
              for (const [index, part] of output.entries()) {
                // Redact before truncation so cutting through a credential cannot defeat exact-value filtering.
                const safe = redactToolText(`${index ? "\n" : ""}${part.text!}`);
                const remaining = limit - text.length;
                text += safe.slice(0, remaining);
                if (safe.length > remaining) {
                  truncated = true;
                  break;
                }
              }
              toolOutputRemaining -= text.length;
              call.result = {
                text,
                isError: Boolean(msg.isError),
                ...(createdAt ? { createdAt } : {}),
                ...(truncated ? { truncated: true } : {}),
              };
            }
          }
          pendingToolCalls.delete(msg.toolCallId);
        }
      }
      if (msg && msg.role === "toolResult" && !msg.isError && msg.toolName) {
        if (msg.toolName === "web_search" || msg.toolName === "web_fetch") {
          pendingSources = sanitizeSearchSources([...pendingSources, ...sanitizeSearchSources(msg.details?.sources)]);
          if (typeof msg.details?.searchSuggestions === "string" && msg.details.searchSuggestions.length <= 64_000) {
            pendingSearchSuggestions = [...new Set([...pendingSearchSuggestions, msg.details.searchSuggestions])].slice(-4);
          }
        }
        const actionLabel = DISPATCH_TOOL_LABELS[msg.toolName];
        if (actionLabel && Array.isArray(msg.content)) {
          const textPart = msg.content.find((c) => c.type === "text" && typeof c.text === "string");
          if (textPart?.text) {
            try {
              const parsed = JSON.parse(textPart.text) as {
                ticket?: { id?: string; title?: string; userSummary?: string };
                inline_delivery?: { sources?: WebSource[] };
              };
              if (parsed.inline_delivery) {
                if (parsed.inline_delivery.sources?.length) {
                  pendingSources = sanitizeSearchSources([
                    ...pendingSources,
                    ...sanitizeSearchSources(parsed.inline_delivery.sources),
                  ]);
                }
              } else if (parsed.ticket?.id && parsed.ticket.title) {
                items.push({
                  id: entry.id as number,
                  role: "dispatch",
                  text: parsed.ticket.title,
                  ...(createdAt ? { createdAt } : {}),
                  dispatch: {
                    actionLabel,
                    ticketId: parsed.ticket.id,
                    title: parsed.ticket.title,
                    ...(parsed.ticket.userSummary ? { userSummary: parsed.ticket.userSummary } : {}),
                  },
                });
              }
            } catch {
              // ignore non-JSON diagnostics block
            }
          }
        }
      }
      continue;
    }

    if (UserEntry.is(entry) || KuloUserEntry.is(entry)) {
      const msg = entry.model?.[0];
      const data = (entry.data ?? {}) as unknown as {
        kuloContentVersion?: unknown;
        text?: unknown;
        attachments?: unknown;
        replyTo?: ChatReplyReference;
      };
      if (
        msg?.role === "user" ||
        (KuloUserEntry.is(entry) &&
          data.kuloContentVersion === 1 &&
          typeof data.text === "string" &&
          Array.isArray(data.attachments))
      ) {
        const parsed =
          data.kuloContentVersion === 1 && typeof data.text === "string" && Array.isArray(data.attachments)
            ? { text: data.text, attachments: data.attachments as ChatAttachment[] }
            : parseUserEntryContent(msg?.role === "user" ? msg.content : "");
        if (
          (UserEntry.is(entry) && isInternalCoordinatorPromptText(parsed.text)) ||
          (KuloUserEntry.is(entry) && !chatReceiptData(entry.data).requestId && parsed.text.trimStart().startsWith("[KULO_WORKER_WATCHDOG]"))
        ) {
          continue;
        }
        pendingSources = [];
        pendingSearchSuggestions = [];
        let displayText = parsed.text;
        if (displayText.startsWith('{"type":"kulo.ui.action"')) {
          try {
            const action = JSON.parse(displayText) as {
              commandId: string;
              title: string;
              action: { label: string };
              values: Record<string, unknown>;
            };
            const card = uiCommands.get(action.commandId)?.card;
            if (card) {
              const fields = getUiSpecFields(card.spec);
              const lines = Object.entries(action.values).map(([key, value]) => {
                const element = Object.values(card.spec.elements).find((item) => item.props.field === key);
                const options =
                  element && Array.isArray(element.props.options)
                    ? (element.props.options as Array<{ value: string; label: string }>)
                    : [];
                const format = (item: unknown) =>
                  typeof item === "boolean"
                    ? item
                      ? "开启"
                      : "关闭"
                    : (options.find((option) => option.value === item)?.label ?? String(item));
                return `${fields.find((field) => field.name === key)?.label ?? key}：${Array.isArray(value) ? value.map(format).join("、") : format(value)}`;
              });
              displayText = `${action.title} · ${action.action.label}${lines.length ? `\n${lines.join("\n")}` : ""}`;
            }
          } catch {
            /* Ordinary user text retains its original display. */
          }
        }
        items.push({
          id: entry.id as number,
          role: "user",
          text: displayText,
          ...(data.replyTo ? { replyTo: cloneJson(data.replyTo) } : {}),
          ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...chatReceiptData(entry.data),
        });
      }
      continue;
    }

    if (AssistantEntry.is(entry)) {
      const msg = entry.model?.[0];
      if (msg && msg.role === "assistant") {
        const native = nativeSearchEvidence(msg);
        pendingSources = sanitizeSearchSources([...pendingSources, ...native.sources]);
        pendingSearchSuggestions = [...new Set([...pendingSearchSuggestions, ...native.searchSuggestions])].slice(-4);
        const textBlocks: string[] = [];
        const thinkingBlocks: string[] = [];
        const toolCalls: NonNullable<ChatDisplayItem["toolCalls"]> = [];

        for (const block of msg.content) {
          if (block.type === "text" && block.text.trim()) {
            textBlocks.push(block.text);
          } else if (block.type === "thinking" && block.thinking.trim()) {
            thinkingBlocks.push(block.thinking);
          } else if (block.type === "toolCall") {
            if (SILENT_UI_TOOLS.has(block.name)) continue;
            const actionMeta = classifyToolAction({
              name: block.name,
              args: block.arguments,
              redactText: redactToolText,
              resolveConnectionLabel: options.resolveConnectionLabel,
            });
            if (BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS.has(block.name)) {
              const call: NonNullable<ChatDisplayItem["toolCalls"]>[number] = {
                id: block.id,
                name: block.name,
                argsSummary: "",
                actionMeta,
              };
              toolCalls.push(call);
              pendingToolCalls.set(call.id, call);
              continue;
            }
            const rawArgs = JSON.stringify(
              options.includeToolResults ? redactCredentialData(block.arguments ?? {}, redactToolText) : (block.arguments ?? {}),
            );
            const summaryValue = options.includeToolResults
              ? ["command", "path", "file_path", "target_path", "query", "url", "action", "summary", "title"]
                  .map((key) => block.arguments?.[key])
                  .find((value): value is string => typeof value === "string" && value.trim().length > 0)
              : undefined;
            const actionSummary =
              summaryValue === undefined
                ? undefined
                : redactToolText(summaryValue).trim().split(/[\r\n]/, 1)[0]!.slice(0, 140);
            const call: NonNullable<ChatDisplayItem["toolCalls"]>[number] = {
              id: block.id,
              name: block.name,
              argsSummary: rawArgs.length > 140 ? `${rawArgs.slice(0, 140)}...` : rawArgs,
              ...(actionSummary ? { actionSummary } : {}),
              actionMeta,
            };
            toolCalls.push(call);
            pendingToolCalls.set(call.id, call);
          }
        }

        const joinedText = textBlocks.join("\n").trim();
        const isSilentAck = isSilentCoordinatorReplyText(joinedText);
        if (isSilentAck && toolCalls.length === 0) {
          continue;
        }
        const visibleText = isSilentAck ? "" : sanitizeMarkdownTrackingLinks(textBlocks.join("\n"));
        const sources = visibleText.trim()
          ? sanitizeSearchSources([...native.sources, ...selectCitedSources(visibleText, pendingSources)])
          : [];

        if (visibleText.trim().length > 0 || toolCalls.length > 0 || thinkingBlocks.length > 0) {
          items.push({
            id: entry.id as number,
            role: "assistant",
            text: visibleText,
            ...(sources.length
              ? {
                  sources,
                  ...(pendingSearchSuggestions.length ? { searchSuggestions: pendingSearchSuggestions } : {}),
                }
              : {}),
            ...(createdAt ? { createdAt } : {}),
            ...(thinkingBlocks.length > 0 ? { thinking: thinkingBlocks.join("\n") } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }
      }
    }
  }

  const { responseIds } = resolveResponseContext(entries);
  return items.map((item) => {
    const responseId = responseIds.get(item.id);
    return responseId === undefined ? item : { ...item, responseId };
  });
}

export function extractLiveState(
  view: ConversationView,
  responseEntries: readonly EntryRecord[] = view.entries,
): LiveStreamState {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
  const lastInput = [...responseEntries].reverse().find(isRecoveryInputBoundary);
  if (lastInput && WorkerRecoveryEntry.is(lastInput)) {
    return {
      busy: Boolean(live?.run),
      activeTools: [],
      queuedCount: Array.isArray(inbox?.items) ? inbox.items.length : 0,
    };
  }

  let rawStreamingText: string | undefined;
  let streamingText: string | undefined;
  let streamingThinking: string | undefined;

  const partialContent = live?.generation?.message?.content;
  if (Array.isArray(partialContent)) {
    const texts: string[] = [];
    const thoughts: string[] = [];
    for (const block of partialContent) {
      if (block && typeof block === "object") {
        if ("type" in block && block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if ("type" in block && block.type === "thinking" && typeof block.thinking === "string") {
          thoughts.push(block.thinking);
        }
      }
    }
    if (texts.length > 0) rawStreamingText = texts.join("");
    if (thoughts.length > 0) streamingThinking = thoughts.join("");
  }

  const activeTools = (live?.tools ?? [])
    .filter((t) => t.status !== "done" && !SILENT_UI_TOOLS.has(t.name))
    .map((t) => ({
      callId: t.callId,
      name: t.name,
      actionMeta: buildLiveToolActionMeta(t.name),
      ...(t.output && !BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS.has(t.name) ? { outputTail: t.output.slice(-400) } : {}),
    }));

  const trimmedStreaming = rawStreamingText?.trim() ?? "";
  if (
    rawStreamingText &&
    !(
      (trimmedStreaming.startsWith("[W") && "[WATCHDOG_OK]".startsWith(trimmedStreaming)) ||
      (trimmedStreaming.startsWith("[C") && "[COORDINATOR_OK]".startsWith(trimmedStreaming)) ||
      (trimmedStreaming.startsWith("[R") && "[RECOVERY_OK]".startsWith(trimmedStreaming))
    )
  ) {
    streamingText = sanitizeMarkdownTrackingLinks(rawStreamingText);
  }

  const { currentResponseId } = resolveResponseContext(responseEntries);
  return {
    busy: Boolean(live?.run),
    ...(live?.run && currentResponseId !== undefined ? { responseId: currentResponseId } : {}),
    ...(streamingText ? { streamingText } : {}),
    ...(streamingThinking ? { streamingThinking } : {}),
    activeTools,
    queuedCount: Array.isArray(inbox?.items) ? inbox.items.length : 0,
    ...(Boolean(live?.run) && live?.generation?.retry
      ? {
          retrying: {
            attempt: live.generation.attempt,
            at: live.generation.retry.at,
          },
        }
      : {}),
    ...(live?.runFailure
      ? {
          runFailure: {
            ...(typeof live.runFailure.taskId === "number" ? { taskId: Number(live.runFailure.taskId) } : {}),
            reason: live.runFailure.reason,
            ...(live.runFailure.detail !== undefined ? { detail: live.runFailure.detail } : {}),
          },
        }
      : {}),
  };
}
