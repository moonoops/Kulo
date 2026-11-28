import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { SkillAudience, SkillRecord, SkillSnapshot } from "@kulo/protocol";
import { installSkillSource, parseSkillSource, SkillSourceError, type SkillSourceSpec } from "./skill-sources.js";
import { COMPUTER_ONLY_BUILTINS, isSkillApplicable, loadSkillPresets, type SkillPreset } from "./skill-presets.js";
import type { SkillRuntimeContext } from "./skill-runtime.js";

const AUDIENCES: SkillAudience[] = ["settings", "chat", "worker"];
const BUILTINS = ["genui-cards", "interactive-html"] as const;
const SYSTEM_GUIDES = ["capability-setup"] as const;
export type SystemSkillGuideId = (typeof SYSTEM_GUIDES)[number];
const MAX_FILES = 512;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const DEFAULT_HISTORY_VERSIONS = 20;
const DEFAULT_HISTORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_TOTAL_HISTORY_BYTES = 256 * 1024 * 1024;
const skillOperations = new Map<string, Promise<unknown>>();
const skillVersionLeases = new Map<string, number>();
const IGNORED = new Set([".git", "node_modules", ".DS_Store", ".gitignore", ".gitattributes", ".ignore", ".fdignore"]);
const SENSITIVE_NAME = /^(?:credentials?(?:\.[^.]+)?|auth\.json|secrets?(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|p12|pfx))$/i;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;

export class SkillError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = "SkillError";
  }
}

interface SkillFile { size: number; hash: string; executable: boolean }
interface SkillVersion { record: SkillRecord; files: Record<string, SkillFile>; manualOnly?: boolean; commit?: string }
interface StoredSkill { record: SkillRecord; versions: Record<string, SkillVersion>; order: string[]; retired?: Record<string, SkillVersion>; removed?: boolean }
export interface KuloSkillsState {
  revision: number;
  skills: Record<string, StoredSkill>;
  commands: Record<string, { fingerprint: string }>;
}
export const KuloSkillsDoc = defineDoc<KuloSkillsState & JsonObject>({
  kind: "kulo.skills", version: 1, scope: "session",
  initial: () => ({ revision: 0, skills: {}, commands: {} }) as KuloSkillsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export interface KuloSkillsOptions {
  harness: Harness;
  stateDir: string;
  onChanged?: () => void | Promise<void>;
  resolveLocalSource?: (source: string) => Promise<{ directory: string; dispose(): Promise<void> }>;
  retention?: {
    maxVersionsPerSkill?: number;
    maxBytesPerSkill?: number;
    maxTotalBytes?: number;
    protectedVersions?: () => readonly { id: string; version: string }[];
  };
}
export interface ManageSkillInput {
  action: "import" | "enable" | "disable" | "update" | "remove" | "rollback";
  id?: string;
  source?: string;
  audiences?: SkillAudience[];
  expectedRevision?: number;
  commandId: string;
}
type SkillSource = SkillSourceSpec;
interface PreparedSkill { record: SkillRecord; files: Record<string, SkillFile>; manualOnly: boolean; commit?: string; created?: boolean }

function invalid(message: string): never { throw new SkillError(400, "invalid_skill", message); }
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label}无效。`);
  return value.trim();
}
function audiences(value: unknown, fallback: SkillAudience[] = ["chat", "worker"]): SkillAudience[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.length || value.some((item) => !AUDIENCES.includes(item))) invalid("Skill 使用范围无效。");
  return [...new Set(value as SkillAudience[])].sort();
}
function resourcePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value)) invalid("Skill 资源路径无效。");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || SENSITIVE_NAME.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) invalid("Skill 资源必须位于受管目录内，不能包含隐藏或凭证文件。");
  return parts.join("/");
}
function parseSource(input: string): SkillSource {
  try { return parseSkillSource(input); }
  catch (error) {
    if (error instanceof SkillSourceError) throw new SkillError(error.status, error.code, error.message);
    throw error;
  }
}

function parseSkill(content: string, fallbackAudiences?: SkillAudience[]): Pick<SkillRecord, "name" | "description" | "audiences" | "dependencies" | "diagnostics"> & { manualOnly: boolean } {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) invalid("Skill 需要带有 name 和 description 的 YAML 头部。");
  const document = parseDocument(frontmatter[1]!, { uniqueKeys: true });
  if (document.errors.length) invalid("Skill YAML 头部无效。");
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 20 }); }
  catch { return invalid("Skill YAML 引用无效或过多。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Skill YAML 头部必须为对象。");
  const data = value as Record<string, unknown>;
  const name = text(data.name, "Skill 名称", 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) invalid("Skill 名称只能使用小写字母、数字和单个连字符。");
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024) invalid("Skill 描述无效。");
  if (data.metadata !== undefined && (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata) || Object.values(data.metadata).some((value) => typeof value !== "string"))) invalid("Skill metadata 需要使用字符串键值。");
  const metadata = (data.metadata ?? {}) as Record<string, string>;
  const declaredAudiences = metadata["kulo-audiences"]?.split(/[\s,]+/).filter(Boolean);
  const dependencies = metadata["kulo-dependencies"]?.split(/[\s,]+/).filter(Boolean) ?? [];
  if (dependencies.length > 32 || dependencies.some((entry) => !/^[A-Za-z0-9._+-]{1,64}$/.test(entry))) invalid("Skill 依赖需要使用程序名称列表。");
  if (data["disable-model-invocation"] !== undefined && typeof data["disable-model-invocation"] !== "boolean") invalid("Skill 自动调用设置无效。");
  return {
    name, description: data.description.trim(), audiences: audiences(fallbackAudiences ?? declaredAudiences),
    dependencies: [...new Set(dependencies)], diagnostics: [], manualOnly: data["disable-model-invocation"] === true,
  };
}

function readBounded(handle: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(handle, buffer, offset, size - offset, offset);
    if (!count) throw new SkillError(409, "skill_resource_changed", "Skill 资源在读取期间发生变化。");
    offset += count;
  }
  if (fs.fstatSync(handle).size !== size) throw new SkillError(409, "skill_resource_changed", "Skill 资源在读取期间发生变化。");
  return buffer;
}

function scanSkillDirectory(sourceDirectory: string, destination?: string): Record<string, SkillFile> {
  const files: Record<string, SkillFile> = {};
  let bytes = 0;
  let count = 0;
  let entries = 0;
  const copy = (directory: string, relative: string): void => {
    if (relative.split("/").length > 24) invalid("Skill 目录层级过深。");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      if (++entries > MAX_FILES * 2) throw new SkillError(413, "skill_package_too_large", "Skill 超过目录条目上限。");
      const resource = resourcePath(relative ? `${relative}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) invalid("Skill 来源不能包含符号链接。");
      const output = destination ? path.join(destination, resource) : undefined;
      if (info.isDirectory()) {
        if (output) fs.mkdirSync(output, { mode: 0o700 }); copy(absolute, resource);
      } else if (info.isFile()) {
        if (++count > MAX_FILES || info.size > MAX_FILE_BYTES || (bytes += info.size) > MAX_PACKAGE_BYTES) throw new SkillError(413, "skill_package_too_large", "Skill 超过文件数量或体积上限。");
        const handle = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let content: Buffer;
        try {
          const actual = fs.fstatSync(handle);
          if (!actual.isFile() || actual.size !== info.size) invalid("Skill 来源在导入期间发生变化。");
          content = readBounded(handle, actual.size);
          if (content.length !== info.size) invalid("Skill 来源在导入期间发生变化。");
        } finally { fs.closeSync(handle); }
        if (output) fs.writeFileSync(output, content, { flag: "wx", mode: 0o400 });
        files[resource] = { size: content.length, hash: digest(content), executable: Boolean(info.mode & 0o111) };
      } else invalid("Skill 不能包含特殊文件。");
    }
  };
  copy(sourceDirectory, "");
  return files;
}

