import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startMocoHubServer } from "@moco/hub";
import type { CustomProviderConfig, SearchPlanInput, SearchPlanView, SearchSnapshot } from "@moco/protocol";
import { MocoSearchDoc } from "../packages/hub/src/search.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const { runSearch } = vi.hoisted(() => ({ runSearch: vi.fn() }));
vi.mock("../packages/hub/src/search-adapters.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../packages/hub/src/search-adapters.js")>(),
  runSearchAdapter: runSearch,
}));

const NODE_TOKEN = "search-http-worker-token";
const FIRST_KEY = "tvly-search-http-primary-test-value";
const SECOND_KEY = "tvly-search-http-secondary-test-value";
const cleanup: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const name of ["MOCO_SEARCH_API_KEY", "MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY", "MOCO_HINDSIGHT_ROUTER_API_KEY", "MOCO_HINDSIGHT_WORKER_API_KEY", "MOCO_HINDSIGHT_SHARED_READ_API_KEY"]) vi.stubEnv(name, "");
  runSearch.mockReset().mockResolvedValue({ sources: [{ id: "docs", title: "API documentation", url: "https://developers.openai.com/api/docs/", snippet: "Official API documentation." }] });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(existingDirectory?: string, options: { keepPreset?: boolean; customProviders?: CustomProviderConfig[] } = {}) {
  const stateDir = existingDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-search-http-"));
  if (!existingDirectory) cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "main-model" }, { id: "search-model" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, envTokens: { node: NODE_TOKEN }, stateDir,
    identityDir: path.join(stateDir, "identity"), workerEnvIds: ["node"], enableLocalEnv: false,
    memory: { enabled: false }, model: { defaultProvider: "openai", defaultModel: "main-model", apiKey: "", ...(options.customProviders ? { customProviders: options.customProviders } : {}) },
  } });
  if (!existingDirectory && !options.keepPreset) {
    for (const preset of (await hub.search.snapshot()).plans) await hub.search.remove(preset.id, preset.revision);
  }
  let closed = false;
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  const close = async () => { if (!closed) { closed = true; await server.close(); await hub.close(); } };
  cleanup.push(close);
  const request = async (route: string, method = "GET", body?: unknown, token: string | null = HUB_TEST_ADMIN_TOKEN) => {
    const response = await fetch(`${server.url}${route}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const add = async (input: SearchPlanInput) => {
    const result = await request("/api/search/plans", "POST", input);
    expect(result.status).toBe(200);
    return result.value as SearchSnapshot;
  };
  return { hub, stateDir, request, add, close, provider };
}

function edit(plan: SearchPlanView, changes: Partial<SearchPlanInput> = {}): SearchPlanInput {
  return { id: plan.id, expectedRevision: plan.revision, name: plan.name, adapter: plan.adapter,
    enabled: plan.enabled, ...(plan.baseUrl ? { baseUrl: plan.baseUrl } : {}), ...changes };
}

describe("search management HTTP", () => {
  it("seeds one keyless Exa plan once and preserves the user's deletion across restarts", async () => {
    const f = await fixture(undefined, { keepPreset: true });
    const initial = await f.request("/api/search");
    expect(initial.value.plans).toHaveLength(1);
    const preset = initial.value.plans[0] as SearchPlanView;
    expect(preset).toMatchObject({ adapter: "exa", enabled: true, baseUrl: "https://mcp.exa.ai/mcp" });
    expect(runSearch).not.toHaveBeenCalled();
    const tested = await f.request(`/api/search/plans/${preset.id}/test`, "POST", { expectedRevision: preset.revision });
    expect(tested.status).toBe(200);
    expect(runSearch.mock.calls[0]![0]).toMatchObject({ plan: { adapter: "exa" }, apiKey: undefined });
    const removed = await f.request(`/api/search/plans/${preset.id}?expectedRevision=${preset.revision}`, "DELETE");
    expect(removed.status).toBe(200); expect(removed.value.plans).toEqual([]);
    await f.close();
    const reopened = await fixture(f.stateDir, { keepPreset: true });
    expect((await reopened.request("/api/search")).value.plans).toEqual([]);
    await reopened.hub.search.initialize();
    expect((await reopened.request("/api/search")).value.plans).toEqual([]);
  });

  it("migrates persisted native search plans into model tools without overriding an explicit model preference", async () => {
    const customProviders: CustomProviderConfig[] = [{ id: "api-search-legacy", name: "Search provider", api: "openai-responses", baseUrl: "https://api.example.com/v1",
      models: [{ id: "legacy-enabled" }, { id: "explicitly-disabled", nativeTools: { webSearch: false } }] }];
    const f = await fixture(undefined, { customProviders });
    await f.hub.harness.commit(async (tx) => {
      const doc = await tx.doc(MocoSearchDoc);
      for (const modelId of ["legacy-enabled", "explicitly-disabled"]) {
        const id = `old-${modelId}`;
        doc.plans[id] = { id, name: modelId, adapter: "native", providerId: "api-search-legacy", modelId,
          enabled: true, revision: 1, status: "unverified", createdAt: 1, updatedAt: 1 };
        doc.order.push(id);
      }
      doc.revision++;
    }, BACKGROUND_CONTEXT);
    await f.close();
    const reopened = await fixture(f.stateDir, { customProviders });
    const model = reopened.hub.getSettingsView().blocks.model.value;
    const models = model.customProviders!.find((provider) => provider.id === "api-search-legacy")!.models;
    expect(models.find((item) => item.id === "legacy-enabled")?.nativeTools).toEqual({ webSearch: true });
    expect(models.find((item) => item.id === "explicitly-disabled")?.nativeTools).toEqual({ webSearch: false });
    expect(model.defaultModel).toBe("main-model");
    expect((await reopened.request("/api/search")).value.plans.every((plan: SearchPlanView) => plan.adapter !== ("native" as string))).toBe(true);
    await reopened.close();
    const again = await fixture(f.stateDir, { customProviders });
    expect(again.hub.getSettingsView().blocks.model.value.customProviders!.find((provider) => provider.id === "api-search-legacy")!.models).toEqual(models);
  });

  it("runs Hub search without a Worker Env and retains cited sources in the conversation after restart", async () => {
    const f = await fixture();
    const saved = await f.add({ name: "Hub search", adapter: "tavily", apiKey: FIRST_KEY });
    const source = { id: "docs", title: "API documentation", url: "https://developers.openai.com/api/docs/", snippet: "Official API documentation." };
    const answer = "参见 [API documentation](https://developers.openai.com/api/docs/)。";
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("web_search", { query: "official API documentation" })], { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "web_search");
        expect(result).toMatchObject({ isError: false });
        expect(JSON.stringify(result)).toContain(source.url);
        return fauxAssistantMessage([fauxText(answer)]);
      },
    ]);
    const submission = await f.hub.sendUserMessage("搜索官方 API 文档并引用来源");
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    await vi.waitFor(async () => {
      const view = await f.hub.getTopicView("root");
      expect(view.live.busy).toBe(false);
      expect(view.messages.find((message) => message.text === answer)).toMatchObject({ role: "assistant", sources: [source] });
    }, { timeout: 5000, interval: 20 });
    expect(runSearch).toHaveBeenCalledTimes(1);
    expect(runSearch.mock.calls[0]![0]).toMatchObject({ plan: { id: saved.plans[0]!.id }, input: { query: "official API documentation" } });
    await f.close();
    const reopened = await fixture(f.stateDir);
    const history = await reopened.hub.getTopicView("root");
    expect(history.messages.find((message) => message.text === answer)).toMatchObject({ sources: [source] });
  });

  it("requires management authentication and rejects management or Worker credentials as search keys", async () => {
    const f = await fixture();
    const requests: Array<[string, string, unknown?]> = [
      ["/api/search", "GET"], ["/api/search/plans", "POST", { name: "Tavily", adapter: "tavily" }],
      ["/api/search/order", "PATCH", { ids: [], expectedRevision: 0 }],
      ["/api/search/plans/missing?expectedRevision=1", "DELETE"],
      ["/api/search/plans/missing/test", "POST", { expectedRevision: 1 }],
    ];
    for (const token of [null, NODE_TOKEN]) for (const [route, method, body] of requests) {
      expect((await f.request(route, method, body, token)).status).toBe(401);
    }
    for (const apiKey of [HUB_TEST_ADMIN_TOKEN, NODE_TOKEN]) {
      const rejected = await f.request("/api/search/plans", "POST", { name: "Tavily", adapter: "tavily", apiKey });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.value)).not.toContain(apiKey);
    }
    expect((await f.request("/api/search")).value.plans).toEqual([]);
    expect(runSearch).not.toHaveBeenCalled();
  });

  it("persists multiple accounts, priority and enable states through restart without leaking or mixing their keys", async () => {
    const f = await fixture();
    const broadcasts: unknown[] = [];
    const unsubscribe = f.hub.subscribe({ onCapabilities: (snapshot) => { broadcasts.push(snapshot); } });
    const first = (await f.add({ name: "Tavily primary", adapter: "tavily", apiKey: FIRST_KEY })).plans[0]!;
    const secondSnapshot = await f.add({ name: "Tavily secondary", adapter: "tavily", apiKey: SECOND_KEY });
    const second = secondSnapshot.plans[1]!;
    await f.add({ name: "Brave primary", adapter: "brave", apiKey: "brave-http-first-test-value" });
    const all = await f.add({ name: "Brave secondary", adapter: "brave", apiKey: "brave-http-second-test-value" });
    expect(all.plans.map((plan) => plan.adapter)).toEqual(["tavily", "tavily", "brave", "brave"]);
    const accountKeys = [FIRST_KEY, SECOND_KEY, "brave-http-first-test-value", "brave-http-second-test-value"];
    for (const [index, plan] of all.plans.entries()) {
      expect((await f.request(`/api/search/plans/${plan.id}/test`, "POST", { expectedRevision: plan.revision })).status).toBe(200);
      expect(runSearch.mock.calls.at(-1)![0]).toMatchObject({ plan: { id: plan.id, adapter: plan.adapter }, apiKey: accountKeys[index] });
    }
    const disabled = await f.add(edit(first, { enabled: false }));
    const order = [second.id, ...disabled.plans.filter((plan) => ![first.id, second.id].includes(plan.id)).map((plan) => plan.id), first.id];
    const reordered = await f.request("/api/search/order", "PATCH", { ids: order, expectedRevision: disabled.revision });
    expect(reordered.status).toBe(200);
    expect(reordered.value.plans.map((plan: SearchPlanView) => plan.id)).toEqual(order);
    expect(reordered.value.plans.at(-1)).toMatchObject({ id: first.id, enabled: false, status: "disabled", hasCredential: true });
    expect(f.hub.getSettingsView().blocks.model.value.defaultModel).toBe("main-model");
    const workspace = await f.request("/api/capabilities?clientId=search-test");
    expect(workspace.value.search.plans.map((plan: SearchPlanView) => plan.id)).toEqual(order);
    expect(broadcasts.length).toBeGreaterThan(0);
    for (const value of [all, reordered.value, workspace.value, broadcasts]) {
      expect(JSON.stringify(value)).not.toContain(FIRST_KEY);
      expect(JSON.stringify(value)).not.toContain(SECOND_KEY);
      expect(JSON.stringify(value)).not.toContain("credentialRef");
    }
    unsubscribe();
    await f.close();
    const g = await fixture(f.stateDir);
    const restored = await g.request("/api/search");
    expect(restored.value.plans.map((plan: SearchPlanView) => plan.id)).toEqual(order);
    expect(restored.value.plans.at(-1)).toMatchObject({ enabled: false, hasCredential: true });
    expect(g.hub.getSettingsView().blocks.model.value.defaultModel).toBe("main-model");
    for (const name of fs.readdirSync(f.stateDir).filter((name) => name.startsWith("moco.sqlite"))) {
      const bytes = fs.readFileSync(path.join(f.stateDir, name));
      expect(bytes.includes(Buffer.from(FIRST_KEY))).toBe(false);
      expect(bytes.includes(Buffer.from(SECOND_KEY))).toBe(false);
    }
  });

  it("rejects stale edits, incomplete priorities and invalid fields without overwriting the current list", async () => {
    const f = await fixture();
    const one = (await f.add({ name: "Primary", adapter: "tavily", apiKey: FIRST_KEY })).plans[0]!;
    const two = await f.add({ name: "Secondary", adapter: "brave", apiKey: "brave-http-validation-test-value" });
    const current = await f.add(edit(one, { name: "Renamed" }));
    expect((await f.request("/api/search/plans", "POST", edit(one, { enabled: false }))).status).toBe(409);
    expect((await f.request("/api/search/order", "PATCH", { ids: current.plans.map((plan) => plan.id), expectedRevision: two.revision })).status).toBe(409);
    for (const ids of [[one.id], [one.id, one.id], [one.id, "missing"]]) {
      expect((await f.request("/api/search/order", "PATCH", { ids, expectedRevision: current.revision })).status).toBe(400);
    }
    for (const extra of [{ secret: FIRST_KEY }, { enabled: "true" }, { apiKey: 123 }, { baseUrl: "https://user:secret@example.com" }, { baseUrl: "https://example.com?token=secret" }, { adapter: "native", providerId: "openai", modelId: "search-model" }]) {
      const rejected = await f.request("/api/search/plans", "POST", { name: "Invalid", adapter: "tavily", ...extra });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.value)).not.toContain(FIRST_KEY);
    }
    expect((await f.request(`/api/search/plans/${one.id}?expectedRevision=${one.revision}`, "DELETE")).status).toBe(409);
    const unchanged = await f.request("/api/search");
    expect(unchanged.value.revision).toBe(current.revision);
    expect(unchanged.value.plans.map((plan: SearchPlanView) => plan.name)).toEqual(["Renamed", "Secondary"]);
  });

  it("tests only the selected plan, publishes source metadata, and uses the same stored order for normal fallback", async () => {
    const f = await fixture();
    await f.add({ name: "Primary", adapter: "tavily", apiKey: FIRST_KEY });
    const snapshot = await f.add({ name: "Secondary", adapter: "tavily", apiKey: SECOND_KEY });
    const [primary, secondary] = snapshot.plans;
    const success = await f.request(`/api/search/plans/${secondary!.id}/test`, "POST", { expectedRevision: secondary!.revision });
    expect(success.status).toBe(200);
    expect(success.value.result).toMatchObject({ planId: secondary!.id, sources: [{ title: "API documentation", url: "https://developers.openai.com/api/docs/" }] });
    expect(success.value.snapshot.plans.find((plan: SearchPlanView) => plan.id === secondary!.id)).toMatchObject({ status: "ready" });
    expect(runSearch).toHaveBeenCalledTimes(1);
    expect(runSearch.mock.calls[0]![0]).toMatchObject({ plan: { id: secondary!.id }, apiKey: SECOND_KEY });
    runSearch.mockReset().mockImplementation(async ({ plan }) => {
      if (plan.id === primary!.id) throw new Error(`Provider rejected key ${FIRST_KEY}`);
      return { sources: [{ id: "docs", title: "Documentation", url: "https://developers.openai.com/api/docs/" }] };
    });
    const failure = await f.request(`/api/search/plans/${primary!.id}/test`, "POST", { expectedRevision: primary!.revision });
    expect(failure.status).toBe(502);
    expect(JSON.stringify(failure.value)).not.toContain(FIRST_KEY);
    expect(runSearch).toHaveBeenCalledTimes(1);
    runSearch.mockClear();
    const fallback = await f.hub.search.search({ query: "official documentation" });
    expect(runSearch.mock.calls.map((call) => call[0].plan.id)).toEqual([primary!.id, secondary!.id]);
    expect(fallback.planId).toBe(secondary!.id);
    expect(fallback.attempts).toHaveLength(2);
    expect(JSON.stringify(await f.request("/api/search"))).not.toContain(FIRST_KEY);
    expect(JSON.stringify(fallback)).not.toContain(FIRST_KEY);
  });

  it("preserves structured upstream failures, redacts credentials and retries through the same POST test endpoint", async () => {
    const f = await fixture();
    const plan = (await f.add({ name: "Rate limited account", adapter: "tavily", apiKey: FIRST_KEY })).plans[0]!;
    const upstream = (details: Record<string, unknown>) => Object.assign(new Error(`Upstream echoed ${FIRST_KEY}`), {
      failure: { kind: "rate_limit", message: `Limit for ${FIRST_KEY}`, upstreamStatus: 429, upstreamCode: "rate_limit_exceeded", parameter: "query", requestId: "req-mcp-429", retryable: true, ...details },
    });
    runSearch.mockRejectedValue(upstream({}));
    const route = `/api/search/plans/${plan.id}/test`;
    const failed = await f.request(route, "POST", { expectedRevision: plan.revision });
    expect(failed.status).toBe(502);
    expect(failed.value).toMatchObject({ code: "search_plan_failed", failure: { kind: "rate_limit", upstreamStatus: 429,
      upstreamCode: "rate_limit_exceeded", parameter: "query", requestId: "req-mcp-429", retryable: true },
      attempts: [{ planId: plan.id, failure: { kind: "rate_limit", upstreamStatus: 429 } }] });
    expect(JSON.stringify(failed.value)).not.toContain(FIRST_KEY);
    runSearch.mockRejectedValue(upstream({ upstreamCode: FIRST_KEY, requestId: FIRST_KEY, parameter: FIRST_KEY }));
    const malicious = await f.request(route, "POST", { expectedRevision: plan.revision });
    expect(malicious.status).toBe(502);
    expect(malicious.value.failure).not.toHaveProperty("upstreamCode");
    expect(malicious.value.failure).not.toHaveProperty("requestId");
    expect(malicious.value.failure).not.toHaveProperty("parameter");
    const unhealthy = await f.request("/api/search");
    expect(unhealthy.value.plans[0]).toMatchObject({ revision: plan.revision, status: "error", failure: { kind: "rate_limit" } });
    expect(JSON.stringify(unhealthy.value)).not.toContain(FIRST_KEY);
    runSearch.mockResolvedValue({ sources: [{ id: "recovered", title: "Recovered source", url: "https://example.com/recovered" }] });
    const retried = await f.request(route, "POST", { expectedRevision: plan.revision });
    expect(retried.status).toBe(200);
    expect(retried.value.snapshot.plans[0]).toMatchObject({ revision: plan.revision, status: "ready" });
    expect(retried.value.snapshot.plans[0]).not.toHaveProperty("failure");
    expect(retried.value.result.sources).toMatchObject([{ title: "Recovered source" }]);
    expect(runSearch).toHaveBeenCalledTimes(3);
  });

  it("treats an empty search as a healthy response while trying the next configured service", async () => {
    const f = await fixture();
    await f.add({ name: "Empty index", adapter: "tavily", apiKey: FIRST_KEY });
    const snapshot = await f.add({ name: "Second index", adapter: "brave", apiKey: "brave-empty-test-key" });
    const [first, second] = snapshot.plans;
    runSearch.mockResolvedValue({ sources: [] });
    const tested = await f.request(`/api/search/plans/${first!.id}/test`, "POST", { expectedRevision: first!.revision });
    expect(tested.status).toBe(200);
    expect(tested.value.result.sources).toEqual([]);
    expect(tested.value.snapshot.plans[0]).toMatchObject({ status: "ready" });
    expect(tested.value.snapshot.plans[0]).not.toHaveProperty("failure");
    runSearch.mockClear();
    const empty = await f.hub.search.search({ query: "missing fixture result" });
    expect(empty.sources).toEqual([]);
    expect(runSearch.mock.calls.map((call) => call[0].plan.id)).toEqual([first!.id, second!.id]);
    runSearch.mockClear();
    runSearch.mockImplementation(async ({ plan }) => ({ sources: plan.id === first!.id ? [] : [{ id: "found", title: "Second index source", url: "https://example.com/found" }] }));
    const found = await f.hub.search.search({ query: "fixture result" });
    expect(found.planId).toBe(second!.id);
    expect(found.attempts[0]).toMatchObject({ planId: first!.id, failure: { kind: "no_results" } });
    expect(found.sources).toHaveLength(1);
  });

  it("never reuses a stored key after changing the API origin and removes credentials with the deleted plan", async () => {
    const f = await fixture();
    const plan = (await f.add({ name: "Tavily", adapter: "tavily", apiKey: FIRST_KEY })).plans[0]!;
    const changed = await f.add(edit(plan, { baseUrl: "https://search.example.com" }));
    expect(changed.plans[0]).toMatchObject({ hasCredential: false, status: "needs_auth" });
    const check = await f.request(`/api/search/plans/${plan.id}/test`, "POST", { expectedRevision: changed.plans[0]!.revision });
    expect(check.status).toBe(409);
    expect(check.value).toMatchObject({ failure: { kind: "auth", retryable: false } });
    expect(runSearch).not.toHaveBeenCalled();
    const credentialFile = path.join(f.stateDir, "credentials.json");
    expect(fs.existsSync(credentialFile)).toBe(false);
    const credentials = fs.readFileSync(path.join(f.stateDir, "connection-vault.json"), "utf8");
    expect(credentials).not.toContain(FIRST_KEY);
    const removed = await f.request(`/api/search/plans/${plan.id}?expectedRevision=${changed.plans[0]!.revision}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.value.plans).toEqual([]);
  });
});
