import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHost, defineFacet, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { buildFacet, discoverPlugins, evaluateFacet } from "@earendil-works/chord/plugins";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { redactSecrets } from "@kulo/protocol";
import { resolveWindowsNpmCmdTarget } from "@kulo/env";

export const BILLION_CONTEXT_KERNEL_VERSION = "0.0.101";
export const BILLION_CONTEXT_ADAPTER_VERSION = "0.1.0";
export const BILLION_CONTEXT_PACKAGE_SOURCE = "https://github.com/ranxianglei/acp-kernel";
const KERNEL_INTEGRITY = "sha512-zKqi1mW+oTcpSY79lKkQXdz9AXFrmRj7JL6Mfpuo6JXM0WqRebXHBkQUZz9VGGi1SsOOjK0D9NghZ1/mIakdAA==";
const ADAPTER_NAME = "@kulo/billion-context-adapter";
const API = { name: "@kulo/extensions", versions: ["v1"] } as const;
const API_MODULE = "@kulo/extensions/v1";
const KERNEL_MODULE = "@kulo/extensions/v1/kernel";
const MANIFEST = "kulo-extension-package.json";
const PACKAGE_FOLDER = "billion-context";
const STAGING_MARKER = ".kulo-extension-staging.json";
const loaded = new Map<string, number>();

export class ExtensionPackageError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "ExtensionPackageError"; }
}

export interface ExtensionPackageInfo {
  id: "billion-context";
  packageName: "acp-kernel";
  version: string;
  adapterVersion: string;
  sourceUrl: string;
  directory: string;
  digest: string;
  kernelDigest: string;
  installedAt: number;
  bundled?: boolean;
}
export interface ExtensionPackageInstallOptions {
  stateDir: string;
  signal?: AbortSignal;
  npmCommand?: readonly string[];
  bundledKernelDir?: string | null;
}
export interface LoadedBillionContextPackage {
  info: ExtensionPackageInfo;
  kernel: Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}

const MAX_KERNEL_BYTES = 16 * 1024 * 1024;
const MAX_KERNEL_FILES = 1000;
const DIAGNOSTIC_TAIL_CHARS = 16 * 1024;

function locations(stateDir: string) {
  const root = path.resolve(stateDir, "extensions", "packages");
  return { root, directory: path.join(root, PACKAGE_FOLDER) };
}
async function regularDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExtensionPackageError("extension_directory_unmanaged", "扩展目录不是受管目录。");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function packageJson(directory: string): Promise<Record<string, unknown>> {
  const filename = path.join(directory, "package.json");
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new ExtensionPackageError("extension_package_invalid", "扩展版本清单无效。");
  const value: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtensionPackageError("extension_package_invalid", "扩展版本清单无效。");
  return value as Record<string, unknown>;
}

