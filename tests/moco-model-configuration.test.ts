import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderConfig, MocoSettingsView, ProviderCatalogItem, ProviderModelItem } from "@moco/protocol";
import { MocoModelConfiguration, ModelConfigurationDoc, type ModelConfigurationOptions } from "../packages/hub/src/model-configuration";

const cleanup: Array<() => Promise<void>> = [];
const secret = "test-only-arbitrary-credential-42";
const model = (id = "chat"): ProviderModelItem => ({ id, name: id, contextWindow: 100_000, maxTokens: 8_000, modalities: ["text", "image"], vision: true, reasoning: false, supportedThinkingLevels: ["off"] });
const connection = (id: string, extra: Partial<ProviderCatalogItem> = {}): ProviderCatalogItem => ({ id, name: id, builtin: false, authenticated: true, authType: "api_key", supportsApiKey: true, supportsOAuth: false, api: "openai-completions", baseUrl: "https://provider.example/v1", models: [model()], ...extra });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const models = createModels(); models.setProvider(fauxProvider({ provider: "setup", models: [{ id: "chat" }] }).provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "setup", modelId: "chat" } } });
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const state = {
    providers: [connection("api-existing")],
    settings: { blocks: { model: { revision: 1, hasApiKey: false, value: { baseUrl: "https://gateway.example/v1", apiMode: "openai-completions", defaultModel: "chat", defaultProvider: "api-existing", thinkingLevel: "off", customProviders: [{ id: "api-existing", name: "Existing", api: "openai-completions", baseUrl: "https://provider.example/v1", models: [{ id: "chat", contextWindow: 8_000, maxTokens: 4_000, modalities: ["text"] }] }] } } } } as MocoSettingsView,
    failAfterCommit: false,
    committed: 0,
    savedKey: "",
  };
  const secrets = new Set([secret]);
  const discover = vi.fn<ModelConfigurationOptions["discover"]>(async () => ({ ok: true, models: [model()], latencyMs: 1 }));
  const probe = vi.fn<ModelConfigurationOptions["probe"]>(async (request) => ({ ok: true, latencyMs: 2, baseUrl: request.baseUrl!, model: request.model!, availableModels: [], checkedAt: Date.now() }));
  const saveProvider = vi.fn<ModelConfigurationOptions["saveProvider"]>(async (input) => {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ModelConfigurationDoc);
      if (doc.commits[input.operationKey]) return;
      if (state.settings.blocks.model.revision !== input.expectedSettingsRevision) throw new Error("stale settings");
      state.settings.blocks.model.value.customProviders = [...(state.settings.blocks.model.value.customProviders ?? []).filter((item) => item.id !== input.provider.id), input.provider];
      state.settings.blocks.model.revision += 1; state.committed += 1; state.savedKey = input.apiKey ?? "";
      doc.commits[input.operationKey] = input.commit;
    }, BACKGROUND_CONTEXT);
    if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error("runtime apply failed"); }
    return structuredClone(state.settings);
  });
  const options: ModelConfigurationOptions = { harness, settings: () => state.settings, providers: async () => state.providers, discover, probe, saveProvider, redact: (text) => [...secrets].reduce((value, key) => value.split(key).join("[hidden]"), text), rememberSecrets: (values) => values.forEach((value) => secrets.add(value)) };
  const service = new MocoModelConfiguration(options);
  const fresh = async () => service.prepare({ clientId: "window-a", name: "Example", baseUrl: "https://provider.example/v1" });
  const selected = async () => {
    let draft = await fresh(); draft = await service.supplyCredential({ clientId: draft.clientId, expectedRevision: draft.revision, apiKey: secret }); draft = await service.discover(draft.clientId, draft.revision);
    return service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: draft.provider, selectedModelIds: ["chat"], defaultModelId: "chat" });
  };
  return { harness, service, options, state, discover, probe, saveProvider, fresh, selected };
}

