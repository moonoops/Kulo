import type { ExecutionTrustMode } from "./execution-trust.js";

export type ComputerUseTool = "browser" | "desktop";

export type ComputerScrollDirection = "up" | "down" | "left" | "right";

export type BrowserSnapshotMode = "interactive" | "compact";

export type BrowserBatchStep =
  | { action: "click"; ref: string }
  | { action: "fill" | "type"; ref: string; text: string }
  | { action: "scroll"; direction: ComputerScrollDirection; amount?: number }
  | { action: "wait"; ref?: string; text?: string; timeoutMs?: number }
  | { action: "back" | "forward" | "get-url" | "get-text" }
  | { action: "snapshot"; mode?: BrowserSnapshotMode };

export type ComputerUseRequest = (
  | { tool: "browser"; action: "status" }
  | { tool: "browser"; action: "open"; sessionId: string; url: string; returnSnapshot?: boolean; snapshotMode?: BrowserSnapshotMode }
  | { tool: "browser"; action: "snapshot"; sessionId: string; mode?: BrowserSnapshotMode }
  | { tool: "browser"; action: "get-url" | "get-text" | "close"; sessionId: string }
  | { tool: "browser"; action: "back" | "forward"; sessionId: string; returnSnapshot?: boolean; snapshotMode?: BrowserSnapshotMode }
  | { tool: "browser"; action: "click"; sessionId: string; ref: string; returnSnapshot?: boolean; snapshotMode?: BrowserSnapshotMode }
  | { tool: "browser"; action: "fill" | "type"; sessionId: string; ref: string; text: string; returnSnapshot?: boolean; snapshotMode?: BrowserSnapshotMode }
  | { tool: "browser"; action: "scroll"; sessionId: string; direction: ComputerScrollDirection; amount?: number; returnSnapshot?: boolean; snapshotMode?: BrowserSnapshotMode }
  | { tool: "browser"; action: "wait"; sessionId: string; ref?: string; text?: string; timeoutMs?: number }
  | { tool: "browser"; action: "batch"; sessionId: string; steps: BrowserBatchStep[]; returnSnapshot?: boolean; snapshotMode?: BrowserSnapshotMode }
  | { tool: "desktop"; action: "status" }
  | { tool: "desktop"; action: "permissions" }
  | { tool: "desktop"; action: "permission-guide"; kind?: "accessibility" | "screen" }
  | { tool: "desktop"; action: "snapshot"; sessionId: string; app: string }
  | { tool: "desktop"; action: "click"; sessionId: string; app: string; ref: string }
  | { tool: "desktop"; action: "type" | "set-value"; sessionId: string; app: string; ref: string; text: string }
  | { tool: "desktop"; action: "scroll"; sessionId: string; app: string; ref: string; direction: ComputerScrollDirection; amount?: number }
  | { tool: "desktop"; action: "wait"; sessionId: string; app: string; text: string; timeoutMs?: number }
  | { tool: "desktop"; action: "close"; sessionId: string }
) & { executionMode?: ExecutionTrustMode };

