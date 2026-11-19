import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type {
  BrowserRequest, BrowserResult, CapabilityRecord, ChatAttachment, MediaConnectionView, MediaJob,
  MediaJobRequest, MediaJobSource, MediaKind, MediaOutputFormat, ImageGenerationParameters,
} from "@moco/protocol";
import { getImageModelProfile, mergeImageGenerationParameters, normalizeImageGenerationParameters } from "@moco/protocol";
import {
  MAX_MESSAGE_UPLOAD_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES,
  MocoUploadStore,
} from "./uploads.js";
import {
  decodeMediaBase64, downloadImageOutput, generateImage, MediaAdapterError, MEDIA_OUTPUT_MIMES,
  validateImageParameters, customImageRequest, type ImageOutput, type MediaInput,
} from "./media-adapters.js";
import { CapabilityError } from "./capabilities.js";

export interface MediaCapabilities {
  resolve(id: string | undefined, kind: MediaKind, format?: MediaOutputFormat, request?: Partial<MediaJobRequest>): Promise<{ capability: CapabilityRecord; connection: MediaConnectionView; selectionReason?: string }>;
  connection(id: string): Promise<MediaConnectionView>;
  apiKey(connectionId: string, expectedOrigin?: string): Promise<string>;
  markGenerated?(id: string, expectedRevision: number): Promise<void>;
}
export interface MediaJobsOptions {
  harness: Harness;
  capabilities: MediaCapabilities;
  uploads: MocoUploadStore;
  browser: (envId: string, request: BrowserRequest) => Promise<BrowserResult>;
  validateSource?: (source: MediaJobSource, job?: MediaJob) => void | Promise<void>;
  validateInput?: (assetId: string, source: MediaJobSource) => void | Promise<void>;
  onChanged?: () => void | Promise<void>;
  onCompleted?: (job: MediaJob) => void | Promise<void>;
  onSettled?: (job: MediaJob) => void | Promise<void>;
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
}
interface OutputReceipt { name: string; mimeType: string; file?: string; url?: string }
interface StoredMediaJob extends MediaJob {
  fingerprint: string;
  connection: MediaConnectionView;
  submitted?: boolean;
  outputs?: OutputReceipt[];
  settledVersion?: number;
  notifiedSettledVersion?: number;
  originalRunEpoch?: number;
}
export interface MediaJobsState { jobs: Record<string, StoredMediaJob>; operations: Record<string, string> }
export const MocoMediaJobsDoc = defineDoc<MediaJobsState & JsonObject>({
  kind: "moco.media-jobs", version: 1, scope: "session",
  initial: () => ({ jobs: {}, operations: {} }) as MediaJobsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class MediaJobError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "MediaJobError"; }
}
const context = BACKGROUND_CONTEXT;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;
const active = new Set<MediaJob["status"]>(["queued", "submitting", "running", "collecting"]);
const settled = new Set<MediaJob["status"]>(["failed", "stopped", "needs_user", "needs_reconciliation"]);
function publicJob(value: StoredMediaJob): MediaJob {
  const { fingerprint: _fingerprint, connection: _connection, submitted: _submitted, outputs: _outputs, settledVersion: _settledVersion, notifiedSettledVersion: _notified, originalRunEpoch: _originalRunEpoch, ...job } = clone(value);
  return job;
}
function operationKey(request: MediaJobRequest): string {
  return JSON.stringify([request.source.ticketId ? `ticket:${request.source.ticketId}` : `conversation:${request.source.conversationId}`, request.operationId]);
}
function fingerprint(request: MediaJobRequest): string {
  const source = request.source.ticketId
    ? { ticketId: request.source.ticketId, topicId: request.source.topicId, projectId: request.source.projectId }
    : { conversationId: request.source.conversationId, topicId: request.source.topicId, projectId: request.source.projectId };
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify({
    capabilityId: request.capabilityId ?? null, kind: request.kind, prompt: request.prompt.trim(),
    inputAssetIds: request.inputAssetIds ?? [], format: request.format ?? null,
    aspectRatio: request.aspectRatio ?? null, quality: request.quality ?? null,
    durationSeconds: request.durationSeconds ?? null, count: request.count ?? 1, source,
    ...(request.parameters !== undefined ? { parameters: canonical(request.parameters) } : {}),
    ...(request.intent !== undefined ? { intent: request.intent } : {}),
    ...(request.preference !== undefined ? { preference: request.preference } : {}),
    ...(request.source.setupClientId !== undefined ? { setupClientId: request.source.setupClientId } : {}),
  })).digest("hex");
}
function safeError(error: unknown): string {
  return error instanceof MediaAdapterError || error instanceof MediaJobError || error instanceof CapabilityError
    ? error.message : "媒体执行失败，请检查连接后继续原作业。";
}
function sameConnection(a: MediaConnectionView, b: MediaConnectionView): boolean {
  return a.id === b.id && a.adapter === b.adapter && a.baseUrl === b.baseUrl && a.origin === b.origin
    && a.browserEnvId === b.browserEnvId && a.profileRef === b.profileRef && JSON.stringify(a.customAdapter ?? null) === JSON.stringify(b.customAdapter ?? null);
}
function flowModelLabel(value: string): string { return value.toLowerCase().replace(/[\s-]+/g, ""); }
const flowDefaultModels = new Set(["auto", "default", "flow", "flowauto", "flowdefault", "默认", "网页默认", "flow默认", "flow网页默认"]);

