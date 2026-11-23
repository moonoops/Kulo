import { createHash } from "node:crypto";
import {
  defineDoc, defineEntry, defineExtension, defineTask, GenerationTask, hook, ToolTask,
  type Harness, type JsonObject,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { HindsightMemoryConfig, TicketRecord, WorkerReportRecord } from "@kulo/protocol";
import {
  executeHindsightTool, getHindsightOperation, HindsightAccessError, isSafeMemoryText,
  memoryDocumentId, memoryOperationId, retainHindsightDocument, resolveHindsightToken,
  type MemoryCallerContext,
} from "./hindsight.js";
import { matchesForgottenTerm } from "./memory-forget.js";
import { PersonalityDoc } from "./personality.js";
import { KuloStateDoc, resolveTicketExecutionScope } from "./state.js";
import { memoryCallerFromState } from "./tools-memory.js";
import { KuloWorkingMemoryDoc, isSuspiciousMemoryInstruction, type WorkingMemoryRecord } from "./working-memory.js";

export interface MemoryWorklogReceipt {
  sourceId: string;
  ticketId: string;
  projectId?: string;
  operationId: string;
  documentId: string;
  taskId?: number;
  status: "submitting" | "pending" | "processing" | "completed" | "failed" | "cancelled";
  error?: string;
  updatedAt: number;
}

interface MemoryRecallReceipt {
  text: string;
  timestamp: number;
  requestTaskId: number;
  error?: string;
}

export interface MemoryPrivateRetainReceipt {
  sourceId: string;
  recordId: string;
  conversationId: number;
  bucketId: string;
  operationId: string;
  documentId: string;
  title: string;
  content: string;
  timestamp: number;
  taskId?: number;
  status: "submitting" | "pending" | "processing" | "completed" | "failed" | "cancelled" | "revoked";
  revokedAt?: number;
  revocationReason?: string;
  remoteInvalidated?: boolean;
  error?: string;
  updatedAt: number;
}

export interface MemoryLifecycleState {
  worklogs: Record<string, MemoryWorklogReceipt>;
  recalls: Record<string, MemoryRecallReceipt>;
  privateRetains?: Record<string, MemoryPrivateRetainReceipt>;
}

export const MemoryLifecycleDoc = defineDoc<MemoryLifecycleState & JsonObject>({
  kind: "kulo.memory-lifecycle", version: 1, scope: "session",
  initial: () => ({ worklogs: {}, recalls: {}, privateRetains: {} }) as MemoryLifecycleState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export const MemoryContextEntry = defineEntry<{ sourceId: string; text: string }>("kulo.memory-context");

export const MEMORY_PRIVATE_RETAIN_TASK_NAME = "kulo.memory-private-retain";

interface WorklogInput {
  sourceId: string;
  caller: Omit<MemoryCallerContext, "isValidTicket">;
  title: string;
  content: string;
  timestamp: number;
  operationId: string;
  connection: string;
}

interface PrivateRetainInput {
  sourceId: string;
  recordId: string;
  conversationId: number;
  title: string;
  content: string;
  timestamp: number;
  operationId: string;
  connection: string;
}

type WorklogState = { phase: "submit"; attempts: number } | { phase: "poll"; polls?: number };

interface MemoryLifecycleHost {
  getHarness: () => Harness;
  getMemoryConfig: () => HindsightMemoryConfig;
  recallTimeoutMs?: number;
  onChange?: () => void;
}

const RECALL_MAX_ITEMS = 6;
const RECALL_ITEM_MAX_CHARS = 480;
const RECALL_TOTAL_MAX_CHARS = 2_400;
const RECALL_QUERY_MAX_CHARS = 1_200;
const WILDCARD_SCOPE_RE = /^[\s.*\/\\-]+$/;

interface RecallPayloadItem {
  text?: unknown;
  occurred_start?: unknown;
}

export function buildTicketRecallQuery(
  ticket: Pick<TicketRecord, "title" | "goal" | "scope">,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [ticket.title, ticket.goal, ticket.scope]) {
    const clean = raw?.replace(/\s+/g, " ").trim();
    if (!clean || WILDCARD_SCOPE_RE.test(clean)) continue;
    const key = clean.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(clean);
  }
  return (parts.join(" — ") || ticket.title.trim() || "project context").slice(0, RECALL_QUERY_MAX_CHARS);
}

export function parseRecallPayload(raw: string): {
  results?: RecallPayloadItem[];
  code?: string;
  parseError?: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { code: "INVALID_JSON", parseError: true };
    }
    const record = parsed as { results?: unknown; code?: unknown };
    return {
      ...(Array.isArray(record.results) ? { results: record.results as RecallPayloadItem[] } : {}),
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    };
  } catch {
    return { code: "INVALID_JSON", parseError: true };
  }
}

