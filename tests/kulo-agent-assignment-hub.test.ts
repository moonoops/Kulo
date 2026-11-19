import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { EnvManager, type ExternalAgentToolHandler } from "@kulo/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentDispatchPolicy, AgentTaskKind, EnvNodeDescriptor, ExternalAgentKind, ExternalAgentRequest, ExternalAgentResponse, ExternalAgentRun, RolePreset, TicketRecord } from "@kulo/protocol";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const context = BACKGROUND_CONTEXT;
type NativeRun = Extract<ExternalAgentRequest, { operation: "run" }>;
interface Action { name: "kulo_dispatch" | "kulo_steer"; args: Record<string, unknown> }
interface Plan { needle: string; steps: Array<Action | (() => Action)>; used?: number }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(file => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_AUTH_TOKEN", "KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY", "KULO_ENV_TOKENS"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function external(id: string, kind: ExternalAgentKind, extra: Partial<RolePreset> = {}): RolePreset {
  return {
    id, label: kind === "codex" ? "Codex" : kind === "claude-code" ? "Claude Code" : kind,
    whenToUse: "Use this configured native client", prompt: "Return task evidence to Kulo.",
    enabled: true, readOnly: true, allowSubagents: false,
    provider: "native-only", modelId: `${kind}-native-model`,
    external: { kind, envId: "computer-a", verifiedAt: 1_700_000_000_000 },
    ...extra,
  };
}
function dispatch(commandId: string, taskKind: AgentTaskKind = "coding", extra: Record<string, unknown> = {}): Action {
  return { name: "kulo_dispatch", args: {
    command_id: commandId, title: "核实并完成任务", goal: "Complete the requested work and return evidence.",
    scope: "The authorized task workspace", role: "coder", task_kind: taskKind, ...extra,
  } };
}
function tools(transcript: TranscriptContext): string[] {
  return [...new Set([
    ...(transcript.tools?.map(tool => tool.name) ?? []),
    ...transcript.messages.flatMap(message => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
      ? message.toolsAdded.map(tool => tool.name) : []),
  ])];
}
function userTexts(transcript: TranscriptContext): string {
  return transcript.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}

