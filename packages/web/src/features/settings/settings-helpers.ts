import type {
  CustomModelConfig,
  BuiltinThinkingEffort,
  CustomProviderApi,
  DisplayThinkingEffort,
  KuloSettingsView,
  ModelModality,
  ModelProtocolAdapter,
  ModelPurpose,
  ProviderCatalogItem,
  ProviderModelItem,
  RoleThinkingEffort,
  SettingsBlockName,
  ThinkingEffort,
  ThinkingLevelMapConfig,
  ThinkingLevelOption,
} from "@kulo/protocol";
import type { KuloIconName } from "../../kulo-icons";
import {
  defaultProtocolAdapterForModel,
  defaultVoicesForAdapter,
  inferModelPurpose,
  isConversationModel,
} from "@kulo/protocol";
import { getLanguage, translate, type KuloLanguage } from "../../kulo-i18n";

/** A delayed HTTP acknowledgement must not replace a newer settings broadcast. */
export function acceptSettingsSnapshot(current: KuloSettingsView | null, next: KuloSettingsView): KuloSettingsView {
  return !current || next.globalRevision >= current.globalRevision ? next : current;
}

export const SETTINGS_MODULES = [
  { id: "appearance", icon: "palette" as KuloIconName, title: "外观" },
  { id: "models", icon: "token" as KuloIconName, title: "模型" },
  { id: "workers", icon: "team" as KuloIconName, title: "智能体" },
  { id: "capabilities", icon: "tools" as KuloIconName, title: "工具技能" },
  { id: "identity", icon: "memory" as KuloIconName, title: "记忆" },
  { id: "connections", icon: "key" as KuloIconName, title: "授权凭据" },
  { id: "permissions", icon: "shield" as KuloIconName, title: "系统权限" },
  { id: "machines", icon: "devices" as KuloIconName, title: "设备互联" },
  { id: "schedules", icon: "schedule" as KuloIconName, title: "定时任务" },
  { id: "archives", icon: "archive" as KuloIconName, title: "已归档会话" },
] as const;

export type SettingsModuleId = (typeof SETTINGS_MODULES)[number]["id"];

const SETTINGS_MODULE_TITLES: Record<SettingsModuleId, string> = {
  appearance: "Appearance", models: "Models", workers: "Agents", capabilities: "Tools & skills",
  identity: "Memory", connections: "Credentials", permissions: "System permissions", machines: "Devices", schedules: "Scheduled tasks", archives: "Archived conversations",
};

export function settingsModuleTitle(id: SettingsModuleId, language: KuloLanguage = getLanguage()): string {
  return language === "en" ? SETTINGS_MODULE_TITLES[id] : SETTINGS_MODULES.find((module) => module.id === id)!.title;
}

export const BLOCK_NAMES: Record<SettingsBlockName, string> = {
  presentation: "显示名称",
  executor: "运行设置",
  roles: "智能体配置",
  model: "模型配置",
  identity: "身份目录",
  memory: "长期记忆",
};

export const EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "极低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "极限" },
];

export const ROLE_EFFORT_OPTIONS: Array<{ value: RoleThinkingEffort; label: string }> = [
  { value: "auto", label: "自动" },
  ...EFFORT_OPTIONS,
];

const BUILTIN_LABEL_ENGLISH: Record<string, string> = {
  "关闭": "Off", "极低": "Minimal", "低": "Low", "中": "Medium", "高": "High", "超高": "Extra high", "极限": "Maximum", "自动": "Auto",
  "文本": "Text", "图片": "Image", "音频": "Audio", "视频": "Video", "显示名称": "Display name", "运行设置": "Runtime",
  "智能体配置": "Agent configuration", "模型配置": "Model configuration", "身份目录": "Identity directory", "长期记忆": "Long-term memory",
};

/** Only use for labels from the built-in option lists, never user-authored labels. */
export function settingsBuiltinLabel(label: string): string {
  return translate(label, BUILTIN_LABEL_ENGLISH[label] ?? label);
}

export function defaultModelThinkingLevels(api: CustomProviderApi): ThinkingLevelOption[] {
  return ["off", "low", "medium", "high", "xhigh"].map((id) => ({
    id,
    label: id,
    value: id === "xhigh" && (api === "google-generative-ai" || api === "google-vertex") ? "high" : id,
  }));
}

