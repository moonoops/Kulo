import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type ConversationId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import type {
  ChatDisplayItem,
  ExternalAgentRun,
  ExternalAgentRuntimeEvent,
  LiveStreamState,
  SubagentCardView,
  TicketRecord,
  WorkerInspectResult,
} from "@kulo/protocol";
import { BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS } from "./builtin-memory-entries.js";
import type { KuloConnections } from "./connections.js";
import { redactCredentialData } from "./credential-redaction.js";
import {
  extractLiveState,
  summarizeEntryForInspect,
  type DisplayMessageOptions,
} from "./hub-display-projection.js";
import type { LiveSettingsStore } from "./hub-kernel-ports.js";
import type { HubWatchdog } from "./hub-watchdog.js";
import type { KuloProjects } from "./projects.js";
import { boundInspectResult, inferBuiltInWorkerPhaseAndFiles } from "./report-overflow.js";
import { isSettingsTopicDeleted, SettingsAssistantDoc } from "./settings-assistant.js";
import { resolveEffectiveIdentityDir } from "./settings.js";
import { getActiveStagedCwd, getEffectiveWorkspaceDir, KuloStateDoc } from "./state.js";
import { buildTicketSubagentViews } from "./subagent-runner.js";
import {
  listTaskDeliverables,
  readTaskDeliverable,
  reportFileReferences,
  taskDeliverableError,
  TaskDeliverableError,
  type TaskDeliverableOptions,
} from "./task-deliverables.js";
import type { KuloUploadStore } from "./uploads.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export interface TicketInspectionServiceDeps {
  harness: Harness;
  envManager: EnvManager;
  projects: KuloProjects;
  uploads: KuloUploadStore;
  connectionManager: KuloConnections;
  liveSettings: LiveSettingsStore;
  watchdog: Pick<HubWatchdog, "getLastActivityAt">;
  stateDir: string;
  defaultIdentityDir: string;
  hydrateMessages: (
    entries: readonly EntryRecord[],
    conversationId: number,
    options?: DisplayMessageOptions,
  ) => Promise<ChatDisplayItem[]>;
}

export class TicketInspectionService {
  readonly #deps: TicketInspectionServiceDeps;

  constructor(deps: TicketInspectionServiceDeps) {
    this.#deps = deps;
  }

