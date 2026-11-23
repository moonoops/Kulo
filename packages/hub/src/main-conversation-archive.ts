import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  LiveDoc,
  configure,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Extension,
  type Harness,
  type ModelRef,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  ArchiveMainConversationInput,
  ArchiveMainConversationResult,
  MainArchiveFinalizeRecord,
  MainArchiveFinalizeSteps,
  MainArchiveFlushStatus,
  TopicSummary,
} from "@kulo/protocol";
import { ActionConfirmationsDoc, effectiveConfirmationEffect, type PendingActionConfirmation } from "./action-confirmations.js";
import { PendingChatAttachmentsDoc } from "./chat-attachment-deliveries.js";
import type { KuloConnections } from "./connections.js";
import type { HubContextGuard } from "./context-guard.js";
import type { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import { extractDisplayMessages } from "./hub-display-projection.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import { MediaNoticesDoc } from "./hub-media-delivery.js";
import type { HubMemoryRuntime } from "./hub-memory-runtime.js";
import type { HubTopicManager } from "./hub-topic-manager.js";
import {
  allocateArchivedRootTopicId,
  findBlockingMainArchiveTickets,
  formatArchivedRootTitle,
} from "./main-archive-state.js";
import { KuloMediaJobsDoc } from "./media-jobs.js";
import { extractEntryTextAndRole } from "./memory-flush-extract.js";
import { ProjectError } from "./projects.js";
import { KuloStateDoc, ensureDefaultRootTopic } from "./state.js";
import { UiCardsDoc } from "./ui-cards.js";
import type { KuloVoiceCalls } from "./voice-calls.js";
import { rehomeRootWorkingMemoryOnArchive } from "./working-memory-archive.js";

const ACTIVE_MEDIA_JOB_STATUSES = new Set(["queued", "submitting", "running", "collecting"]);

export interface MainConversationArchiveDeps {
  harness: Harness;
  runtimeGates: Pick<HubRuntimeGates, "isClosed" | "isRecovering" | "isHandoverBarrierActive">;
  delivery: Pick<HubDeliveryCoordinator, "queueChat">;
  topics: Pick<HubTopicManager, "drainTopicActivity" | "replaceWatchedTopic">;
  voiceCalls: Pick<KuloVoiceCalls, "hasActiveOrPendingCallForTopic">;
  contextGuard: Pick<HubContextGuard, "isCompacting">;
  memoryRuntime: Pick<HubMemoryRuntime, "scheduleForArchive" | "rebindArchivedRootConversation">;
  connectionManager: Pick<KuloConnections, "hasPendingAccessRequest" | "redact">;
  orchestrator: {
    resolveAgent: () => { model?: ModelRef; thinkingLevel?: ModelThinkingLevel };
    extensions: (isRoot: boolean) => readonly Extension[];
    tools: (isRoot: boolean) => readonly ToolRegistration[];
    mainWorkspaceDir: string;
    alignContextCompaction: (conversationId: ConversationId, context: Context) => Promise<void>;
  };
  hooks: {
    getAgentName: () => string;
    isLongTermMemoryActive: () => boolean;
    closeOrchestratorBrowserSessionByConversation: (conversationId: number) => Promise<void>;
    onActiveRootChanged?: (conversation: Conversation) => void;
    broadcastTicketsAndBoards?: (context: Context) => Promise<void>;
  };
  now?: () => number;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function hasArchivableEntriesInTx(
  tx: Tx,
  conversationId: ConversationId,
  redact: (text: string) => string,
): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 100, cursor);
    if (page.items.length === 0) return false;
    if (extractDisplayMessages(page.items).length > 0) return true;
    if (page.items.some((entry) => extractEntryTextAndRole(entry, redact) !== undefined)) return true;
    cursor = page.next;
  } while (cursor);
  return false;
}

export class MainConversationArchiveService {
  readonly #deps: MainConversationArchiveDeps;
  #archiving = false;

  constructor(deps: MainConversationArchiveDeps) {
    this.#deps = deps;
  }

