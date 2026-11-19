import { describe, expect, it } from "vitest";
import type { LiveStreamState, TicketCardView } from "@kulo/protocol";
import { agentProfileActivity, agentProfileCompletions } from "./agent-profile-state";

const live = (patch: Partial<LiveStreamState> = {}): LiveStreamState => ({ busy: false, activeTools: [], queuedCount: 0, ...patch });
const task: TicketCardView = { id: "other", title: "核对文档", role: "developer", roleLabel: "开发", status: "running", envId: "local", workspaceDir: "/tmp", originTopicId: "another-topic", createdAt: 1, updatedAt: 1 };

describe("agent profile activity", () => {
  it("separates connectivity from work and never animates stale progress as current work", () => {
    expect(agentProfileActivity({ connected: false, live: live({ busy: true }), tickets: [task], entries: [] })).toMatchObject({ state: "offline", label: "连接中…" });
    expect(agentProfileActivity({ connected: true, live: live(), tickets: [], entries: [{ id: "old", text: "调用工具 · read", tone: "tool" }] })).toEqual({ state: "idle", label: "等待任务" });
  });

  it("distinguishes tool execution, active reply growth and thinking", () => {
    expect(agentProfileActivity({ connected: true, live: live({ busy: true, activeTools: [{ callId: "read", name: "read" }] }), tickets: [], entries: [] })).toMatchObject({ state: "working", label: "正在执行", detail: "read" });
    expect(agentProfileActivity({ connected: true, live: live({ busy: true, streamingText: "回复中" }), tickets: [], entries: [] })).toMatchObject({ state: "speaking", label: "正在回复" });
    expect(agentProfileActivity({ connected: true, live: live({ busy: true, streamingText: "已经输出的文字" }), replyActive: false, tickets: [], entries: [] })).toMatchObject({ state: "thinking", label: "正在思考" });
    expect(agentProfileActivity({ connected: true, live: live({ busy: true, streamingThinking: "正在检查" }), tickets: [], entries: [] })).toMatchObject({ state: "thinking" });
    expect(agentProfileActivity({ connected: true, live: live({ streamingText: "旧回复" }), tickets: [], entries: [] })).toMatchObject({ state: "idle" });
  });

  it("keeps background work visible after navigating to another topic", () => {
    expect(agentProfileActivity({ connected: true, live: live(), tickets: [task], entries: [] })).toMatchObject({ state: "working", detail: "核对文档" });
    expect(agentProfileActivity({ connected: true, tickets: [{ ...task, status: "waiting", waiting: { reason: "user", since: 1 } }], entries: [] })).toMatchObject({ state: "waiting", label: "等待确认" });
    expect(agentProfileActivity({ connected: true, tickets: [{ ...task, status: "blocked" }], entries: [] })).toMatchObject({ state: "waiting", label: "需要处理" });
  });

  it("distinguishes failure and completion after execution stops", () => {
    expect(agentProfileActivity({ connected: true, tickets: [], entries: [{ id: "e", tone: "error", text: "执行失败 · 连接中断" }] })).toMatchObject({ state: "error", tone: "danger" });
    expect(agentProfileActivity({ connected: true, tickets: [], entries: [{ id: "d", tone: "done", outcome: "completed", eventAt: 10, text: "执行完成" }] })).toMatchObject({ state: "success", label: "已完成", eventId: "d:completed", eventAt: 10 });
    expect(agentProfileActivity({ connected: true, tickets: [], live: live({ runFailure: { reason: "aborted" } }), entries: [{ id: "d", tone: "done", outcome: "completed", text: "旧的执行完成" }] })).toMatchObject({ state: "idle", label: "已停止" });
    expect(agentProfileActivity({ connected: true, tickets: [], live: live({ runFailure: { reason: "aborted", detail: "进程中断" } }), entries: [] })).toMatchObject({ state: "error", tone: "danger" });
    expect(agentProfileActivity({ connected: true, tickets: [], live: live({ runFailure: { reason: "model_error", detail: "503" } }), entries: [] })).toMatchObject({ state: "error", tone: "danger" });
  });

  it.each([
    [undefined, "等待中"], ["env", "等待设备"], ["time", "等待时间"], ["external", "等待外部结果"], ["project", "等待项目"], ["connection", "等待连接"],
  ] as const)("does not ask the user to act on a passive %s wait", (reason, label) => {
    expect(agentProfileActivity({ connected: true, tickets: [{ ...task, status: "waiting", waiting: reason ? { reason, since: 1 } : undefined }], entries: [] })).toMatchObject({ state: "idle", label });
  });

  it("keeps retry and queue waits quiet and recovery visibly working", () => {
    expect(agentProfileActivity({ connected: true, live: live({ busy: true, retrying: { attempt: 1, at: 1 } }), tickets: [], entries: [] })).toMatchObject({ state: "idle", label: "正在重试" });
    expect(agentProfileActivity({ connected: true, tickets: [{ ...task, status: "queued" }], entries: [] })).toMatchObject({ state: "idle", label: "等待执行" });
    expect(agentProfileActivity({ connected: true, tickets: [{ ...task, status: "failed", recovery: { state: "recovering", attempts: 1, startedAt: 1, deadlineAt: 100 } }], entries: [] })).toMatchObject({ state: "working", label: "恢复中" });
  });

  it("prioritizes foreground progress, then actionable attention over ordinary background execution", () => {
    const waiting: TicketCardView = { ...task, id: "wait", status: "waiting", waiting: { reason: "user", since: 1 } };
    expect(agentProfileActivity({ connected: true, live: live({ busy: true }), tickets: [task, waiting], entries: [] })).toMatchObject({ state: "thinking" });
    expect(agentProfileActivity({ connected: true, tickets: [task, waiting], entries: [] })).toMatchObject({ state: "waiting", label: "等待确认" });
    expect(agentProfileActivity({ connected: true, tickets: [task, { ...task, id: "failed", status: "failed" }], entries: [] })).toMatchObject({ state: "error" });
    expect(agentProfileActivity({ connected: true, tickets: [{ ...task, status: "ready", cleanupPending: true }], entries: [] })).toMatchObject({ state: "waiting", label: "清理待确认" });
    expect(agentProfileActivity({ connected: true, live: live({ busy: true, activeTools: [{ callId: "read", name: "read" }], streamingText: "已有文字" }), tickets: [], entries: [] })).toMatchObject({ state: "working" });
  });

  it("never treats a closed row, deliberately stopped run or unstructured done row as success", () => {
    for (const entry of [
      { id: "closed", tone: "done" as const, outcome: "closed" as const, text: "已关闭" },
      { id: "legacy", tone: "done" as const, text: "旧状态" },
      { id: "stopped", tone: "info" as const, outcome: "stopped" as const, text: "已停止" },
    ]) expect(agentProfileActivity({ connected: true, tickets: [], entries: [entry] })).toMatchObject({ state: "idle" });
  });

  it("provides stable completion IDs and lets new background completion supersede a restored chat completion", () => {
    const ready: TicketCardView = { ...task, status: "ready", completedAt: 20, updatedAt: 30 };
    const entry = { id: "root:3", tone: "done" as const, outcome: "completed" as const, eventAt: 10, text: "执行完成" };
    expect(agentProfileActivity({ connected: true, tickets: [ready], entries: [entry] })).toMatchObject({ state: "success", eventId: "ticket:other:completed:20", eventAt: 20 });
    expect(agentProfileActivity({ connected: true, tickets: [{ ...ready, updatedAt: 100, userSummary: "编辑说明" }], entries: [entry] })).toMatchObject({ eventId: "ticket:other:completed:20" });
    expect(agentProfileActivity({ connected: true, tickets: [ready], entries: [{ ...entry, eventAt: 40 }] })).toMatchObject({ eventId: "root:3:completed", eventAt: 40 });
    expect(agentProfileCompletions({ tickets: [ready, { ...task, id: "closed", status: "closed" }], entries: [entry, { ...entry, id: "ticket-row", eventAt: 20, eventId: "ticket:other:completed:20" }] })).toEqual([
      { eventId: "ticket:other:completed:20", eventAt: 20 }, { eventId: "root:3:completed", eventAt: 10 },
    ]);
  });
});
