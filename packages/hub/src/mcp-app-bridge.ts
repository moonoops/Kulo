import { randomBytes } from "node:crypto";
import {
  MCP_APP_MAX_CONCURRENT_CALLS_PER_VIEW,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_PROTOCOL_VERSION,
  isValidMcpAppResourceUri,
  redactSensitiveText,
  type ConnectionRecordView,
  type ConnectionSecrets,
  type McpAppCreateViewRequest,
  type McpAppInlineMeta,
  type McpAppReadResourceRequest,
  type McpAppResourcePayload,
  type McpAppSandboxConfig,
  type McpAppToolCallRequest,
  type McpAppToolCallResponse,
  type McpAppViewSession,
  type McpAppViewToolResult,
} from "@kulo/protocol";
import type { McpAppToolResultCapture, McpConnectionPool } from "./mcp-connections.js";
import type { McpAppSandboxProxyServer } from "./mcp-app-sandbox-proxy.js";
import { isMcpAggregatorConnection } from "./mcp-presets.js";

const VIEW_TTL_MS = 15 * 60_000;
const CAPTURE_TTL_MS = 30 * 60_000;
const MAX_ACTIVE_VIEWS = 64;
const MAX_CAPTURED_RESULTS = 128;
const MAX_TOOL_ARGS_BYTES = 64 * 1024;
const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._:/-]{0,127}$/;
const UNSAFE_ARG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class McpAppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpAppError";
  }
}

export interface McpAppBridgeConnectionsPort {
  getConnectionRecord(id: string): ConnectionRecordView | undefined;
  redact(text: string): string;
  withMcpAppPool<T>(
    connectionId: string,
    expectedRevision: number,
    work: (
      pool: McpConnectionPool,
      record: ConnectionRecordView,
      secrets: ConnectionSecrets,
      binding: string,
      signal: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface McpAppBridgeOptions {
  connections: McpAppBridgeConnectionsPort;
  sandboxProxy?: Pick<McpAppSandboxProxyServer, "origin" | "url" | "allowHostOrigin">;
  viewTtlMs?: number;
  now?: () => number;
}

interface StoredToolCapture {
  resultRef: string;
  connectionId: string;
  connectionRevision: number;
  toolName: string;
  resourceUri: string;
  title?: string;
  viewResult: McpAppViewToolResult;
  createdAt: number;
}

interface ActiveViewEntry {
  viewId: string;
  sessionHandle: string;
  principalId: string;
  connectionId: string;
  connectionName: string;
  connectionRevision: number;
  resourceUri: string;
  toolName: string;
  title?: string;
  initialToolResult?: McpAppViewToolResult;
  inFlightCalls: number;
  controllers: Set<AbortController>;
  createdAt: number;
  expiresAt: number;
  closed: boolean;
}

function validateSafeToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpAppError(400, "mcp_app_invalid_arguments", "工具参数必须为 JSON 对象。");
  }
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_ARGS_BYTES) {
    throw new McpAppError(400, "mcp_app_invalid_arguments", "工具参数超过 64 KiB 限制。");
  }
  const stack: unknown[] = [raw];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (UNSAFE_ARG_KEYS.has(k)) {
        throw new McpAppError(400, "mcp_app_invalid_arguments", "工具参数包含禁止字段。");
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return raw as Record<string, unknown>;
}

/**
 * Manages read-only inline MCP App View lifecycles (`viewId` / `sessionHandle`),
 * filtered `structuredContent` snapshots, resource loading, and single-server read-only
 * `tools/call` proxying with immediate revocation on connection edit/disable/remove/close.
 */
export class McpAppBridgeService {
  readonly #connections: McpAppBridgeConnectionsPort;
  #sandboxProxy?: Pick<McpAppSandboxProxyServer, "origin" | "url" | "allowHostOrigin">;
  readonly #viewTtlMs: number;
  readonly #now: () => number;
  readonly #views = new Map<string, ActiveViewEntry>();
  readonly #captures = new Map<string, StoredToolCapture>();
  #closed = false;

