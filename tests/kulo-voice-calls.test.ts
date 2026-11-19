import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ChatDisplayItem, LiveStreamState, VoiceCallEvent } from "@kulo/protocol";
import { KuloVoiceCalls, type KuloVoiceCallsOptions, type VoiceCallScope } from "../packages/hub/src/voice-calls.js";

vi.mock("../packages/hub/src/voice-live-adapters.js", () => ({ openVoiceLive: vi.fn() }));

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: VoiceCallEvent[] = [];
  send(value: string) { this.sent.push(JSON.parse(value) as VoiceCallEvent); }
  close = vi.fn(() => { this.readyState = 3; this.emit("close"); });
  input(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
  ws() { return this as unknown as WebSocket; }
}

const scope = (input: Partial<VoiceCallScope> = {}): VoiceCallScope => ({ topicId: "topic-one", principalId: "owner", clientId: "web-one", commandId: "start-one", ...input });
const idle: LiveStreamState = { busy: false, activeTools: [], queuedCount: 0 };
const message = (id: number, text: string, extra: Partial<ChatDisplayItem> = {}): ChatDisplayItem => ({ id, role: "assistant", text, ...extra });
const managers: KuloVoiceCalls[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(overrides: Partial<KuloVoiceCallsOptions> = {}) {
  const closed = deferred<void>();
  const connection = {
    inputSampleRate: 16000, outputSampleRate: 24000, closed: closed.promise,
    sendAudio: vi.fn(), sendTaskResult: vi.fn(), sendContext: vi.fn(), sendNotification: vi.fn(), setMuted: vi.fn(), close: vi.fn(() => closed.resolve()),
  };
  let upstream!: Parameters<NonNullable<KuloVoiceCallsOptions["openLive"]>>[0];
  const openLive = vi.fn(async (options) => { upstream = options; return connection; }) as NonNullable<KuloVoiceCallsOptions["openLive"]>;
  const config = { provider: "gemini" as const, modelId: "gemini-3.8-live", voice: "Kore", apiKey: "synthetic-key-must-remain-private" };
  const transcript = vi.fn(async () => {});
  const delegate = vi.fn(async () => {});
  const manager = new KuloVoiceCalls({
    voice: { liveConfig: vi.fn(async () => ({ ...config })) },
    context: vi.fn(async () => ({ history: [{ role: "assistant" as const, text: "旧回答" }], instructions: "Reuse the current Kulo backend", messageIds: [1] })),
    transcript, delegate, openLive, ...overrides,
  });
  managers.push(manager);
  return { manager, connection, openLive, transcript, delegate, config, get upstream() { return upstream; } };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  vi.useRealTimers();
});