async function fixture(options: {
  roles?: Record<string, RolePreset>;
  plans: Plan[];
  relayAction?: Action;
  maxConcurrentWorkers?: number;
  workerEnvIds?: string[];
  holdNative?: Set<ExternalAgentKind>;
  beforeAction?: (action: Action) => Promise<void>;
}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-agent-assignment-hub-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "assignment-hub-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  const routerContexts: TranscriptContext[] = [];
  let relayUsed = false;
  provider.setResponses(Array.from({ length: 150 }, () => async (transcript: TranscriptContext) => {
    const names = tools(transcript);
    if (names.includes("kulo_dispatch")) {
      routerContexts.push({ ...transcript, messages: [...transcript.messages] });
      const text = userTexts(transcript);
      const latest = transcript.messages.filter(message => message.role === "user").at(-1);
      const latestText = latest ? JSON.stringify(latest.content) : "";
      let action: Action | undefined;
      if (latestText.includes("[KULO_WORKER_RELAY]") || latestText.includes("[KULO_WORKER_RECOVERY]")) {
        if (!relayUsed && options.relayAction) { relayUsed = true; action = options.relayAction; }
      } else {
        const plan = [...options.plans].reverse().find(candidate => text.includes(candidate.needle));
        const step = plan?.steps[plan.used ?? 0];
        if (plan && step) { plan.used = (plan.used ?? 0) + 1; action = typeof step === "function" ? step() : step; }
      }
      if (action) await options.beforeAction?.(action);
      return action ? fauxAssistantMessage([fauxToolCall(action.name, action.args)], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText("已处理当前请求。")]);
    }
    if (names.includes("kulo_report") && !transcript.messages.some(message => message.role === "toolResult" && message.toolName === "kulo_report")) {
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "Builtin worker returned synthetic evidence", deliverable: "Synthetic builtin result" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage([fauxText("完成")]);
  }));
  let taskHandler: ExternalAgentToolHandler | undefined;
  const installTaskHandler = EnvManager.prototype.setExternalAgentToolHandler;
  vi.spyOn(EnvManager.prototype, "setExternalAgentToolHandler").mockImplementation(function (this: EnvManager, handler) {
    if (handler) taskHandler = handler;
    installTaskHandler.call(this, handler);
  });
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"),
    localEnvRoot: path.join(directory, "workspace"), enableLocalEnv: false, envTokens: {}, workerEnvIds: options.workerEnvIds ?? ["computer-a"],
    maxConcurrentWorkers: options.maxConcurrentWorkers ?? 3, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "assignment-hub-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1", apiKey: "" },
    roles: {
      coder: { id: "coder", label: "内置开发者", whenToUse: "General coding", prompt: "Report synthetic evidence", enabled: true, readOnly: true, allowSubagents: false, provider: "openai", modelId: "assignment-hub-model" },
      ...(options.roles ?? { codex: external("codex", "codex"), "claude-code": external("claude-code", "claude-code") }),
    },
  } });
  cleanups.push(() => hub.close());
  const devices = ["computer-a", "computer-b"].map((id): EnvNodeDescriptor => ({
    id, name: id, kind: "reverse-ws", executionKind: "pi-env", online: true, platform: "linux", arch: "x64", rootDir: path.join(directory, id),
    capabilities: ["worker-isolation", "external-agents"], connectedAt: 1, lastSeenAt: 1,
  }));
  vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation(id => devices.find(device => device.id === id));
  vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => structuredClone(devices));
  vi.spyOn(hub.envManager, "pickDefaultWorkerEnvId").mockReturnValue("computer-a");
  vi.spyOn(hub.envManager, "pickDefaultEnvId").mockReturnValue("computer-a");
  vi.spyOn(hub.envManager, "createExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
  const execution = vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
  vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockResolvedValue({ cleanupPending: false });
  vi.spyOn(hub.envManager, "authorizeProjectDirectory").mockImplementation(async (_id, input) => ({
    projectId: input.projectId, workspaceDir: input.path, directoryId: `directory:${input.path}`, revision: input.revision ?? 1,
    scratchRoot: path.join(directory, "scratch"), platform: "linux",
  }));
  const runs = new Map<string, ExternalAgentRun>();
  const native = vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (_id, request): Promise<ExternalAgentResponse> => {
    if (request.operation === "run") {
      const run: ExternalAgentRun = { id: request.requestId, taskId: request.taskId, runEpoch: request.runEpoch, kind: request.binding.kind,
        sessionId: request.sessionId ?? `session:${request.taskId}`, state: "running", text: "", events: [], permissions: [], nextSequence: 1, quiescent: false };
      runs.set(run.id, run); return { type: "run", run };
    }
    if (request.operation === "probe" || request.operation === "detect") throw new Error("Verified assignments should not rediscover native clients");
    const run = runs.get(request.runId); if (!run) throw new Error("Unknown synthetic native run");
    return { type: "run", run: { ...run, state: request.operation === "inspect" ? options.holdNative?.has(run.kind) ? "running" : "completed" : "cancelled", text: "Native client returned synthetic evidence", quiescent: request.operation !== "inspect" || !options.holdNative?.has(run.kind) } };
  });
  const tickets = async () => Object.values((await hub.harness.snapshot(KuloStateDoc, context))?.tickets ?? {}).sort((a, b) => a.id.localeCompare(b.id));
  const ready = async (count: number) => {
    await vi.waitFor(async () => { const all = await tickets(); expect(all).toHaveLength(count); expect(all.every(ticket => ticket.status === "ready" && !ticket.cleanupPending)).toBe(true); }, { timeout: 12_000, interval: 20 });
    return tickets();
  };
  const idle = async (topicId = "root") => { await vi.waitFor(async () => expect((await hub.getTopicView(topicId)).live.busy).toBe(false), { timeout: 8_000, interval: 20 }); };
  const runCalls = () => native.mock.calls.filter((call): call is [string, NativeRun] => call[1].operation === "run");
  const taskTool = (run: NativeRun, name: string, args: Record<string, unknown>) => {
    if (!taskHandler) throw new Error("Hub did not install the authenticated external task tool handler");
    return taskHandler({ envId: run.binding.envId, runId: run.requestId, taskId: run.taskId, runEpoch: run.runEpoch, cwd: run.cwd, allowSubagents: run.allowSubagents, name, args });
  };
  return { hub, directory, devices, native, execution, routerContexts, tickets, ready, idle, runCalls, taskTool, plans: options.plans };
}
function toolResults(contexts: TranscriptContext[], name = "kulo_dispatch") {
  return contexts.at(-1)?.messages.filter(message => message.role === "toolResult" && message.toolName === name) ?? [];
}

