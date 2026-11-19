import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export async function startSearchMcpFixture(options: {
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  onCall: (name: string, args: Record<string, unknown>, signal: AbortSignal) => CallToolResult | Promise<CallToolResult>;
}) {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let connections = 0;
  const http = createServer(async (req, res) => {
    try {
      let body: unknown;
      if (req.method === "POST") { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      const id = req.headers["mcp-session-id"] as string | undefined;
      let connection = id ? sessions.get(id) : undefined;
      if (!connection && req.method === "POST" && isInitializeRequest(body)) {
        const server = new Server({ name: "kulo-search-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: (sessionId) => { sessions.set(sessionId, { transport, server }); connections++; } });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.tools.map((tool) => ({ description: tool.name, ...tool, inputSchema: { type: "object" as const, ...tool.inputSchema } })) }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const args = request.params.arguments ?? {}; calls.push({ name: request.params.name, args });
          return await options.onCall(request.params.name, args, extra.signal);
        });
        await server.connect(transport); connection = { transport, server };
      }
      if (!connection) { res.writeHead(404); res.end(); return; }
      await connection.transport.handleRequest(req, res, body);
      if (req.method === "DELETE" && id) { sessions.delete(id); await connection.server.close(); }
    } catch (error) { if (!res.headersSent) { res.writeHead(500); res.end(error instanceof Error ? error.message : "fixture error"); } else res.destroy(); }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, calls,
    get connections() { return connections; }, get activeSessions() { return sessions.size; },
    async close() { await Promise.all([...sessions.values()].map(({ server }) => server.close())); sessions.clear(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); },
  };
}
