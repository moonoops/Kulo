import { AssistantEntry, ToolResultEntry, UserEntry, type Conversation, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ChatDisplayItem } from "@kulo/protocol";
import { nativeSearchEvidence, sanitizeSearchSources } from "./search-sources.js";
import { isRecoveryInputBoundary } from "./state.js";

function boundary(entry: EntryRecord): boolean { return UserEntry.is(entry) || entry.kind === "kulo.user"; }

function evidence(entry: EntryRecord): EntryRecord | undefined {
  if (isRecoveryInputBoundary(entry)) {
    const data = entry.kind === "kulo.worker_relay" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? { sources: sanitizeSearchSources(entry.data.sources), ...(Array.isArray(entry.data.searchSuggestions) ? { searchSuggestions: entry.data.searchSuggestions.filter((value) => typeof value === "string" && value.length <= 24_000).slice(-4) } : {}) }
      : undefined;
    return { id: entry.id, conversationId: entry.conversationId, kind: entry.kind, model: [{ role: "user", content: "", timestamp: 0 }], ...(data ? { data } : {}) };
  }
  if (AssistantEntry.is(entry)) {
    const message = entry.model?.[0];
    const native = nativeSearchEvidence(message);
    if (message?.role !== "assistant") return undefined;
    const content = message.content.flatMap((part) => part.type === "toolCall" ? [{ type: "toolCall" as const, id: part.id, name: part.name, arguments: {} }] : []);
    return { id: entry.id, conversationId: entry.conversationId, kind: entry.kind, model: [{ role: "assistant", content,
      api: message.api, provider: message.provider, model: message.model, usage: message.usage,
      stopReason: message.stopReason, timestamp: 0, kuloSearchSources: native.sources, kuloSearchSuggestions: native.searchSuggestions } as typeof message] };
  }
  if (!ToolResultEntry.is(entry)) return undefined;
  const message = entry.model?.[0];
  if (message?.role !== "toolResult" || message.isError || !["web_search", "web_fetch"].includes(message.toolName)) return undefined;
  const details = message.details as { sources?: unknown; searchSuggestions?: unknown } | undefined;
  return { ...entry, model: [{ ...message, content: [], details: {
    sources: sanitizeSearchSources(details?.sources),
    ...(typeof details?.searchSuggestions === "string" && details.searchSuggestions.length <= 24_000 ? { searchSuggestions: details.searchSuggestions } : {}),
  } }] };
}

/** Search evidence spans a user turn; retain other input boundaries inside it for response ownership. */
export async function loadSearchEvidencePrefix(conversation: Pick<Conversation, "entries">, first: EntryRecord, context: Context): Promise<EntryRecord[]> {
  if (boundary(first) || Number(first.id) <= 1) return [];
  const query = { maxEntryId: (Number(first.id) - 1) as EntryId };
  let page = await conversation.entries(query, 120, undefined, context);
  const prefix: EntryRecord[] = [];
  for (;;) {
    context.abortSignal?.throwIfAborted();
    for (const entry of page.items) {
      const compact = evidence(entry);
      if (compact) prefix.push(compact);
      if (boundary(entry)) return prefix.reverse();
    }
    if (!page.next) return prefix.reverse();
    page = await conversation.entries(query, 120, page.next, context);
  }
}

/** Retain source events across live window trimming, without retaining tool output or private user text. */
export class SearchEvidenceHistory {
  readonly #events = new Map<number, EntryRecord>();
  remember(entries: readonly EntryRecord[]): void {
    for (const entry of entries) {
      const compact = evidence(entry);
      if (compact) this.#events.set(Number(entry.id), compact);
    }
  }
  projectionEntries(entries: readonly EntryRecord[]): readonly EntryRecord[] {
    if (!entries.length) return [];
    this.remember(entries);
    const first = Number(entries[0]!.id);
    const prior = [...this.#events.values()].filter((entry) => Number(entry.id) < first).sort((a, b) => Number(a.id) - Number(b.id));
    const start = prior.findLastIndex(boundary);
    const prefix = start >= 0 ? prior.slice(start) : prior;
    if (start >= 0) for (const id of this.#events.keys()) if (id < Number(prior[start]!.id)) this.#events.delete(id);
    return [...prefix, ...entries];
  }
  project(entries: readonly EntryRecord[], project: (entries: readonly EntryRecord[]) => ChatDisplayItem[]): ChatDisplayItem[] {
    const visible = new Set(entries.map((entry) => Number(entry.id)));
    return project(this.projectionEntries(entries)).filter((item) => visible.has(item.id));
  }
}
