import { describe, expect, it, vi } from "vitest";
import { MAX_VOICE_TTS_TEXT, synthesizeVoice, type VoiceSynthesisConfig } from "../packages/hub/src/voice-tts.js";

const key = "synthetic-voice-tts-private-key";
const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
function wav(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
const config: VoiceSynthesisConfig = { provider: "minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal" };
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
const minimaxResponse = () => json({ base_resp: { status_code: 0 }, data: { audio: mp3.toString("hex") } });

describe("official voice synthesis adapters", () => {
  it.each([
    ["minimax-cn", "https://api.minimax.cn/v1/t2a_v2"],
    ["minimax-global", "https://api.minimax.io/v1/t2a_v2"],
  ] as const)("uses the %s official endpoint and returns MP3", async (provider, endpoint) => {
    const fetcher = vi.fn(async () => minimaxResponse());
    const result = await synthesizeVoice({ ...config, provider, speed: "fast" }, key, "你好，Moco。", { fetch: fetcher as typeof fetch });
    expect(result).toEqual({ bytes: mp3, mimeType: "audio/mpeg" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(endpoint);
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.redirect).toBe("error");
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: config.modelId, text: "你好，Moco。", stream: false, output_format: "hex",
      voice_setting: { voice_id: config.voice, speed: 1.2 }, audio_setting: { format: "mp3", channel: 1 },
    });
  });

  it("uses Gemini Interactions speech metadata and returns the complete WAV", async () => {
    const audio = wav();
    const fetcher = vi.fn(async () => json({ steps: [
      { type: "user_input", content: [{ type: "audio", data: "ignored" }] },
      { type: "model_output", content: [{ type: "audio", data: audio.toString("base64"), mime_type: "audio/wav" }] },
    ] }));
    const result = await synthesizeVoice({ provider: "gemini", modelId: "gemini-3.8-flash-tts", voice: "Kore", speed: "slow" }, key, "请慢一点。", { fetch: fetcher as typeof fetch });
    expect(result).toEqual({ bytes: audio, mimeType: "audio/wav" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ "x-goog-api-key": key });
    expect(request.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "gemini-3.8-flash-tts", response_format: { type: "audio", mime_type: "audio/wav" },
      generation_config: { speech_config: [{ voice: "Kore" }] },
      input: [{ type: "user_input", content: [{ type: "text", text: "请慢一点。", annotations: [{ type: "speech_metadata", style: "Speak slowly and clearly." }] }] }],
    });
  });

  it("rejects unsupported providers, invalid keys and oversized input before sending", async () => {
    const fetcher = vi.fn();
    await expect(synthesizeVoice({ ...config, provider: "https://other.example" as never }, key, "hello", { fetch: fetcher })).rejects.toMatchObject({ status: 400 });
    await expect(synthesizeVoice(config, `${key}\nInjected: true`, "hello", { fetch: fetcher })).rejects.toMatchObject({ code: "voice_tts_missing_credential" });
    await expect(synthesizeVoice(config, key, "x".repeat(MAX_VOICE_TTS_TEXT + 1), { fetch: fetcher })).rejects.toMatchObject({ code: "invalid_voice_tts_text" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { base_resp: { status_code: 1008, status_msg: key }, data: { audio: mp3.toString("hex") } },
    { base_resp: { status_code: 0 }, data: { audio: "00f" } },
    { base_resp: { status_code: 0 }, data: { audio: "00gg" } },
    { base_resp: { status_code: 0 }, data: { audio: "00000000" } },
    { base_resp: { status_code: 0 }, data: { audio: "https://untrusted.example/audio" } },
  ])("refuses provider errors and malformed or redirected audio", async (body) => {
    const fetcher = vi.fn(async () => json(body));
    const error = await synthesizeVoice(config, key, "hello", { fetch: fetcher as typeof fetch }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(key);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds response bodies before attempting to decode audio", async () => {
    const fetcher = vi.fn(async () => new Response("never parsed", { headers: { "content-length": String(100 * 1024 * 1024) } }));
    await expect(synthesizeVoice(config, key, "hello", { fetch: fetcher as typeof fetch })).rejects.toMatchObject({ code: "voice_tts_response_too_large" });
  });

  it("does not expose HTTP response text or a network exception containing a key", async () => {
    const rejected = vi.fn(async () => { throw new Error(`failed request ${key}`); });
    const networkError = await synthesizeVoice(config, key, "hello", { fetch: rejected as typeof fetch }).catch((cause: unknown) => cause);
    expect(String(networkError)).not.toContain(key);
    const forbidden = vi.fn(async () => new Response(key, { status: 403 }));
    await expect(synthesizeVoice(config, key, "hello", { fetch: forbidden as typeof fetch })).rejects.toMatchObject({ code: "voice_tts_provider_error", message: "语音合成认证失败，请检查 API Key。" });
  });

  it("aborts a stalled response and preserves explicit caller cancellation", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() { /* Deliberately no response bytes. */ } })));
    await expect(synthesizeVoice(config, key, "hello", { fetch: fetcher as typeof fetch, timeoutMs: 10 })).rejects.toMatchObject({ code: "voice_tts_timeout" });
    const controller = new AbortController();
    const pending = synthesizeVoice(config, key, "hello", { fetch: fetcher as typeof fetch, signal: controller.signal });
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
