import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuloModelMetadataRegistry } from "../packages/hub/src/model-metadata-registry";
import { normalizeModelIdCandidates } from "../packages/hub/src/model-metadata-parser";
import { KuloProviderManager } from "../packages/hub/src/providers";
import { startKuloHubServer } from "../packages/hub/src/server";
import { openTestHub } from "./helpers/secure-hub";
import { fetchWithHubAuth, HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";
import type { ResolveModelMetadataResponse } from "@kulo/protocol";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeStateDir(prefix = "kulo-metadata-reg-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Model metadata registry & official API defaults", () => {
  it("normalizes resource prefixes, dated snapshots, and dot/hyphen aliases deterministically", () => {
    expect(normalizeModelIdCandidates("publishers/google/models/gemini-4-carbon")).toContain("gemini-4-carbon");
    expect(normalizeModelIdCandidates("gpt-4.1-2025-04-14")).toContain("gpt-4.1");
    expect(normalizeModelIdCandidates("claude-sonnet-4-5-20250929")).toEqual(
      expect.arrayContaining(["claude-sonnet-4-5", "claude-sonnet-4.5"]),
    );
    expect(normalizeModelIdCandidates("openai/o3-2025-04-16")).toContain("o3");
  });

  it("loads the bundled factory snapshot offline with accurate defaults for Vertex, OpenAI, Claude, OpenRouter, and third-party APIs", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Should not hit network without explicit refresh"));
    const manager = new KuloProviderManager({
      stateDir: makeStateDir(),
      metadataRegistryOptions: { fetcher: fetchMock as unknown as typeof fetch },
    });

    // 1. Official Google Vertex AI: gemini-4-carbon (absent from static pi-ai, present in bundled models.dev snapshot)
    const vertex = await manager.resolveModelMetadata({
      modelId: "gemini-4-carbon",
      api: "google-vertex",
      preset: "google-vertex",
    });
    expect(vertex.model.contextWindow).toBe(1_048_576);
    expect(vertex.model.maxTokens).toBe(65_536);
    expect(vertex.model.modalities).toEqual(expect.arrayContaining(["text", "image", "audio", "video", "pdf"]));
    expect(vertex.model.vision).toBe(true);
    expect(vertex.model.reasoning).toBe(true);
    expect(vertex.model.supportedThinkingLevels).toEqual(["low", "medium", "high"]);
    expect(vertex.model.supportedThinkingLevels).not.toContain("xhigh");
    expect(vertex.model.nativeTools).toBeUndefined();
    expect(vertex.nativeSearchAllowed).toBe(false);
    expect(vertex.allowedThinkingWireValues).toEqual(["off", "minimal", "low", "medium", "high"]);

    // 2. Official OpenAI Responses: gpt-5.4 & dated gpt-4.1-2025-04-14
    const gpt54 = await manager.resolveModelMetadata({
      modelId: "gpt-5.4",
      api: "openai-responses",
      preset: "openai",
    });
    expect(gpt54.model.contextWindow).toBe(1_050_000);
    expect(gpt54.model.maxTokens).toBe(128_000);
    expect(gpt54.model.modalities).toEqual(expect.arrayContaining(["text", "image", "pdf"]));
    expect(gpt54.model.reasoning).toBe(true);
    expect(gpt54.model.nativeTools).toEqual({ webSearch: true });
    expect(gpt54.nativeSearchAllowed).toBe(true);

    const gpt41Dated = await manager.resolveModelMetadata({
      modelId: "gpt-4.1-2025-04-14",
      api: "openai-responses",
      preset: "openai",
    });
    expect(gpt41Dated.model.contextWindow).toBe(1_047_576);
    expect(gpt41Dated.model.maxTokens).toBe(32_768);
    expect(gpt41Dated.model.reasoning).toBe(false);
    expect(gpt41Dated.model.thinkingEnabled).toBe(false);
    expect(gpt41Dated.model.nativeTools).toEqual({ webSearch: true });

    // 3. Official Anthropic Claude: defaults native webSearch ON
    const claude = await manager.resolveModelMetadata({
      modelId: "claude-opus-4-6",
      api: "anthropic-messages",
      preset: "anthropic",
    });
    expect(claude.model.contextWindow).toBe(1_000_000);
    expect(claude.model.maxTokens).toBe(128_000);
    expect(claude.model.modalities).toEqual(expect.arrayContaining(["text", "image", "pdf"]));
    expect(claude.model.nativeTools).toEqual({ webSearch: true });
    expect(claude.nativeSearchAllowed).toBe(true);

    // 4. OpenRouter official preset: native webSearch stays OFF by default (user toggleable)
    const openrouter = await manager.resolveModelMetadata({
      modelId: "openai/gpt-5.4",
      api: "openai-completions",
      preset: "openrouter",
    });
    expect(openrouter.model.contextWindow).toBeGreaterThanOrEqual(272_000);
    expect(openrouter.model.nativeTools).toBeUndefined();
    expect(openrouter.nativeSearchAllowed).toBe(true);

    // 5. Third-party custom endpoint: still gets accurate context/modalities/reasoning, but native webSearch stays OFF
    const thirdParty = await manager.resolveModelMetadata({
      modelId: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(thirdParty.model.contextWindow).toBe(1_050_000);
    expect(thirdParty.model.modalities).toEqual(expect.arrayContaining(["text", "image", "pdf"]));
    expect(thirdParty.model.nativeTools).toBeUndefined();
    expect(thirdParty.nativeSearchAllowed).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes online on demand with ETag caching and recovers cleanly from corrupt cache or network failure", async () => {
    const stateDir = makeStateDir();
    const cacheFile = path.join(stateDir, "model-registry-cache.json");
    // Seed a corrupt cache file to verify safe fallback to bundled snapshot.
    fs.writeFileSync(cacheFile, "{not valid json", "utf8");

    let calls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls++;
      if (url.includes("models.dev")) {
        if (headers.get("if-none-match") === '"etag-v1"') {
          return new Response(null, { status: 304, headers: { etag: '"etag-v1"' } });
        }
        return new Response(
          JSON.stringify({
            openai: {
              models: {
                "gpt-9-future": {
                  id: "gpt-9-future",
                  name: "GPT-9 Future",
                  reasoning: true,
                  reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
                  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
                  limit: { context: 2_000_000, output: 256_000 },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json", etag: '"etag-v1"' } },
        );
      }
      if (headers.get("if-none-match") === '"ltm-v1"') {
        return new Response(null, { status: 304, headers: { etag: '"ltm-v1"' } });
      }
      return new Response(
        JSON.stringify({
          "gpt-9-future": {
            litellm_provider: "openai",
            mode: "chat",
            max_input_tokens: 2_000_000,
            max_output_tokens: 256_000,
            supports_web_search: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json", etag: '"ltm-v1"' } },
      );
    });

    const registry = new KuloModelMetadataRegistry({
      stateDir,
      fetcher: fetcher as unknown as typeof fetch,
      refreshTtlMs: 60_000,
    });

    // Before refresh, corrupt cache falls back seamlessly to bundled factory snapshot.
    expect(registry.lookup("gpt-5.4", { preset: "openai" })?.contextWindow).toBe(1_050_000);
    expect(registry.lookup("gpt-9-future", { preset: "openai" })).toBeUndefined();

    // First on-demand refresh populates cache and persists to disk.
    const first = await registry.refresh({ force: true });
    expect(first).toMatchObject({ updated: true, fromCache: false, source: "remote" });
    expect(registry.lookup("gpt-9-future", { preset: "openai" })).toMatchObject({
      contextWindow: 2_000_000,
      maxTokens: 256_000,
      webSearch: true,
      source: "models.dev",
    });

    // Second refresh within TTL returns cached without extra HTTP calls.
    const callsAfterFirst = calls;
    const cached = await registry.refresh();
    expect(cached).toMatchObject({ updated: false, fromCache: true, source: "cache" });
    expect(calls).toBe(callsAfterFirst);

    // Reloading from disk picks up persisted cache and sends ETag on expired TTL -> 304 Not Modified.
    const reloaded = new KuloModelMetadataRegistry({
      stateDir,
      fetcher: fetcher as unknown as typeof fetch,
      refreshTtlMs: 0,
    });
    expect(reloaded.lookup("gpt-9-future", { preset: "openai" })?.contextWindow).toBe(2_000_000);
    const notModified = await reloaded.refresh();
    expect(notModified).toMatchObject({ updated: false, fromCache: true, source: "cache" });

    // Network failure never throws and retains last valid cache.
    const failingRegistry = new KuloModelMetadataRegistry({
      stateDir,
      fetcher: vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch,
      refreshTtlMs: 0,
    });
    const offline = await failingRegistry.refresh({ force: true });
    expect(offline.updated).toBe(false);
    expect(failingRegistry.lookup("gpt-9-future", { preset: "openai" })?.contextWindow).toBe(2_000_000);
  });

  it("parses upstream input_modalities and supported_parameters during live discovery and exposes /api/providers/resolve-model", async () => {
    const stateDir = makeStateDir();
    const providerManager = new KuloProviderManager({ stateDir });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "vendor/custom-multimodal-model",
              context_length: 512_000,
              top_provider: { max_completion_tokens: 32_768 },
              architecture: { input_modalities: ["text", "image", "pdf"], output_modalities: ["text"] },
              supported_parameters: ["temperature", "reasoning"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const discovered = await providerManager.discoverModels({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      preset: "openrouter",
      apiKey: "dummy-or-key",
    });
    expect(discovered.ok).toBe(true);
    expect(discovered.models[0]).toMatchObject({
      id: "vendor/custom-multimodal-model",
      contextWindow: 512_000,
      maxTokens: 32_768,
      modalities: ["text", "image", "pdf"],
      vision: true,
      reasoning: true,
      metadataSource: "provider-api",
    });
    expect(discovered.models[0]?.nativeTools).toBeUndefined();

    // Verify REST endpoint /api/providers/resolve-model through authenticated Hub
    vi.unstubAllGlobals();
    const hub = await openTestHub({
      config: {
        authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir: makeStateDir("kulo-resolve-http-"),
        identityDir: makeStateDir("kulo-resolve-id-"),
        localEnvRoot: makeStateDir("kulo-resolve-env-"),
        enableLocalEnv: false,
        memory: { enabled: false },
        watchdogMinutes: 0,
      },
    });
    cleanups.push(() => hub.close());
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    const res = await fetchWithHubAuth(`${server.url}/api/providers/resolve-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "gpt-5.4", api: "openai-responses", preset: "openai" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResolveModelMetadataResponse;
    expect(body.model).toMatchObject({
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      nativeTools: { webSearch: true },
    });
    expect(body.nativeSearchAllowed).toBe(true);
  }, 30_000);
});
