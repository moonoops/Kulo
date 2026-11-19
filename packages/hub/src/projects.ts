import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry, UserEntry, defineDoc,
  type ConversationId, type Harness, type JsonObject,
} from "@earendil-works/pi-durable";
import type {
  CreateProjectInput, ProjectDirectoryGrant, ProjectDirectoryListing, ProjectRecord,
  ProjectView, TicketRecord, TopicSummary,
} from "@moco/protocol";
import { MocoStateDoc, hasPendingWorkspaceApply, transitionTicketStatus } from "./state.js";
import { MocoUserEntry } from "./ui-cards.js";

export class ProjectError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { ticketIds?: string[]; activeTickets?: string[]; projectId?: string },
  ) { super(message); this.name = "ProjectError"; }
}

export interface ProjectEnvManager {
  getEnvDescriptor(id: string): { id: string; name: string; online: boolean; capabilities: string[] } | undefined;
  listProjectDirectories(deviceId: string, directory?: string): Promise<ProjectDirectoryListing>;
  authorizeProjectDirectory(deviceId: string, input: {
    projectId: string; path: string; create?: boolean; operationId: string; revision?: number;
  }): Promise<ProjectDirectoryGrant>;
  revokeProjectDirectory(deviceId: string, projectId: string): Promise<{ cleanupPending: boolean }>;
}

interface CreateOperation { projectId: string; input: CreateProjectInput }
interface BindingOperation { operationId: string; deviceId: string; workspaceDir: string; revision: number; grantRevision: number }
export interface MocoProjectsState {
  projects: Record<string, ProjectRecord>;
  commands: Record<string, CreateOperation>;
  bindings: Record<string, BindingOperation>;
  needsAuthorization: Record<string, boolean>;
  cleanup: Record<string, { projectId: string; deviceId: string; since: number }>;
  errors: Record<string, string>;
  cancellations: Record<string, { projectId?: string; reason: string; requestedAt: number }>;
}

