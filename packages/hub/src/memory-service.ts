import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  HindsightEmbeddingsModel, HindsightMemoryConfig, HindsightProbeResult, HindsightRerankerModel,
  HindsightServiceModel, MemoryServiceConnection, MemoryServiceJob,
  MemoryServicePrepareRequest, MemoryServiceSecretField, MemoryServiceSecretInput, MemoryServiceSnapshot, KuloSettingsView,
  MemoryConnectionUpdateRequest, MemoryConnectionUpdateResult,
} from "@kulo/protocol";
import { probeHindsightConnection, resolveHindsightToken, resolveHindsightSharedReadToken } from "./hindsight.js";
import { HindsightServiceError } from "./hindsight-service.js";
import { KuloSettingsDoc, SettingsUpdateError, applySettingsBlockUpdate, type KuloDurableSettings } from "./settings.js";

interface LocalStatus {
  installed: boolean; running: boolean; platform: string; deviceName: string; endpoint?: string;
  version?: string; model?: HindsightServiceModel; embeddings?: HindsightEmbeddingsModel; reranker?: HindsightRerankerModel;
  dataDirectory?: string; phase?: string;
}
interface LocalConnection {
  endpoint: string; routerApiKey: string; workerApiKey: string; banks: { private: string; shared: string };
}
export interface LocalMemoryExecutor {
  inspect(): Promise<LocalStatus>;
  deploy(input: {
    commandId: string;
    model: HindsightServiceModel;
    embeddings?: HindsightEmbeddingsModel;
    reranker?: HindsightRerankerModel;
    apiKey?: string;
    embeddingsApiKey?: string;
    rerankerApiKey?: string;
    onProgress?: (stage: string) => void | Promise<void>;
  }): Promise<LocalConnection>;
  configure(input: {
    commandId: string;
    model: HindsightServiceModel;
    embeddings?: HindsightEmbeddingsModel;
    reranker?: HindsightRerankerModel;
    apiKey?: string;
    embeddingsApiKey?: string;
    rerankerApiKey?: string;
    onProgress?: (stage: string) => void | Promise<void>;
  }): Promise<LocalConnection>;
  uninstall(input: { commandId: string; deleteData?: boolean; onProgress?: (stage: string) => void | Promise<void> }): Promise<LocalStatus>;
}
interface StoredJob {
  view: MemoryServiceJob;
  fingerprint: string;
  expectedRevision: number;
  credentialRefs: Partial<Record<MemoryServiceSecretField, string>>;
  /** Preserve connection ownership when uninstall removes the native manifest before replay. */
  uninstallEndpoint?: string | null;
  taskId?: number;
}
interface MemoryServiceState { jobs: Record<string, StoredJob>; inputs: Record<string, MemoryServiceSecretInput> }
export const MemoryServiceDoc = defineDoc<MemoryServiceState & JsonObject>({
  kind: "kulo.memory-service", version: 1, scope: "session",
  initial: () => ({ jobs: {}, inputs: {} }) as MemoryServiceState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class MemoryServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "MemoryServiceError"; }
}
const fail = (status: number, code: string, message: string): never => { throw new MemoryServiceError(status, code, message); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = <T>(value: Readonly<Record<string, T>> | undefined, key: string): T | undefined => value && Object.hasOwn(value, key) ? value[key] : undefined;
const ctx = BACKGROUND_CONTEXT;
const active = new Set(["awaiting-input", "awaiting-confirmation", "running"]);
const OPERATIONS = ["deploy", "configure", "connect", "disconnect", "uninstall", "check"] as const;
const SECRET_LABELS: Record<MemoryServiceSecretField, string> = {
  modelApiKey: "理解模型 API Key",
  embeddingsApiKey: "向量模型 API Key",
  rerankerApiKey: "重排模型 API Key",
  routerApiKey: "主脑记忆密钥",
  workerApiKey: "Worker 共享记忆密钥",
  sharedReadApiKey: "共享库只读密钥",
};
const DEFAULT_ORIGINS = {
  openai: "https://api.openai.com", anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com", ollama: "http://127.0.0.1:11434",
};
const EMBEDDINGS_DEFAULT_ORIGINS: Partial<Record<HindsightEmbeddingsModel["provider"], string>> = {
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  cohere: "https://api.cohere.com",
};
const RERANKER_DEFAULT_ORIGINS: Partial<Record<HindsightRerankerModel["provider"], string>> = {
  cohere: "https://api.cohere.com",
  siliconflow: "https://api.siliconflow.cn",
  alibaba: "https://dashscope.aliyuncs.com",
  zeroentropy: "https://api.zeroentropy.dev",
};
const SECRET_LIKE_KEYS = new Set(["apikey", "api_key", "secret", "token", "key", "password", "authorization"]);
function hasSecretKey(keys: string[]): boolean {
  return keys.some((key) => SECRET_LIKE_KEYS.has(key.toLowerCase()));
}
function identifier(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(raw)) fail(400, "invalid_memory_request", `${label}无效。`);
  return raw as string;
}
function endpoint(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) fail(400, "invalid_memory_endpoint", "请输入有效的服务地址。");
  let url: URL;
  try { url = new URL(raw as string); } catch { return fail(400, "invalid_memory_endpoint", "请输入有效的服务地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(400, "invalid_memory_endpoint", "服务地址不能包含凭据、查询参数或片段。");
  return url.toString().replace(/\/+$/, "");
}
function modelValue(raw: unknown): HindsightServiceModel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid_memory_model", "请先选择记忆理解模型。");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (hasSecretKey(keys)) {
    return fail(400, "invalid_memory_model", "模型配置不能包含密钥；密钥请使用保密输入。");
  }
  if (keys.some((key) => !["provider", "model", "baseUrl", "connectionId"].includes(key))) {
    return fail(400, "invalid_memory_model", "理解模型配置包含不支持的字段；仅支持 provider、model、baseUrl、connectionId。");
  }
  if (typeof value.provider !== "string" || (value.provider !== "kulo" && !Object.hasOwn(DEFAULT_ORIGINS, value.provider))) {
    return fail(400, "invalid_memory_model", "不支持的理解模型供应商；复用 Kulo 已配置模型请使用 provider: \"kulo\"，或选择 openai/anthropic/gemini/groq/ollama。");
  }
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 240 || /[\x00-\x1f\x7f]/.test(value.model)) {
    return fail(400, "invalid_memory_model", "请填写有效的记忆理解模型名称。");
  }
  if (value.provider === "kulo") {
    if (!value.connectionId) return fail(400, "invalid_memory_model", "使用 Kulo 已配置模型时必须提供 connectionId。");
    return { provider: "kulo", model: value.model.trim(), connectionId: identifier(value.connectionId, "模型连接") };
  }
  return { provider: value.provider as HindsightServiceModel["provider"], model: value.model.trim(),
    ...(value.baseUrl ? { baseUrl: endpoint(value.baseUrl) } : {}),
    ...(value.connectionId ? { connectionId: identifier(value.connectionId, "模型连接") } : {}) };
}
function embeddingsValue(raw: unknown): HindsightEmbeddingsModel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid_memory_embeddings", "向量模型（Embedding）配置无效。");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (hasSecretKey(keys)) return fail(400, "invalid_memory_embeddings", "向量模型配置不能包含密钥；密钥请使用保密输入。");
  if (keys.some((key) => !["provider", "model", "baseUrl", "connectionId", "dimensions"].includes(key))) {
    return fail(400, "invalid_memory_embeddings", "向量模型配置包含不支持的字段。");
  }
  if (typeof value.provider !== "string" || !["onnx", "openai", "google", "cohere", "tei"].includes(value.provider)) {
    return fail(400, "invalid_memory_embeddings", "不支持的向量模型供应商；支持 onnx、openai、google、cohere、tei。");
  }
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 240 || /[\x00-\x1f\x7f]/.test(value.model))) {
    return fail(400, "invalid_memory_embeddings", "向量模型名称无效。");
  }
  if (value.dimensions !== undefined && (typeof value.dimensions !== "number" || !Number.isSafeInteger(value.dimensions) || value.dimensions < 32 || value.dimensions > 8192)) {
    return fail(400, "invalid_memory_embeddings", "向量维度必须为 32 到 8192 之间的整数。");
  }
  const baseUrl = value.baseUrl ? endpoint(value.baseUrl) : undefined;
  if (value.provider === "tei" && !baseUrl) return fail(400, "invalid_memory_embeddings", "TEI 向量服务必须填写服务地址。");
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  return {
    provider: value.provider as HindsightEmbeddingsModel["provider"],
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(value.connectionId ? { connectionId: identifier(value.connectionId, "向量模型连接") } : {}),
    ...(value.dimensions !== undefined ? { dimensions: value.dimensions } : {}),
  };
}
function rerankerValue(raw: unknown): HindsightRerankerModel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid_memory_reranker", "重排模型（Rerank）配置无效。");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (hasSecretKey(keys)) return fail(400, "invalid_memory_reranker", "重排模型配置不能包含密钥；密钥请使用保密输入。");
  if (keys.some((key) => !["provider", "model", "baseUrl", "connectionId"].includes(key))) {
    return fail(400, "invalid_memory_reranker", "重排模型配置包含不支持的字段。");
  }
  if (typeof value.provider !== "string" || !["onnx", "rrf", "cohere", "siliconflow", "alibaba", "zeroentropy", "tei"].includes(value.provider)) {
    return fail(400, "invalid_memory_reranker", "不支持的重排模型供应商；支持 onnx、rrf、cohere、siliconflow、alibaba、zeroentropy、tei。");
  }
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 240 || /[\x00-\x1f\x7f]/.test(value.model))) {
    return fail(400, "invalid_memory_reranker", "重排模型名称无效。");
  }
  const baseUrl = value.baseUrl ? endpoint(value.baseUrl) : undefined;
  if (value.provider === "tei" && !baseUrl) return fail(400, "invalid_memory_reranker", "TEI 重排服务必须填写服务地址。");
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  return {
    provider: value.provider as HindsightRerankerModel["provider"],
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(value.connectionId ? { connectionId: identifier(value.connectionId, "重排模型连接") } : {}),
  };
}
function connectionValue(raw: unknown): MemoryServiceConnection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid_memory_connection", "请输入记忆服务连接。");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["endpoint", "endpoints", "accessMode", "banks"].includes(key))) fail(400, "invalid_memory_connection", "连接中不能包含密钥。");
  if (!["kulo", "scoped", "private-only"].includes(String(value.accessMode))) fail(400, "invalid_memory_connection", "请选择接入方式。");
  const banks = value.banks as Record<string, unknown> | undefined;
  const privateBank = banks?.private ?? "kulo-core", shared = banks?.shared ?? "kulo-shared";
  if (typeof privateBank !== "string" || typeof shared !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(privateBank) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(shared) || privateBank.toLowerCase() === shared.toLowerCase()) fail(400, "invalid_memory_connection", "私有库与共享库名称必须有效且不同。");
  if (value.endpoints !== undefined && (!Array.isArray(value.endpoints) || value.endpoints.length > 8)) fail(400, "invalid_memory_connection", "备用地址最多 8 个。");
  return { endpoint: endpoint(value.endpoint), accessMode: value.accessMode as MemoryServiceConnection["accessMode"],
    endpoints: (value.endpoints as unknown[] | undefined)?.map(endpoint) ?? [], banks: { private: privateBank as string, shared: shared as string } };
}
function originForModel(model: HindsightServiceModel): string { return model.provider === "kulo" ? `kulo:${model.connectionId ?? ""}` : model.baseUrl ? new URL(model.baseUrl).origin : DEFAULT_ORIGINS[model.provider]; }
function originForEmbeddings(model: HindsightEmbeddingsModel): string {
  if (model.provider === "onnx") return "onnx";
  if (model.provider === "tei") return new URL(model.baseUrl!).origin;
  return model.baseUrl ? new URL(model.baseUrl).origin : EMBEDDINGS_DEFAULT_ORIGINS[model.provider]!;
}
function originForReranker(model: HindsightRerankerModel): string {
  if (model.provider === "onnx" || model.provider === "rrf") return model.provider;
  if (model.provider === "tei") return new URL(model.baseUrl!).origin;
  return model.baseUrl ? new URL(model.baseUrl).origin : RERANKER_DEFAULT_ORIGINS[model.provider]!;
}
function embeddingsNeedsApiKey(model: HindsightEmbeddingsModel): boolean {
  return model.provider === "openai" || model.provider === "google" || model.provider === "cohere";
}
function rerankerNeedsApiKey(model: HindsightRerankerModel): boolean {
  return model.provider === "cohere" || model.provider === "siliconflow" || model.provider === "alibaba" || model.provider === "zeroentropy";
}
function publicModel(model: HindsightServiceModel | undefined): HindsightServiceModel | undefined { return model ? modelValue(model) : undefined; }
function publicEmbeddings(model: HindsightEmbeddingsModel | undefined): HindsightEmbeddingsModel | undefined { return model ? embeddingsValue(model) : undefined; }
function publicReranker(model: HindsightRerankerModel | undefined): HindsightRerankerModel | undefined { return model ? rerankerValue(model) : undefined; }