export async function resolveBundledBillionContextKernel(): Promise<string | null> {
  let candidate: string | null = null;
  if (typeof import.meta.resolve === "function") {
    try {
      const entry = fileURLToPath(import.meta.resolve("acp-kernel"));
      candidate = path.resolve(path.dirname(entry), "..");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (!candidate) {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const probe = path.join(cursor, "node_modules", "acp-kernel", "package.json");
      const found = await fs.lstat(probe).then((stat) => stat.isFile() || stat.isSymbolicLink(), () => false);
      if (found) { candidate = path.dirname(probe); break; }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  if (!candidate) return null;
  let directory: string;
  try { directory = await fs.realpath(candidate); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  let engine: Record<string, unknown>;
  try { engine = await packageJson(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (engine.name !== "acp-kernel" || engine.version !== BILLION_CONTEXT_KERNEL_VERSION) return null;
  const entry = await fs.lstat(path.join(directory, "dist", "index.js"))
    .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!entry || !entry.isFile() || entry.isSymbolicLink()) return null;
  return directory;
}

export async function inspectBundledBillionContextPackage(): Promise<ExtensionPackageInfo | null> {
  const directory = await resolveBundledBillionContextKernel();
  if (!directory) return null;
  return {
    id: PACKAGE_FOLDER, packageName: "acp-kernel", version: BILLION_CONTEXT_KERNEL_VERSION,
    adapterVersion: BILLION_CONTEXT_ADAPTER_VERSION, sourceUrl: BILLION_CONTEXT_PACKAGE_SOURCE,
    directory, digest: "", kernelDigest: "", installedAt: 0, bundled: true,
  };
}

export async function inspectBillionContextPackage(stateDir: string): Promise<ExtensionPackageInfo | null> {
  const { root, directory } = locations(stateDir);
  if (!await regularDirectory(path.dirname(root)) || !await regularDirectory(root) || !await regularDirectory(directory)) return null;
  const marker = path.join(directory, MANIFEST);
  const stat = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new ExtensionPackageError("extension_directory_unmanaged", "扩展目录不属于 Kulo。"); throw error; });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8000) throw new ExtensionPackageError("extension_directory_unmanaged", "扩展目录不属于 Kulo。");
  const value: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtensionPackageError("extension_package_invalid", "扩展安装记录无效。");
  const record = value as Record<string, unknown>;
  if (record.id !== PACKAGE_FOLDER || record.packageName !== "acp-kernel" || record.sourceUrl !== BILLION_CONTEXT_PACKAGE_SOURCE ||
      typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest) || typeof record.kernelDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.kernelDigest) || typeof record.installedAt !== "number" ||
      !Number.isSafeInteger(record.installedAt) || record.installedAt <= 0) throw new ExtensionPackageError("extension_package_invalid", "扩展安装记录无效。");
  const wrapper = await packageJson(directory);
  const engineDirectory = path.join(directory, "node_modules", "acp-kernel");
  if (!await regularDirectory(path.dirname(engineDirectory))) throw new ExtensionPackageError("extension_package_missing", "上下文压缩依赖目录缺失。");
  if (!await regularDirectory(engineDirectory)) throw new ExtensionPackageError("extension_package_missing", "上下文压缩内核缺失。");
  const engine = await packageJson(engineDirectory);
  if (wrapper.name !== ADAPTER_NAME || wrapper.version !== BILLION_CONTEXT_ADAPTER_VERSION || record.adapterVersion !== wrapper.version ||
      engine.name !== "acp-kernel" || engine.version !== BILLION_CONTEXT_KERNEL_VERSION || record.version !== engine.version) {
    throw new ExtensionPackageError("extension_version_mismatch", "扩展实际版本与已验证版本不一致。");
  }
  return { id: PACKAGE_FOLDER, packageName: "acp-kernel", version: engine.version, adapterVersion: wrapper.version,
    sourceUrl: BILLION_CONTEXT_PACKAGE_SOURCE, directory: await fs.realpath(directory), digest: record.digest, kernelDigest: record.kernelDigest, installedAt: record.installedAt };
}

export async function inspectAvailableBillionContextPackage(
  stateDir: string,
  options: { includeBundled?: boolean } = {},
): Promise<ExtensionPackageInfo | null> {
  const managed = await inspectBillionContextPackage(stateDir);
  if (managed) return managed;
  if (options.includeBundled === false) return null;
  return inspectBundledBillionContextPackage();
}

const FACET = `import { defineFacet, registerKernel } from "${API_MODULE}";
import * as kernel from "${KERNEL_MODULE}";
export default defineFacet(() => { registerKernel(kernel); });\n`;

/** The reviewed facet imports one pinned library; the official loader owns its build and activation. */
async function kernelDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0, files = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await fs.readdir(folder)).sort()) {
      const file = path.join(folder, name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new ExtensionPackageError("extension_package_invalid", "内核包包含不受支持的文件。");
      if (stat.isDirectory()) { await walk(file); continue; }
      bytes += stat.size; files++;
      if (bytes > MAX_KERNEL_BYTES || files > MAX_KERNEL_FILES) throw new ExtensionPackageError("extension_package_invalid", "内核包大小超出限制。");
      hash.update(path.relative(root, file).split(path.sep).join("/")); hash.update("\0");
      hash.update(await fs.readFile(file)); hash.update("\0");
    }
  };
  await walk(root);
  return hash.digest("hex");
}

