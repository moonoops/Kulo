import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KuloHub,
  KuloStateDoc,
  closeSettledTicketsForDeletedTopic,
  type KuloDurableState,
} from "@kulo/hub";
import type { TicketCardView, TicketRecord } from "@kulo/protocol";
import { visibleTaskCards } from "../packages/web/src/features/tasks/task-model";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function makeTicket(overrides: Partial<TicketRecord> & { id: string }): TicketRecord {
  return {
    title: overrides.id,
    goal: "goal",
    scope: "scope",
    role: "scout",
    status: "ready",
    envId: "local",
    workspaceDir: "/tmp/ws",
    workerConversationId: 10,
    originConversationId: 2,
    originTopicId: "topic-a",
    runEpoch: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function makeState(tickets: TicketRecord[], writeHolders: string[] = []): KuloDurableState {
  return {
    nextTicketNumber: tickets.length + 1,
    tickets: Object.fromEntries(tickets.map((t) => [t.id, t])),
    commandIndex: {},
    conversationToTicket: {},
    slots: { holders: [], writeHolders },
  };
}

describe("closeSettledTicketsForDeletedTopic", () => {
  it("closes settled tickets of the deleted topic, clears parked/recovery fields, and preserves cleanupPending and pendingWorkspaceApply guards", () => {
    const readyTicket = makeTicket({
      id: "T-0001",
      status: "ready",
      originTopicId: "topic-del",
      waiting: { reason: "env", since: 50, summary: "stale" },
      activeTaskId: "task-stale",
      resumePrompt: "stale prompt",
      resumeAttachmentIds: ["att-1"],
      wakePending: true,
      schedule: { kind: "cron", expr: "0 9 * * *", nextRunAt: 99999 },
      recovery: { state: "recovering", attempts: 1, startedAt: 50, deadlineAt: 500, rootTicketId: "T-0001" },
      workspaceStaging: {
        mode: "staged",
        targetDir: "/tmp/ws",
        stagedCwd: "/tmp/staged-nodiff",
        stagedDiff: { hasChanges: false, files: [], added: 0, modified: 0, deleted: 0, binaryCount: 0, truncated: false },
      },
    });
    const siblingRecovery = makeTicket({
      id: "T-0002",
      status: "failed",
      originTopicId: "topic-keep",
      recovery: { state: "recovering", attempts: 1, startedAt: 50, deadlineAt: 500, rootTicketId: "T-0001" },
    });
    const convMatchedStopped = makeTicket({
      id: "T-0003",
      status: "stopped",
      originTopicId: undefined,
      originConversationId: 42,
    });
    const cleanupPendingTicket = makeTicket({
      id: "T-0004",
      status: "stopped",
      originTopicId: "topic-del",
      cleanupPending: true,
    });
    const pendingApplyTicket = makeTicket({
      id: "T-0005",
      status: "ready",
      originTopicId: "topic-del",
      workspaceStaging: {
        mode: "staged",
        targetDir: "/tmp/ws",
        stagedCwd: "/tmp/staged-changes",
        stagedDiff: { hasChanges: true, files: [{ path: "a.ts", kind: "modified" }], added: 0, modified: 1, deleted: 0, binaryCount: 0, truncated: false },
      },
    });
    const otherTopicTicket = makeTicket({
      id: "T-0006",
      status: "ready",
      originTopicId: "topic-other",
    });

    const state = makeState(
      [readyTicket, siblingRecovery, convMatchedStopped, cleanupPendingTicket, pendingApplyTicket, otherTopicTicket],
      ["T-0001", "T-0004"],
    );

    const result = closeSettledTicketsForDeletedTopic(state, "topic-del", 500, 42);
    expect(result.closedCount).toBe(2);
    expect(result.stagedToDiscard.map((t) => t.id)).toEqual(["T-0001"]);
    expect(result.stagedToDiscard[0]?.workspaceStaging?.stagedCwd).toBe("/tmp/staged-nodiff");

    // Ready ticket closed & sanitized
    expect(state.tickets["T-0001"]).toMatchObject({
      status: "closed",
      updatedAt: 500,
      closure: { kind: "obsolete", reason: "会话已删除", at: 500 },
    });
    expect(state.tickets["T-0001"]?.waiting).toBeUndefined();
    expect(state.tickets["T-0001"]?.activeTaskId).toBeUndefined();
    expect(state.tickets["T-0001"]?.resumePrompt).toBeUndefined();
    expect(state.tickets["T-0001"]?.resumeAttachmentIds).toBeUndefined();
    expect(state.tickets["T-0001"]?.wakePending).toBeUndefined();
    expect(state.tickets["T-0001"]?.schedule?.nextRunAt).toBeNull();
    expect(state.tickets["T-0001"]?.recovery).toBeUndefined();
    expect(state.tickets["T-0001"]?.workspaceStaging?.stagedCwd).toBeUndefined();
    expect(state.tickets["T-0001"]?.workspaceStaging?.discardedAt).toBe(500);

    // Sibling recovery referencing T-0001 was suppressed without closing the other topic's ticket
    expect(state.tickets["T-0002"]?.status).toBe("failed");
    expect(state.tickets["T-0002"]?.recovery).toBeUndefined();
    expect(state.tickets["T-0002"]?.autoRecoverySuppressed).toBe(true);

    // Conversation-matched stopped ticket closed
    expect(state.tickets["T-0003"]?.status).toBe("closed");
    expect(state.tickets["T-0003"]?.closure).toEqual({ kind: "obsolete", reason: "会话已删除", at: 500 });

    // cleanupPending & pendingWorkspaceApply & other topic tickets untouched; T-0004/T-0005 write locks preserved while T-0001 released
    expect(state.tickets["T-0004"]?.status).toBe("stopped");
    expect(state.tickets["T-0004"]?.cleanupPending).toBe(true);
    expect(state.slots.writeHolders).toEqual(["T-0004", "T-0005"]);
    expect(state.tickets["T-0005"]?.status).toBe("ready");
    expect(state.tickets["T-0006"]?.status).toBe("ready");
  });
});

describe("KuloHub.deleteTopic task rail cleanup", () => {
  it("closes completed topic tickets, broadcasts updates, and keeps archived topic tickets intact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-del-topic-tickets-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const hub = await KuloHub.open({
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: workspace,
        authToken: "test-token",
        host: "127.0.0.1",
        port: 0,
        envTokens: {},
        workerEnvIds: [],
        enableLocalEnv: true,
      },
    });
    cleanups.push(() => hub.close());

    const topicToDelete = await hub.createTopic("待删除会话", BACKGROUND_CONTEXT);
    const topicToArchive = await hub.createTopic("待归档会话", BACKGROUND_CONTEXT);

    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-0001"] = makeTicket({
        id: "T-0001",
        title: "已完成的任务",
        status: "ready",
        completedAt: Date.now(),
        originTopicId: topicToDelete.id,
        originConversationId: topicToDelete.conversationId,
      });
      state.tickets["T-0002"] = makeTicket({
        id: "T-0002",
        title: "归档会话的任务",
        status: "ready",
        completedAt: Date.now(),
        originTopicId: topicToArchive.id,
        originConversationId: topicToArchive.conversationId,
      });
    }, BACKGROUND_CONTEXT);

    // Archiving a topic must NOT close its settled tickets
    await hub.patchTopic(topicToArchive.id, { archived: true }, BACKGROUND_CONTEXT);
    const afterArchive = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(afterArchive?.tickets["T-0002"]?.status).toBe("ready");

    // Subscribe to live ticket broadcasts before deleting topicToDelete
    let lastBroadcastTickets: TicketCardView[] | undefined;
    const unsubscribe = hub.subscribe({
      onTickets: (tickets) => { lastBroadcastTickets = tickets; },
    });
    cleanups.push(unsubscribe);

    await hub.deleteTopic(topicToDelete.id, BACKGROUND_CONTEXT);

    const afterDelete = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(afterDelete?.tickets["T-0001"]).toMatchObject({
      status: "closed",
      closure: { kind: "obsolete", reason: "会话已删除" },
    });
    expect(afterDelete?.tickets["T-0001"]?.closure?.at).toEqual(expect.any(Number));
    expect(afterDelete?.tickets["T-0002"]?.status).toBe("ready");

    // Live broadcast fired and Task Rail visibleTaskCards removes T-0001 while preserving T-0002
    expect(lastBroadcastTickets).toBeDefined();
    const visibleIds = visibleTaskCards(lastBroadcastTickets!, Date.now(), 3).map((t) => t.id);
    expect(visibleIds).not.toContain("T-0001");
    expect(visibleIds).toContain("T-0002");
  });

  it("stops and closes active tickets on deleteTopic({ stopTasks: true }) once cancellation settles", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-del-topic-stop-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const hub = await KuloHub.open({
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: workspace,
        authToken: "test-token",
        host: "127.0.0.1",
        port: 0,
        envTokens: {},
        workerEnvIds: [],
        enableLocalEnv: true,
      },
    });
    cleanups.push(() => hub.close());

    const topic = await hub.createTopic("带等待任务的会话", BACKGROUND_CONTEXT);
    const descriptor = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    const offline = vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => {
      const value = descriptor(id);
      return value && id === "local" ? { ...value, online: false } : value;
    });
    const card = await hub.dispatchTicket({
      commandId: "del-stop-ticket",
      title: "等待设备任务",
      goal: "只读测试",
      scope: "独立工单",
      envId: "local",
      originConversationId: topic.conversationId,
    });
    const deadline = Date.now() + 5_000;
    while (true) {
      const t = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[card.id];
      if (t?.status === "waiting" && t.activeTaskId === undefined) break;
      if (Date.now() > deadline) throw new Error("Ticket did not enter waiting state");
      await new Promise((r) => setTimeout(r, 20));
    }
    offline.mockRestore();

    await expect(hub.deleteTopic(topic.id, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "topic_tasks_running" });

    let lastBroadcastTickets: TicketCardView[] | undefined;
    const unsubscribe = hub.subscribe({ onTickets: (tickets) => { lastBroadcastTickets = tickets; } });
    cleanups.push(unsubscribe);

    await hub.deleteTopic(topic.id, BACKGROUND_CONTEXT, { stopTasks: true });

    const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap?.tickets[card.id]).toMatchObject({
      status: "closed",
      cleanupPending: false,
      closure: { kind: "obsolete", reason: "会话已删除" },
    });
    expect(snap?.tickets[card.id]?.waiting).toBeUndefined();
    expect(lastBroadcastTickets).toBeDefined();
    expect(visibleTaskCards(lastBroadcastTickets!, Date.now(), 3).map((t) => t.id)).not.toContain(card.id);
  });
});
