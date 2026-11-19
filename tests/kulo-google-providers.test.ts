import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KuloHub, startKuloHubServer } from "@kulo/hub";
import type { KuloModelConfig } from "../packages/hub/src/config";
import { probeOpenAICompatibleGateway } from "../packages/hub/src/models";
import { MAINSTREAM_PROVIDER_PRESETS, KuloProviderManager } from "../packages/hub/src/providers";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";
import { vertexPublicCatalogDocuments } from "./helpers/vertex-public-catalog";

const dirs: string[] = [];
const servers: http.Server[] = [];

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-google-providers-"));
  dirs.push(dir);
  return new KuloProviderManager({ stateDir: dir });
}

function vertexConfig(baseUrl: string): KuloModelConfig {
  return {
    baseUrl,
    apiMode: "google-vertex",
    defaultProvider: "api-google-vertex",
    defaultModel: "gemini-2.5-pro",
    thinkingLevel: "off",
    contextWindow: 1_000_000,
    compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 },
    gatewayDisabled: true,
    customProviders: [{
      id: "api-google-vertex",
      name: "Vertex test",
      preset: "google-vertex",
      api: "google-vertex",
      baseUrl,
      models: [{ id: "manually-configured-model" }],
    }],
  };
}

async function vertexEndpoint(status = 200) {
  const requests: Array<{
    method?: string; url?: string; key?: string; authorization?: string; body: unknown;
  }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      url: req.url,
      key: typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"] : undefined,
      authorization: req.headers.authorization,
      body: text ? JSON.parse(text) : undefined,
    });
    if (req.url?.includes(":streamGenerateContent") && status === 200) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })}\n\n`);
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status === 200
      ? { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }
      : { error: { code: status, message: "invalid test key" } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

function publicDirectory(ids: string[]) {
  const documents = vertexPublicCatalogDocuments(ids, ["gemini-preview-current"]);
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://docs.cloud.google.com");
    const headers = new Headers(init?.headers);
    expect(headers.has("x-goog-api-key")).toBe(false);
    expect(headers.has("Authorization")).toBe(false);
    const html = documents.get(url.pathname);
    if (!html) throw new Error(`Unexpected public document ${url.pathname}`);
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  });
}

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(name, "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Google API key providers", () => {
  it("keeps AI Studio and Vertex presets on separate APIs and endpoints", () => {
    expect(MAINSTREAM_PROVIDER_PRESETS.find((preset) => preset.id === "google")).toMatchObject({
      name: "Gemini · AI Studio", api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta", builtinId: "google",
    });
    expect(MAINSTREAM_PROVIDER_PRESETS.find((preset) => preset.id === "google-vertex")).toMatchObject({
      name: "Google Vertex AI", api: "google-vertex",
      baseUrl: "https://aiplatform.googleapis.com", builtinId: "google-vertex",
    });
  });

  it("loads the current official Vertex directory without forwarding an API key", async () => {
    const providerManager = manager();
    const fetchMock = publicDirectory(["gemini-new-published"]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await providerManager.discoverModels({
      preset: "google-vertex", api: "google-vertex", apiKey: "dummy-vertex-key",
    });
    expect(result.ok).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((model) => model.api === "google-vertex")).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(["gemini-new-published", "gemini-preview-current"]);
    expect(result.source).toBe("official-documentation");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("serves a live Vertex catalog through the discovery HTTP route", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-vertex-discovery-http-"));
    dirs.push(stateDir);
    const hub = await openTestHub({
      config: {
        stateDir,
        enableLocalEnv: false,
        authToken: HUB_TEST_ADMIN_TOKEN,
        model: { ...vertexConfig("https://aiplatform.googleapis.com"), apiKey: "" },
      },
    });
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    const localFetch = globalThis.fetch;
    const remoteFetch = publicDirectory(["gemini-http-published"]);
    vi.stubGlobal("fetch", remoteFetch);
    try {
      const response = await localFetch(`${server.url}/api/providers/discover-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
        body: JSON.stringify({
          preset: "google-vertex",
          api: "google-vertex",
          baseUrl: "https://aiplatform.googleapis.com",
          apiKey: "dummy-vertex-key",
        }),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.ok).toBe(true);
      expect(result.models.map((model: { id: string }) => model.id)).toEqual(["gemini-http-published", "gemini-preview-current"]);
      expect(result.source).toBe("official-documentation");
      expect(result.models.every((model: { api: string }) => model.api === "google-vertex")).toBe(true);
      expect(remoteFetch).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("preserves manually configured Vertex models on credential save and refresh", async () => {
    const providerManager = manager();
    const fetchMock = publicDirectory(["gemini-new-published"]);
    vi.stubGlobal("fetch", fetchMock);
    providerManager.syncProviders(vertexConfig("https://aiplatform.googleapis.com"), {});
    await providerManager.setApiKey("api-google-vertex", "dummy-vertex-key");
    await providerManager.refreshProvider("api-google-vertex");
    const ids = providerManager.models.getModels("api-google-vertex").map((model) => model.id);
    expect(ids).toContain("manually-configured-model");
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).toContain("gemini-new-published");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each(["", "/v1", "/v1beta1"])("probes Vertex generation at the %s base using API-key headers", async (suffix) => {
    const endpoint = await vertexEndpoint();
    const saved = vertexConfig(endpoint.origin + suffix);
    const result = await probeOpenAICompatibleGateway(saved, { apiKey: "dummy-vertex-key" });
    expect(result.ok).toBe(true);
    expect(endpoint.requests).toEqual([{
      method: "POST",
      url: `${suffix || "/v1"}/publishers/google/models/gemini-2.5-pro:generateContent`,
      key: "dummy-vertex-key",
      authorization: undefined,
      body: {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }]);
  });

  it("uses the native Vertex adapter for configured API-key generation", async () => {
    const endpoint = await vertexEndpoint();
    const providerManager = manager();
    providerManager.syncProviders(vertexConfig(endpoint.origin), {});
    await providerManager.setApiKey("api-google-vertex", "dummy-vertex-key");
    const model = providerManager.models.getModel("api-google-vertex", "gemini-2.5-pro")!;
    const result = await providerManager.models.completeSimple(model, {
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
    }, { signal: AbortSignal.timeout(2_000) });
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "ok" });
    const generationRequests = endpoint.requests.filter((request) => request.method === "POST");
    expect(generationRequests).toHaveLength(1);
    expect(generationRequests[0]).toMatchObject({
      method: "POST",
      url: "/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      key: "dummy-vertex-key",
      authorization: undefined,
    });
  });

  it("reports failed Vertex generation rather than accepting catalog availability as authentication", async () => {
    const endpoint = await vertexEndpoint(403);
    const result = await probeOpenAICompatibleGateway(vertexConfig(endpoint.origin), { apiKey: "dummy-invalid-key" });
    expect(result.ok).toBe(false);
    expect(result.rawDetail).toContain("403");
    expect(endpoint.requests).toHaveLength(1);
  });

  it("does not forward saved Vertex API keys after an endpoint change", async () => {
    const endpoint = await vertexEndpoint(401);
    vi.stubEnv("KULO_API_KEY", "dummy-environment-key");
    vi.stubEnv("OPENAI_API_KEY", "dummy-openai-environment-key");
    const saved = { ...vertexConfig("https://aiplatform.googleapis.com"), apiKey: "dummy-saved-key" };
    const result = await probeOpenAICompatibleGateway(saved, { baseUrl: endpoint.origin });
    expect(result.ok).toBe(false);
    expect(result.title).toBe("需要重新输入接口密钥");
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]!.key).toBeUndefined();
    expect(endpoint.requests[0]!.authorization).toBeUndefined();
  });
});
