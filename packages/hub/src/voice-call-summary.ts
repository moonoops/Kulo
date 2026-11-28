import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineEntry,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { redactSecrets, type VoiceCallEvent, type VoiceCallTranscriptTurn } from "@kulo/protocol";
import { KuloStateDoc, summarizeTopicPreview, type KuloDurableState } from "./state.js";
import type { VoiceCallSummaryInput } from "./voice-calls.js";
import { VoiceTranscriptEntry, type VoiceTranscriptData } from "./voice-transcripts.js";

export interface VoiceCallSummaryData {
  callId: string;
  durationMs: number;
  turnCount: number;
  delegatedTicketIds: string[];
  startedAt: number;
  endedAt: number;
}

/** Display-only voice call summary card entry. Never supplies `model` messages to `ContextView`. */
export const VoiceCallSummaryEntry = defineEntry<VoiceCallSummaryData & JsonObject>("kulo.voice.summary");

const MAX_CALL_ID_LENGTH = 240;
const MAX_TICKET_ID_LENGTH = 160;
const MAX_DELEGATED_TICKETS = 64;
const MAX_TRANSCRIPT_SCAN_ENTRIES = 4_000;

function sanitizeSummaryIdentifier(
  value: string,
  redact: (text: string) => string,
  maxLength: number,
): string {
  return redact(redactSecrets(value))
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clampNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function buildVoiceCallSummaryData(
  input: {
    callId: string;
    durationMs: number;
    turnCount: number;
    delegatedTicketIds?: readonly string[];
    startedAt: number;
    endedAt: number;
  },
  redact: (text: string) => string,
): VoiceCallSummaryData {
  const safeCallId = sanitizeSummaryIdentifier(input.callId, redact, MAX_CALL_ID_LENGTH) || "voice_call";
  const seen = new Set<string>();
  const delegatedTicketIds: string[] = [];
  for (const rawId of input.delegatedTicketIds ?? []) {
    if (typeof rawId !== "string") continue;
    const safeId = sanitizeSummaryIdentifier(rawId, redact, MAX_TICKET_ID_LENGTH);
    if (!safeId || seen.has(safeId)) continue;
    seen.add(safeId);
    delegatedTicketIds.push(safeId);
    if (delegatedTicketIds.length >= MAX_DELEGATED_TICKETS) break;
  }
  const startedAt = clampNonNegativeInt(input.startedAt);
  const endedAt = Math.max(startedAt, clampNonNegativeInt(input.endedAt));
  return {
    callId: safeCallId,
    durationMs: clampNonNegativeInt(input.durationMs),
    turnCount: clampNonNegativeInt(input.turnCount),
    delegatedTicketIds,
    startedAt,
    endedAt,
  };
}

export function formatVoiceCallDurationZh(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(clampNonNegativeInt(durationMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  }
  return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

export function formatVoiceCallSummaryText(
  summary: Pick<VoiceCallSummaryData, "durationMs" | "turnCount" | "delegatedTicketIds">,
): string {
  const parts = [
    "语音通话",
    formatVoiceCallDurationZh(summary.durationMs),
    `${clampNonNegativeInt(summary.turnCount)} 句交流`,
  ];
  if (summary.delegatedTicketIds.length > 0) {
    parts.push(`${summary.delegatedTicketIds.length} 项任务`);
  }
  return parts.join(" · ");
}

export function collectCallDelegatedTicketIds(
  state: Readonly<KuloDurableState> | undefined,
  conversationId: number,
  startedAt: number,
  observedTicketIds: readonly string[],
  hadDelegations: boolean,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of observedTicketIds) add(id);
  if (hadDelegations && state?.tickets) {
    const candidates = Object.values(state.tickets)
      .filter((ticket) => ticket.originConversationId === conversationId && ticket.createdAt >= startedAt)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const ticket of candidates) add(ticket.id);
  }
  return ids;
}

export interface ResolvedVoiceConversation {
  conversation: Conversation;
  conversationId: number;
  topicId: string;
  archived: boolean;
}

/**
 * Resolves a voice call's immutable `conversationId` directly without re-resolving mutable
 * `"root"`, verifying the owning topic still exists and has no `deletedAt` tombstone.
 */
export async function resolveBoundVoiceConversation(
  harness: Harness,
  conversationId: number,
  allowArchived: boolean,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ResolvedVoiceConversation | undefined> {
  const state = await harness.snapshot(KuloStateDoc, context);
  const mappedId = state?.conversationToTopic?.[String(conversationId)];
  const topic = (mappedId ? state?.topics?.[mappedId] : undefined)
    ?? Object.values(state?.topics ?? {}).find((item) => item.conversationId === conversationId);
  if (!topic || topic.deletedAt) return undefined;
  if (!allowArchived && topic.archived) return undefined;
  const conversation = await harness.conversation(conversationId as ConversationId, context);
  if (!conversation) return undefined;
  return { conversation, conversationId, topicId: topic.id, archived: Boolean(topic.archived) };
}

export async function persistVoiceTranscript(
  deps: {
    target: ResolvedVoiceConversation;
    event: Extract<VoiceCallEvent, { type: "transcript" }>;
    callId: string;
    processUserText: (text: string) => Promise<string>;
    redact: (text: string) => string;
    refreshConversation: (conversationId: number) => void;
    recordTopicActivity: (topicId: string, preview: { preview: string; at?: number }, conversationId: number) => void;
  },
  context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
  const { target, event, callId } = deps;
  const processed = event.role === "user"
    ? await deps.processUserText(event.text)
    : deps.redact(event.text);
  const text = deps.redact(redactSecrets(processed)).trim();
  if (!text) return false;
  const createdAt = Date.now();
  const entryData: VoiceTranscriptData = {
    callId: deps.redact(redactSecrets(callId)),
    role: event.role,
    text,
    createdAt,
    ...(event.id ? { itemId: event.id } : {}),
    ...(event.incomplete ? { incomplete: true } : {}),
  };
  await target.conversation.submit(
    {
      type: "write",
      entry: {
        kind: VoiceTranscriptEntry.kind,
        data: entryData as VoiceTranscriptData & JsonObject,
        model: [
          {
            role: "user",
            content: `[KULO_VOICE_CONTEXT: ${event.role === "user" ? "用户" : "Kulo"}在通话中说]\n${text}`,
            timestamp: createdAt,
          },
        ],
      },
      ...(event.id ? { requestId: `voice-transcript:${callId}:${event.role}:${event.id}` } : {}),
    },
    context,
  );
  deps.refreshConversation(target.conversationId);
  const preview = summarizeTopicPreview([{ role: event.role, text, createdAt }]);
  if (preview && !target.archived) deps.recordTopicActivity(target.topicId, preview, target.conversationId);
  return true;
}

export async function writeVoiceCallSummaryEntry(
  conversation: Conversation,
  data: VoiceCallSummaryData,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  await conversation.submit(
    {
      type: "write",
      entry: {
        kind: VoiceCallSummaryEntry.kind,
        data: data as VoiceCallSummaryData & JsonObject,
      },
      requestId: `voice-summary:${data.callId}`,
    },
    context,
  );
}

export async function persistVoiceCallSummary(
  deps: {
    harness: Harness;
    target: ResolvedVoiceConversation;
    input: VoiceCallSummaryInput;
    redact: (text: string) => string;
    refreshConversation: (conversationId: number) => void;
  },
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  const state = await deps.harness.snapshot(KuloStateDoc, context);
  const delegatedTicketIds = collectCallDelegatedTicketIds(
    state,
    deps.target.conversationId,
    deps.input.startedAt,
    deps.input.delegatedTicketIds,
    deps.input.hadDelegations,
  );
  const data = buildVoiceCallSummaryData(
    {
      callId: deps.input.callId,
      durationMs: deps.input.durationMs,
      turnCount: deps.input.turnCount,
      delegatedTicketIds,
      startedAt: deps.input.startedAt,
      endedAt: deps.input.endedAt,
    },
    deps.redact,
  );
  await writeVoiceCallSummaryEntry(deps.target.conversation, data, context);
  deps.refreshConversation(deps.target.conversationId);
}

export async function readVoiceCallTranscriptTurns(
  conversation: Conversation,
  callId: string,
  redact: (text: string) => string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<VoiceCallTranscriptTurn[]> {
  const cleanCallId = callId.trim();
  if (!cleanCallId) return [];
  const turns: VoiceCallTranscriptTurn[] = [];
  let cursor: Cursor | undefined;
  let scanned = 0;
  do {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) {
      if (!VoiceTranscriptEntry.is(entry) || entry.data.callId !== cleanCallId) continue;
      const safeText = redact(redactSecrets(String(entry.data.text ?? ""))).trim();
      if (!safeText) continue;
      turns.push({
        ...(typeof entry.data.itemId === "string" && entry.data.itemId ? { id: entry.data.itemId } : {}),
        role: entry.data.role === "assistant" ? "assistant" : "user",
        text: safeText,
        ...(typeof entry.data.createdAt === "number" && Number.isFinite(entry.data.createdAt)
          ? { createdAt: entry.data.createdAt }
          : {}),
        ...(entry.data.incomplete === true ? { incomplete: true } : {}),
      });
    }
    scanned += page.items.length;
    cursor = page.next;
  } while (cursor && scanned < MAX_TRANSCRIPT_SCAN_ENTRIES);
  return turns;
}
