import fs from "node:fs";
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
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, opt, str } from "@earendil-works/pi-schema";
import {
  defaultRolePresets,
  type ModelGatewayConfig,
  type RolePreset,
  type TicketRecord,
} from "@kulo/protocol";
import {
  KuloStateDoc,
  RunHealthDoc,
  RunHealthEscalationEntry,
  createRunHealthController,
  evaluateOneWayModelEscalation,
  resolveWorkerEffectiveModel,
  type KuloHubConfigOverrides,
  type RunHealthJudgeVerdict,
} from "@kulo/hub";
import { wrapRedactedStorage } from "../packages/hub/src/credential-redaction.js";
import {
  applyRolesBlockUpdate,
  cleanupRemovedRoleModels,
  type RoleSettingsTarget,
} from "../packages/hub/src/settings-roles.js";
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

async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function toolTurn(...calls: ReturnType<typeof fauxToolCall>[]) {
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

function makeBaseModelConfig(overrides: Partial<ModelGatewayConfig> = {}): ModelGatewayConfig {
  return {
    baseUrl: "https://api.openai.com/v1",
    apiMode: "openai-completions",
    defaultProvider: "openai",
    defaultModel: "gpt-4o",
    thinkingLevel: "off",
    customProviders: [
      {
        id: "fast-worker",
        name: "Fast Worker Provider",
        api: "openai-completions",
        baseUrl: "https://fast.example.com/v1",
        models: [
          { id: "fast-mini", contextWindow: 128_000 },
          { id: "fast-alt", contextWindow: 128_000 },
        ],
      },
      {
        id: "anthropic-cloud",
        name: "Anthropic Cloud",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        models: [
          { id: "claude-opus-4", contextWindow: 200_000 },
          { id: "claude-tiny", contextWindow: 120 },
        ],
      },
      {
        id: "user-override-prov",
        name: "User Override Provider",
        api: "openai-completions",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "user-chosen-model", contextWindow: 128_000 }],
      },
    ],
    ...overrides,
  };
}

function makeHubConfig(
  rootDir: string,
  options: {
    escalationModel?: RolePreset["escalationModel"];
    scoutReadOnly?: boolean;
    modelOverrides?: Partial<ModelGatewayConfig>;
  } = {},
): KuloHubConfigOverrides {
  const roles: Record<string, RolePreset> = {};
  for (const [id, preset] of Object.entries(defaultRolePresets())) {
    roles[id] = { ...preset };
  }
  roles.scout = {
    ...roles.scout!,
    readOnly: options.scoutReadOnly ?? true,
    provider: "fast-worker",
    modelId: "fast-mini",
    thinkingLevel: "off",
    ...(options.escalationModel ? { escalationModel: options.escalationModel } : {}),
  };

  return {
    stateDir: path.join(rootDir, "hub-state"),
    localEnvRoot: path.join(rootDir, "local-runtime"),
    identityDir: path.join(rootDir, "private-identity"),
    authToken: HUB_TEST_ADMIN_TOKEN,
    maxConcurrentWorkers: 2,
    watchdogMinutes: 0,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: makeBaseModelConfig(options.modelOverrides),
    roles,
  };
}

function createDualFauxModels(options: {
  fastHandler: (req: TranscriptContext, turn: number, reqOptions?: unknown) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
  strongHandler: (req: TranscriptContext, turn: number, reqOptions?: unknown) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
  overrideHandler?: (req: TranscriptContext, turn: number, reqOptions?: unknown) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
  strongContextWindow?: number;
  tinyContextWindow?: number;
}) {
  const models = createModels();
  const outboundCalls: Array<{ provider: string; modelId: string; turn: number; messages: readonly Message[] }> = [];
  let fastCount = 0;
  let strongCount = 0;
  let overrideCount = 0;

  // Dedicated orchestrator model so relay turns never mix with Worker outbound call counts.
  const orchestratorFaux = fauxProvider({
    provider: "openai",
    models: [
      { id: "gpt-4o", contextWindow: 128_000 },
      { id: "gpt-4o-mini", contextWindow: 128_000 },
    ],
  });
  orchestratorFaux.setResponses(
    Array.from({ length: 32 }, () => () => fauxAssistantMessage([fauxText("已收到汇报。")])),
  );
  models.setProvider(orchestratorFaux.provider);

  const fastFaux = fauxProvider({
    provider: "fast-worker",
    models: [
      { id: "fast-mini", contextWindow: 128_000 },
      { id: "fast-alt", contextWindow: 128_000 },
    ],
  });
  fastFaux.setResponses(
    Array.from({ length: 64 }, () => (req: TranscriptContext, reqOptions?: unknown) => {
      fastCount += 1;
      outboundCalls.push({ provider: "fast-worker", modelId: "fast-mini", turn: fastCount, messages: req.messages });
      return options.fastHandler(req, fastCount, reqOptions);
    }),
  );
  models.setProvider(fastFaux.provider);

  const strongFaux = fauxProvider({
    provider: "anthropic-cloud",
    models: [
      { id: "claude-opus-4", contextWindow: options.strongContextWindow ?? 200_000 },
      { id: "claude-tiny", contextWindow: options.tinyContextWindow ?? 120 },
    ],
  });
  strongFaux.setResponses(
    Array.from({ length: 64 }, () => (req: TranscriptContext, reqOptions?: unknown) => {
      strongCount += 1;
      outboundCalls.push({ provider: "anthropic-cloud", modelId: "claude-opus-4", turn: strongCount, messages: req.messages });
      return options.strongHandler(req, strongCount, reqOptions);
    }),
  );
  models.setProvider(strongFaux.provider);

  const overrideFaux = fauxProvider({
    provider: "user-override-prov",
    models: [{ id: "user-chosen-model", contextWindow: 128_000 }],
  });
  overrideFaux.setResponses(
    Array.from({ length: 32 }, () => (req: TranscriptContext, reqOptions?: unknown) => {
      overrideCount += 1;
      outboundCalls.push({
        provider: "user-override-prov",
        modelId: "user-chosen-model",
        turn: overrideCount,
        messages: req.messages,
      });
      return (options.overrideHandler ?? options.strongHandler)(req, overrideCount, reqOptions);
    }),
  );
  models.setProvider(overrideFaux.provider);

  return {
    models,
    outboundCalls,
    counts: () => ({ fast: fastCount, strong: strongCount, override: overrideCount }),
  };
}

