import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import type { ChatDisplayItem, LiveStreamState, VoiceCallEvent, VoiceCallSession, VoiceLiveProvider } from "@kulo/protocol";
import { openVoiceLive, type VoiceLiveConnection } from "./voice-live-adapters.js";

export class VoiceCallsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "VoiceCallsError"; }
}

export interface VoiceCallConfiguration {
  provider: VoiceLiveProvider;
  baseUrl?: string;
  modelId: string;
  voice: string;
  apiKey: string;
}
export interface VoiceCallScope { topicId: string; clientId: string; principalId: string; commandId: string }
type Transcript = Extract<VoiceCallEvent, { type: "transcript" }>;
export interface KuloVoiceCallsOptions {
  voice: { liveConfig(): Promise<VoiceCallConfiguration> };
  context(topicId: string, principalId: string): Promise<{
    history: Array<{ role: "user" | "assistant"; text: string }>;
    instructions: string;
    messageIds?: Array<string | number>;
    priorFailureTaskId?: number | "router";
  }>;
  transcript(topicId: string, event: Transcript, callId: string): Promise<void>;
  delegate(input: { topicId: string; principalId: string; callId: string; delegationId: string; text: string }): Promise<void>;
  openLive?: typeof openVoiceLive;
  pendingTimeoutMs?: number;
  now?: () => number;
}

interface Call {
  id: string;
  scope: VoiceCallScope;
  configuration: string;
  context: Awaited<ReturnType<KuloVoiceCallsOptions["context"]>>;
  session: VoiceCallSession;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  ended: boolean;
  socket?: WebSocket;
  connection?: VoiceLiveConnection;
  opening?: Promise<void>;
  finishing?: Promise<void>;
  effects: Promise<void>;
  delegated: Set<string>;
  seen: Map<string, string>;
  finalTranscripts: Map<string, string>;
  taskUpdates: Map<string, string>;
  routerUpdates: Map<string, { text: string; spoken: boolean }>;
  pendingAudio: string[];
  pendingAudioBytes: number;
  muted: boolean;
  audioBudget: number;
  audioBudgetAt: number;
}

const MAX_SOCKET_BUFFER = 2 * 1024 * 1024;
const MAX_AUDIO_FRAME = 96 * 1024;
const MAX_TRANSCRIPT = 64_000;
const MAX_RESULT = 1400;
const identifier = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\x00-\x1f\x7f]/.test(value)) throw new VoiceCallsError(400, "invalid_voice_call", `${name}无效。`);
  return value.trim();
};
const configIdentity = (config: VoiceCallConfiguration) => JSON.stringify([config.provider, config.baseUrl ?? "", config.modelId, config.voice]);
const messageId = (item: ChatDisplayItem) => String(item.id);
const voiceMessage = (item: ChatDisplayItem): boolean => Boolean((item as ChatDisplayItem & { voiceCallId?: string }).voiceCallId || item.meta?.voiceCallId);
const frameBuffer = (data: RawData): Buffer => Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/** The browser connection owns audio lifetime; delegated work remains owned by the Hub. */
export class KuloVoiceCalls {
  readonly #options: KuloVoiceCallsOptions;
  readonly #calls = new Map<string, Call>();
  readonly #commands = new Map<string, { id: string; topicId: string; at: number }>();
  readonly #topicMessages = new Map<string, ChatDisplayItem[]>();
  readonly #topicTasks = new Map<string, Map<string, string>>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(options: KuloVoiceCallsOptions) { this.#options = options; }
  #now(): number { return this.#options.now?.() ?? Date.now(); }

