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
  AssistantEntry,
  LiveDoc,
  type ConversationId,
} from "@earendil-works/pi-durable";
import type { TicketRecord } from "@kulo/protocol";
import {
  BOOT_GATE_FILENAME,
  CRASH_LOOP_WINDOW_MS,
  KuloStateDoc,
  RESTART_GATE_CONTINUE_OPTION_ID,
  RESTART_GATE_WAIT_TOKEN_PREFIX,
  evaluateTicketRestartAutoResume,
  isDeclaredReadOnlyTool,
  recordBootStart,
  recordGracefulShutdown,
  resolveBootGateLocalNodeId,
  type KuloHub,
  type KuloHubConfigOverrides,
} from "@kulo/hub";
import { isSafeSyncRelativePath, TIER3_FIXED_FILES } from "../packages/hub/src/cluster-sync-paths.js";
import { hasFailoverTrustGuard } from "../packages/hub/src/hub-kernel-ports.js";
import { appendTicketOutwardAction } from "../packages/hub/src/task-recovery.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isOrchestratorRequest(request: TranscriptContext): boolean {
  return (
    Boolean(request.tools?.some((tool) => tool.name === "kulo_dispatch")) ||
    request.messages.some(
      (message) =>
        message.role === "system" &&
        "toolsAdded" in message &&
        Array.isArray(message.toolsAdded) &&
        message.toolsAdded.some((tool) => tool.name === "kulo_dispatch"),
    )
  );
}

function makeTicketRecord(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "T-0001",
    commandId: "cmd-1",
    title: "测试工单",
    goal: "检查文件状态",
    scope: "/tmp/project",
    role: "scout",
    status: "running",
    envId: "local",
    workspaceDir: "/tmp/project",
    readOnly: true,
    workerConversationId: 2,
    runEpoch: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function hubConfig(rootDir: string, overrides: KuloHubConfigOverrides = {}): KuloHubConfigOverrides {
  return {
    stateDir: path.join(rootDir, "hub-state"),
    localEnvRoot: path.join(rootDir, "local-runtime"),
    identityDir: path.join(rootDir, "private-identity"),
    authToken: HUB_TEST_ADMIN_TOKEN,
    maxConcurrentWorkers: 2,
    watchdogMinutes: 0,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: {
      baseUrl: "http://127.0.0.1:9/v1",
      apiMode: "openai-completions",
      defaultModel: "gpt-4o",
      thinkingLevel: "off",
    },
    ...overrides,
  };
}

async function openTrackedHub(
  config: KuloHubConfigOverrides,
  onRequest: (request: TranscriptContext, options?: unknown) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
): Promise<KuloHub> {
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 64 }, () => onRequest));
  const hub = await openTestHub({ config, models });
  cleanups.push(async () => {
    await hub.close().catch(() => {});
  });
  return hub;
}

