import fs from "node:fs/promises";
import { constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
export const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
export const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const APP_NAME = "Kulo Dev";
export const APP_ID = "io.kulo.desktop.dev";
export const RELEASE_APP_NAME = "Kulo";
export const RELEASE_APP_ID = "io.kulo.desktop";

const LINUX_ALLOWED_SYSTEM_LIBS = [
  /^linux-vdso\.so/i,
  /^ld-linux/i,
  /^libc\.so\./i,
  /^libm\.so\./i,
  /^libdl\.so\./i,
  /^libpthread\.so\./i,
  /^librt\.so\./i,
  /^libstdc\+\+\.so\./i,
  /^libgcc_s\.so\./i,
];

export function resolveDesktopChannel(options = {}) {
  const raw = options.channel ?? process.env.KULO_DESKTOP_CHANNEL ?? "dev";
  const channel = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!channel || channel === "dev") {
    return { channel: "dev", appName: APP_NAME, appId: APP_ID };
  }
  if (channel === "release") {
    return { channel: "release", appName: RELEASE_APP_NAME, appId: RELEASE_APP_ID };
  }
  throw new Error(`无效的桌面发布通道：${String(raw)}（仅支持 dev 或 release）。`);
}

export function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function assertRegularFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`缺少运行文件：${file}`);
}

export async function safeChmod(target, mode) {
  if (process.platform === "win32") return;
  await fs.chmod(target, mode);
}

export async function writeSha256File(filePath) {
  const digest = createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  const outPath = `${filePath}.sha256`;
  await fs.writeFile(outPath, `${digest}  ${path.basename(filePath)}\n`, "utf8");
  return { digest, sha256Path: outPath };
}

export async function readUpdateTrustFile(filename) {
  if (!path.isAbsolute(filename)) throw new Error("更新信任文件必须使用绝对路径。");
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("更新信任文件无效。");
  const input = JSON.parse(await fs.readFile(filename, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input) || input.formatVersion !== 1 ||
      Object.keys(input).some((key) => !["formatVersion", "keys", "feedUrl", "source"].includes(key))) throw new Error("更新信任配置格式无效。");
  const keys = input.keys ?? {};
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length > 16) throw new Error("更新信任公钥无效。");
  for (const [id, pem] of Object.entries(keys)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) || typeof pem !== "string" || pem.length > 8192 ||
        !pem.trim().startsWith("-----BEGIN PUBLIC KEY-----") || createPublicKey(pem).asymmetricKeyType !== "ed25519") throw new Error("信任配置只接受 Ed25519 公钥。");
  }
  if (input.feedUrl !== undefined) {
    if (typeof input.feedUrl !== "string" || input.feedUrl.length > 2048) throw new Error("更新地址无效。");
    const url = new URL(input.feedUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("更新地址必须是不含凭据的固定 HTTPS 地址。");
  }
  if (input.source !== undefined) {
    const source = input.source;
    if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).some((key) => !["repositoryUrl", "commit", "version"].includes(key)) ||
        typeof source.repositoryUrl !== "string" || typeof source.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(source.commit) ||
        typeof source.version !== "string" || !source.version.trim() || source.version.length > 80) throw new Error("官方源码配置无效。");
    const url = new URL(source.repositoryUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash ||
        !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) throw new Error("官方源码必须使用固定公开仓库地址。");
  }
  return { formatVersion: 1, keys, ...(input.feedUrl ? { feedUrl: input.feedUrl } : {}), ...(input.source ? { source: input.source } : {}) };
}

export async function createBuildIdentity(sourceRoot = workspaceRoot) {
  const root = await fs.realpath(sourceRoot);
  const { customizationSourceIdentity } = await import(pathToFileURL(path.join(workspaceRoot, "packages/hub/dist/customization-source.js")).href);
  const source = await customizationSourceIdentity(root);
  const dependencyLockHash = createHash("sha256").update(await fs.readFile(path.join(root, "pnpm-lock.yaml"))).digest("hex");
  return { ...(source.commit ? { sourceCommit: source.commit } : {}), sourceTreeHash: source.treeHash, dependencyLockHash };
}

