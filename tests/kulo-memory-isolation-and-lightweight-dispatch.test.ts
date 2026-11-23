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
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, ROOT_CONVERSATION_ID, createRegistry } from "@earendil-works/pi-durable";
import {
  EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY,
  type ExternalAgentRequest,
  type HindsightMemoryConfig,
  type RolePreset,
  type TicketRecord,
} from "@kulo/protocol";
import { ExternalAgentService } from "../packages/env/src/external-agents.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";
import {
  buildTicketRecallQuery,
  createMemoryLifecycleExtension,
  formatRecalledMemoryItems,
  MemoryLifecycleDoc,
  parseRecallPayload,
} from "../packages/hub/src/memory-lifecycle.js";
import {
  buildExternalAgentPrompt,
  buildExternalAgentRunRequest,
  defaultExternalAgentRolePrompt,
  formatExternalAgentFollowUpPrompt,
  isDefaultExternalAgentRolePrompt,
  isEphemeralTableWorkspaceDir,
  isLightweightStandaloneExternalTask,
} from "../packages/hub/src/prompts/external-agent.js";
import { createWorkerSections, formatWorkerInitialPrompt } from "../packages/hub/src/prompts/worker.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { createHindsightTools } from "../packages/hub/src/tools-memory.js";
import { createWorkerExtension } from "../packages/hub/src/tools-worker.js";
import { createExternalAgentToolHandler } from "../packages/hub/src/external-agent-tools.js";
import { createVoiceContext } from "../packages/hub/src/voice-context.js";
import { openTestHub } from "./helpers/secure-hub.js";

const ROUTER = "memory-router-test-00000000000000001";
const WORKER = "memory-worker-test-00000000000000001";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "T-0023",
    commandId: "cmd-23",
    title: "向 Codex Sol 发送测试消息",
    goal: 'Respond to: "叮咚鸡 叮咚鸡"',
    scope: "Text reply only",
    status: "running",
    role: "codex-sol",
    envId: "local",
    workspaceDir: "/Users/test/Library/Application Support/Kulo Dev/workspace/table/T-0023-codex-sol",
    scratchDir: "/Users/test/Library/Application Support/Kulo Dev/workspace/scratch/T-0023",
    readOnly: false,
    workerConversationId: 42,
    runEpoch: 1,
    createdAt: 1,
    updatedAt: 1,
    externalExecution: {
      binding: { kind: "codex", envId: "local", verifiedAt: 1_700_000_000_000 },
      effectiveReadOnly: true,
      instructions: defaultExternalAgentRolePrompt("zh-CN"),
      allowSubagents: false,
    },
    ...overrides,
  };
}

