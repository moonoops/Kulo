import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  EXTERNAL_AGENT_NODE_CAPABILITIES,
  EnvManager,
  isExternalAgentRequest,
  resolveSafeExternalImages,
  type ExternalAgentToolHandler,
} from "@kulo/env";
import type { KuloHubConfigOverrides } from "@kulo/hub";
import {
  EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY,
  type EnvNodeDescriptor,
  type ExternalAgentRequest,
  type ExternalAgentResponse,
  type ExternalAgentRun,
  type RolePreset,
  type TicketRecord,
} from "@kulo/protocol";
import { connectAcp, connectCodex, type ExternalDriverContext } from "../packages/env/src/external-agent-drivers.js";
import { nativeClaudeOptions } from "../packages/env/src/external-agent-claude.js";
import { startExternalAgentMcp } from "../packages/env/src/external-agent-mcp.js";
import type { ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
import {
  buildExternalAgentPrompt,
  buildExternalAgentRunRequest,
  budgetExternalContextSections,
  reconcileConsumedResumeState,
  stripMemoryContextHeader,
} from "../packages/hub/src/prompts/external-agent.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const context = BACKGROUND_CONTEXT;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeTicket(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "T-1001",
    title: "Refactor protocol framing",
    goal: "Update framing logic and verify Array<string> handling",
    scope: "packages/hub/src/**",
    role: "codex",
    status: "running",
    envId: "computer-a",
    workspaceDir: "/secret/host/repo",
    scratchDir: "/tmp/kulo-scratch/T-1001",
    readOnly: false,
    runEpoch: 1,
    createdAt: 1,
    updatedAt: 1,
    queuedAt: 1,
    accumulatedRunningMs: 0,
    workerConversationId: 10,
    originConversationId: 1,
    externalExecution: {
      binding: { kind: "codex", envId: "computer-a", verifiedAt: 1_700_000_000_000 },
      workspaceMode: "staged",
      instructions: "Focus on minimal diffs.",
      allowSubagents: false,
    },
    ...patch,
  } as TicketRecord;
}

function mockDriverFixture(
  kind: "codex" | "dsh",
  options: {
    rejectGraceOnce?: boolean;
    acpImageCap?: boolean;
    acpSystemPromptCap?: boolean;
    acpHttpMcp?: boolean;
    acpStopReason?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-ext-opt-driver-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  const inputsDir = path.join(root, "inputs");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(inputsDir, { recursive: true });

  const sent: Array<Record<string, any>> = [];
  const responses = new Map<number, Record<string, any>>();
  let spec!: ExternalAgentPipeOptions;
  let rejectedGrace = false;
  const emit = (msg: unknown) => spec.onStdout(Buffer.from(`${JSON.stringify(msg)}\n`));
  const reply = (id: number, result: unknown) => emit({ jsonrpc: "2.0", id, result });
  const replyError = (id: number, code: number, message: string) => emit({ jsonrpc: "2.0", id, error: { code, message } });

  const ctx: ExternalDriverContext = {
    binding: { kind, envId: "local" },
    executable: process.execPath,
    cwd,
    inputsDir,
    prompt: "<task id=\"T-1\">Inspect</task>",
    developerInstructions: "You are a specialist.\nWorkspace Mode: staged clone",
    timeoutMs: 10_000,
    readOnly: false,
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
        write: (raw: string) => {
          for (const line of raw.split("\n").filter(Boolean)) {
            const msg = JSON.parse(line) as Record<string, any>;
            sent.push(msg);
            if (!msg.method) {
              if (typeof msg.id === "number") responses.set(msg.id, msg);
              continue;
            }
            const { id, method, params } = msg;
            if (id === undefined) continue;
            if (method === "initialize") {
              if (kind === "codex") reply(id, {});
              else {
                reply(id, {
                  agentCapabilities: {
                    mcpCapabilities: { http: options.acpHttpMcp ?? true },
                    promptCapabilities: { image: options.acpImageCap ?? false },
                    sessionCapabilities: options.acpSystemPromptCap ? { systemPrompt: true } : {},
                  },
                });
              }
            } else if (method === "thread/start" || method === "thread/resume") {
              if (options.rejectGraceOnce && !rejectedGrace && params?.config?.mcp_optional_startup_grace_ms !== undefined) {
                rejectedGrace = true;
                replyError(id, -32600, "unknown field `mcp_optional_startup_grace_ms` in config");
              } else {
                reply(id, { thread: { id: "thread-opt-1" }, model: "gpt-5-codex" });
              }
            } else if (method === "turn/start") {
              reply(id, { turn: { id: "turn-opt-1" } });
            } else if (method === "session/new") {
              reply(id, { sessionId: "acp-opt-1" });
            } else if (method === "session/prompt") {
              reply(id, { stopReason: options.acpStopReason ?? "end_turn" });
            } else {
              reply(id, {});
            }
          }
        },
      };
    },
  };

  return {
    root,
    cwd,
    inputsDir,
    ctx,
    sent,
    responses,
    get spec() { return spec; },
    async request(id: number, method: string, params: unknown) {
      emit({ jsonrpc: "2.0", id, method, params });
      await vi.waitFor(() => expect(responses.has(id)).toBe(true));
      return responses.get(id)!;
    },
  };
}

