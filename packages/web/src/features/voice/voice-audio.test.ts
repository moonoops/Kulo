import { describe, expect, it, vi } from "vitest";
import { decodePcm16, MicrophoneActivity, Pcm16Resampler, pcm16Base64, rootMeanSquare, VoicePlayback } from "./voice-audio";
import { mergeVoiceCaption } from "./use-voice-call";
import { voiceCallStatus } from "./voice-call-panel";

describe("voice PCM transport", () => {
  it("preserves a fractional microphone clock across chunks", () => {
    const input = Float32Array.from({ length: 4410 }, (_, index) => Math.sin(index / 13) * 0.7);
    const whole = new Pcm16Resampler(44100, 16000).push(input);
    const chunked = new Pcm16Resampler(44100, 16000);
    const parts: number[] = [];
    for (let offset = 0; offset < input.length; offset += 128) parts.push(...chunked.push(input.slice(offset, offset + 128)));
    expect(parts).toEqual([...whole]);
    expect(whole.length).toBeGreaterThanOrEqual(1599);
    expect(whole.length).toBeLessThanOrEqual(1601);
  });

  it("encodes clipped little-endian signed samples and decodes them for playback", () => {
    const samples = new Pcm16Resampler(24000, 24000).push(Float32Array.of(-2, -0.5, 0, 0.5, 2, 0));
    expect([...samples]).toEqual([-32768, -16384, 0, 16384, 32767]);
    const encoded = pcm16Base64(samples);
    expect([...decodePcm16(encoded)]).toEqual([...samples].map((value) => value / 32768));
    expect(rootMeanSquare(Float32Array.of(0, 0, 0))).toBe(0);
    expect(rootMeanSquare(Float32Array.of(-0.5, 0.5))).toBe(0.5);
  });

  it("rejects invalid rates and malformed audio instead of scheduling corrupt buffers", () => {
    expect(() => new Pcm16Resampler(0, 16000)).toThrow("采样率");
    expect(() => decodePcm16(btoa("odd"))).toThrow("格式");
    expect(() => decodePcm16("A".repeat(2 * 1024 * 1024 + 1))).toThrow("过大");
  });

  it("clears every queued source on interruption and schedules the next reply from now", () => {
    const sources: Array<{ onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; buffer?: unknown }> = [];
    const context = {
      currentTime: 2, destination: {},
      createBuffer: vi.fn((_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: vi.fn() })),
      createBufferSource: vi.fn(() => { const source = { onended: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn() }; sources.push(source); return source; }),
    };
    const active = vi.fn();
    const playback = new VoicePlayback(context as unknown as AudioContext, active);
    const packet = pcm16Base64(new Int16Array(2400));
    playback.enqueue(packet, 24000); playback.enqueue(packet, 24000);
    expect(active.mock.calls).toEqual([[true]]);
    expect(sources[1]!.start.mock.calls[0]![0]).toBeGreaterThan(sources[0]!.start.mock.calls[0]![0]);
    playback.interrupt();
    expect(sources.slice(0, 2).every((source) => source.stop.mock.calls.length === 1 && source.disconnect.mock.calls.length === 1)).toBe(true);
    context.currentTime = 3;
    playback.enqueue(packet, 24000);
    expect(sources[2]!.start).toHaveBeenCalledWith(3.015);
    expect(active.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("requires sustained microphone activity and holds old output until speech has stopped", () => {
    const activity = new MicrophoneActivity();
    const frame = new Float32Array(480).fill(0.2);
    for (let index = 0; index < 9; index++) expect(activity.observe(frame, 48000, index * 10)).toBe(false);
    expect(activity.observe(frame, 48000, 90)).toBe(true);
    expect(activity.isSpeaking(250)).toBe(true);
    expect(activity.isSpeaking(400)).toBe(false);
    activity.observe(new Float32Array(480), 48000, 410);
    expect(activity.observe(frame, 48000, 420)).toBe(false);
    activity.reset(); expect(activity.isSpeaking(430)).toBe(false);
  });
});

describe("live voice captions", () => {
  it("replaces cumulative text by stable role/id without duplicating final text", () => {
    let captions = mergeVoiceCaption([], { type: "transcript", id: "u1", role: "user", text: "搜索", final: false });
    captions = mergeVoiceCaption(captions, { type: "transcript", id: "a1", role: "assistant", text: "我来查", final: false });
    captions = mergeVoiceCaption(captions, { type: "transcript", id: "u1", role: "user", text: "搜索资料并生成报表", final: true });
    captions = mergeVoiceCaption(captions, { type: "transcript", id: "a1", role: "assistant", text: "我来查", final: true });
    expect(captions).toEqual([
      { id: "u1", role: "user", text: "搜索资料并生成报表", final: true },
      { id: "a1", role: "assistant", text: "我来查", final: true },
    ]);
  });

  it("keeps roles separate even if an upstream provider reuses an id", () => {
    const captions = mergeVoiceCaption([{ id: "turn", role: "user", text: "你好", final: true }], { type: "transcript", id: "turn", role: "assistant", text: "我在", final: true });
    expect(captions).toHaveLength(2);
    expect(voiceCallStatus({ state: "listening", muted: true })).toBe("麦克风已静音");
    expect(voiceCallStatus({ state: "ended", muted: true })).toBe("通话已结束");
  });
});
