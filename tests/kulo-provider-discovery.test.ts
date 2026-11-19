import fs from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderApi } from "@kulo/protocol";
import type { KuloModelConfig } from "../packages/hub/src/config";
import { MAINSTREAM_PROVIDER_PRESETS, KuloProviderManager } from "../packages/hub/src/providers";
import { fetchLiveProviderModels } from "../packages/hub/src/provider-discovery";
import { vertexPublicCatalogDocuments } from "./helpers/vertex-public-catalog";

const dirs: string[] = [];
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function manager() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-live-models-"));
  dirs.push(stateDir);
  return new KuloProviderManager({ stateDir });
}
function config(overrides: Partial<KuloModelConfig> = {}): KuloModelConfig {
  return {
    baseUrl: "https://models.example/v1", apiMode: "openai-completions", defaultProvider: "api-test", defaultModel: "configured-model",
    thinkingLevel: "off", contextWindow: 100_000, gatewayDisabled: true,
    compaction: { enabled: false, reserveTokens: 10_000, keepRecentTokens: 20_000, backgroundTokens: 30_000 },
    customProviders: [{ id: "api-test", name: "Test", api: "openai-completions", baseUrl: "https://models.example/v1", models: [{ id: "configured-model" }] }],
    ...overrides,
  };
}
async function connectProxy(handler: http.RequestListener) {
  const sockets = new Set<Duplex>();
  const connections: Array<{ authority: string; headers: http.IncomingHttpHeaders }> = [];
  const upstream = http.createServer(handler);
  const proxy = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
  for (const server of [upstream, proxy]) server.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  proxy.on("connect", (request, client, head) => {
    connections.push({ authority: request.url ?? "", headers: request.headers });
    const destination = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) destination.write(head);
      client.pipe(destination); destination.pipe(client);
    });
    sockets.add(destination); destination.once("close", () => sockets.delete(destination));
    destination.on("error", () => client.destroy());
    client.on("error", () => destination.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  return {
    baseUrl: "http://model-discovery-dns-unresolvable.invalid/v1",
    localUrl: `http://127.0.0.1:${port}/v1`,
    proxyUrl: `http://proxy-user:dummy-proxy-password@127.0.0.1:${proxyPort}`,
    connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, upstream].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}
