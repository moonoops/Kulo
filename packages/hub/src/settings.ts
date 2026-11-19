/**
 * Durable Runtime Settings Document (`MocoSettingsDoc`) with per-block Revision CAS,
 * Secret-Free Public Projection, and Snapshot Rollback History.
 */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CUSTOM_PROVIDER_APIS,
  EXTERNAL_AGENT_KINDS,
  externalClientConnectionId,
  inferModelPurpose,
  isConversationModel,
  isImageGenerationModel,
  MODEL_PROTOCOL_ADAPTERS,
  MODEL_PURPOSES,
  normalizeImageGenerationParameters,
  normalizeVertexConfig,
  buildVertexModelBaseUrl,
  validateCustomImageAdapter,
  validateImageModelProfile,
  VertexConfigError,
  defaultRolePresets,
  HISTORICAL_DEFAULT_ROLE_TEXTS,
  type AgentExpressionState,
  type CompactionConfig,
  type CustomModelConfig,
  type CustomProviderApi,
  type CustomProviderConfig,
  type ExecutorSlotsConfig,
  type ExternalAgentBinding,
  type ExternalAgentModelInfo,
  type ExternalClientConnection,
  type HindsightMemoryConfig,
  type MocoSettingsView,
  type ModelGatewayConfig,
  type ModelModality,
  type ModelProtocolAdapter,
  type ModelPurpose,
  type PresentationConfig,
  type RolePreset,
  type RoleThinkingEffort,
  type SettingsBlockName,
  type SettingsHistoryItem,
  type ThinkingEffort,
  type BuiltinThinkingEffort,
  type ThinkingLevelOption,
  type ThinkingLevelMapConfig,
} from "@moco/protocol";
import {
  coerceCustomProviderApi,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeCustomProviderApi,
  normalizeProviderBaseUrl,
  parseThinking,
  type MocoHubConfig,
} from "./config.js";
import { resolveHindsightToken, resolveHindsightSharedReadToken } from "./hindsight.js";
import { subscriptionModelTemplate } from "./subscription-models.js";
import { AgentRoutingError, assertAgentDefaultScopes, normalizeAgentDispatchPolicy } from "./agent-routing.js";

const VALID_CUSTOM_APIS = new Set<CustomProviderApi>(CUSTOM_PROVIDER_APIS);

function sanitizeVertexConfig(raw: { vertexProject?: unknown; vertexLocation?: unknown }, api: CustomProviderApi, baseUrl: string) {
  if (api !== "google-vertex") return undefined;
  try {
    const vertex = normalizeVertexConfig(raw);
    if (vertex) buildVertexModelBaseUrl(baseUrl, vertex);
    return vertex;
  } catch (error) {
    if (error instanceof VertexConfigError) throw new SettingsUpdateError(400, error.message);
    throw error;
  }
}

const VALID_MODALITIES = new Set<ModelModality>(["text", "image", "audio", "video", "pdf"]);
const VALID_THINKING_KEYS: readonly BuiltinThinkingEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function sanitizeModalities(
  raw: unknown,
  fallbackVision?: boolean,
): ModelModality[] | undefined {
  if (Array.isArray(raw)) {
    const out: ModelModality[] = [];
    for (const item of raw) {
      if (typeof item === "string" && VALID_MODALITIES.has(item as ModelModality)) {
        const mod = item as ModelModality;
        if (!out.includes(mod)) out.push(mod);
      }
    }
    return out.length > 0 ? out : ["text"];
  }
  if (fallbackVision !== undefined) {
    return fallbackVision ? ["text", "image"] : ["text"];
  }
  return undefined;
}

const GOOGLE_VALID_WIRE_THINKING = new Set(["minimal", "low", "medium", "high"]);

export function allowedThinkingWireValuesForApi(api?: CustomProviderApi): readonly string[] | undefined {
  if (api === "google-generative-ai" || api === "google-vertex") {
    return ["off", "minimal", "low", "medium", "high"];
  }
  if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
    return [...VALID_THINKING_KEYS];
  }
  return undefined;
}

export function sanitizeThinkingLevels(raw: unknown, api?: CustomProviderApi): ThinkingLevelOption[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SettingsUpdateError(400, "思考强度至少需要一个档位。");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  return raw.map((item) => {
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const wire = typeof value.value === "string" ? value.value.trim() : "";
    if (id === "auto" || !/^[a-zA-Z0-9_.:-]{1,96}$/.test(id)) {
      throw new SettingsUpdateError(400, "思考强度档位标识无效。");
    }
    if (!label || label.length > 80 || !wire || wire.length > 64) {
      throw new SettingsUpdateError(400, "请填写有效的思考强度显示名称和映射值。");
    }
    if (ids.has(id) || labels.has(label)) {
      throw new SettingsUpdateError(400, "思考强度档位标识和显示名称不能重复。");
    }
    if ((api === "google-generative-ai" || api === "google-vertex") &&
      wire !== "off" && !GOOGLE_VALID_WIRE_THINKING.has(wire)) {
      throw new SettingsUpdateError(400, `Google API 不支持思考强度映射值「${wire}」，仅支持 off、minimal、low、medium、high。`);
    }
    if ((api === "anthropic-messages" || api === "bedrock-converse-stream") &&
      !VALID_THINKING_KEYS.includes(wire as BuiltinThinkingEffort)) {
      throw new SettingsUpdateError(400, `此 API 不支持思考强度映射值「${wire}」，请使用标准思考强度（${VALID_THINKING_KEYS.join("、")}）。`);
    }
    ids.add(id);
    labels.add(label);
    return { id, label, value: wire };
  });
}

