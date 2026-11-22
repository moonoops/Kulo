import type { CustomImageAdapter, ImageGenerationParameters, ImageJsonValue, MediaConnectionView, MediaJob } from "@kulo/protocol";
import { cleanGoogleImageModelId, getImageModelProfile, isOfficialVertexBaseUrl, normalizeImageGenerationParameters } from "@kulo/protocol";
import { isGoogleImageAdapter, isOfficialGoogleImageHost } from "./capability-helpers.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

export class MediaAdapterError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) {
    super(message); this.name = "MediaAdapterError";
  }
}

export interface MediaInput {
  id: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}
export type ImageOutput =
  | { name: string; mimeType: string; bytes: Buffer }
  | { name: string; mimeType: string; url: string };

export const MEDIA_OUTPUT_MIMES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4" };
const MIMES = MEDIA_OUTPUT_MIMES;
const RATIOS: Record<string, string> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864", "9:16": "864x1536", "4:3": "1536x1152", "3:4": "1152x1536", "4:5": "1024x1280", "5:4": "1280x1024", "21:9": "2016x864" };
const INPUT_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

type ParameterJob = Pick<MediaJob, "adapter" | "format" | "aspectRatio" | "quality" | "count" | "modelId" | "parameters" | "imageProfile">;
export function imageParameters(job: ParameterJob): ImageGenerationParameters {
  const value: ImageGenerationParameters = { ...job.parameters, format: job.format, count: job.count,
    ...(job.aspectRatio ? { aspectRatio: job.aspectRatio } : {}), ...(job.quality ? { quality: job.quality } : {}) };
  if (isGoogleImageAdapter(job.adapter) && value.quality && ["0.5K", "1K", "2K", "4K"].includes(value.quality)) { value.size = value.quality; delete value.quality; }
  return value;
}
export function validateImageParameters(job: ParameterJob): void {
  if (job.adapter === "flow-browser") return;
  if (!MIMES[job.format] || job.format === "mp4") throw new MediaAdapterError("unsupported_format", "该接口不支持此图片格式。");
  const profile = job.imageProfile ?? getImageModelProfile(job.adapter, job.modelId);
  const params = imageParameters(job);
  if (params.quality && !profile?.qualities?.includes(params.quality)) throw new MediaAdapterError("invalid_quality", "此模型不支持所选质量档位。");
  if (!profile) throw new MediaAdapterError("image_profile_required", "请先补充此模型的图像能力声明。");
  if (!profile.formats.includes(job.format)) throw new MediaAdapterError("unsupported_format", "此模型不支持所选输出格式。");
  if (isGoogleImageAdapter(job.adapter) && job.count !== 1 || job.format === "svg" && job.count !== 1) throw new MediaAdapterError("unsupported_count", "此生成类型每个作业只请求一个结果。");
  try { normalizeImageGenerationParameters(params, profile, job.adapter); }
  catch (cause) { throw new MediaAdapterError("invalid_image_parameters", cause instanceof Error ? cause.message : "图像生成参数无效。"); }
}

export function mediaEndpoint(connection: MediaConnectionView, suffix: string): URL {
  if (!connection.baseUrl || !connection.origin) throw new MediaAdapterError("missing_endpoint", "生成服务尚未配置接口地址。");
  const normalizedBase = connection.baseUrl.replace(/\/+$/, "");
  let effectiveBase = normalizedBase;
  if (connection.adapter === "gemini-image" && !isOfficialGoogleImageHost(normalizedBase) && /\/v1$/i.test(normalizedBase)) {
    effectiveBase = normalizedBase.replace(/\/v1$/i, "/v1beta");
  } else if (connection.adapter === "vertex-image") {
    const parsed = new URL(normalizedBase);
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (isOfficialVertexBaseUrl(normalizedBase) && /\/v1beta$/i.test(cleanPath)) {
      parsed.pathname = cleanPath.replace(/\/v1beta$/i, "/v1");
      effectiveBase = parsed.toString().replace(/\/+$/, "");
    } else if (!cleanPath.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part))) {
      parsed.pathname = `${cleanPath}/v1`;
      effectiveBase = parsed.toString().replace(/\/+$/, "");
    }
  }
  const url = new URL(`${effectiveBase}/${suffix}`);
  if (url.origin !== connection.origin || url.username || url.password || url.search || url.hash) {
    throw new MediaAdapterError("endpoint_origin_mismatch", "生成接口与保存的凭证来源不一致。");
  }
  return url;
}

