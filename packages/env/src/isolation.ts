import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { localDaemon } from "@earendil-works/pi-env";
import { supervisedCommand, cleanSupervisedExecution, processFingerprint } from "./worker-supervisor.js";
import { createWindowsSandboxCommand, createWindowsSandboxSetupCommand, cleanupWindowsSandboxCommand } from "./isolation-windows.js";
import { createLinuxSandboxCommand, linuxSandboxAvailable } from "./isolation-linux.js";
import { createMacSandboxCleanupCommand, macSandboxCleanupAvailable } from "./isolation-macos.js";
import { randomBytes } from "node:crypto";

export interface WorkerExecutionOptions {
  scratchDir?: string;
  network?: WorkerNetworkPolicy;
  projectId?: string;
  grantRevision?: number;
  stagedTaskId?: string;
  readOnly?: boolean;
}

export interface WorkerNetworkPolicy {
  localConnectPorts?: readonly number[];
  localListenPorts?: readonly number[];
  /** When true, blocks public internet outbound traffic while permitting local loopback daemon IPC. */
  offline?: boolean;
}

export interface WorkerSandboxOptions extends WorkerExecutionOptions {
  workspaceDir: string;
  workspaceRoot?: string;
  protectedPaths?: readonly string[];
  /** Paths that remain readable inside the sandbox but cannot be modified, created, unlinked, or renamed. */
  writeDeniedPaths?: readonly string[];
  controlRoot?: string;
  managedScratchRoot?: string;
  /** Read-only installed program code needed by a managed protocol subprocess, never native account stores. */
  runtimePaths?: readonly string[];
}

export interface WorkerSandbox {
  command: readonly string[];
  temporaryDir: string;
  workspaceDir: string;
  port: number;
  close(): void;
  cleanup(): Promise<boolean>;
}