async function openExternalHubFixture(options: {
  roles: Record<string, RolePreset>;
  capabilities?: string[];
  onRun?: (
    req: Extract<ExternalAgentRequest, { operation: "run" }>,
    defaultAck: () => ExternalAgentResponse,
  ) => Promise<ExternalAgentResponse>;
  inspect?: (run: ExternalAgentRun) => ExternalAgentRun;
}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-ext-opt-hub-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 40 }, () => () => fauxAssistantMessage([fauxText("OK")])));

  const config: KuloHubConfigOverrides = {
    authToken: HUB_TEST_ADMIN_TOKEN,
    stateDir: path.join(directory, "state"),
    identityDir: path.join(directory, "identity"),
    localEnvRoot: path.join(directory, "main-workspace"),
    enableLocalEnv: false,
    envTokens: {},
    watchdogMinutes: 0,
    maxConcurrentWorkers: 2,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
    roles: options.roles,
  };

  let toolHandler: ExternalAgentToolHandler | undefined;
  const origSetHandler = EnvManager.prototype.setExternalAgentToolHandler;
  vi.spyOn(EnvManager.prototype, "setExternalAgentToolHandler").mockImplementation(function (this: EnvManager, handler) {
    if (handler) toolHandler = handler;
    origSetHandler.call(this, handler);
  });

  const hub = await openTestHub({ config, models });
  cleanups.push(() => hub.close());
  if (!toolHandler) throw new Error("Tool handler was not registered");

  const device: EnvNodeDescriptor = {
    id: "computer-a",
    name: "computer-a",
    kind: "reverse-ws",
    executionKind: "pi-env",
    online: true,
    platform: "linux",
    arch: "x64",
    rootDir: path.join(directory, "computer-a"),
    capabilities: options.capabilities ?? ["worker-isolation", ...EXTERNAL_AGENT_NODE_CAPABILITIES],
    connectedAt: 1,
    lastSeenAt: 1,
  };
  fs.mkdirSync(device.rootDir, { recursive: true });
  vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => (id === device.id ? device : undefined));
  vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => [structuredClone(device)]);
  vi.spyOn(hub.envManager, "pickDefaultWorkerEnvId").mockReturnValue(device.id);
  vi.spyOn(hub.envManager, "pickDefaultEnvId").mockReturnValue(device.id);
  vi.spyOn(hub.envManager, "createExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
  vi.spyOn(hub.envManager, "authorizeProjectDirectory").mockImplementation(async (_envId, input) => ({
    projectId: input.projectId,
    workspaceDir: input.path,
    directoryId: `dir:${input.path}`,
    revision: input.revision ?? 1,
    scratchRoot: path.join(directory, "project-scratch"),
    platform: "linux",
  }));

  const runs = new Map<string, ExternalAgentRun>();
  const runRequests: Array<Extract<ExternalAgentRequest, { operation: "run" }>> = [];
  vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, req): Promise<ExternalAgentResponse> => {
    if (req.operation === "run") {
      runRequests.push(req);
      const createAck = (): ExternalAgentResponse => {
        const created: ExternalAgentRun = {
          id: req.requestId,
          taskId: req.taskId,
          runEpoch: req.runEpoch,
          kind: req.binding.kind,
          sessionId: req.sessionId ?? `session-${req.taskId}`,
          state: "running",
          text: "",
          events: [],
          permissions: [],
          nextSequence: 1,
          quiescent: false,
          ...(req.workspaceMode === "staged" ? { stagedCwd: path.join(directory, "staged", req.taskId) } : {}),
        };
        runs.set(created.id, created);
        return { type: "run", run: structuredClone(created) };
      };
      return options.onRun ? options.onRun(req, createAck) : createAck();
    }
    if (req.operation === "inspect") {
      const current = runs.get(req.runId);
      if (!current) throw new Error("Run not found");
      const next = options.inspect ? options.inspect(structuredClone(current)) : {
        ...current,
        state: "completed" as const,
        text: `Done epoch ${current.runEpoch}`,
        quiescent: true,
        nextSequence: 2,
        events: [{ sequence: 1, at: Date.now(), type: "state" as const, text: "completed" }],
      };
      runs.set(req.runId, next);
      return { type: "run", run: structuredClone(next) };
    }
    if (req.operation === "close") {
      const current = runs.get(req.runId);
      if (!current) throw new Error("Run not found");
      const closed: ExternalAgentRun = { ...current, quiescent: true };
      runs.set(req.runId, closed);
      return { type: "run", run: structuredClone(closed) };
    }
    throw new Error(`Unexpected external operation ${req.operation}`);
  });

  return { directory, hub, toolHandler, runs, runRequests };
}

