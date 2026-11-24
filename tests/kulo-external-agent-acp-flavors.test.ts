import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedCustomAcpExecutableName,
  isSupportedExternalAgentKind,
  validateCustomAcpArgs,
  type EnvNodeDescriptor,
  type ExternalAgentDetection,
  type ExternalAgentKind,
  type KuloSettingsView,
} from "@kulo/protocol";
import {
  detectGrokAuthenticated,
  extractModelsFromAcpInitialize,
  isAcpAuthRequiredError,
  isSensitiveCredentialFilename,
  parseGrokModelsOutput,
  sortEffortTokens,
} from "../packages/env/src/external-agent-acp.js";
import {
  connectAcp,
  isProtectedAcpPath,
  resolveExternalExecutable,
  type ExternalDriverContext,
} from "../packages/env/src/external-agent-drivers.js";
import { ExternalAgentService } from "../packages/env/src/external-agents.js";
import { defaultProtectedPaths } from "../packages/env/src/isolation.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";
import type { ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
import { parseAcpRegistryPayload } from "../packages/hub/src/acp-registry.js";
import {
  AgentConfigurationDoc,
  KuloAgentConfiguration,
  type AgentConfigurationOptions,
} from "../packages/hub/src/agent-configuration.js";
import { extractAgentDispatchIntent } from "../packages/hub/src/agent-routing.js";
import { defaultRolePresets } from "@kulo/protocol";

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

describe("ACP flavors, Grok Build, OpenCode, Kiro, and custom ACP drivers", () => {
  it("parses grok models output and detects authentication without launching interactive login", async () => {
    const unauth = parseGrokModelsOutput("You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n");
    expect(unauth.authenticated).toBe(false);
    expect(unauth.models).toEqual([
      { id: "grok-4.6", name: "Grok 4.6", isDefault: true },
      { id: "grok-4.5", name: "Grok 4.5" },
    ]);

    const auth = parseGrokModelsOutput("You are logged in as user@example.com\n  * grok-4.6 (default)\n");
    expect(auth.authenticated).toBe(true);

    vi.stubEnv("XAI_API_KEY", "");
    expect(await detectGrokAuthenticated("/fake/grok", "/usr/bin", async () => ({ code: 0, output: "You are not authenticated." }))).toBe(false);
    expect(await detectGrokAuthenticated("/fake/grok", "/usr/bin", async () => ({ code: 1, output: "You are logged in" }))).toBe(null);

    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    const runner = vi.fn();
    expect(await detectGrokAuthenticated("/fake/grok", "/usr/bin", runner)).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("extracts Grok initialize._meta.modelState and sorts reasoningEfforts lowest to highest", () => {
    expect(sortEffortTokens(["xhigh", "high", "medium", "low"])).toEqual(["low", "medium", "high", "xhigh"]);
    const extracted = extractModelsFromAcpInitialize({
      _meta: {
        modelState: {
          currentModelId: "grok-4.6",
          availableModels: [
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEfforts: [
                  { value: "xhigh", label: "Extra High" },
                  { value: "high", label: "High" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                ],
              },
            },
            {
              modelId: "grok-fast",
              name: "Grok Fast",
              _meta: {
                supportsReasoningEffort: false,
                reasoningEfforts: [{ value: "high" }],
              },
            },
          ],
        },
      },
    });
    expect(extracted).toEqual({
      currentModelId: "grok-4.6",
      models: [
        { id: "grok-4.6", name: "Grok 4.6", efforts: ["low", "medium", "high", "xhigh"], isDefault: true },
        { id: "grok-fast", name: "Grok Fast" },
      ],
    });
  });

  it("supports Grok probeInitializeOnly, default model + thinkingLevel via session/set_model, readOnly args, cancel _meta, and x.ai/session/prompt_complete idempotency", async () => {
    const root = tempDir("kulo-grok-flavor-");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);

    const makeCtx = (opts: { readOnly?: boolean; modelId?: string; thinkingLevel?: string; completeViaExtension?: boolean }) => {
      const sent: Array<Record<string, unknown>> = [];
      let spec!: ExternalAgentPipeOptions;
      let rejectPromptOnClose: (() => void) | undefined;
      const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(`${JSON.stringify({ id, result })}\n`));
      const complete = vi.fn();
      const ctx: ExternalDriverContext = {
        binding: { kind: "grok", envId: "local" },
        executable: process.execPath,
        cwd,
        prompt: "grok task",
        modelId: opts.modelId,
        thinkingLevel: opts.thinkingLevel,
        timeoutMs: 10_000,
        readOnly: Boolean(opts.readOnly),
        controlRoot: path.join(root, "control"),
        servers: [],
        event: vi.fn(),
        activity: vi.fn(),
        session: vi.fn(),
        submitted: vi.fn(),
        complete,
        permission: vi.fn(async () => "0"),
        pipe: async (value) => {
          spec = value;
          return {
            exited: new Promise<number>((resolve) => { rejectPromptOnClose = () => resolve(0); }),
            close: vi.fn(() => { rejectPromptOnClose?.(); }),
            cleanup: async () => true,
            write: (raw) => {
              const msg = JSON.parse(raw) as Record<string, unknown>;
              sent.push(msg);
              const id = typeof msg.id === "number" ? msg.id : undefined;
              const method = typeof msg.method === "string" ? msg.method : undefined;
              if (id === undefined || !method) return;
              if (method === "initialize") {
                reply(id, {
                  protocolVersion: 1,
                  agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
                  _meta: {
                    modelState: {
                      currentModelId: "grok-4.6",
                      availableModels: [
                        {
                          modelId: "grok-4.6",
                          name: "Grok 4.6",
                          _meta: { reasoningEfforts: [{ value: "xhigh" }, { value: "high" }, { value: "low" }] },
                        },
                      ],
                    },
                  },
                });
              } else if (method === "session/new") {
                reply(id, { sessionId: "grok-sess-1" });
              } else if (method === "session/set_model") {
                reply(id, {});
              } else if (method === "session/prompt") {
                if (opts.completeViaExtension) {
                  const params = msg.params as Record<string, unknown>;
                  const meta = params._meta as Record<string, unknown>;
                  spec.onStdout(Buffer.from(`${JSON.stringify({
                    method: "x.ai/session/prompt_complete",
                    params: { sessionId: "grok-sess-1", promptId: meta.promptId, stopReason: "end_turn" },
                  })}\n`));
                } else {
                  reply(id, { stopReason: "end_turn" });
                }
              }
            },
          };
        },
      };
      return { ctx, sent, complete, get spec() { return spec; } };
    };

    // 1. Probe uses initialize._meta.modelState without calling session/new
    const probed = makeCtx({});
    const probeRes = await connectAcp(probed.ctx, true);
    expect(probed.spec.args).toEqual(["agent", "stdio"]);
    expect(probed.sent.find((m) => m.method === "initialize")?.params).toMatchObject({ _meta: { clientType: "extension" } });
    expect(probed.sent.some((m) => m.method === "session/new")).toBe(false);
    expect(probeRes.models).toEqual([
      { id: "grok-4.6", name: "Grok 4.6", efforts: ["low", "high", "xhigh"], isDefault: true },
    ]);
    probeRes.driver.close();

    // 2. Default model (modelId omitted) + explicit thinkingLevel uses session/set_model with _meta.reasoningEffort,
    //    readOnly switches args to --permission-mode default, and x.ai/session/prompt_complete settles idempotently once
    const run = makeCtx({ readOnly: true, thinkingLevel: "xhigh", completeViaExtension: true });
    const runRes = await connectAcp(run.ctx, false);
    expect(run.spec.args).toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(run.sent.find((m) => m.method === "session/set_model")?.params).toEqual({
      sessionId: "grok-sess-1",
      modelId: "grok-4.6",
      _meta: { reasoningEffort: "xhigh" },
    });
    await vi.waitFor(() => expect(run.complete).toHaveBeenCalledTimes(1));
    expect(run.complete).toHaveBeenCalledWith("completed");

    // 3. Cancel includes _meta.cancelTrigger = "ctrl_c"
    const cancelRun = makeCtx({ readOnly: false });
    const cancelRes = await connectAcp(cancelRun.ctx, true);
    // For cancel test, verify on a normal session
    cancelRes.driver.close();
    const liveCancel = makeCtx({ readOnly: false });
    // Delay prompt response so we can call cancel
    const liveCtx = liveCancel.ctx;
    const origPipe = liveCtx.pipe;
    let cancelSent: Array<Record<string, unknown>> = [];
    liveCtx.pipe = async (value) => {
      const p = await origPipe(value);
      const origWrite = p.write;
      return {
        ...p,
        write: (raw) => {
          const msg = JSON.parse(raw) as Record<string, unknown>;
          cancelSent.push(msg);
          if (msg.method === "session/prompt") return; // keep open until cancel
          origWrite(raw);
        },
      };
    };
    const liveDriver = await connectAcp(liveCtx, false);
    await liveDriver.driver.cancel();
    expect(cancelSent.find((m) => m.method === "session/cancel")?.params).toEqual({
      sessionId: "grok-sess-1",
      _meta: { cancelTrigger: "ctrl_c" },
    });
    liveDriver.driver.close();
  });

  it("collects async OpenCode config_option_update models during probe before submitted=true", async () => {
    const root = tempDir("kulo-opencode-grace-");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    let spec!: ExternalAgentPipeOptions;
    const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(`${JSON.stringify({ id, result })}\n`));
    const ctx: ExternalDriverContext = {
      binding: { kind: "opencode", envId: "local" },
      executable: process.execPath,
      cwd,
      prompt: "",
      timeoutMs: 10_000,
      readOnly: true,
      controlRoot: path.join(root, "control"),
      servers: [],
      event: vi.fn(),
      session: vi.fn(),
      submitted: vi.fn(),
      complete: vi.fn(),
      permission: vi.fn(async () => "0"),
      pipe: async (value) => {
        spec = value;
        return {
          exited: new Promise(() => {}),
          close: vi.fn(),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            if (msg.method === "initialize") reply(msg.id as number, { protocolVersion: 1, agentCapabilities: {} });
            else if (msg.method === "session/new") {
              reply(msg.id as number, { sessionId: "oc-1" });
              setTimeout(() => {
                spec.onStdout(Buffer.from(`${JSON.stringify({
                  method: "session/update",
                  params: {
                    sessionId: "oc-1",
                    update: {
                      sessionUpdate: "config_option_update",
                      configOptions: [
                        { id: "model", category: "model", currentValue: "gpt-5.4", options: [{ value: "gpt-5.4", name: "GPT-5.4" }] },
                      ],
                    },
                  },
                })}\n`));
              }, 30);
            }
          },
        };
      },
    };
    const res = await connectAcp(ctx, true);
    expect(spec.args).toEqual(["acp"]);
    expect(res.models).toEqual([{ id: "gpt-5.4", name: "GPT-5.4", isDefault: true }]);
    res.driver.close();
  });

  it("launches Kiro V3 with effortLevel config option and emits activity heartbeats on ACP v2 updates", async () => {
    const root = tempDir("kulo-kiro-flavor-");
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    const sent: Array<Record<string, unknown>> = [];
    let spec!: ExternalAgentPipeOptions;
    const activity = vi.fn();
    const reply = (id: number, result: unknown) => spec.onStdout(Buffer.from(`${JSON.stringify({ id, result })}\n`));
    const ctx: ExternalDriverContext = {
      binding: { kind: "kiro", envId: "local" },
      executable: process.execPath,
      cwd,
      prompt: "run kiro",
      thinkingLevel: "high",
      timeoutMs: 10_000,
      readOnly: false,
      controlRoot: path.join(root, "control"),
      servers: [],
      event: vi.fn(),
      activity,
      session: vi.fn(),
      submitted: vi.fn(),
      complete: vi.fn(),
      permission: vi.fn(async () => "0"),
      pipe: async (value) => {
        spec = value;
        return {
          exited: new Promise(() => {}),
          close: vi.fn(),
          cleanup: async () => true,
          write: (raw) => {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            sent.push(msg);
            if (msg.method === "initialize") reply(msg.id as number, { protocolVersion: 1, agentCapabilities: {} });
            else if (msg.method === "session/new") {
              reply(msg.id as number, {
                sessionId: "kiro-1",
                configOptions: [
                  { id: "model", category: "model", currentValue: "auto", options: [{ value: "auto", name: "Auto" }] },
                  { id: "effortLevel", category: "thinking", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
                ],
              });
            } else if (msg.method === "session/set_config_option") {
              reply(msg.id as number, {});
            } else if (msg.method === "session/prompt") {
              spec.onStdout(Buffer.from(`${JSON.stringify({ method: "session/update", params: { sessionId: "kiro-1", update: { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" } } })}\n`));
              spec.onStdout(Buffer.from(`${JSON.stringify({ method: "session/update", params: { sessionId: "kiro-1", update: { sessionUpdate: "usage_update", used: 100, size: 1000 } } })}\n`));
              reply(msg.id as number, { stopReason: "end_turn" });
            }
          },
        };
      },
    };
    const res = await connectAcp(ctx, false);
    expect(spec.args).toEqual(["acp", "--agent-engine=v3", "--auth-method=cli"]);
    expect(sent.find((m) => m.method === "session/set_config_option")?.params).toEqual({
      sessionId: "kiro-1",
      configId: "effortLevel",
      value: "high",
    });
    await vi.waitFor(() => expect(activity).toHaveBeenCalled());
    res.driver.close();
  });

  it("enforces custom ACP executable/symlink denylist and validates acpArgs", () => {
    for (const blocked of [
      "/bin/sh",
      "/bin/bash",
      "/bin/zsh",
      "/usr/bin/env",
      "/usr/bin/sudo",
      "/usr/bin/osascript",
    ]) {
      expect(isBlockedCustomAcpExecutableName(blocked), blocked).toBe(true);
    }
    for (const allowed of [
      "/opt/homebrew/bin/kimi-code",
      "/Users/test/.local/bin/hermes-acp",
      "/opt/homebrew/bin/python3.13",
      "/usr/local/bin/node22",
      "/usr/local/bin/npx",
      "/Users/test/.local/bin/uvx",
      "/Users/test/.bun/bin/bunx",
    ]) {
      expect(isBlockedCustomAcpExecutableName(allowed), allowed).toBe(false);
    }

    // Symlink disguise pointing to /bin/sh must be rejected on realpath double-check
    const dir = tempDir("kulo-acp-symlink-");
    const disguised = path.join(dir, "my-safe-agent");
    fs.symlinkSync("/bin/sh", disguised);
    expect(() => resolveExternalExecutable("acp", disguised)).toThrow(/generic shell/i);

    // Real custom executable script passes
    const legit = path.join(dir, "my-acp-cli");
    fs.writeFileSync(legit, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    expect(resolveExternalExecutable("acp", legit)).toBe(legit);

    // Claude bundled SDK symlink bypass is blocked
    const fakeSdkDir = path.join(dir, "@anthropic-ai", "claude-agent-sdk");
    fs.mkdirSync(fakeSdkDir, { recursive: true });
    const fakeSdkBin = path.join(fakeSdkDir, "cli.js");
    fs.writeFileSync(fakeSdkBin, "#!/usr/bin/env node\n", { mode: 0o755 });
    const claudeSymlink = path.join(dir, "claude");
    fs.symlinkSync(fakeSdkBin, claudeSymlink);
    expect(() => resolveExternalExecutable("claude-code", claudeSymlink)).toThrow(/Bundled Claude SDK/i);

    // Args validation
    expect(validateCustomAcpArgs(["acp", "--verbose"])).toEqual({ ok: true, value: ["acp", "--verbose"] });
    expect(validateCustomAcpArgs(["acp\nbad"]).ok).toBe(false);
    expect(validateCustomAcpArgs(Array.from({ length: 17 }, (_, i) => `--a${i}`)).ok).toBe(false);
  });

  it("short-circuits #probe when grok detect reports authenticated === false without spawning ACP process", async () => {
    const dir = tempDir("kulo-probe-shortcircuit-");
    const fakeGrok = path.join(dir, "grok");
    fs.writeFileSync(
      fakeGrok,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.92"; exit 0; fi\nif [ "$1" = "models" ]; then echo "You are not authenticated."; exit 0; fi\nexit 1\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("XAI_API_KEY", "");
    const pipeFactory = vi.fn();
    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(dir, ".kulo-env", "projects.json"),
      scratchRoot: path.join(dir, ".kulo-env", "scratch"),
    });
    const service = new ExternalAgentService({ envId: "local", rootDir: dir, projectRegistry: registry, pipeFactory });
    try {
      const response = await service.request({
        operation: "probe",
        binding: { kind: "grok", envId: "local", executable: fakeGrok },
      });
      expect(response.type).toBe("detection");
      if (response.type === "detection") {
        expect(response.detection.installed).toBe(true);
        expect(response.detection.authenticated).toBe(false);
        expect(response.detection.version).toBe("grok 1.0.92");
      }
      expect(pipeFactory).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("classifies ACP auth-required probe errors as authenticated: false without misclassifying non-auth -32000 errors", async () => {
    expect(isAcpAuthRequiredError(Object.assign(new Error("Authentication required"), { code: -32000 }))).toBe(true);
    expect(isAcpAuthRequiredError(Object.assign(new Error(""), { code: -32000 }))).toBe(true);
    expect(isAcpAuthRequiredError(new Error("Please sign in to view available models"))).toBe(true);
    expect(isAcpAuthRequiredError(Object.assign(new Error("HTTP 404: session not found"), { code: -32000 }))).toBe(false);

    const dir = tempDir("kulo-acp-auth-probe-");
    const fakeAgy = path.join(dir, "agy");
    fs.writeFileSync(fakeAgy, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.5.15"; exit 0; fi\nexit 0\n`, { mode: 0o755 });
    const makeService = (sessionNewError: { code: number; message: string }) => {
      const pipeFactory = vi.fn(async (spec: ExternalAgentPipeOptions) => {
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        return {
          exited,
          close: () => resolveExit(0),
          cleanup: async () => true,
          write: (raw: string) => {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            if (msg.method === "initialize") {
              spec.onStdout(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`));
            } else if (msg.method === "session/new") {
              spec.onStdout(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: sessionNewError })}\n`));
            }
          },
        };
      });
      const registry = new ProjectDirectoryRegistry({
        deviceId: "local",
        filePath: path.join(dir, ".kulo-env", "projects.json"),
        scratchRoot: path.join(dir, ".kulo-env", "scratch"),
      });
      return new ExternalAgentService({ envId: "local", rootDir: dir, projectRegistry: registry, pipeFactory });
    };

    const unauthService = makeService({ code: -32000, message: "Authentication required" });
    try {
      const response = await unauthService.request({
        operation: "probe",
        binding: { kind: "antigravity", envId: "local", executable: fakeAgy },
      });
      expect(response.type).toBe("detection");
      if (response.type === "detection") {
        expect(response.detection.installed).toBe(true);
        expect(response.detection.authenticated).toBe(false);
        expect(response.detection.error).toBeUndefined();
      }
    } finally {
      await unauthService.close();
    }

    const otherErrService = makeService({ code: -32000, message: "Workspace root rejected" });
    try {
      const response = await otherErrService.request({
        operation: "probe",
        binding: { kind: "antigravity", envId: "local", executable: fakeAgy },
      });
      expect(response.type).toBe("detection");
      if (response.type === "detection") {
        expect(response.detection.installed).toBe(true);
        expect(response.detection.authenticated).toBe(null);
        expect(response.detection.error).toContain("Workspace root rejected");
      }
    } finally {
      await otherErrService.close();
    }
  });
});

describe("isolation boundaries and ACP skill read allowlist", () => {
  it("protects all external client directories in defaultProtectedPaths while allowing own public skills only", () => {
    const fakeHome = "/tmp/kulo-fake-home";
    const protectedList = defaultProtectedPaths(fakeHome);
    for (const subdir of [".grok", ".cursor", ".opencode", ".kiro", ".copilot", ".gemini", ".antigravity", ".dsh"]) {
      expect(protectedList).toContain(path.join(fakeHome, subdir));
    }

    const home = os.homedir();
    // Own public skill files (including oauth/auth/state named skill folders!) are readable by antigravity
    expect(isProtectedAcpPath(path.join(home, ".gemini", "antigravity-cli", "builtin", "skills", "guide", "SKILL.md"), false, "antigravity")).toBe(false);
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "oauth-setup", "SKILL.md"), false, "antigravity")).toBe(false);
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "state-machine", "SKILL.md"), false, "antigravity")).toBe(false);
    // Writes inside protected directories remain strictly denied
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "oauth-setup", "SKILL.md"), true, "antigravity")).toBe(true);
    // Sensitive filenames inside skill subdirs remain strictly denied
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "auth.json"), false, "antigravity")).toBe(true);
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "config.toml"), false, "antigravity")).toBe(true);
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "mcp.json"), false, "antigravity")).toBe(true);
    expect(isProtectedAcpPath(path.join(home, ".gemini", "config", "skills", "state.sqlite"), false, "antigravity")).toBe(true);
    // Cross-client reads are strictly denied
    expect(isProtectedAcpPath(path.join(home, ".grok", "skills", "demo", "SKILL.md"), false, "antigravity")).toBe(true);
    expect(isProtectedAcpPath(path.join(home, ".cursor", "rules", "app.mdc"), false, "antigravity")).toBe(true);
    // Root credential files of the same client remain strictly denied
    expect(isProtectedAcpPath(path.join(home, ".gemini", "oauth_creds.json"), false, "antigravity")).toBe(true);
    expect(isSensitiveCredentialFilename("/tmp/skills/oauth-setup/SKILL.md")).toBe(false);
    expect(isSensitiveCredentialFilename("/tmp/skills/.env.local")).toBe(true);
  });
});

