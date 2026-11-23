import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import {
  defaultRolePresets,
  inspectSensitiveText,
  type HindsightMemoryConfig,
  type RolePreset,
  type TicketRecord,
} from "@kulo/protocol";
import {
  composeSubagentInstructions,
  composeWorkerInstructions,
  createWorkerSections,
  formatWorkerInitialPrompt,
} from "../packages/hub/src/prompts/worker.js";
import { createComputerUseTools, type ComputerUseScope } from "../packages/hub/src/tools-computer-use.js";
import { createConnectionTools, type ConnectionToolController } from "../packages/hub/src/tools-connections.js";
import { createWorkerExtension } from "../packages/hub/src/tools-worker.js";
import { resolveSurfaceTools, type ToolSurfaceRuntimeState } from "../packages/hub/src/tool-surface.js";
import { createMemoryLifecycleExtension, MemoryContextEntry, MemoryLifecycleDoc } from "../packages/hub/src/memory-lifecycle.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "T-0042",
    commandId: "cmd-42",
    title: "Worker alignment check",
    goal: "Verify prompt alignment",
    scope: "packages/hub",
    status: "running",
    role: "coder",
    readOnly: false,
    envId: "local",
    workspaceDir: "/tmp/repo",
    scratchDir: "/tmp/scratch/T-0042",
    workerConversationId: 10,
    runEpoch: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("Built-in Worker & Subagent template alignment (v2)", () => {
  it("keeps kulo_worker_mandate byte-identical across tool_search loads and exposes dynamic discovery accurately", async () => {
    const provider = fauxProvider({ provider: "openai", models: [{ id: "m" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const workerExt = createWorkerExtension({
      getIdentityDir: () => "/nonexistent",
      getMemoryConfig: () => ({ enabled: false }) as never,
      getRoles: () => defaultRolePresets("en"),
      computerUse: {
        scope: async () => ({
          ticketId: "T-0042",
          conversationId: 1,
          runEpoch: 1,
          envId: "local",
          readOnly: false,
          assertActive: async () => {},
        }),
        execute: async () => ({ tool: "browser", action: "status", ok: true }),
        requestHandoff: async () => ({ requestId: "r1", expiresAt: Date.now() + 60_000 }),
      },
      hostActions: {
        inspect: async () => ({}),
        run: async () => ({}),
        decide: async () => ({}),
      },
    });
    const registry = createRegistry();
    registry.install(workerExt);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    const surfaceState: ToolSurfaceRuntimeState = {
      audience: "computer-worker",
      memoryEnabled: false,
      sharedMemoryEnabled: false,
      ttsEnabled: false,
      webSearchAvailable: false,
      customizationEnabled: false,
      deviceInviteAvailable: false,
      computerUseBrowserEnabled: true,
      computerUseDesktopEnabled: false,
      readOnly: false,
      allowSubagents: true,
    };
    const surfaceTools = resolveSurfaceTools(workerExt.tools ?? [], surfaceState);
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "openai", modelId: "m" },
          extensions: [workerExt],
          tools: surfaceTools,
        },
      },
      BACKGROUND_CONTEXT,
    );
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-0042"] = makeTicket({ workerConversationId: Number(conv.id) });
      state.conversationToTicket[String(conv.id)] = "T-0042";
    }, BACKGROUND_CONTEXT);

    const renderMandate = async () => {
      const agent = await conv.agent(BACKGROUND_CONTEXT);
      return agent.sections
        .find((s) => s.key === "kulo_worker_mandate")!
        .render(
          { conversationId: conv.id, agent, env: undefined, shown: {}, read: harness },
          BACKGROUND_CONTEXT,
        );
    };

    const beforeLoad = await renderMandate();
    expect(beforeLoad).toContain("kulo_computer_handoff");
    expect(beforeLoad).toContain("kulo_browser");
    expect(beforeLoad).toContain("kulo_host_action");
    expect(beforeLoad).not.toContain("kulo_desktop");
    expect(beforeLoad).not.toContain("advanced shared memory");
    expect(beforeLoad).not.toContain("TTS");
    expect(beforeLoad).not.toContain("never shown directly to the end user");
    expect(beforeLoad).toContain("Prefer solving small, self-contained lookups or edits directly");
    expect(beforeLoad).toContain("PARTIAL WRITE WARNING");

    // Simulate tool_search activating deferred tools into modelTools.add -> union stays identical
    const loadedTools = surfaceTools.filter(
      (t) => t.name === "kulo_browser" || t.name === "kulo_computer_handoff",
    );
    await conv.configure(
      { modelTools: { add: loadedTools } },
      BACKGROUND_CONTEXT,
    );
    const afterLoad = await renderMandate();
    expect(afterLoad).toBe(beforeLoad);

    // Simulate compaction pruning idle deferred tools -> union still identical
    await conv.configure({ modelTools: { add: [] } }, BACKGROUND_CONTEXT);
    const afterPrune = await renderMandate();
    expect(afterPrune).toBe(beforeLoad);
  });

  it("restricts kulo_computer_handoff and kulo_connection_request at both tool-surface and runtime layers", async () => {
    const baseState: Omit<ToolSurfaceRuntimeState, "audience" | "readOnly"> = {
      memoryEnabled: false,
      sharedMemoryEnabled: false,
      ttsEnabled: false,
      webSearchAvailable: false,
      customizationEnabled: false,
      deviceInviteAvailable: false,
      computerUseBrowserEnabled: true,
      computerUseDesktopEnabled: true,
      allowSubagents: false,
    };
    const mockTools = [
      { name: "kulo_browser", deferred: true },
      { name: "kulo_computer_handoff", deferred: true },
      { name: "kulo_connections", deferred: true },
      { name: "kulo_connection_request", deferred: true },
    ] as never;

    const namesFor = (audience: ToolSurfaceRuntimeState["audience"], readOnly: boolean) =>
      resolveSurfaceTools(mockTools, { ...baseState, audience, readOnly }).map((t) => t.name);

    expect(namesFor("computer-worker", false)).toEqual(
      expect.arrayContaining(["kulo_computer_handoff", "kulo_connection_request"]),
    );
    expect(namesFor("computer-worker", true)).not.toContain("kulo_computer_handoff");
    expect(namesFor("computer-worker", true)).toContain("kulo_connection_request");
    expect(namesFor("computer-subagent", false)).not.toContain("kulo_computer_handoff");
    expect(namesFor("computer-subagent", false)).not.toContain("kulo_connection_request");

    // Runtime double-insurance: writable Subagent rejected by kulo_computer_handoff
    const requestHandoff = vi.fn(async () => ({ requestId: "r1", expiresAt: Date.now() + 60_000 }));
    const subScope: ComputerUseScope = {
      ticketId: "T-0042",
      conversationId: 99,
      runEpoch: 1,
      envId: "local",
      readOnly: false,
      isSubagent: true,
      assertActive: async () => {},
    };
    const compTools = createComputerUseTools({
      scope: async () => subScope,
      execute: async () => ({ tool: "browser", action: "status", ok: true }),
      requestHandoff,
    });
    const handoff = compTools.find((t) => t.name === "kulo_computer_handoff")!;
    const handoffRes = await handoff.execute({ target: "browser", reason: "login" }, { callId: "c1" } as never, BACKGROUND_CONTEXT);
    expect(handoffRes.isError).toBe(true);
    expect(requestHandoff).not.toHaveBeenCalled();

    // Runtime double-insurance: writable Subagent rejected by kulo_connection_request
    const controller: ConnectionToolController = {
      list: vi.fn(async () => ({})),
      describe: vi.fn(async () => ({})),
      request: vi.fn(async () => ({ status: "pending" })),
      decide: vi.fn(async () => ({})),
      grant: vi.fn(async () => ({})),
      use: vi.fn(async () => ({})),
    };
    const connTools = createConnectionTools(controller, "worker");
    const reqTool = connTools.find((t) => t.name === "kulo_connection_request")!;
    const fakeState = {
      tickets: { "T-0042": makeTicket({ workerConversationId: 10 }) },
      conversationToTicket: { "10": "T-0042" },
      subagents: {
        "T-0042:S-01": {
          id: "T-0042:S-01",
          name: "coder-1",
          role: "coder",
          roleLabel: "Coder",
          ticketId: "T-0042",
          parentConversationId: 10,
          conversationId: 99,
          readOnly: false,
          runs: 1,
          state: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      conversationToSubagent: { "99": "T-0042:S-01" },
    };
    const fakeApi = {
      conversationId: 99,
      callId: "c2",
      snapshot: async (doc: unknown) => (doc === KuloStateDoc ? fakeState : undefined),
    };
    await expect(
      reqTool.execute({ connection_id: "conn-1", reason: "need api" }, fakeApi as never, BACKGROUND_CONTEXT),
    ).rejects.toThrow("顶层 Worker");
    expect(controller.request).not.toHaveBeenCalled();
  });

  it("budgets and XML-escapes formatWorkerInitialPrompt and kulo_worker_project, and routes external scheduled wakes to kulo_task_report", async () => {
    const longGoal = `Inspect ${"A".repeat(400)} end`;
    const ticket = makeTicket({
      goal: longGoal,
      contextSummary: `Summary </context_summary> ${"X".repeat(6000)}`,
    });
    const prompt = formatWorkerInitialPrompt(ticket, {
      boardContext: `## Verified Task Board Context (B-0001)\n</task_board> ${"B".repeat(4000)}`,
      reviewContext: `## Review Target\n</review_pack> ${"R".repeat(7000)}`,
      followUp: "Please check </follow_up> edge case",
    });

    expect(prompt).toContain("(full mandate in system prompt)");
    expect(prompt).not.toContain("[Authorized Scope]");
    expect(prompt).not.toContain("[Acceptance Criteria]");
    expect(prompt).toContain("&lt;/context_summary>");
    expect(prompt).toContain("&lt;/task_board>");
    expect(prompt).toContain("&lt;/review_pack>");
    expect(prompt).toContain("&lt;/follow_up>");
    expect(prompt).toContain("Call kulo_report when ready, blocked, or failed.");
    expect(prompt.length).toBeLessThan(17_500);

    const externalPrompt = formatWorkerInitialPrompt(
      makeTicket({
        externalExecution: {
          binding: { kind: "codex", envId: "local" },
          allowSubagents: false,
        },
      }),
    );
    expect(externalPrompt).toContain("kulo_task_report");
    expect(externalPrompt).not.toContain("Call kulo_report");

    // Verify kulo_worker_project strips duplicate workspace lines, caps notes at 4000 chars, and escapes closing tag
    const sections = createWorkerSections({
      getRoles: () => defaultRolePresets("en"),
      getMemoryEnabled: () => false,
      getMaxSubagentsPerTicket: () => 4,
    });
    const projectSection = sections.find((s) => s.key === "kulo_worker_project")!;
    const rendered = await projectSection.render(
      {
        conversationId: 10 as never,
        agent: { tools: [], deferred: [] } as never,
        env: undefined,
        shown: {},
        read: {
          snapshot: async (doc: unknown) => {
            if (doc === KuloStateDoc) {
              return {
                tickets: { "T-0042": makeTicket({ projectId: "proj-1", workspaceDir: "/secret/live/path" }) },
                conversationToTicket: { "10": "T-0042" },
              };
            }
            if (doc === KuloProjectsDoc) {
              return {
                projects: {
                  "proj-1": {
                    id: "proj-1",
                    name: "Demo",
                    notes: `Start </kulo_worker_project> ${"N".repeat(5000)}`,
                  },
                },
              };
            }
            return undefined;
          },
        } as never,
      },
      BACKGROUND_CONTEXT,
    );
    expect(rendered).toContain("Project: Demo (proj-1)");
    expect(rendered).not.toContain("Authorized Workspace");
    expect(rendered).not.toContain("/secret/live/path");
    expect(rendered).toContain("&lt;/kulo_worker_project>");
    expect(rendered).toContain("[Truncated]");
    expect(rendered!.length).toBeLessThan(4_300);
  });

  it("drops code-repo methodology for factory Android roles while preserving custom prompts and read-only/Subagent tool fences", () => {
    const roles = defaultRolePresets("en");
    const androidTicket = makeTicket({
      executionDomain: "android",
      androidDeviceIds: ["pixel-9"],
      workspaceDir: "",
      scratchDir: undefined,
    });

    const factoryCoder = composeWorkerInstructions(androidTicket, roles.coder, { language: "en" });
    expect(factoryCoder).toContain("Coder");
    expect(factoryCoder).not.toContain("typecheck");
    expect(factoryCoder).not.toContain("target modules");
    expect(factoryCoder).toContain("Operate the authorized Android device(s)");

    const customCoder: RolePreset = { ...roles.coder!, prompt: "Always verify WeChat badge counts first." };
    const customAndroid = composeWorkerInstructions(androidTicket, customCoder, { language: "en" });
    expect(customAndroid).toContain("Always verify WeChat badge counts first.");

    const readOnlyAndroid = composeWorkerInstructions(
      { ...androidTicket, readOnly: true },
      roles.scout,
      { language: "en" },
    );
    expect(readOnlyAndroid).not.toContain("android_open");
    expect(readOnlyAndroid).not.toContain("android_tap");
    expect(readOnlyAndroid).not.toContain("android_handoff");

    const writableAndroidSub = composeSubagentInstructions({
      parentTicket: androidTicket,
      subagentId: "T-0042:S-01",
      subagentName: "phone-1",
      rolePreset: roles.coder,
      roleId: "coder",
      effectiveReadOnly: false,
      language: "en",
    });
    expect(writableAndroidSub).not.toContain("typecheck");
    expect(writableAndroidSub).not.toContain("android_handoff");

    // Read-only computer worker must never be invited to call host_action `run`, TTS, export, or handoff
    const readOnlyComputer = composeWorkerInstructions(
      makeTicket({ readOnly: true }),
      roles.checker,
      {
        language: "en",
        memoryEnabled: false,
        enabledTools: new Set(["read", "bash", "kulo_host_action", "kulo_synthesize_speech", "kulo_media_export", "kulo_computer_handoff"]),
      },
    );
    expect(readOnlyComputer).toContain("action='inspect'");
    expect(readOnlyComputer).not.toContain("one `run` call");
    expect(readOnlyComputer).not.toContain("kulo_computer_handoff");
    expect(readOnlyComputer).not.toContain("TTS");
    expect(readOnlyComputer).not.toContain("export");
    expect(readOnlyComputer).not.toContain("advanced shared memory");
  });

  it("propagates Cross-Device Guard, Truthfulness, $HOME rules, and scoped Tool Discovery to Subagents", () => {
    const roles = defaultRolePresets("en");
    const subPrompt = composeSubagentInstructions({
      parentTicket: makeTicket({
        envId: "local",
        senderSource: { deviceId: "macbook-pro", name: "MacBook Pro" },
      }),
      subagentId: "T-0042:S-01",
      subagentName: "repo-scout",
      rolePreset: roles.scout,
      roleId: "scout",
      effectiveReadOnly: true,
      memoryEnabled: false,
      language: "en",
      localEnvId: "local",
      enabledTools: new Set(["read", "bash", "kulo_host_action", "kulo_browser", "kulo_computer_handoff", "kulo_connection_request"]),
    });

    expect(subPrompt).toContain("Cross-Device Guard");
    expect(subPrompt).toContain("MacBook Pro");
    expect(subPrompt).toContain("Never fabricate uninspected file contents");
    expect(subPrompt).toContain("$KULO_HOST_HOME");
    expect(subPrompt).toContain("kulo_host_action");
    expect(subPrompt).toContain("kulo_browser");
    expect(subPrompt).not.toContain("kulo_computer_handoff");
    expect(subPrompt).not.toContain("kulo_connection_request");
    expect(subPrompt).not.toContain("kulo_report");
    expect(subPrompt).not.toContain("kulo_subagent");
  });

  it("persists a TIMEOUT receipt on slow Hindsight beforeRequest recall so subsequent turns in the same epoch skip in 0ms", async () => {
    let recallHits = 0;
    let hangRecall = true;
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      const url = new URL(req.url!, "http://127.0.0.1");
      const token = req.headers.authorization?.replace("Bearer ", "");
      const role = token === "memory-router-test-00000000000000001" ? "router" : token === "memory-worker-test-00000000000000001" ? "worker" : "anonymous";
      if (url.pathname === "/v1/kulo/access") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          policyVersion: 1,
          role,
          banks: {
            private: { id: "private-bank", read: role === "router", write: role === "router" },
            shared: { id: "shared-bank", read: true, write: role === "worker" },
          },
        }));
        return;
      }
      if (url.pathname === "/v1/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "1.2.1" }));
        return;
      }
      const shared = url.pathname.includes("/shared-bank/");
      if (!shared && role !== "router") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      if (url.pathname.endsWith("/documents")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      if (url.pathname.endsWith("/memories/recall")) {
        recallHits += 1;
        if (hangRecall) {
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ results: [{ id: "m1", text: "late result" }] }));
            }
          }, 2_000);
          req.on("close", () => clearTimeout(timer));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [{ id: "m2", document_id: "d2", text: "recovered memory", tags: ["project:p1"], type: "experience" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const config: HindsightMemoryConfig = {
      enabled: true,
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      endpoints: [],
      caCertPem: "",
      routerApiKey: "memory-router-test-00000000000000001",
      workerApiKey: "memory-worker-test-00000000000000001",
      routerApiKeyEnv: "",
      workerApiKeyEnv: "",
      authFile: "",
      autoAttachTopLevelRouters: false,
      banks: { private: "private-bank", shared: "shared-bank" },
    };

    const provider = fauxProvider({ provider: "openai", models: [{ id: "m" }] });
    provider.setResponses([
      fauxAssistantMessage([fauxText("turn-1-ok")]),
      fauxAssistantMessage([fauxText("turn-2-ok")]),
      fauxAssistantMessage([fauxText("epoch-2-ok")]),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    let harness!: Harness;
    const memory = createMemoryLifecycleExtension({
      getHarness: () => harness,
      getMemoryConfig: () => config,
      recallTimeoutMs: 250,
    });
    const worker = createWorkerExtension({ getIdentityDir: () => "/nonexistent", getMemoryConfig: () => config });
    const registry = createRegistry();
    registry.install(worker);
    registry.install(memory);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "openai", modelId: "m" }, extensions: [worker, memory] },
      },
      BACKGROUND_CONTEXT,
    );
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-TIMEOUT"] = makeTicket({
        id: "T-TIMEOUT",
        projectId: "p1",
        workerConversationId: Number(conv.id),
        runEpoch: 1,
      });
      state.conversationToTicket[String(conv.id)] = "T-TIMEOUT";
    }, BACKGROUND_CONTEXT);

    // Turn 1 times out softly after ~250ms and persists TIMEOUT receipt
    const t0 = Date.now();
    await (await conv.submit({ type: "input", content: "first turn" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(recallHits).toBe(1);
    const snap1 = await harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT);
    const key1 = `worker-start:${conv.id}:T-TIMEOUT:1`;
    expect(snap1?.recalls[key1]).toMatchObject({ text: "", error: "TIMEOUT" });

    // Even after server recovers, Turn 2 in the SAME runEpoch must NOT hit Hindsight or inject MemoryContextEntry
    hangRecall = false;
    await (await conv.submit({ type: "input", content: "second turn same epoch" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    expect(recallHits).toBe(1);
    const entriesAfterTurn2 = await conv.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    expect(entriesAfterTurn2.items.some((e) => e.kind === MemoryContextEntry.kind)).toBe(false);

    // Next runEpoch (2) uses a fresh sourceId and recalls normally
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-TIMEOUT"]!.runEpoch = 2;
    }, BACKGROUND_CONTEXT);
    await (await conv.submit({ type: "input", content: "epoch 2 turn" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    expect(recallHits).toBe(2);
    const snap2 = await harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT);
    expect(snap2?.recalls[`worker-start:${conv.id}:T-TIMEOUT:2`]?.text).toContain("recovered memory");
  });

  it("never triggers sensitive-text false positives across all 6 built-in roles with full enabledTools", () => {
    const roles = defaultRolePresets("en");
    const enabledTools = new Set([
      "read",
      "write",
      "edit",
      "bash",
      "tool_search",
      "kulo_host_action",
      "kulo_browser",
      "kulo_desktop",
      "kulo_computer_handoff",
      "kulo_generate_image",
      "kulo_synthesize_speech",
      "kulo_media_export",
      "kulo_connections",
      "kulo_connection_use",
      "kulo_connection_request",
      "kulo_publish_asset",
      "kulo_skill_materialize",
      "hindsight_recall",
      "hindsight_search_pages",
    ]);
    const ticket = makeTicket({
      title: "保存检查记录",
      goal: "检查项目并保存执行结果。",
      scope: "检查当前模块，将较长记录保存到工单草稿箱。",
      acceptance: "报告实际运行的检查。",
      assignment: "不能通过文件搜索获取其他账号的 SSH 权限；凭据由主模型分配。",
      senderSource: { deviceId: "laptop-1", name: "MacBook" },
    });
    for (const [roleId, preset] of Object.entries(roles)) {
      const parent = composeWorkerInstructions(ticket, preset, {
        roles,
        memoryEnabled: true,
        maxSubagentsPerTicket: 4,
        enabledTools,
      });
      const child = composeSubagentInstructions({
        parentTicket: ticket,
        subagentId: "T-0042:S-01",
        subagentName: `${roleId}-1`,
        rolePreset: preset,
        roleId,
        effectiveReadOnly: Boolean(preset.readOnly),
        memoryEnabled: true,
        enabledTools,
      });
      for (const prompt of [parent, child]) {
        const inspected = inspectSensitiveText(prompt);
        expect(inspected.secrets).toEqual([]);
        expect(inspected.customCredential).toBeUndefined();
      }
    }
  });
});
