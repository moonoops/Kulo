import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomModelConfig } from "@kulo/protocol";
import { resolveHubConfig, type KuloHubConfig, type KuloModelConfig } from "../packages/hub/src/config";
import { resolveModelThinkingSelection, withThinkingLevelModels } from "../packages/hub/src/models";
import { KuloProviderManager } from "../packages/hub/src/providers";
import {
  applySettingsBlockUpdate,
  hydrateSettingsFromConfig,
  rollbackSettingsToSnapshot,
  toPublicSettingsView,
  type KuloDurableSettings,
} from "../packages/hub/src/settings";

const subscriptionModels = {
  "openai-codex": [{ id: "manual-codex", name: "Manual Codex", reasoning: true }],
  anthropic: [{ id: "manual-claude", modalities: ["text", "image"] }],
} satisfies Record<string, CustomModelConfig[]>;
const directories: string[] = [];

function modelConfig(): KuloModelConfig {
  return {
    baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-responses", apiKey: "synthetic-settings-key",
    defaultProvider: "api-existing", defaultModel: "already-configured", thinkingLevel: "medium", contextWindow: 100_000,
    compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 },
    gatewayDisabled: true, customProviders: [{ id: "api-existing", name: "Existing", api: "openai-responses",
      baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "already-configured" }] }],
  };
}

function settings(): KuloDurableSettings {
  return {
    initialized: true, rolesMigratedV2: true, rolesMigratedV3: true, globalRevision: 1,
    revisions: { presentation: 1, executor: 1, roles: 1, model: 1, identity: 1, memory: 1 },
    presentation: { agentName: "Kulo", workbenchName: "Table" },
    executor: { maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1, paused: false, watchdogMinutes: 0 },
    roles: {}, model: modelConfig(), identity: { directory: "", directoryRevision: 1 },
    memory: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "",
      routerApiKeyEnv: "KULO_TEST_MEMORY_KEY", workerApiKeyEnv: "KULO_TEST_WORKER_MEMORY_KEY", authFile: "", autoAttachTopLevelRouters: false,
      banks: { private: "test-private", shared: "test-shared" } },
    expression: null, snapshots: [],
  };
}

