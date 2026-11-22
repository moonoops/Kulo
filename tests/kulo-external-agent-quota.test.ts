import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_AGENT_QUOTA_CAPABILITY,
  deriveConnectedExternalClients,
  type EnvNodeDescriptor,
  type ExternalAgentBinding,
  type ExternalAgentQuotaProbeResult,
  type ExternalClientConnection,
} from "@kulo/protocol";
import {
  EnvManager,
  ExternalAgentService,
  KuloEnvAgent,
  ProjectDirectoryRegistry,
  formatQuotaCurrencyAmount,
  isExternalAgentRequest,
  isExternalAgentResponse,
  isValidQuotaProbeResult,
  mergeQuotaProbeResults,
  normalizeQuotaPlanLabel,
  parseClaudeControlUsageResponse,
  parseClaudeRateLimitEvent,
  parseCodexRateLimitsSnapshot,
  probeClaudeQuota,
  probeCodexQuota,
  probeGrokQuota,
  quotaClaudeOptions,
  sanitizeQuotaError,
} from "@kulo/env";
import { connectCodex, type ExternalDriverContext } from "../packages/env/src/external-agent-drivers.js";
import type { ExternalAgentPipeFactory, ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ExternalAgentQuotaService, startKuloHubServer } from "@kulo/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const tempRoots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanups.splice(0).reverse()) {
    await Promise.resolve(fn()).catch(() => {});
  }
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("external agent quota validation, PII scrubbing and normalization", () => {
  it("validates quota requests/responses strictly and rejects malformed payloads", () => {
    expect(isExternalAgentRequest({ operation: "quota", binding: { kind: "codex", envId: "local" } })).toBe(true);
    expect(isExternalAgentRequest({ operation: "quota", binding: { kind: "codex", envId: "local" }, extra: 1 })).toBe(false);

    const valid: ExternalAgentQuotaProbeResult = {
      kind: "codex",
      status: "ok",
      source: "live",
      fetchedAt: 1_700_000_000_000,
      planLabel: "Plus",
      ordinaryUsageAllowed: true,
      windows: [{ id: "codex:primary", label: "5h", usedPercent: 0, windowMinutes: 300, resetsAt: 1_700_003_600_000, severity: "normal" }],
      credits: { hasCredits: true, unlimited: false, balanceText: "$12.50" },
    };
    expect(isValidQuotaProbeResult(valid)).toBe(true);
    expect(isExternalAgentResponse({ type: "quota", quota: valid })).toBe(true);

    // Reject unknown extra keys, NaN, out-of-range percentages, control chars, > 16 windows, bad balanceText
    expect(isValidQuotaProbeResult({ ...valid, email: "alice@example.com" })).toBe(false);
    expect(isExternalAgentResponse({ type: "quota", quota: valid, leaked: true })).toBe(false);
    expect(isValidQuotaProbeResult({ ...valid, windows: [{ id: "p", label: "5h", usedPercent: Number.NaN }] })).toBe(false);
    expect(isValidQuotaProbeResult({ ...valid, windows: [{ id: "p", label: "5h", usedPercent: 101 }] })).toBe(false);
    expect(isValidQuotaProbeResult({ ...valid, windows: [{ id: "p", label: "5h\n", usedPercent: 10 }] })).toBe(false);
    expect(isValidQuotaProbeResult({ ...valid, windows: Array.from({ length: 17 }, (_, i) => ({ id: `w${i}`, label: "5h", usedPercent: 1 })) })).toBe(false);
    expect(isValidQuotaProbeResult({ ...valid, credits: { hasCredits: true, balanceText: "alice@corp.com" } })).toBe(false);
  });

  it("scrubs emails, local user paths, UUIDs and tokens from quota errors and whitelists plan labels", () => {
    const dirty = "Auth error for alice.chen@corp.com at /Users/alice/.claude/settings.json (org 123e4567-e89b-12d3-a456-426614174000) key sk-1234567890abcdef1234567890\nnext";
    const clean = sanitizeQuotaError(dirty)!;
    expect(clean).not.toContain("alice.chen@corp.com");
    expect(clean).not.toContain("/Users/alice");
    expect(clean).not.toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(clean).not.toContain("sk-1234567890");
    expect(clean).toContain("[email]");
    expect(clean).toContain("[path]");
    expect(clean).toContain("[id]");
    expect(clean).not.toMatch(/[\r\n]/);

    expect(normalizeQuotaPlanLabel("codex", "plus")).toBe("Plus");
    expect(normalizeQuotaPlanLabel("codex", "unknown")).toBeUndefined();
    expect(normalizeQuotaPlanLabel("codex", "acme-corp-custom")).toBeUndefined();
    expect(normalizeQuotaPlanLabel("claude-code", "max")).toBe("Max");
    expect(normalizeQuotaPlanLabel("claude-code", "custom_org")).toBeUndefined();

    expect(formatQuotaCurrencyAmount(1250, "USD")).toBe("$12.50");
    expect(formatQuotaCurrencyAmount(500, "JPY")).toBe("¥500");
  });

  it("parses Claude active usage and passive rate_limit_event with exact ratio scaling (> 1.0 overage -> 100%)", () => {
    const active = parseClaudeControlUsageResponse({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.4, resets_at: "2026-11-22T10:00:00Z" },
        seven_day: { utilization: 61, resets_at: "2026-11-29T00:00:00Z" },
        model_scoped: [{ display_name: "Opus", utilization: 85, resets_at: "2026-11-29T00:00:00Z" }],
        extra_usage: { is_enabled: true, used_credits: 360, monthly_limit: 2000, utilization: 18, currency: "USD" },
      },
    }, 1_700_000_000_000);
    expect(active.status).toBe("ok");
    expect(active.planLabel).toBe("Max");
    expect(active.windows.map((w) => [w.id, w.usedPercent, w.severity])).toEqual([
      ["five_hour", 42, "normal"],
      ["seven_day", 61, "normal"],
      ["model:opus", 85, "warning"],
    ]);
    expect(active.credits).toMatchObject({ hasCredits: true, isExtraUsage: true, balanceText: "$3.60 / $20.00", usedPercent: 18 });

    // Passive SDKRateLimitInfo: utilization is ALWAYS 0-1+ ratio (1.08 = 108% overage, NEVER 1%!)
    const overage = parseClaudeRateLimitEvent({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1.08,
      resetsAt: 1_760_000_000,
      isUsingOverage: true,
    }, 1_700_000_000_000)!;
    expect(overage.windows).toEqual([
      {
        id: "five_hour",
        label: "5h",
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: 1_760_000_000_000,
        severity: "exhausted",
      },
    ]);
    expect(overage.credits).toEqual({ hasCredits: true, isExtraUsage: true });

    const unified = parseClaudeRateLimitEvent({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: 1_760_000_100 },
        seven_day: { utilization: 0.81, resetsAt: 1_760_500_000 },
      },
    }, 1_700_000_000_000)!;
    expect(unified.windows.map((w) => [w.id, w.usedPercent, w.severity])).toEqual([
      ["five_hour", 42, "normal"],
      ["seven_day", 81, "warning"],
    ]);

    const merged = mergeQuotaProbeResults(active, overage);
    expect(merged.planLabel).toBe("Max");
    expect(merged.windows.find((w) => w.id === "five_hour")?.usedPercent).toBe(100);
    expect(merged.windows.find((w) => w.id === "seven_day")?.usedPercent).toBe(61);
  });

  it("isolates Claude quota options from user MCPs and Hooks", () => {
    const opts = quotaClaudeOptions("/usr/local/bin/claude", "/tmp/kulo-quota");
    expect(opts.settingSources).toEqual(["user"]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
    expect(opts.tools).toEqual([]);
    expect(opts.settings).toEqual({ disableAllHooks: true });
  });
});

