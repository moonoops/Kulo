import {
  BROWSER_BATCH_DEFAULT_WAIT_MS,
  browserRequestWantsAutoSnapshot,
  computerUseEnvDeadlineMs,
  type BrowserBatchStep,
  type BrowserSnapshotMode,
  type ComputerUseRequest,
  type ComputerUseResult,
} from "@kulo/protocol";
import { AgentCliError } from "./agent-cli.js";

export const AUTO_SNAPSHOT_MAX_CHARS = 14_000;
export const AUTO_SNAPSHOT_MIN_REMAINING_MS = 8_000;
export const AUTO_SNAPSHOT_MAX_TIMEOUT_MS = 10_000;

export type BrowserBatchRequest = Extract<ComputerUseRequest, { tool: "browser"; action: "batch" }>;
export type BrowserSessionRequest = Extract<ComputerUseRequest, { tool: "browser"; sessionId: string }>;

interface NativeBatchRow {
  index?: unknown;
  success?: unknown;
  result?: unknown;
  error?: unknown;
  code?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function normalizeBrowserRef(ref: string): string {
  return ref.replace(/^@/, "");
}

export function extractBrowserRefs(value: unknown): Set<string> {
  const refs = new Set<string>();
  const data = asRecord(value);
  const mapped = asRecord(data?.refs);
  if (mapped) {
    for (const key of Object.keys(mapped)) {
      if (/^@?e[0-9]+$/.test(key)) refs.add(key.replace(/^@/, ""));
    }
  }
  return refs;
}

export function browserSnapshotCliArgs(mode?: BrowserSnapshotMode): string[] {
  return mode === "compact" ? ["snapshot", "-c"] : ["snapshot", "-i", "-c"];
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const cut = lastNewline >= maxChars - 500 && lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return { text: cut, truncated: true };
}

/**
 * Strip the redundant `refs` object map after Env has cached `session.refs`,
 * and optionally bound `snapshot` text length with `truncated: true`.
 */
export function compactBrowserSnapshotData(
  rawData: unknown,
  options?: { maxSnapshotChars?: number; stripLifecycle?: boolean },
): unknown {
  const data = asRecord(rawData);
  if (!data) return rawData;
  const { refs: _strippedRefs, ...rest } = data;
  if (options?.stripLifecycle) delete rest.lifecycle;
  if (options?.maxSnapshotChars !== undefined && typeof rest.snapshot === "string") {
    const bounded = truncateText(rest.snapshot, options.maxSnapshotChars);
    rest.snapshot = bounded.text;
    if (bounded.truncated) rest.truncated = true;
  }
  return rest;
}

export function collectInputSecrets(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    seen.add(raw);
    const escaped = JSON.stringify(raw).slice(1, -1);
    if (escaped) seen.add(escaped);
    const trimmed = raw.replace(/[\r\n]+$/g, "");
    if (trimmed && trimmed !== raw) {
      seen.add(trimmed);
      const trimmedEscaped = JSON.stringify(trimmed).slice(1, -1);
      if (trimmedEscaped) seen.add(trimmedEscaped);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

export function scrubSecretsInString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join("[input omitted]");
    }
  }
  return out;
}

export function scrubSecretsDeep(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return scrubSecretsInString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubSecretsDeep(item, secrets));
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = scrubSecretsDeep(entry, secrets);
  }
  return out;
}

export function isBatchStepRefEpochBarrier(step: BrowserBatchStep): boolean {
  if (step.action === "click" || step.action === "scroll" || step.action === "back" || step.action === "forward") {
    return true;
  }
  if (step.action === "type" && /[\r\n]/.test(step.text)) {
    return true;
  }
  return false;
}

/**
 * Validate batch ref authorization across ref-epoch barriers before touching the browser:
 * - Pre-barrier `@eN` refs must all exist in `sessionRefs`.
 * - After any ref-epoch barrier (`click`, `scroll`, `back`, `forward`, or `type` containing `\n`/`\r`),
 *   no subsequent step may reference any pre-barrier `@eN` ref.
 */
