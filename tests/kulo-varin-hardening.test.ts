import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as kernel from "acp-kernel";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { Harness, LiveDoc, MemoryStorage, UserEntry, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { EnvNodeDescriptor, RolePreset, TicketRecord } from "@kulo/protocol";
import {
  DEFAULT_COMPACTION_CONFIG,
  buildAdaptiveCompactionPolicy,
  clampCompactionConfigForWindow,
  resolveHubConfig,
} from "../packages/hub/src/config.js";
import { createContextCompactionController, validateBillionKernel } from "../packages/hub/src/context-compaction.js";
import { createOrchestratorSections } from "../packages/hub/src/prompts.js";
import { buildRecentWorkSnapshot } from "../packages/hub/src/recent-work.js";
import { AssistantEchoSuppressor } from "../packages/hub/src/assistant-echo.js";
import { AssistantLedger } from "../packages/hub/src/assistant-ledger.js";
import { AssistantDoc } from "../packages/hub/src/assistant-state.js";
import { AssistantSorter, MAX_SORTER_PROMPT_EVENTS } from "../packages/hub/src/assistant-sorter.js";
import { AssistantCoordinator } from "../packages/hub/src/assistant-coordinator.js";
import { KuloActionConfirmations, effectiveConfirmationEffect } from "../packages/hub/src/action-confirmations.js";
import { KuloUiCards } from "../packages/hub/src/ui-cards.js";
import { isHomeAssistantPreDispatchError } from "../packages/hub/src/connectors/home-assistant.js";
import { assertValidReplyReference, clientDeliveryIntent } from "../packages/hub/src/delivery-receipts.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

describe("#1 Prompt prefix stability", () => {
  it("keeps kulo_envs and kulo_roles byte-identical across transient online/offline and Android paused flips", async () => {
    let online = true;
    let androidPaused = false;
    const getEnvs = (): EnvNodeDescriptor[] => [
      {
        id: "local",
        name: "MacBook",
        kind: "local",
        executionKind: "pi-env",
        platform: "darwin",
        arch: "arm64",
        rootDir: "/Users/test",
        capabilities: ["worker-isolation", "agent-browser"],
        online,
        connectedAt: 1,
      },
      {
        id: "android-1",
        name: "Pixel",
        kind: "remote",
        executionKind: "native-device",
        platform: "android",
        arch: "arm64",
        rootDir: "",
        capabilities: [],
        online,
        connectedAt: 1,
        android: { enabled: true, paused: androidPaused, capabilities: [] },
      },
    ];
    const roles: Record<string, RolePreset> = {
      codex_peer: {
        id: "codex_peer",
        label: "Codex",
        whenToUse: "Heavy coding",
        systemPrompt: "Code",
        external: { kind: "codex", envId: "local", command: "codex" },
      },
    };
    const sections = createOrchestratorSections({
      getIdentityDir: () => "/nonexistent",
      getRoles: () => roles,
      getExternalClients: () => ({
        "codex:local": {
          id: "codex:local",
          kind: "codex",
          envId: "local",
          verifiedAt: 1,
        },
      }),
      getEnvs,
      getMemoryConfig: () => resolveHubConfig({}).memory,
    });
    const envSection = sections.find((s) => s.key === "kulo_envs")!;
    const rolesSection = sections.find((s) => s.key === "kulo_roles")!;
    const { ROOT_CONVERSATION_ID } = await import("@earendil-works/pi-durable");
    const input = {
      conversationId: ROOT_CONVERSATION_ID,
      read: { snapshot: async () => undefined },
    } as unknown as Parameters<typeof envSection.render>[0];

    const envOnline = await envSection.render(input, BACKGROUND_CONTEXT);
    const rolesOnline = await rolesSection.render(input, BACKGROUND_CONTEXT);

    online = false;
    androidPaused = true;

    const envOffline = await envSection.render(input, BACKGROUND_CONTEXT);
    const rolesOffline = await rolesSection.render(input, BACKGROUND_CONTEXT);

    expect(envOffline).toBe(envOnline);
    expect(rolesOffline).toBe(rolesOnline);
    expect(envOnline).not.toContain("| Status |");
    expect(envOnline).not.toContain("android (paused)");
  });

  it("merges transient queued -> running in recent-work while keeping waiting/ready authoritative", () => {
    const baseTicket: TicketRecord = {
      id: "t1",
      commandId: "cmd-1",
      title: "重构模块",
      goal: "重构模块",
      scope: "当前项目",
      status: "queued",
      role: "coder",
      envId: "local",
      workspaceDir: "/repo",
      workerConversationId: 100,
      runEpoch: 1,
      createdAt: 10,
      updatedAt: 10,
    };
    const state = {
      tickets: { t1: { ...baseTicket } },
      topics: { root: { id: "root", conversationId: 1, title: "Kulo", master: true, createdAt: 1, updatedAt: 1 } },
      conversationToTopic: { "1": "root" },
      conversationToTicket: { "100": "t1" },
      conversationToSubagent: {},
      slots: { max: 2, holders: [] },
      processedCommands: {},
    };
    const queuedSnap = buildRecentWorkSnapshot({ state, projects: undefined, conversationId: 1, enabled: true });
    state.tickets.t1.status = "running";
    const runningSnap = buildRecentWorkSnapshot({ state, projects: undefined, conversationId: 1, enabled: true });
    expect(runningSnap.revision).toBe(queuedSnap.revision);
    expect(runningSnap.content).toBe(queuedSnap.content);

    state.tickets.t1.status = "waiting";
    state.tickets.t1.waiting = { reason: "user", since: 20, detail: "等待确认" };
    const waitingSnap = buildRecentWorkSnapshot({ state, projects: undefined, conversationId: 1, enabled: true });
    expect(waitingSnap.revision).not.toBe(runningSnap.revision);
    expect(waitingSnap.content).toContain("waiting");
  });
});

describe("#2 Five-guard echo suppression and Sorter bucket cap", () => {
  it("enforces min length >= 12, exact full hash, sender exclusion, 15s TTL, consumeOnce, and security exemption", () => {
    const echo = new AssistantEchoSuppressor();
    const t0 = 1_700_000_000_000;

    // 1. Short messages (< 12 chars) are never registered or suppressed ("好的"/"收到"/"OK").
    expect(echo.recordOutgoing({ appId: "com.electron.lark", body: "好的，收到", now: t0 })).toBe(false);
    expect(echo.consumeIfEcho({ appId: "com.electron.lark", body: "好的，收到", now: t0 + 500 })).toBe(false);

    // 2. Exact full body >= 12 chars suppresses once and burns immediately (`consumeOnce`).
    const longReply = "好的，我下午三点准时把最终方案发到群里。";
    expect(echo.recordOutgoing({ appId: "com.electron.lark", body: longReply, now: t0 })).toBe(true);
    expect(echo.consumeIfEcho({ appId: "com.electron.lark", body: longReply, now: t0 + 1_000 })).toBe(true);
    expect(echo.consumeIfEcho({ appId: "com.electron.lark", body: longReply, now: t0 + 1_500 })).toBe(false);

    // 3. Sender exclusion on structured IM feeds (lark-cli) refuses suppression for another human sender.
    expect(echo.recordOutgoing({ appId: "lark:default", body: longReply, requireSenderMatch: true, now: t0 })).toBe(true);
    expect(
      echo.consumeIfEcho({ appId: "lark:default", driverId: "lark-cli", sender: "张三", body: longReply, now: t0 + 1_000 }),
    ).toBe(false);

    // 4. Expires strictly after 15s TTL.
    expect(echo.recordOutgoing({ appId: "com.electron.lark", body: "这是超过十二个字符的测试外发消息正文", now: t0 })).toBe(true);
    expect(echo.consumeIfEcho({ appId: "com.electron.lark", body: "这是超过十二个字符的测试外发消息正文", now: t0 + 15_001 })).toBe(false);

    // 5. Home Assistant and physical security alerts are permanently exempt.
    expect(echo.recordOutgoing({ appId: "home-assistant", body: "前门门锁状态已更新为正常闭合状态", now: t0 })).toBe(false);
    expect(echo.recordOutgoing({ appId: "com.electron.lark", body: "厨房烟雾报警器触发紧急告警通知！", now: t0 })).toBe(false);
  });

  it("caps Sorter prompt payload to 12 events per burst while preserving all eventIds and suppresses confirmed echoes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-sorter-cap-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = new AssistantLedger({ stateDir: dir });
    cleanups.push(() => ledger.close());
    const echo = new AssistantEchoSuppressor();
    const modelCalls: string[] = [];
    const notified: unknown[] = [];

    const sorter = new AssistantSorter({
      ledger,
      ambientModel: {
        completeZeroToolJson: async ({ userContent }: { userContent: string }) => {
          modelCalls.push(userContent);
          return JSON.stringify({
            digest: "下载任务持续更新中",
            category: "system",
            disposition: "archive",
            urgency: "low",
            situationKey: "app:dl",
            title: "下载进度",
          });
        },
      } as unknown as ConstructorParameters<typeof AssistantSorter>[0]["ambientModel"],
      redact: (t) => t,
      echoSuppressor: echo,
      onNotifyBrain: (p) => notified.push(p),
      coalesceWindowMs: 20,
      maxCoalesceMs: 60,
    });
    cleanups.push(() => sorter.close());

    // First: confirmed outgoing echo bypasses ambientModel completely.
    const replyBody = "已确认今天的会议改到明天上午十点举行。";
    echo.recordOutgoing({ appId: "com.electron.lark", body: replyBody });
    const echoIngest = await ledger.ingestBatch("local", {
      batchId: "b-echo",
      driverId: "macos-notifications",
      streamId: "s1",
      sourceEpoch: "e1",
      cursorAfter: "1",
      events: [{
        nativeEventId: "ev-echo",
        eventVersion: "1",
        appId: "com.electron.lark",
        appLabel: "飞书",
        title: "飞书",
        body: replyBody,
        occurredAt: Date.now(),
        fidelity: "notification",
      }],
    }, (t) => t);
    sorter.enqueue(echoIngest.inserted);
    await sorter.flushAll();
    expect(modelCalls).toHaveLength(0);
    expect(notified).toHaveLength(0);

    // Second: 20 burst events in one bucket cap prompt payload at MAX_SORTER_PROMPT_EVENTS + omission marker.
    const burst = await ledger.ingestBatch("local", {
      batchId: "b-burst",
      driverId: "macos-notifications",
      streamId: "s1",
      sourceEpoch: "e1",
      cursorAfter: "21",
      events: Array.from({ length: 20 }, (_, i) => ({
        nativeEventId: `ev-burst-${i}`,
        eventVersion: "1",
        appId: "com.example.downloader",
        appLabel: "下载器",
        threadHint: "job-1",
        title: "下载进度",
        body: `正在下载大文件进度第 ${i + 1} 阶段完成`,
        occurredAt: Date.now() + i * 10,
        fidelity: "notification" as const,
      })),
    }, (t) => t);
    sorter.enqueue(burst.inserted);
    await sorter.flushAll();
    expect(modelCalls).toHaveLength(1);
    const jsonMatch = modelCalls[0]!.match(/<untrusted_events>\n([\s\S]*?)\n<\/untrusted_events>/);
    const sentItems = JSON.parse(jsonMatch![1]!) as Array<Record<string, unknown>>;
    // 2 head + 1 omission marker + 10 tail = 13 array elements (12 real events)
    expect(sentItems).toHaveLength(MAX_SORTER_PROMPT_EVENTS + 1);
    expect(sentItems[2]).toMatchObject({ omittedEvents: 8 });
  });
});