export function sanitizeThinkingLevelMap(
  raw: unknown,
  api?: CustomProviderApi,
): ThinkingLevelMapConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: ThinkingLevelMapConfig = {};
  let hasAny = false;
  for (const key of VALID_THINKING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const val = obj[key];
    if (val === null) {
      out[key] = null;
      hasAny = true;
    } else if (typeof val === "string" && val.trim()) {
      let wire = val.trim().slice(0, 64).toLowerCase();
      if (
        (api === "google-generative-ai" || api === "google-vertex") &&
        !GOOGLE_VALID_WIRE_THINKING.has(wire)
      ) {
        wire = "high";
      }
      out[key] = wire;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

export function sanitizeCustomModelList(
  rawModels: unknown,
  api?: CustomProviderApi,
): CustomModelConfig[] {
  if (!Array.isArray(rawModels)) return [];
  const seenModels = new Set<string>();
  const models: CustomModelConfig[] = [];
  for (const m of rawModels) {
    if (!m || typeof m !== "object") continue;
    const mObj = m as Record<string, unknown>;
    const mid = String(mObj.id ?? "").trim();
    if (!mid || seenModels.has(mid)) continue;
    seenModels.add(mid);
    const fallbackVision =
      mObj.vision !== undefined ? Boolean(mObj.vision) : undefined;
    const modalities = sanitizeModalities(mObj.modalities, fallbackVision);
    if (mObj.purpose !== undefined && !(MODEL_PURPOSES as readonly unknown[]).includes(mObj.purpose)) {
      throw new SettingsUpdateError(400, "模型用途无效。");
    }
    const purpose = mObj.purpose as ModelPurpose | undefined;
    if (mObj.protocolAdapter !== undefined && !(MODEL_PROTOCOL_ADAPTERS as readonly unknown[]).includes(mObj.protocolAdapter)) {
      throw new SettingsUpdateError(400, "模型接口协议无效。");
    }
    const protocolAdapter = mObj.protocolAdapter as ModelProtocolAdapter | undefined;
    let voices: string[] | undefined;
    if (mObj.voices !== undefined) {
      if (!Array.isArray(mObj.voices) || mObj.voices.length > 64 || mObj.voices.some((v) => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(v.trim()))) {
        throw new SettingsUpdateError(400, "模型音色列表无效。");
      }
      const deduped = [...new Set(mObj.voices.map((v) => String(v).trim()).filter(Boolean))];
      if (deduped.length > 0) voices = deduped;
    }
    let imageProfile: CustomModelConfig["imageProfile"];
    if (mObj.imageProfile !== undefined) {
      try { imageProfile = validateImageModelProfile(mObj.imageProfile as NonNullable<CustomModelConfig["imageProfile"]>); }
      catch (err) { throw new SettingsUpdateError(400, err instanceof Error ? err.message : "图像能力声明无效。"); }
    }
    let imageDefaults: CustomModelConfig["imageDefaults"];
    if (mObj.imageDefaults !== undefined) {
      if (!imageProfile) throw new SettingsUpdateError(400, "配置默认图像参数前需提供图像能力声明。");
      const mediaAdapter = protocolAdapter === "gemini-image" ? "gemini-image" : protocolAdapter === "custom-image" ? "custom-image" : "openai-image";
      try { imageDefaults = normalizeImageGenerationParameters(mObj.imageDefaults as NonNullable<CustomModelConfig["imageDefaults"]>, imageProfile, mediaAdapter); }
      catch (err) { throw new SettingsUpdateError(400, err instanceof Error ? err.message : "默认图像参数无效。"); }
    }
    let customImageAdapter: CustomModelConfig["customImageAdapter"];
    if (mObj.customImageAdapter !== undefined) {
      try { customImageAdapter = validateCustomImageAdapter(mObj.customImageAdapter as NonNullable<CustomModelConfig["customImageAdapter"]>); }
      catch (err) { throw new SettingsUpdateError(400, err instanceof Error ? err.message : "自定义图像接口无效。"); }
    }
    if (mObj.outputModalities !== undefined && (!Array.isArray(mObj.outputModalities) || !mObj.outputModalities.length ||
      mObj.outputModalities.some((value) => typeof value !== "string" || !VALID_MODALITIES.has(value as ModelModality)))) {
      throw new SettingsUpdateError(400, "模型输出类型无效。");
    }
    const outputModalities = mObj.outputModalities === undefined ? undefined : [...new Set(mObj.outputModalities as ModelModality[])];
    const isChat = isConversationModel({ id: mid, ...(purpose ? { purpose } : {}), ...(outputModalities ? { outputModalities } : {}) });
    const hasImage = modalities
      ? modalities.includes("image")
      : fallbackVision;
    const thinkingLevelMap = isChat ? sanitizeThinkingLevelMap(mObj.thinkingLevelMap, api) : undefined;
    const thinkingLevels = isChat ? sanitizeThinkingLevels(mObj.thinkingLevels, api) : undefined;
    let nativeTools: CustomModelConfig["nativeTools"];
    if (mObj.nativeTools !== undefined) {
      if (!mObj.nativeTools || typeof mObj.nativeTools !== "object" || Array.isArray(mObj.nativeTools) ||
        Object.keys(mObj.nativeTools).some((key) => key !== "webSearch") ||
        (Object.hasOwn(mObj.nativeTools, "webSearch") && typeof (mObj.nativeTools as { webSearch?: unknown }).webSearch !== "boolean")) {
        throw new SettingsUpdateError(400, "原生工具设置无效。");
      }
      if (isChat) {
        nativeTools = { ...(Object.hasOwn(mObj.nativeTools, "webSearch") ? { webSearch: (mObj.nativeTools as { webSearch: boolean }).webSearch } : {}) };
      }
    }
    if (mObj.thinkingEnabled !== undefined && typeof mObj.thinkingEnabled !== "boolean") {
      throw new SettingsUpdateError(400, "思考强度开关必须为布尔值。");
    }
    if (isChat && mObj.reasoning !== false && thinkingLevelMap?.off === null &&
      (mObj.thinkingEnabled === false || thinkingLevels?.some((level) => level.value === "off"))) {
      throw new SettingsUpdateError(400, `模型「${mid}」不支持关闭思考，请移除关闭档位并保持思考强度开启。`);
    }

    models.push({
      id: mid,
      ...(purpose !== undefined ? { purpose } : {}),
      ...(protocolAdapter !== undefined ? { protocolAdapter } : {}),
      ...(voices ? { voices } : {}),
      ...(imageProfile ? { imageProfile } : {}),
      ...(imageDefaults ? { imageDefaults } : {}),
      ...(customImageAdapter ? { customImageAdapter } : {}),
      ...(outputModalities ? { outputModalities } : {}),
      ...(typeof mObj.name === "string" && mObj.name.trim()
        ? { name: mObj.name.trim().slice(0, 120) }
        : {}),
      ...(isChat && typeof mObj.contextWindow === "number" && Number.isFinite(mObj.contextWindow)
        ? {
            contextWindow: clampInt(
              mObj.contextWindow,
              DEFAULT_CONTEXT_WINDOW,
              4096,
              10_000_000,
            ),
          }
        : {}),
      ...(isChat && typeof mObj.maxTokens === "number" && Number.isFinite(mObj.maxTokens)
        ? {
            maxTokens: clampInt(
              mObj.maxTokens,
              DEFAULT_MAX_TOKENS,
              256,
              1_000_000,
            ),
          }
        : {}),
      ...(mObj.reasoning !== undefined ? { reasoning: Boolean(mObj.reasoning) } : {}),
      ...(mObj.thinkingEnabled !== undefined ? { thinkingEnabled: mObj.thinkingEnabled as boolean } : {}),
      ...(hasImage !== undefined ? { vision: hasImage } : {}),
      ...(modalities ? { modalities } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(thinkingLevels ? { thinkingLevels } : {}),
      ...(nativeTools ? { nativeTools } : {}),
    });
  }
  return models;
}

const SUBSCRIPTION_PROVIDERS = new Map(builtinProviders().filter((provider) => provider.auth.oauth).map((provider) => [provider.id, provider]));

function sanitizeSubscriptionModels(raw: unknown): Record<string, CustomModelConfig[]> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
    throw new SettingsUpdateError(400, "订阅模型配置必须按供应商分组。");
  }
  const groups: Record<string, CustomModelConfig[]> = {};
  for (const [providerId, entries] of Object.entries(raw)) {
    const provider = SUBSCRIPTION_PROVIDERS.get(providerId);
    if (!provider) throw new SettingsUpdateError(400, `不支持的订阅供应商「${providerId}」。`);
    if (!Array.isArray(entries) || entries.length > 1000) {
      throw new SettingsUpdateError(400, "订阅模型列表无效或超过数量上限。");
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string") {
        throw new SettingsUpdateError(400, "请填写有效的订阅模型 ID。");
      }
      const id = entry.id.trim();
      if (!/^[a-zA-Z0-9~][a-zA-Z0-9_.:/@+~-]{0,511}$/.test(id) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(id) ||
        ["__proto__", "constructor", "prototype"].includes(id)) {
        throw new SettingsUpdateError(400, "请填写有效的订阅模型 ID。");
      }
      if (seen.has(id)) throw new SettingsUpdateError(400, `订阅模型「${id}」不能重复。`);
      seen.add(id);
    }
    groups[providerId] = entries.flatMap((entry) => {
      const configured = sanitizeCustomModelList([entry]);
      if (configured[0] && isImageGenerationModel(configured[0])) return configured;
      let template: Model<Api>;
      try { template = subscriptionModelTemplate(providerId, entry.id.trim(), provider.getModels()); }
      catch (error) {
        if (error instanceof Error) throw new SettingsUpdateError(400, error.message);
        throw error;
      }
      const api = VALID_CUSTOM_APIS.has(template.api as CustomProviderApi) ? template.api as CustomProviderApi : undefined;
      const thinkingLevelMap: ThinkingLevelMapConfig = { ...template.thinkingLevelMap, ...sanitizeThinkingLevelMap(entry.thinkingLevelMap, api) };
      for (const key of VALID_THINKING_KEYS) {
        if (template.thinkingLevelMap?.[key] === null) thinkingLevelMap[key] = null;
      }
      if (template.reasoning && template.thinkingLevelMap?.off === null && (entry.thinkingEnabled === false || entry.reasoning === false)) {
        throw new SettingsUpdateError(400, `模型「${entry.id.trim()}」不支持关闭思考，请移除关闭档位并保持思考强度开启。`);
      }
      let thinkingLevels = sanitizeThinkingLevels(entry.thinkingLevels, api)?.filter((level) =>
        thinkingLevelMap[level.id as BuiltinThinkingEffort] !== null && thinkingLevelMap[level.value as BuiltinThinkingEffort] !== null);
      if (thinkingLevels?.length === 0) {
        const supported = getSupportedThinkingLevels({ ...template, thinkingLevelMap });
        const fallback = supported.includes("medium") ? "medium" : supported[0];
        if (!fallback) throw new SettingsUpdateError(400, "思考强度至少需要一个档位。");
        thinkingLevels = [{ id: fallback, label: fallback, value: fallback }];
      }
      return sanitizeCustomModelList([{ ...entry, thinkingLevelMap, ...(thinkingLevels ? { thinkingLevels } : {}) }], api);
    });
  }
  return groups;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseRoleThinking(
  raw: unknown,
  fallback: RoleThinkingEffort = "auto",
): RoleThinkingEffort {
  if (raw === "auto") return "auto";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    return parseThinking(trimmed, fallback === "auto" ? "medium" : fallback);
  }
  return fallback;
}

function configuredModel(
  config: ModelGatewayConfig,
  provider: string | undefined,
  modelId: string,
): CustomModelConfig | undefined {
  const providerId = provider || config.defaultProvider || (!config.gatewayDisabled ? "moco-gateway" : undefined);
  if (!providerId || (providerId === "moco-gateway" && config.gatewayDisabled)) return undefined;
  const subscriptionModels = config.subscriptionModels && Object.hasOwn(config.subscriptionModels, providerId)
    ? config.subscriptionModels[providerId] : undefined;
  return providerId === "moco-gateway"
    ? config.gatewayModels?.find((model) => model.id === modelId)
    : subscriptionModels?.find((model) => model.id === modelId) ??
      config.customProviders?.find((entry) => entry.id === providerId)?.models.find((model) => model.id === modelId);
}

function isValidThinkingSelection(model: CustomModelConfig | undefined, selection: string): boolean {
  return model?.thinkingLevels?.length
    ? model.thinkingLevels.some((option) => option.id === selection)
    : VALID_THINKING_KEYS.includes(selection as BuiltinThinkingEffort);
}

function assertConversationModelSelection(config: ModelGatewayConfig, provider: string | undefined, modelId: string): void {
  if (!modelId) return;
  const candidate = configuredModel(config, provider, modelId) ?? { id: modelId };
  const purpose = inferModelPurpose(candidate);
  if (purpose === "image") {
    throw new SettingsUpdateError(400, `模型「${modelId}」用于图像生成，请在工具技能的图像能力中配置。`);
  }
  if (purpose !== "chat") {
    throw new SettingsUpdateError(400, `模型「${modelId}」是语音或实时通话模型，不能设为默认对话或智能体模型。`);
  }
}

