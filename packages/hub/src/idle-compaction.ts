import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { computeContextThresholds, DEFAULT_CONTEXT_WINDOW, DEFAULT_SOFT_BACKGROUND_TRIGGER_TOKENS } from "./config.js";
import {
  analyzeCompactablePrefix,
  estimateActiveContextFromContextView,
  type HubContextGuard,
} from "./context-guard.js";
import type { LiveSettingsStore } from "./hub-kernel-ports.js";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-doc.js";
import { KuloStateDoc, isOrchestratorConversation, isTicketUnfinished } from "./state.js";
import { isLoopbackBaseUrl } from "./usage-caps.js";
import {
  KuloWorkingMemoryDoc,
  formatLocalDate,
  tryCommitWorkingMemory,
} from "./working-memory.js";

/** Experimental tunable parameters for idle / cross-day soft compaction. */
export const IDLE_COMPACT_MIN_IDLE_MS = 2 * 60 * 60 * 1000;
export const IDLE_COMPACT_CROSS_DAY_MIN_IDLE_MS = 30 * 60 * 1000;
export const IDLE_COMPACT_MIN_TOKENS = 44_000;
export const IDLE_COMPACT_MIN_DROPPED_TOKENS = 12_000;
export const IDLE_COMPACT_FRESH_COMMITMENT_GUARD_MS = 2 * 60 * 60 * 1000;
export const IDLE_COMPACT_RETRY_BACKOFF_MS = 30 * 60 * 1000;
export const IDLE_COMPACT_SCAN_INTERVAL_MS = 10 * 60 * 1000;

export interface IdleCompactionPolicy {
  enabled: boolean;
  minIdleMs: number;
  crossDayMinIdleMs: number;
  minTokens: number;
  minDroppedTokens: number;
  freshCommitmentGuardMs: number;
  retryBackoffMs: number;
}

export const DEFAULT_IDLE_COMPACTION_POLICY: Readonly<IdleCompactionPolicy> = Object.freeze({
  enabled: true,
  minIdleMs: IDLE_COMPACT_MIN_IDLE_MS,
  crossDayMinIdleMs: IDLE_COMPACT_CROSS_DAY_MIN_IDLE_MS,
  minTokens: IDLE_COMPACT_MIN_TOKENS,
  minDroppedTokens: IDLE_COMPACT_MIN_DROPPED_TOKENS,
  freshCommitmentGuardMs: IDLE_COMPACT_FRESH_COMMITMENT_GUARD_MS,
  retryBackoffMs: IDLE_COMPACT_RETRY_BACKOFF_MS,
});

export interface IdleCompactionHost {
  harness: Harness;
  models: Models;
  settingsStore: LiveSettingsStore;
  contextGuard: Pick<HubContextGuard, "compactConversationAtomic">;
  redact: (text: string) => string;
  isClosed: () => boolean;
  isRecovering: () => boolean;
  isHandoverBarrierActive: () => boolean;
  isPersonalityCapped: () => { capped: boolean; resetAt?: number };
  policy?: Partial<IdleCompactionPolicy>;
  now?: () => number;
}

export interface IdleCompactionTickResult {
  action: "noop" | "compacted" | "skipped_capped" | "skipped_below_threshold" | "failed";
  topicId?: string;
  conversationId?: number;
  taskId?: number;
  contextCalls: number;
}

