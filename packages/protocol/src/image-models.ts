import type { CustomImageAdapter, ImageGenerationParameters, ImageJsonValue, ImageModelProfile, MediaAdapterId, MediaOutputFormat } from "./capabilities.js";
import { cleanGoogleImageModelId } from "./vertex.js";

export interface ImageModelPreset {
  id: string;
  name: string;
  adapter: "openai-image" | "gemini-image" | "vertex-image";
  baseUrl: string;
  modelId: string;
  profile: ImageModelProfile;
  defaults: ImageGenerationParameters;
}
const ratios = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const google = (modelId: string, name: string, extra: Partial<ImageModelProfile> = {}): ImageModelPreset => ({
  id: modelId, modelId, name, adapter: "gemini-image", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  profile: { id: modelId, name, formats: ["jpeg", "png"], supportsEdit: true, maxReferences: 14, aspectRatios: ratios,
    sizes: ["1K", "2K", "4K"], thinkingLevels: ["minimal", "high"], supportsGrounding: true, speed: 3, quality: 4, cost: 3, ...extra },
  defaults: { format: "jpeg", count: 1, aspectRatio: "auto", ...(extra.sizes?.length === 0 ? {} : { size: extra.sizes && !extra.sizes.includes("1K") ? extra.sizes[0] : "1K" }) },
});
const openai = (modelId: string, name: string, generation: number, fast = false): ImageModelPreset => ({
  id: modelId, modelId, name, adapter: "openai-image", baseUrl: "https://api.openai.com/v1",
  profile: { id: modelId, name, formats: generation >= 26 ? ["png", "jpeg", "webp", "gif", "svg"] : ["png", "jpeg", "webp"],
    supportsEdit: true, maxReferences: 16, aspectRatios: generation >= 20 ? ratios : ["auto", "1:1", "3:2", "2:3"], sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
    qualities: generation >= 25 ? ["auto", "low", "medium", "high", "xhigh", "max"] : ["auto", "low", "medium", "high"],
    supportsTransparency: true, supportsComplexity: generation >= 26, supportsCustomSize: generation >= 20, speed: fast ? 5 : 2, quality: fast ? 4 : 5, cost: fast ? 4 : 2 },
  defaults: { format: "png", count: 1, size: "auto", quality: "auto", background: "auto" },
});

export const IMAGE_MODEL_PRESETS: readonly ImageModelPreset[] = [
  google("gemini-nano-banana-2.1", "Nano Banana 2.1", { aspectRatios: [...ratios, "1:4", "4:1", "1:8", "8:1"], thinkingLevels: ["minimal", "medium", "high"], speed: 4 }),
  google("gemini-3.1-flash-image", "Nano Banana 2", { aspectRatios: [...ratios, "1:4", "4:1", "1:8", "8:1"], sizes: ["0.5K", "1K", "2K", "4K"], speed: 4 }),
  google("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite", { maxReferences: 1, sizes: ["1024px"], supportsGrounding: false, speed: 5, cost: 5, quality: 3 }),
  google("gemini-3-pro-image", "Nano Banana Pro", { thinkingLevels: [], speed: 2, quality: 5, cost: 2 }),
  google("gemini-2.5-flash-image", "Nano Banana", { maxReferences: 3, sizes: [], thinkingLevels: [], supportsGrounding: false, speed: 4, quality: 3, cost: 4 }),
  openai("gpt-image-2.6-sunburst", "GPT Image 2.6 Sunburst", 26),
  openai("gpt-image-2.6-flare", "GPT Image 2.6 Flare", 26, true),
  openai("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst", 25),
  openai("gpt-image-2.5-flare", "GPT Image 2.5 Flare", 25, true),
  openai("gpt-image-2", "GPT Image 2", 20),
  openai("gpt-image-1.5", "GPT Image 1.5", 15),
  openai("gpt-image-1-mini", "GPT Image 1 Mini", 15, true),
];

