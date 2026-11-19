import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { StagedWorkspaceApplyResult, StagedWorkspaceDiffDetail, StagedWorkspaceDiffSummary } from "@kulo/protocol";

export interface ManifestEntry {
  sha256: string;
  size: number;
  mode: number;
  binary: boolean;
  symlinkTarget?: string;
  kind?: "file" | "dir" | "symlink";
  mtimeMs?: number;
  mtimeNs?: string;
  ino?: number;
  manifestVersion?: number;
}

export type WorkspaceManifest = Record<string, ManifestEntry>;

export const SAFE_HOST_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;

export function safeHostGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

const MANIFEST_VERSION = 2;
const HARD_IGNORED_NAMES = new Set([".git", ".kulo-env", "node_modules", ".DS_Store"]);
const DEFAULT_BUILD_CACHE_DIRS = new Set([
  "dist",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  ".venv",
]);
const DEFAULT_BUILD_CACHE_FILE_SUFFIXES = [".tsbuildinfo", ".pyc", ".pyo"];
const MAX_TEXT_DIFF_FILE_BYTES = 512 * 1024;
const STREAM_HASH_CHUNK_BYTES = 64 * 1024;
const STAT_CACHE_RACY_WINDOW_MS = 2000;
const LIFECYCLE_SCRIPT_KEYS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "preversion",
  "version",
  "postversion",
]);

export const STAGED_NON_COW_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const STAGED_NON_COW_MAX_FILES = 50_000;

export class StagedWorkspaceConflictError extends Error {
  readonly code = "staged_workspace_conflict";
  constructor(readonly conflictFiles: string[]) {
    super(`目标项目目录在任务执行期间发生了并发修改，存在冲突文件：${conflictFiles.join(", ")}`);
    this.name = "StagedWorkspaceConflictError";
  }
}

export class StagedWorkspaceOversizedError extends Error {
  readonly code = "staged_workspace_oversized";
  constructor(
    readonly details: {
      totalBytes: number;
      totalFiles: number;
      maxBytes: number;
      maxFiles: number;
    },
  ) {
    const mb = Math.round(details.totalBytes / (1024 * 1024));
    const maxMb = Math.round(details.maxBytes / (1024 * 1024));
    super(
      `当前文件系统不支持写时复制克隆，且项目非构建缓存文件体积过大（约 ${mb} MiB / ${details.totalFiles} 个文件，上限 ${maxMb} MiB / ${details.maxFiles} 个文件）。`,
    );
    this.name = "StagedWorkspaceOversizedError";
  }
}

interface GitignoreRule {
  baseDir: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegexSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i + 1) {
        const body = glob.slice(i + 1, close).replace(/^!/, "^");
        out += `[${body}]`;
        i = close + 1;
      } else {
        out += "\\[";
        i += 1;
      }
    } else {
      out += escapeRegexChar(ch);
      i += 1;
    }
  }
  return out;
}

function parseGitignoreFile(filePath: string, baseDir: string): GitignoreRule[] {
  if (!fs.existsSync(filePath)) return [];
  let raw = "";
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return [];
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rules: GitignoreRule[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1);
    }
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) {
      line = line.slice(1);
    }
    if (!line) continue;
    const pattern = globToRegexSource(line);
    const regex = anchored
      ? new RegExp(`^${pattern}(?:/.*)?$`)
      : new RegExp(`(?:^|/)${pattern}(?:/.*)?$`);
    rules.push({ baseDir, negated, dirOnly, anchored, regex });
  }
  return rules;
}

function matchesGitignore(relPosix: string, isDir: boolean, rules: readonly GitignoreRule[]): boolean | undefined {
  let matched: boolean | undefined;
  for (const rule of rules) {
    let candidate = relPosix;
    if (rule.baseDir) {
      if (!relPosix.startsWith(`${rule.baseDir}/`)) continue;
      candidate = relPosix.slice(rule.baseDir.length + 1);
    }
    if (rule.dirOnly && !isDir) {
      // Directory-only rule still matches children inside the directory via (?:/.*)?
      // Check whether any ancestor directory matches when anchored/non-anchored:
      const slashIdx = candidate.lastIndexOf("/");
      if (slashIdx < 0) continue;
      const parentCandidate = candidate.slice(0, slashIdx);
      if (rule.regex.test(parentCandidate)) {
        matched = !rule.negated;
      }
      continue;
    }
    if (rule.regex.test(candidate)) {
      matched = !rule.negated;
    }
  }
  return matched;
}

