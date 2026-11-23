import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RecoveryFileEntry, RecoveryManifestOptions, RecoveryReleaseIdentity, RecoveryReleaseManifest } from "./types.js";
import { atomicJson, fail, inside, readJson, redact } from "./files.js";

export const RELEASE_MANIFEST_FILE = "kulo-release.json";
export const RELEASE_IDENTITY_FILE = "kulo-release.identity.json";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^release_[a-f0-9]{24}$/;
const NAME = /^[A-Za-z0-9._:+/-]{1,160}$/;
const MAX_FILES = 100_000;
const MAX_BYTES = 8 * 1024 ** 3;
const FORBIDDEN_ROOT = new Set([".env", ".git", ".npmrc", "credentials.json", "runtime-token", "connection.json"]);

export function releaseId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_release_id", "版本标识无效。");
  return value;
}

export function relativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(value) || path.posix.isAbsolute(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) fail("invalid_release_path", "版本包含无效的相对路径。");
  return value;
}

function number(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("invalid_release_manifest", "版本清单中的数值无效。");
  return value;
}

function name(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value) || redact(value) !== value) fail("invalid_release_manifest", "版本清单中的身份字段无效。");
  return value;
}

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}

function contentIdentity(manifest: Omit<RecoveryReleaseManifest, "id">): string {
  return digest(canonical(manifest));
}

export function validateReleaseManifest(input: unknown): RecoveryReleaseManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_release_manifest", "版本清单无效。");
  const m = input as Record<string, unknown>;
  const fields = ["formatVersion", "id", "version", "kind", "sourceCommit", "sourceTreeHash", "baseReleaseId", "customizationRevision", "platform", "arch", "nodeMajor", "shellVersion", "protocolVersion", "dataVersion", "minDataVersion", "maxDataVersion", "runtimeEntry", "webDir", "files", "artifactHash", "checks"];
  if (Object.keys(m).some((key) => !fields.includes(key)) || m.formatVersion !== 1 || !["official", "custom"].includes(String(m.kind))) fail("invalid_release_manifest", "版本清单格式不受支持。");
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES || !Array.isArray(m.checks) || m.checks.length > 64) fail("invalid_release_manifest", "版本文件或验证记录无效。");
  const paths = new Set<string>();
  let total = 0;
  const files: RecoveryFileEntry[] = m.files.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_release_manifest", "版本文件记录无效。");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["path", "kind", "size", "sha256", "target", "executable"].includes(key)) || value.executable !== undefined && typeof value.executable !== "boolean") fail("invalid_release_manifest", "版本文件包含未知字段或无效权限。");
    const filename = relativePath(value.path);
    if ([RELEASE_MANIFEST_FILE, RELEASE_IDENTITY_FILE].includes(filename) || paths.has(filename) || FORBIDDEN_ROOT.has(filename.split("/")[0]!) || filename.split("/")[0]!.startsWith(".env.")) fail("invalid_release_manifest", "版本包含重复文件或私有配置。");
    paths.add(filename);
    if (!["file", "symlink"].includes(String(value.kind)) || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) fail("invalid_release_manifest", "版本文件摘要无效。");
    const size = number(value.size);
    total += size;
    if (total > MAX_BYTES) fail("release_too_large", "版本超过受管制品大小限制。");
    if (value.kind === "symlink") {
      if (value.executable !== undefined) fail("invalid_release_manifest", "链接不能声明可执行权限。");
      if (typeof value.target !== "string" || !value.target || path.isAbsolute(value.target) || /[\x00-\x1f\x7f\\]/.test(value.target) || value.target.length > 4096 ||
          !inside("/release", path.resolve("/release", path.posix.dirname(filename), value.target))) fail("unsafe_release_link", "版本链接指向制品外部。");
      return { path: filename, kind: "symlink", size, sha256: value.sha256, target: value.target };
    }
    if (value.target !== undefined) fail("invalid_release_manifest", "普通版本文件不能声明链接。");
    return { path: filename, kind: "file", size, sha256: value.sha256, executable: value.executable ?? false };
  });
  if (files.some((entry, index) => index > 0 && files[index - 1]!.path.localeCompare(entry.path, "en") >= 0)) fail("invalid_release_manifest", "版本文件清单顺序无效。");
  const checks = m.checks.map((check) => {
    if (typeof check !== "string" || !check.trim() || check.length > 160 || /[\x00-\x1f\x7f]/.test(check) || redact(check) !== check) fail("invalid_release_manifest", "版本验证记录无效或包含私有认证内容。");
    return check;
  });
  const body: Omit<RecoveryReleaseManifest, "id"> = {
    formatVersion: 1,
    version: name(m.version),
    kind: m.kind as RecoveryReleaseManifest["kind"],
    ...(m.sourceCommit === undefined ? {} : { sourceCommit: name(m.sourceCommit) }),
    ...(m.sourceTreeHash === undefined ? {} : { sourceTreeHash: typeof m.sourceTreeHash === "string" && HASH.test(m.sourceTreeHash) ? m.sourceTreeHash : fail("invalid_release_manifest", "源码树摘要无效。") }),
    ...(m.baseReleaseId === undefined ? {} : { baseReleaseId: releaseId(m.baseReleaseId) }),
    ...(m.customizationRevision === undefined ? {} : { customizationRevision: name(m.customizationRevision) }),
    platform: name(m.platform), arch: name(m.arch), nodeMajor: number(m.nodeMajor, 22), shellVersion: name(m.shellVersion),
    protocolVersion: number(m.protocolVersion, 1), dataVersion: number(m.dataVersion, 1),
    minDataVersion: number(m.minDataVersion, 1), maxDataVersion: number(m.maxDataVersion, 1),
    runtimeEntry: relativePath(m.runtimeEntry), webDir: relativePath(m.webDir), files,
    artifactHash: typeof m.artifactHash === "string" && HASH.test(m.artifactHash) ? m.artifactHash : fail("invalid_release_manifest", "版本制品摘要无效。"),
    checks,
  };
  if (body.minDataVersion > body.dataVersion || body.dataVersion > body.maxDataVersion) fail("invalid_release_manifest", "版本的数据兼容范围无效。");
  if (!paths.has(body.runtimeEntry) || !paths.has(body.webDir + "/index.html")) fail("incomplete_release", "版本缺少运行入口或界面入口。");
  if (body.artifactHash !== digest(JSON.stringify(files))) fail("release_digest_mismatch", "版本文件清单摘要不一致。");
  const id = releaseId(m.id);
  if (id !== "release_" + contentIdentity(body).slice(0, 24)) fail("release_digest_mismatch", "版本身份与清单内容不一致。");
  return { ...body, id };
}