export function getImageModelPreset(adapter: MediaAdapterId, modelId: string): ImageModelPreset | undefined {
  const isGoogle = adapter === "gemini-image" || adapter === "vertex-image";
  const id = isGoogle ? cleanGoogleImageModelId(modelId) : modelId.replace(/^models\//, "");
  const lookupAdapter = adapter === "vertex-image" ? "gemini-image" : adapter;
  const exact = IMAGE_MODEL_PRESETS.find((preset) => preset.adapter === lookupAdapter && preset.modelId === id);
  const variant = exact ?? IMAGE_MODEL_PRESETS.find((preset) => preset.adapter === lookupAdapter
    && id.startsWith(`${preset.modelId}-`)
    && /^(?:\d{4}-\d{2}-\d{2}|preview(?:-\d{4}-\d{2}-\d{2})?)$/.test(id.slice(preset.modelId.length + 1)));
  if (!variant) return undefined;
  return copy({
    ...variant,
    ...(adapter === "vertex-image" ? { adapter: "vertex-image" as const, baseUrl: "https://aiplatform.googleapis.com/v1" } : {}),
    modelId: id,
  });
}
export function getImageModelProfile(adapter: MediaAdapterId, modelId: string): ImageModelProfile | undefined {
  return getImageModelPreset(adapter, modelId)?.profile;
}

const safeKey = (key: string) => key.length > 0 && key.length <= 100 && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)
  && !key.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part));
const problem = (message: string): never => { throw new Error(message); };
const outputFormats = new Set<MediaOutputFormat>(["png", "jpeg", "webp", "gif", "svg"]);
export function validateImageModelProfile(profile: ImageModelProfile): ImageModelProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).some((key) => !["id", "name", "formats", "supportsEdit", "maxReferences", "aspectRatios", "sizes", "qualities", "supportsTransparency", "supportsComplexity", "supportsCustomSize", "thinkingLevels", "supportsGrounding", "parameters", "speed", "quality", "cost"].includes(key)) || !Array.isArray(profile.formats) || !profile.formats.length || profile.formats.length > 5
    || profile.formats.some((format) => !outputFormats.has(format)) || new Set(profile.formats).size !== profile.formats.length
    || typeof profile.supportsEdit !== "boolean" || !Number.isInteger(profile.maxReferences) || profile.maxReferences < 0 || profile.maxReferences > 16) problem("图像能力声明无效。");
  for (const key of ["aspectRatios", "sizes", "qualities", "thinkingLevels"] as const) {
    const values = profile[key];
    if (values !== undefined && (!Array.isArray(values) || values.length > 50 || values.some((value) => typeof value !== "string" || !value || value.length > 100))) problem("图像参数选项无效。");
  }
  for (const key of ["supportsTransparency", "supportsComplexity", "supportsCustomSize", "supportsGrounding"] as const) if (profile[key] !== undefined && typeof profile[key] !== "boolean") problem("图像能力开关无效。");
  for (const key of ["speed", "quality", "cost"] as const) if (profile[key] !== undefined && (!Number.isFinite(profile[key]) || profile[key]! < 0 || profile[key]! > 5)) problem("图像路由评分必须为0到5。");
  if (profile.parameters !== undefined) {
    if (!Array.isArray(profile.parameters) || profile.parameters.length > 30) problem("自定义图像参数过多。");
    const seen = new Set<string>();
    for (const field of profile.parameters) {
      if (!field || Object.keys(field).some((key) => !["key", "label", "type", "enum", "minimum", "maximum", "required", "default"].includes(key)) || !safeKey(field.key) || ["model", "prompt", "n", "output_format", "size", "quality", "background", "complexity", "output_compression", "frame_count", "frame_duration_ms", "svg", "input", "contents", "response_format", "generation_config", "generationConfig", "tools", "stream", "api_key", "apiKey", "token", "secret", "authorization"].includes(field.key) || seen.has(field.key) || typeof field.label !== "string" || !field.label.trim() || field.label.length > 100 || !["string", "number", "boolean"].includes(field.type)) problem("自定义图像参数声明无效。");
      seen.add(field.key);
      if (field.enum && (!Array.isArray(field.enum) || field.enum.length > 50 || field.enum.some((value) => typeof value !== field.type))) problem("自定义参数选项类型无效。");
      if (field.minimum !== undefined && !Number.isFinite(field.minimum) || field.maximum !== undefined && !Number.isFinite(field.maximum)
        || field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) problem("自定义参数范围无效。");
      if (field.default !== undefined && (typeof field.default !== field.type || field.enum && !field.enum.includes(field.default)
        || typeof field.default === "number" && (!Number.isFinite(field.default) || field.minimum !== undefined && field.default < field.minimum || field.maximum !== undefined && field.default > field.maximum))) problem("自定义参数默认值无效。");
    }
  }
  return copy(profile);
}

