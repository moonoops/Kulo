import { randomUUID } from "node:crypto";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import type { VoiceCallEvent, VoiceCallState, VoiceLiveProvider } from "@kulo/protocol";
import { VOICE_FALLBACK_INSTRUCTIONS } from "./prompts.js";

const MAX_AUDIO_BYTES = 128 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024;
const DELEGATE_TOOL = "delegate_to_kulo";

export class VoiceLiveError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "VoiceLiveError";
  }
}
export interface VoiceLiveConfig { provider: VoiceLiveProvider; baseUrl?: string; modelId: string; voice: string; apiKey: string }
export interface VoiceLiveOpenInput extends VoiceLiveConfig {
  instructions?: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  signal?: AbortSignal;
  onEvent: (event: VoiceCallEvent) => void;
  onDelegate: (request: { id: string; text: string }) => void | Promise<void>;
}
export interface VoiceLiveOptions { signal?: AbortSignal; timeoutMs?: number }
export interface VoiceLiveConnection {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  readonly closed: Promise<void>;
  sendAudio(data: string): void;
  setMuted(muted: boolean): void;
  sendTaskResult(id: string, text: string, final?: boolean): void;
  sendContext(text: string): void;
  sendNotification(text: string, speak?: boolean): void;
  close(): void;
}
interface TranscriptGroup { id: string; text: string; endMs?: number }
interface InputTranscriptSegment { startMs: number; endMs: number; text: string }
interface Task { upstreamId?: string; responded: boolean; cancelled: boolean }
type Json = Record<string, unknown>;
function object(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }

