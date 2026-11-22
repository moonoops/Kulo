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
import {
  ProjectDirectoryRegistry,
  StagedWorkspaceOversizedError,
  StagedWorkspaceService,
} from "@kulo/env";
import { KuloStateDoc, hasPendingWorkspaceApply } from "@kulo/hub";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeTestModels() {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "staged-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  return { provider, models };
}

function openStagedTestHub(
  dir: string,
  models: ReturnType<typeof createModels>,
  extra: { inlineDispatchWaitMs?: number } = {},
) {
  return openTestHub({
    models,
    config: {
      stateDir: path.join(dir, "state"),
      identityDir: path.join(dir, "identity"),
      localEnvRoot: path.join(dir, "env"),
      enableLocalEnv: true,
      maxConcurrentWorkers: 3,
      watchdogMinutes: 0,
      memory: { enabled: false },
      ...(extra.inlineDispatchWaitMs !== undefined ? { inlineDispatchWaitMs: extra.inlineDispatchWaitMs } : {}),
      model: {
        defaultProvider: "openai",
        defaultModel: "staged-model",
        thinkingLevel: "off",
        baseUrl: "http://127.0.0.1:9/v1",
      },
    },
  });
}

function allTools(ctx: TranscriptContext) {
  return [
    ...(ctx.tools ?? []),
    ...ctx.messages.flatMap((m) =>
      m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) ? m.toolsAdded : [],
    ),
  ];
}

function systemText(ctx: TranscriptContext): string {
  const parts: string[] = [];
  if (typeof ctx.systemPrompt === "string") parts.push(ctx.systemPrompt);
  for (const m of ctx.messages) {
    if (m.role === "system") {
      parts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      if ("sections" in m && m.sections && typeof m.sections === "object") {
        for (const val of Object.values(m.sections)) {
          if (typeof val === "string") parts.push(val);
        }
      }
    }
  }
  return parts.join("\n");
}

