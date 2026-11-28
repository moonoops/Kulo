import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type ConversationId,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import {
  computeBatchWorkflowCounts,
  type BatchWorkflowCardView,
  type BatchWorkflowRecord,
} from "@kulo/protocol";
import type { KuloActionConfirmations } from "./action-confirmations.js";
import {
  BatchWorkflowError,
  extractAndValidateBatchItemOutput,
  sanitizeBatchText,
  sanitizeBatchValueForDoc,
  validateAndCompileBatchSchema,
} from "./batch-workflow-schema.js";

const MAX_RETAINED_BATCHES = 128;

export interface BatchWorkflowDocState {
  nextBatchNumber: number;
  batches: Record<string, BatchWorkflowRecord>;
  commandIndex: Record<string, string>;
  /** Maps sub-item conversationId (as string) -> { batchId, itemId } for read-only env & safety hooks. */
  conversationToItem: Record<string, { batchId: string; itemId: string }>;
}

export const BatchWorkflowDoc = defineDoc<BatchWorkflowDocState & JsonObject>({
  kind: "kulo.batch_workflows",
  version: 1,
  scope: "session",
  initial: () =>
    ({
      nextBatchNumber: 1,
      batches: {},
      commandIndex: {},
      conversationToItem: {},
    }) as BatchWorkflowDocState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 24,
});

export interface BatchWorkflowItemExecutionInput {
  batchId: string;
  itemId: string;
  label: string;
  prompt: string;
  role: string;
  /** Always hard-locked to true by BatchWorkflowService. */
  readOnly: true;
  envId?: string;
  workspaceDir?: string;
  projectId?: string;
  outputSchema?: Record<string, unknown>;
  attempt: number;
  registerConversation: (conversationId: number) => Promise<void>;
}

export interface BatchWorkflowItemExecutionOutput {
  rawText: string;
  conversationId?: number;
}

export interface BatchWorkflowServiceHost {
  harness: Harness;
  actionConfirmations: KuloActionConfirmations;
  redact: (text: string) => string;
  isClosed: () => boolean;
  getMaxConcurrency: () => number;
  getMaxWaveSize?: () => number;
  isBudgetCapped: () => { capped: boolean; reason?: string };
  executeItem: (
    input: BatchWorkflowItemExecutionInput,
    context: Context,
  ) => Promise<BatchWorkflowItemExecutionOutput>;
  onChanged?: (batches: BatchWorkflowCardView[]) => void;
  onBackgroundBatchSettled?: (
    batch: Readonly<BatchWorkflowRecord>,
    formattedReport: string,
    context: Context,
  ) => Promise<void>;
}

export interface ActiveBatchRun {
  controller: AbortController;
  promise: Promise<BatchWorkflowRecord>;
  activeConversations: Set<number>;
  stopRequested: boolean;
  stopReason?: string;
}

