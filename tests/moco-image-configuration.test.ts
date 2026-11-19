import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoverModelsRequest, DiscoverModelsResponse, ImageCapabilityConfiguration, ProviderCatalogItem, ProviderModelItem } from "@moco/protocol";
import { MocoCapabilities } from "../packages/hub/src/capabilities.js";
import { ImageConfigurationDoc, MocoImageConfiguration } from "../packages/hub/src/image-configuration.js";
import { FileCredentialStore } from "../packages/hub/src/providers.js";

const cleanup: Array<() => void | Promise<void>> = [];
const key = "synthetic-image-setup-test-key";
const configuration = (extra: Partial<ImageCapabilityConfiguration> = {}): ImageCapabilityConfiguration => ({
  adapter: "openai-image", name: "Image model", modelId: "gpt-image-2.6-flare", baseUrl: "https://images.example/v1", ...extra,
});
const model = (id: string, extra: Partial<ProviderModelItem> = {}): ProviderModelItem => ({
  id, name: id, modalities: ["text", "image"], vision: true, reasoning: false, supportedThinkingLevels: ["off"],
  contextWindow: 100_000, maxTokens: 10_000, ...extra,
});
const provider = (id: string, extra: Partial<ProviderCatalogItem> = {}): ProviderCatalogItem => ({
  id, name: id, builtin: false, api: "openai-completions", baseUrl: "https://api.openai.com/v1",
  authenticated: true, authType: "api_key", supportsApiKey: true, supportsOAuth: false, models: [], ...extra,
});

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-image-setup-test-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "setup", models: [{ id: "chat" }] }).provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "setup", modelId: "chat" } } });
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const state = { providers: [provider("api-images")] };
  const capabilities = new MocoCapabilities({ harness, credentials: new FileCredentialStore(path.join(directory, "credentials.json")),
    envs: () => [], browser: async () => { throw new Error("Browser is not used by image setup tests"); },
    resolveProviderApiKey: async (id, baseUrl) => state.providers.some((item) => item.id === id && item.baseUrl === baseUrl && item.authenticated && item.authType === "api_key") ? key : undefined,
  });
  const discover = vi.fn(async (_request: DiscoverModelsRequest): Promise<DiscoverModelsResponse> => ({ ok: true, latencyMs: 0, models: [model("gpt-image-2.6-flare"), model("vision-chat")] }));
  const onChanged = vi.fn();
  const setup = new MocoImageConfiguration({ harness, capabilities, providers: async () => state.providers, discover, onChanged });
  return { harness, setup, capabilities, state, discover, onChanged };
}

