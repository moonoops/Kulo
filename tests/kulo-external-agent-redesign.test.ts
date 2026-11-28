import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { EnvManager } from "@kulo/env";
import {
  defaultRolePresets,
  isBundledClaudeSdkExecutable,
  type EnvNodeDescriptor,
  type ExternalAgentKind,
  type ExternalAgentRequest,
  type ExternalAgentResponse,
  type ExternalAgentRun,
  type RolePreset,
} from "@kulo/protocol";
import {
  augmentedNativePath,
  connectAcp,
  connectCodex,
  parseLoginShellPathOutput,
  resolveExternalExecutable,
  type ExternalDriverContext,
} from "../packages/env/src/external-agent-drivers.js";
import { nativeClaudeOptions } from "../packages/env/src/external-agent-claude.js";
import { ExternalAgentService } from "../packages/env/src/external-agents.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";
import type { ExternalAgentPipeFactory, ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
import { extractAgentDispatchIntent, resolveAgentDispatch } from "../packages/hub/src/agent-routing.js";
import { resolveComputerEnvBinding } from "../packages/hub/src/env-routing-policy.js";
import { applySettingsBlockUpdate, KuloSettingsDoc, syncExternalClientsInSettings, type KuloDurableSettings } from "../packages/hub/src/settings.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import type { KuloHubConfigOverrides } from "@kulo/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const context = BACKGROUND_CONTEXT;

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(file => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY", "KULO_ENV_TOKENS"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("external agent redesign — Env & Driver invariants (B1, B5, B6, E2, E4, E5, I1)", () => {
  it("parses login shell PATH between sentinels and strips banners, empty/relative segments, and puts user dirs ahead of system stubs (B6)", () => {
    const parsed = parseLoginShellPathOutput("Welcome banner!\n__KULO_PATH_START__:/opt/homebrew/bin:relative/dir::/usr/local/bin:/bad\x00path:/opt/homebrew/bin__KULO_PATH_END__\ntrailing");
    expect(parsed).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);

    const combined = augmentedNativePath("/usr/bin:/bin::./evil", ["/custom/tool/bin"]);
    const parts = combined.split(path.delimiter);
    expect(parts.every(seg => path.isAbsolute(seg) && seg.length > 0)).toBe(true);
    expect(parts).not.toContain("./evil");
    expect(parts.indexOf("/custom/tool/bin")).toBe(0);
    expect(parts.indexOf("/custom/tool/bin")).toBeLessThan(parts.indexOf("/usr/bin"));
  });

  it("identifies and ignores bundled Claude Agent SDK paths in executable resolution (B5, E2)", () => {
    const bundledMac = "/Applications/Kulo Dev.app/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    const bundledPnpm = "/Users/dev/project/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.0/node_modules/@anthropic-ai/claude-agent-sdk/claude";
    expect(isBundledClaudeSdkExecutable(bundledMac)).toBe(true);
    expect(isBundledClaudeSdkExecutable(bundledPnpm)).toBe(true);
    expect(isBundledClaudeSdkExecutable("/Users/dev/.local/bin/claude")).toBe(false);

    vi.stubEnv("PATH", "/nonexistent-dir-kulo-test");
    const resolved = resolveExternalExecutable("claude-code", bundledMac);
    if (resolved) expect(isBundledClaudeSdkExecutable(resolved)).toBe(false);
  });

  it("enforces disallowedTools + canUseTool read-only guard on Claude Code strictly when workspaceMode is read_only (B1)", async () => {
    const root = tempDir("kulo-claude-ro-");
    const ctx: ExternalDriverContext = {
      binding: { kind: "claude-code", envId: "local" },
      executable: process.execPath,
      cwd: root,
      workspaceMode: "read_only",
      readOnly: true,
      prompt: "Audit",
      timeoutMs: 10_000,
      servers: [],
      pipe: async () => { throw new Error("unused"); },
      event: vi.fn(),
      session: vi.fn(),
      submitted: vi.fn(),
      complete: vi.fn(),
      permission: vi.fn(async () => "allow"),
    };
    const opts = nativeClaudeOptions(ctx);
    expect(opts.disallowedTools).toEqual(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
    const decision = await opts.canUseTool!("Edit", { file_path: "a.ts" }, { toolUseID: "t1", signal: new AbortController().signal });
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(ctx.permission).not.toHaveBeenCalled();
  });

  it("handles ACP per-model efforts from session.models, auto-mkdir on fs/write_text_file, and thought heartbeats (E4, I4)", async () => {
    const root = tempDir("kulo-acp-enhancements-");
    const cwd = path.join(root, "staged");
    fs.mkdirSync(cwd);
    const responses = new Map<number, Record<string, unknown>>();
    let spec!: ExternalAgentPipeOptions;
    const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(JSON.stringify({ id, result }) + "\n"));
    const activity = vi.fn();
    const ctx: ExternalDriverContext = {
      binding: { kind: "antigravity", envId: "local" },
      executable: process.execPath,
      cwd,
      workspaceMode: "staged",
      readOnly: false,
      prompt: "hello",
      timeoutMs: 10_000,
      servers: [],
      event: vi.fn(),
      activity,
      session: vi.fn(),
      submitted: vi.fn(),
      complete: vi.fn(),
      permission: vi.fn(async () => "allow"),
      pipe: async value => {
        spec = value;
        return {
          exited: new Promise(() => {}),
          close: vi.fn(),
          cleanup: async () => true,
          write: raw => {
            const msg = JSON.parse(raw);
            if (!msg.method) { responses.set(msg.id, msg); return; }
            if (msg.method === "initialize") reply(msg.id, { agentCapabilities: { mcpCapabilities: { http: true } } });
            else if (msg.method === "session/new") reply(msg.id, {
              sessionId: "acp-1",
              configOptions: [
                { id: "model", category: "model", currentValue: "gemini-4-carbon", options: [
                  { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
                  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
                ] },
                { id: "thought_level", category: "thought_level", options: [{ value: "low" }, { value: "high" }] },
              ],
              models: {
                currentModelId: "gemini-4-carbon?thinkingLevel=high",
                availableModels: [
                  { modelId: "gemini-4-carbon?thinkingLevel=low", name: "Gemini 4 Carbon (low)" },
                  { modelId: "gemini-4-carbon?thinkingLevel=high", name: "Gemini 4 Carbon (high)" },
                  { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
                ],
              },
            });
            else if (msg.method === "session/prompt") {
              spec.onStdout(Buffer.from(JSON.stringify({ method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } }) + "\n"));
            }
          },
        };
      },
    };
    const { driver, models } = await connectAcp(ctx, false);
    try {
      expect(models).toEqual([
        { id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "high"], effortCapability: "supported", isDefault: true },
        { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", effortCapability: "unsupported" },
      ]);
      expect(activity).toHaveBeenCalledWith("Thinking...");
      const nested = path.join(cwd, "sub", "dir", "new.txt");
      spec.onStdout(Buffer.from(JSON.stringify({ id: 901, method: "fs/write_text_file", params: { sessionId: "acp-1", path: nested, content: "created" } }) + "\n"));
      await vi.waitFor(() => expect(responses.has(901)).toBe(true));
      expect(responses.get(901)).toMatchObject({ result: {} });
      expect(fs.readFileSync(nested, "utf8")).toBe("created");
    } finally { driver.close(); }
  });

  it("handles Codex reasoning/command heartbeats, item/completed message fallback, and requestUserInput bridge (E4)", async () => {
    const root = tempDir("kulo-codex-enhancements-");
    let spec!: ExternalAgentPipeOptions;
    const responses = new Map<number, Record<string, unknown>>();
    const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(JSON.stringify({ id, result }) + "\n"));
    const events: Array<[string, string]> = [];
    const activity = vi.fn();
    const ctx: ExternalDriverContext = {
      binding: { kind: "codex", envId: "local" },
      executable: process.execPath,
      cwd: root,
      readOnly: false,
      prompt: "test",
      timeoutMs: 10_000,
      servers: [],
      event: (type, text) => events.push([type, text]),
      activity,
      session: vi.fn(),
      submitted: vi.fn(),
      complete: vi.fn(),
      permission: vi.fn(async () => "1"),
      pipe: async value => {
        spec = value;
        return {
          exited: new Promise(() => {}),
          close: vi.fn(),
          cleanup: async () => true,
          write: raw => {
            const msg = JSON.parse(raw);
            if (!msg.method) { responses.set(msg.id, msg); return; }
            if (msg.method === "initialize") reply(msg.id, {});
            else if (msg.method === "model/list") reply(msg.id, { data: [{ id: "gpt-5", displayName: "GPT-5", isDefault: true }] });
            else if (msg.method === "account/read") reply(msg.id, { account: { type: "chatgpt" } });
            else if (msg.method === "thread/start") reply(msg.id, { thread: { id: "th-1" } });
            else if (msg.method === "turn/start") reply(msg.id, { turn: { id: "turn-1" } });
          },
        };
      },
    };
    const { driver } = await connectCodex(ctx, false);
    try {
      spec.onStdout(Buffer.from(JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { threadId: "th-1", delta: "hmm" } }) + "\n"));
      spec.onStdout(Buffer.from(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "th-1", delta: "running tests" } }) + "\n"));
      expect(activity).toHaveBeenCalledWith("Reasoning...");
      expect(activity).toHaveBeenCalledWith("Executing...");

      spec.onStdout(Buffer.from(JSON.stringify({
        id: 505,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "th-1",
          questions: [{ id: "q1", header: "Target", question: "Pick target?", options: [{ label: "A" }, { label: "B" }] }],
        },
      }) + "\n"));
      await vi.waitFor(() => expect(responses.has(505)).toBe(true));
      expect(responses.get(505)).toMatchObject({ result: { answers: { q1: { answers: ["B"] } } } });

      spec.onStdout(Buffer.from(JSON.stringify({
        method: "item/completed",
        params: { threadId: "th-1", item: { type: "agentMessage", text: "Fallback complete answer" } },
      }) + "\n"));
      expect(events).toContainEqual(["message", "Fallback complete answer"]);
    } finally { driver.close(); }
  });

  it("allows concurrent isolated project read_only external runs and cleans up agent-setup verification dirs on close (B1, E5, I1)", async () => {
    const root = tempDir("kulo-env-parallel-ro-");
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "index.ts"), "export const x = 1;\n");
    const registry = new ProjectDirectoryRegistry({ deviceId: "local", filePath: path.join(root, "private", "grants.json"), scratchRoot: path.join(root, "scratch") });
    const grant = registry.authorize({ projectId: "P-1", path: project, operationId: "grant-1" });

    let pipeCounter = 0;
    const pipes: Array<{ close: () => void }> = [];
    const factory: ExternalAgentPipeFactory = async options => {
      const idx = ++pipeCounter;
      let finish = (_code: number) => {};
      const emit = (v: unknown) => options.onStdout(Buffer.from(JSON.stringify(v) + "\n"));
      const p = {
        write: (raw: string) => {
          const msg = JSON.parse(raw);
          if (!msg.method) return;
          const reply = (res: unknown) => queueMicrotask(() => emit({ jsonrpc: "2.0", id: msg.id, result: res }));
          if (msg.method === "initialize") reply({ agentCapabilities: {} });
          else if (msg.method === "session/new") reply({ sessionId: `acp-${idx}`, configOptions: [] });
          else if (msg.method === "session/prompt") { /* stay running until closed */ }
          else reply({});
        },
        close: () => finish(0),
        exited: new Promise<number>(resolve => { finish = resolve; }),
      };
      pipes.push(p);
      return p;
    };

    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: factory });
    try {
      const r1 = await service.request({
        operation: "run",
        binding: { kind: "antigravity", envId: "local", executable: process.execPath },
        taskId: "T-RO-1", runEpoch: 1, requestId: "kulo:external:T-RO-1:1",
        prompt: "Audit A", cwd: project, workspaceMode: "read_only", readOnly: true, allowSubagents: false,
        projectId: "P-1", directoryId: grant.directoryId, grantRevision: grant.revision, timeoutMs: 30_000,
      });
      const r2 = await service.request({
        operation: "run",
        binding: { kind: "antigravity", envId: "local", executable: process.execPath },
        taskId: "T-RO-2", runEpoch: 1, requestId: "kulo:external:T-RO-2:1",
        prompt: "Audit B", cwd: project, workspaceMode: "read_only", readOnly: true, allowSubagents: false,
        projectId: "P-1", directoryId: grant.directoryId, grantRevision: grant.revision, timeoutMs: 30_000,
      });
      expect(r1.type).toBe("run");
      expect(r2.type).toBe("run");
      if (r1.type === "run" && r2.type === "run") {
        expect(r1.run.stagedCwd).toBeTruthy();
        expect(r2.run.stagedCwd).toBeTruthy();
        expect(r1.run.stagedCwd).not.toBe(r2.run.stagedCwd);
      }
      await service.request({ operation: "close", runId: "kulo:external:T-RO-1:1" });
      await service.request({ operation: "close", runId: "kulo:external:T-RO-2:1" });

      // Verification dir cleanup on close(discardStaged: true)
      const setupDir = path.join(root, "table", "agent-setup-test123");
      await service.request({
        operation: "run",
        binding: { kind: "antigravity", envId: "local", executable: process.execPath },
        taskId: "agent-setup-test123", runEpoch: 1, requestId: "agent-setup-test123:verify",
        prompt: "ping", cwd: setupDir, readOnly: false, allowSubagents: false, timeoutMs: 10_000,
      });
      expect(fs.existsSync(setupDir)).toBe(true);
      await service.request({ operation: "close", runId: "agent-setup-test123:verify", discardStaged: true });
      expect(fs.existsSync(setupDir)).toBe(false);
    } finally {
      await service.close();
    }
  });

  it("allows managed localEnvRoot under a protected stateDir parent while still blocking privateDirectory and sibling protected paths", async () => {
    const stateDir = tempDir("kulo-state-parent-");
    const workspaceRoot = path.join(stateDir, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(workspaceRoot, ".kulo-env", "grants.json"),
      scratchRoot: path.join(workspaceRoot, "scratch"),
      getProtectedPaths: () => [stateDir],
    });
    const factory: ExternalAgentPipeFactory = async options => {
      let finish = (_code: number) => {};
      const emit = (v: unknown) => options.onStdout(Buffer.from(JSON.stringify(v) + "\n"));
      return {
        write: (raw: string) => {
          const msg = JSON.parse(raw);
          if (!msg.method) return;
          const reply = (res: unknown) => queueMicrotask(() => emit({ jsonrpc: "2.0", id: msg.id, result: res }));
          if (msg.method === "initialize") reply({ agentCapabilities: {} });
          else if (msg.method === "session/new") reply({ sessionId: "acp-parent", configOptions: [] });
          else reply({});
        },
        close: () => finish(0),
        exited: new Promise<number>(resolve => { finish = resolve; }),
      };
    };
    const service = new ExternalAgentService({ envId: "local", rootDir: workspaceRoot, projectRegistry: registry, pipeFactory: factory });
    try {
      const probed = await service.request({ operation: "probe", binding: { kind: "antigravity", envId: "local", executable: process.execPath } });
      expect(probed).toMatchObject({ type: "detection", detection: { installed: true } });
      if (probed.type === "detection") expect(probed.detection.error).toBeUndefined();

      await expect(service.request({
        operation: "run",
        binding: { kind: "antigravity", envId: "local", executable: process.execPath },
        taskId: "T-BAD-1", runEpoch: 1, requestId: "kulo:external:T-BAD-1:1",
        prompt: "bad", cwd: path.join(workspaceRoot, ".kulo-env"), readOnly: false, allowSubagents: false, timeoutMs: 5000,
      })).rejects.toThrow("protected");

      await expect(service.request({
        operation: "run",
        binding: { kind: "antigravity", envId: "local", executable: process.execPath },
        taskId: "T-BAD-2", runEpoch: 1, requestId: "kulo:external:T-BAD-2:1",
        prompt: "bad", cwd: path.join(stateDir, "identity"), readOnly: false, allowSubagents: false, timeoutMs: 5000,
      })).rejects.toThrow(/requires a current project|protected/);
    } finally {
      await service.close();
    }
  });
});