export class IdleSoftCompactionService {
  readonly #host: IdleCompactionHost;
  readonly #policy: IdleCompactionPolicy;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(host: IdleCompactionHost) {
    this.#host = host;
    this.#policy = { ...DEFAULT_IDLE_COMPACTION_POLICY, ...(host.policy ?? {}) };
  }

  #now(): number {
    return this.#host.now ? this.#host.now() : Date.now();
  }

  start(intervalMs = IDLE_COMPACT_SCAN_INTERVAL_MS): void {
    if (this.#timer || !this.#policy.enabled) return;
    this.#timer = setInterval(() => {
      void this.runTick(BACKGROUND_CONTEXT).catch(() => {});
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Executes one bounded scan using the 4-step O(1) pre-filter.
   * Performs ZERO disk writes on no-op ticks and triggers at most 1 compaction per tick.
   */
  async runTick(context: Context = BACKGROUND_CONTEXT): Promise<IdleCompactionTickResult> {
    if (
      !this.#policy.enabled ||
      this.#running ||
      this.#host.isClosed() ||
      this.#host.isRecovering() ||
      this.#host.isHandoverBarrierActive() ||
      !this.#host.settingsStore.getCompactionConfig().enabled
    ) {
      return { action: "noop", contextCalls: 0 };
    }

    this.#running = true;
    let contextCalls = 0;
    try {
      const now = this.#now();
      const today = formatLocalDate(now);
      const [state, settingsDoc, wmDoc] = await Promise.all([
        this.#host.harness.snapshot(KuloStateDoc, context),
        this.#host.harness.snapshot(SettingsAssistantDoc, context),
        this.#host.harness.snapshot(KuloWorkingMemoryDoc, context),
      ]);
      if (!state?.topics) return { action: "noop", contextCalls: 0 };

      // Precompute topics protected by paused chats, active/pending-review tickets, or fresh commitments.
      const protectedTopicIds = new Set<string>();
      for (const topicId of Object.keys(state.pausedChats ?? {})) {
        protectedTopicIds.add(topicId);
      }
      for (const ticket of Object.values(state.tickets ?? {})) {
        if (isTicketUnfinished(ticket) || ticket.status === "ready") {
          protectedTopicIds.add(ticket.originTopicId ?? "root");
        }
      }
      for (const records of Object.values(wmDoc?.buckets ?? {})) {
        if (!Array.isArray(records)) continue;
        for (const rec of records) {
          if (
            rec.category === "commitment" &&
            rec.status === "active" &&
            now - rec.updatedAt < this.#policy.freshCommitmentGuardMs
          ) {
            if (rec.provenance.topicId) protectedTopicIds.add(rec.provenance.topicId);
          }
        }
      }

      // Step 1: In-memory/snapshot pre-filter of active chat topics meeting idle/cross-day criteria.
      const candidates = Object.values(state.topics)
        .filter((topic) => {
          if (topic.deletedAt !== undefined || topic.archived) return false;
          if (protectedTopicIds.has(topic.id)) return false;
          if (!isOrchestratorConversation(topic.conversationId, state)) return false;
          if (isActiveSettingsConversation(topic.conversationId, settingsDoc)) return false;
          // Use real user/assistant message activity time when present, never background sync ticks.
          const lastRealActivity = topic.lastMessageAt ?? topic.updatedAt;
          if (!lastRealActivity || lastRealActivity <= 0) return false;
          const idleMs = now - lastRealActivity;
          const isCrossDay = formatLocalDate(lastRealActivity) !== today;
          const requiredIdleMs = isCrossDay ? this.#policy.crossDayMinIdleMs : this.#policy.minIdleMs;
          return idleMs >= requiredIdleMs;
        })
        .sort((a, b) => (a.lastMessageAt ?? a.updatedAt) - (b.lastMessageAt ?? b.updatedAt));

      for (const topic of candidates) {
        const convId = topic.conversationId as ConversationId;
        const convKey = String(topic.conversationId);
        const cursor = wmDoc?.cursors?.[convKey];
        if (cursor?.nextIdleEligibleAt && now < cursor.nextIdleEligibleAt) continue;

        // Step 2: O(1) LiveDoc & InboxDoc idle check.
        const [live, inbox] = await Promise.all([
          this.#host.harness.snapshot(LiveDoc, convId, context),
          this.#host.harness.snapshot(InboxDoc, convId, context),
        ]);
        if (live?.run !== undefined || (live?.compactions && live.compactions.length > 0)) continue;
        if (inbox && Array.isArray(inbox.items) && inbox.items.length > 0) continue;

        const conversation = await this.#host.harness.conversation(convId, context);
        if (!conversation) continue;

        // Step 3: Single-row tail entry check to skip already-evaluated tails with ZERO disk writes!
        const tailPage = await conversation.entries({}, 1, undefined, context);
        const tailEntry = tailPage.items[0];
        if (!tailEntry) continue;
        const tailId = Number(tailEntry.id);
        if (cursor?.lastIdleAttemptTailId === tailId && (!cursor.nextIdleEligibleAt || now < cursor.nextIdleEligibleAt)) {
          continue;
        }

        // Check UsageCaps strictly based on whether this conversation's summarization model is cloud.
        const agent = await conversation.agent(context);
        const liveModel = this.#host.settingsStore.getModel();
        const provider = agent.model?.provider || liveModel.defaultProvider || "";
        const modelId = agent.model?.modelId || liveModel.defaultModel || "";
        const registered = provider && modelId ? this.#host.models.getModel(provider, modelId) : undefined;
        const usesCloudModel = registered ? !isLoopbackBaseUrl(registered.baseUrl) : true;
        if (usesCloudModel && this.#host.isPersonalityCapped().capped) {
          return {
            action: "skipped_capped",
            topicId: topic.id,
            conversationId: topic.conversationId,
            contextCalls,
          };
        }

        // Step 4: Only candidate passing Steps 1-3 loads `conversation.context()`.
        contextCalls += 1;
        const ctxView = await conversation.context(context);
        const estimate = estimateActiveContextFromContextView(ctxView);
        const contextWindow =
          registered?.contextWindow && registered.contextWindow > 0
            ? registered.contextWindow
            : liveModel.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const compaction = this.#host.settingsStore.getCompactionConfig();
        const thresholds = computeContextThresholds(compaction, contextWindow, DEFAULT_SOFT_BACKGROUND_TRIGGER_TOKENS);
        const cut = analyzeCompactablePrefix(ctxView, thresholds.keepRecentTokens);

        if (
          estimate.tokens < this.#policy.minTokens ||
          !cut.canCompact ||
          cut.droppedTokens < this.#policy.minDroppedTokens
        ) {
          // Record evaluated tail so subsequent ticks stay O(1) without calling conversation.context() again.
          await tryCommitWorkingMemory(
            this.#host.harness,
            this.#host.redact,
            (doc) => {
              const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
              cur.lastIdleAttemptTailId = tailId;
              delete cur.nextIdleEligibleAt;
              doc.cursors[convKey] = cur;
            },
            context,
          );
          return {
            action: "skipped_below_threshold",
            topicId: topic.id,
            conversationId: topic.conversationId,
            contextCalls,
          };
        }

        try {
          const compactRes = await this.#host.contextGuard.compactConversationAtomic(topic.conversationId, context);
          await tryCommitWorkingMemory(
            this.#host.harness,
            this.#host.redact,
            (doc) => {
              const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
              cur.lastIdleAttemptTailId = tailId;
              delete cur.nextIdleEligibleAt;
              doc.cursors[convKey] = cur;
            },
            context,
          );
          if (compactRes.compacted) {
            return {
              action: "compacted",
              topicId: topic.id,
              conversationId: topic.conversationId,
              taskId: compactRes.taskId,
              contextCalls,
            };
          }
          return {
            action: "skipped_below_threshold",
            topicId: topic.id,
            conversationId: topic.conversationId,
            contextCalls,
          };
        } catch {
          // Transient error / rate limit -> back off before retrying this tail.
          await tryCommitWorkingMemory(
            this.#host.harness,
            this.#host.redact,
            (doc) => {
              const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
              cur.lastIdleAttemptTailId = tailId;
              cur.nextIdleEligibleAt = now + this.#policy.retryBackoffMs;
              doc.cursors[convKey] = cur;
            },
            context,
          );
          return {
            action: "failed",
            topicId: topic.id,
            conversationId: topic.conversationId,
            contextCalls,
          };
        }
      }

      return { action: "noop", contextCalls };
    } finally {
      this.#running = false;
    }
  }
}

export { ROOT_CONVERSATION_ID };