function isDefaultBuildCache(name: string, isDir: boolean): boolean {
  if (isDir) return DEFAULT_BUILD_CACHE_DIRS.has(name);
  return DEFAULT_BUILD_CACHE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function shouldIgnoreEntry(
  relPosix: string,
  name: string,
  isDir: boolean,
  rules: readonly GitignoreRule[],
  baseline?: WorkspaceManifest,
  extraIgnoredPrefixes?: readonly string[],
): boolean {
  if (HARD_IGNORED_NAMES.has(name)) return true;
  if (extraIgnoredPrefixes?.some((prefix) => relPosix === prefix || relPosix.startsWith(`${prefix}/`))) {
    return true;
  }
  // Never let new .gitignore rules hide changes/deletions of files already in baseline
  if (baseline && Object.hasOwn(baseline, relPosix)) {
    return false;
  }
  const gitignoreDecision = matchesGitignore(relPosix, isDir, rules);
  if (gitignoreDecision !== undefined) {
    return gitignoreDecision;
  }
  return isDefaultBuildCache(name, isDir);
}

function toPosixRelative(rel: string): string {
  return rel.split(path.sep).join("/");
}

function assertSafeRelativePath(relPosix: string): string {
  if (!relPosix || relPosix.startsWith("/") || relPosix.includes("\0")) {
    throw new Error(`Invalid relative workspace path: ${relPosix}`);
  }
  const segments = relPosix.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === ".." || HARD_IGNORED_NAMES.has(seg))) {
    throw new Error(`Disallowed relative workspace path: ${relPosix}`);
  }
  return segments.join(path.sep);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buf = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return buf.subarray(0, end).toString("utf8");
}

function assertNoSymlinkEscape(rootDir: string, relPosix: string, options?: { allowTargetSymlink?: boolean }): string {
  const segments = relPosix.split("/");
  let current = rootDir;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]!);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing to traverse symbolic link or non-directory when applying staged path: ${relPosix}`);
      }
    }
  }
  const target = path.join(rootDir, ...segments);
  if (!options?.allowTargetSymlink && fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link in project workspace: ${relPosix}`);
  }
  return target;
}

function inspectFile(filePath: string, stat: fs.BigIntStats, cached?: ManifestEntry, nowMs = Date.now()): ManifestEntry {
  const mode = Number(stat.mode) & 0o777;
  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  const mtimeNs = stat.mtimeNs.toString();
  const ino = Number(stat.ino);

  if (
    cached &&
    cached.manifestVersion === MANIFEST_VERSION &&
    cached.kind === "file" &&
    cached.symlinkTarget === undefined &&
    cached.size === size &&
    cached.mtimeNs === mtimeNs &&
    cached.ino === ino &&
    ino !== 0 &&
    nowMs - mtimeMs > STAT_CACHE_RACY_WINDOW_MS
  ) {
    return {
      sha256: cached.sha256,
      size,
      mode,
      binary: cached.binary,
      kind: "file",
      mtimeMs,
      mtimeNs,
      ino,
      manifestVersion: MANIFEST_VERSION,
    };
  }

  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STREAM_HASH_CHUNK_BYTES);
  let binary = false;
  let checkedBinary = false;
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      if (!checkedBinary) {
        checkedBinary = true;
        binary = chunk.subarray(0, Math.min(bytesRead, 8192)).includes(0);
      }
      hash.update(chunk);
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    sha256: hash.digest("hex"),
    size,
    mode,
    binary,
    kind: "file",
    mtimeMs,
    mtimeNs,
    ino,
    manifestVersion: MANIFEST_VERSION,
  };
}

function isWithinRoot(canonicalRoot: string, candidatePath: string): boolean {
  const relTarget = path.relative(canonicalRoot, candidatePath);
  return relTarget === "" || (relTarget !== ".." && !relTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relTarget));
}

function inspectSymlink(rawLink: string): ManifestEntry {
  return {
    sha256: createHash("sha256").update(`symlink:${rawLink}`).digest("hex"),
    size: Buffer.byteLength(rawLink, "utf8"),
    mode: 0o777,
    binary: false,
    symlinkTarget: rawLink,
    kind: "symlink",
    manifestVersion: MANIFEST_VERSION,
  };
}

function inspectEmptyDir(mode: number): ManifestEntry {
  return {
    sha256: "dir:empty",
    size: 0,
    mode: mode & 0o777,
    binary: false,
    kind: "dir",
    manifestVersion: MANIFEST_VERSION,
  };
}

