import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import type { ConnectionRecordView, ConnectionWorkspaceSnapshot, McpOAuthSessionView } from "@kulo/protocol";
import {
  KuloConnections,
  KuloHub,
  LocalConnectionVault,
  MCP_PRESET_CATALOG,
  buildMcpStdioEnv,
  createMcpFetch,
  extractMcpOAuthSecrets,
  isCloudMetadataIp,
  isNonPublicMcpUrl,
  isPrivateOrReservedIp,
  isValidMcpEnvKey,
  mcpOAuthVaultRef,
  parseMcpOAuthVaultEntry,
  sanitizeMcpCallContent,
  serializeMcpOAuthVaultEntry,
  startKuloHubServer,
  validateMcpTargetUrl,
} from "../packages/hub/src/index.js";
import { createSettingsAssistantExtension } from "../packages/hub/src/settings-assistant.js";
import { createExternalAgentToolHandler } from "../packages/hub/src/external-agent-tools.js";
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

function makeStateDir(prefix = "kulo-mcp-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  resources.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeVault(stateDir: string): LocalConnectionVault {
  return new LocalConnectionVault({
    stateDir,
    keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 9) },
  });
}

function attachMockMcpServer(options: {
  serverName?: string;
  getTools: () => Tool[];
  onCall: (name: string, args: Record<string, unknown>) => unknown;
}) {
  const pair = createInMemoryTransportPair();
  pair.server.onMessage((msg: JsonRpcMessage) => {
    if (!("method" in msg) || !("id" in msg)) return;
    if (msg.method === "initialize") {
      void pair.server.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: options.serverName ?? "mock-mcp-server", version: "1.0.0" },
        },
      });
      return;
    }
    if (msg.method === "tools/list") {
      void pair.server.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: options.getTools() },
      });
      return;
    }
    if (msg.method === "tools/call") {
      const params = (msg.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = options.onCall(params.name, params.arguments ?? {});
        void pair.server.send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        void pair.server.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });
  void pair.server.start();
  return {
    client: pair.client,
    notifyToolsChanged: () =>
      pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
  };
}

