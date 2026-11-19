import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { openTestHub } from "./helpers/secure-hub";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const name of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(name, "");
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createCalibrationFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-model-calibration-"));
  cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "settings-test" }] });
  const models = createModels();
  models.setProvider(routeSettingsTitleRequests(provider));
  const hub = await openTestHub({
    models,
    config: {
      authToken: HUB_TEST_ADMIN_TOKEN,
      stateDir,
      identityDir: path.join(stateDir, "identity"),
      localEnvRoot: path.join(stateDir, "runtime"),
      enableLocalEnv: false,
      memory: { enabled: false },
      watchdogMinutes: 0,
      model: {
        defaultProvider: "openai",
        defaultModel: "settings-test",
        thinkingLevel: "off",
        apiKey: "",
        customProviders: [
          {
            id: "api-google-vertex",
            name: "Google Vertex AI",
            preset: "google-vertex",
            api: "google-vertex",
            baseUrl: "https://aiplatform.googleapis.com",
            vertexProject: "demo-project",
            vertexLocation: "global",
            models: [
              {
                id: "gemini-4-carbon",
                name: "Gemini 4 Carbon",
                contextWindow: 256_000,
                maxTokens: 64_000,
                reasoning: false,
                thinkingEnabled: false,
                vision: false,
                modalities: ["text"],
              },
            ],
          },
          {
            id: "api-openai",
            name: "OpenAI / Codex",
            preset: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                contextWindow: 256_000,
                maxTokens: 64_000,
                reasoning: false,
                thinkingEnabled: false,
                vision: false,
                modalities: ["text"],
              },
            ],
          },
        ],
      },
    },
  });
  cleanups.push(() => hub.close());
  return { hub, provider };
}