export function cloneBatchJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function clampBatchInt(raw: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export function pruneOldBatchesInTx(doc: BatchWorkflowDocState): void {
  const entries = Object.values(doc.batches);
  if (entries.length <= MAX_RETAINED_BATCHES) return;
  const settled = entries
    .filter((b) => b.status === "completed" || b.status === "failed" || b.status === "stopped" || b.status === "denied")
    .sort((a, b) => a.updatedAt - b.updatedAt);
  let excess = entries.length - MAX_RETAINED_BATCHES;
  for (const batch of settled) {
    if (excess <= 0) break;
    delete doc.batches[batch.id];
    if (doc.commandIndex[batch.commandId] === batch.id) {
      delete doc.commandIndex[batch.commandId];
    }
    for (const item of batch.items) {
      if (item.conversationId !== undefined) {
        delete doc.conversationToItem[String(item.conversationId)];
      }
    }
    excess -= 1;
  }
}

export async function abortBatchConversations(
  host: Pick<BatchWorkflowServiceHost, "harness" | "isClosed">,
  conversationIds: readonly number[],
): Promise<void> {
  if (host.isClosed() || conversationIds.length === 0) return;
  await Promise.allSettled(
    conversationIds.map(async (convId) => {
      const conv = await host.harness.conversation(convId as ConversationId, BACKGROUND_CONTEXT);
      if (conv) {
        await conv.abort(BACKGROUND_CONTEXT, { background: true });
      }
    }),
  );
}

export interface BatchWaveRunnerCallbacks {
  host: BatchWorkflowServiceHost;
  isServiceClosed: () => boolean;
  getRecord: (batchId: string, context: Context) => Promise<BatchWorkflowRecord | undefined>;
  emitChanged: (context: Context) => Promise<void>;
}

export async function runBatchWaves(
  callbacks: BatchWaveRunnerCallbacks,
  batchId: string,
  run: ActiveBatchRun,
  onProgress?: (line: string) => void,
): Promise<BatchWorkflowRecord> {
  const { host, isServiceClosed, getRecord, emitChanged } = callbacks;
  const initial = await getRecord(batchId, BACKGROUND_CONTEXT);
  if (!initial) {
    throw new BatchWorkflowError(404, "batch_not_found", `批处理 '${batchId}' 不存在。`);
  }
  const validator = initial.outputSchema
    ? validateAndCompileBatchSchema(initial.outputSchema).validator
    : undefined;

  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(BatchWorkflowDoc);
    const batch = doc.batches[batchId];
    if (!batch) return;
    batch.status = "running";
    batch.updatedAt = Date.now();
  }, BACKGROUND_CONTEXT);
  await emitChanged(BACKGROUND_CONTEXT);

  let budgetHit: { reason: string } | undefined;

  for (let waveIndex = 0; waveIndex < initial.totalWaves; waveIndex += 1) {
    if (run.controller.signal.aborted || isServiceClosed() || host.isClosed()) break;

    const latest = await getRecord(batchId, BACKGROUND_CONTEXT);
    if (!latest || latest.status === "stopped" || latest.status === "denied") break;

    const wavePending = latest.items.filter(
      (item) => (item.waveIndex ?? 0) === waveIndex && item.status === "pending",
    );
    if (wavePending.length === 0) continue;

    const capBeforeWave = host.isBudgetCapped();
    if (capBeforeWave.capped) {
      budgetHit = {
        reason: sanitizeBatchText(
          capBeforeWave.reason ?? "用量上限已触顶，停止派发新波次子项（在途子项单独结算）。",
          host.redact,
          240,
        ),
      };
      break;
    }

    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      const batch = doc.batches[batchId];
      if (!batch) return;
      batch.currentWave = waveIndex;
      batch.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    onProgress?.(`[批处理波次 ${waveIndex + 1}/${latest.totalWaves}] 启动 ${wavePending.length} 项（并发 ≤ ${latest.concurrency}）`);

    let cursor = 0;
    const workerCount = Math.min(latest.concurrency, wavePending.length);

    const workerLoop = async () => {
      while (true) {
        if (run.controller.signal.aborted || isServiceClosed() || host.isClosed() || budgetHit) {
          return;
        }
        // Re-check budget BEFORE launching every individual item; already in-flight items settle normally.
        const cap = host.isBudgetCapped();
        if (cap.capped) {
          budgetHit = {
            reason: sanitizeBatchText(
              cap.reason ?? "用量上限已触顶，停止派发新子项（在途子项单独结算）。",
              host.redact,
              240,
            ),
          };
          return;
        }
        const nextIdx = cursor++;
        if (nextIdx >= wavePending.length) return;
        const item = wavePending[nextIdx]!;
        await runSingleBatchItem(callbacks, latest, item.itemId, validator, run, onProgress);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
    if (budgetHit) break;
  }

  const now = Date.now();
  const finalized = await host.harness.commit(async (tx) => {
    const doc = await tx.doc(BatchWorkflowDoc);
    const batch = doc.batches[batchId];
    if (!batch) return initial;

    const wasStopped = run.stopRequested || run.controller.signal.aborted || batch.status === "stopped";
    if (wasStopped) {
      batch.status = "stopped";
      batch.stopReason = sanitizeBatchText(run.stopReason ?? batch.stopReason ?? "批处理已停止", host.redact, 240);
      for (const item of batch.items) {
        if (item.status === "running" || item.status === "pending") {
          item.status = "stopped";
          item.error ??= batch.stopReason;
          item.updatedAt = now;
        }
      }
    } else if (budgetHit) {
      batch.budgetCapped = true;
      batch.budgetCapReason = budgetHit.reason;
      batch.status = "partial";
    } else {
      const counts = computeBatchWorkflowCounts(batch.items);
      if (counts.failed === 0 && counts.pending === 0 && counts.running === 0 && counts.stopped === 0) {
        batch.status = "completed";
      } else if (counts.completed > 0 || counts.pending > 0) {
        batch.status = "partial";
      } else {
        batch.status = "failed";
      }
    }
    batch.completedAt = now;
    batch.updatedAt = now;
    return cloneBatchJson(batch);
  }, BACKGROUND_CONTEXT);

  await emitChanged(BACKGROUND_CONTEXT);
  return finalized;
}

async function runSingleBatchItem(
  callbacks: BatchWaveRunnerCallbacks,
  batch: Readonly<BatchWorkflowRecord>,
  itemId: string,
  validator: ReturnType<typeof validateAndCompileBatchSchema>["validator"] | undefined,
  run: ActiveBatchRun,
  onProgress?: (line: string) => void,
): Promise<void> {
  const { host, emitChanged } = callbacks;
  const startAt = Date.now();
  const started = await host.harness.commit(async (tx) => {
    const doc = await tx.doc(BatchWorkflowDoc);
    const liveBatch = doc.batches[batch.id];
    const liveItem = liveBatch?.items.find((i) => i.itemId === itemId);
    if (!liveBatch || !liveItem || liveItem.status !== "pending") return undefined;
    liveItem.status = "running";
    liveItem.attempts += 1;
    liveItem.startedAt = startAt;
    liveItem.updatedAt = startAt;
    delete liveItem.error;
    liveBatch.updatedAt = startAt;
    return cloneBatchJson(liveItem);
  }, BACKGROUND_CONTEXT);
  if (!started) return;

  await emitChanged(BACKGROUND_CONTEXT);
  onProgress?.(`[批处理子项启动] ${started.label} (${started.itemId}, 第 ${started.attempts} 次)`);

  let registeredConvId: number | undefined;
  const registerConversation = async (conversationId: number) => {
    registeredConvId = conversationId;
    run.activeConversations.add(conversationId);
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      doc.conversationToItem[String(conversationId)] = { batchId: batch.id, itemId };
      const liveItem = doc.batches[batch.id]?.items.find((i) => i.itemId === itemId);
      if (liveItem) {
        liveItem.conversationId = conversationId;
        liveItem.updatedAt = Date.now();
      }
    }, BACKGROUND_CONTEXT);
    if (run.controller.signal.aborted) {
      await abortBatchConversations(host, [conversationId]);
    }
  };

  try {
    const itemCtx = withAbortSignal(run.controller.signal, BACKGROUND_CONTEXT);
    const output = await host.executeItem(
      {
        batchId: batch.id,
        itemId: started.itemId,
        label: started.label,
        prompt: started.prompt,
        role: batch.role,
        readOnly: true,
        envId: batch.envId,
        workspaceDir: batch.workspaceDir,
        projectId: batch.projectId,
        outputSchema: batch.outputSchema,
        attempt: started.attempts,
        registerConversation,
      },
      itemCtx,
    );

    if (run.controller.signal.aborted || run.stopRequested) {
      await settleBatchItem(callbacks, batch.id, itemId, {
        status: "stopped",
        error: run.stopReason ?? "批处理已停止",
      });
      return;
    }

    const validated = extractAndValidateBatchItemOutput({
      rawText: output.rawText,
      validator,
      redact: host.redact,
    });

    if (validated.ok) {
      await settleBatchItem(callbacks, batch.id, itemId, {
        status: "completed",
        validatedOutput: validated.validatedOutput,
      });
      onProgress?.(`[批处理子项完成] ${started.label} (${started.itemId})`);
    } else {
      await settleBatchItem(callbacks, batch.id, itemId, {
        status: "failed",
        error: validated.error,
      });
      onProgress?.(`[批处理子项校验失败] ${started.label} (${started.itemId})`);
    }
  } catch (error) {
    const stopped = run.controller.signal.aborted || run.stopRequested;
    const errMsg = sanitizeBatchText(
      stopped ? (run.stopReason ?? "批处理已停止") : (error instanceof Error ? error.message : String(error)),
      host.redact,
      400,
    );
    await settleBatchItem(callbacks, batch.id, itemId, {
      status: stopped ? "stopped" : "failed",
      error: errMsg,
    });
    onProgress?.(`[批处理子项${stopped ? "中止" : "失败"}] ${started.label}: ${errMsg}`);
  } finally {
    if (registeredConvId !== undefined) {
      run.activeConversations.delete(registeredConvId);
    }
  }
}

async function settleBatchItem(
  callbacks: BatchWaveRunnerCallbacks,
  batchId: string,
  itemId: string,
  outcome: { status: "completed" | "failed" | "stopped"; validatedOutput?: unknown; error?: string },
): Promise<void> {
  const { host, isServiceClosed, emitChanged } = callbacks;
  if (isServiceClosed() || host.isClosed()) return;
  const now = Date.now();
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(BatchWorkflowDoc);
    const batch = doc.batches[batchId];
    const item = batch?.items.find((i) => i.itemId === itemId);
    if (!batch || !item) return;
    item.status = outcome.status;
    if (outcome.validatedOutput !== undefined) {
      item.validatedOutput = sanitizeBatchValueForDoc(outcome.validatedOutput, host.redact);
      delete item.error;
    }
    if (outcome.error !== undefined) {
      item.error = sanitizeBatchText(outcome.error, host.redact, 400);
    }
    item.completedAt = now;
    item.updatedAt = now;
    batch.updatedAt = now;
  }, BACKGROUND_CONTEXT).catch(() => {});
  await emitChanged(BACKGROUND_CONTEXT);
}
