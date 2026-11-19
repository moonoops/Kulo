import type { ChatDisplayItem, LiveStreamState, TopicActivity } from "@moco/protocol";

export function topicActivity(messages: readonly ChatDisplayItem[], live: LiveStreamState): TopicActivity {
  const assistantIds = messages.filter((message) => message.role === "assistant").map((message) => message.id);
  return {
    busy: live.busy,
    queuedCount: live.queuedCount,
    ...(assistantIds.length ? { lastAssistantMessageId: Math.max(...assistantIds) } : {}),
  };
}
