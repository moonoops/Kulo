import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { KuloHub } from "@kulo/hub";
import { KuloConnections } from "../packages/hub/src/connections.js";
import { LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import type { ConnectionExecutionBackend } from "../packages/hub/src/connection-execution.js";
import { getConnectionApplication, type ConnectionApplicationBackend } from "../packages/hub/src/connection-applications.js";
import type { ConnectionAccessRequest, ConnectionUseResult } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const nativeWorkers = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const credential = "kulo-worker-connection-synthetic-secret-54321";
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (summary = "已完成连接任务") => call("kulo_report", { state: "ready", summary });
type Respond = (ctx: TranscriptContext) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>;

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

function isMain(ctx: TranscriptContext): boolean {
  return Boolean(ctx.tools?.some((tool) => tool.name === "kulo_dispatch")) || ctx.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === "kulo_dispatch"));
}

function hasTool(ctx: TranscriptContext, name: string): boolean {
  return Boolean(ctx.tools?.some((tool) => tool.name === name)) || ctx.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === name));
}

function toolResult(ctx: TranscriptContext, name: string): unknown {
  const message = ctx.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === name).at(-1);
  if (!message || message.role !== "toolResult") return undefined;
  const value = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  try { return JSON.parse(value); } catch { return undefined; }
}

function containsRelay(ctx: TranscriptContext): boolean {
  return ctx.messages.some((entry) => entry.role === "user" && JSON.stringify(entry.content).includes("[KULO_CONNECTION_REQUEST]"));
}

