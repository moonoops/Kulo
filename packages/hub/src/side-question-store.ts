import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  defineDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type JsonObject,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  redactDeviceInvitationText,
  redactSecrets,
  redactSensitiveText,
  type SideQuestionRecord,
  type SideQuestionStatus,
} from "@kulo/protocol";
import { abortConversationSafely } from "./conversation-abort.js";
import { redactCredentialData } from "./credential-redaction.js";
import { KuloUserEntry } from "./ui-cards.js";

const FORK_BOUNDARY_PAGE_SIZE = 64;
const FORK_BOUNDARY_MAX_PAGES = 32;
const MAX_RETAINED_CLOSED_RECORDS = 64;
const EXCLUDED_ASSISTANT_STOP_REASONS = new Set(["error", "aborted", "deferred"]);

export interface SideQuestionsDocState {
  /** Active side question ID keyed by parentTopicId (strictly at most 1 active side question per parent topic). */
  activeByTopic: Record<string, string>;
  /** Indexed side-question records (expired entries are pruned from both `activeByTopic` and `records`). */
  records: Record<string, SideQuestionRecord>;
}

/**
 * Independent durable index for Stage 3 P1-1 side questions (`/btw`).
 * Note: `pi-durable` public storage does not expose per-conversation SQLite row deletion,
 * so 24h cleanup is defined honestly as aborting/offlining and removing from `SideQuestionsDoc`
 * while retaining underlying conversation rows under standard storage retention.
 */
export const SideQuestionsDoc = defineDoc<SideQuestionsDocState & JsonObject>({
  kind: "kulo.side_questions",
  version: 1,
  scope: "session",
  initial: () => ({ activeByTopic: {}, records: {} }) as SideQuestionsDocState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export class SideQuestionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SideQuestionError";
  }
}

/**
 * Double-layer redaction (§2.2 anti-`SessionFailed` law) for every free-text field
 * written into `SideQuestionsDoc`. Guarantees `wrapRedactedStorage.commit` sees
 * a fixed-point sanitized value and never triggers `documentLeak() -> SessionFailed`.
 */
export function sanitizeSideQuestionText(
  raw: string | undefined,
  redact: (text: string) => string,
  maxLen: number,
  options: { preserveNewlines?: boolean } = {},
): string {
  const apply = (value: string): string => {
    const once = redactSecrets(value);
    const twice = redact(once);
    const thrice = redactSensitiveText(redactDeviceInvitationText(redactSecrets(twice)));
    return redactCredentialData({ text: thrice }, redact).text;
  };
  let cleaned = apply(raw ?? "");
  cleaned = options.preserveNewlines
    ? cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim()
    : cleaned.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const sliced = cleaned.slice(0, maxLen).trimEnd();
  const verified = apply(sliced);
  if (verified.length <= maxLen) return verified;
  return apply(verified.slice(0, maxLen)).slice(0, maxLen);
}

/**
 * Concise read-only zero-tool system prompt for Phase 1 side questions.
 * Never grants tools, workspace access, memory writes, or main-chat mutations.
 */
export function buildSideQuestionSystemPrompt(quoteSnippet?: string): string {
  const lines = [
    "You are answering an ephemeral, read-only side question (/btw) branched from the parent conversation.",
    "Rules:",
    "- Answer directly and concisely based on the inherited conversation context and any quoted snippet.",
    "- Zero tools are available in this side question. Never claim to execute commands, edit files, call tools, or mutate external state.",
    "- This side thread is isolated and never writes to the main conversation, working memory, or private identity files.",
  ];
  if (quoteSnippet) {
    lines.push("", "Quoted snippet from the parent conversation:", quoteSnippet);
  }
  return lines.join("\n");
}

export interface SafeForkScanState {
  pendingToolResultIds: Set<string>;
  trailingToolResultBoundaryId?: EntryId;
}

/**
 * Pure scanner over descending entries of ONE parent conversation to select the newest
 * complete turn boundary `EntryId`:
 * - Skips unclosed `AssistantEntry(stopReason="toolUse")` and partial/orphaned `ToolResultEntry`.
 * - Skips failed/aborted/deferred assistant entries (`error`, `aborted`, `deferred`).
 * - Never performs arithmetic `id - 1` (global `entries.id` interleaves across conversations)
 *   and never returns `0`.
 */
