import { describe, expect, it } from "vitest";
import type { TicketCardView } from "@kulo/protocol";
import { reconcileTaskRows, taskHasExpired, taskIsRecovering, taskNeedsAttention, taskRunningMs, taskStatusLabel, taskSummary, taskTimeLabel, visibleTaskCards } from "./task-model";

const hour = 3_600_000;
const ticket = (id: string, changes: Partial<TicketCardView> = {}): TicketCardView => ({
  id, title: id, role: "developer", roleLabel: "开发智能体", status: "running",
  envId: "local", workspaceDir: "/project", createdAt: 1, updatedAt: 1, ...changes,
});

describe("global background tasks", () => {
  it("reports native results returned without inferring review or changing internal completions", () => {
    const native = ticket("native", { status: "ready", externalAgentKind: "codex" });
    expect(taskStatusLabel(native)).toBe("已返回");
    expect(taskStatusLabel({ ...native, externalAgentKind: undefined })).toBe("已完成");
    expect(taskStatusLabel({ ...native, status: "running" })).toBe("运行中");
    expect(taskStatusLabel({ ...native, status: "closed" })).toBe("已关闭");
    expect(taskStatusLabel({ ...native, cleanupPending: true })).toBe("清理待确认");
  });
  it("treats automatic recovery as active work and only asks for attention after exhaustion", () => {
    const recovering = ticket("recovering", { status: "failed", recovery: { state: "recovering", attempts: 1, startedAt: 1, deadlineAt: 600_001 } });
    expect(taskIsRecovering(recovering)).toBe(true);
    expect(taskNeedsAttention(recovering)).toBe(false);
    expect(taskStatusLabel(recovering)).toBe("恢复中");
    const exhausted = { ...recovering, id: "exhausted", recovery: { ...recovering.recovery!, state: "exhausted" as const } };
    expect(taskNeedsAttention(exhausted)).toBe(true);
    expect(taskStatusLabel(exhausted)).toBe("需处理");
    expect(visibleTaskCards([recovering, exhausted], 1, 3).map(t => t.id)).toEqual(["exhausted", "recovering"]);
    expect(taskStatusLabel({ ...recovering, status: "waiting", waiting: { reason: "user", since: 1 } })).toBe("等待确认");
    expect(taskNeedsAttention({ ...recovering, cleanupPending: true })).toBe(true);
  });
  it("orders attention before active work and keeps ordinary updates in place across conversations", () => {
    const older = ticket("older", { originTopicId: "one", createdAt: 2, updatedAt: 100 });
    const newer = ticket("newer", { originTopicId: "two", createdAt: 3, updatedAt: 3 });
    const failed = ticket("failed", { status: "failed", createdAt: 1 });
    expect(visibleTaskCards([older, newer, failed], 101, 3).map(t => t.id)).toEqual(["failed", "newer", "older"]);
    older.updatedAt = 200;
    expect(visibleTaskCards([older, newer, failed], 201, 3).map(t => t.id)).toEqual(["failed", "newer", "older"]);
  });

  it("expires successful work from its completion time and preserves attention and viewed tasks", () => {
    const ready = ticket("ready", { status: "ready", completedAt: hour, updatedAt: 20 * hour });
    expect(taskHasExpired(ready, 4 * hour, 3)).toBe(true);
    expect(taskHasExpired(ready, 40 * hour, null)).toBe(false);
    expect(taskHasExpired({ ...ready, cleanupPending: true }, 40 * hour, 3)).toBe(false);
    expect(taskHasExpired({ ...ready, pendingWorkspaceApply: true }, 40 * hour, 3)).toBe(false);
    expect(taskNeedsAttention({ ...ready, pendingWorkspaceApply: true })).toBe(true);
    expect(taskStatusLabel({ ...ready, pendingWorkspaceApply: true })).toBe("待合入");
    expect(visibleTaskCards([ready, { ...ready, id: "staged-pending", pendingWorkspaceApply: true }], 40 * hour, 3).map(t => t.id)).toEqual(["staged-pending"]);
    expect(visibleTaskCards([ready], 4 * hour, 3, new Set(["ready"]))).toHaveLength(1);
    expect(visibleTaskCards([ready], 4 * hour, 3)).toHaveLength(0);
    expect(taskHasExpired(ticket("failed", { status: "failed" }), 40 * hour, 3)).toBe(false);
    expect(taskHasExpired(ticket("stopped", { status: "stopped" }), 40 * hour, 3)).toBe(false);
  });

  it("uses explicit legacy completion evidence without inventing a completion time", () => {
    const legacy = ticket("legacy", { status: "ready", latestReport: { state: "ready", summary: "done", at: hour }, updatedAt: 20 * hour });
    expect(taskHasExpired(legacy, 4 * hour, 3)).toBe(true);
    expect(taskHasExpired({ ...legacy, latestReport: undefined }, 40 * hour, 3)).toBe(false);
    expect(visibleTaskCards([ticket("closed", { status: "closed" })], 1, null, new Set(["closed"]))).toEqual([]);
  });

  it("counts known running segments and separates queue and wait time", () => {
    const active = ticket("active", { accumulatedRunningMs: 120_000, startedRunningAt: 600_000 });
    expect(taskRunningMs(active, 780_000)).toBe(300_000);
    expect(taskTimeLabel(active, 780_000)).toBe("已运行 5 分钟");
    expect(taskTimeLabel({ ...active, status: "waiting", waiting: { reason: "env", since: 720_000 } }, 780_000)).toBe("已等待 1 分钟");
    expect(taskTimeLabel({ ...active, status: "queued", queuedAt: 720_000 }, 780_000)).toBe("已排队 1 分钟");
    expect(taskRunningMs(ticket("unknown"), 780_000)).toBeUndefined();
    expect(taskTimeLabel(ticket("unknown", { status: "ready" }), 780_000)).toBe("用时未记录");
  });

  it("shows the main Agent dispatch summary until it reviews the Worker result", () => {
    const card = ticket("dispatch-title", { userSummary: "主 Agent 的派单说明", latestReport: { state: "blocked", summary: "正在验证", question: "是否继续？", at: 2 }, status: "waiting", waiting: { reason: "user", since: 2 } });
    expect(taskSummary(card)).toBe("主 Agent 的派单说明");
    expect(card.title).toBe("dispatch-title");
    expect(taskSummary({ ...card, status: "running", waiting: undefined })).toBe("主 Agent 的派单说明");
    expect(taskSummary({ ...card, userSummary: undefined })).toBe(card.title);
  });
});

describe("task row presence", () => {
  it("retains multiple outgoing rows in their original order until exit completes", () => {
    const cards = ["a", "b", "c", "d"].map(id => ticket(id));
    const rows = reconcileTaskRows(cards.map(t => ({ ticket: t, present: true, enter: false })), [cards[0]!, cards[3]!], new Set());
    expect(rows.map(row => [row.ticket.id, row.present])).toEqual([["a", true], ["b", false], ["c", false], ["d", true]]);
  });

  it("cancels an outgoing row when the same task resumes and animates only genuinely new tasks", () => {
    const old = ticket("old", { status: "ready" });
    const resumed = { ...old, status: "running" as const };
    const fresh = ticket("new");
    const rows = reconcileTaskRows([{ ticket: old, present: false, enter: false }], [fresh, resumed], new Set(["new"]));
    expect(rows.map(row => [row.ticket.id, row.present, row.enter])).toEqual([["new", true, true], ["old", true, false]]);
    expect(reconcileTaskRows([], [old], new Set())[0]?.enter).toBe(false);
  });
});
