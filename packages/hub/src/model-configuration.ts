import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import { CUSTOM_PROVIDER_APIS, isConversationModel, MODEL_PROTOCOL_ADAPTERS, MODEL_PURPOSES, redactSensitiveText, validateCustomImageAdapter, validateImageModelProfile, type CustomModelConfig, type CustomProviderApi, type CustomProviderConfig, type DiscoverModelsRequest, type DiscoverModelsResponse, type MocoSettingsView, type ProviderCatalogItem } from "@moco/protocol";
import type { ModelConfigurationCandidate, ModelConfigurationDraft, ModelConfigurationPrepareRequest, ModelConfigurationProbe, ModelConfigurationSaveResult, ModelConfigurationUpdateRequest, ModelConfigurationVerification, ModelConfigurationWorkspace } from "@moco/protocol";
import { normalizeProviderBaseUrl } from "./config.js";
import { MAINSTREAM_PROVIDER_PRESETS } from "./providers.js";
import { sanitizeThinkingLevelMap, sanitizeThinkingLevels, SettingsUpdateError } from "./settings.js";

const MAX_DRAFTS_PER_WINDOW = 8;

export interface ModelConfigurationCommit {
  fingerprint: string;
  clientId: string;
  draftId: string;
  draftRevision: number;
  provider: CustomProviderConfig;
  defaultModelId?: string;
  verifications: ModelConfigurationVerification[];
}
interface ModelConfigurationCleanup {
  clientId: string;
  draftId: string;
  draftRevision: number;
  providerId: string;
}
interface DraftBaseline {
  provider: CustomProviderConfig | null;
  defaultProvider?: string;
  defaultModel?: string;
}
interface ConfigurationState {
  drafts: Record<string, ModelConfigurationDraft>;
  baselines?: Record<string, DraftBaseline>;
  commits: Record<string, ModelConfigurationCommit>;
  receipts: Record<string, { fingerprint: string; result: ModelConfigurationSaveResult | { draft: ModelConfigurationDraft; verification: ModelConfigurationVerification }; cleanup?: ModelConfigurationCleanup }>;
}
export const ModelConfigurationDoc = defineDoc<ConfigurationState & JsonObject>({
  kind: "moco.model-configuration", version: 1, scope: "session",
  initial: () => ({ drafts: {}, baselines: {}, commits: {}, receipts: {} }) as ConfigurationState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class ModelConfigurationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface ModelConfigurationOptions {
  harness: Harness;
  settings: () => MocoSettingsView;
  providers: () => Promise<ProviderCatalogItem[]>;
  discover: (request: DiscoverModelsRequest) => Promise<DiscoverModelsResponse>;
  probe: ModelConfigurationProbe;
  saveProvider: (input: { provider: CustomProviderConfig; expectedSettingsRevision: number; defaultModelId?: string; apiKey?: string; operationKey: string; fingerprint: string; commit: ModelConfigurationCommit }) => Promise<MocoSettingsView>;
  redact?: (text: string) => string;
  rememberSecrets?: (values: readonly string[]) => void;
  onChanged?: () => void | Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status: number, code: string, message: string): never => { throw new ModelConfigurationError(status, code, message); };
export function modelConfigurationIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) return fail(400, "invalid_model_configuration_id", "模型配置标识无效。");
  return value;
}
function assertRevision(draft: ModelConfigurationDraft | undefined, expected: unknown): asserts draft is ModelConfigurationDraft {
  if (!Number.isSafeInteger(expected) || Number(expected) < 1) fail(400, "invalid_model_configuration_revision", "模型草稿版本无效。");
  if (!draft || draft.revision !== expected) fail(409, "model_configuration_conflict", "模型草稿已更新，请载入最新草稿后继续。");
}
function publicText(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return fail(400, "invalid_model_configuration", `${label}无效。`);
  return value.trim();
}
function endpoint(raw: unknown, api: CustomProviderConfig["api"], allowEmpty = false): string {
  if (allowEmpty && raw === "") return "";
  const value = publicText(raw, "接口地址", 2048);
  let url: URL;
  try { url = new URL(value); } catch { return fail(400, "invalid_model_endpoint", "请输入有效的 HTTP 或 HTTPS 接口地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(400, "invalid_model_endpoint", "接口地址不能包含凭据、查询参数或片段。");
  return normalizeProviderBaseUrl(value, api);
}
const MODEL_FIELDS = new Set(["id", "name", "purpose", "protocolAdapter", "voices", "imageProfile", "imageDefaults", "customImageAdapter", "outputModalities", "contextWindow", "maxTokens", "reasoning", "thinkingEnabled", "vision", "modalities", "thinkingLevelMap", "thinkingLevels", "nativeTools"]);
const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);
function validModalities(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.length <= 5 && value.every((item) => typeof item === "string" && MODALITIES.has(item)) && new Set(value).size === value.length; }
export function validateConfigurationModel(raw: unknown, api?: CustomProviderApi): asserts raw is CustomModelConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_model_configuration", "模型配置无效。");
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).some((key) => !MODEL_FIELDS.has(key))) fail(400, "invalid_model_configuration_field", "模型包含不支持的字段。");
  publicText(item.id, "模型 ID");
  if (item.name !== undefined) publicText(item.name, "模型名称");
  if (item.purpose !== undefined && !(MODEL_PURPOSES as readonly unknown[]).includes(item.purpose)) fail(400, "invalid_model_purpose", "模型类型无效。");
  if (item.protocolAdapter !== undefined && !(MODEL_PROTOCOL_ADAPTERS as readonly unknown[]).includes(item.protocolAdapter)) fail(400, "invalid_model_protocol_adapter", "模型接口协议无效。");
  if (item.voices !== undefined && (!Array.isArray(item.voices) || item.voices.length > 64 || item.voices.some((v) => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(v)))) fail(400, "invalid_model_voices", "模型音色列表无效。");
  if (item.imageProfile !== undefined) {
    try { validateImageModelProfile(item.imageProfile as NonNullable<CustomModelConfig["imageProfile"]>); }
    catch (err) { fail(400, "invalid_model_image_profile", err instanceof Error ? err.message : "图像能力声明无效。"); }
  }
  if (item.customImageAdapter !== undefined) {
    try { validateCustomImageAdapter(item.customImageAdapter as NonNullable<CustomModelConfig["customImageAdapter"]>); }
    catch (err) { fail(400, "invalid_model_custom_image_adapter", err instanceof Error ? err.message : "自定义图像接口无效。"); }
  }
  const isChat = isConversationModel(item as unknown as CustomModelConfig);
  if (isChat) {
    for (const key of ["contextWindow", "maxTokens"] as const) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 1 || Number(item[key]) > 10_000_000)) fail(400, "invalid_model_capacity", "上下文或最大输出必须为 1 到 10000000 之间的整数。");
    if (typeof item.contextWindow === "number" && typeof item.maxTokens === "number" && item.maxTokens > item.contextWindow) fail(400, "invalid_model_capacity", "最大输出不能超过上下文长度。");
  }
  if (item.modalities !== undefined && !validModalities(item.modalities) || item.outputModalities !== undefined && !validModalities(item.outputModalities)) fail(400, "invalid_model_modalities", "模型输入或输出类型无效。");
  for (const key of ["reasoning", "thinkingEnabled", "vision"]) if (item[key] !== undefined && typeof item[key] !== "boolean") fail(400, "invalid_model_configuration", "模型能力字段无效。");
  if (item.thinkingLevels !== undefined) {
    if (!Array.isArray(item.thinkingLevels) || item.thinkingLevels.length > 12) fail(400, "invalid_model_thinking", "思考档位无效。");
    for (const level of item.thinkingLevels as Array<Record<string, unknown>>) {
      if (!level || typeof level !== "object" || Object.keys(level).some((key) => !["id", "label", "value"].includes(key))) fail(400, "invalid_model_thinking", "思考档位无效。");
    }
    if (isChat) {
      try { sanitizeThinkingLevels(item.thinkingLevels, api); }
      catch (err) { fail(400, "invalid_model_thinking", err instanceof SettingsUpdateError || err instanceof Error ? err.message : "思考档位无效。"); }
    }
  }
  if (item.thinkingLevelMap !== undefined) {
    if (!item.thinkingLevelMap || typeof item.thinkingLevelMap !== "object" || Array.isArray(item.thinkingLevelMap) || Object.entries(item.thinkingLevelMap).some(([key, value]) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key) || value !== null && (typeof value !== "string" || value.length > 100))) fail(400, "invalid_model_thinking", "思考参数映射无效。");
  }
  if (isChat) {
    const tlm = sanitizeThinkingLevelMap(item.thinkingLevelMap, api);
    const levels = item.thinkingLevels as Array<{ value?: unknown }> | undefined;
    if (item.reasoning !== false && tlm?.off === null && (item.thinkingEnabled === false || levels?.some((level) => level.value === "off"))) {
      fail(400, "invalid_model_thinking", `模型「${String(item.id).trim()}」不支持关闭思考，请移除关闭档位并保持思考强度开启。`);
    }
  }
  if (item.nativeTools !== undefined && (!item.nativeTools || typeof item.nativeTools !== "object" || Array.isArray(item.nativeTools) || Object.entries(item.nativeTools).some(([key, value]) => key !== "webSearch" || typeof value !== "boolean"))) fail(400, "invalid_model_native_tools", "模型原生工具字段无效。");
  if (isChat && (item.nativeTools as { webSearch?: boolean } | undefined)?.webSearch === true && (api === "google-generative-ai" || api === "google-vertex")) {
    fail(400, "invalid_model_native_tools", "Google API 不支持将原生联网搜索与智能体函数工具同时使用，请保持关闭。");
  }
}
export function validateConfigurationProvider(raw: unknown, allowEmptyEndpoint = false): asserts raw is CustomProviderConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_model_provider", "供应商配置无效。");
  const provider = raw as Record<string, unknown>;
  if (Object.keys(provider).some((key) => !["id", "name", "preset", "api", "baseUrl", "models", "vertexProject", "vertexLocation"].includes(key))) fail(400, "invalid_model_provider_field", "供应商只接收公开配置；密钥请通过保密输入填写。");
  modelConfigurationIdentifier(provider.id); publicText(provider.name, "供应商名称", 80);
  if (!(CUSTOM_PROVIDER_APIS as readonly unknown[]).includes(provider.api)) fail(400, "invalid_model_protocol", "请选择支持的接口协议。");
  const api = provider.api as CustomProviderApi;
  endpoint(provider.baseUrl, api, allowEmptyEndpoint);
  for (const key of ["preset", "vertexProject", "vertexLocation"]) if (provider[key] !== undefined) publicText(provider[key], key, 200);
  if (!Array.isArray(provider.models) || provider.models.length > 256) fail(400, "invalid_model_selection", "模型数量无效。");
  const ids = new Set<string>();
  for (const model of provider.models as unknown[]) { validateConfigurationModel(model, api); if (ids.has(model.id)) fail(400, "duplicate_model_selection", "模型 ID 不能重复。"); ids.add(model.id); }
  if (JSON.stringify(provider).length > 128_000) fail(400, "model_configuration_too_large", "模型配置过大。");
}