export async function finalizePackagedRelease(appDirectory, runtimeDirectory, options) {
  const appRequire = createRequire(path.join(appDirectory, "package.json"));
  const recovery = await import(pathToFileURL(appRequire.resolve("@kulo/recovery")).href);
  const release = await recovery.createReleaseManifest(appDirectory, options);
  await recovery.writeReleaseManifest(appDirectory, release);
  await safeChmod(path.join(appDirectory, "kulo-release.json"), 0o644);
  await safeChmod(path.join(appDirectory, "kulo-release.identity.json"), 0o644);
  const bundleFile = path.join(runtimeDirectory, "bundle.json");
  const bundle = JSON.parse(await fs.readFile(bundleFile, "utf8"));
  await fs.writeFile(bundleFile, JSON.stringify({ ...bundle, releaseId: release.id }, null, 2) + "\n");
  return release;
}

export async function prepareRecoveryRuntime(appDirectory, runtimeDirectory, options = {}) {
  const targetPlatform = options.platform ?? process.platform;
  const appRequire = createRequire(path.join(appDirectory, "package.json"));
  const entry = await fs.realpath(appRequire.resolve("@kulo/recovery"));
  const target = path.join(runtimeDirectory, "recovery");
  await fs.cp(path.dirname(entry), target, { recursive: true });
  await fs.writeFile(path.join(target, "package.json"), '{"private":true,"type":"module"}\n');
  await assertRegularFile(path.join(target, "bin.js"));
  if (targetPlatform === "win32") {
    const launcher = path.join(runtimeDirectory, "kulo-rescue.cmd");
    await fs.writeFile(launcher, '@echo off\r\n"%~dp0node.exe" "%~dp0recovery\\bin.js" %*\r\n', "utf8");
  } else {
    const launcher = path.join(runtimeDirectory, "kulo-rescue");
    await fs.writeFile(launcher, '#!/bin/sh\nkulo_runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$kulo_runtime_dir/node" "$kulo_runtime_dir/recovery/bin.js" "$@"\n', { mode: 0o755 });
    await safeChmod(launcher, 0o755);
  }
  if (targetPlatform === "darwin") {
    const envEntry = await fs.realpath(appRequire.resolve("@kulo/env"));
    const cleanupSource = path.join(path.dirname(envEntry), "macos-worker-cleanup");
    const sourceStat = await fs.lstat(cleanupSource);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 4 * 1024 * 1024 || !contained(await fs.realpath(appDirectory), cleanupSource)) {
      throw new Error("救援清理程序必须来自稳定包内的普通文件。");
    }
    const cleanupFile = path.join(target, "macos-worker-cleanup");
    await fs.copyFile(cleanupSource, cleanupFile, constants.COPYFILE_EXCL);
    await safeChmod(cleanupFile, 0o500);
    const sha256 = createHash("sha256").update(await fs.readFile(cleanupFile)).digest("hex");
    await fs.writeFile(path.join(target, "kulo-cleanup-runtime.json"), JSON.stringify({
      formatVersion: 1, file: "macos-worker-cleanup", sha256,
    }) + "\n", { flag: "wx", mode: 0o444 });
  }
}

export async function verifyRecoveryCleanupRuntime(recoveryDirectory) {
  const metadataFile = path.join(recoveryDirectory, "kulo-cleanup-runtime.json");
  const metadataStat = await fs.lstat(metadataFile);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 4096) throw new Error("救援清理程序清单无效。");
  const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  if (!metadata || metadata.formatVersion !== 1 || metadata.file !== "macos-worker-cleanup" ||
      Object.keys(metadata).some((key) => !["formatVersion", "file", "sha256"].includes(key)) ||
      typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error("救援清理程序清单无效。");
  const executable = path.join(recoveryDirectory, "macos-worker-cleanup");
  const stat = await fs.lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o777) !== 0o500) throw new Error("救援清理程序或执行权限无效。");
  const sha256 = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  if (sha256 !== metadata.sha256) throw new Error("救援清理程序摘要不一致。");
  await run(executable, ["--probe"], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: 5_000, maxBuffer: 4096,
  });
}

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function deploymentIndependentState(state) {
  const { lastValidatedTimestamp: _timestamp, filteredInstall: _filtered, settings, ...rest } = state;
  const stableSettings = { ...settings };
  for (const key of ["dev", "production", "dedupePeerDependents", "dedupeInjectedDeps", "enableGlobalVirtualStore", "nodeLinker"]) delete stableSettings[key];
  return JSON.stringify({ ...rest, settings: stableSettings });
}

