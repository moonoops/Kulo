import {
  isConversationModel,
  type HindsightEmbeddingsModel,
  type HindsightEmbeddingsProvider,
  type HindsightModelProvider,
  type HindsightRerankerModel,
  type HindsightRerankerProvider,
  type HindsightServiceModel,
  type KuloSettingsView,
  type ProviderCatalogItem,
} from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";

export const DEFAULT_ONNX_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";
export const DEFAULT_ONNX_EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_ONNX_RERANKER_MODEL = "hindsight-ai/hs-rerank-1";
export const CUSTOM_MODEL_OPTION = "__custom__";
export const SEPARATE_CONNECTION_OPTION = "__separate__";

export interface MemoryKuloConnectionOption {
  id: string;
  label: string;
  authType: "api_key" | "oauth";
  baseUrl?: string;
  api?: string;
  model: string;
  models: string[];
}

export interface MemoryModelsDraft {
  provider: HindsightModelProvider;
  connectionId: string;
  model: string;
  baseUrl: string;
  embeddingsProvider: HindsightEmbeddingsProvider;
  embeddingsConnectionId: string;
  embeddingsModel: string;
  embeddingsBaseUrl: string;
  embeddingsDimensions: string;
  rerankerProvider: HindsightRerankerProvider;
  rerankerConnectionId: string;
  rerankerModel: string;
  rerankerBaseUrl: string;
}

export const directModelProviders = (): Array<{ id: Exclude<HindsightModelProvider, "kulo">; label: string }> => ([
  { id: "openai", label: t("OpenAI 兼容 API", "OpenAI-compatible API") },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "groq", label: "Groq" },
  { id: "ollama", label: "Ollama" },
]);

export const embeddingsProviders = (): Array<{ id: HindsightEmbeddingsProvider; label: string }> => ([
  { id: "onnx", label: t("本机 ONNX", "Local ONNX") },
  { id: "openai", label: t("OpenAI 兼容 API", "OpenAI-compatible API") },
  { id: "google", label: "Google Gemini" },
  { id: "cohere", label: "Cohere" },
  { id: "tei", label: "TEI" },
]);

export const rerankerProviders = (): Array<{ id: HindsightRerankerProvider; label: string }> => ([
  { id: "onnx", label: t("本机 ONNX", "Local ONNX") },
  { id: "rrf", label: t("关闭重排（RRF）", "Disabled (RRF)") },
  { id: "cohere", label: t("Cohere 兼容 API", "Cohere-compatible API") },
  { id: "siliconflow", label: "SiliconFlow" },
  { id: "alibaba", label: t("阿里云 DashScope", "Alibaba DashScope") },
  { id: "zeroentropy", label: "ZeroEntropy" },
  { id: "tei", label: "TEI" },
]);

export const ONNX_EMBEDDING_PRESETS: Array<{ id: string; label: string; dimensions?: number }> = [
  { id: "intfloat/multilingual-e5-small", label: "multilingual-e5-small (384d)", dimensions: 384 },
  { id: "intfloat/multilingual-e5-base", label: "multilingual-e5-base (768d)", dimensions: 768 },
  { id: "Xenova/bge-small-zh-v1.5", label: "bge-small-zh-v1.5 (512d)", dimensions: 512 },
  { id: "BAAI/bge-m3", label: "bge-m3 (1024d)", dimensions: 1024 },
];

export const ONNX_RERANKER_PRESETS: Array<{ id: string; label: string }> = [
  { id: "hindsight-ai/hs-rerank-1", label: "hs-rerank-1" },
  { id: "onnx-community/bge-reranker-v2-m3-ONNX", label: "bge-reranker-v2-m3" },
  { id: "BAAI/bge-reranker-base", label: "bge-reranker-base" },
];

const ONNX_EMBEDDING_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "BAAI/bge-small-zh-v1.5": "Xenova/bge-small-zh-v1.5",
};

const ONNX_RERANKER_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "BAAI/bge-reranker-v2-m3": "onnx-community/bge-reranker-v2-m3-ONNX",
};

