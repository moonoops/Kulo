import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface DesktopRuntimeOptions {
  dataDir: string;
  webDir: string;
  viteUrl?: string;
  appRoot?: string;
  shellVersion?: string;
  sourceRoot?: string;
  trustedRoot?: string;
}

export interface DesktopRuntimePaths {
  dataDir: string;
  stateDir: string;
  identityDir: string;
  workspaceDir: string;
  peerConfigPath: string;
  tokenPath: string;
  portPath: string;
}

function absoluteDirectory(value: string | undefined, name: string): string {
  if (!value?.trim() || !path.isAbsolute(value) || path.parse(value).root === path.resolve(value)) {
    throw new Error(`${name} 必须是有效的绝对目录。`);
  }
  return path.resolve(value);
}

export function resolveDesktopRuntimePaths(dataDir: string): DesktopRuntimePaths {
  const root = absoluteDirectory(dataDir, "开发版数据目录");
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

function loopbackOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("开发服务器必须使用本机 HTTP 地址。"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("开发服务器必须使用本机 HTTP 地址。");
  }
  return url.origin;
}

export function loadDesktopRuntimeOptions(env: NodeJS.ProcessEnv): DesktopRuntimeOptions {
  const shellVersion = env.MOCO_DESKTOP_SHELL_VERSION;
  if (shellVersion !== undefined && !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(shellVersion)) throw new Error("桌面运行版本无效。");
  return {
    dataDir: absoluteDirectory(env.MOCO_DESKTOP_DATA_DIR, "开发版数据目录"),
    webDir: absoluteDirectory(env.MOCO_DESKTOP_WEB_DIR, "界面资源目录"),
    ...(env.MOCO_DESKTOP_VITE_URL ? { viteUrl: loopbackOrigin(env.MOCO_DESKTOP_VITE_URL) } : {}),
    ...(env.MOCO_DESKTOP_APP_ROOT ? { appRoot: absoluteDirectory(env.MOCO_DESKTOP_APP_ROOT, "运行资源目录") } : {}),
    ...(shellVersion ? { shellVersion } : {}),
    ...(env.MOCO_DESKTOP_SOURCE_ROOT ? { sourceRoot: absoluteDirectory(env.MOCO_DESKTOP_SOURCE_ROOT, "源码目录") } : {}),
    ...(env.MOCO_DESKTOP_TRUSTED_ROOT ? { trustedRoot: absoluteDirectory(env.MOCO_DESKTOP_TRUSTED_ROOT, "受信资源目录") } : {}),
  };
}

/** Finder and terminal launches must resolve to the same private development instance. */
export function buildRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  options: DesktopRuntimeOptions,
): NodeJS.ProcessEnv {
  const paths = resolveDesktopRuntimePaths(options.dataDir);
  const webDir = absoluteDirectory(options.webDir, "界面资源目录");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || /^MOCO_/i.test(name) ||
        /^(?:AWS|GOOGLE|GCLOUD|AZURE|ANTHROPIC|OPENAI|OPENROUTER|PI)_/i.test(name) ||
        /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|ACCESS_KEY|PRIVATE_KEY)(?:_|$)/i.test(name) ||
        /^(?:NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE)$/i.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, {
    MOCO_DESKTOP_DATA_DIR: paths.dataDir,
    MOCO_DESKTOP_WEB_DIR: webDir,
    MOCO_STATE_DIR: paths.stateDir,
    MOCO_IDENTITY_DIR: paths.identityDir,
    MOCO_PEER_CONFIG: paths.peerConfigPath,
    MOCO_HUB_HOST: "127.0.0.1",
  });
  if (options.viteUrl) env.MOCO_DESKTOP_VITE_URL = loopbackOrigin(options.viteUrl);
  if (options.appRoot) env.MOCO_DESKTOP_APP_ROOT = absoluteDirectory(options.appRoot, "运行资源目录");
  if (options.shellVersion) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(options.shellVersion)) throw new Error("桌面运行版本无效。");
    env.MOCO_DESKTOP_SHELL_VERSION = options.shellVersion;
  }
  if (options.sourceRoot) env.MOCO_DESKTOP_SOURCE_ROOT = absoluteDirectory(options.sourceRoot, "源码目录");
  if (options.trustedRoot) env.MOCO_DESKTOP_TRUSTED_ROOT = absoluteDirectory(options.trustedRoot, "受信资源目录");
  return env;
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("开发版数据目录不可用。");
  }
  fs.chmodSync(directory, 0o700);
}

/** Publishes a complete token atomically so another launch never observes a partial secret. */
export function prepareDesktopRuntime(paths: DesktopRuntimePaths): string {
  for (const directory of [paths.dataDir, paths.stateDir, paths.identityDir, paths.workspaceDir, path.dirname(paths.peerConfigPath)]) {
    privateDirectory(directory);
  }
  const temporary = path.join(paths.stateDir, `.runtime-token-${randomBytes(12).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    try { fs.linkSync(temporary, paths.tokenPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const descriptor = fs.openSync(paths.tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("开发版管理凭据不可用。");
    }
    fs.fchmodSync(descriptor, 0o600);
    const token = fs.readFileSync(descriptor, "utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("开发版管理凭据不可用。");
    return token;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** A stable origin preserves browser preferences across desktop launches. */
export function readDesktopRuntimePort(paths: DesktopRuntimePaths): number {
  let descriptor: number;
  try { descriptor = fs.openSync(paths.portPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 6 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("开发版服务端口不可用。");
    }
    const value = fs.readFileSync(descriptor, "utf8");
    const port = Number(value.trim());
    if (!/^[1-9][0-9]{0,4}\n?$/.test(value) || !Number.isInteger(port) || port > 65535) {
      throw new Error("开发版服务端口不可用。");
    }
    fs.fchmodSync(descriptor, 0o600);
    return port;
  } finally { fs.closeSync(descriptor); }
}

export function saveDesktopRuntimePort(paths: DesktopRuntimePaths, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("开发版服务端口不可用。");
  const previous = readDesktopRuntimePort(paths);
  if (previous) {
    if (previous !== port) throw new Error("开发版服务端口与已保存配置不一致。");
    return;
  }
  const temporary = path.join(paths.dataDir, `.runtime-port-${randomBytes(12).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${port}\n`, { mode: 0o600, flag: "wx" });
    try { fs.linkSync(temporary, paths.portPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (readDesktopRuntimePort(paths) !== port) throw new Error("开发版服务端口与已保存配置不一致。");
  } finally { fs.rmSync(temporary, { force: true }); }
}
