import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  BATCH_WORKFLOW_DEFAULT_CONCURRENCY,
  BATCH_WORKFLOW_DEFAULT_WAVE_SIZE,
  BATCH_WORKFLOW_HUMAN_CONFIRM_THRESHOLD,
  BATCH_WORKFLOW_MAX_ITEMS,
  computeBatchWorkflowCounts,
  toBatchWorkflowCardView,
  type BatchWorkflowCardView,
  type BatchWorkflowItemRecord,
  type BatchWorkflowRecord,
  type BatchWorkflowRetryRequest,
  type BatchWorkflowStatus,
} from "@kulo/protocol";
import {
  batchDispatchFingerprint,
  buildBatchDispatchConfirmCard,
  type PendingActionConfirmation,
} from "./action-confirmations.js";
import {
  BatchWorkflowDoc,
  abortBatchConversations,
  clampBatchInt,
  cloneBatchJson,
  pruneOldBatchesInTx,
  runBatchWaves,
  type ActiveBatchRun,
  type BatchWorkflowDocState,
  type BatchWorkflowItemExecutionInput,
  type BatchWorkflowItemExecutionOutput,
  type BatchWorkflowServiceHost,
} from "./batch-workflow-runner.js";
import {
  BatchWorkflowError,
  formatBatchReportForOrchestrator,
  sanitizeBatchText,
  sanitizeBatchValueForDoc,
  validateAndCompileBatchSchema,
} from "./batch-workflow-schema.js";

export {
  BatchWorkflowDoc,
  BatchWorkflowError,
  formatBatchReportForOrchestrator,
  validateAndCompileBatchSchema,
  type BatchWorkflowDocState,
  type BatchWorkflowItemExecutionInput,
  type BatchWorkflowItemExecutionOutput,
  type BatchWorkflowServiceHost,
};

export interface DispatchBatchWorkflowItemInput {
  itemId?: string;
  label: string;
  prompt: string;
}

export interface DispatchBatchWorkflowInput {
  commandId: string;
  title: string;
  mode?: string;
  readOnly?: boolean;
  writable?: boolean;
  workspaceMode?: string;
  role?: string;
  concurrency?: number;
  waveSize?: number;
  outputSchema?: unknown;
  items: DispatchBatchWorkflowItemInput[];
  originTopicId: string;
  originConversationId: number;
  parentTicketId?: string;
  projectId?: string;
  envId?: string;
  workspaceDir?: string;
  callId: string;
  onProgress?: (line: string) => void;
  /** Defaults to true for immediate (<=6 items) batches; set false to start in background. */
  waitForCompletion?: boolean;
}

export interface DispatchBatchWorkflowResult {
  status: BatchWorkflowStatus;
  batch: BatchWorkflowRecord;
  cardView: BatchWorkflowCardView;
  confirmationId?: string;
  cardId?: string;
  formattedReport?: string;
}

export class BatchWorkflowService {
  readonly #host: BatchWorkflowServiceHost;
  readonly #activeRuns = new Map<string, ActiveBatchRun>();
  #closed = false;

  constructor(host: BatchWorkflowServiceHost) {
    this.#host = host;
  }

