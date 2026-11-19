import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildWorkerSandboxProfile, createMacSandboxCleanupCommand, defaultProtectedPaths } from "@kulo/env";
import { redactSecrets } from "@kulo/protocol";
import { recoverCustomizationExecutions } from "@kulo/recovery";

export class CustomizationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "CustomizationError";
  }
}

export interface CustomizationSource {
  directory?: string;
  repositoryUrl?: string;
  commit?: string;
  version: string;
  treeHash?: string;
  archivePath?: string;
  archiveHash?: string;
}
export interface CustomizationFileChange { path: string; before: string | null; after: string | null }
export interface CustomizationSourceSnapshot {
  sourceCommit?: string;
  sourceTreeHash: string;
  files: Record<string, string>;
  scripts: Record<string, unknown>;
}
export interface CustomizationBuildRequest {
  workRoot: string;
  sourceRoot: string;
  outputRoot: string;
  basePayloadRoot?: string;
  baseReleaseId?: string;
  signal?: AbortSignal;
}
export interface CustomizationProbeRequest {
  workRoot: string;
  payloadRoot: string;
  runtimeEntry: string;
  webDir: string;
  signal?: AbortSignal;
}
export interface CustomizationRunner {
  build(request: CustomizationBuildRequest): Promise<{ checks: string[] }>;
  probe(request: CustomizationProbeRequest): Promise<{ checks: string[] }>;
}

const WEB_TEST_FILES = [
  "packages/web",
  "tests/kulo-heroui-guard.test.ts",
  "tests/kulo-typography.test.ts",
  "tests/kulo-form-layout.test.ts",
  "tests/kulo-input-appearance.test.ts",
  "tests/kulo-tab-layout.test.ts",
  "tests/kulo-control-appearance.test.ts",
  "tests/kulo-popover-layout.test.ts",
  "tests/kulo-focus-appearance.test.ts",
  "tests/kulo-navigation-motion.test.ts",
] as const;

const EXCLUDED = new Set([".git", ".agents", "node_modules", "dist", "output", ".kulo-state", ".kulo", ".pnpm-store", ".playwright-cli", ".playwright-mcp", ".codex", ".claude", ".gemini",
  ".venv", "venv", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", "coverage", ".next", ".turbo"]);
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const generatedNativePath = (relative: string) => /^packages\/hub\/native\/kulo-connector-[^/]+(?:\/|$)/.test(relative);

export function customizationIdentifier(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value)) {
    throw new CustomizationError("invalid_customization_id", "定制操作标识无效。", 400);
  }
  return value;
}
export function customizationRelativePath(value: string): string {
  if (typeof value !== "string" || value.length > 500 || !value || value.includes("\\") ||
      path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
      /[\x00-\x1f\x7f]/.test(value)) throw new CustomizationError("invalid_customization_path", "只能修改候选项目中的相对源码路径。", 400);
  return value;
}
export function customizationEditablePath(value: string): string {
  const relative = customizationRelativePath(value);
  if (!/^packages\/web\/(?:src|public|test)\//.test(relative) ||
      /(?:^|\/)(?:credentials?|secrets?|runtime-token|connection)\.(?:json|ya?ml|env|pem|key)$/i.test(relative) ||
      /(?:^|\/)(?:node_modules|native|recovery|dist|output|coverage)(?:\/|$)/.test(relative)) {
    throw new CustomizationError("customization_path_protected", "当前定制仅支持 Web 界面；后端和执行控制层需在后续阶段或独立源码分支修改。", 403);
  }
  return relative;
}
export function customizationContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
export async function customizationPrivateDirectory(directory: string): Promise<string> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CustomizationError("customization_directory_invalid", "定制目录不可用。");
  }
  return fsp.realpath(directory);
}
function controlDirectory(workRoot: string, name: string): string {
  const rootStat = fs.lstatSync(workRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || typeof process.getuid === "function" && rootStat.uid !== process.getuid()) {
    throw new CustomizationError("customization_directory_invalid", "定制控制目录不可用。");
  }
  const root = fs.realpathSync(workRoot), directory = path.join(root, name);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory), canonical = fs.realpathSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
      canonical === root || !customizationContained(root, canonical)) {
    throw new CustomizationError("customization_directory_invalid", "定制控制目录包含不支持的链接或文件。");
  }
  fs.chmodSync(canonical, 0o700);
  return canonical;
}
function writeControlFile(filename: string, content: string, mode: number): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_CREAT, mode);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new CustomizationError("customization_control_invalid", "定制控制文件身份无效，已停止写入。");
    }
    fs.ftruncateSync(descriptor, 0); fs.writeFileSync(descriptor, content); fs.fchmodSync(descriptor, mode);
  } catch (error) {
    if (["ELOOP", "EMLINK", "EISDIR", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new CustomizationError("customization_control_invalid", "定制控制文件包含不支持的链接或文件。");
    }
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
export async function customizationSourceFile(root: string, relative: string, create = false): Promise<string> {
  const file = path.join(root, customizationRelativePath(relative));
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new CustomizationError("customization_file_missing", "候选文件不存在。", 404);
      if (index !== parts.length - 1) await fsp.mkdir(current, { mode: 0o700 });
      continue;
    }
    if (stat.isSymbolicLink() || index !== parts.length - 1 && !stat.isDirectory() ||
        index === parts.length - 1 && !stat.isFile()) {
      throw new CustomizationError("customization_path_protected", "候选路径包含不支持的文件或链接。", 403);
    }
  }
  return file;
}

