import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import { KuloConnections, LocalConnectionVault } from "../packages/hub/src/index.js";
import {
  COMPOSIO_PRESET_ID,
  createComposioConnectLink,
  createComposioSession,
  disconnectComposioAccount,
  generateComposioUserId,
  listComposioAccounts,
} from "../packages/hub/src/composio-bridge.js";
import { handleComposioRoutes } from "../packages/hub/src/composio-routes.js";

const resources: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) {
    await cleanup();
  }
});

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-composio-test-"));
  resources.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeVault(stateDir: string): LocalConnectionVault {
  return new LocalConnectionVault({
    stateDir,
    keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 7) },
  });
}

function attachMockComposioMcpServer(options: {
  tools: Tool[];
  failSessionUrls?: Set<string>;
  url: string;
  onCall?: (name: string, args: Record<string, unknown>) => unknown;
}) {
  const pair = createInMemoryTransportPair();
  pair.server.onMessage((msg: JsonRpcMessage) => {
    if (!("method" in msg) || !("id" in msg)) return;
    if (options.failSessionUrls?.has(options.url)) {
      void pair.server.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "HTTP 404: session not found" },
      });
      return;
    }
    if (msg.method === "initialize") {
      void pair.server.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "composio-tool-router", version: "3.1.0" },
        },
      });
      return;
    }
    if (msg.method === "tools/list") {
      void pair.server.send({ jsonrpc: "2.0", id: msg.id, result: { tools: options.tools } });
      return;
    }
    if (msg.method === "tools/call") {
      const params = (msg.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      const res = options.onCall ? options.onCall(params.name, params.arguments ?? {}) : { content: [{ type: "text", text: "ok" }] };
      void pair.server.send({ jsonrpc: "2.0", id: msg.id, result: res });
    }
  });
  void pair.server.start();
  return pair.client;
}

const COMPOSIO_RAW_TOOLS: Tool[] = [
  { name: "COMPOSIO_SEARCH_TOOLS", description: "Search tools", inputSchema: { type: "object" } },
  { name: "COMPOSIO_GET_TOOL_SCHEMAS", description: "Get schemas", inputSchema: { type: "object" } },
  {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    description: "Execute tools",
    annotations: { readOnlyHint: true }, // Intentionally mis-annotated to verify client-side hard enforcement!
    inputSchema: { type: "object" },
  },
  { name: "COMPOSIO_REMOTE_WORKBENCH", description: "Sandbox", inputSchema: { type: "object" } },
  { name: "COMPOSIO_REMOTE_BASH_TOOL", description: "Bash", inputSchema: { type: "object" } },
  { name: "COMPOSIO_PROXY_EXECUTE", description: "Raw HTTP proxy", inputSchema: { type: "object" } },
  { name: "COMPOSIO_MANAGE_CONNECTIONS", description: "Manage auth", inputSchema: { type: "object" } },
  { name: "_1PASSWORD_GET_ITEM", description: "Leading underscore tool", inputSchema: { type: "object" } },
];