function draftsForClient(doc: Readonly<ConfigurationState> | undefined, clientId: string): Array<{ key: string; draft: ModelConfigurationDraft }> {
  if (!doc?.drafts) return [];
  const list: Array<{ key: string; draft: ModelConfigurationDraft }> = [];
  for (const [key, draft] of Object.entries(doc.drafts)) {
    if (draft?.clientId === clientId) list.push({ key, draft });
  }
  list.sort((left, right) => right.draft.updatedAt - left.draft.updatedAt || left.draft.id.localeCompare(right.draft.id));
  return list;
}

function findDraftEntry(
  doc: Readonly<ConfigurationState> | undefined,
  clientId: string,
  draftId?: string,
): { key: string; draft: ModelConfigurationDraft } | undefined {
  const entries = draftsForClient(doc, clientId);
  if (draftId !== undefined) {
    const cleanId = modelConfigurationIdentifier(draftId);
    return entries.find((entry) => entry.draft.id === cleanId);
  }
  return entries[0];
}

export class MocoModelConfiguration {
  #options: ModelConfigurationOptions;
  #queue: Promise<unknown> = Promise.resolve();
  /** Keyed by draftId so multiple drafts in one window keep their staged credentials isolated. */
  #secrets = new Map<string, { draftId: string; revision: number; origin: string; value: string }>();
  constructor(options: ModelConfigurationOptions) { this.#options = options; }
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => undefined).then(work); this.#queue = next;
    return next;
  }
  async #draft(clientId: string, draftId?: string): Promise<ModelConfigurationDraft | undefined> {
    const snapshot = await this.#options.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT);
    return findDraftEntry(snapshot, clientId, draftId)?.draft;
  }
  async #clientDrafts(clientId: string): Promise<ModelConfigurationDraft[]> {
    const snapshot = await this.#options.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT);
    return draftsForClient(snapshot, clientId).map((entry) => entry.draft);
  }
  async #changed() { await this.#options.onChanged?.(); }
  #redact(text: string): string { return redactSensitiveText(this.#options.redact?.(text) ?? text); }
  #assertPublic(value: unknown): void {
    const text = JSON.stringify(value);
    if (this.#redact(text) !== text) fail(400, "model_catalog_contains_secret", "模型资料包含受保护内容，已拒绝保存；请检查服务返回的公开目录。");
  }
  #secret(draft: ModelConfigurationDraft): string | undefined {
    const saved = this.#secrets.get(draft.id);
    return saved?.draftId === draft.id && draft.provider.baseUrl && saved.origin === new URL(draft.provider.baseUrl).origin ? saved.value : undefined;
  }
  async #public(draft: ModelConfigurationDraft, allProviders?: ProviderCatalogItem[]): Promise<ModelConfigurationDraft> {
    const list = allProviders ?? await this.#options.providers();
    const existing = list.find((item) => item.id === draft.provider.id);
    const sameOrigin = Boolean(existing?.baseUrl && draft.provider.baseUrl && new URL(existing.baseUrl).origin === new URL(draft.provider.baseUrl).origin);
    return clone({ ...draft, hasCredential: Boolean(this.#secret(draft) || existing?.authenticated && sameOrigin) });
  }
  async workspace(clientId: string): Promise<ModelConfigurationWorkspace> {
    modelConfigurationIdentifier(clientId);
    const allProviders = await this.#options.providers();
    const providers = allProviders.filter((item) => !item.builtin && !item.isGateway && item.authType !== "oauth").map(({ id, name, authenticated, builtin, isGateway, authType, api, baseUrl }) => ({ id, name: this.#redact(name), authenticated, builtin, isGateway, authType, api, baseUrl: baseUrl ? this.#redact(baseUrl) : undefined }));
    this.#assertPublic(providers);
    const rawDrafts = await this.#clientDrafts(clientId);
    const drafts = await Promise.all(rawDrafts.map((item) => this.#public(item, allProviders)));
    const draft = drafts[0];
    return {
      providers,
      presets: MAINSTREAM_PROVIDER_PRESETS.map(({ id, name, api, baseUrl }) => ({ id, name, api, baseUrl })),
      ...(draft ? { draft } : {}),
      ...(drafts.length ? { drafts } : {}),
    };
  }
  async #store(draft: ModelConfigurationDraft, baseline?: DraftBaseline): Promise<ModelConfigurationDraft> {
    draft.hasCredential = false;
    this.#assertPublic(draft);
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(ModelConfigurationDoc);
      // Clean up any legacy clientId-keyed copy of the same draft ID so we never duplicate it.
      const legacyKey = Object.entries(doc.drafts).find(([key, entry]) => key !== draft.id && entry?.id === draft.id)?.[0];
      if (legacyKey) delete doc.drafts[legacyKey];
      if (Object.keys(doc.drafts).length >= 128 && !doc.drafts[draft.id]) fail(409, "model_configuration_limit", "模型草稿数量已达上限，请关闭其它草稿。");
      doc.drafts[draft.id] = clone(draft);
      if (baseline !== undefined) {
        doc.baselines ??= {};
        doc.baselines[draft.id] = clone(baseline);
      }
    }, BACKGROUND_CONTEXT);
    await this.#changed(); return this.#public(draft);
  }
  async prepare(input: ModelConfigurationPrepareRequest): Promise<ModelConfigurationDraft> {
    const clientId = modelConfigurationIdentifier(input.clientId);
    return this.#serial(async () => {
      const currentDrafts = await this.#clientDrafts(clientId);
      if (currentDrafts.length >= MAX_DRAFTS_PER_WINDOW) {
        fail(409, "model_configuration_limit", "当前窗口模型草稿数量已达上限，请先保存或取消部分草稿。");
      }
      if (input.providerId && currentDrafts.some((item) => item.provider.id === input.providerId)) {
        fail(409, "model_draft_exists", "此连接已有配置草稿，请继续编辑或取消当前草稿。");
      }
      const settings = this.#options.settings().blocks.model;
      const preset = input.preset ? MAINSTREAM_PROVIDER_PRESETS.find((item) => item.id === input.preset) : undefined;
      if (input.preset && !preset) fail(400, "unknown_model_provider_preset", "此供应商预设不存在，请提供公开接口地址和协议。");
      const existing = input.providerId ? settings.value.customProviders?.find((item) => item.id === input.providerId) : undefined;
      if (input.providerId && !existing) fail(400, "model_provider_not_custom", "请选择已有自定义 API 供应商；订阅登录使用原有授权流程。");
      const provider: CustomProviderConfig = existing ? clone(existing) : { id: `api-${randomUUID()}`, name: input.name?.trim() || preset?.name || "自定义供应商", api: input.api ?? preset?.api ?? "openai-completions", baseUrl: input.baseUrl?.trim() ?? preset?.baseUrl ?? "", models: [], ...(preset ? { preset: preset.id } : {}) };
      if (input.api) provider.api = input.api;
      if (input.baseUrl !== undefined) provider.baseUrl = input.baseUrl.trim();
      if (input.name !== undefined) provider.name = input.name.trim();
      validateConfigurationProvider(provider, true);
      if (provider.baseUrl) provider.baseUrl = endpoint(provider.baseUrl, provider.api);
      const draft: ModelConfigurationDraft = { id: `model-draft-${randomUUID()}`, clientId, revision: 1, settingsRevision: settings.revision, provider, existingProvider: Boolean(existing), selectedModelIds: provider.models.map((model) => model.id), ...(settings.value.defaultProvider === provider.id && provider.models.some((model) => model.id === settings.value.defaultModel) ? { defaultModelId: settings.value.defaultModel } : {}), candidates: provider.models.map((model) => ({ model, evidence: "configured" })), verifications: [], hasCredential: false, updatedAt: Date.now() };
      const baseline: DraftBaseline = {
        provider: existing ? clone(existing) : null,
        ...(settings.value.defaultProvider !== undefined ? { defaultProvider: settings.value.defaultProvider } : {}),
        ...(settings.value.defaultModel !== undefined ? { defaultModel: settings.value.defaultModel } : {}),
      };
      return this.#store(draft, baseline);
    });
  }
  async updateDraft(input: ModelConfigurationUpdateRequest): Promise<ModelConfigurationDraft> {
    const clientId = modelConfigurationIdentifier(input.clientId); validateConfigurationProvider(input.provider, true);
    if (!Array.isArray(input.selectedModelIds) || input.selectedModelIds.length > 256 || input.selectedModelIds.some((item) => typeof item !== "string") || new Set(input.selectedModelIds).size !== input.selectedModelIds.length) fail(400, "invalid_model_selection", "模型选择无效。");
    return this.#serial(async () => {
      const current = await this.#draft(clientId, input.draftId); assertRevision(current, input.expectedRevision);
      if (current.provider.id !== input.provider.id) fail(400, "model_provider_identity_changed", "不能更换草稿所属供应商。");
      const provider = clone(input.provider); if (provider.baseUrl) provider.baseUrl = endpoint(provider.baseUrl, provider.api);
      if (input.selectedModelIds.some((id) => !provider.models.some((item) => item.id === id))) fail(400, "invalid_model_selection", "所选模型不在草稿中。");
      if (input.defaultModelId && !input.selectedModelIds.includes(input.defaultModelId)) fail(400, "invalid_default_model", "默认模型必须包含在所选模型中。");
      if (input.defaultModelId) {
        const defaultEntry = provider.models.find((item) => item.id === input.defaultModelId);
        if (defaultEntry && !isConversationModel(defaultEntry)) fail(400, "invalid_default_model", "默认对话模型只能选择 Chat 类型模型。");
      }
      const endpointChanged = current.provider.api !== provider.api || current.provider.baseUrl !== provider.baseUrl;
      if (current.provider.baseUrl && (!provider.baseUrl || new URL(current.provider.baseUrl).origin !== new URL(provider.baseUrl).origin)) this.#secrets.delete(current.id);
      const modelChanged = JSON.stringify(current.provider.models) !== JSON.stringify(provider.models);
      const candidates: ModelConfigurationCandidate[] = provider.models.map((model) => { const previous = current.candidates.find((entry) => entry.model.id === model.id); return { model, evidence: endpointChanged || JSON.stringify(model) !== JSON.stringify(previous?.model) ? "manual" : previous?.evidence ?? "manual", ...(!endpointChanged && previous?.catalogModel ? { catalogModel: previous.catalogModel } : {}) }; });
      return this.#store({ ...current, provider, selectedModelIds: [...input.selectedModelIds], defaultModelId: input.defaultModelId || undefined, candidates, verifications: endpointChanged || modelChanged ? [] : current.verifications, revision: current.revision + 1, updatedAt: Date.now() });
    });
  }
  async supplyCredential(input: { clientId: string; draftId?: string; expectedRevision: number; apiKey: string }): Promise<ModelConfigurationDraft> {
    const clientId = modelConfigurationIdentifier(input.clientId);
    if (typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 16_384 || /[\x00-\x20\x7f]/.test(input.apiKey.trim())) fail(400, "invalid_model_credential", "请输入有效的 API Key。");
    return this.#serial(async () => {
      const current = await this.#draft(clientId, input.draftId); assertRevision(current, input.expectedRevision);
      endpoint(current.provider.baseUrl, current.provider.api);
      this.#options.rememberSecrets?.([input.apiKey.trim()]);
      this.#secrets.set(current.id, { draftId: current.id, revision: current.revision + 1, origin: new URL(current.provider.baseUrl).origin, value: input.apiKey.trim() });
      return this.#store({ ...current, revision: current.revision + 1, verifications: [], updatedAt: Date.now() });
    });
  }
  #safeError(cause: unknown, secret?: string): string {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "模型操作失败，请重试。";
    return this.#redact(secret ? message.split(secret).join("[已隐藏]") : message).slice(0, 1000);
  }
  async discover(clientId: string, expectedRevision: number, draftId?: string): Promise<ModelConfigurationDraft> {
    modelConfigurationIdentifier(clientId);
    return this.#serial(async () => {
      const current = await this.#draft(clientId, draftId); assertRevision(current, expectedRevision);
      const baseUrl = endpoint(current.provider.baseUrl, current.provider.api);
      const secret = this.#secret(current);
      let response: DiscoverModelsResponse;
      try { response = await this.#options.discover({ ...(current.existingProvider ? { providerId: current.provider.id } : {}), api: current.provider.api, baseUrl, ...(secret ? { apiKey: secret } : {}), ...(current.provider.preset ? { preset: current.provider.preset } : {}), vertexProject: current.provider.vertexProject, vertexLocation: current.provider.vertexLocation, refreshMetadata: true }); }
      catch (cause) { return fail(400, "model_discovery_failed", this.#safeError(cause, secret)); }
      if (!response.ok) fail(400, "model_discovery_failed", this.#safeError(response.error || "未能读取供应商模型目录。", secret));
      const candidates = new Map(current.candidates.map((entry) => [entry.model.id, entry]));
      for (const item of response.models.slice(0, 256)) {
        this.#assertPublic(item);
        const isChat = isConversationModel(item);
        const model: CustomModelConfig = isChat
          ? { id: item.id, name: item.name, contextWindow: item.contextWindow, maxTokens: Math.min(item.maxTokens, item.contextWindow), reasoning: item.reasoning, ...(item.thinkingEnabled !== undefined ? { thinkingEnabled: item.thinkingEnabled } : {}), modalities: [...item.modalities], vision: item.modalities.includes("image"), ...(item.thinkingLevelMap ? { thinkingLevelMap: item.thinkingLevelMap } : {}), ...(item.thinkingLevels ? { thinkingLevels: item.thinkingLevels } : {}), ...(item.nativeTools ? { nativeTools: { ...item.nativeTools } } : {}) }
          : { id: item.id, name: item.name, purpose: item.purpose, ...(item.protocolAdapter ? { protocolAdapter: item.protocolAdapter } : {}), ...(item.voices?.length ? { voices: [...item.voices] } : {}), ...(item.imageProfile ? { imageProfile: clone(item.imageProfile) } : {}), ...(item.imageDefaults ? { imageDefaults: clone(item.imageDefaults) } : {}) };
        validateConfigurationModel(model, current.provider.api);
        const configured = current.provider.models.find((entry) => entry.id === item.id);
        candidates.set(item.id, { model: configured ?? model, catalogModel: model, evidence: configured ? current.candidates.find((entry) => entry.model.id === item.id)?.evidence ?? "configured" : "catalog" });
      }
      const entries = [...candidates.values()].slice(0, 256);
      return this.#store({ ...current, candidates: entries, provider: { ...current.provider, models: entries.map((entry) => entry.model) }, revision: current.revision + 1, updatedAt: Date.now() });
    });
  }
  async #receipt<T extends ConfigurationState["receipts"][string]["result"]>(key: string, fingerprint: string): Promise<T | undefined> {
    const previous = (await this.#options.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))?.receipts[key];
    if (previous && previous.fingerprint !== fingerprint) fail(409, "model_configuration_command_conflict", "此操作标识已用于另一份配置。");
    return previous ? clone(previous.result) as T : undefined;
  }
  async #remember(key: string, fingerprint: string, result: ConfigurationState["receipts"][string]["result"], cleanup?: ModelConfigurationCleanup) {
    await this.#options.harness.commit(async (tx) => { const doc = await tx.doc(ModelConfigurationDoc); doc.receipts[key] = { fingerprint, result: clone(result), ...(cleanup ? { cleanup } : {}) }; if (doc.commits) delete doc.commits[key]; while (Object.keys(doc.receipts).length > 256) delete doc.receipts[Object.keys(doc.receipts)[0]!]; }, BACKGROUND_CONTEXT);
  }
  async #finishSavedDraft(cleanup: ModelConfigurationCleanup): Promise<void> {
    const matches = (draft: ModelConfigurationDraft | undefined) => draft?.id === cleanup.draftId && draft.revision === cleanup.draftRevision && draft.provider.id === cleanup.providerId;
    const current = await this.#draft(cleanup.clientId, cleanup.draftId);
    if (matches(current)) {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ModelConfigurationDoc);
        const found = findDraftEntry(doc, cleanup.clientId, cleanup.draftId);
        if (found && matches(found.draft)) {
          delete doc.drafts[found.key];
          if (doc.baselines) delete doc.baselines[cleanup.draftId];
        }
      }, BACKGROUND_CONTEXT);
    }
    const staged = this.#secrets.get(cleanup.draftId);
    // A user can provide a newer key for the same draft after an uncertain save.
    if (staged?.draftId === cleanup.draftId && staged.revision <= cleanup.draftRevision) this.#secrets.delete(cleanup.draftId);
    await this.#changed();
  }
  async test(input: { clientId: string; draftId?: string; expectedRevision: number; modelId: string; commandId: string }, signal?: AbortSignal): Promise<{ draft: ModelConfigurationDraft; verification: ModelConfigurationVerification }> {
    const clientId = modelConfigurationIdentifier(input.clientId); modelConfigurationIdentifier(input.commandId); publicText(input.modelId, "模型 ID");
    return this.#serial(async () => {
      const key = `test:${hash([clientId, input.commandId])}`; const fingerprint = hash(input);
      const repeated = await this.#receipt<{ draft: ModelConfigurationDraft; verification: ModelConfigurationVerification }>(key, fingerprint); if (repeated) return repeated;
      const current = await this.#draft(clientId, input.draftId); assertRevision(current, input.expectedRevision);
      if (!current.selectedModelIds.includes(input.modelId)) fail(400, "model_not_selected", "请先选择需要测试的模型。");
      const baseUrl = endpoint(current.provider.baseUrl, current.provider.api); const secret = this.#secret(current);
      if (!secret && (!current.existingProvider || !(await this.#public(current)).hasCredential)) fail(400, "model_test_credential_required", "请先通过保密输入提供此连接的 API Key，再执行文本测试。");
      const startedAt = Date.now(); let verification: ModelConfigurationVerification;
      try {
        const result = await this.#options.probe({ ...(current.existingProvider ? { providerId: current.provider.id } : {}), api: current.provider.api, apiMode: current.provider.api, baseUrl, model: input.modelId, ...(secret ? { apiKey: secret } : {}), vertexProject: current.provider.vertexProject, vertexLocation: current.provider.vertexLocation }, signal);
        verification = { modelId: input.modelId, kind: "text-call", ok: result.ok, checkedAt: Date.now(), latencyMs: result.latencyMs, ...(!result.ok ? { error: this.#safeError(result.error || result.title || "文本调用未通过。", secret) } : {}) };
      } catch (cause) { if (signal?.aborted) throw cause; verification = { modelId: input.modelId, kind: "text-call", ok: false, checkedAt: Date.now(), latencyMs: Date.now() - startedAt, error: this.#safeError(cause, secret) }; }
      const draft = await this.#store({ ...current, revision: current.revision + 1, verifications: [...current.verifications.filter((item) => item.modelId !== input.modelId), verification], updatedAt: Date.now() });
      const result = { draft, verification }; await this.#remember(key, fingerprint, { draft: { ...draft, hasCredential: false }, verification }); return result;
    });
  }
  async save(input: { clientId: string; draftId?: string; expectedRevision: number; commandId: string }): Promise<ModelConfigurationSaveResult> {
    const clientId = modelConfigurationIdentifier(input.clientId); modelConfigurationIdentifier(input.commandId);
    return this.#serial(async () => {
      const key = `save:${hash([clientId, input.commandId])}`; const fingerprint = hash(input);
      const repeated = await this.#receipt<ModelConfigurationSaveResult>(key, fingerprint);
      if (repeated) { const cleanup = (await this.#options.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))?.receipts[key]?.cleanup; if (cleanup) await this.#finishSavedDraft(cleanup); return repeated; }
      const snapshot = await this.#options.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT);
      const remembered = snapshot?.commits?.[key];
      if (remembered && remembered.fingerprint !== fingerprint) fail(409, "model_configuration_command_conflict", "此操作标识已用于另一份配置。");
      const current = findDraftEntry(snapshot, clientId, input.draftId)?.draft;
      let effectiveSettingsRevision = current?.settingsRevision ?? 0;
      if (!remembered) {
        assertRevision(current, input.expectedRevision);
        validateConfigurationProvider(current.provider);
        if (!current.selectedModelIds.length) fail(400, "empty_model_selection", "请至少选择一个模型。");
        const liveSettings = this.#options.settings().blocks.model;
        if (liveSettings.revision !== current.settingsRevision) {
          const baseline = snapshot?.baselines?.[current.id];
          const liveProvider = liveSettings.value.customProviders?.find((item) => item.id === current.provider.id) ?? null;
          const providerUnchanged = Boolean(baseline) && same(liveProvider, baseline!.provider);
          const defaultUnchanged = !current.defaultModelId || (
            baseline !== undefined &&
            liveSettings.value.defaultProvider === baseline.defaultProvider &&
            liveSettings.value.defaultModel === baseline.defaultModel
          );
          if (!providerUnchanged || !defaultUnchanged) {
            fail(409, "model_settings_changed", "模型设置已被其他操作修改，请重新创建草稿。");
          }
          // Safe to rebase onto the latest revision because this target provider and default selection did not change.
          effectiveSettingsRevision = liveSettings.revision;
        }
      }
      const liveModel = this.#options.settings().blocks.model.value;
      const provider = remembered?.provider ?? { ...clone(current!.provider), models: current!.provider.models.filter((model) => current!.selectedModelIds.includes(model.id)) };
      const autoDefaultModelId = !remembered && !current!.defaultModelId && !liveModel.defaultModel.trim()
        ? provider.models.find((model) => isConversationModel(model))?.id
        : undefined;
      const effectiveDefaultModelId = remembered?.defaultModelId ?? current!.defaultModelId ?? autoDefaultModelId;
      const commit: ModelConfigurationCommit = remembered ?? { fingerprint, clientId, draftId: current!.id, draftRevision: current!.revision, provider, ...(effectiveDefaultModelId ? { defaultModelId: effectiveDefaultModelId } : {}), verifications: clone(current!.verifications) };
      const secret = !remembered && current ? this.#secret(current) : undefined;
      let settings: MocoSettingsView;
      try { settings = await this.#options.saveProvider({ provider, expectedSettingsRevision: effectiveSettingsRevision, defaultModelId: commit.defaultModelId, operationKey: key, fingerprint, commit, ...(secret ? { apiKey: secret } : {}) }); }
      catch (cause) {
        const committed = (await this.#options.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))?.commits?.[key];
        return fail(400, committed ? "model_configuration_save_failed" : "model_configuration_not_saved", this.#safeError(cause, secret));
      }
      const result: ModelConfigurationSaveResult = { providerId: provider.id, modelIds: provider.models.map((model) => model.id), defaultModelId: commit.defaultModelId, settings, verifications: clone(commit.verifications) };
      const cleanup: ModelConfigurationCleanup = { clientId, draftId: commit.draftId, draftRevision: commit.draftRevision, providerId: provider.id };
      await this.#remember(key, fingerprint, result, cleanup);
      await this.#finishSavedDraft(cleanup); return clone(result);
    });
  }
  async discard(clientId: string, expectedRevision: number, draftId?: string): Promise<void> {
    modelConfigurationIdentifier(clientId);
    await this.#serial(async () => {
      const current = await this.#draft(clientId, draftId); assertRevision(current, expectedRevision);
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ModelConfigurationDoc);
        const found = findDraftEntry(doc, clientId, current.id);
        if (found) delete doc.drafts[found.key];
        if (doc.baselines) delete doc.baselines[current.id];
      }, BACKGROUND_CONTEXT);
      this.#secrets.delete(current.id);
      await this.#changed();
    });
  }
}
