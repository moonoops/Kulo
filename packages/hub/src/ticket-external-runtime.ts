import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { EnvManager } from "@kulo/env";
import {
  isEffectiveExternalReadOnly,
  isSupportedExternalAgentKind,
  type ChatAttachment,
  type ExternalAgentPendingReport,
  type TicketCardView,
  type TicketRecord,
  type WorkerInspectResult,
  type WorkerReportRecord,
} from "@kulo/protocol";
import { resolveRoleOrDirectClient } from "./agent-routing.js";
import type { KuloConnections } from "./connections.js";
import { publishExecutionAsset } from "./content-assets.js";
import { EXECUTION_FILE_CHUNK_BYTES, writeExecutionFile } from "./execution-files.js";
import {
  assertExternalAgentScope,
  createExternalAgentToolHandler,
  type ExternalAgentReportFile,
  type ExternalAgentToolScope,
} from "./external-agent-tools.js";
import { executeHindsightTool } from "./hindsight.js";
import type { HubConnectionsBridge } from "./hub-connections-bridge.js";
import type { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import { spillOversizedReport } from "./report-overflow.js";
import { resolveEffectiveIdentityDir } from "./settings.js";
import { KuloStateDoc } from "./state.js";
import type { DispatchTicketParams } from "./tools-router.js";
import { sanitizeDiskFilename, type KuloUploadStore } from "./uploads.js";

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export interface TicketExternalRuntimePorts {
  connectionsBridge: Pick<HubConnectionsBridge, "list" | "use">;
  stageWorkerArtifact: (
    asset: ChatAttachment,
    meta: { conversationId: number; topicId: string; ticketId: string; runEpoch: number; envId: string },
    callId: string,
  ) => Promise<void>;
  dispatchTicket: (params: DispatchTicketParams, context: Context) => Promise<TicketCardView>;
  inspectWorker: (ticketId: string, context: Context) => Promise<WorkerInspectResult>;
}

export interface TicketExternalRuntimeDeps {
  harness: Harness;
  envManager: EnvManager;
  uploads: KuloUploadStore;
  connectionManager: KuloConnections;
  liveSettings: LiveSettingsStore;
  delivery: HubDeliveryCoordinator;
  runtimeGates: HubRuntimeGates;
  stateDir: string;
  defaultIdentityDir: string;
  ports: TicketExternalRuntimePorts;
}

export class TicketExternalRuntime {
  readonly #deps: TicketExternalRuntimeDeps;

  constructor(deps: TicketExternalRuntimeDeps) {
    this.#deps = deps;
  }

  createToolHandler(): ReturnType<typeof createExternalAgentToolHandler> {
    const { harness, uploads, connectionManager, liveSettings, delivery, runtimeGates, ports } = this.#deps;
    return createExternalAgentToolHandler({
      read: async (scope) => {
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const ticket = assertExternalAgentScope(scope, state?.tickets);
        const live = liveSettings.get();
        const role = resolveRoleOrDirectClient(ticket.role, live.roles, live.externalClients, live.presentation.language);
        return {
          ticket: cloneJson(ticket),
          role: role ? { ...cloneJson(role), allowSubagents: Boolean(role.allowSubagents && ticket.externalExecution?.allowSubagents) } : undefined,
          maxSubagents: live.executor.maxSubagentsPerTicket,
          children: cloneJson(ticket.externalExecution!.children ?? {}),
        };
      },
      agents: async (scope) => {
        const ticket = assertExternalAgentScope(scope, (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets);
        return Object.values(liveSettings.get().roles)
          .filter((role) => role.enabled !== false && role.id !== ticket.role)
          .map((role) => ({
            id: role.id,
            label: role.label,
            whenToUse: role.whenToUse,
            readOnly: Boolean(role.readOnly),
            ...(role.external ? { envId: role.external.envId } : {}),
            available: !role.external || Boolean(role.external.verifiedAt && isSupportedExternalAgentKind(role.external.kind)),
          }));
      },
      report: async (scope, report, files) => {
        const snap = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const snapTicket = assertExternalAgentScope(scope, snap?.tickets);
        const nextVersion = (snapTicket.externalExecution!.explicitReportVersion ?? 0) + 1;
        const stagedAttachments = files?.length ? await this.#stageReportFiles(scope, files) : undefined;
        const spilled = spillOversizedReport({
          uploads,
          ticketId: snapTicket.id,
          runEpoch: snapTicket.runEpoch,
          version: nextVersion,
          ownerConversationId: snapTicket.workerConversationId,
          originConversationId: snapTicket.originConversationId,
          report,
        });
        const finalizedReport: WorkerReportRecord = {
          ...spilled,
          ...(stagedAttachments?.length ? { attachments: stagedAttachments } : {}),
        };
        await harness.commit(async (tx) => {
          const ticket = assertExternalAgentScope(scope, (await tx.doc(KuloStateDoc)).tickets);
          const committedVersion = Math.max(nextVersion, (ticket.externalExecution!.explicitReportVersion ?? 0) + 1);
          ticket.externalExecution!.explicitReportVersion = committedVersion;
          ticket.latestReport = cloneJson(finalizedReport);
          if (finalizedReport.state === "ready") {
            ticket.externalExecution!.explicitReadyReport = {
              ...cloneJson(finalizedReport),
              runEpoch: ticket.runEpoch,
              version: committedVersion,
            };
          } else if (finalizedReport.state === "blocked" || finalizedReport.state === "failed") {
            delete ticket.externalExecution!.explicitReadyReport;
          }
          ticket.externalExecution!.lastActivityAt = Date.now();
          ticket.updatedAt = Date.now();
        }, BACKGROUND_CONTEXT);
        await runtimeGates.broadcastTickets(BACKGROUND_CONTEXT);
        return {
          recorded: true,
          pendingNativeCompletion: true,
          ...(["ready", "blocked", "failed"].includes(finalizedReport.state)
            ? { instruction: "Report recorded. End your turn immediately with one brief sentence; do not repeat the full report or make further edits." }
            : {}),
          ...(stagedAttachments?.length ? { stagedAssets: stagedAttachments.map((a) => ({ id: a.id, name: a.name })) } : {}),
          ...(finalizedReport.overflowAsset ? { overflowAssetId: finalizedReport.overflowAsset.id } : {}),
        };
      },
      memory: async (scope, toolName, args) => {
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const ticket = assertExternalAgentScope(scope, state?.tickets);
        const memory = liveSettings.get().memory;
        if (!memory.enabled || memory.accessMode === "private-only") {
          throw new Error("Hindsight 共享记忆库当前未开启。");
        }
        const res = await executeHindsightTool({
          config: memory,
          bank: "shared",
          caller: {
            role: "worker",
            conversationId: String(ticket.workerConversationId),
            ticketId: ticket.id,
            runEpoch: ticket.runEpoch,
            ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
            workerRole: ticket.role,
            sourceId: `external-mcp:${scope.runId}:${Date.now()}`,
          },
          toolName,
          args,
        });
        if (res.isError) throw new Error(res.text);
        try { return JSON.parse(res.text); } catch { return { text: res.text }; }
      },
      connectionsList: async (scope) => {
        const ticket = assertExternalAgentScope(scope, (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets);
        const list = await ports.connectionsBridge.list({
          kind: "worker",
          conversationId: ticket.workerConversationId,
          ticketId: ticket.id,
          runEpoch: ticket.runEpoch,
          readOnly: isEffectiveExternalReadOnly(ticket),
          isSubagent: false,
        }, BACKGROUND_CONTEXT);
        const granted = new Set(list.grantedConnectionIds);
        const grantedEntries = list.connections.filter((entry) => granted.has(entry.id)).map((entry) => {
          const { mcpArgs: _args, mcpCwd: _cwd, instructions, ...rest } = entry;
          return { ...rest, ...(instructions ? { instructions: instructions.slice(0, 1_000) } : {}) };
        });
        const grantedApps = new Set(grantedEntries.filter((entry) => entry.kind === "app" && entry.appId).map((entry) => entry.appId!));
        return {
          ...list,
          connections: grantedEntries,
          applications: (list.applications ?? []).filter((app) => grantedApps.has(app.id)),
          requests: [],
        };
      },
      connectionUse: async (scope, input) => {
        const ticket = assertExternalAgentScope(scope, (await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets);
        return ports.connectionsBridge.use({
          kind: "worker",
          conversationId: ticket.workerConversationId,
          ticketId: ticket.id,
          runEpoch: ticket.runEpoch,
          readOnly: isEffectiveExternalReadOnly(ticket),
          isSubagent: false,
        }, input, BACKGROUND_CONTEXT);
      },
      delegate: (scope, request) => delivery.queueTicket(scope.taskId, async () => {
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const parent = assertExternalAgentScope(scope, state?.tickets);
        const live = liveSettings.get();
        const role = live.roles[parent.role];
        if (!parent.externalExecution!.allowSubagents || !role?.allowSubagents || role.enabled === false) {
          throw new Error("该智能体未开启 Hub 协作。");
        }
        let depth = 0;
        for (let cursor: Readonly<TicketRecord> | undefined = parent; cursor?.parentTicketId; cursor = state?.tickets[cursor.parentTicketId]) {
          if (++depth >= 3) throw new Error("协作层级已达到上限，请交回主 Agent 调度。");
        }
        const commandId = `external-child:${createHash("sha256").update(`${parent.id}:${scope.runEpoch}:${request.requestId}`).digest("hex")}`;
        const child = await ports.dispatchTicket({
          commandId,
          title: request.goal.slice(0, 40),
          goal: request.goal,
          scope: parent.scope,
          acceptance: request.acceptance ?? parent.acceptance,
          role: request.agentId,
          envId: parent.envId,
          projectId: parent.projectId,
          workspaceDir: parent.workspaceDir,
          connectionIds: parent.connectionIds,
          originConversationId: parent.originConversationId,
          parentTicketId: parent.id,
          parentExternalRequest: { runId: scope.runId, runEpoch: scope.runEpoch, requestId: request.requestId, fingerprint: request.fingerprint },
        }, BACKGROUND_CONTEXT);
        const childRole = live.roles[request.agentId];
        // Slot-lock yield check must track actual scheduler write-holder lock (`!parent.readOnly`), not effective read-only intent.
        const requiresParentYield =
          (!parent.readOnly && (Boolean(childRole?.external) || !childRole?.readOnly)) ||
          (state?.slots.holders.length ?? 0) >= live.executor.maxConcurrentWorkers;
        return {
          ...child,
          requiresParentYield,
          ...(requiresParentYield
            ? { instruction: "协作任务正在等待可用执行名额或项目写入占用。请先结束当前轮并把协作安排交回主 Agent，释放后子任务会继续执行。" }
            : {}),
        };
      }),
      inspect: async (scope, childTaskId) => {
        const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const parent = assertExternalAgentScope(scope, state?.tickets);
        const child = state?.tickets[childTaskId];
        if (!child || child.parentTicketId !== parent.id || !Object.values(parent.externalExecution!.children ?? {}).some((entry) => entry.taskId === child.id)) {
          throw new Error("只能读取当前任务创建的协作任务。");
        }
        return { taskId: child.id, title: child.title, status: child.status, report: child.latestReport };
      },
      redact: (value) => connectionManager.redact(value),
    });
  }

  async respondPermission(
    ticketId: string,
    permissionId: string,
    choiceId: string,
    runEpoch: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<WorkerInspectResult> {
    const { harness, envManager, delivery, runtimeGates, ports } = this.#deps;
    await delivery.queueTicket(ticketId, async () => {
      const state = await harness.snapshot(KuloStateDoc, context);
      const ticket = state?.tickets[ticketId];
      const execution = ticket?.externalExecution;
      if (!ticket || !execution?.runId || ticket.status !== "running" || ticket.waiting || ticket.runEpoch !== runEpoch) {
        throw new Error("外部任务的执行资格已改变，请重新查看待授权操作。");
      }
      const pending = execution.pendingPermissions?.find((permission) => permission.id === permissionId);
      if (!pending?.choices.some((choice) => choice.id === choiceId)) {
        throw new Error("待授权操作或选项已失效，请重新查看。");
      }
      const response = await envManager.requestExternalAgent(ticket.envId, {
        operation: "respond",
        runId: execution.runId,
        permissionId,
        choiceId,
      });
      if (
        response.type !== "run" ||
        response.run.id !== execution.runId ||
        response.run.taskId !== ticketId ||
        response.run.runEpoch !== runEpoch ||
        response.run.kind !== execution.binding.kind
      ) {
        throw new Error("客户端返回了不匹配的授权回执。");
      }
      await harness.commit(async (tx) => {
        const current = assertExternalAgentScope(
          { envId: ticket.envId, taskId: ticketId, runEpoch, runId: execution.runId! },
          (await tx.doc(KuloStateDoc)).tickets,
        );
        current.externalExecution!.pendingPermissions = cloneJson(response.run.permissions);
      }, context);
    });
    await runtimeGates.broadcastTickets(context);
    return ports.inspectWorker(ticketId, context);
  }

  async materializeAttachments(
    ticket: Readonly<TicketRecord>,
    attachmentIds: readonly string[],
    context: Context,
    options?: { subdir?: string },
  ): Promise<Array<{ id: string; name: string; mimeType: string; path: string; size: number; sha256: string }>> {
    const { harness, envManager, uploads } = this.#deps;
    if (!attachmentIds.length || !ticket.scratchDir) return [];
    const envDesc = envManager.getEnvDescriptor(ticket.envId);
    if (!envDesc?.online) return [];
    const pathApi = envDesc.platform === "win32" ? path.win32 : path.posix;
    const safeSubdir = options?.subdir ? sanitizeDiskFilename(options.subdir) : undefined;
    const inputsDir = safeSubdir ? pathApi.join(ticket.scratchDir, "inputs", safeSubdir) : pathApi.join(ticket.scratchDir, "inputs");
    const env = envManager.createExecutionEnv(ticket.envId, ticket.scratchDir);
    getOrThrow(await env.createDir(inputsDir, { recursive: true }, context));
    const assertActive = async () => {
      const current = (await harness.snapshot(KuloStateDoc, context))?.tickets[ticket.id];
      if (!current || ["stopped", "closed"].includes(current.status)) throw new Error("任务已结束，停止转存附件。");
    };
    const epochPrefix = ticket.runEpoch > 1 ? `e${ticket.runEpoch}-` : "";
    const results: Array<{ id: string; name: string; mimeType: string; path: string; size: number; sha256: string }> = [];
    for (const [index, id] of attachmentIds.entries()) {
      const loaded = uploads.getUpload(id);
      if (!loaded) continue;
      const safeName = `${epochPrefix}${String(index + 1).padStart(2, "0")}-${sanitizeDiskFilename(loaded.record.name)}`;
      const targetPath = pathApi.join(inputsDir, safeName);
      const handle = await fs.promises.open(loaded.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        let sha = loaded.record.sha256;
        if (!sha) {
          const hasher = createHash("sha256");
          let pos = 0;
          while (pos < stat.size) {
            const buf = Buffer.alloc(Math.min(EXECUTION_FILE_CHUNK_BYTES, stat.size - pos));
            const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
            if (bytesRead <= 0) break;
            pos += bytesRead;
            hasher.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          }
          sha = hasher.digest("hex");
        }
        async function* chunks(): AsyncGenerator<Uint8Array> {
          let offset = 0;
          while (offset < stat.size) {
            const buffer = Buffer.alloc(Math.min(EXECUTION_FILE_CHUNK_BYTES, stat.size - offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead <= 0) break;
            offset += bytesRead;
            yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
          }
        }
        const written = await writeExecutionFile({
          env,
          root: ticket.scratchDir,
          target: targetPath,
          size: stat.size,
          hash: sha,
          chunks: chunks(),
          overwrite: true,
          assertActive,
          context,
        });
        results.push({ id: loaded.record.id, name: loaded.record.name, mimeType: loaded.record.mimeType, path: written.path, size: stat.size, sha256: sha });
      } finally {
        await handle.close();
      }
    }
    return results;
  }

  async consumePendingReports(
    ticket: Readonly<TicketRecord>,
    reports: readonly ExternalAgentPendingReport[],
    context: Context,
  ): Promise<string[]> {
    const { harness, envManager, uploads, connectionManager, runtimeGates } = this.#deps;
    const ackIds: string[] = [];
    let anyCommitted = false;
    for (const pending of reports) {
      const snap = await harness.snapshot(KuloStateDoc, context);
      const current = snap?.tickets[ticket.id];
      if (!current || current.runEpoch !== ticket.runEpoch || !current.externalExecution) break;
      if (current.externalExecution.consumedPendingReportIds?.includes(pending.reportId)) {
        ackIds.push(pending.reportId);
        continue;
      }

      const stagedAttachments: ChatAttachment[] = [];
      if (pending.files?.length) {
        const ownerId = `agent:${current.workerConversationId}`;
        for (const [index, file] of pending.files.entries()) {
          const env = envManager.createExecutionEnv(current.envId, path.dirname(file.snapshotPath));
          const readRes = await env.readBinaryFile(file.snapshotPath, context);
          if (!readRes.ok) {
            throw new Error(`无法读取离线交卷文件快照：${file.originalPath}`);
          }
          const bytes = Buffer.from(readRes.value);
          const actualSha = createHash("sha256").update(bytes).digest("hex");
          if (bytes.byteLength !== file.size || actualSha !== file.sha256) {
            throw new Error(`离线交卷文件快照校验失败：${file.originalPath}`);
          }
          const saved = uploads.saveUpload({
            name: file.name ?? path.basename(file.originalPath),
            mimeType: file.mimeType,
            bytes,
            ownerId,
            idempotencyKey: `ext-outbox:${current.id}:${current.runEpoch}:${pending.reportId}:${index}`,
          });
          uploads.bindAttachments([saved], `ticket:${current.id}`, ownerId);
          uploads.bindAttachments([saved], `conversation:${current.workerConversationId}`, ownerId);
          if (current.originConversationId !== undefined) {
            uploads.bindAttachments([saved], `conversation:${current.originConversationId}`, ownerId);
          }
          stagedAttachments.push(saved);
        }
      }

      const nextVersion = (current.externalExecution.explicitReportVersion ?? 0) + 1;
      const spilled = spillOversizedReport({
        uploads,
        ticketId: current.id,
        runEpoch: current.runEpoch,
        version: nextVersion,
        ownerConversationId: current.workerConversationId,
        originConversationId: current.originConversationId,
        report: {
          state: pending.state,
          summary: connectionManager.redact(pending.summary),
          ...(pending.deliverable ? { deliverable: connectionManager.redact(pending.deliverable) } : {}),
          ...(pending.question ? { question: connectionManager.redact(pending.question) } : {}),
          at: pending.at,
        },
      });
      const finalizedReport: WorkerReportRecord = {
        ...spilled,
        ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
      };

      await harness.commit(async (tx) => {
        const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
        if (!live || live.runEpoch !== ticket.runEpoch || !live.externalExecution) return;
        const consumed = live.externalExecution.consumedPendingReportIds ?? [];
        if (consumed.includes(pending.reportId)) return;
        live.externalExecution.consumedPendingReportIds = [...consumed, pending.reportId];
        const committedVersion = Math.max(nextVersion, (live.externalExecution.explicitReportVersion ?? 0) + 1);
        live.externalExecution.explicitReportVersion = committedVersion;
        live.latestReport = cloneJson(finalizedReport);
        if (finalizedReport.state === "ready") {
          live.externalExecution.explicitReadyReport = {
            ...cloneJson(finalizedReport),
            runEpoch: live.runEpoch,
            version: committedVersion,
          };
        } else if (finalizedReport.state === "blocked" || finalizedReport.state === "failed") {
          delete live.externalExecution.explicitReadyReport;
        }
        live.externalExecution.lastActivityAt = Date.now();
        live.updatedAt = Date.now();
        anyCommitted = true;
      }, context);
      ackIds.push(pending.reportId);
    }
    if (anyCommitted) {
      await runtimeGates.broadcastTickets(context);
    }
    return ackIds;
  }

  async #stageReportFiles(scope: ExternalAgentToolScope, files: ExternalAgentReportFile[]): Promise<ChatAttachment[]> {
    const { harness, envManager, uploads, liveSettings, stateDir, defaultIdentityDir, ports } = this.#deps;
    const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = assertExternalAgentScope(scope, state?.tickets);
    const envDesc = envManager.getEnvDescriptor(ticket.envId);
    if (!envDesc?.online) throw new Error("执行设备离线，无法读取待审产物文件。");
    const pathApi = envDesc.platform === "win32" ? path.win32 : path.posix;
    const insideRoot = (candidate: string, root: string) => {
      const rel = pathApi.relative(root, candidate);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
    };
    const stagedCwd = ticket.externalExecution?.stagedCwd && !ticket.externalExecution.stagedAppliedAt ? ticket.externalExecution.stagedCwd : undefined;
    const protectedPaths = [stateDir, resolveEffectiveIdentityDir(liveSettings.get(), defaultIdentityDir)];
    const staged: ChatAttachment[] = [];
    for (const [index, item] of files.entries()) {
      const allowedRoot = stagedCwd && (!pathApi.isAbsolute(item.path) || insideRoot(item.path, stagedCwd))
        ? stagedCwd
        : ticket.scratchDir && pathApi.isAbsolute(item.path) && insideRoot(item.path, ticket.scratchDir)
          ? ticket.scratchDir
          : ticket.workspaceDir;
      const resolvedPath = pathApi.isAbsolute(item.path) ? item.path : pathApi.resolve(allowedRoot, item.path);
      const env = envManager.createExecutionEnv(ticket.envId, allowedRoot);
      const callId = `external-report-file:${scope.runId}:${index}:${createHash("sha256").update(resolvedPath).digest("hex").slice(0, 16)}`;
      const asset = await publishExecutionAsset(
        {
          path: resolvedPath,
          ...(item.name ? { name: item.name } : {}),
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          ...(item.caption ? { caption: item.caption } : {}),
        },
        { env, conversationId: ticket.workerConversationId as ConversationId, callId },
        BACKGROUND_CONTEXT,
        uploads,
        {
          allowedRoot,
          protectedPaths: protectedPaths.filter((p) => !insideRoot(allowedRoot, p)),
          trustedSandbox: true,
          ownerId: `agent:${ticket.workerConversationId}`,
        },
      );
      await ports.stageWorkerArtifact(asset, {
        conversationId: ticket.workerConversationId,
        topicId: ticket.originTopicId ?? "root",
        ticketId: ticket.id,
        runEpoch: ticket.runEpoch,
        envId: ticket.envId,
      }, callId);
      staged.push(asset);
    }
    return staged;
  }
}
