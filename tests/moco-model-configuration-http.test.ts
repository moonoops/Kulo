import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startMocoHubServer } from "../packages/hub/src/server";
import { openTestHub } from "./helpers/secure-hub";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider";
import { fetchWithHubAuth, HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";
import type { ModelConfigurationDraft, ModelConfigurationSaveResult, ModelConfigurationWorkspace } from "@moco/protocol";

const cleanups: Array<() => void | Promise<void>> = [];
const secret = "synthetic-local-provider-configuration-key";
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const name of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(realProviders = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-model-configuration-http-"));
  cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "settings-test" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  const hub = await openTestHub({ ...(!realProviders ? { models } : {}), config: { authToken: HUB_TEST_ADMIN_TOKEN, stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "runtime"), enableLocalEnv: false, memory: { enabled: false }, watchdogMinutes: 0, model: { defaultProvider: realProviders ? "" : "openai", defaultModel: realProviders ? "" : "settings-test", thinkingLevel: "off", apiKey: "" } } });
  cleanups.push(() => hub.close());
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 }); cleanups.push(() => server.close());
  const request = async <T>(suffix: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> => {
    const response = await fetchWithHubAuth(`${server.url}/api/settings/model-configuration${suffix}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); expect(JSON.stringify(value)).not.toContain(secret); return value as T;
  };
  return { hub, server, provider, request };
}

describe("model configuration through authenticated Hub", () => {
  it("discovers, securely saves a selected Provider and updates the settings view without overwriting built-ins", async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const upstream = http.createServer((request, response) => {
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-chat", context_length: 32000, max_output_tokens: 4096 }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}/v1`;
    const f = await fixture(true);
    expect((await fetch(`${f.server.url}/api/settings/model-configuration?clientId=http-client`)).status).toBe(401);
    let draft = await f.request<ModelConfigurationDraft>("/prepare", { clientId: "http-client", name: "Local API", api: "openai-completions", baseUrl });
    expect(draft.provider.id).toMatch(/^api-/);
    draft = await f.request<ModelConfigurationDraft>("/credential", { clientId: "http-client", expectedRevision: draft.revision, apiKey: secret });
    draft = await f.request<ModelConfigurationDraft>("/discover", { clientId: "http-client", expectedRevision: draft.revision });
    expect(requests.some((request) => request.url === "/v1/models" && request.authorization === `Bearer ${secret}`)).toBe(true);
    draft = await f.request<ModelConfigurationDraft>("/draft", { clientId: "http-client", expectedRevision: draft.revision, provider: draft.provider, selectedModelIds: ["local-chat"], defaultModelId: "local-chat" }, "PUT");
    const envelope = { clientId: "http-client", expectedRevision: draft.revision, commandId: "http-save-once" };
    const saved = await f.request<ModelConfigurationSaveResult>("/save", envelope);
    const repeated = await f.request<ModelConfigurationSaveResult>("/save", envelope);
    expect(repeated).toEqual(saved);
    expect(saved.settings.blocks.model.value.customProviders?.find((provider) => provider.id === draft.provider.id)?.models.map((model) => model.id)).toEqual(["local-chat"]);
    expect(f.hub.getSettingsView().blocks.model.value.defaultProvider).toBe(draft.provider.id);
    expect(f.hub.getSettingsView().blocks.model.value.defaultModel).toBe("local-chat");
    const catalog = await f.hub.listProviders();
    expect(catalog.find((provider) => provider.id === draft.provider.id)?.authenticated).toBe(true);
    expect(catalog.some((provider) => provider.id === "openai" && provider.builtin)).toBe(true);
    expect((await f.request<ModelConfigurationWorkspace>("?clientId=http-client")).draft).toBeUndefined();
    expect(requests.every((request) => !request.url.includes("chat/completions"))).toBe(true);
  }, 60_000);

  it("registers the model tools in the live settings Agent and prepares its current-window card", async () => {
    const f = await fixture(); let phase = 0;
    const transcripts: string[] = [];
    f.provider.setResponses(Array.from({ length: 5 }, () => (ctx) => {
      transcripts.push(JSON.stringify(ctx)); phase += 1;
      return phase === 1 ? fauxAssistantMessage([fauxToolCall("moco_model_configuration_read", {})], { stopReason: "toolUse" })
        : phase === 2 ? fauxAssistantMessage([fauxToolCall("moco_model_configuration_prepare", { preset: "anthropic" })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxText("供应商配置卡已准备，请在保密卡片提供凭据并选择模型。")]);
    }));
    await f.hub.settingsAssistant.send("帮我接入 Claude API", { module: "models", clientId: "agent-client", appearance: "light", hasUnsavedChanges: false }, "model-prepare-tool-test");
    await vi.waitFor(async () => { expect(phase).toBeGreaterThanOrEqual(3); expect((await f.hub.settingsAssistant.getSnapshot()).live.busy).toBe(false); }, { timeout: 10000, interval: 25 });
    const workspace = await f.request<ModelConfigurationWorkspace>("?clientId=agent-client");
    expect(workspace.draft).toMatchObject({ clientId: "agent-client", provider: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", preset: "anthropic" }, selectedModelIds: [] });
    expect((await f.request<ModelConfigurationWorkspace>("?clientId=other-client")).draft).toBeUndefined();
    expect(transcripts.join("\n")).toContain("moco_model_configuration_prepare");
    expect(transcripts.join("\n")).not.toContain(secret);
    expect(f.hub.getSettingsView().blocks.model.value.customProviders?.some((provider) => provider.id === workspace.draft?.provider.id)).toBe(false);
  });
});
