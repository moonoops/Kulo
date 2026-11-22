export interface VertexProjectConfig {
  vertexProject: string;
  vertexLocation: string;
}

export function isOfficialVertexBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      (url.hostname === "aiplatform.googleapis.com"
        || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-aiplatform\.googleapis\.com$/.test(url.hostname)
        || /^aiplatform\.(?:us|eu)\.rep\.googleapis\.com$/.test(url.hostname));
  } catch {
    return false;
  }
}

export class VertexConfigError extends Error {
  readonly status = 400;
}

export function normalizeVertexConfig(input: { vertexProject?: unknown; vertexLocation?: unknown }): VertexProjectConfig | undefined {
  const { vertexProject, vertexLocation } = input;
  if (vertexProject === undefined && vertexLocation === undefined) return undefined;
  if (typeof vertexProject === "string" && typeof vertexLocation === "string" && !vertexProject.trim() && !vertexLocation.trim()) return undefined;
  if (typeof vertexProject !== "string" || typeof vertexLocation !== "string" || !vertexProject.trim() || !vertexLocation.trim()) {
    throw new VertexConfigError("请同时填写 Vertex AI 项目 ID 或编号与区域。");
  }
  const project = vertexProject.trim();
  const location = vertexLocation.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) && !/^[1-9]\d{0,19}$/.test(project)) {
    throw new VertexConfigError("Vertex AI 项目 ID 应为 6–30 位小写字母、数字或短横线，也可以填写项目编号。");
  }
  if (location.length > 63 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(location)) {
    throw new VertexConfigError("Vertex AI 区域格式无效，请填写 global 或有效区域名称。");
  }
  return { vertexProject: project, vertexLocation: location };
}

/** Keep the configured origin stable while routing native Vertex calls to a project. */
export function buildVertexModelBaseUrl(baseUrl: string, input: { vertexProject?: unknown; vertexLocation?: unknown }): string {
  const config = normalizeVertexConfig(input);
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!config) return base;
  let url: URL;
  try { url = new URL(base); }
  catch { throw new VertexConfigError("Vertex AI 接口地址格式无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new VertexConfigError("Vertex AI 接口地址须为不含账号、查询参数或片段的 HTTP 地址。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const projectRoute = path.match(/^(.*)\/v\d+(?:beta\d*)?\/projects\/[^/]+\/locations\/[^/]+$/);
  const root = projectRoute ? projectRoute[1]! : path.replace(/\/v\d+(?:beta\d*)?$/, "");
  url.pathname = `${root}/v1/projects/${config.vertexProject}/locations/${config.vertexLocation}`;
  return url.toString().replace(/\/+$/, "");
}

/** Resolve Vertex AI image base URL, preserving origin and normalizing bare or legacy `/v1beta` paths to `/v1`. */
export function resolveVertexImageBaseUrl(baseUrl: string, input?: { vertexProject?: unknown; vertexLocation?: unknown }): string {
  const config = input ? normalizeVertexConfig(input) : undefined;
  if (config) return buildVertexModelBaseUrl(baseUrl, config);
  const base = baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(base); }
  catch { throw new VertexConfigError("Vertex AI 接口地址格式无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new VertexConfigError("Vertex AI 接口地址须为不含账号、查询参数或片段的 HTTP 地址。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (isOfficialVertexBaseUrl(base) && /\/v1beta$/i.test(path)) {
    url.pathname = path.replace(/\/v1beta$/i, "/v1");
  } else if (!path.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part))) {
    url.pathname = `${path}/v1`;
  }
  return url.toString().replace(/\/+$/, "");
}

export function cleanGoogleImageModelId(modelId: string): string {
  return modelId.trim().replace(/^(?:publishers\/google\/models\/|models\/|google\/)/, "");
}