export function normalizeOnnxEmbeddingModelId(model: string): string {
  return ONNX_EMBEDDING_MODEL_ALIASES[model] ?? model;
}

export function normalizeOnnxRerankerModelId(model: string): string {
  return ONNX_RERANKER_MODEL_ALIASES[model] ?? model;
}

export function defaultEmbeddingsModelFor(provider: HindsightEmbeddingsProvider): string {
  switch (provider) {
    case "onnx": return DEFAULT_ONNX_EMBEDDING_MODEL;
    case "openai": return "text-embedding-3-small";
    case "google": return "gemini-embedding-001";
    case "cohere": return "embed-multilingual-v3.0";
    case "tei": return "";
  }
}

export function defaultRerankerModelFor(provider: HindsightRerankerProvider): string {
  switch (provider) {
    case "onnx": return DEFAULT_ONNX_RERANKER_MODEL;
    case "cohere": return "rerank-multilingual-v3.0";
    case "siliconflow": return "BAAI/bge-reranker-v2-m3";
    case "alibaba": return "qwen3-rerank";
    case "zeroentropy": return "zerank-2";
    case "rrf":
    case "tei": return "";
  }
}

export function embeddingsSupportsBaseUrl(provider: HindsightEmbeddingsProvider): boolean {
  return provider === "openai" || provider === "cohere" || provider === "tei";
}

export function rerankerSupportsBaseUrl(provider: HindsightRerankerProvider): boolean {
  return provider === "cohere" || provider === "siliconflow" || provider === "zeroentropy" || provider === "tei";
}

export function embeddingsUsesApiKey(provider: HindsightEmbeddingsProvider): boolean {
  return provider === "openai" || provider === "google" || provider === "cohere";
}

export function rerankerUsesApiKey(provider: HindsightRerankerProvider): boolean {
  return provider === "cohere" || provider === "siliconflow" || provider === "alibaba" || provider === "zeroentropy";
}

/** All ready Kulo model connections (API Key, Vertex AI, and logged-in OAuth subscriptions). */
export function kuloMemoryConnections(
  settings?: KuloSettingsView,
  providers?: ProviderCatalogItem[],
): MemoryKuloConnectionOption[] {
  const defaultProvider = settings?.blocks.model.value.defaultProvider;
  const defaultModel = settings?.blocks.model.value.defaultModel.trim() ?? "";

  if (providers && providers.length > 0) {
    const customNames = new Map((settings?.blocks.model.value.customProviders ?? []).map((cp) => [cp.id, cp.name?.trim()]));
    const gatewayLabel = settings?.blocks.model.value.gatewayName?.trim();
    const options: MemoryKuloConnectionOption[] = [];
    for (const item of providers) {
      if (!item.authenticated) continue;
      const modelIds = [...new Set(item.models.map((m) => m.id.trim()).filter(Boolean))];
      if (defaultProvider === item.id && defaultModel && !modelIds.includes(defaultModel)) {
        modelIds.unshift(defaultModel);
      }
      if (!modelIds.length) continue;
      const fallbackName = item.id === "kulo-gateway" ? gatewayLabel : customNames.get(item.id);
      const label = item.name && item.name !== item.id ? item.name : fallbackName || item.name || item.id;
      options.push({
        id: item.id,
        label,
        authType: item.authType === "oauth" ? "oauth" : "api_key",
        ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
        ...(item.api ? { api: item.api } : {}),
        model: defaultProvider === item.id && defaultModel ? defaultModel : modelIds[0]!,
        models: modelIds,
      });
    }
    return options;
  }

  if (!settings) return [];
  const model = settings.blocks.model;
  const options: MemoryKuloConnectionOption[] = [];
  if (!model.value.gatewayDisabled && (model.hasApiKey || (model.value.gatewayModels?.length ?? 0) > 0)) {
    const chatIds = [...new Set((model.value.gatewayModels ?? []).filter(isConversationModel).map((m) => m.id.trim()).filter(Boolean))];
    if (defaultProvider === "kulo-gateway" && defaultModel && !chatIds.includes(defaultModel)) {
      chatIds.unshift(defaultModel);
    }
    if (chatIds.length || defaultModel) {
      options.push({
        id: "kulo-gateway",
        label: model.value.gatewayName?.trim() || t("默认 API 连接", "Default API connection"),
        authType: "api_key",
        baseUrl: model.value.baseUrl,
        api: model.value.apiMode,
        model: defaultProvider === "kulo-gateway" && defaultModel ? defaultModel : chatIds[0] ?? defaultModel,
        models: chatIds.length ? chatIds : defaultModel ? [defaultModel] : [],
      });
    }
  }
  for (const item of model.value.customProviders ?? []) {
    const chatIds = [...new Set(item.models.filter(isConversationModel).map((m) => m.id.trim()).filter(Boolean))];
    const defaultForConn = defaultProvider === item.id ? defaultModel : "";
    if (defaultForConn && !chatIds.includes(defaultForConn)) chatIds.unshift(defaultForConn);
    options.push({
      id: item.id,
      label: item.name || item.id,
      authType: "api_key",
      baseUrl: item.baseUrl,
      api: item.api,
      model: defaultForConn || chatIds[0] || "",
      models: chatIds,
    });
  }
  return options;
}