describe("routing disambiguation, Hub custom ACP UI-only enforcement, and ACP registry parsing", () => {
  it("routes Grok vs Grok Bot vs Cursor Agent without false positives on normal coding phrases", () => {
    const roles = defaultRolePresets();
    expect(extractAgentDispatchIntent("用 Grok 写个单元测试", roles)?.targets[0]).toMatchObject({ kind: "grok" });
    expect(extractAgentDispatchIntent("用 Grok Bot 查一下日程", roles)?.targets[0]).toMatchObject({ kind: "grok-bot" });
    expect(extractAgentDispatchIntent("让 Cursor Agent 重构这里", roles)?.targets[0]).toMatchObject({ kind: "cursor" });
    expect(extractAgentDispatchIntent("用 OpenCode 检查一下构建", roles)?.targets[0]).toMatchObject({ kind: "opencode" });
    expect(extractAgentDispatchIntent("让 Kiro CLI 跑一遍", roles)?.targets[0]).toMatchObject({ kind: "kiro" });

    // Everyday programming phrases must NEVER trigger false explicit dispatch
    for (const prompt of [
      "Use cursor pagination to fetch items",
      "用 cursor 遍历结果集",
      "把按钮改成 cursor pointer 样式",
      "请使用 cursor 分页实现列表查询",
    ]) {
      expect(extractAgentDispatchIntent(prompt, roles), prompt).toBeUndefined();
    }
  });

  it("blocks custom ACP command creation from non-UI callers while allowing multiple custom ACP clients via UI caller", async () => {
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "setup", models: [{ id: "chat" }] }).provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "setup", modelId: "chat" } } });
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    const state = { settings: { blocks: { roles: { revision: 1, value: {} } } } as KuloSettingsView };
    const env: EnvNodeDescriptor = {
      id: "local", name: "MacBook", kind: "local", online: true,
      platform: "darwin", arch: "arm64", rootDir: "/tmp/work",
      capabilities: ["fs", "bash", "external-agents"], connectedAt: 1, lastSeenAt: 1,
    };
    const detection = (kind: ExternalAgentKind, authenticated: boolean | null = true): ExternalAgentDetection => ({
      kind, installed: true, executable: "/usr/local/bin/kimi-code", version: "2.7.2", authenticated, models: [],
      capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" },
    });
    let nextAuth: boolean | null = true;
    const options: AgentConfigurationOptions = {
      harness,
      settings: () => state.settings,
      envs: () => [env],
      request: async (_envId, input) => ({
        type: "detection",
        detection: detection(input.operation === "detect" ? input.kind : input.operation === "probe" ? input.binding.kind : "acp", nextAuth),
      }),
      verifyRoundtrip: async () => ({ sessionId: "s-1", version: "2.7.2" }),
      saveRole: async (input) => {
        state.settings.blocks.roles.value[input.role.id] = structuredClone(input.role);
        state.settings.blocks.roles.revision += 1;
        return structuredClone(state.settings);
      },
      saveClient: async (input) => {
        state.settings.externalClients = {
          ...(state.settings.externalClients ?? {}),
          [input.client.id]: structuredClone(input.client),
        };
        state.settings.blocks.roles.revision += 1;
        return structuredClone(state.settings);
      },
    };
    const service = new KuloAgentConfiguration(options);

    // Non-UI (default) caller is rejected for custom ACP
    await expect(service.quickConnect({
      clientId: "win-1",
      kind: "acp",
      envId: "local",
      commandId: "cmd-denied",
      executable: "/usr/local/bin/kimi-code",
      agentRef: "kimi-code",
      acpArgs: ["acp"],
      runTest: true,
    })).rejects.toMatchObject({ status: 403, code: "custom_acp_ui_only" });

    // UI caller with allowCustomAcpCommand: true succeeds for two distinct custom ACP clients on same device
    const first = await service.quickConnect({
      clientId: "win-1",
      kind: "acp",
      envId: "local",
      commandId: "cmd-kimi",
      label: "Kimi Code",
      executable: "/usr/local/bin/kimi-code",
      agentRef: "kimi-code",
      acpArgs: ["acp"],
      runTest: true,
    }, undefined, { allowCustomAcpCommand: true });
    expect(first.clientId).toBe("acp:local:kimi-code");
    expect(first.enabled).toBe(true);
    expect(first.agentId).toBeUndefined();
    expect(state.settings.externalClients?.[first.clientId]?.acpArgs).toEqual(["acp"]);

    const second = await service.quickConnect({
      clientId: "win-1",
      kind: "acp",
      envId: "local",
      commandId: "cmd-qwen",
      label: "Qwen Code",
      executable: "/usr/local/bin/qwen",
      agentRef: "qwen-code",
      acpArgs: ["--acp"],
      runTest: true,
    }, undefined, { allowCustomAcpCommand: true });
    expect(second.clientId).toBe("acp:local:qwen-code");
    expect(second.clientId).not.toBe(first.clientId);

    // Draft probe with authenticated === false must NOT stamp verification.level = "protocol"
    nextAuth = false;
    const draft = await service.prepare({ clientId: "win-grok", kind: "grok", envId: "local" });
    const probed = await service.probe(draft.clientId, draft.revision);
    expect(probed.detection?.authenticated).toBe(false);
    expect(probed.verification).toBeUndefined();

    // Non-UI caller cannot mutate an existing custom ACP draft's executable/agentRef
    nextAuth = true;
    state.settings.blocks.roles.value["kimi-code"] = {
      id: "kimi-code",
      label: "Kimi Code",
      whenToUse: "Kimi 任务",
      prompt: "使用 Kimi 完成任务。",
      enabled: true,
      externalClientId: first.clientId,
      external: { kind: "acp", envId: "local", executable: "/usr/local/bin/kimi-code", agentRef: "kimi-code", acpArgs: ["acp"], verifiedAt: 100 },
    };
    const editDraft = await service.prepare({ clientId: "win-edit", kind: "acp", envId: "local", agentId: "kimi-code" });
    await expect(service.updateDraft({
      clientId: "win-edit",
      expectedRevision: editDraft.revision,
      patch: { executable: "/tmp/other" },
    })).rejects.toMatchObject({ status: 403, code: "custom_acp_ui_only" });
    // Metadata-only edit (label) on an existing custom ACP draft is still allowed
    const renamed = await service.updateDraft({
      clientId: "win-edit",
      expectedRevision: editDraft.revision,
      patch: { label: "Kimi 架构师" },
    });
    expect(renamed.label).toBe("Kimi 架构师");

    expect(isSupportedExternalAgentKind("grok")).toBe(true);
    expect(isSupportedExternalAgentKind("acp")).toBe(true);
    expect(isSupportedExternalAgentKind("grok-bot")).toBe(false);
  });

  it("parses official ACP Registry JSON safely while filtering built-in kinds and invalid entries", () => {
    const parsed = parseAcpRegistryPayload({
      agents: [
        { id: "grok-build", name: "Grok Build", version: "1.0.93", distribution: { npx: { package: "@xai-official/grok@1.0.93", args: ["agent", "stdio"] } } },
        { id: "kimi-code", name: "Kimi Code", version: "2.7.2", distribution: { npx: { package: "@moonshot-ai/kimi-code@2.7.2", args: ["acp"] } } },
        { id: "muse-code", name: "Muse Code", version: "1.4.24", distribution: { binary: { "darwin-aarch64": { cmd: "./muse", args: ["acp"] } } } },
        { id: "bad-shell", name: "Bad", version: "1.0.0", distribution: { binary: { "darwin-aarch64": { cmd: "/bin/bash", args: ["-c", "id"] } } } },
      ],
    });
    expect(parsed.map((item) => item.id)).toEqual(["kimi-code", "muse-code"]);
    expect(parsed[0]).toMatchObject({ id: "kimi-code", suggestedArgs: ["acp"], requiresLocalInstall: true });
    expect(parsed[1]).toMatchObject({ id: "muse-code", suggestedBinary: "muse", suggestedArgs: ["acp"], requiresLocalInstall: false });
  });
});