export function getModelThinkingLevels(
  model: Pick<CustomModelConfig, "thinkingLevels" | "thinkingLevelMap">,
  api: CustomProviderApi,
): ThinkingLevelOption[] {
  if (model.thinkingLevels) return model.thinkingLevels;
  const legacy = (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).flatMap((value) => {
    const wire = model.thinkingLevelMap?.[value];
    return typeof wire === "string" && wire.trim()
      ? [{ id: value, label: value, value: wire }]
      : [];
  });
  if (legacy.length > 0) {
    if (model.thinkingLevelMap?.off !== null && !legacy.some((level) => level.id === "off")) legacy.unshift({ id: "off", label: "off", value: "off" });
    return legacy;
  }
  return defaultModelThinkingLevels(api).filter((level) => model.thinkingLevelMap?.[level.id as BuiltinThinkingEffort] !== null);
}

export function modelEffortOptions(model: ProviderModelItem | undefined): Array<{ value: ThinkingEffort; label: string }> {
  if (model?.reasoning === false || model?.thinkingEnabled === false) return [{ value: "off", label: translate("关闭", "Off") }];
  if (model?.thinkingLevels?.length) return model.thinkingLevels.map((level) => ({ value: level.id, label: level.label }));
  return EFFORT_OPTIONS.filter((option) => !model || model.supportedThinkingLevels.includes(option.value))
    .map((option) => ({ ...option, label: settingsBuiltinLabel(option.label) }));
}

export function clampModelEffort(effort: ThinkingEffort, model: ProviderModelItem): ThinkingEffort {
  const options = modelEffortOptions(model);
  if (options.some((option) => option.value === effort)) return effort;
  return options.find((option) => option.value === "medium")?.value ?? options[0]?.value ?? "off";
}

export function selectedDefaultProvider(model: KuloSettingsView["blocks"]["model"]["value"]): string {
  return model.defaultProvider ?? (model.defaultModel && !model.gatewayDisabled ? "kulo-gateway" : "");
}

