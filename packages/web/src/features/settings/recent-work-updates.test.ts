import { describe, expect, it } from "vitest";
import type { TicketCardView } from "@kulo/protocol";
import { recentWorkUpdateKey, type RecentWorkSource } from "./recent-work-updates";

function ticket(id: string): TicketCardView {
  return { id, title: `工作 ${id}`, role: "coder", roleLabel: "开发者", status: "running",
    envId: "local", workspaceDir: "/project", createdAt: 1, updatedAt: 1 };
}

function fixture(): RecentWorkSource {
  return {
    tickets: [ticket("a"), ticket("b")],
    topics: [{ id: "root", conversationId: 1, title: "话题", createdAt: 1, updatedAt: 1 }],
    projects: [{ id: "p1" }, { id: "p2" }],
  };
}

describe("recent-work push invalidation", () => {
  it("ignores duplicate broadcasts, heartbeat timestamps, progress, and display ordering", () => {
    const source = fixture();
    const before = recentWorkUpdateKey(source);
    const next = structuredClone(source);
    next.tickets.forEach((item) => {
      item.updatedAt = 999;
      item.accumulatedRunningMs = 10_000;
      item.latestReport = { state: "progress", summary: "又完成一个工具步骤", at: 999 };
    });
    next.tickets = [...next.tickets].reverse();
    next.projects = [...next.projects].reverse();
    next.topics[0]!.title = "111";
    next.topics[0]!.updatedAt = 999;
    expect(recentWorkUpdateKey(next)).toBe(before);
  });

  it("changes for committed task status, waiting detail, and outcome updates", () => {
    const source = fixture();
    const before = recentWorkUpdateKey(source);
    source.tickets[0]!.status = "waiting";
    source.tickets[0]!.waiting = { reason: "user", since: 2, detail: "确认范围" };
    const waiting = recentWorkUpdateKey(source);
    expect(waiting).not.toBe(before);
    source.tickets[0]!.waiting!.since = 300;
    expect(recentWorkUpdateKey(source)).toBe(waiting);
    source.tickets[0]!.waiting!.detail = "确认交付物";
    expect(recentWorkUpdateKey(source)).not.toBe(waiting);
    source.tickets[0]!.status = "ready";
    source.tickets[0]!.latestReport = { state: "ready", summary: "已完成交付", at: 4 };
    const ready = recentWorkUpdateKey(source);
    source.tickets[0]!.latestReport!.summary = "已修订交付";
    expect(recentWorkUpdateKey(source)).not.toBe(ready);
  });

  it("tracks creation, closure, topic moves, archive changes, and project removal", () => {
    const source = fixture();
    let before = recentWorkUpdateKey(source);
    source.tickets = [...source.tickets, ticket("c")];
    expect(recentWorkUpdateKey(source)).not.toBe(before);
    before = recentWorkUpdateKey(source);
    source.tickets[0]!.status = "closed";
    expect(recentWorkUpdateKey(source)).not.toBe(before);
    before = recentWorkUpdateKey(source);
    source.topics[0]!.projectId = "p1";
    expect(recentWorkUpdateKey(source)).not.toBe(before);
    before = recentWorkUpdateKey(source);
    source.topics[0]!.archived = true;
    expect(recentWorkUpdateKey(source)).not.toBe(before);
    before = recentWorkUpdateKey(source);
    source.projects = source.projects.filter((project) => project.id !== "p1");
    expect(recentWorkUpdateKey(source)).not.toBe(before);
  });

  it("ignores later housekeeping on work that is already closed", () => {
    const source = fixture();
    source.tickets[0]!.status = "closed";
    const before = recentWorkUpdateKey(source);
    source.tickets[0]!.title = "清理后的标题";
    source.tickets[0]!.cleanupPending = true;
    source.tickets[0]!.updatedAt = 100;
    expect(recentWorkUpdateKey(source)).toBe(before);
  });

  it("does not reload for unrelated topic or project creation", () => {
    const source = fixture();
    const before = recentWorkUpdateKey(source);
    source.topics = [...source.topics, { id: "other", conversationId: 2, title: "普通闲聊", createdAt: 2, updatedAt: 2 }];
    source.projects = [...source.projects, { id: "unrelated-project" }];
    expect(recentWorkUpdateKey(source)).toBe(before);
  });
});
