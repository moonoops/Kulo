import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  Harness,
  ToolResultEntry,
  createRegistry,
  type ConversationId,
  type EntryRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  EXTERNAL_AGENT_MEMORY_MODE_CAPABILITY,
  EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY,
  type HindsightMemoryConfig,
  type TicketRecord,
} from "@kulo/protocol";
import {
  BuiltinMemoryDoc,
  BuiltinMemoryError,
  BuiltinMemoryService,
} from "../packages/hub/src/builtin-memory-service.js";
import {
  MemoryContextEntry,
  MemoryContextRevocationEntry,
} from "../packages/hub/src/builtin-memory-entries.js";
import {
  isChitchatRecallQuery,
  rankAndFoldAuthorizedCandidates,
} from "../packages/hub/src/builtin-memory-query.js";
import {
  BuiltinMemoryStore,
  BuiltinMemoryStoreError,
} from "../packages/hub/src/builtin-memory-store.js";
import {
  BUILTIN_MEMORY_FAILOVER_PAUSE_FILE,
  CLUSTER_BUILTIN_MEMORY_CAPABILITY,
  verifyReplicaBuiltinMemoryMeta,
  verifyStagedManifestBuiltinMemory,
} from "../packages/hub/src/cluster-sync-paths.js";
import { ClusterSyncService, readReplicaState } from "../packages/hub/src/cluster-sync.js";
import { historyEntryText } from "../packages/hub/src/conversation-history.js";
import {
  BUILTIN_MEMORY_REDACTION_PENDING_FILE,
  scrubBuiltinMemorySecrets,
} from "../packages/hub/src/credential-redaction.js";
import { extractDisplayMessages, extractLiveState, summarizeEntryForInspect } from "../packages/hub/src/hub-display-projection.js";
import { isProtectedAcpPath } from "../packages/env/src/external-agent-drivers.js";
import { collectAllConversationIds } from "../packages/hub/src/builtin-memory-doc.js";
import { handleBuiltinMemoryRoutes } from "../packages/hub/src/http/builtin-memory-routes.js";
import type { HubHttpRouteContext } from "../packages/hub/src/http/context.js";
import { executeMemoryForget } from "../packages/hub/src/memory-forget.js";
import {
  extractEntryTextAndRole,
  isCursorAhead,
} from "../packages/hub/src/memory-flush-extract.js";
import { buildExternalAgentRunRequest } from "../packages/hub/src/prompts/external-agent.js";
import { RecentWorkUpdateEntry } from "../packages/hub/src/recent-work-sync.js";
import { KuloStateDoc, ensureDefaultRootTopic } from "../packages/hub/src/state.js";
import { KuloUserEntry } from "../packages/hub/src/ui-cards.js";
import { voiceHistory } from "../packages/hub/src/voice-context.js";
import { KuloWorkingMemoryDoc, commitWorkingMemory } from "../packages/hub/src/working-memory.js";
import { KuloHub, startKuloHubServer } from "../packages/hub/src/index.js";

const tmpDirs: string[] = [];
function makeTmpDir(prefix = "kulo-builtin-mem-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function disabledHindsight(overrides: Partial<HindsightMemoryConfig> = {}): HindsightMemoryConfig {
  return {
    enabled: false,
    endpoint: "http://127.0.0.1:8888",
    endpoints: [],
    caCertPem: "",
    routerApiKeyEnv: "",
    workerApiKeyEnv: "",
    authFile: "",
    autoAttachTopLevelRouters: false,
    banks: { private: "kulo-core", shared: "kulo-shared" },
    ...overrides,
  };
}

