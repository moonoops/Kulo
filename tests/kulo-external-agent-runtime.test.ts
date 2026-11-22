import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExternalAgentService, isExternalAgentRequest } from "../packages/env/src/external-agents.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";
import type { ExternalAgentPipeFactory, ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
import type { ExternalAgentRequest, ExternalAgentRun } from "@kulo/protocol";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-external-test-")); roots.push(root);
  const cwd = path.join(root, "work"); fs.mkdirSync(cwd);
  const registry = new ProjectDirectoryRegistry({ deviceId: "local", filePath: path.join(root, "private", "grants.json"), scratchRoot: path.join(root, "scratch") });
  return { root, cwd, registry };
}
interface WireMessage { method?: string; params?: Record<string, unknown>; id?: number | string; result?: unknown }
function mockPipe(behavior: { resume?: boolean; replay?: boolean; httpMcp?: boolean } = {}) {
  const sent: WireMessage[] = [];
  let current: ExternalAgentPipeOptions;
  let promptId: number | string | undefined;
  let finish: (code: number) => void = () => {};
  const emit = (value: unknown) => current.onStdout(Buffer.from(JSON.stringify(value) + "\n"));
  const factory: ExternalAgentPipeFactory = async options => {
    current = options;
    return {
      write: data => {
        const message = JSON.parse(data) as WireMessage; sent.push(message);
        if (!message.method) return;
        const reply = (result: unknown) => queueMicrotask(() => emit({ jsonrpc: "2.0", id: message.id, result }));
        if (message.method === "initialize") reply({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: behavior.resume !== false }, mcpCapabilities: { http: behavior.httpMcp !== false } } });
        else if (message.method === "config/read") reply({ config: { mcp_servers: { privateAccount: { command: "native-client-owned-server" } }, shell_environment_policy: { set: { CLIENT_SETTING: "native-value" } } } });
        else if (message.method === "model/list") reply({ data: [{ id: "test-model", displayName: "Test", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] });
        else if (message.method === "account/read") reply({ account: { type: "chatgpt" } });
        else if (["thread/start", "thread/resume"].includes(message.method)) reply({ thread: { id: "native-thread" } });
        else if (message.method === "turn/start") reply({ turn: { id: "native-turn" } });
        else if (["session/new", "session/resume", "session/load"].includes(message.method)) {
          if (behavior.replay && message.method !== "session/new") {
            emit({ method: "session/update", params: { sessionId: "native-acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD SESSION HISTORY" } } } });
            emit({ id: "load-permission", method: "session/request_permission", params: { sessionId: "native-acp", toolCall: { toolCallId: "old-call", title: "Old command" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } });
          }
          reply({ sessionId: "native-acp", configOptions: [
            { id: "model", category: "model", options: [{ value: '["deepseek","deepseek-chat"]', name: "DeepSeek" }] },
            { id: "reasoning_effort", category: "thought_level", options: [{ value: "high", name: "High" }] },
          ] });
        } else if (message.method === "session/set_config_option") reply({});
        else if (message.method === "session/prompt") promptId = message.id;
        else if (message.method === "session/cancel" && promptId !== undefined) emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        else if (message.id !== undefined) reply({});
      },
      close: () => finish(0), exited: new Promise(resolve => { finish = resolve; }),
    };
  };
  return {
    factory, sent, emit, get options() { return current!; },
    complete: () => emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "native-turn", status: "completed" } } }),
    crash: () => finish(1),
  };
}
function runRequest(cwd: string, patch: Partial<Extract<ExternalAgentRequest, { operation: "run" }>> = {}): Extract<ExternalAgentRequest, { operation: "run" }> {
  return { operation: "run", binding: { kind: "codex", envId: "local", executable: process.execPath }, taskId: "T-1", runEpoch: 1, requestId: "kulo:external:T-1:1", prompt: "Check source", cwd, readOnly: true, allowSubagents: false, timeoutMs: 10_000, ...patch };
}
async function run(service: ExternalAgentService, id = "kulo:external:T-1:1"): Promise<ExternalAgentRun> {
  const response = await service.request({ operation: "inspect", runId: id }); if (response.type !== "run") throw new Error("Expected run"); return response.run;
}
async function spin(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error("Condition did not become true");
}