async function configureAgent(f: Awaited<ReturnType<typeof fixture>>, agentId: string, patch: { dispatchPolicy?: AgentDispatchPolicy; prompt?: string; modelId?: string }) {
  const role = f.hub.getSettingsView().blocks.roles.value[agentId]!;
  const clientId = `policy-client-${agentId}`;
  let draft = await f.hub.agentConfiguration.prepare({ clientId, agentId, kind: role.external!.kind, envId: role.external!.envId });
  draft = await f.hub.agentConfiguration.updateDraft({ clientId, expectedRevision: draft.revision, patch });
  const native = f.native.getMockImplementation()!;
  f.native.mockImplementation(async (envId, request) => request.operation === "probe" ? { type: "detection", detection: {
    kind: request.binding.kind, installed: true, authenticated: null, models: [{ id: role.modelId!, name: role.modelId! }],
    capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" },
  } } : native(envId, request));
  try {
    draft = await f.hub.agentConfiguration.probe(clientId, draft.revision);
    return await f.hub.agentConfiguration.save({ clientId, expectedRevision: draft.revision, commandId: `save-policy-${agentId}` });
  } finally { f.native.mockImplementation(native); }
}

const configurePolicy = (f: Awaited<ReturnType<typeof fixture>>, agentId: string, dispatchPolicy: AgentDispatchPolicy) => configureAgent(f, agentId, { dispatchPolicy });

async function expectRejected(f: Awaited<ReturnType<typeof fixture>>, attempts: number, reason: RegExp) {
  await vi.waitFor(() => { const results = toolResults(f.routerContexts); expect(results).toHaveLength(attempts); expect(results.every(result => "isError" in result && result.isError)).toBe(true); }, { timeout: 8_000, interval: 20 });
  expect(JSON.stringify(toolResults(f.routerContexts))).toMatch(reason);
  expect(await f.tickets()).toEqual([]);
  expect(f.native).not.toHaveBeenCalled();
  expect(f.execution).not.toHaveBeenCalled();
}

