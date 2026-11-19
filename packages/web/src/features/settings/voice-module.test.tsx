import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceSnapshot } from "@moco/protocol";
import {
  selectCallModelOption,
  selectTtsModelOption,
  VoiceModule,
  VoiceSettingsFields,
  voiceSettingsDraft,
  voiceSettingsInput,
  voiceTtsStatusLabel,
} from "./voice-module";
import { voiceTtsFingerprint } from "../voice/voice-context";
import * as voiceContext from "../voice/voice-context";
import { MocoComposer } from "../../moco-composer";
import { VoiceMessage } from "../chat/voice-message";
import type { ConfiguredPurposeModelOption } from "./settings-helpers";

const snapshot: VoiceSnapshot = {
  revision: 4,
  asr: { enabled: true, status: "ready" },
  tts: { enabled: true, provider: "minimax-cn", providerId: "api-minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal", hasCredential: true },
  call: { enabled: true, provider: "vertex", providerId: "api-vertex", modelId: "gemini-3.8-live", voice: "Aoede", hasCredential: true, status: "unverified" },
};

const sampleTtsModels: ConfiguredPurposeModelOption[] = [
  {
    selectionKey: "api-minimax-cn::speech-2.8-turbo",
    providerId: "api-minimax-cn",
    providerName: "MiniMax · 国内",
    modelId: "speech-2.8-turbo",
    modelName: "speech-2.8-turbo",
    label: "speech-2.8-turbo · MiniMax · 国内",
    api: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    preset: "minimax-cn",
    protocolAdapter: "minimax-t2a",
    voices: ["male-qn-qingse", "female-shaonv"],
    authenticated: true,
  },
  {
    selectionKey: "api-openai::gpt-4o-mini-tts",
    providerId: "api-openai",
    providerName: "OpenAI / Codex",
    modelId: "gpt-4o-mini-tts",
    modelName: "gpt-4o-mini-tts",
    label: "gpt-4o-mini-tts · OpenAI / Codex",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    preset: "openai",
    protocolAdapter: "openai-speech",
    voices: ["alloy", "nova"],
    authenticated: true,
  },
];

const sampleLiveModels: ConfiguredPurposeModelOption[] = [
  {
    selectionKey: "api-vertex::gemini-3.8-live",
    providerId: "api-vertex",
    providerName: "Google Vertex AI",
    modelId: "gemini-3.8-live",
    modelName: "gemini-3.8-live",
    label: "gemini-3.8-live · Google Vertex AI",
    api: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    preset: "google-vertex",
    protocolAdapter: "vertex-live",
    voices: ["Aoede", "Kore"],
    authenticated: true,
  },
];

afterEach(() => vi.restoreAllMocks());

