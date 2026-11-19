import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MocoHub } from "../packages/hub/src/hub";
import { MocoProviderManager } from "../packages/hub/src/providers";
import { resolveModelThinkingSelection, withThinkingLevelModels } from "../packages/hub/src/models";
import type { MocoModelConfig } from "../packages/hub/src/config";
import type { ThinkingLevelOption } from "@moco/protocol";

const dirs: string[] = [];
const servers: http.Server[] = [];
const hubs: MocoHub[] = [];
const providerId = "api-thinking-test";
const modelId = "local-thinking-model";
const levels: ThinkingLevelOption[] = [
  { id: "off", label: "关闭", value: "off" },
  { id: "custom-balanced", label: "平衡", value: "low" },
  { id: "custom-deep", label: "深入推理", value: "xhigh" },
];

function stateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-thinking-"));
  dirs.push(dir);
  return dir;
}

async function endpoint() {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({
        id: "local-thinking", object: "chat.completion.chunk", created: 0, model: modelId,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: "local-thinking", object: "chat.completion.chunk", created: 0, model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })}`,
      "data: [DONE]", "",
    ].join("\n\n"));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests };
}

async function nativeRequestCapture() {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (body) requests.push(JSON.parse(body));
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Local request-body capture", code: 400, status: "INVALID_ARGUMENT", type: "invalid_request_error" } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

function config(baseUrl: string): MocoModelConfig {
  return {
    baseUrl, apiMode: "openai-completions", defaultProvider: providerId,
    defaultModel: modelId, thinkingLevel: "custom-deep", contextWindow: 256_000,
    compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 },
    gatewayDisabled: true,
    customProviders: [{
      id: providerId, name: "Local thinking", api: "openai-completions", baseUrl,
      models: [{ id: modelId, reasoning: true, thinkingLevels: levels }],
    }],
  };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("custom thinking strength levels", () => {
  it.each([
    ["openai-responses", "gpt-5"],
    ["google-generative-ai", "gemini-2.5-flash"],
    ["anthropic-messages", "claude-sonnet-4"],
  ] as const)("sends explicit native off for %s both for the off level and the master switch", async (api, nativeModelId) => {
    const capture = await nativeRequestCapture();
    const modelConfig = config(capture.baseUrl);
    modelConfig.defaultModel = nativeModelId;
    modelConfig.customProviders[0] = {
      ...modelConfig.customProviders[0]!, api,
      models: [{ id: nativeModelId, reasoning: true, thinkingEnabled: true,
        thinkingLevelMap: { off: "low" }, thinkingLevels: levels }],
    };
    const manager = new MocoProviderManager({ stateDir: stateDir() });
    manager.syncProviders(modelConfig, {});
    await manager.setApiKey(providerId, "local-thinking-test-key");
    const models = withThinkingLevelModels(manager.models);
    for (const disabled of [false, true]) {
      modelConfig.customProviders[0]!.models[0]!.thinkingEnabled = !disabled;
      manager.syncProviders(modelConfig, {});
      const selected = resolveModelThinkingSelection(models, providerId, nativeModelId, disabled ? "custom-deep" : "off", modelConfig);
      expect(selected.thinkingLevel).toBe("off");
      const clone = models.getModel(providerId, selected.model.modelId)!;
      expect(clone.reasoning).toBe(true);
      await models.completeSimple(clone, {
        messages: [{ role: "user", content: "capture disabled request", timestamp: Date.now() }],
      }, { maxRetries: 0, signal: AbortSignal.timeout(3_000) });
    }
    expect(capture.requests).toHaveLength(2);
    for (const request of capture.requests) {
      if (api === "openai-responses") expect(request.reasoning).toMatchObject({ effort: "none" });
      else if (api === "google-generative-ai") expect(request.generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 0 } });
      else expect(request.thinking).toEqual({ type: "disabled" });
    }
    expect(manager.models.getModel(providerId, nativeModelId)!.thinkingLevelMap?.off).toBe("low");
  });

  it("uses distinct native Anthropic budgets for mapped low and high strengths", async () => {
    const capture = await nativeRequestCapture();
    const modelConfig = config(capture.baseUrl);
    const nativeId = "claude-sonnet-4";
    modelConfig.customProviders[0] = {
      ...modelConfig.customProviders[0]!, api: "anthropic-messages",
      models: [{ id: nativeId, reasoning: true, thinkingEnabled: true, thinkingLevels: [
        { id: "custom-low", label: "轻量", value: "low" },
        { id: "custom-high", label: "深入", value: "high" },
      ] }],
    };
    const manager = new MocoProviderManager({ stateDir: stateDir() });
    manager.syncProviders(modelConfig, {});
    await manager.setApiKey(providerId, "local-thinking-test-key");
    const models = withThinkingLevelModels(manager.models);
    for (const level of ["custom-low", "custom-high"]) {
      const selected = resolveModelThinkingSelection(models, providerId, nativeId, level, modelConfig);
      await models.completeSimple(models.getModel(providerId, selected.model.modelId)!, {
        messages: [{ role: "user", content: "capture budget", timestamp: Date.now() }],
      }, { reasoning: selected.thinkingLevel, maxRetries: 0, signal: AbortSignal.timeout(3_000) });
    }
    const low = capture.requests[0]!.thinking as { type: string; budget_tokens: number };
    const high = capture.requests[1]!.thinking as { type: string; budget_tokens: number };
    expect(low.type).toBe("enabled");
    expect(high.type).toBe("enabled");
    expect(high.budget_tokens).toBeGreaterThan(low.budget_tokens);
  });

  it("normalizes deleted selected levels in defaults and roles and advances affected role revisions", async () => {
    const api = await endpoint();
    const hub = await openTestHub({ config: { stateDir: stateDir(), enableLocalEnv: false, model: config(api.baseUrl) } });
    hubs.push(hub);
    const before = hub.getSettingsView();
    const architect = before.blocks.roles.value.architect!;
    await hub.updateSettingsBlock("roles", before.blocks.roles.revision, {
      ...before.blocks.roles.value,
      architect: { ...architect, provider: providerId, modelId, thinkingLevel: "custom-deep" },
    });
    const original = hub.getSettingsView();
    const remaining = levels.filter((level) => level.id !== "custom-deep");
    const updated = await hub.updateSettingsBlock("model", original.blocks.model.revision, {
      ...original.blocks.model.value,
      customProviders: [{
        ...original.blocks.model.value.customProviders![0],
        models: [{ id: modelId, reasoning: true, thinkingLevels: remaining }],
      }],
    });
    expect(updated.settings.blocks.model.value.thinkingLevel).toBe("off");
    expect(updated.settings.blocks.roles.value.architect!.thinkingLevel).toBe("auto");
    expect(updated.settings.blocks.roles.revision).toBe(original.blocks.roles.revision + 1);
    await expect(hub.updateSettingsBlock("roles", original.blocks.roles.revision, original.blocks.roles.value))
      .rejects.toMatchObject({ status: 409 });

    const next = updated.settings.blocks.model;
    const withoutOff = await hub.updateSettingsBlock("model", next.revision, {
      ...next.value, thinkingLevel: "custom-deep",
      customProviders: [{
        ...next.value.customProviders![0],
        models: [{ id: modelId, reasoning: true, thinkingLevels: [levels[1]!] }],
      }],
    });
    expect(withoutOff.settings.blocks.model.value.thinkingLevel).toBe("custom-balanced");
    const current = withoutOff.settings.blocks.model;
    const disabled = await hub.updateSettingsBlock("model", current.revision, {
      ...current.value,
      customProviders: [{ ...current.value.customProviders![0], models: [{ id: modelId, reasoning: true, thinkingEnabled: false, thinkingLevels: levels }] }],
    });
    expect(disabled.settings.blocks.model.value.thinkingLevel).toBe("off");
    const disabledCatalog = (await hub.listProviders()).find((provider) => provider.id === providerId)!.models[0]!;
    expect(disabledCatalog.reasoning).toBe(true);
    expect(disabledCatalog.thinkingEnabled).toBe(false);
    expect(disabledCatalog.supportedThinkingLevels).toEqual(["off"]);
  });

  it("preserves labels, values and the selected custom id across save and restart", async () => {
    const api = await endpoint();
    const dir = stateDir();
    const first = await openTestHub({ config: { stateDir: dir, enableLocalEnv: false, model: config(api.baseUrl) } });
    const initial = first.getSettingsView();
    const changed = [
      ...levels,
      { id: "custom-verification", label: "交叉验证", value: "high" },
    ];
    await first.updateSettingsBlock("model", initial.blocks.model.revision, {
      ...initial.blocks.model.value, thinkingLevel: "custom-verification",
      customProviders: [{
        ...initial.blocks.model.value.customProviders![0],
        models: [{ id: modelId, reasoning: true, thinkingLevels: changed }],
      }],
    });
    await first.close();
    const reopened = await openTestHub({ config: { stateDir: dir, enableLocalEnv: false } });
    hubs.push(reopened);
    const restored = reopened.getSettingsView().blocks.model.value;
    expect(restored.thinkingLevel).toBe("custom-verification");
    expect(restored.customProviders![0]!.models[0]!.thinkingLevels).toEqual(changed);
    const catalog = (await reopened.listProviders()).find((provider) => provider.id === providerId)!;
    expect(catalog.models[0]!.thinkingLevels).toEqual(changed);
    expect(catalog.models[0]!.supportedThinkingLevels).toEqual(changed.map((level) => level.id));
  });

  it("sends independent mapped values concurrently and keeps real model ids on the wire and in results", async () => {
    const api = await endpoint();
    const modelConfig = config(api.baseUrl);
    const manager = new MocoProviderManager({ stateDir: stateDir() });
    manager.syncProviders(modelConfig, {});
    await manager.setApiKey(providerId, "local-thinking-test-key");
    const models = withThinkingLevelModels(manager.models);
    const original = manager.models.getModel(providerId, modelId)!;
    const selections = ["custom-balanced", "custom-deep", "off"].map((level) =>
      resolveModelThinkingSelection(models, providerId, modelId, level, modelConfig));
    const results = await Promise.all(selections.map((selected) => models.completeSimple(
      models.getModel(selected.model.provider, selected.model.modelId)!,
      { messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
      { reasoning: selected.thinkingLevel, signal: AbortSignal.timeout(3_000) },
    )));
    expect(api.requests.map((request) => request.reasoning_effort).sort()).toEqual(["low", "xhigh", "none"].sort());
    expect(api.requests.every((request) => request.model === modelId)).toBe(true);
    expect(results.every((result) => result.model === modelId && result.stopReason === "stop")).toBe(true);
    expect(manager.models.getModel(providerId, modelId)).toBe(original);
    expect(original.thinkingLevelMap).toBeUndefined();
    expect(models.getModels(providerId).map((model) => model.id)).toEqual([modelId]);
  });

  it("honors the reasoning switch and legacy thinkingLevelMap configurations", async () => {
    const api = await endpoint();
    const manager = new MocoProviderManager({ stateDir: stateDir() });
    const disabled = config(api.baseUrl);
    disabled.customProviders[0]!.models[0]!.reasoning = false;
    manager.syncProviders(disabled, {});
    await manager.setApiKey(providerId, "local-thinking-test-key");
    const models = withThinkingLevelModels(manager.models);
    const selected = resolveModelThinkingSelection(models, providerId, modelId, "custom-deep", disabled);
    expect(selected.thinkingLevel).toBe("off");
    await models.completeSimple(models.getModel(providerId, selected.model.modelId)!, {
      messages: [{ role: "user", content: "off", timestamp: Date.now() }],
    }, { reasoning: selected.thinkingLevel });
    expect(api.requests[0]!.reasoning_effort).toBeUndefined();

    const legacy = config(api.baseUrl);
    legacy.customProviders[0]!.models = [{ id: modelId, reasoning: true, thinkingLevelMap: { medium: "high" } }];
    manager.syncProviders(legacy, {});
    const old = resolveModelThinkingSelection(models, providerId, modelId, "medium", legacy);
    expect(old.model.modelId).toBe(modelId);
    expect(old.thinkingLevel).toBe("medium");
    await models.completeSimple(models.getModel(providerId, old.model.modelId)!, {
      messages: [{ role: "user", content: "legacy", timestamp: Date.now() }],
    }, { reasoning: old.thinkingLevel });
    expect(api.requests[1]!.reasoning_effort).toBe("high");
  });

  it("validates names, duplicate ids and unsupported native Google mappings without silently changing them", async () => {
    const api = await endpoint();
    const hub = await openTestHub({ config: { stateDir: stateDir(), enableLocalEnv: false, model: config(api.baseUrl) } });
    hubs.push(hub);
    const initial = hub.getSettingsView().blocks.model;
    for (const invalid of [
      [{ id: "custom-x", label: "", value: "high" }],
      [{ id: "custom-x", label: "A", value: "" }],
      [{ id: "same", label: "A", value: "high" }, { id: "same", label: "B", value: "low" }],
      [{ id: "first", label: "A", value: "high" }, { id: "second", label: "A", value: "low" }],
    ]) {
      await expect(hub.updateSettingsBlock("model", initial.revision, {
        ...initial.value,
        customProviders: [{ ...initial.value.customProviders![0], models: [{ id: modelId, thinkingLevels: invalid }] }],
      })).rejects.toMatchObject({ status: 400 });
    }
    await expect(hub.updateSettingsBlock("model", initial.revision, {
      ...initial.value,
      customProviders: [{
        ...initial.value.customProviders![0], api: "google-generative-ai",
        models: [{ id: modelId, thinkingLevels: [{ id: "xhigh", label: "超高", value: "xhigh" }] }],
      }],
    })).rejects.toThrow("Google API 不支持");
    await expect(hub.updateSettingsBlock("model", initial.revision, {
      ...initial.value,
      customProviders: [{ ...initial.value.customProviders![0], api: "anthropic-messages",
        models: [{ id: modelId, thinkingLevels: [{ id: "custom-ultra", label: "极深", value: "ultra" }] }] }],
    })).rejects.toThrow("此 API 不支持");
    await expect(hub.updateSettingsBlock("model", initial.revision, {
      ...initial.value,
      customProviders: [{ ...initial.value.customProviders![0], models: [{
        id: modelId, reasoning: true, thinkingEnabled: false,
        thinkingLevelMap: { off: null }, thinkingLevels: levels.filter((level) => level.value !== "off"),
      }] }],
    })).rejects.toThrow("不支持关闭思考");
    expect(hub.getSettingsView().blocks.model.revision).toBe(initial.revision);
    const legacyNonReasoning = await hub.updateSettingsBlock("model", initial.revision, {
      ...initial.value,
      customProviders: [{ ...initial.value.customProviders![0], models: [{
        id: modelId, reasoning: false, thinkingEnabled: false, thinkingLevelMap: { off: null },
      }] }],
    });
    expect(legacyNonReasoning.settings.blocks.model.value.thinkingLevel).toBe("off");
  });

  it("uses the mapped strength in a real Hub turn without exposing internal references in chat or usage", async () => {
    const api = await endpoint();
    const hub = await openTestHub({ config: {
      stateDir: stateDir(), enableLocalEnv: true, watchdogMinutes: 0, model: config(api.baseUrl),
      memory: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], routerApiKey: "", workerApiKey: "", routerApiKeyEnv: "", workerApiKeyEnv: "",
        authFile: "", caCertPem: "", autoAttachTopLevelRouters: false, banks: { private: "test", shared: "shared" } },
    } });
    hubs.push(hub);
    await hub.setProviderApiKey(providerId, "local-thinking-test-key");
    await hub.sendUserMessage("用一句话回复");
    await expect.poll(async () => (await hub.getTopicView()).live.busy, { timeout: 5_000 }).toBe(false);
    const view = await hub.getTopicView();
    expect(view.live.runFailure).toBeUndefined();
    expect(api.requests[0]!.reasoning_effort).toBe("xhigh");
    expect(JSON.stringify(view)).not.toContain("moco-thinking:");
    const usage = await hub.computeUsageStats("today");
    expect(usage.models.map((model) => model.model)).toEqual([modelId]);
  });
});