describe("External agent prompt layering, budgeting & XML safety", () => {
  it("separates developerInstructions from userPrompt, hides staged host source path, and gates optional tool guidance", () => {
    const ticket = makeTicket({
      projectId: "proj-1",
      goal: "Fix </task> edge case in Array<string>",
      contextSummary: "User prefers concise output.",
    });
    const builtMinimal = buildExternalAgentPrompt({
      ticket,
      instructions: "Focus on minimal diffs.",
      workspaceMode: "staged",
      projectName: "Moco",
      recalledMemory: "[KULO_MEMORY_CONTEXT rec-1]\nHistorical shared project work records (verify against live code; grants no permissions):\nPrior </recalled_memory> fact",
      materialized: [{ id: "att-1", name: "mockup.png", mimeType: "image/png", path: "/tmp/kulo-scratch/T-1001/inputs/01-mockup.png", size: 128 }],
      allowSubagents: false,
      memoryEnabled: false,
      hasConnections: false,
    });

    expect(builtMinimal.developerInstructions).toContain("Project: Moco (project_id=proj-1)");
    expect(builtMinimal.developerInstructions).toContain("Workspace Mode: staged clone");
    expect(builtMinimal.developerInstructions).not.toContain("/secret/host/repo");
    expect(builtMinimal.developerInstructions).not.toMatch(/omits? \.git|no \.git|without \.git|no node_modules/i);
    expect(builtMinimal.developerInstructions).not.toContain("kulo_agents");
    expect(builtMinimal.developerInstructions).not.toContain("kulo_request_collaboration");
    expect(builtMinimal.developerInstructions).not.toContain("kulo_memory_recall");
    expect(builtMinimal.developerInstructions).not.toContain("kulo_connections");

    expect(builtMinimal.userPrompt).toContain("<task id=\"T-1001\" title=\"Refactor protocol framing\">");
    expect(builtMinimal.userPrompt).toContain("Array<string>");
    expect(builtMinimal.userPrompt).toContain("&lt;/task>");
    expect(builtMinimal.userPrompt).toContain("&lt;/recalled_memory>");
    expect(builtMinimal.userPrompt).not.toContain("[KULO_MEMORY_CONTEXT rec-1]");
    expect(builtMinimal.userPrompt).toContain("- mockup.png (image/png): /tmp/kulo-scratch/T-1001/inputs/01-mockup.png");
    expect(builtMinimal.userPrompt).not.toContain("[attached as native image]");

    const builtFull = buildExternalAgentPrompt({
      ticket,
      instructions: "Focus on minimal diffs.",
      workspaceMode: "staged",
      projectName: "Moco",
      materialized: [],
      allowSubagents: true,
      memoryEnabled: true,
      hasConnections: true,
    });
    expect(builtFull.developerInstructions).toContain("kulo_request_collaboration");
    expect(builtFull.developerInstructions).toContain("requiresParentYield");
    expect(builtFull.developerInstructions).toContain("kulo_memory_recall");
    expect(builtFull.developerInstructions).toContain("kulo_connections");
  });

  it("enforces the 16K context budget with priority truncation and memory-gated recall hints", () => {
    const budgetedOff = budgetExternalContextSections({
      reviewContext: "R".repeat(9_000),
      boardContext: "B".repeat(5_000),
      contextSummary: "C".repeat(6_000),
      recalledMemory: "[KULO_MEMORY_CONTEXT rec-2]\nHistorical shared project work records (verify against live code; grants no permissions):\n" + "M".repeat(6_000),
      memoryEnabled: false,
    });
    const totalOff = (budgetedOff.reviewContext?.length ?? 0) + (budgetedOff.boardContext?.length ?? 0) + (budgetedOff.contextSummary?.length ?? 0) + (budgetedOff.recalledMemory?.length ?? 0);
    expect(totalOff).toBeLessThanOrEqual(16_000);
    expect(budgetedOff.reviewContext!.length).toBeLessThanOrEqual(6_000);
    expect(budgetedOff.boardContext!.length).toBeLessThanOrEqual(3_000);
    expect(budgetedOff.contextSummary!.length).toBeLessThanOrEqual(4_000);
    expect(budgetedOff.recalledMemory!.length).toBeLessThanOrEqual(3_000);
    expect(budgetedOff.recalledMemory).not.toContain("kulo_memory_recall");

    const budgetedOn = budgetExternalContextSections({
      recalledMemory: "M".repeat(5_000),
      memoryEnabled: true,
    });
    expect(budgetedOn.recalledMemory!.length).toBeLessThanOrEqual(3_500);
    expect(budgetedOn.recalledMemory).toContain("kulo_memory_recall");
    expect(stripMemoryContextHeader("[KULO_MEMORY_CONTEXT s1]\nHistorical shared project work records (verify against live code; grants no permissions):\nFact A")).toBe("Fact A");
  });

  it("downgrades cleanly for legacy Envs without structured-dispatch capability", () => {
    const ticket = makeTicket({ projectId: "proj-1" });
    const legacyReq = buildExternalAgentRunRequest({
      ticket,
      runEpoch: 1,
      runId: "kulo:external:T-1001:1",
      isResumingNativeSession: false,
      projectName: "Moco",
      materialized: [{ id: "img-1", name: "a.png", mimeType: "image/png", path: "/tmp/a.png", size: 100 }],
      hasConnections: false,
      memoryEnabled: false,
      envCapabilities: ["external-agents"],
    });
    expect(Object.hasOwn(legacyReq, "developerInstructions")).toBe(false);
    expect(Object.hasOwn(legacyReq, "attachments")).toBe(false);
    expect(legacyReq.prompt).toContain("Workspace Mode: staged clone");
    expect(legacyReq.prompt).toContain("<task id=\"T-1001\"");

    const modernReq = buildExternalAgentRunRequest({
      ticket,
      runEpoch: 1,
      runId: "kulo:external:T-1001:1",
      isResumingNativeSession: false,
      projectName: "Moco",
      materialized: [{ id: "img-1", name: "a.png", mimeType: "image/png", path: "/tmp/a.png", size: 100 }],
      hasConnections: false,
      memoryEnabled: false,
      envCapabilities: ["external-agents", EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY],
    });
    expect(modernReq.developerInstructions).toContain("Workspace Mode: staged clone");
    expect(modernReq.prompt).not.toContain("Workspace Mode: staged clone");
    expect(modernReq.attachments).toHaveLength(1);
    expect(isExternalAgentRequest(modernReq)).toBe(true);
    expect(isExternalAgentRequest({ ...modernReq, developerInstructions: "x".repeat(24_001) })).toBe(false);
    expect(isExternalAgentRequest({ ...modernReq, attachments: Array.from({ length: 9 }, (_, i) => ({ name: `${i}.png`, mimeType: "image/png", path: `/tmp/${i}.png` })) })).toBe(false);
  });
});