describe("#3 External action dispatched / unknown anti-replay and startup recovery", () => {
  it("prevents concurrent double execution, supports safe preDispatch rollback, locks unknown outcomes, and recovers dispatched on startup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-l2-replay-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = new AssistantLedger({ stateDir: dir });
    cleanups.push(() => ledger.close());
    const models = createModels();
    const registry = createRegistry();
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    let execCount = 0;
    let releaseFirst: (() => void) | undefined;
    let nextResult: () => Promise<{ ok: boolean; preDispatch?: boolean; error?: string }> = () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve({ ok: true });
      });
    const broadcasts: Array<{ revision: number; items: unknown[] }> = [];

    const coordinator = new AssistantCoordinator({
      harness,
      ledger,
      ambientModel: {} as ConstructorParameters<typeof AssistantCoordinator>[0]["ambientModel"],
      agentName: () => "Kulo",
      envDisplayName: () => "Mac",
      isForegroundBusy: () => false,
      redact: (t) => t,
      createDetachedOrchestratorConversation: async () => harness.create(BACKGROUND_CONTEXT),
      onItemsChanged: (revision, items) => broadcasts.push({ revision, items }),
      onTopicsChanged: () => {},
      executePendingAction: async () => {
        execCount += 1;
        return nextResult();
      },
    });

    // 1. Concurrent double-tap with two distinct commandIds executes strictly ONCE.
    const card1 = await coordinator.proposeDecisionCard({
      situationKey: "mail:1",
      sourceApp: "com.readdle.SparkDesktop",
      sourceLabel: "Spark",
      title: "回复客户",
      summary: "已拟好草稿",
      pendingAction: {
        actionId: "act-1",
        kind: "spark_create_draft",
        label: "确认存草稿",
        targetLabel: "client@example.com",
        previewText: "您好，方案已更新。",
        driverId: "spark-mail",
        operation: "create_draft",
        params: { body: "您好，方案已更新。" },
      },
    });
    const p1 = coordinator.performItemAction({
      itemId: card1.id,
      expectedRevision: card1.revision,
      action: "confirm_action",
      intent: clientDeliveryIntent({
        type: "assistant.item_action",
        itemId: card1.id,
        expectedRevision: card1.revision,
        action: "confirm_action",
        commandId: "cmd-a",
      }),
    });
    // Wait until first call reaches in-flight execution and broadcasts dispatched state.
    await vi.waitFor(() => expect(execCount).toBe(1));
    await expect(
      coordinator.performItemAction({
        itemId: card1.id,
        expectedRevision: card1.revision,
        action: "confirm_action",
        intent: clientDeliveryIntent({
          type: "assistant.item_action",
          itemId: card1.id,
          expectedRevision: card1.revision,
          action: "confirm_action",
          commandId: "cmd-b",
        }),
      }),
    ).rejects.toMatchObject({ status: 409 });
    releaseFirst!();
    await p1;
    expect(execCount).toBe(1);

    // 2. preDispatch failure rolls back cleanly, resets receipt, bumps revision, and allows retry.
    const card2 = await coordinator.proposeDecisionCard({
      situationKey: "mail:2",
      sourceApp: "com.readdle.SparkDesktop",
      sourceLabel: "Spark",
      title: "离线重试测试",
      summary: "测试预发失败回退",
      pendingAction: {
        actionId: "act-2",
        kind: "spark_create_draft",
        label: "确认存草稿",
        targetLabel: "a@b.com",
        previewText: "草稿内容",
        driverId: "spark-mail",
        operation: "create_draft",
        params: { body: "草稿内容" },
      },
    });
    nextResult = async () => ({ ok: false, preDispatch: true, error: "Spark 离线未发出" });
    await expect(
      coordinator.performItemAction({
        itemId: card2.id,
        expectedRevision: card2.revision,
        action: "confirm_action",
        intent: clientDeliveryIntent({
          type: "assistant.item_action",
          itemId: card2.id,
          expectedRevision: card2.revision,
          action: "confirm_action",
          commandId: "cmd-pre-1",
        }),
      }),
    ).rejects.toMatchObject({ code: "assistant_action_failed" });
    const listItems = async () => (await harness.snapshot(AssistantDoc, BACKGROUND_CONTEXT))?.items ?? [];

    const afterRollback = (await listItems()).find((i) => i.id === card2.id)!;
    expect(afterRollback.pendingAction?.executionState).toBe("none");
    expect(afterRollback.revision).toBeGreaterThan(card2.revision);
    expect(afterRollback.pendingAction?.lastError).toContain("Spark 离线未发出");

    // Retrying with the refreshed revision succeeds.
    nextResult = async () => ({ ok: true });
    await coordinator.performItemAction({
      itemId: afterRollback.id,
      expectedRevision: afterRollback.revision,
      action: "confirm_action",
      intent: clientDeliveryIntent({
        type: "assistant.item_action",
        itemId: afterRollback.id,
        expectedRevision: afterRollback.revision,
        action: "confirm_action",
        commandId: "cmd-pre-2",
      }),
    });
    expect((await listItems()).find((i) => i.id === card2.id)).toBeUndefined();

    // 3. Post-dispatch failure / timeout locks card into `unknown` and forbids any second `confirm_action`.
    const card3 = await coordinator.proposeDecisionCard({
      situationKey: "lark:3",
      sourceApp: "lark:default",
      sourceLabel: "飞书",
      title: "飞书回复超时测试",
      summary: "测试未知结果防重放",
      pendingAction: {
        actionId: "act-3",
        kind: "lark_send_reply",
        label: "确认发送",
        targetLabel: "oc_123",
        previewText: "已收到",
        driverId: "lark-cli",
        operation: "send_reply",
        params: { chatId: "oc_123", text: "已收到" },
      },
    });
    nextResult = async () => ({ ok: false, preDispatch: false, error: "socket timeout" });
    await expect(
      coordinator.performItemAction({
        itemId: card3.id,
        expectedRevision: card3.revision,
        action: "confirm_action",
        intent: clientDeliveryIntent({
          type: "assistant.item_action",
          itemId: card3.id,
          expectedRevision: card3.revision,
          action: "confirm_action",
          commandId: "cmd-unk-1",
        }),
      }),
    ).rejects.toMatchObject({ code: "assistant_action_unknown" });
    const unknownItem = (await listItems()).find((i) => i.id === card3.id)!;
    expect(unknownItem.pendingAction?.executionState).toBe("unknown");
    await expect(
      coordinator.performItemAction({
        itemId: unknownItem.id,
        expectedRevision: unknownItem.revision,
        action: "confirm_action",
        intent: clientDeliveryIntent({
          type: "assistant.item_action",
          itemId: unknownItem.id,
          expectedRevision: unknownItem.revision,
          action: "confirm_action",
          commandId: "cmd-unk-2",
        }),
      }),
    ).rejects.toMatchObject({ code: "action_outcome_unknown", status: 409 });

    // User can cleanly dismiss after verifying in the target app.
    await coordinator.performItemAction({
      itemId: unknownItem.id,
      expectedRevision: unknownItem.revision,
      action: "acknowledge",
    });
    expect((await listItems()).find((i) => i.id === card3.id)).toBeUndefined();

    // 4. Startup recovery downgrades lingering `dispatched` card to `unknown`.
    const card4 = await coordinator.proposeDecisionCard({
      situationKey: "ha:4",
      sourceApp: "home-assistant",
      sourceLabel: "Home Assistant",
      title: "重启未决测试",
      summary: "模拟崩溃前已发出",
      pendingAction: {
        actionId: "act-4",
        kind: "ha_call_service",
        label: "确认执行",
        targetLabel: "light.desk",
        previewText: "关闭书桌灯",
        driverId: "home-assistant",
        operation: "call_service",
        params: { domain: "light", service: "turn_off", entityId: "light.desk" },
        executionState: "dispatched",
        dispatchedAt: Date.now() - 5_000,
      },
    });
    expect(await coordinator.reconcileDispatchedActions()).toBe(1);
    const recoveredCard4 = (await listItems()).find((i) => i.id === card4.id)!;
    expect(recoveredCard4.pendingAction?.executionState).toBe("unknown");
  });

  it("classifies Home Assistant preDispatch vs unknown errors strictly and reconciles ActionConfirmationsDoc on startup", async () => {
    expect(isHomeAssistantPreDispatchError(Object.assign(new Error("blocked"), { code: "ha_physical_security_blocked" }))).toBe(true);
    expect(isHomeAssistantPreDispatchError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isHomeAssistantPreDispatchError(Object.assign(new Error("403"), { status: 403 }))).toBe(true);
    expect(isHomeAssistantPreDispatchError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isHomeAssistantPreDispatchError(Object.assign(new Error("502"), { status: 502 }))).toBe(false);
    expect(isHomeAssistantPreDispatchError(new Error("unexpected socket drop"))).toBe(false);

    const models = createModels();
    const registry = createRegistry();
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const uiCards = new KuloUiCards({ harness });
    const confirmations = new KuloActionConfirmations({ harness, uiCards });

    const created = await confirmations.createPendingOrchestratorRequest({
      conversationId: 1,
      kind: "host_action",
      fingerprint: "fp-host-1",
      payload: {
        kind: "host_action",
        envId: "local",
        envName: "Mac",
        summary: "重启服务",
        commands: ["echo hi"],
        ticketId: "t-wait",
      },
    });
    expect(effectiveConfirmationEffect(created)).toBe("none");
    expect(await confirmations.markDispatched(created.id)).toBe(true);
    // Second claim must fail cleanly.
    expect(await confirmations.markDispatched(created.id)).toBe(false);
    const recovered = await confirmations.reconcileDispatchedOnStartup();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe(created.id);
    expect(recovered[0]!.effect).toBe("unknown");
    expect(await confirmations.reconcileDispatchedOnStartup()).toHaveLength(0);
  });
});