  constructor(options: McpAppBridgeOptions) {
    this.#connections = options.connections;
    this.#sandboxProxy = options.sandboxProxy;
    this.#viewTtlMs = options.viewTtlMs ?? VIEW_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  setSandboxProxy(proxy: Pick<McpAppSandboxProxyServer, "origin" | "url" | "allowHostOrigin"> | undefined): void {
    this.#sandboxProxy = proxy;
  }

  allowHostOrigin(origin: string): boolean {
    return this.#sandboxProxy?.allowHostOrigin(origin) ?? false;
  }

  getConfig(): McpAppSandboxConfig {
    return {
      enabled: Boolean(this.#sandboxProxy?.origin && this.#sandboxProxy?.url),
      ...(this.#sandboxProxy?.origin ? { sandboxOrigin: this.#sandboxProxy.origin } : {}),
      ...(this.#sandboxProxy?.url ? { sandboxUrl: this.#sandboxProxy.url } : {}),
      protocolVersion: MCP_APP_PROTOCOL_VERSION,
      maxHtmlBytes: MCP_APP_MAX_HTML_BYTES,
      maxConcurrentCalls: MCP_APP_MAX_CONCURRENT_CALLS_PER_VIEW,
    };
  }

  #redact(text: string): string {
    return this.#connections.redact(redactSensitiveText(text));
  }

  #prune(now: number): void {
    for (const [id, view] of this.#views) {
      if (view.closed || now > view.expiresAt) {
        this.#destroyView(id, view);
      }
    }
    for (const [ref, cap] of this.#captures) {
      if (now - cap.createdAt > CAPTURE_TTL_MS) {
        this.#captures.delete(ref);
      }
    }
  }

  #destroyView(viewId: string, view: ActiveViewEntry): void {
    view.closed = true;
    for (const controller of view.controllers) {
      controller.abort();
    }
    view.controllers.clear();
    this.#views.delete(viewId);
  }

  #assertEligibleConnection(connectionId: string, expectedRevision?: number): ConnectionRecordView {
    const record = this.#connections.getConnectionRecord(connectionId);
    if (!record) {
      throw new McpAppError(404, "mcp_app_connection_not_found", "此 MCP 连接不存在或已移除。");
    }
    if (record.kind !== "mcp") {
      throw new McpAppError(403, "mcp_app_not_eligible", "仅 MCP 连接支持内联视图。");
    }
    if (isMcpAggregatorConnection(record)) {
      throw new McpAppError(403, "mcp_app_aggregator_forbidden", "聚合型 MCP 连接禁止启用内联 MCP App。");
    }
    if (record.mcpAppsEnabled !== true) {
      throw new McpAppError(403, "mcp_app_not_enabled", "请先在连接设置中显式开启「允许内联 MCP App（只读原型）」。");
    }
    if (record.mcpDisabled) {
      throw new McpAppError(403, "mcp_app_connection_disabled", "此 MCP 连接已禁用。");
    }
    if (
      record.mcpTransport === "http" &&
      (record.mcpAuthMode ?? "oauth") === "oauth" &&
      !record.mcpOAuthAuthorized
    ) {
      throw new McpAppError(401, "mcp_app_auth_required", "此 MCP 连接尚未完成 OAuth 授权。");
    }
    if (expectedRevision !== undefined && record.revision !== expectedRevision) {
      throw new McpAppError(410, "mcp_app_connection_changed", "连接配置已变更，旧视图已失效，请重新展开。");
    }
    return record;
  }