async function fileDigest(filename: string): Promise<{ size: number; sha256: string; executable: boolean }> {
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("unsafe_release_file", "版本包含非普通文件。");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("release_changed", "版本在校验期间发生变化。");
    if (process.platform !== "win32" && (before.mode & 0o111) !== (after.mode & 0o111)) fail("release_changed", "版本权限在校验期间发生变化。");
    return { size: after.size, sha256: hash.digest("hex"), executable: process.platform === "win32" ? false : Boolean(after.mode & 0o111) };
  } finally { await handle.close(); }
}

async function tree(root: string): Promise<RecoveryFileEntry[]> {
  const canonical = await fsp.realpath(root);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("unsafe_release_root", "版本根目录必须是普通目录。");
  const files: RecoveryFileEntry[] = [];
  let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if ([RELEASE_MANIFEST_FILE, RELEASE_IDENTITY_FILE].includes(relative)) continue;
      relativePath(relative);
      if (FORBIDDEN_ROOT.has(relative.split("/")[0]!) || relative.split("/")[0]!.startsWith(".env.")) fail("private_release_content", "发布制品不能包含私有配置或源码仓库。");
      const stat = await fsp.lstat(filename);
      if (stat.isSymbolicLink()) {
        const target = await fsp.readlink(filename);
        const resolved = await fsp.realpath(filename);
        if (path.isAbsolute(target) || /[\x00-\x1f\x7f\\]/.test(target) || !inside(canonical, resolved)) fail("unsafe_release_link", "版本链接指向制品外部。");
        files.push({ path: relative, kind: "symlink", size: Buffer.byteLength(target), sha256: digest(target), target });
      } else if (stat.isDirectory()) {
        await walk(filename);
      } else if (stat.isFile()) {
        const info = await fileDigest(filename);
        files.push({ path: relative, kind: "file", ...info });
        total += info.size;
      } else fail("unsafe_release_file", "版本包含不支持的文件类型。");
      if (files.length > MAX_FILES || total > MAX_BYTES) fail("release_too_large", "版本超过受管制品大小限制。");
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function createReleaseManifest(root: string, options: RecoveryManifestOptions): Promise<RecoveryReleaseManifest> {
  const files = await tree(path.resolve(root));
  const dataVersion = options.dataVersion ?? 3;
  const body: Omit<RecoveryReleaseManifest, "id"> = {
    formatVersion: 1, version: options.version, kind: options.kind,
    ...(options.sourceCommit === undefined ? {} : { sourceCommit: options.sourceCommit }),
    ...(options.sourceTreeHash === undefined ? {} : { sourceTreeHash: options.sourceTreeHash }),
    ...(options.baseReleaseId === undefined ? {} : { baseReleaseId: options.baseReleaseId }),
    ...(options.customizationRevision === undefined ? {} : { customizationRevision: options.customizationRevision }),
    platform: options.platform ?? process.platform, arch: options.arch ?? process.arch,
    nodeMajor: options.nodeMajor ?? Number(process.versions.node.split(".")[0]),
    shellVersion: options.shellVersion ?? "1", protocolVersion: options.protocolVersion ?? 1,
    dataVersion, minDataVersion: options.minDataVersion ?? dataVersion, maxDataVersion: options.maxDataVersion ?? dataVersion,
    runtimeEntry: options.runtimeEntry ?? "dist/runtime.js", webDir: options.webDir ?? "web/dist",
    files, artifactHash: digest(JSON.stringify(files)), checks: options.checks ?? [],
  };
  return validateReleaseManifest({ ...body, id: "release_" + contentIdentity(body).slice(0, 24) });
}

export function readReleaseManifest(root: string): RecoveryReleaseManifest {
  return validateReleaseManifest(readJson(path.join(root, RELEASE_MANIFEST_FILE), 32 * 1024 ** 2));
}

export function releaseIdentity(input: RecoveryReleaseManifest): RecoveryReleaseIdentity {
  const manifest = validateReleaseManifest(input);
  const { files, ...identity } = manifest;
  return {
    ...identity,
    entryFiles: files.filter((entry) => entry.path === manifest.runtimeEntry || entry.path === manifest.webDir + "/index.html"),
    inventoryHash: digest(canonical(manifest)),
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  };
}

export function validateReleaseIdentity(input: unknown): RecoveryReleaseIdentity {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_release_identity", "版本启动清单无效。");
  const identity = input as RecoveryReleaseIdentity;
  const { entryFiles, inventoryHash, fileCount, totalBytes, ...common } = identity;
  if (!Array.isArray(entryFiles) || entryFiles.length !== 2 || !HASH.test(String(inventoryHash)) || !HASH.test(String(common.artifactHash))) fail("invalid_release_identity", "版本启动摘要无效。");
  const { id: originalId, ...withoutId } = common;
  releaseId(originalId);
  const probeBody = { ...withoutId, files: entryFiles, artifactHash: digest(JSON.stringify(entryFiles)) };
  const checked = validateReleaseManifest({ ...probeBody, id: "release_" + contentIdentity(probeBody).slice(0, 24) });
  if (entryFiles.some((entry) => entry.kind !== "file")) fail("unsafe_release_entry", "版本入口必须是普通文件。");
  number(fileCount, 2); number(totalBytes);
  const { files: _files, ...fields } = checked;
  return { ...fields, id: originalId, artifactHash: common.artifactHash, entryFiles, inventoryHash, fileCount, totalBytes };
}

export function writeReleaseManifest(root: string, manifest: RecoveryReleaseManifest): void {
  const checked = validateReleaseManifest(manifest);
  atomicJson(path.join(root, RELEASE_MANIFEST_FILE), checked);
  atomicJson(path.join(root, RELEASE_IDENTITY_FILE), releaseIdentity(checked));
}

export function readReleaseIdentity(root: string): RecoveryReleaseIdentity {
  return validateReleaseIdentity(readJson(path.join(root, RELEASE_IDENTITY_FILE), 64 * 1024));
}

export async function verifyReleaseIdentity(root: string, input: RecoveryReleaseIdentity): Promise<void> {
  const identity = validateReleaseIdentity(input);
  const canonical = await fsp.realpath(root);
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_release_root", "版本根目录无效。");
  for (const expected of identity.entryFiles) {
    const filename = path.join(root, expected.path);
    if (!inside(canonical, await fsp.realpath(filename))) fail("unsafe_release_link", "版本入口指向制品外部。");
    const actual = await fileDigest(filename);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.executable !== Boolean(expected.executable)) fail("release_digest_mismatch", "版本入口或执行权限与已验证清单不一致。");
  }
}

export async function verifyRelease(root: string, input: RecoveryReleaseManifest, options: { full?: boolean } = {}): Promise<void> {
  const manifest = validateReleaseManifest(input);
  const canonical = await fsp.realpath(root);
  if (!(await fsp.lstat(root)).isDirectory() || (await fsp.lstat(root)).isSymbolicLink()) fail("unsafe_release_root", "版本根目录无效。");
  if (options.full !== false) {
    const actual = await tree(path.resolve(root));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail("release_digest_mismatch", "版本文件与已验证清单不一致。");
  } else {
    for (const name of [manifest.runtimeEntry, manifest.webDir + "/index.html"]) {
      const expected = manifest.files.find((entry) => entry.path === name)!;
      const filename = path.join(root, name);
      if (!inside(canonical, await fsp.realpath(filename))) fail("unsafe_release_link", "版本入口指向制品外部。");
      if (expected.kind !== "file") fail("unsafe_release_entry", "版本入口必须是普通文件。");
      const actual = await fileDigest(filename);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.executable !== Boolean(expected.executable)) fail("release_digest_mismatch", "版本入口或执行权限与已验证清单不一致。");
    }
  }
}