const parameterKeys = new Set(["format", "count", "aspectRatio", "size", "quality", "background", "complexity", "outputCompression", "frameCount", "frameDurationMs", "thinkingLevel", "grounding", "svgModel", "svgReasoning", "custom"]);
export function mergeImageGenerationParameters(defaults: ImageGenerationParameters = {}, overrides: ImageGenerationParameters = {}): ImageGenerationParameters {
  if (overrides.custom !== undefined && (!overrides.custom || typeof overrides.custom !== "object" || Array.isArray(overrides.custom))) problem("自定义参数需要对象。");
  const value = { ...copy(defaults), ...copy(overrides) };
  if (defaults.custom || overrides.custom) value.custom = { ...copy(defaults.custom ?? {}), ...copy(overrides.custom ?? {}) };
  if (overrides.format !== undefined && defaults.format !== undefined && overrides.format !== defaults.format) {
    for (const field of ["frameCount", "frameDurationMs", "svgModel", "svgReasoning", "outputCompression"] as const) if (overrides[field] === undefined) delete value[field];
  }
  return value;
}
export function normalizeImageGenerationParameters(input: ImageGenerationParameters, profile: ImageModelProfile, adapter: MediaAdapterId): ImageGenerationParameters {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !parameterKeys.has(key))) problem("图像生成参数包含不支持的字段。");
  const value = copy(input);
  if (value.format !== undefined && !profile.formats.includes(value.format)) problem("此模型不支持所选输出格式。");
  if (value.count !== undefined && (!Number.isInteger(value.count) || value.count < 1 || value.count > 8)) problem("图片数量必须为1到8。");
  if (value.aspectRatio !== undefined && !profile.aspectRatios?.includes(value.aspectRatio)) problem("此模型不支持所选画面比例。");
  if (value.quality !== undefined && !profile.qualities?.includes(value.quality)) problem("此模型不支持所选质量档位。");
  if (value.size !== undefined && !profile.sizes?.includes(value.size)) {
    const dimensions = /^(\d{2,4})x(\d{2,4})$/.exec(value.size);
    const width = Number(dimensions?.[1]); const height = Number(dimensions?.[2]);
    if (adapter !== "openai-image" || !profile.supportsCustomSize || !dimensions || width < 16 || height < 16 || width % 16 || height % 16 || Math.max(width, height) > 3840 || width * height > 3840 * 2160 || width / height > 3 || height / width > 3) problem("此模型不支持所选图片尺寸。");
  }
  if (value.background !== undefined && (!["auto", "opaque", "transparent"].includes(value.background) || value.background === "transparent" && !profile.supportsTransparency)) problem("此模型不支持所选背景。");
  if (value.background === "transparent" && value.format !== undefined && !["png", "webp"].includes(value.format)) problem("透明背景需要PNG或WebP格式。");
  if (value.complexity !== undefined && (!profile.supportsComplexity || !["low", "medium", "high"].includes(value.complexity))) problem("此模型不支持所选复杂度。");
  if (value.outputCompression !== undefined && (!Number.isInteger(value.outputCompression) || value.outputCompression < 0 || value.outputCompression > 100 || value.format !== undefined && !["jpeg", "webp"].includes(value.format))) problem("压缩质量仅支持JPEG/WebP，范围为0到100。");
  if (value.frameCount !== undefined && (value.format !== "gif" || !Number.isInteger(value.frameCount) || value.frameCount < 2 || value.frameCount > 16)) problem("GIF帧数必须为2到16。");
  if (value.frameDurationMs !== undefined && (value.format !== "gif" || !Number.isInteger(value.frameDurationMs) || value.frameDurationMs < 20 || value.frameDurationMs > 655350)) problem("GIF帧间隔必须为20到655350毫秒。");
  if (value.format === "svg" && value.count !== undefined && value.count !== 1) problem("SVG每次只能生成一个结果。");
  if (value.thinkingLevel !== undefined && !profile.thinkingLevels?.includes(value.thinkingLevel)) problem("此模型不支持所选思考档位。");
  if (value.grounding !== undefined && (typeof value.grounding !== "boolean" || value.grounding && !profile.supportsGrounding)) problem("此模型不支持搜索增强。");
  if (value.svgModel !== undefined && (value.format !== "svg" || typeof value.svgModel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value.svgModel))) problem("SVG创作模型无效。");
  if (value.svgReasoning !== undefined && (value.format !== "svg" || !value.svgModel || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.svgReasoning))) problem("SVG思考设置无效。");
  if ((adapter === "gemini-image" || adapter === "vertex-image") && value.count !== undefined && value.count !== 1) problem("Gemini每个作业只请求一张图片。");
  if (value.custom !== undefined && (!value.custom || typeof value.custom !== "object" || Array.isArray(value.custom))) problem("自定义参数需要对象。");
  for (const [key, fieldValue] of Object.entries(value.custom ?? {})) {
    const field = profile.parameters?.find((item) => item.key === key);
    if (!field || typeof fieldValue !== field.type || field.enum && !field.enum.includes(fieldValue as string | number | boolean)
      || typeof fieldValue === "string" && fieldValue.length > 8000
      || typeof fieldValue === "number" && (!Number.isFinite(fieldValue) || field.minimum !== undefined && fieldValue < field.minimum || field.maximum !== undefined && fieldValue > field.maximum)) problem("自定义参数不符合模型声明。");
  }
  for (const field of profile.parameters ?? []) {
    if (value.custom?.[field.key] === undefined && field.default !== undefined) (value.custom ??= {})[field.key] = field.default;
    if (field.required && value.custom?.[field.key] === undefined) problem(`请填写${field.label}。`);
  }
  return value;
}

