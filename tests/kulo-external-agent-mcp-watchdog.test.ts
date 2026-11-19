import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { HindsightMemoryConfig } from "@kulo/protocol";
import { EnvManager, ExternalAgentService, ProjectDirectoryRegistry, type ExternalAgentToolHandler } from "@kulo/env";
import { KuloConnections } from "../packages/hub/src/connections.js";
import { LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import type { ConnectionExecutionBackend } from "../packages/hub/src/connection-execution.js";
import { MemoryLifecycleDoc } from "../packages/hub/src/memory-lifecycle.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ROUTER_MEM_TOKEN = "router-mem-token-0000000000000001";
const WORKER_MEM_TOKEN = "worker-mem-token-0000000000000001";

async function startMockHindsight() {
  const sharedDocs: Array<{ content: string; tags: string[]; document_id: string }> = [
    {
      document_id: "doc-seed-1",
      content: "架构约定：所有 API 错误统一返回 ProjectError code。",
      tags: ["scope:project"],
    },
  ];
  const privateHits: string[] = [];
  const sharedWrites: Array<Record<string, unknown>> = [];
  const sharedReads: Array<Record<string, unknown>> = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const url = new URL(req.url!, "http://127.0.0.1");
    const auth = req.headers.authorization?.replace("Bearer ", "");
    const role = auth === ROUTER_MEM_TOKEN ? "router" : auth === WORKER_MEM_TOKEN ? "worker" : "none";
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (role === "none") return send(401, {});
    if (url.pathname === "/v1/kulo/access") {
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
    if (url.pathname.includes("/private-bank/")) {
      if (role !== "router") return send(403, { error: "worker_private_denied" });
      privateHits.push(`${role}:${req.method}:${url.pathname}`);
    }
    if (url.pathname.includes("/shared-bank/")) {
      if (url.pathname.endsWith("/memories/recall")) {
        sharedReads.push(body);
        return send(200, {
          results: sharedDocs.map((d) => ({ id: d.document_id, document_id: d.document_id, text: d.content, tags: d.tags, type: "experience" })),
        });
      }
      if (url.pathname.endsWith("/memories") && req.method === "POST") {
        sharedWrites.push(body);
        const items = (body.items as Array<{ content: string; tags: string[]; document_id: string }>) ?? [];
        for (const item of items) sharedDocs.push(item);
        return send(202, { operation_id: String(body.operation_id ?? "op-1"), async: true, success: true, bank_id: "shared-bank", items_count: items.length });
      }
      if (url.pathname.includes("/operations/")) {
        return send(200, { operation_id: url.pathname.split("/").at(-1), status: "completed" });
      }
    }
    return send(404, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const config: HindsightMemoryConfig = {
    enabled: true,
    endpoint: `http://127.0.0.1:${port}`,
    endpoints: [],
    caCertPem: "",
    routerApiKey: ROUTER_MEM_TOKEN,
    workerApiKey: WORKER_MEM_TOKEN,
    routerApiKeyEnv: "",
    workerApiKeyEnv: "",
    authFile: "",
    autoAttachTopLevelRouters: false,
    banks: { private: "private-bank", shared: "shared-bank" },
  };
  return { config, privateHits, sharedReads, sharedWrites };
}

describe("Phase 3: Default kulo-task MCP, artifact staging, Hindsight shared memory & connection bridge", () => {
  it("mounts kulo-task MCP by default (allowSubagents=false), stages report files, recalls/writes shared memory while blocking private bank, and brokers connectionIds", async () => {
    const root = makeTempDir("kulo-ext-mcp-mem-");
    const stateDir = path.join(root, "state");
    const projectDir = path.join(root, "proj-mem");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "index.ts"), "export const v = 1;\n");

    const fakeBinDir = path.join(root, "bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeCodex = path.join(fakeBinDir, "codex");
    fs.writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex 0.1.0'\n", { mode: 0o755 });

    const hindsight = await startMockHindsight();
    const connSecret = "sk-conn-sealed-secret-9876543210";
    const vault = new LocalConnectionVault({ stateDir, keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 23) } });
    const executeConn = vi.fn<ConnectionExecutionBackend["execute"]>(async (_conn, secrets, operation) => ({
      kind: operation.kind,
      status: 200,
      output: `upstream ok (secret_present=${Boolean(secrets.apiKey)}, leaked=${connSecret})`,
    }));
    const connManager = new KuloConnections({
      stateDir,
      vault,
      executor: { scan: vi.fn(async () => ({ fingerprint: "SHA256:test", lines: [] })), trust: vi.fn(async () => {}), execute: executeConn },
      platform: "darwin",
    });

    let installedToolHandler: ExternalAgentToolHandler | undefined;
    const origSetHandler = EnvManager.prototype.setExternalAgentToolHandler;
    vi.spyOn(EnvManager.prototype, "setExternalAgentToolHandler").mockImplementation(function (this: EnvManager, handler) {
      if (handler) installedToolHandler = handler;
      origSetHandler.call(this, handler);
    });

    const models = createModels();
    const provider = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
    provider.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage([fauxText("Reviewed")])));
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      connectionManager: connManager,
      config: {
        stateDir,
        identityDir: path.join(root, "identity"),
        localEnvRoot: path.join(root, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: hindsight.config,
        model: { defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
        roles: {
          "codex-dev": {
            id: "codex-dev",
            label: "Codex 工程师",
            whenToUse: "编码与自测",
            prompt: "使用 kulo-task 工具汇报产物。",
            enabled: true,
            allowSubagents: false,
            modelId: "gpt-5-codex",
            external: { kind: "codex", envId: "local", executable: fakeCodex, verifiedAt: 1_700_000_000_000 },
          },
        },
      },
    });
    cleanups.push(() => hub.close());
    expect(installedToolHandler).toBeDefined();

    const savedConn = await connManager.save({
      name: "Staging API",
      kind: "api-key",
      url: "https://staging.example.test",
      secrets: { apiKey: connSecret },
    });

    const project = await hub.projects.create({
      commandId: "create-proj-mem",
      name: "Memory Project",
      deviceId: "local",
      workspaceDir: projectDir,
    });

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "native-control", "grants.json"),
      scratchRoot: path.join(root, "workspace", "scratch"),
    });
    registry.authorize({ id: project.directoryId, projectId: project.id, path: projectDir, operationId: "grant-mem-1" });

    let mcpToolNames: string[] = [];
    let privateAttemptCode = 0;
    let recallResultText = "";
    let connListText = "";
    let connUseText = "";
    let observedPrompt = "";

    const service = new ExternalAgentService({
      envId: "local",
      rootDir: path.join(root, "workspace"),
      projectRegistry: registry,
      toolHandler: (inv) => installedToolHandler!(inv),
      pipeFactory: async (spec) => {
        let closed = false;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        let mcpConfig: { url: string; http_headers: Record<string, string> } | undefined;
        const emit = (msg: unknown) => {
          if (!closed) spec.onStdout(Buffer.from(`${JSON.stringify(msg)}\n`));
        };
        return {
          write(data: string) {
            if (closed) return;
            for (const line of data.split("\n").filter(Boolean)) {
              const parsed = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
              if (parsed.method === "initialize") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { userAgent: "codex-test" } }));
              } else if (parsed.method === "model/list") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { data: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true }] } }));
              } else if (parsed.method === "thread/start") {
                const cfg = parsed.params?.config as { mcp_servers?: Record<string, { url: string; http_headers: Record<string, string> }> } | undefined;
                mcpConfig = cfg?.mcp_servers ? Object.values(cfg.mcp_servers)[0] : undefined;
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { thread: { id: "thread-mem-1" } } }));
              } else if (parsed.method === "turn/start") {
                observedPrompt = ((parsed.params?.input as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
                queueMicrotask(async () => {
                  emit({ jsonrpc: "2.0", id: parsed.id, result: { turn: { id: "turn-mem-1" } } });
                  if (mcpConfig) {
                    const callMcp = async (method: string, params?: unknown) => {
                      const res = await fetch(mcpConfig!.url, {
                        method: "POST",
                        headers: { ...mcpConfig!.http_headers, "content-type": "application/json" },
                        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                      });
                      return res.json() as Promise<Record<string, any>>;
                    };
                    const listed = await callMcp("tools/list");
                    mcpToolNames = (listed.result?.tools ?? []).map((t: { name: string }) => t.name);

                    // Attempt to pass bank: "private" -> rejected at MCP schema validation (-32602)!
                    const privAttempt = await callMcp("tools/call", {
                      name: "kulo_memory_recall",
                      arguments: { query: "secret", bank: "private" },
                    });
                    privateAttemptCode = privAttempt.error?.code ?? 0;

                    // Valid shared recall
                    const recalled = await callMcp("tools/call", {
                      name: "kulo_memory_recall",
                      arguments: { query: "API 错误约定" },
                    });
                    recallResultText = recalled.result?.content?.[0]?.text ?? "";

                    // Valid shared ingest
                    await callMcp("tools/call", {
                      name: "kulo_memory_ingest",
                      arguments: { title: "新增模块约定", content: "外部智能体验证通过：staged 模式默认启用。" },
                    });

                    // Authorized connection list + brokered HTTP GET (raw secret must be redacted!)
                    const conns = await callMcp("tools/call", { name: "kulo_connections", arguments: {} });
                    connListText = conns.result?.content?.[0]?.text ?? "";

                    const connRes = await callMcp("tools/call", {
                      name: "kulo_connection_use",
                      arguments: { connection_id: savedConn.id, operation: "http", path: "/v1/health", method: "GET" },
                    });
                    connUseText = connRes.result?.content?.[0]?.text ?? "";

                    // Create an HTML deliverable inside staged workspace and stage it via kulo_task_report(files=[...])
                    fs.writeFileSync(path.join(spec.cwd, "summary.html"), "<!doctype html><html><body><h1>Audit Summary</h1></body></html>\n");
                    await callMcp("tools/call", {
                      name: "kulo_task_report",
                      arguments: {
                        state: "ready",
                        summary: "已完成分析并生成 HTML 报告。",
                        deliverable: "详见 summary.html",
                        files: [{ path: "summary.html", name: "summary.html", mime_type: "text/html" }],
                      },
                    });
                  }
                  emit({ method: "turn/completed", params: { threadId: "thread-mem-1", turn: { id: "turn-mem-1", status: "completed" } } });
                });
              } else if (parsed.id !== undefined) {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: {} }));
              }
            }
          },
          close() {
            if (!closed) {
              closed = true;
              resolveExit(0);
            }
          },
          exited,
          cleanup: async () => true,
        };
      },
    });
    cleanups.push(() => service.close());

    vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation((_envId, req) => service.request(req));

    const card = await hub.dispatchTicket({
      commandId: "dispatch-mcp-mem-1",
      title: "检查 API 错误处理并生成报告",
      goal: "查阅共享记忆与健康状态并输出报告",
      scope: "**",
      role: "codex-dev",
      projectId: project.id,
      connectionIds: [savedConn.id],
    });

    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 8000, interval: 30 });

    // 1. Default MCP mounted without collaboration tools (allowSubagents=false)
    expect(mcpToolNames).toEqual(expect.arrayContaining([
      "kulo_task_context",
      "kulo_task_report",
      "kulo_memory_recall",
      "kulo_memory_search_pages",
      "kulo_memory_read_page",
      "kulo_memory_ingest",
      "kulo_connections",
      "kulo_connection_use",
    ]));
    expect(mcpToolNames).not.toContain("kulo_request_collaboration");

    // 2. Pre-dispatch shared memory recall injected into external prompt; zero private bank hits!
    expect(observedPrompt).toContain("架构约定：所有 API 错误统一返回 ProjectError code。");
    expect(privateAttemptCode).toBe(-32602);
    expect(hindsight.privateHits).toEqual([]);
    expect(recallResultText).toContain("ProjectError code");

    // 3. Connection brokered with sealed secret, raw secret redacted from MCP output!
    expect(executeConn).toHaveBeenCalledTimes(1);
    expect(connListText).toContain(savedConn.id);
    expect(connListText).not.toContain(connSecret);
    expect(connUseText).toContain("secret_present=true");
    expect(connUseText).not.toContain(connSecret);

    // 4. HTML file privately staged for Main Agent review
    const state = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(state.tickets[card.id]?.latestReport?.attachments).toHaveLength(1);
    expect(state.tickets[card.id]?.latestReport?.attachments?.[0]?.name).toBe("summary.html");

    // 5. Post-run worklog automatically retained into Hindsight shared bank
    await vi.waitFor(async () => {
      const memDoc = await hub.harness.snapshot(MemoryLifecycleDoc, context);
      const worklog = Object.values(memDoc?.worklogs ?? {}).find((w) => w.ticketId === card.id);
      expect(worklog).toBeDefined();
      expect(hindsight.sharedWrites.length).toBeGreaterThanOrEqual(2); // 1 explicit ingest + 1 automatic worklog!
    }, { timeout: 5000, interval: 30 });
  });
});