export function scanWorkspaceManifest(
  rootDir: string,
  options?: {
    rejectExternalSymlinks?: boolean;
    baseline?: WorkspaceManifest;
    statCache?: WorkspaceManifest;
    extraIgnoredPaths?: readonly string[];
  },
): WorkspaceManifest {
  const manifest: WorkspaceManifest = {};
  if (!fs.existsSync(rootDir)) return manifest;
  const canonicalRoot = fs.realpathSync(rootDir);
  const nowMs = Date.now();
  const extraIgnoredPrefixes = options?.extraIgnoredPaths
    ?.map((candidate) => {
      try {
        const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
        if (!isWithinRoot(canonicalRoot, resolved)) return undefined;
        const rel = toPosixRelative(path.relative(canonicalRoot, resolved));
        return rel && rel !== "." ? rel : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));

  const rootRules: GitignoreRule[] = [];
  const gitExclude = path.join(rootDir, ".git", "info", "exclude");
  rootRules.push(...parseGitignoreFile(gitExclude, ""));

  const walk = (currentDir: string, relDir: string, inheritedRules: readonly GitignoreRule[]): number => {
    const localGitignore = parseGitignoreFile(path.join(currentDir, ".gitignore"), relDir);
    const activeRules = localGitignore.length > 0 ? [...inheritedRules, ...localGitignore] : inheritedRules;
    let nonIgnoredCount = 0;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const lstat = fs.lstatSync(fullPath, { bigint: true });
      const isDir = lstat.isDirectory();

      if (shouldIgnoreEntry(rel, entry.name, isDir, activeRules, options?.baseline, extraIgnoredPrefixes)) {
        continue;
      }

      if (lstat.isSymbolicLink()) {
        nonIgnoredCount += 1;
        const rawLink = fs.readlinkSync(fullPath);
        const unchangedBaselineSymlink = options?.baseline?.[rel]?.symlinkTarget === rawLink;
        if (options?.rejectExternalSymlinks && !unchangedBaselineSymlink) {
          const parentReal = fs.realpathSync(path.dirname(fullPath));
          const lexicalTarget = path.resolve(parentReal, rawLink);
          if (!isWithinRoot(canonicalRoot, lexicalTarget)) {
            throw new Error(`Refusing symbolic link escaping staged workspace: ${rel}`);
          }
          if (fs.existsSync(fullPath) && !isWithinRoot(canonicalRoot, fs.realpathSync(fullPath))) {
            throw new Error(`Refusing symbolic link escaping staged workspace: ${rel}`);
          }
        }
        manifest[rel] = inspectSymlink(rawLink);
        continue;
      }

      if (isDir) {
        const childCount = walk(fullPath, rel, activeRules);
        nonIgnoredCount += 1;
        if (childCount === 0) {
          manifest[rel] = inspectEmptyDir(Number(lstat.mode));
        }
      } else if (lstat.isFile()) {
        nonIgnoredCount += 1;
        manifest[rel] = inspectFile(fullPath, lstat, options?.statCache?.[rel], nowMs);
      }
    }

    return nonIgnoredCount;
  };

  walk(rootDir, "", rootRules);
  return manifest;
}

export interface CloneStagedWorkspaceOptions {
  onWarning?: (message: string) => void;
  maxNonCowBytes?: number;
  maxNonCowFiles?: number;
  forceNonCow?: boolean;
}

export function preflightNonCowWorkspace(
  sourceDir: string,
  options?: { maxBytes?: number; maxFiles?: number },
): { totalBytes: number; totalFiles: number } {
  const maxBytes = options?.maxBytes ?? STAGED_NON_COW_MAX_BYTES;
  const maxFiles = options?.maxFiles ?? STAGED_NON_COW_MAX_FILES;
  const rootRules = [
    ...parseGitignoreFile(path.join(sourceDir, ".git", "info", "exclude"), ""),
    ...parseGitignoreFile(path.join(sourceDir, ".gitignore"), ""),
  ];
  let totalBytes = 0;
  let totalFiles = 0;

  const walk = (absDir: string, relDir: string, inheritedRules: readonly GitignoreRule[]) => {
    const localRules = relDir ? parseGitignoreFile(path.join(absDir, ".gitignore"), relDir) : [];
    const activeRules = localRules.length > 0 ? [...inheritedRules, ...localRules] : inheritedRules;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (HARD_IGNORED_NAMES.has(entry.name)) continue;
      const fullPath = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      const isDir = stat.isDirectory();
      if (shouldIgnoreEntry(rel, entry.name, isDir, activeRules)) continue;
      if (isDir) {
        walk(fullPath, rel, activeRules);
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        totalFiles += 1;
        totalBytes += stat.isFile() ? stat.size : 0;
        if (totalFiles > maxFiles || totalBytes > maxBytes) {
          throw new StagedWorkspaceOversizedError({ totalBytes, totalFiles, maxBytes, maxFiles });
        }
      }
    }
  };

  walk(sourceDir, "", rootRules);
  return { totalBytes, totalFiles };
}