async function until(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 12_000, interval: 25 });
}

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-worker-flow-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, "state");
  const vault = new LocalConnectionVault({ stateDir, keyStore: { getOrCreateKey: async () => Buffer.alloc(32, 19) } });
  const applications: ConnectionApplicationBackend = {
    probe: vi.fn(async () => ({ username: "合成账号" })),
    execute: vi.fn(async () => ({ kind: "app", output: `messages read ${credential}` })),
  };
  const execute = vi.fn<ConnectionExecutionBackend["execute"]>(async (connection, secrets, operation, signal) =>
    operation.kind === "app" ? applications.execute(connection.appId!, secrets, operation, signal)
      : ({ kind: operation.kind, status: 200, output: `operation completed ${credential}` }));
  const executor: ConnectionExecutionBackend = {
    scan: vi.fn(async () => ({ fingerprint: "SHA256:connection-flow-fixture", lines: [] })),
    trust: vi.fn(async () => {}), execute,
  };
  const manager = new KuloConnections({ stateDir, vault, executor, applications, platform: "darwin" });
  const provider = fauxProvider({ provider: "openai", models: [{ id: "connection-flow-model" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const transcripts: string[] = [];
  let mainRespond: Respond = () => answer("已收到。");
  let workerRespond: Respond = () => report();
  provider.setResponses(Array.from({ length: 100 }, () => async (ctx: TranscriptContext) => {
    transcripts.push(JSON.stringify(ctx));
    return isMain(ctx) ? mainRespond(ctx) : workerRespond(ctx);
  }));
  const hub = await KuloHub.open({ models, connectionManager: manager, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir, identityDir: path.join(directory, "identity"), localEnvRoot: path.join(directory, "runtime"),
    enableLocalEnv: true, watchdogMinutes: 0, memory: { enabled: false }, maxConcurrentWorkers: 2,
    model: { defaultProvider: "openai", defaultModel: "connection-flow-model", thinkingLevel: "off", apiKey: "" },
  } });
  cleanups.push(() => hub.close());
  const connection = await manager.save({ name: "测试 API", kind: "api-key", url: "https://connection.example.test", secrets: { apiKey: credential } });
  return { hub, manager, execute, applications, connection, transcripts, directory,
    main: (respond: Respond) => { mainRespond = respond; }, worker: (respond: Respond) => { workerRespond = respond; } };
}

describe.skipIf(!nativeWorkers)("connection permissions across real Hub Worker lifecycle", () => {
  it("gives a read-only Worker an application reference while rejecting its write operation", async () => {
    const f = await fixture();
    const input = await f.manager.prepare({ clientId: "app-worker-test", category: "app", appId: "messages" });
    const application = await f.manager.submitInput(input.id, "app-worker-test", { name: "消息", kind: "app", category: "app", appId: "messages" });
    const definition = getConnectionApplication("messages");
    const read = definition.actions.find((action) => action.readOnly && action.id.endsWith("list"))!;
    const write = definition.actions.find((action) => !action.readOnly)!;
    let phase = 0;
    const outcomes: unknown[] = [];
    f.worker((ctx) => {
      outcomes.push(...ctx.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === "kulo_connection_use"));
      if (phase++ === 0) return call("kulo_connection_use", { connection_id: application.id, operation: "app", action: write.id, params_json: '{"to":"synthetic-recipient","text":"synthetic-body"}' });
      if (phase === 2) return call("kulo_connection_use", { connection_id: application.id, operation: "app", action: read.id, params_json: "{}" });
      return report("已读取消息，只读任务未发送内容");
    });
    const card = await f.hub.dispatchTicket({ commandId: "application-readonly", title: "检查消息", goal: "只读查询消息", scope: "已授权应用", role: "scout", connectionIds: [application.id] });
    await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "ready");
    expect(outcomes).toContainEqual(expect.objectContaining({ isError: true }));
    expect(f.applications.execute).toHaveBeenCalledTimes(1);
    expect(f.applications.execute).toHaveBeenCalledWith("messages", {}, { kind: "app", action: read.id, params: {} }, expect.any(AbortSignal));
    expect(f.transcripts.join("\n")).toContain("messages read");
    expect(f.transcripts.join("\n")).not.toContain(credential);
  });

  it("lets a granted Worker use ordinary remembered information without exposing reclassified credentials", async () => {
    const f = await fixture();
    await f.manager.processText("请记住我的饮食偏好：不吃芹菜", { requestId: "remember-food" });
    const information = (await f.manager.snapshot()).connections.find((record) => record.category === "information")!;
    expect(information.canReadInformation).toBe(true);
    let phase = 0;
    f.worker(() => phase++ === 0 ? call("kulo_connection_use", { connection_id: information.id, operation: "information", action: "read" }) : report("已使用饮食偏好"));
    const card = await f.hub.dispatchTicket({ commandId: "information-readonly", title: "查看偏好", goal: "只读查询记住的资料", scope: "已授权资料", role: "scout", connectionIds: [information.id] });
    await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "ready");
    expect(f.transcripts.join("\n")).toContain("不吃芹菜");
    expect(f.execute).not.toHaveBeenCalled();
    const protectedCard = await f.manager.save({ kind: "custom", category: "credential", name: "登录资料", secrets: { opaque: credential } });
    const moved = await f.manager.describe({ id: protectedCard.id, expectedRevision: protectedCard.revision, category: "information" });
    expect(moved.canReadInformation).toBe(false);
    await expect(f.hub.connections.use({ kind: "orchestrator", conversationId: Number(f.hub.rootConversation.id) },
      { connectionId: moved.id, operation: { kind: "information", action: "read" } }, BACKGROUND_CONTEXT)).rejects.toThrow(/受保护|不能/);
    expect(f.transcripts.join("\n")).not.toContain(credential);
  });

  it("passes connection references with dispatch, uses the trusted executor, redacts its output and revokes the settled run", async () => {
    const f = await fixture();
    let phase = 0;
    f.worker(() => phase++ === 0 ? call("kulo_connection_use", { connection_id: f.connection.id, operation: "http", path: "/status", method: "POST",
      body: '{"check":true}', content_type: "application/json" }) : report());
    const card = await f.hub.dispatchTicket({ commandId: "connection-dispatch", title: "检查服务", goal: "检查远程 API", scope: "指定连接", connectionIds: [f.connection.id] });
    await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "ready");
    const detail = await f.hub.inspectTicketDetail(card.id);
    expect(detail.ticket.connectionIds).toEqual([f.connection.id]);
    const execution = detail.transcript.flatMap((item) => item.toolCalls ?? []).find((tool) => tool.name === "kulo_connection_use");
    expect(execution?.result).toMatchObject({ isError: false, text: expect.stringContaining("operation completed") });
    expect(JSON.stringify(detail.transcript)).not.toContain(credential);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ id: f.connection.id }), { apiKey: credential },
      { kind: "http", path: "/status", method: "POST", body: '{"check":true}', headers: { "Content-Type": "application/json" } }, expect.any(AbortSignal));
    expect(f.manager.hasGrant(card.id, detail.ticket.runEpoch, f.connection.id)).toBe(false);
    expect(f.transcripts.join("\n")).not.toContain(credential);
    expect(f.transcripts.join("\n")).toContain("operation completed");
    expect((await f.manager.snapshot()).requests).toHaveLength(0);
    expect(fs.readFileSync(path.join(f.directory, "state", "connection-vault.json"), "utf8")).not.toContain(credential);
  });

  it("refuses a saved connection when dispatch did not authorize it", async () => {
    const f = await fixture();
    let phase = 0;
    const toolErrors: unknown[] = [];
    f.worker((ctx) => {
      if (!hasTool(ctx, "kulo_connection_use")) return call("tool_search", { query: "kulo_connection_use", limit: 3 });
      toolErrors.push(...ctx.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === "kulo_connection_use"));
      return phase++ === 0 ? call("kulo_connection_use", { connection_id: f.connection.id, operation: "http", path: "/status" }) : report("没有连接授权，未执行远程操作");
    });
    const card = await f.hub.dispatchTicket({ commandId: "connection-denied", title: "检查权限", goal: "检查连接权限", scope: "任务" });
    await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "ready");
    expect(f.execute).not.toHaveBeenCalled();
    expect(toolErrors).toContainEqual(expect.objectContaining({ isError: true }));
  });

  it("requires fresh approval when a connection is changed after task dispatch", async () => {
    const f = await fixture();
    let releaseWorker!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    cleanups.push(() => releaseWorker());
    let entered = false, phase = 0;
    const toolErrors: unknown[] = [];
    f.worker(async (ctx) => {
      if (phase++ === 0) { entered = true; await gate; return call("kulo_connection_use", { connection_id: f.connection.id, operation: "http", path: "/status" }); }
      toolErrors.push(...ctx.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === "kulo_connection_use"));
      return report("连接已变化，等待重新授权后再执行");
    });
    const card = await f.hub.dispatchTicket({ commandId: "connection-revised", title: "检查连接版本", goal: "检查远程服务", scope: "指定连接", connectionIds: [f.connection.id] });
    await until(() => entered);
    await f.manager.save({ id: f.connection.id, expectedRevision: f.connection.revision, name: "更新的 API", kind: "api-key",
      url: "https://replacement.example.test", secrets: { apiKey: "replacement-connection-synthetic-secret" } });
    releaseWorker();
    await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "ready");
    expect(f.execute).not.toHaveBeenCalled();
    expect(toolErrors).toContainEqual(expect.objectContaining({ isError: true }));
  });

  for (const decision of ["approve", "reject", "grant"] as const) {
    it(`parks a Worker, relays its request to the originating main model and resumes after ${decision}`, async () => {
      const f = await fixture();
      let releaseMain!: () => void;
      const mainGate = new Promise<void>((resolve) => { releaseMain = resolve; });
      cleanups.push(() => releaseMain());
      let workerPhase = 0, mainPhase = 0;
      const approved = decision !== "reject";
      f.worker((ctx) => {
        if (workerPhase === 0 && !hasTool(ctx, "kulo_connection_request")) {
          return call("tool_search", { query: "kulo_connection_request", limit: 3 });
        }
        return workerPhase++ === 0
          ? call("kulo_connection_request", { connection_id: f.connection.id, reason: "需要查看远程状态" })
          : workerPhase === 2
            ? call("kulo_connection_use", { connection_id: f.connection.id, operation: "http", path: "/status" })
            : report(approved ? "已使用批准的连接" : "权限被拒绝，已保留未执行部分");
      });
      f.main(async (ctx) => {
        if (!containsRelay(ctx)) return answer("已收到。");
        const stage = mainPhase++;
        if (stage === 0) { await mainGate; return call("kulo_connections", {}); }
        if (stage === 1) {
          const result = toolResult(ctx, "kulo_connections") as { requests?: ConnectionAccessRequest[] } | undefined;
          const request = result?.requests?.find((entry) => entry.status === "pending");
          if (request) return decision === "grant"
            ? call("kulo_connection_grant", { ticket_id: request.ticketId, connection_ids: [request.connectionId] })
            : call("kulo_connection_decide", { request_id: request.id, decision });
        }
        return answer("连接权限已处理。");
      });
      const topic = await f.hub.createTopic("连接任务来源", BACKGROUND_CONTEXT);
      const card = await f.hub.dispatchTicket({ commandId: `connection-request-${decision}`, title: "查询远程状态", goal: "查询指定服务", scope: "指定连接", originConversationId: topic.conversationId });
      await until(async () => {
        const ticket = (await f.hub.inspectTicketDetail(card.id)).ticket;
        return ticket.status === "waiting" && ticket.waiting?.reason === "connection";
      });
      expect(f.execute).not.toHaveBeenCalled();
      expect(workerPhase).toBe(1);
      const pending = (await f.manager.snapshot()).requests.find((entry) => entry.ticketId === card.id)!;
      expect(pending.status).toBe("pending");
      expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
      const foreign = await f.hub.createTopic("另一个会话", BACKGROUND_CONTEXT);
      await expect(f.hub.connections.decide({ kind: "orchestrator", conversationId: foreign.conversationId },
        { requestId: pending.id, decision: "approve" }, BACKGROUND_CONTEXT)).rejects.toThrow("不属于当前会话");
      releaseMain();
      await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "ready");
      expect((await f.manager.snapshot()).requests.find((entry) => entry.id === pending.id)?.status).toBe(approved ? "approved" : "rejected");
      expect(f.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(workerPhase).toBe(3);
      const ticket = (await f.hub.inspectTicketDetail(card.id)).ticket;
      expect(ticket.connectionIds?.includes(f.connection.id) ?? false).toBe(approved);
      expect(f.transcripts.join("\n")).not.toContain(credential);
      const topicView = await f.hub.getTopicView(topic.id);
      expect(topicView.messages.some((m) => m.text.includes("[KULO_CONNECTION_REQUEST]"))).toBe(false);
    });
  }

  it("aborts an in-flight connection operation and refuses the old caller after a task is stopped", async () => {
    const f = await fixture();
    let activeSignal: AbortSignal | undefined;
    f.execute.mockImplementation(async (_connection, _secrets, operation, signal) => {
      activeSignal = signal;
      return new Promise<ConnectionUseResult>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error("cancelled"));
        else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    let phase = 0;
    f.worker(() => phase++ === 0 ? call("kulo_connection_use", { connection_id: f.connection.id, operation: "http", path: "/slow" }) : report());
    const card = await f.hub.dispatchTicket({ commandId: "connection-stop", title: "运行连接操作", goal: "请求远程状态", scope: "指定连接", connectionIds: [f.connection.id] });
    await until(() => !!activeSignal);
    const before = (await f.hub.inspectTicketDetail(card.id)).ticket;
    await f.hub.stopTicket(card.id, "用户停止", BACKGROUND_CONTEXT);
    await until(() => activeSignal?.aborted === true);
    expect(f.manager.hasGrant(card.id, before.runEpoch, f.connection.id)).toBe(false);
    await expect(f.hub.connections.use({ kind: "worker", conversationId: before.workerConversationId, ticketId: card.id,
      runEpoch: before.runEpoch, readOnly: false, isSubagent: false }, { connectionId: f.connection.id,
      operation: { kind: "http", path: "/status" } }, BACKGROUND_CONTEXT)).rejects.toThrow("已失效");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.hub.inspectTicketDetail(card.id)).ticket.status).toBe("stopped");
  });

  it("revokes a pending request when its task is stopped and refuses a late main-model approval", async () => {
    const f = await fixture();
    f.worker((ctx) => !hasTool(ctx, "kulo_connection_request")
      ? call("tool_search", { query: "kulo_connection_request", limit: 3 })
      : call("kulo_connection_request", { connection_id: f.connection.id, reason: "查看远程状态" }));
    const card = await f.hub.dispatchTicket({ commandId: "connection-stop-pending", title: "申请连接权限", goal: "查看服务", scope: "指定连接" });
    await until(async () => (await f.hub.inspectTicketDetail(card.id)).ticket.status === "waiting");
    const pending = (await f.manager.snapshot()).requests.find((entry) => entry.ticketId === card.id)!;
    expect(pending.status).toBe("pending");
    await f.hub.stopTicket(card.id, "取消等待", BACKGROUND_CONTEXT);
    expect((await f.manager.snapshot()).requests.find((entry) => entry.id === pending.id)?.status).toBe("revoked");
    await expect(f.hub.connections.decide({ kind: "orchestrator", conversationId: Number(f.hub.rootConversation.id) },
      { requestId: pending.id, decision: "approve" }, BACKGROUND_CONTEXT)).rejects.toThrow("任务已结束");
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.hub.inspectTicketDetail(card.id)).ticket.status).toBe("stopped");
  });
});
