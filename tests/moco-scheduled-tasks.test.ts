import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { MocoStateDoc, WorkerRelayEntry, startMocoHubServer, type MocoHubConfigOverrides } from "@moco/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = () => fauxAssistantMessage([fauxText("已收到。")]);
const report = () => tool("moco_report", { state: "ready", summary: "本轮已完成" });
const isMain = (request: TranscriptContext) => request.tools?.some(item => item.name === "moco_dispatch") ||
  request.messages.some(message => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) &&
    message.toolsAdded.some(item => item.name === "moco_dispatch"));

async function until(check: () => Promise<boolean> | boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= end) throw new Error("Scheduled task condition timed out");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

type Response = (request: TranscriptContext) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>;
async function fixture(worker: Response = report, main: Response = answer) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-schedules-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  models.setProvider(faux.provider);
  const requests: TranscriptContext[] = [];
  faux.setResponses(Array.from({ length: 80 }, () => request => {
    if (isMain(request)) return main(request);
    requests.push(request);
    return worker(request);
  }));
  const config: MocoHubConfigOverrides = {
    stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), localEnvRoot: path.join(directory, "runtime"),
    authToken: HUB_TEST_ADMIN_TOKEN, watchdogMinutes: 0, maxConcurrentWorkers: 2, memory: { enabled: false },
    model: { baseUrl: "http://127.0.0.1:9/v1", defaultModel: "gpt-4o", thinkingLevel: "off" },
  };
  let hub = await openTestHub({ config, models });
  cleanups.push(() => hub.close());
  const dispatch = (commandId: string, at: number, repeatEverySeconds?: number) => hub.dispatchTicket({
    commandId, title: `定时任务 ${commandId}`, goal: `SCHEDULE_GOAL_${commandId}`, scope: "仅当前授权目录",
    executeAt: new Date(at).toISOString(), ...(repeatEverySeconds === undefined ? {} : { repeatEverySeconds }),
  });
  return {
    get hub() { return hub; }, requests, dispatch,
    close: () => hub.close(),
    open: async () => { hub = await openTestHub({ config, models }); return hub; },
  };
}