function cleanupRemovedRoleModels(
  roles: Record<string, RolePreset>,
  prevModel: ModelGatewayConfig,
  nextModel: ModelGatewayConfig,
): boolean {
  let changed = false;
  const prevCustomById = new Map((prevModel.customProviders ?? []).map((p) => [p.id, p]));
  const nextCustomById = new Map((nextModel.customProviders ?? []).map((p) => [p.id, p]));
  const prevGatewayModels = new Set((prevModel.gatewayModels ?? []).map((m) => m.id));
  const nextGatewayChatModels = new Set(
    (nextModel.gatewayModels ?? []).filter((m) => isConversationModel(m)).map((m) => m.id),
  );

  for (const role of Object.values(roles)) {
    if (role.external) continue;
    const explicitProvider = role.provider?.trim();
    const modelId = role.modelId?.trim();
    if (!explicitProvider && !modelId) continue;

    let shouldClear = false;
    if (explicitProvider === "moco-gateway") {
      if (nextModel.gatewayDisabled) {
        shouldClear = true;
      } else if (modelId && prevGatewayModels.has(modelId) && !nextGatewayChatModels.has(modelId)) {
        shouldClear = true;
      }
    } else if (explicitProvider && prevCustomById.has(explicitProvider)) {
      const prevCustom = prevCustomById.get(explicitProvider)!;
      const nextCustom = nextCustomById.get(explicitProvider);
      if (!nextCustom) {
        shouldClear = true;
      } else if (
        modelId &&
        prevCustom.models.some((m) => m.id === modelId) &&
        !nextCustom.models.some((m) => m.id === modelId && isConversationModel(m))
      ) {
        shouldClear = true;
      }
    } else if (
      explicitProvider &&
      modelId &&
      prevModel.subscriptionModels &&
      Object.hasOwn(prevModel.subscriptionModels, explicitProvider) &&
      prevModel.subscriptionModels[explicitProvider]!.some((m) => m.id === modelId)
    ) {
      const nextSub = nextModel.subscriptionModels && Object.hasOwn(nextModel.subscriptionModels, explicitProvider)
        ? nextModel.subscriptionModels[explicitProvider]
        : undefined;
      if (nextSub && !nextSub.some((m) => m.id === modelId && isConversationModel(m))) {
        shouldClear = true;
      }
    } else if (!explicitProvider && modelId) {
      const prevImplicitProvider = prevModel.defaultProvider?.trim() || (!prevModel.gatewayDisabled ? "moco-gateway" : "");
      if (prevImplicitProvider === "moco-gateway" && nextModel.gatewayDisabled) {
        shouldClear = true;
      }
    }

    if (shouldClear) {
      delete role.provider;
      delete role.modelId;
      role.thinkingLevel = "auto";
      changed = true;
    }
  }
  return changed;
}

function normalizeRoleThinkingSelections(roles: Record<string, RolePreset>, config: ModelGatewayConfig): boolean {
  let changed = false;
  for (const role of Object.values(roles)) {
    if (role.external) continue;
    if (!role.thinkingLevel || role.thinkingLevel === "auto") continue;
    const model = configuredModel(config, role.provider, role.modelId || config.defaultModel);
    const next = model?.reasoning === false || model?.thinkingEnabled === false ? "off" :
      isValidThinkingSelection(model, role.thinkingLevel) ? role.thinkingLevel : "auto";
    if (role.thinkingLevel !== next) {
      role.thinkingLevel = next;
      changed = true;
    }
  }
  return changed;
}

function normalizeCompactionConfig(raw: unknown, fallback = DEFAULT_COMPACTION_CONFIG): CompactionConfig {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : fallback.enabled,
    reserveTokens: clampInt(obj.reserveTokens, fallback.reserveTokens, 1024, 256_000),
    keepRecentTokens: clampInt(obj.keepRecentTokens, fallback.keepRecentTokens, 2048, 512_000),
    backgroundTokens: clampInt(obj.backgroundTokens, fallback.backgroundTokens, 4096, 1_000_000),
  };
}

function sanitizeCustomProviders(raw: unknown): CustomProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const out: CustomProviderConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new SettingsUpdateError(400, "自定义模型提供商配置项格式无效。");
    }
    const obj = item as Record<string, unknown>;
    const id = String(obj.id ?? "").trim();
    const name = String(obj.name ?? "").trim() || id;
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || id === "moco-gateway") {
      throw new SettingsUpdateError(
        400,
        `自定义提供商 ID "${id}" 格式非法（仅限小写字母、数字、-、_，且不可为 moco-gateway）。`,
      );
    }
    if (seenIds.has(id)) {
      throw new SettingsUpdateError(400, `自定义提供商 ID "${id}" 重复。`);
    }
    seenIds.add(id);

    const apiRaw = String(obj.api ?? "openai-completions").trim() as CustomProviderApi;
    if (!VALID_CUSTOM_APIS.has(apiRaw)) {
      throw new SettingsUpdateError(400, `不支持的协议类型 "${apiRaw}"。`);
    }

    const rawBaseUrl = String(obj.baseUrl ?? "").trim();
    const baseUrl = normalizeProviderBaseUrl(rawBaseUrl, apiRaw);
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Invalid protocol");
      }
    } catch {
      throw new SettingsUpdateError(400, `自定义提供商 "${name}" 的接口地址格式无效。`);
    }

    const presetRaw =
      typeof obj.preset === "string" && /^[a-z0-9_-]{1,48}$/i.test(obj.preset.trim())
        ? obj.preset.trim().toLowerCase()
        : undefined;
    const models = sanitizeCustomModelList(obj.models, apiRaw);
    const vertex = sanitizeVertexConfig(obj, apiRaw, baseUrl);

    out.push({
      id,
      name,
      ...(presetRaw ? { preset: presetRaw } : {}),
      api: apiRaw,
      baseUrl,
      ...vertex,
      models,
    });
  }
  return out;
}

function normalizeExecutorConfig(
  raw: unknown,
  fallbackMax = 3,
  fallbackWatchdog = 5,
  fallbackMaxSubagents = 4,
  fallbackCompletedDisplay: ExecutorSlotsConfig["completedTaskDisplayHours"] = 3,
): ExecutorSlotsConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const maxConcurrentWorkers = clampInt(
    obj.maxConcurrentWorkers ?? obj.normalSlots ?? fallbackMax,
    fallbackMax,
    1,
    16,
  );
  const maxSubagentsPerTicket = clampInt(
    obj.maxSubagentsPerTicket ?? fallbackMaxSubagents,
    fallbackMaxSubagents,
    1,
    8,
  );
  const watchdogMinutes = clampInt(
    obj.watchdogMinutes ?? fallbackWatchdog,
    fallbackWatchdog,
    0,
    60,
  );
  const completedTaskDisplayHours = obj.completedTaskDisplayHours === null ||
    obj.completedTaskDisplayHours === 1 || obj.completedTaskDisplayHours === 3 || obj.completedTaskDisplayHours === 6
    ? obj.completedTaskDisplayHours
    : fallbackCompletedDisplay;
  const autoArchiveEnabled = typeof obj.autoArchiveEnabled === "boolean" ? obj.autoArchiveEnabled : true;
  const autoArchiveDays = typeof obj.autoArchiveDays === "number" && Number.isSafeInteger(obj.autoArchiveDays) &&
    obj.autoArchiveDays >= 1 && obj.autoArchiveDays <= 3650 ? obj.autoArchiveDays : 7;
  return {
    maxConcurrentWorkers,
    maxSubagentsPerTicket,
    paused: Boolean(obj.paused),
    watchdogMinutes,
    completedTaskDisplayHours,
    autoArchiveEnabled,
    autoArchiveDays,
  };
}

function normalizeModelConfig(raw: unknown): ModelGatewayConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const apiMode: CustomProviderApi = normalizeCustomProviderApi(obj.apiMode);
  const contextWindow = clampInt(
    obj.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    DEFAULT_CONTEXT_WINDOW,
    4096,
    10_000_000,
  );
  const compaction = normalizeCompactionConfig(obj.compaction, DEFAULT_COMPACTION_CONFIG);
  const customProviders = (Array.isArray(obj.customProviders)
    ? (cleanJson(obj.customProviders) as CustomProviderConfig[]) : []).map(({ vertexProject, vertexLocation, ...provider }) => ({
      ...provider,
      ...sanitizeVertexConfig({ vertexProject, vertexLocation }, provider.api, provider.baseUrl),
    }));
  const vertex = sanitizeVertexConfig(obj, apiMode, String(obj.baseUrl ?? "https://api.openai.com/v1"));
  const defaultProvider =
    typeof obj.defaultProvider === "string"
      ? obj.defaultProvider.trim()
      : undefined;
  const gatewayName =
    typeof obj.gatewayName === "string" && obj.gatewayName.trim()
      ? obj.gatewayName.trim().slice(0, 80)
      : undefined;
  const gatewayModels = Array.isArray(obj.gatewayModels)
    ? sanitizeCustomModelList(obj.gatewayModels, apiMode)
    : undefined;
  const subscriptionModels = sanitizeSubscriptionModels(obj.subscriptionModels);
  const gatewayDisabled =
    Boolean(obj.gatewayDisabled) && defaultProvider !== "moco-gateway";

  return {
    baseUrl: String(obj.baseUrl ?? "https://api.openai.com/v1"),
    apiMode,
    ...vertex,
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    defaultModel: String(obj.defaultModel ?? ""),
    thinkingLevel: parseThinking(
      typeof obj.thinkingLevel === "string" ? obj.thinkingLevel : undefined,
      "medium",
    ),
    contextWindow,
    compaction,
    customProviders,
    ...(subscriptionModels !== undefined ? { subscriptionModels } : {}),
    ...(gatewayName ? { gatewayName } : {}),
    ...(gatewayModels ? { gatewayModels } : {}),
    ...(gatewayDisabled ? { gatewayDisabled: true } : {}),
    ...(typeof obj.apiKey === "string" && obj.apiKey ? { apiKey: obj.apiKey } : {}),
  };
}

