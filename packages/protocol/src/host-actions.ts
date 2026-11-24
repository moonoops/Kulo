import type { ExecutionTrustMode } from "./execution-trust.js";

export type HostInspectScope = "summary" | "processes" | "ports";

export type HostActionRequest =
  | {
      kind: "inspect";
      scope: HostInspectScope;
      filter?: string;
      paths?: string[];
      limit?: number;
      executionMode?: ExecutionTrustMode;
    }
  | {
      kind: "run";
      commands: string[];
      cwd?: string;
      timeoutMs?: number;
      executionMode?: ExecutionTrustMode;
    };

export interface HostProcessEntry {
  pid: number;
  ppid?: number;
  cpu?: string;
  mem?: string;
  name: string;
  command: string;
}

export interface HostPortEntry {
  protocol: string;
  localAddress: string;
  port: number;
  pid?: number;
  processName?: string;
}

export interface HostPathCheck {
  path: string;
  resolvedPath?: string;
  status: "file" | "directory" | "symlink" | "missing" | "denied" | "error";
  entries?: string[];
  truncated?: boolean;
}

export interface HostActionStepResult {
  command: string;
  exitCode: number;
}

export interface HostActionResult {
  kind: HostActionRequest["kind"];
  platform: string;
  ok: boolean;
  homeDir?: string;
  hostname?: string;
  arch?: string;
  processes?: HostProcessEntry[];
  ports?: HostPortEntry[];
  paths?: HostPathCheck[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  steps?: HostActionStepResult[];
  error?: string;
}

export const HOST_ACTION_MAX_RESULT = 256 * 1024;
export const HOST_ACTION_MAX_COMMANDS = 8;
export const HOST_ACTION_MAX_COMMAND_CHARS = 8_000;
export const HOST_ACTION_MAX_PATHS = 32;
export const HOST_ACTION_MAX_TIMEOUT_MS = 600_000;

export function isHostActionRequest(value: unknown): value is HostActionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "inspect") {
    const allowed = new Set(["kind", "scope", "filter", "paths", "limit", "executionMode"]);
    if (Object.keys(v).some((key) => !allowed.has(key))) return false;
    if (v.executionMode !== undefined && v.executionMode !== "trusted" && v.executionMode !== "sandboxed") return false;
    if (v.scope !== "summary" && v.scope !== "processes" && v.scope !== "ports") return false;
    if (v.filter !== undefined && (typeof v.filter !== "string" || v.filter.length > 120 || /[\x00-\x1f\x7f]/.test(v.filter))) return false;
    if (v.limit !== undefined && (typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 200)) return false;
    if (v.paths !== undefined) {
      if (!Array.isArray(v.paths) || v.paths.length > HOST_ACTION_MAX_PATHS) return false;
      if (v.paths.some((item) => typeof item !== "string" || !item.trim() || item.length > 1024 || /[\x00-\x1f\x7f]/.test(item))) return false;
    }
    return true;
  }
  if (v.kind === "run") {
    const allowed = new Set(["kind", "commands", "cwd", "timeoutMs", "executionMode"]);
    if (Object.keys(v).some((key) => !allowed.has(key))) return false;
    if (v.executionMode !== undefined && v.executionMode !== "trusted" && v.executionMode !== "sandboxed") return false;
    if (!Array.isArray(v.commands) || v.commands.length < 1 || v.commands.length > HOST_ACTION_MAX_COMMANDS) return false;
    if (v.commands.some((cmd) => typeof cmd !== "string" || !cmd.trim() || cmd.length > HOST_ACTION_MAX_COMMAND_CHARS || cmd.includes("\0"))) return false;
    if (v.cwd !== undefined && (typeof v.cwd !== "string" || !v.cwd.trim() || v.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(v.cwd))) return false;
    if (v.timeoutMs !== undefined && (typeof v.timeoutMs !== "number" || !Number.isInteger(v.timeoutMs) || v.timeoutMs < 1_000 || v.timeoutMs > HOST_ACTION_MAX_TIMEOUT_MS)) return false;
    return true;
  }
  return false;
}

export function isHostActionResult(value: unknown, request: HostActionRequest): value is HostActionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as HostActionResult;
  const fields = new Set([
    "kind", "platform", "ok", "homeDir", "hostname", "arch",
    "processes", "ports", "paths",
    "exitCode", "stdout", "stderr", "truncated", "steps", "error",
  ]);
  if (Object.keys(v).some((key) => !fields.has(key))) return false;
  if (v.kind !== request.kind || typeof v.platform !== "string" || v.platform.length > 32 || typeof v.ok !== "boolean") return false;
  if (v.error !== undefined && (typeof v.error !== "string" || v.error.length > 4000)) return false;
  if (v.stdout !== undefined && typeof v.stdout !== "string") return false;
  if (v.stderr !== undefined && typeof v.stderr !== "string") return false;
  if (v.exitCode !== undefined && (typeof v.exitCode !== "number" || !Number.isInteger(v.exitCode))) return false;
  try {
    return JSON.stringify(value).length <= HOST_ACTION_MAX_RESULT;
  } catch {
    return false;
  }
}
