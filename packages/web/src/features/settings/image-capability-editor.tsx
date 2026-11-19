import { useEffect, useRef, useState } from "react";
import { Button, Card, Checkbox, CheckboxGroup, ComboBox, Disclosure, Input, Label, ListBox, Radio, RadioGroup } from "@heroui/react";
import {
  IMAGE_MODEL_PRESETS, getImageModelPreset, normalizeImageGenerationParameters, validateCustomImageAdapter, validateImageModelProfile,
  type CapabilitiesWorkspaceSnapshot, type CapabilityRecord, type CustomImageAdapter, type ImageCapabilityConfiguration,
  type ImageCapabilityDraft, type ImageGenerationParameters, type ImageModelProfile, type ImageParameterDefinition,
  type ImageProviderConnection, type MediaAdapterId, type MediaOutputFormat,
} from "@moco/protocol";
import { MocoApiError, mocoRest } from "../../moco-api";
import { useI18n } from "../../moco-i18n";
import { CapabilitySetupInputs, safeSetupInputError } from "./capability-setup-inputs";
import { ImageNumber, ImageSelect, ImageText, ImageToggle } from "./image-fields";
import { imageActionError, imageCommandId, type ImageConfigurationCardProps } from "./image-provider-picker";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const outputFormats: MediaOutputFormat[] = ["png", "jpeg", "webp", "gif", "svg"];
const fallbackProfile: ImageModelProfile = { formats: [], supportsEdit: false, maxReferences: 0 };
const customAdapterTemplate: CustomImageAdapter = {
  auth: { type: "bearer" }, generate: { path: "images/generations", body: { model: "{{model}}", prompt: "{{prompt}}" } },
  response: { imagesPath: "data", base64Path: "b64_json" },
};

const isOfficialOpenAi = (url: string | undefined): boolean => {
  try { return Boolean(url) && new URL(url!).origin === "https://api.openai.com"; }
  catch { return false; }
};

export function createImageDraftConfig(workspace: CapabilitiesWorkspaceSnapshot): ImageCapabilityConfiguration {
  const provider = workspace.imageSetup?.providers.find((item) => item.authType === "api_key" && item.authenticated && item.imageSupported && item.baseUrl);
  const adapter = provider?.api === "google-generative-ai" ? "gemini-image" : "openai-image";
  const preset = IMAGE_MODEL_PRESETS.find((item) => item.adapter === adapter && item.modelId === (adapter === "gemini-image" ? "gemini-nano-banana-2.1" : "gpt-image-2.6-flare"))!;
  const usePreset = !provider || adapter === "gemini-image" || isOfficialOpenAi(provider.baseUrl);
  return {
    name: usePreset ? preset.name : "",
    adapter,
    baseUrl: provider?.baseUrl ?? preset.baseUrl,
    modelId: usePreset ? preset.modelId : "",
    credentialProviderId: provider?.id ?? null,
    enabled: true,
    allowTaskGeneration: true,
    maxOutputs: 1,
    ...(usePreset ? { imageProfile: clone(preset.profile), defaults: clone(preset.defaults) } : { defaults: {} }),
  };
}

export function imageConfigFromCapability(workspace: CapabilitiesWorkspaceSnapshot, capability: CapabilityRecord): ImageCapabilityConfiguration {
  const connection = workspace.connections.find((item) => item.id === capability.connectionId);
  if (!connection) throw new Error("图像服务连接不存在。");
  return { id: capability.id, expectedRevision: capability.revision, name: capability.name, adapter: connection.adapter,
    baseUrl: connection.baseUrl, modelId: capability.modelId, credentialProviderId: connection.credentialProviderId,
    enabled: capability.enabled, isDefault: capability.isDefault, allowTaskGeneration: capability.allowTaskGeneration, maxOutputs: capability.maxOutputs,
    imageProfile: capability.imageProfile, defaults: capability.defaults, routing: capability.routing, customAdapter: connection.customAdapter };
}

export function reloadImageDraftConfiguration(workspace: CapabilitiesWorkspaceSnapshot, draft: ImageCapabilityDraft): ImageCapabilityConfiguration {
  if (!draft.config.id) return clone(draft.config);
  const capability = workspace.capabilities.find((item) => item.id === draft.config.id);
  if (!capability) throw new Error("此图像模型已被移除，请取消草稿后重新添加。");
  return capability.revision === draft.config.expectedRevision ? clone(draft.config) : imageConfigFromCapability(workspace, capability);
}

