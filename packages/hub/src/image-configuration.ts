import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import {
  redactSensitiveText, validateCustomImageAdapter, validateImageModelProfile,
  type DiscoverModelsRequest, type DiscoverModelsResponse, type ImageCapabilityConfiguration,
  type ImageCapabilityDraft, type ImageConfigurationWorkspace, type ImageDraftSaveResult,
  type ImageDraftUpdateRequest, type ImageModelCandidate, type ImageModelDiscovery,
  type ImageModelImportResult, type ImageProviderConnection, type ProviderCatalogItem,
} from "@moco/protocol";
import { CapabilityError, type MocoCapabilities } from "./capabilities.js";
import { discoverImageProviderAdapters } from "./image-provider-adapters.js";

interface ImageConfigurationState {
  draftSequence?: number;
  drafts: Record<string, ImageCapabilityDraft>;
  discoveries: Record<string, ImageModelDiscovery>;
  receipts: Record<string, { fingerprint: string; result: ImageDraftSaveResult | ImageModelImportResult }>;
}

export const ImageConfigurationDoc = defineDoc<ImageConfigurationState & JsonObject>({
  kind: "moco.image-configuration", version: 1, scope: "session",
  initial: () => ({ draftSequence: 0, drafts: {}, discoveries: {}, receipts: {} }) as ImageConfigurationState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

interface ImageConfigurationOptions {
  harness: Harness;
  capabilities: MocoCapabilities;
  providers: () => Promise<ProviderCatalogItem[]>;
  discover: (request: DiscoverModelsRequest) => Promise<DiscoverModelsResponse>;
  onChanged: () => void | Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CONFIG_FIELDS = new Set(["id", "expectedRevision", "name", "adapter", "baseUrl", "modelId", "credentialProviderId", "enabled", "isDefault", "allowTaskGeneration", "maxOutputs", "imageProfile", "defaults", "routing", "customAdapter"]);
const SECRET_FIELDS = new Set(["apikey", "authorization", "cookie", "password", "secret", "accesstoken", "refreshtoken", "token"]);

export function imageSetupIdentifier(value: unknown, label = "配置标识"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) {
    throw new CapabilityError(400, "invalid_image_setup", `${label}无效。`);
  }
  return value;
}

function assertRevision(current: ImageCapabilityDraft | undefined, expected: unknown): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 0)) throw new CapabilityError(400, "invalid_image_draft_revision", "草稿版本无效。");
  if (current ? expected !== current.revision : expected !== undefined && expected !== 0) {
    throw new CapabilityError(409, "image_draft_conflict", "图像配置草稿已更新，请载入最新草稿后继续。");
  }
}

