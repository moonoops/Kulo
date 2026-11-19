import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SearchFailure, SearchPlanInput, WebSearchInput } from "@moco/protocol";
import { FileCredentialStore } from "../packages/hub/src/providers.js";
import { MocoSearch, MocoSearchDoc } from "../packages/hub/src/search.js";
import { fetchSearchPageAdapter, runSearchAdapter } from "../packages/hub/src/search-adapters.js";
import { fetchWebPage } from "../packages/hub/src/web-content.js";

vi.mock("../packages/hub/src/search-adapters.js", () => ({
  runSearchAdapter: vi.fn(),
  fetchSearchPageAdapter: vi.fn(),
}));
vi.mock("../packages/hub/src/web-content.js", () => ({ fetchWebPage: vi.fn() }));

const cleanup: Array<() => Promise<void> | void> = [];
const source = { id: "source-test", title: "Primary source", url: "https://example.com/docs", snippet: "A source excerpt." };
const keyA = "synthetic-tavily-first-key";
const keyB = "synthetic-tavily-second-key";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MOCO_SEARCH_API_KEY", "");
  vi.mocked(runSearchAdapter).mockResolvedValue({ sources: [source] });
  vi.mocked(fetchSearchPageAdapter).mockResolvedValue(undefined);
  vi.mocked(fetchWebPage).mockResolvedValue({ url: source.url, title: source.title, content: "Full article", truncated: false, sources: [source] });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
});

async function fixture(options: { directory?: string; attemptTimeoutMs?: number; timeoutMs?: number; preservePreset?: boolean; initialize?: boolean;
  fetch?: typeof fetch; pageFetch?: typeof fetch;
  migrateNativePlan?: (plan: { providerId: string; modelId: string; enabled: boolean }) => Promise<void | boolean> } = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-search-"));
  if (!options.directory) cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "independent-search-provider", models: [{ id: "search-model" }] }).provider);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await harness.close(BACKGROUND_CONTEXT); } };
  cleanup.push(close);
  const credentials = new FileCredentialStore(path.join(directory, "credentials.json"));
  const changed = vi.fn();
  const service = new MocoSearch({ harness, credentials, onChanged: changed, ...options });
  if (options.initialize !== false) {
    await service.initialize();
    if (!options.preservePreset) {
      const preset = (await service.snapshot()).plans.find((plan) => plan.adapter === "exa");
      if (preset) await service.remove(preset.id, preset.revision);
    }
  }
  return { directory, models, harness, credentials, service, close, changed };
}
const tavily = (name = "Tavily one", extra: Partial<SearchPlanInput> = {}): SearchPlanInput => ({ name, adapter: "tavily", apiKey: keyA, ...extra });
function upstream(failure: SearchFailure): Error { return Object.assign(new Error("Untrusted query and credential echo"), { failure }); }
async function seedLegacy(f: Awaited<ReturnType<typeof fixture>>, input: {
  id: string; adapter: "tavily" | "brave" | "duckduckgo" | "native"; baseUrl?: string; apiKey?: string; providerId?: string; modelId?: string; enabled?: boolean;
}) {
  const origin = input.baseUrl ? new URL(input.baseUrl).origin : undefined;
  const credentialRef = input.apiKey ? `search:${input.id}` : undefined;
  if (credentialRef) await f.credentials.modify(credentialRef, async () => ({ type: "api_key", key: input.apiKey, env: { MOCO_API_KEY_ORIGIN: origin! } }));
  await f.harness.commit(async (tx) => {
    const state = await tx.doc(MocoSearchDoc);
    state.plans[input.id] = { id: input.id, name: input.id, adapter: input.adapter, enabled: input.enabled ?? true,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}), ...(credentialRef ? { credentialRef } : {}), ...(origin ? { credentialOrigin: origin } : {}),
      revision: 7, status: "ready", createdAt: 1, updatedAt: 1 };
    state.order.push(input.id); state.revision++; state.legacyImported = true;
  }, BACKGROUND_CONTEXT);
}

