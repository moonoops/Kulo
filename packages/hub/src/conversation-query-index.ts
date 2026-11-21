import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry, UserEntry, type Conversation, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { getMessageParts, messagePartFallback, type ChatDisplayItem, type TopicSummary } from "@kulo/protocol";
import { isRecoveryInputBoundary, WorkerRecoveryEntry } from "./state.js";
import { ContentPublicationEntry, KuloUserEntry } from "./ui-cards.js";
import { parseUserEntryContent } from "./uploads.js";

export const CONVERSATION_QUERY_PAGE_SIZE = 200;
const FILTER_WORDS = 1024;
const BIT_MASK = FILTER_WORDS * 32 - 1;

export type VisibleMessage = ChatDisplayItem & { role: "user" | "assistant" | "dispatch" };
export function isVisibleMessage(item: ChatDisplayItem): item is VisibleMessage {
  if (item.role === "user") return !item.text.startsWith("[KULO_WORKER_RELAY]") && !item.text.startsWith("[KULO_WORKER_WATCHDOG]");
  if (item.role === "assistant") return Boolean(item.text || item.parts?.length || item.attachments?.length);
  return item.role === "dispatch";
}

export const foldQueryText = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
export function messageText(item: VisibleMessage): string {
  const text = getMessageParts(item).map((part) => part.type === "code" ? part.code : "assetId" in part ? [part.fallbackText, part.caption, part.asset?.name].filter(Boolean).join("\n") : messagePartFallback(part));
  return [...new Set([item.text, ...text].filter(Boolean))].join("\n");
}

// One-, two- and three-code-unit substrings also cover short Chinese queries and arbitrary emoji.
// A collision adds a source page to inspect. Only a fresh projection may produce a result.
function visitGrams(text: string, minimum: number, visit: (bit: number) => void): void {
  for (let start = 0; start < text.length; start++) {
    let hash = 2166136261;
    for (let offset = 0; offset < 3 && start + offset < text.length; offset++) {
      hash = Math.imul(hash ^ text.charCodeAt(start + offset), 16777619);
      if (offset + 1 >= minimum) visit((hash ^ (hash >>> 16)) & BIT_MASK);
    }
  }
}

export function queryFingerprint(folded: string): number[] {
  const bits = new Set<number>();
  visitGrams(folded, Math.min(3, folded.length), (bit) => bits.add(bit));
  return [...bits];
}

function pageFingerprint(messages: VisibleMessage[]): Uint32Array {
  const bits = new Uint32Array(FILTER_WORDS);
  const add = (bit: number) => {
    const word = bit >>> 5;
    bits[word] = bits[word]! | (1 << (bit & 31));
  };
  for (const message of messages) visitGrams(foldQueryText(messageText(message)), 1, add);
  return bits;
}

function canReferenceFile(entry: EntryRecord): boolean {
  if (ContentPublicationEntry.is(entry)) return entry.data.parts.some((part) => "assetId" in part);
  if (KuloUserEntry.is(entry) || UserEntry.is(entry)) {
    const data = entry.data;
    if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.attachments) && data.attachments.length) return true;
    const message = entry.model?.[0];
    return message?.role === "user" && parseUserEntryContent(message.content).attachments.length > 0;
  }
  return false;
}

interface IndexedPage {
  first: number;
  last: number;
  count: number;
  recoveringBefore: boolean;
  recoveringAfter: boolean;
  hasFiles: boolean;
  bits: Uint32Array;
}

function matchesPage(page: IndexedPage, fingerprint: readonly number[]): boolean {
  // File visibility and display names are owned by the upload store and can change without a new entry.
  return page.hasFiles || fingerprint.every((bit) => (page.bits[bit >>> 5]! & (1 << (bit & 31))) !== 0);
}

interface IndexSource {
  conversation(id: number, context: Context): Promise<Conversation>;
  project(entries: readonly EntryRecord[], conversationId: number, context: Context): Promise<ChatDisplayItem[]>;
}

interface PageQuery {
  /** Undefined selects pages with possible file references. */
  fingerprint?: number[];
  within(first: number, last: number): boolean;
  collect(topic: TopicSummary, messages: VisibleMessage[]): void;
}

