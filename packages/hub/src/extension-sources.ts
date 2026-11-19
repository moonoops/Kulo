import { readWebResponseText, serviceApiFetch } from "./web-content.js";

export type ExtensionSourceRoute = "builtin" | "chord" | "mcp" | "coding-agent" | "library" | "unknown";
export interface ExtensionSourceAnalysis {
  sourceUrl: string;
  name: string;
  route: ExtensionSourceRoute;
  compatibility: "ready" | "needs_adapter";
  installable: boolean;
  extensionId?: string;
  version?: string;
  description?: string;
  license?: string;
  reasons: string[];
}

export class ExtensionSourceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ExtensionSourceError"; }
}

interface Source { kind: "github" | "npm"; url: string; name: string; owner?: string }
const BUILTIN_REPOSITORIES = new Set(["ranxianglei/billion-context", "ranxianglei/billion-context-pi", "ranxianglei/acp-kernel"]);
const BUILTIN_PACKAGES = new Set(["billion-context", "billion-context-pi", "acp-kernel"]);
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const invalidSource = (): never => { throw new ExtensionSourceError(400, "invalid_extension_source", "请提供不含凭据的 GitHub 仓库或 npm 包链接。"); };

function sourceValue(raw: string): Source {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw.trim())) return invalidSource();
  const value = raw.trim();
  if (value.startsWith("npm:")) {
    const name = value.slice(4);
    if (!npmName.test(name)) return invalidSource();
    return { kind: "npm", name, url: `https://www.npmjs.com/package/${name}` };
  }
  let url: URL;
  try { url = new URL(value); } catch { return invalidSource(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return invalidSource();
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (url.hostname === "github.com" && parts.length >= 2 &&
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(parts[0]!) && /^[a-zA-Z0-9_.-]{1,150}$/.test(parts[1]!)) {
    const owner = parts[0]!, name = parts[1]!.replace(/\.git$/, "");
    if (!name || name === "." || name === ".." || parts.length > 2 && parts[2] !== "tree" && parts[2] !== "blob") return invalidSource();
    return { kind: "github", owner, name, url: `https://github.com/${owner}/${name}` };
  }
  if (["npmjs.com", "www.npmjs.com"].includes(url.hostname) && parts.shift() === "package") {
    const name = parts.join("/");
    if (npmName.test(name)) return { kind: "npm", name, url: `https://www.npmjs.com/package/${name}` };
  }
  return invalidSource();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function boundedText(value: unknown, limit = 1000): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}
async function readJson(url: string, options: { signal?: AbortSignal; fetch?: typeof fetch }, optional = false): Promise<Record<string, unknown> | undefined> {
  const target = new URL(url);
  if (target.protocol !== "https:" || !["api.github.com", "registry.npmjs.org"].includes(target.hostname) || target.port || target.username || target.password || target.search || target.hash) return invalidSource();
  const timeout = AbortSignal.timeout(20_000), signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const init: RequestInit = { method: "GET", signal, redirect: "error", credentials: "omit", headers: { Accept: "application/json", "User-Agent": "Moco-Agent/0.3" } };
  // These fixed public service APIs can use the configured proxy without open-web DNS pinning.
  const response = options.fetch ? await options.fetch(target, init) : await serviceApiFetch(target, init, { timeoutMs: 20_000, maxResponseBytes: 256_000 });
  if (response.status === 404 && optional && !response.redirected) { await response.body?.cancel(); return undefined; }
  if (!response.ok || response.redirected) { await response.body?.cancel(); throw new ExtensionSourceError(502, "extension_source_unavailable", "无法读取项目元数据，请检查来源或稍后重试。"); }
  const text = await readWebResponseText(response, 256_000);
  try { const value = object(JSON.parse(text)); if (!value) throw new Error("not an object"); return value; }
  catch { throw new ExtensionSourceError(502, "extension_source_invalid", "项目元数据格式无效。"); }
}

function routeFor(manifest: Record<string, unknown> | undefined, description: string): ExtensionSourceRoute {
  if (!manifest) return /\bmodel context protocol\b|\bmcp\s+server\b/i.test(description) ? "mcp" : "unknown";
  if (object(manifest.chord)) return "chord";
  if (object(manifest.pi)?.extensions !== undefined) return "coding-agent";
  const dependencies = { ...object(manifest.dependencies), ...object(manifest.peerDependencies) };
  if (Object.keys(dependencies).some((name) => name.includes("modelcontextprotocol")) || /\bmcp\s+server\b/i.test(description)) return "mcp";
  return "library";
}

/** Classifies public metadata only; a repository never supplies executable installation instructions. */
export async function analyzeExtensionSource(raw: string, options: { signal?: AbortSignal; fetch?: typeof fetch; builtinVersion: string }): Promise<ExtensionSourceAnalysis> {
  const source = sourceValue(raw);
  const builtin = source.kind === "github" ? BUILTIN_REPOSITORIES.has(`${source.owner}/${source.name}`.toLowerCase()) : BUILTIN_PACKAGES.has(source.name);
  if (builtin) return { sourceUrl: source.url, name: "Billion Context 上下文压缩", route: "builtin", compatibility: "ready", installable: true,
    extensionId: "billion-context", version: options.builtinVersion,
    reasons: ["使用已验证的 Moco 内核适配包，保留 Pi Durable 会话和压缩提交机制。", "安装后保持关闭，可在“其他”中启用。"] };
  let manifest: Record<string, unknown> | undefined, metadata: Record<string, unknown> | undefined;
  try {
    if (source.kind === "npm") {
      metadata = manifest = await readJson(`https://registry.npmjs.org/${encodeURIComponent(source.name)}/latest`, options);
    } else {
      const repository = `https://api.github.com/repos/${source.owner}/${source.name}`;
      metadata = await readJson(repository, options);
      const entry = await readJson(`${repository}/contents/package.json`, options, true);
      if (entry?.encoding === "base64" && typeof entry.content === "string") {
        try { manifest = object(JSON.parse(Buffer.from(entry.content, "base64").toString("utf8"))); }
        catch { throw new ExtensionSourceError(502, "extension_source_invalid", "项目 package.json 格式无效。"); }
      }
    }
  } catch (error) {
    if (error instanceof ExtensionSourceError) throw error;
    if (options.signal?.aborted) throw error;
    throw new ExtensionSourceError(502, "extension_source_unavailable", "项目分析未完成，请检查来源或稍后重试。");
  }
  const description = boundedText(manifest?.description ?? metadata?.description), route = routeFor(manifest, description ?? "");
  const reasons: Record<ExtensionSourceRoute, string> = {
    builtin: "已有受管适配包。", chord: "项目采用 Chord 插件入口，需要验证它使用的宿主 API 和权限。",
    mcp: "项目提供 MCP 接口，可参考官方 pi-mcp 接入，需要验证服务启动和工具权限。",
    "coding-agent": "项目使用 Coding Agent ExtensionAPI，需要核对兼容层支持的事件和恢复语义。",
    library: "项目是普通代码包，需要封装受管插件入口并验证生命周期。", unknown: "尚未从公开元数据确认可装载入口，需要进一步检查项目接口。",
  };
  const license = boundedText(manifest?.license ?? object(metadata?.license)?.spdx_id, 160);
  return { sourceUrl: source.url, name: boundedText(manifest?.name ?? metadata?.name, 160) ?? source.name,
    route, compatibility: "needs_adapter", installable: false,
    ...(boundedText(manifest?.version, 80) ? { version: boundedText(manifest?.version, 80) } : {}),
    ...(description ? { description } : {}), ...(license ? { license } : {}),
    reasons: [reasons[route], ...(metadata?.archived === true ? ["上游仓库已归档，需要先评估维护来源。"] : []), "当前未登记已验证的 Moco 适配包，不执行仓库脚本或安装。"] };
}
