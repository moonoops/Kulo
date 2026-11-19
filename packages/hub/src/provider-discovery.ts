import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { inferModelPurpose, isImageGenerationModel, isOfficialVertexBaseUrl, MODEL_PURPOSES, redactSensitiveText, type CustomProviderApi, type ModelModality, type ModelPurpose } from "@moco/protocol";
import { fetchVertexPublicModels } from "./vertex-public-catalog.js";

export interface RawDiscoveredModel {
  id: string;
  purpose?: ModelPurpose;
  outputModalities?: ModelModality[];
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

const MAX_PAGES = 100;
const MAX_MODELS = 50_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function loopbackTarget(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) || /^::ffff:7f[\da-f]{2}:/.test(host);
}

async function fetchModelListPage(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  let proxy: URL | undefined;
  try { proxy = loopbackTarget(url) ? undefined : resolveHttpProxyUrlForTarget(url); }
  catch { throw new Error("HTTP 代理配置无效或不支持，请检查代理地址。"); }
  const requestOptions = { method: "GET", headers, cache: "no-store", redirect: "error" as const, signal };
  if (!proxy) return globalThis.fetch(url, requestOptions);

  // Node 22 fetch does not consistently honor the Hub's HTTP proxy environment.
  let agent: HttpsProxyAgent<string>;
  try { agent = new HttpsProxyAgent(proxy); }
  catch { throw new Error("HTTP 代理配置无效，请检查代理地址。"); }
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (result: Response | Error) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const transportError = (error: Error) => {
      if (signal.aborted) {
        finish(new Error("获取模型列表已取消或超时。"));
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      finish(new Error(`通过 HTTP 代理获取模型列表失败${code && /^[A-Z_\d]+$/.test(code) ? ` (${code})` : ""}，请检查网络连接。`));
    };
    try {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", headers: { ...headers, "Accept-Encoding": "identity" }, signal, agent,
      }, (incoming) => {
        incoming.once("error", transportError);
        incoming.once("aborted", () => transportError(new Error("模型列表响应中断。")));
        const status = incoming.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          incoming.resume();
          finish(new Error(`模型列表接口发生重定向 (HTTP ${status})，已停止请求。`));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            finish(new Error("模型列表响应超过大小限制，未返回不完整结果。"));
            incoming.destroy();
          } else chunks.push(chunk);
        });
        incoming.once("end", () => {
          if (settled) return;
          try {
            let bytes = Buffer.concat(chunks);
            const encoding = incoming.headers["content-encoding"]?.toLowerCase();
            const decodeOptions = { maxOutputLength: MAX_RESPONSE_BYTES };
            if (encoding === "gzip") bytes = gunzipSync(bytes, decodeOptions);
            else if (encoding === "br") bytes = brotliDecompressSync(bytes, decodeOptions);
            else if (encoding === "deflate") bytes = inflateSync(bytes, decodeOptions);
            else if (encoding && encoding !== "identity") throw new Error("不支持的响应压缩格式。");
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            finish(new Response(status === 204 || status === 205 ? null : bytes, { status, headers: responseHeaders }));
          } catch {
            finish(new Error("模型列表响应无法读取或超过大小限制。"));
          }
        });
      });
      request.once("error", transportError);
      request.end();
    } catch {
      finish(new Error("通过 HTTP 代理发送模型列表请求失败，请检查网络与接口配置。"));
    }
  });
}

export function supportsApiModelDiscovery(api: CustomProviderApi): boolean {
  return api !== "bedrock-converse-stream" && api !== "pi-messages" && api !== "openai-codex-responses";
}

