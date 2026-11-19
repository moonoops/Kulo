import type {
  ModelProtocolAdapter,
  VoiceLiveProvider,
  VoiceSettingsInput,
  VoiceSnapshot,
  VoiceSpeed,
  VoiceTtsProvider,
} from "@moco/protocol";
import type { ConfiguredPurposeModelOption } from "./settings-helpers";

export type VoiceFormScope = "tts" | "call";
export type VoiceToggleScope = "asr" | VoiceFormScope;

export interface TtsDraft {
  provider?: VoiceTtsProvider;
  providerId?: string;
  modelId: string;
  voice: string;
  speed: VoiceSpeed;
}

export interface CallDraft {
  provider?: VoiceLiveProvider;
  providerId?: string;
  modelId: string;
  voice: string;
}

export interface VoiceSettingsDraft {
  tts: TtsDraft;
  call: CallDraft;
}

export interface VoiceSettingsEditorState {
  base: VoiceSnapshot;
  draft: VoiceSettingsDraft;
  conflicts: Record<VoiceFormScope, boolean>;
}

export function ttsProviderForAdapter(adapter?: ModelProtocolAdapter, preset?: string): VoiceTtsProvider {
  if (adapter === "gemini-tts") return "gemini";
  if (adapter === "minimax-t2a") return preset === "minimax" ? "minimax-global" : "minimax-cn";
  return "openai";
}

export function liveProviderForAdapter(adapter?: ModelProtocolAdapter): VoiceLiveProvider {
  if (adapter === "gemini-live") return "gemini";
  if (adapter === "vertex-live") return "vertex";
  return "openai";
}

export function voiceSettingsDraft(snapshot: VoiceSnapshot): VoiceSettingsDraft {
  return {
    tts: {
      ...(snapshot.tts.provider ? { provider: snapshot.tts.provider } : {}),
      ...(snapshot.tts.providerId ? { providerId: snapshot.tts.providerId } : {}),
      modelId: snapshot.tts.modelId,
      voice: snapshot.tts.voice,
      speed: snapshot.tts.speed,
    },
    call: {
      ...(snapshot.call.provider ? { provider: snapshot.call.provider } : {}),
      ...(snapshot.call.providerId ? { providerId: snapshot.call.providerId } : {}),
      modelId: snapshot.call.modelId,
      voice: snapshot.call.voice,
    },
  };
}

export function voiceSettingsInput(draft: VoiceSettingsDraft, snapshot: VoiceSnapshot, scope: VoiceFormScope): VoiceSettingsInput {
  if (scope === "tts") {
    const providerIdPatch = draft.tts.providerId !== undefined
      ? { providerId: draft.tts.providerId }
      : snapshot.tts.providerId
        ? { providerId: "" }
        : {};
    return {
      expectedRevision: snapshot.revision,
      tts: {
        enabled: snapshot.tts.enabled,
        ...(draft.tts.provider ? { provider: draft.tts.provider } : {}),
        ...providerIdPatch,
        modelId: draft.tts.modelId.trim(),
        voice: draft.tts.voice.trim(),
        speed: draft.tts.speed,
      },
    };
  }
  const providerIdPatch = draft.call.providerId !== undefined
    ? { providerId: draft.call.providerId }
    : snapshot.call.providerId
      ? { providerId: "" }
      : {};
  return {
    expectedRevision: snapshot.revision,
    call: {
      enabled: snapshot.call.enabled,
      ...(draft.call.provider ? { provider: draft.call.provider } : {}),
      ...providerIdPatch,
      modelId: draft.call.modelId.trim(),
      voice: draft.call.voice.trim(),
    },
  };
}

/** Running-state toggles use saved connection fields, never an unsaved draft. */
export function voiceToggleInput(snapshot: VoiceSnapshot, scope: VoiceToggleScope, enabled: boolean): VoiceSettingsInput {
  if (scope === "asr") {
    return {
      expectedRevision: snapshot.revision,
      asr: {
        enabled,
        ...(snapshot.asr.source ? { source: snapshot.asr.source } : {}),
        ...(snapshot.asr.providerId ? { providerId: snapshot.asr.providerId } : {}),
        ...(snapshot.asr.modelId ? { modelId: snapshot.asr.modelId } : {}),
      },
    };
  }
  if (scope === "tts") {
    return {
      expectedRevision: snapshot.revision,
      tts: {
        enabled,
        ...(snapshot.tts.provider ? { provider: snapshot.tts.provider } : {}),
        ...(snapshot.tts.providerId ? { providerId: snapshot.tts.providerId } : {}),
        modelId: snapshot.tts.modelId,
        voice: snapshot.tts.voice,
        speed: snapshot.tts.speed,
      },
    };
  }
  return {
    expectedRevision: snapshot.revision,
    call: {
      enabled,
      ...(snapshot.call.provider ? { provider: snapshot.call.provider } : {}),
      ...(snapshot.call.providerId ? { providerId: snapshot.call.providerId } : {}),
      modelId: snapshot.call.modelId,
      voice: snapshot.call.voice,
    },
  };
}

