import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { CompactionEntry, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { BuiltinMemoryStateView, HindsightMemoryConfig, MainArchiveFlushStatus, MemoryBank } from "@kulo/protocol";
import { BuiltinMemoryService } from "./builtin-memory-service.js";
import { BUILTIN_MEMORY_FAILOVER_PAUSE_FILE } from "./cluster-sync-paths.js";
import { abortConversationSafely } from "./conversation-abort.js";
import { BUILTIN_MEMORY_REDACTION_PENDING_FILE, scrubBuiltinMemorySecrets } from "./credential-redaction.js";
import type { HubContextGuard } from "./context-guard.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import { IdleSoftCompactionService, type IdleCompactionPolicy } from "./idle-compaction.js";
import { createMemoryFlushExtension } from "./memory-flush.js";
import type { createMemoryLifecycleExtension } from "./memory-lifecycle.js";
import { invalidateRecentWorkSyncCaches } from "./recent-work-sync.js";
import { KuloStateDoc } from "./state.js";
import { createBuiltinMemoryTools } from "./tools-builtin-memory.js";
import {
  classifyTicketOutcome,
  purgeDeletedScopeWorkingMemory,
  recordTicketOutcomeToWorkingMemory,
  revokeWorkingMemoryTerm,
} from "./working-memory.js";

export interface HubMemoryRuntimeDeps {
  stateDir: string;
  getHarness: () => Harness;
  getModels: () => Models;
  getSettingsStore: () => LiveSettingsStore;
  getContextGuard: () => Pick<HubContextGuard, "compactConversationAtomic">;
  getRuntimeGates: () => Pick<HubRuntimeGates, "isClosed" | "isRecovering" | "isHandoverBarrierActive">;
  getMemoryLifecycle: () => Pick<
    ReturnType<typeof createMemoryLifecycleExtension>,
    "retainGlobalWorkingMemoryRecords" | "revokePrivateRetainsForTerm"
  >;
  getEffectiveMemoryConfig: () => HindsightMemoryConfig;
  getRawMemoryConfig?: () => HindsightMemoryConfig;
  onBuiltinMemoryModeChanged?: (state: BuiltinMemoryStateView) => void | Promise<void>;
  onBuiltinMemoryStoreWrite?: () => void;
  isClusterStandbyActive?: () => boolean;
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
  readonly builtinMemory: BuiltinMemoryService;
  readonly builtinMemoryRecallExt: ReturnType<BuiltinMemoryService["createRecallExtension"]>;
  readonly memoryFlushExt: ReturnType<typeof createMemoryFlushExtension>;
  #idleCompaction: IdleSoftCompactionService | null = null;
  #startupScrub: Promise<void> | null = null;
  #closing = false;

  constructor(deps: HubMemoryRuntimeDeps) {
    this.#deps = deps;
    this.builtinMemory = new BuiltinMemoryService({
      stateDir: deps.stateDir,
      getHarness: deps.getHarness,
      getEffectiveMemoryConfig: deps.getEffectiveMemoryConfig,
      ...(deps.getRawMemoryConfig ? { getRawMemoryConfig: deps.getRawMemoryConfig } : {}),
      redact: deps.redact,
      scheduleIdleFlush: (input, ctx) => this.memoryFlushExt.scheduleForIdle(input, ctx),
      abortIdleFlushTasks: (ctx) => this.memoryFlushExt.abortIdleFlushTasks(ctx),
      ...(deps.onBuiltinMemoryModeChanged ? { onModeChanged: deps.onBuiltinMemoryModeChanged } : {}),
      ...(deps.onBuiltinMemoryStoreWrite ? { onStoreWrite: deps.onBuiltinMemoryStoreWrite } : {}),
      ...(deps.isClusterStandbyActive ? { isClusterStandbyActive: deps.isClusterStandbyActive } : {}),
    });
    this.builtinMemoryRecallExt = this.builtinMemory.createRecallExtension();
    this.memoryFlushExt = createMemoryFlushExtension({
      getHarness: deps.getHarness,
      redact: deps.redact,
      isClosed: () => deps.getRuntimeGates().isClosed(),
      isRecovering: () => deps.getRuntimeGates().isRecovering(),
      isHandoverBarrierActive: () => deps.getRuntimeGates().isHandoverBarrierActive(),
      isPersonalityCapped: deps.isPersonalityCapped,
      willUseCloudModel: deps.willUseCloudModel,
      completeZeroToolJson: deps.completeZeroToolJson,
      getBuiltinMemoryEpochs: () => this.builtinMemory.getCurrentEpochs(),
      getBuiltinMemoryFloorCursor: (cid) => this.builtinMemory.getFloorCursor(cid),
      onFlushCommitInTx: async (tx, payload) => {
        await this.builtinMemory.enqueueFlushDeliveriesInTx(tx, {
          conversationId: payload.conversationId,
          records: payload.verifiedRecords,
          forgottenTerms: payload.forgottenTerms,
          ...(payload.expectedClearEpoch !== undefined ? { expectedClearEpoch: payload.expectedClearEpoch } : {}),
          ...(payload.expectedEngineEpoch !== undefined ? { expectedEngineEpoch: payload.expectedEngineEpoch } : {}),
          ...(payload.advanceIdleFloorEntryId !== undefined ? { advanceIdleFloorEntryId: payload.advanceIdleFloorEntryId } : {}),
          ...(payload.advanceIdleFloorCharOffset !== undefined ? { advanceIdleFloorCharOffset: payload.advanceIdleFloorCharOffset } : {}),
        });
      },
      onFlushCommitted: async (ctx) => {
        await this.builtinMemory.drainOutbox(ctx);
      },
      onRecordsCommitted: async (records, ctx) => {
        await deps.getMemoryLifecycle().retainGlobalWorkingMemoryRecords(records, ctx);
      },
      onActiveRootMemoryUpdated: async (activeRootConversationId, ctx) => {
        await invalidateRecentWorkSyncCaches(deps.getHarness(), [activeRootConversationId], ctx);
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

  createBuiltinMemoryTools(defaultBank: MemoryBank) {
    return createBuiltinMemoryTools({
      defaultBank,
      port: {
        isEffectiveActive: () => this.builtinMemory.isEffectiveActive(),
        isSharedEffectiveActive: () => this.builtinMemory.isSharedEffectiveActive(),
        retainFromTool: (input) => this.builtinMemory.retainFromTool(input),
        recallForTool: (input) => this.builtinMemory.recallForTool(input),
      },
    });
  }

  async start(options?: { hasCustomStorage?: boolean; isKnownSecret?: (text: string) => boolean }): Promise<void> {
    this.#closing = false;
    this.idleCompaction.start();
    void this.memoryFlushExt.recoverPendingArchiveFlushes(BACKGROUND_CONTEXT).catch(() => {});
    const failoverPausePath = path.join(this.#deps.stateDir, BUILTIN_MEMORY_FAILOVER_PAUSE_FILE);
    if (fs.existsSync(failoverPausePath)) {
      this.builtinMemory.setFailoverPaused(true);
      await this.builtinMemory.hydratePaused(BACKGROUND_CONTEXT).catch(() => {});
      return;
    }
    const dbPath = path.join(this.#deps.stateDir, "memory.sqlite");
    const markerPath = path.join(this.#deps.stateDir, BUILTIN_MEMORY_REDACTION_PENDING_FILE);
    const needsScrub = !options?.hasCustomStorage && (fs.existsSync(dbPath) || fs.existsSync(markerPath));
    if (needsScrub) {
      this.builtinMemory.setScrubBlocked(true);
      // Queue exclusive scrub synchronously onto store.#serial before returning so concurrent
      // clusterSync backupTo() / getStateView() / close() calls serialize behind scrub.
      const scrubWork = this.builtinMemory.store.runExclusiveUnopened(() =>
        scrubBuiltinMemorySecrets(this.#deps.stateDir, this.#deps.redact, {
          ...(options?.isKnownSecret ? { isKnownSecret: options.isKnownSecret } : {}),
        }),
      );
      let task: Promise<void> | null = null;
      task = (async () => {
        try {
          const res = await scrubWork;
          if (res.deletedRows > 0) this.#deps.onBuiltinMemoryStoreWrite?.();
          if (this.#closing) return;
          this.builtinMemory.setScrubBlocked(false);
          await this.builtinMemory.start(BACKGROUND_CONTEXT);
          void this.builtinMemory.drainOutbox(BACKGROUND_CONTEXT).catch(() => {});
          await this.#deps.onBuiltinMemoryModeChanged?.(this.builtinMemory.buildStateView());
        } catch (error) {
          console.warn("[KuloBuiltinMemory] Startup secret scrub failed; built-in memory paused", error);
        } finally {
          if (this.#startupScrub === task) this.#startupScrub = null;
        }
      })();
      this.#startupScrub = task;
      return;
    }
    try {
      await this.builtinMemory.start(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn("[KuloBuiltinMemory] Startup initialization failed", error);
    }
  }

  async startBuiltinMemory(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.builtinMemory.start(context);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#idleCompaction?.stop();
    await this.#startupScrub?.catch(() => {});
    await this.builtinMemory.close().catch(() => {});
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

  async forgetFromBuiltinMemory(
    term: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ removedRecords: number }> {
    return this.builtinMemory.forgetPrivateTerm(term, context);
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
    await this.builtinMemory.schedulePurgeScope({ kind: "topic", targetId: topicId, conversationIds: [conversationId] }, context).catch(() => {});
  }

  async onProjectDeleted(
    projectId: string,
    conversationIds: readonly number[],
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    const harness = this.#deps.getHarness();
    for (const convId of conversationIds) {
      const conv = await harness.conversation(convId as ConversationId, context).catch(() => undefined);
      if (conv) await abortConversationSafely(harness, conv, context);
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
    await this.builtinMemory.schedulePurgeScope({ kind: "project", targetId: projectId, conversationIds }, context).catch(() => {});
  }

  async onTopicMoved(
    topicId: string,
    nextProjectId: string | null,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    await this.builtinMemory.onTopicMoved(topicId, nextProjectId, context).catch(() => {});
  }

  async scheduleForArchive(
    conversationId: number,
    tailEntryId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<MainArchiveFlushStatus> {
    return this.memoryFlushExt.scheduleForArchive(conversationId, tailEntryId, context);
  }

  async rebindArchivedRootConversation(
    oldConvId: number,
    archivedTopicId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    await this.builtinMemory.rebindArchivedRootConversation(oldConvId, archivedTopicId, context);
  }
}
