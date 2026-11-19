import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOfficialVertexBaseUrl } from "@moco/protocol";
import type { MocoModelConfig } from "../packages/hub/src/config.js";
import { MocoProviderManager } from "../packages/hub/src/providers.js";
import { fetchLiveProviderModels } from "../packages/hub/src/provider-discovery.js";
import { startMocoHubServer } from "../packages/hub/src/server.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

vi.mock("../packages/hub/src/provider-discovery.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../packages/hub/src/provider-discovery.js")>();
  return { ...original, fetchLiveProviderModels: vi.fn() };
});

const providerId = "api-vertex-directory";
const baseUrl = "https://aiplatform.googleapis.com";
const sourceUrl = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions?hl=en";
const directories: string[] = [];
const liveModels = vi.mocked(fetchLiveProviderModels);

function config(gateway = false): MocoModelConfig {
  return {
    baseUrl, apiMode: gateway ? "google-vertex" : "openai-responses",
    defaultProvider: gateway ? "moco-gateway" : providerId, defaultModel: "gemini-manual", thinkingLevel: "off", contextWindow: 100_000,
    compaction: { enabled: false, reserveTokens: 10_000, keepRecentTokens: 20_000, backgroundTokens: 30_000 },
    gatewayDisabled: !gateway, gatewayModels: [{ id: "gemini-manual" }],
    customProviders: gateway ? [] : [{ id: providerId, name: "Vertex", api: "google-vertex", baseUrl, models: [{ id: "gemini-manual" }] }],
  };
}

