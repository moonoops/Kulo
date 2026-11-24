import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionError, Result, ShellExecOptions, ShellExecResult } from "@earendil-works/pi-durable/env";
import { LocalExecutionEnv, localDaemon, type LocalExecutionEnvOptions } from "@earendil-works/pi-env";
import { canonicalExecutionPath, type WorkerSandbox } from "./isolation.js";
import {
  cleanSupervisedExecution,
  processFingerprint,
  supervisedCommand,
  type SupervisorEnvPolicy,
} from "./worker-supervisor.js";

export const KULO_INTERNAL_SECRET_ENV_RE =
  /^(?:KULO|HINDSIGHT)_.*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PEER.*CONFIG)/i;

/** Core Kulo runtime files/directories protected in both trusted and sandboxed modes. */
export const KULO_CORE_STATE_SENSITIVE_NAMES = [
  "kulo.sqlite",
  "kulo.sqlite-wal",
  "kulo.sqlite-shm",
  "memory.sqlite",
  "memory.sqlite-wal",
  "memory.sqlite-shm",
  "assistant.sqlite",
  "assistant.sqlite-wal",
  "assistant.sqlite-shm",
  "credentials.json",
  "connection-vault.json",
  "devices.json",
  "connections.json",
  "runtime-token",
  "vault-envelope.enc",
  ".secure",
] as const;

const PATH_SENTINEL_START = "__KULO_PATH_START__";
const PATH_SENTINEL_END = "__KULO_PATH_END__";
const SYSTEM_STUB_PATH_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
let cachedLoginShellPath: string[] | undefined;
let loginShellPathPromise: Promise<string[]> | undefined;

export function isValidAbsolutePathSegment(segment: string): boolean {
  return segment.length > 0 && path.isAbsolute(segment) && !/[\x00-\x1f\x7f]/.test(segment);
}

