import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import type {
  StagedWorkspaceApplyResult,
  StagedWorkspaceDiffDetail,
  StagedWorkspaceDiffSummary,
  TicketRecord,
} from "@kulo/protocol";
import {
  buildStagedApplyConfirmCard,
  stagedApplyFingerprint,
  type KuloActionConfirmations,
} from "./action-confirmations.js";
import type { KuloConnections } from "./connections.js";
import { redactCredentialData } from "./credential-redaction.js";
import { legacyDeliveryConflict } from "./delivery-receipts.js";
import type { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import { ProjectError, type KuloProjects } from "./projects.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import {
  SettingsAssistantDoc,
  isActiveSettingsConversation,
  parseSettingsTopicConversationId,
} from "./settings-assistant.js";
import {
  KuloStateDoc,
  hasPendingWorkspaceApply,
  isTicketUnfinished,
  recordProcessedCommand,
  releaseProjectWrite,
  transitionTicketStatus,
} from "./state.js";
import type { ApplyStagedChangesParams } from "./tools-router.js";
import { recordTicketOutcomeToWorkingMemory } from "./working-memory.js";

export interface TicketStagedApplyDeps {
  harness: Harness;
  envManager: Pick<
    EnvManager,
    | "getEnvDescriptor"
    | "prepareStagedWorkspace"
    | "inspectStagedWorkspaceDiff"
    | "discardStagedWorkspace"
    | "applyStagedWorkspaceChanges"
    | "requestExternalAgent"
  >;
  projects: Pick<KuloProjects, "ensureAuthorized">;
  actionConfirmations: KuloActionConfirmations;
  connectionManager: Pick<KuloConnections, "redact">;
  delivery: Pick<HubDeliveryCoordinator, "queueTicket">;
  runtimeGates: Pick<HubRuntimeGates, "resumeIfNotRecovering" | "broadcastTickets">;
  workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
}

function filterStagedDiffSummary(
  prev: StagedWorkspaceDiffSummary,
  appliedSet: ReadonlySet<string>,
): StagedWorkspaceDiffSummary {
  const added = prev.added.filter((p) => !appliedSet.has(p));
  const modified = prev.modified.filter((p) => !appliedSet.has(p));
  const deleted = prev.deleted.filter((p) => !appliedSet.has(p));
  const emptyDirsAdded = prev.emptyDirsAdded?.filter((p) => !appliedSet.has(p));
  const emptyDirsDeleted = prev.emptyDirsDeleted?.filter((p) => !appliedSet.has(p));
  const modeChanged = prev.modeChanged?.filter((p) => !appliedSet.has(p));
  const sensitivePaths = prev.sensitivePaths?.filter((p) => !appliedSet.has(p));
  const autoExecPaths = prev.autoExecPaths?.filter((p) => !appliedSet.has(p));
  const dirChanges = (emptyDirsAdded?.length ?? 0) + (emptyDirsDeleted?.length ?? 0);
  return {
    ...prev,
    hasChanges: added.length + modified.length + deleted.length + dirChanges > 0,
    added,
    modified,
    deleted,
    ...(emptyDirsAdded?.length ? { emptyDirsAdded } : { emptyDirsAdded: undefined }),
    ...(emptyDirsDeleted?.length ? { emptyDirsDeleted } : { emptyDirsDeleted: undefined }),
    ...(modeChanged?.length ? { modeChanged } : { modeChanged: undefined }),
    ...(sensitivePaths?.length ? { sensitivePaths } : { sensitivePaths: undefined }),
    ...(autoExecPaths?.length ? { autoExecPaths } : { autoExecPaths: undefined }),
    conflictFiles: prev.conflictFiles.filter((p) => !appliedSet.has(p)),
  };
}

export class TicketStagedApplyService {
  readonly #deps: TicketStagedApplyDeps;

  constructor(deps: TicketStagedApplyDeps) {
    this.#deps = deps;
  }