export function applyImageModelPreset(config: ImageCapabilityConfiguration, modelId: string, keepEndpoint = false): ImageCapabilityConfiguration {
  const preset = IMAGE_MODEL_PRESETS.find((item) => item.modelId === modelId);
  if (!preset) return { ...config, modelId, imageProfile: undefined, defaults: {} };
  const previous = IMAGE_MODEL_PRESETS.find((item) => item.modelId === config.modelId);
  return { ...config, modelId, adapter: preset.adapter, name: !config.name || config.name === previous?.name ? preset.name : config.name,
    baseUrl: keepEndpoint ? config.baseUrl : preset.baseUrl, imageProfile: clone(preset.profile), defaults: clone(preset.defaults),
    customAdapter: undefined };
}

export function mergeImageGenerationParameters(parameters: ImageGenerationParameters, changes: Partial<ImageGenerationParameters>): ImageGenerationParameters {
  const next = { ...parameters, ...changes };
  if (changes.format && next.background === "transparent" && !["png", "webp"].includes(changes.format)) next.background = "auto";
  if (next.background === "transparent" && !["png", "webp"].includes(next.format ?? "")) next.format = "png";
  if (next.format !== "gif") { delete next.frameCount; delete next.frameDurationMs; }
  if (next.format !== "svg") { delete next.svgModel; delete next.svgReasoning; }
  if (next.format === "svg") next.count = 1;
  if (next.format !== "jpeg" && next.format !== "webp") delete next.outputCompression;
  return next;
}

