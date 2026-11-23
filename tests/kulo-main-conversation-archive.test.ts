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
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { collapseSystemMessages, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTask,
  type ConversationId,
} from "@earendil-works/pi-durable";
import type { TicketRecord } from "@kulo/protocol";
import { ActionConfirmationsDoc } from "../packages/hub/src/action-confirmations.js";
import { BuiltinMemoryDoc } from "../packages/hub/src/builtin-memory-doc.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { abortConversationSafely } from "../packages/hub/src/conversation-abort.js";
import { MediaNoticesDoc } from "../packages/hub/src/hub-media-delivery.js";
import { KuloMediaJobsDoc } from "../packages/hub/src/media-jobs.js";
import { parseFlushExtraction } from "../packages/hub/src/memory-flush-extract.js";
import { createOrchestratorSections } from "../packages/hub/src/prompts.js";
import { createRecentWorkSyncHook, isSystemBaselinePending } from "../packages/hub/src/recent-work-sync.js";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import {
  KuloStateDoc,
  ensureDefaultRootTopic,
  isActiveRootConversation,
  resolveActiveRootConversationId,
} from "../packages/hub/src/state.js";
import {
  KuloWorkingMemoryDoc,
  bucketIdForScope,
  commitWorkingMemory,
  computeMemoryFingerprint,
  formatLocalDate,
  upsertWorkingMemoryRecord,
} from "../packages/hub/src/working-memory.js";
import { rehomeRootWorkingMemoryOnArchive } from "../packages/hub/src/working-memory-archive.js";
import { mergeChatSubmissions, reconcileSubmissions, type PendingSubmissionBackup } from "../packages/web/src/features/chat/chat-submissions.js";
import { consumedOutboxReceipts } from "../packages/web/src/features/chat/outbox-submissions.js";
import type { ReliableOutboxRecord } from "../packages/web/src/features/chat/reliable-outbox.js";
import { evaluateTopicConversationFrame } from "../packages/web/src/features/shell/root-rotation.js";
import { openTestHub } from "./helpers/secure-hub.js";

const ctx = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function makeTempDir(prefix = "kulo-main-archive-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeModelsWithReplies(replies: string[], capturedRequests?: TranscriptContext[]) {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "test-model" }] });
  let chatIndex = 0;
  provider.setResponses(
    Array.from({ length: Math.max(replies.length + 12, 16) }, () => (context: TranscriptContext) => {
      const systemText = context.messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      if (systemText.includes("working-memory ledger entries")) {
        return fauxAssistantMessage([fauxText("{\"items\":[]}")]);
      }
      if (capturedRequests) capturedRequests.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
      const reply = replies[chatIndex] ?? `回复#${chatIndex + 1}`;
      chatIndex += 1;
      return fauxAssistantMessage([fauxText(reply)]);
    }),
  );
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider };
}

function makeTestTicket(partial: Partial<TicketRecord> & { id: string }): TicketRecord {
  return {
    commandId: `cmd:${partial.id}`,
    title: `工单 ${partial.id}`,
    goal: "测试目标",
    scope: "测试范围",
    role: "coder",
    envId: "local",
    workspaceDir: "/tmp/ws",
    status: "closed",
    runEpoch: 1,
    workerConversationId: 900,
    originConversationId: 1,
    originTopicId: "root",
    createdAt: 1000,
    updatedAt: 2000,
    ...partial,
  } as TicketRecord;
}