function tryOfflinePnpmInstall(sourceDir: string, stagedDir: string, onWarning?: (message: string) => void): void {
  const hasLockfile = fs.existsSync(path.join(stagedDir, "pnpm-lock.yaml"));
  const hasSourceNodeModules = fs.existsSync(path.join(sourceDir, "node_modules"));
  if (!hasLockfile || !hasSourceNodeModules) return;

  const storeCheck = spawnSync("pnpm", ["store", "path"], {
    cwd: stagedDir,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const storePath = storeCheck.status === 0 ? storeCheck.stdout.trim() : "";
  if (!storePath || !fs.existsSync(storePath)) {
    onWarning?.("Staged workspace excluded node_modules on non-CoW platform and no local pnpm store was found; dependencies may need to be installed if tests require them.");
    return;
  }

  const install = spawnSync(
    "pnpm",
    ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    {
      cwd: stagedDir,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (install.status !== 0) {
    onWarning?.(`Offline pnpm install in staged workspace failed (exit ${install.status ?? "unknown"}); proceeding without node_modules.`);
  }
}

function isFicloneUnsupported(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "ENOTSUP" || code === "EXDEV" || code === "EOPNOTSUPP" || code === "EINVAL" || code === "ENOSYS";
}

export function cloneStagedWorkspace(
  sourceDir: string,
  stagedDir: string,
  options?: CloneStagedWorkspaceOptions,
): WorkspaceManifest {
  const baseline = scanWorkspaceManifest(sourceDir);
  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagedDir), { recursive: true, mode: 0o700 });

  const rootRules = [
    ...parseGitignoreFile(path.join(sourceDir, ".git", "info", "exclude"), ""),
    ...parseGitignoreFile(path.join(sourceDir, ".gitignore"), ""),
  ];
  const resolvedSource = path.resolve(sourceDir);

  const makeFilter = (includeNodeModules: boolean) => (src: string): boolean => {
    const resolvedSrc = path.resolve(src);
    const relRaw = path.relative(resolvedSource, resolvedSrc);
    if (!relRaw) return true;
    if (relRaw === ".." || relRaw.startsWith(`..${path.sep}`) || path.isAbsolute(relRaw)) return false;
    const relPosix = toPosixRelative(relRaw);
    const name = path.basename(resolvedSrc);
    if (name === ".kulo-env") return false;
    if (name === ".git" || relPosix.startsWith(".git/")) return true;
    if (name === "node_modules") return includeNodeModules;
    if (!includeNodeModules) {
      let isDir = false;
      try {
        isDir = fs.lstatSync(resolvedSrc).isDirectory();
      } catch {
        isDir = false;
      }
      if (shouldIgnoreEntry(relPosix, name, isDir, rootRules, baseline)) {
        return false;
      }
    }
    return true;
  };

  let usedCow = false;
  if (!options?.forceNonCow && (process.platform === "darwin" || process.platform === "linux")) {
    try {
      fs.cpSync(sourceDir, stagedDir, {
        recursive: true,
        verbatimSymlinks: true,
        mode: fs.constants.COPYFILE_FICLONE,
        filter: makeFilter(true),
      });
      usedCow = true;
    } catch (error) {
      if (!isFicloneUnsupported(error)) throw error;
      fs.rmSync(stagedDir, { recursive: true, force: true });
    }
  }

  if (!usedCow) {
    preflightNonCowWorkspace(sourceDir, {
      maxBytes: options?.maxNonCowBytes,
      maxFiles: options?.maxNonCowFiles,
    });
    fs.cpSync(sourceDir, stagedDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: makeFilter(false),
    });
    tryOfflinePnpmInstall(sourceDir, stagedDir, options?.onWarning);
  }

  return baseline;
}

function hasExecBitDiff(before: ManifestEntry | undefined, after: ManifestEntry | undefined): boolean {
  if (process.platform === "win32") return false;
  if (!before || !after) return false;
  if (before.kind === "dir" || after.kind === "dir") return false;
  if (before.symlinkTarget !== undefined || after.symlinkTarget !== undefined) return false;
  return (before.mode & 0o111) !== (after.mode & 0o111);
}

function readPackageLifecycleScripts(filePath: string | undefined): { valid: boolean; scripts: Record<string, string> } {
  if (!filePath || !fs.existsSync(filePath)) return { valid: true, scripts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { valid: false, scripts: {} };
    const rawScripts = (parsed as { scripts?: unknown }).scripts;
    if (!rawScripts || typeof rawScripts !== "object" || Array.isArray(rawScripts)) return { valid: true, scripts: {} };
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (LIFECYCLE_SCRIPT_KEYS.has(key) && typeof value === "string") {
        scripts[key] = value;
      }
    }
    return { valid: true, scripts };
  } catch {
    return { valid: false, scripts: {} };
  }
}

