import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const APP_NAME = "Moco Dev";
export const APP_ID = "io.moco.desktop.dev";

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
  const recovery = await import(pathToFileURL(appRequire.resolve("@moco/recovery")).href);
  const release = await recovery.createReleaseManifest(appDirectory, options);
  await recovery.writeReleaseManifest(appDirectory, release);
  await fs.chmod(path.join(appDirectory, "moco-release.json"), 0o644);
  await fs.chmod(path.join(appDirectory, "moco-release.identity.json"), 0o644);
  const bundleFile = path.join(runtimeDirectory, "bundle.json");
  const bundle = JSON.parse(await fs.readFile(bundleFile, "utf8"));
  await fs.writeFile(bundleFile, JSON.stringify({ ...bundle, releaseId: release.id }, null, 2) + "\n");
  return release;
}

export async function prepareRecoveryRuntime(appDirectory, runtimeDirectory) {
  const appRequire = createRequire(path.join(appDirectory, "package.json"));
  const entry = await fs.realpath(appRequire.resolve("@moco/recovery"));
  const target = path.join(runtimeDirectory, "recovery");
  await fs.cp(path.dirname(entry), target, { recursive: true });
  await fs.writeFile(path.join(target, "package.json"), '{"private":true,"type":"module"}\n');
  await assertRegularFile(path.join(target, "bin.js"));
  const launcher = path.join(runtimeDirectory, "moco-rescue");
  await fs.writeFile(launcher, '#!/bin/sh\nmoco_runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$moco_runtime_dir/node" "$moco_runtime_dir/recovery/bin.js" "$@"\n', { mode: 0o755 });
  await fs.chmod(launcher, 0o755);
  const envEntry = await fs.realpath(appRequire.resolve("@moco/env"));
  const cleanupSource = path.join(path.dirname(envEntry), "macos-worker-cleanup");
  const sourceStat = await fs.lstat(cleanupSource);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 4 * 1024 * 1024 || !contained(await fs.realpath(appDirectory), cleanupSource)) {
    throw new Error("救援清理程序必须来自稳定包内的普通文件。");
  }
  const cleanupFile = path.join(target, "macos-worker-cleanup");
  await fs.copyFile(cleanupSource, cleanupFile, constants.COPYFILE_EXCL);
  await fs.chmod(cleanupFile, 0o500);
  const sha256 = createHash("sha256").update(await fs.readFile(cleanupFile)).digest("hex");
  await fs.writeFile(path.join(target, "moco-cleanup-runtime.json"), JSON.stringify({
    formatVersion: 1, file: "macos-worker-cleanup", sha256,
  }) + "\n", { flag: "wx", mode: 0o444 });
}

