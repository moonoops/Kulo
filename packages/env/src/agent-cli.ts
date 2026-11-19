import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface AgentCliInvocation {
  tool: "agent-browser" | "agent-desktop";
  args: readonly string[];
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type AgentCliRunner = (invocation: AgentCliInvocation) => Promise<unknown>;

export class AgentCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AgentCliError"; }
}

const MAX_OUTPUT = 1024 * 1024;
const require = createRequire(import.meta.url);

function command(invocation: AgentCliInvocation): { executable: string; args: string[] } {
  const variable = invocation.tool === "agent-browser" ? "MOCO_AGENT_BROWSER_PATH" : "MOCO_AGENT_DESKTOP_PATH";
  const override = invocation.env?.[variable] ?? process.env[variable];
  let executable: string;
  if (override) {
    if (!path.isAbsolute(override)) throw new AgentCliError("CLI_CONFIGURATION", `${variable} must be an absolute executable path`);
    executable = override;
  } else {
    let manifest: string;
    try { manifest = require.resolve(`${invocation.tool}/package.json`); }
    catch { throw new AgentCliError("CLI_NOT_INSTALLED", `${invocation.tool} is not installed on this Env`); }
    const packageDirectory = path.dirname(manifest);
    const metadata = JSON.parse(fs.readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
    const entry = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[invocation.tool];
    if (!entry) throw new AgentCliError("CLI_CONFIGURATION", `${invocation.tool} has no executable entry`);
    executable = path.resolve(packageDirectory, entry);
    const relative = path.relative(packageDirectory, executable);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new AgentCliError("CLI_CONFIGURATION", `${invocation.tool} has an invalid executable entry`);
  }
  let header: string;
  try {
    const descriptor = fs.openSync(executable, "r");
    try {
      const bytes = Buffer.alloc(128);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      header = bytes.subarray(0, length).toString("utf8");
    } finally { fs.closeSync(descriptor); }
  } catch { throw new AgentCliError("CLI_NOT_INSTALLED", `${invocation.tool} executable is unavailable on this Env`); }
  // npm installs may keep a Node launcher or link the entry directly to a native binary.
  const nodeLauncher = /^#![^\n]*\bnode(?:\s|$)/.test(header) || !header.startsWith("MZ") && /\.(?:c?js|mjs)$/.test(executable) && !header.includes("\0");
  return nodeLauncher
    ? { executable: process.execPath, args: [executable, ...invocation.args] }
    : { executable, args: [...invocation.args] };
}

function kill(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.windir;
    const taskkill = root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe";
    const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { child.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

export async function runAgentCli(invocation: AgentCliInvocation): Promise<unknown> {
  if (invocation.signal?.aborted) throw new AgentCliError("CLI_ABORTED", `${invocation.tool} operation was cancelled`);
  if (!Number.isSafeInteger(invocation.timeoutMs ?? 30_000) || (invocation.timeoutMs ?? 30_000) < 1 || (invocation.timeoutMs ?? 30_000) > 180_000) {
    throw new AgentCliError("CLI_CONFIGURATION", "Invalid native tool timeout");
  }
  const selected = command(invocation);
  return new Promise((resolve, reject) => {
    const child = spawn(selected.executable, selected.args, {
      cwd: invocation.cwd,
      env: invocation.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    let failure: AgentCliError | undefined;
    let forcedFinish: NodeJS.Timeout | undefined;
    const finish = (error?: AgentCliError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedFinish) clearTimeout(forcedFinish);
      invocation.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const stop = (error: AgentCliError) => {
      if (settled || failure) return;
      failure = error;
      kill(child);
      forcedFinish = setTimeout(() => finish(error), 1000);
      forcedFinish.unref();
    };
    const abort = () => stop(new AgentCliError("CLI_ABORTED", `${invocation.tool} operation was cancelled; observe before retrying`));
    const timer = setTimeout(() => stop(new AgentCliError("CLI_TIMEOUT", `${invocation.tool} did not confirm the operation; observe before retrying`)), invocation.timeoutMs ?? 30_000);
    timer.unref();
    invocation.signal?.addEventListener("abort", abort, { once: true });
    if (invocation.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) stop(new AgentCliError("CLI_OUTPUT_LIMIT", `${invocation.tool} output exceeds its limit`));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > MAX_OUTPUT) stop(new AgentCliError("CLI_OUTPUT_LIMIT", `${invocation.tool} diagnostic output exceeds its limit`));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new AgentCliError(error.code === "ENOENT" ? "CLI_NOT_INSTALLED" : "CLI_START_FAILED", `${invocation.tool} could not start on this Env`));
    });
    child.stdin.on("error", () => { /* A native error may close stdin before its JSON error is written. */ });
    child.on("close", (code) => {
      if (failure) { finish(failure); return; }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { finish(new AgentCliError("CLI_INVALID_OUTPUT", `${invocation.tool} returned no valid JSON response`)); return; }
      if (code !== 0) {
        const structuredFailure = Array.isArray(value)
          ? value.some((row) => row && typeof row === "object" && (row as { success?: unknown }).success === false)
          : value && typeof value === "object" && ((value as { success?: unknown }).success === false || (value as { ok?: unknown }).ok === false);
        if (!structuredFailure) { finish(new AgentCliError("CLI_FAILED", `${invocation.tool} did not complete the operation`)); return; }
      }
      finish(undefined, value);
    });
    child.stdin.end(invocation.input ?? "");
  });
}
