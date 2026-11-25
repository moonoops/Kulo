/**
 * Kulo Identity & Relationship Document Storage & Context Reader (`identity-agreement.md`, `relationship.md`).
 * Strictly private to the Root Kulo Orchestrator; background Workers never read or receive these documents.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  IDENTITY_FILES,
  type IdentityBackup,
  type IdentityDirectoryState,
  type IdentityFile,
  type IdentityList,
  type IdentityRead,
  type IdentityRollbackRequest,
  type IdentitySaved,
  type IdentityVersion,
  type IdentityWriteRequest,
  type KuloLanguage,
} from "@kulo/protocol";

import {
  KULO_IDENTITY_TEMPLATES,
  KULO_IDENTITY_TEMPLATES_ZH,
  getIdentityTemplate,
} from "./prompts/identity-templates.js";

export {
  IDENTITY_FILES,
  KULO_IDENTITY_TEMPLATES,
  KULO_IDENTITY_TEMPLATES_ZH,
  getIdentityTemplate,
};

export const IDENTITY_AGREEMENT_FILE = "identity-agreement.md" as const;

export class IdentityFilesError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 503,
    readonly code: string,
    message: string,
    readonly committed = false,
  ) {
    super(message);
    this.name = "IdentityFilesError";
  }
}

const invalid = (msg = "身份或关系文档请求无效。") =>
  new IdentityFilesError(400, "invalidIdentityRequest", msg);
const conflict = () =>
  new IdentityFilesError(409, "identityConflict", "身份或关系文档已发生变更，请重新加载后再保存。");
const unavailable = () =>
  new IdentityFilesError(503, "identityUnavailable", "身份目录不可用或路径不安全。");

const LIMIT = 64 * 1024;
const META_LIMIT = 8192;
const DEFAULT_BACKUP_LIMIT = 200;
const DEFAULT_BACKUP_BYTES = 16 * 1024 * 1024;

export interface IdentityBackupRetention {
  maxBackups?: number;
  maxBytes?: number;
  protectedBackupIds?: () => readonly string[];
}

export interface KuloIdentityFilesOptions {
  retention?: IdentityBackupRetention;
  getLanguage?: () => KuloLanguage | undefined;
  /** Default Hub-managed `<stateDir>/identity` directory for cross-host backup portability (P0-6). */
  managedDirectory?: string;
}

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;
const wellFormedUtf8 = (value: string): boolean =>
  Buffer.from(value, "utf8").toString("utf8") === value;

function isIdentityFile(value: unknown): value is IdentityFile {
  return typeof value === "string" && (IDENTITY_FILES as readonly string[]).includes(value);
}

function isValidHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateVersion(value: unknown): IdentityVersion {
  if (!value || typeof value !== "object") throw invalid();
  const v = value as Record<string, unknown>;
  if (
    typeof v.directoryRevision !== "number" ||
    !Number.isSafeInteger(v.directoryRevision) ||
    v.directoryRevision < 0
  ) {
    throw invalid();
  }
  if (v.sha256 !== null && !isValidHash(v.sha256)) {
    throw invalid();
  }
  return { directoryRevision: v.directoryRevision, sha256: v.sha256 };
}

function validateSummary(value: unknown): string {
  if (typeof value !== "string" || !wellFormedUtf8(value)) throw invalid("请填写有效的修改说明。");
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 500) {
    throw invalid("修改说明不能为空且不超过 500 字。");
  }
  return trimmed;
}

function validateWriteRequest(value: unknown): IdentityWriteRequest {
  if (!value || typeof value !== "object") throw invalid();
  const obj = value as Record<string, unknown>;
  if (!isIdentityFile(obj.file)) throw invalid();
  if (obj.dualSignConfirmed !== true) {
    throw invalid("必须完成双重确认勾选（dualSignConfirmed: true）后才能写入身份文档。");
  }
  if (typeof obj.content !== "string" || !wellFormedUtf8(obj.content)) {
    throw invalid();
  }
  return {
    file: obj.file,
    expected: validateVersion(obj.expected),
    content: obj.content,
    summary: validateSummary(obj.summary),
    dualSignConfirmed: true,
  };
}

