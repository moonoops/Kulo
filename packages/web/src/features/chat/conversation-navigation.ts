import type { ChatDisplayItem } from "@kulo/protocol";

/** Durable publications from one response can share a single visible message. */
export function visibleMessageId(source: readonly ChatDisplayItem[], rendered: readonly ChatDisplayItem[], messageId: number): number | undefined {
  if (rendered.some((item) => item.id === messageId)) return messageId;
  const original = source.find((item) => item.id === messageId);
  if (original?.role !== "assistant" || original.responseId === undefined) return undefined;
  return rendered.find((item) => item.role === "assistant" && item.responseId === original.responseId)?.id;
}

export function mergeLocatedMessages(older: readonly ChatDisplayItem[], current: readonly ChatDisplayItem[]): ChatDisplayItem[] {
  return [...new Map([...older, ...current].map((item) => [item.id, item])).values()].sort((left, right) => left.id - right.id);
}

export function searchExcerptParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLocaleLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let from = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