function toolReply(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

async function waitFor<T>(
  check: () => T | Promise<T>,
  timeoutMs = 15_000,
  intervalMs = 30,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError ?? new Error(`Condition not met within ${timeoutMs}ms`);
}

describe("Batch 3 — R4-B Built-in Worker Staged Project Writes", () => {
  it("preflights non-CoW project size while ignoring dist/ and node_modules/", () => {
    const root = makeTempDir("kulo-b3-preflight-");
    const projectDir = path.join(root, "repo");
    fs.mkdirSync(path.join(projectDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(projectDir, "dist", "bundle.js"), "x".repeat(5_000));
    fs.writeFileSync(path.join(projectDir, "node_modules", "pkg", "index.js"), "y".repeat(5_000));

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, ".kulo-env", "grants.json"),
      scratchRoot: path.join(root, "scratch"),
    });
    const grant = registry.authorize({
      projectId: "proj-1",
      path: projectDir,
      operationId: "op-1",
    });

    const serviceSmallOk = new StagedWorkspaceService({
      projectRegistry: registry,
      forceNonCow: true,
      maxNonCowBytes: 200,
      maxNonCowFiles: 10,
    });
    const prepared = serviceSmallOk.prepare({
      taskId: "T-small",
      projectId: "proj-1",
      sourceDir: grant.workspaceDir,
      directoryId: grant.directoryId,
      grantRevision: grant.revision,
    });
    expect(prepared.reused).toBe(false);
    expect(fs.existsSync(path.join(prepared.stagedCwd, "src.ts"))).toBe(true);
    expect(fs.existsSync(path.join(prepared.stagedCwd, "dist"))).toBe(false);

    // Adding a non-ignored file > 200 bytes triggers StagedWorkspaceOversizedError
    fs.writeFileSync(path.join(projectDir, "large.txt"), "z".repeat(500));
    expect(() =>
      serviceSmallOk.prepare({
        taskId: "T-large",
        projectId: "proj-1",
        sourceDir: grant.workspaceDir,
        directoryId: grant.directoryId,
        grantRevision: grant.revision,
      }),
    ).toThrow(StagedWorkspaceOversizedError);
  });

  it("removes 'direct' from model kulo_dispatch schema and blocks model direct override", async () => {
    const dir = makeTempDir("kulo-b3-schema-");
    const projectDir = path.join(dir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "app.txt"), "initial\n");

    let seenWorkspaceModeSchema: unknown;
    let attemptDirectResult = "";

    const { provider, models } = makeTestModels();
    let projectId = "";
    provider.setResponses([
      (ctx: TranscriptContext) => {
        const dispatch = allTools(ctx).find((t) => t.name === "kulo_dispatch");
        const params = dispatch?.parameters as { properties?: Record<string, unknown> } | undefined;
        seenWorkspaceModeSchema = params?.properties?.workspace_mode;
        return toolReply("kulo_dispatch", {
          command_id: "cmd-direct-reject",
          title: "Try direct mode",
          goal: "Attempt direct write",
          scope: "app.txt",
          project_id: projectId,
          workspace_mode: "direct",
        });
      },
      (ctx: TranscriptContext) => {
        const lastTool = [...ctx.messages].reverse().find((m) => m.role === "toolResult");
        attemptDirectResult = lastTool && "content" in lastTool ? JSON.stringify(lastTool.content) : "";
        return fauxAssistantMessage([fauxText("Rejected direct mode as expected.")]);
      },
    ]);

    const hub = await openStagedTestHub(dir, models);
    cleanups.push(() => hub.close(context));

    const project = await hub.projects.create(
      { commandId: "proj-create-1", name: "Demo", deviceId: "local", workspaceDir: projectDir },
      context,
    );
    projectId = project.id;

    const sub = await hub.sendUserMessage("请改一下 app.txt", { topicId: "root" }, context);
    await sub.wait(context);

    const schemaJson = JSON.stringify(seenWorkspaceModeSchema);
    expect(schemaJson).toContain("staged");
    expect(schemaJson).toContain("read_only");
    expect(schemaJson).not.toContain("direct");
    expect(attemptDirectResult).toContain("direct");
  });

  it("executes built-in project write + subagent in stagedCwd, supports A2-lite inline review, blocks live writes, separates compute slot from write lock, surfaces blockedByPendingMerge, and applies cleanly", async () => {
    const dir = makeTempDir("kulo-b3-e2e-");
    const projectDir = path.join(dir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "index.ts"), "export const version = 1;\n");

    const liveProjectReal = fs.realpathSync(projectDir);
    let workerBlockedLiveWriteError = "";
    let workerSawStagedMandate = false;
    let subagentSawStagedMandate = false;
    let workerStep = 0;
    let subagentStep = 0;
    let t2WorkerStep = 0;
    let orchestratorSawInlineStagedDiff = false;
    let orchestratorHasStagedTools = false;
    let orchestratorSawBlockedByPending = false;
    let firstTicketId = "";
    let secondTicketId = "";
    let projectId = "";

    const { provider, models } = makeTestModels();
    const handler = (ctx: TranscriptContext) => {
      const sys = systemText(ctx);
      const tools = allTools(ctx);
      const toolNames = new Set(tools.map((t) => t.name));

      // Subagent (has write/edit, NO kulo_report and NO kulo_dispatch)
      if (!toolNames.has("kulo_dispatch") && !toolNames.has("kulo_report") && sys.includes("Subagent Mandate")) {
        subagentStep += 1;
        if (subagentStep === 1) {
          subagentSawStagedMandate = sys.includes("shared isolated staged copy");
          return toolReply("write", { path: "helper.ts", content: "export const helper = true;\n" });
        }
        return fauxAssistantMessage([fauxText("Created helper.ts inside shared staged workspace.")]);
      }

      // Built-in Worker (has kulo_report)
      if (toolNames.has("kulo_report")) {
        if (sys.includes("Second project write")) {
          t2WorkerStep += 1;
          if (t2WorkerStep === 1) {
            return toolReply("write", { path: "second.ts", content: "export const second = 2;\n" });
          }
          return toolReply("kulo_report", { state: "ready", summary: "Added second.ts" });
        }
        workerStep += 1;
        if (workerStep === 1) {
          workerSawStagedMandate =
            sys.includes("isolated staged copy of the project") &&
            sys.includes("Project: StagedRepo") &&
            !sys.includes(liveProjectReal);
          return toolReply("write", { path: "index.ts", content: "export const version = 2;\n" });
        }
        if (workerStep === 2) {
          // Attempt to escape and write directly to the live project checkout -> blocked by safetyHook!
          return toolReply("write", { path: path.join(liveProjectReal, "escape.txt"), content: "pwned" });
        }
        if (workerStep === 3) {
          const lastTool = [...ctx.messages].reverse().find((m) => m.role === "toolResult");
          workerBlockedLiveWriteError = lastTool && "content" in lastTool ? JSON.stringify(lastTool.content) : "";
          return toolReply("kulo_subagent", {
            tasks: [{ name: "helper-writer", role: "coder", goal: "Create helper.ts" }],
          });
        }
        return toolReply("kulo_report", { state: "ready", summary: "Updated index.ts and created helper.ts" });
      }

      // Orchestrator
      const toolResults = ctx.messages.filter((m) => m.role === "toolResult");
      if (toolResults.length === 0) {
        return toolReply("kulo_dispatch", {
          command_id: "cmd-staged-t1",
          title: "Update version",
          goal: "Update version to 2 and add helper.ts",
          scope: "index.ts, helper.ts",
          role: "coder",
          project_id: projectId,
          inline_wait_ms: 12_000,
        });
      }
      const lastTool = toolResults.at(-1)!;
      const lastText = "content" in lastTool ? JSON.stringify(lastTool.content) : "";
      if (toolResults.length === 1) {
        if (lastText.includes("inline_delivery") && lastText.includes("stagedDiff") && lastText.includes("helper.ts")) {
          orchestratorSawInlineStagedDiff = true;
        }
        orchestratorHasStagedTools =
          toolNames.has("kulo_inspect_staged_diff") && toolNames.has("kulo_apply_staged_changes");
        const match = lastText.match(/T-\d{4}/);
        firstTicketId = match?.[0] ?? "";
        return toolReply("kulo_dispatch", {
          command_id: "cmd-staged-t2",
          title: "Second project write",
          goal: "Add second.ts",
          scope: "second.ts",
          role: "coder",
          project_id: projectId,
          inline_wait_ms: 500,
        });
      }
      if (toolResults.length === 2) {
        if (lastText.includes("blocked_by_pending_merge") && lastText.includes(firstTicketId)) {
          orchestratorSawBlockedByPending = true;
        }
        const ids = lastText.match(/T-\d{4}/g) ?? [];
        secondTicketId = ids.find((id) => id !== firstTicketId) ?? "";
        return fauxAssistantMessage([fauxText("Dispatched T1 inline and queued T2 behind pending merge.")]);
      }
      return fauxAssistantMessage([fauxText("Done.")]);
    };
    provider.setResponses(Array.from({ length: 30 }, () => handler));

    const hub = await openStagedTestHub(dir, models, { inlineDispatchWaitMs: 12_000 });
    cleanups.push(() => hub.close(context));

    // Allow subagents on coder role for this test
    const settings = hub.getSettingsView();
    const coderRole = settings.blocks.roles.value.coder!;
    await hub.updateSettingsBlock(
      "roles",
      settings.blocks.roles.revision,
      { ...settings.blocks.roles.value, coder: { ...coderRole, allowSubagents: true } },
      context,
    );

    const project = await hub.projects.create(
      { commandId: "proj-e2e-1", name: "StagedRepo", deviceId: "local", workspaceDir: projectDir },
      context,
    );
    projectId = project.id;

    const sub = await hub.sendUserMessage("请把 index.ts 版本升到 2 并创建 helper.ts", { topicId: "root" }, context);
    await sub.wait(context);

    // 1. Live project directory MUST STILL BE UNTOUCHED!
    expect(fs.readFileSync(path.join(projectDir, "index.ts"), "utf8")).toBe("export const version = 1;\n");
    expect(fs.existsSync(path.join(projectDir, "helper.ts"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "escape.txt"))).toBe(false);
    expect(workerSawStagedMandate).toBe(true);
    expect(subagentSawStagedMandate).toBe(true);
    expect(workerBlockedLiveWriteError).toContain("isolated staged workspace");

    // 2. A2-lite inline review worked and injected staged review tools in the SAME turn!
    expect(orchestratorSawInlineStagedDiff).toBe(true);
    expect(orchestratorHasStagedTools).toBe(true);
    expect(orchestratorSawBlockedByPending).toBe(true);
    expect(firstTicketId).toMatch(/^T-\d{4}$/);
    expect(secondTicketId).toMatch(/^T-\d{4}$/);

    // 3. Compute slot released while write lock is held; T2 stays queued!
    const boardBefore = await hub.getBoardSnapshot(context);
    expect(boardBefore.slots.used).toBe(0);
    const t1Card = boardBefore.tickets.find((t) => t.id === firstTicketId)!;
    const t2Card = boardBefore.tickets.find((t) => t.id === secondTicketId)!;
    expect(t1Card.status).toBe("ready");
    expect(t1Card.pendingWorkspaceApply).toBe(true);
    expect(t2Card.status).toBe("queued");

    // 4. Inspect staged diff works for built-in staged ticket
    const diff = await hub.inspectStagedDiff(firstTicketId, undefined, context);
    expect(diff.added).toContain("helper.ts");
    expect(diff.modified).toContain("index.ts");

    // 5. Project rebind & project delete without stopTasks refuse while pending merge!
    await expect(
      hub.projects.patch(projectId, { workspaceDir: projectDir, expectedRevision: project.revision }, context),
    ).rejects.toMatchObject({ code: "project_tasks_running" });
    await expect(hub.projects.remove(projectId, {}, context)).rejects.toMatchObject({
      code: "project_tasks_running",
    });

    // 6. Apply T1 staged changes -> live project updated, T1 unlocked, queued T2 wakes & finishes!
    const applied = await hub.applyStagedChanges(
      { commandId: "cmd-apply-t1", ticketId: firstTicketId },
      context,
    );
    expect(applied.cleanedUp).toBe(true);
    expect(applied.appliedModified).toContain("index.ts");
    expect(applied.appliedAdded).toContain("helper.ts");
    expect(fs.readFileSync(path.join(projectDir, "index.ts"), "utf8")).toBe("export const version = 2;\n");
    expect(fs.readFileSync(path.join(projectDir, "helper.ts"), "utf8")).toBe("export const helper = true;\n");

    await waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      return snap?.tickets[secondTicketId]?.status === "ready";
    });
    const boardAfter = await hub.getBoardSnapshot(context);
    expect(boardAfter.tickets.find((t) => t.id === firstTicketId)?.pendingWorkspaceApply).toBeUndefined();
    expect(boardAfter.tickets.find((t) => t.id === secondTicketId)?.pendingWorkspaceApply).toBe(true);

    // 7. Close T2 without applying -> discards T2 staged copy & releases write lock
    await hub.closeTicket(
      { commandId: "cmd-close-t2", ticketId: secondTicketId, kind: "obsolete", reason: "Discard T2" },
      context,
    );
    const snapAfterClose = await hub.harness.snapshot(KuloStateDoc, context);
    expect(snapAfterClose?.tickets[secondTicketId]?.status).toBe("closed");
    expect(hasPendingWorkspaceApply(snapAfterClose!.tickets[secondTicketId]!)).toBe(false);
    expect(snapAfterClose?.slots.writeHolders ?? []).not.toContain(secondTicketId);
    expect(fs.existsSync(path.join(projectDir, "second.ts"))).toBe(false);
  }, 30_000);

  it("auto-cleans zero-diff built-in staged tickets, breaks supersedes deadlocks, cleans on topic archive, and handles multi-turn steer reuse vs re-clone", async () => {
    const dir = makeTempDir("kulo-b3-lifecycle-");
    const projectDir = path.join(dir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "note.txt"), "v0\n");

    let runCounter = 0;

    const { provider, models } = makeTestModels();
    const handler = (ctx: TranscriptContext) => {
      const sys = systemText(ctx);
      const toolNames = new Set(allTools(ctx).map((t) => t.name));
      if (!toolNames.has("kulo_report")) {
        return fauxAssistantMessage([fauxText("Ack.")]);
      }
      if (sys.includes("Zero diff check")) {
        return toolReply("kulo_report", { state: "ready", summary: "Checked project, no edits needed." });
      }
      if (sys.includes("Sensitive workflow edit")) {
        if (!ctx.messages.some((m) => m.role === "toolResult")) {
          return toolReply("write", { path: ".github/workflows/ci.yml", content: "name: ci\n" });
        }
        return toolReply("kulo_report", { state: "ready", summary: "Added workflow file." });
      }
      if (sys.includes("Steerable edit")) {
        runCounter += 1;
        const toolResults = ctx.messages.filter((m) => m.role === "toolResult");
        const lastInput = [...ctx.messages].reverse().find((m) => m.role === "user");
        const inputText = lastInput ? JSON.stringify(lastInput) : "";
        if (inputText.includes("Round 2 before apply")) {
          if (!toolResults.some((r) => JSON.stringify(r).includes("round2.txt") || toolResults.length >= 3)) {
            return toolReply("write", { path: "round2.txt", content: "r2\n" });
          }
          return toolReply("kulo_report", { state: "ready", summary: "Round 2 done." });
        }
        if (inputText.includes("Round 3 after apply")) {
          if (!toolResults.some((r) => JSON.stringify(r).includes("round3.txt") || toolResults.length >= 5)) {
            return toolReply("write", { path: "round3.txt", content: "r3\n" });
          }
          return toolReply("kulo_report", { state: "ready", summary: "Round 3 done." });
        }
        if (toolResults.length === 0) {
          return toolReply("write", { path: "round1.txt", content: "r1\n" });
        }
        return toolReply("kulo_report", { state: "ready", summary: "Round 1 done." });
      }
      if (sys.includes("Replacement edit")) {
        if (!ctx.messages.some((m) => m.role === "toolResult")) {
          return toolReply("write", { path: "replacement.txt", content: "ok\n" });
        }
        return toolReply("kulo_report", { state: "ready", summary: "Replacement complete." });
      }
      return toolReply("kulo_report", { state: "ready", summary: "Done." });
    };
    provider.setResponses(Array.from({ length: 40 }, () => handler));

    const hub = await openStagedTestHub(dir, models, { inlineDispatchWaitMs: 10_000 });
    cleanups.push(() => hub.close(context));

    const project = await hub.projects.create(
      { commandId: "proj-lc-1", name: "LifecycleRepo", deviceId: "local", workspaceDir: projectDir },
      context,
    );
    const topic = await hub.createTopic("Project Topic", context, project.id);

    // 1. Zero-diff ticket -> auto-discarded & write lock released
    const zeroCard = await hub.dispatchTicket(
      {
        commandId: "cmd-zero",
        title: "Zero diff check",
        goal: "Inspect only",
        scope: "note.txt",
        role: "coder",
        projectId: project.id,
        originConversationId: topic.conversationId,
      },
      context,
    );
    await waitFor(async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[zeroCard.id]?.status === "ready");
    const zeroSnap = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(hasPendingWorkspaceApply(zeroSnap.tickets[zeroCard.id]!)).toBe(false);
    expect(zeroSnap.tickets[zeroCard.id]!.workspaceStaging?.discardedAt).toBeDefined();
    expect(zeroSnap.slots.writeHolders ?? []).not.toContain(zeroCard.id);

    // 2. Sensitive path (.github/workflows/ci.yml) -> exits A2-lite & triggers supersedes deadlock test
    const sensCard = await hub.dispatchTicket(
      {
        commandId: "cmd-sens",
        title: "Sensitive workflow edit",
        goal: "Add CI workflow",
        scope: ".github/workflows/ci.yml",
        role: "coder",
        projectId: project.id,
        originConversationId: topic.conversationId,
        inlineWaitMs: 5_000,
      },
      context,
    );
    await waitFor(async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[sensCard.id]?.status === "ready");
    const sensSnap = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(hasPendingWorkspaceApply(sensSnap.tickets[sensCard.id]!)).toBe(true);
    expect(sensSnap.tickets[sensCard.id]!.workspaceStaging?.stagedDiff?.sensitivePaths).toContain(".github/workflows/ci.yml");
    expect(sensSnap.tickets[sensCard.id]!.deliveryClaim).toBe("escalated");

    // 3. Supersedes deadlock breaker: replacement supersedes sensCard -> unlocks write lock and runs immediately!
    const replCard = await hub.dispatchTicket(
      {
        commandId: "cmd-repl",
        title: "Replacement edit",
        goal: "Add replacement.txt",
        scope: "replacement.txt",
        role: "coder",
        projectId: project.id,
        originConversationId: topic.conversationId,
        supersedes: [{ ticketId: sensCard.id, reason: "Redo cleanly" }],
      },
      context,
    );
    await waitFor(async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[replCard.id]?.status === "ready");
    const replSnap = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(replSnap.tickets[sensCard.id]!.status).toBe("closed");
    expect(hasPendingWorkspaceApply(replSnap.tickets[sensCard.id]!)).toBe(false);
    expect(hasPendingWorkspaceApply(replSnap.tickets[replCard.id]!)).toBe(true);

    // 4. Topic delete without stopTasks blocks on pending-merge ticket; archiving topic cleans it & releases write lock!
    await expect(hub.deleteTopic(topic.id, context)).rejects.toMatchObject({ code: "topic_tasks_running" });
    await hub.patchTopic(topic.id, { archived: true }, context);
    const archivedSnap = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(hasPendingWorkspaceApply(archivedSnap.tickets[replCard.id]!)).toBe(false);
    expect(archivedSnap.slots.writeHolders ?? []).not.toContain(replCard.id);

    // 5. Multi-turn steer: before apply reuses stagedCwd (both round1.txt & round2.txt); after apply re-clones fresh!
    const steerTopic = await hub.createTopic("Steer Topic", context, project.id);
    const steerCard = await hub.dispatchTicket(
      {
        commandId: "cmd-steer-t1",
        title: "Steerable edit",
        goal: "Write round1.txt",
        scope: "round1.txt, round2.txt, round3.txt",
        role: "coder",
        projectId: project.id,
        originConversationId: steerTopic.conversationId,
      },
      context,
    );
    await waitFor(async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[steerCard.id]?.status === "ready");
    const firstStagedCwd = (await hub.harness.snapshot(KuloStateDoc, context))!.tickets[steerCard.id]!.workspaceStaging!.stagedCwd!;

    // Steer BEFORE apply -> reuses stagedCwd so round1.txt + round2.txt are both in diff!
    await hub.steerTicket(
      { commandId: "cmd-steer-r2", ticketId: steerCard.id, text: "Round 2 before apply" },
      context,
    );
    await waitFor(async () => {
      const t = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[steerCard.id];
      return t?.runEpoch === 2 && t.status === "ready";
    });
    const diffBeforeApply = await hub.inspectStagedDiff(steerCard.id, undefined, context);
    expect(diffBeforeApply.added).toContain("round1.txt");
    expect(diffBeforeApply.added).toContain("round2.txt");

    // Apply both round1.txt & round2.txt
    await hub.applyStagedChanges({ commandId: "cmd-apply-steer", ticketId: steerCard.id }, context);
    expect(fs.existsSync(path.join(projectDir, "round1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "round2.txt"))).toBe(true);
    expect(fs.existsSync(firstStagedCwd)).toBe(false);

    // Steer AFTER apply -> re-clones fresh from live projectDir (so round1/round2 are baseline, only round3 is added!)
    await hub.steerTicket(
      { commandId: "cmd-steer-r3", ticketId: steerCard.id, text: "Round 3 after apply" },
      context,
    );
    await waitFor(async () => {
      const t = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[steerCard.id];
      return t?.runEpoch === 3 && t.status === "ready";
    });
    const diffAfterReclone = await hub.inspectStagedDiff(steerCard.id, undefined, context);
    expect(diffAfterReclone.added).toEqual(["round3.txt"]);
    expect(runCounter).toBeGreaterThanOrEqual(3);
  }, 30_000);
});
