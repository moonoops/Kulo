import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ChatAttachment, MediaJobSource, VoiceSnapshot } from "@moco/protocol";
import { VoiceError, type MocoVoiceService } from "../packages/hub/src/voice-service.js";
import { createVoiceToolsExtension, MocoSpeechGenerationsDoc } from "../packages/hub/src/tools-voice.js";
import { MocoUploadStore } from "../packages/hub/src/uploads.js";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => void | Promise<void>> = [];
function audio(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-voice-tools-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "voice-tool-test", models: [{ id: "test" }] }).provider);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models, registry: createRegistry() }, context);
  await harness.root(context, { agent: { model: { provider: "voice-tool-test", modelId: "test" } } });
  cleanup.push(() => harness.close(context));
  const uploads = new MocoUploadStore(path.join(directory, "uploads"));
  const source: MediaJobSource = { conversationId: 1, topicId: "root" };
  const settings = { tts: { enabled: true, hasCredential: true } } as VoiceSnapshot;
  const synthesize = vi.fn(async (_text: string, _signal?: AbortSignal) => ({ bytes: audio(), mimeType: "audio/wav" as const }));
  const service = { snapshot: vi.fn(async () => structuredClone(settings)), synthesize } as unknown as MocoVoiceService;
  let permitted = true;
  const assertActive = vi.fn(async () => { if (!permitted) throw new VoiceError(403, "voice_speech_scope_revoked", "工单已停止。"); });
  const publications = new Map<string, { asset: ChatAttachment; source: MediaJobSource; callId: string }>();
  const publish = vi.fn(async (asset: ChatAttachment, current: MediaJobSource, callId: string) => {
    if (!publications.has(asset.id)) publications.set(asset.id, { asset: structuredClone(asset), source: structuredClone(current), callId });
  });
  const api = {
    conversationId: 1, callId: "voice-tool-call-1",
    snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness),
  } as unknown as ToolExecutionApi;
  const extension = () => createVoiceToolsExtension({ service: () => service, uploads: () => uploads, scope: async () => structuredClone(source), assertActive, publish });
  const initial = extension();
  const invoke = (text = "你好，欢迎使用 Moco。", selected = initial, executionApi = api, executionContext = context) => selected.tools![0]!.execute({ text }, executionApi, executionContext);
  return { directory, harness, uploads, source, settings, synthesize, service, assertActive, publish, publications, api, extension, initial, invoke, revoke: () => { permitted = false; } };
}

