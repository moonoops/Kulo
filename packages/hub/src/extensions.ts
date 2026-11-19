import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Harness, type JsonObject, type TaskId } from "@earendil-works/pi-durable";
import { redactSecrets, type ExtensionJob, type ExtensionOperationRequest, type ExtensionRecord, type ExtensionWorkspaceSnapshot } from "@kulo/protocol";
import { analyzeExtensionSource, type ExtensionSourceAnalysis } from "./extension-sources.js";
import { BILLION_CONTEXT_ADAPTER_VERSION, BILLION_CONTEXT_KERNEL_VERSION, BILLION_CONTEXT_PACKAGE_SOURCE, ExtensionPackageError,
  inspectBillionContextPackage, installBillionContextPackage, removeBillionContextPackage, type ExtensionPackageInfo } from "./extension-packages.js";

interface StoredJob { view: ExtensionJob; fingerprint: string; expectedRevision: number }
interface ExtensionsState { revision: number; items: Record<string, ExtensionRecord>; jobs: Record<string, StoredJob> }
const context = BACKGROUND_CONTEXT;
const ID = "billion-context";
const ACTIVE = new Set<ExtensionJob["status"]>(["queued", "running"]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = <T>(values: Readonly<Record<string, T>> | undefined, key: string): T | undefined => values && Object.hasOwn(values, key) ? values[key] : undefined;
function initialRecord(): ExtensionRecord {
  return { id: ID, name: "Billion Context 上下文压缩", sourceUrl: BILLION_CONTEXT_PACKAGE_SOURCE, packageName: "acp-kernel",
    availableVersion: BILLION_CONTEXT_KERNEL_VERSION, adapterVersion: BILLION_CONTEXT_ADAPTER_VERSION, enabled: false, status: "not_installed", revision: 1, updatedAt: 0 };
}
export const ExtensionsDoc = defineDoc<ExtensionsState & JsonObject>({
  kind: "kulo.extensions", version: 1, scope: "session",
  initial: () => ({ revision: 1, items: { [ID]: initialRecord() }, jobs: {} }) as unknown as ExtensionsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});
export class ExtensionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ExtensionError"; }
}
function fail(status: number, code: string, message: string): never { throw new ExtensionError(status, code, message); }
function identifier(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(raw)) return fail(400, "invalid_extension_request", `${label}无效。`);
  return raw;
}
function publicError(error: unknown): string {
  return redactSecrets(error instanceof ExtensionError || error instanceof ExtensionPackageError ? error.message : "扩展操作未完成，请检查安装和上下文状态后重试。").slice(0, 600);
}
export interface ExtensionPackageExecutor {
  inspect(): Promise<ExtensionPackageInfo | null>;
  install(signal: AbortSignal): Promise<ExtensionPackageInfo>;
  remove(): Promise<void>;
}
export interface KuloExtensionsOptions {
  harness: Harness;
  operationTask: ReturnType<typeof createExtensionsTask>;
  stateDir: string;
  compaction: { enable(): Promise<void>; stop(): Promise<void> };
  packages?: ExtensionPackageExecutor;
  onChange?: () => void;
  now?: () => number;
}

