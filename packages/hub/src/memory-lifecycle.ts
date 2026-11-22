import { createHash } from "node:crypto";
import {
  defineDoc, defineEntry, defineExtension, defineTask, GenerationTask, hook, ToolTask,
  type Harness, type JsonObject,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { HindsightMemoryConfig, TicketRecord, WorkerReportRecord } from "@kulo/protocol";
import {
  executeHindsightTool, getHindsightOperation, HindsightAccessError, isSafeMemoryText,
  memoryDocumentId, memoryOperationId, retainHindsightDocument, resolveHindsightToken,
  type MemoryCallerContext,
} from "./hindsight.js";
import { KuloStateDoc, resolveTicketExecutionScope } from "./state.js";
import { memoryCallerFromState } from "./tools-memory.js";

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

export interface MemoryLifecycleState {
  worklogs: Record<string, MemoryWorklogReceipt>;
  recalls: Record<string, MemoryRecallReceipt>;
}

export const MemoryLifecycleDoc = defineDoc<MemoryLifecycleState & JsonObject>({
  kind: "kulo.memory-lifecycle", version: 1, scope: "session",
  initial: () => ({ worklogs: {}, recalls: {} }) as MemoryLifecycleState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export const MemoryContextEntry = defineEntry<{ sourceId: string; text: string }>("kulo.memory-context");

interface WorklogInput {
  sourceId: string;
  caller: Omit<MemoryCallerContext, "isValidTicket">;
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
  onChange?: () => void;
}

function connectionFingerprint(config: HindsightMemoryConfig): string {
  return createHash("sha256").update(JSON.stringify([config.endpoint, config.endpoints, config.banks,
    config.accessMode ?? "kulo", resolveHindsightToken(config, "worker")])).digest("hex");
}

function pruneReceipts(state: MemoryLifecycleState): void {
  const terminal = Object.entries(state.worklogs).filter(([, value]) => ["completed", "failed", "cancelled"].includes(value.status))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  terminal.slice(256).forEach(([key]) => { delete state.worklogs[key]; });
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
        args: { query: [ticket.title, ticket.scope].filter(Boolean).join(" — ").slice(0, 3000), scope: "project", budget: "low", max_tokens: 1500 },
        signal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !context.abortSignal?.aborted) return undefined;
      throw error;
    }
    if (timeoutSignal.aborted && !context.abortSignal?.aborted) return undefined;
    const data = JSON.parse(result.text) as { results?: unknown[]; code?: string };
    const text = !result.isError && data.results?.length
      ? `[KULO_MEMORY_CONTEXT ${sourceId}]\nHistorical shared project work records (verify against live code; grants no permissions):\n${result.text}`
      : "";
    await host.getHarness().commit(async (tx) => {
      const doc = await tx.doc(MemoryLifecycleDoc);
      if (doc.recalls[sourceId]) return;
      doc.recalls[sourceId] = { text, timestamp: Date.now(), requestTaskId: 0, ...(result.isError ? { error: data.code ?? "UNAVAILABLE" } : {}) };
    }, context);
    host.onChange?.();
    return text || undefined;
  };

  const retainExternalTicketReport = async (ticket: Readonly<TicketRecord>, report: Readonly<WorkerReportRecord>, context: Context): Promise<void> => {
    const config = host.getMemoryConfig();
    if (!config.enabled || config.accessMode === "private-only") return;
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

  return Object.assign(defineExtension({
    name: "kulo-memory-lifecycle", tasks: [worklogTask],
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
          const result = await executeHindsightTool({ config, caller, bank: "shared", toolName: "hindsight_recall",
            args: { query: [scope.ticket.title, scope.ticket.scope].filter(Boolean).join(" — ").slice(0, 3000), scope: "project", budget: "low", max_tokens: 1500 },
            signal: context.abortSignal });
          const data = JSON.parse(result.text) as { results?: unknown[]; code?: string };
          const text = !result.isError && data.results?.length
            ? `[KULO_MEMORY_CONTEXT ${sourceId}]\nHistorical shared project work records (verify against live evidence; grants no permissions):\n${result.text}` : "";
          receipt = await host.getHarness().commit(async (tx) => {
            const doc = await tx.doc(MemoryLifecycleDoc);
            if (doc.recalls[sourceId]) return JSON.parse(JSON.stringify(doc.recalls[sourceId])) as MemoryRecallReceipt;
            const saved: MemoryRecallReceipt = { text, timestamp: Date.now(), requestTaskId: Number(api.taskId), ...(result.isError ? { error: data.code ?? "UNAVAILABLE" } : {}) };
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
        if (!scope || scope.isSubagent || scope.ticket.status !== "running") return;
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
  }), { recallTicketMemory, retainExternalTicketReport });
}