describe("Multi-provider model metadata lookup & atomic calibration", () => {
  it("looks up all configured connections in one tool call and calibrates both connections atomically with full undo support", async () => {
    const f = await createCalibrationFixture();
    // Ensure offline-safe deterministic lookup using bundled snapshot (no external HTTP needed in test).
    vi.spyOn(f.hub, "resolveModelMetadata").mockImplementation(async (req) => {
      if (req.modelId === "gemini-4-carbon") {
        return {
          model: {
            id: "gemini-4-carbon",
            name: "Gemini 4 Carbon",
            api: "google-vertex",
            contextWindow: 1_048_576,
            maxTokens: 65_536,
            reasoning: true,
            thinkingEnabled: true,
            vision: true,
            modalities: ["text", "image", "audio", "video", "pdf"],
            supportedThinkingLevels: ["low", "medium", "high"],
            thinkingLevels: [
              { id: "low", label: "low", value: "low" },
              { id: "medium", label: "medium", value: "medium" },
              { id: "high", label: "high", value: "high" },
            ],
            metadataSource: "models.dev",
          },
          allowedThinkingWireValues: ["off", "minimal", "low", "medium", "high"],
          nativeSearchAllowed: false,
        };
      }
      return {
        model: {
          id: "gpt-5.4",
          name: "GPT-5.4",
          api: "openai-responses",
          contextWindow: 1_050_000,
          maxTokens: 128_000,
          reasoning: true,
          thinkingEnabled: true,
          vision: true,
          modalities: ["text", "image", "pdf"],
          supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
          nativeTools: { webSearch: true },
          metadataSource: "models.dev",
        },
        nativeSearchAllowed: true,
      };
    });

    const toolResults: string[] = [];
    let phase = 0;
    f.provider.setResponses(
      Array.from({ length: 6 }, () => (ctx) => {
        for (const msg of ctx.messages) {
          if (msg.role === "toolResult") {
            toolResults.push(msg.content.map((c) => ("text" in c ? c.text : "")).join(""));
          }
        }
        phase += 1;
        if (phase === 1) {
          return fauxAssistantMessage([fauxToolCall("moco_model_metadata_lookup", {})], { stopReason: "toolUse" });
        }
        if (phase === 2) {
          // Simulate AI first accidentally passing invalid Google wire value "xhigh" -> must be rejected cleanly before mutating!
          return fauxAssistantMessage([
            fauxToolCall("moco_model_calibrate", {
              updates_json: JSON.stringify([
                {
                  providerId: "api-google-vertex",
                  models: [{ id: "gemini-4-carbon", patch: { thinkingLevels: [{ id: "xhigh", label: "xhigh", value: "xhigh" }] } }],
                },
                {
                  providerId: "api-openai",
                  models: [{ id: "gpt-5.4", patch: { contextWindow: 1_050_000 } }],
                },
              ]),
            }),
          ], { stopReason: "toolUse" });
        }
        if (phase === 3) {
          // AI self-corrects based on tool error and atomically calibrates BOTH connections in one call.
          return fauxAssistantMessage([
            fauxToolCall("moco_model_calibrate", {
              updates_json: JSON.stringify([
                {
                  providerId: "api-google-vertex",
                  models: [
                    {
                      id: "gemini-4-carbon",
                      patch: {
                        contextWindow: 1_048_576,
                        maxTokens: 65_536,
                        modalities: ["text", "image", "audio", "video", "pdf"],
                        reasoning: true,
                        thinkingEnabled: true,
                        thinkingLevels: [
                          { id: "low", label: "low", value: "low" },
                          { id: "medium", label: "medium", value: "medium" },
                          { id: "high", label: "high", value: "high" },
                        ],
                      },
                    },
                  ],
                },
                {
                  providerId: "api-openai",
                  models: [
                    {
                      id: "gpt-5.4",
                      patch: {
                        contextWindow: 1_050_000,
                        maxTokens: 128_000,
                        modalities: ["text", "image", "pdf"],
                        reasoning: true,
                        thinkingEnabled: true,
                      },
                    },
                  ],
                },
              ]),
            }),
          ], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText("已为你一次性完成 Google Vertex AI 与 OpenAI 两个连接的模型参数校准。")]);
      }),
    );

    await f.hub.settingsAssistant.send(
      "帮我检查并校准两个 API 里的模型参数",
      { module: "models", clientId: "calibrate-window", appearance: "dark", hasUnsavedChanges: false },
      "calibrate-both-req",
    );

    await vi.waitFor(
      async () => {
        expect(phase).toBeGreaterThanOrEqual(4);
        expect((await f.hub.settingsAssistant.getSnapshot()).live.busy).toBe(false);
      },
      { timeout: 10_000, interval: 25 },
    );

    // Phase 2 invalid Google "xhigh" error was caught and reported back to AI so it self-healed.
    expect(toolResults.join("\n")).toContain("Google API 不支持思考强度映射值「xhigh」");

    // Verify BOTH providers were updated atomically!
    const updatedProviders = f.hub.getSettingsView().blocks.model.value.customProviders ?? [];
    const vertex = updatedProviders.find((p) => p.id === "api-google-vertex");
    const openai = updatedProviders.find((p) => p.id === "api-openai");
    expect(vertex?.models[0]).toMatchObject({
      id: "gemini-4-carbon",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      modalities: ["text", "image", "audio", "video", "pdf"],
      vision: true,
      reasoning: true,
      thinkingEnabled: true,
      thinkingLevels: [
        { id: "low", label: "low", value: "low" },
        { id: "medium", label: "medium", value: "medium" },
        { id: "high", label: "high", value: "high" },
      ],
    });
    expect(openai?.models[0]).toMatchObject({
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      modalities: ["text", "image", "pdf"],
      vision: true,
      reasoning: true,
      thinkingEnabled: true,
    });

    // Verify undo receipt card was emitted with grouped diffs for both connections.
    const snapshot = await f.hub.settingsAssistant.getSnapshot();
    const action = snapshot.actions.find((a) => a.status === "applied" && a.canUndo);
    expect(action).toBeDefined();
    expect(action?.changes.join("\n")).toContain("Google Vertex AI · gemini-4-carbon");
    expect(action?.changes.join("\n")).toContain("OpenAI / Codex · gpt-5.4");

    // Undo cleanly restores BOTH providers to their exact original pre-calibration settings!
    await f.hub.settingsAssistant.decide(action!.id, "undo", "calibrate-window");
    const restoredProviders = f.hub.getSettingsView().blocks.model.value.customProviders ?? [];
    expect(restoredProviders.find((p) => p.id === "api-google-vertex")?.models[0]).toMatchObject({
      contextWindow: 256_000,
      maxTokens: 64_000,
      reasoning: false,
      modalities: ["text"],
    });
    expect(restoredProviders.find((p) => p.id === "api-openai")?.models[0]).toMatchObject({
      contextWindow: 256_000,
      maxTokens: 64_000,
      reasoning: false,
      modalities: ["text"],
    });
  }, 30_000);

  it("blocks disallowed fields (baseUrl/apiKey), unknown models, and Google native webSearch in moco_model_calibrate", async () => {
    const f = await createCalibrationFixture();
    const errors: string[] = [];
    let phase = 0;
    f.provider.setResponses(
      Array.from({ length: 5 }, () => (ctx) => {
        for (const msg of ctx.messages) {
          if (msg.role === "toolResult" && msg.isError) {
            errors.push(msg.content.map((c) => ("text" in c ? c.text : "")).join(""));
          }
        }
        phase += 1;
        if (phase === 1) {
          return fauxAssistantMessage([
            fauxToolCall("moco_model_calibrate", {
              updates_json: JSON.stringify([
                { providerId: "api-openai", models: [{ id: "gpt-5.4", patch: { baseUrl: "https://evil.example" } }] },
              ]),
            }),
          ], { stopReason: "toolUse" });
        }
        if (phase === 2) {
          return fauxAssistantMessage([
            fauxToolCall("moco_model_calibrate", {
              updates_json: JSON.stringify([
                { providerId: "api-google-vertex", models: [{ id: "gemini-4-carbon", patch: { nativeTools: { webSearch: true } } }] },
              ]),
            }),
          ], { stopReason: "toolUse" });
        }
        if (phase === 3) {
          return fauxAssistantMessage([
            fauxToolCall("moco_model_calibrate", {
              updates_json: JSON.stringify([
                { providerId: "api-openai", models: [{ id: "non-existent-model", patch: { contextWindow: 128_000 } }] },
              ]),
            }),
          ], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText("校验拦截均正常。")]);
      }),
    );

    await f.hub.settingsAssistant.send(
      "测试安全边界",
      { module: "models", clientId: "guard-window", appearance: "light", hasUnsavedChanges: false },
      "calibrate-guard-req",
    );

    await vi.waitFor(
      async () => {
        expect(phase).toBeGreaterThanOrEqual(4);
        expect((await f.hub.settingsAssistant.getSnapshot()).live.busy).toBe(false);
      },
      { timeout: 10_000, interval: 25 },
    );

    const allErrors = errors.join("\n");
    expect(allErrors).toContain("不允许修改字段：baseUrl");
    expect(allErrors).toContain("Google API 不支持将原生联网搜索与智能体函数工具同时使用");
    expect(allErrors).toContain("不存在已添加的模型「non-existent-model」");
    // Original settings completely untouched
    expect(f.hub.getSettingsView().blocks.model.value.customProviders?.[0]?.models[0]?.contextWindow).toBe(256_000);
  }, 30_000);
});
