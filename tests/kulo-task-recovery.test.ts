import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, ToolResultEntry, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TicketRecord } from "@kulo/protocol";
import { openTestHub } from "./helpers/secure-hub.js";
import { KuloStateDoc, WorkerRecoveryEntry, WorkerRelayEntry, type KuloDurableState } from "../packages/hub/src/state.js";
import { extractDisplayMessages, extractLiveState } from "../packages/hub/src/hub.js";
import { voiceHistory } from "../packages/hub/src/voice-context.js";
import { VoiceTranscriptEntry } from "../packages/hub/src/voice-transcripts.js";
import { assertRecoveryGuard, beginTicketRecovery, createFailureRecoveryTask, recoveryLeaf, resolveSupersededTickets } from "../packages/hub/src/task-recovery.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const ticket = (id: string, changes: Partial<TicketRecord> = {}): TicketRecord => ({
  id, commandId: id, title: id, goal: "完成原目标", scope: "/project", role: "coder", status: "failed",
  envId: "local", workspaceDir: "/project", workerConversationId: 2, runEpoch: 1, createdAt: 1, updatedAt: 1,
  ...changes,
});
const state = (...tickets: TicketRecord[]): KuloDurableState => ({ nextTicketNumber: 1,
  tickets: Object.fromEntries(tickets.map(t => [t.id, t])), commandIndex: {}, conversationToTicket: {}, slots: { holders: [] } });
const isMain = (ctx: TranscriptContext) => ctx.tools?.some(tool => tool.name === "kulo_dispatch") ||
  ctx.messages.some(message => message.role === "system" && "toolsAdded" in message &&
    Array.isArray(message.toolsAdded) && message.toolsAdded.some(tool => tool.name === "kulo_dispatch"));
async function until(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error("Recovery condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function openHub(response: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number], existingStateDir?: string) {
  const stateDir = existingStateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "kulo-task-recovery-"));
  if (!existingStateDir) cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 60 }, () => response));
  const hub = await openTestHub({ models, config: { stateDir, memory: { enabled: false },
    model: { baseUrl: "http://127.0.0.1:9/v1", defaultModel: "gpt-4o" } } });
  cleanups.push(() => hub.close());
  return hub;
}
// A fresh token of the registered kind wakes the real Hub review handler after fixture clock changes.
const recoveryTask = createFailureRecoveryTask({ review: async () => { throw new Error("Unregistered fixture handler"); } });
async function wakeRecovery(hub: Awaited<ReturnType<typeof openHub>>, id: string, change?: (ticket: TicketRecord) => void) {
  const taskId = await hub.harness.commit(async tx => {
    const s = await tx.doc(KuloStateDoc); const t = s.tickets[id]!; change?.(t);
    return tx.createTask(recoveryTask, { ticketId: id, startedAt: t.recovery!.startedAt }, {
      ownership: { kind: "conversation" }, conversationId: hub.rootConversation.id, background: true,
    });
  }, BACKGROUND_CONTEXT);
  hub.harness.resume();
  return taskId;
}

