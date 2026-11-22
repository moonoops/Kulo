import { randomBytes } from "node:crypto";
import type { Tool } from "@earendil-works/pi-mcp";
import type {
  ComposioConnectedAccountView,
  ConnectionFields,
  ConnectionRecordView,
  ConnectionUseOperation,
} from "@kulo/protocol";
import { createMcpFetch } from "./mcp-fetch.js";

export const COMPOSIO_PRESET_ID = "composio";
export const COMPOSIO_API_ORIGIN = "https://backend.composio.dev";
export const COMPOSIO_API_BASE = `${COMPOSIO_API_ORIGIN}/api/v3.1`;
export const COMPOSIO_MAX_ALLOWED_TOOLKITS = 32;

const COMPOSIO_USER_ID_RE = /^kulo_[a-f0-9]{16,64}$/;
const COMPOSIO_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const COMPOSIO_TOOLKIT_SLUG_RE = /^_?[a-z0-9][a-z0-9_]{0,62}$/;
const COMPOSIO_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const COMPOSIO_TOOL_SLUG_RE = /^_?[A-Z0-9]+_[A-Z0-9_]+$/;

const COMPOSIO_TOOLKIT_ALIASES: Readonly<Record<string, string>> = {
  x: "twitter",
  google_calendar: "googlecalendar",
  google_drive: "googledrive",
  google_sheets: "googlesheets",
  google_docs: "googledocs",
  google_mail: "gmail",
};

export const ALLOWED_COMPOSIO_META_TOOLS: ReadonlySet<string> = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
]);

function composioError(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

export function isComposioHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "composio.dev" || lower.endsWith(".composio.dev");
}

export function isTrustedComposioMcpUrl(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  return url.protocol === "https:" && isComposioHost(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
}

export function isTrustedComposioRedirectUrl(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  return url.protocol === "https:" && isComposioHost(url.hostname) && !url.username && !url.password;
}

export function generateComposioUserId(): string {
  return `kulo_${randomBytes(16).toString("hex")}`;
}

export function normalizeComposioToolkitSlug(raw: unknown): string {
  if (typeof raw !== "string") throw composioError("Composio 应用标识无效。", "connection_composio_invalid_toolkit", 400);
  const lower = raw.trim().toLowerCase().replace(/-/g, "_");
  const canonical = COMPOSIO_TOOLKIT_ALIASES[lower] ?? lower;
  if (!COMPOSIO_TOOLKIT_SLUG_RE.test(canonical)) {
    throw composioError(`Composio 应用标识「${raw.slice(0, 40)}」无效。`, "connection_composio_invalid_toolkit", 400);
  }
  return canonical;
}

export function normalizeComposioAllowedToolkits(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > COMPOSIO_MAX_ALLOWED_TOOLKITS) {
    throw composioError(`Composio 允许应用列表最多 ${COMPOSIO_MAX_ALLOWED_TOOLKITS} 项。`, "connection_composio_invalid_toolkit", 400);
  }
  const normalized = [...new Set(raw.map((item) => normalizeComposioToolkitSlug(item)))];
  return normalized.length ? normalized : undefined;
}

export function validateComposioMetadataFields(input: ConnectionFields, url: URL, authMode: string, headerName?: string): {
  mcpComposioUserId: string;
  mcpComposioSessionId: string;
  mcpAllowedToolkits?: string[];
} {
  if (!isTrustedComposioMcpUrl(url.href)) {
    throw composioError("Composio 连接仅允许指向官方 composio.dev HTTPS 端点。", "connection_composio_untrusted_url", 400);
  }
  if (authMode !== "header" || headerName?.toLowerCase() !== "x-api-key") {
    throw composioError("Composio 连接必须使用 x-api-key 请求头认证。", "connection_composio_invalid_auth", 400);
  }
  if (typeof input.mcpComposioUserId !== "string" || !COMPOSIO_USER_ID_RE.test(input.mcpComposioUserId)) {
    throw composioError("Composio 连接缺少有效的实例用户标识，请通过 Composio 入口配置。", "connection_composio_invalid_session", 400);
  }
  if (typeof input.mcpComposioSessionId !== "string" || !COMPOSIO_SESSION_ID_RE.test(input.mcpComposioSessionId)) {
    throw composioError("Composio 连接缺少有效的 Session 标识，请通过 Composio 入口配置。", "connection_composio_invalid_session", 400);
  }
  const mcpAllowedToolkits = normalizeComposioAllowedToolkits(input.mcpAllowedToolkits);
  return {
    mcpComposioUserId: input.mcpComposioUserId,
    mcpComposioSessionId: input.mcpComposioSessionId,
    ...(mcpAllowedToolkits ? { mcpAllowedToolkits } : {}),
  };
}

