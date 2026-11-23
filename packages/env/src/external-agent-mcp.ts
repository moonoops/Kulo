import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EXTERNAL_AGENT_MCP_TOOL_NAMES, redactSensitiveText, type ExternalAgentMcpToolName } from "@kulo/protocol";

export interface ExternalAgentMcpScope {
  runId: string;
  taskId: string;
  runEpoch: number;
  cwd: string;
  allowSubagents: boolean;
  hasConnections?: boolean;
  memoryEnabled?: boolean;
  memoryMode?: "hindsight" | "builtin";
}

export interface ExternalAgentMcpInvocation extends ExternalAgentMcpScope {
  name: string;
  args: Record<string, unknown>;
}

export interface ExternalAgentMcpOptions extends ExternalAgentMcpScope {
  handler: (invocation: ExternalAgentMcpInvocation) => Promise<unknown>;
  redact?: (text: string) => string;
}

export interface ExternalAgentMcpServer {
  server: { name: string; url: string; headers: Array<{ name: string; value: string }> };
  port: number;
  close(): Promise<void>;
}

const BODY_LIMIT = 256 * 1024;
const RESULT_LIMIT = 128 * 1024;

function buildMcpInstructions(scope: Pick<ExternalAgentMcpScope, "allowSubagents" | "memoryEnabled" | "hasConnections">): string {
  const parts = ["Use kulo_task_context and kulo_task_report to inspect task metadata or submit structured reports/artifacts to Kulo."];
  if (scope.allowSubagents) parts.push("Use kulo_agents / kulo_request_collaboration / kulo_child_task only when specialized delegation is clearly needed.");
  if (scope.memoryEnabled) parts.push("Use kulo_memory_* tools for shared project memory when relevant.");
  if (scope.hasConnections) parts.push("Use kulo_connections / kulo_connection_use for authorized external connections.");
  return parts.join(" ");
}
const text = (description: string, maxLength: number) => ({ type: "string", description, minLength: 1, maxLength });
const integer = (description: string, minimum: number, maximum: number) => ({ type: "integer", description, minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const EXTERNAL_AGENT_MCP_TOOLS = [
  {
    name: "kulo_task_context",
    description: "Read the current authorized Kulo task, workspace mode, and scratch paths. Only this task's brief is available; main-agent private memory and unrelated conversations are not exposed.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_task_report",
    description: "Report progress, a blocking question ('blocked'), or privately staged results ('ready' / 'failed') and optional artifact files to the Kulo main agent. Ready means awaiting the main agent's review, not approved or published.",
    inputSchema: object({
      state: { type: "string", enum: ["progress", "blocked", "ready", "failed"] },
      summary: text("Observed result or progress", 4000),
      deliverable: text("Structured findings and verification evidence without secrets (stage multi-page standalone reports via files instead of pasting full prose)", 60000),
      question: text("A concrete decision needed from the user or main agent when blocked", 2000),
      files: {
        type: "array",
        description: "Optional task workspace or scratch files to privately stage for the main agent's review",
        maxItems: 16,
        items: object({
          path: text("Relative workspace path or absolute task scratch path", 4096),
          name: text("Optional display file name", 180),
          mime_type: text("Optional MIME type such as text/html or image/png", 120),
          caption: text("Optional short caption", 500),
        }, ["path"]),
      },
    }, ["state", "summary"]),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "kulo_agents",
    description: "List agents eligible for collaboration within this task's authorized device, project, and read-only scope.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_request_collaboration",
    description: "Ask Hub to dispatch a bounded child task to another configured agent. Supply an explicit brief. Reuse request_id on retry; do not copy the whole parent conversation.",
    inputSchema: object({ request_id: text("Stable identifier for this child request; reuse after uncertain delivery", 120), agent_id: text("Eligible agent ID from kulo_agents", 120), goal: text("Complete task objective and necessary context", 16000), acceptance: text("Verification criteria", 4000) }, ["request_id", "agent_id", "goal"]),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "kulo_child_task",
    description: "Read the state and result of a child task created by this task. Other tasks cannot be read.",
    inputSchema: object({ task_id: text("Child task ID returned by kulo_request_collaboration", 120) }, ["task_id"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_memory_recall",
    description: "Recall relevant project facts and past work observations from Kulo's shared project memory bank. Private main-agent memory is never accessible.",
    inputSchema: object({
      query: text("Natural language recall query", 3000),
      budget: { type: "string", enum: ["low", "mid", "high"], description: "Optional recall budget" },
      max_tokens: integer("Optional max tokens (100..4000)", 100, 4000),
    }, ["query"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_memory_search_pages",
    description: "Search curated Hindsight shared Knowledge Pages (architecture, conventions, past project decisions).",
    inputSchema: object({ query: text("Topic or question to search across shared knowledge pages", 2000) }, ["query"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_memory_read_page",
    description: "Read the markdown content of a Hindsight shared Knowledge Page by its page_id.",
    inputSchema: object({ page_id: text("Shared knowledge page ID", 240) }, ["page_id"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_memory_ingest",
    description: "Retain newly verified project facts or an evidence-backed 'Correction: <topic>' into Kulo's shared project memory. Never include secrets or re-ingest recalled text.",
    inputSchema: object({
      title: text("Document title (or 'Correction: <topic>')", 240),
      content: text("Verified factual text without secrets", 24000),
    }, ["title", "content"]),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "kulo_memory_reflect",
    description: "Synthesize historical design rationale and root causes across this project's Hindsight shared memory bank.",
    inputSchema: object({
      query: text("Deep reasoning question over shared project memory", 2000),
      budget: { type: "string", enum: ["low", "mid", "high"], description: "Optional reflection budget" },
    }, ["query"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_connections",
    description: "List Kulo connections authorized for this task and their supported actions/parameters without exposing raw credential values.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "kulo_connection_use",
    description: "Execute an operation through a Kulo connection authorized for this task (SSH, HTTP, app action, MCP list_tools/call_tool, or authorized information read). Credentials remain sealed inside Hub.",
    inputSchema: object({
      connection_id: text("Authorized connection ID", 256),
      operation: { type: "string", enum: ["ssh", "http", "app", "mcp", "information"] },
      command: text("SSH command when operation='ssh'", 32000),
      timeout_ms: integer("Optional SSH timeout in ms (1000..120000)", 1000, 120000),
      path: text("Relative URL path starting with '/' when operation='http'", 4096),
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
      body: { type: "string", description: "Optional HTTP request body", minLength: 0, maxLength: 64000 },
      content_type: text("Optional HTTP Content-Type header", 256),
      action: text("App action ID (`operation='app'`), `list_tools`/`call_tool` (`operation='mcp'`), or `read` (`operation='information'`)", 64),
      params_json: text("JSON object string of app or MCP parameters (<= 64 KiB)", 65536),
    }, ["connection_id", "operation"]),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
] as const satisfies readonly { name: ExternalAgentMcpToolName; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }[];

export const EXTERNAL_AGENT_MCP_DEFINED_TOOL_NAMES: readonly ExternalAgentMcpToolName[] = EXTERNAL_AGENT_MCP_TOOLS.map((tool) => tool.name);
const _verifyAllProtocolMcpToolsDefined: ReadonlyArray<ExternalAgentMcpToolName> = EXTERNAL_AGENT_MCP_TOOL_NAMES;
void _verifyAllProtocolMcpToolsDefined;

const CORE_TOOL_NAMES = new Set(["kulo_task_context", "kulo_task_report"]);
const COLLAB_TOOL_NAMES = new Set(["kulo_agents", "kulo_request_collaboration", "kulo_child_task"]);
const MEMORY_TOOL_NAMES = new Set(["kulo_memory_recall", "kulo_memory_search_pages", "kulo_memory_read_page", "kulo_memory_ingest", "kulo_memory_reflect"]);
const BUILTIN_MEMORY_TOOL_NAMES = new Set(["kulo_memory_recall", "kulo_memory_ingest"]);
const CONNECTION_TOOL_NAMES = new Set(["kulo_connections", "kulo_connection_use"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface SchemaProperty {
  type: string;
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  enum?: readonly string[];
  items?: { properties: Record<string, SchemaProperty>; required: readonly string[] };
}

function validObjectBySchema(value: unknown, properties: Record<string, SchemaProperty>, required: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  return Object.entries(value).every(([key, content]) => {
    if (!Object.hasOwn(properties, key)) return false;
    const field = properties[key]!;
    if (field.type === "string") {
      return typeof content === "string" && content.length >= (field.minLength ?? 0) && content.length <= (field.maxLength ?? 65536) &&
        (!field.enum || field.enum.includes(content));
    }
    if (field.type === "integer") {
      return typeof content === "number" && Number.isSafeInteger(content) &&
        content >= (field.minimum ?? Number.MIN_SAFE_INTEGER) && content <= (field.maximum ?? Number.MAX_SAFE_INTEGER);
    }
    if (field.type === "array" && field.items) {
      return Array.isArray(content) && content.length <= (field.maxItems ?? 16) &&
        content.every((item) => validObjectBySchema(item, field.items!.properties, field.items!.required));
    }
    return false;
  });
}

function validArguments(name: string, value: unknown): value is Record<string, unknown> {
  const tool = EXTERNAL_AGENT_MCP_TOOLS.find((item) => item.name === name);
  if (!tool) return false;
  const schema = tool.inputSchema;
  return validObjectBySchema(value, schema.properties as unknown as Record<string, SchemaProperty>, schema.required);
}

/** Each run owns its endpoint and secret; closing one bridge cannot revoke a sibling run. */
export async function startExternalAgentMcp(options: ExternalAgentMcpOptions): Promise<ExternalAgentMcpServer> {
  if (!options.runId || !options.taskId || !Number.isSafeInteger(options.runEpoch) || options.runEpoch < 1 || !options.cwd) throw new Error("Invalid external agent MCP scope");
  const bearer = Buffer.from(`Bearer ${randomBytes(32).toString("base64url")}`);
  const allowedMemoryTools = options.memoryMode === "builtin" ? BUILTIN_MEMORY_TOOL_NAMES : MEMORY_TOOL_NAMES;
  const tools = EXTERNAL_AGENT_MCP_TOOLS.filter((tool) =>
    CORE_TOOL_NAMES.has(tool.name) ||
    (Boolean(options.allowSubagents) && COLLAB_TOOL_NAMES.has(tool.name)) ||
    (Boolean(options.memoryEnabled) && allowedMemoryTools.has(tool.name)) ||
    (Boolean(options.hasConnections) && CONNECTION_TOOL_NAMES.has(tool.name)),
  );
  const names = new Set<string>(tools.map((tool) => tool.name));
  let closed = false;
  let port = 0;
  const redact = (value: string) => redactSensitiveText(options.redact?.(value) ?? value);
  const send = (response: http.ServerResponse, status: number, body?: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(status >= 400 ? { Connection: "close" } : {}) });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    if (closed) { send(response, 503); return; }
    const host = request.headers.host;
    const expectedHost = `127.0.0.1:${port}`;
    if (host !== expectedHost || request.url !== "/mcp") { send(response, 403); return; }
    if (request.headers.origin !== undefined && request.headers.origin !== `http://${expectedHost}`) { send(response, 403); return; }
    const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
    if (supplied.length !== bearer.length || !timingSafeEqual(supplied, bearer)) { send(response, 401); return; }
    if (request.method === "DELETE") { send(response, 204); return; }
    if (request.method !== "POST") { response.setHeader("Allow", "POST, DELETE"); send(response, 405); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) { send(response, 415); return; }
    if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT) { send(response, 413); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > BODY_LIMIT) { send(response, 413); request.resume(); return; }
        chunks.push(data);
      }
    } catch { send(response, 400); return; }
    if (closed) { send(response, 503); return; }
    let message: unknown;
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
    if (!record(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number" && message.id !== null) {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return;
    }
    if (message.id === undefined) { send(response, 202); return; }
    const id = message.id;
    const result = (value: unknown) => send(response, 200, { jsonrpc: "2.0", id, result: value });
    const error = (code: number, description: string) => send(response, 200, { jsonrpc: "2.0", id, error: { code, message: description } });
    if (message.method === "initialize") {
      const requestedVersion = record(message.params) ? message.params.protocolVersion : undefined;
      result({ protocolVersion: requestedVersion === "2025-06-18" ? "2025-06-18" : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kulo-task", version: "1.0.0" }, instructions: buildMcpInstructions(options) }); return;
    }
    if (message.method === "ping") { result({}); return; }
    if (message.method === "tools/list") { result({ tools }); return; }
    if (message.method !== "tools/call") { error(-32601, "Method not found"); return; }
    const params = message.params;
    if (!record(params) || typeof params.name !== "string" || !names.has(params.name) || !validArguments(params.name, params.arguments ?? {})) {
      error(-32602, "Unsupported task tool or invalid arguments"); return;
    }
    try {
      const value = await options.handler({ runId: options.runId, taskId: options.taskId, runEpoch: options.runEpoch, cwd: options.cwd, allowSubagents: options.allowSubagents, name: params.name, args: (params.arguments ?? {}) as Record<string, unknown> });
      const serialized = JSON.stringify(value);
      if (serialized === undefined || Buffer.byteLength(serialized) > RESULT_LIMIT) throw new Error("Task tool returned no bounded result");
      result({ content: [{ type: "text", text: redact(serialized) }] });
    } catch (cause) {
      result({ isError: true, content: [{ type: "text", text: redact(cause instanceof Error ? cause.message : "Task operation failed").slice(0, 2000) }] });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Unable to bind task MCP endpoint"); }
  port = address.port;
  let closing: Promise<void> | undefined;
  return {
    server: { name: "kulo-task", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: bearer.toString() }] },
    port,
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise<void>((resolve, reject) => {
        server.close((cause) => cause ? reject(cause) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
