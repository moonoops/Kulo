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
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import {
  SIDE_QUESTION_MAX_USER_TURNS,
  SIDE_QUESTION_TTL_MS,
  formatSideQuestionInsertDraft,
  parseBtwCommand,
} from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import {
  SideQuestionError,
  SideQuestionService,
  SideQuestionsDoc,
  findSafeForkBoundary,
  selectSafeForkBoundaryFromDescending,
} from "../packages/hub/src/side-questions.js";
import { KuloStateDoc, isOrchestratorConversation } from "../packages/hub/src/state.js";
import { KuloWorkingMemoryDoc } from "../packages/hub/src/working-memory.js";
import { openTestHub } from "./helpers/secure-hub.js";

const ctx = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function makeTempDir(prefix = "kulo-side-questions-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeModelsWithReplies(replies: string[], capturedRequests?: TranscriptContext[]) {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "test-model" }] });
  let idx = 0;
  provider.setResponses(
    Array.from({ length: Math.max(replies.length + 24, 32) }, () => (context: TranscriptContext) => {
      const systemText = context.messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      if (systemText.includes("working-memory ledger entries")) {
        return fauxAssistantMessage([fauxText("{\"items\":[]}")]);
      }
      if (capturedRequests) {
        capturedRequests.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
      }
      const reply = replies[idx] ?? `回复#${idx + 1}`;
      idx += 1;
      return fauxAssistantMessage([fauxText(reply)]);
    }),
  );
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function makeEntry(partial: {
  id: number;
  conversationId?: number;
  kind: string;
  model?: unknown[];
}): EntryRecord {
  return {
    id: partial.id as EntryId,
    conversationId: (partial.conversationId ?? 1) as ConversationId,
    kind: partial.kind,
    data: {},
    ...(partial.model ? { model: partial.model } : {}),
  } as unknown as EntryRecord;
}

describe("Stage 3 P1-1 Side Question (/btw) protocol & boundary helpers", () => {
  it("parses /btw commands cleanly and formats non-auto-sent main composer drafts", () => {
    expect(parseBtwCommand("/btw 这个公式怎么推导？")).toEqual({ matched: true, question: "这个公式怎么推导？" });
    expect(parseBtwCommand("  /BTW\t解释一下")).toEqual({ matched: true, question: "解释一下" });
    expect(parseBtwCommand("/btw ")).toEqual({ matched: true, question: "" });
    expect(parseBtwCommand("/btw")).toEqual({ matched: true, question: "" });
    expect(parseBtwCommand("/btwfoo bar")).toEqual({ matched: false });
    expect(parseBtwCommand("hello /btw world")).toEqual({ matched: false });

    expect(formatSideQuestionInsertDraft("结论第一行\n结论第二行")).toBe(
      "> 结论第一行\n> 结论第二行\n\n",
    );
    expect(formatSideQuestionInsertDraft("简短结论", "我原本的草稿")).toBe(
      "我原本的草稿\n\n> 简短结论\n\n",
    );
  });

  it("skips unclosed toolUse, partial ToolResultEntry, and aborted/error entries; never returns 0", () => {
    const user10 = makeEntry({ id: 10, kind: UserEntry.kind, model: [{ role: "user", content: "hi" }] });
    const stop11 = makeEntry({
      id: 11,
      kind: AssistantEntry.kind,
      model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }],
    });
    const unclosedToolUse12 = makeEntry({
      id: 12,
      kind: AssistantEntry.kind,
      model: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
            { type: "toolCall", id: "call-2", name: "bash", arguments: {} },
          ],
        },
      ],
    });
    const partialResult13 = makeEntry({
      id: 13,
      kind: ToolResultEntry.kind,
      model: [{ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "r1" }] }],
    });
    const secondResult14 = makeEntry({
      id: 14,
      kind: ToolResultEntry.kind,
      model: [{ role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "r2" }] }],
    });
    const aborted15 = makeEntry({
      id: 15,
      kind: AssistantEntry.kind,
      model: [{ role: "assistant", stopReason: "aborted", content: [] }],
    });

    // Unclosed toolUse -> skips to prior complete turn (11).
    expect(selectSafeForkBoundaryFromDescending([unclosedToolUse12, stop11, user10])).toBe(11);
    // Partial ToolResultEntry (only call-1 closed, call-2 missing) -> skips both 13 & 12, returns 11.
    expect(selectSafeForkBoundaryFromDescending([partialResult13, unclosedToolUse12, stop11, user10])).toBe(11);
    // Fully closed tool round (call-1 & call-2 both have ToolResultEntry) -> accepts trailing result 14.
    expect(
      selectSafeForkBoundaryFromDescending([secondResult14, partialResult13, unclosedToolUse12, stop11, user10]),
    ).toBe(14);
    // Trailing aborted assistant entry skipped -> lands on 11.
    expect(selectSafeForkBoundaryFromDescending([aborted15, stop11, user10])).toBe(11);
    // Only non-model system entry or empty list -> undefined (never 0).
    expect(selectSafeForkBoundaryFromDescending([])).toBeUndefined();
    expect(
      selectSafeForkBoundaryFromDescending([makeEntry({ id: 1, kind: "pi.system" })]),
    ).toBeUndefined();
  });
});

