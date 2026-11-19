import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ContextView, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { createVoiceContext, voiceHistory } from "../packages/hub/src/voice-context.js";
import type { KuloDurableState } from "../packages/hub/src/state.js";

const memory = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../packages/hub/src/hindsight.js", async (load) => ({
  ...await load<typeof import("../packages/hub/src/hindsight.js")>(), executeHindsightTool: memory.execute,
}));
beforeEach(() => { memory.execute.mockReset(); memory.execute.mockResolvedValue({ text: JSON.stringify({ results: [{ text: "用户长期偏好暖色灯光。" }] }) }); });

function contextView(items: Array<{ kind?: string; role?: "user" | "assistant"; text: string; speaker?: "user" | "assistant" }>): ContextView {
  return {
    entries: items.map((item, index) => ({ id: index + 1, kind: item.kind ?? "pi.user", data: { callId: "previous-call", role: item.speaker, text: item.text, createdAt: 1 } })),
    contributions: items.map((item) => [{ role: item.role ?? "user", content: item.text, timestamp: 1 }]),
    messages: [],
  } as unknown as ContextView;
}
function fixture(options: { enabled?: boolean; privateOnly?: boolean; project?: boolean; oversized?: boolean } = {}) {
  const render = vi.fn(async () => "必须只在后端执行的 Router 工具规则");
  const sections = [
    { key: "kulo_orchestrator", render },
    { key: "kulo_identity", render: vi.fn(async () => `生效身份：Kulo，同伴。${options.oversized ? "身份😀".repeat(20000) : ""}`) },
    { key: "kulo_relationship", render: vi.fn(async () => `用户叫小林。${options.oversized ? "关系😀".repeat(20000) : ""}`) },
    { key: "kulo_recent_work", render: vi.fn(async () => "当前项目：灯光改造，正等待用户选择。") },
  ];
  const conversationId = options.project ? 77 : ROOT_CONVERSATION_ID;
  const conversation = { id: conversationId, agent: vi.fn(async () => ({ sections })), context: vi.fn(async () => contextView([
    { text: "普通文字历史" }, { kind: "kulo.voice.transcript", text: "刚才的口头偏好", speaker: "user" },
  ])) } as unknown as Conversation;
  const state = { conversationToTicket: {}, conversationToSubagent: {}, conversationToTopic: { [conversationId]: "topic-one" },
    topics: { "topic-one": { id: "topic-one", conversationId, ...(options.project ? { projectId: "lighting-project" } : {}) } }, tickets: {} } as unknown as KuloDurableState;
  const settings = resolveHubConfig({ memory: { enabled: Boolean(options.enabled), ...(options.privateOnly ? { accessMode: "private-only" } : {}) } });
  return { render, conversation, options: { conversation, harness: {} as Harness, state, memory: settings.memory, agentName: "Kulo", redact: (text: string) => text.replaceAll("sensitive-canary", "[redacted]") } };
}