export function composioBinding(fields: Pick<ConnectionFields, "mcpComposioUserId">): string {
  return JSON.stringify(["mcp", "composio", COMPOSIO_API_ORIGIN, fields.mcpComposioUserId ?? "", "x-api-key"]);
}

export function isComposioSessionMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? Number((error as { status?: unknown }).status) : NaN;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 404) return true;
  return /\b404\b|session[\s_-]*not[\s_-]*found|tool_router.*not found/i.test(message);
}

interface ComposioFetchContext {
  baseFetch?: typeof fetch;
  redact?: (text: string) => string;
  signal?: AbortSignal;
}

async function readComposioError(res: Response, fallback: string, redact?: (text: string) => string): Promise<string> {
  const raw = await res.text().catch(() => "");
  let detail = fallback;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } | string };
    const candidate = parsed?.message ?? (typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message);
    if (typeof candidate === "string" && candidate.trim()) detail = candidate.trim().slice(0, 240);
  } catch {
    if (raw.trim()) detail = raw.trim().slice(0, 240);
  }
  return redact ? redact(detail) : detail;
}

export interface ComposioSessionCreated {
  sessionId: string;
  mcpUrl: string;
  userId: string;
}

export async function createComposioSession(
  apiKey: string,
  options: { userId: string; allowedToolkits?: readonly string[] } & ComposioFetchContext,
): Promise<ComposioSessionCreated> {
  const fetcher = createMcpFetch({ allowPrivateNetwork: false, timeoutMs: 20_000, baseFetch: options.baseFetch });
  const body: Record<string, unknown> = {
    user_id: options.userId,
    workbench: { enable: false },
    proxy_execute: { enable: false },
    manage_connections: { enable: false },
    multi_account: { enable: false },
  };
  if (options.allowedToolkits?.length) {
    body.toolkits = { enable: [...options.allowedToolkits] };
  }
  const res = await fetcher(`${COMPOSIO_API_BASE}/tool_router/session`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    const msg = await readComposioError(res, `Composio 创建会话失败（HTTP ${res.status}）`, options.redact);
    const status = res.status === 401 || res.status === 403 ? 401 : res.status >= 400 && res.status < 500 ? 400 : 502;
    throw composioError(msg, "connection_composio_session_failed", status);
  }
  const data = (await res.json()) as { session_id?: unknown; mcp?: { url?: unknown } };
  const sessionId = typeof data?.session_id === "string" ? data.session_id.trim() : "";
  const mcpUrl = typeof data?.mcp?.url === "string" ? data.mcp.url.trim() : "";
  if (!COMPOSIO_SESSION_ID_RE.test(sessionId) || !isTrustedComposioMcpUrl(mcpUrl)) {
    throw composioError("Composio 返回了不可信或无效的 MCP 会话地址。", "connection_composio_untrusted_url", 502);
  }
  return { sessionId, mcpUrl, userId: options.userId };
}