function skillMetadata(directory: string, files: Record<string, SkillFile>, scope?: SkillAudience[]) {
  const header = own(files, "SKILL.md");
  if (!header) invalid("来源目录缺少 SKILL.md。");
  if (header.size > MAX_TEXT_BYTES) throw new SkillError(413, "skill_resource_too_large", "SKILL.md 超过体积上限。");
  let instructions: string;
  const handle = fs.openSync(path.join(directory, "SKILL.md"), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.size !== header.size) invalid("Skill 来源在导入期间发生变化。");
    const bytes = readBounded(handle, info.size);
    if (digest(bytes) !== header.hash) invalid("Skill 来源在导入期间发生变化。");
    try { instructions = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return invalid("SKILL.md 必须是 UTF-8 文本。"); }
  } finally { fs.closeSync(handle); }
  return parseSkill(instructions, scope);
}

function validateSkillDirectory(directory: string): void {
  skillMetadata(directory, scanSkillDirectory(directory));
}

export class KuloSkills {
  readonly #options: KuloSkillsOptions;
  readonly #root: string;
  readonly #presets = new Map<string, SkillPreset>();
  #rootIdentity: { dev: number; ino: number } | undefined;
  constructor(options: KuloSkillsOptions) {
    this.#options = options;
    this.#root = path.resolve(options.stateDir, "skills");
    const policy = options.retention;
    if (policy?.maxVersionsPerSkill !== undefined && (!Number.isSafeInteger(policy.maxVersionsPerSkill) || policy.maxVersionsPerSkill < 3) ||
      [policy?.maxBytesPerSkill, policy?.maxTotalBytes].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) {
      throw new Error("Invalid Skill history retention limits");
    }
  }

  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = (skillOperations.get(this.#root) ?? Promise.resolve()).then(work, work);
    const tail = run.then(() => undefined, () => undefined);
    skillOperations.set(this.#root, tail);
    void tail.then(() => { if (skillOperations.get(this.#root) === tail) skillOperations.delete(this.#root); });
    return run;
  }
  retainVersion(id: string, version: string): () => void {
    this.#directory(id, version);
    const key = `${this.#root}\0${id}:${version}`;
    skillVersionLeases.set(key, (skillVersionLeases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (skillVersionLeases.get(key) ?? 1) - 1;
      if (remaining) skillVersionLeases.set(key, remaining);
      else skillVersionLeases.delete(key);
    };
  }

  #protectedVersions(state: KuloSkillsState): Set<string> {
    const protectedSet = new Set<string>();
    for (const [id, skill] of Object.entries(state.skills)) {
      protectedSet.add(`${id}:${skill.record.version}`);
      for (const version of [...skill.order].reverse().filter((value) => value !== skill.record.version).slice(0, 2)) protectedSet.add(`${id}:${version}`);
    }
    const prefix = `${this.#root}\0`;
    for (const key of skillVersionLeases.keys()) if (key.startsWith(prefix)) protectedSet.add(key.slice(prefix.length));
    for (const reference of this.#options.retention?.protectedVersions?.() ?? []) {
      this.#directory(reference.id, reference.version);
      protectedSet.add(`${reference.id}:${reference.version}`);
    }
    return protectedSet;
  }

  #versionBytes(version: SkillVersion): number {
    return Object.values(version.files).reduce((sum, file) => sum + file.size, 0);
  }

  #removeOwnedSnapshot(id: string, version: string, value: SkillVersion): boolean {
    const root = fs.lstatSync(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink() || !this.#rootIdentity ||
      root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino) return false;
    const target = this.#directory(id, version);
    if (!fs.existsSync(target)) {
      try { fs.lstatSync(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      return false;
    }
    let parent = this.#root;
    for (const part of ["packages", id, version]) {
      parent = path.join(parent, part);
      const entry = fs.lstatSync(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    }
    const expected = new Map<string, "file" | "directory">();
    for (const file of Object.keys(value.files)) {
      expected.set(file, "file");
      const parts = file.split("/");
      while (parts.length > 1) { parts.pop(); expected.set(parts.join("/"), "directory"); }
    }
    const inspect = (directory: string, relative = ""): boolean => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const resource = relative ? `${relative}/${entry.name}` : entry.name;
        const kind = expected.get(resource);
        if (!kind || entry.isSymbolicLink() || kind === "directory" && !entry.isDirectory() || kind === "file" && !entry.isFile()) return false;
        if (kind === "directory" && !inspect(path.join(directory, entry.name), resource)) return false;
      }
      return true;
    };
    try {
      if (!inspect(target) || !this.#verifiedSnapshot(id, version, value.files)) return false;
    } catch (error) {
      if (error instanceof SkillError) return false;
      throw error;
    }
    fs.rmSync(target, { recursive: true });
    return true;
  }

  async #collectHistory(reserve?: { id: string; bytes: number }): Promise<void> {
    const initial = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    if (!initial) return;
    const protectedSet = this.#protectedVersions(initial);
    const policy = this.#options.retention;
    const maxVersions = policy?.maxVersionsPerSkill ?? DEFAULT_HISTORY_VERSIONS;
    const maxBytes = policy?.maxBytesPerSkill ?? DEFAULT_HISTORY_BYTES;
    const maxTotalBytes = policy?.maxTotalBytes ?? DEFAULT_TOTAL_HISTORY_BYTES;
    const totals = new Map<string, { versions: number; bytes: number }>();
    let totalBytes = reserve?.bytes ?? 0, unprotectedVersions = 0;
    const candidates: Array<{ id: string; version: string; value: SkillVersion }> = [];
    for (const [id, skill] of Object.entries(initial.skills)) {
      const allVersions = { ...skill.retired, ...skill.versions };
      const bytes = Object.values(allVersions).reduce((sum, version) => sum + this.#versionBytes(version), 0);
      totals.set(id, { versions: Object.keys(allVersions).length, bytes: bytes + (reserve?.id === id ? reserve.bytes : 0) });
      totalBytes += bytes;
      unprotectedVersions += Object.keys(allVersions).filter((version) => !protectedSet.has(`${id}:${version}`)).length;
      for (const version of skill.order) if (!protectedSet.has(`${id}:${version}`) && skill.versions[version]) candidates.push({ id, version, value: skill.versions[version]! });
    }
    candidates.sort((a, b) => a.value.record.updatedAt - b.value.record.updatedAt);
    const retiring: typeof candidates = [];
    for (const candidate of candidates) {
      const total = totals.get(candidate.id)!;
      if (total.versions <= maxVersions && total.bytes <= maxBytes && unprotectedVersions <= 200 && totalBytes <= maxTotalBytes) continue;
      retiring.push(candidate);
      const bytes = this.#versionBytes(candidate.value);
      total.versions--; total.bytes -= bytes; unprotectedVersions--; totalBytes -= bytes;
    }
    if (retiring.length) {
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloSkillsDoc);
        if (state.revision !== initial.revision) throw new SkillError(409, "skill_revision_conflict", "Skill 目录已更新，请重新读取。");
        const currentProtection = this.#protectedVersions(state);
        for (const { id, version, value } of retiring) {
          const skill = state.skills[id]!;
          if (!skill.versions[version] || currentProtection.has(`${id}:${version}`)) continue;
          // Keep ownership evidence until deletion commits, so an interrupted collection can resume.
          (skill.retired ??= {})[version] = clone(value);
          delete skill.versions[version];
          skill.order = skill.order.filter((entry) => entry !== version);
        }
      }, BACKGROUND_CONTEXT);
    }
    const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    if (!state) return;
    const protectedNow = this.#protectedVersions(state);
    const removed: Array<{ id: string; version: string }> = [];
    for (const [id, skill] of Object.entries(state.skills)) {
      for (const [version, value] of Object.entries(skill.retired ?? {})) {
        if (removed.length >= 16) break;
        if (skill.versions[version] || protectedNow.has(`${id}:${version}`)) continue;
        if (this.#removeOwnedSnapshot(id, version, value)) removed.push({ id, version });
      }
    }
    if (removed.length) {
      await this.#options.harness.commit(async (tx) => {
        const latest = await tx.doc(KuloSkillsDoc);
        for (const { id, version } of removed) delete latest.skills[id]?.retired?.[version];
      }, BACKGROUND_CONTEXT);
    }
    if (reserve) {
      const latest = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
      const protectedLatest = latest ? this.#protectedVersions(latest) : new Set<string>();
      let total = reserve.bytes, ownBytes = reserve.bytes, versions = 0, ownVersions = 0, protectedOwnVersions = 0;
      for (const [id, skill] of Object.entries(latest?.skills ?? {})) {
        const bytes = [...Object.values(skill.versions), ...Object.values(skill.retired ?? {})].reduce((sum, version) => sum + this.#versionBytes(version), 0);
        total += bytes;
        versions += [...Object.keys(skill.versions), ...Object.keys(skill.retired ?? {})].filter((version) => !protectedLatest.has(`${id}:${version}`)).length;
        if (id === reserve.id) {
          ownBytes += bytes;
          ownVersions = Object.keys(skill.versions).length + Object.keys(skill.retired ?? {}).length;
          protectedOwnVersions = [...Object.keys(skill.versions), ...Object.keys(skill.retired ?? {})].filter((version) => protectedLatest.has(`${id}:${version}`)).length;
        }
      }
      if (total > maxTotalBytes || ownBytes > maxBytes || versions > 200 ||
        ownVersions - protectedOwnVersions > Math.max(0, maxVersions - protectedOwnVersions)) {
        throw new SkillError(409, "skill_history_full", "Skill 历史空间不足，当前版本和受保护历史已保留。");
      }
    }
  }

  async #discardPrepared(prepared: PreparedSkill): Promise<void> {
    if (!prepared.created) return;
    const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    const skill = state?.skills[prepared.record.id];
    if (skill?.versions[prepared.record.version] || skill?.retired?.[prepared.record.version] ||
      state && this.#protectedVersions(state).has(`${prepared.record.id}:${prepared.record.version}`)) return;
    this.#removeOwnedSnapshot(prepared.record.id, prepared.record.version, prepared);
  }
  #directory(id: string, version: string): string {
    if (!/^[a-z0-9-]{1,80}$/.test(id) || !/^[a-f0-9]{64}$/.test(version)) invalid("Skill 版本引用无效。");
    return path.join(this.#root, "packages", id, version);
  }
  #ensureRoot(): void {
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const root = fs.lstatSync(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink() || this.#rootIdentity &&
      (root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino)) invalid("Skill 管理目录不能为符号链接或被替换。");
    this.#rootIdentity ??= { dev: root.dev, ino: root.ino };
  }

  #verifiedSnapshot(id: string, version: string, files: Record<string, SkillFile>): boolean {
    const target = this.#directory(id, version);
    let parent = this.#root;
    for (const component of ["packages", id, version]) {
      parent = path.join(parent, component);
      if (!fs.existsSync(parent)) return false;
      const info = fs.lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) invalid("Skill 快照目录无效。");
    }
    const changed = () => new SkillError(409, "skill_snapshot_changed", "已有 Skill 快照发生变化，请移除损坏快照后重试。");
    for (const [resource, file] of Object.entries(files)) {
      let location = target;
      for (const part of resource.split("/")) {
        location = path.join(location, part);
        if (!fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink()) throw changed();
      }
      const handle = fs.openSync(location, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const info = fs.fstatSync(handle);
        if (!info.isFile() || info.size !== file.size || digest(readBounded(handle, file.size)) !== file.hash) throw changed();
      } finally { fs.closeSync(handle); }
    }
    return true;
  }