describe("Live as Kulo's conversational context", () => {
  it("reuses active Kulo persona sections without importing Router-only tools", async () => {
    const f = fixture();
    const result = await createVoiceContext(f.options, BACKGROUND_CONTEXT);
    expect(result.instructions).toContain("生效身份：Kulo，同伴。");
    expect(result.instructions).toContain("用户叫小林");
    expect(result.instructions).toContain("当前项目：灯光改造");
    expect(f.render).not.toHaveBeenCalled();
    expect(result.instructions).not.toContain("必须只在后端执行的 Router 工具规则");
    expect(result.instructions).toContain("Long-term memory (Hindsight) is currently disabled");
    expect(memory.execute).not.toHaveBeenCalled();
    expect(result.history.at(-1)).toEqual({ role: "user", text: "刚才的口头偏好" });
    expect(result.messageIds).toEqual([1, 2]);
  });

  it("recalls as the current Router and keeps shared memory scoped to the current project", async () => {
    const f = fixture({ enabled: true, project: true });
    const result = await createVoiceContext(f.options, BACKGROUND_CONTEXT);
    expect(memory.execute).toHaveBeenCalledTimes(2);
    expect(memory.execute).toHaveBeenCalledWith(expect.objectContaining({ bank: "private", toolName: "hindsight_recall",
      caller: expect.objectContaining({ role: "router", conversationId: "77", projectId: "lighting-project" }),
      args: expect.objectContaining({ scope: "global" }) }));
    expect(memory.execute).toHaveBeenCalledWith(expect.objectContaining({ bank: "shared", toolName: "hindsight_recall",
      caller: expect.objectContaining({ role: "router", projectId: "lighting-project" }), args: expect.objectContaining({ scope: "project" }), signal: expect.any(AbortSignal) }));
    expect(result.instructions).toContain("用户长期偏好暖色灯光");
    expect(result.instructions).toContain("Keep private Identity Agreement, Working Relationship, and personal memory out of delegated Worker tasks");
  });

  it("never queries shared memory on a private-only connection", async () => {
    const f = fixture({ enabled: true, privateOnly: true });
    await createVoiceContext(f.options, BACKGROUND_CONTEXT);
    expect(memory.execute).toHaveBeenCalledOnce();
    expect(memory.execute.mock.calls[0]![0]).toMatchObject({ bank: "private", caller: { role: "router" } });
  });

  it("keeps the persona available when memory retrieval fails and directs missing facts to the backend", async () => {
    memory.execute.mockResolvedValue({ isError: true, text: JSON.stringify({ code: "ISOLATION_UNVERIFIED" }) });
    const result = await createVoiceContext(fixture({ enabled: true }).options, BACKGROUND_CONTEXT);
    expect(result.instructions).toContain("用户叫小林");
    expect(result.instructions).toContain("did not complete on call startup");
    expect(result.instructions).toContain("delegate to the Kulo backend first");
    expect(result.instructions).not.toContain("用户长期偏好暖色灯光");
  });

  it("redacts and bounds multibyte persona and memory before the Live adapter's limit", async () => {
    memory.execute.mockResolvedValue({ text: JSON.stringify({ results: [{ text: `sensitive-canary${"记忆😀".repeat(20000)}` }] }) });
    const result = await createVoiceContext(fixture({ enabled: true, oversized: true }).options, BACKGROUND_CONTEXT);
    expect(Buffer.byteLength(result.instructions)).toBeLessThan(48 * 1024);
    expect(result.instructions).not.toContain("sensitive-canary");
    expect(result.instructions).not.toContain("\uFFFD");
    expect(result.instructions).toContain("[redacted]");
    expect(result.instructions).toContain("Content truncated");
  });
});

describe("hidden speech history", () => {
  it("keeps speaker attribution and compaction summaries without replaying delegation or old memory wrappers", () => {
    const view = contextView([
      { kind: "pi.compaction", text: "此前上下文摘要：用户正在装修。" },
      { text: "普通聊天" },
      { kind: "kulo.voice.transcript", text: "我喜欢自然的灯光。", speaker: "user" },
      { kind: "kulo.voice.transcript", text: "记下了。", speaker: "assistant" },
      { kind: "kulo.voice.delegation", text: "隐藏的内部派单提示" },
      { kind: "kulo.memory-context", text: "过时的记忆包装" },
    ]);
    expect(voiceHistory(view, (text) => text)).toEqual([
      { role: "user", text: "此前上下文摘要：用户正在装修。" }, { role: "user", text: "普通聊天" },
      { role: "user", text: "我喜欢自然的灯光。" }, { role: "assistant", text: "记下了。" },
    ]);
  });

  it("uses only the active context after a reset and caps large histories without invalid Unicode", () => {
    expect(voiceHistory(contextView([{ text: "reset 后的内容" }]), (text) => text)).toEqual([{ role: "user", text: "reset 后的内容" }]);
    const history = voiceHistory(contextView(Array.from({ length: 50 }, (_, index) => ({ text: `${index}: ${"多字节😀".repeat(1500)}` }))), (text) => text);
    expect(history.length).toBeLessThanOrEqual(24);
    expect(history.at(-1)?.text).toMatch(/^49:/);
    expect(history.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(32 * 1024);
    expect(JSON.stringify(history)).not.toContain("\uFFFD");
  });

  it("honors omitted and replaced speech contributions instead of replaying stale stored data", () => {
    const view = contextView([
      { kind: "kulo.voice.transcript", text: "已删除的语音", speaker: "user" },
      { kind: "kulo.voice.transcript", text: "尚未修订的旧文字", speaker: "assistant" },
    ]);
    const edited = { ...view, contributions: [[], [{ role: "user" as const, content: "[KULO_VOICE_CONTEXT: Kulo在通话中说]\n当前生效的修订文字", timestamp: 1 }]] };
    expect(voiceHistory(edited, (text) => text)).toEqual([{ role: "assistant", text: "当前生效的修订文字" }]);
  });
});