export async function listComposioAccounts(
  apiKey: string,
  userId: string,
  options: ComposioFetchContext = {},
): Promise<ComposioConnectedAccountView[]> {
  const fetcher = createMcpFetch({ allowPrivateNetwork: false, timeoutMs: 15_000, baseFetch: options.baseFetch });
  const params = new URLSearchParams({
    user_ids: userId,
    limit: "50",
    order_by: "updated_at",
    order_direction: "desc",
  });
  const res = await fetcher(`${COMPOSIO_API_BASE}/connected_accounts?${params}`, {
    method: "GET",
    headers: { "x-api-key": apiKey },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    const msg = await readComposioError(res, `读取 Composio 已连应用失败（HTTP ${res.status}）`, options.redact);
    throw composioError(msg, "connection_composio_accounts_failed", res.status === 401 || res.status === 403 ? 401 : 502);
  }
  const data = (await res.json()) as { items?: unknown[] };
  const items = Array.isArray(data?.items) ? data.items : [];
  const results: ComposioConnectedAccountView[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { id?: unknown; status?: unknown; updated_at?: unknown; user_id?: unknown; toolkit?: { slug?: unknown } };
    if (typeof item.user_id === "string" && item.user_id !== userId) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const toolkit = typeof item.toolkit?.slug === "string" ? item.toolkit.slug.trim().toLowerCase() : "";
    const status = typeof item.status === "string" ? item.status.trim().toUpperCase() : "UNKNOWN";
    if (!COMPOSIO_ACCOUNT_ID_RE.test(id) || !toolkit) continue;
    results.push({
      id,
      toolkit,
      status,
      ...(typeof item.updated_at === "string" ? { updatedAt: item.updated_at } : {}),
    });
  }
  return results;
}

export async function createComposioConnectLink(
  apiKey: string,
  sessionId: string,
  toolkitSlug: string,
  options: { allowedToolkits?: readonly string[] } & ComposioFetchContext = {},
): Promise<string> {
  const canonical = normalizeComposioToolkitSlug(toolkitSlug);
  if (options.allowedToolkits?.length && !options.allowedToolkits.includes(canonical)) {
    throw composioError(`应用「${canonical}」不在当前连接允许的应用范围内。`, "connection_composio_toolkit_denied", 403);
  }
  const fetcher = createMcpFetch({ allowPrivateNetwork: false, timeoutMs: 20_000, baseFetch: options.baseFetch });
  const res = await fetcher(`${COMPOSIO_API_BASE}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ toolkit: canonical }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    const msg = await readComposioError(res, `生成 Composio 授权链接失败（HTTP ${res.status}）`, options.redact);
    const code = res.status === 404 ? "connection_composio_session_expired" : "connection_composio_link_failed";
    throw composioError(msg, code, res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 401 : 502);
  }
  const data = (await res.json()) as { redirect_url?: unknown };
  const redirectUrl = typeof data?.redirect_url === "string" ? data.redirect_url.trim() : "";
  if (!isTrustedComposioRedirectUrl(redirectUrl)) {
    throw composioError("Composio 返回了不可信的授权跳转地址。", "connection_composio_untrusted_url", 502);
  }
  return redirectUrl;
}

export async function disconnectComposioAccount(
  apiKey: string,
  userId: string,
  accountId: string,
  options: ComposioFetchContext = {},
): Promise<void> {
  if (!COMPOSIO_ACCOUNT_ID_RE.test(accountId)) {
    throw composioError("Composio 账号标识无效。", "connection_composio_invalid_account", 400);
  }
  // Verify ownership under this installation's user_id before revoking.
  const owned = await listComposioAccounts(apiKey, userId, options);
  if (!owned.some((acc) => acc.id === accountId)) {
    throw composioError("未在当前连接下找到该授权账号。", "connection_composio_account_not_found", 404);
  }
  const fetcher = createMcpFetch({ allowPrivateNetwork: false, timeoutMs: 20_000, baseFetch: options.baseFetch });
  const res = await fetcher(
    `${COMPOSIO_API_BASE}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    {
      method: "DELETE",
      headers: { "x-api-key": apiKey },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!res.ok && res.status !== 404) {
    const msg = await readComposioError(res, `断开 Composio 授权失败（HTTP ${res.status}）`, options.redact);
    throw composioError(msg, "connection_composio_disconnect_failed", res.status === 401 || res.status === 403 ? 401 : 502);
  }
}

export function filterComposioTools(record: Pick<ConnectionRecordView, "mcpPresetId">, tools: readonly Tool[]): Tool[] {
  if (record.mcpPresetId !== COMPOSIO_PRESET_ID) return [...tools];
  return tools.filter((tool) => !tool.name.startsWith("COMPOSIO_") || ALLOWED_COMPOSIO_META_TOOLS.has(tool.name));
}

function toolSlugMatchesAllowed(toolSlug: string, allowedToolkits: readonly string[]): boolean {
  const upperAllowed = new Set(allowedToolkits.map((slug) => slug.toUpperCase()));
  // Extract prefix candidates: exact matching normalized slug + "_" prefix
  for (const slug of upperAllowed) {
    if (toolSlug.startsWith(`${slug}_`)) return true;
  }
  return false;
}

export interface ComposioCallPolicyResult {
  skipOutwardAction?: boolean;
  forceOutwardLabel?: string;
}

export function evaluateComposioCall(
  record: Pick<ConnectionRecordView, "name" | "mcpPresetId" | "mcpAllowedToolkits">,
  operation: Extract<ConnectionUseOperation, { kind: "mcp" }>,
  options: { readOnly?: boolean },
): ComposioCallPolicyResult {
  if (record.mcpPresetId !== COMPOSIO_PRESET_ID || operation.action !== "call_tool") return {};
  if (options.readOnly) {
    throw composioError("只读任务无法执行 Composio 聚合工具，请由主智能体或非只读任务执行。", "connection_read_only", 403);
  }
  const tool = operation.tool;
  const allowed = record.mcpAllowedToolkits;

  if (tool.startsWith("COMPOSIO_") && !ALLOWED_COMPOSIO_META_TOOLS.has(tool)) {
    throw composioError(`出于安全策略，已禁用 Composio 元工具「${tool}」。`, "connection_mcp_tool_blocked", 403);
  }

  if (tool === "COMPOSIO_SEARCH_TOOLS" || tool === "COMPOSIO_GET_TOOL_SCHEMAS") {
    if (allowed?.length && operation.arguments && typeof operation.arguments === "object") {
      const rawToolkits = (operation.arguments as Record<string, unknown>).toolkits;
      const requested = Array.isArray(rawToolkits)
        ? rawToolkits.filter((v): v is string => typeof v === "string")
        : typeof rawToolkits === "string"
          ? rawToolkits.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      for (const reqSlug of requested) {
        const canonical = normalizeComposioToolkitSlug(reqSlug);
        if (!allowed.includes(canonical)) {
          throw composioError(`应用「${canonical}」不在当前 Composio 连接允许范围内。`, "connection_composio_toolkit_denied", 403);
        }
      }
    }
    return { skipOutwardAction: true };
  }

  if (tool === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const args = operation.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw composioError("COMPOSIO_MULTI_EXECUTE_TOOL 必须提供包含 tools 数组的参数对象。", "connection_composio_invalid_args", 400);
    }
    const keys = Object.keys(args);
    if (keys.some((key) => key !== "tools" && key !== "session_id")) {
      throw composioError("COMPOSIO_MULTI_EXECUTE_TOOL 仅允许传入 tools（与可选 session_id）参数。", "connection_composio_invalid_args", 403);
    }
    const tools = (args as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0 || tools.length > 50) {
      throw composioError("COMPOSIO_MULTI_EXECUTE_TOOL 的 tools 必须包含 1 到 50 项工具调用。", "connection_composio_invalid_args", 400);
    }
    const slugs: string[] = [];
    for (const item of tools) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw composioError("COMPOSIO_MULTI_EXECUTE_TOOL 的工具项格式无效。", "connection_composio_invalid_args", 400);
      }
      const slug = (item as { tool_slug?: unknown }).tool_slug;
      if (typeof slug !== "string" || !COMPOSIO_TOOL_SLUG_RE.test(slug)) {
        throw composioError("COMPOSIO_MULTI_EXECUTE_TOOL 缺少合法的大写 tool_slug。", "connection_composio_invalid_args", 400);
      }
      if (allowed?.length && !toolSlugMatchesAllowed(slug, allowed)) {
        throw composioError(`工具「${slug}」不在当前 Composio 连接允许的应用范围内。`, "connection_composio_toolkit_denied", 403);
      }
      slugs.push(slug);
    }
    return { forceOutwardLabel: `mcp:${record.name}:${slugs.slice(0, 3).join(",")}` };
  }

  if (allowed?.length && !toolSlugMatchesAllowed(tool, allowed)) {
    throw composioError(`工具「${tool}」不在当前 Composio 连接允许的应用范围内。`, "connection_composio_toolkit_denied", 403);
  }
  return {};
}