export async function withPreservedWorkspaceState(directory, action) {
  const cache = path.join(directory, "node_modules/.pnpm-workspace-state-v1.json");
  const original = await readOptional(cache);
  const state = original === null ? null : JSON.parse(original);
  const watched = new Set([
    path.join(directory, "package.json"),
    path.join(directory, "pnpm-lock.yaml"),
    path.join(directory, "pnpm-workspace.yaml"),
    path.join(directory, "node_modules/.modules.yaml"),
  ]);
  for (const project of Object.keys(state?.projects ?? {})) {
    if (contained(directory, project)) watched.add(path.join(project, "package.json"));
  }
  const before = await Promise.all([...watched].map(readOptional));
  try {
    return await action();
  } finally {
    const after = await Promise.all([...watched].map(readOptional));
    const current = await readOptional(cache);
    if (before.some((content, index) => content !== after[index]) ||
        state && current !== null && deploymentIndependentState(state) !== deploymentIndependentState(JSON.parse(current))) {
      throw new Error("打包期间工作区依赖或配置发生变化，请重新安装依赖后重试。");
    }
    if (current !== original) {
      if (original === null) await fs.rm(cache, { force: true });
      else {
        const temporary = `${cache}.kulo-${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, original, { flag: "wx" });
          await fs.rename(temporary, cache);
        } finally { await fs.rm(temporary, { force: true }); }
      }
    }
  }
}

export async function assertClosedLinks(directory) {
  const root = await fs.realpath(directory);
  async function inspect(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(file);
        if (!contained(root, target)) throw new Error(`安装包的符号链接指向包外：${file}`);
      } else if (entry.isDirectory()) {
        await inspect(file);
      }
    }
  }
  await inspect(root);
}

export async function repairDeployedSelfLink(stage, sourceDesktopRoot = desktopRoot) {
  const self = path.join(stage, "node_modules/.pnpm/node_modules/@kulo/desktop");
  let stat;
  try { stat = await fs.lstat(self); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isSymbolicLink()) throw new Error("部署的桌面包自身引用不是符号链接。");
  const target = path.resolve(path.dirname(self), await fs.readlink(self));
  if (target === path.resolve(stage) || target === await fs.realpath(stage)) return;
  if (target !== sourceDesktopRoot && target !== await fs.realpath(sourceDesktopRoot)) {
    throw new Error("部署的桌面包自身引用指向未知位置。");
  }
  await fs.unlink(self);
  await fs.symlink(path.relative(path.dirname(self), stage), self, "dir");
}

/**
 * Windows installers (NSIS / non-admin extractors) cannot reliably create symlinks or junctions.
 * Removes the hoisted `@kulo/desktop` self-link first (avoiding infinite self-recursion) and
 * materializes all remaining internal links inside `node_modules` with cycle detection.
 */
export async function materializeWindowsNodeModules(stage, sourceDesktopRoot = desktopRoot) {
  const stageRoot = await fs.realpath(stage);
  const selfLink = path.join(stageRoot, "node_modules/.pnpm/node_modules/@kulo/desktop");
  const selfStat = await fs.lstat(selfLink).catch((error) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
  if (selfStat) {
    if (selfStat.isSymbolicLink()) {
      const rawTarget = path.resolve(path.dirname(selfLink), await fs.readlink(selfLink));
      const allowed = new Set([path.resolve(stageRoot), path.resolve(sourceDesktopRoot)]);
      try { allowed.add(await fs.realpath(sourceDesktopRoot)); } catch { /* ignore */ }
      if (!allowed.has(rawTarget)) throw new Error("部署的桌面包自身引用指向未知位置。");
      await fs.unlink(selfLink);
    } else {
      await fs.rm(selfLink, { recursive: true, force: true });
    }
  }

  const nodeModules = path.join(stageRoot, "node_modules");
  if (!existsSync(nodeModules)) return;

  async function derefTree(current, ancestors) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(fullPath);
        if (!contained(stageRoot, resolved)) {
          throw new Error(`Windows 部署依赖链接指向包外：${fullPath}`);
        }
        if (resolved === stageRoot || ancestors.has(resolved)) {
          // Break cyclic self-references cleanly rather than recursing infinitely.
          await fs.unlink(fullPath);
          continue;
        }
        const targetStat = await fs.stat(resolved);
        await fs.unlink(fullPath);
        if (targetStat.isDirectory()) {
          await fs.cp(resolved, fullPath, { recursive: true, dereference: true });
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(resolved);
          await derefTree(fullPath, nextAncestors);
        } else {
          await fs.copyFile(resolved, fullPath);
        }
      } else if (stat.isDirectory()) {
        const realDir = await fs.realpath(fullPath);
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(realDir);
        await derefTree(fullPath, nextAncestors);
      }
    }
  }

  await derefTree(nodeModules, new Set([stageRoot, nodeModules]));

  // Verify zero symlinks remain under stage/node_modules.
  async function assertNoLinks(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Windows 产物仍包含符号链接：${fullPath}`);
      if (entry.isDirectory()) await assertNoLinks(fullPath);
    }
  }
  await assertNoLinks(nodeModules);
}