function hasPackageLifecycleScriptChange(beforePath: string | undefined, afterPath: string | undefined): boolean {
  const before = readPackageLifecycleScripts(beforePath);
  const after = readPackageLifecycleScripts(afterPath);
  if (!after.valid) return true;
  const keys = new Set([...Object.keys(before.scripts), ...Object.keys(after.scripts)]);
  for (const key of keys) {
    if (before.scripts[key] !== after.scripts[key]) return true;
  }
  return false;
}

function isAutoExecSensitivePath(
  relPosix: string,
  beforePath: string | undefined,
  afterPath: string | undefined,
): boolean {
  if (
    relPosix === ".husky" ||
    relPosix.startsWith(".husky/") ||
    relPosix.includes("/.husky/") ||
    relPosix === ".envrc" ||
    relPosix.endsWith("/.envrc") ||
    relPosix === ".vscode" ||
    relPosix.startsWith(".vscode/") ||
    relPosix.includes("/.vscode/") ||
    relPosix === ".github/workflows" ||
    relPosix.startsWith(".github/workflows/") ||
    relPosix.includes("/.github/workflows/")
  ) {
    return true;
  }
  if (relPosix === "package.json" || relPosix.endsWith("/package.json")) {
    return hasPackageLifecycleScriptChange(beforePath, afterPath);
  }
  return false;
}