export function validateBrowserBatchRefs(
  steps: readonly BrowserBatchStep[],
  sessionRefs: ReadonlySet<string>,
): { ok: true } | { ok: false; code: "REF_NOT_AUTHORIZED"; message: string } {
  let barrierCrossed = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if ("ref" in step && step.ref !== undefined) {
      if (barrierCrossed) {
        return {
          ok: false,
          code: "REF_NOT_AUTHORIZED",
          message: `Batch step ${i} (${step.action}) cannot use ref ${step.ref} after a navigation/DOM barrier; take a fresh snapshot before acting on new elements`,
        };
      }
      if (!sessionRefs.has(normalizeBrowserRef(step.ref))) {
        return {
          ok: false,
          code: "REF_NOT_AUTHORIZED",
          message: "Take a fresh snapshot in this browser session before acting on a ref",
        };
      }
    }
    if (isBatchStepRefEpochBarrier(step)) {
      barrierCrossed = true;
    }
  }
  return { ok: true };
}

export function browserBatchStepToCliCommand(step: BrowserBatchStep): string[] {
  switch (step.action) {
    case "click":
      return ["click", `@${normalizeBrowserRef(step.ref)}`];
    case "fill":
    case "type":
      return [step.action, `@${normalizeBrowserRef(step.ref)}`, "--", step.text];
    case "scroll":
      return ["scroll", step.direction, String(step.amount ?? 500)];
    case "wait":
      return [
        "wait",
        ...(step.ref !== undefined ? [`@${normalizeBrowserRef(step.ref)}`] : ["--text", step.text!]),
        "--timeout",
        String(step.timeoutMs ?? BROWSER_BATCH_DEFAULT_WAIT_MS),
      ];
    case "back":
    case "forward":
      return [step.action];
    case "snapshot":
      return browserSnapshotCliArgs(step.mode);
    case "get-url":
      return ["get", "url"];
    case "get-text":
      return ["get", "text", "body"];
  }
}

export function mergeAutoSnapshotPayload(
  mainData: unknown,
  rawSnapshotData: unknown,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const base = asRecord(mainData) ? { ...asRecord(mainData)! } : {};
  delete base.observationRequired;
  const compacted = compactBrowserSnapshotData(rawSnapshotData, {
    maxSnapshotChars: AUTO_SNAPSHOT_MAX_CHARS,
    stripLifecycle: true,
  });
  const snapObj = asRecord(scrubSecretsDeep(compacted, secrets));
  if (!snapObj) return base;
  return {
    ...snapObj,
    ...base,
    ...(typeof snapObj.snapshot === "string" ? { snapshot: snapObj.snapshot } : {}),
    ...(snapObj.truncated === true ? { truncated: true } : {}),
    ...(typeof snapObj.origin === "string" ? { origin: snapObj.origin } : {}),
  };
}

export function attachAutoSnapshotFailure(
  mainData: unknown,
  snapshotError: string,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const base = asRecord(mainData) ? { ...asRecord(mainData)! } : {};
  const message = scrubSecretsInString(snapshotError, secrets).slice(0, 500);
  return {
    ...base,
    observationRequired: true,
    snapshotError: message,
  };
}

export interface SecondarySnapshotContext {
  request: BrowserSessionRequest;
  mainData: unknown;
  deadlineAt: number;
  active: () => boolean;
  signal: AbortSignal;
  runSnapshot: (mode: BrowserSnapshotMode | undefined, timeoutMs: number) => Promise<{ data?: unknown; failure?: ComputerUseResult }>;
  onRefs: (refs: Set<string>) => void;
}

/**
 * Execute secondary auto-snapshot inside a local try/catch so snapshot timeouts or errors
 * NEVER propagate `AgentCliError` to `ComputerUseService.request()` (which would set
 * `cleanupRequired = true` and destroy active browser sessions / login state).
 */