describe("Stage 1 P1-4B: boot-gate persistence & positive read-only proof (unit)", () => {
  it("never exposes boot-gate.json in cluster-sync-paths.ts sync allowlist", () => {
    expect(isSafeSyncRelativePath(BOOT_GATE_FILENAME)).toBe(false);
    expect((TIER3_FIXED_FILES as readonly string[]).includes(BOOT_GATE_FILENAME)).toBe(false);
  });

  it("binds graceful shutdown marker to localNodeId + bootId and consumes it once on next boot", () => {
    const stateDir = tempDir("kulo-boot-gate-graceful-");
    const t0 = 1_700_000_000_000;

    // Initial boot on empty stateDir
    const first = recordBootStart(stateDir, "node-a", t0);
    expect(first.wasGracefulRestart).toBe(false);
    expect(first.crashLoopTripped).toBe(false);
    expect(first.recentUnexpectedBoots).toEqual([]);

    // Graceful shutdown writes kind=graceful bound to node-a + bootId
    recordGracefulShutdown(stateDir, "node-a", first.bootId, t0 + 1_000);
    const onDiskAfterClose = JSON.parse(fs.readFileSync(path.join(stateDir, BOOT_GATE_FILENAME), "utf8"));
    expect(onDiskAfterClose).toMatchObject({
      kind: "graceful",
      localNodeId: "node-a",
      bootId: first.bootId,
    });

    // Next boot on same node-a consumes graceful marker and immediately persists kind=running
    const second = recordBootStart(stateDir, "node-a", t0 + 2_000);
    expect(second.wasGracefulRestart).toBe(true);
    expect(second.crashLoopTripped).toBe(false);
    expect(second.bootId).not.toBe(first.bootId);
    const onDiskAfterOpen = JSON.parse(fs.readFileSync(path.join(stateDir, BOOT_GATE_FILENAME), "utf8"));
    expect(onDiskAfterOpen).toMatchObject({
      kind: "running",
      localNodeId: "node-a",
      bootId: second.bootId,
    });

    // Crash (no graceful shutdown) -> third boot sees unexpected boot #1
    const third = recordBootStart(stateDir, "node-a", t0 + 3_000);
    expect(third.wasGracefulRestart).toBe(false);
    expect(third.crashLoopTripped).toBe(false);
    expect(third.recentUnexpectedBoots).toEqual([t0 + 3_000]);
  });

  it("Case ④ (unit): rejects a graceful boot-gate.json copied from another localNodeId", () => {
    const primaryDir = tempDir("kulo-boot-gate-primary-");
    const standbyDir = tempDir("kulo-boot-gate-standby-");
    const t0 = 1_700_000_000_000;

    const primaryBoot = recordBootStart(primaryDir, "node-primary-1", t0);
    recordGracefulShutdown(primaryDir, "node-primary-1", primaryBoot.bootId, t0 + 500);

    // Copy primary's graceful boot-gate.json directly into standby's stateDir
    fs.copyFileSync(
      path.join(primaryDir, BOOT_GATE_FILENAME),
      path.join(standbyDir, BOOT_GATE_FILENAME),
    );

    const standbyBoot = recordBootStart(standbyDir, "node-standby-2", t0 + 1_000);
    expect(standbyBoot.wasGracefulRestart).toBe(false);
    expect(standbyBoot.localNodeId).toBe("node-standby-2");
    expect(standbyBoot.crashLoopTripped).toBe(false);

    // Verify resolveBootGateLocalNodeId prefers devices.json localNodeId when explicit override absent
    fs.writeFileSync(
      path.join(standbyDir, "devices.json"),
      JSON.stringify({ version: 1, hubId: "h1", enabled: true, localNodeId: "node-standby-2", devices: [] }),
    );
    expect(resolveBootGateLocalNodeId(standbyDir)).toBe("node-standby-2");
    expect(resolveBootGateLocalNodeId(standbyDir, "node-explicit")).toBe("node-explicit");
  });

  it("Case ⑤ (unit): trips crashLoopTripped on 2 unexpected boots within 5 minutes and prunes older ones", () => {
    const stateDir = tempDir("kulo-boot-gate-loop-");
    const t0 = 1_700_000_000_000;

    // First normal launch
    recordBootStart(stateDir, "node-a", t0);
    // Crash 1 -> unexpected boot #1
    const u1 = recordBootStart(stateDir, "node-a", t0 + 10_000);
    expect(u1.wasGracefulRestart).toBe(false);
    expect(u1.crashLoopTripped).toBe(false);
    expect(u1.recentUnexpectedBoots).toHaveLength(1);

    // Crash 2 within 5 min -> unexpected boot #2 -> crash loop tripped
    const u2 = recordBootStart(stateDir, "node-a", t0 + 60_000);
    expect(u2.wasGracefulRestart).toBe(false);
    expect(u2.crashLoopTripped).toBe(true);
    expect(u2.recentUnexpectedBoots).toHaveLength(2);

    // After > 5 min window expires, single unexpected boot does NOT trip crash loop
    const u3 = recordBootStart(stateDir, "node-a", t0 + 60_000 + CRASH_LOOP_WINDOW_MS + 1_000);
    expect(u3.wasGracefulRestart).toBe(false);
    expect(u3.crashLoopTripped).toBe(false);
    expect(u3.recentUnexpectedBoots).toHaveLength(1);

    // Symlinked boot-gate.json fails closed
    const outside = path.join(tempDir("kulo-boot-gate-outside-"), "fake.json");
    fs.writeFileSync(outside, JSON.stringify({ version: 1, kind: "graceful", localNodeId: "node-a", bootId: "b", at: t0 }));
    fs.rmSync(path.join(stateDir, BOOT_GATE_FILENAME), { force: true });
    fs.symlinkSync(outside, path.join(stateDir, BOOT_GATE_FILENAME));
    const afterSymlink = recordBootStart(stateDir, "node-a", t0 + 60_000 + CRASH_LOOP_WINDOW_MS + 5_000);
    expect(afterSymlink.wasGracefulRestart).toBe(false);
  });

  it("enforces positive read-only whitelist proof and rejects any single unsatisfied condition", () => {
    const baseInput = {
      ticket: makeTicketRecord(),
      oldEpoch: 1,
      wasGracefulRestart: true,
      bootWasFailover: false,
      crashLoopTripped: false,
      executedTools: ["read", "web_search", "kulo_skill_read"],
      historyVerified: true,
      hasActiveSubagents: false,
    } as const;

    expect(evaluateTicketRestartAutoResume(baseInput)).toMatchObject({
      action: "auto_resume",
      reasons: [],
    });

    // Whitelist checks
    expect(isDeclaredReadOnlyTool("read")).toBe(true);
    expect(isDeclaredReadOnlyTool("web_fetch")).toBe(true);
    expect(isDeclaredReadOnlyTool("write")).toBe(false);
    expect(isDeclaredReadOnlyTool("edit")).toBe(false);
    expect(isDeclaredReadOnlyTool("bash")).toBe(false);
    expect(isDeclaredReadOnlyTool("kulo_browser")).toBe(false);
    expect(isDeclaredReadOnlyTool("kulo_desktop")).toBe(false);
    expect(isDeclaredReadOnlyTool("kulo_connection_use")).toBe(false);
    expect(isDeclaredReadOnlyTool("kulo_subagent")).toBe(false);

    // Every negative condition independently fails closed
    expect(evaluateTicketRestartAutoResume({ ...baseInput, bootWasFailover: true })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["failover"]),
    });
    expect(evaluateTicketRestartAutoResume({ ...baseInput, crashLoopTripped: true })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["crash_loop"]),
    });
    expect(evaluateTicketRestartAutoResume({ ...baseInput, wasGracefulRestart: false })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["unexpected_restart"]),
    });
    expect(evaluateTicketRestartAutoResume({ ...baseInput, ticket: makeTicketRecord({ readOnly: false }) })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["not_read_only"]),
    });
    expect(evaluateTicketRestartAutoResume({ ...baseInput, ticket: makeTicketRecord({ deviceStateTouched: true }) })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["device_state_touched"]),
    });
    expect(
      evaluateTicketRestartAutoResume({
        ...baseInput,
        ticket: makeTicketRecord({
          outwardActions: [{ runEpoch: 1, kind: "connection", label: "http:POST api/send", at: 100 }],
        }),
      }),
    ).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["outward_actions"]),
    });
    for (const unsafeTool of ["write", "edit", "bash", "kulo_browser", "kulo_desktop", "kulo_connection_use", "kulo_subagent"]) {
      expect(
        evaluateTicketRestartAutoResume({
          ...baseInput,
          executedTools: ["read", unsafeTool],
        }),
      ).toMatchObject({
        action: "require_user_review",
        reasons: expect.arrayContaining(["non_read_only_tools"]),
      });
    }
    expect(evaluateTicketRestartAutoResume({ ...baseInput, executedTools: undefined })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["unverified_history"]),
    });
    expect(evaluateTicketRestartAutoResume({ ...baseInput, hasActiveSubagents: true })).toMatchObject({
      action: "require_user_review",
      reasons: expect.arrayContaining(["active_subagents"]),
    });
  });
});

