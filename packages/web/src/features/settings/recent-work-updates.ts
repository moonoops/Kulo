import type { ProjectView, TicketCardView, TopicSummary } from "@kulo/protocol";

export interface RecentWorkSource {
  tickets: readonly TicketCardView[];
  topics: readonly TopicSummary[];
  projects: readonly Pick<ProjectView, "id">[];
}

/** Ignore progress, heartbeat timestamps, and display ordering in existing Hub pushes. */
export function recentWorkUpdateKey(source: RecentWorkSource, topicId = "root"): string {
  const topicIds = new Set([topicId]);
  const projectIds = new Set<string>();
  const tickets = source.tickets.filter((ticket) => ticket.status !== "closed").map((ticket) => {
    if (ticket.originTopicId) topicIds.add(ticket.originTopicId);
    if (ticket.projectId) projectIds.add(ticket.projectId);
    const waiting = ["waiting", "blocked", "pausing"].includes(ticket.status);
    const result = ["ready", "failed", "stopped"].includes(ticket.status);
    return [
      ticket.id, ticket.title, ticket.status, ticket.projectId, ticket.originTopicId, ticket.createdAt,
      waiting ? ticket.waiting?.detail ?? ticket.latestReport?.question ??
        (ticket.latestReport?.state === "blocked" ? ticket.latestReport.summary : undefined) : undefined,
      result ? ticket.latestReport?.summary : undefined,
      result ? ticket.latestReport?.at ?? ticket.completedAt ?? ticket.createdAt : undefined,
      ticket.status === "stopped" ? ticket.stoppedReason : undefined,
    ] as const;
  }).sort(([a], [b]) => a.localeCompare(b));
  const topics = source.topics.filter((topic) => topicIds.has(topic.id)).map((topic) => {
    if (topic.projectId) projectIds.add(topic.projectId);
    return [topic.id, topic.projectId, Boolean(topic.archived), topic.deletedAt !== undefined] as const;
  })
    .sort(([a], [b]) => a.localeCompare(b));
  const projects = source.projects.filter((project) => projectIds.has(project.id)).map((project) => project.id).sort();
  return JSON.stringify([tickets, topics, projects]);
}
