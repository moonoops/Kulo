import type {
  BuiltinThinkingEffort,
  CustomProviderApi,
  ModelModality,
  ModelNativeTools,
  ModelPurpose,
  ThinkingEffort,
  ThinkingLevelMapConfig,
  ThinkingLevelOption,
} from "@moco/protocol";
import { inferModelPurpose } from "@moco/protocol";

export interface ModelMetadataEntry {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  reasoning?: boolean;
  /** Effort wire levels advertised by the upstream registry (e.g. ["none", "low", "medium", "high", "xhigh"]). */
  reasoningEfforts?: string[];
  /** True when the model supports toggling reasoning off (toggle option, budget min 0, or "none"/"off" effort). */
  reasoningToggle?: boolean;
  /** True when reasoning is mandatory / cannot be turned off. */
  reasoningAlwaysOn?: boolean;
  /** True when the model natively supports vendor web search on a compatible official API. */
  webSearch?: boolean;
  /** Non-chat model purpose when explicitly declared by the registry. */
  purpose?: ModelPurpose;
  source: "models.dev" | "litellm";
}

export interface ModelMetadataCatalog {
  version: 1;
  generatedAt: number;
  providers: Record<string, Record<string, ModelMetadataEntry>>;
  models: Record<string, ModelMetadataEntry>;
}

export const REGISTRY_PROVIDER_KEYS = new Set<string>([
  "openai",
  "openai-codex",
  "anthropic",
  "google",
  "google-vertex",
  "deepseek",
  "openrouter",
  "xai",
  "moonshotai-cn",
  "moonshotai",
  "minimax-cn",
  "minimax",
  "zai-coding-plan",
  "zhipuai",
  "zai",
  "alibaba-cn",
  "alibaba",
  "groq",
  "mistral",
  "azure",
  "amazon-bedrock",
]);

export const PRESET_TO_REGISTRY_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  openai: ["openai"],
  "openai-codex": ["openai-codex", "openai"],
  google: ["google"],
  "google-vertex": ["google-vertex", "google"],
  anthropic: ["anthropic"],
  deepseek: ["deepseek"],
  openrouter: ["openrouter"],
  xai: ["xai"],
  "moonshotai-cn": ["moonshotai-cn", "moonshotai"],
  moonshotai: ["moonshotai", "moonshotai-cn"],
  "minimax-cn": ["minimax-cn", "minimax"],
  minimax: ["minimax", "minimax-cn"],
  "zai-coding-cn": ["zai-coding-plan", "zhipuai", "zai"],
  zai: ["zai", "zhipuai"],
  "qwen-token-plan-cn": ["alibaba-cn", "alibaba"],
  "qwen-token-plan": ["alibaba", "alibaba-cn"],
  groq: ["groq"],
  mistral: ["mistral"],
  "azure-openai": ["azure", "openai"],
  "amazon-bedrock": ["amazon-bedrock"],
};

export const API_TO_REGISTRY_PROVIDERS: Readonly<Partial<Record<CustomProviderApi, readonly string[]>>> = {
  "google-vertex": ["google-vertex", "google"],
  "google-generative-ai": ["google"],
  "anthropic-messages": ["anthropic"],
  "openai-responses": ["openai", "xai"],
  "openai-codex-responses": ["openai-codex", "openai"],
  "azure-openai-responses": ["azure", "openai"],
  "mistral-conversations": ["mistral"],
  "bedrock-converse-stream": ["amazon-bedrock", "anthropic"],
};