describe("shared image configuration workspace", () => {
  it("shares incomplete drafts within one client, isolates other clients and rejects lost updates", async () => {
    const f = await fixture();
    const first = await f.setup.updateDraft({ clientId: "client-a", expectedRevision: 0, config: configuration({ name: "", modelId: "", baseUrl: "" }) });
    expect(first).toMatchObject({ clientId: "client-a", revision: 1, config: { name: "", modelId: "", baseUrl: "" } });
    expect((await f.setup.workspace("client-a")).draft).toEqual(first);
    expect((await f.setup.workspace("client-b")).draft).toBeUndefined();
    const updated = await f.setup.updateDraft({ clientId: "client-a", expectedRevision: first.revision, config: configuration({ name: "Filled by the assistant" }) });
    await expect(f.setup.updateDraft({ clientId: "client-a", expectedRevision: first.revision, config: configuration({ name: "Stale form" }) })).rejects.toMatchObject({ status: 409, code: "image_draft_conflict" });
    expect((await f.setup.workspace("client-a")).draft).toEqual(updated);
    await expect(f.setup.discardDraft("client-a", first.revision)).rejects.toMatchObject({ status: 409 });
    await f.setup.discardDraft("client-a", updated.revision);
    expect((await f.setup.workspace("client-a")).draft).toBeUndefined();
  });

  it("allows incomplete drafts but refuses to save them as working capabilities", async () => {
    const f = await fixture();
    const draft = await f.setup.updateDraft({ clientId: "client-a", config: configuration({ name: "", modelId: "" }) });
    await expect(f.setup.saveDraft({ clientId: "client-a", expectedRevision: draft.revision, commandId: "incomplete-save" })).rejects.toMatchObject({ status: 400 });
    expect((await f.setup.workspace("client-a")).draft).toEqual(draft);
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it("rejects a delayed editor update after its draft was discarded and recreated", async () => {
    const f = await fixture();
    const before = await f.setup.updateDraft({ clientId: "client-a", config: configuration({ name: "First draft" }) });
    await f.setup.discardDraft("client-a", before.revision);
    const current = await f.setup.updateDraft({ clientId: "client-a", config: configuration({ name: "New draft" }) });
    expect(current.revision).toBeGreaterThan(before.revision);
    await expect(f.setup.updateDraft({ clientId: "client-a", expectedRevision: before.revision, config: configuration({ name: "Delayed old editor" }) })).rejects.toMatchObject({ status: 409, code: "image_draft_conflict" });
    expect((await f.setup.workspace("client-a")).draft).toEqual(current);
  });

  it.each([
    { apiKey: key },
    { baseUrl: `https://username:${key}@images.example/v1` },
    { baseUrl: `https://images.example/v1?api_key=${key}` },
    { defaults: { custom: { access_token: key } } },
    { customAdapter: { generate: { headers: { Authorization: key } } } },
    JSON.parse('{"defaults":{"custom":{"__proto__":{"polluted":true}}}}'),
    { routing: { constructor: { polluted: true } } },
  ])("rejects secret or prototype-bearing draft data without persisting it", async (extra) => {
    const f = await fixture();
    await expect(f.setup.updateDraft({ clientId: "client-a", config: { ...configuration(), ...extra } as ImageCapabilityConfiguration })).rejects.toMatchObject({ status: 400 });
    expect((await f.setup.workspace("client-a")).draft).toBeUndefined();
    expect(JSON.stringify(await f.harness.snapshot(ImageConfigurationDoc, BACKGROUND_CONTEXT)) ?? "").not.toContain(key);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("replays a save without duplicating a capability or its protected input", async () => {
    const f = await fixture();
    const draft = await f.setup.updateDraft({ clientId: "client-a", config: configuration() });
    const request = { clientId: "client-a", expectedRevision: draft.revision, commandId: "save-once" };
    const [first, repeated] = await Promise.all([f.setup.saveDraft(request), f.setup.saveDraft(request)]);
    expect(repeated).toEqual(first);
    expect(first.input).toMatchObject({ clientId: "client-a", capabilityId: first.capability.id, kind: "secret" });
    expect((await f.capabilities.snapshot()).capabilities).toHaveLength(1);
    expect(await f.capabilities.listInputs("client-a")).toHaveLength(1);
    expect(await f.capabilities.listInputs("client-b")).toEqual([]);
    expect((await f.setup.workspace("client-a")).draft).toBeUndefined();
    await expect(f.setup.saveDraft({ ...request, expectedRevision: draft.revision + 1 })).rejects.toMatchObject({ code: "image_setup_command_conflict" });
    await expect(f.setup.saveDraft({ ...request, clientId: "client-b" })).rejects.toMatchObject({ code: "image_draft_conflict" });
  });

  it("discovers fresh image outputs while retaining visual chat and subscription boundaries", async () => {
    const f = await fixture();
    f.state.providers = [
      provider("api-images", { models: [model("gpt-image-2.5-sunburst"), model("vision-chat")] }),
      provider("subscription", { authType: "oauth", supportsOAuth: true }),
      provider("disconnected", { authenticated: false }),
      provider("google-images", { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
    ];
    f.discover.mockImplementation(async (request: { providerId?: string }) => ({ ok: true, latencyMs: 0, models: request.providerId === "google-images"
      ? [model("models/gemini-nano-banana-2.1"), model("models/gemini-chat")]
      : [model("fresh-render", { purpose: "image", outputModalities: ["image"] }), model("gpt-image-2.6-flare?invalid"), model("vision-chat")] }));
    const found = await f.setup.discover("client-a");
    expect(f.discover.mock.calls.map(([request]) => request.providerId)).toEqual(["api-images", "google-images"]);
    expect(found.candidates.map((candidate) => candidate.modelId)).toEqual(["fresh-render", "gpt-image-2.5-sunburst", "gemini-nano-banana-2.1"]);
    expect(found.candidates.find((candidate) => candidate.modelId === "gemini-nano-banana-2.1")).toMatchObject({ adapter: "gemini-image", providerId: "google-images" });
    expect(found.candidates.every((candidate) => candidate.id !== candidate.modelId)).toBe(true);
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
    expect((await f.setup.workspace("client-b")).discovery).toBeUndefined();
    expect((await f.setup.workspace()).providers.find((item) => item.id === "subscription")).toMatchObject({ imageSupported: false });
    await expect(f.setup.discover("client-a", ["subscription"])).rejects.toMatchObject({ code: "image_provider_unavailable" });
  });

  it("shows a partial result when a live directory fails without substituting unseen model IDs", async () => {
    const f = await fixture();
    f.state.providers = [provider("api-images", { models: [model("gpt-image-2.5-flare")] })];
    f.discover.mockResolvedValue({ ok: false, latencyMs: 0, models: [] });
    const found = await f.setup.discover("client-a");
    expect(found).toMatchObject({ status: "partial", errors: [{ providerId: "api-images" }] });
    expect(found.candidates.map((candidate) => candidate.modelId)).toEqual(["gpt-image-2.5-flare"]);
  });

  it("uses a builtin API connection's model protocol for discovery and import", async () => {
    const f = await fixture();
    f.state.providers = [provider("openai", { builtin: true, api: undefined, models: [model("vision-chat", { api: "openai-responses" })] })];
    expect((await f.setup.workspace("client-a")).providers[0]).toMatchObject({ api: "openai-responses", imageSupported: true });
    const found = await f.setup.discover("client-a");
    expect(f.discover).toHaveBeenCalledWith({ providerId: "openai", api: "openai-responses" });
    expect(found.candidates[0]).toMatchObject({ adapter: "openai-image", modelId: "gpt-image-2.6-flare" });
    const imported = await f.setup.importModels({ clientId: "client-a", discoveryId: found.id, candidateIds: [found.candidates[0]!.id], commandId: "builtin-import" });
    expect(imported.added).toHaveLength(1);
    expect(imported.errors).toEqual([]);
  });

  it("requires image interface configuration for an unverified compatible gateway", async () => {
    const f = await fixture();
    f.state.providers = [provider("compatible-gateway", { baseUrl: "https://gateway.example/v1" })];
    const found = await f.setup.discover("client-a");
    expect(found.candidates[0]).toMatchObject({ needsConfiguration: true, adapter: "custom-image" });
    const result = await f.setup.importModels({ clientId: "client-a", discoveryId: found.id, candidateIds: [found.candidates[0]!.id], commandId: "gateway-import" });
    expect(result.added).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it.each([{ imageProfile: { formats: "png" } }, { imageProfile: { formats: ["png"], supportsEdit: false, maxReferences: 0, parameters: {} } }, { defaults: [] }])("rejects structurally invalid shared model declarations", async (extra) => {
    const f = await fixture();
    await expect(f.setup.updateDraft({ clientId: "client-a", config: { ...configuration(), ...extra } as ImageCapabilityConfiguration })).rejects.toMatchObject({ status: 400 });
    expect((await f.setup.workspace("client-a")).draft).toBeUndefined();
  });

  it("rejects forged candidate IDs, cross-client reuse and a stale discovery before adding models", async () => {
    const f = await fixture();
    const found = await f.setup.discover("client-a");
    const request = { clientId: "client-a", discoveryId: found.id, candidateIds: [found.candidates[0]!.id], commandId: "import-models" };
    await expect(f.setup.importModels({ ...request, allowTaskGeneration: "true" as never })).rejects.toMatchObject({ code: "invalid_image_generation_permission" });
    await expect(f.setup.importModels({ ...request, candidateIds: [found.candidates[0]!.modelId] })).rejects.toMatchObject({ code: "image_candidate_unavailable" });
    await expect(f.setup.importModels({ ...request, clientId: "client-b" })).rejects.toMatchObject({ code: "image_discovery_changed" });
    await f.setup.discover("client-a");
    await expect(f.setup.importModels(request)).rejects.toMatchObject({ code: "image_discovery_changed" });
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it("requires rediscovery after an origin changes and keeps model import disabled by default", async () => {
    const f = await fixture();
    const found = await f.setup.discover("client-a");
    const request = { clientId: "client-a", discoveryId: found.id, candidateIds: [found.candidates[0]!.id], commandId: "import-origin" };
    f.state.providers[0]!.baseUrl = "https://changed.example/v1";
    expect(await f.setup.importModels(request)).toMatchObject({ added: [], errors: [{ candidateId: found.candidates[0]!.id }] });
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
    f.state.providers[0]!.baseUrl = found.candidates[0]!.baseUrl;
    const imported = await f.setup.importModels(request);
    expect(imported.added).toHaveLength(1);
    expect(imported.added[0]).toMatchObject({ allowTaskGeneration: false });
    expect(await f.setup.importModels(request)).toEqual(imported);
    const later = await f.setup.importModels({ ...request, commandId: "import-again", allowTaskGeneration: true });
    expect(later.added[0]!.id).toBe(imported.added[0]!.id);
    expect(later.added[0]!.allowTaskGeneration).toBe(false);
    expect((await f.setup.workspace("client-a")).discovery!.candidates[0]!.alreadyAdded).toBe(true);
    expect((await f.capabilities.snapshot()).capabilities).toHaveLength(1);
    expect(await f.capabilities.listInputs("client-a")).toEqual([]);
  });

  it("imports a model only once when two windows select the same supplier model concurrently", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.setup.discover("client-a"), f.setup.discover("client-b")]);
    const [first, second] = await Promise.all([
      f.setup.importModels({ clientId: "client-a", discoveryId: a.id, candidateIds: [a.candidates[0]!.id], commandId: "select", allowTaskGeneration: true }),
      f.setup.importModels({ clientId: "client-b", discoveryId: b.id, candidateIds: [b.candidates[0]!.id], commandId: "select", allowTaskGeneration: false }),
    ]);
    expect(first.added).toHaveLength(1);
    expect(first.added[0]!.allowTaskGeneration).toBe(true);
    expect(second.added[0]!.id).toBe(first.added[0]!.id);
    expect((await f.capabilities.snapshot()).capabilities).toHaveLength(1);
  });
});
