import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import {
  defaultProtocolAdapterForModel,
  defaultVoicesForAdapter,
  redactSecrets, redactSensitiveText,
  type ModelProtocolAdapter, type VoiceAsrSource, type VoiceAsrStatus, type VoiceLiveProvider, type VoiceSettingsInput,
  type VoiceSnapshot, type VoiceTtsProvider,
} from "@moco/protocol";
import { transcribeCloudAudio } from "./voice-asr.js";
import { synthesizeVoice, VOICE_TTS_ORIGINS, type VoiceSynthesisOutput } from "./voice-tts.js";

const ORIGIN_ENV = "MOCO_API_KEY_ORIGIN";
const CALL_ORIGINS: Readonly<Record<VoiceLiveProvider, string>> = {
  openai: "https://api.openai.com", gemini: "https://generativelanguage.googleapis.com", vertex: "https://aiplatform.googleapis.com",
};
const DEFAULT_TTS: Omit<StoredTts, keyof StoredCredential> = { enabled: false, modelId: "", voice: "", speed: "normal" };
const DEFAULT_CALL: Omit<StoredCall, keyof StoredCredential> = { enabled: false, modelId: "", voice: "", status: "unverified" };

interface StoredCredential { credentialRef?: string; credentialOrigin?: string }
type StoredTts = Omit<VoiceSnapshot["tts"], "hasCredential"> & StoredCredential;
type StoredCall = Omit<VoiceSnapshot["call"], "hasCredential"> & StoredCredential;
export interface MocoVoiceState {
  revision: number;
  defaultsMigratedV2?: boolean;
  asrEnabled: boolean;
  asrSource?: VoiceAsrSource;
  asrProviderId?: string;
  asrModelId?: string;
  tts: StoredTts;
  call: StoredCall;
  cleanup: Record<string, boolean>;
}
export const MocoVoiceDoc = defineDoc<MocoVoiceState & JsonObject>({
  kind: "moco.voice", version: 1, scope: "session",
  initial: () => ({ revision: 0, defaultsMigratedV2: true, asrEnabled: true, tts: { ...DEFAULT_TTS }, call: { ...DEFAULT_CALL }, cleanup: {} }) as MocoVoiceState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class VoiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "VoiceError"; }
}
export interface VoiceAsrEngine {
  status(): { status: VoiceAsrStatus; progress?: number; error?: string };
  prepare(): Promise<void>;
  transcribe(filePath: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}
export interface ResolvedVoiceModelConnection {
  baseUrl: string;
  apiKey?: string;
  protocolAdapter?: ModelProtocolAdapter;
  preset?: string;
}
export interface SyncedVoiceModelCandidate {
  purpose: "asr" | "tts" | "live";
  providerId: string;
  modelId: string;
  protocolAdapter?: ModelProtocolAdapter;
  preset?: string;
  voices?: string[];
  authenticated?: boolean;
}
export interface VoiceLiveConfiguration { provider: VoiceLiveProvider; baseUrl?: string; modelId: string; voice: string; apiKey: string }
export interface MocoVoiceOptions {
  harness: Harness;
  credentials: CredentialStore;
  asr: VoiceAsrEngine;
  resolveModel?: (providerId: string, modelId: string) => Promise<ResolvedVoiceModelConnection | undefined>;
  cloudTranscribe?: typeof transcribeCloudAudio;
  onChanged?: () => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  probe?: (config: VoiceLiveConfiguration, options?: { signal?: AbortSignal }) => Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(status: number, code: string, message: string): never { throw new VoiceError(status, code, message); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(400, "invalid_voice_settings", "语音设置包含不支持的字段。");
}
function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) fail(400, "invalid_voice_settings", `${label}无效。`);
  return value.trim();
}
function keyValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 16_384 || /[\x00-\x1f\x7f]/.test(value)) fail(400, "invalid_voice_credential", "API Key 无效。");
  return value.trim() || undefined;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail(400, "invalid_voice_settings", "语音开关必须是布尔值。");
  return value;
}
function safeError(error: unknown, secrets: readonly string[] = []): string {
  return redactSecrets(redactSensitiveText(error instanceof Error ? error.message : String(error), secrets)).slice(0, 350) || "语音服务暂不可用。";
}
function callIdentity(call: StoredCall): string { return JSON.stringify([call.providerId ?? "", call.provider ?? "", call.modelId, call.voice, call.credentialRef, call.credentialOrigin]); }