export function customizationEnvironment(workRoot: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = controlDirectory(workRoot, ".home"), temporary = controlDirectory(workRoot, ".tmp");
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: temporary,
    LANG: "en_US.UTF-8", CI: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_SYSTEM: path.join(home, "gitconfig"),
    GIT_ATTR_NOSYSTEM: "1", npm_config_userconfig: path.join(home, "npmrc"), npm_config_ignore_scripts: "true",
  };
  writeControlFile(env.GIT_CONFIG_GLOBAL!, "", 0o600);
  writeControlFile(env.npm_config_userconfig!, "", 0o600);
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (parent[name]) env[name] = parent[name];
  }
  return env;
}

function outputExcerpt(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  const marker = "\n...[truncated]...\n", markerBytes = Buffer.byteLength(marker);
  const prefix = (limit: number) => { let end = limit; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; return bytes.subarray(0, end).toString("utf8"); };
  if (maxBytes <= markerBytes) return prefix(Math.max(0, maxBytes));
  const headBytes = Math.floor((maxBytes - markerBytes) / 2), tailBytes = maxBytes - markerBytes - headBytes;
  let start = bytes.length - tailBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return prefix(headBytes) + marker + bytes.subarray(start).toString("utf8");
}

export async function customizationCommand(command: string, args: readonly string[], options: {
  cwd: string; workRoot: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; allowedExitCodes?: number[];
  captureLimitBytes?: number; failOnOutputLimit?: boolean;
  cleanup?: () => Promise<void>;
}): Promise<{ code: number; output: string }> {
  if (options.signal?.aborted) throw new DOMException("定制操作已取消。", "AbortError");
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? customizationEnvironment(options.workRoot),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let output = "", aborted = false, timedOut = false, settled = false, overflow = false;
    let cleanupPromise: Promise<void> | undefined;
    const append = (chunk: Buffer) => {
      const limit = options.captureLimitBytes ?? 64 * 1024;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > limit) { overflow = true; output = outputExcerpt(output, limit); }
    };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const cleanup = () => cleanupPromise ??= Promise.resolve().then(async () => {
      if (options.cleanup) { await options.cleanup(); return; }
      if (!child.pid) return;
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } else {
        // The group can outlive its direct parent and keep inherited output pipes open.
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    });
    const fail = (error: unknown) => {
      if (settled) return; finish();
      child.stdout.destroy(); child.stderr.destroy();
      reject(error);
    };
    const stop = () => { void cleanup().catch(fail); };
    const abort = () => { aborted = true; stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 15 * 60_000);
    const finish = () => { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.once("error", (error) => {
      if (settled) return;
      void cleanup().then(() => fail(new CustomizationError("customization_command_unavailable", "定制所需工具无法启动：" + redactSecrets(error.message))), fail);
    });
    child.once("exit", stop);
    child.once("close", (code) => { void cleanup().then(() => {
      if (settled) return; finish();
      if (aborted) { reject(new DOMException("定制操作已取消。", "AbortError")); return; }
      if (timedOut) { reject(new CustomizationError("customization_timeout", "定制验证超时，当前版本仍可继续使用。")); return; }
      if (overflow && options.failOnOutputLimit) { reject(new CustomizationError("customization_output_limit", "定制合并结果超过大小限制。")); return; }
      if (code === null || ![0, ...(options.allowedExitCodes ?? [])].includes(code)) {
        const prefix = "定制验证未通过：";
        reject(new CustomizationError("customization_command_failed", prefix + outputExcerpt(redactSecrets(output), 6000 - Buffer.byteLength(prefix)))); return;
      }
      resolve({ code, output });
    }, fail); });
  });
}

