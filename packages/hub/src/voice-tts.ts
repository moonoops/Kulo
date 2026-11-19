import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ModelProtocolAdapter, VoiceSpeed, VoiceTtsProvider } from "@kulo/protocol";
import { serviceApiFetch } from "./web-content.js";

export const VOICE_TTS_ORIGINS: Readonly<Record<VoiceTtsProvider, string>> = {
  "minimax-cn": "https://api.minimax.cn",
  "minimax-global": "https://api.minimax.io",
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com",
};
export const MAX_VOICE_TTS_TEXT = 8_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = MAX_AUDIO_BYTES * 2 + 1024 * 1024;

let cachedOpenAIClass: (new (opts: Record<string, unknown>) => {
  audio: { speech: { create: (body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<Response> } };
}) | undefined;
function getOpenAIClientClass() {
  if (!cachedOpenAIClass) {
    const piDir = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/@earendil-works/pi-ai"));
    const mod = createRequire(path.join(piDir, "package.json"))("openai") as { default: typeof cachedOpenAIClass };
    cachedOpenAIClass = mod.default;
  }
  return cachedOpenAIClass!;
}

export class VoiceTtsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message); this.name = "VoiceTtsError";
  }
}

export interface VoiceSynthesisConfig {
  provider: VoiceTtsProvider;
  protocolAdapter?: Extract<ModelProtocolAdapter, "openai-speech" | "minimax-t2a" | "gemini-tts">;
  baseUrl?: string;
  modelId: string;
  voice: string;
  speed: VoiceSpeed;
}
export interface VoiceSynthesisOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface VoiceSynthesisOutput { bytes: Buffer; mimeType: "audio/wav" | "audio/mpeg" }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fail(code: string, message: string, status?: number): never { throw new VoiceTtsError(code, message, status); }
function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) fail("invalid_voice_tts", `${label}无效。`, 400);
  return value.trim();
}
function validText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_VOICE_TTS_TEXT || /\x00/.test(value)) fail("invalid_voice_tts_text", `朗读内容应为 1 至 ${MAX_VOICE_TTS_TEXT} 个字符。`, 400);
  return value.trim();
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail("voice_tts_response_too_large", "合成语音超过大小限制。");
  }
  if (!response.body) fail("voice_tts_empty_response", "语音服务没有返回内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail("voice_tts_response_too_large", "合成语音超过大小限制。");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { return fail("voice_tts_invalid_response", "语音服务返回了无效数据。"); }
}

function decodeHex(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length || value.length > MAX_AUDIO_BYTES * 2 || value.length % 2 || !/^[0-9a-f]+$/i.test(value)) fail("voice_tts_invalid_audio", "语音服务没有返回有效音频。");
  const bytes = Buffer.from(value, "hex");
  if (bytes.length < 4 || !(bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) fail("voice_tts_invalid_audio", "语音服务返回的 MP3 无效。");
  return bytes;
}
function decodeWav(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("voice_tts_invalid_audio", "语音服务没有返回有效音频。");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_AUDIO_BYTES || bytes.length < 44 || bytes.toString("base64") !== value || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") fail("voice_tts_invalid_audio", "语音服务返回的 WAV 无效。");
  return bytes;
}

function isValidMp3(bytes: Buffer): boolean {
  return bytes.length >= 4 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0));
}
function isValidWav(bytes: Buffer): boolean {
  return bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
}

function resolveOrigin(rawBaseUrl: string): { origin: string; baseUrl: string } {
  let parsed: URL;
  try { parsed = new URL(rawBaseUrl); }
  catch { return fail("invalid_voice_tts", "语音服务地址无效。", 400); }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    fail("invalid_voice_tts", "语音服务地址无效。", 400);
  }
  return { origin: parsed.origin, baseUrl: rawBaseUrl.replace(/\/+$/, "") };
}

async function readAudioStream(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
    await response.body?.cancel();
    fail("voice_tts_response_too_large", "合成语音超过大小限制。");
  }
  if (!response.body) fail("voice_tts_empty_response", "语音服务没有返回内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_AUDIO_BYTES) fail("voice_tts_response_too_large", "合成语音超过大小限制。");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks);
}