describe("ordered search plans", () => {
  it("persists multiple accounts and explicit priority without exposing keys", async () => {
    const f = await fixture();
    const first = await f.service.configure(tavily());
    const second = await f.service.configure(tavily("Tavily two", { apiKey: keyB }));
    const brave = await f.service.configure({ name: "Brave", adapter: "brave", apiKey: "synthetic-brave-key" });
    const snapshot = await f.service.snapshot();
    const ordered = await f.service.reorder([brave.id, second.id, first.id], snapshot.revision);
    expect(ordered.plans.map((plan) => plan.id)).toEqual([brave.id, second.id, first.id]);
    expect(JSON.stringify(ordered)).not.toContain(keyA);
    expect(JSON.stringify(await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT))).not.toContain(keyB);
    await f.close();
    const reopened = await fixture({ directory: f.directory });
    expect(await reopened.service.snapshot()).toEqual(ordered);
    await reopened.service.search({ query: "public test" });
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0]).toMatchObject({ plan: { id: brave.id }, apiKey: "synthetic-brave-key" });
  });

  it("checks item and list revisions and rejects incomplete or duplicate reorder requests", async () => {
    const { service } = await fixture();
    const first = await service.configure(tavily());
    const second = await service.configure(tavily("Second"));
    const snapshot = await service.snapshot();
    await expect(service.reorder([first.id], snapshot.revision)).rejects.toMatchObject({ code: "invalid_search_order" });
    await expect(service.reorder([first.id, first.id], snapshot.revision)).rejects.toMatchObject({ code: "invalid_search_order" });
    await expect(service.reorder([second.id, first.id], snapshot.revision - 1)).rejects.toMatchObject({ status: 409 });
    const edited = await service.configure({ ...tavily("Renamed"), id: first.id, expectedRevision: first.revision });
    await expect(service.configure({ ...tavily(), id: first.id, expectedRevision: first.revision })).rejects.toMatchObject({ status: 409 });
    await expect(service.remove(first.id, first.revision)).rejects.toMatchObject({ status: 409 });
    await service.remove(first.id, edited.revision);
    expect((await service.snapshot()).plans.map((plan) => plan.id)).toEqual([second.id]);
  });

  it("keeps credentials per plan and invalidates them after an origin change", async () => {
    const { service, credentials } = await fixture();
    const first = await service.configure(tavily());
    const sibling = await service.configure(tavily("Sibling", { apiKey: keyB }));
    const changed = await service.configure({ name: first.name, adapter: "tavily", id: first.id, expectedRevision: first.revision, baseUrl: "https://other.example/search" });
    expect(changed).toMatchObject({ hasCredential: false, status: "needs_auth" });
    await service.search({ query: "public test" });
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0]).toMatchObject({ plan: { id: sibling.id }, apiKey: keyB });
    expect(await credentials.list()).toHaveLength(1);
    const replaced = await service.configure({ name: changed.name, adapter: "tavily", id: changed.id, expectedRevision: changed.revision, baseUrl: "https://other.example/search", apiKey: "synthetic-replacement-key" });
    expect(replaced.hasCredential).toBe(true);
    await service.remove(sibling.id, sibling.revision);
    expect(await credentials.list()).toHaveLength(1);
    await service.remove(replaced.id, replaced.revision);
    expect(await credentials.list()).toEqual([]);
  });

  it("validates configuration before storage and excludes model settings from third-party search", async () => {
    const { service } = await fixture();
    for (const baseUrl of ["file:///tmp/test", "https://user:pass@example.com", "https://example.com?q=secret", "not a URL"]) {
      await expect(service.configure(tavily("Invalid", { baseUrl }))).rejects.toMatchObject({ status: 400 });
    }
    await expect(service.configure({ ...tavily(), unexpected: true } as SearchPlanInput)).rejects.toMatchObject({ status: 400 });
    await expect(service.configure({ name: "Native", adapter: "native", providerId: "independent-search-provider", modelId: "search-model", apiKey: keyA } as unknown as SearchPlanInput)).rejects.toMatchObject({ status: 400 });
    expect((await service.snapshot()).plans).toEqual([]);
  });

  it.each([
    ["brave", "https://private-gateway.example"], ["brave", "https://api.search.brave.com/other"],
    ["brave", "http://api.search.brave.com"], ["duckduckgo", "https://private-gateway.example"],
    ["duckduckgo", "https://duckduckgo.com/other"],
  ] as const)("rejects a nonofficial %s identity %s before storing any credential", async (adapter, baseUrl) => {
    const { service, credentials } = await fixture();
    await expect(service.configure({ name: "Invalid fixed identity", adapter, baseUrl, ...(adapter === "brave" ? { apiKey: keyA } : {}) })).rejects.toMatchObject({ status: 400, code: "invalid_search_url" });
    expect((await service.snapshot()).plans).toEqual([]);
    expect(await credentials.list()).toEqual([]);
    expect(runSearchAdapter).not.toHaveBeenCalled();
  });

  it("preserves an unchanged account key on a blank-key edit and keeps health updates outside revisions", async () => {
    const { service, credentials } = await fixture();
    const first = await service.configure(tavily());
    const edited = await service.configure({ name: "Renamed account", adapter: "tavily", id: first.id, expectedRevision: first.revision, apiKey: "" });
    const before = await service.snapshot();
    await service.test(edited.id, edited.revision);
    const after = await service.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.plans[0]).toMatchObject({ revision: edited.revision, status: "ready", hasCredential: true });
    expect(await credentials.list()).toHaveLength(1);
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0].apiKey).toBe(keyA);
  });

  it("presets free Exa once and permits multiple keyless DuckDuckGo plans", async () => {
    const { service } = await fixture({ preservePreset: true });
    const initial = await service.snapshot();
    expect(initial.plans).toHaveLength(1);
    expect(initial.plans[0]).toMatchObject({ name: "Exa", adapter: "exa", baseUrl: "https://mcp.exa.ai/mcp", enabled: true, hasCredential: false, status: "unverified" });
    await service.search({ query: "public question" });
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0].apiKey).toBeUndefined();
    await service.remove(initial.plans[0]!.id, initial.plans[0]!.revision);
    await service.initialize();
    expect((await service.snapshot()).plans).toEqual([]);
    const first = await service.configure({ name: "Duck one", adapter: "duckduckgo" });
    const second = await service.configure({ name: "Duck two", adapter: "duckduckgo" });
    expect((await service.snapshot()).plans.map((plan) => plan.id)).toEqual([first.id, second.id]);
    await service.search({ query: "public question" });
    expect(vi.mocked(runSearchAdapter).mock.calls.at(-1)![0].plan).toMatchObject({ adapter: "duckduckgo", baseUrl: "https://duckduckgo.com" });
    await expect(service.configure({ name: "Duck with key", adapter: "duckduckgo", apiKey: keyA })).rejects.toMatchObject({ status: 400 });
  });

  it("migrates a legacy Tavily key once and does not restore a deleted plan", async () => {
    vi.stubEnv("MOCO_SEARCH_API_KEY", "tvly-synthetic-migration-key");
    const f = await fixture();
    const plan = (await f.service.snapshot()).plans[0]!;
    expect(plan).toMatchObject({ adapter: "tavily", hasCredential: true });
    expect(JSON.stringify(await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT))).not.toContain("tvly-synthetic-migration-key");
    await f.service.remove(plan.id, plan.revision);
    await f.service.initialize();
    expect((await f.service.snapshot()).plans).toEqual([]);
  });
});

