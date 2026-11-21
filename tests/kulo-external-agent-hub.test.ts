import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { EnvManager, type ExternalAgentToolHandler } from "@kulo/env";
import type { KuloHub, KuloHubConfigOverrides } from "@kulo/hub";
import type { EnvNodeDescriptor, ExternalAgentKind, ExternalAgentRequest, ExternalAgentResponse, ExternalAgentRun, RolePreset, TicketRecord } from "@kulo/protocol";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { externalAgentCollaborationFingerprint } from "../packages/hub/src/external-agent-tools.js";
import { ExternalAgentService } from "../packages/env/src/external-agents.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const nativeKinds = ["codex", "claude-code", "antigravity", "dsh"] as const;
const context = BACKGROUND_CONTEXT;
type NativeRequest = Extract<ExternalAgentRequest, { operation: "run" }>;

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(file => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY", "KULO_ENV_TOKENS"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function role(kind: ExternalAgentKind, extra: Partial<RolePreset> = {}): RolePreset {
  return {
    id: kind, label: kind, whenToUse: `Use the local ${kind} client`, prompt: `Execute with ${kind}, then report to Kulo.`,
    enabled: true, readOnly: true, allowSubagents: false,
    provider: "native-client-only-provider", modelId: `${kind}-native-model-not-in-pi`,
    external: { kind, envId: "computer-a", verifiedAt: 1_700_000_000_000 },
    ...extra,
  };
}

function toolNames(transcript: TranscriptContext): string[] {
  return [...new Set([
    ...transcript.messages.flatMap(message => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
      ? message.toolsAdded.map(tool => tool.name) : []),
  ])];
}

function completedRun(run: ExternalAgentRun): ExternalAgentRun {
  return { ...run, state: "completed", text: `Verified ${run.kind} native result`, nextSequence: 2, quiescent: true,
    events: [{ sequence: 1, at: Date.now(), type: "state", text: "completed" }] };
}