export interface ComputerUseResult {
  tool: ComputerUseTool;
  action: ComputerUseRequest["action"];
  sessionId?: string;
  platform: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export const COMPUTER_USE_MAX_RESULT = 1024 * 1024;
export const BROWSER_V2_CAPABILITY = "agent-browser-v2" as const;
export const BROWSER_BATCH_MAX_STEPS = 5;
export const BROWSER_BATCH_MAX_WAIT_MS = 15_000;
export const BROWSER_BATCH_DEFAULT_WAIT_MS = 5_000;
export const BROWSER_BATCH_MAX_TEXT_BYTES = 20_000;

const BROWSER_AUTO_SNAPSHOT_DEFAULT_TRUE_ACTIONS = new Set(["open", "click", "scroll", "back", "forward"]);
const BROWSER_AUTO_SNAPSHOT_OPT_IN_ACTIONS = new Set(["fill", "type"]);
const BROWSER_BATCH_READ_ONLY_ACTIONS = new Set(["snapshot", "get-url", "get-text"]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const browserRefPattern = /^@?e[0-9]+$/;
const desktopRefPattern = /^@s[a-zA-Z0-9_-]+:e[0-9]+$/;
const utf8Encoder = new TextEncoder();

function isBrowserSnapshotMode(value: unknown): value is BrowserSnapshotMode {
  return value === "interactive" || value === "compact";
}

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

export function hasBrowserV2Capability(capabilities: readonly string[]): boolean {
  return capabilities.includes(BROWSER_V2_CAPABILITY);
}

export function isBrowserBatchReadOnly(steps: readonly BrowserBatchStep[]): boolean {
  return steps.every((step) => BROWSER_BATCH_READ_ONLY_ACTIONS.has(step.action));
}

export function browserRequestWantsAutoSnapshot(request: ComputerUseRequest): boolean {
  if (request.tool !== "browser") return false;
  if (BROWSER_AUTO_SNAPSHOT_DEFAULT_TRUE_ACTIONS.has(request.action)) {
    return (request as { returnSnapshot?: boolean }).returnSnapshot !== false;
  }
  if (BROWSER_AUTO_SNAPSHOT_OPT_IN_ACTIONS.has(request.action)) {
    return (request as { returnSnapshot?: boolean }).returnSnapshot === true;
  }
  if (request.action === "batch") {
    return request.returnSnapshot !== false && request.steps[request.steps.length - 1]?.action !== "snapshot";
  }
  return false;
}

/**
 * Shared Env-side execution deadline budget (ms) for a computer-use request.
 * Ensures multi-step browser batches and primary+auto-snapshot calls share one bounded budget.
 */
export function computerUseEnvDeadlineMs(request: ComputerUseRequest): number {
  if (request.tool === "browser" && request.action === "batch") {
    let waitBudgetMs = 0;
    let nonWaitSteps = 0;
    for (const step of request.steps) {
      if (step.action === "wait") waitBudgetMs += step.timeoutMs ?? BROWSER_BATCH_DEFAULT_WAIT_MS;
      else nonWaitSteps += 1;
    }
    if (browserRequestWantsAutoSnapshot(request)) nonWaitSteps += 1;
    return Math.min(115_000, Math.max(30_000, 15_000 + nonWaitSteps * 10_000 + Math.min(waitBudgetMs, BROWSER_BATCH_MAX_WAIT_MS)));
  }
  if (browserRequestWantsAutoSnapshot(request)) return 40_000;
  return 30_000;
}

/**
 * Shared Hub-side RPC timeout (ms) derived from the Env deadline + 5s transport margin,
 * preserving the 45s baseline while preventing premature RPC timeouts on bounded batches.
 */
export function computerUseRpcTimeoutMs(request: ComputerUseRequest): number {
  return Math.max(45_000, computerUseEnvDeadlineMs(request) + 5_000);
}

function validateBrowserWait(
  v: Record<string, unknown>,
  allowed: Set<string>,
): { valid: boolean; timeoutMs: number; textBytes: number } {
  allowed.add("ref");
  allowed.add("text");
  allowed.add("timeoutMs");
  const hasRef = v.ref !== undefined;
  const hasText = v.text !== undefined;
  const valid =
    (hasRef || hasText) &&
    !(hasRef && hasText) &&
    (!hasRef || (typeof v.ref === "string" && browserRefPattern.test(v.ref))) &&
    (!hasText || (typeof v.text === "string" && v.text.length >= 1 && v.text.length <= 500 && !v.text.includes("\0"))) &&
    (v.timeoutMs === undefined || (typeof v.timeoutMs === "number" && Number.isInteger(v.timeoutMs) && v.timeoutMs >= 100 && v.timeoutMs <= BROWSER_BATCH_MAX_WAIT_MS));
  return {
    valid,
    timeoutMs: valid && typeof v.timeoutMs === "number" ? v.timeoutMs : BROWSER_BATCH_DEFAULT_WAIT_MS,
    textBytes: valid && hasText ? utf8ByteLength(v.text as string) : 0,
  };
}

function validateBrowserBatchSteps(steps: unknown): boolean {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > BROWSER_BATCH_MAX_STEPS) return false;
  let cumulativeWaitMs = 0;
  let totalTextBytes = 0;
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const step = raw as Record<string, unknown>;
    if (typeof step.action !== "string") return false;
    const stepAllowed = new Set(["action"]);
    let stepValid = false;
    switch (step.action) {
      case "click":
        stepAllowed.add("ref");
        stepValid = typeof step.ref === "string" && browserRefPattern.test(step.ref);
        break;
      case "fill":
      case "type":
        stepAllowed.add("ref");
        stepAllowed.add("text");
        stepValid =
          typeof step.ref === "string" &&
          browserRefPattern.test(step.ref) &&
          typeof step.text === "string" &&
          step.text.length <= BROWSER_BATCH_MAX_TEXT_BYTES &&
          !step.text.includes("\0");
        if (stepValid) totalTextBytes += utf8ByteLength(step.text as string);
        break;
      case "scroll":
        stepAllowed.add("direction");
        stepAllowed.add("amount");
        stepValid =
          typeof step.direction === "string" &&
          SCROLL_DIRECTIONS.has(step.direction) &&
          (step.amount === undefined || (typeof step.amount === "number" && Number.isInteger(step.amount) && step.amount >= 1 && step.amount <= 4000));
        break;
      case "wait": {
        const wait = validateBrowserWait(step, stepAllowed);
        stepValid = wait.valid;
        if (stepValid) {
          cumulativeWaitMs += wait.timeoutMs;
          totalTextBytes += wait.textBytes;
        }
        break;
      }
      case "snapshot":
        stepAllowed.add("mode");
        stepValid = step.mode === undefined || isBrowserSnapshotMode(step.mode);
        break;
      case "back":
      case "forward":
      case "get-url":
      case "get-text":
        stepValid = true;
        break;
      default:
        return false;
    }
    if (!stepValid || !Object.keys(step).every((key) => stepAllowed.has(key))) return false;
    if (cumulativeWaitMs > BROWSER_BATCH_MAX_WAIT_MS || totalTextBytes > BROWSER_BATCH_MAX_TEXT_BYTES) return false;
  }
  return true;
}

