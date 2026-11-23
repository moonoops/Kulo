/**
 * Built-in Memory Orchestration Service (`BuiltinMemoryDoc` + L2 `memory.sqlite`).
 *
 * Implements v3 hardened contracts:
 * - Pure L2 clear with cross-DB crash-recovery barrier (`clearTargetEpoch` vs `applied_clear_epoch`),
 *   `operationId` idempotency, `tx.latestEntryId` deterministic boundaries, and independent `floorCursors`.
 * - Single-transaction Outbox (`pendingDeliveries`) & retryable scope purges (`pendingPurges`).
 * - Upgrade baseline watermarks so enabling never back-sweeps legacy conversations.
 * - Low-frequency idle scanner feeding `memory-flush.ts` without blocking chat.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import type {
  ActiveMemoryMode,
  BuiltinMemoryCategory,
  BuiltinMemoryClusterMeta,
  BuiltinMemoryScopeKind,
  BuiltinMemoryStateView,
  ExternalMemoryMode,
  HindsightMemoryConfig,
  MemoryBank,
  TicketRecord,
} from "@kulo/protocol";
import { redactSensitiveText } from "@kulo/protocol";
import { BUILTIN_MEMORY_FAILOVER_PAUSE_FILE } from "./cluster-sync-paths.js";
import { isSafeMemoryText, type MemoryCallerContext } from "./hindsight.js";
import { findMatchingForgottenTerm, type ForgottenTermEntry } from "./memory-forget.js";
import { PersonalityDoc } from "./personality.js";
import { KuloProjectsDoc } from "./projects.js";
import { KuloStateDoc } from "./state.js";
import {
  isSuspiciousMemoryInstruction,
  type WorkingMemoryRecord,
} from "./working-memory.js";
import {
  BuiltinMemoryDoc,
  BuiltinMemoryError,
  advanceFloorCursorsInTx,
  buildDeliveryRetainPayload,
  collectAllConversationIds,
  enqueueFlushRecordsIntoDoc,
  pruneForgottenPendingDeliveries,
  prunePendingDeliveriesForScope,
  type BuiltinMemoryDeliveryItem,
  type BuiltinMemoryDocState,
  type BuiltinMemoryFloorCursor,
} from "./builtin-memory-doc.js";
import {
  createBuiltinMemoryRecallExtension,
  revokeBuiltinRecallsInConversations,
  scanIdleTopicsForBuiltinMemory,
} from "./builtin-memory-recall.js";
import {
  BuiltinMemoryStore,
  BuiltinMemoryStoreError,
  type BuiltinMemoryRecallHit,
} from "./builtin-memory-store.js";

export { BuiltinMemoryDoc, BuiltinMemoryError, type BuiltinMemoryDocState, type BuiltinMemoryFloorCursor } from "./builtin-memory-doc.js";

const IDLE_SCAN_INTERVAL_MS = 3 * 60_000;
const MAX_PENDING_DELIVERIES = 512;
const MAX_PENDING_PURGES = 128;

export interface BuiltinMemoryServiceDeps {
  stateDir: string;
  getHarness: () => Harness;
  getEffectiveMemoryConfig: () => HindsightMemoryConfig;
  getRawMemoryConfig?: () => HindsightMemoryConfig;
  redact: (text: string) => string;
  scheduleIdleFlush?: (
    input: { conversationId: number; headEntryId: number; clearEpoch: number; engineEpoch: number },
    context: Context,
  ) => Promise<boolean>;
  abortIdleFlushTasks?: (context: Context) => Promise<void>;
  onModeChanged?: (state: BuiltinMemoryStateView) => void | Promise<void>;
  onStoreWrite?: () => void;
  isClusterStandbyActive?: () => boolean;
  now?: () => number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class BuiltinMemoryService {
  readonly #deps: BuiltinMemoryServiceDeps;
  readonly store: BuiltinMemoryStore;
  #cachedDoc: BuiltinMemoryDocState = clone(BuiltinMemoryDoc.definition.initial()) as unknown as BuiltinMemoryDocState;
  #appliedClearEpoch = 0;
  #lastAppliedSeq = 0;
  #ready = false;
  #scrubBlocked = false;
  #failoverPaused = false;
  #replicaClearConfirmed: boolean | undefined;
  #mutations: Promise<unknown> = Promise.resolve();
  #idleTimer: ReturnType<typeof setInterval> | null = null;
  #idleScanning = false;
  #closed = false;
  #emptyRecallCache = new Map<number, string[]>();

  constructor(deps: BuiltinMemoryServiceDeps) {
    this.#deps = deps;
    this.store = new BuiltinMemoryStore({ stateDir: deps.stateDir });
    this.store.setOnWrite(() => deps.onStoreWrite?.());
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(work);
    this.#mutations = next.then(() => undefined, () => undefined);
    return next;
  }

  async #readDoc(context: Context = BACKGROUND_CONTEXT): Promise<BuiltinMemoryDocState> {
    const snap = await this.#deps.getHarness().snapshot(BuiltinMemoryDoc, context);
    if (snap) this.#cachedDoc = clone(snap) as unknown as BuiltinMemoryDocState;
    return this.#cachedDoc;
  }

  get clearBarrierActive(): boolean {
    return this.#appliedClearEpoch < this.#cachedDoc.clearTargetEpoch;
  }

  get isBlocked(): boolean {
    return !this.#ready || this.#scrubBlocked || this.#failoverPaused || this.clearBarrierActive;
  }

  async hydratePaused(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#serialize(async () => {
      await this.#readDoc(context);
      const meta = await this.store.getMetaSnapshot().catch(() => undefined);
      if (meta) {
        this.#appliedClearEpoch = meta.appliedClearEpoch;
        this.#lastAppliedSeq = meta.lastAppliedSeq;
      }
    });
  }

  setScrubBlocked(blocked: boolean): void {
    this.#scrubBlocked = blocked;
  }

  setFailoverPaused(paused: boolean): void {
    this.#failoverPaused = paused;
  }

  setReplicaClearConfirmed(confirmed: boolean | undefined): void {
    this.#replicaClearConfirmed = confirmed;
  }

  isEffectiveActive(): boolean {
    if (this.#closed || this.isBlocked) return false;
    if (!this.#cachedDoc.enabled) return false;
    return !this.#deps.getEffectiveMemoryConfig().enabled;
  }

  /** Preserves user's Hindsight `private-only` scope if loopback Hindsight degrades after host failover. */
  isSharedEffectiveActive(): boolean {
    if (!this.isEffectiveActive()) return false;
    const raw = this.#deps.getRawMemoryConfig?.() ?? this.#deps.getEffectiveMemoryConfig();
    if (raw.enabled && raw.accessMode === "private-only") return false;
    return true;
  }

  getActiveMemoryMode(): ActiveMemoryMode {
    if (this.#deps.getEffectiveMemoryConfig().enabled) return "hindsight";
    return this.isEffectiveActive() ? "builtin" : "none";
  }

  getExternalMemoryMode(): ExternalMemoryMode | "none" {
    const effective = this.#deps.getEffectiveMemoryConfig();
    if (effective.enabled) return effective.accessMode === "private-only" ? "none" : "hindsight";
    return this.isSharedEffectiveActive() ? "builtin" : "none";
  }

  getCurrentEpochs(): { clearTargetEpoch: number; engineEpoch: number } {
    return { clearTargetEpoch: this.#cachedDoc.clearTargetEpoch, engineEpoch: this.#cachedDoc.engineEpoch };
  }

  getFloorCursor(conversationId: number): BuiltinMemoryFloorCursor | undefined {
    return this.#cachedDoc.floorCursors?.[String(conversationId)];
  }

  getClusterMeta(): BuiltinMemoryClusterMeta {
    return {
      clearTargetEpoch: this.#cachedDoc.clearTargetEpoch,
      appliedClearEpoch: this.#appliedClearEpoch,
      lastAppliedSeq: this.#lastAppliedSeq,
    };
  }

  buildStateView(doc: BuiltinMemoryDocState = this.#cachedDoc): BuiltinMemoryStateView {
    const supersededByHindsight = Boolean(this.#deps.getEffectiveMemoryConfig().enabled);
    const blocked = this.isBlocked;
    return {
      enabled: Boolean(doc.enabled),
      revision: doc.revision,
      clearTargetEpoch: doc.clearTargetEpoch,
      appliedClearEpoch: this.#appliedClearEpoch,
      engineEpoch: doc.engineEpoch,
      clearedAt: doc.clearedAt,
      supersededByHindsight,
      ...(blocked ? { blocked: true } : {}),
      ...(this.#deps.isClusterStandbyActive?.() && this.#replicaClearConfirmed !== undefined
        ? { replicaClearConfirmed: this.#replicaClearConfirmed }
        : {}),
    };
  }

  async getStateView(context: Context = BACKGROUND_CONTEXT): Promise<BuiltinMemoryStateView> {
    const doc = await this.#readDoc(context);
    const meta = await this.store.getMetaSnapshot().catch(() => undefined);
    if (meta) {
      this.#appliedClearEpoch = meta.appliedClearEpoch;
      this.#lastAppliedSeq = meta.lastAppliedSeq;
    }
    return this.buildStateView(doc);
  }

  async start(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.#closed) return;
    const prevActive = this.isEffectiveActive();
    await this.#serialize(async () => {
      const harness = this.#deps.getHarness();
      const doc = await this.#readDoc(context);
      const meta = await this.store.getMetaSnapshot();
      this.#appliedClearEpoch = meta.appliedClearEpoch;
      this.#lastAppliedSeq = meta.lastAppliedSeq;

      // 1. Crash-recovery barrier: finish any clear committed in kulo.sqlite before memory.sqlite finished.
      if (this.#appliedClearEpoch < doc.clearTargetEpoch) {
        const res = await this.store.clearAll(doc.clearTargetEpoch);
        this.#appliedClearEpoch = res.appliedClearEpoch;
        this.#lastAppliedSeq = 0;
        await revokeBuiltinRecallsInConversations(harness, { clearEpochBelow: doc.clearTargetEpoch }, "clear_recovery", context);
      }

      // 2. Establish baseline watermarks once on first enable so upgrades never back-sweep legacy history.
      if (!doc.initializedWatermarks) {
        await harness.commit(async (tx) => {
          const cur = await tx.doc(BuiltinMemoryDoc);
          if (cur.initializedWatermarks) return;
          await this.#advanceWatermarksInTx(tx, cur);
          cur.initializedWatermarks = true;
        }, context);
        await this.#readDoc(context);
      }

      this.#ready = true;
      // 3. Drain retryable purges & Outbox deliveries persisted prior to restart.
      await this.#drainPurgesLocked(context);
      await this.#drainDeliveriesLocked(context);
    });
    if (prevActive !== this.isEffectiveActive()) {
      await this.#deps.onModeChanged?.(this.buildStateView());
    }

    this.#ensureIdleTimer();
  }

  #ensureIdleTimer(): void {
    if (!this.#idleTimer && !process.env.VITEST) {
      this.#idleTimer = setInterval(() => {
        void this.runIdleMaintenanceTick(BACKGROUND_CONTEXT).catch(() => {});
      }, IDLE_SCAN_INTERVAL_MS);
      this.#idleTimer.unref?.();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = null;
    }
    await this.#mutations;
    await this.store.close();
  }

  async setEnabled(enabled: boolean, expectedRevision: number, context: Context = BACKGROUND_CONTEXT): Promise<BuiltinMemoryStateView> {
    if (typeof enabled !== "boolean") {
      throw new BuiltinMemoryError(400, "invalid_builtin_memory_request", "启用状态必须为布尔值。");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new BuiltinMemoryError(400, "invalid_builtin_memory_request", "配置版本号无效。");
    }
    return this.#serialize(async () => {
      const harness = this.#deps.getHarness();
      let changed = false;
      await harness.commit(async (tx) => {
        const doc = await tx.doc(BuiltinMemoryDoc);
        if (doc.revision !== expectedRevision) {
          throw new BuiltinMemoryError(409, "builtin_memory_conflict", "内置记忆设置已在其他窗口更新，请重试。");
        }
        if (doc.enabled === enabled) return;
        const wasDisabled = !doc.enabled;
        doc.enabled = enabled;
        doc.userExplicitlyDisabled = !enabled;
        doc.revision += 1;
        doc.engineEpoch += 1;
        changed = true;
        if (wasDisabled && enabled) {
          await this.#advanceWatermarksInTx(tx, doc);
          doc.initializedWatermarks = true;
        }
      }, context);
      const nextDoc = await this.#readDoc(context);
      const view = this.buildStateView(nextDoc);
      if (changed) {
        if (!enabled) await this.#deps.abortIdleFlushTasks?.(context).catch(() => {});
        await this.#deps.onModeChanged?.(view);
      }
      return view;
    });
  }

  async onExternalEngineChanged(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#serialize(async () => {
      await this.#deps.getHarness().commit(async (tx) => {
        const doc = await tx.doc(BuiltinMemoryDoc);
        doc.engineEpoch += 1;
        if (!this.#deps.getEffectiveMemoryConfig().enabled && doc.enabled) {
          await this.#advanceWatermarksInTx(tx, doc);
        }
      }, context);
      const nextDoc = await this.#readDoc(context);
      await this.#deps.onModeChanged?.(this.buildStateView(nextDoc));
    });
  }

  async #advanceWatermarksInTx(tx: Tx, doc: BuiltinMemoryDocState): Promise<void> {
    await advanceFloorCursorsInTx(tx, doc, collectAllConversationIds(await tx.doc(KuloStateDoc)));
  }

  async clearAll(
    input: { confirm: true; expectedEpoch: number; operationId: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<BuiltinMemoryStateView> {
    const operationId = input.operationId?.trim();
    if (input.confirm !== true || !operationId || operationId.length > 128 || /[\x00-\x1f\x7f]/.test(operationId)) {
      throw new BuiltinMemoryError(400, "invalid_builtin_memory_clear", "清空内置记忆请求无效。");
    }
    if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0) {
      throw new BuiltinMemoryError(400, "invalid_builtin_memory_clear", "清空代次无效。");
    }

    return this.#serialize(async () => {
      const harness = this.#deps.getHarness();
      const now = this.#now();

      const txOutcome = await harness.commit(async (tx) => {
        const doc = await tx.doc(BuiltinMemoryDoc);
        if (doc.lastClearOp?.operationId === operationId) {
          return { deduplicated: true, targetEpoch: doc.lastClearOp.targetEpoch };
        }
        if (doc.clearTargetEpoch !== input.expectedEpoch) {
          throw new BuiltinMemoryError(409, "builtin_memory_clear_conflict", "内置记忆状态已变更，请刷新后重试。");
        }
        const nextEpoch = doc.clearTargetEpoch + 1;
        doc.clearTargetEpoch = nextEpoch;
        doc.revision += 1;
        doc.engineEpoch += 1;
        doc.clearedAt = now;
        doc.lastClearOp = { operationId, targetEpoch: nextEpoch, clearedAt: now };
        doc.pendingDeliveries = {};
        await advanceFloorCursorsInTx(tx, doc, collectAllConversationIds(await tx.doc(KuloStateDoc)));
        doc.initializedWatermarks = true;
        return { deduplicated: false, targetEpoch: nextEpoch };
      }, context);

      const updatedDoc = await this.#readDoc(context);
      this.#replicaClearConfirmed = this.#deps.isClusterStandbyActive?.() ? false : undefined;
      this.#emptyRecallCache.clear();
      await this.#deps.abortIdleFlushTasks?.(context).catch(() => {});

      if (this.#appliedClearEpoch < txOutcome.targetEpoch || this.#failoverPaused) {
        const cleared = await this.store.clearAll(txOutcome.targetEpoch);
        this.#appliedClearEpoch = cleared.appliedClearEpoch;
        this.#lastAppliedSeq = 0;
        if (this.#failoverPaused) {
          try { fs.rmSync(path.join(this.#deps.stateDir, BUILTIN_MEMORY_FAILOVER_PAUSE_FILE), { force: true }); } catch { /* ignore */ }
          this.#failoverPaused = false;
          this.#ready = true;
          this.#ensureIdleTimer();
        }
      }

      if (!txOutcome.deduplicated) {
        await revokeBuiltinRecallsInConversations(harness, { clearEpochBelow: txOutcome.targetEpoch }, "builtin_memory_clear", context);
      }

      const view = this.buildStateView(updatedDoc);
      await this.#deps.onModeChanged?.(view);
      return view;
    });
  }

  #validateAndSanitizeContent(content: string): string {
    const cleaned = this.#deps.redact(redactSensitiveText(content)).replace(/\s+/g, " ").trim();
    if (!cleaned) throw new BuiltinMemoryError(400, "empty_memory_content", "记忆内容不能为空。");
    if (cleaned.length > 1_200) throw new BuiltinMemoryError(400, "memory_too_long", "单条内置记忆长度不能超过 1200 字符。");
    if (!isSafeMemoryText(cleaned)) throw new BuiltinMemoryError(400, "unsafe_memory_content", "记忆内容包含敏感凭据，已拒绝写入。");
    if (isSuspiciousMemoryInstruction(cleaned)) throw new BuiltinMemoryError(400, "suspicious_memory_instruction", "记忆内容包含可疑指令片段，已拒绝写入。");
    return cleaned;
  }

  async #assertNotForgotten(content: string, context: Context): Promise<void> {
    const personality = await this.#deps.getHarness().snapshot(PersonalityDoc, context);
    const terms: readonly ForgottenTermEntry[] = personality?.forgottenTerms ?? [];
    const matched = findMatchingForgottenTerm(content, terms);
    if (matched) {
      throw new BuiltinMemoryError(400, "forgotten_memory_term", `拒绝写入私有记忆：内容命中用户已遗忘词条「${matched.term}」。`);
    }
  }

  async #resolveTopicStateMap(context: Context): Promise<(topicId: string) => { deleted: boolean; projectId?: string | null } | undefined> {
    const state = await this.#deps.getHarness().snapshot(KuloStateDoc, context);
    const topics = state?.topics ?? {};
    return (topicId: string) => {
      const topic = topics[topicId];
      if (!topic) return undefined;
      return { deleted: topic.deletedAt !== undefined, projectId: topic.projectId ?? null };
    };
  }

  async retainFromTool(
    input: {
      caller: MemoryCallerContext;
      bank: MemoryBank;
      content: string;
      scope?: BuiltinMemoryScopeKind;
      category?: BuiltinMemoryCategory;
      callId: string;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ id: string; bank: MemoryBank; inserted: boolean }> {
    if (!this.isEffectiveActive()) throw new BuiltinMemoryError(409, "builtin_memory_inactive", "内置记忆当前未激活。");
    if (input.bank === "shared" && !this.isSharedEffectiveActive()) {
      throw new BuiltinMemoryError(403, "builtin_shared_disabled", "共享项目记忆当前未开启。");
    }
    const epochs = this.getCurrentEpochs();
    const safeContent = this.#validateAndSanitizeContent(input.content);
    if (input.bank === "private") await this.#assertNotForgotten(safeContent, context);

    const state = await this.#deps.getHarness().snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[input.caller.conversationId];
    const scopeKind: BuiltinMemoryScopeKind =
      input.bank === "shared" ? "project" : input.scope ?? (input.caller.projectId ? "project" : "global");
    const effectiveScope: BuiltinMemoryScopeKind =
      scopeKind === "topic" && !topicId
        ? input.caller.projectId ? "project" : "global"
        : scopeKind === "project" && !input.caller.projectId
          ? "global"
          : scopeKind;

    return this.#serialize(async () => {
      if (!this.isEffectiveActive() || this.isBlocked || this.#cachedDoc.clearTargetEpoch !== epochs.clearTargetEpoch || this.#cachedDoc.engineEpoch !== epochs.engineEpoch) {
        throw new BuiltinMemoryError(409, "builtin_memory_epoch_changed", "内置记忆状态已变更，请重试。");
      }
      if (input.bank === "shared" && !this.isSharedEffectiveActive()) {
        throw new BuiltinMemoryError(403, "builtin_shared_disabled", "共享项目记忆当前未开启。");
      }
      const res = await this.store.retain({
        callerRole: input.caller.role,
        bank: input.bank,
        scopeKind: effectiveScope,
        ...(input.caller.projectId ? { projectId: input.caller.projectId } : {}),
        ...(topicId && input.bank === "private" ? { topicId } : {}),
        ...(Number.isSafeInteger(Number(input.caller.conversationId)) ? { conversationId: Number(input.caller.conversationId) } : {}),
        ...(input.caller.ticketId ? { ticketId: input.caller.ticketId } : {}),
        source: "tool",
        sourceId: `tool:${input.bank}:${input.callId}`,
        evidenceLevel: input.caller.role === "router" ? "user_decision" : "ticket_outcome",
        category: input.category ?? "fact",
        content: safeContent,
        expectedAppliedClearEpoch: epochs.clearTargetEpoch,
        now: this.#now(),
      });
      this.#lastAppliedSeq = Math.max(this.#lastAppliedSeq, res.seq);
      return { id: res.id, bank: res.bank, inserted: res.inserted };
    });
  }

  async recallForTool(
    input: {
      caller: MemoryCallerContext;
      bank: MemoryBank;
      query: string;
      scope?: BuiltinMemoryScopeKind;
      limit?: number;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<BuiltinMemoryRecallHit[]> {
    if (!this.isEffectiveActive()) return [];
    if (input.bank === "shared" && !this.isSharedEffectiveActive()) return [];
    const state = await this.#deps.getHarness().snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[input.caller.conversationId];
    const resolveTopicState = await this.#resolveTopicStateMap(context);
    return this.store.recall(input.query, {
      callerRole: input.caller.role,
      bank: input.bank,
      ...(input.caller.projectId ? { projectId: input.caller.projectId } : {}),
      ...(topicId ? { topicId } : {}),
      ...(input.scope ? { scopeFilter: input.scope } : {}),
      limit: input.limit ?? 6,
      resolveTopicState,
      now: this.#now(),
    });
  }

  /**
   * Atomically enqueues verified flush records into `BuiltinMemoryDoc.pendingDeliveries` inside the caller's
   * `kulo.sqlite` commit transaction, strictly enforcing `clearTargetEpoch`, `engineEpoch`, and `floorCursors`.
   */
  async enqueueFlushDeliveriesInTx(
    tx: Tx,
    input: {
      conversationId: number;
      records: readonly WorkingMemoryRecord[];
      forgottenTerms: readonly { term: string }[];
      expectedClearEpoch?: number;
      expectedEngineEpoch?: number;
      advanceIdleFloorEntryId?: number;
      advanceIdleFloorCharOffset?: number;
    },
  ): Promise<number> {
    if (!this.isEffectiveActive()) return 0;
    const doc = await tx.doc(BuiltinMemoryDoc);
    if (!doc.enabled) return 0;
    if (input.expectedClearEpoch !== undefined && doc.clearTargetEpoch !== input.expectedClearEpoch) return 0;
    if (input.expectedEngineEpoch !== undefined && doc.engineEpoch !== input.expectedEngineEpoch) return 0;
    return enqueueFlushRecordsIntoDoc(doc, {
      conversationId: input.conversationId,
      records: input.records,
      forgottenTerms: input.forgottenTerms,
      redact: this.#deps.redact,
      now: this.#now(),
      maxPending: MAX_PENDING_DELIVERIES,
      ...(input.advanceIdleFloorEntryId !== undefined ? { advanceIdleFloorEntryId: input.advanceIdleFloorEntryId } : {}),
      ...(input.advanceIdleFloorCharOffset !== undefined ? { advanceIdleFloorCharOffset: input.advanceIdleFloorCharOffset } : {}),
    });
  }

  async drainOutbox(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#readDoc(context);
    await this.#serialize(() => this.#drainDeliveriesLocked(context));
  }

  async #drainDeliveriesLocked(context: Context): Promise<void> {
    if (this.isBlocked || !this.#cachedDoc.enabled) return;
    const doc = await this.#readDoc(context);
    const entries = Object.values(doc.pendingDeliveries ?? {});
    if (entries.length === 0) return;
    const [liveState, liveProjects, personality] = await Promise.all([
      this.#deps.getHarness().snapshot(KuloStateDoc, context),
      this.#deps.getHarness().snapshot(KuloProjectsDoc, context),
      this.#deps.getHarness().snapshot(PersonalityDoc, context),
    ]);
    const forgottenTerms: readonly ForgottenTermEntry[] = personality?.forgottenTerms ?? [];
    const completedIds: string[] = [];
    for (const item of entries) {
      if (item.clearEpoch !== doc.clearTargetEpoch || item.engineEpoch !== doc.engineEpoch) {
        completedIds.push(item.sourceId);
        continue;
      }
      if (!this.isEffectiveActive() || (item.bank === "shared" && !this.isSharedEffectiveActive())) break;
      const liveTopicId = item.conversationId !== undefined ? (liveState?.conversationToTopic?.[String(item.conversationId)] ?? item.topicId) : item.topicId;
      if (liveTopicId && liveState?.topics?.[liveTopicId]?.deletedAt !== undefined) {
        completedIds.push(item.sourceId);
        continue;
      }
      if (item.projectId && (!liveProjects?.projects?.[item.projectId] || liveProjects.projects[item.projectId]?.deletedAt !== undefined)) {
        completedIds.push(item.sourceId);
        continue;
      }
      if (item.bank === "private" && forgottenTerms.length > 0 && findMatchingForgottenTerm(item.content, forgottenTerms)) {
        completedIds.push(item.sourceId);
        continue;
      }
      try {
        const res = await this.store.retain(buildDeliveryRetainPayload(item, liveTopicId, doc.clearTargetEpoch));
        this.#lastAppliedSeq = Math.max(this.#lastAppliedSeq, res.seq);
        completedIds.push(item.sourceId);
      } catch (error) {
        if (error instanceof BuiltinMemoryStoreError && (error.code === "FORBIDDEN" || error.code === "INVALID_ARGUMENT" || error.code === "EPOCH_MISMATCH")) {
          completedIds.push(item.sourceId);
        } else {
          break;
        }
      }
    }
    if (completedIds.length > 0) {
      await this.#deps.getHarness().commit(async (tx) => {
        const live = await tx.doc(BuiltinMemoryDoc);
        for (const id of completedIds) delete live.pendingDeliveries[id];
      }, context);
      await this.#readDoc(context);
    }
  }

  async retainWorkerOrExternalReport(
    input: {
      source: "worklog" | "external_report";
      sourceId: string;
      ticket: Readonly<TicketRecord>;
      content: string;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> {
    if (!this.isSharedEffectiveActive() || !input.ticket.projectId) return false;
    const epochs = this.getCurrentEpochs();
    const safe = this.#deps.redact(redactSensitiveText(input.content)).replace(/\s+/g, " ").trim();
    if (!safe || !isSafeMemoryText(safe) || isSuspiciousMemoryInstruction(safe)) return false;
    const bounded = safe.length > 1_200 ? `${safe.slice(0, 1_199).trimEnd()}…` : safe;
    const item: BuiltinMemoryDeliveryItem = {
      sourceId: input.sourceId,
      bank: "shared",
      scopeKind: "project",
      projectId: input.ticket.projectId,
      conversationId: input.ticket.workerConversationId,
      ticketId: input.ticket.id,
      source: input.source,
      evidenceLevel: "ticket_outcome",
      category: "worklog",
      durability: "temporary",
      content: bounded,
      clearEpoch: epochs.clearTargetEpoch,
      engineEpoch: epochs.engineEpoch,
      createdAt: this.#now(),
    };
    await this.#deps.getHarness().commit(async (tx) => {
      const doc = await tx.doc(BuiltinMemoryDoc);
      if (doc.clearTargetEpoch !== epochs.clearTargetEpoch || doc.engineEpoch !== epochs.engineEpoch) return;
      doc.pendingDeliveries[item.sourceId] = item;
    }, context);
    await this.drainOutbox(context);
    return true;
  }

  async retainExternalMcpMemory(
    input: { ticket: Readonly<TicketRecord>; runId: string; title: string; content: string },
    _context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ id: string; bank: MemoryBank }> {
    if (!this.isSharedEffectiveActive() || !input.ticket.projectId) {
      throw new BuiltinMemoryError(403, "builtin_shared_disabled", "共享项目记忆当前未开启。");
    }
    const epochs = this.getCurrentEpochs();
    const combined = `${input.title.trim()}: ${input.content.trim()}`;
    const safe = this.#validateAndSanitizeContent(combined);
    const deterministicHash = createHash("sha256").update(`${input.runId}\0${safe}`).digest("hex").slice(0, 24);
    return this.#serialize(async () => {
      if (!this.isSharedEffectiveActive() || this.isBlocked || this.#cachedDoc.clearTargetEpoch !== epochs.clearTargetEpoch || this.#cachedDoc.engineEpoch !== epochs.engineEpoch) {
        throw new BuiltinMemoryError(409, "builtin_memory_epoch_changed", "内置记忆状态已变更，请重试。");
      }
      const res = await this.store.retain({
        callerRole: "worker",
        bank: "shared",
        scopeKind: "project",
        projectId: input.ticket.projectId!,
        conversationId: input.ticket.workerConversationId,
        ticketId: input.ticket.id,
        source: "tool",
        sourceId: `external-mcp:${input.runId}:${deterministicHash}`,
        evidenceLevel: "ticket_outcome",
        category: "fact",
        content: safe,
        expectedAppliedClearEpoch: epochs.clearTargetEpoch,
        now: this.#now(),
      });
      this.#lastAppliedSeq = Math.max(this.#lastAppliedSeq, res.seq);
      return { id: res.id, bank: res.bank };
    });
  }

  async recallForWorkerTicket(
    ticket: Readonly<TicketRecord>,
    query: string,
    limit = 6,
    _context: Context = BACKGROUND_CONTEXT,
  ): Promise<BuiltinMemoryRecallHit[]> {
    if (!this.isSharedEffectiveActive() || !ticket.projectId) return [];
    return this.store.recall(query, {
      callerRole: "worker",
      bank: "shared",
      projectId: ticket.projectId,
      scopeFilter: "project",
      limit,
      now: this.#now(),
    });
  }

  async recallForVoice(
    input: { conversationId: number; projectId?: string; query: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ privateText: string; sharedText: string }> {
    if (!this.isEffectiveActive()) return { privateText: "", sharedText: "" };
    const state = await this.#deps.getHarness().snapshot(KuloStateDoc, context);
    const topicId = state?.conversationToTopic?.[String(input.conversationId)];
    const resolveTopicState = await this.#resolveTopicStateMap(context);
    const privateHits = await this.store.recall(input.query, {
      callerRole: "router",
      bank: "private",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(topicId ? { topicId } : {}),
      limit: 6,
      resolveTopicState,
      now: this.#now(),
    });
    const sharedHits =
      input.projectId && this.isSharedEffectiveActive()
        ? await this.store.recall(input.query, {
            callerRole: "router",
            bank: "shared",
            projectId: input.projectId,
            scopeFilter: "project",
            limit: 4,
            now: this.#now(),
          })
        : [];
    const format = (hits: readonly BuiltinMemoryRecallHit[]) =>
      hits.map((h) => `- [${new Date(h.updatedAt || h.createdAt).toISOString().slice(0, 10)}] ${this.#deps.redact(h.content)}`).join("\n");
    return { privateText: format(privateHits), sharedText: format(sharedHits) };
  }

  async forgetPrivateTerm(term: string, context: Context = BACKGROUND_CONTEXT): Promise<{ removedRecords: number }> {
    return this.#serialize(async () => {
      await this.#deps.getHarness().commit(async (tx) => {
        pruneForgottenPendingDeliveries(await tx.doc(BuiltinMemoryDoc), term);
      }, context);
      await this.#readDoc(context);
      const res = await this.store.forgetPrivateTerm(term);
      if (res.removedIds.length > 0) {
        await revokeBuiltinRecallsInConversations(
          this.#deps.getHarness(),
          { memoryIds: new Set(res.removedIds) },
          `forget:${term}`,
          context,
        );
      }
      return { removedRecords: res.removedRecords };
    });
  }

  async schedulePurgeScope(
    scope: { kind: "topic" | "project"; targetId: string; conversationIds?: readonly number[] },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    await this.#deps.getHarness().commit(async (tx) => {
      const doc = await tx.doc(BuiltinMemoryDoc);
      doc.pendingPurges ??= [];
      doc.pendingPurges.push({
        id: randomUUID(),
        kind: scope.kind,
        targetId: scope.targetId,
        ...(scope.conversationIds?.length ? { conversationIds: [...scope.conversationIds] } : {}),
        createdAt: this.#now(),
      });
      if (doc.pendingPurges.length > MAX_PENDING_PURGES) {
        doc.pendingPurges = doc.pendingPurges.slice(-MAX_PENDING_PURGES);
      }
      if (scope.conversationIds?.length) {
        await advanceFloorCursorsInTx(tx, doc, scope.conversationIds);
      }
      prunePendingDeliveriesForScope(doc, scope);
    }, context);
    await this.#readDoc(context);
    await this.#serialize(() => this.#drainPurgesLocked(context));
  }

  async #drainPurgesLocked(context: Context): Promise<void> {
    const doc = await this.#readDoc(context);
    const purges = doc.pendingPurges ?? [];
    if (purges.length === 0) return;
    const doneIds = new Set<string>();
    const revokedMemoryIds = new Set<string>();
    for (const purge of purges) {
      try {
        const res = await this.store.purgeScope({
          ...(purge.kind === "topic" ? { topicId: purge.targetId } : { projectId: purge.targetId }),
          ...(purge.conversationIds?.length ? { conversationIds: purge.conversationIds } : {}),
        });
        for (const id of res.removedIds) revokedMemoryIds.add(id);
        doneIds.add(purge.id);
      } catch {
        break;
      }
    }
    if (revokedMemoryIds.size > 0) {
      await revokeBuiltinRecallsInConversations(
        this.#deps.getHarness(),
        { memoryIds: revokedMemoryIds },
        "scope_purge",
        context,
      ).catch(() => {});
    }
    if (doneIds.size > 0) {
      await this.#deps.getHarness().commit(async (tx) => {
        const live = await tx.doc(BuiltinMemoryDoc);
        live.pendingPurges = (live.pendingPurges ?? []).filter((p) => !doneIds.has(p.id));
      }, context);
      await this.#readDoc(context);
    }
  }

  async onTopicMoved(topicId: string, nextProjectId: string | null, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#serialize(async () => {
      await this.store.reassignTopicProject(topicId, nextProjectId);
      await this.#readDoc(context);
    });
  }

  async rebindArchivedRootConversation(oldConvId: number, archivedTopicId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#serialize(async () => {
      await this.#deps.getHarness().commit(async (tx) => {
        const live = await tx.doc(BuiltinMemoryDoc);
        for (const item of Object.values(live.pendingDeliveries ?? {})) {
          if (item.conversationId === oldConvId && item.topicId === "root") item.topicId = archivedTopicId;
        }
      }, context);
      await this.store.rebindConversationTopic(oldConvId, "root", archivedTopicId);
      await this.#readDoc(context);
    });
  }

  async runIdleMaintenanceTick(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.#closed || this.#idleScanning) return;
    this.#idleScanning = true;
    try {
      await this.#serialize(async () => {
        await this.#drainPurgesLocked(context);
        await this.#drainDeliveriesLocked(context);
      });
      if (!this.isEffectiveActive() || !this.#deps.scheduleIdleFlush) return;
      const doc = await this.#readDoc(context);
      await scanIdleTopicsForBuiltinMemory({
        harness: this.#deps.getHarness(),
        doc,
        now: this.#now(),
        scheduleIdleFlush: this.#deps.scheduleIdleFlush,
        context,
      });
    } finally {
      this.#idleScanning = false;
    }
  }

  createRecallExtension() {
    return createBuiltinMemoryRecallExtension({
      getHarness: this.#deps.getHarness,
      getStore: () => this.store,
      isEffectiveActive: () => this.isEffectiveActive(),
      getClearTargetEpoch: () => this.#cachedDoc.clearTargetEpoch,
      resolveTopicStateMap: (ctx) => this.#resolveTopicStateMap(ctx),
      redact: this.#deps.redact,
      now: () => this.#now(),
      emptyRecallCache: this.#emptyRecallCache,
    });
  }
}