export interface SettingsSnapshotRecord extends SettingsHistoryItem {
  previousState: {
    presentation: PresentationConfig;
    executor: ExecutorSlotsConfig;
    roles: Record<string, RolePreset>;
    externalClients?: Record<string, ExternalClientConnection>;
    model: ModelGatewayConfig;
    identityDirectory: string;
    memory: HindsightMemoryConfig;
  };
}

const SETTINGS_HISTORY_LIMIT = 40;

function rememberSettingsSnapshot(doc: MocoDurableSettings, snapshot: SettingsSnapshotRecord): void {
  doc.snapshots.push(snapshot);
  if (doc.snapshots.length > SETTINGS_HISTORY_LIMIT) doc.snapshots = doc.snapshots.slice(-SETTINGS_HISTORY_LIMIT);
}

export type MocoDurableSettings = {
  initialized: boolean;
  rolesMigratedV2?: boolean;
  rolesMigratedV3?: boolean;
  rolesMigratedV4?: boolean;
  gatewayMigratedV2?: boolean;
  globalRevision: number;
  revisions: Record<SettingsBlockName, number>;
  presentation: PresentationConfig;
  executor: ExecutorSlotsConfig;
  roles: Record<string, RolePreset>;
  externalClients?: Record<string, ExternalClientConnection>;
  model: ModelGatewayConfig;
  identity: {
    /** Empty string means default `<stateDir>/identity`. */
    directory: string;
    directoryRevision: number;
  };
  memory: HindsightMemoryConfig;
  expression: AgentExpressionState | null;
  snapshots: SettingsSnapshotRecord[];
};

export const MocoSettingsDoc = defineDoc<MocoDurableSettings & JsonObject>({
  kind: "moco.settings",
  version: 1,
  scope: "session",
  initial: () =>
    ({
      initialized: false,
      rolesMigratedV2: true,
      rolesMigratedV3: true,
      rolesMigratedV4: true,
      gatewayMigratedV2: true,
      globalRevision: 1,
      revisions: {
        presentation: 1,
        executor: 1,
        roles: 1,
        model: 1,
        identity: 1,
        memory: 1,
      },
      presentation: {
        agentName: "Moco",
        workbenchName: "Moco's table",
      },
      executor: {
        maxConcurrentWorkers: 3,
        maxSubagentsPerTicket: 4,
        paused: false,
        watchdogMinutes: 5,
        completedTaskDisplayHours: 3,
        autoArchiveEnabled: true,
        autoArchiveDays: 7,
      },
      roles: {},
      model: {
        baseUrl: "https://api.openai.com/v1",
        apiMode: "openai-completions",
        defaultModel: "",
        thinkingLevel: "medium",
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        compaction: { ...DEFAULT_COMPACTION_CONFIG },
        customProviders: [],
        gatewayDisabled: true,
      },
      identity: {
        directory: "",
        directoryRevision: 1,
      },
      memory: {
        enabled: false,
        endpoint: "http://127.0.0.1:8888",
        endpoints: [],
        caCertPem: "",
        routerApiKeyEnv: "MOCO_HINDSIGHT_ROUTER_API_KEY",
        workerApiKeyEnv: "MOCO_HINDSIGHT_WORKER_API_KEY",
        authFile: "",
        autoAttachTopLevelRouters: true,
        banks: {
          private: "moco-core",
          shared: "moco-shared",
        },
      },
      expression: null,
      snapshots: [],
    }) as MocoDurableSettings & JsonObject,
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 16,
});

function cleanJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function bindingFromExternalClient(client: ExternalClientConnection): ExternalAgentBinding {
  return {
    kind: client.kind,
    envId: client.envId,
    ...(client.executable ? { executable: client.executable } : {}),
    ...(client.agentRef ? { agentRef: client.agentRef } : {}),
    ...(client.cdpUrl ? { cdpUrl: client.cdpUrl } : {}),
    ...(client.experimental !== undefined ? { experimental: client.experimental } : {}),
    ...(client.version ? { version: client.version } : {}),
    ...(client.verifiedAt !== undefined ? { verifiedAt: client.verifiedAt } : {}),
    ...(client.capabilities ? { capabilities: cleanJson(client.capabilities) } : {}),
  };
}

export function syncExternalClientsInSettings(
  doc: MocoDurableSettings,
  clientModels?: Record<string, ExternalAgentModelInfo[]>,
  removeClientIds?: readonly string[],
): void {
  const existing = doc.externalClients ? cleanJson(doc.externalClients) : {};
  for (const clientId of removeClientIds ?? []) {
    delete existing[clientId];
  }
  for (const role of Object.values(doc.roles)) {
    if (!role.external) continue;
    const clientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
    const prior = existing[clientId];
    const suppliedModels = clientModels?.[clientId];
    existing[clientId] = {
      id: clientId,
      kind: role.external.kind,
      envId: role.external.envId,
      ...(prior?.label ? { label: prior.label } : {}),
      ...(role.external.executable ? { executable: role.external.executable } : {}),
      ...(role.external.agentRef ? { agentRef: role.external.agentRef } : {}),
      ...(role.external.cdpUrl ? { cdpUrl: role.external.cdpUrl } : {}),
      ...(role.external.experimental !== undefined ? { experimental: role.external.experimental } : {}),
      ...(role.external.version ? { version: role.external.version } : {}),
      ...(role.external.verifiedAt !== undefined ? { verifiedAt: role.external.verifiedAt } : {}),
      ...(role.external.capabilities ? { capabilities: cleanJson(role.external.capabilities) } : {}),
      models: suppliedModels ? cleanJson(suppliedModels) : prior?.models ?? [],
      updatedAt: prior?.updatedAt ?? Date.now(),
    };
  }
  if (Object.keys(existing).length > 0) doc.externalClients = existing;
  else delete doc.externalClients;
}

export function normalizeMemoryConfig(value: HindsightMemoryConfig): HindsightMemoryConfig {
  const legacy = value as HindsightMemoryConfig & { apiKey?: string; apiKeyEnv?: string };
  const routerKey = value.routerApiKey ?? legacy.apiKey;
  return {
    accessMode: value.accessMode === "scoped" || value.accessMode === "private-only" ? value.accessMode : "moco",
    enabled: Boolean(value.enabled),
    endpoint: value.endpoint || "http://127.0.0.1:8888",
    endpoints: Array.isArray(value.endpoints) ? [...value.endpoints] : [],
    caCertPem: value.caCertPem ?? "",
    ...(routerKey ? { routerApiKey: routerKey } : {}),
    ...(value.workerApiKey ? { workerApiKey: value.workerApiKey } : {}),
    ...(value.sharedReadApiKey ? { sharedReadApiKey: value.sharedReadApiKey } : {}),
    sharedReadApiKeyEnv: value.sharedReadApiKeyEnv ?? "MOCO_HINDSIGHT_SHARED_READ_API_KEY",
    ...(value.sharedReadApiKeyDisabled ? { sharedReadApiKeyDisabled: true } : {}),
    routerApiKeyEnv: value.routerApiKeyEnv ?? legacy.apiKeyEnv ?? "MOCO_HINDSIGHT_ROUTER_API_KEY",
    workerApiKeyEnv: value.workerApiKeyEnv ?? "MOCO_HINDSIGHT_WORKER_API_KEY",
    ...(value.routerApiKeyDisabled ? { routerApiKeyDisabled: true } : {}),
    ...(value.workerApiKeyDisabled ? { workerApiKeyDisabled: true } : {}),
    authFile: value.authFile ?? "",
    autoAttachTopLevelRouters: value.autoAttachTopLevelRouters !== false,
    banks: { private: value.banks?.private ?? "moco-core", shared: value.banks?.shared ?? "moco-shared" },
  };
}

function memoryOrigins(memory: Pick<HindsightMemoryConfig, "endpoint" | "endpoints">): string {
  return [...new Set([memory.endpoint, ...memory.endpoints].map((raw) => {
    let parsed: URL;
    try { parsed = new URL(raw); } catch {
      throw new SettingsUpdateError(400, "Hindsight 服务端点必须是有效的 HTTP/HTTPS 地址。");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new SettingsUpdateError(400, "Hindsight 服务端点不能包含凭据、查询参数或片段。");
    }
    return parsed.origin;
  }))].sort().join("\n");
}

function bindMemoryFallbackOrigins(memory: HindsightMemoryConfig, runtime: HindsightMemoryConfig): void {
  if (memoryOrigins(memory) !== memoryOrigins(runtime)) {
    if (!memory.routerApiKey) memory.routerApiKeyDisabled = true;
    if (!memory.workerApiKey) memory.workerApiKeyDisabled = true;
    if (!memory.sharedReadApiKey) memory.sharedReadApiKeyDisabled = true;
  }
}

