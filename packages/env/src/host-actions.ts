import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  HOST_ACTION_MAX_RESULT,
  classifyShellSafetyFloor,
  isHostActionRequest,
  redactSecrets,
  redactSensitiveText,
  type HostActionRequest,
  type HostActionResult,
  type HostActionStepResult,
  type HostPathCheck,
  type HostPortEntry,
  type HostProcessEntry,
} from "@kulo/protocol";
import {
  buildHostMaintenanceSandboxProfile,
  canonicalExecutionPath,
  defaultProtectedPaths,
  hasWorkerBasicOrFullIsolation,
  isApplicationPrivatePath,
  nativeProtectedPaths,
  workerExecutionPath,
  workerIsolationCapabilities,
  workerProxyEnvironment,
} from "./isolation.js";
import { createMacSandboxCleanupCommand, macSandboxCleanupAvailable } from "./isolation-macos.js";
import { createLinuxHostMaintenanceCommand, linuxSandboxAvailable } from "./isolation-linux.js";
import { cleanupWindowsSandboxCommand, createWindowsSandboxCommand } from "./isolation-windows.js";
import { removeReadonlyTreeSync, safeChmodSync } from "./platform-fs.js";
import { cleanSupervisedExecution, processFingerprint, supervisedCommand } from "./worker-supervisor.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const INSPECT_TIMEOUT_MS = 10_000;

const PRIVILEGE_ESCALATION_PATTERNS: readonly RegExp[] = [
  /(?:^|[;&|`(]\s*)(?:\/usr\/bin\/)?sudo(?:\s|$)/,
  /(?:^|[;&|`(]\s*)(?:\/usr\/bin\/)?doas(?:\s|$)/,
  /(?:^|[;&|`(]\s*)(?:\/usr\/bin\/)?pkexec(?:\s|$)/,
  /(?:^|[;&|`(]\s*)(?:\/usr\/bin\/)?su(?:\s+|$)/,
  /with\s+administrator\s+privileges/i,
];

function sanitizeOutput(text: string): string {
  return redactSensitiveText(redactSecrets(text));
}

function inside(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function expandHostPath(raw: string, homeDir = os.homedir()): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

export function validateHostMaintenanceCommands(commands: readonly string[]): void {
  for (const command of commands) {
    const floor = classifyShellSafetyFloor(command);
    if (floor.verdict === "block") {
      throw new Error(`已拦截高危系统命令："${command.slice(0, 120)}"`);
    }
    for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error("本机运维操作以当前登录用户权限运行，不支持 sudo / 管理员提权；如需管理员权限，请由用户在终端手动执行。");
      }
    }
  }
}

function resolveProtectedCanonical(extraProtected: readonly string[]): string[] {
  const raw = nativeProtectedPaths([...defaultProtectedPaths(), ...extraProtected]);
  const out = new Set<string>();
  for (const entry of raw) {
    try {
      out.add(canonicalExecutionPath(entry));
    } catch {
      // Skip unresolvable paths
    }
  }
  return [...out];
}

function isProtectedPath(candidate: string, canonicalProtected: readonly string[]): boolean {
  let actual: string;
  try {
    actual = canonicalExecutionPath(candidate);
  } catch {
    return true;
  }
  if (process.platform === "darwin" && (actual === "/System/Volumes/Data" || actual.startsWith("/System/Volumes/Data/"))) {
    return true;
  }
  if (isApplicationPrivatePath(actual)) return true;
  return canonicalProtected.some((blocked) => inside(actual, blocked));
}

function parsePosixProcesses(stdout: string, filter: string | undefined, limit: number): HostProcessEntry[] {
  const needle = filter?.trim().toLowerCase();
  const entries: HostProcessEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpu = match[3]!;
    const mem = match[4]!;
    const rawArgs = match[5]!.trim();
    const firstToken = rawArgs.split(/\s+/, 1)[0] ?? rawArgs;
    const name = path.basename(firstToken).slice(0, 120);
    const command = sanitizeOutput(rawArgs).slice(0, 300);
    if (needle && !name.toLowerCase().includes(needle) && !command.toLowerCase().includes(needle) && String(pid) !== needle) {
      continue;
    }
    entries.push({ pid, ppid, cpu, mem, name, command });
    if (entries.length >= limit) break;
  }
  return entries;
}