export async function runSecondaryAutoSnapshot(ctx: SecondarySnapshotContext): Promise<unknown> {
  if (!browserRequestWantsAutoSnapshot(ctx.request)) return ctx.mainData;
  const secrets =
    (ctx.request.action === "fill" || ctx.request.action === "type")
      ? collectInputSecrets([ctx.request.text])
      : [];
  if (!ctx.active() || ctx.signal.aborted) {
    return attachAutoSnapshotFailure(ctx.mainData, "Skipped automatic snapshot because operation was cancelled", secrets);
  }
  const remainingMs = ctx.deadlineAt - Date.now();
  if (remainingMs < AUTO_SNAPSHOT_MIN_REMAINING_MS) {
    return attachAutoSnapshotFailure(ctx.mainData, "Skipped automatic snapshot due to remaining timeout budget", secrets);
  }
  const timeoutMs = Math.min(AUTO_SNAPSHOT_MAX_TIMEOUT_MS, remainingMs);
  const mode = "snapshotMode" in ctx.request ? ctx.request.snapshotMode : undefined;
  try {
    const snap = await ctx.runSnapshot(mode, timeoutMs);
    if (snap.failure) {
      return attachAutoSnapshotFailure(
        ctx.mainData,
        snap.failure.error?.message ?? "Automatic snapshot failed",
        secrets,
      );
    }
    ctx.onRefs(extractBrowserRefs(snap.data));
    return mergeAutoSnapshotPayload(ctx.mainData, snap.data, secrets);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automatic snapshot failed";
    return attachAutoSnapshotFailure(ctx.mainData, message, secrets);
  }
}

export interface BrowserBatchExecutionContext {
  request: BrowserBatchRequest;
  sessionRefs: Set<string>;
  platform: string;
  runBatchCli: (commands: string[][], timeoutMs: number) => Promise<unknown>;
  onLifecycle?: (lifecycle: Record<string, unknown> | undefined) => Promise<Record<string, unknown> | undefined>;
}

function extractRowError(row: NativeBatchRow, secrets: readonly string[]): { code: string; message: string } {
  const detail = asRecord(row.error);
  const code = typeof detail?.code === "string"
    ? detail.code
    : typeof row.code === "string"
      ? row.code
      : "NATIVE_OPERATION_FAILED";
  const rawMessage = typeof detail?.message === "string"
    ? detail.message
    : typeof row.error === "string"
      ? row.error
      : "The native tool did not complete the operation";
  return {
    code: code.slice(0, 128),
    message: scrubSecretsInString(rawMessage, secrets),
  };
}

function sanitizeGetTextResult(result: unknown, secrets: readonly string[]): unknown {
  if (typeof result === "string") {
    const bounded = truncateText(scrubSecretsInString(result, secrets), AUTO_SNAPSHOT_MAX_CHARS);
    return bounded.truncated ? { text: bounded.text, truncated: true } : bounded.text;
  }
  const record = asRecord(scrubSecretsDeep(result, secrets));
  if (!record) return scrubSecretsDeep(result, secrets);
  if (typeof record.text === "string") {
    const bounded = truncateText(record.text, AUTO_SNAPSHOT_MAX_CHARS);
    record.text = bounded.text;
    if (bounded.truncated) record.truncated = true;
  }
  return record;
}

/**
 * Execute a bounded browser `batch` (1..5 steps) with:
 * - Pre-execution ref-epoch barrier validation
 * - `agent-browser batch --omit-command --bail`
 * - Zero `row.result` passthrough for `fill`/`type` steps + full secret scrubbing on all strings & errors
 * - Automatic trailing snapshot when `returnSnapshot !== false` and last step is not `snapshot`
 */