  async listCardViews(
    context: Context = BACKGROUND_CONTEXT,
    filter?: { topicId?: string; ticketId?: string },
  ): Promise<BatchWorkflowCardView[]> {
    const doc = await this.#host.harness.snapshot(BatchWorkflowDoc, context);
    const list = Object.values(doc?.batches ?? {})
      .filter((batch) => {
        if (filter?.topicId && batch.originTopicId !== filter.topicId) return false;
        if (filter?.ticketId && batch.parentTicketId !== filter.ticketId) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .map((batch) => toBatchWorkflowCardView(batch));
    return sanitizeBatchValueForDoc(list, this.#host.redact);
  }

  async getRecord(batchId: string, context: Context = BACKGROUND_CONTEXT): Promise<BatchWorkflowRecord | undefined> {
    const doc = await this.#host.harness.snapshot(BatchWorkflowDoc, context);
    const found = doc?.batches?.[batchId];
    return found ? cloneBatchJson(found) : undefined;
  }

  async getCardView(batchId: string, context: Context = BACKGROUND_CONTEXT): Promise<BatchWorkflowCardView | undefined> {
    const rec = await this.getRecord(batchId, context);
    return rec ? sanitizeBatchValueForDoc(toBatchWorkflowCardView(rec), this.#host.redact) : undefined;
  }

  async dispatch(
    input: DispatchBatchWorkflowInput,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<DispatchBatchWorkflowResult> {
    if (this.#closed || this.#host.isClosed()) {
      throw new BatchWorkflowError(503, "hub_closing", "中枢正在关闭，无法发起新的批量只读扇出。");
    }

    // Hard red-line lock: parallel mode ONLY (no pipeline), strictly read-only ONLY.
    if (input.mode !== undefined && input.mode !== "parallel") {
      throw new BatchWorkflowError(
        400,
        "batch_mode_unsupported",
        `kulo_batch_dispatch 首期仅支持 mode="parallel"，不支持 "${input.mode}" 模式。`,
      );
    }
    if (
      input.readOnly === false ||
      input.writable === true ||
      (input.workspaceMode !== undefined && input.workspaceMode !== "read_only")
    ) {
      throw new BatchWorkflowError(
        400,
        "batch_read_only_enforced",
        "kulo_batch_dispatch 严格锁定纯只读执行（readOnly=true），拒绝可写参数或工作区写模式。",
      );
    }

    const commandId = typeof input.commandId === "string" ? input.commandId.trim() : "";
    if (!commandId || commandId.length > 200) {
      throw new BatchWorkflowError(400, "batch_invalid_request", "command_id 必须为非空字符串（≤ 200 字符）。");
    }
    const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
    if (!rawTitle) {
      throw new BatchWorkflowError(400, "batch_invalid_request", "请提供简洁的批处理标题 title。");
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BatchWorkflowError(400, "batch_items_empty", "items 不能为空，请至少提供 1 个只读子项。");
    }
    if (input.items.length > BATCH_WORKFLOW_MAX_ITEMS) {
      throw new BatchWorkflowError(
        400,
        "batch_items_limit",
        `单次批处理最多支持 ${BATCH_WORKFLOW_MAX_ITEMS} 项（当前 ${input.items.length} 项），请拆分后执行。`,
      );
    }

    const compiledSchema =
      input.outputSchema !== undefined ? validateAndCompileBatchSchema(input.outputSchema) : undefined;

    // Idempotent lookup by commandId
    const existingSnap = await this.#host.harness.snapshot(BatchWorkflowDoc, context);
    const existingId = existingSnap?.commandIndex?.[commandId];
    if (existingId && existingSnap?.batches?.[existingId]) {
      const existing = cloneBatchJson(existingSnap.batches[existingId]!);
      if (existing.status === "awaiting_confirmation") {
        return {
          status: existing.status,
          batch: existing,
          cardView: toBatchWorkflowCardView(existing),
          confirmationId: existing.confirmation?.confirmationId,
          cardId: existing.confirmation?.cardId,
        };
      }
      const active = this.#activeRuns.get(existing.id);
      if (active && input.waitForCompletion !== false) {
        const settled = await active.promise;
        return {
          status: settled.status,
          batch: settled,
          cardView: toBatchWorkflowCardView(settled),
          formattedReport: formatBatchReportForOrchestrator(settled, this.#host.redact),
        };
      }
      return {
        status: existing.status,
        batch: existing,
        cardView: toBatchWorkflowCardView(existing),
        formattedReport: formatBatchReportForOrchestrator(existing, this.#host.redact),
      };
    }

    const hostMaxConcurrency = clampBatchInt(
      this.#host.getMaxConcurrency(),
      1,
      BATCH_WORKFLOW_DEFAULT_CONCURRENCY,
      BATCH_WORKFLOW_DEFAULT_CONCURRENCY,
    );
    const hostMaxWaveSize = clampBatchInt(
      this.#host.getMaxWaveSize?.(),
      1,
      BATCH_WORKFLOW_DEFAULT_WAVE_SIZE,
      BATCH_WORKFLOW_DEFAULT_WAVE_SIZE,
    );
    const waveSize = clampBatchInt(input.waveSize, 1, hostMaxWaveSize, hostMaxWaveSize);
    const concurrency = clampBatchInt(input.concurrency, 1, Math.min(hostMaxConcurrency, waveSize), Math.min(hostMaxConcurrency, waveSize));
    const totalWaves = Math.ceil(input.items.length / waveSize);

    const now = Date.now();
    const seenItemIds = new Set<string>();
    const preparedItems: BatchWorkflowItemRecord[] = input.items.map((raw, index) => {
      const itemId = raw.itemId?.trim() || `item-${String(index + 1).padStart(2, "0")}`;
      if (seenItemIds.has(itemId)) {
        throw new BatchWorkflowError(400, "batch_duplicate_item_id", `重复的子项编号 '${itemId}'。`);
      }
      seenItemIds.add(itemId);
      const label = sanitizeBatchText(raw.label?.trim() || itemId, this.#host.redact, 160);
      const prompt = sanitizeBatchText(raw.prompt?.trim() || "", this.#host.redact, 8000);
      if (!prompt) {
        throw new BatchWorkflowError(400, "batch_invalid_item", `子项 '${itemId}' 缺少非空 prompt。`);
      }
      return {
        itemId,
        label,
        prompt,
        status: "pending",
        attempts: 0,
        waveIndex: Math.floor(index / waveSize),
        updatedAt: now,
      };
    });

    const safeTitle = sanitizeBatchText(rawTitle, this.#host.redact, 120);
    const safeRole = sanitizeBatchText((input.role?.trim() || "scout").slice(0, 64), this.#host.redact, 64);
    const requiresHumanApproval = preparedItems.length > BATCH_WORKFLOW_HUMAN_CONFIRM_THRESHOLD;
    const safeSchema = compiledSchema
      ? sanitizeBatchValueForDoc(compiledSchema.schema, this.#host.redact)
      : undefined;

    const created = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      const existingByCmd = doc.commandIndex[commandId];
      if (existingByCmd && doc.batches[existingByCmd]) {
        return { existed: true, batch: cloneBatchJson(doc.batches[existingByCmd]!) };
      }
      const seq = doc.nextBatchNumber++;
      const id = `BW-${String(seq).padStart(4, "0")}`;
      const record: BatchWorkflowRecord = sanitizeBatchValueForDoc(
        {
          id,
          commandId,
          title: safeTitle,
          mode: "parallel" as const,
          readOnly: true as const,
          status: requiresHumanApproval ? ("awaiting_confirmation" as const) : ("queued" as const),
          originTopicId: input.originTopicId,
          originConversationId: input.originConversationId,
          ...(input.parentTicketId ? { parentTicketId: input.parentTicketId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.envId ? { envId: input.envId } : {}),
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          role: safeRole,
          concurrency,
          waveSize,
          ...(safeSchema ? { outputSchema: safeSchema } : {}),
          totalWaves,
          currentWave: 0,
          items: preparedItems,
          createdAt: now,
          updatedAt: now,
        },
        this.#host.redact,
      );
      doc.batches[id] = record;
      doc.commandIndex[commandId] = id;
      pruneOldBatchesInTx(doc);
      return { existed: false, batch: cloneBatchJson(record) };
    }, context);

    if (created.existed) {
      return {
        status: created.batch.status,
        batch: created.batch,
        cardView: toBatchWorkflowCardView(created.batch),
        confirmationId: created.batch.confirmation?.confirmationId,
        cardId: created.batch.confirmation?.cardId,
        ...(created.batch.status !== "awaiting_confirmation"
          ? { formattedReport: formatBatchReportForOrchestrator(created.batch, this.#host.redact) }
          : {}),
      };
    }

    if (requiresHumanApproval) {
      const claimId = `bwclaim_${randomUUID().replace(/-/g, "")}`;
      const itemLabels = created.batch.items.map((item) => item.label);
      const built = buildBatchDispatchConfirmCard({
        batchId: created.batch.id,
        title: created.batch.title,
        itemCount: created.batch.items.length,
        itemLabels,
        waveSize: created.batch.waveSize,
        concurrency: created.batch.concurrency,
      });
      const fingerprint = batchDispatchFingerprint({
        batchId: created.batch.id,
        commandId,
        itemCount: created.batch.items.length,
        claimId,
      });
      // Strictly enters `pending` human approval directly — NEVER `pending_orchestrator`.
      const { confirmation } = await this.#host.actionConfirmations.ensurePendingCard(
        {
          conversationId: input.originConversationId,
          topicId: input.originTopicId,
          ...(input.parentTicketId ? { ticketId: input.parentTicketId } : {}),
          callId: input.callId,
          kind: "batch_dispatch",
          fingerprint,
          cardInput: built.input,
          logicalIds: built.logicalIds,
          payload: sanitizeBatchValueForDoc(
            {
              kind: "batch_dispatch" as const,
              batchId: created.batch.id,
              commandId,
              title: created.batch.title,
              itemCount: created.batch.items.length,
              itemLabels,
              readOnly: true as const,
              mode: "parallel" as const,
              waveSize: created.batch.waveSize,
              concurrency: created.batch.concurrency,
              initiator: {
                conversationId: input.originConversationId,
                topicId: input.originTopicId,
                ...(input.parentTicketId ? { ticketId: input.parentTicketId } : {}),
                callId: input.callId,
              },
              approverPolicy: "human_only" as const,
              executor: "batch_workflow_service" as const,
              claimId,
              ...(input.parentTicketId ? { ticketId: input.parentTicketId } : {}),
            },
            this.#host.redact,
          ),
        },
        context,
      );

      const boundBatch = await this.#host.harness.commit(async (tx) => {
        const doc = await tx.doc(BatchWorkflowDoc);
        const live = doc.batches[created.batch.id];
        if (!live) return created.batch;
        live.confirmation = sanitizeBatchValueForDoc(
          {
            confirmationId: confirmation.id,
            ...(confirmation.cardId ? { cardId: confirmation.cardId } : {}),
            claimId,
            initiatorConversationId: input.originConversationId,
            initiatorTopicId: input.originTopicId,
            ...(input.parentTicketId ? { initiatorTicketId: input.parentTicketId } : {}),
            initiatorCallId: input.callId,
            approverPolicy: "human_only" as const,
            executor: "batch_workflow_service" as const,
          },
          this.#host.redact,
        );
        live.updatedAt = Date.now();
        return cloneBatchJson(live);
      }, context);

      await this.#emitChanged(context);
      return {
        status: "awaiting_confirmation",
        batch: boundBatch,
        cardView: toBatchWorkflowCardView(boundBatch),
        confirmationId: confirmation.id,
        cardId: confirmation.cardId,
      };
    }

    await this.#emitChanged(context);
    if (input.waitForCompletion === false) {
      this.#launchBackgroundExecution(created.batch.id);
      return {
        status: "queued",
        batch: created.batch,
        cardView: toBatchWorkflowCardView(created.batch),
      };
    }

    const settled = await this.#executeBatch(created.batch.id, {
      context,
      onProgress: input.onProgress,
    });
    return {
      status: settled.status,
      batch: settled,
      cardView: toBatchWorkflowCardView(settled),
      formattedReport: formatBatchReportForOrchestrator(settled, this.#host.redact),
    };
  }

  async handleConfirmationResolved(
    resolved: Readonly<PendingActionConfirmation>,
    approverPrincipalId?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<BatchWorkflowRecord | undefined> {
    if (resolved.payload.kind !== "batch_dispatch") return undefined;
    // Enforce single-use confirmation consumption before launching any sub-items.
    const claimed = await this.#host.actionConfirmations.markDispatched(resolved.id, context);
    if (!claimed) return undefined;

    const { batchId, claimId } = resolved.payload;
    const approved = resolved.status === "approved";
    const now = Date.now();
    const safeApprover = approverPrincipalId
      ? sanitizeBatchText(approverPrincipalId, this.#host.redact, 128)
      : "human_ui";

    const transition = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      const batch = doc.batches[batchId];
      if (!batch || batch.status !== "awaiting_confirmation") return undefined;
      if (!batch.confirmation || batch.confirmation.claimId !== claimId || batch.confirmation.consumedAt !== undefined) {
        return undefined;
      }
      batch.confirmation.consumedAt = now;
      batch.confirmation.approverPrincipalId = safeApprover;
      batch.updatedAt = now;
      if (!approved) {
        batch.status = "denied";
        batch.stopReason = "用户已拒绝批量只读派发";
        batch.completedAt = now;
        for (const item of batch.items) {
          if (item.status === "pending" || item.status === "running") {
            item.status = "stopped";
            item.updatedAt = now;
          }
        }
      } else {
        batch.status = "queued";
      }
      return cloneBatchJson(batch);
    }, context);

    await this.#host.actionConfirmations.markOutcome(
      resolved.id,
      transition ? "confirmed" : "failed_pre_dispatch",
      transition ? undefined : "批处理确认已失效或已消费",
      context,
    );

    if (!transition) return undefined;
    await this.#emitChanged(context);
    if (approved) {
      this.#launchBackgroundExecution(batchId);
    }
    return transition;
  }

  async retryFailedItems(
    batchId: string,
    req: BatchWorkflowRetryRequest = {},
    context: Context = BACKGROUND_CONTEXT,
    options: { waitForCompletion?: boolean } = {},
  ): Promise<BatchWorkflowCardView> {
    if (this.#closed || this.#host.isClosed()) {
      throw new BatchWorkflowError(503, "hub_closing", "中枢正在关闭，无法重试批处理。");
    }
    if (this.#activeRuns.has(batchId)) {
      throw new BatchWorkflowError(409, "batch_already_running", "该批处理正在运行中，请稍后再试。");
    }

    const requestedIds = req.itemIds?.length ? new Set(req.itemIds.map((id) => id.trim()).filter(Boolean)) : undefined;
    const now = Date.now();
    const updated = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      const batch = doc.batches[batchId];
      if (!batch) throw new BatchWorkflowError(404, "batch_not_found", `批处理 '${batchId}' 不存在。`);
      if (batch.status === "awaiting_confirmation") {
        throw new BatchWorkflowError(409, "batch_awaiting_confirmation", "该批处理尚未经过人工批准，请先在确认卡片中批准。");
      }
      if (batch.status === "running" || batch.status === "queued") {
        throw new BatchWorkflowError(409, "batch_already_running", "该批处理正在执行中。");
      }
      if (batch.status === "denied") {
        throw new BatchWorkflowError(409, "batch_denied", "该批处理已被用户拒绝，无法直接重试。");
      }

      const targets = requestedIds
        ? batch.items.filter((item) => requestedIds.has(item.itemId) && item.status !== "completed")
        : batch.items.filter((item) => item.status === "failed");
      const effectiveTargets =
        targets.length > 0
          ? targets
          : requestedIds
            ? []
            : batch.items.filter((item) => item.status === "pending" || item.status === "stopped");

      if (effectiveTargets.length === 0) {
        throw new BatchWorkflowError(400, "batch_no_retryable_items", "没有可重试的失败或未完成子项。");
      }

      for (const item of effectiveTargets) {
        item.status = "pending";
        delete item.error;
        delete item.completedAt;
        item.updatedAt = now;
      }
      batch.status = "queued";
      delete batch.budgetCapped;
      delete batch.budgetCapReason;
      delete batch.stopReason;
      delete batch.completedAt;
      batch.updatedAt = now;
      return cloneBatchJson(batch);
    }, context);

    await this.#emitChanged(context);
    if (options.waitForCompletion) {
      const settled = await this.#executeBatch(batchId, { context });
      return toBatchWorkflowCardView(settled);
    }
    this.#launchBackgroundExecution(batchId);
    return toBatchWorkflowCardView(updated);
  }

  async recoverIncompleteOnStartup(
    options: { bootWasFailover?: boolean; crashLoopTripped?: boolean } = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ resumedIds: string[]; pausedIds: string[] }> {
    const blockAutoResume = Boolean(options.bootWasFailover || options.crashLoopTripped);
    const now = Date.now();
    const resumedIds: string[] = [];
    const pausedIds: string[] = [];

    await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      for (const batch of Object.values(doc.batches)) {
        if (batch.status !== "running" && batch.status !== "queued") continue;
        // Reset ONLY orphaned `running` items back to `pending`; NEVER touch `completed` items.
        let hasIncomplete = false;
        for (const item of batch.items) {
          if (item.status === "running") {
            item.status = "pending";
            item.updatedAt = now;
          }
          if (item.status === "pending") {
            hasIncomplete = true;
          }
        }
        if (!hasIncomplete) {
          const counts = computeBatchWorkflowCounts(batch.items);
          batch.status = counts.failed === 0 ? "completed" : counts.completed > 0 ? "partial" : "failed";
          batch.completedAt = now;
          batch.updatedAt = now;
          continue;
        }
        if (blockAutoResume) {
          batch.status = "partial";
          batch.stopReason = sanitizeBatchText(
            "故障切换或异常重启后已暂停未完成批处理，请手动重试剩余子项。",
            this.#host.redact,
            240,
          );
          batch.updatedAt = now;
          pausedIds.push(batch.id);
        } else {
          batch.status = "queued";
          batch.updatedAt = now;
          resumedIds.push(batch.id);
        }
      }
    }, context);

    if (resumedIds.length > 0 || pausedIds.length > 0) {
      await this.#emitChanged(context);
    }
    for (const batchId of resumedIds) {
      this.#launchBackgroundExecution(batchId);
    }
    return { resumedIds, pausedIds };
  }

  async stopBatch(
    batchId: string,
    reason?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<BatchWorkflowCardView> {
    const safeReason = sanitizeBatchText(reason?.trim() || "批处理已停止", this.#host.redact, 240);
    const active = this.#activeRuns.get(batchId);
    if (active) {
      active.stopRequested = true;
      active.stopReason = safeReason;
      active.controller.abort();
      await this.#abortConversations([...active.activeConversations]);
    }

    const now = Date.now();
    let pendingConfirmationId: string | undefined;
    const updated = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(BatchWorkflowDoc);
      const batch = doc.batches[batchId];
      if (!batch) throw new BatchWorkflowError(404, "batch_not_found", `批处理 '${batchId}' 不存在。`);
      if (batch.status === "awaiting_confirmation" && batch.confirmation?.confirmationId) {
        pendingConfirmationId = batch.confirmation.confirmationId;
      }
      if (batch.status !== "completed" && batch.status !== "denied") {
        batch.status = "stopped";
        batch.stopReason = safeReason;
        batch.completedAt = now;
        batch.updatedAt = now;
        for (const item of batch.items) {
          if (item.status === "pending" || item.status === "running") {
            item.status = "stopped";
            item.error ??= safeReason;
            item.updatedAt = now;
          }
        }
      }
      return cloneBatchJson(batch);
    }, context);

    if (pendingConfirmationId) {
      await this.#host.actionConfirmations
        .resolveProgrammatically(
          pendingConfirmationId,
          { status: "denied", resultSummary: safeReason, markExecuted: true },
          context,
        )
        .catch(() => {});
    }

    if (active) {
      await active.promise.catch(() => undefined);
    }
    await this.#emitChanged(context);
    return toBatchWorkflowCardView(updated);
  }

  async abortForTicket(
    ticketId: string,
    reason = "父任务已停止，级联中止批处理子项",
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<number> {
    const doc = await this.#host.harness.snapshot(BatchWorkflowDoc, context);
    const targets = Object.values(doc?.batches ?? {}).filter(
      (b) =>
        b.parentTicketId === ticketId &&
        (b.status === "running" || b.status === "queued" || b.status === "awaiting_confirmation"),
    );
    for (const batch of targets) {
      await this.stopBatch(batch.id, reason, context).catch(() => {});
    }
    return targets.length;
  }

  async abortForTopic(
    topicId: string,
    conversationId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<number> {
    const doc = await this.#host.harness.snapshot(BatchWorkflowDoc, context);
    const targets = Object.values(doc?.batches ?? {}).filter(
      (b) =>
        (b.originTopicId === topicId || b.originConversationId === conversationId) &&
        (b.status === "running" || b.status === "queued" || b.status === "awaiting_confirmation"),
    );
    for (const batch of targets) {
      await this.stopBatch(batch.id, "所属会话已删除，级联中止批处理子项", context).catch(() => {});
    }
    return targets.length;
  }

  async waitForBatch(batchId: string): Promise<BatchWorkflowRecord | undefined> {
    const active = this.#activeRuns.get(batchId);
    if (active) return active.promise;
    return this.getRecord(batchId, BACKGROUND_CONTEXT);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const convIds: number[] = [];
    const runs = [...this.#activeRuns.values()];
    for (const run of runs) {
      run.stopRequested = true;
      run.stopReason = "中枢正在关闭";
      run.controller.abort();
      for (const id of run.activeConversations) convIds.push(id);
    }
    await this.#abortConversations(convIds);
    if (runs.length > 0) {
      await Promise.race([
        Promise.allSettled(runs.map((r) => r.promise)),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        }),
      ]);
    }
  }

  #launchBackgroundExecution(batchId: string): void {
    if (this.#closed || this.#host.isClosed() || this.#activeRuns.has(batchId)) return;
    void this.#executeBatch(batchId, { context: BACKGROUND_CONTEXT })
      .then(async (settled) => {
        if (this.#closed || this.#host.isClosed()) return;
        const formatted = formatBatchReportForOrchestrator(settled, this.#host.redact);
        await this.#host.onBackgroundBatchSettled?.(settled, formatted, BACKGROUND_CONTEXT);
      })
      .catch((error) => {
        console.warn("[KuloBatchWorkflow] Background run failed", this.#host.redact(error instanceof Error ? error.message : String(error)));
      });
  }

  async #executeBatch(
    batchId: string,
    opts: { context: Context; onProgress?: (line: string) => void },
  ): Promise<BatchWorkflowRecord> {
    const existingActive = this.#activeRuns.get(batchId);
    if (existingActive) return existingActive.promise;

    const controller = new AbortController();
    const run: ActiveBatchRun = {
      controller,
      promise: Promise.resolve(undefined as unknown as BatchWorkflowRecord),
      activeConversations: new Set(),
      stopRequested: false,
    };

    const onOuterAbort = () => {
      run.stopRequested = true;
      run.stopReason = "父调用已取消，级联中止批处理子项";
      controller.abort();
      void this.#abortConversations([...run.activeConversations]);
    };
    if (opts.context.abortSignal?.aborted) {
      onOuterAbort();
    } else {
      opts.context.abortSignal?.addEventListener("abort", onOuterAbort, { once: true });
    }

    const work = runBatchWaves(
      {
        host: this.#host,
        isServiceClosed: () => this.#closed,
        getRecord: (id, ctx) => this.getRecord(id, ctx),
        emitChanged: (ctx) => this.#emitChanged(ctx),
      },
      batchId,
      run,
      opts.onProgress,
    ).finally(() => {
      opts.context.abortSignal?.removeEventListener("abort", onOuterAbort);
      if (this.#activeRuns.get(batchId) === run) {
        this.#activeRuns.delete(batchId);
      }
    });
    run.promise = work;
    this.#activeRuns.set(batchId, run);
    return work;
  }

  async #abortConversations(conversationIds: readonly number[]): Promise<void> {
    await abortBatchConversations(this.#host, conversationIds);
  }

  async #emitChanged(context: Context): Promise<void> {
    if (!this.#host.onChanged || this.#closed || this.#host.isClosed()) return;
    try {
      const views = await this.listCardViews(context);
      this.#host.onChanged(views);
    } catch {
      // Ignore listener notification errors
    }
  }
}