async function copyRegularTree(source: string, destination: string): Promise<void> {
  let bytes = 0, files = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const name of (await fs.readdir(from)).sort()) {
      const src = path.join(from, name), dst = path.join(to, name);
      const stat = await fs.lstat(src);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new ExtensionPackageError("extension_package_invalid", "内核包包含不受支持的文件。");
      }
      if (stat.isDirectory()) { await walk(src, dst); continue; }
      bytes += stat.size; files++;
      if (bytes > MAX_KERNEL_BYTES || files > MAX_KERNEL_FILES) {
        throw new ExtensionPackageError("extension_package_invalid", "内核包大小超出限制。");
      }
      await fs.copyFile(src, dst);
    }
  };
  await walk(source, destination);
}

async function loadKernelFromDirectories(
  adapterDirectory: string,
  kernelDirectory: string,
  signal?: AbortSignal,
  expected?: { kernelDigest: string; digest: string },
): Promise<{ kernel: Readonly<Record<string, unknown>>; digest: string; kernelDigest: string; close(): Promise<void> }> {
  const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  await regularDirectory(kernelDirectory);
  const actualKernelDigest = await kernelDigest(kernelDirectory);
  if (expected !== undefined && actualKernelDigest !== expected.kernelDigest) throw new ExtensionPackageError("extension_integrity_mismatch", "上下文压缩内核内容已改变，请重新安装。");
  const discovery = await discoverPlugins([path.dirname(adapterDirectory)], { kinds: ["worker"] }, context);
  const real = await fs.realpath(adapterDirectory);
  const plugin = discovery.plugins.find((candidate) => candidate.dir === real);
  if (!plugin || discovery.problems.length) throw new ExtensionPackageError("extension_package_invalid", "扩展入口发现失败。");
  const built = await buildFacet(plugin, "worker", { hostPackages: [API_MODULE, KERNEL_MODULE], platform: "node", api: API, kinds: ["worker"] }, context);
  if (built.kind !== "script") throw new ExtensionPackageError("extension_build_failed", "上下文压缩扩展构建失败。");
  if (expected !== undefined && built.digest !== expected.digest) throw new ExtensionPackageError("extension_integrity_mismatch", "扩展适配器内容已改变，请重新安装。");
  // The published ESM library uses import.meta.url. Loading it as a host package preserves Node's ESM semantics.
  const module: unknown = await import(pathToFileURL(path.join(kernelDirectory, "dist", "index.js")).href);
  let kernel: Readonly<Record<string, unknown>> | undefined;
  const facet = evaluateFacet(built, { plugin, hostPackages: { [KERNEL_MODULE]: module, [API_MODULE]: { defineFacet, registerKernel: (value: unknown) => {
    if (kernel || !value || typeof value !== "object" || !["createCore", "createInitialState", "defaultConfig", "collectBlockContent"].every((name) => typeof (value as Record<string, unknown>)[name] === "function")) {
      throw new ExtensionPackageError("extension_kernel_invalid", "上下文压缩内核接口验证失败。");
    }
    kernel = value as Readonly<Record<string, unknown>>;
  } } } });
  const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
  const errors: unknown[] = [];
  const host = createHost({ store, onError: (error) => errors.push(error) });
  const close = async () => { try { await host.close(BACKGROUND_CONTEXT); } finally { await store.close(BACKGROUND_CONTEXT); } };
  try {
    const report = await host.load([{ name: plugin.name, facet }], context);
    if (!kernel || errors.length || report.failed.length) throw new ExtensionPackageError("extension_kernel_invalid", "上下文压缩内核装载验证失败。");
    let closed = false;
    return { kernel, digest: built.digest, kernelDigest: actualKernelDigest, close: async () => { if (!closed) { closed = true; await close(); } } };
  } catch (error) { await close(); throw error; }
}

async function loadKernel(directory: string, signal?: AbortSignal, expected?: { kernelDigest: string; digest: string }) {
  await regularDirectory(path.join(directory, "node_modules"));
  return loadKernelFromDirectories(directory, path.join(directory, "node_modules", "acp-kernel"), signal, expected);
}

