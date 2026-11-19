import { describe, expect, it, vi } from "vitest";
import { normalizeImageGenerationParameters, type MediaJob, type MediaConnectionView, type ProviderCatalogItem, type ProviderModelItem } from "@moco/protocol";
import { discoverImageProviderAdapters } from "../packages/hub/src/image-provider-adapters.js";
import { customImageRequest } from "../packages/hub/src/media-adapters.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
const model = (id: string, extra: Partial<ProviderModelItem> = {}): ProviderModelItem => ({
  id, name: id, reasoning: false, modalities: ["text", "image"], vision: true,
  supportedThinkingLevels: ["off"], contextWindow: 100_000, maxTokens: 1000, ...extra,
});
const provider = (baseUrl: string, extra: Partial<ProviderCatalogItem> = {}): ProviderCatalogItem => ({
  id: "api-saved", name: "Saved provider", builtin: false, authenticated: true, authType: "api_key",
  supportsApiKey: true, supportsOAuth: false, api: "openai-completions", baseUrl, models: [], ...extra,
});
const router = () => provider("https://openrouter.ai/api/v1");
const response = (data: unknown[]) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
function directoryEntry(id = "vendor/fresh-render", supported: Record<string, unknown> = {}) {
  return { id, name: "Fresh render", architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] }, supported_parameters: {
    output_format: { type: "enum", values: ["png", "jpeg"] }, aspect_ratio: { type: "enum", values: ["auto", "16:9"] },
    resolution: { type: "enum", values: ["1K", "2K"] }, quality: { type: "enum", values: ["auto", "high"] },
    background: { type: "enum", values: ["auto", "opaque", "transparent"] }, n: { type: "range", min: 1, max: 2 },
    input_references: { type: "range", min: 0, max: 3 }, output_compression: { type: "range", min: 0, max: 100 }, seed: { type: "boolean" }, ...supported,
  } };
}

