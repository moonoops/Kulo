import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHost, defineFacet, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { buildFacet, discoverPlugins, evaluateFacet } from "@earendil-works/chord/plugins";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

export const BILLION_CONTEXT_KERNEL_VERSION = "0.0.101";
export const BILLION_CONTEXT_ADAPTER_VERSION = "0.1.0";
export const BILLION_CONTEXT_PACKAGE_SOURCE = "https://github.com/ranxianglei/acp-kernel";
const KERNEL_INTEGRITY = "sha512-zKqi1mW+oTcpSY79lKkQXdz9AXFrmRj7JL6Mfpuo6JXM0WqRebXHBkQUZz9VGGi1SsOOjK0D9NghZ1/mIakdAA==";
const ADAPTER_NAME = "@moco/billion-context-adapter";
const API = { name: "@moco/extensions", versions: ["v1"] } as const;
const API_MODULE = "@moco/extensions/v1";
const KERNEL_MODULE = "@moco/extensions/v1/kernel";
const MANIFEST = "moco-extension-package.json";
const PACKAGE_FOLDER = "billion-context";
const STAGING_MARKER = ".moco-extension-staging.json";
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
}
export interface ExtensionPackageInstallOptions {
  stateDir: string;
  signal?: AbortSignal;
  npmCommand?: readonly string[];
}
export interface LoadedBillionContextPackage {
  info: ExtensionPackageInfo;
  kernel: Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}

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

export async function inspectBillionContextPackage(stateDir: string): Promise<ExtensionPackageInfo | null> {
  const { root, directory } = locations(stateDir);
  if (!await regularDirectory(path.dirname(root)) || !await regularDirectory(root) || !await regularDirectory(directory)) return null;
  const marker = path.join(directory, MANIFEST);
  const stat = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new ExtensionPackageError("extension_directory_unmanaged", "扩展目录不属于 Moco。"); throw error; });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8000) throw new ExtensionPackageError("extension_directory_unmanaged", "扩展目录不属于 Moco。");
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

const FACET = `import { defineFacet, registerKernel } from "${API_MODULE}";
import * as kernel from "${KERNEL_MODULE}";
export default defineFacet(() => { registerKernel(kernel); });\n`;

/** The reviewed facet imports one pinned library; the official loader owns its build and activation. */
async function kernelDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const root = path.join(directory, "node_modules", "acp-kernel");
  let bytes = 0, files = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await fs.readdir(folder)).sort()) {
      const file = path.join(folder, name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new ExtensionPackageError("extension_package_invalid", "内核包包含不受支持的文件。");
      if (stat.isDirectory()) { await walk(file); continue; }
      bytes += stat.size; files++;
      if (bytes > 16 * 1024 * 1024 || files > 1000) throw new ExtensionPackageError("extension_package_invalid", "内核包大小超出限制。");
      hash.update(path.relative(root, file).split(path.sep).join("/")); hash.update("\0");
      hash.update(await fs.readFile(file)); hash.update("\0");
    }
  };
  await walk(root);
  return hash.digest("hex");
}

