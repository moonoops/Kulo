/**
 * Durable Runtime Settings Document (`KuloSettingsDoc`) with per-block Revision CAS,
 * Secret-Free Public Projection, and Snapshot Rollback History.
 */
import fs from "node:fs";
import path from "node:path";
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { migrateSettingsRolesOnHydrate } from "./settings-role-migration.js";
import {
  CUSTOM_PROVIDER_APIS,
  isConversationModel, supportsKeylessLocalModel,
  isImageGenerationModel,
  MODEL_PROTOCOL_ADAPTERS,
  MODEL_PURPOSES,
  normalizeImageGenerationParameters,
  normalizeKuloLanguage,
  normalizeVertexConfig,
  buildVertexModelBaseUrl,
  validateCustomImageAdapter,
  validateImageModelProfile,
  VertexConfigError,
  type AgentExpressionState,
  type CompactionConfig,
  type CustomModelConfig,
  type CustomProviderApi,
  type CustomProviderConfig,
  type ExecutorSlotsConfig,
  type ExternalAgentModelInfo,
  type ExternalClientConnection,
  type HindsightMemoryConfig,
  type KuloSettingsView,
  type ModelGatewayConfig,
  type ModelModality,
  type ModelProtocolAdapter,
  type ModelPurpose,
  type PresentationConfig,
  type RolePreset,
  type SettingsBlockName,
  type SettingsHistoryItem,
  type BuiltinThinkingEffort,
  type ThinkingLevelOption,
  type ThinkingLevelMapConfig,
} from "@kulo/protocol";
import {
  coerceCustomProviderApi,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeCustomProviderApi,
  normalizeProviderBaseUrl,
  parseThinking,
  type KuloHubConfig,
} from "./config.js";
import { resolveHindsightToken, resolveHindsightSharedReadToken } from "./hindsight.js";
import { subscriptionModelTemplate } from "./subscription-models.js";
import {
  applyExecutorBlockUpdate,
  createFreshExecutorConfig,
  normalizeExecutorConfig,
  resolveRollbackExecutorConfig,
  SettingsUpdateError,
} from "./settings-executor.js";
import {
  VALID_THINKING_KEYS,
  applyRolesBlockUpdate,
  assertConversationModelSelection,
  bindingFromExternalClient,
  cleanupRemovedRoleModels,
  configuredModel,
  isValidThinkingSelection,
  normalizeRoleThinkingSelections,
  syncExternalClientsInSettings,
} from "./settings-roles.js";