export function hydrateSettingsFromConfig(
  doc: MocoDurableSettings,
  config: MocoHubConfig,
  options?: { hasGatewayCredential?: boolean },
): void {
  if (!doc.initialized) {
    doc.initialized = true;
    doc.rolesMigratedV2 = true;
    doc.rolesMigratedV3 = true;
    doc.rolesMigratedV4 = true;
    doc.gatewayMigratedV2 = true;
    doc.presentation = cleanJson(config.presentation);
    doc.executor = {
      maxConcurrentWorkers: config.maxConcurrentWorkers,
      maxSubagentsPerTicket: config.maxSubagentsPerTicket,
      paused: false,
      watchdogMinutes: config.watchdogMinutes,
      completedTaskDisplayHours: config.completedTaskDisplayHours === undefined ? 3 : config.completedTaskDisplayHours,
      autoArchiveEnabled: true,
      autoArchiveDays: 7,
    };
    doc.roles = cleanJson(config.roles);
    syncExternalClientsInSettings(doc);
    doc.model = cleanJson({
      baseUrl: config.model.baseUrl,
      apiMode: config.model.apiMode,
      ...sanitizeVertexConfig(config.model, config.model.apiMode, config.model.baseUrl),
      ...(config.model.defaultProvider !== undefined
        ? { defaultProvider: config.model.defaultProvider }
        : {}),
      defaultModel: config.model.defaultModel,
      thinkingLevel: config.model.thinkingLevel,
      contextWindow: config.model.contextWindow,
      compaction: config.model.compaction,
      customProviders: config.model.customProviders,
      ...(config.model.subscriptionModels !== undefined ? { subscriptionModels: sanitizeSubscriptionModels(config.model.subscriptionModels) } : {}),
      ...(config.model.gatewayName !== undefined ? { gatewayName: config.model.gatewayName } : {}),
      ...(config.model.gatewayModels !== undefined ? { gatewayModels: config.model.gatewayModels } : {}),
      ...(config.model.gatewayDisabled !== undefined ? { gatewayDisabled: config.model.gatewayDisabled } : {}),
      ...(config.model.apiKey ? { apiKey: config.model.apiKey } : {}),
    });
    const defaultIdentity = path.join(config.stateDir, "identity");
    doc.identity = {
      directory: config.identityDir === defaultIdentity ? "" : config.identityDir,
      directoryRevision: 1,
    };
    doc.memory = normalizeMemoryConfig(config.memory);
    return;
  }

  if (!doc.identity) {
    const defaultIdentity = path.join(config.stateDir, "identity");
    doc.identity = {
      directory: config.identityDir === defaultIdentity ? "" : config.identityDir,
      directoryRevision: 1,
    };
  }
  doc.revisions.identity ??= 1;

  // Upgrade older persisted SQLite settings docs in place
  doc.executor = normalizeExecutorConfig(
    doc.executor,
    config.maxConcurrentWorkers,
    config.watchdogMinutes,
    config.maxSubagentsPerTicket,
    config.completedTaskDisplayHours,
  );
  doc.model = normalizeModelConfig(doc.model);

  const upgradeRoleTexts = (id: string, target: RolePreset, existing: RolePreset): RolePreset => {
    const historical = HISTORICAL_DEFAULT_ROLE_TEXTS[id];
    const isHistoricalLabel = Boolean(historical?.labels.includes(existing.label));
    const isHistoricalWhen = Boolean(historical?.whenToUse.includes(existing.whenToUse));
    const isHistoricalPrompt = Boolean(historical?.prompts.includes(existing.prompt));
    return {
      ...existing,
      id,
      label: isHistoricalLabel || !existing.label?.trim() ? target.label : existing.label,
      whenToUse: isHistoricalWhen || !existing.whenToUse?.trim() ? target.whenToUse : existing.whenToUse,
      prompt: isHistoricalPrompt || !existing.prompt?.trim() ? target.prompt : existing.prompt,
    };
  };

  if (!doc.rolesMigratedV3) {
    const freshDefaults = defaultRolePresets();
    const prevRoles = doc.roles ?? {};
    const migrated: Record<string, RolePreset> = {};
    const carryOverrides = (id: string, target: RolePreset, legacy: RolePreset | undefined): RolePreset => {
      if (!legacy) return { ...target };
      const merged: RolePreset = {
        ...target,
        ...(legacy.provider ? { provider: legacy.provider } : {}),
        ...(legacy.modelId ? { modelId: legacy.modelId } : {}),
        ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
        ...(legacy.readOnly !== undefined ? { readOnly: legacy.readOnly } : {}),
        ...(legacy.allowSubagents !== undefined ? { allowSubagents: legacy.allowSubagents } : {}),
        ...(legacy.thinkingLevel !== undefined ? { thinkingLevel: legacy.thinkingLevel } : {}),
        ...(legacy.dispatchPolicy ? { dispatchPolicy: cleanJson(legacy.dispatchPolicy) } : {}),
      };
      return upgradeRoleTexts(id, target, {
        ...merged,
        label: legacy.label,
        whenToUse: legacy.whenToUse,
        prompt: legacy.prompt,
      });
    };
    for (const [id, preset] of Object.entries(freshDefaults)) {
      const legacyMatch =
        id === "coder"
          ? prevRoles.coder ?? prevRoles.engineer
          : id === "checker"
            ? prevRoles.checker ?? prevRoles.reviewer
            : id === "scout"
              ? prevRoles.scout ?? prevRoles.explorer
              : prevRoles[id];
      migrated[id] = carryOverrides(id, preset, legacyMatch);
    }
    const legacyDefaultIds = new Set([
      "architect",
      "engineer",
      "writer",
      "scout",
      "coder",
      "checker",
      "designer",
      "reviewer",
      "explorer",
    ]);
    for (const [id, custom] of Object.entries(prevRoles)) {
      if (!legacyDefaultIds.has(id)) {
        migrated[id] = cleanJson(custom);
      }
    }
    doc.roles = migrated;
    doc.rolesMigratedV2 = true;
    doc.rolesMigratedV3 = true;
    doc.rolesMigratedV4 = true;
  } else if (!doc.rolesMigratedV4) {
    const freshDefaults = defaultRolePresets();
    const upgradePool = (pool: Record<string, RolePreset> | undefined) => {
      if (!pool) return;
      for (const [id, preset] of Object.entries(freshDefaults)) {
        const existing = pool[id];
        if (!existing || existing.external) continue;
        pool[id] = upgradeRoleTexts(id, preset, existing);
      }
    };
    upgradePool(doc.roles);
    for (const snap of doc.snapshots ?? []) {
      upgradePool(snap.previousState?.roles);
    }
    doc.rolesMigratedV4 = true;
  }
  syncExternalClientsInSettings(doc);

  // Keep env-supplied API keys in sync if none stored inline
  if (
    !doc.model.apiKey && config.model.apiKey &&
    new URL(doc.model.baseUrl).origin === new URL(config.model.baseUrl).origin
  ) {
    doc.model.apiKey = config.model.apiKey;
  }
  if (!doc.gatewayMigratedV2) {
    const gatewayUnused =
      !doc.model.gatewayDisabled &&
      !doc.model.apiKey &&
      !options?.hasGatewayCredential &&
      !config.model.apiKey &&
      !(doc.model.gatewayModels && doc.model.gatewayModels.length > 0) &&
      !doc.model.gatewayName &&
      normalizeProviderBaseUrl(doc.model.baseUrl, doc.model.apiMode) === "https://api.openai.com/v1" &&
      doc.model.apiMode === "openai-completions" &&
      doc.model.defaultProvider !== "moco-gateway" &&
      !(doc.model.defaultModel.trim() && !doc.model.defaultProvider) &&
      !Object.values(doc.roles ?? {}).some(
        (role) =>
          !role.external &&
          (role.provider === "moco-gateway" || (!role.provider && Boolean(role.modelId?.trim()))),
      );
    if (gatewayUnused) {
      doc.model.gatewayDisabled = true;
    }
    doc.gatewayMigratedV2 = true;
  }
  doc.memory = normalizeMemoryConfig(doc.memory);
  if (memoryOrigins(doc.memory) === memoryOrigins(config.memory)) {
    if (!doc.memory.routerApiKeyDisabled && !doc.memory.routerApiKey && config.memory.routerApiKey) {
      doc.memory.routerApiKey = config.memory.routerApiKey;
    }
    if (!doc.memory.workerApiKeyDisabled && !doc.memory.workerApiKey && config.memory.workerApiKey) {
      doc.memory.workerApiKey = config.memory.workerApiKey;
    }
  } else {
    // A startup environment belongs to its configured service, not a persisted different origin.
    bindMemoryFallbackOrigins(doc.memory, config.memory);
  }
  for (const snapshot of doc.snapshots) snapshot.previousState.memory = normalizeMemoryConfig(snapshot.previousState.memory);
}

export function resolveEffectiveIdentityDir(
  doc: Readonly<MocoDurableSettings>,
  defaultIdentityDir: string,
): string {
  const custom = doc.identity.directory?.trim();
  return custom ? path.resolve(custom) : defaultIdentityDir;
}

