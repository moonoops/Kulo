/**
 * Pure stateless transcript packing & 5-gate extraction verification for `memory-flush.ts`.
 */
import {
  AssistantEntry,
  CompactionEntry,
  SystemEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { isSilentCoordinatorReplyText, redactSensitiveText } from "@kulo/protocol";
import {
  MEMORY_TOOL_ECHO_SKIP_NAMES,
  MemoryContextEntry,
  MemoryContextRevocationEntry,
} from "./builtin-memory-entries.js";
import { isSafeMemoryText } from "./hindsight.js";
import { matchesForgottenTerm } from "./memory-forget.js";
import { isContextSyncEntry } from "./recent-work-sync.js";
import {
  CoordinatorEventEntry,
  MediaRelayEntry,
  WorkerRecoveryEntry,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
  isLegacyInternalUserEntry,
} from "./state.js";
import { ContentPublicationEntry, KuloUserEntry } from "./ui-cards.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";
import {
  bucketIdForScope,
  computeMemoryFingerprint,
  formatLocalDate,
  isSuspiciousMemoryInstruction,
  normalizeMemorySummary,
  type WorkingMemoryCategory,
  type WorkingMemoryEvidenceLevel,
  type WorkingMemoryRecord,
} from "./working-memory.js";

export type FlushedSourceRole = "user" | "assistant" | "tool_result";

export interface ScannedBatchItem {
  entryId: number;
  role: FlushedSourceRole;
  text: string;
  timestamp: number;
  charOffset: number;
  isPartial: boolean;
}

export function isCursorAhead(nextId: number, nextOff: number, curId: number, curOff: number): boolean {
  if (nextId !== curId) return nextId > curId;
  return (nextOff > 0 ? nextOff : Number.POSITIVE_INFINITY) > (curOff > 0 ? curOff : Number.POSITIVE_INFINITY);
}

export function extractEntryTextAndRole(
  entry: EntryRecord,
  redact: (text: string) => string,
): { role: FlushedSourceRole; text: string; timestamp: number } | undefined {
  if (
    SystemEntry.is(entry) ||
    CompactionEntry.is(entry) ||
    isContextSyncEntry(entry) ||
    MediaRelayEntry.is(entry) ||
    WorkerRelayEntry.is(entry) ||
    WorkerWatchdogEntry.is(entry) ||
    WorkerRecoveryEntry.is(entry) ||
    isLegacyInternalUserEntry(entry) ||
    entry.kind === MemoryContextEntry.kind ||
    entry.kind === MemoryContextRevocationEntry.kind
  ) {
    return undefined;
  }

  if (CoordinatorEventEntry.is(entry)) {
    if (entry.data.eventKind !== "user_task_instruction") return undefined;
    const manual = typeof entry.data.manualText === "string" ? entry.data.manualText.trim() : "";
    if (!manual) return undefined;
    const safe = redact(redactSensitiveText(manual)).trim();
    if (!safe) return undefined;
    return { role: "user", text: safe, timestamp: entry.data.createdAt || Date.now() };
  }

  let role: FlushedSourceRole | undefined;
  const parts: string[] = [];
  let timestamp = 0;

  if (entry.kind === VoiceTranscriptEntry.kind && entry.data && typeof entry.data === "object") {
    const data = entry.data as { role?: unknown; text?: unknown; createdAt?: unknown };
    if (typeof data.text === "string" && data.text.trim()) {
      role = data.role === "assistant" ? "assistant" : "user";
      parts.push(data.text);
      if (typeof data.createdAt === "number") timestamp = data.createdAt;
    }
  } else if (entry.kind === ContentPublicationEntry.kind && entry.data && typeof entry.data === "object") {
    const data = entry.data as { parts?: Array<{ text?: unknown }>; fallbackText?: unknown; createdAt?: unknown };
    role = "assistant";
    if (Array.isArray(data.parts)) {
      for (const p of data.parts) {
        if (typeof p?.text === "string" && p.text.trim()) parts.push(p.text);
      }
    } else if (typeof data.fallbackText === "string" && data.fallbackText.trim()) {
      parts.push(data.fallbackText);
    }
    if (typeof data.createdAt === "number") timestamp = data.createdAt;
  } else if (entry.kind === KuloUserEntry.kind && entry.data && typeof entry.data === "object") {
    const data = entry.data as { text?: unknown };
    if (typeof data.text === "string" && data.text.trim()) {
      role = "user";
      parts.push(data.text);
    }
  }

  if (parts.length === 0 && Array.isArray(entry.model)) {
    for (const msg of entry.model) {
      if (typeof msg.timestamp === "number" && msg.timestamp > timestamp) timestamp = msg.timestamp;
      if (msg.role === "user") {
        role ??= "user";
        if (typeof msg.content === "string") {
          parts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) parts.push(block.text);
          }
        }
      } else if (msg.role === "assistant") {
        role ??= "assistant";
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push(block.text);
        }
      } else if (msg.role === "toolResult") {
        if (MEMORY_TOOL_ECHO_SKIP_NAMES.has(msg.toolName)) continue;
        role ??= "tool_result";
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push(`[tool:${msg.toolName}] ${block.text}`);
        }
      }
    }
  }

  if (!role) {
    if (UserEntry.is(entry)) role = "user";
    else if (AssistantEntry.is(entry)) role = "assistant";
    else if (ToolResultEntry.is(entry)) role = "tool_result";
    else return undefined;
  }

  const raw = parts.join("\n").trim();
  if (!raw) return undefined;
  if (role === "assistant" && isSilentCoordinatorReplyText(raw)) return undefined;
  const safe = redact(redactSensitiveText(raw)).trim();
  if (!safe) return undefined;
  return { role, text: safe, timestamp: timestamp || Date.now() };
}