beforeEach(() => {
  vi.stubEnv("KULO_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Live provider model discovery", () => {
  it("loads a fresh catalog through the configured CONNECT proxy without locally resolving the target", async () => {
    const requests: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
    let generation = 0;
    const fixture = await connectProxy((request, response) => {
      requests.push({ path: request.url ?? "", headers: request.headers });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: `live-proxy-model-${++generation}` }] }));
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error("Unexpected direct request")); vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HTTP_PROXY", fixture.proxyUrl);
    try {
      const providerManager = manager();
      for (const number of [1, 2]) {
        const result = await providerManager.discoverModels({ api: "openai-completions", baseUrl: fixture.baseUrl, apiKey: "dummy-provider-key" });
        expect(result.models.map((model) => model.id)).toEqual([`live-proxy-model-${number}`]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fixture.connections.map((connection) => connection.authority)).toEqual([
        "model-discovery-dns-unresolvable.invalid:80", "model-discovery-dns-unresolvable.invalid:80",
      ]);
      expect(fixture.connections[0].headers.authorization).toBeUndefined();
      expect(fixture.connections[0].headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("proxy-user:dummy-proxy-password").toString("base64")}`);
      expect(requests[0]).toMatchObject({ path: "/v1/models", headers: { authorization: "Bearer dummy-provider-key", "cache-control": "no-cache, no-store" } });
      expect(requests[0].headers["proxy-authorization"]).toBeUndefined();
    } finally { await fixture.close(); }
  });

  it("honors NO_PROXY and keeps loopback catalogs outside the proxy", async () => {
    const fixture = await connectProxy((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "local-model" }] })); });
    vi.stubEnv("HTTP_PROXY", fixture.proxyUrl);
    vi.stubEnv("NO_PROXY", ".invalid");
    const directFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "no-proxy-model" }] })); vi.stubGlobal("fetch", fetchMock);
    try {
      expect((await manager().discoverModels({ api: "openai-completions", baseUrl: fixture.baseUrl })).models.map((model) => model.id)).toEqual(["no-proxy-model"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.stubGlobal("fetch", directFetch);
      vi.stubEnv("NO_PROXY", "");
      expect((await manager().discoverModels({ api: "openai-completions", baseUrl: fixture.localUrl })).models.map((model) => model.id)).toEqual(["local-model"]);
      expect(fixture.connections).toEqual([]);
    } finally { await fixture.close(); }
  });

  it("does not forward a provider key to a proxy response's redirect destination", async () => {
    let firstKey: string | undefined;
    const fixture = await connectProxy((request, response) => {
      firstKey = request.headers["x-api-key"] as string | undefined;
      response.writeHead(302, { Location: "http://redirected-models.invalid/models" }); response.end();
    });
    vi.stubEnv("HTTP_PROXY", fixture.proxyUrl);
    try {
      const result = await manager().discoverModels({ api: "anthropic-messages", baseUrl: fixture.baseUrl, apiKey: "dummy-redirect-key" });
      expect(result).toMatchObject({ ok: false, models: [] });
      expect(result.error).toContain("重定向");
      expect(firstKey).toBe("dummy-redirect-key");
      expect(fixture.connections).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it("cancels a stalled proxy request using the caller signal", async () => {
    const fixture = await connectProxy(() => {});
    vi.stubEnv("HTTP_PROXY", fixture.proxyUrl);
    try {
      await expect(fetchLiveProviderModels({ api: "openai-completions", baseUrl: fixture.baseUrl, signal: AbortSignal.timeout(50) })).rejects.toThrow(/取消|超时/);
      expect(fixture.connections).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it("bounds decompression of a proxy catalog response", async () => {
    const compressed = gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, "x"));
    const fixture = await connectProxy((_request, response) => { response.writeHead(200, { "Content-Encoding": "gzip" }); response.end(compressed); });
    vi.stubEnv("HTTP_PROXY", fixture.proxyUrl);
    try {
      const result = await manager().discoverModels({ api: "openai-completions", baseUrl: fixture.baseUrl });
      expect(result).toMatchObject({ ok: false, models: [] });
      expect(result.error).toContain("大小限制");
    } finally { await fixture.close(); }
  });

  it.each(MAINSTREAM_PROVIDER_PRESETS.filter((preset) => preset.api !== "google-vertex"))("requests fresh IDs for $name without appending its bundled catalog", async (preset) => {
    const providerManager = manager();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "upstream-new-model" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await providerManager.discoverModels({ preset: preset.id, api: preset.api, apiKey: "dummy-live-key" });
    expect(result.ok).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(["upstream-new-model"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error", headers: { "Cache-Control": "no-cache, no-store" } });
  });

  it.each(["https://aiplatform.googleapis.com", "https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1"])("refreshes the official Vertex directory anonymously from %s", async (baseUrl) => {
    let generation = 1;
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(input);
      const html = vertexPublicCatalogDocuments([`gemini-catalog-generation-${generation}`]).get(url.pathname);
      if (!html) throw new Error("Unexpected API request");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const providerManager = manager();
    for (const key of [undefined, "dummy-unused-vertex-key"]) {
      const result = await providerManager.discoverModels({ api: "google-vertex", baseUrl, ...(key ? { apiKey: key } : {}) });
      expect(result.ok, result.error).toBe(true);
      expect(result.models.map((model) => model.id)).toEqual([`gemini-catalog-generation-${generation}`, "gemini-fixture-preview"]);
      generation++;
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [target, init] of fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>) {
      expect(target.origin).toBe("https://docs.cloud.google.com");
      expect(target.search).toBe("?hl=en");
      expect(init).toMatchObject({ cache: "no-store", redirect: "error", headers: { Accept: "text/html", "Cache-Control": "no-cache, no-store" } });
      expect(new Headers(init.headers).has("x-goog-api-key")).toBe(false);
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).has("x-goog-user-project")).toBe(false);
    }
    fetchMock.mockImplementation(async () => new Response("Unavailable", { status: 503, headers: { "Content-Type": "text/html" } }));
    const failed = await providerManager.discoverModels({ api: "google-vertex", baseUrl, apiKey: "dummy-unused-vertex-key" });
    expect(failed).toMatchObject({ ok: false, models: [] });
    expect(failed.error).toContain("HTTP 503");
  });

  it.each([401, 403, 404, 405, 429, 500])("reports HTTP %i instead of returning built-in preset models", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "upstream error" }, status)));
    const result = await manager().discoverModels({ preset: "openai", api: "openai-responses", apiKey: "dummy-key" });
    expect(result).toMatchObject({ ok: false, models: [] });
    expect(result.error).toContain(`HTTP ${status}`);
  });

  it.each([{ data: [] }, { models: [] }, { publisherModels: [] }])("preserves an actual empty list: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await manager().discoverModels({ preset: "openai", api: "openai-responses" })).toMatchObject({ ok: true, models: [] });
  });

  it.each([{}, { error: { message: "rejected" } }, { data: {} }, { data: [{ id: "" }] }, { data: [null] }])("rejects malformed or error-shaped success responses: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await manager().discoverModels({ preset: "openai", api: "openai-responses" })).toMatchObject({ ok: false, models: [] });
  });

  it("never reuses a prior fetch when the key, upstream list, or upstream status changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "first-model" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "new-model" }] }))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    vi.stubGlobal("fetch", fetchMock);
    const providerManager = manager();
    const request = { preset: "openai", api: "openai-responses" as const, apiKey: "dummy-first-key" };
    expect((await providerManager.discoverModels(request)).models.map((model) => model.id)).toEqual(["first-model"]);
    expect((await providerManager.discoverModels({ ...request, apiKey: "dummy-second-key" })).models.map((model) => model.id)).toEqual(["new-model"]);
    expect(await providerManager.discoverModels(request)).toMatchObject({ ok: false, models: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("loads every Gemini page, includes bidi live models with live purpose, and excludes embedding-only models", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ models: [
        { name: "models/future-gemini", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 2_000_000 },
        { name: "models/embedding-only", supportedGenerationMethods: ["embedContent"] },
        { name: "models/live-only", supportedGenerationMethods: ["bidiGenerateContent"] },
      ], nextPageToken: "second-page" }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/another-future-model", supportedGenerationMethods: ["generateContent"] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await manager().discoverModels({ preset: "google", api: "google-generative-ai", apiKey: "dummy-google-key" });
    expect(result.models.map((model) => [model.id, model.purpose ?? "chat"])).toEqual([
      ["future-gemini", "chat"],
      ["live-only", "live"],
      ["another-future-model", "chat"],
    ]);
    expect(result.models.find((model) => model.id === "live-only")?.protocolAdapter).toBe("gemini-live");
    expect(result.models[0].contextWindow).toBe(2_000_000);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageToken=second-page");
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe("dummy-google-key");
  });

  it.each(["", "/v1", "/v1beta1"])("uses native Vertex publisher listing from a %s base", async (suffix) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ publisherModels: [{ name: "publishers/google/models/gemini-future" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await manager().discoverModels({ api: "google-vertex", baseUrl: `https://vertex.example${suffix}`, apiKey: "dummy-vertex-key" });
    expect(result.models.map((model) => model.id)).toEqual(["gemini-future"]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://vertex.example/v1beta1/publishers/google/models?listAllVersions=true&view=PUBLISHER_MODEL_VIEW_FULL&pageSize=100");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "x-goog-api-key": "dummy-vertex-key" });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("gets all Anthropic pages using native authentication and after_id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-new" }], has_more: true, last_id: "claude-new" }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-next" }], has_more: false }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await manager().discoverModels({ preset: "anthropic", api: "anthropic-messages", apiKey: "dummy-anthropic-key" });
    expect(result.models.map((model) => model.id)).toEqual(["claude-new", "claude-next"]);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.anthropic.com/v1/models?after_id=claude-new");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "anthropic-version": "2023-06-01", "x-api-key": "dummy-anthropic-key" });
  });

  it("keeps the established third-party Anthropic bearer fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(jsonResponse({ data: [{ id: "third-party-model" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await manager().discoverModels({ baseUrl: "https://claude-proxy.example/v1", api: "anthropic-messages", apiKey: "dummy-proxy-key" });
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer dummy-proxy-key");
    expect(fetchMock.mock.calls[1][1].headers["x-api-key"]).toBeUndefined();
  });

  it("rejects a cross-origin next page before sending its credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "first-page" }], nextLink: "https://other.example/models" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await manager().discoverModels({ preset: "openai", api: "openai-responses", apiKey: "dummy-key" })).toMatchObject({ ok: false, models: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow an actual HTTP redirect carrying a provider API key", async () => {
    let forwarded = 0;
    const target = http.createServer((_req, res) => { forwarded++; res.end(JSON.stringify({ data: [] })); });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const source = http.createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/models` }); res.end(); });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    try {
      const sourcePort = (source.address() as { port: number }).port;
      const result = await manager().discoverModels({ api: "anthropic-messages", baseUrl: `http://127.0.0.1:${sourcePort}`, apiKey: "dummy-redirect-key" });
      expect(result).toMatchObject({ ok: false, models: [] });
      expect(forwarded).toBe(0);
    } finally {
      await Promise.all([source, target].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });

  it("redacts a supplied credential from unexpected transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("invalid header dummy-sensitive-key")));
    const result = await manager().discoverModels({ preset: "openai", api: "openai-responses", apiKey: "dummy-sensitive-key" });
    expect(result).toMatchObject({ ok: false, models: [] });
    expect(result.error).not.toContain("dummy-sensitive-key");
  });

  it("does not present partial lists when a later page fails or repeats its token", async () => {
    const providerManager = manager();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "first-page" }], nextPageToken: "next" }))
      .mockResolvedValueOnce(jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);
    expect(await providerManager.discoverModels({ preset: "google", api: "google-generative-ai" })).toMatchObject({ ok: false, models: [] });
    fetchMock.mockReset().mockImplementation(() => Promise.resolve(jsonResponse({ data: [{ id: "same-page" }], nextPageToken: "same" })));
    expect(await providerManager.discoverModels({ preset: "google", api: "google-generative-ai" })).toMatchObject({ ok: false, models: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports bounded pagination instead of silently truncating an endless upstream", async () => {
    let page = 0;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: [{ id: `model-${page++}` }], nextPageToken: String(page) })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await manager().discoverModels({ preset: "google", api: "google-generative-ai" });
    expect(result).toMatchObject({ ok: false, models: [] });
    expect(result.error).toContain("上限");
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it.each(["bedrock-converse-stream", "pi-messages", "openai-codex-responses"] as CustomProviderApi[])("reports unsupported API-key discovery for %s without inventing an endpoint", async (api) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await manager().discoverModels({ api, baseUrl: "https://unsupported.example" })).toMatchObject({ ok: false, models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Provider model catalog provenance", () => {
  it("registers an explicit new subscription ID using the native OAuth adapter without exposing preset candidates", async () => {
    const providerManager = manager();
    const native = providerManager.models.getProvider("anthropic")!;
    const id = "claude-manually-added-future-model";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request in native subscription fixture")));
    providerManager.syncProviders(config({ subscriptionModels: { anthropic: [{ id, contextWindow: 240_000, maxTokens: 1024, vision: false, reasoning: false }] } }), {});
    await providerManager.credentials.modify("anthropic", async () => ({ type: "oauth", access: "sk-ant-oat01-dummy-subscription", refresh: "dummy-refresh", expires: Date.now() + 3_600_000 }));
    const registered = providerManager.models.getProvider("anthropic")!;
    expect(registered.auth).toBe(native.auth);
    expect(registered.streamSimple).toBe(native.streamSimple);
    const model = providerManager.models.getModel("anthropic", id)!;
    expect(model).toMatchObject({ id, provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 240_000, maxTokens: 1024, input: ["text"] });
    expect(await providerManager.getProviderCatalogItem("anthropic")).toMatchObject({ modelCatalogSource: "configured", models: [{ id }] });
    const events = [
      { type: "message_start", message: { id: "msg_subscription_test", type: "message", role: "assistant", model: id, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json(), authorization: request.headers.get("authorization") });
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    });
    const result = await providerManager.models.completeSimple(model, { messages: [{ role: "user", content: "test", timestamp: Date.now() }] }, {
      fetch: mockFetch, signal: AbortSignal.timeout(2_000), thinkingLevel: "off",
    });
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "ok" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://api.anthropic.com/v1/messages?beta=true", body: { model: id }, authorization: "Bearer sk-ant-oat01-dummy-subscription" });
  });

  it("uses the matching native model for known subscription IDs and restores the original registry on removal", async () => {
    const providerManager = manager();
    const native = providerManager.models.getProvider("openai-codex")!;
    const original = native.getModels()[0]!;
    providerManager.syncProviders(config({ subscriptionModels: { "openai-codex": [{ id: original.id, name: "Explicit name", maxTokens: 999, thinkingEnabled: false }] } }), {});
    expect(providerManager.models.getModel("openai-codex", original.id)).toMatchObject({ api: original.api, baseUrl: original.baseUrl, name: "Explicit name", maxTokens: 999 });
    providerManager.syncProviders(config(), {});
    expect(providerManager.models.getProvider("openai-codex")).toBe(native);
    expect(providerManager.models.getModel("openai-codex", original.id)).toBe(original);
    expect((await providerManager.getProviderCatalogItem("openai-codex")).models).toEqual([]);
  });

  it("rejects an unknown mixed-protocol subscription family before changing the registry", () => {
    const providerManager = manager();
    const native = providerManager.models.getProvider("github-copilot");
    expect(() => providerManager.syncProviders(config({ subscriptionModels: { "github-copilot": [{ id: "unknown-family-model" }] } }), {})).toThrow("无法确定");
    expect(providerManager.models.getProvider("github-copilot")).toBe(native);
  });

  it("shows only explicitly configured builtin IDs and applies the account's availability filter", async () => {
    const providerManager = manager();
    const [allowed, denied] = providerManager.models.getModels("github-copilot");
    providerManager.syncProviders(config({ defaultProvider: "github-copilot", defaultModel: allowed.id, customProviders: [] }), {
      worker: { id: "worker", label: "Worker", whenToUse: "test", provider: "github-copilot", modelId: denied.id },
    });
    await providerManager.credentials.modify("github-copilot", async () => ({ type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 60_000, availableModelIds: [allowed.id] }));
    const item = await providerManager.getProviderCatalogItem("github-copilot");
    expect(item.models.map((model) => model.id)).toEqual([allowed.id]);
    expect(item).toMatchObject({ modelCatalogSource: "configured", supportsModelDiscovery: false });
    await expect(providerManager.refreshProvider("github-copilot")).rejects.toThrow("不支持");
    expect(await providerManager.getProviderCatalogItem("openai-codex")).toMatchObject({ models: [], modelCatalogSource: "preset", supportsModelDiscovery: false });
  });

  it("does not reintroduce an account-denied manual subscription ID through configuredModels", async () => {
    const providerManager = manager();
    const [allowed, denied] = providerManager.models.getModels("github-copilot");
    providerManager.syncProviders(config({ subscriptionModels: { "github-copilot": [{ id: allowed.id }, { id: denied.id }] } }), {});
    await providerManager.credentials.modify("github-copilot", async () => ({ type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 3_600_000, availableModelIds: [allowed.id] }));
    const item = await providerManager.getProviderCatalogItem("github-copilot");
    expect(item.configuredModels?.map((model) => model.id)).toEqual([allowed.id]);
    expect(item.models.map((model) => model.id)).toEqual([allowed.id]);
    providerManager.syncProviders(config({ subscriptionModels: { "github-copilot": [{ id: denied.id }] } }), {});
    expect(await providerManager.getProviderCatalogItem("github-copilot")).toMatchObject({ configuredModels: [], models: [] });
  });

  it("keeps runtime discoveries separate from explicitly added custom models", async () => {
    const providerManager = manager(); providerManager.syncProviders(config(), {});
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: [{ id: "remote-candidate" }] }))));
    await providerManager.setApiKey("api-test", "dummy-custom-key");
    const item = await providerManager.refreshProvider("api-test");
    expect(item).toMatchObject({ modelCatalogSource: "configured", supportsModelDiscovery: true });
    expect(item.models.map((model) => model.id)).toEqual(["configured-model"]);
    expect(providerManager.models.getModel("api-test", "remote-candidate")).toBeDefined();
    expect((await providerManager.discoverModels({ providerId: "api-test", api: "openai-completions" })).models.map((model) => model.id)).toEqual(["remote-candidate"]);
  });

  it("rejects refresh failure and auth-skipped refresh while preserving configured models", async () => {
    const providerManager = manager(); providerManager.syncProviders(config(), {});
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, 503))); vi.stubGlobal("fetch", fetchMock);
    await expect(providerManager.refreshProvider("api-test")).rejects.toThrow("授权状态");
    expect(fetchMock).not.toHaveBeenCalled();
    await providerManager.setApiKey("api-test", "dummy-custom-key");
    await expect(providerManager.refreshProvider("api-test")).rejects.toThrow("HTTP 503");
    expect((await providerManager.getProviderCatalogItem("api-test")).models.map((model) => model.id)).toEqual(["configured-model"]);
  });

  it("only marks a native subscription catalog remote after the network phase fully succeeds", async () => {
    const providerManager = manager();
    const radiusModel = { id: "radius-live-model", name: "Live", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
    const response = { baseUrl: "https://radius.pi.dev/v1", models: [radiusModel] };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(response))); vi.stubGlobal("fetch", fetchMock);
    await providerManager.credentials.modify("radius", async () => ({ type: "api_key", key: "dummy-radius-key" }));
    expect(await providerManager.refreshProvider("radius")).toMatchObject({ modelCatalogSource: "remote", models: [{ id: "radius-live-model" }] });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({}, 503)));
    await expect(providerManager.refreshProvider("radius")).rejects.toThrow("503");
    expect(await providerManager.getProviderCatalogItem("radius")).toMatchObject({ modelCatalogSource: "preset", models: [] });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(response)));
    await providerManager.refreshProvider("radius");
    expect(await providerManager.logout("radius")).toMatchObject({ modelCatalogSource: "preset", models: [] });
  });

  it("does not mark a legacy subscription cache remote when the subsequent native request fails", async () => {
    const providerManager = manager();
    const cachedModel = { id: "legacy-radius-model", name: "Cached", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
    const credential = { type: "oauth" as const, access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 60_000,
      gatewayConfig: { baseUrl: "https://radius.pi.dev/v1", models: [cachedModel] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    const publish = vi.fn().mockResolvedValue(true);
    await expect(providerManager.models.getProvider("radius")!.refreshModels!({
      credential, allowNetwork: true, force: true, signal: new AbortController().signal, publish,
    })).rejects.toThrow("503");
    expect(publish).toHaveBeenCalled();
    expect(await providerManager.getProviderCatalogItem("radius")).toMatchObject({ modelCatalogSource: "preset", models: [] });
  });

  it("locks mainstream presets to @earendil-works/pi-ai builtinProviders() single source of truth", async () => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const { MAINSTREAM_PROVIDER_PRESETS } = await import("../packages/hub/src/providers");
    const { MAINSTREAM_PRESETS } = await import("../packages/web/src/features/settings/settings-helpers");
    const piById = new Map(builtinProviders().map((p) => [p.id, p]));

    for (const preset of MAINSTREAM_PROVIDER_PRESETS) {
      const pi = piById.get(preset.builtinId);
      expect(pi, `pi-ai builtin provider ${preset.builtinId}`).toBeDefined();
      const expectedUrl = preset.id === "google-vertex" ? "https://aiplatform.googleapis.com" : pi!.baseUrl;
      expect(preset.baseUrl, `${preset.id} baseUrl`).toBe(expectedUrl);
      const piApis = new Set<string>(pi!.getModels().map((m) => m.api));
      if (piApis.size > 0) {
        expect(piApis.has(preset.api), `${preset.id} api (${preset.api}) must exist in pi-ai (${[...piApis].join(",")})`).toBe(true);
      }
      const webPreset = MAINSTREAM_PRESETS.find((w) => w.id === preset.id);
      expect(webPreset, `web fallback preset ${preset.id}`).toMatchObject({
        id: preset.id,
        api: preset.api,
        baseUrl: preset.baseUrl,
      });
    }
    expect(MAINSTREAM_PROVIDER_PRESETS.find((p) => p.id === "xai")?.api).toBe("openai-responses");
    expect(MAINSTREAM_PROVIDER_PRESETS.find((p) => p.id === "openrouter")?.supportedApis).toEqual(
      expect.arrayContaining(["openai-completions", "anthropic-messages"]),
    );
    expect(MAINSTREAM_PROVIDER_PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(["minimax-cn", "minimax"]));
  });
});