describe("Stage 3 P1-3: RolePreset escalationModel validation in settings-roles.ts", () => {
  function makeSettingsDoc(): RoleSettingsTarget {
    return {
      model: makeBaseModelConfig(),
      roles: {
        scout: { ...defaultRolePresets().scout! },
      },
    };
  }

  it("accepts valid built-in escalationModel, ignores external escalationModel, rejects unknown provider/model and non-chat models", () => {
    const doc = makeSettingsDoc();
    const baseScout = defaultRolePresets().scout!;

    // 1. Valid built-in escalationModel succeeds
    applyRolesBlockUpdate(doc, {
      scout: {
        ...baseScout,
        provider: "openai",
        modelId: "gpt-4o-mini",
        escalationModel: {
          provider: "anthropic-cloud",
          modelId: "claude-opus-4",
          thinkingLevel: "high",
        },
      },
    });
    expect(doc.roles.scout?.escalationModel).toEqual({
      provider: "anthropic-cloud",
      modelId: "claude-opus-4",
      thinkingLevel: "high",
    });

    // 2. Unknown provider is rejected with 400
    expect(() =>
      applyRolesBlockUpdate(makeSettingsDoc(), {
        scout: {
          ...baseScout,
          escalationModel: { provider: "missing-provider", modelId: "some-model" },
        },
      }),
    ).toThrow(/不存在的服务商/);

    // 3. Unknown model under existing custom provider is rejected with 400
    expect(() =>
      applyRolesBlockUpdate(makeSettingsDoc(), {
        scout: {
          ...baseScout,
          escalationModel: { provider: "anthropic-cloud", modelId: "nonexistent-model-999" },
        },
      }),
    ).toThrow(/不存在遇卡升级模型/);

    // 4. Non-chat (image) model is rejected with 400
    expect(() =>
      applyRolesBlockUpdate(makeSettingsDoc(), {
        scout: {
          ...baseScout,
          escalationModel: { provider: "openai", modelId: "gpt-image-1" },
        },
      }),
    ).toThrow(/图像生成/);

    // 5. External role silently ignores escalationModel without failing
    const extDoc: RoleSettingsTarget = {
      ...makeSettingsDoc(),
      externalClients: {
        "codex:local": {
          id: "codex:local",
          kind: "codex",
          envId: "local",
          verifiedAt: 100,
          updatedAt: 100,
          models: [{ id: "gpt-5-codex" }],
        },
      },
    };
    applyRolesBlockUpdate(
      extDoc,
      {
        scout: { ...baseScout },
        ext_coder: {
          id: "ext_coder",
          label: "外部编码",
          whenToUse: "编码",
          prompt: "编码",
          enabled: true,
          externalClientId: "codex:local",
          external: { kind: "codex", envId: "local", verifiedAt: 100 },
          escalationModel: { provider: "nonexistent-provider", modelId: "ignored-model" },
        },
      },
      { externalAgents: true },
    );
    expect(extDoc.roles.ext_coder?.escalationModel).toBeUndefined();

    // 6. Removing the custom provider cleans up stale role.escalationModel
    const prevModel = doc.model;
    const nextModel: ModelGatewayConfig = {
      ...prevModel,
      customProviders: prevModel.customProviders?.filter((cp) => cp.id !== "anthropic-cloud"),
    };
    const cleaned = cleanupRemovedRoleModels(doc.roles, prevModel, nextModel);
    expect(cleaned).toBe(true);
    expect(doc.roles.scout?.escalationModel).toBeUndefined();
  });
});