  async prepareBuiltInStagedWorkspace(
    ticket: Readonly<TicketRecord>,
    context: Context,
  ): Promise<{ stagedCwd: string; reused: boolean; warnings?: string[] }> {
    if (!ticket.projectId) throw new Error("Staged workspace requires a bound project");
    const project = await this.#deps.projects.ensureAuthorized(ticket.projectId, context);
    if (
      project.grantRevision !== ticket.grantRevision ||
      project.directoryId !== ticket.directoryId ||
      project.deviceId !== ticket.envId ||
      project.workspaceDir !== ticket.workspaceDir
    ) {
      throw new ProjectError(409, "project_binding_changed", "项目目录或授权版本已变化，请创建新任务。");
    }
    const fresh = Boolean(ticket.workspaceStaging?.appliedAt || ticket.workspaceStaging?.discardedAt);
    return this.#deps.envManager.prepareStagedWorkspace(ticket.envId, {
      taskId: ticket.id,
      projectId: project.id,
      sourceDir: project.workspaceDir,
      directoryId: project.directoryId,
      grantRevision: project.grantRevision,
      ...(fresh ? { fresh: true } : {}),
    });
  }

  async inspectBuiltInStagedDiffSummary(
    ticket: Readonly<TicketRecord>,
  ): Promise<StagedWorkspaceDiffSummary | undefined> {
    if (ticket.externalExecution || ticket.workspaceStaging?.mode !== "staged") return undefined;
    if (ticket.workspaceStaging.appliedAt || ticket.workspaceStaging.discardedAt || !ticket.workspaceStaging.stagedCwd) {
      return undefined;
    }
    if (!this.#deps.envManager.getEnvDescriptor(ticket.envId)?.online) return undefined;
    const detail = await this.#deps.envManager.inspectStagedWorkspaceDiff(ticket.envId, ticket.id);
    const redacted = redactCredentialData(detail, (value) => this.#deps.connectionManager.redact(value));
    return {
      hasChanges: redacted.hasChanges,
      added: redacted.added,
      modified: redacted.modified,
      deleted: redacted.deleted,
      ...(redacted.emptyDirsAdded?.length ? { emptyDirsAdded: redacted.emptyDirsAdded } : {}),
      ...(redacted.emptyDirsDeleted?.length ? { emptyDirsDeleted: redacted.emptyDirsDeleted } : {}),
      ...(redacted.modeChanged?.length ? { modeChanged: redacted.modeChanged } : {}),
      ...(redacted.sensitivePaths?.length ? { sensitivePaths: redacted.sensitivePaths } : {}),
      ...(redacted.autoExecPaths?.length ? { autoExecPaths: redacted.autoExecPaths } : {}),
      conflictFiles: redacted.conflictFiles,
      unifiedPreview: redacted.unifiedPreview.slice(0, 24 * 1024),
      truncated: redacted.truncated,
    };
  }

  async discardTicketStagedWorkspace(ticket: Readonly<TicketRecord>): Promise<boolean> {
    if (ticket.externalExecution) {
      const runId = ticket.externalExecution.runId;
      if (!runId || !ticket.externalExecution.stagedCwd || ticket.externalExecution.stagedAppliedAt) return false;
      if (!this.#deps.envManager.getEnvDescriptor(ticket.envId)?.online) return true;
      try {
        await this.#deps.envManager.requestExternalAgent(ticket.envId, { operation: "close", runId, discardStaged: true });
        return false;
      } catch {
        return true;
      }
    }
    if (ticket.workspaceStaging?.mode !== "staged" || ticket.workspaceStaging.appliedAt || ticket.workspaceStaging.discardedAt) {
      return false;
    }
    if (!ticket.workspaceStaging.stagedCwd) return false;
    if (!this.#deps.envManager.getEnvDescriptor(ticket.envId)?.online) return true;
    try {
      await this.#deps.envManager.discardStagedWorkspace(ticket.envId, ticket.id, ticket.projectId);
      return false;
    } catch {
      return true;
    }
  }

  async applyStagedChangesFromTool(
    params: ApplyStagedChangesParams,
    source: { conversationId: number; callId: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<StagedWorkspaceApplyResult | Record<string, unknown>> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[params.ticketId];
    if (!ticket) return this.applyStagedChanges(params, context);
    const isExternalStaged = ticket.externalExecution?.workspaceMode === "staged";
    const isBuiltInStaged = !ticket.externalExecution && ticket.workspaceStaging?.mode === "staged";
    if (!isExternalStaged && !isBuiltInStaged) return this.applyStagedChanges(params, context);
    if (isExternalStaged ? ticket.externalExecution!.stagedAppliedAt : ticket.workspaceStaging!.appliedAt) {
      return this.applyStagedChanges(params, context);
    }

    if (params.askUser !== true) {
      const applied = await this.applyStagedChanges(params, context);
      const pendingList = await this.#deps.actionConfirmations.listPendingForConversation(source.conversationId, context);
      for (const item of pendingList) {
        if (item.payload.kind === "staged_apply" && item.payload.ticketId === ticket.id) {
          await this.#deps.actionConfirmations.resolveProgrammatically(
            item.id,
            { status: "approved", selectedChoiceId: "confirm", resultSummary: "已通过对话合并", markExecuted: true },
            context,
          );
        }
      }
      const activeReviewers = Object.values(state?.tickets ?? {})
        .filter((other) => other.reviewTicketId === ticket.id && isTicketUnfinished(other))
        .map((other) => other.id);
      return activeReviewers.length > 0
        ? { ...applied, activeReviewers, note: `合并已完成；请注意独立评审任务 ${activeReviewers.join(", ")} 仍在基于合并前快照继续复核。` }
        : applied;
    }

    let stagedDiff = isExternalStaged ? ticket.externalExecution!.stagedDiff : ticket.workspaceStaging!.stagedDiff;
    if (!stagedDiff && !isTicketUnfinished(ticket) && ticket.status !== "stopped" && ticket.status !== "closed") {
      try {
        stagedDiff = await this.inspectStagedDiff(ticket.id, undefined, context);
      } catch {
        // Fall through to applyStagedChanges which reports the authoritative error.
      }
    }
    const selectedPaths = params.paths?.length ? new Set(params.paths) : undefined;
    const sensitivePaths = (stagedDiff?.sensitivePaths ?? []).filter((entry) => !selectedPaths || selectedPaths.has(entry));
    const conflictFiles = (stagedDiff?.conflictFiles ?? []).filter((entry) => !selectedPaths || selectedPaths.has(entry));
    const fingerprint = stagedApplyFingerprint({
      ticketId: ticket.id,
      runEpoch: ticket.runEpoch,
      paths: params.paths,
      allowConflicts: Boolean(params.allowConflicts),
      sensitivePaths,
      conflictFiles,
    });
    const existing = await this.#deps.actionConfirmations.lookup(source.conversationId, "staged_apply", fingerprint, context);
    if (existing?.status === "approved") {
      const applied = await this.applyStagedChanges(params, context);
      await this.#deps.actionConfirmations.markExecuted(existing.id, context);
      return applied;
    }
    const topicId = state?.conversationToTopic?.[String(source.conversationId)];
    const built = buildStagedApplyConfirmCard({
      ticketId: ticket.id,
      sensitivePaths,
      conflictFiles,
      allowConflicts: Boolean(params.allowConflicts),
    });
    const { confirmation } = await this.#deps.actionConfirmations.ensurePendingCard({
      conversationId: source.conversationId,
      ...(topicId ? { topicId } : {}),
      ticketId: ticket.id,
      callId: source.callId,
      kind: "staged_apply",
      fingerprint,
      cardInput: built.input,
      logicalIds: built.logicalIds,
      payload: {
        kind: "staged_apply",
        ticketId: ticket.id,
        runEpoch: ticket.runEpoch,
        commandId: params.commandId,
        ...(params.paths?.length ? { paths: [...params.paths] } : {}),
        allowConflicts: Boolean(params.allowConflicts),
        sensitivePaths,
        conflictFiles,
      },
    }, context);
    return {
      status: "awaiting_user_confirmation",
      cardId: confirmation.cardId,
      requestId: confirmation.id,
      ticketId: ticket.id,
      sensitivePaths,
      conflictFiles,
      message: "已向用户展示合并确认卡片（含允许/拒绝/手动输入），对话不阻塞；若用户直接在聊天中同意，你可以直接调用 kulo_apply_staged_changes 完成合并并自动收口卡片。",
    };
  }

  async inspectStagedDiff(
    ticketId: string,
    filePath?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<StagedWorkspaceDiffDetail> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new ProjectError(404, "ticket_not_found", `任务 '${ticketId}' 不存在。`);
    const isExternalStaged = ticket.externalExecution?.workspaceMode === "staged";
    const isBuiltInStaged = !ticket.externalExecution && ticket.workspaceStaging?.mode === "staged";
    if (!isExternalStaged && !isBuiltInStaged) {
      throw new ProjectError(400, "staged_workspace_unavailable", "该任务未使用隔离副本（staged）工作区模式。");
    }
    if (isExternalStaged ? ticket.externalExecution!.stagedAppliedAt : ticket.workspaceStaging!.appliedAt) {
      throw new ProjectError(409, "staged_already_applied", "该任务的隔离副本变更已经合并回项目目录。");
    }
    if (isBuiltInStaged && ticket.workspaceStaging!.discardedAt) {
      throw new ProjectError(409, "staged_already_discarded", "该任务的隔离副本已被清理或丢弃。");
    }
    if (!this.#deps.envManager.getEnvDescriptor(ticket.envId)?.online) {
      throw new ProjectError(503, "device_offline", "执行设备离线，暂时无法读取隔离副本差异。");
    }
    if (isExternalStaged) {
      const response = await this.#deps.envManager.requestExternalAgent(ticket.envId, {
        operation: "diff",
        taskId: ticket.id,
        ...(filePath?.trim() ? { filePath: filePath.trim() } : {}),
      });
      if (response.type !== "diff") throw new Error("客户端未返回有效的差异结果。");
      return redactCredentialData(response.diff, (value) => this.#deps.connectionManager.redact(value));
    }
    const diff = await this.#deps.envManager.inspectStagedWorkspaceDiff(ticket.envId, ticket.id, filePath);
    return redactCredentialData(diff, (value) => this.#deps.connectionManager.redact(value));
  }

  async applyStagedChanges(
    params: ApplyStagedChangesParams,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<StagedWorkspaceApplyResult> {
    const cleanCmdId = params.commandId?.trim();
    if (!cleanCmdId) throw new ProjectError(400, "invalid_command_id", "合并操作需要有效的 command_id。");
    return this.#deps.delivery.queueTicket(params.ticketId, async () => {
      const snapshot = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const ticket = snapshot?.tickets[params.ticketId];
      if (!ticket) throw new ProjectError(404, "ticket_not_found", `任务 '${params.ticketId}' 不存在。`);
      if (params.originConversationId !== undefined && (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== params.originConversationId) {
        throw new ProjectError(403, "ticket_scope_denied", "不能跨会话合并其他对话的任务变更。");
      }
      const isExternalStaged = ticket.externalExecution?.workspaceMode === "staged";
      const isBuiltInStaged = !ticket.externalExecution && ticket.workspaceStaging?.mode === "staged";
      if (!isExternalStaged && !isBuiltInStaged) {
        throw new ProjectError(400, "staged_workspace_unavailable", "该任务未使用隔离副本（staged）工作区模式。");
      }
      const alreadyApplied = Boolean(
        isExternalStaged ? ticket.externalExecution!.stagedAppliedAt : ticket.workspaceStaging!.appliedAt,
      );
      const priorCmd = snapshot?.processedCommands?.[cleanCmdId];
      if (priorCmd) {
        if (priorCmd.ticketId !== ticket.id || priorCmd.action !== "apply_staged") legacyDeliveryConflict();
        if (alreadyApplied) return { appliedAdded: [], appliedModified: [], appliedDeleted: [], cleanedUp: true };
      }
      if (alreadyApplied) {
        return { appliedAdded: [], appliedModified: [], appliedDeleted: [], cleanedUp: true };
      }
      if (isBuiltInStaged && ticket.workspaceStaging!.discardedAt) {
        throw new ProjectError(409, "staged_already_discarded", "该任务的隔离副本已被清理或丢弃。");
      }
      if (isTicketUnfinished(ticket)) {
        throw new ProjectError(409, "ticket_still_running", "请等待任务结束当前轮执行后再合并变更。");
      }
      if (ticket.status === "stopped" || ticket.status === "closed") {
        throw new ProjectError(409, "ticket_stopped", "已停止或关闭的任务不能再合并隔离副本。");
      }
      if (!ticket.projectId) {
        throw new ProjectError(400, "project_required", "隔离副本合并需要绑定的项目。");
      }
      if (!this.#deps.envManager.getEnvDescriptor(ticket.envId)?.online) {
        throw new ProjectError(503, "device_offline", "执行设备离线，请待设备重连后再合并。");
      }
      const project = await this.#deps.projects.ensureAuthorized(ticket.projectId, context);
      if (
        project.grantRevision !== ticket.grantRevision ||
        project.directoryId !== ticket.directoryId ||
        project.deviceId !== ticket.envId ||
        project.workspaceDir !== ticket.workspaceDir
      ) {
        throw new ProjectError(409, "project_binding_changed", "项目目录或授权版本已变化，不能将旧副本覆盖到新目录。");
      }
      let applied: StagedWorkspaceApplyResult;
      if (isExternalStaged) {
        const response = await this.#deps.envManager.requestExternalAgent(ticket.envId, {
          operation: "apply",
          taskId: ticket.id,
          projectId: project.id,
          directoryId: project.directoryId,
          grantRevision: project.grantRevision,
          ...(params.paths?.length ? { paths: params.paths } : {}),
          ...(params.allowConflicts ? { allowConflicts: true } : {}),
        });
        if (response.type !== "apply") throw new Error("执行节点未返回有效的合并回执。");
        applied = response.applied;
      } else {
        applied = await this.#deps.envManager.applyStagedWorkspaceChanges(ticket.envId, {
          taskId: ticket.id,
          projectId: project.id,
          directoryId: project.directoryId,
          grantRevision: project.grantRevision,
          ...(params.paths?.length ? { paths: params.paths } : {}),
          ...(params.allowConflicts ? { allowConflicts: true } : {}),
        });
      }
      const appliedDigest = createHash("sha256")
        .update(JSON.stringify([ticket.id, ticket.runEpoch, applied.appliedAdded, applied.appliedModified, applied.appliedDeleted]))
        .digest("hex")
        .slice(0, 32);
      let unlockedOrScheduled = false;
      await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(KuloStateDoc);
        const current = state.tickets[ticket.id];
        if (!current) return;
        recordProcessedCommand(state, cleanCmdId, ticket.id, "apply_staged");
        const now = Date.now();
        const appliedSet = new Set([
          ...applied.appliedAdded,
          ...applied.appliedModified,
          ...applied.appliedDeleted,
        ]);
        if (current.externalExecution?.workspaceMode === "staged") {
          if (applied.cleanedUp) {
            current.externalExecution.stagedAppliedAt = now;
            delete current.externalExecution.stagedCwd;
            delete current.externalExecution.stagedDiff;
          } else if (current.externalExecution.stagedDiff) {
            current.externalExecution.stagedDiff = filterStagedDiffSummary(current.externalExecution.stagedDiff, appliedSet);
          }
        } else if (current.workspaceStaging?.mode === "staged") {
          if (applied.cleanedUp) {
            current.workspaceStaging.appliedAt = now;
            current.workspaceStaging.appliedDigest = appliedDigest;
            delete current.workspaceStaging.stagedCwd;
            delete current.workspaceStaging.stagedDiff;
          } else if (current.workspaceStaging.stagedDiff) {
            current.workspaceStaging.stagedDiff = filterStagedDiffSummary(current.workspaceStaging.stagedDiff, appliedSet);
          }
        }
        if (!hasPendingWorkspaceApply(current)) {
          releaseProjectWrite(state, current.id);
          unlockedOrScheduled = true;
          // Re-arm deferred repeating schedule once staged changes have merged cleanly.
          if (
            current.status === "ready" &&
            current.schedule?.repeatEverySeconds &&
            current.schedule.deletedAt === undefined &&
            current.activeTaskId === undefined
          ) {
            const settingsDoc = await tx.doc(SettingsAssistantDoc);
            const origin = state.topics?.[current.originTopicId ?? "root"];
            const settingsConv = parseSettingsTopicConversationId(current.originTopicId);
            const originAlive =
              settingsConv !== null
                ? isActiveSettingsConversation(settingsConv, settingsDoc)
                : Boolean(origin && origin.deletedAt === undefined);
            if (originAlive) {
              const interval = current.schedule.repeatEverySeconds * 1000;
              const nextRunAt =
                current.schedule.nextRunAt && current.schedule.nextRunAt > now
                  ? current.schedule.nextRunAt
                  : current.schedule.executeAt + (Math.floor((now - current.schedule.executeAt) / interval) + 1) * interval;
              current.schedule.nextRunAt = nextRunAt;
              current.waiting = { reason: "time", since: now, until: nextRunAt, detail: "等待下次定时执行" };
              transitionTicketStatus(current, "waiting", now);
              const taskId = await tx.createTask(
                this.#deps.workerTicketTask,
                { ticketId: current.id, runEpoch: current.runEpoch, promptOverride: null },
                {
                  ownership: { kind: "conversation" },
                  conversationId: (current.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId,
                  background: true,
                },
              );
              current.activeTaskId = Number(taskId);
            }
          }
        }
        current.updatedAt = now;
      }, context);
      if (unlockedOrScheduled) this.#deps.runtimeGates.resumeIfNotRecovering();
      await this.#deps.runtimeGates.broadcastTickets(context);
      const postState = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const appliedTicket = postState?.tickets[params.ticketId];
      if (appliedTicket) {
        const appliedCount = applied.appliedAdded.length + applied.appliedModified.length + applied.appliedDeleted.length;
        void recordTicketOutcomeToWorkingMemory(
          this.#deps.harness,
          (text) => this.#deps.connectionManager.redact(text),
          appliedTicket,
          "ticket_applied",
          { detail: `已合入 ${appliedCount} 项文件变更` },
          context,
        ).catch(() => {});
      }
      return applied;
    });
  }
}