export function voiceAsrSourceInput(
  snapshot: VoiceSnapshot,
  option?: Pick<ConfiguredPurposeModelOption, "providerId" | "modelId">,
): VoiceSettingsInput {
  if (!option) {
    return {
      expectedRevision: snapshot.revision,
      asr: {
        enabled: snapshot.asr.enabled,
        source: "local",
        providerId: "",
        modelId: "",
      },
    };
  }
  return {
    expectedRevision: snapshot.revision,
    asr: {
      enabled: snapshot.asr.enabled,
      source: "provider",
      providerId: option.providerId,
      modelId: option.modelId,
    },
  };
}

export function voiceFormDirty(draft: VoiceSettingsDraft, snapshot: VoiceSnapshot, scope: VoiceFormScope): boolean {
  const draftConfig = draft[scope];
  const saved = snapshot[scope];
  return (
    (draftConfig.providerId ?? "") !== (saved.providerId ?? "") ||
    draftConfig.provider !== saved.provider ||
    draftConfig.modelId !== saved.modelId ||
    draftConfig.voice !== saved.voice ||
    (scope === "tts" && draft.tts.speed !== snapshot.tts.speed)
  );
}

export function createVoiceSettingsEditor(snapshot: VoiceSnapshot): VoiceSettingsEditorState {
  return { base: snapshot, draft: voiceSettingsDraft(snapshot), conflicts: { tts: false, call: false } };
}

/** Rebase acknowledged switches without committing or discarding either manual connection draft. */
export function acceptVoiceSettings(
  editor: VoiceSettingsEditorState,
  next: VoiceSnapshot,
  ownUpdate?: { expectedRevision: number; savedScope?: VoiceFormScope },
): VoiceSettingsEditorState {
  if (next.revision < editor.base.revision) return editor;
  const fresh = voiceSettingsDraft(next);
  const ttsDirty = voiceFormDirty(editor.draft, editor.base, "tts");
  const callDirty = voiceFormDirty(editor.draft, editor.base, "call");
  const external = next.revision !== editor.base.revision && ownUpdate?.expectedRevision !== editor.base.revision;
  return {
    base: next,
    draft: {
      ...fresh,
      tts: ttsDirty && ownUpdate?.savedScope !== "tts" ? editor.draft.tts : fresh.tts,
      call: callDirty && ownUpdate?.savedScope !== "call" ? editor.draft.call : fresh.call,
    },
    conflicts: {
      tts: ownUpdate?.savedScope === "tts" ? false : editor.conflicts.tts || (external && ttsDirty),
      call: ownUpdate?.savedScope === "call" ? false : editor.conflicts.call || (external && callDirty),
    },
  };
}

export function discardVoiceSettingsScope(editor: VoiceSettingsEditorState, snapshot: VoiceSnapshot, scope: VoiceFormScope): VoiceSettingsEditorState {
  const next = acceptVoiceSettings(editor, snapshot);
  return { ...next, draft: { ...next.draft, [scope]: voiceSettingsDraft(next.base)[scope] }, conflicts: { ...next.conflicts, [scope]: false } };
}

export function selectTtsModelOption(
  draft: TtsDraft,
  option: Pick<ConfiguredPurposeModelOption, "providerId" | "modelId" | "protocolAdapter" | "preset" | "voices">,
): TtsDraft {
  const provider = ttsProviderForAdapter(option.protocolAdapter, option.preset);
  const voice = option.voices.includes(draft.voice) ? draft.voice : (option.voices[0] ?? draft.voice);
  return {
    ...draft,
    provider,
    providerId: option.providerId,
    modelId: option.modelId,
    voice,
  };
}

export function selectCallModelOption(
  draft: CallDraft,
  option: Pick<ConfiguredPurposeModelOption, "providerId" | "modelId" | "protocolAdapter" | "voices">,
): CallDraft {
  const provider = liveProviderForAdapter(option.protocolAdapter);
  const voice = option.voices.includes(draft.voice) ? draft.voice : (option.voices[0] ?? draft.voice);
  return {
    ...draft,
    provider,
    providerId: option.providerId,
    modelId: option.modelId,
    voice,
  };
}