function connectionUpdateValue(raw: MemoryConnectionUpdateRequest): MemoryConnectionUpdateRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["expectedRevision", "enabled", "connection", "routerApiKey", "workerApiKey", "sharedReadApiKey", "clearRouterApiKey", "clearWorkerApiKey", "clearSharedReadApiKey", "caCertPem"].includes(key)) ||
    !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1 || typeof raw.enabled !== "boolean") fail(400, "invalid_memory_request", "记忆连接设置无效。");
  for (const key of ["routerApiKey", "workerApiKey", "sharedReadApiKey", "caCertPem"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key]!.length > (key === "caCertPem" ? 131_072 : 8192))) fail(400, "invalid_memory_request", "记忆连接字段格式无效。");
  }
  for (const key of ["clearRouterApiKey", "clearWorkerApiKey", "clearSharedReadApiKey"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail(400, "invalid_memory_request", "清除凭据选项无效。");
  }
  const connection = raw.connection;
  if (!connection || typeof connection !== "object" || Array.isArray(connection) || Object.keys(connection).some((key) => !["endpoint", "endpoints", "accessMode", "banks"].includes(key)) ||
    typeof connection.endpoint !== "string" || connection.endpoint.length > 2048 || /[\x00-\x1f\x7f]/.test(connection.endpoint) ||
    typeof connection.accessMode !== "string" || !["kulo", "scoped", "private-only"].includes(connection.accessMode) ||
    connection.endpoints !== undefined && (!Array.isArray(connection.endpoints) || connection.endpoints.length > 8 || connection.endpoints.some((value) => typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)))) fail(400, "invalid_memory_connection", "记忆连接字段格式无效。");
  const banks = connection.banks;
  if (!banks || typeof banks !== "object" || Array.isArray(banks) || Object.keys(banks).some((key) => !["private", "shared"].includes(key)) || typeof banks.private !== "string" || typeof banks.shared !== "string") fail(400, "invalid_memory_connection", "请填写私有库与共享库名称。");
  return { ...clone(raw), connection: { ...clone(connection), endpoint: connection.endpoint.trim() ? endpoint(connection.endpoint.trim()) : "",
    ...(connection.endpoints === undefined ? {} : { endpoints: connection.endpoints.map((value) => endpoint(value.trim())) }) } };
}