async function fixture(options: {
  roles?: Record<string, RolePreset>;
  maxConcurrentWorkers?: number;
  loseRunAcknowledgement?: boolean;
  acknowledge?: (run: ExternalAgentRun) => ExternalAgentRun;
  inspect?: (run: ExternalAgentRun) => ExternalAgentRun;
} = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-external-agent-hub-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const modelCalls: string[][] = [];
  faux.setResponses(Array.from({ length: 80 }, () => (transcript: TranscriptContext) => {
    modelCalls.push(toolNames(transcript));
    return fauxAssistantMessage([fauxText("已收到原生客户端的结果。")]);
  }));
  const config: KuloHubConfigOverrides = {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"),
    localEnvRoot: path.join(directory, "main-workspace"), enableLocalEnv: false, envTokens: {}, watchdogMinutes: 0,
    maxConcurrentWorkers: options.maxConcurrentWorkers ?? 2, memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
    roles: options.roles ?? Object.fromEntries(nativeKinds.map(kind => [kind, role(kind)])),
  };
  let installedToolHandler: ExternalAgentToolHandler | undefined;
  const setToolHandler = EnvManager.prototype.setExternalAgentToolHandler;
  vi.spyOn(EnvManager.prototype, "setExternalAgentToolHandler").mockImplementation(function (this: EnvManager, handler) {
    if (handler) installedToolHandler = handler;
    setToolHandler.call(this, handler);
  });
  const hub = await openTestHub({ config, models });
  cleanups.push(() => hub.close());
  if (!installedToolHandler) throw new Error("Hub did not install the external task MCP handler");
  const toolHandler = installedToolHandler;
  const computers = ["computer-a", "computer-b"].map((id): EnvNodeDescriptor => ({
    id, name: id, kind: "reverse-ws", executionKind: "pi-env", online: true, platform: "linux", arch: "x64",
    rootDir: path.join(directory, id), capabilities: ["worker-isolation", "external-agents"], connectedAt: 1, lastSeenAt: 1,
  }));
  const phone: EnvNodeDescriptor = {
    id: "phone", name: "phone", kind: "reverse-ws", executionKind: "native-device", online: true, platform: "android", arch: "arm64",
    rootDir: "", capabilities: ["android-device", "android-native-v1"], connectedAt: 1, lastSeenAt: 1,
  };
  const devices = [...computers, phone];
  vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation(id => devices.find(device => device.id === id));
  vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => structuredClone(devices));
  vi.spyOn(hub.envManager, "pickDefaultWorkerEnvId").mockReturnValue("computer-b");
  vi.spyOn(hub.envManager, "pickDefaultEnvId").mockReturnValue("computer-b");
  vi.spyOn(hub.envManager, "createExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
  // Native execution is mocked at the Env boundary; entering the Pi worker path is a regression.
  const piCreateDir = vi.fn(async () => { throw new Error("External tickets must not run a Pi coding worker"); });
  const workerEnv = new NodeExecutionEnv({ cwd: path.join(directory, "mock-worker") });
  vi.spyOn(workerEnv, "createDir").mockImplementation(piCreateDir);
  const execution = vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockReturnValue(workerEnv);
  const cleanup = vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockResolvedValue({ cleanupPending: false });
  vi.spyOn(hub.envManager, "authorizeProjectDirectory").mockImplementation(async (_envId, input) => ({
    projectId: input.projectId, workspaceDir: input.path, directoryId: `directory:${input.path}`,
    revision: input.revision ?? 1, scratchRoot: path.join(directory, "project-scratch"), platform: "linux",
  }));
  const runs = new Map<string, ExternalAgentRun>();
  const persistedAtAdmission: TicketRecord[] = [];
  const native = vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, request): Promise<ExternalAgentResponse> => {
    if (request.operation === "run") {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets[request.taskId];
      if (!ticket) throw new Error("The Hub sent a native task before persisting its ticket");
      persistedAtAdmission.push(structuredClone(ticket));
      const run: ExternalAgentRun = {
        id: request.requestId, taskId: request.taskId, runEpoch: request.runEpoch, kind: request.binding.kind,
        sessionId: request.sessionId ?? `native-session:${request.requestId}`, state: "running", text: "", events: [], permissions: [], nextSequence: 1, quiescent: false,
      };
      runs.set(run.id, run);
      if (options.loseRunAcknowledgement) throw new Error("Native task admitted, but acknowledgement was lost");
      return { type: "run", run: options.acknowledge?.(structuredClone(run)) ?? structuredClone(run) };
    }
    if (request.operation === "detect" || request.operation === "probe") throw new Error("Dispatch must not rediscover a verified connection");
    const run = runs.get(request.runId);
    if (!run) throw new Error("Unknown native run");
    if (request.operation === "inspect") {
      return { type: "run", run: options.inspect?.(structuredClone(run)) ?? completedRun(run) };
    }
    return { type: "run", run: { ...run, state: request.operation === "cancel" || request.operation === "close" ? "cancelled" : run.state,
      quiescent: request.operation === "cancel" || request.operation === "close" } };
  });
  async function settled(id: string, expected = "ready"): Promise<TicketRecord> {
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets[id];
      expect({ status: ticket?.status, report: ticket?.latestReport }).toMatchObject({ status: expected });
      expect(ticket?.cleanupPending).not.toBe(true);
    }, { timeout: 12_000, interval: 20 });
    return (await hub.harness.snapshot(KuloStateDoc, context))!.tickets[id]!;
  }
  const dispatch = (commandId: string, extra: Partial<Parameters<KuloHub["dispatchTicket"]>[0]> = {}) => hub.dispatchTicket({
    commandId, title: commandId, goal: "Read the authorized workspace and return evidence", scope: "Authorized computer workspace only", role: "codex", ...extra,
  });
  const runCalls = () => native.mock.calls.filter((call): call is [string, NativeRequest] => call[1].operation === "run");
  const taskTool = (run: NativeRequest, name: string, args: Record<string, unknown> = {}, scope: Partial<Parameters<ExternalAgentToolHandler>[0]> = {}) => toolHandler({
    envId: run.binding.envId, taskId: run.taskId, runId: run.requestId, runEpoch: run.runEpoch, cwd: run.cwd,
    allowSubagents: run.allowSubagents, ...scope, name, args,
  });
  return { hub, config, models, directory, devices, native, modelCalls, piCreateDir, execution, cleanup, runs, persistedAtAdmission, settled, dispatch, runCalls, taskTool };
}