export async function verifyRecoveryCleanupRuntime(recoveryDirectory) {
  const metadataFile = path.join(recoveryDirectory, "moco-cleanup-runtime.json");
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

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertRegularFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`缺少运行文件：${file}`);
}

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function deploymentIndependentState(state) {
  const { lastValidatedTimestamp: _timestamp, filteredInstall: _filtered, settings, ...rest } = state;
  const stableSettings = { ...settings };
  for (const key of ["dev", "production", "dedupePeerDependents", "dedupeInjectedDeps", "enableGlobalVirtualStore"]) delete stableSettings[key];
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
    // pnpm 11 legacy deploy writes production-only settings to the source workspace's cache.
    // Restore that generated cache so the next pnpm command keeps the development installation.
    if (current !== original) {
      if (original === null) await fs.rm(cache, { force: true });
      else {
        const temporary = `${cache}.moco-${randomUUID()}.tmp`;
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
  const self = path.join(stage, "node_modules/.pnpm/node_modules/@moco/desktop");
  let stat;
  try { stat = await fs.lstat(self); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isSymbolicLink()) throw new Error("部署的桌面包自身引用不是符号链接。");
  const target = path.resolve(path.dirname(self), await fs.readlink(self));
  if (target === path.resolve(stage) || target === await fs.realpath(stage)) return;
  if (target !== sourceDesktopRoot && target !== await fs.realpath(sourceDesktopRoot)) {
    throw new Error("部署的桌面包自身引用指向未知位置。");
  }
  // Legacy deploy leaves its hoisted self-reference pointing at the source workspace.
  // On macOS /tmp and /var aliases can also make that generated relative link dangling.
  await fs.unlink(self);
  await fs.symlink(path.relative(path.dirname(self), stage), self, "dir");
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
  await trimDeclarations(dist);
}

async function portableNode(runtime) {
  const source = await fs.realpath(process.execPath);
  const version = process.versions.node.split(".").map(Number);
  if (version[0] < 22 || version[0] === 22 && version[1] < 20) {
    throw new Error("打包 Moco Dev 需要 Node.js ≥22.20.0。");
  }
  const { stdout } = await run("/usr/bin/otool", ["-L", source]);
  const libraries = stdout.split("\n").slice(1).map((line) => line.trim().split(" (", 1)[0]).filter(Boolean);
  if (!libraries.length || libraries.some((library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"))) {
    throw new Error("当前 Node 依赖包外动态库，请使用 Node.js 官方 macOS 二进制分发运行打包命令。");
  }
  await fs.mkdir(runtime, { recursive: true });
  const target = path.join(runtime, "node");
  await fs.copyFile(source, target);
  await fs.chmod(target, 0o755);
  const license = path.resolve(source, "../../LICENSE");
  try {
    await fs.copyFile(license, path.join(runtime, "NODE-LICENSE"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("当前 Node.js 安装缺少 LICENSE，请使用包含许可文件的官方 Node.js 分发打包。");
  }
  return target;
}

export async function prepareMacAgentClis(envPackage) {
  const envRequire = createRequire(path.join(envPackage, "package.json"));
  for (const name of ["agent-browser", "agent-desktop"]) {
    const manifestPath = envRequire.resolve(`${name}/package.json`);
    const directory = path.dirname(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const binaryName = `${name}-darwin-${process.arch}`;
    const binary = path.join(directory, "bin", binaryName);
    if (name === "agent-browser") {
      const locator = await import(pathToFileURL(path.join(directory, "scripts/native.js")).href);
      const source = locator.findNativeBinary(directory, locator.nativeTarget("darwin", process.arch));
      if (!source) throw new Error("安装包缺少 agent-browser 的 macOS 原生运行文件。");
      if (path.resolve(source) !== binary) await fs.copyFile(source, binary);
    } else {
      const helper = path.join(directory, "bin/agent-desktop-macos-helper");
      await fs.copyFile(`${helper}-darwin-${process.arch}`, helper);
      await fs.chmod(helper, 0o755);
    }
    await assertRegularFile(binary);
    await fs.chmod(binary, 0o755);
    // The Node launchers create files on first use, which would invalidate the app's sealed resources.
    manifest.bin = { ...manifest.bin, [name]: `./bin/${binaryName}` };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export async function preserveConnectorBroker(payloadRoot, options) {
  const payload = await fs.realpath(payloadRoot);
  const sourceRoot = await fs.realpath(options.workspaceRoot);
  const filename = "moco-connector-" + process.platform + "-" + process.arch + (process.platform === "win32" ? ".exe" : "");
  async function deployedHub(root) {
    const require = createRequire(path.join(root, "package.json"));
    const entry = await fs.realpath(require.resolve("@moco/hub"));
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024 || !(stat.mode & 0o111)) throw new Error("手机连接模块必须是可执行的普通文件。");
    const canonical = await fs.realpath(file);
    if (!contained(root, canonical)) throw new Error("手机连接模块指向制品外部。");
    return { file: canonical, mode: stat.mode & 0o777 };
  }
  const hub = await deployedHub(payload), nativeDirectory = path.join(hub, "native");
  if (await broker(payload, nativeDirectory)) return;
  let selected = await broker(sourceRoot, path.join(sourceRoot, "packages/hub/native"));
  if (!selected && options.basePayloadRoot) {
    if (!path.isAbsolute(options.basePayloadRoot)) throw new Error("基础制品必须使用绝对路径。");
    const base = await fs.realpath(options.basePayloadRoot);
    selected = await broker(base, path.join(await deployedHub(base), "native"));
  }
  if (!selected) return;
  await fs.mkdir(nativeDirectory, { recursive: true, mode: 0o755 });
  const directory = await fs.lstat(nativeDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !contained(payload, await fs.realpath(nativeDirectory))) throw new Error("手机连接模块输出目录无效。");
  const destination = path.join(nativeDirectory, filename);
  await fs.copyFile(selected.file, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  await fs.chmod(destination, selected.mode);
}

export async function prepareRuntimePayload(stage, options = {}) {
  const sourceRoot = await fs.realpath(options.workspaceRoot ?? workspaceRoot);
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
  if (sourceManifest.name !== "moco-monorepo") throw new Error("候选源码不是 Moco 工作区。");
  if (process.platform !== "darwin") throw new Error("当前运行制品构建仅支持 macOS。");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await withPreservedWorkspaceState(sourceRoot, async () => {
    try {
      await run(pnpm, ["--filter", "@moco/desktop", "deploy", "--legacy", "--prod", stage], {
        cwd: sourceRoot, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(["生产依赖部署失败。", error.stdout?.trim(), error.stderr?.trim(), error.message].filter(Boolean).join("\n"), { cause: error });
    }
  });
  await repairDeployedSelfLink(stage, sourceDesktopRoot);
  await assertClosedLinks(stage);
  const deployedRequire = createRequire(path.join(stage, "package.json"));
  const packages = {};
  for (const name of ["hub", "env", "recovery"]) {
    packages[name] = path.dirname(path.dirname(await fs.realpath(deployedRequire.resolve(`@moco/${name}`))));
  }
  const hubRequire = createRequire(path.join(packages.hub, "package.json"));
  packages.protocol = path.dirname(path.dirname(await fs.realpath(hubRequire.resolve("@moco/protocol"))));
  const stageRoot = await fs.realpath(stage);
  if (Object.values(packages).some((directory) => !contained(stageRoot, directory))) {
    throw new Error("部署的工作区依赖指向安装包外部。");
  }
  await preserveConnectorBroker(stage, { workspaceRoot: sourceRoot, basePayloadRoot: options.basePayloadRoot });
  await prepareMacAgentClis(packages.env);
  await trimPackage(stage, new Set(["dist", "assets", "node_modules", "package.json"]));
  await trimPackage(packages.hub, new Set(["dist", "native", "scripts", "node_modules", "package.json"]));
  await trimPackage(packages.env, new Set(["dist", "native", "bin", "node_modules", "package.json"]));
  await trimPackage(packages.protocol, new Set(["dist", "node_modules", "package.json"]));
  await trimPackage(packages.recovery, new Set(["dist", "node_modules", "package.json"]));
  const hubScripts = path.join(packages.hub, "scripts");
  for (const name of await fs.readdir(hubScripts)) {
    if (name !== "voice-asr-worker.cjs") await fs.rm(path.join(hubScripts, name), { recursive: true, force: true });
  }
  await fs.cp(path.join(sourceRoot, "packages/web/dist"), path.join(stage, "web/dist"), { recursive: true });
  // Hindsight's deployment source is a runtime resource; its local venv and tests are not.
  const integration = path.resolve(packages.hub, "../../integrations/hindsight");
  await fs.mkdir(integration, { recursive: true });
  await fs.cp(path.join(sourceRoot, "integrations/hindsight/src"), path.join(integration, "src"), {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}__pycache__`) && !file.endsWith(".pyc"),
  });
  await fs.copyFile(path.join(sourceRoot, "integrations/hindsight/pyproject.toml"), path.join(integration, "pyproject.toml"));
  for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.pnpm-workspace-state-v1.json"]) {
    await fs.rm(path.join(stage, file), { force: true });
  }
  await assertRegularFile(path.join(stage, "dist/main.js"));
  await assertRegularFile(path.join(stage, "assets/moco-icon.png"));
  await assertRegularFile(path.join(stage, "dist/runtime.js"));
  await assertRegularFile(path.join(stage, "web/dist/index.html"));
  await assertRegularFile(path.join(packages.env, "dist/peer.mjs"));
  await assertRegularFile(path.resolve(packages.hub, "../env/dist/peer.mjs"));
  await assertRegularFile(path.join(packages.env, "dist/macos-worker-cleanup"));
  await assertRegularFile(path.join(packages.env, "bin/stdio-relay.mjs"));
  await assertRegularFile(path.join(packages.hub, "native/moco-vault-keychain.c"));
  await assertRegularFile(path.join(packages.hub, "dist/moco-native-applications"));
  const keychainHelper = path.join(packages.hub, "dist/moco-vault-keychain");
  await run("/usr/bin/clang", ["-x", "c", "-O2", "-mmacosx-version-min=13.0", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-framework", "CoreFoundation", "-framework", "Security", path.join(packages.hub, "native/moco-vault-keychain.c"), "-o", keychainHelper]);
  await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.moco.connection-vault-helper", keychainHelper]);
  await fs.chmod(keychainHelper, 0o500);
  await assertRegularFile(keychainHelper);
  await assertClosedLinks(stage);
}

export async function verifyMacApp(bundle) {
  const resources = path.join(bundle, "Contents/Resources");
  const app = path.join(resources, "app");
  const node = path.join(resources, "runtime/node");
  const { stdout: identifier } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")]);
  if (identifier.trim() !== APP_ID) throw new Error("安装包应用标识不匹配。");
  await assertRegularFile(path.join(bundle, `Contents/MacOS/${APP_NAME}`));
  await assertRegularFile(path.join(app, "dist/main.js"));
  await assertRegularFile(path.join(app, "assets/moco-icon.png"));
  await assertRegularFile(path.join(app, "dist/shell.js"));
  await assertRegularFile(path.join(app, "dist/runtime.js"));
  await assertRegularFile(path.join(app, "web/dist/index.html"));
  await assertRegularFile(path.join(resources, "runtime/recovery/bin.js"));
  await assertRegularFile(path.join(resources, "runtime/moco-rescue"));
  await assertClosedLinks(app);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  await verifyRecoveryCleanupRuntime(path.join(resources, "runtime/recovery"));
  // Importing from the packaged location catches missing Node and native dependencies without opening user data.
  await run(node, ["--input-type=module", "-e", "await import('@moco/hub'); await import('@moco/env'); const r = await import('@moco/recovery'); await r.verifyRelease(process.cwd(), await r.readReleaseManifest(process.cwd()), { full: true });"], {
    cwd: app,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir() },
    maxBuffer: 1024 * 1024,
  });
  await run(node, ["--input-type=module", "-e", "await import('./recovery/index.js');"], {
    cwd: path.join(resources, "runtime"),
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir() },
    maxBuffer: 1024 * 1024,
  });
  return bundle;
}

export async function packageMacApp(options = {}) {
  if (process.platform !== "darwin") throw new Error("当前桌面打包仅支持在 macOS 上生成本机开发版。");
  const { ensureElectron } = await import("./ensure-electron.mjs");
  await ensureElectron();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "moco-desktop-package-"));
  // Keep distributables outside the workspace package's dist; otherwise the next deploy includes the previous .app.
  const output = options.outputDir ?? path.join(workspaceRoot, "dist/desktop");
  if (!path.isAbsolute(output) || path.parse(output).root === output || contained(path.join(desktopRoot, "dist"), output)) throw new Error("桌面产物目录无效。");
  try {
    const app = path.join(temporary, "app");
    await prepareRuntimePayload(app);
    if (options.updateTrustFile) {
      await fs.writeFile(path.join(app, "moco-update-trust.json"), JSON.stringify(await readUpdateTrustFile(options.updateTrustFile)) + "\n", { mode: 0o644 });
    }
    const runtime = path.join(temporary, "runtime");
    await portableNode(runtime);
    await prepareRecoveryRuntime(app, runtime);
    const electronManifest = require.resolve("electron/package.json");
    const electronVersion = JSON.parse(await fs.readFile(electronManifest, "utf8")).version;
    const checksums = JSON.parse(await fs.readFile(path.join(path.dirname(electronManifest), "checksums.json"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
    const sourceHelpers = await import(pathToFileURL(path.join(workspaceRoot, "packages/hub/dist/customization-source.js")).href);
    const sourceArchive = await sourceHelpers.createCustomizationSourceArchive(workspaceRoot, path.join(app, "moco-source.json.gz"), { version: manifest.version });
    await fs.writeFile(path.join(app, "moco-source.json"), JSON.stringify(sourceArchive) + "\n");
    await fs.chmod(path.join(app, "moco-source.json.gz"), 0o644);
    const identity = {
      ...(sourceArchive.commit ? { sourceCommit: sourceArchive.commit } : {}),
      sourceTreeHash: sourceArchive.treeHash,
      dependencyLockHash: createHash("sha256").update(await fs.readFile(path.join(workspaceRoot, "pnpm-lock.yaml"))).digest("hex"),
    };
    const releaseOptions = {
      version: manifest.version, kind: "custom", sourceCommit: identity.sourceCommit,
      sourceTreeHash: identity.sourceTreeHash, shellVersion: manifest.version,
      checks: ["closed-dependencies"],
    };
    await fs.writeFile(path.join(runtime, "bundle.json"), `${JSON.stringify({
      appId: APP_ID, appVersion: manifest.version, electronVersion,
      nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
      ...identity,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const { packager } = await import("@electron/packager");
    const bundles = await packager({
      dir: app,
      name: APP_NAME,
      appBundleId: APP_ID,
      appVersion: manifest.version,
      appCategoryType: "public.app-category.productivity",
      icon: path.join(desktopRoot, "assets/moco.icns"),
      electronVersion,
      download: { checksums },
      platform: "darwin",
      arch: process.arch,
      out: output,
      overwrite: true,
      asar: false,
      prune: false,
      derefSymlinks: false,
      // Packager's copy does not preserve relative pnpm links verbatim; copy this closed tree ourselves.
      ignore: /^\/node_modules(?:\/|$)/,
      afterCopy: [async ({ buildPath }) => {
        await fs.cp(path.join(app, "node_modules"), path.join(buildPath, "node_modules"), {
          recursive: true, dereference: false, verbatimSymlinks: true,
        });
        await assertClosedLinks(buildPath);
      }],
      darwinDarkModeSupport: true,
      extendInfo: {
        CFBundleDisplayName: APP_NAME,
        LSMinimumSystemVersion: "14.0",
        NSMicrophoneUsageDescription: "Moco 使用麦克风进行语音输入和通话。",
        NSLocalNetworkUsageDescription: "Moco 按任务访问和诊断同一局域网内的设备与本地服务。",
        NSAppleEventsUsageDescription: "Moco 在你连接消息和邮件后，按任务读取内容、发送消息或邮件。",
      },
      extraResource: [runtime],
    });
    if (bundles.length !== 1 || !bundles[0]) throw new Error("没有生成唯一的 macOS 应用。");
    const bundle = path.join(bundles[0], `${APP_NAME}.app`);
    // Packager strips fields from package.json; hash the final payload before signing it.
    const finalResources = path.join(bundle, "Contents/Resources");
    await finalizePackagedRelease(path.join(finalResources, "app"), path.join(finalResources, "runtime"), releaseOptions);
    await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", "--identifier", APP_ID, bundle], { maxBuffer: 1024 * 1024 });
    await verifyMacApp(bundle);
    console.log(`已构建：${bundle}`);
    return bundle;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packageMacApp().catch((error) => {
    console.error(error instanceof Error ? error.message : "Moco Dev 打包失败。");
    process.exitCode = 1;
  });
}
