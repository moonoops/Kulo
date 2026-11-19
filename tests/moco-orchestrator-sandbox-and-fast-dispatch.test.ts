import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { MocoStateDoc, WorkerRelayEntry, type MocoHub } from "@moco/hub";
import { openTestHub } from "./helpers/secure-hub.js";

const tempDirs: string[] = [];
const openHubs: MocoHub[] = [];
const releaseCallbacks: Array<() => void> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `moco-step4-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function isOrchestratorContext(ctx: TranscriptContext): boolean {
  if (ctx.tools?.some((t) => t.name === "moco_dispatch")) return true;
  return ctx.messages.some(
    (m) =>
      m.role === "system" &&
      "toolsAdded" in m &&
      Array.isArray(m.toolsAdded) &&
      m.toolsAdded.some((t) => t.name === "moco_dispatch"),
  );
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 12_000,
  intervalMs = 40,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition timed out after ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const fn of releaseCallbacks.splice(0)) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  for (const hub of openHubs.splice(0)) {
    try {
      await hub.close();
    } catch {
      // ignore close race
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup race
    }
  }
});

describe("Step 4: A1s+ Sandboxed Orchestrator Coding Tools & A2-lite Single-Delivery Inline Dispatch", () => {
  it("allows Main Chat atomic write/edit/bash inside workspaceDir and enforces path, secret, network, timeout, and active-ticket write locks", async () => {
    const stateDir = makeTempDir("state");
    const identityDir = makeTempDir("identity");
    const localEnvRoot = makeTempDir("workspace");
    const outsideDir = makeTempDir("outside");
    fs.writeFileSync(path.join(identityDir, "identity-agreement.md"), "# Private Identity\n");
    fs.writeFileSync(path.join(outsideDir, "external.txt"), "outside");

    const faux = fauxProvider({ provider: "step4-test", models: [{ id: "step4-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let turnMode: "atomic_ops" | "security_guards" | "write_lock_conflict" = "atomic_ops";
    let workerHoldResolve: (() => void) | null = null;
    const workerHoldPromise = new Promise<void>((resolve) => {
      workerHoldResolve = resolve;
    });
    releaseCallbacks.push(() => workerHoldResolve?.());
    let workerStartedResolve: (() => void) | null = null;
    const workerStartedPromise = new Promise<void>((resolve) => {
      workerStartedResolve = resolve;
    });

    faux.setResponses(
      Array.from({ length: 30 }, () => async (ctx: TranscriptContext) => {
        if (!isOrchestratorContext(ctx)) {
          workerStartedResolve?.();
          await workerHoldPromise;
          const hasReport = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "moco_report");
          if (hasReport) {
            return fauxAssistantMessage([fauxText("Worker finished.")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("moco_report", {
                state: "ready",
                summary: "Workspace lock holder completed.",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (turnMode === "atomic_ops") {
          if (turnResults.length === 0) {
            return fauxAssistantMessage(
              [fauxToolCall("write", { path: "draft.txt", content: "hello world\n" })],
              { stopReason: "toolUse" },
            );
          }
          if (turnResults.length === 1) {
            return fauxAssistantMessage(
              [fauxToolCall("edit", { path: "draft.txt", oldText: "world", newText: "moco" })],
              { stopReason: "toolUse" },
            );
          }
          if (turnResults.length === 2) {
            return fauxAssistantMessage(
              [fauxToolCall("bash", { command: "mv draft.txt renamed.txt && ls -1", timeout: 120 })],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage([fauxText("已在当前工作区完成重命名。")]);
        }

        if (turnMode === "security_guards") {
          if (turnResults.length === 0) {
            return fauxAssistantMessage(
              [
                fauxToolCall("write", { path: path.join(outsideDir, "hack.txt"), content: "nope" }),
                fauxToolCall("read", { path: path.join(identityDir, "identity-agreement.md") }),
                fauxToolCall("read", { path: path.join(stateDir, "moco.sqlite") }),
                fauxToolCall("bash", { command: "curl https://example.com" }),
                fauxToolCall("bash", { command: "rm -rf /" }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage([fauxText("安全护栏已全部拦截。")]);
        }

        // write_lock_conflict
        if (turnResults.length === 0) {
          return fauxAssistantMessage(
            [
              fauxToolCall("write", { path: "conflict.txt", content: "race" }),
              fauxToolCall("bash", { command: "echo race" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("检测到活跃工单写锁，已停止直接修改。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "step4-test",
      config: {
        stateDir,
        identityDir,
        localEnvRoot,
        model: {
          defaultProvider: "step4-test",
          defaultModel: "step4-model",
          thinkingLevel: "off",
        },
      },
    });
    openHubs.push(hub);

    // 1. Atomic write -> edit -> bash rename inside workspaceDir
    const sub1 = await hub.sendUserMessage("帮我建一个 draft.txt 改成 hello moco 并重命名为 renamed.txt");
    expect((await sub1.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(fs.existsSync(path.join(localEnvRoot, "draft.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(localEnvRoot, "renamed.txt"), "utf8")).toBe("hello moco\n");
    expect((await hub.getBoardSnapshot()).tickets).toHaveLength(0);

    // 2. Security guards: outside workspace write, private identity dir read, stateDir read, network bash, dangerous bash
    turnMode = "security_guards";
    const sub2 = await hub.sendUserMessage("测试越界读写与联网命令拦截");
    expect((await sub2.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(fs.existsSync(path.join(outsideDir, "hack.txt"))).toBe(false);

    const entries2 = await hub.rootConversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const guardResults = entries2.items
      .flatMap((e) => e.model ?? [])
      .filter((m) => m.role === "toolResult")
      .slice(-5);
    expect(guardResults).toHaveLength(5);
    for (const res of guardResults) {
      expect(res.isError).toBe(true);
    }

    // 3. Active writable ticket write-lock guard on same workspace directory
    const lockTicket = await hub.dispatchTicket({
      commandId: "lock-holder-1",
      title: "占用同一工作区写入",
      goal: "保持活跃运行以验证主脑写锁",
      scope: localEnvRoot,
      workspaceDir: localEnvRoot,
    });
    await workerStartedPromise;
    expect((await hub.harness.snapshot(MocoStateDoc, BACKGROUND_CONTEXT))?.tickets[lockTicket.id]?.status).toBe("running");

    turnMode = "write_lock_conflict";
    const sub3 = await hub.sendUserMessage("尝试在工单写入期间直接改同一目录");
    expect((await sub3.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(fs.existsSync(path.join(localEnvRoot, "conflict.txt"))).toBe(false);

    const entries3 = await hub.rootConversation.entries({ order: "ascending" }, 120, undefined, BACKGROUND_CONTEXT);
    const lockResults = entries3.items
      .flatMap((e) => e.model ?? [])
      .filter((m) => m.role === "toolResult")
      .slice(-2);
    expect(lockResults).toHaveLength(2);
    for (const res of lockResults) {
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(lockTicket.id);
    }

    workerHoldResolve?.();
    await waitFor(async () => {
      const snap = await hub.harness.snapshot(MocoStateDoc, BACKGROUND_CONTEXT);
      return snap?.tickets[lockTicket.id]?.status === "ready";
    });
  });

  it("delivers fast Worker tasks inline in the same turn (0 relays, 0 board noise) and escalates slow or blocked tasks cleanly with exact single delivery", async () => {
    const stateDir = makeTempDir("fast-state");
    const identityDir = makeTempDir("fast-identity");
    const localEnvRoot = makeTempDir("fast-workspace");

    const faux = fauxProvider({ provider: "step4-fast", models: [{ id: "step4-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let scenario: "fast" | "slow" | "blocked" = "fast";
    let workerExecutions = 0;
    let observedDispatchPayloads: Array<Record<string, unknown>> = [];

    faux.setResponses(
      Array.from({ length: 40 }, () => async (ctx: TranscriptContext) => {
        if (!isOrchestratorContext(ctx)) {
          const hasReport = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "moco_report");
          if (hasReport) {
            return fauxAssistantMessage([fauxText("Worker done.")]);
          }
          workerExecutions++;
          if (scenario === "fast") {
            return fauxAssistantMessage(
              [
                fauxToolCall("moco_report", {
                  state: "ready",
                  summary: "快速检索完成：共找到 3 处匹配。",
                  deliverable: "1. a.ts\n2. b.ts\n3. c.ts",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (scenario === "slow") {
            await new Promise((r) => setTimeout(r, 350));
            return fauxAssistantMessage(
              [
                fauxToolCall("moco_report", {
                  state: "ready",
                  summary: "长耗时编译构建已顺利完成。",
                  deliverable: "dist/bundle.js generated",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("moco_report", {
                state: "blocked",
                summary: "检测到两套部署目标配置。",
                question: "请确认发布到 staging 还是 prod？",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        // Orchestrator turn
        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastUserMsg = ctx.messages[lastUserIdx];
        const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content ?? "");
        if (userText.includes("[MOCO_WORKER_RELAY]")) {
          return fauxAssistantMessage([fauxText(`收到后台汇报：${scenario}`)]);
        }
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult" && m.toolName === "moco_dispatch");
        if (turnResults.length > 0) {
          const firstBlock = turnResults[0]!.content[0];
          const parsed = JSON.parse(firstBlock && "text" in firstBlock ? firstBlock.text : "{}") as Record<string, unknown>;
          observedDispatchPayloads.push(parsed);
          if ("inline_delivery" in parsed) {
            const inline = parsed.inline_delivery as { summary: string };
            return fauxAssistantMessage([fauxText(`当轮直接拿到结果：${inline.summary}`)]);
          }
          return fauxAssistantMessage([fauxText("任务较重，已转入后台继续推进。")]);
        }

        return fauxAssistantMessage(
          [
            fauxToolCall("moco_dispatch", {
              command_id: `cmd-${scenario}`,
              title: `测试任务-${scenario}`,
              goal: `执行 ${scenario} 任务`,
              scope: "workspace",
              ...(scenario === "slow" ? { inline_wait_ms: 120 } : { inline_wait_ms: 3_000 }),
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "step4-fast",
      config: {
        stateDir,
        identityDir,
        localEnvRoot,
        inlineDispatchWaitMs: 3_000,
        model: {
          defaultProvider: "step4-fast",
          defaultModel: "step4-model",
          thinkingLevel: "off",
        },
      },
    });
    openHubs.push(hub);

    // Case 1: Fast task (< inlineDispatchWaitMs) -> inline_delivery in 1 turn, 0 relays, 0 board cards!
    scenario = "fast";
    observedDispatchPayloads = [];
    workerExecutions = 0;
    const subFast = await hub.sendUserMessage("帮我快速统计匹配项");
    expect((await subFast.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    expect(workerExecutions).toBe(1);
    expect(observedDispatchPayloads).toHaveLength(1);
    expect(observedDispatchPayloads[0]).toMatchObject({
      inline_delivery: {
        state: "ready",
        summary: "快速检索完成：共找到 3 处匹配。",
      },
    });
    // Board must NOT show claimed_inline noise card
    expect((await hub.getBoardSnapshot()).tickets).toHaveLength(0);
    // Conversation must have 0 WorkerRelayEntry and 0 noisy dispatch items
    const fastEntries = await hub.rootConversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    expect(fastEntries.items.filter(WorkerRelayEntry.is)).toHaveLength(0);
    const rootViewAfterFast = await hub.getTopicView("root");
    expect(rootViewAfterFast.messages.filter((m) => m.role === "dispatch")).toHaveLength(0);
    expect(rootViewAfterFast.messages.at(-1)?.text).toContain("当轮直接拿到结果：快速检索完成");

    // Idempotent replay check: calling dispatchTicketForModel again with same commandId returns exact same inlineDelivery without re-running Worker!
    const fastTicketId = (observedDispatchPayloads[0]!.ticket as { id: string }).id;
    const replayed = await hub.dispatchTicketForModel({
      commandId: "cmd-fast",
      title: "测试任务-fast",
      goal: "执行 fast 任务",
      scope: "workspace",
      originConversationId: Number(hub.rootConversation.id),
    });
    expect(replayed.ticket.id).toBe(fastTicketId);
    expect(replayed.inlineDelivery?.summary).toBe("快速检索完成：共找到 3 处匹配。");
    expect(workerExecutions).toBe(1);

    // Case 2: Slow task (> inline_wait_ms: 120ms, takes 350ms) -> escalates cleanly, keeps same Worker running, delivers ONCE via relay!
    scenario = "slow";
    observedDispatchPayloads = [];
    workerExecutions = 0;
    const subSlow = await hub.sendUserMessage("执行耗时构建");
    expect((await subSlow.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    expect(observedDispatchPayloads).toHaveLength(1);
    expect(observedDispatchPayloads[0]).not.toHaveProperty("inline_delivery");
    const slowTicketId = (observedDispatchPayloads[0]!.ticket as { id: string }).id;
    // Escalated ticket IS visible on TicketBoard
    expect((await hub.getBoardSnapshot()).tickets.some((t) => t.id === slowTicketId)).toBe(true);

    // Wait for the same Worker to finish in background and deliver relay once
    await waitFor(async () => {
      const entries = await hub.rootConversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
      return entries.items.filter((e) => WorkerRelayEntry.is(e) && e.data.ticketId === slowTicketId).length === 1;
    });
    await waitFor(async () => !(await hub.getTopicView("root")).live.busy);
    expect(workerExecutions).toBe(1);
    const slowEntries = await hub.rootConversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    expect(slowEntries.items.filter((e) => WorkerRelayEntry.is(e) && e.data.ticketId === slowTicketId)).toHaveLength(1);

    // Case 3: Blocked task (< inline_wait_ms: 3000ms) -> wakes inline waiter immediately, escalates, and delivers blocked relay once!
    scenario = "blocked";
    observedDispatchPayloads = [];
    workerExecutions = 0;
    const t0 = Date.now();
    const subBlocked = await hub.sendUserMessage("执行需要确认的发布");
    expect((await subBlocked.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const elapsedMs = Date.now() - t0;
    // Must wake up immediately on blocked report rather than sleeping the full 3000ms window!
    expect(elapsedMs).toBeLessThan(2_200);
    expect(observedDispatchPayloads[0]).not.toHaveProperty("inline_delivery");
    const blockedTicketId = (observedDispatchPayloads[0]!.ticket as { id: string }).id;
    await waitFor(async () => {
      const entries = await hub.rootConversation.entries({ order: "ascending" }, 250, undefined, BACKGROUND_CONTEXT);
      return entries.items.filter((e) => WorkerRelayEntry.is(e) && e.data.ticketId === blockedTicketId).length === 1;
    });
    expect(workerExecutions).toBe(1);
  });
});