describe("Hub dispatch to local external Agent clients", () => {
  it.each(nativeKinds)("runs %s on its fixed Env with the native model outside Pi provider validation", async kind => {
    const f = await fixture();
    const card = await f.dispatch(`native-${kind}`, { role: kind });
    const ticket = await f.settled(card.id);
    expect(card).toMatchObject({ envId: "computer-a", executionDomain: "computer" });
    expect(f.runCalls()).toHaveLength(1);
    const [envId, request] = f.runCalls()[0]!;
    expect(envId).toBe("computer-a");
    expect(request).toMatchObject({
      binding: { kind, envId: "computer-a" }, modelId: `${kind}-native-model-not-in-pi`,
      taskId: card.id, runEpoch: 1, cwd: ticket.workspaceDir, readOnly: false, allowSubagents: false,
    });
    expect(request.prompt).toContain(`Execute with ${kind}`);
    expect(request.prompt).toContain("Read the authorized workspace");
    expect(f.persistedAtAdmission[0]).toMatchObject({ status: "running", externalExecution: { runId: request.requestId } });
    expect(ticket.externalExecution).toMatchObject({ runId: request.requestId, sessionId: `native-session:${request.requestId}`, lastSequence: 1 });
    expect(ticket.latestReport).toMatchObject({ state: "ready", deliverable: `Verified ${kind} native result` });
    expect(f.piCreateDir).not.toHaveBeenCalled();
    expect(f.modelCalls.some(tools => tools.includes("kulo_report"))).toBe(false);
    expect(f.native.mock.calls).toContainEqual(["computer-a", { operation: "close", runId: request.requestId }]);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.hub.getSettingsView().blocks.model.value.defaultModel).toBe("hub-model");
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("uses the native client's default model without persisting a missing modelId key", async () => {
    const nativeRole = role("codex");
    delete nativeRole.modelId;
    const f = await fixture({ roles: { codex: nativeRole } });
    const card = await f.dispatch("native-default-model");
    const ticket = await f.settled(card.id);
    expect(f.runCalls()).toHaveLength(1);
    expect(Object.hasOwn(f.runCalls()[0]![1], "modelId")).toBe(false);
    expect(Object.hasOwn(ticket.externalExecution!, "modelId")).toBe(false);
    expect(ticket.externalExecution?.modelId).not.toBe("hub-model");
    expect(f.piCreateDir).not.toHaveBeenCalled();
  });

  it.each([undefined, "auto", "high", "off"] as const)("passes native reasoning selection %s without inheriting the Hub default", async thinkingLevel => {
    const nativeRole = role("codex");
    if (thinkingLevel !== undefined) nativeRole.thinkingLevel = thinkingLevel;
    const f = await fixture({ roles: { codex: nativeRole } });
    const card = await f.dispatch(`native-thinking-${thinkingLevel ?? "default"}`);
    const ticket = await f.settled(card.id);
    const request = f.runCalls()[0]![1];
    if (thinkingLevel === undefined || thinkingLevel === "auto") {
      expect(Object.hasOwn(request, "thinkingLevel")).toBe(false);
      expect(Object.hasOwn(ticket.externalExecution!, "thinkingLevel")).toBe(false);
    } else {
      expect(request).toHaveProperty("thinkingLevel", thinkingLevel);
      expect(ticket.externalExecution).toHaveProperty("thinkingLevel", thinkingLevel);
    }
  });

  it("expresses a read-only assignment as input while reserving write access for the native client's own execution", async () => {
    const f = await fixture({ roles: { codex: role("codex", { readOnly: true }) }, inspect: run => run });
    const card = await f.dispatch("native-readonly-intent");
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 4000, interval: 20 });
    const request = f.runCalls()[0]![1];
    const state = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(state.tickets[card.id]).toMatchObject({ readOnly: false });
    expect(state.slots.writeHolders).toContain(card.id);
    expect(request.readOnly).toBe(false);
    expect(request.prompt).toMatch(/只读|read.only/i);
    expect(request.prompt).toContain("Read the authorized workspace");
    expect(request.prompt).not.toContain("kulo_task_exec");
    expect(request.prompt).not.toMatch(/仅通过\s*Kulo|不能通过原生授权扩大权限|必须使用\s*Kulo/);
    expect(f.piCreateDir).not.toHaveBeenCalled();
    await f.hub.stopTicket(card.id, "Finish the synthetic native assignment");
  });

  it("rejects device changes and phone execution before calling any external client", async () => {
    const f = await fixture();
    await expect(f.dispatch("wrong-computer", { envId: "computer-b" })).rejects.toMatchObject({ code: "agent_device_conflict" });
    await expect(f.dispatch("wrong-domain", { executionDomain: "android" })).rejects.toMatchObject({ code: "agent_project_conflict" });
    await expect(f.dispatch("expanded-phones", { androidDeviceIds: ["phone"] })).rejects.toMatchObject({ code: "agent_project_conflict" });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.execution).not.toHaveBeenCalled();
    expect(Object.values((await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets ?? {})).toHaveLength(0);
  });

  it("keeps project authorization and grant identity on the bound computer", async () => {
    const f = await fixture();
    const other = await f.hub.projects.create({ commandId: "other-project", name: "Other device", deviceId: "computer-b", workspaceDir: path.join(f.directory, "other-project") });
    await expect(f.dispatch("wrong-project", { projectId: other.id })).rejects.toMatchObject({ code: "agent_project_conflict" });
    const project = await f.hub.projects.create({ commandId: "bound-project", name: "Bound device", deviceId: "computer-a", workspaceDir: path.join(f.directory, "bound-project") });
    const card = await f.dispatch("authorized-project", { projectId: project.id });
    const ticket = await f.settled(card.id);
    expect(ticket).toMatchObject({ projectId: project.id, envId: "computer-a", workspaceDir: project.workspaceDir, directoryId: project.directoryId, grantRevision: project.grantRevision });
    expect(f.runCalls()[0]?.[1]).toMatchObject({ projectId: project.id, cwd: project.workspaceDir, directoryId: project.directoryId, grantRevision: project.grantRevision });
  });

  it.each(["grok-bot", "dots", "muse"] as const)("keeps the %s entry unavailable to automatic task dispatch", async kind => {
    const f = await fixture({ roles: { [kind]: role(kind) } });
    await expect(f.dispatch(`reserved-${kind}`, { role: kind })).rejects.toMatchObject({ code: "external_agent_unverified" });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.piCreateDir).not.toHaveBeenCalled();
  });

  it("requires roundtrip verification before a saved external role can execute", async () => {
    const f = await fixture({ roles: { codex: role("codex", { external: { kind: "codex", envId: "computer-a" } }) } });
    await expect(f.dispatch("unverified-codex")).rejects.toMatchObject({ code: "external_agent_unverified" });
    expect(f.native).not.toHaveBeenCalled();
    expect(Object.values((await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets ?? {})).toHaveLength(0);
  });

  it("keeps ordinary Pi roles subject to conversation-model validation", async () => {
    const f = await fixture();
    const roles = f.hub.getSettingsView().blocks.roles;
    await expect(f.hub.updateSettingsBlock("roles", roles.revision, {
      ...roles.value,
      ordinary: { id: "ordinary", label: "ordinary", whenToUse: "ordinary Pi worker", prompt: "ordinary Pi worker", provider: "openai", modelId: "gpt-image-1" },
    })).rejects.toThrow(/图像/);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.modelCalls).toHaveLength(0);
  });

  it("preserves enforced read-only execution for an internal Pi worker", async () => {
    const f = await fixture({ roles: { reader: {
      id: "reader", label: "Internal reader", whenToUse: "Read the project", prompt: "Read only", enabled: true,
      provider: "openai", modelId: "hub-model", readOnly: true,
    } } });
    const card = await f.dispatch("internal-readonly", { role: "reader" });
    const ticket = (await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
    expect(ticket.readOnly).toBe(true);
    expect(ticket.externalExecution).toBeUndefined();
    expect(f.execution.mock.calls.some(([, , options]) => options?.readOnly === true)).toBe(true);
    expect(f.native).not.toHaveBeenCalled();
  });

  it("preserves native run and session identity across a Hub restart without rerunning completed work", async () => {
    const f = await fixture();
    const card = await f.dispatch("durable-native-run");
    const ticket = await f.settled(card.id);
    await f.hub.close();
    const restored = await openTestHub({ config: f.config, models: f.models });
    cleanups.push(() => restored.close());
    const restoredNative = vi.spyOn(restored.envManager, "requestExternalAgent").mockRejectedValue(new Error("Completed external work must not execute again"));
    const state = await restored.harness.snapshot(KuloStateDoc, context);
    expect(state?.tickets[card.id]).toMatchObject({ status: "ready", externalExecution: {
      runId: ticket.externalExecution!.runId, sessionId: ticket.externalExecution!.sessionId,
      binding: { kind: "codex", envId: "computer-a" }, modelId: "codex-native-model-not-in-pi",
    } });
    const duplicate = await restored.dispatchTicket({ commandId: "durable-native-run", title: "same command", goal: "same command", scope: "same command", role: "codex" });
    expect(duplicate.id).toBe(card.id);
    expect(restoredNative).not.toHaveBeenCalled();
    expect(f.runCalls()).toHaveLength(1);
  });

  it("inspects the persisted deterministic run after a lost acknowledgement instead of resending a task", async () => {
    const f = await fixture({ loseRunAcknowledgement: true });
    const card = await f.dispatch("lost-native-ack");
    const ticket = await f.settled(card.id);
    expect(f.runCalls()).toHaveLength(1);
    const request = f.runCalls()[0]![1];
    expect(f.persistedAtAdmission[0]?.externalExecution?.runId).toBe(request.requestId);
    expect(f.native.mock.calls.filter(([, call]) => call.operation === "inspect")).toEqual([
      ["computer-a", { operation: "inspect", runId: request.requestId, afterSequence: undefined }],
    ]);
    expect(ticket.latestReport).toMatchObject({ state: "ready", deliverable: "Verified codex native result" });
  });

  it.each([false, true])("reports a native executable rejection without fallback, including a lost rejection acknowledgement (%s)", async loseAcknowledgement => {
    const clientDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-removed-native-client-"));
    cleanups.push(() => fs.rmSync(clientDirectory, { recursive: true, force: true }));
    const f = await fixture({ roles: { antigravity: role("antigravity", { external: {
      kind: "antigravity", envId: "computer-a", verifiedAt: 1_700_000_000_000, executable: path.join(clientDirectory, "agy"),
    } }) } });
    const registry = new ProjectDirectoryRegistry({ deviceId: "computer-a", filePath: path.join(f.directory, "native-control", "grants.json"), scratchRoot: path.join(f.directory, "native-scratch") });
    const nativeProcess = vi.fn();
    const service = new ExternalAgentService({ envId: "computer-a", rootDir: f.directory, projectRegistry: registry, pipeFactory: nativeProcess });
    cleanups.push(() => service.close());
    f.native.mockImplementation(async (_envId, request) => {
      const response = await service.request(request);
      if (request.operation === "run" && loseAcknowledgement) throw new Error("Run rejection acknowledgement was lost");
      return response;
    });
    const card = await f.dispatch(`missing-native-executable-${loseAcknowledgement}`, { role: "antigravity" });
    const ticket = await f.settled(card.id, "waiting");
    expect(ticket.role).toBe("antigravity");
    expect(ticket.externalExecution?.binding.kind).toBe("antigravity");
    expect(ticket.latestReport).toMatchObject({ state: "blocked", summary: expect.stringContaining("executable was not found"), question: expect.stringContaining("恢复指定客户端") });
    expect(ticket.latestReport?.summary).toContain("No task was submitted");
    expect(ticket.latestReport?.question).toContain("具体原因：Local antigravity client could not start: Agent executable was not found");
    expect(ticket.latestReport?.question).toContain("No task was submitted");
    expect(ticket.latestReport?.question).not.toContain("接收状态不明确");
    expect(f.runCalls()).toHaveLength(1);
    expect(nativeProcess).not.toHaveBeenCalled();
    expect(f.piCreateDir).not.toHaveBeenCalled();
    expect(f.execution).not.toHaveBeenCalled();
    expect(Object.values((await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets)).toHaveLength(1);
  });

  it("keeps an unconfirmed admission uncertain when no receipt can be recovered and never replays or substitutes a Worker", async () => {
    const f = await fixture();
    f.native.mockImplementation(async (_envId, request) => {
      if (request.operation === "run") throw new Error("Connection closed before the admission acknowledgement arrived");
      throw new Error("External agent run was not found on this device");
    });
    const card = await f.dispatch("unknown-native-admission");
    await vi.waitFor(async () => {
      const ticket = (await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
      expect(ticket.status).toBe("waiting");
      expect(ticket.latestReport).toMatchObject({ state: "blocked", question: expect.stringContaining("接收状态不明确") });
      expect(ticket.cleanupPending).toBe(true);
    }, { timeout: 12_000, interval: 20 });
    expect(f.runCalls()).toHaveLength(1);
    expect(f.piCreateDir).not.toHaveBeenCalled();
    expect(f.execution).not.toHaveBeenCalled();
    expect(Object.values((await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets)).toHaveLength(1);
  });

  it("rejects an acknowledgement from another native scope and inspects only the admitted run", async () => {
    const f = await fixture({ acknowledge: run => ({ ...run, id: "foreign-run", taskId: "foreign-ticket", runEpoch: 20, kind: "dsh", sessionId: "foreign-session" }) });
    const card = await f.dispatch("foreign-native-ack");
    const ticket = await f.settled(card.id);
    const request = f.runCalls()[0]![1];
    expect(f.runCalls()).toHaveLength(1);
    expect(ticket.externalExecution).toMatchObject({ runId: request.requestId, sessionId: `native-session:${request.requestId}` });
    expect(f.native.mock.calls.filter(([, call]) => call.operation === "inspect")).toEqual([
      ["computer-a", { operation: "inspect", runId: request.requestId, afterSequence: undefined }],
    ]);
    expect(JSON.stringify(ticket)).not.toContain("foreign-session");
    expect(JSON.stringify(ticket)).not.toContain("foreign-run");
  });

  it("parks an unrelated native result for user review without attributing it to the current task", async () => {
    const f = await fixture({ inspect: run => ({ ...run, taskId: "another-ticket", state: "completed", text: "Unrelated private result" }) });
    const card = await f.dispatch("foreign-native-result");
    const ticket = await f.settled(card.id, "waiting");
    expect(ticket.waiting?.reason).toBe("user");
    expect(ticket.latestReport).toMatchObject({ state: "blocked" });
    expect(JSON.stringify(ticket.latestReport)).not.toContain("Unrelated private result");
    expect(f.runCalls()).toHaveLength(1);
    expect(f.piCreateDir).not.toHaveBeenCalled();
  });

  it("relays native permission requests to the main Agent and validates each human decision", async () => {
    let permissionAnswered = false;
    const permission = { id: "native-permission", title: "Allow reading the project manifest?", choices: [
      { id: "allow-once", label: "Allow once" }, { id: "deny", label: "Deny" },
    ] };
    const f = await fixture({ inspect: run => ({ ...run,
      state: permissionAnswered ? "completed" : "waiting", permissions: permissionAnswered ? [] : [permission],
      text: permissionAnswered ? "Permission decision received" : "", nextSequence: 2, quiescent: permissionAnswered,
    }) });
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async (envId, request) => {
      if (request.operation !== "respond") return original(envId, request);
      permissionAnswered = true;
      return { type: "run", run: { ...f.runs.get(request.runId)!, permissions: [] } };
    });
    const card = await f.dispatch("native-permission-flow");
    await vi.waitFor(async () => {
      const ticket = (await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      expect(ticket?.externalExecution?.pendingPermissions).toEqual([permission]);
      expect(ticket?.externalExecution?.notifiedPermissions).toEqual([permission.id]);
      expect(f.native.mock.calls.filter(([, request]) => request.operation === "inspect").length).toBeGreaterThanOrEqual(2);
    }, { timeout: 4000, interval: 20 });
    const entries = await f.hub.rootConversation.entries({}, 80, undefined, context);
    const relays = entries.items.filter(entry => entry.kind === "kulo.worker_relay" && JSON.stringify(entry.data).includes(permission.title));
    expect(relays).toHaveLength(1);
    expect(f.native.mock.calls.filter(([, request]) => request.operation === "respond")).toHaveLength(0);
    await expect(f.hub.respondExternalAgentPermission(card.id, permission.id, "allow-once", 2)).rejects.toThrow(/执行资格/);
    await expect(f.hub.respondExternalAgentPermission(card.id, "another-permission", "allow-once", 1)).rejects.toThrow(/失效/);
    await expect(f.hub.respondExternalAgentPermission(card.id, permission.id, "allow-everything", 1)).rejects.toThrow(/失效/);
    expect(f.native.mock.calls.filter(([, request]) => request.operation === "respond")).toHaveLength(0);
    await f.hub.respondExternalAgentPermission(card.id, permission.id, "allow-once", 1);
    const ticket = await f.settled(card.id);
    expect(ticket.latestReport?.deliverable).toBe("Permission decision received");
    expect(f.native.mock.calls.filter(([, request]) => request.operation === "respond")).toEqual([
      ["computer-a", { operation: "respond", runId: f.runCalls()[0]![1].requestId, permissionId: permission.id, choiceId: "allow-once" }],
    ]);
  });

  it("queues guidance received during a native run and continues its session in a new epoch", async () => {
    let finishFirst = false;
    const f = await fixture({ inspect: run => run.runEpoch === 1 && !finishFirst ? run : {
      ...run, state: "completed", text: `Native epoch ${run.runEpoch} finished`, nextSequence: 2, quiescent: true,
    } });
    const card = await f.dispatch("native-followup");
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 4000, interval: 20 });
    const first = f.runCalls()[0]![1];
    await f.hub.steerTicket({ commandId: "native-followup-guidance", ticketId: card.id, text: "Also inspect the package manifest and keep the same session." });
    const pending = (await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
    expect(pending).toMatchObject({ runEpoch: 1, wakePending: true });
    expect(pending.resumePrompt).toContain("Also inspect the package manifest");
    expect(f.runCalls()).toHaveLength(1);
    finishFirst = true;
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(2), { timeout: 6000, interval: 20 });
    const second = f.runCalls()[1]![1];
    expect(second).toMatchObject({
      taskId: card.id, runEpoch: 2, sessionId: `native-session:${first.requestId}`,
      requestId: `kulo:external:${card.id}:2`, modelId: first.modelId, cwd: first.cwd,
    });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.prompt).toContain("Also inspect the package manifest");
    const ticket = await f.settled(card.id);
    expect(ticket).toMatchObject({ runEpoch: 2, externalExecution: { runId: second.requestId, sessionId: second.sessionId } });
    expect(ticket.resumePrompt).toBeUndefined();
    expect(f.piCreateDir).not.toHaveBeenCalled();
  });
});

