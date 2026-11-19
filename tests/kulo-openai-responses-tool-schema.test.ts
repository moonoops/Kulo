import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import { createOpenAIModelEntry } from "../packages/hub/src/models.js";
import { KuloProviderManager } from "../packages/hub/src/providers.js";
import type { KuloModelConfig } from "../packages/hub/src/config.js";
import { createOrchestratorToolsExtension, type OrchestratorController } from "../packages/hub/src/tools-router.js";

function dispatchTool() {
  const dispatchTicket = vi.fn(async (_input: unknown) => ({ id: "T-0001" }));
  const extension = createOrchestratorToolsExtension({ dispatchTicket } as unknown as OrchestratorController, [], () => ({ enabled: false }) as never);
  return { tool: extension.tools!.find(tool => tool.name === "kulo_dispatch")!, dispatchTicket };
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function payload(baseUrl: string, registration: "standalone" | "configured-provider") {
  let model = createOpenAIModelEntry("gpt-6.1-sol", baseUrl, "openai-responses", "api-openai");
  let models = createModels();
  if (registration === "configured-provider") {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-openai-tool-schema-"));
    directories.push(directory);
    const manager = new KuloProviderManager({ stateDir: directory });
    const config: KuloModelConfig = {
      baseUrl, apiMode: "openai-responses", defaultProvider: "api-openai", defaultModel: "gpt-6.1-sol", thinkingLevel: "off", contextWindow: 256_000,
      compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 }, gatewayDisabled: true,
      customProviders: [{ id: "api-openai", name: "OpenAI test", api: "openai-responses", baseUrl, models: [{ id: "gpt-6.1-sol", contextWindow: 64_000, maxTokens: 2048, reasoning: false, vision: false }] }],
    };
    manager.syncProviders(config, {});
    await manager.setApiKey("api-openai", "synthetic-tool-schema-test-key");
    models = manager.models;
    model = models.getModel("api-openai", "gpt-6.1-sol")! as typeof model;
    expect(model).toMatchObject({ api: "openai-responses", contextWindow: 64_000, maxTokens: 2048, reasoning: false, input: ["text"] });
  } else {
    models.setProvider(createProvider({ id: model.provider, models: [model], api: openAIResponsesApi(), auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-tool-schema-test-key" } }) } } }));
  }
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response([
      { type: "response.created", response: { id: "response-schema-test" } },
      { type: "response.completed", response: { id: "response-schema-test", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const result = await models.completeSimple(model, { tools: [dispatchTool().tool], messages: [{ role: "user", content: "立即执行一次任务。", timestamp: 1 }] }, { fetch });
  expect(result.stopReason).not.toBe("error");
  expect(requests).toHaveLength(1);
  return { model, body: requests[0]!, tool: (requests[0]!.tools as Array<{ name: string; strict?: boolean; parameters: { required: string[]; properties: Record<string, unknown> } }>).find(tool => tool.name === "kulo_dispatch")! };
}

describe.each(["standalone", "configured-provider"] as const)("official OpenAI Responses optional tool fields through %s registration", registration => {
  it.each(["https://api.openai.com/v1", "https://api.openai.com:443/v1/"])("sends explicit non-strict kulo_dispatch parameters to %s", async baseUrl => {
    const { model, tool } = await payload(baseUrl, registration);
    expect(model.compat).toMatchObject({ supportsStrictMode: true });
    expect(tool.strict).toBe(false);
    expect(tool.parameters.required).toEqual(["command_id", "title", "goal", "scope"]);
    for (const name of ["execute_at", "repeat_every_seconds", "thinking_level"]) {
      expect(tool.parameters.properties).toHaveProperty(name);
      expect(tool.parameters.required).not.toContain(name);
    }
    expect(compile(tool.parameters).check({ command_id: "once", title: "立即执行", goal: "完成一次任务", scope: "任务临时目录" })).toBe(true);
  });

  it.each(["https://gateway.example/v1", "https://api.openai.com.gateway.example/v1", "https://api.openai.com:8443/v1", "http://api.openai.com/v1"])("preserves gateway serialization outside the verified official origin: %s", async baseUrl => {
    const { model, tool } = await payload(baseUrl, registration);
    expect(model.compat).not.toHaveProperty("supportsStrictMode");
    expect(tool).not.toHaveProperty("strict");
  });

  it("accepts an immediate one-shot dispatch without schedule, repetition or thinking overrides", async () => {
    const { tool, dispatchTicket } = dispatchTool();
    const args = { command_id: "once", title: "立即执行", goal: "完成一次任务", scope: "任务临时目录", role: "antigravity", task_kind: "coding", env_id: "local" };
    expect(compile(tool.parameters).check(args)).toBe(true);
    await tool.execute(args as never, { callId: "call-once", conversationId: 1, taskId: 1 } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(dispatchTicket).toHaveBeenCalledTimes(1);
    expect(dispatchTicket.mock.calls[0]![0]).toMatchObject({ executeAt: undefined, repeatEverySeconds: undefined, thinkingLevel: undefined });
  });
});