describe("BuiltinMemoryStore & query engine", () => {
  it("enforces DDL & role isolation, folds duplicates post-authorization, handles empty FTS tokens, and preserves single-source deletes", async () => {
    const dir = makeTmpDir();
    const store = new BuiltinMemoryStore({ stateDir: dir });

    // Role / scope violations rejected
    await expect(
      store.retain({
        callerRole: "worker",
        bank: "private",
        scopeKind: "global",
        source: "tool",
        sourceId: "bad-1",
        evidenceLevel: "ticket_outcome",
        category: "fact",
        content: "Worker cannot write private bank",
      }),
    ).rejects.toBeInstanceOf(BuiltinMemoryStoreError);

    await expect(
      store.retain({
        callerRole: "router",
        bank: "shared",
        scopeKind: "project",
        projectId: "proj-a",
        source: "tool",
        sourceId: "bad-2",
        evidenceLevel: "user_decision",
        category: "fact",
        content: "Router cannot write shared bank",
      }),
    ).rejects.toBeInstanceOf(BuiltinMemoryStoreError);

    await expect(
      store.retain({
        callerRole: "worker",
        bank: "shared",
        scopeKind: "project",
        source: "tool",
        sourceId: "bad-3",
        evidenceLevel: "ticket_outcome",
        category: "fact",
        content: "Shared requires projectId",
      }),
    ).rejects.toBeInstanceOf(BuiltinMemoryStoreError);

    // Same content in two different projects must both persist with distinct source_ids
    const pA = await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "project",
      projectId: "proj-a",
      topicId: "topic-a",
      source: "tool",
      sourceId: "src-a",
      evidenceLevel: "user_decision",
      category: "decision",
      content: "Production gateway binds port 8787 on /etc/nginx/conf.d/app.conf",
    });
    const pB = await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "project",
      projectId: "proj-b",
      topicId: "topic-b",
      source: "tool",
      sourceId: "src-b",
      evidenceLevel: "user_decision",
      category: "decision",
      content: "Production gateway binds port 8787 on /etc/nginx/conf.d/app.conf",
    });
    expect(pA.id).not.toBe(pB.id);

    // Project B recall sees ONLY project B record (pre-filtered before dedup!)
    const hitsB = await store.recall("/etc/nginx/conf.d/app.conf", {
      callerRole: "router",
      bank: "private",
      projectId: "proj-b",
      topicId: "topic-b",
    });
    expect(hitsB).toHaveLength(1);
    expect(hitsB[0]!.id).toBe(pB.id);

    // Deleting topic-a retains topic-b's identical content
    const purgedA = await store.purgeScope({ topicId: "topic-a" });
    expect(purgedA.removedIds).toContain(pA.id);
    const hitsBAfter = await store.recall("port 8787", {
      callerRole: "router",
      bank: "private",
      projectId: "proj-b",
      topicId: "topic-b",
    });
    expect(hitsBAfter).toHaveLength(1);
    expect(hitsBAfter[0]!.id).toBe(pB.id);

    // Live topic move (`reassignTopicProject(topic-b, null)`) downgrades project scope to topic safely without CHECK failure
    await store.reassignTopicProject("topic-b", null);
    const hitsAfterMoveToStandalone = await store.recall("port 8787", {
      callerRole: "router",
      bank: "private",
      topicId: "topic-b",
    });
    expect(hitsAfterMoveToStandalone).toHaveLength(1);
    // Project B no longer sees moved topic's memory
    const hitsOldProjB = await store.recall("port 8787", {
      callerRole: "router",
      bank: "private",
      projectId: "proj-b",
      topicId: "topic-other",
    });
    expect(hitsOldProjB).toHaveLength(0);

    // Empty-token / symbol-only queries never throw FTS5 syntax errors
    const symHits = await store.recall("C++ ??? 🚀", {
      callerRole: "router",
      bank: "private",
      topicId: "topic-b",
    });
    expect(Array.isArray(symHits)).toBe(true);

    // Explicit supersedesId marks old record superseded; similar content without supersedesId does NOT auto-supersede
    const first = await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      source: "tool",
      sourceId: "pref-1",
      evidenceLevel: "user_decision",
      category: "decision",
      content: "默认使用 pnpm 运行前端构建",
    });
    const second = await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      source: "tool",
      sourceId: "pref-2",
      evidenceLevel: "user_decision",
      category: "decision",
      supersedesId: first.id,
      content: "默认使用 corepack pnpm 运行前端构建",
    });
    const prefHits = await store.recall("pnpm 前端构建", {
      callerRole: "router",
      bank: "private",
    });
    expect(prefHits.map((h) => h.id)).toEqual([second.id]);

    await store.close();
  });

  it("allows short Chinese questions, skips pure chitchat, and guarantees exact/BM25 #1 inside Top-4", () => {
    expect(isChitchatRecallQuery("端口多少")).toBe(false);
    expect(isChitchatRecallQuery("端口?")).toBe(false);
    expect(isChitchatRecallQuery("好的")).toBe(true);
    expect(isChitchatRecallQuery("ok")).toBe(true);
    expect(isChitchatRecallQuery("   ...  ")).toBe(true);

    const now = Date.now();
    // 5 vector-only candidates + 1 unembedded exact/BM25 #1 candidate
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `vec-${i}`,
        bank: "private" as const,
        scope_kind: "global" as const,
        project_id: null,
        topic_id: null,
        content: `Unrelated vectorized note ${i}`,
        content_hash: `h-vec-${i}`,
        category: "fact" as const,
        evidence_level: "user_decision" as const,
        durability: "permanent" as const,
        importance: 0.7,
        created_at: now,
        updated_at: now,
        embedding_model: "mock-e5",
      })),
      {
        id: "exact-1",
        bank: "private" as const,
        scope_kind: "global" as const,
        project_id: null,
        topic_id: null,
        content: "Gateway port is 8787 at /etc/kulo.conf",
        content_hash: "h-exact-1",
        category: "fact" as const,
        evidence_level: "user_decision" as const,
        durability: "permanent" as const,
        importance: 0.7,
        created_at: now,
        updated_at: now,
        embedding_model: null,
      },
    ];
    const vecRankMap = new Map<string, number>(Array.from({ length: 5 }, (_, i) => [`vec-${i}`, i + 1]));
    const ftsRankMap = new Map<string, number>([["exact-1", 1]]);
    const exactHitIds = new Set<string>(["exact-1"]);
    const effectiveProjectById = new Map<string, string | undefined>();
    const ranked = rankAndFoldAuthorizedCandidates({
      rows,
      ftsRankMap,
      vecRankMap,
      exactHitIds,
      effectiveProjectById,
      callerRole: "router",
      bank: "private",
      limit: 4,
      now,
    });
    expect(ranked).toHaveLength(4);
    expect(ranked.some((h) => h.id === "exact-1")).toBe(true);
  });
});

async function openHarness(dir: string) {
  const storage: Storage = await openNodeSqliteStorage(path.join(dir, "kulo.sqlite"));
  const requests: TranscriptContext[] = [];
  const provider = fauxProvider({ provider: "openai", models: [{ id: "mem-test-model" }] });
  provider.setResponses(Array.from({ length: 8 }, () => (ctx: TranscriptContext) => {
    requests.push(JSON.parse(JSON.stringify(ctx)) as TranscriptContext);
    return fauxAssistantMessage([fauxText("已收到。")]);
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  let serviceRef!: BuiltinMemoryService;
  const rawMem = disabledHindsight();
  const effMem = disabledHindsight();
  const service = new BuiltinMemoryService({
    stateDir: dir,
    getHarness: () => harness,
    getEffectiveMemoryConfig: () => effMem,
    getRawMemoryConfig: () => rawMem,
    redact: (t) => t,
  });
  serviceRef = service;
  const recallExt = service.createRecallExtension();
  const registry = createRegistry();
  registry.install(recallExt);
  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
  const rootConv = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "openai", modelId: "mem-test-model" }, extensions: [recallExt], thinkingLevel: "off" },
  });
  await harness.commit(async (tx) => {
    const state = await tx.doc(KuloStateDoc);
    ensureDefaultRootTopic(state);
  }, BACKGROUND_CONTEXT);
  return { harness, rootConv, requests, service: serviceRef, rawMem, effMem };
}

