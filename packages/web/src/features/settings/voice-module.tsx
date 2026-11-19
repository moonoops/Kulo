import { useI18n, translate } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Chip, Label, ListBox, Select, Spinner, Switch } from "@heroui/react";
import {
  defaultVoicesForAdapter,
  redactSensitiveText,
  type KuloSettingsView,
  type VoiceSnapshot,
  type VoiceSpeed,
} from "@kulo/protocol";
import { SettingsSaveBar, SettingsSection } from "./settings-layout";
import { useVoiceWorkspace } from "../voice/voice-context";
import { voiceApi } from "../voice/voice-api";
import { VoiceIcon } from "../voice/voice-icons";
import { pauseOtherMedia } from "../chat/media-message";
import { KuloApiError } from "../../kulo-api";
import { useProviderCatalog } from "./use-provider-catalog";
import {
  buildConfiguredModelsForPurpose,
  type ConfiguredPurposeModelOption,
} from "./settings-helpers";
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
  type CallDraft,
  type TtsDraft,
  type VoiceFormScope,
  type VoiceSettingsDraft,
  type VoiceSettingsEditorState,
  type VoiceToggleScope,
} from "./voice-settings-model";
import { useSettingsPending } from "./settings-save-activity";
import "../voice/voice.css";

export {
  selectCallModelOption,
  selectTtsModelOption,
  voiceAsrSourceInput,
  voiceSettingsDraft,
  voiceSettingsInput,
} from "./voice-settings-model";
export type { VoiceSettingsDraft } from "./voice-settings-model";

const LEGACY_KEY = "__legacy__";
const LOCAL_ASR_KEY = "__local__";

function fallbackTtsVoices(draft: TtsDraft): string[] {
  if (draft.provider === "gemini") return defaultVoicesForAdapter("gemini-tts");
  if (draft.provider === "openai") return defaultVoicesForAdapter("openai-speech");
  if (draft.provider === "minimax-cn" || draft.provider === "minimax-global") return defaultVoicesForAdapter("minimax-t2a");
  return [];
}

function fallbackCallVoices(draft: CallDraft): string[] {
  if (draft.provider === "openai") return defaultVoicesForAdapter("openai-realtime");
  if (draft.provider === "gemini" || draft.provider === "vertex") return defaultVoicesForAdapter("gemini-live");
  return [];
}

