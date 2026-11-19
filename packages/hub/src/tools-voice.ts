import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, type JsonObject, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { ChatAttachment, MediaJobSource } from "@moco/protocol";
import { VoiceError, type MocoVoiceService } from "./voice-service.js";
import { MAX_VOICE_TTS_TEXT, VoiceTtsError } from "./voice-tts.js";
import type { MocoUploadStore } from "./uploads.js";

interface SpeechReceipt {
  fingerprint: string;
  status: "submitting" | "generated" | "published" | "pending_review" | "failed";
  asset?: ChatAttachment;
  error?: { code: string; message: string };
}
interface SpeechGenerationState { operations: Record<string, SpeechReceipt> }
export const MocoSpeechGenerationsDoc = defineDoc<SpeechGenerationState & JsonObject>({
  kind: "moco.speech-generations", version: 1, scope: "session",
  initial: () => ({ operations: {} }) as SpeechGenerationState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export interface VoiceToolsOptions {
  service: () => MocoVoiceService;
  uploads: () => MocoUploadStore;
  scope: (api: ToolExecutionApi) => Promise<MediaJobSource>;
  assertActive: (source: MediaJobSource) => Promise<void>;
  /** Must publish idempotently for asset.id, including recovery after publication but before the tool receipt commits. */
  publish: (asset: ChatAttachment, source: MediaJobSource, callId: string) => Promise<void>;
}
interface SpeechResult { status: "published" | "pending_review"; assetId: string; reused: boolean }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const result = (value: SpeechResult) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], details: value as never });
function requireSame(receipt: SpeechReceipt, fingerprint: string): void {
  if (receipt.fingerprint !== fingerprint) throw new VoiceError(409, "voice_speech_call_conflict", "同一工具调用不能合成不同内容。");
}
function speechText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_VOICE_TTS_TEXT || /\x00/.test(value)) throw new VoiceError(400, "invalid_voice_tts_text", `合成文本应为 1 至 ${MAX_VOICE_TTS_TEXT} 个字符。`);
  return value.trim();
}
function generationError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  if (error instanceof VoiceTtsError) return new VoiceError(error.status, error.code, error.message);
  return new VoiceError(502, "voice_speech_generation_failed", "语音合成未完成，未再次提交生成。");
}

