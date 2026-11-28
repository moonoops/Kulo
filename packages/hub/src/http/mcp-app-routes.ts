import type { McpAppCreateViewRequest, McpAppReadResourceRequest, McpAppToolCallRequest } from "@kulo/protocol";
import { McpAppError } from "../mcp-app-bridge.js";
import { assertHttpSameOrigin, type HubHttpRouteContext } from "./context.js";

const CREATE_VIEW_KEYS = new Set([
  "connectionId",
  "resourceUri",
  "toolName",
  "title",
  "resultRef",
  "expectedRevision",
]);
const RESOURCE_KEYS = new Set(["viewId", "uri"]);
const CALL_KEYS = new Set(["viewId", "toolName", "arguments"]);

function assertBearerHostCaller(ctx: HubHttpRouteContext): string {
  assertHttpSameOrigin(ctx, {
    code: "mcp_app_origin_required",
    message: "请在 Kulo 宿主页中访问 MCP App 接口。",
  });
  // Strictly forbid query `?token=` credentials on MCP Apps endpoints.
  if (ctx.authority.authSource !== "bearer" || !ctx.authority.principalId) {
    throw new McpAppError(401, "mcp_app_bearer_required", "MCP App 接口仅支持 Bearer 鉴权，禁止 URL 令牌。");
  }
  return ctx.authority.principalId;
}

/**
 * Handles Stage 4 P2-2 read-only inline MCP Apps HTTP routes:
 * - `GET    /api/mcp-apps/config`
 * - `POST   /api/mcp-apps/views`
 * - `POST   /api/mcp-apps/resource` (and Bearer-only `GET /api/mcp-apps/resource?viewId=...`)
 * - `POST   /api/mcp-apps/call`
 * - `DELETE /api/mcp-apps/views/:viewId`
 */
export async function handleMcpAppRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, parsedUrl, pathname, readJsonObject, sendJson } = ctx;
  if (pathname !== "/api/mcp-apps" && !pathname.startsWith("/api/mcp-apps/")) {
    return false;
  }

  res.setHeader("cache-control", "no-store");
  const principalId = assertBearerHostCaller(ctx);

  const callerOrigin = ctx.requestOrigin(req);
  if (callerOrigin) {
    hub.mcpApps.allowHostOrigin(callerOrigin);
  }

  if (pathname === "/api/mcp-apps/config") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "仅支持 GET 请求。", code: "mcp_app_method_not_allowed" });
      return true;
    }
    sendJson(res, 200, hub.mcpApps.getConfig());
    return true;
  }

  if (pathname === "/api/mcp-apps/views") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "仅支持 POST 请求。", code: "mcp_app_method_not_allowed" });
      return true;
    }
    const body = await readJsonObject(req, 32 * 1024);
    if (Object.keys(body).some((key) => !CREATE_VIEW_KEYS.has(key))) {
      throw new McpAppError(400, "mcp_app_invalid_request", "创建视图请求包含未定义参数。");
    }
    if (
      body.expectedRevision !== undefined &&
      (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)
    ) {
      throw new McpAppError(400, "mcp_app_invalid_request", "expectedRevision 必须为正整数。");
    }
    const view = hub.mcpApps.createView(principalId, body as unknown as McpAppCreateViewRequest);
    sendJson(res, 201, { view });
    return true;
  }

  const deleteViewMatch = /^\/api\/mcp-apps\/views\/([^/]+)$/.exec(pathname);
  if (deleteViewMatch) {
    if (req.method !== "DELETE") {
      sendJson(res, 405, { error: "仅支持 DELETE 请求。", code: "mcp_app_method_not_allowed" });
      return true;
    }
    const viewId = decodeURIComponent(deleteViewMatch[1]!);
    const result = hub.mcpApps.closeView(principalId, viewId);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === "/api/mcp-apps/resource") {
    if (req.method !== "POST" && req.method !== "GET") {
      sendJson(res, 405, { error: "仅支持 POST 或 GET 请求。", code: "mcp_app_method_not_allowed" });
      return true;
    }
    let payload: McpAppReadResourceRequest;
    if (req.method === "GET") {
      const viewId = parsedUrl.searchParams.get("viewId") ?? "";
      const uri = parsedUrl.searchParams.get("uri") ?? undefined;
      payload = { viewId, ...(uri ? { uri } : {}) };
    } else {
      const body = await readJsonObject(req, 16 * 1024);
      if (Object.keys(body).some((key) => !RESOURCE_KEYS.has(key))) {
        throw new McpAppError(400, "mcp_app_invalid_request", "资源请求包含未定义参数。");
      }
      payload = body as unknown as McpAppReadResourceRequest;
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);
    try {
      const resource = await hub.mcpApps.readResource(principalId, payload, controller.signal);
      sendJson(res, 200, { resource });
    } finally {
      res.off("close", onClose);
    }
    return true;
  }

  if (pathname === "/api/mcp-apps/call") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "仅支持 POST 请求。", code: "mcp_app_method_not_allowed" });
      return true;
    }
    const body = await readJsonObject(req, 96 * 1024);
    if (Object.keys(body).some((key) => !CALL_KEYS.has(key))) {
      throw new McpAppError(400, "mcp_app_invalid_request", "工具调用请求包含未定义参数。");
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);
    try {
      const call = await hub.mcpApps.callTool(principalId, body as unknown as McpAppToolCallRequest, controller.signal);
      sendJson(res, 200, { call });
    } finally {
      res.off("close", onClose);
    }
    return true;
  }

  sendJson(res, 404, { error: "MCP App 接口不存在。", code: "mcp_app_route_not_found" });
  return true;
}
