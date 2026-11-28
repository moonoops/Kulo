import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  LiveDoc,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type Extension,
  type Harness,
  type JsonObject,
  type ModelRef,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  SIDE_QUESTION_MAX_USER_TURNS,
  SIDE_QUESTION_QUESTION_MAX_CHARS,
  SIDE_QUESTION_QUOTE_MAX_CHARS,
  SIDE_QUESTION_TITLE_MAX_CHARS,
  SIDE_QUESTION_TTL_MS,
  redactDeviceInvitationText,
  type SideQuestionCloseResponse,
  type SideQuestionCreateRequest,
  type SideQuestionMessageRequest,
  type SideQuestionRecord,
  type SideQuestionStatus,
  type SideQuestionView,
} from "@kulo/protocol";
import { queuedChatEntries } from "./chat-submissions.js";
import { redactCredentialData } from "./credential-redaction.js";
import { extractDisplayMessages, extractLiveState } from "./hub-display-projection.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import {
  SideQuestionError,
  SideQuestionsDoc,
  abortSideQuestionConversations,
  buildSideQuestionSystemPrompt,
  findSafeForkBoundary,
  offlineSideQuestionsInTx,
  pruneExpiredInDoc,
  pruneRetainedClosedRecords,
  sanitizeSideQuestionText,
  selectSafeForkBoundaryFromDescending,
  type SafeForkScanState,
  type SideQuestionsDocState,
} from "./side-question-store.js";
import { KuloStateDoc } from "./state.js";
import { KuloUserEntry } from "./ui-cards.js";

export {
  SideQuestionError,
  SideQuestionsDoc,
  abortSideQuestionConversations,
  buildSideQuestionSystemPrompt,
  findSafeForkBoundary,
  offlineSideQuestionsInTx,
  sanitizeSideQuestionText,
  selectSafeForkBoundaryFromDescending,
  type SafeForkScanState,
  type SideQuestionsDocState,
};

const SIDE_ENTRIES_PAGE_SIZE = 64;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60_000;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface SideQuestionServiceDeps {
  harness: Harness;
  runtimeGates: Pick<
    HubRuntimeGates,
    "isClosed" | "isRecovering" | "isHandoverBarrierActive" | "resumeIfNotRecovering"
  >;
  redactionExt: Extension;
  isArchivingRoot: () => boolean;
  resolveOrchestratorAgent: () => { model?: ModelRef; thinkingLevel?: ModelThinkingLevel };
  redact: (text: string) => string;
  now?: () => number;
  cleanupIntervalMs?: number;
}

