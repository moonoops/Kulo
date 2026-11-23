/**
 * Shared durable entry tokens, predicates, and formatting helpers for Kulo memory context.
 * Pure leaf module (zero dependency on `memory-lifecycle.ts`, `builtin-memory-service.ts`, or `hub.ts`).
 */
import { defineEntry, type JsonObject } from "@earendil-works/pi-durable";
import type { TicketRecord } from "@kulo/protocol";
import type { BuiltinMemoryRecallHit } from "./builtin-memory-query.js";

export const MEMORY_CONTEXT_PREFIX = "[KULO_MEMORY_CONTEXT ";

export interface MemoryContextEntryData {
  sourceId: string;
  text: string;
  engine?: "builtin" | "hindsight";
  clearEpoch?: number;
  memoryIds?: string[];
  targetEntryId?: number;
}

export interface MemoryContextRevocationData {
  reason: string;
  targetEntryId: number;
  revokedSourceIds: string[];
}

export const MemoryContextEntry = defineEntry<MemoryContextEntryData & JsonObject>("kulo.memory-context");

export const MemoryContextRevocationEntry = defineEntry<MemoryContextRevocationData & JsonObject>("kulo.memory-context-revocation");

export const BUILTIN_MEMORY_TOOL_NAMES = ["kulo_memory_recall", "kulo_memory_retain"] as const;

export type BuiltinMemoryToolName = (typeof BUILTIN_MEMORY_TOOL_NAMES)[number];

/** Built-in memory tools whose arguments and output body must never be shown verbatim in UI summaries. */
export const BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS: ReadonlySet<string> = new Set(BUILTIN_MEMORY_TOOL_NAMES);

/** Memory tool results skipped by conversation history indexing and flush re-extraction to prevent echo loops. */
export const MEMORY_TOOL_ECHO_SKIP_NAMES: ReadonlySet<string> = new Set([
  "kulo_memory_recall",
  "kulo_memory_retain",
  "hindsight_recall",
  "hindsight_retain",
]);

export function isMemoryContextMessageText(text: string): boolean {
  return text.startsWith(MEMORY_CONTEXT_PREFIX);
}

export function extractMemoryContextSourceId(text: string): string | undefined {
  if (!text.startsWith(MEMORY_CONTEXT_PREFIX)) return undefined;
  const end = text.indexOf("]");
  if (end <= MEMORY_CONTEXT_PREFIX.length) return undefined;
  return text.slice(MEMORY_CONTEXT_PREFIX.length, end).trim() || undefined;
}

export function formatBuiltinRecallBlock(options: {
  sourceId: string;
  header: string;
  hits: readonly BuiltinMemoryRecallHit[];
  redact: (text: string) => string;
  maxItemChars?: number;
  maxTotalChars?: number;
}): string {
  const maxItemChars = options.maxItemChars ?? 280;
  const maxTotalChars = options.maxTotalChars ?? 1_200;
  const lines: string[] = [];
  let total = 0;
  for (const hit of options.hits) {
    const clean = options.redact(hit.content).replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const body = clean.length > maxItemChars ? `${clean.slice(0, maxItemChars - 1).trimEnd()}…` : clean;
    const date = new Date(hit.updatedAt || hit.createdAt).toISOString().slice(0, 10);
    const line = `- [${date}] ${body}`;
    const sep = lines.length > 0 ? 1 : 0;
    if (total + sep + line.length > maxTotalChars) {
      if (lines.length === 0) lines.push(`${line.slice(0, maxTotalChars - 1).trimEnd()}…`);
      break;
    }
    lines.push(line);
    total += sep + line.length;
  }
  if (lines.length === 0) return "";
  return `${MEMORY_CONTEXT_PREFIX}${options.sourceId}]\n${options.header}\n${lines.join("\n")}`;
}

const RECALL_MAX_ITEMS = 6;
const RECALL_ITEM_MAX_CHARS = 480;
const RECALL_TOTAL_MAX_CHARS = 2_400;
const RECALL_QUERY_MAX_CHARS = 1_200;
const WILDCARD_SCOPE_RE = /^[\s.*\/\\-]+$/;

export interface RecallPayloadItem {
  text?: unknown;
  occurred_start?: unknown;
}

export function buildTicketRecallQuery(
  ticket: Pick<TicketRecord, "title" | "goal" | "scope">,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [ticket.title, ticket.goal, ticket.scope]) {
    const clean = raw?.replace(/\s+/g, " ").trim();
    if (!clean || WILDCARD_SCOPE_RE.test(clean)) continue;
    const key = clean.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(clean);
  }
  return (parts.join(" — ") || ticket.title.trim() || "project context").slice(0, RECALL_QUERY_MAX_CHARS);
}

export function parseRecallPayload(raw: string): {
  results?: RecallPayloadItem[];
  code?: string;
  parseError?: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { code: "INVALID_JSON", parseError: true };
    }
    const record = parsed as { results?: unknown; code?: unknown };
    return {
      ...(Array.isArray(record.results) ? { results: record.results as RecallPayloadItem[] } : {}),
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    };
  } catch {
    return { code: "INVALID_JSON", parseError: true };
  }
}

export function formatRecalledMemoryItems(results: ReadonlyArray<RecallPayloadItem> | undefined): string {
  if (!Array.isArray(results) || results.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  let totalChars = 0;
  for (const item of results) {
    if (lines.length >= RECALL_MAX_ITEMS) break;
    if (!item || typeof item !== "object" || typeof item.text !== "string") continue;
    const normalized = item.text.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const dedupKey = normalized.toLocaleLowerCase("en-US");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const body =
      normalized.length > RECALL_ITEM_MAX_CHARS
        ? `${normalized.slice(0, RECALL_ITEM_MAX_CHARS - 1).trimEnd()}…`
        : normalized;
    const dateMatch =
      typeof item.occurred_start === "string"
        ? item.occurred_start.trim().match(/^(\d{4}-\d{2}-\d{2})/)
        : null;
    const line = dateMatch ? `- [${dateMatch[1]}] ${body}` : `- ${body}`;
    const sep = lines.length > 0 ? 1 : 0;
    if (totalChars + sep + line.length > RECALL_TOTAL_MAX_CHARS) {
      if (lines.length === 0) {
        lines.push(`${line.slice(0, RECALL_TOTAL_MAX_CHARS - 1).trimEnd()}…`);
      }
      break;
    }
    lines.push(line);
    totalChars += sep + line.length;
  }
  return lines.join("\n");
}