async function startMockOAuthMcpServer(options?: { requireScopeOnWrite?: string }) {
  let activeAccessToken = "oauth-access-token-initial-secret-9001";
  let activeRefreshToken = "oauth-refresh-token-initial-secret-9002";
  const issuedIdToken = "oauth-id-token-initial-secret-9003";
  const issuedClientSecret = "oauth-client-secret-dcr-9004";
  const issuedRegToken = "oauth-reg-access-token-9005";
  let refreshCount = 0;
  let lastAuthCode: {
    code: string;
    challenge: string;
    redirectUri: string;
    clientId: string;
    scope: string;
  } | null = null;
  let baseUrl = "";

  const readBody = async (req: http.IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          client_id: "dcr-client-id-1",
          client_secret: issuedClientSecret,
          registration_access_token: issuedRegToken,
          redirect_uris: body.redirect_uris ?? [],
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const clientId = url.searchParams.get("client_id") ?? "";
      const scope = url.searchParams.get("scope") ?? "read";
      const code = `auth-code-${Date.now()}`;
      lastAuthCode = { code, challenge, redirectUri, clientId, scope };
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        const code = params.get("code");
        const verifier = params.get("code_verifier") ?? "";
        const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
        if (!lastAuthCode || code !== lastAuthCode.code || expectedChallenge !== lastAuthCode.challenge) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: activeAccessToken,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: activeRefreshToken,
            id_token: issuedIdToken,
            scope: lastAuthCode.scope,
          }),
        );
        return;
      }
      if (grantType === "refresh_token") {
        const providedRefresh = params.get("refresh_token");
        if (providedRefresh !== activeRefreshToken) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        refreshCount += 1;
        activeAccessToken = `oauth-access-token-rotated-${refreshCount}-secret-9999`;
        activeRefreshToken = `oauth-refresh-token-rotated-${refreshCount}-secret-9998`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: activeAccessToken,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: activeRefreshToken,
            scope: "read",
          }),
        );
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${activeAccessToken}`) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { id?: number | string; method: string; params?: Record<string, unknown> };
        if (body.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        if (body.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "Mock OAuth MCP", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (body.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "list_issues",
                    description: "List workspace issues",
                    inputSchema: { type: "object", properties: { team: { type: "string" } } },
                    annotations: { readOnlyHint: true },
                  },
                  {
                    name: "create_issue",
                    description: "Create an issue",
                    inputSchema: { type: "object", properties: { title: { type: "string" } } },
                    annotations: { readOnlyHint: false },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (body.method === "tools/call") {
          const toolName = String(body.params?.name ?? "");
          if (toolName === "create_issue" && options?.requireScopeOnWrite) {
            res.writeHead(403, {
              "content-type": "application/json",
              "www-authenticate": `Bearer error="insufficient_scope", scope="${options.requireScopeOnWrite}"`,
            });
            res.end(JSON.stringify({ error: "insufficient_scope" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: `ok:${toolName}:token=${activeAccessToken}` }],
              },
            }),
          );
          return;
        }
      }
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  resources.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    secrets: () => ({
      accessToken: activeAccessToken,
      refreshToken: activeRefreshToken,
      idToken: issuedIdToken,
      clientSecret: issuedClientSecret,
      regToken: issuedRegToken,
    }),
    refreshCount: () => refreshCount,
  };
}

describe("MCP presets, SSRF guards, and stdio env isolation", () => {
  it("exposes curated official Remote MCP presets with valid HTTPS URLs and unique IDs", () => {
    expect(MCP_PRESET_CATALOG.length).toBeGreaterThanOrEqual(10);
    const ids = new Set<string>();
    for (const preset of MCP_PRESET_CATALOG) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      const parsed = new URL(preset.url);
      expect(parsed.protocol).toBe("https:");
      expect(preset.supportedAuthModes).toContain(preset.authMode);
    }
    expect(MCP_PRESET_CATALOG.find((p) => p.id === "linear")?.authMode).toBe("oauth");
    expect(MCP_PRESET_CATALOG.find((p) => p.id === "context7")?.authMode).toBe("none");
    expect(MCP_PRESET_CATALOG.find((p) => p.id === "slack")?.requiresClientId).toBe(true);
  });

  it("blocks dangerous system env vars and non-public/metadata network targets", () => {
    for (const blocked of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HTTP_PROXY", "KULO_VAULT_KEY", "kulo_auth_token", "lower_case", ""]) {
      expect(isValidMcpEnvKey(blocked)).toBe(false);
    }
    expect(isValidMcpEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isValidMcpEnvKey("CUSTOM_API_KEY_2")).toBe(true);

    expect(isCloudMetadataIp("169.254.169.254")).toBe(true);
    expect(isCloudMetadataIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);

    expect(isNonPublicMcpUrl("http://127.0.0.1:8080/mcp")).toBe(true);
    expect(isNonPublicMcpUrl("https://mcp.internal/mcp")).toBe(true);
    expect(isNonPublicMcpUrl("https://mcp.linear.app/mcp")).toBe(false);

    expect(() => validateMcpTargetUrl("http://mcp.example.com/mcp", { allowPrivateNetwork: false })).toThrow(/HTTPS/);
    expect(() => validateMcpTargetUrl("http://127.0.0.1:8787/mcp", { allowPrivateNetwork: false })).toThrow();
    expect(() => validateMcpTargetUrl("http://127.0.0.1:8787/mcp", { allowPrivateNetwork: true })).not.toThrow();
    expect(() => validateMcpTargetUrl("http://169.254.169.254/latest/meta-data", { allowPrivateNetwork: true })).toThrow();
    expect(() => validateMcpTargetUrl("https://[::ffff:169.254.169.254]/mcp", { allowPrivateNetwork: true })).toThrow();
  });

  it("enforces redirect:error on createMcpFetch so redirects never leak Authorization headers", async () => {
    let seenRedirect: RequestRedirect | undefined;
    const mcpFetch = createMcpFetch({
      allowPrivateNetwork: false,
      baseFetch: async (_input, init) => {
        seenRedirect = init?.redirect;
        return new Response("ok", { status: 200 });
      },
    });
    await mcpFetch("https://mcp.linear.app/mcp", { redirect: "follow" });
    expect(seenRedirect).toBe("error");
    await expect(mcpFetch("http://mcp.linear.app/mcp")).rejects.toThrow(/HTTPS/);
  });

  it("isolates stdio subprocess env vars from Kulo process secrets", () => {
    vi.stubEnv("KULO_VAULT_KEY", "host-vault-key-secret");
    vi.stubEnv("NODE_OPTIONS", "--require=/tmp/evil.js");
    const env = buildMcpStdioEnv(
      { GITHUB_TOKEN: "ghp_secret_123", NODE_OPTIONS: "injected", PATH: "/evil" },
      ["GITHUB_TOKEN", "NODE_OPTIONS", "PATH"],
    );
    expect(env.GITHUB_TOKEN).toBe("ghp_secret_123");
    expect(env.KULO_VAULT_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).not.toBe("/evil");
  });

  it("redacts secrets before truncation across the 10 KiB boundary and summarizes oversized images", async () => {
    const secret = "sk-live-boundary-secret-0123456789ABCDEF";
    const padded = `${"A".repeat(10_220)}${secret}${"B".repeat(500)}`;
    const blocks = await sanitizeMcpCallContent(
      [
        { type: "text", text: padded },
        { type: "image", mimeType: "image/png", data: "x".repeat(70_000) },
      ],
      (text) => text.replaceAll(secret, "[已隐藏]"),
    );
    const out = JSON.stringify(blocks);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("sk-live-boundary");
    expect(out).toContain("image/png");
    expect(out).toContain("Image omitted");
  });
});

describe("MCP connection pool, Worker Fail-Closed, and list_changed governance", () => {
  it("enforces read-only Fail-Closed and refreshes tools live on notifications/tools/list_changed", async () => {
    const stateDir = makeStateDir();
    const vault = makeVault(stateDir);
    let currentTools: Tool[] = [
      {
        name: "search_docs",
        title: "Search docs",
        description: "Read-only documentation lookup",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
      {
        name: "unannotated_tool",
        description: "Missing annotations",
        inputSchema: { type: "object" },
      },
      {
        name: "conflicting_tool",
        description: "Claims read-only and destructive",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
      {
        name: "delete_doc",
        description: "Deletes a document",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ];
    let notifyChanged: (() => Promise<void>) | undefined;
    const manager = new KuloConnections({
      stateDir,
      vault,
      mcpIdleMs: 50,
      mcpTransportFactory: () => {
        const mock = attachMockMcpServer({
          serverName: "Docs MCP",
          getTools: () => currentTools,
          onCall: (name, args) => ({
            content: [{ type: "text", text: `called:${name}:${JSON.stringify(args)}` }],
          }),
        });
        notifyChanged = mock.notifyToolsChanged;
        return mock.client;
      },
    });
    resources.push(() => manager.closeAsync());
    await manager.initialize();

    const saved = await manager.save({
      name: "Docs MCP",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://mcp.example.com/mcp",
      mcpAuthMode: "none",
    });
    const revBeforeTest = saved.revision;
    const tested = await manager.test(saved.id);
    expect(tested.connection.status).toBe("verified");
    expect(tested.connection.mcpServerName).toBe("Docs MCP");
    expect(tested.connection.mcpTools?.length).toBe(4);
    expect(tested.connection.revision).toBe(revBeforeTest);

    // Grant to a read-only Worker
    manager.grant("ticket-ro", 1, [saved.id]);

    // list_tools works for read-only Worker
    const listed = await manager.use(
      "ticket-ro",
      1,
      saved.id,
      { kind: "mcp", action: "list_tools", query: "search" },
      { readOnly: true },
    );
    expect(listed.kind).toBe("mcp");
    expect(listed.output).toContain("search_docs");
    expect(listed.output).not.toContain("delete_doc");

    // Read-only annotated tool succeeds
    const okRead = await manager.use(
      "ticket-ro",
      1,
      saved.id,
      { kind: "mcp", action: "call_tool", tool: "search_docs", arguments: { q: "mcp" } },
      { readOnly: true },
    );
    const parsedOkRead = JSON.parse(okRead.output) as { untrustedData: boolean; content: Array<{ type: string; text: string }> };
    expect(parsedOkRead.untrustedData).toBe(true);
    expect(parsedOkRead.content[0]?.text).toBe('called:search_docs:{"q":"mcp"}');

    // Unannotated, conflicting, and write tools are ALL rejected for read-only Worker (Fail-Closed)
    for (const blocked of ["unannotated_tool", "conflicting_tool", "delete_doc"]) {
      await expect(
        manager.use(
          "ticket-ro",
          1,
          saved.id,
          { kind: "mcp", action: "call_tool", tool: blocked },
          { readOnly: true },
        ),
      ).rejects.toThrow(/只读/);
    }

    // Server flips search_docs to non-readOnly and sends notifications/tools/list_changed
    currentTools = currentTools.map((tool) =>
      tool.name === "search_docs" ? { ...tool, annotations: { readOnlyHint: false } } : tool,
    );
    await notifyChanged?.();
    await new Promise((r) => setTimeout(r, 15));

    // Next read-only Worker call MUST re-fetch live tools and deny search_docs (no TOCTOU!)
    await expect(
      manager.use(
        "ticket-ro",
        1,
        saved.id,
        { kind: "mcp", action: "call_tool", tool: "search_docs" },
        { readOnly: true },
      ),
    ).rejects.toThrow(/只读/);

    // Read-write Worker can call it
    manager.grant("ticket-rw", 1, [saved.id]);
    const okWrite = await manager.use(
      "ticket-rw",
      1,
      saved.id,
      { kind: "mcp", action: "call_tool", tool: "search_docs" },
      { readOnly: false },
    );
    expect(okWrite.output).toContain("called:search_docs");

    // Wait past idle timeout (50ms) and verify lazy reconnect still works
    await new Promise((r) => setTimeout(r, 80));
    const afterIdle = await manager.use(
      "ticket-rw",
      1,
      saved.id,
      { kind: "mcp", action: "call_tool", tool: "search_docs" },
      { readOnly: false },
    );
    expect(afterIdle.output).toContain("called:search_docs");
  });
});

describe("MCP OAuth 2.1 lifecycle inside LocalConnectionVault", () => {
  it("completes DCR + PKCE loopback flow, redacts all tokens across restart, refreshes silently without bumping revision, and protects tokens on cancelled re-auth", async () => {
    const stateDir = makeStateDir();
    const vault = makeVault(stateDir);
    const mock = await startMockOAuthMcpServer();

    const manager = new KuloConnections({ stateDir, vault });
    resources.push(() => manager.closeAsync());
    await manager.initialize();

    const saved = await manager.save({
      name: "Mock Linear",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: mock.mcpUrl,
      mcpAuthMode: "oauth",
    });
    expect(saved.mcpOAuthAuthorized).toBe(false);

    // 1. Start OAuth session and simulate user browser visiting authorizationUrl -> loopback callback
    const session = await manager.mcpOAuth.start({
      connectionId: saved.id,
      owner: { clientId: "tab-1", principalId: "local" },
    });
    expect(session.status).toBe("pending");
    expect(session.authorizationUrl).toContain(`${mock.baseUrl}/authorize`);

    // Wrong owner cannot read, complete, or cancel
    expect(() => manager.mcpOAuth.get(session.sessionId, { clientId: "tab-2", principalId: "local" })).toThrow();

    // Simulate browser following /authorize -> 302 -> loopback callback
    const authRes = await fetch(session.authorizationUrl!, { redirect: "follow" });
    expect(authRes.status).toBe(200);

    // Wait for session to settle to completed
    let current: McpOAuthSessionView = session;
    for (let i = 0; i < 40 && current.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      current = manager.mcpOAuth.get(session.sessionId, { clientId: "tab-1", principalId: "local" });
    }
    expect(current.status).toBe("completed");
    expect(current.connection?.status).toBe("verified");
    expect(current.connection?.mcpOAuthAuthorized).toBe(true);
    expect(current.connection?.mcpTools?.map((t) => t.name)).toContain("list_issues");

    // Verify all 5 OAuth secrets are stored in Vault and extracted for redaction
    const rawVault = await vault.get(mcpOAuthVaultRef(saved.id));
    const parsedState = parseMcpOAuthVaultEntry(rawVault);
    expect(parsedState?.tokens?.access_token).toBe(mock.secrets().accessToken);
    const extracted = extractMcpOAuthSecrets(parsedState);
    expect(extracted).toEqual(
      expect.arrayContaining([
        mock.secrets().accessToken,
        mock.secrets().refreshToken,
        mock.secrets().idToken,
        mock.secrets().clientSecret,
        mock.secrets().regToken,
      ]),
    );

    // 2. Restart KuloConnections on the same stateDir + vault -> verify startup redaction + authorized flag without live probe
    await manager.closeAsync();
    const restarted = new KuloConnections({ stateDir, vault });
    resources.push(() => restarted.closeAsync());
    await restarted.initialize();

    for (const secret of Object.values(mock.secrets())) {
      expect(restarted.redact(`leaked=${secret}`)).not.toContain(secret);
    }
    const snapAfterRestart = await restarted.snapshot();
    const recordAfterRestart = snapAfterRestart.connections.find((c) => c.id === saved.id)!;
    expect(recordAfterRestart.mcpOAuthAuthorized).toBe(true);
    const revBeforeRefresh = recordAfterRestart.revision;

    // 3. Cancel a re-auth session and prove live Vault tokens are NOT wiped
    const reauth = await restarted.mcpOAuth.start({
      connectionId: saved.id,
      owner: { clientId: "tab-1", principalId: "local" },
      forceReauth: true,
    });
    expect(reauth.status).toBe("pending");
    await restarted.mcpOAuth.cancel(reauth.sessionId, { clientId: "tab-1", principalId: "local" });
    const afterCancel = parseMcpOAuthVaultEntry(await vault.get(mcpOAuthVaultRef(saved.id)));
    expect(afterCancel?.tokens?.access_token).toBe(mock.secrets().accessToken);

    // 4. Expire stored access_token in Vault, grant Worker, call_tool -> silent refresh MUST succeed WITHOUT bumping revision!
    const expiredState = {
      ...afterCancel!,
      tokensExpireAt: Date.now() - 5_000,
    };
    await vault.set(mcpOAuthVaultRef(saved.id), serializeMcpOAuthVaultEntry(rawVault!.__binding!, expiredState));

    restarted.grant("ticket-oauth", 1, [saved.id]);
    const callRes = await restarted.use(
      "ticket-oauth",
      1,
      saved.id,
      { kind: "mcp", action: "call_tool", tool: "list_issues" },
      { readOnly: true },
    );
    expect(mock.refreshCount()).toBe(1);
    // Output contained the rotated access token on server side, and MUST be redacted!
    expect(callRes.output).toContain("ok:list_issues:token=");
    expect(callRes.output).not.toContain(mock.secrets().accessToken);
    expect(restarted.getConnectionRecord(saved.id)?.revision).toBe(revBeforeRefresh);

    // 5. Changing URL wipes mcp-oauth:<id> so tokens never forward to a new origin
    const updated = await restarted.save({
      id: saved.id,
      expectedRevision: revBeforeRefresh,
      name: "Mock Linear",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://mcp.linear.app/mcp",
      mcpAuthMode: "oauth",
    });
    expect(updated.mcpOAuthAuthorized).toBe(false);
    expect(await vault.get(mcpOAuthVaultRef(saved.id))).toBeUndefined();
  });

  it("supports manual pasted redirect URL completion for remote/headless clients", async () => {
    const stateDir = makeStateDir();
    const vault = makeVault(stateDir);
    const mock = await startMockOAuthMcpServer();

    const manager = new KuloConnections({ stateDir, vault });
    resources.push(() => manager.closeAsync());
    await manager.initialize();

    const saved = await manager.save({
      name: "Manual OAuth MCP",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: mock.mcpUrl,
      mcpAuthMode: "oauth",
    });

    const session = await manager.mcpOAuth.start({
      connectionId: saved.id,
      owner: { clientId: "remote-tab", principalId: "remote-dev" },
    });
    // Hit /authorize WITHOUT following redirect so loopback never receives it automatically
    const authRes = await fetch(session.authorizationUrl!, { redirect: "manual" });
    expect(authRes.status).toBe(302);
    const redirectLocation = authRes.headers.get("location")!;
    expect(redirectLocation).toContain("code=");

    const completed = await manager.mcpOAuth.complete(
      session.sessionId,
      { clientId: "remote-tab", principalId: "remote-dev" },
      redirectLocation,
    );
    expect(completed.status).toBe("completed");
    expect(completed.connection?.mcpOAuthAuthorized).toBe(true);
  });
});

describe("MCP Hub, HTTP management gates, settings assistant, and external agent boundaries", () => {
  it("enforces localHost/same-origin gates, strips full mcpTools in Hub list, blocks unsafe prepare, and executes MCP via external-agent tool", async () => {
    const stateDir = makeStateDir("kulo-mcp-hub-");
    const vault = makeVault(stateDir);
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "mcp-test", models: [{ id: "test" }] }).provider);

    const mockTools: Tool[] = Array.from({ length: 16 }, (_, idx) => ({
      name: `tool_${idx + 1}`,
      description: `Tool number ${idx + 1}`,
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      annotations: { readOnlyHint: true },
    }));

    const manager = new KuloConnections({
      stateDir,
      vault,
      mcpTransportFactory: () =>
        attachMockMcpServer({
          serverName: "Hub Mock MCP",
          getTools: () => mockTools,
          onCall: (name) => ({ content: [{ type: "text", text: `ran:${name}` }] }),
        }).client,
    });
    const hub = await KuloHub.open({
      models,
      providerId: "mcp-test",
      connectionManager: manager,
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        localEnvRoot: path.join(stateDir, "workspace"),
        enableLocalEnv: false,
        authToken: HUB_TEST_ADMIN_TOKEN,
        envTokens: {},
        workerEnvIds: [],
        memory: { enabled: false },
        watchdogMinutes: 0,
        model: { defaultProvider: "mcp-test", defaultModel: "test", thinkingLevel: "off", apiKey: "" },
      },
    });
    resources.push(() => hub.close());
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    resources.push(() => server.close());

    const req = (
      endpoint: string,
      method = "GET",
      body?: unknown,
      extraHeaders?: Record<string, string>,
    ) =>
      fetch(`${server.url}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    // 1. GET /api/connections includes curated presets
    const snapRes = await req("/api/connections");
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as ConnectionWorkspaceSnapshot;
    expect(snap.mcpPresets?.length).toBe(MCP_PRESET_CATALOG.length);
    expect(snap.localHost).toBe(true);

    // 2. Cross-origin and remote non-localHost rejected on local stdio / loopback HTTP MCP
    const crossOrigin = await req(
      "/api/connections",
      "POST",
      { name: "Local Stdio", kind: "mcp", category: "app", mcpTransport: "stdio", mcpCommand: "echo" },
      { Origin: "https://evil.example" },
    );
    expect(crossOrigin.status).toBe(403);

    const remoteStdio = await req(
      "/api/connections",
      "POST",
      { name: "Remote Stdio", kind: "mcp", category: "app", mcpTransport: "stdio", mcpCommand: "echo" },
      { "X-Forwarded-For": "203.0.113.5" },
    );
    expect(remoteStdio.status).toBe(403);

    const remoteLoopback = await req(
      "/api/connections",
      "POST",
      { name: "Remote Loopback", kind: "mcp", category: "app", mcpTransport: "http", url: "http://127.0.0.1:8787/mcp", mcpAuthMode: "none" },
      { "X-Forwarded-For": "203.0.113.5" },
    );
    expect(remoteLoopback.status).toBe(403);

    // 3. Create public HTTP MCP and test discovery (16 tools)
    const createdRes = await req("/api/connections", "POST", {
      name: "Linear",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      mcpPresetId: "linear",
      url: "https://mcp.linear.app/mcp",
      mcpAuthMode: "none",
    });
    expect(createdRes.status).toBe(201);
    const { connection: created } = (await createdRes.json()) as { connection: ConnectionRecordView };
    const testRes = await req(`/api/connections/${created.id}/test`, "POST");
    expect(testRes.status).toBe(200);

    // 4. Settings assistant kulo_connection_prepare rejects stdio args & accepts public HTTPS MCP
    const preparedInputs: unknown[] = [];
    const ext = createSettingsAssistantExtension(() => ({
      prepareConnection: async (input: Record<string, unknown>) => {
        if (typeof input.url === "string" && (!input.url.startsWith("https://") || isNonPublicMcpUrl(input.url))) {
          throw new Error("助手只能预填公开的 HTTPS MCP 地址");
        }
        preparedInputs.push(input);
        return manager.prepare({ clientId: "settings-tab", ...(input as never) });
      },
    }) as never);
    const prepareTool = ext.tools!.find((tool) => tool.name === "kulo_connection_prepare")!;
    expect(prepareTool).toBeDefined();

    await expect(
      prepareTool.execute({ kind: "mcp", name: "Bad Stdio", mcp_transport: "stdio" } as never, { callId: "c1" } as never, {} as never),
    ).rejects.toThrow();
    await expect(
      prepareTool.execute({ kind: "mcp", name: "Bad Loopback", url: "http://127.0.0.1:8080/mcp" } as never, { callId: "c2" } as never, {} as never),
    ).rejects.toThrow();
    const okPrep = await prepareTool.execute(
      { kind: "mcp", mcp_preset_id: "linear" } as never,
      { callId: "c3" } as never,
      {} as never,
    );
    expect(JSON.stringify(okPrep)).toContain("Linear");
    expect(preparedInputs.at(-1)).toMatchObject({ kind: "mcp", mcpPresetId: "linear" });

    // 5. External agent tool: kulo_connection_use(operation="mcp") works when granted and hub list strips full mcpTools
    const handler = createExternalAgentToolHandler({
      read: async (scope) => ({
        ticket: {
          id: scope.taskId,
          envId: scope.envId,
          runEpoch: scope.runEpoch,
          status: "running",
          waiting: false,
          readOnly: true,
          connectionIds: scope.taskId === "ext-1" ? [created.id] : [],
          externalExecution: { runId: scope.runId, binding: { envId: scope.envId } },
        },
      } as never),
      agents: async () => [],
      report: async () => ({ ok: true }),
      delegate: async () => ({ ok: true }),
      inspect: async () => ({ ok: true }),
      connectionsList: async (scope) => {
        const granted = scope.taskId === "ext-1" ? [created.id] : [];
        const all = (await manager.snapshot()).connections.filter((c) => granted.includes(c.id));
        return {
          connections: all.map(({ mcpTools, ...rest }) =>
            rest.kind === "mcp"
              ? { ...rest, toolCount: mcpTools?.length ?? 0, sampleTools: (mcpTools ?? []).slice(0, 12).map((t) => ({ name: t.name, readOnly: t.readOnly })) }
              : rest,
          ),
        };
      },
      connectionUse: async (scope, input) =>
        manager.use(scope.taskId, scope.runEpoch, input.connectionId, input.operation, { readOnly: true }),
    });

    const grantedScope = { taskId: "ext-1", runId: "run-1", runEpoch: 1, envId: "local" };
    const ungrantedScope = { taskId: "ext-2", runId: "run-2", runEpoch: 1, envId: "local" };
    manager.grant("ext-1", 1, [created.id]);

    // Projected connection list caps sampleTools to 12 and omits full mcpTools
    const parsedList = (await handler({ ...grantedScope, name: "kulo_connections", args: {} })) as { connections: Array<Record<string, unknown>> };
    expect(parsedList.connections[0]?.toolCount).toBe(16);
    expect((parsedList.connections[0]?.sampleTools as unknown[]).length).toBe(12);
    expect(parsedList.connections[0]?.mcpTools).toBeUndefined();

    // Ungranted external agent rejected
    await expect(
      handler({
        ...ungrantedScope,
        name: "kulo_connection_use",
        args: { connection_id: created.id, operation: "mcp", action: "list_tools" },
      }),
    ).rejects.toThrow();

    // Granted external agent succeeds on list_tools and call_tool
    const listToolsOut = await handler({
      ...grantedScope,
      name: "kulo_connection_use",
      args: {
        connection_id: created.id,
        operation: "mcp",
        action: "list_tools",
        params_json: JSON.stringify({ query: "tool_1", limit: 5 }),
      },
    });
    expect(JSON.stringify(listToolsOut)).toContain("tool_1");

    const callToolOut = await handler({
      ...grantedScope,
      name: "kulo_connection_use",
      args: {
        connection_id: created.id,
        operation: "mcp",
        action: "call_tool",
        params_json: JSON.stringify({ tool: "tool_1", arguments: { q: "hi" } }),
      },
    });
    expect(JSON.stringify(callToolOut)).toContain("ran:tool_1");
  });
});
