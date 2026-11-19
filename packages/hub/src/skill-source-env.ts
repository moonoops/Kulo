import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import type { ProjectRecord } from "@moco/protocol";
import type { EnvManager } from "@moco/env";
import type { MocoProjects } from "./projects.js";

const MAX_FILES = 512;
const MAX_ENTRIES = 1024;
const MAX_DEPTH = 16;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const READ_BYTES = 256 * 1024;
const SENSITIVE_NAME = /^(?:credentials?(?:\..+)?|auth(?:\..+)?|secrets?(?:\..+)?|tokens?(?:\..+)?|cookies?(?:\..+)?|api[-_]?keys?(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|pem|p12|pfx))$/i;

export class SkillSourceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = "SkillSourceError";
  }
}
function refuse(message: string, code = "skill_source_denied", status = 403): never {
  throw new SkillSourceError(status, code, message);
}
function portableName(value: string, allowHidden = false): string {
  if (!value || value.length > 255 || /[\x00-\x1f\x7f\\/:?#%]/.test(value) || value === "." || value === ".." || (!allowHidden && value.startsWith(".")) || SENSITIVE_NAME.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    refuse("Skill 来源包含不允许的文件或目录名称。");
  }
  return value;
}
function parseSource(source: string): { projectId: string; parts: string[] } {
  if (typeof source !== "string" || source.length > 4096 || /[\x00-\x1f\x7f\\?#]/.test(source)) refuse("项目 Skill 来源地址无效。", "invalid_skill_source", 400);
  // Parse before URL normalization, which would otherwise discard literal or encoded dot segments.
  const match = /^project:\/\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(.+)$/.exec(source);
  if (!match) refuse("请使用 project://项目ID/相对Skill目录。", "invalid_skill_source", 400);
  const parts = match[2]!.replace(/\/+$/, "").split("/").map((part) => {
    try { return decodeURIComponent(part); } catch { return refuse("项目 Skill 来源编码无效。", "invalid_skill_source", 400); }
  });
  const standardPrefix = (parts[0] === ".agents" || parts[0] === ".pi") && parts[1] === "skills";
  for (let index = 0; index < parts.length; index++) portableName(parts[index]!, standardPrefix && index === 0);
  if (standardPrefix && parts.length < 3) refuse("请指定一个 Skill 目录。", "invalid_skill_source", 400);
  return { projectId: match[1]!, parts };
}
function sameBinding(first: ProjectRecord, next: ProjectRecord): boolean {
  return first.id === next.id && first.deviceId === next.deviceId && first.workspaceDir === next.workspaceDir && first.directoryId === next.directoryId && first.revision === next.revision && first.grantRevision === next.grantRevision && first.scratchRoot === next.scratchRoot;
}
function checkedFile(info: FileInfo): void {
  if (info.kind !== "file") refuse("Skill 只能包含普通文件和目录。");
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE_BYTES) refuse("Skill 单个文件最大支持 4 MiB。", "skill_source_too_large", 413);
  if (!Number.isFinite(info.mtimeMs)) refuse("Skill 文件元信息无效。");
}
function unchanged(first: FileInfo, next: FileInfo): boolean {
  return first.kind === next.kind && first.size === next.size && first.mtimeMs === next.mtimeMs;
}

export interface StageProjectSkillOptions {
  stateDir: string;
  projects: MocoProjects;
  envManager: EnvManager;
}

/** Copy a version-checked project source through its actual read-only execution node. */
export async function stageProjectSkillSource(options: StageProjectSkillOptions, source: string): Promise<{ directory: string; dispose(): Promise<void> }> {
  const { projectId, parts } = parseSource(source);
  const context = BACKGROUND_CONTEXT;
  const project = await options.projects.ensureAuthorized(projectId, context);
  const descriptor = options.envManager.getEnvDescriptor(project.deviceId);
  if (!descriptor?.online) refuse("项目所在设备离线。", "skill_source_offline", 409);
  const paths = (project.platform ?? descriptor.platform) === "win32" ? path.win32 : path.posix;
  const normalized = (value: string) => {
    const result = paths.normalize(value).replace(/[\\/]+$/, "");
    return paths === path.win32 ? result.toLowerCase() : result;
  };
  const equal = (first: string, next: string) => normalized(first) === normalized(next);
  const within = (target: string, root: string) => {
    const relative = paths.relative(normalized(root), normalized(target));
    return !paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`);
  };
  if (!project.scratchRoot || !paths.isAbsolute(project.scratchRoot) || !paths.isAbsolute(project.workspaceDir) || within(project.scratchRoot, project.workspaceDir) || within(project.workspaceDir, project.scratchRoot)) {
    refuse("项目尚未提供独立的受管暂存目录。", "skill_source_scratch_unavailable", 409);
  }
  const scratchDir = paths.join(project.scratchRoot, `skill-import-${randomUUID()}`);
  if (!within(scratchDir, project.scratchRoot) || equal(scratchDir, project.scratchRoot)) refuse("项目暂存授权无效。");
  const env: ExecutionEnv = options.envManager.createWorkerExecutionEnv(project.deviceId, project.workspaceDir, { projectId: project.id, grantRevision: project.grantRevision, scratchDir, readOnly: true });
  let directory: string | undefined;
  let successful = false;
  const observed: Array<{ path: string; canonical: string; info: FileInfo }> = [];
  let fileCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  try {
    await fs.mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const stateRoot = await fs.realpath(options.stateDir);
    const stagingRoot = path.join(stateRoot, "skill-source-staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stagingInfo = await fs.lstat(stagingRoot);
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink() || await fs.realpath(stagingRoot) !== stagingRoot) refuse("Skill 暂存目录不可用。");
    await fs.chmod(stagingRoot, 0o700);
    directory = await fs.mkdtemp(path.join(stagingRoot, "project-"));
    await fs.chmod(directory, 0o700);
    const root = getOrThrow(await env.absolutePath(project.workspaceDir, context));
    const canonicalRoot = getOrThrow(await env.canonicalPath(root, context));
    if (!paths.isAbsolute(canonicalRoot) || !normalized(canonicalRoot) || /^[A-Za-z]:$/.test(normalized(canonicalRoot))) refuse("项目目录边界无效。");
    if (getOrThrow(await env.fileInfo(root, context)).kind !== "directory") refuse("项目目录不可用。");

    async function inspect(target: string, expected: string, expectedKind?: "directory" | "file"): Promise<FileInfo> {
      if (!within(target, root)) refuse("Skill 来源超出项目目录。");
      const info = getOrThrow(await env.fileInfo(target, context));
      if (info.kind !== "directory" && info.kind !== "file") refuse("Skill 不能包含符号链接或特殊文件。");
      if (expectedKind && info.kind !== expectedKind) refuse("Skill 来源文件类型发生变化。", "skill_source_changed", 409);
      const canonical = getOrThrow(await env.canonicalPath(target, context));
      if (!within(canonical, canonicalRoot) || !equal(canonical, expected)) refuse("Skill 来源实际位置已变化。", "skill_source_changed", 409);
      return info;
    }
    let packageRoot = root;
    let canonicalPackageRoot = canonicalRoot;
    for (let index = 0; index < parts.length; index++) {
      packageRoot = getOrThrow(await env.joinPath([root, ...parts.slice(0, index + 1)], context));
      canonicalPackageRoot = getOrThrow(await env.joinPath([canonicalRoot, ...parts.slice(0, index + 1)], context));
      await inspect(packageRoot, canonicalPackageRoot, "directory");
    }
    if (!sameBinding(project, await options.projects.get(projectId, context))) refuse("项目或授权已变化，请重新导入 Skill。", "skill_source_changed", 409);

    async function copyFile(target: string, canonical: string, relative: string[], before: FileInfo): Promise<void> {
      checkedFile(before);
      if (++fileCount > MAX_FILES || (totalBytes += before.size) > MAX_TOTAL_BYTES) refuse("Skill 最多包含 512 个文件，总计不超过 16 MiB。", "skill_source_too_large", 413);
      const reader = getOrThrow(await env.openBinaryReader(canonical, { noFollow: true }, context));
      let bytes: Buffer;
      try {
        const opened = getOrThrow(await reader.info(context));
        checkedFile(opened);
        if (!unchanged(before, opened)) refuse("Skill 文件在读取前发生变化。", "skill_source_changed", 409);
        const chunks: Uint8Array[] = [];
        let offset = 0;
        while (offset < before.size) {
          const length = Math.min(READ_BYTES, before.size - offset);
          const chunk = getOrThrow(await reader.read(offset, length, context));
          if (chunk.length < 1 || chunk.length > length) refuse("Skill 文件读取中断。", "skill_source_read_failed", 502);
          chunks.push(Buffer.from(chunk)); offset += chunk.length;
        }
        const after = getOrThrow(await reader.info(context));
        if (!unchanged(before, after) || !unchanged(before, await inspect(target, canonical, "file"))) refuse("Skill 文件在读取期间发生变化。", "skill_source_changed", 409);
        bytes = Buffer.concat(chunks);
      } finally { await reader.close(withoutAbortSignal(context)); }
      const destination = path.join(directory!, ...relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      observed.push({ path: target, canonical, info: before });
    }

    async function walk(target: string, canonical: string, relative: string[], depth: number): Promise<void> {
      if (depth > MAX_DEPTH) refuse("Skill 目录层级过深。", "skill_source_too_large", 413);
      const before = await inspect(target, canonical, "directory");
      const reader = getOrThrow(await env.openDirReader(target, context));
      const names = new Set<string>();
      try {
        for (;;) {
          const page = getOrThrow(await reader.next(64, context));
          if (page.entries.length > 64) refuse("设备返回的 Skill 文件列表无效。", "skill_source_listing_invalid", 502);
          if (!page.done && !page.entries.length) refuse("设备返回的 Skill 文件列表未前进。", "skill_source_listing_invalid", 502);
          for (const entry of page.entries) {
            if (++entryCount > MAX_ENTRIES) refuse("Skill 文件和目录数量过多。", "skill_source_too_large", 413);
            const name = portableName(entry.name);
            if (names.has(name)) refuse("Skill 目录出现重复文件名。", "skill_source_listing_invalid", 502);
            names.add(name);
            const child = getOrThrow(await env.joinPath([target, name], context));
            const expected = getOrThrow(await env.joinPath([canonical, name], context));
            if (!equal(entry.path, child)) refuse("设备返回的 Skill 文件路径无效。", "skill_source_listing_invalid", 502);
            const info = await inspect(child, expected);
            if (entry.kind !== info.kind) refuse("Skill 文件类型在列出后发生变化。", "skill_source_changed", 409);
            if (info.kind === "directory") await walk(child, expected, [...relative, name], depth + 1);
            else await copyFile(child, expected, [...relative, name], info);
          }
          if (page.done) break;
        }
      } finally { await reader.close(withoutAbortSignal(context)); }
      if (!unchanged(before, await inspect(target, canonical, "directory"))) refuse("Skill 目录在导入期间发生变化。", "skill_source_changed", 409);
      observed.push({ path: target, canonical, info: before });
    }

    await walk(packageRoot, canonicalPackageRoot, [], 0);
    if (!await fs.stat(path.join(directory, "SKILL.md")).then((info) => info.isFile(), (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) refuse("来源目录中没有 SKILL.md。", "invalid_skill_source", 400);
    for (const item of observed) {
      if (!unchanged(item.info, await inspect(item.path, item.canonical, item.info.kind === "directory" ? "directory" : "file"))) refuse("Skill 来源在导入期间发生变化。", "skill_source_changed", 409);
    }
    if (!sameBinding(project, await options.projects.get(projectId, context))) refuse("项目或授权已变化，请重新导入 Skill。", "skill_source_changed", 409);
    if (!options.envManager.getEnvDescriptor(project.deviceId)?.online) refuse("项目所在设备已离线。", "skill_source_offline", 409);
    successful = true;
    const staged = directory;
    return { directory: staged, dispose: async () => { await fs.rm(staged, { recursive: true, force: true }); } };
  } finally {
    try {
      const cleanup = await options.envManager.releaseWorkerExecutionEnv(project.deviceId, project.workspaceDir, { scratchDir });
      if (cleanup.cleanupPending) refuse("项目读取环境尚未完成清理，请稍后重试。", "skill_source_cleanup_pending", 409);
      if (successful && !sameBinding(project, await options.projects.get(projectId, context))) refuse("项目或授权已变化，请重新导入 Skill。", "skill_source_changed", 409);
    } catch (error) { successful = false; throw error; }
    finally { if (!successful && directory) await fs.rm(directory, { recursive: true, force: true }); }
  }
}
