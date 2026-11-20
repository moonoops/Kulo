import { describe, expect, it } from "vitest";
import type { TicketCardView, TopicSummary } from "@kulo/protocol";
import { parseSeenTopicActivities, reconcileTopicActivity, topicNotifications, type SeenTopicActivities } from "./topic-activity";

const topics: TopicSummary[] = [{ id: "root", conversationId: 1, title: "Kulo", createdAt: 1, updatedAt: 1 },
  { id: "project-topic", projectId: "project", conversationId: 2, title: "项目讨论", createdAt: 1, updatedAt: 1 }];
const task: TicketCardView = { id: "task", title: "任务", role: "developer", roleLabel: "开发", status: "running", envId: "local", workspaceDir: "/tmp", originTopicId: "project-topic", createdAt: 1, updatedAt: 1 };
const activity = (id: number, busy = false) => ({ busy, queuedCount: 0, lastAssistantMessageId: id });

describe("sidebar conversation activity", () => {
  it("keeps automatic task recovery running without presenting the failed recovery stage as a failure", () => {
    const recovering: TicketCardView = { ...task, status: "failed", recovery: { state: "recovering", attempts: 1, startedAt: 1, deadlineAt: 100 } };
    const result = reconcileTopicActivity({ topics, tickets: [recovering], topicActivities: {}, seen: {} });
    expect(result.states["project-topic"]).toEqual({ running: true, queued: false, unread: false });
    expect(topicNotifications([recovering], "project-topic")).toEqual({ failureCount: 0, attentionCount: 0 });
    expect(topicNotifications([{ ...recovering, cleanupPending: true }], "project-topic")).toEqual({ failureCount: 0, attentionCount: 1 });
  });
  it("baselines historical replies and tasks on first use without marking everything unread", () => {
    const result = reconcileTopicActivity({ topics, tickets: [task], topicActivities: { root: activity(8), "project-topic": activity(12) }, seen: {} });
    expect(Object.values(result.states).every((state) => !state.unread)).toBe(true);
    expect(result.states["project-topic"]?.running).toBe(true);
  });

  it("shows inactive main conversations running and preserves new replies until actually viewed", () => {
    const baseline = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(8), "project-topic": activity(12) }, seen: {} }).seen;
    const busy = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(8), "project-topic": activity(12, true) }, seen: baseline, readableTopicId: "root" });
    expect(busy.states["project-topic"]).toEqual({ running: true, queued: false, unread: false });
    const completed = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(14) }, seen: busy.seen });
    expect(completed.states["project-topic"]?.unread).toBe(true);
    expect(reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(14) }, seen: completed.seen }).states["project-topic"]?.unread).toBe(true);
    const read = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(14) }, seen: completed.seen, readableTopicId: "project-topic" });
    expect(read.states["project-topic"]?.unread).toBe(false);
    expect(read.seen["project-topic"]?.assistant).toBe(14);
  });

  it("does not acknowledge completion while viewing a partial reply", () => {
    const baseline = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(8) }, seen: {} }).seen;
    const partial = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(10, true) }, seen: baseline, readableTopicId: "root" });
    expect(partial.seen.root).toMatchObject({ assistant: 10, settled: 8 });
    const completedAway = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(10) }, seen: partial.seen });
    expect(completedAway.states.root?.unread).toBe(true);
  });

  it("marks the first background reply unread after an initially unwatched empty conversation starts", () => {
    const initial = reconcileTopicActivity({ topics, tickets: [], topicActivities: {}, seen: {} }).seen;
    const started = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": { busy: true, queuedCount: 0 } }, seen: initial, readableTopicId: "root" });
    expect(started.seen["project-topic"]?.assistant).toBe(0);
    expect(started.states["project-topic"]?.unread).toBe(false);
    const completed = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(7) }, seen: started.seen, readableTopicId: "root" });
    expect(completed.states["project-topic"]?.unread).toBe(true);
  });

  it("does not confuse titles, timestamps, task labels or queue admission with new progress", () => {
    const baseline = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(8) }, seen: {} }).seen;
    const result = reconcileTopicActivity({ topics: topics.map((topic) => ({ ...topic, title: "新标题", updatedAt: 99 })), tickets: [{ ...task, status: "queued", updatedAt: 99 }], topicActivities: { root: activity(8) }, seen: baseline });
    expect(result.states["project-topic"]).toEqual({ running: false, queued: true, unread: false });
    const renamed = reconcileTopicActivity({ topics, tickets: [{ ...task, title: "新任务标题", status: "queued", updatedAt: 999 }], topicActivities: {}, seen: result.seen });
    expect(renamed.states["project-topic"]?.unread).toBe(false);
  });

  it("shows background reports and blocked tasks as progress, without presenting waiting as running", () => {
    const baseline = reconcileTopicActivity({ topics, tickets: [task], topicActivities: {}, seen: {} }).seen;
    const result = reconcileTopicActivity({ topics, tickets: [{ ...task, status: "waiting", waiting: { reason: "user", since: 2 }, latestReport: { state: "blocked", summary: "等待确认", at: 2 } }], topicActivities: {}, seen: baseline });
    expect(result.states["project-topic"]).toEqual({ running: false, queued: false, unread: true });
  });

  it("keeps unread across reload and baselines newly observed historical activity", () => {
    const previous = reconcileTopicActivity({ topics, tickets: [], topicActivities: {}, seen: {} }).seen;
    const loaded = parseSeenTopicActivities(JSON.stringify(previous));
    const observed = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(100) }, seen: loaded });
    expect(observed.states.root?.unread).toBe(false);
    const reloaded = parseSeenTopicActivities(JSON.stringify(observed.seen));
    expect(reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(101) }, seen: reloaded }).states.root?.unread).toBe(true);
    for (const malformed of ["null", "[]", "{", '{"root":{"assistant":"bad","settled":0,"tasks":{}}}']) expect(parseSeenTopicActivities(malformed)).toEqual({});
  });

  it("keeps an observed unread reply when a restarted Hub omits its idle topic cache", () => {
    const initial = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(8) }, seen: {} }).seen;
    const replied = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(10) }, seen: initial, readableTopicId: "root" });
    expect(replied.states["project-topic"]?.unread).toBe(true);
    const stored = parseSeenTopicActivities(JSON.stringify(replied.seen));
    const restarted = reconcileTopicActivity({ topics, tickets: [], topicActivities: { root: activity(2) }, seen: stored, readableTopicId: "root" });
    expect(restarted.states["project-topic"]).toEqual({ running: false, queued: false, unread: true });
    const read = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(10) }, seen: restarted.seen, readableTopicId: "project-topic" });
    expect(read.states["project-topic"]?.unread).toBe(false);
    const reloaded = reconcileTopicActivity({ topics, tickets: [], topicActivities: {}, seen: parseSeenTopicActivities(JSON.stringify(read.seen)) });
    expect(reloaded.states["project-topic"]?.unread).toBe(false);
  });

  it("does not persist stale running state alongside unread progress", () => {
    const initial = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(8) }, seen: {} }).seen;
    const partial = reconcileTopicActivity({ topics, tickets: [], topicActivities: { "project-topic": activity(10, true) }, seen: initial });
    expect(partial.states["project-topic"]).toEqual({ running: true, queued: false, unread: true });
    const restarted = reconcileTopicActivity({ topics, tickets: [], topicActivities: {}, seen: parseSeenTopicActivities(JSON.stringify(partial.seen)) });
    expect(restarted.states["project-topic"]).toEqual({ running: false, queued: false, unread: true });
  });

  it("retains saved state while connecting and removes deleted topics after a topic snapshot", () => {
    const seen: SeenTopicActivities = { removed: { assistant: 1, settled: 1, tasks: {} } };
    expect(reconcileTopicActivity({ topics: [], tickets: [], topicActivities: {}, seen }).seen).toBe(seen);
    expect(reconcileTopicActivity({ topics, tickets: [], topicActivities: {}, seen }).seen.removed).toBeUndefined();
  });

  it("marks first-seen proactive topics unread until viewed and re-marks on proactiveSeq bumps", () => {
    const proactive: TopicSummary = {
      id: "proactive-1",
      conversationId: 3,
      title: "Q4 预算表",
      origin: "proactive",
      situationId: "sit-q4",
      proactiveSeq: 1,
      createdAt: 10,
      updatedAt: 10,
    };
    const first = reconcileTopicActivity({
      topics: [...topics, proactive],
      tickets: [],
      topicActivities: { "proactive-1": activity(20) },
      seen: {},
      readableTopicId: "root",
    });
    expect(first.states["proactive-1"]?.unread).toBe(true);
    // Persists unread across reload until opened.
    const reloaded = reconcileTopicActivity({
      topics: [...topics, proactive],
      tickets: [],
      topicActivities: {},
      seen: parseSeenTopicActivities(JSON.stringify(first.seen)),
      readableTopicId: "root",
    });
    expect(reloaded.states["proactive-1"]?.unread).toBe(true);

    // Viewing clears unread.
    const opened = reconcileTopicActivity({
      topics: [...topics, proactive],
      tickets: [],
      topicActivities: { "proactive-1": activity(20) },
      seen: reloaded.seen,
      readableTopicId: "proactive-1",
    });
    expect(opened.states["proactive-1"]?.unread).toBe(false);
    expect(opened.seen["proactive-1"]?.proactiveSeq).toBe(1);

    // Switching away keeps it read; bumping proactiveSeq marks it unread again.
    const away = reconcileTopicActivity({
      topics: [...topics, proactive],
      tickets: [],
      topicActivities: { "proactive-1": activity(20) },
      seen: opened.seen,
      readableTopicId: "root",
    });
    expect(away.states["proactive-1"]?.unread).toBe(false);

    const bumped = reconcileTopicActivity({
      topics: [...topics, { ...proactive, proactiveSeq: 2 }],
      tickets: [],
      topicActivities: { "proactive-1": activity(20) },
      seen: away.seen,
      readableTopicId: "root",
    });
    expect(bumped.states["proactive-1"]?.unread).toBe(true);
  });
});