function validateAutoSnapshotOptions(v: Record<string, unknown>, allowed: Set<string>): boolean {
  allowed.add("returnSnapshot");
  allowed.add("snapshotMode");
  return (
    (v.returnSnapshot === undefined || typeof v.returnSnapshot === "boolean") &&
    (v.snapshotMode === undefined || isBrowserSnapshotMode(v.snapshotMode))
  );
}

export function isComputerUseRequest(value: unknown): value is ComputerUseRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.tool !== "browser" && v.tool !== "desktop" || typeof v.action !== "string") return false;
  if (v.executionMode !== undefined && v.executionMode !== "trusted" && v.executionMode !== "sandboxed") return false;
  const allowed = new Set(["tool", "action", "executionMode"]);
  if (v.action === "status") return Object.keys(v).every((key) => allowed.has(key));
  if (v.tool === "desktop" && v.action === "permissions") return Object.keys(v).every((key) => allowed.has(key));
  if (v.tool === "desktop" && v.action === "permission-guide") {
    allowed.add("kind");
    return (v.kind === undefined || v.kind === "accessibility" || v.kind === "screen")
      && Object.keys(v).every((key) => allowed.has(key));
  }
  allowed.add("sessionId");
  if (typeof v.sessionId !== "string" || !sessionPattern.test(v.sessionId)) return false;
  let valid = false;
  if (v.tool === "browser") {
    if (v.action === "open") {
      allowed.add("url");
      if (typeof v.url !== "string" || v.url.length > 4096) return false;
      try {
        const url = new URL(v.url);
        valid = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && validateAutoSnapshotOptions(v, allowed);
      } catch { return false; }
    } else if (v.action === "snapshot") {
      allowed.add("mode");
      valid = v.mode === undefined || isBrowserSnapshotMode(v.mode);
    } else if (["get-url", "get-text", "close"].includes(v.action)) {
      valid = true;
    } else if (["back", "forward"].includes(v.action)) {
      valid = validateAutoSnapshotOptions(v, allowed);
    } else if (["click", "fill", "type"].includes(v.action)) {
      allowed.add("ref");
      valid = typeof v.ref === "string" && browserRefPattern.test(v.ref) && validateAutoSnapshotOptions(v, allowed);
    } else if (v.action === "scroll") {
      allowed.add("direction");
      allowed.add("amount");
      valid =
        typeof v.direction === "string" &&
        SCROLL_DIRECTIONS.has(v.direction) &&
        (v.amount === undefined || (typeof v.amount === "number" && Number.isInteger(v.amount) && v.amount >= 1 && v.amount <= 4000)) &&
        validateAutoSnapshotOptions(v, allowed);
    } else if (v.action === "wait") {
      valid = validateBrowserWait(v, allowed).valid;
    } else if (v.action === "batch") {
      allowed.add("steps");
      valid = validateAutoSnapshotOptions(v, allowed) && validateBrowserBatchSteps(v.steps);
    }
  } else if (v.action === "close") valid = true;
  else if (["snapshot", "click", "type", "set-value", "scroll", "wait"].includes(v.action)) {
    allowed.add("app");
    valid = typeof v.app === "string" && v.app.length > 0 && v.app.length <= 256 && !/[\x00-\x1f]/.test(v.app);
    if (v.action === "scroll") {
      allowed.add("ref");
      allowed.add("direction");
      allowed.add("amount");
      valid &&=
        typeof v.ref === "string" &&
        desktopRefPattern.test(v.ref) &&
        typeof v.direction === "string" &&
        SCROLL_DIRECTIONS.has(v.direction) &&
        (v.amount === undefined || (typeof v.amount === "number" && Number.isInteger(v.amount) && v.amount >= 1 && v.amount <= 20));
    } else if (v.action === "wait") {
      allowed.add("text");
      allowed.add("timeoutMs");
      valid &&=
        typeof v.text === "string" &&
        v.text.length >= 1 &&
        v.text.length <= 500 &&
        !v.text.includes("\0") &&
        (v.timeoutMs === undefined || (typeof v.timeoutMs === "number" && Number.isInteger(v.timeoutMs) && v.timeoutMs >= 200 && v.timeoutMs <= 15_000));
    } else if (v.action !== "snapshot") {
      allowed.add("ref");
      valid &&= typeof v.ref === "string" && desktopRefPattern.test(v.ref);
    }
  }
  if (["fill", "type", "set-value"].includes(v.action)) {
    allowed.add("text");
    valid &&= typeof v.text === "string" && v.text.length <= 20_000 && !v.text.includes("\0");
  }
  return valid && Object.keys(v).every((key) => allowed.has(key));
}

export function isComputerUseResult(value: unknown, request: ComputerUseRequest): value is ComputerUseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ComputerUseResult;
  const fields = new Set(["tool", "action", "sessionId", "platform", "ok", "data", "error"]);
  if (Object.keys(v).some((key) => !fields.has(key))) return false;
  if (v.tool !== request.tool || v.action !== request.action || v.sessionId !== ("sessionId" in request ? request.sessionId : undefined)
    || typeof v.platform !== "string" || v.platform.length > 32 || typeof v.ok !== "boolean") return false;
  if (v.ok ? v.error !== undefined : !v.error || typeof v.error.code !== "string" || v.error.code.length > 128
    || typeof v.error.message !== "string" || v.error.message.length > 2000
    || Object.keys(v.error).some((key) => key !== "code" && key !== "message")) return false;
  try { return JSON.stringify(value).length <= COMPUTER_USE_MAX_RESULT; } catch { return false; }
}
