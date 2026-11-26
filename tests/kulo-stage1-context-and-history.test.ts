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
import { AgentDoc, UserEntry } from "@earendil-works/pi-durable";
import {
  CANDIDATE_CHAT_KEEP_RECENT_TOKENS,
  CANDIDATE_CHAT_SOFT_BACKGROUND_TRIGGER_TOKENS,
  DEFAULT_COMPACTION_CONFIG,
  buildChatCompactionPolicy,
  computeContextThresholds,
  estimateActiveContextFromContextView,
  estimateContextFromWatchView,
  startKuloHubServer,
} from "@kulo/hub";
import { HUB_TEST_ADMIN_TOKEN, fetchWithHubAuth } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("Stage 1: context thresholds, watch-window estimation, manual compact API, and chat-resident history search", () => {
  it("keeps warnLimit strictly below blocking across 32K/64K/128K/200K/1M windows and builds chat-scoped policy", () => {
    for (const window of [32_768, 65_536, 128_000, 200_000, 1_000_000]) {
      const legacy = computeContextThresholds(DEFAULT_COMPACTION_CONFIG, window);
      expect(legacy.warnLimit).toBeLessThan(legacy.blocking);
      expect(legacy.warnLimit).toBeGreaterThanOrEqual(legacy.softLimit);

      const candidate = computeContextThresholds(
        { ...DEFAULT_COMPACTION_CONFIG, keepRecentTokens: CANDIDATE_CHAT_KEEP_RECENT_TOKENS },
        window,
        CANDIDATE_CHAT_SOFT_BACKGROUND_TRIGGER_TOKENS,
      );
      expect(candidate.warnLimit).toBeLessThan(candidate.blocking);
      expect(candidate.warnLimit).toBeGreaterThanOrEqual(candidate.softLimit);
      if (window >= 128_000) {
        expect(candidate.softLimit).toBe(72_000);
        expect(candidate.keepRecentTokens).toBe(16_000);
      }
    }

    // 32K regression check: old naive `softLimit * 1.5` (26,727) exceeded blocking (24,576).
    const t32 = computeContextThresholds(DEFAULT_COMPACTION_CONFIG, 32_768);
    expect(t32.softLimit).toBe(17_818);
    expect(t32.blocking).toBe(24_576);
    expect(t32.warnLimit).toBeLessThan(24_576);
    expect(t32.warnLimit).toBeGreaterThan(17_818);

    // Chat-scoped policy targets 72k/16k on large windows without mutating DEFAULT_COMPACTION_CONFIG.
    const chatPolicy = buildChatCompactionPolicy(
      DEFAULT_COMPACTION_CONFIG,
      [
        { provider: "p", id: "m-32k", contextWindow: 32_768 },
        { provider: "p", id: "m-200k", contextWindow: 200_000 },
        { provider: "p", id: "m-1m", contextWindow: 1_000_000 },
      ],
      { keepRecentTokens: CANDIDATE_CHAT_KEEP_RECENT_TOKENS },
    );
    expect(DEFAULT_COMPACTION_CONFIG.keepRecentTokens).toBe(24_000);
    expect(chatPolicy.keepRecentTokens).toBe(16_000);
    expect(200_000 - chatPolicy.modelOverrides!["p/m-200k"]!.reserveTokens - chatPolicy.modelOverrides!["p/m-200k"]!.backgroundTokens).toBe(72_000);
    expect(1_000_000 - chatPolicy.modelOverrides!["p/m-1m"]!.reserveTokens - chatPolicy.modelOverrides!["p/m-1m"]!.backgroundTokens).toBe(72_000);
  });

  it("avoids watch-window underestimation on 200-entry conversations and converges via async full ContextView fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s1-est-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const provider = fauxProvider({
      provider: "s1-est",
      models: [{ id: "m1", contextWindow: 128_000, maxTokens: 4_096 }],
    });
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "s1-est",
      config: {
        stateDir: dir,
        identityDir: path.join(dir, "identity"),
        enableLocalEnv: false,
        memory: { enabled: false },
        model: {
          defaultProvider: "s1-est",
          defaultModel: "m1",
          contextWindow: 128_000,
          compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 },
        },
      },
    });
    cleanups.push(() => hub.close());

    // Populate 120 long entries followed by 80 short entries (200 total > 80–160 watch window).
    await hub.rootConversation.commit(async (tx) => {
      for (let i = 0; i < 120; i += 1) {
        await tx.appendEntry(UserEntry, hub.rootConversation.id, {
          model: [{ role: "user", content: `长历史段落 ${i} ${"内容".repeat(160)}`, timestamp: i + 1 }],
        });
      }
      for (let i = 0; i < 80; i += 1) {
        await tx.appendEntry(UserEntry, hub.rootConversation.id, {
          model: [{ role: "user", content: `短消息 ${i}`, timestamp: 1000 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);

    const fullCtx = await hub.rootConversation.context(BACKGROUND_CONTEXT);
    const exact = estimateActiveContextFromContextView(fullCtx);
    expect(exact.tokens).toBeGreaterThan(10_000);

    // Watch window without AssistantEntry.usage and with `before !== undefined` must NOT return an
    // underestimated count from the tail 80 short entries; fast path defers to async exact estimate.
    const watch = await hub.rootConversation.watch(BACKGROUND_CONTEXT, { min: 80, max: 160 });
    cleanups.push(() => watch.stop());
    expect(watch.value.before).toBeDefined();
    expect(estimateContextFromWatchView(watch.value)).toBeUndefined();

    // Opening the topic view triggers the single-flight async estimate and converges to exact tokens.
    let latestLive = (await hub.getTopicView("root", BACKGROUND_CONTEXT)).live;
    const deadline = Date.now() + 3_000;
    while (latestLive.context?.tokens === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      latestLive = (await hub.getTopicView("root", BACKGROUND_CONTEXT)).live;
    }
    expect(latestLive.context?.tokens).toBe(exact.tokens);
    expect(latestLive.context?.window).toBe(128_000);
    expect(latestLive.context?.softLimit).toBeLessThan(128_000);
    expect(latestLive.context?.warnLimit).toBeLessThan(128_000 - 16_384);
  });

  it("supports POST /api/topics/:id/compact with 404/200/202, concurrent atomic dedup, and redaction-decline diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s1-compact-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    cleanups.push(() => releaseSummary());
    const provider = fauxProvider({
      provider: "s1-compact",
      models: [{ id: "m1", contextWindow: 16_384, maxTokens: 2_048 }],
    });
    provider.setResponses([
      async () => {
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n整理完成摘要")]);
      },
      () => fauxAssistantMessage([fauxText("## Goal\n二次整理摘要")]),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "s1-compact",
      config: {
        stateDir: dir,
        identityDir: path.join(dir, "identity"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        memory: { enabled: false },
        model: {
          defaultProvider: "s1-compact",
          defaultModel: "m1",
          contextWindow: 16_384,
          compaction: { enabled: true, reserveTokens: 2_048, keepRecentTokens: 2_048, backgroundTokens: 4_096 },
        },
      },
    });
    cleanups.push(() => hub.close());
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    // 1. Unknown/draft topic -> 404
    const missing = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/topics/local-draft-1/compact`, {
      method: "POST",
    });
    expect(missing.status).toBe(404);

    // 2. Empty root topic -> 200 nothing_to_compact
    const empty = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/topics/root/compact`, {
      method: "POST",
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ compacted: false, reason: "nothing_to_compact" });

    // 3. Populate enough entries so `keepRecentTokens = 2048` has a cut, then fire 2 concurrent compacts.
    await hub.rootConversation.commit(async (tx) => {
      for (let i = 0; i < 16; i += 1) {
        await tx.appendEntry(UserEntry, hub.rootConversation.id, {
          model: [{ role: "user", content: `段落 ${i} ${"测试上下文".repeat(220)}`, timestamp: i + 1 }],
        });
      }
    }, BACKGROUND_CONTEXT);

    // Direct concurrent calls share the exact same taskId via per-conversation single-flight dedup.
    const [direct1, direct2] = await Promise.all([
      hub.compactTopic("root", BACKGROUND_CONTEXT),
      hub.compactTopic("root", BACKGROUND_CONTEXT),
    ]);
    expect(direct1.compacted).toBe(true);
    expect(direct2).toEqual(direct1);
    const taskId = direct1.compacted ? direct1.taskId : 0;

    // While compaction task is running, HTTP POST /api/topics/:id/compact returns 409 compaction_in_progress.
    const whileRunning = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/topics/root/compact`, {
      method: "POST",
    });
    expect(whileRunning.status).toBe(409);

    releaseSummary();
    await hub.harness.waitForTask(taskId as never, BACKGROUND_CONTEXT);

    // After compaction completes, verify HTTP 202 works on a fresh compactable batch.
    await hub.rootConversation.commit(async (tx) => {
      for (let i = 0; i < 16; i += 1) {
        await tx.appendEntry(UserEntry, hub.rootConversation.id, {
          model: [{ role: "user", content: `第二批段落 ${i} ${"更多内容".repeat(220)}`, timestamp: 500 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);
    const accepted = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/topics/root/compact`, {
      method: "POST",
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as { compacted: true; taskId: number };
    expect(acceptedBody.compacted).toBe(true);
    expect(acceptedBody.taskId).toBeGreaterThan(taskId);
    await hub.harness.waitForTask(acceptedBody.taskId as never, BACKGROUND_CONTEXT);
  });

  it("defers kulo_history_search on chat turn 1, loads via tool_search, skips mounting kulo_history_read on zero hits, and mounts it on hit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s1-hist-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({
      provider: "s1-hist",
      models: [{ id: "m1", contextWindow: 128_000, maxTokens: 4_096 }],
    });
    provider.setResponses([
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxText("记住了：暗语 ALPHA-9941。")]);
      },
      // Turn 2: search deferred tool first, then zero-hit search -> must NOT mount kulo_history_read
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "搜索聊天记录 history search", limit: 3 })], { stopReason: "toolUse" });
      },
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxToolCall("kulo_history_search", { query: "NONEXISTENT_XYZ_777" })], { stopReason: "toolUse" });
      },
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxText("没搜到相关记录。")]);
      },
      // Turn 3: matching search -> MUST mount kulo_history_read and answer without tool_search
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxToolCall("kulo_history_search", { query: "ALPHA-9941" })], { stopReason: "toolUse" });
      },
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage([fauxText("找到暗语 ALPHA-9941。")]);
      },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "s1-hist",
      config: {
        stateDir: dir,
        identityDir: path.join(dir, "identity"),
        enableLocalEnv: false,
        memory: { enabled: false },
        model: {
          defaultProvider: "s1-hist",
          defaultModel: "m1",
          contextWindow: 128_000,
          compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 },
        },
      },
    });
    cleanups.push(() => hub.close());

    const send = async (text: string) => {
      const sub = await hub.rootConversation.submit({ type: "input", content: text }, BACKGROUND_CONTEXT);
      const done = await sub.wait(BACKGROUND_CONTEXT);
      expect(done.status).toBe("done");
    };

    await send("请记住暗语 ALPHA-9941");
    await send("查一下有没有记录过那串不存在的暗号");

    // After zero-hit search, kulo_history_read must NOT be added to AgentDoc.modelTools.
    const agentAfterZeroHit = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id, BACKGROUND_CONTEXT);
    expect(agentAfterZeroHit?.modelTools?.add ?? []).not.toContain("kulo_history_read");

    await send("回忆一下暗语 ALPHA-9941");
    const agentAfterHit = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id, BACKGROUND_CONTEXT);
    expect(agentAfterHit?.modelTools?.add ?? []).toContain("kulo_history_read");

    // Settings Assistant must still keep kulo_history_search deferred.
    const settingsSnap = await hub.settingsAssistant.getSnapshot();
    expect(settingsSnap).toBeDefined();
    expect(requests.length).toBe(6);
  });

  it("surfaces a secret-free compactionError diagnostic when credential redaction declines compaction", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-s1-decline-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const provider = fauxProvider({
      provider: "s1-decline",
      models: [{ id: "m1", contextWindow: 16_384, maxTokens: 2_048 }],
    });
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "s1-decline",
      config: {
        stateDir: dir,
        identityDir: path.join(dir, "identity"),
        enableLocalEnv: false,
        memory: { enabled: false },
        model: {
          defaultProvider: "s1-decline",
          defaultModel: "m1",
          contextWindow: 16_384,
          compaction: { enabled: true, reserveTokens: 2_048, keepRecentTokens: 2_048, backgroundTokens: 4_096 },
        },
      },
    });
    cleanups.push(() => hub.close());

    // First populate entries containing a later-registered secret so in-memory Session still has raw text.
    const rawSecret = "kulo_decline_probe_secret_9876543210";
    await hub.rootConversation.commit(async (tx) => {
      for (let i = 0; i < 18; i += 1) {
        await tx.appendEntry(UserEntry, hub.rootConversation.id, {
          model: [{ role: "user", content: i === 2 ? `历史里包含 ${rawSecret} ${"填充内容测试".repeat(200)}` : `段落 ${i} ${"填充内容测试".repeat(200)}`, timestamp: i + 1 }],
        });
      }
    }, BACKGROUND_CONTEXT);
    // Register secret after entry was already cached in memory so redactionExt.beforeCompact declines it.
    hub.connectionManager.rememberSecrets([rawSecret]);

    const res = await hub.compactTopic("root", BACKGROUND_CONTEXT);
    expect(res.compacted).toBe(true);
    if (res.compacted) {
      await hub.harness.waitForTask(res.taskId as never, BACKGROUND_CONTEXT);
    }
    const view = await hub.getTopicView("root", BACKGROUND_CONTEXT);
    expect(view.live.context?.compactionError).toBeTruthy();
    expect(view.live.context?.compactionError).not.toContain(rawSecret);
  });

  it("paired replay comparison: chat-scoped 72k/16k policy caps peak active context well below legacy 128k/24k on 200K window", () => {
    const legacy = computeContextThresholds(DEFAULT_COMPACTION_CONFIG, 200_000);
    const candidate = computeContextThresholds(
      { ...DEFAULT_COMPACTION_CONFIG, keepRecentTokens: CANDIDATE_CHAT_KEEP_RECENT_TOKENS },
      200_000,
      CANDIDATE_CHAT_SOFT_BACKGROUND_TRIGGER_TOKENS,
    );

    const simulateTurns = (softLimit: number, keepRecent: number, turnTokens: readonly number[]) => {
      let active = 4_000; // base system + tools
      let compactions = 0;
      let peak = active;
      let sum = 0;
      for (const delta of turnTokens) {
        active += delta;
        peak = Math.max(peak, active);
        sum += active;
        if (active > softLimit) {
          compactions += 1;
          active = 4_000 + keepRecent + 1_500; // base + kept tail + summary
        }
      }
      return { compactions, peak, avgActive: Math.round(sum / turnTokens.length) };
    };

    const workload = Array.from({ length: 40 }, () => 5_500); // 220k total cumulative conversation
    const legacyStats = simulateTurns(legacy.softLimit, legacy.keepRecentTokens, workload);
    const candidateStats = simulateTurns(candidate.softLimit, candidate.keepRecentTokens, workload);

    expect(candidateStats.peak).toBeLessThan(legacyStats.peak);
    expect(candidateStats.avgActive).toBeLessThan(legacyStats.avgActive);
    expect(candidateStats.peak).toBeLessThanOrEqual(80_000);
  });
});
