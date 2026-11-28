import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import {
  describeKuloError,
  type ExternalAgentRequest,
  type ExternalAgentResponse,
  type ExternalAgentRun,
  type TicketRecord,
} from "@kulo/protocol";
import {
  KuloStateDoc,
  classifyQuotaPauseFromExternalFailure,
  classifyQuotaPauseFromUnanswered,
  downgradeQuotaWaitingToUser,
  resolveWorkerEffectiveModel,
  sanitizeTicketQuotaText,
  startKuloHubServer,
  type KuloHub,
  type KuloHubConfigOverrides,
} from "@kulo/hub";
import { prepareNativeReplay, nativeContentHash, type NativeContentEnvelope, type NativeContentMessage } from "../packages/hub/src/model-native-replay.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { toTicketCardView } from "../packages/hub/src/ticket-card-view.js";
import { TicketReconciler } from "../packages/hub/src/ticket-reconciler.js";
import { taskNeedsAttention, taskStatusLabel } from "../packages/web/src/features/tasks/task-model.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeHubConfig(rootDir: string, overrides: KuloHubConfigOverrides = {}): KuloHubConfigOverrides {
  return {
    stateDir: path.join(rootDir, "hub-state"),
    localEnvRoot: path.join(rootDir, "local-runtime"),
    identityDir: path.join(rootDir, "private-identity"),
    authToken: HUB_TEST_ADMIN_TOKEN,
    maxConcurrentWorkers: 2,
    watchdogMinutes: 0,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: {
      baseUrl: "https://api.openai.com/v1",
      apiMode: "openai-completions",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      thinkingLevel: "off",
      customProviders: [
        {
          id: "anthropic-cloud",
          name: "Anthropic Cloud",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          models: [{ id: "claude-sonnet-4" }, { id: "claude-opus-4" }],
        },
        {
          id: "local-ollama",
          name: "Local Ollama",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: [{ id: "qwen2.5-coder:32b" }],
        },
      ],
    },
    ...overrides,
  };
}

function toolTurn(...calls: ReturnType<typeof fauxToolCall>[]) {
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

function createMultiProviderFauxModels(
  handlers: Record<
    string,
    (
      request: TranscriptContext,
      modelId: string,
    ) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>
  >,
) {
  const models = createModels();
  const makeResponses = (providerId: string, modelIds: string[]) => {
    const expectedBaseUrl =
      providerId === "local-ollama"
        ? "http://127.0.0.1:11434/v1"
        : providerId === "anthropic-cloud"
          ? "https://api.anthropic.com/v1"
          : "https://api.openai.com/v1";
    const faux = fauxProvider({
      provider: providerId,
      models: modelIds.map((id) => ({ id })),
    });
    faux.setResponses(
      Array.from({ length: 64 }, () => (req: TranscriptContext) => {
        const handler = handlers[providerId] ?? handlers.default!;
        const modelId = modelIds[0]!;
        return handler(req, modelId);
      }),
    );
    models.setProvider(faux.provider);
    for (const id of modelIds) {
      const registered = models.getModel(providerId, id);
      if (registered) (registered as { baseUrl: string }).baseUrl = expectedBaseUrl;
    }
  };
  makeResponses("openai", ["gpt-4o", "gpt-4o-mini"]);
  makeResponses("anthropic-cloud", ["claude-sonnet-4", "claude-opus-4"]);
  makeResponses("local-ollama", ["qwen2.5-coder:32b"]);
  return models;
}

async function httpPostJson(
  url: string,
  body: Record<string, unknown>,
  token = HUB_TEST_ADMIN_TOKEN,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
          origin: parsed.origin,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) as Record<string, unknown> });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: { raw: text } });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Stage 2 P0-3: 429 subscription & quota error classification", () => {
  it.each([
    ["429 subscription_sharing_usage_limit_exceeded", '429 {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached"}}'],
    ["429 usage_limit_reached", '429 {"error":{"type":"usage_limit_reached","message":"Weekly usage limit reached"}}'],
    ["GoUsageLimitError", '429 {"error":{"type":"GoUsageLimitError","message":"Plan limit reached"}}'],
    ["FreeUsageLimitError", '429 {"error":{"type":"FreeUsageLimitError","message":"Free tier exhausted"}}'],
    ["Monthly usage limit reached", "429 Monthly usage limit reached for your subscription"],
    ["out of budget", "429 Workspace is out of budget"],
    ["specified API usage limits", "429 You have reached your specified API usage limits. You will regain access on 2026-12-01."],
    ['Zhipu code 1308', '429 {"error":{"code":"1308","message":"Rate limit reached for plan"}}'],
  ])("classifies %s as kind='quota'", (_label, detail) => {
    const desc = describeKuloError({ reason: "model_error", detail });
    expect(desc.kind).toBe("quota");
  });

  it("keeps ordinary 429 transient throttling as kind='rate_limit'", () => {
    const desc = describeKuloError({
      reason: "model_error",
      detail: '429 {"error":{"type":"rate_limit_error","message":"Too many requests per minute"}}',
    });
    expect(desc.kind).toBe("rate_limit");
  });
});