describe("external agent runtime", () => {
  it.each(["codex", "claude-code", "antigravity", "dsh"] as const)("persists a missing %s executable as a failed receipt and never replays it when the executable returns", async kind => {
    const { root, cwd, registry } = setup();
    const executable = path.join(root, "removed-native-client");
    const factory = vi.fn<ExternalAgentPipeFactory>();
    let service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: factory });
    const request = runRequest(cwd, { binding: { kind, envId: "local", executable } });
    try {
      const response = await service.request(request);
      expect(response).toMatchObject({ type: "run", run: { id: request.requestId, taskId: request.taskId, kind, state: "failed", quiescent: true } });
      if (response.type !== "run") throw new Error("Expected a failed native receipt");
      expect(response.run.error).toContain("executable was not found");
      expect(response.run.error).toContain("No task was submitted");
      expect(response.run.sessionId).toBeUndefined();
      expect((await run(service)).error).toBe(response.run.error);
      expect(factory).not.toHaveBeenCalled();

      await service.close();
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: factory });
      expect(await run(service)).toEqual(response.run);
      expect(await service.request(request)).toEqual(response);
      await expect(service.request({ ...request, prompt: "A different task" })).rejects.toThrow("reused with a different task");
      expect(factory).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it.skipIf(process.platform === "win32")("reports an existing but non-executable native client without starting it", async () => {
    const { root, cwd, registry } = setup();
    const executable = path.join(root, "non-executable-native-client");
    fs.writeFileSync(executable, "not executable", { mode: 0o600 });
    const factory = vi.fn<ExternalAgentPipeFactory>();
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: factory });
    try {
      const result = await service.request(runRequest(cwd, { binding: { kind: "antigravity", envId: "local", executable } }));
      expect(result).toMatchObject({ type: "run", run: { state: "failed", quiescent: true, error: expect.stringContaining("is not executable") } });
      expect(factory).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it("keeps native client settings intact while persisting, deduplicating and resuming owned work", async () => {
    const { root, cwd, registry } = setup(), pipe = mockPipe();
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory, toolHandler: async () => ({}) });
    const request = runRequest(cwd);
    try {
      await service.request(request); await spin(() => pipe.sent.some(item => item.method === "turn/start")); await service.request(request);
      expect(pipe.sent.filter(item => item.method === "turn/start")).toHaveLength(1);
      await expect(service.request({ ...request, prompt: "Changed task" })).rejects.toThrow("reused with a different task");
      const thread = pipe.sent.find(item => item.method === "thread/start")!.params!;
      expect(thread.permissions).toBeUndefined(); expect(thread.sandbox).toBeUndefined(); expect(thread.approvalPolicy).toBeUndefined(); expect(thread.config).toBeUndefined();
      expect(pipe.sent.some(item => item.method === "permissionProfile/list" || item.method === "config/read")).toBe(false);
      expect(pipe.options.args).toEqual(["app-server"]); expect(pipe.options.isolated).toBe(false);
      const input = pipe.sent.find(item => item.method === "turn/start")!.params!.input as Array<{ text: string }>;
      expect(input[0]!.text).toContain("Check source"); expect(input[0]!.text).toContain("never modify files"); expect(input[0]!.text).not.toContain("kulo_task_exec");
      pipe.complete(); await spin(async () => (await run(service)).quiescent === true);
      await service.request(runRequest(cwd, { runEpoch: 2, requestId: "kulo:external:T-1:2", sessionId: "native-thread" }));
      await spin(() => pipe.sent.some(item => item.method === "thread/resume"));
    } finally { await service.close(); }
  });

  it("recovers lost native terminal evidence as uncertain without resending", async () => {
    const { root, cwd, registry } = setup(), pipe = mockPipe();
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    const request = runRequest(cwd); await service.request(request); await spin(() => pipe.sent.some(item => item.method === "turn/start"));
    const restarted = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: () => { throw new Error("Must not replay"); } });
    try { expect((await run(restarted)).state).toBe("uncertain"); expect((await restarted.request(request)).type).toBe("run"); }
    finally { await service.close(); await restarted.close(); }
  });

  it("bounds and redacts native output and known credential values before receipt persistence", async () => {
    const { root, cwd, registry } = setup(), pipe = mockPipe();
    vi.stubEnv("KULO_AUTH_TOKEN", "synthetic-private-management-value");
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    try {
      await service.request(runRequest(cwd)); await spin(() => pipe.sent.some(item => item.method === "turn/start"));
      pipe.emit({ method: "item/agentMessage/delta", params: { threadId: "native-thread", delta: "api_key=sk-live-secret-1234567890\nraw synthetic-private-management-value" } });
      const receipts = fs.readdirSync(service.rootDir).filter(name => name.endsWith(".json")).map(name => fs.readFileSync(path.join(service.rootDir, name), "utf8")).join("");
      for (const text of [(await run(service)).text, receipts]) { expect(text).not.toContain("sk-live-secret"); expect(text).not.toContain("synthetic-private-management-value"); }
    } finally { await service.close(); }
  });

  it("relays the client's native approval choices exactly and expires unanswered request IDs on close", async () => {
    const { root, cwd, registry } = setup(), pipe = mockPipe();
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    try {
      await service.request(runRequest(cwd, { readOnly: false })); await spin(() => pipe.sent.some(item => item.method === "turn/start"));
      const nativeDecision = { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["node", "build.mjs"] } };
      pipe.emit({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "native-thread", reason: "Client-requested approval", availableDecisions: ["decline", nativeDecision] } });
      await spin(async () => (await run(service)).permissions.length === 1);
      const permission = (await run(service)).permissions[0]!;
      await expect(service.request({ operation: "respond", runId: "kulo:external:T-1:1", permissionId: permission.id, choiceId: "not-offered" })).rejects.toThrow("no longer active");
      await service.request({ operation: "respond", runId: "kulo:external:T-1:1", permissionId: permission.id, choiceId: permission.choices[1]!.id });
      await spin(() => pipe.sent.some(item => item.id === 77 && !!item.result));
      expect(pipe.sent.find(item => item.id === 77)?.result).toEqual({ decision: nativeDecision });
      pipe.emit({ id: 78, method: "item/fileChange/requestApproval", params: { threadId: "native-thread", availableDecisions: ["accept", "decline"] } });
      await spin(async () => (await run(service)).permissions.length === 1);
      const expired = (await run(service)).permissions[0]!;
      await service.request({ operation: "close", runId: "kulo:external:T-1:1" });
      await expect(service.request({ operation: "respond", runId: "kulo:external:T-1:1", permissionId: expired.id, choiceId: expired.choices[0]!.id })).rejects.toThrow("no longer active");
    } finally { await service.close(); }
  });

  it("keeps native DSH model IDs and persistent permission options without injecting provider credentials or a fake HOME", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const { root, cwd, registry } = setup(), pipe = mockPipe();
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    try {
      await service.request(runRequest(cwd, { binding: { kind: "dsh", envId: "local", executable: process.execPath }, modelId: '["deepseek","deepseek-chat"]' }));
      await spin(() => pipe.sent.some(item => item.method === "session/prompt"));
      expect(pipe.options.args).toEqual(["--profile", "acp"]); expect(pipe.options.isolated).toBe(false); expect(pipe.options.env).toEqual({});
      expect(fs.existsSync(path.join(registry.scratchRoot, "external-agent-sessions"))).toBe(false);
      expect(pipe.sent.find(item => item.method === "session/set_config_option")?.params?.value).toBe('["deepseek","deepseek-chat"]');
      pipe.emit({ id: 81, method: "session/request_permission", params: { sessionId: "native-acp", toolCall: { toolCallId: "call-1", title: "Native operation" }, options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always allow" }] } });
      await spin(async () => (await run(service)).permissions.length === 1); const permission = (await run(service)).permissions[0]!;
      expect(permission.choices.map(item => item.id)).toContain("always");
      await service.request({ operation: "respond", runId: "kulo:external:T-1:1", permissionId: permission.id, choiceId: "always" });
      await spin(() => pipe.sent.some(item => item.id === 81 && !!item.result));
      expect(pipe.sent.find(item => item.id === 81)?.result).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
      await service.request({ operation: "cancel", runId: "kulo:external:T-1:1" }); expect((await run(service)).state).toBe("cancelled");
    } finally { await service.close(); }
  });

  it.each([true, false])("uses the advertised ACP resume method (resume=%s) without mixing replayed history into the new result", async resume => {
    const { root, cwd, registry } = setup(), pipe = mockPipe({ resume, replay: true });
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    const binding = { kind: "dsh" as const, envId: "local", executable: process.execPath };
    try {
      await service.request(runRequest(cwd, { binding })); await spin(() => pipe.sent.some(item => item.method === "session/prompt"));
      pipe.emit({ id: pipe.sent.find(item => item.method === "session/prompt")!.id, result: { stopReason: "end_turn" } }); await spin(async () => (await run(service)).quiescent === true);
      await service.request(runRequest(cwd, { binding, runEpoch: 2, requestId: "kulo:external:T-1:2", sessionId: "native-acp" })); await spin(() => pipe.sent.filter(item => item.method === "session/prompt").length === 2);
      expect(pipe.sent.some(item => item.method === (resume ? "session/resume" : "session/load"))).toBe(true); expect((await run(service, "kulo:external:T-1:2")).text).toBe("");
      expect((await run(service, "kulo:external:T-1:2")).permissions).toEqual([]); expect(pipe.sent.find(item => item.id === "load-permission")?.result).toEqual({ outcome: { outcome: "cancelled" } });
      pipe.emit({ method: "session/update", params: { sessionId: "native-acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CURRENT TURN" } } } }); expect((await run(service, "kulo:external:T-1:2")).text).toBe("CURRENT TURN");
    } finally { await service.close(); }
  });

  it("validates handed-off resource directories, grants and native session ownership, without treating a read-only instruction as a concurrency guarantee", async () => {
    const { root, cwd, registry } = setup(), pipe = mockPipe(); const project = path.join(root, "project"); fs.mkdirSync(project);
    const grant = registry.authorize({ projectId: "P-1", path: project, operationId: "grant-1" });
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    try {
      await expect(service.request(runRequest(project, { projectId: "P-1", directoryId: grant.directoryId, grantRevision: 99 }))).rejects.toThrow();
      await expect(service.request(runRequest(cwd, { sessionId: "unowned" }))).rejects.toThrow("does not belong");
      await expect(service.request(runRequest(registry.privateDirectory))).rejects.toThrow("protected");
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-external-other-resource-")); roots.push(outside);
      fs.symlinkSync(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
      await expect(service.request(runRequest(path.join(cwd, "escape")))).rejects.toThrow("requires a current project");
      await service.request(runRequest(project, { projectId: "P-1", directoryId: grant.directoryId, grantRevision: grant.revision }));
      await expect(service.request(runRequest(project, { taskId: "T-2", requestId: "other", projectId: "P-1", grantRevision: grant.revision }))).rejects.toThrow("cleanup is pending");
    } finally { await service.close(); }
  });

  it("adds only an optional Hub collaboration bridge when enabled and never an execution proxy", async () => {
    const { root, cwd, registry } = setup(), pipe = mockPipe(); const calls: unknown[] = [];
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory, toolHandler: async invocation => { calls.push(invocation); return { reported: true }; } });
    try {
      await service.request(runRequest(cwd, { allowSubagents: true })); await spin(() => pipe.sent.some(item => item.method === "turn/start"));
      const config = pipe.sent.find(item => item.method === "thread/start")!.params!.config as Record<string, { url?: string; http_headers?: Record<string, string>; enabled?: boolean }>;
      expect(config).toBeDefined(); expect(config.mcp_servers).toBeUndefined();
      const server = config["mcp_servers.kulo-task"] as { url: string; http_headers: Record<string, string>; enabled?: boolean };
      expect(server?.url).toBeTruthy(); expect(server.enabled).not.toBe(false);
      const call = async (method: string, params?: unknown) => (await fetch(server.url, { method: "POST", headers: { ...server.http_headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      const listing = await call("tools/list"); expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toContain("kulo_request_collaboration"); expect(listing.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("kulo_task_exec");
      const removed = await call("tools/call", { name: "kulo_task_exec", arguments: { command: "pwd" } }); expect(removed.error.code).toBe(-32602); expect(calls).toHaveLength(0);
      await call("tools/call", { name: "kulo_task_report", arguments: { state: "progress", summary: "Native progress" } }); expect(calls).toMatchObject([{ taskId: "T-1", envId: "local", name: "kulo_task_report" }]);
    } finally { await service.close(); }
  });

  it.each(["codex", "dsh"] as const)("passes the selected native model and thinking depth to %s", async kind => {
    const { root, cwd, registry } = setup(), pipe = mockPipe(); const modelId = kind === "codex" ? "test-model" : '["deepseek","deepseek-chat"]';
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    try {
      await service.request(runRequest(cwd, { binding: { kind, envId: "local", executable: process.execPath }, modelId, thinkingLevel: "high" }));
      await spin(() => pipe.sent.some(item => item.method === (kind === "codex" ? "turn/start" : "session/prompt")));
      if (kind === "codex") expect(pipe.sent.find(item => item.method === "turn/start")?.params).toMatchObject({ model: modelId, effort: "high" });
      else expect(pipe.sent.filter(item => item.method === "session/set_config_option").map(item => item.params)).toEqual(expect.arrayContaining([{ sessionId: "native-acp", configId: "model", value: modelId }, { sessionId: "native-acp", configId: "reasoning_effort", value: "high" }]));
    } finally { await service.close(); }
  });

  it("does not require an optional HTTP collaboration bridge or a provider key to start native ACP", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", ""); const { root, cwd, registry } = setup(), pipe = mockPipe({ httpMcp: false });
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory, toolHandler: async () => ({}) });
    try { await service.request(runRequest(cwd, { binding: { kind: "dsh", envId: "local", executable: process.execPath }, allowSubagents: true })); await spin(() => pipe.sent.some(item => item.method === "session/prompt")); expect(pipe.sent.find(item => item.method === "session/new")?.params?.mcpServers).toEqual([]); expect((await run(service)).error).toBeUndefined(); }
    finally { await service.close(); }
  });

  it.each(["codex", "dsh", "antigravity"] as const)("probes %s without private permission profiles, provider proxies or forced account settings", async kind => {
    vi.stubEnv("DEEPSEEK_API_KEY", ""); vi.stubEnv("GEMINI_API_KEY", ""); const { root, registry } = setup(), pipe = mockPipe();
    const service = new ExternalAgentService({ envId: "local", rootDir: root, projectRegistry: registry, pipeFactory: pipe.factory });
    try {
      const response = await service.request({ operation: "probe", binding: { kind, envId: "local", executable: process.execPath } });
      expect(response).toMatchObject({ type: "detection", detection: { installed: true } }); if (response.type === "detection") expect(response.detection.error).toBeUndefined();
      expect(pipe.options.env).toEqual({}); expect(pipe.options.isolated).toBe(false); expect(pipe.sent.some(item => item.method === "permissionProfile/list" || item.method === "turn/start" || item.method === "session/prompt")).toBe(false);
      expect(fs.existsSync(path.join(registry.scratchRoot, "external-agent-sessions"))).toBe(false);
    } finally { await service.close(); }
  });

  it("rejects malformed management requests without accepting commands, environment overrides or injected MCP endpoints", () => {
    expect(isExternalAgentRequest({ ...runRequest("/tmp"), mcpServers: [{ name: "unsafe", url: "http://evil.example" }] })).toBe(false);
    expect(isExternalAgentRequest({ ...runRequest("/tmp"), cwd: "relative" })).toBe(false);
    expect(isExternalAgentRequest({ ...runRequest("/tmp"), env: { TOKEN: "inline" } })).toBe(false);
    expect(isExternalAgentRequest({ ...runRequest("/tmp"), thinkingLevel: 1 })).toBe(false);
    expect(isExternalAgentRequest({ ...runRequest("/tmp"), thinkingLevel: "high" })).toBe(true);
  });
});