describe("Phase 2: Composio v3.1 bridge, security invariants, and zero-revocation 404 refresh", () => {
  it("creates hardened sessions (workbench/proxy/manage_connections disabled) and rejects untrusted MCP URLs", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      requests.push({ url, body });
      return new Response(
        JSON.stringify({
          session_id: "trs_session_0001",
          mcp: { type: "http", url: "https://backend.composio.dev/tool_router/trs_session_0001/mcp" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const userId = generateComposioUserId();
    const created = await createComposioSession("ak_test_key_1234567890abcdef", {
      userId,
      allowedToolkits: ["gmail", "googlecalendar"],
      baseFetch: mockFetch,
    });
    expect(created).toEqual({
      sessionId: "trs_session_0001",
      mcpUrl: "https://backend.composio.dev/tool_router/trs_session_0001/mcp",
      userId,
    });
    expect(requests[0]?.body).toEqual({
      user_id: userId,
      workbench: { enable: false },
      proxy_execute: { enable: false },
      manage_connections: { enable: false },
      multi_account: { enable: false },
      toolkits: { enable: ["gmail", "googlecalendar"] },
    });

    const evilFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ session_id: "trs_bad_0001", mcp: { type: "http", url: "https://evil.example/mcp" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    await expect(
      createComposioSession("ak_test_key_1234567890abcdef", { userId, baseFetch: evilFetch }),
    ).rejects.toMatchObject({ code: "connection_composio_untrusted_url" });
  });

  it("enforces strict meta-tool allowlist, MULTI_EXECUTE schema/scope guard, readOnly denial, and accurate onOutwardAction", async () => {
    const stateDir = makeStateDir();
    const executedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outwardLabels: string[] = [];

    const connections = new KuloConnections({
      stateDir,
      vault: makeVault(stateDir),
      mcpTransportFactory: ({ record }) =>
        attachMockComposioMcpServer({
          tools: COMPOSIO_RAW_TOOLS,
          url: record.url!,
          onCall: (name, args) => {
            executedCalls.push({ name, args });
            return { content: [{ type: "text", text: `executed:${name}` }] };
          },
        }),
    });
    resources.push(() => connections.closeAsync());
    await connections.initialize();

    const userId = generateComposioUserId();
    const saved = await connections.saveComposioSession({
      name: "Composio",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      mcpPresetId: COMPOSIO_PRESET_ID,
      url: "https://backend.composio.dev/tool_router/trs_live_0001/mcp",
      mcpAuthMode: "header",
      headerName: "x-api-key",
      mcpComposioUserId: userId,
      mcpComposioSessionId: "trs_live_0001",
      mcpAllowedToolkits: ["gmail", "_1password"],
      secrets: { apiKey: "ak_live_key_1234567890abcdef" },
    });
    connections.grant("ticket-1", 1, [saved.id]);

    // 1. list_tools filters out blocked meta-tools
    const listed = await connections.use("ticket-1", 1, saved.id, { kind: "mcp", action: "list_tools" });
    const parsedList = JSON.parse(listed.output) as { tools: Array<{ name: string }> };
    const names = parsedList.tools.map((t) => t.name);
    expect(names).toContain("COMPOSIO_SEARCH_TOOLS");
    expect(names).toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(names).toContain("_1PASSWORD_GET_ITEM");
    expect(names).not.toContain("COMPOSIO_REMOTE_WORKBENCH");
    expect(names).not.toContain("COMPOSIO_REMOTE_BASH_TOOL");
    expect(names).not.toContain("COMPOSIO_PROXY_EXECUTE");
    expect(names).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");

    // 2. Read-only Worker blocked immediately without recording outward action
    await expect(
      connections.use(
        "ticket-1",
        1,
        saved.id,
        { kind: "mcp", action: "call_tool", tool: "COMPOSIO_SEARCH_TOOLS", arguments: {} },
        { readOnly: true, onOutwardAction: (l) => { outwardLabels.push(l); } },
      ),
    ).rejects.toMatchObject({ code: "connection_read_only" });
    expect(outwardLabels).toEqual([]);

    // 3. Blocked meta-tool rejected before onOutwardAction
    await expect(
      connections.use(
        "ticket-1",
        1,
        saved.id,
        { kind: "mcp", action: "call_tool", tool: "COMPOSIO_PROXY_EXECUTE", arguments: {} },
        { onOutwardAction: (l) => { outwardLabels.push(l); } },
      ),
    ).rejects.toMatchObject({ code: "connection_mcp_tool_blocked" });
    expect(outwardLabels).toEqual([]);

    // 4. COMPOSIO_SEARCH_TOOLS skips outward action recording even without readOnlyHint
    await connections.use(
      "ticket-1",
      1,
      saved.id,
      { kind: "mcp", action: "call_tool", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { toolkits: ["gmail"] } },
      { onOutwardAction: (l) => { outwardLabels.push(l); } },
    );
    expect(outwardLabels).toEqual([]);

    // 5. MULTI_EXECUTE rejects sync_response_to_workbench, top-level tool_slug, and out-of-scope toolkits
    await expect(
      connections.use("ticket-1", 1, saved.id, {
        kind: "mcp",
        action: "call_tool",
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }], sync_response_to_workbench: true },
      }),
    ).rejects.toMatchObject({ code: "connection_composio_invalid_args" });

    await expect(
      connections.use("ticket-1", 1, saved.id, {
        kind: "mcp",
        action: "call_tool",
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: { tool_slug: "GMAIL_SEND_EMAIL" },
      }),
    ).rejects.toMatchObject({ code: "connection_composio_invalid_args" });

    await expect(
      connections.use("ticket-1", 1, saved.id, {
        kind: "mcp",
        action: "call_tool",
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: { tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: {} }] },
      }),
    ).rejects.toMatchObject({ code: "connection_composio_toolkit_denied" });

    // 6. Valid MULTI_EXECUTE succeeds and forces expanded outward action label despite upstream readOnlyHint: true
    await connections.use(
      "ticket-1",
      1,
      saved.id,
      {
        kind: "mcp",
        action: "call_tool",
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.com" } }] },
      },
      { onOutwardAction: (l) => { outwardLabels.push(l); } },
    );
    expect(outwardLabels).toEqual(["mcp:Composio:GMAIL_SEND_EMAIL"]);

    // 7. Leading underscore direct tool succeeds when in allowedToolkits
    await connections.use("ticket-1", 1, saved.id, {
      kind: "mcp",
      action: "call_tool",
      tool: "_1PASSWORD_GET_ITEM",
      arguments: {},
    });
    expect(executedCalls.map((c) => c.name)).toContain("_1PASSWORD_GET_ITEM");
  });

  it("blocks prepare()/direct save() bypasses, preserves Vault key on describe(), and transparently refreshes expired 404 sessions without bumping revision", async () => {
    const stateDir = makeStateDir();
    const expiredUrls = new Set(["https://backend.composio.dev/tool_router/trs_expired_01/mcp"]);
    let refreshCount = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/tool_router/session") && init?.method === "POST") {
        refreshCount++;
        const nextId = `trs_refreshed_0${refreshCount}`;
        return new Response(
          JSON.stringify({ session_id: nextId, mcp: { type: "http", url: `https://backend.composio.dev/tool_router/${nextId}/mcp` } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const connections = new KuloConnections({
      stateDir,
      vault: makeVault(stateDir),
      mcpBaseFetch: mockFetch,
      mcpTransportFactory: ({ record }) =>
        attachMockComposioMcpServer({
          tools: COMPOSIO_RAW_TOOLS,
          failSessionUrls: expiredUrls,
          url: record.url!,
        }),
    });
    resources.push(() => connections.closeAsync());
    await connections.initialize();

    const userId = generateComposioUserId();
    // P0-1: prepare() and direct save() must refuse Composio creation
    await expect(
      connections.prepare({ clientId: "tab-1", kind: "mcp", mcpPresetId: "composio" }),
    ).rejects.toMatchObject({ code: "connection_composio_route_required" });

    await expect(
      connections.save({
        name: "Composio",
        kind: "mcp",
        category: "app",
        mcpTransport: "http",
        mcpPresetId: "composio",
        url: "https://backend.composio.dev/tool_router/trs_fake_01/mcp",
        mcpAuthMode: "header",
        headerName: "x-api-key",
        mcpComposioUserId: userId,
        mcpComposioSessionId: "trs_fake_01",
        secrets: { apiKey: "ak_direct_key_1234567890abcd" },
      }),
    ).rejects.toMatchObject({ code: "connection_composio_route_required" });

    // Save through dedicated Composio session path
    const saved = await connections.saveComposioSession({
      name: "Composio",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      mcpPresetId: "composio",
      url: "https://backend.composio.dev/tool_router/trs_expired_01/mcp",
      mcpAuthMode: "header",
      headerName: "x-api-key",
      mcpComposioUserId: userId,
      mcpComposioSessionId: "trs_expired_01",
      mcpAllowedToolkits: ["gmail"],
      secrets: { apiKey: "ak_vault_secret_1234567890abcd" },
    });

    // P0-1: describe() keeps Composio metadata & Vault API key intact
    const renamed = await connections.describe({ id: saved.id, expectedRevision: saved.revision, name: "Work Composio" });
    expect(renamed.mcpComposioUserId).toBe(userId);
    expect(renamed.mcpComposioSessionId).toBe("trs_expired_01");
    expect(renamed.mcpAllowedToolkits).toEqual(["gmail"]);
    expect(renamed.hasCredential).toBe(true);
    expect((await connections.getComposioContext(saved.id)).apiKey).toBe("ak_vault_secret_1234567890abcd");

    // P0-2: 404 session triggers single-flight refresh WITHOUT bumping revision or revoking active Worker grant
    const revBefore = renamed.revision;
    connections.grant("worker-active", 1, [saved.id]);
    const listResult = await connections.use("worker-active", 1, saved.id, { kind: "mcp", action: "list_tools" });
    expect(JSON.parse(listResult.output).tools.length).toBeGreaterThan(0);
    expect(refreshCount).toBe(1);

    const after = connections.getConnectionRecord(saved.id)!;
    expect(after.revision).toBe(revBefore);
    expect(after.mcpComposioSessionId).toBe("trs_refreshed_01");
    expect(after.url).toBe("https://backend.composio.dev/tool_router/trs_refreshed_01/mcp");
    expect(connections.hasGrant("worker-active", 1, saved.id)).toBe(true);
  });

  it("verifies account ownership, passes revoke_on_delete=true, locks /link redirect host, and enforces assertSameOrigin in routes", async () => {
    const deleteUrls: string[] = [];
    const userId = generateComposioUserId();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/connected_accounts?") && init?.method === "GET") {
        return new Response(
          JSON.stringify({
            items: [
              { id: "ca_owned_01", user_id: userId, status: "ACTIVE", toolkit: { slug: "gmail" } },
              { id: "ca_foreign_99", user_id: "kulo_other_user_1234567890", status: "ACTIVE", toolkit: { slug: "slack" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/connected_accounts/") && init?.method === "DELETE") {
        deleteUrls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/tool_router/session/trs_evil/link")) {
        return new Response(JSON.stringify({ redirect_url: "https://phishing.example/steal" }), { status: 200 });
      }
      if (url.endsWith("/tool_router/session/trs_good/link")) {
        return new Response(JSON.stringify({ redirect_url: "https://app.composio.dev/link/lt_valid_1" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const accounts = await listComposioAccounts("ak_key_1234567890abcdef", userId, { baseFetch: mockFetch });
    expect(accounts.map((a) => a.id)).toEqual(["ca_owned_01"]);

    // Cross-user disconnect blocked
    await expect(
      disconnectComposioAccount("ak_key_1234567890abcdef", userId, "ca_foreign_99", { baseFetch: mockFetch }),
    ).rejects.toMatchObject({ code: "connection_composio_account_not_found" });
    expect(deleteUrls).toEqual([]);

    // Owned account disconnect passes revoke_on_delete=true
    await disconnectComposioAccount("ak_key_1234567890abcdef", userId, "ca_owned_01", { baseFetch: mockFetch });
    expect(deleteUrls).toEqual(["https://backend.composio.dev/api/v3.1/connected_accounts/ca_owned_01?revoke_on_delete=true"]);

    // Link redirect URL host pinned to *.composio.dev
    await expect(
      createComposioConnectLink("ak_key_1234567890abcdef", "trs_evil", "gmail", { baseFetch: mockFetch }),
    ).rejects.toMatchObject({ code: "connection_composio_untrusted_url" });
    expect(await createComposioConnectLink("ak_key_1234567890abcdef", "trs_good", "gmail", { baseFetch: mockFetch }))
      .toBe("https://app.composio.dev/link/lt_valid_1");

    // Route handler enforces assertSameOrigin on every endpoint
    const stateDir = makeStateDir();
    const connections = new KuloConnections({ stateDir, vault: makeVault(stateDir), mcpBaseFetch: mockFetch });
    resources.push(() => connections.closeAsync());
    await connections.initialize();

    let originChecks = 0;
    await expect(
      handleComposioRoutes({
        req: { method: "POST" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/api/connections/composio/connect-session",
        connections,
        assertSameOrigin: () => {
          originChecks++;
          throw Object.assign(new Error("cross-site blocked"), { status: 403, code: "connection_origin_required" });
        },
        readJsonObject: async () => ({}),
        sendJson: () => {},
      }),
    ).rejects.toMatchObject({ code: "connection_origin_required" });
    expect(originChecks).toBe(1);
  });

  it("handles full Composio HTTP route lifecycle: create, edit keeping Vault key & clearing toolkits, and /link 404 auto-refresh", async () => {
    const stateDir = makeStateDir();
    let sessionSeq = 0;
    let firstLinkExpired = true;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/tool_router/session") && init?.method === "POST") {
        sessionSeq++;
        const sid = `trs_route_0${sessionSeq}`;
        return new Response(
          JSON.stringify({ session_id: sid, mcp: { type: "http", url: `https://backend.composio.dev/tool_router/${sid}/mcp` } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/tool_router/session/trs_route_02/link") && init?.method === "POST" && firstLinkExpired) {
        firstLinkExpired = false;
        return new Response(JSON.stringify({ message: "session not found" }), { status: 404 });
      }
      if (url.endsWith("/tool_router/session/trs_route_03/link") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ redirect_url: "https://connect.composio.dev/link/lt_recovered" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const connections = new KuloConnections({
      stateDir,
      vault: makeVault(stateDir),
      mcpBaseFetch: mockFetch,
      mcpTransportFactory: ({ record }) =>
        attachMockComposioMcpServer({ tools: COMPOSIO_RAW_TOOLS, url: record.url! }),
    });
    resources.push(() => connections.closeAsync());
    await connections.initialize();

    const invoke = async (method: string, pathname: string, body: Record<string, unknown> = {}) => {
      let status = 0;
      let payload: unknown;
      const handled = await handleComposioRoutes({
        req: { method } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname,
        connections,
        assertSameOrigin: () => {},
        readJsonObject: async () => body,
        sendJson: (_res, s, p) => {
          status = s;
          payload = p;
        },
      });
      return { handled, status, payload: payload as Record<string, unknown> };
    };

    // 1. Create Composio connection
    const created = await invoke("POST", "/api/connections/composio/connect-session", {
      name: "Composio",
      apiKey: "ak_route_secret_1234567890abcd",
      allowedToolkits: ["gmail"],
    });
    expect(created.handled).toBe(true);
    expect(created.status).toBe(201);
    const conn = created.payload.connection as { id: string; revision: number; mcpComposioSessionId: string; mcpAllowedToolkits?: string[] };
    expect(conn.mcpComposioSessionId).toBe("trs_route_01");
    expect(conn.mcpAllowedToolkits).toEqual(["gmail"]);

    // 2. Edit without re-sending apiKey and clearing allowedToolkits -> keeps Vault key!
    const edited = await invoke("POST", "/api/connections/composio/connect-session", {
      id: conn.id,
      expectedRevision: conn.revision,
      name: "Team Composio",
      allowedToolkits: [],
    });
    expect(edited.status).toBe(200);
    const editedConn = edited.payload.connection as { id: string; name: string; revision: number; mcpComposioSessionId: string; mcpAllowedToolkits?: string[]; hasCredential: boolean };
    expect(editedConn.name).toBe("Team Composio");
    expect(editedConn.mcpComposioSessionId).toBe("trs_route_02");
    expect(editedConn.mcpAllowedToolkits).toBeUndefined();
    expect(editedConn.hasCredential).toBe(true);
    expect((await connections.getComposioContext(conn.id)).apiKey).toBe("ak_route_secret_1234567890abcd");

    // 3. /link hits 404 on trs_route_02 -> auto-refreshes to trs_route_03 without bumping revision
    const revBeforeLink = editedConn.revision;
    const linked = await invoke("POST", `/api/connections/${encodeURIComponent(conn.id)}/composio/link`, { toolkit: "gmail" });
    expect(linked.status).toBe(200);
    expect(linked.payload.redirectUrl).toBe("https://connect.composio.dev/link/lt_recovered");
    expect(connections.getConnectionRecord(conn.id)?.revision).toBe(revBeforeLink);
    expect(connections.getConnectionRecord(conn.id)?.mcpComposioSessionId).toBe("trs_route_03");
  });
});