export function reusableApiConnectionsForEmbeddings(
  provider: HindsightEmbeddingsProvider,
  connections: MemoryKuloConnectionOption[],
): MemoryKuloConnectionOption[] {
  if (!embeddingsUsesApiKey(provider)) return [];
  return connections.filter((conn) => {
    if (conn.authType !== "api_key" || !conn.baseUrl) return false;
    if (provider === "google") return conn.api === "google-generative-ai";
    if (provider === "openai") return !conn.api || conn.api.startsWith("openai-");
    return true;
  });
}

export function reusableApiConnectionsForReranker(
  provider: HindsightRerankerProvider,
  connections: MemoryKuloConnectionOption[],
): MemoryKuloConnectionOption[] {
  if (!rerankerUsesApiKey(provider)) return [];
  return connections.filter((conn) => conn.authType === "api_key" && Boolean(conn.baseUrl));
}

export function initialMemoryModelsDraft(
  saved?: { model?: HindsightServiceModel; embeddings?: HindsightEmbeddingsModel; reranker?: HindsightRerankerModel },
  settings?: KuloSettingsView,
  providers?: ProviderCatalogItem[],
): MemoryModelsDraft {
  const embeddings = saved?.embeddings;
  const reranker = saved?.reranker;
  const embeddingsProvider: HindsightEmbeddingsProvider = embeddings?.provider ?? "onnx";
  const rerankerProvider: HindsightRerankerProvider = reranker?.provider ?? "onnx";
  const rawEmbeddingsModel = embeddings?.model ?? defaultEmbeddingsModelFor(embeddingsProvider);
  const resolvedEmbeddingsModel = embeddingsProvider === "onnx" ? normalizeOnnxEmbeddingModelId(rawEmbeddingsModel) : rawEmbeddingsModel;
  const rawRerankerModel = reranker?.model ?? defaultRerankerModelFor(rerankerProvider);
  const resolvedRerankerModel = rerankerProvider === "onnx" ? normalizeOnnxRerankerModelId(rawRerankerModel) : rawRerankerModel;
  const baseModels = {
    embeddingsProvider,
    embeddingsConnectionId: embeddings?.connectionId ?? "",
    embeddingsModel: resolvedEmbeddingsModel,
    embeddingsBaseUrl: embeddings?.baseUrl ?? "",
    embeddingsDimensions: embeddings?.dimensions !== undefined
      ? String(embeddings.dimensions)
      : embeddingsProvider === "onnx" && (!embeddings?.model || resolvedEmbeddingsModel === DEFAULT_ONNX_EMBEDDING_MODEL)
        ? String(DEFAULT_ONNX_EMBEDDING_DIMENSIONS)
        : "",
    rerankerProvider,
    rerankerConnectionId: reranker?.connectionId ?? "",
    rerankerModel: resolvedRerankerModel,
    rerankerBaseUrl: reranker?.baseUrl ?? "",
  };

  if (saved?.model) {
    return {
      provider: saved.model.provider,
      connectionId: saved.model.connectionId ?? "",
      model: saved.model.model,
      baseUrl: saved.model.baseUrl ?? "",
      ...baseModels,
    };
  }

  const connections = kuloMemoryConnections(settings, providers);
  const preferredId = settings?.blocks.model.value.defaultProvider;
  const chosen =
    connections.find((item) => item.id === preferredId && item.model)
    ?? connections.find((item) => Boolean(item.model))
    ?? connections.find((item) => item.id === preferredId)
    ?? connections[0];
  if (chosen) {
    return {
      provider: "kulo",
      connectionId: chosen.id,
      model: chosen.model || chosen.models[0] || "",
      baseUrl: "",
      ...baseModels,
    };
  }

  return {
    provider: "openai",
    connectionId: "",
    model: "",
    baseUrl: "",
    ...baseModels,
  };
}