describe("speech generation tool", () => {
  it("passes the actual calling tool identity to main-chat publication and preserves it when replaying the receipt", async () => {
    const f = await fixture();
    const api = { ...f.api, callId: "main-speech-publication-call" };
    const first = await f.invoke(undefined, f.initial, api);
    const details = first.details as { assetId: string };
    expect(first.details).toMatchObject({ status: "published", reused: false });
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ id: details.assetId }), f.source, api.callId);
    expect(f.publications.get(details.assetId)?.callId).toBe(api.callId);
    expect((await f.invoke(undefined, f.extension(), api)).details).toMatchObject({ status: "published", assetId: details.assetId, reused: true });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });

  it("returns a Worker review receipt and retains its calling tool identity when replayed", async () => {
    const f = await fixture();
    f.source.ticketId = "T-0001"; f.source.runEpoch = 1;
    const first = await f.invoke();
    const assetId = (first.details as { assetId: string }).assetId;
    expect(first.details).toMatchObject({ status: "pending_review", reused: false });
    expect(f.publications.get(assetId)).toMatchObject({ source: { ticketId: "T-0001", runEpoch: 1 }, callId: f.api.callId });
    expect((await f.invoke(undefined, f.extension())).details).toMatchObject({ status: "pending_review", assetId, reused: true });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("publishes real managed audio using only the configured voice capability", async () => {
    const f = await fixture();
    expect(f.initial.tools?.map((tool) => tool.name)).toEqual(["moco_synthesize_speech"]);
    const response = await f.invoke();
    const details = response.details as { assetId: string; status: string; reused: boolean };
    expect(details).toMatchObject({ status: "published", reused: false });
    expect(f.synthesize).toHaveBeenCalledWith("你好，欢迎使用 Moco。", undefined);
    expect(f.publish).toHaveBeenCalledTimes(1);
    const stored = f.uploads.getUpload(details.assetId)!;
    expect(f.uploads.readUploadBytes(stored)).toEqual(audio());
    expect(stored.record).toMatchObject({ ownerId: "agent:1", kind: "audio", mimeType: "audio/wav", presentation: "voice", referenceScopes: ["conversation:1"] });
    expect(f.publications.get(details.assetId)?.source).toEqual({ conversationId: 1, topicId: "root" });
    expect(JSON.stringify(response)).not.toMatch(/apiKey|credential|Authorization/);
    expect(f.assertActive.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("reuses a completed receipt across extension recreation without another paid request or publication", async () => {
    const f = await fixture();
    const first = await f.invoke();
    const repeated = await f.invoke(undefined, f.extension());
    expect(repeated.details).toMatchObject({ assetId: (first.details as { assetId: string }).assetId, reused: true });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(f.uploads.dir).filter((name) => name.endsWith(".meta.json"))).toHaveLength(1);
  });

  it("deduplicates concurrent invocations of the same durable call", async () => {
    const f = await fixture();
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    f.synthesize.mockImplementationOnce(async () => { await ready; return { bytes: audio(), mimeType: "audio/wav" }; });
    const first = f.invoke();
    const second = f.invoke();
    await vi.waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect((a.details as { assetId: string }).assetId).toBe((b.details as { assetId: string }).assetId);
    expect(b.details).toMatchObject({ reused: true });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("blocks disabled or unconfigured synthesis before charging or reserving a call", async () => {
    const f = await fixture();
    f.settings.tts.enabled = false;
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_tts_disabled" });
    f.settings.tts.enabled = true; f.settings.tts.hasCredential = false;
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_credential_required" });
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.harness.snapshot(MocoSpeechGenerationsDoc, context)).toBeUndefined();
  });

  it("rejects revoked, foreign and read-only scopes before synthesizing", async () => {
    const f = await fixture();
    f.source.readOnly = true;
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_scope_denied" });
    f.source.readOnly = false; f.source.conversationId = 999;
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_scope_denied" });
    f.source.conversationId = 1; f.revoke();
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_scope_revoked" });
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not publish audio when a Worker is stopped during synthesis", async () => {
    const f = await fixture();
    f.source.ticketId = "T-0001"; f.source.runEpoch = 1;
    f.synthesize.mockImplementationOnce(async () => { f.revoke(); return { bytes: audio(), mimeType: "audio/wav" }; });
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_scope_revoked" });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    expect(fs.existsSync(f.uploads.dir)).toBe(false);
    const receipts = Object.values((await f.harness.snapshot(MocoSpeechGenerationsDoc, context))!.operations);
    expect(receipts[0]?.status).toBe("failed");
  });

  it("does not publish when the TTS capability is disabled while synthesis is running", async () => {
    const f = await fixture();
    f.synthesize.mockImplementationOnce(async () => { f.settings.tts.enabled = false; return { bytes: audio(), mimeType: "audio/wav" }; });
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_tts_disabled" });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("retains a generated asset and retries publication without synthesizing again", async () => {
    const f = await fixture();
    f.publish.mockRejectedValueOnce(new Error("publication interrupted"));
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_publication_failed" });
    const before = Object.values((await f.harness.snapshot(MocoSpeechGenerationsDoc, context))!.operations)[0]!;
    expect(before.status).toBe("generated");
    expect(before.asset?.kind).toBe("audio");
    expect((await f.invoke(undefined, f.extension())).details).toMatchObject({ status: "published", assetId: before.asset!.id, reused: true });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publications.size).toBe(1);
    expect(f.publish.mock.calls.map((call) => call[2])).toEqual([f.api.callId, f.api.callId]);
  });

  it("retries interrupted Worker staging with the original audio and returns pending review", async () => {
    const f = await fixture();
    f.source.ticketId = "T-0001"; f.source.runEpoch = 1;
    f.publish.mockRejectedValueOnce(new Error("staging interrupted"));
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_publication_failed" });
    const generated = Object.values((await f.harness.snapshot(MocoSpeechGenerationsDoc, context))!.operations)[0]!;
    expect(generated.status).toBe("generated");
    const retried = await f.invoke(undefined, f.extension());
    expect(retried.details).toMatchObject({ status: "pending_review", assetId: generated.asset!.id, reused: true });
    expect(Object.values((await f.harness.snapshot(MocoSpeechGenerationsDoc, context))!.operations)[0]!.status).toBe("pending_review");
    expect(f.uploads.readUploadBytes(f.uploads.getUpload(generated.asset!.id)!)).toEqual(audio());
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publications.size).toBe(1);
    expect(f.publish.mock.calls.map((call) => call[2])).toEqual([f.api.callId, f.api.callId]);
  });

  it("recovers the gap after publication and before the receipt commits without a duplicate chat entry", async () => {
    const f = await fixture();
    let commits = 0;
    const normal = f.api.commit.bind(f.api);
    f.api.commit = (async (...args: Parameters<ToolExecutionApi["commit"]>) => {
      commits++;
      if (commits === 3) throw new Error("commit interrupted");
      return normal(...args);
    }) as ToolExecutionApi["commit"];
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_publication_failed" });
    expect(f.publications.size).toBe(1);
    expect((await f.invoke(undefined, f.extension())).details).toMatchObject({ status: "published", reused: true });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publications.size).toBe(1);
    expect(f.publish.mock.calls.map((call) => call[2])).toEqual([f.api.callId, f.api.callId]);
  });

  it("refuses an interrupted submitting receipt rather than calling the paid API again", async () => {
    const f = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    f.synthesize.mockImplementationOnce(async () => { await pending; return { bytes: audio(), mimeType: "audio/wav" }; });
    const first = f.invoke();
    await vi.waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    await expect(f.invoke(undefined, f.extension())).rejects.toMatchObject({ code: "voice_speech_submission_unknown" });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it("rejects changed content under one call ID and a missing already-generated resource", async () => {
    const f = await fixture();
    const first = await f.invoke();
    await expect(f.invoke("different text")).rejects.toMatchObject({ code: "voice_speech_call_conflict" });
    const asset = f.uploads.getUpload((first.details as { assetId: string }).assetId)!;
    fs.unlinkSync(asset.filePath);
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_asset_missing" });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });

  it("keeps unexpected provider failures out of receipts and prevents replay from charging again", async () => {
    const f = await fixture();
    const secret = "synthetic-provider-private-key";
    f.synthesize.mockRejectedValueOnce(new Error(`network ${secret}`));
    const first = await f.invoke().catch((error: unknown) => error);
    expect(String(first)).not.toContain(secret);
    expect(JSON.stringify(await f.harness.snapshot(MocoSpeechGenerationsDoc, context))).not.toContain(secret);
    await expect(f.invoke()).rejects.toMatchObject({ code: "voice_speech_generation_failed" });
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });

  it("respects cancellation before any new synthesis", async () => {
    const f = await fixture();
    const abort = new AbortController(); abort.abort();
    await expect(f.invoke(undefined, f.initial, f.api, withAbortSignal(abort.signal, context))).rejects.toThrow();
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
});