function hubConfig(doc: KuloDurableSettings): KuloHubConfig {
  return {
    stateDir: "/tmp/kulo-subscription-config-test", identityDir: "/tmp/kulo-subscription-config-test/identity", host: "127.0.0.1", port: 0,
    envTokens: {}, workerEnvIds: [], enableLocalEnv: false, maxConcurrentWorkers: 1, maxSubagentsPerTicket: 1,
    watchdogMinutes: 0, model: { ...modelConfig(), subscriptionModels }, roles: {}, memory: doc.memory, presentation: doc.presentation,
  };
}

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  vi.stubEnv("KULO_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("explicit OAuth subscription model configuration", () => {
  it("keeps subscription overrides in runtime configuration and initial settings hydration", () => {
    const resolved = resolveHubConfig({ model: { apiKey: "", subscriptionModels } });
    expect(resolved.model.subscriptionModels).toEqual(subscriptionModels);
    const doc = settings();
    doc.initialized = false;
    hydrateSettingsFromConfig(doc, hubConfig(doc));
    expect(doc.model.subscriptionModels).toMatchObject(subscriptionModels);
    const publicModel = toPublicSettingsView(doc, "/tmp/identity").blocks.model.value;
    expect(publicModel.subscriptionModels).toMatchObject(subscriptionModels);
    expect(publicModel).not.toHaveProperty("apiKey");
  });

  it("saves explicit model parameters without changing the current provider, model, API connections or key", () => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels: {
      "openai-codex": [{ id: "  manually-added  ", name: "  Manual  ", contextWindow: 256_000, maxTokens: 16_000, reasoning: true,
        thinkingLevels: [{ id: "custom-deep", label: "深入", value: "xhigh" }], unknown: "discarded" }],
    } });
    expect(doc.model).toMatchObject({ defaultProvider: "api-existing", defaultModel: "already-configured", apiKey: "synthetic-settings-key",
      customProviders: modelConfig().customProviders,
      subscriptionModels: { "openai-codex": [{ id: "manually-added", name: "Manual", contextWindow: 256_000, maxTokens: 16_000,
        thinkingLevels: [{ id: "custom-deep", label: "深入", value: "xhigh" }] }] } });
    expect(doc.model.subscriptionModels!["openai-codex"][0]).not.toHaveProperty("unknown");
    applySettingsBlockUpdate(doc, "model", 2, { thinkingLevel: "high" });
    expect(doc.model.subscriptionModels!["openai-codex"][0].id).toBe("manually-added");
  });

  it("saves native OpenRouter aliases and preserves their IDs and wire protocols at runtime", () => {
    const aliases = builtinProviders().find((provider) => provider.id === "openrouter")!.getModels().filter((model) => model.id.startsWith("~"));
    expect(aliases.map((model) => model.id)).toEqual(expect.arrayContaining(["~anthropic/claude-sonnet-latest", "~google/gemini-pro-latest"]));
    const doc = settings();
    doc.model.defaultProvider = "openrouter";
    doc.model.defaultModel = aliases[0].id;
    applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels: { openrouter: aliases.map((model) => ({ id: model.id })) } });
    expect(toPublicSettingsView(doc, "/tmp/identity").blocks.model.value.subscriptionModels?.openrouter.map((model) => model.id)).toEqual(aliases.map((model) => model.id));
    expect(doc.model.defaultModel).toBe(aliases[0].id);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-subscription-alias-"));
    directories.push(directory);
    const manager = new KuloProviderManager({ stateDir: directory });
    manager.syncProviders({ ...modelConfig(), subscriptionModels: doc.model.subscriptionModels }, {});
    for (const alias of aliases) {
      expect(manager.models.getModel("openrouter", alias.id)).toMatchObject({ id: alias.id, api: alias.api, baseUrl: alias.baseUrl });
    }
  });

  it("preserves the mapping through persisted reloads, public projection and settings rollback", () => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels });
    const reloaded: KuloDurableSettings = JSON.parse(JSON.stringify(doc));
    const config = hubConfig(reloaded);
    config.model.subscriptionModels = { "openai-codex": [{ id: "startup-must-not-overwrite" }] };
    hydrateSettingsFromConfig(reloaded, config);
    expect(toPublicSettingsView(reloaded, "/tmp/identity").blocks.model.value.subscriptionModels).toMatchObject(subscriptionModels);
    applySettingsBlockUpdate(reloaded, "model", 2, { subscriptionModels: {} });
    expect(reloaded.model.subscriptionModels).toEqual({});
    rollbackSettingsToSnapshot(reloaded, reloaded.globalRevision, reloaded.globalRevision);
    expect(reloaded.model.subscriptionModels).toMatchObject(subscriptionModels);
  });

  it.each([
    null, [], "invalid", { "api-existing": [] }, { "google-vertex": [] }, { unknown: [] },
    JSON.parse('{"__proto__":[]}'), { constructor: [] }, { "openai-codex": null },
    { "openai-codex": [null] }, { "openai-codex": [{ id: 7 }] }, { "openai-codex": [{ id: "" }] },
    { "openai-codex": [{ id: "bad model" }] }, { "openai-codex": [{ id: "../model" }] },
    { "openai-codex": [{ id: "model?key=value" }] }, { "openai-codex": [{ id: "bad\nmodel" }] },
    { "openai-codex": [{ id: "same" }, { id: " same " }] },
    { "github-copilot": [{ id: "unknown-future-model" }] },
  ])("rejects invalid subscription groups without changing settings: %j", (invalid) => {
    const doc = settings();
    const before = JSON.stringify(doc);
    expect(() => applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels: invalid })).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("applies subscription thinking choices to durable model references", () => {
    const registry = createModels();
    registry.setProvider(fauxProvider({ provider: "openai-codex", models: [{ id: "manual-codex", reasoning: true }] }).provider);
    const config: KuloModelConfig = { ...modelConfig(), subscriptionModels: { "openai-codex": [{ id: "manual-codex", reasoning: true,
      thinkingLevels: [{ id: "careful", label: "深入", value: "xhigh" }] }] } };
    const choice = resolveModelThinkingSelection(registry, "openai-codex", "manual-codex", "careful", config);
    expect(choice.thinkingLevel).toBe("xhigh");
    expect(withThinkingLevelModels(registry).getModel("openai-codex", choice.model.modelId)?.thinkingLevelMap?.xhigh).toBe("xhigh");
    config.subscriptionModels!["openai-codex"][0].thinkingEnabled = false;
    const disabled = resolveModelThinkingSelection(registry, "openai-codex", "manual-codex", "careful", config);
    expect(disabled.thinkingLevel).toBe("off");
    expect(withThinkingLevelModels(registry).getModel("openai-codex", disabled.model.modelId)?.thinkingLevelMap?.off).toBe("off");
  });

  it.each([false, true])("removes native forbidden thinking choices and retains a legal runtime choice (only off: %s)", (onlyOff) => {
    const native = builtinProviders().find((provider) => provider.id === "anthropic")!.getModels().find((model) => model.id === "claude-fable-5")!;
    expect(native.thinkingLevelMap?.off).toBeNull();
    const values = onlyOff ? ["off"] : ["off", "low", "medium", "high", "xhigh"];
    const doc = settings();
    applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels: { anthropic: [{ id: native.id, reasoning: true, thinkingEnabled: true,
      thinkingLevelMap: { off: "off" }, thinkingLevels: values.map((value) => ({ id: value, label: value, value })) }] } });
    const saved = toPublicSettingsView(doc, "/tmp/identity").blocks.model.value.subscriptionModels!.anthropic[0];
    expect(saved.thinkingLevelMap?.off).toBeNull();
    expect(saved.thinkingLevels!.length).toBeGreaterThan(0);
    expect(saved.thinkingLevels!.some((level) => level.id === "off" || level.value === "off")).toBe(false);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-subscription-thinking-"));
    directories.push(directory);
    const manager = new KuloProviderManager({ stateDir: directory });
    const config = { ...modelConfig(), subscriptionModels: doc.model.subscriptionModels };
    manager.syncProviders(config, {});
    const choice = resolveModelThinkingSelection(manager.models, "anthropic", native.id, "off", config);
    expect(choice.thinkingLevel).not.toBe("off");
    expect(withThinkingLevelModels(manager.models).getModel("anthropic", choice.model.modelId)).toMatchObject({ id: native.id });
  });

  it.each([{ thinkingEnabled: false }, { reasoning: false }])("rejects disabling reasoning that the native subscription requires: %j", (patch) => {
    const doc = settings();
    expect(() => applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels: { anthropic: [{ id: "claude-fable-5", ...patch }] } }))
      .toThrow("不支持关闭思考");
    expect(doc.model.subscriptionModels).toBeUndefined();
  });

  it("keeps off available for a native subscription model that supports disabling thinking", () => {
    const native = builtinProviders().find((provider) => provider.id === "anthropic")!.getModels().find((model) => model.reasoning && model.thinkingLevelMap?.off !== null)!;
    expect(native).toBeDefined();
    const doc = settings();
    applySettingsBlockUpdate(doc, "model", 1, { subscriptionModels: { anthropic: [{ id: native.id, thinkingEnabled: false,
      thinkingLevels: [{ id: "off", label: "off", value: "off" }, { id: "low", label: "low", value: "low" }] }] } });
    const saved = doc.model.subscriptionModels!.anthropic[0];
    expect(saved.thinkingEnabled).toBe(false);
    expect(saved.thinkingLevels!.map((level) => level.value)).toEqual(["off", "low"]);
  });

  it("does not treat inherited object properties as subscription model lists", () => {
    const doc = settings();
    expect(() => applySettingsBlockUpdate(doc, "model", 1, { defaultProvider: "constructor", defaultModel: "unknown", subscriptionModels: {} })).not.toThrow();
    const config = { ...modelConfig(), subscriptionModels: {} };
    expect(() => resolveModelThinkingSelection(createModels(), "constructor", "unknown", "off", config)).not.toThrow();
  });
});