export async function executeBrowserBatch(ctx: BrowserBatchExecutionContext): Promise<ComputerUseResult> {
  const { request, sessionRefs, platform } = ctx;
  const refCheck = validateBrowserBatchRefs(request.steps, sessionRefs);
  if (!refCheck.ok) {
    return {
      tool: "browser",
      action: "batch",
      sessionId: request.sessionId,
      platform,
      ok: false,
      error: { code: refCheck.code, message: refCheck.message },
    };
  }

  const secrets = collectInputSecrets(
    request.steps.map((step) => (step.action === "fill" || step.action === "type" ? step.text : undefined)),
  );
  const appendTrailingSnapshot = browserRequestWantsAutoSnapshot(request);
  const executedSteps: BrowserBatchStep[] = appendTrailingSnapshot
    ? [...request.steps, { action: "snapshot", ...(request.snapshotMode ? { mode: request.snapshotMode } : {}) }]
    : [...request.steps];
  const commands = executedSteps.map(browserBatchStepToCliCommand);
  const mutatesRefs = executedSteps.some((step) => step.action !== "get-url" && step.action !== "get-text");
  if (mutatesRefs) sessionRefs.clear();

  const timeoutMs = computerUseEnvDeadlineMs(request);
  let rawRows: unknown;
  try {
    rawRows = await ctx.runBatchCli(commands, timeoutMs);
  } catch (error) {
    if (error instanceof AgentCliError) {
      throw new AgentCliError(error.code, scrubSecretsInString(error.message, secrets));
    }
    throw error;
  }

  if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > executedSteps.length) {
    throw new AgentCliError("CLI_INVALID_OUTPUT", "The browser returned an invalid batch response");
  }

  const completedSteps: Array<Record<string, unknown>> = [];
  let latestRefs: Set<string> | undefined;
  let sessionReset: Record<string, unknown> | undefined;
  let trailingSnapshot: Record<string, unknown> | undefined;
  let trailingSnapshotError: string | undefined;

  for (let i = 0; i < rawRows.length; i++) {
    const row = asRecord(rawRows[i]) as NativeBatchRow | undefined;
    if (!row || typeof row.success !== "boolean" || (row.index !== undefined && row.index !== i)) {
      throw new AgentCliError("CLI_INVALID_OUTPUT", "The browser returned an invalid batch row");
    }
    const step = executedSteps[i]!;
    const isTrailingAutoSnapshot = appendTrailingSnapshot && i === request.steps.length;

    if (!row.success) {
      const err = extractRowError(row, secrets);
      if (isTrailingAutoSnapshot) {
        trailingSnapshotError = err.message.slice(0, 500);
        break;
      }
      sessionRefs.clear();
      return {
        tool: "browser",
        action: "batch",
        sessionId: request.sessionId,
        platform,
        ok: false,
        data: {
          steps: completedSteps,
          failedStepIndex: i,
          failedAction: step.action,
        },
        error: {
          code: err.code,
          message: `Batch step ${i} (${step.action}) failed: ${err.message}`.slice(0, 2000),
        },
      };
    }

    if (!sessionReset && ctx.onLifecycle) {
      const lifecycle = asRecord(asRecord(row.result)?.lifecycle);
      if (lifecycle) sessionReset = await ctx.onLifecycle(lifecycle);
    }

    if (step.action === "snapshot") {
      latestRefs = extractBrowserRefs(row.result);
      const compacted = compactBrowserSnapshotData(row.result, {
        maxSnapshotChars: AUTO_SNAPSHOT_MAX_CHARS,
        stripLifecycle: true,
      });
      const scrubbed = scrubSecretsDeep(compacted, secrets);
      if (isTrailingAutoSnapshot) {
        trailingSnapshot = asRecord(scrubbed) ?? {};
      } else {
        completedSteps.push({ index: i, action: step.action, ok: true, data: scrubbed });
      }
      continue;
    }

    if (step.action !== "get-url" && step.action !== "get-text") {
      latestRefs = undefined;
    }

    if (step.action === "fill" || step.action === "type") {
      // NEVER return raw `row.result` for fill/type (`agent-browser@0.43.0` echoes typed text in `type`).
      completedSteps.push({ index: i, action: step.action, ok: true });
    } else if (step.action === "get-url") {
      completedSteps.push({ index: i, action: step.action, ok: true, data: scrubSecretsDeep(row.result, secrets) });
    } else if (step.action === "get-text") {
      completedSteps.push({ index: i, action: step.action, ok: true, data: sanitizeGetTextResult(row.result, secrets) });
    } else {
      completedSteps.push({ index: i, action: step.action, ok: true });
    }
  }

  if (!trailingSnapshotError && rawRows.length !== executedSteps.length) {
    throw new AgentCliError("CLI_INVALID_OUTPUT", "The browser returned an incomplete batch response");
  }

  if (sessionReset) {
    sessionRefs.clear();
  } else if (latestRefs) {
    sessionRefs.clear();
    for (const ref of latestRefs) sessionRefs.add(ref);
  } else if (mutatesRefs) {
    sessionRefs.clear();
  }

  const data: Record<string, unknown> = {
    steps: completedSteps,
    ...(trailingSnapshot ?? {}),
    ...(trailingSnapshotError ? { observationRequired: true, snapshotError: trailingSnapshotError } : {}),
    ...(sessionReset ? { sessionReset } : {}),
  };

  return {
    tool: "browser",
    action: "batch",
    sessionId: request.sessionId,
    platform,
    ok: true,
    data,
  };
}