function VoiceSelect({
  label,
  value,
  choices,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string | null;
  choices: Record<string, string>;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Select
      variant="secondary"
      className="kulo-form-field"
      value={value}
      placeholder={placeholder}
      fullWidth
      isDisabled={disabled}
      onChange={(next) => {
        if (next !== null && Object.hasOwn(choices, String(next))) onChange(String(next));
      }}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {Object.entries(choices).map(([id, text]) => (
            <ListBox.Item key={id} id={id} textValue={text}>
              {text}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function EnableSwitch({
  label,
  enabled,
  onChange,
  disabled,
  busy,
  pending,
}: {
  label: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  pending?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {pending && <Spinner size="sm" aria-label={translate("正在保存", "Saving")} />}
      <Switch isSelected={enabled} onChange={onChange} isReadOnly={busy} isDisabled={disabled}>
        <Switch.Content>
          <Label className="sr-only">{label}</Label>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}

export function voiceTtsStatusLabel(snapshot: VoiceSnapshot): string {
  if (!snapshot.tts.enabled) return translate("已关闭", "Off");
  return snapshot.tts.hasCredential ? translate("已配置", "Configured") : translate("待连接", "Not connected");
}

interface VoiceSettingsFieldsProps {
  snapshot: VoiceSnapshot;
  draft: VoiceSettingsDraft;
  ttsModels?: readonly ConfiguredPurposeModelOption[];
  liveModels?: readonly ConfiguredPurposeModelOption[];
  onChange: (next: VoiceSettingsDraft) => void;
  onToggle: (scope: VoiceFormScope, enabled: boolean) => void;
  onSubmit?: (scope: VoiceFormScope) => void;
  onOpenModels?: () => void;
  disabled?: boolean;
  busy?: boolean;
  switching?: VoiceFormScope;
  togglesDisabled?: boolean;
  ttsStatus?: ReactNode;
  callStatus?: ReactNode;
  ttsAction?: ReactNode;
  callAction?: ReactNode;
  ttsFeedback?: ReactNode;
  callFeedback?: ReactNode;
  ttsFooter?: ReactNode;
  callFooter?: ReactNode;
}

export function VoiceSettingsFields({
  snapshot,
  draft,
  ttsModels = [],
  liveModels = [],
  onChange,
  onToggle,
  onSubmit,
  onOpenModels,
  disabled = false,
  busy = false,
  switching,
  togglesDisabled = disabled,
  ttsStatus,
  callStatus,
  ttsAction,
  callAction,
  ttsFeedback,
  callFeedback,
  ttsFooter,
  callFooter,
}: VoiceSettingsFieldsProps) {
  const { t } = useI18n();
  const SPEED_LABELS: Record<VoiceSpeed, string> = {
    slow: t("慢", "Slow"),
    normal: t("自然", "Natural"),
    fast: t("快", "Fast"),
  };

  const selectedTtsKey = draft.tts.providerId && draft.tts.modelId
    ? `${draft.tts.providerId}::${draft.tts.modelId}`
    : draft.tts.modelId
      ? LEGACY_KEY
      : null;
  const matchedTtsOption = selectedTtsKey ? ttsModels.find((opt) => opt.selectionKey === selectedTtsKey) : undefined;
  const ttsChoices: Record<string, string> = {};
  for (const opt of ttsModels) ttsChoices[opt.selectionKey] = opt.label;
  if (!matchedTtsOption && draft.tts.modelId && (draft.tts.providerId || snapshot.tts.hasCredential)) {
    const legacyKey = draft.tts.providerId ? `${draft.tts.providerId}::${draft.tts.modelId}` : LEGACY_KEY;
    ttsChoices[legacyKey] = draft.tts.providerId ? `${draft.tts.modelId} · ${draft.tts.providerId}` : draft.tts.modelId;
  }
  const activeTtsKey = selectedTtsKey && Object.hasOwn(ttsChoices, selectedTtsKey) ? selectedTtsKey : null;
  const hasSelectedTtsModel = activeTtsKey !== null;
  const ttsVoiceList = matchedTtsOption?.voices.length
    ? matchedTtsOption.voices
    : hasSelectedTtsModel
      ? fallbackTtsVoices(draft.tts)
      : [];
  const ttsVoiceChoices = Object.fromEntries(
    [...new Set([...ttsVoiceList, ...(hasSelectedTtsModel ? [draft.tts.voice] : [])])].filter(Boolean).map((v) => [v, v]),
  );
  const activeTtsVoice = hasSelectedTtsModel && draft.tts.voice && Object.hasOwn(ttsVoiceChoices, draft.tts.voice) ? draft.tts.voice : null;

  const selectedCallKey = draft.call.providerId && draft.call.modelId
    ? `${draft.call.providerId}::${draft.call.modelId}`
    : draft.call.modelId
      ? LEGACY_KEY
      : null;
  const matchedCallOption = selectedCallKey ? liveModels.find((opt) => opt.selectionKey === selectedCallKey) : undefined;
  const callChoices: Record<string, string> = {};
  for (const opt of liveModels) callChoices[opt.selectionKey] = opt.label;
  if (!matchedCallOption && draft.call.modelId && (draft.call.providerId || snapshot.call.hasCredential)) {
    const legacyKey = draft.call.providerId ? `${draft.call.providerId}::${draft.call.modelId}` : LEGACY_KEY;
    callChoices[legacyKey] = draft.call.providerId ? `${draft.call.modelId} · ${draft.call.providerId}` : draft.call.modelId;
  }
  const activeCallKey = selectedCallKey && Object.hasOwn(callChoices, selectedCallKey) ? selectedCallKey : null;
  const hasSelectedCallModel = activeCallKey !== null;
  const callVoiceList = matchedCallOption?.voices.length
    ? matchedCallOption.voices
    : hasSelectedCallModel
      ? fallbackCallVoices(draft.call)
      : [];
  const callVoiceChoices = Object.fromEntries(
    [...new Set([...callVoiceList, ...(hasSelectedCallModel ? [draft.call.voice] : [])])].filter(Boolean).map((v) => [v, v]),
  );
  const activeCallVoice = hasSelectedCallModel && draft.call.voice && Object.hasOwn(callVoiceChoices, draft.call.voice) ? draft.call.voice : null;
  const unselectedPlaceholder = t("未选择", "Not selected");

  return (
    <>
      <SettingsSection
        title={t("语音合成", "Speech synthesis")}
        status={ttsStatus}
        action={
          <div className="kulo-voice-settings-header-actions">
            {ttsModels.length === 0 && onOpenModels && (
              <Button size="sm" variant="ghost" isDisabled={disabled} onPress={onOpenModels}>
                {t("添加 TTS 模型", "Add TTS model")}
              </Button>
            )}
            {ttsAction}
            <EnableSwitch
              label={t("启用语音合成", "Enable speech synthesis")}
              enabled={snapshot.tts.enabled}
              onChange={(enabled) => onToggle("tts", enabled)}
              disabled={togglesDisabled || (!snapshot.tts.enabled && !snapshot.tts.modelId)}
              busy={busy}
              pending={switching === "tts"}
            />
          </div>
        }
      >
        {ttsFeedback}
        <form
          className="kulo-form-stack"
          aria-label={t("语音合成配置", "Speech synthesis configuration")}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.("tts");
          }}
        >
          <div className="kulo-form-grid" inert={busy || undefined}>
            <VoiceSelect
              label={t("TTS 模型", "TTS model")}
              value={activeTtsKey}
              choices={ttsChoices}
              placeholder={unselectedPlaceholder}
              disabled={disabled || Object.keys(ttsChoices).length === 0}
              onChange={(key) => {
                const chosen = ttsModels.find((opt) => opt.selectionKey === key);
                if (chosen) onChange({ ...draft, tts: selectTtsModelOption(draft.tts, chosen) });
              }}
            />
            <div className="kulo-form-grid">
              <VoiceSelect
                label={t("合成音色", "Voice")}
                value={activeTtsVoice}
                choices={ttsVoiceChoices}
                placeholder={unselectedPlaceholder}
                disabled={disabled || !hasSelectedTtsModel || Object.keys(ttsVoiceChoices).length === 0}
                onChange={(voice) => onChange({ ...draft, tts: { ...draft.tts, voice } })}
              />
              <VoiceSelect
                label={t("语速", "Speaking rate")}
                value={draft.tts.speed}
                choices={SPEED_LABELS}
                disabled={disabled}
                onChange={(speed) => onChange({ ...draft, tts: { ...draft.tts, speed: speed as VoiceSpeed } })}
              />
            </div>
          </div>
          {ttsFooter}
        </form>
      </SettingsSection>

      <SettingsSection
        title={t("通话", "Calls")}
        status={callStatus}
        action={
          <div className="kulo-voice-settings-header-actions">
            {liveModels.length === 0 && onOpenModels && (
              <Button size="sm" variant="ghost" isDisabled={disabled} onPress={onOpenModels}>
                {t("添加 Live 模型", "Add Live model")}
              </Button>
            )}
            {callAction}
            <EnableSwitch
              label={t("启用通话", "Enable calls")}
              enabled={snapshot.call.enabled}
              onChange={(enabled) => onToggle("call", enabled)}
              disabled={togglesDisabled || (!snapshot.call.enabled && !snapshot.call.modelId)}
              busy={busy}
              pending={switching === "call"}
            />
          </div>
        }
      >
        {callFeedback}
        <form
          className="kulo-form-stack"
          aria-label={t("通话配置", "Call configuration")}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.("call");
          }}
        >
          <div className="kulo-form-grid" inert={busy || undefined}>
            <VoiceSelect
              label={t("Live 模型", "Live model")}
              value={activeCallKey}
              choices={callChoices}
              placeholder={unselectedPlaceholder}
              disabled={disabled || Object.keys(callChoices).length === 0}
              onChange={(key) => {
                const chosen = liveModels.find((opt) => opt.selectionKey === key);
                if (chosen) onChange({ ...draft, call: selectCallModelOption(draft.call, chosen) });
              }}
            />
            <VoiceSelect
              label={t("通话音色", "Call voice")}
              value={activeCallVoice}
              choices={callVoiceChoices}
              placeholder={unselectedPlaceholder}
              disabled={disabled || !hasSelectedCallModel || Object.keys(callVoiceChoices).length === 0}
              onChange={(voice) => onChange({ ...draft, call: { ...draft.call, voice } })}
            />
          </div>
          {callFooter}
        </form>
      </SettingsSection>
    </>
  );
}

function VoiceSettingsEditor({
  snapshot,
  settings,
  disabled,
  onDirtyChange,
  onOpenModels,
}: {
  snapshot: VoiceSnapshot;
  settings?: KuloSettingsView | null;
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenModels?: () => void;
}) {
  const { t } = useI18n();
  const workspace = useVoiceWorkspace()!;
  const { providers } = useProviderCatalog(settings ?? null);
  const modelValue = settings?.blocks.model.value;
  const hasGatewayKey = Boolean(settings?.blocks.model.hasApiKey);

  const asrModels = useMemo(
    () => (modelValue ? buildConfiguredModelsForPurpose(modelValue, providers, "asr", hasGatewayKey) : []),
    [modelValue, providers, hasGatewayKey],
  );
  const ttsModels = useMemo(
    () => (modelValue ? buildConfiguredModelsForPurpose(modelValue, providers, "tts", hasGatewayKey) : []),
    [modelValue, providers, hasGatewayKey],
  );
  const liveModels = useMemo(
    () => (modelValue ? buildConfiguredModelsForPurpose(modelValue, providers, "live", hasGatewayKey) : []),
    [modelValue, providers, hasGatewayKey],
  );

  const [editor, setEditor] = useState(() => createVoiceSettingsEditor(snapshot));
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [busy, setBusy] = useState<{ kind: "toggle" | "save" | "prepare" | "probe" | "preview" | "asr-source"; scope: VoiceToggleScope }>();
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<Partial<Record<VoiceToggleScope, { message: string; retryEnabled?: boolean }>>>({});
  const [previewing, setPreviewing] = useState(false);
  const preview = useRef<{ controller: AbortController; audio?: HTMLAudioElement; url?: string } | null>(null);
  const mounted = useRef(true);
  const { base, draft, conflicts } = editor;
  const saved = snapshot.revision >= base.revision ? snapshot : base;
  const ttsDirty = voiceFormDirty(draft, base, "tts");
  const callDirty = voiceFormDirty(draft, base, "call");
  const dirty = ttsDirty || callDirty;
  const blocked = disabled || Boolean(busy);
  useSettingsPending(busy?.kind === "toggle" || busy?.kind === "save" || busy?.kind === "asr-source");
  const updateEditor = (update: (current: VoiceSettingsEditorState) => VoiceSettingsEditorState) => {
    const next = update(editorRef.current);
    editorRef.current = next;
    if (mounted.current) setEditor(next);
  };
  const latestSnapshot = () => (snapshot.revision >= editorRef.current.base.revision ? snapshot : editorRef.current.base);
  const clearError = (scope: VoiceToggleScope) => setErrors((previous) => ({ ...previous, [scope]: undefined }));
  const report = (failure: unknown) =>
    redactSensitiveText(failure instanceof Error ? failure.message : t("语音设置操作失败", "Voice settings action failed"));
  useEffect(() => {
    updateEditor((current) => acceptVoiceSettings(current, snapshot));
  }, [snapshot]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const stopPreview = () => {
    const active = preview.current;
    preview.current = null;
    active?.controller.abort();
    if (active?.audio) {
      active.audio.onended = null;
      active.audio.onerror = null;
      active.audio.pause();
      active.audio.removeAttribute("src");
      active.audio.load();
    }
    if (active?.url) URL.revokeObjectURL(active.url);
    if (mounted.current) setPreviewing(false);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopPreview();
    };
  }, []);
  useEffect(() => {
    stopPreview();
  }, [snapshot.revision]);
  const begin = (kind: NonNullable<typeof busy>["kind"], scope: VoiceToggleScope) => {
    busyRef.current = true;
    setBusy({ kind, scope });
    clearError(scope);
  };
  const finish = () => {
    busyRef.current = false;
    if (mounted.current) setBusy(undefined);
  };
  const failure = async (scope: VoiceToggleScope, cause: unknown, retryEnabled?: boolean) => {
    if (!mounted.current) return;
    setErrors((previous) => ({ ...previous, [scope]: { message: report(cause), retryEnabled } }));
    if (cause instanceof KuloApiError && cause.code === "voice_revision_conflict") {
      if (scope !== "asr" && voiceFormDirty(editorRef.current.draft, editorRef.current.base, scope)) {
        updateEditor((current) => ({ ...current, conflicts: { ...current.conflicts, [scope]: true } }));
      }
      await workspace.refresh();
    }
  };
  const toggle = async (scope: VoiceToggleScope, enabled: boolean) => {
    if (disabled || busyRef.current || (scope === "asr" ? workspace.recordingActive : workspace.call.active)) return;
    const current = latestSnapshot();
    if (current[scope].enabled === enabled) {
      clearError(scope);
      return;
    }
    stopPreview();
    begin("toggle", scope);
    try {
      const next = await workspace.save(voiceToggleInput(current, scope, enabled));
      if (mounted.current) updateEditor((previous) => acceptVoiceSettings(previous, next, { expectedRevision: current.revision }));
    } catch (cause) {
      await failure(scope, cause, enabled);
    } finally {
      finish();
    }
  };
  const changeAsrSource = async (selectionKey: string) => {
    if (disabled || busyRef.current || workspace.recordingActive) return;
    const current = latestSnapshot();
    const chosen = selectionKey === LOCAL_ASR_KEY ? undefined : asrModels.find((opt) => opt.selectionKey === selectionKey);
    if (!chosen && selectionKey !== LOCAL_ASR_KEY) return;
    const currentKey = current.asr.source === "provider" && current.asr.providerId && current.asr.modelId
      ? `${current.asr.providerId}::${current.asr.modelId}`
      : LOCAL_ASR_KEY;
    if (selectionKey === currentKey) return;
    begin("asr-source", "asr");
    try {
      const next = await workspace.save(voiceAsrSourceInput(current, chosen));
      if (mounted.current) updateEditor((previous) => acceptVoiceSettings(previous, next, { expectedRevision: current.revision }));
    } catch (cause) {
      await failure("asr", cause);
    } finally {
      finish();
    }
  };
  const save = async (scope: VoiceFormScope) => {
    const current = editorRef.current;
    if (disabled || busyRef.current || workspace.call.active || current.conflicts[scope] || !voiceFormDirty(current.draft, current.base, scope)) return;
    if (latestSnapshot().revision !== current.base.revision) {
      updateEditor((previous) => acceptVoiceSettings(previous, latestSnapshot()));
      return;
    }
    stopPreview();
    begin("save", scope);
    try {
      const input = voiceSettingsInput(current.draft, current.base, scope);
      const next = await workspace.save(input);
      if (mounted.current) updateEditor((previous) => acceptVoiceSettings(previous, next, { expectedRevision: current.base.revision, savedScope: scope }));
    } catch (cause) {
      await failure(scope, cause);
    } finally {
      finish();
    }
  };
  const discard = (scope: VoiceFormScope) => {
    if (busyRef.current) return;
    stopPreview();
    updateEditor((current) => discardVoiceSettingsScope(current, latestSnapshot(), scope));
    clearError(scope);
  };
  const action = async (kind: "prepare" | "probe" | "preview") => {
    if (kind === "preview" && previewing) {
      stopPreview();
      return;
    }
    const scope = kind === "prepare" ? "asr" : kind === "probe" ? "call" : "tts";
    if (disabled || busyRef.current || (scope !== "asr" && (workspace.call.active || voiceFormDirty(editorRef.current.draft, editorRef.current.base, scope)))) return;
    begin(kind, scope);
    try {
      if (kind === "prepare" || kind === "probe") {
        const next = kind === "prepare" ? await workspace.prepare() : await workspace.probe();
        if (mounted.current) updateEditor((current) => acceptVoiceSettings(current, next));
        return;
      }
      if (!latestSnapshot().tts.hasCredential) throw new Error(t("请先连接所选 TTS 模型的服务密钥", "Connect an API key for the selected TTS model first"));
      stopPreview();
      const current = { controller: new AbortController(), audio: undefined as HTMLAudioElement | undefined, url: undefined as string | undefined };
      preview.current = current;
      const blob = await voiceApi.synthesize(
        t("你好，我是 Kulo。我们可以开始聊了。", "Hello, I'm Kulo. Let's have a chat."),
        workspace.clientId,
        current.controller.signal,
        true,
      );
      if (!mounted.current || preview.current !== current) return;
      current.url = URL.createObjectURL(blob);
      current.audio = new Audio(current.url);
      current.audio.onended = stopPreview;
      current.audio.onerror = () => {
        if (mounted.current) setErrors((previous) => ({ ...previous, tts: { message: t("试听语音无法播放", "Unable to play the voice preview") } }));
        stopPreview();
      };
      pauseOtherMedia(current.audio);
      await current.audio.play();
      if (mounted.current) setPreviewing(true);
    } catch (cause) {
      await failure(scope, cause);
      if (kind === "preview") stopPreview();
    } finally {
      finish();
    }
  };
  const feedback = (scope: VoiceToggleScope) => {
    const error = errors[scope];
    const conflict = scope !== "asr" && conflicts[scope];
    const retryEnabled = error?.retryEnabled;
    if (!error && !conflict) return null;
    return (
      <Alert status={conflict ? "warning" : "danger"} role="alert">
        <Alert.Content>{error?.message ?? t("配置已更新", "Configuration changed")}</Alert.Content>
        {retryEnabled !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={blocked || (scope === "asr" ? workspace.recordingActive : workspace.call.active)}
            onPress={() => {
              void toggle(scope, retryEnabled);
            }}
          >
            {t("重试", "Retry")}
          </Button>
        )}
        {scope !== "asr" && conflict && (
          <Button size="sm" variant="secondary" isDisabled={Boolean(busy)} onPress={() => discard(scope)}>
            {t("载入最新配置", "Load latest configuration")}
          </Button>
        )}
      </Alert>
    );
  };
  const footer = (scope: VoiceFormScope) => (
    <SettingsSaveBar
      scopeLabel={scope === "tts" ? t("语音合成配置", "Speech configuration") : t("通话配置", "Call configuration")}
      dirty={scope === "tts" ? ttsDirty : callDirty}
      busy={Boolean(busy)}
      saving={busy?.kind === "save" && busy.scope === scope}
      disabled={disabled || workspace.call.active || conflicts[scope]}
      onDiscard={() => discard(scope)}
      onSave={() => {
        void save(scope);
      }}
    />
  );

  const isCloudAsr = saved.asr.source === "provider";
  const asrLabel = !saved.asr.enabled
    ? t("已关闭", "Off")
    : isCloudAsr
      ? saved.asr.hasCredential !== false
        ? t("云端可用", "Cloud ready")
        : t("待连接", "Not connected")
      : {
          unprepared: t("待准备", "Not prepared"),
          preparing: t("准备中", "Preparing"),
          ready: t("本地可用", "Ready locally"),
          error: t("准备失败", "Preparation failed"),
        }[saved.asr.status];

  const asrChoices: Record<string, string> = {
    [LOCAL_ASR_KEY]: t("本机离线 · SenseVoice", "Local offline · SenseVoice"),
  };
  for (const opt of asrModels) asrChoices[opt.selectionKey] = opt.label;
  const savedAsrKey = isCloudAsr && saved.asr.providerId && saved.asr.modelId
    ? `${saved.asr.providerId}::${saved.asr.modelId}`
    : LOCAL_ASR_KEY;
  if (savedAsrKey !== LOCAL_ASR_KEY && !Object.hasOwn(asrChoices, savedAsrKey)) {
    asrChoices[savedAsrKey] = `${saved.asr.modelId} · ${saved.asr.providerId}`;
  }

  const callLabel = !saved.call.enabled
    ? t("已关闭", "Off")
    : !saved.call.hasCredential
      ? t("待连接", "Not connected")
      : saved.call.status === "ready"
        ? t("通话可用", "Calls ready")
        : saved.call.status === "error"
          ? t("连接失败", "Connection failed")
          : t("待验证", "Unverified");

  return (
    <div className="kulo-voice-settings" aria-busy={Boolean(busy) || undefined}>
      <SettingsSection
        title={t("语音转文本", "Speech to text")}
        status={
          <>
            <Chip size="sm" variant="soft" color={saved.asr.enabled && saved.asr.status === "ready" && (!isCloudAsr || saved.asr.hasCredential !== false) ? "success" : "default"}>
              {asrLabel}
              {!isCloudAsr && saved.asr.enabled && saved.asr.status === "preparing" && saved.asr.progress !== undefined
                ? ` ${Math.round(saved.asr.progress <= 1 ? saved.asr.progress * 100 : saved.asr.progress)}%`
                : ""}
            </Chip>
            {!isCloudAsr && saved.asr.enabled && saved.asr.status === "preparing" && <Spinner size="sm" />}
          </>
        }
        action={
          <div className="kulo-voice-settings-header-actions">
            {!isCloudAsr && saved.asr.enabled && (saved.asr.status === "unprepared" || saved.asr.status === "error") && (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={disabled || Boolean(busy && busy.kind !== "prepare") || workspace.recordingActive}
                isPending={busy?.kind === "prepare"}
                onPress={() => {
                  void action("prepare");
                }}
              >
                {saved.asr.status === "error" ? t("重试", "Retry") : t("准备本地模型", "Prepare local model")}
              </Button>
            )}
            <EnableSwitch
              label={t("语音转文本", "Speech to text")}
              enabled={saved.asr.enabled}
              disabled={disabled || workspace.recordingActive}
              busy={Boolean(busy)}
              pending={(busy?.kind === "toggle" || busy?.kind === "asr-source") && busy.scope === "asr"}
              onChange={(enabled) => {
                void toggle("asr", enabled);
              }}
            />
          </div>
        }
      >
        {(asrModels.length > 0 || isCloudAsr) && (
          <div className="kulo-form-grid" inert={Boolean(busy) || undefined}>
            <VoiceSelect
              label={t("识别模型", "Recognition model")}
              value={savedAsrKey}
              choices={asrChoices}
              disabled={disabled || workspace.recordingActive}
              onChange={(key) => {
                void changeAsrSource(key);
              }}
            />
          </div>
        )}
        {saved.asr.enabled && saved.asr.error && (
          <p className="text-sm text-danger" role="alert">
            {saved.asr.error}
          </p>
        )}
        {feedback("asr")}
      </SettingsSection>

      <VoiceSettingsFields
        snapshot={saved}
        draft={draft}
        ttsModels={ttsModels}
        liveModels={liveModels}
        onOpenModels={onOpenModels}
        onChange={(next) => {
          if (busyRef.current) return;
          stopPreview();
          if (next.tts !== draft.tts) clearError("tts");
          if (next.call !== draft.call) clearError("call");
          updateEditor((current) => ({ ...current, draft: next }));
        }}
        onToggle={(scope, enabled) => {
          void toggle(scope, enabled);
        }}
        onSubmit={(scope) => {
          void save(scope);
        }}
        disabled={disabled}
        togglesDisabled={disabled || workspace.call.active}
        busy={Boolean(busy)}
        switching={busy?.kind === "toggle" && busy.scope !== "asr" ? busy.scope : undefined}
        ttsStatus={<Chip size="sm" variant="soft">{voiceTtsStatusLabel(saved)}</Chip>}
        callStatus={
          <Chip
            size="sm"
            variant="soft"
            color={
              saved.call.enabled && saved.call.hasCredential && saved.call.status === "ready"
                ? "success"
                : saved.call.enabled && saved.call.status === "error"
                  ? "danger"
                  : "default"
            }
          >
            {callLabel}
          </Chip>
        }
        ttsAction={
          <Button
            size="sm"
            variant="ghost"
            isDisabled={disabled || Boolean(busy && busy.kind !== "preview") || workspace.call.active || ttsDirty || !saved.tts.hasCredential}
            isPending={busy?.kind === "preview"}
            onPress={() => {
              void action("preview");
            }}
          >
            {busy?.kind === "preview" ? <Spinner size="sm" color="current" /> : <VoiceIcon name="speaker" size={17} />}
            {previewing ? t("停止试听", "Stop preview") : t("试听音色", "Preview voice")}
          </Button>
        }
        callAction={
          <Button
            size="sm"
            variant="ghost"
            className="relative"
            aria-label={t("测试通话", "Test call")}
            isDisabled={disabled || Boolean(busy && busy.kind !== "probe") || workspace.call.active || callDirty || !saved.call.hasCredential}
            isPending={busy?.kind === "probe"}
            onPress={() => {
              void action("probe");
            }}
          >
            <span className={busy?.kind === "probe" ? "invisible" : undefined}>{t("测试通话", "Test call")}</span>
            {busy?.kind === "probe" && <Spinner size="sm" color="current" className="absolute" aria-label={t("正在测试通话", "Testing call")} />}
          </Button>
        }
        ttsFeedback={feedback("tts")}
        callFeedback={
          <>
            {saved.call.error && (
              <p className="text-sm text-danger" role="alert">
                {saved.call.error}
              </p>
            )}
            {feedback("call")}
          </>
        }
        ttsFooter={footer("tts")}
        callFooter={footer("call")}
      />
    </div>
  );
}