function validConfig(input: VoiceLiveConfig): VoiceLiveConfig {
  if (!input || !["openai", "gemini", "vertex"].includes(input.provider)) throw new VoiceLiveError("voice_live_invalid_provider", "请选择有效的通话服务。");
  const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  const voice = typeof input.voice === "string" ? input.voice.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(modelId)) throw new VoiceLiveError("voice_live_invalid_model", "通话模型名称无效。");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(voice)) throw new VoiceLiveError("voice_live_invalid_voice", "请选择有效的通话音色。");
  if (!apiKey || apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(apiKey)) throw new VoiceLiveError("voice_live_missing_credential", "通话服务需要有效的 API Key。");
  let baseUrl: string | undefined;
  if (input.baseUrl !== undefined && input.baseUrl.trim()) {
    let parsed: URL;
    try { parsed = new URL(input.baseUrl.trim()); }
    catch { throw new VoiceLiveError("voice_live_invalid_endpoint", "通话服务地址无效。"); }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
      throw new VoiceLiveError("voice_live_invalid_endpoint", "通话服务地址无效。");
    }
    baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  }
  return { provider: input.provider, ...(baseUrl ? { baseUrl } : {}), modelId, voice, apiKey };
}
function audioBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new VoiceLiveError("voice_live_invalid_audio", "实时音频格式无效。");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.length % 2 !== 0 || bytes.toString("base64") !== value) throw new VoiceLiveError("voice_live_invalid_audio", "实时音频需要完整的 PCM16 采样。");
  return bytes;
}
function contextText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_CONTEXT_BYTES) throw new VoiceLiveError("voice_live_invalid_context", "通话上下文为空或过长，请返回简短的任务结果。");
  return value;
}
function contextChunks(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "", bytes = 0;
  // A conservative byte bound also stays below the 500-token append limit for byte-fallback tokens.
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 450) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
function safeFailure(provider: VoiceLiveProvider, status?: number, reason = ""): VoiceLiveError {
  if (provider === "vertex" && /(?:project|location).*(?:required|missing|must|invalid)|(?:required|missing).*(?:project|location)/i.test(reason)) return new VoiceLiveError("voice_vertex_resource_required", "Vertex Live 要求额外的资源参数，当前仅 API Key 的连接未通过。", status);
  if (provider === "vertex" && /express|api.?key.{0,40}(?:not supported|unsupported)|(?:not supported|unsupported).{0,40}api.?key/i.test(reason)) return new VoiceLiveError("voice_vertex_key_unsupported", "该 Vertex API Key 渠道不支持当前 Live 会话。", status);
  if (status === 401 || status === 403 || /unauthenticated|permission.?denied|invalid.{0,20}(?:key|credential)|api.?key.{0,20}(?:invalid|expired|not valid)/i.test(reason)) return new VoiceLiveError("voice_live_auth_failed", "语音服务拒绝了 API Key 或当前模型权限。", status);
  if (status === 429 || /resource.?exhausted|quota exceeded|rate limit/i.test(reason)) return new VoiceLiveError("voice_live_rate_limited", "实时语音服务额度不足或请求过多，请稍后重试。", status);
  if (status !== undefined && status >= 500) return new VoiceLiveError("voice_live_service_error", "实时语音服务暂时不可用，请稍后重试。", status);
  if (status === 404 || /model.{0,80}(?:not found|not supported|unsupported|unavailable)|(?:not found|unsupported).{0,80}model/i.test(reason)) return new VoiceLiveError("voice_live_model_unavailable", "所选 Live 模型在当前渠道不可用。", status);
  if (provider === "vertex") return new VoiceLiveError("voice_vertex_live_unavailable", "Vertex API Key 未能建立 Live 会话，请检查模型与渠道支持。", status);
  return new VoiceLiveError("voice_live_unavailable", "实时语音连接失败，请检查模型、音色与服务权限。", status);
}
function supportsAsyncFunction(modelId: string): boolean {
  return /(?:^gemini-3\.8-live(?:-|$)|2\.5.*(?:native-audio|live)|^gemini-live-2\.5)/i.test(modelId);
}
function history(input: VoiceLiveOpenInput): Array<{ role: "user" | "assistant"; text: string }> {
  const items = input.history ?? [];
  if (!Array.isArray(items) || items.length > 100 || items.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.text !== "string")) throw new VoiceLiveError("voice_live_invalid_context", "通话历史格式无效。");
  const bounded = items.slice(-24).map((item) => ({ role: item.role, text: item.text.slice(0, 4000) }));
  if (bounded.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) > 64 * 1024) throw new VoiceLiveError("voice_live_invalid_context", "通话历史过长，请先精简上下文。");
  return bounded;
}
function instructions(input: VoiceLiveOpenInput): string {
  const base = input.instructions?.trim() ?? VOICE_FALLBACK_INSTRUCTIONS;
  if (Buffer.byteLength(base) > 48 * 1024) throw new VoiceLiveError("voice_live_invalid_context", "通话指令过长。");
  const policy = input.provider === "openai"
    ? "Delegation policy:\nBackend tools:\n- Kulo: retrieve personal or project memories and earlier conversations, search, use configured models and tools, create reports or files, and manage existing tasks.\nGenerate <|SpawnThinking|> when:\n- The user requests any backend capability, careful reasoning, or a correction to a running task.\nDo not generate <|SpawnThinking|> when:\n- A short conversational reply or a clarification is sufficient.\nGenerate <|SpawnThinking|> before answering anything that depends on backend work."
    : `Use ${DELEGATE_TOOL} to retrieve personal or project memories and earlier conversations, or for searches, reports, files, configured models, tools, and corrections to existing tasks. Continue conversing while Kulo works.`;
  return `${base}\n\n${policy}\nKeep spoken replies brief. Stop speaking when interrupted. Interruptions and hanging up do not cancel backend tasks. Report an action as complete only after Kulo returns a verified result.`;
}

