import { useState, type Key, type ReactNode } from "react";
import { useI18n } from "../../kulo-i18n";
import {
  Alert, Button, Chip, Input, Label, ListBox, Modal, NumberField,
  SearchField, Select, Spinner, Switch, Tabs, TextField,
} from "@heroui/react";
import {
  defaultProtocolAdapterForModel,
  defaultVoicesForAdapter,
  getImageModelPreset,
  inferModelPurpose,
  type CustomModelConfig,
  type CustomProviderApi,
  type MediaOutputFormat,
  type ModelModality,
  type ModelProtocolAdapter,
  type ModelPurpose,
  type ProviderModelItem,
  type ThinkingLevelOption,
} from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";
import { MODALITIES, getModelModalities, getModelThinkingLevels } from "./settings-helpers";

export const DEFAULT_MODEL_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MODEL_MAX_TOKENS = 64_000;

export type ModelPurposeFilter = "all" | ModelPurpose;

const NATIVE_SEARCH_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses", "anthropic-messages"]);
const IMAGE_FORMATS: readonly MediaOutputFormat[] = ["png", "jpeg", "webp", "gif", "svg"];

export function nativeSearchAvailable(
  api: string | undefined,
  options?: { officialSource?: boolean; presetId?: string },
): boolean {
  if (options?.officialSource === false) return false;
  if (options?.presetId === "openrouter" && api && ["openai-completions", "openai-responses", "anthropic-messages"].includes(api)) {
    return true;
  }
  return Boolean(api && NATIVE_SEARCH_APIS.has(api));
}

export function purposeBadgeLabel(purpose: ModelPurpose): string {
  switch (purpose) {
    case "image":
      return "Image";
    case "tts":
      return "TTS";
    case "asr":
      return "ASR";
    case "live":
      return "Live";
    default:
      return "Chat";
  }
}