describe("Stage 3 P1-3: Pure evaluateOneWayModelEscalation decision rules", () => {
  const defaultModel = { provider: "openai", modelId: "gpt-4o-mini", thinkingLevel: "off" as const };
  const rolePreset: Pick<RolePreset, "provider" | "modelId" | "thinkingLevel" | "escalationModel" | "external"> = {
    provider: "openai",
    modelId: "gpt-4o-mini",
    thinkingLevel: "off",
    escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", thinkingLevel: "high" },
  };
  const baseTicket: Pick<
    TicketRecord,
    "status" | "runEpoch" | "providerOverride" | "modelOverride" | "thinkingOverride" | "modelEscalation" | "externalExecution"
  > = {
    status: "running",
    runEpoch: 1,
  };

  it("approves escalation for eligible built-in worker and arbitrates via resolveWorkerEffectiveModel", () => {
    const decision = evaluateOneWayModelEscalation({
      role: "worker",
      ticket: baseTicket,
      rolePreset,
      defaultModel,
      trigger: { layer: "layer1_doom_loop", action: "warn", reason: "重复调用 read" },
      turn: 3,
      targetModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", contextWindow: 200_000 },
      estimatedContextTokens: 8_500,
    });
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.resolvedModel).toEqual({
      provider: "anthropic-cloud",
      modelId: "claude-opus-4",
      thinkingLevel: "high",
      explicitThinking: true,
      source: "escalation",
    });
    expect(decision.escalation.runEpoch).toBe(1);
    expect(decision.escalation.activatedAtTurn).toBe(3);
    expect(decision.timelineText).toContain("已单向升级至 claude-opus-4 继续排障");
  });

  it("rejects non-builtin roles, missing config, user overrides, second escalation, and insufficient context window", () => {
    // Non-worker role (orchestrator / subagent)
    expect(
      evaluateOneWayModelEscalation({
        role: "orchestrator",
        ticket: baseTicket,
        rolePreset,
        defaultModel,
        trigger: { layer: "layer1_doom_loop", action: "warn", reason: "loop" },
        turn: 3,
        targetModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", contextWindow: 200_000 },
        estimatedContextTokens: 1_000,
      }),
    ).toMatchObject({ escalate: false, rejectReason: "not_builtin_worker" });

    // User explicit override blocks escalation
    expect(
      evaluateOneWayModelEscalation({
        role: "worker",
        ticket: { ...baseTicket, providerOverride: "user-override-prov", modelOverride: "user-chosen-model" },
        rolePreset,
        defaultModel,
        trigger: { layer: "layer1_doom_loop", action: "warn", reason: "loop" },
        turn: 3,
        targetModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", contextWindow: 200_000 },
        estimatedContextTokens: 1_000,
      }),
    ).toMatchObject({ escalate: false, rejectReason: "user_override_present" });

    // Already escalated in this runEpoch -> strictly at most once
    expect(
      evaluateOneWayModelEscalation({
        role: "worker",
        ticket: {
          ...baseTicket,
          modelEscalation: {
            runEpoch: 1,
            activatedAtTurn: 3,
            escalatedModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
            reason: "already",
          },
        },
        rolePreset,
        defaultModel,
        trigger: { layer: "layer1_doom_loop", action: "warn", reason: "loop again" },
        turn: 6,
        targetModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", contextWindow: 200_000 },
        estimatedContextTokens: 1_000,
      }),
    ).toMatchObject({ escalate: false, rejectReason: "already_escalated" });

    // Target model contextWindow < estimatedContextTokens -> rejected with reason
    const tooSmall = evaluateOneWayModelEscalation({
      role: "worker",
      ticket: baseTicket,
      rolePreset,
      defaultModel,
      trigger: { layer: "layer2_judge", verdict: "stuck", reason: "stuck" },
      turn: 25,
      targetModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", contextWindow: 4_000 },
      estimatedContextTokens: 12_000,
    });
    expect(tooSmall).toMatchObject({ escalate: false, rejectReason: "context_window_insufficient" });
    if (!tooSmall.escalate) {
      expect(tooSmall.detail).toContain("4000");
      expect(tooSmall.detail).toContain("12000");
    }
  });
});

