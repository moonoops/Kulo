import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KuloSettingsView, ProviderCatalogItem } from "@kulo/protocol";
import { KuloHub, startKuloHubServer, type KuloHubServer } from "@kulo/hub";
import type { KuloModelConfig } from "../packages/hub/src/config";
import { HUB_TEST_ADMIN_TOKEN, fetchWithHubAuth } from "./helpers/hub-auth";

const directories: string[] = [];
const hubs = new Set<KuloHub>();
const servers = new Set<KuloHubServer>();
const allInputs = ["text", "image", "audio", "video", "pdf"];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.clear();
  for (const hub of hubs) await hub.close();
  hubs.clear();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function stateDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-model-modalities-"));
  directories.push(directory);
  return directory;
}

async function open(stateDir: string, model: Partial<KuloModelConfig> = {}) {
  const hub = await openTestHub({ config: {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"),
    enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", apiKey: "", defaultProvider: "", defaultModel: "", ...model },
  } });
  hubs.add(hub);
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  servers.add(server);
  return { hub, server };
}

async function settings(server: KuloHubServer): Promise<KuloSettingsView> {
  const response = await fetchWithHubAuth(`${server.url}/api/settings`);
  expect(response.status).toBe(200);
  return response.json();
}

async function saveModels(server: KuloHubServer, value: Record<string, unknown>): Promise<KuloSettingsView> {
  const previous = await settings(server);
  const response = await fetchWithHubAuth(`${server.url}/api/settings/model`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: previous.blocks.model.revision, value: { ...previous.blocks.model.value, ...value } }),
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { settings: KuloSettingsView };
  return result.settings;
}

async function providerModels(server: KuloHubServer) {
  const response = await fetchWithHubAuth(`${server.url}/api/providers`);
  expect(response.status).toBe(200);
  return (await response.json() as { providers: ProviderCatalogItem[] }).providers;
}

describe("configured model input types", () => {
  it("round trips all five input types through HTTP settings and provider catalogs across restart", async () => {
    const stateDir = stateDirectory();
    const first = await open(stateDir);
    const configured = {
      gatewayModels: [{ id: "gateway-five", modalities: allInputs, vision: false }],
      customProviders: [{ id: "api-five-inputs", name: "Five input types", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "custom-five", modalities: allInputs, vision: false }] }],
    };
    const saved = await saveModels(first.server, configured);
    expect(saved.blocks.model.value.gatewayModels?.[0]).toMatchObject({ modalities: allInputs, vision: true });
    expect(saved.blocks.model.value.customProviders[0]?.models[0]).toMatchObject({ modalities: allInputs, vision: true });
    const firstCatalog = await providerModels(first.server);
    expect(firstCatalog.find((provider) => provider.id === "kulo-gateway")?.models.find((model) => model.id === "gateway-five"))
      .toMatchObject({ modalities: allInputs, vision: true });
    expect(firstCatalog.find((provider) => provider.id === "api-five-inputs")?.models[0])
      .toMatchObject({ modalities: allInputs, vision: true });
    await first.server.close(); servers.delete(first.server);
    await first.hub.close(); hubs.delete(first.hub);

    const second = await open(stateDir);
    const restored = await settings(second.server);
    expect(restored.blocks.model.value.gatewayModels?.[0]).toMatchObject({ modalities: allInputs, vision: true });
    expect(restored.blocks.model.value.customProviders[0]?.models[0]).toMatchObject({ modalities: allInputs, vision: true });
    const secondCatalog = await providerModels(second.server);
    expect(secondCatalog.find((provider) => provider.id === "api-five-inputs")?.models[0])
      .toMatchObject({ modalities: allInputs, vision: true });
  });

  it("migrates old vision fields and lets explicit modalities override them without losing audio or PDF", async () => {
    const { server } = await open(stateDirectory(), {
      gatewayModels: [{ id: "old-vision", vision: true }, { id: "old-text", vision: false }],
    });
    const initial = await settings(server);
    expect(initial.blocks.model.value.gatewayModels).toEqual([
      { id: "old-vision", vision: true, modalities: ["text", "image"] },
      { id: "old-text", vision: false, modalities: ["text"] },
    ]);
    const saved = await saveModels(server, { gatewayModels: [
      { id: "audio-pdf", vision: true, modalities: ["audio", "pdf", "audio", "future-input"] },
      { id: "all-five", vision: false, modalities: allInputs },
      { id: "empty", vision: true, modalities: [] },
      { id: "old-vision", vision: true },
      { id: "old-text", vision: false },
    ] });
    expect(saved.blocks.model.value.gatewayModels).toEqual([
      { id: "audio-pdf", vision: false, modalities: ["audio", "pdf"] },
      { id: "all-five", vision: true, modalities: allInputs },
      { id: "empty", vision: false, modalities: ["text"] },
      { id: "old-vision", vision: true, modalities: ["text", "image"] },
      { id: "old-text", vision: false, modalities: ["text"] },
    ]);
    const reloaded = await settings(server);
    expect(reloaded.blocks.model.value.gatewayModels).toEqual(saved.blocks.model.value.gatewayModels);
  });
});