describe("search execution and fallback", () => {
  it("tries enabled plans in order, records failures, and redacts literal API keys", async () => {
    const { service } = await fixture();
    await service.configure(tavily("Disabled", { enabled: false }));
    const first = await service.configure(tavily("First"));
    const second = await service.configure(tavily("Second", { apiKey: keyB }));
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(new Error(`rejected credential ${keyA}`)).mockResolvedValueOnce({ sources: [source] });
    const result = await service.search({ query: "public question", includeDomains: ["example.com"], timeRange: "week" });
    expect(result.planId).toBe(second.id);
    expect(result.attempts.map((attempt) => attempt.planId)).toEqual([first.id, second.id]);
    expect(JSON.stringify(result)).not.toContain(keyA);
    const snapshot = await service.snapshot();
    expect(snapshot.plans.find((plan) => plan.id === first.id)?.status).toBe("error");
    expect(snapshot.plans.find((plan) => plan.id === second.id)?.status).toBe("ready");
    expect(snapshot.plans.find((plan) => plan.id === second.id)?.revision).toBe(second.revision);
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0].input).toMatchObject({ query: "public question", includeDomains: ["example.com"], timeRange: "week" });
  });

  it("treats a missing credential and ungrounded answer as failures before falling through", async () => {
    const { service } = await fixture();
    await service.configure({ name: "No key", adapter: "brave" });
    await service.configure(tavily("Empty"));
    const third = await service.configure(tavily("Working"));
    vi.mocked(runSearchAdapter).mockResolvedValueOnce({ answer: "Unverified answer", sources: [] }).mockResolvedValueOnce({ sources: [source] });
    const result = await service.search({ query: "public question" });
    expect(result.planId).toBe(third.id);
    expect(result.attempts).toHaveLength(3);
    expect(runSearchAdapter).toHaveBeenCalledTimes(2);
  });

  it("tests only the requested plan and does not conceal its failure with another", async () => {
    const { service } = await fixture();
    const first = await service.configure(tavily());
    await service.configure(tavily("Backup"));
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(new Error("Upstream unavailable"));
    await expect(service.test(first.id, first.revision)).rejects.toMatchObject({ code: "search_plan_failed" });
    expect(runSearchAdapter).toHaveBeenCalledTimes(1);
  });

  it("returns actionable failures for an empty catalog or entirely failed plans", async () => {
    const { service } = await fixture();
    await expect(service.search({ query: "public" })).rejects.toMatchObject({ code: "search_not_configured" });
    await service.configure(tavily());
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(new Error("Quota exceeded"));
    await expect(service.search({ query: "public" })).rejects.toMatchObject({ code: "search_all_failed" });
  });

  it("never starts another provider after caller cancellation, even if the adapter ignores it", async () => {
    const { service } = await fixture();
    await service.configure(tavily()); await service.configure(tavily("Backup"));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(runSearchAdapter).mockImplementationOnce(async () => { started(); return new Promise(() => {}); });
    const controller = new AbortController();
    const pending = service.search({ query: "public" }, controller.signal);
    await ready; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runSearchAdapter).toHaveBeenCalledTimes(1);
    expect((await service.snapshot()).plans[0]!.lastCheckedAt).toBeUndefined();
  });

  it("bounds each attempt and then uses the next configured provider", async () => {
    const { service } = await fixture({ attemptTimeoutMs: 15, timeoutMs: 1000 });
    await service.configure(tavily()); const backup = await service.configure(tavily("Backup"));
    vi.mocked(runSearchAdapter).mockImplementationOnce(async () => new Promise(() => {}));
    const result = await service.search({ query: "public" });
    expect(result.planId).toBe(backup.id);
    expect(result.attempts[0]?.failure?.kind).toBe("timeout");
  });

  it("does not validate a new configuration with an older in-flight response", async () => {
    const { service } = await fixture();
    const plan = await service.configure(tavily());
    let finish!: (value: { sources: typeof source[] }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(runSearchAdapter).mockImplementationOnce(async () => { started(); return new Promise((resolve) => { finish = resolve; }); });
    const pending = service.search({ query: "public" });
    await ready;
    const replacement = await service.configure(tavily("Replacement", { id: plan.id, expectedRevision: plan.revision, apiKey: keyB }));
    finish({ sources: [source] }); await pending;
    expect((await service.snapshot()).plans[0]).toMatchObject({ id: plan.id, revision: replacement.revision, status: "unverified" });
    expect((await service.snapshot()).plans[0]!.lastCheckedAt).toBeUndefined();
  });

  it("validates tool input without contacting any provider", async () => {
    const { service } = await fixture();
    for (const raw of [{ query: " " }, { query: "valid", maxResults: 0 }, { query: "valid", includeDomains: ["https://example.com"] }, { query: "valid", timeRange: "decade" }]) {
      await expect(service.search(raw as WebSearchInput)).rejects.toMatchObject({ status: 400 });
    }
    expect(runSearchAdapter).not.toHaveBeenCalled();
  });

  it("uses ordered enabled Tavily credentials for full-page extraction and retries another account", async () => {
    const { service } = await fixture();
    await service.configure(tavily("Disabled", { enabled: false }));
    await service.configure(tavily("One")); await service.configure(tavily("Two", { apiKey: keyB }));
    vi.mocked(fetchSearchPageAdapter).mockRejectedValueOnce(new Error(`Quota reached for ${keyA}`)).mockResolvedValueOnce({ url: source.url, title: source.title, content: "Full article", truncated: false, sources: [source] });
    const page = await service.fetch(source.url);
    expect(page.content).toBe("Full article");
    expect(vi.mocked(fetchSearchPageAdapter).mock.calls.map(([request]) => request.apiKey)).toEqual([keyA, keyB]);
  });

  it("keeps healthy zero-result searches ready and still tries a later provider", async () => {
    const { service } = await fixture();
    const first = await service.configure(tavily());
    const second = await service.configure(tavily("Backup"));
    vi.mocked(runSearchAdapter).mockResolvedValueOnce({ sources: [] });
    const result = await service.search({ query: "Rare public query" });
    expect(result.planId).toBe(second.id);
    expect(result.attempts[0]).toMatchObject({ planId: first.id, failure: { kind: "no_results" } });
    expect((await service.snapshot()).plans[0]).toMatchObject({ status: "ready" });
    expect((await service.snapshot()).plans[0]!.error).toBeUndefined();
  });

  it("returns genuine zero results rather than a connection failure when the backup also fails", async () => {
    const { service } = await fixture();
    const first = await service.configure(tavily());
    await service.configure(tavily("Backup"));
    vi.mocked(runSearchAdapter).mockResolvedValueOnce({ sources: [] }).mockRejectedValueOnce(upstream({ kind: "network", message: "untrusted", retryable: true }));
    const result = await service.search({ query: "Rare public query" });
    expect(result).toMatchObject({ planId: first.id, sources: [], attempts: [{ failure: { kind: "no_results" } }, { failure: { kind: "network" } }] });
  });

  it("accepts an empty result in a specified-plan test without trying another account", async () => {
    const { service } = await fixture();
    const plan = await service.configure(tavily()); await service.configure(tavily("Backup"));
    vi.mocked(runSearchAdapter).mockResolvedValueOnce({ sources: [] });
    expect(await service.test(plan.id, plan.revision)).toMatchObject({ sources: [], attempts: [{ failure: { kind: "no_results" } }] });
    expect(runSearchAdapter).toHaveBeenCalledTimes(1);
    expect((await service.snapshot()).plans[0]!.status).toBe("ready");
  });

  it.each([
    ["auth", 401, "invalid_api_key", false], ["quota", 429, "insufficient_quota", false],
    ["rate_limit", 429, "rate_limit_exceeded", true], ["invalid_request", 400, "invalid_parameter", false],
    ["unsupported_tool", 400, "unsupported_tool", false], ["upstream", 503, "service_unavailable", true],
  ] as const)("preserves structured %s failures without treating upstream authentication as Hub authentication", async (kind, status, code, retryable) => {
    const { service } = await fixture();
    const plan = await service.configure(tavily());
    const raw: SearchFailure = { kind, message: `Raw query echo and ${keyA}`, upstreamStatus: status, upstreamCode: code, parameter: "tools", requestId: "req_public123", retryable };
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(upstream(raw));
    const error = await service.test(plan.id, plan.revision).catch((value) => value);
    expect(error).toMatchObject({ status: 502, failure: { kind, upstreamStatus: status, upstreamCode: code, parameter: "tools", requestId: "req_public123", retryable }, attempts: [{ planId: plan.id, failure: { kind } }] });
    expect(JSON.stringify(error)).not.toContain(keyA);
    expect(JSON.stringify(await service.snapshot())).not.toContain("Raw query echo");
    expect((await service.snapshot()).plans[0]!.failure).toMatchObject({ kind, upstreamStatus: status });
    if (kind === "auth") expect((await service.snapshot()).plans[0]!.status).toBe("needs_auth");
  });

  it("removes credential-bearing diagnostic fields and persists only local error wording", async () => {
    const { service, harness } = await fixture();
    const plan = await service.configure(tavily());
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(upstream({ kind: "rate_limit", message: `${keyA} private query`, upstreamStatus: 429, upstreamCode: keyA, parameter: keyA, requestId: keyA, retryable: true }));
    const error = await service.test(plan.id, plan.revision).catch((value) => value);
    expect(error.failure).toMatchObject({ kind: "rate_limit", upstreamStatus: 429 });
    expect(error.failure.upstreamCode).toBeUndefined(); expect(error.failure.requestId).toBeUndefined(); expect(error.failure.parameter).toBeUndefined();
    const serialized = JSON.stringify([error, await service.snapshot(), await harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT)]);
    expect(serialized).not.toContain(keyA); expect(serialized).not.toContain("private query");
  });

  it("retains the ordered structured failure chain when every provider fails", async () => {
    const { service } = await fixture();
    const first = await service.configure(tavily()); const second = await service.configure(tavily("Second"));
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(upstream({ kind: "auth", message: "discard", upstreamStatus: 401, retryable: false }))
      .mockRejectedValueOnce(upstream({ kind: "rate_limit", message: "discard", upstreamStatus: 429, requestId: "req_limit", retryable: true }));
    await expect(service.search({ query: "public query" })).rejects.toMatchObject({ status: 502, code: "search_all_failed", failure: { kind: "rate_limit", upstreamStatus: 429 },
      attempts: [{ planId: first.id, failure: { kind: "auth", upstreamStatus: 401 } }, { planId: second.id, failure: { kind: "rate_limit", requestId: "req_limit" } }] });
  });

  it("does not invent an upstream HTTP status for a locally missing credential", async () => {
    const { service } = await fixture();
    const plan = await service.configure({ name: "No account key", adapter: "tavily" });
    const error = await service.test(plan.id, plan.revision).catch((value) => value);
    expect(error).toMatchObject({ status: 409, failure: { kind: "auth" } });
    expect(error.failure.upstreamStatus).toBeUndefined();
    expect(runSearchAdapter).not.toHaveBeenCalled();
  });

  it("keeps a newer successful test healthy when an older request fails later", async () => {
    const { service } = await fixture();
    const plan = await service.configure(tavily());
    let started!: () => void; let rejectOld!: (error: unknown) => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(runSearchAdapter).mockImplementationOnce(async () => { started(); return new Promise((_resolve, reject) => { rejectOld = reject; }); });
    const oldRequest = service.test(plan.id, plan.revision).catch((error) => error);
    await ready;
    await service.test(plan.id, plan.revision);
    const healthy = await service.snapshot();
    rejectOld(upstream({ kind: "network", message: "older failure", retryable: true })); await oldRequest;
    expect(await service.snapshot()).toEqual(healthy);
    expect(healthy.plans[0]).toMatchObject({ status: "ready", revision: plan.revision });
  });

  it("increments independent health revisions on recovery while preserving configuration CAS", async () => {
    const { service } = await fixture();
    const plan = await service.configure(tavily());
    vi.mocked(runSearchAdapter).mockRejectedValueOnce(upstream({ kind: "network", message: "private", retryable: true }));
    await expect(service.test(plan.id, plan.revision)).rejects.toMatchObject({ failure: { kind: "network" } });
    const failed = await service.snapshot();
    await service.test(plan.id, plan.revision);
    const recovered = await service.snapshot();
    expect(recovered.revision).toBe(failed.revision);
    expect(recovered.healthRevision!).toBeGreaterThan(failed.healthRevision!);
    expect(recovered.plans[0]!.healthRevision!).toBeGreaterThan(failed.plans[0]!.healthRevision!);
    expect(recovered.plans[0]).toMatchObject({ status: "ready", revision: plan.revision });
    expect(recovered.plans[0]!.failure).toBeUndefined();
  });

  it("reports an overall timeout with a structured chain and never starts the backup", async () => {
    const { service } = await fixture({ attemptTimeoutMs: 2000, timeoutMs: 15 });
    await service.configure(tavily()); await service.configure(tavily("Backup"));
    vi.mocked(runSearchAdapter).mockImplementationOnce(async () => new Promise(() => {}));
    await expect(service.search({ query: "public query" })).rejects.toMatchObject({ status: 504, failure: { kind: "timeout" }, attempts: [{ failure: { kind: "timeout" } }] });
    expect(runSearchAdapter).toHaveBeenCalledTimes(1);
  });

  it("falls back to public page reading when MCP fetch is unavailable", async () => {
    const { service } = await fixture({ preservePreset: true });
    const page = await service.fetch(source.url);
    expect(page.content).toBe("Full article");
    expect(fetchSearchPageAdapter).toHaveBeenCalledTimes(1);
    expect(fetchWebPage).toHaveBeenCalledWith(expect.objectContaining({ url: source.url }));
    expect(vi.mocked(fetchWebPage).mock.calls[0]![0].tavily).toBeUndefined();
  });

  it("never passes the service MCP transport into the secure public page reader", async () => {
    const serviceTransport = vi.fn() as unknown as typeof fetch;
    const { service } = await fixture({ preservePreset: true, fetch: serviceTransport });
    await service.search({ query: "public question" });
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0].fetch).toBe(serviceTransport);
    await service.fetch(source.url);
    expect(vi.mocked(fetchSearchPageAdapter).mock.calls[0]![0].fetch).toBe(serviceTransport);
    expect(vi.mocked(fetchWebPage).mock.calls[0]![0].fetch).toBeUndefined();
  });

  it("accepts an explicitly separate trusted page transport only for page-reader tests", async () => {
    const serviceTransport = vi.fn() as unknown as typeof fetch;
    const pageTransport = vi.fn() as unknown as typeof fetch;
    const { service } = await fixture({ preservePreset: true, fetch: serviceTransport, pageFetch: pageTransport });
    await service.fetch(source.url);
    expect(vi.mocked(fetchSearchPageAdapter).mock.calls[0]![0].fetch).toBe(serviceTransport);
    expect(vi.mocked(fetchWebPage).mock.calls[0]![0].fetch).toBe(pageTransport);
  });
});

