import type {
  McpAppCreateViewRequest,
  McpAppReadResourceRequest,
  McpAppResourcePayload,
  McpAppSandboxConfig,
  McpAppToolCallRequest,
  McpAppToolCallResponse,
  McpAppViewSession,
} from "@kulo/protocol";
import { apiRequest } from "../../kulo-api-rest";

export interface McpAppFrameApi {
  getConfig(signal?: AbortSignal): Promise<McpAppSandboxConfig>;
  createView(body: McpAppCreateViewRequest, signal?: AbortSignal): Promise<{ view: McpAppViewSession }>;
  readResource(body: McpAppReadResourceRequest, signal?: AbortSignal): Promise<{ resource: McpAppResourcePayload }>;
  callTool(body: McpAppToolCallRequest, signal?: AbortSignal): Promise<{ call: McpAppToolCallResponse }>;
  closeView(viewId: string): Promise<{ closed: boolean }>;
}

export const mcpAppRestApi: McpAppFrameApi = {
  getConfig: (signal) => apiRequest<McpAppSandboxConfig>("/api/mcp-apps/config", { signal }),
  createView: (body, signal) =>
    apiRequest<{ view: McpAppViewSession }>("/api/mcp-apps/views", { method: "POST", body, signal }),
  readResource: (body, signal) =>
    apiRequest<{ resource: McpAppResourcePayload }>("/api/mcp-apps/resource", { method: "POST", body, signal }),
  callTool: (body, signal) =>
    apiRequest<{ call: McpAppToolCallResponse }>("/api/mcp-apps/call", { method: "POST", body, signal }),
  closeView: (viewId) =>
    apiRequest<{ closed: boolean }>(`/api/mcp-apps/views/${encodeURIComponent(viewId)}`, { method: "DELETE" }),
};