export function parseLoginShellPathOutput(stdout: string, delimiter = path.delimiter): string[] {
  const start = stdout.lastIndexOf(PATH_SENTINEL_START);
  if (start < 0) return [];
  const end = stdout.indexOf(PATH_SENTINEL_END, start + PATH_SENTINEL_START.length);
  if (end < 0) return [];
  const raw = stdout.slice(start + PATH_SENTINEL_START.length, end);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of raw.split(delimiter)) {
    const trimmed = segment.trim();
    if (!isValidAbsolutePathSegment(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function resolveLoginShellPath(options?: {
  shell?: string;
  timeoutMs?: number;
}): Promise<string[]> {
  if (process.platform === "win32") return [];
  const shellCandidate =
    options?.shell ??
    (process.env.SHELL && path.isAbsolute(process.env.SHELL)
      ? process.env.SHELL
      : fs.existsSync("/bin/zsh")
        ? "/bin/zsh"
        : "/bin/sh");
  const timeoutMs = options?.timeoutMs ?? 2500;
  return new Promise<string[]>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (paths: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(paths);
    };
    const child = spawn(
      shellCandidate,
      ["-lc", `printf '%s%s%s' '${PATH_SENTINEL_START}' "$PATH" '${PATH_SENTINEL_END}'`],
      {
        env: {
          HOME: os.homedir(),
          USER: process.env.USER ?? "",
          TERM: "dumb",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish([]);
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64_000) {
        try { child.kill(); } catch { /* ignore */ }
        finish(parseLoginShellPathOutput(stdout));
      }
    });
    child.once("error", () => finish([]));
    child.once("exit", (code) => finish(code === 0 ? parseLoginShellPathOutput(stdout) : []));
  });
}

export function primeLoginShellPath(): Promise<string[]> {
  if (cachedLoginShellPath !== undefined) return Promise.resolve(cachedLoginShellPath);
  if (process.platform === "win32" || process.env.KULO_DISABLE_LOGIN_SHELL_PATH === "1" || process.env.VITEST) {
    cachedLoginShellPath = [];
    return Promise.resolve([]);
  }
  loginShellPathPromise ??= resolveLoginShellPath()
    .then((paths) => {
      cachedLoginShellPath = paths;
      return paths;
    })
    .catch(() => {
      cachedLoginShellPath = [];
      return [];
    });
  return loginShellPathPromise;
}

export function getCachedLoginShellPath(): readonly string[] {
  return cachedLoginShellPath ?? [];
}

export function resetLoginShellPathCacheForTest(override?: string[]): void {
  cachedLoginShellPath = override;
  loginShellPathPromise = undefined;
}

function listVersionedNodeDirs(parent: string, suffix: string[]): string[] {
  try {
    const entries = fs.readdirSync(parent);
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
    const dirs: string[] = [];
    for (const entry of entries) {
      const candidate = path.join(parent, entry, ...suffix);
      if (isValidAbsolutePathSegment(candidate) && fs.existsSync(candidate)) dirs.push(candidate);
    }
    return dirs;
  } catch {
    return [];
  }
}

function wellKnownUserToolDirs(): string[] {
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".local", "bin"),
          path.join(home, ".bun", "bin"),
          path.join(home, ".cargo", "bin"),
          path.join(home, "AppData", "Local", "pnpm"),
        ]
      : [
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          path.join(home, ".local", "bin"),
          path.join(home, ".bun", "bin"),
          path.join(home, ".cargo", "bin"),
          path.join(home, ".volta", "bin"),
          path.join(home, ".npm-global", "bin"),
          path.join(home, "Library", "pnpm"),
          path.join(home, ".local", "share", "pnpm"),
          path.join(home, ".asdf", "shims"),
          path.join(home, ".local", "share", "mise", "shims"),
          path.join(home, ".nodenv", "shims"),
          path.join(home, ".pyenv", "shims"),
          path.join(home, ".proto", "shims"),
          path.join(home, "go", "bin"),
          path.join(home, ".grok", "bin"),
          path.join(home, ".opencode", "bin"),
          path.join(home, ".cursor", "bin"),
          path.join(home, ".kiro", "bin"),
          path.join(home, ".gemini", "antigravity", "bin"),
          path.join(home, ".gemini", "antigravity-cli", "bin"),
          path.join(home, "Library", "Application Support", "Antigravity", "bin"),
          ...listVersionedNodeDirs(path.join(home, ".nvm", "versions", "node"), ["bin"]),
          ...listVersionedNodeDirs(
            path.join(home, "Library", "Application Support", "fnm", "node-versions"),
            ["installation", "bin"],
          ),
          ...listVersionedNodeDirs(path.join(home, ".fnm", "node-versions"), ["installation", "bin"]),
          ...listVersionedNodeDirs(
            path.join(home, ".local", "share", "fnm", "node-versions"),
            ["installation", "bin"],
          ),
        ];
  return candidates.filter((dir) => isValidAbsolutePathSegment(dir) && fs.existsSync(dir));
}

export function augmentedNativePath(
  basePath = process.env.PATH ?? "",
  loginShellDirs: readonly string[] = cachedLoginShellPath ?? [],
): string {
  const nonStubBase: string[] = [];
  const systemStubs: string[] = [];
  for (const rawSegment of basePath.split(path.delimiter)) {
    const segment = rawSegment.trim();
    if (!isValidAbsolutePathSegment(segment)) continue;
    if (SYSTEM_STUB_PATH_DIRS.has(segment)) systemStubs.push(segment);
    else nonStubBase.push(segment);
  }
  const ordered = [
    ...loginShellDirs.filter(isValidAbsolutePathSegment),
    ...nonStubBase,
    ...wellKnownUserToolDirs(),
    ...systemStubs,
  ];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of ordered) {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(dir);
  }
  return deduped.join(path.delimiter);
}

function normalizeBlockedSet(blockedEnvNames?: Iterable<string>): Set<string> {
  const blocked = new Set<string>();
  if (!blockedEnvNames) return blocked;
  for (const raw of blockedEnvNames) {
    const trimmed = raw.trim();
    if (trimmed) blocked.add(trimmed.toUpperCase());
  }
  return blocked;
}

export function isBlockedInternalEnvName(name: string, blockedUpper?: ReadonlySet<string>): boolean {
  if (KULO_INTERNAL_SECRET_ENV_RE.test(name)) return true;
  if (blockedUpper && blockedUpper.has(name.toUpperCase())) return true;
  return false;
}

/**
 * Final-pass sanitizer removing Kulo/Hindsight internal secrets and any configured custom secret env names.
 * Deduplicates environment keys case-insensitively on Windows.
 */
