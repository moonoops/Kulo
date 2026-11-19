import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BrowserRequest, BrowserResult } from "@kulo/protocol";
import { MainChromeFlowDriver } from "./flow-main-driver.js";

const MAX_CHUNK = 1024 * 1024;
const MAX_FILE = 250 * 1024 * 1024;
const MAX_INPUT_TOTAL = 300 * 1024 * 1024;
const TERMINAL_RETENTION = 7 * 24 * 60 * 60 * 1000;
const inputExtension: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm" };
const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) || ["constructor", "prototype"].includes(value)) {
    throw new Error("Invalid Flow " + label);
  }
  return value;
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface FlowJobState {
  id: string;
  profileRef: string;
  fingerprint: string;
  status: "prepared" | "submitting" | "running" | "completed" | "needs_review" | "stopped";
  remoteUrl?: string;
  baselineUrls: string[];
  mediaUrl?: string;
  submittedAt?: number;
  preparedAt?: number;
  quote?: NonNullable<BrowserResult["quote"]>;
  updatedAt: number;
  remoteMayBeRunning?: boolean;
  file?: { name: string; mimeType: string; size: number };
  uploads: Record<string, { name: string; mimeType: string; size: number; complete: boolean }>;
}
interface FlowState { version: 1; jobs: Record<string, FlowJobState> }
export interface FlowSubmitInput {
  job: FlowJobState;
  prompt: string;
  modelId?: string;
  durationSeconds?: number;
  referencePaths: string[];
}
export interface FlowBrowserDriver {
  open?(): Promise<BrowserResult>;
  check(): Promise<BrowserResult>;
  prepare?(input: FlowSubmitInput, beforePrepare: (pageUrl: string, baselineUrls: string[]) => void): Promise<BrowserResult>;
  submit(input: FlowSubmitInput, beforeSubmit: (pageUrl: string, baselineUrls: string[]) => void): Promise<BrowserResult>;
  poll(job: FlowJobState): Promise<BrowserResult & { mediaUrl?: string }>;
  stop?(job: FlowJobState): Promise<BrowserResult>;
  download(job: FlowJobState, destination: string): Promise<{ name: string; mimeType: string; size: number } | null>;
  close(): Promise<void>;
}
export interface FlowBrowserServiceOptions {
  rootDir: string;
  platform?: NodeJS.Platform;
  executablePath?: string;
  driverFactory?: (connectionDirectory: string) => Promise<FlowBrowserDriver>;
  now?: () => number;
}
export function flowBrowserExecutable(platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates = platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : platform === "linux" ? [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome",
  ] : platform === "win32" ? [
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value))
      .map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe")),
  ] : [];
  return candidates.find((file) => fs.existsSync(file));
}

/** Keeps Flow job state and connection output outside Worker RPC. */
export class FlowBrowserService {
  readonly rootDir: string;
  readonly available: boolean;
  readonly #options: FlowBrowserServiceOptions;
  readonly #statePath: string;
  readonly #drivers = new Map<string, Promise<FlowBrowserDriver>>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #state: FlowState;
  #closed = false;
  #generation = 0;