  #assertActiveView(principalId: string, viewId: string): { view: ActiveViewEntry; record: ConnectionRecordView } {
    if (this.#closed) {
      throw new McpAppError(503, "mcp_app_bridge_closed", "MCP App 服务已关闭。");
    }
    const cleanViewId = typeof viewId === "string" ? viewId.trim() : "";
    if (!cleanViewId) {
      throw new McpAppError(400, "mcp_app_invalid_view_id", "缺少有效的视图标识 viewId。");
    }
    const view = this.#views.get(cleanViewId);
    if (!view || view.closed) {
      throw new McpAppError(410, "mcp_app_view_invalidated", "该 MCP App 视图已关闭或失效。");
    }
    if (this.#now() > view.expiresAt) {
      this.#destroyView(cleanViewId, view);
      throw new McpAppError(410, "mcp_app_view_expired", "该 MCP App 视图已过期，请重新展开。");
    }
    if (view.principalId !== principalId) {
      throw new McpAppError(403, "mcp_app_view_forbidden", "当前客户端无权访问该 MCP App 视图。");
    }
    const liveRecord = this.#connections.getConnectionRecord(view.connectionId);
    if (
      !liveRecord ||
      liveRecord.kind !== "mcp" ||
      liveRecord.revision !== view.connectionRevision ||
      liveRecord.mcpDisabled ||
      liveRecord.mcpAppsEnabled !== true ||
      isMcpAggregatorConnection(liveRecord) ||
      (liveRecord.mcpTransport === "http" &&
        (liveRecord.mcpAuthMode ?? "oauth") === "oauth" &&
        !liveRecord.mcpOAuthAuthorized)
    ) {
      this.#destroyView(cleanViewId, view);
      throw new McpAppError(410, "mcp_app_view_invalidated", "关联连接已修改、禁用或撤权，视图已立即失效。");
    }
    return { view, record: liveRecord };
  }

  /**
   * Stores a redacted, size-bounded `structuredContent` snapshot in memory for an eligible
   * read-only MCP tool call and returns safe metadata suitable for chat message projection.
   */
  recordToolResult(capture: McpAppToolResultCapture): McpAppInlineMeta {
    const now = this.#now();
    this.#prune(now);
    const resultRef = `mcpr_${randomBytes(12).toString("hex")}`;
    const safeName = this.#redact(capture.connectionName).slice(0, 120);
    const safeTitle = capture.title ? this.#redact(capture.title).slice(0, 120) : undefined;
    const safeUri = this.#redact(capture.resourceUri).slice(0, 512);
    const safeToolName = capture.toolName.slice(0, 128);

    while (this.#captures.size >= MAX_CAPTURED_RESULTS) {
      const oldest = this.#captures.keys().next().value;
      if (!oldest) break;
      this.#captures.delete(oldest);
    }
    this.#captures.set(resultRef, {
      resultRef,
      connectionId: capture.connectionId,
      connectionRevision: capture.connectionRevision,
      toolName: safeToolName,
      resourceUri: safeUri,
      ...(safeTitle ? { title: safeTitle } : {}),
      viewResult: capture.viewResult,
      createdAt: now,
    });

    return {
      connectionId: capture.connectionId,
      connectionName: safeName,
      connectionRevision: capture.connectionRevision,
      toolName: safeToolName,
      resourceUri: safeUri,
      ...(safeTitle ? { title: safeTitle } : {}),
      resultRef,
      readOnly: true,
    };
  }

  createView(principalId: string, input: McpAppCreateViewRequest): McpAppViewSession {
    if (this.#closed) {
      throw new McpAppError(503, "mcp_app_bridge_closed", "MCP App 服务已关闭。");
    }
    if (!principalId) {
      throw new McpAppError(401, "mcp_app_unauthorized", "需要有效的已认证客户端主体。");
    }
    const proxy = this.#sandboxProxy;
    if (!proxy?.origin || !proxy?.url) {
      throw new McpAppError(503, "mcp_app_sandbox_unavailable", "独立异源 MCP App 沙箱代理尚未就绪。");
    }

    const now = this.#now();
    this.#prune(now);

    const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
    const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
    const resourceUri = typeof input.resourceUri === "string" ? input.resourceUri.trim() : "";
    if (!connectionId || connectionId.length > 256) {
      throw new McpAppError(400, "mcp_app_invalid_request", "缺少有效的连接标识 connectionId。");
    }
    if (!MCP_TOOL_NAME_RE.test(toolName)) {
      throw new McpAppError(400, "mcp_app_invalid_request", "缺少有效的工具名称 toolName。");
    }
    if (!isValidMcpAppResourceUri(resourceUri)) {
      throw new McpAppError(400, "mcp_app_invalid_uri", "MCP App 资源地址必须使用 ui:// 协议。");
    }

    const record = this.#assertEligibleConnection(connectionId, input.expectedRevision);

    let initialToolResult: McpAppViewToolResult | undefined;
    if (typeof input.resultRef === "string" && input.resultRef.trim()) {
      const captured = this.#captures.get(input.resultRef.trim());
      if (
        captured &&
        captured.connectionId === record.id &&
        captured.connectionRevision === record.revision &&
        captured.resourceUri === resourceUri
      ) {
        initialToolResult = captured.viewResult;
      }
    }

    while (this.#views.size >= MAX_ACTIVE_VIEWS) {
      const oldestKey = this.#views.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.#views.get(oldestKey);
      if (oldest) this.#destroyView(oldestKey, oldest);
    }

    const viewId = `mcpv_${randomBytes(16).toString("hex")}`;
    const sessionHandle = `mcps_${randomBytes(12).toString("hex")}`;
    const safeConnectionName = this.#redact(record.name).slice(0, 120);
    const safeTitle =
      typeof input.title === "string" && input.title.trim()
        ? this.#redact(input.title.trim()).slice(0, 120)
        : undefined;
    const expiresAt = now + this.#viewTtlMs;

    const entry: ActiveViewEntry = {
      viewId,
      sessionHandle,
      principalId,
      connectionId: record.id,
      connectionName: safeConnectionName,
      connectionRevision: record.revision,
      resourceUri,
      toolName,
      ...(safeTitle ? { title: safeTitle } : {}),
      ...(initialToolResult ? { initialToolResult } : {}),
      inFlightCalls: 0,
      controllers: new Set(),
      createdAt: now,
      expiresAt,
      closed: false,
    };
    this.#views.set(viewId, entry);

    return {
      viewId,
      sessionHandle,
      connectionId: entry.connectionId,
      connectionName: entry.connectionName,
      connectionRevision: entry.connectionRevision,
      resourceUri: entry.resourceUri,
      toolName: entry.toolName,
      ...(entry.title ? { title: entry.title } : {}),
      readOnly: true,
      protocolVersion: MCP_APP_PROTOCOL_VERSION,
      sandboxOrigin: proxy.origin,
      sandboxUrl: proxy.url,
      ...(entry.initialToolResult ? { initialToolResult: entry.initialToolResult } : {}),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  }

  async readResource(
    principalId: string,
    input: McpAppReadResourceRequest,
    signal?: AbortSignal,
  ): Promise<McpAppResourcePayload> {
    const { view } = this.#assertActiveView(principalId, input.viewId);
    const targetUri = input.uri !== undefined ? String(input.uri).trim() : view.resourceUri;
    if (!isValidMcpAppResourceUri(targetUri) || targetUri !== view.resourceUri) {
      throw new McpAppError(403, "mcp_app_resource_scope_denied", "只读视图仅允许加载当前绑定的 ui:// 资源。");
    }

    const controller = new AbortController();
    view.controllers.add(controller);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const loaded = await this.#connections.withMcpAppPool(
        view.connectionId,
        view.connectionRevision,
        (pool, record, secrets, bind, poolSignal) =>
          pool.readAppResource(record, secrets, bind, targetUri, poolSignal),
        combinedSignal,
      );
      // Re-verify view & connection remained valid across the async boundary.
      this.#assertActiveView(principalId, view.viewId);
      return {
        viewId: view.viewId,
        uri: loaded.uri,
        mimeType: loaded.mimeType,
        html: loaded.html,
        byteLength: loaded.byteLength,
        ...(loaded.csp ? { csp: loaded.csp } : {}),
      };
    } catch (error) {
      throw this.#mapError(error);
    } finally {
      view.controllers.delete(controller);
    }
  }

  async callTool(
    principalId: string,
    input: McpAppToolCallRequest,
    signal?: AbortSignal,
  ): Promise<McpAppToolCallResponse> {
    const { view } = this.#assertActiveView(principalId, input.viewId);
    const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
    if (!MCP_TOOL_NAME_RE.test(toolName)) {
      throw new McpAppError(400, "mcp_app_invalid_tool", "工具名称无效。");
    }
    const args = validateSafeToolArguments(input.arguments);

    if (view.inFlightCalls >= MCP_APP_MAX_CONCURRENT_CALLS_PER_VIEW) {
      throw new McpAppError(
        429,
        "mcp_app_concurrency_limit",
        `单个 MCP App 视图最多同时发起 ${MCP_APP_MAX_CONCURRENT_CALLS_PER_VIEW} 个只读调用。`,
      );
    }

    const controller = new AbortController();
    view.inFlightCalls += 1;
    view.controllers.add(controller);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    try {
      const result = await this.#connections.withMcpAppPool(
        view.connectionId,
        view.connectionRevision,
        (pool, record, secrets, bind, poolSignal) =>
          pool.callAppTool(record, secrets, bind, toolName, args, poolSignal),
        combinedSignal,
      );
      this.#assertActiveView(principalId, view.viewId);
      return {
        viewId: view.viewId,
        toolName,
        result,
      };
    } catch (error) {
      throw this.#mapError(error);
    } finally {
      view.inFlightCalls = Math.max(0, view.inFlightCalls - 1);
      view.controllers.delete(controller);
    }
  }

  closeView(principalId: string, viewId: string): { closed: boolean } {
    const cleanViewId = typeof viewId === "string" ? viewId.trim() : "";
    const view = cleanViewId ? this.#views.get(cleanViewId) : undefined;
    if (!view) return { closed: false };
    if (view.principalId !== principalId) {
      throw new McpAppError(403, "mcp_app_view_forbidden", "当前客户端无权关闭该 MCP App 视图。");
    }
    this.#destroyView(cleanViewId, view);
    return { closed: true };
  }

  invalidateConnection(connectionId: string): void {
    for (const [id, view] of this.#views) {
      if (view.connectionId === connectionId) {
        this.#destroyView(id, view);
      }
    }
    for (const [ref, cap] of this.#captures) {
      if (cap.connectionId === connectionId) {
        this.#captures.delete(ref);
      }
    }
  }

  reconcileConnections(): void {
    for (const [id, view] of this.#views) {
      const live = this.#connections.getConnectionRecord(view.connectionId);
      if (
        !live ||
        live.kind !== "mcp" ||
        live.revision !== view.connectionRevision ||
        live.mcpDisabled ||
        live.mcpAppsEnabled !== true ||
        isMcpAggregatorConnection(live) ||
        (live.mcpTransport === "http" &&
          (live.mcpAuthMode ?? "oauth") === "oauth" &&
          !live.mcpOAuthAuthorized)
      ) {
        this.#destroyView(id, view);
      }
    }
    for (const [ref, cap] of this.#captures) {
      const live = this.#connections.getConnectionRecord(cap.connectionId);
      if (!live || live.revision !== cap.connectionRevision || live.mcpAppsEnabled !== true || live.mcpDisabled) {
        this.#captures.delete(ref);
      }
    }
  }

  get activeViewCount(): number {
    return this.#views.size;
  }

  close(): void {
    this.#closed = true;
    for (const [id, view] of this.#views) {
      this.#destroyView(id, view);
    }
    this.#captures.clear();
  }

  #mapError(error: unknown): McpAppError {
    if (error instanceof McpAppError) return error;
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : 502;
    const rawCode =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "mcp_app_execution_failed";
    const mappedStatus =
      rawCode === "connection_conflict" || rawCode === "connection_not_found" || rawCode === "connection_access_revoked"
        ? 410
        : status;
    const message = this.#redact(error instanceof Error ? error.message : "MCP App 请求失败。");
    return new McpAppError(mappedStatus, rawCode, message || "MCP App 请求失败。");
  }
}
