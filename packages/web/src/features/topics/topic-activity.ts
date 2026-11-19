import type { TicketCardView, TopicActivity, TopicSummary } from "@kulo/protocol";
import { taskIsRecovering } from "../tasks/task-model";

export interface TopicActivityState { running: boolean; queued: boolean; unread: boolean }
export interface SeenTopicActivity {
  assistant: number | null;
  settled: number | null;
  tasks: Record<string, string>;
  unread?: boolean;
}
export type SeenTopicActivities = Record<string, SeenTopicActivity>;

export function topicNotifications(tickets: readonly TicketCardView[], topicId: string): { failureCount: number; attentionCount: number } {
  let failureCount = 0;
  let attentionCount = 0;
  for (const ticket of tickets) {
    if ((ticket.originTopicId ?? "root") !== topicId) continue;
    if (ticket.status === "failed" && !taskIsRecovering(ticket)) failureCount++;
    if (ticket.cleanupPending || ticket.status === "blocked" || ticket.status === "waiting" && ticket.waiting?.reason === "user") attentionCount++;
  }
  return { failureCount, attentionCount };
}

export function parseSeenTopicActivities(value: string | null): SeenTopicActivities {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, SeenTopicActivity] => {
      const item = entry[1];
      return Boolean(item && typeof item === "object" && !Array.isArray(item) &&
        (item.assistant === null || Number.isSafeInteger(item.assistant) && item.assistant >= 0) &&
        (item.settled === null || Number.isSafeInteger(item.settled) && item.settled >= 0) &&
        (item.unread === undefined || typeof item.unread === "boolean") &&
        item.tasks && typeof item.tasks === "object" && !Array.isArray(item.tasks) && Object.values(item.tasks).every((token) => typeof token === "string"));
    }));
  } catch { return {}; }
}

function taskToken(ticket: TicketCardView): string {
  return JSON.stringify([ticket.status, ticket.latestReport?.at ?? null, ticket.waiting?.reason ?? null, Boolean(ticket.cleanupPending)]);
}

export function reconcileTopicActivity({ topics, tickets, topicActivities, seen, readableTopicId }: {
  topics: readonly TopicSummary[];
  tickets: readonly TicketCardView[];
  topicActivities: Readonly<Record<string, TopicActivity>>;
  seen: SeenTopicActivities;
  readableTopicId?: string;
}): { seen: SeenTopicActivities; states: Record<string, TopicActivityState> } {
  if (!topics.length) return { seen, states: {} };
  const nextSeen: SeenTopicActivities = {};
  const states: Record<string, TopicActivityState> = {};
  for (const topic of topics) {
    if (topic.deletedAt) continue;
    const activity = topicActivities[topic.id];
    const associated = tickets.filter((ticket) => (ticket.originTopicId ?? "root") === topic.id);
    const tasks = Object.fromEntries(associated.map((ticket) => [ticket.id, taskToken(ticket)]));
    const previous = seen[topic.id];
    const assistant = activity ? activity.lastAssistantMessageId ?? 0 : previous?.assistant ?? null;
    // Reading a partial reply does not acknowledge its eventual completion.
    const settled = activity && !activity.busy ? assistant : previous?.settled ?? (activity ? assistant : null);
    const baseline: SeenTopicActivity = { assistant, settled, tasks, unread: false };
    let unread = false;
    if (previous) {
      const newAssistant = activity && previous.assistant !== null && assistant !== null && assistant > previous.assistant;
      const completedReply = activity && !activity.busy && previous.settled !== null && settled !== null && settled > previous.settled;
      const taskProgress = associated.some((ticket) => {
        const old = previous.tasks[ticket.id];
        if (old !== undefined) return old !== tasks[ticket.id];
        return Boolean(ticket.latestReport || ["ready", "failed", "blocked", "waiting", "stopped"].includes(ticket.status));
      });
      // Idle topic caches are intentionally absent after a Hub restart. Keep a known
      // unread result until the user reads it, without retaining stale running state.
      unread = Boolean(previous.unread || newAssistant || completedReply || taskProgress);
      const trackedTasks = { ...previous.tasks };
      for (const ticket of associated) {
        if (!(ticket.id in trackedTasks) && !ticket.latestReport && ["queued", "running", "pausing"].includes(ticket.status)) trackedTasks[ticket.id] = tasks[ticket.id]!;
      }
      nextSeen[topic.id] = readableTopicId === topic.id ? baseline : {
        assistant: previous.assistant === null ? assistant : previous.assistant,
        settled: previous.settled === null ? settled : previous.settled,
        tasks: trackedTasks,
        unread,
      };
    } else nextSeen[topic.id] = baseline;
    states[topic.id] = {
      running: Boolean(activity?.busy || associated.some((ticket) => ["running", "pausing"].includes(ticket.status) || taskIsRecovering(ticket))),
      queued: Boolean(activity?.queuedCount || associated.some((ticket) => ticket.status === "queued")),
      unread: readableTopicId === topic.id ? false : unread,
    };
  }
  return { seen: nextSeen, states };
}
