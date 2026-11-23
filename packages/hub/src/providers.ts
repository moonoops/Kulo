import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  isModelType,
  type Api,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Models,
  type ModelsStore,
  type ModelsStoreEntry,
  type MutableModels,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { registerLazyBedrockProvider } from "@earendil-works/pi-ai/lazy-bedrock-provider";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  CustomModelConfig,
  CustomProviderApi,
  CustomProviderConfig,
  DiscoverModelsRequest,
  DiscoverModelsResponse,
  ModelMetadataSource,
  ModelModality,
  ModelProtocolAdapter,
  ModelPurpose,
  OAuthPromptView,
  OAuthSessionView,
  ProviderCatalogItem,
  ProviderModelItem,
  ResolveModelMetadataRequest,
  ResolveModelMetadataResponse,
  RolePreset,
  ThinkingEffort,
  ThinkingLevelMapConfig,
} from "@kulo/protocol";
import {
  buildVertexModelBaseUrl,
  CUSTOM_PROVIDER_APIS,
  defaultProtocolAdapterForModel,
  defaultVoicesForAdapter,
  getImageModelPreset,
  inferModelPurpose,
  isConversationModel,
  isImageGenerationModel,
  isOfficialVertexBaseUrl,
  normalizeVertexConfig,
} from "@kulo/protocol";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeProviderBaseUrl,
  type KuloModelConfig,
} from "./config.js";
import { fetchLiveProviderModels, supportsApiModelDiscovery, type RawDiscoveredModel } from "./provider-discovery.js";
import { subscriptionModelTemplate, validateSubscriptionModelTemplates } from "./subscription-models.js";
import {
  buildThinkingConfigFromRegistry,
  isOfficialNativeSearchDefaultEligible,
  normalizeModelIdCandidates,
  resolveDefaultNativeTools,
} from "./model-metadata-parser.js";
import { KuloModelMetadataRegistry, type ModelMetadataRegistryOptions } from "./model-metadata-registry.js";
import { allowedThinkingWireValuesForApi } from "./settings.js";
import { LOCAL_KEYLESS_SYNTHETIC_API_KEY, supportsKeylessLocalModel } from "./local-model-endpoint.js";
import {
  KULO_GATEWAY_PROVIDER_ID,
  openAIResponsesCompat,
  sanitizeThinkingLevelMapForApi,
} from "./models.js";

export interface MainstreamProviderPreset {
  id: string;
  name: string;
  api: CustomProviderApi;
  supportedApis?: readonly CustomProviderApi[];
  baseUrl: string;
  builtinId: string;
}

const CURATED_PRESET_DEFINITIONS: ReadonlyArray<{
  id: string;
  name: string;
  fallbackApi?: CustomProviderApi;
  fallbackBaseUrl?: string;
}> = [
  { id: "openai", name: "OpenAI / Codex" },
  { id: "google", name: "Gemini · AI Studio" },
  { id: "google-vertex", name: "Google Vertex AI", fallbackBaseUrl: "https://aiplatform.googleapis.com" },
  { id: "anthropic", name: "Claude" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "openrouter", name: "OpenRouter", fallbackApi: "openai-completions" },
  { id: "xai", name: "xAI Grok" },
  { id: "moonshotai-cn", name: "Kimi" },
  { id: "minimax-cn", name: "MiniMax · 国内" },
  { id: "minimax", name: "MiniMax · 国际" },
  { id: "zai-coding-cn", name: "智谱 GLM" },
  { id: "qwen-token-plan-cn", name: "通义千问" },
  { id: "groq", name: "Groq" },
  { id: "mistral", name: "Mistral" },
];

function buildMainstreamProviderPresets(): readonly MainstreamProviderPreset[] {
  const validApis = new Set<string>(CUSTOM_PROVIDER_APIS);
  const builtinsById = new Map(builtinProviders().map((p) => [p.id, p]));
  return CURATED_PRESET_DEFINITIONS.map((def) => {
    const builtin = builtinsById.get(def.id);
    if (!builtin) {
      throw new Error(`Missing @earendil-works/pi-ai builtin provider '${def.id}'`);
    }
    const modelApis = [...new Set(
      builtin.getModels()
        .map((m) => m.api)
        .filter((api): api is CustomProviderApi => validApis.has(api)),
    )];
    const api = (modelApis.length === 1 ? modelApis[0] : def.fallbackApi ?? modelApis[0]) ?? "openai-completions";
    const baseUrl = builtin.baseUrl ?? def.fallbackBaseUrl ?? "";
    return {
      id: def.id,
      name: def.name,
      api,
      ...(modelApis.length > 1 ? { supportedApis: modelApis } : {}),
      baseUrl,
      builtinId: def.id,
    };
  });
}

export const MAINSTREAM_PROVIDER_PRESETS: readonly MainstreamProviderPreset[] = buildMainstreamProviderPresets();

const PRESET_BY_ID = new Map<string, MainstreamProviderPreset>(
  MAINSTREAM_PROVIDER_PRESETS.map((p) => [p.id, p]),
);

let lazyBuiltinsRegistered = false;
function ensureLazyBuiltinsRegistered(): void {
  if (!lazyBuiltinsRegistered) {
    registerLazyOAuthFlows();
    registerLazyBedrockProvider();
    lazyBuiltinsRegistered = true;
  }
}

const FEATURED_PROVIDER_ORDER = [
  KULO_GATEWAY_PROVIDER_ID,
  "openai",
  "openai-codex",
  "anthropic",
  "google",
  "github-copilot",
  "deepseek",
  "openrouter",
  "xai",
  "kimi-coding",
  "meta",
  "radius",
  "moonshotai-cn",
  "moonshotai",
  "minimax-cn",
  "minimax",
  "zai-coding-cn",
  "zai",
  "qwen-token-plan-cn",
  "qwen-token-plan",
  "groq",
  "mistral",
];

const FEATURED_RANK = new Map<string, number>(
  FEATURED_PROVIDER_ORDER.map((id, idx) => [id, idx]),
);

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode,
  });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Ignore on platforms where chmod is not applicable
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * File-backed `CredentialStore` at `<stateDir>/credentials.json` (`0o600`),
 * serializing per-provider `modify`/`delete` operations as required for OAuth refresh safety.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #filePath: string;
  #cache: Record<string, Credential> | null = null;
  #providerChains = new Map<string, Promise<unknown>>();
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  #load(): Record<string, Credential> {
    if (this.#cache) return this.#cache;
    try {
      if (fs.existsSync(this.#filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.#filePath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.#cache = parsed as Record<string, Credential>;
          return this.#cache;
        }
      }
    } catch {
      // Corrupt credential file falls back to empty
    }
    this.#cache = {};
    return this.#cache;
  }

  #enqueue<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.#providerChains.get(providerId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#providerChains.set(providerId, tail);
    void tail.then(() => {
      if (this.#providerChains.get(providerId) === tail) {
        this.#providerChains.delete(providerId);
      }
    });
    return run;
  }

  #persist(next: Record<string, Credential>): Promise<void> {
    const run = this.#writeChain.then(() => {
      atomicWriteJson(this.#filePath, next, 0o600);
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const map = this.#load();
    const entry = map[providerId];
    return entry ? cloneJson(entry) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const map = this.#load();
    return Object.entries(map).map(([providerId, cred]) => ({
      providerId,
      type: cred.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#enqueue(providerId, async () => {
      const map = this.#load();
      const current = map[providerId] ? cloneJson(map[providerId]!) : undefined;
      const candidate = await fn(current);
      if (candidate === undefined) {
        return current;
      }
      map[providerId] = cloneJson(candidate);
      await this.#persist(map);
      return cloneJson(candidate);
    });
  }

  async delete(providerId: string): Promise<void> {
    return this.#enqueue(providerId, async () => {
      const map = this.#load();
      if (Object.prototype.hasOwnProperty.call(map, providerId)) {
        delete map[providerId];
        await this.#persist(map);
      }
    });
  }
}

/**
 * File-backed `ModelsStore` at `<stateDir>/models-cache.json` for dynamic provider model discovery.
 */