/** Keeps offsets and compact substring filters in the Hub process. No transcript copy is written to disk. */
export class ConversationQueryIndex {
  #pages = new Map<number, readonly IndexedPage[]>();
  #revision = -1;

  constructor(readonly source: IndexSource) {}

  retain(topics: readonly TopicSummary[]): void {
    if (!this.#pages.size) return;
    const live = new Set(topics.map((topic) => topic.conversationId));
    for (const id of this.#pages.keys()) if (!live.has(id)) this.#pages.delete(id);
  }

  async #project(topic: TopicSummary, entries: readonly EntryRecord[], recovering: boolean, context: Context) {
    const kept = entries.filter((entry) => {
      if (WorkerRecoveryEntry.is(entry)) recovering = true;
      else if (isRecoveryInputBoundary(entry)) recovering = false;
      return !recovering || !AssistantEntry.is(entry) && !ToolResultEntry.is(entry);
    });
    const messages = (await this.source.project(kept, topic.conversationId, context)).filter(isVisibleMessage);
    return { messages, recovering };
  }

  async visit(topics: readonly TopicSummary[], revision: number, query: PageQuery, context: Context): Promise<void> {
    if (this.#revision !== revision) {
      this.#pages = new Map();
      this.#revision = revision;
    }
    const index = this.#pages;
    const candidates: Array<{ conversation: Conversation; topic: TopicSummary; page: IndexedPage }> = [];
    const wanted = (page: IndexedPage) => query.within(page.first, page.last) &&
      (query.fingerprint ? matchesPage(page, query.fingerprint) : page.hasFiles);

    for (const topic of topics) {
      context.abortSignal?.throwIfAborted();
      const conversation = await this.source.conversation(topic.conversationId, context);
      const head = Number((await conversation.entries({}, 1, undefined, context)).items[0]?.id ?? 0);
      const previous = index.get(topic.conversationId) ?? [];
      const tail = previous.at(-1);
      let cached = previous;
      if (tail && head < tail.last) {
        cached = [];
        index.delete(topic.conversationId);
      } else if (tail && head > tail.last && tail.count < CONVERSATION_QUERY_PAGE_SIZE) {
        // A partial page may gain later UI action receipts which affect the projected text in that same page.
        cached = previous.slice(0, -1);
      }
      for (const page of cached) if (wanted(page)) candidates.push({ conversation, topic, page });
      let last = cached.at(-1)?.last ?? 0;
      if (last === head) continue;

      const pages = [...cached];
      let recovering = cached.at(-1)?.recoveringAfter ?? false;
      try {
        while (last < head) {
          context.abortSignal?.throwIfAborted();
          const { items } = await conversation.entries({ order: "ascending", minEntryId: (last + 1) as EntryId,
            maxEntryId: head as EntryId }, CONVERSATION_QUERY_PAGE_SIZE, undefined, context);
          if (!items.length) throw new Error("会话记录在检索期间发生了变化。");
          const projected = await this.#project(topic, items, recovering, context);
          const page = {
            first: Number(items[0]!.id), last: Number(items.at(-1)!.id), count: items.length,
            recoveringBefore: recovering, recoveringAfter: projected.recovering,
            bits: pageFingerprint(projected.messages), hasFiles: items.some(canReferenceFile),
          };
          pages.push(page);
          last = page.last;
          recovering = page.recoveringAfter;
          if (wanted(page)) query.collect(topic, projected.messages);
        }
      } finally {
        // Typing cancels old searches. Keep completed pages, without overwriting a newer search's progress.
        if (pages.length > cached.length && (index.get(topic.conversationId)?.at(-1)?.last ?? 0) <= last) {
          index.set(topic.conversationId, pages);
        }
      }
    }

    candidates.sort((left, right) => right.page.last - left.page.last);
    for (const { topic, conversation, page } of candidates) {
      context.abortSignal?.throwIfAborted();
      if (!query.within(page.first, page.last)) continue;
      const { items } = await conversation.entries({ order: "ascending", minEntryId: page.first as EntryId,
        maxEntryId: page.last as EntryId }, page.count, undefined, context);
      const projected = await this.#project(topic, items, page.recoveringBefore, context);
      query.collect(topic, projected.messages);
    }
  }
}