function ImageJsonField<T>({ label, value, onChange, disabled, onValidityChange }: {
  label: string; value: T; onChange: (value: T) => void; disabled: boolean; onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const encoded = JSON.stringify(value, null, 2);
  const [text, setText] = useState(encoded);
  const [validationError, setValidationError] = useState<string>();
  const applied = useRef(encoded);
  const validityCallback = useRef(onValidityChange);
  validityCallback.current = onValidityChange;
  useEffect(() => () => { validityCallback.current?.(true); }, []);
  useEffect(() => { if (encoded !== applied.current) { applied.current = encoded; setText(encoded); setValidationError(undefined); onValidityChange?.(true); } }, [encoded]);
  return <div className="flex min-w-0 flex-col gap-2">
    <ImageText label={label} value={text} disabled={disabled} multiline onChange={(next) => {
      setText(next);
      try {
        const parsed = JSON.parse(next) as T;
        onChange(parsed);
        applied.current = JSON.stringify(parsed, null, 2); setValidationError(undefined); onValidityChange?.(true);
      } catch (cause) {
        setValidationError(cause instanceof SyntaxError ? t("JSON 格式无效", "Invalid JSON") : imageActionError(cause)); onValidityChange?.(false);
      }
    }} />
    {validationError && <p className="text-xs text-danger" role="alert">{validationError}</p>}
  </div>;
}

function ImageCustomParameter({ field, value, disabled, onChange }: { field: ImageParameterDefinition; value: unknown; disabled: boolean; onChange: (value: string | number | boolean | undefined) => void }) {
  const { t } = useI18n();
  if (field.enum) return <ImageSelect label={field.label} value={value === undefined ? "__default" : String(value)} disabled={disabled}
    options={[{ id: "__default", label: t("默认", "Default") }, ...field.enum.map((item) => ({ id: String(item), label: String(item) }))]}
    onChange={(next) => onChange(next === "__default" ? undefined : field.enum!.find((item) => String(item) === next))} />;
  if (field.type === "boolean") return <ImageToggle label={field.label} value={value === true} disabled={disabled} onChange={onChange} />;
  if (field.type === "number") return <ImageNumber label={field.label} value={typeof value === "number" ? value : undefined} minimum={field.minimum ?? -1_000_000} maximum={field.maximum ?? 1_000_000} disabled={disabled} onChange={onChange} />;
  return <ImageText label={field.label} value={typeof value === "string" ? value : ""} required={field.required} disabled={disabled} onChange={onChange} />;
}

export function ImageCapabilityFields({ config, providers, onChange, apiKey, onApiKeyChange, canKeepSavedKey = false, disabled = false, onValidityChange }: {
  config: ImageCapabilityConfiguration;
  providers: ImageProviderConnection[];
  onChange: (config: ImageCapabilityConfiguration) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  canKeepSavedKey?: boolean;
  disabled?: boolean;
  onValidityChange?: (valid: boolean, field?: string) => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<"existing" | "api" | "subscription">(config.credentialProviderId ? "existing" : "api");
  const validityCallback = useRef(onValidityChange);
  validityCallback.current = onValidityChange;
  const profile = config.imageProfile ?? getImageModelPreset(config.adapter, config.modelId)?.profile;
  const customModel = config.adapter === "custom-image" || !getImageModelPreset(config.adapter, config.modelId);
  const parameters = config.defaults ?? {};
  const updateParameters = (changes: Partial<ImageGenerationParameters>) => onChange({ ...config, defaults: mergeImageGenerationParameters(parameters, changes) });
  useEffect(() => { if (config.credentialProviderId) setSource("existing"); }, [config.credentialProviderId]);
  useEffect(() => {
    const sourceValid = source === "api" || (source === "existing" && Boolean(config.credentialProviderId));
    validityCallback.current?.(sourceValid, "source");
  }, [source, config.credentialProviderId]);
  const selectProvider = (id: string) => {
    const provider = providers.find((item) => item.id === id);
    if (!provider?.authenticated || !provider.baseUrl || !provider.imageSupported && config.adapter !== "custom-image") return;
    if (config.adapter === "custom-image") { onChange({ ...config, credentialProviderId: id, baseUrl: provider.baseUrl }); onApiKeyChange(""); return; }
    const adapter: MediaAdapterId = provider.api === "google-generative-ai" ? "gemini-image" : "openai-image";
    const usePreset = adapter === "gemini-image" || isOfficialOpenAi(provider.baseUrl);
    const preset = getImageModelPreset(adapter, config.modelId) ?? (usePreset ? IMAGE_MODEL_PRESETS.find((item) => item.adapter === adapter) : undefined);
    if (preset) {
      onChange({ ...config, adapter, credentialProviderId: id, baseUrl: provider.baseUrl, modelId: preset.modelId,
        name: !config.name || config.name === IMAGE_MODEL_PRESETS.find((item) => item.modelId === config.modelId)?.name ? preset.name : config.name,
        imageProfile: clone(preset.profile), defaults: clone(preset.defaults), customAdapter: undefined });
    } else {
      onChange({ ...config, adapter, credentialProviderId: id, baseUrl: provider.baseUrl, modelId: "",
        name: IMAGE_MODEL_PRESETS.some((item) => item.name === config.name) ? "" : config.name,
        imageProfile: undefined, defaults: {}, customAdapter: undefined });
    }
    onApiKeyChange("");
  };
  const modelOptions = IMAGE_MODEL_PRESETS.some((item) => item.modelId === config.modelId) ? IMAGE_MODEL_PRESETS : IMAGE_MODEL_PRESETS.filter((item) => !config.modelId || `${item.modelId} ${item.name}`.toLowerCase().includes(config.modelId.toLowerCase()));
  return <div className="moco-form-stack">
    <RadioGroup aria-label={t("接入方式", "Connection method")} value={source} onChange={(value) => {
      if (!["existing", "api", "subscription"].includes(value)) return;
      const next = value as typeof source; setSource(next); onApiKeyChange("");
      if (next === "api") onChange({ ...config, credentialProviderId: null });
      if (next === "existing") { const provider = providers.find((item) => (item.imageSupported || config.adapter === "custom-image") && item.authenticated && item.authType === "api_key"); if (provider) selectProvider(provider.id); }
    }} isDisabled={disabled} className="flex flex-wrap gap-3">
      {[{ id: "existing", label: t("使用现有连接", "Use existing connection") }, { id: "api", label: t("新增 API 连接", "New API connection") }, { id: "subscription", label: t("订阅授权", "Subscription authorization") }].map((item) => <Radio key={item.id} value={item.id}><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{item.label}</Radio.Content></Radio>)}
    </RadioGroup>
    {source === "subscription" ? <div className="flex flex-col gap-2" role="status">
      <p className="text-sm">{t("当前订阅授权未提供可接入的生图接口", "No image endpoint is available through current subscription authorization")}</p>
      {providers.filter((provider) => provider.authType === "oauth").map((provider) => <p key={provider.id} className="break-words text-xs text-muted">{provider.name} · {provider.reason ?? t("此授权暂不支持生图", "Image generation is unavailable with this authorization")}</p>)}
    </div> : <>
      {source === "existing" && <>
        <ImageSelect label={t("服务连接", "Service connection")} value={config.credentialProviderId ?? ""} disabled={disabled} onChange={selectProvider}
          options={providers.filter((provider) => provider.authType === "api_key").map((provider) => ({ id: provider.id, label: provider.name, disabled: !provider.authenticated || !provider.imageSupported && config.adapter !== "custom-image" }))} />
        {!providers.some((provider) => (provider.imageSupported || config.adapter === "custom-image") && provider.authenticated && provider.authType === "api_key") && <p className="text-xs text-warning" role="status">{t("暂无可复用的 API 连接", "No reusable API connections")}</p>}
      </>}
      <ComboBox className="moco-form-field" variant="primary" inputValue={config.modelId} selectedKey={IMAGE_MODEL_PRESETS.some((item) => item.modelId === config.modelId) ? config.modelId : null} allowsCustomValue menuTrigger="focus" defaultFilter={() => true} isDisabled={disabled} isRequired
        onInputChange={(modelId) => { if (modelId !== config.modelId) onChange(applyImageModelPreset(config, modelId, source === "existing")); }}
        onSelectionChange={(modelId) => { if (modelId !== null && modelId !== config.modelId) onChange(applyImageModelPreset(config, String(modelId), source === "existing")); }}>
        <Label>{t("图像模型", "Image model")}</Label><ComboBox.InputGroup><Input placeholder={t("选择预设或输入模型 ID", "Choose a preset or enter a model ID")} spellCheck={false} /><ComboBox.Trigger aria-label={t("展开图像模型预设", "Open image model presets")} /></ComboBox.InputGroup>
        <ComboBox.Popover><ListBox renderEmptyState={() => <span className="p-3 text-sm text-muted">{t("使用输入的模型 ID", "Use the entered model ID")}</span>}>{modelOptions.map((preset) => <ListBox.Item key={preset.modelId} id={preset.modelId} textValue={preset.modelId}><span className="flex flex-col gap-1"><span>{preset.name}</span><span className="text-xs text-muted">{preset.modelId}</span></span><ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></ComboBox.Popover>
      </ComboBox>
      <ImageText label={t("显示名称", "Display name")} value={config.name} onChange={(name) => onChange({ ...config, name })} disabled={disabled} required />
      {source === "api" && <>
        <ImageText label={t("接口地址", "API URL")} value={config.baseUrl ?? ""} type="url" onChange={(baseUrl) => onChange({ ...config, baseUrl })} disabled={disabled} required />
        {config.customAdapter?.auth.type !== "none" && <ImageText label="API Key" type="password" value={apiKey} onChange={onApiKeyChange} disabled={disabled} placeholder={canKeepSavedKey ? t("留空保留已保存的密钥", "Leave blank to keep the saved key") : t("输入 API Key", "Enter an API key")} />}
      </>}
      <ImageSelect label={t("接口协议", "API protocol")} value={config.adapter} disabled={disabled} onChange={(adapter) => {
        if (!["openai-image", "gemini-image", "custom-image"].includes(adapter)) return;
        onChange({ ...config, adapter: adapter as MediaAdapterId,
          imageProfile: getImageModelPreset(adapter as MediaAdapterId, config.modelId)?.profile ?? config.imageProfile ?? (adapter === "custom-image" ? clone(fallbackProfile) : undefined),
          defaults: getImageModelPreset(adapter as MediaAdapterId, config.modelId)?.defaults ?? {},
          customAdapter: adapter === "custom-image" ? config.customAdapter ?? clone(customAdapterTemplate) : undefined });
      }} options={[{ id: "openai-image", label: "OpenAI Images" }, { id: "gemini-image", label: "Gemini Images" }, { id: "custom-image", label: t("自定义接口", "Custom API") }]} />
      {customModel && <div className="moco-form-stack">
        <h3 className="moco-group-title">{t("模型能力", "Model capabilities")}</h3>
        <CheckboxGroup className="moco-form-field" value={(profile ?? fallbackProfile).formats} isDisabled={disabled} onChange={(formats) => onChange({ ...config, imageProfile: { ...(profile ?? fallbackProfile), formats: formats as MediaOutputFormat[] }, defaults: {} })}>
          <Label>{t("输出格式", "Output formats")}</Label><div className="flex flex-wrap gap-3">{outputFormats.map((format) => <Checkbox key={format} value={format} variant="primary"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{format.toUpperCase()}</Checkbox.Content></Checkbox>)}</div>
        </CheckboxGroup>
        <ImageToggle label={t("支持图片编辑", "Supports image editing")} value={profile?.supportsEdit ?? false} disabled={disabled} onChange={(supportsEdit) => onChange({ ...config, imageProfile: { ...(profile ?? fallbackProfile), supportsEdit } })} />
        <ImageNumber label={t("参考图上限", "Reference image limit")} value={profile?.maxReferences ?? 0} minimum={0} maximum={16} disabled={disabled} onChange={(maxReferences) => onChange({ ...config, imageProfile: { ...(profile ?? fallbackProfile), maxReferences: maxReferences ?? 0 } })} />
      </div>}
      {profile && profile.formats.length > 0 && <div className="moco-form-stack">
        <h3 className="moco-group-title">{t("默认生成参数", "Default generation parameters")}</h3>
        <div className="moco-form-grid">
          <ImageSelect label={t("输出格式", "Output format")} value={parameters.format ?? profile.formats[0] ?? "png"} options={profile.formats.map((format) => ({ id: format, label: format.toUpperCase() }))} disabled={disabled} onChange={(format) => updateParameters({ format: format as MediaOutputFormat })} />
          <ImageNumber label={t("图片数量", "Image count")} value={parameters.count ?? 1} maximum={config.adapter === "gemini-image" || parameters.format === "svg" ? 1 : config.maxOutputs ?? 1} disabled={disabled} onChange={(count) => updateParameters({ count })} />
          {Boolean(profile.aspectRatios?.length) && <ImageSelect label={t("画面比例", "Aspect ratio")} value={parameters.aspectRatio ?? "__default"} options={[{ id: "__default", label: t("跟随任务", "Follow task") }, ...profile.aspectRatios!.map((ratio) => ({ id: ratio, label: ratio === "auto" ? t("自动", "Auto") : ratio }))]} disabled={disabled} onChange={(aspectRatio) => updateParameters({ aspectRatio: aspectRatio === "__default" ? undefined : aspectRatio })} />}
          {Boolean(profile.sizes?.length) && <ImageText label={t("图片尺寸", "Image size")} value={parameters.size ?? ""} disabled={disabled} placeholder={profile.sizes!.join(" / ")} onChange={(size) => updateParameters({ size: size || undefined })} />}
          {Boolean(profile.qualities?.length) && <ImageSelect label={t("渲染质量", "Rendering quality")} value={parameters.quality ?? "auto"} options={profile.qualities!.map((quality) => ({ id: quality, label: quality === "auto" ? t("自动", "Auto") : quality }))} disabled={disabled} onChange={(quality) => updateParameters({ quality })} />}
          {profile.supportsTransparency && <ImageSelect label={t("背景", "Background")} value={parameters.background ?? "auto"} options={[{ id: "auto", label: t("自动", "Auto") }, { id: "opaque", label: t("不透明", "Opaque") }, { id: "transparent", label: t("透明", "Transparent") }]} disabled={disabled} onChange={(background) => updateParameters({ background: background as ImageGenerationParameters["background"] })} />}
        </div>
        <Disclosure>
          <Disclosure.Heading><Button slot="trigger" variant="ghost" className="justify-start" size="sm">{t("高级设置", "Advanced settings")}<Disclosure.Indicator /></Button></Disclosure.Heading>
          <Disclosure.Content><Disclosure.Body className="moco-form-stack pt-3">
            {profile.supportsComplexity && <ImageSelect label={t("规划复杂度", "Planning complexity")} value={parameters.complexity ?? "__default"} options={[{ id: "__default", label: t("模型默认", "Model default") }, ...["low", "medium", "high"].map((id) => ({ id, label: id }))]} disabled={disabled} onChange={(complexity) => updateParameters({ complexity: complexity === "__default" ? undefined : complexity as ImageGenerationParameters["complexity"] })} />}
            {Boolean(profile.thinkingLevels?.length) && <ImageSelect label={t("思考强度", "Thinking level")} value={parameters.thinkingLevel ?? "__default"} options={[{ id: "__default", label: t("模型默认", "Model default") }, ...profile.thinkingLevels!.map((id) => ({ id, label: id }))]} disabled={disabled} onChange={(thinkingLevel) => updateParameters({ thinkingLevel: thinkingLevel === "__default" ? undefined : thinkingLevel })} />}
            {profile.supportsGrounding && <ImageToggle label={t("搜索增强", "Search grounding")} value={parameters.grounding ?? false} disabled={disabled} onChange={(grounding) => updateParameters({ grounding })} />}
            {(parameters.format === "jpeg" || parameters.format === "webp") && <ImageNumber label={t("压缩质量（%）", "Compression quality (%)")} value={parameters.outputCompression ?? 100} minimum={0} disabled={disabled} onChange={(outputCompression) => updateParameters({ outputCompression })} />}
            {parameters.format === "gif" && <div className="moco-form-grid"><ImageNumber label={t("帧数", "Frames")} value={parameters.frameCount ?? 9} minimum={2} maximum={16} disabled={disabled} onChange={(frameCount) => updateParameters({ frameCount })} /><ImageNumber label={t("帧间隔（毫秒）", "Frame duration (ms)")} value={parameters.frameDurationMs ?? 200} minimum={20} maximum={655350} step={10} disabled={disabled} onChange={(frameDurationMs) => updateParameters({ frameDurationMs })} /></div>}
            {parameters.format === "svg" && <><ImageText label={t("矢量创作模型（可选）", "SVG author model (optional)")} value={parameters.svgModel ?? ""} disabled={disabled} onChange={(svgModel) => updateParameters({ svgModel: svgModel || undefined, ...(svgModel ? {} : { svgReasoning: undefined }) })} />{parameters.svgModel && <ImageSelect label={t("矢量思考强度", "SVG reasoning")} value={parameters.svgReasoning ?? "__default"} options={[{ id: "__default", label: t("模型默认", "Model default") }, ...["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }))]} disabled={disabled} onChange={(svgReasoning) => updateParameters({ svgReasoning: svgReasoning === "__default" ? undefined : svgReasoning })} />}</>}
            {(profile.parameters ?? []).map((field) => <ImageCustomParameter key={field.key} field={field} value={parameters.custom?.[field.key] ?? field.default} disabled={disabled} onChange={(value) => {
              const custom = { ...parameters.custom }; if (value === undefined) delete custom[field.key]; else custom[field.key] = value; updateParameters({ custom });
            }} />)}
            <ImageJsonField label={t("能力与参数声明（JSON）", "Capability and parameter schema (JSON)")} value={profile} disabled={disabled} onValidityChange={(valid) => onValidityChange?.(valid, "profile")} onChange={(imageProfile) => onChange({ ...config, imageProfile: validateImageModelProfile(imageProfile) })} />
          </Disclosure.Body></Disclosure.Content>
        </Disclosure>
      </div>}
      {config.adapter === "custom-image" && <ImageJsonField label={t("请求与响应映射（JSON）", "Request and response mapping (JSON)")} value={config.customAdapter ?? customAdapterTemplate} disabled={disabled} onValidityChange={(valid) => onValidityChange?.(valid, "adapter")} onChange={(customAdapter) => onChange({ ...config, customAdapter: validateCustomImageAdapter(customAdapter) })} />}
      <div className="moco-form-stack">
        <h3 className="moco-group-title">{t("使用规则", "Usage rules")}</h3>
        <ImageToggle label={t("启用模型", "Enable model")} value={config.enabled ?? true} onChange={(enabled) => onChange({ ...config, enabled })} disabled={disabled} />
        <ImageToggle label={t("设为默认图像模型", "Set as default image model")} value={config.isDefault ?? false} onChange={(isDefault) => onChange({ ...config, isDefault })} disabled={disabled} />
        <ImageToggle label={t("允许 Moco 在任务中调用", "Allow Moco to use in tasks")} value={config.allowTaskGeneration ?? true} onChange={(allowTaskGeneration) => onChange({ ...config, allowTaskGeneration })} disabled={disabled} />
        <ImageNumber label={t("单次图片上限", "Maximum images per job")} value={config.maxOutputs ?? 1} maximum={8} onChange={(maxOutputs) => onChange({ ...config, maxOutputs: maxOutputs ?? 1 })} disabled={disabled} />
        <ImageText label={t("适用任务", "Preferred tasks")} value={config.routing?.useCases?.join("、") ?? ""} onChange={(value) => onChange({ ...config, routing: { ...config.routing, useCases: value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) } })} disabled={disabled} placeholder={t("产品图、文字排版、快速草稿", "Product images, typography, quick drafts")} />
        <ImageText label={t("调用偏好", "Model selection guidance")} value={config.routing?.instructions ?? ""} onChange={(instructions) => onChange({ ...config, routing: { ...config.routing, instructions } })} disabled={disabled} multiline />
      </div>
    </>}
  </div>;
}

export function ImageCapabilityEditor({ workspace, clientId, connected, disabled = false, onChanged, onClose }: ImageConfigurationCardProps) {
  const incoming = workspace.imageSetup?.draft;
  const remembered = useRef<ImageCapabilityDraft | undefined>(undefined);
  if (incoming?.clientId === clientId) remembered.current = incoming;
  const active = incoming?.clientId === clientId ? incoming : remembered.current?.clientId === clientId ? remembered.current : undefined;
  if (!active) return null;
  return <SharedImageCapabilityEditor key={`${clientId}:${active.id}`} {...{ workspace, clientId, connected, disabled, onChanged, onClose }} initial={active} />;
}

export function SharedImageCapabilityEditor({ workspace, clientId, connected, disabled = false, onChanged, onClose, initial }: ImageConfigurationCardProps & { initial: ImageCapabilityDraft }) {
  const { t } = useI18n();
  const incoming = workspace.imageSetup?.draft;
  const [config, setConfig] = useState(() => clone(initial.config));
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "cancel" | "reload">();
  const [syncing, setSyncing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());
  const valid = invalidFields.size === 0;
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [savedInput, setSavedInput] = useState<Awaited<ReturnType<typeof mocoRest.saveImageDraft>>["input"]>();
  const shared = useRef(initial);
  const current = useRef(config);
  const localVersion = useRef(0);
  const persistedVersion = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<ImageCapabilityDraft> | null>(null);
  const blocked = !connected || disabled || Boolean(busy);
  const hasSharedDraft = incoming?.clientId === clientId && incoming.id === shared.current.id;
  const savedConnection = workspace.connections.find((connection) => connection.id === workspace.capabilities.find((capability) => capability.id === config.id)?.connectionId);
  const sameOrigin = (left: string | undefined, right: string | undefined) => { try { return Boolean(left && right) && new URL(left!).origin === new URL(right!).origin; } catch { return false; } };
  const canKeepSavedKey = Boolean(savedConnection?.hasCredential && !savedConnection.credentialProviderId && config.credentialProviderId !== null && savedConnection.adapter === config.adapter && sameOrigin(savedConnection.baseUrl, config.baseUrl));
  const savedModelChanged = Boolean(incoming?.config.id && workspace.capabilities.find((capability) => capability.id === incoming.config.id)?.revision !== incoming.config.expectedRevision);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!connected) setApiKey(""); }, [connected]);
  useEffect(() => {
    if (!incoming || incoming.id !== shared.current.id || incoming.revision <= shared.current.revision) return;
    if (inFlight.current) return;
    if (localVersion.current > persistedVersion.current || invalidFields.has("profile") || invalidFields.has("adapter")) { setConflict(true); return; }
    shared.current = incoming; current.current = clone(incoming.config); setConfig(current.current); setError(undefined);
  }, [incoming]);
  const update = (next: ImageCapabilityConfiguration) => {
    current.current = next; ++localVersion.current; setConfig(next); setDirty(true); setError(undefined);
    if (connected && !disabled && !busy && !conflict) void flush().catch(() => {});
  };
  const flush = async (): Promise<ImageCapabilityDraft> => {
    if (inFlight.current) return inFlight.current;
    if (conflict) throw new Error(t("草稿已在其他位置更新，请先载入最新草稿。", "The draft changed elsewhere. Load the latest draft first."));
    if (persistedVersion.current >= localVersion.current) return shared.current;
    const promise = (async () => {
      if (mounted.current) setSyncing(true);
      try {
        while (persistedVersion.current < localVersion.current) {
          const sentVersion = localVersion.current;
          const next = await mocoRest.updateImageDraft({ clientId, config: clone(current.current), expectedRevision: shared.current.revision });
          shared.current = next; persistedVersion.current = sentVersion;
        }
        if (mounted.current) { setDirty(false); onChanged(); }
        return shared.current;
      } catch (cause) {
        if (mounted.current) { setError(imageActionError(cause)); if (cause instanceof MocoApiError && cause.status === 409) setConflict(true); }
        throw cause;
      } finally { inFlight.current = null; if (mounted.current) setSyncing(false); }
    })();
    inFlight.current = promise;
    return promise;
  };
  const save = async () => {
    if (blocked || !valid || conflict || !hasSharedDraft) return;
    setBusy("save"); setError(undefined);
    try {
      if (!current.current.name.trim() || !current.current.modelId.trim()) throw new Error(t("请填写名称和模型 ID。", "Enter a name and model ID."));
      if (!current.current.credentialProviderId && !canKeepSavedKey && current.current.customAdapter?.auth.type !== "none" && !apiKey.trim()) throw new Error(t("请填写 API Key。", "Enter an API key."));
      const profile = current.current.imageProfile ?? getImageModelPreset(current.current.adapter, current.current.modelId)?.profile;
      if (!profile) throw new Error(t("请声明此模型的图像能力。", "Declare this model’s image capabilities."));
      validateImageModelProfile(profile); normalizeImageGenerationParameters(current.current.defaults ?? {}, profile, current.current.adapter);
      if (current.current.adapter === "custom-image") validateCustomImageAdapter(current.current.customAdapter!);
      if (apiKey.trim() && current.current.credentialProviderId !== null) update({ ...current.current, credentialProviderId: null });
      const draft = await flush();
      const result = await mocoRest.saveImageDraft({ clientId, expectedRevision: draft.revision, commandId: imageCommandId("save") });
      if (mounted.current) setSavedInput(result.input);
      if (result.input && apiKey.trim()) await mocoRest.submitCapabilityInput(result.input.id, { clientId, secret: apiKey });
      if (mounted.current) {
        setApiKey(""); setDirty(false); onChanged();
        if (!result.input || apiKey.trim()) { setSavedInput(undefined); onClose?.(); }
      }
    } catch (cause) { if (mounted.current) { setError(safeSetupInputError(cause, apiKey)); if (cause instanceof MocoApiError && cause.status === 409) setConflict(true); } }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const cancel = async () => {
    if (blocked) return;
    setBusy("cancel");
    try {
      if (inFlight.current) await inFlight.current.catch(() => undefined);
      if (hasSharedDraft) await mocoRest.deleteImageDraft(clientId, shared.current.revision);
      if (mounted.current) { setApiKey(""); setDirty(false); setConflict(false); onChanged(); onClose?.(); }
    } catch (cause) { if (mounted.current) setError(imageActionError(cause)); }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const reload = async () => {
    if (blocked || !incoming || !hasSharedDraft) return;
    setBusy("reload");
    try {
      const nextConfig = reloadImageDraftConfiguration(workspace, incoming);
      const next = savedModelChanged ? await mocoRest.updateImageDraft({ clientId, config: nextConfig, expectedRevision: incoming.revision }) : incoming;
      shared.current = next; current.current = clone(next.config); setConfig(current.current); persistedVersion.current = ++localVersion.current;
      setDirty(false); setConflict(false); setError(undefined); setInvalidFields(new Set()); setApiKey(""); onChanged();
    } catch (cause) { if (mounted.current) setError(imageActionError(cause)); }
    finally { if (mounted.current) setBusy(undefined); }
  };
  if (!hasSharedDraft && !busy && !syncing && !savedInput && !dirty && !conflict) return null;
  return <Card variant="secondary" className="min-w-0 gap-4 rounded-2xl p-4" aria-label={initial.config.id ? t("编辑图像模型", "Edit image model") : t("添加图像模型", "Add image model")}>
    <Card.Header className="flex-row items-center justify-between gap-2"><Card.Title className="text-lg">{initial.config.id ? t("编辑图像模型", "Edit image model") : t("添加图像模型", "Add image model")}</Card.Title><span className="text-xs text-muted" role="status">{syncing ? t("同步草稿…", "Syncing draft…") : dirty ? t("未同步", "Not synced") : t("草稿已同步", "Draft synced")}</span></Card.Header>
    <Card.Content className="flex min-w-0 flex-col gap-4">
      <ImageCapabilityFields {...{ config, apiKey, canKeepSavedKey }} providers={workspace.imageSetup?.providers ?? []} disabled={blocked || Boolean(savedInput)} onChange={update} onApiKeyChange={setApiKey} onValidityChange={(fieldValid, field = "source") => setInvalidFields((previous) => {
        const next = new Set(previous); if (fieldValid) next.delete(field); else next.add(field); return next;
      })} />
      {error && <p className="break-words text-xs text-danger" role="alert">{error}</p>}
      {!hasSharedDraft && !busy && !savedInput && <p className="text-xs text-warning" role="status">{t("草稿已在其他位置保存或取消，当前未同步输入已保留。", "The draft was saved or cancelled elsewhere. Your unsynced input is preserved.")}</p>}
      {conflict && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-warning" role="status">{t("配置已在其他位置更新，当前输入已保留。", "Settings changed elsewhere. Your input is preserved.")}</p>{hasSharedDraft && <Button variant="secondary" size="sm" isDisabled={blocked} isPending={busy === "reload"} onPress={() => void reload()}>{savedModelChanged ? t("载入最新模型配置", "Load latest model settings") : t("载入最新草稿", "Load latest draft")}</Button>}</div>}
      {savedInput && <CapabilitySetupInputs inputs={[savedInput]} clientId={clientId} connected={connected} envs={[]} onChanged={onChanged} onCompleted={() => { setSavedInput(undefined); onClose?.(); }} />}
    </Card.Content>
    <Card.Footer className="justify-end gap-2"><Button variant="tertiary" isDisabled={blocked} onPress={() => savedInput ? onClose?.() : void cancel()}>{savedInput ? t("关闭", "Close") : t("取消", "Cancel")}</Button>{!savedInput && <Button variant="primary" isPending={busy === "save"} isDisabled={blocked || !valid || conflict || !hasSharedDraft} onPress={() => void save()}>{t("保存模型", "Save model")}</Button>}</Card.Footer>
  </Card>;
}