class LiveConnection implements VoiceLiveConnection {
  readonly inputSampleRate: number;
  readonly outputSampleRate = 24_000;
  readonly closed: Promise<void>;
  readonly #config: VoiceLiveConfig;
  readonly #input: VoiceLiveOpenInput;
  readonly #options: VoiceLiveOptions;
  readonly #instructions: string;
  readonly #history: Array<{ role: "user" | "assistant"; text: string }>;
  readonly #groups: Partial<Record<"user" | "assistant", TranscriptGroup>> = {};
  readonly #tasks = new Map<string, Task>();
  readonly #inputSegments: InputTranscriptSegment[] = [];
  readonly #delegationOffsets = new Map<string, number>();
  readonly #pendingCommands: Json[] = [];
  readonly #pendingDelegations = new Map<string, ReturnType<typeof setTimeout>>();
  #resolveClosed!: () => void;
  #socket?: WebSocket;
  #ready = false;
  #closing = false;
  #ended = false;
  #muted = false;
  #state?: VoiceCallState;
  #speakingUntil = 0;
  #speechTimer?: ReturnType<typeof setTimeout>;
  #closeTimer?: ReturnType<typeof setTimeout>;
  #resumptionHandle?: string;
  #connectReject?: (error: VoiceLiveError) => void;
  #connectTimer?: ReturnType<typeof setTimeout>;
  #abort?: () => void;