/** Inherited npm/user configuration is deliberately absent from the install process. */
export function extensionInstallEnvironment(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, NPM_CONFIG_USERCONFIG: path.join(home, "npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(home, "global-npmrc"),
    NPM_CONFIG_CACHE: path.join(home, "cache"), NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig") };
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExtensionNpmCommand(
  parent: NodeJS.ProcessEnv,
  explicit?: readonly string[],
  options: { platform?: NodeJS.Platform; execPath?: string; checkExecutable?: (file: string) => Promise<boolean> } = {},
): Promise<{ command: readonly string[]; extraPathDirs: string[] }> {
  if (explicit !== undefined) return { command: explicit, extraPathDirs: [] };
  const platform = options.platform ?? process.platform;
  const pathLib = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const binary = platform === "win32" ? "npm.cmd" : "npm";
  const execPath = options.execPath ?? process.execPath;
  const execDir = pathLib.dirname(execPath);
  const home = parent.HOME ?? parent.USERPROFILE;
  const candidates = [
    ...(parent.PATH ?? "").split(delimiter),
    execDir,
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", ...(home ? [pathLib.join(home, ".local", "bin")] : [])]),
  ];
  const seen = new Set<string>();
  const check = options.checkExecutable ?? isExecutableFile;
  for (const dir of candidates) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const fullPath = pathLib.join(trimmed, binary);
    if (await check(fullPath)) {
      const extraPathDirs = [execDir, trimmed].filter((entry, index, list) => Boolean(entry) && list.indexOf(entry) === index);
      if (platform === "win32") {
        const bundledCli = pathLib.join(trimmed, "node_modules", "npm", "bin", "npm-cli.js");
        const resolvedShim = (await check(bundledCli)) ? { scriptPath: bundledCli } : resolveWindowsNpmCmdTarget(fullPath);
        if (resolvedShim) return { command: [execPath, resolvedShim.scriptPath], extraPathDirs };
      }
      return { command: [fullPath], extraPathDirs };
    }
  }
  throw new ExtensionPackageError("extension_install_failed", "上下文压缩依赖安装失败：当前运行环境未找到 npm 命令。", 502);
}

function sanitizeInstallerDiagnostic(text: string): string {
  return redactSecrets(text)
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1••••@")
    .replace(/(\b(?:_?auth[_-]?token|access[_-]?token|token|password|passwd|secret|api[_-]?key)\s*[=:]\s*)[^\s&"']+/gi, "$1••••");
}

export function summarizeExtensionInstallFailure(code: number | null, stderr: string, stdout = ""): string {
  const combined = sanitizeInstallerDiagnostic(`${stderr}\n${stdout}`);
  const suffix = `退出码 ${code ?? "中断"}`;
  if (/spawn\s+npm\b[^\n]*\bENOENT\b|\bENOENT\b[^\n]*\bnpm\b/i.test(combined)) {
    return "上下文压缩依赖安装失败：当前运行环境未找到 npm 命令。";
  }
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|EPROTO)\b|network\s+(?:error|timeout)|fetch failed/i.test(combined)) {
    return `上下文压缩依赖安装失败：无法连接 npm 源（${suffix}，请检查网络或代理）。`;
  }
  if (/\b(?:CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)\b/i.test(combined)) {
    return `上下文压缩依赖安装失败：TLS 证书校验失败（${suffix}）。`;
  }
  if (/\b(?:EACCES|EPERM|EROFS)\b/i.test(combined)) {
    return `上下文压缩依赖安装失败：安装目录权限不足（${suffix}）。`;
  }
  if (/\bENOSPC\b/i.test(combined)) {
    return `上下文压缩依赖安装失败：磁盘空间不足（${suffix}）。`;
  }
  const npmCode = /npm\s+(?:ERR!|error)\s+code\s+([A-Z0-9_-]{2,40})/i.exec(combined)?.[1];
  if (npmCode) {
    return `上下文压缩依赖安装失败（${npmCode}，${suffix}）。`;
  }
  return `上下文压缩依赖安装失败（${suffix}）。`;
}

export async function terminateExtensionInstaller(pid: number, options: { platform?: NodeJS.Platform; systemRoot?: string; launch?: typeof spawn } = {}): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ExtensionPackageError("extension_cleanup_pending", "安装进程标识无效。");
  if ((options.platform ?? process.platform) !== "win32") {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    return;
  }
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR;
  const killer = (options.launch ?? spawn)(systemRoot ? path.win32.join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe", ["/PID", String(pid), "/T", "/F"],
    { stdio: "ignore", shell: false, windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    killer.once("error", reject);
    killer.once("close", (code) => code === 0 ? resolve() : reject(new ExtensionPackageError("extension_cleanup_pending", "无法确认安装进程树已停止，临时文件已保留。", 502)));
  });
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; if ((error as NodeJS.ErrnoException).code === "EPERM") return true; throw error; }
}
async function cleanupStaging(root: string): Promise<void> {
  for (const name of await fs.readdir(root)) {
    if (!/^\.billion-context-[a-zA-Z0-9]+$/.test(name)) continue;
    const directory = path.join(root, name), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const marker = path.join(directory, STAGING_MARKER);
    let record: Record<string, unknown>;
    try {
      const info = await fs.lstat(marker);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2000) continue;
      const value: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      record = value as Record<string, unknown>;
    } catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (record.kind !== "kulo-extension-install" || record.version !== BILLION_CONTEXT_KERNEL_VERSION || !Number.isSafeInteger(record.ownerPid) || (record.ownerPid as number) <= 0 ||
        record.installerPid !== null && (!Number.isSafeInteger(record.installerPid) || (record.installerPid as number) <= 0)) continue;
    if (processExists(record.ownerPid as number) || record.installerPid !== null && processExists(record.installerPid as number)) continue;
    await fs.rm(directory, { recursive: true });
  }
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > DIAGNOSTIC_TAIL_CHARS ? next.slice(-DIAGNOSTIC_TAIL_CHARS) : next;
}

