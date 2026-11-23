import {
  clampThinkingLevel,
  type Api,
  type Model,
  type Models,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export const ZERO_TOOL_THINKING_HEADROOM_TOKENS = 2048;

const BUILTIN_THINKING_MAP_PROVIDERS = [
  "google-vertex",
  "google",
  "anthropic",
  "openai",
  "openai-codex",
  "deepseek",
  "xai",
  "kimi-coding",
  "openrouter",
] as const;

export function isGoogleThinkingApi(api: Api): boolean {
  return api === "google-vertex" || api === "google-generative-ai";
}

/**
 * Resolves the lowest legal thinking level for zero-tool background / memory extraction calls.
 * Preserves `"off"` when the model supports disabling thinking (e.g. Anthropic Claude), while
 * clamping always-on reasoning models to `"minimal"` or `"low"` to avoid upstream 400 errors.
 */
export function resolveZeroToolThinkingLevel(model: Model<Api>, models: Models): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  let effectiveModel: Model<Api> = model;
  if (!effectiveModel.thinkingLevelMap) {
    for (const builtinProvider of BUILTIN_THINKING_MAP_PROVIDERS) {
      const candidate = models.getModel(builtinProvider, model.id);
      if (candidate?.thinkingLevelMap) {
        effectiveModel = { ...model, thinkingLevelMap: candidate.thinkingLevelMap };
        break;
      }
    }
  }
  if (!effectiveModel.thinkingLevelMap) {
    const id = model.id.toLowerCase();
    if (isGoogleThinkingApi(model.api)) {
      if (/^gemini-(?:2\.5-pro|3\.[7-9]|3\.1-pro|[4-9])/.test(id)) {
        effectiveModel = { ...model, thinkingLevelMap: { off: null, minimal: null, low: "low" } };
      } else if (/^gemini-3(?:\.\d+)?-flash|^gemma-?4/.test(id)) {
        effectiveModel = { ...model, thinkingLevelMap: { off: null, minimal: "minimal" } };
      }
    } else if (
      model.api === "openai-responses" ||
      model.api === "openai-codex-responses" ||
      model.api === "azure-openai-responses" ||
      model.api === "openai-completions"
    ) {
      if (/(?:^|\/)(?:deepseek-reasoner|deepseek-r1|o[134](?:-|$))/.test(id)) {
        effectiveModel = { ...model, thinkingLevelMap: { off: null, minimal: null, low: "low" } };
      } else if (/(?:^|\/)gpt-5(?:\.\d+)?(?:-|$)/.test(id)) {
        effectiveModel = { ...model, thinkingLevelMap: { off: null, minimal: "minimal", low: "low" } };
      }
    }
  }
  return clampThinkingLevel(effectiveModel, "off");
}

/**
 * Suppresses Google Gemini/Vertex thought summaries in zero-tool structured JSON requests
 * so hidden reasoning summaries are not billed or interleaved into concise background output.
 */
export function suppressGoogleThoughtSummaries(api: Api, payload: unknown): unknown {
  if (!isGoogleThinkingApi(api)) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  if (!copy.config || typeof copy.config !== "object" || Array.isArray(copy.config)) return copy;
  const config = { ...(copy.config as Record<string, unknown>) };
  if (!config.thinkingConfig || typeof config.thinkingConfig !== "object" || Array.isArray(config.thinkingConfig)) {
    return copy;
  }
  config.thinkingConfig = {
    ...(config.thinkingConfig as Record<string, unknown>),
    includeThoughts: false,
  };
  copy.config = config;
  return copy;
}
