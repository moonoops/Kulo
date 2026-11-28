import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_EXTERNAL_EFFORTS,
  normalizeExternalContextUsage,
  resolveExternalModelEffortPolicy,
  type ExternalAgentModelInfo,
  type ExternalAgentRun,
  type RolePreset,
  type TicketRecord,
} from "@kulo/protocol";
import { extractModelsFromAcpModelState } from "../packages/env/src/external-agent-acp.js";
import {
  connectAcp,
  isProtectedAcpPath,
  modelsFromConfig,
  type ExternalDriverContext,
} from "../packages/env/src/external-agent-drivers.js";
import type { ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
import { isExternalAgentResponse } from "../packages/env/src/external-agent-validation.js";
import { ExternalAgentService } from "../packages/env/src/external-agents.js";
import { buildWorkerSandboxProfile, defaultProtectedPaths } from "../packages/env/src/isolation.js";
import { EnvManager } from "../packages/env/src/bridge.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";
import { wrapRedactedStorage } from "../packages/hub/src/credential-redaction.js";
import {
  applyExternalRunSnapshotToTicket,
  ExternalTelemetryCache,
} from "../packages/hub/src/scheduler-external-settle.js";
import { applySettingsBlockUpdate, KuloSettingsDoc, syncExternalClientsInSettings } from "../packages/hub/src/settings.js";
import { KuloSkills } from "../packages/hub/src/skills.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

describe("Stage 1 P0-1: tri-state effort capability & xhigh support", () => {
  it("resolves tri-state effortCapability consistently and includes xhigh in antigravity fallback", () => {
    expect(FALLBACK_EXTERNAL_EFFORTS.antigravity).toEqual(["low", "medium", "high", "xhigh"]);

    const supported = resolveExternalModelEffortPolicy(
      { efforts: ["low", "high", "xhigh"], effortCapability: "supported" },
      "antigravity",
    );
    expect(supported).toEqual({
      capability: "supported",
      showSelector: true,
      efforts: ["low", "high", "xhigh"],
      usesFallback: false,
    });

    const unsupported = resolveExternalModelEffortPolicy(
      { effortCapability: "unsupported" },
      "antigravity",
    );
    expect(unsupported).toEqual({
      capability: "unsupported",
      showSelector: false,
      efforts: [],
      usesFallback: false,
    });

    const unknown = resolveExternalModelEffortPolicy(
      { effortCapability: "unknown" },
      "antigravity",
    );
    expect(unknown).toEqual({
      capability: "unknown",
      showSelector: true,
      efforts: ["low", "medium", "high", "xhigh"],
      usesFallback: true,
    });

    // Legacy saved model without explicit effortCapability still infers unsupported when siblings have efforts
    const legacySiblings: ExternalAgentModelInfo[] = [
      { id: "claude-opus", name: "Claude Opus", efforts: ["low", "high", "xhigh"] },
      { id: "orchestrator-neon", name: "Orchestrator (Neon)" },
    ];
    expect(resolveExternalModelEffortPolicy(legacySiblings[1], "antigravity", legacySiblings)).toEqual({
      capability: "unsupported",
      showSelector: false,
      efforts: [],
      usesFallback: false,
    });
  });

  it("extracts exact tri-state effortCapability in extractModelsFromAcpModelState and modelsFromConfig", () => {
    const agyState = extractModelsFromAcpModelState({
      currentModelId: "claude-opus?thinkingLevel=high",
      availableModels: [
        { modelId: "claude-opus?thinkingLevel=low", name: "Claude Opus" },
        { modelId: "claude-opus?thinkingLevel=medium", name: "Claude Opus" },
        { modelId: "claude-opus?thinkingLevel=high", name: "Claude Opus" },
        { modelId: "claude-opus?thinkingLevel=xhigh", name: "Claude Opus" },
        { modelId: "orchestrator-neon", name: "Orchestrator (Neon)" },
      ],
    });
    expect(agyState.models).toEqual([
      {
        id: "claude-opus",
        name: "Claude Opus",
        efforts: ["low", "medium", "high", "xhigh"],
        effortCapability: "supported",
        isDefault: true,
      },
      {
        id: "orchestrator-neon",
        name: "Orchestrator (Neon)",
        effortCapability: "unsupported",
      },
    ]);

    const explicitDisabled = extractModelsFromAcpModelState({
      availableModels: [
        { modelId: "solo-fast", name: "Solo Fast", _meta: { supportsReasoningEffort: false } },
      ],
    });
    expect(explicitDisabled.models).toEqual([
      { id: "solo-fast", name: "Solo Fast", effortCapability: "unsupported" },
    ]);

    const unknownOnly = extractModelsFromAcpModelState({
      availableModels: [{ modelId: "plain-model", name: "Plain" }],
    });
    expect(unknownOnly.models).toEqual([
      { id: "plain-model", name: "Plain", effortCapability: "unknown" },
    ]);

    // modelsFromConfig preserves per-model unsupported on Orchestrator even when configOptions has thought_level
    const cfg = modelsFromConfig({
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "claude-opus",
          options: [
            { value: "claude-opus", name: "Claude Opus" },
            { value: "orchestrator-neon", name: "Orchestrator (Neon)" },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          options: [{ value: "low" }, { value: "high" }, { value: "xhigh" }],
        },
        {
          id: "mode",
          category: "mode",
          currentValue: "plan",
        },
      ],
      modes: { currentModeId: "legacy-default" },
      models: {
        currentModelId: "claude-opus?thinkingLevel=high",
        availableModels: [
          { modelId: "claude-opus?thinkingLevel=low", name: "Claude Opus" },
          { modelId: "claude-opus?thinkingLevel=high", name: "Claude Opus" },
          { modelId: "claude-opus?thinkingLevel=xhigh", name: "Claude Opus" },
          { modelId: "orchestrator-neon", name: "Orchestrator (Neon)" },
        ],
      },
    });
    expect(cfg.currentModeId).toBe("plan");
    expect(cfg.models.find((m) => m.id === "orchestrator-neon")).toEqual({
      id: "orchestrator-neon",
      name: "Orchestrator (Neon)",
      effortCapability: "unsupported",
    });
    expect(cfg.models.find((m) => m.id === "claude-opus")?.efforts).toEqual(["low", "high", "xhigh"]);
  });

  it("clears stale thinkingLevel on unsupported models in settings-roles save validation while preserving valid xhigh", () => {
    const doc = KuloSettingsDoc.definition.initial();
    const baseRole: RolePreset = {
      id: "coder",
      label: "Coder",
      whenToUse: "Coding",
      prompt: "Code cleanly",
      enabled: true,
      readOnly: false,
      allowSubagents: false,
      thinkingLevel: "auto",
    };
    doc.roles = { coder: baseRole };
    syncExternalClientsInSettings(doc, undefined, undefined, undefined, {
      "antigravity:local": {
        id: "antigravity:local",
        kind: "antigravity",
        envId: "local",
        verifiedAt: 100,
        updatedAt: 100,
        models: [
          { id: "claude-opus", name: "Claude Opus", efforts: ["low", "medium", "high", "xhigh"], effortCapability: "supported", isDefault: true },
          { id: "orchestrator-neon", name: "Orchestrator (Neon)", effortCapability: "unsupported" },
        ],
      },
    });

    // Valid xhigh on supported model is preserved
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, {
      ...doc.roles,
      "agy-opus": {
        ...baseRole,
        id: "agy-opus",
        label: "Agy Opus",
        externalClientId: "antigravity:local",
        modelId: "claude-opus",
        thinkingLevel: "xhigh",
      },
      // Stale thinkingLevel on unsupported Orchestrator is auto-cleared to "auto"
      "agy-orch": {
        ...baseRole,
        id: "agy-orch",
        label: "Agy Orchestrator",
        externalClientId: "antigravity:local",
        modelId: "orchestrator-neon",
        thinkingLevel: "high",
      },
    });

    expect(doc.roles["agy-opus"]?.thinkingLevel).toBe("xhigh");
    expect(doc.roles["agy-orch"]?.thinkingLevel).toBe("auto");
  });

  it("connectAcp passes xhigh via configOptions, drops stale thinkingLevel for Orchestrator without throwing, and NEVER sends set_mode(auto)", async () => {
    const root = tempDir("kulo-acp-effort-");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);

    const runScenario = async (opts: { modelId: string; thinkingLevel?: string; trustMode?: "trusted" | "sandboxed" }) => {
      const sent: Array<Record<string, unknown>> = [];
      let spec!: ExternalAgentPipeOptions;
      const reply = (id: number, result: unknown) =>
        spec.onStdout(Buffer.from(`${JSON.stringify({ id, result })}\n`));
      const ctx: ExternalDriverContext = {
        binding: { kind: "antigravity", envId: "local" },
        executable: process.execPath,
        cwd,
        prompt: "inspect repo",
        modelId: opts.modelId,
        thinkingLevel: opts.thinkingLevel,
        runEpoch: 1,
        trustMode: opts.trustMode ?? "trusted",
        timeoutMs: 10_000,
        readOnly: false,
        controlRoot: path.join(root, "control"),
        servers: [],
        event: vi.fn(),
        activity: vi.fn(),
        session: vi.fn(),
        submitted: vi.fn(),
        complete: vi.fn(),
        permission: vi.fn(async () => "allow"),
        pipe: async (value) => {
          spec = value;
          return {
            exited: new Promise(() => {}),
            close: vi.fn(),
            cleanup: async () => true,
            write: (raw) => {
              const msg = JSON.parse(raw) as Record<string, unknown>;
              sent.push(msg);
              const id = typeof msg.id === "number" ? msg.id : undefined;
              const method = typeof msg.method === "string" ? msg.method : undefined;
              if (id === undefined || !method) return;
              if (method === "initialize") {
                reply(id, { protocolVersion: 1, agentCapabilities: {} });
              } else if (method === "session/new") {
                reply(id, {
                  sessionId: "agy-sess-1",
                  configOptions: [
                    {
                      id: "model",
                      category: "model",
                      currentValue: "claude-opus",
                      options: [
                        { value: "claude-opus", name: "Claude Opus" },
                        { value: "orchestrator-neon", name: "Orchestrator (Neon)" },
                      ],
                    },
                    {
                      id: "thought_level",
                      category: "thought_level",
                      options: [
                        { value: "low" },
                        { value: "medium" },
                        { value: "high" },
                        { value: "xhigh" },
                      ],
                    },
                  ],
                  models: {
                    currentModelId: "claude-opus?thinkingLevel=high",
                    availableModels: [
                      { modelId: "claude-opus?thinkingLevel=low", name: "Claude Opus" },
                      { modelId: "claude-opus?thinkingLevel=medium", name: "Claude Opus" },
                      { modelId: "claude-opus?thinkingLevel=high", name: "Claude Opus" },
                      { modelId: "claude-opus?thinkingLevel=xhigh", name: "Claude Opus" },
                      { modelId: "orchestrator-neon", name: "Orchestrator (Neon)" },
                    ],
                  },
                });
              } else if (method === "session/set_config_option") {
                const params = msg.params as Record<string, unknown>;
                if (params.configId === "model" && params.value === "orchestrator-neon") {
                  // Orchestrator drops thought_level from configOptions on switch
                  reply(id, {
                    configOptions: [
                      {
                        id: "model",
                        category: "model",
                        currentValue: "orchestrator-neon",
                        options: [
                          { value: "claude-opus", name: "Claude Opus" },
                          { value: "orchestrator-neon", name: "Orchestrator (Neon)" },
                        ],
                      },
                    ],
                  });
                } else {
                  reply(id, {});
                }
              } else if (method === "session/prompt") {
                reply(id, { stopReason: "end_turn" });
              }
            },
          };
        },
      };
      const res = await connectAcp(ctx, false);
      res.driver.close();
      return { sent, ctx, models: res.models };
    };

    // 1. Supported model with xhigh passes xhigh through configOptions and never calls set_mode
    const xhighRun = await runScenario({ modelId: "claude-opus", thinkingLevel: "xhigh", trustMode: "trusted" });
    const configCalls = xhighRun.sent.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
    expect(configCalls).toEqual([
      { sessionId: "agy-sess-1", configId: "model", value: "claude-opus" },
      { sessionId: "agy-sess-1", configId: "thought_level", value: "xhigh" },
    ]);
    // Negative assertion: connectAcp NEVER sends session/set_mode or auto mode even in trusted mode
    expect(xhighRun.sent.some((m) => m.method === "session/set_mode")).toBe(false);
    expect(
      xhighRun.sent.some(
        (m) => m.method === "session/set_config_option" && (m.params as Record<string, unknown>)?.value === "auto",
      ),
    ).toBe(false);

    // 2. Switching to Orchestrator (Neon) with stale thinkingLevel="high" omits thought_level and does NOT throw
    const orchRun = await runScenario({ modelId: "orchestrator-neon", thinkingLevel: "high", trustMode: "trusted" });
    const orchConfigCalls = orchRun.sent.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
    expect(orchConfigCalls).toEqual([
      { sessionId: "agy-sess-1", configId: "model", value: "orchestrator-neon" },
    ]);
    expect(orchRun.ctx.submitted).toHaveBeenCalledTimes(1);
    expect(orchRun.sent.some((m) => m.method === "session/set_mode")).toBe(false);
  });
});