function formatOctalMode(mode: number): string {
  return `100${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function renderUnifiedFileDiff(
  relPath: string,
  beforePath: string | undefined,
  afterPath: string | undefined,
  beforeMeta: ManifestEntry | undefined,
  afterMeta: ManifestEntry | undefined,
  options?: { isConflict?: boolean; modeChanged?: boolean },
): string {
  const conflictBanner = options?.isConflict
    ? "[Source file modified concurrently since task baseline; diff shown against current live file]\n"
    : "";
  if (beforeMeta?.kind === "dir" || afterMeta?.kind === "dir") {
    const action = !beforeMeta ? "added" : "deleted";
    return `diff --staged a/${relPath} b/${relPath}\n${conflictBanner}[${action} empty directory]\n`;
  }
  if (beforeMeta?.symlinkTarget !== undefined || afterMeta?.symlinkTarget !== undefined) {
    const action = !beforeMeta ? "added" : !afterMeta ? "deleted" : "modified";
    return `diff --staged a/${relPath} b/${relPath}\n${conflictBanner}[${action} symlink: ${beforeMeta?.symlinkTarget ?? "(none)"} -> ${afterMeta?.symlinkTarget ?? "(none)"}]\n`;
  }
  const modeLines =
    options?.modeChanged && beforeMeta && afterMeta
      ? [`old mode ${formatOctalMode(beforeMeta.mode)}`, `new mode ${formatOctalMode(afterMeta.mode)}`]
      : [];
  if (
    beforeMeta &&
    afterMeta &&
    beforeMeta.sha256 === afterMeta.sha256 &&
    options?.modeChanged &&
    !options?.isConflict
  ) {
    return `diff --staged a/${relPath} b/${relPath}\n${modeLines.join("\n")}\n`;
  }
  if ((beforeMeta?.binary || afterMeta?.binary) || (beforeMeta?.size ?? 0) > MAX_TEXT_DIFF_FILE_BYTES || (afterMeta?.size ?? 0) > MAX_TEXT_DIFF_FILE_BYTES) {
    const action = !beforeMeta ? "added" : !afterMeta ? "deleted" : "modified";
    const modeNote = modeLines.length > 0 ? `${modeLines.join("\n")}\n` : "";
    return `diff --staged a/${relPath} b/${relPath}\n${conflictBanner}${modeNote}[${action} binary or large file: ${beforeMeta?.size ?? 0}B -> ${afterMeta?.size ?? 0}B]\n`;
  }
  const beforeLines = beforePath && fs.existsSync(beforePath) ? fs.readFileSync(beforePath, "utf8").split("\n") : [];
  const afterLines = afterPath && fs.existsSync(afterPath) ? fs.readFileSync(afterPath, "utf8").split("\n") : [];
  const header = [
    ...(conflictBanner ? [conflictBanner.trimEnd()] : []),
    ...modeLines,
    `--- ${beforeMeta ? `a/${relPath}` : "/dev/null"}`,
    `+++ ${afterMeta ? `b/${relPath}` : "/dev/null"}`,
  ];
  if (!beforeMeta) {
    return [...header, `@@ -0,0 +1,${afterLines.length} @@`, ...afterLines.slice(0, 120).map((l) => `+${l}`), ...(afterLines.length > 120 ? [`+... (${afterLines.length - 120} more lines)`] : []), ""].join("\n");
  }
  if (!afterMeta) {
    return [...header, `@@ -1,${beforeLines.length} +0,0 @@`, ...beforeLines.slice(0, 80).map((l) => `-${l}`), ...(beforeLines.length > 80 ? [`-... (${beforeLines.length - 80} more lines)`] : []), ""].join("\n");
  }
  let prefix = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ctxStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3);
  const removedMid = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedMid = afterLines.slice(prefix, afterLines.length - suffix);
  const preCtx = beforeLines.slice(ctxStart, prefix).map((l) => ` ${l}`);
  const postCtx = beforeLines.slice(beforeLines.length - suffix, beforeEnd).map((l) => ` ${l}`);
  const body = [
    ...preCtx,
    ...removedMid.slice(0, 120).map((l) => `-${l}`),
    ...(removedMid.length > 120 ? [`-... (${removedMid.length - 120} more removed lines)`] : []),
    ...addedMid.slice(0, 120).map((l) => `+${l}`),
    ...(addedMid.length > 120 ? [`+... (${addedMid.length - 120} more added lines)`] : []),
    ...postCtx,
  ];
  return [
    ...header,
    `@@ -${ctxStart + 1},${Math.max(0, beforeEnd - ctxStart)} +${ctxStart + 1},${Math.max(0, afterEnd - ctxStart)} @@`,
    ...body,
    "",
  ].join("\n");
}

function hasChildEntry(manifest: WorkspaceManifest, dirRel: string): boolean {
  const prefix = `${dirRel}/`;
  return Object.keys(manifest).some((key) => key.startsWith(prefix));
}

export function computeStagedDiff(options: {
  sourceDir: string;
  stagedDir: string;
  baseline: WorkspaceManifest;
  filePath?: string;
  maxPreviewBytes?: number;
  extraIgnoredPaths?: readonly string[];
}): StagedWorkspaceDiffDetail {
  const staged = scanWorkspaceManifest(options.stagedDir, {
    rejectExternalSymlinks: true,
    baseline: options.baseline,
    extraIgnoredPaths: options.extraIgnoredPaths,
  });
  const currentSource = scanWorkspaceManifest(options.sourceDir, {
    baseline: options.baseline,
    statCache: options.baseline,
    extraIgnoredPaths: options.extraIgnoredPaths,
  });

  const baselineKeys = Object.keys(options.baseline);
  const baselineHasV2 = baselineKeys.length === 0 || Object.values(options.baseline).some((entry) => entry.manifestVersion === MANIFEST_VERSION);
  const allPaths = [...new Set([...baselineKeys, ...Object.keys(staged)])].sort();

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const emptyDirsAdded: string[] = [];
  const emptyDirsDeleted: string[] = [];
  const modeChanged: string[] = [];
  const conflictFiles: string[] = [];
  const sensitiveSet = new Set<string>();

  for (const rel of allPaths) {
    const base = options.baseline[rel];
    const next = staged[rel];
    const isDirEntry = base?.kind === "dir" || next?.kind === "dir";

    if (isDirEntry) {
      if (!baselineHasV2) continue;
      if (!base && next?.kind === "dir") {
        // Directory became empty because files were deleted vs brand new empty dir
        if (!hasChildEntry(options.baseline, rel)) {
          emptyDirsAdded.push(rel);
          const liveSource = currentSource[rel];
          if (liveSource && liveSource.kind !== "dir") {
            conflictFiles.push(rel);
          }
        }
      } else if (base?.kind === "dir" && !next) {
        const stillExistsInStaged = fs.existsSync(path.join(options.stagedDir, assertSafeRelativePath(rel)));
        if (!stillExistsInStaged && !hasChildEntry(staged, rel)) {
          emptyDirsDeleted.push(rel);
          const liveExists = fs.existsSync(path.join(options.sourceDir, assertSafeRelativePath(rel)));
          if (liveExists && hasChildEntry(currentSource, rel)) {
            conflictFiles.push(rel);
          }
        }
      }
      continue;
    }

    const contentChanged = Boolean(base && next && base.sha256 !== next.sha256);
    const execChanged = hasExecBitDiff(base, next);

    if (!base && next) {
      added.push(rel);
      if (process.platform !== "win32" && next.symlinkTarget === undefined && (next.mode & 0o111) !== 0) {
        sensitiveSet.add(rel);
      }
    } else if (base && !next) {
      deleted.push(rel);
      sensitiveSet.add(rel);
    } else if (contentChanged || execChanged) {
      modified.push(rel);
      if (execChanged) {
        modeChanged.push(rel);
        sensitiveSet.add(rel);
      }
    } else {
      continue;
    }

    if (base?.symlinkTarget !== undefined || next?.symlinkTarget !== undefined) {
      sensitiveSet.add(rel);
    }

    const safeRel = assertSafeRelativePath(rel);
    const beforePath = base ? path.join(options.sourceDir, safeRel) : undefined;
    const afterPath = next ? path.join(options.stagedDir, safeRel) : undefined;
    if (isAutoExecSensitivePath(rel, beforePath, afterPath)) {
      sensitiveSet.add(rel);
    }

    const liveSource = currentSource[rel];
    const sourceContentChanged =
      (!base && Boolean(liveSource)) ||
      (Boolean(base) && !liveSource) ||
      (Boolean(base) && Boolean(liveSource) && (base!.sha256 !== liveSource!.sha256 || hasExecBitDiff(base, liveSource)));
    if (sourceContentChanged) {
      const sameAsStaged =
        (!next && !liveSource) ||
        (Boolean(next) && Boolean(liveSource) && next!.sha256 === liveSource!.sha256 && !hasExecBitDiff(next, liveSource));
      if (!sameAsStaged) conflictFiles.push(rel);
    }
  }

  const conflictSet = new Set(conflictFiles);
  const modeChangedSet = new Set(modeChanged);
  const changedPaths = [...added, ...modified, ...deleted, ...emptyDirsAdded, ...emptyDirsDeleted].sort();
  const requestedFilter = options.filePath?.trim() ? toPosixRelative(options.filePath.trim()).replace(/^\/+/, "") : undefined;
  const targetPaths = requestedFilter
    ? changedPaths.filter((p) => p === requestedFilter || p.startsWith(`${requestedFilter}/`))
    : changedPaths;
  const limit = options.maxPreviewBytes ?? 24 * 1024;
  let diffText = "";
  let truncated = false;

  for (const rel of targetPaths) {
    const safeRel = assertSafeRelativePath(rel);
    const isConflict = conflictSet.has(rel);
    const beforeMeta = isConflict ? currentSource[rel] : options.baseline[rel];
    const beforePath = beforeMeta ? path.join(options.sourceDir, safeRel) : undefined;
    const afterMeta = staged[rel];
    const afterPath = afterMeta ? path.join(options.stagedDir, safeRel) : undefined;

    const chunk = renderUnifiedFileDiff(rel, beforePath, afterPath, beforeMeta, afterMeta, {
      isConflict,
      modeChanged: modeChangedSet.has(rel),
    });
    const usedBytes = Buffer.byteLength(diffText, "utf8");
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (usedBytes + chunkBytes > limit) {
      const remaining = Math.max(0, limit - usedBytes);
      if (remaining > 64) diffText += truncateUtf8(chunk, remaining);
      truncated = true;
      break;
    }
    diffText += chunk;
  }

  const sensitivePaths = [...sensitiveSet].sort();
  const summary: StagedWorkspaceDiffSummary = {
    hasChanges: changedPaths.length > 0,
    added,
    modified,
    deleted,
    ...(emptyDirsAdded.length > 0 ? { emptyDirsAdded } : {}),
    ...(emptyDirsDeleted.length > 0 ? { emptyDirsDeleted } : {}),
    ...(modeChanged.length > 0 ? { modeChanged } : {}),
    ...(sensitivePaths.length > 0 ? { sensitivePaths } : {}),
    conflictFiles,
    unifiedPreview: truncateUtf8(diffText, 24 * 1024),
    truncated,
  };
  return {
    ...summary,
    diff: diffText,
    ...(requestedFilter ? { filteredPath: requestedFilter } : {}),
  };
}

export function applyStagedChanges(options: {
  sourceDir: string;
  stagedDir: string;
  baseline: WorkspaceManifest;
  paths?: string[];
  allowConflicts?: boolean;
}): StagedWorkspaceApplyResult {
  const detail = computeStagedDiff({
    sourceDir: options.sourceDir,
    stagedDir: options.stagedDir,
    baseline: options.baseline,
    maxPreviewBytes: 4096,
  });
  const filterSet = options.paths?.length
    ? new Set(
        options.paths.map((p) => {
          const clean = toPosixRelative(p.trim()).replace(/^\/+/, "");
          assertSafeRelativePath(clean);
          return clean;
        }),
      )
    : undefined;
  const selectedConflicts = detail.conflictFiles.filter((file) => !filterSet || filterSet.has(file));
  if (selectedConflicts.length > 0 && !options.allowConflicts) {
    throw new StagedWorkspaceConflictError(selectedConflicts);
  }

  const toAdd = detail.added.filter((file) => !filterSet || filterSet.has(file));
  const toModify = detail.modified.filter((file) => !filterSet || filterSet.has(file));
  const toDelete = detail.deleted.filter((file) => !filterSet || filterSet.has(file));
  const toAddDirs = (detail.emptyDirsAdded ?? []).filter((dir) => !filterSet || filterSet.has(dir));
  const toDeleteDirs = (detail.emptyDirsDeleted ?? []).filter((dir) => !filterSet || filterSet.has(dir));
  const canonicalSourceRoot = fs.realpathSync(options.sourceDir);

  // Hard reject any attempt to target .git/**
  for (const rel of [...toAdd, ...toModify, ...toDelete, ...toAddDirs, ...toDeleteDirs]) {
    if (rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/")) {
      throw new Error(`Refusing to apply staged change inside .git metadata: ${rel}`);
    }
  }

  for (const rel of [...toAdd, ...toModify]) {
    const safeRel = assertSafeRelativePath(rel);
    const srcFile = path.join(options.stagedDir, safeRel);
    const stat = fs.lstatSync(srcFile, { bigint: true });
    if (stat.isSymbolicLink()) {
      const rawLink = fs.readlinkSync(srcFile);
      const destFile = assertNoSymlinkEscape(options.sourceDir, rel, { allowTargetSymlink: options.baseline[rel]?.symlinkTarget !== undefined });
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      const parentReal = fs.realpathSync(path.dirname(destFile));
      if (!isWithinRoot(canonicalSourceRoot, path.resolve(parentReal, rawLink))) {
        throw new Error(`Refusing symbolic link escaping project workspace: ${rel}`);
      }
      const tempLink = path.join(path.dirname(destFile), `.kulo-apply-${randomUUID()}.tmp`);
      try {
        fs.symlinkSync(rawLink, tempLink);
        fs.renameSync(tempLink, destFile);
        options.baseline[rel] = inspectSymlink(rawLink);
      } finally {
        if (fs.existsSync(tempLink) || (() => { try { return fs.lstatSync(tempLink).isSymbolicLink(); } catch { return false; } })()) {
          fs.rmSync(tempLink, { force: true });
        }
      }
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to apply non-regular staged file: ${rel}`);
    }
    const destFile = assertNoSymlinkEscape(options.sourceDir, rel);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const tempFile = path.join(path.dirname(destFile), `.kulo-apply-${randomUUID()}.tmp`);
    try {
      fs.copyFileSync(srcFile, tempFile);
      if (process.platform !== "win32") {
        fs.chmodSync(tempFile, Number(stat.mode) & 0o777);
      }
      fs.renameSync(tempFile, destFile);
      options.baseline[rel] = inspectFile(destFile, fs.lstatSync(destFile, { bigint: true }));
    } finally {
      if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true });
    }
  }

  for (const rel of toAddDirs) {
    assertSafeRelativePath(rel);
    const destDir = assertNoSymlinkEscape(options.sourceDir, rel);
    fs.mkdirSync(destDir, { recursive: true });
    const dirStat = fs.lstatSync(destDir, { bigint: true });
    options.baseline[rel] = inspectEmptyDir(Number(dirStat.mode));
  }

  for (const rel of toDelete) {
    assertSafeRelativePath(rel);
    const destFile = assertNoSymlinkEscape(options.sourceDir, rel, { allowTargetSymlink: options.baseline[rel]?.symlinkTarget !== undefined });
    if (fs.existsSync(destFile) || (() => { try { return fs.lstatSync(destFile).isSymbolicLink(); } catch { return false; } })()) {
      fs.rmSync(destFile, { force: true });
    }
    delete options.baseline[rel];
  }

  // Delete empty directories deepest-first
  for (const rel of [...toDeleteDirs].sort((a, b) => b.length - a.length)) {
    assertSafeRelativePath(rel);
    const destDir = assertNoSymlinkEscape(options.sourceDir, rel);
    if (fs.existsSync(destDir)) {
      const stat = fs.lstatSync(destDir);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        try {
          fs.rmdirSync(destDir);
        } catch {
          // Directory no longer empty; preserve live contents safely
        }
      }
    }
    delete options.baseline[rel];
  }

  const totalPending =
    detail.added.length +
    detail.modified.length +
    detail.deleted.length +
    (detail.emptyDirsAdded?.length ?? 0) +
    (detail.emptyDirsDeleted?.length ?? 0);
  const totalApplied = toAdd.length + toModify.length + toDelete.length + toAddDirs.length + toDeleteDirs.length;
  const appliedAll = !filterSet || totalApplied === totalPending;
  if (appliedAll) {
    fs.rmSync(options.stagedDir, { recursive: true, force: true });
  }

  return {
    appliedAdded: toAdd,
    appliedModified: toModify,
    appliedDeleted: toDelete,
    cleanedUp: appliedAll,
  };
}