describe("Stage 3 P1-1 Side Question (/btw) Hub integration", () => {
  it("1. forks safely across interleaved conversations, enforces zero tools, and isolates main chat & working memory", async () => {
    const stateDir = makeTempDir();
    const captured: TranscriptContext[] = [];
    const { models } = makeModelsWithReplies(
      ["主对话答复A", "话题B答复", "主对话答复B", "话题B答复2", "支线纯只读回答"],
      captured,
    );
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const topicB = await hub.createTopic("并行话题B", ctx);

    // Interleave turns across root and topicB so global entries.id interleaves across conversations.
    await hub.sendUserMessage("主对话问题A", { topicId: "root" }, ctx);
    await waitFor(async () => {
      const view = await hub.getTopicView("root", ctx);
      return !view.live.busy && view.messages.some((m) => m.text.includes("主对话答复A"));
    });

    await hub.sendUserMessage("话题B问题1", { topicId: topicB.id }, ctx);
    await waitFor(async () => {
      const view = await hub.getTopicView(topicB.id, ctx);
      return !view.live.busy && view.messages.some((m) => m.text.includes("话题B答复"));
    });

    await hub.sendUserMessage("主对话问题B", { topicId: "root" }, ctx);
    await waitFor(async () => {
      const view = await hub.getTopicView("root", ctx);
      return !view.live.busy && view.messages.some((m) => m.text.includes("主对话答复B"));
    });

    await hub.sendUserMessage("话题B问题2", { topicId: topicB.id }, ctx);
    await waitFor(async () => {
      const view = await hub.getTopicView(topicB.id, ctx);
      return !view.live.busy && view.messages.some((m) => m.text.includes("话题B答复2"));
    });

    // Append an unclosed toolUse entry to root so we also verify skipping unclosed toolUse in real storage!
    const rootBeforeBoundary = await findSafeForkBoundary(hub.rootConversation, ctx);
    expect(rootBeforeBoundary).toBeDefined();
    await hub.harness.commit(async (tx) => {
      await tx.appendEntry(hub.rootConversation.id, {
        kind: AssistantEntry.kind,
        data: {},
        model: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "test-model",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: Date.now(),
            content: [{ type: "toolCall", id: "unclosed-call-1", name: "read", arguments: {} }],
          },
        ],
      });
    }, ctx);

    const rootMessagesBefore = (await hub.getTopicView("root", ctx)).messages.length;
    const wmBefore = await hub.harness.snapshot(KuloWorkingMemoryDoc, ctx);

    // Create side question on root — must skip unclosed toolUse AND resolve interleaved EntryId cleanly.
    const created = await hub.sideQuestions.createSideQuestion(
      "root",
      {
        question: "用一句话总结主对话问题B",
        quoteSnippet: "主对话答复B",
      },
      ctx,
    );
    expect(created.record.forkedAtEntryId).toBe(Number(rootBeforeBoundary));
    expect(created.record.parentTopicId).toBe("root");
    expect(created.record.userTurnCount).toBe(1);
    expect(created.remainingTurns).toBe(SIDE_QUESTION_MAX_USER_TURNS - 1);

    const completed = await waitFor(async () => {
      const view = await hub.sideQuestions.getActiveSideQuestion("root", ctx);
      if (!view || view.live.busy) return null;
      return view.messages.some((m) => m.role === "assistant" && m.text.includes("支线纯只读回答")) ? view : null;
    });
    expect(completed.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(completed.messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    // Verify zero tools on both Conversation.agent() and the model request transcript!
    const sideConv = await hub.harness.conversation(created.record.conversationId as ConversationId, ctx);
    expect(sideConv).toBeDefined();
    const sideAgent = await sideConv!.agent(ctx);
    expect(sideAgent.tools).toEqual([]);
    expect(sideAgent.modelTools ?? []).toEqual([]);
    expect(sideAgent.maxTurns).toBe(1);
    expect(sideAgent.cwd).toBeUndefined();

    const sideModelReq = captured[captured.length - 1]!;
    expect(getCurrentTools(sideModelReq.messages)).toEqual([]);
    const systemPromptText = getCurrentSystemPrompt(sideModelReq.messages);
    expect(systemPromptText).toContain("Zero tools are available");
    expect(systemPromptText).toContain("主对话答复B");
    // Inherited parent conversation text is visible to the side-question model:
    expect(JSON.stringify(sideModelReq.messages)).toContain("主对话问题B");

    // Strict isolation: not an orchestrator conversation, never registered in topics, never writes parent chat or working memory.
    const stateSnap = await hub.harness.snapshot(KuloStateDoc, ctx);
    expect(isOrchestratorConversation(sideConv!.id, stateSnap)).toBe(false);
    expect(stateSnap?.conversationToTopic?.[String(created.record.conversationId)]).toBeUndefined();
    expect((await hub.getTopicView("root", ctx)).messages.length).toBe(rootMessagesBefore);
    expect(await hub.harness.snapshot(KuloWorkingMemoryDoc, ctx)).toEqual(wmBefore);
  });

  it("2. creates a blank read-only side question without calling fork(0) when parent conversation is empty", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["空白父会话支线回复"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const emptyTopic = await hub.createTopic("全新空话题", ctx);
    const parentConv = await hub.harness.conversation(emptyTopic.conversationId as ConversationId, ctx);
    expect(await findSafeForkBoundary(parentConv!, ctx)).toBeUndefined();

    const created = await hub.sideQuestions.createSideQuestion(
      emptyTopic.id,
      { quoteSnippet: "外部引文片段", question: "这段引文是什么意思？" },
      ctx,
    );
    expect(created.record.forkedAtEntryId).toBeUndefined();
    expect(created.record.quoteSnippet).toBe("外部引文片段");

    const completed = await waitFor(async () => {
      const view = await hub.sideQuestions.getActiveSideQuestion(emptyTopic.id, ctx);
      if (!view || view.live.busy) return null;
      return view.messages.some((m) => m.text.includes("空白父会话支线回复")) ? view : null;
    });
    expect(completed.messages.some((m) => m.text.includes("空白父会话支线回复"))).toBe(true);
  });

  it("3. enforces single active side question per topic, 12-turn limit, and idempotent requestId", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(Array.from({ length: 20 }, (_, i) => `答复-${i + 1}`));
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const sq1 = await hub.sideQuestions.createSideQuestion("root", { title: "支线1" }, ctx);
    const sq2 = await hub.sideQuestions.createSideQuestion("root", { title: "支线2" }, ctx);
    expect(sq2.record.id).not.toBe(sq1.record.id);

    const active = await hub.sideQuestions.getActiveSideQuestion("root", ctx);
    expect(active?.record.id).toBe(sq2.record.id);

    const docAfterReplace = await hub.harness.snapshot(SideQuestionsDoc, ctx);
    expect(docAfterReplace?.records[sq1.record.id]?.status).toBe("closed");
    expect(docAfterReplace?.activeByTopic.root).toBe(sq2.record.id);

    // Send 12 turns on sq2 (including one duplicate requestId retry that must NOT double-count).
    for (let turn = 1; turn <= SIDE_QUESTION_MAX_USER_TURNS; turn++) {
      const reqId = `turn-${turn}`;
      const view = await hub.sideQuestions.sendMessage(sq2.record.id, { question: `追问 #${turn}`, requestId: reqId }, ctx);
      expect(view.record.userTurnCount).toBe(turn);
      if (turn === 1) {
        const dup = await hub.sideQuestions.sendMessage(sq2.record.id, { question: `追问 #${turn}`, requestId: reqId }, ctx);
        expect(dup.record.userTurnCount).toBe(1);
      }
    }

    const atLimit = await hub.sideQuestions.getSideQuestion(sq2.record.id, ctx);
    expect(atLimit.remainingTurns).toBe(0);
    expect(atLimit.limitReached).toBe(true);

    // 13th turn must be rejected with 409 side_question_turn_limit_reached.
    await expect(
      hub.sideQuestions.sendMessage(sq2.record.id, { question: "第13轮超限追问", requestId: "turn-13" }, ctx),
    ).rejects.toMatchObject({
      status: 409,
      code: "side_question_turn_limit_reached",
    });
  });

  it("4. enforces 24h TTL offline cleanup and removes expired records from SideQuestionsDoc", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["TTL 回复"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    let fakeNow = 1_770_000_000_000;
    const redactionExt = { name: "test-noop-redaction" };
    const timedService = new SideQuestionService({
      harness: hub.harness,
      runtimeGates: {
        isClosed: () => false,
        isRecovering: () => false,
        isHandoverBarrierActive: () => false,
        resumeIfNotRecovering: () => hub.harness.resume(),
      },
      redactionExt,
      isArchivingRoot: () => false,
      resolveOrchestratorAgent: () => ({
        model: { provider: "openai", modelId: "test-model" },
        thinkingLevel: "off",
      }),
      redact: (text) => hub.connectionManager.redact(text),
      now: () => fakeNow,
    });

    const created = await timedService.createSideQuestion("root", { title: "24h 测试支线" }, ctx);
    expect(created.record.expiresAt).toBe(fakeNow + SIDE_QUESTION_TTL_MS);

    // 1 second before TTL expiry -> still active.
    fakeNow += SIDE_QUESTION_TTL_MS - 1_000;
    expect((await timedService.getActiveSideQuestion("root", ctx))?.record.id).toBe(created.record.id);

    // Past 24h -> sending fails with 410 side_question_expired and removes it from active index & records.
    fakeNow += 2_000;
    await expect(
      timedService.sendMessage(created.record.id, { question: "过期后追问" }, ctx),
    ).rejects.toMatchObject({
      status: 410,
      code: "side_question_expired",
    });

    const docAfterExpiry = await hub.harness.snapshot(SideQuestionsDoc, ctx);
    expect(docAfterExpiry?.activeByTopic.root).toBeUndefined();
    expect(docAfterExpiry?.records[created.record.id]).toBeUndefined();
    expect(await timedService.getActiveSideQuestion("root", ctx)).toBeNull();
  });

  it("5. handles lifecycle closure: root archive rejection & offline, topic archive/delete offline, and failover interrupt", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["主对话内容", "话题内容"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    // Reject creating root side question while root archive is in progress.
    let archivingRoot = true;
    const gatedService = new SideQuestionService({
      harness: hub.harness,
      runtimeGates: {
        isClosed: () => false,
        isRecovering: () => false,
        isHandoverBarrierActive: () => false,
        resumeIfNotRecovering: () => hub.harness.resume(),
      },
      redactionExt: { name: "test-noop" },
      isArchivingRoot: () => archivingRoot,
      resolveOrchestratorAgent: () => ({ model: { provider: "openai", modelId: "test-model" }, thinkingLevel: "off" }),
      redact: (text) => hub.connectionManager.redact(text),
    });
    await expect(gatedService.createSideQuestion("root", { title: "归档期间" }, ctx)).rejects.toMatchObject({
      status: 409,
      code: "main_archive_in_progress",
    });
    archivingRoot = false;

    // Seed root conversation so archiveMainConversation actually rotates it.
    await hub.sendUserMessage("归档前的主对话消息", { topicId: "root" }, ctx);
    await waitFor(async () => {
      const view = await hub.getTopicView("root", ctx);
      return !view.live.busy && view.messages.some((m) => m.text.includes("主对话内容"));
    });
    const rootSq = await hub.sideQuestions.createSideQuestion("root", { title: "主对话支线" }, ctx);
    const oldRootConvId = Number(hub.rootConversation.id);
    const archiveRes = await hub.archiveMainConversation({ expectedConversationId: oldRootConvId }, ctx);
    expect(archiveRes.archived).toBe(true);
    expect(await hub.sideQuestions.getActiveSideQuestion("root", ctx)).toBeNull();
    expect((await hub.harness.snapshot(SideQuestionsDoc, ctx))?.records[rootSq.record.id]?.status).toBe("closed");

    // Normal topic archive -> offlines its active side question.
    const topicA = await hub.createTopic("归档测试话题", ctx);
    const sqA = await hub.sideQuestions.createSideQuestion(topicA.id, { title: "话题A支线" }, ctx);
    await hub.patchTopic(topicA.id, { archived: true }, ctx);
    expect(await hub.sideQuestions.getActiveSideQuestion(topicA.id, ctx)).toBeNull();
    expect((await hub.harness.snapshot(SideQuestionsDoc, ctx))?.records[sqA.record.id]?.status).toBe("closed");

    // Normal topic delete -> offlines its active side question.
    const topicB = await hub.createTopic("删除测试话题", ctx);
    const sqB = await hub.sideQuestions.createSideQuestion(topicB.id, { title: "话题B支线" }, ctx);
    await hub.deleteTopic(topicB.id, ctx);
    expect(await hub.sideQuestions.getActiveSideQuestion(topicB.id, ctx)).toBeNull();
    expect((await hub.harness.snapshot(SideQuestionsDoc, ctx))?.records[sqB.record.id]?.status).toBe("closed");

    // Failover interrupt -> marks active side questions interrupted and clears activeByTopic.
    const sqFailover = await hub.sideQuestions.createSideQuestion("root", { title: "切换前支线" }, ctx);
    const interruptedCount = await hub.sideQuestions.interruptActiveOnFailover(ctx);
    expect(interruptedCount).toBe(1);
    expect(await hub.sideQuestions.getActiveSideQuestion("root", ctx)).toBeNull();
    expect((await hub.harness.snapshot(SideQuestionsDoc, ctx))?.records[sqFailover.record.id]?.status).toBe("interrupted");
  });

  it("6. redacts sentinel pattern & Vault secrets in quoteSnippet/title with zero documentLeak/SessionFailed", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["安全脱敏回复"]);
    const hub = await openTestHub({
      config: {
        stateDir,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const vaultSentinel = "KULO_VAULT_SENTINEL_SECRET_774411";
    const patternSentinel = "sk-proj-sentinel0123456789abcdefABCDEF012345";
    hub.connectionManager.rememberSecrets([vaultSentinel]);

    // Must commit cleanly through real wrapRedactedStorage without throwing SessionFailed / documentLeak!
    const created = await hub.sideQuestions.createSideQuestion(
      "root",
      {
        title: `排查密钥 ${vaultSentinel} 和 ${patternSentinel}`,
        quoteSnippet: `Authorization: Bearer ${patternSentinel}\nVault=${vaultSentinel}`,
      },
      ctx,
    );

    const rawDoc = await hub.harness.snapshot(SideQuestionsDoc, ctx);
    const serializedDoc = JSON.stringify(rawDoc);
    expect(serializedDoc).not.toContain(vaultSentinel);
    expect(serializedDoc).not.toContain(patternSentinel);
    expect(created.record.title).not.toContain(vaultSentinel);
    expect(created.record.title).not.toContain(patternSentinel);
    expect(created.record.quoteSnippet).not.toContain(vaultSentinel);
    expect(created.record.quoteSnippet).not.toContain(patternSentinel);
  });

  it("7. serves HTTP endpoints end-to-end for create, active, message, and close", async () => {
    const stateDir = makeTempDir();
    const { models } = makeModelsWithReplies(["HTTP支线回复1", "HTTP支线回复2"]);
    const authToken = "test-side-question-token-0123456789";
    const hub = await openTestHub({
      config: {
        stateDir,
        authToken,
        model: { defaultProvider: "openai", defaultModel: "test-model", thinkingLevel: "off" },
      },
      models,
    });
    cleanups.push(() => hub.close().catch(() => {}));

    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close().catch(() => {}));

    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      origin: `http://127.0.0.1:${server.port}`,
    };
    const base = `http://127.0.0.1:${server.port}`;

    // Initially no active side question.
    const emptyActive = await fetch(`${base}/api/topics/root/side-questions/active`, { headers });
    expect(emptyActive.status).toBe(200);
    expect(await emptyActive.json()).toEqual({ sideQuestion: null });

    // POST create side question.
    const createRes = await fetch(`${base}/api/topics/root/side-questions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "第一问", quoteSnippet: "引文片段" }),
    });
    expect(createRes.status).toBe(200);
    const createdBody = (await createRes.json()) as { sideQuestion: { record: { id: string; userTurnCount: number } } };
    const created = createdBody.sideQuestion;
    expect(created.record.userTurnCount).toBe(1);

    // GET active returns the created side question.
    const activeRes = await fetch(`${base}/api/topics/root/side-questions/active`, { headers });
    expect(activeRes.status).toBe(200);
    const activeBody = (await activeRes.json()) as { sideQuestion: { record: { id: string } } | null };
    expect(activeBody.sideQuestion?.record.id).toBe(created.record.id);

    // POST follow-up message.
    const msgRes = await fetch(`${base}/api/side-questions/${encodeURIComponent(created.record.id)}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "第二问" }),
    });
    expect(msgRes.status).toBe(200);
    const afterMsg = ((await msgRes.json()) as { sideQuestion: { record: { userTurnCount: number } } }).sideQuestion;
    expect(afterMsg.record.userTurnCount).toBe(2);

    // DELETE closes and takes offline.
    const delRes = await fetch(`${base}/api/side-questions/${encodeURIComponent(created.record.id)}`, {
      method: "DELETE",
      headers,
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toMatchObject({ closed: true, id: created.record.id, status: "closed" });

    // Subsequent GET active returns null.
    const afterDel = await fetch(`${base}/api/topics/root/side-questions/active`, { headers });
    expect(await afterDel.json()).toEqual({ sideQuestion: null });
  });
});