  async create(input: VoiceCallScope): Promise<VoiceCallSession> {
    const scope: VoiceCallScope = {
      topicId: identifier(input?.topicId, "会话"), clientId: identifier(input?.clientId, "客户端"),
      principalId: identifier(input?.principalId, "设备"), commandId: identifier(input?.commandId, "请求标识"),
    };
    const work = this.#tail.then(async () => {
      if (this.#closed) throw new VoiceCallsError(503, "voice_calls_closed", "语音服务已关闭。");
      const now = this.#now();
      for (const [key, value] of this.#commands) if (now - value.at > 10 * 60_000 && !this.#calls.has(value.id)) this.#commands.delete(key);
      const command = JSON.stringify([scope.principalId, scope.clientId, scope.commandId]);
      const previous = this.#commands.get(command);
      if (previous) {
        if (previous.topicId !== scope.topicId) throw new VoiceCallsError(409, "voice_call_command_conflict", "通话请求已用于其他会话。");
        const existing = this.#calls.get(previous.id);
        if (!existing || existing.ended) throw new VoiceCallsError(410, "voice_call_ended", "通话已结束，请重新发起。");
        return { ...existing.session };
      }
      if ([...this.#calls.values()].some((call) => !call.ended && call.scope.principalId === scope.principalId)) throw new VoiceCallsError(409, "voice_call_active", "已有正在进行的通话。");
      await Promise.all([...this.#calls.values()].filter((call) => call.ended && call.scope.principalId === scope.principalId).map((call) => call.finishing));
      const config = await this.#options.voice.liveConfig();
      const context = await this.#options.context(scope.topicId, scope.principalId);
      if (this.#closed) throw new VoiceCallsError(503, "voice_calls_closed", "语音服务已关闭。");
      const id = `call_${randomUUID().replaceAll("-", "")}`;
      const inputSampleRate = config.provider === "openai" ? 24000 : 16000;
      const session: VoiceCallSession = { id, wsPath: `/api/voice/calls/${id}/socket`, inputSampleRate, outputSampleRate: 24000 };
      const call: Call = {
        id, scope, configuration: configIdentity(config), context, session, controller: new AbortController(),
        timer: setTimeout(() => { void this.#finish(call); }, this.#options.pendingTimeoutMs ?? 30_000),
        ended: false, effects: Promise.resolve(), delegated: new Set(),
        seen: new Map((this.#topicMessages.get(scope.topicId) ?? []).map((item) => [messageId(item), item.text])),
        finalTranscripts: new Map(), taskUpdates: new Map(this.#topicTasks.get(scope.topicId)), routerUpdates: new Map(), pendingAudio: [], pendingAudioBytes: 0, muted: false,
        audioBudget: inputSampleRate * 2 * 4, audioBudgetAt: now,
      };
      for (const entryId of context.messageIds ?? []) call.seen.set(String(entryId), "");
      if (context.priorFailureTaskId !== undefined) call.taskUpdates.set(`failure:${context.priorFailureTaskId}`, "failed");
      call.timer.unref?.();
      this.#calls.set(id, call);
      this.#commands.set(command, { id, topicId: scope.topicId, at: now });
      return { ...session };
    });
    this.#tail = work.then(() => undefined, () => undefined);
    return work;
  }

  #call(id: string, principalId: string): Call {
    const call = this.#calls.get(id);
    if (!call || call.ended) throw new VoiceCallsError(410, "voice_call_ended", "通话不存在或已经结束。");
    if (call.scope.principalId !== principalId) throw new VoiceCallsError(403, "voice_call_forbidden", "无权访问此通话。");
    return call;
  }

  async attach(id: string, principalId: string, socket: WebSocket): Promise<void> {
    const call = this.#call(id, principalId);
    if (call.socket) throw new VoiceCallsError(409, "voice_call_attached", "通话已连接。");
    clearTimeout(call.timer);
    call.socket = socket;
    socket.on("message", (data, binary) => this.#input(call, data, binary));
    socket.once("close", () => { void this.#finish(call); });
    socket.once("error", () => { void this.#finish(call); });
    this.#send(call, { type: "state", state: "connecting" });
    const opening = (async () => {
      try {
        const config = await this.#options.voice.liveConfig();
        if (call.ended) return;
        if (configIdentity(config) !== call.configuration) throw new VoiceCallsError(409, "voice_call_settings_changed", "通话设置已变更，请重新连接。");
        const connection = await (this.#options.openLive ?? openVoiceLive)({
          ...config, instructions: call.context.instructions, history: call.context.history, signal: call.controller.signal,
          onEvent: (event) => this.#event(call, event), onDelegate: (request) => this.#delegate(call, request),
        });
        call.connection = connection;
        if (call.ended) { connection.close(); return; }
        connection.setMuted(call.muted);
        for (const chunk of call.pendingAudio.splice(0)) if (!call.muted) connection.sendAudio(chunk);
        call.pendingAudioBytes = 0;
        void connection.closed.then(() => this.#finish(call), () => this.#fail(call, "语音连接已断开。", "voice_upstream_closed"));
      } catch (error) {
        if (!call.ended) {
          const own = error instanceof VoiceCallsError;
          const liveError = error instanceof Error && error.name === "VoiceLiveError" && typeof (error as { code?: unknown }).code === "string"
            ? error as Error & { code: string }
            : undefined;
          await this.#fail(
            call,
            own ? error.message : liveError ? liveError.message : "语音连接失败，请检查通话配置后重试。",
            own ? error.code : liveError ? liveError.code : "voice_connection_failed",
          );
        }
      }
    })();
    call.opening = opening;
    await opening;
  }

  #send(call: Call, event: VoiceCallEvent): void {
    const socket = call.socket;
    if (call.ended || !socket || socket.readyState !== 1) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) { void this.#finish(call); return; }
    try { socket.send(JSON.stringify(event)); }
    catch { void this.#finish(call); }
  }

  #queue(call: Call, work: () => Promise<void>): void {
    call.effects = call.effects.then(work).catch(() => {
      this.#send(call, { type: "error", code: "voice_history_failed", message: "保存通话记录失败，请重试。" });
      queueMicrotask(() => { void this.#finish(call); });
    });
  }

  #event(call: Call, event: VoiceCallEvent): void {
    if (event.type === "transcript" && event.final && event.text.trim()) {
      const text = event.text.trim().slice(0, MAX_TRANSCRIPT);
      const key = event.id ? `${event.role}:${event.id}` : `${event.role}:${text}`;
      if (call.finalTranscripts.get(key) !== text) {
        call.finalTranscripts.set(key, text);
        this.#queue(call, () => this.#options.transcript(call.scope.topicId, { ...event, text }, call.id));
      }
    }
    this.#send(call, event);
    if (event.type === "error") void this.#finish(call);
  }

  #delegate(call: Call, request: { id: string; text: string }): void {
    if (call.ended || call.delegated.has(request.id)) return;
    if (!request.id || request.id.length > 240 || !request.text.trim() || request.text.length > MAX_TRANSCRIPT) {
      this.#send(call, { type: "error", code: "invalid_voice_delegation", message: "没有听清任务要求，请再说一次。" });
      return;
    }
    call.delegated.add(request.id);
    this.#queue(call, async () => {
      if (call.ended) return;
      try {
        await this.#options.delegate({ topicId: call.scope.topicId, principalId: call.scope.principalId, callId: call.id,
          delegationId: request.id, text: request.text.trim() });
        this.#taskResult(call, request.id, "请求已提交给当前 Kulo 会话处理，进展和结果将单独更新。", true);
      } catch {
        this.#taskResult(call, request.id, "任务提交状态尚未确认，请查看当前会话。", true);
      }
    });
  }

  #input(call: Call, raw: RawData, binary: boolean): void {
    if (call.ended) return;
    const bytes = frameBuffer(raw);
    if (binary || bytes.length > MAX_AUDIO_FRAME) { void this.#fail(call, "语音数据格式无效。", "invalid_voice_audio"); return; }
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { void this.#fail(call, "语音数据格式无效。", "invalid_voice_audio"); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { void this.#fail(call, "语音数据格式无效。", "invalid_voice_audio"); return; }
    const input = value as Record<string, unknown>;
    if (input.type === "close" && Object.keys(input).length === 1) { void this.#finish(call); return; }
    if (input.type === "mute" && typeof input.muted === "boolean" && Object.keys(input).every((key) => ["type", "muted"].includes(key))) {
      call.muted = input.muted;
      if (call.muted) { call.pendingAudio.length = 0; call.pendingAudioBytes = 0; }
      try { call.connection?.setMuted(call.muted); }
      catch { void this.#fail(call, "麦克风状态同步失败，请重新连接。", "voice_mute_failed"); }
      return;
    }
    if (input.type !== "audio" || Object.keys(input).some((key) => !["type", "data"].includes(key)) || typeof input.data !== "string" ||
      !input.data || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) {
      void this.#fail(call, "语音数据格式无效。", "invalid_voice_audio"); return;
    }
    const decoded = Buffer.from(input.data, "base64");
    if (!decoded.length || decoded.length % 2 || decoded.toString("base64") !== input.data) { void this.#fail(call, "语音数据格式无效。", "invalid_voice_audio"); return; }
    if (call.muted) return;
    const now = this.#now();
    const rate = call.session.inputSampleRate * 2;
    call.audioBudget = Math.min(rate * 4, call.audioBudget + Math.max(0, now - call.audioBudgetAt) / 1000 * rate);
    call.audioBudgetAt = now;
    if (decoded.length > call.audioBudget) { void this.#fail(call, "语音发送过快，请重新连接。", "voice_audio_rate_exceeded"); return; }
    call.audioBudget -= decoded.length;
    try {
      if (call.connection) call.connection.sendAudio(input.data);
      else if (call.pendingAudioBytes + decoded.length <= rate * 2) {
        call.pendingAudio.push(input.data); call.pendingAudioBytes += decoded.length;
      } else void this.#fail(call, "语音连接尚未就绪，请重新连接。", "voice_audio_not_ready");
    } catch { void this.#fail(call, "语音发送失败，请重新连接。", "voice_audio_failed"); }
  }

  /** Only committed Router text is relayed; voice transcript entries never feed back into Live. */
  topicUpdated(topicId: string, messages: ChatDisplayItem[], live: LiveStreamState): void {
    if (this.#closed) return;
    this.#topicMessages.set(topicId, messages.slice(-100));
    if (this.#topicMessages.size > 128) this.#topicMessages.delete(this.#topicMessages.keys().next().value!);
    for (const call of this.#calls.values()) {
      if (call.ended || call.scope.topicId !== topicId) continue;
      for (const message of messages) {
        const id = messageId(message);
        const previous = call.seen.get(id);
        call.seen.set(id, message.text);
        if (message.role !== "assistant" || voiceMessage(message) || previous === "" || !message.text.trim()) continue;
        if (!call.context.messageIds && previous === undefined && call.context.history.some((item) => item.role === "assistant" && item.text === message.text)) continue;
        const update = call.routerUpdates.get(id);
        if ((!update && previous === message.text) || (update?.text === message.text && (update.spoken || live.busy))) continue;
        call.routerUpdates.set(id, { text: message.text, spoken: !live.busy });
        this.#notification(call, `当前会话的后端更新：\n${message.text.trim().slice(0, MAX_RESULT)}`, !live.busy);
      }
      if (live.runFailure) {
        const key = `failure:${live.runFailure.taskId ?? "router"}`;
        if (!call.taskUpdates.has(key)) {
          call.taskUpdates.set(key, "failed");
          this.#notification(call, "当前会话处理遇到错误，详细信息已保留在聊天中。", true);
        }
      }
    }
  }

  taskUpdated(topicId: string, taskId: string, summary: string, status: string): void {
    if (this.#closed) return;
    const fingerprint = JSON.stringify([status, summary]);
    let baseline = this.#topicTasks.get(topicId);
    if (!baseline) { baseline = new Map(); this.#topicTasks.set(topicId, baseline); }
    baseline.set(taskId, fingerprint);
    for (const call of this.#calls.values()) {
      if (call.ended || call.scope.topicId !== topicId || !summary.trim()) continue;
      if (call.taskUpdates.get(taskId) === fingerprint) continue;
      call.taskUpdates.set(taskId, fingerprint);
      this.#notification(call, `工单 ${taskId}（${status}）的更新：\n${summary.trim().slice(0, MAX_RESULT)}`,
        ["completed", "failed", "stopped", "ready", "done"].includes(status));
    }
  }

  #taskResult(call: Call, id: string, text: string, final: boolean): void {
    if (call.ended || !call.connection) return;
    try { call.connection.sendTaskResult(id, text, final); }
    catch { void this.#fail(call, "通话连接已中断，任务结果仍保留在当前会话。", "voice_result_delivery_failed"); }
  }

  #notification(call: Call, text: string, speak: boolean): void {
    if (call.ended || !call.connection) return;
    try { call.connection.sendNotification(text, speak); }
    catch { void this.#fail(call, "通话连接已中断，任务结果仍保留在当前会话。", "voice_result_delivery_failed"); }
  }

  async #fail(call: Call, message: string, code: string): Promise<void> {
    this.#send(call, { type: "error", message, code });
    await this.#finish(call);
  }

  #finish(call: Call): Promise<void> {
    if (call.finishing) return call.finishing;
    call.finishing = Promise.resolve().then(async () => {
      if (call.connection) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([call.connection.closed.then(() => undefined, () => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); timer.unref?.(); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      await call.effects;
    }).finally(() => { this.#calls.delete(call.id); });
    this.#send(call, { type: "state", state: "ended" });
    call.ended = true;
    clearTimeout(call.timer);
    call.controller.abort();
    call.pendingAudio.length = 0;
    call.pendingAudioBytes = 0;
    call.connection?.close();
    if (call.socket && call.socket.readyState < 2) call.socket.close(1000, "Call ended");
    return call.finishing;
  }

  async end(id: string, principalId: string): Promise<void> {
    const call = this.#calls.get(id);
    if (!call) return;
    if (call.scope.principalId !== principalId) throw new VoiceCallsError(403, "voice_call_forbidden", "无权访问此通话。");
    await this.#finish(call);
  }

  hasActiveCalls(): boolean {
    return [...this.#calls.values()].some((call) => !call.ended);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    await Promise.all([...this.#calls.values()].map((call) => this.#finish(call)));
    this.#commands.clear();
    this.#topicMessages.clear();
    this.#topicTasks.clear();
  }
}
