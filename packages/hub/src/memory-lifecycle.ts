import { createHash } from "node:crypto";
import {
  defineDoc, defineExtension, defineTask, GenerationTask, hook, ToolTask,
  type Harness, type JsonObject,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { HindsightMemoryConfig, TicketRecord, WorkerReportRecord } from "@kulo/protocol";
import {
  buildTicketRecallQuery,
  formatBuiltinRecallBlock,
  formatRecalledMemoryItems,
  MemoryContextEntry,
  parseRecallPayload,
} from "./builtin-memory-entries.js";
import { BuiltinMemoryDoc } from "./builtin-memory-doc.js";
import type { BuiltinMemoryRecallHit } from "./builtin-memory-store.js";
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

export {
  buildTicketRecallQuery,
  formatRecalledMemoryItems,
  MemoryContextEntry,
  parseRecallPayload,
} from "./builtin-memory-entries.js";

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
  engine?: "hindsight" | "builtin";
  clearEpoch?: number;
  memoryIds?: string[];
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

export interface BuiltinMemoryLifecyclePort {
  isSharedEffectiveActive: () => boolean;
  getCurrentEpochs: () => { clearTargetEpoch: number; engineEpoch: number };
  recallForWorkerTicket: (ticket: Readonly<TicketRecord>, query: string, limit?: number, context?: Context) => Promise<BuiltinMemoryRecallHit[]>;
  retainWorkerOrExternalReport: (
    input: { source: "worklog" | "external_report"; sourceId: string; ticket: Readonly<TicketRecord>; content: string },
    context?: Context,
  ) => Promise<boolean>;
}

interface MemoryLifecycleHost {
  getHarness: () => Harness;
  getMemoryConfig: () => HindsightMemoryConfig;
  getBuiltinMemory?: () => BuiltinMemoryLifecyclePort | undefined;
  redact?: (text: string) => string;
  recallTimeoutMs?: number;
  onChange?: () => void;
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
    if (!ticket.projectId) return undefined;
    const sourceId = `external-start:${ticket.workerConversationId}:${ticket.id}:${ticket.runEpoch}`;
    if (!config.enabled) {
      const builtin = host.getBuiltinMemory?.();
      if (!builtin?.isSharedEffectiveActive()) return undefined;
      const hits = await builtin.recallForWorkerTicket(ticket, buildTicketRecallQuery(ticket), 6, context);
      return formatBuiltinRecallBlock({
        sourceId,
        header: "Historical shared project work records (verify against live code; grants no permissions):",
        hits,
        redact: host.redact ?? ((s) => s),
      }) || undefined;
    }
    if (config.accessMode === "private-only") return undefined;
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
    if (!ticket.projectId) return;
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
    if (!config.enabled) {
      const builtin = host.getBuiltinMemory?.();
      if (builtin?.isSharedEffectiveActive()) {
        await builtin.retainWorkerOrExternalReport({ source: "external_report", sourceId, ticket, content: `${title}\n${content}` }, context);
      }
      return;
    }
    if (config.accessMode === "private-only") return;
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
        const builtin = !config.enabled ? host.getBuiltinMemory?.() : undefined;
        const useBuiltin = Boolean(builtin?.isSharedEffectiveActive());
        if (!useBuiltin && (!config.enabled || config.accessMode === "private-only")) return;
        const state = await api.snapshot(KuloStateDoc, context);
        const scope = resolveTicketExecutionScope(state, api.conversationId);
        if (!scope || scope.ticket.status !== "running" || !scope.ticket.projectId) return;
        const clearEpoch = useBuiltin ? builtin!.getCurrentEpochs().clearTargetEpoch : undefined;
        const sourceId = useBuiltin
          ? `worker-start:${api.conversationId}:${scope.ticket.id}:${scope.ticket.runEpoch}:b${clearEpoch}`
          : `worker-start:${api.conversationId}:${scope.ticket.id}:${scope.ticket.runEpoch}`;
        let receipt = (await api.snapshot(MemoryLifecycleDoc, context))?.recalls[sourceId];
        if (!receipt) {
          let text = "";
          let errorCode: string | undefined;
          let memoryIds: string[] | undefined;
          if (useBuiltin) {
            const hits = await builtin!.recallForWorkerTicket(scope.ticket, buildTicketRecallQuery(scope.ticket), 6, context);
            text = formatBuiltinRecallBlock({
              sourceId,
              header: "Historical shared project work records (verify against live evidence; grants no permissions):",
              hits,
              redact: host.redact ?? ((s) => s),
            });
            memoryIds = hits.flatMap((h) => h.mergedIds);
          } else {
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
            text = formatted
              ? `[KULO_MEMORY_CONTEXT ${sourceId}]\nHistorical shared project work records (verify against live evidence; grants no permissions):\n${formatted}` : "";
            errorCode = timedOut ? "TIMEOUT" : result.isError ? (data.code ?? "UNAVAILABLE") : data.parseError ? data.code : undefined;
          }
          const workerConv = useBuiltin ? await host.getHarness().conversation(api.conversationId, context) : undefined;
          const workerView = workerConv ? await workerConv.context(context) : undefined;
          const tailIdx = workerView ? workerView.contributions.findLastIndex((c) => c.length > 0) : -1;
          const tailEntry = tailIdx >= 0 ? workerView!.entries[tailIdx] : undefined;
          const tailMsgs = tailIdx >= 0 ? workerView!.contributions[tailIdx] : undefined;
          const canWrapTail = Boolean(useBuiltin && tailEntry && tailMsgs?.length && tailMsgs.every((m) => m.role === "user"));
          receipt = await host.getHarness().commit(async (tx) => {
            if (useBuiltin) {
              const bmDoc = await tx.doc(BuiltinMemoryDoc);
              if (!bmDoc.enabled || bmDoc.clearTargetEpoch !== clearEpoch) return undefined;
            }
            const doc = await tx.doc(MemoryLifecycleDoc);
            if (doc.recalls[sourceId]) return JSON.parse(JSON.stringify(doc.recalls[sourceId])) as MemoryRecallReceipt;
            const saved: MemoryRecallReceipt = {
              text, timestamp: Date.now(), requestTaskId: Number(api.taskId),
              engine: useBuiltin ? "builtin" : "hindsight",
              ...(clearEpoch !== undefined ? { clearEpoch } : {}),
              ...(memoryIds?.length ? { memoryIds } : {}),
              ...(errorCode ? { error: errorCode } : {}),
            };
            doc.recalls[sourceId] = saved;
            if (text) {
              const memMsg = { role: "user" as const, content: text, timestamp: saved.timestamp };
              await tx.appendEntry(MemoryContextEntry, api.conversationId, canWrapTail
                ? {
                    data: { sourceId, text, engine: "builtin", ...(clearEpoch !== undefined ? { clearEpoch } : {}), ...(memoryIds?.length ? { memoryIds } : {}), targetEntryId: Number(tailEntry!.id) },
                    edits: [{ target: tailEntry!.id, action: "replace", messages: [...tailMsgs!.slice(0, -1), memMsg, tailMsgs!.at(-1)!] }],
                  }
                : {
                    data: { sourceId, text, engine: useBuiltin ? "builtin" : "hindsight", ...(clearEpoch !== undefined ? { clearEpoch } : {}), ...(memoryIds?.length ? { memoryIds } : {}) },
                    model: [memMsg],
                  });
            }
            return saved;
          }, context);
          if (!receipt) return;
          host.onChange?.();
        }
        if (useBuiltin && receipt.clearEpoch !== undefined && receipt.clearEpoch < builtin!.getCurrentEpochs().clearTargetEpoch) return;
        if (!receipt.text || request.messages.some((message) => message.role === "user" && message.content === receipt!.text)) return;
        if (receipt.requestTaskId !== Number(api.taskId)) return;
        const memMsg = { role: "user" as const, content: receipt.text, timestamp: receipt.timestamp };
        return {
          messages: useBuiltin && request.messages.at(-1)?.role === "user"
            ? [...request.messages.slice(0, -1), memMsg, request.messages.at(-1)!]
            : [...request.messages, memMsg],
        };
      } }),
      hook(ToolTask, { afterTool: async (call, result, api, context) => {
        if (call.name !== "kulo_report" || result.isError) return;
        const config = host.getMemoryConfig();
        const builtin = !config.enabled ? host.getBuiltinMemory?.() : undefined;
        const useBuiltin = Boolean(builtin?.isSharedEffectiveActive());
        if (!useBuiltin && (!config.enabled || config.accessMode === "private-only")) return;
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
        if (useBuiltin) {
          await builtin!.retainWorkerOrExternalReport({ source: "worklog", sourceId, ticket: scope.ticket, content: `${title}\n${content}` }, context);
          return undefined;
        }
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