describe("Stage 3 P1-3: End-to-end dual-model one-way auto-escalation on real KuloHub", () => {
  it("switches real outbound requests from fast model to strong model on doom_loop, resets cache.doomLoop so strong model runs tools freely, never downgrades, emits timeline event, and cleans active state on settle", async () => {
    const rootDir = tempDir("kulo-esc-e2e-");
    let observedActiveEscalationInFlight = false;
    const faux = createDualFauxModels({
      fastHandler: (_req, turn) => {
        // 3 identical tool calls trigger Layer-1 doom_loop warn -> one-way auto-escalation
        if (turn <= 3) {
          return toolTurn(fauxToolCall("read", { path: "missing-probe.txt" }));
        }
        throw new Error(`Fast model must NOT be called again after escalation (unexpected turn ${turn})`);
      },
      strongHandler: (_req, turn) => {
        // Strong model makes 2 tool calls with the SAME failing read BEFORE succeeding & reporting!
        // If cache.doomLoop had NOT been reset at streak=3, turn 2 on strong model would hit streak=5 brake & block tools!
        if (turn <= 2) {
          return toolTurn(fauxToolCall("read", { path: "missing-probe.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "升级至强模型后连续排查并成功完成任务。",
          }),
        );
      },
    });

    const hub = await openTestHub({
      config: makeHubConfig(rootDir, {
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4", thinkingLevel: "high" },
      }),
      models: faux.models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const unsubscribe = hub.subscribe({
      onTickets: (cards) => {
        if (cards.some((c) => c.modelEscalation?.escalatedModel.modelId === "claude-opus-4")) {
          observedActiveEscalationInFlight = true;
        }
      },
    });
    cleanups.push(unsubscribe);

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-esc-1",
        title: "单向自动升档端到端验证",
        goal: "排查并修复问题",
        scope: "src",
        role: "scout",
      },
      context,
    );

    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "ready";
    }, "escalated worker completes on strong model");

    // 1. Outbound requests switched cleanly: 3 turns on fast model, then ALL remaining turns on strong model (never fell back!)
    expect(faux.counts().fast).toBe(3);
    expect(faux.counts().strong).toBe(3);
    expect(faux.outboundCalls.map((c) => `${c.provider}/${c.modelId}`)).toEqual([
      "fast-worker/fast-mini",
      "fast-worker/fast-mini",
      "fast-worker/fast-mini",
      "anthropic-cloud/claude-opus-4",
      "anthropic-cloud/claude-opus-4",
      "anthropic-cloud/claude-opus-4",
    ]);
    expect(observedActiveEscalationInFlight).toBe(true);

    // 2. Concise timeline event projected in worker transcript
    const transcriptView = await hub.inspectTicketDetail(card.id, context);
    const escalationNote = transcriptView.transcript.find(
      (item) => item.role === "system_note" && item.text.includes("已单向升级至 claude-opus-4 继续排障"),
    );
    expect(escalationNote).toBeDefined();

    // 3. Strong model's 2 tool calls were NOT blocked by doom_loop brake (cache.doomLoop was reset!)
    const strongToolBlocked = transcriptView.transcript.some((item) =>
      item.toolCalls?.some((tc) => tc.result?.text.includes("[KULO_RUN_HEALTH] Wrap-up active")),
    );
    expect(strongToolBlocked).toBe(false);

    // 4. Terminal onTicketSettled cleaned up active escalation state on KuloStateDoc & RunHealthDoc
    const finalState = await hub.harness.snapshot(KuloStateDoc, context);
    const settledTicket = finalState?.tickets[card.id]!;
    expect(settledTicket.status).toBe("ready");
    expect(settledTicket.modelEscalation).toBeUndefined();
    const runHealthDoc = await hub.harness.snapshot(
      RunHealthDoc,
      settledTicket.workerConversationId as ConversationId,
      context,
    );
    expect(runHealthDoc?.escalation).toBeUndefined();
  });

  it("escalates at most ONCE per ticket: if the strong model also loops, no second escalation occurs and normal brake applies", async () => {
    const rootDir = tempDir("kulo-esc-once-");
    const faux = createDualFauxModels({
      fastHandler: () => toolTurn(fauxToolCall("read", { path: "loop-target.txt" })),
      strongHandler: (_req, turn) => {
        // Strong model ALSO repeats the same call 5 times -> hits streak=3 warn, streak=5 brake (no 2nd escalation!)
        if (turn <= 5) {
          return toolTurn(fauxToolCall("read", { path: "loop-target.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "blocked",
            summary: "强模型也受阻，按要求收口。",
            question: "请确认文件位置。",
          }),
        );
      },
    });

    const hub = await openTestHub({
      config: makeHubConfig(rootDir, {
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
      }),
      models: faux.models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-esc-once-1",
        title: "单工单最多升档一次",
        goal: "检查文件",
        scope: "src",
        role: "scout",
      },
      context,
    );

    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "waiting" && s.tickets[card.id]?.latestReport?.state === "blocked";
    }, "strong model hits brake and reports blocked");

    // Fast model ran exactly 3 turns, strong model ran 6 turns, and NEVER downgraded
    expect(faux.counts().fast).toBe(3);
    expect(faux.counts().strong).toBe(6);

    // Exactly ONE timeline escalation entry exists (never escalated a second time)
    const view = await hub.inspectTicketDetail(card.id, context);
    const escalationNotes = view.transcript.filter(
      (item) => item.role === "system_note" && item.text.includes("已单向升级至"),
    );
    expect(escalationNotes).toHaveLength(1);
  });

  it("respects user explicit model override over auto-escalation and protects active escalation against settings sync", async () => {
    const rootDir = tempDir("kulo-esc-override-");
    let releaseStrongGate!: () => void;
    const strongGate = new Promise<void>((resolve) => {
      releaseStrongGate = resolve;
    });
    cleanups.push(() => releaseStrongGate());
    let strongArrivedResolve!: () => void;
    const strongArrived = new Promise<void>((resolve) => {
      strongArrivedResolve = resolve;
    });

    const faux = createDualFauxModels({
      fastHandler: () => toolTurn(fauxToolCall("read", { path: "probe-sync.txt" })),
      strongHandler: async (_req, turn) => {
        if (turn === 1) {
          strongArrivedResolve();
          await strongGate;
          return toolTurn(fauxToolCall("read", { path: "after-settings-sync.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "设置同步后仍保持升档强模型完成。",
          }),
        );
      },
      overrideHandler: (_req, turn) => {
        if (turn <= 5) {
          return toolTurn(fauxToolCall("read", { path: "override-loop.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "用户显式覆盖模型未触发自动升档。",
          }),
        );
      },
    });

    const hub = await openTestHub({
      config: makeHubConfig(rootDir, {
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
      }),
      models: faux.models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    // Part A: Ticket dispatched with explicit user override NEVER auto-escalates even on doom_loop!
    const overriddenCard = await hub.dispatchTicket(
      {
        commandId: "cmd-override-1",
        title: "用户显式指定模型",
        goal: "核实优先级",
        scope: "src",
        role: "scout",
        providerOverride: "user-override-prov",
        modelOverride: "user-chosen-model",
      },
      context,
    );
    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[overriddenCard.id]?.status === "ready";
    }, "user-overridden ticket completes without escalation");

    expect(faux.counts().override).toBe(6);
    expect(faux.counts().strong).toBe(0);
    const overriddenTranscript = await hub.inspectTicketDetail(overriddenCard.id, context);
    expect(overriddenTranscript.transcript.some((i) => i.text.includes("已单向升级至"))).toBe(false);

    // Part B: Active escalation is NOT overwritten when settings change triggers #reconfigureWorkerConversations
    const escCard = await hub.dispatchTicket(
      {
        commandId: "cmd-settings-sync-1",
        title: "设置同步保护活跃升档",
        goal: "核实设置同步不降级",
        scope: "src",
        role: "scout",
      },
      context,
    );
    await strongArrived;

    // While ticket is actively running on escalated strong model, mutate role settings to trigger #reconfigureWorkerConversations!
    const settingsView = hub.getSettingsView();
    const updatedRoles = {
      ...settingsView.blocks.roles.value,
      scout: {
        ...settingsView.blocks.roles.value.scout!,
        modelId: "fast-alt",
      },
    };
    await hub.updateSettingsBlock(
      "roles",
      settingsView.blocks.roles.revision,
      updatedRoles as unknown as Record<string, unknown>,
      context,
    );

    // Verify AgentDoc stayed on escalated claude-opus-4 (NOT overwritten to gpt-4o!)
    const stateNow = await hub.harness.snapshot(KuloStateDoc, context);
    const liveTicket = stateNow?.tickets[escCard.id]!;
    const agentAfterSync = await hub.harness.snapshot(
      AgentDoc,
      liveTicket.workerConversationId as ConversationId,
      context,
    );
    expect(agentAfterSync?.model).toEqual({ provider: "anthropic-cloud", modelId: "claude-opus-4" });

    releaseStrongGate();
    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[escCard.id]?.status === "ready";
    }, "escalated ticket completes on strong model after settings sync");

    expect(faux.counts().strong).toBe(2);
    expect(faux.counts().fast).toBe(3);
  });

  it("preserves escalation state across mid-run user steer (normalizeDocForRun whitelist fix)", async () => {
    const rootDir = tempDir("kulo-esc-steer-");
    let strongTurn1Arrived!: () => void;
    const onStrongTurn1 = new Promise<void>((r) => {
      strongTurn1Arrived = r;
    });
    let releaseStrongTurn1!: () => void;
    const gateStrongTurn1 = new Promise<void>((r) => {
      releaseStrongTurn1 = r;
    });

    const faux = createDualFauxModels({
      fastHandler: () => toolTurn(fauxToolCall("read", { path: "steer-probe.txt" })),
      strongHandler: async (_req, turn) => {
        if (turn === 1) {
          strongTurn1Arrived();
          await gateStrongTurn1;
          return toolTurn(fauxToolCall("read", { path: "step-after-steer-1.txt" }));
        }
        // Repeat identical calls after steer to prove escalation state was NOT wiped by steer
        if (turn <= 4) {
          return toolTurn(fauxToolCall("read", { path: "same-after-steer.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "插话后仍保持升档模型且未二次升档。",
          }),
        );
      },
    });

    const hub = await openTestHub({
      config: makeHubConfig(rootDir, {
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
      }),
      models: faux.models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-steer-1",
        title: "插话保持升档状态",
        goal: "核实 steer 不丢状态",
        scope: "src",
        role: "scout",
      },
      context,
    );

    await onStrongTurn1;

    // Mid-run user steer while strong model is running!
    await hub.steerTicket(
      {
        ticketId: card.id,
        commandId: "steer-mid-run-1",
        text: "请顺便检查一下配置文件。",
      },
      context,
    );
    releaseStrongTurn1();

    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "ready";
    }, "steered escalated ticket completes");

    // Fast model never resumed; strong model ran all post-escalation turns (5 turns total)
    expect(faux.counts().fast).toBe(3);
    expect(faux.counts().strong).toBe(5);

    // Only ONE escalation timeline event (steer did NOT wipe RunHealthDoc.escalation or cause re-escalation!)
    const view = await hub.inspectTicketDetail(card.id, context);
    const escalationNotes = view.transcript.filter(
      (item) => item.role === "system_note" && item.text.includes("已单向升级至"),
    );
    expect(escalationNotes).toHaveLength(1);
  });

  it("rejects escalation and records skip reason when target model contextWindow < estimatedContext", async () => {
    const rootDir = tempDir("kulo-esc-ctx-");
    const warnings: string[] = [];
    const faux = createDualFauxModels({
      tinyContextWindow: 60, // Far smaller than the worker's system + user prompt!
      fastHandler: (_req, turn) => {
        if (turn <= 5) {
          return toolTurn(fauxToolCall("read", { path: "ctx-small-probe.txt" }));
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "blocked",
            summary: "上下文超出目标模型窗口，未升档，已收口汇报。",
            question: "是否需要手动切换更大窗口模型？",
          }),
        );
      },
      strongHandler: () => {
        throw new Error("Target model with insufficient contextWindow must NEVER be called!");
      },
    });

    const hub = await openTestHub({
      config: makeHubConfig(rootDir, {
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-tiny" },
      }),
      models: faux.models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const card = await hub.dispatchTicket(
      {
        commandId: "cmd-ctx-small-1",
        title: "目标窗口不足拒绝升档",
        goal: "这是一段足够长的任务描述用于确保上下文估算 token 数明显大于 60 tokens 以便触发目标模型上下文窗口不足保护。",
        scope: "packages/hub/src",
        role: "scout",
      },
      context,
    );

    await until(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[card.id]?.status === "waiting" && s.tickets[card.id]?.latestReport?.state === "blocked";
    }, "ticket stays on fast model and surfaces blocked");

    expect(faux.counts().strong).toBe(0);
    expect(faux.counts().fast).toBeGreaterThanOrEqual(5);

    const state = await hub.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[card.id]!;
    expect(ticket.modelEscalation).toBeUndefined();
    expect(ticket.runHealthStuck?.kind).toBe("doom_loop");

    const rhDoc = await hub.harness.snapshot(
      RunHealthDoc,
      ticket.workerConversationId as ConversationId,
      context,
    );
    expect(rhDoc?.lastEscalationSkip?.rejectReason).toBe("context_window_insufficient");
    expect(rhDoc?.lastEscalationSkip?.detail).toContain("claude-tiny");
    void warnings;
  });

  it("keeps escalated strong model consistent across quota pause same-model retry AND Hub restart recovery", async () => {
    const rootDir = tempDir("kulo-esc-quota-restart-");

    // --- Part A: Quota pause after auto-escalation + same-model retry ---
    let allowStrongAfterQuota = false;
    const faux1 = createDualFauxModels({
      fastHandler: (_req, turn) => {
        if (turn <= 3) return toolTurn(fauxToolCall("read", { path: "quota-probe.txt" }));
        throw new Error(`Fast model must not run after escalation (turn ${turn})`);
      },
      strongHandler: () => {
        if (!allowStrongAfterQuota) {
          return fauxAssistantMessage(fauxText(""), {
            stopReason: "error",
            errorMessage: '429 {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Monthly usage limit reached"}}',
          });
        }
        return toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "额度暂停同模重试后仍在强模型完成。",
          }),
        );
      },
    });

    const hub1 = await openTestHub({
      config: makeHubConfig(rootDir, {
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
      }),
      models: faux1.models,
    });
    cleanups.push(() => hub1.close().catch(() => {}));

    const quotaCard = await hub1.dispatchTicket(
      {
        commandId: "cmd-esc-quota-1",
        title: "升档后额度暂停恢复",
        goal: "测试额度暂停后保持强模型",
        scope: "src",
        role: "scout",
      },
      context,
    );

    await until(async () => {
      const s = await hub1.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[quotaCard.id]?.status === "waiting" && s.tickets[quotaCard.id]?.waiting?.reason === "quota";
    }, "escalated worker pauses on quota");

    // Verify quotaPause recorded the escalated strong model AND onTicketSettled preserved active modelEscalation!
    const pausedState = await hub1.harness.snapshot(KuloStateDoc, context);
    const pausedTicket = pausedState?.tickets[quotaCard.id]!;
    expect(pausedTicket.quotaPause?.provider).toBe("anthropic-cloud");
    expect(pausedTicket.quotaPause?.modelId).toBe("claude-opus-4");
    expect(pausedTicket.modelEscalation?.runEpoch).toBe(pausedTicket.runEpoch);
    expect(pausedTicket.modelEscalation?.escalatedModel.modelId).toBe("claude-opus-4");

    // User clicks "Retry" WITHOUT changing model -> must stay on claude-opus-4 (NEVER downgrade to fast-mini!)
    allowStrongAfterQuota = true;
    const retryRes = await hub1.resumeTicketWithOverride(
      quotaCard.id,
      { commandId: "retry-same-model-1" },
      context,
    );
    expect(retryRes.resumed).toBe(true);

    await until(async () => {
      const s = await hub1.harness.snapshot(KuloStateDoc, context);
      return s?.tickets[quotaCard.id]?.status === "ready";
    }, "quota-paused escalated ticket completes on strong model after retry");

    expect(faux1.counts().fast).toBe(3);
    expect(faux1.counts().strong).toBeGreaterThanOrEqual(2);
    await hub1.close(context);

    // --- Part B: Hub restart while an escalated readOnly ticket is running -> resumes on strong model ---
    const restartDir = tempDir("kulo-esc-restart-");
    let strongArrivedBeforeRestart!: () => void;
    const beforeRestartReady = new Promise<void>((r) => {
      strongArrivedBeforeRestart = r;
    });

    const fauxBefore = createDualFauxModels({
      fastHandler: () => toolTurn(fauxToolCall("read", { path: "restart-probe.txt" })),
      strongHandler: async (_req, turn, reqOptions) => {
        if (turn === 1) {
          strongArrivedBeforeRestart();
          const signal = (reqOptions as { signal?: AbortSignal } | undefined)?.signal;
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return fauxAssistantMessage([fauxText("中断中")]);
        }
        return toolTurn(fauxToolCall("kulo_report", { state: "ready", summary: "unexpected" }));
      },
    });

    const hubBefore = await openTestHub({
      config: makeHubConfig(restartDir, {
        scoutReadOnly: true,
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
      }),
      models: fauxBefore.models,
    });
    let hubBeforeClosed = false;
    cleanups.push(() => (hubBeforeClosed ? undefined : hubBefore.close().catch(() => {})));

    const restartCard = await hubBefore.dispatchTicket(
      {
        commandId: "cmd-esc-restart-1",
        title: "重启恢复后保持强模型",
        goal: "只读排查并重启恢复",
        scope: "src",
        role: "scout",
      },
      context,
    );

    await beforeRestartReady;
    // Confirm ticket is escalated before restart
    const preRestartTicket = (await hubBefore.harness.snapshot(KuloStateDoc, context))?.tickets[restartCard.id]!;
    expect(preRestartTicket.modelEscalation?.escalatedModel.modelId).toBe("claude-opus-4");

    // Graceful shutdown of hubBefore
    await hubBefore.close(context);
    hubBeforeClosed = true;

    // Reopen Hub on same stateDir with fresh dual faux models
    const fauxAfter = createDualFauxModels({
      fastHandler: () => {
        throw new Error("Fast model MUST NOT be invoked after Hub restart of an escalated ticket!");
      },
      strongHandler: () =>
        toolTurn(
          fauxToolCall("kulo_report", {
            state: "ready",
            summary: "重启恢复后保持强模型顺利完成。",
          }),
        ),
    });

    const hubAfter = await openTestHub({
      config: makeHubConfig(restartDir, {
        scoutReadOnly: true,
        escalationModel: { provider: "anthropic-cloud", modelId: "claude-opus-4" },
      }),
      models: fauxAfter.models,
    });
    cleanups.push(() => hubAfter.close().catch(() => {}));

    // Wait for readOnly graceful auto-resume (or user continue if waiting)
    let continued = false;
    await until(async () => {
      const s = await hubAfter.harness.snapshot(KuloStateDoc, context);
      const t = s?.tickets[restartCard.id];
      if (!t) return false;
      if (t.status === "waiting" && t.waiting?.reason === "user" && !continued) {
        continued = true;
        await hubAfter.steerTicket({ ticketId: t.id, commandId: "restart-continue-1", text: "继续执行" }, context);
        return false;
      }
      return t.status === "ready";
    }, "restarted escalated ticket completes on strong model");

    expect(fauxAfter.counts().fast).toBe(0);
    expect(fauxAfter.counts().strong).toBeGreaterThanOrEqual(1);
  });
});