describe("#6 Adaptive compaction clamping and post-commit tool pruning", () => {
  it("prevents 32K blocking loops and 64K thrashing, leaves 128K unchanged, and caps 200K/1M background triggers to 128K", () => {
    const c32k = clampCompactionConfigForWindow(DEFAULT_COMPACTION_CONFIG, 32_768);
    expect(c32k.reserveTokens).toBe(8_192);
    const blocking32 = 32_768 - c32k.reserveTokens;
    expect(c32k.keepRecentTokens).toBeLessThan(blocking32);
    expect(blocking32 - c32k.backgroundTokens).toBeGreaterThan(c32k.keepRecentTokens);

    const c64k = clampCompactionConfigForWindow(DEFAULT_COMPACTION_CONFIG, 65_536);
    const blocking64 = 65_536 - c64k.reserveTokens;
    expect(blocking64 - c64k.backgroundTokens).toBeGreaterThan(30_000);
    expect(blocking64 - c64k.backgroundTokens - c64k.keepRecentTokens).toBeGreaterThan(10_000);

    expect(clampCompactionConfigForWindow(DEFAULT_COMPACTION_CONFIG, 128_000)).toEqual(DEFAULT_COMPACTION_CONFIG);

    const c200k = clampCompactionConfigForWindow(DEFAULT_COMPACTION_CONFIG, 200_000);
    expect(c200k.reserveTokens).toBe(DEFAULT_COMPACTION_CONFIG.reserveTokens);
    expect(c200k.keepRecentTokens).toBe(DEFAULT_COMPACTION_CONFIG.keepRecentTokens);
    expect(200_000 - c200k.reserveTokens - c200k.backgroundTokens).toBe(128_000);

    const c1m = clampCompactionConfigForWindow(DEFAULT_COMPACTION_CONFIG, 1_048_576);
    expect(c1m.reserveTokens).toBe(DEFAULT_COMPACTION_CONFIG.reserveTokens);
    expect(c1m.keepRecentTokens).toBe(32_000);
    expect(1_048_576 - c1m.reserveTokens - c1m.backgroundTokens).toBe(160_000);

    // Explicit backgroundTokens=0 opt-out and earlier user-configured triggers remain honored.
    expect(clampCompactionConfigForWindow({ ...DEFAULT_COMPACTION_CONFIG, backgroundTokens: 0 }, 1_048_576).backgroundTokens).toBe(0);
    const c200kEarlier = clampCompactionConfigForWindow({ ...DEFAULT_COMPACTION_CONFIG, backgroundTokens: 70_000 }, 200_000);
    expect(c200kEarlier.backgroundTokens).toBe(70_000);

    const policy = buildAdaptiveCompactionPolicy(DEFAULT_COMPACTION_CONFIG, [
      { provider: "local", id: "qwen-32k", contextWindow: 32_768 },
      { provider: "local", id: "qwen-128k", contextWindow: 128_000 },
      { provider: "anthropic", id: "claude-200k", contextWindow: 200_000 },
      { provider: "google-vertex", id: "gemini-1m", contextWindow: 1_048_576 },
    ]);
    expect(policy.modelOverrides?.["local/qwen-32k"]).toEqual(c32k);
    expect(policy.modelOverrides?.["local/qwen-128k"]).toBeUndefined();
    expect(policy.modelOverrides?.["anthropic/claude-200k"]).toEqual(c200k);
    expect(policy.modelOverrides?.["google-vertex/gemini-1m"]).toEqual(c1m);
  });

  it("never prunes deferred tools inside beforeCompact and only prunes once after compaction commits when idle", async () => {
    let harness!: Harness;
    const prunedCalls: Array<{ conversationId: number; baselineEntryId: number }> = [];
    const provider = fauxProvider({ provider: "compact-race", models: [{ id: "m1", contextWindow: 2048, maxTokens: 512 }] });
    provider.setResponses(Array.from({ length: 40 }, () => () => fauxAssistantMessage([fauxText("摘要保留关键路径 packages/hub/src/hub.ts。")])));
    const models = createModels();
    models.setProvider(provider.provider);

    const controller = createContextCompactionController({
      getHarness: () => harness,
      getKernel: async () => ({ version: "0.0.101", kernel: validateBillionKernel(kernel) }),
      getReserveTokens: () => 512,
      maxSourceChars: 512,
      onCompactionBaseline: async (conversationId, baselineEntryId) => {
        prunedCalls.push({ conversationId: Number(conversationId), baselineEntryId });
      },
    });
    const registry = createRegistry();
    registry.install(controller.extension);
    harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: {
          retry: { enabled: false, maxRetries: 1, baseDelayMs: 1 },
          compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 512, backgroundTokens: 0 },
        },
      },
      BACKGROUND_CONTEXT,
    );
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "compact-race", modelId: "m1" }, thinkingLevel: "off", extensions: [controller.extension] },
    });

    await conversation.commit(async (tx) => {
      for (let i = 0; i < 8; i += 1) {
        await tx.appendEntry(UserEntry, conversation.id, {
          model: [{ role: "user", content: `历史段 ${i} ${"记录".repeat(120)}`, timestamp: i }],
        });
      }
    }, BACKGROUND_CONTEXT);

    // Run compaction: beforeCompact must NOT call onCompactionBaseline prematurely.
    const taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    const done = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    expect(done.state.outcome.status).toBe("completed");
    if (done.state.outcome.status === "completed" && done.state.outcome.result.submissionId !== undefined) {
      const sub = await harness.submission(done.state.outcome.result.submissionId, BACKGROUND_CONTEXT);
      await sub?.wait(BACKGROUND_CONTEXT);
    }
    expect(prunedCalls).toHaveLength(0);

    // Simulate an active foreground run in LiveDoc: idle-gated prune must refuse.
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      live.run = { id: "run-active" } as unknown as typeof live.run;
    }, BACKGROUND_CONTEXT);
    expect(await controller.pruneCommittedBaseline(conversation.id, BACKGROUND_CONTEXT, false)).toBe(false);
    expect(prunedCalls).toHaveLength(0);

    // Clear active run: post-commit prune executes exactly once and is idempotent afterwards.
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      live.run = undefined;
    }, BACKGROUND_CONTEXT);
    expect(await controller.pruneCommittedBaseline(conversation.id, BACKGROUND_CONTEXT, false)).toBe(true);
    expect(prunedCalls).toHaveLength(1);
    expect(await controller.pruneCommittedBaseline(conversation.id, BACKGROUND_CONTEXT, false)).toBe(false);
    expect(prunedCalls).toHaveLength(1);
  });
});