export class FileModelsStore implements ModelsStore {
  readonly #filePath: string;
  #cache: Record<string, ModelsStoreEntry> | null = null;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  #load(): Record<string, ModelsStoreEntry> {
    if (this.#cache) return this.#cache;
    try {
      if (fs.existsSync(this.#filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.#filePath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.#cache = parsed as Record<string, ModelsStoreEntry>;
          return this.#cache;
        }
      }
    } catch {
      // Ignore cache read error
    }
    this.#cache = {};
    return this.#cache;
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = this.#load()[providerId];
    return entry ? cloneJson(entry) : undefined;
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    const map = this.#load();
    map[providerId] = cloneJson(entry);
    atomicWriteJson(this.#filePath, map, 0o644);
  }

  async delete(providerId: string): Promise<void> {
    const map = this.#load();
    if (Object.prototype.hasOwnProperty.call(map, providerId)) {
      delete map[providerId];
      atomicWriteJson(this.#filePath, map, 0o644);
    }
  }
}

function getOrCreateDeviceId(stateDir: string): string {
  const devicePath = path.join(stateDir, "device-id");
  try {
    if (fs.existsSync(devicePath)) {
      const val = fs.readFileSync(devicePath, "utf8").trim();
      if (val) return val;
    }
  } catch {
    // Fallback to generating a fresh ID
  }
  const fresh = crypto.randomUUID();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(devicePath, `${fresh}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort persistence
  }
  return fresh;
}

function getStreamForCustomApi(api: CustomProviderApi): ProviderStreams {
  switch (api) {
    case "openai-completions":
      return openAICompletionsApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "google-generative-ai":
      return googleGenerativeAIApi();
    case "google-vertex":
      return googleVertexApi();
    case "mistral-conversations":
      return mistralConversationsApi();
    case "azure-openai-responses":
      return azureOpenAIResponsesApi();
    case "openai-codex-responses":
      return openAICodexResponsesApi();
    case "bedrock-converse-stream":
      return bedrockConverseStreamApi();
    case "pi-messages":
      return piMessagesApi();
  }
}

function getAllCustomApiStreams(): Record<CustomProviderApi, ProviderStreams> {
  return {
    "openai-completions": openAICompletionsApi(),
    "openai-responses": openAIResponsesApi(),
    "anthropic-messages": anthropicMessagesApi(),
    "google-generative-ai": googleGenerativeAIApi(),
    "google-vertex": googleVertexApi(),
    "mistral-conversations": mistralConversationsApi(),
    "azure-openai-responses": azureOpenAIResponsesApi(),
    "openai-codex-responses": openAICodexResponsesApi(),
    "bedrock-converse-stream": bedrockConverseStreamApi(),
    "pi-messages": piMessagesApi(),
  };
}

function createCustomModelEntry(
  providerId: string,
  baseUrl: string,
  api: CustomProviderApi,
  model: CustomModelConfig,
  fallbackContextWindow: number,
): Model<Api> {
  const contextWindow = model.contextWindow ?? fallbackContextWindow;
  const maxTokens = model.maxTokens ?? DEFAULT_MAX_TOKENS;
  const reasoning = model.reasoning ?? true;
  const hasImage = model.modalities
    ? model.modalities.includes("image")
    : model.vision !== false;
  const input: ("text" | "image")[] = hasImage ? ["text", "image"] : ["text"];
  const thinkingLevelMap = sanitizeThinkingLevelMapForApi(model.thinkingLevelMap, api);
  const base = {
    id: model.id,
    name: model.name?.trim() || model.id,
    provider: providerId,
    baseUrl,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  if (api === "openai-completions") {
    return {
      ...base,
      api: "openai-completions",
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
        supportsReasoningEffort: reasoning,
      },
    };
  }
  if (api === "openai-responses") {
    return {
      ...base,
      api: "openai-responses",
      compat: openAIResponsesCompat(baseUrl),
    };
  }
  return {
    ...base,
    api,
  };
}

function getOriginSafe(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function isSameOrigin(a: string, b: string): boolean {
  const oa = getOriginSafe(a);
  const ob = getOriginSafe(b);
  return oa !== null && oa === ob;
}

export const API_KEY_ORIGIN_ENV = "KULO_API_KEY_ORIGIN";

function apiKeyForOrigin(credential: Credential | undefined, baseUrl: string): string | undefined {
  if (credential?.type !== "api_key") return undefined;
  const origin = getOriginSafe(baseUrl);
  return origin !== null && credential.env?.[API_KEY_ORIGIN_ENV] === origin
    ? credential.key
    : undefined;
}

interface InternalOAuthSession {
  sessionId: string;
  providerId: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  authUrl?: string;
  instructions?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  infoMessages: string[];
  progressMessage?: string;
  prompt?: OAuthPromptView;
  resolvePrompt?: (value: string) => void;
  rejectPrompt?: (err: Error) => void;
  error?: string;
  abortController: AbortController;
  createdAt: number;
  notifyUpdate?: () => void;
}

export function localizeOAuthProgress(raw: string): string {
  const text = raw.trim();
  if (!text) return "等待授权…";
  if (/^Listening for .*OAuth callback/i.test(text)) return "等待浏览器完成授权…";
  if (/^Exchanging authorization code/i.test(text)) return "正在获取访问凭据…";
  if (/^Enabling models/i.test(text)) return "正在同步可用模型…";
  if (/^Enabling .*API access/i.test(text)) return "正在开通接口权限…";
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  return "正在处理授权…";
}

function localizeOAuthOptionLabel(id: string, label: string): string {
  const lowerId = id.toLowerCase();
  if (lowerId.includes("browser") || /browser/i.test(label)) return "浏览器授权";
  if (lowerId.includes("device") || /device code/i.test(label)) return "设备码授权";
  if (lowerId.includes("copy") || /copy code/i.test(label)) return "粘贴授权码";
  if (lowerId === "api-key" || /API key/i.test(label)) return "API 密钥";
  if (lowerId === "adc" || /Application Default Credentials/i.test(label)) {
    return "默认应用凭据";
  }
  if (lowerId === "service-account" || /Service account/i.test(label)) {
    return "服务账号密钥文件";
  }
  return label.replace(/\s*\([^)]*\)\s*/g, "").trim() || label;
}

export function localizeOAuthPrompt(
  prompt: AuthPrompt,
  promptId: string,
): OAuthPromptView {
  if (prompt.type === "select") {
    const message = /login method|Sign in to|authentication method/i.test(prompt.message)
      ? "授权方式"
      : prompt.message;
    return {
      id: promptId,
      type: "select",
      message,
      options: prompt.options.map((o) => ({
        id: o.id,
        label: localizeOAuthOptionLabel(o.id, o.label),
      })),
    };
  }

  let message = prompt.message.trim();
  let placeholder =
    "placeholder" in prompt && prompt.placeholder ? prompt.placeholder : undefined;

  if (prompt.type === "manual_code") {
    if (/Paste the code .* shows/i.test(message)) {
      message = "授权码";
    } else if (/authorization code\s*\/\s*redirect URL/i.test(message)) {
      message = "授权码或回调链接";
    } else if (/redirect URL/i.test(message)) {
      message = "回调链接";
    } else if (!/[\u4e00-\u9fa5]/.test(message)) {
      message = "授权码或回调链接";
    }
  } else if (/GitHub Enterprise URL\/domain/i.test(message)) {
    message = "企业域名";
    placeholder = "留空默认使用 github.com";
  } else if (/Google Cloud API key/i.test(message)) {
    message = "API 密钥";
  } else if (/Google Cloud project ID/i.test(message)) {
    message = "项目 ID";
  } else if (/Google Cloud location/i.test(message)) {
    message = "区域";
  } else if (/service account credentials file path/i.test(message)) {
    message = "凭据文件路径";
  }

  return {
    id: promptId,
    type: prompt.type,
    message,
    ...(placeholder ? { placeholder } : {}),
  };
}

function localizeOAuthInfo(raw: string): string {
  const text = raw.trim();
  if (/gcloud auth application-default login/i.test(text)) {
    return "请先执行 gcloud auth application-default login，再填写项目 ID 与区域。";
  }
  if (/Provide a service account credentials file/i.test(text)) {
    return "请填写服务账号凭据文件路径、项目 ID 与区域。";
  }
  return text;
}

export function localizeOAuthError(raw: string): string {
  const text = raw.trim();
  if (!text) return "授权登录失败";
  if (/^(Login cancelled|OAuth login cancelled|Prompt cancelled)$/i.test(text)) {
    return "已取消登录";
  }
  if (/state mismatch/i.test(text)) {
    return "授权状态校验不匹配，请重新发起登录";
  }
  if (/Missing authorization code/i.test(text)) {
    return "未检测到有效授权码";
  }
  if (/Invalid GitHub Enterprise URL/i.test(text)) {
    return "GitHub 企业域名格式无效";
  }
  if (/sign-in timed out|timed out/i.test(text)) {
    return "授权等待超时，请重试";
  }
  if (/device authorization expired|expired_token/i.test(text)) {
    return "设备码已过期，请重新获取";
  }
  if (/login was denied|access_denied/i.test(text)) {
    return "授权请求已被拒绝";
  }
  if (/authorization failed/i.test(text)) {
    return "浏览器授权未通过，请重试";
  }
  if (/Token exchange request failed|Token exchange returned invalid JSON/i.test(text)) {
    return "获取访问令牌失败，请检查网络或回调链接";
  }
  if (/OAuth callback did not complete|OAuth callback server closed/i.test(text)) {
    return "未完成浏览器授权回调";
  }
  if (/did not bind to TCP|EADDRINUSE/i.test(text)) {
    return "本地回调端口被占用，请粘贴回调链接完成验证";
  }
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  return `授权失败：${text}`;
}

export function toProviderModelItem(
  m: Model<Api>,
  customCfg?: CustomModelConfig,
  preset?: string,
): ProviderModelItem {
  const defaultModalities: ModelModality[] =
    Array.isArray(m.input) && m.input.includes("image") ? ["text", "image"] : ["text"];
  const modalities: ModelModality[] = customCfg?.modalities?.length
    ? [...customCfg.modalities]
    : defaultModalities;
  const supportedThinkingLevels: ThinkingEffort[] = !m.reasoning || customCfg?.thinkingEnabled === false ? ["off"] :
    customCfg?.thinkingLevels?.map((option) => option.id) ?? getSupportedThinkingLevels(m);
  const thinkingLevelMap =
    (m.thinkingLevelMap as ThinkingLevelMapConfig | undefined) ??
    sanitizeThinkingLevelMapForApi(customCfg?.thinkingLevelMap, m.api);
  const inferred = inferModelPurpose(customCfg ?? m);
  const purpose: ModelPurpose | undefined = customCfg?.purpose ?? (inferred !== "chat" ? inferred : undefined);
  const protocolAdapter = customCfg?.protocolAdapter ?? (purpose && purpose !== "chat" ? defaultProtocolAdapterForModel(purpose, m.id, m.api, preset) : undefined);
  const voices = customCfg?.voices?.length ? [...customCfg.voices] : protocolAdapter ? defaultVoicesForAdapter(protocolAdapter) : undefined;
  return {
    id: m.id,
    ...(purpose ? { purpose } : {}),
    ...(protocolAdapter ? { protocolAdapter } : {}),
    ...(voices?.length ? { voices } : {}),
    ...(customCfg?.imageProfile ? { imageProfile: cloneJson(customCfg.imageProfile) } : {}),
    ...(customCfg?.imageDefaults ? { imageDefaults: cloneJson(customCfg.imageDefaults) } : {}),
    ...(customCfg?.customImageAdapter ? { customImageAdapter: cloneJson(customCfg.customImageAdapter) } : {}),
    ...(customCfg?.outputModalities ? { outputModalities: [...customCfg.outputModalities] } : {}),
    name: customCfg?.name?.trim() || m.name || m.id,
    api: m.api,
    reasoning: Boolean(m.reasoning),
    ...(customCfg?.thinkingEnabled !== undefined ? { thinkingEnabled: customCfg.thinkingEnabled } : {}),
    vision: modalities.includes("image"),
    modalities,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    supportedThinkingLevels,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(customCfg?.thinkingLevels ? { thinkingLevels: customCfg.thinkingLevels.map((option) => ({ ...option })) } : {}),
    ...(customCfg?.nativeTools ? { nativeTools: { ...customCfg.nativeTools } } : {}),
  };
}

export function nonChatConfigToProviderModelItem(
  cfg: CustomModelConfig,
  providerApi?: CustomProviderApi,
  preset?: string,
): ProviderModelItem {
  const purpose = inferModelPurpose(cfg);
  const rawAdapter = cfg.protocolAdapter ?? defaultProtocolAdapterForModel(purpose, cfg.id, providerApi, preset);
  const protocolAdapter = purpose === "image" && providerApi === "google-vertex" && rawAdapter === "gemini-image" ? "vertex-image" : rawAdapter;
  const defaultVoices = defaultVoicesForAdapter(protocolAdapter);
  const voices = cfg.voices?.length ? [...cfg.voices] : defaultVoices.length ? defaultVoices : undefined;
  const imagePreset = purpose === "image" && (protocolAdapter === "openai-image" || protocolAdapter === "gemini-image" || protocolAdapter === "vertex-image")
    ? getImageModelPreset(protocolAdapter, cfg.id)
    : undefined;
  const imageProfile = cfg.imageProfile ?? imagePreset?.profile;
  const imageDefaults = cfg.imageDefaults ?? imagePreset?.defaults;
  const modalities: ModelModality[] = cfg.modalities?.length ? [...cfg.modalities] : ["text"];
  return {
    id: cfg.id,
    purpose,
    ...(protocolAdapter ? { protocolAdapter } : {}),
    ...(voices ? { voices } : {}),
    ...(imageProfile ? { imageProfile: cloneJson(imageProfile) } : {}),
    ...(imageDefaults ? { imageDefaults: cloneJson(imageDefaults) } : {}),
    ...(cfg.customImageAdapter ? { customImageAdapter: cloneJson(cfg.customImageAdapter) } : {}),
    ...(cfg.outputModalities ? { outputModalities: [...cfg.outputModalities] } : purpose === "image" ? { outputModalities: ["image"] } : {}),
    name: cfg.name?.trim() || imagePreset?.name || cfg.id,
    ...(providerApi ? { api: providerApi } : {}),
    reasoning: false,
    thinkingEnabled: false,
    vision: modalities.includes("image"),
    modalities,
    contextWindow: cfg.contextWindow ?? 0,
    maxTokens: cfg.maxTokens ?? 0,
    supportedThinkingLevels: ["off"],
  };
}

export function serializeProviderCatalogItem(
  p: Provider<Api>,
  models: Models,
  opts: {
    builtin: boolean;
    preset?: string; isGateway?: boolean; api?: CustomProviderApi;
    vertexProject?: string; vertexLocation?: string;
    customModels?: CustomModelConfig[]; authenticated: boolean;
    authType?: "api_key" | "oauth"; authSource?: string; credential?: Credential;
    modelIds?: ReadonlySet<string>; configuredModelIds?: ReadonlySet<string>;
    supportsModelDiscovery?: boolean; modelCatalogSource?: ProviderCatalogItem["modelCatalogSource"];
  },
): ProviderCatalogItem {
  const customById = new Map((opts.customModels ?? []).map((cm) => [cm.id, cm]));
  const knownModels = models.getModels(p.id);
  const allowedModels = p.filterModels?.(knownModels, opts.credential) ?? knownModels;
  const chatItems = allowedModels.map((model) => toProviderModelItem(model, customById.get(model.id), opts.preset));
  const chatIdSet = new Set(chatItems.map((item) => item.id));
  const nonChatItems = !opts.builtin
    ? (opts.customModels ?? [])
        .filter((cm) => cm.id && !chatIdSet.has(cm.id) && !isConversationModel(cm))
        .map((cm) => nonChatConfigToProviderModelItem(cm, opts.api, opts.preset))
    : [];
  const allowedItems = [...chatItems, ...nonChatItems];
  const catalogModels = allowedItems.filter((model) => !opts.modelIds || opts.modelIds.has(model.id));

  return {
    id: p.id, name: p.name || p.id, builtin: opts.builtin,
    ...(opts.preset ? { preset: opts.preset } : {}), ...(opts.isGateway ? { isGateway: true } : {}),
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(opts.api ? { api: opts.api } : {}),
    ...(opts.vertexProject ? { vertexProject: opts.vertexProject } : {}),
    ...(opts.vertexLocation ? { vertexLocation: opts.vertexLocation } : {}),
    supportsApiKey: Boolean(p.auth.apiKey),
    supportsOAuth: Boolean(p.auth.oauth),
    supportsModelDiscovery: opts.supportsModelDiscovery ?? Boolean(p.refreshModels),
    modelCatalogSource: opts.modelCatalogSource ?? (opts.builtin ? "preset" : "configured"),
    ...(p.auth.oauth?.name ? { oauthName: p.auth.oauth.name } : {}),
    ...(p.auth.oauth?.loginLabel ? { oauthLoginLabel: p.auth.oauth.loginLabel } : {}),
    authenticated: opts.authenticated,
    ...(opts.authType ? { authType: opts.authType } : {}),
    ...(opts.authSource ? { authSource: opts.authSource } : {}),
    models: catalogModels,
    ...(opts.configuredModelIds ? { configuredModels: allowedItems.filter((model) => opts.configuredModelIds!.has(model.id)) } : {}),
  };
}

export class KuloProviderManager {
  readonly stateDir: string;
  readonly credentials: CredentialStore;
  readonly modelsStore: FileModelsStore;
  readonly metadataRegistry: KuloModelMetadataRegistry;
  readonly models: MutableModels;
  readonly #builtins: readonly Provider[];
  readonly #nativeBuiltinProviders = new Map<string, Provider<Api>>();
  readonly #builtinModelTemplates = new Map<string, readonly Model<Api>[]>();
  readonly #subscriptionModelSnapshots = new Map<string, string>();
  readonly #builtinIds: ReadonlySet<string>;
  readonly #customProviderMeta = new Map<string, CustomProviderConfig>();
  readonly #oauthSessions = new Map<string, InternalOAuthSession>();
  readonly #liveBuiltinModelIds = new Map<string, ReadonlySet<string>>();
  readonly #modelRefreshRevisions = new Map<string, number>();
  #latestModelConfig: KuloModelConfig | null = null;
  #latestRoles: Record<string, RolePreset> = {};
  #offlineRestored = false;
  #gatewayEnvironmentBaseUrl: string | null = null;

  constructor(options: { stateDir: string; credentials?: CredentialStore; metadataRegistry?: KuloModelMetadataRegistry; metadataRegistryOptions?: ModelMetadataRegistryOptions }) {
    ensureLazyBuiltinsRegistered();
    this.stateDir = options.stateDir;
    this.credentials = options.credentials ?? new FileCredentialStore(path.join(this.stateDir, "credentials.json"));
    this.modelsStore = new FileModelsStore(path.join(this.stateDir, "models-cache.json"));
    this.metadataRegistry = options.metadataRegistry ?? new KuloModelMetadataRegistry({
      stateDir: this.stateDir,
      ...options.metadataRegistryOptions,
    });
    this.models = createModels({
      credentials: this.credentials,
      modelsStore: this.modelsStore,
      identity: { attribution: null },
    });
    this.#builtins = builtinProviders();
    this.#builtinIds = new Set(this.#builtins.map((p) => p.id));
    for (const p of this.#builtins) {
      this.#builtinModelTemplates.set(p.id, p.getModels());
      const native: Provider<Api> = p.refreshModels ? {
        ...p,
        refreshModels: async (context: RefreshModelsContext) => {
          let publishedIds: ReadonlySet<string> | undefined;
          await p.refreshModels!({
            ...context,
            publish: async (publication) => {
              const accepted = await context.publish(publication);
              if (accepted && publication.persist?.models) {
                publishedIds = new Set(publication.persist.models.map((model) => model.id));
              }
              return accepted;
            },
          });
          if (context.allowNetwork && !context.signal.aborted && publishedIds) {
            this.#liveBuiltinModelIds.set(p.id, publishedIds);
            this.#recordModelRefresh(p.id);
          }
        },
      } : p;
      this.#nativeBuiltinProviders.set(p.id, native);
      this.models.setProvider(native);
    }
  }

  #recordModelRefresh(providerId: string): void {
    this.#modelRefreshRevisions.set(providerId, (this.#modelRefreshRevisions.get(providerId) ?? 0) + 1);
  }

  async restoreOfflineCache(): Promise<void> {
    if (this.#offlineRestored) return;
    this.#offlineRestored = true;
    try {
      await this.models.refresh({ allowNetwork: false });
    } catch {
      // Best-effort offline cache restore
    }
  }

  async bindLegacyApiKeyOrigins(modelConfig: KuloModelConfig): Promise<void> {
    // Startup migration must use restored settings, before accepting address edits.
    const endpoints: [string, string][] = [
      [KULO_GATEWAY_PROVIDER_ID, modelConfig.baseUrl],
      ...modelConfig.customProviders
        .filter((cp) => !this.#builtinIds.has(cp.id) && cp.id !== KULO_GATEWAY_PROVIDER_ID)
        .map((cp): [string, string] => [cp.id, cp.baseUrl]),
    ];
    for (const [providerId, baseUrl] of endpoints) {
      const origin = getOriginSafe(baseUrl);
      if (!origin) continue;
      const stored = await this.credentials.read(providerId);
      if (stored?.type !== "api_key" || stored.env?.[API_KEY_ORIGIN_ENV]) continue;
      await this.credentials.modify(providerId, async (current) => {
        if (current?.type !== "api_key" || current.env?.[API_KEY_ORIGIN_ENV]) return current;
        return { ...current, env: { ...current.env, [API_KEY_ORIGIN_ENV]: origin } };
      });
    }
  }

  #gatewayApiKey(credential: Credential | undefined, baseUrl: string): {
    key: string;
    source: string;
  } | undefined {
    const storedKey = apiKeyForOrigin(credential, baseUrl);
    if (storedKey) return { key: storedKey, source: "已保存密钥" };
    const live = this.#latestModelConfig;
    if (live?.apiKey && isSameOrigin(live.baseUrl, baseUrl)) {
      return { key: live.apiKey, source: "网关配置密钥" };
    }
    if (this.#gatewayEnvironmentBaseUrl && isSameOrigin(this.#gatewayEnvironmentBaseUrl, baseUrl)) {
      const key = process.env.KULO_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
      if (key) return { key, source: "环境变量" };
    }
    return undefined;
  }

  syncProviders(
    modelConfig: KuloModelConfig,
    roles: Record<string, RolePreset>,
  ): void {
    validateSubscriptionModelTemplates(modelConfig.subscriptionModels);
    this.#gatewayEnvironmentBaseUrl ??= modelConfig.baseUrl;
    this.#latestModelConfig = modelConfig;
    this.#latestRoles = roles;

    const getModelConfig = () => this.#latestModelConfig ?? modelConfig;
    const getRoles = () => this.#latestRoles;
    const contextWindow = modelConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const defaultProvider = modelConfig.defaultProvider?.trim() || (!modelConfig.gatewayDisabled ? KULO_GATEWAY_PROVIDER_ID : "");
    const gatewayModelBaseUrl = modelConfig.apiMode === "google-vertex"
      ? buildVertexModelBaseUrl(modelConfig.baseUrl, modelConfig) : modelConfig.baseUrl;
    this.#syncSubscriptionModels(modelConfig.subscriptionModels);

    // 1. Register/update Kulo's OpenAI-compatible gateway unless explicitly disabled
    const gatewayDisabled =
      Boolean(modelConfig.gatewayDisabled) && defaultProvider !== KULO_GATEWAY_PROVIDER_ID;
    if (gatewayDisabled) {
      this.models.deleteProvider(KULO_GATEWAY_PROVIDER_ID);
    } else {
      const gatewayCustomMap = new Map<string, CustomModelConfig>(
        (modelConfig.gatewayModels ?? []).map((gm) => [gm.id, gm]),
      );
      const gatewayIds = new Set<string>(
        (modelConfig.gatewayModels ?? []).map((gm) => gm.id),
      );
      if (defaultProvider === KULO_GATEWAY_PROVIDER_ID && modelConfig.defaultModel.trim()) {
        gatewayIds.add(modelConfig.defaultModel.trim());
      }
      for (const r of Object.values(roles)) {
        if (r.external) continue;
        const rp = r.provider?.trim();
        if ((!rp || rp === KULO_GATEWAY_PROVIDER_ID) && r.modelId?.trim()) {
          gatewayIds.add(r.modelId.trim());
        }
      }

      const gatewayHeaders: ProviderHeaders | undefined =
        modelConfig.apiMode === "anthropic-messages"
          ? { "anthropic-version": "2023-06-01" }
          : undefined;

      const gatewayProvider = createProvider({
        id: KULO_GATEWAY_PROVIDER_ID,
        name: modelConfig.gatewayName?.trim() || "默认兼容网关",
        baseUrl: modelConfig.baseUrl,
        ...(gatewayHeaders ? { headers: gatewayHeaders } : {}),
        auth: {
          apiKey: {
            name: "KULO_API_KEY",
            resolve: async ({ credential }) => {
              const resolved = this.#gatewayApiKey(credential, modelConfig.baseUrl);
              if (!resolved) return undefined;
              return {
                // A retained Model may still carry an old endpoint after a settings edit.
                auth: { apiKey: resolved.key, baseUrl: gatewayModelBaseUrl },
                env: { [API_KEY_ORIGIN_ENV]: getOriginSafe(modelConfig.baseUrl)! },
                source: resolved.source,
              };
            },
          },
        },
        models: Array.from(gatewayIds).filter((id) => isConversationModel(gatewayCustomMap.get(id) ?? { id })).map((id) =>
          createCustomModelEntry(
            KULO_GATEWAY_PROVIDER_ID,
            gatewayModelBaseUrl,
            modelConfig.apiMode,
            gatewayCustomMap.get(id) ?? { id },
            contextWindow,
          ),
        ),
        fetchModels: async (ctx: RefreshModelsContext) => {
          const live = getModelConfig();
          const modelBaseUrl = live.apiMode === "google-vertex" ? buildVertexModelBaseUrl(live.baseUrl, live) : live.baseUrl;
          const key = live.apiMode === "google-vertex" && isOfficialVertexBaseUrl(live.baseUrl)
            ? undefined : apiKeyForOrigin(ctx.credential, live.baseUrl);
          const discovered = await fetchLiveProviderModels({ baseUrl: live.baseUrl, api: live.apiMode, apiKey: key, signal: ctx.signal });
          this.#recordModelRefresh(KULO_GATEWAY_PROVIDER_ID);
          const ids = discovered.map((model) => model.id);
          const allIds = new Set<string>([...gatewayIds, ...ids]);
          const liveCustomMap = new Map<string, CustomModelConfig>(
            (live.gatewayModels ?? []).map((gm) => [gm.id, gm]),
          );
          const discoveredById = new Map(discovered.map((model) => [model.id, model]));
          return Array.from(allIds).filter((id) => isConversationModel({ ...liveCustomMap.get(id), ...discoveredById.get(id), id })).map((id) =>
            createCustomModelEntry(
              KULO_GATEWAY_PROVIDER_ID,
              modelBaseUrl,
              live.apiMode,
              liveCustomMap.get(id) ?? { id },
              live.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            ),
          );
        },
        api: getAllCustomApiStreams(),
      });
      this.models.setProvider(gatewayProvider);
    }

    // 2. Remove deleted custom providers
    const nextCustomIds = new Set(
      (modelConfig.customProviders ?? []).map((cp) => cp.id),
    );
    for (const prevId of this.#customProviderMeta.keys()) {
      if (
        !nextCustomIds.has(prevId) &&
        !this.#builtinIds.has(prevId) &&
        prevId !== KULO_GATEWAY_PROVIDER_ID
      ) {
        this.models.deleteProvider(prevId);
      }
    }
    this.#customProviderMeta.clear();

    // 3. Register/update custom compatible providers
    for (const cp of modelConfig.customProviders ?? []) {
      if (this.#builtinIds.has(cp.id) || cp.id === KULO_GATEWAY_PROVIDER_ID) {
        continue;
      }
      const normalizedBaseUrl = normalizeProviderBaseUrl(cp.baseUrl, cp.api);
      const vertex = cp.api === "google-vertex" ? normalizeVertexConfig(cp) : undefined;
      const modelBaseUrl = cp.api === "google-vertex" ? buildVertexModelBaseUrl(normalizedBaseUrl, cp) : normalizedBaseUrl;
      this.#customProviderMeta.set(cp.id, { ...cp, baseUrl: normalizedBaseUrl, ...vertex });

      const modelConfigs: CustomModelConfig[] = [...cp.models];
      const knownIds = new Set(modelConfigs.map((m) => m.id));
      if (defaultProvider === cp.id && modelConfig.defaultModel.trim() && !knownIds.has(modelConfig.defaultModel.trim())) {
        knownIds.add(modelConfig.defaultModel.trim());
        modelConfigs.push({ id: modelConfig.defaultModel.trim() });
      }
      for (const r of Object.values(getRoles())) {
        if (r.provider?.trim() === cp.id && r.modelId?.trim() && !knownIds.has(r.modelId.trim())) {
          knownIds.add(r.modelId.trim());
          modelConfigs.push({ id: r.modelId.trim() });
        }
      }

      const presetMeta = cp.preset ? PRESET_BY_ID.get(cp.preset) : undefined;
      const multiApiTemplates = presetMeta?.supportedApis && isSameOrigin(normalizedBaseUrl, presetMeta.baseUrl)
        ? new Map((this.#builtinModelTemplates.get(presetMeta.builtinId) ?? []).map((t) => [t.id.toLowerCase(), t]))
        : undefined;
      const resolveModelApi = (id: string): CustomProviderApi => {
        const matched = multiApiTemplates?.get(id.toLowerCase())?.api;
        return matched && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(matched) ? matched as CustomProviderApi : cp.api;
      };

      const customModels = modelConfigs.filter(isConversationModel).map((m) =>
        createCustomModelEntry(cp.id, modelBaseUrl, resolveModelApi(m.id), m, contextWindow),
      );

      const providerHeaders: ProviderHeaders | undefined =
        cp.api === "anthropic-messages"
          ? { "anthropic-version": "2023-06-01" }
          : undefined;

      const customProvider = createProvider({
        id: cp.id,
        name: cp.name,
        baseUrl: normalizedBaseUrl,
        ...(providerHeaders ? { headers: providerHeaders } : {}),
        auth: {
          apiKey: {
            name: `${cp.name} API Key`,
            resolve: async ({ credential }) => {
              const key = apiKeyForOrigin(credential, normalizedBaseUrl);
              if (key) return { auth: { apiKey: key, baseUrl: modelBaseUrl }, env: credential?.env, source: "已保存密钥" };
              if (cp.authMode === "none" && supportsKeylessLocalModel(normalizedBaseUrl, cp.api)) {
                return { auth: { apiKey: LOCAL_KEYLESS_SYNTHETIC_API_KEY, baseUrl: modelBaseUrl }, source: "本地免密服务" };
              }
              return undefined;
            },
          },
        },
        models: customModels,
        fetchModels: async (ctx: RefreshModelsContext) => {
          const key = cp.api === "google-vertex" && isOfficialVertexBaseUrl(normalizedBaseUrl)
            ? undefined : apiKeyForOrigin(ctx.credential, normalizedBaseUrl);
          const discovered = await fetchLiveProviderModels({ baseUrl: normalizedBaseUrl, api: cp.api, apiKey: key, signal: ctx.signal });
          this.#recordModelRefresh(cp.id);
          const merged = new Map<string, CustomModelConfig>(
            modelConfigs.map((m) => [m.id, m]),
          );
          for (const model of discovered) {
            merged.set(model.id, { ...merged.get(model.id), ...model });
          }
          return Array.from(merged.values()).filter(isConversationModel).map((m) =>
            createCustomModelEntry(
              cp.id,
              modelBaseUrl,
              resolveModelApi(m.id),
              m,
              getModelConfig().contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            ),
          );
        },
        api: multiApiTemplates ? getAllCustomApiStreams() : getStreamForCustomApi(cp.api),
      });

      this.models.setProvider(customProvider);
    }
  }

  #syncSubscriptionModels(subscriptions: Record<string, CustomModelConfig[]> | undefined): void {
    for (const [providerId, native] of this.#nativeBuiltinProviders) {
      if (!native.auth.oauth) continue;
      const entries = (subscriptions && Object.hasOwn(subscriptions, providerId) ? subscriptions[providerId]! : []).filter(isConversationModel);
      const snapshot = JSON.stringify(entries);
      if ((this.#subscriptionModelSnapshots.get(providerId) ?? "[]") === snapshot) continue;
      this.#subscriptionModelSnapshots.set(providerId, snapshot);
      if (!entries.length) {
        this.models.setProvider(native);
        continue;
      }
      const getModels = (): readonly Model<Api>[] => {
        const current = native.getModels();
        const templates = [...current, ...(this.#builtinModelTemplates.get(providerId) ?? []).filter((model) => !current.some((entry) => entry.id === model.id))];
        const models = new Map(current.map((model) => [model.id, model]));
        for (const entry of entries) {
          const template = subscriptionModelTemplate(providerId, entry.id, templates);
          const known = template.id === entry.id;
          const thinkingLevelMap = sanitizeThinkingLevelMapForApi(entry.thinkingLevelMap, template.api) ?? template.thinkingLevelMap;
          const input = entry.modalities ? entry.modalities.filter((modality) => modality === "text" || modality === "image")
            : entry.vision !== undefined ? entry.vision ? ["text" as const, "image" as const] : ["text" as const] : [...template.input];
          models.set(entry.id, {
            ...template,
            id: entry.id,
            name: entry.name?.trim() || (known ? template.name : entry.id),
            input: input.length ? input : ["text"],
            reasoning: entry.reasoning ?? template.reasoning,
            contextWindow: entry.contextWindow ?? template.contextWindow,
            maxTokens: entry.maxTokens ?? template.maxTokens,
            ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
            ...(!known ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
          });
        }
        return [...models.values()];
      };
      this.models.setProvider({
        ...native,
        getModels,
        getAllModels: () => [
          ...(native.getAllModels?.() ?? native.getModels()).filter((model) => !isModelType(model, "chat")),
          ...getModels(),
        ],
      });
    }
  }

  async #inspectProviderItem(p: Provider<Api>): Promise<ProviderCatalogItem> {
    let check;
    try {
      check = await this.models.checkAuth(p.id);
    } catch {
      check = undefined;
    }
    const stored = await this.credentials.read(p.id);
    const customMeta = this.#customProviderMeta.get(p.id);
    const customModels =
      customMeta?.models ??
      (p.id === KULO_GATEWAY_PROVIDER_ID
        ? this.#latestModelConfig?.gatewayModels
        : this.#subscriptionModelsFor(p.id));

    const authenticated = Boolean(check);
    const authType = check?.type ?? (stored?.type === "oauth" ? "oauth" : stored ? "api_key" : undefined);
    const authSource = check?.source;
    const builtin = this.#builtinIds.has(p.id);
    const configuredIds = this.#configuredModelIds(p.id);
    const liveIds = this.#liveBuiltinModelIds.get(p.id);
    const api = customMeta?.api ?? (p.id === KULO_GATEWAY_PROVIDER_ID ? this.#latestModelConfig?.apiMode : undefined);
    const vertexSource = customMeta ?? (p.id === KULO_GATEWAY_PROVIDER_ID ? this.#latestModelConfig : undefined);
    const result = serializeProviderCatalogItem(p, this.models, {
      builtin, preset: customMeta?.preset, isGateway: p.id === KULO_GATEWAY_PROVIDER_ID, api,
      ...(api === "google-vertex" ? { vertexProject: vertexSource?.vertexProject, vertexLocation: vertexSource?.vertexLocation } : {}),
      customModels, authenticated, authType, authSource, credential: stored,
      modelIds: builtin && liveIds ? liveIds : configuredIds, configuredModelIds: configuredIds,
      supportsModelDiscovery: api ? supportsApiModelDiscovery(api) : Boolean(p.refreshModels),
      modelCatalogSource: api === "google-vertex" && isOfficialVertexBaseUrl(p.baseUrl ?? "") ? "official-documentation"
        : builtin ? liveIds ? "remote" : configuredIds.size ? "configured" : "preset" : "configured",
    });
    return result;
  }

  #configuredModelIds(providerId: string): ReadonlySet<string> {
    const config = this.#latestModelConfig;
    const ids = new Set<string>((providerId === KULO_GATEWAY_PROVIDER_ID ? config?.gatewayModels
      : this.#customProviderMeta.get(providerId)?.models ?? this.#subscriptionModelsFor(providerId))?.map((model) => model.id) ?? []);
    const fallbackProvider = config?.gatewayDisabled ? "" : KULO_GATEWAY_PROVIDER_ID;
    if ((config?.defaultProvider?.trim() || fallbackProvider) === providerId && config?.defaultModel.trim()) {
      ids.add(config.defaultModel.trim());
    }
    for (const role of Object.values(this.#latestRoles)) {
      if (role.external) continue;
      if ((role.provider?.trim() || fallbackProvider) === providerId && role.modelId?.trim()) ids.add(role.modelId.trim());
    }
    return ids;
  }

  #subscriptionModelsFor(providerId: string): CustomModelConfig[] | undefined {
    const subscriptions = this.#latestModelConfig?.subscriptionModels;
    return subscriptions && Object.hasOwn(subscriptions, providerId) ? subscriptions[providerId] : undefined;
  }

  #buildModelEnricher(options: {
    presetMeta?: MainstreamProviderPreset;
    targetApi: CustomProviderApi;
    officialSource: boolean;
  }): (raw: RawDiscoveredModel) => ProviderModelItem {
    const { presetMeta, targetApi, officialSource } = options;
    const presetBuiltinModels = presetMeta?.builtinId
      ? this.models.getModels(presetMeta.builtinId)
      : [];
    const presetModelById = new Map<string, Model<Api>>(
      presetBuiltinModels.map((m) => [m.id.toLowerCase(), m]),
    );
    const globalModelById = new Map<string, Model<Api>>();
    for (const builtinId of this.#builtinIds) {
      for (const m of this.models.getModels(builtinId)) {
        const lower = m.id.toLowerCase();
        if (!globalModelById.has(lower)) {
          globalModelById.set(lower, m);
        }
        const slash = lower.indexOf("/");
        if (slash > 0) {
          const tail = lower.slice(slash + 1);
          if (!globalModelById.has(tail)) {
            globalModelById.set(tail, m);
          }
        }
      }
    }

    return (raw: RawDiscoveredModel): ProviderModelItem => {
      const candidates = normalizeModelIdCandidates(raw.id);
      let match: Model<Api> | undefined;
      for (const candidate of candidates) {
        match = presetModelById.get(candidate);
        if (match) break;
      }
      if (!match) {
        for (const candidate of candidates) {
          match = globalModelById.get(candidate);
          if (match) break;
        }
      }
      const baseItem = match ? toProviderModelItem(match, undefined, presetMeta?.id) : undefined;
      const regEntry = this.metadataRegistry.lookup(raw.id, {
        preset: presetMeta?.id,
        api: targetApi,
      });

      const outputModalities = raw.outputModalities?.length
        ? raw.outputModalities
        : regEntry?.outputModalities?.length
          ? regEntry.outputModalities
          : baseItem?.outputModalities;

      const inferred = inferModelPurpose({
        id: raw.id,
        ...(raw.purpose ? { purpose: raw.purpose } : regEntry?.purpose ? { purpose: regEntry.purpose } : {}),
        ...(outputModalities ? { outputModalities } : {}),
      });
      const purpose = raw.purpose ?? regEntry?.purpose ?? baseItem?.purpose ?? (inferred !== "chat" ? inferred : undefined);

      const metadataSource: ModelMetadataSource =
        raw.contextWindow !== undefined || raw.maxTokens !== undefined || raw.inputModalities?.length
          ? "provider-api"
          : regEntry
            ? regEntry.source
            : baseItem
              ? "pi-ai"
              : "default";

      if (purpose && purpose !== "chat") {
        const item = nonChatConfigToProviderModelItem({
          id: raw.id,
          purpose,
          ...(raw.name ? { name: raw.name } : regEntry?.name ? { name: regEntry.name } : baseItem?.name ? { name: baseItem.name } : {}),
          ...(outputModalities ? { outputModalities } : {}),
          ...(raw.contextWindow ? { contextWindow: raw.contextWindow } : regEntry?.contextWindow ? { contextWindow: regEntry.contextWindow } : {}),
          ...(raw.maxTokens ? { maxTokens: raw.maxTokens } : regEntry?.maxTokens ? { maxTokens: regEntry.maxTokens } : {}),
        }, targetApi, presetMeta?.id);
        return { ...item, metadataSource };
      }

      const resolvedApi: CustomProviderApi =
        presetMeta?.supportedApis && match?.api && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(match.api)
          ? match.api as CustomProviderApi
          : targetApi;

      const contextWindow =
        raw.contextWindow ??
        regEntry?.contextWindow ??
        baseItem?.contextWindow ??
        DEFAULT_CONTEXT_WINDOW;
      const rawMaxTokens =
        raw.maxTokens ??
        regEntry?.maxTokens ??
        baseItem?.maxTokens ??
        DEFAULT_MAX_TOKENS;
      const maxTokens = Math.min(rawMaxTokens, contextWindow);

      const modalities: ModelModality[] = raw.inputModalities?.length
        ? [...raw.inputModalities]
        : regEntry?.inputModalities?.length
          ? [...regEntry.inputModalities]
          : baseItem?.modalities?.length
            ? [...baseItem.modalities]
            : ["text"];

      const reasoning = raw.reasoning ?? regEntry?.reasoning ?? baseItem?.reasoning ?? false;
      let thinkingLevelMap: ThinkingLevelMapConfig | undefined;
      let supportedThinkingLevels: ThinkingEffort[] = ["off"];
      let thinkingLevels: ProviderModelItem["thinkingLevels"];

      if (reasoning) {
        const usePiThinking = Boolean(
          baseItem &&
          match?.api === resolvedApi &&
          (baseItem.thinkingLevelMap || !regEntry?.reasoningEfforts?.length),
        );
        if (usePiThinking && baseItem) {
          thinkingLevelMap = sanitizeThinkingLevelMapForApi(baseItem.thinkingLevelMap, resolvedApi);
          const allowed = allowedThinkingWireValuesForApi(resolvedApi);
          supportedThinkingLevels = allowed
            ? baseItem.supportedThinkingLevels.filter((level) => allowed.includes(level))
            : [...baseItem.supportedThinkingLevels];
          if (supportedThinkingLevels.length === 0) supportedThinkingLevels = ["medium", "high"];
        } else if (regEntry) {
          const derived = buildThinkingConfigFromRegistry(resolvedApi, regEntry);
          thinkingLevelMap = derived.thinkingLevelMap;
          supportedThinkingLevels = derived.supportedThinkingLevels;
          thinkingLevels = derived.thinkingLevels;
        } else {
          const isGoogle = resolvedApi === "google-generative-ai" || resolvedApi === "google-vertex";
          supportedThinkingLevels = isGoogle ? ["off", "low", "medium", "high"] : ["off", "low", "medium", "high", "xhigh"];
        }
      }

      const nativeTools = resolveDefaultNativeTools({
        modelId: raw.id,
        api: resolvedApi,
        officialSource,
        presetId: presetMeta?.id,
        registryEntry: regEntry,
      });

      return {
        id: raw.id,
        ...(outputModalities ? { outputModalities: [...outputModalities] } : {}),
        name: raw.name || regEntry?.name || baseItem?.name || raw.id,
        api: resolvedApi,
        reasoning,
        thinkingEnabled: reasoning,
        vision: modalities.includes("image"),
        modalities,
        contextWindow,
        maxTokens,
        supportedThinkingLevels,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        ...(thinkingLevels ? { thinkingLevels } : {}),
        ...(nativeTools ? { nativeTools } : {}),
        metadataSource,
      };
    };
  }

  async resolveModelMetadata(req: ResolveModelMetadataRequest): Promise<ResolveModelMetadataResponse> {
    const modelId = req.modelId.trim();
    if (!modelId) throw new Error("请填写模型 ID");
    const providerId = req.providerId?.trim() || undefined;
    const customMeta = providerId ? this.#customProviderMeta.get(providerId) : undefined;
    const presetId = req.preset?.trim().toLowerCase() || customMeta?.preset?.trim().toLowerCase();
    const presetMeta = presetId ? PRESET_BY_ID.get(presetId) : undefined;
    const baseUrl = req.baseUrl?.trim() || customMeta?.baseUrl || presetMeta?.baseUrl || "";
    const officialSource = Boolean(
      (providerId && this.#builtinIds.has(providerId)) ||
      (presetMeta && (!baseUrl || (presetMeta.baseUrl && isSameOrigin(baseUrl, presetMeta.baseUrl)))),
    );
    if (req.refreshMetadata) {
      await this.metadataRegistry.refresh();
    }
    const enrichModel = this.#buildModelEnricher({
      presetMeta,
      targetApi: req.api,
      officialSource,
    });
    const model = enrichModel({ id: modelId });
    const resolvedApi = (model.api && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(model.api)
      ? model.api
      : req.api) as CustomProviderApi;
    const allowedWire = allowedThinkingWireValuesForApi(resolvedApi);
    const nativeSearchAllowed =
      isOfficialNativeSearchDefaultEligible({ api: resolvedApi, officialSource, presetId: presetMeta?.id }) ||
      Boolean(
        officialSource &&
        presetMeta?.id === "openrouter" &&
        ["openai-completions", "openai-responses", "anthropic-messages"].includes(resolvedApi),
      );
    return {
      model,
      ...(allowedWire ? { allowedThinkingWireValues: [...allowedWire] } : {}),
      nativeSearchAllowed,
    };
  }

  async discoverModels(req: DiscoverModelsRequest): Promise<DiscoverModelsResponse> {
    const startedAt = Date.now();
    const providerId = req.providerId?.trim() || undefined;
    const customMeta = providerId ? this.#customProviderMeta.get(providerId) : undefined;
    const effectivePresetId = req.preset?.trim().toLowerCase() || customMeta?.preset?.trim().toLowerCase();
    const presetMeta = effectivePresetId
      ? PRESET_BY_ID.get(effectivePresetId)
      : undefined;
    const existingProvider = providerId ? this.models.getProvider(providerId) : undefined;
    const existingBaseUrl =
      providerId === KULO_GATEWAY_PROVIDER_ID
        ? this.#latestModelConfig?.baseUrl
        : customMeta?.baseUrl ?? existingProvider?.baseUrl;

    const rawBaseInput =
      req.baseUrl?.trim() || existingBaseUrl || presetMeta?.baseUrl || "";
    if (!rawBaseInput) {
      return {
        ok: false,
        models: [],
        latencyMs: 0,
        error: "请填写 BaseURL",
      };
    }

    const targetApi: CustomProviderApi = req.api;
    const baseUrl = normalizeProviderBaseUrl(rawBaseInput, targetApi);
    const publicVertexCatalog = targetApi === "google-vertex" && isOfficialVertexBaseUrl(baseUrl);
    if (targetApi === "google-vertex" && !publicVertexCatalog) {
      const savedVertex = providerId === KULO_GATEWAY_PROVIDER_ID ? this.#latestModelConfig : customMeta;
      normalizeVertexConfig({
        vertexProject: req.vertexProject !== undefined ? req.vertexProject : savedVertex?.vertexProject,
        vertexLocation: req.vertexLocation !== undefined ? req.vertexLocation : savedVertex?.vertexLocation,
      });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("invalid protocol");
      }
    } catch {
      return {
        ok: false,
        models: [],
        latencyMs: 0,
        error: "BaseURL 格式无效",
      };
    }

    // Only reuse stored API key if explicit baseUrl wasn't changed to a different origin
    let resolvedKey = publicVertexCatalog ? undefined : req.apiKey?.trim() || undefined;
    if (!publicVertexCatalog && !resolvedKey && providerId) {
      const safeToReuseStored =
        !req.baseUrl?.trim() ||
        (existingBaseUrl ? isSameOrigin(baseUrl, existingBaseUrl) : false);
      if (safeToReuseStored) {
        const stored = await this.credentials.read(providerId);
        if (providerId === KULO_GATEWAY_PROVIDER_ID) {
          resolvedKey = this.#gatewayApiKey(stored, baseUrl)?.key;
        } else if (customMeta) {
          resolvedKey = apiKeyForOrigin(stored, baseUrl);
        } else if (stored?.type === "api_key") {
          resolvedKey = stored.key;
        }
      }
    }

    const officialSource = Boolean(
      presetMeta && presetMeta.baseUrl && isSameOrigin(baseUrl, presetMeta.baseUrl),
    );

    try {
      // On-demand metadata registry refresh runs concurrently and never blocks or fails discovery.
      const metadataRefresh = req.refreshMetadata
        ? this.metadataRegistry.refresh().catch(() => undefined)
        : Promise.resolve(undefined);
      const [rawItems] = await Promise.all([
        fetchLiveProviderModels({
          baseUrl,
          api: targetApi,
          apiKey: resolvedKey,
          signal: AbortSignal.timeout(30_000),
        }),
        metadataRefresh,
      ]);
      const enrichModel = this.#buildModelEnricher({
        presetMeta,
        targetApi,
        officialSource,
      });
      return {
        ok: true,
        models: rawItems.map(enrichModel),
        ...(publicVertexCatalog ? { source: "official-documentation" as const, sourceUrl: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions?hl=en" } : {}),
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (err) {
      return {
        ok: false,
        models: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listCatalog(): Promise<ProviderCatalogItem[]> {
    const providers = [...this.models.getProviders()];
    const items = await Promise.all(providers.map((p) => this.#inspectProviderItem(p)));

    items.sort((a, b) => {
      if (a.id === KULO_GATEWAY_PROVIDER_ID) return -1;
      if (b.id === KULO_GATEWAY_PROVIDER_ID) return 1;
      // Custom user providers appear right after default gateway
      const aCustom = !a.builtin;
      const bCustom = !b.builtin;
      if (aCustom !== bCustom) return aCustom ? -1 : 1;
      // Authenticated providers bubble up cleanly within built-in/custom groups
      if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
      const rankA = FEATURED_RANK.get(a.id) ?? 999;
      const rankB = FEATURED_RANK.get(b.id) ?? 999;
      if (rankA !== rankB) return rankA - rankB;
      return a.name.localeCompare(b.name);
    });

    return items;
  }

  async getProviderCatalogItem(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.models.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' not found`);
    }
    return this.#inspectProviderItem(provider);
  }