describe("Hub voice calls", () => {
  it("creates one unpaid pending call across retries and keeps credentials out of browser descriptors", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.manager.create(scope()), f.manager.create(scope())]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ wsPath: `/api/voice/calls/${a.id}/socket`, inputSampleRate: 16000, outputSampleRate: 24000 });
    expect(JSON.stringify(a)).not.toContain(f.config.apiKey);
    expect(f.openLive).not.toHaveBeenCalled();
    await expect(f.manager.create(scope({ commandId: "another" }))).rejects.toMatchObject({ code: "voice_call_active" });
    await expect(f.manager.create(scope({ topicId: "other" }))).rejects.toMatchObject({ code: "voice_call_command_conflict" });
  });

  it("binds attach and hangup to the authenticated principal and closes each transport once", async () => {
    const f = fixture();
    const session = await f.manager.create(scope());
    const socket = new Socket();
    await expect(f.manager.attach(session.id, "someone-else", socket.ws())).rejects.toMatchObject({ status: 403 });
    expect(f.openLive).not.toHaveBeenCalled();
    await f.manager.attach(session.id, "owner", socket.ws());
    await expect(f.manager.attach(session.id, "owner", new Socket().ws())).rejects.toMatchObject({ code: "voice_call_attached" });
    await expect(f.manager.end(session.id, "someone-else")).rejects.toMatchObject({ status: 403 });
    socket.input({ type: "audio", data: Buffer.alloc(3200).toString("base64") });
    expect(f.connection.sendAudio).toHaveBeenCalledOnce();
    await f.manager.end(session.id, "owner");
    await f.manager.end(session.id, "owner");
    expect(socket.close).toHaveBeenCalledOnce();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(socket.sent.at(-1)).toEqual({ type: "state", state: "ended" });
    await expect(f.manager.create(scope())).rejects.toMatchObject({ status: 410 });
  });

  it("expires a call that never attaches without opening an upstream connection", async () => {
    vi.useFakeTimers();
    const f = fixture({ pendingTimeoutMs: 50 });
    const session = await f.manager.create(scope());
    await vi.advanceTimersByTimeAsync(51);
    await expect(f.manager.attach(session.id, "owner", new Socket().ws())).rejects.toMatchObject({ status: 410 });
    expect(f.openLive).not.toHaveBeenCalled();
  });

  it("closes an upstream that finishes opening after the caller has hung up", async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<KuloVoiceCallsOptions["openLive"]>>>>();
    const openLive = vi.fn(() => pending.promise) as NonNullable<KuloVoiceCallsOptions["openLive"]>;
    const f = fixture({ openLive });
    const session = await f.manager.create(scope());
    const socket = new Socket();
    const attaching = f.manager.attach(session.id, "owner", socket.ws());
    await vi.waitFor(() => expect(openLive).toHaveBeenCalledOnce());
    await f.manager.end(session.id, "owner");
    pending.resolve(f.connection);
    await attaching;
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("synchronizes mute and unmute upstream and does not forward muted microphone samples", async () => {
    const f = fixture();
    const session = await f.manager.create(scope());
    const socket = new Socket();
    await f.manager.attach(session.id, "owner", socket.ws());
    socket.input({ type: "mute", muted: true });
    socket.input({ type: "audio", data: Buffer.alloc(3200).toString("base64") });
    expect(f.connection.sendAudio).not.toHaveBeenCalled();
    expect(f.connection.setMuted).toHaveBeenLastCalledWith(true);
    socket.input({ type: "mute", muted: false });
    socket.input({ type: "audio", data: Buffer.alloc(3200).toString("base64") });
    expect(f.connection.setMuted).toHaveBeenLastCalledWith(false);
    expect(f.connection.sendAudio).toHaveBeenCalledOnce();
  });

  it("retains a mute requested during setup and discards pre-mute buffered audio", async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<KuloVoiceCallsOptions["openLive"]>>>>();
    const openLive = vi.fn(() => pending.promise) as NonNullable<KuloVoiceCallsOptions["openLive"]>;
    const f = fixture({ openLive });
    const session = await f.manager.create(scope());
    const socket = new Socket();
    const attaching = f.manager.attach(session.id, "owner", socket.ws());
    await vi.waitFor(() => expect(openLive).toHaveBeenCalledOnce());
    socket.input({ type: "audio", data: Buffer.alloc(3200).toString("base64") });
    socket.input({ type: "mute", muted: true });
    pending.resolve(f.connection);
    await attaching;
    expect(f.connection.sendAudio).not.toHaveBeenCalled();
    expect(f.connection.setMuted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    { type: "audio", data: "not base64" },
    { type: "audio", data: Buffer.from([1]).toString("base64") },
    { type: "audio", data: "AA==", unexpected: true },
    { type: "tool", data: "{}" },
    { type: "audio", data: "A".repeat(100_000) },
  ])("rejects malformed audio instead of forwarding it (%j)", async (input) => {
    const f = fixture();
    const session = await f.manager.create(scope());
    const socket = new Socket();
    await f.manager.attach(session.id, "owner", socket.ws());
    socket.input(input);
    expect(f.connection.sendAudio).not.toHaveBeenCalled();
    expect(socket.sent).toContainEqual({ type: "error", code: "invalid_voice_audio", message: "语音数据格式无效。" });
    expect(f.connection.close).toHaveBeenCalledOnce();
  });

  it("limits rapid PCM uploads and stops a slow browser consumer", async () => {
    const f = fixture({ now: () => 1000 });
    const session = await f.manager.create(scope());
    const socket = new Socket();
    await f.manager.attach(session.id, "owner", socket.ws());
    for (let index = 0; index < 5; index++) socket.input({ type: "audio", data: Buffer.alloc(32000).toString("base64") });
    expect(f.connection.sendAudio).toHaveBeenCalledTimes(4);
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "error", code: "voice_audio_rate_exceeded" }));
    const g = fixture();
    const otherSession = await g.manager.create(scope());
    const slow = new Socket();
    await g.manager.attach(otherSession.id, "owner", slow.ws());
    slow.bufferedAmount = 3 * 1024 * 1024;
    g.upstream.onEvent({ type: "audio", data: "AAAA", sampleRate: 24000 });
    expect(g.connection.close).toHaveBeenCalledOnce();
  });

  it("persists only completed transcript groups and delegates once after transcript persistence", async () => {
    const sequence: string[] = [];
    const f = fixture({ transcript: async () => { sequence.push("transcript"); }, delegate: async () => { sequence.push("delegate"); } });
    const session = await f.manager.create(scope());
    await f.manager.attach(session.id, "owner", new Socket().ws());
    f.upstream.onEvent({ type: "transcript", role: "user", text: "搜索", final: false, id: "turn-1" });
    expect(sequence).toEqual([]);
    const completed: VoiceCallEvent = { type: "transcript", role: "user", text: "搜索并生成报表", final: true, id: "turn-1" };
    f.upstream.onEvent(completed);
    f.upstream.onEvent(completed);
    await f.upstream.onDelegate({ id: "delegation-1", text: "搜索并生成报表" });
    await f.upstream.onDelegate({ id: "delegation-1", text: "搜索并生成报表" });
    await vi.waitFor(() => expect(sequence).toEqual(["transcript", "delegate"]));
    await f.manager.end(session.id, "owner");
    expect(sequence).toEqual(["transcript", "delegate"]);
  });

  it("relays new Router results, excludes historical and voice messages, and deduplicates task progress", async () => {
    const f = fixture();
    f.manager.topicUpdated("topic-one", [message(1, "旧回答")], idle);
    const session = await f.manager.create(scope());
    await f.manager.attach(session.id, "owner", new Socket().ws());
    f.manager.topicUpdated("topic-one", [message(1, "旧回答"), message(2, "普通聊天")], idle);
    expect(f.connection.sendTaskResult).not.toHaveBeenCalled();
    f.connection.sendNotification.mockClear();
    await f.upstream.onDelegate({ id: "delegation-1", text: "生成报表" });
    await vi.waitFor(() => expect(f.delegate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.connection.sendTaskResult).toHaveBeenCalledOnce());
    const messages = [message(1, "旧回答"), message(2, "普通聊天"), message(3, "完整报表已生成"), message(4, "完整报表已生成", { meta: { voiceCallId: session.id } })];
    f.manager.topicUpdated("topic-one", messages, idle);
    f.manager.topicUpdated("topic-one", messages, idle);
    expect(f.connection.sendNotification).toHaveBeenCalledExactlyOnceWith("当前会话的后端更新：\n完整报表已生成", true);
    expect(f.connection.sendTaskResult).toHaveBeenCalledExactlyOnceWith("delegation-1", expect.stringContaining("请求已提交"), true);
    f.manager.taskUpdated("other-topic", "ticket-one", "其他会话的报告", "ready");
    f.manager.taskUpdated("topic-one", "ticket-one", "搜索完成，正在整理", "running");
    f.manager.taskUpdated("topic-one", "ticket-one", "搜索完成，正在整理", "running");
    expect(f.connection.sendNotification).toHaveBeenCalledTimes(2);
    expect(f.connection.sendNotification).toHaveBeenLastCalledWith("工单 ticket-one（running）的更新：\n搜索完成，正在整理", false);
    await f.manager.end(session.id, "owner");
    f.manager.taskUpdated("topic-one", "ticket-one", "全部完成", "ready");
    expect(f.connection.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("keeps interleaved A/B and pre-call task results independent of delegation identities", async () => {
    const f = fixture();
    const session = await f.manager.create(scope());
    await f.manager.attach(session.id, "owner", new Socket().ws());
    await f.upstream.onDelegate({ id: "delegation-A", text: "搜索产品A" });
    await f.upstream.onDelegate({ id: "delegation-B", text: "生成报告B" });
    await vi.waitFor(() => expect(f.connection.sendTaskResult).toHaveBeenCalledTimes(2));
    f.manager.taskUpdated("topic-one", "ticket-B", "报告B完成", "ready");
    f.manager.taskUpdated("topic-one", "ticket-A", "产品A搜索完成", "ready");
    f.manager.taskUpdated("topic-one", "ticket-from-before-call", "旧任务完成", "ready");
    f.manager.topicUpdated("topic-one", [message(1, "旧回答"), message(10, "旧工单的新结果")], idle);
    expect(f.connection.sendTaskResult.mock.calls.map((args) => args[0])).toEqual(["delegation-A", "delegation-B"]);
    expect(f.connection.sendTaskResult.mock.calls.every((args) => String(args[1]).includes("请求已提交"))).toBe(true);
    expect(f.connection.sendNotification.mock.calls).toEqual([
      ["工单 ticket-B（ready）的更新：\n报告B完成", true],
      ["工单 ticket-A（ready）的更新：\n产品A搜索完成", true],
      ["工单 ticket-from-before-call（ready）的更新：\n旧任务完成", true],
      ["当前会话的后端更新：\n旧工单的新结果", true],
    ]);
  });

  it("speaks a committed Router update once after its turn settles without replaying it on future turns", async () => {
    const f = fixture();
    const session = await f.manager.create(scope());
    await f.manager.attach(session.id, "owner", new Socket().ws());
    const a = [message(1, "旧回答"), message(2, "结果A")];
    f.manager.topicUpdated("topic-one", a, { ...idle, busy: true });
    f.manager.topicUpdated("topic-one", a, idle);
    f.manager.topicUpdated("topic-one", a, { ...idle, busy: true });
    const b = [...a, message(3, "结果B")];
    f.manager.topicUpdated("topic-one", b, { ...idle, busy: true });
    f.manager.topicUpdated("topic-one", b, idle);
    expect(f.connection.sendNotification.mock.calls).toEqual([
      ["当前会话的后端更新：\n结果A", false],
      ["当前会话的后端更新：\n结果A", true],
      ["当前会话的后端更新：\n结果B", false],
      ["当前会话的后端更新：\n结果B", true],
    ]);
  });

  it("seeds existing completed tasks before a call and only notifies later task changes", async () => {
    const f = fixture();
    f.manager.taskUpdated("topic-one", "old-completed", "此前已完成的报告", "ready");
    f.manager.taskUpdated("topic-one", "old-running", "此前正在搜索", "running");
    const session = await f.manager.create(scope());
    await f.manager.attach(session.id, "owner", new Socket().ws());
    f.manager.taskUpdated("topic-one", "old-completed", "此前已完成的报告", "ready");
    f.manager.taskUpdated("topic-one", "old-running", "此前正在搜索", "running");
    expect(f.connection.sendNotification).not.toHaveBeenCalled();
    f.manager.taskUpdated("topic-one", "old-running", "搜索结果已整理完成", "ready");
    f.manager.taskUpdated("topic-one", "old-completed", "报告新增了价格对比", "ready");
    expect(f.connection.sendNotification.mock.calls).toEqual([
      ["工单 old-running（ready）的更新：\n搜索结果已整理完成", true],
      ["工单 old-completed（ready）的更新：\n报告新增了价格对比", true],
    ]);
  });

  it("includes task baselines seeded by the context callback before create returns", async () => {
    let manager!: KuloVoiceCalls;
    const f = fixture({ context: async () => {
      manager.taskUpdated("topic-one", "existing-report", "早已生成的报表", "ready");
      return { history: [], instructions: "Reuse Kulo", messageIds: [] };
    } });
    manager = f.manager;
    const session = await manager.create(scope());
    await manager.attach(session.id, "owner", new Socket().ws());
    manager.taskUpdated("topic-one", "existing-report", "早已生成的报表", "ready");
    expect(f.connection.sendNotification).not.toHaveBeenCalled();
    manager.taskUpdated("topic-one", "existing-report", "已按新要求更新报表", "ready");
    expect(f.connection.sendNotification).toHaveBeenCalledExactlyOnceWith("工单 existing-report（ready）的更新：\n已按新要求更新报表", true);
  });

  it.each([42, "router"] as const)("does not replay prior failure %s on passive transcript refresh, but announces a new failure once", async (priorFailureTaskId) => {
    const priorFailure: NonNullable<LiveStreamState["runFailure"]> = {
      ...(typeof priorFailureTaskId === "number" ? { taskId: priorFailureTaskId } : {}),
      reason: "model_error", detail: "A failure from before this call",
    };
    let manager!: KuloVoiceCalls;
    const transcript = vi.fn(async () => {
      manager.topicUpdated("topic-one", [message(1, "旧回答")], { ...idle, runFailure: priorFailure });
    });
    const f = fixture({ transcript, context: async () => ({
      history: [], instructions: "Reuse Kulo", messageIds: [1], priorFailureTaskId,
    }) });
    manager = f.manager;
    const session = await manager.create(scope());
    await manager.attach(session.id, "owner", new Socket().ws());
    f.upstream.onEvent({ type: "transcript", role: "user", text: "你好", final: true, id: "greeting" });
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledOnce());
    manager.topicUpdated("topic-one", [message(1, "旧回答")], { ...idle, runFailure: priorFailure });
    expect(f.connection.sendNotification).not.toHaveBeenCalled();
    manager.topicUpdated("topic-one", [message(1, "旧回答")], idle);
    const newFailure = { ...idle, runFailure: { taskId: 99, reason: "model_error", detail: "A new failure during this call" } };
    manager.topicUpdated("topic-one", [message(1, "旧回答")], newFailure);
    manager.topicUpdated("topic-one", [message(1, "旧回答")], newFailure);
    expect(f.connection.sendNotification).toHaveBeenCalledExactlyOnceWith("当前会话处理遇到错误，详细信息已保留在聊天中。", true);
  });

  it("surfaces a failed transcript write without exposing backend errors", async () => {
    const f = fixture({ transcript: async () => { throw new Error("synthetic-key-must-remain-private"); } });
    const session = await f.manager.create(scope());
    const socket = new Socket();
    await f.manager.attach(session.id, "owner", socket.ws());
    f.upstream.onEvent({ type: "transcript", role: "assistant", text: "你好", final: true, id: "turn-one" });
    await vi.waitFor(() => expect(f.connection.close).toHaveBeenCalledOnce());
    expect(socket.sent).toContainEqual({ type: "error", code: "voice_history_failed", message: "保存通话记录失败，请重试。" });
    expect(JSON.stringify(socket.sent)).not.toContain(f.config.apiKey);
  });
});