describe("Stage 3 P1-3: Layer 2 async Judge escalation, late-verdict fencing, and §2.2 sentinel redaction", () => {
  async function openJudgeEscalationHarness(options: {
    evaluateJudge: () => Promise<RunHealthJudgeVerdict | null>;
    vaultSecret?: string;
    escalationModel?: RolePreset["escalationModel"];
    strongContextWindow?: number;
  }) {
    const dir = tempDir("kulo-esc-judge-");
    const vaultSecret = options.vaultSecret ?? "kulo_vault_sentinel_secret_987654";
    const redact = (text: string) => text.replaceAll(vaultSecret, "[已隐藏]");
    const rawStorage = await openNodeSqliteStorage(path.join(dir, "judge.sqlite"), context);
    const storage = wrapRedactedStorage(rawStorage, redact);

    const outboundModels: string[] = [];
    const models = createModels();
    const fastFaux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-4o-mini", contextWindow: 128_000 }],
    });
    const strongFaux = fauxProvider({
      provider: "anthropic-cloud",
      models: [{ id: "claude-opus-4", contextWindow: options.strongContextWindow ?? 200_000 }],
    });

    let fastTurn = 0;
    let strongTurn = 0;
    let fastGateResolve: (() => void) | undefined;
    let fastWaitTurn26: Promise<void> | undefined;

    fastFaux.setResponses(
      Array.from({ length: 40 }, () => async () => {
        fastTurn += 1;
        outboundModels.push("openai/gpt-4o-mini");
        if (fastTurn === 26 && fastWaitTurn26) {
          await fastWaitTurn26;
        }
        return toolTurn(fauxToolCall("probe", { note: `step-${fastTurn}` }));
      }),
    );
    strongFaux.setResponses(
      Array.from({ length: 10 }, () => () => {
        strongTurn += 1;
        outboundModels.push("anthropic-cloud/claude-opus-4");
        return toolTurn(fauxToolCall("kulo_report", { state: "ready", note: "done-on-strong" }));
      }),
    );
    models.setProvider(fastFaux.provider);
    models.setProvider(strongFaux.provider);

    let harnessRef: Harness | undefined;
    const rolePreset: RolePreset = {
      ...defaultRolePresets().scout!,
      provider: "openai",
      modelId: "gpt-4o-mini",
      thinkingLevel: "off",
      escalationModel: options.escalationModel ?? {
        provider: "anthropic-cloud",
        modelId: "claude-opus-4",
      },
    };
    const modelConfig = makeBaseModelConfig();

    const runHealth = createRunHealthController({
      getHarness: () => harnessRef,
      getModels: () => models,
      getSettings: () => ({
        roles: { scout: rolePreset },
        model: modelConfig,
        fallbackProviderId: "openai",
      }),
      redact,
      evaluateJudge: () => options.evaluateJudge(),
    });

    const mkTool = (name: string, terminate = false) =>
      defineTool({
        name,
        description: `Tool ${name}`,
        parameters: obj({ state: opt(str()), note: opt(str()) }),
        execute: async () => ({
          output: [{ type: "text", text: `${name}:ok` }],
          ...(terminate ? { control: { terminate: true } } : {}),
        }),
      });

    const toolsExt = defineExtension({
      name: "judge-test-tools",
      tools: [mkTool("probe"), mkTool("kulo_report", true)],
    });

    const registry = createRegistry();
    registry.install(toolsExt);
    registry.install(runHealth.extension);
    registry.install(defineExtension({ name: "kulo-state-doc", docs: [KuloStateDoc] }));

    const harness = await Harness.open(storage, { models, registry }, context);
    harnessRef = harness;
    cleanups.push(async () => {
      runHealth.close();
      await harness.close(context);
      await storage.close(context);
    });

    const conv = await harness.root(context, {
      agent: {
        model: { provider: "openai", modelId: "gpt-4o-mini" },
        thinkingLevel: "off",
        extensions: [toolsExt, runHealth.extension],
        maxTurns: 40,
      },
    });

    const ticketId = "T-0001";
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[ticketId] = {
        id: ticketId,
        commandId: "cmd-judge-1",
        title: "Judge escalation ticket",
        goal: "Test Layer 2 judge escalation",
        scope: "src",
        role: "scout",
        status: "running",
        envId: "local",
        workspaceDir: dir,
        workerConversationId: Number(conv.id),
        runEpoch: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.conversationToTicket[String(conv.id)] = ticketId;
    }, context);

    return {
      harness,
      conv,
      runHealth,
      ticketId,
      vaultSecret,
      outboundModels,
      pauseTurn26: () => {
        fastWaitTurn26 = new Promise<void>((r) => {
          fastGateResolve = r;
        });
      },
      releaseTurn26: () => fastGateResolve?.(),
    };
  }

  it("escalates via Layer 2 Judge stuck verdict with sentinel API key + Vault secret redacted cleanly (zero documentLeak)", async () => {
    const apiKeySentinel = "sk-test-sentinel-1234567890abcdef";
    const vaultSecret = "kulo_vault_sentinel_secret_987654";
    let resolveJudge!: (v: RunHealthJudgeVerdict) => void;
    let judgeStarted!: () => void;
    const onJudgeStart = new Promise<void>((r) => {
      judgeStarted = r;
    });

    const env = await openJudgeEscalationHarness({
      vaultSecret,
      evaluateJudge: () => {
        judgeStarted();
        return new Promise<RunHealthJudgeVerdict>((r) => {
          resolveJudge = r;
        });
      },
    });
    env.pauseTurn26();

    const runPromise = env.conv.submit(
      { type: "input", content: "Run 25+ distinct steps until Layer 2 judge flags stuck" },
      context,
    );
    void runPromise;

    await onJudgeStart;

    // Resolve Layer 2 judge with BOTH sentinel API key and Vault secret inside reason!
    resolveJudge({
      verdict: "stuck",
      reason: `Repeated futile probing using key=${apiKeySentinel} and vault=${vaultSecret}`,
    });
    await env.runHealth.waitForPendingJudges();

    // Release turn 26 so the next turn picks up the escalated strong model from AgentDoc!
    env.releaseTurn26();

    await until(
      () => env.outboundModels.includes("anthropic-cloud/claude-opus-4"),
      "outbound request switches to strong model after Layer 2 judge escalation",
    );

    // Inspect KuloStateDoc, RunHealthDoc, and RunHealthEscalationEntry — zero documentLeak and full redaction!
    const state = await env.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[env.ticketId]!;
    expect(ticket.modelEscalation?.escalatedModel.modelId).toBe("claude-opus-4");
    expect(ticket.modelEscalation?.reason).not.toContain(apiKeySentinel);
    expect(ticket.modelEscalation?.reason).not.toContain(vaultSecret);

    const rhDoc = await env.harness.snapshot(RunHealthDoc, env.conv.id, context);
    expect(rhDoc?.escalation?.modelId).toBe("claude-opus-4");
    expect(rhDoc?.escalation?.reason).not.toContain(apiKeySentinel);
    expect(rhDoc?.escalation?.reason).not.toContain(vaultSecret);

    const entries = await env.conv.entries({ order: "ascending" }, 200, undefined, context);
    const escEntry = entries.items.find(RunHealthEscalationEntry.is);
    expect(escEntry).toBeDefined();
    expect(escEntry?.data.text).toContain("已单向升级至 claude-opus-4 继续排障");
    expect(escEntry?.data.reason).not.toContain(apiKeySentinel);
    expect(escEntry?.data.reason).not.toContain(vaultSecret);

    // Confirm resolveWorkerEffectiveModel recognizes the escalated model while running
    const resolved = resolveWorkerEffectiveModel({
      ticket,
      rolePreset: { provider: "openai", modelId: "gpt-4o-mini", thinkingLevel: "off" },
      defaultModel: { provider: "openai", modelId: "gpt-4o-mini", thinkingLevel: "off" },
    });
    expect(resolved.source).toBe("escalation");
    expect(resolved.modelId).toBe("claude-opus-4");
  });

  it("drops late Layer 2 Judge verdict when runEpoch advances or ticket reaches terminal status before judge completes", async () => {
    // --- Case 1: runEpoch changed while Layer 2 judge was in flight ---
    let resolveJudge1!: (v: RunHealthJudgeVerdict) => void;
    let judge1Started!: () => void;
    const onJudge1Start = new Promise<void>((r) => {
      judge1Started = r;
    });

    const env1 = await openJudgeEscalationHarness({
      evaluateJudge: () => {
        judge1Started();
        return new Promise<RunHealthJudgeVerdict>((r) => {
          resolveJudge1 = r;
        });
      },
    });
    env1.pauseTurn26();
    void env1.conv.submit({ type: "input", content: "Trigger turn-25 judge then advance runEpoch" }, context);
    await onJudge1Start;

    // Advance ticket.runEpoch from 1 -> 2 before the in-flight judge finishes!
    await env1.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[env1.ticketId]!.runEpoch = 2;
    }, context);

    resolveJudge1({ verdict: "stuck", reason: "stale epoch-1 judge verdict" });
    await env1.runHealth.waitForPendingJudges();

    const state1 = await env1.harness.snapshot(KuloStateDoc, context);
    expect(state1?.tickets[env1.ticketId]?.modelEscalation).toBeUndefined();
    expect(state1?.tickets[env1.ticketId]?.runHealthStuck).toBeUndefined();
    const agent1 = await env1.harness.snapshot(AgentDoc, env1.conv.id, context);
    expect(agent1?.model).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
    const rh1 = await env1.harness.snapshot(RunHealthDoc, env1.conv.id, context);
    expect(rh1?.escalation).toBeUndefined();
    expect(rh1?.forceWrapUp).toBeUndefined();
    env1.releaseTurn26();
    await env1.conv.abort(context, { background: true });

    // --- Case 2: Ticket settled (stopped/ready) while Layer 2 judge was in flight ---
    let resolveJudge2!: (v: RunHealthJudgeVerdict) => void;
    let judge2Started!: () => void;
    const onJudge2Start = new Promise<void>((r) => {
      judge2Started = r;
    });

    const env2 = await openJudgeEscalationHarness({
      evaluateJudge: () => {
        judge2Started();
        return new Promise<RunHealthJudgeVerdict>((r) => {
          resolveJudge2 = r;
        });
      },
    });
    env2.pauseTurn26();
    void env2.conv.submit({ type: "input", content: "Trigger turn-25 judge then settle ticket" }, context);
    await onJudge2Start;

    // Mark ticket terminal ("ready") and abort active run before judge resolves
    await env2.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[env2.ticketId]!.status = "ready";
    }, context);
    await env2.runHealth.onTicketSettled(env2.ticketId, context);

    resolveJudge2({ verdict: "stuck", reason: "late verdict after terminal settlement" });
    await env2.runHealth.waitForPendingJudges();

    const state2 = await env2.harness.snapshot(KuloStateDoc, context);
    expect(state2?.tickets[env2.ticketId]?.modelEscalation).toBeUndefined();
    expect(state2?.tickets[env2.ticketId]?.runHealthStuck).toBeUndefined();
    const agent2 = await env2.harness.snapshot(AgentDoc, env2.conv.id, context);
    expect(agent2?.model).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
    env2.releaseTurn26();
    await env2.conv.abort(context, { background: true });
  });
});
