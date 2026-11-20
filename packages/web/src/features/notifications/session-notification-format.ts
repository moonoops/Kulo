import type { MainSessionNotificationEvent, TopicSummary } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";

export interface FormattedSessionNotification {
  title: string;
  body: string;
  topicId: string;
  eventId: string;
  dedupeKey: string;
}

export function formatMainSessionNotification(
  event: MainSessionNotificationEvent,
  options: {
    topics: readonly TopicSummary[];
    agentName: string;
  },
): FormattedSessionNotification {
  const title =
    event.kind === "attention_required"
      ? t("需要确认", "Needs attention")
      : event.kind === "run_failed"
        ? t("执行失败", "Run failed")
        : t("回复已完成", "Reply ready");

  const topicLabel = event.topicId === "root"
    ? t(`${options.agentName} · 主会话`, `${options.agentName} · Main chat`)
    : event.topicTitle?.trim()
      || options.topics.find((topic) => topic.id === event.topicId)?.title?.trim()
      || t("对话", "Conversation");

  const body = event.summary?.trim()
    ? `${topicLabel} · ${event.summary.trim()}`
    : topicLabel;

  return {
    title,
    body,
    topicId: event.topicId,
    eventId: event.id,
    dedupeKey: `topic:${event.topicId}`,
  };
}