describe("Batch 0 delayed ack race & review-pack isolation & Claude resume cache", () => {
  it("reconciles consumed resume state without wiping in-flight steers", () => {
    const live = { resumePrompt: "first\n\nsecond", resumeAttachmentIds: ["a1", "a2"] as string[] | undefined };
    reconcileConsumedResumeState(live, undefined, []);
    expect(live).toEqual({ resumePrompt: "first\n\nsecond", resumeAttachmentIds: ["a1", "a2"] });

    reconcileConsumedResumeState(live, "first", ["a1"]);
    expect(live).toEqual({ resumePrompt: "second", resumeAttachmentIds: ["a2"] });

    reconcileConsumedResumeState(live, "second", ["a2"]);
    expect(live).toEqual({ resumePrompt: undefined, resumeAttachmentIds: undefined });
  });

  it("preserves a steerTicket sent while epoch 1 run ack is in flight and keeps Claude developerInstructions byte-identical across resume", async () => {
    let releaseEpoch1Ack!: () => void;
    const epoch1AckGate = new Promise<void>((resolve) => { releaseEpoch1Ack = resolve; });
    let finishEpoch1 = false;
    let finishEpoch2 = false;

    const claudeRole: RolePreset = {
      id: "claude-code",
      label: "Claude Code",
      whenToUse: "Claude specialist",
      prompt: "Keep edits crisp.",
      enabled: true,
      readOnly: false,
      allowSubagents: false,
      provider: "native",
      modelId: "claude-sonnet",
      external: { kind: "claude-code", envId: "computer-a", verifiedAt: 1_700_000_000_000 },
    };

    const f = await openExternalHubFixture({
      roles: { "claude-code": claudeRole },
      onRun: async (req, defaultAck) => {
        if (req.runEpoch === 1) await epoch1AckGate;
        return defaultAck();
      },
      inspect: (run) => {
        const done = run.runEpoch === 1 ? finishEpoch1 : finishEpoch2;
        if (!done) return run;
        return { ...run, state: "completed", text: `Completed epoch ${run.runEpoch}`, quiescent: true, nextSequence: 2, events: [{ sequence: 1, at: Date.now(), type: "state", text: "completed" }] };
      },
    });

    const projectDir = path.join(f.directory, "demo-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = await f.hub.projects.create({ commandId: "proj-claude", name: "Cache Project", deviceId: "computer-a", workspaceDir: projectDir });

    const card = await f.hub.dispatchTicket({
      commandId: "dispatch-inflight-steer",
      title: "Inflight steer test",
      goal: "Initial goal",
      scope: "src/**",
      role: "claude-code",
      projectId: project.id,
    });

    await vi.waitFor(() => expect(f.runRequests).toHaveLength(1), { timeout: 5000, interval: 20 });

    const steerUpload = f.hub.uploads.saveUpload({
      name: "extra.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("EXTRA_STEER_NOTE", "utf8"),
    });
    // Steer while epoch 1 requestExternalAgent ack is STILL pending!
    await f.hub.steerTicket({
      commandId: "steer-during-ack",
      ticketId: card.id,
      text: "INFLIGHT_STEER_MUST_SURVIVE",
      attachments: [{ id: steerUpload.id }],
    });

    // Now let epoch 1 ack commit and finish epoch 1
    releaseEpoch1Ack();
    await new Promise((r) => setTimeout(r, 80));
    const afterAck = (await f.hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
    expect(afterAck.resumePrompt).toContain("INFLIGHT_STEER_MUST_SURVIVE");
    expect(afterAck.resumeAttachmentIds).toContain(steerUpload.id);

    finishEpoch1 = true;
    await vi.waitFor(() => expect(f.runRequests).toHaveLength(2), { timeout: 6000, interval: 20 });

    const req1 = f.runRequests[0]!;
    const req2 = f.runRequests[1]!;
    expect(req2.runEpoch).toBe(2);
    expect(req2.prompt).toContain("[Follow-up on Ticket");
    expect(req2.prompt).toContain("INFLIGHT_STEER_MUST_SURVIVE");
    expect(req2.prompt).toContain("extra.txt");
    // Byte-identical developerInstructions for Claude Code prompt cache hit!
    expect(req1.developerInstructions).toBeTruthy();
    expect(req1.developerInstructions).toContain(`Project: Cache Project (project_id=${project.id})`);
    expect(req2.developerInstructions).toBe(req1.developerInstructions);

    finishEpoch2 = true;
    await vi.waitFor(async () => {
      const snap = await f.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 5000, interval: 20 });
  });

  it("isolates same-filename review packs from user attachments in inputs/review-<targetId>/", async () => {
    const codexRole: RolePreset = {
      id: "codex-reviewer",
      label: "Codex Reviewer",
      whenToUse: "Independent reviewer",
      prompt: "Review carefully.",
      enabled: true,
      readOnly: true,
      allowSubagents: false,
      provider: "native",
      modelId: "gpt-5-codex",
      external: { kind: "codex", envId: "computer-a", verifiedAt: 1_700_000_000_000 },
    };

    const f = await openExternalHubFixture({ roles: { "codex-reviewer": codexRole } });
    const projectDir = path.join(f.directory, "review-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = await f.hub.projects.create({ commandId: "proj-review", name: "Review Repo", deviceId: "computer-a", workspaceDir: projectDir });

    const targetCard = await f.hub.dispatchTicket({
      commandId: "dispatch-target-1",
      title: "Upstream target",
      goal: "Upstream change",
      scope: "src/**",
      role: "codex-reviewer",
      projectId: project.id,
    });
    await vi.waitFor(async () => {
      const snap = await f.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[targetCard.id]?.status).toBe("ready");
    }, { timeout: 5000, interval: 20 });

    const userSummary = f.hub.uploads.saveUpload({
      name: "summary.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("USER_ATTACHED_SUMMARY_BYTES", "utf8"),
    });

    const reviewCard = await f.hub.dispatchTicket({
      commandId: "dispatch-review-1",
      title: "Review upstream",
      goal: "Audit upstream target",
      scope: "src/**",
      role: "codex-reviewer",
      projectId: project.id,
      reviewTicketId: targetCard.id,
      attachmentIds: [userSummary.id],
    });
    await vi.waitFor(async () => {
      const snap = await f.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[reviewCard.id]?.status).toBe("ready");
    }, { timeout: 5000, interval: 20 });

    const reviewReq = f.runRequests.find((r) => r.taskId === reviewCard.id)!;
    const userPathMatch = reviewReq.prompt.match(/([^\s]+inputs\/01-summary\.md)/);
    const reviewPathMatch = reviewReq.prompt.match(new RegExp(`([^\\s]+inputs/review-${targetCard.id}/[^\\s]+summary\\.md)`));
    expect(userPathMatch).not.toBeNull();
    expect(reviewPathMatch).not.toBeNull();
    expect(fs.readFileSync(userPathMatch![1]!, "utf8")).toBe("USER_ATTACHED_SUMMARY_BYTES");
    expect(fs.readFileSync(reviewPathMatch![1]!, "utf8")).toContain(targetCard.id);
  });

  it("propagates effectiveReadOnly across non-project MCP tools, hides staged host source path, and emits terminal report instruction", async () => {
    let finishParent = false;
    const roles: Record<string, RolePreset> = {
      "ro-codex": {
        id: "ro-codex",
        label: "RO Codex",
        whenToUse: "Read-only audit",
        prompt: "Audit only.",
        enabled: true,
        readOnly: true,
        allowSubagents: true,
        provider: "native",
        modelId: "gpt-5-codex",
        external: { kind: "codex", envId: "computer-a", verifiedAt: 1_700_000_000_000 },
      },
      "rw-claude": {
        id: "rw-claude",
        label: "RW Claude",
        whenToUse: "Writable helper",
        prompt: "Edit code.",
        enabled: true,
        readOnly: false,
        allowSubagents: false,
        provider: "native",
        modelId: "claude-sonnet",
        external: { kind: "claude-code", envId: "computer-a", verifiedAt: 1_700_000_000_000 },
      },
      "ro-claude": {
        id: "ro-claude",
        label: "RO Claude",
        whenToUse: "Read-only helper",
        prompt: "Inspect code.",
        enabled: true,
        readOnly: true,
        allowSubagents: false,
        provider: "native",
        modelId: "claude-sonnet",
        external: { kind: "claude-code", envId: "computer-a", verifiedAt: 1_700_000_000_000 },
      },
    };
    const f = await openExternalHubFixture({
      roles,
      inspect: (run) => (finishParent ? { ...run, state: "completed", text: "ok", quiescent: true, nextSequence: 2, events: [{ sequence: 1, at: Date.now(), type: "state", text: "completed" }] } : run),
    });

    const card = await f.hub.dispatchTicket({
      commandId: "dispatch-ro-parent",
      title: "Read-only parent",
      goal: "Inspect files only",
      scope: "**",
      role: "ro-codex",
    });
    await vi.waitFor(() => expect(f.runRequests).toHaveLength(1), { timeout: 5000, interval: 20 });
    const req = f.runRequests[0]!;
    expect(req.readOnly).toBe(true);

    const ctxResult = await f.toolHandler({
      envId: "computer-a",
      runId: req.requestId,
      taskId: card.id,
      runEpoch: 1,
      cwd: req.cwd,
      allowSubagents: true,
      name: "kulo_task_context",
      args: {},
    }) as Record<string, unknown>;
    expect(ctxResult.readOnly).toBe(true);

    const agentsResult = await f.toolHandler({
      envId: "computer-a",
      runId: req.requestId,
      taskId: card.id,
      runEpoch: 1,
      cwd: req.cwd,
      allowSubagents: true,
      name: "kulo_agents",
      args: {},
    }) as { agents: Array<{ id: string; readOnly: boolean }> };
    expect(agentsResult.agents.map((a) => a.id)).toContain("ro-claude");
    expect(agentsResult.agents.map((a) => a.id)).not.toContain("rw-claude");

    await expect(f.toolHandler({
      envId: "computer-a",
      runId: req.requestId,
      taskId: card.id,
      runEpoch: 1,
      cwd: req.cwd,
      allowSubagents: true,
      name: "kulo_request_collaboration",
      args: { request_id: "try-write", agent_id: "rw-claude", goal: "Modify files" },
    })).rejects.toMatchObject({ code: "external_collaboration_target_denied" });

    const reportResult = await f.toolHandler({
      envId: "computer-a",
      runId: req.requestId,
      taskId: card.id,
      runEpoch: 1,
      cwd: req.cwd,
      allowSubagents: true,
      name: "kulo_task_report",
      args: { state: "ready", summary: "Audit complete" },
    }) as Record<string, unknown>;
    expect(String(reportResult.instruction ?? "")).toContain("End your turn immediately");

    finishParent = true;
    await vi.waitFor(async () => {
      const snap = await f.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 5000, interval: 20 });

    // Staged project ticket: kulo_task_context exposes stagedCwd as workspaceDir instead of host source path
    let finishStaged = false;
    const fStaged = await openExternalHubFixture({
      roles: { "rw-claude": roles["rw-claude"]! },
      inspect: (run) => (finishStaged ? { ...run, state: "completed", text: "ok", quiescent: true, nextSequence: 2, events: [{ sequence: 1, at: Date.now(), type: "state", text: "completed" }] } : run),
    });
    const hostProjectDir = path.join(fStaged.directory, "host-source-repo");
    fs.mkdirSync(hostProjectDir, { recursive: true });
    const stagedProj = await fStaged.hub.projects.create({ commandId: "proj-staged-ctx", name: "Staged Repo", deviceId: "computer-a", workspaceDir: hostProjectDir });
    const stagedCard = await fStaged.hub.dispatchTicket({
      commandId: "dispatch-staged-ctx",
      title: "Staged context test",
      goal: "Check staged workspaceDir",
      scope: "src/**",
      role: "rw-claude",
      projectId: stagedProj.id,
    });
    await vi.waitFor(() => expect(fStaged.runRequests).toHaveLength(1), { timeout: 5000, interval: 20 });
    await vi.waitFor(async () => {
      const snap = await fStaged.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[stagedCard.id]?.externalExecution?.stagedCwd).toBeTruthy();
    }, { timeout: 5000, interval: 20 });
    const stagedReq = fStaged.runRequests[0]!;
    const stagedCtx = await fStaged.toolHandler({
      envId: "computer-a",
      runId: stagedReq.requestId,
      taskId: stagedCard.id,
      runEpoch: 1,
      cwd: stagedReq.cwd,
      allowSubagents: false,
      name: "kulo_task_context",
      args: {},
    }) as Record<string, unknown>;
    expect(stagedCtx.workspaceDir).toBe(stagedCtx.stagedCwd);
    expect(stagedCtx.workspaceDir).not.toBe(hostProjectDir);
    finishStaged = true;
    await vi.waitFor(async () => {
      const snap = await fStaged.hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[stagedCard.id]?.status).toBe("ready");
    }, { timeout: 5000, interval: 20 });
  });
});