function discoveryRequest(baseUrl: string, api: CustomProviderApi, apiKey?: string, bearerFallback = false) {
  if (!supportsApiModelDiscovery(api)) {
    throw new Error("此协议不支持通过 API Key 获取实时模型列表，请手动添加模型。");
  }
  let url = `${baseUrl}/models`;
  if (api === "anthropic-messages" || api === "mistral-conversations") {
    url = `${baseUrl.replace(/\/v1$/, "")}/v1/models`;
  } else if (api === "google-vertex") {
    url = `${baseUrl.replace(/\/v\d+(?:beta\d*)?(?:\/projects\/[^/]+\/locations\/[^/]+)?$/, "")}/v1beta1/publishers/google/models`;
  } else if (api === "azure-openai-responses") {
    url = `${baseUrl.replace(/\/openai\/v1$/, "")}/openai/v1/models`;
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Cache-Control": "no-cache, no-store",
  };
  if (api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  if (apiKey) {
    if (api === "anthropic-messages" && !bearerFallback) {
      headers["x-api-key"] = apiKey;
    } else if (api === "google-generative-ai" || api === "google-vertex") {
      headers["x-goog-api-key"] = apiKey;
    } else if (api === "azure-openai-responses") {
      headers["api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  const target = new URL(url);
  if (api === "google-vertex") {
    target.searchParams.set("listAllVersions", "true");
    target.searchParams.set("view", "PUBLISHER_MODEL_VIEW_FULL");
    target.searchParams.set("pageSize", "100");
  }
  return { url: target, headers };
}

function responsePage(json: unknown, api: CustomProviderApi): { models: RawDiscoveredModel[]; body: Record<string, unknown> } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("模型列表响应格式无效。");
  }
  const body = json as Record<string, unknown>;
  if (body.error) throw new Error("供应商返回了模型列表错误。");
  const list = Array.isArray(body.data) ? body.data
    : Array.isArray(body.models) ? body.models
      : Array.isArray(body.publisherModels) ? body.publisherModels : undefined;
  if (!list) throw new Error("模型列表响应缺少 data、models 或 publisherModels 数组。");
  if (list.length > MAX_MODELS) throw new Error("模型列表超过获取上限，请缩小供应商返回范围。");
  const models = list.flatMap((entry): RawDiscoveredModel[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("模型列表响应包含无效的模型条目。");
    }
    const item = entry as Record<string, unknown>;
    const resourceName = typeof item.name === "string" ? item.name.trim() : "";
    const id = typeof item.id === "string" ? item.id.trim()
      : resourceName.replace(/^(?:publishers\/[^/]+\/)?models\//, "");
    if (!id) throw new Error("模型列表响应包含无效的模型 ID。");
    if (/(?:^|[/-])(?:text-embedding|gemini-embedding|embedding-\d|embed-)(?:[-.@\w]*)$/i.test(id)) return [];
    const inferredById = inferModelPurpose({ id });
    if (api === "google-generative-ai" && Array.isArray(item.supportedGenerationMethods) &&
        inferredById === "chat" && !item.supportedGenerationMethods.some((method) =>
          method === "generateContent" || method === "streamGenerateContent" || method === "generateImages" || method === "generateImage" || method === "bidiGenerateContent")) return [];
    const name = typeof item.display_name === "string" && item.display_name.trim() ? item.display_name.trim()
      : typeof item.displayName === "string" && item.displayName.trim() ? item.displayName.trim()
        : resourceName && !/^(?:publishers\/[^/]+\/)?models\//.test(resourceName) ? resourceName : undefined;
    const topProvider = item.top_provider && typeof item.top_provider === "object"
      ? item.top_provider as Record<string, unknown> : undefined;
    const architecture = item.architecture && typeof item.architecture === "object"
      ? item.architecture as Record<string, unknown> : undefined;
    const declaredOutput = item.output_modalities ?? item.outputModalities ?? architecture?.output_modalities;
    const outputModalities = Array.isArray(declaredOutput)
      ? [...new Set(declaredOutput.filter((value): value is ModelModality =>
        typeof value === "string" && ["text", "image", "audio", "video", "pdf"].includes(value)))]
      : undefined;
    const imageMethod = Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.some((method) => method === "generateImages" || method === "generateImage");
    const liveMethod = Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes("bidiGenerateContent");
    const explicitPurpose = typeof item.purpose === "string" && (MODEL_PURPOSES as readonly string[]).includes(item.purpose) ? item.purpose as ModelPurpose : undefined;
    const inferred = inferModelPurpose({ id, ...(explicitPurpose ? { purpose: explicitPurpose } : {}), ...(outputModalities?.length ? { outputModalities } : {}) });
    const purpose: ModelPurpose | undefined = imageMethod || isImageGenerationModel({ id, ...(outputModalities?.length ? { outputModalities } : {}) })
      ? "image"
      : liveMethod && inferred === "chat"
        ? "live"
        : inferred !== "chat"
          ? inferred
          : undefined;
    const cw = item.context_window ?? item.context_length ?? item.inputTokenLimit ?? topProvider?.context_length;
    const mt = item.max_tokens ?? item.max_output_tokens ?? item.outputTokenLimit ?? topProvider?.max_completion_tokens;
    return [{
      id,
      ...(purpose ? { purpose } : {}),
      ...(outputModalities?.length ? { outputModalities } : {}),
      ...(name ? { name } : {}),
      ...(typeof cw === "number" && Number.isFinite(cw) && cw > 0 ? { contextWindow: Math.round(cw) } : {}),
      ...(typeof mt === "number" && Number.isFinite(mt) && mt > 0 ? { maxTokens: Math.round(mt) } : {}),
    }];
  });
  return { models, body };
}

function nextPageUrl(current: URL, body: Record<string, unknown>, models: RawDiscoveredModel[], api: CustomProviderApi): URL | undefined {
  const token = body.nextPageToken;
  if (token !== undefined && typeof token !== "string") throw new Error("模型列表分页标记无效。");
  if (typeof token === "string" && token) {
    const next = new URL(current);
    next.searchParams.set("pageToken", token);
    return next;
  }
  if (body.has_more !== undefined && typeof body.has_more !== "boolean") throw new Error("模型列表分页标记无效。");
  if (body.has_more === true) {
    const lastId = typeof body.last_id === "string" && body.last_id.trim() ? body.last_id.trim() : models.at(-1)?.id;
    if (!lastId) throw new Error("模型列表缺少下一页游标。");
    const next = new URL(current);
    next.searchParams.set(api === "anthropic-messages" ? "after_id" : "after", lastId);
    return next;
  }
  if (typeof body.nextLink === "string" && body.nextLink) return new URL(body.nextLink, current);
  if (body.nextLink !== undefined && body.nextLink !== null && typeof body.nextLink !== "string") {
    throw new Error("模型列表下一页地址无效。");
  }
  return undefined;
}

/** Return only complete, fresh upstream results; never substitute a bundled catalog. */
export async function fetchLiveProviderModels(options: {
  baseUrl: string;
  api: CustomProviderApi;
  apiKey?: string;
  signal: AbortSignal;
}): Promise<RawDiscoveredModel[]> {
  try {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
    if (options.api === "google-vertex" && isOfficialVertexBaseUrl(options.baseUrl)) {
      return await fetchVertexPublicModels((url, pageSignal) => fetchModelListPage(url, {
        Accept: "text/html",
        "Cache-Control": "no-cache, no-store",
      }, pageSignal), signal);
    }
    const primary = discoveryRequest(options.baseUrl, options.api, options.apiKey);
    if (primary.url.username || primary.url.password) throw new Error("BaseURL 不能包含用户名或密码。");
    const origin = primary.url.origin;
    let current: URL | undefined = primary.url;
    let headers = primary.headers;
    const visited = new Set<string>();
    const models = new Map<string, RawDiscoveredModel>();
    while (current) {
      if (visited.size >= MAX_PAGES) throw new Error("模型列表页数超过获取上限，未返回不完整结果。");
      if (current.origin !== origin || current.username || current.password) {
        throw new Error("模型列表分页地址更换了服务来源，已停止请求。");
      }
      if (visited.has(current.href)) throw new Error("模型列表分页游标重复，未返回不完整结果。");
      visited.add(current.href);
      let response = await fetchModelListPage(current, headers, signal);
      if (response.status === 401 && options.api === "anthropic-messages" && options.apiKey &&
          primary.url.hostname !== "api.anthropic.com" && !headers.Authorization) {
        headers = discoveryRequest(options.baseUrl, options.api, options.apiKey, true).headers;
        response = await fetchModelListPage(current, headers, signal);
      }
      if (!response.ok) {
        if (options.api === "google-vertex" && options.apiKey && (response.status === 401 || response.status === 403)) {
          let body: { error?: { message?: unknown; details?: Array<{ reason?: unknown }> } } | undefined;
          try { body = await response.json() as typeof body; }
          catch { /* A non-JSON error still retains its HTTP failure below. */ }
          if (typeof body?.error?.message === "string" && /API keys are not supported/i.test(body.error.message) ||
              Array.isArray(body?.error?.details) && body.error.details.some((detail) => detail?.reason === "CREDENTIALS_MISSING")) {
            throw new Error(`当前 API Key 不支持 Vertex AI 模型列表接口 (HTTP ${response.status})，可手动添加模型后测试调用。`);
          }
        }
        const detail = response.status === 401 || response.status === 403 ? "认证失败" : "获取模型列表失败";
        const vertex = options.api === "google-vertex"
          ? "。当前凭据可能不支持 Vertex AI 模型列表接口，可手动添加模型。" : "";
        throw new Error(`${detail} (HTTP ${response.status})${vertex}`);
      }
      const page = responsePage(await response.json(), options.api);
      for (const model of page.models) models.set(model.id, model);
      if (models.size > MAX_MODELS) throw new Error("模型列表超过获取上限，未返回不完整结果。");
      current = nextPageUrl(current, page.body, page.models, options.api);
    }
    return [...models.values()];
  } catch (error) {
    throw new Error(redactSensitiveText(error instanceof Error ? error.message : String(error), options.apiKey ? [options.apiKey] : []));
  }
}