describe("Stage 2 §2.4: Single Worker Model Arbiter precedence", () => {
  const defaultModel = { provider: "openai", modelId: "gpt-4o-mini", thinkingLevel: "low" as const };
  const rolePreset = { provider: "openai", modelId: "gpt-4o", thinkingLevel: "medium" as const };

  it("enforces user_override > active escalation (matching runEpoch) > role_preset > default", () => {
    const overrideWins = resolveWorkerEffectiveModel({
      ticket: {
        providerOverride: "anthropic-cloud",
        modelOverride: "claude-opus-4",
        thinkingOverride: "high",
        runEpoch: 2,
        modelEscalation: {
          runEpoch: 2,
          activatedAtTurn: 5,
          escalatedModel: { provider: "openai", modelId: "o3", thinkingLevel: "xhigh" },
          reason: "doom_loop",
        },
      },
      rolePreset,
      defaultModel,
    });
    expect(overrideWins).toEqual({
      provider: "anthropic-cloud",
      modelId: "claude-opus-4",
      thinkingLevel: "high",
      explicitThinking: true,
      source: "user_override",
    });

    const activeEscalation = resolveWorkerEffectiveModel({
      ticket: {
        runEpoch: 2,
        modelEscalation: {
          runEpoch: 2,
          activatedAtTurn: 5,
          escalatedModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", thinkingLevel: "high" },
          reason: "doom_loop",
        },
      },
      rolePreset,
      defaultModel,
    });
    expect(activeEscalation).toEqual({
      provider: "anthropic-cloud",
      modelId: "claude-opus-4",
      thinkingLevel: "high",
      explicitThinking: true,
      source: "escalation",
    });

    // Stale escalation bound to an older runEpoch must NOT override rolePreset
    const staleEscalation = resolveWorkerEffectiveModel({
      ticket: {
        runEpoch: 3,
        modelEscalation: {
          runEpoch: 2,
          activatedAtTurn: 5,
          escalatedModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
          reason: "old epoch",
        },
      },
      rolePreset,
      defaultModel,
    });
    expect(staleEscalation).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "medium",
      explicitThinking: true,
      source: "role_preset",
    });

    const fallbackDefault = resolveWorkerEffectiveModel({
      ticket: { runEpoch: 1 },
      rolePreset: { thinkingLevel: "auto" },
      defaultModel,
    });
    expect(fallbackDefault).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
      thinkingLevel: "low",
      explicitThinking: false,
      source: "default",
    });
  });
});

describe("Stage 2 §4.1: Native pi-ai transformMessages & model-native-replay 6-way cross-model replay", () => {
  const modelsByVendor: Record<"openai" | "anthropic" | "google", Model<Api>> = {
    openai: {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    },
    anthropic: {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    },
    google: {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 16_384,
    },
  };

  const pairs: Array<["openai" | "anthropic" | "google", "openai" | "anthropic" | "google"]> = [
    ["openai", "anthropic"],
    ["openai", "google"],
    ["anthropic", "openai"],
    ["anthropic", "google"],
    ["google", "openai"],
    ["google", "anthropic"],
  ];

  it.each(pairs)(
    "drops foreign thinking/signatures and normalizes toolCallId cleanly across %s -> %s",
    (fromKey, toKey) => {
      const fromModel = modelsByVendor[fromKey];
      const toModel = modelsByVendor[toKey];
      const longToolCallId = `call_${"a".repeat(80)}|item_${"b".repeat(40)}`;
      const baseContent: AssistantMessage["content"] = [
        { type: "thinking", thinking: "PRIVATE_CHAIN_OF_THOUGHT", thinkingSignature: "c2lnbmF0dXJlMTIz" },
        { type: "text", text: "Checking file", textSignature: "dGV4dFNpZw==" },
        {
          type: "toolCall",
          id: longToolCallId,
          name: "read",
          arguments: { path: "README.md" },
          thoughtSignature: "dGhvdWdodFNpZw==",
        },
      ];
      const assistant: NativeContentMessage = {
        role: "assistant",
        content: baseContent,
        api: fromModel.api,
        provider: fromModel.provider,
        model: fromModel.id,
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1000,
        ...(fromModel.api === "anthropic-messages"
          ? {
              kuloNativeContent: {
                version: 1,
                provider: fromModel.provider,
                api: "anthropic-messages",
                model: fromModel.id,
                contentHash: nativeContentHash(baseContent),
                blocks: [{ type: "text", text: "Checking file" }],
              } satisfies NativeContentEnvelope,
            }
          : {}),
      };
      const messages: Message[] = [
        { role: "user", content: "Inspect README.md", timestamp: 900 },
        assistant,
        {
          role: "toolResult",
          toolCallId: longToolCallId,
          toolName: "read",
          content: [{ type: "text", text: "# Kulo" }],
          isError: false,
          timestamp: 1100,
        },
      ];

      // prepareNativeReplay must not activate on cross-model/cross-vendor switch
      const replay = prepareNativeReplay({ messages }, toModel);
      expect(replay.active).toBe(false);
      replay.release();

      // pi-ai native transformMessages drops foreign thinking & signatures without turning thinking into visible text
      const transformed = transformMessages(messages, toModel, (id) =>
        id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      );
      const outAssistant = transformed.find((m) => m.role === "assistant") as AssistantMessage;
      expect(outAssistant).toBeDefined();
      expect(outAssistant.content.some((b) => b.type === "thinking")).toBe(false);
      expect(JSON.stringify(outAssistant.content)).not.toContain("PRIVATE_CHAIN_OF_THOUGHT");
      expect(JSON.stringify(outAssistant.content)).not.toContain("textSignature");
      expect(JSON.stringify(outAssistant.content)).not.toContain("thoughtSignature");
      const outCall = outAssistant.content.find((b) => b.type === "toolCall");
      expect(outCall && outCall.type === "toolCall" ? outCall.id.length : 0).toBeLessThanOrEqual(64);
      const outResult = transformed.find((m) => m.role === "toolResult");
      expect(outResult && outResult.role === "toolResult" ? outResult.toolCallId : "").toBe(
        outCall && outCall.type === "toolCall" ? outCall.id : "",
      );
    },
  );
});