export function VoiceModule({
  connected,
  settings,
  disabled = false,
  onDirtyChange,
  onOpenModels,
}: {
  connected: boolean;
  settings?: KuloSettingsView | null;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenModels?: () => void;
}) {
  const { t } = useI18n();
  const workspace = useVoiceWorkspace();
  if (!workspace) return <p className="text-sm text-muted" role="status">{t("语音配置正在加载", "Loading voice settings")}</p>;
  if (!workspace.snapshot) {
    return workspace.error ? (
      <Alert status="danger">
        <Alert.Content>{workspace.error}</Alert.Content>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!connected || workspace.loading}
          onPress={() => {
            void workspace.refresh();
          }}
        >
          {t("重试", "Retry")}
        </Button>
      </Alert>
    ) : (
      <div className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner size="sm" />
        {t("加载中…", "Loading…")}
      </div>
    );
  }
  return (
    <>
      {workspace.error && (
        <Alert status="danger">
          <Alert.Content>{workspace.error}</Alert.Content>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={!connected || workspace.loading}
            onPress={() => {
              void workspace.refresh();
            }}
          >
            {t("重试", "Retry")}
          </Button>
        </Alert>
      )}
      <VoiceSettingsEditor
        snapshot={workspace.snapshot}
        settings={settings}
        disabled={!connected || disabled}
        onDirtyChange={onDirtyChange}
        onOpenModels={onOpenModels}
      />
    </>
  );
}
