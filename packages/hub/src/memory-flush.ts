import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTask,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { MainArchiveFlushStatus } from "@kulo/protocol";
import {
  buildContinuousFlushBatch,
  isCursorAhead,
  parseFlushExtraction,
  type FlushedSourceRole,
  type ScannedBatchItem,
} from "./memory-flush-extract.js";
import { PersonalityDoc } from "./personality.js";
import { KuloProjectsDoc } from "./projects.js";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-doc.js";
import { KuloStateDoc, isOrchestratorConversation, resolveActiveRootConversationId } from "./state.js";
import {
  KuloWorkingMemoryDoc,
  commitWorkingMemory,
  tryCommitWorkingMemory,
  upsertWorkingMemoryRecord,
  type ConversationMemoryCursor,
  type WorkingMemoryRecord,
} from "./working-memory.js";

export {
  buildContinuousFlushBatch,
  verifyFlushExtraction,
  type FlushedSourceRole,
  type ScannedBatchItem,
} from "./memory-flush-extract.js";

export const MEMORY_FLUSH_TASK_NAME = "kulo.memory-flush";
export const MEMORY_FLUSH_BATCH_BUDGET_CHARS = 24_000;
const MEMORY_FLUSH_MAX_BATCHES_PER_STEP = 12;
const MEMORY_FLUSH_FAILURE_BACKOFF_BASE_MS = 60_000;
const MEMORY_FLUSH_FAILURE_BACKOFF_MAX_MS = 30 * 60_000;

export interface MemoryFlushHost {
  getHarness: () => Harness;
  redact: (text: string) => string;
  isClosed: () => boolean;
  isRecovering: () => boolean;
  isHandoverBarrierActive: () => boolean;
  isPersonalityCapped: () => { capped: boolean; resetAt?: number };
  willUseCloudModel: () => Promise<boolean>;
  completeZeroToolJson: (input: {
    systemPrompt: string;
    userContent: string;
    maxTokens?: number;
    signal?: AbortSignal;
    allowCloudFallback?: boolean;
  }) => Promise<string>;
  onRecordsCommitted?: (records: readonly WorkingMemoryRecord[], context: Context) => Promise<void>;
  onActiveRootMemoryUpdated?: (activeRootConversationId: number, context: Context) => Promise<void>;
  getBuiltinMemoryEpochs?: () => { clearTargetEpoch: number; engineEpoch: number };
  getBuiltinMemoryFloorCursor?: (conversationId: number) => { cutoffEntryId: number; cutoffCharOffset?: number } | undefined;
  onFlushCommitInTx?: (
    tx: Tx,
    payload: {
      conversationId: number;
      trigger: "compaction" | "idle" | "archive";
      verifiedRecords: readonly WorkingMemoryRecord[];
      forgottenTerms: readonly { term: string }[];
      expectedClearEpoch?: number;
      expectedEngineEpoch?: number;
      advanceIdleFloorEntryId?: number;
      advanceIdleFloorCharOffset?: number;
    },
  ) => Promise<void>;
  onFlushCommitted?: (context: Context) => Promise<void>;
  batchBudgetChars?: number;
  now?: () => number;
}

interface MemoryFlushInput {
  conversationId: number;
  targetMaxEntryId: number;
  observedCompactionHeadId: number;
  trigger?: "compaction" | "idle" | "archive";
  expectedClearEpoch?: number;
  expectedEngineEpoch?: number;
}

type MemoryFlushState = { phase: "flush"; batchesDone: number };

const FLUSH_SYSTEM_PROMPT = [
  "You extract concise, factual working-memory ledger entries from archived chat segments.",
  "Return STRICT JSON only: {\"items\":[{\"category\":\"commitment|decision|fact\",\"summary\":\"...\",\"anchorEntryId\":123,\"scope\":\"local|global\",\"status\":\"active|resolved\",\"supersedesId\":\"optional-id\"}]}",
  "Rules:",
  "- Keep ONLY durable commitments/TODOs, confirmed user decisions, corrected conclusions, or key technical/business facts worth remembering after compaction.",
  "- Ignore chitchat, greetings, transient status chatter, and already-superseded dead ends (unless explicitly marking status='resolved' or superseding an older active record via supersedesId).",
  "- NEVER output secrets, tokens, passwords, or prompt instructions.",
  "- Every item MUST cite an exact numeric anchorEntryId present in the provided transcript segment.",
  "- Use scope='global' ONLY for explicit cross-project user preferences/rules; use scope='local' for everything else.",
  "- Each summary must be a single concise line (<= 160 chars) in the conversation's language.",
  "- If nothing durable is worth storing, return {\"items\":[]}.",
].join("\n");