async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new MediaAdapterError("response_too_large", "生成结果超过资源大小限制。", true);
  if (!response.body) throw new MediaAdapterError("empty_response", "生成服务没有返回结果。", true);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new MediaAdapterError("response_too_large", "生成结果超过资源大小限制。", true);
      parts.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof MediaAdapterError) throw cause;
    throw new MediaAdapterError("response_interrupted", "结果读取中断，请先核实原作业，不能重复生成。", true);
  } finally {
    // A failed response stream may also reject cancel; preserve the original failure above.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

export function decodeMediaBase64(data: unknown, limit = MAX_UPLOAD_BYTES): Buffer {
  if (typeof data !== "string" || !data || data.length > Math.ceil(limit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
    throw new MediaAdapterError("invalid_result", "生成服务返回了无效或过大的媒体数据。", true);
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > limit) throw new MediaAdapterError("invalid_result", "生成服务返回了无效或过大的媒体数据。", true);
  return bytes;
}

function safeResultUrl(raw: unknown, origin: string, outputOrigins: readonly string[] = []): string {
  if (typeof raw !== "string" || raw.length > 8192) throw new MediaAdapterError("invalid_result_url", "生成结果地址无效。", true);
  let url: URL;
  try { url = new URL(raw); } catch { throw new MediaAdapterError("invalid_result_url", "生成结果地址无效。", true); }
  if (url.origin !== origin && !outputOrigins.includes(url.origin) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new MediaAdapterError("result_origin_mismatch", "生成结果地址不在已授权的服务来源，未发起下载。", true);
  }
  return url.toString();
}

export async function downloadImageOutput(url: string, origin: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, outputOrigins: readonly string[] = []): Promise<Buffer> {
  let next = safeResultUrl(url, origin, outputOrigins);
  for (let hop = 0; hop < 4; hop++) {
    let response: Response;
    try { response = await fetcher(next, { redirect: "manual", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)]) }); }
    catch { throw new MediaAdapterError("download_failed", "结果下载中断，可重试取回原结果。", true); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new MediaAdapterError("download_failed", "结果下载跳转地址无效。", true);
      next = safeResultUrl(new URL(location, next).toString(), origin, outputOrigins);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaAdapterError("download_failed", `结果下载返回 HTTP ${response.status}，可重试取回原结果。`, true);
    }
    return responseBytes(response, MAX_UPLOAD_BYTES);
  }
  throw new MediaAdapterError("download_failed", "结果下载跳转次数过多。", true);
}

