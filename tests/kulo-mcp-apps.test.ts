import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_PROTOCOL_VERSION,
  MCP_APP_RESOURCE_MIME_TYPE,
  extractMcpToolUiMeta,
  isMcpToolVisibleToApp,
  isMcpToolVisibleToModel,
  isStrictMcpAppMimeType,
  isValidMcpAppResourceUri,
  messagePartFallback,
  type McpAppResourcePayload,
  type McpAppSandboxConfig,
  type McpAppToolCallResponse,
  type McpAppViewSession,
} from "@kulo/protocol";
import {
  KuloConnections,
  KuloHub,
  LocalConfigMigrationService,
  LocalConnectionVault,
  MCP_APP_INNER_SANDBOX_CSP,
  buildMcpAppSandboxProxyHtml,
  extractDisplayMessages,
  isHostApprovedReadOnlyMcpAppTool,
  startKuloHubServer,
} from "../packages/hub/src/index.js";
import {
  desktopContentSecurityPolicy,
  shouldAuthorizeDesktopRequest,
} from "../packages/desktop/src/desktop-config.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const resources: Array<() => unknown | Promise<unknown>> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((filename) =>
    path.basename(String(filename)) === ".env" ? false : exists(filename),
  );
  for (const name of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeTempDir(prefix = "kulo-mcp-apps-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  resources.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeVault(stateDir: string): LocalConnectionVault {
  return new LocalConnectionVault({
    stateDir,
    keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 7) },
  });
}

interface MockMcpAppServerOptions {
  sentinelSecret?: string;
  onInitialize?: (params: Record<string, unknown>) => void;
  onSlowCall?: (args: Record<string, unknown>) => Promise<unknown>;
  customHtml?: string;
}

function createMockMcpAppServer(options: MockMcpAppServerOptions = {}) {
  const sentinel = options.sentinelSecret ?? "sk-test-sentinel-mcp-app-secret-8899";
  const receivedInitCapabilities: Array<Record<string, unknown>> = [];
  const calledTools: Array<{ name: string; args: Record<string, unknown> }> = [];

  const tools: Tool[] = [
    {
      name: "get_metrics",
      title: `Metrics Dashboard (${sentinel})`,
      description: "Read-only metrics overview with inline UI",
      inputSchema: { type: "object", properties: { range: { type: "string" } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: "ui://metrics/dashboard",
          visibility: ["model", "app"],
        },
      },
    },
    {
      name: "app_only_refresh",
      title: "App-only Refresh",
      description: "Internal refresh callable only by active MCP App View",
      inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    {
      name: "model_only_lookup",
      title: "Model-only Lookup",
      description: "Visible only to model, forbidden from MCP App View",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          visibility: ["model"],
        },
      },
    },
    {
      name: "write_record",
      title: "Write Record",
      description: "Mutating tool forbidden from read-only MCP App View",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: {
        ui: {
          visibility: ["model", "app"],
        },
      },
    },
    {
      name: "delete_sneaky",
      title: "Sneaky Delete",
      description: "Server falsely advertises readOnlyHint=true on a destructive name",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    {
      name: "slow_query",
      title: "Slow Read Query",
      description: "Concurrency-testing read-only app tool",
      inputSchema: { type: "object", properties: { slot: { type: "number" } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    {
      name: "get_wrong_mime_view",
      title: "Wrong MIME View",
      description: "Points to text/html instead of text/html;profile=mcp-app",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: "ui://metrics/wrong-mime",
          visibility: ["model", "app"],
        },
      },
    },
    {
      name: "get_oversized_view",
      title: "Oversized View",
      description: "Points to > 2.5 MiB HTML",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: "ui://metrics/oversized",
          visibility: ["model", "app"],
        },
      },
    },
  ];

  const validHtml =
    options.customHtml ??
    `<!doctype html><html><head><title>Metrics</title></head><body><main>Metrics UI (${sentinel})</main><script>window.parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{protocolVersion:"2026-01-26"}},"*");</script></body></html>`;
  const oversizedHtml = `<!doctype html><html><body>${"A".repeat(MCP_APP_MAX_HTML_BYTES + 1024)}</body></html>`;

  const createTransport = () => {
    const pair = createInMemoryTransportPair();
    pair.server.onMessage((msg: JsonRpcMessage) => {
      if (!("method" in msg) || !("id" in msg)) return;
      if (msg.method === "initialize") {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        receivedInitCapabilities.push((params.capabilities ?? {}) as Record<string, unknown>);
        options.onInitialize?.(params);
        void pair.server.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {
              tools: { listChanged: true },
              resources: {},
              extensions: { [MCP_APP_EXTENSION_ID]: {} },
            },
            serverInfo: { name: "mock-metrics-app", version: "1.0.0" },
          },
        });
        return;
      }
      if (msg.method === "tools/list") {
        void pair.server.send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
        return;
      }
      if (msg.method === "resources/read") {
        const uri = String((msg.params as { uri?: unknown } | undefined)?.uri ?? "");
        if (uri === "ui://metrics/dashboard") {
          void pair.server.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              contents: [{ uri, mimeType: MCP_APP_RESOURCE_MIME_TYPE, text: validHtml }],
            },
          });
          return;
        }
        if (uri === "ui://metrics/wrong-mime") {
          void pair.server.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              contents: [{ uri, mimeType: "text/html", text: "<h1>Wrong MIME</h1>" }],
            },
          });
          return;
        }
        if (uri === "ui://metrics/oversized") {
          void pair.server.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              contents: [{ uri, mimeType: MCP_APP_RESOURCE_MIME_TYPE, text: oversizedHtml }],
            },
          });
          return;
        }
        void pair.server.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32002, message: `Resource not found: ${uri}` },
        });
        return;
      }
      if (msg.method === "tools/call") {
        const params = (msg.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
        const args = params.arguments ?? {};
        calledTools.push({ name: params.name, args });
        if (params.name === "get_metrics") {
          void pair.server.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `CPU 42%, MEM 61% (${sentinel})` }],
              structuredContent: {
                cpuPercent: 42,
                memoryPercent: 61,
                note: `secret=${sentinel}`,
                series: [12, 34, 42],
              },
            },
          });
          return;
        }
        if (params.name === "app_only_refresh") {
          void pair.server.send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `Refreshed cursor ${String(args.cursor ?? "0")}` }],
              structuredContent: {
                refreshed: true,
                cursor: args.cursor ?? "0",
                leaked: sentinel,
              },
            },
          });
          return;
        }
        if (params.name === "slow_query" && options.onSlowCall) {
          void options.onSlowCall(args).then(
            (result) => pair.server.send({ jsonrpc: "2.0", id: msg.id, result }),
            (err) =>
              pair.server.send({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
              }),
          );
          return;
        }
        void pair.server.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `ok:${params.name}` }],
          },
        });
      }
    });
    void pair.server.start();
    return pair.client;
  };

  return { createTransport, receivedInitCapabilities, calledTools, sentinel };
}

