import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DevicePeerConfig } from "@moco/protocol";
import { collectDeviceSystemInfo } from "./device-info.js";
import { LocalInstanceOwner } from "./local-instance.js";

export function getPeerConfigPath(): string {
  return path.resolve(process.env.MOCO_PEER_CONFIG?.trim() || path.join(os.homedir(), ".moco", "connection.json"));
}

export function localPeerProof(config: DevicePeerConfig, challenge: string): string {
  return createHmac("sha256", config.clientToken).update(JSON.stringify(["moco-local-peer-v1", config.deviceId, config.hubUrl, challenge])).digest("hex");
}

export function normalizePeerHubUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("主脑地址必须是完整的 HTTP 或 HTTPS 服务地址。");
  }
  return url.origin;
}

export function deviceHostUnreachable(): Error {
  return Object.assign(new Error("暂时无法连接主机，请检查主机和网络后重试。"), { code: "device_host_unreachable" });
}

export function invalidDeviceInvitation(): Error {
  return Object.assign(new Error("配对凭证已失效或与目标主机不符，请在目标主机重新复制邀请。"), { code: "device_invitation_invalid" });
}

export async function authenticatedPeerHub(config: DevicePeerConfig, timeoutMs: number): Promise<{ hubId: string; hubUrls: string[] }> {
  const response = await fetch(new URL("/api/devices", config.hubUrl), {
    redirect: "error", headers: { authorization: `Bearer ${config.clientToken}` }, signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => { throw deviceHostUnreachable(); });
  if (response.status === 401 || response.status === 403) throw invalidDeviceInvitation();
  if (!response.ok) throw deviceHostUnreachable();
  const data: unknown = await response.json().catch(() => { throw deviceHostUnreachable(); });
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidDeviceInvitation();
  const view = data as Record<string, unknown>;
  if (view.role !== "joined" || view.currentDeviceId !== config.deviceId || typeof view.hubId !== "string" ||
      !Array.isArray(view.hubUrls) || !view.hubUrls.every((url: unknown) => typeof url === "string")) throw invalidDeviceInvitation();
  return { hubId: view.hubId, hubUrls: view.hubUrls };
}

export function validatePeerConfig(value: unknown): DevicePeerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("设备连接配置无效。");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.deviceId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.deviceId) ||
      typeof data.name !== "string" || !data.name.trim() || typeof data.hubUrl !== "string" ||
      typeof data.rootDir !== "string" || !data.rootDir.trim() ||
      typeof data.clientToken !== "string" || !data.clientToken || /\s/.test(data.clientToken) ||
      typeof data.envToken !== "string" || !data.envToken || /\s/.test(data.envToken) || data.clientToken === data.envToken ||
      (data.localPort !== undefined && (!Number.isInteger(data.localPort) || Number(data.localPort) < 0 || Number(data.localPort) > 65535))) {
    throw new Error("设备连接配置无效。");
  }
  const rootDir = data.rootDir === "~" ? os.homedir() : data.rootDir.startsWith("~/") || data.rootDir.startsWith("~\\")
    ? path.join(os.homedir(), data.rootDir.slice(2)) : path.resolve(data.rootDir);
  return {
    version: 1,
    deviceId: data.deviceId,
    name: data.name,
    hubUrl: normalizePeerHubUrl(data.hubUrl),
    envToken: data.envToken,
    clientToken: data.clientToken,
    rootDir,
    ...(data.localPort !== undefined ? { localPort: data.localPort as number } : {}),
  };
}