export async function generateImage(input: {
  job: MediaJob;
  connection: MediaConnectionView;
  apiKey: string;
  inputs: MediaInput[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<ImageOutput[]> {
  const { job, connection, apiKey, inputs, signal } = input;
  validateImageParameters(job);
  const parameters = imageParameters(job);
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new MediaAdapterError("missing_credential", "生成服务需要有效凭证。");
  if (inputs.some((asset) => !INPUT_MIMES.has(asset.mimeType) || asset.bytes.length > MAX_UPLOAD_BYTES)) {
    throw new MediaAdapterError("unsupported_reference", "图片参考素材需要 PNG、JPEG 或 WebP，且在资源大小限制内。");
  }
  let url: URL;
  let body: string | FormData;
  const headers: Record<string, string> = {};
  if (connection.adapter === "openai-image") {
    url = mediaEndpoint(connection, inputs.length ? "images/edits" : "images/generations");
    headers.Authorization = `Bearer ${apiKey}`;
    const params: Record<string, unknown> = { model: job.modelId, prompt: job.prompt, n: job.count, output_format: job.format };
    if (parameters.size && !(parameters.size === "auto" && parameters.aspectRatio && parameters.aspectRatio !== "auto")) params.size = parameters.size;
    else if (parameters.aspectRatio && parameters.aspectRatio !== "auto") params.size = RATIOS[parameters.aspectRatio] ?? (() => { throw new MediaAdapterError("invalid_aspect_ratio", "此比例需要提供符合模型限制的具体尺寸。"); })();
    for (const [key, name] of [["quality", "quality"], ["background", "background"], ["complexity", "complexity"], ["outputCompression", "output_compression"], ["frameCount", "frame_count"], ["frameDurationMs", "frame_duration_ms"]] as const) if (parameters[key] !== undefined) params[name] = parameters[key];
    if (parameters.svgModel) params.svg = { model: parameters.svgModel, ...(parameters.svgReasoning ? { reasoning: { effort: parameters.svgReasoning } } : {}) };
    Object.assign(params, parameters.custom);
    if (inputs.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (key === "svg") {
          form.set("svg[model]", parameters.svgModel!);
          if (parameters.svgReasoning) form.set("svg[reasoning][effort]", parameters.svgReasoning);
        } else form.set(key, String(value));
      }
      for (const asset of inputs) form.append("image[]", new Blob([new Uint8Array(asset.bytes)], { type: asset.mimeType }), asset.name);
      body = form;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params);
    }
  } else if (connection.adapter === "gemini-image") {
    // https://aistudio.google.com/docs/image-generation uses this revision of Interactions.
    // Select the protocol before submitting: retrying another protocol could charge twice.
    url = mediaEndpoint(connection, "interactions");
    headers["x-goog-api-key"] = apiKey;
    if (!isOfficialGoogleImageHost(url.toString())) headers.Authorization = `Bearer ${apiKey}`;
    headers["Api-Revision"] = "2026-05-20";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      ...parameters.custom,
      model: cleanGoogleImageModelId(job.modelId),
      input: [{ type: "text", text: job.prompt }, ...inputs.map((asset) => ({ type: "image", mime_type: asset.mimeType, data: asset.bytes.toString("base64") }))],
      background: false,
      ...(parameters.thinkingLevel ? { generation_config: { thinking_level: parameters.thinkingLevel } } : {}),
      ...(parameters.grounding ? { tools: [{ type: "google_search" }] } : {}),
      response_format: {
        type: "image", mime_type: MIMES[job.format], delivery: "inline",
        ...(parameters.aspectRatio && parameters.aspectRatio !== "auto" ? { aspect_ratio: parameters.aspectRatio } : {}),
        ...(parameters.size ? { image_size: parameters.size } : {}),
      },
    });
  } else if (connection.adapter === "vertex-image") {
    // Vertex AI generateContent natively supports API-key auth (Express & project-scoped) and imageOutputOptions.
    // Select the protocol statically before submitting: never retry another paid protocol on failure.
    const modelId = cleanGoogleImageModelId(job.modelId);
    url = mediaEndpoint(connection, `publishers/google/models/${encodeURIComponent(modelId)}:generateContent`);
    headers["x-goog-api-key"] = apiKey;
    if (!isOfficialVertexBaseUrl(url.origin)) headers.Authorization = `Bearer ${apiKey}`;
    headers["Content-Type"] = "application/json";
    const wireSize = parameters.size === "0.5K" ? "512" : parameters.size === "1024px" ? "1K" : parameters.size;
    const imageOutputOptions: Record<string, unknown> = {
      mimeType: MIMES[job.format]!,
      ...(parameters.outputCompression !== undefined && job.format === "jpeg" ? { compressionQuality: parameters.outputCompression } : {}),
    };
    const imageConfig: Record<string, unknown> = {
      ...(parameters.aspectRatio && parameters.aspectRatio !== "auto" ? { aspectRatio: parameters.aspectRatio } : {}),
      ...(wireSize ? { imageSize: wireSize } : {}),
      imageOutputOptions,
    };
    body = JSON.stringify({
      ...parameters.custom,
      contents: [{
        role: "user",
        parts: [
          { text: job.prompt },
          ...inputs.map((asset) => ({ inlineData: { mimeType: asset.mimeType, data: asset.bytes.toString("base64") } })),
        ],
      }],
      ...(parameters.grounding ? { tools: [{ googleSearch: {} }] } : {}),
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig,
        ...(parameters.thinkingLevel ? { thinkingConfig: { thinkingLevel: parameters.thinkingLevel.toUpperCase() } } : {}),
      },
    });
  } else throw new MediaAdapterError("invalid_adapter", "此服务不通过图片 API 调用。");

  let response: Response;
  try { response = await (input.fetcher ?? fetch)(url, { method: "POST", headers, body, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)]), redirect: "manual" }); }
  catch { throw new MediaAdapterError("submission_unknown", "请求中断，生成可能已提交；请先核实原作业。", true); }
  if (!response.ok) {
    await response.body?.cancel();
    // Never reflect a provider body: it may echo credentials or signed URLs.
    throw new MediaAdapterError("provider_error", `生成服务返回 HTTP ${response.status}。`, response.status >= 500 || response.status < 400);
  }
  const bytes = await responseBytes(response, Math.ceil(MAX_UPLOAD_BYTES * Math.max(1, job.count) * 1.4) + 1024 * 1024);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new MediaAdapterError("invalid_response", "生成服务返回格式无效，需要核实原结果。", true); }
  if (!value || typeof value !== "object") throw new MediaAdapterError("invalid_response", "生成服务返回格式无效。", true);
  const record = value as Record<string, unknown>;
  const outputs: ImageOutput[] = [];
  if (connection.adapter === "openai-image") {
    const data = record.data;
    if (!Array.isArray(data) || data.length < 1 || data.length > job.count) throw new MediaAdapterError("invalid_response", "生成服务返回的图片数量无效。", true);
    for (const [index, item] of data.entries()) {
      if (!item || typeof item !== "object") throw new MediaAdapterError("invalid_response", "生成服务返回格式无效。", true);
      const result = item as Record<string, unknown>;
      const metadata = { name: `generated-${index + 1}.${job.format}`, mimeType: MIMES[job.format]! };
      if (typeof result.b64_json === "string") outputs.push({ ...metadata, bytes: decodeMediaBase64(result.b64_json) });
      else outputs.push({ ...metadata, url: safeResultUrl(result.url, connection.origin!) });
    }
  } else if (connection.adapter === "vertex-image") {
    const candidates = record.candidates;
    if (!Array.isArray(candidates) || !candidates.length) {
      throw new MediaAdapterError("invalid_response", "Vertex AI 未返回已完成的图片结果，需要核实原结果。", true);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const content = (candidate as Record<string, unknown>).content;
      const parts = content && typeof content === "object" ? (content as Record<string, unknown>).parts : undefined;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const entry = part as Record<string, unknown>;
        if (entry.thought === true) continue;
        const inline = entry.inlineData;
        if (!inline || typeof inline !== "object") continue;
        const inlineRecord = inline as Record<string, unknown>;
        if (inlineRecord.mimeType !== MIMES[job.format]) {
          throw new MediaAdapterError("unsupported_result", "Vertex AI 返回了未请求的媒体格式。", true);
        }
        outputs.push({ name: `generated-${outputs.length + 1}.${job.format}`, mimeType: MIMES[job.format]!, bytes: decodeMediaBase64(inlineRecord.data) });
        if (outputs.length > job.count) throw new MediaAdapterError("invalid_response", "生成服务返回的图片数量超出请求。", true);
      }
    }
    if (!outputs.length) throw new MediaAdapterError("no_image", "生成服务未返回图片，请检查模型或安全反馈。", true);
  } else {
    // REST returns steps/model_output/content; output_image is an SDK-only convenience.
    // https://aistudio.google.com/api-reference/interactions-api#Resource:Interaction
    if (typeof record.id !== "string" || !record.id || record.status !== "completed" || !Array.isArray(record.steps)) {
      throw new MediaAdapterError("invalid_response", "Gemini 未返回已完成的图片作业，需要核实原结果。", true);
    }
    for (const step of record.steps) {
      if (!step || typeof step !== "object" || step.type !== "model_output") continue;
      if (!Array.isArray(step.content)) throw new MediaAdapterError("invalid_response", "Gemini 返回了无效的图片内容。", true);
      for (const part of step.content) {
        if (!part || typeof part !== "object" || part.type !== "image") continue;
        if (part.mime_type !== MIMES[job.format]) throw new MediaAdapterError("unsupported_result", "Gemini 返回了未请求的媒体格式。", true);
        outputs.push({ name: `generated-${outputs.length + 1}.${job.format}`, mimeType: part.mime_type, bytes: decodeMediaBase64(part.data) });
        if (outputs.length > job.count) throw new MediaAdapterError("invalid_response", "生成服务返回的图片数量超出请求。", true);
      }
    }
    if (!outputs.length) throw new MediaAdapterError("no_image", "生成服务未返回图片，请检查模型或安全反馈。", true);
  }
  return outputs;
}