async function createHubAndServer(options: {
  mockServer: ReturnType<typeof createMockMcpAppServer>;
  migrationHomeDir?: string;
}) {
  const stateDir = makeTempDir("kulo-mcp-apps-hub-");
  const workspaceDir = makeTempDir("kulo-mcp-apps-ws-");
  const vault = makeVault(stateDir);
  const connectionManager = new KuloConnections({
    stateDir,
    vault,
    mcpTransportFactory: () => options.mockServer.createTransport(),
  });
  await connectionManager.initialize();

  const faux = fauxProvider({ provider: "faux-mcp-apps" });
  const models = createModels({ providers: { [faux.provider]: faux } });
  const hub = await KuloHub.open({
    config: {
      stateDir,
      localEnvRoot: workspaceDir,
      authToken: HUB_TEST_ADMIN_TOKEN,
      host: "127.0.0.1",
      port: 0,
      enableLocalEnv: false,
      envTokens: {},
      workerEnvIds: [],
      defaultProvider: faux.provider,
      defaultModel: "faux-model",
    },
    models,
    connectionManager,
    connectionVault: vault,
    ...(options.migrationHomeDir ? { migrationHomeDir: options.migrationHomeDir } : {}),
  });
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  resources.push(async () => {
    await server.close();
    await hub.close();
  });
  return { hub, server, connectionManager, stateDir };
}

async function apiJson<T>(
  baseUrl: string,
  pathname: string,
  options: {
    method?: string;
    token?: string | null;
    queryToken?: string;
    origin?: string;
    secFetchSite?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const url = options.queryToken
    ? `${baseUrl}${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(options.queryToken)}`
    : `${baseUrl}${pathname}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? HUB_TEST_ADMIN_TOKEN}`;
  }
  if (options.origin) headers.Origin = options.origin;
  if (options.secFetchSite) headers["Sec-Fetch-Site"] = options.secFetchSite;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data, headers: res.headers };
}