export function canonicalExecutionPath(value: string): string {
  const resolved = path.resolve(value);
  let current = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot resolve execution path '${value}'`);
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}

function inside(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function nativeProtectedPaths(values: readonly string[]): string[] {
  return values.filter((value) => process.platform === "win32" ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value) : path.posix.isAbsolute(value));
}

function quoted(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid sandbox path");
  return JSON.stringify(value);
}

const allocatedPorts = new Set<number>();

function allocateWorkerPort(): number {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listener = net.createServer();
    listener.on("error", () => listener.close());
    listener.listen(0);
    const address = listener.address();
    listener.close();
    if (!address || typeof address === "string") throw new Error("Cannot reserve a Worker development port");
    if (allocatedPorts.has(address.port)) continue;
    allocatedPorts.add(address.port);
    return address.port;
  }
  throw new Error("Cannot allocate a unique Worker development port");
}

function normalizedPorts(values: readonly number[] | undefined): number[] {
  const ports = [...new Set(values ?? [])];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Worker network capabilities require explicit TCP ports from 1 to 65535");
  }
  return ports.sort((a, b) => a - b);
}

const SENSITIVE_CONFIG_SUBDIRS: readonly string[] = [
  "gh",
  "gcloud",
  "rclone",
  "op",
  "1Password",
  "sops",
  "hub",
  "configstore",
  "netlify",
  "vercel",
  "stripe",
  "doctl",
  "helm",
  "firebase",
  "aws",
  "azure",
  "codex",
  "claude",
  "anthropic",
  "openai",
  "kulo",
  "heroku",
  "tailscale",
  "fly",
  "railway",
  "supabase",
  "cloudflare",
  "wrangler",
  "docker",
  "kubernetes",
  "pip",
  "pypirc",
  "npm",
  "pnpm",
  "yarn",
  "cursor",
  "zed",
  "opencode",
  "github-copilot",
  "kiro",
  "grok",
];

export function defaultProtectedPaths(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".gnupg"),
    path.join(homeDir, ".kube"),
    path.join(homeDir, ".claude"),
    path.join(homeDir, ".codex"),
    path.join(homeDir, ".gemini"),
    path.join(homeDir, ".antigravity"),
    path.join(homeDir, ".grok"),
    path.join(homeDir, ".cursor"),
    path.join(homeDir, ".opencode"),
    path.join(homeDir, ".local", "share", "opencode"),
    path.join(homeDir, ".kiro"),
    path.join(homeDir, ".copilot"),
    ...SENSITIVE_CONFIG_SUBDIRS.map((entry) => path.join(homeDir, ".config", entry)),
    path.join(homeDir, ".dsh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".azure"),
    path.join(homeDir, ".netrc"),
    path.join(homeDir, ".git-credentials"),
    path.join(homeDir, "AppData/Roaming/Microsoft/Credentials"),
    path.join(homeDir, "AppData/Local/Microsoft/Credentials"),
    path.join(homeDir, "Library/Keychains"),
    path.join(homeDir, "Library/Cookies"),
    path.join(homeDir, "Library/Group Containers/2BUA8C4S2C.com.1password"),
    ...applicationProtectedPaths(homeDir),
  ];
}

/** Account access to these local stores is brokered, even inside an authorized project root. */
export function applicationProtectedPaths(homeDir = os.homedir()): string[] {
  if (process.platform !== "darwin") return [];
  return [
    "Library/Messages", "Library/SMS", "Library/Mail", "Library/Application Support/Mail",
    "Library/Containers/com.apple.iChat", "Library/Containers/com.apple.MobileSMS", "Library/Containers/com.apple.messages", "Library/Containers/com.apple.mail",
    "Library/Group Containers/group.com.apple.messages", "Library/Group Containers/group.com.apple.mail", "Library/Group Containers/com.apple.MailPersonaStorage",
    "Library/Group Containers/group.com.apple.usernoted",
  ].map((entry) => path.join(homeDir, entry));
}

const PRIVATE_APP_CONTAINER = /^(?:com\.apple\.(?:mail|MobileSMS|iChat|messages)(?:\.[^/\\]+)?|com\.apple\.share\.Mail\.compose)$/u;
const LEGACY_NOTIFICATION_CENTER_PATH = /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/0\/com\.apple\.notificationcenter(?:\/|$)/u;

export function isApplicationPrivatePath(value: string): boolean {
  if (process.platform !== "darwin") return false;
  const actual = canonicalExecutionPath(value);
  if (LEGACY_NOTIFICATION_CENTER_PATH.test(actual)) return true;
  if (applicationProtectedPaths().some((entry) => inside(actual, canonicalExecutionPath(entry)))) return true;
  const containers = canonicalExecutionPath(path.join(os.homedir(), "Library/Containers"));
  const relative = path.relative(containers, actual);
  return !relative.startsWith("..") && !path.isAbsolute(relative) && PRIVATE_APP_CONTAINER.test(relative.split(path.sep)[0] ?? "");
}

function legacyNotificationCenterFilter(): string {
  return '(regex #"^/private/var/folders/[^/]+/[^/]+/0/com[.]apple[.]notificationcenter(/|$)")';
}

function applicationContainerFilter(): string {
  const containers = canonicalExecutionPath(path.join(os.homedir(), "Library/Containers"));
  const escaped = containers.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(regex #${quoted(`^${escaped}/(com[.]apple[.](mail|MobileSMS|iChat|messages)([.][^/]*)?|com[.]apple[.]share[.]Mail[.]compose)(/|$)`)})`;
}