describe("External task MCP through the real Hub collaboration host", () => {
  it("dispatches a scoped child, persists its ownership and makes concurrent request retries idempotent", async () => {
    let finishParent = false;
    const f = await fixture({ roles: {
      codex: role("codex", { readOnly: false, allowSubagents: true }),
      "claude-code": role("claude-code", { readOnly: false }),
      "remote-helper": role("dsh", { id: "remote-helper", external: { kind: "dsh", envId: "computer-b", verifiedAt: 1_700_000_000_000 } }),
      "writable-helper": role("dsh", { id: "writable-helper", readOnly: false }),
    }, inspect: run => run.kind === "codex" && !finishParent ? run : completedRun(run) });
    const project = await f.hub.projects.create({ commandId: "collaboration-project", name: "Shared authorized project", deviceId: "computer-a", workspaceDir: path.join(f.directory, "collaboration-project") });
    const parent = await f.dispatch("collaborating-parent", { projectId: project.id });
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 4000, interval: 20 });
    const parentRun = f.runCalls()[0]![1];
    expect(await f.taskTool(parentRun, "kulo_task_context")).toMatchObject({ taskId: parent.id, readOnly: false, allowSubagents: true });
    const available = await f.taskTool(parentRun, "kulo_agents") as { agents: Array<{ id: string }> };
    expect(available.agents.map(agent => agent.id)).toContain("claude-code");
    expect(available.agents.map(agent => agent.id)).toContain("writable-helper");
    for (const id of ["codex", "remote-helper"]) expect(available.agents.map(agent => agent.id)).not.toContain(id);
    for (const agentId of ["remote-helper"]) {
      await expect(f.taskTool(parentRun, "kulo_request_collaboration", { request_id: `denied-${agentId}`, agent_id: agentId, goal: "Read the manifest" })).rejects.toMatchObject({ code: "external_collaboration_target_denied" });
    }
    const request = { request_id: "inspect-manifest", agent_id: "claude-code", goal: "Inspect the manifest and list runtime dependencies", acceptance: "Return dependency names without changing files" };
    const results = await Promise.all([
      f.taskTool(parentRun, "kulo_request_collaboration", request),
      f.taskTool(parentRun, "kulo_request_collaboration", request),
    ]) as Array<{ id?: string; taskId?: string }>;
    const state = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(state.tickets[parent.id]!.externalExecution!.children).toHaveProperty(request.request_id);
    const childEntry = state.tickets[parent.id]!.externalExecution!.children![request.request_id]!;
    expect(childEntry).toEqual({ taskId: expect.any(String), fingerprint: externalAgentCollaborationFingerprint({ agentId: request.agent_id, goal: request.goal, acceptance: request.acceptance }) });
    expect(results.map(result => result.id ?? result.taskId)).toEqual([childEntry.taskId, childEntry.taskId]);
    expect(Object.values(state.tickets).filter(ticket => ticket.parentTicketId === parent.id)).toHaveLength(1);
    expect(state.tickets[childEntry.taskId]).toMatchObject({ status: "queued", readOnly: false });
    expect(state.slots.writeHolders).toContain(parent.id);
    expect(f.runCalls()).toHaveLength(1);
    expect(await f.taskTool(parentRun, "kulo_child_task", { task_id: childEntry.taskId })).toMatchObject({ taskId: childEntry.taskId, status: "queued" });
    expect(await f.taskTool(parentRun, "kulo_request_collaboration", request)).toMatchObject({ taskId: childEntry.taskId, status: "queued" });
    await expect(f.taskTool(parentRun, "kulo_request_collaboration", { ...request, goal: "A different objective using the same request ID" })).rejects.toMatchObject({ code: "external_collaboration_request_conflict" });
    await expect(f.taskTool(parentRun, "kulo_child_task", { task_id: "T-9999" })).rejects.toMatchObject({ code: "external_child_task_forbidden" });
    finishParent = true;
    await f.settled(parent.id);
    const child = await f.settled(childEntry.taskId);
    expect(child).toMatchObject({
      parentTicketId: parent.id, role: "claude-code", readOnly: false, envId: "computer-a", scope: state.tickets[parent.id]!.scope,
      projectId: project.id, workspaceDir: project.workspaceDir, directoryId: project.directoryId, grantRevision: project.grantRevision,
      goal: request.goal, acceptance: request.acceptance,
    });
    expect(f.runCalls().filter(([, run]) => run.taskId === child.id)).toHaveLength(1);
    expect(f.runCalls().find(([, run]) => run.taskId === child.id)?.[1]).toMatchObject({
      projectId: project.id, directoryId: project.directoryId, grantRevision: project.grantRevision,
      binding: { kind: "claude-code", envId: "computer-a" }, readOnly: false, allowSubagents: false,
    });
    expect(f.runCalls()).toHaveLength(2);
    await f.hub.close();
    const restored = await openTestHub({ config: f.config, models: f.models });
    cleanups.push(() => restored.close());
    const restoredState = (await restored.harness.snapshot(KuloStateDoc, context))!;
    expect(restoredState.tickets[parent.id]?.externalExecution?.children).toEqual({ [request.request_id]: childEntry });
    expect(restoredState.tickets[child.id]).toMatchObject({ parentTicketId: parent.id, status: "ready", projectId: project.id });
    expect(f.piCreateDir).not.toHaveBeenCalled();
  });

  it("refuses collaboration when the saved switch is off and rejects an expired run epoch", async () => {
    const f = await fixture({ inspect: run => run });
    const parent = await f.dispatch("collaboration-disabled");
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 4000, interval: 20 });
    const parentRun = f.runCalls()[0]![1];
    const request = { request_id: "cannot-self-enable", agent_id: "claude-code", goal: "Inspect the manifest" };
    await expect(f.taskTool(parentRun, "kulo_request_collaboration", request, { allowSubagents: true })).rejects.toMatchObject({ code: "external_collaboration_disabled" });
    await expect(f.taskTool(parentRun, "kulo_agents", {}, { allowSubagents: true })).rejects.toMatchObject({ code: "external_collaboration_disabled" });
    await expect(f.taskTool(parentRun, "kulo_task_context", {}, { runEpoch: parentRun.runEpoch + 1 })).rejects.toThrow(/执行资格/);
    await expect(f.taskTool(parentRun, "kulo_task_context", {}, { runId: "another-native-run" })).rejects.toThrow(/执行资格/);
    const state = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(Object.values(state.tickets)).toHaveLength(1);
    expect(state.tickets[parent.id]?.externalExecution?.children ?? {}).toEqual({});
    await f.hub.stopTicket(parent.id, "Finish the synthetic test");
  });

  it("releases a writable parent after native completion so its queued child can use the freed slot", async () => {
    let finishParent = false;
    let finishChild = false;
    const f = await fixture({ maxConcurrentWorkers: 1, roles: {
      codex: role("codex", { readOnly: false, allowSubagents: true }),
      "claude-code": role("claude-code"),
    }, inspect: run => run.kind === "codex" ? finishParent ? completedRun(run) : run : finishChild ? completedRun(run) : run });
    const project = await f.hub.projects.create({ commandId: "yield-project", name: "Yielding parent project", deviceId: "computer-a", workspaceDir: path.join(f.directory, "yield-project") });
    const parent = await f.dispatch("writable-parent-yield", { projectId: project.id });
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(1), { timeout: 4000, interval: 20 });
    const parentRun = f.runCalls()[0]![1];
    const result = await f.taskTool(parentRun, "kulo_request_collaboration", { request_id: "queued-review", agent_id: "claude-code", goal: "Review the manifest read-only" }) as { id: string; requiresParentYield: boolean };
    expect(result).toMatchObject({ id: expect.any(String), requiresParentYield: true });
    const before = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(before.tickets[parent.id]).toMatchObject({ status: "running", readOnly: false });
    expect(before.tickets[result.id]).toMatchObject({ status: "queued", parentTicketId: parent.id, readOnly: false });
    expect(before.slots.writeHolders).toContain(parent.id);
    expect(f.runCalls()).toHaveLength(1);
    finishParent = true;
    const releasedParent = await f.settled(parent.id);
    expect(releasedParent.cleanupPending).toBe(false);
    await vi.waitFor(() => expect(f.runCalls()).toHaveLength(2), { timeout: 6000, interval: 20 });
    const after = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(after.tickets[result.id]).toMatchObject({ status: "running", parentTicketId: parent.id, projectId: project.id, readOnly: false });
    expect(after.slots.writeHolders).not.toContain(parent.id);
    expect(after.slots.holders).toEqual([result.id]);
    expect(f.runCalls()[1]?.[1]).toMatchObject({ taskId: result.id, cwd: parentRun.cwd, readOnly: true, workspaceMode: "read_only", projectId: project.id });
    finishChild = true;
    await f.settled(result.id);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    expect(f.piCreateDir).not.toHaveBeenCalled();
  });
});