async function loadKernel(directory: string, signal?: AbortSignal, expected?: { kernelDigest: string; digest: string }): Promise<{ kernel: Readonly<Record<string, unknown>>; digest: string; kernelDigest: string; close(): Promise<void> }> {
  const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  await regularDirectory(path.join(directory, "node_modules"));
  await regularDirectory(path.join(directory, "node_modules", "acp-kernel"));
  const actualKernelDigest = await kernelDigest(directory);
  if (expected !== undefined && actualKernelDigest !== expected.kernelDigest) throw new ExtensionPackageError("extension_integrity_mismatch", "上下文压缩内核内容已改变，请重新安装。");
  const discovery = await discoverPlugins([path.dirname(directory)], { kinds: ["worker"] }, context);
  const real = await fs.realpath(directory);
  const plugin = discovery.plugins.find((candidate) => candidate.dir === real);
  if (!plugin || discovery.problems.length) throw new ExtensionPackageError("extension_package_invalid", "扩展入口发现失败。");
  const built = await buildFacet(plugin, "worker", { hostPackages: [API_MODULE, KERNEL_MODULE], platform: "node", api: API, kinds: ["worker"] }, context);
  if (built.kind !== "script") throw new ExtensionPackageError("extension_build_failed", "上下文压缩扩展构建失败。");
  if (expected !== undefined && built.digest !== expected.digest) throw new ExtensionPackageError("extension_integrity_mismatch", "扩展适配器内容已改变，请重新安装。");
  // The published ESM library uses import.meta.url. Loading it as a host package preserves Node's ESM semantics.
  const module: unknown = await import(pathToFileURL(path.join(directory, "node_modules", "acp-kernel", "dist", "index.js")).href);
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
    if (record.kind !== "moco-extension-install" || record.version !== BILLION_CONTEXT_KERNEL_VERSION || !Number.isSafeInteger(record.ownerPid) || (record.ownerPid as number) <= 0 ||
        record.installerPid !== null && (!Number.isSafeInteger(record.installerPid) || (record.installerPid as number) <= 0)) continue;
    if (processExists(record.ownerPid as number) || record.installerPid !== null && processExists(record.installerPid as number)) continue;
    await fs.rm(directory, { recursive: true });
  }
}

async function installDependenciesClean(directory: string, options: ExtensionPackageInstallOptions, owner: Record<string, unknown>): Promise<void> {
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
    const child = spawn(process.execPath, ["--input-type=module", "-e", script],
      { cwd: path.dirname(fileURLToPath(import.meta.url)), env: extensionInstallEnvironment(process.env, home), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let termination: Promise<void> | undefined, stopFailure: unknown;
    const stop = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      termination ??= terminateExtensionInstaller(child.pid).catch((error: unknown) => { stopFailure = error; child.kill(); });
    };
    let bytes = 0;
    const consume = (data: Buffer) => { bytes += data.length; if (bytes > 1024 * 1024) stop(); };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      const completed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") { stopFailure = error; stop(); } });
      // The helper waits for stdin, so a hard-killed owner cannot leave an unrecorded npm process.
      owner.installerPid = child.pid ?? null;
      await fs.writeFile(path.join(path.dirname(directory), STAGING_MARKER), JSON.stringify(owner), { mode: 0o600 });
      const realDirectory = await fs.realpath(directory);
      child.stdin.end(JSON.stringify({ root: path.dirname(realDirectory), directory: realDirectory, npmCommand: options.npmCommand ?? ["npm"] }));
      const code = await completed;
      await termination;
      if (stopFailure) { cleanup = false; throw new ExtensionPackageError("extension_cleanup_pending", "无法确认安装进程已停止，临时文件已保留。", 502); }
      options.signal?.throwIfAborted();
      if (code !== 0) throw new ExtensionPackageError("extension_install_failed", `上下文压缩依赖安装失败（退出码 ${code ?? "中断"}）。`, 502);
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
  const staging = await fs.mkdtemp(path.join(root, ".billion-context-"));
  const staged = path.join(staging, PACKAGE_FOLDER);
  const owner = { kind: "moco-extension-install", version: BILLION_CONTEXT_KERNEL_VERSION, ownerPid: process.pid, installerPid: null as number | null };
  let cleanup = true;
  try {
    await fs.writeFile(path.join(staging, STAGING_MARKER), JSON.stringify(owner), { mode: 0o600 });
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "package.json"), `${JSON.stringify({ name: ADAPTER_NAME, version: BILLION_CONTEXT_ADAPTER_VERSION, private: true, type: "module", dependencies: { "acp-kernel": BILLION_CONTEXT_KERNEL_VERSION }, chord: { plugins: ["."] } }, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(staged, "worker.ts"), FACET, { mode: 0o600 });
    await installDependenciesClean(staged, options, owner);
    const lock = JSON.parse(await fs.readFile(path.join(staged, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string }> };
    if (lock.packages?.["node_modules/acp-kernel"]?.integrity !== KERNEL_INTEGRITY) throw new ExtensionPackageError("extension_integrity_mismatch", "上下文压缩内核完整性验证失败。");
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
