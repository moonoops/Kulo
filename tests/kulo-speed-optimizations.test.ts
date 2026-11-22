import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type {
  EnvNodeDescriptor,
  HindsightMemoryConfig,
  TicketCardView,
  TicketRecord,
} from "@kulo/protocol";
import { createOrchestratorToolsExtension } from "../packages/hub/src/tools-router.js";
import { MemoryLlmBridge } from "../packages/hub/src/memory-llm-bridge.js";
import { createMemoryLifecycleExtension, MemoryLifecycleDoc } from "../packages/hub/src/memory-lifecycle.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

describe("Kulo speed optimization invariants (WS-2 / WS-3 / WS-4)", () => {
  it("projects compact kulo_status output, prioritizes pendingWorkspaceApply over plain ready, and honors limit/include_closed", async () => {
    const longSummary = "摘要".repeat(200);
    const makeTicket = (id: string, overrides: Partial<TicketCardView>): TicketCardView => ({
      id,
      title: `任务 ${id}`,
      role: "coder",
      roleLabel: "开发者",
      status: "ready",
      envId: "local",
      workspaceDir: "/tmp/very/long/workspace/path",
      createdAt: 1000,
      updatedAt: 1000,
      latestReport: {
        state: "ready",
        summary: longSummary,
        deliverable: "x".repeat(5000),
        at: 1000,
        overflowAsset: { id: "asset_1", name: "report.md", totalChars: 5000 },
      },
      ...overrides,
    });

    const tickets: TicketCardView[] = [
      makeTicket("T-0001", { status: "closed", updatedAt: 9000 }),
      makeTicket("T-0002", { status: "ready", updatedAt: 8000 }),
      makeTicket("T-0003", {
        status: "ready",
        pendingWorkspaceApply: true,
        boardId: "B-1",
        reviewTicketId: "T-0002",
        updatedAt: 2000,
      }),
      makeTicket("T-0004", { status: "running", updatedAt: 1500 }),
      makeTicket("T-0005", { status: "waiting", updatedAt: 1200 }),
    ];
    const envs: EnvNodeDescriptor[] = [
      {
        id: "local",
        name: "MacMini",
        kind: "local",
        online: true,
        platform: "darwin",
        arch: "arm64",
        rootDir: "/workspace",
        capabilities: ["worker-isolation", "agent-browser"],
        connectedAt: 1,
        lastSeenAt: 2,
        standbyPublicKey: "should-not-bloat-status",
        identityPublicKey: "should-not-bloat-status-2",
        info: { hostname: "macmini", cpus: 10, memoryGb: 16 } as never,
      },
    ];

    const ext = createOrchestratorToolsExtension(
      {
        dispatchTicket: async () => { throw new Error("unused"); },
        steerTicket: async () => { throw new Error("unused"); },
        stopTicket: async () => { throw new Error("unused"); },
        closeTicket: async () => { throw new Error("unused"); },
        inspectWorker: async () => { throw new Error("unused"); },
        getBoardSnapshot: async () => ({
          tickets,
          slots: { maxConcurrentWorkers: 4, used: 1, holders: ["T-0004"], writeHolders: ["T-0003"] },
          envs,
        }),
        readIdentityFiles: async () => { throw new Error("unused"); },
        proposeIdentity: async () => { throw new Error("unused"); },
        updateRelationship: async () => { throw new Error("unused"); },
        setAgentExpression: async () => null,
      },
      [],
      () => ({ enabled: false, endpoint: "", endpoints: [], caCertPem: "", routerApiKey: "", workerApiKey: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "p", shared: "s" } }),
    );
    const statusTool = ext.tools!.find((t) => t.name === "kulo_status")!;
    const fakeApi = { now: () => 1_795_334_700_000 } as unknown as ToolExecutionApi;

    const res = await statusTool.execute({ limit: 3 }, fakeApi, BACKGROUND_CONTEXT);
    const raw = (res.output![0] as { type: "text"; text: string }).text;
    // Compact unindented JSON (no pretty-print newlines).
    expect(raw).not.toContain("\n  ");
    const parsed = JSON.parse(raw) as {
      tickets: Array<Record<string, unknown>>;
      total_tickets: number;
      truncated: boolean;
      envs: Array<Record<string, unknown>>;
      current_time: string;
      time_zone: string;
    };
    expect(parsed.total_tickets).toBe(4); // closed excluded by default
    expect(parsed.truncated).toBe(true);
    // Order: waiting (T-0005) -> running (T-0004) -> pendingWorkspaceApply (T-0003) before plain ready (T-0002)!
    expect(parsed.tickets.map((t) => t.id)).toEqual(["T-0005", "T-0004", "T-0003"]);
    const staged = parsed.tickets[2]!;
    expect(staged.pendingWorkspaceApply).toBe(true);
    expect(staged.boardId).toBe("B-1");
    expect(staged.reviewTicketId).toBe("T-0002");
    const report = staged.latestReport as { summary: string; hasDeliverable: boolean; overflowAsset?: { id: string }; deliverable?: string };
    expect(report.summary.length).toBeLessThanOrEqual(200);
    expect(report.hasDeliverable).toBe(true);
    expect(report.overflowAsset?.id).toBe("asset_1");
    expect(report.deliverable).toBeUndefined();
    expect(parsed.envs[0]).not.toHaveProperty("standbyPublicKey");
    expect(parsed.envs[0]).not.toHaveProperty("info");
    expect(parsed.time_zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(Date.parse(parsed.current_time)).toBe(1_795_334_700_000);

    const withClosed = await statusTool.execute({ include_closed: true, limit: 10 }, fakeApi, BACKGROUND_CONTEXT);
    const parsedClosed = JSON.parse((withClosed.output![0] as { type: "text"; text: string }).text) as {
      tickets: Array<{ id: string }>;
      total_tickets: number;
      truncated: boolean;
    };
    expect(parsedClosed.total_tickets).toBe(5);
    expect(parsedClosed.truncated).toBe(false);
    expect(parsedClosed.tickets.at(-1)?.id).toBe("T-0001");
  });

  it("forces external agent dispatches to deliveryClaim='escalated' and zero inline wait even when inlineWaitMs is requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-ext-no-inline-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const faux = fauxProvider({ provider: "openai", models: [{ id: "fast-model" }] });
    let turn = 0;
    faux.setResponses([
      () => {
        turn += 1;
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_dispatch", {
              command_id: "ext-inline-zero-1",
              title: "外部异步直返测试",
              goal: "Test immediate async dispatch for external agent",
              scope: "read-only test",
              role: "codex_ext",
              env_id: "local",
              inline_wait_ms: 15_000,
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      () => {
        turn += 1;
        return fauxAssistantMessage([fauxText("已异步派发，正在执行。")]);
      },
      () => fauxAssistantMessage([fauxText("收到结果。")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    const hub = await openTestHub({
      models,
      providerId: "openai",
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "workspace"),
        enableLocalEnv: true,
        inlineDispatchWaitMs: 10_000,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "fast-model", thinkingLevel: "off" },
        roles: {
          codex_ext: {
            id: "codex_ext",
            label: "Codex",
            whenToUse: "External coding",
            prompt: "Run via Codex",
            readOnly: false,
            allowSubagents: false,
            external: { kind: "codex", envId: "local", verifiedAt: 1 },
          },
        },
      },
    });
    cleanups.push(() => hub.close());

    // Simulate a slow external agent (10s+) so any inline wait would visibly stall the turn.
    vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, req) => {
      const runId = "requestId" in req ? req.requestId : "runId" in req ? req.runId : "mock";
      return {
        type: "run",
        run: {
          id: runId,
          taskId: "T-0001",
          runEpoch: 1,
          kind: "codex",
          state: "running",
          text: "",
          events: [],
          permissions: [],
          nextSequence: 1,
          quiescent: false,
        },
      };
    });

    const started = Date.now();
    const sub = await hub.sendUserMessage("请用 Codex 跑个测试");
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    const elapsed = Date.now() - started;
    expect(settled.status).toBe("done");
    expect(turn).toBe(2);
    // Returned immediately without blocking for 10s/15s inline wait!
    expect(elapsed).toBeLessThan(3_000);

    const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const stored = Object.values(state?.tickets ?? {})[0];
    expect(stored).toBeDefined();
    expect(stored?.deliveryClaim).toBe("escalated");
    // Immediately visible on ticket board (not hidden by inline_waiting).
    const board = await hub.getBoardSnapshot(BACKGROUND_CONTEXT);
    expect(board.tickets.some((t) => t.id === stored!.id)).toBe(true);
  });

  it("clamps MemoryLlmBridge reasoning safely for api-vertex and non-mandatory models, suppresses includeThoughts, and adds headroom", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-bridge-think-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const captured: Array<{ model: Model<Api>; options: SimpleStreamOptions | undefined; transformedPayload: unknown }> = [];
    const customVertexModel: Model<Api> = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      api: "google-vertex",
      provider: "api-vertex",
      baseUrl: "https://aiplatform.googleapis.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    };
    const anthropicModel: Model<Api> = {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
      provider: "api-anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    };

    const fakeModels = {
      getModel: (provider: string, id: string) => {
        if (provider === "api-vertex" && id === "gemini-3.8-flash") return customVertexModel;
        if (provider === "api-anthropic" && id === "claude-sonnet-4-5") return anthropicModel;
        return undefined;
      },
      completeSimple: async (model: Model<Api>, _ctx: unknown, options?: SimpleStreamOptions) => {
        const samplePayload = model.api === "google-vertex"
          ? { config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } } }
          : { max_tokens: options?.maxTokens };
        const transformedPayload = options?.onPayload ? await options.onPayload(samplePayload, model) : samplePayload;
        captured.push({ model, options, transformedPayload });
        const msg = fauxAssistantMessage([{ type: "text", text: "{\"ok\":true}" }]);
        msg.usage.reasoning = 42;
        return msg;
      },
    };

    const bridge = new MemoryLlmBridge({ stateDir: dir, models: fakeModels as never });

    // 1. api-vertex gemini-3.8-flash (without thinkingLevelMap): infers low, adds +2048 headroom, disables includeThoughts, forwards thoughtsTokens.
    const vertexRes = await bridge.handleCall({
      providerId: "api-vertex",
      modelId: "gemini-3.8-flash",
      messages: [{ role: "user", content: "verify" }],
      maxCompletionTokens: 16,
    });
    expect(vertexRes.usage.thoughtsTokens).toBe(42);
    expect(captured[0]!.options?.reasoning).toBe("low");
    expect(captured[0]!.options?.maxTokens).toBe(16 + 2048);
    expect((captured[0]!.transformedPayload as { config: { thinkingConfig: { includeThoughts: boolean } } }).config.thinkingConfig.includeThoughts).toBe(false);

    // 2. Anthropic model that supports disabling reasoning: MUST omit `reasoning` (never pass "off") and keep exact maxCompletionTokens.
    await bridge.handleCall({
      providerId: "api-anthropic",
      modelId: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "extract" }],
      maxCompletionTokens: 512,
    });
    expect(captured[1]!.options?.reasoning).toBeUndefined();
    expect(captured[1]!.options?.maxTokens).toBe(512);
  });

  it("skips recallTicketMemory without projectId, degrades silently on timeout, and avoids redundant worklog writes when status is unchanged", async () => {
    let recallRequests = 0;
    let operationPolls = 0;
    let completeOp = false;
    let stallRecall = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/v1/kulo/access") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          policyVersion: 1,
          role: "worker",
          banks: {
            private: { id: "private-bank", read: false, write: false },
            shared: { id: "shared-bank", read: true, write: true },
          },
        }));
        return;
      }
      if (url.pathname === "/v1/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "1.2.1" }));
        return;
      }
      if (url.pathname.includes("/private-bank/")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (url.pathname.endsWith("/memories/recall")) {
        recallRequests += 1;
        if (stallRecall) {
          // Hold longer than the 1500ms timeout budget.
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ results: [] }));
            }
          }, 5_000);
          req.on("close", () => clearTimeout(timer));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [{ id: "m1", text: "project memory" }] }));
        return;
      }
      if (url.pathname.endsWith("/memories") && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const body = JSON.parse(raw) as { operation_id: string };
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            operation_id: body.operation_id,
            async: true,
            success: true,
            bank_id: "shared-bank",
            items_count: 1,
          }));
        });
        return;
      }
      if (url.pathname.includes("/operations/")) {
        operationPolls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ operation_id: url.pathname.split("/").at(-1), status: completeOp ? "completed" : "processing" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
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

    const onChange = vi.fn();
    let harness!: Harness;
    const ext = createMemoryLifecycleExtension({ getHarness: () => harness, getMemoryConfig: () => config, onChange });
    const registry = createRegistry();
    registry.install(ext);
    const models = createModels();
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    harness.resume();
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    // 1. External ticket WITHOUT projectId skips recall completely.
    const ungroupedTicket: TicketRecord = {
      id: "T-no-proj",
      commandId: "cmd-1",
      title: "叮咚鸡测试",
      goal: "ping",
      scope: "read-only",
      status: "running",
      role: "codex",
      envId: "local",
      workspaceDir: "/tmp",
      workerConversationId: 101,
      runEpoch: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(await ext.recallTicketMemory(ungroupedTicket, BACKGROUND_CONTEXT)).toBeUndefined();
    expect(recallRequests).toBe(0);

    // 2. External ticket WITH projectId degrades silently on timeout without writing MemoryLifecycleDoc or firing onChange.
    stallRecall = true;
    const projectTicket: TicketRecord = { ...ungroupedTicket, id: "T-with-proj", projectId: "proj-1", workerConversationId: 102 };
    const t0 = Date.now();
    expect(await ext.recallTicketMemory(projectTicket, BACKGROUND_CONTEXT)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3_500);
    expect(recallRequests).toBe(1);
    const lifecycleAfterTimeout = await harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT);
    expect(lifecycleAfterTimeout?.recalls["external-start:102:T-with-proj:1"]).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();

    // 3. worklogTask.poll does NOT notify onChange on unchanged "processing" status polls.
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await ext.retainExternalTicketReport(
      { ...projectTicket, workerConversationId: Number(conv.id) },
      { state: "ready", summary: "完成测试", at: Date.now() },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(operationPolls).toBeGreaterThanOrEqual(1), { timeout: 6_000 });
    const callsAfterFirstPoll = onChange.mock.calls.length;
    await vi.waitFor(() => expect(operationPolls).toBeGreaterThanOrEqual(2), { timeout: 6_000 });
    // Second unchanged "processing" poll must not trigger another onChange broadcast!
    expect(onChange.mock.calls.length).toBe(callsAfterFirstPoll);

    completeOp = true;
    await vi.waitFor(
      async () => {
        const snap = await harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT);
        expect(Object.values(snap?.worklogs ?? {})[0]?.status).toBe("completed");
      },
      { timeout: 8_000 },
    );
    expect(onChange.mock.calls.length).toBe(callsAfterFirstPoll + 1);
  }, 20_000);
});
