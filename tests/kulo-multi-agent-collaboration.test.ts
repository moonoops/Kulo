import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, ROOT_CONVERSATION_ID, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ProjectRecord, SubagentRecord, TicketRecord } from "@kulo/protocol";
import {
  KuloSubagentRunner,
  aggregateTicketSubagentSummaries,
  buildRecentWorkSnapshot,
  buildTicketSubagentViews,
  canAccessTaskBoard,
  clampSubagentTimeoutSeconds,
  collectReviewPackAssets,
  extractCurrentTurnAssistantText,
  formatTaskBoardWorkerContext,
  pruneClosedSubagentsInTx,
  readTaskBoard,
  resolveBoardCallerScope,
  resolveReplyTaskAnchor,
  searchTaskBoards,
  settlePendingSubagentsInTx,
  validateReviewTargetTicket,
  writeTaskBoardInTx,
  KuloStateDoc,
  type KuloDurableState,
} from "../packages/hub/src/index.js";
import { formatExternalAgentHandoffPrompt, formatWorkerInitialPrompt } from "../packages/hub/src/prompts/worker.js";
import type { KuloProjectsState } from "../packages/hub/src/projects.js";
import type { SettingsAssistantState } from "../packages/hub/src/settings-doc.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function makeTicket(id: string, patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id,
    commandId: `cmd-${id}`,
    title: `任务 ${id}`,
    goal: `目标 ${id}`,
    scope: "packages/hub",
    role: "coder",
    status: "ready",
    envId: "local",
    workspaceDir: "/project",
    workerConversationId: 200,
    runEpoch: 1,
    createdAt: 100,
    updatedAt: 100,
    originTopicId: "root",
    originConversationId: Number(ROOT_CONVERSATION_ID),
    ...patch,
  };
}

function makeSubagent(id: string, patch: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id,
    name: `sub-${id}`,
    role: "scout",
    roleLabel: "侦察员",
    ticketId: "T-0001",
    parentConversationId: 200,
    conversationId: 300,
    readOnly: true,
    runs: 1,
    createdAt: 100,
    updatedAt: 100,
    state: "running",
    ...patch,
  };
}