describe("Stage 2 §2.5 & §2.2: Rollback downgrade helper and sentinel secret redaction", () => {
  it("downgrades waiting(reason='quota') to waiting(reason='user') compatible with legacy Web task-model", () => {
    const sentinel = "sk-test-sentinel-rollback-9876543210";
    const state = {
      nextTicketNumber: 2,
      tickets: {
        "T-0001": {
          id: "T-0001",
          commandId: "cmd-1",
          title: "测试额度回滚",
          goal: "完成改动",
          scope: "/project",
          role: "developer",
          status: "waiting",
          envId: "local",
          workspaceDir: "/project",
          workerConversationId: 2,
          runEpoch: 1,
          createdAt: 1000,
          updatedAt: 1000,
          waiting: {
            reason: "quota",
            since: 1000,
            detail: `429 insufficient_quota with ${sentinel}`,
          },
          quotaPause: {
            kind: "provider_quota",
            provider: "openai",
            modelId: "gpt-4o",
            errorMessage: `429 insufficient_quota with ${sentinel}`,
            pausedAt: 1000,
          },
        } as TicketRecord,
      },
      commandIndex: {},
      conversationToTicket: {},
      slots: { holders: [] },
    };

    const result = downgradeQuotaWaitingToUser(state);
    expect(result.downgradedTicketIds).toEqual(["T-0001"]);
    const downgraded = state.tickets["T-0001"]!;
    expect(downgraded.waiting?.reason).toBe("user");
    expect(downgraded.quotaPause).toBeUndefined();
    expect(downgraded.waiting?.detail).toContain("额度暂停");
    expect(downgraded.waiting?.detail).not.toContain(sentinel);

    // Legacy Web compatibility check
    const card = toTicketCardView(downgraded, {});
    expect(taskNeedsAttention(card)).toBe(true);
    expect(taskStatusLabel(card)).toBe("等待确认");
  });

  it("commits sentinel secrets in quotaPause.errorMessage without documentLeak / SessionFailed", async () => {
    const rootDir = tempDir("kulo-quota-redact-");
    const vaultSecret = "vault-super-secret-value-xyz987654321";
    const apiKeySentinel = "sk-test-sentinel-abcdef1234567890";
    const models = createMultiProviderFauxModels({
      default: () => fauxAssistantMessage(fauxText("ok")),
    });
    const hub = await openTestHub({ config: makeHubConfig(rootDir), models });
    cleanups.push(() => hub.close().catch(() => {}));

    // Register a custom vault secret with connectionManager redactor
    hub.connectionManager.rememberSecrets([vaultSecret]);

    const rawErr = `429 usage_limit_reached: key=${apiKeySentinel} vault=${vaultSecret} ${"x".repeat(400)}`;
    const sanitized = sanitizeTicketQuotaText(rawErr, (t) => hub.connectionManager.redact(t));
    expect(sanitized.length).toBeLessThanOrEqual(240);
    expect(sanitized).not.toContain(apiKeySentinel);
    expect(sanitized).not.toContain(vaultSecret);

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-sentinel",
        title: "脱敏校验任务",
        goal: "检验脱敏落盘",
        scope: "test",
        role: "scout",
      },
      context,
    );

    // Write quotaPause + runHealthStuck directly through wrapRedactedStorage -> must NOT throw documentLeak / SessionFailed
    await expect(
      hub.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const live = state.tickets[card.id]!;
        const pause = classifyQuotaPauseFromUnanswered({
          ticket: live,
          unansweredReason: "model_error",
          unansweredDetail: rawErr,
          redact: (t) => hub.connectionManager.redact(t),
          now: Date.now(),
        })!;
        expect(pause.kind).toBe("provider_quota");
        live.quotaPause = pause;
        live.waiting = { reason: "quota", since: Date.now(), detail: pause.errorMessage };
        live.runHealthStuck = {
          kind: "doom_loop",
          reason: sanitizeTicketQuotaText(`stuck with ${apiKeySentinel} and ${vaultSecret}`, (t) =>
            hub.connectionManager.redact(t),
          ),
          at: Date.now(),
        };
      }, context),
    ).resolves.toBeUndefined();

    const snap = await hub.harness.snapshot(KuloStateDoc, context);
    const stored = snap?.tickets[card.id]!;
    expect(stored.quotaPause?.errorMessage.length).toBeLessThanOrEqual(240);
    expect(stored.quotaPause?.errorMessage).not.toContain(apiKeySentinel);
    expect(stored.quotaPause?.errorMessage).not.toContain(vaultSecret);
    expect(stored.waiting?.detail).not.toContain(apiKeySentinel);
    expect(stored.waiting?.detail).not.toContain(vaultSecret);
    expect(stored.runHealthStuck?.reason).not.toContain(apiKeySentinel);
    expect(stored.runHealthStuck?.reason).not.toContain(vaultSecret);
  });
});