export type CustomImageResult = { status: "completed"; outputs: ImageOutput[] } | { status: "running"; remoteId: string; nextPollAt: number };
function readPath(value: unknown, path: string): unknown {
  if (path === "" || path === "$") return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
function template(value: ImageJsonValue, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    if (exact) return readPath(variables, exact[1]!.trim());
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
      const result = readPath(variables, key.trim());
      if (typeof result !== "string" && typeof result !== "number" && typeof result !== "boolean") throw new MediaAdapterError("invalid_custom_template", "请求模板中的嵌入变量需要文本或数字。");
      return String(result);
    });
  }
  if (Array.isArray(value)) return value.map((item) => template(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, template(item, variables)]));
  return value;
}
function customHeaders(adapter: CustomImageAdapter, apiKey: string): Record<string, string> {
  if (adapter.auth.type === "none") return {};
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new MediaAdapterError("missing_credential", "生成服务需要有效凭证。");
  return adapter.auth.type === "bearer" ? { Authorization: `Bearer ${apiKey}` }
    : { [adapter.auth.header!]: `${adapter.auth.prefix ?? ""}${apiKey}` };
}
function customPath(connection: MediaConnectionView, path: string, modelId: string, remoteId?: string): URL {
  const expanded = path.replaceAll("{{model}}", encodeURIComponent(modelId)).replaceAll("{{jobId}}", encodeURIComponent(remoteId ?? ""));
  if (/\{\{|\}\}/.test(expanded)) throw new MediaAdapterError("invalid_custom_path", "接口路径包含不支持的变量。");
  return mediaEndpoint(connection, expanded.replace(/^\/+/, ""));
}
function customOutputs(value: unknown, job: MediaJob, connection: MediaConnectionView): ImageOutput[] {
  const adapter = connection.customAdapter!;
  const images = readPath(value, adapter.response.imagesPath);
  const items = Array.isArray(images) ? images : images === undefined || images === null ? [] : [images];
  if (!items.length || items.length > job.count) throw new MediaAdapterError("invalid_custom_response", "接口未返回符合请求数量的图片。", true);
  return items.map((item, index): ImageOutput => {
    const suppliedMime = adapter.response.mimeTypePath ? readPath(item, adapter.response.mimeTypePath) : undefined;
    if (suppliedMime !== undefined && suppliedMime !== MIMES[job.format]) throw new MediaAdapterError("unsupported_result", "返回图片格式与请求不一致。", true);
    const metadata = { name: `generated-${index + 1}.${job.format}`, mimeType: MIMES[job.format]! };
    const encoded = adapter.response.base64Path !== undefined ? readPath(item, adapter.response.base64Path) : undefined;
    if (typeof encoded === "string") {
      const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(encoded);
      if (dataUrl && dataUrl[1] !== metadata.mimeType) throw new MediaAdapterError("unsupported_result", "返回图片格式与请求不一致。", true);
      return { ...metadata, bytes: decodeMediaBase64(dataUrl?.[2] ?? encoded) };
    }
    const url = adapter.response.urlPath !== undefined ? readPath(item, adapter.response.urlPath) : undefined;
    return { ...metadata, url: safeResultUrl(url, connection.origin!, adapter.outputOrigins) };
  });
}
export async function customImageRequest(input: {
  job: MediaJob; connection: MediaConnectionView; apiKey: string; inputs?: MediaInput[];
  remoteId?: string; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<CustomImageResult> {
  const { job, connection, apiKey, signal, remoteId } = input;
  const adapter = connection.customAdapter;
  if (connection.adapter !== "custom-image" || !adapter) throw new MediaAdapterError("invalid_adapter", "自定义图像接口尚未配置。");
  if (remoteId && !adapter.poll) throw new MediaAdapterError("invalid_adapter", "此自定义接口未配置异步查询。");
  validateImageParameters(job);
  const headers = customHeaders(adapter, apiKey);
  const request = job.inputAssetIds.length ? adapter.edit : adapter.generate;
  if (!request) throw new MediaAdapterError("unsupported_reference", "此自定义接口尚未配置参考图请求。");
  const variables = { model: job.modelId, prompt: job.prompt, parameters: imageParameters(job), references: (input.inputs ?? []).map((asset) => {
    if (!INPUT_MIMES.has(asset.mimeType) || asset.bytes.length > MAX_UPLOAD_BYTES) throw new MediaAdapterError("unsupported_reference", "参考图片格式或大小不受支持。");
    const base64 = asset.bytes.toString("base64");
    if (adapter.referenceTemplate !== undefined) return template(adapter.referenceTemplate, { reference: { name: asset.name, mimeType: asset.mimeType, base64, dataUrl: `data:${asset.mimeType};base64,${base64}` } });
    return { name: asset.name, mime_type: asset.mimeType, data: base64 };
  }) };
  const url = customPath(connection, remoteId ? adapter.poll!.path : request.path, job.modelId, remoteId);
  const options: RequestInit = { method: remoteId ? "GET" : "POST", headers: { ...(!remoteId ? request.headers : {}), ...headers, ...(!remoteId ? { "Content-Type": "application/json" } : {}) },
    ...(!remoteId ? { body: JSON.stringify(template(request.body, variables)) } : {}),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(remoteId ? 30_000 : 180_000)]), redirect: "manual" };
  let response: Response;
  try { response = await (input.fetcher ?? fetch)(url, options); }
  catch { throw new MediaAdapterError(remoteId ? "custom_poll_failed" : "submission_unknown", remoteId ? "暂时无法查询图像作业，保留原作业等待恢复。" : "请求中断，生成可能已提交；请先核实原作业。", !remoteId); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MediaAdapterError(remoteId ? response.status === 401 || response.status === 403 ? "custom_poll_auth" : "custom_poll_failed" : "provider_error", `图像接口返回HTTP ${response.status}。`, !remoteId && (response.status >= 500 || response.status < 400));
  }
  let bytes: Buffer;
  try { bytes = await responseBytes(response, Math.ceil(MAX_UPLOAD_BYTES * job.count * 1.4) + 1024 * 1024); }
  catch (cause) {
    if (remoteId && cause instanceof MediaAdapterError && cause.code === "response_interrupted") throw new MediaAdapterError("custom_poll_failed", "查询响应读取中断，保留原作业等待恢复。");
    throw cause;
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new MediaAdapterError("invalid_custom_response", "图像接口返回格式无效，请核对原作业。", true); }
  if (adapter.poll) {
    const status = readPath(value, adapter.poll.statusPath);
    if (typeof status === "string" && adapter.poll.failedValues.includes(status)) throw new MediaAdapterError("custom_job_failed", "服务报告图像生成失败。");
    if (!(typeof status === "string" && adapter.poll.completeValues.includes(status))) {
      const id = remoteId ?? readPath(value, adapter.poll.idPath);
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new MediaAdapterError("invalid_custom_job", "异步接口未返回有效作业标识，请核对原请求。", true);
      return { status: "running", remoteId: id, nextPollAt: Date.now() + (adapter.poll.intervalMs ?? 5000) };
    }
  }
  return { status: "completed", outputs: customOutputs(value, job, connection) };
}