describe("voice configuration", () => {
  it("keeps passive state beside each title and lightweight commands before the switch", () => {
    const next = { ...snapshot, asr: { ...snapshot.asr, status: "unprepared" as const } };
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue({ snapshot: next, clientId: "voice-settings", call: { active: false } } as unknown as voiceContext.VoiceWorkspace);
    const html = renderToStaticMarkup(<VoiceModule connected />);
    const statuses = [...html.matchAll(/<div class="moco-settings-section-title-group">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
    expect(statuses).toHaveLength(3);
    for (const status of statuses) {
      expect(status).toContain("<h2");
      expect(status).toContain("chip");
      expect(status).not.toContain("<button");
    }
    expect(statuses.join("")).toContain("已配置");
    expect(statuses.join("")).toContain("待验证");
    expect(statuses.join("")).not.toContain("通话可用");
    const actions = [...html.matchAll(/<div class="moco-voice-settings-header-actions">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
    expect(actions).toHaveLength(3);
    expect(actions.join("")).toContain("准备本地模型");
    expect(actions.join("")).toContain("试听音色");
    expect(actions.join("")).toContain("测试通话");
    for (const action of actions) {
      expect(action).not.toContain("chip");
      expect(action).toContain("button--ghost");
      expect(action).toContain('role="switch"');
      expect(action.indexOf("<button")).toBeLessThan(action.indexOf('role="switch"'));
    }
  });

  it("uses only the compact header for ready local speech recognition when no cloud ASR models are configured", () => {
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue({ snapshot, clientId: "voice-settings", call: { active: false } } as unknown as voiceContext.VoiceWorkspace);
    const html = renderToStaticMarkup(<VoiceModule connected />);
    const asr = html.match(/<section\b[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
    expect(asr).toContain("语音转文本");
    expect(asr).toContain("本地可用");
    expect(asr).not.toContain("<button");
  });

  it("renders model-referenced selectors with zero password or provider fields", () => {
    const html = renderToStaticMarkup(
      <VoiceSettingsFields
        snapshot={snapshot}
        draft={voiceSettingsDraft(snapshot)}
        ttsModels={sampleTtsModels}
        liveModels={sampleLiveModels}
        onChange={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    expect(html).toContain('class="moco-form-grid"');
    expect(html.match(/class="[^"]*\bmoco-form-field\b/g)).toHaveLength(5);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("TTS API Key");
    expect(html).not.toContain("通话 API Key");
    expect(html).not.toContain("Google 渠道");
    expect(html.indexOf("TTS 模型")).toBeLessThan(html.indexOf("合成音色"));
    expect(html.indexOf("合成音色")).toBeLessThan(html.indexOf("语速"));
    expect(html.indexOf("Live 模型")).toBeLessThan(html.indexOf("通话音色"));
    expect(html).toContain("speech-2.8-turbo · MiniMax · 国内");
    expect(html).toContain("gemini-3.8-live · Google Vertex AI");
  });

  it("reports the saved TTS connection and runtime state", () => {
    expect(voiceTtsStatusLabel(snapshot)).toBe("已配置");
    expect(voiceTtsStatusLabel({ ...snapshot, tts: { ...snapshot.tts, enabled: false } })).toBe("已关闭");
    const unconnected = { ...snapshot, tts: { ...snapshot.tts, hasCredential: false } };
    expect(voiceTtsStatusLabel(unconnected)).toBe("待连接");
  });

  it("submits only supported settings fields without secrets", () => {
    const draft = voiceSettingsDraft(snapshot);
    const input = voiceSettingsInput(draft, snapshot, "tts");
    expect(input).toEqual({
      expectedRevision: 4,
      tts: { enabled: true, provider: "minimax-cn", providerId: "api-minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal" },
    });
    expect(JSON.stringify(input)).not.toMatch(/hasCredential|apiKey|projectId|location|baseUrl|status/);
  });

  it("updates adapter provider and default voice when switching configured models", () => {
    const draft = voiceSettingsDraft(snapshot);
    const nextTts = selectTtsModelOption(draft.tts, sampleTtsModels[1]!);
    expect(nextTts).toMatchObject({ provider: "openai", providerId: "api-openai", modelId: "gpt-4o-mini-tts", voice: "alloy" });
    const nextCall = selectCallModelOption(draft.call, {
      providerId: "api-openai",
      modelId: "gpt-4o-realtime-preview",
      protocolAdapter: "openai-realtime",
      voices: ["marin", "quartz"],
    });
    expect(nextCall).toMatchObject({ provider: "openai", providerId: "api-openai", modelId: "gpt-4o-realtime-preview", voice: "marin" });
  });

  it("locks voice fields during local operations without changing their enabled appearance", () => {
    const html = renderToStaticMarkup(<VoiceSettingsFields snapshot={snapshot} draft={voiceSettingsDraft(snapshot)} ttsModels={sampleTtsModels} liveModels={sampleLiveModels} onChange={vi.fn()} onToggle={vi.fn()} busy />);
    expect(html).toContain('inert=""');
    const actions = [...html.matchAll(/<div class="moco-voice-settings-header-actions">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action).toContain('aria-readonly="true"');
      expect(action).not.toContain('inert=""');
    }
  });

  it("keeps each manual save beside all fields in its configuration form", () => {
    const html = renderToStaticMarkup(
      <VoiceSettingsFields
        snapshot={snapshot}
        draft={voiceSettingsDraft(snapshot)}
        ttsModels={sampleTtsModels}
        liveModels={sampleLiveModels}
        onChange={vi.fn()}
        onToggle={vi.fn()}
        ttsFooter={<span>TTS_SAVE</span>}
        callFooter={<span>CALL_SAVE</span>}
      />,
    );
    const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((match) => match[1]);
    expect(forms).toHaveLength(2);
    expect(forms[0]).toContain("TTS 模型");
    expect(forms[0]).toContain("TTS_SAVE");
    expect(forms[0]).not.toContain("CALL_SAVE");
    expect(forms[1]).toContain("Live 模型");
    expect(forms[1]).toContain("CALL_SAVE");
    expect(forms[1]).not.toContain("TTS_SAVE");
  });

  it("invalidates cached narration for every synthesis setting and credential revision", () => {
    const before = voiceTtsFingerprint(snapshot);
    for (const change of [{ providerId: "api-other" }, { provider: "gemini" as const }, { modelId: "different" }, { voice: "other" }, { speed: "fast" as const }]) {
      expect(voiceTtsFingerprint({ ...snapshot, tts: { ...snapshot.tts, ...change } })).not.toBe(before);
    }
    expect(voiceTtsFingerprint({ ...snapshot, revision: 5 })).not.toBe(before);
  });

  it("renders unselected placeholders and never fabricates phantom defaults when no TTS or Live model is configured", () => {
    const emptySnapshot: VoiceSnapshot = {
      revision: 0,
      asr: { enabled: true, status: "ready" },
      tts: { enabled: false, modelId: "", voice: "", speed: "normal", hasCredential: false },
      call: { enabled: false, modelId: "", voice: "", hasCredential: false, status: "unverified" },
    };
    const html = renderToStaticMarkup(
      <VoiceSettingsFields
        snapshot={emptySnapshot}
        draft={voiceSettingsDraft(emptySnapshot)}
        ttsModels={[]}
        liveModels={[]}
        onChange={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    expect(html).toContain("未选择");
    for (const phantom of ["speech-2.8-turbo", "male-qn-qingse", "gpt-live-1", "marin"]) {
      expect(html).not.toContain(phantom);
    }
    // Even when liveModels exist in catalog, an empty draft must not visually fake-select the first option.
    const withCatalog = renderToStaticMarkup(
      <VoiceSettingsFields
        snapshot={emptySnapshot}
        draft={voiceSettingsDraft(emptySnapshot)}
        ttsModels={sampleTtsModels}
        liveModels={sampleLiveModels}
        onChange={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    const selectValues = [...withCatalog.matchAll(/<span\b[^>]*data-slot="select-value"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
    expect(selectValues).toContain("未选择");
    expect(selectValues.join(" ")).not.toContain("speech-2.8-turbo");
    expect(selectValues.join(" ")).not.toContain("gemini-3.8-live");
  });
});

describe("chat voice controls", () => {
  const renderComposer = () => renderToStaticMarkup(<MocoComposer draftText="" onDraftTextChange={vi.fn()} attachments={[]} onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()} onTranscribeVoice={vi.fn()} connected placeholder="输入消息" conversationKey="root" />);
  const workspace = (active = false) => ({ snapshot, connected: true, clientId: "voice-test", recordingActive: false, setRecordingActive: vi.fn(), call: { active, start: vi.fn(), expand: vi.fn() } }) as unknown as voiceContext.VoiceWorkspace;

  it("keeps calling in the profile card and disables recording during a call", () => {
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(workspace(true));
    const html = renderComposer();
    expect(html).not.toContain('aria-label="开始通话"');
    expect(html).not.toContain('aria-label="返回通话"');
    const record = html.match(/<button\b[^>]*aria-label="语音输入"[^>]*>/)?.[0];
    expect(record).toMatch(/disabled|aria-disabled="true"/);
  });

  it("preserves voice messages when live calling is disabled", () => {
    const context = workspace(); context.snapshot = { ...snapshot, call: { ...snapshot.call, enabled: false } };
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(context);
    const html = renderComposer();
    expect(html).not.toContain('aria-label="开始通话"');
    expect(html).toContain('aria-label="语音输入"');
  });

  it("never expands a background transcript without an explicit message action", () => {
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(workspace());
    const html = renderToStaticMarkup(<VoiceMessage conversationKey="root" asset={{ id: "voice-one", name: "语音.webm", kind: "audio", presentation: "voice", mimeType: "audio/webm", size: 100, url: "/api/uploads/voice-one", transcript: { text: "后台识别内容不能自动显示", status: "ready" } }} />);
    expect(html).not.toContain("后台识别内容不能自动显示");
    expect(html).not.toContain("已转文字");
    expect(html).not.toContain('aria-label="文字稿"');
  });
});
