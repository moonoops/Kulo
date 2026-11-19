import { describe, expect, it } from "vitest";
import type { VoiceSnapshot } from "@kulo/protocol";
import {
  acceptVoiceSettings,
  createVoiceSettingsEditor,
  discardVoiceSettingsScope,
  selectCallModelOption,
  selectTtsModelOption,
  voiceAsrSourceInput,
  voiceFormDirty,
  voiceSettingsInput,
  voiceToggleInput,
} from "./voice-settings-model";

const snapshot: VoiceSnapshot = {
  revision: 4,
  asr: { enabled: false, status: "ready" },
  tts: { enabled: false, provider: "minimax-cn", providerId: "api-minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal", hasCredential: true },
  call: { enabled: false, provider: "vertex", providerId: "api-vertex", modelId: "gemini-3.8-live", voice: "Aoede", hasCredential: true, status: "ready" },
};

function dirtyEditor() {
  const editor = createVoiceSettingsEditor(snapshot);
  editor.draft.tts = selectTtsModelOption(editor.draft.tts, {
    providerId: "api-google",
    modelId: "gemini-3.8-flash-tts",
    protocolAdapter: "gemini-tts",
    voices: ["Kore", "Puck"],
  });
  editor.draft.tts.voice = "Puck";
  editor.draft.call = selectCallModelOption(editor.draft.call, {
    providerId: "api-openai",
    modelId: "gpt-live-1",
    protocolAdapter: "openai-realtime",
    voices: ["marin", "quartz"],
  });
  editor.draft.call.voice = "quartz";
  return editor;
}

describe("voice settings save policy", () => {
  it("submits immediate switches with only their saved scope and no secret fields", () => {
    const editor = dirtyEditor();
    expect(voiceToggleInput(editor.base, "asr", true)).toEqual({ expectedRevision: 4, asr: { enabled: true } });
    expect(voiceToggleInput(editor.base, "tts", true)).toEqual({
      expectedRevision: 4,
      tts: { enabled: true, provider: "minimax-cn", providerId: "api-minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal" },
    });
    expect(voiceToggleInput(editor.base, "call", true)).toEqual({
      expectedRevision: 4,
      call: { enabled: true, provider: "vertex", providerId: "api-vertex", modelId: "gemini-3.8-live", voice: "Aoede" },
    });
    for (const scope of ["asr", "tts", "call"] as const) expect(JSON.stringify(voiceToggleInput(editor.base, scope, true))).not.toMatch(/apiKey|hasCredential|status/);
  });

  it("saves one complete model selection draft without submitting the other scope or ASR", () => {
    const { draft } = dirtyEditor();
    expect(voiceSettingsInput(draft, snapshot, "tts")).toEqual({
      expectedRevision: 4,
      tts: { enabled: false, provider: "gemini", providerId: "api-google", modelId: "gemini-3.8-flash-tts", voice: "Puck", speed: "normal" },
    });
    expect(voiceSettingsInput(draft, snapshot, "call")).toEqual({
      expectedRevision: 4,
      call: { enabled: false, provider: "openai", providerId: "api-openai", modelId: "gpt-live-1", voice: "quartz" },
    });
  });

  it("builds local and provider-referenced ASR inputs cleanly", () => {
    expect(voiceAsrSourceInput(snapshot)).toEqual({
      expectedRevision: 4,
      asr: { enabled: false, source: "local", providerId: "", modelId: "" },
    });
    expect(voiceAsrSourceInput(snapshot, { providerId: "api-openai", modelId: "gpt-4o-transcribe" })).toEqual({
      expectedRevision: 4,
      asr: { enabled: false, source: "provider", providerId: "api-openai", modelId: "gpt-4o-transcribe" },
    });
  });

  it("keeps both connection drafts after its own immediate switch is acknowledged", () => {
    const editor = dirtyEditor();
    const next = { ...snapshot, revision: 5, tts: { ...snapshot.tts, enabled: true } };
    const rebased = acceptVoiceSettings(editor, next, { expectedRevision: 4 });
    expect(rebased.base).toBe(next);
    expect(rebased.draft.tts).toEqual(editor.draft.tts);
    expect(rebased.draft.call).toEqual(editor.draft.call);
    expect(rebased.conflicts).toEqual({ tts: false, call: false });
    expect(voiceFormDirty(rebased.draft, rebased.base, "tts")).toBe(true);
    expect(voiceFormDirty(rebased.draft, rebased.base, "call")).toBe(true);
    expect(voiceSettingsInput(rebased.draft, rebased.base, "tts").tts?.enabled).toBe(true);
  });

  it("clears only the successfully saved manual scope and rebases the other draft", () => {
    const editor = dirtyEditor();
    const next: VoiceSnapshot = {
      ...snapshot,
      revision: 5,
      tts: { enabled: false, provider: "gemini", providerId: "api-google", modelId: editor.draft.tts.modelId, voice: "Puck", speed: "normal", hasCredential: true },
    };
    const rebased = acceptVoiceSettings(editor, next, { expectedRevision: 4, savedScope: "tts" });
    expect(voiceFormDirty(rebased.draft, next, "tts")).toBe(false);
    expect(rebased.draft.call).toEqual(editor.draft.call);
    expect(voiceFormDirty(rebased.draft, next, "call")).toBe(true);
    expect(rebased.conflicts).toEqual({ tts: false, call: false });
    expect(voiceSettingsInput(rebased.draft, next, "call").expectedRevision).toBe(5);
  });

  it("preserves drafts and marks conflicts on unknown revisions", () => {
    const editor = dirtyEditor();
    const next = { ...snapshot, revision: 5 };
    const rebased = acceptVoiceSettings(editor, next);
    expect(rebased.draft).toEqual(editor.draft);
    expect(rebased.conflicts).toEqual({ tts: true, call: true });
    const discarded = discardVoiceSettingsScope(rebased, next, "tts");
    expect(discarded.conflicts).toEqual({ tts: false, call: true });
    expect(voiceFormDirty(discarded.draft, next, "tts")).toBe(false);
    expect(discarded.draft.call).toEqual(editor.draft.call);
  });

  it("accepts status-only refreshes without dirtying or conflicting drafts", () => {
    const editor = dirtyEditor();
    const next = { ...snapshot, call: { ...snapshot.call, status: "error" as const, error: "Connection failed" } };
    const rebased = acceptVoiceSettings(editor, next);
    expect(rebased.base.call.status).toBe("error");
    expect(rebased.draft).toEqual(editor.draft);
    expect(rebased.conflicts).toEqual({ tts: false, call: false });
    const clean = createVoiceSettingsEditor(next);
    const switched = { ...next, asr: { ...next.asr, enabled: true }, tts: { ...next.tts, enabled: true }, call: { ...next.call, enabled: true } };
    expect(voiceFormDirty(clean.draft, switched, "tts")).toBe(false);
    expect(voiceFormDirty(clean.draft, switched, "call")).toBe(false);
  });

  it("ignores stale snapshots and cannot reload an older configuration", () => {
    const latest = { ...snapshot, revision: 6, tts: { ...snapshot.tts, voice: "new-saved-voice" } };
    const editor = createVoiceSettingsEditor(latest);
    editor.draft.tts.voice = "my-draft";
    expect(acceptVoiceSettings(editor, snapshot)).toBe(editor);
    expect(discardVoiceSettingsScope(editor, snapshot, "tts").draft.tts.voice).toBe("new-saved-voice");
  });
});
