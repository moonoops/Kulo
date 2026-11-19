import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { SearchPlanView } from "../packages/protocol/src/search";
import { classifySearchMcpError, duckProxyForTarget, searchMcpStdioEnvironment, withSearchMcp } from "../packages/hub/src/search-mcp";
import { startSearchMcpFixture } from "../packages/hub/test/search-mcp-fixture";

function plan(adapter: SearchPlanView["adapter"], baseUrl?: string): SearchPlanView {
  return { id: "mcp-fixture", name: "Fixture", adapter, enabled: true, hasCredential: adapter === "brave", revision: 1, status: "unverified", createdAt: 1, updatedAt: 1, ...(baseUrl ? { baseUrl } : {}) };
}
const localFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "127.0.0.1") throw new Error("Only local fixture connections are permitted");
  return fetch(request);
};
const cleanups: Array<() => Promise<unknown>> = [];
async function tempDir() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moco-search-mcp-test-")); cleanups.push(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
async function fixture(options: Parameters<typeof startSearchMcpFixture>[0]) { const server = await startSearchMcpFixture(options); cleanups.push(() => server.close()); return server; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("standard MCP transport lifecycle", () => {
  it("closes a real MCP session after tool errors and redacts upstream diagnostics", async () => {
    const server = await fixture({ tools: [{ name: "web_search_exa" }], onCall: () => ({ isError: true, content: [{ type: "text", text: "HTTP 401 invalid_api_key fixture-secret-key url=https://secret.example" }] }) });
    const result = withSearchMcp({ plan: plan("exa", server.url), fetch: localFetch }, (session) => session.call("web_search_exa", { query: "q" }));
    await expect(result).rejects.toMatchObject({ failure: { kind: "auth", upstreamStatus: 401, upstreamCode: "invalid_api_key", retryable: false } });
    await expect(result).rejects.not.toThrow("fixture-secret-key");
    expect(server.activeSessions).toBe(0);
  });

  it("cancels the pending MCP call and deletes its session even with an aborted operation signal", async () => {
    let upstreamAborted = false;
    const server = await fixture({ tools: [{ name: "web_search_exa" }], onCall: (_name, _args, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { upstreamAborted = true; resolve({ content: [] }); }, { once: true }); }) });
    const abort = new AbortController();
    const pending = withSearchMcp({ plan: plan("exa", server.url), signal: abort.signal, fetch: localFetch }, (session) => session.call("web_search_exa", { query: "q" }));
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => server.calls.length).toBe(1);
    abort.abort(); await rejection;
    expect(server.activeSessions).toBe(0);
    await expect.poll(() => upstreamAborted).toBe(true);
  });

  it.each([{ header: false, contentType: "application/json" }, { header: true, contentType: "application/json" }, { header: false, contentType: "text/event-stream" }])("rejects oversized HTTP bodies before MCP parsing ($contentType, content-length=$header)", async ({ header, contentType }) => {
    let cancelled = false;
    const pulls: number[] = [];
    const http: typeof fetch = async () => {
      const index = pulls.push(0) - 1;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls[index]++; controller.enqueue(new Uint8Array(512 * 1024)); }, cancel() { cancelled = true; } }), { headers: { "content-type": contentType, ...(header ? { "content-length": "3000000" } : {}) } });
    };
    await expect(withSearchMcp({ plan: plan("exa", "https://mcp.example.com/mcp"), fetch: http }, async () => null)).rejects.toMatchObject({ failure: { kind: "upstream" } });
    expect(cancelled).toBe(true);
    expect(Math.max(...pulls)).toBeLessThanOrEqual(7);
  });

  it("classifies status, timeout, and network causes without returning raw text", () => {
    expect(classifySearchMcpError({ status: 402, message: "credential fixture-secret" }).failure).toMatchObject({ kind: "quota", upstreamStatus: 402, retryable: false });
    expect(classifySearchMcpError({ status: 429, message: "rate_limit_exceeded" }).failure).toMatchObject({ kind: "rate_limit", upstreamCode: "rate_limit_exceeded", retryable: true });
    expect(classifySearchMcpError(new Error("fetch failed", { cause: new Error("ECONNREFUSED fixture-secret") })).failure).toMatchObject({ kind: "network", retryable: true });
    const cyclic = new Error("TimeoutError fixture-secret"); cyclic.cause = cyclic;
    expect(classifySearchMcpError(cyclic).failure).toMatchObject({ kind: "timeout" });
    expect(JSON.stringify(classifySearchMcpError(cyclic).failure)).not.toContain("fixture-secret");
  });

  it("rejects missing credentials and credential-bearing endpoints before HTTP", async () => {
    const http = vi.fn();
    await expect(withSearchMcp({ plan: plan("tavily"), fetch: http }, async () => null)).rejects.toMatchObject({ failure: { kind: "auth" } });
    await expect(withSearchMcp({ plan: plan("exa", "https://user:password@mcp.example.com/mcp"), fetch: http }, async () => null)).rejects.toMatchObject({ failure: { kind: "invalid_request" } });
    expect(http).not.toHaveBeenCalled();
  });
});

