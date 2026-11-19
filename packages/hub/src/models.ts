import {
  clampThinkingLevel,
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  describeMocoError,
  inferModelPurpose,
  isConversationModel,
  isImageGenerationModel,
  buildVertexModelBaseUrl,
  normalizeVertexConfig,
  redactSensitiveText,
  type CustomModelConfig,
  type CustomProviderApi,
  type BuiltinThinkingEffort,
  type ModelProbeRequest,
  type ModelProbeResult,
  type RolePreset,
  type ThinkingEffort,
  type ThinkingLevelMapConfig,
} from "@moco/protocol";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeProviderBaseUrl,
  type MocoModelConfig,
  type OpenAIApiMode,
} from "./config.js";
import { proxyFetch } from "./http-transport.js";

export const MOCO_PROVIDER_ID = "openai";
export const MOCO_GATEWAY_PROVIDER_ID = "moco-gateway";

const THINKING_MAP_KEYS: readonly BuiltinThinkingEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const GOOGLE_VALID_WIRE_LEVELS = new Set(["minimal", "low", "medium", "high"]);

/**
 * Sanitize a `ThinkingLevelMapConfig` for a target API format.
 * Google Gemini's adapter rejects `"xhigh"` / `"max"` wire strings, so clamp them to `"high"`.
 */
