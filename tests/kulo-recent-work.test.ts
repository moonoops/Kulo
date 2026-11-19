import { describe, expect, it } from "vitest";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ProjectRecord, TicketRecord } from "@kulo/protocol";
import { buildRecentWorkSnapshot, RECENT_WORK_LIMIT, RECENT_WORK_TICKET_LIMIT } from "../packages/hub/src/recent-work.js";
import type { KuloDurableState } from "../packages/hub/src/state.js";
import type { KuloProjectsState } from "../packages/hub/src/projects.js";

function ticket(id: string, patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id, commandId: id, title: `工作 ${id}`, goal: `目标 ${id}`, scope: `范围 ${id}`,
    role: "coder", status: "running", envId: "local", workspaceDir: "/project",
    workerConversationId: 100, runEpoch: 1, createdAt: 10, updatedAt: 10, ...patch,
  };
}
function project(id: string, patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id, name: `项目 ${id}`, deviceId: "local", workspaceDir: `/project/${id}`,
    directoryId: id, revision: 1, grantRevision: 1, notes: `背景 ${id}`, createdAt: 1, updatedAt: 1, ...patch };
}
function fixture() {
  const root = Number(ROOT_CONVERSATION_ID);
  const state: KuloDurableState = {
    nextTicketNumber: 1, tickets: {}, commandIndex: {}, conversationToTicket: {},
    topics: { root: { id: "root", conversationId: root, title: "主话题", createdAt: 1, updatedAt: 1 } },
    conversationToTopic: { [root]: "root" }, slots: { holders: [] },
  };
  const projects: KuloProjectsState = { projects: {}, commands: {}, bindings: {}, needsAuthorization: {}, cleanup: {}, errors: {}, cancellations: {} };
  return { state, projects, conversationId: root };
}

