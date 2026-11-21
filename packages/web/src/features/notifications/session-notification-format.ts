import type { MainSessionNotificationEvent, TopicSummary } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";

const APP_NOTIFICATION_TITLE = "Kulo";

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
  const summary = event.summary?.trim();
  const topicFallback = event.topicId === "root"
    ? undefined
    : event.topicTitle?.trim()
      || options.topics.find((topic) => topic.id === event.topicId)?.title?.trim()
      || undefined;

  let body: string;
  if (event.kind === "attention_required") {
    const detail = summary || topicFallback;
    body = detail
      ? t(`需要确认：${detail}`, `Needs confirmation: ${detail}`)
      : t("需要你的确认", "Needs your confirmation");
  } else if (event.kind === "run_failed") {
    const detail = summary || topicFallback;
    body = detail
      ? t(`执行失败：${detail}`, `Run failed: ${detail}`)
      : t("任务执行失败", "Task failed");
  } else {
    body = summary
      || (topicFallback ? t(`已完成：${topicFallback}`, `Completed: ${topicFallback}`) : t("任务已完成", "Task completed"));
  }

  return {
    title: APP_NOTIFICATION_TITLE,
    body,
    topicId: event.topicId,
    eventId: event.id,
    dedupeKey: `topic:${event.topicId}`,
  };
}