describe("Codex, Claude Code and Grok quota probes and passive hooks", () => {
  it("probes Codex with isolated config, multi-bucket ordering, -32602 fallback, and API key short-circuit", async () => {
    const root = makeTempDir("kulo-codex-quota-");
    const sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    let capturedArgs: string[] = [];
    let failFirstRateLimits = true;
    const pipeFactory: ExternalAgentPipeFactory = async (spec) => {
      capturedArgs = [...spec.args];
      const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(JSON.stringify({ id, result }) + "\n"));
      const replyErr = (id: number, code: number, message: string) =>
        spec.onStdout(Buffer.from(JSON.stringify({ id, error: { code, message } }) + "\n"));
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
      return {
        exited,
        close: vi.fn(() => resolveExit(0)),
        cleanup: async () => true,
        write: (raw) => {
          const msg = JSON.parse(raw);
          sent.push(msg);
          if (msg.id === undefined) return;
          if (msg.method === "initialize") reply(msg.id, {});
          else if (msg.method === "account/read") reply(msg.id, { account: { type: "chatgpt", email: "hidden@example.com", planType: "plus" } });
          else if (msg.method === "account/rateLimits/read") {
            if (failFirstRateLimits) {
              failFirstRateLimits = false;
              // Test numeric code -32602 even when message doesn't literally say "Invalid params"
              replyErr(msg.id, -32602, "unexpected field");
              return;
            }
            reply(msg.id, {
              ordinaryUsageAllowed: true,
              rateLimitsByLimitId: {
                spark: {
                  limitId: "spark",
                  limitName: "Spark",
                  primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1_760_000_000 },
                },
                codex: {
                  limitId: "codex",
                  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_760_000_100 },
                  secondary: { usedPercent: 83, windowDurationMins: 10080, resetsAt: 1_760_600_000 },
                  credits: { hasCredits: true, unlimited: false, balance: "12.5" },
                  planType: "unknown",
                },
              },
            });
          }
        },
      };
    };

    const res = await probeCodexQuota({
      executable: process.execPath,
      cwd: root,
      controlRoot: path.join(root, "ctrl"),
      pipeFactory,
    });
    expect(capturedArgs).toEqual(["app-server", "-c", "mcp_servers={}"]);
    expect(sent.find((m) => m.method === "account/read")?.params).toEqual({ refreshToken: false });
    expect(res.status).toBe("ok");
    expect(res.planLabel).toBe("Plus");
    expect(res.windows.map((w) => [w.id, w.label, w.usedPercent, w.severity])).toEqual([
      ["codex:primary", "5h", 42, "normal"],
      ["codex:secondary", "7d", 83, "warning"],
      ["spark:primary", "Spark 5h", 15, "normal"],
    ]);
    expect(res.credits).toEqual({ hasCredits: true, unlimited: false, balanceText: "$12.50" });
    expect(JSON.stringify(res)).not.toContain("hidden@example.com");

    // API key account short-circuits without rateLimits/read
    const apiMethods: string[] = [];
    const apiRes = await probeCodexQuota({
      executable: process.execPath,
      cwd: root,
      controlRoot: path.join(root, "ctrl"),
      pipeFactory: async (spec) => {
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        return {
          exited,
          close: vi.fn(() => resolveExit(0)),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method) apiMethods.push(msg.method);
            if (msg.id === undefined) return;
            if (msg.method === "initialize") spec.onStdout(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + "\n"));
            else if (msg.method === "account/read") spec.onStdout(Buffer.from(JSON.stringify({ id: msg.id, result: { account: { type: "apiKey" } } }) + "\n"));
          },
        };
      },
    });
    expect(apiRes.status).toBe("api_key_billing");
    expect(apiMethods).not.toContain("account/rateLimits/read");
  });

  it("passively captures Codex account/rateLimits/updated without adding RPC on turn/completed", async () => {
    const root = makeTempDir("kulo-codex-passive-");
    let specRef!: ExternalAgentPipeOptions;
    const sentMethods: string[] = [];
    const observedQuotas: ExternalAgentQuotaProbeResult[] = [];
    const complete = vi.fn();
    const ctx: ExternalDriverContext = {
      binding: { kind: "codex", envId: "local" },
      executable: process.execPath,
      cwd: root,
      prompt: "test",
      timeoutMs: 10_000,
      readOnly: false,
      controlRoot: path.join(root, "ctrl"),
      servers: [],
      event: vi.fn(),
      quota: (q) => observedQuotas.push(q),
      session: vi.fn(),
      submitted: vi.fn(),
      complete,
      permission: vi.fn(async () => "0"),
      pipe: async (spec) => {
        specRef = spec;
        const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(JSON.stringify({ id, result }) + "\n"));
        return {
          exited: new Promise(() => {}),
          close: vi.fn(),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method) sentMethods.push(msg.method);
            if (msg.id === undefined) return;
            if (msg.method === "initialize") reply(msg.id, {});
            else if (msg.method === "model/list") reply(msg.id, { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5", isDefault: true }] });
            else if (msg.method === "account/read") reply(msg.id, { account: { type: "chatgpt" } });
            else if (msg.method === "thread/start") reply(msg.id, { thread: { id: "thr-1" }, model: "gpt-5" });
            else if (msg.method === "turn/start") reply(msg.id, { turn: { id: "turn-1" } });
          },
        };
      },
    };
    const { driver } = await connectCodex(ctx);
    // Notification without threadId must still be captured
    specRef.onStdout(Buffer.from(JSON.stringify({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_760_000_000 } } },
    }) + "\n"));
    specRef.onStdout(Buffer.from(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } },
    }) + "\n"));
    expect(observedQuotas).toHaveLength(1);
    expect(observedQuotas[0]!.windows[0]!.usedPercent).toBe(55);
    expect(complete).toHaveBeenCalledWith("completed", undefined);
    expect(sentMethods).not.toContain("account/rateLimits/read");
    driver.close();
  });

  it("handles Grok CLI fast path, team-managed exit 0, and shell-route fallback to _x.ai/billing", async () => {
    const root = makeTempDir("kulo-grok-quota-");
    const unusedPipe: ExternalAgentPipeFactory = async () => { throw new Error("should not spawn stdio"); };

    // Team-managed text with exit code 0
    const team = await probeGrokQuota({
      executable: process.execPath,
      cwd: root,
      pathEnv: "",
      pipeFactory: unusedPipe,
      runtimePaths: [],
      hasApiKey: false,
      runner: async () => ({ code: 0, stdout: "Usage limits are managed by your team.\n", stderr: "" }),
    });
    expect(team).toMatchObject({ kind: "grok", status: "ok", planLabel: "Team", windows: [] });

    // Not signed in + XAI_API_KEY -> api_key_billing
    const apiKey = await probeGrokQuota({
      executable: process.execPath,
      cwd: root,
      pathEnv: "",
      pipeFactory: unusedPipe,
      runtimePaths: [],
      hasApiKey: true,
      runner: async () => ({ code: 1, stdout: "", stderr: "Error: not signed in" }),
    });
    expect(apiKey.status).toBe("api_key_billing");

    // Shell route error -> Stage 2 ACP stdio `_x.ai/billing`
    const stdioMethods: string[] = [];
    const fallback = await probeGrokQuota({
      executable: process.execPath,
      cwd: root,
      pathEnv: "",
      runtimePaths: [],
      hasApiKey: false,
      runner: async () => ({ code: 1, stdout: "", stderr: "Error: `grok usage` can't show your plan's usage here yet. Run /usage inside grok instead." }),
      pipeFactory: async (spec) => {
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        return {
          exited,
          close: vi.fn(() => resolveExit(0)),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method) stdioMethods.push(msg.method);
            if (msg.id === undefined) return;
            if (msg.method === "initialize") spec.onStdout(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + "\n"));
            else if (msg.method === "_x.ai/billing") {
              spec.onStdout(Buffer.from(JSON.stringify({
                id: msg.id,
                result: {
                  subscriptionTier: "supergrok",
                  config: { creditUsagePercent: 37.6, currentPeriod: { end: "2026-11-23T00:00:00Z" } },
                },
              }) + "\n"));
            }
          },
        };
      },
    });
    expect(stdioMethods).toEqual(["initialize", "_x.ai/billing"]);
    expect(fallback.status).toBe("ok");
    expect(fallback.planLabel).toBe("SuperGrok");
    expect(fallback.windows[0]).toMatchObject({ id: "period", usedPercent: 38 });
  });

  it("short-circuits Claude Console API key and heals corrupt latestQuota receipts on Env restart", async () => {
    const root = makeTempDir("kulo-env-quota-");
    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "grants.json"),
      scratchRoot: path.join(root, "scratch"),
    });
    let sdkCalled = false;
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: root,
      projectRegistry: registry,
      claudeAuthStatus: async () => ({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }),
      claudeQuotaProbe: async () => {
        sdkCalled = true;
        return { kind: "claude-code", status: "ok", source: "live", fetchedAt: Date.now(), windows: [] };
      },
    });
    cleanups.push(() => service.close());

    const claudeRes = await service.request({
      operation: "quota",
      binding: { kind: "claude-code", envId: "local", executable: process.execPath },
    });
    expect(claudeRes.type).toBe("quota");
    if (claudeRes.type === "quota") expect(claudeRes.quota.status).toBe("api_key_billing");
    expect(sdkCalled).toBe(false);

    // ACP kind returns unsupported immediately
    const acpRes = await service.request({
      operation: "quota",
      binding: { kind: "antigravity", envId: "local" },
    });
    expect(acpRes).toMatchObject({ type: "quota", quota: { kind: "antigravity", status: "unsupported", windows: [] } });

    // Write a persisted run receipt containing corrupt latestQuota (usedPercent: null) and ensure boot heals it
    const runId = "run-corrupt-quota-1";
    const receiptPath = path.join(service.rootDir, createHash("sha256").update(runId).digest("hex") + ".json");
    fs.writeFileSync(receiptPath, JSON.stringify({
      version: 1,
      fingerprint: "fp-1",
      cwd: root,
      executable: process.execPath,
      readOnly: true,
      run: {
        id: runId,
        taskId: "tk-1",
        runEpoch: 1,
        kind: "codex",
        state: "completed",
        text: "done",
        events: [],
        permissions: [],
        nextSequence: 1,
        quiescent: true,
        latestQuota: { kind: "codex", status: "ok", source: "passive_run", fetchedAt: 1, windows: [{ id: "p", label: "5h", usedPercent: null }] },
      },
    }), { mode: 0o600 });

    const restarted = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry });
    cleanups.push(() => restarted.close());
    const inspected = await restarted.request({ operation: "inspect", runId });
    expect(isExternalAgentResponse(inspected)).toBe(true);
    expect(inspected.type).toBe("run");
    if (inspected.type === "run") {
      expect(inspected.run.latestQuota).toBeUndefined();
    }

    // Valid latestQuota is stripped on compact inspect
    const validRunId = "run-valid-quota-1";
    const validReceipt = path.join(service.rootDir, createHash("sha256").update(validRunId).digest("hex") + ".json");
    fs.writeFileSync(validReceipt, JSON.stringify({
      version: 1,
      fingerprint: "fp-2",
      cwd: root,
      executable: process.execPath,
      readOnly: true,
      run: {
        id: validRunId,
        taskId: "tk-2",
        runEpoch: 1,
        kind: "codex",
        state: "completed",
        text: "done",
        events: [],
        permissions: [],
        nextSequence: 1,
        quiescent: true,
        latestQuota: { kind: "codex", status: "ok", source: "passive_run", fetchedAt: 1000, windows: [{ id: "p", label: "5h", usedPercent: 30 }] },
      },
    }), { mode: 0o600 });
    const restarted2 = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry });
    cleanups.push(() => restarted2.close());
    const fullSnap = await restarted2.request({ operation: "inspect", runId: validRunId });
    const compactSnap = await restarted2.request({ operation: "inspect", runId: validRunId, compact: true });
    expect(fullSnap.type === "run" && fullSnap.run.latestQuota?.windows[0]?.usedPercent).toBe(30);
    expect(compactSnap.type === "run" && compactSnap.run.latestQuota).toBeUndefined();
  });

  it("probeClaudeQuota rejects gracefully when SDK lacks experimental usage method", async () => {
    const root = makeTempDir("kulo-claude-fallback-");
    const res = await probeClaudeQuota({
      executable: process.execPath,
      cwd: root,
      controlRoot: path.join(root, "ctrl"),
      queryFn: (() => ({
        initializationResult: async () => ({}),
        close: () => {},
      })) as unknown as Parameters<typeof probeClaudeQuota>[0]["queryFn"],
    });
    expect(res.status).toBe("unavailable");
    expect(res.error).toContain("active usage API");
  });
});

