import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  acquireCustomizationOperationLock, createReleaseManifest, readReleaseManifest, verifyRelease, type RecoveryManager, type RecoveryReleaseRecord,
  type RecoveryReleaseManifest,
} from "@moco/recovery";
import { redactSecrets } from "@moco/protocol";
import {
  CustomizationError, assertCustomizationDataCompatibility, cleanupLocalCustomizationExecutions, customizationChanges, customizationEditablePath, customizationIdentifier,
  customizationPrivateDirectory, customizationSourceFile, customizationSourceIdentity, prepareCustomizationSource,
  type CustomizationRunner, type CustomizationSource, type CustomizationSourceSnapshot, type CustomizationFileChange,
} from "./customization-source.js";
import { cleanupManagedCustomizationUpdates, fetchSignedCustomizationUpdate, mergeCustomizationChanges, readSignedCustomizationUpdate } from "./customization-updates.js";

export interface CustomizationCaller { id: string; canModify: boolean }
export interface MocoCustomizationOptions {
  dataDir: string;
  stateDir?: string;
  source?: CustomizationSource;
  recovery: Pick<RecoveryManager, "inspect" | "stageRelease" | "schedule">;
  runner?: CustomizationRunner;
  trustedUpdateKeys?: Readonly<Record<string, string>>;
  updateInboxRoot?: string;
  updateFeedUrl?: string;
  fetch?: typeof fetch;
  allowLocalFeed?: boolean;
  shellVersion?: string;
  redact?: (text: string) => string;
  onChanged?: () => void | Promise<void>;
  now?: () => number;
}
interface SourceSession {
  formatVersion: 1;
  id: string;
  ownerId: string;
  summary: string;
  status: "prepared" | "validating" | "pending" | "failed" | "cancelled" | "conflict";
  revision: number;
  baseReleaseId: string;
  officialVersion: string;
  source: CustomizationSourceSnapshot;
  changedFiles?: string[];
  createdAt: number;
  updatedAt: number;
  releaseId?: string;
  error?: string;
}
interface SourceRevision {
  formatVersion: 1;
  id: string;
  sourceCommit?: string;
  sourceTreeHash: string;
  changes: CustomizationFileChange[];
  createdAt: number;
}
export interface CustomizationSessionView {
  id: string; summary: string; status: SourceSession["status"]; revision: number;
  changedFiles: string[]; releaseId?: string; error?: string;
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
async function readJson(file: string, maxBytes = 8 * 1024 * 1024): Promise<unknown | undefined> {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new CustomizationError("customization_record_invalid", "定制记录无效。");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  await customizationPrivateDirectory(path.dirname(file));
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export class MocoCustomizationService {
  readonly #options: MocoCustomizationOptions;
  readonly #root: string;
  readonly #staging: string;
  readonly #now: () => number;
  #running?: { id: string; controller: AbortController; promise: Promise<unknown> };
  #closed = false;

  constructor(options: MocoCustomizationOptions) {
    if (!path.isAbsolute(options.dataDir) || path.parse(options.dataDir).root === options.dataDir) throw new CustomizationError("customization_directory_invalid", "定制数据目录无效。");
    this.#options = options; this.#root = path.join(options.dataDir, "customizations");
    this.#staging = path.join(options.dataDir, "staging", "customization");
    this.#now = options.now ?? Date.now;
  }
  #authorize(caller: CustomizationCaller, modify = false): string {
    customizationIdentifier(caller.id);
    if (this.#closed) throw new CustomizationError("customization_closed", "定制服务已关闭。");
    if (modify && !caller.canModify) throw new CustomizationError("customization_forbidden", "当前会话没有修改 Moco 的授权。", 403);
    return caller.id;
  }
  #work(id: string) { return path.join(this.#staging, customizationIdentifier(id)); }
  #sessionPath(id: string) { return path.join(this.#root, "sessions", customizationIdentifier(id) + ".json"); }
  #redact(value: string) { return (this.#options.redact ?? redactSecrets)(value); }
  #downloadOwner() { return createHash("sha256").update(path.resolve(this.#options.dataDir)).digest("hex"); }
  async #save(session: SourceSession) {
    session.updatedAt = this.#now(); await atomicJson(this.#sessionPath(session.id), session);
    await this.#options.onChanged?.();
  }
  async #session(id: string, caller: CustomizationCaller): Promise<SourceSession> {
    const owner = this.#authorize(caller);
    const raw = await readJson(this.#sessionPath(id));
    if (!object(raw) || raw.formatVersion !== 1 || raw.id !== id || raw.ownerId !== owner ||
        !object(raw.source) || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision)) {
      throw new CustomizationError("customization_session_missing", "此定制不属于当前会话或已不可用。", 404);
    }
    return raw as unknown as SourceSession;
  }
  async #view(session: SourceSession): Promise<CustomizationSessionView> {
    return { id: session.id, summary: this.#redact(session.summary), status: session.status, revision: session.revision,
      changedFiles: session.changedFiles ?? [], ...(session.releaseId ? { releaseId: session.releaseId } : {}), ...(session.error ? { error: this.#redact(session.error) } : {}) };
  }
  async #effective(): Promise<RecoveryReleaseRecord> {
    const state = await this.#options.recovery.inspect(), release = state.pending ?? state.current;
    if (!release) throw new CustomizationError("customization_baseline_missing", "当前安装尚未登记可恢复的运行版本。");
    return release;
  }
  async #officialSource(root: string, manifest: RecoveryReleaseRecord["manifest"] | RecoveryReleaseManifest): Promise<CustomizationSource | undefined> {
    const raw = await readJson(path.join(root, "moco-source.json"), 32 * 1024);
    if (raw === undefined) return undefined;
    if (!object(raw) || raw.formatVersion !== 1 || raw.archiveFile !== "moco-source.json.gz" ||
        typeof raw.archiveHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.archiveHash) ||
        typeof raw.treeHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.treeHash) ||
        raw.version !== manifest.version || manifest.sourceTreeHash && raw.treeHash !== manifest.sourceTreeHash ||
        manifest.sourceCommit && raw.commit !== manifest.sourceCommit) {
      throw new CustomizationError("customization_source_invalid", "官方源码归档与运行版本不匹配。");
    }
    return { archivePath: path.join(root, raw.archiveFile), archiveHash: raw.archiveHash,
      treeHash: raw.treeHash, version: manifest.version, ...(typeof raw.commit === "string" ? { commit: raw.commit } : {}) };
  }
  async #sourceRevision(id: string): Promise<SourceRevision> {
    const raw = await readJson(path.join(this.#root, "revisions", customizationIdentifier(id) + ".json"), 32 * 1024 * 1024);
    if (!object(raw) || raw.formatVersion !== 1 || raw.id !== id || !Array.isArray(raw.changes)) {
      throw new CustomizationError("customization_revision_missing", "定制修订缺失，已保留当前环境。");
    }
    for (const change of raw.changes) {
      if (!object(change) || typeof change.path !== "string" ||
          change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string") {
        throw new CustomizationError("customization_revision_invalid", "定制修订格式无效。");
      }
      customizationEditablePath(change.path);
    }
    return raw as unknown as SourceRevision;
  }
  async #exclusive<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    customizationIdentifier(id);
    if (this.#running) throw new CustomizationError("customization_busy", "已有一项定制正在准备，当前版本可继续使用。");
    await customizationPrivateDirectory(this.#root);
    const releaseLock = acquireCustomizationOperationLock(this.#options.dataDir);
    const controller = new AbortController();
    if (this.#closed) { releaseLock(); throw new CustomizationError("customization_closed", "定制服务已关闭。"); }
    const promise = Promise.resolve().then(async () => {
      const recovered = await cleanupLocalCustomizationExecutions(this.#options.dataDir, true);
      if (recovered.pending.length) throw new CustomizationError("customization_cleanup_pending", "先前定制进程尚未确认清理，已保留现场并暂停新定制，可通过独立救援修复。");
      if (this.#options.updateInboxRoot) await cleanupManagedCustomizationUpdates({ inboxRoot: this.#options.updateInboxRoot, ownerId: this.#downloadOwner() });
      return operation(controller.signal);
    }).finally(async () => {
      try { releaseLock(); }
      finally { this.#running = undefined; }
    });
    this.#running = { id, controller, promise };
    return promise;
  }
  async status(caller: CustomizationCaller) {
    this.#authorize(caller);
    const state = await this.#options.recovery.inspect();
    const pointer = await readJson(path.join(this.#root, "active-session.json"), 1000);
    let session: (CustomizationSessionView & { applicationState: "active" | "pending" | "failed" | "inactive" }) | undefined;
    if (object(pointer) && typeof pointer.id === "string") {
      const raw = await readJson(this.#sessionPath(pointer.id));
      if (object(raw) && raw.ownerId === caller.id) {
        const view = await this.#view(raw as unknown as SourceSession);
        const release = view.releaseId ? state.releases.find((record) => record.id === view.releaseId) : undefined;
        session = { ...view, applicationState: !view.releaseId ? "inactive" : release?.status === "failed" ? "failed" :
          state.current?.id === view.releaseId && state.current.status !== "failed" ? "active" :
          state.pending?.id === view.releaseId ? "pending" : "inactive" };
      }
    }
    return { currentVersion: state.current?.manifest.version ?? null, currentReleaseId: state.current?.id ?? null,
      pendingReleaseId: state.pending?.id ?? null, hasPendingUpdate: Boolean(state.pending),
      sourceCustomizationAvailable: Boolean(this.#options.source && this.#options.runner),
      officialUpdatesAvailable: Boolean(this.#options.updateFeedUrl && this.#options.fetch && Object.keys(this.#options.trustedUpdateKeys ?? {}).length && this.#options.runner),
      ...(session ? { session } : {}) };
  }
  async prepare(input: { summary: string; commandId: string }, caller: CustomizationCaller): Promise<CustomizationSessionView> {
    this.#authorize(caller, true);
    if (!this.#options.source || !this.#options.runner) throw new CustomizationError("customization_source_unavailable", "当前安装尚未准备匹配的源码定制环境，原版本可继续使用。");
    customizationIdentifier(input.commandId);
    if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 1000) throw new CustomizationError("invalid_customization_summary", "请提供简短的功能修改目标。", 400);
    const id = "custom-" + createHash("sha256").update(caller.id + "\0" + input.commandId).digest("hex").slice(0, 24);
    const existing = await readJson(this.#sessionPath(id));
    if (existing) {
      const session = await this.#session(id, caller);
      if (session.summary !== input.summary.trim()) throw new CustomizationError("customization_command_conflict", "此操作标识已用于另一项定制。");
      return this.#view(session);
    }
    return this.#exclusive(id, async (signal) => {
      let ownsWork = false;
      try {
      const pointer = await readJson(path.join(this.#root, "active-session.json"), 1000);
      if (object(pointer) && typeof pointer.id === "string") {
        const active = await readJson(this.#sessionPath(pointer.id));
        if (object(active) && ["prepared", "validating", "failed", "conflict"].includes(String(active.status))) {
          if (active.ownerId === caller.id) return this.#view(active as unknown as SourceSession);
          throw new CustomizationError("customization_busy", "另一会话已有待完成的定制，当前版本可继续使用。");
        }
      }
      const release = await this.#effective(), workRoot = await customizationPrivateDirectory(this.#work(id));
      ownsWork = true;
      const inspection = await this.#options.recovery.inspect();
      const base = inspection.releases.find((record) => record.id === (release.manifest.baseReleaseId ?? release.id));
      const packagedSource = base ? await this.#officialSource(base.root, base.manifest) : undefined;
      const source = packagedSource ?? this.#options.source!;
      const baseManifest = base?.manifest ?? release.manifest;
      if (!packagedSource && source.archivePath && (!baseManifest.sourceTreeHash || source.treeHash !== baseManifest.sourceTreeHash ||
          baseManifest.sourceCommit && source.commit !== baseManifest.sourceCommit)) {
        throw new CustomizationError("customization_source_unavailable", "当前尚未准备与运行版本匹配的源码归档。");
      }
      const targetCommit = !source.archivePath && baseManifest.sourceCommit &&
        (baseManifest.sourceCommit !== source.commit || baseManifest.sourceTreeHash && source.treeHash && baseManifest.sourceTreeHash !== source.treeHash) ? baseManifest.sourceCommit : undefined;
      const snapshot = await prepareCustomizationSource(source, path.join(workRoot, "source"), workRoot, signal, targetCommit);
      if (baseManifest.sourceTreeHash && snapshot.sourceTreeHash !== baseManifest.sourceTreeHash) throw new CustomizationError("source_version_changed", "候选源码与运行基线的实际源树不一致。");
      const baseRoot = await customizationPrivateDirectory(path.join(this.#root, "bases", id));
      for (const relative of Object.keys(snapshot.files)) {
        try { customizationEditablePath(relative); } catch (error) { if (error instanceof CustomizationError) continue; throw error; }
        const content = await fs.readFile(path.join(workRoot, "source", relative));
        if (content.length > 2 * 1024 * 1024 || content.includes(0)) continue;
        const destination = path.join(baseRoot, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await fs.writeFile(destination, content, { mode: 0o600 });
      }
      let inheritedChanges: string[] = [];
      if (release.manifest.customizationRevision) {
        const revision = await this.#sourceRevision(release.manifest.customizationRevision);
        inheritedChanges = revision.changes.map((change) => change.path);
        const merged = await mergeCustomizationChanges({ sourceRoot: path.join(workRoot, "source"), workRoot, changes: revision.changes, signal });
        if (merged.conflicts.length) throw new CustomizationError("customization_source_conflict", "本机源码与已有定制存在冲突，已保留当前环境。");
      }
      const session: SourceSession = { formatVersion: 1, id, ownerId: caller.id, summary: input.summary.trim(), status: "prepared", revision: 1,
        baseReleaseId: release.id, officialVersion: release.manifest.version, source: snapshot, changedFiles: inheritedChanges, createdAt: this.#now(), updatedAt: this.#now() };
      await this.#save(session); await atomicJson(path.join(this.#root, "active-session.json"), { id });
      return this.#view(session);
      } catch (error) {
        if (ownsWork && !(error instanceof CustomizationError && error.code === "customization_cleanup_pending") && !await readJson(this.#sessionPath(id))) await this.#releaseWorkspace(id);
        throw error;
      }
    });
  }
  async read(sessionId: string, relative: string, caller: CustomizationCaller) {
    const session = await this.#session(sessionId, caller); customizationEditablePath(relative);
    const file = await customizationSourceFile(path.join(this.#work(session.id), "source"), relative);
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new CustomizationError("customization_file_limit", "候选文本文件过大。");
    const content = await fs.readFile(file, "utf8");
    if (content.includes("\0")) throw new CustomizationError("customization_binary_change", "此入口只读取文本源码。");
    return { sessionId, path: relative, revision: session.revision, content: this.#redact(content) };
  }
  async write(sessionId: string, relative: string, content: string | null, expectedRevision: number, caller: CustomizationCaller) {
    this.#authorize(caller, true);
    return this.#exclusive(sessionId, async () => {
    const session = await this.#session(sessionId, caller); customizationEditablePath(relative);
    if (!["prepared", "failed", "conflict"].includes(session.status) || session.revision !== expectedRevision) {
      throw new CustomizationError("customization_revision_conflict", "候选已变化或正在验证，请重新读取。");
    }
    if (content !== null && (typeof content !== "string" || Buffer.byteLength(content) > 2 * 1024 * 1024 || content.includes("\0"))) throw new CustomizationError("customization_file_limit", "候选源码内容无效或过大。", 400);
    const file = await customizationSourceFile(path.join(this.#work(session.id), "source"), relative, content !== null);
    let before: string | null = null;
    try { before = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assertCustomizationDataCompatibility(relative, before, content);
    if (content === null) await fs.rm(file);
    else { const temporary = file + "." + randomUUID() + ".tmp"; try { await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); } }
    const targetHash = content === null ? undefined : createHash("sha256").update(content).digest("hex");
    const changedFiles = new Set(session.changedFiles ?? []);
    if (targetHash === session.source.files[relative]) changedFiles.delete(relative); else changedFiles.add(relative);
    session.changedFiles = [...changedFiles].sort();
    session.revision++; session.status = "prepared"; delete session.error; await this.#save(session);
    return this.#view(session);
    });
  }
  async #revision(session: SourceSession, changes: CustomizationFileChange[]): Promise<SourceRevision> {
    const id = createHash("sha256").update(JSON.stringify([session.source.sourceCommit, session.source.sourceTreeHash, changes])).digest("hex");
    const revision: SourceRevision = { formatVersion: 1, id, sourceCommit: session.source.sourceCommit,
      sourceTreeHash: session.source.sourceTreeHash, changes, createdAt: this.#now() };
    if (Buffer.byteLength(JSON.stringify(revision)) > 16 * 1024 * 1024) throw new CustomizationError("customization_revision_limit", "本次源码修订超过本地历史大小限制。");
    const existing = await readJson(path.join(this.#root, "revisions", id + ".json"), 32 * 1024 * 1024);
    if (!existing) await atomicJson(path.join(this.#root, "revisions", id + ".json"), revision);
    return revision;
  }
  async #buildAndStage(session: SourceSession, caller: CustomizationCaller, signal: AbortSignal, baseReleaseId?: string) {
    const runner = this.#options.runner!;
    const workRoot = this.#work(session.id), sourceRoot = path.join(workRoot, "source"), outputRoot = path.join(workRoot, "payload");
    const changes = await customizationChanges(sourceRoot, path.join(this.#root, "bases", session.id), session.source);
    if (!changes.length) throw new CustomizationError("customization_unchanged", "候选没有实际源码修改。");
    session.status = "validating"; session.changedFiles = changes.map((change) => change.path); delete session.error; await this.#save(session);
    await fs.rm(outputRoot, { recursive: true, force: true });
    const state = await this.#options.recovery.inspect(), preparedBase = state.pending ?? state.current;
    if (!preparedBase || preparedBase.id !== session.baseReleaseId) throw new CustomizationError("customization_base_changed", "运行版本在验证期间已更新，请重新准备。");
    const foundationId = baseReleaseId ?? preparedBase.manifest.baseReleaseId ?? preparedBase.id;
    const foundation = state.releases.find((release) => release.id === foundationId);
    if (!foundation) throw new CustomizationError("customization_base_missing", "定制基线制品已不可用，已保留当前运行版本。");
    const foundationManifest = await readReleaseManifest(foundation.root);
    if (foundationManifest.id !== foundation.id || foundationManifest.artifactHash !== foundation.manifest.artifactHash) throw new CustomizationError("customization_base_changed", "基线运行制品身份发生变化，已保留当前版本。");
    await verifyRelease(foundation.root, foundationManifest, { full: true });
    const build = await runner.build({ workRoot, sourceRoot, outputRoot, basePayloadRoot: foundation.root, baseReleaseId: foundationId, signal });
    if (!["typecheck", "build", "build:web", "runtime:base-reused", "test", "candidate-test-plan:web-v1", "frontend-regression", "host-native:not-rerun"].every((check) => build.checks.includes(check))) throw new CustomizationError("customization_validation_missing", "源码定制缺少本阶段必要验证结果。");
    const after = await customizationChanges(sourceRoot, path.join(this.#root, "bases", session.id), session.source);
    if (JSON.stringify(after) !== JSON.stringify(changes)) throw new CustomizationError("customization_source_changed", "验证期间源码发生变化，请重新验证。");
    const revision = await this.#revision(session, changes);
    const effective = await this.#effective();
    if (effective.id !== session.baseReleaseId) throw new CustomizationError("customization_base_changed", "运行版本在验证期间已更新，请重新准备。");
    let manifest = await createReleaseManifest(outputRoot, { version: session.officialVersion, kind: "custom", sourceCommit: session.source.sourceCommit,
      sourceTreeHash: (await customizationSourceIdentity(sourceRoot)).treeHash,
      baseReleaseId: foundationId,
      customizationRevision: revision.id, shellVersion: this.#options.shellVersion ?? effective.manifest.shellVersion,
      protocolVersion: effective.manifest.protocolVersion, dataVersion: effective.manifest.dataVersion,
      minDataVersion: effective.manifest.minDataVersion, maxDataVersion: effective.manifest.maxDataVersion, checks: [...build.checks, "validation-base:" + foundationId] });
    await verifyRelease(outputRoot, manifest, { full: true });
    const probe = await runner.probe({ workRoot, payloadRoot: outputRoot, runtimeEntry: manifest.runtimeEntry, webDir: manifest.webDir, signal });
    await verifyRelease(outputRoot, manifest, { full: true });
    const validatedArtifactHash = manifest.artifactHash;
    manifest = await createReleaseManifest(outputRoot, { ...manifest, checks: [...manifest.checks, ...probe.checks] });
    if (manifest.artifactHash !== validatedArtifactHash) throw new CustomizationError("customization_artifact_changed", "验证后的运行制品发生变化，请重新验证。");
    await verifyRelease(outputRoot, manifest, { full: true });
    if (signal.aborted) throw new DOMException("定制操作已取消。", "AbortError");
    const record = await this.#options.recovery.stageRelease(outputRoot, manifest, { schedule: true, expectedBaseId: session.baseReleaseId });
    session.status = "pending"; session.releaseId = record.id; session.source.files = {}; session.source.scripts = {}; await this.#save(session);
    await this.#releaseWorkspace(session.id); await this.#prune();
    return { ...(await this.#view(session)), result: "准备完成，下次打开时生效。" };
  }
  async validateAndStage(sessionId: string, caller: CustomizationCaller) {
    this.#authorize(caller, true);
    const session = await this.#session(sessionId, caller);
    if (session.status === "pending") return { ...(await this.#view(session)), result: "准备完成，下次打开时生效。" };
    if (!this.#options.runner || !["prepared", "failed", "conflict"].includes(session.status)) throw new CustomizationError("customization_not_ready", "此定制尚不能验证。");
    return this.#exclusive(session.id, async (signal) => {
      try { return await this.#buildAndStage(session, caller, signal); }
      catch (error) {
        session.status = signal.aborted ? "cancelled" : "failed"; session.error = this.#redact(error instanceof Error ? error.message : "定制未完成。");
        await this.#save(session);
        if (!(error instanceof CustomizationError && error.code === "customization_cleanup_pending")) await this.#releaseBuildCache(session.id);
        throw error;
      }
    });
  }
  async installOfficial(packageName: string | undefined, caller: CustomizationCaller): Promise<unknown> {
    this.#authorize(caller, true);
    const download = packageName === undefined || packageName === "";
    if (download) {
      if (!this.#options.updateFeedUrl || !this.#options.fetch || !this.#options.updateInboxRoot) throw new CustomizationError("official_updates_unconfigured", "当前安装包尚未配置可信官方更新来源。");
    } else customizationIdentifier(packageName!);
    if (!this.#options.updateInboxRoot || !this.#options.runner) throw new CustomizationError("official_updates_unconfigured", "当前安装包尚未配置可信官方更新来源。");
    return this.#exclusive(download ? "official-download" : "official-" + createHash("sha256").update(packageName!).digest("hex").slice(0, 24), async (signal) => {
      let downloaded: string | undefined, cleanupAllowed = true;
      try {
        if (download) downloaded = await fetchSignedCustomizationUpdate({
          feedUrl: this.#options.updateFeedUrl!, inboxRoot: this.#options.updateInboxRoot!, trustedKeys: this.#options.trustedUpdateKeys ?? {},
          fetch: this.#options.fetch!, signal, allowLocalFeed: this.#options.allowLocalFeed, ownerId: this.#downloadOwner(),
        });
        return await this.#installOfficialPackage(downloaded ?? packageName!, caller, signal);
      } catch (error) {
        if (error instanceof CustomizationError && error.code === "customization_cleanup_pending") cleanupAllowed = false;
        throw error;
      } finally {
        if (downloaded && cleanupAllowed) await cleanupManagedCustomizationUpdates({ inboxRoot: this.#options.updateInboxRoot!, ownerId: this.#downloadOwner(), packageName: downloaded });
      }
    });
  }
  async #installOfficialPackage(packageName: string, caller: CustomizationCaller, signal: AbortSignal): Promise<unknown> {
    const id = "update-" + createHash("sha256").update(packageName).digest("hex").slice(0, 24);
    const current = await this.#effective();
    const { root, envelope } = await readSignedCustomizationUpdate({ inboxRoot: this.#options.updateInboxRoot!, packageName, trustedKeys: this.#options.trustedUpdateKeys ?? {} });
    if (envelope.manifest.dataVersion !== current.manifest.dataVersion) throw new CustomizationError("customization_data_migration_unsupported", "此更新需要数据格式迁移，当前安装尚未支持安全迁移，已保留当前版本。");
    const workRoot = await customizationPrivateDirectory(this.#work(id));
    let cleanupAllowed = true;
    try {
      const probe = await this.#options.runner!.probe({ workRoot, payloadRoot: root, runtimeEntry: envelope.manifest.runtimeEntry, webDir: envelope.manifest.webDir, signal });
      if (!probe.checks.length) throw new CustomizationError("customization_validation_missing", "更新缺少本机运行验证。");
      if (current.manifest.customizationRevision) {
        const packagedSource = await this.#officialSource(root, envelope.manifest);
        const fallback = this.#options.source;
        const sourceDefinition = packagedSource ?? (fallback?.archivePath && (!envelope.manifest.sourceTreeHash || fallback.treeHash !== envelope.manifest.sourceTreeHash ||
          envelope.manifest.sourceCommit && fallback.commit !== envelope.manifest.sourceCommit) ? undefined : fallback);
        if (!sourceDefinition || !sourceDefinition.archivePath && !envelope.manifest.sourceCommit) return { status: "deferred", result: "本次更新暂未应用，当前定制可继续使用。", reason: "matching-source-unavailable" };
        const revision = await this.#sourceRevision(current.manifest.customizationRevision);
        const sourceRoot = path.join(workRoot, "source");
        const source = await prepareCustomizationSource(sourceDefinition, sourceRoot, workRoot, signal, sourceDefinition.archivePath ? undefined : envelope.manifest.sourceCommit);
        if (envelope.manifest.sourceTreeHash && source.sourceTreeHash !== envelope.manifest.sourceTreeHash) return {
          status: "deferred", result: "本次更新暂未应用，当前定制可继续使用。", reason: "matching-source-unavailable",
        };
        const baseRoot = await customizationPrivateDirectory(path.join(this.#root, "bases", id));
        for (const relative of Object.keys(source.files)) {
          try { customizationEditablePath(relative); } catch (error) { if (error instanceof CustomizationError) continue; throw error; }
          const content = await fs.readFile(path.join(sourceRoot, relative));
          if (content.length > 2 * 1024 * 1024 || content.includes(0)) continue;
          const target = path.join(baseRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, content, { mode: 0o600 });
        }
        const merged = await mergeCustomizationChanges({ sourceRoot, workRoot, changes: revision.changes, signal });
        if (merged.conflicts.length) return { status: "deferred", result: "本次更新暂未应用，当前定制可继续使用。", reason: "source-conflict", conflicts: merged.conflicts };
        const official = await this.#options.recovery.stageRelease(root, envelope.manifest, { schedule: false });
        const session: SourceSession = { formatVersion: 1, id, ownerId: caller.id, summary: "保留定制升级", status: "prepared", revision: 1,
          baseReleaseId: current.id, officialVersion: envelope.manifest.version, source, createdAt: this.#now(), updatedAt: this.#now() };
        await this.#save(session);
        return await this.#buildAndStage(session, caller, signal, official.id);
      }
      if (signal.aborted) throw new DOMException("更新已取消。", "AbortError");
      const record = await this.#options.recovery.stageRelease(root, envelope.manifest, { schedule: true, expectedBaseId: current.id });
      return { status: "pending", releaseId: record.id, result: "更新准备完成，下次打开时生效。" };
    } catch (error) {
      if (error instanceof CustomizationError && error.code === "customization_cleanup_pending") cleanupAllowed = false;
      throw error;
    } finally { if (cleanupAllowed) await this.#releaseWorkspace(id); }
  }
  async cancel(sessionId: string, caller: CustomizationCaller) {
    this.#authorize(caller, true);
    let session = await this.#session(sessionId, caller);
    if (this.#running?.id === sessionId) {
      const operation = this.#running; operation.controller.abort(); await operation.promise.catch(() => {});
    }
    session = await this.#session(sessionId, caller);
    const pending = (await this.#options.recovery.inspect()).pending;
    if (session.status === "pending" || pending && pending.id !== session.baseReleaseId) throw new CustomizationError("customization_already_staged", "此修改已提交为待更新版本，取消未执行，请通过恢复入口撤回。");
    session.status = "cancelled"; session.revision++; session.source.files = {}; session.source.scripts = {}; await this.#save(session); await this.#releaseWorkspace(session.id); await this.#prune();
    return this.#view(session);
  }
  async #releaseWorkspace(id: string) {
    await fs.rm(this.#work(id), { recursive: true, force: true });
    await fs.rm(path.join(this.#root, "bases", id), { recursive: true, force: true });
  }
  async #releaseBuildCache(id: string) {
    const root = this.#work(id);
    for (const name of ["payload", ".store", ".tmp"]) await fs.rm(path.join(root, name), { recursive: true, force: true });
    const walk = async (directory: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(directory, entry.name);
        if (["node_modules", "dist", "coverage", ".cache"].includes(entry.name)) await fs.rm(child, { recursive: true, force: true });
        else await walk(child);
      }
    };
    await walk(path.join(root, "source"));
  }
  async #prune() {
    const state = await this.#options.recovery.inspect();
    const protectedIds = new Set(state.protectedReleaseIds);
    const retained = new Set(state.releases.filter((release) => protectedIds.has(release.id))
      .map((release) => release.manifest.customizationRevision).filter((value): value is string => Boolean(value)));
    const revisionsRoot = path.join(this.#root, "revisions");
    let files: string[];
    try { files = await fs.readdir(revisionsRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files = []; else throw error; }
    const records: { file: string; id: string; time: number; bytes: number }[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const stat = await fs.lstat(path.join(revisionsRoot, file));
      if (stat.isFile() && !stat.isSymbolicLink()) records.push({ file, id: file.slice(0, -5), time: stat.mtimeMs, bytes: stat.size });
    }
    records.sort((a, b) => b.time - a.time);
    let count = 0, bytes = 0;
    for (const record of records) {
      if (retained.has(record.id)) { bytes += record.bytes; continue; }
      count++; bytes += record.bytes;
      if (count > 200 || this.#now() - record.time > 90 * 86400_000 || bytes > 64 * 1024 * 1024) { await fs.unlink(path.join(revisionsRoot, record.file)); bytes -= record.bytes; }
    }
    const sessionsRoot = path.join(this.#root, "sessions"), active = await readJson(path.join(this.#root, "active-session.json"), 1000);
    const sessions = (await fs.readdir(sessionsRoot)).filter((file) => /^(?:custom|update)-[a-f0-9]{24}\.json$/.test(file));
    const ordered = await Promise.all(sessions.map(async (file) => ({ file, stat: await fs.lstat(path.join(sessionsRoot, file)) })));
    ordered.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let sessionBytes = 0, sessionCount = 0;
    for (const entry of ordered) {
      if (!entry.stat.isFile() || entry.stat.isSymbolicLink()) continue;
      const id = entry.file.slice(0, -5);
      if (object(active) && active.id === id || this.#running?.id === id) continue;
      sessionCount++; sessionBytes += entry.stat.size;
      if (sessionCount > 200 || sessionBytes > 4 * 1024 * 1024 || this.#now() - entry.stat.mtimeMs > 90 * 86400_000) {
        await fs.unlink(path.join(sessionsRoot, entry.file)); sessionBytes -= entry.stat.size;
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (!this.#running) return;
    const operation = this.#running; operation.controller.abort(); await operation.promise.catch(() => {});
  }
}
