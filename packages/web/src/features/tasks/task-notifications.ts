import type { TicketCardView } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";

export interface TicketNotificationEvent {
  ticketId: string;
  title: string;
  body: string;
  topicId?: string;
}

const ACTIVE_TICKET_STATUSES = new Set<TicketCardView["status"]>(["queued", "running", "pausing", "waiting"]);
const NOTIFIABLE_SETTLED_STATUSES = new Set<TicketCardView["status"]>(["ready", "blocked", "failed"]);

export function collectTicketNotifications(
  previousById: ReadonlyMap<string, TicketCardView["status"]>,
  nextTickets: readonly TicketCardView[],
): TicketNotificationEvent[] {
  if (previousById.size === 0) return [];
  const events: TicketNotificationEvent[] = [];
  for (const ticket of nextTickets) {
    const previous = previousById.get(ticket.id);
    if (!previous || !ACTIVE_TICKET_STATUSES.has(previous)) continue;
    if (!NOTIFIABLE_SETTLED_STATUSES.has(ticket.status)) continue;
    const heading =
      ticket.status === "ready"
        ? t("任务已完成", "Task completed")
        : ticket.status === "blocked"
          ? t("任务需要确认", "Task needs attention")
          : t("任务执行失败", "Task failed");
    events.push({
      ticketId: ticket.id,
      title: heading,
      body: ticket.title || ticket.id,
      ...(ticket.originTopicId ? { topicId: ticket.originTopicId } : {}),
    });
  }
  return events;
}