export function selectSafeForkBoundaryFromDescending(
  entriesDescending: readonly EntryRecord[],
  state: SafeForkScanState = { pendingToolResultIds: new Set() },
): EntryId | undefined {
  for (const entry of entriesDescending) {
    const numericId = Number(entry.id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) {
      continue;
    }

    if (ToolResultEntry.is(entry)) {
      const msg = entry.model?.[0] as { role?: string; toolCallId?: unknown } | undefined;
      if (msg?.role === "toolResult" && typeof msg.toolCallId === "string" && msg.toolCallId.trim()) {
        if (state.trailingToolResultBoundaryId === undefined) {
          state.trailingToolResultBoundaryId = entry.id;
        }
        state.pendingToolResultIds.add(msg.toolCallId);
      }
      continue;
    }

    if (AssistantEntry.is(entry)) {
      const msg = entry.model?.[0] as
        | {
            role?: string;
            stopReason?: string;
            content?: Array<{ type?: string; id?: string }>;
          }
        | undefined;
      if (!msg || msg.role !== "assistant") {
        state.pendingToolResultIds.clear();
        state.trailingToolResultBoundaryId = undefined;
        continue;
      }
      if (msg.stopReason && EXCLUDED_ASSISTANT_STOP_REASONS.has(msg.stopReason)) {
        state.pendingToolResultIds.clear();
        state.trailingToolResultBoundaryId = undefined;
        continue;
      }
      const toolCalls = Array.isArray(msg.content)
        ? msg.content.filter(
            (block): block is { type: "toolCall"; id: string } =>
              Boolean(block && block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0),
          )
        : [];
      if (msg.stopReason === "toolUse" || toolCalls.length > 0) {
        const allClosed =
          toolCalls.length > 0 &&
          state.trailingToolResultBoundaryId !== undefined &&
          toolCalls.every((call) => state.pendingToolResultIds.has(call.id));
        if (allClosed) {
          return state.trailingToolResultBoundaryId;
        }
        // Unclosed toolUse or partial ToolResultEntry: skip this assistant turn and partial results.
        state.pendingToolResultIds.clear();
        state.trailingToolResultBoundaryId = undefined;
        continue;
      }
      state.pendingToolResultIds.clear();
      state.trailingToolResultBoundaryId = undefined;
      return entry.id;
    }

    if (
      UserEntry.is(entry) ||
      KuloUserEntry.is(entry) ||
      CompactionEntry.is(entry) ||
      ResetEntry.is(entry)
    ) {
      state.pendingToolResultIds.clear();
      state.trailingToolResultBoundaryId = undefined;
      return entry.id;
    }
    // Non-model / bookkeeping entries (SystemEntry, ContentPublicationEntry, etc.) are skipped.
  }
  return undefined;
}

/**
 * Queries `parentConv.entries({ order: "descending" }, ...)` to locate the parent
 * conversation's own most recent complete boundary `EntryId`. Returns `undefined`
 * when no complete boundary exists (callers must then create a blank side conversation
 * rather than ever passing `0` to `fork()`).
 */
export async function findSafeForkBoundary(
  parentConv: Pick<Conversation, "entries">,
  context: Context = BACKGROUND_CONTEXT,
): Promise<EntryId | undefined> {
  const state: SafeForkScanState = { pendingToolResultIds: new Set() };
  let cursor: Cursor | undefined;
  for (let pageIndex = 0; pageIndex < FORK_BOUNDARY_MAX_PAGES; pageIndex++) {
    const page = await parentConv.entries(
      { order: "descending" },
      FORK_BOUNDARY_PAGE_SIZE,
      cursor,
      context,
    );
    if (page.items.length === 0) return undefined;
    const found = selectSafeForkBoundaryFromDescending(page.items, state);
    if (found !== undefined) return found;
    if (!page.next) return undefined;
    cursor = page.next;
  }
  return undefined;
}