describe("Drivers, safe multimodal images & MCP server hardening", () => {
  it("handles Codex dotted MCP config, -32600 grace fallback, read-only sandbox & approval denial, localImage, and resume without duplicate instructions", async () => {
    const f = mockDriverFixture("codex", { rejectGraceOnce: true });
    const imgPath = path.join(f.inputsDir, "01-screen.png");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    fs.writeFileSync(imgPath, pngBytes);
    const sha256 = createHash("sha256").update(pngBytes).digest("hex");

    f.ctx.readOnly = true;
    f.ctx.servers = [{ name: "kulo-task", url: "http://127.0.0.1:44444/mcp", headers: [{ name: "Authorization", value: "Bearer tok" }] }];
    f.ctx.attachments = [{ id: "img-1", name: "screen.png", mimeType: "image/png", path: imgPath, size: pngBytes.length, sha256 }];

    const res1 = await connectCodex(f.ctx);
    const threadStarts = f.sent.filter((m) => m.method === "thread/start");
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[0]!.params.config.mcp_optional_startup_grace_ms).toBe(10_000);
    expect(threadStarts[1]!.params.config.mcp_optional_startup_grace_ms).toBeUndefined();
    expect(threadStarts[1]!.params.config["mcp_servers.kulo-task"]).toEqual({
      enabled: true,
      url: "http://127.0.0.1:44444/mcp",
      http_headers: { Authorization: "Bearer tok" },
    });

    const turnStart1 = f.sent.find((m) => m.method === "turn/start")!;
    expect(turnStart1.params.sandboxPolicy).toEqual({ type: "readOnly" });
    expect(turnStart1.params.sandboxPolicy.networkAccess).toBeUndefined();
    expect(turnStart1.params.input[0].text).toContain("<kulo_instructions>");
    expect(turnStart1.params.input[1]).toEqual({ type: "localImage", path: fs.realpathSync(imgPath) });

    // Read-only auto-declines fileChange and write-escalating permissions without calling ctx.permission
    const fcResp = await f.request(901, "item/fileChange/requestApproval", { threadId: "thread-opt-1", availableDecisions: ["accept", "decline"] });
    expect(fcResp.result).toEqual({ decision: "decline" });
    const permResp = await f.request(902, "item/permissions/requestApproval", {
      threadId: "thread-opt-1",
      permissions: { fileSystem: { write: [f.cwd] } },
    });
    expect(permResp.result).toEqual({ permissions: {}, scope: "turn" });
    expect(f.ctx.permission).not.toHaveBeenCalled();
    res1.driver.close();

    // Resume turn (sessionId set) must NOT prepend <kulo_instructions> again and keeps fixed MCP key
    const f2 = mockDriverFixture("codex");
    f2.ctx.sessionId = "thread-opt-1";
    f2.ctx.servers = [{ name: "kulo-task", url: "http://127.0.0.1:44445/mcp" }];
    f2.ctx.prompt = "[Follow-up on Ticket T-1: Test]\nCheck edge cases";
    const res2 = await connectCodex(f2.ctx);
    const resumeMsg = f2.sent.find((m) => m.method === "thread/resume")!;
    expect(resumeMsg.params.config["mcp_servers.kulo-task"]).toBeDefined();
    const turnStart2 = f2.sent.find((m) => m.method === "turn/start")!;
    expect(turnStart2.params.input[0].text).not.toContain("<kulo_instructions>");
    res2.driver.close();
  });

  it("configures Claude Code with snapshot systemPrompt.append, fixed MCP name, and non-project readOnly disallowedTools", async () => {
    const f = mockDriverFixture("codex");
    f.ctx.binding.kind = "claude-code";
    f.ctx.readOnly = true;
    f.ctx.workspaceMode = undefined;
    f.ctx.servers = [{ name: "kulo-task", url: "http://127.0.0.1:44446/mcp" }];

    const opts = nativeClaudeOptions(f.ctx);
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: f.ctx.developerInstructions,
      snapshot: true,
    });
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["kulo-task"]);
    expect(opts.disallowedTools).toEqual(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
    const editDecision = await opts.canUseTool!("Edit", { file_path: "a.ts" }, { toolUseID: "tu-1", signal: new AbortController().signal });
    expect(editDecision).toMatchObject({ behavior: "deny" });
  });

  it("rejects symlinks, traversal, size/sha256 mismatches, and enforces ACP 4 MiB total image cap & systemPrompt capability", async () => {
    const f = mockDriverFixture("dsh", { acpImageCap: true, acpSystemPromptCap: true, acpHttpMcp: false, acpStopReason: "max_tokens" });
    const outsideFile = path.join(f.root, "secret.png");
    fs.writeFileSync(outsideFile, Buffer.alloc(64, 1));
    const symlinkFile = path.join(f.inputsDir, "01-link.png");
    fs.symlinkSync(outsideFile, symlinkFile);

    const good1 = path.join(f.inputsDir, "02-good1.png");
    const good1Bytes = Buffer.alloc(2.5 * 1024 * 1024, 2);
    fs.writeFileSync(good1, good1Bytes);
    const good2 = path.join(f.inputsDir, "03-good2.png");
    const good2Bytes = Buffer.alloc(2.5 * 1024 * 1024, 3);
    fs.writeFileSync(good2, good2Bytes);

    const skipped: string[] = [];
    const safe = resolveSafeExternalImages({
      attachments: [
        { name: "link.png", mimeType: "image/png", path: symlinkFile },
        { name: "outside.png", mimeType: "image/png", path: outsideFile },
        { name: "bad-sha.png", mimeType: "image/png", path: good1, size: good1Bytes.length, sha256: "0".repeat(64) },
        { name: "good1.png", mimeType: "image/png", path: good1, size: good1Bytes.length, sha256: createHash("sha256").update(good1Bytes).digest("hex") },
        { name: "good2.png", mimeType: "image/png", path: good2, size: good2Bytes.length, sha256: createHash("sha256").update(good2Bytes).digest("hex") },
      ],
      expectedInputsDir: f.inputsDir,
      maxCount: 4,
      maxFileBytes: 3 * 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      readBytes: true,
      onSkip: (reason) => skipped.push(reason),
    });
    expect(safe).toHaveLength(1);
    expect(safe[0]!.name).toBe("good1.png");
    expect(skipped.some((s) => s.includes("symlinks"))).toBe(true);
    expect(skipped.some((s) => s.includes("outside authorized"))).toBe(true);
    expect(skipped.some((s) => s.includes("digest mismatch"))).toBe(true);
    expect(skipped.some((s) => s.includes("byte budget"))).toBe(true);

    // ACP driver: uses sessionCapabilities.systemPrompt, attaches 1st image (drops 2nd under 4 MiB total cap), notes missing HTTP MCP, and logs max_tokens early stop
    f.ctx.servers = [{ name: "kulo-task", url: "http://127.0.0.1:44447/mcp" }];
    f.ctx.attachments = [
      { name: "good1.png", mimeType: "image/png", path: good1, size: good1Bytes.length },
      { name: "good2.png", mimeType: "image/png", path: good2, size: good2Bytes.length },
    ];
    const acpRes = await connectAcp(f.ctx);
    await vi.waitFor(() => expect(f.ctx.complete).toHaveBeenCalledWith("completed", expect.stringContaining("max_tokens")));
    const sessionNew = f.sent.find((m) => m.method === "session/new")!;
    expect(sessionNew.params.systemPrompt).toEqual({ mode: "append", text: f.ctx.developerInstructions });
    expect(sessionNew.params.mcpServers).toEqual([]);
    const promptCall = f.sent.find((m) => m.method === "session/prompt")!;
    expect(promptCall.params.prompt[0].text).not.toContain("<kulo_instructions>");
    expect(promptCall.params.prompt[0].text).toContain("HTTP MCP tools are unavailable");
    expect(promptCall.params.prompt.filter((b: { type: string }) => b.type === "image")).toHaveLength(1);
    expect((f.ctx.event as ReturnType<typeof vi.fn>).mock.calls.some(([t, msg]) => t === "state" && String(msg).includes("max_tokens"))).toBe(true);
    acpRes.driver.close();
  });

  it("allows 25,000-char CJK deliverable within MCP 256 KiB BODY_LIMIT and dynamically builds initialize.instructions", async () => {
    let receivedDeliverableLen = 0;
    const mcp = await startExternalAgentMcp({
      runId: "run-1",
      taskId: "T-1",
      runEpoch: 1,
      cwd: os.tmpdir(),
      allowSubagents: false,
      memoryEnabled: false,
      hasConnections: false,
      handler: async (inv) => {
        receivedDeliverableLen = String(inv.args.deliverable ?? "").length;
        return { recorded: true };
      },
    });
    cleanups.push(() => mcp.close());

    const post = async (body: unknown) => {
      const res = await fetch(mcp.server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: mcp.server.headers[0]!.value,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as Record<string, any> };
    };

    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.status).toBe(200);
    expect(init.json.result.instructions).not.toContain("kulo_request_collaboration");
    expect(init.json.result.instructions).not.toContain("kulo_memory_");
    expect(init.json.result.instructions).not.toContain("kulo_connections");

    const bigCjk = "测试报告内容".repeat(4_500); // 27,000 CJK chars ≈ 81 KiB UTF-8 (> old 64 KiB limit!)
    const report = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "kulo_task_report", arguments: { state: "ready", summary: "完成", deliverable: bigCjk } },
    });
    expect(report.status).toBe(200);
    expect(report.json.error).toBeUndefined();
    expect(receivedDeliverableLen).toBe(bigCjk.length);
  });
});
