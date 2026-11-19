import { getMessageParts, type ChatDisplayItem, type LiveStreamState, type MessagePart } from "@moco/protocol";

function hasContent(item: ChatDisplayItem): boolean {
  return Boolean(item.text.trim() || item.parts?.length || item.attachments?.length);
}

function mergeBy<T>(previous: T[] | undefined, next: T[] | undefined, key: (item: T) => string): T[] | undefined {
  if (!previous && !next) return undefined;
  return [...new Map([...(previous ?? []), ...(next ?? [])].map((item) => [key(item), item])).values()];
}

function appendParts(previous: ChatDisplayItem, next: ChatDisplayItem): MessagePart[] {
  const parts = getMessageParts(previous);
  const ids = new Set(parts.map((part) => part.partId));
  return [...parts, ...getMessageParts(next).map((part) => ids.has(part.partId) ? { ...part, partId: `${next.id}:${part.partId}` } : part)];
}

/** Keep durable entry identities intact while presenting one assistant reply. */
export function mergeResponseMessages<T extends ChatDisplayItem>(items: readonly T[]): T[] {
  const merged: T[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (item.role !== "assistant" || item.responseId === undefined || previous?.role !== "assistant" || previous.responseId !== item.responseId) {
      merged.push(item);
      continue;
    }
    // A hidden tool record must not replace the identity of the first visible attachment or text.
    const anchor = hasContent(previous) || !hasContent(item) ? previous : item;
    merged[merged.length - 1] = {
      ...anchor,
      text: [previous.text, item.text].filter(Boolean).join("\n\n"),
      parts: appendParts(previous, item),
      attachments: mergeBy(previous.attachments, item.attachments, (asset) => asset.id),
      thinking: [previous.thinking, item.thinking].filter(Boolean).join("\n\n") || undefined,
      toolCalls: mergeBy(previous.toolCalls, item.toolCalls, (call) => call.id),
      sources: mergeBy(previous.sources, item.sources, (source) => source.url),
      searchSuggestions: mergeBy(previous.searchSuggestions, item.searchSuggestions, (suggestion) => suggestion),
    };
  }
  return merged;
}

export function liveResponseMessageId(items: readonly ChatDisplayItem[], live: LiveStreamState): number | undefined {
  const last = items.at(-1);
  return live.busy && live.responseId !== undefined && last?.role === "assistant" && last.responseId === live.responseId && hasContent(last)
    ? last.id : undefined;
}