describe("recent work context", () => {
  it("scopes project work to the current project, including after a topic has moved", () => {
    const input = fixture();
    input.state.topics!.root!.projectId = "p1";
    input.projects.projects = { p1: project("p1"), p2: project("p2") };
    input.state.tickets = {
      own: ticket("own", { projectId: "p1", status: "waiting", waiting: { reason: "user", since: 9, detail: "请确定颜色" } }),
      other: ticket("other", { projectId: "p2", originTopicId: "root", title: "不相关项目的私密内容" }),
    };
    const snapshot = buildRecentWorkSnapshot(input);
    expect(snapshot).toMatchObject({ enabled: true, projectId: "p1", topicId: "root" });
    expect(snapshot.content).toContain("请确定颜色");
    expect(snapshot.content).not.toContain("背景 p1");
    expect(snapshot.content).not.toContain("不相关项目");
    expect(snapshot.content).not.toContain("背景 p2");
  });

  it("retains unfinished work globally while rendering ready as awaiting acceptance", () => {
    const input = fixture();
    input.state.topics!.archived = { id: "archived", title: "旧话题", conversationId: 20, archived: true, createdAt: 1, updatedAt: 1 };
    input.projects.projects.p1 = project("p1");
    input.state.tickets = {
      active: ticket("active", { projectId: "p1", originTopicId: "archived" }),
      ready: ticket("ready", { status: "ready", latestReport: { state: "ready", summary: "已生成方案", at: 100 } }),
      closed: ticket("closed", { status: "closed", title: "已关闭秘密" }),
      archivedReady: ticket("archivedReady", { status: "ready", originTopicId: "archived", title: "归档旧结果" }),
    };
    const { content } = buildRecentWorkSnapshot(input);
    expect(content).toContain("active");
    expect(content).toContain("ready_for_review");
    expect(content).not.toContain("已关闭秘密");
    expect(content).not.toContain("归档旧结果");
  });

  it("changes revisions for meaningful state changes, not UI timestamps or map ordering", () => {
    const input = fixture();
    input.state.tickets = { a: ticket("a"), b: ticket("b") };
    const before = buildRecentWorkSnapshot(input);
    input.state.topics!.root!.updatedAt = 999999;
    input.state.tickets = { b: { ...input.state.tickets.b!, updatedAt: 900 }, a: { ...input.state.tickets.a!, updatedAt: 600 } };
    expect(buildRecentWorkSnapshot(input)).toEqual(before);
    input.state.tickets.a!.status = "waiting";
    input.state.tickets.a!.waiting = { reason: "env", since: 1000, detail: "等待电脑上线" };
    const after = buildRecentWorkSnapshot(input);
    expect(after.content).toContain("等待电脑上线");
    expect(after.revision).not.toBe(before.revision);
  });

  it("does not broaden a deleted project or expose work to Workers and removed topics", () => {
    const input = fixture();
    input.state.topics!.root!.projectId = "gone";
    input.projects.projects.gone = project("gone", { deletedAt: 10 });
    input.state.tickets.secret = ticket("secret", { title: "其他项目秘密" });
    expect(buildRecentWorkSnapshot(input).content).not.toContain("其他项目秘密");
    expect(buildRecentWorkSnapshot(input).content).toContain("The project linked to this conversation is unavailable");
    input.state.conversationToTicket["100"] = "secret";
    expect(buildRecentWorkSnapshot({ ...input, conversationId: 100 })).toMatchObject({ enabled: false, content: "" });
    input.state.topics!.root!.deletedAt = 11;
    expect(buildRecentWorkSnapshot(input)).toMatchObject({ enabled: false, content: "" });
  });

  it("supports disabling injection and bounds untrusted source text", () => {
    const input = fixture();
    input.state.tickets.huge = ticket("huge", { title: "x".repeat(20000), scope: "y".repeat(20000), goal: "z".repeat(20000) });
    const snapshot = buildRecentWorkSnapshot(input);
    expect(snapshot.content.length).toBeLessThanOrEqual(RECENT_WORK_LIMIT);
    expect(buildRecentWorkSnapshot({ ...input, enabled: false })).toMatchObject({ enabled: false, content: "", revision: "disabled" });
  });

  it("keeps titles, project notes, and active progress reports out of working context", () => {
    const input = fixture();
    input.state.topics!.root!.projectId = "p1";
    input.projects.projects.p1 = project("p1");
    input.state.tickets.active = ticket("active", { projectId: "p1" });
    const before = buildRecentWorkSnapshot(input);
    input.state.topics!.root!.title = "111";
    input.projects.projects.p1.notes = "PROJECT_NOTES_ALREADY_IN_CONTEXT";
    input.state.tickets.active!.latestReport = { state: "progress", summary: "PROGRESS_LOG", at: 999 };
    expect(buildRecentWorkSnapshot(input)).toEqual(before);
    expect(before.content).not.toContain("当前话题");
    expect(before.content).not.toContain("当前会话背景");
    expect(before.content).not.toContain("项目背景");
  });

  it("fits five complete ticket entries and an overflow count while prioritizing decisions", () => {
    const input = fixture();
    input.state.tickets = {
      running: ticket("running", { createdAt: 300 }),
      newer: ticket("newer", { createdAt: 400 }),
      waiting: ticket("waiting", { status: "waiting", waiting: { reason: "user", since: 1, detail: "WAITING_DECISION" } }),
      ready: ticket("ready", { status: "ready", latestReport: { state: "ready", summary: "READY_RESULT", at: 10 } }),
      blocked: ticket("blocked", { status: "blocked", latestReport: { state: "blocked", summary: "BLOCKED_REASON", at: 20 } }),
      failed: ticket("failed", { status: "failed", createdAt: 500 }),
      closed: ticket("closed", { status: "closed" }),
    };
    for (const item of Object.values(input.state.tickets)) {
      item.title = "很长的工作标题".repeat(100);
      item.goal = "很长的工作目标".repeat(100);
      item.scope = "很长的范围".repeat(100);
    }
    const { content } = buildRecentWorkSnapshot(input);
    const entries = content.split("\n").filter((line) => line.startsWith("- "));
    expect(entries).toHaveLength(RECENT_WORK_TICKET_LIMIT);
    expect(entries.map((line) => line.split(" · ")[0])).toEqual([
      "- blocked", "- waiting", "- ready", "- newer", "- running",
    ]);
    expect(content).toContain("BLOCKED_REASON");
    expect(content).toContain("WAITING_DECISION");
    expect(content).toContain("READY_RESULT");
    expect(content).toContain("1 additional ticket(s) in scope");
    expect(content).not.toContain("- closed");
    expect(content.length).toBeLessThanOrEqual(RECENT_WORK_LIMIT);
    input.state.tickets = Object.fromEntries(Object.entries(input.state.tickets).reverse());
    expect(buildRecentWorkSnapshot(input).content).toBe(content);
  });

  it("updates outcomes and waiting state but ignores heartbeat timestamps for results", () => {
    const input = fixture();
    input.state.tickets = {
      a: ticket("a", { status: "ready", latestReport: { state: "ready", summary: "旧结果", at: 10 } }),
      b: ticket("b", { status: "failed", latestReport: { state: "failed", summary: "失败原因", at: 20 } }),
    };
    const before = buildRecentWorkSnapshot(input);
    input.state.tickets.a!.updatedAt = 999;
    input.state.tickets.b!.updatedAt = 1000;
    expect(buildRecentWorkSnapshot(input)).toEqual(before);
    input.state.tickets.a!.latestReport!.summary = "新结果";
    const after = buildRecentWorkSnapshot(input);
    expect(after.revision).not.toBe(before.revision);
    expect(after.content).toContain("新结果");
    input.state.tickets.a!.status = "closed";
    expect(buildRecentWorkSnapshot(input).content).not.toContain("新结果");
    input.state.tickets.b!.status = "stopped";
    input.state.tickets.b!.stoppedReason = "用户取消";
    expect(buildRecentWorkSnapshot(input).content).toContain("用户取消");
  });
});