export class KuloExtensions {
  readonly #options: KuloExtensionsOptions;
  readonly #packages: ExtensionPackageExecutor;
  readonly #controllers = new Map<string, AbortController>();
  readonly #executions = new Map<string, Promise<void>>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(options: KuloExtensionsOptions) {
    this.#options = options;
    this.#packages = options.packages ?? { inspect: () => inspectBillionContextPackage(options.stateDir),
      install: (signal) => installBillionContextPackage({ stateDir: options.stateDir, signal }), remove: () => removeBillionContextPackage(options.stateDir) };
  }
  #now() { return this.#options.now?.() ?? Date.now(); }
  #changed() { this.#options.onChange?.(); }
  #serial<T>(run: () => Promise<T>): Promise<T> { const pending = this.#queue.then(run); this.#queue = pending.catch(() => {}); return pending; }
  async snapshot(_clientId?: string): Promise<ExtensionWorkspaceSnapshot> {
    const state = await this.#options.harness.snapshot(ExtensionsDoc, context);
    return { revision: state?.revision ?? 1, items: clone(Object.values(state?.items ?? { [ID]: initialRecord() })),
      jobs: clone(Object.values(state?.jobs ?? {}).map((job) => job.view).sort((a, b) => a.createdAt - b.createdAt).slice(-40)) };
  }
  async analyze(source: string): Promise<ExtensionSourceAnalysis> {
    return analyzeExtensionSource(source, { builtinVersion: BILLION_CONTEXT_KERNEL_VERSION });
  }
  async initialize(): Promise<void> {
    await this.#options.harness.commit(async (tx) => { await tx.doc(ExtensionsDoc); }, context);
    const state = (await this.#options.harness.snapshot(ExtensionsDoc, context))!;
    const pending = Object.values(state.jobs).find((job) => ACTIVE.has(job.view.status));
    if (pending) {
      if (pending.view.operation === "stop" || pending.view.operation === "remove") await this.#options.compaction.stop();
      return;
    }
    let info: ExtensionPackageInfo | null;
    try {
      info = await this.#packages.inspect();
      if (state.items[ID]!.enabled) {
        if (!info) throw new ExtensionError(409, "extension_package_missing", "已启用的上下文压缩包缺失，请重新安装。");
        await this.#options.compaction.enable();
      }
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ExtensionsDoc), item = doc.items[ID]!;
        const next = { ...clone(item), sourceUrl: info?.sourceUrl ?? BILLION_CONTEXT_PACKAGE_SOURCE, installedVersion: info?.version,
          adapterVersion: info?.adapterVersion ?? BILLION_CONTEXT_ADAPTER_VERSION, enabled: Boolean(info && item.enabled),
          status: (info ? item.enabled ? "running" : "stopped" : "not_installed") as ExtensionRecord["status"] };
        if (!info) delete next.installedVersion;
        delete next.error;
        if (JSON.stringify({ ...item, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 })) { next.revision++; next.updatedAt = this.#now(); doc.items[ID] = next; doc.revision++; }
      }, context);
    } catch (error) {
      await this.#options.compaction.stop();
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ExtensionsDoc), item = doc.items[ID]!;
        item.enabled = false; item.status = "error"; item.error = publicError(error); item.updatedAt = this.#now(); item.revision++; doc.revision++;
      }, context);
    }
    this.#changed();
  }
  async request(raw: ExtensionOperationRequest): Promise<ExtensionWorkspaceSnapshot> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["id", "operation", "expectedRevision", "commandId", "clientId"].includes(key))) fail(400, "invalid_extension_request", "扩展操作字段无效。");
    const id = identifier(raw.id, "扩展"), commandId = identifier(raw.commandId, "操作标识"), clientId = identifier(raw.clientId ?? "settings-page", "客户端");
    if (id !== ID) fail(404, "extension_not_supported", "此项目尚未登记已验证的 Kulo 适配包，请先分析来源。");
    if (!["install", "enable", "stop", "remove"].includes(raw.operation) || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) fail(400, "invalid_extension_request", "扩展操作或版本无效。");
    const fingerprint = createHash("sha256").update(JSON.stringify([id, raw.operation, raw.expectedRevision, clientId])).digest("hex");
    await this.#serial(async () => {
      if (this.#closed) fail(409, "extension_manager_closed", "中枢正在关闭，请稍后重试。");
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ExtensionsDoc), prior = own(doc.jobs, commandId);
        if (prior) { if (prior.fingerprint !== fingerprint) fail(409, "extension_command_conflict", "操作标识已经用于其他扩展操作。"); return; }
        const item = doc.items[id]!;
        if (item.revision !== raw.expectedRevision) fail(409, "extension_revision_conflict", "扩展状态已更新，请刷新后重试。");
        if (Object.values(doc.jobs).some((job) => ACTIVE.has(job.view.status))) fail(409, "extension_busy", "扩展正在处理另一项操作。");
        if (raw.operation === "enable" && !item.installedVersion) fail(409, "extension_not_installed", "请先安装 Billion Context。");
        if (raw.operation === "install" && item.enabled) fail(409, "extension_running", "请先停止扩展再安装。");
        const now = this.#now();
        item.status = raw.operation === "install" ? "installing" : raw.operation === "enable" ? "starting" : raw.operation === "stop" ? "stopping" : "removing";
        delete item.error; item.revision++; item.updatedAt = now; doc.revision++;
        const job: StoredJob = { fingerprint, expectedRevision: item.revision, view: { id: commandId, extensionId: id, clientId,
          operation: raw.operation, status: "queued", stage: "等待执行", createdAt: now, updatedAt: now } };
        doc.jobs[commandId] = job;
        doc.jobs[commandId]!.view.taskId = Number(await tx.createTask(this.#options.operationTask, { jobId: commandId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }));
      }, context);
    });
    this.#changed(); this.#options.harness.resume();
    return this.snapshot(clientId);
  }
  async #stage(id: string, stage: string): Promise<void> {
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(ExtensionsDoc), job = doc.jobs[id]!;
      if (!ACTIVE.has(job.view.status)) return;
      job.view.status = "running"; job.view.stage = stage; job.view.updatedAt = this.#now(); doc.revision++;
    }, context);
    this.#changed();
  }
  async execute(jobId: string, signal?: AbortSignal): Promise<void> {
    const running = this.#executions.get(jobId); if (running) return running;
    const execution = this.#execute(jobId, signal).finally(() => this.#executions.delete(jobId));
    this.#executions.set(jobId, execution); return execution;
  }
  async #execute(jobId: string, signal?: AbortSignal): Promise<void> {
    const stored = own((await this.#options.harness.snapshot(ExtensionsDoc, context))?.jobs, jobId);
    if (!stored || !ACTIVE.has(stored.view.status)) return;
    const job = clone(stored), controller = new AbortController();
    this.#controllers.set(jobId, controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      combined.throwIfAborted();
      let info: ExtensionPackageInfo | null = null;
      if (job.view.operation === "install") {
        await this.#stage(jobId, "安装并验证上下文压缩内核");
        combined.throwIfAborted();
        info = await this.#packages.inspect() ?? await this.#packages.install(combined);
      } else if (job.view.operation === "enable") {
        await this.#stage(jobId, "接入主会话压缩");
        info = await this.#packages.inspect();
        if (!info) fail(409, "extension_not_installed", "上下文压缩包缺失，请重新安装。");
        combined.throwIfAborted();
        await this.#options.compaction.enable();
      } else {
        await this.#stage(jobId, "保存上下文并停止扩展");
        combined.throwIfAborted();
        await this.#options.compaction.stop();
        await this.#options.harness.commit(async (tx) => {
          const doc = await tx.doc(ExtensionsDoc), current = doc.jobs[jobId]!, item = doc.items[job.view.extensionId]!;
          if (ACTIVE.has(current.view.status) && item.revision === job.expectedRevision && item.enabled) {
            item.enabled = false; item.updatedAt = this.#now(); doc.revision++;
          }
        }, context);
        this.#changed();
        if (job.view.operation === "remove") { await this.#stage(jobId, "删除受管程序并保留会话历史"); combined.throwIfAborted(); await this.#packages.remove(); }
        else info = await this.#packages.inspect();
      }
      combined.throwIfAborted();
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ExtensionsDoc), current = doc.jobs[jobId]!, item = doc.items[job.view.extensionId]!;
        if (!ACTIVE.has(current.view.status)) return;
        if (current.view.taskId !== undefined && (await tx.task(current.view.taskId as TaskId))?.abortRequested) return;
        if (item.revision !== job.expectedRevision) fail(409, "extension_revision_conflict", "扩展状态已变化，操作结果未覆盖新设置。");
        item.enabled = job.view.operation === "enable";
        item.status = info ? item.enabled ? "running" : "stopped" : "not_installed";
        if (info) { item.installedVersion = info.version; item.adapterVersion = info.adapterVersion; item.sourceUrl = info.sourceUrl; }
        else delete item.installedVersion;
        delete item.error; item.updatedAt = this.#now(); item.revision++; doc.revision++;
        current.view.status = "completed"; current.view.stage = "已完成"; current.view.updatedAt = this.#now(); delete current.view.error;
      }, context);
      this.#changed();
    } catch (error) {
      if (combined.aborted) throw error;
      const message = publicError(error);
      await this.#options.harness.commit(async (tx) => {
        const doc = await tx.doc(ExtensionsDoc), current = doc.jobs[jobId]!, item = doc.items[job.view.extensionId]!;
        if (!ACTIVE.has(current.view.status)) return;
        if (current.view.taskId !== undefined && (await tx.task(current.view.taskId as TaskId))?.abortRequested) return;
        current.view.status = "failed"; current.view.stage = "未完成"; current.view.error = message; current.view.updatedAt = this.#now();
        if (item.revision === job.expectedRevision) { item.status = "error"; item.error = message; item.updatedAt = this.#now(); item.revision++; }
        doc.revision++;
      }, context);
      this.#changed(); throw new ExtensionError(409, "extension_operation_failed", message);
    } finally { this.#controllers.delete(jobId); }
  }
  async cancel(jobId: string): Promise<void> {
    this.#controllers.get(jobId)?.abort();
    // A host callback may be finishing a safe boundary; drain it before undoing a cancelled start.
    await this.#executions.get(jobId)?.catch(() => {});
    const before = own((await this.#options.harness.snapshot(ExtensionsDoc, context))?.jobs, jobId);
    if (!before || !ACTIVE.has(before.view.status)) return;
    if (before.view.operation !== "install") await this.#options.compaction.stop();
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(ExtensionsDoc), job = own(doc.jobs, jobId);
      if (!job || !ACTIVE.has(job.view.status)) return;
      const item = doc.items[job.view.extensionId]!;
      job.view.status = "cancelled"; job.view.stage = "已取消"; job.view.updatedAt = this.#now();
      if (item.revision === job.expectedRevision) {
        if (job.view.operation !== "install") item.enabled = false;
        item.status = "error"; item.error = "操作已取消，请检查安装状态后重试。"; item.updatedAt = this.#now(); item.revision++;
      }
      doc.revision++;
    }, context);
    this.#changed();
  }
  // Harness.close cancels task invocations without making their jobs terminal, so reopening can resume them.
  close(): void { this.#closed = true; }
}

function createExtensionsTask(get: () => KuloExtensions) {
  return defineTask<{ jobId: string }, { phase: "run" }, null>({
    name: "kulo.extension-operation", version: 1, initial: () => ({ phase: "run" }),
    phases: { run: async (task, runtime, ctx) => {
      try { await get().execute(task.input.jobId, runtime.signal); }
      catch (error) {
        runtime.signal.throwIfAborted();
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: publicError(error) } } }), ctx); return;
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
    } },
    abort: async (task, runtime, ctx) => { await get().cancel(task.input.jobId); await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
}
export function createExtensionsExtension(get: () => KuloExtensions) {
  const operationTask = createExtensionsTask(get);
  return Object.assign(defineExtension({ name: "kulo-extensions", tasks: [operationTask] }), { operationTask });
}