export function createVoiceToolsExtension(options: VoiceToolsOptions) {
  const inFlight = new Map<string, { fingerprint: string; promise: Promise<SpeechResult> }>();
  const synthesize = async (text: string, api: ToolExecutionApi, source: MediaJobSource, key: string, fingerprint: string, context: Context): Promise<SpeechResult> => {
    const assertActive = async () => {
      context.abortSignal?.throwIfAborted();
      await options.assertActive(source);
      if (!(await options.service().snapshot()).tts.enabled) throw new VoiceError(409, "voice_tts_disabled", "语音合成已关闭。");
      context.abortSignal?.throwIfAborted();
    };
    const reservation = await api.commit(async (tx) => {
      const state = await tx.doc(MocoSpeechGenerationsDoc);
      const previous = Object.hasOwn(state.operations, key) ? state.operations[key] : undefined;
      if (previous) { requireSame(previous, fingerprint); return { created: false, receipt: clone(previous) }; }
      const receipt: SpeechReceipt = { fingerprint, status: "submitting" };
      state.operations[key] = receipt;
      return { created: true, receipt: clone(receipt) };
    }, BACKGROUND_CONTEXT);
    let receipt = reservation.receipt;
    await assertActive();
    if (receipt.status === "failed") throw new VoiceError(409, receipt.error?.code ?? "voice_speech_generation_failed", receipt.error?.message ?? "此调用未完成，未再次提交生成。");
    if (!reservation.created && receipt.status === "submitting") throw new VoiceError(409, "voice_speech_submission_unknown", "原语音合成的提交状态待核实，未重复计费生成。");
    if (reservation.created) {
      try {
        const audio = await options.service().synthesize(text, context.abortSignal);
        await assertActive();
        const asset = options.uploads().saveUpload({
          bytes: audio.bytes, mimeType: audio.mimeType, name: audio.mimeType === "audio/wav" ? "语音.wav" : "语音.mp3",
          ownerId: `agent:${source.conversationId}`, idempotencyKey: `voice-speech:${source.conversationId}:${api.callId}`, presentation: "voice",
        });
        if (asset.kind !== "audio") throw new VoiceError(502, "voice_speech_invalid_audio", "合成服务没有返回有效音频。");
        receipt = { fingerprint, status: "generated", asset };
        await api.commit(async (tx) => {
          const state = await tx.doc(MocoSpeechGenerationsDoc);
          const current = state.operations[key];
          if (!current) throw new VoiceError(409, "voice_speech_receipt_missing", "语音合成记录不可用。");
          requireSame(current, fingerprint);
          state.operations[key] = clone(receipt);
        }, BACKGROUND_CONTEXT);
      } catch (cause) {
        const error = generationError(cause);
        await api.commit(async (tx) => {
          const state = await tx.doc(MocoSpeechGenerationsDoc);
          const current = state.operations[key];
          if (current?.fingerprint === fingerprint && current.status === "submitting") {
            current.status = "failed";
            current.error = { code: error.code, message: error.message };
          }
        }, BACKGROUND_CONTEXT);
        throw error;
      }
    }
    const asset = receipt.asset;
    const loaded = asset ? options.uploads().getUpload(asset.id) : null;
    if (!asset || !loaded || loaded.record.kind !== "audio" || loaded.record.ownerId !== `agent:${source.conversationId}`) throw new VoiceError(409, "voice_speech_asset_missing", "原语音资源已移除或不可用，未重新合成。");
    await assertActive();
    if (receipt.status === "published" || receipt.status === "pending_review") return { status: source.ticketId ? "pending_review" : "published", assetId: asset.id, reused: true };
    options.uploads().bindAttachments([asset], `conversation:${source.conversationId}`, `agent:${source.conversationId}`);
    await assertActive();
    try {
      await options.publish(asset, source, api.callId);
      await api.commit(async (tx) => {
        const state = await tx.doc(MocoSpeechGenerationsDoc);
        const current = state.operations[key];
        if (!current) throw new VoiceError(409, "voice_speech_receipt_missing", "语音合成记录不可用。");
        requireSame(current, fingerprint);
        current.status = source.ticketId ? "pending_review" : "published";
      }, BACKGROUND_CONTEXT);
    } catch {
      // Keep the generated asset: recovery republishes this ID instead of buying another synthesis.
      throw new VoiceError(502, "voice_speech_publication_failed", "语音已合成，发布未完成；重试会继续发布原语音。");
    }
    return { status: source.ticketId ? "pending_review" : "published", assetId: asset.id, reused: !reservation.created };
  };
  return defineExtension({
    name: "moco-voice",
    tools: [defineTool({
      name: "moco_synthesize_speech",
      description:
        "Synthesize verbatim spoken audio (`text`) using the configured TTS model and voice. Returns `published` when delivered by the coordinating assistant, or `pending_review` when staged privately by a Worker. Reuses in-flight/recovered calls without duplicate billing; if delivery is interrupted, report the status rather than issuing a duplicate call. 关键词：语音合成 文字转语音 朗读 配音 发语音消息 TTS",
      parameters: obj({ text: str({ description: "Exact plain text to read aloud." }) }), deferred: true, replay: "safe",
      execute: async (args, api, context) => {
        const text = speechText(args.text);
        context.abortSignal?.throwIfAborted();
        const source = await options.scope(api);
        if (source.readOnly || !Number.isSafeInteger(source.conversationId) || source.conversationId < 1 || source.conversationId !== Number(api.conversationId) || !api.callId) throw new VoiceError(403, "voice_speech_scope_denied", "当前调用没有语音生成权限。");
        await options.assertActive(source);
        context.abortSignal?.throwIfAborted();
        const settings = await options.service().snapshot();
        if (!settings.tts.enabled) throw new VoiceError(409, "voice_tts_disabled", "语音合成已关闭。");
        if (!settings.tts.hasCredential) throw new VoiceError(409, "voice_credential_required", "请先配置语音合成 API Key。");
        const key = digest([source.conversationId, api.callId]);
        const fingerprint = digest([text, source.conversationId, source.topicId, source.ticketId, source.projectId]);
        const running = inFlight.get(key);
        if (running) {
          if (running.fingerprint !== fingerprint) throw new VoiceError(409, "voice_speech_call_conflict", "同一工具调用不能合成不同内容。");
          return result({ ...await running.promise, reused: true });
        }
        const promise = synthesize(text, api, source, key, fingerprint, context);
        inFlight.set(key, { fingerprint, promise });
        try { return result(await promise); }
        finally { inFlight.delete(key); }
      },
    })],
  });
}
