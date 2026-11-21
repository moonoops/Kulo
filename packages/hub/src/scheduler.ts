import {
  AssistantEntry,
  ToolResultEntry,
  ROOT_CONVERSATION_ID,
  defineTask,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import type { Context } from "@earendil-works/chord/context";
import { describeKuloError, isSupportedExternalAgentKind, type ExternalAgentPendingReport, type ExternalAgentRuntimeEvent, type ExternalAgentUncertainReason, type StagedWorkspaceDiffSummary, type TicketRecord, type TicketWait, type WorkerExecutionPhase, type WorkerReportRecord } from "@kulo/protocol";
import { spillOversizedReport } from "./report-overflow.js";
import {
  formatExternalAgentFollowUpPrompt,
  formatExternalAgentHandoffPrompt,
  formatExternalPermissionMessage,
  formatStagedDiffRelayLines,
  formatWorkerInitialPrompt,
  formatWorkerRelayMessage,
} from "./prompts.js";
import { KuloStateDoc, WorkerRelayEntry, getActiveStagedCwd, hasActiveSubagents, hasPendingWorkspaceApply, releaseSlot, transitionTicketStatus, tryClaimSlot, type KuloDurableState } from "./state.js";
import { SettingsAssistantDoc, isActiveSettingsConversation, parseSettingsTopicConversationId } from "./settings-doc.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import type { KuloUploadStore } from "./uploads.js";
import { nativeSearchEvidence, sanitizeSearchSources, selectCitedSources } from "./search-sources.js";
import { beginTicketRecovery, resolveSupersededTickets, type createFailureRecoveryTask } from "./task-recovery.js";
import { submitAutomaticChatInput } from "./chat-control.js";
import { bindDispatchedAttachments } from "./ticket-dispatch.js";

export type WorkerTicketTaskInput = {
  ticketId: string;
  runEpoch: number;
  promptOverride: string | null;
  attachmentIds?: string[];
};

export type WorkerTicketTaskState =
  | { phase: "acquire_slot" }
  | { phase: "run_worker" }
  | { phase: "wait_until" }
  | { phase: "external_wait"; failures?: number }
  | {
      phase: "deliver_report";
      fallbackSummary?: string;
      unansweredReason?: string;
      unansweredDetail?: string;
    };

export interface WorkerTicketTaskDependencies {
  recoveryTask?: ReturnType<typeof createFailureRecoveryTask>;
  envManager: EnvManager;
  uploads: KuloUploadStore;
  getMaxConcurrentWorkers: () => number;
  onTicketsChanged?: () => void;
  onTicketRunning?: (
    ticketId: string,
    workerConversationId: number,
    runEpoch: number,
  ) => void;
  onTicketSettled?: (ticketId: string) => void;
  isTicketRunnable?: (ticket: Readonly<TicketRecord>, state: Readonly<KuloDurableState>) => boolean;
  onTicketWaiting?: (ticketId: string, reason: TicketWait["reason"]) => void;
  resumeWaitingTicket?: (ticketId: string, context: Context) => Promise<unknown>;
  prepareTicketRelease?: (ticket: Readonly<TicketRecord>, context: Context) => Promise<{ cleanupPending: boolean }>;
  redact?: (text: string) => string;
  ticketAgentBlock?: (ticket: Readonly<TicketRecord>) => string | undefined;
  getProjectMeta?: (projectId: string, context: Context) => Promise<{ id: string; name: string; workspaceDir: string } | undefined>;
  materializeExternalAttachments?: (ticket: Readonly<TicketRecord>, attachmentIds: readonly string[], context: Context) => Promise<Array<{ id: string; name: string; mimeType: string; path: string }>>;
  recallExternalMemory?: (ticket: Readonly<TicketRecord>, context: Context) => Promise<string | undefined>;
  retainExternalMemory?: (ticket: Readonly<TicketRecord>, report: WorkerReportRecord, context: Context) => Promise<void>;
  consumeExternalPendingReports?: (ticket: Readonly<TicketRecord>, reports: readonly ExternalAgentPendingReport[], context: Context) => Promise<string[]>;
  hasTicketConnections?: (ticket: Readonly<TicketRecord>) => boolean;
  isExternalMemoryEnabled?: () => boolean;
  syncWorkerConversation?: (ticket: Readonly<TicketRecord>, context: Context) => Promise<void>;
  prepareBuiltInStagedWorkspace?: (ticket: Readonly<TicketRecord>, context: Context) => Promise<{ stagedCwd: string; reused: boolean; warnings?: string[] }>;
  inspectBuiltInStagedDiff?: (ticket: Readonly<TicketRecord>, context: Context) => Promise<StagedWorkspaceDiffSummary | undefined>;
  discardBuiltInStagedWorkspace?: (ticket: Readonly<TicketRecord>, context: Context) => Promise<void>;
  onInlineCandidateSettled?: (ticketId: string) => void;
  onOriginConversationRelayed?: (originConversationId: number, context: Context) => Promise<void>;
}

export function createWorkerTicketTask(deps: WorkerTicketTaskDependencies) {
  const devicesOnline = (ticket: Readonly<TicketRecord>) => Boolean(deps.envManager.getEnvDescriptor(ticket.envId)?.online) &&
    (ticket.androidDeviceIds ?? (ticket.executionDomain === "android" ? [ticket.envId] : [])).every(id => {
      const phone = deps.envManager.getEnvDescriptor(id);
      return phone?.online && phone.executionKind === "native-device" && phone.android?.enabled && !phone.android.paused;
    });
  return defineTask<WorkerTicketTaskInput, WorkerTicketTaskState, null>({
    name: "kulo.worker_ticket",
    version: 1,
    initial: () => ({ phase: "acquire_slot" }),
    phases: {
      acquire_slot: async (task, runtime, context) => {
        let notified = false;
        let startedInfo:
          | { ticketId: string; workerConversationId: number; runEpoch: number }
          | undefined;
        let waitingReason: TicketWait["reason"] | undefined;
        await runtime.commit(async (tx) => {
          const state = await tx.doc(KuloStateDoc);
          const ticket = state.tickets[task.input.ticketId];
          if (
            !ticket ||
            ticket.status === "stopped" ||
            ticket.status === "closed" ||
            ticket.runEpoch !== task.input.runEpoch
          ) {
            if (ticket?.runEpoch === task.input.runEpoch) releaseSlot(state, task.input.ticketId);
            return { status: "terminal", outcome: { status: "aborted" } };
          }

          if (ticket.waiting && ticket.waiting.reason !== "project") {
            if (hasActiveSubagents(state, ticket.id)) {
              transitionTicketStatus(ticket, "pausing", runtime.now());
              return { status: "sleeping", until: runtime.now() + 300, checkpoint: { phase: "acquire_slot" } };
            }
            transitionTicketStatus(ticket, "waiting", runtime.now());
            ticket.updatedAt = runtime.now();
            releaseSlot(state, ticket.id);
            waitingReason = ticket.waiting.reason;
            notified = true;
            if (ticket.waiting.reason === "time") {
              return { status: "running", checkpoint: { phase: "wait_until" } };
            }
            ticket.activeTaskId = undefined;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }

          const agentBlock = deps.ticketAgentBlock?.(ticket);
          if (agentBlock) {
            const question = "请恢复指定 Agent 的可用状态，或明确选择其他 Agent。";
            ticket.latestReport = { state: "blocked", summary: agentBlock, question, at: runtime.now() };
            ticket.waiting = { reason: "user", since: runtime.now(), detail: question };
            return { status: "running", checkpoint: { phase: "deliver_report" } };
          }

          if (!devicesOnline(ticket)) {
            ticket.waiting = { reason: "env", since: runtime.now(), detail: `执行设备 ${ticket.envId} 离线` };
            transitionTicketStatus(ticket, hasActiveSubagents(state, ticket.id) ? "pausing" : "waiting", runtime.now());
            ticket.updatedAt = runtime.now();
            if (ticket.status === "pausing") {
              return { status: "sleeping", until: runtime.now() + 300, checkpoint: { phase: "acquire_slot" } };
            }
            releaseSlot(state, ticket.id);
            ticket.activeTaskId = undefined;
            waitingReason = "env";
            notified = true;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }

          const claimed = tryClaimSlot(
            state,
            ticket.id,
            deps.getMaxConcurrentWorkers(),
            { isRunnable: (candidate) => devicesOnline(candidate) &&
              deps.isTicketRunnable?.(candidate, state) !== false },
          );

          if (!claimed) {
            if (ticket.status !== "queued") {
              transitionTicketStatus(ticket, "queued", runtime.now());
              ticket.updatedAt = runtime.now();
              notified = true;
            }
            return {
              status: "sleeping",
              until: runtime.now() + 300,
              checkpoint: { phase: "acquire_slot" },
            };
          }

          const now = runtime.now();
          transitionTicketStatus(ticket, "running", now);
          ticket.waiting = undefined;
          if (ticket.schedule) ticket.schedule.nextRunAt = null;
          ticket.updatedAt = now;
          notified = true;
          startedInfo = {
            ticketId: ticket.id,
            workerConversationId: ticket.workerConversationId,
            runEpoch: ticket.runEpoch,
          };
          return {
            status: "running",
            checkpoint: { phase: "run_worker" },
          };
        }, context);

        if (startedInfo) {
          deps.onTicketRunning?.(
            startedInfo.ticketId,
            startedInfo.workerConversationId,
            startedInfo.runEpoch,
          );
        }
        if (waitingReason) {
          deps.onTicketWaiting?.(task.input.ticketId, waitingReason);
          deps.onTicketSettled?.(task.input.ticketId);
        }
        if (notified) deps.onTicketsChanged?.();
      },

      run_worker: async (task, runtime, context) => {
        const snapshot = await runtime.snapshot(KuloStateDoc, context);
        const ticket = snapshot?.tickets[task.input.ticketId];
        if (
          !ticket ||
          ticket.status === "stopped" ||
          ticket.status === "closed" ||
          ticket.runEpoch !== task.input.runEpoch
        ) {
          let currentRun = false;
          await runtime.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            if (state.tickets[task.input.ticketId]?.runEpoch === task.input.runEpoch) {
              releaseSlot(state, task.input.ticketId);
              currentRun = true;
            }
            return { status: "terminal", outcome: { status: "aborted" } };
          }, context);
          if (currentRun) {
            deps.onTicketSettled?.(task.input.ticketId);
            deps.onTicketsChanged?.();
          }
          return;
        }

        const agentBlock = deps.ticketAgentBlock?.(ticket);
        if (agentBlock) {
          await runtime.commit(async (tx) => {
            const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
            if (!current || current.runEpoch !== task.input.runEpoch) return { status: "terminal", outcome: { status: "aborted" } };
            const question = "请恢复指定 Agent 的可用状态，或明确选择其他 Agent。";
            current.latestReport = { state: "blocked", summary: agentBlock, question, at: runtime.now() };
            current.waiting = { reason: "user", since: runtime.now(), detail: question };
            return { status: "running", checkpoint: { phase: "deliver_report" } };
          }, context);
          return;
        }

        try {
          bindDispatchedAttachments(deps.uploads, ticket);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await runtime.commit(async () => ({
            status: "running",
            checkpoint: { phase: "deliver_report", unansweredReason: "无法准备工单输入附件", unansweredDetail: deps.redact?.(detail) ?? detail },
          }), context);
          return;
        }

        if (ticket.externalExecution) {
          const external = ticket.externalExecution;
          const runId = `kulo:external:${ticket.id}:${task.input.runEpoch}`;
          const followUpText = task.input.promptOverride ?? ticket.resumePrompt;
          const isResumingNativeSession = Boolean(
            task.input.runEpoch > 1 &&
              external.sessionId &&
              external.binding.capabilities?.resume !== false &&
              isSupportedExternalAgentKind(external.binding.kind) &&
              followUpText?.trim(),
          );
          const attachmentIds = [...new Set([
            ...(task.input.attachmentIds ?? []),
            ...(!isResumingNativeSession ? (ticket.inputAttachmentIds ?? []) : []),
            ...(ticket.resumeAttachmentIds ?? []),
          ])];
          let materialized: Array<{ id: string; name: string; mimeType: string; path: string }> = [];
          if (attachmentIds.length > 0 && deps.materializeExternalAttachments) {
            materialized = await deps.materializeExternalAttachments(ticket, attachmentIds, context);
          }
          const projectMeta = !isResumingNativeSession && ticket.projectId && deps.getProjectMeta
            ? await deps.getProjectMeta(ticket.projectId, context).catch(() => undefined)
            : undefined;
          const recalledMemory = !isResumingNativeSession && deps.recallExternalMemory
            ? await deps.recallExternalMemory(ticket, context).catch(() => undefined)
            : undefined;
          const prompt = isResumingNativeSession
            ? formatExternalAgentFollowUpPrompt({
                ticket,
                followUp: followUpText!.trim(),
                materialized,
              })
            : formatExternalAgentHandoffPrompt({
                ticket,
                instructions: external.instructions,
                workspaceMode: external.workspaceMode === "read_only" || external.workspaceMode === "direct" ? external.workspaceMode : "staged",
                projectName: projectMeta?.name,
                recalledMemory,
                materialized,
                followUp: followUpText,
                localEnvId: deps.envManager.localEnvId,
              });
          await runtime.commit(async (tx) => {
            const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
            if (!current || current.runEpoch !== task.input.runEpoch || current.status === "stopped" || current.status === "closed") return { status: "terminal", outcome: { status: "aborted" } };
            current.externalExecution!.runId = runId;
            current.externalExecution!.notifiedPermissions = [];
            current.externalExecution!.lastActivityAt = runtime.now();
            return { status: "running", checkpoint: { phase: "external_wait" } };
          }, context);
          const current = (await runtime.snapshot(KuloStateDoc, context))?.tickets[ticket.id];
          if (!current || current.runEpoch !== task.input.runEpoch || current.status !== "running") return;
          try {
            const response = await deps.envManager.requestExternalAgent(ticket.envId, { operation: "run", binding: external.binding,
              taskId: ticket.id, runEpoch: task.input.runEpoch, requestId: runId, prompt, cwd: ticket.workspaceDir,
              ...(external.workspaceMode ? { workspaceMode: external.workspaceMode } : {}),
              ...(external.modelId ? { modelId: external.modelId } : {}),
              ...(external.thinkingLevel ? { thinkingLevel: external.thinkingLevel } : {}),
              ...(external.sessionId ? { sessionId: external.sessionId } : {}),
              readOnly: Boolean(ticket.readOnly || external.workspaceMode === "read_only"), allowSubagents: Boolean(external.allowSubagents), taskTools: true,
              ...(deps.hasTicketConnections?.(ticket) ? { hasConnections: true } : {}),
              ...(deps.isExternalMemoryEnabled?.() ? { memoryEnabled: true } : {}),
              projectId: ticket.projectId, directoryId: ticket.directoryId, grantRevision: ticket.grantRevision, timeoutMs: 30 * 60_000 });
            if (response.type !== "run" || response.run.id !== runId || response.run.taskId !== ticket.id || response.run.runEpoch !== task.input.runEpoch || response.run.kind !== external.binding.kind) throw new Error("客户端未返回匹配的任务执行标识。");
            await runtime.commit(async (tx) => {
              const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
              if (live?.runEpoch === task.input.runEpoch) {
                live.externalExecution!.runId = response.run.id;
                live.externalExecution!.sessionId = response.run.sessionId;
                if (response.run.stagedCwd) live.externalExecution!.stagedCwd = response.run.stagedCwd;
                live.externalExecution!.lastActivityAt = runtime.now();
                live.resumePrompt = undefined;
                live.resumeAttachmentIds = undefined;
              }
              return { status: "running", checkpoint: { phase: "external_wait" } };
            }, context);
          } catch (error) {
            // An acknowledgement can be lost after native admission. Inspect the deterministic run before another input.
            await runtime.commit(async (tx) => {
              const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
              if (live?.runEpoch === task.input.runEpoch) live.latestReport = { state: "progress", summary: deps.redact?.(error instanceof Error ? error.message : String(error)) ?? "客户端接收状态待核对。", at: runtime.now() };
              return { status: "sleeping", until: runtime.now() + 1000, checkpoint: { phase: "external_wait" } };
            }, context);
          }
          return;
        }

        // Android runs only Hub-hosted tools and never acquires a computer filesystem.
        try {
          if (ticket.executionDomain !== "android") {
            let activeStagedCwd = getActiveStagedCwd(ticket);
            if (ticket.workspaceStaging?.mode === "staged" && ticket.projectId && deps.prepareBuiltInStagedWorkspace) {
              const prepared = await deps.prepareBuiltInStagedWorkspace(ticket, context);
              activeStagedCwd = prepared.stagedCwd;
              await runtime.commit(async (tx) => {
                const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
                if (!current || current.runEpoch !== task.input.runEpoch || current.status !== "running") return undefined;
                current.workspaceStaging = {
                  mode: "staged",
                  stagedCwd: prepared.stagedCwd,
                  ...(prepared.warnings?.length ? { warnings: prepared.warnings } : {}),
                };
                current.updatedAt = runtime.now();
                return undefined;
              }, context);
            }
            const effectiveWorkspaceDir = activeStagedCwd ?? ticket.workspaceDir;
            const execEnv = deps.envManager.createWorkerExecutionEnv(
              ticket.envId,
              effectiveWorkspaceDir,
              {
                scratchDir: ticket.scratchDir,
                projectId: ticket.projectId,
                grantRevision: ticket.grantRevision,
                readOnly: ticket.readOnly,
                ...(activeStagedCwd ? { stagedTaskId: ticket.id } : {}),
              },
            );
            const mkdirRes = await execEnv.createDir(
              effectiveWorkspaceDir,
              { recursive: true },
              context,
            );
            if (!mkdirRes.ok) {
              throw new Error(mkdirRes.error.message);
            }
            if (ticket.scratchDir) {
              const scratchRes = await execEnv.createDir(
                ticket.scratchDir,
                { recursive: true },
                context,
              );
              if (!scratchRes.ok) {
                throw new Error(scratchRes.error.message);
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorCode = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : undefined;
          if (errorCode === "staged_workspace_oversized") {
            await runtime.commit(async (tx) => {
              const current = (await tx.doc(KuloStateDoc)).tickets[task.input.ticketId];
              if (current?.runEpoch === task.input.runEpoch && current.status !== "stopped" && current.status !== "closed") {
                const question = `${message}\n是否确认授权在原项目目录直接修改，或缩小任务范围？`;
                current.latestReport = {
                  state: "blocked",
                  summary: message,
                  question,
                  at: runtime.now(),
                };
                current.waiting = { reason: "user", since: runtime.now(), detail: question };
              }
              return { status: "running", checkpoint: { phase: "deliver_report" } };
            }, context);
            return;
          }
          if (!deps.envManager.getEnvDescriptor(ticket.envId)?.online) {
            await runtime.commit(async (tx) => {
              const state = await tx.doc(KuloStateDoc);
              const current = state.tickets[task.input.ticketId];
              if (current?.runEpoch === task.input.runEpoch && current.status !== "stopped" && current.status !== "closed") {
                current.waiting = { reason: "env", since: runtime.now(), detail: message };
                transitionTicketStatus(current, "pausing", runtime.now());
              }
              return { status: "running", checkpoint: { phase: "deliver_report" } };
            }, context);
            return;
          }
          await runtime.commit(async () => {
            return {
              status: "running",
              checkpoint: {
                phase: "deliver_report",
                unansweredReason: `Environment '${ticket.envId}' preparation failed: ${message}`,
              },
            };
          }, context);
          return;
        }

        const preparedState = await runtime.snapshot(KuloStateDoc, context);
        const preparedTicket = preparedState?.tickets[ticket.id];
        if (!preparedTicket || preparedTicket.runEpoch !== task.input.runEpoch || preparedTicket.status !== "running") {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        }

        // A deterministic admission reattaches to the same turn after crash recovery.
        const workerConv = await runtime.conversation(
          ticket.workerConversationId as never,
          context,
        );
        if (!workerConv) {
          await runtime.commit(async () => ({
            status: "running",
            checkpoint: {
              phase: "deliver_report",
              unansweredReason: "Worker conversation record missing",
            },
          }), context);
          return;
        }

        await deps.syncWorkerConversation?.(preparedTicket, context);

        const pendingPrompt = preparedTicket.resumePrompt;
        const pendingAttachmentIds = [...(preparedTicket.resumeAttachmentIds ?? [])];
        const initialPrompt = task.input.promptOverride ?? formatWorkerInitialPrompt(preparedTicket);
        const rawPrompt = pendingPrompt && pendingPrompt !== initialPrompt
          ? `${initialPrompt}\n\n【排队期间补充要求】\n${pendingPrompt}`
          : initialPrompt;
        const attachmentIds = [...new Set([...(task.input.attachmentIds ?? []), ...pendingAttachmentIds])];
        const promptContent = deps.uploads.buildMultimodalContent(
          rawPrompt,
          attachmentIds,
        ).content;
        const requestId = `kulo:worker-run:${ticket.id}:${task.input.runEpoch}`;

        const submission = await workerConv.submit(
          {
            type: "input",
            content: promptContent,
            requestId,
          },
          context,
        );

        if (pendingPrompt !== undefined || pendingAttachmentIds.length > 0) {
          await runtime.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const current = state.tickets[ticket.id];
            if (!current || current.runEpoch !== task.input.runEpoch) return undefined;
            const currentAttachments = current.resumeAttachmentIds ?? [];
            if (current.resumePrompt === pendingPrompt && currentAttachments.length === pendingAttachmentIds.length &&
                currentAttachments.every((id, index) => id === pendingAttachmentIds[index])) {
              current.resumePrompt = undefined;
              current.resumeAttachmentIds = undefined;
            }
            return undefined;
          }, context);
        }

        const settled = await submission.wait(context);
        // Also drain any mid-run steers queued into the worker conversation
        await workerConv.waitForIdle(context);

        let fallbackSummary: string | undefined;
        let unansweredReason: string | undefined;
        let unansweredDetail: string | undefined;

        if (settled.status === "done" && settled.type === "input") {
          // Extract assistant text in case the model finished without calling `kulo_report`
          const history = await runtime.context(
            ticket.workerConversationId as never,
            context,
          );
          for (let i = history.entries.length - 1; i >= 0; i--) {
            const entry = history.entries[i]!;
            if (AssistantEntry.is(entry)) {
              const msg = entry.model?.[0];
              if (msg && msg.role === "assistant") {
                const textParts = msg.content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text.trim())
                  .filter(Boolean);
                if (textParts.length > 0) {
                  fallbackSummary = textParts.join("\n");
                  break;
                }
              }
            }
          }
        } else if (settled.status === "unanswered") {
          unansweredReason = settled.reason;
          if (settled.detail !== undefined) {
            unansweredDetail =
              typeof settled.detail === "string"
                ? settled.detail
                : JSON.stringify(settled.detail);
          }
        }

        await runtime.commit(async () => ({
          status: "running",
          checkpoint: {
            phase: "deliver_report",
            ...(fallbackSummary ? { fallbackSummary } : {}),
            ...(unansweredReason ? { unansweredReason } : {}),
            ...(unansweredDetail ? { unansweredDetail } : {}),
          },
        }), context);
      },

      external_wait: async (task, runtime, context) => {
        const ticket = (await runtime.snapshot(KuloStateDoc, context))?.tickets[task.input.ticketId];
        if (!ticket || ticket.runEpoch !== task.input.runEpoch || ["stopped", "closed"].includes(ticket.status)) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context); return;
        }
        const execution = ticket.externalExecution;
        if (!execution?.runId) throw new Error("外部任务缺少已持久化的执行标识。");
        if (!deps.envManager.getEnvDescriptor(ticket.envId)?.online || deps.envManager.getConnectionState?.(ticket.envId) === "reconnecting") {
          await runtime.commit(async () => ({ status: "sleeping", until: runtime.now() + 750, checkpoint: { phase: "external_wait" } }), context); return;
        }
        try {
          const response = await deps.envManager.requestExternalAgent(ticket.envId, { operation: "inspect", runId: execution.runId, afterSequence: execution.lastSequence });
          if (response.type !== "run") throw new Error("外部任务状态无效。");
          let activeTicket = ticket;
          let run = response.run;
          if (run.id !== execution.runId || run.taskId !== ticket.id || run.runEpoch !== task.input.runEpoch || run.kind !== execution.binding.kind) throw new Error("外部任务执行归属不匹配。");
          if (run.pendingReports?.length && deps.consumeExternalPendingReports) {
            const ackReportIds = await deps.consumeExternalPendingReports(activeTicket, run.pendingReports, context);
            if (ackReportIds.length > 0) {
              const refreshed = await deps.envManager.requestExternalAgent(activeTicket.envId, {
                operation: "inspect",
                runId: execution.runId,
                afterSequence: Math.max(execution.lastSequence ?? 0, run.nextSequence - 1),
                ackReportIds,
              });
              if (refreshed.type === "run" && refreshed.run.id === execution.runId && refreshed.run.taskId === activeTicket.id && refreshed.run.runEpoch === task.input.runEpoch && refreshed.run.kind === execution.binding.kind) {
                run = refreshed.run;
              }
              const latestSnap = (await runtime.snapshot(KuloStateDoc, context))?.tickets[task.input.ticketId];
              if (latestSnap) activeTicket = latestSnap;
            }
          }
          const redact = (value: string) => deps.redact?.(value) ?? value;
          const origin = run.permissions.length ? await runtime.conversation((activeTicket.originConversationId ?? ROOT_CONVERSATION_ID) as never, context) : undefined;
          const activeExplicitReady =
            activeTicket.externalExecution?.explicitReadyReport?.runEpoch === task.input.runEpoch
              ? activeTicket.externalExecution.explicitReadyReport
              : undefined;
          const fallbackNaturalReport =
            run.state === "completed" && !activeExplicitReady
              ? spillOversizedReport({
                  uploads: deps.uploads,
                  ticketId: activeTicket.id,
                  runEpoch: task.input.runEpoch,
                  version: 0,
                  ownerConversationId: activeTicket.workerConversationId,
                  originConversationId: activeTicket.originConversationId,
                  report: {
                    state: "ready",
                    summary: redact(run.text.slice(0, 1200) || "客户端已结束执行，等待主 Agent 验收。"),
                    ...(run.text ? { deliverable: redact(run.text) } : {}),
                    at: runtime.now(),
                  },
                })
              : undefined;
          const backfilledExplicitReady =
            run.state === "completed" &&
            activeExplicitReady &&
            !activeExplicitReady.deliverable &&
            !activeExplicitReady.overflowAsset &&
            run.text.trim().length > 0
              ? spillOversizedReport({
                  uploads: deps.uploads,
                  ticketId: activeTicket.id,
                  runEpoch: task.input.runEpoch,
                  version: activeExplicitReady.version,
                  ownerConversationId: activeTicket.workerConversationId,
                  originConversationId: activeTicket.originConversationId,
                  report: {
                    state: activeExplicitReady.state,
                    summary: activeExplicitReady.summary,
                    deliverable: redact(run.text),
                    ...(activeExplicitReady.attachments ? { attachments: activeExplicitReady.attachments } : {}),
                    at: activeExplicitReady.at,
                  },
                })
              : undefined;
          const phaseLabel = (phase?: WorkerExecutionPhase): string => {
            switch (phase) {
              case "investigating": return "正在排查分析…";
              case "editing": return "正在编辑修改…";
              case "verifying": return "正在运行验证…";
              case "responding": return "正在整理回复…";
              case "waiting_permission": return "等待客户端授权…";
              default: return "客户端正在执行。";
            }
          };
          const isHeartbeatStateEvent = (ev: ExternalAgentRuntimeEvent) =>
            ev.type === "state" && /^(?:Thinking|Reasoning|Executing|Working|Running tool)\.\.\.$/.test(ev.text);
          await runtime.commit(async (tx) => {
            const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
            if (!live || live.runEpoch !== task.input.runEpoch) return { status: "terminal", outcome: { status: "aborted" } };
            live.externalExecution!.sessionId = run.sessionId;
            live.externalExecution!.lastSequence = Math.max(0, run.nextSequence - 1);
            live.externalExecution!.pendingPermissions = run.permissions;
            if (run.stagedCwd) live.externalExecution!.stagedCwd = run.stagedCwd;
            if (run.stagedDiff) live.externalExecution!.stagedDiff = run.stagedDiff;
            if (run.phase) live.externalExecution!.phase = run.phase;
            if (run.touchedFiles?.length) live.externalExecution!.touchedFiles = [...run.touchedFiles];
            if (run.uncertainReason) live.externalExecution!.uncertainReason = run.uncertainReason;
            if (run.readOnlyViolation) live.externalExecution!.readOnlyViolation = run.readOnlyViolation;
            if (run.events.length > 0) {
              live.externalExecution!.lastActivityAt = Math.max(
                live.externalExecution!.lastActivityAt ?? 0,
                ...run.events.map((event) => event.at),
              );
              const nonMessage = run.events.filter((ev) => ev.type !== "message");
              if (nonMessage.length > 0) {
                const merged = [...(live.externalExecution!.recentEvents ?? [])];
                const seenSeq = new Set(merged.map((ev) => ev.sequence));
                for (const ev of nonMessage) {
                  if (seenSeq.has(ev.sequence)) continue;
                  const last = merged.at(-1);
                  if (last && isHeartbeatStateEvent(ev) && isHeartbeatStateEvent(last) && last.text === ev.text) {
                    merged[merged.length - 1] = { sequence: ev.sequence, at: ev.at, type: ev.type, text: redact(ev.text).slice(0, 500) };
                  } else {
                    merged.push({ sequence: ev.sequence, at: ev.at, type: ev.type, text: redact(ev.text).slice(0, 500) });
                  }
                  seenSeq.add(ev.sequence);
                }
                live.externalExecution!.recentEvents = merged.slice(-30);
              }
            }
            if (origin) for (const permission of run.permissions) {
              const notified = live.externalExecution!.notifiedPermissions ?? [];
              if (notified.includes(permission.id)) continue;
              await injectEventToolsInTx(tx, origin.id, ["kulo_inspect", "kulo_external_permission"]);
              await submitAutomaticChatInput(tx, origin, { type: "input", whenBusy: "followUp", requestId: `kulo:external-permission:${ticket.id}:${task.input.runEpoch}:${permission.id}`,
                content: formatExternalPermissionMessage({
                  ticketId: ticket.id,
                  title: ticket.title,
                  permissionId: permission.id,
                  runEpoch: task.input.runEpoch,
                  permissionTitle: redact(permission.title),
                  choicesJson: JSON.stringify(permission.choices),
                }),
                entry: { kind: WorkerRelayEntry.kind, data: { ticketId: ticket.id, title: ticket.title, role: ticket.role, state: "blocked", summary: redact(permission.title), question: "本地客户端正在等待授权决定。", deliverable: null } } });
              live.externalExecution!.notifiedPermissions = [...notified, permission.id];
            }
            const explicitReady =
              live.externalExecution?.explicitReadyReport?.runEpoch === task.input.runEpoch
                ? live.externalExecution.explicitReadyReport
                : undefined;
            if ((run.events.length || run.permissions.length) && !explicitReady && (!live.latestReport || live.latestReport.state === "progress")) {
              const latestTool = [...(live.externalExecution!.recentEvents ?? [])].reverse().find((ev) => ev.type === "tool");
              live.updatedAt = runtime.now();
              live.latestReport = {
                state: "progress",
                summary: redact(
                  run.permissions[0]?.title ??
                    (run.text.trim() ? run.text.slice(-1200) : latestTool?.text ?? phaseLabel(run.phase ?? live.externalExecution!.phase)),
                ),
                at: runtime.now(),
              };
            }
            if (["completed", "failed", "cancelled", "uncertain"].includes(run.state)) {
              if (live.externalExecution!.interruptPending && live.wakePending && live.resumePrompt) {
                live.latestReport = { state: "progress", summary: "已中断上一轮执行，正在继续新指令。", at: runtime.now() };
                return { status: "running", checkpoint: { phase: "deliver_report" } };
              }
              const readOnlyViolation = run.readOnlyViolation ?? live.externalExecution?.readOnlyViolation;
              const withViolation = (base: WorkerReportRecord): WorkerReportRecord =>
                readOnlyViolation ? { ...base, readOnlyViolation } : base;
              const autoRecoverableFailure = run.state === "failed" && live.agentAssignment?.source === "orchestrator";
              const resumableTimeout =
                run.state === "uncertain" &&
                run.uncertainReason === "timeout" &&
                Boolean(run.sessionId);
              if (run.state === "completed") {
                if (live.latestReport && ["blocked", "failed"].includes(live.latestReport.state)) {
                  live.latestReport = withViolation(live.latestReport);
                } else if (explicitReady) {
                  const { runEpoch: _re, version: _ver, ...preserved } = explicitReady;
                  const resolved = !preserved.deliverable && !preserved.overflowAsset && backfilledExplicitReady
                    ? { ...preserved, ...(backfilledExplicitReady.deliverable ? { deliverable: backfilledExplicitReady.deliverable } : {}), ...(backfilledExplicitReady.overflowAsset ? { overflowAsset: backfilledExplicitReady.overflowAsset } : {}) }
                    : preserved;
                  live.latestReport = withViolation(resolved);
                } else {
                  live.latestReport = withViolation(
                    fallbackNaturalReport ?? {
                      state: "ready",
                      summary: redact(run.text.slice(0, 1200) || "客户端已结束执行，等待主 Agent 验收。"),
                      ...(run.text ? { deliverable: redact(run.text) } : {}),
                      at: runtime.now(),
                    },
                  );
                }
              } else if (resumableTimeout) {
                const elapsedSec = Math.max(1, Math.round((runtime.now() - (live.startedRunningAt ?? live.createdAt)) / 1000));
                const diff = run.stagedDiff ?? live.externalExecution?.stagedDiff;
                const stagedCounts = diff?.hasChanges
                  ? `+${diff.added.length} 新增 / ~${diff.modified.length} 修改 / -${diff.deleted.length} 删除`
                  : undefined;
                live.latestReport = withViolation({
                  state: "blocked",
                  summary: `外部智能体已运行约 ${elapsedSec} 秒并触发单次超时上限，原会话存档点（sessionId）已完整保留${stagedCounts ? `（暂存区已有部分改动：${stagedCounts}）` : ""}。`,
                  question: `该任务已运行约 ${elapsedSec} 秒达到单次超时上限，但原生会话进度${stagedCounts ? `与暂存区部分改动（${stagedCounts}）` : ""}均已保留。是否基于原会话继续加时执行，或先审阅当前进度？`,
                  at: runtime.now(),
                });
              } else if (autoRecoverableFailure) {
                live.latestReport = withViolation({
                  state: "failed",
                  summary: redact(run.error || "外部智能体执行失败。"),
                  at: runtime.now(),
                });
              } else {
                const question = run.state === "failed"
                  ? `具体原因：${redact(run.error || "客户端未返回失败原因")}\n请按错误原因恢复指定客户端后，再决定是否重试；不会自动改派其他智能体。`
                  : "请检查原会话后决定是否继续；未自动重发任务。";
                live.latestReport = withViolation({
                  state: "blocked",
                  summary: redact(run.error || `客户端状态：${run.state}`),
                  question,
                  at: runtime.now(),
                });
                live.waiting = { reason: "user", since: runtime.now(), detail: question };
              }
              return { status: "running", checkpoint: { phase: "deliver_report" } };
            }
            return { status: "sleeping", until: runtime.now() + 750, checkpoint: { phase: "external_wait" } };
          }, context);
          deps.onTicketsChanged?.();
        } catch (error) {
          const message = deps.redact?.(error instanceof Error ? error.message : String(error)) ?? "外部执行状态待核对。";
          const failures = (task.state.checkpoint.failures ?? 0) + 1;
          await runtime.commit(async (tx) => {
            const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
            if (!live || live.runEpoch !== task.input.runEpoch) return { status: "terminal", outcome: { status: "aborted" } };
            const hasExplicitReady = live.externalExecution?.explicitReadyReport?.runEpoch === task.input.runEpoch;
            if (failures < 6 && !/not found|归属不匹配|状态无效/i.test(message)) {
              if (!hasExplicitReady && (!live.latestReport || live.latestReport.state === "progress")) {
                live.latestReport = { state: "progress", summary: message, at: runtime.now() };
              }
              return { status: "sleeping", until: runtime.now() + 1500, checkpoint: { phase: "external_wait", failures } };
            }
            if (live?.runEpoch === task.input.runEpoch) {
              if (hasExplicitReady) {
                const { runEpoch: _re, version: _ver, ...preserved } = live.externalExecution!.explicitReadyReport!;
                live.latestReport = preserved;
              } else {
                const question = "原执行接收状态不明确，请核对客户端后继续；未自动重发。";
                live.latestReport = { state: "blocked", summary: message, question, at: runtime.now() };
                live.waiting = { reason: "user", since: runtime.now(), detail: question };
              }
            }
            return { status: "running", checkpoint: { phase: "deliver_report" } };
          }, context);
        }
      },

      deliver_report: async (task, runtime, context) => {
        const snapshot = await runtime.snapshot(KuloStateDoc, context);
        const pending = snapshot?.tickets[task.input.ticketId];
        if (!pending || pending.runEpoch !== task.input.runEpoch) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        }
        if (hasActiveSubagents(snapshot!, pending.id)) {
          await runtime.commit(async (tx) => {
            const state = await tx.doc(KuloStateDoc);
            const current = state.tickets[pending.id];
            if (current?.runEpoch === task.input.runEpoch && current.waiting) transitionTicketStatus(current, "pausing", runtime.now());
            return { status: "sleeping", until: runtime.now() + 300, checkpoint: task.state.checkpoint };
          }, context);
          return;
        }
        const cleanup = await deps.prepareTicketRelease?.(pending, context);
        let builtInStagedDiff: StagedWorkspaceDiffSummary | undefined;
        let builtInZeroDiffDiscarded = false;
        let externalZeroDiffDiscarded = false;
        const willSettleReady =
          !pending.waiting &&
          !task.state.checkpoint.unansweredReason &&
          (!pending.latestReport || pending.latestReport.state === "ready" || pending.latestReport.state === "progress");
        const canInspectBuiltInStaged = Boolean(
          !pending.externalExecution &&
            pending.workspaceStaging?.mode === "staged" &&
            pending.workspaceStaging.stagedCwd &&
            !pending.workspaceStaging.appliedAt &&
            !pending.workspaceStaging.discardedAt &&
            pending.status !== "stopped" &&
            pending.status !== "closed" &&
            !(
              pending.waiting &&
              !(
                (pending.waiting.reason === "user" || pending.waiting.reason === "coordinator") &&
                pending.latestReport?.state === "blocked"
              )
            ),
        );
        if (canInspectBuiltInStaged && deps.inspectBuiltInStagedDiff) {
          builtInStagedDiff = await deps.inspectBuiltInStagedDiff(pending, context).catch(() => undefined);
          if (builtInStagedDiff && !builtInStagedDiff.hasChanges && willSettleReady && !cleanup?.cleanupPending && deps.discardBuiltInStagedWorkspace) {
            await deps.discardBuiltInStagedWorkspace(pending, context).catch(() => {});
            builtInZeroDiffDiscarded = true;
          }
        }
        if (
          pending.externalExecution?.workspaceMode === "staged" &&
          pending.externalExecution.stagedCwd &&
          !pending.externalExecution.stagedAppliedAt &&
          pending.externalExecution.stagedDiff?.hasChanges === false &&
          pending.externalExecution.runId &&
          willSettleReady &&
          !cleanup?.cleanupPending &&
          pending.status !== "stopped" &&
          pending.status !== "closed"
        ) {
          await deps.envManager.requestExternalAgent(pending.envId, {
            operation: "close",
            runId: pending.externalExecution.runId,
            discardStaged: true,
          }).catch(() => {});
          externalZeroDiffDiscarded = true;
        }
        const evidenceEntries = pending.workerConversationId
          ? (await runtime.context(pending.workerConversationId as never, context)).entries : [];
        const evidence = evidenceEntries.flatMap((entry) => {
          const message = entry.model?.[0];
          const native = nativeSearchEvidence(message);
          if (native.sources.length) return [{ sources: native.sources, searchSuggestions: native.searchSuggestions.join("\n") }];
          if (!ToolResultEntry.is(entry)) return [];
          if (message?.role !== "toolResult" || message.isError || !["web_search", "web_fetch"].includes(message.toolName)) return [];
          return [message.details as { sources?: unknown; searchSuggestions?: unknown } | undefined];
        });
        const availableSources = sanitizeSearchSources(evidence.flatMap((details) => sanitizeSearchSources(details?.sources)));
        let parked = false;
        let interruptedContinue = false;
        let waitingReason: TicketWait["reason"] | undefined;
        let settledCurrentRun = false;
        let relayPayload:
          | {
              ticketId: string;
              title: string;
              role: string;
              originConvId?: number;
              report: WorkerReportRecord;
              stagedDiff?: StagedWorkspaceDiffSummary;
              uncertainReason?: ExternalAgentUncertainReason;
              hasNativeSession?: boolean;
            }
          | undefined;

        await runtime.commit(async (tx) => {
          const state = await tx.doc(KuloStateDoc);
          const ticket = state.tickets[task.input.ticketId];
          if (!ticket || ticket.runEpoch !== task.input.runEpoch) {
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }

          if (cleanup) ticket.cleanupPending = cleanup.cleanupPending;
          settledCurrentRun = true;

          if (ticket.activeTaskId === (task.id as number)) ticket.activeTaskId = undefined;
          const now = runtime.now();
          ticket.updatedAt = now;

          if (ticket.status === "stopped" || ticket.status === "closed") {
            releaseSlot(state, ticket.id);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }

          if (ticket.externalExecution?.interruptPending && ticket.wakePending && ticket.resumePrompt) {
            delete ticket.externalExecution.interruptPending;
            transitionTicketStatus(ticket, "waiting", now);
            ticket.waiting = { reason: "time", since: now, until: now, detail: "中断后继续补充要求" };
            releaseSlot(state, ticket.id, { releaseWrite: !hasPendingWorkspaceApply(ticket) });
            parked = true;
            if (!ticket.cleanupPending) interruptedContinue = true;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }

          if (
            ticket.waiting &&
            !(
              (ticket.waiting.reason === "user" || ticket.waiting.reason === "coordinator") &&
              ticket.latestReport?.state === "blocked"
            )
          ) {
            transitionTicketStatus(ticket, "waiting", now);
            releaseSlot(state, ticket.id, { releaseWrite: !hasPendingWorkspaceApply(ticket) });
            parked = true;
            waitingReason = ticket.waiting.reason;
            if (ticket.waiting.reason === "time") {
              const until = ticket.waiting.until;
              if (until === undefined || !Number.isFinite(until) || until < 0) throw new Error("Timed Worker wait requires a valid deadline");
              ticket.activeTaskId = task.id as number;
              return { status: "sleeping", until: Math.max(runtime.now(), until), checkpoint: { phase: "wait_until" } };
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }

          const latest = ticket.latestReport;
          let finalReport: WorkerReportRecord;

          if (
            latest &&
            (latest.state === "ready" ||
              latest.state === "blocked" ||
              latest.state === "failed")
          ) {
            finalReport = latest;
          } else if (task.state.checkpoint.unansweredReason) {
            const desc = describeKuloError({
              reason: task.state.checkpoint.unansweredReason,
              detail: task.state.checkpoint.unansweredDetail,
            });
            finalReport = {
              state: "failed",
              summary: desc.isUserAbort
                ? "任务已手动停止。"
                : `${desc.title}：${desc.hint}`,
              at: now,
            };
            ticket.latestReport = finalReport;
          } else {
            finalReport = {
              state: "ready",
              summary:
                task.state.checkpoint.fallbackSummary?.slice(0, 1200) ||
                "后台任务已执行完毕。",
              at: now,
            };
            ticket.latestReport = finalReport;
          }

          const pendingArtifacts = [...new Map([...(state.workerArtifacts?.[ticket.id] ?? []), ...(finalReport.attachments ?? [])].map((asset) => [asset.id, asset])).values()];
          if (pendingArtifacts.length) {
            finalReport = { ...finalReport, attachments: pendingArtifacts };
            ticket.latestReport = finalReport;
          }
          const deliveryFailure = state.fileDeliveryFailures?.[ticket.id];
          if (finalReport.state === "ready" && deliveryFailure?.runEpoch === ticket.runEpoch && Object.keys(deliveryFailure.errors).length) {
            finalReport = { ...finalReport, state: "failed", summary: "产物未能全部提交给主 Agent 审核。", deliverable: [finalReport.deliverable, ...Object.values(deliveryFailure.errors)].filter(Boolean).join("\n") };
            ticket.latestReport = finalReport;
          }
          if (ticket.workspaceStaging?.mode === "staged" && !ticket.workspaceStaging.appliedAt && !ticket.workspaceStaging.discardedAt) {
            if (builtInZeroDiffDiscarded && finalReport.state === "ready") {
              ticket.workspaceStaging.discardedAt = now;
              delete ticket.workspaceStaging.stagedCwd;
              delete ticket.workspaceStaging.stagedDiff;
            } else if (builtInStagedDiff) {
              ticket.workspaceStaging.stagedDiff = JSON.parse(JSON.stringify(builtInStagedDiff)) as StagedWorkspaceDiffSummary;
            }
          }
          if (externalZeroDiffDiscarded && finalReport.state === "ready" && ticket.externalExecution?.workspaceMode === "staged" && !ticket.externalExecution.stagedAppliedAt) {
            delete ticket.externalExecution.stagedCwd;
          }
          transitionTicketStatus(ticket, finalReport.state === "blocked" ? "waiting" : finalReport.state === "progress" ? "ready" : finalReport.state, now);
          if (finalReport.state === "blocked") {
            const keepUserWait = ticket.waiting?.reason === "user";
            ticket.waiting = keepUserWait
              ? {
                  ...ticket.waiting!,
                  detail: ticket.waiting!.detail ?? finalReport.question ?? finalReport.summary,
                }
              : {
                  reason: "coordinator",
                  since: now,
                  detail: finalReport.question ?? finalReport.summary,
                };
            waitingReason = ticket.waiting.reason;
          } else {
            ticket.waiting = undefined;
          }
          releaseSlot(state, ticket.id, { releaseWrite: !hasPendingWorkspaceApply(ticket) });
          if (finalReport.state === "ready") resolveSupersededTickets(state, ticket, now);
          if (finalReport.state === "failed" && deps.recoveryTask) {
            if (ticket.autoRecoverySuppressed) {
              transitionTicketStatus(ticket, "closed", now);
              ticket.closure = { kind: "obsolete", reason: "已忽略此前问题的自动恢复", at: now };
              ticket.recovery = undefined;
              return undefined;
            }
            const existed = Boolean(ticket.recovery);
            const recovery = beginTicketRecovery(ticket, now);
            if (!existed && (recovery.rootTicketId ?? ticket.id) === ticket.id) {
              await tx.createTask(deps.recoveryTask, { ticketId: ticket.id, startedAt: recovery.startedAt },
                { ownership: { kind: "conversation" }, background: true });
            }
            return undefined;
          }
          const activeStagedDiff =
            ticket.workspaceStaging?.mode === "staged" &&
            !ticket.workspaceStaging.appliedAt &&
            !ticket.workspaceStaging.discardedAt &&
            ticket.workspaceStaging.stagedDiff?.hasChanges
              ? ticket.workspaceStaging.stagedDiff
              : ticket.externalExecution?.workspaceMode === "staged" &&
                  !ticket.externalExecution.stagedAppliedAt &&
                  ticket.externalExecution.stagedDiff?.hasChanges
                ? ticket.externalExecution.stagedDiff
                : undefined;
          relayPayload = {
            ticketId: String(ticket.id),
            title: String(ticket.title),
            role: String(ticket.role),
            ...(ticket.originConversationId !== undefined
              ? { originConvId: ticket.originConversationId }
              : {}),
            ...(activeStagedDiff
              ? { stagedDiff: JSON.parse(JSON.stringify(activeStagedDiff)) as StagedWorkspaceDiffSummary }
              : {}),
            ...(ticket.externalExecution?.uncertainReason ? { uncertainReason: ticket.externalExecution.uncertainReason } : {}),
            ...(ticket.externalExecution?.sessionId ? { hasNativeSession: true } : {}),
            report: {
              state: finalReport.state,
              summary: finalReport.summary,
              ...(finalReport.deliverable ? { deliverable: finalReport.deliverable } : {}),
              ...(finalReport.attachments?.length ? { attachments: JSON.parse(JSON.stringify(finalReport.attachments)) as WorkerReportRecord["attachments"] } : {}),
              ...(finalReport.overflowAsset ? { overflowAsset: { ...finalReport.overflowAsset } } : {}),
              ...(finalReport.readOnlyViolation ? { readOnlyViolation: JSON.parse(JSON.stringify(finalReport.readOnlyViolation)) as WorkerReportRecord["readOnlyViolation"] } : {}),
              ...(finalReport.question ? { question: finalReport.question } : {}),
              ...(finalReport.options?.length ? { options: [...finalReport.options] } : {}),
              at: finalReport.at,
            },
          };

          return undefined;
        }, context);

        if (settledCurrentRun) {
          deps.onTicketSettled?.(task.input.ticketId);
          if (waitingReason) deps.onTicketWaiting?.(task.input.ticketId, waitingReason);
          deps.onTicketsChanged?.();
        }
        if (parked) {
          deps.onInlineCandidateSettled?.(task.input.ticketId);
          if (interruptedContinue) await deps.resumeWaitingTicket?.(task.input.ticketId, context);
          return;
        }

        if (!relayPayload) {
          deps.onInlineCandidateSettled?.(task.input.ticketId);
        }

        if (pending.externalExecution && relayPayload && deps.retainExternalMemory) {
          await deps.retainExternalMemory(pending, relayPayload.report, context).catch(() => {});
        }

        // Relay terminal/blocked outcome back to Kulo root conversation BEFORE marking task terminal!
        if (relayPayload) {
          const targetConvId = (relayPayload.originConvId ?? ROOT_CONVERSATION_ID) as never;
          const targetConv =
            (await runtime.conversation(targetConvId, context)) ??
            (await runtime.conversation(ROOT_CONVERSATION_ID, context));
          if (targetConv) {
            const { ticketId, title, role, report, stagedDiff, uncertainReason, hasNativeSession } = relayPayload;
            const sources = selectCitedSources([report.summary, report.deliverable ?? ""].join("\n"), availableSources);
            const searchSuggestions = sources.length ? [...new Set(evidence.flatMap((details) => typeof details?.searchSuggestions === "string" && details.searchSuggestions.length <= 24_000 ? [details.searchSuggestions] : []))].slice(-3) : [];
            const stagedLines = stagedDiff ? formatStagedDiffRelayLines(stagedDiff) : [];
            const relayText = formatWorkerRelayMessage({
              ticketId,
              title,
              role,
              report,
              stagedLines,
              sources,
              uncertainReason,
              hasNativeSession,
            });

            const eventTools: string[] = [];
            if (stagedDiff) {
              eventTools.push("kulo_inspect_staged_diff", "kulo_apply_staged_changes");
            }
            if (report.attachments?.length) {
              eventTools.push("kulo_inspect_asset", "kulo_publish_asset");
            } else if (report.overflowAsset) {
              eventTools.push("kulo_inspect_asset");
            }
            if (report.state === "failed" || report.state === "blocked") {
              eventTools.push("kulo_inspect");
            }
            if (report.state === "blocked") {
              eventTools.push("kulo_ticket_ask_user");
            }

            if (deps.onOriginConversationRelayed) {
              await deps.onOriginConversationRelayed(Number(targetConv.id), context).catch(() => {});
            }
            let notifyInlineWaiter = false;
            await runtime.commit(async (tx) => {
              const state = await tx.doc(KuloStateDoc);
              const currentTicket = state.tickets[ticketId];
              if (currentTicket?.deliveryClaim === "claimed_inline") {
                return undefined;
              }
              if (currentTicket?.deliveryClaim === "inline_waiting") {
                const cleanSmallStagedDiff =
                  !stagedDiff ||
                  (stagedDiff.conflictFiles.length === 0 &&
                    !(stagedDiff.sensitivePaths?.length) &&
                    stagedDiff.unifiedPreview.length <= 6_000);
                const canClaimInline =
                  report.state === "ready" &&
                  cleanSmallStagedDiff &&
                  !report.overflowAsset &&
                  !report.readOnlyViolation &&
                  !(report.attachments?.length) &&
                  !(state.workerArtifacts?.[ticketId]?.length);
                notifyInlineWaiter = true;
                if (canClaimInline) {
                  if (stagedDiff) {
                    await injectEventToolsInTx(tx, targetConv.id, ["kulo_inspect_staged_diff", "kulo_apply_staged_changes"]);
                  }
                  currentTicket.deliveryClaim = "claimed_inline";
                  currentTicket.inlineResult = {
                    state: report.state,
                    summary: report.summary,
                    deliverable: report.deliverable ?? null,
                    ...(sources.length ? { sources } : {}),
                    ...(stagedDiff ? { stagedDiff: JSON.parse(JSON.stringify(stagedDiff)) as StagedWorkspaceDiffSummary } : {}),
                  };
                  return undefined;
                }
                currentTicket.deliveryClaim = "escalated";
              }
              if (eventTools.length > 0) {
                await injectEventToolsInTx(tx, targetConv.id, eventTools);
              }
              await submitAutomaticChatInput(tx, targetConv,
              {
                type: "input",
                content: relayText,
                whenBusy: "followUp",
                requestId: `kulo:relay:${ticketId}:${task.input.runEpoch}`,
                entry: {
                  kind: WorkerRelayEntry.kind,
                  data: {
                    ticketId,
                    title,
                    role,
                    state: report.state,
                    summary: report.summary,
                    deliverable: report.deliverable ?? null,
                    ...(report.attachments?.length ? { pendingAssets: report.attachments.map((asset) => asset.id) } : {}),
                    question: report.question ?? null,
                    ...(sources.length ? { sources } : {}),
                    ...(searchSuggestions.length ? { searchSuggestions } : {}),
                  },
                },
              });
              return undefined;
            }, context);
            if (notifyInlineWaiter) {
              deps.onInlineCandidateSettled?.(ticketId);
            }
          }
        }

        let repeated = false;
        let continueExternal = false;
        await runtime.commit(async tx => {
          const state = await tx.doc(KuloStateDoc);
          const settingsDoc = await tx.doc(SettingsAssistantDoc);
          const ticket = state.tickets[task.input.ticketId];
          const origin = ticket && state.topics?.[ticket.originTopicId ?? "root"];
          const settingsConv = parseSettingsTopicConversationId(ticket?.originTopicId);
          const originAlive = settingsConv !== null
            ? isActiveSettingsConversation(settingsConv, settingsDoc)
            : Boolean(origin && origin.deletedAt === undefined);
          if (ticket?.runEpoch === task.input.runEpoch && ticket.status === "ready" && ticket.externalExecution &&
              ticket.wakePending && ticket.resumePrompt && !ticket.cleanupPending) {
            transitionTicketStatus(ticket, "waiting", runtime.now());
            ticket.waiting = { reason: "time", since: runtime.now(), until: runtime.now(), detail: "继续已收到的补充要求" };
            continueExternal = true;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          if (ticket?.runEpoch === task.input.runEpoch && ticket.status === "ready" &&
              ticket.schedule?.repeatEverySeconds && ticket.schedule.deletedAt === undefined && originAlive) {
            const interval = ticket.schedule.repeatEverySeconds * 1000;
            const now = runtime.now();
            const nextRunAt = ticket.schedule.executeAt + (Math.floor((now - ticket.schedule.executeAt) / interval) + 1) * interval;
            ticket.schedule.nextRunAt = nextRunAt;
            if (hasPendingWorkspaceApply(ticket)) {
              // Defer next scheduled execution until current staged changes are applied or discarded.
              ticket.updatedAt = now;
              repeated = true;
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }
            ticket.waiting = { reason: "time", since: now, until: nextRunAt, detail: "等待下次定时执行" };
            transitionTicketStatus(ticket, "waiting", now);
            ticket.activeTaskId = Number(task.id);
            ticket.updatedAt = now;
            repeated = true;
            return { status: "sleeping", until: nextRunAt, checkpoint: { phase: "wait_until" } };
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        if (repeated) deps.onTicketsChanged?.();
        if (continueExternal) await deps.resumeWaitingTicket?.(task.input.ticketId, context);
      },

      wait_until: async (task, runtime, context) => {
        const state = await runtime.snapshot(KuloStateDoc, context);
        const ticket = state?.tickets[task.input.ticketId];
        if (!ticket || ticket.runEpoch !== task.input.runEpoch ||
            ticket.status !== "waiting" || ticket.waiting?.reason !== "time") {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        }
        const until = ticket.waiting.until;
        if (until === undefined || !Number.isFinite(until) || until < 0) throw new Error("Timed Worker wait requires a valid deadline");
        if (until > runtime.now()) {
          await runtime.sleepUntil(until, { phase: "wait_until" }, context);
          return;
        }
        if (hasPendingWorkspaceApply(ticket)) {
          await runtime.sleepUntil(runtime.now() + 5_000, { phase: "wait_until" }, context);
          return;
        }
        if (!deps.resumeWaitingTicket) throw new Error("Timed Worker waits require a host resumeWaitingTicket handler");
        await deps.resumeWaitingTicket(ticket.id, context);
        await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },

    abort: async (task, runtime, context) => {
      let settledCurrentRun = false;
      await runtime.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const ticket = state.tickets[task.input.ticketId];
        if (ticket?.runEpoch === task.input.runEpoch) {
          releaseSlot(state, task.input.ticketId);
          settledCurrentRun = true;
          if (ticket.activeTaskId === (task.id as number)) ticket.activeTaskId = undefined;
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
      if (settledCurrentRun) {
        deps.onTicketSettled?.(task.input.ticketId);
        deps.onTicketsChanged?.();
      }
    },
  });
}
