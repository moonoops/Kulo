import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { VoiceSettingsInput } from "@moco/protocol";
import { FileCredentialStore } from "../packages/hub/src/providers.js";
import { MocoVoiceDoc, MocoVoiceService, type MocoVoiceOptions, type VoiceAsrEngine } from "../packages/hub/src/voice-service.js";

const cleanup: Array<() => void | Promise<void>> = [];
const context = BACKGROUND_CONTEXT;
const key = "synthetic-moco-voice-secret-key";
const tts = { enabled: true, provider: "minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal", apiKey: key } as const;
const call = { enabled: true, provider: "openai", modelId: "gpt-live-1", voice: "marin", apiKey: key } as const;

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(options: {
  directory?: string;
  asr?: VoiceAsrEngine;
  probe?: MocoVoiceOptions["probe"];
  fetch?: typeof globalThis.fetch;
  resolveModel?: MocoVoiceOptions["resolveModel"];
  cloudTranscribe?: MocoVoiceOptions["cloudTranscribe"];
} = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-voice-service-"));
  if (!options.directory) cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "voice-test", models: [{ id: "test" }] }).provider);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models, registry: createRegistry() }, context);
  await harness.root(context, { agent: { model: { provider: "voice-test", modelId: "test" } } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
  cleanup.push(close);
  const credentials = new FileCredentialStore(path.join(directory, "credentials.json"));
  const asr = options.asr ?? {
    status: vi.fn(() => ({ status: "unprepared" as const })),
    prepare: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => "语音识别结果。"),
    close: vi.fn(),
  };
  const changed = vi.fn();
  const probe = options.probe ?? vi.fn(async () => undefined);
  const service = new MocoVoiceService({
    harness, credentials, asr, onChanged: changed, probe, fetch: options.fetch,
    resolveModel: options.resolveModel, cloudTranscribe: options.cloudTranscribe,
    now: () => 1000,
  });
  await service.initialize({ prepareAsr: false });
  return { directory, harness, credentials, asr, changed, service, probe, close };
}

