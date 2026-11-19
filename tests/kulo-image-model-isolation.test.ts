import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConversationModel, isImageGenerationModel, type CustomModelConfig } from "@kulo/protocol";
import { resolveHubConfig, type KuloModelConfig } from "../packages/hub/src/config";
import { resolveModelThinkingSelection, withThinkingLevelModels } from "../packages/hub/src/models";
import { KuloProviderManager } from "../packages/hub/src/providers";
import { applySettingsBlockUpdate, type KuloDurableSettings } from "../packages/hub/src/settings";

const directories: string[] = [];
const outputModel: CustomModelConfig = { id: "vendor-custom-render", purpose: "image", outputModalities: ["image"] };
const config = (): KuloModelConfig => ({
  baseUrl: "https://image-models.example/v1", apiMode: "openai-completions", defaultProvider: "api-media", defaultModel: "vision-chat",
  thinkingLevel: "off", contextWindow: 100_000, gatewayDisabled: true,
  compaction: { enabled: false, reserveTokens: 10_000, keepRecentTokens: 20_000, backgroundTokens: 30_000 },
  customProviders: [{ id: "api-media", name: "Media", api: "openai-completions", baseUrl: "https://image-models.example/v1",
    models: [{ id: "vision-chat", modalities: ["text", "image"] }, { id: "gpt-image-2.6-flare" }, outputModel] }],
});
function manager() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-image-isolation-"));
  directories.push(stateDir);
  const result = new KuloProviderManager({ stateDir });
  result.syncProviders(config(), {});
  return result;
}
function settings(): KuloDurableSettings {
  const defaults = resolveHubConfig();
  return {
    initialized: true, rolesMigratedV2: true, rolesMigratedV3: true, globalRevision: 1,
    revisions: { presentation: 1, executor: 1, roles: 1, model: 1, identity: 1, memory: 1 },
    presentation: defaults.presentation, executor: { maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1, paused: false, watchdogMinutes: 0 },
    roles: {}, model: config(), identity: { directory: "", directoryRevision: 1 }, memory: defaults.memory,
    expression: null, snapshots: [],
  };
}
beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "KULO_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("image model isolation", () => {
  it("keeps perception separate from generation and recognizes vendor-prefixed image model IDs", () => {
    expect(isConversationModel({ id: "vision-chat", purpose: "chat", outputModalities: ["text"] })).toBe(true);
    for (const id of ["gpt-image-2.5-sunburst", "openai/gpt-image-2.6-flare", "gemini-nano-banana-2.1", "models/gemini-2.5-flash-image", "google/gemini-3-pro-image-preview"]) {
      expect(isImageGenerationModel({ id }), id).toBe(true);
    }
    expect(isImageGenerationModel(outputModel)).toBe(true);
    expect(isImageGenerationModel({ id: "unknown-new-image-model", outputModalities: ["text", "image"] })).toBe(true);
    expect(isImageGenerationModel({ id: "image-understanding-chat" })).toBe(false);
  });

  it("does not register configured image models in the conversation runtime or delete their saved metadata", () => {
    const providerManager = manager();
    expect(providerManager.models.getModels("api-media").map((model) => model.id)).toEqual(["vision-chat"]);
    expect(providerManager.models.getModel("api-media", "vision-chat")?.input).toEqual(["text", "image"]);
    expect(config().customProviders[0]!.models).toContainEqual(outputModel);
  });

  it("preserves output capabilities from live discovery without registering them as chat models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "upstream-render", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
      { id: "upstream-chat", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "gpt-image-2.6-sunburst" },
    ] }), { headers: { "Content-Type": "application/json" } })));
    const providerManager = manager();
    await providerManager.credentials.modify("api-media", async () => ({ type: "api_key", key: "synthetic-refresh-key", env: { KULO_API_KEY_ORIGIN: "https://image-models.example" } }));
    const catalog = await providerManager.discoverModels({ providerId: "api-media", api: "openai-completions" });
    expect(catalog.models.find((model) => model.id === "upstream-render")).toMatchObject({ purpose: "image", outputModalities: ["image"] });
    expect(catalog.models.find((model) => model.id === "upstream-chat")).toMatchObject({ outputModalities: ["text"] });
    expect(catalog.models.find((model) => model.id === "gpt-image-2.6-sunburst")).toMatchObject({ purpose: "image" });
    await providerManager.models.refresh({ providers: ["api-media"], force: true, allowNetwork: true });
    expect(providerManager.models.getModels("api-media").map((model) => model.id)).toEqual(["vision-chat", "upstream-chat"]);
  });

  it("discovers native Gemini image endpoints even when they do not declare generateContent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [
      { name: "models/gemini-nano-banana-2.1", supportedGenerationMethods: ["interactions"] },
      { name: "models/custom-photo", supportedGenerationMethods: ["generateImages"] },
      { name: "models/embedding-only", supportedGenerationMethods: ["embedContent"] },
    ] }), { headers: { "Content-Type": "application/json" } })));
    const catalog = await manager().discoverModels({ api: "google-generative-ai", baseUrl: "https://gemini.example/v1beta" });
    expect(catalog.models.map((model) => [model.id, model.purpose])).toEqual([["gemini-nano-banana-2.1", "image"], ["custom-photo", "image"]]);
  });

  it("reuses a saved connection key for an unregistered image model only at the same origin", async () => {
    const providerManager = manager();
    await providerManager.credentials.modify("api-media", async () => ({ type: "api_key", key: "synthetic-media-key", env: { KULO_API_KEY_ORIGIN: "https://image-models.example" } }));
    expect(await providerManager.resolveServiceApiKey("api-media", "gpt-image-2.6-flare", "https://image-models.example/v1")).toBe("synthetic-media-key");
    expect(await providerManager.resolveServiceApiKey("api-media", "gpt-image-2.6-flare", "https://other.example/v1")).toBeUndefined();
    await providerManager.credentials.modify("api-media", async () => ({ type: "oauth", access: "synthetic-oauth-token", refresh: "synthetic-refresh-token", expires: Date.now() + 60_000 }));
    expect(await providerManager.resolveServiceApiKey("api-media", "gpt-image-2.6-flare", "https://image-models.example/v1")).toBeUndefined();
  });

  it.each(["gpt-image-2.6-flare", "vendor-custom-render"])("rejects %s as a default conversation model before saving", (id) => {
    const doc = settings();
    const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "model", 1, { defaultModel: id })).toThrow(/图像/);
    expect(doc).toEqual(before);
  });

  it("rejects image models in worker presets while retaining vision chat models", () => {
    const doc = settings();
    const role = { label: "Worker", whenToUse: "Work", prompt: "Work", provider: "api-media" };
    expect(() => applySettingsBlockUpdate(doc, "roles", 1, { worker: { ...role, modelId: "vendor-custom-render" } })).toThrow(/图像/);
    expect(() => applySettingsBlockUpdate(doc, "roles", 1, { worker: { ...role, modelId: "vision-chat" } })).not.toThrow();
  });

  it("retains image metadata in legacy stored catalogs while preventing runtime selection", () => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "model", 1, { customProviders: config().customProviders });
    expect(doc.model.customProviders![0]!.models).toContainEqual(outputModel);
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "api-media", models: [{ id: "vision-chat" }, { id: "gpt-image-2.6-flare" }] }).provider);
    expect(withThinkingLevelModels(models).getModel("api-media", "gpt-image-2.6-flare")).toBeUndefined();
    expect(() => resolveModelThinkingSelection(models, "api-media", "vendor-custom-render", "off", config())).toThrow(/图像/);
  });

  it("isolates tts, asr, and live models from conversation runtime and syncs image models + /v1beta gateway routing", async () => {
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const { createRegistry, Harness, MemoryStorage } = await import("@earendil-works/pi-durable");
    const { KuloCapabilities } = await import("../packages/hub/src/capabilities");
    const { FileCredentialStore } = await import("../packages/hub/src/providers");
    const { generateImage } = await import("../packages/hub/src/media-adapters");

    const multiPurposeModels: CustomModelConfig[] = [
      { id: "chat-main", purpose: "chat" },
      { id: "gpt-4o-mini-tts", purpose: "tts", protocolAdapter: "openai-speech", voices: ["alloy"] },
      { id: "gpt-4o-transcribe", purpose: "asr", protocolAdapter: "openai-asr" },
      { id: "gpt-4o-realtime-preview", purpose: "live", protocolAdapter: "openai-realtime", voices: ["marin"] },
      { id: "gemini-3.1-flash-image-preview", purpose: "image", protocolAdapter: "gemini-image" },
    ];
    const pm = manager();
    pm.syncProviders({
      ...config(),
      defaultModel: "chat-main",
      customProviders: [{ id: "api-newapi", name: "NewAPI", api: "openai-completions", baseUrl: "https://newapi.example.com/v1", models: multiPurposeModels }],
    }, {});
    expect(pm.models.getModels("api-newapi").map((m) => m.id)).toEqual(["chat-main"]);
    const cat = await pm.getProviderCatalogItem("api-newapi");
    expect(cat.models.map((m) => [m.id, m.purpose ?? "chat"])).toEqual([
      ["chat-main", "chat"],
      ["gpt-4o-mini-tts", "tts"],
      ["gpt-4o-transcribe", "asr"],
      ["gpt-4o-realtime-preview", "live"],
      ["gemini-3.1-flash-image-preview", "image"],
    ]);

    const doc = settings();
    doc.model.customProviders = [{ id: "api-newapi", name: "NewAPI", api: "openai-completions", baseUrl: "https://newapi.example.com/v1", models: multiPurposeModels }];
    doc.model.defaultProvider = "api-newapi";
    for (const nonChatId of ["gpt-4o-mini-tts", "gpt-4o-transcribe", "gpt-4o-realtime-preview", "gemini-3.1-flash-image-preview"]) {
      expect(() => applySettingsBlockUpdate(structuredClone(doc), "model", 1, { defaultModel: nonChatId })).toThrow(/不能设为默认对话|图像/);
    }

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-sync-cap-"));
    directories.push(stateDir);
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      const caps = new KuloCapabilities({
        harness,
        credentials: new FileCredentialStore(path.join(stateDir, "credentials.json")),
        resolveProviderApiKey: async (_pid, url) => (new URL(url).origin === "https://newapi.example.com" ? "synthetic-newapi-key" : undefined),
        envs: () => [],
        browser: async () => { throw new Error("unused"); },
      });
      await caps.syncProviderImageModels([{
        id: "api-newapi",
        name: "NewAPI",
        baseUrl: "https://newapi.example.com/v1",
        api: "openai-completions",
        models: multiPurposeModels,
      }]);
      const snap = await caps.snapshot();
      expect(snap.capabilities).toHaveLength(1);
      expect(snap.capabilities[0]).toMatchObject({ modelId: "gemini-3.1-flash-image-preview", enabled: true, allowTaskGeneration: true, status: "unverified" });
      expect(snap.connections[0]).toMatchObject({ adapter: "gemini-image", baseUrl: "https://newapi.example.com/v1beta", origin: "https://newapi.example.com", hasCredential: true });

      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
      const fetcher = vi.fn(async () => new Response(JSON.stringify({
        id: "ix-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }],
      }), { headers: { "Content-Type": "application/json" } }));
      const outputs = await generateImage({
        job: {
          id: "job-1", operationId: "op-1", capabilityId: snap.capabilities[0]!.id, capabilityRevision: 1,
          connectionId: snap.connections[0]!.id, adapter: "gemini-image", modelId: "gemini-3.1-flash-image-preview",
          kind: "image", prompt: "test banana", inputAssetIds: [], format: "png", count: 1,
          imageProfile: snap.capabilities[0]!.imageProfile, source: { conversationId: 1, topicId: "root" },
          status: "running", assets: [], createdAt: 1, updatedAt: 1,
        },
        connection: snap.connections[0]!,
        apiKey: "synthetic-newapi-key",
        inputs: [],
        fetcher: fetcher as unknown as typeof fetch,
      });
      expect(outputs).toHaveLength(1);
      const [calledUrl, calledInit] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
      expect(String(calledUrl)).toBe("https://newapi.example.com/v1beta/interactions");
      expect(calledInit.headers).toMatchObject({ "x-goog-api-key": "synthetic-newapi-key", Authorization: "Bearer synthetic-newapi-key" });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