function parseLsofListeningPorts(stdout: string, filter: string | undefined, limit: number): HostPortEntry[] {
  const needle = filter?.trim().toLowerCase();
  const entries: HostPortEntry[] = [];
  const seen = new Set<string>();
  let currentPid: number | undefined;
  let currentCommand: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number(value);
      currentPid = Number.isInteger(parsed) ? parsed : undefined;
      currentCommand = undefined;
    } else if (tag === "c") {
      currentCommand = value.slice(0, 120);
    } else if (tag === "n") {
      const colonIdx = value.lastIndexOf(":");
      if (colonIdx <= 0) continue;
      const localAddress = value.slice(0, colonIdx);
      const port = Number(value.slice(colonIdx + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const key = `tcp|${localAddress}|${port}|${currentPid ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        needle &&
        !String(port).includes(needle) &&
        !localAddress.toLowerCase().includes(needle) &&
        !(currentCommand ?? "").toLowerCase().includes(needle) &&
        String(currentPid ?? "") !== needle
      ) {
        continue;
      }
      entries.push({
        protocol: "tcp",
        localAddress,
        port,
        ...(currentPid !== undefined ? { pid: currentPid } : {}),
        ...(currentCommand ? { processName: currentCommand } : {}),
      });
      if (entries.length >= limit) break;
    }
  }
  return entries;
}

function parseSsListeningPorts(stdout: string, filter: string | undefined, limit: number): HostPortEntry[] {
  const needle = filter?.trim().toLowerCase();
  const entries: HostPortEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Netid") || line.startsWith("State")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const proto = parts[0]!.toLowerCase().startsWith("udp") ? "udp" : "tcp";
    const localCol = parts[0]!.toLowerCase().startsWith("tcp") || parts[0]!.toLowerCase().startsWith("udp") ? parts[4]! : parts[3]!;
    const colonIdx = localCol.lastIndexOf(":");
    if (colonIdx <= 0) continue;
    const localAddress = localCol.slice(0, colonIdx);
    const port = Number(localCol.slice(colonIdx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const procMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    const processName = procMatch?.[1]?.slice(0, 120);
    const pid = procMatch?.[2] ? Number(procMatch[2]) : undefined;
    const key = `${proto}|${localAddress}|${port}|${pid ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      needle &&
      !String(port).includes(needle) &&
      !localAddress.toLowerCase().includes(needle) &&
      !(processName ?? "").toLowerCase().includes(needle) &&
      String(pid ?? "") !== needle
    ) {
      continue;
    }
    entries.push({
      protocol: proto,
      localAddress,
      port,
      ...(pid !== undefined ? { pid } : {}),
      ...(processName ? { processName } : {}),
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

function parseWindowsNetstatPorts(stdout: string, filter: string | undefined, limit: number): HostPortEntry[] {
  const needle = filter?.trim().toLowerCase();
  const entries: HostPortEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("TCP")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;
    const localCol = parts[1]!;
    const colonIdx = localCol.lastIndexOf(":");
    if (colonIdx <= 0) continue;
    const localAddress = localCol.slice(0, colonIdx);
    const port = Number(localCol.slice(colonIdx + 1));
    const pid = Number(parts[4]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const key = `tcp|${localAddress}|${port}|${Number.isInteger(pid) ? pid : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (needle && !String(port).includes(needle) && !localAddress.toLowerCase().includes(needle) && String(pid) !== needle) {
      continue;
    }
    entries.push({
      protocol: "tcp",
      localAddress,
      port,
      ...(Number.isInteger(pid) ? { pid } : {}),
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

export class HostActionService {
  readonly #controlRoot: string;
  readonly #getProtectedPaths: () => readonly string[];
  readonly #activeControllers = new Set<AbortController>();

  constructor(options: { controlRoot: string; getProtectedPaths: () => readonly string[] }) {
    this.#controlRoot = path.resolve(options.controlRoot);
    this.#getProtectedPaths = options.getProtectedPaths;
  }

  async suspend(): Promise<void> {
    for (const controller of this.#activeControllers) {
      controller.abort();
    }
    this.#activeControllers.clear();
  }

  async execute(request: HostActionRequest, signal?: AbortSignal): Promise<HostActionResult> {
    if (!isHostActionRequest(request)) {
      throw new Error("Invalid host action request");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#activeControllers.add(controller);
    try {
      if (request.kind === "inspect") {
        return await this.#inspect(request, controller.signal);
      }
      return await this.#run(request, controller.signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#activeControllers.delete(controller);
    }
  }

  async #inspectProcesses(filter: string | undefined, limit: number, signal: AbortSignal): Promise<HostProcessEntry[]> {
    if (process.platform === "win32") {
      const psScript = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
      const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", psScript], {
        timeout: INSPECT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout || "[]") as Array<{ ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string }> | { ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string };
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const needle = filter?.trim().toLowerCase();
      const entries: HostProcessEntry[] = [];
      for (const item of list) {
        if (!item || typeof item.ProcessId !== "number") continue;
        const name = String(item.Name ?? "").slice(0, 120);
        const command = sanitizeOutput(String(item.CommandLine ?? name)).slice(0, 300);
        if (needle && !name.toLowerCase().includes(needle) && !command.toLowerCase().includes(needle) && String(item.ProcessId) !== needle) continue;
        entries.push({
          pid: item.ProcessId,
          ...(typeof item.ParentProcessId === "number" ? { ppid: item.ParentProcessId } : {}),
          name,
          command,
        });
        if (entries.length >= limit) break;
      }
      return entries;
    }
    const psBin = fs.existsSync("/bin/ps") ? "/bin/ps" : "ps";
    const { stdout } = await execFileAsync(psBin, ["-axo", "pid=,ppid=,pcpu=,pmem=,args="], {
      timeout: INSPECT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    return parsePosixProcesses(stdout, filter, limit);
  }

  async #inspectPorts(filter: string | undefined, limit: number, signal: AbortSignal): Promise<HostPortEntry[]> {
    if (process.platform === "darwin") {
      try {
        const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], {
          timeout: INSPECT_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          signal,
        });
        return parseLsofListeningPorts(stdout, filter, limit);
      } catch (error) {
        const stdout = (error as { stdout?: string })?.stdout;
        if (typeof stdout === "string" && stdout.trim()) {
          return parseLsofListeningPorts(stdout, filter, limit);
        }
        return [];
      }
    }
    if (process.platform === "linux") {
      try {
        const { stdout } = await execFileAsync("ss", ["-tlnp"], {
          timeout: INSPECT_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          signal,
        });
        return parseSsListeningPorts(stdout, filter, limit);
      } catch {
        return [];
      }
    }
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("netstat.exe", ["-ano"], {
          timeout: INSPECT_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          signal,
          windowsHide: true,
        });
        return parseWindowsNetstatPorts(stdout, filter, limit);
      } catch {
        return [];
      }
    }
    return [];
  }

  #inspectPaths(rawPaths: readonly string[], canonicalProtected: readonly string[]): HostPathCheck[] {
    const homeDir = os.homedir();
    const results: HostPathCheck[] = [];
    for (const raw of rawPaths) {
      const expanded = expandHostPath(raw, homeDir);
      if (!path.isAbsolute(expanded)) {
        results.push({ path: raw, status: "error" });
        continue;
      }
      if (isProtectedPath(expanded, canonicalProtected)) {
        results.push({ path: raw, status: "denied" });
        continue;
      }
      try {
        const lstat = fs.lstatSync(expanded);
        const resolved = canonicalExecutionPath(expanded);
        if (isProtectedPath(resolved, canonicalProtected)) {
          results.push({ path: raw, status: "denied" });
          continue;
        }
        if (lstat.isSymbolicLink()) {
          results.push({ path: raw, resolvedPath: resolved, status: "symlink" });
        } else if (lstat.isDirectory()) {
          const allEntries = fs.readdirSync(resolved)
            .filter((name) => !isProtectedPath(path.join(resolved, name), canonicalProtected))
            .sort((a, b) => a.localeCompare(b));
          const maxEntries = 40;
          results.push({
            path: raw,
            resolvedPath: resolved,
            status: "directory",
            entries: allEntries.slice(0, maxEntries),
            ...(allEntries.length > maxEntries ? { truncated: true } : {}),
          });
        } else {
          results.push({ path: raw, resolvedPath: resolved, status: "file" });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          results.push({ path: raw, status: "missing" });
        } else if (code === "EACCES" || code === "EPERM") {
          results.push({ path: raw, status: "denied" });
        } else {
          results.push({ path: raw, status: "error" });
        }
      }
    }
    return results;
  }

  async #inspect(
    request: Extract<HostActionRequest, { kind: "inspect" }>,
    signal: AbortSignal,
  ): Promise<HostActionResult> {
    const canonicalProtected = resolveProtectedCanonical(this.#getProtectedPaths());
    const limit = request.limit ?? (request.scope === "summary" ? 40 : 80);
    const includeProcesses = request.scope === "processes" || request.scope === "summary";
    const includePorts = request.scope === "ports" || request.scope === "summary";
    const [processes, ports] = await Promise.all([
      includeProcesses ? this.#inspectProcesses(request.filter, limit, signal) : Promise.resolve(undefined),
      includePorts ? this.#inspectPorts(request.filter, limit, signal) : Promise.resolve(undefined),
    ]);
    const paths = request.paths?.length ? this.#inspectPaths(request.paths, canonicalProtected) : undefined;
    return {
      kind: "inspect",
      platform: process.platform,
      ok: true,
      homeDir: os.homedir(),
      hostname: os.hostname(),
      arch: process.arch,
      ...(processes ? { processes } : {}),
      ...(ports ? { ports } : {}),
      ...(paths ? { paths } : {}),
    };
  }

  async #run(
    request: Extract<HostActionRequest, { kind: "run" }>,
    signal: AbortSignal,
  ): Promise<HostActionResult> {
    validateHostMaintenanceCommands(request.commands);
    const protectedPaths = nativeProtectedPaths([...defaultProtectedPaths(), ...this.#getProtectedPaths()]);
    const canonicalProtected = resolveProtectedCanonical(protectedPaths);
    const homeDir = os.homedir();
    const rawCwd = request.cwd ? expandHostPath(request.cwd, homeDir) : homeDir;
    if (!path.isAbsolute(rawCwd)) {
      throw new Error("工作目录必须为绝对路径。");
    }
    if (isProtectedPath(rawCwd, canonicalProtected)) {
      throw new Error("工作目录位于受保护的凭据或系统私有路径内，已拒绝执行。");
    }
    const cwd = canonicalExecutionPath(rawCwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`工作目录不存在：${rawCwd}`);
    }

    if (process.platform === "darwin" && (!fs.existsSync("/usr/bin/sandbox-exec") || !macSandboxCleanupAvailable())) {
      throw new Error("当前 macOS 设备缺少原生沙箱隔离后端，拒绝无隔离执行本机运维命令。");
    }
    if (process.platform === "linux" && !linuxSandboxAvailable()) {
      throw new Error("当前 Linux 设备缺少 bubblewrap 原生沙箱后端，拒绝无隔离执行本机运维命令。");
    }
    if (process.platform === "win32" && !hasWorkerBasicOrFullIsolation(workerIsolationCapabilities())) {
      throw new Error("当前 Windows 设备缺少原生沙箱隔离后端，拒绝无隔离执行本机运维命令。");
    }

    const totalTimeoutMs = request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const deadline = Date.now() + totalTimeoutMs;
    const steps: HostActionStepResult[] = [];
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let lastExitCode = 0;

    for (const command of request.commands) {
      if (signal.aborted) {
        throw new Error("本机运维操作已取消。");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`本机运维操作超时（>${Math.round(totalTimeoutMs / 1000)}s）。`);
      }
      const step = await this.#runSingleStep({
        command,
        cwd,
        protectedPaths,
        timeoutMs: remainingMs,
        signal,
      });
      steps.push({ command, exitCode: step.exitCode });
      lastExitCode = step.exitCode;
      if (step.stdout) {
        const prefix = request.commands.length > 1 ? `$ ${command}\n` : "";
        const next = `${stdout}${stdout ? "\n" : ""}${prefix}${step.stdout}`;
        if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
          stdout = next.slice(0, MAX_OUTPUT_BYTES);
          truncated = true;
        } else {
          stdout = next;
        }
      }
      if (step.stderr) {
        const next = `${stderr}${stderr ? "\n" : ""}${step.stderr}`;
        if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
          stderr = next.slice(0, MAX_OUTPUT_BYTES);
          truncated = true;
        } else {
          stderr = next;
        }
      }
      if (step.truncated) truncated = true;
      if (step.exitCode !== 0) break;
    }

    const redactedStdout = sanitizeOutput(stdout);
    const redactedStderr = sanitizeOutput(stderr);
    let result: HostActionResult = {
      kind: "run",
      platform: process.platform,
      ok: lastExitCode === 0,
      exitCode: lastExitCode,
      stdout: redactedStdout,
      stderr: redactedStderr,
      ...(truncated ? { truncated: true } : {}),
      steps,
      ...(lastExitCode !== 0 ? { error: `命令退出码 ${lastExitCode}` } : {}),
    };
    if (JSON.stringify(result).length > HOST_ACTION_MAX_RESULT) {
      result = {
        ...result,
        stdout: redactedStdout.slice(0, 48_000),
        stderr: redactedStderr.slice(0, 24_000),
        truncated: true,
      };
    }
    return result;
  }

  async #runSingleStep(params: {
    command: string;
    cwd: string;
    protectedPaths: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
    fs.mkdirSync(this.#controlRoot, { recursive: true, mode: 0o700 });
    const controlDir = fs.realpathSync(fs.mkdtempSync(path.join(this.#controlRoot, "kulo-host-action-")));
    safeChmodSync(controlDir, 0o700);
    let sandboxTempDir: string | undefined;
    let windowsSandboxCmd: readonly string[] | undefined;

    try {
      if (process.platform === "win32") {
        sandboxTempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-host-action-tmp-")));
      }
      fs.writeFileSync(
        path.join(controlDir, "owner.json"),
        JSON.stringify({
          ownerPid: process.pid,
          ownerIdentity: processFingerprint(process.pid),
          workspaceDir: params.cwd,
          temporaryDir: sandboxTempDir ?? controlDir,
          cleanupModel: process.platform === "darwin" ? "macos-seatbelt" : "os-container",
        }),
        { mode: 0o600 },
      );

      const allProtected = [...params.protectedPaths, controlDir];
      const homeDir = os.homedir();
      const pathEnv = workerExecutionPath(allProtected);
      const proxyEnv = workerProxyEnvironment();

      let wrappedCommand: readonly string[];
      if (process.platform === "darwin") {
        const sandboxIdentity = {
          marker: `kulo.worker.${randomBytes(24).toString("hex")}`,
          negative: `kulo.unowned.${randomBytes(24).toString("hex")}`,
        };
        const sandboxCleanup = createMacSandboxCleanupCommand(controlDir, sandboxIdentity.marker, sandboxIdentity.negative);
        const profile = buildHostMaintenanceSandboxProfile({
          protectedPaths: allProtected,
          sandboxIdentity,
        });
        const innerCommand: readonly string[] = [
          "/usr/bin/env",
          "-i",
          `PATH=${pathEnv}`,
          `HOME=${homeDir}`,
          `KULO_HOST_HOME=${homeDir}`,
          `TMPDIR=${os.tmpdir()}`,
          `USER=${os.userInfo().username}`,
          "LANG=en_US.UTF-8",
          "SHELL=/bin/bash",
          ...proxyEnv,
          "/usr/bin/sandbox-exec",
          "-p",
          profile,
          "/bin/bash",
          "-c",
          params.command,
        ];
        wrappedCommand = supervisedCommand(innerCommand, controlDir, sandboxCleanup);
      } else if (process.platform === "linux") {
        const innerCommand = createLinuxHostMaintenanceCommand({
          cwd: params.cwd,
          controlDir,
          protectedPaths: allProtected,
          pathEnv,
          proxyEnv,
          command: params.command,
        });
        wrappedCommand = supervisedCommand(innerCommand, controlDir);
      } else {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const isolatedTemp = sandboxTempDir!;
        const sandboxWorkspace = params.cwd.toLowerCase() === homeDir.toLowerCase() ? isolatedTemp : params.cwd;
        windowsSandboxCmd = createWindowsSandboxCommand({
          workspaceDir: sandboxWorkspace,
          temporaryDir: isolatedTemp,
          executable: powershell,
          protectedPaths: allProtected,
          port: 1,
          networkBackend: "basic",
        });
        const innerCommand = [...windowsSandboxCmd, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", params.command];
        wrappedCommand = supervisedCommand(innerCommand, controlDir);
      }

      return await new Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>((resolve, reject) => {
        const [exe, ...args] = wrappedCommand;
        const child = spawn(exe!, args, {
          cwd: params.cwd,
          // Keep stdin piped open until completion/termination: worker-supervisor watches stdin EOF
          // as a parent-death signal and kills the supervised child group immediately on /dev/null EOF.
          stdio: ["pipe", "pipe", "pipe"],
          env:
            process.platform === "win32"
              ? {
                  PATH: `${path.dirname(process.execPath)};${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0`,
                  USERPROFILE: homeDir,
                  HOME: homeDir,
                  KULO_HOST_HOME: homeDir,
                  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
                  WINDIR: process.env.WINDIR ?? "C:\\Windows",
                  TEMP: os.tmpdir(),
                  TMP: os.tmpdir(),
                  ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
                }
              : {
                  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                  HOME: homeDir,
                  TMPDIR: os.tmpdir(),
                  LANG: "en_US.UTF-8",
                },
          windowsHide: true,
        });

        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let truncated = false;
        let settled = false;
        let timedOut = false;

        child.stdin?.on("error", () => {
          // Ignore EPIPE when the supervised command exits quickly.
        });

        const terminate = () => {
          try {
            child.stdin?.end();
          } catch {
            // ignore
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 500).unref();
        };

        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, params.timeoutMs);
        timer.unref();

        const onAbort = () => terminate();
        params.signal.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (chunk: Buffer) => {
          if (outBytes >= MAX_OUTPUT_BYTES) {
            truncated = true;
            return;
          }
          const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - outBytes);
          outChunks.push(slice);
          outBytes += slice.byteLength;
          if (slice.byteLength < chunk.byteLength) truncated = true;
        });

        child.stderr.on("data", (chunk: Buffer) => {
          if (errBytes >= MAX_OUTPUT_BYTES) {
            truncated = true;
            return;
          }
          const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - errBytes);
          errChunks.push(slice);
          errBytes += slice.byteLength;
          if (slice.byteLength < chunk.byteLength) truncated = true;
        });

        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          params.signal.removeEventListener("abort", onAbort);
          try {
            child.stdin?.destroy();
          } catch {
            // ignore
          }
          reject(error);
        });

        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          params.signal.removeEventListener("abort", onAbort);
          try {
            child.stdin?.destroy();
          } catch {
            // ignore
          }
          if (timedOut) {
            reject(new Error("本机运维命令执行超时。"));
            return;
          }
          if (params.signal.aborted) {
            reject(new Error("本机运维操作已取消。"));
            return;
          }
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(outChunks).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
            truncated,
          });
        });
      });
    } finally {
      const pending = await cleanSupervisedExecution(controlDir).catch(() => true);
      if (windowsSandboxCmd) {
        try { cleanupWindowsSandboxCommand(windowsSandboxCmd); } catch { /* retain native cleanup helper for retry */ }
      }
      if (!pending) {
        if (sandboxTempDir) {
          try { removeReadonlyTreeSync(sandboxTempDir); } catch { /* best-effort */ }
        }
        removeReadonlyTreeSync(controlDir);
      }
    }
  }
}