/** Drafts may contain incomplete fields, but never credentials or executable objects. */
export function validateImageDraft(config: unknown): asserts config is ImageCapabilityConfiguration {
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !CONFIG_FIELDS.has(key))) {
    throw new CapabilityError(400, "invalid_image_draft", "图像草稿字段无效；密钥请通过保密输入填写。");
  }
  const value = config as Record<string, unknown>;
  if (!["openai-image", "gemini-image", "custom-image"].includes(String(value.adapter)) || typeof value.name !== "string" || value.name.length > 100 || typeof value.modelId !== "string" || value.modelId.length > 200) {
    throw new CapabilityError(400, "invalid_image_draft", "图像草稿的接口、名称或模型无效。");
  }
  if (JSON.stringify(config).length > 48_000) throw new CapabilityError(400, "image_draft_too_large", "图像配置草稿过大。");
  for (const key of ["id", "baseUrl", "modelId", "name"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || String(value[key]).length > 2048)) throw new CapabilityError(400, "invalid_image_draft", "图像草稿文本字段无效。");
  if (typeof value.baseUrl === "string") {
    let endpoint: URL | undefined;
    try { endpoint = new URL(value.baseUrl); } catch { /* An incomplete address is retained while typing. */ }
    if (endpoint && (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)) throw new CapabilityError(400, "image_draft_contains_secret", "接口地址不能包含凭据、查询参数或片段。");
  }
  if (value.credentialProviderId !== undefined && value.credentialProviderId !== null && typeof value.credentialProviderId !== "string") throw new CapabilityError(400, "invalid_image_draft", "图像连接引用无效。");
  for (const key of ["enabled", "isDefault", "allowTaskGeneration"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new CapabilityError(400, "invalid_image_draft", "图像草稿开关无效。");
  for (const key of ["expectedRevision", "maxOutputs"] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new CapabilityError(400, "invalid_image_draft", "图像草稿数值无效。");
  if (value.defaults !== undefined && (!value.defaults || typeof value.defaults !== "object" || Array.isArray(value.defaults))) throw new CapabilityError(400, "invalid_image_draft", "默认图像参数需要对象。");
  if (value.defaults) {
    const defaults = value.defaults as Record<string, unknown>;
    const strings = ["format", "aspectRatio", "size", "quality", "background", "complexity", "thinkingLevel", "svgModel", "svgReasoning"];
    const numbers = ["count", "outputCompression", "frameCount", "frameDurationMs"];
    if (strings.some((key) => defaults[key] !== undefined && typeof defaults[key] !== "string") || numbers.some((key) => defaults[key] !== undefined && (typeof defaults[key] !== "number" || !Number.isFinite(defaults[key]))) || defaults.grounding !== undefined && typeof defaults.grounding !== "boolean" || defaults.custom !== undefined && (!defaults.custom || typeof defaults.custom !== "object" || Array.isArray(defaults.custom))) throw new CapabilityError(400, "invalid_image_draft", "默认图像参数的字段类型无效。");
  }
  if (value.routing !== undefined) {
    const routing = value.routing as Record<string, unknown>;
    if (!routing || typeof routing !== "object" || Array.isArray(routing) || routing.instructions !== undefined && typeof routing.instructions !== "string" || routing.useCases !== undefined && (!Array.isArray(routing.useCases) || routing.useCases.some((item) => typeof item !== "string")) || routing.priority !== undefined && (typeof routing.priority !== "number" || !Number.isFinite(routing.priority))) throw new CapabilityError(400, "invalid_image_draft", "图像调用偏好结构无效。");
  }
  try {
    if (value.imageProfile !== undefined) validateImageModelProfile(value.imageProfile as Parameters<typeof validateImageModelProfile>[0]);
    if (value.customAdapter !== undefined) validateCustomImageAdapter(value.customAdapter as Parameters<typeof validateCustomImageAdapter>[0]);
  } catch { throw new CapabilityError(400, "invalid_image_draft", "图像能力或自定义接口声明无效，请检查字段结构。"); }
  const inspect = (node: unknown, depth: number): void => {
    if (depth > 14) throw new CapabilityError(400, "invalid_image_draft", "图像配置嵌套过深。");
    if (typeof node === "number" && !Number.isFinite(node)) throw new CapabilityError(400, "invalid_image_draft", "图像配置包含无效数字。");
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || SECRET_FIELDS.has(key.replace(/[-_\s]/g, "").toLowerCase())) {
        throw new CapabilityError(400, "image_draft_contains_secret", "配置不接收密钥、Cookie 或授权头；请使用保密输入。");
      }
      inspect(item, depth + 1);
    }
  };
  inspect(config, 0);
}

function effectiveImageProvider(provider: ProviderCatalogItem): ProviderCatalogItem {
  const protocols = ["openai-completions", "openai-responses", "google-generative-ai"] as const;
  const api = provider.api ?? [...provider.models, ...(provider.configuredModels ?? [])].map((model) => model.api)
    .find((value): value is typeof protocols[number] => protocols.some((protocol) => protocol === value));
  return { ...provider, ...(api ? { api } : {}), ...(provider.baseUrl ? { baseUrl: provider.baseUrl.replace(/\/+$/, "") } : {}) };
}

function providerConnection(raw: ProviderCatalogItem): ImageProviderConnection {
  const provider = effectiveImageProvider(raw);
  const supportedProtocol = ["openai-completions", "openai-responses", "google-generative-ai"].includes(provider.api ?? "");
  const imageSupported = provider.authenticated && provider.authType === "api_key" && !!provider.baseUrl && supportedProtocol;
  return {
    id: provider.id, name: provider.name, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.api ? { api: provider.api } : {}), ...(provider.authType ? { authType: provider.authType } : {}),
    authenticated: provider.authenticated, imageSupported,
    ...(!imageSupported ? { reason: provider.authType === "oauth" ? "此订阅授权暂未提供可用的图像接口" : !provider.authenticated ? "请先连接此供应商" : !provider.baseUrl ? "此连接尚未提供图像接口地址" : "请通过自定义图像接口接入此协议" } : {}),
  };
}

export class MocoImageConfiguration {
  #options: ImageConfigurationOptions;
  #queues = new Map<string, Promise<unknown>>();