export function workerExecutionPath(protectedPaths: readonly string[]): string {
  const homeDir = os.homedir();
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(homeDir, "Library/pnpm"),
    path.join(homeDir, ".local/share/pnpm"),
    path.join(homeDir, ".local/bin"),
    path.join(homeDir, ".bun/bin"),
    path.join(homeDir, ".cargo/bin"),
    path.join(homeDir, ".volta/bin"),
    path.join(homeDir, ".pyenv/shims"),
    path.join(homeDir, "go/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const canonicalProtected = protectedPaths.map(canonicalExecutionPath);
  const seen = new Set<string>();
  for (const raw of candidates) {
    const entry = raw.trim();
    if (!entry || !path.isAbsolute(entry) || /[\x00-\x1f\x7f:]/.test(entry)) continue;
    try {
      const resolved = canonicalExecutionPath(entry);
      if (canonicalProtected.some((blocked) => inside(resolved, blocked))) continue;
    } catch {
      continue;
    }
    seen.add(entry);
  }
  return [...seen].join(":");
}

export function workerProxyEnvironment(): string[] {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
  const entries: string[] = [];
  for (const key of keys) {
    const value = process.env[key];
    if (!value || /[\x00-\x1f\x7f@]/.test(value)) continue;
    entries.push(`${key}=${value}`);
  }
  return entries;
}

function collectGitDirWriteDeniedTargets(gitDir: string, targets: Set<string>, depth = 0): void {
  targets.add(path.join(gitDir, "hooks"));
  targets.add(path.join(gitDir, "config"));
  targets.add(path.join(gitDir, "config.worktree"));
  targets.add(path.join(gitDir, "info", "attributes"));
  if (depth >= 4) return;
  const modulesDir = path.join(gitDir, "modules");
  try {
    if (!fs.existsSync(modulesDir) || !fs.lstatSync(modulesDir).isDirectory()) return;
  } catch {
    return;
  }
  const walkModules = (dir: string, currentDepth: number) => {
    if (currentDepth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const looksLikeGitDir =
        fs.existsSync(path.join(child, "HEAD")) ||
        fs.existsSync(path.join(child, "config")) ||
        fs.existsSync(path.join(child, "hooks"));
      if (looksLikeGitDir) {
        collectGitDirWriteDeniedTargets(child, targets, currentDepth + 1);
      } else {
        walkModules(child, currentDepth + 1);
      }
    }
  };
  walkModules(modulesDir, depth + 1);
}

/** Discover readable-but-write-denied Git control paths under a workspace directory. */
export function discoverGitWriteDeniedPaths(workspaceDir: string): string[] {
  const targets = new Set<string>();
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = canonicalExecutionPath(workspaceDir);
  } catch {
    return [];
  }
  const dotGit = path.join(canonicalWorkspace, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGit);
  } catch {
    return [];
  }
  if (stat.isDirectory()) {
    collectGitDirWriteDeniedTargets(dotGit, targets);
  } else if (stat.isFile()) {
    targets.add(dotGit);
    try {
      const content = fs.readFileSync(dotGit, "utf8");
      const match = content.match(/^\s*gitdir:\s*(.+?)\s*$/m);
      if (match?.[1]) {
        const resolvedGitDir = canonicalExecutionPath(path.resolve(canonicalWorkspace, match[1]));
        collectGitDirWriteDeniedTargets(resolvedGitDir, targets);
        const commonDirFile = path.join(resolvedGitDir, "commondir");
        if (fs.existsSync(commonDirFile) && fs.lstatSync(commonDirFile).isFile()) {
          const commonRel = fs.readFileSync(commonDirFile, "utf8").trim();
          if (commonRel) {
            const commonDir = canonicalExecutionPath(path.resolve(resolvedGitDir, commonRel));
            collectGitDirWriteDeniedTargets(commonDir, targets);
          }
        }
      }
    } catch {
      // Still keep the .git pointer file write-denied even if unreadable.
    }
  }
  return [...targets];
}