/**
 * Resolves a Node-invocable `pnpm` command that never executes `.cmd` directly via execFile
 * (avoiding Node 22+ CVE-2024-27980 EINVAL on Windows).
 */
export function resolvePnpmInvocation(sourceRoot = workspaceRoot) {
  const envNpmExecPath = process.env.npm_execpath;
  if (envNpmExecPath && /\bpnpm\.(?:m?js|cjs)$/i.test(envNpmExecPath) && existsSync(envNpmExecPath)) {
    return { command: process.execPath, prefixArgs: [envNpmExecPath] };
  }
  // Check workspace node_modules/pnpm (if installed as a dependency, e.g., by @kulo/hub)
  for (const base of [path.join(sourceRoot, "packages/hub/package.json"), path.join(sourceRoot, "package.json")]) {
    if (!existsSync(base)) continue;
    try {
      const req = createRequire(base);
      const pkgPath = req.resolve("pnpm/package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pnpm;
      if (typeof bin === "string") {
        const candidate = path.resolve(path.dirname(pkgPath), bin);
        if (existsSync(candidate)) return { command: process.execPath, prefixArgs: [candidate] };
      }
    } catch { /* fall through */ }
  }
  // Check corepack bundled JS next to Node executable
  const nodeDir = path.dirname(process.execPath);
  for (const rel of [
    "../lib/node_modules/corepack/dist/pnpm.js",
    "node_modules/corepack/dist/pnpm.js",
    "../lib/node_modules/corepack/dist/corepack.js",
    "node_modules/corepack/dist/corepack.js",
  ]) {
    const candidate = path.resolve(nodeDir, rel);
    if (existsSync(candidate)) {
      return candidate.endsWith("corepack.js")
        ? { command: process.execPath, prefixArgs: [candidate, "pnpm"] }
        : { command: process.execPath, prefixArgs: [candidate] };
    }
  }
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", prefixArgs: ["/d", "/s", "/c", "pnpm"] };
  }
  return { command: "pnpm", prefixArgs: [] };
}

async function trimPackage(directory, allowed) {
  for (const entry of await fs.readdir(directory)) {
    if (!allowed.has(entry) && !/^licen[sc]e(?:\.|$)/i.test(entry)) {
      await fs.rm(path.join(directory, entry), { recursive: true, force: true });
    }
  }
  const dist = path.join(directory, "dist");
  async function trimDeclarations(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await trimDeclarations(file);
      else if (/\.map$|\.d\.[cm]?ts$|\.test\.[cm]?js$/.test(entry.name)) await fs.rm(file);
    }
  }
  if (existsSync(dist)) await trimDeclarations(dist);
}

