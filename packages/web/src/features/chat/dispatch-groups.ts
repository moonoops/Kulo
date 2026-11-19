import { getMessageParts, type ChatDisplayItem, type LiveStreamState } from "@moco/protocol";

export interface DispatchReplyGroup<T extends ChatDisplayItem = ChatDisplayItem> {
  type: "dispatch-group";
  key: string;
  dispatches: T[];
  replies: T[];
}

export type ConversationEntry<T extends ChatDisplayItem = ChatDisplayItem> =
  | { type: "message"; item: T }
  | DispatchReplyGroup<T>;

export function groupDispatchReplies<T extends ChatDisplayItem>(items: T[]): ConversationEntry<T>[] {
  const groups: ConversationEntry<T>[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.role !== "dispatch" || !item.dispatch) {
      groups.push({ type: "message", item });
      continue;
    }
    const group: DispatchReplyGroup<T> = { type: "dispatch-group", key: `dispatch:${item.id}`, dispatches: [item], replies: [] };
    let responseId = item.responseId;
    while (index + 1 < items.length) {
      const next = items[index + 1]!;
      if (next.role === "dispatch" && next.dispatch && group.replies.length === 0) {
        if (responseId !== next.responseId) break;
        group.dispatches.push(next);
      } else if (next.role === "assistant") {
        if (responseId !== next.responseId) {
          if (responseId !== undefined || group.replies.length > 0) break;
          responseId = next.responseId;
        }
        group.replies.push(next);
      } else break;
      index++;
    }
    groups.push(group);
  }
  return groups;
}

export function matchingLiveDispatchGroupKey(entry: ConversationEntry | undefined, live: Pick<LiveStreamState, "busy" | "responseId">): string | undefined {
  if (!live.busy || entry?.type !== "dispatch-group") return undefined;
  const responseId = entry.replies.at(-1)?.responseId ?? entry.dispatches.at(-1)?.responseId;
  return responseId === live.responseId ? entry.key : undefined;
}

export function dispatchGroupActionItem(group: DispatchReplyGroup): ChatDisplayItem {
  const messages = [...group.dispatches, ...group.replies];
  const createdAt = messages.findLast((item) => typeof item.createdAt === "number" && Number.isFinite(item.createdAt))?.createdAt;
  const reply = group.replies.at(-1);
  if (!reply) {
    return {
      ...group.dispatches[0]!,
      text: group.dispatches.map((item) => [item.dispatch!.actionLabel, item.dispatch!.title, item.dispatch!.userSummary].filter(Boolean).join("\n")).join("\n\n"),
      createdAt,
    };
  }
  return {
    ...reply,
    createdAt,
    text: group.replies.map((item) => item.text).filter(Boolean).join("\n\n"),
    parts: group.replies.flatMap((item) => getMessageParts(item).map((part) => ({ ...part, partId: `${item.id}:${part.partId}` }))),
  };
}