const VALID_MODALITIES = new Set<ModelModality>(["text", "image", "audio", "video", "pdf"]);
const VALID_EFFORTS = new Set<string>(["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ORDERED_EFFORTS: readonly BuiltinThinkingEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const GOOGLE_ALLOWED_EFFORTS = new Set<string>(["minimal", "low", "medium", "high"]);

const LITELLM_PROVIDER_MAP: Readonly<Record<string, string>> = {
  openai: "openai",
  "text-completion-openai": "openai",
  anthropic: "anthropic",
  gemini: "google",
  vertex_ai: "google-vertex",
  "vertex_ai-language-models": "google-vertex",
  "vertex_ai-vision-models": "google-vertex",
  "vertex_ai-audio-models": "google-vertex",
  "vertex_ai-image-models": "google-vertex",
  "vertex_ai-anthropic_models": "anthropic",
  deepseek: "deepseek",
  openrouter: "openrouter",
  xai: "xai",
  moonshot: "moonshotai",
  minimax: "minimax",
  zhipu: "zhipuai",
  zai: "zai",
  dashscope: "alibaba",
  groq: "groq",
  mistral: "mistral",
  azure: "azure",
  azure_ai: "azure",
  bedrock: "amazon-bedrock",
  bedrock_converse: "amazon-bedrock",
};

function positiveInt(value: unknown, min = 1, max = 10_000_000): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function sanitizeModalityList(raw: unknown): ModelModality[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ModelModality[] = [];
  for (const item of raw) {
    if (typeof item === "string" && VALID_MODALITIES.has(item as ModelModality) && !out.includes(item as ModelModality)) {
      out.push(item as ModelModality);
    }
  }
  return out.length > 0 ? out : undefined;
}

function purposeFromModelsDevType(rawType: unknown): ModelPurpose | "skip" | undefined {
  if (typeof rawType !== "string") return undefined;
  switch (rawType.trim().toLowerCase()) {
    case "embedding":
    case "rerank":
    case "moderation":
    case "video":
      return "skip";
    case "image":
      return "image";
    case "speech":
    case "tts":
      return "tts";
    case "transcription":
    case "asr":
      return "asr";
    case "realtime":
    case "live":
      return "live";
    case "chat":
      return "chat";
    default:
      return undefined;
  }
}

function purposeFromLiteLLMMode(rawMode: unknown): ModelPurpose | "skip" | undefined {
  if (typeof rawMode !== "string") return undefined;
  switch (rawMode.trim().toLowerCase()) {
    case "embedding":
    case "moderation":
    case "rerank":
    case "video_generation":
    case "ocr":
    case "search":
    case "completion":
      return "skip";
    case "image_generation":
      return "image";
    case "audio_speech":
      return "tts";
    case "audio_transcription":
      return "asr";
    case "realtime":
      return "live";
    case "chat":
    case "responses":
      return "chat";
    default:
      return undefined;
  }
}

function parseReasoningOptions(raw: unknown, reasoningFlag: boolean): Pick<ModelMetadataEntry, "reasoningEfforts" | "reasoningToggle" | "reasoningAlwaysOn"> {
  if (!reasoningFlag || !Array.isArray(raw) || raw.length === 0) return {};
  const efforts: string[] = [];
  let hasToggle = false;
  let hasBudget = false;
  let budgetMinZero = false;
  for (const option of raw) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const rec = option as Record<string, unknown>;
    if (rec.type === "toggle") {
      hasToggle = true;
    } else if (rec.type === "budget_tokens") {
      hasBudget = true;
      if (rec.min === 0) budgetMinZero = true;
    } else if (rec.type === "effort" && Array.isArray(rec.values)) {
      for (const value of rec.values) {
        if (typeof value === "string") {
          const lower = value.trim().toLowerCase();
          if (VALID_EFFORTS.has(lower) && !efforts.includes(lower)) {
            efforts.push(lower);
          }
        }
      }
    }
  }
  const hasExplicitOff = efforts.includes("none") || efforts.includes("off");
  const reasoningToggle = hasToggle || hasExplicitOff || budgetMinZero;
  // When effort values are listed without "none"/"off", without toggle, and without optional budget_tokens, reasoning is always on.
  const reasoningAlwaysOn = efforts.length > 0 && !reasoningToggle && !hasBudget;
  return {
    ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    ...(reasoningToggle ? { reasoningToggle: true } : {}),
    ...(reasoningAlwaysOn ? { reasoningAlwaysOn: true } : {}),
  };
}

/** Generate normalized lookup candidates from most-specific to most-general. */
export function normalizeModelIdCandidates(rawId: string): string[] {
  const trimmed = rawId.trim().toLowerCase();
  if (!trimmed) return [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const clean = value.trim();
    if (clean && !seen.has(clean)) seen.add(clean);
  };

  add(trimmed);
  const withoutResource = trimmed
    .replace(/^publishers\/[^/]+\/models\//, "")
    .replace(/^models\//, "");
  add(withoutResource);

  const slashIdx = withoutResource.indexOf("/");
  const bare = slashIdx > 0 ? withoutResource.slice(slashIdx + 1) : withoutResource;
  add(bare);

  const bases = [withoutResource, bare];
  for (const base of bases) {
    // Strip @version (Vertex / Anthropic on Vertex style)
    const noAt = base.replace(/@[a-z0-9._-]+$/, "");
    add(noAt);
    // Strip ISO date (-YYYY-MM-DD), compact 8-digit date (-YYYYMMDD), and MMDD (-MMDD)
    const noIsoDate = noAt.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    add(noIsoDate);
    const noCompactDate = noIsoDate.replace(/-\d{8}$/, "");
    add(noCompactDate);
    const noShortDate = noCompactDate.replace(/-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, "");
    add(noShortDate);
    // Strip -latest and -001 / -002 version revisions
    const noLatest = noShortDate.replace(/-latest$/, "");
    add(noLatest);
    const noRev = noLatest.replace(/-\d{3}$/, "");
    add(noRev);
    // Strip -preview / -exp suffix as lower-priority fallback
    const noPreview = noRev.replace(/-(?:preview|exp)(?:-\d{2}-\d{4}|-\d{4})?$/, "");
    add(noPreview);
  }

  // Add dot <-> hyphen version toggles (e.g. claude-sonnet-4-5 <-> claude-sonnet-4.5)
  const snapshot = [...seen];
  for (const candidate of snapshot) {
    const hyphenToDot = candidate.replace(/(?<=[a-z-])(\d+)-(\d+)(?=$|-)/g, "$1.$2");
    if (hyphenToDot !== candidate) add(hyphenToDot);
    const dotToHyphen = candidate.replace(/(?<=[a-z-])(\d+)\.(\d+)(?=$|-)/g, "$1-$2");
    if (dotToHyphen !== candidate) add(dotToHyphen);
  }

  return [...seen];
}

function stripVersionDate(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^publishers\/[^/]+\/models\//, "")
    .replace(/^models\//, "")
    .replace(/@[a-z0-9._-]+$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

function mergeEntry(primary: ModelMetadataEntry | undefined, secondary: ModelMetadataEntry): ModelMetadataEntry {
  if (!primary) return { ...secondary };
  const contextWindow = primary.contextWindow ?? secondary.contextWindow;
  const rawMaxTokens = primary.maxTokens ?? secondary.maxTokens;
  const maxTokens = contextWindow && rawMaxTokens ? Math.min(rawMaxTokens, contextWindow) : rawMaxTokens;
  const inputModalities = primary.inputModalities?.length
    ? primary.inputModalities
    : secondary.inputModalities;
  const outputModalities = primary.outputModalities?.length
    ? primary.outputModalities
    : secondary.outputModalities;
  return {
    ...(primary.name || secondary.name ? { name: primary.name || secondary.name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(inputModalities ? { inputModalities: [...inputModalities] } : {}),
    ...(outputModalities ? { outputModalities: [...outputModalities] } : {}),
    ...(primary.reasoning !== undefined
      ? { reasoning: primary.reasoning }
      : secondary.reasoning !== undefined
        ? { reasoning: secondary.reasoning }
        : {}),
    ...(primary.reasoningEfforts?.length
      ? { reasoningEfforts: [...primary.reasoningEfforts] }
      : secondary.reasoningEfforts?.length
        ? { reasoningEfforts: [...secondary.reasoningEfforts] }
        : {}),
    ...(primary.reasoningToggle || secondary.reasoningToggle ? { reasoningToggle: true } : {}),
    ...(primary.reasoningAlwaysOn !== undefined
      ? primary.reasoningAlwaysOn ? { reasoningAlwaysOn: true } : {}
      : secondary.reasoningAlwaysOn
        ? { reasoningAlwaysOn: true }
        : {}),
    ...(primary.webSearch || secondary.webSearch ? { webSearch: true } : {}),
    ...(primary.purpose ?? secondary.purpose ? { purpose: primary.purpose ?? secondary.purpose } : {}),
    source: primary.source,
  };
}

/** Parse raw `https://models.dev/api.json` payload into Moco's compact provider & canonical model index. */
export function parseModelsDevCatalog(raw: unknown): {
  providers: Record<string, Record<string, ModelMetadataEntry>>;
  models: Record<string, ModelMetadataEntry>;
} {
  const providers: Record<string, Record<string, ModelMetadataEntry>> = {};
  const models: Record<string, ModelMetadataEntry> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { providers, models };
  }

  for (const [providerId, providerValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!REGISTRY_PROVIDER_KEYS.has(providerId)) continue;
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const rawModels = (providerValue as Record<string, unknown>).models;
    if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) continue;

    const bucket: Record<string, ModelMetadataEntry> = {};
    for (const [key, modelValue] of Object.entries(rawModels as Record<string, unknown>)) {
      if (!modelValue || typeof modelValue !== "object" || Array.isArray(modelValue)) continue;
      const item = modelValue as Record<string, unknown>;
      const id = (typeof item.id === "string" && item.id.trim() ? item.id.trim() : key).toLowerCase();
      if (!id) continue;
      const explicitPurpose = purposeFromModelsDevType(item.type);
      if (explicitPurpose === "skip") continue;

      const limit = item.limit && typeof item.limit === "object" && !Array.isArray(item.limit)
        ? item.limit as Record<string, unknown>
        : undefined;
      const contextWindow = positiveInt(limit?.context) ?? positiveInt(limit?.input);
      const rawOutput = positiveInt(limit?.output);
      const maxTokens = contextWindow && rawOutput ? Math.min(rawOutput, contextWindow) : rawOutput;

      const modalities = item.modalities && typeof item.modalities === "object" && !Array.isArray(item.modalities)
        ? item.modalities as Record<string, unknown>
        : undefined;
      const inputModalities = sanitizeModalityList(modalities?.input);
      const outputModalities = sanitizeModalityList(modalities?.output);

      const inferred = inferModelPurpose({
        id,
        ...(explicitPurpose ? { purpose: explicitPurpose } : {}),
        ...(outputModalities ? { outputModalities } : {}),
      });
      const purpose = explicitPurpose && explicitPurpose !== "chat"
        ? explicitPurpose
        : inferred !== "chat"
          ? inferred
          : undefined;

      const reasoning = typeof item.reasoning === "boolean" ? item.reasoning : undefined;
      const capabilities = item.capabilities && typeof item.capabilities === "object" && !Array.isArray(item.capabilities)
        ? item.capabilities as Record<string, unknown>
        : undefined;
      const capReasoning = capabilities?.reasoning;
      const resolvedReasoning = reasoning ?? (typeof capReasoning === "boolean"
        ? capReasoning
        : capReasoning && typeof capReasoning === "object" && typeof (capReasoning as Record<string, unknown>).supported === "boolean"
          ? (capReasoning as Record<string, unknown>).supported as boolean
          : undefined);

      const reasoningOpts = parseReasoningOptions(
        item.reasoning_options ?? (capReasoning && typeof capReasoning === "object" && Array.isArray((capReasoning as Record<string, unknown>).effort)
          ? [{ type: "effort", values: (capReasoning as Record<string, unknown>).effort }]
          : undefined),
        resolvedReasoning === true,
      );

      const name = typeof item.name === "string" && item.name.trim() && item.name.trim() !== id
        ? item.name.trim().slice(0, 120)
        : undefined;

      const entry: ModelMetadataEntry = {
        ...(name ? { name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
        ...(resolvedReasoning !== undefined ? { reasoning: resolvedReasoning } : {}),
        ...reasoningOpts,
        ...(purpose ? { purpose } : {}),
        source: "models.dev",
      };

      bucket[id] = entry;

      // Also populate provider-agnostic canonical index (preferring non-openrouter first-party entries).
      const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
      if (providerId !== "openrouter" || !models[bare]) {
        models[bare] = providerId === "openrouter"
          ? mergeEntry(models[bare], entry)
          : mergeEntry(entry, models[bare] ?? entry);
      }
    }

    if (Object.keys(bucket).length > 0) {
      providers[providerId] = bucket;
    }
  }

  return { providers, models };
}

/** Enrich/merge a catalog with LiteLLM's `model_prices_and_context_window.json` (secondary source + webSearch flags). */
export function mergeLiteLLMCatalog(
  base: {
    providers: Record<string, Record<string, ModelMetadataEntry>>;
    models: Record<string, ModelMetadataEntry>;
  },
  rawLiteLLM: unknown,
): {
  providers: Record<string, Record<string, ModelMetadataEntry>>;
  models: Record<string, ModelMetadataEntry>;
} {
  if (!rawLiteLLM || typeof rawLiteLLM !== "object" || Array.isArray(rawLiteLLM)) {
    return base;
  }

  // First pass: collect webSearch capability union across dated snapshots -> base IDs per provider
  const webSearchByProviderBase = new Map<string, Set<string>>();
  const globalWebSearchBases = new Set<string>();
  const parsedItems: Array<{ providerId: string; id: string; entry: ModelMetadataEntry }> = [];

  for (const [rawKey, rawValue] of Object.entries(rawLiteLLM as Record<string, unknown>)) {
    if (rawKey === "sample_spec" || !rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const item = rawValue as Record<string, unknown>;
    const rawProvider = typeof item.litellm_provider === "string" ? item.litellm_provider.trim().toLowerCase() : "";
    const providerId = LITELLM_PROVIDER_MAP[rawProvider];
    if (!providerId) continue;

    const modePurpose = purposeFromLiteLLMMode(item.mode);
    if (modePurpose === "skip") continue;

    // Strip LiteLLM provider prefix (e.g. "vertex_ai/gemini-2.5-pro" -> "gemini-2.5-pro")
    const lowerKey = rawKey.trim().toLowerCase();
    const id = providerId === "openrouter"
      ? lowerKey.replace(/^openrouter\//, "")
      : lowerKey.replace(/^(?:vertex_ai|gemini|anthropic|openai|deepseek|xai|moonshot|minimax|zhipu|zai|dashscope|groq|mistral|azure_ai|azure|bedrock_converse|bedrock)\//, "");
    if (!id || id.includes("*")) continue;
    // Skip regional/routing duplicate keys in LiteLLM (e.g. "us.anthropic...", "eu/gpt-4o", "bedrock/us-east-1/...")
    if (/^(?:us|eu|ap|apac|au|ca|jp|uk|global|regional|eastus\d*|westus\d*|swedencentral|northcentralus|southcentralus|australiaeast|canadacentral|francecentral|japaneast|koreacentral|norwayeast|polandcentral|spaincentral|switzerlandnorth|uaenorth|uksouth)[./-]/i.test(id)) {
      continue;
    }
    if ((providerId === "amazon-bedrock" || providerId === "azure") && (id.includes("/") || id.includes(":") || id.includes("."))) continue;
    // Skip legacy/dated duplicate entries in LiteLLM when an entry already exists under the base ID (keep webSearch union below).
    const isDatedSnapshot = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(id) || /@\d{6,8}$/.test(id);
    if (isDatedSnapshot && !base.providers[providerId]?.[id]) {
      if (item.supports_web_search === true) {
        const baseId = stripVersionDate(id);
        if (!webSearchByProviderBase.has(providerId)) webSearchByProviderBase.set(providerId, new Set());
        webSearchByProviderBase.get(providerId)!.add(baseId);
        globalWebSearchBases.add(baseId);
      }
      continue;
    }

    const contextWindow = positiveInt(item.max_input_tokens) ?? positiveInt(item.max_tokens);
    const rawMaxOutput = positiveInt(item.max_output_tokens) ?? positiveInt(item.max_tokens);
    // Guard against known LiteLLM copy-paste errors where max_output_tokens === 1M context window.
    const saneMaxOutput = rawMaxOutput && contextWindow && rawMaxOutput === contextWindow && contextWindow >= 500_000
      ? undefined
      : rawMaxOutput && contextWindow
        ? Math.min(rawMaxOutput, contextWindow)
        : rawMaxOutput;

    const inputModalities: ModelModality[] = ["text"];
    if (item.supports_vision === true) inputModalities.push("image");
    if (item.supports_audio_input === true) inputModalities.push("audio");
    if (item.supports_video_input === true) inputModalities.push("video");
    if (item.supports_pdf_input === true) inputModalities.push("pdf");

    const webSearch = item.supports_web_search === true ? true : undefined;
    const reasoning = typeof item.supports_reasoning === "boolean" ? item.supports_reasoning : undefined;
    const purpose = modePurpose && modePurpose !== "chat" ? modePurpose : undefined;

    if (webSearch) {
      const baseId = stripVersionDate(id);
      if (!webSearchByProviderBase.has(providerId)) webSearchByProviderBase.set(providerId, new Set());
      webSearchByProviderBase.get(providerId)!.add(baseId);
      globalWebSearchBases.add(baseId);
    }

    const entry: ModelMetadataEntry = {
      ...(contextWindow ? { contextWindow } : {}),
      ...(saneMaxOutput ? { maxTokens: saneMaxOutput } : {}),
      ...(inputModalities.length > 1 ? { inputModalities } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(webSearch ? { webSearch: true } : {}),
      ...(purpose ? { purpose } : {}),
      source: "litellm",
    };

    parsedItems.push({ providerId, id, entry });
  }

  for (const { providerId, id, entry } of parsedItems) {
    base.providers[providerId] ??= {};
    const existing = base.providers[providerId]![id];
    // Preserve models.dev as primary; LiteLLM only fills missing fields / webSearch / missing models.
    base.providers[providerId]![id] = existing ? mergeEntry(existing, entry) : entry;

    const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    if (providerId !== "openrouter" && providerId !== "amazon-bedrock" && providerId !== "azure") {
      base.models[bare] = base.models[bare] ? mergeEntry(base.models[bare], entry) : entry;
    }
  }

  // Propagate webSearch from dated LiteLLM variants onto existing models.dev aliases (e.g. claude-sonnet-4-5).
  for (const [providerId, bucket] of Object.entries(base.providers)) {
    const searchBases = webSearchByProviderBase.get(providerId);
    if (!searchBases) continue;
    for (const [id, entry] of Object.entries(bucket)) {
      if (!entry.webSearch && searchBases.has(stripVersionDate(id))) {
        entry.webSearch = true;
      }
    }
  }
  for (const [id, entry] of Object.entries(base.models)) {
    if (!entry.webSearch && globalWebSearchBases.has(stripVersionDate(id))) {
      entry.webSearch = true;
    }
  }

  return base;
}

export function buildNormalizedCatalog(
  rawModelsDev: unknown,
  rawLiteLLM?: unknown,
  now = Date.now(),
): ModelMetadataCatalog {
  const base = parseModelsDevCatalog(rawModelsDev);
  const merged = rawLiteLLM ? mergeLiteLLMCatalog(base, rawLiteLLM) : base;
  return {
    version: 1,
    generatedAt: now,
    providers: merged.providers,
    models: merged.models,
  };
}

export function isValidModelMetadataCatalog(raw: unknown): raw is ModelMetadataCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return (
    obj.version === 1 &&
    typeof obj.generatedAt === "number" &&
    Number.isFinite(obj.generatedAt) &&
    Boolean(obj.providers && typeof obj.providers === "object" && !Array.isArray(obj.providers)) &&
    Boolean(obj.models && typeof obj.models === "object" && !Array.isArray(obj.models))
  );
}

/** Lookup a model entry in a normalized catalog using provider scope + multi-stage ID normalization. */
export function lookupModelInCatalog(
  catalog: ModelMetadataCatalog,
  modelId: string,
  options?: { preset?: string; api?: CustomProviderApi },
): ModelMetadataEntry | undefined {
  const candidates = normalizeModelIdCandidates(modelId);
  if (candidates.length === 0) return undefined;

  const providerHints: string[] = [];
  if (options?.preset) {
    const mapped = PRESET_TO_REGISTRY_PROVIDERS[options.preset.trim().toLowerCase()];
    if (mapped) providerHints.push(...mapped);
    else providerHints.push(options.preset.trim().toLowerCase());
  }
  if (options?.api) {
    const apiMapped = API_TO_REGISTRY_PROVIDERS[options.api];
    if (apiMapped) {
      for (const pid of apiMapped) {
        if (!providerHints.includes(pid)) providerHints.push(pid);
      }
    }
  }

  for (const providerId of providerHints) {
    const bucket = catalog.providers[providerId];
    if (!bucket) continue;
    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(bucket, candidate)) {
        return bucket[candidate];
      }
    }
  }

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(catalog.models, candidate)) {
      return catalog.models[candidate];
    }
  }

  return undefined;
}

/** Whether official native web search may be defaulted ON for this provider + API combination. */
export function isOfficialNativeSearchDefaultEligible(options: {
  api: CustomProviderApi;
  officialSource: boolean;
  presetId?: string;
}): boolean {
  if (!options.officialSource) return false;
  // Google generateContent cannot combine googleSearch with agent functionDeclarations.
  if (options.api === "google-generative-ai" || options.api === "google-vertex") return false;
  // OpenRouter web plugin incurs per-search extra charges -> off by default (user toggleable).
  if (options.presetId === "openrouter") return false;
  return (
    options.api === "openai-responses" ||
    options.api === "openai-codex-responses" ||
    options.api === "azure-openai-responses" ||
    options.api === "anthropic-messages"
  );
}

/** Model-level native web search capability check for official vendor presets. */
export function resolveDefaultNativeTools(options: {
  modelId: string;
  api: CustomProviderApi;
  officialSource: boolean;
  presetId?: string;
  registryEntry?: Pick<ModelMetadataEntry, "webSearch">;
}): ModelNativeTools | undefined {
  if (!isOfficialNativeSearchDefaultEligible(options)) return undefined;
  const bare = options.modelId.trim().toLowerCase().replace(/^(?:publishers\/[^/]+\/)?models\//, "");
  const tail = bare.includes("/") ? bare.slice(bare.indexOf("/") + 1) : bare;

  // Exclude obvious non-search specialized models.
  if (/(?:^|-)(?:audio|realtime|transcribe|tts|whisper|image|imagine|embedding|moderation|sora|veo)(?:-|$)/i.test(tail)) {
    return undefined;
  }

  if (options.registryEntry?.webSearch === true) {
    return { webSearch: true };
  }

  if (
    options.api === "openai-responses" ||
    options.api === "openai-codex-responses" ||
    options.api === "azure-openai-responses"
  ) {
    if (/^(?:gpt-4o|gpt-4\.1(?!-nano)|gpt-5|gpt-6|gpt-daybreak|o3(?!-mini)|o4-mini|chat-latest|chatgpt-4o)/i.test(tail)) {
      return { webSearch: true };
    }
    if ((options.presetId === "xai" || tail.startsWith("grok-")) && /^grok-(?:3|4|5|build)/i.test(tail)) {
      return { webSearch: true };
    }
  }

  if (options.api === "anthropic-messages") {
    if (/^claude-(?:3-7|sonnet-4|opus-4|haiku-4|sonnet-5|opus-5|haiku-5|fable-|mythos-)/i.test(tail)) {
      return { webSearch: true };
    }
  }

  return undefined;
}

/** Build API-legal `thinkingLevelMap`, `supportedThinkingLevels`, and `thinkingLevels` from registry metadata. */
export function buildThinkingConfigFromRegistry(
  api: CustomProviderApi,
  entry: Pick<ModelMetadataEntry, "reasoning" | "reasoningEfforts" | "reasoningToggle" | "reasoningAlwaysOn">,
): {
  thinkingLevelMap?: ThinkingLevelMapConfig;
  supportedThinkingLevels: ThinkingEffort[];
  thinkingLevels?: ThinkingLevelOption[];
} {
  if (!entry.reasoning) {
    return { supportedThinkingLevels: ["off"] };
  }
  const efforts = entry.reasoningEfforts ?? [];
  if (efforts.length === 0) {
    const isGoogle = api === "google-generative-ai" || api === "google-vertex";
    const levels: ThinkingEffort[] = isGoogle
      ? ["off", "low", "medium", "high"]
      : ["off", "low", "medium", "high", "xhigh"];
    return { supportedThinkingLevels: levels };
  }

  const isGoogle = api === "google-generative-ai" || api === "google-vertex";
  const isOpenAILike =
    api === "openai-responses" ||
    api === "openai-codex-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-completions" ||
    api === "mistral-conversations";

  const map: ThinkingLevelMapConfig = {};
  const supported: ThinkingEffort[] = [];
  const options: ThinkingLevelOption[] = [];

  if (entry.reasoningAlwaysOn) {
    map.off = null;
  } else if (efforts.includes("none") && isOpenAILike) {
    map.off = "none";
    supported.push("off");
    options.push({ id: "off", label: "off", value: "off" });
  } else {
    supported.push("off");
    options.push({ id: "off", label: "off", value: "off" });
  }

  for (const level of ORDERED_EFFORTS) {
    const allowedByApi = !isGoogle || GOOGLE_ALLOWED_EFFORTS.has(level);
    if (allowedByApi && efforts.includes(level)) {
      map[level] = level;
      supported.push(level);
      options.push({ id: level, label: level, value: level });
    } else {
      map[level] = null;
    }
  }

  // Fallback safeguard: ensure at least one active level exists if all upstream efforts were filtered out.
  if (options.length === 0) {
    map.medium = "medium";
    map.high = "high";
    supported.push("medium", "high");
    options.push({ id: "medium", label: "medium", value: "medium" }, { id: "high", label: "high", value: "high" });
  }

  return {
    thinkingLevelMap: map,
    supportedThinkingLevels: supported,
    thinkingLevels: options,
  };
}