  #builtinRoot(): string {
    const adjacent = fileURLToPath(new URL("./skills/", import.meta.url));
    return fs.existsSync(adjacent) ? adjacent : fileURLToPath(new URL("../skills/", import.meta.url));
  }

  #isHiddenPreset(record: Pick<SkillRecord, "id" | "source">): boolean {
    return record.source === "builtin" && Boolean(this.#presets.get(record.id)?.hidden);
  }

  async readSystemGuide(id: SystemSkillGuideId, resource = "SKILL.md"): Promise<string> {
    if (!SYSTEM_GUIDES.includes(id)) throw new SkillError(404, "skill_not_found", "系统指引不存在。");
    const name = resourcePath(resource);
    let location = path.join(this.#builtinRoot(), id);
    const rootInfo = fs.lstatSync(location);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SkillError(404, "skill_not_found", "系统指引目录无效。");
    for (const part of name.split("/")) {
      location = path.join(location, part);
      if (!fs.existsSync(location)) throw new SkillError(404, "skill_resource_not_found", "系统指引资源不存在。");
      if (fs.lstatSync(location).isSymbolicLink()) throw new SkillError(409, "skill_resource_changed", "系统指引位置无效。");
    }
    const handle = fs.openSync(location, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const info = fs.fstatSync(handle);
      if (!info.isFile() || info.size > MAX_TEXT_BYTES) throw new SkillError(413, "skill_resource_too_large", "系统指引资源过大。");
      const bytes = readBounded(handle, info.size);
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new SkillError(400, "skill_resource_binary", "系统指引资源不是 UTF-8 文本。"); }
    } finally { fs.closeSync(handle); }
  }

  async initialize(): Promise<void> {
    await this.#serial(async () => {
      this.#ensureRoot();
      const builtinRoot = this.#builtinRoot();
      const presets = loadSkillPresets(builtinRoot);
      this.#presets.clear();
      for (const preset of presets) this.#presets.set(preset.id, preset);
      const builtinAudiences = (name: (typeof BUILTINS)[number]): SkillAudience[] =>
        name === "genui-cards" ? ["chat", "settings"] : ["chat", "worker"];
      const bundled: Array<{ id: string; directory: string; audiences: SkillAudience[]; enabled: boolean; hidden?: boolean }> = [
        ...BUILTINS.map((name) => ({ id: name, directory: name, audiences: builtinAudiences(name), enabled: true })),
        ...presets,
      ];
      const activeBuiltins = new Set(bundled.map((entry) => entry.id));
      let changed = false;
      for (const entry of bundled) {
        const name = entry.id;
        const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
        const prepared = await this.#prepare(parseSource(path.join(builtinRoot, entry.directory)), name, "builtin", entry.audiences, own(state?.skills, name));
        prepared.record.enabled = entry.enabled;
        await this.#options.harness.commit(async (tx) => {
          const state = await tx.doc(KuloSkillsDoc);
          const previous = own(state.skills, name);
          const fixedAudiences = entry.hidden ? [...entry.audiences].sort() : undefined;
          if (previous?.record.version === prepared.record.version && !previous.removed
            && (!fixedAudiences || previous.record.enabled === entry.enabled && JSON.stringify(previous.record.audiences) === JSON.stringify(fixedAudiences))) return;
          this.#put(state, prepared, previous);
          if (entry.hidden) {
            state.skills[name]!.record.enabled = entry.enabled;
            state.skills[name]!.record.audiences = fixedAudiences!;
          }
          changed = true;
          state.revision++;
        }, BACKGROUND_CONTEXT);
      }
      await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloSkillsDoc);
        let retiredAny = false;
        for (const [id, entry] of Object.entries(state.skills)) {
          if (entry.record.source === "builtin" && !entry.removed && !activeBuiltins.has(id)) {
            entry.removed = true;
            entry.record.enabled = false;
            entry.record.updatedAt = Date.now();
            retiredAny = true;
          }
        }
        if (retiredAny) {
          changed = true;
          state.revision++;
        }
      }, BACKGROUND_CONTEXT);
      if (changed) await this.#collectHistory();
    });
  }

  async snapshot(): Promise<SkillSnapshot> {
    const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    return {
      revision: state?.revision ?? 0,
      skills: Object.values(state?.skills ?? {})
        .filter((entry) => !entry.removed && !this.#isHiddenPreset(entry.record))
        .map((entry) => clone(entry.record))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
  }
  async runtimeRequirements(audience: SkillAudience, id?: string): Promise<{
    targetDevice: boolean;
    reactWorkspace: boolean;
    media: boolean;
    android: boolean;
    customization: boolean;
    memoryKnowledge: boolean;
  }> {
    if (!AUDIENCES.includes(audience)) invalid("Skill 使用范围无效。");
    const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    const entries = id ? [own(state?.skills, id)] : Object.values(state?.skills ?? {});
    const conditions = entries.flatMap((entry) => {
      if (!entry || entry.removed || !entry.record.enabled || entry.record.source !== "builtin" || !entry.record.audiences.includes(audience)
        || !id && entry.versions[entry.record.version]?.manualOnly) return [];
      const preset = this.#presets.get(entry.record.id);
      return preset ? [preset.condition] : [];
    });
    const checksAndroidDomain = audience === "worker" && entries.some((entry) =>
      entry && !entry.removed && entry.record.enabled && entry.record.source === "builtin" && COMPUTER_ONLY_BUILTINS.has(entry.record.id));
    return {
      targetDevice: conditions.some((condition) => !!condition.capability || !!condition.platform),
      reactWorkspace: conditions.some((condition) => condition.projectFramework === "react"),
      media: conditions.some((condition) => !!condition.mediaKind),
      android: checksAndroidDomain || conditions.some((condition) => Boolean(condition.androidAvailable)),
      customization: conditions.some((condition) => Boolean(condition.customizationEnabled)),
      memoryKnowledge: conditions.some((condition) => Boolean(condition.memoryKnowledgeEnabled)),
    };
  }
  async catalog(audience: SkillAudience, runtime?: SkillRuntimeContext): Promise<SkillRecord[]> {
    if (!AUDIENCES.includes(audience)) invalid("Skill 使用范围无效。");
    const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    return Object.values(state?.skills ?? {}).filter((entry) => !entry.removed && entry.record.enabled && entry.record.audiences.includes(audience) && !entry.versions[entry.record.version]?.manualOnly && isSkillApplicable(entry.record, this.#presets, runtime))
      .map((entry) => clone(entry.record)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  async #version(id: string, audience: SkillAudience, version?: string, runtime?: SkillRuntimeContext): Promise<{ record: SkillRecord; value: SkillVersion }> {
    if (!AUDIENCES.includes(audience)) invalid("Skill 使用范围无效。");
    const state = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    const stored = own(state?.skills, id);
    if (!stored || stored.removed) throw new SkillError(404, "skill_not_found", "Skill 不存在。");
    if (!stored.record.enabled || !stored.record.audiences.includes(audience)) throw new SkillError(403, "skill_scope_denied", "当前 Agent 不能读取这个 Skill。");
    if (!isSkillApplicable(stored.record, this.#presets, runtime)) throw new SkillError(403, "skill_context_denied", "该预置 Skill 不适用于当前执行设备或项目。");
    const value = own(stored.versions, version ?? stored.record.version);
    if (!value) throw new SkillError(404, "skill_version_not_found", "Skill 版本不存在。");
    return { record: clone(stored.record), value: clone(value) };
  }
  async resources(id: string, audience: SkillAudience, version?: string, runtime?: SkillRuntimeContext): Promise<Array<{ path: string } & SkillFile>> {
    const { value } = await this.#version(id, audience, version, runtime);
    return Object.entries(value.files).map(([resource, info]) => ({ path: resource, ...info }));
  }
  async describe(id: string, audience: SkillAudience, version?: string, runtime?: SkillRuntimeContext): Promise<SkillRecord> {
    const { record, value } = await this.#version(id, audience, version, runtime);
    return { ...value.record, enabled: record.enabled, audiences: record.audiences };
  }
  async readBytes(id: string, resource = "SKILL.md", audience: SkillAudience = "chat", version?: string, runtime?: SkillRuntimeContext): Promise<Uint8Array> {
    const release = version ? this.retainVersion(id, version) : undefined;
    try { return await this.#readResource(id, resource, audience, version, runtime); }
    finally { release?.(); }
  }
  async #readResource(id: string, resource: string, audience: SkillAudience, version?: string, runtime?: SkillRuntimeContext): Promise<Uint8Array> {
    const name = resourcePath(resource);
    const { value } = await this.#version(id, audience, version, runtime);
    const file = own(value.files, name);
    if (!file) throw new SkillError(404, "skill_resource_not_found", "Skill 资源不存在。");
    this.#directory(id, value.record.version);
    let location = this.#root;
    for (const part of ["", "packages", id, value.record.version, ...name.split("/")]) {
      if (part) location = path.join(location, part);
      const info = fs.lstatSync(location);
      if (info.isSymbolicLink()) throw new SkillError(409, "skill_resource_changed", "Skill 资源位置已变化，请重新导入。");
    }
    const handle = fs.openSync(location, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const info = fs.fstatSync(handle);
      if (!info.isFile() || info.size !== file.size || info.size > MAX_FILE_BYTES) throw new SkillError(409, "skill_resource_changed", "Skill 资源已变化，请重新导入。");
      const bytes = readBounded(handle, info.size);
      if (digest(bytes) !== file.hash) throw new SkillError(409, "skill_resource_changed", "Skill 资源已变化，请重新导入。");
      return bytes;
    } finally { fs.closeSync(handle); }
  }
  async read(id: string, resource = "SKILL.md", audience: SkillAudience = "chat", version?: string, runtime?: SkillRuntimeContext): Promise<string> {
    const bytes = await this.readBytes(id, resource, audience, version, runtime);
    if (bytes.byteLength > MAX_TEXT_BYTES) throw new SkillError(413, "skill_resource_too_large", "该资源过大，请通过受控文件资源使用。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new SkillError(400, "skill_resource_binary", "该资源不是 UTF-8 文本。"); }
  }

  #put(state: KuloSkillsState, prepared: PreparedSkill, previous?: StoredSkill): void {
    const record = {
      ...prepared.record,
      createdAt: previous?.record.createdAt ?? prepared.record.createdAt,
      enabled: previous && !previous.removed ? previous.record.enabled : prepared.record.enabled,
      audiences: previous && !previous.removed ? previous.record.audiences : prepared.record.audiences,
    };
    state.skills[record.id] = {
      record,
      versions: { ...(previous?.versions ?? {}), [record.version]: { record: prepared.record, files: prepared.files, manualOnly: prepared.manualOnly, ...(prepared.commit ? { commit: prepared.commit } : {}) } },
      order: [...(previous?.order ?? []).filter((value) => value !== record.version), record.version],
      retired: Object.fromEntries(Object.entries(previous?.retired ?? {}).filter(([version]) => version !== record.version)),
    };
  }

  async manage(input: ManageSkillInput): Promise<SkillSnapshot> {
    return this.#serial(async () => {
      const commandId = text(input.commandId, "操作编号", 256);
      if (["__proto__", "prototype", "constructor"].includes(commandId)) invalid("操作编号无效。");
      if (!["import", "enable", "disable", "update", "remove", "rollback"].includes(input.action)) invalid("Skill 操作无效。");
      if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) invalid("Skill revision 无效。");
      const scope = input.audiences === undefined ? undefined : audiences(input.audiences);
      const source = input.source === undefined ? undefined : parseSource(input.source);
      const fingerprint = digest(JSON.stringify({ action: input.action, id: input.id, source: source?.locator, audiences: scope, expectedRevision: input.expectedRevision }));
      const before = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
      const done = own(before?.commands, commandId);
      if (done) {
        if (done.fingerprint !== fingerprint) throw new SkillError(409, "skill_command_conflict", "同一操作编号不能用于不同的 Skill 请求。");
        return this.snapshot();
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== (before?.revision ?? 0)) throw new SkillError(409, "skill_revision_conflict", "Skill 目录已更新，请重新读取。");
      const previous = input.id ? own(before?.skills, input.id) : undefined;
      if (input.action !== "import" && (!previous || previous.removed)) throw new SkillError(404, "skill_not_found", "Skill 不存在。");
      if (previous && this.#isHiddenPreset(previous.record)) throw new SkillError(400, "builtin_skill_managed", "该能力内置指引随对应能力开关自动管理。");
      if (previous?.record.source === "builtin" && ["update", "remove", "rollback"].includes(input.action)) throw new SkillError(400, "builtin_skill_managed", "内置 Skill 随应用维护。");
      let prepared: PreparedSkill | undefined;
      if (input.action === "import") {
        if (!source) invalid("请提供 Skill 来源。");
        const id = `import-${digest(source.locator).slice(0, 32)}`;
        prepared = await this.#prepare(source, id, source.kind, scope);
      } else if (input.action === "update") {
        if (!previous?.record.sourceUrl) invalid("该 Skill 没有可更新来源。");
        prepared = await this.#prepare(parseSource(previous.record.sourceUrl), previous.record.id, previous.record.source, scope ?? previous.record.audiences);
      }
      if (prepared && !before?.skills[prepared.record.id]?.versions[prepared.record.version] &&
        !before?.skills[prepared.record.id]?.retired?.[prepared.record.version]) {
        try { await this.#collectHistory({ id: prepared.record.id, bytes: this.#versionBytes(prepared) }); }
        catch (error) { await this.#discardPrepared(prepared); throw error; }
      }
      try { await this.#options.harness.commit(async (tx) => {
        const state = await tx.doc(KuloSkillsDoc);
        const repeat = own(state.commands, commandId);
        if (repeat) {
          if (repeat.fingerprint !== fingerprint) throw new SkillError(409, "skill_command_conflict", "同一操作编号不能用于不同的 Skill 请求。");
          return;
        }
        if (state.revision !== (before?.revision ?? 0)) throw new SkillError(409, "skill_revision_conflict", "Skill 目录已更新，请重新读取。");
        if (prepared) {
          const existing = own(state.skills, prepared.record.id);
          this.#put(state, prepared, existing);
          if (scope) state.skills[prepared.record.id]!.record.audiences = scope;
        } else {
          const stored = state.skills[input.id!]!;
          if (input.action === "enable" || input.action === "disable") {
            stored.record.enabled = input.action === "enable";
            if (scope) stored.record.audiences = scope;
          } else if (input.action === "remove") {
            stored.removed = true; stored.record.enabled = false;
          } else if (input.action === "rollback") {
            const version = [...stored.order].reverse().find((item) => item !== stored.record.version);
            if (!version) throw new SkillError(409, "skill_no_previous_version", "没有可回退的 Skill 版本。");
            const preserved = { enabled: stored.record.enabled, audiences: stored.record.audiences, createdAt: stored.record.createdAt };
            stored.record = { ...clone(stored.versions[version]!.record), ...preserved };
          }
          stored.record.updatedAt = Date.now();
        }
        state.commands[commandId] = { fingerprint };
        state.revision++;
      }, BACKGROUND_CONTEXT); }
      catch (error) { if (prepared) await this.#discardPrepared(prepared); throw error; }
      await this.#collectHistory();
      await this.#options.onChanged?.();
      return this.snapshot();
    });
  }

  /**
   * Import a pre-validated local snapshot directory directly into managed immutable storage.
   * Defaults to `enabled: false` and `audiences: ["worker"]`, skips without overwriting when
   * another Kulo-managed skill already owns the same normalized name, and spawns zero subprocesses.
   */
  async importLocalSnapshot(input: {
    stagingDirectory: string;
    sourceLocator: string;
    commandId: string;
    enabled?: boolean;
    audiences?: SkillAudience[];
  }): Promise<{ status: "imported" | "skipped"; record?: SkillRecord; existingId?: string; snapshot: SkillSnapshot }> {
    return this.#serial(async () => {
      const commandId = text(input.commandId, "操作编号", 256);
      if (["__proto__", "prototype", "constructor"].includes(commandId)) invalid("操作编号无效。");
      const sourceLocator = text(input.sourceLocator, "Skill 来源", 4096);
      const scope = audiences(input.audiences ?? ["worker"]);
      const desiredEnabled = input.enabled === true;
      this.#ensureRoot();
      const rootInfo = fs.lstatSync(input.stagingDirectory);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid("Skill 来源需要是普通目录。");
      const canonical = fs.realpathSync(input.stagingDirectory);
      if (canonical === this.#root || canonical.startsWith(`${this.#root}${path.sep}`) || this.#root.startsWith(`${canonical}${path.sep}`)) {
        invalid("Skill 来源不能包含管理目录或位于其中。");
      }
      const id = `import-${digest(sourceLocator).slice(0, 32)}`;
      const fingerprint = digest(JSON.stringify({ action: "import-snapshot", id, sourceLocator, audiences: scope, enabled: desiredEnabled }));
      const before = await this.#options.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
      const done = own(before?.commands, commandId);
      if (done) {
        if (done.fingerprint !== fingerprint) throw new SkillError(409, "skill_command_conflict", "同一操作编号不能用于不同的 Skill 请求。");
        const snap = await this.snapshot();
        const rec = snap.skills.find((entry) => entry.id === id);
        return { status: rec ? "imported" : "skipped", ...(rec ? { record: rec } : {}), snapshot: snap };
      }
      const work = fs.mkdtempSync(path.join(this.#root, ".staging-"));
      let prepared: PreparedSkill | undefined;
      try {
        const destination = path.join(work, "snapshot");
        fs.mkdirSync(destination, { mode: 0o700 });
        const files = scanSkillDirectory(canonical, destination);
        const { manualOnly, ...metadata } = skillMetadata(destination, files, scope);
        const conflict = Object.values(before?.skills ?? {}).find(
          (entry) => !entry.removed && entry.record.name === metadata.name && entry.record.id !== id,
        );
        if (conflict) {
          return { status: "skipped", existingId: conflict.record.id, snapshot: await this.snapshot() };
        }
        const existingSame = own(before?.skills, id);
        if (existingSame && !existingSame.removed) {
          return { status: "skipped", existingId: existingSame.record.id, snapshot: await this.snapshot() };
        }
        const version = digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
        const target = this.#directory(id, version);
        let parent = this.#root;
        for (const component of ["packages", id]) {
          parent = path.join(parent, component);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
          if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) invalid("Skill 管理目录不能包含符号链接。");
        }
        const created = !this.#verifiedSnapshot(id, version, files);
        if (created) fs.renameSync(destination, target);
        const now = Date.now();
        prepared = {
          record: { id, ...metadata, source: "local", sourceUrl: sourceLocator, version, enabled: desiredEnabled, createdAt: now, updatedAt: now },
          files, manualOnly, created,
        };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      if (!before?.skills[prepared.record.id]?.versions[prepared.record.version] &&
        !before?.skills[prepared.record.id]?.retired?.[prepared.record.version]) {
        try { await this.#collectHistory({ id: prepared.record.id, bytes: this.#versionBytes(prepared) }); }
        catch (error) { await this.#discardPrepared(prepared); throw error; }
      }
      let skippedId: string | undefined;
      try {
        await this.#options.harness.commit(async (tx) => {
          const state = await tx.doc(KuloSkillsDoc);
          const repeat = own(state.commands, commandId);
          if (repeat) {
            if (repeat.fingerprint !== fingerprint) throw new SkillError(409, "skill_command_conflict", "同一操作编号不能用于不同的 Skill 请求。");
            return;
          }
          const conflict = Object.values(state.skills).find(
            (entry) => !entry.removed && (entry.record.name === prepared!.record.name || entry.record.id === prepared!.record.id),
          );
          if (conflict) {
            skippedId = conflict.record.id;
            return;
          }
          this.#put(state, prepared!, own(state.skills, prepared!.record.id));
          state.skills[prepared!.record.id]!.record.enabled = desiredEnabled;
          state.skills[prepared!.record.id]!.record.audiences = scope;
          state.commands[commandId] = { fingerprint };
          state.revision++;
        }, BACKGROUND_CONTEXT);
      } catch (error) {
        await this.#discardPrepared(prepared);
        throw error;
      }
      if (skippedId) {
        await this.#discardPrepared(prepared);
        return { status: "skipped", existingId: skippedId, snapshot: await this.snapshot() };
      }
      await this.#collectHistory();
      await this.#options.onChanged?.();
      const snapshot = await this.snapshot();
      return { status: "imported", record: snapshot.skills.find((entry) => entry.id === prepared.record.id), snapshot };
    });
  }

  async #prepare(source: SkillSource, id: string, kind: SkillRecord["source"], scope?: SkillAudience[], previous?: StoredSkill): Promise<PreparedSkill> {
    this.#ensureRoot();
    const work = fs.mkdtempSync(path.join(this.#root, ".staging-"));
    let commit: string | undefined;
    let resolvedSource: { directory: string; commit?: string; dispose(): Promise<void> } | undefined;
    try {
      if (source.kind === "local" && !source.locator.startsWith("project://")) {
        const rootInfo = fs.lstatSync(source.input);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid("Skill 来源需要是普通目录。");
        const canonical = fs.realpathSync(source.input);
        if (canonical === this.#root || canonical.startsWith(`${this.#root}${path.sep}`) || this.#root.startsWith(`${canonical}${path.sep}`)) invalid("Skill 来源不能包含管理目录或位于其中。");
        if (kind === "builtin" && previous?.record.source === "builtin" && !previous.removed) {
          const files = scanSkillDirectory(canonical);
          const { manualOnly, ...metadata } = skillMetadata(canonical, files, scope);
          const version = digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
          if (previous.record.version === version && this.#verifiedSnapshot(id, version, files)) {
            const now = Date.now();
            return { record: { id, ...metadata, source: kind, version, enabled: true, createdAt: now, updatedAt: now }, files, manualOnly };
          }
        }
      }
      fs.mkdirSync(path.join(work, "source"), { mode: 0o700 });
      resolvedSource = await installSkillSource(source, { stagingDir: path.join(work, "source"),
        resolveLocalSource: this.#options.resolveLocalSource, validateDirectory: validateSkillDirectory });
      commit = resolvedSource.commit;
      const canonical = fs.realpathSync(resolvedSource.directory);
      const destination = path.join(work, "snapshot");
      fs.mkdirSync(destination, { mode: 0o700 });
      const files = scanSkillDirectory(canonical, destination);
      const { manualOnly, ...metadata } = skillMetadata(destination, files, scope);
      const version = digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
      const target = this.#directory(id, version);
      let parent = this.#root;
      for (const component of ["packages", id]) {
        parent = path.join(parent, component);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
        if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) invalid("Skill 管理目录不能包含符号链接。");
      }
      const created = !this.#verifiedSnapshot(id, version, files);
      if (created) fs.renameSync(destination, target);
      const now = Date.now();
      return {
        record: { id, ...metadata, source: kind, ...(kind !== "builtin" ? { sourceUrl: source.locator } : {}), version, enabled: true, createdAt: now, updatedAt: now },
        files, manualOnly, created, ...(commit ? { commit } : {}),
      };
    } catch (error) {
      if (error instanceof SkillError) throw error;
      if (error instanceof SkillSourceError) throw new SkillError(error.status, error.code, error.message);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SkillError(404, "skill_source_not_found", "Skill 来源或资源不存在。");
      throw error;
    } finally {
      try { if (resolvedSource) await resolvedSource.dispose(); }
      finally { fs.rmSync(work, { recursive: true, force: true }); }
    }
  }
}