describe("Stage 1 P0-1: pre-submit telemetry, zero write amplification, fail-closed permissions, and sandbox protection", () => {
  it("consumes pre-submit usage_update (including used=0 and unknown window) and current_mode_update while rejecting unknown sessionId permissions", async () => {
    const root = tempDir("kulo-acp-telemetry-");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    let spec!: ExternalAgentPipeOptions;
    const responses = new Map<number | string, Record<string, unknown>>();
    const reply = (id: number, result: unknown) =>
      spec.onStdout(Buffer.from(`${JSON.stringify({ id, result })}\n`));
    const emit = (payload: unknown) => spec.onStdout(Buffer.from(`${JSON.stringify(payload)}\n`));
    const usageUpdates: Array<{ usedTokens: number; contextWindow?: number; percent?: number; sessionId: string; runEpoch: number }> = [];
    const modeUpdates: Array<{ mode: string; sessionId: string; runEpoch: number }> = [];
    const permission = vi.fn(async () => "allow");

    const ctx: ExternalDriverContext = {
      binding: { kind: "antigravity", envId: "mac-1" },
      executable: process.execPath,
      cwd,
      prompt: "check telemetry",
      modelId: "claude-opus",
      sessionId: "sess-resumed",
      runEpoch: 2,
      timeoutMs: 10_000,
      readOnly: false,
      controlRoot: path.join(root, "control"),
      servers: [],
      event: vi.fn(),
      activity: vi.fn(),
      contextUsage: (usage, scope) => usageUpdates.push({ ...usage, sessionId: scope.sessionId, runEpoch: scope.runEpoch }),
      sessionMode: (mode, scope) => modeUpdates.push({ mode, sessionId: scope.sessionId, runEpoch: scope.runEpoch }),
      session: vi.fn(),
      submitted: vi.fn(),
      complete: vi.fn(),
      permission,
      pipe: async (value) => {
        spec = value;
        return {
          exited: new Promise(() => {}),
          close: vi.fn(),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            if (!msg.method) {
              responses.set(msg.id as number | string, msg);
              return;
            }
            const id = msg.id as number;
            if (msg.method === "initialize") {
              reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
            } else if (msg.method === "session/resume") {
              // Pre-submit notifications during session/resume (BEFORE submitted=true!):
              // 1) Stale/foreign session must be dropped
              emit({ method: "session/update", params: { sessionId: "foreign-sess", update: { sessionUpdate: "usage_update", used: 99999, size: 100000 } } });
              emit({ method: "session/update", params: { sessionId: "foreign-sess", update: { sessionUpdate: "current_mode_update", currentModeId: "rogue" } } });
              // 2) Matching session with used=0 and known window
              emit({ method: "session/update", params: { sessionId: "sess-resumed", update: { sessionUpdate: "usage_update", used: 0, size: 200000 } } });
              // 3) Matching session current_mode_update before submitted=true
              emit({ method: "session/update", params: { sessionId: "sess-resumed", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } });
              reply(id, {
                sessionId: "sess-resumed",
                modes: { currentModeId: "default" },
                configOptions: [
                  { id: "model", category: "model", currentValue: "claude-opus", options: [{ value: "claude-opus", name: "Claude Opus" }] },
                ],
              });
            } else if (msg.method === "session/set_config_option") {
              // Pre-submit notification during model switch with unknown window (size: 0 -> omit percent)
              emit({ method: "session/update", params: { sessionId: "sess-resumed", update: { sessionUpdate: "usage_update", used: 1200, size: 0 } } });
              reply(id, {});
            } else if (msg.method === "session/prompt") {
              // Keep open so we can send permission request with unknown sessionId
            }
          },
        };
      },
    };

    const res = await connectAcp(ctx, false);
    try {
      expect(usageUpdates).toHaveLength(2);
      expect(usageUpdates[0]).toMatchObject({ usedTokens: 0, contextWindow: 200_000, percent: 0, sessionId: "sess-resumed", runEpoch: 2 });
      expect(usageUpdates[1]).toMatchObject({ usedTokens: 1200, sessionId: "sess-resumed", runEpoch: 2 });
      expect(usageUpdates[1]?.contextWindow).toBeUndefined();
      expect(usageUpdates[1]?.percent).toBeUndefined();
      // Pre-submit current_mode_update ("plan") must not be clobbered by stale session.modes ("default")
      expect(modeUpdates).toEqual([{ mode: "plan", sessionId: "sess-resumed", runEpoch: 2 }]);

      // Negative fail-closed assertion: unknown sessionId permission request is REJECTED and never reaches ctx.permission
      emit({
        id: 501,
        method: "session/request_permission",
        params: {
          sessionId: "unknown-subagent-session",
          toolCall: { toolCallId: "sub-1", title: "Run rm -rf" },
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        },
      });
      await vi.waitFor(() => expect(responses.has(501)).toBe(true));
      expect(responses.get(501)?.error).toMatchObject({ code: -32603, message: expect.stringMatching(/Client refused/i) });
      expect(permission).not.toHaveBeenCalled();
    } finally {
      res.driver.close();
    }
  });

  it("keeps Env telemetry in memory without extra receipt writes and filters late cross-epoch / wrong-session updates in Hub without write amplification", async () => {
    // 1. Validate ExternalAgentResponse accepts telemetry & legacy runs without telemetry
    const baseRun: ExternalAgentRun = {
      id: "kulo:external:T-1:2",
      taskId: "T-1",
      runEpoch: 2,
      kind: "antigravity",
      sessionId: "sess-2",
      state: "running",
      text: "",
      events: [],
      permissions: [],
      nextSequence: 1,
    };
    expect(isExternalAgentResponse({ type: "run", run: baseRun })).toBe(true);
    expect(
      isExternalAgentResponse({
        type: "run",
        run: {
          ...baseRun,
          contextUsage: { usedTokens: 0, updatedAt: 100 },
          activeSessionMode: "plan",
        },
      }),
    ).toBe(true);
    // Reject invalid percent when contextWindow is absent
    expect(
      isExternalAgentResponse({
        type: "run",
        run: {
          ...baseRun,
          contextUsage: { usedTokens: 10, percent: 50, updatedAt: 100 },
        },
      }),
    ).toBe(false);

    // 2. ExternalAgentService keeps usage_update purely in memory (zero extra receipt disk writes)
    const root = tempDir("kulo-ext-mem-telemetry-");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "private", "grants.json"),
      scratchRoot: path.join(root, "scratch"),
    });
    let pipeSpec!: ExternalAgentPipeOptions;
    const emit = (payload: unknown) => pipeSpec.onStdout(Buffer.from(`${JSON.stringify(payload)}\n`));
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: root,
      projectRegistry: registry,
      pipeFactory: async (spec) => {
        pipeSpec = spec;
        let exitResolve!: (code: number) => void;
        return {
          exited: new Promise<number>((resolve) => { exitResolve = resolve; }),
          close: () => exitResolve(0),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            if (msg.method === "initialize") emit({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
            else if (msg.method === "session/new") emit({ id: msg.id, result: { sessionId: "agy-live-1", modes: { currentModeId: "default" } } });
          },
        };
      },
    });
    cleanups.push(() => service.close());

    await service.request({
      operation: "run",
      binding: { kind: "antigravity", envId: "local", executable: process.execPath },
      taskId: "T-10",
      runEpoch: 1,
      requestId: "kulo:external:T-10:1",
      prompt: "hello",
      cwd,
      readOnly: true,
      allowSubagents: false,
      timeoutMs: 10_000,
    });
    await vi.waitFor(async () => {
      const r = await service.request({ operation: "inspect", runId: "kulo:external:T-10:1" });
      expect(r.type === "run" && r.run.state === "running").toBe(true);
    });

    // Trigger one initial activity heartbeat so subsequent burst of usage_update notifications tests pure telemetry memory-only path
    emit({ method: "session/update", params: { sessionId: "agy-live-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "..." } } } });
    await vi.waitFor(async () => {
      const r = await service.request({ operation: "inspect", runId: "kulo:external:T-10:1" });
      expect(r.type === "run" && r.run.events.some((e) => e.text === "Thinking...")).toBe(true);
    });

    const writeSpy = vi.spyOn(fs, "writeFileSync");
    emit({ method: "session/update", params: { sessionId: "agy-live-1", update: { sessionUpdate: "usage_update", used: 2500, size: 100_000 } } });
    emit({ method: "session/update", params: { sessionId: "agy-live-1", update: { sessionUpdate: "usage_update", used: 5000, size: 100_000 } } });
    emit({ method: "session/update", params: { sessionId: "agy-live-1", update: { sessionUpdate: "usage_update", used: 7500, size: 100_000 } } });
    // Stale session packet must be dropped
    emit({ method: "session/update", params: { sessionId: "old-session", update: { sessionUpdate: "usage_update", used: 999_999, size: 1_000_000 } } });
    await vi.waitFor(async () => {
      const r = await service.request({ operation: "inspect", runId: "kulo:external:T-10:1" });
      expect(r.type === "run" && r.run.contextUsage?.usedTokens === 7500).toBe(true);
    });
    const inspected = await service.request({ operation: "inspect", runId: "kulo:external:T-10:1" });
    expect(inspected.type).toBe("run");
    if (inspected.type === "run") {
      expect(inspected.run.contextUsage).toMatchObject({ usedTokens: 7500, contextWindow: 100_000, percent: 8 });
      expect(inspected.run.activeSessionMode).toBe("default");
    }
    // Zero disk writes triggered by high-frequency usage_update notifications
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();

    // 3. Hub ExternalTelemetryCache drops stale runEpoch / wrong envId / wrong sessionId
    const cache = new ExternalTelemetryCache();
    expect(
      cache.update({
        ticketId: "T-1",
        envId: "mac-1",
        runEpoch: 2,
        sessionId: "sess-2",
        contextUsage: { usedTokens: 4000, contextWindow: 200_000, percent: 2, updatedAt: 200 },
        activeSessionMode: "plan",
      }).changed,
    ).toBe(true);
    // Late epoch-1 packet dropped
    expect(
      cache.update({
        ticketId: "T-1",
        envId: "mac-1",
        runEpoch: 1,
        sessionId: "sess-1",
        contextUsage: { usedTokens: 99_999, contextWindow: 200_000, percent: 50, updatedAt: 999 },
      }).changed,
    ).toBe(false);
    // Mismatched sessionId in same epoch dropped
    expect(
      cache.update({
        ticketId: "T-1",
        envId: "mac-1",
        runEpoch: 2,
        sessionId: "sess-old",
        contextUsage: { usedTokens: 88_888, contextWindow: 200_000, percent: 44, updatedAt: 999 },
      }).changed,
    ).toBe(false);
    // Out-of-order older updatedAt dropped
    expect(
      cache.update({
        ticketId: "T-1",
        envId: "mac-1",
        runEpoch: 2,
        sessionId: "sess-2",
        contextUsage: { usedTokens: 1000, contextWindow: 200_000, percent: 1, updatedAt: 100 },
      }).changed,
    ).toBe(false);
    expect(cache.get("T-1", { envId: "mac-1", runEpoch: 2, sessionId: "sess-2" })).toEqual({
      contextUsage: { usedTokens: 4000, contextWindow: 200_000, percent: 2, updatedAt: 200 },
      activeSessionMode: "plan",
    });
    expect(cache.get("T-1", { envId: "mac-1", runEpoch: 1 })).toBeUndefined();

    // 4. applyExternalRunSnapshotToTicket has ZERO KuloStateDoc write amplification on telemetry-only polls,
    //    and piggybacks telemetry on existing receipt merge / terminal settlement + redacts sentinel secrets
    const ticket: TicketRecord = {
      id: "T-1",
      commandId: "cmd-1",
      title: "Test",
      goal: "Test",
      scope: "Test",
      role: "agy",
      status: "running",
      envId: "mac-1",
      workspaceDir: "/tmp/work",
      workerConversationId: 1,
      runEpoch: 2,
      createdAt: 1,
      updatedAt: 1,
      externalExecution: {
        binding: { kind: "antigravity", envId: "mac-1" },
        runId: "kulo:external:T-1:2",
        sessionId: "sess-2",
        lastSequence: 0,
        pendingPermissions: [],
        phase: "investigating",
      },
    };
    const beforeSnapshot = JSON.stringify(ticket);
    // Telemetry-only poll (no new events, no durable changes, non-terminal)
    applyExternalRunSnapshotToTicket(
      ticket,
      {
        ...baseRun,
        phase: "investigating",
        contextUsage: { usedTokens: 8000, contextWindow: 200_000, percent: 4, updatedAt: 300 },
        activeSessionMode: "plan",
      },
      2,
      (v) => v,
    );
    expect(JSON.stringify(ticket)).toBe(beforeSnapshot);
    expect(ticket.externalExecution?.contextUsage).toBeUndefined();

    // Terminal settlement piggybacks telemetry and redacts secrets cleanly through wrapRedactedStorage
    const secretSentinel = "sk-test-sentinel-secret-9876543210";
    const redact = (value: string) => value.split(secretSentinel).join("[已隐藏]");
    applyExternalRunSnapshotToTicket(
      ticket,
      {
        ...baseRun,
        state: "completed",
        phase: "responding",
        contextUsage: { usedTokens: 0, updatedAt: 400 },
        activeSessionMode: `mode-${secretSentinel}`,
      },
      2,
      redact,
    );
    expect(ticket.externalExecution?.contextUsage).toEqual({ usedTokens: 0, updatedAt: 400 });
    expect(ticket.externalExecution?.activeSessionMode).not.toContain(secretSentinel);

    // Commit through wrapRedactedStorage to verify zero credential_document_leak (§2.2)
    const storage = wrapRedactedStorage(new MemoryStorage(), redact);
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "test", models: [{ id: "m1" }] }).provider);
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    await harness.commit(async (tx) => {
      const doc = await tx.doc(KuloStateDoc);
      doc.tickets[ticket.id] = structuredClone(ticket);
    }, BACKGROUND_CONTEXT);
    const committed = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[ticket.id];
    expect(committed?.externalExecution?.contextUsage).toEqual({ usedTokens: 0, updatedAt: 400 });
    expect(committed?.externalExecution?.activeSessionMode).not.toContain(secretSentinel);
  });

  it("protects ~/.agents in sandbox & ACP writes, allows antigravity read of ~/.agents/skills, and keeps Hub skills isolated from ~/.agents/skills", async () => {
    const fakeHome = "/tmp/kulo-fake-home-agents";
    expect(defaultProtectedPaths(fakeHome)).toContain(path.join(fakeHome, ".agents"));

    const home = os.homedir();
    const skillPath = path.join(home, ".agents", "skills", "demo-skill", "SKILL.md");
    // antigravity can read public skill file under ~/.agents/skills
    expect(isProtectedAcpPath(skillPath, false, "antigravity")).toBe(false);
    // Writing to ~/.agents/skills is strictly denied even for antigravity
    expect(isProtectedAcpPath(skillPath, true, "antigravity")).toBe(true);
    // Sensitive filenames under ~/.agents/skills remain strictly denied for reads
    expect(isProtectedAcpPath(path.join(home, ".agents", "skills", "auth.json"), false, "antigravity")).toBe(true);
    expect(isProtectedAcpPath(path.join(home, ".agents", "skills", ".env"), false, "antigravity")).toBe(true);
    // Non-skill files under ~/.agents remain strictly denied
    expect(isProtectedAcpPath(path.join(home, ".agents", "config.json"), false, "antigravity")).toBe(true);
    // Other ACP clients cannot read ~/.agents/skills
    expect(isProtectedAcpPath(skillPath, false, "grok")).toBe(true);
    expect(isProtectedAcpPath(skillPath, false, "cursor")).toBe(true);

    // Seatbelt profile denies writing to ~/.agents
    const stateDir = tempDir("kulo-agents-sandbox-");
    const workRoot = tempDir("kulo-agents-work-");
    const workspaceDir = path.join(workRoot, "table", "T-1");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const profile = buildWorkerSandboxProfile({
      writablePaths: [workspaceDir],
      executable: process.execPath,
      protectedPaths: [stateDir],
    });
    expect(profile).toContain(path.join(os.homedir(), ".agents").replace(/\\/g, "/"));

    // On macOS, verify real OS sandbox blocks writing into ~/.agents
    if (process.platform === "darwin") {
      const rootDir = path.join(workRoot, "env-root");
      const taskWork = path.join(rootDir, "table", "T-agents");
      fs.mkdirSync(rootDir, { recursive: true });
      const manager = new EnvManager({ localRootDir: rootDir, getProtectedPaths: () => [stateDir] });
      await manager.start();
      cleanups.push(() => manager.close());
      const env = manager.createWorkerExecutionEnv("local", taskWork);
      const target = path.join(os.homedir(), ".agents", `kulo-sandbox-deny-test-${Date.now()}.txt`);
      const res = await env.exec(
        [
          "node",
          "-e",
          `const fs = require('node:fs');
           try { fs.mkdirSync(require('node:path').dirname(process.argv[1]), { recursive: true }); fs.writeFileSync(process.argv[1], 'poison'); process.exit(2); }
           catch (e) { if (['EPERM', 'EACCES', 'EROFS'].includes(e.code)) process.exit(0); throw e; }`,
          target,
        ],
        {},
        BACKGROUND_CONTEXT,
      );
      expect(res.ok && res.value.exitCode === 0, JSON.stringify(res)).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    }

    // Negative assertion: writing to a simulated HOME/.agents/skills does NOT affect Hub's skill catalog
    const fakeUserHome = tempDir("kulo-hub-skills-home-");
    const poisonSkillDir = path.join(fakeUserHome, ".agents", "skills", "poisoned-skill");
    fs.mkdirSync(poisonSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(poisonSkillDir, "SKILL.md"),
      "---\nname: poisoned-skill\ndescription: should never be auto-discovered by Hub\n---\nInjected prompt\n",
    );
    vi.stubEnv("HOME", fakeUserHome);
    const hubStateDir = tempDir("kulo-hub-skills-state-");
    const skillModels = createModels();
    skillModels.setProvider(fauxProvider({ provider: "test", models: [{ id: "m1" }] }).provider);
    const skillHarness = await Harness.open(new MemoryStorage(), { models: skillModels, registry: createRegistry() }, BACKGROUND_CONTEXT);
    cleanups.push(() => skillHarness.close(BACKGROUND_CONTEXT));
    const skills = new KuloSkills({ harness: skillHarness, stateDir: hubStateDir });
    await skills.initialize();
    const chatSkills = await skills.catalog("chat");
    const workerSkills = await skills.catalog("worker");
    expect([...chatSkills, ...workerSkills].some((item) => item.id === "poisoned-skill" || item.name === "poisoned-skill")).toBe(false);
  });

  it("normalizes edge cases in normalizeExternalContextUsage", () => {
    expect(normalizeExternalContextUsage({ usedTokens: 0, contextWindow: 128_000, updatedAt: 1 })).toEqual({
      usedTokens: 0,
      contextWindow: 128_000,
      percent: 0,
      updatedAt: 1,
    });
    expect(normalizeExternalContextUsage({ usedTokens: 0, contextWindow: 0, updatedAt: 1 })).toEqual({
      usedTokens: 0,
      updatedAt: 1,
    });
    expect(normalizeExternalContextUsage({ usedTokens: 500, contextWindow: -10, updatedAt: 1 })).toEqual({
      usedTokens: 500,
      updatedAt: 1,
    });
    expect(normalizeExternalContextUsage({ usedTokens: -1, contextWindow: 1000, updatedAt: 1 })).toBeUndefined();
  });
});