describe("#7 Excerpt reply validation and restart attachment fingerprint preservation", () => {
  it("accepts optional boolean excerpt and preserves it across Hub restart without attachment 403", async () => {
    expect(() => assertValidReplyReference({ messageId: 1, role: "assistant", text: "片段", excerpt: true })).not.toThrow();
    expect(() => assertValidReplyReference({ messageId: 1, role: "assistant", text: "整条" })).not.toThrow();
    expect(() => assertValidReplyReference({ messageId: 1, role: "assistant", text: "非法", excerpt: "yes" })).toThrow();

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-excerpt-restart-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const makeModels = () => {
      const provider = fauxProvider({ provider: "excerpt-test", models: [{ id: "m1" }] });
      provider.setResponses([
        () => fauxAssistantMessage([fauxText("首轮回复内容")]),
        () => fauxAssistantMessage([fauxText("已收到片段引用和附件")]),
      ]);
      const models = createModels();
      models.setProvider(provider.provider);
      return models;
    };

    const hub1 = await openTestHub({
      models: makeModels(),
      providerId: "excerpt-test",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "excerpt-test", defaultModel: "m1", thinkingLevel: "off" },
      },
    });
    const first = await hub1.sendUserMessage("首轮提问");
    await first.wait(BACKGROUND_CONTEXT);

    const uploaded = hub1.uploads.saveUpload({
      name: "note.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello excerpt attachment"),
      ownerId: "user-1",
    });
    const replyTo = { messageId: 1, role: "assistant" as const, text: "首轮回复", excerpt: true };
    const intent = clientDeliveryIntent(
      {
        type: "chat.send",
        topicId: "root",
        content: "追问这个片段",
        attachments: [uploaded],
        replyTo,
        requestId: "req-excerpt-1",
      },
      "user-1",
    );
    const second = await hub1.sendUserMessage("追问这个片段", {
      topicId: "root",
      principalId: "user-1",
      requestId: "req-excerpt-1",
      attachments: [uploaded],
      replyTo,
      deliveryIntent: intent,
    });
    await second.wait(BACKGROUND_CONTEXT);
    await hub1.close();

    // Reopen Hub on the same SQLite state: stored replyTo must retain `excerpt: true` and keep chat-scoped attachment grant readable.
    const hub2 = await openTestHub({
      models: makeModels(),
      providerId: "excerpt-test",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "excerpt-test", defaultModel: "m1", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub2.close());
    const { messages } = await hub2.getTopicView("root");
    const quotedMsg = messages.find((m) => m.role === "user" && m.text.includes("追问这个片段"));
    expect(quotedMsg?.replyTo).toEqual(replyTo);
    expect(hub2.uploads.canReadUpload(uploaded.id, "user-1")).toBe(true);
    expect(hub2.uploads.canReadUpload(uploaded.id, "user-2")).toBe(true);
  });
});
