import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import type { EnvManager } from "@kulo/env";
import type { SubagentRecord, TicketRecord, TopicSummary } from "@kulo/protocol";
import { createWorkerTicketTask } from "../packages/hub/src/scheduler.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { createWorkerExtension } from "../packages/hub/src/tools-worker.js";
import {
  KuloStateDoc,
  WorkerRelayEntry,
  computeSlotSummary,
  hasActiveSubagents,
  isTicketUnfinished,
  listSortedTopics,
  releaseProjectWrite,
  releaseSlot,
  ticketsShareWriteScope,
  toTicketCardView,
  tryClaimSlot,
  type KuloDurableState,
} from "../packages/hub/src/state.js";
import type { KuloUploadStore } from "../packages/hub/src/uploads.js";

function ticket(id: string, workspaceDir = `/projects/${id}`, extra: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id, commandId: `command:${id}`, title: id, goal: id, scope: workspaceDir,
    role: "coder", status: "queued", envId: "local", workspaceDir,
    workerConversationId: 2, runEpoch: 1, createdAt: Number(id.replace(/\D/g, "")) || 1,
    updatedAt: 1, ...extra,
  };
}

function state(...tickets: TicketRecord[]): KuloDurableState {
  return {
    nextTicketNumber: 1, tickets: Object.fromEntries(tickets.map((entry) => [entry.id, entry])),
    commandIndex: {}, conversationToTicket: {}, subagents: {}, topics: {}, slots: { holders: [] },
  };
}

function subagent(ticketId: string, subState: SubagentRecord["state"]): SubagentRecord {
  return {
    id: `${ticketId}:S-01`, name: "checker", role: "checker", roleLabel: "checker", ticketId,
    parentConversationId: 2, conversationId: 3, readOnly: true, runs: 1,
    createdAt: 1, updatedAt: 1, state: subState,
  };
}