export function sanitizeThinkingLevelMapForApi(
  map: ThinkingLevelMapConfig | undefined,
  api: CustomProviderApi | string,
): ThinkingLevelMap | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: ThinkingLevelMap = {};
  let hasAny = false;
  for (const key of THINKING_MAP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    const raw = map[key];
    if (raw === null) {
      out[key] = null;
      hasAny = true;
    } else if (typeof raw === "string" && raw.trim()) {
      let wire = raw.trim().toLowerCase();
      if (
        (api === "google-generative-ai" || api === "google-vertex") &&
        !GOOGLE_VALID_WIRE_LEVELS.has(wire)
      ) {
        wire = "high";
      }
      out[key] = wire;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

/**
 * Clamp a requested thinking level against the target Model's `reasoning` capability and
 * `thinkingLevelMap` using `@earendil-works/pi-ai`'s native helper.
 */
export function clampModelThinkingLevel(
  model: Model<Api> | undefined,
  requested: ThinkingEffort,
): BuiltinThinkingEffort {
  const builtin = THINKING_MAP_KEYS.includes(requested as BuiltinThinkingEffort)
    ? requested as BuiltinThinkingEffort
    : "off";
  if (!model) return builtin;
  return clampThinkingLevel(model, builtin);
}

const THINKING_MODEL_REF_PREFIX = "moco-thinking:";

function thinkingModelRef(modelId: string, wire: string): string {
  return THINKING_MODEL_REF_PREFIX + Buffer.from(JSON.stringify([modelId, wire])).toString("base64url");
}

/** The durable agent stores a model reference; generation resolves it to a real-id clone. */
export function withThinkingLevelModels(models: Models): Models {
  return new Proxy(models, {
    get(target, property) {
      if (property === "getModel") {
        return (provider: string, id: string): Model<Api> | undefined => {
          if (!isConversationModel({ id })) return undefined;
          const existing = target.getModel(provider, id);
          if (existing || !id.startsWith(THINKING_MODEL_REF_PREFIX)) return existing;
          let snapshot: unknown;
          try {
            snapshot = JSON.parse(Buffer.from(id.slice(THINKING_MODEL_REF_PREFIX.length), "base64url").toString("utf8"));
          } catch {
            return undefined;
          }
          if (!Array.isArray(snapshot) || snapshot.length !== 2 ||
            typeof snapshot[0] !== "string" || typeof snapshot[1] !== "string" ||
            !snapshot[1] || snapshot[1].length > 64) return undefined;
          const [modelId, wire] = snapshot as [string, string];
          if (!isConversationModel({ id: modelId })) return undefined;
          const model = target.getModel(provider, modelId);
          if (!model) return undefined;
          const canonical = THINKING_MAP_KEYS.includes(wire as BuiltinThinkingEffort) ? wire as BuiltinThinkingEffort : "medium";
          const thinkingLevelMap = { ...model.thinkingLevelMap };
          if (wire === "off") {
            if (thinkingLevelMap.off === null) throw new Error(`模型「${modelId}」不支持关闭思考。`);
            thinkingLevelMap.off = model.api.startsWith("openai-") || model.api === "azure-openai-responses" ||
              model.api === "mistral-conversations" ? "none" : "off";
          } else {
            thinkingLevelMap[canonical] = wire;
          }
          // Never mutate the registry model: concurrent conversations may choose different wire values.
          return {
            ...model,
            thinkingLevelMap,
          };
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

export function resolveModelThinkingSelection(
  models: Models,
  provider: string,
  modelId: string,
  requested: ThinkingEffort,
  config: Pick<MocoModelConfig, "gatewayModels" | "customProviders" | "subscriptionModels">,
): { model: { provider: string; modelId: string }; thinkingLevel: BuiltinThinkingEffort } {
  const model = models.getModel(provider, modelId);
  const subscriptionModels = config.subscriptionModels && Object.hasOwn(config.subscriptionModels, provider)
    ? config.subscriptionModels[provider] : undefined;
  const custom = provider === MOCO_GATEWAY_PROVIDER_ID
    ? config.gatewayModels?.find((item) => item.id === modelId)
    : subscriptionModels?.find((item) => item.id === modelId) ??
      config.customProviders.find((item) => item.id === provider)?.models.find((item) => item.id === modelId);
  const nonChatPurpose = inferModelPurpose(custom ?? { id: modelId });
  if (nonChatPurpose !== "chat") {
    if (nonChatPurpose === "image") {
      throw new Error(`模型「${modelId}」是图像生成模型，请在工具技能的图像能力中使用。`);
    }
    throw new Error(`模型「${modelId}」是语音或实时音频模型，不能作为对话模型使用。`);
  }
  const options = custom?.thinkingLevels;
  if (model?.reasoning && custom?.thinkingEnabled === false) {
    return { model: { provider, modelId: thinkingModelRef(modelId, "off") }, thinkingLevel: "off" };
  }
  if (model?.reasoning && options?.length) {
    const option = options.find((item) => item.id === requested) ??
      options.find((item) => item.value === "off") ?? options[0]!;
    return {
      model: { provider, modelId: thinkingModelRef(modelId, option.value) },
      thinkingLevel: THINKING_MAP_KEYS.includes(option.value as BuiltinThinkingEffort) ? option.value as BuiltinThinkingEffort : "medium",
    };
  }
  return {
    model: { provider, modelId },
    thinkingLevel: clampModelThinkingLevel(model, requested),
  };
}

export function openAIResponsesCompat(baseUrl: string): NonNullable<Model<"openai-responses">["compat"]> {
  const officialOpenAI = URL.canParse(baseUrl) && new URL(baseUrl).origin === "https://api.openai.com";
  return {
    supportsDeveloperRole: false,
    // Responses normalizes omitted strict flags; Pi needs this capability to send strict:false for optional tool fields.
    ...(officialOpenAI ? { supportsStrictMode: true } : {}),
  };
}

export function createOpenAIModelEntry(
  modelId: string,
  baseUrl: string,
  apiMode: OpenAIApiMode,
  providerId: string = MOCO_PROVIDER_ID,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  customModel?: CustomModelConfig,
): Model<"openai-completions"> | Model<"openai-responses"> {
  const hasVision = customModel?.modalities
    ? customModel.modalities.includes("image")
    : customModel?.vision ?? true;
  const input: ("text" | "image")[] = hasVision ? ["text", "image"] : ["text"];
  const reasoning = customModel?.reasoning ?? true;
  const resolvedContext = customModel?.contextWindow ?? contextWindow;
  const resolvedMaxTokens = customModel?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const thinkingLevelMap = sanitizeThinkingLevelMapForApi(
    customModel?.thinkingLevelMap,
    apiMode,
  );
  const name = customModel?.name?.trim() || modelId;

  if (apiMode === "openai-responses") {
    return {
      id: modelId,
      name,
      api: "openai-responses",
      provider: providerId,
      baseUrl,
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: resolvedContext,
      maxTokens: resolvedMaxTokens,
      compat: openAIResponsesCompat(baseUrl),
    };
  }

  return {
    id: modelId,
    name,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolvedContext,
    maxTokens: resolvedMaxTokens,
    // Tuned for broad OpenAI-compatible gateways (NewAPI / OneAPI / OpenRouter / DeepSeek / Gemini / Claude proxies)
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: reasoning,
    },
  };
}

export type MutableModels = ReturnType<typeof createModels>;

export function syncOpenAICompatibleModels(
  models: MutableModels,
  getConfig: () => MocoModelConfig,
  getRoles: () => Record<string, RolePreset>,
): void {
  const config = getConfig();
  const roles = getRoles();
  const modelIds = new Set<string>([
    config.defaultModel,
    "gemini-4-hydrogen-xhigh",
    "gpt-4o",
    "gpt-4o-mini",
    "deepseek-chat",
    "deepseek-reasoner",
  ]);

  for (const role of Object.values(roles)) {
    if (role.external) continue;
    if (role.modelId?.trim()) {
      modelIds.add(role.modelId.trim());
    }
  }

  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const openAIApiMode: OpenAIApiMode =
    config.apiMode === "openai-responses" ? "openai-responses" : "openai-completions";
  const catalog = Array.from(modelIds).filter((id) => isConversationModel({ id })).map((id) =>
    createOpenAIModelEntry(id, config.baseUrl, openAIApiMode, MOCO_PROVIDER_ID, contextWindow),
  );

  const provider = createProvider({
    id: MOCO_PROVIDER_ID,
    name: "Moco OpenAI-Compatible Provider",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "MOCO_API_KEY",
        resolve: async () => {
          const live = getConfig();
          const key =
            live.apiKey ??
            process.env.MOCO_API_KEY?.trim() ??
            process.env.OPENAI_API_KEY?.trim();
          return { auth: key ? { apiKey: key } : {} };
        },
      },
    },
    models: catalog,
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });

  models.setProvider(provider);
}

/**
 * Create a `pi-ai` Models registry backed by an OpenAI-compatible endpoint (such as NewAPI).
 */
export function createOpenAICompatibleModels(
  config: MocoModelConfig,
  roles: Record<string, RolePreset>,
): Models {
  const models = createModels();
  syncOpenAICompatibleModels(
    models,
    () => config,
    () => roles,
  );
  return models;
}

function combineProbeSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSig;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([external, timeoutSig]);
  }
  return external;
}

/**
 * Probe an OpenAI-compatible (or Anthropic/Google custom) gateway: list `/models` (best-effort)
 * and run a minimal completion check without leaking saved credentials to new hosts.
 */
export async function probeOpenAICompatibleGateway(
  saved: MocoModelConfig,
  draft: ModelProbeRequest = {},
  signal?: AbortSignal,
  savedCustom?: {
    baseUrl?: string;
    apiKey?: string;
    api?: CustomProviderApi;
    model?: string;
    vertexProject?: string;
    vertexLocation?: string;
  },
): Promise<ModelProbeResult> {
  const checkedAt = Date.now();
  const targetApi: CustomProviderApi =
    draft.api ?? draft.apiMode ?? savedCustom?.api ?? saved.apiMode;

  const rawBaseInput = draft.baseUrl?.trim() || savedCustom?.baseUrl || saved.baseUrl;
  const baseUrl = normalizeProviderBaseUrl(rawBaseInput, targetApi);
  const model = draft.model?.trim() || savedCustom?.model?.trim() || (savedCustom ? "" : saved.defaultModel);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return {
      ok: false,
      latencyMs: 0,
      baseUrl: rawBaseInput,
      model,
      availableModels: [],
      title: "网关地址格式无效",
      error: "请输入以 http:// 或 https:// 开头的有效网关地址。",
      checkedAt,
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      latencyMs: 0,
      baseUrl,
      model,
      availableModels: [],
      title: "网关地址格式无效",
      error: "仅支持 http:// 或 https:// 协议的模型网关地址。",
      checkedAt,
    };
  }
  if (!model) return {
    ok: false, latencyMs: 0, baseUrl, model, availableModels: [], checkedAt,
    title: "请选择要检测的模型", error: "请先填写或选择模型 ID。",
  };
  if (!isConversationModel({ id: model })) return {
    ok: false, latencyMs: 0, baseUrl, model, availableModels: [], checkedAt,
    title: "请选择对话模型", error: isImageGenerationModel({ id: model }) ? "请在工具技能的图像页测试生图模型。" : "请在语音设置页测试语音或实时通话模型。",
  };
  const savedVertex = savedCustom ?? saved;
  const vertex = targetApi === "google-vertex" ? normalizeVertexConfig({
    vertexProject: draft.vertexProject !== undefined ? draft.vertexProject : savedVertex.vertexProject,
    vertexLocation: draft.vertexLocation !== undefined ? draft.vertexLocation : savedVertex.vertexLocation,
  }) : undefined;
  const modelBaseUrl = targetApi === "google-vertex" ? buildVertexModelBaseUrl(baseUrl, vertex ?? {}) : baseUrl;

  const baselineUrl = normalizeProviderBaseUrl(
    savedCustom?.baseUrl ?? saved.baseUrl,
    targetApi,
  );
  const sameEndpoint = baseUrl === baselineUrl;
  const explicitKey = draft.apiKey?.trim();
  // Guardrail: never forward a stored API key when probing a different gateway URL.
  const resolvedKey =
    explicitKey ||
    (sameEndpoint
      ? savedCustom ? savedCustom.apiKey : saved.apiKey ?? process.env.MOCO_API_KEY?.trim() ?? process.env.OPENAI_API_KEY?.trim()
      : undefined);

  const authHeaders: Record<string, string> = {};
  if (resolvedKey) {
    if (targetApi === "anthropic-messages") {
      authHeaders["x-api-key"] = resolvedKey;
      authHeaders["anthropic-version"] = "2023-06-01";
    } else if (targetApi === "google-generative-ai" || targetApi === "google-vertex") {
      authHeaders["x-goog-api-key"] = resolvedKey;
    } else if (targetApi === "azure-openai-responses") {
      authHeaders["api-key"] = resolvedKey;
      authHeaders.Authorization = `Bearer ${resolvedKey}`;
    } else {
      authHeaders.Authorization = `Bearer ${resolvedKey}`;
    }
  }

  let availableModels: string[] = [];
  // Vertex Express exposes generation APIs, but no API-key model-list endpoint.
  if (targetApi !== "google-vertex") {
    try {
      const modelsEndpoint =
        targetApi === "anthropic-messages" || targetApi === "mistral-conversations"
          ? `${baseUrl.replace(/\/v1$/, "")}/v1/models`
          : targetApi === "azure-openai-responses"
            ? `${baseUrl.replace(/\/openai\/v1$/, "")}/openai/v1/models`
            : `${baseUrl}/models`;
      const modelsRes = await proxyFetch(modelsEndpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...authHeaders,
        },
        signal: combineProbeSignal(8_000, signal),
      });
      if (modelsRes.ok) {
        const json = (await modelsRes.json()) as {
          data?: Array<{ id?: unknown }>;
          models?: Array<{ name?: unknown; id?: unknown }>;
        };
        const seen = new Set<string>();
        if (Array.isArray(json?.data)) {
          for (const item of json.data) {
            if (typeof item?.id === "string" && item.id.trim()) {
              seen.add(item.id.trim());
              if (seen.size >= 200) break;
            }
          }
        } else if (Array.isArray(json?.models)) {
          for (const item of json.models) {
            const rawId =
              typeof item?.id === "string"
                ? item.id
                : typeof item?.name === "string"
                  ? item.name.replace(/^models\//, "")
                  : "";
            if (rawId.trim()) {
              seen.add(rawId.trim());
              if (seen.size >= 200) break;
            }
          }
        }
        availableModels = Array.from(seen);
      }
    } catch {
      // Some gateways do not expose `/models`; proceed with direct completion test.
    }
  }

  const start = Date.now();
  try {
    let endpoint: string;
    let bodyPayload: Record<string, unknown>;
    if (targetApi === "anthropic-messages") {
      endpoint = `${baseUrl.replace(/\/v1$/, "")}/v1/messages`;
      bodyPayload = {
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      };
    } else if (targetApi === "pi-messages") {
      endpoint = `${baseUrl}/messages`;
      bodyPayload = {
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      };
    } else if (targetApi === "mistral-conversations") {
      endpoint = `${baseUrl.replace(/\/v1$/, "")}/v1/chat/completions`;
      bodyPayload = {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        stream: false,
      };
    } else if (targetApi === "google-generative-ai" || targetApi === "google-vertex") {
      if (targetApi === "google-vertex") {
        const versionedBaseUrl = new URL(modelBaseUrl).pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part))
          ? modelBaseUrl
          : `${modelBaseUrl}/v1`;
        endpoint = `${versionedBaseUrl}/publishers/google/models/${encodeURIComponent(model.replace(/^publishers\/google\/models\//, ""))}:generateContent`;
      } else {
        endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      }
      bodyPayload = {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 16 },
      };
    } else if (
      targetApi === "openai-responses" ||
      targetApi === "openai-codex-responses" ||
      targetApi === "azure-openai-responses"
    ) {
      endpoint = `${baseUrl}/responses`;
      bodyPayload = {
        model,
        input: "ping",
        max_output_tokens: 16,
        stream: false,
      };
    } else {
      endpoint = `${baseUrl}/chat/completions`;
      bodyPayload = {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        stream: false,
      };
    }

    const res = await proxyFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(bodyPayload),
      signal: combineProbeSignal(15_000, signal),
    });
    const latencyMs = Math.max(0, Date.now() - start);

    if (res.ok) {
      return {
        ok: true,
        latencyMs,
        baseUrl,
        model,
        availableModels,
        checkedAt: Date.now(),
      };
    }

    const bodyText = redactSensitiveText(await res.text().catch(() => ""), resolvedKey ? [resolvedKey] : []);
    if (!sameEndpoint && !explicitKey && (res.status === 401 || res.status === 403)) {
      return {
        ok: false,
        latencyMs,
        baseUrl,
        model,
        availableModels,
        title: "需要重新输入接口密钥",
        error:
          "网关地址已变更，为保护已保存的密钥不被发送到新地址，请填写新网关的接口密钥后再检测。",
        rawDetail: `${res.status}: ${bodyText}`.slice(0, 1000),
        checkedAt: Date.now(),
      };
    }

    const desc = describeMocoError({
      reason: "model_error",
      detail: `${res.status}${bodyText ? `: ${bodyText}` : ""}`,
      modelId: model,
    });
    return {
      ok: false,
      latencyMs,
      baseUrl,
      model,
      availableModels,
      title: desc.title,
      error: desc.hint,
      ...(desc.rawDetail ? { rawDetail: desc.rawDetail } : {}),
      checkedAt: Date.now(),
    };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - start);
    const errMsg = redactSensitiveText(err instanceof Error ? err.message : String(err), resolvedKey ? [resolvedKey] : []);
    const desc = describeMocoError({
      reason: "model_error",
      detail: errMsg,
      modelId: model,
    });
    return {
      ok: false,
      latencyMs,
      baseUrl,
      model,
      availableModels,
      title: desc.title,
      error: desc.hint,
      ...(desc.rawDetail ? { rawDetail: desc.rawDetail } : {}),
      checkedAt: Date.now(),
    };
  }
}