/**
 * Packs a contiguous slice of entries strictly within `budgetChars` (`24,000` default)
 * with zero head/tail sampling; oversized single entries continue via `charOffset`.
 */
export function buildContinuousFlushBatch(
  entries: readonly EntryRecord[],
  startEntryId: number,
  startCharOffset: number,
  budgetChars: number,
  redact: (text: string) => string,
): {
  items: ScannedBatchItem[];
  nextLastFlushedEntryId: number;
  nextLastFlushedCharOffset: number;
  hasMoreInSlice: boolean;
} {
  const items: ScannedBatchItem[] = [];
  let usedChars = 0;
  let nextEntryId = Math.max(0, startEntryId - 1);
  let nextCharOffset = 0;
  let hasMoreInSlice = false;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const entryId = Number(entry.id);
    if (entryId < startEntryId) continue;

    const extracted = extractEntryTextAndRole(entry, redact);
    if (!extracted) {
      if (items.length === 0 || usedChars < budgetChars) {
        nextEntryId = entryId;
        nextCharOffset = 0;
      }
      continue;
    }

    const offset = entryId === startEntryId ? Math.max(0, startCharOffset) : 0;
    const remainingText = offset > 0 ? extracted.text.slice(offset) : extracted.text;
    if (!remainingText) {
      nextEntryId = entryId;
      nextCharOffset = 0;
      continue;
    }

    const overhead = 40;
    const available = budgetChars - usedChars - overhead;
    if (available <= 0 && items.length > 0) {
      hasMoreInSlice = true;
      break;
    }

    if (remainingText.length <= Math.max(256, available)) {
      items.push({
        entryId,
        role: extracted.role,
        text: remainingText,
        timestamp: extracted.timestamp,
        charOffset: offset,
        isPartial: false,
      });
      usedChars += remainingText.length + overhead;
      nextEntryId = entryId;
      nextCharOffset = 0;
    } else {
      if (items.length > 0) {
        hasMoreInSlice = true;
        break;
      }
      const take = Math.max(256, budgetChars - overhead);
      const chunk = remainingText.slice(0, take);
      items.push({
        entryId,
        role: extracted.role,
        text: chunk,
        timestamp: extracted.timestamp,
        charOffset: offset,
        isPartial: true,
      });
      nextEntryId = entryId;
      nextCharOffset = offset + chunk.length;
      hasMoreInSlice = true;
      break;
    }
  }

  return {
    items,
    nextLastFlushedEntryId: nextEntryId,
    nextLastFlushedCharOffset: nextCharOffset,
    hasMoreInSlice,
  };
}

interface RawExtractedItem {
  category?: unknown;
  summary?: unknown;
  anchorEntryId?: unknown;
  scope?: unknown;
  status?: unknown;
  supersedesId?: unknown;
}