describe("Item 1: Non-project shared memory isolation & legacy project:unassigned filtering", () => {
  it("skips worklog retention for both external and built-in non-project tickets and blocks shared memory tool calls without projectId", async () => {
    const writes: unknown[] = [];
    const recalls: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      const url = new URL(req.url!, "http://127.0.0.1");
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/v1/kulo/access") {
        const role = req.headers.authorization === `Bearer ${ROUTER}` ? "router" : "worker";
        return send(200, {
          policyVersion: 1,
          role,
          banks: {
            private: { id: "private-bank", read: role === "router", write: role === "router" },
            shared: { id: "shared-bank", read: true, write: role === "worker" },
          },
        });
      }
      if (url.pathname === "/v1/version") return send(200, { version: "1.2.1" });
      const role = req.headers.authorization === `Bearer ${ROUTER}` ? "router" : "worker";
      if (url.pathname.includes("/private-bank/") && role !== "router") return send(403, {});
      if (url.pathname.includes("/shared-bank/") && req.method === "POST" && role !== "worker" && !url.pathname.endsWith("/recall")) return send(403, {});
      if (url.pathname.endsWith("/documents")) return send(200, { items: [] });
      if (url.pathname.endsWith("/memories") && req.method === "POST") {
        writes.push(body);
        return send(202, { operation_id: body.operation_id, async: true, success: true });
      }
      if (url.pathname.endsWith("/memories/recall")) {
        recalls.push(body);
        return send(200, {
          results: [
            { id: "dirty-1", text: "旧版遗留未分组 MacBook 18核", tags: ["project:unassigned"] },
            { id: "clean-1", text: "真实项目架构约定", tags: ["project:proj-1"] },
          ],
        });
      }
      if (url.pathname.endsWith("/mental-models")) {
        return send(200, {
          items: [
            { id: "mm-dirty", name: "Dirty", tags: ["project:unassigned"] },
            { id: "mm-clean", name: "Clean", tags: ["project:proj-1"] },
          ],
        });
      }
      if (url.pathname.endsWith("/pages/dirty-page")) {
        return send(200, { id: "dirty-page", name: "Dirty Page", tags: ["project:unassigned"], body: "noise" });
      }
      return send(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const config: HindsightMemoryConfig = {
      enabled: true,
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      endpoints: [],
      caCertPem: "",
      routerApiKey: ROUTER,
      workerApiKey: WORKER,
      routerApiKeyEnv: "",
      workerApiKeyEnv: "",
      authFile: "",
      autoAttachTopLevelRouters: false,
      banks: { private: "private-bank", shared: "shared-bank" },
    };

    const provider = fauxProvider({ provider: "openai", models: [{ id: "m1" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    let harness!: Harness;
    const memory = createMemoryLifecycleExtension({ getHarness: () => harness, getMemoryConfig: () => config });
    const worker = createWorkerExtension({ getIdentityDir: () => "/nonexistent", getMemoryConfig: () => config });
    const routerTools = createHindsightTools({ getMemoryConfig: () => config, defaultBank: "private" });
    const registry = createRegistry();
    registry.install(worker);
    registry.install(memory);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    // 1. External non-project report must NOT retain into shared bank
    const convExt = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await memory.retainExternalTicketReport(
      makeTicket({ projectId: undefined, workerConversationId: Number(convExt.id) }),
      { state: "ready", summary: "叮咚鸡回复完成", at: Date.now() },
      BACKGROUND_CONTEXT,
    );
    expect(writes).toHaveLength(0);

    // 2. Built-in non-project worker kulo_report must NOT retain into shared bank, AND its worker prompt omits Shared Project Memory
    const seenContexts: TranscriptContext[] = [];
    provider.setResponses([
      (ctx) => {
        seenContexts.push(structuredClone(ctx));
        return fauxAssistantMessage(
          [fauxToolCall("hindsight_recall", { query: "MacBook", bank: "shared" })],
          { stopReason: "toolUse" },
        );
      },
      (ctx) => {
        seenContexts.push(structuredClone(ctx));
        return fauxAssistantMessage(
          [fauxToolCall("kulo_report", { state: "ready", summary: "查询完毕：无项目测试" })],
          { stopReason: "toolUse" },
        );
      },
    ]);
    const workerConv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "openai", modelId: "m1" }, thinkingLevel: "off", extensions: [worker, memory] },
      },
      BACKGROUND_CONTEXT,
    );
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-NO-PROJ"] = {
        id: "T-NO-PROJ",
        commandId: "cmd-np",
        title: "无项目测试",
        goal: "测试隔离",
        scope: "只读",
        status: "running",
        role: "scout",
        readOnly: true,
        envId: "local",
        workspaceDir: "/tmp/table/T-NO-PROJ-test",
        workerConversationId: Number(workerConv.id),
        runEpoch: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      state.conversationToTicket[String(workerConv.id)] = "T-NO-PROJ";
    }, BACKGROUND_CONTEXT);
    await (await workerConv.submit({ type: "input", content: "执行" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

    // System prompt must omit Shared Project Memory when !ticket.projectId
    const systemText = JSON.stringify(seenContexts[0]!.messages.filter((m) => m.role === "system"));
    expect(systemText).not.toContain("Shared Project Memory");
    // Runtime guard in tools-memory.ts blocks worker shared recall without projectId
    const toolResultMsg = seenContexts[1]!.messages.find((m) => m.role === "toolResult");
    expect(JSON.stringify(toolResultMsg)).toContain("非项目独立任务不访问共享项目记忆库");
    expect(recalls).toHaveLength(0);
    expect(writes).toHaveLength(0);

    // 3. External agent tool handler rejects all 5 kulo_memory_* tools when !ticket.projectId
    const memorySpy = vi.fn(async () => ({ ok: true }));
    const handler = createExternalAgentToolHandler({
      read: async () => ({ ticket: makeTicket({ projectId: undefined }), maxSubagents: 2, children: {} }),
      agents: async () => [],
      report: async () => ({ recorded: true }),
      delegate: async () => ({}),
      inspect: async () => ({}),
      memory: memorySpy,
    });
    const baseScope = { envId: "local", runId: "r-1", taskId: "T-0023", runEpoch: 1 };
    const ticketWithRun = makeTicket({
      projectId: undefined,
      externalExecution: {
        binding: { kind: "codex", envId: "local", verifiedAt: 1 },
        runId: "r-1",
        effectiveReadOnly: true,
      },
    });
    const activeHandler = createExternalAgentToolHandler({
      read: async () => ({ ticket: ticketWithRun, maxSubagents: 2, children: {} }),
      agents: async () => [],
      report: async () => ({ recorded: true }),
      delegate: async () => ({}),
      inspect: async () => ({}),
      memory: memorySpy,
    });
    for (const [name, args] of [
      ["kulo_memory_recall", { query: "test" }],
      ["kulo_memory_search_pages", { query: "test" }],
      ["kulo_memory_read_page", { page_id: "p1" }],
      ["kulo_memory_ingest", { title: "t", content: "c" }],
      ["kulo_memory_reflect", { query: "q" }],
    ] as const) {
      await expect(activeHandler({ ...baseScope, name, args })).rejects.toMatchObject({
        code: "external_memory_project_required",
      });
    }
    expect(memorySpy).not.toHaveBeenCalled();
    void handler;

    // 4. Router in ungrouped chat querying shared bank: defaults scope to global, rejects scope='project', and filters legacy project:unassigned
    const recallTool = routerTools.find((t) => t.name === "hindsight_recall")!;
    const listMmTool = routerTools.find((t) => t.name === "hindsight_list_mental_models")!;
    const getPageTool = routerTools.find((t) => t.name === "hindsight_get_page")!;
    const rootApi = {
      conversationId: ROOT_CONVERSATION_ID,
      callId: "c1",
      now: () => Date.now(),
      memo: async <T>(_k: string, val: T) => val,
      snapshot: async () => undefined,
    } as never;

    const projectScopeErr = await recallTool.execute({ query: "架构", bank: "shared", scope: "project" }, rootApi, BACKGROUND_CONTEXT);
    expect(projectScopeErr.isError).toBe(true);
    expect(JSON.stringify(projectScopeErr.output)).toContain("scope='global'");

    const routerGlobalRes = await recallTool.execute({ query: "架构", bank: "shared" }, rootApi, BACKGROUND_CONTEXT);
    expect(routerGlobalRes.isError).toBeUndefined();
    const routerGlobalText = (routerGlobalRes.output[0] as { text: string }).text;
    expect(routerGlobalText).toContain("真实项目架构约定");
    expect(routerGlobalText).not.toContain("project:unassigned");
    expect(routerGlobalText).not.toContain("MacBook 18核");
    // Unscoped router call must NOT send project:unassigned filter tags upstream
    expect(recalls.at(-1)?.tags).toBeUndefined();

    const mmRes = await listMmTool.execute({ bank: "shared" }, rootApi, BACKGROUND_CONTEXT);
    const mmText = (mmRes.output[0] as { text: string }).text;
    expect(mmText).toContain("mm-clean");
    expect(mmText).not.toContain("mm-dirty");

    const dirtyPageRes = await getPageTool.execute({ page_id: "dirty-page", bank: "shared" }, rootApi, BACKGROUND_CONTEXT);
    expect(dirtyPageRes.isError).toBe(true);

    // 5. Ungrouped voice context skips shared bank recall completely (only queries private bank)
    const rootConv = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const recallsBeforeVoice = recalls.length;
    const voiceState = {
      ...(await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!,
      topics: { "topic-ungrouped": { id: "topic-ungrouped", title: "闲聊", conversationId: Number(rootConv.id), createdAt: 1, updatedAt: 1 } },
      conversationToTopic: { [String(rootConv.id)]: "topic-ungrouped" },
    };
    const voiceCtx = await createVoiceContext(
      {
        conversation: rootConv,
        harness,
        state: voiceState,
        memory: config,
        agentName: "Kulo",
        redact: (t) => t,
      },
      BACKGROUND_CONTEXT,
    );
    expect(recalls.length - recallsBeforeVoice).toBe(1);
    expect(voiceCtx.instructions).not.toContain("Project long-term memory");
  });
});

describe("Item 2: Compact project memory formatting & malformed JSON safety", () => {
  it("strips UUIDs, null fields, tags, crediting, deduplicates, formats dates, and removes wildcard scope noise", () => {
    expect(buildTicketRecallQuery({ title: "修复鉴权", goal: "修复 token 刷新", scope: "**" })).toBe(
      "修复鉴权 — 修复 token 刷新",
    );
    expect(buildTicketRecallQuery({ title: "相同标题", goal: "相同标题", scope: "." })).toBe("相同标题");

    const formatted = formatRecalledMemoryItems([
      { text: "  架构约定：\n所有 API 返回 ProjectError  ", occurred_start: "2026-11-22T06:40:23.010Z" },
      { text: "架构约定： 所有 API 返回 ProjectError", occurred_start: "2026-11-22T09:00:00Z" },
      { text: "使用 pnpm typecheck 验证", occurred_start: null },
      { text: "   " },
    ]);
    expect(formatted).toBe("- [2026-11-22] 架构约定： 所有 API 返回 ProjectError\n- 使用 pnpm typecheck 验证");
    expect(formatted).not.toContain("crediting");
    expect(formatted).not.toContain("project:");

    expect(parseRecallPayload("<html>502 Bad Gateway</html>")).toEqual({ code: "INVALID_JSON", parseError: true });
    expect(parseRecallPayload('{"results":[{"text":"ok"}]}')).toEqual({ results: [{ text: "ok" }] });
  });

  it("handles malformed gateway JSON gracefully in built-in worker beforeRequest and persists error receipt", async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith("/v1/kulo/access")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            policyVersion: 1,
            role: "worker",
            banks: {
              private: { id: "private-bank", read: false, write: false },
              shared: { id: "shared-bank", read: true, write: true },
            },
          }),
        );
        return;
      }
      if (req.url?.endsWith("/v1/version")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "1.2.1" }));
        return;
      }
      if (req.url?.includes("/private-bank/")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url?.endsWith("/documents")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      if (req.url?.endsWith("/memories/recall")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                id: "uuid-should-not-appear",
                text: "API 统一返回 ProjectError",
                type: "observation",
                document_id: null,
                occurred_start: "2026-11-22T06:40:23.000Z",
                occurred_end: "2026-11-22T06:40:23.000Z",
                tags: ["project:p1"],
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const config: HindsightMemoryConfig = {
      enabled: true,
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      endpoints: [],
      caCertPem: "",
      routerApiKey: ROUTER,
      workerApiKey: WORKER,
      routerApiKeyEnv: "",
      workerApiKeyEnv: "",
      authFile: "",
      autoAttachTopLevelRouters: false,
      banks: { private: "private-bank", shared: "shared-bank" },
    };

    const provider = fauxProvider({ provider: "openai", models: [{ id: "m1" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    let harness!: Harness;
    const memory = createMemoryLifecycleExtension({ getHarness: () => harness, getMemoryConfig: () => config });
    const registry = createRegistry();
    registry.install(memory);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    const requests: TranscriptContext[] = [];
    provider.setResponses([
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "openai", modelId: "m1" }, thinkingLevel: "off", extensions: [memory] } },
      BACKGROUND_CONTEXT,
    );
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const builtinTicket = makeTicket({ id: "T-COMPACT", projectId: "p1", workerConversationId: Number(conv.id) });
      delete builtinTicket.externalExecution;
      state.tickets["T-COMPACT"] = builtinTicket;
      state.conversationToTicket[String(conv.id)] = "T-COMPACT";
    }, BACKGROUND_CONTEXT);

    await (await conv.submit({ type: "input", content: "check" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const snap = await harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT);
    const recalledText = snap?.recalls[`worker-start:${conv.id}:T-COMPACT:1`]?.text ?? "";
    expect(recalledText).toContain("- [2026-11-22] API 统一返回 ProjectError");
    expect(recalledText).not.toContain("uuid-should-not-appear");
    expect(recalledText).not.toContain('"document_id"');
    expect(recalledText).not.toContain('"crediting"');

    // Also verify malformed gateway response in beforeRequest never crashes the turn and records error receipt
    const badServer = http.createServer((req, res) => {
      if (req.url?.endsWith("/v1/kulo/access")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            policyVersion: 1,
            role: "worker",
            banks: {
              private: { id: "private-bank", read: false, write: false },
              shared: { id: "shared-bank", read: true, write: true },
            },
          }),
        );
        return;
      }
      if (req.url?.endsWith("/v1/version")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "1.2.1" }));
        return;
      }
      if (req.url?.includes("/private-bank/")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url?.endsWith("/documents")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>502 Bad Gateway</html>");
    });
    await new Promise<void>((resolve) => badServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => badServer.close(() => resolve())));
    const badConfig: HindsightMemoryConfig = {
      ...config,
      endpoint: `http://127.0.0.1:${(badServer.address() as { port: number }).port}`,
    };
    let badHarness!: Harness;
    const badMemory = createMemoryLifecycleExtension({ getHarness: () => badHarness, getMemoryConfig: () => badConfig });
    const badRegistry = createRegistry();
    badRegistry.install(badMemory);
    badHarness = await Harness.open(new MemoryStorage(), { models, registry: badRegistry }, BACKGROUND_CONTEXT);
    cleanups.push(() => badHarness.close(BACKGROUND_CONTEXT));
    provider.setResponses([fauxAssistantMessage([fauxText("survived bad gateway")])]);
    const badConv = await badHarness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "openai", modelId: "m1" }, thinkingLevel: "off", extensions: [badMemory] } },
      BACKGROUND_CONTEXT,
    );
    await badHarness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = makeTicket({ id: "T-BAD-GW", projectId: "p1", workerConversationId: Number(badConv.id) });
      delete t.externalExecution;
      state.tickets["T-BAD-GW"] = t;
      state.conversationToTicket[String(badConv.id)] = "T-BAD-GW";
    }, BACKGROUND_CONTEXT);
    await (await badConv.submit({ type: "input", content: "check" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const badSnap = await badHarness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT);
    expect(badSnap?.recalls[`worker-start:${badConv.id}:T-BAD-GW:1`]).toMatchObject({ text: "" });
    expect(badSnap?.recalls[`worker-start:${badConv.id}:T-BAD-GW:1`]?.error).toBeTruthy();
  });
});