describe("project scheduler state", () => {
  it("serializes a whole writing ticket while independent and read-only work proceeds", () => {
    const a = ticket("T1", "/projects/shop");
    const b = ticket("T2", "/projects/shop");
    const read = ticket("T3", "/projects/shop", { readOnly: true });
    const other = ticket("T4", "/projects/notes");
    const s = state(a, b, read, other);
    expect(tryClaimSlot(s, a.id, 3)).toBe(true);
    a.status = "running";
    expect(tryClaimSlot(s, b.id, 3)).toBe(false);
    expect(tryClaimSlot(s, read.id, 3)).toBe(true);
    read.status = "running";
    expect(tryClaimSlot(s, other.id, 3)).toBe(true);
    expect(computeSlotSummary(s, 3).used).toBe(3);
    expect(s.slots.writeHolders).toEqual([a.id, other.id]);
    releaseSlot(s, a.id);
    a.status = "ready";
    expect(tryClaimSlot(s, b.id, 3)).toBe(true);
  });

  it("keeps FIFO within overlapping directories even when global slots are free", () => {
    const parent = ticket("T1", "/projects/shop");
    const nested = ticket("T2", "/projects/shop/web");
    const s = state(parent, nested);
    expect(tryClaimSlot(s, nested.id, 4)).toBe(false);
    expect(tryClaimSlot(s, parent.id, 4)).toBe(true);
    parent.status = "running";
    expect(tryClaimSlot(s, nested.id, 4)).toBe(false);
    releaseSlot(s, parent.id);
    parent.status = "ready";
    expect(tryClaimSlot(s, nested.id, 4)).toBe(true);
  });

  it("does not let an offline or write-blocked older ticket block another project", () => {
    const occupied = ticket("T1", "/projects/shop", { status: "running" });
    const waiting = ticket("T2", "/projects/shop");
    const offline = ticket("T3", "/projects/offline", { envId: "offline" });
    const other = ticket("T4", "/projects/notes");
    const s = state(occupied, waiting, offline, other);
    s.slots.holders.push(occupied.id);
    expect(tryClaimSlot(s, other.id, 2, { isRunnable: (candidate) => candidate.envId !== "offline" })).toBe(true);
    expect(s.slots.holders).toEqual([occupied.id, other.id]);
  });

  it("retains one parent slot while any subagent is running and releases only after the tree parks", () => {
    const parent = ticket("T1", "/projects/shop", { status: "pausing" });
    const next = ticket("T2", "/projects/notes");
    const s = state(parent, next);
    s.slots.holders = [parent.id];
    const child = subagent(parent.id, "running");
    s.subagents![child.id] = child;
    expect(hasActiveSubagents(s, parent.id)).toBe(true);
    expect(releaseSlot(s, parent.id)).toBe(false);
    expect(tryClaimSlot(s, next.id, 1)).toBe(false);
    expect(computeSlotSummary(s, 1).used).toBe(1);
    child.state = "waiting";
    parent.status = "waiting";
    parent.waiting = { reason: "user", since: 1 };
    expect(releaseSlot(s, parent.id)).toBe(true);
    expect(tryClaimSlot(s, next.id, 1)).toBe(true);
    expect(computeSlotSummary(s, 1).used).toBe(1);
  });

  it("can free a Worker slot without freeing a directory whose process cleanup is unconfirmed", () => {
    const old = ticket("T1", "/projects/shop", { status: "waiting", cleanupPending: true });
    const same = ticket("T2", "/projects/shop");
    const other = ticket("T3", "/projects/notes");
    const s = state(old, same, other);
    s.slots.holders = [old.id];
    expect(releaseSlot(s, old.id)).toBe(true);
    expect(s.slots.holders).toEqual([]);
    expect(s.slots.writeHolders).toEqual([old.id]);
    expect(tryClaimSlot(s, same.id, 1)).toBe(false);
    expect(tryClaimSlot(s, other.id, 1)).toBe(true);
    old.cleanupPending = false;
    expect(releaseProjectWrite(s, old.id)).toBe(true);
    releaseSlot(s, other.id);
    other.status = "ready";
    expect(tryClaimSlot(s, same.id, 1)).toBe(true);
  });

  it("compares Windows path aliases and canonical identities without merging devices or siblings", () => {
    expect(ticketsShareWriteScope(ticket("T1", "C:\\Work\\Shop"), ticket("T2", "c:/work/shop/web"))).toBe(true);
    expect(ticketsShareWriteScope(ticket("T1", "/projects/shop"), ticket("T2", "/projects/shopping"))).toBe(false);
    expect(ticketsShareWriteScope(ticket("T1", "/link", { directoryId: "inode:42" }), ticket("T2", "/actual", { directoryId: "inode:42" }))).toBe(true);
    expect(ticketsShareWriteScope(ticket("T1", "/projects/shop"), ticket("T2", "/projects/shop", { envId: "remote" }))).toBe(false);
  });

  it("keeps soft-deleted topics out of navigation and exposes wait metadata in cards", () => {
    const a = ticket("T1", "/projects/shop", { status: "waiting", projectId: "P1", waiting: { reason: "env", since: 1 } });
    const s = state(a);
    const topic: TopicSummary = { id: "topic", conversationId: 2, title: "work", projectId: "P1", createdAt: 1, updatedAt: 1 };
    s.topics = { topic, deleted: { ...topic, id: "deleted", deletedAt: 2 } };
    expect(listSortedTopics(s)).toEqual([topic]);
    expect(toTicketCardView(a, []).projectId).toBe("P1");
    expect(toTicketCardView(a, []).waiting?.reason).toBe("env");
    expect(isTicketUnfinished(a)).toBe(true);
    a.status = "stopped";
    expect(isTicketUnfinished(a)).toBe(false);
  });
});

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => Promise<boolean>, timeout = 6_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Scheduler condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function envManager(online: Record<string, boolean>, beforeCreate?: () => Promise<void>): EnvManager {
  return {
    getEnvDescriptor: (id: string) => ({ id, online: Boolean(online[id]) }),
    createWorkerExecutionEnv: () => ({
      createDir: async () => { await beforeCreate?.(); return { ok: true, value: undefined }; },
    }),
  } as unknown as EnvManager;
}

const uploads = { buildMultimodalContent: (content: string) => ({ content }) } as unknown as KuloUploadStore;
const model = { provider: "openai", modelId: "gpt-4o" };

