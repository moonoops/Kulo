import {
  getImageModelPreset, isImageGenerationModel, redactSensitiveText, validateCustomImageAdapter, validateImageModelProfile,
  type CustomImageAdapter, type ImageGenerationParameters, type ImageJsonValue, type ImageModelProfile,
  type ImageParameterDefinition, type MediaOutputFormat, type ProviderCatalogItem, type ProviderModelItem,
} from "@moco/protocol";
import { readWebResponseText, serviceApiFetch } from "./web-content.js";

export interface ImageProviderAdapterModel {
  model: ProviderModelItem;
  adapter: "openai-image" | "gemini-image" | "custom-image";
  imageProfile: ImageModelProfile;
  defaults?: ImageGenerationParameters;
  customAdapter?: CustomImageAdapter;
  maxOutputs?: number;
  needsConfiguration?: boolean;
  configurationReason?: string;
}
export interface ImageProviderAdapterDiscovery {
  models: ImageProviderAdapterModel[];
  source: "openrouter-image-api" | "native-image-api" | "configuration-required";
  error?: string;
}
export interface ImageProviderAdapterOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const OPENROUTER_IMAGE_MODELS = "https://openrouter.ai/api/v1/images/models";
const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;
const formats = new Set<MediaOutputFormat>(["png", "jpeg", "webp", "gif", "svg"]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function baseUrl(provider: ProviderCatalogItem): URL | undefined {
  try {
    const url = new URL(provider.baseUrl ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : undefined;
  } catch { return undefined; }
}
function nativePreset(id: string) {
  const normalized = id.replace(/^models\//, "").replace(/^(?:openai|google)\//, "");
  return getImageModelPreset("openai-image", normalized) ?? getImageModelPreset("gemini-image", normalized);
}
function unconfigured(model: ProviderModelItem, reason = "请提供此供应商的图像接口文档，确认请求方式与返回字段"): ImageProviderAdapterModel {
  const preset = nativePreset(model.id);
  return { model: clone(model), adapter: "custom-image", imageProfile: preset?.profile ?? { formats: ["png"], supportsEdit: false, maxReferences: 0 },
    ...(preset ? { defaults: preset.defaults } : {}), needsConfiguration: true, configurationReason: reason };
}
function descriptor(parameters: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return Object.hasOwn(parameters, key) ? record(parameters[key]) : undefined;
}
function enumStrings(parameters: Record<string, unknown>, key: string): string[] | undefined {
  const item = descriptor(parameters, key);
  if (item?.type !== "enum" || !Array.isArray(item.values) || !item.values.length || item.values.length > 50 ||
    item.values.some((value) => typeof value !== "string" || !value || value.length > 100)) return undefined;
  return [...new Set(item.values as string[])];
}
function rangeMaximum(parameters: Record<string, unknown>, key: string): number | undefined {
  const item = descriptor(parameters, key);
  return item?.type === "range" && Number.isSafeInteger(item.max) && Number(item.max) >= 0 ? Number(item.max) : undefined;
}
function defaultChoice(values: string[] | undefined, choices: string[]): string | undefined {
  return choices.find((choice) => values?.includes(choice));
}
function customParameters(parameters: Record<string, unknown>): ImageParameterDefinition[] {
  const mapped = new Set(["resolution", "aspect_ratio", "output_format", "quality", "background", "complexity", "n", "input_references", "size", "output_compression", "frame_count", "frame_duration_ms"]);
  return Object.entries(parameters).flatMap(([key, value]): ImageParameterDefinition[] => {
    if (mapped.has(key) || !/^[a-z][a-z0-9_]{0,79}$/.test(key) || /(?:key|token|secret|authorization|password|cookie|header|url|model|prompt|stream|svg|input|tools|provider)/i.test(key)) return [];
    const item = record(value);
    if (item?.type === "range" && typeof item.min === "number" && typeof item.max === "number" && Number.isFinite(item.min) && Number.isFinite(item.max) && item.min <= item.max) {
      return [{ key, label: key, type: "number", minimum: item.min, maximum: item.max }];
    }
    if (item?.type === "enum" && Array.isArray(item.values) && item.values.length && item.values.length <= 50) {
      const type = typeof item.values[0];
      if (["string", "number", "boolean"].includes(type) && item.values.every((entry) => typeof entry === type && (typeof entry !== "string" || entry.length <= 100) && (typeof entry !== "number" || Number.isFinite(entry)))) {
        return [{ key, label: key, type: type as "string" | "number" | "boolean", enum: item.values as Array<string | number | boolean> }];
      }
    }
    // A boolean descriptor means this parameter exists; seed's value is an integer.
    return key === "seed" && item?.type === "boolean" ? [{ key, label: "Seed", type: "number" }] : [];
  }).slice(0, 30);
}

function openRouterModel(raw: unknown): ImageProviderAdapterModel | undefined {
  const item = record(raw);
  if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(item.id)) return undefined;
  const architecture = record(item.architecture);
  if (!Array.isArray(architecture?.output_modalities) || !architecture.output_modalities.includes("image")) return undefined;
  const id = item.id;
  const name = redactSensitiveText(typeof item.name === "string" && item.name.trim() ? item.name.slice(0, 120) : id);
  const model: ProviderModelItem = { id, name, purpose: "image", outputModalities: ["image"],
    modalities: Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image") ? ["text", "image"] : ["text"],
    vision: Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image"),
    reasoning: false, supportedThinkingLevels: ["off"], contextWindow: 0, maxTokens: 0 };
  const parameters = record(item.supported_parameters) ?? {};
  const preset = nativePreset(id);
  const declaredFormats = enumStrings(parameters, "output_format")?.filter((value): value is MediaOutputFormat => formats.has(value as MediaOutputFormat));
  const nativeFormat = preset?.defaults.format;
  const outputFormats = declaredFormats?.length ? declaredFormats : nativeFormat ? [nativeFormat] : ["png" as const];
  const referenceMaximum = rangeMaximum(parameters, "input_references");
  const maxReferences = model.vision && referenceMaximum !== undefined ? Math.min(16, referenceMaximum, preset?.profile.maxReferences ?? 16) : 0;
  const aspectRatios = enumStrings(parameters, "aspect_ratio");
  const resolutions = enumStrings(parameters, "resolution");
  const sizes = resolutions ?? enumStrings(parameters, "size");
  const qualities = enumStrings(parameters, "quality");
  const backgrounds = enumStrings(parameters, "background");
  const complexities = enumStrings(parameters, "complexity");
  const extra = customParameters(parameters);
  const profile = validateImageModelProfile({ id, name, formats: outputFormats, supportsEdit: maxReferences > 0, maxReferences,
    ...(aspectRatios ? { aspectRatios } : {}), ...(sizes ? { sizes } : {}), ...(qualities ? { qualities } : {}),
    supportsTransparency: !!backgrounds?.includes("transparent") && outputFormats.some((format) => format === "png" || format === "webp"),
    supportsComplexity: ["low", "medium", "high"].every((value) => complexities?.includes(value)),
    ...(extra.length ? { parameters: extra } : {}),
  });
  const outputFormat = defaultChoice(outputFormats, ["png", "jpeg", "webp", "svg", "gif"]) as MediaOutputFormat;
  const defaults: ImageGenerationParameters = { format: outputFormat, count: 1,
    ...(defaultChoice(aspectRatios, ["auto"]) ? { aspectRatio: "auto" } : {}),
    ...(defaultChoice(sizes, ["1K", "auto"]) ? { size: defaultChoice(sizes, ["1K", "auto"]) } : {}),
    ...(defaultChoice(qualities, ["auto"]) ? { quality: "auto" } : {}),
    ...(backgrounds?.includes("auto") ? { background: "auto" } : {}),
  };
  const body: Record<string, ImageJsonValue> = { model: "{{model}}", prompt: "{{prompt}}", provider: { allow_fallbacks: false } };
  for (const [native, common] of [["n", "count"], ["aspect_ratio", "aspectRatio"], ["quality", "quality"], ["background", "background"], ["complexity", "complexity"], ["output_compression", "outputCompression"]]) {
    if (descriptor(parameters, native!)) body[native!] = `{{parameters.${common}}}`;
  }
  if (declaredFormats?.length) body.output_format = "{{parameters.format}}";
  if (sizes) body[resolutions ? "resolution" : "size"] = "{{parameters.size}}";
  if (outputFormats.includes("gif")) {
    body.frame_count = "{{parameters.frameCount}}";
    body.frame_duration_ms = "{{parameters.frameDurationMs}}";
  }
  for (const parameter of extra) body[parameter.key] = `{{parameters.custom.${parameter.key}}}`;
  const adapter: CustomImageAdapter = { auth: { type: "bearer" }, generate: { path: "images", body },
    response: { imagesPath: "data", base64Path: "b64_json", mimeTypePath: "media_type" },
    ...(maxReferences > 0 ? { edit: { path: "images", body: { ...body, input_references: "{{references}}" } },
      referenceTemplate: { type: "image_url", image_url: { url: "{{reference.dataUrl}}" } } } : {}),
  };
  const missingFormat = !declaredFormats?.length;
  const minimumReferences = descriptor(parameters, "input_references")?.min;
  const requiresReference = typeof minimumReferences === "number" && minimumReferences > 0;
  return { model, adapter: "custom-image", imageProfile: profile, defaults, customAdapter: validateCustomImageAdapter(adapter),
    maxOutputs: Math.max(1, Math.min(8, rangeMaximum(parameters, "n") ?? 1)),
    ...(missingFormat || requiresReference ? { needsConfiguration: true, configurationReason: missingFormat ? "目录未声明默认输出格式，请核对模型文档后配置" : "此模型要求参考图，请配置仅用于编辑的调用规则" } : {}),
  };
}

/** Only known service origins select a transport; a chat wire protocol is not image API evidence. */
export async function discoverImageProviderAdapters(provider: ProviderCatalogItem, models: readonly ProviderModelItem[], options: ImageProviderAdapterOptions = {}): Promise<ImageProviderAdapterDiscovery> {
  const endpoint = baseUrl(provider);
  const eligible = models.filter(isImageGenerationModel);
  if (!provider.authenticated || provider.authType !== "api_key") return { source: "configuration-required", models: eligible.map((model) => unconfigured(model, "请先连接支持图像接口的 API Key 授权")) };
  if (endpoint?.origin === "https://openrouter.ai" && endpoint.pathname.replace(/\/+$/, "") === "/api/v1") {
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
      const transport = options.fetch ?? ((url, init) => serviceApiFetch(url as string | URL, init ?? {}, { maxResponseBytes: MAX_DIRECTORY_BYTES, timeoutMs: 20_000 }));
      const response = await transport(OPENROUTER_IMAGE_MODELS, { method: "GET", redirect: "error", signal, headers: { Accept: "application/json" } });
      if (!response.ok) { await response.body?.cancel(); throw new Error("图像目录请求失败"); }
      const body = record(JSON.parse(await readWebResponseText(response, MAX_DIRECTORY_BYTES)));
      if (!Array.isArray(body?.data) || body.data.length > 2000) throw new Error("图像目录格式无效");
      const found = new Map<string, ImageProviderAdapterModel>();
      for (const raw of body.data) { const candidate = openRouterModel(raw); if (candidate) found.set(candidate.model.id, candidate); }
      return { source: "openrouter-image-api", models: [...found.values()] };
    } catch {
      return { source: "configuration-required", models: eligible.map((model) => unconfigured(model, "未能读取供应商的图像接口目录，请稍后重试或补充接口配置")), error: "未能读取 OpenRouter 图像模型目录" };
    }
  }
  const nativeAdapter = endpoint?.origin === "https://api.openai.com" && endpoint.pathname.replace(/\/+$/, "") === "/v1" ? "openai-image" as const
    : endpoint?.origin === "https://generativelanguage.googleapis.com" && ["/v1beta", "/v1"].includes(endpoint.pathname.replace(/\/+$/, "")) ? "gemini-image" as const : undefined;
  if (nativeAdapter) return { source: "native-image-api", models: eligible.map((model) => {
    const preset = getImageModelPreset(nativeAdapter, model.id);
    return { model: clone(model), adapter: nativeAdapter, imageProfile: preset?.profile ?? { formats: nativeAdapter === "gemini-image" ? ["jpeg"] : ["png"], supportsEdit: false, maxReferences: 0 },
      defaults: preset?.defaults ?? { format: nativeAdapter === "gemini-image" ? "jpeg" : "png", count: 1 } };
  }) };
  return { source: "configuration-required", models: eligible.map((model) => unconfigured(model)) };
}