/** The profile covers the daemon's file operations as well as every child command. */
export function buildWorkerSandboxProfile(options: {
  writablePaths: readonly string[];
  readOnlyPaths?: readonly string[];
  executable: string;
  protectedPaths: readonly string[];
  writeDeniedPaths?: readonly string[];
  workspaceRoot?: string;
  managedScratchRoot?: string;
  network?: WorkerNetworkPolicy;
  sandboxIdentity?: { marker: string; negative: string };
}): string {
  const writablePaths = [...new Set(options.writablePaths.map(canonicalExecutionPath))];
  const readOnlyPaths = [...new Set((options.readOnlyPaths ?? []).map(canonicalExecutionPath))];
  const visiblePaths = [...new Set([...writablePaths, ...readOnlyPaths])];
  const protectedPaths = [...new Set(nativeProtectedPaths([...defaultProtectedPaths(), ...options.protectedPaths, ...applicationProtectedPaths()]).map(canonicalExecutionPath))];
  const writeDeniedPaths = [...new Set(nativeProtectedPaths(options.writeDeniedPaths ?? []).map(canonicalExecutionPath))];
  const workspaceRoot = options.workspaceRoot ? canonicalExecutionPath(options.workspaceRoot) : undefined;
  const managedScratchRoot = options.managedScratchRoot ? canonicalExecutionPath(options.managedScratchRoot) : undefined;
  const scopedException = (candidate: string, protectedPath: string) => !isApplicationPrivatePath(protectedPath) && [workspaceRoot, managedScratchRoot].some((root) => root && root !== protectedPath && inside(root, protectedPath) && inside(candidate, root));
  normalizedPorts(options.network?.localConnectPorts);
  normalizedPorts(options.network?.localListenPorts);
  for (const workspace of visiblePaths) {
    if (isApplicationPrivatePath(workspace)) throw new Error("Worker workspace overlaps protected application data");
    if (workspace === path.parse(workspace).root || workspace === canonicalExecutionPath(os.homedir())) {
      throw new Error("Worker workspace must be a project directory, not the filesystem or home root");
    }
    if (protectedPaths.some((entry) => inside(workspace, entry) && !scopedException(workspace, entry))) {
      throw new Error("Worker workspace overlaps protected Hub data");
    }
  }
  const executable = canonicalExecutionPath(options.executable);
  const protectedAncestors = new Set<string>();
  for (const entry of [...protectedPaths, ...writeDeniedPaths]) {
    for (let ancestor = path.dirname(entry); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      if (visiblePaths.some((root) => inside(ancestor, root))) protectedAncestors.add(ancestor);
    }
  }
  const ancestors = new Set<string>(["/"]);
  for (const entry of [...visiblePaths, executable]) {
    for (let current = path.dirname(entry); ; current = path.dirname(current)) {
      ancestors.add(current);
      if (current === path.dirname(current)) break;
    }
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny appleevent-send)",
    '(deny mach-lookup (global-name "com.apple.imagent") (global-name "com.apple.coreservices.appleevents"))',
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    // kern.procargs* requires denying both sysctl-read and cross-sandbox process-info* on XNU.
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))',
    ...writablePaths.map((entry) => `(allow file-read* file-write* (subpath ${quoted(entry)}))`),
    ...readOnlyPaths.map((entry) => `(allow file-read* (subpath ${quoted(entry)}))`),
    ...protectedPaths.flatMap((entry) => {
      const taskExceptions = writablePaths.filter((writable) => scopedException(writable, entry)).map((writable) => `(require-not (subpath ${quoted(writable)}))`);
      const readExceptions = [
        ...taskExceptions,
        ...readOnlyPaths.filter((readOnly) => scopedException(readOnly, entry)).map((readOnly) => `(require-not (subpath ${quoted(readOnly)}))`),
        ...[...ancestors].filter((ancestor) => inside(ancestor, entry)).map((ancestor) => `(require-not (literal ${quoted(ancestor)}))`),
        ...(inside(executable, entry) ? [`(require-not (literal ${quoted(executable)}))`] : []),
      ];
      const filter = (exceptions: string[]) => exceptions.length ? `(require-all (subpath ${quoted(entry)}) ${exceptions.join(" ")})` : `(subpath ${quoted(entry)})`;
      return [`(deny file-read* ${filter(readExceptions)})`, `(deny file-write* ${filter(taskExceptions)})`];
    }),
    ...writeDeniedPaths.map((entry) => `(deny file-write* (subpath ${quoted(entry)}))`),
    ...(process.platform === "darwin" ? [
      `(deny file-read* file-write* ${applicationContainerFilter()})`,
      `(deny file-read* file-write* ${legacyNotificationCenterFilter()})`,
    ] : []),
    // A writable ancestor cannot be renamed to move a private or write-denied entry beyond its path rule.
    ...[...protectedAncestors].map((entry) => `(deny file-write-unlink (literal ${quoted(entry)}))`),
    '(deny file-read* file-write* (subpath "/System/Volumes/Data"))',
    ...(options.network?.offline ? [
      "(deny network-outbound (remote ip))",
      '(allow network-outbound (remote ip "localhost:*"))',
    ] : []),
    '(deny network-outbound (remote unix-socket (regex #"^/private/tmp/com[.]apple[.]launchd[.][^/]+/Listeners$")))',
    '(deny mach-lookup (global-name-regex #"^kulo[.](worker|customization|unowned)[.]"))',
    ...(options.sandboxIdentity ? [
      `(allow mach-lookup (global-name ${quoted(options.sandboxIdentity.marker)}))`,
      `(deny mach-lookup (global-name ${quoted(options.sandboxIdentity.negative)}))`,
    ] : []),
  ].join("\n");
}

/**
 * Credential-isolated Seatbelt profile for user-approved (or always-allowed) host maintenance.
 * Allows writing to ordinary user-writable host paths (e.g. Homebrew, global npm/pip, ~/...)
 * while keeping credentials, keychains, private Mail/Messages stores, Kulo private state/runtime,
 * launchd SSH agent sockets, cross-sandbox kern.procargs, and AppleEvents strictly denied.
 */