export const CUSTOM_API_OPTIONS: Array<{ value: CustomProviderApi; label: string }> = [
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Gemini API" },
  { value: "google-vertex", label: "Google Vertex AI" },
  { value: "mistral-conversations", label: "Mistral Conversations" },
  { value: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { value: "openai-codex-responses", label: "OpenAI Codex Responses" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock Converse" },
  { value: "pi-messages", label: "Pi Messages" },
];

export interface MainstreamPresetMeta {
  id: string;
  name: string;
  api: CustomProviderApi;
  baseUrl: string;
  builtinId: string;
}

export const MAINSTREAM_PRESETS: readonly MainstreamPresetMeta[] = [
  {
    id: "openai",
    name: "OpenAI / Codex",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    builtinId: "openai",
  },
  {
    id: "google",
    name: "Gemini · AI Studio",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    builtinId: "google",
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    api: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    builtinId: "google-vertex",
  },
  {
    id: "anthropic",
    name: "Claude",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    builtinId: "anthropic",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    builtinId: "deepseek",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    builtinId: "openrouter",
  },
  {
    id: "xai",
    name: "xAI Grok",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    builtinId: "xai",
  },
  {
    id: "moonshotai-cn",
    name: "Kimi",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    builtinId: "moonshotai-cn",
  },
  {
    id: "minimax-cn",
    name: "MiniMax · 国内",
    api: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    builtinId: "minimax-cn",
  },
  {
    id: "minimax",
    name: "MiniMax · 国际",
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    builtinId: "minimax",
  },
  {
    id: "zai-coding-cn",
    name: "智谱 GLM",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    builtinId: "zai-coding-cn",
  },
  {
    id: "qwen-token-plan-cn",
    name: "通义千问",
    api: "openai-completions",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    builtinId: "qwen-token-plan-cn",
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    builtinId: "groq",
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "mistral-conversations",
    baseUrl: "https://api.mistral.ai",
    builtinId: "mistral",
  },
];

export const SUBSCRIPTION_PROVIDERS = [
  { id: "openai-codex", label: "OpenAI Codex" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Claude Code" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "kimi-coding", label: "Kimi Code" },
  { id: "xai", label: "SuperGrok" },
  { id: "meta", label: "Meta Muse" },
  { id: "radius", label: "Radius" },
] as const;

export const MODALITIES: Array<{ value: ModelModality; label: string }> = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "pdf", label: "PDF" },
];

export function getModelModalities(
  model: Pick<CustomModelConfig, "modalities" | "vision">,
  catalog?: Pick<ProviderModelItem, "modalities" | "vision">,
): ModelModality[] {
  if (model.modalities) return model.modalities.length ? [...model.modalities] : ["text"];
  if (model.vision !== undefined) return model.vision ? ["text", "image"] : ["text"];
  if (catalog?.modalities?.length) return [...catalog.modalities];
  return catalog?.vision ? ["text", "image"] : ["text"];
}

export const DISPLAY_EFFORTS: readonly DisplayThinkingEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const ALL_WIRE_EFFORTS = [
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
] as const;

export interface ThinkingMapRow {
  display: DisplayThinkingEffort;
  wire: string;
}

export function shortApiLabel(api: CustomProviderApi | string): string {
  switch (api) {
    case "openai-completions":
      return "OpenAI Chat";
    case "openai-responses":
      return "OpenAI Responses";
    case "anthropic-messages":
      return "Claude";
    case "google-generative-ai":
      return "Gemini";
    case "google-vertex":
      return "Vertex AI";
    case "mistral-conversations":
      return "Mistral";
    case "azure-openai-responses":
      return "Azure OpenAI";
    case "openai-codex-responses":
      return "Codex Responses";
    case "bedrock-converse-stream":
      return "Bedrock";
    case "pi-messages":
      return "Pi";
    default:
      return api;
  }
}

export function allowedWireEfforts(api: CustomProviderApi) {
  return api === "google-generative-ai" || api === "google-vertex"
    ? ALL_WIRE_EFFORTS.filter((o) =>
        ["minimal", "low", "medium", "high"].includes(o.value),
      )
    : ALL_WIRE_EFFORTS;
}

export function normalizeWireForApi(wire: string, api: CustomProviderApi): string {
  const lower = wire.trim().toLowerCase();
  if (
    (api === "google-generative-ai" || api === "google-vertex") &&
    !["minimal", "low", "medium", "high"].includes(lower)
  ) {
    return "high";
  }
  return lower || "medium";
}

export function thinkingMapToRows(
  map: ThinkingLevelMapConfig | undefined,
  api: CustomProviderApi,
  supported?: ThinkingEffort[],
): ThinkingMapRow[] {
  const rows: ThinkingMapRow[] = [];
  if (map) {
    for (const d of DISPLAY_EFFORTS) {
      const wire = map[d];
      if (typeof wire === "string" && wire.trim()) {
        rows.push({ display: d, wire: normalizeWireForApi(wire, api) });
      }
    }
  }
  if (rows.length > 0) return rows;
  if (supported && supported.length > 0) {
    const matched = DISPLAY_EFFORTS.filter((d) => supported.includes(d));
    if (matched.length > 0) {
      return matched.map((d) => ({
        display: d,
        wire: normalizeWireForApi(d, api),
      }));
    }
  }
  return [
    { display: "low", wire: "low" },
    { display: "medium", wire: "medium" },
    { display: "high", wire: "high" },
  ];
}

export function rowsToThinkingLevelMap(
  rows: ThinkingMapRow[],
  api: CustomProviderApi,
): ThinkingLevelMapConfig | undefined {
  if (rows.length === 0) return undefined;
  const map: ThinkingLevelMapConfig = {};
  const chosen = new Set<DisplayThinkingEffort>();
  for (const r of rows) {
    chosen.add(r.display);
    map[r.display] = normalizeWireForApi(r.wire, api);
  }
  map.minimal = null;
  for (const d of DISPLAY_EFFORTS) {
    if (!chosen.has(d)) {
      map[d] = null;
    }
  }
  return map;
}

export function allocateCustomProviderId(
  rawBase: string,
  existingIds: Set<string>,
  builtinIds: Set<string>,
): string {
  let slug = rawBase
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "custom";
  if (slug === "kulo-gateway" || builtinIds.has(slug)) {
    slug = `api-${slug}`;
  }
  if (!existingIds.has(slug) && !builtinIds.has(slug)) return slug;
  let i = 2;
  while (existingIds.has(`${slug}-${i}`) || builtinIds.has(`${slug}-${i}`)) {
    i += 1;
  }
  return `${slug}-${i}`;
}

export interface ProviderModelGroup {
  providerId: string;
  label: string;
  models: ProviderModelItem[];
}

export function isOfficialPresetOrigin(
  presetId: string | undefined,
  baseUrl: string | undefined,
  presets: readonly Pick<MainstreamPresetMeta, "id" | "baseUrl">[] = MAINSTREAM_PRESETS,
): boolean {
  if (!presetId || !baseUrl?.trim()) return false;
  const preset = presets.find((item) => item.id === presetId);
  if (!preset) return false;
  try {
    return new URL(baseUrl).origin === new URL(preset.baseUrl).origin;
  } catch {
    return false;
  }
}

export function toProviderModelItem(
  m: CustomModelConfig,
  fallbackWindow = 256_000,
  catalog?: ProviderModelItem,
): ProviderModelItem {
  const inferred = inferModelPurpose({ ...catalog, ...m });
  const purpose = m.purpose ?? catalog?.purpose ?? (inferred !== "chat" ? inferred : undefined);
  const nonChat = Boolean(purpose && purpose !== "chat");
  const reasoning = nonChat ? false : m.reasoning ?? catalog?.reasoning ?? true;
  const thinkingEnabled = nonChat ? false : m.thinkingEnabled ?? catalog?.thinkingEnabled;
  const thinkingLevels = nonChat ? undefined : m.thinkingLevels ?? catalog?.thinkingLevels;
  const modalities = getModelModalities(m, catalog);
  const protocolAdapter = m.protocolAdapter ?? catalog?.protocolAdapter;
  const voices = m.voices ?? catalog?.voices;
  return {
    id: m.id,
    ...(purpose ? { purpose } : {}),
    ...(protocolAdapter ? { protocolAdapter } : {}),
    ...(voices?.length ? { voices: [...voices] } : {}),
    ...(m.imageProfile ?? catalog?.imageProfile ? { imageProfile: m.imageProfile ?? catalog?.imageProfile } : {}),
    ...(m.imageDefaults ?? catalog?.imageDefaults ? { imageDefaults: m.imageDefaults ?? catalog?.imageDefaults } : {}),
    ...(m.customImageAdapter ?? catalog?.customImageAdapter ? { customImageAdapter: m.customImageAdapter ?? catalog?.customImageAdapter } : {}),
    ...(m.outputModalities ?? catalog?.outputModalities ? { outputModalities: [...(m.outputModalities ?? catalog?.outputModalities)!] } : {}),
    name: m.name || catalog?.name || m.id,
    reasoning,
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    vision: modalities.includes("image"),
    modalities,
    contextWindow: nonChat ? (m.contextWindow ?? catalog?.contextWindow ?? 0) : (m.contextWindow ?? catalog?.contextWindow ?? fallbackWindow),
    maxTokens: nonChat ? (m.maxTokens ?? catalog?.maxTokens ?? 0) : (m.maxTokens ?? catalog?.maxTokens ?? 64_000),
    supportedThinkingLevels:
      nonChat || !reasoning || thinkingEnabled === false ? ["off"] : thinkingLevels?.map((level) => level.id) ?? catalog?.supportedThinkingLevels ?? ["off", "low", "medium", "high"],
    ...(thinkingLevels ? { thinkingLevels } : {}),
    ...(!nonChat && (m.nativeTools ?? catalog?.nativeTools) ? { nativeTools: { ...(m.nativeTools ?? catalog?.nativeTools) } } : {}),
    ...(!nonChat && (m.thinkingLevelMap ?? catalog?.thinkingLevelMap) ? { thinkingLevelMap: m.thinkingLevelMap ?? catalog?.thinkingLevelMap } : {}),
  };
}

export interface ConfiguredPurposeModelOption {
  selectionKey: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  label: string;
  api: CustomProviderApi;
  baseUrl: string;
  preset?: string;
  protocolAdapter?: ModelProtocolAdapter;
  voices: string[];
  authenticated: boolean;
}

export function buildConfiguredModelsForPurpose(
  modelValue: KuloSettingsView["blocks"]["model"]["value"],
  providers: ProviderCatalogItem[],
  purpose: Exclude<ModelPurpose, "chat">,
  hasGatewayKey = false,
): ConfiguredPurposeModelOption[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const options: ConfiguredPurposeModelOption[] = [];
  const pushFromSource = (source: {
    providerId: string;
    providerName: string;
    api: CustomProviderApi;
    baseUrl: string;
    preset?: string;
    authenticated: boolean;
    models: readonly CustomModelConfig[];
  }) => {
    const seen = new Set<string>();
    for (const cm of source.models) {
      const cleanId = cm.id?.trim();
      if (!cleanId || seen.has(cleanId)) continue;
      seen.add(cleanId);
      if (inferModelPurpose(cm) !== purpose) continue;
      const protocolAdapter = cm.protocolAdapter ?? defaultProtocolAdapterForModel(purpose, cleanId, source.api, source.preset);
      const voices = cm.voices?.length ? [...cm.voices] : defaultVoicesForAdapter(protocolAdapter);
      const modelName = cm.name?.trim() || cleanId;
      options.push({
        selectionKey: `${source.providerId}::${cleanId}`,
        providerId: source.providerId,
        providerName: source.providerName,
        modelId: cleanId,
        modelName,
        label: `${modelName} · ${source.providerName}`,
        api: source.api,
        baseUrl: source.baseUrl,
        ...(source.preset ? { preset: source.preset } : {}),
        ...(protocolAdapter ? { protocolAdapter } : {}),
        voices,
        authenticated: source.authenticated,
      });
    }
  };

  if (!modelValue.gatewayDisabled && modelValue.gatewayModels?.length) {
    const cat = byId.get("kulo-gateway");
    pushFromSource({
      providerId: "kulo-gateway",
      providerName: modelValue.gatewayName?.trim() || translate("兼容网关", "Compatible gateway"),
      api: modelValue.apiMode,
      baseUrl: modelValue.baseUrl,
      authenticated: Boolean(hasGatewayKey || cat?.authenticated),
      models: modelValue.gatewayModels,
    });
  }

  for (const cp of modelValue.customProviders ?? []) {
    const cat = byId.get(cp.id);
    pushFromSource({
      providerId: cp.id,
      providerName: cp.name || cp.id,
      api: cp.api,
      baseUrl: cp.baseUrl,
      preset: cp.preset,
      authenticated: Boolean(cat?.authenticated),
      models: cp.models,
    });
  }

  return options;
}

export function countConfiguredModelsForProvider(
  modelValue: KuloSettingsView["blocks"]["model"]["value"],
  providerId: string,
  providers: ProviderCatalogItem[],
): number {
  if (providerId === "kulo-gateway") {
    return new Set((modelValue.gatewayModels ?? []).map((m) => m.id).filter(Boolean)).size;
  }
  const custom = (modelValue.customProviders ?? []).find((cp) => cp.id === providerId);
  if (custom) {
    return new Set(custom.models.map((m) => m.id).filter(Boolean)).size;
  }
  return buildProviderModelGroups(modelValue, providers).find((g) => g.providerId === providerId)?.models.length ?? 0;
}

export function buildProviderModelGroups(
  modelValue: KuloSettingsView["blocks"]["model"]["value"],
  providers: ProviderCatalogItem[],
): ProviderModelGroup[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const fallbackWindow = modelValue.contextWindow ?? 256_000;
  const groups: ProviderModelGroup[] = [];
  const seenProviders = new Set<string>();

  const collectModels = (
    providerId: string,
    draftList: CustomModelConfig[] = [],
  ): ProviderModelItem[] => {
    const out: ProviderModelItem[] = [];
    const seen = new Set<string>();
    for (const cm of draftList) {
      if (cm.id && !seen.has(cm.id)) {
        seen.add(cm.id);
        const catalogModel = byId.get(providerId)?.models.find((model) => model.id === cm.id);
        const model = toProviderModelItem(cm, fallbackWindow, catalogModel);
        if (isConversationModel(model)) out.push(model);
      }
    }
    return out;
  };

  const collectSubscriptionModels = (provider: ProviderCatalogItem): ProviderModelItem[] => {
    const configured = provider.configuredModels ?? collectModels(provider.id, modelValue.subscriptionModels?.[provider.id]);
    const configuredIds = new Set(configured.map((model) => model.id));
    const catalog = provider.modelCatalogSource === "preset" ? [] : provider.models;
    return [...configured, ...catalog.filter((model) => !configuredIds.has(model.id))].filter(isConversationModel);
  };

  if (!modelValue.gatewayDisabled) {
    seenProviders.add("kulo-gateway");
    const models = collectModels("kulo-gateway", modelValue.gatewayModels ?? []);
    if (modelValue.gatewayModels !== undefined) {
      groups.push({
        providerId: "kulo-gateway",
        label: modelValue.gatewayName?.trim() || translate("兼容网关", "Compatible gateway"),
        models,
      });
    }
  }

  for (const cp of modelValue.customProviders ?? []) {
    if (seenProviders.has(cp.id)) continue;
    seenProviders.add(cp.id);
    const models = collectModels(cp.id, cp.models);
    groups.push({ providerId: cp.id, label: cp.name || cp.id, models });
  }

  for (const sub of SUBSCRIPTION_PROVIDERS) {
    const cat = byId.get(sub.id);
    if (cat?.authenticated && cat.authType === "oauth" && !seenProviders.has(sub.id)) {
      seenProviders.add(sub.id);
      const models = collectSubscriptionModels(cat);
      if (models.length > 0) {
        groups.push({
          providerId: sub.id,
          label: sub.label,
          models,
        });
      }
    }
  }

  for (const p of providers) {
    if (p.builtin && !p.isGateway && p.authenticated && p.authType === "oauth" && !seenProviders.has(p.id)) {
      seenProviders.add(p.id);
      const models = collectSubscriptionModels(p);
      if (models.length > 0) {
        groups.push({
          providerId: p.id,
          label: p.name,
          models,
        });
      }
    }
  }

  return groups;
}

export function normalizeClientOAuthProgress(raw?: string): string {
  const text = (raw ?? "").trim();
  if (!text) return translate("等待浏览器完成授权…", "Waiting for browser authorization…");
  if (/^Listening for .*OAuth callback/i.test(text)) return translate("等待浏览器完成授权…", "Waiting for browser authorization…");
  if (/^Exchanging authorization code/i.test(text)) return translate("正在获取访问凭据…", "Getting access credentials…");
  if (/^Enabling models/i.test(text)) return translate("正在同步可用模型…", "Syncing available models…");
  if (/^Enabling .*API access/i.test(text)) return translate("正在开通接口权限…", "Enabling API access…");
  return text;
}

export function normalizeClientOAuthPromptLabel(message: string, type: string): string {
  const text = message.trim();
  if (type === "select" && /login method|Sign in to|authentication method/i.test(text)) {
    return translate("授权方式", "Authorization method");
  }
  if (type === "manual_code") {
    if (/Paste the code .* shows/i.test(text)) return translate("授权码", "Authorization code");
    if (/authorization code\s*\/\s*redirect URL/i.test(text)) return translate("授权码或回调链接", "Authorization code or redirect URL");
    if (/redirect URL/i.test(text)) return translate("回调链接", "Redirect URL");
  }
  if (/GitHub Enterprise URL\/domain/i.test(text)) return translate("企业域名", "Enterprise domain");
  return text;
}

export function normalizeClientOAuthOptionLabel(id: string, label: string): string {
  const lowerId = id.toLowerCase();
  if (lowerId.includes("browser") || /browser/i.test(label)) return translate("浏览器授权", "Browser authorization");
  if (lowerId.includes("device") || /device code/i.test(label)) return translate("设备码授权", "Device code");
  if (lowerId.includes("copy") || /copy code/i.test(label)) return translate("粘贴授权码", "Paste authorization code");
  return label.replace(/\s*\([^)]*\)\s*/g, "").trim() || label;
}

export function effortLabel(effort: RoleThinkingEffort | undefined, model?: ProviderModelItem): string {
  if (!effort || effort === "auto") return translate("自动", "Auto");
  const custom = model?.thinkingLevels?.find((level) => level.id === effort);
  if (custom) return custom.label;
  return settingsBuiltinLabel(EFFORT_OPTIONS.find((item) => item.value === effort)?.label ?? effort);
}