describe("conversation notifications", () => {
  it("scopes failures and required decisions to their conversation, including legacy root tasks", () => {
    const tickets: TicketCardView[] = [
      { ...task, status: "failed" },
      { ...task, id: "confirmation", status: "waiting", waiting: { reason: "user", since: 1 } },
      { ...task, id: "other", originTopicId: "other", status: "blocked" },
      { ...task, id: "legacy-root", originTopicId: undefined, status: "failed" },
    ];
    expect(topicNotifications(tickets, "project-topic")).toEqual({ failureCount: 1, attentionCount: 1 });
    expect(topicNotifications(tickets, "root")).toEqual({ failureCount: 1, attentionCount: 0 });
    expect(topicNotifications(tickets, "missing")).toEqual({ failureCount: 0, attentionCount: 0 });
  });

  it("includes cleanup and blocked tasks but excludes passive waits and stale user-wait metadata", () => {
    const tickets: TicketCardView[] = [
      { ...task, id: "cleanup", status: "stopped", cleanupPending: true },
      { ...task, id: "blocked", status: "blocked" },
      ...(["env", "time", "external", "project", "connection"] as const).map(reason => ({ ...task, id: reason, status: "waiting" as const, waiting: { reason, since: 1 } })),
      { ...task, id: "stale-running", status: "running", waiting: { reason: "user", since: 1 } },
      { ...task, id: "stale-closed", status: "closed", waiting: { reason: "user", since: 1 } },
    ];
    expect(topicNotifications(tickets, "project-topic")).toEqual({ failureCount: 0, attentionCount: 2 });
  });

  it("keeps exhausted failures actionable and retains cleanup decisions alongside failures", () => {
    const failed: TicketCardView = { ...task, status: "failed", cleanupPending: true, recovery: { state: "exhausted", attempts: 3, startedAt: 1, deadlineAt: 100 } };
    expect(topicNotifications([failed], "project-topic")).toEqual({ failureCount: 1, attentionCount: 1 });
  });
});