export function validateCustomImageAdapter(adapter: CustomImageAdapter): CustomImageAdapter {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) || JSON.stringify(adapter).length > 24_000) problem("自定义图像接口声明无效或过长。");
  const relativePath = (value: unknown, poll = false) => {
    if (typeof value !== "string" || !value || value.length > 1000 || /[\x00-\x20\\?#]/.test(value) || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)
      || value.split("/").some((part) => part === ".." || /%(?:2e|2f|5c)/i.test(part)) || !poll && value.includes("{{jobId}}")) problem("自定义接口必须使用同来源的相对路径。");
  };
  const jsonPath = (value: unknown) => { if (typeof value !== "string" || value.length > 500 || value !== "" && value !== "$" && value.split(".").some((part) => !/^(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) problem("返回字段路径无效。"); };
  if (!adapter.auth || !["bearer", "api-key", "none"].includes(adapter.auth.type)) problem("自定义接口认证方式无效。");
  if (adapter.auth.type === "api-key" && (!adapter.auth.header || !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(adapter.auth.header) || /^(?:cookie|host|origin|referer|proxy-authorization)$/i.test(adapter.auth.header))) problem("API Key请求头无效。");
  if (adapter.auth.prefix !== undefined && (typeof adapter.auth.prefix !== "string" || adapter.auth.prefix.length > 40 || /[\r\n]/.test(adapter.auth.prefix))) problem("认证前缀无效。");
  const visitTemplate = (value: ImageJsonValue, referenceOnly = false, depth = 0): void => {
    if (depth > 12) problem("请求模板嵌套过深。");
    if (typeof value === "string") {
      const invalidVariable = referenceOnly
        ? /\{\{(?!\s*reference\.(?:name|mimeType|base64|dataUrl)\s*\}\})/
        : /\{\{(?!\s*(?:prompt|model|references(?:\.\d+\.(?:name|mime_type|data))?|parameters(?:\.[A-Za-z_][A-Za-z0-9_.-]*)?)\s*\}\})/;
      if (value.length > 12_000 || invalidVariable.test(value)) problem("请求模板包含不支持的变量。");
    } else if (Array.isArray(value)) {
      if (value.length > 50) problem("请求模板数组过长。");
      for (const item of value) visitTemplate(item, referenceOnly, depth + 1);
    } else if (value && typeof value === "object") {
      if (Object.keys(value).length > 50) problem("请求模板字段过多。");
      for (const [key, item] of Object.entries(value)) {
        if (!safeKey(key) || /^(?:api[-_]?key|authorization|password|cookie|token|secret)$/i.test(key)) problem("请求模板不能包含凭据字段。");
        visitTemplate(item, referenceOnly, depth + 1);
      }
    } else if (typeof value === "number" && !Number.isFinite(value)) problem("请求模板包含无效数字。");
  };
  for (const request of [adapter.generate, ...(adapter.edit ? [adapter.edit] : [])]) {
    if (!request || typeof request !== "object") problem("缺少图像请求定义。");
    relativePath(request.path);
    for (const [key, value] of Object.entries(request.headers ?? {})) if (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(key) || /(?:authorization|cookie|api[-_]?key|token|secret|host|origin|referer)/i.test(key) || typeof value !== "string" || value.length > 500 || /[\r\n]/.test(value)) problem("自定义请求头不能包含凭据或来源设置。");
    visitTemplate(request.body);
  }
  if (adapter.referenceTemplate !== undefined) visitTemplate(adapter.referenceTemplate, true);
  if (!adapter.response || adapter.response.base64Path === undefined && adapter.response.urlPath === undefined) problem("请配置图片数据或地址的返回字段。");
  for (const value of [adapter.response.imagesPath, adapter.response.base64Path, adapter.response.urlPath, adapter.response.mimeTypePath].filter((value) => value !== undefined)) jsonPath(value);
  if (adapter.poll) {
    relativePath(adapter.poll.path, true); jsonPath(adapter.poll.idPath); jsonPath(adapter.poll.statusPath);
    if (!adapter.poll.path.includes("{{jobId}}") || !Array.isArray(adapter.poll.completeValues) || !adapter.poll.completeValues.length || adapter.poll.completeValues.length > 10
      || !Array.isArray(adapter.poll.failedValues) || adapter.poll.failedValues.length > 10 || [...adapter.poll.completeValues, ...adapter.poll.failedValues].some((value) => typeof value !== "string" || !value || value.length > 100)
      || adapter.poll.intervalMs !== undefined && (!Number.isInteger(adapter.poll.intervalMs) || adapter.poll.intervalMs < 1000 || adapter.poll.intervalMs > 300_000)) problem("异步作业查询定义无效。");
  }
  if (adapter.outputOrigins !== undefined && (!Array.isArray(adapter.outputOrigins) || adapter.outputOrigins.length > 10 || adapter.outputOrigins.some((origin) => {
    try { const url = new URL(origin); return url.protocol !== "https:" || url.origin !== origin || Boolean(url.username || url.password); } catch { return true; }
  }))) problem("产物来源需要明确的HTTPS origin。");
  return copy(adapter);
}
