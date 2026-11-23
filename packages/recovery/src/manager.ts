import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RecoveryInspection, RecoveryLaunch, RecoveryManagerOptions, RecoveryReleaseIdentity, RecoveryReleaseManifest, RecoveryReleaseRecord, RecoverySession, RecoveryTransaction } from "./types.js";
import { alive, atomicJson, clearWindowsReadonlyTreeSync, dataDirectory, fail, inside, operationLock, privateDirectory, readJson, readText, redact } from "./files.js";
import { releaseId, releaseIdentity, validateReleaseIdentity, validateReleaseManifest, verifyRelease, verifyReleaseIdentity, writeReleaseManifest } from "./manifest.js";

interface StoredRelease {
  id: string;
  root: string;
  managed: boolean;
  registeredAt: number;
  status: RecoveryReleaseRecord["status"];
  bytes: number;
  identityHash: string;
  readyAt?: number;
  normalLaunches?: number;
  usedMs?: number;
  startupInterruptions?: number;
}

interface Catalog {
  formatVersion: 1;
  revision: number;
  current?: string;
  pending?: string;
  baseline?: string;
  history: string[];
  stable?: string;
  releases: Record<string, StoredRelease>;
  session?: RecoverySession;
  transaction?: RecoveryTransaction;
}

interface DiagnosticEvent { at: number; kind: string; releaseId?: string; detail?: string }
interface FileIntent {
  id: string;
  kind: "install" | "delete";
  releaseId: string;
  stage?: string;
  managed: boolean;
  createdAt: number;
}
const DEFAULT_BUDGET = 4 * 1024 ** 3;
// The desktop owns the other 8 MiB of the shared diagnostic allowance.
const LOG_LIMIT = 8 * 1024 ** 2;
const EMPTY = (): Catalog => ({ formatVersion: 1, revision: 0, history: [], releases: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_catalog", "恢复索引无效。");
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("invalid_catalog", "恢复索引数值无效。");
  return value;
}

export class RecoveryManager {
  readonly dataDir: string;
  readonly recoveryDir: string;
  readonly versionsDir: string;
  readonly #options: RecoveryManagerOptions;
  readonly #now: () => number;
  readonly #alive: (pid: number) => boolean;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, options: RecoveryManagerOptions = {}) {
    this.dataDir = dataDirectory(dataDir);
    this.recoveryDir = path.join(this.dataDir, "recovery");
    this.versionsDir = path.join(this.dataDir, "versions");
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#alive = options.isProcessAlive ?? alive;
    if (options.maxStorageBytes !== undefined && (!Number.isSafeInteger(options.maxStorageBytes) || options.maxStorageBytes < 1)) fail("invalid_budget", "恢复空间预算无效。");
  }

  #paths() {
    return {
      catalog: path.join(this.recoveryDir, "catalog.json"),
      previous: path.join(this.recoveryDir, "catalog.previous.json"),
      manifests: path.join(this.recoveryDir, "manifests"),
      transactions: path.join(this.recoveryDir, "transactions"),
      diagnostics: path.join(this.recoveryDir, "diagnostics"),
      log: path.join(this.recoveryDir, "diagnostics", "events.jsonl"),
      intents: path.join(this.recoveryDir, "file-intents.json"),
    };
  }

  #ensure(): void {
    privateDirectory(this.dataDir);
    privateDirectory(this.recoveryDir);
    privateDirectory(this.versionsDir);
    for (const directory of [this.#paths().manifests, this.#paths().transactions, this.#paths().diagnostics]) privateDirectory(directory);
    const readme = path.join(this.recoveryDir, "README.md");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme,
      "# Kulo recovery\n\nRun kulo-rescue inspect --data-dir <this application's data directory> --json first.\n" +
      "The tool does not import Hub, Env or user customizations. Do not overwrite a live database.\n" +
      "Use versions to inspect compatible local payloads; rollback refuses active desktop or backend processes.\n" +
      "After interrupted source customization, cleanup uses only the bundled verified native component; receipt commands are never executed.\n" +
      "The catalog, manifests and unfinished transactions are recovery state, not disposable log files.\n" +
      "No credentials or browser profile should be attached to a diagnostic export.\n", { mode: 0o600, flag: "wx" });
  }

  #validateCatalog(raw: unknown): Catalog {
    const value = object(raw);
    if (value.formatVersion !== 1 || !Array.isArray(value.history) || value.history.length > 2) fail("invalid_catalog", "恢复索引格式无效。");
    const records = object(value.releases);
    if (Object.keys(records).length > 256) fail("invalid_catalog", "恢复索引超过容量限制。");
    const releases: Catalog["releases"] = {};
    for (const [id, rawRecord] of Object.entries(records)) {
      releaseId(id);
      const r = object(rawRecord);
      if (r.id !== id || typeof r.root !== "string" || !path.isAbsolute(r.root) || path.resolve(r.root) !== r.root || typeof r.managed !== "boolean" ||
          !["baseline", "staged", "ready", "failed"].includes(String(r.status))) fail("invalid_catalog", "恢复版本引用无效。");
      if (r.managed && r.root !== this.#payloadPath(id)) fail("unsafe_release_root", "受管版本根目录无效。");
      releases[id] = {
        id, root: r.root, managed: r.managed, registeredAt: integer(r.registeredAt),
        status: r.status as StoredRelease["status"], bytes: integer(r.bytes),
        identityHash: typeof r.identityHash === "string" && /^[a-f0-9]{64}$/.test(r.identityHash) ? r.identityHash : fail("invalid_catalog", "恢复清单摘要无效。"),
        ...(r.readyAt === undefined ? {} : { readyAt: integer(r.readyAt) }),
        ...(r.normalLaunches === undefined ? {} : { normalLaunches: integer(r.normalLaunches) }),
        ...(r.usedMs === undefined ? {} : { usedMs: integer(r.usedMs) }),
        ...(r.startupInterruptions === undefined ? {} : { startupInterruptions: integer(r.startupInterruptions) }),
      };
    }
    const ref = (input: unknown): string | undefined => {
      if (input === undefined) return undefined;
      const id = releaseId(input);
      if (!releases[id]) fail("invalid_catalog", "恢复索引引用了不存在的版本。");
      return id;
    };
    const catalog: Catalog = {
      formatVersion: 1, revision: integer(value.revision),
      current: ref(value.current), pending: ref(value.pending), baseline: ref(value.baseline), stable: ref(value.stable),
      history: value.history.map((id) => ref(id)!), releases,
    };
    if (new Set(catalog.history).size !== catalog.history.length) fail("invalid_catalog", "恢复历史包含重复版本。");
    if (value.session !== undefined) {
      const session = object(value.session);
      if (typeof session.attemptId !== "string" || !/^attempt_[a-f0-9-]{36}$/.test(session.attemptId) || !Array.isArray(session.childPids) || session.childPids.length > 16) fail("invalid_catalog", "恢复会话无效。");
      catalog.session = {
        attemptId: session.attemptId, releaseId: ref(session.releaseId)!, pid: integer(session.pid, 1),
        childPids: session.childPids.map((pid) => integer(pid, 1)), startedAt: integer(session.startedAt),
        ...(session.readyAt === undefined ? {} : { readyAt: integer(session.readyAt) }),
      };
    }
    if (value.transaction !== undefined) {
      const t = object(value.transaction);
      if (typeof t.id !== "string" || !/^transaction_[a-f0-9-]{36}$/.test(t.id) || !["prepared", "activating", "committed", "reverted"].includes(String(t.phase))) fail("invalid_catalog", "恢复事务无效。");
      const active = !["committed", "reverted"].includes(String(t.phase));
      catalog.transaction = {
        id: t.id,
        from: t.from === undefined ? undefined : active ? ref(t.from) : releaseId(t.from),
        target: active ? ref(t.target)! : releaseId(t.target), phase: t.phase as RecoveryTransaction["phase"], startedAt: integer(t.startedAt),
        ...(t.finishedAt === undefined ? {} : { finishedAt: integer(t.finishedAt) }),
        ...(t.error === undefined ? {} : { error: typeof t.error === "string" ? redact(t.error) : fail("invalid_catalog", "恢复错误记录无效。") }),
      };
    }
    return catalog;
  }

  #read(): { catalog: Catalog; warnings: string[] } {
    const paths = this.#paths();
    if (!fs.existsSync(paths.catalog) && !fs.existsSync(paths.previous)) return { catalog: EMPTY(), warnings: [] };
    let original: unknown;
    try { return { catalog: this.#validateCatalog(readJson(paths.catalog)), warnings: [] }; }
    catch (error) { original = error; }
    try { return { catalog: this.#validateCatalog(readJson(paths.previous)), warnings: ["恢复索引已从上一有效副本读取。"] }; }
    catch {
      if (original instanceof Error && "code" in original && original.code === "EACCES") throw original;
      return fail("catalog_corrupt", "恢复索引及其上一副本均不可读取，请保全数据并使用本地修复资料。");
    }
  }

  #write(catalog: Catalog): void {
    this.#validateCatalog(catalog);
    const files = this.#paths();
    if (fs.existsSync(files.catalog)) {
      try { const before = this.#validateCatalog(readJson(files.catalog)); atomicJson(files.previous, before); }
      catch (error) {
        if (!fs.existsSync(files.previous)) throw error;
        this.#validateCatalog(readJson(files.previous));
      }
    }
    catalog.revision++;
    if (catalog.transaction) atomicJson(path.join(files.transactions, catalog.transaction.id + ".json"), catalog.transaction);
    atomicJson(files.catalog, catalog);
  }

  #event(event: Omit<DiagnosticEvent, "at">): void {
    const file = this.#paths().log;
    const current = fs.existsSync(file) ? fs.lstatSync(file) : undefined;
    if (current && (!current.isFile() || current.isSymbolicLink())) fail("unsafe_diagnostic_file", "诊断日志文件无效。");
    const line = JSON.stringify({ at: this.#now(), ...event, ...(event.detail ? { detail: redact(event.detail) } : {}) }) + "\n";
    if (current && (current.size + Buffer.byteLength(line) > LOG_LIMIT || this.#now() - (current.birthtimeMs || current.mtimeMs) > 14 * 24 * 60 * 60 * 1000)) fs.rmSync(file);
    fs.appendFileSync(file, line, { mode: 0o600 });
  }

  #mutate<T>(operation: (catalog: Catalog) => Promise<T> | T): Promise<T> {
    const pending = this.#queue.then(async () => {
      this.#ensure();
      const release = operationLock(this.recoveryDir, this.#alive);
      try {
        const loaded = this.#read();
        if (loaded.warnings.length) fail("catalog_recovery_required", "恢复索引损坏；已保留只读诊断，确认进程状态前不能修改版本。");
        const catalog = loaded.catalog;
        await this.#resumeFileIntents(catalog);
        return await operation(catalog);
      } finally { release(); }
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  #manifestPath(id: string): string { return path.join(this.#paths().manifests, releaseId(id) + ".json"); }
  #readFileIntents(): FileIntent[] {
    const filename = this.#paths().intents;
    if (!fs.existsSync(filename)) return [];
    const input = readJson(filename, 64 * 1024);
    if (!Array.isArray(input) || input.length > 512) fail("invalid_file_intents", "制品恢复待办无效。");
    return input.map((raw) => {
      const value = object(raw);
      if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) || !["install", "delete"].includes(String(value.kind)) || typeof value.managed !== "boolean" ||
          value.stage !== undefined && (typeof value.stage !== "string" || !/^\.stage-[a-f0-9-]{36}$/.test(value.stage))) fail("invalid_file_intents", "制品恢复待办无效。");
      return { id: value.id, kind: value.kind as FileIntent["kind"], releaseId: releaseId(value.releaseId), managed: value.managed, ...(value.stage === undefined ? {} : { stage: value.stage as string }), createdAt: integer(value.createdAt) };
    });
  }
  #addIntent(intent: FileIntent): void { atomicJson(this.#paths().intents, [...this.#readFileIntents(), intent]); }
  #clearIntent(id: string): void { atomicJson(this.#paths().intents, this.#readFileIntents().filter((intent) => intent.id !== id)); }
  #owner(directory: string): string { return path.join(directory, ".kulo-owned.json"); }
  #owned(directory: string, id: string, intentId?: string): boolean {
    if (!fs.existsSync(directory)) return false;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_managed_directory", "受管制品目录归属无效。");
    const owner = object(readJson(this.#owner(directory), 4096));
    if (owner.releaseId !== id || intentId !== undefined && owner.intentId !== intentId) fail("unsafe_managed_directory", "受管制品目录归属不匹配。");
    return true;
  }
  async #removeOwned(directory: string, id: string, intentId?: string): Promise<void> {
    if (!fs.existsSync(directory)) return;
    if (!fs.existsSync(this.#owner(directory))) {
      const stat = fs.lstatSync(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(directory).length === 0) { fs.rmdirSync(directory); return; }
      fail("unsafe_managed_directory", "制品目录缺少归属记录，已保留未知内容。");
    }
    if (this.#owned(directory, id, intentId)) {
      clearWindowsReadonlyTreeSync(directory);
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
  async #resumeFileIntents(catalog: Catalog): Promise<void> {
    for (const intent of this.#readFileIntents()) {
      const final = path.dirname(this.#payloadPath(intent.releaseId));
      if (intent.kind === "install") {
        if (!catalog.releases[intent.releaseId]) {
          await this.#removeOwned(final, intent.releaseId, intent.id);
          await fsp.rm(this.#manifestPath(intent.releaseId), { force: true });
          await fsp.rm(this.#identityPath(intent.releaseId), { force: true });
        }
        if (intent.stage) await this.#removeOwned(path.join(this.versionsDir, intent.stage), intent.releaseId, intent.id);
      } else if (!catalog.releases[intent.releaseId]) {
        if (intent.managed) await this.#removeOwned(final, intent.releaseId);
        await fsp.rm(this.#manifestPath(intent.releaseId), { force: true });
        await fsp.rm(this.#identityPath(intent.releaseId), { force: true });
      }
      this.#clearIntent(intent.id);
    }
  }
  #identityPath(id: string): string { return path.join(this.#paths().manifests, releaseId(id) + ".identity.json"); }
  #saveIdentity(identity: RecoveryReleaseIdentity): string {
    atomicJson(this.#identityPath(identity.id), identity);
    return createHash("sha256").update(readText(this.#identityPath(identity.id), 64 * 1024)).digest("hex");
  }
  #payloadPath(id: string): string { return path.join(this.versionsDir, releaseId(id), "payload"); }
  #record(catalog: Catalog, id: string): RecoveryReleaseRecord {
    const record = catalog.releases[releaseId(id)];
    if (!record) return fail("unknown_release", "未找到此本地版本。");
    const text = readText(this.#identityPath(id), 64 * 1024);
    if (createHash("sha256").update(text).digest("hex") !== record.identityHash) fail("release_digest_mismatch", "恢复启动清单摘要不一致。");
    const manifest = validateReleaseIdentity(JSON.parse(text));
    if (manifest.id !== id) fail("release_digest_mismatch", "恢复版本身份不一致。");
    return { ...clone(record), manifest };
  }

  #dataVersion(): number {
    const filename = path.join(this.dataDir, "hub", "state-version.json");
    if (!fs.existsSync(filename)) return this.#options.dataVersion ?? 3;
    const marker = object(readJson(filename, 4096));
    return integer(marker.version, 1);
  }

  #compatible(manifest: RecoveryReleaseManifest | RecoveryReleaseIdentity): boolean {
    const dataVersion = this.#dataVersion();
    return manifest.platform === (this.#options.platform ?? process.platform) &&
      manifest.arch === (this.#options.arch ?? process.arch) &&
      manifest.nodeMajor === (this.#options.nodeMajor ?? Number(process.versions.node.split(".")[0])) &&
      manifest.shellVersion === (this.#options.shellVersion ?? "1") &&
      manifest.protocolVersion === (this.#options.protocolVersion ?? 1) &&
      manifest.dataVersion === (this.#options.dataVersion ?? 3) &&
      manifest.dataVersion === dataVersion &&
      dataVersion >= manifest.minDataVersion && dataVersion <= manifest.maxDataVersion;
  }

  #assertBaseAvailable(catalog: Catalog, manifest: RecoveryReleaseManifest | RecoveryReleaseIdentity): void {
    const visited = new Set([manifest.id]);
    let base = manifest.baseReleaseId;
    while (base) {
      if (visited.has(base)) fail("invalid_base_dependency", "源码基线依赖存在循环，未应用本次修改。");
      visited.add(base);
      if (!catalog.releases[base]) fail("missing_base_release", "此定制所需的源码基线 " + base + " 缺失，不能用其他基础版本代替。");
      base = this.#record(catalog, base).manifest.baseReleaseId;
    }
  }

  #sessionLive(session?: RecoverySession): boolean {
    return Boolean(session && [session.pid, ...session.childPids].some((pid) => this.#alive(pid)));
  }

  #assertOffline(catalog: Catalog): void {
    if (this.#sessionLive(catalog.session)) fail("runtime_active", "Kulo 或后台进程仍在运行，不能离线修改当前版本。");
    const statusFile = path.join(this.dataDir, "desktop-status.json");
    if (fs.existsSync(statusFile)) {
      const status = object(readJson(statusFile, 16384));
      if (typeof status.pid !== "number" || !Number.isSafeInteger(status.pid)) fail("invalid_runtime_status", "桌面运行状态无效，请先检查进程。");
      if (this.#alive(status.pid)) fail("runtime_active", "Kulo 桌面仍在运行，不能离线修改当前版本。");
    }
  }

  async #fallback(catalog: Catalog, failed?: string): Promise<RecoveryReleaseRecord | null> {
    const choices = [...new Set([catalog.transaction?.from, catalog.current, ...catalog.history, catalog.stable, catalog.baseline].filter((id): id is string => Boolean(id)))];
    for (const id of choices) {
      const stored = catalog.releases[id];
      if (id === failed || !stored || stored.status === "failed" || (stored.startupInterruptions ?? 0) >= 2) continue;
      try {
        const record = this.#record(catalog, id);
        if (!this.#compatible(record.manifest)) continue;
        await verifyReleaseIdentity(record.root, record.manifest);
        return record;
      } catch (error) {
        stored.status = "failed";
        this.#event({ kind: "fallback-unavailable", releaseId: id, detail: error instanceof Error ? error.message : "版本不可用。" });
      }
    }
    return null;
  }

  async initializeBaseline(root: string, input: RecoveryReleaseManifest | RecoveryReleaseIdentity): Promise<RecoveryReleaseRecord> {
    const manifest = "files" in input ? releaseIdentity(input) : validateReleaseIdentity(input);
    const canonical = fs.realpathSync(root);
    await verifyReleaseIdentity(canonical, manifest);
    return this.#mutate(async (catalog) => {
      if (!this.#compatible(manifest)) fail("incompatible_release", "基础版本与当前平台、外壳或数据格式不兼容。");
      const oldBaseline = catalog.baseline;
      if (oldBaseline === manifest.id && catalog.releases[manifest.id]?.root === canonical) return this.#record(catalog, manifest.id);
      if (Object.keys(catalog.releases).length >= 200) await this.#gcLocked(catalog, false);
      if (!catalog.releases[manifest.id]) {
        if ("files" in input) atomicJson(this.#manifestPath(manifest.id), validateReleaseManifest(input));
        const identityHash = this.#saveIdentity(manifest);
        catalog.releases[manifest.id] = { id: manifest.id, root: canonical, managed: false, registeredAt: this.#now(), status: "baseline", bytes: 0, identityHash };
      } else if (!catalog.releases[manifest.id]!.managed) catalog.releases[manifest.id]!.root = canonical;
      catalog.baseline = manifest.id;
      if (!catalog.current) { catalog.current = manifest.id; catalog.stable = manifest.id; }
      else if (oldBaseline !== manifest.id && catalog.current === oldBaseline && !catalog.pending) catalog.pending = manifest.id;
      this.#write(catalog);
      return this.#record(catalog, manifest.id);
    });
  }

  async stageRelease(sourceRoot: string, input: RecoveryReleaseManifest, options: { schedule?: boolean; expectedBaseId?: string } = {}): Promise<RecoveryReleaseRecord> {
    const manifest = validateReleaseManifest(input);
    const source = await fsp.realpath(sourceRoot);
    for (const protectedRoot of [this.recoveryDir, this.versionsDir, path.join(this.dataDir, "hub"), path.join(this.dataDir, "chromium"), path.join(this.dataDir, "peer")]) {
      if (inside(protectedRoot, source) || inside(source, protectedRoot)) fail("unsafe_release_source", "不能从运行数据、凭据或恢复目录创建候选版本。");
    }
    await verifyRelease(source, manifest);
    return this.#mutate(async (catalog) => {
      if (options.expectedBaseId !== undefined && releaseId(options.expectedBaseId) !== (catalog.pending ?? catalog.current)) fail("base_release_changed", "当前版本或待应用修改已变化，请重新准备本次修改。");
      if (!this.#compatible(manifest)) fail("incompatible_release", "候选版本与当前平台、外壳或数据格式不兼容。");
      this.#assertBaseAvailable(catalog, manifest);
      if (catalog.releases[manifest.id]?.status === "failed") fail("quarantined_release", "此候选已失败隔离，请生成新的修订。");
      if (catalog.releases[manifest.id]) {
        if (options.schedule) { catalog.pending = manifest.id; this.#write(catalog); }
        return this.#record(catalog, manifest.id);
      }
      const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
      let used = Object.values(catalog.releases).reduce((total, r) => total + (r.managed ? r.bytes : 0), 0);
      if (used + bytes > (this.#options.maxStorageBytes ?? DEFAULT_BUDGET)) {
        await this.#gcLocked(catalog, false, manifest.baseReleaseId ? [manifest.baseReleaseId] : []);
        used = Object.values(catalog.releases).reduce((total, r) => total + (r.managed ? r.bytes : 0), 0);
      }
      if (used + bytes > (this.#options.maxStorageBytes ?? DEFAULT_BUDGET)) fail("storage_budget_exceeded", "恢复空间不足，本次修改尚未应用，当前版本可继续使用。");
      const free = fs.statfsSync(this.versionsDir);
      if (Number(free.bavail) * Number(free.bsize) < bytes + 16 * 1024 ** 2) fail("insufficient_space", "可用磁盘空间不足，本次修改尚未应用。");
      const stage = path.join(this.versionsDir, ".stage-" + randomUUID());
      const final = path.dirname(this.#payloadPath(manifest.id));
      if (fs.existsSync(final)) fail("unowned_release_directory", "版本目录已存在未知内容，未覆盖。");
      const intent: FileIntent = { id: randomUUID(), kind: "install", releaseId: manifest.id, stage: path.basename(stage), managed: true, createdAt: this.#now() };
      this.#addIntent(intent);
      privateDirectory(stage);
      atomicJson(this.#owner(stage), { releaseId: manifest.id, intentId: intent.id });
      const payload = path.join(stage, "payload");
      privateDirectory(payload);
      try {
        for (const entry of manifest.files) {
          const target = path.join(payload, entry.path);
          await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          if (entry.kind === "symlink") await fsp.symlink(entry.target!, target);
          else {
            await fsp.copyFile(path.join(source, entry.path), target, fs.constants.COPYFILE_FICLONE);
            if (process.platform !== "win32") await fsp.chmod(target, entry.executable ? 0o555 : 0o444);
          }
        }
        await verifyRelease(payload, manifest);
        writeReleaseManifest(payload, manifest);
        if (process.platform !== "win32") {
          await fsp.chmod(path.join(payload, "kulo-release.json"), 0o444);
          await fsp.chmod(path.join(payload, "kulo-release.identity.json"), 0o444);
        }
        atomicJson(this.#manifestPath(manifest.id), manifest);
        const identityHash = this.#saveIdentity(releaseIdentity(manifest));
        await fsp.rename(stage, final);
        catalog.releases[manifest.id] = { id: manifest.id, root: this.#payloadPath(manifest.id), managed: true, registeredAt: this.#now(), status: "staged", bytes, identityHash };
        if (options.schedule) catalog.pending = manifest.id;
        this.#event({ kind: "release-staged", releaseId: manifest.id });
        this.#write(catalog);
        this.#clearIntent(intent.id);
        return this.#record(catalog, manifest.id);
      } finally {
        const loaded = this.#read();
        if (!loaded.warnings.length) await this.#resumeFileIntents(loaded.catalog);
      }
    });
  }

  schedule(id: string): Promise<void> {
    return this.#mutate((catalog) => {
      const record = this.#record(catalog, id);
      if (record.status === "failed") fail("quarantined_release", "此候选已失败隔离。");
      if (!this.#compatible(record.manifest)) fail("incompatible_release", "候选版本不兼容。");
      this.#assertBaseAvailable(catalog, record.manifest);
      catalog.pending = id;
      this.#write(catalog);
    });
  }

  async prepareLaunch(): Promise<RecoveryLaunch> {
    return this.#mutate(async (catalog) => {
      if (!catalog.current) fail("not_initialized", "尚未登记基础版本。");
      if (this.#sessionLive(catalog.session)) fail("runtime_active", "已有 Kulo 或后台进程占用此实例。");
      let recovered = false;
      if (catalog.session && !catalog.session.readyAt) {
        const interrupted = catalog.session.releaseId;
        const stored = catalog.releases[interrupted]!;
        stored.startupInterruptions = (stored.startupInterruptions ?? 0) + 1;
        const unchanged = interrupted === catalog.current;
        delete catalog.session;
        if (catalog.transaction) {
          catalog.transaction.phase = "reverted";
          catalog.transaction.finishedAt = this.#now();
          catalog.transaction.error = "启动在就绪前中断。";
        }
        this.#event({ kind: "launch-interrupted", releaseId: interrupted, detail: String(stored.startupInterruptions) });
        if (!unchanged || stored.startupInterruptions >= 2) {
          if (!unchanged) stored.status = "failed";
          const fallback = await this.#fallback(catalog, interrupted);
          if (catalog.pending === interrupted) delete catalog.pending;
          if (!fallback) {
            this.#write(catalog);
            fail(unchanged ? "startup_recovery_exhausted" : "no_compatible_release",
              unchanged ? "基础版本启动连续中断，已停止自动重试；版本和数据已保留，可从独立修复入口重试。" : "启动中断后没有兼容的本地恢复版本，用户数据已保留。");
          }
          catalog.current = fallback.id;
          recovered = true;
        }
      } else if (catalog.session) delete catalog.session;
      const target = catalog.pending ?? catalog.current;
      if ((catalog.releases[target]?.startupInterruptions ?? 0) >= 2) fail("startup_recovery_exhausted", "此版本启动连续中断，已停止自动重试；可从独立修复入口重试。");
      let record: RecoveryReleaseRecord;
      try {
        record = this.#record(catalog, target);
        if (!this.#compatible(record.manifest) || record.status === "failed") fail("incompatible_release", "目标版本与当前数据或运行环境不兼容。");
        await verifyReleaseIdentity(record.root, record.manifest);
      } catch (error) {
        catalog.releases[target]!.status = "failed";
        const fallback = await this.#fallback(catalog, target);
        if (!fallback) {
          delete catalog.pending;
          this.#write(catalog);
          throw error;
        }
        record = fallback;
        catalog.current = record.id;
        delete catalog.pending;
        recovered = true;
      }
      const attemptId = "attempt_" + randomUUID();
      const previous = catalog.current;
      catalog.session = { attemptId, releaseId: record.id, pid: process.pid, childPids: [], startedAt: this.#now() };
      catalog.transaction = { id: "transaction_" + randomUUID(), from: previous, target: record.id, phase: "activating", startedAt: this.#now() };
      this.#event({ kind: "launch-started", releaseId: record.id });
      this.#write(catalog);
      return { attemptId, releaseId: record.id, root: record.root, manifest: record.manifest, previousReleaseId: previous, recovered };
    });
  }

  trackProcess(attemptId: string, pid: number): Promise<void> {
    return this.#mutate((catalog) => {
      const session = this.#ownSession(catalog, attemptId);
      integer(pid, 1);
      if (!session.childPids.includes(pid)) session.childPids.push(pid);
      if (session.childPids.length > 16) fail("too_many_processes", "恢复会话关联进程过多。");
      this.#write(catalog);
    });
  }

  #ownSession(catalog: Catalog, attemptId: string): RecoverySession {
    if (!catalog.session || catalog.session.attemptId !== attemptId || catalog.session.pid !== process.pid) fail("stale_attempt", "启动状态已被其他操作接管。");
    return catalog.session;
  }

  #selectHistory(catalog: Catalog, current: string, previous?: string): string[] {
    const history = [...new Set([previous, ...catalog.history].filter((id): id is string => Boolean(id && id !== current && catalog.releases[id]?.status !== "failed")))];
    const anchor = catalog.stable && catalog.stable !== current && catalog.releases[catalog.stable]?.status !== "failed" ? catalog.stable : undefined;
    return [...new Set([history[0], anchor, ...history].filter((id): id is string => Boolean(id)))].slice(0, 2);
  }

  markReady(attemptId: string): Promise<void> {
    return this.#mutate((catalog) => {
      const session = this.#ownSession(catalog, attemptId);
      if (session.readyAt) return;
      const before = catalog.current;
      const record = catalog.releases[session.releaseId]!;
      session.readyAt = this.#now();
      record.readyAt = session.readyAt;
      record.normalLaunches = (record.normalLaunches ?? 0) + 1;
      record.startupInterruptions = 0;
      record.status = record.id === catalog.baseline ? "baseline" : "ready";
      catalog.current = record.id;
      if (catalog.pending === record.id) delete catalog.pending;
      catalog.history = this.#selectHistory(catalog, record.id, before);
      if (catalog.transaction) { catalog.transaction.phase = "committed"; catalog.transaction.finishedAt = this.#now(); }
      this.#event({ kind: "launch-ready", releaseId: record.id });
      this.#write(catalog);
    });
  }

  markFailed(attemptId: string, error: unknown): Promise<RecoveryReleaseRecord | null> {
    return this.#mutate(async (catalog) => {
      const session = this.#ownSession(catalog, attemptId);
      const failed = session.releaseId;
      catalog.releases[failed]!.status = "failed";
      const detail = error instanceof Error ? error.message : String(error);
      this.#event({ kind: "launch-failed", releaseId: failed, detail });
      const fallback = await this.#fallback(catalog, failed);
      delete catalog.session;
      delete catalog.pending;
      if (fallback) catalog.current = fallback.id;
      if (catalog.stable === failed) catalog.stable = fallback?.id;
      catalog.history = catalog.history.filter((id) => id !== failed);
      if (catalog.transaction) {
        catalog.transaction.phase = "reverted"; catalog.transaction.finishedAt = this.#now(); catalog.transaction.error = redact(detail);
      }
      this.#write(catalog);
      return fallback;
    });
  }

  markStopped(attemptId?: string): Promise<void> {
    return this.#mutate((catalog) => {
      if (!catalog.session) return;
      const session = this.#ownSession(catalog, attemptId ?? catalog.session.attemptId);
      if (session.childPids.some((pid) => this.#alive(pid))) fail("runtime_active", "后台进程尚未完全结束。");
      const record = catalog.releases[session.releaseId]!;
      if (session.readyAt) {
        record.usedMs = (record.usedMs ?? 0) + Math.max(0, this.#now() - session.readyAt);
        if ((record.normalLaunches ?? 0) >= 2 && record.usedMs >= 24 * 60 * 60 * 1000) catalog.stable = record.id;
      }
      delete catalog.session;
      this.#write(catalog);
    });
  }

  rollback(id?: string): Promise<RecoveryReleaseRecord> {
    return this.#mutate(async (catalog) => {
      this.#assertOffline(catalog);
      const target = id ? this.#record(catalog, id) : await this.#fallback(catalog, catalog.current);
      if (!target) return fail("no_compatible_release", "没有可直接恢复的兼容版本。");
      if (target.status === "failed" || !this.#compatible(target.manifest)) fail("incompatible_release", "目标版本不兼容或已被隔离，用户数据未修改。");
      await verifyReleaseIdentity(target.root, target.manifest);
      const previous = catalog.current;
      catalog.releases[target.id]!.startupInterruptions = 0;
      catalog.current = target.id;
      delete catalog.pending; delete catalog.session;
      catalog.transaction = { id: "transaction_" + randomUUID(), from: previous, target: target.id, phase: "committed", startedAt: this.#now(), finishedAt: this.#now() };
      catalog.history = this.#selectHistory(catalog, target.id, previous);
      this.#event({ kind: "offline-rollback", releaseId: target.id });
      this.#write(catalog);
      return target;
    });
  }

  relocateRelease(id: string, newRoot: string): Promise<void> {
    return this.#mutate(async (catalog) => {
      this.#assertOffline(catalog);
      const record = this.#record(catalog, id);
      if (record.managed) fail("managed_release", "受管制品不能迁出版本目录。");
      const root = await fsp.realpath(newRoot);
      await verifyReleaseIdentity(root, record.manifest);
      catalog.releases[id]!.root = root;
      this.#write(catalog);
    });
  }

  async inspect(): Promise<RecoveryInspection> {
    const { catalog, warnings } = this.#read();
    const releases: RecoveryReleaseRecord[] = [];
    for (const id of Object.keys(catalog.releases)) {
      try { releases.push(this.#record(catalog, id)); }
      catch (error) { warnings.push("无法读取版本 " + id + "：" + redact(error instanceof Error ? error.message : "未知错误")); }
    }
    const hostDataVersion = this.#options.dataVersion ?? 3;
    let diskDataVersion: number | undefined;
    try { diskDataVersion = this.#dataVersion(); }
    catch (error) { warnings.push("无法核对磁盘数据格式，版本切换保持关闭：" + redact(error instanceof Error ? error.message : "未知错误")); }
    for (const record of releases) {
      if (record.manifest.dataVersion !== hostDataVersion || record.manifest.dataVersion !== diskDataVersion) {
        warnings.push("版本 " + record.id + " 的数据写入格式为 " + record.manifest.dataVersion +
          "，当前宿主为 " + hostDataVersion + "、磁盘为 " + (diskDataVersion ?? "无法确认") + "；此构建不执行数据格式迁移，不能应用该版本。");
      }
    }
    const get = (id?: string) => releases.find((record) => record.id === id) ?? null;
    return {
      formatVersion: 1, initialized: Boolean(catalog.current), current: get(catalog.current), pending: get(catalog.pending), baseline: get(catalog.baseline),
      history: catalog.history.map((id) => get(id)).filter((record): record is RecoveryReleaseRecord => record !== null),
      releases, session: catalog.session ? clone(catalog.session) : null, transaction: catalog.transaction ? clone(catalog.transaction) : null, warnings,
      protectedReleaseIds: [...this.#protected(catalog, warnings)].filter((id): id is string => Boolean(id)),
      storage: { managedBytes: releases.reduce((total, record) => total + (record.managed ? record.bytes : 0), 0), budgetBytes: this.#options.maxStorageBytes ?? DEFAULT_BUDGET },
    };
  }

  #protected(catalog: Catalog, warnings?: string[], additionalRoots: readonly string[] = []): Set<string | undefined> {
      const roots = new Set([catalog.current, catalog.pending, catalog.baseline, catalog.stable, ...catalog.history, catalog.session?.releaseId, ...additionalRoots]);
      if (catalog.transaction && !["committed", "reverted"].includes(catalog.transaction.phase)) {
        roots.add(catalog.transaction.from); roots.add(catalog.transaction.target);
      }
      // These are actual source dependencies, unlike completed transactions' historical links.
      const queue = [...roots].filter((id): id is string => Boolean(id));
      const visited = new Set<string>();
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]!;
        if (visited.has(id)) continue;
        visited.add(id);
        if (!catalog.releases[id]) {
          const message = "此定制所需的源码基线 " + id + " 缺失，不能用其他基础版本代替。";
          if (!warnings) fail("missing_base_release", message);
          warnings.push(message);
          continue;
        }
        try {
          const base = this.#record(catalog, id).manifest.baseReleaseId;
          if (base) { roots.add(base); queue.push(base); }
        } catch (error) {
          if (!warnings) throw error;
          const message = "无法核对版本 " + id + " 的源码基线：" + redact(error instanceof Error ? error.message : "未知错误");
          if (!warnings.includes(message)) warnings.push(message);
        }
      }
      return roots;
  }

  async protectedReleaseIds(): Promise<string[]> {
    const loaded = this.#read();
    if (loaded.warnings.length) fail("catalog_recovery_required", "恢复索引损坏，不能确认清理保护范围。");
    return [...this.#protected(loaded.catalog)].filter((id): id is string => Boolean(id));
  }

  withOfflineMaintenance<T>(action: (protectedRecords: RecoveryReleaseRecord[]) => Promise<T>): Promise<T> {
    return this.#mutate(async (catalog) => {
      this.#assertOffline(catalog);
      const records = [...this.#protected(catalog)].filter((id): id is string => Boolean(id)).map((id) => this.#record(catalog, id));
      return action(records);
    });
  }

  async #gcLocked(catalog: Catalog, dryRun: boolean, additionalRoots: readonly string[] = []): Promise<{ removed: string[]; reclaimedBytes: number }> {
      const roots = this.#protected(catalog, undefined, additionalRoots);
      const removed: string[] = [];
      let reclaimedBytes = 0;
      for (const record of Object.values(catalog.releases)) {
        if (roots.has(record.id)) continue;
        const directory = path.dirname(this.#payloadPath(record.id));
        if (record.managed && fs.existsSync(directory)) this.#owned(directory, record.id);
        removed.push(record.id); reclaimedBytes += record.bytes;
      }
      if (dryRun) return { removed, reclaimedBytes };
      // Commit the logical removal first; interrupted deletes leave only reclaimable files.
      for (const id of removed) this.#addIntent({ id: randomUUID(), kind: "delete", releaseId: id, managed: catalog.releases[id]!.managed, createdAt: this.#now() });
      for (const id of removed) delete catalog.releases[id];
      if (removed.length) this.#event({ kind: "history-cleanup-prepared", detail: String(removed.length) + " unreferenced releases" });
      if (removed.length) this.#write(catalog);
      await this.#resumeFileIntents(catalog);
      const transactions = await fsp.readdir(this.#paths().transactions);
      const keepTransaction = catalog.transaction?.id + ".json";
      const expired = transactions.filter((name) => /^transaction_[a-f0-9-]{36}\.json$/.test(name) && name !== keepTransaction)
        .map((name) => ({ name, modifiedAt: fs.lstatSync(path.join(this.#paths().transactions, name)).mtimeMs }))
        .sort((a, b) => a.modifiedAt - b.modifiedAt).map((entry) => entry.name);
      for (const filename of expired.slice(0, Math.max(0, expired.length - 199))) await fsp.rm(path.join(this.#paths().transactions, filename));
      return { removed, reclaimedBytes };
  }

  gc(options: { dryRun?: boolean } = {}): Promise<{ removed: string[]; reclaimedBytes: number }> {
    if (options.dryRun) return this.#gcLocked(this.#read().catalog, true);
    return this.#mutate((catalog) => this.#gcLocked(catalog, options.dryRun ?? false));
  }

  async exportDiagnostics(destinationFile?: string): Promise<Record<string, unknown>> {
    const inspection = await this.inspect();
    const file = this.#paths().log;
    let events: unknown[] = [];
    if (fs.existsSync(file)) {
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) fail("unsafe_diagnostic_file", "诊断日志文件无效。");
        const size = Math.min(stat.size, 256 * 1024);
        const buffer = Buffer.alloc(size);
        fs.readSync(descriptor, buffer, 0, size, stat.size - size);
        const lines = buffer.toString("utf8").split("\n");
        if (stat.size > size) lines.shift();
        events = lines.filter(Boolean).slice(-100).map((line) => {
          try { return JSON.parse(line); } catch { return { detail: "[truncated diagnostic event]" }; }
        });
      } finally { fs.closeSync(descriptor); }
    }
    const diagnostic = JSON.parse(JSON.stringify(
      { formatVersion: 1, exportedAt: this.#now(), dataDir: this.dataDir, inspection, events },
      (_key, value) => typeof value === "string" ? redact(value) : value,
    )) as Record<string, unknown>;
    if (destinationFile) {
      if (!path.isAbsolute(destinationFile) || inside(path.join(this.dataDir, "hub"), destinationFile) || inside(this.versionsDir, destinationFile)) fail("unsafe_export_target", "诊断导出不能覆盖业务数据或版本制品。");
      const target = path.resolve(destinationFile);
      const fd = fs.openSync(target, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(diagnostic, null, 2) + "\n"); } finally { fs.closeSync(fd); }
    }
    return diagnostic;
  }

  async repairInstructions(): Promise<string> {
    const state = await this.inspect();
    return [
      "Kulo 本地修复信息",
      "数据目录：" + this.dataDir,
      "当前版本：" + (state.current?.id ?? "尚未登记"),
      "先使用独立 kulo-rescue 的 inspect --json，只读诊断。",
      "命令参数以数组传递：" + JSON.stringify(["inspect", "--data-dir", this.dataDir, "--json"]),
      "主程序或后台仍运行时不要覆盖文件和数据库。可用版本由 versions 列出；rollback 仅在离线且数据兼容时执行。",
      "源码定制中断后可使用 cleanup 清理受管残留；它只运行独立包内经校验的组件，不执行收据中的命令。",
      "修复代码放入新的候选工作区，验证后通过 stageRelease 安排下次启动；不要修改凭据或直接替换运行中制品。",
      ...state.warnings,
    ].join("\n");
  }
}