export function toPublicSettingsView(
  doc: Readonly<MocoDurableSettings>,
  defaultIdentityDir: string,
): MocoSettingsView {
  const normalizedModel = normalizeModelConfig(doc.model);
  const normalizedExecutor = normalizeExecutorConfig(doc.executor);
  const { apiKey: modelKey, ...publicModel } = normalizedModel;
  const memory = normalizeMemoryConfig(doc.memory);
  const { routerApiKey: _routerKey, workerApiKey: _workerKey, sharedReadApiKey: _sharedReadKey, ...publicMemory } = memory;

  return {
    globalRevision: doc.globalRevision,
    ...(doc.externalClients && Object.keys(doc.externalClients).length
      ? { externalClients: cleanJson(doc.externalClients) }
      : {}),
    blocks: {
      presentation: {
        revision: doc.revisions.presentation,
        value: { ...doc.presentation },
      },
      executor: {
        revision: doc.revisions.executor,
        value: normalizedExecutor,
      },
      roles: {
        revision: doc.revisions.roles,
        value: cleanJson(doc.roles),
      },
      model: {
        revision: doc.revisions.model,
        value: cleanJson(publicModel),
        hasApiKey: Boolean(
          modelKey ||
            process.env.MOCO_API_KEY?.trim() ||
            process.env.OPENAI_API_KEY?.trim(),
        ),
      },
      identity: {
        revision: doc.revisions.identity,
        value: { directory: doc.identity.directory },
        effectiveDirectory: resolveEffectiveIdentityDir(doc, defaultIdentityDir),
        directoryRevision: doc.identity.directoryRevision,
      },
      memory: {
        revision: doc.revisions.memory,
        value: cleanJson(publicMemory),
        hasRouterApiKey: Boolean(resolveHindsightToken(memory, "router")),
        hasWorkerApiKey: Boolean(resolveHindsightToken(memory, "worker")),
        hasSharedReadApiKey: Boolean(resolveHindsightSharedReadToken(memory)),
      },
    },
    history: doc.snapshots
      .slice(-20)
      .reverse()
      .map(({ revision, block, summary, savedAt }) => ({
        revision,
        block,
        summary,
        savedAt,
      })),
  };
}

export class SettingsUpdateError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SettingsUpdateError";
  }
}

