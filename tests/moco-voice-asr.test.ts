import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceAsr, type LocalVoiceAsrOptions, type LocalVoiceAsrStatus, type VoiceAsrProcessRunner } from "../packages/hub/src/voice-asr.js";

const directories: string[] = [];
const services: LocalVoiceAsr[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(options: Partial<LocalVoiceAsrOptions> = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "moco-voice-asr-"));
  directories.push(stateDir);
  const statuses: LocalVoiceAsrStatus[] = [];
  const service = new LocalVoiceAsr({ stateDir, ffmpegPath: process.execPath, onStatus: (status) => statuses.push(status), ...options });
  services.push(service);
  return { service, stateDir, statuses };
}
async function audioFixture(run: VoiceAsrProcessRunner) {
  const f = await fixture({ run, ffmpegPath: "/test/ffmpeg" });
  await fs.mkdir(path.join(f.stateDir, "voice", "asr"), { recursive: true });
  const audio = path.join(f.stateDir, "voice.webm");
  await fs.writeFile(audio, "recorded audio fixture");
  vi.spyOn(f.service, "prepare").mockResolvedValue();
  return { ...f, audio };
}
async function decoded(args: string[]): Promise<void> { await fs.writeFile(args.at(-1)!, Buffer.alloc(16000 * 4)); }

describe("Hub local speech resource preparation", () => {
  it("deduplicates concurrent preparation, reports failure, and permits an explicit retry", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const f = await fixture({ fetch: fetcher as typeof fetch });
    expect(f.service.status()).toEqual({ status: "unprepared" });
    const results = await Promise.allSettled([f.service.prepare(), f.service.prepare(), f.service.prepare()]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2");
    expect(f.service.status()).toMatchObject({ status: "error", error: expect.stringContaining("下载失败") });
    await expect(f.service.prepare()).rejects.toMatchObject({ code: "asr_download_failed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.statuses.some((status) => status.status === "ready")).toBe(false);
    expect(await fs.readdir(path.join(f.stateDir, "voice", "asr"))).toEqual([]);
  });

  it("rejects an unexpected download origin before requesting it", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://untrusted.example.test/model" } }));
    const f = await fixture({ fetch: fetcher as typeof fetch });
    await expect(f.service.prepare()).rejects.toMatchObject({ code: "asr_download_origin" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and corrupt downloads without executing or installing them", async () => {
    const run = vi.fn<VoiceAsrProcessRunner>();
    const fetcher = vi.fn(async () => new Response("too large", { headers: { "Content-Length": "999999999" } }));
    const f = await fixture({ fetch: fetcher as typeof fetch, run });
    await expect(f.service.prepare()).rejects.toMatchObject({ code: "asr_download_size" });
    fetcher.mockImplementation(async () => new Response("corrupt release"));
    await expect(f.service.prepare()).rejects.toMatchObject({ code: "asr_model_checksum" });
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(f.stateDir, "voice", "asr"))).toEqual([]);
  });

  it("does not trust an incomplete preinstalled model or replace its files", async () => {
    const modelDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "moco-voice-model-"));
    directories.push(modelDirectory);
    await fs.writeFile(path.join(modelDirectory, "model.int8.onnx"), "incomplete");
    const fetcher = vi.fn<typeof fetch>();
    const f = await fixture({ modelDirectory, fetch: fetcher });
    await expect(f.service.prepare()).rejects.toMatchObject({ code: "asr_model_invalid" });
    expect(await fs.readFile(path.join(modelDirectory, "model.int8.onnx"), "utf8")).toBe("incomplete");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels resource preparation when the Hub closes", async () => {
    let downloading!: () => void;
    const started = new Promise<void>((resolve) => { downloading = resolve; });
    const fetcher: typeof fetch = async (_url, options) => {
      downloading();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(options!.signal!.reason);
        options!.signal!.addEventListener("abort", abort, { once: true });
        if (options!.signal!.aborted) abort();
      });
    };
    const f = await fixture({ fetch: fetcher });
    const preparation = f.service.prepare();
    const rejected = expect(preparation).rejects.toMatchObject({ code: "asr_closed" });
    await started;
    f.service.close();
    await rejected;
    await expect(f.service.prepare()).rejects.toMatchObject({ code: "asr_closed" });
  });
});

