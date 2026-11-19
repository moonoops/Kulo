import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVertexModelBaseUrl, normalizeVertexConfig, VertexConfigError } from "@kulo/protocol";
import { resolveHubConfig, type KuloHubConfig, type KuloModelConfig } from "../packages/hub/src/config";
import { KuloProviderManager } from "../packages/hub/src/providers";
import { probeOpenAICompatibleGateway } from "../packages/hub/src/models";
import { applySettingsBlockUpdate, hydrateSettingsFromConfig, rollbackSettingsToSnapshot, toPublicSettingsView, type KuloDurableSettings } from "../packages/hub/src/settings";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";
import { startKuloHubServer } from "../packages/hub/src/server";

const directories: string[] = [];
const servers: http.Server[] = [];
const project = { vertexProject: "kulo-project", vertexLocation: "global" };
const modelId = "gemini-2.5-pro";
const customId = "api-vertex-project";

function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-vertex-project-")); directories.push(value); return value;
}
function config(baseUrl = "https://aiplatform.googleapis.com", gateway = false): KuloModelConfig {
  return {
    baseUrl, apiMode: gateway ? "google-vertex" : "openai-responses", apiKey: "synthetic-gateway-key",
    defaultProvider: gateway ? "kulo-gateway" : customId, defaultModel: modelId, thinkingLevel: "off", contextWindow: 100_000,
    compaction: { enabled: false, reserveTokens: 10_000, keepRecentTokens: 20_000, backgroundTokens: 30_000 },
    ...(gateway ? project : {}), gatewayDisabled: !gateway, gatewayModels: [{ id: modelId, reasoning: false }],
    customProviders: gateway ? [] : [{ id: customId, name: "Vertex", preset: "google-vertex", api: "google-vertex", baseUrl, ...project, models: [{ id: modelId, reasoning: false }] }],
  };
}
function settings(model = config()): KuloDurableSettings {
  return {
    initialized: true, rolesMigratedV2: true, rolesMigratedV3: true, globalRevision: 1,
    revisions: { presentation: 1, executor: 1, roles: 1, model: 1, identity: 1, memory: 1 },
    presentation: { agentName: "Kulo", workbenchName: "Table" },
    executor: { maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1, paused: false, watchdogMinutes: 0 },
    roles: {}, model, identity: { directory: "", directoryRevision: 1 },
    memory: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "KULO_TEST_MEMORY_KEY", workerApiKeyEnv: "KULO_TEST_WORKER_MEMORY_KEY", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "test-private", shared: "test-shared" } },
    expression: null, snapshots: [],
  };
}
function hubConfig(doc: KuloDurableSettings): KuloHubConfig {
  const stateDir = directory();
  return { stateDir, identityDir: path.join(stateDir, "identity"), host: "127.0.0.1", port: 0, envTokens: {}, workerEnvIds: [], enableLocalEnv: false,
    maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1, watchdogMinutes: 0, model: doc.model as KuloModelConfig, roles: {}, memory: doc.memory, presentation: doc.presentation };
}
async function endpoint() {
  const requests: Array<{ method: string; path: string; key?: string; body?: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method ?? "", path: request.url ?? "", key: request.headers["x-goog-api-key"] as string | undefined, ...(body ? { body: JSON.parse(body) } : {}) });
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ publisherModels: [{ name: `publishers/google/models/${modelId}` }] })); return;
    }
    const result = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    if (request.url?.includes(":streamGenerateContent")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.end(`data: ${JSON.stringify(result)}\n\n`);
    } else {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(result));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const name of ["KULO_API_KEY", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(name, "");
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("Vertex project configuration", () => {
  it("accepts project IDs and numeric project numbers while preserving legacy Express and explicit clears", () => {
    expect(normalizeVertexConfig({})).toBeUndefined();
    expect(normalizeVertexConfig({ vertexProject: " ", vertexLocation: "" })).toBeUndefined();
    expect(normalizeVertexConfig({ vertexProject: " kulo-project ", vertexLocation: " global " })).toEqual(project);
    expect(normalizeVertexConfig({ vertexProject: "123456789012", vertexLocation: "us-central1" })).toEqual({ vertexProject: "123456789012", vertexLocation: "us-central1" });
    expect(buildVertexModelBaseUrl("https://aiplatform.googleapis.com", {})).toBe("https://aiplatform.googleapis.com");
  });

  it.each([
    { vertexProject: "kulo-project" }, { vertexLocation: "global" }, { vertexProject: "", vertexLocation: "global" },
    { vertexProject: null, vertexLocation: "global" }, { vertexProject: 123456789012, vertexLocation: "global" },
    { vertexProject: "../project", vertexLocation: "global" }, { vertexProject: "kulo-project/locations/global", vertexLocation: "global" },
    { vertexProject: "kulo%2fproject", vertexLocation: "global" }, { vertexProject: "kulo-project?key=value", vertexLocation: "global" },
    { vertexProject: "Kulo Project", vertexLocation: "global" }, { vertexProject: "kulo-project", vertexLocation: "../global" },
    { vertexProject: "kulo-project", vertexLocation: "global?key=value" }, { vertexProject: "kulo-project", vertexLocation: "us--central1" },
  ])("rejects incomplete or path-injecting fields: %j", (value) => {
    expect(() => normalizeVertexConfig(value)).toThrow(VertexConfigError);
  });

  it.each(["", "/v1", "/v1beta1", "/v1/projects/previous-project/locations/us-central1"])("constructs exactly one version/project route from %s", (suffix) => {
    expect(buildVertexModelBaseUrl(`https://aiplatform.googleapis.com${suffix}`, project)).toBe("https://aiplatform.googleapis.com/v1/projects/kulo-project/locations/global");
  });

  it("persists, hydrates, projects publicly, reloads and rolls back both gateway and custom Vertex fields", () => {
    const model = { ...config(), apiMode: "google-vertex" as const, ...project };
    const resolved = resolveHubConfig({ model });
    expect(resolved.model).toMatchObject(project);
    expect(resolved.model.customProviders[0]).toMatchObject(project);
    const doc = settings(model); doc.initialized = false;
    hydrateSettingsFromConfig(doc, hubConfig(doc));
    expect(toPublicSettingsView(doc, "/tmp/identity").blocks.model.value).toMatchObject({ ...project, customProviders: [project] });
    applySettingsBlockUpdate(doc, "model", 1, { vertexProject: "new-project", vertexLocation: "us-central1" });
    expect(doc.model.apiKey).toBe("synthetic-gateway-key");
    const reloaded = JSON.parse(JSON.stringify(doc)) as KuloDurableSettings;
    hydrateSettingsFromConfig(reloaded, hubConfig(reloaded));
    expect(reloaded.model.vertexProject).toBe("new-project");
    rollbackSettingsToSnapshot(reloaded, reloaded.globalRevision, reloaded.globalRevision);
    expect(reloaded.model).toMatchObject(project);
    applySettingsBlockUpdate(reloaded, "model", reloaded.revisions.model, { apiMode: "openai-responses", vertexProject: "", vertexLocation: "" });
    expect(reloaded.model).not.toHaveProperty("vertexProject");
    expect(reloaded.model).not.toHaveProperty("vertexLocation");
  });

  it("rejects partial settings atomically and strips Vertex fields from other API protocols", () => {
    const doc = settings({ ...config(), customProviders: [] });
    const before = JSON.stringify(doc);
    expect(() => applySettingsBlockUpdate(doc, "model", 1, { apiMode: "google-vertex", vertexProject: "kulo-project" })).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
    const other = { ...config().customProviders[0]!, api: "openai-responses" as const };
    applySettingsBlockUpdate(doc, "model", 1, { customProviders: [other] });
    expect(doc.model.customProviders![0]).not.toHaveProperty("vertexProject");
    expect(doc.model.customProviders![0]).not.toHaveProperty("vertexLocation");
  });
});

describe("Vertex project routing and origin-bound credentials", () => {
  it.each([401, 503])("reports public document HTTP %s failures without diagnosing API-key permissions", async (status) => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).origin).toBe("https://docs.cloud.google.com");
      const headers = new Headers(init?.headers);
      expect(headers.has("x-goog-api-key")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
      return new Response("public documentation unavailable", { status });
    });
    vi.stubGlobal("fetch", request);
    const manager = new KuloProviderManager({ stateDir: directory() });
    const result = await manager.discoverModels({ api: "google-vertex", baseUrl: "https://aiplatform.googleapis.com", apiKey: "synthetic-vertex-key", ...project });
    expect(result).toMatchObject({ ok: false, models: [] });
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.error).toContain("官方模型文档");
    expect(result.error).not.toMatch(/认证|API Key|权限|密钥/);
  });

  it("reports a changed public document format without treating it as an invalid API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("unexpected format", { headers: { "Content-Type": "text/plain" } })));
    const manager = new KuloProviderManager({ stateDir: directory() });
    const result = await manager.discoverModels({ api: "google-vertex", baseUrl: "https://aiplatform.googleapis.com", apiKey: "synthetic-invalid-key", ...project });
    expect(result.error).toContain("HTML");
    expect(result.error).not.toMatch(/认证|API Key|权限|密钥/);
  });

  it.each([false, true])("routes native generation for custom/gateway=%s and keeps the same-origin key after project changes", async (gateway) => {
    const upstream = await endpoint();
    const manager = new KuloProviderManager({ stateDir: directory() });
    const initial = { ...config(upstream.baseUrl, gateway), apiKey: undefined };
    const id = gateway ? "kulo-gateway" : customId;
    manager.syncProviders(initial, {});
    await manager.setApiKey(id, "synthetic-vertex-key");
    const oldModel = manager.models.getModel(id, modelId)!;
    expect(oldModel.baseUrl).toBe(`${upstream.baseUrl}/v1/projects/kulo-project/locations/global`);
    const nextFields = { vertexProject: "123456789012", vertexLocation: "us-central1" };
    const next = gateway ? { ...initial, ...nextFields } : { ...initial, customProviders: [{ ...initial.customProviders[0]!, ...nextFields }] };
    manager.syncProviders(next, {});
    expect((await manager.models.getAuth(id))?.auth.apiKey).toBe("synthetic-vertex-key");
    const result = await manager.models.completeSimple(oldModel, { messages: [{ role: "user", content: "test", timestamp: Date.now() }] }, { signal: AbortSignal.timeout(2_000) });
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(upstream.requests.filter((request) => request.method === "POST")).toEqual([expect.objectContaining({
      path: `/v1/projects/123456789012/locations/us-central1/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`, key: "synthetic-vertex-key",
    })]);
    await manager.discoverModels({ providerId: id, api: "google-vertex", ...nextFields });
    await manager.discoverModels({ providerId: id, api: "google-vertex", baseUrl: `${upstream.baseUrl}/v1/projects/legacy-project/locations/global`, ...nextFields });
    expect(upstream.requests.filter((request) => request.method === "GET").every((request) => request.path === "/v1beta1/publishers/google/models?listAllVersions=true&view=PUBLISHER_MODEL_VIEW_FULL&pageSize=100")).toBe(true);
    const changed = await endpoint();
    const edited = gateway ? { ...next, baseUrl: changed.baseUrl } : { ...next, customProviders: [{ ...next.customProviders[0]!, baseUrl: changed.baseUrl }] };
    manager.syncProviders(edited, {});
    expect(await manager.resolveProbeApiKey(id, changed.baseUrl)).toBeUndefined();
    expect(await manager.models.getAuth(id)).toBeUndefined();
  });

  it("uses configured project fields in probes without falling back to another connection's key", async () => {
    const upstream = await endpoint();
    const saved = config(upstream.baseUrl);
    vi.stubEnv("KULO_API_KEY", "synthetic-wrong-env-key");
    const result = await probeOpenAICompatibleGateway(saved, { model: modelId }, undefined, {
      api: "google-vertex", baseUrl: upstream.baseUrl, model: modelId, ...project,
    });
    expect(result.ok, `${result.error ?? ""} ${result.rawDetail ?? ""}`).toBe(true);
    expect(upstream.requests[0]).toMatchObject({ path: `/v1/projects/kulo-project/locations/global/publishers/google/models/${modelId}:generateContent`, key: undefined });
  });

  it("passes fields through real discovery and probe HTTP routes and rejects incomplete requests with HTTP 400", async () => {
    const { openTestHub } = await import("./helpers/secure-hub");
    const upstream = await endpoint();
    const stateDir = directory();
    const hub = await openTestHub({ config: { stateDir, enableLocalEnv: false, authToken: HUB_TEST_ADMIN_TOKEN, model: config(upstream.baseUrl), memory: { ...settings().memory, enabled: false } } });
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` };
    try {
      await hub.setProviderApiKey(customId, "synthetic-saved-vertex-key");
      const discovery = await fetch(`${server.url}/api/providers/discover-models`, { method: "POST", headers,
        body: JSON.stringify({ providerId: customId, api: "google-vertex", ...project }) });
      expect(discovery.status).toBe(200);
      expect((await discovery.json()).models.map((model: { id: string }) => model.id)).toEqual([modelId]);
      const invalid = await fetch(`${server.url}/api/providers/discover-models`, { method: "POST", headers,
        body: JSON.stringify({ api: "google-vertex", baseUrl: upstream.baseUrl, vertexProject: "kulo-project" }) });
      expect(invalid.status).toBe(400);
      const probe = await fetch(`${server.url}/api/model/probe`, { method: "POST", headers,
        body: JSON.stringify({ providerId: customId, model: modelId, vertexProject: "another-project", vertexLocation: "us-central1" }) });
      expect(probe.status).toBe(200);
      expect((await probe.json()).ok).toBe(true);
      expect(upstream.requests.filter((request) => request.method === "POST").at(-1)).toMatchObject({
        path: `/v1/projects/another-project/locations/us-central1/publishers/google/models/${modelId}:generateContent`, key: "synthetic-saved-vertex-key",
      });
      const invalidProbe = await fetch(`${server.url}/api/model/probe`, { method: "POST", headers,
        body: JSON.stringify({ providerId: customId, model: modelId, vertexProject: "../bad-project", vertexLocation: "global" }) });
      expect(invalidProbe.status).toBe(400);
    } finally { await server.close(); await hub.close(); }
  });
});