export class MocoMediaJobs {
  readonly #options: MediaJobsOptions;
  readonly #work = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #controllers = new Map<string, AbortController>();
  #tail: Promise<unknown> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(options: MediaJobsOptions) { this.#options = options; }

  async #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run, run);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
  async #stored(id: string): Promise<StoredMediaJob> {
    const doc = await this.#options.harness.snapshot(MocoMediaJobsDoc, context);
    const value = own(doc?.jobs, id);
    if (!value) throw new MediaJobError(404, "media_job_not_found", "媒体作业不存在。");
    return clone(value);
  }
  async #change(id: string, update: (value: StoredMediaJob) => void): Promise<StoredMediaJob> {
    const result = await this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(MocoMediaJobsDoc);
      const job = own(state.jobs, id);
      if (!job) throw new MediaJobError(404, "media_job_not_found", "媒体作业不存在。");
      const previousStatus = job.status;
      update(job);
      if (job.status !== previousStatus && settled.has(job.status)) job.settledVersion = (job.settledVersion ?? 0) + 1;
      job.updatedAt = Date.now();
      return clone(job);
    }, context);
    await this.#options.onChanged?.();
    return result;
  }
  async start(): Promise<void> {
    if (this.#started && !this.#closed) return;
    this.#closed = false;
    this.#started = true;
    const state = await this.#options.harness.snapshot(MocoMediaJobsDoc, context);
    for (const record of Object.values(state?.jobs ?? {})) {
      if (record.status === "submitting") {
        await this.#change(record.id, (job) => {
          job.status = "needs_reconciliation";
          job.error = "提交期间连接中断，请核实原作业后继续，不能直接重复生成。";
        });
        if (this.#options.onSettled) this.#kick(record.id);
      } else if (active.has(record.status) || record.status === "completed" && !record.deliveredAt
        || this.#options.onSettled && settled.has(record.status) && record.settledVersion !== record.notifiedSettledVersion) this.#kick(record.id);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const controller of this.#controllers.values()) controller.abort();
    await Promise.allSettled([...this.#work.values()]);
    await this.#tail;
  }
  async drain(): Promise<void> {
    while (this.#work.size) await Promise.all([...this.#work.values()]);
  }
  async get(id: string): Promise<MediaJob> { return publicJob(await this.#stored(id)); }
  async recoveryConnection(id: string): Promise<MediaConnectionView> {
    // A recovery candidate is not authorization; callers must explicitly recreate the managed connection.
    return clone((await this.#stored(id)).connection);
  }
  async list(source?: { conversationId?: number; ticketId?: string }): Promise<MediaJob[]> {
    const doc = await this.#options.harness.snapshot(MocoMediaJobsDoc, context);
    return Object.values(doc?.jobs ?? {})
      .filter((job) => !source || (source.conversationId === undefined || job.source.conversationId === source.conversationId)
        && (source.ticketId === undefined || job.source.ticketId === source.ticketId))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(publicJob);
  }
  async create(input: MediaJobRequest): Promise<MediaJob> {
    const request = clone(input);
    this.#validateRequest(request);
    return this.#serial(async () => {
      const state = await this.#options.harness.snapshot(MocoMediaJobsDoc, context);
      const key = operationKey(request);
      const hash = fingerprint(request);
      const previousId = own(state?.operations, key);
      if (previousId) {
        const previous = own(state?.jobs, previousId);
        if (!previous || previous.fingerprint !== hash) throw new MediaJobError(409, "media_operation_conflict", "此生成意图已用于不同请求，请查询原作业；新版本需使用新意图。");
        return publicJob(previous);
      }
      await this.#options.validateSource?.(request.source);
      const desiredFormat = request.format ?? request.parameters?.format ?? (request.intent === "animate" ? "gif" : request.intent === "vector" ? "svg" : undefined);
      const { capability, connection, selectionReason } = await this.#options.capabilities.resolve(request.capabilityId, request.kind, desiredFormat, request);
      if (!request.source.setupClientId && !capability.allowTaskGeneration) throw new MediaJobError(403, "media_task_generation_not_allowed", "尚未允许此能力按需生成，请通过右侧对话授权后继续。");
      const explicit: ImageGenerationParameters = { ...request.parameters,
        ...(request.format !== undefined ? { format: request.format } : {}), ...(request.count !== undefined ? { count: request.count } : {}),
        ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}), ...(request.quality !== undefined ? { quality: request.quality } : {}) };
      if (connection.adapter === "gemini-image" && explicit.quality && ["0.5K", "1K", "2K", "4K"].includes(explicit.quality)) { explicit.size = explicit.quality; delete explicit.quality; }
      const parameters = request.kind === "image" ? mergeImageGenerationParameters(capability.defaults, { ...explicit, ...(desiredFormat ? { format: desiredFormat } : {}) }) : undefined;
      const count = parameters?.count ?? request.count ?? 1;
      if (count > capability.maxOutputs) throw new MediaJobError(400, "media_output_limit", `此能力每次最多生成 ${capability.maxOutputs} 个结果。`);
      if (request.inputAssetIds?.length && !capability.supportsEdit) throw new MediaJobError(400, "media_edit_unsupported", "此能力不支持参考素材或编辑。");
      const format = desiredFormat ?? parameters?.format ?? capability.formats[0];
      if (!format || !capability.formats.includes(format)) throw new MediaJobError(400, "media_format_unsupported", "此能力不支持请求的输出格式。");
      if (request.kind === "video" && count !== 1) throw new MediaJobError(400, "media_output_limit", "每个视频作业只生成一个结果。");
      const profile = capability.imageProfile ?? getImageModelProfile(connection.adapter, capability.modelId);
      if (request.inputAssetIds?.length && profile && request.inputAssetIds.length > profile.maxReferences) throw new MediaJobError(400, "media_reference_limit", `此模型最多支持${profile.maxReferences}张参考图。`);
      if (parameters && profile) {
        parameters.format = format; parameters.count = count;
        try { Object.assign(parameters, normalizeImageGenerationParameters(parameters, profile, connection.adapter)); }
        catch (cause) { throw new MediaJobError(400, parameters.quality && !profile.qualities?.includes(parameters.quality) ? "invalid_quality" : "invalid_image_parameters", cause instanceof Error ? cause.message : "图像参数无效。"); }
      }
      for (const id of request.inputAssetIds ?? []) await this.#input(id, request.source, connection.adapter === "flow-browser");
      const now = Date.now();
      const record: StoredMediaJob = {
        id: `media_${randomUUID().replaceAll("-", "")}`, operationId: request.operationId,
        capabilityId: capability.id, capabilityRevision: capability.revision,
        connectionId: connection.id, adapter: connection.adapter, modelId: capability.modelId,
        kind: request.kind, prompt: request.prompt.trim(), inputAssetIds: request.inputAssetIds ?? [],
        format, count, source: request.source, status: "queued", assets: [],
        ...(parameters ? { parameters } : {}), ...(profile ? { imageProfile: clone(profile) } : {}),
        ...(request.intent ? { intent: request.intent } : {}), ...(request.preference ? { preference: request.preference } : {}), ...(selectionReason ? { selectionReason } : {}),
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
        ...(parameters?.quality ? { quality: parameters.quality } : {}),
        ...(request.durationSeconds ? { durationSeconds: request.durationSeconds } : {}),
        createdAt: now, updatedAt: now, fingerprint: hash, connection: clone(connection),
      };
      validateImageParameters(record);
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(MocoMediaJobsDoc);
        doc.jobs[record.id] = record;
        doc.operations[key] = record.id;
      }, context);
      await this.#options.onChanged?.();
      if (this.#started && !this.#closed) this.#kick(record.id);
      return publicJob(record);
    });
  }
  #validateRequest(request: MediaJobRequest): void {
    if (typeof request.operationId !== "string" || !request.operationId.trim() || request.operationId.length > 180
      || /[\x00-\x1f\x7f]/.test(request.operationId)
      || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 32_000
      || !["image", "video"].includes(request.kind) || !request.source || !Number.isSafeInteger(request.source.conversationId)
      || request.source.conversationId < 1 || typeof request.source.topicId !== "string" || !request.source.topicId || request.source.topicId.length > 180) {
      throw new MediaJobError(400, "invalid_media_request", "生成请求缺少有效意图、内容或来源。");
    }
    if (request.inputAssetIds !== undefined && (!Array.isArray(request.inputAssetIds) || request.inputAssetIds.length > 16
      || request.inputAssetIds.some((id) => typeof id !== "string") || new Set(request.inputAssetIds).size !== request.inputAssetIds.length)) {
      throw new MediaJobError(400, "invalid_media_references", "参考资源无效、重复或数量超过限制。");
    }
    if (request.intent === "edit" && !request.inputAssetIds?.length) throw new MediaJobError(400, "media_edit_reference_required", "编辑图片需要参考图。");
    const format = request.format ?? request.parameters?.format;
    if (request.intent === "animate" && format !== undefined && format !== "gif" || request.intent === "vector" && format !== undefined && format !== "svg") throw new MediaJobError(400, "media_intent_format_mismatch", "生成用途与图片格式不一致。");
    if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > 10)) throw new MediaJobError(400, "invalid_media_count", "生成数量必须为 1 到 10。");
    if (request.source.setupClientId !== undefined && (typeof request.source.setupClientId !== "string" || !request.source.setupClientId || request.source.setupClientId.length > 180 || !this.#options.validateSource)) throw new MediaJobError(403, "media_setup_scope_invalid", "试生成需要有效的设置窗口。");
    if (request.intent !== undefined && !["generate", "edit", "animate", "vector"].includes(request.intent) || request.preference !== undefined && !["balanced", "speed", "quality", "cost"].includes(request.preference)) throw new MediaJobError(400, "invalid_media_intent", "图像用途或偏好无效。");
    if (request.parameters !== undefined && (!request.parameters || typeof request.parameters !== "object" || Array.isArray(request.parameters) || JSON.stringify(request.parameters).length > 16000)) throw new MediaJobError(400, "invalid_media_parameters", "图像参数无效或过长。");
    if (request.kind === "video" && (request.aspectRatio !== undefined || request.quality !== undefined || request.parameters !== undefined || request.intent !== undefined || request.preference !== undefined)) {
      throw new MediaJobError(400, "media_video_parameters_unsupported", "当前 Flow 视频生成仅支持网页默认画幅和质量，尚未提交。");
    }
    if (request.durationSeconds !== undefined && (request.kind !== "video" || !Number.isInteger(request.durationSeconds) || request.durationSeconds < 1 || request.durationSeconds > 60)) {
      throw new MediaJobError(400, "invalid_media_duration", "视频时长必须为 1 到 60 秒，并符合当前网页模型的限制。");
    }
  }
  async #input(id: string, source: MediaJobSource, allowVideo = false): Promise<MediaInput> {
    await this.#options.validateInput?.(id, source);
    const loaded = this.#options.uploads.getUpload(id);
    const scopes = new Set([`conversation:${source.conversationId}`, `topic:${source.topicId}`, ...(source.ticketId ? [`ticket:${source.ticketId}`] : [])]);
    if (!loaded || !this.#options.validateInput && !this.#options.uploads.canReadUpload(id, `agent:${source.conversationId}`, (scope) => scopes.has(scope))) {
      throw new MediaJobError(403, "media_reference_forbidden", "没有权限读取此参考资源。");
    }
    if (loaded.record.kind !== "image" && !(allowVideo && loaded.record.kind === "video")) throw new MediaJobError(400, "media_reference_type", "参考资源需要可用图片或此能力支持的视频。");
    return { id, name: loaded.record.name, mimeType: loaded.record.mimeType, bytes: this.#options.uploads.readUploadBytes(loaded) };
  }
  async resume(id: string, currentSource?: MediaJobSource): Promise<MediaJob> {
    const job = await this.#stored(id);
    if (job.status === "stopped" || job.status === "failed") throw new MediaJobError(409, "media_job_terminal", "该作业已停止或失败；再次生成需明确创建新意图。");
    if (job.status === "needs_reconciliation" && job.adapter !== "flow-browser" && !(job.adapter === "custom-image" && job.remoteId && job.connection.customAdapter?.poll)) throw new MediaJobError(409, "media_submission_unknown", "原图片提交结果尚未确认，不能自动重新生成。");
    const source = currentSource ? clone(currentSource) : undefined;
    if (source) {
      if (source.topicId !== job.source.topicId || source.ticketId && source.ticketId !== job.source.ticketId) {
        throw new MediaJobError(403, "media_job_forbidden", "不能使用其他会话或工单的执行资格继续此作业。");
      }
      if (source.ticketId) {
        if (source.projectId !== job.source.projectId || source.envId !== job.source.envId || !Number.isSafeInteger(source.runEpoch) || Number(source.runEpoch) < 1) {
          throw new MediaJobError(403, "media_resume_scope_mismatch", "所属执行位置或资格已改变，不能自动转移原生成作业。");
        }
        if (!this.#options.validateSource) throw new MediaJobError(403, "media_resume_scope_unverified", "无法核验当前工单执行资格，未继续生成。");
        // Validate the current live run, not the old job's waiting exception.
        await this.#options.validateSource(source);
      } else {
        await this.#options.validateSource?.(source);
        if (job.source.ticketId && !job.submitted && !job.outputs) throw new MediaJobError(403, "media_worker_resume_required", "请由所属工单的当前 Worker 继续此未提交作业。");
      }
    }
    await this.#change(id, (value) => {
      if (value.status === "stopped" || value.status === "failed") throw new MediaJobError(409, "media_job_terminal", "该作业已经结束，不能继续。");
      if (value.status === "completed") return;
      if (source?.ticketId) {
        if (value.source.ticketId !== source.ticketId || value.source.topicId !== source.topicId
          || value.source.projectId !== source.projectId || value.source.envId !== source.envId
          || value.source.runEpoch !== undefined && value.source.runEpoch > source.runEpoch!) {
          throw new MediaJobError(409, "media_resume_scope_changed", "工单执行资格已被更新，请重新读取原作业。");
        }
        value.originalRunEpoch ??= value.source.runEpoch;
        value.source.runEpoch = source.runEpoch;
      }
      value.status = value.outputs ? "collecting" : value.submitted ? "running" : "queued";
      delete value.error;
    });
    if (this.#started && !this.#closed) this.#kick(id);
    return this.get(id);
  }
  async stop(id: string): Promise<MediaJob> {
    const job = await this.#stored(id);
    if (job.status === "completed" || job.status === "stopped") return publicJob(job);
    await this.#change(id, (value) => {
      if (value.status === "completed" || value.status === "stopped") return;
      value.status = "stopped";
      value.error = value.submitted ? "已停止 Moco 后续处理；外部已提交的生成可能仍在进行。" : "已停止，未继续提交。";
      delete value.nextPollAt;
    });
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    this.#controllers.get(id)?.abort();
    if (job.adapter === "flow-browser" && job.connection.browserEnvId && job.connection.profileRef) {
      try { await this.#options.browser(job.connection.browserEnvId, { action: "stop", profileRef: job.connection.profileRef, jobId: id }); }
      catch { /* The durable stopped state still fences late results; the browser may be offline. */ }
    }
    await this.#notifySettled(await this.#stored(id));
    return this.get(id);
  }
  async markDelivered(id: string): Promise<void> {
    await this.#change(id, (job) => {
      if (job.status !== "completed") throw new MediaJobError(409, "media_not_complete", "媒体尚未完成。");
      job.deliveredAt ??= Date.now();
      delete job.error;
    });
  }
  #kick(id: string): void {
    if (this.#closed || this.#work.has(id)) return;
    const work = Promise.resolve().then(() => this.#run(id));
    this.#work.set(id, work);
    void work.finally(() => { this.#work.delete(id); }).catch(() => undefined);
  }
  #later(id: string, delay?: number): void {
    if (this.#closed || this.#timers.has(id)) return;
    const timer = setTimeout(() => { this.#timers.delete(id); this.#kick(id); }, delay ?? this.#options.pollIntervalMs ?? 5000);
    timer.unref?.();
    this.#timers.set(id, timer);
  }
  async #run(id: string): Promise<void> {
    if (this.#closed) return;
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    try {
      let job = await this.#stored(id);
      if (job.status === "queued") await this.#submit(job, controller.signal);
      else if (job.status === "running") await this.#poll(job, controller.signal);
      job = await this.#stored(id);
      if (job.status === "completed" || job.status === "stopped") this.#removeStaging(job.id);
      if (job.status === "collecting") await this.#collect(job, controller.signal);
      job = await this.#stored(id);
      if (job.status === "completed" || job.status === "stopped") this.#removeStaging(job.id);
      if (job.status === "completed" && !job.deliveredAt && this.#options.onCompleted) {
        try { await this.#options.onCompleted(publicJob(job)); }
        catch { await this.#change(id, (value) => { value.error = "产物已保存，结果投递失败，等待重试。"; }); this.#later(id); }
      }
      if (settled.has(job.status)) await this.#notifySettled(job);
      if (job.status === "running") this.#later(id, job.adapter === "custom-image" ? Math.max(1000, (job.nextPollAt ?? Date.now() + 5000) - Date.now()) : undefined);
    } catch (error) {
      if (this.#closed) return;
      const current = await this.#stored(id);
      if (current.status === "stopped") return;
      const changed = await this.#change(id, (job) => {
        job.error = safeError(error);
        job.status = error instanceof MediaJobError && error.code === "media_source_revoked" ? "stopped"
          : error instanceof MediaJobError && ["media_connection_unavailable", "media_connection_changed"].includes(error.code)
            || error instanceof CapabilityError && ["media_credential_missing", "connection_not_found"].includes(error.code) ? "needs_user"
          : current.status === "collecting" ? "needs_user"
          : error instanceof MediaAdapterError && error.uncertain ? "needs_reconciliation"
          : current.submitted ? "failed" : "needs_user";
      });
      await this.#notifySettled(changed);
    } finally { this.#controllers.delete(id); }
  }
  async #submit(job: StoredMediaJob, signal: AbortSignal): Promise<void> {
    const { capability, connection } = await this.#options.capabilities.resolve(job.capabilityId, job.kind, job.format);
    if (!sameConnection(job.connection, connection) || capability.modelId !== job.modelId || capability.connectionId !== job.connectionId) {
      throw new MediaJobError(409, "media_connection_changed", "生成连接或模型已改变，请核对原作业。");
    }
    const inputs: MediaInput[] = [];
    let total = 0;
    for (const id of job.inputAssetIds) {
      const asset = await this.#input(id, job.source, job.adapter === "flow-browser");
      total += asset.bytes.length;
      if (total > MAX_MESSAGE_UPLOAD_BYTES) throw new MediaJobError(400, "media_references_too_large", "参考素材总大小超过限制。");
      inputs.push(asset);
    }
    if (job.adapter === "flow-browser") {
      const envId = connection.browserEnvId!;
      const profileRef = connection.profileRef!;
      if (!envId || !profileRef) throw new MediaJobError(409, "media_browser_missing", "Flow 浏览器连接尚未完成。");
      for (const asset of inputs) {
        for (let offset = 0; offset < asset.bytes.length; offset += 256 * 1024) {
          const chunk = asset.bytes.subarray(offset, Math.min(offset + 256 * 1024, asset.bytes.length));
          await this.#options.browser(envId, { action: "upload", profileRef, jobId: job.id, assetId: asset.id, name: asset.name, mimeType: asset.mimeType, data: chunk.toString("base64"), offset, final: offset + chunk.length === asset.bytes.length });
        }
      }
      let current = await this.#stored(job.id);
      if (current.status === "stopped" || this.#closed) return;
      const intent = { profileRef, jobId: job.id, prompt: job.prompt, modelId: job.modelId, durationSeconds: job.durationSeconds, referenceIds: job.inputAssetIds };
      let prepared: BrowserResult;
      try { prepared = await this.#options.browser(envId, { action: "prepare", ...intent }); }
      catch { throw new MediaJobError(409, "media_browser_prepare_failed", "Flow 准备中断，尚未批准生成；处理后可继续原作业。"); }
      current = await this.#stored(job.id);
      if (current.status === "stopped" || this.#closed) return;
      if (prepared.jobId !== job.id || prepared.profileRef !== profileRef) {
        throw new MediaJobError(409, "media_browser_prepare_mismatch", "Flow 准备结果与原作业或会话不一致，未批准生成。");
      }
      if (prepared.submitted === true) {
        // A prepare call must not spend. If the Env reports prior acceptance, only reconcile it.
        await this.#change(job.id, (value) => { if (value.status !== "stopped") value.submitted = true; });
        throw new MediaAdapterError("submission_unknown", "Flow 准备结果显示作业已提交，请核实原作业，不能再次批准。", true);
      }
      this.#validatePrepared(current, prepared);
      if (!await this.#claimSubmission(current)) return;
      if (signal.aborted || this.#closed) return;
      let result: BrowserResult;
      try { result = await this.#options.browser(envId, { action: "submit", ...intent }); }
      catch { throw new MediaAdapterError("submission_unknown", "Flow 提交中断，请先核实原作业，不能重复点击生成。", true); }
      await this.#browserResult(job.id, result, true);
    } else {
      const apiKey = await this.#options.capabilities.apiKey(connection.id, connection.origin);
      const current = await this.#stored(job.id);
      if (current.status === "stopped" || this.#closed) return;
      if (!await this.#claimSubmission(current)) return;
      let outputs: ImageOutput[];
      if (job.adapter === "custom-image") {
        const result = await customImageRequest({ job, connection, apiKey, inputs, signal, fetcher: this.#options.fetcher });
        if (result.status === "running") {
          await this.#change(job.id, (value) => { value.remoteId = result.remoteId; value.nextPollAt = result.nextPollAt; if (value.status !== "stopped") value.status = "running"; });
          return;
        }
        outputs = result.outputs;
      } else outputs = await generateImage({ job, connection, apiKey, inputs, signal, fetcher: this.#options.fetcher });
      const receipts = this.#stageOutputs(job.id, outputs);
      await this.#change(job.id, (value) => {
        value.outputs = receipts;
        if (value.status !== "stopped") value.status = "collecting";
      });
    }
  }
  #validatePrepared(job: StoredMediaJob, result: BrowserResult): void {
    if (result.status === "needs_login") throw new MediaJobError(409, "media_browser_login_required", "Flow 需要在浏览器所在设备完成登录，尚未批准生成。");
    if (result.status !== "ready" || result.prepared !== true) {
      throw new MediaJobError(409, "media_browser_not_prepared", "Flow 尚未准备好原生生成确认卡；处理后可继续原作业。");
    }
    const quote = result.quote;
    if (!quote || !Number.isFinite(quote.credits) || quote.credits < 0 || quote.credits > Number.MAX_SAFE_INTEGER || quote.outputs !== 1 || quote.outputs !== job.count
      || quote.durationSeconds !== undefined && (!Number.isInteger(quote.durationSeconds) || quote.durationSeconds < 1 || quote.durationSeconds > 60)
      || quote.modelId !== undefined && (typeof quote.modelId !== "string" || !quote.modelId.trim() || quote.modelId.length > 240)) {
      throw new MediaJobError(409, "media_browser_invalid_quote", "Flow 原生确认卡未提供有效点数和单个结果，未批准生成。");
    }
    if (job.durationSeconds !== undefined && quote.durationSeconds !== job.durationSeconds) {
      throw new MediaJobError(409, "media_browser_quote_duration_mismatch", "Flow 原生确认卡无法核对请求的视频时长，未批准生成。");
    }
    if (!flowDefaultModels.has(flowModelLabel(job.modelId)) && (!quote.modelId || flowModelLabel(quote.modelId) !== flowModelLabel(job.modelId))) {
      throw new MediaJobError(409, "media_browser_quote_model_mismatch", "Flow 原生确认卡无法核对请求的模型，未批准生成。");
    }
  }
  async #claimSubmission(job: StoredMediaJob): Promise<boolean> {
    // References and native confirmation preparation may await another device; recheck at approval.
    const { capability, connection } = await this.#options.capabilities.resolve(job.capabilityId, job.kind, job.format);
    if (!sameConnection(job.connection, connection) || capability.modelId !== job.modelId) throw new MediaJobError(409, "media_connection_changed", "生成连接或模型已改变，请核对原作业。");
    if (!job.source.setupClientId && !capability.allowTaskGeneration) throw new MediaJobError(403, "media_task_generation_not_allowed", "尚未允许此能力按需生成，请通过右侧对话授权后继续。");
    if (job.count > capability.maxOutputs) throw new MediaJobError(409, "media_output_limit", "生成数量上限已改变，原作业尚未提交。");
    await this.#options.validateSource?.(job.source, publicJob(job));
    let accepted = false;
    await this.#change(job.id, (value) => {
      if (value.status !== "queued" || this.#closed) return;
      value.status = "submitting";
      value.submitted = true;
      accepted = true;
    });
    return accepted;
  }
  async #notifySettled(job: StoredMediaJob): Promise<void> {
    if (!this.#options.onSettled || !settled.has(job.status) || job.settledVersion === job.notifiedSettledVersion) return;
    try {
      await this.#options.onSettled(publicJob(job));
      await this.#change(job.id, (current) => {
        if (current.status === job.status && current.settledVersion === job.settledVersion) current.notifiedSettledVersion = job.settledVersion;
      });
    } catch { this.#later(job.id); }
  }
  async #browserResult(id: string, result: BrowserResult, submitting = false): Promise<void> {
    if (result.jobId !== undefined && result.jobId !== id) throw new MediaAdapterError("browser_job_mismatch", "浏览器返回了其他作业的结果。", true);
    await this.#change(id, (job) => {
      if (job.status === "stopped") return;
      if (result.profileRef !== job.connection.profileRef) throw new MediaAdapterError("browser_profile_mismatch", "浏览器返回了其他连接的结果。", true);
      if (result.remoteId) job.remoteId = result.remoteId;
      if (result.remoteUrl) {
        const url = new URL(result.remoteUrl);
        if (["https://labs.google", "https://flow.google.com"].includes(url.origin) && !url.username && !url.password && !url.search && !url.hash) job.remoteUrl = url.toString();
      }
      if (result.status === "completed") job.status = "collecting";
      else if (result.status === "running") { job.status = "running"; delete job.error; }
      else if (result.status === "needs_login") {
        job.status = "needs_user"; job.error = "Flow 需要在浏览器所在设备完成登录。";
        if (submitting) delete job.submitted;
      } else if (result.status === "stopped") { job.status = "stopped"; job.error = "浏览器已停止后续处理。"; }
      else if (result.submitted === false) {
        job.status = "needs_user"; delete job.submitted;
        job.error = "Flow 页面需要处理，尚未提交生成；处理后可继续原作业。";
      } else { job.status = "needs_reconciliation"; job.error = "Flow 作业结果需要在原浏览器页面核实。"; }
    });
  }
  async #poll(job: StoredMediaJob, signal?: AbortSignal): Promise<void> {
    if (job.adapter === "custom-image" && job.remoteId && job.connection.customAdapter?.poll) {
      const connection = await this.#options.capabilities.connection(job.connectionId);
      if (!sameConnection(connection, job.connection)) throw new MediaJobError(409, "media_connection_changed", "原图像接口已改变，请恢复原配置后继续取回作业。");
      const apiKey = await this.#options.capabilities.apiKey(connection.id, connection.origin);
      try {
        const result = await customImageRequest({ job, connection, apiKey, remoteId: job.remoteId, signal, fetcher: this.#options.fetcher });
        if (result.status === "running") await this.#change(job.id, (value) => { value.nextPollAt = result.nextPollAt; delete value.error; });
        else {
          const outputs = this.#stageOutputs(job.id, result.outputs);
          await this.#change(job.id, (value) => { value.outputs = outputs; if (value.status !== "stopped") value.status = "collecting"; });
        }
      } catch (cause) {
        if (cause instanceof MediaAdapterError && cause.code === "custom_poll_failed") {
          await this.#change(job.id, (value) => { value.error = cause.message; value.nextPollAt = Date.now() + (connection.customAdapter?.poll?.intervalMs ?? 5000); });
          return;
        }
        if (cause instanceof MediaAdapterError && cause.code === "custom_poll_auth") throw new MediaJobError(409, "media_connection_unavailable", "原图像作业需要重新连接授权，未重复生成。");
        throw cause;
      }
      return;
    }
    if (job.adapter !== "flow-browser") throw new MediaAdapterError("submission_unknown", "图片生成状态未知，需要核实原请求。", true);
    const connection = await this.#flowConnection(job);
    let result: BrowserResult;
    try { result = await this.#options.browser(connection.browserEnvId!, { action: "poll", profileRef: connection.profileRef!, jobId: job.id }); }
    catch {
      await this.#change(job.id, (value) => { if (value.status !== "stopped") value.error = "暂时无法查询浏览器，等待设备连接恢复。"; });
      return;
    }
    await this.#browserResult(job.id, result);
  }
  async #flowConnection(job: StoredMediaJob): Promise<MediaConnectionView> {
    let connection: MediaConnectionView;
    try { connection = await this.#options.capabilities.connection(job.connectionId); }
    catch (error) {
      if (error instanceof CapabilityError && error.code === "connection_not_found") {
        throw new MediaJobError(409, "media_connection_unavailable", "原 Flow 浏览器连接已移除，请通过右侧对话恢复原设备和会话后，继续取回本作业。");
      }
      throw error;
    }
    if (!sameConnection(connection, job.connection)) throw new MediaJobError(409, "media_connection_changed", "Flow 浏览器连接已改变，请恢复原设备和会话后继续取回本作业。");
    return connection;
  }
  #stageDirectory(id: string): string {
    if (!/^media_[a-f0-9]{32}$/.test(id)) throw new MediaJobError(400, "invalid_media_id", "媒体作业标识无效。");
    const directory = path.join(this.#options.uploads.dir, ".media-jobs", id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  #stageOutputs(id: string, outputs: ImageOutput[]): OutputReceipt[] {
    return outputs.map((output, index) => {
      if ("url" in output) return { name: output.name, mimeType: output.mimeType, url: output.url };
      const file = `${index}.bin`;
      fs.writeFileSync(path.join(this.#stageDirectory(id), file), output.bytes, { mode: 0o600 });
      return { name: output.name, mimeType: output.mimeType, file };
    });
  }
  #removeStaging(id: string): void {
    if (!/^media_[a-f0-9]{32}$/.test(id)) throw new MediaJobError(400, "invalid_media_id", "媒体作业标识无效。");
    fs.rmSync(path.join(this.#options.uploads.dir, ".media-jobs", id), { recursive: true, force: true });
  }
  async #collect(job: StoredMediaJob, signal: AbortSignal): Promise<void> {
    const artifacts: Array<{ name: string; mimeType: string; stream: AsyncIterable<Uint8Array> }> = [];
    if (job.adapter === "flow-browser") {
      const connection = await this.#flowConnection(job);
      const result = await this.#options.browser(connection.browserEnvId!, { action: "download", profileRef: connection.profileRef!, jobId: job.id });
      if (result.profileRef !== connection.profileRef || result.jobId !== undefined && result.jobId !== job.id || !result.file
        || !Number.isSafeInteger(result.file.size) || result.file.size < 1 || result.file.size > MAX_VIDEO_UPLOAD_BYTES || result.file.mimeType !== "video/mp4") {
        throw new MediaAdapterError("invalid_browser_download", "Flow 尚未提供可取回的 MP4 产物。", true);
      }
      const browser = this.#options.browser;
      const file = result.file;
      artifacts.push({ name: file.name, mimeType: file.mimeType, stream: (async function* () {
        let offset = 0;
        while (offset < file.size) {
          if (signal.aborted) throw new MediaJobError(499, "media_cancelled", "产物取回已停止。");
          const length = Math.min(256 * 1024, file.size - offset);
          const next = await browser(connection.browserEnvId!, { action: "read", profileRef: connection.profileRef!, jobId: job.id, offset, length });
          if (next.profileRef !== connection.profileRef || next.jobId !== undefined && next.jobId !== job.id || next.offset !== undefined && next.offset !== offset) throw new MediaAdapterError("invalid_browser_download", "浏览器下载位置不匹配。", true);
          const bytes = decodeMediaBase64(next.data, length);
          if (bytes.length > length) throw new MediaAdapterError("invalid_browser_download", "浏览器返回的下载数据超过请求范围。", true);
          offset += bytes.length;
          yield bytes;
        }
      })() });
    } else {
      if (!job.outputs?.length) throw new MediaAdapterError("missing_receipt", "缺少已生成结果的取回记录，不能重新提交。", true);
      for (const receipt of job.outputs) {
        let bytes: Buffer;
        if (receipt.file && /^\d+\.bin$/.test(receipt.file)) bytes = fs.readFileSync(path.join(this.#stageDirectory(job.id), receipt.file));
        else if (receipt.url && job.connection.origin) bytes = await downloadImageOutput(receipt.url, job.connection.origin, signal, this.#options.fetcher, job.connection.customAdapter?.outputOrigins);
        else throw new MediaAdapterError("missing_receipt", "已生成结果的取回记录无效。", true);
        if (bytes.length > MAX_UPLOAD_BYTES) throw new MediaAdapterError("result_too_large", "生成图片超过资源大小限制。", true);
        artifacts.push({ name: receipt.name, mimeType: receipt.mimeType, stream: (async function* () { yield bytes; })() });
      }
    }
    const assets: ChatAttachment[] = [];
    for (const [index, artifact] of artifacts.entries()) {
      if ((await this.#stored(job.id)).status === "stopped" || this.#closed) return;
      const attachment = await this.#options.uploads.saveUploadStream({
        ...artifact, ownerId: `agent:${job.source.conversationId}`, signal,
        idempotencyKey: `media-job:${job.id}:${index}`,
      });
      if (attachment.mimeType !== MEDIA_OUTPUT_MIMES[job.format]
        || job.kind === "video" && attachment.kind !== "video" || job.kind === "image" && attachment.kind !== "image" && attachment.mimeType !== "image/svg+xml") {
        throw new MediaAdapterError("result_type_mismatch", "生成结果文件类型与请求不一致。", true);
      }
      this.#options.uploads.bindAttachments([attachment], `conversation:${job.source.conversationId}`, `agent:${job.source.conversationId}`, (scope) => scope === `conversation:${job.source.conversationId}`);
      assets.push(attachment);
    }
    await this.#options.capabilities.markGenerated?.(job.capabilityId, job.capabilityRevision);
    await this.#change(job.id, (value) => {
      if (value.status === "stopped") return;
      value.assets = assets;
      value.status = "completed";
      delete value.outputs;
      delete value.error;
      delete value.nextPollAt;
    });
  }
}