export function formatRecalledMemoryItems(results: ReadonlyArray<RecallPayloadItem> | undefined): string {
  if (!Array.isArray(results) || results.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  let totalChars = 0;
  for (const item of results) {
    if (lines.length >= RECALL_MAX_ITEMS) break;
    if (!item || typeof item !== "object" || typeof item.text !== "string") continue;
    const normalized = item.text.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const dedupKey = normalized.toLocaleLowerCase("en-US");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const body =
      normalized.length > RECALL_ITEM_MAX_CHARS
        ? `${normalized.slice(0, RECALL_ITEM_MAX_CHARS - 1).trimEnd()}…`
        : normalized;
    const dateMatch =
      typeof item.occurred_start === "string"
        ? item.occurred_start.trim().match(/^(\d{4}-\d{2}-\d{2})/)
        : null;
    const line = dateMatch ? `- [${dateMatch[1]}] ${body}` : `- ${body}`;
    const sep = lines.length > 0 ? 1 : 0;
    if (totalChars + sep + line.length > RECALL_TOTAL_MAX_CHARS) {
      if (lines.length === 0) {
        lines.push(`${line.slice(0, RECALL_TOTAL_MAX_CHARS - 1).trimEnd()}…`);
      }
      break;
    }
    lines.push(line);
    totalChars += sep + line.length;
  }
  return lines.join("\n");
}

function connectionFingerprint(config: HindsightMemoryConfig, role: "worker" | "router" = "worker"): string {
  return createHash("sha256").update(JSON.stringify([config.endpoint, config.endpoints, config.banks,
    config.accessMode ?? "kulo", role, resolveHindsightToken(config, role)])).digest("hex");
}

function pruneReceipts(state: MemoryLifecycleState): void {
  const terminal = Object.entries(state.worklogs).filter(([, value]) => ["completed", "failed", "cancelled"].includes(value.status))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  terminal.slice(256).forEach(([key]) => { delete state.worklogs[key]; });
  if (state.privateRetains) {
    const privateTerminal = Object.entries(state.privateRetains)
      .filter(([, value]) => ["completed", "failed", "cancelled", "revoked"].includes(value.status) && (!value.revokedAt || value.remoteInvalidated))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    privateTerminal.slice(256).forEach(([key]) => { delete state.privateRetains![key]; });
  }
}

/** The durable task only submits and follows receipts; Hindsight owns extraction, retries and consolidation. */
export function createMemoryLifecycleExtension(host: MemoryLifecycleHost) {
  const worklogTask = defineTask<WorklogInput, WorklogState, null>({
    name: "kulo.memory-worklog", version: 1, initial: () => ({ phase: "submit", attempts: 0 }),
    phases: {
      submit: async (task, runtime, context) => {
        const config = host.getMemoryConfig();
        if (!config.enabled || config.accessMode === "private-only" || connectionFingerprint(config) !== task.input.connection) {
          await runtime.commit(async (tx) => {
            const receipt = (await tx.doc(MemoryLifecycleDoc)).worklogs[task.input.sourceId];
            if (receipt) { receipt.status = "cancelled"; receipt.error = config.enabled ? "CONNECTION_CHANGED" : "DISABLED"; receipt.updatedAt = runtime.now(); }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          host.onChange?.(); return;
        }
        try {
          const receipt = await retainHindsightDocument({ config, caller: task.input.caller, bank: "shared", title: task.input.title,
            content: task.input.content, timestamp: task.input.timestamp, operationId: task.input.operationId, source: "worklog", signal: runtime.signal });
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(MemoryLifecycleDoc)).worklogs[task.input.sourceId];
            if (saved) { saved.status = receipt.status; saved.updatedAt = runtime.now(); delete saved.error; }
            return receipt.status === "completed" ? { status: "terminal", outcome: { status: "completed", result: null } }
              : { status: "sleeping", until: runtime.now() + 1500, checkpoint: { phase: "poll" } };
          }, context);
        } catch (error) {
          if (!(error instanceof HindsightAccessError)) throw error;
          if (runtime.signal.aborted) throw error;
          const retry = error.diagnostic.retryable && task.state.checkpoint.attempts < 4;
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(MemoryLifecycleDoc)).worklogs[task.input.sourceId];
            if (saved) { saved.error = error.diagnostic.code; saved.status = retry ? "submitting" : "failed"; saved.updatedAt = runtime.now(); }
            return retry ? { status: "sleeping", until: runtime.now() + 1000 * 2 ** task.state.checkpoint.attempts,
              checkpoint: { phase: "submit", attempts: task.state.checkpoint.attempts + 1 } }
              : { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        }
        host.onChange?.();
      },
      poll: async (task, runtime, context) => {
        const config = host.getMemoryConfig();
        if (!config.enabled || connectionFingerprint(config) !== task.input.connection) {
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(MemoryLifecycleDoc)).worklogs[task.input.sourceId];
            if (saved) { saved.status = "cancelled"; saved.error = "CONNECTION_CHANGED"; saved.updatedAt = runtime.now(); }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context); host.onChange?.(); return;
        }
        const polls = task.state.checkpoint.polls ?? 0;
        const nextDelayMs = Math.min(15_000, 2_000 * 2 ** Math.min(polls, 3));
        try {
          const receipt = await getHindsightOperation(config, task.input.caller, "shared", task.input.operationId, runtime.signal);
          const terminal = ["completed", "failed", "cancelled", "not_found"].includes(receipt.status);
          const nextStatus = receipt.status === "not_found" ? "failed" : receipt.status;
          const nextError = receipt.status === "failed"
            ? "UPSTREAM_OPERATION_FAILED"
            : receipt.status === "not_found"
              ? "OPERATION_NOT_FOUND"
              : undefined;
          let changed = false;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const saved = doc.worklogs[task.input.sourceId];
            const statusDiffers = Boolean(saved && (saved.status !== nextStatus || saved.error !== nextError));
            if (saved && (statusDiffers || terminal)) {
              saved.status = nextStatus;
              saved.updatedAt = runtime.now();
              if (nextError !== undefined) saved.error = nextError;
              else delete saved.error;
              changed = true;
            }
            if (terminal) pruneReceipts(doc);
            return terminal
              ? { status: "terminal", outcome: { status: "completed", result: null } }
              : { status: "sleeping", until: runtime.now() + nextDelayMs, checkpoint: { phase: "poll", polls: polls + 1 } };
          }, context);
          if (changed || terminal) host.onChange?.();
        } catch (error) {
          if (!(error instanceof HindsightAccessError)) throw error;
          if (runtime.signal.aborted) throw error;
          let changed = false;
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(MemoryLifecycleDoc)).worklogs[task.input.sourceId];
            const nextStatus = error.diagnostic.retryable ? saved?.status : "failed";
            if (saved && (saved.error !== error.diagnostic.code || saved.status !== nextStatus)) {
              saved.error = error.diagnostic.code;
              saved.updatedAt = runtime.now();
              if (!error.diagnostic.retryable) saved.status = "failed";
              changed = true;
            }
            return error.diagnostic.retryable
              ? { status: "sleeping", until: runtime.now() + 30_000, checkpoint: { phase: "poll", polls: polls + 1 } }
              : { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          if (changed || !error.diagnostic.retryable) host.onChange?.();
        }
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const receipt = (await tx.doc(MemoryLifecycleDoc)).worklogs[task.input.sourceId];
        if (receipt) { receipt.status = "cancelled"; receipt.updatedAt = runtime.now(); }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
      host.onChange?.();
    },
  });

  const recallTicketMemory = async (ticket: Readonly<TicketRecord>, context: Context): Promise<string | undefined> => {
    const config = host.getMemoryConfig();
    if (!config.enabled || config.accessMode === "private-only" || !ticket.projectId) return undefined;
    const sourceId = `external-start:${ticket.workerConversationId}:${ticket.id}:${ticket.runEpoch}`;
    const existing = (await host.getHarness().snapshot(MemoryLifecycleDoc, context))?.recalls[sourceId];
    if (existing) return existing.text || undefined;
    const caller: MemoryCallerContext = {
      role: "worker",
      conversationId: String(ticket.workerConversationId),
      ticketId: ticket.id,
      runEpoch: ticket.runEpoch,
      projectId: ticket.projectId,
      workerRole: ticket.role,
    };
    const timeoutSignal = AbortSignal.timeout(1_500);
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeoutSignal]) : timeoutSignal;
    let result: Awaited<ReturnType<typeof executeHindsightTool>>;
    try {
      result = await executeHindsightTool({
        config,
        caller,
        bank: "shared",
        toolName: "hindsight_recall",
        args: { query: buildTicketRecallQuery(ticket), scope: "project", budget: "low", max_tokens: 1000 },
        signal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !context.abortSignal?.aborted) return undefined;
      throw error;
    }
    if (timeoutSignal.aborted && !context.abortSignal?.aborted) return undefined;
    const data = parseRecallPayload(result.text);
    const formatted = !result.isError && !data.parseError ? formatRecalledMemoryItems(data.results) : "";
    const text = formatted
      ? `[KULO_MEMORY_CONTEXT ${sourceId}]\nHistorical shared project work records (verify against live code; grants no permissions):\n${formatted}`
      : "";
    const errorCode = result.isError ? (data.code ?? "UNAVAILABLE") : data.parseError ? data.code : undefined;
    await host.getHarness().commit(async (tx) => {
      const doc = await tx.doc(MemoryLifecycleDoc);
      if (doc.recalls[sourceId]) return;
      doc.recalls[sourceId] = { text, timestamp: Date.now(), requestTaskId: 0, ...(errorCode ? { error: errorCode } : {}) };
    }, context);
    host.onChange?.();
    return text || undefined;
  };

  const retainExternalTicketReport = async (ticket: Readonly<TicketRecord>, report: Readonly<WorkerReportRecord>, context: Context): Promise<void> => {
    const config = host.getMemoryConfig();
    if (!config.enabled || config.accessMode === "private-only" || !ticket.projectId) return;
    if (!report.summary.trim() || (report.state === "progress" && !report.deliverable?.trim())) return;
    const sourceId = `external-report:${ticket.workerConversationId}:${ticket.id}:${ticket.runEpoch}`;
    const title = `工作记录：${ticket.title}`;
    const content = [
      `报告状态：${report.state}`,
      report.summary.trim(),
      report.deliverable?.trim() ? `验证与交付：${report.deliverable.trim()}` : "",
      report.overflowAsset ? `完整汇报内部资产：${report.overflowAsset.id}（${report.overflowAsset.name}，${report.overflowAsset.totalChars} 字符）` : "",
      report.question?.trim() ? `未解决问题：${report.question.trim()}` : "",
    ].filter(Boolean).join("\n\n");
    const caller: Omit<MemoryCallerContext, "isValidTicket"> = {
      role: "worker",
      conversationId: String(ticket.workerConversationId),
      sourceId,
      ticketId: ticket.id,
      runEpoch: ticket.runEpoch,
      ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
      workerRole: ticket.role,
    };
    const operationId = memoryOperationId(sourceId);
    const documentId = memoryDocumentId(caller, title);
    await host.getHarness().commit(async (tx) => {
      const doc = await tx.doc(MemoryLifecycleDoc);
      if (doc.worklogs[sourceId]) return;
      const timestamp = Date.now();
      const receipt: MemoryWorklogReceipt = {
        sourceId,
        ticketId: ticket.id,
        ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
        operationId,
        documentId,
        status: "submitting",
        updatedAt: timestamp,
      };
      doc.worklogs[sourceId] = receipt;
      if (!isSafeMemoryText(content) || !isSafeMemoryText(title)) {
        receipt.status = "failed";
        receipt.error = "UNSAFE_CONTENT";
        return;
      }
      const taskId = await tx.createTask(worklogTask, { sourceId, caller, title, content, timestamp, operationId, connection: connectionFingerprint(config) },
        { ownership: { kind: "conversation" }, conversationId: ticket.workerConversationId as never, background: true });
      receipt.taskId = Number(taskId);
      pruneReceipts(doc);
    }, context);
    host.onChange?.();
  };

  const isPrivateRecordStillAuthorized = async (
    input: PrivateRetainInput,
    context: Context,
  ): Promise<{ authorized: boolean; reason?: string }> => {
    const harness = host.getHarness();
    const [lifecycle, wmDoc, personalityDoc, state] = await Promise.all([
      harness.snapshot(MemoryLifecycleDoc, context),
      harness.snapshot(KuloWorkingMemoryDoc, context),
      harness.snapshot(PersonalityDoc, context),
      harness.snapshot(KuloStateDoc, context),
    ]);
    const receipt = lifecycle?.privateRetains?.[input.sourceId];
    if (receipt?.revokedAt || receipt?.status === "revoked" || receipt?.status === "cancelled") {
      return { authorized: false, reason: "REVOKED" };
    }
    const forgotten = personalityDoc?.forgottenTerms ?? [];
    if (forgotten.some((term) => matchesForgottenTerm(input.content, term.term))) {
      return { authorized: false, reason: "FORGOTTEN" };
    }
    const globalRecords = wmDoc?.buckets?.global ?? [];
    const liveRec = globalRecords.find((r) => r.id === input.recordId);
    if (!liveRec || liveRec.status !== "active") {
      return { authorized: false, reason: "RECORD_INACTIVE" };
    }
    if (liveRec.provenance.topicId) {
      const topic = state?.topics?.[liveRec.provenance.topicId];
      if (!topic || topic.deletedAt !== undefined) {
        return { authorized: false, reason: "TOPIC_DELETED" };
      }
    }
    return { authorized: true };
  };

  /**
   * Independent Stage 4 Durable Task (`kulo.memory-private-retain`):
   * - Hard-locks host-derived `caller.role === "router"`, `bank = "private"`, router connection fingerprint.
   * - Works in both `"kulo"` and `"private-only"` modes (never mixes with Worker `worklogTask`).
   * - Retries strictly resend the immutable payload persisted on first enqueue.
   */
  const privateRetainTask = defineTask<PrivateRetainInput, WorklogState, null>({
    name: MEMORY_PRIVATE_RETAIN_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "submit", attempts: 0 }),
    phases: {
      submit: async (task, runtime, context) => {
        const config = host.getMemoryConfig();
        const auth = await isPrivateRecordStillAuthorized(task.input, context);
        if (!auth.authorized) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const receipt = doc.privateRetains?.[task.input.sourceId];
            if (receipt) {
              receipt.status = "revoked";
              receipt.revokedAt ??= runtime.now();
              receipt.error = auth.reason ?? "REVOKED";
              receipt.updatedAt = runtime.now();
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          host.onChange?.();
          return;
        }
        if (!config.enabled || connectionFingerprint(config, "router") !== task.input.connection) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const receipt = doc.privateRetains?.[task.input.sourceId];
            if (receipt) {
              receipt.status = "cancelled";
              receipt.error = config.enabled ? "CONNECTION_CHANGED" : "DISABLED";
              receipt.updatedAt = runtime.now();
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          host.onChange?.();
          return;
        }
        // Strictly host-derived router caller (never worker, never cross-topic project bank).
        const caller: MemoryCallerContext = {
          role: "router",
          conversationId: String(task.input.conversationId),
          sourceId: task.input.sourceId,
        };
        try {
          const receipt = await retainHindsightDocument({
            config,
            caller,
            bank: "private",
            title: task.input.title,
            content: task.input.content,
            timestamp: task.input.timestamp,
            operationId: task.input.operationId,
            source: "document",
            signal: runtime.signal,
          });
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const saved = doc.privateRetains?.[task.input.sourceId];
            if (saved) {
              saved.status = receipt.status;
              saved.updatedAt = runtime.now();
              delete saved.error;
            }
            return receipt.status === "completed"
              ? { status: "terminal", outcome: { status: "completed", result: null } }
              : { status: "sleeping", until: runtime.now() + 1500, checkpoint: { phase: "poll" } };
          }, context);
        } catch (error) {
          if (!(error instanceof HindsightAccessError)) throw error;
          if (runtime.signal.aborted) throw error;
          const retry = error.diagnostic.retryable && task.state.checkpoint.attempts < 4;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const saved = doc.privateRetains?.[task.input.sourceId];
            if (saved) {
              saved.error = error.diagnostic.code;
              saved.status = retry ? "submitting" : "failed";
              saved.updatedAt = runtime.now();
            }
            return retry
              ? {
                  status: "sleeping",
                  until: runtime.now() + 1000 * 2 ** task.state.checkpoint.attempts,
                  checkpoint: { phase: "submit", attempts: task.state.checkpoint.attempts + 1 },
                }
              : { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        }
        host.onChange?.();
      },
      poll: async (task, runtime, context) => {
        const config = host.getMemoryConfig();
        const auth = await isPrivateRecordStillAuthorized(task.input, context);
        if (!config.enabled || connectionFingerprint(config, "router") !== task.input.connection) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const saved = doc.privateRetains?.[task.input.sourceId];
            if (saved) {
              saved.status = "cancelled";
              saved.error = config.enabled ? "CONNECTION_CHANGED" : "DISABLED";
              saved.updatedAt = runtime.now();
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          host.onChange?.();
          return;
        }
        const caller: MemoryCallerContext = {
          role: "router",
          conversationId: String(task.input.conversationId),
          sourceId: task.input.sourceId,
        };
        const polls = task.state.checkpoint.polls ?? 0;
        const nextDelayMs = Math.min(15_000, 2_000 * 2 ** Math.min(polls, 3));
        try {
          const receipt = await getHindsightOperation(config, caller, "private", task.input.operationId, runtime.signal);
          const terminal = ["completed", "failed", "cancelled", "not_found"].includes(receipt.status);
          const nextStatus = !auth.authorized
            ? "revoked"
            : receipt.status === "not_found"
              ? "failed"
              : receipt.status;
          const nextError = !auth.authorized
            ? (auth.reason ?? "REVOKED")
            : receipt.status === "failed"
              ? "UPSTREAM_OPERATION_FAILED"
              : receipt.status === "not_found"
                ? "OPERATION_NOT_FOUND"
                : undefined;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const saved = doc.privateRetains?.[task.input.sourceId];
            if (saved) {
              saved.status = nextStatus;
              saved.updatedAt = runtime.now();
              if (nextError !== undefined) saved.error = nextError;
              else delete saved.error;
            }
            if (terminal) pruneReceipts(doc);
            return terminal
              ? { status: "terminal", outcome: { status: "completed", result: null } }
              : { status: "sleeping", until: runtime.now() + nextDelayMs, checkpoint: { phase: "poll", polls: polls + 1 } };
          }, context);
          host.onChange?.();
        } catch (error) {
          if (!(error instanceof HindsightAccessError)) throw error;
          if (runtime.signal.aborted) throw error;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            const saved = doc.privateRetains?.[task.input.sourceId];
            if (saved) {
              saved.error = error.diagnostic.code;
              saved.updatedAt = runtime.now();
              if (!error.diagnostic.retryable) saved.status = "failed";
            }
            return error.diagnostic.retryable
              ? { status: "sleeping", until: runtime.now() + 30_000, checkpoint: { phase: "poll", polls: polls + 1 } }
              : { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          host.onChange?.();
        }
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(MemoryLifecycleDoc);
        const receipt = doc.privateRetains?.[task.input.sourceId];
        if (receipt) {
          receipt.status = "cancelled";
          receipt.updatedAt = runtime.now();
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
      host.onChange?.();
    },
  });

  /**
   * Conditionally mirrors ONLY explicitly `global`-scoped `user_decision` working-memory facts
   * into Hindsight `private` bank (`router` identity). Project and ordinary topic facts stay local!
   */
  const retainGlobalWorkingMemoryRecords = async (
    records: readonly WorkingMemoryRecord[],
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<number> => {
    const config = host.getMemoryConfig();
    if (!config.enabled) return 0;
    const eligible = records.filter(
      (record) =>
        record.status === "active" &&
        record.bucketId === "global" &&
        record.evidenceLevel === "user_decision" &&
        (record.category === "decision" || record.category === "fact") &&
        isSafeMemoryText(record.summary) &&
        !isSuspiciousMemoryInstruction(record.summary),
    );
    if (eligible.length === 0) return 0;

    const routerConn = connectionFingerprint(config, "router");
    let enqueued = 0;
    await host.getHarness().commit(async (tx) => {
      const doc = await tx.doc(MemoryLifecycleDoc);
      doc.privateRetains ??= {};
      for (const record of eligible) {
        const sourceId = `wm-private:${record.id}:${record.fingerprint}`;
        if (doc.privateRetains[sourceId]) continue;
        const title = `长期偏好与决定（${record.date}）`;
        const content = `[${record.category}] ${record.summary}`;
        const caller: MemoryCallerContext = {
          role: "router",
          conversationId: String(record.provenance.conversationId),
          sourceId,
        };
        const operationId = memoryOperationId(sourceId);
        const documentId = memoryDocumentId(caller, title);
        const timestamp = record.updatedAt || Date.now();
        const receipt: MemoryPrivateRetainReceipt = {
          sourceId,
          recordId: record.id,
          conversationId: record.provenance.conversationId,
          bucketId: record.bucketId,
          operationId,
          documentId,
          title,
          content,
          timestamp,
          status: "submitting",
          updatedAt: Date.now(),
        };
        doc.privateRetains[sourceId] = receipt;
        const taskId = await tx.createTask(
          privateRetainTask,
          {
            sourceId,
            recordId: record.id,
            conversationId: record.provenance.conversationId,
            title,
            content,
            timestamp,
            operationId,
            connection: routerConn,
          },
          {
            ownership: { kind: "conversation" },
            conversationId: record.provenance.conversationId as never,
            background: true,
          },
        );
        receipt.taskId = Number(taskId);
        enqueued += 1;
      }
      if (enqueued > 0) pruneReceipts(doc);
    }, context);
    if (enqueued > 0) host.onChange?.();
    return enqueued;
  };

  /**
   * Marks matching `privateRetains` receipts as revoked on `kulo_memory_forget` so pending/offline
   * submits cancel before sending and completed receipts record offline revocation status.
   */
  const revokePrivateRetainsForTerm = async (
    term: string,
    reason: string | undefined,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<number> => {
    let revoked = 0;
    await host.getHarness().commit(async (tx) => {
      const doc = await tx.doc(MemoryLifecycleDoc);
      if (!doc.privateRetains) return;
      const now = Date.now();
      for (const receipt of Object.values(doc.privateRetains)) {
        if (!matchesForgottenTerm(receipt.content, term) && !matchesForgottenTerm(receipt.title, term)) continue;
        if (receipt.status === "revoked" && receipt.revokedAt) continue;
        receipt.status = "revoked";
        receipt.revokedAt = now;
        if (reason) receipt.revocationReason = reason;
        receipt.updatedAt = now;
        revoked += 1;
      }
    }, context);
    if (revoked > 0) host.onChange?.();
    return revoked;
  };

  return Object.assign(defineExtension({
    name: "kulo-memory-lifecycle", tasks: [worklogTask, privateRetainTask],
    hooks: [
      hook(GenerationTask, { beforeRequest: async (request, api, context) => {
        const config = host.getMemoryConfig();
        if (!config.enabled || config.accessMode === "private-only") return;
        const state = await api.snapshot(KuloStateDoc, context);
        const scope = resolveTicketExecutionScope(state, api.conversationId);
        if (!scope || scope.ticket.status !== "running" || !scope.ticket.projectId) return;
        const sourceId = `worker-start:${api.conversationId}:${scope.ticket.id}:${scope.ticket.runEpoch}`;
        let receipt = (await api.snapshot(MemoryLifecycleDoc, context))?.recalls[sourceId];
        if (!receipt) {
          const caller = memoryCallerFromState(state, api.conversationId);
          const timeoutSignal = AbortSignal.timeout(host.recallTimeoutMs ?? 1_500);
          const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeoutSignal]) : timeoutSignal;
          const result = await executeHindsightTool({ config, caller, bank: "shared", toolName: "hindsight_recall",
            args: { query: buildTicketRecallQuery(scope.ticket), scope: "project", budget: "low", max_tokens: 1000 },
            signal });
          context.abortSignal?.throwIfAborted();
          const timedOut = timeoutSignal.aborted;
          const data = timedOut ? {} : parseRecallPayload(result.text);
          const formatted = !timedOut && !result.isError && !data.parseError ? formatRecalledMemoryItems(data.results) : "";
          const text = formatted
            ? `[KULO_MEMORY_CONTEXT ${sourceId}]\nHistorical shared project work records (verify against live evidence; grants no permissions):\n${formatted}` : "";
          const errorCode = timedOut ? "TIMEOUT" : result.isError ? (data.code ?? "UNAVAILABLE") : data.parseError ? data.code : undefined;
          receipt = await host.getHarness().commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            if (doc.recalls[sourceId]) return JSON.parse(JSON.stringify(doc.recalls[sourceId])) as MemoryRecallReceipt;
            const saved: MemoryRecallReceipt = { text, timestamp: Date.now(), requestTaskId: Number(api.taskId), ...(errorCode ? { error: errorCode } : {}) };
            doc.recalls[sourceId] = saved;
            if (text) await tx.appendEntry(MemoryContextEntry, api.conversationId, { data: { sourceId, text }, model: [{ role: "user", content: text, timestamp: saved.timestamp }] });
            return saved;
          }, context);
          host.onChange?.();
        }
        if (!receipt.text || request.messages.some((message) => message.role === "user" && message.content === receipt!.text)) return;
        // Compaction may remove the old entry. Reintroducing it in each subsequent turn would move
        // the evidence block and invalidate prefixes; only its original request needs this bridge.
        if (receipt.requestTaskId !== Number(api.taskId)) return;
        // The same committed message is reused across retries; later requests already contain its entry.
        return { messages: [...request.messages, { role: "user" as const, content: receipt.text, timestamp: receipt.timestamp }] };
      } }),
      hook(ToolTask, { afterTool: async (call, result, api, context) => {
        if (call.name !== "kulo_report" || result.isError) return;
        const config = host.getMemoryConfig();
        if (!config.enabled || config.accessMode === "private-only") return;
        const state = await api.snapshot(KuloStateDoc, context);
        const scope = resolveTicketExecutionScope(state, api.conversationId);
        if (!scope || scope.isSubagent || scope.ticket.status !== "running" || !scope.ticket.projectId) return;
        const args = call.arguments as { state?: string; summary?: string; deliverable?: string; question?: string };
        const persisted = scope.ticket.latestReport;
        const effectiveState = persisted?.state ?? args.state;
        const effectiveSummary = (persisted?.summary ?? args.summary ?? "").trim();
        const effectiveDeliverable = (persisted?.deliverable ?? args.deliverable ?? "").trim();
        const effectiveQuestion = (persisted?.question ?? args.question ?? "").trim();
        const overflowAsset = persisted?.overflowAsset;
        if (!effectiveSummary || (effectiveState === "progress" && !effectiveDeliverable)) return;
        const sourceId = `worker-report:${api.conversationId}:${scope.ticket.runEpoch}:${call.id}`;
        const title = `工作记录：${scope.ticket.title}`;
        const content = [
          `报告状态：${effectiveState}`,
          effectiveSummary,
          effectiveDeliverable ? `验证与交付：${effectiveDeliverable}` : "",
          overflowAsset ? `完整汇报内部资产：${overflowAsset.id}（${overflowAsset.name}，${overflowAsset.totalChars} 字符）` : "",
          effectiveQuestion ? `未解决问题：${effectiveQuestion}` : "",
        ].filter(Boolean).join("\n\n");
        const caller = memoryCallerFromState(state, api.conversationId, sourceId);
        const operationId = memoryOperationId(sourceId);
        const documentId = memoryDocumentId(caller, title);
        await host.getHarness().commit(async (tx) => {
          const doc = await tx.doc(MemoryLifecycleDoc);
          if (doc.worklogs[sourceId]) return;
          const timestamp = Date.now();
          const receipt: MemoryWorklogReceipt = { sourceId, ticketId: scope.ticket.id, ...(scope.ticket.projectId ? { projectId: scope.ticket.projectId } : {}),
            operationId, documentId, status: "submitting", updatedAt: timestamp };
          doc.worklogs[sourceId] = receipt;
          if (!isSafeMemoryText(content) || !isSafeMemoryText(title)) { receipt.status = "failed"; receipt.error = "UNSAFE_CONTENT"; return; }
          const taskId = await tx.createTask(worklogTask, { sourceId, caller, title, content, timestamp, operationId, connection: connectionFingerprint(config) },
            { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
          receipt.taskId = Number(taskId);
          pruneReceipts(doc);
        }, context);
        host.onChange?.();
        return undefined;
      } }),
    ],
  }), { recallTicketMemory, retainExternalTicketReport, retainGlobalWorkingMemoryRecords, revokePrivateRetainsForTerm, privateRetainTask });
}