describe("Item 3: Lightweight standalone external prompt, Grok Bot convergence & cross-epoch cache stability", () => {
  it("detects ephemeral table directories across POSIX and Windows paths while rejecting explicit directories", () => {
    expect(isEphemeralTableWorkspaceDir("/Users/demo/Library/Application Support/Kulo Dev/workspace/table/T-0023-codex-sol", "T-0023")).toBe(true);
    expect(isEphemeralTableWorkspaceDir("C:\\Users\\demo\\Kulo\\workspace\\table\\T-0023-test\\", "T-0023")).toBe(true);
    expect(isEphemeralTableWorkspaceDir("/Users/demo/workspace/table/T-0001-prev", "T-0002")).toBe(false);
    expect(isEphemeralTableWorkspaceDir("/Users/demo/Documents/my-folder", "T-0023")).toBe(false);
  });

  it("uses compact prompt & disables MCP for lightweight standalone read-only tasks across Codex/Claude/ACP and stays byte-identical on resume with image", () => {
    const ticket = makeTicket();
    expect(isDefaultExternalAgentRolePrompt(defaultExternalAgentRolePrompt("zh-CN"))).toBe(true);
    expect(isDefaultExternalAgentRolePrompt(defaultExternalAgentRolePrompt("en"))).toBe(true);
    expect(isDefaultExternalAgentRolePrompt("用简短幽默语气回答")).toBe(false);

    const req1 = buildExternalAgentRunRequest({
      ticket,
      runEpoch: 1,
      runId: "kulo:external:T-0023:1",
      isResumingNativeSession: false,
      materialized: [],
      hasConnections: false,
      memoryEnabled: true, // Even if caller passes true, non-project forces false!
      envCapabilities: ["external-agents", EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY],
    });
    expect(req1.taskTools).toBe(false);
    expect(req1.memoryEnabled).toBeUndefined();
    expect(req1.readOnly).toBe(true);
    expect(req1.developerInstructions).toBe(
      "Read-only mode: delegated task from Kulo. Reply directly without modifying files.",
    );
    expect(req1.developerInstructions).not.toContain("遵循仓库既有约定");
    expect(req1.developerInstructions).not.toContain("kulo_task_report");
    expect(req1.developerInstructions).not.toContain("kulo_memory_");
    expect(req1.prompt).toContain('Goal: Respond to: "叮咚鸡 叮咚鸡"');
    expect(req1.prompt).toContain("Scope: Text reply only");

    // Legacy Env downgrade: combinedPrompt starts with "Read-only mode:" so fallbackReadOnlyNote is suppressed
    const legacyReq = buildExternalAgentRunRequest({
      ticket,
      runEpoch: 1,
      runId: "kulo:external:T-0023:1",
      isResumingNativeSession: false,
      materialized: [],
      hasConnections: false,
      memoryEnabled: true,
      envCapabilities: ["external-agents"],
    });
    expect(legacyReq.taskTools).toBe(false);
    expect(legacyReq.developerInstructions).toBeUndefined();
    expect(legacyReq.prompt).toMatch(/^Read-only mode:/);

    // Resume epoch 2 with newly added image attachment keeps byte-identical developerInstructions and taskTools=false!
    const resumedTicket = makeTicket({
      runEpoch: 2,
      externalExecution: { ...ticket.externalExecution!, sessionId: "native-sess-1" },
    });
    const req2 = buildExternalAgentRunRequest({
      ticket: resumedTicket,
      runEpoch: 2,
      runId: "kulo:external:T-0023:2",
      isResumingNativeSession: true,
      followUpText: "再看下这张图",
      materialized: [{ id: "att-2", name: "shot.png", mimeType: "image/png", path: "/tmp/shot.png", size: 64 }],
      hasConnections: false,
      memoryEnabled: true,
      envCapabilities: ["external-agents", EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY],
    });
    expect(req2.developerInstructions).toBe(req1.developerInstructions);
    expect(req2.taskTools).toBe(false);
    expect(req2.prompt).toContain("and reply directly.");
    expect(req2.prompt).not.toContain("kulo_task_report");
    expect(req2.attachments).toHaveLength(1);

    // Custom role prompt is preserved in lightweight mode
    const customBuilt = buildExternalAgentPrompt({
      ticket: makeTicket({ externalExecution: { ...ticket.externalExecution!, instructions: "用猫娘语气回复。" } }),
      instructions: "用猫娘语气回复。",
      workspaceMode: "read_only",
      materialized: [],
    });
    expect(customBuilt.developerInstructions).toContain("用猫娘语气回复。");

    // Scheduled standalone read-only ticket MUST NOT enter lightweight mode (keeps kulo_task_report available)
    const scheduledTicket = makeTicket({ schedule: { executeAt: Date.now() + 60_000, nextRunAt: Date.now() + 60_000 } });
    expect(
      isLightweightStandaloneExternalTask({
        ticket: scheduledTicket,
        effectiveReadOnly: true,
        allowSubagents: false,
        memoryEnabled: false,
        hasConnections: false,
      }),
    ).toBe(false);
    const scheduledReq = buildExternalAgentRunRequest({
      ticket: scheduledTicket,
      runEpoch: 1,
      runId: "kulo:external:T-0023:1",
      isResumingNativeSession: false,
      materialized: [],
      hasConnections: false,
      memoryEnabled: false,
      envCapabilities: ["external-agents", EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY],
    });
    expect(scheduledReq.taskTools).toBe(true);
    expect(scheduledReq.developerInstructions).toContain("kulo_task_report");

    // Cross-device guard in lightweight mode avoids referencing nonexistent kulo_task_report
    const crossBuilt = buildExternalAgentPrompt({
      ticket: makeTicket({ senderSource: { deviceId: "macbook-1", name: "MacBook" } }),
      instructions: defaultExternalAgentRolePrompt("zh-CN"),
      workspaceMode: "read_only",
      materialized: [],
    });
    expect(crossBuilt.developerInstructions).toContain("Cross-Device Guard");
    expect(crossBuilt.developerInstructions).toContain("immediately stop and state what prerequisite");
    expect(crossBuilt.developerInstructions).not.toContain("report blocked");
  });

  it("disables MCP, repo boilerplate, fake workspace paths, and staged disk cloning for Grok Bot even when writable or project-bound", async () => {
    const grokTicket = makeTicket({
      projectId: "proj-1",
      externalExecution: {
        binding: { kind: "grok-bot", envId: "local", agentRef: "bot-1", cdpUrl: "http://127.0.0.1:9222", experimental: true },
        workspaceMode: "staged",
        instructions: defaultExternalAgentRolePrompt("zh-CN"),
        allowSubagents: true,
      },
    });
    const req = buildExternalAgentRunRequest({
      ticket: grokTicket,
      runEpoch: 1,
      runId: "kulo:external:T-0023:1",
      isResumingNativeSession: false,
      projectName: "Moco",
      materialized: [],
      hasConnections: true,
      memoryEnabled: true,
      envCapabilities: ["external-agents", EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY],
    });
    expect(req.taskTools).toBe(false);
    expect(req.allowSubagents).toBe(false);
    expect(req.memoryEnabled).toBeUndefined();
    expect(req.hasConnections).toBeUndefined();
    expect(req.developerInstructions).toBe("Delegated task from Kulo. Reply directly with your findings or answer.");
    expect(req.developerInstructions).not.toContain("Workspace Mode");
    expect(req.developerInstructions).not.toContain("kulo_task_report");
    expect(req.developerInstructions).not.toContain("遵循仓库既有约定");

    // Scheduled wake prompt for Grok Bot does not reference kulo_task_report
    expect(formatWorkerInitialPrompt(grokTicket)).toContain("directly in your final response");
    expect(formatWorkerInitialPrompt(grokTicket)).not.toContain("kulo_task_report");

    // Follow-up helper without taskTools omits kulo_task_report
    expect(formatExternalAgentFollowUpPrompt({ ticket: grokTicket, followUp: "继续", taskTools: false })).not.toContain("kulo_task_report");

    // Env side: Grok Bot skips staged workspace clone even with projectId + workspaceMode='staged'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-grok-noclone-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const projectDir = path.join(dir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "a.txt"), "hello");
    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(dir, "private", "project-grants.json"),
      scratchRoot: path.join(dir, "workspace", "scratch"),
    });
    const grant = registry.authorize({
      operationId: "op-grok-1",
      projectId: "proj-1",
      path: projectDir,
    });
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: path.join(dir, "workspace"),
      projectRegistry: registry,
      toolHandler: vi.fn(async () => ({})),
    });
    cleanups.push(() => service.close());
    const runReq: Extract<ExternalAgentRequest, { operation: "run" }> = {
      ...req,
      cwd: grant.workspaceDir,
      directoryId: grant.directoryId,
      grantRevision: grant.revision,
    };
    const started = await service.request(runReq);
    expect(started.type).toBe("run");
    if (started.type === "run") {
      expect(started.run.stagedCwd).toBeUndefined();
      expect(fs.existsSync(path.join(registry.scratchRoot, "T-0023", "staged"))).toBe(false);
    }
  });

  it("gates built-in worker hindsight-knowledge skill visibility on projectId", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skill-proj-gate-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const provider = fauxProvider({ provider: "gate-test", models: [{ id: "m1" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const seenWorkerSystem: string[] = [];
    const reply = (ctx: TranscriptContext) => {
      const sys = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
      if (sys.includes("# Worker Mandate")) {
        seenWorkerSystem.push(sys);
        return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "ok" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText("ack")]);
    };
    provider.setResponses(Array.from({ length: 12 }, () => reply));

    const hub = await openTestHub({
      models,
      providerId: "gate-test",
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: {
          enabled: true,
          knowledgeGuidanceEnabled: true,
          endpoint: "http://127.0.0.1:19999",
          accessMode: "kulo",
          routerApiKey: ROUTER,
          workerApiKey: WORKER,
        },
        model: { defaultProvider: "gate-test", defaultModel: "m1", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());
    const memView = hub.getSettingsView().blocks.memory;
    await hub.updateSettingsBlock("memory", memView.revision, {
      ...memView.value,
      enabled: true,
      knowledgeGuidanceEnabled: true,
    });

    // 1. Non-project worker must NOT see hindsight-knowledge skill or Shared Project Memory
    const ungrouped = await hub.dispatchTicket({
      commandId: "cmd-skill-ungrouped",
      title: "无项目测试",
      goal: "只读测试",
      scope: "只读",
      role: "scout",
    });
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[ungrouped.id]?.status).toBe("ready");
    });

    // 2. Project worker DOES see hindsight-knowledge skill & Shared Project Memory
    const repoDir = path.join(dir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const project = await hub.projects.create({ commandId: "cmd-proj", name: "Demo", deviceId: "local", workspaceDir: repoDir });
    const grouped = await hub.dispatchTicket({
      commandId: "cmd-skill-grouped",
      title: "项目测试",
      goal: "检查架构",
      scope: "src/**",
      role: "scout",
      projectId: project.id,
    });
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[grouped.id]?.status).toBe("ready");
    });

    expect(seenWorkerSystem).toHaveLength(2);
    expect(seenWorkerSystem[0]).not.toContain("hindsight-knowledge");
    expect(seenWorkerSystem[0]).not.toContain("Shared Project Memory");
    expect(seenWorkerSystem[1]).toContain("hindsight-knowledge");
    expect(seenWorkerSystem[1]).toContain("Shared Project Memory");
  });
});