  async #taskDeliverableOptions(ticketId: string, context: Context): Promise<TaskDeliverableOptions> {
    const { harness, envManager, projects, liveSettings, stateDir, defaultIdentityDir } = this.#deps;
    const snapshot = await harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new TaskDeliverableError(404, "ticket_not_found", "任务不存在。");
    if (ticket.executionDomain === "android") {
      throw new TaskDeliverableError(409, "task_deliverable_unavailable", "手机任务没有可读取的工作区文件。");
    }
    if (!envManager.getEnvDescriptor(ticket.envId)?.online) {
      throw new TaskDeliverableError(503, "task_deliverable_device_offline", "任务设备离线，连接后可查看交付文件。");
    }
    // Preserves per-chunk live authorization check during deliverable downloads.
    const assertAuthorized = async () => {
      if (context.abortSignal?.aborted) throw new TaskDeliverableError(499, "task_deliverable_aborted", "文件读取已取消。");
      const state = await harness.snapshot(KuloStateDoc, context);
      const current = state?.tickets[ticketId];
      if (
        !current ||
        current.workspaceDir !== ticket.workspaceDir ||
        current.scratchDir !== ticket.scratchDir ||
        current.envId !== ticket.envId ||
        current.projectId !== ticket.projectId ||
        current.grantRevision !== ticket.grantRevision
      ) {
        throw new TaskDeliverableError(403, "task_deliverable_scope_changed", "任务文件授权已变化。");
      }
      const settings = await harness.snapshot(SettingsAssistantDoc, context);
      if (isSettingsTopicDeleted(current.originTopicId, settings) || state?.topics?.[current.originTopicId ?? "root"]?.deletedAt !== undefined) {
        throw new TaskDeliverableError(403, "task_deliverable_scope_changed", "任务所属会话已删除。");
      }
      if (current.projectId) {
        const project = await projects.get(current.projectId, context);
        if (
          project.grantRevision !== current.grantRevision ||
          project.workspaceDir !== current.workspaceDir ||
          project.deviceId !== current.envId ||
          project.directoryId !== current.directoryId
        ) {
          throw new TaskDeliverableError(403, "task_deliverable_scope_changed", "项目目录授权已变化，请重新关联。");
        }
      }
    };
    await assertAuthorized();
    if (ticket.projectId) await projects.ensureAuthorized(ticket.projectId, context);
    await assertAuthorized();
    const activeStagedCwd = getActiveStagedCwd(ticket);
    const effectiveWorkspaceDir = activeStagedCwd ?? ticket.workspaceDir;
    const env = envManager.createWorkerExecutionEnv(ticket.envId, effectiveWorkspaceDir, {
      scratchDir: ticket.scratchDir,
      projectId: ticket.projectId,
      grantRevision: ticket.grantRevision,
      readOnly: true,
      ...(activeStagedCwd && !ticket.externalExecution ? { stagedTaskId: ticket.id } : {}),
    });
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
    const roots = [effectiveWorkspaceDir, ticket.workspaceDir, ticket.scratchDir].filter((value): value is string => Boolean(value));
    const statePath = normalize(stateDir);
    const protectedPaths = [
      ...(!roots.some((root) => normalize(root).startsWith(`${statePath}/`)) ? [stateDir] : []),
      resolveEffectiveIdentityDir(liveSettings.get(), defaultIdentityDir),
    ];
    return { env, ticket: { ...ticket, workspaceDir: effectiveWorkspaceDir }, protectedPaths, assertAuthorized, context };
  }

  async listTicketDeliverables(ticketId: string, context: Context = BACKGROUND_CONTEXT) {
    const { harness, uploads } = this.#deps;
    const snapshot = await harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new TaskDeliverableError(404, "ticket_not_found", "任务不存在。");
    if (ticket.latestReport?.attachments?.length) {
      const files = [];
      const missing = [];
      const overflowId = ticket.latestReport.overflowAsset?.id;
      for (const attachment of ticket.latestReport.attachments) {
        if (overflowId && attachment.id === overflowId) continue;
        const loaded = uploads.getUpload(attachment.id);
        if (!loaded) { missing.push(attachment.name); continue; }
        if (loaded.record.internalOnly) continue;
        const published = uploads.toChatAttachment(loaded.record);
        files.push({
          id: published.id,
          name: published.name,
          size: published.size,
          mimeType: published.mimeType,
          url: published.url,
          previewable: published.mimeType === "text/html" && /\.html?$/i.test(published.name),
        });
      }
      return { files, ...(missing.length ? { missing } : {}) };
    }
    if (!reportFileReferences(ticket.latestReport).length) return { files: [] };
    try { return await listTaskDeliverables(await this.#taskDeliverableOptions(ticketId, context)); }
    catch (error) { return taskDeliverableError(error); }
  }

  async readTicketDeliverable(ticketId: string, fileId: string, context: Context = BACKGROUND_CONTEXT) {
    try { return await readTaskDeliverable(await this.#taskDeliverableOptions(ticketId, context), fileId); }
    catch (error) { return taskDeliverableError(error); }
  }

  async inspectTicketDetail(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{
    ticket: TicketRecord;
    transcript: ChatDisplayItem[];
    live: LiveStreamState;
    subagents?: SubagentCardView[];
  }> {
    const { harness, connectionManager, hydrateMessages } = this.#deps;
    const state = await harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new Error(`Ticket '${ticketId}' not found`);
    const subagents = buildTicketSubagentViews(state, ticketId, (value) => connectionManager.redact(value));
    const subagentsField = subagents.length > 0 ? { subagents } : {};
    if (ticket.externalExecution) {
      const { run, error } = await this.#externalAgentRunView(ticket);
      const text = connectionManager.redact(run?.text || ticket.latestReport?.deliverable || ticket.latestReport?.summary || "");
      const transcript: ChatDisplayItem[] = [{
        id: -1,
        role: "user",
        text: [ticket.goal, ticket.scope, ticket.acceptance].filter(Boolean).join("\n\n"),
        createdAt: ticket.createdAt,
      }];
      const eventMap = new Map<number, ExternalAgentRuntimeEvent>();
      for (const ev of ticket.externalExecution.recentEvents ?? []) eventMap.set(ev.sequence, ev);
      for (const ev of run?.events ?? []) {
        if (ev.type !== "message") eventMap.set(ev.sequence, ev);
      }
      const timeline = [...eventMap.values()].sort((a, b) => a.sequence - b.sequence).slice(-30);
      let nextSyntheticId = -10;
      for (const ev of timeline) {
        const prefix = ev.type === "tool" ? "[工具] " : ev.type === "error" ? "[错误] " : ev.type === "permission" ? "[授权] " : "";
        transcript.push({
          id: nextSyntheticId--,
          role: "system_note",
          text: `${prefix}${connectionManager.redact(ev.text).slice(0, 500)}`,
          createdAt: ev.at,
        });
      }
      if (text) transcript.push({ id: -2, role: "assistant", text, createdAt: ticket.latestReport?.at ?? ticket.updatedAt });
      const activePermissions = run?.permissions ?? ticket.externalExecution.pendingPermissions ?? [];
      for (const permission of activePermissions) {
        transcript.push({ id: nextSyntheticId--, role: "system_note", text: `[待授权] ${connectionManager.redact(permission.title)}` });
      }
      const isBusy = ticket.status === "running" && (!run || ["starting", "running", "waiting"].includes(run.state));
      const latestToolEvent = isBusy ? [...timeline].reverse().find((ev) => ev.type === "tool") : undefined;
      const activeTools: LiveStreamState["activeTools"] = [
        ...activePermissions.map((permission) => ({ callId: permission.id, name: connectionManager.redact(permission.title).slice(0, 120), outputTail: "等待授权" })),
        ...(latestToolEvent && activePermissions.length === 0
          ? [{ callId: `ext-tool-${latestToolEvent.sequence}`, name: connectionManager.redact(latestToolEvent.text).slice(0, 120) }]
          : []),
      ];
      return {
        ticket: cloneJson(ticket),
        transcript,
        ...subagentsField,
        live: {
          busy: isBusy,
          ...(isBusy && text ? { streamingText: text } : {}),
          activeTools,
          queuedCount: ticket.resumePrompt ? 1 : 0,
          ...(error ? { runFailure: { reason: "external_status_unavailable", detail: error } } : {}),
        },
      };
    }
    const workerConv = await harness.conversation(ticket.workerConversationId as ConversationId, context);
    if (!workerConv) {
      return {
        ticket: { ...ticket },
        transcript: [],
        ...subagentsField,
        live: { busy: false, activeTools: [], queuedCount: 0 },
      };
    }
    const watch = await workerConv.watch(context, { min: 80, max: 160 });
    const view = watch.value;
    await watch.stop();
    return {
      ticket: { ...ticket },
      transcript: await hydrateMessages(view.entries, Number(workerConv.id), {
        includeToolResults: true,
        redactToolText: (text) => connectionManager.redact(text),
      }),
      ...subagentsField,
      live: extractLiveState(view),
    };
  }

  /** Lightweight worker diagnostic snapshot used by `kulo_inspect` (no `watch()`). */
  async #externalAgentRunView(
    ticket: Readonly<TicketRecord>,
    options?: { compact?: boolean },
  ): Promise<{ run?: ExternalAgentRun; error?: string }> {
    const { envManager, connectionManager } = this.#deps;
    const execution = ticket.externalExecution;
    if (!execution?.runId) return {};
    if (!envManager.getEnvDescriptor(ticket.envId)?.online) return { error: "等待执行设备上线后核对原会话。" };
    try {
      const response = await envManager.requestExternalAgent(ticket.envId, {
        operation: "inspect",
        runId: execution.runId,
        ...(options?.compact ? { compact: true } : {}),
      });
      if (response.type !== "run" || response.run.taskId !== ticket.id || response.run.id !== execution.runId || response.run.kind !== execution.binding.kind) {
        throw new Error("客户端返回了不匹配的执行回执。");
      }
      return { run: redactCredentialData(response.run, (value) => connectionManager.redact(value)) };
    } catch (error) {
      return { error: connectionManager.redact(error instanceof Error ? error.message : "客户端状态暂时无法读取。") };
    }
  }

  async inspectWorker(
    ticketId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<WorkerInspectResult> {
    const { harness, watchdog } = this.#deps;
    const state = await harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new Error(`Ticket '${ticketId}' not found`);
    if (ticket.externalExecution) {
      const { run, error } = await this.#externalAgentRunView(ticket, { compact: true });
      const lastActivity = Math.max(
        run?.events.at(-1)?.at ?? 0,
        ticket.externalExecution.lastActivityAt ?? 0,
        ticket.latestReport?.at ?? 0,
        ticket.startedRunningAt ?? 0,
        ticket.updatedAt,
      );
      const phase = run?.phase ?? ticket.externalExecution.phase;
      const touchedFiles = run?.touchedFiles ?? ticket.externalExecution.touchedFiles;
      const uncertainReason = run?.uncertainReason ?? ticket.externalExecution.uncertainReason;
      const externalInspect: WorkerInspectResult = {
        ticketId: ticket.id,
        title: ticket.title,
        role: ticket.role,
        status: ticket.status,
        runEpoch: ticket.runEpoch,
        ...(phase ? { phase } : {}),
        ...(touchedFiles?.length ? { touchedFiles: [...touchedFiles] } : {}),
        ...(ticket.startedRunningAt === undefined ? {} : { startedRunningAt: ticket.startedRunningAt, runningDurationSec: Math.max(0, Math.round((Date.now() - ticket.startedRunningAt) / 1000)) }),
        idleSec: Math.max(0, Math.round((Date.now() - lastActivity) / 1000)),
        busy: ticket.status === "running" && (!run || ["starting", "running", "waiting"].includes(run.state)),
        ...(run?.text ? { streamingPreview: run.text.slice(-1200) } : {}),
        activeTools: (run?.permissions ?? ticket.externalExecution.pendingPermissions ?? []).map((permission) => ({ callId: permission.id, name: permission.title, status: "waiting" })),
        ...(error || run?.error ? { runFailure: { reason: "external_agent", detail: error ?? run!.error } } : {}),
        ...(ticket.latestReport ? { latestReport: cloneJson(ticket.latestReport) } : {}),
        external: {
          kind: ticket.externalExecution.binding.kind,
          runId: ticket.externalExecution.runId,
          sessionId: run?.sessionId ?? ticket.externalExecution.sessionId,
          ...(ticket.externalExecution.workspaceMode ? { workspaceMode: ticket.externalExecution.workspaceMode } : {}),
          ...((run?.stagedCwd ?? ticket.externalExecution.stagedCwd) ? { stagedCwd: run?.stagedCwd ?? ticket.externalExecution.stagedCwd } : {}),
          ...(uncertainReason ? { uncertainReason } : {}),
          permissions: run?.permissions ?? ticket.externalExecution.pendingPermissions ?? [],
        },
        recentEntries: (run?.events ?? []).slice(-15).map((event) => ({
          id: event.sequence,
          kind: event.type === "message" ? "assistant" : event.type === "tool" ? "tool_result" : "other",
          summary: (event.type === "message" ? event.text : `[${event.type}] ${event.text}`).slice(-1200),
          createdAt: event.at,
        })),
      };
      return boundInspectResult(externalInspect);
    }

    const workerConvId = ticket.workerConversationId as ConversationId;
    const [live, workerConv] = await Promise.all([
      harness.snapshot(LiveDoc, workerConvId, context),
      harness.conversation(workerConvId, context),
    ]);
    const entriesPage = workerConv ? await workerConv.entries({}, 10, undefined, context) : undefined;
    const recentEntries = entriesPage ? [...entriesPage.items].reverse().map(summarizeEntryForInspect) : [];

    let streamingPreview: string | undefined;
    let thinkingPreview: string | undefined;
    const partialContent = live?.generation?.message?.content;
    if (Array.isArray(partialContent)) {
      const texts: string[] = [];
      const thoughts: string[] = [];
      for (const block of partialContent) {
        if (!block || typeof block !== "object") continue;
        if ("type" in block && block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if ("type" in block && block.type === "thinking" && typeof block.thinking === "string") thoughts.push(block.thinking);
      }
      const joinedText = texts.join("").trim();
      const joinedThinking = thoughts.join("").trim();
      if (joinedText) streamingPreview = joinedText.length > 300 ? `...${joinedText.slice(-300)}` : joinedText;
      if (joinedThinking) thinkingPreview = joinedThinking.length > 200 ? `...${joinedThinking.slice(-200)}` : joinedThinking;
    }

    const now = Date.now();
    const trackedLastActivityAt = watchdog.getLastActivityAt(ticketId);
    const runningDurationSec = ticket.status === "running" && ticket.startedRunningAt
      ? Math.max(0, Math.round((now - ticket.startedRunningAt) / 1000))
      : undefined;
    const lastActivityAt = Math.max(trackedLastActivityAt ?? 0, ticket.startedRunningAt ?? 0, ticket.latestReport?.at ?? 0);
    const idleSec = ticket.status === "running" && lastActivityAt > 0
      ? Math.max(0, Math.round((now - lastActivityAt) / 1000))
      : undefined;

    const activeTools = (live?.tools ?? [])
      .filter((t) => t.status !== "done")
      .map((t) => ({ callId: t.callId, name: t.name, status: t.status, ...(t.output && !BUILTIN_MEMORY_DISPLAY_REDACTED_TOOLS.has(t.name) ? { outputTail: t.output.slice(-300) } : {}) }));

    const builtInProjection = inferBuiltInWorkerPhaseAndFiles({
      activeTools,
      recentEntries,
      streamingPreview,
      workspaceDir: getEffectiveWorkspaceDir(ticket),
    });

    return boundInspectResult({
      ticketId: ticket.id,
      title: ticket.title,
      role: ticket.role,
      status: ticket.status,
      runEpoch: ticket.runEpoch,
      phase: builtInProjection.phase,
      ...(builtInProjection.touchedFiles?.length ? { touchedFiles: builtInProjection.touchedFiles } : {}),
      ...(ticket.startedRunningAt !== undefined ? { startedRunningAt: ticket.startedRunningAt } : {}),
      ...(runningDurationSec !== undefined ? { runningDurationSec } : {}),
      ...(idleSec !== undefined ? { idleSec } : {}),
      busy: Boolean(live?.run),
      ...(live?.run?.turns !== undefined ? { turns: live.run.turns } : {}),
      ...(streamingPreview ? { streamingPreview } : {}),
      ...(thinkingPreview ? { thinkingPreview } : {}),
      activeTools,
      ...(live?.runFailure
        ? {
            runFailure: {
              reason: live.runFailure.reason,
              ...(live.runFailure.detail !== undefined ? { detail: String(live.runFailure.detail) } : {}),
            },
          }
        : {}),
      ...(ticket.latestReport ? { latestReport: { ...ticket.latestReport } } : {}),
      recentEntries,
    });
  }
}