describe("BuiltinMemoryService: Pure-L2 clear, crash recovery, restorative revocation & failover scope", () => {

  it("executes Pure-L2 clear preserving L1 working memory, enforces operationId idempotency & 409 conflict, and recovers from mid-clear crash", async () => {
    const dir = makeTmpDir();
    const { harness, service } = await openHarness(dir);
    await service.start(BACKGROUND_CONTEXT);

    // Seed L1 Working Memory
    await commitWorkingMemory(harness, (t) => t, (doc) => {
      doc.buckets.global = [{
        id: "l1-keep-1",
        bucketId: "global",
        category: "commitment",
        evidenceLevel: "user_decision",
        status: "active",
        date: "2026-11-23",
        summary: "Keep this L1 commitment intact",
        fingerprint: "fp1",
        provenance: { conversationId: 1, entryId: 1, sourceRole: "user" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];
    }, BACKGROUND_CONTEXT);

    // Retain L2 built-in memory
    await service.retainFromTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      content: "User prefers dark theme and port 9123",
      callId: "call-1",
    }, BACKGROUND_CONTEXT);

    const beforeClear = await service.recallForTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      query: "port 9123",
    }, BACKGROUND_CONTEXT);
    expect(beforeClear).toHaveLength(1);

    // Stale expectedEpoch -> 409
    await expect(
      service.clearAll({ confirm: true, expectedEpoch: 99, operationId: "op-stale" }, BACKGROUND_CONTEXT),
    ).rejects.toMatchObject({ status: 409 });

    // Valid clear -> wipes L2, keeps L1 untouched!
    const cleared = await service.clearAll({ confirm: true, expectedEpoch: 0, operationId: "op-clear-1" }, BACKGROUND_CONTEXT);
    expect(cleared.clearTargetEpoch).toBe(1);
    expect(cleared.appliedClearEpoch).toBe(1);

    const wmAfterClear = await harness.snapshot(KuloWorkingMemoryDoc, BACKGROUND_CONTEXT);
    expect(wmAfterClear?.buckets.global).toHaveLength(1);
    expect(wmAfterClear?.buckets.global![0]!.summary).toContain("Keep this L1 commitment intact");

    const afterClear = await service.recallForTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      query: "port 9123",
    }, BACKGROUND_CONTEXT);
    expect(afterClear).toHaveLength(0);

    // Write new memory after clear, then replay the SAME operationId -> MUST NOT wipe the new memory!
    await service.retainFromTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      content: "Post-clear brand new port 9456",
      callId: "call-2",
    }, BACKGROUND_CONTEXT);
    const replayed = await service.clearAll({ confirm: true, expectedEpoch: 0, operationId: "op-clear-1" }, BACKGROUND_CONTEXT);
    expect(replayed.clearTargetEpoch).toBe(1);
    const postReplayHits = await service.recallForTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      query: "port 9456",
    }, BACKGROUND_CONTEXT);
    expect(postReplayHits).toHaveLength(1);

    // Simulate crash: bump clearTargetEpoch in kulo.sqlite ahead of memory.sqlite applied_clear_epoch
    await harness.commit(async (tx) => {
      const doc = await tx.doc(BuiltinMemoryDoc);
      doc.clearTargetEpoch = 2;
    }, BACKGROUND_CONTEXT);
    await service.close();
    await harness.close(BACKGROUND_CONTEXT);

    // Reopen -> startup crash-recovery barrier completes clearAll(2) and wipes residual post-clear row
    const reopened = await openHarness(dir);
    await reopened.service.start(BACKGROUND_CONTEXT);
    const recoveredState = await reopened.service.getStateView(BACKGROUND_CONTEXT);
    expect(recoveredState.clearTargetEpoch).toBe(2);
    expect(recoveredState.appliedClearEpoch).toBe(2);
    expect(recoveredState.blocked).toBeUndefined();
    const afterRecovery = await reopened.service.recallForTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      query: "port 9456",
    }, BACKGROUND_CONTEXT);
    expect(afterRecovery).toHaveLength(0);

    await reopened.service.close();
    await reopened.harness.close(BACKGROUND_CONTEXT);
  });

  it("restoratively revokes recalled MemoryContextEntry across conversation context and voiceHistory while preserving RecentWorkUpdate and UserMessage", async () => {
    const dir = makeTmpDir();
    const { harness, service } = await openHarness(dir);
    await service.start(BACKGROUND_CONTEXT);

    const retained = await service.retainFromTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      content: "Project internal codename is Aurora-42",
      callId: "call-rev-1",
    }, BACKGROUND_CONTEXT);

    const rootConv = (await harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT))!;
    // Simulate a real user entry wrapped with RecentWorkUpdate + MemoryContext via edits.replace
    const userMsg = { role: "user" as const, content: "帮我查一下代号", timestamp: 1000 };
    const syncMsg = { role: "user" as const, content: "[KULO_RECENT_WORK_UPDATE]\nActive task summary", timestamp: 1001 };
    const memMsg = {
      role: "user" as const,
      content: `[KULO_MEMORY_CONTEXT builtin-router:1:2]\nHistorical personal memory:\n- Project internal codename is Aurora-42`,
      timestamp: 1002,
    };
    let targetId = 0;
    await harness.commit(async (tx) => {
      const appended = await tx.appendEntry(KuloUserEntry, 1 as ConversationId, {
        data: { kuloContentVersion: 1, text: "帮我查一下代号", attachments: [] } as never,
        model: [userMsg],
      });
      const entryId = typeof appended === "object" && appended !== null && "id" in appended ? (appended as { id: number }).id : Number(appended);
      targetId = Number(entryId);
      await tx.appendEntry(RecentWorkUpdateEntry, 1 as ConversationId, {
        data: { kind: "recent_work", hash: "abc" } as never,
        edits: [{ target: entryId as never, action: "replace", messages: [syncMsg, userMsg] }],
      });
      await tx.appendEntry(MemoryContextEntry, 1 as ConversationId, {
        data: {
          sourceId: "builtin-router:1:2",
          text: memMsg.content,
          engine: "builtin",
          clearEpoch: 0,
          memoryIds: [retained.id],
          targetEntryId: targetId,
        } as never,
        edits: [{ target: entryId as never, action: "replace", messages: [syncMsg, memMsg, userMsg] }],
      });
    }, BACKGROUND_CONTEXT);

    // Before revocation: voiceHistory ALREADY filters out [KULO_MEMORY_CONTEXT ...] and [KULO_RECENT_WORK_UPDATE]
    const viewBefore = await rootConv.context(BACKGROUND_CONTEXT);
    const voiceBefore = voiceHistory(viewBefore, (t) => t);
    expect(voiceBefore).toEqual([{ role: "user", text: "帮我查一下代号" }]);
    expect(JSON.stringify(viewBefore.contributions)).toContain("Aurora-42");

    // Forget term -> revokes the recall in active conversation window!
    const forgetRes = await service.forgetPrivateTerm("Aurora-42", BACKGROUND_CONTEXT);
    expect(forgetRes.removedRecords).toBe(1);

    const viewAfter = await rootConv.context(BACKGROUND_CONTEXT);
    const targetIdx = viewAfter.entries.findIndex((e) => Number(e.id) === targetId);
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    const restoredMsgs = viewAfter.contributions[targetIdx]!;
    // Both RecentWorkUpdate and UserMessage preserved; MemoryContext completely gone!
    expect(restoredMsgs.map((m) => m.content)).toEqual([syncMsg.content, userMsg.content]);
    expect(restoredMsgs.some((m) => String(m.content).includes("Aurora-42"))).toBe(false);

    // Display projection hides MemoryContextRevocationEntry AND redacts kulo_memory_recall/retain tool args & results
    const fakeToolEntries: EntryRecord[] = [
      ...viewAfter.entries,
      {
        id: 900 as never,
        kind: AssistantEntry.kind,
        data: {},
        model: [{
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "kulo_memory_recall", arguments: { query: "Aurora-42" } }],
          stopReason: "toolUse",
          timestamp: 2000,
        }],
      } as unknown as EntryRecord,
      {
        id: 901 as never,
        kind: ToolResultEntry.kind,
        data: {},
        model: [{
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "kulo_memory_recall",
          isError: false,
          content: [{ type: "text", text: "TOP SECRET MEMORY CONTENT Aurora-42" }],
          timestamp: 2001,
        }],
      } as unknown as EntryRecord,
    ];
    const display = extractDisplayMessages(fakeToolEntries, { includeToolResults: true });
    const toolDisplay = display.find((item) => item.toolCalls?.length);
    expect(toolDisplay?.toolCalls?.[0]?.name).toBe("kulo_memory_recall");
    expect(toolDisplay?.toolCalls?.[0]?.argsSummary).toBe("");
    expect(toolDisplay?.toolCalls?.[0]?.actionSummary).toBeUndefined();
    expect(toolDisplay?.toolCalls?.[0]?.result?.text).toBe("ok");
    expect(JSON.stringify(display)).not.toContain("TOP SECRET MEMORY CONTENT");

    // History index and memory flush both skip memory tool results
    expect(historyEntryText(fakeToolEntries.at(-1)!)).toBeUndefined();
    expect(extractEntryTextAndRole(fakeToolEntries.at(-1)!, (t) => t)).toBeUndefined();

    await service.close();
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("locks shared built-in memory when Hindsight private-only degrades on failover, and protects cursor monotonicity", async () => {
    const dir = makeTmpDir();
    const { harness, service, rawMem, effMem } = await openHarness(dir);
    await service.start(BACKGROUND_CONTEXT);

    // Simulate Hindsight enabled with private-only in persisted settings, degraded to disabled locally after failover
    rawMem.enabled = true;
    rawMem.accessMode = "private-only";
    effMem.enabled = false;

    expect(service.isEffectiveActive()).toBe(true);
    expect(service.isSharedEffectiveActive()).toBe(false);
    expect(service.getExternalMemoryMode()).toBe("none");

    // Monotonic chunked cursor comparison never regresses
    expect(isCursorAhead(10, 1000, 10, 500)).toBe(true);
    expect(isCursorAhead(10, 0, 10, 1000)).toBe(true);
    expect(isCursorAhead(11, 500, 10, 0)).toBe(true);
    expect(isCursorAhead(10, 500, 10, 0)).toBe(false);
    expect(isCursorAhead(9, 500, 10, 0)).toBe(false);

    await service.close();
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("injects router auto-recall via edits.replace preserving monotonic Prompt Prefix Cache across turns", async () => {
    const dir = makeTmpDir();
    const { harness, rootConv, requests, service } = await openHarness(dir);
    await service.start(BACKGROUND_CONTEXT);

    await service.retainFromTool({
      caller: { role: "router", conversationId: "1" },
      bank: "private",
      content: "部署端口是 8787，Nginx 配置在 /etc/nginx/conf.d/app.conf",
      callId: "call-cache-1",
    }, BACKGROUND_CONTEXT);

    await rootConv.submit({ type: "input", content: "端口多少" }, BACKGROUND_CONTEXT);
    await rootConv.waitForIdle(BACKGROUND_CONTEXT);
    expect(requests).toHaveLength(1);
    const turn1Msgs = requests[0]!.messages;
    expect(turn1Msgs.some((m) => typeof m.content === "string" && m.content.includes("8787") && m.content.includes("[KULO_MEMORY_CONTEXT"))).toBe(true);

    // Turn 2: chitchat does not re-inject; exact turn-1 message prefix stays byte-identical!
    await rootConv.submit({ type: "input", content: "好的" }, BACKGROUND_CONTEXT);
    await rootConv.waitForIdle(BACKGROUND_CONTEXT);
    expect(requests).toHaveLength(2);
    const turn2Msgs = requests[1]!.messages;
    expect(turn2Msgs.slice(0, turn1Msgs.length)).toEqual(turn1Msgs);

    // Clear wipes the recalled memory from subsequent turn context via restorative revocation!
    await service.clearAll({ confirm: true, expectedEpoch: 0, operationId: "op-cache-clear" }, BACKGROUND_CONTEXT);
    await rootConv.submit({ type: "input", content: "继续说说" }, BACKGROUND_CONTEXT);
    await rootConv.waitForIdle(BACKGROUND_CONTEXT);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.messages)).not.toContain("8787");

    await service.close();
    await harness.close(BACKGROUND_CONTEXT);
  });
});

