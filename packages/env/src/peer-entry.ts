import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
  getPeerConfigPath,
  readPeerConfig,
  startDevicePeer,
} from "./peer.js";
import { activateStagedPeer, pairingFingerprint, stageDevicePeer } from "./peer-config.js";
import { discoverDevicePeer } from "./peer-runtime-owner.js";
import type { DevicePeerConfig } from "@moco/protocol";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function existingPeer(config: DevicePeerConfig, options: { ignoreReadinessError?: boolean } = {}): Promise<{ url: string; origin: string; ready: boolean; pid: number } | null> {
  const instance = await discoverDevicePeer(config);
  if (!instance) return null;
  const { status } = instance;
  if (status.error && !options.ignoreReadinessError) throw new Error(status.error);
  return { url: instance.url.toString(), origin: instance.url.origin, ready: status.ready === true, pid: status.pid };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => { /* Headless devices use the printed URL. */ });
  child.unref();
}

function installLauncher(entry: string, configPath: string): string {
  const directory = process.platform === "win32" ? path.join(os.homedir(), ".moco", "bin") : path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, process.platform === "win32" ? "moco.cmd" : "moco");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (process.platform === "win32") {
    if ([process.execPath, entry, configPath].some((value) => /["%\r\n]/.test(value))) throw new Error("Moco 安装路径包含不支持的字符。");
    fs.writeFileSync(target, `@echo off\r\n"${process.execPath}" "${entry}" open --config "${configPath}" %*\r\n`, { mode: 0o700 });
  } else {
    fs.writeFileSync(target, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} open --config ${quote(configPath)} "$@"\n`, { mode: 0o700 });
    fs.chmodSync(target, 0o700);
  }
  return target;
}

async function ensureRunning(config: DevicePeerConfig, configPath: string, options: {
  staged?: string; allowOffline?: boolean; onSpawn?: (child: ChildProcess) => void;
} = {}): Promise<{ url: string; origin: string }> {
  const statusOptions = { ignoreReadinessError: options.allowOffline };
  const existing = await existingPeer(config, statusOptions);
  if (existing && (existing.ready || options.allowOffline)) return { url: existing.url, origin: existing.origin };
  let started: ChildProcess | undefined;
  if (!existing) {
    const logPath = path.join(path.dirname(configPath), "peer.log");
    const log = fs.openSync(logPath, "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start", "--config", configPath, ...(options.staged ? ["--staged", options.staged] : [])], {
        detached: true,
        stdio: options.staged ? ["ignore", log, log, "ipc"] : ["ignore", log, log],
        windowsHide: true,
        env: { ...process.env, MOCO_PEER_CONFIG: configPath },
      });
      started = child;
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
      options.onSpawn?.(child);
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (started && (started.exitCode !== null || started.signalCode !== null)) throw new Error("本机设备入口未能启动，请检查端口后用原命令重试。");
    const peer = await existingPeer(config, statusOptions);
    if (peer && (peer.ready || options.allowOffline)) return { url: peer.url, origin: peer.origin };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("尚未连接至主脑，请检查连接后重试。");
}

async function stopPeer(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  try {
    process.kill(pid, "SIGTERM");
    while (Date.now() < deadline) {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error("已有 Moco 尚未关闭，请关闭后重试。");
}

async function main(): Promise<void> {
  const [command = "open", ...args] = process.argv.slice(2);
  const configPath = path.resolve(flag(args, "--config") ?? getPeerConfigPath());
  process.env.MOCO_PEER_CONFIG = configPath;
  if (command === "install") {
    const hubUrl = flag(args, "--hub");
    const inviteToken = flag(args, "--invite");
    if (!hubUrl || !inviteToken) throw new Error("设备接入需要主脑地址和配对凭证。");
    const oldConfig = readPeerConfig(configPath);
    const previous = oldConfig ? await existingPeer(oldConfig, { ignoreReadinessError: true }) : null;
    if (previous) {
      const pidFile = path.join(path.dirname(configPath), "peer.pid");
      if (!fs.existsSync(pidFile) || Number(fs.readFileSync(pidFile, "utf8")) !== previous.pid) {
        throw new Error("该设备客户端由其他 Moco 入口管理，请先在原客户端断开连接。");
      }
    }
    const input = { hubUrl, inviteToken, configPath, rootDir: flag(args, "--root") };
    const config = await stageDevicePeer(input);
    const launcher = installLauncher(fileURLToPath(import.meta.url), configPath);
    if (previous) await stopPeer(previous.pid);
    let child: ChildProcess | undefined;
    let launched: { url: string; origin: string };
    try {
      launched = await ensureRunning(config, configPath, {
        staged: pairingFingerprint(input), onSpawn: (started) => { child = started; },
      });
      activateStagedPeer(config, configPath);
      if (child?.connected) child.disconnect();
    } catch (error) {
      if (child?.pid && child.exitCode === null && child.signalCode === null) await stopPeer(child.pid);
      if (previous && oldConfig) await ensureRunning(oldConfig, configPath, { allowOffline: true });
      throw error;
    }
    console.log(`设备已加入主脑。\nMoco: ${launched.origin}\n启动命令: ${launcher}`);
    return;
  }
  const staged = command === "start" ? flag(args, "--staged") : undefined;
  if (staged && !/^[a-f0-9]{64}$/.test(staged)) throw new Error("无效的暂存配对记录。");
  const config = readPeerConfig(staged ? path.join(`${configPath}.pending`, staged) : configPath);
  if (!config) throw new Error("尚未加入主脑，请先运行设备接入命令。");
  if (command === "start" || command === "run") {
    let stagingParentExited = false;
    let stopIfUncommitted: (() => void) | undefined;
    if (staged && process.connected) process.once("disconnect", () => { stagingParentExited = true; stopIfUncommitted?.(); });
    const runtime = await startDevicePeer(config, { onLog: (message) => console.log(message) });
    const pidFile = path.join(path.dirname(configPath), "peer.pid");
    fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await runtime.close();
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") === String(process.pid)) fs.rmSync(pidFile);
    };
    process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
    process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
    stopIfUncommitted = () => {
      const active = readPeerConfig(configPath);
      if (active?.deviceId !== config.deviceId || active.clientToken !== config.clientToken) void close().then(() => process.exit(1));
    };
    if (stagingParentExited) stopIfUncommitted();
    console.log(`Moco: ${runtime.url}`);
    return;
  }
  if (command !== "open") throw new Error(`未知的设备命令: ${command}`);
  const launched = await ensureRunning(config, configPath, { allowOffline: true });
  console.log(`Moco: ${launched.origin}`);
  openBrowser(launched.url);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "设备接入失败。");
  process.exitCode = 1;
});