export async function portableNode(runtime, options = {}) {
  const targetPlatform = options.platform ?? process.platform;
  const source = await fs.realpath(options.nodePath ?? process.execPath);
  const version = process.versions.node.split(".").map(Number);
  if (version[0] < 22 || (version[0] === 22 && version[1] < 20)) {
    throw new Error("打包 Kulo 需要 Node.js ≥22.20.0。");
  }
  if (targetPlatform === "darwin") {
    const { stdout } = await run("/usr/bin/otool", ["-L", source]);
    const libraries = stdout.split("\n").slice(1).map((line) => line.trim().split(" (", 1)[0]).filter(Boolean);
    if (!libraries.length || libraries.some((library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"))) {
      throw new Error("当前 Node 依赖包外动态库，请使用 Node.js 官方 macOS 二进制分发运行打包命令。");
    }
  } else if (targetPlatform === "linux") {
    const { stdout } = await run("ldd", [source]);
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const bad = lines.filter((line) => {
      const lib = line.split(/\s+/)[0] ?? "";
      return lib && !LINUX_ALLOWED_SYSTEM_LIBS.some((re) => re.test(path.basename(lib)));
    });
    if (bad.length) {
      throw new Error(`当前 Node 依赖非标准动态库（请使用官方 Linux 二进制分发）：${bad.join(", ")}`);
    }
  }
  await fs.mkdir(runtime, { recursive: true });
  const target = path.join(runtime, targetPlatform === "win32" ? "node.exe" : "node");
  await fs.copyFile(source, target);
  await safeChmod(target, 0o755);
  const licenseCandidates = targetPlatform === "win32"
    ? [path.resolve(source, "../LICENSE"), path.resolve(source, "../../LICENSE")]
    : [path.resolve(source, "../../LICENSE"), path.resolve(source, "../LICENSE")];
  const license = licenseCandidates.find((candidate) => existsSync(candidate));
  if (!license) {
    throw new Error("当前 Node.js 安装缺少 LICENSE，请使用包含许可文件的官方 Node.js 分发打包。");
  }
  await fs.copyFile(license, path.join(runtime, "NODE-LICENSE"));
  return target;
}

export async function prepareAgentClis(envPackage, options = {}) {
  const targetPlatform = options.platform ?? process.platform;
  const targetArch = options.arch ?? process.arch;
  const ext = targetPlatform === "win32" ? ".exe" : "";
  const envRequire = createRequire(path.join(envPackage, "package.json"));
  for (const name of ["agent-browser", "agent-desktop"]) {
    const manifestPath = envRequire.resolve(`${name}/package.json`);
    const directory = path.dirname(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const binaryName = `${name}-${targetPlatform}-${targetArch}${ext}`;
    const binary = path.join(directory, "bin", binaryName);
    if (name === "agent-browser") {
      const locator = await import(pathToFileURL(path.join(directory, "scripts/native.js")).href);
      const source = locator.findNativeBinary(directory, locator.nativeTarget(targetPlatform, targetArch));
      if (!source) throw new Error(`安装包缺少 agent-browser 的 ${targetPlatform}-${targetArch} 原生运行文件。`);
      if (path.resolve(source) !== binary) await fs.copyFile(source, binary);
    } else if (targetPlatform === "darwin") {
      const helper = path.join(directory, "bin/agent-desktop-macos-helper");
      await fs.copyFile(`${helper}-darwin-${targetArch}`, helper);
      await safeChmod(helper, 0o755);
    } else if (targetPlatform === "linux") {
      // agent-desktop Linux clipboard owner helper MUST be placed at exact path bin/agent-desktop-linux-clipboard-owner.
      const helper = path.join(directory, "bin/agent-desktop-linux-clipboard-owner");
      const suffixed = `${helper}-linux-${targetArch}`;
      if (existsSync(suffixed)) {
        await fs.copyFile(suffixed, helper);
        await safeChmod(helper, 0o755);
      } else if (existsSync(helper)) {
        await safeChmod(helper, 0o755);
      }
    }
    await assertRegularFile(binary);
    await safeChmod(binary, 0o755);
    manifest.bin = { ...manifest.bin, [name]: `./bin/${binaryName}` };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export const prepareMacAgentClis = prepareAgentClis;

export async function preserveConnectorBroker(payloadRoot, options) {
  const targetPlatform = options.platform ?? process.platform;
  const targetArch = options.arch ?? process.arch;
  const payload = await fs.realpath(payloadRoot);
  const sourceRoot = await fs.realpath(options.workspaceRoot);
  const filename = `kulo-connector-${targetPlatform}-${targetArch}${targetPlatform === "win32" ? ".exe" : ""}`;
  async function deployedHub(root) {
    const req = createRequire(path.join(root, "package.json"));
    const entry = await fs.realpath(req.resolve("@kulo/hub"));
    const hub = path.dirname(path.dirname(entry));
    if (!contained(root, hub)) throw new Error("手机连接模块所属依赖指向制品外部。");
    return hub;
  }
  async function broker(root, nativeDirectory) {
    const directory = await fs.lstat(nativeDirectory).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!directory) return undefined;
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("手机连接模块目录必须是普通目录。");
    const file = path.join(nativeDirectory, filename);
    const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat) return undefined;
    const isExecutable = targetPlatform === "win32" ? true : Boolean(stat.mode & 0o111);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024 || !isExecutable) throw new Error("手机连接模块必须是可执行的普通文件。");
    const canonical = await fs.realpath(file);
    if (!contained(root, canonical)) throw new Error("手机连接模块指向制品外部。");
    return { file: canonical, mode: stat.mode & 0o777 };
  }
  const hub = await deployedHub(payload);
  const nativeDirectory = path.join(hub, "native");
  let finalBrokerPath = (await broker(payload, nativeDirectory))?.file;
  if (!finalBrokerPath) {
    let selected = await broker(sourceRoot, path.join(sourceRoot, "packages/hub/native"));
    if (!selected && options.basePayloadRoot) {
      if (!path.isAbsolute(options.basePayloadRoot)) throw new Error("基础制品必须使用绝对路径。");
      const base = await fs.realpath(options.basePayloadRoot);
      selected = await broker(base, path.join(await deployedHub(base), "native"));
    }
    if (!selected) {
      if (options.required) throw new Error(`发布包缺少必需的手机连接模块：${filename}`);
      return;
    }
    await fs.mkdir(nativeDirectory, { recursive: true, mode: 0o755 });
    const directory = await fs.lstat(nativeDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !contained(payload, await fs.realpath(nativeDirectory))) throw new Error("手机连接模块输出目录无效。");
    const destination = path.join(nativeDirectory, filename);
    await fs.copyFile(selected.file, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await safeChmod(destination, selected.mode);
    finalBrokerPath = destination;
  }
  if (options.verifyManifest) {
    const manifestPath = options.connectorManifestPath ?? fileURLToPath(new URL("./connector-manifest.json", import.meta.url));
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const expected = manifest?.binaries?.[`${targetPlatform}-${targetArch}`]?.sha256?.trim();
    if (!expected) {
      throw new Error(`手机连接模块 ${filename} 缺少受信任的 SHA-256 清单摘要（${targetPlatform}-${targetArch}）。`);
    }
    const actual = createHash("sha256").update(await fs.readFile(finalBrokerPath)).digest("hex");
    if (actual !== expected) {
      throw new Error(`手机连接模块 ${filename} SHA-256 校验失败（期望 ${expected}，实际 ${actual}）。`);
    }
  }
}

export async function prepareRuntimePayload(stage, options = {}) {
  const sourceRoot = await fs.realpath(options.workspaceRoot ?? workspaceRoot);
  const targetPlatform = options.platform ?? process.platform;
  const targetArch = options.arch ?? process.arch;
  if (!path.isAbsolute(stage)) throw new Error("运行制品目录必须是绝对路径。");
  stage = path.join(await fs.realpath(path.dirname(stage)), path.basename(stage));
  if (contained(sourceRoot, stage) || contained(stage, sourceRoot)) {
    throw new Error("运行制品目录必须独立于源码工作区。");
  }
  const existing = await fs.lstat(stage).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await fs.readdir(stage)).length)) {
    throw new Error("运行制品目录必须是空的普通目录。");
  }
  const sourceDesktopRoot = path.join(sourceRoot, "packages/desktop");
  const sourceManifest = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8"));
  if (sourceManifest.name !== "kulo-monorepo") throw new Error("候选源码不是 Kulo 工作区。");
  if (!["darwin", "linux", "win32"].includes(targetPlatform)) {
    throw new Error(`不支持的运行制品构建平台：${targetPlatform}`);
  }
  const pnpmInvocation = resolvePnpmInvocation(sourceRoot);
  const deployEnv = targetPlatform === "win32"
    ? { ...process.env, pnpm_config_node_linker: "hoisted" }
    : process.env;
  await withPreservedWorkspaceState(sourceRoot, async () => {
    try {
      await run(pnpmInvocation.command, [...pnpmInvocation.prefixArgs, "--filter", "@kulo/desktop", "deploy", "--legacy", "--prod", stage], {
        cwd: sourceRoot, env: deployEnv, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
    } catch (error) {
      throw new Error(["生产依赖部署失败。", error.stdout?.trim(), error.stderr?.trim(), error.message].filter(Boolean).join("\n"), { cause: error });
    }
  });
  if (targetPlatform === "win32") {
    await materializeWindowsNodeModules(stage, sourceDesktopRoot);
  } else {
    await repairDeployedSelfLink(stage, sourceDesktopRoot);
    await assertClosedLinks(stage);
  }
  const deployedRequire = createRequire(path.join(stage, "package.json"));
  const packages = {};
  for (const name of ["hub", "env", "recovery", "cli"]) {
    packages[name] = path.dirname(path.dirname(await fs.realpath(deployedRequire.resolve(`@kulo/${name}`))));
  }
  const hubRequire = createRequire(path.join(packages.hub, "package.json"));
  packages.protocol = path.dirname(path.dirname(await fs.realpath(hubRequire.resolve("@kulo/protocol"))));
  const stageRoot = await fs.realpath(stage);
  if (Object.values(packages).some((directory) => !contained(stageRoot, directory))) {
    throw new Error("部署的工作区依赖指向安装包外部。");
  }
  await preserveConnectorBroker(stage, {
    workspaceRoot: sourceRoot,
    basePayloadRoot: options.basePayloadRoot,
    platform: targetPlatform,
    arch: targetArch,
    required: Boolean(options.requireConnector),
    verifyManifest: Boolean(options.verifyConnectorManifest),
  });
  await prepareAgentClis(packages.env, { platform: targetPlatform, arch: targetArch });
  await trimPackage(stage, new Set(["dist", "assets", "node_modules", "package.json"]));
  await trimPackage(packages.hub, new Set(["dist", "native", "scripts", "node_modules", "package.json"]));
  await trimPackage(packages.env, new Set(["dist", "native", "bin", "node_modules", "package.json"]));
  await trimPackage(packages.cli, new Set(["dist", "node_modules", "package.json"]));
  await trimPackage(packages.protocol, new Set(["dist", "node_modules", "package.json"]));
  await trimPackage(packages.recovery, new Set(["dist", "node_modules", "package.json"]));
  const hubScripts = path.join(packages.hub, "scripts");
  if (existsSync(hubScripts)) {
    for (const name of await fs.readdir(hubScripts)) {
      if (name !== "voice-asr-worker.cjs") await fs.rm(path.join(hubScripts, name), { recursive: true, force: true });
    }
  }
  await fs.cp(path.join(sourceRoot, "packages/web/dist"), path.join(stage, "web/dist"), { recursive: true });
  // Hindsight's deployment source is a runtime resource on macOS/Linux; its local venv and tests are not.
  if (targetPlatform !== "win32") {
    const integration = path.resolve(packages.hub, "../../integrations/hindsight");
    await fs.mkdir(integration, { recursive: true });
    await fs.cp(path.join(sourceRoot, "integrations/hindsight/src"), path.join(integration, "src"), {
      recursive: true,
      filter: (file) => !file.includes(`${path.sep}__pycache__`) && !file.endsWith(".pyc"),
    });
    await fs.copyFile(path.join(sourceRoot, "integrations/hindsight/pyproject.toml"), path.join(integration, "pyproject.toml"));
  }
  for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.pnpm-workspace-state-v1.json"]) {
    await fs.rm(path.join(stage, file), { force: true });
  }
  if (targetPlatform === "win32") {
    await fs.rm(path.join(stage, "node_modules/.pnpm"), { recursive: true, force: true });
  }
  for (const requiredFile of [
    "dist/main.js",
    "dist/runtime.js",
    "web/dist/index.html",
    "assets/kulo-icon.png",
    "assets/kulo.ico",
    "assets/kulo-trayTemplate.png",
    "assets/kulo-trayTemplate@2x.png",
    "assets/kulo-tray-light.png",
    "assets/kulo-tray-light@2x.png",
    "assets/kulo-tray-dark.png",
    "assets/kulo-tray-dark@2x.png",
    "assets/kulo-tray-badge-light.png",
    "assets/kulo-tray-badge-light@2x.png",
    "assets/kulo-tray-badge-dark.png",
    "assets/kulo-tray-badge-dark@2x.png",
  ]) {
    await assertRegularFile(path.join(stage, requiredFile));
  }
  await assertRegularFile(path.join(packages.env, "dist/peer.mjs"));
  await assertRegularFile(path.join(packages.env, "bin/stdio-relay.mjs"));
  await assertRegularFile(path.join(packages.cli, "dist/bin.js"));
  await assertRegularFile(path.join(packages.cli, "dist/headless-host.js"));
  if (targetPlatform === "darwin") {
    await assertRegularFile(path.resolve(packages.hub, "../env/dist/peer.mjs"));
    await assertRegularFile(path.join(packages.env, "dist/macos-worker-cleanup"));
    await assertRegularFile(path.join(packages.hub, "native/kulo-vault-keychain.c"));
    await assertRegularFile(path.join(packages.hub, "dist/kulo-native-applications"));
    const keychainHelper = path.join(packages.hub, "dist/kulo-vault-keychain");
    await run("/usr/bin/clang", ["-x", "c", "-O2", "-mmacosx-version-min=13.0", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-framework", "CoreFoundation", "-framework", "Security", path.join(packages.hub, "native/kulo-vault-keychain.c"), "-o", keychainHelper]);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.kulo.connection-vault-helper", keychainHelper]);
    await safeChmod(keychainHelper, 0o500);
    await assertRegularFile(keychainHelper);
  }
  if (targetPlatform !== "win32") {
    await assertClosedLinks(stage);
  }
}

export async function runPackagedSmokeTest(nodePath, appDir, runtimeDir, options = {}) {
  const targetPlatform = options.platform ?? process.platform;
  const smokeEnv = targetPlatform === "win32"
    ? {
        PATH: `${path.dirname(nodePath)};${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}`,
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? "C:\\Windows",
        ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        TEMP: os.tmpdir(),
        TMP: os.tmpdir(),
        USERPROFILE: os.homedir(),
      }
    : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir() };
  await run(nodePath, [
    "--input-type=module",
    "-e",
    "const hub = await import('@kulo/hub'); const bundled = await hub.inspectBundledBillionContextPackage(); if (!bundled || bundled.version !== hub.BILLION_CONTEXT_KERNEL_VERSION) throw new Error('安装包缺少内置 Billion Context 压缩内核。'); await import('@kulo/env'); await import('@kulo/cli'); const r = await import('@kulo/recovery'); await r.verifyRelease(process.cwd(), await r.readReleaseManifest(process.cwd()), { full: true });",
  ], { cwd: appDir, env: smokeEnv, maxBuffer: 1024 * 1024, windowsHide: true });
  await run(nodePath, ["--input-type=module", "-e", "await import('./recovery/index.js');"], {
    cwd: runtimeDir, env: smokeEnv, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}