/** The official origin or bound provider origin is selected by the adapter; credentials never follow redirects. */
export async function synthesizeVoice(config: VoiceSynthesisConfig, apiKey: string, rawText: string, options: VoiceSynthesisOptions = {}): Promise<VoiceSynthesisOutput> {
  if (typeof config.provider !== "string" || !Object.hasOwn(VOICE_TTS_ORIGINS, config.provider)) fail("invalid_voice_tts", "请选择支持的语音合成服务。", 400);
  const text = validText(rawText);
  const model = token(config.modelId, "语音模型");
  const voice = token(config.voice, "音色");
  if (!["slow", "normal", "fast"].includes(config.speed)) fail("invalid_voice_tts", "请选择有效语速。", 400);
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 16_384 || /[\x00-\x1f\x7f]/.test(apiKey)) fail("voice_tts_missing_credential", "请先配置语音合成 API Key。", 409);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 60_000)]);
  signal.throwIfAborted();

  const adapter = config.protocolAdapter ?? (config.provider === "openai" ? "openai-speech" : config.provider === "gemini" ? "gemini-tts" : "minimax-t2a");
  const transport = (url: string | URL | Request, init?: RequestInit) => {
    const merged: RequestInit = { ...init, redirect: "error", signal };
    const target = typeof url === "string" || url instanceof URL ? url : url.url;
    return options.fetch ? options.fetch(target, merged) : serviceApiFetch(target, merged, { maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: options.timeoutMs ?? 90_000 });
  };

  if (adapter === "openai-speech") {
    const resolved = config.baseUrl ? resolveOrigin(config.baseUrl) : { origin: VOICE_TTS_ORIGINS.openai, baseUrl: `${VOICE_TTS_ORIGINS.openai}/v1` };
    const normalizedBase = /\/v\d+(?:beta\d*)?$/.test(new URL(resolved.baseUrl).pathname) ? resolved.baseUrl : `${resolved.baseUrl}/v1`;
    const OpenAI = getOpenAIClientClass();
    const client = new OpenAI({ apiKey, baseURL: normalizedBase, maxRetries: 0, fetch: transport });
    let speechResponse: Response;
    try {
      speechResponse = await client.audio.speech.create({
        model,
        voice,
        input: text,
        response_format: "mp3",
        speed: ({ slow: 0.85, normal: 1, fast: 1.2 } as const)[config.speed],
      }, { signal });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
      if (status !== undefined) {
        return fail("voice_tts_provider_error", status === 401 || status === 403 ? "语音合成认证失败，请检查 API Key。" : `语音合成服务返回 HTTP ${status}。`);
      }
      return fail(signal.aborted ? "voice_tts_timeout" : "voice_tts_connection_failed", signal.aborted ? "语音合成超时，请重试。" : "无法连接语音合成服务，请重试。");
    }
    const bytes = await readAudioStream(speechResponse, signal);
    if (isValidWav(bytes)) return { bytes, mimeType: "audio/wav" };
    if (isValidMp3(bytes)) return { bytes, mimeType: "audio/mpeg" };
    return fail("voice_tts_invalid_audio", "语音服务返回的音频格式无效。");
  }

  const gemini = adapter === "gemini-tts";
  const resolvedOrigin = config.baseUrl ? resolveOrigin(config.baseUrl).origin : VOICE_TTS_ORIGINS[config.provider];
  const url = `${resolvedOrigin}${gemini ? "/v1beta/interactions" : "/v1/t2a_v2"}`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (gemini) {
    headers["x-goog-api-key"] = apiKey;
    if (resolvedOrigin !== VOICE_TTS_ORIGINS.gemini) headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body = gemini ? {
    model: model.replace(/^models\//, ""),
    input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: ({ slow: "Speak slowly and clearly.", normal: "Speak at a natural conversational pace.", fast: "Speak briskly while keeping clear pronunciation." } as const)[config.speed] }] }] }],
    response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
    generation_config: { speech_config: [{ voice }] },
    stream: false,
  } : {
    model, text, stream: false, output_format: "hex", language_boost: "auto",
    voice_setting: { voice_id: voice, speed: ({ slow: 0.8, normal: 1, fast: 1.2 } as const)[config.speed], vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  };
  let response: Response;
  try {
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" };
    response = options.fetch ? await options.fetch(url, init) : await serviceApiFetch(url, init, { maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: options.timeoutMs ?? 90_000 });
  }
  catch {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    return fail(signal.aborted ? "voice_tts_timeout" : "voice_tts_connection_failed", signal.aborted ? "语音合成超时，请重试。" : "无法连接语音合成服务，请重试。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail("voice_tts_provider_error", response.status === 401 || response.status === 403 ? "语音合成认证失败，请检查 API Key。" : `语音合成服务返回 HTTP ${response.status}。`);
  }
  let value: unknown;
  try { value = await responseJson(response, signal); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof VoiceTtsError) throw error;
    return fail(signal.aborted ? "voice_tts_timeout" : "voice_tts_connection_failed", signal.aborted ? "语音合成超时，请重试。" : "语音合成传输中断，请重试。");
  }
  if (!object(value)) fail("voice_tts_invalid_response", "语音服务返回了无效数据。");
  if (!gemini) {
    const status = object(value.base_resp) ? value.base_resp.status_code : undefined;
    if (status !== 0) fail("voice_tts_provider_error", "语音合成失败，请检查服务额度和模型配置。");
    return { bytes: decodeHex(object(value.data) ? value.data.audio : undefined), mimeType: "audio/mpeg" };
  }
  if (value.error) fail("voice_tts_provider_error", "语音合成失败，请检查服务额度和模型配置。");
  const audio = Array.isArray(value.steps) ? value.steps.filter(object).filter((step) => step.type === "model_output")
    .flatMap((step) => Array.isArray(step.content) ? step.content.filter(object) : [])
    .filter((content) => content.type === "audio").at(-1) : undefined;
  return { bytes: decodeWav(audio?.data), mimeType: "audio/wav" };
}
