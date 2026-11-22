import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { CompactionEntry, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { HubContextGuard } from "./context-guard.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import { IdleSoftCompactionService, type IdleCompactionPolicy } from "./idle-compaction.js";
import { createMemoryFlushExtension } from "./memory-flush.js";
import type { createMemoryLifecycleExtension } from "./memory-lifecycle.js";
import { invalidateRecentWorkSyncCaches } from "./recent-work-sync.js";
import { KuloStateDoc } from "./state.js";
import {
  classifyTicketOutcome,
  purgeDeletedScopeWorkingMemory,
  recordTicketOutcomeToWorkingMemory,
  revokeWorkingMemoryTerm,
} from "./working-memory.js";

export interface HubMemoryRuntimeDeps {
  getHarness: () => Harness;
  getModels: () => Models;
  getSettingsStore: () => LiveSettingsStore;
  getContextGuard: () => Pick<HubContextGuard, "compactConversationAtomic">;
  getRuntimeGates: () => Pick<HubRuntimeGates, "isClosed" | "isRecovering" | "isHandoverBarrierActive">;
  getMemoryLifecycle: () => Pick<
    ReturnType<typeof createMemoryLifecycleExtension>,
    "retainGlobalWorkingMemoryRecords" | "revokePrivateRetainsForTerm"
  >;
  redact: (text: string) => string;
  isPersonalityCapped: () => { capped: boolean; resetAt?: number };
  willUseCloudModel: () => Promise<boolean>;
  completeZeroToolJson: (input: {
    systemPrompt: string;
    userContent: string;
    maxTokens?: number;
    signal?: AbortSignal;
    allowCloudFallback?: boolean;
  }) => Promise<string>;
  idlePolicy?: Partial<IdleCompactionPolicy>;
}

export class HubMemoryRuntime {
  readonly #deps: HubMemoryRuntimeDeps;
  readonly memoryFlushExt: ReturnType<typeof createMemoryFlushExtension>;
  #idleCompaction: IdleSoftCompactionService | null = null;

  constructor(deps: HubMemoryRuntimeDeps) {
    this.#deps = deps;
    this.memoryFlushExt = createMemoryFlushExtension({
      getHarness: deps.getHarness,
      redact: deps.redact,
      isClosed: () => deps.getRuntimeGates().isClosed(),
      isRecovering: () => deps.getRuntimeGates().isRecovering(),
      isHandoverBarrierActive: () => deps.getRuntimeGates().isHandoverBarrierActive(),
      isPersonalityCapped: deps.isPersonalityCapped,
      willUseCloudModel: deps.willUseCloudModel,
      completeZeroToolJson: deps.completeZeroToolJson,
      onRecordsCommitted: async (records, ctx) => {
        await deps.getMemoryLifecycle().retainGlobalWorkingMemoryRecords(records, ctx);
      },
    });
  }

  get idleCompaction(): IdleSoftCompactionService {
    if (!this.#idleCompaction) {
      this.#idleCompaction = new IdleSoftCompactionService({
        harness: this.#deps.getHarness(),
        models: this.#deps.getModels(),
        settingsStore: this.#deps.getSettingsStore(),
        contextGuard: this.#deps.getContextGuard(),
        redact: this.#deps.redact,
        isClosed: () => this.#deps.getRuntimeGates().isClosed(),
        isRecovering: () => this.#deps.getRuntimeGates().isRecovering(),
        isHandoverBarrierActive: () => this.#deps.getRuntimeGates().isHandoverBarrierActive(),
        isPersonalityCapped: this.#deps.isPersonalityCapped,
        policy: this.#deps.idlePolicy,
      });
    }
    return this.#idleCompaction;
  }

  start(): void {
    this.idleCompaction.start();
  }

  close(): void {
    this.#idleCompaction?.stop();
  }

  async onCompactionCommitted(
    conversationId: ConversationId,
    firstKept: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    try {
      const conv = await this.#deps.getHarness().conversation(conversationId, context);
      const latest = conv ? await conv.entries({}, 8, undefined, context) : undefined;
      const compEntry = latest?.items.find((entry) => CompactionEntry.is(entry));
      const observedHeadId = compEntry ? Number(compEntry.id) : firstKept;
      await this.memoryFlushExt.scheduleForCompaction(conversationId, firstKept, observedHeadId, context);
    } catch {
      // Best-effort scheduling; next compaction or recovery will pick up unflushed range.
    }
  }

  async onTicketSettled(ticketId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    try {
      const harness = this.#deps.getHarness();
      const state = await harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets?.[ticketId];
      if (!ticket) return;
      const outcome = classifyTicketOutcome(ticket, {
        failed: ticket.latestReport?.state === "failed" && ticket.status !== "closed",
      });
      if (!outcome) return;
      await recordTicketOutcomeToWorkingMemory(
        harness,
        this.#deps.redact,
        ticket,
        outcome,
        { detail: ticket.latestReport?.summary ?? ticket.closure?.reason ?? ticket.stoppedReason },
        context,
      );
    } catch {
      // Independent best-effort write; never interferes with ticket state machine.
    }
  }

  async forgetFromWorkingMemory(
    term: string,
    reason?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ removedRecords: number }> {
    const harness = this.#deps.getHarness();
    const res = await revokeWorkingMemoryTerm(harness, this.#deps.redact, term, context);
    await invalidateRecentWorkSyncCaches(harness, res.flaggedConversationIds, context);
    await this.#deps.getMemoryLifecycle().revokePrivateRetainsForTerm(term, reason, context).catch(() => {});
    return { removedRecords: res.removedRecords };
  }

  async onTopicDeleted(
    topicId: string,
    conversationId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const harness = this.#deps.getHarness();
    const purged = await purgeDeletedScopeWorkingMemory(
      harness,
      this.#deps.redact,
      { topicId, conversationIds: [conversationId] },
      context,
    );
    if (purged.flaggedConversationIds.length > 0) {
      await invalidateRecentWorkSyncCaches(harness, purged.flaggedConversationIds, context);
    }
  }

  async onProjectDeleted(
    projectId: string,
    conversationIds: readonly number[],
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const harness = this.#deps.getHarness();
    for (const convId of conversationIds) {
      const conv = await harness.conversation(convId as ConversationId, context).catch(() => undefined);
      await conv?.abort(context, { background: true }).catch(() => {});
    }
    const purged = await purgeDeletedScopeWorkingMemory(
      harness,
      this.#deps.redact,
      { projectId, conversationIds },
      context,
    );
    if (purged.flaggedConversationIds.length > 0) {
      await invalidateRecentWorkSyncCaches(harness, purged.flaggedConversationIds, context);
    }
  }
}