describe("official stdio isolation", () => {
  it("passes only a controlled environment and the active Brave account key", () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-model-key"); vi.stubEnv("BRAVE_API_KEY", "different-account-key"); vi.stubEnv("PI_CODING_AGENT_DIR", "/global/pi"); vi.stubEnv("NODE_OPTIONS", "--require /unsafe.js"); vi.stubEnv("HOME", "/private/home");
    const brave = searchMcpStdioEnvironment({ plan: plan("brave"), apiKey: "active-account-key" });
    expect(brave).toMatchObject({ BRAVE_API_KEY: "active-account-key", BRAVE_MCP_TRANSPORT: "stdio", BRAVE_MCP_ENABLED_TOOLS: "brave_llm_context brave_web_search", HOME: "" });
    expect(brave.OPENAI_API_KEY).toBeUndefined(); expect(brave.PI_CODING_AGENT_DIR).toBeUndefined(); expect(brave.NODE_OPTIONS).toBeUndefined();
    const duck = searchMcpStdioEnvironment({ plan: plan("duckduckgo") }, "/controlled/pi");
    expect(duck.PI_CODING_AGENT_DIR).toBe("/controlled/pi"); expect(duck.BRAVE_API_KEY).toBeUndefined(); expect(duck.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/global/pi");
  });

  it("connects to the installed official Brave server without an upstream API request", async () => {
    const names = await withSearchMcp({ plan: plan("brave"), apiKey: "dummy-no-upstream-call" }, async (session) => {
      const llm = session.tools.find((tool) => tool.name === "brave_llm_context");
      expect(llm?.inputSchema.required).toContain("query");
      expect(llm?.inputSchema.properties).toHaveProperty("query");
      return session.tools.map((tool) => tool.name);
    });
    expect(names.sort()).toEqual(["brave_llm_context", "brave_web_search"]);
  }, 15000);

  it("connects to isolated Duck MCP with model, cookie, remote-fetch and GitHub execution disabled", async () => {
    const stateDir = await tempDir();
    const names = await withSearchMcp({ plan: plan("duckduckgo"), stateDir }, async (session) => session.tools.map((tool) => tool.name));
    expect(names).toContain("web_search"); expect(names).toContain("fetch_content"); expect(names).toContain("get_search_content");
    const file = path.join(stateDir, "search-mcp", "duckduckgo", "mcp-fixture", "web-search.json");
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ allowBrowserCookies: false, ssrf: { trustEnvProxy: false, allowRanges: [] }, provider: "duckduckgo", webSearch: { allowedProviders: ["duckduckgo"] }, searchRouting: { providers: ["duckduckgo"] }, fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false }, githubClone: { enabled: false }, githubPrIssue: { enabled: false }, geminiWeb: { enabled: false }, image: { enabled: false } });
    expect(raw).not.toMatch(/apiKey|cookie|native|auto/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(file))).some((name) => name.endsWith(".tmp"))).toBe(false);
  }, 15000);

  it("honors per-target NO_PROXY when choosing Duck's explicit proxy", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9999"); vi.stubEnv("https_proxy", ""); vi.stubEnv("NO_PROXY", "example.com"); vi.stubEnv("no_proxy", "");
    expect(duckProxyForTarget("https://example.com/a")).toBe("");
    expect(duckProxyForTarget("https://duckduckgo.com/")).toBe("http://127.0.0.1:9999/");
  });

  it("boots stdio fetch through the configured proxy without changing the parent fetch", async () => {
    const directory = await tempDir();
    const probe = path.join(directory, "probe.mjs");
    await fs.writeFile(probe, 'process.stdout.write(await (await fetch("http://search-probe.example/probe")).text());');
    const origin = createServer((_req, res) => res.end("proxied-stdio-result"));
    const proxy = createServer();
    const tunnels: string[] = [];
    const sockets = new Set<import("node:net").Socket>();
    proxy.on("connect", (req, socket, head) => {
      tunnels.push(req.url!); const upstream = connect((origin.address() as { port: number }).port, "127.0.0.1");
      sockets.add(upstream); sockets.add(socket); upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
      upstream.on("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); origin.closeAllConnections(); proxy.closeAllConnections(); await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]); });
    const require = createRequire(import.meta.url);
    const originalFetch = globalThis.fetch;
    const env = searchMcpStdioEnvironment({ plan: plan("brave"), apiKey: "fake" });
    Object.assign(env, { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, http_proxy: "", HTTPS_PROXY: "", https_proxy: "", ALL_PROXY: "", all_proxy: "", NO_PROXY: "", no_proxy: "" });
    const output = await promisify(execFile)(process.execPath, ["--import", require.resolve("tsx"), path.resolve("packages/hub/src/search-mcp-stdio.ts"), probe], { env, timeout: 10000 });
    expect(output.stdout).toBe("proxied-stdio-result");
    expect(tunnels).toEqual(["search-probe.example:80"]); expect(globalThis.fetch).toBe(originalFetch);
  }, 15000);
});
