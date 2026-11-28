/**
 * Stage 4 P2-2: Read-only inline MCP Apps prototype protocol (aligned with MCP Apps 2026-01-26).
 *
 * Strictly forbids `*token` / `SECRET_FIELD` property names on durable or transport records;
 * view lifecycles use opaque `viewId` and `sessionHandle` identifiers only.
 */

export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

/** Hard ceiling for decoded HTML text (2.5 MiB), staying inside the 4 MiB JSON-RPC transport limit with base64 overhead. */
export const MCP_APP_MAX_HTML_BYTES = Math.floor(2.5 * 1024 * 1024);

/** Hard ceiling for filtered structuredContent payload delivered to an active View. */
export const MCP_APP_MAX_STRUCTURED_BYTES = 128 * 1024;

/** Maximum concurrent read-only tools/call requests allowed per active MCP App View. */
export const MCP_APP_MAX_CONCURRENT_CALLS_PER_VIEW = 4;

export type McpAppToolVisibility = "model" | "app";

export interface McpAppToolUiMeta {
  resourceUri?: string;
  visibility?: McpAppToolVisibility[];
}

export interface McpAppResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
}

export interface McpAppInlineMeta {
  connectionId: string;
  connectionName: string;
  connectionRevision: number;
  toolName: string;
  resourceUri: string;
  title?: string;
  /** Opaque in-memory Hub reference for the redacted/filtered structuredContent snapshot. */
  resultRef?: string;
  readOnly: true;
}

export interface McpAppViewToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpAppSandboxConfig {
  enabled: boolean;
  sandboxOrigin?: string;
  sandboxUrl?: string;
  protocolVersion: string;
  maxHtmlBytes: number;
  maxConcurrentCalls: number;
}

export interface McpAppCreateViewRequest {
  connectionId: string;
  resourceUri: string;
  toolName: string;
  title?: string;
  resultRef?: string;
  expectedRevision?: number;
}

export interface McpAppViewSession {
  viewId: string;
  sessionHandle: string;
  connectionId: string;
  connectionName: string;
  connectionRevision: number;
  resourceUri: string;
  toolName: string;
  title?: string;
  readOnly: true;
  protocolVersion: string;
  sandboxOrigin: string;
  sandboxUrl: string;
  initialToolResult?: McpAppViewToolResult;
  createdAt: number;
  expiresAt: number;
}

export interface McpAppReadResourceRequest {
  viewId: string;
  uri?: string;
}

export interface McpAppResourcePayload {
  viewId: string;
  uri: string;
  mimeType: typeof MCP_APP_RESOURCE_MIME_TYPE;
  html: string;
  byteLength: number;
  csp?: McpAppResourceCsp;
}

export interface McpAppToolCallRequest {
  viewId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface McpAppToolCallResponse {
  viewId: string;
  toolName: string;
  result: McpAppViewToolResult;
}

const VALID_VISIBILITIES: ReadonlySet<string> = new Set(["model", "app"]);
const STRICT_MCP_APP_MIME_RE = /^text\/html\s*;\s*profile=mcp-app$/i;

export function isValidMcpAppResourceUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_024) return false;
  if (!trimmed.startsWith("ui://")) return false;
  if (/[\x00-\x20\x7f<>"{}|\\^`]/.test(trimmed)) return false;
  const rest = trimmed.slice("ui://".length);
  return rest.length > 0 && !rest.startsWith("/");
}

export function isStrictMcpAppMimeType(value: unknown): boolean {
  return typeof value === "string" && STRICT_MCP_APP_MIME_RE.test(value.trim());
}

/**
 * Extracts `_meta.ui` metadata from an MCP Tool definition according to the 2026-01-26 spec
 * (with fallback to deprecated flat `_meta["ui/resourceUri"]`).
 */
export function extractMcpToolUiMeta(meta: unknown): McpAppToolUiMeta | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const rec = meta as Record<string, unknown>;
  const uiObj = rec.ui && typeof rec.ui === "object" && !Array.isArray(rec.ui)
    ? (rec.ui as Record<string, unknown>)
    : undefined;

  const rawUri = uiObj?.resourceUri ?? rec["ui/resourceUri"];
  const resourceUri = isValidMcpAppResourceUri(rawUri) ? rawUri.trim() : undefined;

  let visibility: McpAppToolVisibility[] | undefined;
  if (Array.isArray(uiObj?.visibility)) {
    const parsed = [...new Set(
      uiObj.visibility.filter((item): item is McpAppToolVisibility => typeof item === "string" && VALID_VISIBILITIES.has(item)),
    )];
    // Preserve explicit empty/filtered visibility arrays so an invalid or app-only list fails closed.
    visibility = parsed;
  }

  if (!resourceUri && visibility === undefined) return undefined;
  return {
    ...(resourceUri ? { resourceUri } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  };
}

/**
 * Per MCP Apps 2026-01-26, tools without explicit `_meta.ui.visibility` default to `["model", "app"]`.
 * Tools declaring `visibility: ["app"]` MUST be hidden from model tool lists and model direct calls.
 */
export function isMcpToolVisibleToModel(meta: unknown): boolean {
  const ui = extractMcpToolUiMeta(meta);
  if (!ui || ui.visibility === undefined) return true;
  return ui.visibility.includes("model");
}

/**
 * Per MCP Apps 2026-01-26, tools declaring `visibility: ["model"]` (omitting `"app"`)
 * MUST NOT be callable from an embedded MCP App View.
 */
export function isMcpToolVisibleToApp(meta: unknown): boolean {
  const ui = extractMcpToolUiMeta(meta);
  if (!ui || ui.visibility === undefined) return true;
  return ui.visibility.includes("app");
}
