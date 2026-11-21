import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { VoiceCallEvent } from "@kulo/protocol";
import { openVoiceLive, probeVoiceLive, type VoiceLiveConfig } from "../packages/hub/src/voice-live-adapters.js";

interface Socket {
  url: string;
  options: { headers: Record<string, string>; agent?: unknown };
  readyState: number;
  bufferedAmount: number;
  sent: Record<string, any>[];
  terminated: boolean;
  open(): void;
  receive(message: unknown): void;
  emit(name: string, ...args: any[]): boolean;
  terminate(): void;
}
const network = vi.hoisted(() => ({ sockets: [] as Socket[], finalize: true }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent: Record<string, any>[] = [];
    terminated = false;
    constructor(readonly url: string, readonly options: { headers: Record<string, string>; agent?: unknown }) { super(); network.sockets.push(this); }
    open() { this.readyState = 1; this.emit("open"); }
    receive(message: unknown) { this.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message))); }
    send(data: string, callback?: (error?: Error) => void) {
      const message = JSON.parse(data);
      this.sent.push(message); callback?.();
      if (message.type === "session.close" && network.finalize) queueMicrotask(() => this.receive({ type: "session.closed" }));
    }
    close(code = 1000) { this.readyState = 3; this.emit("close", code, Buffer.alloc(0)); }
    terminate() { this.terminated = true; this.readyState = 3; this.emit("close", 1006, Buffer.alloc(0)); }
  } };
});

const config = (provider: VoiceLiveConfig["provider"] = "openai", modelId = provider === "openai" ? "gpt-live-1" : "gemini-3.8-live"): VoiceLiveConfig => ({ provider, modelId, voice: provider === "openai" ? "marin" : "Kore", apiKey: "fixture-private-key" });
function begin(provider: VoiceLiveConfig["provider"] = "openai", modelId?: string, extra: Partial<Parameters<typeof openVoiceLive>[0]> = {}) {
  const events: VoiceCallEvent[] = [];
  const delegated = vi.fn();
  const promise = openVoiceLive({ ...config(provider, modelId), onEvent: (event) => events.push(event), onDelegate: delegated, ...extra });
  const socket = network.sockets.at(-1)!;
  return { promise, socket, events, delegated };
}
async function ready(provider: VoiceLiveConfig["provider"] = "openai", modelId?: string, extra: Partial<Parameters<typeof openVoiceLive>[0]> = {}) {
  const started = begin(provider, modelId, extra);
  started.socket.open();
  started.socket.receive(provider === "openai" ? { type: "session.started", session: { id: "fixture-live" } } : { setupComplete: {} });
  return { ...started, connection: await started.promise };
}