export interface MemoryServiceOptions {
  harness: Harness;
  operationTask: ReturnType<typeof createMemoryServiceTask>;
  local: LocalMemoryExecutor;
  credentials: CredentialStore;
  settings: () => KuloSettingsView;
  memory: () => HindsightMemoryConfig;
  applied: (settings: KuloDurableSettings) => Promise<void>;
  validateMemory?: (memory: HindsightMemoryConfig) => void;
  validateKuloModel?: (connectionId: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  resolveModelCredential?: (model: HindsightServiceModel) => Promise<string | undefined>;
  resolveServiceCredential?: (connectionId: string, modelId: string, baseUrl: string) => Promise<string | undefined>;
  probe?: typeof probeHindsightConnection;
  now?: () => number;
}

export class KuloMemoryService {
  readonly #options: MemoryServiceOptions;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(options: MemoryServiceOptions) { this.#options = options; }
  #now() { return this.#options.now?.() ?? Date.now(); }
  #serial<T>(run: () => Promise<T>): Promise<T> { const pending = this.#queue.then(run); this.#queue = pending.catch(() => {}); return pending; }
  async #stored(id: string): Promise<StoredJob> {
    const value = own((await this.#options.harness.snapshot(MemoryServiceDoc, ctx))?.jobs, id);
    return value ? clone(value) : fail(404, "memory_job_not_found", "记忆配置操作不存在。");
  }
  async snapshot(clientId?: string): Promise<MemoryServiceSnapshot> {
    if (clientId) identifier(clientId, "客户端");
    const [local, doc] = await Promise.all([this.#options.local.inspect(), this.#options.harness.snapshot(MemoryServiceDoc, ctx)]);
    const settings = this.#options.settings();
    return { revision: settings.blocks.memory.revision, deviceName: local.deviceName, platform: local.platform,
      installed: local.installed, running: local.running, ...(local.endpoint ? { endpoint: local.endpoint } : {}),
      ...(local.version ? { version: local.version } : {}),
      ...(local.model ? { model: publicModel(local.model) } : {}),
      ...(local.embeddings ? { embeddings: publicEmbeddings(local.embeddings) } : {}),
      ...(local.reranker ? { reranker: publicReranker(local.reranker) } : {}),
      ...(local.dataDirectory ? { dataDirectory: local.dataDirectory } : {}), ...(local.phase ? { phase: local.phase } : {}),
      connection: clone(settings.blocks.memory.value),
      jobs: clientId ? Object.values(doc?.jobs ?? {}).filter((job) => job.view.clientId === clientId).map((job) => clone(job.view)).sort((a,b) => a.createdAt-b.createdAt).slice(-30) : [],
      inputs: clientId ? Object.values(doc?.inputs ?? {}).filter((input) => input.clientId === clientId).map((input) => ({ ...clone(input), status: input.status === "pending" && input.expiresAt <= this.#now() ? "expired" : input.status })).slice(-40) : [],
    };
  }
  async updateConnection(raw: MemoryConnectionUpdateRequest, probeOnly = false): Promise<MemoryConnectionUpdateResult> {
    if (typeof probeOnly !== "boolean") fail(400, "invalid_memory_request", "连接检查选项无效。");
    const request = connectionUpdateValue(raw);
    try {
      return await this.#serial(async () => {
        const [state, current] = await Promise.all([this.#options.harness.snapshot(MemoryServiceDoc, ctx), this.#options.harness.snapshot(KuloSettingsDoc, ctx)]);
        if (Object.values(state?.jobs ?? {}).some((job) => job.view.status === "running")) fail(409, "memory_service_busy", "记忆服务正在处理配置，请稍后重试。");
        if (!current || current.revisions.memory !== request.expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已更新，请刷新后重试。");
        const copy = clone(current) as KuloDurableSettings;
        // Leave saved keys on the owning Settings document, so its origin checks decide reuse.
        const { routerApiKey: _router, workerApiKey: _worker, sharedReadApiKey: _sharedRead, ...previous } = copy.memory;
        const payload = { ...previous, ...request.connection, endpoints: request.connection.endpoints ?? previous.endpoints,
          enabled: request.enabled, ...(request.caCertPem === undefined ? {} : { caCertPem: request.caCertPem }),
          ...(request.routerApiKey === undefined ? {} : { routerApiKey: request.routerApiKey }),
          ...(request.workerApiKey === undefined ? {} : { workerApiKey: request.workerApiKey }),
          ...(request.sharedReadApiKey === undefined ? {} : { sharedReadApiKey: request.sharedReadApiKey }),
          ...(request.clearRouterApiKey === undefined ? {} : { clearRouterApiKey: request.clearRouterApiKey }),
          ...(request.clearWorkerApiKey === undefined ? {} : { clearWorkerApiKey: request.clearWorkerApiKey }),
          ...(request.clearSharedReadApiKey === undefined ? {} : { clearSharedReadApiKey: request.clearSharedReadApiKey }),
          ...(request.connection.accessMode === "private-only" ? { clearWorkerApiKey: true, clearSharedReadApiKey: true } : request.connection.accessMode === "kulo" ? { clearSharedReadApiKey: true } : {}),
        };
        applySettingsBlockUpdate(copy, "memory", request.expectedRevision, payload);
        const candidate = copy.memory;
        const checking = probeOnly ? { ...candidate, enabled: true } : candidate;
        this.#options.validateMemory?.(checking);
        let probe: HindsightProbeResult | undefined;
        if (probeOnly || request.enabled) {
          try { probe = await (this.#options.probe ?? probeHindsightConnection)(checking); }
          catch { return fail(409, "memory_probe_failed", "连接检查未完成，原设置已保留。"); }
          if (!probe.healthy) fail(409, "memory_probe_failed", "连接未通过检查，原设置已保留。");
        }
        if (!probeOnly) {
          const saved = await this.#options.harness.commit(async (tx) => {
            const settings = await tx.doc(KuloSettingsDoc);
            applySettingsBlockUpdate(settings, "memory", request.expectedRevision, payload);
            this.#options.validateMemory?.(settings.memory);
            return clone(settings) as KuloDurableSettings;
          }, ctx);
          await this.#options.applied(saved);
        }
        return { settings: clone(this.#options.settings()), service: await this.snapshot(), ...(probe ? { probe } : {}) };
      });
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      if (error instanceof SettingsUpdateError) throw new MemoryServiceError(error.status, error.status === 409 ? "memory_revision_conflict" : "invalid_memory_connection", error.message);
      return fail(500, "memory_connection_failed", "连接配置未完成，请刷新后重试。");
    }
  }
  async setEnabled(enabled: boolean, expectedRevision: number): Promise<MemoryServiceSnapshot> {
    if (typeof enabled !== "boolean" || !Number.isSafeInteger(expectedRevision)) fail(400, "invalid_memory_request", "启用设置无效。");
    await this.#serial(async () => {
      const state = await this.#options.harness.snapshot(MemoryServiceDoc, ctx);
      if (Object.values(state?.jobs ?? {}).some((job) => job.view.status === "running")) fail(409, "memory_service_busy", "记忆服务正在处理配置，请稍后重试。");
      if (this.#options.settings().blocks.memory.revision !== expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已更新，请刷新后重试。");
      const candidate = { ...this.#options.memory(), enabled };
      this.#options.validateMemory?.(candidate);
      if (enabled) {
        const result = await (this.#options.probe ?? probeHindsightConnection)(candidate);
        if (!result.healthy) fail(409, "memory_probe_failed", "连接未通过检查，未启用长期记忆。");
      }
      const saved = await this.#options.harness.commit(async (tx) => {
        const settings = await tx.doc(KuloSettingsDoc);
        applySettingsBlockUpdate(settings, "memory", expectedRevision, candidate);
        return clone(settings) as KuloDurableSettings;
      }, ctx);
      await this.#options.applied(saved);
    });
    return this.snapshot();
  }
  async setKnowledgeGuidanceEnabled(enabled: boolean, expectedRevision: number): Promise<MemoryServiceSnapshot> {
    if (typeof enabled !== "boolean" || !Number.isSafeInteger(expectedRevision)) fail(400, "invalid_memory_request", "知识整理指引设置无效。");
    await this.#serial(async () => {
      const state = await this.#options.harness.snapshot(MemoryServiceDoc, ctx);
      if (Object.values(state?.jobs ?? {}).some((job) => job.view.status === "running")) fail(409, "memory_service_busy", "记忆服务正在处理配置，请稍后重试。");
      if (this.#options.settings().blocks.memory.revision !== expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已更新，请刷新后重试。");
      const current = this.#options.memory();
      const candidate = { ...current, knowledgeGuidanceEnabled: enabled };
      this.#options.validateMemory?.(candidate);
      const saved = await this.#options.harness.commit(async (tx) => {
        const settings = await tx.doc(KuloSettingsDoc);
        applySettingsBlockUpdate(settings, "memory", expectedRevision, candidate);
        return clone(settings) as KuloDurableSettings;
      }, ctx);
      await this.#options.applied(saved);
    });
    return this.snapshot();
  }
  async prepare(raw: MemoryServicePrepareRequest): Promise<MemoryServiceSnapshot> {
    if (!raw || typeof raw !== "object" || Object.keys(raw).some((key) => !["commandId", "clientId", "expectedRevision", "operation", "model", "embeddings", "reranker", "connection", "deleteData"].includes(key))) fail(400, "invalid_memory_request", "配置请求无效，凭据请使用保密输入。");
    const id = identifier(raw.commandId, "操作标识"), clientId = identifier(raw.clientId, "客户端");
    if (!OPERATIONS.includes(raw.operation) || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1 || raw.deleteData !== undefined && typeof raw.deleteData !== "boolean") fail(400, "invalid_memory_request", "配置请求无效。");
    const normalized = {
      operation: raw.operation,
      clientId,
      expectedRevision: raw.expectedRevision,
      ...(raw.model ? { model: modelValue(raw.model) } : {}),
      ...(raw.embeddings ? { embeddings: embeddingsValue(raw.embeddings) } : {}),
      ...(raw.reranker ? { reranker: rerankerValue(raw.reranker) } : {}),
      ...(raw.connection ? { connection: connectionValue(raw.connection) } : {}),
      ...(raw.deleteData === undefined ? {} : { deleteData: raw.deleteData }),
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    await this.#serial(async () => {
      const state = await this.#options.harness.snapshot(MemoryServiceDoc, ctx);
      const prior = own(state?.jobs, id);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.view.clientId !== clientId) fail(409, "memory_command_conflict", "操作标识已经用于其他配置。");
        return;
      }
      if (this.#options.settings().blocks.memory.revision !== raw.expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已更新，请刷新后重试。");
      if (Object.values(state?.jobs ?? {}).some((job) => job.view.status === "running")) fail(409, "memory_service_busy", "记忆服务正在处理另一项操作。");
      const local = await this.#options.local.inspect();
      if (["configure", "uninstall"].includes(raw.operation) && !local.installed) fail(409, "memory_not_managed", "未发现由 Kulo 管理的本机安装。");
      const model = normalized.model ?? (raw.operation === "configure" ? publicModel(local.model) : undefined);
      const embeddings = normalized.embeddings ?? (raw.operation === "configure" ? publicEmbeddings(local.embeddings) : undefined);
      const reranker = normalized.reranker ?? (raw.operation === "configure" ? publicReranker(local.reranker) : undefined);
      if (["deploy", "configure"].includes(raw.operation) && !model) fail(400, "invalid_memory_model", "请先选择记忆理解模型。");
      if (raw.operation === "connect" && !normalized.connection) fail(400, "invalid_memory_connection", "请输入记忆服务连接。");
      const required: MemoryServiceSecretField[] = [];
      if (model) {
        if (model.provider === "kulo") {
          const check = await this.#options.validateKuloModel?.(model.connectionId!, model.model);
          if (check && !check.ok) fail(409, "memory_model_unavailable", check.error || "所选 Kulo 模型连接尚未就绪或未登录，请先在「模型」设置完成配置。");
        } else if (model.provider !== "ollama") {
          const reused = model.connectionId ? await this.#options.resolveModelCredential?.(model) : undefined;
          const managedKeyReusable = raw.operation === "configure" && local.model && local.model.provider === model.provider && originForModel(local.model) === originForModel(model);
          if (!reused && !managedKeyReusable) required.push("modelApiKey");
        }
      }
      if (embeddings && embeddingsNeedsApiKey(embeddings)) {
        const reused = embeddings.connectionId
          ? await this.#options.resolveServiceCredential?.(embeddings.connectionId, embeddings.model ?? "", embeddings.baseUrl ?? EMBEDDINGS_DEFAULT_ORIGINS[embeddings.provider]!)
          : undefined;
        const managedKeyReusable = raw.operation === "configure" && local.embeddings && local.embeddings.provider === embeddings.provider && originForEmbeddings(local.embeddings) === originForEmbeddings(embeddings);
        if (!reused && !managedKeyReusable) required.push("embeddingsApiKey");
      }
      if (reranker && rerankerNeedsApiKey(reranker)) {
        const reused = reranker.connectionId
          ? await this.#options.resolveServiceCredential?.(reranker.connectionId, reranker.model ?? "", reranker.baseUrl ?? RERANKER_DEFAULT_ORIGINS[reranker.provider]!)
          : undefined;
        const managedKeyReusable = raw.operation === "configure" && local.reranker && local.reranker.provider === reranker.provider && originForReranker(local.reranker) === originForReranker(reranker);
        if (!reused && !managedKeyReusable) required.push("rerankerApiKey");
      }
      if (normalized.connection) {
        const fields: MemoryServiceSecretField[] = normalized.connection.accessMode === "private-only" ? ["routerApiKey"] : normalized.connection.accessMode === "scoped" ? ["routerApiKey", "workerApiKey", "sharedReadApiKey"] : ["routerApiKey", "workerApiKey"];
        for (const field of fields) if (!this.#existingSecret(field, normalized.connection)) required.push(field);
      }
      const title = { deploy: "在本机部署 Hindsight", configure: "配置本机 Hindsight", connect: "连接 Hindsight 服务", disconnect: "断开记忆连接", uninstall: "卸载本机 Hindsight", check: "检测记忆连接" }[raw.operation];
      const modelLine = model
        ? model.provider === "kulo"
          ? `理解模型：${model.connectionId} / ${model.model}`
          : `理解模型：${model.provider} / ${model.model}`
        : undefined;
      const embeddingsLine = embeddings ? `向量模型：${embeddings.provider}${embeddings.model ? ` / ${embeddings.model}` : ""}` : undefined;
      const rerankerLine = reranker ? `重排模型：${reranker.provider === "rrf" ? "关闭重排（RRF）" : `${reranker.provider}${reranker.model ? ` / ${reranker.model}` : ""}`}` : undefined;
      const changes = [local.deviceName,
        ...(modelLine ? [modelLine, model!.provider === "ollama" ? "本机存储与本地模型" : "本机存储 · 记忆材料发送至所选模型服务"] : []),
        ...(embeddingsLine ? [embeddingsLine] : []),
        ...(rerankerLine ? [rerankerLine] : []),
        ...(normalized.connection ? [normalized.connection.endpoint, normalized.connection.accessMode === "private-only" ? "仅主脑私有记忆，Worker 共享记忆关闭" : "验证主脑与 Worker 权限后启用"] : []),
        ...(raw.operation === "deploy" ? ["安装服务、准备检索模型并设置自动启动", "小样本验证后保存并启用"] : []),
        ...(raw.operation === "uninstall" ? [raw.deleteData ? "同时删除此安装的记忆数据" : "保留记忆数据"] : [])];
      const now = this.#now();
      const view: MemoryServiceJob = { id, clientId, operation: raw.operation, status: required.length ? "awaiting-input" : "awaiting-confirmation", stage: required.length ? "等待保密输入" : "等待确认", title, changes, deviceName: local.deviceName, createdAt: now, updatedAt: now,
        ...(model ? { model } : {}),
        ...(embeddings ? { embeddings } : {}),
        ...(reranker ? { reranker } : {}),
        ...(normalized.connection ? { connection: normalized.connection } : {}),
        ...(raw.deleteData === undefined ? {} : { deleteData: raw.deleteData }) };
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MemoryServiceDoc);
        doc.jobs[id] = { view, fingerprint, expectedRevision: raw.expectedRevision, credentialRefs: {} };
        for (const field of required) {
          const inputId = `memory-input-${randomUUID()}`;
          doc.inputs[inputId] = { id: inputId, jobId: id, clientId, field, label: SECRET_LABELS[field], status: "pending", expiresAt: now + 15 * 60_000 };
        }
      }, ctx);
    });
    if (raw.operation === "check") await this.decide(id, clientId, "confirm");
    return this.snapshot(clientId);
  }
  #existingSecret(field: MemoryServiceSecretField, connection: MemoryServiceConnection): string | undefined {
    const current = this.#options.memory();
    const wanted = [connection.endpoint, ...(connection.endpoints ?? [])].map((url) => new URL(url).origin).sort();
    const actual = [current.endpoint, ...current.endpoints].map((url) => new URL(url).origin).sort();
    if (JSON.stringify(wanted) !== JSON.stringify(actual)) return undefined;
    return field === "routerApiKey" ? resolveHindsightToken(current, "router") : field === "workerApiKey" ? resolveHindsightToken(current, "worker") : field === "sharedReadApiKey" ? resolveHindsightSharedReadToken(current) : undefined;
  }
  async submitInput(idRaw: string, clientRaw: string, values: { secret?: string; cancel?: boolean }): Promise<MemoryServiceSnapshot> {
    const id = identifier(idRaw, "输入请求"), clientId = identifier(clientRaw, "客户端");
    if (!values || Object.keys(values).some((key) => !["secret", "cancel"].includes(key)) || values.cancel !== undefined && typeof values.cancel !== "boolean") fail(400, "invalid_memory_input", "保密输入无效。");
    let cancelledJob: StoredJob | undefined;
    await this.#serial(async () => {
      const doc = await this.#options.harness.snapshot(MemoryServiceDoc, ctx);
      const input = own(doc?.inputs, id);
      if (!input || input.clientId !== clientId) fail(403, "memory_input_forbidden", "无法使用此保密输入。");
      const request = input!;
      if (request.status === "completed") return;
      if (request.status !== "pending" || request.expiresAt <= this.#now()) fail(409, "memory_input_expired", "保密输入已过期，请重新发起配置。");
      const job = await this.#stored(request.jobId);
      if (job.view.status !== "awaiting-input" || job.expectedRevision !== this.#options.settings().blocks.memory.revision) fail(409, "memory_input_stale", "配置已更新，请重新发起保密输入。");
      if (values.cancel) {
        cancelledJob = job;
        await this.#options.harness.commit(async (tx) => {
          const state = await tx.doc(MemoryServiceDoc);
          state.jobs[request.jobId]!.view.status = "rejected";
          state.jobs[request.jobId]!.view.stage = "已取消";
          for (const value of Object.values(state.inputs)) if (value.jobId === request.jobId && value.status === "pending") value.status = "cancelled";
        }, ctx);
        return;
      }
      if (typeof values.secret !== "string" || !values.secret.trim() || values.secret.length > 8192 || /[\x00-\x20\x7f]/.test(values.secret.trim())) fail(400, "invalid_memory_secret", "请输入有效的密钥。");
      const secret = values.secret!.trim();
      const isModelSecret = request.field === "modelApiKey" || request.field === "embeddingsApiKey" || request.field === "rerankerApiKey";
      if (!isModelSecret && secret.length < 32) fail(400, "invalid_memory_secret", "记忆密钥至少 32 位。");
      const origin = request.field === "modelApiKey"
        ? originForModel(job.view.model!)
        : request.field === "embeddingsApiKey"
          ? originForEmbeddings(job.view.embeddings!)
          : request.field === "rerankerApiKey"
            ? originForReranker(job.view.reranker!)
            : new URL(job.view.connection!.endpoint).origin;
      const ref = `memory-service:${job.view.id}:${request.field}`;
      await this.#options.credentials.modify(ref, async () => ({ type: "api_key", key: secret, env: { KULO_MEMORY_ORIGIN: origin } }));
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(MemoryServiceDoc);
        state.jobs[request.jobId]!.credentialRefs[request.field] = ref;
        state.inputs[id]!.status = "completed";
        const stillPending = Object.values(state.inputs).some((value) => value.jobId === request.jobId && value.status === "pending");
        if (!stillPending) { state.jobs[request.jobId]!.view.status = "awaiting-confirmation"; state.jobs[request.jobId]!.view.stage = "等待确认"; }
      }, ctx);
    });
    if (cancelledJob) await this.#cleanup(cancelledJob);
    return this.snapshot(clientId);
  }
  async decide(idRaw: string, clientRaw: string, decision: "confirm" | "reject"): Promise<MemoryServiceSnapshot> {
    const id = identifier(idRaw, "操作标识"), clientId = identifier(clientRaw, "客户端");
    if (!["confirm", "reject"].includes(decision)) fail(400, "invalid_memory_decision", "操作决定无效。");
    let rejectedJob: StoredJob | undefined;
    await this.#serial(async () => {
      const current = await this.#stored(id);
      if (current.view.clientId !== clientId) fail(403, "memory_job_forbidden", "请在发起操作的窗口确认。");
      if (["running", "succeeded", "rejected"].includes(current.view.status)) return;
      if (decision === "confirm" && current.view.status !== "awaiting-confirmation" && current.view.status !== "failed") fail(409, "memory_not_confirmable", "请先完成配置输入。");
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(MemoryServiceDoc), job = state.jobs[id]!;
        if (decision === "reject") {
          job.view.status = "rejected"; job.view.stage = "已取消";
          for (const input of Object.values(state.inputs)) if (input.jobId === id && input.status === "pending") input.status = "cancelled";
          return;
        }
        const settings = await tx.doc(KuloSettingsDoc);
        if (settings.revisions.memory !== job.expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已更新，请重新准备配置。");
        if (Object.values(state.jobs).some((other) => other.view.id !== id && other.view.status === "running")) fail(409, "memory_service_busy", "记忆服务正在处理另一项操作。");
        job.view.status = "running"; job.view.stage = "准备执行"; job.view.updatedAt = this.#now();
        delete job.view.error;
        job.taskId = Number(await tx.createTask(this.#options.operationTask, { jobId: id }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }));
      }, ctx);
      if (decision === "reject") rejectedJob = current;
    });
    if (rejectedJob) await this.#cleanup(rejectedJob);
    this.#options.harness.resume();
    return this.snapshot(clientId);
  }
  async #secret(job: StoredJob, field: MemoryServiceSecretField): Promise<string | undefined> {
    const ref = job.credentialRefs[field];
    if (ref) {
      const credential = await this.#options.credentials.read(ref);
      const origin = field === "modelApiKey"
        ? originForModel(job.view.model!)
        : field === "embeddingsApiKey"
          ? originForEmbeddings(job.view.embeddings!)
          : field === "rerankerApiKey"
            ? originForReranker(job.view.reranker!)
            : new URL(job.view.connection!.endpoint).origin;
      if (credential?.type !== "api_key" || credential.env?.KULO_MEMORY_ORIGIN !== origin) fail(409, "memory_credential_stale", "凭据与当前服务不匹配，请重新配置。");
      return credential?.type === "api_key" ? credential.key : undefined;
    }
    if (field === "modelApiKey") return job.view.model && job.view.model.provider !== "kulo" && job.view.model.connectionId ? this.#options.resolveModelCredential?.(job.view.model) : undefined;
    if (field === "embeddingsApiKey") {
      const emb = job.view.embeddings;
      return emb && embeddingsNeedsApiKey(emb) && emb.connectionId
        ? this.#options.resolveServiceCredential?.(emb.connectionId, emb.model ?? "", emb.baseUrl ?? EMBEDDINGS_DEFAULT_ORIGINS[emb.provider]!)
        : undefined;
    }
    if (field === "rerankerApiKey") {
      const rr = job.view.reranker;
      return rr && rerankerNeedsApiKey(rr) && rr.connectionId
        ? this.#options.resolveServiceCredential?.(rr.connectionId, rr.model ?? "", rr.baseUrl ?? RERANKER_DEFAULT_ORIGINS[rr.provider]!)
        : undefined;
    }
    return job.view.connection ? this.#existingSecret(field, job.view.connection) : undefined;
  }
  async #stage(id: string, stage: string): Promise<void> {
    await this.#options.harness.commit(async (tx) => {
      const job = (await tx.doc(MemoryServiceDoc)).jobs[id]!;
      job.view.stage = stage.slice(0, 200); job.view.updatedAt = this.#now();
    }, ctx);
  }
  async #finish(job: StoredJob, config?: HindsightMemoryConfig, probe?: MemoryServiceJob["probe"]): Promise<void> {
    if (config) this.#options.validateMemory?.(config);
    const saved = await this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(MemoryServiceDoc), current = state.jobs[job.view.id]!;
      if (current.view.status === "succeeded") return undefined;
      const settings = await tx.doc(KuloSettingsDoc);
      if (config) applySettingsBlockUpdate(settings, "memory", current.expectedRevision, { ...config,
        ...(config.routerApiKeyDisabled ? { clearRouterApiKey: true } : {}),
        ...(config.workerApiKeyDisabled ? { clearWorkerApiKey: true } : {}),
        ...(config.sharedReadApiKeyDisabled ? { clearSharedReadApiKey: true } : {}) });
      current.view.status = "succeeded"; current.view.stage = "已完成"; current.view.updatedAt = this.#now();
      if (probe) current.view.probe = clone(probe);
      return config ? clone(settings) as KuloDurableSettings : undefined;
    }, ctx);
    if (saved) await this.#options.applied(saved);
    await this.#cleanup(job);
  }
  async #cleanup(job: StoredJob): Promise<void> {
    for (const ref of Object.values(job.credentialRefs)) if (ref) await this.#options.credentials.delete(ref);
  }
  /** The Pi task may replay this after a crash; the executor and settings commit share stable operation identities. */
  async execute(id: string): Promise<void> {
    const job = await this.#stored(id);
    if (job.view.status !== "running") return;
    try {
      const settings = await this.#options.harness.snapshot(KuloSettingsDoc, ctx);
      if (settings?.revisions.memory !== job.expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已变化，未切换连接。");
      const onProgress = (stage: string) => this.#stage(id, stage);
      const probe = this.#options.probe ?? probeHindsightConnection;
      if (job.view.operation === "check") {
        await this.#stage(id, "检测连接与权限");
        const result = await probe({ ...this.#options.memory(), enabled: true });
        if (!result.healthy) fail(409, "memory_probe_failed", result.endpoints.find((value) => value.detail)?.detail ?? "记忆连接未通过检查。");
        await this.#finish(job, undefined, result); return;
      }
      if (job.view.operation === "disconnect") {
        const config = { ...this.#options.memory(), enabled: false, routerApiKeyDisabled: true, workerApiKeyDisabled: true, sharedReadApiKeyDisabled: true };
        delete config.routerApiKey; delete config.workerApiKey; delete config.sharedReadApiKey;
        await this.#finish(job, config); return;
      }
      if (job.view.operation === "uninstall") {
        const local = job.uninstallEndpoint === undefined ? await this.#options.local.inspect() : undefined;
        const removal = await this.#options.harness.commit(async (tx) => {
          const settings = await tx.doc(KuloSettingsDoc), current = (await tx.doc(MemoryServiceDoc)).jobs[id]!;
          if (settings.revisions.memory !== current.expectedRevision) fail(409, "memory_revision_conflict", "记忆设置已变化，未切换连接。");
          if (current.uninstallEndpoint === undefined) current.uninstallEndpoint = local?.endpoint === settings.memory.endpoint ? settings.memory.endpoint : null;
          const affectsConnection = current.uninstallEndpoint === settings.memory.endpoint;
          const paused = affectsConnection && settings.memory.enabled;
          if (paused) applySettingsBlockUpdate(settings, "memory", current.expectedRevision, { ...settings.memory, enabled: false });
          current.expectedRevision = settings.revisions.memory;
          return { affectsConnection, paused, settings: clone(settings) as KuloDurableSettings };
        }, ctx);
        if (removal.paused) await this.#options.applied(removal.settings);
        await this.#options.local.uninstall({ commandId: id, deleteData: job.view.deleteData, onProgress });
        const disconnected = removal.affectsConnection ? { ...this.#options.memory(), enabled: false,
          routerApiKeyDisabled: true, workerApiKeyDisabled: true, sharedReadApiKeyDisabled: true } : undefined;
        if (disconnected) { delete disconnected.routerApiKey; delete disconnected.workerApiKey; delete disconnected.sharedReadApiKey; }
        await this.#finish(job, disconnected); return;
      }
      let candidate: HindsightMemoryConfig;
      if (job.view.operation === "connect") {
        const connection = job.view.connection!;
        candidate = { enabled: true, endpoint: connection.endpoint, endpoints: connection.endpoints ?? [], accessMode: connection.accessMode,
          banks: connection.banks, caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", sharedReadApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: true,
          routerApiKey: await this.#secret(job, "routerApiKey"),
          ...(connection.accessMode !== "private-only" ? { workerApiKey: await this.#secret(job, "workerApiKey") } : { workerApiKeyDisabled: true }),
          ...(connection.accessMode === "scoped" ? { sharedReadApiKey: await this.#secret(job, "sharedReadApiKey") } : { sharedReadApiKeyDisabled: true }) };
      } else {
        const input = {
          commandId: id,
          model: job.view.model!,
          ...(job.view.embeddings ? { embeddings: job.view.embeddings } : {}),
          ...(job.view.reranker ? { reranker: job.view.reranker } : {}),
          apiKey: await this.#secret(job, "modelApiKey"),
          embeddingsApiKey: await this.#secret(job, "embeddingsApiKey"),
          rerankerApiKey: await this.#secret(job, "rerankerApiKey"),
          onProgress,
        };
        const local = job.view.operation === "deploy" ? await this.#options.local.deploy(input) : await this.#options.local.configure(input);
        candidate = { enabled: true, endpoint: local.endpoint, endpoints: [], accessMode: "kulo", banks: local.banks, caCertPem: "", routerApiKey: local.routerApiKey, workerApiKey: local.workerApiKey,
          routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: true, sharedReadApiKeyDisabled: true };
      }
      await this.#stage(id, "验证连接与权限");
      this.#options.validateMemory?.(candidate);
      const checked = await probe(candidate);
      if (!checked.healthy) fail(409, "memory_probe_failed", checked.endpoints.find((value) => value.detail)?.detail ?? "连接或权限验证失败，原设置已保留。");
      await this.#finish(job, candidate, checked);
    } catch (error) {
      await this.#options.harness.commit(async (tx) => {
        const value = (await tx.doc(MemoryServiceDoc)).jobs[id]!;
        if (value.view.status === "succeeded") return;
        value.view.status = "failed"; value.view.stage = "未完成"; value.view.updatedAt = this.#now();
        value.view.error = error instanceof MemoryServiceError || error instanceof HindsightServiceError ? error.message : "服务操作未完成，请检查本机服务后重试。";
      }, ctx);
    }
  }
}

function createMemoryServiceTask(get: () => KuloMemoryService) { return defineTask<{ jobId: string }, { phase: "run" }, null>({
  name: "kulo.memory-service-operation", version: 1, initial: () => ({ phase: "run" }),
  phases: { run: async (task, runtime, context) => {
    await get().execute(task.input.jobId);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
  } },
  abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
}); }
export function createMemoryServiceExtension(get: () => KuloMemoryService) {
  const operationTask = createMemoryServiceTask(get);
  return Object.assign(defineExtension({ name: "kulo-memory-service", tasks: [operationTask] }), { operationTask });
}
