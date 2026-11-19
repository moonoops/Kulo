import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

export function processFingerprint(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    }
    if (process.platform === "darwin") return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    if (process.platform === "win32") {
      const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() || undefined;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && !["ENOENT", "ESRCH"].includes(code)) throw error;
    if (typeof (error as { status?: number }).status === "number" || code) return undefined;
    throw error;
  }
  return undefined;
}

async function workerSupervisor(): Promise<void> {
  const fs = await import("node:fs");
  const cp = await import("node:child_process");
  const path = await import("node:path");
  const [stateFile, encodedCommand, encodedCleanup, ...arguments_] = process.argv.slice(1);
  if (!stateFile || !encodedCommand) process.exit(2);
  const command = JSON.parse(encodedCommand) as string[];
  const sandboxCleanup = JSON.parse(encodedCleanup ?? "[]") as string[];
  const fingerprint = (pid: number) => {
    if (process.platform === "linux") { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]; }
    if (process.platform === "darwin") return cp.execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return cp.execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  };
  const identity = fingerprint(process.pid);
  let childIdentity: string | undefined;
  let cleanupFailure: { exitCode: number | null; signal: string | null; stderr: string } | undefined;
  const store = (state: string, childPid?: number) => {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ supervisorPid: process.pid, supervisorIdentity: identity, childPid, childIdentity, state, ...(sandboxCleanup.length ? { sandboxCleanup } : {}), ...(cleanupFailure ? { cleanupFailure } : {}) }), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  };
  // This must succeed before a process is spawned: cleanup may already have revoked the launch directory.
  store("starting");
  const child = cp.spawn(command[0]!, [...command.slice(1), ...arguments_], {
    stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let stopping = false;
  let exited = false;
  const signal = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    if (sandboxCleanup.length) {
      if (child.exitCode === null && child.signalCode === null && childIdentity) {
        try { if (fingerprint(child.pid) === childIdentity) child.kill(kind); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH" && typeof (error as { status?: number }).status !== "number") throw error;
        }
      }
      return;
    }
    try { process.platform === "win32" ? child.kill(kind) : process.kill(-child.pid, kind); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signal("SIGTERM");
    const kill = setTimeout(() => signal("SIGKILL"), 500);
    kill.unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  process.stdout.on("error", stop);
  child.once("spawn", async () => {
    if (child.pid) {
      try { childIdentity = fingerprint(child.pid); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH" && typeof (error as { status?: number }).status !== "number") throw error;
      }
    }
    if (sandboxCleanup.length && child.pid) {
      const until = Date.now() + 3_000;
      let verified = false;
      while (Date.now() < until && !exited && !stopping) {
        const result = cp.spawnSync(sandboxCleanup[0]!, ["--verify", String(child.pid), ...sandboxCleanup.slice(2)], { timeout: 1_000, stdio: "ignore" });
        if (!result.error && result.status === 0) { verified = true; break; }
        if (result.error || result.status !== 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!verified) { store("cleanup_pending", child.pid); stop(); return; }
    }
    store("running", child.pid);
    process.stdin.pipe(child.stdin);
  });
  child.stdin.on("error", stop);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", () => {
    store("stopped", child.pid);
    process.exit(1);
  });
  child.once("close", async (code) => {
    if (exited) return;
    exited = true;
    signal("SIGKILL");
    let pending = false;
    if (process.platform !== "win32" && child.pid && !sandboxCleanup.length) {
      const until = Date.now() + 1_500;
      while (Date.now() < until) {
        try { process.kill(-child.pid, 0); pending = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          pending = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    if (sandboxCleanup.length) {
      const result = cp.spawnSync(sandboxCleanup[0]!, sandboxCleanup.slice(1), { timeout: 7_000, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
      if (result.error || result.status !== 0) cleanupFailure = { exitCode: result.status, signal: result.signal, stderr: String(result.stderr ?? "").slice(0, 2000) };
      pending = pending || Boolean(result.error || result.status !== 0);
    }
    store(pending ? "cleanup_pending" : "stopped", child.pid);
    process.exit(code ?? 1);
  });
}

export function supervisedCommand(command: readonly string[], controlDirectory: string, sandboxCleanup?: readonly string[]): readonly string[] {
  return [process.execPath, "--input-type=module", "-e", standaloneFunctionSource(workerSupervisor), path.join(controlDirectory, "execution.json"), JSON.stringify(command), JSON.stringify(sandboxCleanup ?? [])];
}

export function standaloneFunctionSource(body: () => Promise<void>): string {
  // tsx/esbuild can insert the name-preservation helper into nested function expressions.
  return `const __name = (value) => value; const __vite_ssr_dynamic_import__ = (specifier) => import(specifier); (${body.toString()})()`;
}

export async function cleanSupervisedExecution(controlDirectory: string): Promise<boolean> {
  const stateFile = path.join(controlDirectory, "execution.json");
  if (!fs.existsSync(stateFile)) return false;
  let state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { supervisorPid?: number; supervisorIdentity?: string; childPid?: number; childIdentity?: string; state: string; sandboxCleanup?: string[] };
  if (state.sandboxCleanup) {
    const cleanup = state.sandboxCleanup;
    if (cleanup.length !== 4 || cleanup[0] !== path.join(fs.realpathSync(controlDirectory), "macos-worker-cleanup") || cleanup[1] !== "--cleanup" || cleanup.some((value) => typeof value !== "string")) throw new Error("Invalid sandbox cleanup receipt");
    const supervisorActive = () => {
      if (!state.supervisorPid || !state.supervisorIdentity || processFingerprint(state.supervisorPid) !== state.supervisorIdentity) return false;
      try { return !execFileSync("/bin/ps", ["-p", String(state.supervisorPid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z"); }
      catch (error) { if ((error as { status?: number }).status === 1 || (error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    if (supervisorActive()) {
      try { process.kill(state.supervisorPid!, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (!fs.existsSync(cleanup[0]!)) return true;
    const result = await new Promise<boolean>((resolve, reject) => {
      const child = execFile(cleanup[0]!, cleanup.slice(1), { timeout: 7_000 }, (error, _stdout, stderr) => {
        if (error && fs.existsSync(controlDirectory)) {
          try { fs.writeFileSync(path.join(controlDirectory, "cleanup-error.json"), JSON.stringify({ code: error.code, signal: (error as { signal?: string }).signal, stderr: stderr.slice(0, 2000) }), { mode: 0o600 }); }
          catch (writeError) { reject(writeError); return; }
        }
        if (error && typeof (error as { code?: unknown }).code !== "number" && !(error as { killed?: boolean }).killed) reject(error);
        else resolve(Boolean(error));
      });
      child.stdin?.end();
    });
    if (result) return true;
    const until = Date.now() + 2_500;
    while (supervisorActive() && Date.now() < until) {
      if (!fs.existsSync(stateFile)) return false;
      state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as typeof state;
      if (state.state === "stopped") return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return supervisorActive();
  }
  if (state.state === "stopped") return false;
  if (state.state === "cleanup_pending" && process.platform !== "win32" && state.childPid) {
    try { process.kill(-state.childPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }
  if (state.supervisorPid && Number.isSafeInteger(state.supervisorPid) && state.supervisorPid > 0) {
    if (!state.supervisorIdentity || processFingerprint(state.supervisorPid) !== state.supervisorIdentity) {
      if (!state.childPid || !Number.isSafeInteger(state.childPid) || state.childPid < 1) return true;
      const alive = () => {
        try { process.kill(process.platform === "win32" ? state.childPid! : -state.childPid!, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      };
      if (!alive()) return false;
      // A reused PID is never authority to signal another process or release its directory fence.
      if (!state.childIdentity || processFingerprint(state.childPid) !== state.childIdentity) return true;
      const target = process.platform === "win32" ? state.childPid : -state.childPid;
      try { process.kill(target, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (alive()) {
        // Only escalate while the group leader still has the recorded process identity.
        if (processFingerprint(state.childPid) !== state.childIdentity) return true;
        try { process.kill(target, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      const until = Date.now() + 2_000;
      while (alive() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 30));
      return alive();
    }
    try { process.kill(state.supervisorPid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  const until = Date.now() + 2_500;
  while (Date.now() < until) {
    if (!fs.existsSync(stateFile)) return false;
    state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as typeof state;
    if (state.state === "stopped") return false;
    if (state.state === "cleanup_pending") return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return true;
}

interface RecordedExecution {
  ownerPid: number;
  ownerIdentity?: string;
  workspaceDir: string;
  scratchDir?: string;
  projectId?: string;
  temporaryDir: string;
  cleanupModel?: string;
}

function recordedExecutions(controlRoot: string): Array<{ directory: string; scope: RecordedExecution }> {
  if (!fs.existsSync(controlRoot)) return [];
  const records: Array<{ directory: string; scope: RecordedExecution }> = [];
  for (const entry of fs.readdirSync(controlRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("moco-worker-control-")) continue;
    const directory = path.join(controlRoot, entry.name);
    const owner = path.join(directory, "owner.json");
    if (!fs.existsSync(owner)) continue;
    const scope = JSON.parse(fs.readFileSync(owner, "utf8")) as RecordedExecution;
    if (!Number.isSafeInteger(scope.ownerPid) || scope.ownerPid < 1 || !path.isAbsolute(scope.workspaceDir) || !path.isAbsolute(scope.temporaryDir)) throw new Error("Invalid Worker execution receipt");
    records.push({ directory, scope });
  }
  return records;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export function hasOrphanedExecution(controlRoot: string, workspaceDir: string): boolean {
  const identity = processFingerprint(process.pid);
  return recordedExecutions(controlRoot).some(({ directory, scope }) => scope.workspaceDir === workspaceDir && (scope.ownerPid !== process.pid || scope.ownerIdentity && scope.ownerIdentity !== identity || fs.existsSync(path.join(directory, "execution.json")) && JSON.parse(fs.readFileSync(path.join(directory, "execution.json"), "utf8")).state === "cleanup_pending"));
}

/** Reconcile receipts before granting a directory to a new process after an Env or Hub restart. */
export async function cleanupRecordedExecutions(controlRoot: string, select?: { workspaceDir?: string; scratchDir?: string; projectId?: string }): Promise<boolean> {
  let pending = false;
  for (const { directory, scope } of recordedExecutions(controlRoot)) {
    if (select?.workspaceDir !== undefined && scope.workspaceDir !== select.workspaceDir) continue;
    if (select && "scratchDir" in select && scope.scratchDir !== select.scratchDir) continue;
    if (select?.projectId !== undefined && scope.projectId !== select.projectId) continue;
    const owned = scope.ownerPid === process.pid && (!scope.ownerIdentity || processFingerprint(process.pid) === scope.ownerIdentity);
    if (owned && !select) continue;
    if (!owned && processExists(scope.ownerPid) && (!scope.ownerIdentity || processFingerprint(scope.ownerPid) === scope.ownerIdentity)) { pending = true; continue; }
    const executionFile = path.join(directory, "execution.json");
    if (process.platform === "darwin" && scope.cleanupModel !== "process-group" && fs.existsSync(executionFile) && !JSON.parse(fs.readFileSync(executionFile, "utf8")).sandboxCleanup) {
      // Older receipts cannot prove that independently sessioned descendants have stopped.
      pending = true;
      continue;
    }
    if (await cleanSupervisedExecution(directory)) { pending = true; continue; }
    // Receipts may only name the temporary workspace created by createWorkerSandbox.
    if (path.basename(scope.temporaryDir).startsWith("moco-worker-") && !scope.workspaceDir.startsWith(`${scope.temporaryDir}${path.sep}`) && scope.workspaceDir !== scope.temporaryDir) {
      fs.rmSync(scope.temporaryDir, { recursive: true, force: true });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return pending;
}