  async setApiKey(providerId: string, apiKey: string): Promise<ProviderCatalogItem> {
    const provider = this.models.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' not found`);
    }
    if (!provider.auth.apiKey) {
      throw new Error(`Provider '${providerId}' does not support API key authentication`);
    }
    const cleanKey = apiKey.trim();
    if (!cleanKey) {
      throw new Error("API Key 不能为空");
    }

    const origin = providerId === KULO_GATEWAY_PROVIDER_ID || this.#customProviderMeta.has(providerId)
      ? getOriginSafe(provider.baseUrl ?? "")
      : null;
    await this.credentials.modify(providerId, async (current) => {
      const env = { ...(current?.type === "api_key" ? current.env : undefined), ...(origin ? { [API_KEY_ORIGIN_ENV]: origin } : {}) };
      return { type: "api_key", key: cleanKey, ...(Object.keys(env).length ? { env } : {}) };
    });
    this.#liveBuiltinModelIds.delete(providerId);

    try {
      await this.models.refresh({
        providers: [providerId],
        allowNetwork: true,
        force: true,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Saving a credential is independent of listing models.
    }

    return this.#inspectProviderItem(provider);
  }

  /** Native vendor search is restricted to built-in subscriptions and official vendor presets at their official origin. */
  isOfficialNativeSearchAllowed(providerId: string): boolean {
    if (providerId === "google" || providerId === "google-vertex") return false;
    if (this.#builtinIds.has(providerId)) return true;
    const meta = this.#customProviderMeta.get(providerId);
    if (!meta?.preset || meta.preset === "google" || meta.preset === "google-vertex") return false;
    const preset = PRESET_BY_ID.get(meta.preset);
    return Boolean(preset?.baseUrl && isSameOrigin(meta.baseUrl, preset.baseUrl));
  }

  async resolveConfiguredModel(providerId: string, modelId: string): Promise<{
    providerId: string;
    modelId: string;
    baseUrl: string;
    api: CustomProviderApi;
    preset?: string;
    vertexProject?: string;
    vertexLocation?: string;
    model: CustomModelConfig;
    protocolAdapter?: ModelProtocolAdapter;
    voices: string[];
    apiKey?: string;
  } | undefined> {
    const cleanModelId = modelId.trim();
    if (!cleanModelId) return undefined;
    let baseUrl: string | undefined;
    let api: CustomProviderApi | undefined;
    let preset: string | undefined;
    let vertexProject: string | undefined;
    let vertexLocation: string | undefined;
    let configured: CustomModelConfig | undefined;
    if (providerId === KULO_GATEWAY_PROVIDER_ID) {
      const live = this.#latestModelConfig;
      if (!live || live.gatewayDisabled) return undefined;
      baseUrl = live.baseUrl;
      api = live.apiMode;
      vertexProject = live.vertexProject;
      vertexLocation = live.vertexLocation;
      configured = live.gatewayModels?.find((m) => m.id === cleanModelId);
    } else {
      const meta = this.#customProviderMeta.get(providerId);
      if (!meta) return undefined;
      baseUrl = meta.baseUrl;
      api = meta.api;
      preset = meta.preset;
      vertexProject = meta.vertexProject;
      vertexLocation = meta.vertexLocation;
      configured = meta.models.find((m) => m.id === cleanModelId);
    }
    if (!baseUrl || !api || !configured) return undefined;
    const model: CustomModelConfig = cloneJson(configured);
    const purpose = inferModelPurpose(model);
    const protocolAdapter = model.protocolAdapter ?? defaultProtocolAdapterForModel(purpose, cleanModelId, api, preset);
    const voices = model.voices?.length ? [...model.voices] : defaultVoicesForAdapter(protocolAdapter);
    const apiKey = await this.resolveServiceApiKey(providerId, cleanModelId, baseUrl);
    return {
      providerId,
      modelId: cleanModelId,
      baseUrl,
      api,
      ...(preset ? { preset } : {}),
      ...(vertexProject ? { vertexProject } : {}),
      ...(vertexLocation ? { vertexLocation } : {}),
      model,
      ...(protocolAdapter ? { protocolAdapter } : {}),
      voices,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  /** Export only an API key bound to the selected connection's current origin. */
  async resolveServiceApiKey(providerId: string, modelId: string, baseUrl: string): Promise<string | undefined> {
    if (!modelId.trim()) return undefined;
    return this.resolveProbeApiKey(providerId, baseUrl);
  }

  /** A draft model may be unregistered, but its probe still belongs to one saved connection. */
  async resolveProbeApiKey(providerId: string, baseUrl: string): Promise<string | undefined> {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.apiKey || !provider.baseUrl || !isSameOrigin(provider.baseUrl, baseUrl)) return undefined;
    const credential = await this.credentials.read(providerId);
    if (providerId === KULO_GATEWAY_PROVIDER_ID) return this.#gatewayApiKey(credential, baseUrl)?.key;
    if (credential?.type !== "api_key") return undefined;
    return this.#customProviderMeta.has(providerId) ? apiKeyForOrigin(credential, baseUrl) : credential.key;
  }

  async logout(providerId: string): Promise<ProviderCatalogItem | null> {
    const provider = this.models.getProvider(providerId);
    await this.models.logout(providerId);
    this.#liveBuiltinModelIds.delete(providerId);
    if (!provider) return null;
    return this.#inspectProviderItem(provider);
  }

  async refreshProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.models.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' not found`);
    }
    const api = this.#customProviderMeta.get(providerId)?.api
      ?? (providerId === KULO_GATEWAY_PROVIDER_ID ? this.#latestModelConfig?.apiMode : undefined);
    if (api === "google-vertex" && isOfficialVertexBaseUrl(provider.baseUrl ?? "")) {
      // The SDK's refresh path requires a model-call credential; public documentation does not.
      const catalog = await this.discoverModels({ providerId, api });
      if (!catalog.ok) throw new Error(catalog.error || "获取官方模型目录失败，请重试。");
      return { ...await this.#inspectProviderItem(provider), models: catalog.models };
    }
    if (!provider.refreshModels) throw new Error("此供应商暂不支持实时获取模型列表，请手动添加模型。");
    const revision = this.#modelRefreshRevisions.get(providerId) ?? 0;
    this.#liveBuiltinModelIds.delete(providerId);
    const result = await this.models.refresh({
      providers: [providerId],
      allowNetwork: true,
      force: true,
      signal: AbortSignal.timeout(30_000),
    });
    const error = result.errors.get(providerId);
    if (error) throw error;
    if (result.aborted) throw new Error("获取模型列表超时，请重试。");
    if ((this.#modelRefreshRevisions.get(providerId) ?? 0) === revision) {
      throw new Error("未能获取实时模型列表，请检查 API Key 或授权状态。");
    }
    return this.#inspectProviderItem(provider);
  }

  async startOAuthLogin(
    providerId: string,
    agentName = "Kulo",
  ): Promise<OAuthSessionView> {
    const provider = this.models.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' not found`);
    }
    if (!provider.auth.oauth) {
      throw new Error(`Provider '${providerId}' does not support OAuth authentication`);
    }

    this.#gcOAuthSessions();

    const sessionId = crypto.randomUUID();
    const abortController = new AbortController();
    const session: InternalOAuthSession = {
      sessionId,
      providerId,
      status: "pending",
      infoMessages: [],
      abortController,
      createdAt: Date.now(),
    };
    this.#oauthSessions.set(sessionId, session);

    let settledOrFirstEvent: (() => void) | null = null;
    const firstSignalPromise = new Promise<void>((resolve) => {
      settledOrFirstEvent = resolve;
    });
    const pulse = () => {
      if (settledOrFirstEvent) {
        const fn = settledOrFirstEvent;
        settledOrFirstEvent = null;
        fn();
      }
      session.notifyUpdate?.();
    };

    const interaction: AuthInteraction = {
      signal: abortController.signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          session.authUrl = event.url;
        } else if (event.type === "device_code") {
          session.deviceCode = {
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            ...(event.expiresInSeconds !== undefined
              ? { expiresInSeconds: event.expiresInSeconds }
              : {}),
          };
          if (!session.authUrl) {
            session.authUrl = event.verificationUri;
          }
        } else if (event.type === "info") {
          session.infoMessages.push(localizeOAuthInfo(event.message));
          if (session.infoMessages.length > 20) {
            session.infoMessages = session.infoMessages.slice(-20);
          }
        } else if (event.type === "progress") {
          session.progressMessage = localizeOAuthProgress(event.message);
        }
        pulse();
      },
      prompt: (prompt: AuthPrompt) => {
        return new Promise<string>((resolve, reject) => {
          const promptId = crypto.randomUUID();
          session.prompt = localizeOAuthPrompt(prompt, promptId);

          const cleanup = () => {
            session.prompt = undefined;
            session.resolvePrompt = undefined;
            session.rejectPrompt = undefined;
            prompt.signal?.removeEventListener("abort", onPromptAbort);
            abortController.signal.removeEventListener("abort", onSessionAbort);
          };

          const onPromptAbort = () => {
            cleanup();
            reject(
              prompt.signal?.reason instanceof Error
                ? prompt.signal.reason
                : new Error("Prompt cancelled"),
            );
          };

          const onSessionAbort = () => {
            cleanup();
            reject(new Error("OAuth login cancelled"));
          };

          if (prompt.signal?.aborted) {
            onPromptAbort();
            return;
          }
          if (abortController.signal.aborted) {
            onSessionAbort();
            return;
          }

          session.resolvePrompt = (value: string) => {
            cleanup();
            resolve(value);
          };
          session.rejectPrompt = (err: Error) => {
            cleanup();
            reject(err);
          };

          prompt.signal?.addEventListener("abort", onPromptAbort, { once: true });
          abortController.signal.addEventListener("abort", onSessionAbort, { once: true });
          pulse();
        });
      },
    };

    void this.models
      .login(providerId, "oauth", interaction, {
        agentName,
        getDeviceId: () => getOrCreateDeviceId(this.stateDir),
      })
      .then(async () => {
        session.prompt = undefined;
        session.status = "completed";
        this.#liveBuiltinModelIds.delete(providerId);
        try {
          await this.models.refresh({
            providers: [providerId],
            allowNetwork: true,
            force: true,
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          // Best-effort refresh after login
        }
        pulse();
      })
      .catch((err) => {
        session.prompt = undefined;
        if (abortController.signal.aborted) {
          session.status = "cancelled";
          session.error = "已取消登录";
        } else {
          session.status = "failed";
          session.error = localizeOAuthError(
            err instanceof Error ? err.message : String(err),
          );
        }
        pulse();
      });

    // Wait briefly so synchronous/fast auth_url or initial prompts are included in the start response
    await Promise.race([
      firstSignalPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 180)),
    ]);

    return this.#toSessionView(session);
  }

  getOAuthSession(sessionId: string): OAuthSessionView | null {
    const session = this.#oauthSessions.get(sessionId);
    return session ? this.#toSessionView(session) : null;
  }

  async respondOAuthPrompt(
    sessionId: string,
    promptId: string | undefined,
    value: string,
  ): Promise<OAuthSessionView> {
    const session = this.#oauthSessions.get(sessionId);
    if (!session) {
      throw new Error(`OAuth session '${sessionId}' not found`);
    }
    if (!session.prompt || !session.resolvePrompt) {
      return this.#toSessionView(session);
    }
    if (promptId && session.prompt.id !== promptId) {
      return this.#toSessionView(session);
    }

    let resolveNextSignal: (() => void) | null = null;
    const nextSignalPromise = new Promise<void>((resolve) => {
      resolveNextSignal = resolve;
    });
    session.notifyUpdate = () => {
      if (resolveNextSignal) {
        const fn = resolveNextSignal;
        resolveNextSignal = null;
        fn();
      }
    };

    try {
      session.resolvePrompt(value);
      await Promise.race([
        nextSignalPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
      // Allow chained notify + prompt events (e.g. auth_url + manual_code) to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } finally {
      session.notifyUpdate = undefined;
    }
    return this.#toSessionView(session);
  }

  cancelOAuthSession(sessionId: string): OAuthSessionView | null {
    const session = this.#oauthSessions.get(sessionId);
    if (!session) return null;
    if (session.status === "pending") {
      session.abortController.abort(new Error("OAuth login cancelled"));
      session.rejectPrompt?.(new Error("OAuth login cancelled"));
      session.status = "cancelled";
      session.error = "已取消登录";
    }
    return this.#toSessionView(session);
  }

  #toSessionView(session: InternalOAuthSession): OAuthSessionView {
    return {
      sessionId: session.sessionId,
      providerId: session.providerId,
      status: session.status,
      ...(session.authUrl ? { authUrl: session.authUrl } : {}),
      ...(session.instructions ? { instructions: session.instructions } : {}),
      ...(session.deviceCode ? { deviceCode: { ...session.deviceCode } } : {}),
      infoMessages: [...session.infoMessages],
      ...(session.progressMessage ? { progressMessage: session.progressMessage } : {}),
      ...(session.prompt ? { prompt: cloneJson(session.prompt) } : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }

  #gcOAuthSessions(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, session] of this.#oauthSessions) {
      if (session.status !== "pending" && session.createdAt < cutoff) {
        this.#oauthSessions.delete(id);
      }
    }
  }
}
