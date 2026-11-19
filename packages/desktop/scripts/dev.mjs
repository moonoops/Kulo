import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensureElectron } from "./ensure-electron.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "darwin") throw new Error("Kulo 桌面开发目前先支持 macOS。");
const electron = await ensureElectron();
const mainEntry = path.join(root, "packages/desktop/dist/main.js");
const statusFile = path.join(os.homedir(), "Library/Application Support/Kulo Dev/desktop-status.json");
const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-desktop-dev-"));
fs.chmodSync(controlDir, 0o700);
const launchArguments = [mainEntry, `--kulo-dev-root=${root}`, `--kulo-dev-control=${controlDir}`];
const launchEnvironment = { ...process.env, KULO_DESKTOP_NODE_PATH: process.execPath };
delete launchEnvironment.ELECTRON_RUN_AS_NODE;
let child;
let stopping = false;
let ready = false;
let restarting = false;
let building = false;
let rebuildPending = false;
let desktopChanged = false;
let readyStatus;
let changeTimer;
let monitor;
let buildChild;
const watchers = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readStatus(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error("无效的桌面实例信息。");
    return value;
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function running(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function request(action) {
  const file = path.join(controlDir, "request.json");
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ id: randomUUID(), action }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
async function waitForExit(pid) {
  const deadline = Date.now() + 25_000;
  while (running(pid)) {
    if (Date.now() >= deadline) throw new Error("已有 Kulo Dev 尚未安全退出，请查看开发版日志。");
    await delay(100);
  }
}
async function waitUntilReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    const status = readStatus(path.join(controlDir, "ready.json"));
    if (status) return status;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error("桌面进程在启动完成前退出。");
    await delay(100);
  }
  throw new Error("Kulo 桌面开发启动超时，请查看开发版数据目录中的 desktop.log。");
}
async function launch() {
  fs.rmSync(path.join(controlDir, "ready.json"), { force: true });
  fs.rmSync(path.join(controlDir, "request.json"), { force: true });
  child = spawn(electron, launchArguments, { cwd: path.join(root, "packages/desktop"), env: launchEnvironment, stdio: "inherit" });
  child.once("error", (error) => { console.error(error.message); void stop(); });
  readyStatus = await waitUntilReady();
  ready = true;
}
async function restartDesktop() {
  restarting = true;
  request("quit");
  await waitForExit(readyStatus.pid);
  if (!stopping) await launch();
  restarting = false;
}
async function rebuild() {
  if (building || stopping) { rebuildPending = true; return; }
  building = true;
  rebuildPending = false;
  const restartMain = desktopChanged;
  desktopChanged = false;
  console.log("正在构建后台与桌面代码…");
  const success = await new Promise((resolve) => {
    buildChild = spawn("pnpm", ["--filter", "@kulo/desktop...", "build"], { cwd: root, stdio: "inherit" });
    buildChild.once("error", (error) => { console.error(error.message); resolve(false); });
    buildChild.once("exit", (code) => resolve(code === 0));
  });
  buildChild = undefined;
  if (!stopping && success) {
    try {
      if (restartMain) await restartDesktop();
      else request("reload");
      console.log(restartMain ? "桌面代码已更新。" : "后台代码已更新。");
    } catch (error) { console.error(error.message); void stop(); }
  } else if (!stopping) {
    desktopChanged ||= restartMain;
    console.error("构建失败，保留当前运行版本；修复后会再次构建。");
  }
  building = false;
  if (rebuildPending && !stopping) void rebuild();
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(changeTimer);
  clearInterval(monitor);
  for (const watcher of watchers) watcher.close();
  buildChild?.kill("SIGTERM");
  try {
    if (ready && running(readyStatus.pid)) { request("quit"); await waitForExit(readyStatus.pid); }
    else if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child.pid);
    }
    fs.rmSync(controlDir, { recursive: true, force: true });
    process.exit(0);
  } catch (error) { console.error(error.message); process.exit(1); }
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

try {
  const previous = readStatus(statusFile);
  if (previous && running(previous.pid)) {
    // Ask the owning instance to save and close; do not signal a PID read from disk.
    await new Promise((resolve, reject) => {
      const quit = spawn(electron, [mainEntry, "--kulo-quit"], { cwd: path.join(root, "packages/desktop"), env: launchEnvironment, stdio: "inherit" });
      quit.once("error", reject);
      quit.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法退出已有 Kulo Dev。")));
    });
    await waitForExit(previous.pid);
  }
  await launch();
  console.log("Kulo Dev 已进入开发模式。前端热更新，后台与桌面代码自动构建重启。Ctrl+C 退出。");
  for (const name of ["protocol", "env", "hub", "desktop"]) {
    watchers.push(fs.watch(path.join(root, "packages", name, "src"), { recursive: true }, (_event, filename) => {
      if (!filename || !/\.(?:ts|tsx|json)$/.test(filename) || /\.(?:test|spec)\.[^.]+$/.test(filename)) return;
      if (name === "desktop") desktopChanged = true;
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => { void rebuild(); }, 350);
    }));
  }
  monitor = setInterval(() => { if (!restarting && ready && !running(readyStatus.pid)) void stop(); }, 1_000);
} catch (error) { console.error(error.message); void stop(); }