describe("Hub local voice decoding and transcription", () => {
  it("decodes locally, preserves recognized text, and removes temporary audio", async () => {
    const run = vi.fn<VoiceAsrProcessRunner>(async (command, args) => {
      if (command === "/test/ffmpeg") { await decoded(args); return ""; }
      return JSON.stringify({ text: "  请整理一份报表。  " });
    });
    const f = await audioFixture(run);
    await expect(f.service.transcribe(f.audio)).resolves.toBe("请整理一份报表。");
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["-protocol_whitelist", "file,pipe", "-ac", "1", "-ar", "16000", "-f", "f32le"]));
    expect(run.mock.calls[1]![1][1]).toBe("--transcribe");
    expect(run.mock.calls[1]![2].native).toBe(true);
    expect(await fs.readdir(path.join(f.stateDir, "voice", "asr"))).toEqual([]);
  });

  it("surfaces decoding errors and allows a later recording to succeed", async () => {
    let fail = true;
    const run = vi.fn<VoiceAsrProcessRunner>(async (command, args) => {
      if (command === "/test/ffmpeg") {
        if (fail) { fail = false; throw new Error("decoder failed with a private filesystem path"); }
        await decoded(args); return "";
      }
      return JSON.stringify({ text: "重试成功" });
    });
    const f = await audioFixture(run);
    await expect(f.service.transcribe(f.audio)).rejects.toMatchObject({ code: "asr_decode_failed", message: "这段语音无法解码，请重新录制后重试。" });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(f.service.transcribe(f.audio)).resolves.toBe("重试成功");
  });

  it("serializes inference and cancels a queued request promptly without starting it", async () => {
    let release!: () => void;
    let inferenceStarted!: () => void;
    const started = new Promise<void>((resolve) => { inferenceStarted = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn<VoiceAsrProcessRunner>(async (command, args) => {
      if (command === "/test/ffmpeg") { await decoded(args); return ""; }
      inferenceStarted(); await pending;
      return JSON.stringify({ text: "第一条" });
    });
    const f = await audioFixture(run);
    const first = f.service.transcribe(f.audio);
    await started;
    const controller = new AbortController();
    const second = f.service.transcribe(f.audio, controller.signal);
    const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await expect(first).resolves.toBe("第一条");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("passes active cancellation to the decoder and cleans its temporary files", async () => {
    let decoding!: () => void;
    const started = new Promise<void>((resolve) => { decoding = resolve; });
    const run = vi.fn<VoiceAsrProcessRunner>(async (_command, _args, options) => {
      decoding();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
    });
    const f = await audioFixture(run);
    const controller = new AbortController();
    const work = f.service.transcribe(f.audio, controller.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    await rejected;
    await vi.waitFor(async () => expect(await fs.readdir(path.join(f.stateDir, "voice", "asr"))).toEqual([]));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects empty recognition and invalid audio instead of returning success-shaped text", async () => {
    const run = vi.fn<VoiceAsrProcessRunner>(async (command, args) => {
      if (command === "/test/ffmpeg") { await decoded(args); return ""; }
      return JSON.stringify({ text: "" });
    });
    const f = await audioFixture(run);
    await expect(f.service.transcribe(f.audio)).rejects.toMatchObject({ code: "asr_no_speech" });
    await fs.truncate(f.audio, 0);
    await expect(f.service.transcribe(f.audio)).rejects.toMatchObject({ code: "asr_invalid_audio" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(path.join(f.stateDir, "voice", "asr"))).toEqual([]);
  });
});