function ttsProviderFromAdapter(adapter: ModelProtocolAdapter | undefined, preset?: string): VoiceTtsProvider {
  if (adapter === "gemini-tts") return "gemini";
  if (adapter === "minimax-t2a") return preset === "minimax" ? "minimax-global" : "minimax-cn";
  return "openai";
}

function liveProviderFromAdapter(adapter: ModelProtocolAdapter | undefined): VoiceLiveProvider {
  if (adapter === "vertex-live") return "vertex";
  if (adapter === "gemini-live") return "gemini";
  return "openai";
}

export class MocoVoiceService {
  readonly #options: MocoVoiceOptions;
  #tail: Promise<unknown> = Promise.resolve();
  #preparation?: Promise<void>;
  #asrError?: string;
  #probeId = 0;
  #closed = false;
  constructor(options: MocoVoiceOptions) { this.#options = options; }
  #now(): number { return this.#options.now?.() ?? Date.now(); }
  async #state(): Promise<Readonly<MocoVoiceState>> {
    return (await this.#options.harness.snapshot(MocoVoiceDoc, BACKGROUND_CONTEXT)) ?? { revision: 0, defaultsMigratedV2: true, asrEnabled: true, tts: { ...DEFAULT_TTS }, call: { ...DEFAULT_CALL }, cleanup: {} };
  }
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
  async #changed(): Promise<void> { if (!this.#closed) await this.#options.onChanged?.(); }
  async #cleanup(): Promise<void> {
    for (const ref of Object.keys((await this.#state()).cleanup)) {
      await this.#options.credentials.delete(ref);
      await this.#options.harness.commit(async (tx) => { delete (await tx.doc(MocoVoiceDoc)).cleanup[ref]; }, BACKGROUND_CONTEXT);
    }
  }
  async initialize(options: { prepareAsr?: boolean } = {}): Promise<void> {
    await this.#serial(async () => {
      await this.#cleanup();
      const persisted = await this.#options.harness.snapshot(MocoVoiceDoc, BACKGROUND_CONTEXT);
      if (persisted && !persisted.defaultsMigratedV2) {
        await this.#options.harness.commit(async (tx) => {
          const doc = await tx.doc(MocoVoiceDoc);
          if (doc.defaultsMigratedV2) return;
          if (!doc.tts.providerId && !doc.tts.credentialRef && !doc.tts.enabled) {
            doc.tts = { ...DEFAULT_TTS, speed: doc.tts.speed ?? "normal" };
          }
          if (!doc.call.providerId && !doc.call.credentialRef && !doc.call.enabled) {
            doc.call = { ...DEFAULT_CALL };
          }
          doc.defaultsMigratedV2 = true;
        }, BACKGROUND_CONTEXT);
      }
    });
    const state = await this.#state();
    if (options.prepareAsr !== false && state.asrEnabled && state.asrSource !== "provider" && this.#options.asr.status().status === "unprepared") this.#prepareInBackground();
  }
  async syncProviderModels(candidates: readonly SyncedVoiceModelCandidate[]): Promise<boolean> {
    if (this.#closed) return false;
    const byPurpose = {
      asr: candidates.filter((c) => c.purpose === "asr"),
      tts: candidates.filter((c) => c.purpose === "tts"),
      live: candidates.filter((c) => c.purpose === "live"),
    };
    const hasMatch = (list: readonly SyncedVoiceModelCandidate[], providerId?: string, modelId?: string) =>
      Boolean(providerId && modelId && list.some((c) => c.providerId === providerId && c.modelId === modelId));
    const pickPreferred = (list: readonly SyncedVoiceModelCandidate[]) =>
      list.find((c) => c.authenticated) ?? list[0];

    let changed = false;
    await this.#serial(async () => {
      const current = await this.#state();
      const needsAsrReset =
        current.asrSource === "provider" &&
        !hasMatch(byPurpose.asr, current.asrProviderId, current.asrModelId);
      const needsTtsReset =
        Boolean(current.tts.providerId) &&
        !hasMatch(byPurpose.tts, current.tts.providerId, current.tts.modelId);
      const needsCallReset =
        Boolean(current.call.providerId) &&
        !hasMatch(byPurpose.live, current.call.providerId, current.call.modelId);
      const ttsUnbound = (!current.tts.providerId && !current.tts.credentialRef && !current.tts.modelId) || needsTtsReset;
      const callUnbound = (!current.call.providerId && !current.call.credentialRef && !current.call.modelId) || needsCallReset;
      const nextTtsCandidate = ttsUnbound ? pickPreferred(byPurpose.tts) : undefined;
      const nextCallCandidate = callUnbound ? pickPreferred(byPurpose.live) : undefined;

      if (!needsAsrReset && !needsTtsReset && !needsCallReset && !nextTtsCandidate && !nextCallCandidate) {
        return;
      }

      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoVoiceDoc);
        let dirty = false;

        if (doc.asrSource === "provider" && !hasMatch(byPurpose.asr, doc.asrProviderId, doc.asrModelId)) {
          delete doc.asrSource;
          delete doc.asrProviderId;
          delete doc.asrModelId;
          dirty = true;
        }

        const ttsRemoved = Boolean(doc.tts.providerId) && !hasMatch(byPurpose.tts, doc.tts.providerId, doc.tts.modelId);
        if (ttsRemoved) {
          doc.tts = { ...DEFAULT_TTS, speed: doc.tts.speed ?? "normal" };
          dirty = true;
        }
        if (!doc.tts.providerId && !doc.tts.credentialRef && !doc.tts.modelId) {
          const pick = pickPreferred(byPurpose.tts);
          if (pick) {
            const adapter = pick.protocolAdapter ?? defaultProtocolAdapterForModel("tts", pick.modelId, undefined, pick.preset);
            const provider = ttsProviderFromAdapter(adapter, pick.preset);
            const voice = pick.voices?.find((v) => v.trim()) ?? defaultVoicesForAdapter(adapter)[0] ?? "";
            doc.tts = {
              enabled: false,
              provider,
              providerId: pick.providerId,
              modelId: pick.modelId,
              voice,
              speed: doc.tts.speed ?? "normal",
            };
            dirty = true;
          }
        }

        const callRemoved = Boolean(doc.call.providerId) && !hasMatch(byPurpose.live, doc.call.providerId, doc.call.modelId);
        if (callRemoved) {
          doc.call = { ...DEFAULT_CALL };
          dirty = true;
        }
        if (!doc.call.providerId && !doc.call.credentialRef && !doc.call.modelId) {
          const pick = pickPreferred(byPurpose.live);
          if (pick) {
            const adapter = pick.protocolAdapter ?? defaultProtocolAdapterForModel("live", pick.modelId, undefined, pick.preset);
            const provider = liveProviderFromAdapter(adapter);
            const voice = pick.voices?.find((v) => v.trim()) ?? defaultVoicesForAdapter(adapter)[0] ?? "";
            doc.call = {
              enabled: false,
              provider,
              providerId: pick.providerId,
              modelId: pick.modelId,
              voice,
              status: "unverified",
            };
            dirty = true;
          }
        }

        if (dirty) {
          doc.revision++;
          changed = true;
        }
      }, BACKGROUND_CONTEXT);
    });
    if (changed) await this.#changed();
    return changed;
  }
  #prepareInBackground(): void {
    // Resource failures are retained in ASR status and retried explicitly; they don't stop other Hub capabilities.
    void this.prepareAsr().catch(() => undefined);
  }
  async #key(stored: StoredCredential, origin: string): Promise<string | undefined> {
    if (!stored.credentialRef || stored.credentialOrigin !== origin) return undefined;
    const credential = await this.#options.credentials.read(stored.credentialRef);
    return credential?.type === "api_key" && credential.env?.[ORIGIN_ENV] === origin && credential.key?.trim() ? credential.key : undefined;
  }
  async #resolveProviderModel(providerId: string | undefined, modelId: string): Promise<ResolvedVoiceModelConnection | undefined> {
    if (!providerId) return undefined;
    return this.#options.resolveModel?.(providerId, modelId);
  }
  async snapshot(): Promise<VoiceSnapshot> {
    const state = await this.#state();
    const { credentialRef: _ttsRef, credentialOrigin: _ttsOrigin, ...tts } = clone(state.tts);
    const { credentialRef: _callRef, credentialOrigin: _callOrigin, ...call } = clone(state.call);
    const ttsResolved = await this.#resolveProviderModel(state.tts.providerId, state.tts.modelId);
    const callResolved = await this.#resolveProviderModel(state.call.providerId, state.call.modelId);
    const ttsHasKey = state.tts.providerId
      ? Boolean(ttsResolved?.apiKey)
      : Boolean(state.tts.provider && await this.#key(state.tts, VOICE_TTS_ORIGINS[state.tts.provider]));
    const callHasKey = state.call.providerId
      ? Boolean(callResolved?.apiKey)
      : Boolean(state.call.provider && await this.#key(state.call, CALL_ORIGINS[state.call.provider]));

    let asrView: VoiceSnapshot["asr"];
    if (state.asrSource === "provider" && state.asrProviderId && state.asrModelId) {
      const asrResolved = await this.#resolveProviderModel(state.asrProviderId, state.asrModelId);
      const hasCredential = Boolean(asrResolved?.apiKey);
      asrView = {
        enabled: state.asrEnabled,
        source: "provider",
        providerId: state.asrProviderId,
        modelId: state.asrModelId,
        hasCredential,
        status: hasCredential ? "ready" : "unprepared",
        ...(!hasCredential && state.asrEnabled
          ? { error: asrResolved ? "请先在模型设置中为此连接配置 API Key。" : "所选识别模型已移除，请重新选择或切换回本地模型。" }
          : {}),
      };
    } else {
      const asr = this.#options.asr.status();
      if (asr.error) asr.error = safeError(asr.error);
      asrView = {
        enabled: state.asrEnabled,
        ...(state.asrSource ? { source: state.asrSource } : {}),
        ...asr,
        ...(this.#asrError && asr.status !== "preparing" && asr.status !== "ready" ? { status: "error", error: this.#asrError } : {}),
      };
    }

    return {
      revision: state.revision,
      asr: asrView,
      tts: { ...tts, hasCredential: ttsHasKey },
      call: { ...call, hasCredential: callHasKey },
    };
  }
  async configure(raw: VoiceSettingsInput): Promise<VoiceSnapshot> {
    fields(raw, ["expectedRevision", "asr", "tts", "call"]);
    if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) fail(400, "voice_revision_required", "请先读取当前语音设置版本。");
    if (raw.asr === undefined && raw.tts === undefined && raw.call === undefined) fail(400, "invalid_voice_settings", "没有需要保存的语音设置。");
    let nextAsr: { enabled: boolean; source?: VoiceAsrSource; providerId?: string; modelId?: string } | undefined;
    if (raw.asr !== undefined) {
      fields(raw.asr, ["enabled", "source", "providerId", "modelId"]);
      const enabled = bool(raw.asr.enabled);
      const source = raw.asr.source;
      if (source !== undefined && source !== "local" && source !== "provider") fail(400, "invalid_voice_settings", "请选择支持的语音识别来源。");
      if (source === "provider") {
        const providerId = token(raw.asr.providerId, "识别模型连接");
        const modelId = token(raw.asr.modelId, "识别模型");
        nextAsr = { enabled, source: "provider", providerId, modelId };
      } else if (source === "local") {
        nextAsr = { enabled, source: "local" };
      } else {
        nextAsr = { enabled };
      }
    }
    let nextTts: Omit<StoredTts, keyof StoredCredential> | undefined;
    let ttsKey: string | undefined;
    if (raw.tts !== undefined) {
      fields(raw.tts, ["enabled", "provider", "providerId", "modelId", "voice", "speed", "apiKey"]);
      if (!["slow", "normal", "fast"].includes(raw.tts.speed)) fail(400, "invalid_voice_settings", "请选择有效语速。");
      const enabled = bool(raw.tts.enabled);
      const providerId = raw.tts.providerId !== undefined && raw.tts.providerId !== "" ? token(raw.tts.providerId, "合成模型连接") : undefined;
      const rawModelId = typeof raw.tts.modelId === "string" ? raw.tts.modelId.trim() : "";
      ttsKey = keyValue(raw.tts.apiKey);
      if (!providerId && !rawModelId && !ttsKey) {
        if (enabled) fail(409, "voice_model_required", "请先在模型设置中添加并选择可用的语音合成模型。");
        nextTts = { enabled: false, modelId: "", voice: "", speed: raw.tts.speed };
      } else {
        const modelId = token(raw.tts.modelId, "合成模型");
        const voice = token(raw.tts.voice, "合成音色");
        if (providerId) {
          const resolved = await this.#resolveProviderModel(providerId, modelId);
          if (enabled && !resolved) fail(409, "voice_model_required", "所选语音合成模型不可用，请在模型设置中添加或重新选择。");
          const adapter = resolved?.protocolAdapter ?? defaultProtocolAdapterForModel("tts", modelId, undefined, resolved?.preset);
          const derivedProvider = raw.tts.provider && Object.hasOwn(VOICE_TTS_ORIGINS, raw.tts.provider) ? raw.tts.provider : ttsProviderFromAdapter(adapter, resolved?.preset);
          nextTts = { enabled, provider: derivedProvider, providerId, modelId, voice, speed: raw.tts.speed };
          ttsKey = undefined;
        } else {
          if (typeof raw.tts.provider !== "string" || !Object.hasOwn(VOICE_TTS_ORIGINS, raw.tts.provider)) fail(400, "invalid_voice_settings", "请选择支持的语音合成服务。");
          nextTts = { enabled, provider: raw.tts.provider, modelId, voice, speed: raw.tts.speed };
        }
      }
    }
    let nextCall: Omit<StoredCall, keyof StoredCredential> | undefined;
    let callKey: string | undefined;
    if (raw.call !== undefined) {
      fields(raw.call, ["enabled", "provider", "providerId", "modelId", "voice", "apiKey"]);
      const enabled = bool(raw.call.enabled);
      const providerId = raw.call.providerId !== undefined && raw.call.providerId !== "" ? token(raw.call.providerId, "通话模型连接") : undefined;
      const rawModelId = typeof raw.call.modelId === "string" ? raw.call.modelId.trim() : "";
      callKey = keyValue(raw.call.apiKey);
      if (!providerId && !rawModelId && !callKey) {
        if (enabled) fail(409, "voice_model_required", "请先在模型设置中添加并选择可用的通话模型。");
        nextCall = { enabled: false, modelId: "", voice: "", status: "unverified" };
      } else {
        const modelId = token(raw.call.modelId, "通话模型");
        const voice = token(raw.call.voice, "通话音色");
        if (providerId) {
          const resolved = await this.#resolveProviderModel(providerId, modelId);
          if (enabled && !resolved) fail(409, "voice_model_required", "所选通话模型不可用，请在模型设置中添加或重新选择。");
          const adapter = resolved?.protocolAdapter ?? defaultProtocolAdapterForModel("live", modelId, undefined, resolved?.preset);
          const derivedProvider = raw.call.provider && Object.hasOwn(CALL_ORIGINS, raw.call.provider) ? raw.call.provider : liveProviderFromAdapter(adapter);
          nextCall = { enabled, provider: derivedProvider, providerId, modelId, voice, status: "unverified" };
          callKey = undefined;
        } else {
          if (typeof raw.call.provider !== "string" || !Object.hasOwn(CALL_ORIGINS, raw.call.provider)) fail(400, "invalid_voice_settings", "请选择支持的通话服务。");
          nextCall = { enabled, provider: raw.call.provider, modelId, voice, status: "unverified" };
        }
      }
    }
    let prepare = false;
    await this.#serial(async () => {
      const before = await this.#state();
      if (before.revision !== raw.expectedRevision) fail(409, "voice_revision_conflict", "语音设置已更新，请刷新后重试。");
      if (nextAsr) {
        const effectiveSource = nextAsr.source ?? before.asrSource;
        const effectiveProviderId = nextAsr.source === "local" ? undefined : nextAsr.providerId ?? before.asrProviderId;
        const effectiveModelId = nextAsr.source === "local" ? undefined : nextAsr.modelId ?? before.asrModelId;
        if (nextAsr.enabled && effectiveSource === "provider") {
          const resolved = effectiveProviderId && effectiveModelId ? await this.#resolveProviderModel(effectiveProviderId, effectiveModelId) : undefined;
          if (!resolved) fail(409, "voice_model_required", "所选语音识别模型不可用，请在模型设置中添加或重新选择。");
          if (!resolved.apiKey) fail(409, "voice_credential_required", "请先在模型设置中为此识别模型配置 API Key。");
        }
      }
      const writes: Array<{ ref: string; key: string; origin: string }> = [];
      const replace = async <T extends { enabled: boolean; provider?: string; providerId?: string; modelId: string } & StoredCredential>(old: T, next: T, key: string | undefined, origin: string | undefined): Promise<T> => {
        if (next.providerId) {
          const resolved = await this.#resolveProviderModel(next.providerId, next.modelId);
          if (next.enabled && !resolved) fail(409, "voice_model_required", "所选语音模型不可用，请在模型设置中添加或重新选择。");
          if (next.enabled && !resolved?.apiKey) fail(409, "voice_credential_required", "请先在模型设置中为此模型连接配置有效的 API Key。");
          return { ...next };
        }
        if (!next.modelId || !origin) {
          if (next.enabled) fail(409, "voice_model_required", "请先在模型设置中添加并选择可用的语音模型。");
          return { ...next };
        }
        const reuse = !old.providerId && old.provider === next.provider && old.credentialOrigin === origin;
        const ref = key ? `voice:${randomUUID()}` : reuse ? old.credentialRef : undefined;
        if (next.enabled && !key && (!ref || !(await this.#key(old, origin)))) fail(409, "voice_credential_required", "请先填写此语音服务的 API Key。");
        if (key && ref) writes.push({ ref, key, origin });
        return { ...next, ...(ref ? { credentialRef: ref, credentialOrigin: origin } : {}) };
      };
      const tts: StoredTts = nextTts
        ? await replace<StoredTts>(before.tts, nextTts, ttsKey, nextTts.provider ? VOICE_TTS_ORIGINS[nextTts.provider] : undefined)
        : clone(before.tts);
      const call: StoredCall = nextCall
        ? await replace<StoredCall>(before.call, nextCall, callKey, nextCall.provider ? CALL_ORIGINS[nextCall.provider] : undefined)
        : clone(before.call);
      if (nextCall && !callKey && callIdentity(call) === callIdentity(before.call)) {
        call.status = before.call.status;
        if (before.call.lastCheckedAt !== undefined) call.lastCheckedAt = before.call.lastCheckedAt;
        if (before.call.error !== undefined) call.error = before.call.error;
      }
      if (writes.length) {
        await this.#options.harness.commit(async (tx) => {
          const doc = await tx.doc(MocoVoiceDoc);
          for (const write of writes) doc.cleanup[write.ref] = true;
        }, BACKGROUND_CONTEXT);
      }
      try {
        for (const write of writes) {
          try { await this.#options.credentials.modify(write.ref, async () => ({ type: "api_key", key: write.key, env: { [ORIGIN_ENV]: write.origin } })); }
          catch { fail(500, "voice_credential_write_failed", "未能保存语音 API Key，请重试。"); }
        }
        await this.#options.harness.commit(async (tx) => {
          const doc = await tx.doc(MocoVoiceDoc);
          if (doc.revision !== raw.expectedRevision) fail(409, "voice_revision_conflict", "语音设置已更新，请刷新后重试。");
          for (const [old, next] of [[doc.tts, tts], [doc.call, call]] as const) {
            if (old.credentialRef && old.credentialRef !== next.credentialRef) doc.cleanup[old.credentialRef] = true;
            if (next.credentialRef) delete doc.cleanup[next.credentialRef];
          }
          if (nextAsr) {
            doc.asrEnabled = nextAsr.enabled;
            if (nextAsr.source === "local") {
              delete doc.asrSource;
              delete doc.asrProviderId;
              delete doc.asrModelId;
            } else if (nextAsr.source === "provider") {
              doc.asrSource = "provider";
              doc.asrProviderId = nextAsr.providerId;
              doc.asrModelId = nextAsr.modelId;
            }
          }
          doc.tts = clone(tts); doc.call = clone(call); doc.revision++;
          prepare = doc.asrEnabled && doc.asrSource !== "provider" && (!before.asrEnabled || before.asrSource === "provider");
        }, BACKGROUND_CONTEXT);
      } finally { await this.#cleanup(); }
    });
    await this.#changed();
    if (prepare) this.#prepareInBackground();
    return this.snapshot();
  }
  async prepareAsr(): Promise<void> {
    if (this.#closed) fail(409, "voice_service_closed", "语音服务已关闭。");
    const state = await this.#state();
    if (!state.asrEnabled) fail(409, "voice_asr_disabled", "语音转文本已关闭。");
    if (state.asrSource === "provider") return;
    if (this.#preparation) return this.#preparation;
    this.#asrError = undefined;
    this.#preparation = (async () => {
      try { await this.#options.asr.prepare(); }
      catch (error) { this.#asrError = safeError(error); throw new VoiceError(503, "voice_asr_prepare_failed", this.#asrError); }
      finally { await this.#changed(); }
    })().finally(() => { this.#preparation = undefined; });
    return this.#preparation;
  }
  async transcribe(filePath: string, signal?: AbortSignal): Promise<string> {
    const state = await this.#state();
    if (!state.asrEnabled) fail(409, "voice_asr_disabled", "语音转文本已关闭。");
    signal?.throwIfAborted();
    if (state.asrSource === "provider" && state.asrProviderId && state.asrModelId) {
      const resolved = await this.#resolveProviderModel(state.asrProviderId, state.asrModelId);
      if (!resolved?.apiKey) fail(409, "voice_credential_required", "请先在模型设置中配置语音识别模型的 API Key。");
      try {
        const cloud = this.#options.cloudTranscribe ?? transcribeCloudAudio;
        return await cloud(filePath, { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, modelId: state.asrModelId }, { fetch: this.#options.fetch, signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        throw new VoiceError(502, "voice_asr_failed", safeError(error, [resolved.apiKey]));
      }
    }
    await this.prepareAsr();
    signal?.throwIfAborted();
    try { return await this.#options.asr.transcribe(filePath, signal); }
    catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      throw new VoiceError(502, "voice_asr_failed", safeError(error));
    }
  }
  async synthesize(text: string, signal?: AbortSignal, options: { preview?: boolean } = {}): Promise<VoiceSynthesisOutput> {
    const { tts } = await this.#state();
    if (!tts.enabled && !options.preview) fail(409, "voice_tts_disabled", "语音合成已关闭。");
    if (!tts.modelId) fail(409, "voice_model_required", "请先在模型设置中添加并选择语音合成模型。");
    if (tts.providerId) {
      const resolved = await this.#resolveProviderModel(tts.providerId, tts.modelId);
      if (!resolved) fail(409, "voice_model_required", "所选语音合成模型已不可用，请重新选择。");
      if (!resolved.apiKey) fail(409, "voice_credential_required", "请先在模型设置中配置语音合成模型的 API Key。");
      const rawAdapter = resolved.protocolAdapter ?? defaultProtocolAdapterForModel("tts", tts.modelId, undefined, resolved.preset);
      const protocolAdapter = rawAdapter === "gemini-tts" || rawAdapter === "minimax-t2a" || rawAdapter === "openai-speech" ? rawAdapter : "openai-speech";
      return synthesizeVoice({ ...tts, provider: tts.provider ?? ttsProviderFromAdapter(protocolAdapter, resolved.preset), protocolAdapter, baseUrl: resolved.baseUrl }, resolved.apiKey, text, { fetch: this.#options.fetch, signal });
    }
    if (!tts.provider) fail(409, "voice_model_required", "请先在模型设置中添加并选择语音合成模型。");
    const key = await this.#key(tts, VOICE_TTS_ORIGINS[tts.provider]);
    if (!key) fail(409, "voice_credential_required", "请先配置语音合成 API Key。");
    return synthesizeVoice({ ...tts, provider: tts.provider }, key, text, { fetch: this.#options.fetch, signal });
  }
  async liveConfig(options: { allowDisabled?: boolean } = {}): Promise<VoiceLiveConfiguration> {
    const { call } = await this.#state();
    if (!options.allowDisabled && !call.enabled) fail(409, "voice_call_disabled", "通话已关闭。");
    if (!call.modelId) fail(409, "voice_model_required", "请先在模型设置中添加并选择通话模型。");
    if (call.providerId) {
      const resolved = await this.#resolveProviderModel(call.providerId, call.modelId);
      if (!resolved) fail(409, "voice_model_required", "所选通话模型已不可用，请重新选择。");
      if (!resolved.apiKey) fail(409, "voice_credential_required", "请先在模型设置中配置通话模型的 API Key。");
      const rawAdapter = resolved.protocolAdapter ?? defaultProtocolAdapterForModel("live", call.modelId, undefined, resolved.preset);
      const provider = liveProviderFromAdapter(rawAdapter);
      const defaultOrigin = CALL_ORIGINS[provider];
      const customBase = new URL(resolved.baseUrl).origin !== defaultOrigin ? resolved.baseUrl : undefined;
      return { provider, ...(customBase ? { baseUrl: customBase } : {}), modelId: call.modelId, voice: call.voice, apiKey: resolved.apiKey };
    }
    if (!call.provider) fail(409, "voice_model_required", "请先在模型设置中添加并选择通话模型。");
    const key = await this.#key(call, CALL_ORIGINS[call.provider]);
    if (!key) fail(409, "voice_credential_required", "请先配置通话 API Key。");
    return { provider: call.provider, modelId: call.modelId, voice: call.voice, apiKey: key };
  }
  async probeCall(signal?: AbortSignal): Promise<VoiceSnapshot> {
    const before = (await this.#state()).call;
    const config = await this.liveConfig({ allowDisabled: true });
    const id = ++this.#probeId;
    let error: string | undefined;
    try {
      const probe = this.#options.probe ?? (await import("./voice-live-adapters.js")).probeVoiceLive;
      await probe(config, { signal });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      error = safeError(cause, [config.apiKey]);
    }
    let changed = false;
    await this.#serial(async () => {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoVoiceDoc);
        if (id !== this.#probeId || callIdentity(doc.call) !== callIdentity(before)) return;
        doc.call.status = error ? "error" : "ready";
        doc.call.lastCheckedAt = this.#now();
        if (error) doc.call.error = error; else delete doc.call.error;
        changed = true;
      }, BACKGROUND_CONTEXT);
    });
    if (changed) await this.#changed();
    return this.snapshot();
  }
  close(): void { this.#closed = true; this.#options.asr.close(); }
}