function fixture(gateway = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-vertex-directory-"));
  directories.push(stateDir);
  const manager = new MocoProviderManager({ stateDir });
  manager.syncProviders(config(gateway), {});
  return { manager, stateDir, id: gateway ? "moco-gateway" : providerId };
}

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const name of ["MOCO_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "");
  liveModels.mockReset();
  liveModels.mockResolvedValue([{ id: "gemini-latest-published" }]);
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Vertex public directory management", () => {
  it.each([
    "https://aiplatform.googleapis.com",
    "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global",
    "https://us-central1-aiplatform.googleapis.com/v1",
    "https://asia-southeast1-aiplatform.googleapis.com",
  ])("recognizes official Vertex endpoints: %s", (url) => {
    expect(isOfficialVertexBaseUrl(url)).toBe(true);
  });

  it.each([
    "http://aiplatform.googleapis.com", "https://aiplatform.googleapis.com:8443",
    "https://aiplatform.googleapis.com.evil.example", "https://user@aiplatform.googleapis.com",
    "https://aiplatform.googleapis.com?key=synthetic", "https://aiplatform.googleapis.com#fragment", "invalid",
  ])("keeps arbitrary endpoints out of the public directory path: %s", (url) => {
    expect(isOfficialVertexBaseUrl(url)).toBe(false);
  });

  it.each([false, true])("discovers without a key, JSON or project configuration (gateway=%s)", async (gateway) => {
    const { manager, id } = fixture(gateway);
    const read = vi.spyOn(manager.credentials, "read");
    const response = await manager.discoverModels({ providerId: id, api: "google-vertex", vertexProject: "invalid/project" });
    expect(response).toMatchObject({ ok: true, models: [{ id: "gemini-latest-published" }], source: "official-documentation", sourceUrl });
    expect(read).not.toHaveBeenCalled();
    expect(liveModels).toHaveBeenCalledWith({ baseUrl, api: "google-vertex", apiKey: undefined, signal: expect.any(AbortSignal) });
  });

  it("does not resolve or forward either a saved or draft API key for the public directory", async () => {
    const { manager, id } = fixture();
    await manager.credentials.modify(id, async () => ({ type: "api_key", key: "synthetic-saved-generation-key", env: { MOCO_API_KEY_ORIGIN: baseUrl } }));
    const read = vi.spyOn(manager.credentials, "read");
    const response = await manager.discoverModels({ providerId: id, api: "google-vertex", apiKey: "synthetic-draft-generation-key" });
    expect(response.ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(liveModels.mock.calls[0]![0].apiKey).toBeUndefined();
  });

  it("refreshes an unauthenticated official provider with public source and configured-model metadata", async () => {
    const { manager, id } = fixture();
    const response = await manager.refreshProvider(id);
    expect(response).toMatchObject({ authenticated: false, modelCatalogSource: "official-documentation", models: [{ id: "gemini-latest-published" }], configuredModels: [{ id: "gemini-manual" }] });
    expect(liveModels).toHaveBeenCalledTimes(1);
    expect(liveModels.mock.calls[0]![0].apiKey).toBeUndefined();
  });

  it("keeps generation API keys, unrelated environment and OAuth credentials intact", async () => {
    const { manager, id } = fixture();
    const oauth = { type: "oauth" as const, access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60_000 };
    await manager.credentials.modify("openai-codex", async () => oauth);
    await manager.credentials.modify(id, async () => ({ type: "api_key", key: "synthetic-old-key", env: { MOCO_API_KEY_ORIGIN: baseUrl, CUSTOM_SETTING: "kept" } }));
    await manager.setApiKey(id, "synthetic-new-generation-key");
    expect(await manager.credentials.read(id)).toMatchObject({ type: "api_key", key: "synthetic-new-generation-key", env: { MOCO_API_KEY_ORIGIN: baseUrl, CUSTOM_SETTING: "kept" } });
    expect(await manager.credentials.read("openai-codex")).toEqual(oauth);
    expect(liveModels.mock.calls.every(([request]) => request.apiKey === undefined)).toBe(true);
    expect((await manager.models.getAuth(id))?.auth.apiKey).toBe("synthetic-new-generation-key");
  });

  it("preserves origin-bound API discovery for third-party Vertex endpoints", async () => {
    const { manager, id } = fixture();
    const thirdParty = "https://vertex.example";
    const model = config();
    manager.syncProviders({ ...model, customProviders: [{ ...model.customProviders[0]!, baseUrl: thirdParty }] }, {});
    await manager.credentials.modify(id, async () => ({ type: "api_key", key: "synthetic-third-party-key", env: { MOCO_API_KEY_ORIGIN: thirdParty } }));
    expect((await manager.discoverModels({ providerId: id, api: "google-vertex" })).ok).toBe(true);
    expect(liveModels.mock.calls.at(-1)![0].apiKey).toBe("synthetic-third-party-key");
    await manager.discoverModels({ providerId: id, api: "google-vertex", baseUrl: "https://changed.example" });
    expect(liveModels.mock.calls.at(-1)![0].apiKey).toBeUndefined();
  });

  it("returns fresh failure instead of configured or earlier successful models", async () => {
    const { manager, id } = fixture();
    expect((await manager.discoverModels({ providerId: id, api: "google-vertex" })).ok).toBe(true);
    liveModels.mockRejectedValue(new Error("官方模型文档暂时无法读取"));
    expect(await manager.discoverModels({ providerId: id, api: "google-vertex" })).toMatchObject({ ok: false, models: [], error: "官方模型文档暂时无法读取" });
    await expect(manager.refreshProvider(id)).rejects.toThrow("官方模型文档暂时无法读取");
  });

  it("exposes public-directory metadata over HTTP and removes JSON credential endpoints", async () => {
    const { stateDir } = fixture();
    const { openTestHub } = await import("./helpers/secure-hub.js");
    const hub = await openTestHub({ config: { stateDir, enableLocalEnv: false, authToken: HUB_TEST_ADMIN_TOKEN, model: config(), memory: { enabled: false } } });
    const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` };
    try {
      const response = await fetch(`${server.url}/api/providers/discover-models`, { method: "POST", headers, body: JSON.stringify({ providerId, api: "google-vertex", vertexProject: "not/a-project" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, source: "official-documentation", sourceUrl, models: [{ id: "gemini-latest-published" }] });
      for (const method of ["POST", "DELETE"]) {
        const removed = await fetch(`${server.url}/api/providers/${providerId}/vertex-catalog-auth`, { method, headers });
        expect(removed.status).toBe(404);
      }
      expect(liveModels.mock.calls.every(([request]) => request.apiKey === undefined)).toBe(true);
    } finally { await server.close(); await hub.close(); }
  });
});
