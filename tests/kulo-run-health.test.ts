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
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  Harness,
  LiveDoc,
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationId,
  type Message,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describeKuloError, parseTurnLimitStepCount } from "@kulo/protocol";
import {
  BROWSER_STAGNATION_BRAKE_STREAK,
  BROWSER_STAGNATION_WARN_STREAK,
  IDENTICAL_CALL_BRAKE_STREAK,
  IDENTICAL_CALL_WARN_STREAK,
  IDENTICAL_ERROR_BRAKE_STREAK,
  IDENTICAL_ERROR_WARN_STREAK,
  JUDGE_GOAL_MAX_CHARS,
  ORCHESTRATOR_HEALTH_CHECK_INTERVAL,
  ORCHESTRATOR_MAX_TURNS,
  ORCHESTRATOR_SOFT_HANDOFF_TURN,
  RUN_HEALTH_BLOCK_MARKER,
  RunHealthDoc,
  SETTINGS_ASSISTANT_MAX_TURNS,
  SUBAGENT_MAX_TURNS,
  WORKER_HEALTH_CHECK_INTERVAL,
  WORKER_MAX_TURNS,
  WRAP_UP_MARGIN_TURNS,
  buildJudgeTrajectorySummary,
  buildJudgeTrajectoryTurn,
  createEmptyDoomLoopState,
  createRunHealthController,
  evaluateDoomLoopRound,
  evaluateRunHealthWithJudge,
  extractBrowserSnapshotFingerprint,
  fingerprintToolCall,
  isTerminatingToolRound,
  parseRunHealthJudgeVerdict,
  resolveRoleTurnBudget,
  summarizeToolArgsAllowlist,
  type JudgeTrajectoryInput,
  type ObservedToolCallOutcome,
  type RunHealthJudgeVerdict,
} from "../packages/hub/src/index.js";
import { buildPhilosophyPrompt } from "../packages/hub/src/prompts/orchestrator.js";
import { ZERO_TOOL_THINKING_HEADROOM_TOKENS } from "../packages/hub/src/zero-tool-thinking.js";
import { describeLocalizedKuloError } from "../packages/web/src/kulo-error.js";
import { setLanguage } from "../packages/web/src/kulo-i18n.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  setLanguage("zh-CN");
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-run-health-${prefix}-`));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Module 3 — Run Health Policy (pure leaf)", () => {
  it("exports centralized turn budgets and never widens subagent budget", () => {
    expect(ORCHESTRATOR_MAX_TURNS).toBe(60);
    expect(WORKER_MAX_TURNS).toBe(120);
    expect(ORCHESTRATOR_SOFT_HANDOFF_TURN).toBe(15);
    expect(ORCHESTRATOR_HEALTH_CHECK_INTERVAL).toBe(20);
    expect(WORKER_HEALTH_CHECK_INTERVAL).toBe(25);
    expect(WRAP_UP_MARGIN_TURNS).toBe(2);
    expect(SUBAGENT_MAX_TURNS).toBe(25);
    expect(SETTINGS_ASSISTANT_MAX_TURNS).toBe(25);

    expect(resolveRoleTurnBudget("orchestrator")).toEqual({
      maxTurns: 60,
      wrapUpTurn: 58,
      softHandoffTurn: 15,
      healthCheckInterval: 20,
    });
    expect(resolveRoleTurnBudget("worker")).toEqual({
      maxTurns: 120,
      wrapUpTurn: 118,
      healthCheckInterval: 25,
    });
    expect(resolveRoleTurnBudget("subagent")).toEqual({
      maxTurns: 25,
      wrapUpTurn: 23,
    });
    // Subagent budget can shrink (e.g. test override) but is NEVER widened above 25.
    expect(resolveRoleTurnBudget("subagent", 120).maxTurns).toBe(25);
    expect(resolveRoleTurnBudget("subagent", 10).maxTurns).toBe(10);
  });

  it("detects identical tool+args streaks with key-order invariance (warn 3, brake 5)", () => {
    expect(fingerprintToolCall("read", { a: 1, b: { y: 2, x: 3 } })).toBe(
      fingerprintToolCall("read", { b: { x: 3, y: 2 }, a: 1 }),
    );

    let state = createEmptyDoomLoopState();
    const actions: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const outcome: ObservedToolCallOutcome = {
        name: "read",
        arguments: i % 2 === 0 ? { path: "/tmp/a.ts", offset: 1 } : { offset: 1, path: "/tmp/a.ts" },
        isError: false,
      };
      const res = evaluateDoomLoopRound(state, [outcome]);
      state = res.state;
      actions.push(res.action);
    }
    expect(actions).toEqual(["none", "none", "warn", "warn", "brake"]);
    expect(state.identicalCallStreak).toBe(IDENTICAL_CALL_BRAKE_STREAK);
    expect(IDENTICAL_CALL_WARN_STREAK).toBe(3);
  });

  it("detects identical tool error streaks across volatile timestamps/UUIDs and resets on success (warn 3, brake 5)", () => {
    let state = createEmptyDoomLoopState();
    const actions: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const res = evaluateDoomLoopRound(state, [
        {
          name: "bash",
          arguments: { command: `cmd-${i}` }, // distinct args so call streak stays 1
          isError: true,
          errorCode: "exit_1",
          errorText: `Request 123e4567-e89b-12d3-a456-42661417400${i} timed out after ${i * 100}ms at 2026-11-26T09:1${i}:00Z`,
        },
      ]);
      state = res.state;
      actions.push(res.action);
    }
    expect(actions).toEqual(["none", "none", "warn", "warn", "brake"]);
    expect(state.identicalErrorStreak).toBe(IDENTICAL_ERROR_BRAKE_STREAK);
    expect(IDENTICAL_ERROR_WARN_STREAK).toBe(3);

    // A succeeding call resets identicalErrorStreak cleanly.
    const recovered = evaluateDoomLoopRound(state, [
      { name: "bash", arguments: { command: "echo ok" }, isError: false, outputText: "ok" },
    ]);
    expect(recovered.state.identicalErrorStreak).toBe(0);
    expect(recovered.action).toBe("none");
  });

  it("advances browser stagnation ONLY on actual snapshot payloads and exempts non-snapshot fill/type calls", () => {
    const fillNoSnap = JSON.stringify({
      envId: "local",
      tool: "browser",
      action: "fill",
      ok: true,
      data: { actionAccepted: true, observationRequired: true },
    });
    expect(extractBrowserSnapshotFingerprint(fillNoSnap)).toBeNull();

    const snapA = JSON.stringify({
      envId: "local",
      tool: "browser",
      action: "snapshot",
      ok: true,
      data: {
        url: "https://admin.example.com/dashboard",
        snapshot: '- heading "Dashboard"\n- button "Save" [ref=e1]',
      },
    });
    const snapARenumbered = JSON.stringify({
      envId: "local",
      tool: "browser",
      action: "click",
      ok: true,
      data: {
        url: "https://admin.example.com/dashboard",
        snapshot: '- heading "Dashboard"\n- button "Save" [ref=e9]',
      },
    });
    const snapB = JSON.stringify({
      envId: "local",
      tool: "browser",
      action: "click",
      ok: true,
      data: {
        url: "https://admin.example.com/settings",
        snapshot: '- heading "Settings"\n- button "Apply" [ref=e2]',
      },
    });

    let state = createEmptyDoomLoopState();
    // Initial snapshot sets streak = 1.
    let res = evaluateDoomLoopRound(state, [
      { name: "kulo_browser", arguments: { action: "open", url: "https://admin.example.com/dashboard" }, isError: false, outputText: snapA },
    ]);
    state = res.state;
    expect(state.browserStagnationStreak).toBe(1);

    // 6 consecutive non-snapshot fill calls on different fields MUST NOT advance browserStagnationStreak!
    for (let i = 1; i <= 6; i += 1) {
      res = evaluateDoomLoopRound(state, [
        { name: "kulo_browser", arguments: { action: "fill", ref: `@e${i}`, text: `val-${i}` }, isError: false, outputText: fillNoSnap },
      ]);
      state = res.state;
      expect(state.browserStagnationStreak).toBe(1);
      expect(res.action).toBe("none");
    }

    // Now 5 more unchanged snapshots (streak 2, 3, 4->warn, 5->warn, 6->brake).
    const snapActions: string[] = [];
    for (let i = 2; i <= 6; i += 1) {
      res = evaluateDoomLoopRound(state, [
        { name: "kulo_browser", arguments: { action: "click", ref: `@e${i}` }, isError: false, outputText: snapARenumbered },
      ]);
      state = res.state;
      snapActions.push(res.action);
    }
    expect(snapActions).toEqual(["none", "none", "warn", "warn", "brake"]);
    expect(state.browserStagnationStreak).toBe(BROWSER_STAGNATION_BRAKE_STREAK);
    expect(BROWSER_STAGNATION_WARN_STREAK).toBe(4);

    // Navigating to a genuinely different page resets stagnation streak to 1.
    res = evaluateDoomLoopRound(state, [
      { name: "kulo_browser", arguments: { action: "click", ref: "@e10" }, isError: false, outputText: snapB },
    ]);
    expect(res.state.browserStagnationStreak).toBe(1);
    expect(res.action).toBe("none");
  });

  it("structurally drops kulo_browser fill/type text and ALL kulo_connection_use args in judge trajectory", () => {
    const turn = buildJudgeTrajectoryTurn(1, [
      {
        name: "kulo_browser",
        arguments: {
          action: "fill",
          ref: "@e3",
          text: "SuperSecretPassword!123",
          url: "https://user:pass@portal.example.com/login?token=secret_query_tok#frag",
        },
        isError: false,
        durationMs: 42,
      },
      {
        name: "kulo_browser",
        arguments: {
          action: "batch",
          steps: [
            { action: "fill", ref: "@e1", text: "admin_pw_999" },
            { action: "type", ref: "@e2", text: "otp_882211" },
            { action: "click", ref: "@e3" },
          ],
        },
        isError: false,
      },
      {
        name: "kulo_connection_use",
        arguments: {
          connection_id: "conn-1",
          method: "POST",
          headers: { Authorization: "Bearer secret_bearer_xyz" },
          body: { password: "vault_password_999" },
        },
        isError: false,
      },
      {
        name: "read",
        arguments: { path: "/Users/alice/private/src/app.ts", offset: 10, limit: 50 },
        isError: false,
      },
    ]);

    const summary = buildJudgeTrajectorySummary({
      role: "orchestrator",
      turnsUsed: 20,
      effectiveTurnsSinceInput: 20,
      maxTurns: 60,
      userGoal: "A".repeat(900),
      recentTurns: [turn],
      doomLoop: createEmptyDoomLoopState(),
    });

    const serialized = JSON.stringify(summary);
    expect(summary.userGoal.length).toBeLessThanOrEqual(JUDGE_GOAL_MAX_CHARS);
    expect(serialized).not.toContain("SuperSecretPassword!123");
    expect(serialized).not.toContain("secret_query_tok");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("admin_pw_999");
    expect(serialized).not.toContain("otp_882211");
    expect(serialized).not.toContain("secret_bearer_xyz");
    expect(serialized).not.toContain("vault_password_999");
    expect(serialized).not.toContain("conn-1");
    expect(serialized).not.toContain("/Users/alice/private");
    expect(serialized).toContain("portal.example.com/login");
    expect(serialized).toContain("file=app.ts");
    expect(summarizeToolArgsAllowlist("kulo_connection_use", { any: "secret" })).toBe("");
  });

  it("strictly validates health judge JSON verdicts and rejects malformed responses", () => {
    expect(parseRunHealthJudgeVerdict('{"verdict":"healthy","reason":"Making progress"}')).toEqual({
      verdict: "healthy",
      reason: "Making progress",
    });
    expect(
      parseRunHealthJudgeVerdict('```json\n{"verdict":"handoff_or_wrap","reason":"Long flow","guidance":"Dispatch a worker"}\n```'),
    ).toEqual({
      verdict: "handoff_or_wrap",
      reason: "Long flow",
      guidance: "Dispatch a worker",
    });
    expect(parseRunHealthJudgeVerdict('{"verdict":"stuck","reason":"Looping on 404"}')).toEqual({
      verdict: "stuck",
      reason: "Looping on 404",
    });

    expect(parseRunHealthJudgeVerdict("")).toBeNull();
    expect(parseRunHealthJudgeVerdict("not json")).toBeNull();
    expect(parseRunHealthJudgeVerdict('{"verdict":"invalid","reason":"x"}')).toBeNull();
    expect(parseRunHealthJudgeVerdict('{"verdict":"stuck","reason":""}')).toBeNull();
    expect(parseRunHealthJudgeVerdict('{"verdict":"healthy","reason":"ok","guidance":123}')).toBeNull();
    expect(isTerminatingToolRound(["kulo_report"])).toBe(true);
    expect(isTerminatingToolRound(["kulo_computer_handoff"])).toBe(true);
    expect(isTerminatingToolRound(["kulo_report", "read"])).toBe(false);
  });
});

describe("Module 3 — Run Health Judge (completeSimple wrapper & fail-open)", () => {
  const sampleTrajectory: JudgeTrajectoryInput = {
    role: "orchestrator",
    turnsUsed: 20,
    effectiveTurnsSinceInput: 20,
    maxTurns: 60,
    userGoal: "Inspect portal with token_abc_secret_1234",
    recentTurns: [{ turn: 1, tools: [{ name: "read", argSummary: "file=index.ts", ok: true }] }],
    signals: { identicalCallStreak: 1, identicalErrorStreak: 0, browserStagnationStreak: 0, dispatchedInRun: false },
  };

  it("uses wrapped completeSimple with zero-tool thinking clamping, headroom, disableNativeTools, cacheRetention=none, and input/output redaction", async () => {
    const captured: Array<{ model: Model<Api>; context: unknown; options: Record<string, unknown> }> = [];
    const fakeModel: Model<Api> = {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      thinkingLevelMap: { off: null, minimal: null, low: "low" },
    };

    const models = {
      getModel: (provider: string, id: string) =>
        provider === "google" && id === "gemini-2.5-pro" ? fakeModel : undefined,
      completeSimple: async (model: Model<Api>, context: unknown, options: Record<string, unknown>) => {
        captured.push({ model, context, options });
        return fauxAssistantMessage([
          fauxText('{"verdict":"handoff_or_wrap","reason":"Leak check token_abc_secret_1234","guidance":"Use kulo_dispatch"}'),
        ]);
      },
    } as unknown as Models;

    const redact = (t: string) => t.replaceAll("token_abc_secret_1234", "[REDACTED]");
    const verdict = await evaluateRunHealthWithJudge({
      models,
      modelRef: { provider: "google", modelId: "gemini-2.5-pro" },
      trajectory: sampleTrajectory,
      redact,
    });

    expect(verdict).toEqual({
      verdict: "handoff_or_wrap",
      reason: "Leak check [REDACTED]",
      guidance: "Use kulo_dispatch",
    });
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.options.disableNativeTools).toBe(true);
    expect(call.options.cacheRetention).toBe("none");
    expect(call.options.reasoning).toBe("low");
    expect(call.options.maxTokens).toBe(400 + ZERO_TOOL_THINKING_HEADROOM_TOKENS);
    expect(typeof call.options.onPayload).toBe("function");
    // Google thought summaries are suppressed on payload transform.
    const transformed = (call.options.onPayload as (p: unknown) => Record<string, unknown>)({
      config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 512 } },
    });
    expect((transformed.config as { thinkingConfig: { includeThoughts: boolean } }).thinkingConfig.includeThoughts).toBe(false);

    // Input payload was redacted before reaching completeSimple.
    expect(JSON.stringify(call.context)).not.toContain("token_abc_secret_1234");
    expect(JSON.stringify(call.context)).toContain("[REDACTED]");
  });

  it("strictly fails open on timeout, network throw, toolCall response, and invalid JSON", async () => {
    const warnings: string[] = [];
    const baseModel: Model<Api> = {
      id: "gpt-4o",
      name: "GPT-4o",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };

    const makeModels = (impl: (opts: { signal?: AbortSignal }) => Promise<unknown>) =>
      ({
        getModel: () => baseModel,
        completeSimple: (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => impl(opts),
      }) as unknown as Models;

    // 1. Timeout
    const timedOut = await evaluateRunHealthWithJudge({
      models: makeModels(
        (opts) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new Error("aborted_timeout")));
          }),
      ),
      modelRef: { provider: "openai", modelId: "gpt-4o" },
      trajectory: sampleTrajectory,
      redact: (s) => s,
      timeoutMs: 30,
      onWarning: (m) => warnings.push(m),
    });
    expect(timedOut).toBeNull();

    // 2. Network error
    const networkErr = await evaluateRunHealthWithJudge({
      models: makeModels(async () => {
        throw new Error("ECONNRESET");
      }),
      modelRef: { provider: "openai", modelId: "gpt-4o" },
      trajectory: sampleTrajectory,
      redact: (s) => s,
      onWarning: (m) => warnings.push(m),
    });
    expect(networkErr).toBeNull();

    // 3. Unexpected tool call in response
    const toolCallResp = await evaluateRunHealthWithJudge({
      models: makeModels(async () => fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" })),
      modelRef: { provider: "openai", modelId: "gpt-4o" },
      trajectory: sampleTrajectory,
      redact: (s) => s,
      onWarning: (m) => warnings.push(m),
    });
    expect(toolCallResp).toBeNull();

    // 4. Malformed JSON
    const badJson = await evaluateRunHealthWithJudge({
      models: makeModels(async () => fauxAssistantMessage([fauxText("definitely not json")])),
      modelRef: { provider: "openai", modelId: "gpt-4o" },
      trajectory: sampleTrajectory,
      redact: (s) => s,
      onWarning: (m) => warnings.push(m),
    });
    expect(badJson).toBeNull();
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Module 3 — Run Health Extension (real pi-durable Harness end-to-end)", () => {
  async function openMiniHarness(options: {
    role: "orchestrator" | "worker" | "subagent";
    maxTurns: number;
    responses: ReturnType<typeof fauxAssistantMessage>[];
    evaluateJudge?: (input: { trajectory: JudgeTrajectoryInput }) => Promise<RunHealthJudgeVerdict | null>;
    onToolExec?: (name: string, args: Record<string, unknown>) => Promise<string | { text: string; isError?: boolean; terminate?: boolean }>;
  }) {
    const dir = makeTempDir(options.role);
    const storage = await openNodeSqliteStorage(path.join(dir, "test.sqlite"), BACKGROUND_CONTEXT);
    const faux = fauxProvider({ provider: "test-prov", models: [{ id: "m1" }] });
    faux.setResponses(options.responses);
    const models = createModels();
    models.setProvider(faux.provider);

    let harnessRef: Harness | undefined;
    const seenRequests: Message[][] = [];
    const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];

    const runHealth = createRunHealthController({
      getHarness: () => harnessRef,
      getModels: () => models,
      redact: (s) => s,
      resolveRole: () => options.role,
      ...(options.evaluateJudge
        ? { evaluateJudge: (input) => options.evaluateJudge!({ trajectory: input.trajectory }) }
        : {}),
    });

    const spyExt = defineExtension({
      name: "test-spy",
      hooks: [
        {
          task: "pi.generation",
          handlers: {
            beforeRequest: (req: { messages: readonly Message[] }) => {
              seenRequests.push([...req.messages]);
              return undefined;
            },
          },
        },
      ],
    });

    const mkTool = (name: string, terminateDefault = false) =>
      defineTool({
        name,
        description: `Test tool ${name}`,
        parameters: obj({
          action: opt(str()),
          ref: opt(str()),
          text: opt(str()),
          note: opt(str()),
          nested: opt(str()),
        }),
        execute: async (args, api, context) => {
          executedTools.push({ name, args: args as Record<string, unknown> });
          if (args.nested) {
            const nestedRes = await api.executeTool("helper_nested", { note: args.nested }, context);
            return {
              output: [{ type: "text", text: `nested_ok:${nestedRes.isError ? "err" : "ok"}` }],
            };
          }
          if (options.onToolExec) {
            const custom = await options.onToolExec(name, args as Record<string, unknown>);
            if (typeof custom === "string") {
              return { output: [{ type: "text", text: custom }] };
            }
            return {
              output: [{ type: "text", text: custom.text }],
              ...(custom.isError ? { isError: true } : {}),
              ...(custom.terminate ? { control: { terminate: true } } : {}),
            };
          }
          return {
            output: [{ type: "text", text: `${name}:ok` }],
            ...(terminateDefault ? { control: { terminate: true } } : {}),
          };
        },
      });

    const toolsExt = defineExtension({
      name: "test-tools",
      tools: [
        mkTool("probe"),
        mkTool("kulo_browser"),
        mkTool("kulo_connection_use"),
        mkTool("kulo_dispatch"),
        mkTool("kulo_report", true),
        mkTool("kulo_computer_handoff", true),
        mkTool("helper_nested"),
      ],
    });

    const registry = createRegistry();
    registry.install(toolsExt);
    registry.install(runHealth.extension);
    registry.install(spyExt);

    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
    harnessRef = harness;
    cleanups.push(async () => {
      runHealth.close();
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    });

    const conv = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: "test-prov", modelId: "m1" },
        thinkingLevel: "off",
        extensions: [toolsExt, runHealth.extension, spyExt],
        maxTurns: options.maxTurns,
      },
    });
    return { harness, conv, runHealth, seenRequests, executedTools, faux };
  }

  function toolTurn(...calls: ReturnType<typeof fauxToolCall>[]) {
    return fauxAssistantMessage(calls, { stopReason: "toolUse" });
  }

  function lastMessageText(messages: readonly Message[]): string {
    const last = [...messages].reverse().find((m) => m.role === "user" || m.role === "toolResult");
    if (!last) return "";
    if (typeof last.content === "string") return last.content;
    return last.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  it("injects Orchestrator turn-15 soft handoff reminder ONCE and preserves system prompt", async () => {
    const responses: ReturnType<typeof fauxAssistantMessage>[] = [];
    // 16 distinct tool rounds + final answer
    for (let i = 1; i <= 16; i += 1) {
      responses.push(toolTurn(fauxToolCall("probe", { note: `step-${i}` })));
    }
    responses.push(fauxAssistantMessage([fauxText("All done.")]));

    const { conv, seenRequests } = await openMiniHarness({
      role: "orchestrator",
      maxTurns: 60,
      responses,
    });

    const sub = await conv.submit({ type: "input", content: "Inspect a long list" }, BACKGROUND_CONTEXT);
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");

    // seenRequests[0] = turn 0, ..., seenRequests[15] = after 15 tool rounds (soft reminder!), seenRequests[16] = after 16 rounds (no duplicate!)
    const softIndices = seenRequests
      .map((msgs, idx) => (lastMessageText(msgs).includes("[KULO_RUN_HEALTH:SOFT_HANDOFF]") ? idx : -1))
      .filter((idx) => idx >= 0);
    expect(softIndices).toEqual([15]);

    // Never mutated system prompt messages.
    for (const req of seenRequests) {
      for (const msg of req) {
        if (msg.role === "system") {
          expect(JSON.stringify(msg)).not.toContain("KULO_RUN_HEALTH");
        }
      }
    }
  });

  it("skips Orchestrator turn-15 soft reminder if kulo_dispatch was already called in the run", async () => {
    const responses: ReturnType<typeof fauxAssistantMessage>[] = [];
    responses.push(toolTurn(fauxToolCall("kulo_dispatch", { note: "delegate" })));
    for (let i = 2; i <= 16; i += 1) {
      responses.push(toolTurn(fauxToolCall("probe", { note: `step-${i}` })));
    }
    responses.push(fauxAssistantMessage([fauxText("Done after dispatch.")]));

    const { conv, seenRequests } = await openMiniHarness({
      role: "orchestrator",
      maxTurns: 60,
      responses,
    });

    const sub = await conv.submit({ type: "input", content: "Do work" }, BACKGROUND_CONTEXT);
    await sub.wait(BACKGROUND_CONTEXT);

    expect(seenRequests.some((msgs) => lastMessageText(msgs).includes("[KULO_RUN_HEALTH:SOFT_HANDOFF]"))).toBe(false);
  });

  it("enforces ceiling beforeTool blocking: Orchestrator allows ONE kulo_dispatch and blocks others; blocks kulo_dispatch on stuck doom-loop", async () => {
    // Part A: Turn ceiling (maxTurns = 6 => wrapUpTurn = 4).
    const responsesA: ReturnType<typeof fauxAssistantMessage>[] = [
      toolTurn(fauxToolCall("probe", { note: "1" })), // turns -> 1
      toolTurn(fauxToolCall("probe", { note: "2" })), // turns -> 2
      toolTurn(fauxToolCall("probe", { note: "3" })), // turns -> 3
      // Turn 4 (turns -> 4 >= 4): probe is blocked, ONE kulo_dispatch is allowed!
      toolTurn(
        fauxToolCall("probe", { note: "4-blocked" }),
        fauxToolCall("kulo_dispatch", { note: "handoff-1" }),
        fauxToolCall("kulo_dispatch", { note: "handoff-2-blocked" }),
      ),
      // Turn 5 (turns -> 5 >= 4): second-turn kulo_dispatch is ALSO blocked because wrapUpDispatched=true!
      toolTurn(fauxToolCall("kulo_dispatch", { note: "handoff-3-blocked" })),
      fauxAssistantMessage([fauxText("Handed off and wrapping up.")]),
    ];

    const envA = await openMiniHarness({ role: "orchestrator", maxTurns: 6, responses: responsesA });
    const subA = await envA.conv.submit({ type: "input", content: "Long orchestrator task" }, BACKGROUND_CONTEXT);
    const settledA = await subA.wait(BACKGROUND_CONTEXT);
    expect(settledA.status).toBe("done");

    expect(envA.executedTools.filter((t) => t.name === "probe")).toHaveLength(3);
    expect(envA.executedTools.filter((t) => t.name === "kulo_dispatch")).toHaveLength(1);
    expect(envA.executedTools.find((t) => t.name === "kulo_dispatch")?.args.note).toBe("handoff-1");
    // Wrap-up guidance was injected on every request once turns >= 4.
    expect(lastMessageText(envA.seenRequests[4]!)).toContain("[KULO_RUN_HEALTH:WRAP_UP]");
    expect(lastMessageText(envA.seenRequests[5]!)).toContain("[KULO_RUN_HEALTH:WRAP_UP]");

    // Part B: Stuck doom-loop (5 identical calls => forceWrapUp source="doom_loop") blocks EVEN kulo_dispatch!
    const responsesB: ReturnType<typeof fauxAssistantMessage>[] = [
      toolTurn(fauxToolCall("probe", { note: "same" })),
      toolTurn(fauxToolCall("probe", { note: "same" })),
      toolTurn(fauxToolCall("probe", { note: "same" })), // warn
      toolTurn(fauxToolCall("probe", { note: "same" })), // warn
      toolTurn(fauxToolCall("probe", { note: "same" })), // brake -> forceWrapUp(doom_loop)
      toolTurn(fauxToolCall("kulo_dispatch", { note: "should-be-blocked" })),
      fauxAssistantMessage([fauxText("Stopped looping and explained blocker.")]),
    ];

    const envB = await openMiniHarness({ role: "orchestrator", maxTurns: 60, responses: responsesB });
    const subB = await envB.conv.submit({ type: "input", content: "Looping task" }, BACKGROUND_CONTEXT);
    const settledB = await subB.wait(BACKGROUND_CONTEXT);
    expect(settledB.status).toBe("done");

    expect(envB.executedTools.filter((t) => t.name === "kulo_dispatch")).toHaveLength(0);
    expect(lastMessageText(envB.seenRequests[3]!)).toContain("[KULO_RUN_HEALTH:WARNING]");
    expect(lastMessageText(envB.seenRequests[5]!)).toContain("[KULO_RUN_HEALTH:WRAP_UP]");
    const persisted = await envB.harness.snapshot(RunHealthDoc, envB.conv.id, BACKGROUND_CONTEXT);
    expect(persisted?.forceWrapUp?.source).toBe("doom_loop");
  });

  it("enforces Worker wrap-up allowing ONLY kulo_report (plus nested calls) and cleanly terminates; Subagent blocks all tools", async () => {
    // Worker: maxTurns = 6 => wrapUpTurn = 4.
    const workerResponses: ReturnType<typeof fauxAssistantMessage>[] = [
      toolTurn(fauxToolCall("probe", { note: "1" })), // turns -> 1
      toolTurn(fauxToolCall("probe", { note: "2" })), // turns -> 2
      toolTurn(fauxToolCall("probe", { note: "3", nested: "child-ok" })), // turns -> 3 (nested runs fine)
      // Turn 4 (turns -> 4 >= 4): probe is blocked!
      toolTurn(fauxToolCall("probe", { note: "4-blocked" })),
      // Turn 5 (turns -> 5 >= 4): Worker emits kulo_report ALONE -> terminates cleanly!
      toolTurn(fauxToolCall("kulo_report", { note: "final-report" })),
    ];

    const workerEnv = await openMiniHarness({ role: "worker", maxTurns: 6, responses: workerResponses });
    const workerSub = await workerEnv.conv.submit({ type: "input", content: "Execute worker task" }, BACKGROUND_CONTEXT);
    const workerSettled = await workerSub.wait(BACKGROUND_CONTEXT);
    expect(workerSettled.status).toBe("done");
    expect(workerEnv.executedTools.filter((t) => t.name === "probe")).toHaveLength(3);
    expect(workerEnv.executedTools.filter((t) => t.name === "helper_nested")).toHaveLength(1);
    expect(workerEnv.executedTools.filter((t) => t.name === "kulo_report")).toHaveLength(1);
    // Worker wrap-up prompt explicitly instructs calling kulo_report alone.
    expect(lastMessageText(workerEnv.seenRequests[4]!)).toContain("kulo_report");
    expect(lastMessageText(workerEnv.seenRequests[4]!)).toContain("严禁与其他任何工具并行调用");

    // Verify nested tool calls are ALWAYS allowed in beforeTool even during active wrap-up!
    const toolHook = workerEnv.runHealth.extension.hooks?.find((h) => h.task === "pi.tool");
    const beforeTool = (toolHook?.handlers as { beforeTool: Function }).beforeTool;
    const nestedDecision = await beforeTool(
      {
        type: "toolCall",
        id: "call_1/1",
        name: "probe",
        arguments: {},
        parent: { taskId: 1, callId: "call_1" },
      } as unknown as ToolHookCall,
      { conversationId: workerEnv.conv.id, snapshot: workerEnv.harness.snapshot.bind(workerEnv.harness) },
      BACKGROUND_CONTEXT,
    );
    expect(nestedDecision).toBeUndefined();

    // Subagent: maxTurns = 5 => wrapUpTurn = 3; blocks ALL tools including kulo_report and kulo_dispatch.
    const subResponses: ReturnType<typeof fauxAssistantMessage>[] = [
      toolTurn(fauxToolCall("probe", { note: "1" })), // turns -> 1
      toolTurn(fauxToolCall("probe", { note: "2" })), // turns -> 2
      toolTurn(fauxToolCall("kulo_report", { note: "blocked" }), fauxToolCall("probe", { note: "blocked" })), // turns -> 3 >= 3
      fauxAssistantMessage([fauxText("Subagent concise text wrap-up.")]),
    ];
    const subEnv = await openMiniHarness({ role: "subagent", maxTurns: 5, responses: subResponses });
    const subRun = await subEnv.conv.submit({ type: "input", content: "Scout files" }, BACKGROUND_CONTEXT);
    const subSettled = await subRun.wait(BACKGROUND_CONTEXT);
    expect(subSettled.status).toBe("done");
    expect(subEnv.executedTools.filter((t) => t.name === "probe")).toHaveLength(2);
    expect(subEnv.executedTools.filter((t) => t.name === "kulo_report")).toHaveLength(0);
  });

  it("resets doom-loop streaks and shifts turn baseline on mid-run user steer", async () => {
    let convRef: Awaited<ReturnType<typeof openMiniHarness>>["conv"] | undefined;
    let steered = false;

    const responses: ReturnType<typeof fauxAssistantMessage>[] = [
      // 5 identical calls -> hits doom-loop brake at turn 5, while steer is queued during tool 5!
      toolTurn(fauxToolCall("probe", { note: "stuck-arg" })),
      toolTurn(fauxToolCall("probe", { note: "stuck-arg" })),
      toolTurn(fauxToolCall("probe", { note: "stuck-arg" })),
      toolTurn(fauxToolCall("probe", { note: "stuck-arg" })),
      toolTurn(fauxToolCall("probe", { note: "stuck-arg" })),
      // After user steer lands at postTools, turn 6 should NOT be blocked by stale doom-loop!
      toolTurn(fauxToolCall("probe", { note: "stuck-arg" })),
      fauxAssistantMessage([fauxText("Completed with user steer.")]),
    ];

    let toolCount = 0;
    const env = await openMiniHarness({
      role: "orchestrator",
      maxTurns: 60,
      responses,
      onToolExec: async () => {
        toolCount += 1;
        if (toolCount === 5 && !steered && convRef) {
          steered = true;
          await convRef.submit({ type: "input", content: "Try a fresh angle", whenBusy: "steer" }, BACKGROUND_CONTEXT);
        }
        return "ok";
      },
    });
    convRef = env.conv;

    const sub = await env.conv.submit({ type: "input", content: "Initial goal" }, BACKGROUND_CONTEXT);
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");

    // 6th call executed cleanly instead of being blocked by pre-steer doom_loop!
    expect(env.executedTools).toHaveLength(6);
    expect(lastMessageText(env.seenRequests[5]!)).not.toContain("[KULO_RUN_HEALTH:WRAP_UP]");
    const doc = await env.harness.snapshot(RunHealthDoc, env.conv.id, BACKGROUND_CONTEXT);
    expect(doc?.lastInputCount).toBe(2);
    expect(doc?.turnsAtLastUserInput).toBe(5);
    expect(doc?.forceWrapUp).toBeUndefined();
  });

  it("runs health judge fire-and-forget asynchronously, persists verdict to RunHealthDoc, strips secrets, handles stuck verdict, and skips terminating rounds", async () => {
    const judgeInputs: JudgeTrajectoryInput[] = [];
    let releaseJudge: ((v: RunHealthJudgeVerdict) => void) | undefined;
    let judgeCallCount = 0;

    const responses: ReturnType<typeof fauxAssistantMessage>[] = [];
    // Turn 1: sensitive fill + connection_use (must be stripped before judge!)
    responses.push(
      toolTurn(
        fauxToolCall("kulo_browser", { action: "fill", ref: "@e1", text: "TopSecretFormPass!99" }),
        fauxToolCall("kulo_connection_use", { action: "call", text: "VaultSecretToken!88" }),
      ),
    );
    // Turns 2..20: distinct probes so turn 20 triggers orchestrator health judge!
    for (let i = 2; i <= 20; i += 1) {
      responses.push(toolTurn(fauxToolCall("probe", { note: `p-${i}` })));
    }
    // Turn 21: runs IMMEDIATELY while judge is still pending! Then releases judge before turn 22.
    responses.push(toolTurn(fauxToolCall("probe", { note: "p-21" })));
    // Turn 22: receives judge `handoff_or_wrap` guidance, then answers.
    responses.push(fauxAssistantMessage([fauxText("Wrapped up after judge check.")]));

    let turn21Started = false;
    const env = await openMiniHarness({
      role: "orchestrator",
      maxTurns: 60,
      responses,
      evaluateJudge: async ({ trajectory }) => {
        judgeCallCount += 1;
        judgeInputs.push(trajectory);
        return new Promise<RunHealthJudgeVerdict>((resolve) => {
          releaseJudge = resolve;
        });
      },
      onToolExec: async (_name, args) => {
        if (args.note === "p-21") {
          // Proves afterTools on turn 20 did NOT await the pending judge!
          turn21Started = true;
          expect(judgeCallCount).toBe(1);
          releaseJudge?.({
            verdict: "handoff_or_wrap",
            reason: "20 turns spent exploring",
            guidance: "Summarize or dispatch a worker",
          });
          await env.runHealth.waitForPendingJudges();
        }
        return "ok";
      },
    });

    const sub = await env.conv.submit({ type: "input", content: "Long exploration" }, BACKGROUND_CONTEXT);
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    expect(turn21Started).toBe(true);
    expect(judgeCallCount).toBe(1);

    // Judge trajectory structurally dropped secrets from kulo_browser fill & kulo_connection_use.
    const serialized = JSON.stringify(judgeInputs[0]);
    expect(serialized).not.toContain("TopSecretFormPass!99");
    expect(serialized).not.toContain("VaultSecretToken!88");

    // Judge verdict persisted in LatestConversationDoc and injected on next request (turn 22).
    const doc = await env.harness.snapshot(RunHealthDoc, env.conv.id, BACKGROUND_CONTEXT);
    expect(doc?.judgedTurns).toContain(20);
    expect(lastMessageText(env.seenRequests[21]!)).toContain("[KULO_RUN_HEALTH:CHECK]");
    expect(lastMessageText(env.seenRequests[21]!)).toContain("20 turns spent exploring");

    // Judge returning "stuck" persists forceWrapUp(judge_stuck) and blocks even kulo_dispatch.
    let releaseStuckJudge: ((v: RunHealthJudgeVerdict) => void) | undefined;
    const stuckResponses: ReturnType<typeof fauxAssistantMessage>[] = [];
    for (let i = 1; i <= 20; i += 1) {
      stuckResponses.push(toolTurn(fauxToolCall("probe", { note: `s-${i}` })));
    }
    stuckResponses.push(toolTurn(fauxToolCall("probe", { note: "s-21" })));
    stuckResponses.push(toolTurn(fauxToolCall("kulo_dispatch", { note: "blocked-by-stuck" })));
    stuckResponses.push(fauxAssistantMessage([fauxText("Stopped because judge flagged stuck.")]));

    const stuckEnv = await openMiniHarness({
      role: "orchestrator",
      maxTurns: 60,
      responses: stuckResponses,
      evaluateJudge: async () =>
        new Promise<RunHealthJudgeVerdict>((resolve) => {
          releaseStuckJudge = resolve;
        }),
      onToolExec: async (_name, args) => {
        if (args.note === "s-21") {
          releaseStuckJudge?.({ verdict: "stuck", reason: "Spinning on same dead-end" });
          await stuckEnv.runHealth.waitForPendingJudges();
        }
        return "ok";
      },
    });
    const stuckSub = await stuckEnv.conv.submit({ type: "input", content: "Stuck task" }, BACKGROUND_CONTEXT);
    expect((await stuckSub.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(stuckEnv.executedTools.filter((t) => t.name === "kulo_dispatch")).toHaveLength(0);
    const stuckDoc = await stuckEnv.harness.snapshot(RunHealthDoc, stuckEnv.conv.id, BACKGROUND_CONTEXT);
    expect(stuckDoc?.forceWrapUp?.source).toBe("judge_stuck");

    // Terminating round on exact judge multiple (turn 25 for Worker) MUST skip health judge!
    let workerJudgeCalls = 0;
    const workerResponses: ReturnType<typeof fauxAssistantMessage>[] = [];
    for (let i = 1; i <= 24; i += 1) {
      workerResponses.push(toolTurn(fauxToolCall("probe", { note: `w-${i}` })));
    }
    workerResponses.push(toolTurn(fauxToolCall("kulo_report", { note: "done-at-25" })));

    const workerEnv = await openMiniHarness({
      role: "worker",
      maxTurns: 120,
      responses: workerResponses,
      evaluateJudge: async () => {
        workerJudgeCalls += 1;
        return { verdict: "healthy", reason: "ok" };
      },
    });
    const wSub = await workerEnv.conv.submit({ type: "input", content: "25-step worker" }, BACKGROUND_CONTEXT);
    expect((await wSub.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    await workerEnv.runHealth.waitForPendingJudges();
    expect(workerJudgeCalls).toBe(0);
  });
});

describe("Module 3 — Hub wiring, prompt calibration & bilingual turn_limit display", () => {
  it("configures KuloHub root conversation with maxTurns=60 and registers kulo-run-health strictly AFTER kulo-builtin-memory-recall", async () => {
    const stateDir = makeTempDir("hub-wiring");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const hub = await openTestHub({
      config: {
        authToken: "test-run-health-token-1234567890",
        stateDir,
        enableLocalEnv: false,
        model: {
          baseUrl: "http://localhost/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
        },
      },
      models,
      providerId: "openai",
    });
    cleanups.push(() => hub.close(BACKGROUND_CONTEXT));

    const rootAgent = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id as ConversationId, BACKGROUND_CONTEXT);
    expect(rootAgent?.maxTurns).toBe(ORCHESTRATOR_MAX_TURNS);
    expect(Array.isArray(rootAgent?.extensions)).toBe(true);
    const extNames = rootAgent?.extensions as string[];
    const recallIdx = extNames.indexOf("kulo-builtin-memory-recall");
    const healthIdx = extNames.indexOf("kulo-run-health");
    expect(recallIdx).toBeGreaterThanOrEqual(0);
    expect(healthIdx).toBeGreaterThan(recallIdx);
  });

  it("calibrates trusted orchestrator prompt for lightweight browser bounds and upfront kulo_dispatch", () => {
    const trusted = buildPhilosophyPrompt("Kulo", "zh-CN", "trusted", "v2");
    expect(trusted).toContain("single read-only page or <=3 simple steps");
    expect(trusted).toContain("admin logins, multi-page menu inspection or scraping");
    expect(trusted).toContain("`kulo_dispatch` upfront");
    expect((trusted.match(/\bnever\b/gi) ?? []).length).toBe(3);
  });

  it("parses and renders bilingual turn_limit step counts with graceful fallback", () => {
    expect(parseTurnLimitStepCount({ reason: "turn_limit", detail: "60 turns" })).toBe(60);
    expect(parseTurnLimitStepCount({ reason: "turn_limit", detail: "120 turns" })).toBe(120);
    expect(parseTurnLimitStepCount({ reason: "turn_limit", detail: "1 turn" })).toBe(1);
    expect(parseTurnLimitStepCount({ reason: "turn_limit", detail: "unknown" })).toBeUndefined();

    // Chinese
    setLanguage("zh-CN");
    const zh60 = describeKuloError({ reason: "turn_limit", detail: "60 turns" });
    expect(zh60.kind).toBe("turn_limit");
    expect(zh60.hint).toBe("本轮已执行 60 步，为避免长时间空转已自动暂停。点击「继续生成」即可接着往下执行。");

    const zh120 = describeLocalizedKuloError({ reason: "turn_limit", detail: "120 turns" });
    expect(zh120.hint).toContain("120 步");

    const zhFallback = describeKuloError({ reason: "turn_limit" });
    expect(zhFallback.hint).toBe("为避免循环调用，本轮已自动暂停。点击「继续生成」即可接着往下执行。");

    // English
    setLanguage("en");
    const en60 = describeLocalizedKuloError({ reason: "turn_limit", detail: "60 turns" });
    expect(en60.kind).toBe("turn_limit");
    expect(en60.hint).toBe("This turn paused after 60 steps to avoid extended loops. Select Continue to resume.");

    const en1 = describeLocalizedKuloError({ reason: "turn_limit", detail: "1 turn" });
    expect(en1.hint).toBe("This turn paused after 1 step to avoid extended loops. Select Continue to resume.");

    const enFallback = describeLocalizedKuloError({ reason: "turn_limit", detail: "limit reached" });
    expect(enFallback.hint).toBe("This turn paused automatically to avoid repeated tool calls. Select Continue to resume.");
  });
});