export function pruneExpiredInDoc(doc: SideQuestionsDocState, now: number): number[] {
  doc.activeByTopic ??= {};
  doc.records ??= {};
  const expiredConvIds: number[] = [];

  for (const [id, rec] of Object.entries(doc.records)) {
    if (!rec) {
      delete doc.records[id];
      continue;
    }
    if (now < rec.expiresAt) continue;
    if (rec.status === "active") {
      expiredConvIds.push(rec.conversationId);
    }
    if (doc.activeByTopic[rec.parentTopicId] === id) {
      delete doc.activeByTopic[rec.parentTopicId];
    }
    delete doc.records[id];
  }

  for (const [topicId, activeId] of Object.entries(doc.activeByTopic)) {
    const rec = doc.records[activeId];
    if (!rec || rec.status !== "active") {
      delete doc.activeByTopic[topicId];
    }
  }
  return expiredConvIds;
}

export function pruneRetainedClosedRecords(doc: SideQuestionsDocState): void {
  const closed = Object.values(doc.records)
    .filter((rec) => rec.status !== "active")
    .sort((a, b) => (a.closedAt ?? a.updatedAt) - (b.closedAt ?? b.updatedAt));
  if (closed.length <= MAX_RETAINED_CLOSED_RECORDS) return;
  const excess = closed.length - MAX_RETAINED_CLOSED_RECORDS;
  for (let i = 0; i < excess; i++) {
    const victim = closed[i]!;
    if (doc.activeByTopic[victim.parentTopicId] === victim.id) {
      delete doc.activeByTopic[victim.parentTopicId];
    }
    delete doc.records[victim.id];
  }
}

/**
 * Transaction helper invoked atomically inside topic archive / rotation / deletion commits
 * to offline all active side questions associated with a parent topic or parent conversation.
 * Returns the side-question conversation IDs that must be aborted post-commit.
 */
export async function offlineSideQuestionsInTx(
  tx: Tx,
  params: {
    topicId?: string;
    conversationId?: number;
    status?: Extract<SideQuestionStatus, "closed" | "interrupted">;
    reason: string;
    now: number;
    redact: (text: string) => string;
  },
): Promise<number[]> {
  const doc = await tx.doc(SideQuestionsDoc);
  doc.activeByTopic ??= {};
  doc.records ??= {};
  const nextStatus = params.status ?? "closed";
  const safeReason = sanitizeSideQuestionText(params.reason, params.redact, 120);
  const toAbort: number[] = [];

  for (const rec of Object.values(doc.records)) {
    if (rec.status !== "active") continue;
    const matchesTopic = params.topicId !== undefined && rec.parentTopicId === params.topicId;
    const matchesConv = params.conversationId !== undefined && rec.parentConversationId === params.conversationId;
    if (!matchesTopic && !matchesConv) continue;
    rec.status = nextStatus;
    rec.closedAt = params.now;
    rec.updatedAt = params.now;
    rec.closedReason = safeReason;
    if (doc.activeByTopic[rec.parentTopicId] === rec.id) {
      delete doc.activeByTopic[rec.parentTopicId];
    }
    toAbort.push(rec.conversationId);
  }

  if (params.topicId !== undefined && doc.activeByTopic[params.topicId]) {
    const activeId = doc.activeByTopic[params.topicId]!;
    const activeRec = doc.records[activeId];
    if (!activeRec || activeRec.status !== "active") {
      delete doc.activeByTopic[params.topicId];
    }
  }
  pruneRetainedClosedRecords(doc);
  return toAbort;
}

/** Safely aborts every side-question conversation in `conversationIds` post-commit. */
export async function abortSideQuestionConversations(
  harness: Harness,
  conversationIds: readonly number[],
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  const unique = [...new Set(conversationIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (const convId of unique) {
    try {
      const conv = await harness.conversation(convId as ConversationId, context);
      if (conv) {
        await abortConversationSafely(harness, conv, context);
      }
    } catch (error) {
      console.warn("[KuloSideQuestions] Failed to abort side-question conversation", convId, error);
    }
  }
}