async function installDependenciesClean(directory: string, options: ExtensionPackageInstallOptions, owner: Record<string, unknown>): Promise<void> {
  const resolvedNpm = await resolveExtensionNpmCommand(process.env, options.npmCommand);
  const home = await fs.mkdtemp(path.join(path.dirname(directory), ".install-env-"));
  await fs.writeFile(path.join(home, "npmrc"), "", { mode: 0o600 });
  await fs.writeFile(path.join(home, "global-npmrc"), "", { mode: 0o600 });
  await fs.writeFile(path.join(home, "gitconfig"), "", { mode: 0o600 });
  const script = `import { discoverPlugins, installDependencies } from "@earendil-works/chord/plugins";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());
const context=withAbortSignal(controller.signal,BACKGROUND_CONTEXT);
let payload='';for await(const bytes of process.stdin)payload+=bytes;
const input=JSON.parse(payload);
const found=await discoverPlugins([input.root],{kinds:["worker"]},context);
const plugin=found.plugins.find(p=>p.dir===input.directory);
if(!plugin||found.problems.length)throw new Error("Managed plugin discovery failed");
await installDependencies(plugin,context,{npmCommand:input.npmCommand});`;
  let cleanup = true;
  try {
    options.signal?.throwIfAborted();
    const installEnv = extensionInstallEnvironment(process.env, home);
    if (resolvedNpm.extraPathDirs.length) {
      const existing = (installEnv.PATH ?? "").split(path.delimiter).filter(Boolean);
      const merged: string[] = [];
      for (const dir of [...resolvedNpm.extraPathDirs, ...existing]) {
        if (dir && !merged.includes(dir)) merged.push(dir);
      }
      installEnv.PATH = merged.join(path.delimiter);
    }
    const child = spawn(process.execPath, ["--input-type=module", "-e", script],
      { cwd: path.dirname(fileURLToPath(import.meta.url)), env: installEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let termination: Promise<void> | undefined, stopFailure: unknown;
    const stop = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      termination ??= terminateExtensionInstaller(child.pid).catch((error: unknown) => { stopFailure = error; child.kill(); });
    };
    let bytes = 0, stdoutTail = "", stderrTail = "";
    const consume = (stream: "stdout" | "stderr") => (data: Buffer) => {
      bytes += data.length;
      if (stream === "stdout") stdoutTail = appendTail(stdoutTail, data);
      else stderrTail = appendTail(stderrTail, data);
      if (bytes > 1024 * 1024) stop();
    };
    child.stdout.on("data", consume("stdout")); child.stderr.on("data", consume("stderr"));
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      const completed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") { stopFailure = error; stop(); } });
      // The helper waits for stdin, so a hard-killed owner cannot leave an unrecorded npm process.
      owner.installerPid = child.pid ?? null;
      await fs.writeFile(path.join(path.dirname(directory), STAGING_MARKER), JSON.stringify(owner), { mode: 0o600 });
      const realDirectory = await fs.realpath(directory);
      child.stdin.end(JSON.stringify({ root: path.dirname(realDirectory), directory: realDirectory, npmCommand: resolvedNpm.command }));
      const code = await completed;
      await termination;
      if (stopFailure) { cleanup = false; throw new ExtensionPackageError("extension_cleanup_pending", "无法确认安装进程已停止，临时文件已保留。", 502); }
      options.signal?.throwIfAborted();
      if (code !== 0) {
        const redactedDetail = sanitizeInstallerDiagnostic((stderrTail.trim() || stdoutTail.trim()).slice(-2000));
        if (redactedDetail) console.error(`[KuloExtensions] dependency install failed (exit ${code ?? "signal"}):\n${redactedDetail}`);
        throw new ExtensionPackageError("extension_install_failed", summarizeExtensionInstallFailure(code, stderrTail, stdoutTail), 502);
      }
    } catch (error) {
      stop(); await termination;
      if (stopFailure) { cleanup = false; throw new ExtensionPackageError("extension_cleanup_pending", "无法确认安装进程已停止，临时文件已保留。", 502); }
      throw error;
    } finally { options.signal?.removeEventListener("abort", stop); }
  } finally { if (cleanup) await fs.rm(home, { recursive: true, force: true }); }
}