describe("provider-specific image transports", () => {
  it("reads the public OpenRouter image directory without credentials and selects its dedicated images transport", async () => {
    const fetcher = vi.fn(async () => response([directoryEntry()]));
    const result = await discoverImageProviderAdapters(router(), [model("vision-chat")], { fetch: fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/images/models");
    expect(request).toMatchObject({ method: "GET", redirect: "error", headers: { Accept: "application/json" } });
    expect(new Headers(request.headers).get("authorization")).toBeNull();
    expect(new Headers(request.headers).get("cookie")).toBeNull();
    expect(result.source).toBe("openrouter-image-api");
    expect(result.models).toHaveLength(1);
    const found = result.models[0]!;
    expect(found).toMatchObject({ adapter: "custom-image", maxOutputs: 2, imageProfile: { formats: ["png", "jpeg"], supportsEdit: true, maxReferences: 3, sizes: ["1K", "2K"], aspectRatios: ["auto", "16:9"] } });
    expect(found.needsConfiguration).toBeUndefined();
    expect(found.customAdapter).toMatchObject({ auth: { type: "bearer" }, generate: { path: "images" }, edit: { path: "images" },
      response: { imagesPath: "data", base64Path: "b64_json", mimeTypePath: "media_type" }, referenceTemplate: { type: "image_url", image_url: { url: "{{reference.dataUrl}}" } } });
    expect(found.defaults).toEqual({ format: "png", count: 1, aspectRatio: "auto", size: "1K", quality: "auto", background: "auto" });
    expect(() => normalizeImageGenerationParameters({ ...found.defaults, custom: { seed: 42 } }, found.imageProfile, "custom-image")).not.toThrow();
  });

  it("maps native settings and every reference image into the documented payload using synthetic transport only", async () => {
    const result = await discoverImageProviderAdapters(router(), [], { fetch: async () => response([directoryEntry()]) });
    const found = result.models[0]!;
    const connection: MediaConnectionView = { id: "router-connection", name: "Router", adapter: "custom-image", baseUrl: "https://openrouter.ai/api/v1", origin: "https://openrouter.ai", hasCredential: true, revision: 1, customAdapter: found.customAdapter };
    const job: MediaJob = { id: "media-router-fixture", operationId: "router-reference", capabilityId: "router-cap", capabilityRevision: 1,
      connectionId: connection.id, adapter: "custom-image", modelId: found.model.id, kind: "image", prompt: "Repaint the references", inputAssetIds: ["ref-a", "ref-b"],
      format: "png", count: 1, parameters: { ...found.defaults, custom: { seed: 42 } }, imageProfile: found.imageProfile,
      source: { conversationId: 1, topicId: "root" }, status: "running", assets: [], createdAt: 1, updatedAt: 1 };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64"), media_type: "image/png" }] }), { headers: { "Content-Type": "application/json" } }));
    const generated = await customImageRequest({ job, connection, apiKey: "synthetic-router-key", inputs: [
      { id: "ref-a", name: "a.png", mimeType: "image/png", bytes: png }, { id: "ref-b", name: "b.png", mimeType: "image/png", bytes: png },
    ], fetcher });
    expect(generated).toMatchObject({ status: "completed", outputs: [{ mimeType: "image/png", bytes: png }] });
    const [url, request] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/images");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer synthetic-router-key");
    expect(JSON.parse(request.body as string)).toEqual({ model: found.model.id, prompt: job.prompt, provider: { allow_fallbacks: false },
      n: 1, aspect_ratio: "auto", quality: "auto", background: "auto", output_format: "png", resolution: "1K", seed: 42,
      input_references: [0, 1].map(() => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } })) });
  });

  it("uses model directory limits instead of advertising all native GPT Image features", async () => {
    const entry = directoryEntry("openai/gpt-image-2.6-flare");
    entry.supported_parameters = { output_format: { type: "enum", values: ["png", "jpeg", "webp", "gif"] },
      input_references: { type: "range", min: 0, max: 99 }, n: { type: "range", min: 1, max: 10 } };
    const result = await discoverImageProviderAdapters(router(), [], { fetch: async () => response([entry]) });
    expect(result.models[0]).toMatchObject({ maxOutputs: 8, imageProfile: { formats: ["png", "jpeg", "webp", "gif"], maxReferences: 16, supportsTransparency: false, supportsComplexity: false } });
    expect(result.models[0]!.imageProfile.formats).not.toContain("svg");
    expect(result.models[0]!.imageProfile.qualities).toBeUndefined();
    expect(result.models[0]!.customAdapter!.generate.body).not.toHaveProperty("complexity");
  });

  it("marks unsupported or incomplete catalog evidence for configuration and filters chat records", async () => {
    const unspecified = directoryEntry("unknown/default-format"); unspecified.supported_parameters = {};
    const editOnly = directoryEntry("vendor/edit-only", { input_references: { type: "range", min: 1, max: 8 } });
    const chat = { ...directoryEntry("vision-chat"), architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } };
    const invalid = { ...directoryEntry(), id: "vendor/invalid?secret=1" };
    const result = await discoverImageProviderAdapters(router(), [], { fetch: async () => response([unspecified, editOnly, chat, invalid]) });
    expect(result.models.map((item) => item.model.id)).toEqual(["unknown/default-format", "vendor/edit-only"]);
    expect(result.models.every((item) => item.needsConfiguration)).toBe(true);
    expect(result.models[0]!.imageProfile.supportsEdit).toBe(false);
    expect(result.models[1]!.configurationReason).toContain("参考图");
  });

  it("does not assume a proxy's output default matches its model vendor's direct API", async () => {
    const entry = directoryEntry("google/gemini-nano-banana-2.1");
    entry.supported_parameters = { resolution: { type: "enum", values: ["1K", "2K"] }, input_references: { type: "range", min: 0, max: 14 } };
    const result = await discoverImageProviderAdapters(router(), [], { fetch: async () => response([entry]) });
    expect(result.models[0]).toMatchObject({ adapter: "custom-image", needsConfiguration: true, imageProfile: { maxReferences: 14 } });
    expect(result.models[0]!.customAdapter!.generate.body).not.toHaveProperty("output_format");
    expect(result.models[0]!.configurationReason).toContain("输出格式");
  });

  it("preserves documented native API routes even if the provider api field is omitted", async () => {
    const fetcher = vi.fn();
    for (const [baseUrl, api, id, expected] of [
      ["https://api.openai.com/v1", "openai-responses", "gpt-image-2.5-flare", "openai-image"],
      ["https://generativelanguage.googleapis.com/v1beta", "google-generative-ai", "gemini-nano-banana-2.1", "gemini-image"],
    ] as const) {
      const result = await discoverImageProviderAdapters(provider(baseUrl, { api: undefined, builtin: true }), [model(id, { api }), model("vision-chat", { api })], { fetch: fetcher });
      expect(result.source).toBe("native-image-api");
      expect(result.models).toHaveLength(1);
      expect(result.models[0]).toMatchObject({ adapter: expected, model: { id } });
      expect(result.models[0]!.needsConfiguration).toBeUndefined();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["https://custom-gateway.example/v1", "https://openrouter.ai.evil.example/api/v1", "https://openrouter.ai/api/v1?token=hidden", "https://openrouter.ai/other"])("does not infer an image route from a chat protocol or misleading provider identity: %s", async (baseUrl) => {
    const fetcher = vi.fn();
    const result = await discoverImageProviderAdapters(provider(baseUrl, { id: "openrouter", preset: "openrouter" }), [model("gpt-image-2.6-flare"), model("vision-chat")], { fetch: fetcher });
    expect(result.source).toBe("configuration-required");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ adapter: "custom-image", needsConfiguration: true });
    expect(result.models[0]!.customAdapter).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not treat OAuth authorization as a usable API key", async () => {
    const fetcher = vi.fn();
    const result = await discoverImageProviderAdapters(provider("https://openrouter.ai/api/v1", { authType: "oauth" }), [model("gpt-image-2.6-flare")], { fetch: fetcher });
    expect(result.models[0]).toMatchObject({ needsConfiguration: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([new Response("No permission", { status: 403 }), response([]), new Response("not-json"), response([{ id: "unknown" }])])("handles empty or failed directories without silently assigning another image API", async (upstream) => {
    const result = await discoverImageProviderAdapters(router(), [model("gpt-image-2.6-flare")], { fetch: async () => upstream });
    if (result.error) {
      expect(result.models[0]).toMatchObject({ adapter: "custom-image", needsConfiguration: true });
      expect(result.models[0]!.customAdapter).toBeUndefined();
    } else expect(result.models).toEqual([]);
  });

  it("ignores credential/prototype parameter names and bounds directory responses", async () => {
    const entry = directoryEntry("vendor/parameter-safe", JSON.parse('{"authorization":{"type":"enum","values":["secret"]},"__proto__":{"type":"enum","values":["bad"]},"guidance":{"type":"range","min":1,"max":20}}'));
    const result = await discoverImageProviderAdapters(router(), [], { fetch: async () => response([entry]) });
    expect(result.models[0]!.imageProfile.parameters!.map((item) => item.key)).toEqual(["seed", "guidance"]);
    expect(JSON.stringify(result.models[0]!.customAdapter)).not.toContain("authorization");
    const oversized = await discoverImageProviderAdapters(router(), [], { fetch: async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)) });
    expect(oversized.error).toBeDefined();
  });
});