export function stripBlockedEnv(
  env: NodeJS.ProcessEnv,
  blockedEnvNames?: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const blockedUpper = normalizeBlockedSet(blockedEnvNames);
  const caseInsensitive = platform === "win32";
  const result: Record<string, string> = {};
  const seenKeyByUpper = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isBlockedInternalEnvName(key, blockedUpper)) continue;
    if (caseInsensitive) {
      const upper = key.toUpperCase();
      const prev = seenKeyByUpper.get(upper);
      if (prev && prev !== key) delete result[prev];
      seenKeyByUpper.set(upper, key);
    }
    result[key] = value;
  }
  return result;
}

function readEnvCaseAware(env: NodeJS.ProcessEnv, target: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[target];
  const upper = target.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === upper && v !== undefined) return v;
  }
  return undefined;
}

function setEnvCaseAware(env: NodeJS.ProcessEnv, target: string, value: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    const upper = target.toUpperCase();
    for (const k of Object.keys(env)) {
      if (k.toUpperCase() === upper && k !== target) delete env[k];
    }
  }
  env[target] = value;
}

export interface BuildTrustedHostEnvOptions {
  sourceEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string | undefined>;
  blockedEnvNames?: Iterable<string>;
  nonInteractiveSudo?: boolean;
  loginShellDirs?: readonly string[];
  platform?: NodeJS.Platform;
  homeDir?: string;
  tmpDir?: string;
}

/**
 * Construct a native trusted host environment preserving real $HOME, login-shell PATH,
 * Keychain/SSH Agent/developer tools while stripping Kulo/Hindsight internal secrets
 * (including custom configured env var names) as the final pass.
 */
export function buildTrustedHostEnv(options?: BuildTrustedHostEnvOptions): Record<string, string> {
  const platform = options?.platform ?? process.platform;
  const source = options?.sourceEnv ?? process.env;
  const stripStaleDesktopSsh = Boolean(readEnvCaseAware(source, "KULO_DESKTOP_DATA_DIR", platform));
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (
      stripStaleDesktopSsh &&
      (upper === "SSH_CLIENT" || upper === "SSH_CONNECTION" || upper === "SSH_TTY")
    ) {
      continue;
    }
    setEnvCaseAware(env, key, value, platform);
  }

  const realHome = options?.homeDir || readEnvCaseAware(env, "HOME", platform) || os.homedir();
  const realTmp = options?.tmpDir || readEnvCaseAware(env, "TMPDIR", platform) || os.tmpdir();
  setEnvCaseAware(env, "HOME", realHome, platform);
  setEnvCaseAware(env, "KULO_HOST_HOME", realHome, platform);
  setEnvCaseAware(env, "TMPDIR", realTmp, platform);
  if (!readEnvCaseAware(env, "LANG", platform)) {
    setEnvCaseAware(env, "LANG", "en_US.UTF-8", platform);
  }

  const basePath = readEnvCaseAware(env, "PATH", platform) ?? "";
  setEnvCaseAware(
    env,
    platform === "win32" ? "Path" : "PATH",
    augmentedNativePath(basePath, options?.loginShellDirs ?? cachedLoginShellPath ?? []),
    platform,
  );

  if (platform !== "win32") {
    if (!env.SHELL) {
      env.SHELL = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
    }
    if (!env.USER) {
      try { env.USER = os.userInfo().username; } catch { /* ignore */ }
    }
    if (options?.nonInteractiveSudo && !env.SUDO_ASKPASS) {
      env.SUDO_ASKPASS = "/usr/bin/false";
    }
  } else {
    if (!readEnvCaseAware(env, "TEMP", platform)) setEnvCaseAware(env, "TEMP", realTmp, platform);
    if (!readEnvCaseAware(env, "TMP", platform)) setEnvCaseAware(env, "TMP", realTmp, platform);
  }

  if (options?.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (value !== undefined) setEnvCaseAware(env, key, value, platform);
    }
  }

  // Mandatory final-pass strip so neither sourceEnv nor extraEnv can leak internal secrets.
  return stripBlockedEnv(env, options?.blockedEnvNames, platform);
}

const SAFE_MCP_DISCOVERY_EXACT = new Set([
  "HOME",
  "KULO_HOST_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PATH",
  "PATHEXT",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "NVM_DIR",
  "FNM_DIR",
  "PNPM_HOME",
  "VOLTA_HOME",
  "VIRTUAL_ENV",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
]);