describe("search transport migrations", () => {
  it("moves Tavily metadata to MCP while keeping its saved key bound to the old origin until explicit replacement", async () => {
    const f = await fixture({ initialize: false });
    await seedLegacy(f, { id: "old-tavily", adapter: "tavily", baseUrl: "https://api.tavily.com", apiKey: keyA });
    await seedLegacy(f, { id: "old-brave", adapter: "brave", baseUrl: "https://api.search.brave.com", apiKey: keyB });
    await f.service.initialize();
    const snapshot = await f.service.snapshot();
    expect(snapshot.plans.map((plan) => plan.id).slice(0, 2)).toEqual(["old-tavily", "old-brave"]);
    expect(snapshot.plans[0]).toMatchObject({ baseUrl: "https://mcp.tavily.com/mcp", hasCredential: false, revision: 8, status: "needs_auth", error: "服务已切换为 MCP，请重新填写 API Key。" });
    expect(snapshot.plans[1]).toMatchObject({ baseUrl: "https://api.search.brave.com", hasCredential: true, revision: 8 });
    const stored = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    const credential = await f.credentials.read(stored!.plans["old-tavily"]!.credentialRef!);
    expect(credential).toMatchObject({ type: "api_key", key: keyA, env: { MOCO_API_KEY_ORIGIN: "https://api.tavily.com" } });
    expect(stored!.plans["old-tavily"]!.credentialRef).toBe("search:old-tavily");
    expect(stored!.plans["old-tavily"]!.credentialOrigin).toBe("https://api.tavily.com");
    await expect(f.service.test("old-tavily", 8)).rejects.toMatchObject({ status: 409, failure: { kind: "auth" } });
    expect(runSearchAdapter).not.toHaveBeenCalled();
    await f.service.fetch(source.url);
    expect(vi.mocked(fetchSearchPageAdapter).mock.calls.map(([request]) => request.plan.id)).not.toContain("old-tavily");
    expect(vi.mocked(fetchSearchPageAdapter).mock.calls.some(([request]) => request.apiKey === keyA)).toBe(false);
    const unchanged = await f.service.configure({ id: "old-tavily", expectedRevision: 8, name: "Still awaiting confirmation", adapter: "tavily", baseUrl: "https://mcp.tavily.com/mcp", apiKey: "" });
    expect(unchanged.hasCredential).toBe(false);
    expect(await f.credentials.read("search:old-tavily")).toMatchObject({ key: keyA, env: { MOCO_API_KEY_ORIGIN: "https://api.tavily.com" } });
    const replacement = await f.service.configure({ id: "old-tavily", expectedRevision: unchanged.revision, name: "Confirmed MCP account", adapter: "tavily", baseUrl: "https://mcp.tavily.com/mcp", apiKey: keyB });
    expect(replacement.hasCredential).toBe(true);
    expect(await f.credentials.read("search:old-tavily")).toBeUndefined();
    const replaced = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(await f.credentials.read(replaced!.plans["old-tavily"]!.credentialRef!)).toMatchObject({ key: keyB, env: { MOCO_API_KEY_ORIGIN: "https://mcp.tavily.com" } });
    await f.service.test("old-tavily", replacement.revision);
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0]).toMatchObject({ apiKey: keyB, plan: { baseUrl: "https://mcp.tavily.com/mcp" } });
    const before = await f.service.snapshot(); await f.service.initialize(); expect(await f.service.snapshot()).toEqual(before);
  });

  it.each(["https://custom.example/api", "https://api.tavily.com.evil.example", "https://api.tavily.com/v1"])("does not silently forward a legacy custom connection key from %s", async (baseUrl) => {
    const f = await fixture({ initialize: false });
    await seedLegacy(f, { id: "old-custom", adapter: "tavily", baseUrl, apiKey: keyA });
    await f.service.initialize();
    expect((await f.service.snapshot()).plans[0]).toMatchObject({ id: "old-custom", baseUrl, hasCredential: false, status: "needs_auth" });
    await expect(f.service.test("old-custom", 8)).rejects.toMatchObject({ status: 409, failure: { kind: "auth" } });
    expect(runSearchAdapter).not.toHaveBeenCalled();
    expect(await f.credentials.read("search:old-custom")).toMatchObject({ key: keyA, env: { MOCO_API_KEY_ORIGIN: new URL(baseUrl).origin } });
    const state = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(state!.plans["old-custom"]!.credentialRef).toBe("search:old-custom");
    expect(state!.plans["old-custom"]!.credentialOrigin).toBe(new URL(baseUrl).origin);
  });

  it.each([undefined, 1])("blocks old custom Brave identities even when their transport version is %s", async (transportVersion) => {
    const f = await fixture({ initialize: false });
    await seedLegacy(f, { id: "old-custom-brave", adapter: "brave", baseUrl: "https://private-gateway.example", apiKey: keyA });
    if (transportVersion !== undefined) await f.harness.commit(async (tx) => { (await tx.doc(MocoSearchDoc)).plans["old-custom-brave"]!.transportVersion = transportVersion; }, BACKGROUND_CONTEXT);
    await f.service.initialize();
    const plan = (await f.service.snapshot()).plans.find((item) => item.id === "old-custom-brave")!;
    expect(plan).toMatchObject({ hasCredential: false, status: "needs_auth" });
    await expect(f.service.test(plan.id, plan.revision)).rejects.toMatchObject({ status: 409, failure: { kind: "auth" } });
    expect(runSearchAdapter).not.toHaveBeenCalled();
    expect(await f.credentials.read("search:old-custom-brave")).toMatchObject({ key: keyA, env: { MOCO_API_KEY_ORIGIN: "https://private-gateway.example" } });
    const noNewKey = await f.service.configure({ id: plan.id, expectedRevision: plan.revision, name: plan.name, adapter: "brave", baseUrl: "https://api.search.brave.com", apiKey: "" });
    expect(noNewKey).toMatchObject({ hasCredential: false, status: "needs_auth" });
    expect(await f.credentials.read("search:old-custom-brave")).toMatchObject({ key: keyA });
    const repaired = await f.service.configure({ id: plan.id, expectedRevision: noNewKey.revision, name: plan.name, adapter: "brave", baseUrl: "https://api.search.brave.com", apiKey: keyB });
    expect(repaired).toMatchObject({ hasCredential: true, status: "unverified", baseUrl: "https://api.search.brave.com" });
    expect(await f.credentials.read("search:old-custom-brave")).toBeUndefined();
    await f.service.test(plan.id, repaired.revision);
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0]).toMatchObject({ apiKey: keyB, plan: { baseUrl: "https://api.search.brave.com" } });
  });

  it("does not execute an old custom DuckDuckGo identity until an explicit save restores its fixed address", async () => {
    const f = await fixture({ initialize: false });
    await seedLegacy(f, { id: "old-custom-duck", adapter: "duckduckgo", baseUrl: "https://private-gateway.example" });
    await f.harness.commit(async (tx) => { (await tx.doc(MocoSearchDoc)).plans["old-custom-duck"]!.transportVersion = 1; }, BACKGROUND_CONTEXT);
    await f.service.initialize();
    const plan = (await f.service.snapshot()).plans.find((item) => item.id === "old-custom-duck")!;
    expect(plan).toMatchObject({ status: "needs_auth" });
    await expect(f.service.test(plan.id, plan.revision)).rejects.toMatchObject({ status: 409 });
    expect(runSearchAdapter).not.toHaveBeenCalled();
    const repaired = await f.service.configure({ id: plan.id, expectedRevision: plan.revision, name: plan.name, adapter: "duckduckgo" });
    await f.service.test(plan.id, repaired.revision);
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0]).toMatchObject({ apiKey: undefined, plan: { baseUrl: "https://duckduckgo.com" } });
  });

  it("moves old native plans through the model-settings callback before removing them", async () => {
    const migrate = vi.fn(async () => {});
    const f = await fixture({ initialize: false, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "old-native", adapter: "native", providerId: "google", modelId: "gemini-search-model", enabled: true });
    await f.service.initialize();
    expect(migrate).toHaveBeenCalledWith({ providerId: "google", modelId: "gemini-search-model", enabled: true });
    expect((await f.service.snapshot()).plans.map((plan) => plan.adapter)).toEqual(["exa"]);
    expect((await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT))!.nativeMigrations).toMatchObject({ "old-native": true });
    await f.service.initialize(); expect(migrate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("aggregates duplicate native model enablement independent of first-plan enabled=%s", async (firstEnabled) => {
    let modelSetting: boolean | undefined;
    const migrate = vi.fn(async (plan: { enabled: boolean }) => { if (modelSetting === undefined) modelSetting = plan.enabled; return true; });
    const f = await fixture({ initialize: false, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "old-first", adapter: "native", providerId: "google", modelId: "same-search-model", enabled: firstEnabled });
    await seedLegacy(f, { id: "old-second", adapter: "native", providerId: "google", modelId: "same-search-model", enabled: !firstEnabled });
    await f.service.initialize();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith({ providerId: "google", modelId: "same-search-model", enabled: true });
    expect(modelSetting).toBe(true);
    const state = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(state!.plans["old-first"]).toBeUndefined(); expect(state!.plans["old-second"]).toBeUndefined();
    expect(state!.nativeMigrations).toMatchObject({ "old-first": true, "old-second": true });
  });

  it("does not require the migration callback to overwrite a preexisting explicit false model setting", async () => {
    let modelSetting: boolean | undefined = false;
    const migrate = vi.fn(async (plan: { enabled: boolean }) => { if (modelSetting === undefined) modelSetting = plan.enabled; return true; });
    const f = await fixture({ initialize: false, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "disabled-first", adapter: "native", providerId: "google", modelId: "same-search-model", enabled: false });
    await seedLegacy(f, { id: "enabled-second", adapter: "native", providerId: "google", modelId: "same-search-model", enabled: true });
    await f.service.initialize();
    expect(migrate).toHaveBeenCalledWith({ providerId: "google", modelId: "same-search-model", enabled: true });
    expect(modelSetting).toBe(false);
    expect((await f.service.snapshot()).plans.map((plan) => plan.adapter)).toEqual(["exa"]);
  });

  it("retries duplicate pending native plans as one group and removes all only after success", async () => {
    let available = false;
    const migrate = vi.fn(async () => available);
    const f = await fixture({ initialize: false, preservePreset: true, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "pending-disabled", adapter: "native", providerId: "google", modelId: "same-search-model", enabled: false });
    await seedLegacy(f, { id: "pending-enabled", adapter: "native", providerId: "google", modelId: "same-search-model", enabled: true });
    await f.service.initialize();
    expect(migrate).toHaveBeenCalledTimes(1);
    const pending = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(pending!.pendingNativeMigrations).toEqual(["pending-disabled", "pending-enabled"]);
    expect(pending!.plans["pending-disabled"]).toMatchObject({ enabled: false });
    expect(pending!.plans["pending-enabled"]).toMatchObject({ enabled: true });
    await f.close(); available = true;
    const reopened = await fixture({ directory: f.directory, preservePreset: true, migrateNativePlan: migrate });
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenLastCalledWith({ providerId: "google", modelId: "same-search-model", enabled: true });
    const migrated = await reopened.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(migrated!.pendingNativeMigrations).toEqual([]);
    expect(migrated!.plans["pending-disabled"]).toBeUndefined(); expect(migrated!.plans["pending-enabled"]).toBeUndefined();
  });

  it("preserves old native settings until a failed model migration succeeds", async () => {
    const migrate = vi.fn().mockRejectedValueOnce(new Error("synthetic migration blocked")).mockResolvedValue(undefined);
    const f = await fixture({ initialize: false, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "old-native", adapter: "native", providerId: "anthropic", modelId: "claude-search", enabled: false });
    await expect(f.service.initialize()).rejects.toThrow("synthetic migration blocked");
    expect((await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT))!.plans["old-native"]).toMatchObject({ adapter: "native", enabled: false });
    await f.service.initialize();
    expect(migrate).toHaveBeenCalledWith({ providerId: "anthropic", modelId: "claude-search", enabled: false });
    expect((await f.service.snapshot()).plans.map((plan) => plan.adapter)).toEqual(["exa"]);
  });

  it("refuses to discard a native plan when no model-settings migration callback is available", async () => {
    const f = await fixture({ initialize: false });
    await seedLegacy(f, { id: "old-native", adapter: "native", providerId: "google", modelId: "gemini-search" });
    await expect(f.service.initialize()).rejects.toMatchObject({ code: "search_native_migration_required" });
    expect((await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT))!.plans["old-native"]).toMatchObject({ adapter: "native" });
  });

  it("keeps an unavailable native model pending across restarts and migrates it when the catalog recovers", async () => {
    let catalogAvailable = false;
    const migrate = vi.fn(async () => catalogAvailable);
    const f = await fixture({ initialize: false, preservePreset: true, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "temporarily-missing-native", adapter: "native", providerId: "temporarily-missing-provider", modelId: "search-model", enabled: false });
    await f.service.initialize();
    const first = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(first!.plans["temporarily-missing-native"]).toMatchObject({ providerId: "temporarily-missing-provider", modelId: "search-model", enabled: false });
    expect(first!.pendingNativeMigrations).toEqual(["temporarily-missing-native"]);
    expect(first!.order).not.toContain("temporarily-missing-native");
    expect((await f.service.snapshot()).plans.map((plan) => plan.adapter)).toEqual(["exa"]);
    await f.service.search({ query: "public question" });
    expect(vi.mocked(runSearchAdapter).mock.calls[0]![0].plan.adapter).toBe("exa");
    await f.close();

    const reopened = await fixture({ directory: f.directory, preservePreset: true, migrateNativePlan: migrate });
    const second = await reopened.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(second!.plans["temporarily-missing-native"]).toMatchObject({ adapter: "native", enabled: false });
    expect(second!.pendingNativeMigrations).toEqual(["temporarily-missing-native"]);
    expect(second!.revision).toBe(first!.revision);
    expect(migrate).toHaveBeenCalledTimes(2);
    await reopened.close();

    catalogAvailable = true;
    const recovered = await fixture({ directory: f.directory, preservePreset: true, migrateNativePlan: migrate });
    const final = await recovered.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(final!.plans["temporarily-missing-native"]).toBeUndefined();
    expect(final!.pendingNativeMigrations).toEqual([]);
    expect(final!.nativeMigrations).toMatchObject({ "temporarily-missing-native": true });
    expect(migrate).toHaveBeenLastCalledWith({ providerId: "temporarily-missing-provider", modelId: "search-model", enabled: false });
    await recovered.service.initialize();
    expect(migrate).toHaveBeenCalledTimes(3);
  });

  it("retains a pending native plan when its retry encounters a storage failure", async () => {
    const migrate = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("synthetic settings storage failure"));
    const f = await fixture({ initialize: false, migrateNativePlan: migrate });
    await seedLegacy(f, { id: "pending-native", adapter: "native", providerId: "google", modelId: "temporarily-missing-search-model" });
    await f.service.initialize();
    await expect(f.service.initialize()).rejects.toThrow("synthetic settings storage failure");
    const state = await f.harness.snapshot(MocoSearchDoc, BACKGROUND_CONTEXT);
    expect(state!.plans["pending-native"]).toMatchObject({ adapter: "native", enabled: true });
    expect(state!.pendingNativeMigrations).toEqual(["pending-native"]);
    expect(state!.order).not.toContain("pending-native");
  });

  it("does not recreate a deliberately removed Exa preset after a restart", async () => {
    const f = await fixture({ preservePreset: true });
    const plan = (await f.service.snapshot()).plans[0]!;
    await f.service.remove(plan.id, plan.revision); await f.close();
    const reopened = await fixture({ directory: f.directory, preservePreset: true });
    expect((await reopened.service.snapshot()).plans).toEqual([]);
  });
});