export function applySettingsBlockUpdate(
  doc: MocoDurableSettings,
  block: SettingsBlockName,
  expectedRevision: number,
  rawValue: unknown,
  options: { externalAgents?: boolean; clientModels?: Record<string, ExternalAgentModelInfo[]>; removeClientIds?: readonly string[] } = {},
): string {
  if (doc.revisions[block] !== expectedRevision) {
    throw new SettingsUpdateError(
      409,
      `配置项 "${block}" 已被其他操作更新（期望版本 v${expectedRevision}，当前 v${doc.revisions[block]}），请刷新后重试。`,
    );
  }
  if (!rawValue || typeof rawValue !== "object") {
    throw new SettingsUpdateError(400, "无效的配置载荷。");
  }

  const prevSnapshot = cleanJson({
    presentation: doc.presentation,
    executor: doc.executor,
    roles: doc.roles,
    ...(doc.externalClients ? { externalClients: doc.externalClients } : {}),
    model: doc.model,
    identityDirectory: doc.identity.directory,
    memory: doc.memory,
  });

  const val = rawValue as Record<string, unknown>;
  let summary = "";

  switch (block) {
    case "presentation": {
      const agentName = String(val.agentName ?? "").trim();
      const workbenchName = String(val.workbenchName ?? "").trim();
      if (!agentName || agentName.length > 80 || !workbenchName || workbenchName.length > 120) {
        throw new SettingsUpdateError(400, "显示名称不能为空且长度需在限制范围内。");
      }
      doc.presentation = { agentName, workbenchName };
      summary = `更新智能体名称为「${agentName}」`;
      break;
    }

    case "executor": {
      const rawWorkers = val.maxConcurrentWorkers ?? val.normalSlots;
      const maxConcurrentWorkers = Number(rawWorkers);
      const prevExecutor = normalizeExecutorConfig(doc.executor);
      const maxSubagentsPerTicket =
        val.maxSubagentsPerTicket !== undefined
          ? Number(val.maxSubagentsPerTicket)
          : prevExecutor.maxSubagentsPerTicket;
      const watchdogMinutes =
        val.watchdogMinutes !== undefined
          ? Number(val.watchdogMinutes)
          : prevExecutor.watchdogMinutes;
      const completedTaskDisplayHours = val.completedTaskDisplayHours === undefined
        ? prevExecutor.completedTaskDisplayHours === undefined ? 3 : prevExecutor.completedTaskDisplayHours
        : val.completedTaskDisplayHours;
      if (completedTaskDisplayHours !== null &&
        completedTaskDisplayHours !== 1 && completedTaskDisplayHours !== 3 && completedTaskDisplayHours !== 6) {
        throw new SettingsUpdateError(400, "已完成任务显示时长需为 1、3、6 小时或一直显示。");
      }
      const autoArchiveEnabled = val.autoArchiveEnabled === undefined ? prevExecutor.autoArchiveEnabled! : val.autoArchiveEnabled;
      const autoArchiveDays = val.autoArchiveDays === undefined ? prevExecutor.autoArchiveDays! : val.autoArchiveDays;
      if (typeof autoArchiveEnabled !== "boolean") {
        throw new SettingsUpdateError(400, "自动归档开关需为开启或关闭。");
      }
      if (typeof autoArchiveDays !== "number" || !Number.isSafeInteger(autoArchiveDays) || autoArchiveDays < 1 || autoArchiveDays > 3650) {
        throw new SettingsUpdateError(400, "自动归档天数需为 1~3650 的整数。");
      }
      const paused = Boolean(val.paused);
      if (
        !Number.isInteger(maxConcurrentWorkers) ||
        maxConcurrentWorkers < 1 ||
        maxConcurrentWorkers > 16 ||
        !Number.isInteger(maxSubagentsPerTicket) ||
        maxSubagentsPerTicket < 1 ||
        maxSubagentsPerTicket > 8 ||
        !Number.isInteger(watchdogMinutes) ||
        watchdogMinutes < 0 ||
        watchdogMinutes > 60
      ) {
        throw new SettingsUpdateError(
          400,
          "并发 Worker 上限需为 1~16 的整数，单任务子智能体上限需为 1~8 的整数，巡检超时需为 0~60 的整数分钟。",
        );
      }
      doc.executor = {
        maxConcurrentWorkers,
        maxSubagentsPerTicket,
        paused,
        watchdogMinutes,
        completedTaskDisplayHours,
        autoArchiveEnabled,
        autoArchiveDays,
      };
      summary = `并发上限 ${maxConcurrentWorkers} · 子智能体 ${maxSubagentsPerTicket} · 巡检${watchdogMinutes > 0 ? ` ${watchdogMinutes} 分钟` : "关闭"} · 已完成任务${completedTaskDisplayHours === null ? "一直显示" : `显示 ${completedTaskDisplayHours} 小时`} · 自动归档${autoArchiveEnabled ? ` ${autoArchiveDays} 天` : "关闭"}${paused ? "（已暂停新派单）" : ""}`;
      break;
    }

    case "roles": {
      if (!options.externalAgents) {
        for (const [id, current] of Object.entries(doc.roles)) {
          if (!current.external) continue;
          const clientId = current.externalClientId?.trim() || externalClientConnectionId(current.external);
          const connected = doc.externalClients?.[clientId];
          const nextEntry = (val as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
          if (!connected) {
            if (!isDeepStrictEqual(current, nextEntry)) {
              throw new SettingsUpdateError(400, "外部智能体请通过智能体页面右侧对话修改。");
            }
            continue;
          }
          if (!nextEntry) continue;
          if (!nextEntry.external && !nextEntry.externalClientId) {
            throw new SettingsUpdateError(400, "外部智能体不能直接转换为内部智能体。");
          }
          if (!isDeepStrictEqual(current.dispatchPolicy, nextEntry.dispatchPolicy)) {
            throw new SettingsUpdateError(400, "外部智能体请通过智能体页面右侧对话修改。");
          }
        }
      }
      const nextRoles: Record<string, RolePreset> = {};
      const updatedClientBindings = new Map<string, ExternalAgentBinding>();
      for (const [roleId, entry] of Object.entries(val)) {
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(roleId) || !entry || typeof entry !== "object") {
          throw new SettingsUpdateError(400, `角色 ID "${roleId}" 格式非法（需小写字母开头，40 字符内）。`);
        }
        const r = entry as Record<string, unknown>;
        const existingRole = doc.roles[roleId];
        const explicitClientId = typeof r.externalClientId === "string" && r.externalClientId.trim()
          ? r.externalClientId.trim()
          : existingRole?.externalClientId?.trim();
        let externalClientId = explicitClientId;
        let external = r.external as RolePreset["external"];
        if (!options.externalAgents && externalClientId) {
          const connected = doc.externalClients?.[externalClientId];
          if (!connected) throw new SettingsUpdateError(400, "请通过右侧对话连接外部智能体。");
          external = bindingFromExternalClient(connected);
        }
        if (external) {
          if (typeof external !== "object" || Array.isArray(external) || !(EXTERNAL_AGENT_KINDS as readonly unknown[]).includes(external.kind) || typeof external.envId !== "string" || !external.envId.trim() || external.envId.length > 200 ||
              Object.keys(external).some((key) => !["kind", "envId", "executable", "agentRef", "cdpUrl", "experimental", "version", "verifiedAt", "capabilities"].includes(key))) {
            throw new SettingsUpdateError(400, "外部智能体连接配置无效。");
          }
          if (external.executable !== undefined && (typeof external.executable !== "string" || !external.executable || !/^(?:\/|[A-Za-z]:[\\/])/.test(external.executable) || /[\x00-\x1f]/.test(external.executable))) throw new SettingsUpdateError(400, "客户端路径必须是绝对路径。");
          if (external.experimental !== undefined && typeof external.experimental !== "boolean" ||
              external.agentRef !== undefined && (typeof external.agentRef !== "string" || !external.agentRef.trim() || external.agentRef.length > 200 || /[\x00-\x1f]/.test(external.agentRef)) ||
              external.version !== undefined && (typeof external.version !== "string" || external.version.length > 200 || /[\x00-\x1f]/.test(external.version)) ||
              external.verifiedAt !== undefined && (typeof external.verifiedAt !== "number" || !Number.isFinite(external.verifiedAt) || external.verifiedAt <= 0)) throw new SettingsUpdateError(400, "外部智能体连接信息无效。");
          const derivedClientId = externalClientId || externalClientConnectionId(external);
          const connected = doc.externalClients?.[derivedClientId];
          if (!options.externalAgents && !existingRole?.external && !connected) {
            throw new SettingsUpdateError(400, "请通过右侧对话连接外部智能体。");
          }
          if (!options.externalAgents && connected) {
            external = bindingFromExternalClient(connected);
          }
          externalClientId = derivedClientId;
          if (external.cdpUrl !== undefined) {
            let url: URL;
            try { url = new URL(external.cdpUrl); } catch { throw new SettingsUpdateError(400, "实验调试地址无效。"); }
            if (external.kind !== "grok-bot" || typeof external.cdpUrl !== "string" || url.protocol !== "http:" ||
                !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new SettingsUpdateError(400, "实验调试地址必须是当前设备的回环地址。");
          }
          if (external.capabilities !== undefined) {
            const capabilities = external.capabilities;
            if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) ||
                Object.keys(capabilities).some((key) => !["resume", "cancel", "models", "permissions", "collaboration", "terminalEvidence"].includes(key)) ||
                ["resume", "cancel", "models", "permissions", "collaboration"].some((key) => typeof capabilities[key as keyof typeof capabilities] !== "boolean") ||
                !["native", "observed", "none"].includes(capabilities.terminalEvidence)) throw new SettingsUpdateError(400, "外部智能体能力声明无效。");
          }
          if (r.enabled !== false && (!Number.isFinite(external.verifiedAt) || ["grok-bot", "dots", "muse"].includes(external.kind))) throw new SettingsUpdateError(400, "此连接尚未完成稳定任务通信验证，不能启用自动派发。");
          if (options.externalAgents && (!existingRole?.external || !isDeepStrictEqual(existingRole.external, external))) {
            updatedClientBindings.set(externalClientId, cleanJson(external));
          }
        }
        let dispatchPolicy: RolePreset["dispatchPolicy"];
        if (r.dispatchPolicy !== undefined) {
          if (!external) throw new SettingsUpdateError(400, "默认承接设置仅适用于外部智能体。");
          try { dispatchPolicy = normalizeAgentDispatchPolicy(r.dispatchPolicy); }
          catch (error) { if (error instanceof AgentRoutingError) throw new SettingsUpdateError(error.status, error.message); throw error; }
        }
        const label = String(r.label ?? "").trim();
        const whenToUse = String(r.whenToUse ?? "").trim();
        const prompt = String(r.prompt ?? "").trim();
        if (!label || !whenToUse || !prompt) {
          throw new SettingsUpdateError(400, `角色 "${roleId}" 缺少名称、适用场景或系统提示词。`);
        }
        const provider =
          typeof r.provider === "string" && r.provider.trim()
            ? r.provider.trim()
            : undefined;
        nextRoles[roleId] = {
          id: roleId,
          label,
          whenToUse,
          prompt,
          enabled: r.enabled !== false,
          readOnly: Boolean(r.readOnly),
          allowSubagents: Boolean(r.allowSubagents),
          ...(provider && !external ? { provider } : {}),
          ...(explicitClientId ? { externalClientId: explicitClientId } : {}),
          ...(external ? { external: cleanJson(external) } : {}),
          ...(dispatchPolicy ? { dispatchPolicy } : {}),
          ...(typeof r.modelId === "string" && r.modelId.trim()
            ? { modelId: r.modelId.trim() }
            : {}),
          thinkingLevel: parseRoleThinking(r.thinkingLevel, "auto"),
        };
      }
      if (options.externalAgents && updatedClientBindings.size > 0) {
        for (const role of Object.values(nextRoles)) {
          if (!role.external) continue;
          const cid = role.externalClientId ?? externalClientConnectionId(role.external);
          const updated = updatedClientBindings.get(cid);
          if (updated) {
            role.external = cleanJson(updated);
            if (!Number.isFinite(updated.verifiedAt) || ["grok-bot", "dots", "muse"].includes(updated.kind)) {
              role.enabled = false;
            }
          }
        }
      }
      try { assertAgentDefaultScopes(nextRoles); }
      catch (error) { if (error instanceof AgentRoutingError) throw new SettingsUpdateError(error.status, error.message); throw error; }
      const roleValues = Object.values(nextRoles);
      if (roleValues.length === 0) {
        throw new SettingsUpdateError(400, "至少需要保留一个 Worker 角色预设。");
      }
      if (!roleValues.some((r) => r.enabled !== false)) {
        throw new SettingsUpdateError(400, "至少需要保留一个启用状态的 Worker 角色。");
      }
      for (const role of roleValues) if (!role.external) assertConversationModelSelection(doc.model, role.provider, role.modelId || doc.model.defaultModel);
      doc.roles = nextRoles;
      if (options.externalAgents || doc.externalClients || options.removeClientIds?.length) {
        syncExternalClientsInSettings(doc, options.clientModels, options.removeClientIds);
      }
      normalizeRoleThinkingSelections(doc.roles, doc.model);
      doc.rolesMigratedV2 = true;
      doc.rolesMigratedV3 = true;
      doc.rolesMigratedV4 = true;
      summary = `更新 Worker 角色与模型预设（共 ${roleValues.length} 个角色）`;
      break;
    }

    case "model": {
      const prevModel = normalizeModelConfig(doc.model);
      const apiMode =
        val.apiMode !== undefined
          ? coerceCustomProviderApi(val.apiMode)
          : prevModel.apiMode;
      if (!apiMode) {
        throw new SettingsUpdateError(
          400,
          `不支持的协议类型 "${String(val.apiMode ?? "").trim()}"。`,
        );
      }
      const customProviders =
        val.customProviders !== undefined
          ? sanitizeCustomProviders(val.customProviders)
          : prevModel.customProviders ?? [];
      const subscriptionModels = val.subscriptionModels !== undefined
        ? sanitizeSubscriptionModels(val.subscriptionModels)
        : prevModel.subscriptionModels;
      const prevCustomIds = new Set((prevModel.customProviders ?? []).map((p) => p.id));
      const nextCustomIds = new Set(customProviders.map((p) => p.id));

      let defaultModel = String(val.defaultModel ?? prevModel.defaultModel).trim();
      let defaultProvider =
        typeof val.defaultProvider === "string"
          ? val.defaultProvider.trim()
          : prevModel.defaultProvider;
      if (defaultProvider && prevCustomIds.has(defaultProvider) && !nextCustomIds.has(defaultProvider)) {
        defaultProvider = "";
        defaultModel = "";
      }
      if (
        val.gatewayDisabled === true &&
        val.defaultProvider !== "moco-gateway" &&
        (defaultProvider === "moco-gateway" || (!defaultProvider && Boolean(defaultModel)))
      ) {
        defaultProvider = "";
        defaultModel = "";
      }

      const gatewayDisabled =
        (val.gatewayDisabled !== undefined
          ? Boolean(val.gatewayDisabled)
          : Boolean(prevModel.gatewayDisabled)) &&
        (defaultProvider || (defaultModel ? "moco-gateway" : undefined)) !== "moco-gateway";

      const rawBaseUrl = val.baseUrl !== undefined
        ? String(val.baseUrl)
        : prevModel.baseUrl || "https://api.openai.com/v1";
      const baseUrl = normalizeProviderBaseUrl(rawBaseUrl, apiMode);
      if (!gatewayDisabled || val.baseUrl !== undefined) {
        try {
          const parsed = new URL(baseUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Invalid protocol");
          }
        } catch {
          throw new SettingsUpdateError(400, "默认兼容网关的接口地址格式无效。");
        }
      }
      const vertex = sanitizeVertexConfig({
        vertexProject: val.vertexProject !== undefined ? val.vertexProject : prevModel.vertexProject,
        vertexLocation: val.vertexLocation !== undefined ? val.vertexLocation : prevModel.vertexLocation,
      }, apiMode, baseUrl);
      const thinkingLevel = parseThinking(
        typeof val.thinkingLevel === "string" ? val.thinkingLevel : undefined,
        prevModel.thinkingLevel,
      );
      const contextWindow = clampInt(
        val.contextWindow ?? prevModel.contextWindow,
        prevModel.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        4096,
        10_000_000,
      );
      const compaction = normalizeCompactionConfig(
        val.compaction ?? prevModel.compaction,
        prevModel.compaction ?? DEFAULT_COMPACTION_CONFIG,
      );
      const gatewayName =
        val.gatewayName !== undefined
          ? typeof val.gatewayName === "string" && val.gatewayName.trim()
            ? val.gatewayName.trim().slice(0, 80)
            : undefined
          : prevModel.gatewayName;
      const gatewayModels =
        val.gatewayModels !== undefined
          ? sanitizeCustomModelList(val.gatewayModels, apiMode)
          : prevModel.gatewayModels;
      const clearApiKey = val.clearApiKey === true;
      const sameOrigin = (() => {
        try {
          return new URL(baseUrl).origin === new URL(prevModel.baseUrl).origin;
        } catch {
          return false;
        }
      })();
      const nextApiKey = clearApiKey
        ? undefined
        : typeof val.apiKey === "string" && val.apiKey.trim()
          ? val.apiKey.trim()
          : sameOrigin
            ? doc.model.apiKey
            : undefined;

      const nextModel: ModelGatewayConfig = {
        baseUrl,
        apiMode,
        ...vertex,
        ...(defaultProvider !== undefined ? { defaultProvider } : {}),
        defaultModel,
        thinkingLevel,
        contextWindow,
        compaction,
        customProviders,
        ...(subscriptionModels !== undefined ? { subscriptionModels } : {}),
        ...(gatewayName ? { gatewayName } : {}),
        ...(gatewayModels ? { gatewayModels } : {}),
        ...(gatewayDisabled ? { gatewayDisabled: true } : {}),
        ...(nextApiKey ? { apiKey: nextApiKey } : {}),
      };
      assertConversationModelSelection(nextModel, nextModel.defaultProvider, nextModel.defaultModel);
      for (const role of Object.values(doc.roles)) if (!role.external) assertConversationModelSelection(nextModel, role.provider, role.modelId || nextModel.defaultModel);
      doc.model = nextModel;
      const selected = configuredModel(doc.model, doc.model.defaultProvider, doc.model.defaultModel);
      if (selected?.reasoning === false || selected?.thinkingEnabled === false) {
        doc.model.thinkingLevel = "off";
      } else if (!isValidThinkingSelection(selected, doc.model.thinkingLevel)) {
        doc.model.thinkingLevel = selected?.thinkingLevels?.find((option) => option.value === "off")?.id ??
          selected?.thinkingLevels?.[0]?.id ?? "off";
      }
      const rolesCleaned = cleanupRemovedRoleModels(doc.roles, prevModel, doc.model);
      const rolesThinkingNormalized = normalizeRoleThinkingSelections(doc.roles, doc.model);
      if (rolesCleaned || rolesThinkingNormalized) doc.revisions.roles += 1;
      summary = `更新模型配置（${defaultProvider ? `${defaultProvider}/` : ""}${defaultModel || "未选择模型"}）`;
      break;
    }

    case "identity": {
      const directory = String(val.directory ?? "").trim();
      if (directory && (!path.isAbsolute(directory) || directory.includes("\0"))) {
        throw new SettingsUpdateError(400, "身份自定义目录必须为绝对路径（留空则使用默认目录）。");
      }
      if (directory !== doc.identity.directory) {
        doc.identity.directory = directory;
        doc.identity.directoryRevision += 1;
      }
      summary = directory ? "切换自定义身份目录" : "恢复默认身份目录";
      break;
    }

    case "memory": {
      const enabled = Boolean(val.enabled);
      const endpoint = String(val.endpoint ?? "http://127.0.0.1:8888").trim() || "http://127.0.0.1:8888";
      const endpoints = Array.isArray(val.endpoints)
        ? val.endpoints.map((e) => String(e).trim()).filter(Boolean).slice(0, 8)
        : [];
      const banksObj = (val.banks ?? {}) as Record<string, unknown>;
      const priv = String(banksObj.private ?? "moco-core").trim();
      const shared = String(banksObj.shared ?? "moco-shared").trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(priv) ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(shared) ||
          priv.toLowerCase() === shared.toLowerCase()) {
        throw new SettingsUpdateError(
          400,
          "Hindsight 私有库（private）与共享库（shared）名称不能为空且必须互不相同。",
        );
      }
      const previous = normalizeMemoryConfig(doc.memory);
      const changedOrigin = memoryOrigins(previous) !== memoryOrigins({ endpoint, endpoints });
      const next: HindsightMemoryConfig = {
        accessMode: val.accessMode === "scoped" || val.accessMode === "private-only" ? val.accessMode : "moco",
        enabled,
        endpoint,
        endpoints,
        caCertPem: typeof val.caCertPem === "string" ? val.caCertPem : "",
        routerApiKeyEnv: String(val.routerApiKeyEnv ?? previous.routerApiKeyEnv).trim(),
        workerApiKeyEnv: String(val.workerApiKeyEnv ?? previous.workerApiKeyEnv).trim(),
        sharedReadApiKeyEnv: String(val.sharedReadApiKeyEnv ?? previous.sharedReadApiKeyEnv ?? "MOCO_HINDSIGHT_SHARED_READ_API_KEY").trim(),
        authFile: String(val.authFile ?? "").trim(),
        autoAttachTopLevelRouters: val.autoAttachTopLevelRouters !== false,
        banks: { private: priv, shared },
      };
      for (const role of ["router", "worker", "sharedRead"] as const) {
        const keyField = role === "router" ? "routerApiKey" : role === "worker" ? "workerApiKey" : "sharedReadApiKey";
        const disabledField = role === "router" ? "routerApiKeyDisabled" : role === "worker" ? "workerApiKeyDisabled" : "sharedReadApiKeyDisabled";
        const clearField = role === "router" ? "clearRouterApiKey" : role === "worker" ? "clearWorkerApiKey" : "clearSharedReadApiKey";
        const supplied = typeof val[keyField] === "string" ? val[keyField].trim() : "";
        if (supplied && !/^[\x21-\x7e]{32,8192}$/.test(supplied)) {
          throw new SettingsUpdateError(400, "记忆密钥必须为 32–8192 位非空格 ASCII 字符。");
        }
        if (val[clearField] === true) {
          next[disabledField] = true;
        } else if (supplied) {
          next[keyField] = supplied;
        } else if (changedOrigin || previous[disabledField]) {
          next[disabledField] = true;
        } else if (previous[keyField]) {
          next[keyField] = previous[keyField];
        }
      }
      const routerKey = resolveHindsightToken(next, "router");
      const workerKey = resolveHindsightToken(next, "worker");
      if (routerKey && workerKey && routerKey === workerKey) {
        throw new SettingsUpdateError(400, "密钥与公开目录密钥必须不同。");
      }
      if (enabled && (!routerKey || next.accessMode !== "private-only" && !workerKey)) {
        const message = next.accessMode === "private-only"
          ? changedOrigin ? "服务地址已变更，请重新填写密钥。" : "启用长期记忆前，请填写密钥。"
          : changedOrigin ? "服务地址已变更，请重新填写密钥和公开目录密钥。" : "启用长期记忆前，请填写密钥和公开目录密钥。";
        throw new SettingsUpdateError(400, message);
      }
      const sharedReadKey = resolveHindsightSharedReadToken(next);
      if (next.accessMode === "scoped" && enabled && (!sharedReadKey || sharedReadKey === routerKey || sharedReadKey === workerKey)) {
        throw new SettingsUpdateError(400, "受限凭据模式需要独立的共享库只读密钥。");
      }
      doc.memory = next;
      summary = `${enabled ? "启用" : "关闭"} Hindsight 长期记忆（${priv} / ${shared}）`;
      break;
    }
  }

  doc.globalRevision += 1;
  doc.revisions[block] += 1;
  rememberSettingsSnapshot(doc, {
    revision: doc.globalRevision,
    block,
    summary,
    savedAt: Date.now(),
    previousState: prevSnapshot,
  });
  return summary;
}