export { bindingFromExternalClient, normalizeExecutorConfig, SettingsUpdateError, syncExternalClientsInSettings };

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
    const protocolAdapter = (api === "google-vertex" && mObj.protocolAdapter === "gemini-image" ? "vertex-image" : mObj.protocolAdapter) as ModelProtocolAdapter | undefined;
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
      const mediaAdapter = protocolAdapter === "vertex-image" ? "vertex-image" : protocolAdapter === "gemini-image" ? "gemini-image" : protocolAdapter === "custom-image" ? "custom-image" : "openai-image";
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
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || id === "kulo-gateway") {
      throw new SettingsUpdateError(
        400,
        `自定义提供商 ID "${id}" 格式非法（仅限小写字母、数字、-、_，且不可为 kulo-gateway）。`,
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

    const presetRaw = typeof obj.preset === "string" && /^[a-z0-9_-]{1,48}$/i.test(obj.preset.trim())
      ? obj.preset.trim().toLowerCase() : undefined;
    const rawAuthMode = obj.authMode;
    if (rawAuthMode !== undefined && rawAuthMode !== "api-key" && rawAuthMode !== "none") {
      throw new SettingsUpdateError(400, `自定义提供商 "${name}" 的认证模式无效。`);
    }
    if (rawAuthMode === "none" && !supportsKeylessLocalModel(baseUrl, apiRaw)) {
      throw new SettingsUpdateError(400, `自定义提供商 "${name}" 仅本机或私有局域网 OpenAI 兼容服务支持免密模式。`);
    }
    const models = sanitizeCustomModelList(obj.models, apiRaw), vertex = sanitizeVertexConfig(obj, apiRaw, baseUrl);
    out.push({
      id, name, ...(presetRaw ? { preset: presetRaw } : {}),
      api: apiRaw, baseUrl, ...(rawAuthMode === "none" ? { authMode: "none" as const } : {}),
      ...vertex, models,
    });
  }
  return out;
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
    Boolean(obj.gatewayDisabled) && defaultProvider !== "kulo-gateway";

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

function rememberSettingsSnapshot(doc: KuloDurableSettings, snapshot: SettingsSnapshotRecord): void {
  doc.snapshots.push(snapshot);
  if (doc.snapshots.length > SETTINGS_HISTORY_LIMIT) doc.snapshots = doc.snapshots.slice(-SETTINGS_HISTORY_LIMIT);
}

export type KuloDurableSettings = {
  initialized: boolean;
  rolesMigratedV2?: boolean;
  rolesMigratedV3?: boolean;
  rolesMigratedV4?: boolean;
  rolesMigratedV5?: boolean;
  gatewayMigratedV2?: boolean;
  executionTrustModeRevision?: number;
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

export const KuloSettingsDoc = defineDoc<KuloDurableSettings & JsonObject>({
  kind: "kulo.settings",
  version: 1,
  scope: "session",
  initial: () =>
    ({
      initialized: false,
      rolesMigratedV2: true,
      rolesMigratedV3: true,
      rolesMigratedV4: true,
      rolesMigratedV5: true,
      gatewayMigratedV2: true,
      executionTrustModeRevision: 1,
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
        agentName: "Kulo",
        workbenchName: "Kulo's table",
      },
      executor: {
        maxConcurrentWorkers: 3,
        maxSubagentsPerTicket: 4,
        paused: false,
        watchdogMinutes: 5,
        completedTaskDisplayHours: 3,
        autoArchiveEnabled: true,
        autoArchiveDays: 7,
        executionTrustMode: "trusted",
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
        routerApiKeyEnv: "KULO_HINDSIGHT_ROUTER_API_KEY",
        workerApiKeyEnv: "KULO_HINDSIGHT_WORKER_API_KEY",
        authFile: "",
        autoAttachTopLevelRouters: true,
        banks: {
          private: "kulo-core",
          shared: "kulo-shared",
        },
      },
      expression: null,
      snapshots: [],
    }) as KuloDurableSettings & JsonObject,
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 16,
});

function cleanJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeMemoryConfig(value: HindsightMemoryConfig): HindsightMemoryConfig {
  const legacy = value as HindsightMemoryConfig & { apiKey?: string; apiKeyEnv?: string };
  const routerKey = value.routerApiKey ?? legacy.apiKey;
  return {
    accessMode: value.accessMode === "scoped" || value.accessMode === "private-only" ? value.accessMode : "kulo",
    enabled: Boolean(value.enabled),
    ...(value.knowledgeGuidanceEnabled ? { knowledgeGuidanceEnabled: true } : {}),
    endpoint: value.endpoint || "http://127.0.0.1:8888",
    endpoints: Array.isArray(value.endpoints) ? [...value.endpoints] : [],
    caCertPem: value.caCertPem ?? "",
    ...(routerKey ? { routerApiKey: routerKey } : {}),
    ...(value.workerApiKey ? { workerApiKey: value.workerApiKey } : {}),
    ...(value.sharedReadApiKey ? { sharedReadApiKey: value.sharedReadApiKey } : {}),
    sharedReadApiKeyEnv: value.sharedReadApiKeyEnv ?? "KULO_HINDSIGHT_SHARED_READ_API_KEY",
    ...(value.sharedReadApiKeyDisabled ? { sharedReadApiKeyDisabled: true } : {}),
    routerApiKeyEnv: value.routerApiKeyEnv ?? legacy.apiKeyEnv ?? "KULO_HINDSIGHT_ROUTER_API_KEY",
    workerApiKeyEnv: value.workerApiKeyEnv ?? "KULO_HINDSIGHT_WORKER_API_KEY",
    ...(value.routerApiKeyDisabled ? { routerApiKeyDisabled: true } : {}),
    ...(value.workerApiKeyDisabled ? { workerApiKeyDisabled: true } : {}),
    authFile: value.authFile ?? "",
    autoAttachTopLevelRouters: value.autoAttachTopLevelRouters !== false,
    banks: { private: value.banks?.private ?? "kulo-core", shared: value.banks?.shared ?? "kulo-shared" },
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
  doc: KuloDurableSettings,
  config: KuloHubConfig,
  options?: { hasGatewayCredential?: boolean },
): void {
  if (!doc.initialized) {
    doc.initialized = true;
    doc.rolesMigratedV2 = true;
    doc.rolesMigratedV3 = true;
    doc.rolesMigratedV4 = true;
    doc.rolesMigratedV5 = true;
    doc.gatewayMigratedV2 = true;
    doc.presentation = cleanJson(config.presentation);
    doc.executionTrustModeRevision = 1;
    doc.executor = createFreshExecutorConfig({
      maxConcurrentWorkers: config.maxConcurrentWorkers,
      maxSubagentsPerTicket: config.maxSubagentsPerTicket,
      watchdogMinutes: config.watchdogMinutes,
      completedTaskDisplayHours: config.completedTaskDisplayHours,
    });
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

  // Upgrade older persisted SQLite settings docs in place (never silently escalate missing trust mode)
  doc.executionTrustModeRevision ??= 1;
  doc.executor = normalizeExecutorConfig(
    doc.executor,
    config.maxConcurrentWorkers,
    config.watchdogMinutes,
    config.maxSubagentsPerTicket,
    config.completedTaskDisplayHours,
  );
  doc.model = normalizeModelConfig(doc.model);
  migrateSettingsRolesOnHydrate(doc);
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
      doc.model.defaultProvider !== "kulo-gateway" &&
      !(doc.model.defaultModel.trim() && !doc.model.defaultProvider) &&
      !Object.values(doc.roles ?? {}).some(
        (role) =>
          !role.external &&
          (role.provider === "kulo-gateway" || (!role.provider && Boolean(role.modelId?.trim()))),
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
  doc: Readonly<KuloDurableSettings>,
  defaultIdentityDir: string,
): string {
  const custom = doc.identity.directory?.trim();
  if (!custom) return defaultIdentityDir;
  const resolved = path.resolve(custom);
  try {
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Fall through to managed fallback check
  }
  try {
    if (fs.existsSync(defaultIdentityDir)) return defaultIdentityDir;
  } catch {
    // Keep custom path if default directory does not exist
  }
  return resolved;
}

export function toPublicSettingsView(
  doc: Readonly<KuloDurableSettings>,
  defaultIdentityDir: string,
): KuloSettingsView {
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
            process.env.KULO_API_KEY?.trim() ||
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

export function applySettingsBlockUpdate(
  doc: KuloDurableSettings,
  block: SettingsBlockName,
  expectedRevision: number,
  rawValue: unknown,
  options: {
    externalAgents?: boolean;
    clientModels?: Record<string, ExternalAgentModelInfo[]>;
    clientPatches?: Record<string, Partial<ExternalClientConnection>>;
    upsertClients?: Record<string, ExternalClientConnection>;
    removeClientIds?: readonly string[];
    summaryOverride?: string;
  } = {},
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
      const hasLanguage = Object.hasOwn(val, "language") && val.language !== undefined;
      const language = hasLanguage ? normalizeKuloLanguage(val.language) : doc.presentation.language;
      if (hasLanguage && !language) {
        throw new SettingsUpdateError(400, "界面语言设置无效。");
      }
      if (!agentName || agentName.length > 80 || !workbenchName || workbenchName.length > 120) {
        throw new SettingsUpdateError(400, "显示名称不能为空且长度需在限制范围内。");
      }
      const prevAgentName = doc.presentation.agentName;
      const prevLanguage = doc.presentation.language;
      doc.presentation = {
        agentName,
        workbenchName,
        ...(language ? { language } : {}),
      };
      summary = hasLanguage && language !== prevLanguage && agentName === prevAgentName
        ? `更新界面语言为「${language === "en" ? "English" : "中文"}」`
        : `更新智能体名称为「${agentName}」`;
      break;
    }

    case "executor": {
      const result = applyExecutorBlockUpdate(doc.executor, val);
      doc.executor = result.next;
      if (result.trustModeChanged) {
        doc.executionTrustModeRevision = (doc.executionTrustModeRevision ?? 1) + 1;
      }
      summary = result.summary;
      break;
    }

    case "roles": {
      summary = applyRolesBlockUpdate(doc, val, options);
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
        val.defaultProvider !== "kulo-gateway" &&
        (defaultProvider === "kulo-gateway" || (!defaultProvider && Boolean(defaultModel)))
      ) {
        defaultProvider = "";
        defaultModel = "";
      }

      const gatewayDisabled =
        (val.gatewayDisabled !== undefined
          ? Boolean(val.gatewayDisabled)
          : Boolean(prevModel.gatewayDisabled)) &&
        (defaultProvider || (defaultModel ? "kulo-gateway" : undefined)) !== "kulo-gateway";

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
      for (const role of Object.values(doc.roles)) {
        if (role.external) continue;
        assertConversationModelSelection(nextModel, role.provider, role.modelId || nextModel.defaultModel);
        if (role.escalationModel) {
          assertConversationModelSelection(nextModel, role.escalationModel.provider, role.escalationModel.modelId);
        }
      }
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
      const priv = String(banksObj.private ?? "kulo-core").trim();
      const shared = String(banksObj.shared ?? "kulo-shared").trim();
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
      const knowledgeGuidanceEnabled =
        val.knowledgeGuidanceEnabled === undefined
          ? Boolean(previous.knowledgeGuidanceEnabled)
          : Boolean(val.knowledgeGuidanceEnabled);
      const next: HindsightMemoryConfig = {
        accessMode: val.accessMode === "scoped" || val.accessMode === "private-only" ? val.accessMode : "kulo",
        enabled,
        ...(knowledgeGuidanceEnabled ? { knowledgeGuidanceEnabled: true } : {}),
        endpoint,
        endpoints,
        caCertPem: typeof val.caCertPem === "string" ? val.caCertPem : "",
        routerApiKeyEnv: String(val.routerApiKeyEnv ?? previous.routerApiKeyEnv).trim(),
        workerApiKeyEnv: String(val.workerApiKeyEnv ?? previous.workerApiKeyEnv).trim(),
        sharedReadApiKeyEnv: String(val.sharedReadApiKeyEnv ?? previous.sharedReadApiKeyEnv ?? "KULO_HINDSIGHT_SHARED_READ_API_KEY").trim(),
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
  doc: KuloDurableSettings,
  targetSnapshotRevision: number,
  expectedGlobalRevision: number,
  runtimeMemory?: HindsightMemoryConfig,
  options?: { allowTrustModeChange?: boolean },
): string {
  if (doc.globalRevision !== expectedGlobalRevision) {
    throw new SettingsUpdateError(409, "配置在撤销前已发生变动，请刷新后重试。");
  }
  const snap = doc.snapshots.find((s) => s.revision === targetSnapshotRevision);
  if (!snap) {
    throw new SettingsUpdateError(400, `未找到版本 v${targetSnapshotRevision} 的历史快照。`);
  }

  const rolledExecutor = resolveRollbackExecutorConfig(cleanJson(snap.previousState.executor), doc.executor);
  if (options?.allowTrustModeChange === false && rolledExecutor.trustModeChanged) {
    throw new SettingsUpdateError(403, "仅主人设备控制台可执行变更执行权限的历史回滚。");
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
  doc.executor = rolledExecutor.next;
  if (rolledExecutor.trustModeChanged) {
    doc.executionTrustModeRevision = (doc.executionTrustModeRevision ?? 1) + 1;
  }
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