describe("External ACP compatibility, forget orchestration, startup secret scrub & cluster failover", () => {
  it("omits memoryMode and disables memoryEnabled for old Env nodes lacking external-memory-mode-v1", () => {
    const ticket = {
      id: "ticket-ext-1",
      title: "Fix bug",
      goal: "Fix bug",
      scope: "src/",
      projectId: "proj-1",
      envId: "env-old",
      workspaceDir: "/tmp/repo",
      role: "developer",
      status: "running",
      runEpoch: 1,
      workerConversationId: 10,
      originConversationId: 1,
      externalExecution: {
        binding: { kind: "codex", envId: "env-old" },
        workspaceMode: "staged",
      },
    } as unknown as TicketRecord;

    const oldEnvReq = buildExternalAgentRunRequest({
      ticket,
      runEpoch: 1,
      runId: "run-1",
      isResumingNativeSession: false,
      materialized: [],
      hasConnections: false,
      memoryEnabled: true,
      memoryMode: "builtin",
      envCapabilities: [EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY],
    });
    expect("memoryMode" in oldEnvReq).toBe(false);
    expect(oldEnvReq.memoryEnabled).toBeUndefined();

    const newEnvReq = buildExternalAgentRunRequest({
      ticket,
      runEpoch: 1,
      runId: "run-2",
      isResumingNativeSession: false,
      materialized: [],
      hasConnections: false,
      memoryEnabled: true,
      memoryMode: "builtin",
      envCapabilities: [EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY, EXTERNAL_AGENT_MEMORY_MODE_CAPABILITY],
    });
    expect(newEnvReq.memoryEnabled).toBe(true);
    expect(newEnvReq.memoryMode).toBe("builtin");
    expect(newEnvReq.developerInstructions).toContain("kulo_memory_recall");
    expect(newEnvReq.developerInstructions).toContain("kulo_memory_ingest");
    expect(newEnvReq.developerInstructions).not.toContain("kulo_memory_search_pages");
    expect(newEnvReq.developerInstructions).not.toContain("kulo_memory_reflect");
  });

  it("cleans built-in private memory on kulo_memory_forget even when Hindsight is disabled, and scrubs secrets physically", async () => {
    const dir = makeTmpDir();
    const store = new BuiltinMemoryStore({ stateDir: dir });
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      source: "tool",
      sourceId: "priv-forget",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "User birthday is May 19",
    });
    await store.retain({
      callerRole: "worker",
      bank: "shared",
      scopeKind: "project",
      projectId: "proj-1",
      source: "worklog",
      sourceId: "shared-keep",
      evidenceLevel: "ticket_outcome",
      category: "worklog",
      content: "Release May 19 milestone passed tests",
    });

    const outcome = await executeMemoryForget({
      term: "May 19",
      caller: { role: "router", conversationId: "1" },
      host: {
        addForgottenTerm: async (term) => ({ added: true, entry: { term, normalized: term.toLowerCase(), addedAt: Date.now() }, total: 1 }),
        forgetFromRelationship: async () => ({ removedLines: 0 }),
        forgetFromBuiltinMemory: async (term) => {
          const r = await store.forgetPrivateTerm(term);
          return { removedRecords: r.removedRecords };
        },
        getMemoryConfig: () => disabledHindsight(),
      },
    });
    expect(outcome.builtinMemoryRemovedRecords).toBe(1);
    expect(await store.recall("May 19", { callerRole: "router", bank: "private" })).toHaveLength(0);
    // Shared bank MUST remain untouched!
    expect(await store.recall("May 19", { callerRole: "worker", bank: "shared", projectId: "proj-1" })).toHaveLength(1);

    // Insert a leaked secret directly via SQL to test startup scrubBuiltinMemorySecrets
    await store.close();
    const db = new DatabaseSync(path.join(dir, "memory.sqlite"));
    db.prepare(
      `INSERT INTO memories (id, bank, scope_kind, project_id, topic_id, source, source_id, evidence_level, category, content, content_hash, identifiers_text, tokens_text, status, durability, created_at, updated_at, last_accessed_at, access_count)
       VALUES ('leak-1', 'private', 'global', NULL, NULL, 'tool', 'src-leak-1', 'user_decision', 'fact', 'My OpenAI key is sk-live-1234567890abcdef1234567890', 'hleak', 'openai key', 'openai key', 'active', 'permanent', 1, 1, 1, 0)`,
    ).run();
    db.close();

    const scrubbed = await scrubBuiltinMemorySecrets(dir, (t) => t, {
      isKnownSecret: (t) => t.includes("sk-live-1234567890abcdef1234567890"),
    });
    expect(scrubbed.deletedRows).toBe(1);
    expect(fs.existsSync(path.join(dir, BUILTIN_MEMORY_REDACTION_PENDING_FILE))).toBe(false);

    const verifyDb = new DatabaseSync(path.join(dir, "memory.sqlite"), { readOnly: true });
    const count = (verifyDb.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = 'leak-1'").get() as { c: number }).c;
    verifyDb.close();
    expect(count).toBe(0);
  });

  it("enforces HTTP 401/403/409/503 guards and cluster replica clear-epoch verification", async () => {
    const dir = makeTmpDir();
    const hub = await KuloHub.open({
      config: { stateDir: dir, identityDir: path.join(dir, "identity"), port: 0, authToken: "test-hub-token" },
    });
    const server = await startKuloHubServer(hub, { port: 0, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      // 1. Unauthenticated -> 401
      const unauth = await fetch(`${base}/api/builtin-memory`);
      expect(unauth.status).toBe(401);

      // 2. Authenticated GET -> 200 with cache-control: no-store
      const okGet = await fetch(`${base}/api/builtin-memory`, {
        headers: { Authorization: "Bearer test-hub-token" },
      });
      expect(okGet.status).toBe(200);
      expect(okGet.headers.get("cache-control")).toBe("no-store");
      const initial = (await okGet.json()) as { enabled: boolean; revision: number; clearTargetEpoch: number };
      expect(initial.enabled).toBe(true);

      // 3. Cross-origin POST -> 403
      const crossOrigin = await fetch(`${base}/api/builtin-memory/enabled`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-hub-token",
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ enabled: false, expectedRevision: initial.revision }),
      });
      expect(crossOrigin.status).toBe(403);

      // 4. Stale revision -> 409
      const staleRev = await fetch(`${base}/api/builtin-memory/enabled`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-hub-token",
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ enabled: false, expectedRevision: initial.revision + 5 }),
      });
      expect(staleRev.status).toBe(409);

      // 5. Valid toggle -> 200
      const toggled = await fetch(`${base}/api/builtin-memory/enabled`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-hub-token",
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ enabled: false, expectedRevision: initial.revision }),
      });
      expect(toggled.status).toBe(200);
      const toggledView = (await toggled.json()) as { enabled: boolean; revision: number; clearTargetEpoch: number };
      expect(toggledView.enabled).toBe(false);
      expect(toggledView.revision).toBe(initial.revision + 1);

      // 6. SSH principal forbidden on route handler (403)
      let sshStatus = 0;
      const fakeCtx = {
        hub,
        req: { method: "POST", headers: { origin: base } } as unknown as http.IncomingMessage,
        res: { setHeader: () => {} } as unknown as http.ServerResponse,
        parsedUrl: new URL(`${base}/api/builtin-memory/clear`),
        pathname: "/api/builtin-memory/clear",
        authority: { hasOwnerHubControl: true, isSshPrincipal: true } as HubHttpRouteContext["authority"],
        readJsonObject: async () => ({ confirm: true, expectedEpoch: 0, operationId: "op-ssh" }),
        readJsonBody: async () => ({}),
        sendJson: (_res: http.ServerResponse, status: number) => { sshStatus = status; },
        requestOrigin: () => base,
        currentDevice: () => "local",
        hasLocalDeviceControl: () => false,
        hasOwnerHubControl: () => true,
        isHubSecret: () => false,
        openNativePermissionSettings: async () => {},
        conversationQueryContext: async (_r: unknown, _s: unknown, run: (c: typeof BACKGROUND_CONTEXT) => Promise<unknown>) => run(BACKGROUND_CONTEXT),
      } as unknown as HubHttpRouteContext;
      await handleBuiltinMemoryRoutes(fakeCtx);
      expect(sshStatus).toBe(403);

      // 7. Handover barrier active -> 503 on POST
      hub.beginHandoverBarrier();
      const barrierRes = await fetch(`${base}/api/builtin-memory/clear`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-hub-token",
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ confirm: true, expectedEpoch: toggledView.clearTargetEpoch, operationId: "op-503" }),
      });
      expect(barrierRes.status).toBe(503);
      hub.releaseHandoverBarrier();

      // 8. Verify ClusterSyncService manifest includes memory.sqlite & capability, and replica clear-epoch check works
      const sync = new ClusterSyncService({
        stateDir: dir,
        getHubId: () => "hub-test",
        getPrimaryNodeId: () => "node-1",
        getClusterEpoch: () => 1,
        hasRemoteStandbys: () => true,
        getEffectiveIdentityDir: () => path.join(dir, "identity"),
        backupSqliteDb: (name, dst) => hub.backupSyncSqlite(name, dst),
        getBuiltinMemoryMeta: () => hub.memoryRuntime.builtinMemory.getClusterMeta(),
        readVaultEntries: async () => [],
        getSenderKeys: () => { throw new Error("unused"); },
        resolveStandbyPublicKey: () => undefined,
        notifySyncAvailable: () => {},
      });
      // Retain one row so memory.sqlite is materialized on disk before snapshot sync
      await hub.memoryRuntime.builtinMemory.store.retain({
        callerRole: "router",
        bank: "private",
        scopeKind: "global",
        source: "tool",
        sourceId: "sync-test-1",
        evidenceLevel: "user_decision",
        category: "fact",
        content: "Sync test memory item",
      });
      const manifest = await sync.flushNow();
      expect(manifest.sqlite.some((s) => s.name === "memory.sqlite")).toBe(true);
      expect(manifest.requiredCapabilities).toContain(CLUSTER_BUILTIN_MEMORY_CAPABILITY);
      expect(manifest.requiredDbs).toContain("memory.sqlite");
      expect(manifest.builtinMemoryMeta?.clearTargetEpoch).toBe(0);
      await sync.close();

      // Verify replica clear-epoch mismatch detection
      const replicaDir = makeTmpDir("kulo-replica-");
      await hub.memoryRuntime.builtinMemory.store.backupTo(path.join(replicaDir, "memory.sqlite"));
      expect(verifyReplicaBuiltinMemoryMeta(replicaDir, { clearTargetEpoch: 0, appliedClearEpoch: 0 }).ok).toBe(true);
      expect(verifyReplicaBuiltinMemoryMeta(replicaDir, { clearTargetEpoch: 3, appliedClearEpoch: 3 }).ok).toBe(false);
      expect(BUILTIN_MEMORY_FAILOVER_PAUSE_FILE).toBe("memory.sqlite.failover-paused");

      // P1-6: GET /api/builtin-memory rejects SSH principal (403), and POST rejects null/string epoch (400)
      let sshGetStatus = 0;
      await handleBuiltinMemoryRoutes({
        ...fakeCtx,
        req: { method: "GET", headers: {} } as unknown as http.IncomingMessage,
        parsedUrl: new URL(`${base}/api/builtin-memory`),
        pathname: "/api/builtin-memory",
        sendJson: (_res: http.ServerResponse, status: number) => { sshGetStatus = status; },
      } as unknown as HubHttpRouteContext);
      expect(sshGetStatus).toBe(403);

      const badEpochRes = await fetch(`${base}/api/builtin-memory/clear`, {
        method: "POST",
        headers: { Authorization: "Bearer test-hub-token", "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ confirm: true, expectedEpoch: null, operationId: "op-null-epoch" }),
      });
      expect(badEpochRes.status).toBe(400);
    } finally {
      await server.close();
      await hub.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("Hydrogen audit P0/P1 regression guarantees", () => {
  it("P0-1: scrubBuiltinMemorySecrets deletes matching rows from memories_fts as well as memories and compacts on pending marker", async () => {
    const dir = makeTmpDir("kulo-scrub-fts-");
    const store = new BuiltinMemoryStore({ stateDir: dir });
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      source: "tool",
      sourceId: "fts-secret-1",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "Production key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 stored",
    });
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      source: "tool",
      sourceId: "fts-safe-1",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "Keep benign architecture decision about SQLite WAL",
    });
    await store.close();

    const scrubbed = await scrubBuiltinMemorySecrets(dir, (s) => s);
    expect(scrubbed.deletedRows).toBe(1);
    expect(fs.existsSync(path.join(dir, BUILTIN_MEMORY_REDACTION_PENDING_FILE))).toBe(false);

    const db = new DatabaseSync(path.join(dir, "memory.sqlite"), { readOnly: true });
    const ftsRows = db.prepare("SELECT memory_id, tokens_text FROM memories_fts").all() as Array<{ memory_id: string; tokens_text: string }>;
    db.close();
    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0]!.tokens_text).not.toContain("sk");
    expect(ftsRows[0]!.tokens_text).toContain("sqlite");

    // Crash-recovery: leftover pending marker with 0 matched rows still cleans up & removes marker
    fs.writeFileSync(path.join(dir, BUILTIN_MEMORY_REDACTION_PENDING_FILE), "1\n");
    const recovery = await scrubBuiltinMemorySecrets(dir, (s) => s);
    expect(recovery.deletedRows).toBe(0);
    expect(fs.existsSync(path.join(dir, BUILTIN_MEMORY_REDACTION_PENDING_FILE))).toBe(false);
  });

  it("P0-2 & P0-3: starts fail-closed until start() completes, preserves replica builtinMemoryMeta, and recovers failover-paused on clearAll", async () => {
    const dir = makeTmpDir("kulo-failclosed-");
    const { harness, service } = await openHarness(dir);
    // Before start(), service MUST be fail-closed!
    expect(service.isBlocked).toBe(true);
    expect(service.isEffectiveActive()).toBe(false);

    await service.start(BACKGROUND_CONTEXT);
    expect(service.isBlocked).toBe(false);
    expect(service.isEffectiveActive()).toBe(true);

    // Simulate failover-paused state: blocked until explicit clearAll(), which removes marker and unblocks
    const pauseFile = path.join(dir, BUILTIN_MEMORY_FAILOVER_PAUSE_FILE);
    fs.writeFileSync(pauseFile, "replica_clear_epoch_behind\n");
    service.setFailoverPaused(true);
    expect(service.isBlocked).toBe(true);
    expect(service.isEffectiveActive()).toBe(false);

    const cleared = await service.clearAll({ confirm: true, expectedEpoch: 0, operationId: "op-recover-pause" }, BACKGROUND_CONTEXT);
    expect(cleared.blocked).toBeUndefined();
    expect(service.isBlocked).toBe(false);
    expect(service.isEffectiveActive()).toBe(true);
    expect(fs.existsSync(pauseFile)).toBe(false);

    // readReplicaState preserves builtinMemoryMeta & verifyStagedManifestBuiltinMemory enforces capabilities + epoch
    const replicaDir = makeTmpDir("kulo-replica-state-");
    await service.store.backupTo(path.join(replicaDir, "memory.sqlite"));
    fs.writeFileSync(path.join(replicaDir, "replica-state.json"), JSON.stringify({
      version: 1,
      hubId: "hub-1",
      primaryNodeId: "node-1",
      epoch: 1,
      generation: 4,
      vaultRevision: 1,
      syncedAt: Date.now(),
      pendingVaultEnvelope: false,
      uploadsComplete: true,
      builtinMemoryMeta: { clearTargetEpoch: 1, appliedClearEpoch: 1, lastAppliedSeq: 0 },
    }));
    const parsedReplica = readReplicaState(replicaDir);
    expect(parsedReplica?.builtinMemoryMeta).toEqual({ clearTargetEpoch: 1, appliedClearEpoch: 1, lastAppliedSeq: 0 });
    expect(() => verifyStagedManifestBuiltinMemory(replicaDir, { requiredCapabilities: ["unknown-cap-v9"] })).toThrow(/不支持同步能力/);
    expect(() => verifyStagedManifestBuiltinMemory(replicaDir, {
      requiredCapabilities: [CLUSTER_BUILTIN_MEMORY_CAPABILITY],
      builtinMemoryMeta: { clearTargetEpoch: 5, appliedClearEpoch: 5 },
    })).toThrow(/校验失败/);
    expect(() => verifyStagedManifestBuiltinMemory(replicaDir, {
      requiredCapabilities: [CLUSTER_BUILTIN_MEMORY_CAPABILITY],
      builtinMemoryMeta: { clearTargetEpoch: 1, appliedClearEpoch: 1 },
    })).not.toThrow();

    await service.close();
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("P0-4, P0-5, P0-6, P1-1, P1-2, P1-3: covers soft-deleted watermarks, epoch-fenced store retain, ACP denylist, inspect redaction, SQL pre-filter, and outbox forget", async () => {
    // P0-6: ACP path denylist protects memory.sqlite & sidecars
    expect(isProtectedAcpPath("/custom/state/memory.sqlite", false)).toBe(true);
    expect(isProtectedAcpPath("/custom/state/memory.sqlite-wal", false)).toBe(true);
    expect(isProtectedAcpPath("/custom/state/memory.sqlite.failover-paused", false)).toBe(true);
    expect(isProtectedAcpPath("/custom/state/memory.sqlite.redaction-pending", false)).toBe(true);

    // P0-4: collectAllConversationIds includes soft-deleted topics
    const convIds = collectAllConversationIds({
      topics: {
        active: { id: "active", conversationId: 11 } as never,
        deleted: { id: "deleted", conversationId: 22, deletedAt: 12345 } as never,
      },
      tickets: {},
    } as never);
    expect(convIds).toEqual(expect.arrayContaining([1, 11, 22]));

    // P1-1: summarizeEntryForInspect & extractLiveState redact built-in memory tools
    const redactedInspect = summarizeEntryForInspect({
      id: 10 as never,
      kind: ToolResultEntry.kind,
      data: {},
      model: [{
        role: "toolResult",
        toolCallId: "tc-mem",
        toolName: "kulo_memory_recall",
        isError: false,
        content: [{ type: "text", text: "SENSITIVE_MEMORY_LINE_SHOULD_NOT_APPEAR" }],
        timestamp: 1000,
      }],
    } as unknown as EntryRecord);
    expect(redactedInspect.summary).toBe("kulo_memory_recall: ok");
    expect(redactedInspect.summary).not.toContain("SENSITIVE_MEMORY_LINE");

    const live = extractLiveState({
      entries: [],
      docs: {
        "pi.live": {
          run: { id: 1 },
          tools: [{ callId: "c1", name: "kulo_memory_recall", status: "running", output: "RAW_MEMORY_OUTPUT" }],
        },
      },
    } as never);
    expect(live.activeTools[0]?.name).toBe("kulo_memory_recall");
    expect(live.activeTools[0]?.outputTail).toBeUndefined();

    // P1-2 & P0-5: private-bank SQL pre-filter prevents unauthorized rows from crowding out LIMIT,
    // Exact Identifier finds permanent record buried behind >620 newer rows, and expectedAppliedClearEpoch rejects stale writes
    const dir = makeTmpDir("kulo-prefilter-");
    const store = new BuiltinMemoryStore({ stateDir: dir });
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "project",
      projectId: "proj-target",
      source: "tool",
      sourceId: "oldest-permanent-ident",
      evidenceLevel: "user_decision",
      category: "decision",
      durability: "permanent",
      content: "Legacy deployment anchor token ERR_OLD_PERMANENT_9981 for proj-target",
      now: 1_000,
    });
    for (let i = 0; i < 620; i += 1) {
      await store.retain({
        callerRole: "router",
        bank: "private",
        scopeKind: "project",
        projectId: "proj-other",
        source: "tool",
        sourceId: `noise-other-${i}`,
        evidenceLevel: "user_decision",
        category: "fact",
        content: `Unrelated proj-other deployment anchor note ${i}`,
        now: 2_000 + i,
      });
    }
    const ftsHits = await store.recall("deployment anchor", {
      callerRole: "router",
      bank: "private",
      projectId: "proj-target",
      limit: 6,
    });
    expect(ftsHits.some((h) => h.content.includes("ERR_OLD_PERMANENT_9981"))).toBe(true);
    expect(ftsHits.every((h) => !h.content.includes("proj-other"))).toBe(true);

    const exactHits = await store.recall("ERR_OLD_PERMANENT_9981", {
      callerRole: "router",
      bank: "private",
      projectId: "proj-target",
      limit: 6,
    });
    expect(exactHits.some((h) => h.content.includes("ERR_OLD_PERMANENT_9981"))).toBe(true);

    // P0-5: expectedAppliedClearEpoch mismatch rejected atomically in SQLite
    await store.clearAll(2);
    await expect(store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      source: "tool",
      sourceId: "stale-epoch-write",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "Should fail stale epoch",
      expectedAppliedClearEpoch: 1,
    })).rejects.toMatchObject({ code: "EPOCH_MISMATCH" });
    await store.close();

    // P1-3: forgetPrivateTerm purges matching pendingDeliveries so outbox drain never resurrects forgotten terms
    const dir2 = makeTmpDir("kulo-outbox-forget-");
    const { harness, service } = await openHarness(dir2);
    await service.start(BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(BuiltinMemoryDoc);
      doc.pendingDeliveries["flush:forget-me"] = {
        sourceId: "flush:forget-me",
        bank: "private",
        scopeKind: "global",
        source: "flush",
        evidenceLevel: "user_decision",
        category: "fact",
        content: "Remember forbidden secret-codename-77",
        clearEpoch: doc.clearTargetEpoch,
        engineEpoch: doc.engineEpoch,
        createdAt: Date.now(),
      };
    }, BACKGROUND_CONTEXT);
    await service.forgetPrivateTerm("secret-codename-77", BACKGROUND_CONTEXT);
    await service.drainOutbox(BACKGROUND_CONTEXT);
    const hitsAfterForget = await service.store.recall("secret-codename-77", { callerRole: "router", bank: "private" });
    expect(hitsAfterForget).toHaveLength(0);
    await service.close();
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("F-03, F-07 & F-08: serializes startup scrub cleanly, resolves/supersedes flush records, and aligns project scopeFilter", async () => {
    const dir = makeTmpDir("kulo-mem-v016-");
    let writeHookCalls = 0;
    const store = new BuiltinMemoryStore({ stateDir: dir });
    store.setOnWrite(() => { writeHookCalls += 1; });

    // Seed active flush-format record, topic-in-project record, and global record carrying project_id provenance
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "project",
      projectId: "proj-alpha",
      topicId: "topic-1",
      source: "flush",
      sourceId: "flush:flush:1:10:abcdef1234:fp-old",
      evidenceLevel: "user_decision",
      category: "decision",
      content: "Alpha legacy target port 4001",
    });
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "topic",
      projectId: "proj-alpha",
      topicId: "topic-2",
      source: "tool",
      sourceId: "topic-scoped-alpha",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "Alpha topic-level deployment note ALPHA_TOPIC_42",
    });
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "global",
      projectId: "proj-alpha",
      topicId: "topic-2",
      source: "flush",
      sourceId: "global-with-proj-provenance",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "Global preference ZEBRA_ONLY_99 created while chatting in project",
    });

    // F-08: scopeFilter="project" includes topic-scoped memories in proj-alpha and excludes global memories carrying provenance
    const projectHits = await store.recall("ALPHA_TOPIC_42", {
      callerRole: "router",
      bank: "private",
      scopeFilter: "project",
      projectId: "proj-alpha",
    });
    expect(projectHits.some((h) => h.content.includes("ALPHA_TOPIC_42"))).toBe(true);
    const leakedGlobal = await store.recall("ZEBRA_ONLY_99", {
      callerRole: "router",
      bank: "private",
      scopeFilter: "project",
      projectId: "proj-alpha",
    });
    expect(leakedGlobal).toHaveLength(0);

    // F-07: flush supersedesId using WorkingMemoryRecord.id supersedes flush:<id>:<fp> row
    await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "project",
      projectId: "proj-alpha",
      source: "flush",
      sourceId: "flush:flush:1:12:fedcba4321:fp-new",
      supersedesId: "flush:1:10:abcdef1234",
      evidenceLevel: "user_decision",
      category: "decision",
      content: "Alpha updated target port 4002",
    });
    const oldPortHits = await store.recall("4001", { callerRole: "router", bank: "private", projectId: "proj-alpha" });
    expect(oldPortHits).toHaveLength(0);
    const newPortHits = await store.recall("4002", { callerRole: "router", bank: "private", projectId: "proj-alpha" });
    expect(newPortHits).toHaveLength(1);

    // F-07: status="resolved" with supersedesId resolves target row & fires onWrite without inserting orphan row
    const writesBeforeResolve = writeHookCalls;
    const resolved = await store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "project",
      projectId: "proj-alpha",
      source: "flush",
      sourceId: "flush:flush:1:15:9999999999:fp-resolved",
      supersedesId: "flush:1:12:fedcba4321",
      status: "resolved",
      evidenceLevel: "user_decision",
      category: "decision",
      content: "Resolved port migration",
    });
    expect(resolved.inserted).toBe(false);
    expect(writeHookCalls).toBeGreaterThan(writesBeforeResolve);
    const postResolveHits = await store.recall("4002", { callerRole: "router", bank: "private", projectId: "proj-alpha" });
    expect(postResolveHits).toHaveLength(0);

    // F-03: runExclusiveUnopened serializes scrub cleanly against concurrent backupTo() and getMetaSnapshot()
    const backupTarget = path.join(makeTmpDir("kulo-mem-backup-"), "memory-copy.sqlite");
    const [scrubRes, metaRes, backupRes] = await Promise.all([
      store.runExclusiveUnopened(() => scrubBuiltinMemorySecrets(dir, (s) => s)),
      store.getMetaSnapshot(),
      store.backupTo(backupTarget),
    ]);
    expect(scrubRes.deletedRows).toBe(0);
    expect(metaRes.appliedClearEpoch).toBe(0);
    expect(backupRes).toBe(true);
    await store.close();
  });
});
