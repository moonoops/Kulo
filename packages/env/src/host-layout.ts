import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isOwnerMismatch, safeChmodSync, safeFchmodSync } from "./platform-fs.js";

export type HostAppChannel = "release" | "dev";

export interface KuloHostLayout {
  dataDir: string;
  stateDir: string;
  identityDir: string;
  workspaceDir: string;
  peerConfigPath: string;
  tokenPath: string;
  portPath: string;
}

export function resolveDefaultHostAppName(channel: HostAppChannel = "release"): string {
  return channel === "dev" ? "Kulo Dev" : "Kulo";
}

/**
 * Resolves the canonical per-user data directory shared by Electron Desktop
 * and headless `kulo host` across macOS, Windows, and Linux.
 */
export function resolveDefaultHostDataDir(options: {
  channel?: HostAppChannel;
  appName?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const appName = options.appName ?? resolveDefaultHostAppName(options.channel ?? "release");

  const explicit = env.KULO_DESKTOP_DATA_DIR?.trim() || env.KULO_DATA_DIR?.trim();
  if (explicit && path.isAbsolute(explicit)) {
    return path.resolve(explicit);
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", appName);
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || path.win32.join(homeDir, "AppData", "Roaming");
    return path.win32.join(appData, appName);
  }
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  const base = xdgConfig && path.posix.isAbsolute(xdgConfig) ? xdgConfig : path.posix.join(homeDir, ".config");
  return path.posix.join(base, appName);
}

function assertValidAbsoluteDir(value: string, label: string): string {
  if (!value?.trim() || !path.isAbsolute(value) || path.parse(value).root === path.resolve(value)) {
    throw new Error(`${label} 必须是有效的绝对目录。`);
  }
  return path.resolve(value);
}

export function resolveKuloHostLayout(dataDir: string): KuloHostLayout {
  const root = assertValidAbsoluteDir(dataDir, "数据目录");
  const stateDir = path.join(root, "hub");
  return {
    dataDir: root,
    stateDir,
    identityDir: path.join(stateDir, "identity"),
    workspaceDir: path.join(root, "workspace"),
    peerConfigPath: path.join(root, "peer", "connection.json"),
    tokenPath: path.join(stateDir, "runtime-token"),
    portPath: path.join(root, "runtime-port"),
  };
}

function ensurePrivateHostDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || isOwnerMismatch(stat)) {
    throw new Error("Kulo 数据目录不可用。");
  }
  safeChmodSync(directory, 0o700);
}

/**
 * Ensures the host directories exist and returns the persisted 64-hex management token
 * (`<stateDir>/runtime-token`), creating it atomically if absent.
 */
export function ensureHostRuntimeToken(paths: KuloHostLayout): string {
  for (const directory of [
    paths.dataDir,
    paths.stateDir,
    paths.identityDir,
    paths.workspaceDir,
    path.dirname(paths.peerConfigPath),
  ]) {
    ensurePrivateHostDir(directory);
  }
  const temporary = path.join(paths.stateDir, `.runtime-token-${randomBytes(12).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(temporary, paths.tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const descriptor = fs.openSync(paths.tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || isOwnerMismatch(stat)) {
      throw new Error("Kulo 本机管理凭据不可用。");
    }
    safeFchmodSync(descriptor, 0o600);
    const token = fs.readFileSync(descriptor, "utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Kulo 本机管理凭据不可用。");
    return token;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readExistingHostRuntimeToken(tokenPath: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 64 || isOwnerMismatch(stat)) return undefined;
    const token = fs.readFileSync(descriptor, "utf8");
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readHostRuntimePort(paths: KuloHostLayout): number {
  let descriptor: number;
  try {
    descriptor = fs.openSync(paths.portPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 6 || isOwnerMismatch(stat)) {
      throw new Error("Kulo 本机服务端口配置不可用。");
    }
    const value = fs.readFileSync(descriptor, "utf8");
    const port = Number(value.trim());
    if (!/^[1-9][0-9]{0,4}\n?$/.test(value) || !Number.isInteger(port) || port > 65535) {
      throw new Error("Kulo 本机服务端口配置不可用。");
    }
    safeFchmodSync(descriptor, 0o600);
    return port;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function saveHostRuntimePort(paths: KuloHostLayout, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Kulo 本机服务端口配置不可用。");
  }
  const previous = readHostRuntimePort(paths);
  if (previous) {
    if (previous !== port) throw new Error("Kulo 本机服务端口与已保存配置不一致。");
    return;
  }
  const temporary = path.join(paths.dataDir, `.runtime-port-${randomBytes(12).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${port}\n`, { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(temporary, paths.portPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (readHostRuntimePort(paths) !== port) {
      throw new Error("Kulo 本机服务端口与已保存配置不一致。");
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