describe("durable project worker scheduling", () => {
  it("does not rearm a repeat when its origin is deleted between completion and report delivery", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage([fauxText("本轮已完成")])));
    let harness!: Harness;
    let deletion: Promise<void> | undefined;
    const workerTask = createWorkerTicketTask({
      envManager: envManager({ local: true }), uploads, getMaxConcurrentWorkers: () => 1,
      onTicketSettled: () => {
        deletion ??= harness.commit(async tx => {
          const state = await tx.doc(KuloStateDoc);
          state.topics!.origin!.deletedAt = Date.now();
        }, BACKGROUND_CONTEXT);
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, BACKGROUND_CONTEXT);
    let taskId = 0;
    await root.commit(async tx => {
      const state = await tx.doc(KuloStateDoc);
      state.topics = { origin: { id: "origin", title: "计划来源", conversationId: Number(root.id), createdAt: 1, updatedAt: 1 } };
      const candidate = ticket("T1", "/shop", { workerConversationId: Number(worker.id), originTopicId: "origin", originConversationId: Number(root.id),
        schedule: { executeAt: Date.now() - 1000, repeatEverySeconds: 60, nextRunAt: null } });
      candidate.activeTaskId = taskId = Number(await tx.createTask(workerTask,
        { ticketId: candidate.id, runEpoch: 1, promptOverride: null }, { ownership: { kind: "conversation" }, background: true }));
      state.tickets[candidate.id] = candidate;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.commit(tx => tx.task(taskId as never), BACKGROUND_CONTEXT))?.state.status === "terminal");
    await deletion;
    const current = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(current.topics?.origin?.deletedAt).toEqual(expect.any(Number));
    expect(current.tickets.T1).toMatchObject({ status: "ready", schedule: { nextRunAt: null } });
    expect(current.tickets.T1?.waiting).toBeUndefined();
  });

  it("parks an kulo_report blocker and relays its question without a Hub wait callback", async () => {
    const question = "服务端口使用 8080 还是 9090？";
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let workerRequests = 0;
    const relays: string[] = [];
    faux.setResponses(Array.from({ length: 8 }, () => (ctx) => {
      const text = ctx.messages.filter((message) => message.role === "user")
        .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      if (text.includes("[KULO_WORKER_RELAY]")) {
        relays.push(text);
        return fauxAssistantMessage([fauxText(question)]);
      }
      workerRequests++;
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "blocked", summary: "端口配置需要确认", question })], { stopReason: "toolUse" });
    }));
    const workerExt = createWorkerExtension({
      getIdentityDir: () => path.join(os.tmpdir(), "kulo-scheduler-private-identity"),
      getMemoryConfig: () => resolveHubConfig({ memory: { enabled: false } }).memory,
    });
    const workerTask = createWorkerTicketTask({ envManager: envManager({ local: true }), uploads, getMaxConcurrentWorkers: () => 1 });
    const registry = createRegistry();
    registry.install(workerExt);
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model, extensions: [] } });
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, extensions: [workerExt] } }, BACKGROUND_CONTEXT);
    let taskId = 0;
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      const candidate = ticket("T1", "/shop", { workerConversationId: Number(worker.id) });
      candidate.activeTaskId = taskId = Number(await tx.createTask(workerTask,
        { ticketId: candidate.id, runEpoch: 1, promptOverride: null }, { ownership: { kind: "conversation" }, background: true }));
      s.tickets[candidate.id] = candidate;
      s.conversationToTicket[String(worker.id)] = candidate.id;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.commit((tx) => tx.task(taskId as never), BACKGROUND_CONTEXT))?.state.status === "terminal");
    await root.waitForIdle(BACKGROUND_CONTEXT);
    const s = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.T1).toMatchObject({ status: "waiting", waiting: { reason: "coordinator", detail: question }, latestReport: { state: "blocked", question } });
    expect(s.tickets.T1?.activeTaskId).toBeUndefined();
    expect(s.slots.holders).toEqual([]);
    expect(s.slots.writeHolders).toEqual([]);
    expect(workerRequests).toBe(1);
    expect(relays).toHaveLength(1);
    expect(relays[0]).toContain(`Blocking Question: ${question}`);
    const history = await root.entries({}, 20, undefined, BACKGROUND_CONTEXT);
    expect(history.items.find(WorkerRelayEntry.is)?.data).toMatchObject({ state: "blocked", question });
  });

  it("keeps a preexisting blocked user wait in waiting state when its scheduler task is acquired", async () => {
    const workerTask = createWorkerTicketTask({ envManager: envManager({ local: true }), uploads, getMaxConcurrentWorkers: () => 0 });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT);
    let taskId = 0;
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      const candidate = ticket("T1", "/shop", {
        status: "blocked", waiting: { reason: "user", since: 1, detail: "请确认" },
        latestReport: { state: "blocked", summary: "等待确认", question: "请确认", at: 1 },
      });
      candidate.activeTaskId = taskId = Number(await tx.createTask(workerTask,
        { ticketId: candidate.id, runEpoch: 1, promptOverride: null }, { ownership: { kind: "conversation" }, background: true }));
      s.tickets[candidate.id] = candidate;
      s.slots.holders = [candidate.id];
      s.slots.writeHolders = [candidate.id];
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.commit((tx) => tx.task(taskId as never), BACKGROUND_CONTEXT))?.state.status === "terminal");
    const s = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.T1).toMatchObject({ status: "waiting", waiting: { reason: "user", detail: "请确认" }, latestReport: { state: "blocked", question: "请确认" } });
    expect(s.tickets.T1?.activeTaskId).toBeUndefined();
    expect(s.slots.holders).toEqual([]);
    expect(s.slots.writeHolders).toEqual([]);
  });

  it.each([false, true])("admits queued instructions and attachments once without clearing a newer instruction (replacement=%s)", async (replacePending) => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage([fauxText("done")])));
    let harness!: Harness;
    let replacement: Promise<unknown> | undefined;
    const admitted: Array<{ text: string; attachments: string[] }> = [];
    const pendingUploads = {
      buildMultimodalContent: (text: string, attachmentIds: string[]) => {
        admitted.push({ text, attachments: attachmentIds });
        if (replacePending) {
          replacement = harness.commit(async (tx) => {
            const s = await tx.doc(KuloStateDoc);
            s.tickets.T1!.resumePrompt = "newer instruction";
            s.tickets.T1!.resumeAttachmentIds = ["newer-attachment"];
          }, BACKGROUND_CONTEXT);
        }
        return { content: text };
      },
    } as unknown as KuloUploadStore;
    const workerTask = createWorkerTicketTask({ envManager: envManager({ local: true }), uploads: pendingUploads, getMaxConcurrentWorkers: () => 1 });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, BACKGROUND_CONTEXT);
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      const candidate = ticket("T1", "/shop", {
        workerConversationId: Number(worker.id), resumePrompt: "queued instruction", resumeAttachmentIds: ["queued-attachment"],
      });
      candidate.activeTaskId = Number(await tx.createTask(workerTask,
        { ticketId: candidate.id, runEpoch: 1, promptOverride: "original objective", attachmentIds: ["original-attachment", "queued-attachment"] },
        { ownership: { kind: "conversation" }, background: true }));
      s.tickets[candidate.id] = candidate;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets.T1?.status === "ready");
    await replacement;
    expect(admitted).toEqual([{ text: "original objective\n\n<follow_up>\nqueued instruction\n</follow_up>", attachments: ["original-attachment", "queued-attachment"] }]);
    const current = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!.tickets.T1!;
    expect(current.completedAt).toBeGreaterThan(current.createdAt);
    expect(current.accumulatedRunningMs).toBeGreaterThanOrEqual(0);
    expect(current.startedRunningAt).toBeUndefined();
    expect(current.resumePrompt).toBe(replacePending ? "newer instruction" : undefined);
    expect(current.resumeAttachmentIds).toEqual(replacePending ? ["newer-attachment"] : undefined);
  });

  it("parks an offline ticket without a model request and lets a later online ticket finish", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let requests = 0;
    faux.setResponses(Array.from({ length: 12 }, () => () => { requests++; return fauxAssistantMessage([fauxText("done")]); }));
    const workerTask = createWorkerTicketTask({ envManager: envManager({ local: true, offline: false }), uploads, getMaxConcurrentWorkers: () => 1 });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
    const first = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, BACKGROUND_CONTEXT);
    const second = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, BACKGROUND_CONTEXT);
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      for (const candidate of [ticket("T1", "/offline", { envId: "offline", workerConversationId: Number(first.id) }), ticket("T2", "/online", { workerConversationId: Number(second.id) })]) {
        candidate.activeTaskId = Number(await tx.createTask(workerTask, { ticketId: candidate.id, runEpoch: 1, promptOverride: null }, { ownership: { kind: "conversation" }, background: true }));
        s.tickets[candidate.id] = candidate;
      }
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets.T2?.status === "ready");
    const s = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.T1?.status).toBe("waiting");
    expect(s.tickets.T1?.waiting?.reason).toBe("env");
    expect(s.slots.holders).toEqual([]);
    expect(requests).toBeGreaterThan(0);
    const history = await first.entries({}, 20, undefined, BACKGROUND_CONTEXT);
    expect(history.items).toHaveLength(0);
  });

  it("does not let an old epoch submit a model turn or release a newer run's qualifications", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let requests = 0;
    faux.setResponses(Array.from({ length: 8 }, () => () => { requests++; return fauxAssistantMessage([fauxText("should not run")]); }));
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const settled: string[] = [];
    const workerTask = createWorkerTicketTask({
      envManager: envManager({ local: true }, async () => { started(); await gate; }), uploads,
      getMaxConcurrentWorkers: () => 1, onTicketSettled: (id) => { settled.push(id); },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    cleanups.push(() => unblock());
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, BACKGROUND_CONTEXT);
    let taskId = 0;
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      const candidate = ticket("T1", "/shop", { workerConversationId: Number(worker.id) });
      candidate.activeTaskId = taskId = Number(await tx.createTask(workerTask, { ticketId: candidate.id, runEpoch: 1, promptOverride: null }, { ownership: { kind: "conversation" }, background: true }));
      s.tickets[candidate.id] = candidate;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await entered;
    await harness.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      s.tickets.T1!.runEpoch = 2;
      s.tickets.T1!.activeTaskId = taskId + 100;
    }, BACKGROUND_CONTEXT);
    unblock();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const s = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.slots.holders).toEqual(["T1"]);
    expect(s.slots.writeHolders).toEqual(["T1"]);
    expect(s.tickets.T1?.activeTaskId).toBe(taskId + 100);
    expect(requests).toBe(0);
    expect(settled).toEqual([]);
  });

  it("aborts an obsolete queued task without releasing a newer epoch's Worker or write slot", async () => {
    const models = createModels();
    const settled: string[] = [];
    const workerTask = createWorkerTicketTask({
      envManager: envManager({ local: true }), uploads, getMaxConcurrentWorkers: () => 0,
      onTicketSettled: (id) => { settled.push(id); },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT);
    let taskId = 0;
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      const candidate = ticket("T1", "/shop");
      candidate.activeTaskId = taskId = Number(await tx.createTask(workerTask,
        { ticketId: candidate.id, runEpoch: 1, promptOverride: null },
        { ownership: { kind: "conversation" }, background: true }));
      s.tickets[candidate.id] = candidate;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await harness.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      s.tickets.T1!.runEpoch = 2;
      s.tickets.T1!.status = "running";
      s.slots.holders = ["T1"];
      s.slots.writeHolders = ["T1"];
    }, BACKGROUND_CONTEXT);
    await harness.abortTask(taskId as never, BACKGROUND_CONTEXT);
    const s = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.slots.holders).toEqual(["T1"]);
    expect(s.slots.writeHolders).toEqual(["T1"]);
    expect(settled).toEqual([]);
  });

  it("persists a timed wait across a Harness restart without keeping a Worker slot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-timer-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([() => fauxAssistantMessage([fauxToolCall("park", {})], { stopReason: "toolUse" })]);
    let harness!: Harness;
    let wakeups = 0;
    const deadline = Date.now() + 1_000;
    const park = defineTool({
      name: "park", description: "park this work until its deadline", parameters: obj({}),
      execute: async (_args, api, context) => {
        await api.commit(async (tx) => {
          const s = await tx.doc(KuloStateDoc);
          s.tickets.T1!.waiting = { reason: "time", since: Date.now(), until: deadline };
        }, context);
        return { output: [{ type: "text", text: "parked" }], control: { terminate: true } };
      },
    });
    const workerExt = defineExtension({ name: "test-parking", tools: [park] });
    const workerTask = createWorkerTicketTask({
      envManager: envManager({ local: true }), uploads, getMaxConcurrentWorkers: () => 1,
      resumeWaitingTicket: async (id, context) => {
        await harness.commit(async (tx) => {
          const s = await tx.doc(KuloStateDoc);
          const candidate = s.tickets[id]!;
          if (candidate.waiting?.reason !== "time") return;
          wakeups++;
          candidate.runEpoch++;
          candidate.status = "queued";
          candidate.waiting = undefined;
          candidate.activeTaskId = undefined;
        }, context);
      },
    });
    const registry = createRegistry();
    registry.install(workerExt);
    registry.install(defineExtension({ name: "test-scheduler", tasks: [workerTask] }));
    const open = async () => Harness.open(await openNodeSqliteStorage(path.join(dir, "session.sqlite")), { models, registry }, BACKGROUND_CONTEXT);
    harness = await open();
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model } });
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, extensions: [workerExt] } }, BACKGROUND_CONTEXT);
    await root.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      const candidate = ticket("T1", "/shop", { workerConversationId: Number(worker.id) });
      candidate.activeTaskId = Number(await tx.createTask(workerTask, { ticketId: candidate.id, runEpoch: 1, promptOverride: null }, { ownership: { kind: "conversation" }, background: true }));
      s.tickets[candidate.id] = candidate;
    }, BACKGROUND_CONTEXT);
    harness.resume();
    await until(async () => (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets.T1?.status === "waiting");
    expect((await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.slots.holders).toEqual([]);
    await harness.close(BACKGROUND_CONTEXT);
    harness = await open();
    harness.resume();
    await until(async () => wakeups === 1);
    harness.resume();
    const s = (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    expect(s.tickets.T1?.status).toBe("queued");
    expect(s.tickets.T1?.runEpoch).toBe(2);
    expect(s.slots.holders).toEqual([]);
    expect(wakeups).toBe(1);
  });
});