describe("voice settings and capability isolation", () => {
  it("defaults local ASR on and cloud abilities off without preparing resources on snapshot", async () => {
    const f = await fixture();
    const snapshot = await f.service.snapshot();
    expect(snapshot).toMatchObject({ revision: 0, asr: { enabled: true, status: "unprepared" }, tts: { enabled: false, hasCredential: false }, call: { enabled: false, hasCredential: false, status: "unverified" } });
    expect(f.asr.prepare).not.toHaveBeenCalled();
    await f.service.initialize();
    await vi.waitFor(() => expect(f.asr.prepare).toHaveBeenCalledTimes(1));
  });

  it("persists settings and credential references without storing keys in the document or snapshots", async () => {
    const f = await fixture();
    await f.credentials.modify("api-google-vertex", async () => ({ type: "api_key", key: "synthetic-mainstream-key" }));
    const saved = await f.service.configure({ expectedRevision: 0, tts, call });
    expect(saved).toMatchObject({ revision: 1, tts: { hasCredential: true }, call: { hasCredential: true } });
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(JSON.stringify(await f.harness.snapshot(MocoVoiceDoc, context))).not.toContain(key);
    expect((await f.credentials.read("api-google-vertex"))?.type).toBe("api_key");
    expect(await f.service.liveConfig()).toEqual({ provider: "openai", modelId: "gpt-live-1", voice: "marin", apiKey: key });
    await f.close();
    const reopened = await fixture({ directory: f.directory });
    expect(await reopened.service.snapshot()).toEqual(saved);
    expect(await reopened.service.liveConfig()).toEqual({ provider: "openai", modelId: "gpt-live-1", voice: "marin", apiKey: key });
    expect(await reopened.credentials.read("api-google-vertex")).toMatchObject({ key: "synthetic-mainstream-key" });
  });

  it("preserves a saved key for blank edits and rejects stale revisions", async () => {
    const f = await fixture();
    await f.service.configure({ expectedRevision: 0, call });
    const probed = await f.service.probeCall();
    expect(probed.call.status).toBe("ready");
    const saved = await f.service.configure({ expectedRevision: 1, call: { ...call, apiKey: "", enabled: false } });
    expect(saved.call).toMatchObject({ enabled: false, hasCredential: true, status: "ready" });
    await expect(f.service.configure({ expectedRevision: 1, asr: { enabled: false } })).rejects.toMatchObject({ status: 409, code: "voice_revision_conflict" });
    await expect(f.service.liveConfig()).rejects.toMatchObject({ code: "voice_call_disabled" });
    expect(await f.service.liveConfig({ allowDisabled: true })).toMatchObject({ apiKey: key });
  });

  it("never carries a key from one provider or ability into another", async () => {
    const f = await fixture();
    await f.service.configure({ expectedRevision: 0, call, tts });
    await expect(f.service.configure({ expectedRevision: 1, call: { ...call, provider: "vertex", modelId: "gemini-3.8-live", voice: "Kore", apiKey: "" } })).rejects.toMatchObject({ code: "voice_credential_required" });
    expect((await f.service.snapshot()).call.provider).toBe("openai");
    const changed = await f.service.configure({ expectedRevision: 1, call: { ...call, provider: "vertex", modelId: "gemini-3.8-live", voice: "Kore", enabled: false, apiKey: "" } });
    expect(changed.call).toMatchObject({ provider: "vertex", hasCredential: false, status: "unverified" });
    expect(changed.tts.hasCredential).toBe(true);
    const all = await f.credentials.list();
    expect(all).toHaveLength(1);
    await expect(f.service.liveConfig({ allowDisabled: true })).rejects.toMatchObject({ code: "voice_credential_required" });
  });

  it("requires a matching saved credential origin before cloud requests", async () => {
    const f = await fixture();
    await f.service.configure({ expectedRevision: 0, call, tts });
    const state = await f.harness.snapshot(MocoVoiceDoc, context);
    for (const ref of [state!.tts.credentialRef!, state!.call.credentialRef!]) {
      await f.credentials.modify(ref, async () => ({ type: "api_key", key, env: { MOCO_API_KEY_ORIGIN: "https://other.example" } }));
    }
    const snapshot = await f.service.snapshot();
    expect(snapshot.tts.hasCredential).toBe(false);
    expect(snapshot.call.hasCredential).toBe(false);
    await expect(f.service.synthesize("hello")).rejects.toMatchObject({ code: "voice_credential_required" });
    await expect(f.service.liveConfig()).rejects.toMatchObject({ code: "voice_credential_required" });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("does not partially apply settings when credential storage fails", async () => {
    const f = await fixture();
    vi.spyOn(f.credentials, "modify").mockRejectedValueOnce(new Error(`write failed ${key}`));
    const error = await f.service.configure({ expectedRevision: 0, asr: { enabled: false }, call }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "voice_credential_write_failed" });
    expect(String(error)).not.toContain(key);
    expect(await f.service.snapshot()).toMatchObject({ revision: 0, asr: { enabled: true }, call: { enabled: false, hasCredential: false } });
    expect((await f.harness.snapshot(MocoVoiceDoc, context))?.cleanup).toEqual({});
  });

  it("rejects unsupported fields and key header injection before credential writes", async () => {
    const f = await fixture();
    const modify = vi.spyOn(f.credentials, "modify");
    await expect(f.service.configure({ expectedRevision: 0, call: { ...call, projectId: "not-supported" } } as VoiceSettingsInput)).rejects.toMatchObject({ code: "invalid_voice_settings" });
    await expect(f.service.configure({ expectedRevision: 0, call: { ...call, apiKey: `${key}\nX-Key: other` } })).rejects.toMatchObject({ code: "invalid_voice_credential" });
    await expect(f.service.configure({ expectedRevision: 0, tts: { ...tts, provider: "__proto__" as never } })).rejects.toMatchObject({ code: "invalid_voice_settings" });
    await expect(f.service.configure({ expectedRevision: 0, call: { ...call, provider: ["gemini"] as never } })).rejects.toMatchObject({ code: "invalid_voice_settings" });
    expect(modify).not.toHaveBeenCalled();
  });

  it("serializes competing saves and rejects the outdated form", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.service.configure({ expectedRevision: 0, call }),
      f.service.configure({ expectedRevision: 0, tts }),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "voice_revision_conflict" } });
    expect(await f.credentials.list()).toHaveLength(1);
  });

  it("routes local recognition through the enabled flag and exposes preparation failures", async () => {
    const f = await fixture();
    expect(await f.service.transcribe("/managed/audio.webm")).toBe("语音识别结果。");
    expect(f.asr.transcribe).toHaveBeenCalledWith("/managed/audio.webm", undefined);
    await f.service.configure({ expectedRevision: 0, asr: { enabled: false } });
    await expect(f.service.transcribe("/managed/audio.webm")).rejects.toMatchObject({ code: "voice_asr_disabled" });
    await expect(f.service.prepareAsr()).rejects.toMatchObject({ code: "voice_asr_disabled" });
    expect(f.asr.transcribe).toHaveBeenCalledTimes(1);
    const failed = await fixture({ asr: { status: () => ({ status: "unprepared" }), prepare: async () => { throw new Error("模型准备失败"); }, transcribe: vi.fn(), close: vi.fn() } });
    await expect(failed.service.prepareAsr()).rejects.toMatchObject({ code: "voice_asr_prepare_failed" });
    expect((await failed.service.snapshot()).asr).toMatchObject({ status: "error", error: "模型准备失败" });
  });

  it("uses the saved TTS adapter and refuses synthesis while disabled", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: "494433040000" } })));
    const f = await fixture({ fetch: fetcher as typeof globalThis.fetch });
    await expect(f.service.synthesize("hello")).rejects.toMatchObject({ code: "voice_tts_disabled" });
    await f.service.configure({ expectedRevision: 0, tts });
    expect(await f.service.synthesize("你好")).toMatchObject({ mimeType: "audio/mpeg" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit settings preview without enabling ordinary speech synthesis", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: "494433040000" } })));
    const f = await fixture({ fetch: fetcher as typeof globalThis.fetch });
    await f.service.configure({ expectedRevision: 0, tts: { ...tts, enabled: false } });
    expect(await f.service.synthesize("试听", undefined, { preview: true })).toMatchObject({ mimeType: "audio/mpeg" });
    await expect(f.service.synthesize("普通朗读")).rejects.toMatchObject({ code: "voice_tts_disabled" });
    expect((await f.service.snapshot()).tts.enabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("records failed probes without leaking keys or changing form revisions", async () => {
    const f = await fixture({ probe: async () => { throw new Error(`rejected ${key}`); } });
    await f.service.configure({ expectedRevision: 0, call: { ...call, enabled: false } });
    const probed = await f.service.probeCall();
    expect(probed).toMatchObject({ revision: 1, call: { status: "error", lastCheckedAt: 1000 } });
    expect(probed.call.error).not.toContain(key);
    expect(JSON.stringify(await f.harness.snapshot(MocoVoiceDoc, context))).not.toContain(key);
  });

  it("does not apply a probe result to a replacement call configuration", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const probe = vi.fn(async () => pending);
    const f = await fixture({ probe });
    await f.service.configure({ expectedRevision: 0, call });
    const checking = f.service.probeCall();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    await f.service.configure({ expectedRevision: 1, call: { ...call, voice: "cedar", apiKey: "" } });
    finish();
    expect((await checking).call).toMatchObject({ voice: "cedar", status: "unverified" });
  });

  it("resolves providerId-backed ASR, OpenAI Speech TTS, and Live models through unified credentials", async () => {
    const mp3Header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const sdkFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/audio/speech")) {
        expect(init?.headers && new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
        return new Response(mp3Header, { status: 200, headers: { "content-type": "audio/mpeg" } });
      }
      if (url.endsWith("/audio/transcriptions")) {
        expect(init?.headers && new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
        return new Response(JSON.stringify({ text: "OpenAI SDK 转写成功" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    const probe = vi.fn(async () => {});
    const resolvedModels = new Map([
      ["api-openai::gpt-4o-transcribe", {
        providerId: "api-openai", modelId: "gpt-4o-transcribe", baseUrl: "https://newapi.example.com/v1",
        api: "openai-completions" as const, model: { id: "gpt-4o-transcribe", purpose: "asr" as const, protocolAdapter: "openai-asr" as const },
        protocolAdapter: "openai-asr" as const, voices: [], apiKey: key,
      }],
      ["api-openai::gpt-4o-mini-tts", {
        providerId: "api-openai", modelId: "gpt-4o-mini-tts", baseUrl: "https://newapi.example.com/v1",
        api: "openai-completions" as const, model: { id: "gpt-4o-mini-tts", purpose: "tts" as const, protocolAdapter: "openai-speech" as const },
        protocolAdapter: "openai-speech" as const, voices: ["alloy", "nova"], apiKey: key,
      }],
      ["api-openai::gpt-4o-realtime-preview", {
        providerId: "api-openai", modelId: "gpt-4o-realtime-preview", baseUrl: "https://newapi.example.com/v1",
        api: "openai-completions" as const, model: { id: "gpt-4o-realtime-preview", purpose: "live" as const, protocolAdapter: "openai-realtime" as const },
        protocolAdapter: "openai-realtime" as const, voices: ["marin"], apiKey: key,
      }],
    ]);
    const f = await fixture({
      fetch: sdkFetch as unknown as typeof fetch,
      probe,
      resolveModel: async (providerId, modelId) => resolvedModels.get(`${providerId}::${modelId}`),
    });

    const configured = await f.service.configure({
      expectedRevision: 0,
      asr: { enabled: true, source: "provider", providerId: "api-openai", modelId: "gpt-4o-transcribe" },
      tts: { enabled: true, provider: "openai", providerId: "api-openai", modelId: "gpt-4o-mini-tts", voice: "nova", speed: "fast" },
      call: { enabled: true, provider: "openai", providerId: "api-openai", modelId: "gpt-4o-realtime-preview", voice: "marin" },
    });
    expect(configured.asr).toMatchObject({ enabled: true, source: "provider", providerId: "api-openai", modelId: "gpt-4o-transcribe", status: "ready", hasCredential: true });
    expect(configured.tts).toMatchObject({ enabled: true, provider: "openai", providerId: "api-openai", modelId: "gpt-4o-mini-tts", voice: "nova", hasCredential: true });
    expect(configured.call).toMatchObject({ enabled: true, provider: "openai", providerId: "api-openai", modelId: "gpt-4o-realtime-preview", voice: "marin", hasCredential: true });

    const wavFile = path.join(f.directory, "test.wav");
    fs.writeFileSync(wavFile, Buffer.from("RIFF....WAVEfmt "));
    expect(await f.service.transcribe(wavFile)).toBe("OpenAI SDK 转写成功");

    const audio = await f.service.synthesize("你好世界");
    expect(audio.mimeType).toBe("audio/mpeg");
    expect(audio.bytes.equals(mp3Header)).toBe(true);

    const probed = await f.service.probeCall();
    expect(probed.call.status).toBe("ready");
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        baseUrl: "https://newapi.example.com/v1",
        modelId: "gpt-4o-realtime-preview",
        voice: "marin",
        apiKey: key,
      }),
      expect.any(Object),
    );
  });

  it("starts with truly empty TTS and Live selections and rejects enabling without a model", async () => {
    const f = await fixture();
    const snap = await f.service.snapshot();
    expect(snap.tts).toMatchObject({ enabled: false, modelId: "", voice: "", speed: "normal", hasCredential: false });
    expect(snap.tts.provider).toBeUndefined();
    expect(snap.call).toMatchObject({ enabled: false, modelId: "", voice: "", hasCredential: false, status: "unverified" });
    expect(snap.call.provider).toBeUndefined();

    await expect(f.service.configure({ expectedRevision: 0, tts: { enabled: true, modelId: "", voice: "", speed: "normal" } }))
      .rejects.toMatchObject({ status: 409, code: "voice_model_required" });
    await expect(f.service.configure({ expectedRevision: 0, call: { enabled: true, modelId: "", voice: "" } }))
      .rejects.toMatchObject({ status: 409, code: "voice_model_required" });
    await expect(f.service.synthesize("试听", undefined, { preview: true }))
      .rejects.toMatchObject({ status: 409, code: "voice_model_required" });
    await expect(f.service.liveConfig({ allowDisabled: true }))
      .rejects.toMatchObject({ status: 409, code: "voice_model_required" });
  });

  it("migrates legacy phantom defaults to empty while preserving legacy standalone credentials", async () => {
    const f = await fixture();
    await f.harness.commit(async (tx) => {
      const doc = await tx.doc(MocoVoiceDoc);
      delete doc.defaultsMigratedV2;
      doc.tts = { enabled: false, provider: "minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "fast" };
      doc.call = { enabled: false, provider: "openai", modelId: "gpt-live-1", voice: "marin", status: "unverified" };
    }, context);
    await f.service.initialize({ prepareAsr: false });
    const migrated = await f.service.snapshot();
    expect(migrated.tts).toMatchObject({ enabled: false, modelId: "", voice: "", speed: "fast" });
    expect(migrated.tts.provider).toBeUndefined();
    expect(migrated.call).toMatchObject({ enabled: false, modelId: "", voice: "" });
    expect(migrated.call.provider).toBeUndefined();
  });

  it("auto-binds provider TTS/Live models while keeping switches off and clears deleted bindings", async () => {
    const f = await fixture();
    const changed = await f.service.syncProviderModels([
      { purpose: "tts", providerId: "api-unauth", modelId: "tts-unauth", protocolAdapter: "openai-speech", voices: ["echo"], authenticated: false },
      { purpose: "tts", providerId: "api-auth", modelId: "tts-auth", protocolAdapter: "openai-speech", voices: ["nova", "alloy"], authenticated: true },
      { purpose: "live", providerId: "api-auth", modelId: "live-auth", protocolAdapter: "openai-realtime", voices: ["marin"], authenticated: true },
    ]);
    expect(changed).toBe(true);
    const bound = await f.service.snapshot();
    expect(bound.tts).toMatchObject({ enabled: false, provider: "openai", providerId: "api-auth", modelId: "tts-auth", voice: "nova" });
    expect(bound.call).toMatchObject({ enabled: false, provider: "openai", providerId: "api-auth", modelId: "live-auth", voice: "marin" });

    // Removing all provider voice models clears & disables them cleanly.
    const cleared = await f.service.syncProviderModels([]);
    expect(cleared).toBe(true);
    const afterClear = await f.service.snapshot();
    expect(afterClear.tts).toMatchObject({ enabled: false, modelId: "", voice: "" });
    expect(afterClear.tts.providerId).toBeUndefined();
    expect(afterClear.call).toMatchObject({ enabled: false, modelId: "", voice: "" });
    expect(afterClear.call.providerId).toBeUndefined();
  });
});