describe("Phase 4: External task Watchdog, pending-permission exemption & interrupt+steer recovery", () => {
  it("emits Watchdog alert on stalled external run (while exempting pending permissions) and interrupts+resumes native session via steerTicket(interrupt=true)", async () => {
    const root = makeTempDir("kulo-ext-watchdog-");
    const fakeBinDir = path.join(root, "bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAgy = path.join(fakeBinDir, "agy");
    fs.writeFileSync(fakeAgy, "#!/bin/sh\necho 'agy 1.0.0'\n", { mode: 0o755 });

    const models = createModels();
    const provider = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
    provider.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("[WATCHDOG_OK]")])));
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      watchdogCheckIntervalMs: 40,
      watchdogStallMsOverride: 140,
      config: {
        stateDir: path.join(root, "state"),
        identityDir: path.join(root, "identity"),
        localEnvRoot: path.join(root, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 1,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
        roles: {
          "agy-coder": {
            id: "agy-coder",
            label: "Antigravity 工程师",
            whenToUse: "全栈实现",
            prompt: "执行任务。",
            enabled: true,
            external: { kind: "antigravity", envId: "local", executable: fakeAgy, verifiedAt: 1_700_000_000_000 },
          },
        },
      },
    });
    cleanups.push(() => hub.close());

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "native-control", "grants.json"),
      scratchRoot: path.join(root, "workspace", "scratch"),
    });

    let epochRuns = 0;
    const resumedSessions: Array<string | undefined> = [];

    const service = new ExternalAgentService({
      envId: "local",
      rootDir: path.join(root, "workspace"),
      projectRegistry: registry,
      pipeFactory: async (spec) => {
        let closed = false;
        let promptId: number | string | undefined;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        const emit = (msg: unknown) => {
          if (!closed) spec.onStdout(Buffer.from(`${JSON.stringify(msg)}\n`));
        };
        return {
          write(data: string) {
            if (closed) return;
            for (const line of data.split("\n").filter(Boolean)) {
              const parsed = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
              if (parsed.method === "initialize") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } } } }));
              } else if (parsed.method === "session/new") {
                resumedSessions.push(undefined);
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { sessionId: "acp-session-keep-1" } }));
              } else if (parsed.method === "session/resume") {
                resumedSessions.push(String(parsed.params?.sessionId ?? ""));
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { sessionId: "acp-session-keep-1" } }));
              } else if (parsed.method === "session/prompt") {
                epochRuns++;
                promptId = parsed.id;
                if (epochRuns === 1) {
                  // Emit one tool event, then stall indefinitely until cancelled!
                  queueMicrotask(() => emit({
                    method: "session/update",
                    params: { sessionId: "acp-session-keep-1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Running slow grep" } },
                  }));
                } else {
                  // Epoch 2 (resumed after interrupt+steer): complete cleanly!
                  queueMicrotask(() => {
                    emit({
                      method: "session/update",
                      params: { sessionId: "acp-session-keep-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered and finished in resumed session." } } },
                    });
                    emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
                  });
                }
              } else if (parsed.method === "session/cancel" && promptId !== undefined) {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } }));
              } else if (parsed.id !== undefined) {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: {} }));
              }
            }
          },
          close() {
            if (!closed) {
              closed = true;
              resolveExit(0);
            }
          },
          exited,
          cleanup: async () => true,
        };
      },
    });
    cleanups.push(() => service.close());

    vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation((_envId, req) => service.request(req));

    // Also add a second synthetic external ticket that has pendingPermissions -> must NOT trigger watchdog!
    const permConv = await hub.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: "hub-model" }, tools: [] },
    }, context);
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const oldTime = Date.now() - 10_000;
      state.tickets["T-perm"] = {
        id: "T-perm",
        commandId: "cmd-perm",
        title: "Waiting Permission Ticket",
        goal: "Await approval",
        scope: "**",
        role: "agy-coder",
        status: "running",
        envId: "local",
        workspaceDir: path.join(root, "workspace", "table", "T-perm"),
        workerConversationId: Number(permConv.id),
        runEpoch: 1,
        createdAt: oldTime,
        updatedAt: oldTime,
        startedRunningAt: oldTime,
        externalExecution: {
          binding: { kind: "antigravity", envId: "local", executable: fakeAgy, verifiedAt: 1_700_000_000_000 },
          runId: "run-perm-1",
          lastActivityAt: oldTime,
          pendingPermissions: [{ id: "p-1", title: "Approve shell?", choices: [{ id: "yes", label: "Yes" }] }],
        },
      };
    }, context);

    const card = await hub.dispatchTicket({
      commandId: "dispatch-stalled-1",
      title: "排查卡死外部任务",
      goal: "测试超时巡检与中断续接",
      scope: "**",
      role: "agy-coder",
    });

    // Wait for Watchdog to emit an alert for `card.id` (while NOT alerting for `T-perm`!)
    await vi.waitFor(async () => {
      const entries = await hub.rootConversation.entries({}, 80, undefined, context);
      const watchdogs = entries.items.filter((e) => e.kind === "kulo.worker_watchdog");
      expect(watchdogs.some((e) => (e.data as { ticketId?: string })?.ticketId === card.id)).toBe(true);
      expect(watchdogs.some((e) => (e.data as { ticketId?: string })?.ticketId === "T-perm")).toBe(false);
    }, { timeout: 6000, interval: 40 });

    // Verify enhanced inspectWorker output
    const inspected = await hub.inspectWorker(card.id, context);
    expect(inspected.external?.kind).toBe("antigravity");
    expect(inspected.external?.sessionId).toBe("acp-session-keep-1");
    expect(inspected.recentEntries.some((entry) => entry.summary.includes("[tool] Running slow grep"))).toBe(true);

    // Trigger interrupt + steer to break out of the stalled turn and resume the same sessionId!
    await hub.steerTicket({
      commandId: "steer-interrupt-1",
      ticketId: card.id,
      text: "不要跑全盘 grep，直接检查目标文件并完成任务。",
      interrupt: true,
    }, context);

    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
      expect(snap?.tickets[card.id]?.runEpoch).toBe(2);
    }, { timeout: 8000, interval: 40 });

    expect(resumedSessions).toEqual([undefined, "acp-session-keep-1"]);
    const finalTicket = (await hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
    expect(finalTicket.latestReport?.state).toBe("ready");
    expect(finalTicket.latestReport?.deliverable).toContain("Recovered and finished in resumed session.");

    // Ensure no spurious blocked/failed relay was emitted for epoch 1's intentional interrupt!
    const finalEntries = await hub.rootConversation.entries({}, 100, undefined, context);
    const relaysForTicket = finalEntries.items.filter(
      (e) => e.kind === "kulo.worker_relay" && (e.data as { ticketId?: string })?.ticketId === card.id,
    );
    expect(relaysForTicket).toHaveLength(1);
    expect((relaysForTicket[0]!.data as { state?: string }).state).toBe("ready");
  });
});
