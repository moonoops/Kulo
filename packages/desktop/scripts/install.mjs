import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { APP_ID, APP_NAME, packageMacApp, verifyMacApp } from "./package.mjs";
import { pruneInstallerBackups, recordInstallerBackup } from "./installer-history.mjs";

const run = promisify(execFile);
const defaultDestination = `/Applications/${APP_NAME}.app`;

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function isRunning(bundle) {
  const executable = path.join(bundle, `Contents/MacOS/${APP_NAME}`);
  const { stdout } = await run("/bin/ps", ["-axo", "comm="]);
  return stdout.split("\n").some((line) => line.trim() === executable);
}

async function stopInstalledApp(bundle, dataDir) {
  if (!await isRunning(bundle)) return;
  await run(path.join(bundle, `Contents/MacOS/${APP_NAME}`), ["--kulo-quit", "--kulo-data-dir=" + dataDir], { timeout: 20_000 });
  const deadline = Date.now() + 20_000;
  while (await isRunning(bundle)) {
    if (Date.now() >= deadline) throw new Error("Kulo Dev 仍在保存任务，请退出应用后重新安装。");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function installMacApp(options = {}) {
  if (process.platform !== "darwin") throw new Error("当前安装脚本仅支持 macOS。");
  const destination = options.destination ?? defaultDestination;
  const dataDir = options.dataDir ?? path.join(os.homedir(), "Library/Application Support", APP_NAME);
  if (!path.isAbsolute(destination) || !path.isAbsolute(dataDir) || path.parse(destination).root === destination || path.parse(dataDir).root === dataDir) throw new Error("安装位置和数据目录必须是独立绝对路径。");
  const source = options.source ?? await packageMacApp();
  await verifyMacApp(source);
  const sourceRoot = path.join(source, "Contents/Resources/app");
  const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));
  const recoveryApi = await import(pathToFileURL(sourceRequire.resolve("@kulo/recovery")).href);
  const manager = new recoveryApi.RecoveryManager(dataDir);
  let oldIdentity;
  const previous = await exists(destination);
  if (previous) {
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${destination} 不是可替换的开发版应用。`);
    const info = path.join(destination, "Contents/Info.plist");
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", info]);
    if (stdout.trim() !== APP_ID) throw new Error(`${destination} 已存在其他应用，未执行覆盖。`);
    await stopInstalledApp(destination, dataDir);
    const oldRoot = path.join(destination, "Contents/Resources/app");
    if (await exists(path.join(oldRoot, "kulo-release.identity.json"))) oldIdentity = recoveryApi.readReleaseIdentity(oldRoot);
  }
  const staged = path.join(path.dirname(destination), `.${APP_NAME}.install-${randomUUID()}.app`);
  const backup = path.join(path.dirname(destination), `.${APP_NAME}.backup-${Date.now()}.app`);
  let movedPrevious = false;
  let installed = false;
  let relocated = false;
  try {
    await fs.cp(source, staged, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE });
    await verifyMacApp(staged);
    if (previous) {
      await fs.rename(destination, backup);
      movedPrevious = true;
      await recordInstallerBackup(backup);
    }
    await fs.rename(staged, destination);
    installed = true;
    await verifyMacApp(destination);
    if (oldIdentity && (await manager.inspect()).releases.some((release) => release.id === oldIdentity.id)) {
      await manager.relocateRelease(oldIdentity.id, path.join(backup, "Contents/Resources/app"));
      relocated = true;
    }
  } catch (error) {
    if (installed) await fs.rm(destination, { recursive: true, force: true });
    if (movedPrevious) await fs.rename(backup, destination);
    if (relocated) await manager.relocateRelease(oldIdentity.id, path.join(destination, "Contents/Resources/app"));
    await fs.rm(backup + ".kulo-backup.json", { force: true });
    throw error;
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
  try {
    const inspection = await manager.inspect();
    if (inspection.warnings.length) throw new Error("恢复索引需要检查，已保留旧应用备份。");
    await manager.withOfflineMaintenance((releases) => pruneInstallerBackups(destination, releases.map((release) => release.root)));
  } catch (error) {
    console.warn("已安装，旧应用备份清理未完成：" + (error instanceof Error ? error.message : "未知清理错误"));
  }
  console.log(`已安装：${destination}`);
  if (movedPrevious) console.log(`旧版本备份：${backup}`);
  if (options.launch) await run("/usr/bin/open", ["-a", destination, "--args", "--kulo-data-dir=" + dataDir]);
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installMacApp({ launch: process.argv.includes("--launch") }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Kulo Dev 安装失败。");
    process.exitCode = 1;
  });
}
