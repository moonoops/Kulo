import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KuloProviderManager } from "../packages/hub/src/providers";
import type { KuloHubConfig, KuloModelConfig } from "../packages/hub/src/config";
import {
  applySettingsBlockUpdate,
  hydrateSettingsFromConfig,
  type KuloDurableSettings,
} from "../packages/hub/src/settings";

const dirs: string[] = [];
const servers: http.Server[] = [];
const providerId = "api-origin-test";
const gatewayId = "kulo-gateway";
const dummyKey = "dummy-origin-key";

function tempState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-provider-origin-"));
  dirs.push(dir);
  return dir;
}

async function endpoint() {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({
          id: "local-completion", object: "chat.completion.chunk", created: 0, model: "local-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        })}`,
        `data: ${JSON.stringify({
          id: "local-completion", object: "chat.completion.chunk", created: 0, model: "local-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

function modelConfig(origin: string): KuloModelConfig {
  return {
    baseUrl: `${origin}/v1`,
    apiMode: "openai-completions",
    defaultProvider: providerId,
    defaultModel: "local-model",
    thinkingLevel: "off",
    contextWindow: 256_000,
    compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 },
    gatewayDisabled: true,
    customProviders: [{
      id: providerId,
      name: "Local origin test",
      api: "openai-completions",
      baseUrl: `${origin}/v1`,
      models: [{ id: "local-model" }],
    }],
  };
}

function durableSettings(model: KuloModelConfig): KuloDurableSettings {
  return {
    initialized: true,
    rolesMigratedV2: true,
    rolesMigratedV3: true,
    globalRevision: 1,
    revisions: { presentation: 1, executor: 1, roles: 1, model: 1, identity: 1, memory: 1 },
    presentation: { agentName: "Kulo", workbenchName: "Table" },
    executor: { maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1, paused: false, watchdogMinutes: 0 },
    roles: {},
    model: { ...model },
    identity: { directory: "", directoryRevision: 1 },
    memory: {
      enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "",
      routerApiKeyEnv: "KULO_TEST_MEMORY_KEY", workerApiKeyEnv: "KULO_TEST_WORKER_MEMORY_KEY", authFile: "", autoAttachTopLevelRouters: false,
      banks: { private: "test-private", shared: "test-shared" },
    },
    expression: null,
    snapshots: [],
  };
}

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(name, "");
  vi.stubEnv("KULO_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Provider API keys remain bound to their saved origin", () => {
  it.each([providerId, gatewayId])("binds request destination with auth when using a stale %s model", async (id) => {
    const a = await endpoint();
    const b = await endpoint();
    const manager = new KuloProviderManager({ stateDir: tempState() });
    const original = { ...modelConfig(a.origin), defaultProvider: id, gatewayDisabled: id !== gatewayId };
    manager.syncProviders(original, {});
    await manager.setApiKey(id, dummyKey);
    const oldModel = manager.models.getModel(id, "local-model")!;
    manager.syncProviders({ ...modelConfig(b.origin), defaultProvider: id, gatewayDisabled: id !== gatewayId }, {});
    await manager.setApiKey(id, "dummy-new-request-origin-key");
    const completion = await manager.models.completeSimple(
      oldModel,
      { messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
      { signal: AbortSignal.timeout(2_000) },
    );
    expect(completion.stopReason).toBe("stop");
    expect(oldModel.baseUrl).toBe(`${a.origin}/v1`);
    expect(a.requests.some((r) => r.url.endsWith("/chat/completions"))).toBe(false);
    expect(b.requests.at(-1)).toEqual({
      url: "/v1/chat/completions", authorization: "Bearer dummy-new-request-origin-key",
    });
  });

  it("blocks custom keys after an origin edit, across restart, and binds an explicitly replaced key", async () => {
    const a = await endpoint();
    const b = await endpoint();
    const stateDir = tempState();
    const manager = new KuloProviderManager({ stateDir });
    const original = modelConfig(a.origin);
    manager.syncProviders(original, {});
    await manager.setApiKey(providerId, dummyKey);
    expect(a.requests.at(-1)?.authorization).toBe(`Bearer ${dummyKey}`);
    expect((await manager.models.getAuth(providerId))?.auth.apiKey).toBe(dummyKey);

    const sameOrigin = {
      ...original,
      customProviders: [{ ...original.customProviders[0]!, baseUrl: `${a.origin}/other/v1` }],
    };
    manager.syncProviders(sameOrigin, {});
    await manager.refreshProvider(providerId);
    expect(a.requests.at(-1)).toEqual({ url: "/other/v1/models", authorization: `Bearer ${dummyKey}` });

    const changed = modelConfig(b.origin);
    manager.syncProviders(changed, {});
    expect(await manager.models.getAuth(providerId)).toBeUndefined();
    expect((await manager.getProviderCatalogItem(providerId)).authenticated).toBe(false);
    await expect(manager.refreshProvider(providerId)).rejects.toThrow("授权状态");
    expect(b.requests).toHaveLength(0);
    await manager.discoverModels({ providerId, api: "openai-completions" });
    expect(b.requests.every((r) => r.authorization === undefined)).toBe(true);

    const restarted = new KuloProviderManager({ stateDir });
    await restarted.bindLegacyApiKeyOrigins(changed);
    restarted.syncProviders(changed, {});
    expect(await restarted.models.getAuth(providerId)).toBeUndefined();
    await restarted.setApiKey(providerId, "dummy-new-origin-key");
    expect(b.requests.at(-1)?.authorization).toBe("Bearer dummy-new-origin-key");
    expect(b.requests.some((r) => r.authorization === `Bearer ${dummyKey}`)).toBe(false);
    restarted.syncProviders(original, {});
    expect(await restarted.models.getAuth(providerId)).toBeUndefined();
  });

  it("migrates unbound legacy keys using restored URLs rather than initial environment defaults", async () => {
    const a = await endpoint();
    const b = await endpoint();
    const stateDir = tempState();
    fs.writeFileSync(path.join(stateDir, "credentials.json"), JSON.stringify({
      [providerId]: { type: "api_key", key: dummyKey },
      [gatewayId]: { type: "api_key", key: "dummy-legacy-gateway" },
    }));
    const manager = new KuloProviderManager({ stateDir });
    manager.syncProviders(modelConfig(a.origin), {});
    expect(await manager.models.getAuth(providerId)).toBeUndefined();
    const restored = { ...modelConfig(b.origin), gatewayDisabled: false };
    await manager.bindLegacyApiKeyOrigins(restored);
    manager.syncProviders(restored, {});
    expect((await manager.models.getAuth(providerId))?.auth.apiKey).toBe(dummyKey);
    expect((await manager.models.getAuth(gatewayId))?.auth.apiKey).toBe("dummy-legacy-gateway");
    await manager.refreshProvider(providerId);
    expect(b.requests.at(-1)?.authorization).toBe(`Bearer ${dummyKey}`);
    const changed = { ...modelConfig(a.origin), gatewayDisabled: false };
    await manager.bindLegacyApiKeyOrigins(changed);
    manager.syncProviders(changed, {});
    expect(await manager.models.getAuth(providerId)).toBeUndefined();
    expect(await manager.models.getAuth(gatewayId)).toBeUndefined();
  });

  it("does not use a saved gateway key or the startup environment key at a changed origin", async () => {
    const a = await endpoint();
    const b = await endpoint();
    vi.stubEnv("KULO_API_KEY", "dummy-environment-key");
    const stateDir = tempState();
    const manager = new KuloProviderManager({ stateDir });
    const original = { ...modelConfig(a.origin), defaultProvider: gatewayId, gatewayDisabled: false };
    manager.syncProviders(original, {});
    await manager.refreshProvider(gatewayId);
    expect(a.requests.at(-1)?.authorization).toBe("Bearer dummy-environment-key");
    await manager.setApiKey(gatewayId, dummyKey);
    const changed = { ...original, baseUrl: `${b.origin}/v1` };
    manager.syncProviders(changed, {});
    expect(await manager.models.getAuth(gatewayId)).toBeUndefined();
    await expect(manager.refreshProvider(gatewayId)).rejects.toThrow("授权状态");
    await manager.discoverModels({ providerId: gatewayId, api: "openai-completions" });
    expect(b.requests.every((r) => r.authorization === undefined)).toBe(true);
    const restarted = new KuloProviderManager({ stateDir });
    restarted.syncProviders(original, {});
    await restarted.bindLegacyApiKeyOrigins(changed);
    restarted.syncProviders(changed, {});
    expect(await restarted.models.getAuth(gatewayId)).toBeUndefined();
    await restarted.setApiKey(gatewayId, "dummy-new-gateway-key");
    expect(b.requests.at(-1)?.authorization).toBe("Bearer dummy-new-gateway-key");
  });

  it("preserves inline gateway keys for same-origin edits, clears them for other origins, and accepts replacement keys", async () => {
    const a = await endpoint();
    const b = await endpoint();
    const initial = { ...modelConfig(a.origin), apiKey: dummyKey, defaultProvider: gatewayId, gatewayDisabled: false };
    const doc = durableSettings(initial);
    const manager = new KuloProviderManager({ stateDir: tempState() });
    manager.syncProviders(initial, {});
    const { apiKey: _key, ...publicDraft } = doc.model;
    applySettingsBlockUpdate(doc, "model", 1, { ...publicDraft, baseUrl: `${a.origin}/other/v1` });
    expect(doc.model.apiKey).toBe(dummyKey);
    applySettingsBlockUpdate(doc, "model", 2, { ...publicDraft, baseUrl: `${b.origin}/v1` });
    expect(doc.model.apiKey).toBeUndefined();
    manager.syncProviders(doc.model as KuloModelConfig, {});
    expect(await manager.models.getAuth(gatewayId)).toBeUndefined();
    await manager.discoverModels({ providerId: gatewayId, api: "openai-completions" });
    expect(b.requests.every((r) => r.authorization === undefined)).toBe(true);

    const config: KuloHubConfig = {
      stateDir: tempState(), identityDir: "/unused", host: "127.0.0.1", port: 0,
      enableLocalEnv: false, maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1,
      watchdogMinutes: 0, model: initial, roles: {}, memory: doc.memory, presentation: doc.presentation,
    };
    hydrateSettingsFromConfig(doc, config);
    expect(doc.model.apiKey).toBeUndefined();
    applySettingsBlockUpdate(doc, "model", 3, {
      ...publicDraft, baseUrl: `${b.origin}/v1`, apiKey: "dummy-new-inline-key",
    });
    manager.syncProviders(doc.model as KuloModelConfig, {});
    await manager.refreshProvider(gatewayId);
    expect(b.requests.at(-1)?.authorization).toBe("Bearer dummy-new-inline-key");
  });
});
