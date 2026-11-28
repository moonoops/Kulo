import {
  limitMcpContent,
  toLlmContent,
  type CallToolResult,
  type ReadResourceResult,
  type Tool,
} from "@earendil-works/pi-mcp";
import {
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MAX_STRUCTURED_BYTES,
  MCP_APP_RESOURCE_MIME_TYPE,
  isStrictMcpAppMimeType,
  redactSensitiveText,
  type McpAppResourceCsp,
  type McpAppViewToolResult,
} from "@kulo/protocol";

const MAX_STRUCTURED_DEPTH = 10;
const MAX_STRUCTURED_NODES = 2_048;
const MAX_BASE64_HTML_BLOB_BYTES = Math.ceil((MCP_APP_MAX_HTML_BYTES * 4) / 3) + 16;
const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DISALLOWED_READ_ONLY_APP_TOOL_NAME_RE =
  /^(?:delete|remove|drop|destroy|write|create|update|patch|put|post|send|submit|execute|exec|run|mutate|modify|set|reset|clear|purge|revoke|approve|deploy|publish|install|uninstall)(?:[_\-./:]|$)/i;

export interface McpAppToolResultCapture {
  connectionId: string;
  connectionName: string;
  connectionRevision: number;
  toolName: string;
  title?: string;
  resourceUri: string;
  viewResult: McpAppViewToolResult;
  readOnly: true;
}

export interface McpAppReadResourceOutput {
  uri: string;
  mimeType: typeof MCP_APP_RESOURCE_MIME_TYPE;
  html: string;
  byteLength: number;
  csp?: McpAppResourceCsp;
}

/**
 * Host-side read-only policy for Stage 4 P2-2 MCP Apps: requires explicit `readOnlyHint: true`,
 * non-destructive annotation, and rejects unmistakable mutation/destructive verb prefixes even
 * if an untrusted server misreports `readOnlyHint`.
 */
export function isHostApprovedReadOnlyMcpAppTool(tool: Pick<Tool, "name" | "annotations">): boolean {
  if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) {
    return false;
  }
  return !DISALLOWED_READ_ONLY_APP_TOOL_NAME_RE.test(tool.name.trim());
}

export function sanitizeStructuredContentForView(
  raw: unknown,
  redact: (text: string) => string,
  maxBytes = MCP_APP_MAX_STRUCTURED_BYTES,
): unknown {
  if (raw === undefined) return undefined;
  let visited = 0;
  let truncated = false;
  const cleanString = (value: string): string => redact(redactSensitiveText(value));
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return cleanString(value);
    if (depth >= MAX_STRUCTURED_DEPTH || visited >= MAX_STRUCTURED_NODES) {
      truncated = true;
      return "[truncated]";
    }
    visited += 1;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        if (visited >= MAX_STRUCTURED_NODES) {
          truncated = true;
          break;
        }
        out.push(walk(item, depth + 1));
      }
      return out;
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (UNSAFE_JSON_KEYS.has(k) || v === undefined) continue;
        if (visited >= MAX_STRUCTURED_NODES) {
          truncated = true;
          break;
        }
        out[cleanString(k)] = walk(v, depth + 1);
      }
      return out;
    }
    return undefined;
  };

  const sanitized = walk(raw, 0);
  if (sanitized === undefined) return undefined;
  const serialized = redact(redactSensitiveText(JSON.stringify(sanitized)));
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return { _truncated: true, reason: "structured_content_exceeded_limit" };
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (truncated && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { ...(parsed as Record<string, unknown>), _truncated: true };
  }
  return parsed;
}

export async function buildMcpAppViewToolResult(
  rawResult: CallToolResult,
  redact: (text: string) => string,
): Promise<McpAppViewToolResult> {
  const blocks = toLlmContent(rawResult);
  const redactedTextOnly = blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => ({ type: "text" as const, text: redact(redactSensitiveText(block.text)) }));
  const limited = await limitMcpContent(redactedTextOnly);
  const textContent = limited.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => ({ type: "text" as const, text: redact(redactSensitiveText(block.text)) }));
  const structuredContent =
    rawResult.structuredContent !== undefined
      ? sanitizeStructuredContentForView(rawResult.structuredContent, redact)
      : undefined;
  return {
    content: textContent,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(rawResult.isError === true ? { isError: true } : {}),
  };
}

function sanitizeResourceCsp(meta: unknown): McpAppResourceCsp | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const ui = (meta as Record<string, unknown>).ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return undefined;
  const csp = (ui as Record<string, unknown>).csp;
  if (!csp || typeof csp !== "object" || Array.isArray(csp)) return undefined;
  const rec = csp as Record<string, unknown>;
  const cleanDomains = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const list = raw
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 256)
      .slice(0, 16)
      .map((item) => item.trim());
    return list.length ? list : undefined;
  };
  const connectDomains = cleanDomains(rec.connectDomains);
  const resourceDomains = cleanDomains(rec.resourceDomains);
  if (!connectDomains && !resourceDomains) return undefined;
  return {
    ...(connectDomains ? { connectDomains } : {}),
    ...(resourceDomains ? { resourceDomains } : {}),
  };
}

export function validateMcpAppResourceResult(
  uri: string,
  resource: ReadResourceResult,
  redact: (text: string) => string,
): McpAppReadResourceOutput {
  const item = resource.contents.find((c) => c.uri === uri) ?? resource.contents[0];
  if (!item) {
    throw Object.assign(new Error("MCP App 资源内容为空。"), {
      code: "connection_mcp_app_resource_empty",
      status: 404,
    });
  }
  if (!isStrictMcpAppMimeType(item.mimeType)) {
    throw Object.assign(new Error("MCP App 资源 MIME 类型必须严格为 text/html;profile=mcp-app。"), {
      code: "connection_mcp_app_invalid_mime",
      status: 415,
    });
  }
  let rawHtml: string;
  if ("text" in item && typeof item.text === "string") {
    rawHtml = item.text;
  } else if ("blob" in item && typeof item.blob === "string") {
    if (Buffer.byteLength(item.blob, "utf8") > MAX_BASE64_HTML_BLOB_BYTES) {
      throw Object.assign(new Error("MCP App 资源超过 2.5 MiB 上限。"), {
        code: "connection_mcp_app_resource_too_large",
        status: 413,
      });
    }
    rawHtml = Buffer.from(item.blob, "base64").toString("utf8");
  } else {
    throw Object.assign(new Error("MCP App 资源缺少 HTML 内容。"), {
      code: "connection_mcp_app_resource_empty",
      status: 400,
    });
  }
  if (Buffer.byteLength(rawHtml, "utf8") > MCP_APP_MAX_HTML_BYTES) {
    throw Object.assign(new Error("MCP App HTML 原文超过 2.5 MiB 硬上限。"), {
      code: "connection_mcp_app_resource_too_large",
      status: 413,
    });
  }
  const safeHtml = redact(rawHtml);
  const byteLength = Buffer.byteLength(safeHtml, "utf8");
  if (byteLength > MCP_APP_MAX_HTML_BYTES) {
    throw Object.assign(new Error("MCP App HTML 原文超过 2.5 MiB 硬上限。"), {
      code: "connection_mcp_app_resource_too_large",
      status: 413,
    });
  }
  const csp = sanitizeResourceCsp(item._meta ?? resource._meta);
  return {
    uri,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    html: safeHtml,
    byteLength,
    ...(csp ? { csp } : {}),
  };
}