beforeEach(() => {
  vi.useFakeTimers(); network.sockets.length = 0; network.finalize = true;
  for (const name of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) vi.stubEnv(name, "");
});
afterEach(() => { for (const socket of network.sockets) socket.terminate(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Live voice provider adapters", () => {
  it("waits for OpenAI session.started and uses the dedicated GPT-Live protocol", async () => {
    const { promise, socket, events } = begin("openai", undefined, { history: [{ role: "user", text: "请继续上次的报表" }, { role: "assistant", text: "正在整理" }] });
    let resolved = false; void promise.then(() => { resolved = true; });
    socket.open(); await Promise.resolve();
    expect(resolved).toBe(false);
    expect(socket.url).toBe("wss://api.openai.com/v1/live/sessions");
    expect(socket.options.headers).toEqual({ Authorization: "Bearer fixture-private-key" });
    expect(socket.sent[0]).toMatchObject({ type: "session.start", session: { model: "gpt-live-1", store: false, delegation: { type: "client" }, audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } }, input: [{ role: "user", content: [{ type: "input_text", text: "请继续上次的报表" }] }, { role: "assistant", content: [{ type: "output_text", text: "正在整理" }] }] } });
    socket.receive({ type: "session.started", session: { id: "fixture-live" } });
    const connection = await promise;
    expect(connection.inputSampleRate).toBe(24000);
    expect(events.at(-1)).toEqual({ type: "state", state: "listening" });
    connection.close(); await connection.closed;
  });

  it("uses the official projectless Vertex Key handshake without ADC or project fields", async () => {
    const { socket, connection } = await ready("vertex", "gemini-live-2.5-flash-native-audio");
    expect(socket.url).toBe("wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent");
    expect(socket.options.headers).toEqual({ "x-goog-api-key": "fixture-private-key" });
    expect(socket.sent[0]).toMatchObject({ setup: { model: "publishers/google/models/gemini-live-2.5-flash-native-audio", generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } }, inputAudioTranscription: {}, outputAudioTranscription: {} } });
    expect(JSON.stringify(socket.sent)).not.toMatch(/projects\/|locations\/|fixture-private-key/);
    expect(connection.inputSampleRate).toBe(16000);
    connection.close(); await connection.closed;
  });

  it("scopes Gemini Key to the fixed official endpoint and preserves proxy routing", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8080");
    const { socket, connection } = await ready("gemini");
    expect(socket.url).toBe("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=fixture-private-key");
    expect(socket.options.agent).toMatchObject({ proxy: new URL("http://127.0.0.1:8080") });
    connection.sendAudio(Buffer.alloc(320).toString("base64"));
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { audio: { data: Buffer.alloc(320).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
    connection.close(); await connection.closed;
  });

  it("rejects malformed Key/model/audio before leaking or forwarding data", async () => {
    await expect(openVoiceLive({ ...config(), apiKey: "key\r\ninjected", onEvent: vi.fn(), onDelegate: vi.fn() })).rejects.toMatchObject({ code: "voice_live_missing_credential" });
    await expect(openVoiceLive({ ...config(), modelId: "gpt-live-1?key=elsewhere", onEvent: vi.fn(), onDelegate: vi.fn() })).rejects.toMatchObject({ code: "voice_live_invalid_model" });
    expect(network.sockets).toHaveLength(0);
    const { connection, socket } = await ready();
    const sent = socket.sent.length;
    expect(() => connection.sendAudio("not base64!")).toThrow("实时音频格式无效");
    expect(() => connection.sendAudio(Buffer.alloc(3).toString("base64"))).toThrow("完整的 PCM16");
    expect(socket.sent).toHaveLength(sent);
    connection.close(); await connection.closed;
  });

  it("handles actual PCM output, interruption, and cumulative transcript groups", async () => {
    const { socket, events, connection } = await ready();
    socket.receive({ type: "session.output_audio.delta", delta: Buffer.alloc(2400).toString("base64") });
    socket.receive({ type: "session.input_transcript.delta", delta: "请搜索", start_ms: 1000, end_ms: 1300 });
    socket.receive({ type: "session.output_transcript.delta", delta: "好的", start_ms: 1250, end_ms: 1400 });
    socket.receive({ type: "session.input_transcript.delta", delta: "并生成报表", start_ms: 1300, end_ms: 1800 });
    expect(events).toContainEqual({ type: "interrupted" });
    expect(events.find((event) => event.type === "audio")).toMatchObject({ sampleRate: 24000 });
    const user = events.filter((event) => event.type === "transcript" && event.role === "user");
    expect(user).toHaveLength(2);
    expect(user[1]).toMatchObject({ id: (user[0] as { id: string }).id, text: "请搜索并生成报表", final: false });
    connection.close(); await connection.closed;
    expect(events).toContainEqual(expect.objectContaining({ type: "transcript", role: "user", text: "请搜索并生成报表", final: true }));
  });

  it("correlates OpenAI client delegations, deduplicates delivery and sends bounded results", async () => {
    const { socket, delegated, connection } = await ready();
    const event = { type: "session.delegation.created", offset_ms: 1000, delegation: { id: "del_1", target: "client", type: "delegation" } };
    socket.receive(event);
    socket.receive({ type: "session.input_transcript.delta", delta: "搜索资料并生成报表", start_ms: 0, end_ms: 1000 });
    socket.receive(event);
    await vi.advanceTimersByTimeAsync(150);
    expect(delegated).toHaveBeenCalledExactlyOnceWith({ id: "del_1", text: "搜索资料并生成报表" });
    connection.sendTaskResult("del_1", "正在执行", false);
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: "del_1", content: "正在执行" });
    const text = "报表已生成。".repeat(100);
    const before = socket.sent.length;
    connection.sendTaskResult("del_1", text);
    const results = socket.sent.slice(before);
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((result) => result.type === "session.commentary.append" && result.delegation_id === "del_1" && Buffer.byteLength(result.content) <= 450)).toBe(true);
    expect(results.map((result) => result.content).join("")).toBe(text);
    expect(() => connection.sendTaskResult("unknown", "结果")).toThrow("任务标识无效");
    connection.close(); await connection.closed;
  });

  it("sends independent task notifications without attributing them to the latest delegation", async () => {
    const { socket, connection } = await ready();
    connection.sendNotification("工单 ticket_A 的报表已生成。", true);
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.commentary.append", delegation_id: null, content: "工单 ticket_A 的报表已生成。" });
    connection.sendContext("工单 ticket_B 仍在执行。");
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: null });
    connection.close(); await connection.closed;
  });

  it("uses the delegation timeline instead of a newer user utterance received during dispatch delay", async () => {
    const { socket, connection, delegated } = await ready();
    socket.receive({ type: "session.input_transcript.delta", delta: "搜索产品 A", start_ms: 100, end_ms: 900 });
    socket.receive({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "del_A", target: "client" } });
    socket.receive({ type: "session.input_transcript.delta", delta: "另外写产品 B 的报告", start_ms: 1100, end_ms: 1900 });
    await vi.advanceTimersByTimeAsync(150);
    expect(delegated).toHaveBeenNthCalledWith(1, { id: "del_A", text: "搜索产品 A" });
    socket.receive({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "del_B", target: "client" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(delegated).toHaveBeenNthCalledWith(2, { id: "del_B", text: "另外写产品 B 的报告" });
    connection.close(); await connection.closed;
  });

  it("uses nonblocking Gemini function responses and preserves task identity", async () => {
    const { socket, connection, delegated } = await ready("gemini");
    expect(socket.sent[0]!.setup.tools[0].functionDeclarations[0]).toMatchObject({ name: "delegate_to_kulo", behavior: "NON_BLOCKING" });
    const request = { toolCall: { functionCalls: [{ id: "fc_1", name: "delegate_to_kulo", args: { request: "请用另一个模型生成报表" } }] } };
    socket.receive(request); socket.receive(request); await Promise.resolve();
    expect(delegated).toHaveBeenCalledExactlyOnceWith({ id: "fc_1", text: "请用另一个模型生成报表" });
    connection.sendTaskResult("fc_1", "已建立工单 ticket_1", false);
    expect(socket.sent.at(-1)).toMatchObject({ toolResponse: { functionResponses: [{ id: "fc_1", name: "delegate_to_kulo", response: { output: "已建立工单 ticket_1", status: "running" }, scheduling: "SILENT", willContinue: true }] } });
    connection.sendTaskResult("fc_1", "报表已经生成", true);
    expect(socket.sent.at(-1)).toMatchObject({ toolResponse: { functionResponses: [{ id: "fc_1", scheduling: "WHEN_IDLE", willContinue: false }] } });
    connection.close(); await connection.closed;
  });

  it("releases synchronous tools promptly and does not cancel Kulo tasks on interruption", async () => {
    const { socket, delegated, connection, events } = await ready("gemini", "gemini-3.1-flash-live-preview");
    expect(socket.sent[0]!.setup.tools[0].functionDeclarations[0]).not.toHaveProperty("behavior");
    socket.receive({ toolCall: { functionCalls: [{ id: "fc_sync", name: "delegate_to_kulo", args: { request: "生成报表" } }] } });
    await Promise.resolve(); connection.sendTaskResult("fc_sync", "任务已建立", false);
    expect(socket.sent.at(-1)).toMatchObject({ toolResponse: { functionResponses: [{ response: { status: "running" } }] } });
    expect(socket.sent.at(-1)!.toolResponse.functionResponses[0]).not.toHaveProperty("willContinue");
    socket.receive({ toolCallCancellation: { ids: ["fc_sync"] }, serverContent: { interrupted: true } });
    connection.sendTaskResult("fc_sync", "报表已完成", true);
    expect(socket.sent.at(-1)).toMatchObject({ clientContent: { turnComplete: true } });
    expect(delegated).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "interrupted" });
    connection.close(); await connection.closed;
  });

  it("finalizes Gemini turn transcripts and does not expose a Vertex Key in errors", async () => {
    const { socket, connection, events } = await ready("vertex");
    socket.receive({ serverContent: { inputTranscription: { text: "你好" }, outputTranscription: { text: "我在" }, turnComplete: true } });
    expect(events).toContainEqual(expect.objectContaining({ type: "transcript", role: "user", text: "你好", final: true }));
    socket.receive({ error: { code: 403, message: "Permission denied for fixture-private-key at https://aiplatform.googleapis.com?key=fixture-private-key" } });
    expect(events).toContainEqual({ type: "error", code: "voice_live_auth_failed", message: "语音服务拒绝了 API Key 或当前模型权限。" });
    expect(JSON.stringify(events)).not.toContain("fixture-private-key");
    await connection.closed;
  });

  it("resumes Gemini after GoAway using the same account and server resumption handle", async () => {
    const { socket, connection, events } = await ready("gemini");
    socket.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "fixture-resumption" } });
    socket.receive({ goAway: { timeLeft: "10s" } });
    expect(events).toContainEqual({ type: "state", state: "reconnecting" });
    const replacement = network.sockets.at(-1)!;
    expect(replacement).not.toBe(socket);
    connection.sendNotification("工单 ticket_A 的报表已完成。", true);
    replacement.open();
    expect(replacement.sent[0]).toMatchObject({ setup: { sessionResumption: { handle: "fixture-resumption" } } });
    expect(replacement.sent).toHaveLength(1);
    replacement.receive({ setupComplete: {} });
    expect(replacement.sent.at(-1)).toMatchObject({ clientContent: { turns: [{ parts: [{ text: "[Kulo task update]\n工单 ticket_A 的报表已完成。" }] }], turnComplete: true } });
    expect(events.at(-1)).toEqual({ type: "state", state: "listening" });
    connection.close(); await connection.closed;
  });

  it("clears the transport on failed startup, cancellation, malformed response and backpressure", async () => {
    const controller = new AbortController();
    const aborted = begin("openai", undefined, { signal: controller.signal });
    const assertion = expect(aborted.promise).rejects.toMatchObject({ code: "voice_live_cancelled" });
    controller.abort(); await assertion;
    expect(aborted.socket.terminated).toBe(true);
    const invalid = begin("gemini");
    const rejected = expect(invalid.promise).rejects.toMatchObject({ code: "voice_live_invalid_response" });
    invalid.socket.open(); invalid.socket.receive("not JSON"); await rejected;
    const { socket, connection, events } = await ready();
    socket.bufferedAmount = 1024 * 1024 + 1;
    connection.sendAudio(Buffer.alloc(32).toString("base64"));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "voice_live_backpressure" }));
    await connection.closed;
  });

  it("probes the actual startup handshake then closes without sending audio", async () => {
    const promise = probeVoiceLive(config("vertex"));
    const socket = network.sockets.at(-1)!;
    socket.open(); socket.receive({ setupComplete: {} });
    await promise;
    expect(socket.readyState).toBe(3);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toHaveProperty("setup");
  });

  it("does not accept a WebSocket upgrade alone as a successful Live probe", async () => {
    const promise = probeVoiceLive(config("vertex"), { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toMatchObject({ code: "voice_live_timeout" });
    const socket = network.sockets.at(-1)!; socket.open();
    await vi.advanceTimersByTimeAsync(101); await assertion;
    expect(socket.terminated).toBe(true);
  });

  it("categorizes a real HTTP Vertex Key rejection without exposing the provider error body", async () => {
    const { socket, promise, events } = begin("vertex");
    const rejected = expect(promise).rejects.toMatchObject({ code: "voice_vertex_key_unsupported", httpStatus: 400 });
    const response = Object.assign(new EventEmitter(), { statusCode: 400, resume: vi.fn() });
    socket.emit("unexpected-response", {}, response);
    response.emit("data", Buffer.from(JSON.stringify({ error: { message: "API keys are not supported by this API: fixture-private-key" } })));
    response.emit("end"); await rejected;
    expect(JSON.stringify(events)).not.toContain("fixture-private-key");
    expect(response.resume).toHaveBeenCalled();
    expect(socket.terminated).toBe(true);
  });

  it("rejects a terminal session event received before startup rather than leaving a probe pending", async () => {
    const { socket, promise } = begin();
    const rejected = expect(promise).rejects.toMatchObject({ code: "voice_live_startup_closed" });
    socket.open();
    socket.receive({ type: "session.closed" });
    await rejected;
    expect(socket.terminated).toBe(true);
  });

  it("caps OpenAI startup input and instructions safely below GPT-Live token limits without splitting surrogates", async () => {
    const hugeHistory = Array.from({ length: 24 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn-${index}: ${"中文会话历史😀".repeat(400)}`,
    }));
    const hugeInstructions = `系统人设：${"规则说明😀".repeat(2500)}`;
    const { promise, socket } = begin("openai", "gpt-live-1.1", {
      instructions: hugeInstructions,
      history: [...hugeHistory, { role: "user", text: "   " }],
    });
    socket.open();
    const start = socket.sent[0]!;
    expect(start.type).toBe("session.start");
    const seeded = start.session.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.length).toBeLessThan(24);
    expect(seeded.at(-1)?.content[0]?.text).toMatch(/^turn-23:/);
    // Conservative byte check ensures rendered tokens stay well below OpenAI's 8,192-token session.input cap.
    const seededBytes = seeded.reduce((sum, item) => sum + Buffer.byteLength(item.content[0]!.text), 0);
    expect(seededBytes).toBeLessThan(18 * 1024);
    expect(start.session.instructions).toContain("Delegation policy:");
    expect(start.session.instructions).toContain("Delegate to the backend when:");
    expect(start.session.instructions).not.toContain("<|SpawnThinking|>");
    expect(Buffer.byteLength(start.session.instructions as string)).toBeLessThan(28 * 1024);
    // Ensure code-point-safe truncation never produces lone UTF-16 surrogates.
    const serialized = JSON.stringify(start);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(serialized)).toBe(false);
    socket.receive({ type: "session.started", session: { id: "fixture-live-bounded" } });
    const connection = await promise;
    connection.close();
    await connection.closed;
  });

  it("categorizes upstream context-limit rejections and redacts secrets in diagnostic logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { socket, promise } = begin("openai", "gpt-live-1.1");
      const rejected = expect(promise).rejects.toMatchObject({ code: "voice_live_context_too_large" });
      socket.open();
      socket.receive({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_value",
          param: "session.input",
          message: "Initial input exceeds the maximum limit of 8192 tokens for fixture-private-key",
        },
      });
      await rejected;
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("fixture-private-key");
    } finally {
      warn.mockRestore();
    }
  });
});