export function modelConfigFromCatalog(
  item: ProviderModelItem,
  api: CustomProviderApi,
  options?: { presetId?: string; officialSource?: boolean },
): CustomModelConfig {
  const purpose = inferModelPurpose(item);
  if (purpose !== "chat") {
    const protocolAdapter = item.protocolAdapter ?? defaultProtocolAdapterForModel(purpose, item.id, api, options?.presetId);
    const voices = purpose === "tts" || purpose === "live"
      ? (item.voices?.length ? [...item.voices] : defaultVoicesForAdapter(protocolAdapter))
      : undefined;
    const preset = purpose === "image" && (protocolAdapter === "openai-image" || protocolAdapter === "gemini-image")
      ? getImageModelPreset(protocolAdapter, item.id.replace(/^models\//, ""))
      : undefined;
    const imageProfile = purpose === "image"
      ? (item.imageProfile ?? preset?.profile ?? {
          formats: protocolAdapter === "gemini-image" ? ["jpeg", "png"] : ["png", "jpeg", "webp"],
          supportsEdit: true,
          maxReferences: 4,
        })
      : undefined;
    return {
      id: item.id,
      purpose,
      ...(protocolAdapter ? { protocolAdapter } : {}),
      ...(voices?.length ? { voices } : {}),
      ...(imageProfile ? { imageProfile } : {}),
      ...(item.imageDefaults ?? preset?.defaults ? { imageDefaults: item.imageDefaults ?? preset?.defaults } : {}),
      ...(item.customImageAdapter ? { customImageAdapter: item.customImageAdapter } : {}),
      ...(item.outputModalities?.length
        ? { outputModalities: [...item.outputModalities] }
        : { outputModalities: [purpose === "image" ? "image" : purpose === "asr" ? "text" : "audio"] }),
      ...(item.name && item.name !== item.id ? { name: item.name } : {}),
    };
  }
  const reasoning = item.reasoning ?? true;
  const allowNativeSearch = options?.officialSource !== false;
  return {
    id: item.id,
    ...(item.purpose ? { purpose: item.purpose } : {}),
    ...(item.outputModalities ? { outputModalities: [...item.outputModalities] } : {}),
    ...(item.name && item.name !== item.id ? { name: item.name } : {}),
    modalities: item.modalities?.length ? [...item.modalities] : ["text"],
    vision: item.modalities?.includes("image") ?? item.vision,
    contextWindow: item.contextWindow || DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: item.maxTokens || DEFAULT_MODEL_MAX_TOKENS,
    reasoning,
    thinkingEnabled: item.thinkingEnabled ?? reasoning,
    ...(item.thinkingLevelMap ? { thinkingLevelMap: item.thinkingLevelMap } : {}),
    thinkingLevels: getModelThinkingLevels(item, api),
    ...(allowNativeSearch && item.nativeTools ? { nativeTools: { ...item.nativeTools } } : {}),
  };
}

export function buildManualModelConfig(
  id: string,
  purpose: ModelPurpose,
  api: CustomProviderApi,
  presetId?: string,
): CustomModelConfig {
  if (purpose !== "chat") {
    const protocolAdapter = defaultProtocolAdapterForModel(purpose, id, api, presetId);
    const voices = purpose === "tts" || purpose === "live" ? defaultVoicesForAdapter(protocolAdapter) : undefined;
    const preset = purpose === "image" && (protocolAdapter === "openai-image" || protocolAdapter === "gemini-image")
      ? getImageModelPreset(protocolAdapter, id.replace(/^models\//, ""))
      : undefined;
    return {
      id,
      purpose,
      ...(protocolAdapter ? { protocolAdapter } : {}),
      ...(voices?.length ? { voices } : {}),
      ...(purpose === "image" ? {
        imageProfile: preset?.profile ?? {
          formats: protocolAdapter === "gemini-image" ? ["jpeg", "png"] : ["png", "jpeg", "webp"],
          supportsEdit: true,
          maxReferences: 4,
        },
        ...(preset?.defaults ? { imageDefaults: preset.defaults } : {}),
      } : {}),
      outputModalities: [purpose === "image" ? "image" : purpose === "asr" ? "text" : "audio"],
    };
  }
  return {
    id,
    purpose: "chat",
    modalities: ["text"],
    vision: false,
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    reasoning: true,
    thinkingEnabled: true,
    thinkingLevels: getModelThinkingLevels({}, api),
  };
}

export function ModelNativeToolsFields({ model, api, disabled, officialSource = true, presetId, onUpdate }: {
  model: CustomModelConfig; api: string | undefined; disabled: boolean;
  officialSource?: boolean; presetId?: string;
  onUpdate: (id: string, patch: Partial<CustomModelConfig>) => void;
}) {
  const { t } = useI18n();
  const available = nativeSearchAvailable(api, { officialSource, presetId });
  const selected = model.nativeTools?.webSearch === true;
  const incompatibleTools = api === "google-generative-ai" || api === "google-vertex";
  return <section aria-label={model.id + t(" 原生工具", " Native tools")} className="flex flex-col gap-3">
    <h3 className="kulo-group-title">{t("原生工具", "Native tools")}</h3>
    <Switch className="w-full" aria-label={model.id + t(" 联网搜索", " Web search")} isSelected={selected} isDisabled={disabled || !available && !selected} onChange={(webSearch) => {
      if (available || !webSearch) onUpdate(model.id, { nativeTools: { ...model.nativeTools, webSearch } });
    }}>
      <Switch.Content className="kulo-form-toggle">
        <Label className="text-sm font-medium">{t("联网搜索", "Web search")}</Label>
        <Switch.Control><Switch.Thumb /></Switch.Control>
      </Switch.Content>
    </Switch>
    {!available && <Alert status={selected ? "warning" : "default"}><Alert.Content>{
      officialSource === false
        ? t("第三方接口默认使用 Kulo 搜索工具，不开启模型内置搜索。", "Third-party APIs use Kulo search tools by default instead of built-in model search.")
        : incompatibleTools
          ? t("当前接口不支持联网搜索与智能体工具同时使用。", "This API cannot use web search and agent tools together.")
          : t("当前接口暂不支持原生联网搜索。", "This API does not support native web search.")
    }</Alert.Content></Alert>}
  </section>;
}

function contextLabel(model: CustomModelConfig) {
  return Math.round((model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW) / 1000).toLocaleString("en-US") + "K";
}

function ModelPurposeFilterTabs({ label, value, onChange }: {
  label: string;
  value: ModelPurposeFilter;
  onChange: (value: ModelPurposeFilter) => void;
}) {
  const { t } = useI18n();
  const tabs: Array<{ id: ModelPurposeFilter; label: string }> = [
    { id: "all", label: t("全部", "All") },
    { id: "chat", label: "Chat" },
    { id: "image", label: "Image" },
    { id: "tts", label: "TTS" },
    { id: "asr", label: "ASR" },
    { id: "live", label: "Live" },
  ];
  return (
    <Tabs selectedKey={value} onSelectionChange={(key) => onChange(key as ModelPurposeFilter)} className="min-w-0">
      <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
        <Tabs.List aria-label={label} className="w-max">
          {tabs.map((tab) => (
            <Tabs.Tab key={tab.id} id={tab.id} className="w-auto shrink-0 whitespace-nowrap px-2.5 text-xs">
              {tab.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

function ModelListPanel({ title, count, action, search, filter, children, footer, compact }: {
  title: string; count?: number; action?: ReactNode; search: ReactNode; filter?: ReactNode;
  children: ReactNode; footer?: ReactNode; compact: boolean;
}) {
  return (
    <section aria-label={title} className="kulo-model-pane" data-compact={compact}>
      <header className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
        <h3 className="kulo-group-title flex items-center gap-2">
          {title}
          {count !== undefined && <Chip size="sm" variant="soft">{count}</Chip>}
        </h3>
        {action}
      </header>
      <div className="flex flex-col gap-2 px-3 pb-3">
        {search}
        {filter}
      </div>
      <div className="kulo-model-pane-body">{children}</div>
      {footer && <footer className="kulo-model-pane-footer p-3">{footer}</footer>}
    </section>
  );
}

export function AvailableModelsPane({ compact, models, total, selectedKeys, loading, error, hasFetched,
  search, onSearch, disabled, onDiscover, onSelectionChange, officialCatalog = false,
  purposeFilter, onPurposeFilterChange,
}: {
  compact: boolean; models: ProviderModelItem[]; total: number; selectedKeys: Set<string>;
  loading: boolean; error?: string; hasFetched: boolean; search: string;
  onSearch: (value: string) => void; disabled: boolean; onDiscover: () => void;
  onSelectionChange: (selection: "all" | Set<Key>) => void;
  officialCatalog?: boolean;
  purposeFilter?: ModelPurposeFilter;
  onPurposeFilterChange?: (value: ModelPurposeFilter) => void;
}) {
  const { t } = useI18n();
  const loadingLabel = t("正在获取模型列表", "Loading models");
  const errorAlert = error && <Alert status="danger" role="alert" className="rounded-xl p-3"><Alert.Indicator /><Alert.Content>{error}</Alert.Content></Alert>;
  const retainCatalog = hasFetched && total > 0;
  return (
    <ModelListPanel
      title={officialCatalog ? t("官方模型目录", "Official model catalog") : t("可用模型", "Available models")}
      count={hasFetched && (!error || total > 0) ? total : undefined}
      compact={compact}
      footer={retainCatalog ? errorAlert : undefined}
      action={<Button size="sm" variant="secondary" isPending={loading} isDisabled={disabled || loading} onPress={onDiscover}>
        <KuloIcon name="refresh" size={16} />{loading ? t("获取中", "Loading") : officialCatalog ? t("刷新目录", "Refresh catalog") : t("获取列表", "Get models")}
      </Button>}
      search={<SearchField className="kulo-context-field" variant="primary" aria-label={officialCatalog ? t("搜索官方模型目录", "Search official model catalog") : t("搜索可用模型", "Search available models")} isDisabled={disabled} value={search} onChange={onSearch} fullWidth>
        <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder={t("搜索模型…", "Search models…")} /><SearchField.ClearButton /></SearchField.Group>
      </SearchField>}
      filter={purposeFilter && onPurposeFilterChange
        ? <ModelPurposeFilterTabs label={t("按类型筛选可用模型", "Filter available models by type")} value={purposeFilter} onChange={onPurposeFilterChange} />
        : undefined}
    >
      <div className="kulo-table-header kulo-model-column-head grid grid-cols-[minmax(0,1fr)_40px]">
        <span>{t("模型", "Model")}</span><span className="text-right">{t("添加", "Add")}</span>
      </div>
      <div className="kulo-model-pane-scroll" aria-busy={loading}>
        {!retainCatalog && errorAlert && <div className="m-3">{errorAlert}</div>}
        {loading && !hasFetched ? <div className="kulo-model-empty"><Spinner size="sm" aria-label={loadingLabel} /><span>{loadingLabel}…</span></div>
          : !hasFetched && total === 0 ? !error && <div className="kulo-model-empty">{t("尚未获取模型列表", "Model list not loaded")}</div>
          : models.length === 0 ? !error && <div className="kulo-model-empty">{total === 0 ? officialCatalog ? t("官方目录未返回模型", "The official catalog returned no models") : t("远端未返回可用模型", "The provider returned no available models") : t("没有匹配的模型", "No matching models")}</div>
          : <ListBox
              aria-label={officialCatalog ? t("官方模型目录列表", "Official model catalog") : t("可用模型列表", "Available models")}
              disabledKeys={disabled ? models.map((model) => model.id) : []}
              selectionMode="multiple"
              selectedKeys={selectedKeys}
              onSelectionChange={onSelectionChange}
              className="gap-0.5 p-2"
            >
              {models.map((model) => {
                const purpose = inferModelPurpose(model);
                return (
                  <ListBox.Item key={model.id} id={model.id} textValue={model.id} className="min-h-11 gap-3 px-3 text-sm text-foreground data-[hovered=true]:bg-surface-tertiary">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm " title={model.id}>{model.id}</span>
                    {purpose !== "chat" && <Chip size="sm" variant="soft" className="shrink-0">{purposeBadgeLabel(purpose)}</Chip>}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                );
              })}
            </ListBox>}
      </div>
    </ModelListPanel>
  );
}

const ADAPTER_OPTIONS_BY_PURPOSE: Record<Exclude<ModelPurpose, "chat">, Array<{ id: ModelProtocolAdapter; label: string }>> = {
  image: [
    { id: "openai-image", label: "OpenAI Images" },
    { id: "gemini-image", label: "Gemini Image" },
  ],
  tts: [
    { id: "openai-speech", label: "OpenAI Speech" },
    { id: "minimax-t2a", label: "MiniMax T2A" },
    { id: "gemini-tts", label: "Gemini TTS" },
  ],
  asr: [
    { id: "openai-asr", label: "OpenAI Transcriptions" },
  ],
  live: [
    { id: "openai-realtime", label: "OpenAI Realtime" },
    { id: "gemini-live", label: "Gemini Live" },
    { id: "vertex-live", label: "Vertex Live" },
  ],
};

function ModelParametersDialog({
  model, availableModels, api, disabled, allowPurposeChange = true,
  allowProtocolSelect = false, officialSource = true, presetId, onUpdate, onClose,
}: {
  model: CustomModelConfig | undefined; availableModels: ProviderModelItem[]; api: CustomProviderApi;
  disabled: boolean; allowPurposeChange?: boolean; allowProtocolSelect?: boolean;
  officialSource?: boolean; presetId?: string;
  onUpdate: (id: string, patch: Partial<CustomModelConfig>) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [newVoice, setNewVoice] = useState("");
  if (!model) return null;
  const knownModel = availableModels.find((item) => item.id === model.id);
  const purpose = inferModelPurpose(model);
  const modalities = getModelModalities(model, knownModel);
  const levels = getModelThinkingLevels(model, api);
  const ctxK = Math.round((model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW) / 1000);
  const maxK = Math.round((model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS) / 1000);

  const effectiveAdapter = purpose === "chat"
    ? undefined
    : (model.protocolAdapter ?? defaultProtocolAdapterForModel(purpose, model.id, api, presetId));
  const voices = purpose === "tts" || purpose === "live"
    ? (model.voices?.length ? model.voices : defaultVoicesForAdapter(effectiveAdapter))
    : [];
  const imagePreset = purpose === "image" && (effectiveAdapter === "openai-image" || effectiveAdapter === "gemini-image")
    ? getImageModelPreset(effectiveAdapter, model.id.replace(/^models\//, ""))
    : undefined;
  const imageFormats = model.imageProfile?.formats?.length
    ? model.imageProfile.formats
    : imagePreset?.profile.formats ?? (effectiveAdapter === "gemini-image" ? ["jpeg", "png"] : ["png", "jpeg", "webp"]);
  const supportsEdit = model.imageProfile?.supportsEdit ?? imagePreset?.profile.supportsEdit ?? true;

  const handlePurposeChange = (nextPurpose: ModelPurpose) => {
    if (nextPurpose === purpose) return;
    if (nextPurpose === "chat") {
      const resetModalities = getModelModalities({}, knownModel);
      onUpdate(model.id, {
        purpose: "chat",
        protocolAdapter: undefined,
        voices: undefined,
        imageProfile: undefined,
        imageDefaults: undefined,
        customImageAdapter: undefined,
        outputModalities: ["text"],
        modalities: resetModalities,
        vision: resetModalities.includes("image"),
        contextWindow: knownModel?.contextWindow || DEFAULT_MODEL_CONTEXT_WINDOW,
        maxTokens: knownModel?.maxTokens || DEFAULT_MODEL_MAX_TOKENS,
        reasoning: knownModel?.reasoning ?? true,
        thinkingEnabled: knownModel?.thinkingEnabled ?? knownModel?.reasoning ?? true,
        thinkingLevels: getModelThinkingLevels(knownModel ?? {}, api),
      });
      return;
    }
    const nextAdapter = defaultProtocolAdapterForModel(nextPurpose, model.id, api, presetId);
    const nextVoices = nextPurpose === "tts" || nextPurpose === "live" ? defaultVoicesForAdapter(nextAdapter) : undefined;
    const preset = nextPurpose === "image" && (nextAdapter === "openai-image" || nextAdapter === "gemini-image")
      ? getImageModelPreset(nextAdapter, model.id.replace(/^models\//, ""))
      : undefined;
    onUpdate(model.id, {
      purpose: nextPurpose,
      protocolAdapter: nextAdapter,
      voices: nextVoices,
      imageProfile: nextPurpose === "image"
        ? (preset?.profile ?? {
            formats: nextAdapter === "gemini-image" ? ["jpeg", "png"] : ["png", "jpeg", "webp"],
            supportsEdit: true,
            maxReferences: 4,
          })
        : undefined,
      imageDefaults: nextPurpose === "image" ? preset?.defaults : undefined,
      outputModalities: [nextPurpose === "image" ? "image" : nextPurpose === "asr" ? "text" : "audio"],
      nativeTools: undefined,
    });
  };

  const handleAdapterChange = (nextAdapter: ModelProtocolAdapter) => {
    if (purpose === "tts" || purpose === "live") {
      onUpdate(model.id, { protocolAdapter: nextAdapter, voices: defaultVoicesForAdapter(nextAdapter) });
      return;
    }
    if (purpose === "image") {
      const preset = nextAdapter === "openai-image" || nextAdapter === "gemini-image"
        ? getImageModelPreset(nextAdapter, model.id.replace(/^models\//, ""))
        : undefined;
      onUpdate(model.id, {
        protocolAdapter: nextAdapter,
        imageProfile: preset?.profile ?? {
          formats: nextAdapter === "gemini-image" ? ["jpeg", "png"] : ["png", "jpeg", "webp"],
          supportsEdit: true,
          maxReferences: 4,
        },
        imageDefaults: preset?.defaults,
      });
      return;
    }
    onUpdate(model.id, { protocolAdapter: nextAdapter });
  };

  const addCustomVoice = () => {
    const clean = newVoice.trim();
    if (!clean || voices.includes(clean)) {
      setNewVoice("");
      return;
    }
    onUpdate(model.id, { voices: [...voices, clean] });
    setNewVoice("");
  };

  const removeVoice = (target: string) => {
    if (voices.length <= 1) return;
    onUpdate(model.id, { voices: voices.filter((v) => v !== target) });
  };

  const toggleImageFormat = (fmt: MediaOutputFormat) => {
    const allowedByPreset = imagePreset?.profile.formats;
    if (allowedByPreset && !allowedByPreset.includes(fmt)) return;
    const next = imageFormats.includes(fmt)
      ? imageFormats.filter((item) => item !== fmt)
      : [...imageFormats, fmt];
    if (!next.length) return;
    onUpdate(model.id, {
      imageProfile: {
        ...(model.imageProfile ?? imagePreset?.profile ?? { supportsEdit, maxReferences: supportsEdit ? 4 : 0 }),
        formats: next,
      },
    });
  };

  const updateLevel = (m: CustomModelConfig, id: string, patch: Partial<ThinkingLevelOption>) => {
    onUpdate(m.id, { thinkingLevels: getModelThinkingLevels(m, api).map((level) => level.id === id ? { ...level, ...patch } : level) });
  };
  const toggleModality = (m: CustomModelConfig, modality: ModelModality) => {
    const current = getModelModalities(m, knownModel);
    const next = current.includes(modality) ? current.filter((item) => item !== modality) : [...current, modality];
    if (next.length) onUpdate(m.id, { modalities: next, vision: next.includes("image") });
  };

  const purposeOptions: Array<{ id: ModelPurpose; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "image", label: "Image" },
    { id: "tts", label: "TTS" },
    { id: "asr", label: "ASR" },
    { id: "live", label: "Live" },
  ];

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open && !disabled) onClose(); }}>
      <Modal.Backdrop isDismissable={!disabled} isKeyboardDismissDisabled={disabled}>
        <Modal.Container placement="center" size="md" scroll="inside">
          <Modal.Dialog aria-label={model.id + t(" 模型参数", " Model parameters")} className="w-full max-w-[640px] rounded-3xl">
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <Modal.Heading className="min-w-0 flex-1 break-all font-mono font-semibold">{model.id}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭模型参数", "Close model parameters")} className="static" isDisabled={disabled} />
            </Modal.Header>
            <Modal.Body className="kulo-form-stack">
              {allowPurposeChange && (
                <div className={purpose !== "chat" && allowProtocolSelect ? "kulo-form-grid" : "contents"}>
                  <Select
                    className="kulo-form-field"
                    variant="secondary"
                    value={purpose}
                    isDisabled={disabled}
                    onChange={(val) => val && handlePurposeChange(val as ModelPurpose)}
                    fullWidth
                  >
                    <Label className="text-sm text-muted">{t("模型类型", "Model type")}</Label>
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {purposeOptions.map((opt) => (
                          <ListBox.Item key={opt.id} id={opt.id} textValue={opt.label}>
                            {opt.label}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>

                  {purpose !== "chat" && allowProtocolSelect && effectiveAdapter && (
                    <Select
                      className="kulo-form-field"
                      variant="secondary"
                      value={effectiveAdapter}
                      isDisabled={disabled}
                      onChange={(val) => val && handleAdapterChange(val as ModelProtocolAdapter)}
                      fullWidth
                    >
                      <Label className="text-sm text-muted">{t("接口协议", "Protocol")}</Label>
                      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {ADAPTER_OPTIONS_BY_PURPOSE[purpose].map((opt) => (
                            <ListBox.Item key={opt.id} id={opt.id} textValue={opt.label}>
                              {opt.label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  )}
                </div>
              )}

              {purpose === "chat" && (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-foreground">{t("模型参数", "Model parameters")}</span>
                    <Button size="sm" variant="ghost" isDisabled={disabled} onPress={() => {
                      const resetModalities = getModelModalities({}, knownModel);
                      const resetReasoning = knownModel?.reasoning ?? true;
                      onUpdate(model.id, {
                        contextWindow: knownModel?.contextWindow || DEFAULT_MODEL_CONTEXT_WINDOW,
                        maxTokens: knownModel?.maxTokens || DEFAULT_MODEL_MAX_TOKENS,
                        modalities: resetModalities,
                        vision: resetModalities.includes("image"),
                        reasoning: resetReasoning,
                        thinkingEnabled: knownModel?.thinkingEnabled ?? resetReasoning,
                        thinkingLevelMap: knownModel?.thinkingLevelMap,
                        thinkingLevels: getModelThinkingLevels(knownModel ?? {}, api),
                        nativeTools: officialSource && knownModel?.nativeTools ? { ...knownModel.nativeTools } : undefined,
                      });
                    }}>{t("重置参数", "Reset parameters")}</Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-2 text-sm text-muted">{t("输入类型", "Input types")}</span>
                    {MODALITIES.map((modality) => <Button key={modality.value} size="sm" variant={modalities.includes(modality.value) ? "secondary" : "ghost"} aria-pressed={modalities.includes(modality.value)} isDisabled={disabled} onPress={() => toggleModality(model, modality.value)}>{t(modality.label, { text: "Text", image: "Image", audio: "Audio", video: "Video", pdf: "PDF" }[modality.value])}</Button>)}
                  </div>
                  <div className="kulo-form-grid">
                    <NumberField className="kulo-form-field" variant="secondary" aria-label={model.id + t(" 上下文窗口", " Context window")} value={ctxK} minValue={4} maxValue={10000} step={1} isDisabled={disabled} onChange={(value) => {
                      if (Number.isFinite(value)) onUpdate(model.id, { contextWindow: Math.round(value * 1000) });
                    }} fullWidth>
                      <Label className="text-sm text-muted">{t("上下文窗口 (K)", "Context window (K)")}</Label>
                      <NumberField.Group><NumberField.DecrementButton /><NumberField.Input className="min-w-0 px-2 text-sm tabular-nums" /><NumberField.IncrementButton /></NumberField.Group>
                    </NumberField>
                    <NumberField className="kulo-form-field" variant="secondary" aria-label={model.id + t(" 最大输出", " Max output")} value={maxK} minValue={1} maxValue={1000} step={1} isDisabled={disabled} onChange={(value) => {
                      if (Number.isFinite(value)) onUpdate(model.id, { maxTokens: Math.round(value * 1000) });
                    }} fullWidth>
                      <Label className="text-sm text-muted">{t("最大输出 (K)", "Max output (K)")}</Label>
                      <NumberField.Group><NumberField.DecrementButton /><NumberField.Input className="min-w-0 px-2 text-sm tabular-nums" /><NumberField.IncrementButton /></NumberField.Group>
                    </NumberField>
                  </div>
                  <ModelNativeToolsFields model={model} api={knownModel?.api ?? api} disabled={disabled} officialSource={officialSource} presetId={presetId} onUpdate={onUpdate} />
                  <Switch className="w-full" aria-label={model.id + t(" 思考强度", " Thinking effort")} isSelected={model.thinkingEnabled ?? model.reasoning ?? true} isDisabled={disabled} onChange={(selected) => onUpdate(model.id, { ...(selected ? { reasoning: true } : {}), thinkingEnabled: selected, thinkingLevels: levels })}>
                    <Switch.Content className="kulo-form-toggle">
                      <Label className="text-sm font-medium">{t("思考强度", "Thinking effort")}</Label>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch.Content>
                  </Switch>
                  {(model.thinkingEnabled ?? model.reasoning ?? true) && <div className="flex flex-col gap-2">
                    <div className="kulo-thinking-level-row px-1 text-xs font-medium text-muted" aria-hidden="true"><span>{t("显示名称", "Display name")}</span><span>{t("映射值", "Mapped value")}</span><span /></div>
                    {levels.map((level, index) => <div key={level.id} className="kulo-thinking-level-row">
                      <TextField className="kulo-context-field" variant="secondary" aria-label={t("档位 ", "Level ") + (index + 1) + t(" 显示名称", " Display name")} value={level.label} onChange={(label) => updateLevel(model, level.id, { label })} isDisabled={disabled} maxLength={80} fullWidth><Input /></TextField>
                      <TextField className="kulo-context-field" variant="secondary" aria-label={t("档位 ", "Level ") + (index + 1) + t(" 映射值", " Mapped value")} value={level.value} onChange={(value) => updateLevel(model, level.id, { value })} isDisabled={disabled} maxLength={64} fullWidth><Input className="font-mono text-sm " /></TextField>
                      <Button isIconOnly size="sm" variant="ghost" aria-label={t("删除档位 ", "Remove level ") + (index + 1)} isDisabled={disabled || levels.length <= 1} onPress={() => onUpdate(model.id, { thinkingLevels: levels.filter((item) => item.id !== level.id) })}><KuloIcon name="close" size={16} /></Button>
                    </div>)}
                    <Button size="sm" variant="ghost" className="self-start" isDisabled={disabled} onPress={() => onUpdate(model.id, { thinkingLevels: [...levels, { id: "custom-" + crypto.randomUUID(), label: "", value: "" }] })}>
                      <KuloIcon name="add" size={16} />{t("添加档位", "Add level")}
                    </Button>
                  </div>}
                </>
              )}

              {purpose === "image" && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-2 text-sm text-muted">{t("输出格式", "Output formats")}</span>
                    {IMAGE_FORMATS.map((fmt) => {
                      const allowedByPreset = imagePreset?.profile.formats;
                      const lockedOut = Boolean(allowedByPreset && !allowedByPreset.includes(fmt));
                      const active = imageFormats.includes(fmt);
                      return (
                        <Button
                          key={fmt}
                          size="sm"
                          variant={active ? "secondary" : "ghost"}
                          aria-pressed={active}
                          isDisabled={disabled || lockedOut}
                          onPress={() => toggleImageFormat(fmt)}
                        >
                          {fmt.toUpperCase()}
                        </Button>
                      );
                    })}
                  </div>
                  <Switch
                    className="w-full"
                    aria-label={model.id + t(" 参考图编辑", " Reference image editing")}
                    isSelected={supportsEdit}
                    isDisabled={disabled || imagePreset?.profile.supportsEdit === false}
                    onChange={(nextEdit) => {
                      onUpdate(model.id, {
                        imageProfile: {
                          ...(model.imageProfile ?? imagePreset?.profile ?? { formats: imageFormats }),
                          formats: imageFormats,
                          supportsEdit: nextEdit,
                          maxReferences: nextEdit ? (imagePreset?.profile.maxReferences ?? 4) : 0,
                        },
                      });
                    }}
                  >
                    <Switch.Content className="kulo-form-toggle">
                      <Label className="text-sm font-medium">{t("参考图编辑", "Reference image editing")}</Label>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch.Content>
                  </Switch>
                </>
              )}

              {(purpose === "tts" || purpose === "live") && (
                <section aria-label={model.id + t(" 音色", " Voices")} className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="kulo-group-title">{t("音色", "Voices")}</h3>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={disabled}
                      onPress={() => onUpdate(model.id, { voices: defaultVoicesForAdapter(effectiveAdapter) })}
                    >
                      {t("恢复默认", "Reset")}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {voices.map((voice) => (
                      <Button
                        key={voice}
                        size="sm"
                        variant="secondary"
                        aria-label={t(`删除音色 ${voice}`, `Remove voice ${voice}`)}
                        isDisabled={disabled || voices.length <= 1}
                        onPress={() => removeVoice(voice)}
                      >
                        <span className="font-mono text-xs">{voice}</span>
                        <KuloIcon name="close" size={14} />
                      </Button>
                    ))}
                  </div>
                  <div className="kulo-field-action-row">
                    <TextField
                      className="kulo-context-field min-w-0 flex-1"
                      variant="secondary"
                      aria-label={t("添加自定义音色 ID", "Add custom voice ID")}
                      value={newVoice}
                      onChange={setNewVoice}
                      isDisabled={disabled}
                      maxLength={120}
                      fullWidth
                    >
                      <Input
                        placeholder={t("输入音色 ID…", "Enter voice ID…")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            addCustomVoice();
                          }
                        }}
                      />
                    </TextField>
                    <Button size="sm" variant="secondary" isDisabled={disabled || !newVoice.trim()} onPress={addCustomVoice}>
                      <KuloIcon name="add" size={16} />{t("添加", "Add")}
                    </Button>
                  </div>
                </section>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="primary" isDisabled={disabled} onPress={onClose}>{t("完成", "Done")}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function AddedModelsPane({ compact, models, total, allAddedModels, availableModels, api, expandedId, onExpandedChange,
  search, onSearch, disabled, manualModelId, onManualModelIdChange, onAddManual, onUpdate, onRemove,
  purposeFilter, onPurposeFilterChange, allowPurposeChange = true, allowProtocolSelect = false,
  officialSource = true, presetId,
}: {
  compact: boolean; models: CustomModelConfig[]; total: number; allAddedModels?: CustomModelConfig[];
  availableModels: ProviderModelItem[];
  api: CustomProviderApi; expandedId: string | null; onExpandedChange: (id: string | null) => void;
  search: string; onSearch: (value: string) => void; disabled: boolean; manualModelId: string;
  onManualModelIdChange: (value: string) => void; onAddManual: () => void;
  onUpdate: (id: string, patch: Partial<CustomModelConfig>) => void; onRemove: (id: string) => void;
  purposeFilter?: ModelPurposeFilter;
  onPurposeFilterChange?: (value: ModelPurposeFilter) => void;
  allowPurposeChange?: boolean;
  allowProtocolSelect?: boolean;
  officialSource?: boolean;
  presetId?: string;
}) {
  const { t } = useI18n();
  const expandedModel = (allAddedModels ?? models).find((model) => model.id === expandedId);
  return (
    <>
    <ModelListPanel
      title={t("已添加模型", "Added models")} count={total} compact={compact}
      search={<SearchField className="kulo-context-field" variant="primary" aria-label={t("筛选已添加模型", "Filter added models")} isDisabled={disabled} value={search} onChange={onSearch} fullWidth>
        <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder={t("筛选已添加…", "Filter added models…")} /><SearchField.ClearButton /></SearchField.Group>
      </SearchField>}
      filter={purposeFilter && onPurposeFilterChange
        ? <ModelPurposeFilterTabs label={t("按类型筛选已添加模型", "Filter added models by type")} value={purposeFilter} onChange={onPurposeFilterChange} />
        : undefined}
      footer={<div className="flex items-center gap-2">
        <TextField variant="primary" aria-label={t("手动添加模型名称", "Add a model manually")} isDisabled={disabled} value={manualModelId} onChange={onManualModelIdChange} className="kulo-context-field min-w-0 flex-1" fullWidth>
          <Input placeholder={t("输入模型 ID…", "Enter a model ID…")} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onAddManual(); }
          }} />
        </TextField>
        <Button size="sm" variant="secondary" isDisabled={disabled || !manualModelId.trim()} onPress={onAddManual}>
          <KuloIcon name="add" size={16} />{t("添加", "Add")}
        </Button>
      </div>}
    >
      <div className="kulo-table-header kulo-model-column-head kulo-added-model-columns">
        <span aria-hidden="true" /><span>{t("模型", "Model")}</span><span className="text-right">{t("规格", "Spec")}</span><span className="sr-only">{t("移除", "Remove")}</span>
      </div>
      <div className="kulo-model-pane-scroll">
        {models.length === 0 ? <div className="kulo-model-empty">{total === 0 ? t("暂未添加模型", "No models added") : t("没有匹配的已添加模型", "No matching added models")}</div>
          : <ul aria-label={t("已添加模型列表", "Added models")} className="m-0 list-none p-2">
            {models.map((model) => {
              const purpose = inferModelPurpose(model);
              return (
                <li key={model.id} className="flex min-h-12 items-center gap-2 rounded-xl px-2 transition-colors hover:bg-surface-tertiary motion-reduce:transition-none">
                  <Button
                    variant="ghost"
                    className="kulo-added-model-trigger px-0"
                    aria-haspopup="dialog"
                    aria-expanded={expandedId === model.id}
                    isDisabled={disabled}
                    onPress={() => onExpandedChange(model.id)}
                  >
                    <KuloIcon name="chevron-right" size={16} className="text-muted" />
                    <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground" title={model.id}>{model.id}</span>
                    {purpose === "chat"
                      ? <span className="text-right text-sm font-normal tabular-nums text-muted">{contextLabel(model)}</span>
                      : <span className="flex justify-end"><Chip size="sm" variant="soft">{purposeBadgeLabel(purpose)}</Chip></span>}
                  </Button>
                  <Button isIconOnly size="sm" variant="ghost" aria-label={t(`移除 ${model.id}`, `Remove ${model.id}`)} isDisabled={disabled} onPress={() => onRemove(model.id)}>
                    <KuloIcon name="close" size={16} />
                  </Button>
                </li>
              );
            })}
          </ul>}
      </div>
    </ModelListPanel>
    <ModelParametersDialog
      model={expandedModel}
      availableModels={availableModels}
      api={api}
      disabled={disabled}
      allowPurposeChange={allowPurposeChange}
      allowProtocolSelect={allowProtocolSelect}
      officialSource={officialSource}
      presetId={presetId}
      onUpdate={onUpdate}
      onClose={() => onExpandedChange(null)}
    />
    </>
  );
}