describe("Stage 2 P0-3 + P1-3: Full Hub lifecycle (pause, write-lock, reconciler, same-engine resume, idempotency, usage_cap, stuck)", () => {
  it("pauses built-in worker on 429 subscription quota without failure_recovery or auto-wake, preserves staged diff & write lock, switches model via arbiter, and deduplicates concurrent resumes", async () => {
    const rootDir = tempDir("kulo-quota-builtin-");
    let openAiCalls = 0;
    let anthropicCalls = 0;

    const models = createMultiProviderFauxModels({
      openai: () => {
        openAiCalls += 1;
        return fauxAssistantMessage(fauxText(""), {
          stopReason: "error",
          errorMessage: '429 {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Monthly usage limit reached"}}',
        });
      },
      "anthropic-cloud": () => {
        anthropicCalls += 1;
        return fauxAssistantMessage(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "已切换至 Claude 模型完成任务。",
          }),
        );
      },
    });

    const hub = await openTestHub({
      config: makeHubConfig(rootDir),
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close().catch(() => {}));

    const projectDir = tempDir("kulo-quota-proj-");
    fs.writeFileSync(path.join(projectDir, "app.ts"), "export const v = 1;\n", "utf8");
    const project = await hub.projects.create(
      {
        commandId: "proj-quota-1",
        name: "QuotaProj",
        deviceId: hub.envManager.localEnvId,
        workspaceDir: projectDir,
      },
      context,
    );

    const dispatched = await hub.dispatchTicket(
      {
        commandId: "cmd-quota-builtin-1",
        title: "内置额度暂停工单",
        goal: "修改 app.ts",
        scope: "app.ts",
        role: "developer",
        projectId: project.id,
        workspaceMode: "staged",
      },
      context,
    );

    // Wait for built-in worker to hit 429 quota error and park in waiting(reason="quota")
    await until(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      const t = state?.tickets[dispatched.id];
      return t?.status === "waiting" && t.waiting?.reason === "quota";
    }, "built-in worker enters waiting(reason='quota')");

    expect(openAiCalls).toBeGreaterThanOrEqual(1);

    // Inject staged diff evidence and verify pause invariants
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[dispatched.id]!;
      t.workspaceStaging = {
        mode: "staged",
        stagedCwd: path.join(rootDir, "staged-copy"),
        stagedDiff: {
          hasChanges: true,
          added: [],
          modified: ["app.ts"],
          deleted: [],
          totalFiles: 1,
          digest: "sha256:test-staged-diff",
          truncated: false,
        },
      };
    }, context);

    const pausedState = await hub.harness.snapshot(KuloStateDoc, context);
    const pausedTicket = pausedState?.tickets[dispatched.id]!;
    expect(pausedTicket.quotaPause?.kind).toBe("provider_quota");
    expect(pausedTicket.quotaPause?.modelId).toBe("gpt-4o");
    expect(pausedTicket.recovery).toBeUndefined(); // MUST NOT trigger failure_recovery
    expect(pausedState?.slots.holders).not.toContain(dispatched.id); // Execution slot released
    expect(pausedState?.slots.writeHolders).toContain(dispatched.id); // Write lock PRESERVED
    expect(pausedTicket.workspaceStaging?.stagedDiff?.hasChanges).toBe(true); // Staged diff PRESERVED

    // Reconciler must NEVER auto-wake waiting(reason="quota"), even when wakePending is set or device reconnects
    const callsBeforeReconcile = openAiCalls;
    let reconcilerSteerCalls = 0;
    const probeReconciler = new TicketReconciler({
      harness: hub.harness,
      envManager: hub.envManager,
      projects: hub.projects,
      connectionManager: hub.connectionManager,
      usageCaps: hub.usageCaps,
      runtimeGates: {
        isClosed: () => false,
        isRecovering: () => false,
        isHandoverBarrierActive: () => false,
        resumeIfNotRecovering: () => {},
        broadcastTickets: async () => {},
        recordTicketOutwardAction: async () => {},
      },
      ports: {
        watchdog: { untrack: () => {} },
        computer: { buildTicketSessionCleanupTasks: () => [] },
        hostActions: { relayRequest: async () => {} },
        connectionsBridge: { resumeConnectionDecision: async () => {} },
        stagedApply: { discardTicketStagedWorkspace: async () => false },
        mediaJobs: () => hub.mediaJobs,
        workerTicketTask: {} as never,
        notifyInlineWaiters: () => {},
        ensureTopicWatchedByConversation: async () => {},
        broadcastProjects: async () => {},
        steerTicket: async () => {
          reconcilerSteerCalls += 1;
          throw new Error("quota ticket must never be auto-woken by reconciler");
        },
      },
    });
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[dispatched.id]!.wakePending = true;
    }, context);
    await probeReconciler.queueWaitReconcile();
    await probeReconciler.queueEnvReconcile();
    await probeReconciler.resumeWaitingTicket(dispatched.id, context);
    expect(reconcilerSteerCalls).toBe(0);
    const afterReconcile = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[dispatched.id]!;
    expect(afterReconcile.status).toBe("waiting");
    expect(afterReconcile.waiting?.reason).toBe("quota");
    expect(openAiCalls).toBe(callsBeforeReconcile);

    // Clear artificial wakePending before HTTP resume test
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[dispatched.id]!.wakePending = undefined;
    }, context);

    // Concurrent HTTP resume clicks with the same commandId MUST execute once!
    const resumeUrl = `${server.url}/api/tickets/${encodeURIComponent(dispatched.id)}/resume-override`;
    const [res1, res2] = await Promise.all([
      httpPostJson(resumeUrl, {
        commandId: "resume-cmd-1",
        provider: "anthropic-cloud",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      }),
      httpPostJson(resumeUrl, {
        commandId: "resume-cmd-1",
        provider: "anthropic-cloud",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      }),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect([res1.data.resumed, res2.data.resumed].filter(Boolean)).toHaveLength(1);

    // Wait for completion on Anthropic model
    await until(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      return state?.tickets[dispatched.id]?.status === "ready";
    }, "resumed built-in ticket completes on anthropic-cloud");

    const doneTicket = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[dispatched.id]!;
    expect(doneTicket.runEpoch).toBe(2); // Incremented ONCE despite concurrent clicks
    expect(doneTicket.providerOverride).toBe("anthropic-cloud");
    expect(doneTicket.modelOverride).toBe("claude-sonnet-4");
    expect(doneTicket.thinkingOverride).toBe("high");
    expect(doneTicket.quotaPause).toBeUndefined();
    expect(anthropicCalls).toBeGreaterThanOrEqual(1);

    // Verify AgentDoc reflects user override AND survives settings sync (#reconfigureWorkerConversations)
    const workerAgent = await hub.harness.snapshot(
      AgentDoc,
      doneTicket.workerConversationId as ConversationId,
      context,
    );
    expect(workerAgent?.model).toEqual({ provider: "anthropic-cloud", modelId: "claude-sonnet-4" });

    // Trigger global model settings update -> #reconfigureWorkerConversations MUST NOT clobber user override!
    const currentSettings = hub.getSettingsView();
    await hub.updateSettingsBlock(
      "model",
      currentSettings.blocks.model.revision,
      {
        ...currentSettings.blocks.model.value,
        defaultModel: "gpt-4o-mini",
      },
      context,
    );
    const workerAgentAfterSync = await hub.harness.snapshot(
      AgentDoc,
      doneTicket.workerConversationId as ConversationId,
      context,
    );
    expect(workerAgentAfterSync?.model).toEqual({ provider: "anthropic-cloud", modelId: "claude-sonnet-4" });

    // Also verify concurrent resume WITHOUT commandId deduplicates cleanly via queueTicket + recentResumes
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[dispatched.id]!;
      t.status = "waiting";
      t.waiting = { reason: "quota", since: Date.now(), detail: "Monthly usage limit reached" };
      t.quotaPause = {
        kind: "provider_quota",
        provider: "openai",
        modelId: "gpt-4o",
        errorMessage: "Monthly usage limit reached",
        pausedAt: Date.now(),
      };
    }, context);
    const [noCmd1, noCmd2] = await Promise.all([
      httpPostJson(resumeUrl, { provider: "anthropic-cloud", modelId: "claude-opus-4" }),
      httpPostJson(resumeUrl, { provider: "anthropic-cloud", modelId: "claude-opus-4" }),
    ]);
    expect(noCmd1.status).toBe(200);
    expect(noCmd2.status).toBe(200);
    expect([noCmd1.data.resumed, noCmd2.data.resumed].filter(Boolean)).toHaveLength(1);
    await until(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      return state?.tickets[dispatched.id]?.status === "ready";
    }, "no-commandId deduped resume completes");
    const afterNoCmd = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[dispatched.id]!;
    expect(afterNoCmd.runEpoch).toBe(3); // Incremented strictly ONCE
  });

  it("pauses external ACP ticket on quota failure without failure_recovery and updates BOTH modelOverride and externalExecution.modelId on same-client resume", async () => {
    const rootDir = tempDir("kulo-quota-ext-");
    const models = createMultiProviderFauxModels({
      default: () => fauxAssistantMessage(fauxText("ok")),
    });
    const hub = await openTestHub({ config: makeHubConfig(rootDir), models });
    cleanups.push(() => hub.close().catch(() => {}));

    const clientId = `codex:${hub.envManager.localEnvId}`;
    const extRequests: ExternalAgentRequest[] = [];
    let attempt = 0;
    let lastRunEpoch = 1;

    hub.envManager.requestExternalAgent = (async (_envId: string, request: ExternalAgentRequest): Promise<ExternalAgentResponse> => {
      extRequests.push(request);
      if (request.operation === "run") {
        attempt += 1;
        lastRunEpoch = request.runEpoch;
        const run: ExternalAgentRun = {
          id: request.requestId,
          taskId: request.taskId,
          runEpoch: request.runEpoch,
          kind: "codex",
          state: "running",
          sessionId: "sess-codex-1",
          text: "",
          events: [],
          nextSequence: 1,
          permissions: [],
          stagedCwd: path.join(rootDir, "ext-staged"),
          stagedDiff: {
            hasChanges: true,
            added: ["new.ts"],
            modified: [],
            deleted: [],
            totalFiles: 1,
            digest: "sha256:ext-diff",
            truncated: false,
          },
          quiescent: false,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        };
        return { type: "run", run };
      }
      if (request.operation === "inspect") {
        const isFirst = attempt === 1;
        const run: ExternalAgentRun = {
          id: request.runId,
          taskId: "T-0001",
          runEpoch: lastRunEpoch,
          kind: "codex",
          state: isFirst ? "failed" : "completed",
          sessionId: "sess-codex-1",
          text: isFirst ? "" : "Completed with codex-mini",
          ...(isFirst ? { error: '429 {"error":{"code":"1308","message":"Weekly usage limit reached"}}' } : {}),
          events: [],
          nextSequence: 2,
          permissions: [],
          stagedCwd: path.join(rootDir, "ext-staged"),
          stagedDiff: {
            hasChanges: true,
            added: ["new.ts"],
            modified: [],
            deleted: [],
            totalFiles: 1,
            digest: "sha256:ext-diff",
            truncated: false,
          },
          quiescent: true,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        };
        return { type: "run", run };
      }
      return {
        type: "run",
        run: {
          id: "runId" in request ? request.runId : "closed",
          taskId: "T-0001",
          runEpoch: attempt,
          kind: "codex",
          state: "cancelled",
          text: "",
          events: [],
          nextSequence: 2,
          permissions: [],
          quiescent: true,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }) as typeof hub.envManager.requestExternalAgent;

    // Register external client connection BEFORE binding a role to it
    await hub.harness.commit(async (tx) => {
      const { KuloSettingsDoc } = await import("../packages/hub/src/settings.js");
      const doc = await tx.doc(KuloSettingsDoc);
      doc.externalClients = {
        ...(doc.externalClients ?? {}),
        [clientId]: {
          id: clientId,
          kind: "codex",
          envId: hub.envManager.localEnvId,
          verifiedAt: Date.now(),
          models: [
            { id: "gpt-5-codex", name: "GPT-5 Codex", efforts: ["low", "medium", "high"], effortCapability: "supported" },
            { id: "gpt-5-codex-mini", name: "GPT-5 Codex Mini", efforts: [], effortCapability: "unsupported" },
          ],
          updatedAt: Date.now(),
        },
      };
    }, context);
    const settingsView = hub.getSettingsView();
    await hub.updateSettingsBlock(
      "roles",
      settingsView.blocks.roles.revision,
      {
        ...settingsView.blocks.roles.value,
        codex_dev: {
          id: "codex_dev",
          label: "Codex Dev",
          whenToUse: "coding",
          prompt: "code",
          enabled: true,
          modelId: "gpt-5-codex",
          externalClientId: clientId,
          external: {
            kind: "codex",
            envId: hub.envManager.localEnvId,
            verifiedAt: Date.now(),
          },
        },
      },
      context,
    );

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-ext-quota-1",
        title: "外部 ACP 额度暂停",
        goal: "编写功能",
        scope: "src/",
        role: "codex_dev",
      },
      context,
    );

    await until(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      const t = state?.tickets[card.id];
      return t?.status === "waiting" && t.waiting?.reason === "quota";
    }, "external ACP ticket pauses on quota");

    const paused = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]!;
    expect(paused.quotaPause?.kind).toBe("external_quota");
    expect(paused.recovery).toBeUndefined();
    expect(paused.externalExecution?.stagedDiff?.hasChanges).toBe(true);
    expect(paused.externalExecution?.stagedCwd).toBeTruthy();

    // Cross-engine switch from external ACP to built-in provider MUST be rejected!
    await expect(
      hub.resumeTicketWithOverride(
        card.id,
        { provider: "openai", modelId: "gpt-4o" },
        context,
      ),
    ).rejects.toMatchObject({ status: 409, code: "cross_engine_resume_denied" });

    // Same-client model switch updates BOTH modelOverride AND externalExecution.modelId
    const resumed = await hub.resumeTicketWithOverride(
      card.id,
      { commandId: "ext-resume-1", modelId: "gpt-5-codex-mini" },
      context,
    );
    expect(resumed.resumed).toBe(true);

    await until(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      return state?.tickets[card.id]?.status === "ready";
    }, "external ACP ticket completes after same-client model switch");

    const finalTicket = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]!;
    expect(finalTicket.modelOverride).toBe("gpt-5-codex-mini");
    expect(finalTicket.externalExecution?.modelId).toBe("gpt-5-codex-mini");
    const runRequests = extRequests.filter((r): r is Extract<ExternalAgentRequest, { operation: "run" }> => r.operation === "run");
    expect(runRequests).toHaveLength(2);
    expect(runRequests[1]?.modelId).toBe("gpt-5-codex-mini");
  });

  it("blocks bypassing usage_cap with another cloud model, allows loopback local model, and enforces project revision conflict", async () => {
    const rootDir = tempDir("kulo-usage-cap-");
    const models = createMultiProviderFauxModels({
      "local-ollama": () =>
        toolTurn(fauxToolCall("kulo_report", { state: "ready", summary: "本机模型完成。" })),
      default: () => fauxAssistantMessage(fauxText("ok")),
    });
    const hub = await openTestHub({ config: makeHubConfig(rootDir), models });
    cleanups.push(() => hub.close().catch(() => {}));

    // Enable usage cap and exceed it
    const capSnap = hub.usageCaps.snapshot();
    await hub.usageCaps.updateConfig(capSnap.revision, {
      enabled: true,
      dailyTokenLimit: 100,
      weeklyTokenLimit: null,
      dailyCostUsdLimit: null,
      weeklyCostUsdLimit: null,
      scope: "all_background",
    });
    hub.usageCaps.recordUsage(
      { baseUrl: "https://api.openai.com/v1", provider: "openai", id: "gpt-4o" },
      { input: 80, output: 50, totalTokens: 130 },
    );
    expect(hub.usageCaps.snapshot().capped).toBe(true);

    const projectDir = tempDir("kulo-cap-proj-");
    const project = await hub.projects.create(
      {
        commandId: "proj-cap-1",
        name: "CapProj",
        deviceId: hub.envManager.localEnvId,
        workspaceDir: projectDir,
      },
      context,
    );

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-cap-1",
        title: "预算上限测试",
        goal: "检查预算防绕过",
        scope: "src",
        role: "scout",
        projectId: project.id,
      },
      context,
    );
    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "ready";
    }, "initial run settles");

    // Put ticket into usage_cap quota pause
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[card.id]!;
      t.status = "waiting";
      t.waiting = { reason: "quota", since: Date.now(), detail: "已达每日 Token 上限" };
      t.quotaPause = {
        kind: "usage_cap",
        provider: "openai",
        modelId: "gpt-4o",
        errorMessage: "已达每日 Token 上限",
        pausedAt: Date.now(),
      };
    }, context);

    // 1. Attempting to switch to ANOTHER cloud model must be DENIED (403 usage_cap_bypass_denied)!
    await expect(
      hub.resumeTicketWithOverride(
        card.id,
        { provider: "anthropic-cloud", modelId: "claude-sonnet-4" },
        context,
      ),
    ).rejects.toMatchObject({ status: 403, code: "usage_cap_bypass_denied" });

    // 2. If project baseline revision changed, conflict must trigger!
    await hub.harness.commit(async (tx) => {
      const pdoc = await tx.doc(KuloProjectsDoc);
      pdoc.projects[project.id]!.revision += 1;
    }, context);
    await expect(
      hub.resumeTicketWithOverride(
        card.id,
        { provider: "local-ollama", modelId: "qwen2.5-coder:32b" },
        context,
      ),
    ).rejects.toMatchObject({ status: 409, code: "project_revision_changed" });

    // Restore matching project revision
    await hub.harness.commit(async (tx) => {
      const pdoc = await tx.doc(KuloProjectsDoc);
      pdoc.projects[project.id]!.revision -= 1;
    }, context);

    // 3. Switching to a loopback local model under usage_cap MUST succeed!
    const localResumed = await hub.resumeTicketWithOverride(
      card.id,
      { commandId: "resume-local-1", provider: "local-ollama", modelId: "qwen2.5-coder:32b" },
      context,
    );
    expect(localResumed.resumed).toBe(true);
    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "ready";
    }, "local loopback model completes after usage_cap resume");

    // 4. Verify relaxing budget allows cloud resume on a usage_cap paused ticket
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[card.id]!;
      t.status = "waiting";
      t.waiting = { reason: "quota", since: Date.now(), detail: "已达每日 Token 上限" };
      t.quotaPause = {
        kind: "usage_cap",
        provider: "openai",
        modelId: "gpt-4o",
        errorMessage: "已达每日 Token 上限",
        pausedAt: Date.now(),
      };
    }, context);
    await hub.usageCaps.updateConfig(hub.usageCaps.snapshot().revision, {
      enabled: true,
      dailyTokenLimit: 1_000_000,
      weeklyTokenLimit: null,
      dailyCostUsdLimit: null,
      weeklyCostUsdLimit: null,
      scope: "all_background",
    });
    const relaxedResumed = await hub.resumeTicketWithOverride(
      card.id,
      { commandId: "resume-relaxed-1", provider: "anthropic-cloud", modelId: "claude-sonnet-4" },
      context,
    );
    expect(relaxedResumed.resumed).toBe(true);
  });

  it("P1-3: surfaces runHealthStuck on doom_loop and allows switching to a stronger model via resume-override", async () => {
    const rootDir = tempDir("kulo-stuck-escalate-");
    let weakTurns = 0;
    let strongTurns = 0;

    const models = createMultiProviderFauxModels({
      openai: () => {
        weakTurns += 1;
        // Repeatedly call the same read tool to trigger Layer-1 doom_loop (warn at 3, brake at 5)
        if (weakTurns <= 5) {
          return toolTurn(fauxToolCall("read", { path: "missing.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "blocked",
            summary: "连续读取失败，任务停滞。",
            question: "如何继续？",
          }),
        );
      },
      "anthropic-cloud": () => {
        strongTurns += 1;
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "换用更强模型后已解决。",
          }),
        );
      },
    });

    const hub = await openTestHub({ config: makeHubConfig(rootDir), models });
    cleanups.push(() => hub.close().catch(() => {}));

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-stuck-1",
        title: "停滞任务换强模型",
        goal: "修复问题",
        scope: "src",
        role: "scout",
      },
      context,
    );

    // Wait for runHealthStuck to be projected onto the ticket
    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return Boolean(s?.tickets[card.id]?.runHealthStuck);
    }, "worker triggers doom_loop and sets runHealthStuck");

    const stuckTicket = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]!;
    expect(stuckTicket.runHealthStuck?.kind).toBe("doom_loop");
    const view = toTicketCardView(stuckTicket, hub.getSettingsView().blocks.roles.value);
    expect(view.runHealthStuck?.kind).toBe("doom_loop");

    // User clicks "换更强模型继续" -> calls resume-override with stronger model
    const res = await hub.resumeTicketWithOverride(
      card.id,
      {
        commandId: "escalate-strong-1",
        provider: "anthropic-cloud",
        modelId: "claude-opus-4",
      },
      context,
    );
    expect(res.resumed).toBe(true);

    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "ready";
    }, "stronger model completes the stuck ticket");

    const finished = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]!;
    expect(finished.providerOverride).toBe("anthropic-cloud");
    expect(finished.modelOverride).toBe("claude-opus-4");
    expect(finished.runHealthStuck).toBeUndefined();
    expect(strongTurns).toBeGreaterThanOrEqual(1);
  });

  it("classifies external failure with classifyQuotaPauseFromExternalFailure cleanly", () => {
    const ticket = {
      id: "T-0099",
      role: "client:codex:local",
      externalExecution: {
        binding: { kind: "codex" as const, envId: "local" },
        modelId: "gpt-5-codex",
      },
    } as unknown as TicketRecord;

    const pause = classifyQuotaPauseFromExternalFailure({
      ticket,
      error: "429 You have reached your specified API usage limits",
      now: 12345,
    });
    expect(pause).toMatchObject({
      kind: "external_quota",
      externalClientId: "codex:local",
      modelId: "gpt-5-codex",
      pausedAt: 12345,
    });
  });
});