function validateRollbackRequest(value: unknown): IdentityRollbackRequest {
  if (!value || typeof value !== "object") throw invalid();
  const obj = value as Record<string, unknown>;
  if (!isIdentityFile(obj.file)) throw invalid();
  if (obj.dualSignConfirmed !== true) {
    throw invalid("必须完成双重确认勾选（dualSignConfirmed: true）后才能回滚身份文档。");
  }
  if (typeof obj.backupId !== "string" || !obj.backupId || obj.backupId.length > 200) {
    throw invalid();
  }
  return {
    file: obj.file,
    expected: validateVersion(obj.expected),
    backupId: obj.backupId,
    summary: validateSummary(obj.summary),
    dualSignConfirmed: true,
  };
}

interface BackupRecord extends IdentityBackup {
  directoryIdentity: string;
}

function parseBackupRecord(raw: unknown): BackupRecord {
  if (!raw || typeof raw !== "object") throw new InvalidBackup();
  const r = raw as Record<string, unknown>;
  if (
    typeof r.backupId !== "string" ||
    !isIdentityFile(r.file) ||
    typeof r.createdAt !== "string" ||
    Number.isNaN(Date.parse(r.createdAt)) ||
    !isValidHash(r.sha256) ||
    typeof r.previouslyMissing !== "boolean" ||
    typeof r.summary !== "string" ||
    typeof r.directoryIdentity !== "string"
  ) {
    throw new InvalidBackup();
  }
  return {
    backupId: r.backupId,
    file: r.file,
    createdAt: r.createdAt,
    sha256: r.sha256,
    previouslyMissing: r.previouslyMissing,
    summary: r.summary,
    directoryIdentity: r.directoryIdentity,
  };
}

interface Root {
  path: string;
  stat: Stats;
  state: IdentityDirectoryState;
  handle: FileHandle;
}

interface Snapshot {
  bytes: Buffer;
  exists: boolean;
  sha256: string | null;
}

const locks = new Map<string, Promise<void>>();
let lastBackupTime = 0;

async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

const sameObject = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const sameRead = (a: Stats, b: Stats): boolean =>
  sameObject(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const directoryKey = (root: Root): string => `${root.stat.dev}:${root.stat.ino}`;
export const MANAGED_IDENTITY_DIRECTORY_KEY = "managed:identity";

const systemAlias = (target: string): boolean =>
  process.platform === "darwin" &&
  ((target === "/var" && realpathSync(target) === "/private/var") ||
    (target === "/tmp" && realpathSync(target) === "/private/tmp"));

const backupPattern =
  /^(identity-agreement|relationship)\.md\.(\d{8}T\d{9}Z)\.([a-f0-9]{64})\.([a-f0-9]{32})\.bak$/;

class InvalidBackup extends Error {}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw unavailable();
  }
}

function enforceSizeLimit(bytes: Buffer): void {
  if (bytes.length > LIMIT) {
    throw new IdentityFilesError(413, "identityTooLarge", "单份文档大小不能超过 64 KiB。");
  }
}

export class KuloIdentityFiles {
  #onWrite?: () => void;

  constructor(
    private readonly getDirectoryState: () => IdentityDirectoryState,
    private readonly options: KuloIdentityFilesOptions = {},
  ) {
    const policy = options.retention;
    if (policy?.maxBackups !== undefined && (!Number.isSafeInteger(policy.maxBackups) || policy.maxBackups < 2) ||
      policy?.maxBytes !== undefined && (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1)) {
      throw new Error("Invalid identity backup retention limits");
    }
  }

  setOnWrite(hook: (() => void) | undefined): void {
    this.#onWrite = hook;
  }

  private isManagedRoot(root: Root): boolean {
    const managed = this.options.managedDirectory;
    if (!managed) return false;
    const resolvedManaged = resolve(managed);
    if (resolve(root.state.directory) === resolvedManaged || resolve(root.path) === resolvedManaged) {
      return true;
    }
    try {
      return realpathSync(resolvedManaged) === root.path;
    } catch {
      return false;
    }
  }

  private matchesDirectoryIdentity(root: Root, recorded: string): boolean {
    if (recorded === directoryKey(root)) return true;
    return this.isManagedRoot(root) && recorded === MANAGED_IDENTITY_DIRECTORY_KEY;
  }

