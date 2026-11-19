import { describe, expect, it, vi } from "vitest";
import type { MocoSettingsView, ProviderCatalogItem } from "@moco/protocol";
import { ProviderCatalogCache, providerCatalogSettingsKey } from "./provider-catalog";
import { toProviderModelItem } from "./settings-helpers";

const provider: ProviderCatalogItem = {
  id: "api-demo", name: "Demo", builtin: false, authenticated: true, authType: "api_key",
  supportsApiKey: true, supportsOAuth: false, api: "openai-responses",
  models: [toProviderModelItem({ id: "demo-chat" })],
};
const settings = {
  globalRevision: 1,
  blocks: {
    model: { revision: 1, hasApiKey: false, value: {
      baseUrl: "https://models.example.test/v1", apiMode: "openai-responses", defaultModel: "demo-chat",
      defaultProvider: "api-demo", thinkingLevel: "medium", gatewayDisabled: true,
      customProviders: [{ id: "api-demo", name: "Demo", api: "openai-responses", baseUrl: "https://models.example.test/v1", models: [{ id: "demo-chat" }] }],
    } },
    roles: { revision: 1, value: {} },
  },
} as MocoSettingsView;

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shared provider catalog", () => {
  it("preloads once and reuses a complete catalog across consumers and remounts", async () => {
    const pending = deferred<{ providers: ProviderCatalogItem[] }>();
    const load = vi.fn().mockReturnValue(pending.promise);
    const cache = new ProviderCatalogCache(load);
    const preload = cache.ensure();
    const consumer = cache.configure(settings);
    expect(consumer).toBe(preload);
    pending.resolve({ providers: [provider] });
    await preload;
    const ready = cache.getSnapshot();
    const unsubscribe = cache.subscribe(vi.fn());
    unsubscribe();
    await cache.configure(structuredClone(settings));
    await cache.ensure();
    expect(load).toHaveBeenCalledOnce();
    expect(cache.getSnapshot()).toBe(ready);
    expect(ready).toMatchObject({ providers: [provider], loaded: true, refreshing: false });
  });

  it("keeps known authentication and models usable during a background refresh", async () => {
    const pending = deferred<{ providers: ProviderCatalogItem[] }>();
    const load = vi.fn().mockResolvedValueOnce({ providers: [provider] }).mockReturnValueOnce(pending.promise);
    const cache = new ProviderCatalogCache(load);
    await cache.ensure();
    const refresh = cache.refresh();
    expect(cache.getSnapshot()).toMatchObject({ providers: [provider], loaded: true, refreshing: true });
    pending.resolve({ providers: [{ ...provider, models: [] }] });
    await refresh;
    expect(cache.getSnapshot()).toMatchObject({ providers: [{ ...provider, models: [] }], refreshing: false });
  });

  it("does not scan credentials again for thinking, compaction or unrelated settings changes", async () => {
    const load = vi.fn().mockResolvedValue({ providers: [provider] });
    const cache = new ProviderCatalogCache(load);
    await cache.configure(settings);
    const next = structuredClone(settings);
    next.globalRevision++;
    next.blocks.model.revision++;
    next.blocks.model.value.thinkingLevel = "high";
    next.blocks.model.value.compaction = { enabled: true, reserveTokens: 8192, keepRecentTokens: 16000, backgroundTokens: 16000 };
    expect(providerCatalogSettingsKey(next)).toBe(providerCatalogSettingsKey(settings));
    await cache.configure(next);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(["endpoint", "models", "selection", "context", "roles", "gateway credential"])("refreshes after a %s change", async (change) => {
    const load = vi.fn().mockResolvedValue({ providers: [provider] });
    const cache = new ProviderCatalogCache(load);
    await cache.configure(settings);
    const next = structuredClone(settings);
    if (change === "endpoint") next.blocks.model.value.customProviders![0]!.baseUrl = "https://other.example.test/v1";
    if (change === "models") next.blocks.model.value.customProviders![0]!.models.push({ id: "new-chat" });
    if (change === "selection") next.blocks.model.value.defaultModel = "new-chat";
    if (change === "context") next.blocks.model.value.contextWindow = 128000;
    if (change === "roles") next.blocks.roles.value.worker = { id: "worker", label: "Worker", whenToUse: "", prompt: "", readOnly: false, provider: "api-demo", modelId: "new-chat" };
    if (change === "gateway credential") next.blocks.model.hasApiKey = true;
    await cache.configure(next);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never lets an older catalog overwrite a completed credential change", async () => {
    const stale = deferred<{ providers: ProviderCatalogItem[] }>();
    const current = { ...provider, authenticated: false, authType: undefined };
    const load = vi.fn().mockResolvedValueOnce({ providers: [provider] }).mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ providers: [current] });
    const cache = new ProviderCatalogCache(load);
    await cache.ensure();
    const seen: boolean[] = [];
    cache.subscribe(() => seen.push(cache.getSnapshot().providers[0]!.authenticated));
    const refresh = cache.refresh();
    await Promise.resolve();
    cache.updateProvider(current);
    seen.length = 0;
    stale.resolve({ providers: [provider] });
    await refresh;
    expect(seen.every((authenticated) => !authenticated)).toBe(true);
    expect(cache.getSnapshot().providers).toEqual([current]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("shares credential, subscription and model updates immediately", async () => {
    const load = vi.fn().mockResolvedValue({ providers: [provider] });
    const cache = new ProviderCatalogCache(load);
    await cache.ensure();
    const subscription = { ...provider, id: "openai-codex", builtin: true, authType: "oauth" as const };
    cache.updateProvider(subscription);
    expect(cache.getSnapshot().providers).toEqual([provider, subscription]);
    cache.updateProvider({ ...provider, models: [] });
    expect(cache.getSnapshot().providers[0]!.models).toEqual([]);
    cache.updateProvider(null, provider.id);
    expect(cache.getSnapshot().providers).toEqual([subscription]);
    await cache.ensure();
    expect(load).toHaveBeenCalledOnce();
  });

  it("surfaces failures without replacing the last catalog and supports retry", async () => {
    const error = new Error("Catalog unavailable");
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ providers: [provider] })
      .mockRejectedValueOnce(error).mockResolvedValueOnce({ providers: [] });
    const cache = new ProviderCatalogCache(load);
    await cache.ensure();
    expect(cache.getSnapshot()).toMatchObject({ loaded: false, refreshing: false, error });
    await cache.refresh();
    await cache.refresh();
    expect(cache.getSnapshot()).toMatchObject({ providers: [provider], loaded: true, refreshing: false, error });
    await cache.refresh();
    expect(cache.getSnapshot()).toMatchObject({ providers: [], loaded: true, error: null });
  });

  it("drops another Hub's authentication state and ignores its pending response", async () => {
    const stale = deferred<{ providers: ProviderCatalogItem[] }>();
    const load = vi.fn().mockResolvedValueOnce({ providers: [provider] }).mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ providers: [] });
    const cache = new ProviderCatalogCache(load);
    cache.setScope("first-hub");
    await cache.ensure();
    const refresh = cache.refresh();
    await Promise.resolve();
    cache.setScope("second-hub");
    expect(cache.getSnapshot()).toMatchObject({ providers: [], loaded: false });
    stale.resolve({ providers: [provider] });
    await refresh;
    expect(cache.getSnapshot()).toMatchObject({ providers: [], loaded: true });
  });
});