describe("ExternalAgentQuotaService caching, cooldowns, Singleflight and Hub HTTP routes", () => {
  it("enforces soft TTL, tiered force cooldown (15s vs 3s), failure retention, reconnecting/env_outdated and independent Singleflight", async () => {
    let nowMs = 1_700_000_000_000;
    let connState: "online" | "reconnecting" | "offline" = "online";
    let envCaps = ["external-agents", EXTERNAL_AGENT_QUOTA_CAPABILITY];
    let clients: ExternalClientConnection[] = [
      { id: "codex:local", kind: "codex", envId: "local", models: [], updatedAt: 1 },
      { id: "claude-code:remote", kind: "claude-code", envId: "remote", models: [], updatedAt: 1 },
      { id: "antigravity:local", kind: "antigravity", envId: "local", models: [], updatedAt: 1 },
    ];
    let codexCalls = 0;
    let codexMode: "ok" | "fail" | "unauth" = "ok";
    let releaseSlowCodex: (() => void) | undefined;
    const envs: Record<string, EnvNodeDescriptor> = {
      local: { id: "local", name: "MacBook", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/tmp", capabilities: ["external-agents", EXTERNAL_AGENT_QUOTA_CAPABILITY], connectedAt: 1, lastSeenAt: 1 },
      remote: { id: "remote", name: "Mac mini", kind: "reverse-ws", online: true, platform: "darwin", arch: "arm64", rootDir: "/tmp", capabilities: envCaps, connectedAt: 1, lastSeenAt: 1 },
    };

    const service = new ExternalAgentQuotaService({
      getClients: () => clients,
      getEnvDescriptor: (id) => (id === "remote" ? { ...envs.remote!, capabilities: envCaps } : envs[id]),
      getEnvConnectionState: (id) => (id === "remote" ? connState : "online"),
      now: () => nowMs,
      requestQuota: async (_envId, binding) => {
        if (binding.kind === "codex") {
          codexCalls++;
          if (releaseSlowCodex) {
            await new Promise<void>((resolve) => {
              const prev = releaseSlowCodex;
              releaseSlowCodex = undefined;
              prev?.();
              setTimeout(resolve, 25);
            });
          }
          if (codexMode === "fail") throw new Error("upstream 429 for user@corp.com");
          if (codexMode === "unauth") {
            return { type: "quota", quota: { kind: "codex", status: "unauthenticated", source: "live", fetchedAt: nowMs, windows: [] } };
          }
          return {
            type: "quota",
            quota: {
              kind: "codex",
              status: "ok",
              source: "live",
              fetchedAt: nowMs,
              planLabel: "Plus",
              windows: [{ id: "codex:primary", label: "5h", usedPercent: 30 + codexCalls, severity: "normal" }],
            },
          };
        }
        return { type: "quota", quota: { kind: "claude-code", status: "ok", source: "live", fetchedAt: nowMs, planLabel: "Max", windows: [] } };
      },
    });
    cleanups.push(() => service.close());

    // Initial snapshot: codex & claude stale, antigravity unsupported (0 RPC)
    const initial = service.getSnapshot();
    expect(initial.items.find((i) => i.clientId === "antigravity:local")).toMatchObject({ status: "unsupported", canRefresh: false, stale: false });
    expect(initial.items.find((i) => i.clientId === "codex:local")).toMatchObject({ canRefresh: true, stale: true });

    // Reconnecting remote device is treated as offline (never probed during 20s grace window)
    connState = "reconnecting";
    expect(service.getSnapshot().items.find((i) => i.clientId === "claude-code:remote")).toMatchObject({ status: "device_offline", canRefresh: false });

    // Outdated remote Env without EXTERNAL_AGENT_QUOTA_CAPABILITY -> env_outdated
    connState = "online";
    envCaps = ["external-agents"];
    expect(service.getSnapshot().items.find((i) => i.clientId === "claude-code:remote")).toMatchObject({ status: "env_outdated", canRefresh: false });
    envCaps = ["external-agents", EXTERNAL_AGENT_QUOTA_CAPABILITY];

    // Auto refresh populates codex & claude
    const afterFirst = await service.refresh({ force: false });
    expect(codexCalls).toBe(1);
    expect(afterFirst.items.find((i) => i.clientId === "codex:local")?.windows[0]?.usedPercent).toBe(31);

    // Within soft TTL (2 min): force=false skips probe
    nowMs += 60_000;
    await service.refresh({ force: false });
    expect(codexCalls).toBe(1);

    // Manual force=true right after auto probe succeeds (3s quick cooldown passed)
    await service.refresh({ clientId: "codex:local", force: true });
    expect(codexCalls).toBe(2);

    // Consecutive force=true within 15s cooldown is suppressed
    nowMs += 5_000;
    await service.refresh({ clientId: "codex:local", force: true });
    expect(codexCalls).toBe(2);

    // After 15s cooldown, failure preserves lastOk and attaches scrubbed refreshError
    nowMs += 11_000;
    codexMode = "fail";
    const afterFail = await service.refresh({ clientId: "codex:local", force: true });
    const codexFailed = afterFail.items.find((i) => i.clientId === "codex:local")!;
    expect(codexFailed.status).toBe("ok");
    expect(codexFailed.windows[0]?.usedPercent).toBe(32);
    expect(codexFailed.refreshError).toContain("[email]");
    expect(codexFailed.refreshError).not.toContain("user@corp.com");

    // After failure, manual force=true only waits 3s quick cooldown (not 15s)
    nowMs += 3_500;
    codexMode = "unauth";
    const afterUnauth = await service.refresh({ clientId: "codex:local", force: true });
    expect(codexCalls).toBe(4);
    expect(afterUnauth.items.find((i) => i.clientId === "codex:local")?.status).toBe("unauthenticated");

    // Aborting caller HTTP signal does NOT abort shared Singleflight cache write
    nowMs += 4_000;
    codexMode = "ok";
    let startedResolve!: () => void;
    const started = new Promise<void>((r) => { startedResolve = r; });
    releaseSlowCodex = () => startedResolve();
    const callerAbort = new AbortController();
    const pendingRefresh = service.refresh({ clientId: "codex:local", force: true, signal: callerAbort.signal });
    await started;
    callerAbort.abort();
    await pendingRefresh;
    // Wait for background Singleflight completion
    await vi.waitFor(() => {
      expect(service.getSnapshot().items.find((i) => i.clientId === "codex:local")?.status).toBe("ok");
    });

    // Passive ingestion merges without overwriting newer snapshot, and respects bindingFingerprint
    const olderPassive = service.ingestPassiveQuota(
      { kind: "codex", envId: "local" },
      { kind: "codex", status: "ok", source: "passive_run", fetchedAt: nowMs - 10_000, windows: [{ id: "codex:primary", label: "5h", usedPercent: 99 }] },
    );
    expect(olderPassive).toBe(false);
    const wrongBindingPassive = service.ingestPassiveQuota(
      { kind: "codex", envId: "local", executable: "/custom/codex" },
      { kind: "codex", status: "ok", source: "passive_run", fetchedAt: nowMs + 1000, windows: [{ id: "codex:secondary", label: "7d", usedPercent: 77 }] },
    );
    expect(wrongBindingPassive).toBe(false);
    const validPassive = service.ingestPassiveQuota(
      { kind: "codex", envId: "local" },
      { kind: "codex", status: "ok", source: "passive_run", fetchedAt: nowMs + 1000, windows: [{ id: "codex:secondary", label: "7d", usedPercent: 77 }] },
    );
    expect(validPassive).toBe(true);
    const mergedItem = service.getSnapshot().items.find((i) => i.clientId === "codex:local")!;
    expect(mergedItem.windows.map((w) => w.id)).toEqual(["codex:primary", "codex:secondary"]);

    // Client removal evicts cache
    clients = clients.filter((c) => c.id !== "codex:local");
    service.reconcileClients(clients);
    expect(service.getSnapshot().items.some((i) => i.clientId === "codex:local")).toBe(false);
  });

  it("derives connected clients from both externalClients and roles[id].external", () => {
    const derived = deriveConnectedExternalClients(
      {
        codex: {
          id: "codex",
          label: "Codex",
          whenToUse: "code",
          prompt: "code",
          external: { kind: "codex", envId: "local" },
        },
      },
      {
        "antigravity:local": { id: "antigravity:local", kind: "antigravity", envId: "local", models: [], updatedAt: 1 },
      },
    );
    expect(derived.map((c) => c.id)).toEqual(["antigravity:local", "codex:local"]);
  });

  it("exposes GET /api/external-clients/quotas and origin-guarded POST /api/external-clients/quotas/refresh without route collision", async () => {
    const dir = makeTempDir("kulo-quota-http-");
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "quota-http-test" }] }).provider);
    const hub = await openTestHub({
      models,
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "runtime"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        envTokens: {},
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    const base = server.url;
    const headers = { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` };

    const getRes = await fetch(`${base}/api/external-clients/quotas`, { headers });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("cache-control")).toBe("no-store");
    const snap = await getRes.json() as { serverTime: number; items: unknown[] };
    expect(typeof snap.serverTime).toBe("number");
    expect(Array.isArray(snap.items)).toBe(true);

    // Cross-site POST is blocked with 403
    const crossSite = await fetch(`${base}/api/external-clients/quotas/refresh`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);

    // Foreign origin POST is blocked with 403
    const foreignOrigin = await fetch(`${base}/api/external-clients/quotas/refresh`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(foreignOrigin.status).toBe(403);

    // Same-origin POST hits quota refresh (NOT /api/external-clients/:id/refresh!)
    const okPost = await fetch(`${base}/api/external-clients/quotas/refresh`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", origin: base },
      body: JSON.stringify({ force: true }),
    });
    expect(okPost.status).toBe(200);
    const refreshed = await okPost.json() as { items: unknown[] };
    expect(Array.isArray(refreshed.items)).toBe(true);
  });

  it("advertises external-agent-quota capability over real EnvManager <-> KuloEnvAgent and rejects cross-type quota response safely", async () => {
    const hubRoot = makeTempDir("kulo-bridge-quota-hub-");
    const peerRoot = makeTempDir("kulo-bridge-quota-peer-");
    const manager = new EnvManager({
      localRootDir: hubRoot,
      authToken: "secret-bridge-token",
      envTokens: { "peer-1": "peer-secret-1" },
      workerEnvIds: ["peer-1"],
    });
    cleanups.push(() => manager.close());

    // Start minimal WS server wired to EnvManager
    const http = await import("node:http");
    const { WebSocketServer } = await import("ws");
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws/env" });
    wss.on("connection", (ws, req) => manager.handleEnvWebSocket(ws, req));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { wss.close(); httpServer.close(() => resolve()); }));
    const port = (httpServer.address() as { port: number }).port;

    const agent = new KuloEnvAgent({
      envId: "peer-1",
      name: "Remote Mac",
      hubUrl: `ws://127.0.0.1:${port}/ws/env`,
      authToken: "peer-secret-1",
      rootDir: peerRoot,
      reconnect: false,
    });
    agent.start();
    cleanups.push(() => agent.stop());

    await vi.waitFor(() => {
      const desc = manager.getEnvDescriptor("peer-1");
      expect(desc?.online).toBe(true);
      expect(desc?.capabilities).toContain(EXTERNAL_AGENT_QUOTA_CAPABILITY);
    });

    // Live quota RPC over WS for unsupported kind returns cleanly without crashing
    const res = await manager.requestExternalAgent("peer-1", {
      operation: "quota",
      binding: { kind: "antigravity", envId: "peer-1" },
    });
    expect(res).toMatchObject({ type: "quota", quota: { kind: "antigravity", status: "unsupported", windows: [] } });

    // Malicious/rogue Peer returning `{ type: "quota" }` to an `inspect` request must NOT crash Hub (P0-1)
    const { WebSocket } = await import("ws");
    const rogue = new WebSocket(`ws://127.0.0.1:${port}/ws/env`, { headers: { authorization: "Bearer secret-bridge-token" } });
    cleanups.push(() => { try { rogue.close(); } catch { /* ignore */ } });
    manager.setDeviceCredential("peer-rogue", "rogue-secret");
    await new Promise<void>((resolve, reject) => {
      rogue.once("open", () => resolve());
      rogue.once("error", reject);
    });
    rogue.send(JSON.stringify({
      type: "env.register",
      envId: "peer-rogue",
      name: "Rogue",
      rootDir: peerRoot,
      platform: "darwin",
      arch: "arm64",
      token: "rogue-secret",
      capabilities: ["external-agents", EXTERNAL_AGENT_QUOTA_CAPABILITY],
    }));
    await vi.waitFor(() => expect(manager.getEnvDescriptor("peer-rogue")?.online).toBe(true));
    rogue.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8")) as { type?: string; requestId?: string };
      if (msg.type === "hub.external_agent_request" && msg.requestId) {
        rogue.send(JSON.stringify({
          type: "env.external_agent_result",
          requestId: msg.requestId,
          result: {
            type: "quota",
            quota: { kind: "codex", status: "ok", source: "live", fetchedAt: Date.now(), windows: [] },
          },
        }));
      }
    });
    await expect(manager.requestExternalAgent("peer-rogue", { operation: "inspect", runId: "run-xyz" })).rejects.toThrow("Invalid external agent response");
  });
});