  private state(): IdentityDirectoryState {
    const state = this.getDirectoryState();
    if (
      !state ||
      typeof state.directory !== "string" ||
      !Number.isSafeInteger(state.directoryRevision) ||
      state.directoryRevision < 0
    ) {
      throw unavailable();
    }
    if (state.directory && (!isAbsolute(state.directory) || state.directory.includes("\0"))) {
      throw unavailable();
    }
    return { ...state };
  }

  private assertState(state: IdentityDirectoryState): void {
    const current = this.state();
    if (
      current.directory !== state.directory ||
      current.directoryRevision !== state.directoryRevision
    ) {
      throw conflict();
    }
  }

  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof IdentityFilesError) throw error;
      throw unavailable();
    }
  }

  private async root(state: IdentityDirectoryState): Promise<Root> {
    if (!state.directory) {
      throw new IdentityFilesError(503, "identityNotConfigured", "请先配置有效的身份目录。");
    }
    const absolute = resolve(state.directory);
    let part = parse(absolute).root;
    for (const segment of absolute.slice(part.length).split(sep).filter(Boolean)) {
      part = join(part, segment);
      const st = await fs.lstat(part);
      if (st.isSymbolicLink() ? !systemAlias(part) : !st.isDirectory()) {
        throw unavailable();
      }
    }
    const resolvedPath = await fs.realpath(absolute);
    const stat = await fs.lstat(resolvedPath);
    const handle = await fs.open(
      resolvedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (!stat.isDirectory() || !sameObject(stat, await handle.stat())) {
        throw unavailable();
      }
      const root: Root = { path: resolvedPath, stat, state, handle };
      await this.assertRoot(root);
      return root;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async assertRoot(root: Root): Promise<void> {
    this.assertState(root.state);
    const stat = await fs.lstat(root.path);
    if (
      !stat.isDirectory() ||
      !sameObject(root.stat, stat) ||
      (await fs.realpath(root.state.directory)) !== root.path
    ) {
      throw unavailable();
    }
    this.assertState(root.state);
  }

  private async readBytes(filePath: string, limit: number): Promise<Buffer | null> {
    let before: Stats;
    try {
      before = await fs.lstat(filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    if (!before.isFile()) throw unavailable();

    const handle = await fs.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameRead(before, opened)) throw conflict();
      if (opened.size > limit) {
        throw new IdentityFilesError(413, "identityTooLarge", "文档大小超出限制。");
      }
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) {
        throw new IdentityFilesError(413, "identityTooLarge", "文档大小超出限制。");
      }
      const after = await handle.stat();
      const linked = await fs.lstat(filePath);
      if (
        !linked.isFile() ||
        !sameRead(opened, after) ||
        !sameRead(after, linked) ||
        after.size !== length
      ) {
        throw conflict();
      }
      return buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  }

  private async snapshot(root: Root, file: IdentityFile): Promise<Snapshot> {
    await this.assertRoot(root);
    const bytes = await this.readBytes(join(root.path, file), LIMIT);
    if (bytes) decodeUtf8(bytes);
    await this.assertRoot(root);
    return {
      bytes: bytes ?? Buffer.alloc(0),
      exists: bytes !== null,
      sha256: bytes === null ? null : digest(bytes),
    };
  }

  private async checked(root: Root, file: IdentityFile, expected: IdentityVersion): Promise<Snapshot> {
    this.assertState(root.state);
    if (expected.directoryRevision !== root.state.directoryRevision) throw conflict();
    const current = await this.snapshot(root, file);
    if (current.sha256 !== expected.sha256) throw conflict();
    return current;
  }

  private async ensureSubdir(dirPath: string, create: boolean): Promise<boolean> {
    let stat: Stats;
    try {
      stat = await fs.lstat(dirPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (!create) return false;
      try {
        await fs.mkdir(dirPath, { mode: 0o700 });
      } catch (mkdirErr) {
        if (errorCode(mkdirErr) !== "EEXIST") throw mkdirErr;
      }
      stat = await fs.lstat(dirPath);
    }
    if (!stat.isDirectory()) throw unavailable();
    const handle = await fs.open(
      dirPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (!sameObject(stat, await handle.stat())) throw unavailable();
      if (create && process.platform !== "win32") await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    return true;
  }

  private async backupDirectory(root: Root, create: boolean): Promise<string | null> {
    await this.assertRoot(root);
    const parent = join(root.path, "backups");
    const target = join(parent, "identity");
    if (!(await this.ensureSubdir(parent, create)) || !(await this.ensureSubdir(target, create))) {
      return null;
    }
    await this.assertRoot(root);
    if (create) {
      await this.syncDirectory(parent);
      await this.syncDirectory(root.path);
    }
    return target;
  }

  private async syncDirectory(dirPath: string): Promise<void> {
    const handle = await fs.open(
      dirPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      try {
        await handle.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "")) {
          throw error;
        }
      }
    } finally {
      await handle.close();
    }
  }

  private publicBackup(record: BackupRecord): IdentityBackup {
    const { directoryIdentity: _id, ...metadata } = record;
    return metadata;
  }

  private async loadBackup(
    root: Root,
    file: IdentityFile,
    backupId: string,
  ): Promise<{ record: BackupRecord; bytes: Buffer }> {
    const match = backupPattern.exec(backupId);
    if (!match || `${match[1]}.md` !== file) throw new InvalidBackup();
    const dir = await this.backupDirectory(root, false);
    if (!dir) throw new InvalidBackup();
    const rawMeta = await this.readBytes(join(dir, `${backupId}.json`), META_LIMIT);
    if (!rawMeta) throw new InvalidBackup();
    let record: BackupRecord;
    try {
      record = parseBackupRecord(JSON.parse(decodeUtf8(rawMeta)));
    } catch {
      throw new InvalidBackup();
    }
    const bytes = await this.readBytes(join(dir, backupId), LIMIT);
    const stamp = record.createdAt.replace(/[-:.]/g, "");
    if (
      !bytes ||
      record.backupId !== backupId ||
      record.file !== file ||
      !this.matchesDirectoryIdentity(root, record.directoryIdentity) ||
      record.sha256 !== match[3] ||
      stamp !== match[2] ||
      digest(bytes) !== record.sha256 ||
      (record.previouslyMissing && bytes.length !== 0)
    ) {
      throw new InvalidBackup();
    }
    decodeUtf8(bytes);
    return { record, bytes };
  }

  private async lastBackup(root: Root, file: IdentityFile): Promise<IdentityBackup | null> {
    const dir = await this.backupDirectory(root, false);
    if (!dir) return null;
    const candidates = (await fs.readdir(dir)).filter(
      (name) => name.startsWith(`${file}.`) && backupPattern.test(name),
    );
    const valid: IdentityBackup[] = [];
    for (const name of candidates) {
      try {
        const loaded = await this.loadBackup(root, file, name);
        valid.push(this.publicBackup(loaded.record));
      } catch (error) {
        if (!(error instanceof InvalidBackup)) throw error;
      }
    }
    valid.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.backupId.localeCompare(a.backupId),
    );
    return valid[0] ?? null;
  }

  private async writeExclusive(
    filePath: string,
    bytes: Buffer,
    created: string[],
  ): Promise<void> {
    const handle = await fs.open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created.push(filePath);
    try {
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async cleanup(paths: string[]): Promise<void> {
    let failed = false;
    for (const p of paths) {
      try {
        await fs.unlink(p);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") failed = true;
      }
    }
    if (failed) {
      throw new IdentityFilesError(
        503,
        "identityCleanupFailed",
        "身份文档临时文件清理失败，请重新读取后重试。",
      );
    }
  }

  private async createBackup(
    root: Root,
    file: IdentityFile,
    old: Snapshot,
    summary: string,
  ): Promise<string> {
    const dir = await this.backupDirectory(root, true);
    if (!dir) throw unavailable();
    lastBackupTime = Math.max(Date.now(), lastBackupTime + 1);
    const createdAt = new Date(lastBackupTime).toISOString();
    const sha256 = digest(old.bytes);
    const backupId = `${file}.${createdAt.replace(/[-:.]/g, "")}.${sha256}.${randomUUID().replaceAll("-", "")}.bak`;
    const record: BackupRecord = {
      backupId,
      file,
      createdAt,
      sha256,
      previouslyMissing: !old.exists,
      summary,
      directoryIdentity: this.isManagedRoot(root) ? MANAGED_IDENTITY_DIRECTORY_KEY : directoryKey(root),
    };
    const created: string[] = [];
    try {
      await this.writeExclusive(join(dir, backupId), old.bytes, created);
      await this.writeExclusive(
        join(dir, `${backupId}.json`),
        Buffer.from(JSON.stringify(record), "utf8"),
        created,
      );
      await this.syncDirectory(dir);
      await this.assertRoot(root);
      return backupId;
    } catch (error) {
      await this.cleanup(created);
      throw error;
    }
  }

  private async pruneBackups(root: Root, protectedIds: readonly string[]): Promise<void> {
    const directory = await this.backupDirectory(root, false);
    if (!directory) return;
    const policy = this.options.retention;
    const protectedSet = new Set([...protectedIds, ...(policy?.protectedBackupIds?.() ?? [])]);
    const known: Array<{ name: string; file: IdentityFile; createdAt: string; bytes: number; body: Stats; metadata: Stats }> = [];
    for (const name of await fs.readdir(directory)) {
      const match = backupPattern.exec(name);
      if (!match) continue;
      const bodyPath = join(directory, name), metadataPath = `${bodyPath}.json`;
      let body: Stats, metadata: Stats;
      try {
        body = await fs.lstat(bodyPath);
        metadata = await fs.lstat(metadataPath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!body.isFile() || !metadata.isFile() || body.size > LIMIT || metadata.size > META_LIMIT) continue;
      const raw = await this.readBytes(metadataPath, META_LIMIT);
      if (!raw) continue;
      let record: BackupRecord;
      try { record = parseBackupRecord(JSON.parse(decodeUtf8(raw))); }
      catch (error) {
        if (error instanceof InvalidBackup || error instanceof SyntaxError || error instanceof IdentityFilesError && error.code === "identityUnavailable") continue;
        throw error;
      }
      if (record.backupId !== name || !this.matchesDirectoryIdentity(root, record.directoryIdentity) ||
        record.file !== `${match[1]}.md` || record.sha256 !== match[3] ||
        record.createdAt.replace(/[-:.]/g, "") !== match[2]) continue;
      known.push({ name, file: record.file, createdAt: record.createdAt, bytes: body.size + metadata.size, body, metadata });
    }
    known.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
    const recent = new Map<IdentityFile, number>();
    for (const entry of known) {
      const count = recent.get(entry.file) ?? 0;
      if (count < 2) protectedSet.add(entry.name);
      recent.set(entry.file, count + 1);
    }
    let count = known.length, bytes = known.reduce((sum, entry) => sum + entry.bytes, 0), deleted = 0;
    for (const entry of [...known].reverse()) {
      if (count <= (policy?.maxBackups ?? DEFAULT_BACKUP_LIMIT) && bytes <= (policy?.maxBytes ?? DEFAULT_BACKUP_BYTES)) break;
      if (protectedSet.has(entry.name)) continue;
      if (deleted >= 16) break;
      try { await this.loadBackup(root, entry.file, entry.name); }
      catch (error) {
        if (error instanceof InvalidBackup) continue;
        throw error;
      }
      await this.assertRoot(root);
      const bodyPath = join(directory, entry.name), metadataPath = `${bodyPath}.json`;
      if (!sameRead(entry.body, await fs.lstat(bodyPath)) || !sameRead(entry.metadata, await fs.lstat(metadataPath))) continue;
      await fs.unlink(bodyPath);
      await fs.unlink(metadataPath);
      count--; bytes -= entry.bytes; deleted++;
    }
    if (deleted) await this.syncDirectory(directory);
  }

  async read(value: unknown, options?: { language?: KuloLanguage }): Promise<IdentityRead> {
    if (!isIdentityFile(value)) throw invalid();
    const file = value;
    const templateLanguage = options?.language ?? this.options.getLanguage?.() ?? "en";
    return this.safe(async () => {
      const state = this.state();
      if (!state.directory) {
        const content = getIdentityTemplate(file, templateLanguage);
        this.assertState(state);
        return {
          file,
          content,
          exists: false,
          configured: false,
          version: { directoryRevision: state.directoryRevision, sha256: null },
          lastBackup: null,
        };
      }
      const root = await this.root(state);
      try {
        return await serial(root.path, async () => {
          const current = await this.snapshot(root, file);
          const lastBackup = await this.lastBackup(root, file);
          const content = current.exists
            ? decodeUtf8(current.bytes)
            : getIdentityTemplate(file, templateLanguage);
          await this.assertRoot(root);
          return {
            file,
            content,
            exists: current.exists,
            configured: true,
            version: {
              directoryRevision: state.directoryRevision,
              sha256: current.sha256,
            },
            lastBackup,
          };
        });
      } finally {
        await root.handle.close();
      }
    });
  }

  async readBackup(
    value: unknown,
    id: unknown,
  ): Promise<IdentityBackup & { content: string }> {
    if (!isIdentityFile(value) || typeof id !== "string" || id.length > 200) {
      throw invalid();
    }
    const file = value;
    const backupId = id;
    if (!backupPattern.test(backupId) || !backupId.startsWith(`${file}.`)) {
      throw invalid();
    }
    return this.safe(async () => {
      const root = await this.root(this.state());
      try {
        return await serial(root.path, async () => {
          try {
            const { record, bytes } = await this.loadBackup(root, file, backupId);
            await this.assertRoot(root);
            return {
              ...this.publicBackup(record),
              content: decodeUtf8(bytes),
            };
          } catch (error) {
            if (error instanceof InvalidBackup) throw invalid();
            throw error;
          }
        });
      } finally {
        await root.handle.close();
      }
    });
  }

  async list(): Promise<IdentityList> {
    return this.safe(async () => {
      const state = this.state();
      const files: IdentityList["files"] = [];
      for (const file of IDENTITY_FILES) {
        const { content: _c, configured: _cfg, ...meta } = await this.read(file);
        files.push(meta);
      }
      this.assertState(state);
      return {
        configured: Boolean(state.directory),
        directory: state.directory,
        directoryRevision: state.directoryRevision,
        files,
      };
    });
  }

  async save(value: unknown): Promise<IdentitySaved> {
    const input = validateWriteRequest(value);
    const bytes = Buffer.from(input.content, "utf8");
    enforceSizeLimit(bytes);
    return this.change(input, "save", async () => ({ bytes, exists: true }));
  }

  async saveRelationship(value: unknown): Promise<IdentitySaved> {
    if (!value || typeof value !== "object") throw invalid();
    const obj = value as Record<string, unknown>;
    if (obj.file !== undefined && obj.file !== "relationship.md") throw invalid();
    if (typeof obj.content !== "string" || !wellFormedUtf8(obj.content)) throw invalid();
    const bytes = Buffer.from(obj.content, "utf8");
    enforceSizeLimit(bytes);
    return this.change({
      file: "relationship.md", expected: validateVersion(obj.expected), content: obj.content,
      summary: validateSummary(obj.summary), dualSignConfirmed: true,
    }, "save", async () => ({ bytes, exists: true }));
  }

  async rollbackRelationship(value: unknown): Promise<IdentitySaved> {
    if (!value || typeof value !== "object") throw invalid();
    const obj = value as Record<string, unknown>;
    if (obj.file !== undefined && obj.file !== "relationship.md") throw invalid();
    return this.rollback({ ...obj, file: "relationship.md", dualSignConfirmed: true });
  }

  async rollback(value: unknown): Promise<IdentitySaved> {
    const input = validateRollbackRequest(value);
    if (!backupPattern.test(input.backupId) || !input.backupId.startsWith(`${input.file}.`)) {
      throw invalid();
    }
    return this.change(input, "rollback", async (root) => {
      try {
        const { record, bytes } = await this.loadBackup(root, input.file, input.backupId);
        return { bytes, exists: !record.previouslyMissing };
      } catch (error) {
        if (error instanceof InvalidBackup) {
          throw new IdentityFilesError(
            400,
            "invalidIdentityBackup",
            "所选文档备份无效或已不存在。",
          );
        }
        throw error;
      }
    });
  }

  private async change(
    input: IdentityWriteRequest | IdentityRollbackRequest,
    operation: "save" | "rollback",
    target: (root: Root) => Promise<{ bytes: Buffer; exists: boolean }>,
  ): Promise<IdentitySaved> {
    return this.safe(async () => {
      const state = this.state();
      if (input.expected.directoryRevision !== state.directoryRevision) {
        throw conflict();
      }
      const root = await this.root(state);
      let committed = false;
      try {
        return await serial(root.path, async () => {
          const old = await this.checked(root, input.file, input.expected);
          const next = await target(root);
          const metadata = {
            operation,
            summary: input.summary,
            savedAt: new Date().toISOString(),
            restoredMissing: !next.exists,
          };
          if (old.exists === next.exists && old.bytes.equals(next.bytes)) {
            await this.checked(root, input.file, input.expected);
            return {
              file: input.file,
              version: input.expected,
              backupId: null,
              unchanged: true,
              metadata,
            };
          }
          const backupId = await this.createBackup(root, input.file, old, input.summary);
          const created: string[] = [];
          const temp = join(root.path, `.${input.file}.${randomUUID()}.tmp`);
          try {
            if (next.exists) await this.writeExclusive(temp, next.bytes, created);
            await this.checked(root, input.file, input.expected);
            this.assertState(state);
            if (next.exists) {
              await fs.rename(temp, join(root.path, input.file));
              created.length = 0;
            } else {
              await fs.unlink(join(root.path, input.file));
            }
            committed = true;
            await this.syncDirectory(root.path);
            this.#onWrite?.();
            try {
              await this.pruneBackups(root, [backupId, ...(operation === "rollback" ? [(input as IdentityRollbackRequest).backupId] : [])]);
            } catch {
              throw new IdentityFilesError(503, "identityHistoryCleanupFailed", "文档已保存，但历史备份清理未完成，请稍后重试。", true);
            }
            return {
              file: input.file,
              version: {
                directoryRevision: state.directoryRevision,
                sha256: next.exists ? digest(next.bytes) : null,
              },
              backupId,
              unchanged: false,
              metadata,
            };
          } catch (error) {
            await this.cleanup(created);
            if (error instanceof IdentityFilesError && error.committed) throw error;
            if (committed) {
              throw new IdentityFilesError(
                503,
                "identityDurabilityFailed",
                "文档已写入，但目录同步确认异常，请刷新后再操作。",
                true,
              );
            }
            throw error;
          }
        });
      } finally {
        try {
          await root.handle.close();
        } catch {
          if (committed) {
            throw new IdentityFilesError(
              503,
              "identityDurabilityFailed",
              "文档已保存，但句柄关闭异常，请刷新后再操作。",
              true,
            );
          }
          throw unavailable();
        }
      }
    });
  }
}

/**
 * Synchronous, fail-closed identity & relationship context reader strictly for the Root Kulo Orchestrator.
 * Unavailable or uninitialized files never inject templates.
 */
export function readIdentityContext(directory: string): Array<{ file: IdentityFile; text: string }> {
  if (!directory || !isAbsolute(directory) || directory.includes("\0")) return [];
  let rootFd: number | undefined;
  try {
    const configured = resolve(directory);
    let current = parse(configured).root;
    for (const part of configured.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() ? !systemAlias(current) : !stat.isDirectory()) {
        return [];
      }
    }
    const root = realpathSync(configured);
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
    rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameObject(rootStat, fstatSync(rootFd))) return [];

    const result: Array<{ file: IdentityFile; text: string }> = [];
    for (const file of IDENTITY_FILES) {
      let fd: number | undefined;
      try {
        const filePath = join(root, file);
        const before = lstatSync(filePath);
        if (!before.isFile() || before.isSymbolicLink() || before.size > LIMIT) continue;
        fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameRead(before, opened) || opened.size > LIMIT) continue;
        const bytes = Buffer.alloc(LIMIT + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, length);
          if (!count) break;
          length += count;
        }
        if (
          length > LIMIT ||
          !sameRead(opened, fstatSync(fd)) ||
          !sameRead(opened, lstatSync(filePath))
        ) {
          continue;
        }
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(bytes.subarray(0, length))
          .trim();
        if (text) {
          result.push({ file, text });
        }
      } catch {
        // Fail closed silently; never leak filesystem diagnostics into prompts.
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (
      realpathSync(configured) !== root ||
      !sameObject(rootStat, lstatSync(root)) ||
      !sameObject(rootStat, fstatSync(rootFd))
    ) {
      return [];
    }
    return result;
  } catch {
    return [];
  } finally {
    if (rootFd !== undefined) closeSync(rootFd);
  }
}