describe("failure recovery lineage", () => {
  it("keeps real speech and a new voice delegation distinct from hidden recovery history", () => {
    const entries = [
      { kind: WorkerRecoveryEntry.kind, id: 1, data: {} },
      { kind: VoiceTranscriptEntry.kind, id: 2, data: { role: "user" } },
      { kind: "pi.assistant", id: 3, data: {} },
      { kind: "kulo.voice.delegation", id: 4, data: {} },
      { kind: "pi.assistant", id: 5, data: {} },
    ];
    const contributions = [
      [{ role: "user", content: "隐藏恢复请求" }],
      [{ role: "user", content: "[KULO_VOICE_CONTEXT: 用户在通话中说]\n新的用户请求" }],
      [{ role: "assistant", content: "[RECOVERY_OK]" }],
      [{ role: "user", content: "新语音委派" }],
      [{ role: "assistant", content: "已处理新请求" }],
    ];
    expect(voiceHistory({ entries, contributions } as never, text => text)).toEqual([
      { role: "user", text: "新的用户请求" }, { role: "assistant", text: "已处理新请求" },
    ]);
    const live = extractLiveState({ entries, docs: { "pi.live": { run: {}, generation: {
      message: { content: [{ type: "text", text: "已处理新请求" }] },
    } } } } as never);
    expect(live.streamingText).toBe("已处理新请求");
  });

  it("keeps old failures until a replacement and its verification succeed, then closes the full chain", () => {
    const original = ticket("A"); beginTicketRecovery(original, 100);
    const alternative = ticket("B", { supersedes: [original.id], recovery: { ...original.recovery! } });
    const final = ticket("C", { status: "running", supersedes: [alternative.id] });
    const s = state(original, alternative, final);
    resolveSupersededTickets(s, final, 200);
    expect(original.status).toBe("failed"); expect(alternative.status).toBe("failed");
    expect(recoveryLeaf(s, original).id).toBe("C");
    final.status = "ready"; resolveSupersededTickets(s, final, 300);
    expect(original).toMatchObject({ status: "closed", closure: { replacementTicketId: "C" } });
    expect(alternative.status).toBe("closed"); expect(original.recovery).toBeUndefined();
  });

  it("fences stale automatic tools after manual retry, a new attempt, or ignore", () => {
    const original = ticket("A"); const recovery = beginTicketRecovery(original, 100); recovery.attempts = 1;
    const s = state(original);
    const guard = { ticketId: "A", rootTicketId: "A", startedAt: 100, attempt: 1, runEpoch: 1 };
    expect(() => assertRecoveryGuard(s, guard)).not.toThrow();
    original.runEpoch++; expect(() => assertRecoveryGuard(s, guard)).toThrow("过期");
    original.runEpoch--; recovery.attempts++; expect(() => assertRecoveryGuard(s, guard)).toThrow("过期");
    recovery.attempts--; original.status = "closed"; expect(() => assertRecoveryGuard(s, guard)).toThrow("过期");
  });

  it("never closes another conversation's task, even in a cyclic lineage", () => {
    const original = ticket("A", { originTopicId: "other", supersedes: ["B"] });
    const done = ticket("B", { status: "ready", supersedes: ["A"] });
    resolveSupersededTickets(state(original, done), done, 200);
    expect(original.status).toBe("failed");
  });
});