export function rollbackSettingsToSnapshot(
  doc: MocoDurableSettings,
  targetSnapshotRevision: number,
  expectedGlobalRevision: number,
  runtimeMemory?: HindsightMemoryConfig,
): string {
  if (doc.globalRevision !== expectedGlobalRevision) {
    throw new SettingsUpdateError(409, "配置在撤销前已发生变动，请刷新后重试。");
  }
  const snap = doc.snapshots.find((s) => s.revision === targetSnapshotRevision);
  if (!snap) {
    throw new SettingsUpdateError(400, `未找到版本 v${targetSnapshotRevision} 的历史快照。`);
  }

  const prevSnapshot = cleanJson({
    presentation: doc.presentation,
    executor: doc.executor,
    roles: doc.roles,
    ...(doc.externalClients ? { externalClients: doc.externalClients } : {}),
    model: doc.model,
    identityDirectory: doc.identity.directory,
    memory: doc.memory,
  });

  doc.presentation = cleanJson(snap.previousState.presentation);
  doc.executor = normalizeExecutorConfig(cleanJson(snap.previousState.executor));
  doc.roles = cleanJson(snap.previousState.roles);
  doc.externalClients = snap.previousState.externalClients ? cleanJson(snap.previousState.externalClients) : undefined;
  doc.model = normalizeModelConfig(cleanJson(snap.previousState.model));
  const nextIdentityDirectory = snap.previousState.identityDirectory ?? "";
  if (doc.identity.directory !== nextIdentityDirectory) {
    doc.identity.directory = nextIdentityDirectory;
    doc.identity.directoryRevision += 1;
  }
  doc.memory = normalizeMemoryConfig(snap.previousState.memory);
  if (runtimeMemory) bindMemoryFallbackOrigins(doc.memory, runtimeMemory);

  doc.globalRevision += 1;
  for (const k of Object.keys(doc.revisions) as SettingsBlockName[]) {
    doc.revisions[k] += 1;
  }

  const summary = `撤销配置变更至 v${targetSnapshotRevision} 之前的状态`;
  rememberSettingsSnapshot(doc, {
    revision: doc.globalRevision,
    block: snap.block,
    summary,
    savedAt: Date.now(),
    previousState: prevSnapshot,
  });
  return summary;
}