describe("external agent redesign — Settings & Routing invariants (B2, B3, B4, B5, H1)", () => {
  it("preserves Claude native thinking levels ('adaptive', 'none', 'disabled') and strips legacy bundled Claude SDK paths (H1, I4, B5)", () => {
    const doc = KuloSettingsDoc.definition.initial();
    doc.roles = defaultRolePresets();
    const bundled = "/Applications/Kulo Dev.app/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    const claudeRole: RolePreset = {
      id: "claude-code",
      label: "Claude Code",
      whenToUse: "Deep reasoning",
      prompt: "Implement cleanly",
      enabled: true,
      thinkingLevel: "adaptive",
      externalClientId: "claude-code:local",
      external: { kind: "claude-code", envId: "local", executable: bundled, verifiedAt: 1000 },
    };
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, "claude-code": claudeRole }, { externalAgents: true });
    expect(doc.roles["claude-code"]?.thinkingLevel).toBe("adaptive");
    expect(doc.roles["claude-code"]?.external?.executable).toBeUndefined();
    expect(doc.externalClients?.["claude-code:local"]?.executable).toBeUndefined();

    // Non-adaptive external thinking values also preserved, invalid rejected
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, {
      ...doc.roles,
      "claude-code": { ...doc.roles["claude-code"]!, thinkingLevel: "disabled" },
    }, { externalAgents: true });
    expect(doc.roles["claude-code"]?.thinkingLevel).toBe("disabled");
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, {
      ...doc.roles,
      "claude-code": { ...doc.roles["claude-code"]!, thinkingLevel: "bad level with spaces" },
    }, { externalAgents: true })).toThrow(/思考深度/);

    // syncExternalClientsInSettings cleans legacy stored docs on startup
    doc.externalClients!["claude-code:local"]!.executable = bundled;
    syncExternalClientsInSettings(doc);
    expect(doc.externalClients!["claude-code:local"]!.executable).toBeUndefined();
  });

  it("routes INTERNAL_ALIASES to any requested built-in role instead of hardcoding coder (B4, H3)", () => {
    const roles = defaultRolePresets();
    const intent = extractAgentDispatchIntent("请用内置 Worker 帮我写一篇技术文档", roles);
    expect(intent?.targets).toEqual([expect.objectContaining({ internal: true })]);
    const routed = resolveAgentDispatch({ roles, intent, requestedRole: "writer", taskKind: "writing" });
    expect(routed).toMatchObject({ role: "writer", source: "explicit" });
    const fallback = resolveAgentDispatch({ roles, intent, taskKind: "coding" });
    expect(fallback).toMatchObject({ role: "coder", source: "explicit" });
  });

  it("permits independent read-only acceptance checker after explicit ready relay while keeping generic continuation locked (B3)", () => {
    const roles: Record<string, RolePreset> = {
      ...defaultRolePresets(),
      codex: {
        id: "codex", label: "Codex", whenToUse: "Code", prompt: "Code", enabled: true,
        external: { kind: "codex", envId: "mac", verifiedAt: 1 },
      },
    };
    const inherited = { agentId: "codex", source: "explicit" as const, requestedName: "Codex", taskKind: "coding" as const };
    // Independent checker verification after ready relay is allowed
    const review = resolveAgentDispatch({ roles, inheritedAssignment: inherited, relaySettledReady: true, requestedRole: "checker", taskKind: "review" });
    expect(review).toMatchObject({ role: "checker", readOnly: true });
    // Generic coder continuation stays locked to Codex (preserving existing explicit-naming contract)
    const cont = resolveAgentDispatch({ roles, inheritedAssignment: inherited, relaySettledReady: true, requestedRole: "coder", taskKind: "review" });
    expect(cont).toMatchObject({ role: "codex", source: "explicit" });
  });

  it("enforces sender_local protection on non-explicit cross-device external bindings while allowing location-independent cross-device routing (B2)", () => {
    const localConflict = resolveComputerEnvBinding({
      externalBindingDeviceId: "macmini",
      sourceEnvId: "macbook",
      userMessage: "整理我桌面 ~/Desktop/notes.md",
      goal: "整理桌面文档",
      scope: "~/Desktop",
      pickFallbackEnvId: () => "local",
    });
    expect(localConflict).toMatchObject({ envId: "macbook", envBinding: "sender_local", conflictWithSource: true });

    const locationIndependent = resolveComputerEnvBinding({
      externalBindingDeviceId: "macmini",
      sourceEnvId: "macbook",
      userMessage: "写一个独立脚本解析 JSON",
      goal: "编写 JSON 解析脚本",
      scope: "独立任务目录",
      pickFallbackEnvId: () => "local",
    });
    expect(locationIndependent).toMatchObject({ envId: "macmini", envBinding: "agent_bound" });
    expect(locationIndependent.conflictWithSource).toBeUndefined();
  });
});