const SAFE_MCP_DISCOVERY_PREFIX = /^(?:LC_|XDG_|UV_|CONDA_)/i;

/**
 * Safe runtime/discovery environment for Stdio MCP servers in trusted mode:
 * provides PATH, SSH_AUTH_SOCK, DOCKER_HOST, proxy, TLS/CA certs and language toolchains
 * without leaking unrelated host deployment/business secrets (e.g. NPM_TOKEN, STRIPE_*, DATABASE_URL).
 */
export function buildSafeMcpDiscoveryEnv(options?: {
  sourceEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string | undefined>;
  blockedEnvNames?: Iterable<string>;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const platform = options?.platform ?? process.platform;
  const source = options?.sourceEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SAFE_MCP_DISCOVERY_EXACT.has(upper) || SAFE_MCP_DISCOVERY_PREFIX.test(key)) {
      setEnvCaseAware(env, key, value, platform);
    }
  }
  const realHome = readEnvCaseAware(source, "HOME", platform) || os.homedir();
  const realTmp = readEnvCaseAware(source, "TMPDIR", platform) || os.tmpdir();
  setEnvCaseAware(env, "HOME", realHome, platform);
  setEnvCaseAware(env, "KULO_HOST_HOME", realHome, platform);
  setEnvCaseAware(env, "TMPDIR", realTmp, platform);
  if (!readEnvCaseAware(env, "LANG", platform)) setEnvCaseAware(env, "LANG", "en_US.UTF-8", platform);
  const basePath = readEnvCaseAware(source, "PATH", platform) ?? "";
  setEnvCaseAware(
    env,
    platform === "win32" ? "Path" : "PATH",
    augmentedNativePath(basePath, cachedLoginShellPath ?? []),
    platform,
  );
  if (options?.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (value !== undefined) setEnvCaseAware(env, key, value, platform);
    }
  }
  return stripBlockedEnv(env, options?.blockedEnvNames, platform);
}

/**
 * LocalExecutionEnv wrapper for trusted mode that blocks leaking Hub's raw process.env
 * while strictly respecting callers that explicitly pass `inheritEnv: false`.
 */
export class TrustedLocalExecutionEnv extends LocalExecutionEnv {
  readonly #getBlockedEnvNames?: () => Iterable<string>;
  readonly #nonInteractiveSudo: boolean;

  constructor(
    options: LocalExecutionEnvOptions & {
      getBlockedEnvNames?: () => Iterable<string>;
      nonInteractiveSudo?: boolean;
    },
  ) {
    super(options);
    this.#getBlockedEnvNames = options.getBlockedEnvNames;
    this.#nonInteractiveSudo = options.nonInteractiveSudo !== false;
  }

  override exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const blocked = this.#getBlockedEnvNames?.();
    if (options?.inheritEnv === false) {
      const sanitizedExplicit = stripBlockedEnv(options.env ?? {}, blocked);
      return super.exec(
        command,
        { ...options, inheritEnv: false, env: sanitizedExplicit },
        context,
      );
    }
    const merged = buildTrustedHostEnv({
      sourceEnv: process.env,
      extraEnv: options?.env,
      blockedEnvNames: blocked,
      nonInteractiveSudo: this.#nonInteractiveSudo,
    });
    return super.exec(
      command,
      { ...options, inheritEnv: false, env: merged },
      context,
    );
  }
}

/**
 * Build exact core runtime state protected paths (SQLite DBs, vaults, runtime-token, .secure, identityDir).
 * Explicitly excludes `mainWorkspaceDir` and Kulo source repositories so self-development works natively.
 */
export function buildCoreStateProtectedPaths(options: {
  stateDir?: string;
  identityDir?: string;
  memoryAuthFile?: string;
  extraProtectedPaths?: readonly string[];
  controlDirs?: readonly string[];
}): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value?.trim()) return;
    try { out.add(canonicalExecutionPath(value)); } catch { out.add(path.resolve(value)); }
  };
  if (options.stateDir?.trim()) {
    const base = options.stateDir.trim();
    for (const name of KULO_CORE_STATE_SENSITIVE_NAMES) {
      add(path.join(base, name));
    }
  }
  add(options.identityDir);
  add(options.memoryAuthFile);
  for (const extra of options.extraProtectedPaths ?? []) add(extra);
  for (const dir of options.controlDirs ?? []) add(dir);
  return [...out];
}