export type FlushExtractionParseResult =
  | { ok: true; records: WorkingMemoryRecord[] }
  | { ok: false; reason: "invalid_json" | "missing_items_array" };

/**
 * Parses LLM JSON output and applies the 5 host security gates, distinguishing valid
 * empty responses (`{"items":[]}`) from malformed/truncated JSON (retryable without
 * advancing the cursor).
 */
export function parseFlushExtraction(options: {
  rawJson: string;
  batch: readonly ScannedBatchItem[];
  conversationId: number;
  topicId: string;
  projectId?: string;
  redact: (text: string) => string;
  forgottenTerms?: readonly { term: string }[];
  now?: number;
}): FlushExtractionParseResult {
  const cleaned = options.rawJson.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) {
    return { ok: false, reason: "missing_items_array" };
  }
  const rawItems = (parsed as { items: RawExtractedItem[] }).items;
  if (rawItems.length === 0) return { ok: true, records: [] };

  const batchByEntryId = new Map<number, ScannedBatchItem>();
  for (const item of options.batch) {
    if (!batchByEntryId.has(item.entryId)) batchByEntryId.set(item.entryId, item);
  }

  const now = options.now ?? Date.now();
  const forgotten = options.forgottenTerms ?? [];
  const verified: WorkingMemoryRecord[] = [];

  for (let idx = 0; idx < Math.min(rawItems.length, 24); idx += 1) {
    const raw = rawItems[idx];
    if (!raw || typeof raw !== "object") continue;

    const anchorEntryId = Number(raw.anchorEntryId);
    if (!Number.isSafeInteger(anchorEntryId) || anchorEntryId <= 0) continue;
    const anchor = batchByEntryId.get(anchorEntryId);
    if (!anchor) continue;

    if (typeof raw.summary !== "string") continue;
    const normalized = normalizeMemorySummary(raw.summary);
    if (!normalized || normalized.length < 4) continue;
    const redacted = options.redact(redactSensitiveText(normalized));
    if (redacted !== normalized) continue;
    if (!isSafeMemoryText(normalized)) continue;
    if (isSuspiciousMemoryInstruction(normalized)) continue;
    if (forgotten.some((entry) => matchesForgottenTerm(normalized, entry.term))) continue;

    let evidenceLevel: WorkingMemoryEvidenceLevel;
    let category: WorkingMemoryCategory =
      raw.category === "commitment" || raw.category === "decision" || raw.category === "fact"
        ? raw.category
        : "fact";

    if (anchor.role === "user") {
      evidenceLevel = "user_decision";
    } else if (anchor.role === "assistant") {
      evidenceLevel = "assistant_proposal";
      if (category === "commitment") category = "decision";
    } else {
      evidenceLevel = "external_reference";
      category = "fact";
    }

    const status = raw.status === "resolved" ? "resolved" : "active";
    const supersedesId =
      typeof raw.supersedesId === "string" && raw.supersedesId.trim().length > 0 && raw.supersedesId.length <= 120
        ? raw.supersedesId.trim()
        : undefined;

    const requestedGlobal = raw.scope === "global" && evidenceLevel === "user_decision";
    const bucketId = requestedGlobal
      ? bucketIdForScope({ kind: "global" })
      : options.projectId
        ? bucketIdForScope({ kind: "project", projectId: options.projectId })
        : bucketIdForScope({ kind: "topic", topicId: options.topicId });

    const fingerprint = computeMemoryFingerprint(category, normalized);
    verified.push({
      id: `flush:${options.conversationId}:${anchorEntryId}:${fingerprint.slice(0, 10)}`,
      bucketId,
      category,
      evidenceLevel,
      status,
      ...(supersedesId ? { supersedesId } : {}),
      date: formatLocalDate(anchor.timestamp || now),
      summary: normalized,
      fingerprint,
      provenance: {
        conversationId: options.conversationId,
        topicId: options.topicId,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        entryId: anchorEntryId,
        sourceRole: anchor.role,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  return { ok: true, records: verified };
}

export function verifyFlushExtraction(options: Parameters<typeof parseFlushExtraction>[0]): WorkingMemoryRecord[] {
  const parsed = parseFlushExtraction(options);
  return parsed.ok ? parsed.records : [];
}