function makeProject(id: string, patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: `项目 ${id}`,
    deviceId: "local",
    workspaceDir: `/projects/${id}`,
    directoryId: id,
    revision: 1,
    grantRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function baseState(): { state: KuloDurableState; projects: KuloProjectsState; rootConvId: number } {
  const rootConvId = Number(ROOT_CONVERSATION_ID);
  const state: KuloDurableState = {
    nextTicketNumber: 1,
    tickets: {},
    commandIndex: {},
    conversationToTicket: {},
    subagents: {},
    conversationToSubagent: {},
    topics: {
      root: { id: "root", conversationId: rootConvId, title: "主对话", master: true, createdAt: 1, updatedAt: 1 },
      "topic-a": { id: "topic-a", conversationId: 11, title: "独立话题A", createdAt: 2, updatedAt: 2 },
      "topic-b": { id: "topic-b", conversationId: 12, title: "独立话题B", createdAt: 3, updatedAt: 3 },
      "topic-p1": { id: "topic-p1", conversationId: 13, title: "项目1话题", projectId: "p1", createdAt: 4, updatedAt: 4 },
      "topic-p2": { id: "topic-p2", conversationId: 14, title: "项目2话题", projectId: "p2", createdAt: 5, updatedAt: 5 },
    },
    conversationToTopic: {
      [String(rootConvId)]: "root",
      "11": "topic-a",
      "12": "topic-b",
      "13": "topic-p1",
      "14": "topic-p2",
    },
    slots: { holders: [] },
  };
  const projects: KuloProjectsState = {
    projects: { p1: makeProject("p1"), p2: makeProject("p2") },
    commands: {},
    bindings: {},
    needsAuthorization: {},
    cleanup: {},
    errors: {},
    cancellations: {},
  };
  return { state, projects, rootConvId };
}

describe("Phase 1: Subagent observability & timeout/write-chain resilience", () => {
  it("counts running subagents only when parent is active, detects queued->running revision changes, and settles stale states", () => {
    const { state } = baseState();
    state.tickets["T-0001"] = makeTicket("T-0001", { status: "running" });
    state.subagents!["T-0001:S-01"] = makeSubagent("T-0001:S-01", { state: "queued", updatedAt: 100 });
    state.subagents!["T-0001:S-02"] = makeSubagent("T-0001:S-02", { state: "waiting", updatedAt: 100 });

    const before = aggregateTicketSubagentSummaries(state).get("T-0001")!;
    expect(before.running).toBe(0);
    expect(before.total).toBe(2);

    state.subagents!["T-0001:S-01"]!.state = "running";
    state.subagents!["T-0001:S-01"]!.updatedAt = 120;
    const active = aggregateTicketSubagentSummaries(state).get("T-0001")!;
    expect(active.running).toBe(1);
    expect(active.revision).not.toBe(before.revision);

    // Settled parent never reports running teammates, and leftover queued/waiting subagents settle to stopped
    state.tickets["T-0001"]!.status = "ready";
    settlePendingSubagentsInTx(state, "T-0001", 200);
    expect(state.subagents!["T-0001:S-02"]!.state).toBe("stopped");
    expect(aggregateTicketSubagentSummaries(state).get("T-0001")!.running).toBe(0);
  });

  it("redacts secrets and clamps subagent summaries, and prunes oldest closed subagents past limit", () => {
    const { state } = baseState();
    state.tickets["T-0001"] = makeTicket("T-0001", { status: "running" });
    state.subagents!["T-0001:S-01"] = makeSubagent("T-0001:S-01", {
      lastSummary: `secret=SECRET_TOKEN ${"x".repeat(600)}`,
    });
    const views = buildTicketSubagentViews(state, "T-0001", (v) => v.replaceAll("SECRET_TOKEN", "[REDACTED]"));
    expect(views).toHaveLength(1);
    expect(views[0]!.lastSummary).not.toContain("SECRET_TOKEN");
    expect(views[0]!.lastSummary!.length).toBeLessThanOrEqual(400);

    // Prune closed subagents when over cap
    state.tickets["T-OLD"] = makeTicket("T-OLD", { status: "closed", updatedAt: 10 });
    state.tickets["T-NEW"] = makeTicket("T-NEW", { status: "closed", updatedAt: 50 });
    state.subagents!["T-OLD:S-01"] = makeSubagent("T-OLD:S-01", { ticketId: "T-OLD", conversationId: 301, updatedAt: 10, state: "ready" });
    state.subagents!["T-NEW:S-01"] = makeSubagent("T-NEW:S-01", { ticketId: "T-NEW", conversationId: 302, updatedAt: 50, state: "ready" });
    state.conversationToSubagent!["301"] = "T-OLD:S-01";
    state.conversationToSubagent!["302"] = "T-NEW:S-01";
    pruneClosedSubagentsInTx(state, 1);
    expect(state.subagents!["T-OLD:S-01"]).toBeUndefined();
    expect(state.conversationToSubagent!["301"]).toBeUndefined();
    expect(state.subagents!["T-NEW:S-01"]).toBeDefined();
    expect(state.subagents!["T-0001:S-01"]).toBeDefined();
  });

  it("clamps subagent timeout defaults & bounds and stops assistant text extraction at UserEntry boundary", () => {
    expect(clampSubagentTimeoutSeconds(undefined, true)).toBe(180);
    expect(clampSubagentTimeoutSeconds(undefined, false)).toBe(300);
    expect(clampSubagentTimeoutSeconds(5, true)).toBe(30);
    expect(clampSubagentTimeoutSeconds(9999, false)).toBe(900);

    // Entries are newest-first: Round 2 user prompt followed by Round 1 assistant reply
    const entries = [
      { kind: UserEntry.kind, id: 4, model: [{ role: "user", content: "round 2" }] },
      { kind: AssistantEntry.kind, id: 3, model: [{ role: "assistant", content: [{ type: "text", text: "OLD_ROUND_1_REPLY" }] }] },
    ];
    expect(extractCurrentTurnAssistantText(entries)).toBe("");

    const withRound2Reply = [
      { kind: AssistantEntry.kind, id: 5, model: [{ role: "assistant", content: [{ type: "text", text: "NEW_ROUND_2_PARTIAL" }] }] },
      ...entries,
    ];
    expect(extractCurrentTurnAssistantText(withRound2Reply)).toBe("NEW_ROUND_2_PARTIAL");
  });

  it("drains timed-out writable subagent and marks skipped subsequent writable subagent as stopped (never stuck queued)", async () => {
    const { state } = baseState();
    state.tickets["T-0001"] = makeTicket("T-0001", { status: "running", role: "architect", workerConversationId: 200 });
    state.conversationToTicket["200"] = "T-0001";
    state.slots.holders = ["T-0001"];

    let nextConvId = 400;
    const abortedConvIds: number[] = [];
    const fakeHarness = {
      snapshot: async () => structuredClone(state),
      commit: async (fn: (tx: { doc: () => Promise<KuloDurableState> }) => Promise<unknown>) =>
        fn({ doc: async () => state }),
      conversation: async () => undefined,
      observeConversation: async () => ({ detach() {} }),
      createConversation: async () => {
        const id = nextConvId++;
        return {
          id,
          submit: async () => ({
            // First writable subagent hangs forever so timeout fires
            wait: () => new Promise(() => {}),
          }),
          abort: async () => {
            abortedConvIds.push(id);
          },
          waitForIdle: async () => {},
          entries: async () => ({ items: [] }),
        };
      },
    };

    const runner = new KuloSubagentRunner({
      harness: fakeHarness as never,
      envManager: {} as never,
      isClosed: () => false,
      getRoles: () => ({
        architect: { id: "architect", label: "架构师", whenToUse: "", prompt: "", allowSubagents: true, enabled: true },
        coder: { id: "coder", label: "开发者", whenToUse: "", prompt: "", readOnly: false, enabled: true },
      }),
      getMaxSubagentsPerTicket: () => 4,
      getDefaultTimeoutOverrideMs: () => 40,
      resolveSubagentAgent: () => ({ model: { id: "m", provider: "p" } as never, thinkingLevel: "low" }),
      buildSubagentTools: () => ({ extensions: [], tools: [] }),
      syncSubagentConversation: async () => {},
      touchParentActivity: () => {},
    });

    const outcomes = await runner.runSubagents(
      {
        callerConversationId: 200,
        tasks: [
          { name: "coder-a", role: "coder", goal: "edit file a" },
          { name: "coder-b", role: "coder", goal: "edit file b" },
        ],
      },
      BACKGROUND_CONTEXT,
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.status).toBe("timeout");
    expect(outcomes[0]!.summary).toContain("[PARTIAL WRITE WARNING]");
    expect(abortedConvIds).toContain(400);

    expect(outcomes[1]!.status).toBe("error");
    expect(outcomes[1]!.summary).toContain("Skipped");
    // Second writable subagent must NOT remain stuck in "queued"
    expect(state.subagents!["T-0001:S-01"]!.state).toBe("failed");
    expect(state.subagents!["T-0001:S-02"]!.state).toBe("stopped");
  });
});

describe("Phase 2: Coordinator-gated Task Boards, project isolation & long-session recall", () => {
  it("supports idempotent write, superseded entries, merged vs staged path separation, and dual-channel Worker injection", () => {
    const { state, projects, rootConvId } = baseState();
    state.tickets["T-0001"] = makeTicket("T-0001", {
      projectId: "p1",
      workspaceStaging: {
        mode: "staged",
        stagedCwd: "/tmp/staged-1",
        stagedDiff: { added: ["src/new.ts"], modified: ["src/a.ts"], deleted: [], conflictFiles: [], unifiedPreview: "" },
      },
    });

    const first = writeTaskBoardInTx(
      state,
      projects,
      undefined,
      {
        commandId: "bw-1",
        conversationId: rootConvId,
        boardTitle: "v0.1.5 架构改造",
        ticketId: "T-0001",
        kind: "decision",
        note: "先用草稿方案验证 ak_1234567890abcdefghijklmnop",
        now: 1000,
      },
      (t) => t,
    );
    expect(first.deduplicated).toBe(false);
    expect(first.board.id).toBe("B-0001");
    expect(first.board.projectId).toBe("p1");
    expect(first.board.entries[0]!.stagedPaths).toEqual(["src/new.ts", "src/a.ts"]);
    expect(first.board.entries[0]!.mergedPaths).toBeUndefined();
    expect(first.board.entries[0]!.note).not.toContain("ak_1234567890");

    // Idempotent replay
    const replay = writeTaskBoardInTx(
      state,
      projects,
      undefined,
      {
        commandId: "bw-1",
        conversationId: rootConvId,
        boardId: "B-0001",
        note: "不应重复追加",
        now: 1001,
      },
      (t) => t,
    );
    expect(replay.deduplicated).toBe(true);
    expect(state.boards!["B-0001"]!.entries).toHaveLength(1);

    // Supersede entry #1 after ticket is merged
    state.tickets["T-0001"]!.workspaceStaging!.appliedAt = 1500;
    writeTaskBoardInTx(
      state,
      projects,
      undefined,
      {
        commandId: "bw-2",
        conversationId: rootConvId,
        boardId: "B-0001",
        ticketId: "T-0001",
        kind: "correction",
        note: "已合入最终方案，废弃旧草稿",
        supersedesSeq: 1,
        now: 2000,
      },
      (t) => t,
    );
    const updatedBoard = state.boards!["B-0001"]!;
    expect(updatedBoard.entries[1]!.mergedPaths).toEqual(["src/new.ts", "src/a.ts"]);
    expect(updatedBoard.entries[1]!.stagedPaths).toBeUndefined();

    const boardCtx = formatTaskBoardWorkerContext(updatedBoard);
    expect(boardCtx).toBeDefined();
    expect(boardCtx).toContain("已合入最终方案");
    expect(boardCtx).not.toContain("先用草稿方案验证");

    // Both built-in AND external handoff prompts receive boardContext & reviewContext
    const builtInPrompt = formatWorkerInitialPrompt(state.tickets["T-0001"]!, {
      boardContext: boardCtx,
      reviewContext: "## Review Target",
    });
    expect(builtInPrompt).toContain("Verified Task Board Context (B-0001");
    expect(builtInPrompt).toContain("## Review Target");

    const externalPrompt = formatExternalAgentHandoffPrompt({
      ticket: state.tickets["T-0001"]!,
      workspaceMode: "read_only",
      boardContext: boardCtx,
      reviewContext: "## Review Target",
      materialized: [],
    });
    expect(externalPrompt).toContain("Verified Task Board Context (B-0001");
    expect(externalPrompt).toContain("## Review Target");
  });

  it("enforces one-way project lock, topic/project isolation, soft-delete veto, and activeSettings exclusion", () => {
    const { state, projects, rootConvId } = baseState();
    // Create ungrouped board in topic-a
    const created = writeTaskBoardInTx(
      state,
      projects,
      undefined,
      { commandId: "b-topic-a", conversationId: 11, boardTitle: "HA 门磁告警", note: "初步调研完成", now: 100 },
      (t) => t,
    );
    const boardId = created.board.id;

    // topic-b cannot see or read topic-a's board; master can
    expect(searchTaskBoards(state, projects, undefined, 12, "门磁")).toHaveLength(0);
    expect(() => readTaskBoard(state, projects, undefined, 12, boardId, (t) => t)).toThrow(/无权访问/);
    expect(searchTaskBoards(state, projects, undefined, rootConvId, "门磁")).toHaveLength(1);

    // Move topic-a into project p1 -> topic-a still sees its own board; attaching p1 ticket locks board to p1 one-way
    state.topics!["topic-a"]!.projectId = "p1";
    const scopeA = resolveBoardCallerScope(state, projects, undefined, 11);
    expect(canAccessTaskBoard(state.boards![boardId]!, scopeA, state, projects)).toBe(true);

    state.tickets["T-P1"] = makeTicket("T-P1", { projectId: "p1", originTopicId: "topic-a", originConversationId: 11 });
    state.tickets["T-P2"] = makeTicket("T-P2", { projectId: "p2", originTopicId: "topic-p2", originConversationId: 14 });
    writeTaskBoardInTx(
      state,
      projects,
      undefined,
      { commandId: "lock-p1", conversationId: 11, boardId, ticketId: "T-P1", note: "绑定 p1", now: 200 },
      (t) => t,
    );
    expect(state.boards![boardId]!.projectId).toBe("p1");

    // Cross-project contamination from master is blocked with 409 board_project_mismatch
    expect(() =>
      writeTaskBoardInTx(
        state,
        projects,
        undefined,
        { commandId: "cross-p2", conversationId: rootConvId, boardId, ticketId: "T-P2", note: "尝试串板", now: 300 },
        (t) => t,
      ),
    ).toThrow(/不能挂载不同项目/);

    // Soft-deleted project hides board everywhere
    projects.projects.p1!.deletedAt = 400;
    expect(searchTaskBoards(state, projects, undefined, rootConvId, "门磁")).toHaveLength(0);
    delete projects.projects.p1!.deletedAt;

    // Settings assistant never sees task boards
    const settingsDoc: SettingsAssistantState = { conversationId: 999, topics: {} } as never;
    expect(searchTaskBoards(state, projects, settingsDoc, 999, "门磁")).toHaveLength(0);
    const rwSettings = buildRecentWorkSnapshot({ state, projects, settings: settingsDoc, conversationId: 999 });
    expect(rwSettings.content).not.toContain("Active Task Boards");
  });

  it("renders Active Task Boards in recent-work with '*' prefix, cache-stable revision, and reply anchor lookup", () => {
    const { state, projects, rootConvId } = baseState();
    state.tickets["T-1"] = makeTicket("T-1", { status: "running", title: "工单1" });
    writeTaskBoardInTx(
      state,
      projects,
      undefined,
      { commandId: "rw-1", conversationId: rootConvId, boardTitle: "HA 告警", ticketId: "T-1", note: "已接通 webhook", now: 500 },
      (t) => t,
    );
    const snap1 = buildRecentWorkSnapshot({ state, projects, conversationId: rootConvId });
    expect(snap1.content).toContain("### Active Task Boards");
    expect(snap1.content).toContain("* B-0001 · HA 告警");
    // Ticket '-' prefix count remains strictly tickets only
    expect(snap1.content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);

    // Heartbeat updatedAt change does NOT bust recent-work revision
    state.boards!["B-0001"]!.updatedAt = 999_999;
    const snap2 = buildRecentWorkSnapshot({ state, projects, conversationId: rootConvId });
    expect(snap2.revision).toBe(snap1.revision);

    // Reply anchor resolves trailing AssistantEntry back to same-turn kulo_dispatch ToolResultEntry
    const fakeEntries = [
      { kind: UserEntry.kind, id: 10, model: [{ role: "user", content: "派单" }] },
      {
        kind: ToolResultEntry.kind,
        id: 11,
        model: [{ role: "toolResult", toolName: "kulo_dispatch", content: [{ type: "text", text: JSON.stringify({ ticket: { id: "T-1" } }) }] }],
      },
      { kind: AssistantEntry.kind, id: 12, model: [{ role: "assistant", content: [{ type: "text", text: "已为你派发" }] }] },
    ];
    const anchor = resolveReplyTaskAnchor(fakeEntries as never, 12, state, projects, undefined, rootConvId);
    expect(anchor).toBe('[Linked Task: T-1 | Board: B-0001 "HA 告警"]');
  });
});

describe("Phase 3: Cross-ticket read-only review materialization & hub integration", () => {
  it("validates reviewable target states and collects redacted review pack assets", async () => {
    const { state, projects, rootConvId } = baseState();
    state.tickets["T-RUN"] = makeTicket("T-RUN", { status: "running" });
    state.tickets["T-STOP"] = makeTicket("T-STOP", { status: "stopped" });
    state.tickets["T-READY"] = makeTicket("T-READY", {
      status: "ready",
      projectId: "p1",
      latestReport: { state: "ready", summary: "完成重构 SECRET_VAL", at: 200 },
      workspaceStaging: {
        mode: "staged",
        stagedCwd: "/tmp/staged-ready",
        stagedDiff: {
          added: [],
          modified: ["src/app.ts"],
          deleted: [],
          conflictFiles: [],
          unifiedPreview: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      },
    });

    expect(() => validateReviewTargetTicket(state, projects, undefined, rootConvId, "T-RUN")).toThrow(/只能评审已落定/);
    expect(() => validateReviewTargetTicket(state, projects, undefined, rootConvId, "T-STOP")).toThrow(/只能评审已落定/);
    const valid = validateReviewTargetTicket(state, projects, undefined, rootConvId, "T-READY");
    expect(valid.id).toBe("T-READY");

    const pack = await collectReviewPackAssets({
      target: valid,
      inspectStagedDiff: async (_id, fp) => ({
        added: [],
        modified: ["src/app.ts"],
        deleted: [],
        conflictFiles: [],
        unifiedPreview: "",
        diff: `--- a/${fp}\n+++ b/${fp}\n@@ -1 +1 @@\n-old\n+new SECRET_VAL`,
      }),
      redact: (v) => v.replaceAll("SECRET_VAL", "[REDACTED]"),
    });
    expect(pack.hasFullPatch).toBe(true);
    const summaryText = pack.assets.find((a) => a.name === "summary.md")!.bytes.toString("utf8");
    const patchText = pack.assets.find((a) => a.name === "changes.patch")!.bytes.toString("utf8");
    expect(summaryText).not.toContain("SECRET_VAL");
    expect(patchText).toContain("+new [REDACTED]");
  });

  it("forces readOnly, lazily links shared TaskBoard, never inherits upstream connections, and blocks cross-topic closeTicket", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-collab-hub-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("done")])));
    const hub = await openTestHub({
      models,
      config: {
        stateDir,
        memory: { enabled: false },
        model: { baseUrl: "http://127.0.0.1:9/v1", defaultModel: "gpt-4o" },
      },
    });
    cleanups.push(() => hub.close());

    // Seed a settled upstream ticket T-0001 with a connectionId
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.nextTicketNumber = 2;
      state.tickets["T-0001"] = makeTicket("T-0001", {
        status: "ready",
        role: "coder",
        connectionIds: ["conn-secret"],
        latestReport: { state: "ready", summary: "实现已完成", at: 500 },
      });
    }, BACKGROUND_CONTEXT);

    // Dispatch a review ticket referencing T-0001 with writable role 'coder' -> must force readOnly + auto-link TaskBoard + zero connection inheritance
    const reviewCard = await hub.dispatchTicket(
      {
        commandId: "cmd-review-1",
        title: "复核 T-0001",
        goal: "独立复核边界与风险",
        scope: "packages/hub",
        role: "coder",
        reviewTicketId: "T-0001",
        originConversationId: Number(ROOT_CONVERSATION_ID),
      },
      BACKGROUND_CONTEXT,
    );

    const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const reviewTicket = snap!.tickets[reviewCard.id]!;
    expect(reviewTicket.readOnly).toBe(true);
    expect(reviewTicket.reviewTicketId).toBe("T-0001");
    expect(reviewTicket.connectionIds).toBeUndefined();
    expect(reviewTicket.boardId).toBeDefined();
    expect(snap!.tickets["T-0001"]!.boardId).toBe(reviewTicket.boardId);
    expect(snap!.boards![reviewTicket.boardId!]!.ticketIds).toEqual(["T-0001", reviewTicket.id]);

    // Real pi-durable Proxy transaction write & idempotent replay (verifies zero DataCloneError)
    const promoted = await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      return writeTaskBoardInTx(
        state,
        undefined,
        undefined,
        {
          commandId: "durable-board-write-1",
          conversationId: Number(ROOT_CONVERSATION_ID),
          boardId: reviewTicket.boardId!,
          ticketId: reviewTicket.id,
          kind: "verified",
          note: "独立复核已通过，确认可合入",
          now: 900,
        },
        (v) => v,
      );
    }, BACKGROUND_CONTEXT);
    expect(promoted.deduplicated).toBe(false);
    expect(promoted.board.entries).toHaveLength(1);
    expect(promoted.board.entries[0]!.note).toBe("独立复核已通过，确认可合入");

    // Non-global topic cannot close another conversation's ticket
    const topicA = await hub.createTopic("独立话题");
    await expect(
      hub.closeTicket({
        commandId: "close-cross-topic",
        ticketId: "T-0001",
        kind: "obsolete",
        reason: "越权测试",
        originConversationId: topicA.conversationId,
      }),
    ).rejects.toThrow(/不能跨会话关闭/);
  });
});