function insideDirectory(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface TrustedWorkerSessionOptions {
  workspaceDir: string;
  scratchDir?: string;
  projectId?: string;
  executionKey?: string;
  controlRoot: string;
  coreProtectedPaths?: readonly string[];
  blockedEnvNames?: Iterable<string>;
}

/**
 * Create a supervised native Worker session without OS sandboxing:
 * - Preserves real $HOME, login-shell PATH, Keychain, SSH Agent, and native toolchains;
 * - Uses in-memory env sanitization inside worker-supervisor (zero env.json written to disk);
 * - Manages lifecycle via process-group (POSIX) or Win32 Job Object (Windows) with compliant owner.json receipts.
 */
export function createTrustedWorkerSession(options: TrustedWorkerSessionOptions): WorkerSandbox {
  const workspaceDir = canonicalExecutionPath(options.workspaceDir);
  if (path.parse(workspaceDir).root === workspaceDir) {
    throw new Error("Refusing to run trusted Worker directly at filesystem root");
  }
  const controlRoot = canonicalExecutionPath(options.controlRoot);
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  if (insideDirectory(workspaceDir, controlRoot)) {
    throw new Error("Refusing to run trusted Worker inside Kulo control directory");
  }
  for (const coreProtected of options.coreProtectedPaths ?? []) {
    try {
      const resolvedProtected = canonicalExecutionPath(coreProtected);
      if (insideDirectory(workspaceDir, resolvedProtected)) {
        throw new Error(`Refusing to run trusted Worker inside protected Kulo core state path '${coreProtected}'`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to run trusted Worker")) throw error;
    }
  }

  fs.mkdirSync(workspaceDir, { recursive: true });
  const scratchDir = options.scratchDir ? canonicalExecutionPath(options.scratchDir) : undefined;
  if (scratchDir) fs.mkdirSync(scratchDir, { recursive: true });

  const controlDir = fs.mkdtempSync(path.join(controlRoot, "kulo-worker-control-"));
  if (process.platform !== "win32") {
    try { fs.chmodSync(controlDir, 0o700); } catch { /* ignore */ }
  }

  const ownerIdentity = processFingerprint(process.pid);
  const cleanupModel = process.platform === "win32" ? "windows-job" : "process-group";
  fs.writeFileSync(
    path.join(controlDir, "owner.json"),
    JSON.stringify({
      ownerPid: process.pid,
      ...(ownerIdentity ? { ownerIdentity } : {}),
      workspaceDir,
      ...(scratchDir ? { scratchDir } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.executionKey ? { executionKey: options.executionKey } : {}),
      temporaryDir: controlDir,
      cleanupModel,
    }),
    { mode: 0o600 },
  );

  const envPolicy: SupervisorEnvPolicy = {
    mode: "trusted",
    blockedEnvNames: options.blockedEnvNames ? [...options.blockedEnvNames] : [],
    extraPath: augmentedNativePath(process.env.PATH ?? "", cachedLoginShellPath ?? []),
    nonInteractiveSudo: true,
    stripDesktopSsh: Boolean(process.env.KULO_DESKTOP_DATA_DIR),
    realHome: os.homedir(),
    realTmpDir: os.tmpdir(),
  };

  const command = supervisedCommand([localDaemon()], controlDir, undefined, {
    envPolicy,
    windowsJobObject: process.platform === "win32",
  });

  let cleanupPromise: Promise<boolean> | undefined;
  const cleanup = () => {
    cleanupPromise ??= cleanSupervisedExecution(controlDir)
      .then((pending) => {
        if (!pending) {
          fs.rmSync(controlDir, { recursive: true, force: true });
        }
        return pending;
      })
      .catch((error: unknown) => {
        cleanupPromise = undefined;
        throw error;
      });
    return cleanupPromise;
  };

  return {
    workspaceDir,
    temporaryDir: controlDir,
    controlDir,
    port: 0,
    command,
    cleanup,
    close: () => {
      void cleanup().catch((error: unknown) =>
        console.error(
          "[KuloEnv:trusted-cleanup]",
          error instanceof Error ? error.message : "Trusted Worker cleanup failed",
        ),
      );
    },
  };
}
