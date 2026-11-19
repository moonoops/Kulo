import { describe, expect, it } from "vitest";
import type { ChatDisplayItem, LiveStreamState, TicketCardView } from "@moco/protocol";
import { updateAgentTerminal, type AgentTerminalState } from "./agent-terminal-state";

const live = (patch: Partial<LiveStreamState> = {}): LiveStreamState => ({ busy: false, activeTools: [], queuedCount: 0, ...patch });
const messages: ChatDisplayItem[] = [{ id: 1, role: "user", text: "检查项目" }, { id: 2, role: "assistant", text: "已检查" }];
const ticket: TicketCardView = { id: "t", title: "检查项目", role: "developer", roleLabel: "开发", status: "running", envId: "local", workspaceDir: "/tmp", createdAt: 1, updatedAt: 1, originTopicId: "root" };
const texts = (state: AgentTerminalState) => state.entries.map((entry) => entry.text);

describe("agent terminal execution journal", () => {
  it("orders a running snapshot before its restored steps and avoids repeating the same thinking", () => {
    const thinking = "检查项目结构";
    const state = updateAgentTerminal(null, { topicId: "root", messages: [{ id: 1, role: "user", text: "检查" },
      { id: 2, role: "assistant", text: "", thinking }], live: live({ busy: true, streamingThinking: thinking }) });
    expect(texts(state)).toEqual(["开始执行", "思考中 · 检查项目结构"]);
  });

  it("records a retry once while its thinking and tool output snapshots keep arriving", () => {
    const retrying = { attempt: 1, at: 123 };
    let state = updateAgentTerminal(null, { topicId: "root", live: live({ busy: true, retrying, streamingThinking: "检查" }) });
    for (let index = 0; index < 4; index++) {
      state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, retrying, streamingThinking: `检查${index}`,
        activeTools: [{ callId: "r", name: "read", outputTail: `输出${index}` }] }) });
    }
    expect(texts(state).filter((text) => text.startsWith("重试"))).toEqual(["重试 · 第 1 次"]);
    state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, retrying: { attempt: 2, at: 124 } }) });
    expect(texts(state).filter((text) => text.startsWith("重试"))).toHaveLength(2);
  });

  it("updates accumulated thinking in place and retains completion across idle snapshots", () => {
    let state = updateAgentTerminal(null, { topicId: "root", live: live({ busy: true, streamingThinking: "先检查" }) });
    const id = state.entries.at(-1)!.id;
    state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, streamingThinking: "先检查，再验证" }) });
    expect(state.entries).toHaveLength(2);
    expect(state.entries.at(-1)).toMatchObject({ id, text: "思考中 · 先检查，再验证" });
    state = updateAgentTerminal(state, { topicId: "root", live: live() });
    expect(state.entries.at(-1)).toMatchObject({ text: "执行完成", tone: "done", outcome: "completed", eventAt: expect.any(Number) });
    expect(state.entries.at(-1)?.eventId).toBe(`${state.entries.at(-1)!.id}:completed`);
    expect(updateAgentTerminal(state, { topicId: "root", live: live() }).entries).toEqual(state.entries);
  });

  it("deduplicates message/live tool calls and updates multiple tool outputs without token rows", () => {
    const calls = [{ callId: "a", name: "read", outputTail: "第一段" }, { callId: "b", name: "search", outputTail: "找到一项" }];
    let state = updateAgentTerminal(null, { topicId: "root", messages: [{ id: 3, role: "assistant", text: "", toolCalls: [{ id: "a", name: "read", argsSummary: "" }] }], live: live({ busy: true, activeTools: calls }) });
    const size = state.entries.length;
    state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, activeTools: calls.map((call) => ({ ...call, outputTail: call.outputTail + "，新增输出" })) }) });
    expect(state.entries).toHaveLength(size);
    expect(texts(state).filter((text) => text === "调用工具 · read")).toHaveLength(1);
    expect(texts(state)).toContain("工具输出 · 第一段，新增输出");
    state = updateAgentTerminal(state, { topicId: "root", live: live() });
    expect(texts(state)).toContain("调用结束 · read");
    expect(texts(state).filter((text) => text.includes("成功"))).toHaveLength(0);
  });

  it("restores the latest turn after refresh, including rapid tools absent from active snapshots", () => {
    const history: ChatDisplayItem[] = [{ id: 0, role: "assistant", text: "旧回复", thinking: "旧思考" }, ...messages.slice(0, 1),
      { id: 2, role: "assistant", text: "", thinking: "检查代码", toolCalls: [{ id: "x", name: "read", argsSummary: "" }] },
      { id: 3, role: "assistant", text: "完成" }];
    const state = updateAgentTerminal(null, { topicId: "root", messages: history, live: live() });
    expect(texts(state)).not.toContain("思考中 · 旧思考");
    expect(texts(state)).toContain("思考中 · 检查代码");
    expect(texts(state)).toContain("调用结束 · read");
    expect(state.entries.at(-1)?.text).toBe("执行完成");
    expect(updateAgentTerminal(state, { topicId: "root", messages: history, live: live() }).entries).toEqual(state.entries);
  });

  it("does not fabricate completion before the matching live state arrives on topic change", () => {
    const old = updateAgentTerminal(null, { topicId: "old", live: live({ busy: true }) });
    let next = updateAgentTerminal(old, { topicId: "new", messages });
    expect(texts(next)).not.toContain("执行完成");
    expect(next.busy).toBe(false);
    next = updateAgentTerminal(next, { topicId: "new", live: live({ busy: true }) });
    expect(texts(next)).not.toContain("执行完成");
    expect(next.entries.every((entry) => entry.id.startsWith("new:"))).toBe(true);
    expect(updateAgentTerminal(next, { topicId: "new", live: live() }).entries.at(-1)?.text).toBe("执行完成");
  });

  it("distinguishes success, failure, deliberate stop and interrupted abort", () => {
    for (const [reason, detail, expected] of [["aborted", undefined, "已停止"], ["model_error", "503", "执行失败"], ["aborted", "进程中断", "执行失败"]] as const) {
      let state = updateAgentTerminal(null, { topicId: "root", messages, live: live({ runFailure: { reason, detail } }) });
      expect(state.entries.at(-1)?.text).toMatch(expected);
      expect(state.entries.at(-1)?.outcome).toBe(reason === "aborted" && !detail ? "stopped" : "failed");
      const settled = state.entries;
      state = updateAgentTerminal(state, { topicId: "root", live: live() });
      expect(state.entries).toEqual(settled);
      state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true }) });
      state = updateAgentTerminal(state, { topicId: "root", live: live() });
      expect(state.entries.at(-1)?.text).toBe("执行完成");
    }
  });

  it("distinguishes settlement changes even when the journal stage retains its row ID", () => {
    let state = updateAgentTerminal(null, { topicId: "root", live: live({ runFailure: { reason: "aborted" } }) });
    const stopped = state.entries.at(-1)!;
    expect(stopped).toMatchObject({ outcome: "stopped", eventId: `${stopped.id}:stopped` });
    state = updateAgentTerminal(state, { topicId: "root", live: live({ runFailure: { reason: "model_error", detail: "503" } }) });
    expect(state.entries.at(-1)).toMatchObject({ id: stopped.id, outcome: "failed", eventId: `${stopped.id}:failed` });
    state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true }) });
    state = updateAgentTerminal(state, { topicId: "root", live: live() });
    expect(state.entries.at(-1)).toMatchObject({ outcome: "completed" });
    expect(state.entries.at(-1)?.eventId).not.toBe(stopped.eventId);
  });

  it("keeps task completion identity stable through report edits and does not celebrate closed or stopped tasks", () => {
    let state = updateAgentTerminal(null, { topicId: "root", tickets: [ticket] });
    const ready: TicketCardView = { ...ticket, status: "ready", completedAt: 5, updatedAt: 6 };
    state = updateAgentTerminal(state, { topicId: "root", tickets: [ready] });
    expect(state.entries.at(-1)).toMatchObject({ tone: "done", outcome: "completed", eventId: "ticket:t:completed:5", eventAt: 5 });
    const completedId = state.entries.at(-1)!.id;
    state = updateAgentTerminal(state, { topicId: "root", tickets: [{ ...ready, userSummary: "补充完成说明", updatedAt: 7 }] });
    expect(state.entries.at(-1)).toMatchObject({ eventId: "ticket:t:completed:5", eventAt: 5 });
    expect(state.entries.at(-1)?.id).not.toBe(completedId);
    state = updateAgentTerminal(state, { topicId: "root", tickets: [{ ...ready, status: "closed", updatedAt: 8 }] });
    expect(state.entries.at(-1)).toMatchObject({ tone: "info", outcome: "closed", eventId: "ticket:t:closed:8" });
    state = updateAgentTerminal(state, { topicId: "root", tickets: [{ ...ready, status: "stopped", updatedAt: 9 }] });
    expect(state.entries.at(-1)).toMatchObject({ tone: "info", outcome: "stopped", eventId: "ticket:t:stopped:9" });
  });

  it("retains settlement provenance when cleanup keeps the visible task label unchanged", () => {
    let state = updateAgentTerminal(null, { topicId: "root", tickets: [{ ...ticket, status: "ready", completedAt: 5, cleanupPending: true }] });
    state = updateAgentTerminal(state, { topicId: "root", tickets: [{ ...ticket, status: "closed", updatedAt: 6, cleanupPending: true }] });
    expect(state.entries.at(-1)).toMatchObject({ tone: "info", outcome: "closed", eventId: "ticket:t:closed:6" });
  });

  it("scopes background progress, baselines history and uses task waiting labels", () => {
    const historical = Array.from({ length: 10 }, (_, index) => ({ ...ticket, id: `old-${index}`, status: "ready" as const, updatedAt: index }));
    let state = updateAgentTerminal(null, { topicId: "root", tickets: [...historical, ticket, { ...ticket, id: "other", originTopicId: "other" }] });
    expect(state.entries).toHaveLength(2);
    expect(texts(state).filter((text) => text.startsWith("已完成"))).toHaveLength(1);
    const unchanged = updateAgentTerminal(state, { topicId: "root", tickets: [...historical, { ...ticket, updatedAt: 99 }] });
    expect(unchanged.entries).toEqual(state.entries);
    const waiting = { ...ticket, status: "waiting" as const, waiting: { reason: "user" as const, since: 2, detail: "是否继续？" } };
    state = updateAgentTerminal(unchanged, { topicId: "root", tickets: [...historical, waiting] });
    expect(state.entries.at(-1)?.text).toBe("等待确认 · 检查项目");
    expect(state.entries.at(-1)?.text).not.toContain("是否继续？");
    state = updateAgentTerminal(state, { topicId: "root", tickets: [{ ...ticket, status: "ready", latestReport: { state: "ready", summary: "验证通过", at: 3 } }] });
    expect(state.entries.at(-1)).toMatchObject({ text: "已完成 · 检查项目", tone: "done" });
    expect(state.entries.at(-1)?.text).not.toContain("验证通过");
  });

  it("bounds the journal and preserves ordered, unique IDs through repeated runs", () => {
    let state: AgentTerminalState | null = null;
    for (let index = 0; index < 60; index++) {
      state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, retrying: { attempt: index, at: index } }) });
      state = updateAgentTerminal(state, { topicId: "root", live: live() });
    }
    expect(state!.entries).toHaveLength(80);
    expect(new Set(state!.entries.map((entry) => entry.id)).size).toBe(80);
    const sequences = state!.entries.map((entry) => Number(entry.id.split(":").at(-1)));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("bounds remembered tools across runs while keeping active tools available for completion", () => {
    let state: AgentTerminalState | null = null;
    for (let index = 0; index < 100; index++) {
      state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, activeTools: [{ callId: `call-${index}`, name: "read" }] }) });
      state = updateAgentTerminal(state, { topicId: "root", live: live() });
    }
    expect(Object.keys(state!.tools)).toHaveLength(80);
    expect(state!.tools["call-0"]).toBeUndefined();
    expect(state!.tools["call-99"]?.ended).toBe(true);
    const activeTools = Array.from({ length: 90 }, (_, index) => ({ callId: `active-${index}`, name: "read" }));
    state = updateAgentTerminal(state, { topicId: "root", live: live({ busy: true, activeTools }) });
    expect(activeTools.every((tool) => state!.tools[tool.callId])).toBe(true);
    state = updateAgentTerminal(state, { topicId: "root", live: live() });
    expect(Object.keys(state.tools)).toHaveLength(80);
    expect(texts(state)).toContain("调用结束 · read");
  });
});