export async function installBillionContextPackage(options: ExtensionPackageInstallOptions): Promise<ExtensionPackageInfo> {
  const existing = await inspectBillionContextPackage(options.stateDir);
  if (existing) return existing;
  const { root, directory } = locations(options.stateDir);
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await regularDirectory(path.dirname(root));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await regularDirectory(root);
  const finalDirectory = path.join(await fs.realpath(root), PACKAGE_FOLDER);
  await cleanupStaging(root);
  const bundledKernel = options.npmCommand !== undefined || options.bundledKernelDir === null
    ? null
    : (options.bundledKernelDir ?? await resolveBundledBillionContextKernel());
  const staging = await fs.mkdtemp(path.join(root, ".billion-context-"));
  const staged = path.join(staging, PACKAGE_FOLDER);
  const owner = { kind: "kulo-extension-install", version: BILLION_CONTEXT_KERNEL_VERSION, ownerPid: process.pid, installerPid: null as number | null };
  let cleanup = true;
  try {
    await fs.writeFile(path.join(staging, STAGING_MARKER), JSON.stringify(owner), { mode: 0o600 });
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "package.json"), `${JSON.stringify({ name: ADAPTER_NAME, version: BILLION_CONTEXT_ADAPTER_VERSION, private: true, type: "module", dependencies: { "acp-kernel": BILLION_CONTEXT_KERNEL_VERSION }, chord: { plugins: ["."] } }, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(staged, "worker.ts"), FACET, { mode: 0o600 });
    if (bundledKernel) {
      options.signal?.throwIfAborted();
      await copyRegularTree(bundledKernel, path.join(staged, "node_modules", "acp-kernel"));
    } else {
      await installDependenciesClean(staged, options, owner);
      const lock = JSON.parse(await fs.readFile(path.join(staged, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string }> };
      if (lock.packages?.["node_modules/acp-kernel"]?.integrity !== KERNEL_INTEGRITY) throw new ExtensionPackageError("extension_integrity_mismatch", "上下文压缩内核完整性验证失败。");
    }
    const engine = await packageJson(path.join(staged, "node_modules", "acp-kernel"));
    if (engine.name !== "acp-kernel" || engine.version !== BILLION_CONTEXT_KERNEL_VERSION) throw new ExtensionPackageError("extension_version_mismatch", "上下文压缩内核版本验证失败。");
    const checked = await loadKernel(staged, options.signal);
    await checked.close();
    const info: ExtensionPackageInfo = { id: PACKAGE_FOLDER, packageName: "acp-kernel", version: BILLION_CONTEXT_KERNEL_VERSION,
      adapterVersion: BILLION_CONTEXT_ADAPTER_VERSION, sourceUrl: BILLION_CONTEXT_PACKAGE_SOURCE, directory: finalDirectory, digest: checked.digest, kernelDigest: checked.kernelDigest, installedAt: Date.now() };
    await fs.writeFile(path.join(staged, MANIFEST), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(staged, directory);
    return info;
  } catch (error) { if (error instanceof ExtensionPackageError && error.code === "extension_cleanup_pending") cleanup = false; throw error; }
  finally { if (cleanup) await fs.rm(staging, { recursive: true, force: true }); }
}

export async function loadBillionContextPackage(stateDir: string): Promise<LoadedBillionContextPackage> {
  const info = await inspectBillionContextPackage(stateDir);
  if (!info) throw new ExtensionPackageError("extension_not_installed", "请先安装 Billion Context。");
  const runtime = await loadKernel(info.directory, undefined, info);
  loaded.set(info.directory, (loaded.get(info.directory) ?? 0) + 1);
  let closed = false;
  return { info, kernel: runtime.kernel, close: async () => { if (!closed) { closed = true; try { await runtime.close(); }
    finally { const count = (loaded.get(info.directory) ?? 1) - 1; if (count > 0) loaded.set(info.directory, count); else loaded.delete(info.directory); } } } };
}

export async function loadBundledBillionContextPackage(signal?: AbortSignal): Promise<LoadedBillionContextPackage> {
  const info = await inspectBundledBillionContextPackage();
  if (!info) throw new ExtensionPackageError("extension_not_installed", "请先安装 Billion Context。");
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-billion-adapter-"));
  const adapter = path.join(staging, PACKAGE_FOLDER);
  try {
    await fs.mkdir(adapter, { mode: 0o700 });
    await fs.writeFile(path.join(adapter, "package.json"), `${JSON.stringify({ name: ADAPTER_NAME, version: BILLION_CONTEXT_ADAPTER_VERSION, private: true, type: "module", chord: { plugins: ["."] } }, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(adapter, "worker.ts"), FACET, { mode: 0o600 });
    const runtime = await loadKernelFromDirectories(adapter, info.directory, signal);
    let closed = false;
    return {
      info: { ...info, digest: runtime.digest, kernelDigest: runtime.kernelDigest },
      kernel: runtime.kernel,
      close: async () => { if (!closed) { closed = true; await runtime.close(); } },
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function loadAvailableBillionContextPackage(
  stateDir: string,
  options: { includeBundled?: boolean; signal?: AbortSignal } = {},
): Promise<LoadedBillionContextPackage> {
  const managed = await inspectBillionContextPackage(stateDir);
  if (managed) return loadBillionContextPackage(stateDir);
  if (options.includeBundled === false) throw new ExtensionPackageError("extension_not_installed", "请先安装 Billion Context。");
  return loadBundledBillionContextPackage(options.signal);
}

export async function removeBillionContextPackage(stateDir: string): Promise<void> {
  const info = await inspectBillionContextPackage(stateDir);
  if (!info) return;
  if (loaded.has(info.directory)) throw new ExtensionPackageError("extension_running", "请先停止 Billion Context。");
  await fs.rm(info.directory, { recursive: true });
}

/** Inspecting a candidate uses official discovery only and never evaluates its code. */
export async function discoverExtensionPackages(root: string) {
  return discoverPlugins([root], { kinds: ["worker"] }, BACKGROUND_CONTEXT);
}