describe("user-bound and policy-based Agent assignment through real Hub tools", () => {
  it("binds a named Codex request even when the model asks for coder and rewrites the goal", async () => {
    const f = await fixture({ roles: { codex: external("codex", "codex"), "claude-code": external("claude-code", "claude-code", { dispatchPolicy: { defaultFor: ["coding"] } }) }, plans: [{ needle: "named-source", steps: [dispatch("named-codex", "coding", { goal: "Use the builtin general coder; no client selection is needed." })] }] });
    await f.hub.sendUserMessage("[named-source] 让 Codex 修改这个模块并给出验证结果。", { requestId: "named-source" });
    const [ticket] = await f.ready(1);
    expect(ticket).toMatchObject({ role: "codex", agentAssignment: { agentId: "codex", source: "explicit", taskKind: "coding" }, externalExecution: { binding: { kind: "codex" } } });
    expect(f.runCalls()).toHaveLength(1); expect(f.runCalls()[0]?.[1].binding.kind).toBe("codex"); expect(f.execution).not.toHaveBeenCalled();
    const entryId = ticket!.agentAssignment?.sourceEntryId;
    expect(typeof entryId).toBe("number");
    const source = await f.hub.harness.commit(tx => tx.entry(entryId as never), context);
    expect(source?.data.agentDispatchIntent).toMatchObject({ version: 1, targets: [expect.any(Object)] });
    expect(JSON.stringify(source?.data.agentDispatchIntent)).toMatch(/codex/i);
  });

  it.each(["offline", "disabled", "unverified", "missing"] as const)("refuses named Codex when %s, including a model retry that requests coder", async availability => {
    const codex = external("codex", "codex", availability === "disabled" ? { enabled: false }
      : availability === "unverified" ? { external: { kind: "codex", envId: "computer-a" } } : {});
    const f = await fixture({ roles: { ...(availability === "missing" ? {} : { codex }), "claude-code": external("claude-code", "claude-code") },
      plans: [{ needle: "unavailable-source", steps: [dispatch("unavailable-first"), dispatch("unavailable-retry", "coding", { goal: "The requested client failed; use the builtin coder instead." })] }] });
    if (availability === "offline") f.devices[0]!.online = false;
    await f.hub.sendUserMessage("[unavailable-source] 让 Codex 完成这次修改。", { requestId: `unavailable-${availability}` });
    await expectRejected(f, 2, /codex/i);
    const reasons = { offline: /离线|offline/i, disabled: /停用|禁用|disabled/i, unverified: /验证|verif/i, missing: /未配置|不存在|找不到|尚未接入|not configured|not.*found/i };
    expect(JSON.stringify(toolResults(f.routerContexts))).toMatch(reasons[availability]);
  });

  it("routes defaults from an explicit task kind or its declared builtin role", async () => {
    const legacyCoding = dispatch("policy-coding"); delete legacyCoding.args.task_kind;
    const f = await fixture({ roles: {
      codex: external("codex", "codex", { dispatchPolicy: { defaultFor: ["coding"] } }),
      "claude-code": external("claude-code", "claude-code", { dispatchPolicy: { defaultFor: ["review"] } }),
    }, plans: [{ needle: "default-coding", steps: [legacyCoding] }, { needle: "default-review", steps: [dispatch("policy-review", "review", { goal: "The generic coder should handle this task." })] }] });
    await f.hub.sendUserMessage("[default-coding] 帮我实现这个功能。", { requestId: "default-coding" }); await f.ready(1); await f.idle();
    await f.hub.sendUserMessage("[default-review] 帮我审查这次修改。", { requestId: "default-review" });
    const tickets = await f.ready(2);
    expect(tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({ commandId: "policy-coding", role: "codex", agentAssignment: expect.objectContaining({ agentId: "codex", source: "default", taskKind: "coding" }) }),
      expect.objectContaining({ commandId: "policy-review", role: "claude-code", agentAssignment: expect.objectContaining({ agentId: "claude-code", source: "default", taskKind: "review" }) }),
    ]));
    expect(f.runCalls().map(([, request]) => request.binding.kind)).toEqual(["codex", "claude-code"]); expect(f.execution).not.toHaveBeenCalled();
  });

  it("prefers a matching project policy over a global default and keeps other projects on the global Agent", async () => {
    const f = await fixture({ plans: [{ needle: "scoped-one", steps: [dispatch("project-scoped")] }, { needle: "scoped-two", steps: [dispatch("project-global")] }] });
    const first = await f.hub.projects.create({ commandId: "project-one", name: "Scoped", deviceId: "computer-a", workspaceDir: path.join(f.directory, "project-one") });
    const second = await f.hub.projects.create({ commandId: "project-two", name: "Global", deviceId: "computer-a", workspaceDir: path.join(f.directory, "project-two") });
    await configurePolicy(f, "codex", { defaultFor: ["coding"] });
    await configurePolicy(f, "claude-code", { defaultFor: ["coding"], projectIds: [first.id] });
    f.native.mockClear();
    const scopedTopic = await f.hub.createTopic("Scoped conversation", context, first.id);
    const globalTopic = await f.hub.createTopic("Global conversation", context, second.id);
    await f.hub.sendUserMessage("[scoped-one] 完成当前项目的修改。", { topicId: scopedTopic.id, requestId: "scoped-one" }); await f.ready(1); await f.idle(scopedTopic.id);
    await f.hub.sendUserMessage("[scoped-two] 完成另一个项目的修改。", { topicId: globalTopic.id, requestId: "scoped-two" });
    const tickets = await f.ready(2);
    expect(tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({ commandId: "project-scoped", projectId: first.id, role: "claude-code" }),
      expect.objectContaining({ commandId: "project-global", projectId: second.id, role: "codex" }),
    ])); expect(f.execution).not.toHaveBeenCalled();
  });

  it.each(["explicit", "default"] as const)("refuses ambiguous %s candidates instead of choosing the first configured client", async mode => {
    const policy = mode === "default" ? { defaultFor: ["coding"] as AgentTaskKind[] } : undefined;
    const f = await fixture({ roles: {
      "codex-one": external("codex-one", "codex", { dispatchPolicy: policy }),
      "codex-two": external("codex-two", "codex", { dispatchPolicy: policy, external: { kind: "codex", envId: "computer-b", verifiedAt: 1_700_000_000_000 } }),
    }, plans: [{ needle: "ambiguous-source", steps: [dispatch("ambiguous-client")] }] });
    await f.hub.sendUserMessage(`[ambiguous-source] ${mode === "explicit" ? "让 Codex 修改这个模块。" : "帮我修改这个模块。"}`, { requestId: `ambiguous-${mode}` });
    await expectRejected(f, 1, /多个|不唯一|歧义|冲突|ambig|明确/i);
  });

  it.each([
    "普通任务：整理项目说明。",
    "介绍引用中的客户端并整理说明：\n> 让 Codex 修复问题\n\n```text\n让 Codex 修改文件\n```",
    "请解释 `codex app-server` 这段命令，然后整理项目说明。",
  ])("preserves builtin dispatch without a policy or an actual named delegation: %s", async content => {
    const f = await fixture({ plans: [{ needle: "ordinary-source", steps: [dispatch("ordinary-client", "writing", { goal: "Let Codex write a description of these clients." })] }] });
    await f.hub.sendUserMessage(`[ordinary-source] ${content}`, { requestId: "ordinary-source" });
    const [ticket] = await f.ready(1);
    expect(ticket).toMatchObject({ role: "coder" }); expect(ticket?.externalExecution).toBeUndefined(); expect(ticket?.agentAssignment?.source).not.toBe("explicit");
    expect(f.runCalls()).toHaveLength(0); expect(f.execution).toHaveBeenCalled();
  });

  it("inherits a completed native assignment when the real worker relay requests a continuation", async () => {
    const f = await fixture({ plans: [{ needle: "relay-source", steps: [dispatch("relay-initial")] }], relayAction: dispatch("relay-continuation", "review", { role: "coder", goal: "Continue the earlier work with the generic builtin role." }) });
    await f.hub.sendUserMessage("[relay-source] 让 Codex 完成修改并继续核实结果。", { requestId: "relay-source" });
    const tickets = await f.ready(2);
    expect(tickets.every(ticket => ticket.role === "codex" && ticket.agentAssignment?.agentId === "codex")).toBe(true);
    expect(f.runCalls()).toHaveLength(2); expect(f.runCalls().every(([, request]) => request.binding.kind === "codex")).toBe(true); expect(f.execution).not.toHaveBeenCalled();
  });

  it("resumes a ticket on its bound Agent and refuses an explicit steer to another client", async () => {
    let ticketId = "";
    const f = await fixture({ plans: [
      { needle: "bound-first", steps: [dispatch("bound-first")] },
      { needle: "bound-resume", steps: [() => ({ name: "kulo_steer", args: { command_id: "steer-bound-resume", ticket_id: ticketId, text: "继续原任务并核实结果。" } })] },
      { needle: "bound-conflict", steps: [() => ({ name: "kulo_steer", args: { command_id: "steer-bound-conflict", ticket_id: ticketId, text: "继续完成修改。" } })] },
    ] });
    await f.hub.sendUserMessage("[bound-first] 让 Codex 完成修改。", { requestId: "bound-first" }); const [initial] = await f.ready(1); ticketId = initial!.id; await f.idle();
    await f.hub.sendUserMessage("[bound-resume] 继续原来的任务，补充验证结果。", { requestId: "bound-resume" });
    await vi.waitFor(async () => {
      const diagnostic = { plans: f.plans.map(plan => ({ needle: plan.needle, used: plan.used })), results: toolResults(f.routerContexts, "kulo_steer"), tickets: (await f.tickets()).map(ticket => ({ status: ticket.status, role: ticket.role, report: ticket.latestReport, wakePending: ticket.wakePending })), latestInput: userTexts(f.routerContexts.at(-1)!).slice(-1000) };
      expect(f.runCalls().length, JSON.stringify(diagnostic)).toBe(2);
    }, { timeout: 10_000, interval: 20 }); await f.ready(1); await f.idle();
    expect(f.runCalls().map(([, request]) => request.binding.kind)).toEqual(["codex", "codex"]);
    expect(f.runCalls()[1]?.[1].sessionId).toBe(f.runCalls()[0]?.[1].sessionId ?? `session:${ticketId}`);
    await f.hub.sendUserMessage("[bound-conflict] 让 Claude Code 接着处理这个已有任务。", { requestId: "bound-conflict" });
    await vi.waitFor(() => { const results = toolResults(f.routerContexts, "kulo_steer"); expect(results).toHaveLength(2); expect(results[1]).toMatchObject({ isError: true }); }, { timeout: 8_000, interval: 20 });
    expect(JSON.stringify(toolResults(f.routerContexts, "kulo_steer"))).toMatch(/agent_binding_conflict|绑定|固定由|更换执行者|换.*智能体|another.*agent/i);
    expect(await f.tickets()).toHaveLength(1); expect((await f.tickets())[0]).toMatchObject({ role: "codex", agentAssignment: { agentId: "codex" } }); expect(f.runCalls()).toHaveLength(2); expect(f.execution).not.toHaveBeenCalled();
  });

  it("blocks a queued external task when its connection is saved as unverified before the slot becomes free", async () => {
    const held = new Set<ExternalAgentKind>(["codex"]);
    const f = await fixture({ maxConcurrentWorkers: 1, holdNative: held, plans: [
      { needle: "slot-holder-source", steps: [dispatch("slot-holder")] },
      { needle: "queued-target-source", steps: [dispatch("queued-target")] },
    ] });
    await f.hub.sendUserMessage("[slot-holder-source] 让 Codex 完成第一个任务。", { requestId: "slot-holder-source" });
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 8000, interval: 20 }); await f.idle();
    await f.hub.sendUserMessage("[queued-target-source] 让 Claude Code 完成第二个任务。", { requestId: "queued-target-source" });
    await vi.waitFor(async () => expect((await f.tickets()).find(ticket => ticket.commandId === "queued-target")).toMatchObject({ status: "queued", role: "claude-code" }), { timeout: 8000, interval: 20 }); await f.idle();
    const saved = await configureAgent(f, "claude-code", { modelId: "new-native-model-needs-verification" });
    expect(saved.enabled).toBe(false);
    expect(f.hub.getSettingsView().blocks.roles.value["claude-code"]).toMatchObject({ enabled: false });
    expect(f.runCalls()).toHaveLength(1);
    held.clear();
    await vi.waitFor(async () => {
      const tickets = await f.tickets();
      expect(tickets.find(ticket => ticket.commandId === "slot-holder")).toMatchObject({ status: "ready" });
      expect(tickets.find(ticket => ticket.commandId === "queued-target")).toMatchObject({ status: "waiting", latestReport: { state: "blocked" }, waiting: { reason: "user" }, role: "claude-code", agentAssignment: { agentId: "claude-code" } });
    }, { timeout: 10_000, interval: 20 });
    const queued = (await f.tickets()).find(ticket => ticket.commandId === "queued-target")!;
    expect(JSON.stringify(queued.latestReport)).toMatch(/停用|验证|配置.*改变/);
    expect(f.runCalls().map(([, request]) => request.binding.kind)).toEqual(["codex"]);
    expect(f.execution).not.toHaveBeenCalled();
  });

  it("keeps an in-flight Codex tool bound to its original user when a later Claude follow-up is already queued", async () => {
    const entered = gate(), release = gate();
    const f = await fixture({ plans: [
      { needle: "inflight-first-source", steps: [dispatch("inflight-first")] },
      { needle: "inflight-later-source", steps: [] },
    ], beforeAction: async action => { if (action.args.command_id === "inflight-first") { entered.release(); await release.promise; } } });
    cleanups.push(release.release);
    await f.hub.sendUserMessage("[inflight-first-source] 让 Codex 完成当前任务。", { requestId: "inflight-first-source" }); await entered.promise;
    try {
      await f.hub.sendUserMessage("[inflight-later-source] 让 Claude Code 处理另一个任务。", { requestId: "inflight-later-source", whenBusy: "followUp" });
      const later = (await f.hub.getTopicView("root")).messages.find(message => message.requestId === "inflight-later-source");
      expect(later).toMatchObject({ delivery: "queued" });
      expect(await f.tickets()).toEqual([]);
    } finally { release.release(); }
    const [first] = await f.ready(1);
    expect(first).toMatchObject({ commandId: "inflight-first", role: "codex", agentAssignment: { agentId: "codex", source: "explicit" } });
    const source = await f.hub.harness.commit(tx => tx.entry(first!.agentAssignment!.sourceEntryId as never), context);
    expect(source?.data.text).toContain("inflight-first-source");
    expect(source?.data.text).not.toContain("inflight-later-source");
    expect(f.runCalls()).toHaveLength(1);
    expect(f.runCalls()[0]?.[1]).toMatchObject({ taskId: first!.id, binding: { kind: "codex" } });
    expect(f.execution).not.toHaveBeenCalled();
  });

  it("rejects stale policy admission after the default changes during asynchronous project authorization", async () => {
    const entered = gate(), release = gate();
    const f = await fixture({ roles: {
      codex: external("codex", "codex", { dispatchPolicy: { defaultFor: ["coding"] } }),
      "claude-code": external("claude-code", "claude-code"),
    }, plans: [{ needle: "policy-race-source", steps: [dispatch("policy-race")] }] });
    const project = await f.hub.projects.create({ commandId: "policy-race-project", name: "Policy race", deviceId: "computer-a", workspaceDir: path.join(f.directory, "policy-race-project") });
    const topic = await f.hub.createTopic("Policy race", context, project.id);
    const authorize = vi.mocked(f.hub.envManager.authorizeProjectDirectory), previous = authorize.getMockImplementation()!;
    authorize.mockImplementation(async (envId, input) => { if (input.projectId === project.id && input.operationId.startsWith("project:authorize:")) { entered.release(); await release.promise; } return previous(envId, input); });
    cleanups.push(release.release);
    await f.hub.sendUserMessage("[policy-race-source] 完成当前项目的实现任务。", { topicId: topic.id, requestId: "policy-race-source" }); await entered.promise;
    try { await configurePolicy(f, "codex", { defaultFor: ["review"] }); }
    finally { release.release(); }
    await vi.waitFor(() => {
      const results = toolResults(f.routerContexts); expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ isError: true });
    }, { timeout: 8_000, interval: 20 });
    expect(JSON.stringify(toolResults(f.routerContexts))).toMatch(/派单期间|承接范围.*改变|配置.*改变|重新指派/);
    expect(await f.tickets()).toEqual([]); expect(f.runCalls()).toHaveLength(0); expect(f.execution).not.toHaveBeenCalled();
  });


  it("allows an authenticated Codex parent to delegate to Claude without reapplying the original user's Codex name", async () => {
    const held = new Set<ExternalAgentKind>(["codex"]);
    const f = await fixture({ holdNative: held, roles: {
      codex: external("codex", "codex", { allowSubagents: true }),
      "claude-code": external("claude-code", "claude-code"),
    }, plans: [{ needle: "collaboration-user-source", steps: [dispatch("collaboration-parent")] }] });
    await f.hub.sendUserMessage("[collaboration-user-source] 让 Codex 完成修改，需要协作时可请求其他智能体。", { requestId: "collaboration-user-source" });
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 8_000, interval: 20 });
    const parentRun = f.runCalls()[0]![1];
    const parent = (await f.tickets()).find(ticket => ticket.id === parentRun.taskId)!;
    expect(parent).toMatchObject({ role: "codex", status: "running", agentAssignment: { agentId: "codex", source: "explicit" } });
    expect(parentRun.allowSubagents).toBe(true);
    try {
      const delegated = await f.taskTool(parentRun, "kulo_request_collaboration", { request_id: "claude-review-child", agent_id: "claude-code", goal: "Review the authorized implementation and return evidence." });
      expect(delegated).toMatchObject({ requiresParentYield: true });
      expect((await f.tickets()).find(ticket => ticket.parentTicketId === parent.id)).toMatchObject({ status: "queued" });
      held.delete("codex");
      await vi.waitFor(async () => {
        const child = (await f.tickets()).find(ticket => ticket.parentTicketId === parent.id);
        expect(child).toMatchObject({ role: "claude-code", agentAssignment: { agentId: "claude-code", source: "manual" }, externalExecution: { binding: { kind: "claude-code" } } });
        expect(f.runCalls().find(([, request]) => request.taskId === child?.id)?.[1].binding.kind).toBe("claude-code");
      }, { timeout: 8_000, interval: 20 });
    } finally { held.clear(); }
    const tickets = await f.ready(2);
    expect(tickets.find(ticket => ticket.id === parent.id)).toMatchObject({ role: "codex", agentAssignment: { agentId: "codex" } });
    expect(tickets.find(ticket => ticket.parentTicketId === parent.id)).toMatchObject({ role: "claude-code", readOnly: false });
    expect(f.runCalls().map(([, request]) => request.binding.kind)).toEqual(["codex", "claude-code"]);
    expect(f.execution).not.toHaveBeenCalled();
  });


  it("does not let a model-supplied device bypass a default Agent, while honoring a real user-selected device", async () => {
    const f = await fixture({ workerEnvIds: ["computer-a", "computer-b"], roles: {
      codex: external("codex", "codex", { dispatchPolicy: { defaultFor: ["coding"] } }),
    }, plans: [
      { needle: "model-device-source", steps: [dispatch("model-device-bypass", "coding", { env_id: "computer-b" })] },
      { needle: "trusted-device-source", steps: [dispatch("trusted-device-scope", "coding", { env_id: "computer-b" })] },
    ] });
    await f.hub.sendUserMessage("[model-device-source] 帮我实现这项代码修改。", { requestId: "model-device-source" });
    await expectRejected(f, 1, /codex|computer-a|绑定.*设备|agent.*device/i); await f.idle();
    await f.hub.sendUserMessage("[trusted-device-source] 在当前选择的设备上完成代码修改。", { requestId: "trusted-device-source", targetDeviceId: "computer-b" });
    const [ticket] = await f.ready(1);
    expect(ticket).toMatchObject({ commandId: "trusted-device-scope", role: "coder", envId: "computer-b" });
    expect(ticket?.externalExecution).toBeUndefined(); expect(f.runCalls()).toHaveLength(0);
    expect(f.execution).toHaveBeenCalled(); expect(f.execution.mock.calls.every(([envId]) => envId === "computer-b")).toBe(true);
  });

});