describe("model configuration workspace", () => {
  it("resolves supported supplier presets while allocating an independent API identity", async () => {
    const f = await fixture(); const draft = await f.service.prepare({ clientId: "window-a", preset: "anthropic" });
    expect(draft.provider).toMatchObject({ name: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", preset: "anthropic" });
    expect(draft.provider.id).toMatch(/^api-/); expect(draft.provider.id).not.toBe("anthropic");
    expect((await f.service.workspace("window-a")).presets?.some((item) => item.id === "google")).toBe(true);
  });
  it("creates an isolated API identity and keeps windows and concurrent draft updates separate", async () => {
    const f = await fixture(); const draft = await f.fresh();
    expect(draft.provider.id).toMatch(/^api-/);
    expect((await f.service.workspace("window-b")).draft).toBeUndefined();
    await expect(f.service.prepare({ clientId: "window-a" })).rejects.toMatchObject({ code: "model_draft_exists" });
    const input = { clientId: "window-a", expectedRevision: draft.revision, provider: { ...draft.provider, name: "Updated" }, selectedModelIds: [] };
    const results = await Promise.allSettled([f.service.updateDraft(input), f.service.updateDraft(input)]);
    expect(results.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(f.service.prepare({ clientId: "window-b", providerId: "openai" })).rejects.toMatchObject({ code: "model_provider_not_custom" });
  });

  it("keeps draft credentials ephemeral, binds them to their origin, and never persists or returns them", async () => {
    const f = await fixture(); let draft = await f.fresh();
    draft = await f.service.supplyCredential({ clientId: draft.clientId, expectedRevision: draft.revision, apiKey: secret });
    expect(draft.hasCredential).toBe(true);
    expect(JSON.stringify(draft)).not.toContain(secret);
    expect(JSON.stringify(await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))).not.toContain(secret);
    expect((await new MocoModelConfiguration(f.options).workspace(draft.clientId)).draft?.hasCredential).toBe(false);
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: { ...draft.provider, baseUrl: "https://other.example/v1" }, selectedModelIds: [] });
    expect(draft.hasCredential).toBe(false);
    await f.service.discover(draft.clientId, draft.revision);
    expect(f.discover).toHaveBeenLastCalledWith(expect.not.objectContaining({ apiKey: secret }));
  });

  it("rejects secrets in public draft fields, unsafe endpoints and invalid capacities", async () => {
    const f = await fixture(); const draft = await f.fresh();
    const update = (provider: unknown) => f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: provider as CustomProviderConfig, selectedModelIds: [] });
    await expect(update({ ...draft.provider, apiKey: secret })).rejects.toMatchObject({ code: "invalid_model_provider_field" });
    await expect(update({ ...draft.provider, baseUrl: "https://user:pass@provider.example/v1" })).rejects.toMatchObject({ code: "invalid_model_endpoint" });
    await expect(update({ ...draft.provider, baseUrl: "https://provider.example/v1?key=value" })).rejects.toMatchObject({ code: "invalid_model_endpoint" });
    await expect(update({ ...draft.provider, models: [{ id: "chat", contextWindow: 10, maxTokens: 20 }] })).rejects.toMatchObject({ code: "invalid_model_capacity" });
  });

  it("retains existing parameters alongside unverified catalog references for review", async () => {
    const f = await fixture(); let draft = await f.service.prepare({ clientId: "window-a", providerId: "api-existing" });
    draft = await f.service.discover(draft.clientId, draft.revision);
    expect(draft.provider.models[0]?.contextWindow).toBe(8_000);
    expect(draft.candidates[0]?.catalogModel?.contextWindow).toBe(100_000);
    expect(draft.verifications).toEqual([]);
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("does not inherit the gateway credential for a new uncredentialed draft test", async () => {
    const f = await fixture(); let draft = await f.fresh(); draft = await f.service.discover(draft.clientId, draft.revision);
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: draft.provider, selectedModelIds: ["chat"] });
    await expect(f.service.test({ clientId: draft.clientId, expectedRevision: draft.revision, modelId: "chat", commandId: "uncredentialed-test" })).rejects.toMatchObject({ code: "model_test_credential_required" });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("tests only an explicitly selected model once and does not claim context or multimodal verification", async () => {
    const f = await fixture(); const draft = await f.selected();
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, modelId: "chat", commandId: "one-test" };
    const [first, repeated] = await Promise.all([f.service.test(input), f.service.test(input)]);
    expect(first.verification).toMatchObject({ kind: "text-call", modelId: "chat", ok: true });
    expect(repeated.verification).toEqual(first.verification);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: secret, model: "chat", baseUrl: "https://provider.example/v1" }), undefined);
    expect(Object.keys(first.verification)).not.toContain("contextWindow");
    await expect(f.service.test({ ...input, commandId: "different", expectedRevision: first.draft.revision, modelId: "unselected" })).rejects.toMatchObject({ code: "model_not_selected" });
  });

  it("replaces a previous successful text test on failure and clears tests after parameter changes", async () => {
    const f = await fixture(); let draft = await f.selected();
    draft = (await f.service.test({ clientId: draft.clientId, expectedRevision: draft.revision, modelId: "chat", commandId: "success" })).draft;
    f.probe.mockResolvedValueOnce({ ok: false, latencyMs: 1, baseUrl: draft.provider.baseUrl, model: "chat", availableModels: [], checkedAt: Date.now(), error: "unavailable" });
    draft = (await f.service.test({ clientId: draft.clientId, expectedRevision: draft.revision, modelId: "chat", commandId: "failure" })).draft;
    expect(draft.verifications).toHaveLength(1); expect(draft.verifications[0]?.ok).toBe(false);
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: { ...draft.provider, models: draft.provider.models.map((model) => ({ ...model, contextWindow: 90_000 })) }, selectedModelIds: ["chat"] });
    expect(draft.verifications).toEqual([]);
  });

  it("scrubs arbitrary saved key echoes from errors and rejects public directory key echoes", async () => {
    const f = await fixture(); let draft = await f.service.prepare({ clientId: "window-a", providerId: "api-existing" });
    f.probe.mockRejectedValueOnce(new Error(`upstream echoed ${secret}`));
    const tested = await f.service.test({ clientId: draft.clientId, expectedRevision: draft.revision, modelId: "chat", commandId: "echo" });
    expect(tested.verification.error).not.toContain(secret);
    draft = tested.draft;
    f.discover.mockResolvedValueOnce({ ok: true, latencyMs: 1, models: [{ ...model(), name: `echo ${secret}` }] });
    await expect(f.service.discover(draft.clientId, draft.revision)).rejects.toMatchObject({ code: "model_catalog_contains_secret" });
    expect(JSON.stringify(await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))).not.toContain(secret);
  });

  it("saves only selected models with an explicit default and replays without duplicate settings writes", async () => {
    const f = await fixture(); const draft = await f.selected();
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "save-once" };
    const [first, repeated] = await Promise.all([f.service.save(input), f.service.save(input)]);
    expect(first).toEqual(repeated); expect(f.state.committed).toBe(1);
    expect(f.state.savedKey).toBe(secret); expect(first.modelIds).toEqual(["chat"]); expect(first.defaultModelId).toBe("chat");
    expect(f.state.settings.blocks.model.value.customProviders).toHaveLength(2);
    expect((await f.service.workspace(draft.clientId)).draft).toBeUndefined();
    expect(JSON.stringify(await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))).not.toContain(secret);
  });

  it("recovers a committed save after runtime failure without duplicating the settings mutation", async () => {
    const f = await fixture(); const draft = await f.selected(); f.state.failAfterCommit = true;
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "recover-save" };
    await expect(f.service.save(input)).rejects.toMatchObject({ code: "model_configuration_save_failed" });
    expect(f.state.committed).toBe(1);
    const result = await f.service.save(input);
    expect(result.modelIds).toEqual(["chat"]); expect(f.state.committed).toBe(1);
    expect(Object.keys((await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))?.commits ?? {})).toHaveLength(0);
  });

  it("finishes draft cleanup when a saved receipt is replayed after cleanup storage failure", async () => {
    const f = await fixture(); const draft = await f.selected();
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "cleanup-retry" };
    const originalCommit = f.harness.commit.bind(f.harness); let failed = false;
    const injected = vi.spyOn(f.harness, "commit").mockImplementation(async (...args) => {
      const doc = await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT);
      if (!failed && Object.values(doc?.receipts ?? {}).some((receipt) => "providerId" in receipt.result) && doc?.drafts[draft.clientId]) { failed = true; throw new Error("injected cleanup storage failure"); }
      return originalCommit(...args);
    });
    try { await expect(f.service.save(input)).rejects.toThrow("injected cleanup storage failure"); }
    finally { injected.mockRestore(); }
    expect(f.state.committed).toBe(1);
    expect((await f.service.workspace(draft.clientId)).draft?.id).toBe(draft.id);
    expect(Object.values((await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT))?.receipts ?? {}).some((receipt) => receipt.cleanup?.draftId === draft.id)).toBe(true);
    const replayed = await f.service.save(input);
    expect(replayed.providerId).toBe(draft.provider.id);
    expect(f.saveProvider).toHaveBeenCalledTimes(1);
    expect((await f.service.workspace(draft.clientId)).draft).toBeUndefined();
    await expect(f.service.prepare({ clientId: draft.clientId })).resolves.toMatchObject({ clientId: draft.clientId, revision: 1, hasCredential: false });
  });

  it.each([false, true])("preserves a newer draft and clears only the original saved credential on receipt replay (new credential: %s)", async (replaceCredential) => {
    const f = await fixture(); const draft = await f.selected();
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: `cleanup-newer-${replaceCredential}` };
    const originalCommit = f.harness.commit.bind(f.harness); let failed = false;
    const injected = vi.spyOn(f.harness, "commit").mockImplementation(async (...args) => {
      const doc = await f.harness.snapshot(ModelConfigurationDoc, BACKGROUND_CONTEXT);
      if (!failed && Object.values(doc?.receipts ?? {}).some((receipt) => "providerId" in receipt.result) && doc?.drafts[draft.clientId]) { failed = true; throw new Error("injected cleanup storage failure"); }
      return originalCommit(...args);
    });
    try { await expect(f.service.save(input)).rejects.toThrow("injected cleanup storage failure"); }
    finally { injected.mockRestore(); }
    let newer = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: { ...draft.provider, name: "New unsaved edits" }, selectedModelIds: draft.selectedModelIds });
    if (replaceCredential) newer = await f.service.supplyCredential({ clientId: newer.clientId, expectedRevision: newer.revision, apiKey: "newer-staged-credential" });
    const replayed = await f.service.save(input);
    expect(replayed.providerId).toBe(draft.provider.id);
    expect(f.saveProvider).toHaveBeenCalledTimes(1);
    expect((await f.service.workspace(draft.clientId)).draft).toMatchObject({ id: draft.id, revision: newer.revision, provider: { name: "New unsaved edits" }, hasCredential: replaceCredential });
  });

  it("rejects stale global settings and an unselected default before mutating", async () => {
    const f = await fixture(); const draft = await f.selected();
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, provider: draft.provider, selectedModelIds: ["chat"], defaultModelId: "other" })).rejects.toMatchObject({ code: "invalid_default_model" });
    f.state.settings.blocks.model.revision += 1;
    await expect(f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "stale-save" })).rejects.toMatchObject({ code: "model_settings_changed" });
    expect(f.saveProvider).not.toHaveBeenCalled();
  });
});