describe("Stage 1 P1-4B: Hub restart auto-resume safety gate (end-to-end integration)", () => {
  it("positive case: gracefully restarted pure read-only ticket auto-resumes and completes", async () => {
    const root = tempDir("kulo-rg-positive-");
    const cfg = hubConfig(root);
    let phase: "before" | "after" = "before";
    let workerStartedResolve!: () => void;
    const workerStarted = new Promise<void>((r) => { workerStartedResolve = r; });
    let outboundAfterRestart = 0;

    let hub = await openTrackedHub(cfg, async (request, options) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("已收到。")]);
      if (phase === "before") {
        workerStartedResolve();
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage([fauxText("中断中")]);
      }
      outboundAfterRestart++;
      return fauxAssistantMessage(
        [fauxToolCall("kulo_report", { state: "ready", summary: "只读任务优雅重启后自动完成。" })],
        { stopReason: "toolUse" },
      );
    });

    const card = await hub.dispatchTicket({
      commandId: "rg-positive-ro",
      title: "只读检查任务",
      goal: "只读检查当前工作区",
      scope: "工作区",
      role: "scout",
      readOnly: true,
    });
    await workerStarted;
    await hub.close();

    phase = "after";
    hub = await openTrackedHub(cfg, async (request) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("已收到。")]);
      outboundAfterRestart++;
      return fauxAssistantMessage(
        [fauxToolCall("kulo_report", { state: "ready", summary: "只读任务优雅重启后自动完成。" })],
        { stopReason: "toolUse" },
      );
    });

    expect(hub.bootGate.wasGracefulRestart).toBe(true);
    expect(hub.bootGate.bootWasFailover).toBe(false);
    expect(hub.bootGate.crashLoopTripped).toBe(false);
    await until(
      async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.status === "ready",
      "read-only ticket to auto-resume after graceful restart",
    );
    expect(outboundAfterRestart).toBe(1);
  });

  it("Case ①: bootWasFailover blocks auto-resume even after failover-trust-guard.json is deleted during open()", async () => {
    const root = tempDir("kulo-rg-case1-failover-");
    const cfg = hubConfig(root);
    let workerStartedResolve!: () => void;
    const workerStarted = new Promise<void>((r) => { workerStartedResolve = r; });

    let hub = await openTrackedHub(cfg, async (request, options) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("ok")]);
      workerStartedResolve();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([fauxText("aborted")]);
    });

    const card = await hub.dispatchTicket({
      commandId: "rg-failover-ro",
      title: "热备接管只读工单",
      goal: "验证 failover 后绝不自动续跑",
      scope: "工作区",
      role: "scout",
      readOnly: true,
    });
    await workerStarted;
    await hub.close();

    // Even with a graceful boot-gate.json on disk, plant failover-trust-guard.json
    fs.writeFileSync(
      path.join(cfg.stateDir!, "failover-trust-guard.json"),
      JSON.stringify({ reason: "failover", promotedAt: Date.now() }),
    );
    expect(hasFailoverTrustGuard(cfg.stateDir!)).toBe(true);

    let outboundRequests = 0;
    hub = await openTrackedHub(cfg, async () => {
      outboundRequests++;
      return fauxAssistantMessage([fauxText("SHOULD NOT FIRE")]);
    });

    // File is already deleted during open(), yet in-memory bootWasFailover still blocks auto-resume!
    expect(hasFailoverTrustGuard(cfg.stateDir!)).toBe(false);
    expect(hub.bootGate.bootWasFailover).toBe(true);

    await until(async () => {
      const t = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      return t?.status === "waiting" && t.cleanupPending === false;
    }, "failover ticket to settle into waiting(reason=user)");

    await new Promise((r) => setTimeout(r, 200));
    const after = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
    expect(after).toMatchObject({
      status: "waiting",
      cleanupPending: false,
      waiting: { reason: "user" },
    });
    expect(after?.waiting?.detail).toContain("故障接管");
    expect(outboundRequests).toBe(0);
  });

  it("Case ②: oldEpoch outwardActions blocks auto-resume before runEpoch++ and reconciler never wakes it", async () => {
    const root = tempDir("kulo-rg-case2-outward-");
    const cfg = hubConfig(root);
    let workerStartedResolve!: () => void;
    const workerStarted = new Promise<void>((r) => { workerStartedResolve = r; });

    let hub = await openTrackedHub(cfg, async (request, options) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("ok")]);
      workerStartedResolve();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([fauxText("aborted")]);
    });

    const card = await hub.dispatchTicket({
      commandId: "rg-outward-ro",
      title: "含外部动作的工单",
      goal: "验证 oldEpoch outwardActions 拦停自动续跑",
      scope: "工作区",
      role: "scout",
      readOnly: true,
    });
    await workerStarted;

    // Record an outward action on oldEpoch (runEpoch === 1) before graceful shutdown
    let oldEpoch = 0;
    await hub.harness.commit(async (tx) => {
      const t = (await tx.doc(KuloStateDoc)).tickets[card.id]!;
      oldEpoch = t.runEpoch;
      appendTicketOutwardAction(t, {
        runEpoch: oldEpoch,
        kind: "connection",
        label: "http:POST webhook/dispatch",
        at: Date.now(),
      });
    }, context);
    await hub.close();

    let outboundRequests = 0;
    hub = await openTrackedHub(cfg, async () => {
      outboundRequests++;
      return fauxAssistantMessage([fauxText("SHOULD NOT FIRE")]);
    });

    expect(hub.bootGate.wasGracefulRestart).toBe(true);
    await until(async () => {
      const t = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      return t?.status === "waiting" && t.cleanupPending === false;
    }, "outward-action ticket to settle into waiting(reason=user)");

    await new Promise((r) => setTimeout(r, 200));
    const settled = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
    expect(settled?.runEpoch).toBeGreaterThan(oldEpoch);
    expect(settled).toMatchObject({
      status: "waiting",
      cleanupPending: false,
      waiting: {
        reason: "user",
        waitToken: `${RESTART_GATE_WAIT_TOKEN_PREFIX}${oldEpoch}`,
      },
    });
    expect(settled?.waiting?.detail).toContain("http:POST webhook/dispatch");
    expect(outboundRequests).toBe(0);
  });

  it("Case ③: writable ticket and browser-touched ticket never auto-resume on graceful restart", async () => {
    const root = tempDir("kulo-rg-case3-write-browser-");
    const cfg = hubConfig(root);
    const startedIds = new Set<string>();
    let bothStartedResolve!: () => void;
    const bothStarted = new Promise<void>((r) => { bothStartedResolve = r; });

    let hub = await openTrackedHub(cfg, async (request, options) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("ok")]);
      const text = JSON.stringify(request.messages);
      if (text.includes("写任务工单")) startedIds.add("write");
      if (text.includes("浏览器交互工单")) startedIds.add("browser");
      if (startedIds.size === 2) bothStartedResolve();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([fauxText("aborted")]);
    });

    const writeCard = await hub.dispatchTicket({
      commandId: "rg-write-ticket",
      title: "写任务工单",
      goal: "修改项目代码",
      scope: "工作区",
      role: "coder",
      readOnly: false,
    });
    const browserCard = await hub.dispatchTicket({
      commandId: "rg-browser-ticket",
      title: "浏览器交互工单",
      goal: "打开并交互浏览器页面",
      scope: "工作区",
      role: "scout",
      readOnly: true,
    });
    await bothStarted;

    // Mark browser ticket as deviceStateTouched AND record a kulo_browser tool call in its worker transcript
    const snapBefore = await hub.harness.snapshot(KuloStateDoc, context);
    const browserWorkerConvId = snapBefore!.tickets[browserCard.id]!.workerConversationId as ConversationId;
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[browserCard.id]!.deviceStateTouched = true;
      await tx.appendEntry(AssistantEntry, browserWorkerConvId, {
        model: [fauxAssistantMessage([fauxToolCall("kulo_browser", { action: "click", ref: "@e1" })], { stopReason: "toolUse" })],
      });
    }, context);
    await hub.close();

    let outboundRequests = 0;
    hub = await openTrackedHub(cfg, async () => {
      outboundRequests++;
      return fauxAssistantMessage([fauxText("SHOULD NOT FIRE")]);
    });

    expect(hub.bootGate.wasGracefulRestart).toBe(true);
    await until(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const w = snap?.tickets[writeCard.id];
      const b = snap?.tickets[browserCard.id];
      return (
        w?.status === "waiting" &&
        w.cleanupPending === false &&
        b?.status === "waiting" &&
        b.cleanupPending === false
      );
    }, "write and browser tickets to settle into waiting(reason=user)");

    await new Promise((r) => setTimeout(r, 200));
    const after = await hub.harness.snapshot(KuloStateDoc, context);
    expect(after?.tickets[writeCard.id]?.waiting?.reason).toBe("user");
    expect(after?.tickets[browserCard.id]?.waiting?.reason).toBe("user");
    expect(after?.tickets[browserCard.id]?.waiting?.detail).toContain("浏览器");
    expect(outboundRequests).toBe(0);
  });

  it("Case ④ (integration): boot-gate.json copied from old primary node is invalid on standby with different localNodeId", async () => {
    const root = tempDir("kulo-rg-case4-node-mismatch-");
    const primaryCfg = hubConfig(root, { localEnvId: "node-primary-alpha" });
    let workerStartedResolve!: () => void;
    const workerStarted = new Promise<void>((r) => { workerStartedResolve = r; });

    let hub = await openTrackedHub(primaryCfg, async (request, options) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("ok")]);
      workerStartedResolve();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([fauxText("aborted")]);
    });

    const card = await hub.dispatchTicket({
      commandId: "rg-node-mismatch",
      title: "跨节点只读工单",
      goal: "验证跨节点复制 boot-gate.json 无效",
      scope: "工作区",
      role: "scout",
      readOnly: true,
    });
    await workerStarted;
    // Rebind ticket envId to standby so env is online on standby boot
    await hub.harness.commit(async (tx) => {
      (await tx.doc(KuloStateDoc)).tickets[card.id]!.envId = "node-standby-beta";
    }, context);
    await hub.close();

    // Confirm boot-gate.json on disk is graceful for node-primary-alpha
    const gateBefore = JSON.parse(fs.readFileSync(path.join(primaryCfg.stateDir!, BOOT_GATE_FILENAME), "utf8"));
    expect(gateBefore).toMatchObject({ kind: "graceful", localNodeId: "node-primary-alpha" });

    // Reopen same stateDir as a different localNodeId (simulating copied boot-gate.json on standby)
    let outboundRequests = 0;
    const standbyCfg = hubConfig(root, { localEnvId: "node-standby-beta" });
    hub = await openTrackedHub(standbyCfg, async () => {
      outboundRequests++;
      return fauxAssistantMessage([fauxText("SHOULD NOT FIRE")]);
    });

    expect(hub.bootGate.localNodeId).toBe("node-standby-beta");
    expect(hub.bootGate.wasGracefulRestart).toBe(false);

    await until(async () => {
      const t = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      return t?.status === "waiting" && t.cleanupPending === false;
    }, "standby ticket to be held at waiting(reason=user)");

    await new Promise((r) => setTimeout(r, 200));
    const settled = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
    expect(settled?.waiting?.reason).toBe("user");
    expect(outboundRequests).toBe(0);
  });

  it("Case ⑤ (integration): 2 unexpected boots within 5 min trips crash-loop fuse and aborts active main conversation before harness.resume()", async () => {
    const root = tempDir("kulo-rg-case5-crash-loop-");
    const cfg = hubConfig(root);
    let mainRunStartedResolve!: () => void;
    const mainRunStarted = new Promise<void>((r) => { mainRunStartedResolve = r; });

    let hub = await openTrackedHub(cfg, async (_request, options) => {
      mainRunStartedResolve();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([fauxText("interrupted")]);
    });

    // Start an in-flight main conversation turn
    void hub.sendUserMessage("请帮我分析一下架构日志", { requestId: "crash-loop-main-turn" });
    await mainRunStarted;
    const liveBeforeCrash = await hub.harness.snapshot(LiveDoc, hub.rootConversation.id, context);
    expect(liveBeforeCrash?.run).toBeDefined();

    // Close Hub cleanly to release SQLite/lock cleanly in test, then simulate 1st unexpected boot
    // followed by a crash state (non-graceful boot-gate.json with 1 recent unexpected boot within 5 min)
    await hub.close();

    const now = Date.now();
    fs.writeFileSync(
      path.join(cfg.stateDir!, BOOT_GATE_FILENAME),
      JSON.stringify({
        version: 1,
        kind: "running",
        localNodeId: "local",
        bootId: "crashed-boot-1",
        startedAt: now - 30_000,
        at: now - 30_000,
        recentUnexpectedBoots: [now - 30_000],
      }),
    );

    let outboundOnBoot = 0;
    let retryAnswered = false;
    hub = await openTrackedHub(cfg, async () => {
      outboundOnBoot++;
      retryAnswered = true;
      return fauxAssistantMessage([fauxText("手动点击重试后已恢复回复。")]);
    });

    expect(hub.bootGate.wasGracefulRestart).toBe(false);
    expect(hub.bootGate.crashLoopTripped).toBe(true);
    expect(hub.bootGate.recentUnexpectedBoots).toHaveLength(2);

    // Wait briefly to confirm zero unsolicited model requests fire after harness.resume()
    await new Promise((r) => setTimeout(r, 200));
    expect(outboundOnBoot).toBe(0);

    const liveAfterFuse = await hub.harness.snapshot(LiveDoc, hub.rootConversation.id, context);
    expect(liveAfterFuse?.run).toBeUndefined();
    expect(liveAfterFuse?.runFailure?.reason).toBe("aborted");

    // Existing main conversation retry button (retryTurn) still works cleanly when user clicks it
    const retryResult = await hub.retryTurn("root", "user-manual-retry-after-fuse");
    expect(retryResult.retried).toBe(true);
    await hub.rootConversation.waitForIdle(context);
    expect(retryAnswered).toBe(true);
    expect(outboundOnBoot).toBe(1);
  });

  it("Case ⑥: clicking Continue twice (same or distinct commandIds) is idempotent and triggers exactly 1 execution", async () => {
    const root = tempDir("kulo-rg-case6-idempotent-continue-");
    const cfg = hubConfig(root);
    let workerStartedResolve!: () => void;
    const workerStarted = new Promise<void>((r) => { workerStartedResolve = r; });

    let hub = await openTrackedHub(cfg, async (request, options) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("ok")]);
      workerStartedResolve();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([fauxText("aborted")]);
    });

    const card = await hub.dispatchTicket({
      commandId: "rg-double-continue",
      title: "双点继续幂等验证",
      goal: "验证连续点击继续只执行一次",
      scope: "工作区",
      role: "coder",
      readOnly: false,
    });
    await workerStarted;
    await hub.close();

    let workerOutboundCount = 0;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => { releaseWorker = r; });
    cleanups.push(() => releaseWorker());

    hub = await openTrackedHub(cfg, async (request) => {
      if (isOrchestratorRequest(request)) return fauxAssistantMessage([fauxText("已收到汇报。")]);
      workerOutboundCount++;
      await workerGate;
      return fauxAssistantMessage(
        [fauxToolCall("kulo_report", { state: "ready", summary: "幂等继续完成。" })],
        { stopReason: "toolUse" },
      );
    });

    await until(async () => {
      const t = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      return t?.status === "waiting" && t.cleanupPending === false;
    }, "writable ticket to wait for user review");

    const waitingTicket = (await hub.harness.snapshot(KuloStateDoc, context))!.tickets[card.id]!;
    expect(waitingTicket.waiting?.reason).toBe("user");
    expect(waitingTicket.waiting?.waitToken?.startsWith(RESTART_GATE_WAIT_TOKEN_PREFIX)).toBe(true);
    expect(waitingTicket.waiting?.options?.some((opt) => opt.id === RESTART_GATE_CONTINUE_OPTION_ID)).toBe(true);

    // Fire TWO concurrent Continue clicks with different commandIds + a duplicate of the first commandId
    const continueText = waitingTicket.waiting!.options!.find((opt) => opt.id === RESTART_GATE_CONTINUE_OPTION_ID)!.value!;
    await Promise.all([
      hub.deliverClientMessage({
        type: "ticket.steer",
        ticketId: card.id,
        commandId: "click-continue-1",
        text: continueText,
        decisionOptionId: RESTART_GATE_CONTINUE_OPTION_ID,
      }),
      hub.deliverClientMessage({
        type: "ticket.steer",
        ticketId: card.id,
        commandId: "click-continue-1",
        text: continueText,
        decisionOptionId: RESTART_GATE_CONTINUE_OPTION_ID,
      }),
      hub.deliverClientMessage({
        type: "ticket.steer",
        ticketId: card.id,
        commandId: "click-continue-2",
        text: continueText,
        decisionOptionId: RESTART_GATE_CONTINUE_OPTION_ID,
      }),
    ]);

    await until(() => workerOutboundCount === 1, "single worker execution to reach model");
    // Even another late click while running must not inject a second execution
    await hub.deliverClientMessage({
      type: "ticket.steer",
      ticketId: card.id,
      commandId: "click-continue-3",
      text: continueText,
      decisionOptionId: RESTART_GATE_CONTINUE_OPTION_ID,
    });
    releaseWorker();

    await until(
      async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.status === "ready",
      "ticket to reach ready",
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(workerOutboundCount).toBe(1);
  });

  it("§2.2 sentinel secret redaction: writing waiting.detail with sentinel secrets never triggers documentLeak and stores redacted text", async () => {
    const root = tempDir("kulo-rg-sentinel-redaction-");
    const cfg = hubConfig(root);
    const hub = await openTrackedHub(cfg, async () => fauxAssistantMessage([fauxText("ok")]));

    const openaiSentinel = "sk-test-sentinel-1234567890abcdefghijklmnop";
    const vaultSentinel = "kulo-vault-sentinel-secret-9988776655";
    await hub.connectionManager.save({
      kind: "api-key",
      name: "SentinelAPI",
      url: "https://api.example.com",
      authType: "bearer",
      secrets: { apiKey: vaultSentinel },
    });

    const dirtyTicket = makeTicketRecord({
      id: "T-SENTINEL",
      readOnly: true,
      outwardActions: [
        {
          runEpoch: 1,
          kind: "connection",
          label: `http:POST api/send key=${openaiSentinel} tok=${vaultSentinel}`,
          at: Date.now(),
        },
      ],
    });

    const decision = evaluateTicketRestartAutoResume({
      ticket: dirtyTicket,
      oldEpoch: 1,
      wasGracefulRestart: true,
      bootWasFailover: false,
      crashLoopTripped: false,
      executedTools: ["read"],
      historyVerified: true,
      redact: (text) => hub.connectionManager.redact(text),
    });

    expect(decision.action).toBe("require_user_review");
    expect(decision.waitingDetail).not.toContain(openaiSentinel);
    expect(decision.waitingDetail).not.toContain(vaultSentinel);

    // Committing the sanitized waiting.detail to real wrapRedactedStorage-backed KuloStateDoc succeeds cleanly
    await expect(
      hub.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        state.tickets["T-SENTINEL"] = {
          ...dirtyTicket,
          outwardActions: [],
          status: "waiting",
          waiting: {
            reason: "user",
            since: Date.now(),
            detail: decision.waitingDetail,
            waitToken: decision.action === "require_user_review" ? decision.waitToken : undefined,
            options: decision.action === "require_user_review" ? decision.waitingOptions : undefined,
          },
        };
      }, context),
    ).resolves.toBeUndefined();

    const stored = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets["T-SENTINEL"];
    expect(stored?.waiting?.detail).toBe(decision.waitingDetail);
    expect(stored?.waiting?.detail).not.toContain(openaiSentinel);
    expect(stored?.waiting?.detail).not.toContain(vaultSentinel);
  });

  it("preserves externalExecution native process receipt reconciliation path untouched on restart", async () => {
    const root = tempDir("kulo-rg-external-preserved-");
    const cfg = hubConfig(root);
    let hub = await openTrackedHub(cfg, async () => fauxAssistantMessage([fauxText("ok")]));

    // Seed a running externalExecution ticket before graceful shutdown
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-EXT-1"] = makeTicketRecord({
        id: "T-EXT-1",
        status: "running",
        readOnly: false,
        runEpoch: 3,
        externalExecution: {
          binding: {
            kind: "codex",
            envId: "local",
            capabilities: { resume: true, streaming: true },
          },
          instructions: "check repo",
          runId: "kulo:external:T-EXT-1:3",
          sessionId: "sess-ext-1",
          allowSubagents: false,
        },
      });
    }, context);
    await hub.close();

    hub = await openTrackedHub(cfg, async () => fauxAssistantMessage([fauxText("ok")]));
    const after = (await hub.harness.snapshot(KuloStateDoc, context))!;
    // External execution ticket stays running on its original runEpoch without being converted to waiting(reason="user")
    expect(after.tickets["T-EXT-1"]).toMatchObject({
      status: "running",
      runEpoch: 3,
    });
    expect(after.tickets["T-EXT-1"]?.waiting).toBeUndefined();
    expect(after.slots.holders).toContain("T-EXT-1");
  });
});