  constructor(options: FlowBrowserServiceOptions) {
    this.#options = options;
    this.rootDir = path.resolve(options.rootDir);
    const platform = options.platform ?? process.platform;
    this.available = Boolean(options.driverFactory || ["darwin", "linux", "win32"].includes(platform) && (options.executablePath || flowBrowserExecutable(platform)));
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(this.rootDir).isDirectory() || fs.lstatSync(this.rootDir).isSymbolicLink()) throw new Error("Flow browser storage must be a private directory");
    fs.chmodSync(this.rootDir, 0o700);
    this.#statePath = path.join(this.rootDir, "jobs.json");
    this.#state = { version: 1, jobs: {} };
    if (fs.existsSync(this.#statePath)) {
      const descriptor = fs.openSync(this.#statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(descriptor).size > 8 * 1024 * 1024) throw new Error("Flow browser state exceeds its limit");
        const state = JSON.parse(fs.readFileSync(descriptor, "utf8")) as FlowState;
        if (state.version !== 1 || !state.jobs || Array.isArray(state.jobs)) throw new Error("Invalid Flow browser state");
        for (const [id, job] of Object.entries(state.jobs)) {
          identifier(id, "job ID"); identifier(job.profileRef, "profile");
          if (job.id !== id || !["prepared", "submitting", "running", "completed", "needs_review", "stopped"].includes(job.status) || !Array.isArray(job.baselineUrls) || !job.uploads || !Number.isFinite(job.updatedAt)) throw new Error("Invalid Flow browser job");
        }
        this.#state = state;
      } finally { fs.closeSync(descriptor); }
    }
    this.#prune();
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #persist(): void {
    const temporary = this.#statePath + ".tmp";
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(this.#state)); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, this.#statePath);
  }
  #directory(profileRef: string, jobId?: string): string {
    const result = path.join(this.rootDir, jobId ? "jobs" : "connections", profileRef, ...(jobId ? [jobId] : []));
    let current = this.rootDir;
    for (const component of path.relative(this.rootDir, result).split(path.sep)) {
      current = path.join(current, component);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid Flow browser storage path");
    }
    return result;
  }
  #job(profileRef: string, jobId: string): FlowJobState | undefined {
    const job = Object.hasOwn(this.#state.jobs, jobId) ? this.#state.jobs[jobId] : undefined;
    if (job && job.profileRef !== profileRef) throw new Error("Flow job belongs to a different browser connection");
    return job;
  }
  #prune(): void {
    let changed = false;
    for (const [id, job] of Object.entries(this.#state.jobs)) {
      if (["completed", "prepared"].includes(job.status) && this.#now() - job.updatedAt > TERMINAL_RETENTION) {
        const directory = path.join(this.rootDir, "jobs", job.profileRef, id);
        fs.rmSync(directory, { recursive: true, force: true });
        delete this.#state.jobs[id]; changed = true;
      }
    }
    if (changed) this.#persist();
  }
  async #driver(profileRef: string, isActive: () => boolean = () => true): Promise<FlowBrowserDriver> {
    if (this.#closed || !isActive()) throw new Error("Flow browser connection is no longer authorized");
    let driver = this.#drivers.get(profileRef);
    if (!driver) {
      const connectionDirectory = this.#directory(profileRef);
      const generation = this.#generation;
      driver = (async () => {
        const created = await (this.#options.driverFactory
          ? this.#options.driverFactory(connectionDirectory)
          : MainChromeFlowDriver.open(connectionDirectory));
        if (generation !== this.#generation || this.#closed || !isActive()) { await created.close(); throw new Error("Flow browser connection is no longer authorized"); }
        return created;
      })();
      this.#drivers.set(profileRef, driver);
      try { await driver; } catch { this.#drivers.delete(profileRef); throw new Error("Flow browser could not start"); }
    }
    return driver;
  }
  async request(request: BrowserRequest, isActive: () => boolean = () => true): Promise<BrowserResult> {
    if (!request || typeof request !== "object") throw new Error("Invalid Flow browser request");
    if ("takeover" in request && (request.action !== "check" || typeof request.takeover !== "boolean")) throw new Error("Invalid Flow browser takeover");
    const profileRef = identifier(request.profileRef, "profile");
    if (!this.available) throw new Error("This device has no supported Flow browser; install Chrome and agent-browser on macOS, Linux, or Windows");
    if (this.#closed) throw new Error("Flow browser service is closed");
    const prior = this.#queues.get(profileRef) ?? Promise.resolve();
    const run = prior.then(async () => {
      if (this.#closed || !isActive()) throw new Error("Flow browser connection is no longer authorized");
      this.#prune();
      return this.#request(request, isActive);
    });
    const work = run.catch(async (error: unknown) => {
      const driver = this.#drivers.get(profileRef); this.#drivers.delete(profileRef);
      if (driver) await Promise.allSettled([driver.then((value) => value.close())]);
      throw error;
    });
    const tail = work.then(() => undefined, () => undefined);
    this.#queues.set(profileRef, tail);
    void tail.then(() => { if (this.#queues.get(profileRef) === tail) this.#queues.delete(profileRef); });
    return work;
  }

  async #request(request: BrowserRequest, isActive: () => boolean): Promise<BrowserResult> {
    const profileRef = request.profileRef;
    if (request.action === "open") {
      const driver = await this.#driver(profileRef, isActive);
      const result = await (driver.open ? driver.open() : driver.check());
      return { ...result, profileRef };
    }
    if (request.action === "check") {
      const blocked = await this.#reconcileStopped(profileRef, isActive);
      if (blocked) return blocked;
      const result = await (await this.#driver(profileRef, isActive)).check();
      return { ...result, profileRef };
    }
    if (!("jobId" in request)) throw new Error("Unknown Flow browser action");
    const jobId = identifier(request.jobId, "job ID");
    let job = this.#job(profileRef, jobId);
    if (request.action === "upload") {
      const assetId = identifier(request.assetId, "asset ID");
      if (!/^image\/(png|jpeg|webp|gif)$|^video\/(mp4|webm)$/.test(request.mimeType) || typeof request.name !== "string" || request.name.length > 255 || /[\x00-\x1f\\/]/.test(request.name) || typeof request.final !== "boolean") throw new Error("Invalid Flow reference file");
      if (!Number.isSafeInteger(request.offset) || request.offset < 0 || typeof request.data !== "string" || request.data.length > Math.ceil(MAX_CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data)) throw new Error("Invalid Flow upload chunk");
      const bytes = Buffer.from(request.data, "base64");
      if (bytes.length > MAX_CHUNK) throw new Error("Flow upload chunk exceeds its limit");
      if (!job) {
        if (Object.keys(this.#state.jobs).length >= 1000) throw new Error("Flow browser job storage is full");
        job = this.#state.jobs[jobId] = { id: jobId, profileRef, fingerprint: "", status: "prepared", baselineUrls: [], updatedAt: this.#now(), uploads: {} };
      }
      const retryPreparation = job.status === "needs_review" && job.submittedAt === undefined;
      if (job.status !== "prepared" && !retryPreparation) throw new Error("Flow references cannot change after submission");
      const upload = Object.hasOwn(job.uploads, assetId) ? job.uploads[assetId] : undefined;
      if (retryPreparation && !upload) throw new Error("Flow reference identity changed");
      if (upload && (upload.name !== request.name || upload.mimeType !== request.mimeType)) throw new Error("Flow reference identity changed");
      const filename = path.join(this.#directory(profileRef, jobId), assetId + inputExtension[request.mimeType]);
      const info = fs.existsSync(filename) ? fs.lstatSync(filename) : undefined;
      if (info?.isSymbolicLink() || info && !info.isFile()) throw new Error("Invalid Flow reference storage");
      const size = info?.size ?? 0;
      if (upload?.complete && request.final && request.offset + bytes.length !== size) throw new Error("Flow reference content changed");
      if (size !== request.offset) {
        if (request.offset + bytes.length <= size) {
          const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const previous = Buffer.alloc(bytes.length); fs.readSync(fd, previous, 0, previous.length, request.offset);
            if (previous.equals(bytes)) {
              if (request.offset + bytes.length === size && (!upload || upload.size <= request.offset)) {
                job.uploads[assetId] = { name: request.name, mimeType: request.mimeType, size, complete: request.final };
                job.updatedAt = this.#now(); this.#persist();
              }
              return { status: "ready", profileRef, jobId, submitted: false, offset: size };
            }
          } finally { fs.closeSync(fd); }
        }
        throw new Error("Flow upload offset does not match the saved file");
      }
      if (upload?.complete) throw new Error("Flow reference is already complete");
      const total = Object.values(job.uploads).reduce((sum, file) => sum + file.size, 0) + bytes.length;
      if (size + bytes.length > (request.mimeType.startsWith("image/") ? 25 * 1024 * 1024 : MAX_FILE) || total > MAX_INPUT_TOTAL) throw new Error("Flow references exceed their size limit");
      const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
      job.uploads[assetId] = { name: request.name, mimeType: request.mimeType, size: size + bytes.length, complete: request.final };
      job.updatedAt = this.#now(); this.#persist();
      return { status: "ready", profileRef, jobId, submitted: false, offset: size + bytes.length };
    }
    if (request.action === "prepare" || request.action === "submit") {
      if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 32_000) throw new Error("Invalid Flow prompt");
      if (request.durationSeconds !== undefined && (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0 || request.durationSeconds > 60)) throw new Error("Invalid Flow duration");
      if (request.modelId !== undefined && (typeof request.modelId !== "string" || request.modelId.length > 200)) throw new Error("Invalid Flow model");
      const references = request.referenceIds ?? [];
      if (!Array.isArray(references) || references.length > 6) throw new Error("Too many Flow references");
      for (const id of references) identifier(id, "asset ID");
      const fingerprint = createHash("sha256").update(JSON.stringify({ prompt: request.prompt.trim(), modelId: request.modelId ?? "", duration: request.durationSeconds ?? null, references })).digest("hex");
      if (job?.fingerprint && job.fingerprint !== fingerprint) throw new Error("Flow job ID cannot be reused for another request");
      if (job && job.status !== "prepared" && !(job.status === "needs_review" && job.submittedAt === undefined)) return this.#result(job);
      await this.#reconcileStopped(profileRef, isActive);
      const blocking = Object.values(this.#state.jobs).find((other) => other.profileRef === profileRef && other.id !== jobId && (["submitting", "running"].includes(other.status) || other.remoteMayBeRunning));
      if (blocking) return { status: "needs_review", profileRef, jobId, submitted: false, message: "此浏览器还有未确认完成的 Flow 生成，请先处理原任务。" };
      if (!job) {
        if (Object.keys(this.#state.jobs).length >= 1000) throw new Error("Flow browser job storage is full");
        job = this.#state.jobs[jobId] = { id: jobId, profileRef, fingerprint, status: "prepared", baselineUrls: [], updatedAt: this.#now(), uploads: {} };
      }
      job.fingerprint = fingerprint;
      const referencePaths = references.map((id) => {
        if (!job!.uploads[id]?.complete) throw new Error("Flow reference upload is not complete");
        return path.join(this.#directory(profileRef, jobId), id + inputExtension[job!.uploads[id]!.mimeType]);
      });
      this.#persist();
      try {
        const driver = await this.#driver(profileRef, isActive);
        const input = { job: copy(job), prompt: request.prompt.trim(), modelId: request.modelId, durationSeconds: request.durationSeconds, referencePaths };
        if (request.action === "prepare") {
          if (!driver.prepare) return { status: "needs_review", profileRef, jobId, submitted: false, message: "当前浏览器连接尚未支持 Flow 生成确认，请连接主 Chrome 后继续。" };
          const result = await driver.prepare(input, (pageUrl, baselineUrls) => {
            if (!isActive()) throw new Error("Flow browser connection was revoked before preparation");
            job!.preparedAt ??= this.#now(); job!.remoteUrl = pageUrl; job!.baselineUrls = baselineUrls;
            job!.updatedAt = this.#now(); this.#persist();
          });
          if (this.#observeAcceptance(job, result)) return { ...result, ...this.#result(job), quote: job.quote ? copy(job.quote) : undefined };
          if (!isActive()) throw new Error("Flow browser connection is no longer authorized");
          if (result.preparationSent === false && input.job.preparedAt === undefined && job.submittedAt === undefined) {
            delete job.preparedAt; delete job.quote;
          }
          const quote = result.quote;
          if (job.preparedAt !== undefined && result.status === "ready" && result.prepared && quote && Number.isFinite(quote.credits) && quote.credits >= 0 && quote.outputs === 1
            && (quote.durationSeconds === undefined || Number.isFinite(quote.durationSeconds) && quote.durationSeconds > 0 && quote.durationSeconds <= 60)
            && (quote.modelId === undefined || typeof quote.modelId === "string" && quote.modelId.length <= 200)) {
            job.quote = copy(result.quote); job.status = "prepared";
          } else { job.status = "needs_review"; delete job.quote; }
          job.updatedAt = this.#now(); this.#persist();
          return { ...result, ...this.#result(job), prepared: job.quote !== undefined, quote: job.quote ? copy(job.quote) : undefined, submitted: false };
        }
        const result = await driver.submit(input, (pageUrl, baselineUrls) => {
          if (!isActive()) throw new Error("Flow browser connection is no longer authorized");
          job!.status = "submitting"; job!.remoteUrl = pageUrl; job!.baselineUrls = baselineUrls;
          job!.submittedAt = this.#now(); job!.remoteMayBeRunning = true; job!.updatedAt = this.#now(); this.#persist();
        });
        if (this.#observeAcceptance(job, result)) return { ...result, ...this.#result(job), quote: job.quote ? copy(job.quote) : undefined };
        job.status = result.status === "running" ? "running" : "needs_review";
        if (result.remoteUrl) job.remoteUrl = result.remoteUrl;
        job.updatedAt = this.#now(); this.#persist();
        return { ...result, profileRef, jobId, submitted: job.submittedAt !== undefined, ...(job.submittedAt !== undefined ? { remoteId: job.id } : {}) };
      } catch {
        if (request.action === "prepare") delete job.quote;
        job.status = "needs_review"; job.updatedAt = this.#now(); this.#persist();
        const driver = this.#drivers.get(profileRef); this.#drivers.delete(profileRef);
        if (driver) await Promise.allSettled([driver.then((value) => value.close())]);
        return { status: "needs_review", profileRef, jobId, submitted: job.submittedAt !== undefined, ...(job.submittedAt !== undefined ? { remoteId: job.id } : {}), message: job.submittedAt !== undefined ? "Flow 提交结果尚未确认，请核对原任务，勿重复生成。" : "Flow 页面需要检查，请在目标设备打开浏览器处理后继续。" };
      }
    }
    if (!job) throw new Error("Flow job was not found");
    if (request.action === "stop") {
      if (job.submittedAt === undefined && job.preparedAt !== undefined) job.remoteMayBeRunning = true;
      job.status = "stopped"; job.updatedAt = this.#now(); this.#persist();
      if (job.submittedAt === undefined && job.remoteMayBeRunning) {
        try { await this.#reconcileStoppedJob(job, await this.#driver(profileRef, isActive)); }
        catch { /* The stopped request stays reserved until its native card can be verified. */ }
      }
      for (const [assetId, upload] of Object.entries(job.uploads)) fs.rmSync(path.join(this.#directory(profileRef, jobId), assetId + inputExtension[upload.mimeType]), { force: true });
      return { ...this.#result(job), message: job.remoteMayBeRunning
        ? job.submittedAt === undefined ? "已停止 Kulo 后续处理，Flow 原请求仍待核对。" : "已停止 Kulo 后续处理，Flow 网页生成可能仍在继续。"
        : "已停止。" };
    }
    if (request.action === "read") {
      if (!job.file || job.status !== "completed") throw new Error("Flow output is not ready");
      if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.length) || request.length < 1 || request.length > MAX_CHUNK || request.offset > job.file.size) throw new Error("Invalid Flow output range");
      const descriptor = fs.openSync(path.join(this.#directory(profileRef, jobId), "output.mp4"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const size = fs.fstatSync(descriptor).size;
        if (size !== job.file.size || size > MAX_FILE) throw new Error("Flow output changed");
        const bytes = Buffer.alloc(Math.min(request.length, size - request.offset));
        fs.readSync(descriptor, bytes, 0, bytes.length, request.offset);
        return { ...this.#result(job), data: bytes.toString("base64"), offset: request.offset };
      } finally { fs.closeSync(descriptor); }
    }
    if (request.action !== "poll" && request.action !== "download") throw new Error("Unknown Flow browser action");
    if (job.file || job.status === "stopped" && request.action === "download") return this.#result(job);
    if (job.submittedAt === undefined) return this.#result(job);
    const driver = await this.#driver(profileRef, isActive);
    const inspected = await driver.poll(copy(job));
    if (inspected.status === "completed" && inspected.mediaUrl) {
      if (job.status !== "stopped") job.status = "completed";
      job.mediaUrl = inspected.mediaUrl; job.remoteMayBeRunning = false;
    } else if (job.status === "stopped" && inspected.status === "stopped") {
      job.remoteMayBeRunning = false;
    } else if (inspected.status === "running" && job.status !== "stopped") job.status = "running";
    else if (job.status !== "stopped") job.status = "needs_review";
    job.updatedAt = this.#now(); this.#persist();
    if (request.action === "download" && job.status === "completed") {
      const file = await driver.download(copy(job), path.join(this.#directory(profileRef, jobId), "output.mp4"));
      if (!file) return { ...this.#result(job), status: "needs_review", message: "浏览器未提供可安全回传的视频内容，请在原 Flow 页面核对下载状态；未重新生成。" };
      if (file.size < 12 || file.size > MAX_FILE) throw new Error("Flow output exceeds its size limit");
      job.file = file; this.#persist();
    }
    return { ...this.#result(job), ...(inspected.message ? { message: inspected.message } : {}) };
  }
  #result(job: FlowJobState): BrowserResult {
    return { status: job.status === "prepared" ? "ready" : job.status === "submitting" || job.status === "needs_review" ? "needs_review" : job.status,
      ...(job.quote ? { prepared: true, quote: copy(job.quote) } : {}),
      profileRef: job.profileRef, jobId: job.id, submitted: job.submittedAt !== undefined, remoteId: job.submittedAt !== undefined ? job.id : undefined, remoteUrl: job.remoteUrl, ...(job.file ? { file: copy(job.file) } : {}) };
  }
  #observeAcceptance(job: FlowJobState, result: BrowserResult): boolean {
    if (result.submitted !== true || job.submittedAt !== undefined) return false;
    // Observing the same owned card already approved never sends another paid click.
    job.submittedAt = this.#now(); job.remoteMayBeRunning = true;
    if (job.status !== "stopped") job.status = "running";
    job.remoteUrl ??= result.remoteUrl; job.updatedAt = this.#now(); this.#persist();
    return true;
  }
  async #reconcileStopped(profileRef: string, isActive: () => boolean): Promise<BrowserResult | undefined> {
    const jobs = Object.values(this.#state.jobs).filter((job) => job.profileRef === profileRef && job.status === "stopped" && job.remoteMayBeRunning);
    if (!jobs.length) return undefined;
    const driver = await this.#driver(profileRef, isActive);
    let pending = false;
    for (const job of jobs) {
      try { if (!await this.#reconcileStoppedJob(job, driver)) pending = true; }
      catch { pending = true; }
    }
    return pending ? { status: "needs_review", profileRef, message: "已停止的 Flow 请求仍待核对，请连接主 Chrome 并确认原确认卡或任务后重新检查。" } : undefined;
  }
  async #reconcileStoppedJob(job: FlowJobState, driver: FlowBrowserDriver): Promise<boolean> {
    const submitted = job.submittedAt !== undefined;
    const result = submitted ? await driver.poll(copy(job)) : job.preparedAt !== undefined ? await driver.stop?.(copy(job)) : undefined;
    if (!result) return false;
    this.#observeAcceptance(job, result);
    if (!submitted && job.submittedAt !== undefined) return false;
    if (result.status !== "stopped" && !(submitted && result.status === "completed" && "mediaUrl" in result && result.mediaUrl)) return false;
    job.remoteMayBeRunning = false;
    if ("mediaUrl" in result && typeof result.mediaUrl === "string") job.mediaUrl = result.mediaUrl;
    job.updatedAt = this.#now(); this.#persist();
    return true;
  }
  async suspend(): Promise<void> {
    this.#generation++;
    const drivers = [...this.#drivers.values()]; this.#drivers.clear();
    const results = await Promise.allSettled(drivers.map(async (driver) => (await driver).close()));
    if (results.some((result) => result.status === "rejected")) throw new Error("Some Main Chrome Flow connections could not detach");
  }
  async close(): Promise<void> { this.#closed = true; await this.suspend(); }
}