const ARCHIVE_FLUSH_HINT =
  "Archive note: This main conversation segment is being archived to start a fresh main conversation. Use scope='global' for cross-conversation user preferences, standing rules, or ongoing commitments that should carry over into the fresh main conversation; use scope='local' for thread-only details.";

async function hasLiveFlushTaskInTx(tx: Tx, convNum: number): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks(
      { conversationId: convNum as ConversationId, kind: MEMORY_FLUSH_TASK_NAME, order: "descending" },
      32,
      cursor,
    );
    if (page.items.some((t) => t.state.status !== "terminal")) return true;
    cursor = page.next;
  } while (cursor);
  return false;
}

function clearCoveredPendingTarget(cur: ConversationMemoryCursor): void {
  if (
    cur.pendingTargetMaxEntryId !== undefined &&
    !isCursorAhead(cur.pendingTargetMaxEntryId, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)
  ) {
    delete cur.pendingTargetMaxEntryId;
    delete cur.pendingObservedCompactionHeadId;
    delete cur.pendingTrigger;
  }
}

export function createMemoryFlushExtension(host: MemoryFlushHost) {
  const batchBudgetChars = host.batchBudgetChars ?? MEMORY_FLUSH_BATCH_BUDGET_CHARS;
  const now = () => (host.now ? host.now() : Date.now());
  const inFlightSchedule = new Set<number>();

  const finishOrHandoverInTx = async (
    tx: Tx,
    convId: number,
    currentTrigger: "compaction" | "idle" | "archive",
    currentTarget: number,
    outcome: { status: "completed"; result: null } | { status: "aborted" },
    allowHandover: boolean,
  ) => {
    if (allowHandover) {
      const txState = await tx.doc(KuloStateDoc);
      const convKey = String(convId);
      const txTopicId = txState.conversationToTopic?.[convKey];
      const txTopic = txTopicId ? txState.topics?.[txTopicId] : undefined;
      const topicAlive = Boolean(txTopicId && txTopic && txTopic.deletedAt === undefined && txTopic.conversationId === convId);
      if (topicAlive) {
        const wm = await tx.doc(KuloWorkingMemoryDoc);
        const pendingCur = wm.cursors[convKey];
        const pendingTarget = pendingCur?.pendingTargetMaxEntryId ?? 0;
        const shouldHandover =
          outcome.status !== "aborted" || currentTrigger === "idle" || pendingTarget > currentTarget;
        if (
          pendingCur &&
          shouldHandover &&
          pendingTarget > 0 &&
          isCursorAhead(pendingTarget, 0, pendingCur.lastFlushedEntryId ?? 0, pendingCur.lastFlushedCharOffset ?? 0)
        ) {
          const nextTrigger = pendingCur.pendingTrigger ?? "compaction";
          const nextHead = pendingCur.pendingObservedCompactionHeadId ?? 0;
          delete pendingCur.pendingObservedCompactionHeadId;
          if (nextTrigger !== "archive") {
            delete pendingCur.pendingTargetMaxEntryId;
            delete pendingCur.pendingTrigger;
          }
          await tx.createTask(
            flushTask,
            { conversationId: convId, targetMaxEntryId: pendingTarget, observedCompactionHeadId: nextHead, trigger: nextTrigger },
            { ownership: { kind: "conversation" }, conversationId: convId as ConversationId, background: true },
          );
        }
      }
    }
    return { status: "terminal" as const, outcome };
  };

  const flushTask = defineTask<MemoryFlushInput, MemoryFlushState, null>({
    name: MEMORY_FLUSH_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "flush", batchesDone: 0 }),
    phases: {
      flush: async (task, runtime, context) => {
        if (host.isClosed() || host.isRecovering() || host.isHandoverBarrierActive()) {
          await runtime.commit(async () => ({ status: "sleeping", until: runtime.now() + 30_000, checkpoint: task.state.checkpoint }), context);
          return;
        }
        const harness = host.getHarness();
        const convId = task.input.conversationId;
        const convKey = String(convId);
        const trigger = task.input.trigger ?? "compaction";
        const isIdle = trigger === "idle";
        const isArchive = trigger === "archive";

        const [state, settingsDoc, projects, wmDoc] = await Promise.all([
          harness.snapshot(KuloStateDoc, context),
          harness.snapshot(SettingsAssistantDoc, context),
          harness.snapshot(KuloProjectsDoc, context),
          harness.snapshot(KuloWorkingMemoryDoc, context),
        ]);

        // Abort cleanly if conversation is no longer an active chat topic.
        if (!isOrchestratorConversation(convId, state) || isActiveSettingsConversation(convId, settingsDoc)) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        const topicId = state?.conversationToTopic?.[convKey];
        const topic = topicId ? state?.topics?.[topicId] : undefined;
        if (!topicId || !topic || topic.deletedAt !== undefined || topic.conversationId !== convId) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        if (topic.projectId) {
          const proj = projects?.projects?.[topic.projectId];
          if (!proj || proj.deletedAt !== undefined) {
            await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
            return;
          }
        }

        const isIdleEpochStale = (): boolean => {
          if (!isIdle || !host.getBuiltinMemoryEpochs) return false;
          const live = host.getBuiltinMemoryEpochs();
          return (
            (task.input.expectedClearEpoch !== undefined && live.clearTargetEpoch !== task.input.expectedClearEpoch) ||
            (task.input.expectedEngineEpoch !== undefined && live.engineEpoch !== task.input.expectedEngineEpoch)
          );
        };
        if (isIdleEpochStale()) {
          await runtime.commit(
            (tx) => finishOrHandoverInTx(tx, convId, trigger, task.input.targetMaxEntryId, { status: "completed", result: null }, true),
            context,
          );
          return;
        }

        const cursor = wmDoc?.cursors?.[convKey] ?? { lastFlushedEntryId: 0 };
        if (cursor.nextFlushEligibleAt && runtime.now() < cursor.nextFlushEligibleAt) {
          await runtime.commit(async () => ({
            status: "sleeping",
            until: cursor.nextFlushEligibleAt!,
            checkpoint: task.state.checkpoint,
          }), context);
          return;
        }
        const baseFailures =
          cursor.nextFlushEligibleAt && runtime.now() >= cursor.nextFlushEligibleAt && (cursor.consecutiveFlushFailures ?? 0) >= 6
            ? 0
            : (cursor.consecutiveFlushFailures ?? 0);

        const effectiveTarget = isIdle
          ? task.input.targetMaxEntryId
          : Math.max(task.input.targetMaxEntryId, cursor.pendingTargetMaxEntryId ?? 0);

        let baseId = cursor.lastFlushedEntryId;
        let baseOff = cursor.lastFlushedCharOffset ?? 0;
        if (isIdle) {
          const floor = host.getBuiltinMemoryFloorCursor?.(convId);
          if (floor && isCursorAhead(floor.cutoffEntryId, floor.cutoffCharOffset ?? 0, baseId, baseOff)) {
            baseId = floor.cutoffEntryId;
            baseOff = floor.cutoffCharOffset ?? 0;
          }
        }
        const startEntryId = baseOff > 0 ? baseId : baseId + 1;
        const startCharOffset = baseOff;

        if (startEntryId > effectiveTarget) {
          if (!isIdle && cursor.pendingTargetMaxEntryId !== undefined) {
            await tryCommitWorkingMemory(harness, host.redact, (doc) => {
              const cur = doc.cursors[convKey];
              if (cur) clearCoveredPendingTarget(cur);
            }, context);
          }
          await runtime.commit(
            (tx) => finishOrHandoverInTx(tx, convId, trigger, effectiveTarget, { status: "completed", result: null }, true),
            context,
          );
          return;
        }

        const conversation = await harness.conversation(convId as ConversationId, context);
        if (!conversation) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }

        // Load a page of entries in ascending order within [startEntryId, effectiveTarget].
        const page = await conversation.entries(
          {
            minEntryId: startEntryId as EntryId,
            maxEntryId: effectiveTarget as EntryId,
            order: "ascending",
          },
          100,
          undefined,
          context,
        );

        if (page.items.length === 0) {
          if (isIdle) {
            if (!isIdleEpochStale()) {
              await commitWorkingMemory(harness, host.redact, () => {}, context, async (tx) => {
                await host.onFlushCommitInTx?.(tx, {
                  conversationId: convId, trigger: "idle", verifiedRecords: [], forgottenTerms: [],
                  expectedClearEpoch: task.input.expectedClearEpoch, expectedEngineEpoch: task.input.expectedEngineEpoch,
                  advanceIdleFloorEntryId: effectiveTarget, advanceIdleFloorCharOffset: 0,
                });
              });
            }
          } else {
            await tryCommitWorkingMemory(harness, host.redact, (doc) => {
              const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
              if (isCursorAhead(effectiveTarget, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) {
                cur.lastFlushedEntryId = effectiveTarget;
                delete cur.lastFlushedCharOffset;
              }
              cur.lastObservedCompactionHeadId = Math.max(cur.lastObservedCompactionHeadId ?? 0, task.input.observedCompactionHeadId);
              cur.lastFlushedAt = now();
              cur.consecutiveFlushFailures = 0;
              delete cur.nextFlushEligibleAt;
              clearCoveredPendingTarget(cur);
              doc.cursors[convKey] = cur;
            }, context);
          }
          await runtime.commit(
            (tx) => finishOrHandoverInTx(tx, convId, trigger, effectiveTarget, { status: "completed", result: null }, true),
            context,
          );
          return;
        }

        const batch = buildContinuousFlushBatch(
          page.items,
          startEntryId,
          startCharOffset,
          batchBudgetChars,
          host.redact,
        );

        // If page only had skippable entries (system/compaction/sync), advance cursor without calling LLM!
        if (batch.items.length === 0) {
          const advanceTo = Math.max(batch.nextLastFlushedEntryId, Number(page.items.at(-1)!.id));
          if (isIdle) {
            if (!isIdleEpochStale()) {
              await commitWorkingMemory(harness, host.redact, () => {}, context, async (tx) => {
                await host.onFlushCommitInTx?.(tx, {
                  conversationId: convId, trigger: "idle", verifiedRecords: [], forgottenTerms: [],
                  expectedClearEpoch: task.input.expectedClearEpoch, expectedEngineEpoch: task.input.expectedEngineEpoch,
                  advanceIdleFloorEntryId: advanceTo, advanceIdleFloorCharOffset: 0,
                });
              });
            }
          } else {
            await tryCommitWorkingMemory(harness, host.redact, (doc) => {
              const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
              if (isCursorAhead(advanceTo, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) {
                cur.lastFlushedEntryId = advanceTo;
                delete cur.lastFlushedCharOffset;
              }
              cur.lastObservedCompactionHeadId = Math.max(cur.lastObservedCompactionHeadId ?? 0, task.input.observedCompactionHeadId);
              clearCoveredPendingTarget(cur);
              doc.cursors[convKey] = cur;
            }, context);
          }
          const hasMorePages = Boolean(page.next) || advanceTo < effectiveTarget;
          await runtime.commit(
            async (tx) =>
              hasMorePages
                ? { status: "sleeping", until: runtime.now() + 100, checkpoint: { phase: "flush", batchesDone: task.state.checkpoint.batchesDone + 1 } }
                : finishOrHandoverInTx(tx, convId, trigger, effectiveTarget, { status: "completed", result: null }, true),
            context,
          );
          return;
        }

        // Check UsageCaps BEFORE calling ambient model; never silently fall back to cloud when capped!
        const cap = host.isPersonalityCapped();
        if (cap.capped && (await host.willUseCloudModel())) {
          const deferUntil = cap.resetAt && cap.resetAt > runtime.now() ? cap.resetAt : runtime.now() + 15 * 60_000;
          await tryCommitWorkingMemory(harness, host.redact, (doc) => {
            const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
            cur.nextFlushEligibleAt = deferUntil;
            doc.cursors[convKey] = cur;
          }, context);
          await runtime.commit(async () => ({
            status: "sleeping",
            until: deferUntil,
            checkpoint: task.state.checkpoint,
          }), context);
          return;
        }

        const existingBucketRecords = [
          ...(wmDoc?.buckets?.global ?? []),
          ...(topic.projectId ? wmDoc?.buckets?.[`project:${topic.projectId}`] ?? [] : []),
          ...(wmDoc?.buckets?.[`topic:${topicId}`] ?? []),
        ]
          .filter((r) => r.status === "active")
          .slice(0, 20)
          .map((r) => `- id=${r.id} [${r.category}] ${r.summary}`)
          .join("\n");

        const segmentText = batch.items
          .map((item) => `[entry#${item.entryId} role=${item.role}${item.isPartial ? ` offset=${item.charOffset}` : ""}]\n${item.text}`)
          .join("\n\n---\n\n");

        const userContent = [
          existingBucketRecords ? `Existing active records (cite supersedesId if corrected/resolved):\n${existingBucketRecords}\n` : "",
          `Transcript segment to extract from:\n${segmentText}`,
        ]
          .filter(Boolean)
          .join("\n");

        const recordFailureAndBackoff = async (errorCode?: unknown): Promise<void> => {
          const failures = baseFailures + 1;
          const deferMs =
            errorCode === "ambient_cloud_fallback_disallowed" && cap.resetAt && cap.resetAt > runtime.now()
              ? cap.resetAt - runtime.now()
              : Math.min(MEMORY_FLUSH_FAILURE_BACKOFF_MAX_MS, MEMORY_FLUSH_FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 5));
          const until = runtime.now() + deferMs;
          await tryCommitWorkingMemory(harness, host.redact, (doc) => {
            const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
            cur.consecutiveFlushFailures = failures;
            cur.nextFlushEligibleAt = until;
            doc.cursors[convKey] = cur;
          }, context);
          await runtime.commit(async () => (
            failures >= 6
              ? { status: "terminal", outcome: { status: "completed", result: null } }
              : { status: "sleeping", until, checkpoint: task.state.checkpoint }
          ), context);
        };

        let rawJson: string;
        try {
          rawJson = await host.completeZeroToolJson({
            systemPrompt: isArchive ? `${FLUSH_SYSTEM_PROMPT}\n${ARCHIVE_FLUSH_HINT}` : FLUSH_SYSTEM_PROMPT,
            userContent,
            maxTokens: 1_000,
            signal: runtime.signal,
            allowCloudFallback: !cap.capped,
          });
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const code = typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
          await recordFailureAndBackoff(code);
          return;
        }

        // Pre-commit live re-check of topic identity (may have rotated from "root" -> archivedTopicId), deletion & forgottenTerms!
        const [liveState, liveProjects, personalityDoc] = await Promise.all([
          harness.snapshot(KuloStateDoc, context),
          harness.snapshot(KuloProjectsDoc, context),
          harness.snapshot(PersonalityDoc, context),
        ]);
        const liveTopicId = liveState?.conversationToTopic?.[convKey];
        const liveTopic = liveTopicId ? liveState?.topics?.[liveTopicId] : undefined;
        if (!liveTopicId || !liveTopic || liveTopic.deletedAt !== undefined || liveTopic.conversationId !== convId) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        const liveProjectId = liveTopic.projectId;
        if (liveProjectId) {
          const liveProj = liveProjects?.projects?.[liveProjectId];
          if (!liveProj || liveProj.deletedAt !== undefined) {
            await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
            return;
          }
        }

        const parsed = parseFlushExtraction({
          rawJson,
          batch: batch.items,
          conversationId: convId,
          topicId: liveTopicId,
          projectId: liveProjectId ?? undefined,
          redact: host.redact,
          forgottenTerms: personalityDoc?.forgottenTerms,
          now: now(),
        });
        if (!parsed.ok) {
          await recordFailureAndBackoff(parsed.reason);
          return;
        }
        const verified = parsed.records;

        if (isIdleEpochStale()) {
          await runtime.commit(
            (tx) => finishOrHandoverInTx(tx, convId, trigger, effectiveTarget, { status: "completed", result: null }, true),
            context,
          );
          return;
        }

        const committedRecords: WorkingMemoryRecord[] = [];
        let abortedInTx = false;
        let effectiveTopic = liveTopic;
        let activeRootConvIdForNotify = resolveActiveRootConversationId(liveState);

        await commitWorkingMemory(
          harness,
          host.redact,
          (doc) => {
            for (const record of verified) {
              if (isIdle && record.evidenceLevel !== "user_decision" && record.bucketId !== "global") continue;
              const res = upsertWorkingMemoryRecord(doc, record);
              if (res.inserted) committedRecords.push(res.record);
            }
            const cur = doc.cursors[convKey] ?? { lastFlushedEntryId: 0 };
            if (!isIdle) {
              if (isCursorAhead(batch.nextLastFlushedEntryId, batch.nextLastFlushedCharOffset, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) {
                cur.lastFlushedEntryId = batch.nextLastFlushedEntryId;
                if (batch.nextLastFlushedCharOffset > 0) cur.lastFlushedCharOffset = batch.nextLastFlushedCharOffset;
                else delete cur.lastFlushedCharOffset;
              }
              cur.lastObservedCompactionHeadId = Math.max(cur.lastObservedCompactionHeadId ?? 0, task.input.observedCompactionHeadId);
              cur.lastFlushedAt = now();
              clearCoveredPendingTarget(cur);
            }
            cur.consecutiveFlushFailures = 0;
            delete cur.nextFlushEligibleAt;
            doc.cursors[convKey] = cur;
          },
          context,
          async (tx) => {
            await host.onFlushCommitInTx?.(tx, {
              conversationId: convId,
              trigger,
              verifiedRecords: verified,
              forgottenTerms: personalityDoc?.forgottenTerms ?? [],
              expectedClearEpoch: task.input.expectedClearEpoch,
              expectedEngineEpoch: task.input.expectedEngineEpoch,
              ...(isIdle ? { advanceIdleFloorEntryId: batch.nextLastFlushedEntryId, advanceIdleFloorCharOffset: batch.nextLastFlushedCharOffset } : {}),
            });
          },
          async (tx) => {
            const txState = await tx.doc(KuloStateDoc);
            const txTopicId = txState.conversationToTopic?.[convKey];
            const txTopic = txTopicId ? txState.topics?.[txTopicId] : undefined;
            if (!txTopicId || !txTopic || txTopic.deletedAt !== undefined || txTopic.conversationId !== convId) {
              abortedInTx = true;
              return false;
            }
            if (txTopicId !== liveTopicId) {
              const oldTopicBucket = `topic:${liveTopicId}`;
              const nextTopicBucket = `topic:${txTopicId}`;
              for (const rec of verified) {
                rec.provenance.topicId = txTopicId;
                if (rec.bucketId === oldTopicBucket) rec.bucketId = nextTopicBucket;
              }
              effectiveTopic = txTopic;
            }
            activeRootConvIdForNotify = resolveActiveRootConversationId(txState);
            return true;
          },
        );

        if (abortedInTx) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }

        if (committedRecords.length > 0 && host.onRecordsCommitted) {
          await host.onRecordsCommitted(committedRecords, context).catch(() => {});
        }
        if (host.onFlushCommitted) {
          await host.onFlushCommitted(context).catch(() => {});
        }
        if (
          committedRecords.length > 0 &&
          host.onActiveRootMemoryUpdated &&
          (effectiveTopic.archivedFromRoot || committedRecords.some((r) => r.bucketId === "global"))
        ) {
          await host.onActiveRootMemoryUpdated(activeRootConvIdForNotify, context).catch(() => {});
        }

        const moreRemains =
          batch.hasMoreInSlice ||
          Boolean(page.next) ||
          (batch.nextLastFlushedCharOffset === 0 && batch.nextLastFlushedEntryId < effectiveTarget);
        const batchesDone = task.state.checkpoint.batchesDone + 1;
        await runtime.commit(async (tx) => {
          if (moreRemains) {
            return batchesDone < MEMORY_FLUSH_MAX_BATCHES_PER_STEP
              ? { status: "sleeping", until: runtime.now() + 150, checkpoint: { phase: "flush", batchesDone } }
              : { status: "sleeping", until: runtime.now() + 5_000, checkpoint: { phase: "flush", batchesDone: 0 } };
          }
          return finishOrHandoverInTx(tx, convId, trigger, effectiveTarget, { status: "completed", result: null }, true);
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(
        (tx) =>
          finishOrHandoverInTx(
            tx,
            task.input.conversationId,
            task.input.trigger ?? "compaction",
            task.input.targetMaxEntryId,
            { status: "aborted" },
            true,
          ),
        context,
      );
    },
  });

  /**
   * Schedules a conversation-owned background flush after a committed `pi.compaction` marker.
   * Safe to call repeatedly; strictly deduplicates to max 1 active flush per conversation.
   */
  const scheduleForCompaction = async (
    conversationId: ConversationId,
    firstKept: number,
    observedCompactionHeadId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> => {
    const convNum = Number(conversationId);
    if (
      host.isClosed() ||
      host.isRecovering() ||
      host.isHandoverBarrierActive() ||
      !Number.isSafeInteger(convNum) ||
      convNum < 1 ||
      !Number.isSafeInteger(firstKept) ||
      firstKept <= 1 ||
      !Number.isSafeInteger(observedCompactionHeadId)
    ) {
      return false;
    }
    if (inFlightSchedule.has(convNum)) return false;
    inFlightSchedule.add(convNum);
    try {
      const harness = host.getHarness();
      const targetMaxEntryId = firstKept - 1;
      const convKey = String(convNum);
      let scheduled = false;
      await harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const settingsDoc = await tx.doc(SettingsAssistantDoc);
        if (!isOrchestratorConversation(convNum, state) || isActiveSettingsConversation(convNum, settingsDoc)) return;
        const topicId = state.conversationToTopic?.[convKey];
        const topic = topicId ? state.topics?.[topicId] : undefined;
        if (!topicId || !topic || topic.deletedAt !== undefined || topic.conversationId !== convNum) return;

        const wm = await tx.doc(KuloWorkingMemoryDoc);
        const cur = wm.cursors[convKey] ?? { lastFlushedEntryId: 0 };
        if (!isCursorAhead(targetMaxEntryId, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) return;

        if (await hasLiveFlushTaskInTx(tx, convNum)) {
          cur.pendingTargetMaxEntryId = Math.max(cur.pendingTargetMaxEntryId ?? 0, targetMaxEntryId);
          cur.pendingObservedCompactionHeadId = Math.max(cur.pendingObservedCompactionHeadId ?? 0, observedCompactionHeadId);
          wm.cursors[convKey] = cur;
          scheduled = true;
          return;
        }
        await tx.createTask(
          flushTask,
          { conversationId: convNum, targetMaxEntryId, observedCompactionHeadId, trigger: "compaction" },
          { ownership: { kind: "conversation" }, conversationId, background: true },
        );
        scheduled = true;
      }, context);
      return scheduled;
    } catch (error) {
      console.warn("[KuloMemoryFlush] Failed to schedule memory flush", error);
      return false;
    } finally {
      inFlightSchedule.delete(convNum);
    }
  };

  /**
   * Atomically schedules or merges an archive-tail flush for a frozen archived root conversation.
   * Uses `tx.scanTasks` inside the same `harness.commit` that updates `pendingTargetMaxEntryId`,
   * eliminating any Lost-Wakeup window against concurrently finishing idle/compaction flushes.
   */
  const scheduleForArchive = async (
    conversationId: number,
    tailEntryId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<MainArchiveFlushStatus> => {
    if (
      host.isClosed() ||
      host.isRecovering() ||
      host.isHandoverBarrierActive() ||
      !Number.isSafeInteger(conversationId) ||
      conversationId < 1 ||
      !Number.isSafeInteger(tailEntryId) ||
      tailEntryId < 1
    ) {
      return "skipped";
    }
    try {
      const harness = host.getHarness();
      const convKey = String(conversationId);
      let status: MainArchiveFlushStatus = "skipped";
      await harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const settingsDoc = await tx.doc(SettingsAssistantDoc);
        if (!isOrchestratorConversation(conversationId, state) || isActiveSettingsConversation(conversationId, settingsDoc)) {
          status = "skipped";
          return;
        }
        const topicId = state.conversationToTopic?.[convKey];
        const topic = topicId ? state.topics?.[topicId] : undefined;
        if (!topicId || !topic || topic.deletedAt !== undefined || topic.conversationId !== conversationId) {
          status = "skipped";
          return;
        }
        const wm = await tx.doc(KuloWorkingMemoryDoc);
        const cur = wm.cursors[convKey] ?? { lastFlushedEntryId: 0 };
        if (!isCursorAhead(tailEntryId, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) {
          clearCoveredPendingTarget(cur);
          wm.cursors[convKey] = cur;
          status = "already_up_to_date";
          return;
        }
        cur.pendingTargetMaxEntryId = Math.max(cur.pendingTargetMaxEntryId ?? 0, tailEntryId);
        cur.pendingTrigger = "archive";
        wm.cursors[convKey] = cur;

        if (await hasLiveFlushTaskInTx(tx, conversationId)) {
          status = "merged_pending";
          return;
        }
        await tx.createTask(
          flushTask,
          {
            conversationId,
            targetMaxEntryId: cur.pendingTargetMaxEntryId,
            observedCompactionHeadId: 0,
            trigger: "archive",
          },
          { ownership: { kind: "conversation" }, conversationId: conversationId as ConversationId, background: true },
        );
        status = "scheduled";
      }, context);
      return status;
    } catch (error) {
      console.warn("[KuloMemoryFlush] Failed to schedule archive flush", error);
      return "skipped";
    }
  };

  /**
   * Startup/recovery sweep for pending archive/compaction flushes whose cursor has not yet
   * reached `pendingTargetMaxEntryId` (including mid-offset long entries and post-backoff recovery).
   */
  const recoverPendingArchiveFlushes = async (context: Context = BACKGROUND_CONTEXT): Promise<number> => {
    if (host.isClosed() || host.isRecovering() || host.isHandoverBarrierActive()) return 0;
    const harness = host.getHarness();
    const [wmDoc, state] = await Promise.all([
      harness.snapshot(KuloWorkingMemoryDoc, context),
      harness.snapshot(KuloStateDoc, context),
    ]);
    let recovered = 0;
    for (const [convKey, cur] of Object.entries(wmDoc?.cursors ?? {})) {
      const pendingTarget = cur?.pendingTargetMaxEntryId;
      if (!pendingTarget || !isCursorAhead(pendingTarget, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) {
        continue;
      }
      const convId = Number(convKey);
      const topicId = state?.conversationToTopic?.[convKey];
      const topic = topicId ? state?.topics?.[topicId] : undefined;
      if (!Number.isSafeInteger(convId) || convId < 1 || !topicId || !topic || topic.deletedAt !== undefined || topic.conversationId !== convId) {
        continue;
      }
      const res = await scheduleForArchive(convId, pendingTarget, context);
      if (res === "scheduled") recovered += 1;
    }
    return recovered;
  };

  const scheduleForIdle = async (
    input: { conversationId: number; headEntryId: number; clearEpoch: number; engineEpoch: number },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<boolean> => {
    const convNum = input.conversationId;
    if (host.isClosed() || host.isRecovering() || host.isHandoverBarrierActive() || !Number.isSafeInteger(convNum) || convNum < 1 || input.headEntryId < 1) {
      return false;
    }
    if (inFlightSchedule.has(convNum)) return false;
    inFlightSchedule.add(convNum);
    try {
      const harness = host.getHarness();
      let scheduled = false;
      await harness.commit(async (tx) => {
        if (await hasLiveFlushTaskInTx(tx, convNum)) return;
        await tx.createTask(
          flushTask,
          {
            conversationId: convNum,
            targetMaxEntryId: input.headEntryId,
            observedCompactionHeadId: 0,
            trigger: "idle",
            expectedClearEpoch: input.clearEpoch,
            expectedEngineEpoch: input.engineEpoch,
          },
          { ownership: { kind: "conversation" }, conversationId: convNum as ConversationId, background: true },
        );
        scheduled = true;
      }, context);
      return scheduled;
    } catch {
      return false;
    } finally {
      inFlightSchedule.delete(convNum);
    }
  };

  const abortIdleFlushTasks = async (context: Context = BACKGROUND_CONTEXT): Promise<void> => {
    const harness = host.getHarness();
    const inspected = await harness.inspect(context).catch(() => undefined);
    for (const task of inspected?.tasks ?? []) {
      if (task.record.kind !== MEMORY_FLUSH_TASK_NAME) continue;
      const input = task.record.input as unknown as MemoryFlushInput | undefined;
      if (input?.trigger !== "idle") continue;
      await harness.abortTask(task.record.id as TaskId, context).catch(() => {});
    }
  };

  return Object.assign(
    defineExtension({
      name: "kulo-memory-flush",
      tasks: [flushTask],
    }),
    { flushTask, scheduleForCompaction, scheduleForArchive, recoverPendingArchiveFlushes, scheduleForIdle, abortIdleFlushTasks },
  );
}