function readPrivateConfig(file: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("设备连接配置必须是普通文件。");
  if (process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("设备连接配置权限必须为 0600。");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readPeerConfig(file = getPeerConfigPath()): DevicePeerConfig | null {
  const data = readPrivateConfig(file);
  return data === undefined ? null : validatePeerConfig(data);
}

function writePrivateConfig(data: unknown, file: string, createOnly = false): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("设备配置目录不能是符号链接。");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("设备连接配置不能是符号链接。");
  const temporary = path.join(directory, `.connection-${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (createOnly) {
      try { fs.linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } else fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function savePeerConfig(config: DevicePeerConfig, file = getPeerConfigPath()): void {
  writePrivateConfig(validatePeerConfig(config), file);
}

export function removePeerConfig(file = getPeerConfigPath()): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("设备连接配置必须是普通文件。");
  fs.unlinkSync(file);
}

interface PairDeviceOptions {
  hubUrl: string;
  inviteToken: string;
  hubId?: string;
  configPath?: string;
  rootDir?: string;
}

function pairingAttempt(file: string): string {
  // Two launches using the same invitation must send the same private proof, including after a crash.
  writePrivateConfig(randomBytes(32).toString("hex"), file, true);
  const value = readPrivateConfig(file);
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("设备配对重试凭据无效。");
  const directory = path.dirname(file);
  // The Hub's recovery window is one day. Clear abandoned attempts after it and the initial invitation have both expired.
  const staleBefore = Date.now() - 2 * 24 * 60 * 60_000;
  for (const name of fs.readdirSync(directory)) {
    if (!/^[0-9a-f]{64}\.attempt$/.test(name) || name === path.basename(file)) continue;
    const previous = path.join(directory, name);
    const stat = fs.lstatSync(previous, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.mtimeMs < staleBefore) fs.rmSync(previous, { force: true });
  }
  return value;
}

async function pairDevicePeer(options: PairDeviceOptions, save: (config: DevicePeerConfig) => void): Promise<DevicePeerConfig> {
  const hubUrl = normalizePeerHubUrl(options.hubUrl);
  if (!options.inviteToken?.trim()) throw new Error("缺少设备配对凭证。");
  const attemptFile = path.join(`${options.configPath ?? getPeerConfigPath()}.pending`, `${pairingFingerprint(options)}.attempt`);
  const attemptKey = pairingAttempt(attemptFile);
  const body = JSON.stringify({ inviteToken: options.inviteToken, attemptKey, info: collectDeviceSystemInfo(),
    ...(options.hubId ? { expectedHubId: options.hubId } : {}),
    ...(options.rootDir ? { rootDir: options.rootDir } : {}) });
  const signal = AbortSignal.timeout(30_000);
  const request = async () => {
    const response = await fetch(`${hubUrl}/api/devices/pair`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body, signal });
    return { response, text: await response.text() };
  };
  const { response, text } = await request().catch((error: unknown) => {
    if (signal.aborted || !(error instanceof TypeError)) throw error;
    return request();
  }).catch(() => { throw deviceHostUnreachable(); });
  if (!response.ok) {
    let detail: unknown;
    let code: unknown;
    try { ({ error: detail, code } = JSON.parse(text)); } catch { /* Older peers may return a non-JSON error response. */ }
    if (code === "device_invitation_invalid" || response.status === 401 || response.status === 410) throw invalidDeviceInvitation();
    if (response.status === 404 || response.status === 429 || response.status >= 500) throw deviceHostUnreachable();
    throw new Error(typeof detail === "string" && detail ? detail.replaceAll(attemptKey, "[已隐藏]").replaceAll(options.inviteToken, "[已隐藏]") : `设备配对失败（${response.status}）。`);
  }
  const payload = JSON.parse(text);
  // Keep a workspace explicitly selected on this device under its own control.
  const config = validatePeerConfig(options.rootDir && payload && typeof payload === "object" ? { ...payload, rootDir: options.rootDir } : payload);
  if (config.hubUrl !== hubUrl) throw new Error("主脑在配对时返回了不同的服务地址，已停止保存凭证。");
  save(config);
  fs.rmSync(attemptFile, { force: true });
  return config;
}

export async function installDevicePeer(options: PairDeviceOptions): Promise<DevicePeerConfig> {
  return pairDevicePeer(options, (config) => savePeerConfig(config, options.configPath));
}

export function pairingFingerprint(input: Pick<PairDeviceOptions, "hubUrl" | "inviteToken">): string {
  return createHash("sha256").update(JSON.stringify([normalizePeerHubUrl(input.hubUrl), input.inviteToken])).digest("hex");
}

function configRevision(config: DevicePeerConfig | null): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function withProfileLock(file: string, change: () => void): void {
  const name = "profile-" + createHash("sha256").update(path.basename(file)).digest("hex").slice(0, 24);
  const owner = LocalInstanceOwner.acquire({ directory: path.dirname(file), name }, "另一进程正在更新本机的设备连接，请重试。");
  try { change(); } finally { owner.close(); }
}

export function detachActivePeer(expected: DevicePeerConfig, file: string): void {
  withProfileLock(file, () => {
    const current = readPeerConfig(file);
    if (current && configRevision(current) !== configRevision(expected)) throw new Error("本机保存的设备连接已改变。");
    removePeerConfig(file);
  });
}

export async function stageDevicePeer(options: PairDeviceOptions, actionId?: string, expectedCurrent?: DevicePeerConfig): Promise<DevicePeerConfig> {
  const fingerprint = pairingFingerprint(options);
  // Other processes may be pairing a different invitation against the same local profile.
  const profile = options.configPath ?? getPeerConfigPath();
  const directories = [path.dirname(profile), `${profile}.pending`];
  for (const directory of directories) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("设备配对暂存目录无效。");
  }
  const before = configRevision(readPeerConfig(profile));
  if (expectedCurrent && before !== configRevision(expectedCurrent)) throw new Error("本机保存的设备连接已改变。");
  const file = path.join(`${profile}.pending`, fingerprint);
  const staged = readPrivateConfig(file);
  if (staged && typeof staged === "object" && "fingerprint" in staged && staged.fingerprint === fingerprint) {
    const config = validatePeerConfig(options.rootDir ? { ...staged, rootDir: options.rootDir } : staged);
    if (config.hubUrl === normalizePeerHubUrl(options.hubUrl)) {
      writePrivateConfig({ ...staged, ...config, before, ...(actionId ? { actionId } : {}) }, file);
      return config;
    }
  }
  return pairDevicePeer(options, (config) => writePrivateConfig({ ...config, fingerprint, actionId, before }, file));
}

function stagedFiles(file: string): string[] {
  const directory = `${file}.pending`;
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("设备配对暂存目录无效。");
  return fs.readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name)).map((name) => path.join(directory, name));
}

export function stagedPeerForAction(file: string, actionId: string, hubUrl: string): DevicePeerConfig | undefined {
  for (const staged of stagedFiles(file)) {
    const data = readPrivateConfig(staged);
    if (!data || typeof data !== "object" || !("actionId" in data) || data.actionId !== actionId) continue;
    const config = validatePeerConfig(data);
    if (config.hubUrl === hubUrl) return config;
  }
}

export function activateStagedPeer(expected: DevicePeerConfig, file = getPeerConfigPath()): void {
  withProfileLock(file, () => {
    const current = configRevision(readPeerConfig(file));
    const next = configRevision(expected);
    for (const staged of stagedFiles(file)) {
      const data = readPrivateConfig(staged);
      if (!data || typeof data !== "object" || !("before" in data) || (data.before !== current && current !== next)) continue;
      if (configRevision(validatePeerConfig(data)) === next) {
        fs.renameSync(staged, file);
        return;
      }
    }
    if (current === next) return;
    throw new Error("本机设备连接已被更新，请重新确认此次接入。");
  });
}