export async function cleanupLocalCustomizationExecutions(dataDir: string, operationLockHeld = false) {
  return recoverCustomizationExecutions({ dataDir, operationLockHeld, cleanup: async ({ marker, negative }) => {
    if (process.platform !== "darwin") throw new CustomizationError("customization_isolation_unavailable", "当前设备尚未提供定制进程恢复能力。");
    const root = await customizationPrivateDirectory(path.join(dataDir, "customizations", "rescue"));
    const helper = await fsp.mkdtemp(path.join(root, "cleanup-"));
    try {
      const command = createMacSandboxCleanupCommand(helper, marker, negative);
      await customizationCommand(command[0]!, command.slice(1), { cwd: helper, workRoot: helper, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
    } finally { await fsp.rm(helper, { recursive: true, force: true }); }
  } });
}

async function collectSource(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0, count = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (EXCLUDED.has(entry.name) || entry.name.startsWith(".") && entry.name !== ".gitignore" ||
          /\.(?:pem|key|p12|pfx|log|dmg|tsbuildinfo|sqlite(?:-shm|-wal)?)$/i.test(entry.name) ||
          /^(?:credentials?|auth|connection)\.json$/i.test(entry.name) ||
          entry.name === ".DS_Store" || prefix === "docs" && entry.name === "assets" || generatedNativePath(relative)) continue;
      if (!prefix && entry.isDirectory() && !["packages", "tests", "integrations", "docs", "scripts"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new CustomizationError("source_link_unsupported", "源码包含不受支持的链接或文件。");
      if (entry.isDirectory()) { await walk(file, relative); continue; }
      const stat = await fsp.stat(file);
      bytes += stat.size; count++;
      if (bytes > MAX_SOURCE_BYTES || count > 20_000 || stat.size > 16 * 1024 * 1024) throw new CustomizationError("customization_source_limit", "源码超出本地定制大小限制。");
      files[relative] = createHash("sha256").update(await fsp.readFile(file)).digest("hex");
    }
  };
  await walk(root, "");
  return files;
}
export function customizationTreeHash(files: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
export async function customizationSourceIdentity(directory: string): Promise<{ commit?: string; treeHash: string }> {
  const root = await fsp.realpath(directory), files = await collectSource(root);
  let commit: string | undefined;
  if (fs.existsSync(path.join(root, ".git"))) {
    const result = await customizationCommand("git", ["-C", root, "rev-parse", "HEAD"], {
      cwd: root, workRoot: root, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 10_000,
    });
    if (/^[a-f0-9]{40,64}$/.test(result.output.trim())) commit = result.output.trim();
    else throw new CustomizationError("invalid_source_commit", "源码版本标识无效。");
  }
  return { ...(commit ? { commit } : {}), treeHash: customizationTreeHash(files) };
}
export async function createCustomizationSourceArchive(sourceRoot: string, destination: string, options: { version: string }) {
  const root = await fsp.realpath(sourceRoot), identity = await customizationSourceIdentity(root), inventory = await collectSource(root);
  const files: { path: string; sha256: string; content: string; executable: boolean }[] = [];
  let sourceBytes = 0;
  for (const relative of Object.keys(inventory).sort()) {
    const file = path.join(root, relative), bytes = await fsp.readFile(file), stat = await fsp.stat(file);
    if (createHash("sha256").update(bytes).digest("hex") !== inventory[relative]) throw new CustomizationError("source_version_changed", "生成归档期间源码发生变化。");
    sourceBytes += bytes.length;
    files.push({ path: relative, sha256: inventory[relative]!, content: bytes.toString("base64"), executable: Boolean(stat.mode & 0o111) });
  }
  if (customizationTreeHash(inventory) !== identity.treeHash) throw new CustomizationError("source_version_changed", "生成归档期间源码发生变化。");
  const body = Buffer.from(JSON.stringify({ formatVersion: 1, ...identity, files }));
  if (body.length > 256 * 1024 * 1024) throw new CustomizationError("customization_source_limit", "源码归档超过解压大小限制。");
  const compressed = gzipSync(body, { level: 6 });
  if (compressed.length > 16 * 1024 * 1024) throw new CustomizationError("customization_source_limit", "源码归档超过压缩大小限制。");
  const metadata = { formatVersion: 1 as const, archiveFile: path.basename(destination),
    archiveHash: createHash("sha256").update(compressed).digest("hex"), version: options.version, ...identity,
    compressedBytes: compressed.length, sourceBytes, fileCount: files.length };
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.writeFile(destination, compressed, { mode: 0o600, flag: "wx" });
  return metadata;
}
export function assertCustomizationDataCompatibility(relative: string, before: string | null, after: string | null): void {
  if (!before) return;
  const versions = (text: string): Map<string, number> => {
    const result = new Map<string, number>();
    for (const match of text.matchAll(/\bdefineDoc(?:<[\s\S]*?>)?\s*\(\s*\{([\s\S]*?)(?=\binitial\s*:)/g)) {
      const kind = /\bkind\s*:\s*["']([^"']+)["']/.exec(match[1]!);
      const version = /\bversion\s*:\s*(\d+)/.exec(match[1]!);
      if (kind && version) result.set(kind[1]!, Number(version[1]));
    }
    return result;
  };
  const old = versions(before), next = versions(after ?? "");
  for (const [kind, version] of old) {
    if (next.get(kind) !== version) throw new CustomizationError("customization_data_migration_unsupported",
      "此修改涉及现有数据格式迁移，当前定制流程尚不支持安全应用：" + relative);
  }
  if (/\bKULO_STATE_VERSION\b/.test(before) && /\bKULO_STATE_VERSION\b/.test(after ?? "") &&
      [...before.matchAll(/\bKULO_STATE_VERSION\s*=\s*\d+/g)].map((m) => m[0]).join() !==
      [...(after ?? "").matchAll(/\bKULO_STATE_VERSION\s*=\s*\d+/g)].map((m) => m[0]).join()) {
    throw new CustomizationError("customization_data_migration_unsupported", "当前定制流程不支持修改状态存储格式。");
  }
}

export async function prepareCustomizationSource(source: CustomizationSource, destination: string, workRoot: string,
  signal?: AbortSignal, commitOverride?: string): Promise<CustomizationSourceSnapshot> {
  await customizationPrivateDirectory(destination);
  let sourceCommit = commitOverride ?? source.commit ?? "";
  if (sourceCommit && !/^[a-f0-9]{40,64}$/i.test(sourceCommit)) throw new CustomizationError("invalid_source_commit", "源码版本标识无效。", 400);
  if (source.archivePath && !commitOverride) {
    const archiveStat = await fsp.lstat(source.archivePath);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > 16 * 1024 * 1024 || !source.archiveHash || !/^[a-f0-9]{64}$/.test(source.archiveHash)) {
      throw new CustomizationError("customization_source_invalid", "源码归档无效。");
    }
    const archive = await fsp.readFile(source.archivePath);
    if (createHash("sha256").update(archive).digest("hex") !== source.archiveHash) throw new CustomizationError("source_version_changed", "源码归档摘要不一致。");
    let raw: unknown;
    try { raw = JSON.parse(gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 }).toString("utf8")); }
    catch { throw new CustomizationError("customization_source_invalid", "源码归档无法安全解开。"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CustomizationError("customization_source_invalid", "源码归档格式无效。");
    const value = raw as { formatVersion?: unknown; commit?: unknown; treeHash?: unknown; files?: unknown };
    if (value.formatVersion !== 1 || !Array.isArray(value.files) || value.files.length > 20_000 || typeof value.treeHash !== "string" ||
        source.treeHash && source.treeHash !== value.treeHash || value.commit !== undefined && (typeof value.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(value.commit)) ||
        sourceCommit && value.commit !== sourceCommit) throw new CustomizationError("customization_source_invalid", "源码归档身份无效。");
    sourceCommit = typeof value.commit === "string" ? value.commit : sourceCommit;
    let total = 0; const inventory: Record<string, string> = {};
    for (const rawFile of value.files) {
      if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new CustomizationError("customization_source_invalid", "源码归档条目无效。");
      const file = rawFile as { path?: unknown; sha256?: unknown; content?: unknown; executable?: unknown };
      if (typeof file.path !== "string" || !file.path || file.path.length > 1024 || path.posix.isAbsolute(file.path) ||
          /[\\\x00-\x1f\x7f:]/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === ".." || EXCLUDED.has(part) || part.startsWith(".") && part !== ".gitignore") ||
          generatedNativePath(file.path) ||
          Object.hasOwn(inventory, file.path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
          typeof file.content !== "string" || file.content.length > 23 * 1024 * 1024 ||
          typeof file.executable !== "boolean") throw new CustomizationError("customization_source_invalid", "源码归档包含无效路径或内容。");
      const bytes = Buffer.from(file.content, "base64"); total += bytes.length;
      if (total > MAX_SOURCE_BYTES || bytes.length > 16 * 1024 * 1024 || bytes.toString("base64") !== file.content || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new CustomizationError("customization_source_limit", "源码归档内容超限或摘要不一致。");
      }
      const target = path.join(destination, file.path); await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.writeFile(target, bytes, { mode: file.executable ? 0o700 : 0o600, flag: "wx" }); inventory[file.path] = file.sha256;
    }
    if (customizationTreeHash(inventory) !== value.treeHash) throw new CustomizationError("source_version_changed", "源码归档文件清单不一致。");
  } else if (source.directory && !commitOverride) {
    const original = await fsp.realpath(source.directory);
    if (customizationContained(original, destination)) throw new CustomizationError("source_workspace_overlap", "候选目录不能位于源码项目内部。");
    if (fs.existsSync(path.join(original, ".git"))) {
      const head = await customizationCommand("git", ["-C", original, "rev-parse", "HEAD"], { cwd: workRoot, workRoot, signal, timeoutMs: 10_000 });
      const actualHead = head.output.trim();
      if (sourceCommit && sourceCommit !== actualHead) throw new CustomizationError("source_version_changed", "本机源码基线已变化，请重新准备。");
      sourceCommit = actualHead;
    }
    const files = await collectSource(original);
    if (source.treeHash && source.treeHash !== customizationTreeHash(files)) throw new CustomizationError("source_version_changed", "本机源码与运行版本的源码摘要不一致。");
    for (const relative of Object.keys(files)) {
      const target = path.join(destination, relative); await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.copyFile(path.join(original, relative), target, fs.constants.COPYFILE_FICLONE);
    }
  } else {
    if (!sourceCommit) throw new CustomizationError("customization_source_unavailable", "尚未配置匹配的源码版本。");
    let repository = source.directory;
    if (!repository && source.repositoryUrl) {
      const url = new URL(source.repositoryUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) throw new CustomizationError("invalid_source_repository", "源码仓库必须使用已配置的不含凭据的 HTTPS 地址。");
      repository = url.href;
    }
    if (!repository) throw new CustomizationError("customization_source_unavailable", "尚未配置匹配的源码来源。");
    const empty = controlDirectory(controlDirectory(workRoot, ".home"), "empty-hooks");
    const config = ["-c", "core.hooksPath=" + empty, "-c", "init.templateDir=" + empty, "-c", "protocol.file.allow=" + (source.directory ? "always" : "never")];
    await customizationCommand("git", [...config, "clone", "--no-checkout", "--no-hardlinks", "--no-recurse-submodules", "--", repository, destination], { cwd: workRoot, workRoot, signal });
    await customizationCommand("git", [...config, "-C", destination, "checkout", "--detach", sourceCommit, "--"], { cwd: workRoot, workRoot, signal });
    await fsp.rm(path.join(destination, ".git"), { recursive: true });
    const sanitize = async (folder: string, prefix = ""): Promise<void> => {
      for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name), relative = prefix ? prefix + "/" + entry.name : entry.name;
        if (EXCLUDED.has(entry.name) || entry.name.startsWith(".") && entry.name !== ".gitignore" ||
            /\.(?:pem|key|p12|pfx)$/i.test(entry.name) || /^(?:credentials?|auth|connection)\.json$/i.test(entry.name) ||
            prefix === "docs" && entry.name === "assets" || generatedNativePath(relative)) { await fsp.rm(file, { recursive: true, force: true }); continue; }
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new CustomizationError("source_link_unsupported", "源码包含不受支持的链接或文件。");
        if (entry.isDirectory()) await sanitize(file, relative);
      }
    };
    await sanitize(destination);
    const checked = await collectSource(destination);
    if (!Object.keys(checked).length) throw new CustomizationError("customization_source_empty", "源码为空。");
  }
  const files = await collectSource(destination), scripts: Record<string, unknown> = {};
  for (const relative of Object.keys(files).filter((file) => /(?:^|\/)package\.json$/.test(file))) {
    const manifest: unknown = JSON.parse(await fsp.readFile(path.join(destination, relative), "utf8"));
    if (manifest && typeof manifest === "object") scripts[relative] = (manifest as { scripts?: unknown }).scripts ?? null;
  }
  const sourceTreeHash = customizationTreeHash(files);
  if (!commitOverride && source.treeHash && source.treeHash !== sourceTreeHash) throw new CustomizationError("source_version_changed", "源码副本与受信基线摘要不一致。");
  return { ...(sourceCommit ? { sourceCommit } : {}), sourceTreeHash, files, scripts };
}

export async function customizationChanges(sourceRoot: string, originalRoot: string, snapshot: CustomizationSourceSnapshot): Promise<CustomizationFileChange[]> {
  const current = await collectSource(sourceRoot), changes: CustomizationFileChange[] = [];
  for (const relative of [...new Set([...Object.keys(snapshot.files), ...Object.keys(current)])].sort()) {
    if (snapshot.files[relative] === current[relative]) continue;
    customizationEditablePath(relative);
    const before = snapshot.files[relative] ? await fsp.readFile(path.join(originalRoot, relative), "utf8") : null;
    const after = current[relative] ? await fsp.readFile(path.join(sourceRoot, relative), "utf8") : null;
    if ((before?.length ?? 0) > MAX_FILE_BYTES || (after?.length ?? 0) > MAX_FILE_BYTES ||
        before?.includes("\0") || after?.includes("\0")) throw new CustomizationError("customization_binary_change", "此入口只接受受限大小的文本源码变更。");
    assertCustomizationDataCompatibility(relative, before, after);
    changes.push({ path: relative, before, after });
  }
  return changes;
}

function findExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(directory, process.platform === "win32" ? name + ".cmd" : name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new CustomizationError("customization_toolchain_unavailable", "当前尚未准备源码构建工具，已保留修改，原版本可继续使用。");
}

function packagedPnpmEntry(trustedRoot: string): string | undefined {
  const root = fs.realpathSync(trustedRoot);
  const hubEntry = fs.realpathSync(createRequire(path.join(root, "package.json")).resolve("@kulo/hub"));
  if (!customizationContained(root, hubEntry)) throw new CustomizationError("customization_toolchain_unavailable", "安装包内的构建工具依赖不完整。");
  const require = createRequire(hubEntry);
  let metadata: string;
  try {
    try { metadata = require.resolve("pnpm/package.json"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      metadata = require.resolve("pnpm");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined; throw error; }
  metadata = fs.realpathSync(metadata);
  const stat = fs.lstatSync(metadata), packageRoot = path.dirname(metadata);
  if (path.basename(metadata) !== "package.json" || !customizationContained(root, packageRoot) || !stat.isFile() || stat.size > 64 * 1024) {
    throw new CustomizationError("customization_toolchain_unavailable", "安装包内的 pnpm 元信息无效。");
  }
  const value = JSON.parse(fs.readFileSync(metadata, "utf8")) as { name?: unknown; bin?: unknown };
  const bin = typeof value.bin === "string" ? value.bin : value.bin && typeof value.bin === "object" ? (value.bin as Record<string, unknown>).pnpm : undefined;
  if (value.name !== "pnpm" || typeof bin !== "string" || !bin || path.isAbsolute(bin) || bin.includes("\\") || bin.split("/").includes("..")) {
    throw new CustomizationError("customization_toolchain_unavailable", "安装包内的 pnpm 入口无效。");
  }
  const entry = fs.realpathSync(path.join(packageRoot, bin));
  if (!customizationContained(root, entry) || !customizationContained(packageRoot, entry) || !fs.lstatSync(entry).isFile() || !/\.(?:mjs|cjs|js)$/.test(entry)) {
    throw new CustomizationError("customization_toolchain_unavailable", "安装包内的 pnpm 入口超出受信工具链。");
  }
  return entry;
}

function pnpmToolchain(executable: string): { entry: string; readOnlyPaths: string[] } {
  const script = fs.readFileSync(executable, "utf8");
  let entry = executable;
  if (!/\.(?:cjs|mjs|js)$/.test(entry) && !/^#![^\n]*\bnode\b/.test(script)) {
    const match = /(?:\$\{SCRIPT_DIR\}|\$\{?basedir\}?)\/([^"'\r\n]+\/pnpm\.(?:mjs|cjs|js))/.exec(script);
    if (!match) throw new CustomizationError("customization_toolchain_unavailable", "当前 pnpm 启动器未提供可隔离的工具链入口。");
    entry = fs.realpathSync(path.resolve(path.dirname(executable), match[1]!));
  }
  let directory = path.dirname(entry), packageRoot: string | undefined;
  for (let depth = 0; depth < 5; depth++) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const raw = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
      if (raw.name === "pnpm") { packageRoot = directory; break; }
      if (raw.name === "corepack") throw new CustomizationError("customization_toolchain_unavailable", "请先安装可用的 pnpm 工具链，当前 Corepack 入口尚未解析为固定版本。");
    }
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  return { entry, readOnlyPaths: [...new Set([path.dirname(executable), packageRoot ?? path.dirname(entry)])] };
}

export function createLocalCustomizationRunner(options: {
  nodePath: string; dataDir: string; trustedRoot?: string; pnpmPath?: string; timeoutMs?: number; probePath?: string;
}): CustomizationRunner {
  const node = fs.realpathSync(options.nodePath);
  const run = async (
    request: { workRoot: string; signal?: AbortSignal },
    cwd: string,
    executable: string,
    args: string[],
    networkMode: "offline" | "localhost" | "install" = "offline",
    payloadRoot?: string,
    toolchainPaths: string[] = [],
  ) => {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
      throw new CustomizationError("customization_isolation_unavailable", "当前设备尚未提供源码定制验证所需的系统隔离。");
    }
    const root = await customizationPrivateDirectory(request.workRoot);
    const env = customizationEnvironment(root);
    env.npm_config_workspace_concurrency = "2";
    env.PATH = path.join(root, ".toolchain") + path.delimiter + path.dirname(node) + path.delimiter + path.dirname(executable) + path.delimiter + (env.PATH ?? "");
    const controlsRoot = await customizationPrivateDirectory(path.join(options.dataDir, "customizations", "executions"));
    const control = await customizationPrivateDirectory(path.join(controlsRoot, randomUUID()));
    const identity = { marker: "kulo.customization." + randomBytes(24).toString("hex"), negative: "kulo.unowned." + randomBytes(24).toString("hex") };
    const cleanupCommand = createMacSandboxCleanupCommand(control, identity.marker, identity.negative);
    await fsp.writeFile(path.join(control, "owner.json"), JSON.stringify({ ownerPid: process.pid, workRoot: root, cleanupCommand, state: "running" }), { mode: 0o600 });
    const runtimePaths = [...new Set([path.dirname(node), path.dirname(executable), options.trustedRoot, payloadRoot, ...toolchainPaths,
      fs.existsSync("/Library/Developer/CommandLineTools") ? "/Library/Developer/CommandLineTools" : undefined,
    ].filter((value): value is string => Boolean(value)))];
    let profile = buildWorkerSandboxProfile({ writablePaths: [root], readOnlyPaths: runtimePaths, executable: node,
      protectedPaths: [...defaultProtectedPaths(), options.dataDir], workspaceRoot: root,
      sandboxIdentity: identity, ...(payloadRoot ? { managedScratchRoot: payloadRoot } : {}),
      ...(networkMode !== "install" ? { network: { offline: true } } : {}) });
    // Node's uname initialization reads this exact sysctl in addition to the shared OS metadata list.
    profile += '\n(allow sysctl-read (sysctl-name "kern.hostname"))';
    if (networkMode === "offline") {
      profile += '\n(deny network-bind (local ip))\n(deny network-inbound (local ip))\n(deny network-outbound (remote ip))';
    } else if (networkMode === "localhost") {
      profile += '\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))';
    }
    if (payloadRoot) profile += "\n(deny file-write* (subpath " + JSON.stringify(await fsp.realpath(payloadRoot)) + "))";
    let cleaned = false;
    const cleanup = async () => {
      try {
        await customizationCommand(cleanupCommand[0]!, cleanupCommand.slice(1), { cwd: root, workRoot: root,
          env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
        cleaned = true;
      } catch {
        await fsp.writeFile(path.join(control, "cleanup-pending.json"), JSON.stringify({ ownerPid: process.pid, workRoot: root, state: "cleanup_pending" }), { mode: 0o600 });
        throw new CustomizationError("customization_cleanup_pending", "定制进程清理尚未完成，已保留现场，请稍后修复。");
      }
    };
    try {
      return await customizationCommand("/usr/bin/sandbox-exec", ["-p", profile, executable, ...args], {
        cwd, workRoot: root, env, signal: request.signal, timeoutMs: options.timeoutMs, cleanup,
      });
    } finally { if (cleaned) await fsp.rm(control, { recursive: true, force: true }); }
  };
  return {
    build: async (request) => {
      const workRoot = await customizationPrivateDirectory(request.workRoot);
      if (!request.basePayloadRoot || !request.baseReleaseId || !options.trustedRoot) throw new CustomizationError("customization_base_missing", "界面定制需要匹配的已安装基线制品和受信打包程序。");
      const basePayloadRoot = request.basePayloadRoot ? await fsp.realpath(request.basePayloadRoot) : undefined;
      if (basePayloadRoot && (customizationContained(basePayloadRoot, request.workRoot) || customizationContained(request.workRoot, basePayloadRoot))) {
        throw new CustomizationError("customization_base_invalid", "基线运行制品不能与候选目录重叠。");
      }
      const pnpm = options.pnpmPath ? fs.realpathSync(options.pnpmPath) : packagedPnpmEntry(options.trustedRoot) ?? findExecutable("pnpm");
      const toolchain = pnpmToolchain(pnpm);
      const trustedRoot = fs.realpathSync(options.trustedRoot);
      let helper: string;
      try { helper = fs.realpathSync(path.join(path.dirname(createRequire(path.join(trustedRoot, "package.json")).resolve("@kulo/hub")), "customization-payload.js")); }
      catch { throw new CustomizationError("customization_packager_unavailable", "受信界面打包程序尚未准备。"); }
      if (!customizationContained(trustedRoot, helper) || !fs.lstatSync(helper).isFile()) throw new CustomizationError("customization_packager_unavailable", "界面打包程序不属于稳定安装包。");
      const bin = controlDirectory(workRoot, ".toolchain");
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      writeControlFile(path.join(bin, "pnpm"), "#!/bin/sh\nexec " + quote(node) + " " + quote(toolchain.entry) + " \"$@\"\n", 0o700);
      await run(request, request.sourceRoot, node, [toolchain.entry, "install", "--frozen-lockfile", "--ignore-scripts", "--store-dir", path.join(request.workRoot, ".store")], "install", undefined, toolchain.readOnlyPaths);
      await run(request, request.sourceRoot, node, [toolchain.entry, "typecheck"], "offline", undefined, toolchain.readOnlyPaths);
      await run(request, request.sourceRoot, node, [toolchain.entry, "--filter", "@kulo/protocol", "build"], "offline", undefined, toolchain.readOnlyPaths);
      await run(request, request.sourceRoot, node, [toolchain.entry, "--filter", "@kulo/web", "build"], "offline", undefined, toolchain.readOnlyPaths);
      await run(request, request.sourceRoot, node, [toolchain.entry, "test", ...WEB_TEST_FILES, "--maxWorkers=4"], "offline", undefined, toolchain.readOnlyPaths);
      const script = "const m=await import(" + JSON.stringify(pathToFileURL(helper).href) + ");await m.prepareWebCustomizationPayload(" +
        JSON.stringify(request.outputRoot) + "," + JSON.stringify({ workRoot, sourceRoot: request.sourceRoot, basePayloadRoot, baseReleaseId: request.baseReleaseId }) + ");";
      await run(request, request.sourceRoot, node, ["--input-type=module", "-e", script], "offline", basePayloadRoot, toolchain.readOnlyPaths);
      return { checks: ["typecheck", "build", "build:web", "runtime:base-reused", "test", "candidate-test-plan:web-v1", "frontend-regression", "host-native:not-rerun"] };
    },
    probe: async (request) => {
      if (!options.trustedRoot) throw new CustomizationError("customization_probe_unavailable", "受信运行验证程序尚未配置。");
      const trustedRoot = fs.realpathSync(options.trustedRoot);
      let executableProbe: string;
      try {
        const expected = options.probePath ?? path.join(path.dirname(createRequire(path.join(trustedRoot, "package.json")).resolve("@kulo/hub")), "customization-probe.js");
        executableProbe = fs.realpathSync(expected);
      } catch { throw new CustomizationError("customization_probe_unavailable", "受信运行验证程序尚未构建。"); }
      if (!customizationContained(trustedRoot, executableProbe) || !fs.statSync(executableProbe).isFile() || executableProbe.endsWith(".ts")) {
        throw new CustomizationError("customization_probe_unavailable", "受信运行验证程序尚未构建。");
      }
      const verificationRoot = controlDirectory(await customizationPrivateDirectory(request.workRoot), "probe-data");
      await run(request, request.workRoot, node, [executableProbe, request.payloadRoot, request.runtimeEntry, request.webDir, verificationRoot], "localhost", request.payloadRoot);
      return { checks: ["isolated-runtime-start", "http-ui-assets", "settings-contract"] };
    },
  };
}