export function buildHostMaintenanceSandboxProfile(options: {
  protectedPaths: readonly string[];
  sandboxIdentity?: { marker: string; negative: string };
}): string {
  const protectedPaths = [
    ...new Set(
      nativeProtectedPaths([
        ...defaultProtectedPaths(),
        ...options.protectedPaths,
        ...applicationProtectedPaths(),
      ]).map(canonicalExecutionPath),
    ),
  ];
  const protectedAncestors = new Set<string>();
  for (const entry of protectedPaths) {
    for (let ancestor = path.dirname(entry); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      protectedAncestors.add(ancestor);
    }
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny appleevent-send)",
    '(deny mach-lookup (global-name "com.apple.imagent") (global-name "com.apple.coreservices.appleevents"))',
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    ...protectedPaths.map((entry) => `(deny file-read* file-write* (subpath ${quoted(entry)}))`),
    ...(process.platform === "darwin" ? [
      `(deny file-read* file-write* ${applicationContainerFilter()})`,
      `(deny file-read* file-write* ${legacyNotificationCenterFilter()})`,
    ] : []),
    ...[...protectedAncestors].map((entry) => `(deny file-write-unlink (literal ${quoted(entry)}))`),
    '(deny file-read* file-write* (subpath "/System/Volumes/Data"))',
    '(deny network-outbound (remote unix-socket (regex #"^/private/tmp/com[.]apple[.]launchd[.][^/]+/Listeners$")))',
    '(deny mach-lookup (global-name-regex #"^kulo[.](worker|customization|unowned)[.]"))',
    ...(options.sandboxIdentity ? [
      `(allow mach-lookup (global-name ${quoted(options.sandboxIdentity.marker)}))`,
      `(deny mach-lookup (global-name ${quoted(options.sandboxIdentity.negative)}))`,
    ] : []),
  ].join("\n");
}