describe("Main conversation Archive & Rotate (v3 acceptance suite)", () => {
  it("1. supports consecutive rotations with immediate real model replies, restart persistence, and empty-root no-op", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["第一代回复", "第二代回复", "第三代回复"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: {
          defaultProvider: "openai",
          defaultModel: "test-model",
          thinkingLevel: "off",
        },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    // Empty root archive is a no-op and does NOT allocate a new conversation.
    const initialConvId = Number(hub.rootConversation.id);
    const emptyRes = await hub.archiveMainConversation({ expectedConversationId: initialConvId });
    expect(emptyRes).toEqual({
      archived: false,
      reason: "empty_conversation",
      rootConversationId: initialConvId,
    });

    // Generation 1 message + real model reply.
    const sub1 = await hub.sendUserMessage("第一代消息：请记住代号 ALPHA");
    await sub1.wait(ctx);
    await hub.rootConversation.waitForIdle(ctx);

    const rot1 = await hub.archiveMainConversation({ expectedConversationId: initialConvId });
    expect(rot1.archived).toBe(true);
    if (!rot1.archived) throw new Error("Expected rotation 1 to succeed");
    expect(rot1.archivedTopic.archived).toBe(true);
    expect(rot1.archivedTopic.archivedFromRoot).toBe(true);
    expect(rot1.archivedTopic.conversationId).toBe(initialConvId);
    expect(rot1.rootConversationId).toBeGreaterThan(initialConvId);
    expect(Number(hub.rootConversation.id)).toBe(rot1.rootConversationId);

    // Immediately send on fresh rotated root -> must get a real reply (proves atomic tx.createConversation + configure).
    const sub2 = await hub.sendUserMessage("第二代消息：验证新对话立即可用");
    const settled2 = await sub2.wait(ctx);
    await hub.rootConversation.waitForIdle(ctx);
    expect(settled2.status).toBe("done");
    const view2 = await hub.getTopicView("root");
    expect(view2.conversationId).toBe(rot1.rootConversationId);
    expect(view2.messages.some((m) => m.role === "assistant" && m.text.includes("第二代回复"))).toBe(true);
    expect(view2.messages.some((m) => m.text.includes("ALPHA"))).toBe(false);

    // Second consecutive rotation.
    const rot2 = await hub.archiveMainConversation({ expectedConversationId: rot1.rootConversationId });
    expect(rot2.archived).toBe(true);
    if (!rot2.archived) throw new Error("Expected rotation 2 to succeed");
    expect(rot2.archivedTopic.conversationId).toBe(rot1.rootConversationId);
    expect(rot2.rootConversationId).toBeGreaterThan(rot1.rootConversationId);

    const sub3 = await hub.sendUserMessage("第三代消息：验证重启保持");
    expect((await sub3.wait(ctx)).status).toBe("done");
    await hub.rootConversation.waitForIdle(ctx);
    const activeGen3Id = rot2.rootConversationId;

    // Close and reopen Hub on the same SQLite directory.
    await hub.close();
    const { models: models2 } = makeModelsWithReplies(["重启后回复"]);
    const reopened = await openTestHub({
      config: {
        stateDir,
        model: {
          defaultProvider: "openai",
          defaultModel: "test-model",
          thinkingLevel: "off",
        },
      },
      models: models2,
    });
    cleanups.push(() => reopened.close().catch(() => {}));

    expect(Number(reopened.rootConversation.id)).toBe(activeGen3Id);
    const snap = await reopened.getFullClientSnapshot("root");
    expect(snap.activeTopicId).toBe("root");
    expect(snap.activeConversationId).toBe(activeGen3Id);
    expect(snap.messages.some((m) => m.text.includes("第三代消息"))).toBe(true);
    expect(snap.messages.some((m) => m.text.includes("ALPHA"))).toBe(false);
    const archivedTopics = snap.topics.filter((t) => t.archivedFromRoot);
    expect(archivedTopics).toHaveLength(2);
    expect(archivedTopics.every((t) => t.archived === true)).toBe(true);

    const reopenedState = await reopened.harness.snapshot(KuloStateDoc, ctx);
    expect(resolveActiveRootConversationId(reopenedState)).toBe(activeGen3Id);
    expect(isActiveRootConversation(activeGen3Id, reopenedState)).toBe(true);
    expect(isActiveRootConversation(initialConvId, reopenedState)).toBe(false);
  });

  it("2. replays interrupted pendingMainArchiveFinalize on startup without clobbering post-switch messages or resurrecting deleted archives", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["第一轮回答", "新代次首轮回答"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const conv1Id = Number(hub.rootConversation.id);
    await (await hub.sendUserMessage("旧主对话内容")).wait(ctx);
    await hub.rootConversation.waitForIdle(ctx);

    // Seed a topic:root working memory record for conv1 before rotation.
    const today = formatLocalDate(Date.now());
    await commitWorkingMemory(
      hub.harness,
      (x) => x,
      (doc) => {
        upsertWorkingMemoryRecord(doc, {
          id: "wm-old-1",
          bucketId: "topic:root",
          category: "fact",
          evidenceLevel: "user_decision",
          status: "active",
          date: today,
          summary: "旧主对话事实",
          fingerprint: computeMemoryFingerprint("fact", "旧主对话事实"),
          provenance: { conversationId: conv1Id, topicId: "root", entryId: 1, sourceRole: "user" },
          createdAt: 1000,
          updatedAt: 1000,
        });
      },
      ctx,
    );

    const rot = await hub.archiveMainConversation({ expectedConversationId: conv1Id });
    expect(rot.archived).toBe(true);
    if (!rot.archived) throw new Error("Expected archive");
    const conv2Id = rot.rootConversationId;
    const archivedTopicId = rot.archivedTopic.id;

    // Simulate user sending a message in newConv BEFORE a crash while finalize was incomplete!
    await (await hub.sendUserMessage("旋转后的新消息")).wait(ctx);
    await hub.rootConversation.waitForIdle(ctx);

    // Manually re-inject incomplete pendingMainArchiveFinalize to simulate crash between commit & finalize.
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.pendingMainArchiveFinalize = {
        oldConvId: conv1Id,
        newConvId: conv2Id,
        archivedTopicId,
        tailEntryId: 2,
        createdAt: Date.now(),
        steps: {
          reconfiguredOld: false,
          watchedNew: false,
          rehomedWorkingMemory: false,
          dispatchedFlush: false,
          reboundBuiltinMemory: false,
        },
      };
    }, ctx);

    await hub.close();

    // Reopen -> startup finalize replay must finish all 5 steps and clear pendingMainArchiveFinalize
    // while preserving conv2's post-switch message and never setting needsBaselineRefresh on conv2!
    const { models: models2 } = makeModelsWithReplies(["继续对话"]);
    const reopened = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models: models2,
    });
    cleanups.push(() => reopened.close().catch(() => {}));

    const afterState = await reopened.harness.snapshot(KuloStateDoc, ctx);
    expect(afterState?.pendingMainArchiveFinalize).toBeUndefined();
    const view = await reopened.getTopicView("root");
    expect(view.conversationId).toBe(conv2Id);
    expect(view.messages.some((m) => m.text.includes("旋转后的新消息"))).toBe(true);
    const wm = await reopened.harness.snapshot(KuloWorkingMemoryDoc, ctx);
    expect(wm?.cursors?.[String(conv2Id)]?.needsBaselineRefresh).toBeUndefined();

    // Now test crash-recovery when the archived topic was deleted before finalize ran.
    await reopened.deleteTopic(archivedTopicId, ctx);
    await reopened.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.pendingMainArchiveFinalize = {
        oldConvId: conv1Id,
        newConvId: conv2Id,
        archivedTopicId,
        tailEntryId: 2,
        createdAt: Date.now(),
        steps: {
          reconfiguredOld: true,
          watchedNew: true,
          rehomedWorkingMemory: false,
          dispatchedFlush: false,
          reboundBuiltinMemory: false,
        },
      };
    }, ctx);
    await reopened.close();

    const { models: models3 } = makeModelsWithReplies([]);
    const reopened2 = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models: models3,
    });
    cleanups.push(() => reopened2.close().catch(() => {}));

    const wmAfterDelete = await reopened2.harness.snapshot(KuloWorkingMemoryDoc, ctx);
    expect(wmAfterDelete?.cursors?.[String(conv1Id)]).toBeUndefined();
    const stateAfterDelete = await reopened2.harness.snapshot(KuloStateDoc, ctx);
    expect(stateAfterDelete?.pendingMainArchiveFinalize).toBeUndefined();
  });

  it("3. enforces write-freeze on archived topics, restores cleanly, blocks unsafe archives (409), and enforces HTTP origin/validation", async () => {
    const stateDir = makeTempDir();
    const authToken = "test-archive-token-0123456789abcdef";
    const { models } = makeModelsWithReplies(["回复一", "还原后的回复"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        authToken,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const conv1Id = Number(hub.rootConversation.id);
    await (await hub.sendUserMessage("归档前的对话")).wait(ctx);
    await hub.rootConversation.waitForIdle(ctx);

    // Wrong expectedConversationId -> 409 root_conversation_changed.
    await expect(hub.archiveMainConversation({ expectedConversationId: conv1Id + 99 })).rejects.toMatchObject({
      status: 409,
      code: "root_conversation_changed",
    });

    // Blocking ticket (finalRelayPending / running) -> 409 blocking_tickets.
    await hub.harness.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      s.tickets["T-block"] = makeTestTicket({
        id: "T-block",
        status: "closed",
        finalRelayPending: true,
        originConversationId: conv1Id,
        originTopicId: "root",
      });
    }, ctx);
    await expect(hub.archiveMainConversation({ expectedConversationId: conv1Id })).rejects.toMatchObject({
      status: 409,
      code: "blocking_tickets",
    });
    // Clear blocking flag -> ticket becomes settled and will migrate!
    await hub.harness.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      delete s.tickets["T-block"]!.finalRelayPending;
    }, ctx);

    // Pending confirmation -> 409 pending_confirmations.
    await hub.harness.commit(async (tx) => {
      const conf = await tx.doc(ActionConfirmationsDoc);
      conf.byId ??= {};
      conf.byId["conf-1"] = {
        id: "conf-1",
        conversationId: conv1Id,
        kind: "host_action",
        fingerprint: "fp-1",
        status: "pending",
        actionMap: {},
        createdAt: 1000,
        payload: { kind: "host_action", envId: "local", envName: "local", summary: "test", commands: ["echo hi"] },
      };
    }, ctx);
    await expect(hub.archiveMainConversation({ expectedConversationId: conv1Id })).rejects.toMatchObject({
      status: 409,
      code: "pending_confirmations",
    });
    await hub.harness.commit(async (tx) => {
      const conf = await tx.doc(ActionConfirmationsDoc);
      delete conf.byId?.["conf-1"];
    }, ctx);

    // Active direct media job -> 409 pending_media_jobs; pending relay -> 409 pending_media_relays.
    await hub.harness.commit(async (tx) => {
      const mj = await tx.doc(KuloMediaJobsDoc);
      mj.jobs["mj-1"] = {
        id: "mj-1",
        kind: "image",
        status: "running",
        capabilityId: "cap-1",
        modelId: "img-1",
        prompt: "cat",
        count: 1,
        source: { conversationId: conv1Id, topicId: "root" },
        createdAt: 1,
        updatedAt: 1,
        fingerprint: "fp",
        connection: { id: "c1", adapter: "openai-image", name: "n", baseUrl: "https://example.test", origin: "https://example.test", revision: 1, hasCredential: true },
      } as unknown as (typeof mj.jobs)[string];
    }, ctx);
    await expect(hub.archiveMainConversation({ expectedConversationId: conv1Id })).rejects.toMatchObject({
      status: 409,
      code: "pending_media_jobs",
    });
    await hub.harness.commit(async (tx) => {
      const mj = await tx.doc(KuloMediaJobsDoc);
      delete mj.jobs["mj-1"];
      const mn = await tx.doc(MediaNoticesDoc);
      mn.pendingRelays = { [String(conv1Id)]: [{ eventKey: "ev-1", jobId: "mj-1", kind: "completed", queuedAt: 1 }] };
    }, ctx);
    await expect(hub.archiveMainConversation({ expectedConversationId: conv1Id })).rejects.toMatchObject({
      status: 409,
      code: "pending_media_relays",
    });
    await hub.harness.commit(async (tx) => {
      const mn = await tx.doc(MediaNoticesDoc);
      delete mn.pendingRelays;
    }, ctx);

    // Voice dedup cache (`taskUpdated` -> `#topicTasks`) must NOT block archive!
    hub.voiceCalls.taskUpdated("root", "T-block", "done", "closed");
    expect(hub.voiceCalls.hasActiveOrPendingCallForTopic("root")).toBe(false);

    // Start HTTP server to verify POST /api/topics/root/archive security + validation.
    const server = await startKuloHubServer(hub, { port: 0, host: "127.0.0.1" });
    cleanups.push(() => server.close().catch(() => {}));
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Unauthenticated request rejected (401).
    const unauth = await fetch(`${baseUrl}/api/topics/root/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ expectedConversationId: conv1Id }),
    });
    expect(unauth.status).toBe(401);

    // Cross-origin request rejected (403).
    const crossOrigin = await fetch(`${baseUrl}/api/topics/root/archive`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ expectedConversationId: conv1Id }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toBe("no-store");

    // Unknown body field rejected (400).
    const badBody = await fetch(`${baseUrl}/api/topics/root/archive`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        origin: baseUrl,
      },
      body: JSON.stringify({ expectedConversationId: conv1Id, extra: true }),
    });
    expect(badBody.status).toBe(400);

    // Seed a UI card on conv1 before archiving so we can verify archived card submit write-freeze.
    const seededCard = await hub.uiCards.show(
      {
        title: "归档前测试卡片",
        spec: {
          root: "box",
          elements: {
            box: { type: "Card", props: { title: "归档前测试卡片" }, children: ["btn"] },
            btn: { type: "Button", props: { label: "确认", actionId: "confirm" } },
          },
        },
        actions: [{ id: "confirm", label: "确认", kind: "submit" }],
      },
      { conversationId: conv1Id, callId: "tc-archive-card-1", actorRole: "router" },
    );

    // Valid archive via HTTP succeeds (200) with no-store.
    const okRes = await fetch(`${baseUrl}/api/topics/root/archive`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        origin: baseUrl,
      },
      body: JSON.stringify({ expectedConversationId: conv1Id }),
    });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("cache-control")).toBe("no-store");
    const archivePayload = (await okRes.json()) as { archived: true; archivedTopic: { id: string }; rootConversationId: number };
    expect(archivePayload.archived).toBe(true);
    const archivedTopicId = archivePayload.archivedTopic.id;

    // Settled ticket migrated from "root" to archivedTopicId.
    const postState = await hub.harness.snapshot(KuloStateDoc, ctx);
    expect(postState?.tickets["T-block"]?.originTopicId).toBe(archivedTopicId);
    expect(postState?.tickets["T-block"]?.originConversationId).toBe(conv1Id);

    // Write-freeze on archived topic across chat.send, retryTurn, compactTopic, uiCards.submit, and voiceCalls.
    await expect(hub.sendUserMessage("尝试往归档写", { topicId: archivedTopicId })).rejects.toMatchObject({
      status: 409,
      code: "topic_archived",
    });
    await expect(hub.retryTurn(archivedTopicId)).rejects.toMatchObject({
      status: 409,
      code: "topic_archived",
    });
    await expect(hub.compactTopic(archivedTopicId)).rejects.toMatchObject({
      status: 409,
      code: "topic_archived",
    });
    await expect(
      hub.uiCards.submit(
        {
          cardId: seededCard.cardId,
          actionId: seededCard.actions[0]!.id,
          revision: seededCard.revision,
          values: {},
          commandId: "cmd-archived-card-1",
        },
        { conversationId: conv1Id },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "topic_archived",
    });
    await expect(
      hub.voiceCalls.create({ topicId: archivedTopicId, principalId: "local", clientId: "test-client", commandId: "voice-req-1" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "topic_archived",
    });

    // Restoring archived topic unlocks writes cleanly without replacing live "root".
    const restored = await hub.patchTopic(archivedTopicId, { archived: false });
    expect(restored.archived).toBe(false);
    expect(Number(hub.rootConversation.id)).toBe(archivePayload.rootConversationId);
    const restoredSub = await hub.sendUserMessage("还原后继续发言", { topicId: archivedTopicId });
    expect((await restoredSub.wait(ctx)).status).toBe("done");
  });

  it("4. enforces multi-client generation CAS, Lost-ACK dedup across rotation, and Web outbox isolation", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["旧代回复"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const conv1Id = Number(hub.rootConversation.id);
    const lostAckReqId = "req-lost-ack-1";
    const ack1 = await hub.deliverClientMessage({
      type: "chat.send",
      topicId: "root",
      expectedConversationId: conv1Id,
      content: "断网前已送达的消息",
      requestId: lostAckReqId,
    });
    expect(ack1.conversationId).toBe(conv1Id);
    await hub.rootConversation.waitForIdle(ctx);

    const rot = await hub.archiveMainConversation({ expectedConversationId: conv1Id });
    expect(rot.archived).toBe(true);
    if (!rot.archived) throw new Error("Expected archive");
    const conv2Id = rot.rootConversationId;

    // Lost-ACK replay of already-committed reqId returns the original receipt (conversationId=conv1Id, deduplicated=true)
    // and NEVER duplicates into conv2!
    const replayedAck = await hub.deliverClientMessage({
      type: "chat.send",
      topicId: "root",
      expectedConversationId: conv1Id,
      content: "断网前已送达的消息",
      requestId: lostAckReqId,
    });
    expect(replayedAck.deduplicated).toBe(true);
    expect(replayedAck.conversationId).toBe(conv1Id);

    // Brand-new send/abort/retry carrying stale expectedConversationId=conv1Id are rejected with 409 root_conversation_rotated!
    await expect(
      hub.deliverClientMessage({
        type: "chat.send",
        topicId: "root",
        expectedConversationId: conv1Id,
        content: "未发出但过期的消息",
        requestId: "req-stale-new",
      }),
    ).rejects.toMatchObject({ status: 409, code: "root_conversation_rotated" });
    await expect(
      hub.deliverClientMessage({
        type: "chat.abort",
        topicId: "root",
        expectedConversationId: conv1Id,
        requestId: "abort-stale",
      }),
    ).rejects.toMatchObject({ status: 409, code: "root_conversation_rotated" });
    await expect(
      hub.deliverClientMessage({
        type: "chat.retry",
        topicId: "root",
        expectedConversationId: conv1Id,
        requestId: "retry-stale",
      }),
    ).rejects.toMatchObject({ status: 409, code: "root_conversation_rotated" });

    // New root stays completely clean.
    const view2 = await hub.getTopicView("root");
    expect(view2.conversationId).toBe(conv2Id);
    expect(view2.messages).toHaveLength(0);

    // Web outbox helpers isolate accepted/failed old-generation entries from new generation conv2Id.
    const oldSub: PendingSubmissionBackup = {
      topicId: "root",
      draftKey: "topic:root",
      envelope: { type: "chat.send", topicId: "root", expectedConversationId: conv1Id, content: "old", requestId: lostAckReqId, whenBusy: "steer" },
      rawUserText: "old",
      draftAttachments: [],
      state: "accepted",
      localMessageId: -1,
      createdAt: 1000,
      conversationId: conv1Id,
    };
    expect(mergeChatSubmissions([], [oldSub], "root", conv2Id)).toHaveLength(0);
    expect(reconcileSubmissions([oldSub], [], "root", conv2Id)).toHaveLength(0);
    const oldRecord: ReliableOutboxRecord = {
      id: lostAckReqId,
      scope: "s",
      sequence: 1,
      createdAt: 1000,
      envelope: { type: "chat.send", topicId: "root", expectedConversationId: conv1Id, content: "old", requestId: lostAckReqId, whenBusy: "steer" },
      state: "accepted",
      attempt: 1,
      nextAttemptAt: 0,
      ack: { topicId: "root", conversationId: conv1Id, submissionId: 10, delivery: "accepted" },
    };
    expect(consumedOutboxReceipts([oldRecord], [], "root", conv2Id)).toEqual([lostAckReqId]);

    // Broadcast hub.messages frames (without selectionVersion) after hub.topics rotation must be accepted,
    // forward-rotation frames ahead of hub.topics must signal rotatedTo, and stale conv1Id frames must be dropped.
    expect(
      evaluateTopicConversationFrame({
        frameTopicId: "root",
        frameVersion: undefined,
        frameConversationId: conv2Id,
        activeTopicId: "root",
        activeConversationId: conv2Id,
        selectionVersion: 1,
        versionedSelections: true,
        changingTopic: false,
      }),
    ).toEqual({ accept: true });
    expect(
      evaluateTopicConversationFrame({
        frameTopicId: "root",
        frameVersion: undefined,
        frameConversationId: conv2Id,
        activeTopicId: "root",
        activeConversationId: conv1Id,
        selectionVersion: 1,
        versionedSelections: true,
        changingTopic: false,
      }),
    ).toEqual({ accept: true, rotatedTo: conv2Id });
    expect(
      evaluateTopicConversationFrame({
        frameTopicId: "root",
        frameVersion: undefined,
        frameConversationId: conv1Id,
        activeTopicId: "root",
        activeConversationId: conv2Id,
        selectionVersion: 1,
        versionedSelections: true,
        changingTopic: false,
      }),
    ).toEqual({ accept: false });
  });

  it("5. validates parseFlushExtraction malformed JSON vs empty JSON, working-memory rehome across all buckets, Built-in Memory rebind, and protected task safe abort", async () => {
    const batch = [{ entryId: 1, role: "user" as const, text: "记住偏好：回复简洁", timestamp: 1000, charOffset: 0, isPartial: false }];
    expect(parseFlushExtraction({ rawJson: "{truncated...", batch, conversationId: 1, topicId: "topic-archive-1", redact: (x) => x })).toEqual({
      ok: false,
      reason: "invalid_json",
    });
    expect(parseFlushExtraction({ rawJson: "{\"items\":[]}", batch, conversationId: 1, topicId: "topic-archive-1", redact: (x) => x })).toEqual({
      ok: true,
      records: [],
    });

    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["好的"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const conv1Id = Number(hub.rootConversation.id);
    const today = formatLocalDate(Date.now());
    await commitWorkingMemory(
      hub.harness,
      (x) => x,
      (doc) => {
        upsertWorkingMemoryRecord(doc, {
          id: "rec-root",
          bucketId: "topic:root",
          category: "fact",
          evidenceLevel: "user_decision",
          status: "active",
          date: today,
          summary: "主对话局部记录",
          fingerprint: computeMemoryFingerprint("fact", "主对话局部记录"),
          provenance: { conversationId: conv1Id, topicId: "root", entryId: 1, sourceRole: "user" },
          createdAt: 10,
          updatedAt: 10,
        });
        upsertWorkingMemoryRecord(doc, {
          id: "rec-global",
          bucketId: "global",
          category: "decision",
          evidenceLevel: "user_decision",
          status: "active",
          date: today,
          summary: "全局规则：一律使用中文",
          fingerprint: computeMemoryFingerprint("decision", "全局规则：一律使用中文"),
          provenance: { conversationId: conv1Id, topicId: "root", entryId: 1, sourceRole: "user" },
          createdAt: 10,
          updatedAt: 10,
        });
        upsertWorkingMemoryRecord(doc, {
          id: "rec-proj",
          bucketId: bucketIdForScope({ kind: "project", projectId: "proj-1" }),
          category: "event",
          evidenceLevel: "ticket_outcome",
          status: "active",
          date: today,
          summary: "项目事件记录",
          fingerprint: computeMemoryFingerprint("event", "项目事件记录"),
          provenance: { conversationId: conv1Id, topicId: "root", projectId: "proj-1", entryId: 1, sourceRole: "system_ticket" },
          createdAt: 10,
          updatedAt: 10,
        });
      },
      ctx,
    );

    // Seed a pending Built-in Memory delivery + stored row under topicId="root" for conv1Id.
    await hub.memoryRuntime.builtinMemory.start(ctx);
    await hub.memoryRuntime.builtinMemory.store.retain({
      callerRole: "router",
      bank: "private",
      scopeKind: "topic",
      topicId: "root",
      conversationId: conv1Id,
      source: "flush",
      sourceId: "flush:test-rebind",
      evidenceLevel: "user_decision",
      category: "fact",
      content: "主对话内的内置记忆条目",
      now: Date.now(),
    });
    await hub.harness.commit(async (tx) => {
      const bm = await tx.doc(BuiltinMemoryDoc);
      bm.pendingDeliveries["flush:pending-rebind"] = {
        sourceId: "flush:pending-rebind",
        bank: "private",
        scopeKind: "topic",
        topicId: "root",
        conversationId: conv1Id,
        source: "flush",
        evidenceLevel: "user_decision",
        category: "fact",
        content: "尚未落盘的内置记忆条目",
        clearEpoch: bm.clearTargetEpoch,
        engineEpoch: bm.engineEpoch,
        createdAt: Date.now(),
      };
    }, ctx);

    const moved = await rehomeRootWorkingMemoryOnArchive({
      harness: hub.harness,
      redact: (x) => x,
      oldConvId: conv1Id,
      newConvId: 99,
      archivedTopicId: "topic-archive-1",
      tailEntryId: 5,
      archivedDeleted: false,
      context: ctx,
    });
    expect(moved.movedRecords).toBe(1);
    expect(moved.reboundRecords).toBe(2);

    const wmSnap = await hub.harness.snapshot(KuloWorkingMemoryDoc, ctx);
    expect(wmSnap?.buckets["topic:root"]).toBeUndefined();
    expect(wmSnap?.buckets["topic:topic-archive-1"]?.[0]?.provenance.topicId).toBe("topic-archive-1");
    expect(wmSnap?.buckets.global?.[0]?.provenance.topicId).toBe("topic-archive-1");
    expect(wmSnap?.buckets["project:proj-1"]?.[0]?.provenance.topicId).toBe("topic-archive-1");
    expect(wmSnap?.cursors?.[String(conv1Id)]?.pendingTargetMaxEntryId).toBe(5);
    expect(wmSnap?.cursors?.["99"]?.needsBaselineRefresh).toBeUndefined();

    // Rebind Built-in Memory pendingDeliveries + memory.sqlite rows.
    await hub.memoryRuntime.rebindArchivedRootConversation(conv1Id, "topic-archive-1", ctx);
    const bmSnap = await hub.harness.snapshot(BuiltinMemoryDoc, ctx);
    expect(bmSnap?.pendingDeliveries["flush:pending-rebind"]?.topicId).toBe("topic-archive-1");
    const recalled = await hub.memoryRuntime.builtinMemory.store.recall("主对话内的内置记忆条目", {
      callerRole: "router",
      bank: "private",
      topicId: "topic-archive-1",
      limit: 5,
    });
    expect(recalled.some((r) => r.topicId === "topic-archive-1")).toBe(true);

    // Verify abortConversationSafely skips protected root system tasks.
    const protectedTask = defineTask<Record<string, never>, { phase: "wait" }, null>({
      name: "kulo.memory-service-operation",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: async (_t, runtime, c) => {
          await runtime.commit(async () => ({ status: "sleeping", until: runtime.now() + 60_000, checkpoint: { phase: "wait" } }), c);
        },
      },
      abort: async (_t, runtime, c) => {
        await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), c);
      },
    });
    const ordinaryBgTask = defineTask<Record<string, never>, { phase: "wait" }, null>({
      name: "kulo.test-ordinary-bg",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: async (_t, runtime, c) => {
          await runtime.commit(async () => ({ status: "sleeping", until: runtime.now() + 60_000, checkpoint: { phase: "wait" } }), c);
        },
      },
      abort: async (_t, runtime, c) => {
        await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), c);
      },
    });
    const ext = defineExtension({ name: "test-safe-abort", tasks: [protectedTask, ordinaryBgTask] });
    const reg = createRegistry();
    reg.install(ext);
    const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: reg }, ctx);
    cleanups.push(() => h.close(ctx));
    const rootConv = await h.root(ctx);
    const { protectedId, ordinaryId } = await h.commit(async (tx) => {
      const pId = await tx.createTask(protectedTask, {}, { ownership: { kind: "conversation" }, conversationId: rootConv.id, background: true });
      const oId = await tx.createTask(ordinaryBgTask, {}, { ownership: { kind: "conversation" }, conversationId: rootConv.id, background: true });
      return { protectedId: pId, ordinaryId: oId };
    }, ctx);
    await abortConversationSafely(h, rootConv, ctx);
    const insp = await h.inspect(ctx);
    expect(insp.tasks.some((t) => t.record.id === protectedId)).toBe(true);
    expect(insp.tasks.some((t) => t.record.id === ordinaryId)).toBe(false);
  });

  it("6. preserves Prompt Cache byte-for-byte prefix invariance when a fresh rotated root starts with empty working memory and receives async global notes before Turn 2", async () => {
    const capturedRequests: TranscriptContext[] = [];
    const { models } = makeModelsWithReplies(["第一轮已答复", "第二轮已答复"], capturedRequests);

    let harness!: Harness;
    const extension = defineExtension({
      name: "test-empty-baseline-cache",
      sections: createOrchestratorSections({
        getIdentityDir: () => "/nonexistent-archive-cache-test",
        getRoles: () => ({}),
        getEnvs: () => [],
        getMemoryConfig: () => resolveHubConfig({}).memory,
        getPersonalityContext: async () => ({
          identityAgreement: "身份：Kulo",
          relationship: "用户偏好简洁。",
          recentWorkEnabled: true,
        }),
        freezeRecentWorkBaseline: true,
        isSystemBaselinePending: (cid, c) => isSystemBaselinePending(harness, cid, c),
      }),
      hooks: [
        createRecentWorkSyncHook({
          getHarness: () => harness,
          getPersonalityContext: async () => ({
            recentWorkEnabled: true,
          }),
          redact: (x) => x,
        }),
      ],
    });
    const reg = createRegistry();
    reg.install(extension);
    harness = await Harness.open(new MemoryStorage(), { models, registry: reg }, ctx);
    cleanups.push(() => harness.close(ctx));

    const newRootConv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "openai", modelId: "test-model" },
          thinkingLevel: "off",
          extensions: [extension],
        },
      },
      ctx,
    );
    await harness.commit(async (tx) => {
      const s = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(s);
      s.topics!["topic-archive-1"] = {
        id: "topic-archive-1",
        conversationId: 1,
        title: "主对话归档 · 2026-11-23",
        createdAt: 1000,
        updatedAt: 2000,
        archived: true,
        archivedFromRoot: true,
      };
      s.topics!.root!.conversationId = Number(newRootConv.id);
      s.conversationToTopic!["1"] = "topic-archive-1";
      s.conversationToTopic![String(newRootConv.id)] = "root";
    }, ctx);

    // Turn 1: KuloWorkingMemoryDoc is EMPTY at start.
    await (await newRootConv.submit({ type: "input", content: "新主对话的第一轮消息" }, ctx)).wait(ctx);
    await newRootConv.waitForIdle(ctx);

    // Archive flush completes asynchronously and commits a new global working memory record BEFORE Turn 2!
    const today = formatLocalDate(Date.now());
    await commitWorkingMemory(
      harness,
      (x) => x,
      (doc) => {
        upsertWorkingMemoryRecord(doc, {
          id: "flush:archive-global-1",
          bucketId: "global",
          category: "decision",
          evidenceLevel: "user_decision",
          status: "active",
          date: today,
          summary: "用户偏好所有结论附带风险提示",
          fingerprint: computeMemoryFingerprint("decision", "用户偏好所有结论附带风险提示"),
          provenance: { conversationId: 1, topicId: "topic-archive-1", entryId: 1, sourceRole: "user" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      },
      ctx,
    );

    // Turn 2: Turn 1 prefix & initial system prompt MUST stay byte-for-byte identical; new working memory arrives append-only!
    await (await newRootConv.submit({ type: "input", content: "新主对话的第二轮消息" }, ctx)).wait(ctx);
    await newRootConv.waitForIdle(ctx);

    expect(capturedRequests).toHaveLength(2);
    const turn1Messages = capturedRequests[0]!.messages;
    const turn2Messages = capturedRequests[1]!.messages;
    expect(turn2Messages.slice(0, turn1Messages.length)).toEqual(turn1Messages);
    expect(JSON.stringify(turn2Messages.slice(turn1Messages.length))).toContain("用户偏好所有结论附带风险提示");
    const wire0 = collapseSystemMessages(capturedRequests[0]!);
    const wire1 = collapseSystemMessages(capturedRequests[1]!);
    expect(getInitialSystemMessage(wire1.messages)).toEqual(getInitialSystemMessage(wire0.messages));
  });
});