  constructor(input: VoiceLiveOpenInput, options: VoiceLiveOptions) {
    this.#config = validConfig(input);
    this.#input = input;
    this.#options = options;
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 60_000)) throw new VoiceLiveError("voice_live_invalid_timeout", "通话连接超时设置无效。");
    this.#instructions = instructions(input);
    this.#history = history(input);
    this.inputSampleRate = input.provider === "openai" ? 24_000 : 16_000;
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
  }
  #event(event: VoiceCallEvent): void { this.#input.onEvent(event); }
  #setState(state: VoiceCallState): void {
    if (this.#state !== state) { this.#state = state; this.#event({ type: "state", state }); }
  }
  async open(): Promise<VoiceLiveConnection> {
    const signal = this.#options.signal ?? this.#input.signal;
    if (signal?.aborted) throw new VoiceLiveError("voice_live_cancelled", "通话连接已取消。");
    this.#abort = () => this.#fail(new VoiceLiveError("voice_live_cancelled", "通话连接已取消。"));
    signal?.addEventListener("abort", this.#abort, { once: true });
    this.#setState("connecting");
    try { await this.#connect(); return this; }
    catch (error) { this.#finish(); throw error; }
  }
  #connect(resume = false): Promise<void> {
    this.#ready = false;
    const { provider, baseUrl, apiKey } = this.#config;
    const defaultOrigin = provider === "openai" ? "https://api.openai.com" : provider === "vertex" ? "https://aiplatform.googleapis.com" : "https://generativelanguage.googleapis.com";
    const parsedBase = baseUrl ? new URL(baseUrl) : undefined;
    const isCustomOrigin = Boolean(parsedBase && parsedBase.origin !== defaultOrigin);
    const wsOrigin = parsedBase ? `${parsedBase.protocol === "http:" ? "ws:" : "wss:"}//${parsedBase.host}` : undefined;
    const endpoint = !isCustomOrigin
      ? (provider === "openai" ? "wss://api.openai.com/v1/live/sessions"
        : provider === "vertex" ? "wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
          : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`)
      : (provider === "openai"
        ? `${wsOrigin}${parsedBase!.pathname.replace(/\/+$/, "") || "/v1"}/live/sessions`
        : provider === "vertex"
          ? `${wsOrigin}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`
          : `${wsOrigin}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`);
    return new Promise<void>((resolve, reject) => {
      this.#connectReject = reject;
      let socket: WebSocket;
      try {
        const target = new URL(endpoint); target.protocol = target.protocol === "ws:" ? "http:" : "https:"; target.search = "";
        const proxy = resolveHttpProxyUrlForTarget(target);
        const headers: Record<string, string> = provider === "openai"
          ? { Authorization: `Bearer ${apiKey}` }
          : provider === "vertex"
            ? { "x-goog-api-key": apiKey }
            : isCustomOrigin
              ? { Authorization: `Bearer ${apiKey}`, "x-goog-api-key": apiKey }
              : {};
        const options: ClientOptions = {
          headers,
          maxPayload: 4 * 1024 * 1024, handshakeTimeout: this.#options.timeoutMs ?? 15_000,
          ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
        };
        socket = new WebSocket(endpoint, options);
        this.#socket = socket;
      } catch { this.#fail(new VoiceLiveError("voice_live_connection_failed", "无法建立实时语音连接，请检查网络与代理配置。")); return; }
      this.#connectTimer = setTimeout(() => this.#fail(new VoiceLiveError("voice_live_timeout", "实时语音连接超时，请重试。")), this.#options.timeoutMs ?? 15_000);
      this.#connectTimer.unref?.();
      socket.on("open", () => {
        if (socket !== this.#socket || this.#closing || this.#ended) return;
        this.#send(this.#setup(resume));
      });
      socket.on("message", (data: RawData) => {
        if (socket !== this.#socket || this.#ended) return;
        let message: unknown;
        try { message = JSON.parse(data.toString()); }
        catch { this.#fail(new VoiceLiveError("voice_live_invalid_response", "语音服务返回了无效的会话数据。")); return; }
        if (!object(message)) { this.#fail(new VoiceLiveError("voice_live_invalid_response", "语音服务返回了无效的会话数据。")); return; }
        const started = provider === "openai" ? message.type === "session.started" : object(message.setupComplete);
        if (started && !this.#ready && !this.#closing) {
          clearTimeout(this.#connectTimer);
          this.#connectReject = undefined;
          this.#ready = true;
          if (!resume) this.#seedHistory();
          if (this.#muted) this.setMuted(true);
          for (const command of this.#pendingCommands.splice(0)) this.#send(command);
          this.#setState("listening");
          resolve();
        }
        if (!this.#ready && message.type !== "error" && !object(message.error)) {
          if (message.type === "session.closed") this.#fail(new VoiceLiveError("voice_live_startup_closed", "语音服务在会话建立前关闭了连接。"));
          return;
        }
        if (provider === "openai") this.#openaiMessage(message);
        else this.#googleMessage(message);
      });
      socket.on("unexpected-response", (_request, response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 16 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (socket !== this.#socket) return;
          // Upstream bodies can echo URLs and credentials. Use them only to select a fixed, non-secret error category.
          let reason = "";
          if (bytes <= 16 * 1024) {
            try {
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (object(body) && object(body.error) && typeof body.error.message === "string") reason = body.error.message;
            } catch { /* A non-JSON error body does not change the HTTP failure. */ }
          }
          this.#fail(safeFailure(provider, response.statusCode, reason));
        });
        response.on("error", () => { if (socket === this.#socket) this.#fail(safeFailure(provider, response.statusCode)); });
        response.resume();
      });
      socket.on("error", () => {
        if (socket === this.#socket && !this.#closing) this.#fail(new VoiceLiveError("voice_live_network_error", "实时语音网络连接中断，请重试。"));
      });
      socket.on("close", (code, reason) => {
        if (socket !== this.#socket || this.#ended) return;
        if (!this.#closing) this.#fail(code === 1008 || code === 1007 ? safeFailure(provider, undefined, reason.toString()) : new VoiceLiveError("voice_live_disconnected", "实时语音连接已断开，可重新连接。"));
        else this.#finish();
      });
    });
  }
  #setup(resume: boolean): Json {
    const { provider, modelId, voice } = this.#config;
    if (provider === "openai") return { type: "session.start", event_id: randomUUID(), session: {
      model: modelId, instructions: this.#instructions, store: false,
      audio: { format: { type: "audio/pcm", rate: this.inputSampleRate }, output: { voice } },
      delegation: { type: "client" },
      input: this.#history.map((item) => ({ type: "message", role: item.role, content: [{ type: item.role === "user" ? "input_text" : "output_text", text: item.text }] })),
    } };
    return { setup: {
      model: `${provider === "vertex" ? "publishers/google/models" : "models"}/${modelId}`,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      systemInstruction: { parts: [{ text: this.#instructions }] },
      inputAudioTranscription: {}, outputAudioTranscription: {},
      sessionResumption: resume && this.#resumptionHandle ? { handle: this.#resumptionHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
      tools: [{ functionDeclarations: [{
        name: DELEGATE_TOOL,
        description: "Ask Kulo to search, use tools or another configured model, produce reports/files, or update an existing task. State the full current request and corrections.",
        parameters: { type: "OBJECT", properties: { request: { type: "STRING", description: "The user's complete task or correction for Kulo." } }, required: ["request"] },
        ...(supportsAsyncFunction(modelId) ? { behavior: "NON_BLOCKING" } : {}),
      }] }],
    } };
  }
  #seedHistory(): void {
    if (this.#config.provider !== "openai" && this.#history.length) this.#send({ clientContent: {
      turns: this.#history.map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.text }] })), turnComplete: false,
    } });
  }
  #send(message: Json): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new VoiceLiveError("voice_live_not_connected", "实时语音尚未连接。");
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.#fail(new VoiceLiveError("voice_live_backpressure", "实时语音网络速度不足，请重新连接。")); return; }
    this.#socket.send(JSON.stringify(message), (error) => { if (error && !this.#closing) this.#fail(new VoiceLiveError("voice_live_network_error", "实时语音数据发送失败，请重新连接。")); });
  }
  #sendApplication(message: Json): void {
    if (this.#closing || this.#ended) return;
    if (this.#ready) { this.#send(message); return; }
    // Preserve backend results across the provider's scheduled reconnect. Live microphone audio is intentionally not replayed.
    if (this.#pendingCommands.length >= 64 || Buffer.byteLength(JSON.stringify([...this.#pendingCommands, message])) > 64 * 1024) { this.#fail(new VoiceLiveError("voice_live_backpressure", "通话待发送结果过多，请重新连接。")); return; }
    this.#pendingCommands.push(message);
  }
  sendAudio(data: string): void {
    audioBytes(data);
    if (this.#closing || this.#ended || !this.#ready || this.#muted) return;
    this.#send(this.#config.provider === "openai" ? { type: "session.input_audio.append", audio: data } : { realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${this.inputSampleRate}` } } });
  }
  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (!this.#ready || this.#closing || this.#ended) return;
    if (this.#config.provider === "openai") this.#send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: randomUUID() });
    else if (muted) this.#send({ realtimeInput: { audioStreamEnd: true } });
  }
  #transcript(role: "user" | "assistant", delta: string, startMs?: number, endMs?: number): void {
    if (!delta) return;
    let group = this.#groups[role];
    // GPT-Live has no turn-complete event. Group by known timeline intervals rather than network arrival gaps.
    if (group && startMs !== undefined && group.endMs !== undefined && startMs - group.endMs > 1800) { this.#finalize(role); group = undefined; }
    if (!group || Buffer.byteLength(group.text) + Buffer.byteLength(delta) > MAX_CONTEXT_BYTES) {
      if (group) this.#finalize(role);
      group = { id: randomUUID(), text: "" }; this.#groups[role] = group;
    }
    group.text += delta;
    if (endMs !== undefined) group.endMs = endMs;
    this.#event({ type: "transcript", id: group.id, role, text: group.text, final: false });
  }
  #finalize(role: "user" | "assistant"): void {
    const group = this.#groups[role];
    if (group) { this.#event({ type: "transcript", id: group.id, role, text: group.text, final: true }); delete this.#groups[role]; }
  }
  #interrupt(): void {
    clearTimeout(this.#speechTimer); this.#speakingUntil = 0;
    this.#event({ type: "interrupted" }); this.#setState("listening");
  }
  #audio(data: string): void {
    let bytes: Buffer;
    try { bytes = audioBytes(data); }
    catch { this.#fail(new VoiceLiveError("voice_live_invalid_response", "语音服务返回了无效的音频数据。")); return; }
    this.#setState("speaking"); this.#event({ type: "audio", data, sampleRate: this.outputSampleRate });
    this.#speakingUntil = Math.max(this.#speakingUntil, Date.now()) + bytes.length / (this.outputSampleRate * 2) * 1000;
    clearTimeout(this.#speechTimer);
    this.#speechTimer = setTimeout(() => { if (!this.#closing && !this.#ended) this.#setState("listening"); }, Math.max(20, this.#speakingUntil - Date.now()));
    this.#speechTimer.unref?.();
  }
  #delegate(id: string, request: string, upstreamId?: string): void {
    if (this.#tasks.has(id) || this.#closing || this.#ended) return;
    if (this.#tasks.size >= 128) { this.#fail(new VoiceLiveError("voice_live_task_limit", "本次通话的任务数量已达上限，请重新连接。")); return; }
    this.#tasks.set(id, { upstreamId, responded: false, cancelled: false }); this.#setState("working");
    void Promise.resolve().then(() => this.#input.onDelegate({ id, text: request })).catch(() => {
      if (!this.#closing && !this.#ended) this.sendTaskResult(id, "Kulo 未能完成这次请求，请查看聊天中的任务状态。", true);
    });
  }
  #openaiMessage(message: Json): void {
    if (message.type === "session.output_audio.delta" && typeof message.delta === "string") this.#audio(message.delta);
    else if ((message.type === "session.input_transcript.delta" || message.type === "session.output_transcript.delta") && typeof message.delta === "string") {
      const role = message.type === "session.input_transcript.delta" ? "user" : "assistant";
      if (role === "user" && this.#state === "speaking") this.#interrupt();
      if (role === "user" && typeof message.start_ms === "number" && typeof message.end_ms === "number" && Number.isFinite(message.start_ms) && Number.isFinite(message.end_ms) && message.start_ms >= 0 && message.end_ms >= message.start_ms) {
        this.#inputSegments.push({ startMs: message.start_ms, endMs: message.end_ms, text: message.delta });
        if (this.#inputSegments.length > 512) this.#inputSegments.splice(0, this.#inputSegments.length - 512);
      }
      this.#transcript(role, message.delta, typeof message.start_ms === "number" ? message.start_ms : undefined, typeof message.end_ms === "number" ? message.end_ms : undefined);
    } else if (message.type === "session.delegation.created" && object(message.delegation) && message.delegation.target === "client" && typeof message.delegation.id === "string") {
      const id = message.delegation.id;
      if (this.#tasks.has(id) || this.#pendingDelegations.has(id) || this.#delegationOffsets.has(id)) return;
      if (id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) { this.#fail(new VoiceLiveError("voice_live_invalid_response", "语音服务返回了无效的任务标识。")); return; }
      if (typeof message.offset_ms !== "number" || !Number.isFinite(message.offset_ms) || message.offset_ms < 0) { this.#fail(new VoiceLiveError("voice_live_invalid_response", "语音服务返回了无效的任务时间位置。")); return; }
      const offsetMs = message.offset_ms;
      const previousOffset = Math.max(-1, ...[...this.#delegationOffsets.values()].filter((offset) => offset < offsetMs));
      if (this.#delegationOffsets.size >= 128) { this.#fail(new VoiceLiveError("voice_live_task_limit", "本次通话的任务数量已达上限，请重新连接。")); return; }
      this.#delegationOffsets.set(id, offsetMs);
      // Task metadata and speech text travel independently. Give already queued transcript fragments time to arrive.
      const timer = setTimeout(() => {
        this.#pendingDelegations.delete(id);
        const request = this.#requestAt(offsetMs, previousOffset);
        if (request?.trim()) this.#delegate(id, request);
        else this.#appendOpenAI("session.thinking.append", id, "No clear user request was received. Ask the caller to repeat the task before executing it.");
      }, 150);
      timer.unref?.(); this.#pendingDelegations.set(id, timer);
    } else if (message.type === "session.closed") { this.#closing = true; this.#socket?.close(1000); this.#finish(); }
    else if (message.type === "error") {
      const upstream = object(message.error) ? message.error : {};
      const error = safeFailure(this.#config.provider, undefined, typeof upstream.message === "string" ? upstream.message : "");
      if (!this.#ready) this.#fail(error);
      else { this.#interrupt(); this.#event({ type: "error", code: error.code, message: error.message }); }
    }
  }
  #requestAt(offsetMs: number, previousOffset: number): string {
    // A later utterance may arrive before this delegation is handled. Only fragments completed by its timeline position belong to the request.
    const candidates = this.#inputSegments.filter((segment) => segment.endMs <= offsetMs && segment.endMs > Math.min(previousOffset, offsetMs));
    let first = candidates.length - 1;
    while (first > 0 && candidates[first]!.startMs - candidates[first - 1]!.endMs <= 1800) first--;
    return candidates.slice(Math.max(0, first)).map((segment) => segment.text).join("");
  }
  #googleMessage(message: Json): void {
    if (object(message.error)) { this.#fail(safeFailure(this.#config.provider, typeof message.error.code === "number" ? message.error.code : undefined, typeof message.error.message === "string" ? message.error.message : "")); return; }
    if (object(message.sessionResumptionUpdate) && message.sessionResumptionUpdate.resumable === true && typeof message.sessionResumptionUpdate.newHandle === "string") this.#resumptionHandle = message.sessionResumptionUpdate.newHandle;
    if (object(message.serverContent)) {
      const content = message.serverContent;
      if (content.interrupted === true) { this.#interrupt(); this.#finalize("assistant"); }
      if (object(content.inputTranscription) && typeof content.inputTranscription.text === "string") this.#transcript("user", content.inputTranscription.text);
      if (object(content.outputTranscription) && typeof content.outputTranscription.text === "string") this.#transcript("assistant", content.outputTranscription.text);
      if (object(content.modelTurn) && Array.isArray(content.modelTurn.parts)) for (const part of content.modelTurn.parts) {
        if (!object(part) || !object(part.inlineData) || typeof part.inlineData.data !== "string") continue;
        if (typeof part.inlineData.mimeType !== "string" || !/^audio\/pcm(?:;rate=24000)?$/i.test(part.inlineData.mimeType)) { this.#fail(new VoiceLiveError("voice_live_unsupported_audio", "语音服务返回了不支持的音频编码。")); return; }
        this.#audio(part.inlineData.data);
      }
      if (content.turnComplete === true) { this.#finalize("user"); this.#finalize("assistant"); if (this.#speakingUntil <= Date.now()) this.#setState("listening"); }
    }
    if (object(message.toolCall) && Array.isArray(message.toolCall.functionCalls)) for (const call of message.toolCall.functionCalls) {
      if (!object(call)) continue;
      const id = typeof call.id === "string" && call.id.length <= 256 ? call.id : randomUUID();
      const upstreamId = typeof call.id === "string" ? call.id : undefined;
      if (call.name !== DELEGATE_TOOL || !object(call.args) || typeof call.args.request !== "string" || !call.args.request.trim() || Buffer.byteLength(call.args.request) > MAX_CONTEXT_BYTES) {
        this.#send({ toolResponse: { functionResponses: [{ ...(upstreamId ? { id: upstreamId } : {}), name: typeof call.name === "string" ? call.name : DELEGATE_TOOL, response: { error: "Unsupported tool or invalid task request." } }] } }); continue;
      }
      this.#delegate(id, call.args.request, upstreamId);
    }
    if (object(message.toolCallCancellation) && Array.isArray(message.toolCallCancellation.ids)) for (const id of message.toolCallCancellation.ids) {
      const task = typeof id === "string" ? this.#tasks.get(id) : undefined;
      // Upstream turn cancellation must not cancel a durable Kulo task that was already accepted.
      if (task) task.cancelled = true;
    }
    if (object(message.goAway) && !this.#closing) {
      if (!this.#resumptionHandle) { this.#fail(new VoiceLiveError("voice_live_session_expiring", "语音会话即将到期，请重新连接。")); return; }
      this.#interrupt(); this.#setState("reconnecting");
      const old = this.#socket; this.#socket = undefined; old?.close(1000);
      // Each failed reconnect already emits a safe error and closes this connection.
      void this.#connect(true).catch(() => undefined);
    }
  }
  #appendOpenAI(type: "session.thinking.append" | "session.commentary.append", id: string | null, text: string): void {
    for (const content of contextChunks(contextText(text))) this.#sendApplication({ type, event_id: randomUUID(), delegation_id: id, content });
  }
  sendTaskResult(id: string, text: string, final = true): void {
    if (this.#closing || this.#ended) return;
    const task = this.#tasks.get(id);
    if (!task) throw new VoiceLiveError("voice_live_unknown_task", "通话任务标识无效。");
    const result = contextText(text);
    if (this.#config.provider === "openai") this.#appendOpenAI(final ? "session.commentary.append" : "session.thinking.append", id, result);
    else if (!task.cancelled && (!task.responded || this.#config.provider === "gemini" && supportsAsyncFunction(this.#config.modelId))) {
      this.#sendApplication({ toolResponse: { functionResponses: [{
        ...(task.upstreamId ? { id: task.upstreamId } : {}), name: DELEGATE_TOOL,
        response: { output: result, status: final ? "completed" : "running" },
        ...(supportsAsyncFunction(this.#config.modelId) ? { scheduling: final ? "WHEN_IDLE" : "SILENT" } : {}),
        ...(this.#config.provider === "gemini" && supportsAsyncFunction(this.#config.modelId) ? { willContinue: !final } : {}),
      }] } }); task.responded = true;
    } else this.#sendApplication({ clientContent: { turns: [{ role: "user", parts: [{ text: `[Kulo task ${id}; ${final ? "completed" : "progress"}]\n${result}` }] }], turnComplete: final } });
  }
  sendContext(text: string): void {
    this.sendNotification(text, false);
  }
  sendNotification(text: string, speak = true): void {
    const value = contextText(text);
    if (this.#closing || this.#ended) return;
    if (this.#config.provider === "openai") this.#appendOpenAI(speak ? "session.commentary.append" : "session.thinking.append", null, value);
    else this.#sendApplication({ clientContent: { turns: [{ role: "user", parts: [{ text: `[Kulo task update${speak ? "" : "; context only, do not announce"}]\n${value}` }] }], turnComplete: speak } });
  }
  #fail(error: VoiceLiveError): void {
    if (this.#ended) return;
    const reject = this.#connectReject; this.#connectReject = undefined; reject?.(error);
    this.#event({ type: "error", code: error.code, message: error.message }); this.#closing = true;
    this.#socket?.terminate(); this.#finish();
  }
  #finish(): void {
    if (this.#ended) return;
    this.#ended = true; this.#ready = false;
    clearTimeout(this.#connectTimer); clearTimeout(this.#closeTimer); clearTimeout(this.#speechTimer);
    for (const timer of this.#pendingDelegations.values()) clearTimeout(timer);
    this.#pendingDelegations.clear();
    this.#pendingCommands.length = 0;
    const signal = this.#options.signal ?? this.#input.signal;
    if (this.#abort) signal?.removeEventListener("abort", this.#abort);
    this.#finalize("user"); this.#finalize("assistant"); this.#setState("ended"); this.#resolveClosed();
  }
  close(): void {
    if (this.#closing || this.#ended) return;
    this.#closing = true;
    if (!this.#ready) { this.#fail(new VoiceLiveError("voice_live_cancelled", "通话连接已取消。")); return; }
    if (this.#config.provider === "openai") {
      this.#send({ type: "session.close", event_id: randomUUID() });
      this.#closeTimer = setTimeout(() => { this.#socket?.terminate(); this.#finish(); }, 3000);
    } else { this.#socket?.close(1000); this.#closeTimer = setTimeout(() => { this.#socket?.terminate(); this.#finish(); }, 1000); }
    this.#closeTimer.unref?.();
  }
}
export async function openVoiceLive(input: VoiceLiveOpenInput, options: VoiceLiveOptions = {}): Promise<VoiceLiveConnection> { return new LiveConnection(input, options).open(); }
export async function probeVoiceLive(config: VoiceLiveConfig, options: VoiceLiveOptions = {}): Promise<void> {
  const connection = await openVoiceLive({ ...config, onEvent: () => undefined, onDelegate: () => undefined }, options);
  connection.close(); await connection.closed;
}