export function createWorkerSandbox(options: WorkerSandboxOptions): WorkerSandbox {
  if ((process.platform === "darwin" && !fs.existsSync("/usr/bin/sandbox-exec")) ||
      (process.platform === "linux" && !linuxSandboxAvailable()) ||
      !["darwin", "linux", "win32"].includes(process.platform)) {
    throw new Error("Worker execution requires a configured native OS isolation backend; unrestricted host execution is disabled.");
  }
  const workspaceDir = canonicalExecutionPath(options.workspaceDir);
  const scratchDir = options.scratchDir ? canonicalExecutionPath(options.scratchDir) : undefined;
  const protectedPaths = nativeProtectedPaths([...defaultProtectedPaths(), ...(options.protectedPaths ?? [])]);
  const writeDeniedPaths = nativeProtectedPaths([
    ...discoverGitWriteDeniedPaths(workspaceDir),
    ...(options.writeDeniedPaths ?? []),
  ]);
  const runtimePaths = [...new Set((options.runtimePaths ?? []).map(canonicalExecutionPath))];
  for (const directory of runtimePaths) {
    if (directory === path.parse(directory).root || directory === canonicalExecutionPath(os.homedir()) ||
        protectedPaths.some((entry) => inside(directory, canonicalExecutionPath(entry))) ||
        [".claude", ".gemini", ".antigravity", ".dsh", ".codex", ".grok", ".cursor", ".opencode", ".kiro", ".copilot"].some((name) => inside(directory, canonicalExecutionPath(path.join(os.homedir(), name))))) {
      throw new Error("Agent runtime code cannot expose private account or application directories");
    }
  }
  // Validate before provisioning any task directories outside the sandbox.
  const executable = localDaemon();
  const projectWritable = options.readOnly ? [] : [workspaceDir];
  const projectReadOnly = [...(options.readOnly ? [workspaceDir] : []), ...runtimePaths];
  buildWorkerSandboxProfile({ writablePaths: [...projectWritable, ...(scratchDir ? [scratchDir] : [])], readOnlyPaths: projectReadOnly, executable, protectedPaths, writeDeniedPaths, workspaceRoot: options.workspaceRoot, managedScratchRoot: options.managedScratchRoot, network: options.network });
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (scratchDir) fs.mkdirSync(scratchDir, { recursive: true });
  const temporaryDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-worker-")));
  const controlRoot = options.controlRoot ?? os.tmpdir();
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  const controlDir = fs.realpathSync(fs.mkdtempSync(path.join(controlRoot, "kulo-worker-control-")));
  fs.chmodSync(controlDir, 0o700);
  fs.writeFileSync(path.join(controlDir, "owner.json"), JSON.stringify({ ownerPid: process.pid, ownerIdentity: processFingerprint(process.pid), workspaceDir, scratchDir, projectId: options.projectId, temporaryDir, cleanupModel: process.platform === "darwin" ? "macos-seatbelt" : "os-container" }), { mode: 0o600 });
  const homeDir = path.join(temporaryDir, "home");
  const tempDir = path.join(temporaryDir, "tmp");
  fs.mkdirSync(homeDir);
  fs.mkdirSync(tempDir);
  const port = allocateWorkerPort();
  let innerCommand: readonly string[] | undefined;
  try {
    const sandboxIdentity = process.platform === "darwin" ? { marker: `kulo.worker.${randomBytes(24).toString("hex")}`, negative: `kulo.unowned.${randomBytes(24).toString("hex")}` } : undefined;
    const sandboxCleanup = sandboxIdentity ? createMacSandboxCleanupCommand(controlDir, sandboxIdentity.marker, sandboxIdentity.negative) : undefined;
    const network: WorkerNetworkPolicy = {
      localConnectPorts: [...(options.network?.localConnectPorts ?? []), port],
      localListenPorts: [...(options.network?.localListenPorts ?? []), port],
      ...(options.network?.offline ? { offline: true } : {}),
    };
    const profile = buildWorkerSandboxProfile({
      writablePaths: [...projectWritable, ...(scratchDir ? [scratchDir] : []), temporaryDir],
      readOnlyPaths: projectReadOnly,
      executable,
      protectedPaths: [...protectedPaths, controlDir],
      writeDeniedPaths,
      workspaceRoot: options.workspaceRoot,
      managedScratchRoot: options.managedScratchRoot,
      network,
      sandboxIdentity,
    });
    if (process.platform === "win32") {
      innerCommand = createWindowsSandboxCommand({ ...options, workspaceDir, temporaryDir, executable, protectedPaths: [...protectedPaths, controlDir], writeDeniedPaths, port, network });
    } else if (process.platform === "linux") {
      innerCommand = createLinuxSandboxCommand({ ...options, workspaceDir, temporaryDir, controlDir, executable, protectedPaths: [...protectedPaths, controlDir], writeDeniedPaths, port, network });
    } else {
      innerCommand = [
        "/usr/bin/env", "-i", `PATH=${workerExecutionPath([...protectedPaths, controlDir])}`,
        `HOME=${homeDir}`, `KULO_HOST_HOME=${os.homedir()}`, `TMPDIR=${tempDir}`, `PORT=${port}`, "LANG=en_US.UTF-8", "SHELL=/bin/bash",
        ...(network.offline ? [] : workerProxyEnvironment()),
        "/usr/bin/sandbox-exec", "-p", profile, executable,
      ];
    }
    let cleanupPromise: Promise<boolean> | undefined;
    const cleanup = () => cleanupPromise ??= cleanSupervisedExecution(controlDir).then((pending) => {
      if (!pending) {
        if (process.platform === "win32") cleanupWindowsSandboxCommand(innerCommand!);
        allocatedPorts.delete(port);
        fs.rmSync(temporaryDir, { recursive: true, force: true });
        fs.rmSync(controlDir, { recursive: true, force: true });
      } else {
        cleanupPromise = undefined;
      }
      return pending;
    }).catch((error: unknown) => { cleanupPromise = undefined; throw error; });
    return {
      workspaceDir,
      temporaryDir,
      port,
      command: supervisedCommand(innerCommand, controlDir, sandboxCleanup),
      cleanup,
      close: () => { void cleanup().catch((error: unknown) => console.error("[KuloEnv:cleanup]", error instanceof Error ? error.message : "Worker cleanup failed")); },
    };
  } catch (error) {
    allocatedPorts.delete(port);
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    fs.rmSync(controlDir, { recursive: true, force: true });
    if (process.platform === "win32" && innerCommand) cleanupWindowsSandboxCommand(innerCommand);
    throw error;
  }
}

let windowsIsolationCapabilities: string[] | undefined;

export function workerIsolationCapabilities(): string[] {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec") && macSandboxCleanupAvailable() ? ["worker-isolation"] : ["worker-isolation-unavailable"];
  if (process.platform === "linux") return linuxSandboxAvailable() ? ["worker-isolation", "worker-http-network"] : ["worker-isolation-unavailable"];
  if (process.platform === "win32") {
    if (windowsIsolationCapabilities) return [...windowsIsolationCapabilities];
    const command = createWindowsSandboxSetupCommand();
    let ready = false;
    try {
      const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 15_000, windowsHide: true });
      ready = !result.error && result.status === 0;
    } finally {
      try { cleanupWindowsSandboxCommand(command); }
      catch { ready = false; }
    }
    windowsIsolationCapabilities = ready ? ["worker-isolation", "worker-wfp-network"] : ["worker-isolation-unavailable", "worker-wfp-setup-required"];
    return [...windowsIsolationCapabilities];
  }
  return ["worker-isolation-unavailable"];
}