  constructor(options: ImageConfigurationOptions) { this.#options = options; }

  async #serial<T>(clientId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(clientId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#queues.set(clientId, next);
    try { return await next; }
    finally { if (this.#queues.get(clientId) === next) this.#queues.delete(clientId); }
  }

  async workspace(clientId?: string): Promise<ImageConfigurationWorkspace> {
    const providers = (await this.#options.providers()).map(effectiveImageProvider).filter((provider) => !provider.builtin || provider.authenticated || provider.isGateway).map(providerConnection);
    if (!clientId) return { providers };
    imageSetupIdentifier(clientId, "窗口标识");
    const state = await this.#options.harness.snapshot(ImageConfigurationDoc, BACKGROUND_CONTEXT);
    const draft = state?.drafts[clientId];
    const discovery = state?.discoveries[clientId] ? clone(state.discoveries[clientId]) : undefined;
    if (discovery) {
      const snapshot = await this.#options.capabilities.snapshot();
      for (const candidate of discovery.candidates) candidate.alreadyAdded = snapshot.capabilities.some((capability) => capability.kind === "image" && capability.modelId === candidate.modelId && snapshot.connections.some((connection) => connection.id === capability.connectionId && connection.credentialProviderId === candidate.providerId && connection.baseUrl === candidate.baseUrl));
    }
    return clone({ providers, ...(draft ? { draft } : {}), ...(discovery ? { discovery } : {}) });
  }

  async updateDraft(input: ImageDraftUpdateRequest): Promise<ImageCapabilityDraft> {
    const clientId = imageSetupIdentifier(input.clientId, "窗口标识");
    validateImageDraft(input.config);
    return this.#serial(clientId, async () => {
      let result!: ImageCapabilityDraft;
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ImageConfigurationDoc);
        const current = doc.drafts[clientId];
        assertRevision(current, input.expectedRevision);
        if (Object.keys(doc.drafts).length >= 128 && !current) throw new CapabilityError(409, "image_draft_limit", "图像草稿数量已达上限，请先关闭其它配置草稿。");
        const revision = Math.max(doc.draftSequence ?? 0, ...Object.values(doc.drafts).map((draft) => draft.revision)) + 1;
        if (!Number.isSafeInteger(revision)) throw new CapabilityError(409, "image_draft_revision_limit", "草稿版本已达上限。");
        doc.draftSequence = revision;
        result = { id: current?.id ?? `image-draft-${randomUUID()}`, clientId, revision, config: clone(input.config), updatedAt: Date.now() };
        doc.drafts[clientId] = result;
      }, BACKGROUND_CONTEXT);
      await this.#options.onChanged();
      return clone(result);
    });
  }

  async discardDraft(clientId: string, expectedRevision?: number): Promise<void> {
    imageSetupIdentifier(clientId, "窗口标识");
    await this.#serial(clientId, async () => {
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ImageConfigurationDoc);
        if (!doc.drafts[clientId]) return;
        assertRevision(doc.drafts[clientId], expectedRevision);
        delete doc.drafts[clientId];
      }, BACKGROUND_CONTEXT);
      await this.#options.onChanged();
    });
  }

  async #receipt<T extends ImageDraftSaveResult | ImageModelImportResult>(key: string, hash: string): Promise<T | undefined> {
    const receipt = (await this.#options.harness.snapshot(ImageConfigurationDoc, BACKGROUND_CONTEXT))?.receipts[key];
    if (receipt && receipt.fingerprint !== hash) throw new CapabilityError(409, "image_setup_command_conflict", "此操作标识已用于另一份配置。");
    return receipt ? clone(receipt.result) as T : undefined;
  }

  async #remember(key: string, hash: string, result: ImageDraftSaveResult | ImageModelImportResult): Promise<void> {
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(ImageConfigurationDoc);
      doc.receipts[key] = { fingerprint: hash, result: clone(result) };
      while (Object.keys(doc.receipts).length > 256) delete doc.receipts[Object.keys(doc.receipts)[0]!];
    }, BACKGROUND_CONTEXT);
  }

  async saveDraft(input: { clientId: string; expectedRevision: number; commandId: string }): Promise<ImageDraftSaveResult> {
    const clientId = imageSetupIdentifier(input.clientId, "窗口标识");
    imageSetupIdentifier(input.commandId, "操作标识");
    return this.#serial(clientId, async () => {
      const key = `save:${fingerprint([clientId, input.commandId])}`;
      const hash = fingerprint(input);
      const repeated = await this.#receipt<ImageDraftSaveResult>(key, hash);
      if (repeated) return repeated;
      const current = (await this.#options.harness.snapshot(ImageConfigurationDoc, BACKGROUND_CONTEXT))?.drafts[clientId];
      assertRevision(current, input.expectedRevision);
      if (!current) throw new CapabilityError(404, "image_draft_missing", "图像配置草稿不存在。");
      const capability = await this.#options.capabilities.configure({ ...current.config, commandId: key });
      const connection = await this.#options.capabilities.connection(capability.connectionId);
      const needsSecret = !connection.hasCredential && !(connection.adapter === "custom-image" && connection.customAdapter?.auth.type === "none");
      const result: ImageDraftSaveResult = { capability, ...(needsSecret ? { input: await this.#options.capabilities.requestInput(capability.id, "secret", clientId) } : {}) };
      await this.#remember(key, hash, result);
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ImageConfigurationDoc);
        if (doc.drafts[clientId]?.revision === current.revision) delete doc.drafts[clientId];
      }, BACKGROUND_CONTEXT);
      await this.#options.onChanged();
      return clone(result);
    });
  }

  async discover(clientId: string, providerIds?: string[]): Promise<ImageModelDiscovery> {
    imageSetupIdentifier(clientId, "窗口标识");
    if (providerIds !== undefined && (!Array.isArray(providerIds) || providerIds.length > 64 || providerIds.some((id) => typeof id !== "string"))) throw new CapabilityError(400, "invalid_image_provider_selection", "供应商选择无效。");
    return this.#serial(clientId, async () => {
      const providers = (await this.#options.providers()).map(effectiveImageProvider);
      const eligible = providers.filter((provider) => (!providerIds || providerIds.includes(provider.id)) && providerConnection(provider).imageSupported);
      if (providerIds?.some((id) => !eligible.some((provider) => provider.id === id))) throw new CapabilityError(400, "image_provider_unavailable", "所选供应商未提供可用的图像 API 连接。");
      const snapshot = await this.#options.capabilities.snapshot();
      const discovery: ImageModelDiscovery = { id: `image-discovery-${randomUUID()}`, clientId, status: "ready", candidates: [], errors: [], createdAt: Date.now() };
      for (let offset = 0; offset < eligible.length; offset += 4) {
        const batch = await Promise.all(eligible.slice(offset, offset + 4).map(async (provider) => {
          let models = [...provider.models, ...(provider.configuredModels ?? [])];
          let error: string | undefined;
          try {
            const response = await this.#options.discover({ providerId: provider.id, api: provider.api! });
            if (response.ok) models = [...response.models, ...models];
            else error = "无法读取实时模型目录，已保留供应商现有目录";
          } catch { error = "无法读取实时模型目录，已保留供应商现有目录"; }
          const adapted = await discoverImageProviderAdapters(provider, models);
          if (adapted.error) error = adapted.error;
          const candidates = new Map<string, ImageModelCandidate>();
          for (const entry of adapted.models) {
            const { model, adapter } = entry;
            const modelId = adapter === "gemini-image" ? model.id.replace(/^models\//, "") : model.id;
            if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(modelId)) continue;
            const id = `image-candidate-${fingerprint([provider.id, provider.baseUrl, modelId]).slice(0, 24)}`;
            candidates.set(id, { id, providerId: provider.id, providerName: redactSensitiveText(provider.name), baseUrl: provider.baseUrl!, adapter, modelId,
              name: redactSensitiveText(model.name || modelId), alreadyAdded: snapshot.capabilities.some((capability) => capability.kind === "image" && capability.modelId === modelId && snapshot.connections.some((connection) => connection.id === capability.connectionId && connection.credentialProviderId === provider.id && connection.baseUrl === provider.baseUrl)),
              imageProfile: entry.imageProfile, ...(entry.defaults ? { defaults: entry.defaults } : {}), ...(entry.customAdapter ? { customAdapter: entry.customAdapter } : {}),
              ...(entry.maxOutputs ? { maxOutputs: entry.maxOutputs } : {}), ...(entry.needsConfiguration ? { needsConfiguration: true, configurationReason: entry.configurationReason } : {}),
              evidence: provider.modelCatalogSource === "preset" ? "preset" : "catalog" });
          }
          return { candidates: [...candidates.values()], ...(error ? { error } : {}), provider };
        }));
        for (const entry of batch) {
          discovery.candidates.push(...entry.candidates);
          if (entry.error) discovery.errors.push({ providerId: entry.provider.id, providerName: redactSensitiveText(entry.provider.name), error: entry.error });
        }
      }
      if (discovery.candidates.length > 512) discovery.candidates.length = 512;
      discovery.status = discovery.errors.length ? "partial" : "ready";
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ImageConfigurationDoc);
        if (Object.keys(doc.discoveries).length >= 128 && !doc.discoveries[clientId]) delete doc.discoveries[Object.keys(doc.discoveries)[0]!];
        doc.discoveries[clientId] = clone(discovery);
      }, BACKGROUND_CONTEXT);
      await this.#options.onChanged();
      return discovery;
    });
  }

  async importModels(input: { clientId: string; discoveryId: string; candidateIds: string[]; commandId: string; allowTaskGeneration?: boolean }): Promise<ImageModelImportResult> {
    const clientId = imageSetupIdentifier(input.clientId, "窗口标识");
    imageSetupIdentifier(input.discoveryId);
    imageSetupIdentifier(input.commandId, "操作标识");
    if (input.allowTaskGeneration !== undefined && typeof input.allowTaskGeneration !== "boolean") throw new CapabilityError(400, "invalid_image_generation_permission", "图像调用许可无效。");
    if (!Array.isArray(input.candidateIds) || !input.candidateIds.length || input.candidateIds.length > 128 || new Set(input.candidateIds).size !== input.candidateIds.length || input.candidateIds.some((id) => typeof id !== "string")) throw new CapabilityError(400, "invalid_image_model_selection", "请选择需要添加的图像模型。");
    return this.#serial("__image-import__", async () => {
      const key = `import:${fingerprint([clientId, input.commandId])}`;
      const hash = fingerprint(input);
      const repeated = await this.#receipt<ImageModelImportResult>(key, hash);
      if (repeated) return repeated;
      const discovery = (await this.#options.harness.snapshot(ImageConfigurationDoc, BACKGROUND_CONTEXT))?.discoveries[clientId];
      if (!discovery || discovery.id !== input.discoveryId) throw new CapabilityError(409, "image_discovery_changed", "候选模型已更新，请重新选择。");
      if (input.candidateIds.some((id) => !discovery.candidates.some((candidate) => candidate.id === id))) throw new CapabilityError(400, "image_candidate_unavailable", "所选模型不在当前供应商目录中。");
      const providers = (await this.#options.providers()).map(effectiveImageProvider);
      const result: ImageModelImportResult = { added: [], errors: [] };
      for (const id of input.candidateIds) {
        const candidate = discovery.candidates.find((item) => item.id === id)!;
        try {
          if (candidate.needsConfiguration) throw new CapabilityError(409, "image_interface_configuration_required", candidate.configurationReason ?? "请先配置此模型的图像接口。");
          const provider = providers.find((item) => item.id === candidate.providerId);
          if (!provider || !providerConnection(provider).imageSupported || provider.baseUrl !== candidate.baseUrl) throw new CapabilityError(409, "image_provider_changed", "供应商连接已变化，请重新发现模型。");
          const snapshot = await this.#options.capabilities.snapshot();
          const existing = snapshot.capabilities.find((capability) => capability.kind === "image" && capability.modelId === candidate.modelId && snapshot.connections.some((connection) => connection.id === capability.connectionId && connection.credentialProviderId === candidate.providerId && connection.baseUrl === candidate.baseUrl));
          result.added.push(existing ?? await this.#options.capabilities.configure({ commandId: `${key}:${id.slice(-24)}`, name: candidate.name.slice(0, 100), adapter: candidate.adapter, modelId: candidate.modelId, baseUrl: candidate.baseUrl, credentialProviderId: candidate.providerId, imageProfile: candidate.imageProfile,
            defaults: candidate.defaults, customAdapter: candidate.customAdapter, ...(candidate.maxOutputs ? { maxOutputs: candidate.maxOutputs } : {}), allowTaskGeneration: input.allowTaskGeneration ?? true }));
        } catch (cause) {
          result.errors.push({ candidateId: id, error: cause instanceof CapabilityError ? cause.message : "此模型未能添加，请检查连接后重试。" });
        }
      }
      if (!result.errors.length) await this.#remember(key, hash, result);
      await this.#options.onChanged();
      return result;
    });
  }
}