function safeModelUrl(raw: string, label: string): string {
  const value = raw.trim();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(t(`请输入有效的${label}。`, `Enter a valid ${label}.`)); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(t(`${label}不能包含凭据、查询参数或锚点。`, `${label} cannot include credentials, query parameters, or fragments.`));
  }
  return value.replace(/\/+$/, "");
}

export function buildMemoryModelsPayload(draft: MemoryModelsDraft): {
  model: HindsightServiceModel;
  embeddings: HindsightEmbeddingsModel;
  reranker: HindsightRerankerModel;
} {
  if (!draft.model.trim()) throw new Error(t("请选择或填写理解模型。", "Select or enter an understanding model."));
  if (draft.provider === "kulo" && !draft.connectionId.trim()) {
    throw new Error(t("请选择已配置的模型来源。", "Select a configured model source."));
  }
  const model: HindsightServiceModel = draft.provider === "kulo"
    ? { provider: "kulo", connectionId: draft.connectionId.trim(), model: draft.model.trim() }
    : {
        provider: draft.provider,
        model: draft.model.trim(),
        ...(draft.baseUrl.trim() ? { baseUrl: safeModelUrl(draft.baseUrl, t("模型地址", "Model URL")) } : {}),
        ...(draft.connectionId.trim() ? { connectionId: draft.connectionId.trim() } : {}),
      };

  const embBaseUrl = embeddingsSupportsBaseUrl(draft.embeddingsProvider) && draft.embeddingsBaseUrl.trim()
    ? safeModelUrl(draft.embeddingsBaseUrl, t("向量服务地址", "Embedding service URL"))
    : undefined;
  if (draft.embeddingsProvider === "tei" && !embBaseUrl) {
    throw new Error(t("请填写 TEI 向量服务地址。", "Enter the TEI embedding service URL."));
  }
  let dimensions: number | undefined;
  if (draft.embeddingsProvider !== "tei" && draft.embeddingsDimensions.trim()) {
    const parsedDims = Number(draft.embeddingsDimensions.trim());
    if (!Number.isSafeInteger(parsedDims) || parsedDims < 32 || parsedDims > 8192) {
      throw new Error(t("向量维度必须为 32 到 8192 之间的整数。", "Embedding dimensions must be an integer between 32 and 8192."));
    }
    dimensions = parsedDims;
  }
  const rawEmbModel = draft.embeddingsProvider !== "tei" && draft.embeddingsModel.trim() ? draft.embeddingsModel.trim() : undefined;
  const embModel = draft.embeddingsProvider === "onnx" && rawEmbModel ? normalizeOnnxEmbeddingModelId(rawEmbModel) : rawEmbModel;
  const embeddings: HindsightEmbeddingsModel = {
    provider: draft.embeddingsProvider,
    ...(embModel ? { model: embModel } : {}),
    ...(embBaseUrl ? { baseUrl: embBaseUrl } : {}),
    ...(embeddingsUsesApiKey(draft.embeddingsProvider) && draft.embeddingsConnectionId.trim() ? { connectionId: draft.embeddingsConnectionId.trim() } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
  };

  const rrBaseUrl = rerankerSupportsBaseUrl(draft.rerankerProvider) && draft.rerankerBaseUrl.trim()
    ? safeModelUrl(draft.rerankerBaseUrl, t("重排服务地址", "Rerank service URL"))
    : undefined;
  if (draft.rerankerProvider === "tei" && !rrBaseUrl) {
    throw new Error(t("请填写 TEI 重排服务地址。", "Enter the TEI rerank service URL."));
  }
  const rawRrModel = draft.rerankerProvider !== "rrf" && draft.rerankerProvider !== "tei" && draft.rerankerModel.trim() ? draft.rerankerModel.trim() : undefined;
  const rrModel = draft.rerankerProvider === "onnx" && rawRrModel ? normalizeOnnxRerankerModelId(rawRrModel) : rawRrModel;
  const reranker: HindsightRerankerModel = {
    provider: draft.rerankerProvider,
    ...(rrModel ? { model: rrModel } : {}),
    ...(rrBaseUrl ? { baseUrl: rrBaseUrl } : {}),
    ...(rerankerUsesApiKey(draft.rerankerProvider) && draft.rerankerConnectionId.trim() ? { connectionId: draft.rerankerConnectionId.trim() } : {}),
  };

  return { model, embeddings, reranker };
}

export function formatUnderstandingModelLabel(
  model: HindsightServiceModel,
  connections: MemoryKuloConnectionOption[],
): string {
  if (model.provider === "kulo") {
    const match = connections.find((item) => item.id === model.connectionId);
    return `${match?.label ?? model.connectionId ?? "Kulo"} / ${model.model}`;
  }
  return `${model.provider} / ${model.model}`;
}

export function formatEmbeddingsModelLabel(embeddings: HindsightEmbeddingsModel): string {
  if (embeddings.provider === "tei") return `TEI · ${embeddings.baseUrl ?? ""}`;
  const model = embeddings.model || defaultEmbeddingsModelFor(embeddings.provider);
  const dims = embeddings.dimensions ? ` (${embeddings.dimensions}d)` : "";
  return `${embeddings.provider === "onnx" ? t("本机 ONNX", "Local ONNX") : embeddings.provider} / ${model}${dims}`;
}

export function formatRerankerModelLabel(reranker: HindsightRerankerModel): string {
  if (reranker.provider === "rrf") return t("关闭重排（RRF）", "Disabled (RRF)");
  if (reranker.provider === "tei") return `TEI · ${reranker.baseUrl ?? ""}`;
  const model = reranker.model || defaultRerankerModelFor(reranker.provider);
  return `${reranker.provider === "onnx" ? t("本机 ONNX", "Local ONNX") : reranker.provider} / ${model}`;
}

export function buildMemoryServicePrefillPrompt(input: {
  operation: "deploy" | "configure";
  resume?: boolean;
  deviceName?: string;
  draft: MemoryModelsDraft;
  connections: MemoryKuloConnectionOption[];
}): string {
  const { model, embeddings, reranker } = buildMemoryModelsPayload(input.draft);
  const host = input.deviceName?.trim();

  const understandingLine = (() => {
    if (model.provider === "kulo") {
      const match = input.connections.find((item) => item.id === model.connectionId);
      const label = match?.label && match.label !== model.connectionId ? `${match.label} ` : "";
      return `${label}(provider: kulo, connectionId: ${model.connectionId}) / ${model.model}`;
    }
    const extras = [
      ...(model.baseUrl ? [`baseUrl: ${model.baseUrl}`] : []),
      ...(model.connectionId ? [`connectionId: ${model.connectionId}`] : []),
    ];
    return `${model.provider} / ${model.model}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  })();

  const embeddingsLine = (() => {
    if (embeddings.provider === "tei") {
      return `TEI (provider: tei, baseUrl: ${embeddings.baseUrl})`;
    }
    const name = embeddings.model || defaultEmbeddingsModelFor(embeddings.provider);
    const extras = [
      `provider: ${embeddings.provider}`,
      ...(embeddings.dimensions !== undefined ? [`dimensions: ${embeddings.dimensions}`] : []),
      ...(embeddings.baseUrl ? [`baseUrl: ${embeddings.baseUrl}`] : []),
      ...(embeddings.connectionId ? [`connectionId: ${embeddings.connectionId}`] : []),
    ];
    const prefix = embeddings.provider === "onnx" ? `${t("本机 ONNX", "Local ONNX")} ` : "";
    return `${prefix}(${extras.join(", ")}) / ${name}`;
  })();

  const rerankerLine = (() => {
    if (reranker.provider === "rrf") {
      return t("关闭重排 (provider: rrf)", "Disabled (provider: rrf)");
    }
    if (reranker.provider === "tei") {
      return `TEI (provider: tei, baseUrl: ${reranker.baseUrl})`;
    }
    const name = reranker.model || defaultRerankerModelFor(reranker.provider);
    const extras = [
      `provider: ${reranker.provider}`,
      ...(reranker.baseUrl ? [`baseUrl: ${reranker.baseUrl}`] : []),
      ...(reranker.connectionId ? [`connectionId: ${reranker.connectionId}`] : []),
    ];
    const prefix = reranker.provider === "onnx" ? `${t("本机 ONNX", "Local ONNX")} ` : "";
    return `${prefix}(${extras.join(", ")}) / ${name}`;
  })();

  const header = input.operation === "configure"
    ? t(
        `请更新本机${host ? `（${host}）` : ""} Hindsight 的模型配置（待我确认后执行）：`,
        `Update the local Hindsight model settings${host ? ` on ${host}` : ""} (wait for my confirmation before applying):`,
      )
    : input.resume
      ? t(
          `请恢复在本机${host ? `（${host}）` : ""}部署 Hindsight 记忆服务，先检查本机环境，再按以下配置准备部署（待我确认后执行）：`,
          `Resume deploying local Hindsight${host ? ` on ${host}` : ""}. Check the local environment first, then prepare deployment with these settings (wait for my confirmation before running):`,
        )
      : t(
          `请在本机${host ? `（${host}）` : ""}部署 Hindsight 记忆服务，先检查本机环境，再按以下配置准备部署（待我确认后执行）：`,
          `Deploy local Hindsight${host ? ` on ${host}` : ""}. Check the local environment first, then prepare deployment with these settings (wait for my confirmation before running):`,
        );

  return [
    header,
    t(`- 理解模型：${understandingLine}`, `- Understanding model: ${understandingLine}`),
    t(`- 向量模型：${embeddingsLine}`, `- Embedding model: ${embeddingsLine}`),
    t(`- 重排模型：${rerankerLine}`, `- Rerank model: ${rerankerLine}`),
  ].join("\n");
}

export function memoryModelsEqual(a: MemoryModelsDraft, b: MemoryModelsDraft): boolean {
  return a.provider === b.provider
    && a.connectionId === b.connectionId
    && a.model.trim() === b.model.trim()
    && a.baseUrl.trim() === b.baseUrl.trim()
    && a.embeddingsProvider === b.embeddingsProvider
    && a.embeddingsConnectionId === b.embeddingsConnectionId
    && a.embeddingsModel.trim() === b.embeddingsModel.trim()
    && a.embeddingsBaseUrl.trim() === b.embeddingsBaseUrl.trim()
    && a.embeddingsDimensions.trim() === b.embeddingsDimensions.trim()
    && a.rerankerProvider === b.rerankerProvider
    && a.rerankerConnectionId === b.rerankerConnectionId
    && a.rerankerModel.trim() === b.rerankerModel.trim()
    && a.rerankerBaseUrl.trim() === b.rerankerBaseUrl.trim();
}