export class SideQuestionService {
  readonly #deps: SideQuestionServiceDeps;
  readonly #topicQueues = new Map<string, Promise<unknown>>();
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SideQuestionServiceDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #assertRuntimeReady(): void {
    if (
      this.#deps.runtimeGates.isClosed() ||
      this.#deps.runtimeGates.isRecovering() ||
      this.#deps.runtimeGates.isHandoverBarrierActive()
    ) {
      throw new SideQuestionError(503, "hub_unavailable", "中枢当前不可操作支线提问，请稍后重试。");
    }
  }

  #withTopicLock<T>(topicId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#topicQueues.get(topicId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tracked = next.catch(() => undefined).finally(() => {
      if (this.#topicQueues.get(topicId) === tracked) {
        this.#topicQueues.delete(topicId);
      }
    });
    this.#topicQueues.set(topicId, tracked);
    return next;
  }

  async start(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.pruneExpired(context);
    if (this.#cleanupTimer || this.#deps.runtimeGates.isClosed()) return;
    const intervalMs = this.#deps.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.#cleanupTimer = setInterval(() => {
      if (this.#deps.runtimeGates.isClosed() || this.#deps.runtimeGates.isHandoverBarrierActive()) return;
      void this.pruneExpired(BACKGROUND_CONTEXT).catch((error) => {
        console.warn("[KuloSideQuestions] Periodic TTL cleanup failed", error);
      });
    }, intervalMs);
    this.#cleanupTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    await Promise.allSettled([...this.#topicQueues.values()]);
  }

  /**
   * Called on failover or crash-loop boot before `harness.resume()`:
   * marks every active side question `interrupted`, clears `activeByTopic`,
   * and aborts their conversations so no stale side-question runs resume.
   */
  async interruptActiveOnFailover(context: Context = BACKGROUND_CONTEXT): Promise<number> {
    const now = this.#now();
    const safeReason = sanitizeSideQuestionText("主备切换或异常重启，支线已中止", this.#deps.redact, 120);
    const toAbort = await this.#deps.harness.commit(async (tx) => {
      const doc = await tx.doc(SideQuestionsDoc);
      doc.activeByTopic ??= {};
      doc.records ??= {};
      const ids: number[] = [];
      for (const rec of Object.values(doc.records)) {
        if (rec.status !== "active") continue;
        rec.status = "interrupted";
        rec.closedAt = now;
        rec.updatedAt = now;
        rec.closedReason = safeReason;
        ids.push(rec.conversationId);
      }
      doc.activeByTopic = {};
      pruneRetainedClosedRecords(doc);
      return ids;
    }, context);
    await abortSideQuestionConversations(this.#deps.harness, toAbort, context);
    return toAbort.length;
  }

  /**
   * Offline/hide/abort expired (>24h) side questions and prune them from `SideQuestionsDoc`.
   * Returns the count of expired active side questions taken offline.
   */
  async pruneExpired(context: Context = BACKGROUND_CONTEXT): Promise<{ expiredCount: number; abortedConversationIds: number[] }> {
    const now = this.#now();
    const snapshot = await this.#deps.harness.snapshot(SideQuestionsDoc, context);
    if (!snapshot) return { expiredCount: 0, abortedConversationIds: [] };
    const hasExpired = Object.values(snapshot.records ?? {}).some((rec) => rec && now >= rec.expiresAt);
    const hasDanglingActive = Object.entries(snapshot.activeByTopic ?? {}).some(([, id]) => {
      const rec = snapshot.records?.[id];
      return !rec || rec.status !== "active" || now >= rec.expiresAt;
    });
    if (!hasExpired && !hasDanglingActive) {
      return { expiredCount: 0, abortedConversationIds: [] };
    }
    const abortedConversationIds = await this.#deps.harness.commit(async (tx) => {
      const doc = await tx.doc(SideQuestionsDoc);
      return pruneExpiredInDoc(doc, now);
    }, context);
    if (abortedConversationIds.length > 0) {
      await abortSideQuestionConversations(this.#deps.harness, abortedConversationIds, context);
    }
    return { expiredCount: abortedConversationIds.length, abortedConversationIds };
  }

  async createSideQuestion(
    parentTopicIdRaw: string,
    input: SideQuestionCreateRequest = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SideQuestionView> {
    this.#assertRuntimeReady();
    const parentTopicId = parentTopicIdRaw.trim();
    if (!parentTopicId) {
      throw new SideQuestionError(400, "invalid_topic_id", "请提供有效的父话题 ID。");
    }
    if (parentTopicId === "root" && this.#deps.isArchivingRoot()) {
      throw new SideQuestionError(409, "main_archive_in_progress", "主对话正在归档，请稍后再发起支线提问。");
    }

    const question = typeof input.question === "string" ? input.question.trim() : "";
    if (question.length > SIDE_QUESTION_QUESTION_MAX_CHARS) {
      throw new SideQuestionError(400, "question_too_long", "支线提问内容过长，请精简后再试。");
    }
    if (
      input.sourceMessageId !== undefined &&
      (!Number.isSafeInteger(input.sourceMessageId) || input.sourceMessageId < 1)
    ) {
      throw new SideQuestionError(400, "invalid_source_message", "引用的消息编号无效。");
    }
    if (
      input.expectedParentConversationId !== undefined &&
      (!Number.isSafeInteger(input.expectedParentConversationId) || input.expectedParentConversationId < 1)
    ) {
      throw new SideQuestionError(400, "invalid_parent_conversation", "父会话编号无效。");
    }

    return this.#withTopicLock(parentTopicId, async () => {
      this.#assertRuntimeReady();
      if (parentTopicId === "root" && this.#deps.isArchivingRoot()) {
        throw new SideQuestionError(409, "main_archive_in_progress", "主对话正在归档，请稍后再发起支线提问。");
      }

      const stateSnap = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const topic = stateSnap?.topics && Object.hasOwn(stateSnap.topics, parentTopicId)
        ? stateSnap.topics[parentTopicId]
        : undefined;
      if (!topic || topic.deletedAt !== undefined) {
        throw new SideQuestionError(404, "topic_not_found", "父话题不存在或已删除。");
      }
      if (topic.archived && !topic.master) {
        throw new SideQuestionError(409, "topic_archived", "父话题已归档，请还原后再发起支线提问。");
      }
      if (parentTopicId === "root" && stateSnap?.pendingMainArchiveFinalize) {
        throw new SideQuestionError(409, "main_archive_in_progress", "主对话正在归档，请稍后再发起支线提问。");
      }
      if (
        input.expectedParentConversationId !== undefined &&
        topic.conversationId !== input.expectedParentConversationId
      ) {
        throw new SideQuestionError(409, "parent_conversation_changed", "父会话已更新，请刷新后重试。");
      }

      const parentConv = await this.#deps.harness.conversation(topic.conversationId as ConversationId, context);
      if (!parentConv) {
        throw new SideQuestionError(404, "parent_conversation_missing", "父会话记录不存在。");
      }

      // Reuse parent conversation's effective model config (fallback to active orchestrator config).
      const parentAgent = await parentConv.agent(context);
      const fallbackAgent = this.#deps.resolveOrchestratorAgent();
      const effectiveModel = parentAgent.model ?? fallbackAgent.model;
      const effectiveThinking = parentAgent.model ? parentAgent.thinkingLevel : fallbackAgent.thinkingLevel;
      if (!effectiveModel?.modelId?.trim()) {
        throw new SideQuestionError(400, "model_not_selected", "请先选择供应商和模型，再发起支线提问。");
      }

      // Strictly scan parent conversation's own entries descending — never `first - 1` and never `fork(0)`.
      const safeForkEntryId = await findSafeForkBoundary(parentConv, context);

      const safeQuote = typeof input.quoteSnippet === "string" && input.quoteSnippet.trim()
        ? sanitizeSideQuestionText(input.quoteSnippet, this.#deps.redact, SIDE_QUESTION_QUOTE_MAX_CHARS, {
            preserveNewlines: true,
          })
        : undefined;
      const titleSource =
        (typeof input.title === "string" && input.title.trim()) ||
        question ||
        safeQuote ||
        "支线提问";
      const safeTitle =
        sanitizeSideQuestionText(titleSource, this.#deps.redact, SIDE_QUESTION_TITLE_MAX_CHARS) || "支线提问";

      // Phase 1 zero-tool read-only configuration: only credential redaction extension, empty tools/modelTools.
      const agentChange: AgentChange = {
        model: { provider: effectiveModel.provider, modelId: effectiveModel.modelId },
        ...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
        extensions: [this.#deps.redactionExt],
        tools: [],
        modelTools: [],
        instructions: buildSideQuestionSystemPrompt(safeQuote),
        cwd: null,
        maxTurns: 1,
        compaction: { enabled: false },
      };

      const sideQuestionId = `sq-${randomUUID()}`;
      const now = this.#now();
      let createdRecord: SideQuestionRecord | undefined;
      let previousConvIdToAbort: number | undefined;
      let expiredConvIdsToAbort: number[] = [];

      const init = async (tx: Tx, newConvId: ConversationId) => {
        const liveState = await tx.doc(KuloStateDoc);
        const liveTopic = liveState.topics && Object.hasOwn(liveState.topics, parentTopicId)
          ? liveState.topics[parentTopicId]
          : undefined;
        if (!liveTopic || liveTopic.deletedAt !== undefined) {
          throw new SideQuestionError(404, "topic_not_found", "父话题不存在或已删除。");
        }
        if (liveTopic.archived && !liveTopic.master) {
          throw new SideQuestionError(409, "topic_archived", "父话题已归档，请还原后再发起支线提问。");
        }
        if (parentTopicId === "root" && (this.#deps.isArchivingRoot() || liveState.pendingMainArchiveFinalize)) {
          throw new SideQuestionError(409, "main_archive_in_progress", "主对话正在归档，请稍后再发起支线提问。");
        }
        if (liveTopic.conversationId !== topic.conversationId) {
          throw new SideQuestionError(409, "parent_conversation_changed", "父会话已更新，请刷新后重试。");
        }

        const doc = await tx.doc(SideQuestionsDoc);
        doc.activeByTopic ??= {};
        doc.records ??= {};
        expiredConvIdsToAbort = pruneExpiredInDoc(doc, now);

        // Single active side question per parent topic: auto-close previous active side question.
        const prevId = doc.activeByTopic[parentTopicId];
        if (prevId) {
          const prev = doc.records[prevId];
          if (prev && prev.status === "active") {
            prev.status = "closed";
            prev.closedAt = now;
            prev.updatedAt = now;
            prev.closedReason = sanitizeSideQuestionText("已开启新支线", this.#deps.redact, 120);
            previousConvIdToAbort = prev.conversationId;
          }
          delete doc.activeByTopic[parentTopicId];
        }

        const record: SideQuestionRecord = {
          id: sideQuestionId,
          parentTopicId,
          parentConversationId: topic.conversationId,
          conversationId: Number(newConvId),
          ...(safeForkEntryId !== undefined ? { forkedAtEntryId: Number(safeForkEntryId) } : {}),
          title: safeTitle,
          ...(safeQuote ? { quoteSnippet: safeQuote } : {}),
          ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
          status: "active",
          userTurnCount: 0,
          maxUserTurns: SIDE_QUESTION_MAX_USER_TURNS,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + SIDE_QUESTION_TTL_MS,
        };
        doc.records[sideQuestionId] = record;
        doc.activeByTopic[parentTopicId] = sideQuestionId;
        pruneRetainedClosedRecords(doc);
        createdRecord = cloneJson(record);
      };

      const sideConv = safeForkEntryId !== undefined
        ? await parentConv.fork(
            safeForkEntryId,
            { ownership: { kind: "ownerless" }, agent: agentChange, init },
            context,
          )
        : await this.#deps.harness.createConversation(
            { ownership: { kind: "ownerless" }, agent: agentChange, init },
            context,
          );

      const toAbort = [
        ...(previousConvIdToAbort !== undefined ? [previousConvIdToAbort] : []),
        ...expiredConvIdsToAbort,
      ];
      if (toAbort.length > 0) {
        await abortSideQuestionConversations(this.#deps.harness, toAbort, context);
      }

      if (question) {
        return this.#submitQuestionLocked(sideQuestionId, sideConv, question, input.requestId, context);
      }
      return this.#buildView(createdRecord!, sideConv, context);
    });
  }

  async getActiveSideQuestion(
    parentTopicIdRaw: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SideQuestionView | null> {
    const parentTopicId = parentTopicIdRaw.trim();
    if (!parentTopicId) {
      throw new SideQuestionError(400, "invalid_topic_id", "请提供有效的父话题 ID。");
    }
    await this.pruneExpired(context);
    const [doc, state] = await Promise.all([
      this.#deps.harness.snapshot(SideQuestionsDoc, context),
      this.#deps.harness.snapshot(KuloStateDoc, context),
    ]);
    const activeId = doc?.activeByTopic?.[parentTopicId];
    if (!activeId) return null;
    const record = doc?.records?.[activeId];
    if (!record || record.status !== "active") return null;

    const topic = state?.topics?.[parentTopicId];
    if (!topic || topic.deletedAt !== undefined || (topic.archived && !topic.master) || topic.conversationId !== record.parentConversationId) {
      const toAbort = await this.#deps.harness.commit(
        (tx) =>
          offlineSideQuestionsInTx(tx, {
            topicId: parentTopicId,
            conversationId: record.parentConversationId,
            reason: "父话题不可用",
            now: this.#now(),
            redact: this.#deps.redact,
          }),
        context,
      );
      await abortSideQuestionConversations(this.#deps.harness, toAbort, context);
      return null;
    }

    const sideConv = await this.#deps.harness.conversation(record.conversationId as ConversationId, context);
    if (!sideConv) return null;
    return this.#buildView(cloneJson(record), sideConv, context);
  }

  async getSideQuestion(
    idRaw: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SideQuestionView> {
    const id = idRaw.trim();
    if (!id) throw new SideQuestionError(400, "invalid_side_question_id", "支线标识无效。");
    await this.pruneExpired(context);
    const doc = await this.#deps.harness.snapshot(SideQuestionsDoc, context);
    const record = doc?.records?.[id];
    if (!record) throw new SideQuestionError(404, "side_question_not_found", "支线提问不存在或已过期下线。");
    const sideConv = await this.#deps.harness.conversation(record.conversationId as ConversationId, context);
    if (!sideConv) throw new SideQuestionError(404, "side_question_conversation_missing", "支线对话记录不存在。");
    return this.#buildView(cloneJson(record), sideConv, context);
  }

  async sendMessage(
    idRaw: string,
    input: SideQuestionMessageRequest,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SideQuestionView> {
    this.#assertRuntimeReady();
    const id = idRaw.trim();
    if (!id) throw new SideQuestionError(400, "invalid_side_question_id", "支线标识无效。");
    const question = typeof input?.question === "string" ? input.question.trim() : "";
    if (!question) {
      throw new SideQuestionError(400, "empty_question", "请输入支线提问内容。");
    }
    if (question.length > SIDE_QUESTION_QUESTION_MAX_CHARS) {
      throw new SideQuestionError(400, "question_too_long", "支线提问内容过长，请精简后再试。");
    }

    const initialDoc = await this.#deps.harness.snapshot(SideQuestionsDoc, context);
    const initialRec = initialDoc?.records?.[id];
    if (!initialRec) {
      throw new SideQuestionError(404, "side_question_not_found", "支线提问不存在或已过期下线。");
    }

    return this.#withTopicLock(initialRec.parentTopicId, async () => {
      this.#assertRuntimeReady();
      const sideConv = await this.#deps.harness.conversation(initialRec.conversationId as ConversationId, context);
      if (!sideConv) {
        throw new SideQuestionError(404, "side_question_conversation_missing", "支线对话记录不存在。");
      }
      return this.#submitQuestionLocked(id, sideConv, question, input.requestId, context);
    });
  }

  async closeSideQuestion(
    idRaw: string,
    context: Context = BACKGROUND_CONTEXT,
    reason = "用户关闭支线",
  ): Promise<SideQuestionCloseResponse> {
    const id = idRaw.trim();
    if (!id) throw new SideQuestionError(400, "invalid_side_question_id", "支线标识无效。");
    const initialDoc = await this.#deps.harness.snapshot(SideQuestionsDoc, context);
    const initialRec = initialDoc?.records?.[id];
    if (!initialRec) {
      return { closed: true, id, status: "expired" };
    }

    return this.#withTopicLock(initialRec.parentTopicId, async () => {
      const now = this.#now();
      const safeReason = sanitizeSideQuestionText(reason, this.#deps.redact, 120);
      const { status, convIdToAbort } = await this.#deps.harness.commit(async (tx) => {
        const doc = await tx.doc(SideQuestionsDoc);
        doc.activeByTopic ??= {};
        doc.records ??= {};
        const rec = doc.records[id];
        if (!rec) return { status: "expired" as SideQuestionStatus, convIdToAbort: undefined };
        if (doc.activeByTopic[rec.parentTopicId] === id) {
          delete doc.activeByTopic[rec.parentTopicId];
        }
        if (rec.status !== "active") {
          return { status: rec.status, convIdToAbort: rec.conversationId };
        }
        rec.status = "closed";
        rec.closedAt = now;
        rec.updatedAt = now;
        rec.closedReason = safeReason;
        pruneRetainedClosedRecords(doc);
        return { status: "closed" as SideQuestionStatus, convIdToAbort: rec.conversationId };
      }, context);

      if (convIdToAbort !== undefined) {
        await abortSideQuestionConversations(this.#deps.harness, [convIdToAbort], context);
      }
      return { closed: true, id, status };
    });
  }

  async #submitQuestionLocked(
    sideQuestionId: string,
    sideConv: Conversation,
    rawQuestion: string,
    requestId: string | undefined,
    context: Context,
  ): Promise<SideQuestionView> {
    const cleanReqId = requestId?.trim() || undefined;
    const now = this.#now();
    const safeQuestionText = redactDeviceInvitationText(rawQuestion);
    const displayEntry = {
      kind: KuloUserEntry.kind,
      data: {
        kuloContentVersion: 1,
        text: safeQuestionText,
        attachments: [],
        ...(cleanReqId ? { requestId: cleanReqId } : {}),
        createdAt: now,
      } as unknown as JsonObject,
    };

    let expiredConvIdsToAbort: number[] = [];
    let parentGoneConvIdToAbort: number | undefined;
    let failureError: SideQuestionError | undefined;

    const committedRecord = await this.#deps.harness.commit(async (tx) => {
      const existingSubmission = cleanReqId
        ? await tx.submissionByRequest(sideConv.id, cleanReqId)
        : undefined;
      const doc = await tx.doc(SideQuestionsDoc);
      const state = await tx.doc(KuloStateDoc);
      doc.activeByTopic ??= {};
      doc.records ??= {};

      const rec = doc.records[sideQuestionId];
      if (!rec) {
        failureError = new SideQuestionError(404, "side_question_not_found", "支线提问不存在或已过期下线。");
        return undefined;
      }
      if (now >= rec.expiresAt) {
        expiredConvIdsToAbort = pruneExpiredInDoc(doc, now);
        failureError = new SideQuestionError(
          410,
          "side_question_expired",
          "支线提问已超过 24 小时并自动下线，请发起新的支线提问。",
        );
        return undefined;
      }
      if (rec.status !== "active") {
        failureError = new SideQuestionError(409, "side_question_closed", "该支线提问已结束，请发起新的支线提问。");
        return undefined;
      }

      const parentTopic = state.topics?.[rec.parentTopicId];
      if (
        !parentTopic ||
        parentTopic.deletedAt !== undefined ||
        (parentTopic.archived && !parentTopic.master) ||
        parentTopic.conversationId !== rec.parentConversationId
      ) {
        rec.status = "closed";
        rec.closedAt = now;
        rec.updatedAt = now;
        rec.closedReason = sanitizeSideQuestionText("父话题已归档或删除", this.#deps.redact, 120);
        if (doc.activeByTopic[rec.parentTopicId] === rec.id) {
          delete doc.activeByTopic[rec.parentTopicId];
        }
        parentGoneConvIdToAbort = rec.conversationId;
        failureError = new SideQuestionError(
          409,
          "parent_topic_unavailable",
          "父话题已归档或删除，关联支线已自动下线。",
        );
        return undefined;
      }

      if (existingSubmission) {
        return cloneJson(rec);
      }

      if (rec.userTurnCount >= rec.maxUserTurns) {
        failureError = new SideQuestionError(
          409,
          "side_question_turn_limit_reached",
          `当前支线已达到 ${rec.maxUserTurns} 轮追问上限，请关闭后发起新的支线提问，或将结论插入主输入框继续讨论。`,
        );
        return undefined;
      }

      await sideConv.submit(tx, {
        type: "input",
        content: safeQuestionText,
        whenBusy: "followUp",
        entry: displayEntry,
        ...(cleanReqId ? { requestId: cleanReqId } : {}),
      });

      rec.userTurnCount += 1;
      rec.updatedAt = now;
      rec.expiresAt = now + SIDE_QUESTION_TTL_MS;
      return cloneJson(rec);
    }, context);

    const toAbort = [
      ...expiredConvIdsToAbort,
      ...(parentGoneConvIdToAbort !== undefined ? [parentGoneConvIdToAbort] : []),
    ];
    if (toAbort.length > 0) {
      await abortSideQuestionConversations(this.#deps.harness, toAbort, context);
    }
    if (failureError) {
      throw failureError;
    }

    this.#deps.runtimeGates.resumeIfNotRecovering();
    return this.#buildView(committedRecord!, sideConv, context);
  }

  async #readOwnEntriesAscending(
    record: Readonly<SideQuestionRecord>,
    sideConv: Conversation,
    context: Context,
  ): Promise<EntryRecord[]> {
    const collected: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
      const page = await sideConv.entries({ order: "descending" }, SIDE_ENTRIES_PAGE_SIZE, cursor, context);
      if (page.items.length === 0) break;
      let crossedForkBoundary = false;
      for (const entry of page.items) {
        if (Number(entry.conversationId) !== record.conversationId) {
          crossedForkBoundary = true;
          break;
        }
        collected.push(entry);
      }
      if (crossedForkBoundary || !page.next) break;
      cursor = page.next;
    }
    return collected.reverse();
  }

  async #buildView(
    record: SideQuestionRecord,
    sideConv: Conversation,
    context: Context,
  ): Promise<SideQuestionView> {
    const [liveDoc, inboxDoc, ownEntries] = await Promise.all([
      this.#deps.harness.snapshot(LiveDoc, sideConv.id, context),
      this.#deps.harness.snapshot(InboxDoc, sideConv.id, context),
      this.#readOwnEntriesAscending(record, sideConv, context),
    ]);

    const syntheticView = {
      conversation: { id: sideConv.id },
      conversationId: sideConv.id,
      entries: ownEntries,
      docs: {
        ...(liveDoc ? { "pi.live": liveDoc } : {}),
        ...(inboxDoc ? { "pi.inbox": inboxDoc } : {}),
      },
    } as unknown as ConversationView;

    const queued = queuedChatEntries(syntheticView);
    const displayOptions = { redactToolText: this.#deps.redact };
    const committedMessages = extractDisplayMessages(ownEntries, displayOptions);
    const queuedMessages = extractDisplayMessages(queued.entries, displayOptions).map((item) => {
      const delivery = queued.deliveries.get(item.id);
      return delivery ? { ...item, ...delivery } : item;
    });
    const messages = redactCredentialData(
      [...committedMessages, ...queuedMessages],
      this.#deps.redact,
    );
    const live = redactCredentialData(extractLiveState(syntheticView, ownEntries), this.#deps.redact);
    const remainingTurns = Math.max(0, record.maxUserTurns - record.userTurnCount);

    return {
      record: redactCredentialData(cloneJson(record), this.#deps.redact),
      messages,
      live,
      remainingTurns,
      limitReached: remainingTurns === 0,
    };
  }
}