describe("Stage 4 P2-2: Read-only inline MCP Apps prototype", () => {
  it("validates protocol helpers, strict MIME, ui:// URIs, visibility, and host read-only policy", () => {
    expect(isStrictMcpAppMimeType("text/html;profile=mcp-app")).toBe(true);
    expect(isStrictMcpAppMimeType("text/html; profile=mcp-app")).toBe(true);
    expect(isStrictMcpAppMimeType("text/html")).toBe(false);
    expect(isStrictMcpAppMimeType("text/html; charset=utf-8")).toBe(false);
    expect(isStrictMcpAppMimeType("application/javascript")).toBe(false);

    expect(isValidMcpAppResourceUri("ui://metrics/dashboard")).toBe(true);
    expect(isValidMcpAppResourceUri("https://evil.example/app.html")).toBe(false);
    expect(isValidMcpAppResourceUri("javascript:alert(1)")).toBe(false);
    expect(isValidMcpAppResourceUri("ui://")).toBe(false);

    expect(extractMcpToolUiMeta({ ui: { resourceUri: "ui://a/b", visibility: ["app"] } })).toEqual({
      resourceUri: "ui://a/b",
      visibility: ["app"],
    });
    expect(isMcpToolVisibleToModel({ ui: { visibility: ["app"] } })).toBe(false);
    expect(isMcpToolVisibleToModel({ ui: { visibility: ["model"] } })).toBe(true);
    expect(isMcpToolVisibleToModel(undefined)).toBe(true);
    expect(isMcpToolVisibleToApp({ ui: { visibility: ["model"] } })).toBe(false);
    expect(isMcpToolVisibleToApp({ ui: { visibility: ["app"] } })).toBe(true);
    expect(isMcpToolVisibleToApp(undefined)).toBe(true);

    expect(isHostApprovedReadOnlyMcpAppTool({ name: "get_metrics", annotations: { readOnlyHint: true } })).toBe(true);
    expect(isHostApprovedReadOnlyMcpAppTool({ name: "app_only_refresh", annotations: { readOnlyHint: true } })).toBe(true);
    expect(isHostApprovedReadOnlyMcpAppTool({ name: "write_record", annotations: { readOnlyHint: false } })).toBe(false);
    expect(isHostApprovedReadOnlyMcpAppTool({ name: "delete_sneaky", annotations: { readOnlyHint: true } })).toBe(false);
    expect(isHostApprovedReadOnlyMcpAppTool({ name: "get_metrics", annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(false);
  });

  it("negotiates io.modelcontextprotocol/ui only when opted in, hides app-only tools from model, keeps CLI/LLM plain text, and provides redacted structuredContent to View", async () => {
    const vaultSecret = "vault-secret-token-xyz-774411";
    const mock = createMockMcpAppServer({ sentinelSecret: "sk-test-sentinel-mcp-app-secret-8899" });
    const { hub, server, connectionManager } = await createHubAndServer({ mockServer: mock });
    connectionManager.rememberSecrets([vaultSecret]);

    // 1. Default connection (mcpAppsEnabled omitted/false): does NOT advertise io.modelcontextprotocol/ui
    const defaultConn = await connectionManager.save({
      name: "Plain MCP",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://metrics.example.com/mcp",
      mcpAuthMode: "none",
    });
    expect(defaultConn.mcpAppsEnabled).toBeUndefined();
    await connectionManager.test(defaultConn.id);
    expect(mock.receivedInitCapabilities.at(-1)?.extensions).toBeUndefined();

    // 2. Opt-in connection (mcpAppsEnabled: true): advertises io.modelcontextprotocol/ui
    const appConn = await connectionManager.save({
      name: `Metrics MCP (${mock.sentinel})`,
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://metrics-ui.example.com/mcp",
      mcpAuthMode: "none",
      mcpAppsEnabled: true,
    }).catch(async () => {
      // KuloConnections rejects secrets inside public metadata name; save clean name instead.
      return connectionManager.save({
        name: "Metrics MCP",
        kind: "mcp",
        category: "app",
        mcpTransport: "http",
        url: "https://metrics-ui.example.com/mcp",
        mcpAuthMode: "none",
        mcpAppsEnabled: true,
      });
    });
    expect(appConn.mcpAppsEnabled).toBe(true);

    const tested = await connectionManager.test(appConn.id);
    expect(tested.connection.status).toBe("verified");
    expect(mock.receivedInitCapabilities.at(-1)).toMatchObject({
      extensions: {
        [MCP_APP_EXTENSION_ID]: {
          mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
        },
      },
    });
    // summarizeMcpTools hides app-only tools from discovery cache / sampleTools
    expect(tested.connection.mcpTools?.some((t) => t.name === "app_only_refresh")).toBe(false);
    expect(tested.connection.mcpTools?.some((t) => t.name === "get_metrics")).toBe(true);

    // 3. Model list_tools hides visibility: ["app"] tools
    connectionManager.grant("conv:test", 0, [appConn.id]);
    const listRes = await connectionManager.use("conv:test", 0, appConn.id, {
      kind: "mcp",
      action: "list_tools",
    });
    const listPayload = JSON.parse(listRes.output) as { tools: Array<{ name: string; uiResourceUri?: string }> };
    expect(listPayload.tools.some((t) => t.name === "app_only_refresh")).toBe(false);
    expect(listPayload.tools.find((t) => t.name === "get_metrics")?.uiResourceUri).toBe("ui://metrics/dashboard");

    // Model attempting direct call_tool on app-only tool is rejected with 403
    await expect(
      connectionManager.use("conv:test", 0, appConn.id, {
        kind: "mcp",
        action: "call_tool",
        tool: "app_only_refresh",
      }),
    ).rejects.toMatchObject({ status: 403, code: "connection_mcp_tool_app_only" });

    // 4. Calling read-only UI tool via HubConnectionsBridge produces clean LLM plain text AND redacted structuredContent for View
    const useRes = (await hub.connections.use(
      { kind: "orchestrator", conversationId: 1 },
      {
        connectionId: appConn.id,
        operation: { kind: "mcp", action: "call_tool", tool: "get_metrics", arguments: { range: "1h" } },
      },
      {} as never,
    )) as { kind: "mcp"; output: string; mcpApp?: { connectionId: string; connectionName: string; connectionRevision: number; toolName: string; resourceUri: string; title?: string; resultRef?: string; readOnly: true } };

    // LLM output stays clean toLlmContent plain text, redacted, without raw HTML
    expect(useRes.output).toContain("CPU 42%, MEM 61%");
    expect(useRes.output).not.toContain(mock.sentinel);
    expect(useRes.output).not.toContain("<!doctype html>");

    // Inline metadata uses opaque resultRef (no *token fields!) and redacts title
    expect(useRes.mcpApp).toBeDefined();
    expect(useRes.mcpApp?.readOnly).toBe(true);
    expect(useRes.mcpApp?.resourceUri).toBe("ui://metrics/dashboard");
    expect(useRes.mcpApp?.title).not.toContain(mock.sentinel);
    expect(Object.keys(useRes.mcpApp!).some((k) => /token|secret|password|apikey/i.test(k))).toBe(false);

    // 5. Chat display projection attaches mcp-app part while preserving plain text for CLI fallback
    const projected = extractDisplayMessages([
      { id: 1, kind: UserEntry.kind, model: [{ role: "user", content: "show metrics" }], data: {} } as never,
      {
        id: 2,
        kind: AssistantEntry.kind,
        model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "kulo_connection_use", arguments: { connection_id: appConn.id, operation: "mcp", action: "call_tool" } }] }],
        data: {},
      } as never,
      {
        id: 3,
        kind: ToolResultEntry.kind,
        model: [{ role: "toolResult", toolCallId: "call-1", toolName: "kulo_connection_use", isError: false, content: [{ type: "text", text: useRes.output }], details: { kind: "mcp", output: useRes.output, mcpApp: useRes.mcpApp } }],
        data: {},
      } as never,
      {
        id: 4,
        kind: AssistantEntry.kind,
        model: [{ role: "assistant", content: [{ type: "text", text: "当前 CPU 42%，内存 61%。" }] }],
        data: {},
      } as never,
    ]);
    const assistantMsg = projected.find((item) => item.id === 4);
    expect(assistantMsg?.text).toBe("当前 CPU 42%，内存 61%。");
    const appPart = assistantMsg?.parts?.find((p) => p.type === "mcp-app");
    expect(appPart).toBeDefined();
    if (appPart?.type === "mcp-app") {
      expect(appPart.mcpApp.connectionId).toBe(appConn.id);
      expect(messagePartFallback(appPart)).toContain("Metrics MCP");
    }

    // 6. Creating View via Bearer API returns cross-origin sandbox URL and redacted structuredContent
    const createRes = await apiJson<{ view: McpAppViewSession }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: {
        connectionId: appConn.id,
        resourceUri: "ui://metrics/dashboard",
        toolName: "get_metrics",
        title: useRes.mcpApp?.title,
        resultRef: useRes.mcpApp?.resultRef,
        expectedRevision: appConn.revision,
      },
    });
    expect(createRes.status).toBe(201);
    const view = createRes.data.view;
    expect(view.viewId).toMatch(/^mcpv_/);
    expect(view.sessionHandle).toMatch(/^mcps_/);
    expect(Object.keys(view).some((k) => /token|secret/i.test(k))).toBe(false);
    expect(view.sandboxOrigin).not.toBe(new URL(server.url).origin);
    expect(view.sandboxUrl).not.toContain("token=");
    expect(view.initialToolResult?.structuredContent).toMatchObject({
      cpuPercent: 42,
      memoryPercent: 61,
      series: [12, 34, 42],
    });
    expect(JSON.stringify(view.initialToolResult)).not.toContain(mock.sentinel);

    // 7. Fetching ui:// resource validates strict MIME and redacts sentinel secret in HTML
    const resourceRes = await apiJson<{ resource: McpAppResourcePayload }>(server.url, "/api/mcp-apps/resource", {
      method: "POST",
      body: { viewId: view.viewId, uri: "ui://metrics/dashboard" },
    });
    expect(resourceRes.status).toBe(200);
    expect(resourceRes.data.resource.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
    expect(resourceRes.data.resource.html).toContain("Metrics UI");
    expect(resourceRes.data.resource.html).not.toContain(mock.sentinel);

    // 8. Persisting mcp-app metadata into Hub durable SQLite storage passes redaction without SessionFailed
    const recordedMeta = hub.mcpApps.recordToolResult({
      connectionId: appConn.id,
      connectionName: `Metrics ${mock.sentinel} ${vaultSecret}`,
      connectionRevision: appConn.revision,
      toolName: "get_metrics",
      title: `Dashboard ${mock.sentinel} ${vaultSecret}`,
      resourceUri: "ui://metrics/dashboard",
      viewResult: {
        content: [{ type: "text", text: `value ${mock.sentinel} ${vaultSecret}` }],
        structuredContent: { nested: `${mock.sentinel}:${vaultSecret}` },
      },
      readOnly: true,
    });
    expect(recordedMeta.connectionName).not.toContain(mock.sentinel);
    expect(recordedMeta.connectionName).not.toContain(vaultSecret);
    expect(recordedMeta.title).not.toContain(mock.sentinel);
    expect(recordedMeta.title).not.toContain(vaultSecret);
    await expect(
      hub.harness.commit(async (tx) => {
        await tx.appendEntry(
          ToolResultEntry,
          1 as never,
          {
            model: [
              {
                role: "toolResult",
                toolCallId: "call-redaction-sentinel",
                toolName: "kulo_connection_use",
                isError: false,
                content: [{ type: "text", text: "ok" }],
                details: { kind: "mcp", output: "ok", mcpApp: recordedMeta },
              },
            ],
            data: {},
          } as never,
        );
      }, {} as never),
    ).resolves.not.toThrow();
  });

  it("enforces zero-credential cross-origin sandbox proxy, rejects ?token=, bad MIME, >2.5 MiB HTML, unenabled/aggregator/migrated connections", async () => {
    const mock = createMockMcpAppServer();
    const fakeHome = makeTempDir("kulo-mcp-apps-home-");
    // Seed a P0-2 migration source file (Cursor mcp.json) with an HTTP MCP entry
    fs.mkdirSync(path.join(fakeHome, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { migratedMetrics: { url: "https://migrated.example.com/mcp" } } }),
    );

    const { hub, server, connectionManager } = await createHubAndServer({
      mockServer: mock,
      migrationHomeDir: fakeHome,
    });

    // 1. Sandbox proxy lives on separate origin, rejects ?token=, emits strict CSP & frame-ancestors, no cookies
    const cfgRes = await apiJson<McpAppSandboxConfig>(server.url, "/api/mcp-apps/config");
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.data.enabled).toBe(true);
    expect(cfgRes.data.protocolVersion).toBe(MCP_APP_PROTOCOL_VERSION);
    expect(cfgRes.data.sandboxOrigin).toBeTruthy();
    expect(cfgRes.data.sandboxOrigin).not.toBe(new URL(server.url).origin);

    // Web UI HTML CSP header explicitly permits the cross-origin loopback sandbox proxy in frame-src
    const indexRes = await fetch(`${server.url}/`);
    if (indexRes.status === 200) {
      const webCsp = indexRes.headers.get("content-security-policy") ?? "";
      expect(webCsp).toContain(`frame-src 'self' about: ${cfgRes.data.sandboxOrigin}`);
    }

    const proxyRes = await fetch(cfgRes.data.sandboxUrl!);
    expect(proxyRes.status).toBe(200);
    expect(proxyRes.headers.get("set-cookie")).toBeNull();
    expect(proxyRes.headers.get("referrer-policy")).toBe("no-referrer");
    const proxyCsp = proxyRes.headers.get("content-security-policy") ?? "";
    expect(proxyCsp).toContain("default-src 'none'");
    expect(proxyCsp).toContain("connect-src 'none'");
    expect(proxyCsp).toContain("form-action 'none'");
    expect(proxyCsp).toContain(`frame-ancestors`);
    expect(proxyCsp).not.toContain("frame-ancestors *");
    expect(proxyCsp).toContain(new URL(server.url).origin);

    const proxyHtml = await proxyRes.text();
    expect(proxyHtml).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(proxyHtml).not.toContain("allow-same-origin");
    expect(proxyHtml).not.toContain(HUB_TEST_ADMIN_TOKEN);
    expect(buildMcpAppSandboxProxyHtml([server.url])).toContain(MCP_APP_INNER_SANDBOX_CSP.slice(0, 32));

    // Sandbox proxy actively rejects ?token= query parameter
    const proxyTokenRes = await fetch(`${cfgRes.data.sandboxUrl}?token=${HUB_TEST_ADMIN_TOKEN}`);
    expect(proxyTokenRes.status).toBe(400);

    // 2. Hub /api/mcp-apps/* strictly rejects ?token= auth (Bearer-only!) and cross-site origin
    const queryAuthRes = await apiJson<{ error: string; code: string }>(server.url, "/api/mcp-apps/config", {
      token: null,
      queryToken: HUB_TEST_ADMIN_TOKEN,
    });
    expect(queryAuthRes.status).toBe(401);
    expect(queryAuthRes.data.code).toBe("mcp_app_bearer_required");

    const crossSiteRes = await apiJson<{ error: string; code: string }>(server.url, "/api/mcp-apps/config", {
      secFetchSite: "cross-site",
    });
    expect(crossSiteRes.status).toBe(403);

    // 3. Rejects saving Composio or Zapier aggregator with mcpAppsEnabled: true
    await expect(
      connectionManager.save({
        name: "Zapier Hub",
        kind: "mcp",
        category: "app",
        mcpTransport: "http",
        mcpPresetId: "zapier",
        url: "https://mcp.zapier.com/api/v1/connect",
        mcpAuthMode: "none",
        mcpAppsEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 403, code: "connection_mcp_apps_aggregator_forbidden" });

    await expect(
      connectionManager.saveComposioSession({
        name: "Composio Hub",
        kind: "mcp",
        category: "app",
        mcpTransport: "http",
        mcpPresetId: "composio",
        url: "https://backend.composio.dev/api/v3.1",
        mcpAuthMode: "header",
        headerName: "x-api-key",
        mcpComposioUserId: "kulo_0123456789abcdef0123456789abcdef",
        mcpComposioSessionId: "sess_12345678",
        mcpAppsEnabled: true,
        secrets: { apiKey: "comp-key-123456" },
      }),
    ).rejects.toMatchObject({ status: 403, code: "connection_mcp_apps_aggregator_forbidden" });

    // Even a saved Composio connection without mcpAppsEnabled is rejected at view creation
    const savedComposio = await connectionManager.saveComposioSession({
      name: "Composio Hub",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      mcpPresetId: "composio",
      url: "https://backend.composio.dev/api/v3.1",
      mcpAuthMode: "header",
      headerName: "x-api-key",
      mcpComposioUserId: "kulo_0123456789abcdef0123456789abcdef",
      mcpComposioSessionId: "sess_12345678",
      secrets: { apiKey: "comp-key-123456" },
    });
    const compView = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: savedComposio.id, resourceUri: "ui://metrics/dashboard", toolName: "get_metrics" },
    });
    expect(compView.status).toBe(403);
    expect(compView.data.code).toBe("mcp_app_aggregator_forbidden");

    // 4. Unenabled connection rejected with 403
    const disabledAppConn = await connectionManager.save({
      name: "Opt-out MCP",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://plain.example.com/mcp",
      mcpAuthMode: "none",
    });
    const optOutView = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: disabledAppConn.id, resourceUri: "ui://metrics/dashboard", toolName: "get_metrics" },
    });
    expect(optOutView.status).toBe(403);
    expect(optOutView.data.code).toBe("mcp_app_not_enabled");

    // 5. P0-2 migration-imported HTTP MCP connection NEVER inherits mcpAppsEnabled
    const migration = new LocalConfigMigrationService({
      stateDir: makeTempDir("kulo-mig-state-"),
      homeDir: fakeHome,
      connections: connectionManager,
      skills: hub.skills,
      getLocalNodeId: () => "local",
    });
    const scan = await migration.scan({ principalId: "local", isHubLocalDisplay: true });
    const cand = scan.httpMcpCandidates.find((c) => c.name === "migratedMetrics");
    expect(cand).toBeDefined();
    const imported = await migration.importSelected(
      { principalId: "local", isHubLocalDisplay: true },
      { scanId: scan.scanId, mcpCandidateIds: [cand!.candidateId] },
    );
    const createdId = imported.results.find((r) => r.status === "imported")?.createdId;
    expect(createdId).toBeTruthy();
    expect(connectionManager.getConnectionRecord(createdId!)?.mcpAppsEnabled).toBeUndefined();
    const migView = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: createdId!, resourceUri: "ui://metrics/dashboard", toolName: "get_metrics" },
    });
    expect(migView.status).toBe(403);
    expect(migView.data.code).toBe("mcp_app_not_enabled");

    // 6. Wrong MIME (text/html) rejected 415; HTML > 2.5 MiB rejected 413
    const enabledConn = await connectionManager.save({
      name: "Enabled MCP",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://enabled.example.com/mcp",
      mcpAuthMode: "none",
      mcpAppsEnabled: true,
    });
    const wrongMimeView = await apiJson<{ view: McpAppViewSession }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: enabledConn.id, resourceUri: "ui://metrics/wrong-mime", toolName: "get_wrong_mime_view" },
    });
    expect(wrongMimeView.status).toBe(201);
    const wrongMimeRes = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/resource", {
      method: "POST",
      body: { viewId: wrongMimeView.data.view.viewId },
    });
    expect(wrongMimeRes.status).toBe(415);
    expect(wrongMimeRes.data.code).toBe("connection_mcp_app_invalid_mime");

    const bigView = await apiJson<{ view: McpAppViewSession }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: enabledConn.id, resourceUri: "ui://metrics/oversized", toolName: "get_oversized_view" },
    });
    expect(bigView.status).toBe(201);
    const bigRes = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/resource", {
      method: "POST",
      body: { viewId: bigView.data.view.viewId },
    });
    expect(bigRes.status).toBe(413);
    expect(bigRes.data.code).toBe("connection_mcp_app_resource_too_large");
  });

  it("enforces write/visibility denial, concurrency <= 4 throttling, and immediate view invalidation on revision/disable/close", async () => {
    const releaseSlowCalls: Array<() => void> = [];
    const mock = createMockMcpAppServer({
      onSlowCall: () =>
        new Promise((resolve) => {
          releaseSlowCalls.push(() =>
            resolve({ content: [{ type: "text", text: "slow-done" }], structuredContent: { ok: true } }),
          );
        }),
    });
    const { hub, server, connectionManager } = await createHubAndServer({ mockServer: mock });

    const conn = await connectionManager.save({
      name: "Trusted ReadOnly MCP",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://trusted.example.com/mcp",
      mcpAuthMode: "none",
      mcpAppsEnabled: true,
    });

    const created = await apiJson<{ view: McpAppViewSession }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: conn.id, resourceUri: "ui://metrics/dashboard", toolName: "get_metrics" },
    });
    expect(created.status).toBe(201);
    const viewId = created.data.view.viewId;

    // 1. App-only read-only tool succeeds with redacted structuredContent
    const okCall = await apiJson<{ call: McpAppToolCallResponse }>(server.url, "/api/mcp-apps/call", {
      method: "POST",
      body: { viewId, toolName: "app_only_refresh", arguments: { cursor: "42" } },
    });
    expect(okCall.status).toBe(200);
    expect(okCall.data.call.result.structuredContent).toMatchObject({ refreshed: true, cursor: "42" });
    expect(JSON.stringify(okCall.data.call.result)).not.toContain(mock.sentinel);

    // 2. Write tool, spoofed destructive readOnly tool, and model-only tool are ALL rejected with 403
    for (const [toolName, expectedCode] of [
      ["write_record", "connection_mcp_app_write_forbidden"],
      ["delete_sneaky", "connection_mcp_app_write_forbidden"],
      ["model_only_lookup", "connection_mcp_app_tool_visibility_denied"],
    ] as const) {
      const denied = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/call", {
        method: "POST",
        body: { viewId, toolName, arguments: {} },
      });
      expect(denied.status).toBe(403);
      expect(denied.data.code).toBe(expectedCode);
    }

    // 3. Concurrency > 4 per view returns 429
    const inFlight = [1, 2, 3, 4].map((slot) =>
      apiJson<{ call: McpAppToolCallResponse }>(server.url, "/api/mcp-apps/call", {
        method: "POST",
        body: { viewId, toolName: "slow_query", arguments: { slot } },
      }),
    );
    await vi.waitFor(() => expect(releaseSlowCalls.length).toBe(4));
    const fifth = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/call", {
      method: "POST",
      body: { viewId, toolName: "slow_query", arguments: { slot: 5 } },
    });
    expect(fifth.status).toBe(429);
    expect(fifth.data.code).toBe("mcp_app_concurrency_limit");
    for (const release of releaseSlowCalls.splice(0)) release();
    const settled = await Promise.all(inFlight);
    expect(settled.every((r) => r.status === 200)).toBe(true);

    // 4. Different principal cannot use or close another principal's viewId
    expect(() => hub.mcpApps.closeView("foreign-principal", viewId)).toThrowError(/无权关闭/);
    await expect(
      hub.mcpApps.callTool("foreign-principal", { viewId, toolName: "app_only_refresh" }),
    ).rejects.toMatchObject({ status: 403, code: "mcp_app_view_forbidden" });

    // 5. Closing view immediately invalidates viewId (410)
    const closed = await apiJson<{ closed: boolean }>(server.url, `/api/mcp-apps/views/${encodeURIComponent(viewId)}`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(200);
    expect(closed.data.closed).toBe(true);
    const afterClose = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/call", {
      method: "POST",
      body: { viewId, toolName: "app_only_refresh" },
    });
    expect(afterClose.status).toBe(410);

    // 6. Connection revision bump immediately invalidates active viewId (410)
    const view2 = (await apiJson<{ view: McpAppViewSession }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: conn.id, resourceUri: "ui://metrics/dashboard", toolName: "get_metrics" },
    })).data.view;
    const rev2 = await connectionManager.save({
      ...conn,
      name: "Trusted ReadOnly MCP v2",
      id: conn.id,
      expectedRevision: conn.revision,
    });
    expect(rev2.revision).toBe(conn.revision + 1);
    const afterEdit = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/call", {
      method: "POST",
      body: { viewId: view2.viewId, toolName: "app_only_refresh" },
    });
    expect(afterEdit.status).toBe(410);
    expect(afterEdit.data.code).toBe("mcp_app_view_invalidated");

    // 7. Turning off mcpAppsEnabled or removing connection immediately invalidates active viewId (410)
    const view3 = (await apiJson<{ view: McpAppViewSession }>(server.url, "/api/mcp-apps/views", {
      method: "POST",
      body: { connectionId: rev2.id, resourceUri: "ui://metrics/dashboard", toolName: "get_metrics" },
    })).data.view;
    await connectionManager.save({
      ...rev2,
      mcpAppsEnabled: false,
      id: rev2.id,
      expectedRevision: rev2.revision,
    });
    const afterRevoke = await apiJson<{ code: string }>(server.url, "/api/mcp-apps/resource", {
      method: "POST",
      body: { viewId: view3.viewId },
    });
    expect(afterRevoke.status).toBe(410);
  });

  it("allows only cross-origin loopback sandbox proxy in Electron desktop CSP without ever attaching Hub credentials", () => {
    const rendererOrigin = "http://127.0.0.1:7799";
    const sandboxOrigin = "http://127.0.0.1:54321";
    const policy = desktopContentSecurityPolicy(
      '<script>console.log("boot")</script>',
      rendererOrigin,
      false,
      { mcpAppSandboxOrigin: sandboxOrigin },
    );
    const directives = Object.fromEntries(
      policy.split(";").map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/);
        return [name!, rest.join(" ")];
      }),
    );
    expect(directives["frame-src"]).toBe(`'self' about: ${sandboxOrigin}`);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["object-src"]).toBe("'none'");

    // Same-origin or external sandbox origins are strictly ignored in desktop CSP
    const sameOriginPolicy = desktopContentSecurityPolicy("", rendererOrigin, false, {
      mcpAppSandboxOrigin: rendererOrigin,
    });
    expect(sameOriginPolicy).toContain("frame-src 'self' about:;");
    const externalPolicy = desktopContentSecurityPolicy("", rendererOrigin, false, {
      mcpAppSandboxOrigin: "https://evil.example",
    });
    expect(externalPolicy).toContain("frame-src 'self' about:;");

    // Electron request authorization NEVER attaches Hub Bearer credentials to sandbox proxy or from sandbox subframes
    const mainFrame = { origin: rendererOrigin };
    expect(
      shouldAuthorizeDesktopRequest(
        { url: `${rendererOrigin}/api/mcp-apps/views`, webContentsId: 7, frame: mainFrame, method: "POST" },
        rendererOrigin,
        7,
        mainFrame,
      ),
    ).toBe(true);
    // Request TO sandbox proxy -> never authorized
    expect(
      shouldAuthorizeDesktopRequest(
        { url: `${sandboxOrigin}/mcp-app-sandbox`, webContentsId: 7, frame: mainFrame, method: "GET" },
        rendererOrigin,
        7,
        mainFrame,
      ),
    ).toBe(false);
    // Request FROM outer sandbox iframe TO Hub API -> never authorized
    expect(
      shouldAuthorizeDesktopRequest(
        { url: `${rendererOrigin}/api/mcp-apps/call`, webContentsId: 7, frame: { origin: sandboxOrigin }, method: "POST" },
        rendererOrigin,
        7,
        mainFrame,
      ),
    ).toBe(false);
    // Request FROM inner opaque sandbox iframe ("null" origin) TO Hub API -> never authorized
    expect(
      shouldAuthorizeDesktopRequest(
        { url: `${rendererOrigin}/api/mcp-apps/call`, webContentsId: 7, frame: { origin: "null" }, method: "POST" },
        rendererOrigin,
        7,
        mainFrame,
      ),
    ).toBe(false);
  });
});