  isArchivingRoot(): boolean {
    return this.#archiving;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #buildOrchestratorAgentChange(isRoot: boolean): AgentChange {
    const resolved = this.#deps.orchestrator.resolveAgent();
    return {
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      extensions: this.#deps.orchestrator.extensions(isRoot),
      tools: this.#deps.orchestrator.tools(isRoot),
      cwd: this.#deps.orchestrator.mainWorkspaceDir,
      maxTurns: 25,
    };
  }

  async archiveMainConversation(
    input: ArchiveMainConversationInput,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ArchiveMainConversationResult> {
    const expectedConversationId = input?.expectedConversationId;
    if (!Number.isSafeInteger(expectedConversationId) || expectedConversationId < 1) {
      throw new ProjectError(400, "invalid_archive_request", "请提供有效的主对话会话 ID。");
    }
    this.#assertRuntimeReady();

    return this.#deps.delivery.queueChat("root", async () => {
      this.#assertRuntimeReady();
      this.#archiving = true;
      try {
        // Complete any pending finalize from an interrupted earlier rotation before validating a new one.
        await this.finalizeMainArchive(context);

        // Drain pending topic preview/activity commits so archived snapshot captures the latest preview.
        await this.#deps.topics.drainTopicActivity("root");

        // Gate 4: reject while a voice call is active, finishing, or being created on root.
        if (this.#deps.voiceCalls.hasActiveOrPendingCallForTopic("root")) {
          throw new ProjectError(409, "voice_call_active", "主对话正在进行语音通话，请先结束通话后再归档。");
        }

        const now = this.#now();
        const rootAgentChange = this.#buildOrchestratorAgentChange(true);
        const redact = (text: string) => this.#deps.connectionManager.redact(text);

        const commitResult = await this.#deps.harness.commit(async (tx) => {
          const state = await tx.doc(KuloStateDoc);
          const root = ensureDefaultRootTopic(state, this.#deps.hooks.getAgentName());
          const oldConvId = root.conversationId;
          const oldConvKey = String(oldConvId);

          // Strict CAS check against caller's observed root generation.
          if (oldConvId !== expectedConversationId) {
            throw new ProjectError(409, "root_conversation_changed", "主对话已更新，请刷新后重试。");
          }

          // Gate 5: conversation run / compaction / context-guard idle check.
          const [live, inbox, pendingAttachments, mediaJobs, mediaNotices, confirmations, uiCards] = await Promise.all([
            tx.doc(LiveDoc, oldConvId as ConversationId),
            tx.doc(InboxDoc, oldConvId as ConversationId),
            tx.doc(PendingChatAttachmentsDoc),
            tx.doc(KuloMediaJobsDoc),
            tx.doc(MediaNoticesDoc),
            tx.doc(ActionConfirmationsDoc),
            tx.doc(UiCardsDoc),
          ]);

          if (live.run || (live.compactions?.length ?? 0) > 0 || this.#deps.contextGuard.isCompacting(oldConvId)) {
            throw new ProjectError(409, "conversation_busy", "主对话正在生成或整理上下文，请稍后再归档。");
          }
          if (inbox.items.length > 0 || (state.pausedChats?.[oldConvKey]?.length ?? 0) > 0) {
            throw new ProjectError(409, "pending_messages", "主对话仍有待处理消息，请先处理后再归档。");
          }
          if (
            Object.values(pendingAttachments.messages ?? {}).some(
              (draft) => draft.topicId === "root" || draft.conversationId === oldConvId,
            )
          ) {
            throw new ProjectError(409, "pending_attachments", "主对话仍有待发送的附件消息，请稍后再归档。");
          }

          // Gate 6: blocking tickets (unfinished / cleanupPending / pendingApply / finalRelayPending).
          const blockingTickets = findBlockingMainArchiveTickets(state, oldConvId);
          if (blockingTickets.length > 0) {
            throw new ProjectError(409, "blocking_tickets", "主对话仍有进行中、待审核或待收尾的任务，请先处理后再归档。");
          }

          const oldRootTicketIds = new Set<string>();
          for (const ticket of Object.values(state.tickets ?? {})) {
            if (ticket.originTopicId === "root" || ticket.originConversationId === oldConvId) {
              oldRootTicketIds.add(ticket.id);
            }
          }

          // Gate 7: active / undelivered / unnotified media jobs (direct & old-root Worker jobs; excluding setup tests).
          for (const job of Object.values(mediaJobs.jobs ?? {})) {
            if (job.source.setupClientId) continue;
            const belongsToOldRoot =
              (!job.source.ticketId && (job.source.conversationId === oldConvId || job.source.topicId === "root")) ||
              (job.source.ticketId !== undefined && oldRootTicketIds.has(job.source.ticketId)) ||
              job.source.topicId === "root";
            if (!belongsToOldRoot) continue;
            const isUndelivered = job.status === "completed" && !job.deliveredAt;
            const isUnnotifiedSettled =
              job.settledVersion !== undefined && job.settledVersion !== job.notifiedSettledVersion;
            if (ACTIVE_MEDIA_JOB_STATUSES.has(job.status) || isUndelivered || isUnnotifiedSettled) {
              throw new ProjectError(409, "pending_media_jobs", "主对话仍有正在生成或待回传的媒体任务，请稍后再归档。");
            }
          }
          if ((mediaNotices.pendingRelays?.[oldConvKey]?.length ?? 0) > 0) {
            throw new ProjectError(409, "pending_media_relays", "主对话仍有待回传的媒体结果，请稍后再归档。");
          }

          // Gate 8: pending / dispatched action confirmations & pending connection approvals.
          const seenConfirmations = new Map<string, PendingActionConfirmation>();
          for (const item of Object.values(confirmations.byId ?? {})) seenConfirmations.set(item.id, item);
          for (const item of Object.values(confirmations.byCardId ?? {})) seenConfirmations.set(item.id, item);
          for (const rec of seenConfirmations.values()) {
            if (rec.conversationId !== oldConvId) continue;
            if (
              rec.status === "pending" ||
              rec.status === "pending_orchestrator" ||
              effectiveConfirmationEffect(rec) === "dispatched"
            ) {
              throw new ProjectError(409, "pending_confirmations", "主对话仍有待确认或执行中的操作，请先处理后再归档。");
            }
          }
          if (this.#deps.connectionManager.hasPendingAccessRequest(oldConvId, oldRootTicketIds)) {
            throw new ProjectError(409, "pending_connection_approval", "主对话仍有待审批的连接权限申请，请先处理后再归档。");
          }

          // Gate 9: empty conversation check & tailEntryId read BEFORE any table write (pi-durable ReadAfterWrite rule).
          const hasEntries = await hasArchivableEntriesInTx(tx, oldConvId as ConversationId, redact);
          if (!hasEntries) {
            return { archived: false as const, oldConvId };
          }
          const latestId = await tx.latestEntryId(oldConvId as ConversationId);
          const tailEntryId = latestId !== undefined ? Number(latestId) : 0;

          // Atomic rotation: create & configure fresh conversation inside the same commit!
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, rootAgentChange);
          const newConvId = Number(created.id);

          const archivedTopicId = allocateArchivedRootTopicId(state, oldConvId, now);
          const existingTitles = new Set(
            Object.values(state.topics ?? {})
              .filter((t) => t.deletedAt === undefined)
              .map((t) => t.title),
          );
          const archivedTopic: TopicSummary = {
            id: archivedTopicId,
            conversationId: oldConvId,
            title: formatArchivedRootTitle(now, existingTitles),
            createdAt: root.createdAt,
            updatedAt: now,
            archived: true,
            archivedFromRoot: true,
            ...(root.lastMessagePreview ? { lastMessagePreview: root.lastMessagePreview } : {}),
            ...(root.lastMessageAt !== undefined ? { lastMessageAt: root.lastMessageAt } : {}),
          };

          // Migrate settled tickets, task boards, media jobs, and UI cards to archivedTopicId.
          for (const ticketId of oldRootTicketIds) {
            const ticket = state.tickets[ticketId];
            if (!ticket) continue;
            ticket.originTopicId = archivedTopicId;
            if (ticket.originConversationId === undefined) ticket.originConversationId = oldConvId;
          }
          for (const board of Object.values(state.boards ?? {})) {
            if (
              board.originConversationId === oldConvId ||
              (board.originTopicId === "root" && board.originConversationId === undefined)
            ) {
              board.originTopicId = archivedTopicId;
              if (board.originConversationId === undefined) board.originConversationId = oldConvId;
            }
          }
          for (const job of Object.values(mediaJobs.jobs ?? {})) {
            if (job.source.setupClientId) continue;
            if (
              job.source.topicId === "root" &&
              (job.source.conversationId === oldConvId ||
                (job.source.ticketId !== undefined && oldRootTicketIds.has(job.source.ticketId)))
            ) {
              job.source.topicId = archivedTopicId;
            }
          }
          for (const card of Object.values(uiCards.cards ?? {})) {
            if (card.originConversationId === oldConvId && card.topicId === "root") {
              card.topicId = archivedTopicId;
            }
          }

          // Commit topic rotation & durable finalize checkpoint.
          state.topics ??= {};
          state.conversationToTopic ??= {};
          state.topics[archivedTopicId] = archivedTopic;
          root.conversationId = newConvId;
          root.updatedAt = now;
          delete root.lastMessagePreview;
          delete root.lastMessageAt;
          state.topics.root = root;
          state.conversationToTopic[oldConvKey] = archivedTopicId;
          state.conversationToTopic[String(newConvId)] = "root";
          if (state.topicTitles?.root) delete state.topicTitles.root;

          state.pendingMainArchiveFinalize = {
            oldConvId,
            newConvId,
            archivedTopicId,
            tailEntryId,
            createdAt: now,
            steps: {
              reconfiguredOld: false,
              watchedNew: false,
              rehomedWorkingMemory: false,
              dispatchedFlush: false,
              reboundBuiltinMemory: false,
            },
          };

          return {
            archived: true as const,
            archivedTopic: cloneJson(archivedTopic),
            newConvId,
          };
        }, context);

        if (!commitResult.archived) {
          return {
            archived: false,
            reason: "empty_conversation",
            rootConversationId: commitResult.oldConvId,
          };
        }

        const longTermMemoryActive = this.#deps.hooks.isLongTermMemoryActive();
        try {
          const finalized = await this.finalizeMainArchive(context);
          return {
            archived: true,
            archivedTopic: commitResult.archivedTopic,
            rootConversationId: commitResult.newConvId,
            memoryFlush: finalized.memoryFlush ?? "already_up_to_date",
            longTermMemoryActive,
          };
        } catch (error) {
          console.warn("[KuloMainArchive] Post-commit finalization deferred for retry", error);
          return {
            archived: true,
            archivedTopic: commitResult.archivedTopic,
            rootConversationId: commitResult.newConvId,
            memoryFlush: "skipped",
            longTermMemoryActive,
            finalizePending: true,
          };
        }
      } finally {
        this.#archiving = false;
      }
    });
  }

  /**
   * Idempotent crash-recovery finalizer for `KuloStateDoc.pendingMainArchiveFinalize`.
   * Executes each remaining step in order, checking live deletion tombstones before touching
   * the archived conversation, and clears `pendingMainArchiveFinalize` once all 5 steps finish.
   */
  async finalizeMainArchive(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ pending: boolean; memoryFlush?: MainArchiveFlushStatus }> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const pending = state?.pendingMainArchiveFinalize;
    if (!pending) return { pending: false };

    let memoryFlush: MainArchiveFlushStatus | undefined;

    // Step 1: Close browser sessions bound to oldConvId & downgrade oldConv from isRoot=true to isRoot=false.
    if (!pending.steps.reconfiguredOld) {
      await this.#deps.hooks.closeOrchestratorBrowserSessionByConversation(pending.oldConvId).catch(() => {});
      const archivedTopic = state.topics?.[pending.archivedTopicId];
      if (archivedTopic && archivedTopic.deletedAt === undefined) {
        const oldConv = await this.#deps.harness.conversation(pending.oldConvId as ConversationId, context);
        if (oldConv) {
          await oldConv.configure(this.#buildOrchestratorAgentChange(false), context);
        }
      }
      await this.#markFinalizeStep(pending, "reconfiguredOld", context);
    }

    // Step 2: Align compaction, bind newConv as active root watch, and broadcast live topics/view.
    if (!pending.steps.watchedNew) {
      const latestState = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const newConv = await this.#deps.harness.conversation(pending.newConvId as ConversationId, context);
      if (newConv) {
        await this.#deps.orchestrator.alignContextCompaction(newConv.id, context);
        if (latestState?.topics?.root?.conversationId === pending.newConvId) {
          this.#deps.hooks.onActiveRootChanged?.(newConv);
          await this.#deps.topics.replaceWatchedTopic("root", newConv, context);
        }
      }
      await this.#deps.hooks.broadcastTicketsAndBoards?.(context).catch(() => {});
      await this.#markFinalizeStep(pending, "watchedNew", context);
    }

    // Step 3: Re-home working memory provenance & topic:root records in independent transaction.
    if (!pending.steps.rehomedWorkingMemory) {
      const latestState = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const archivedTopic = latestState?.topics?.[pending.archivedTopicId];
      const archivedDeleted = !archivedTopic || archivedTopic.deletedAt !== undefined;
      await rehomeRootWorkingMemoryOnArchive({
        harness: this.#deps.harness,
        redact: (text) => this.#deps.connectionManager.redact(text),
        oldConvId: pending.oldConvId,
        newConvId: pending.newConvId,
        archivedTopicId: pending.archivedTopicId,
        tailEntryId: pending.tailEntryId,
        archivedDeleted,
        context,
      });
      await this.#markFinalizeStep(pending, "rehomedWorkingMemory", context);
    }

    // Step 4: Transactionally dispatch or merge archive tail flush (skipping if deleted).
    if (!pending.steps.dispatchedFlush) {
      const latestState = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const archivedTopic = latestState?.topics?.[pending.archivedTopicId];
      const archivedDeleted = !archivedTopic || archivedTopic.deletedAt !== undefined;
      if (!archivedDeleted && pending.tailEntryId > 0) {
        memoryFlush = await this.#deps.memoryRuntime.scheduleForArchive(
          pending.oldConvId,
          pending.tailEntryId,
          context,
        );
      } else {
        memoryFlush = archivedDeleted ? "skipped" : "already_up_to_date";
      }
      await this.#markFinalizeStep(pending, "dispatchedFlush", context);
    }

    // Step 5: Rebind Built-in Memory pendingDeliveries + memory.sqlite rows, then clear finalize slot.
    if (!pending.steps.reboundBuiltinMemory) {
      await this.#deps.memoryRuntime.rebindArchivedRootConversation(
        pending.oldConvId,
        pending.archivedTopicId,
        context,
      );
      await this.#markFinalizeStep(pending, "reboundBuiltinMemory", context, true);
    } else {
      await this.#clearFinalizeSlot(pending, context);
    }

    return { pending: false, ...(memoryFlush ? { memoryFlush } : {}) };
  }

  #assertRuntimeReady(): void {
    if (
      this.#deps.runtimeGates.isClosed() ||
      this.#deps.runtimeGates.isRecovering() ||
      this.#deps.runtimeGates.isHandoverBarrierActive()
    ) {
      throw new ProjectError(503, "hub_unavailable", "中枢当前不可执行主对话归档，请稍后重试。");
    }
  }

  async #markFinalizeStep(
    expected: MainArchiveFinalizeRecord,
    step: keyof MainArchiveFinalizeSteps,
    context: Context,
    clearOnComplete = false,
  ): Promise<void> {
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const live = state.pendingMainArchiveFinalize;
      if (!live || live.oldConvId !== expected.oldConvId || live.newConvId !== expected.newConvId) return;
      live.steps[step] = true;
      if (clearOnComplete && Object.values(live.steps).every(Boolean)) {
        delete state.pendingMainArchiveFinalize;
      }
    }, context);
  }

  async #clearFinalizeSlot(expected: MainArchiveFinalizeRecord, context: Context): Promise<void> {
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const live = state.pendingMainArchiveFinalize;
      if (!live || live.oldConvId !== expected.oldConvId || live.newConvId !== expected.newConvId) return;
      delete state.pendingMainArchiveFinalize;
    }, context);
  }
}