describe("durable automatic recovery", () => {
  it("rechecks the failed ancestors of a changed replacement without replaying unrelated reports", async () => {
    const hub = await openHub(() => fauxAssistantMessage([fauxText("ready")]));
    const spoken = vi.spyOn(hub.voiceCalls, "taskUpdated");
    const failed = (id: string) => ticket(id, { originTopicId: "root",
      latestReport: { state: "failed", summary: id, at: 1 },
      recovery: { state: "exhausted", startedAt: 1, attempts: 2, deadlineAt: 2 } });
    await hub.harness.commit(async tx => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets.old = failed("old");
      state.tickets.original = failed("original");
      state.tickets.replacement = ticket("replacement", { originTopicId: "root", status: "blocked", supersedes: ["original"] });
    }, BACKGROUND_CONTEXT);
    hub.getCurrentTicketBoard();
    expect(spoken.mock.calls.map(call => call[1])).toContain("old");
    expect(spoken.mock.calls.map(call => call[1])).not.toContain("original");
    spoken.mockClear();
    await hub.harness.commit(async tx => { delete (await tx.doc(KuloStateDoc)).tickets.replacement; }, BACKGROUND_CONTEXT);
    hub.getCurrentTicketBoard();
    expect(spoken.mock.calls.map(call => call[1])).toEqual(["original"]);
  });

  it("terminates and broadcasts an exhausted control task when submitting recovery keeps failing", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errorLog.mockRestore());
    const changed = vi.fn(async () => {});
    const broken = createFailureRecoveryTask({ review: async () => { throw new Error("恢复控制提交失败"); }, onChanged: changed });
    const registry = createRegistry(); registry.install(defineExtension({ name: "recovery-control-fixture", tasks: [broken] }));
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT); const now = Date.now();
    const taskId = await root.commit(async tx => {
      const s = await tx.doc(KuloStateDoc);
      s.tickets.A = ticket("A", { recovery: { state: "recovering", attempts: 1, startedAt: now,
        deadlineAt: now - 1, rootTicketId: "A" } });
      return tx.createTask(broken, { ticketId: "A", startedAt: now }, { ownership: { kind: "conversation" }, background: true });
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.commit(tx => tx.task(taskId), BACKGROUND_CONTEXT))?.state.status === "terminal");
    expect((await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!.tickets.A?.recovery).toMatchObject({
      state: "exhausted", attempts: 2, lastError: "恢复控制提交失败",
    });
    expect(changed).toHaveBeenCalledTimes(1); expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("rejects an old recovery turn's stop after manual retry and permits a new explicit user stop", async () => {
    let runs = 0; let reviewEntered = false; let autoStopSent = false; let userStop = false; let userStopSent = false;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const hub = await openHub(async ctx => {
      if (isMain(ctx)) {
        if (userStop && !userStopSent) { userStopSent = true; return fauxAssistantMessage([fauxToolCall("kulo_stop", {
          ticket_id: "T-0001", reason: "用户明确请求停止",
        })], { stopReason: "toolUse" }); }
        if (!autoStopSent) {
          reviewEntered = true; await gate; autoStopSent = true;
          return fauxAssistantMessage([fauxToolCall("kulo_stop", { ticket_id: "T-0001", reason: "旧恢复回合误判断" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText(userStop ? "已停止任务。" : "[RECOVERY_OK]")]);
      }
      runs++;
      return fauxAssistantMessage([fauxToolCall("kulo_report", {
        state: runs === 1 ? "failed" : "ready", summary: runs === 1 ? "首个方案暂不可用" : "手动重试已完成",
      })], { stopReason: "toolUse" });
    });
    cleanups.push(release);
    await hub.dispatchTicket({ commandId: "test:old-stop", title: "停止竞态测试", goal: "完成目标", scope: "当前任务" });
    await until(async () => reviewEntered);
    await hub.retryTicket("T-0001");
    await until(async () => (await hub.getBoardSnapshot()).tickets.some(t => t.id === "T-0001" && t.status === "ready"));
    release(); await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await hub.getBoardSnapshot()).tickets.find(t => t.id === "T-0001")?.status).toBe("ready");
    const results = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(ToolResultEntry.is)
      .map(entry => entry.model?.[0]).filter(message => message?.role === "toolResult" && message.toolName === "kulo_stop" && message.isError);
    expect(results).toHaveLength(1); expect(JSON.stringify(results)).toContain("自动恢复回合不能自行停止任务");
    userStop = true;
    const submission = await hub.sendUserMessage("停止这个任务", { requestId: "test:explicit-user-stop" });
    await submission.wait(BACKGROUND_CONTEXT);
    expect((await hub.getBoardSnapshot()).tickets.find(t => t.id === "T-0001")?.status).toBe("stopped");
  });

  it.each([
    { status: "queued", waiting: undefined, label: "排队" },
    { status: "waiting", waiting: { reason: "env", since: 1, detail: "执行设备仍离线" }, label: "等待设备" },
    { status: "waiting", waiting: { reason: "time", since: 1, until: Date.now() + 3_600_000, detail: "约定执行时间尚未到达" }, label: "等待约定时间" },
    { status: "waiting", waiting: { reason: "external", since: 1, detail: "外部服务尚未返回结果" }, label: "等待外部结果" },
    { status: "waiting", waiting: { reason: "project", since: 1, detail: "项目尚不可用" }, label: "等待项目可用" },
    { status: "waiting", waiting: { reason: "connection", since: 1, detail: "连接授权尚未完成" }, label: "等待连接授权" },
  ] as const)("exhausts a replacement left in $label without changing its real state", async ({ status, waiting, label }) => {
    let notifications = 0;
    const hub = await openHub(() => { notifications++; return fauxAssistantMessage([fauxText("恢复仍有等待事项，需要继续处理。")]); });
    const now = Date.now();
    await hub.harness.commit(async tx => {
      const s = await tx.doc(KuloStateDoc);
      const recovery = { state: "recovering" as const, attempts: 1, startedAt: now, deadlineAt: now + 600_000, rootTicketId: "A" };
      s.tickets.A = ticket("A", { recovery });
      s.tickets.B = ticket("B", { supersedes: ["A"], status, ...(waiting ? { waiting } : {}), recovery: { ...recovery }, envId: "offline-device" });
    }, BACKGROUND_CONTEXT);
    const pendingTask = await wakeRecovery(hub, "A");
    await until(async () => (await hub.harness.commit(tx => tx.task(pendingTask), BACKGROUND_CONTEXT))?.state.status === "sleeping");
    expect((await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is)).toHaveLength(0);
    await wakeRecovery(hub, "A", t => { t.recovery!.deadlineAt = Date.now() - 1; });
    await until(async () => (await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")?.recovery?.state === "exhausted");
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const first = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(first.tickets.B).toMatchObject({ status, recovery: { state: "exhausted" } });
    expect(first.tickets.B?.waiting).toEqual(waiting);
    const relay = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is);
    expect(relay).toHaveLength(1); expect(relay[0]?.data.ticketId).toBe("A");
    expect(relay[0]?.data.summary).toContain(label);
    if (waiting) expect(relay[0]?.data.summary).toContain(waiting.detail);
    const taskId = await wakeRecovery(hub, "A");
    await until(async () => (await hub.harness.commit(tx => tx.task(taskId), BACKGROUND_CONTEXT))?.state.status === "terminal");
    expect((await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is)).toHaveLength(1);
    expect(notifications).toBe(1);
  });

  it.each(["running", "pausing"] as const)("keeps a $0 replacement active past the recovery deadline", async status => {
    const hub = await openHub(() => fauxAssistantMessage([fauxText("不应收到恢复失败通知。") ]));
    const now = Date.now();
    await hub.harness.commit(async tx => {
      const s = await tx.doc(KuloStateDoc);
      const recovery = { state: "recovering" as const, attempts: 1, startedAt: now, deadlineAt: now - 1, rootTicketId: "A" };
      s.tickets.A = ticket("A", { recovery });
      s.tickets.B = ticket("B", { status, supersedes: ["A"], recovery: { ...recovery } });
    }, BACKGROUND_CONTEXT);
    const taskId = await wakeRecovery(hub, "A");
    await until(async () => (await hub.harness.commit(tx => tx.task(taskId), BACKGROUND_CONTEXT))?.state.status === "sleeping");
    const s = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.B?.status).toBe(status);
    expect(s.tickets.A?.recovery).toMatchObject({ state: "recovering", attempts: 1 });
    expect((await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is)).toHaveLength(0);
  });

  it("persists a queued replacement's deadline and emits its delayed notification after restart", async () => {
    const realNow = Date.now.bind(Date); let clockOffset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    cleanups.push(() => clock.mockRestore());
    const quiet = () => fauxAssistantMessage([fauxText("替代方案仍在排队，需要继续处理。")]);
    const hub = await openHub(quiet); const now = Date.now(); const stateDir = hub.config.stateDir;
    await hub.harness.commit(async tx => {
      const s = await tx.doc(KuloStateDoc);
      const recovery = { state: "recovering" as const, attempts: 1, startedAt: now,
        deadlineAt: now + 600_000, rootTicketId: "A" };
      s.tickets.A = ticket("A", { recovery });
      s.tickets.B = ticket("B", { status: "queued", supersedes: ["A"], recovery: { ...recovery } });
    }, BACKGROUND_CONTEXT);
    const taskId = await wakeRecovery(hub, "A");
    await until(async () => (await hub.harness.commit(tx => tx.task(taskId), BACKGROUND_CONTEXT))?.state.status === "sleeping");
    await hub.close();
    clockOffset = 600_001;
    const reopened = await openHub(quiet, stateDir);
    await until(async () => (await reopened.getBoardSnapshot()).tickets.find(t => t.id === "A")?.recovery?.state === "exhausted");
    await reopened.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const s = (await reopened.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.B?.status).toBe("queued");
    expect(s.tickets.A?.recovery).toMatchObject({ attempts: 1, state: "exhausted", startedAt: now });
    const relays = (await reopened.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is);
    expect(relays).toHaveLength(1); expect(relays[0]?.data.summary).toContain("排队");
  });

  it("ends the old recovery budget when a real replacement has already asked the user a question", async () => {
    let runs = 0; let replaced = false;
    const question = "是否授权继续使用备用服务？";
    const hub = await openHub(ctx => {
      if (isMain(ctx)) {
        if (!replaced) { replaced = true; return fauxAssistantMessage([fauxToolCall("kulo_dispatch", {
          command_id: "test:blocked-replacement", title: "确认替代方案", goal: "完成目标", scope: "原任务授权内", env_id: "local",
          supersedes: [{ ticket_id: "T-0001", reason: "检查其他可用方案" }],
        })], { stopReason: "toolUse" }); }
        return fauxAssistantMessage([fauxText(question)]);
      }
      runs++;
      return fauxAssistantMessage([fauxToolCall("kulo_report", runs === 1
        ? { state: "failed", summary: "原方案暂不可用" }
        : { state: "blocked", summary: "备用服务需要授权", question })], { stopReason: "toolUse" });
    });
    const spoken = vi.spyOn(hub.voiceCalls, "taskUpdated");
    await hub.dispatchTicket({ commandId: "test:needs-user", title: "完成目标", goal: "完成目标", scope: "原任务授权内" });
    await until(async () => (await hub.getBoardSnapshot()).tickets.some(t => t.id === "T-0002" && t.status === "waiting" && t.waiting?.reason === "coordinator"));
    await until(async () => (await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is)
      .some(entry => entry.data.state === "blocked"));
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    const taskId = await wakeRecovery(hub, "T-0001");
    await until(async () => (await hub.harness.commit(tx => tx.task(taskId), BACKGROUND_CONTEXT))?.state.status === "terminal");
    const s = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets["T-0001"]?.recovery?.state).toBe("exhausted");
    expect(s.tickets["T-0002"]).toMatchObject({ status: "waiting", waiting: { reason: "coordinator", detail: question } });
    const repeated = await wakeRecovery(hub, "T-0001", t => { t.recovery!.deadlineAt = Date.now() - 1; });
    await until(async () => (await hub.harness.commit(tx => tx.task(repeated), BACKGROUND_CONTEXT))?.state.status === "terminal");
    const relays = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is);
    expect(relays).toHaveLength(1); expect(relays[0]?.data).toMatchObject({ state: "blocked", question });
    expect(spoken.mock.calls.some(call => call[3] === "failed")).toBe(false);
  });

  it("silently asks the main model to fix a failure and completes the same ticket", async () => {
    let runs = 0; let steered = false;
    const hub = await openHub(ctx => {
      if (isMain(ctx)) {
        if (!steered) { steered = true; return fauxAssistantMessage([fauxToolCall("kulo_steer", {
          command_id: "test:auto-recover", ticket_id: "T-0001", text: "换用已有可用工具验证原目标。",
        })], { stopReason: "toolUse" }); }
        return fauxAssistantMessage([fauxText("[RECOVERY_OK]")]);
      }
      runs++;
      return fauxAssistantMessage([fauxToolCall("kulo_report", {
        state: runs === 1 ? "failed" : "ready", summary: runs === 1 ? "首个方案暂不可用" : "替代方案已验证成功",
      })], { stopReason: "toolUse" });
    });
    const spokenUpdates = vi.spyOn(hub.voiceCalls, "taskUpdated");
    const dispatched = await hub.dispatchTicket({ commandId: "test:recovery", title: "恢复测试", goal: "完成目标", scope: "当前任务" });
    await until(async () => (await hub.getBoardSnapshot()).tickets.find(t => t.id === dispatched.id)?.status === "ready")
    const s = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets[dispatched.id]).toMatchObject({ status: "ready", runEpoch: 2 });
    expect(s.tickets[dispatched.id]?.recovery).toBeUndefined(); expect(runs).toBe(2);
    const entries = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries;
    expect(entries.filter(WorkerRecoveryEntry.is)).toHaveLength(1);
    expect(entries.filter(WorkerRelayEntry.is).some(entry => entry.data.state === "failed")).toBe(false);
    const displayed = extractDisplayMessages(entries);
    expect(displayed.some(item => item.text.includes("[RECOVERY_OK]") || item.text.includes("首个方案暂不可用"))).toBe(false);
    const recoveryEntry = entries.find(WorkerRecoveryEntry.is)!;
    const live = extractLiveState({ entries: [recoveryEntry], docs: {
      "pi.live": { run: {}, runFailure: { reason: "model_error", detail: "恢复用模型暂不可用" },
        generation: { message: { content: [{ type: "text", text: "[REC" }, { type: "thinking", thinking: "恢复细节" }] } },
        tools: [{ callId: "recover", name: "kulo_inspect", status: "running" }] },
      "pi.inbox": { items: [{ content: "用户新消息已排队" }] },
    } } as never);
    expect(live).toEqual({ busy: true, activeTools: [], queuedCount: 1 });
    const voice = voiceHistory(await hub.rootConversation.context(BACKGROUND_CONTEXT), text => text);
    expect(voice.some(item => item.text.includes("[KULO_WORKER_RECOVERY]") || item.text.includes("[RECOVERY_OK]"))).toBe(false);
    expect(spokenUpdates.mock.calls.some(call => call[3] === "failed")).toBe(false);
  });

  it("delays user failure notification until the window is exhausted, and ignore fences the task", async () => {
    const hub = await openHub(() => fauxAssistantMessage([fauxText("[RECOVERY_OK]")]));
    const now = Date.now();
    await hub.harness.commit(async tx => {
      const s = await tx.doc(KuloStateDoc);
      s.tickets.A = ticket("A", { recovery: { state: "recovering", attempts: 0, startedAt: now,
        deadlineAt: now + 600_000, rootTicketId: "A" } });
    }, BACKGROUND_CONTEXT);
    await wakeRecovery(hub, "A");
    await until(async () => (await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")?.recovery?.attempts === 1);
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    await wakeRecovery(hub, "A", t => { t.recovery!.nextAttemptAt = Date.now() - 1; });
    await until(async () => (await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")?.recovery?.attempts === 2);
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    await wakeRecovery(hub, "A", t => { t.recovery!.nextAttemptAt = Date.now() - 1; });
    expect((await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRecoveryEntry.is)).toHaveLength(2);
    expect((await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")!.recovery?.notifiedAt).toBeUndefined();
    expect((await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is)).toHaveLength(0);
    await wakeRecovery(hub, "A", t => { t.recovery!.deadlineAt = Date.now() - 1; });
    await until(async () => Boolean((await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")?.recovery?.notifiedAt));
    expect((await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")?.recovery?.state).toBe("exhausted");
    await wakeRecovery(hub, "A");
    await hub.rootConversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRelayEntry.is)).toHaveLength(1);
    await hub.closeTicket({ ticketId: "A", commandId: "ignore:A", kind: "obsolete", reason: "忽略" });
    expect((await hub.getBoardSnapshot()).tickets.find(t => t.id === "A")).toMatchObject({ status: "closed" });
    expect((await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!.tickets.A?.recovery).toBeUndefined();
    await expect(hub.retryTicket("A")).rejects.toThrow("stopped or closed");
  });

  it("dispatches an alternative silently and retires the old failure only after success", async () => {
    let runs = 0; let replaced = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hub = await openHub(async ctx => {
      if (isMain(ctx)) {
        if (!replaced) { replaced = true; return fauxAssistantMessage([fauxToolCall("kulo_dispatch", {
          command_id: "test:replacement", title: "使用替代方案", goal: "完成目标", scope: "原任务授权内", env_id: "local",
          supersedes: [{ ticket_id: "T-0001", reason: "改用已有工具" }],
        })], { stopReason: "toolUse" }); }
        return fauxAssistantMessage([fauxText("[RECOVERY_OK]")]);
      }
      runs++;
      if (runs === 2) await gate;
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: runs === 1 ? "failed" : "ready",
        summary: runs === 1 ? "原方案暂不可用" : "目标已通过替代方案完成" })], { stopReason: "toolUse" });
    });
    cleanups.push(release);
    await hub.dispatchTicket({ commandId: "test:original", title: "完成目标", goal: "完成目标", scope: "原任务授权内" });
    await until(async () => (await hub.getBoardSnapshot()).tickets.some(t => t.id === "T-0002" && t.status === "running"));
    const before = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(before.tickets["T-0001"]?.status).toBe("failed");
    expect(before.tickets["T-0002"]?.recovery).toMatchObject({ attempts: 1, rootTicketId: "T-0001" });
    release();
    await until(async () => (await hub.getBoardSnapshot()).tickets.some(t => t.id === "T-0001" && t.status === "closed"));
    const after = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(after.tickets["T-0001"]?.closure?.replacementTicketId).toBe("T-0002");
    expect(after.tickets["T-0002"]?.status).toBe("ready");
    const entries = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).entries;
    expect(entries.filter(WorkerRelayEntry.is).some(entry => entry.data.state === "failed")).toBe(false);
    expect(extractDisplayMessages(entries).some(item => item.text.includes("[RECOVERY_OK]"))).toBe(false);
  });

  it("preserves one inherited budget and cleans historical successful replacements across restart", async () => {
    const quiet = () => fauxAssistantMessage([fauxText("[RECOVERY_OK]")]);
    const hub = await openHub(quiet); const stateDir = hub.config.stateDir;
    const now = Date.now();
    await hub.harness.commit(async tx => {
      const s = await tx.doc(KuloStateDoc);
      s.tickets.A = ticket("A"); s.tickets.B = ticket("B", { supersedes: ["A"], createdAt: 2,
        recovery: { state: "recovering", attempts: 2, startedAt: now, deadlineAt: now + 600_000, rootTicketId: "B" } });
      s.tickets.C = ticket("C"); s.tickets.D = ticket("D", { supersedes: ["C"], status: "ready", createdAt: 3 });
      s.tickets.E = ticket("E"); s.tickets.F = ticket("F", { supersedes: ["E"], createdAt: 4 });
    }, BACKGROUND_CONTEXT);
    await hub.close();
    const reopened = await openHub(quiet, stateDir);
    await until(async () => Boolean((await reopened.getBoardSnapshot()).tickets.find(t => t.id === "F")?.recovery?.attempts));
    const s = (await reopened.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.A?.recovery).toMatchObject({ rootTicketId: "B", attempts: 2, startedAt: now });
    expect(s.tickets.B?.recovery?.startedAt).toBe(now);
    expect(s.tickets.C).toMatchObject({ status: "closed", closure: { replacementTicketId: "D" } });
    expect(s.tickets.E?.recovery?.rootTicketId).toBe("E");
    expect(s.tickets.F?.recovery).toEqual(s.tickets.E?.recovery);
    const reviews = (await reopened.rootConversation.context(BACKGROUND_CONTEXT)).entries.filter(WorkerRecoveryEntry.is);
    expect(reviews).toHaveLength(1); expect(reviews[0]?.data.ticketId).toBe("F");
  });
});