describe("external agent redesign — Hub End-to-End Flows (B1–B5, I1–I6, H2–H9)", () => {
  async function hubFixture(options: { roles?: Record<string, RolePreset>; maxConcurrentWorkers?: number } = {}) {
    const directory = tempDir("kulo-ext-redesign-hub-");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 40 }, () => () => fauxAssistantMessage([fauxText("已收到结果。")])));
    const config: KuloHubConfigOverrides = {
      authToken: HUB_TEST_ADMIN_TOKEN,
      stateDir: path.join(directory, "state"),
      identityDir: path.join(directory, "identity"),
      localEnvRoot: path.join(directory, "main-workspace"),
      enableLocalEnv: false,
      envTokens: {},
      watchdogMinutes: 0,
      maxConcurrentWorkers: options.maxConcurrentWorkers ?? 2,
      memory: { enabled: false } as KuloHubConfigOverrides["memory"],
      model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
      ...(options.roles ? { roles: options.roles } : {}),
    };
    const hub = await openTestHub({ config, models });
    cleanups.push(() => hub.close());
    const devices: EnvNodeDescriptor[] = ["macbook", "macmini"].map(id => ({
      id, name: id === "macbook" ? "MacBook" : "Mac mini", kind: "reverse-ws", executionKind: "pi-env", online: true,
      platform: "darwin", arch: "arm64", rootDir: path.join(directory, id),
      capabilities: ["worker-isolation", "external-agents"], connectedAt: 1, lastSeenAt: 1,
    }));
    vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation(id => devices.find(d => d.id === id));
    vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => structuredClone(devices));
    vi.spyOn(hub.envManager, "pickDefaultWorkerEnvId").mockReturnValue("macbook");
    vi.spyOn(hub.envManager, "pickDefaultEnvId").mockReturnValue("macbook");
    vi.spyOn(hub.envManager, "createExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
    vi.spyOn(hub.envManager, "authorizeProjectDirectory").mockImplementation(async (_envId, input) => ({
      projectId: input.projectId, workspaceDir: input.path, directoryId: `dir:${input.path}`,
      revision: input.revision ?? 1, scratchRoot: path.join(directory, "scratch"), platform: "darwin",
    }));
    return { hub, directory, devices };
  }

  it("quickConnect generates friendly role IDs, populates authenticated in scan, does not persist auto executable, and verifyExternalClient supports markdown-wrapped nonces + rollback history (B5, H4, H8, I1, I2, S1)", async () => {
    const f = await hubFixture();
    let verifyReplyMode: "backticks" | "echoed_error" = "backticks";
    const runs = new Map<string, ExternalAgentRun>();
    vi.spyOn(f.hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, request): Promise<ExternalAgentResponse> => {
      if (request.operation === "detect") {
        return {
          type: "detection",
          detection: {
            kind: request.kind,
            installed: request.kind === "antigravity" || request.kind === "claude-code",
            executable: request.kind === "antigravity" ? "/Applications/Gemini.app/Contents/Helpers/agy" : "/Users/me/.local/bin/claude",
            version: "1.5.5",
            authenticated: request.kind === "claude-code" ? false : null,
            models: [],
            capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" },
          },
        };
      }
      if (request.operation === "probe") {
        return {
          type: "detection",
          detection: {
            kind: request.binding.kind,
            installed: true,
            executable: "/Applications/Gemini.app/Contents/Helpers/agy",
            version: "1.5.5",
            authenticated: null,
            models: [{ id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "high"], isDefault: true }],
            capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" },
          },
        };
      }
      if (request.operation === "run") {
        const token = /KULO_AGENT_VERIFY_[a-f0-9]+/.exec(request.prompt)?.[0] ?? "";
        const text = verifyReplyMode === "backticks" ? `\`\`\`\n${token}\n\`\`\`` : `Error executing prompt: ${token}`;
        const run: ExternalAgentRun = {
          id: request.requestId, taskId: request.taskId, runEpoch: request.runEpoch, kind: request.binding.kind,
          sessionId: "sess-1", state: "completed", text, events: [], permissions: [], nextSequence: 1, quiescent: true,
        };
        runs.set(request.requestId, run);
        return { type: "run", run };
      }
      if (request.operation === "inspect" || request.operation === "close") {
        return { type: "run", run: runs.get(request.runId)! };
      }
      throw new Error(`Unexpected op ${request.operation}`);
    });

    const scan = await f.hub.agentConfiguration.scan({ envId: "macbook" });
    const claudeCand = scan.candidates.find(c => c.kind === "claude-code");
    const agyCand = scan.candidates.find(c => c.kind === "antigravity");
    expect(claudeCand?.authenticated).toBe(false);
    expect(agyCand?.installed).toBe(true);

    // Connect protocol-only first (saved unverified in externalClients without auto-creating a role or persisting auto executable)
    const connected = await f.hub.agentConfiguration.quickConnect({
      clientId: "ui-test", kind: "antigravity", envId: "macbook", commandId: "cmd-proto", runTest: false,
    });
    expect(connected.agentId).toBeUndefined();
    expect(connected.clientId).toBe("antigravity:macbook");
    expect(connected.enabled).toBe(false);
    expect(connected.settings.blocks.roles.value["antigravity"]).toBeUndefined();
    const savedClient = connected.settings.externalClients?.["antigravity:macbook"]!;
    expect(savedClient.executable).toBeUndefined();
    expect(savedClient.verifiedAt).toBeUndefined();

    // Verify with echoed error text containing nonce MUST FAIL (I1)
    verifyReplyMode = "echoed_error";
    await expect(f.hub.verifyExternalClient(connected.clientId, { commandId: "verify-fail" })).rejects.toThrow(/测试回复/);

    // Verify with backtick-wrapped nonce MUST SUCCEED, stamp client verifiedAt, and record settings history (H4, I2)
    verifyReplyMode = "backticks";
    const historyBefore = f.hub.getSettingsView().history.length;
    const verified = await f.hub.verifyExternalClient(connected.clientId, { commandId: "verify-ok" });
    expect(verified.enabledRoleIds).toEqual([]);
    expect(verified.settings.externalClients?.["antigravity:macbook"]?.verifiedAt).toBeTypeOf("number");
    expect(verified.settings.history.length).toBeGreaterThan(historyBefore);

    // Retry with same commandId is idempotent (I2)
    const deduped = await f.hub.verifyExternalClient(connected.clientId, { commandId: "verify-ok" });
    expect(deduped.verifiedAt).toBe(verified.verifiedAt);

    // Direct explicit dispatch works even with zero roles bound to Antigravity
    await f.hub.sendUserMessage("请让 Antigravity 帮我检查这个目录", { topicId: "root" });
    const card = await f.hub.dispatchTicket({
      commandId: "direct-agy-1",
      title: "直接调用 Antigravity",
      goal: "检查目录",
      scope: f.directory,
      role: "client:antigravity:macbook",
      originConversationId: Number(f.hub.rootConversation.id),
    });
    expect(card.role).toBe("client:antigravity:macbook");
    expect(card.roleLabel).toBe("Antigravity");
    expect(card.externalAgentKind).toBe("antigravity");
  });

  it("clamps advisory thinkingLevel on auto external roles, uses concise follow-up prompt on resume, persists recentEvents timeline, and discards zero-diff staged workspace on ready (H5, H6, H9, I3, I4, I6, E6)", async () => {
    const agyRole: RolePreset = {
      id: "antigravity", label: "Antigravity", whenToUse: "Code", prompt: "Implement cleanly",
      enabled: true, readOnly: false, allowSubagents: false, thinkingLevel: "auto",
      externalClientId: "antigravity:macbook",
      external: { kind: "antigravity", envId: "macbook", verifiedAt: 1000, capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" } },
    };
    const f = await hubFixture({ roles: { ...defaultRolePresets(), antigravity: agyRole } });
    // Seed cached model efforts on the external client
    await f.hub.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc, {
        "antigravity:macbook": [{ id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "high", "none"], isDefault: true }],
      });
    }, context);
    // Reload live settings via refresh/save
    const rev = f.hub.getSettingsView().blocks.roles.revision;
    await f.hub.updateSettingsBlock("roles", rev, f.hub.getSettingsView().blocks.roles.value);

    const runRequests: Array<Extract<ExternalAgentRequest, { operation: "run" }>> = [];
    const closeRequests: Array<Extract<ExternalAgentRequest, { operation: "close" }>> = [];
    const runs = new Map<string, ExternalAgentRun>();
    vi.spyOn(f.hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, request): Promise<ExternalAgentResponse> => {
      if (request.operation === "run") {
        runRequests.push(request);
        const run: ExternalAgentRun = {
          id: request.requestId, taskId: request.taskId, runEpoch: request.runEpoch, kind: request.binding.kind,
          sessionId: request.sessionId ?? "agy-session-42",
          state: "completed",
          phase: "verifying",
          text: `Completed epoch ${request.runEpoch}`,
          stagedCwd: request.workspaceMode === "staged" ? `/tmp/staged/${request.taskId}` : undefined,
          stagedDiff: request.workspaceMode === "staged" ? { hasChanges: false, added: [], modified: [], deleted: [], conflictFiles: [], unifiedPreview: "", truncated: false } : undefined,
          events: [
            { sequence: 1, at: Date.now() - 200, type: "tool", text: "Read src/app.ts" },
            { sequence: 2, at: Date.now() - 100, type: "message", text: "chunk" },
            { sequence: 3, at: Date.now(), type: "state", text: "completed" },
          ],
          permissions: [],
          nextSequence: 4,
          quiescent: true,
        };
        runs.set(request.requestId, run);
        return { type: "run", run };
      }
      if (request.operation === "inspect") {
        return { type: "run", run: runs.get(request.runId)! };
      }
      if (request.operation === "close") {
        closeRequests.push(request);
        return { type: "run", run: runs.get(request.runId)! };
      }
      throw new Error(`Unexpected op ${request.operation}`);
    });

    const project = await f.hub.projects.create({ commandId: "proj-1", name: "Demo", deviceId: "macbook", workspaceDir: path.join(f.directory, "demo-repo") });
    // Dispatch with unsupported advisory thinkingLevel: "minimal" -> MUST be omitted (I4)
    const card = await f.hub.dispatchTicket({
      commandId: "cmd-clamp", title: "Inspect repo", goal: "Check build", scope: "src/", role: "antigravity",
      projectId: project.id, thinkingLevel: "minimal",
    });
    await vi.waitFor(async () => {
      const snap = await f.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 6000, interval: 20 });

    expect(Object.hasOwn(runRequests[0]!, "thinkingLevel")).toBe(false);
    // Zero-diff staged clone was discarded on ready, clearing stagedCwd without setting stagedAppliedAt (E6, I6)
    expect(closeRequests.some(c => c.discardStaged === true)).toBe(true);
    const afterEpoch1 = (await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
    expect(afterEpoch1.externalExecution?.stagedCwd).toBeUndefined();
    expect(afterEpoch1.externalExecution?.stagedAppliedAt).toBeUndefined();
    // Durable non-message recentEvents persisted (H9, I6)
    expect(afterEpoch1.externalExecution?.recentEvents?.some(ev => ev.type === "tool" && ev.text.includes("Read src/app.ts"))).toBe(true);
    expect(afterEpoch1.externalExecution?.recentEvents?.some(ev => ev.type === "message")).toBe(false);

    // inspectTicketDetail renders the persisted tool timeline (H9)
    const detail = await f.hub.inspectTicketDetail(card.id);
    expect(detail.transcript.some(item => item.role === "system_note" && item.text.includes("Read src/app.ts"))).toBe(true);

    // Steer into Epoch 2 with active sessionId -> concise follow-up prompt (H5, I3)
    await f.hub.steerTicket({ commandId: "steer-2", ticketId: card.id, text: "再补一个边界检查" });
    await vi.waitFor(() => expect(runRequests).toHaveLength(2), { timeout: 6000, interval: 20 });
    expect(runRequests[1]!.sessionId).toBe("agy-session-42");
    expect(runRequests[1]!.prompt).toContain("[Follow-up on Ticket");
    expect(runRequests[1]!.prompt).toContain("再补一个边界检查");
    expect(runRequests[1]!.prompt).not.toContain("Workspace Mode:");
  });
});