describe("scheduled Worker tickets using native durable waits", () => {
  it("atomically assigns one Worker conversation per command with the final workspace and instructions", async () => {
    const f = await fixture();
    const conversations = async () => (await f.hub.harness.commit(tx => tx.scanConversations({}, 100), context)).items.map(row => Number(row.id));
    const original = new Set(await conversations());
    const executeAt = new Date(Date.now() + 86_400_000).toISOString();
    const submit = (commandId: string) => f.hub.dispatchTicket({ commandId, title: "identical work", goal: "inspect later", scope: "task workspace", executeAt });
    const [first, replay, independent] = await Promise.all([submit("first"), submit("first"), submit("independent")]);
    expect(replay.id).toBe(first.id);
    expect(independent.id).not.toBe(first.id);

    const state = (await f.hub.harness.snapshot(MocoStateDoc, context))!;
    const records = Object.values(state.tickets);
    expect(records).toHaveLength(2);
    const workerIds = records.map(ticket => ticket.workerConversationId).sort();
    expect((await conversations()).filter(id => !original.has(id)).sort()).toEqual(workerIds);
    for (const ticket of records) {
      const agent = await f.hub.harness.snapshot(AgentDoc, ticket.workerConversationId as ConversationId, context);
      const conv = (await f.hub.harness.conversation(ticket.workerConversationId as ConversationId, context))!;
      const resolvedAgent = await conv.agent(context);
      const mandate = await resolvedAgent.sections
        .find((sec) => sec.key === "moco_worker_mandate")
        ?.render({ conversationId: conv.id, agent: resolvedAgent, env: undefined, shown: {}, read: f.hub.harness }, context);
      expect(state.conversationToTicket[String(ticket.workerConversationId)]).toBe(ticket.id);
      expect(ticket.workspaceDir).toContain(ticket.id);
      expect(ticket.scratchDir).toContain(ticket.id);
      expect(agent?.cwd).toBe(ticket.workspaceDir);
      expect(mandate).toContain(ticket.workspaceDir);
      expect(mandate).toContain(ticket.scratchDir!);
    }
    await f.close();
    await f.open();
    const executor = f.hub.getSettingsView().blocks.executor;
    await f.hub.updateSettingsBlock("executor", executor.revision, { ...executor.value, paused: true });
    expect((await submit("first")).id).toBe(first.id);
    await expect(submit("new-while-paused")).rejects.toThrow(/派发当前已暂停/);
    expect((await conversations()).filter(id => !original.has(id)).sort()).toEqual(workerIds);
  });

  it("leaves the ledger and its conversations untouched when dispatch admission rejects the ticket", async () => {
    const f = await fixture();
    const conversations = async () => (await f.hub.harness.commit(tx => tx.scanConversations({}, 100), context)).items;
    const before = await conversations();
    await expect(f.hub.dispatchTicket({ commandId: "__proto__", title: "bad key", goal: "inspect later", scope: "task workspace" }))
      .rejects.toMatchObject({ code: "invalid_command_id" });
    await expect(f.hub.dispatchTicket({ commandId: "invalid-replacement", title: "replacement", goal: "inspect later", scope: "task workspace",
      executeAt: new Date(Date.now() + 86_400_000).toISOString(), supersedes: [{ ticketId: "missing", reason: "retry" }] })).rejects.toThrow(/替代/);
    expect(await conversations()).toEqual(before);
    const state = await f.hub.harness.snapshot(MocoStateDoc, context);
    expect(state?.tickets).toEqual({});
    expect(state?.nextTicketNumber).toBe(1);
  });

  it("repairs partial attachment binding from the admitted ticket when its command is retried", async () => {
    const f = await fixture();
    const input = f.hub.uploads.saveUpload({ name: "original.txt", mimeType: "text/plain", bytes: Buffer.from("input"), ownerId: "local" });
    const another = f.hub.uploads.saveUpload({ name: "another.txt", mimeType: "text/plain", bytes: Buffer.from("other"), ownerId: "another-client" });
    const params = { commandId: "attachment-replay", title: "attachment", goal: "inspect later", scope: "task workspace",
      executeAt: new Date(Date.now() + 86_400_000).toISOString(), attachmentIds: [input.id] };
    const bind = f.hub.uploads.bindAttachments.bind(f.hub.uploads);
    vi.spyOn(f.hub.uploads, "bindAttachments").mockImplementation((refs, scope, ...rest) => {
      if (scope.startsWith("ticket:")) throw new Error("simulated attachment metadata failure");
      bind(refs, scope, ...rest);
    });
    await expect(f.hub.dispatchTicket(params)).rejects.toThrow("simulated attachment metadata failure");
    await f.close();
    await f.open();
    const otherTopic = await f.hub.createTopic("other conversation");
    await expect(f.hub.dispatchTicket({ ...params, originConversationId: otherTopic.conversationId })).rejects.toMatchObject({ code: "dispatch_command_conflict" });
    expect(f.hub.uploads.getUpload(input.id)?.record.referenceScopes).toEqual([expect.stringMatching(/^conversation:/)]);
    const card = await f.hub.dispatchTicket({ ...params, attachmentIds: [another.id] });
    const state = (await f.hub.harness.snapshot(MocoStateDoc, context))!;
    const worker = state.tickets[card.id]!.workerConversationId;
    expect(state.tickets[card.id]!.inputAttachmentIds).toEqual([input.id]);
    expect(f.hub.uploads.getUpload(input.id)?.record.referenceScopes).toEqual(expect.arrayContaining([`conversation:${worker}`, `ticket:${card.id}`]));
    expect(f.hub.uploads.getUpload(another.id)?.record.referenceScopes).toEqual([]);
  });

  it("restores the committed attachment scopes before a scheduled Worker runs after restart without a client retry", async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let assetId: string;
    const seenScopes: string[][] = [];
    f = await fixture(() => {
      seenScopes.push(f.hub.uploads.getUpload(assetId)?.record.referenceScopes ?? []);
      return report();
    });
    assetId = f.hub.uploads.saveUpload({ name: "worker-input.txt", mimeType: "text/plain", bytes: Buffer.from("input"), ownerId: "local" }).id;
    vi.spyOn(f.hub.uploads, "bindAttachments").mockImplementationOnce(() => { throw new Error("interrupted dispatch"); });
    await expect(f.hub.dispatchTicket({ commandId: "scheduled-attachment", title: "scheduled input", goal: "inspect input", scope: "task workspace",
      executeAt: new Date(Date.now() + 1000).toISOString(), attachmentIds: [assetId] })).rejects.toThrow("interrupted dispatch");
    const state = (await f.hub.harness.snapshot(MocoStateDoc, context))!;
    const [ticket] = Object.values(state.tickets);
    expect(ticket).toBeDefined();
    await f.close();
    await f.open();
    await until(async () => (await f.hub.listScheduledTasks()).some(entry => entry.id === ticket!.id && entry.status === "ready"));
    expect(seenScopes).toHaveLength(1);
    expect(seenScopes[0]).toEqual(expect.arrayContaining([`conversation:${ticket!.workerConversationId}`, `ticket:${ticket!.id}`]));
  });

  it("creates from conversation, keeps follow-ups deferred, and runs once after reopening the same ledger", async () => {
    let stage = 0;
    let executeAt = 0;
    const f = await fixture(report, request => {
      if (stage++ === 0) return tool("moco_status", {});
      if (stage > 2) return answer();
      const status = request.messages.find(message => message.role === "toolResult" && message.toolName === "moco_status");
      if (!status || status.role !== "toolResult") throw new Error("Expected native status tool output");
      const snapshot = JSON.parse(status.content.filter(part => part.type === "text").map(part => part.text).join(""));
      expect(snapshot.time_zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(Date.parse(snapshot.current_time)).toBeGreaterThan(Date.now() - 3000);
      executeAt = Date.parse(snapshot.current_time) + 1000;
      return tool("moco_dispatch", { command_id: "chat-schedule", title: "整理项目资料", goal: "SCHEDULE_GOAL_chat-schedule", scope: "仅当前授权目录", execute_at: new Date(executeAt).toISOString() });
    });
    const submission = await f.hub.sendUserMessage("一秒后整理项目资料", { requestId: "create-through-chat" });
    expect((await submission.wait(context)).status).toBe("done");
    const created = (await f.hub.listScheduledTasks())[0]!;
    expect(created).toMatchObject({ status: "waiting", schedule: { executeAt, nextRunAt: executeAt }, waiting: { reason: "time", until: executeAt } });
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    expect(f.requests).toHaveLength(0);
    await f.hub.steerTicket({ commandId: "add-requirement", ticketId: created.id, text: "ALSO_CHECK_REFERENCES" });
    expect(f.requests).toHaveLength(0);
    expect((await f.hub.listScheduledTasks())[0]?.waiting?.until).toBe(executeAt);
    const before = (await f.hub.harness.snapshot(MocoStateDoc, context))!.tickets[created.id]!;
    await until(async () => (await f.hub.harness.commit(tx => tx.task(before.activeTaskId as never), context))?.state.status === "sleeping");
    await f.close();
    await f.open();
    await until(async () => (await f.hub.listScheduledTasks())[0]?.status === "ready");
    const after = (await f.hub.harness.snapshot(MocoStateDoc, context))!.tickets[created.id]!;
    expect(after.workerConversationId).toBe(before.workerConversationId);
    expect(after.schedule).toEqual({ executeAt, nextRunAt: null });
    expect(f.requests).toHaveLength(1);
    const sent = JSON.stringify(f.requests[0]?.messages);
    expect(sent).toContain("SCHEDULE_GOAL_chat-schedule");
    expect(sent).toContain("ALSO_CHECK_REFERENCES");
    expect((await f.hub.listScheduledTasks())[0]?.id).toBe(created.id);
  });

  it("repeats serially on the original anchor and skips intervals missed during a long run", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let runs = 0;
    const f = await fixture(async () => { if (++runs === 1) await gate; return report(); });
    cleanups.push(release);
    const executeAt = Date.now() + 100;
    const card = await f.dispatch("repeat", executeAt, 1);
    await until(() => runs === 1);
    expect((await f.hub.listScheduledTasks())[0]?.schedule?.nextRunAt).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 2150));
    expect(runs).toBe(1);
    const finishedAt = Date.now();
    release();
    await until(async () => (await f.hub.listScheduledTasks())[0]?.schedule?.nextRunAt != null);
    const repeated = (await f.hub.listScheduledTasks())[0]!;
    expect(repeated).toMatchObject({ id: card.id, status: "waiting", waiting: { reason: "time" } });
    expect(repeated.schedule!.nextRunAt!).toBeGreaterThan(finishedAt);
    expect((repeated.schedule!.nextRunAt! - executeAt) % 1000).toBe(0);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    await until(() => runs === 2);
    await f.hub.stopScheduledTask(card.id);
    expect((await f.hub.listScheduledTasks())[0]).toMatchObject({ status: "stopped", schedule: { nextRunAt: null } });
    expect((await f.hub.getBoardSnapshot()).tickets).toHaveLength(1);
  });

  it.each(["report", "wait"])("relays a scheduled task's user question once after moco_%s and waits for the answer", async mode => {
    const question = "是否授权继续使用备用服务？";
    const f = await fixture(() => mode === "report"
      ? tool("moco_report", { state: "blocked", summary: "备用服务需要授权", question })
      : tool("moco_wait", { reason: "user", detail: question }));
    const card = await f.dispatch(`user-question-${mode}`, Date.now() + 50, 1);
    await until(async () => (await f.hub.listScheduledTasks())[0]?.waiting?.reason === "user");
    await until(async () => (await f.hub.rootConversation.context(context)).entries.filter(WorkerRelayEntry.is).length === 1);
    await f.hub.rootConversation.waitForIdle(context);
    const relays = (await f.hub.rootConversation.context(context)).entries.filter(WorkerRelayEntry.is);
    expect(relays).toHaveLength(1);
    expect(relays[0]?.data).toMatchObject({ ticketId: card.id, state: "blocked", question });
    expect((await f.hub.listScheduledTasks())[0]).toMatchObject({ status: "waiting", waiting: { reason: "user", detail: question }, schedule: { nextRunAt: null } });
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    expect(f.requests).toHaveLength(1);
  });

  it("keeps stopped entries visible, deletes only the schedule entry, and never revives either after restart", async () => {
    const f = await fixture();
    const due = Date.now() + 700;
    const stopped = await f.dispatch("stop", due, 1);
    const deleted = await f.dispatch("delete", due, 1);
    await f.hub.stopScheduledTask(stopped.id);
    const epoch = (await f.hub.harness.snapshot(MocoStateDoc, context))!.tickets[stopped.id]!.runEpoch;
    await f.hub.stopScheduledTask(stopped.id);
    expect((await f.hub.harness.snapshot(MocoStateDoc, context))!.tickets[stopped.id]!.runEpoch).toBe(epoch);
    await f.hub.deleteScheduledTask(deleted.id);
    await f.hub.deleteScheduledTask(deleted.id);
    expect((await f.hub.listScheduledTasks()).map(item => item.id)).toEqual([stopped.id]);
    await f.close();
    await f.open();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due - Date.now()) + 150));
    expect(f.requests).toHaveLength(0);
    const state = (await f.hub.harness.snapshot(MocoStateDoc, context))!;
    expect(state.tickets[deleted.id]).toMatchObject({ status: "stopped", schedule: { nextRunAt: null, deletedAt: expect.any(Number) } });
    expect(state.commandIndex.delete).toBe(deleted.id);
    expect(state.conversationToTicket[String(state.tickets[deleted.id]!.workerConversationId)]).toBe(deleted.id);
    expect((await f.hub.listScheduledTasks())[0]?.status).toBe("stopped");
  });

  it("fences deletion against an executing repeat before its completion can rearm the timer", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const f = await fixture(async () => { entered = true; await gate; return report(); });
    cleanups.push(release);
    const card = await f.dispatch("delete-running", Date.now() + 50, 1);
    await until(() => entered);
    const removal = f.hub.deleteScheduledTask(card.id);
    await until(async () => (await f.hub.getBoardSnapshot()).tickets[0]?.status === "stopped");
    release();
    await removal;
    expect(await f.hub.listScheduledTasks()).toEqual([]);
    expect((await f.hub.harness.snapshot(MocoStateDoc, context))!.tickets[card.id]?.schedule?.nextRunAt).toBeNull();
    await f.close();
    await f.open();
    expect(f.requests).toHaveLength(1);
    expect(await f.hub.listScheduledTasks()).toEqual([]);
  });

  it("preserves the completed result when deleting a finished one-time schedule", async () => {
    const f = await fixture();
    const card = await f.dispatch("delete-completed", Date.now() + 50);
    await until(async () => (await f.hub.listScheduledTasks())[0]?.status === "ready");
    await f.hub.deleteScheduledTask(card.id);
    expect(await f.hub.listScheduledTasks()).toEqual([]);
    expect((await f.hub.harness.snapshot(MocoStateDoc, context))!.tickets[card.id]).toMatchObject({
      status: "ready", latestReport: { state: "ready", summary: "本轮已完成" }, schedule: { deletedAt: expect.any(Number) },
    });
  });

  it("defers an overdue execution until the same device becomes available", async () => {
    const f = await fixture();
    const due = Date.now() + 200;
    const card = await f.dispatch("offline", due);
    const descriptor = f.hub.envManager.getEnvDescriptor.bind(f.hub.envManager);
    const offline = vi.spyOn(f.hub.envManager, "getEnvDescriptor").mockImplementation(id => {
      const value = descriptor(id);
      return value ? { ...value, online: false } : value;
    });
    await until(async () => (await f.hub.listScheduledTasks())[0]?.waiting?.reason === "env");
    expect(f.requests).toHaveLength(0);
    expect((await f.hub.listScheduledTasks())[0]?.schedule?.nextRunAt).toBe(due);
    offline.mockRestore();
    await f.close();
    await f.open();
    await until(async () => (await f.hub.listScheduledTasks())[0]?.status === "ready");
    expect((await f.hub.listScheduledTasks())[0]?.envId).toBe(card.envId);
    expect(f.requests).toHaveLength(1);
  });

  it("rejects invalid deadlines and repeat intervals without admitting a task", async () => {
    const f = await fixture();
    const base = { commandId: "invalid", title: "无效定时", goal: "检查输入", scope: "当前目录" };
    for (const change of [
      { executeAt: "not-a-date" }, { executeAt: "2026-11-16T09:00:00" }, { executeAt: "2026-99-99T00:00:00Z" },
      { repeatEverySeconds: 60 }, { executeAt: new Date().toISOString(), repeatEverySeconds: 0 },
      { executeAt: new Date().toISOString(), repeatEverySeconds: -1 },
      { executeAt: new Date().toISOString(), repeatEverySeconds: 0.5 },
      { executeAt: new Date().toISOString(), repeatEverySeconds: Number.MAX_SAFE_INTEGER },
    ]) await expect(f.hub.dispatchTicket({ ...base, ...change })).rejects.toMatchObject({ status: 400, code: "invalid_schedule" });
    expect(await f.hub.listScheduledTasks()).toEqual([]);
    expect((await f.hub.getBoardSnapshot()).tickets).toEqual([]);
    expect(f.requests).toHaveLength(0);
  });

  it("authenticates list, stop, and delete and returns real missing-task errors", async () => {
    const f = await fixture();
    const task = await f.dispatch("http", Date.now() + 60_000, 60);
    const server = await startMocoHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    const base = `${server.url}/api/scheduled-tasks`;
    const headers = { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` };
    for (const [url, method] of [[base, "GET"], [`${base}/${task.id}/stop`, "POST"], [`${base}/${task.id}`, "DELETE"]]) {
      expect((await fetch(url!, { method })).status).toBe(401);
    }
    const listed = await fetch(base, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).tasks).toEqual([expect.objectContaining({ id: task.id, schedule: expect.objectContaining({ repeatEverySeconds: 60 }) })]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const stopped = await fetch(`${base}/${task.id}/stop`, { method: "POST", headers });
      expect(stopped.status).toBe(200);
      expect((await stopped.json()).task.status).toBe("stopped");
    }
    for (let attempt = 0; attempt < 2; attempt++) expect((await fetch(`${base}/${task.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await (await fetch(base, { headers })).json()).toEqual({ tasks: [] });
    expect((await fetch(`${base}/${task.id}/stop`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${base}/missing`, { method: "DELETE", headers })).status).toBe(404);
    expect((await fetch(base, { method: "POST", headers, body: "{}" })).status).toBe(404);
  });
});
