export const BATCH_WORKFLOW_MAX_ITEMS = 16;
export const BATCH_WORKFLOW_DEFAULT_WAVE_SIZE = 8;
export const BATCH_WORKFLOW_DEFAULT_CONCURRENCY = 4;
export const BATCH_WORKFLOW_HUMAN_CONFIRM_THRESHOLD = 6;
export const BATCH_WORKFLOW_SCHEMA_MAX_BYTES = 8 * 1024;
export const BATCH_WORKFLOW_SCHEMA_MAX_DEPTH = 6;
export const BATCH_WORKFLOW_OUTPUT_MAX_BYTES = 4 * 1024;

export type BatchWorkflowMode = "parallel";

export type BatchWorkflowStatus =
  | "awaiting_confirmation"
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "stopped"
  | "denied";

export type BatchWorkflowItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface BatchWorkflowItemRecord {
  itemId: string;
  label: string;
  /** Redacted prompt instructions for this sub-item. */
  prompt: string;
  status: BatchWorkflowItemStatus;
  attempts: number;
  /** Independently persisted schema-validated structured output (<= 4 KiB UTF-8 JSON, redacted). */
  validatedOutput?: unknown;
  /** Redacted failure or cancellation detail. */
  error?: string;
  conversationId?: number;
  waveIndex?: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface BatchWorkflowConfirmationBinding {
  confirmationId: string;
  cardId?: string;
  /** Single-use idempotency handle bound to this human approval (never named with secret/token substrings). */
  claimId: string;
  initiatorConversationId: number;
  initiatorTopicId?: string;
  initiatorTicketId?: string;
  initiatorCallId: string;
  approverPolicy: "human_only";
  approverPrincipalId?: string;
  executor: "batch_workflow_service";
  consumedAt?: number;
}

export interface BatchWorkflowRecord {
  id: string;
  commandId: string;
  title: string;
  mode: BatchWorkflowMode;
  /** Hard-locked read-only execution flag (always true in Stage 3 P2-1). */
  readOnly: true;
  status: BatchWorkflowStatus;
  originTopicId: string;
  originConversationId: number;
  parentTicketId?: string;
  projectId?: string;
  envId?: string;
  workspaceDir?: string;
  role: string;
  concurrency: number;
  waveSize: number;
  /** Validated JSON Schema object (<= 8 KiB, depth <= 6) compiled by @earendil-works/pi-schema. */
  outputSchema?: Record<string, unknown>;
  totalWaves: number;
  currentWave: number;
  items: BatchWorkflowItemRecord[];
  confirmation?: BatchWorkflowConfirmationBinding;
  budgetCapped?: boolean;
  budgetCapReason?: string;
  stopReason?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BatchWorkflowItemCardView {
  itemId: string;
  label: string;
  status: BatchWorkflowItemStatus;
  attempts: number;
  validatedOutput?: unknown;
  error?: string;
  waveIndex?: number;
  updatedAt: number;
}

export interface BatchWorkflowCounts {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  running: number;
  stopped: number;
}

export interface BatchWorkflowCardView {
  id: string;
  title: string;
  mode: BatchWorkflowMode;
  readOnly: true;
  status: BatchWorkflowStatus;
  originTopicId: string;
  parentTicketId?: string;
  projectId?: string;
  role: string;
  concurrency: number;
  waveSize: number;
  totalWaves: number;
  currentWave: number;
  counts: BatchWorkflowCounts;
  budgetCapped?: boolean;
  budgetCapReason?: string;
  stopReason?: string;
  confirmationCardId?: string;
  items: BatchWorkflowItemCardView[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BatchWorkflowRetryRequest {
  itemIds?: string[];
  commandId?: string;
}

export interface BatchWorkflowStopRequest {
  reason?: string;
}

export function computeBatchWorkflowCounts(
  items: ReadonlyArray<Pick<BatchWorkflowItemRecord, "status">>,
): BatchWorkflowCounts {
  const counts: BatchWorkflowCounts = {
    total: items.length,
    completed: 0,
    failed: 0,
    pending: 0,
    running: 0,
    stopped: 0,
  };
  for (const item of items) {
    if (item.status === "completed") counts.completed += 1;
    else if (item.status === "failed") counts.failed += 1;
    else if (item.status === "running") counts.running += 1;
    else if (item.status === "stopped") counts.stopped += 1;
    else counts.pending += 1;
  }
  return counts;
}

export function toBatchWorkflowCardView(record: Readonly<BatchWorkflowRecord>): BatchWorkflowCardView {
  return {
    id: record.id,
    title: record.title,
    mode: "parallel",
    readOnly: true,
    status: record.status,
    originTopicId: record.originTopicId,
    ...(record.parentTicketId ? { parentTicketId: record.parentTicketId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    role: record.role,
    concurrency: record.concurrency,
    waveSize: record.waveSize,
    totalWaves: record.totalWaves,
    currentWave: record.currentWave,
    counts: computeBatchWorkflowCounts(record.items),
    ...(record.budgetCapped ? { budgetCapped: true } : {}),
    ...(record.budgetCapReason ? { budgetCapReason: record.budgetCapReason } : {}),
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    ...(record.confirmation?.cardId ? { confirmationCardId: record.confirmation.cardId } : {}),
    items: record.items.map((item) => ({
      itemId: item.itemId,
      label: item.label,
      status: item.status,
      attempts: item.attempts,
      ...(item.validatedOutput !== undefined ? { validatedOutput: item.validatedOutput } : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.waveIndex !== undefined ? { waveIndex: item.waveIndex } : {}),
      updatedAt: item.updatedAt,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
  };
}