export const MocoProjectsDoc = defineDoc<MocoProjectsState & JsonObject>({
  kind: "moco.projects", version: 1, scope: "session",
  initial: () => ({ projects: {}, commands: {}, bindings: {}, needsAuthorization: {}, cleanup: {}, errors: {}, cancellations: {} }) as MocoProjectsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export interface ProjectHistoryMatch {
  topicId: string; title: string; entryId: number; role: "user" | "assistant"; excerpt: string;
}

export interface RemoveProjectResult {
  deleted: string; projects: ProjectView[]; topics: TopicSummary[]; cleanupPending: boolean;
}

export interface ProjectPatch {
  name?: string; notes?: string; workspaceDir?: string; deviceId?: string; expectedRevision?: number;
}

export interface MocoProjectsDependencies {
  harness: Harness;
  envManager: ProjectEnvManager;
  stopTicket: (id: string, reason: string) => Promise<unknown>;
  onChanged?: () => void | Promise<void>;
}

const UNFINISHED = new Set(["queued", "running", "pausing", "waiting", "blocked"]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;
const clean = (value: string, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new ProjectError(400, "invalid_project", `${name}无效。`);
  }
  return value.trim();
};

export function assertProjectBinding(
  state: Readonly<MocoProjectsState> | undefined, id: string, expectedRevision?: number,
): ProjectRecord {
  const project = own(state?.projects, id);
  if (!project || project.deletedAt !== undefined) throw new ProjectError(404, "project_not_found", "项目不存在或已删除。");
  if (state?.bindings[id]) throw new ProjectError(409, "project_binding_pending", "项目目录正在重新关联，请稍后重试。");
  if (expectedRevision !== undefined && project.revision !== expectedRevision) {
    throw new ProjectError(409, "project_revision_conflict", "项目已更新，请刷新后重试。");
  }
  return clone(project);
}

export class MocoProjects {
  readonly #deps: MocoProjectsDependencies;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(deps: MocoProjectsDependencies) { this.#deps = deps; }

  async #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run, run);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #changed(): Promise<void> { await this.#deps.onChanged?.(); }

  #view(project: ProjectRecord, state?: Readonly<MocoProjectsState>): ProjectView {
    const device = this.#deps.envManager.getEnvDescriptor(project.deviceId);
    const error = project.deletedAt !== undefined ? "项目已删除。"
      : state?.bindings[project.id] ? "项目目录正在重新关联。"
      : state?.errors[project.id]
      ?? (state?.needsAuthorization[project.id] ? "项目目录需要重新授权。" : undefined)
      ?? (device && (!device.capabilities.includes("worker-isolation") || device.capabilities.includes("worker-isolation-unavailable")) ? "设备执行隔离尚未就绪。" : undefined)
      ?? (device?.capabilities.includes("worker-network-unavailable") ? "设备执行网络尚未就绪。" : undefined);
    return {
      ...clone(project), deviceName: device?.name ?? project.deviceId,
      availability: !device?.online ? "offline" : error ? "unavailable" : "ready",
      ...(error ? { error } : {}),
    };
  }

  async list(context: Context = BACKGROUND_CONTEXT, includeDeleted = false): Promise<ProjectView[]> {
    const state = await this.#deps.harness.snapshot(MocoProjectsDoc, context);
    return Object.values(state?.projects ?? {})
      .filter((project) => includeDeleted || project.deletedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map((project) => this.#view(project, state));
  }

  async listTopics(projectId: string | null | undefined, context: Context = BACKGROUND_CONTEXT, includeDeleted = false): Promise<TopicSummary[]> {
    if (projectId) await this.get(projectId, context, includeDeleted);
    const [state, projects] = await Promise.all([
      this.#deps.harness.snapshot(MocoStateDoc, context),
      this.#deps.harness.snapshot(MocoProjectsDoc, context),
    ]);
    return Object.values(state?.topics ?? {}).filter((topic) => {
      if (projectId !== undefined && (topic.projectId ?? null) !== projectId) return false;
      if (includeDeleted) return true;
      return topic.deletedAt === undefined && (!topic.projectId || own(projects?.projects, topic.projectId)?.deletedAt === undefined);
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(clone);
  }

  async get(id: string, context: Context = BACKGROUND_CONTEXT, includeDeleted = false): Promise<ProjectRecord> {
    const state = await this.#deps.harness.snapshot(MocoProjectsDoc, context);
    if (!includeDeleted) return assertProjectBinding(state, id);
    const project = own(state?.projects, id);
    if (!project) throw new ProjectError(404, "project_not_found", "项目不存在。");
    return clone(project);
  }

  async create(input: CreateProjectInput, context: Context = BACKGROUND_CONTEXT): Promise<ProjectView> {
    return this.#serial(async () => {
      const request: CreateProjectInput = {
        commandId: clean(input.commandId, "操作编号", 256), name: clean(input.name, "项目名称", 120),
        deviceId: clean(input.deviceId, "设备", 100), workspaceDir: clean(input.workspaceDir, "项目目录", 4096),
        ...(input.createDirectory ? { createDirectory: true } : {}),
      };
      const operation = await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(MocoProjectsDoc);
        const previous = own(state.commands, request.commandId);
        if (previous) {
          if (JSON.stringify(previous.input) !== JSON.stringify(request)) {
            throw new ProjectError(409, "project_command_conflict", "同一操作编号不能用于不同的项目请求。");
          }
          return clone(previous);
        }
        const next = { projectId: `project-${randomUUID()}`, input: request };
        if (["__proto__", "constructor", "prototype"].includes(request.commandId)) throw new ProjectError(400, "invalid_project", "操作编号无效。");
        state.commands[request.commandId] = next;
        return clone(next);
      }, context);
      const existing = (await this.#deps.harness.snapshot(MocoProjectsDoc, context))?.projects[operation.projectId];
      if (existing) {
        if (existing.deletedAt !== undefined) throw new ProjectError(409, "project_deleted", "原项目已删除，请通过 Moco 恢复。");
        return this.#view(existing);
      }
      const grant = await this.#deps.envManager.authorizeProjectDirectory(request.deviceId, {
        projectId: operation.projectId, path: request.workspaceDir, create: request.createDirectory,
        operationId: request.commandId, revision: 1,
      });
      try {
        const project = await this.#deps.harness.commit(async (tx) => {
          const state = await tx.doc(MocoProjectsDoc);
          this.#assertUnique(state, operation.projectId, request.deviceId, grant.directoryId);
          const now = Date.now();
          const record: ProjectRecord = {
            id: operation.projectId, name: request.name, deviceId: request.deviceId,
            workspaceDir: grant.workspaceDir, directoryId: grant.directoryId,
            revision: 1, grantRevision: grant.revision, notes: "", createdAt: now, updatedAt: now,
            ...(grant.scratchRoot ? { scratchRoot: grant.scratchRoot } : {}),
            ...(grant.platform ? { platform: grant.platform } : {}),
          };
          state.projects[record.id] = record;
          return clone(record);
        }, context);
        await this.#changed();
        return this.#view(project);
      } catch (error) {
        if (error instanceof ProjectError && error.code === "project_directory_duplicate") {
          await this.#revoke(request.deviceId, operation.projectId, context);
        }
        throw error;
      }
    });
  }

  #assertUnique(state: Readonly<MocoProjectsState>, id: string, deviceId: string, directoryId: string): void {
    const duplicate = Object.values(state.projects).find((project) =>
      project.id !== id && project.deletedAt === undefined && project.deviceId === deviceId && project.directoryId === directoryId);
    if (duplicate) throw new ProjectError(409, "project_directory_duplicate", "该目录已关联项目。", { projectId: duplicate.id });
  }

  async patch(id: string, patch: ProjectPatch, context: Context = BACKGROUND_CONTEXT): Promise<ProjectView> {
    return this.#serial(async () => {
      const project = await this.get(id, context, true);
      if (project.deletedAt !== undefined) throw new ProjectError(404, "project_not_found", "项目不存在或已删除。");
      const previousBinding = (await this.#deps.harness.snapshot(MocoProjectsDoc, context))?.bindings[id];
      const name = patch.name === undefined ? project.name : clean(patch.name, "项目名称", 120);
      if (patch.notes !== undefined && (typeof patch.notes !== "string" || patch.notes.length > 32_000 || patch.notes.includes("\0"))) {
        throw new ProjectError(400, "invalid_project_notes", "项目说明过长或包含无效字符。");
      }
      const deviceId = patch.deviceId === undefined ? project.deviceId : clean(patch.deviceId, "设备", 100);
      const workspaceDir = patch.workspaceDir === undefined ? project.workspaceDir : clean(patch.workspaceDir, "项目目录", 4096);
      const rebind = deviceId !== project.deviceId || patch.workspaceDir !== undefined || previousBinding !== undefined;
      const expected = patch.expectedRevision ?? project.revision;
      if (expected !== project.revision) throw new ProjectError(409, "project_revision_conflict", "项目已更新，请刷新后重试。");
      let grant: ProjectDirectoryGrant | undefined;
      const grantRevision = previousBinding?.deviceId === deviceId && previousBinding.workspaceDir === workspaceDir
        ? previousBinding.grantRevision : Math.max(project.grantRevision, previousBinding?.grantRevision ?? 0) + 1;
      const operationId = `project:bind:${id}:${expected + 1}:${grantRevision}`;
      if (rebind) {
        await this.#deps.harness.commit(async (tx) => {
          const state = await tx.doc(MocoProjectsDoc);
          const current = own(state.projects, id);
          if (!current || current.deletedAt !== undefined || current.revision !== expected) throw new ProjectError(409, "project_revision_conflict", "项目已更新，请刷新后重试。");
          const runtime = await tx.doc(MocoStateDoc);
          this.#assertNoTickets(Object.values(runtime.tickets), (ticket) => ticket.projectId === id);
          state.bindings[id] = { operationId, deviceId, workspaceDir, revision: expected + 1, grantRevision };
        }, context);
        await this.#changed();
        try {
          grant = await this.#deps.envManager.authorizeProjectDirectory(deviceId, {
            projectId: id, path: workspaceDir, operationId, revision: grantRevision,
          });
        } catch (error) {
          await this.#abortBinding(id, deviceId, grantRevision, context);
          throw error;
        }
      }
      let next: ProjectRecord;
      try { next = await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(MocoProjectsDoc);
        const current = own(state.projects, id);
        if (!current || current.deletedAt !== undefined || current.revision !== expected) {
          throw new ProjectError(409, "project_revision_conflict", "项目已更新，请刷新后重试。");
        }
        if (grant) {
          const runtime = await tx.doc(MocoStateDoc);
          this.#assertNoTickets(Object.values(runtime.tickets), (ticket) => ticket.projectId === id);
          this.#assertUnique(state, id, deviceId, grant.directoryId);
          if (current.deviceId !== deviceId) {
            state.cleanup[`${current.deviceId}:${id}`] = { projectId: id, deviceId: current.deviceId, since: Date.now() };
          }
          current.deviceId = deviceId; current.workspaceDir = grant.workspaceDir;
          current.directoryId = grant.directoryId; current.grantRevision = grant.revision;
          if (grant.scratchRoot) current.scratchRoot = grant.scratchRoot;
          if (grant.platform) current.platform = grant.platform;
          delete state.bindings[id]; delete state.needsAuthorization[id]; delete state.errors[id];
        }
        current.name = name;
        if (patch.notes !== undefined) current.notes = patch.notes;
        current.revision++; current.updatedAt = Date.now();
        return clone(current);
      }, context); }
      catch (error) {
        if (rebind && error instanceof ProjectError) await this.#abortBinding(id, deviceId, grantRevision, context);
        throw error;
      }
      if (rebind && project.deviceId !== deviceId) await this.#revoke(project.deviceId, id, context);
      await this.#changed();
      return this.#view(next);
    });
  }

  async #abortBinding(id: string, deviceId: string, grantRevision: number, context: Context): Promise<void> {
    try { await this.#revoke(deviceId, id, context); }
    finally {
      await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(MocoProjectsDoc);
        const project = own(state.projects, id);
        if (project && project.deletedAt === undefined) {
          project.grantRevision = Math.max(project.grantRevision, grantRevision) + 1;
          project.revision++; project.updatedAt = Date.now();
          state.needsAuthorization[id] = true;
        }
        delete state.bindings[id];
      }, context);
      await this.#changed();
    }
  }

  #assertNoTickets(tickets: readonly TicketRecord[], matches: (ticket: TicketRecord) => boolean): void {
    const active = tickets.filter((ticket) => matches(ticket) && (UNFINISHED.has(ticket.status) || hasPendingWorkspaceApply(ticket)));
    if (active.length) throw new ProjectError(409, "project_tasks_running", "请先完成、合并或关闭相关任务。", { ticketIds: active.map((ticket) => ticket.id) });
  }

  async #revoke(deviceId: string, projectId: string, context: Context): Promise<boolean> {
    const key = `${deviceId}:${projectId}`;
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(MocoProjectsDoc);
      state.cleanup[key] = { deviceId, projectId, since: Date.now() };
    }, context);
    if (!this.#deps.envManager.getEnvDescriptor(deviceId)?.online) return true;
    let result: { cleanupPending: boolean };
    try { result = await this.#deps.envManager.revokeProjectDirectory(deviceId, projectId); }
    catch (error) {
      if (!this.#deps.envManager.getEnvDescriptor(deviceId)?.online) return true;
      throw error;
    }
    if (!result.cleanupPending) await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(MocoProjectsDoc);
      delete state.cleanup[key];
      const runtime = await tx.doc(MocoStateDoc);
      for (const ticket of Object.values(runtime.tickets)) {
        if (ticket.projectId === projectId && ticket.envId === deviceId && !UNFINISHED.has(ticket.status) && !state.cancellations?.[ticket.id]) ticket.cleanupPending = false;
      }
    }, context);
    return result.cleanupPending;
  }

  async remove(id: string, options: { stopTasks?: boolean } = {}, context: Context = BACKGROUND_CONTEXT): Promise<RemoveProjectResult> {
    return this.#serial(async () => {
      const transition = await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(MocoProjectsDoc);
        const project = own(state.projects, id);
        if (!project) throw new ProjectError(404, "project_not_found", "项目不存在。");
        const runtime = await tx.doc(MocoStateDoc);
        const projectTopics = Object.values(runtime.topics ?? {}).filter((topic) => topic.projectId === id);
        const topicIds = new Set(projectTopics.map((topic) => topic.id));
        const conversationIds = new Set(projectTopics.map((topic) => topic.conversationId));
        const tickets = Object.values(runtime.tickets).filter((ticket) =>
          (ticket.projectId === id || topicIds.has(ticket.originTopicId ?? "") || conversationIds.has(ticket.originConversationId ?? -1))
          && (UNFINISHED.has(ticket.status) || hasPendingWorkspaceApply(ticket)));
        if (tickets.length && !options.stopTasks) throw new ProjectError(409, "project_tasks_running", "项目仍有进行中或待合入的任务，是否停止相关任务并删除？", { ticketIds: tickets.map((ticket) => ticket.id) });
        const now = Date.now();
        if (project.deletedAt === undefined) {
          project.deletedAt = now; project.deletionId = `project-delete-${randomUUID()}`;
          project.revision++; project.updatedAt = now;
        }
        const pendingBinding = own(state.bindings, id);
        if (pendingBinding && pendingBinding.deviceId !== project.deviceId) {
          state.cleanup[`${pendingBinding.deviceId}:${id}`] = { projectId: id, deviceId: pendingBinding.deviceId, since: now };
        }
        delete state.bindings[id];
        for (const topic of Object.values(runtime.topics ?? {})) {
          if (topic.projectId === id && topic.deletedAt === undefined) {
            topic.deletedAt = now; topic.deletionId = project.deletionId; topic.updatedAt = now;
            const titleJob = runtime.topicTitles?.[topic.id];
            if (titleJob?.status === "pending") titleJob.status = "cancelled";
          }
        }
        const key = `${project.deviceId}:${id}`;
        state.cleanup[key] = { projectId: id, deviceId: project.deviceId, since: now };
        // Cancel intent is durable before aborting conversations or contacting an offline Env.
        for (const ticket of tickets) {
          transitionTicketStatus(ticket, "stopped", now); ticket.stoppedReason = "项目已删除";
          ticket.updatedAt = now; ticket.cleanupPending = true;
          state.cancellations ??= {};
          state.cancellations[ticket.id] = { projectId: id, reason: "项目已删除", requestedAt: now };
        }
        return { project: clone(project), cleanupDevices: [...new Set(Object.values(state.cleanup).filter((item) => item.projectId === id).map((item) => item.deviceId))] };
      }, context);
      await this.#changed();
      await this.#cancelPending(context, id);
      let cleanupPending = false;
      for (const deviceId of transition.cleanupDevices) cleanupPending = await this.#revoke(deviceId, id, context) || cleanupPending;
      const runtime = await this.#deps.harness.snapshot(MocoStateDoc, context);
      await this.#changed();
      return { deleted: id, projects: await this.list(context), topics: Object.values(runtime?.topics ?? {}).filter((topic) => topic.deletedAt === undefined).map(clone), cleanupPending };
    });
  }

  async restore(id: string, context: Context = BACKGROUND_CONTEXT): Promise<ProjectView> {
    return this.#serial(async () => {
      const project = await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(MocoProjectsDoc);
        const current = own(state.projects, id);
        if (!current) throw new ProjectError(404, "project_not_found", "项目不存在。");
        this.#assertUnique(state, id, current.deviceId, current.directoryId);
        if (current.deletedAt === undefined) return clone(current);
        const deletionId = current.deletionId;
        const runtime = await tx.doc(MocoStateDoc);
        for (const topic of Object.values(runtime.topics ?? {})) {
          if (topic.projectId === id && topic.deletedAt !== undefined && topic.deletionId === deletionId) {
            delete topic.deletedAt; delete topic.deletionId; topic.updatedAt = Date.now();
          }
        }
        delete current.deletedAt; delete current.deletionId;
        current.revision++; current.grantRevision++; current.updatedAt = Date.now();
        state.needsAuthorization[id] = true;
        return clone(current);
      }, context);
      await this.#changed();
      const state = await this.#deps.harness.snapshot(MocoProjectsDoc, context);
      return this.#view(project, state);
    });
  }

  async ensureAuthorized(id: string, context: Context = BACKGROUND_CONTEXT): Promise<ProjectRecord> {
    return this.#serial(async () => {
      const project = await this.get(id, context);
      if (!this.#deps.envManager.getEnvDescriptor(project.deviceId)?.online) throw new ProjectError(409, "project_device_offline", "项目设备离线。");
      const before = await this.#deps.harness.snapshot(MocoProjectsDoc, context);
      if (before?.cleanup[`${project.deviceId}:${id}`]) throw new ProjectError(409, "project_cleanup_pending", "项目旧执行仍待清理，请等待设备确认后重试。");
      let grant: ProjectDirectoryGrant;
      try {
        grant = await this.#deps.envManager.authorizeProjectDirectory(project.deviceId, {
          projectId: id, path: project.workspaceDir, operationId: `project:authorize:${id}:${project.grantRevision}`, revision: project.grantRevision,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#deps.harness.commit(async (tx) => {
          const state = await tx.doc(MocoProjectsDoc);
          state.needsAuthorization[id] = true;
          state.errors[id] = `项目目录不可用，请检查路径、权限或重新关联。${message}`;
        }, context);
        await this.#changed();
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (typeof code === "string" && ["project_directory_unavailable", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ESTALE"].includes(code)) {
          const unavailable = new ProjectError(409, "project_directory_unavailable", `项目目录不可用，请检查路径、权限或通过 Moco 重新关联。${message}`);
          unavailable.cause = error;
          throw unavailable;
        }
        throw error;
      }
      if (grant.directoryId !== project.directoryId) {
        await this.#revoke(project.deviceId, id, context);
        await this.#deps.harness.commit(async (tx) => {
          const state = await tx.doc(MocoProjectsDoc);
          state.needsAuthorization[id] = true;
          state.errors[id] = "项目目录身份已变化，请通过 Moco 重新关联。";
        }, context);
        throw new ProjectError(409, "project_directory_changed", "项目目录身份已变化，请通过 Moco 重新关联。");
      }
      await this.#deps.harness.commit(async (tx) => {
        const state = await tx.doc(MocoProjectsDoc);
        assertProjectBinding(state, id, project.revision);
        const current = state.projects[id]!;
        if (grant.scratchRoot) current.scratchRoot = grant.scratchRoot;
        if (grant.platform) current.platform = grant.platform;
        delete state.needsAuthorization[id]; delete state.errors[id];
      }, context);
      return this.get(id, context);
    });
  }

  async reconcileDevice(deviceId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#serial(async () => {
      await this.#cancelPending(context);
      if (!this.#deps.envManager.getEnvDescriptor(deviceId)?.online) return;
      const state = await this.#deps.harness.snapshot(MocoProjectsDoc, context);
      for (const cleanup of Object.values(state?.cleanup ?? {}).filter((item) => item.deviceId === deviceId)) {
        await this.#revoke(deviceId, cleanup.projectId, context);
      }
    });
  }

  async reconcileCancellations(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.#serial(() => this.#cancelPending(context));
  }

  async #cancelPending(context: Context, projectId?: string): Promise<void> {
    const snapshot = await this.#deps.harness.snapshot(MocoProjectsDoc, context);
    for (const [ticketId, cancellation] of Object.entries(snapshot?.cancellations ?? {})) {
      if (projectId && cancellation.projectId !== projectId) continue;
      await this.#deps.stopTicket(ticketId, cancellation.reason);
      await this.#deps.harness.commit(async (tx) => { const state = await tx.doc(MocoProjectsDoc); delete state.cancellations[ticketId]; }, context);
    }
  }

  async moveTopic(topicId: string, projectId: string | null, context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary> {
    return this.#serial(async () => {
      const topic = await this.#deps.harness.commit(async (tx) => {
        const projects = await tx.doc(MocoProjectsDoc);
        if (projectId !== null) assertProjectBinding(projects, projectId);
        const state = await tx.doc(MocoStateDoc);
        const current = own(state.topics, topicId);
        if (!current || current.deletedAt !== undefined) throw new ProjectError(404, "topic_not_found", "会话不存在或已删除。");
        if (current.master) throw new ProjectError(409, "master_topic_immutable", "默认主会话不能移入项目。");
        if ((current.projectId ?? null) === projectId) return clone(current);
        this.#assertNoTickets(Object.values(state.tickets), (ticket) => ticket.originTopicId === topicId || ticket.originConversationId === current.conversationId);
        current.projectId = projectId; current.updatedAt = Date.now();
        return clone(current);
      }, context);
      await this.#changed(); return topic;
    });
  }

  async restoreTopic(topicId: string, context: Context = BACKGROUND_CONTEXT): Promise<TopicSummary> {
    return this.#serial(async () => {
      const topic = await this.#deps.harness.commit(async (tx) => {
        const projects = await tx.doc(MocoProjectsDoc);
        const state = await tx.doc(MocoStateDoc);
        const current = own(state.topics, topicId);
        if (!current) throw new ProjectError(404, "topic_not_found", "会话不存在。");
        if (current.projectId) assertProjectBinding(projects, current.projectId);
        delete current.deletedAt; delete current.deletionId; current.updatedAt = Date.now();
        return clone(current);
      }, context);
      await this.#changed(); return topic;
    });
  }

  async searchHistory(projectId: string, query: string, context: Context = BACKGROUND_CONTEXT): Promise<ProjectHistoryMatch[]> {
    await this.get(projectId, context);
    const search = clean(query, "检索内容", 256).toLocaleLowerCase();
    const state = await this.#deps.harness.snapshot(MocoStateDoc, context);
    const topics = Object.values(state?.topics ?? {}).filter((topic) => topic.projectId === projectId && topic.deletedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const matches: ProjectHistoryMatch[] = [];
    for (const topic of topics) {
      const conversation = await this.#deps.harness.conversation(topic.conversationId as ConversationId, context);
      if (!conversation) continue;
      let page = await conversation.entries({ order: "descending" }, 100, undefined, context);
      for (;;) {
        context.abortSignal?.throwIfAborted();
        for (const entry of page.items) {
          const isUser = UserEntry.is(entry) || MocoUserEntry.is(entry);
          if (!isUser && !AssistantEntry.is(entry)) continue;
          const model = entry.model?.[0] as { content?: unknown } | undefined;
          const storedText = MocoUserEntry.is(entry) ? entry.data.text : undefined;
          const text = typeof storedText === "string" ? storedText : typeof model?.content === "string" ? model.content : Array.isArray(model?.content)
            ? model.content.flatMap((block) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
          const at = text.toLocaleLowerCase().indexOf(search);
          if (at < 0) continue;
          matches.push({ topicId: topic.id, title: topic.title, entryId: Number(entry.id), role: isUser ? "user" : "assistant", excerpt: text.slice(Math.max(0, at - 120), at + 480) });
          if (matches.length === 20) return matches;
        }
        if (!page.next) break;
        page = await conversation.entries({ order: "descending" }, 100, page.next, context);
      }
    }
    return matches;
  }
}
