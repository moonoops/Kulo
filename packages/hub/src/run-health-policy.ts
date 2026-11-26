import { createHash } from "node:crypto";
import path from "node:path";

/** Centralized turn budgets across Orchestrator, Workers, Subagents, and Settings Assistant. */
export const ORCHESTRATOR_MAX_TURNS = 60;
export const WORKER_MAX_TURNS = 120;
export const PROACTIVE_WAKE_MAX_TURNS = 40;
export const ORCHESTRATOR_SOFT_HANDOFF_TURN = 15;
export const ORCHESTRATOR_HEALTH_CHECK_INTERVAL = 20;
export const WORKER_HEALTH_CHECK_INTERVAL = 25;
export const WRAP_UP_MARGIN_TURNS = 2;
export const SUBAGENT_MAX_TURNS = 25;
export const SETTINGS_ASSISTANT_MAX_TURNS = 25;

/** Deterministic doom-loop thresholds (Layer 1). */
export const IDENTICAL_CALL_WARN_STREAK = 3;
export const IDENTICAL_CALL_BRAKE_STREAK = 5;
export const IDENTICAL_ERROR_WARN_STREAK = 3;
export const IDENTICAL_ERROR_BRAKE_STREAK = 5;
export const BROWSER_STAGNATION_WARN_STREAK = 4;
export const BROWSER_STAGNATION_BRAKE_STREAK = 6;

/** Trajectory summarization bounds for Layer 2 health judge. */
export const JUDGE_GOAL_MAX_CHARS = 600;
export const JUDGE_RECENT_TURNS_WINDOW = 25;

/** Tools that terminate a run when every call in the round terminates. */
export const RUN_HEALTH_TERMINATING_TOOLS: ReadonlySet<string> = new Set([
  "kulo_report",
  "kulo_computer_handoff",
  "kulo_wait",
]);

/** Sentinel marker embedded in run-health block/guidance messages so self-blocks never distort doom-loop stats. */
export const RUN_HEALTH_BLOCK_MARKER = "[KULO_RUN_HEALTH]";

export type RunHealthRole = "orchestrator" | "worker" | "subagent";
export type RunHealthVerdictKind = "healthy" | "handoff_or_wrap" | "stuck";
export type RunHealthWrapUpSource = "turn_limit" | "doom_loop" | "judge_stuck";

export interface RunHealthJudgeVerdict {
  verdict: RunHealthVerdictKind;
  reason: string;
  guidance?: string;
}

export interface RunHealthWarning {
  kind: "identical_call" | "identical_error" | "browser_stagnation";
  streak: number;
  detail: string;
}

export interface RoleTurnBudget {
  maxTurns: number;
  wrapUpTurn: number;
  softHandoffTurn?: number;
  healthCheckInterval?: number;
}

export interface DoomLoopTrackerState {
  lastCallFingerprint?: string;
  identicalCallStreak: number;
  lastErrorFingerprint?: string;
  identicalErrorStreak: number;
  lastBrowserSnapshotKey?: string;
  browserStagnationStreak: number;
  dispatchedInRun: boolean;
}

export interface ObservedToolCallOutcome {
  name: string;
  arguments: unknown;
  isError: boolean;
  errorCode?: string;
  errorText?: string;
  outputText?: string;
  extraOutputTexts?: readonly string[];
  durationMs?: number;
}

export interface DoomLoopEvaluation {
  state: DoomLoopTrackerState;
  action: "none" | "warn" | "brake";
  warning?: RunHealthWarning;
  brakeReason?: string;
}

export interface BrowserSnapshotFingerprint {
  url: string;
  coreSnapshotHash: string;
  key: string;
}

export interface JudgeTrajectoryToolEntry {
  name: string;
  argSummary: string;
  ok: boolean;
  errorCode?: string;
  durationMs?: number;
}

export interface JudgeTrajectoryTurn {
  turn: number;
  tools: JudgeTrajectoryToolEntry[];
}

export interface JudgeTrajectoryInput {
  role: RunHealthRole;
  turnsUsed: number;
  effectiveTurnsSinceInput: number;
  maxTurns: number;
  userGoal: string;
  recentTurns: JudgeTrajectoryTurn[];
  signals: {
    identicalCallStreak: number;
    identicalErrorStreak: number;
    browserStagnationStreak: number;
    dispatchedInRun: boolean;
  };
}

export function createEmptyDoomLoopState(): DoomLoopTrackerState {
  return {
    identicalCallStreak: 0,
    identicalErrorStreak: 0,
    browserStagnationStreak: 0,
    dispatchedInRun: false,
  };
}

export function resolveRoleTurnBudget(role: RunHealthRole, agentMaxTurns?: number): RoleTurnBudget {
  const validAgentMax =
    typeof agentMaxTurns === "number" && Number.isFinite(agentMaxTurns) && agentMaxTurns >= 1
      ? Math.floor(agentMaxTurns)
      : undefined;

  let maxTurns: number;
  if (role === "subagent") {
    // Subagent budget is never widened above SUBAGENT_MAX_TURNS.
    maxTurns = validAgentMax !== undefined ? Math.min(validAgentMax, SUBAGENT_MAX_TURNS) : SUBAGENT_MAX_TURNS;
  } else if (role === "worker") {
    maxTurns = validAgentMax ?? WORKER_MAX_TURNS;
  } else {
    maxTurns = validAgentMax ?? ORCHESTRATOR_MAX_TURNS;
  }

  const wrapUpTurn = Math.max(1, maxTurns - WRAP_UP_MARGIN_TURNS);
  return {
    maxTurns,
    wrapUpTurn,
    ...(role === "orchestrator" ? { softHandoffTurn: ORCHESTRATOR_SOFT_HANDOFF_TURN } : {}),
    ...(role === "orchestrator"
      ? { healthCheckInterval: ORCHESTRATOR_HEALTH_CHECK_INTERVAL }
      : role === "worker"
        ? { healthCheckInterval: WORKER_HEALTH_CHECK_INTERVAL }
        : {}),
  };
}

export function isTerminatingToolRound(toolNames: readonly string[]): boolean {
  return toolNames.length > 0 && toolNames.every((name) => RUN_HEALTH_TERMINATING_TOOLS.has(name));
}

function sha256Short(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Deterministic canonical JSON serialization with sorted keys and bounded depth. */
export function canonicalizeForHash(value: unknown, depth = 0): string {
  if (depth > 8) return '"[max-depth]"';
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) || typeof value === "boolean" ? JSON.stringify(value) : "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value.length > 4_000 ? `${value.slice(0, 4_000)}#[len=${value.length}]` : value);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 64).map((item) => canonicalizeForHash(item, depth + 1));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .slice(0, 64);
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeForHash(record[k], depth + 1)}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function fingerprintToolCall(toolName: string, args: unknown): string {
  const canonical = canonicalizeForHash(args);
  return `${toolName}#${sha256Short(`${toolName}:${canonical}`)}`;
}

function normalizeErrorTextForFingerprint(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, "<ts>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/g, "<dur>")
    .replace(/\b(?:0x)?[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\b\d{5,}\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function fingerprintToolError(
  toolName: string,
  errorCode: string | undefined,
  errorText: string | undefined,
): string {
  const normalized = normalizeErrorTextForFingerprint(errorText);
  return `${toolName}:${errorCode ?? ""}:${sha256Short(normalized)}`;
}

function isRunHealthSelfBlock(outcome: ObservedToolCallOutcome): boolean {
  return (
    outcome.isError &&
    outcome.errorCode === "blocked" &&
    Boolean(outcome.errorText?.includes(RUN_HEALTH_BLOCK_MARKER))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractSnapshotTextFromData(data: Record<string, unknown>): { url: string; snapshot: string } | null {
  const topUrl = typeof data.url === "string" ? data.url.trim() : "";

  if (typeof data.snapshot === "string" && data.snapshot.trim().length > 0) {
    return { url: topUrl, snapshot: data.snapshot };
  }
  if (typeof data.autoSnapshot === "string" && data.autoSnapshot.trim().length > 0) {
    return { url: topUrl, snapshot: data.autoSnapshot };
  }

  const nestedSnap = asRecord(data.snapshot);
  if (nestedSnap && typeof nestedSnap.snapshot === "string" && nestedSnap.snapshot.trim().length > 0) {
    const nestedUrl = typeof nestedSnap.url === "string" ? nestedSnap.url.trim() : topUrl;
    return { url: nestedUrl, snapshot: nestedSnap.snapshot };
  }

  if (Array.isArray(data.steps)) {
    for (let i = data.steps.length - 1; i >= 0; i -= 1) {
      const step = asRecord(data.steps[i]);
      if (!step) continue;
      if (typeof step.snapshot === "string" && step.snapshot.trim().length > 0) {
        const stepUrl = typeof step.url === "string" ? step.url.trim() : topUrl;
        return { url: stepUrl, snapshot: step.snapshot };
      }
      const stepResult = asRecord(step.result);
      if (stepResult && typeof stepResult.snapshot === "string" && stepResult.snapshot.trim().length > 0) {
        const stepUrl = typeof stepResult.url === "string" ? stepResult.url.trim() : topUrl;
        return { url: stepUrl, snapshot: stepResult.snapshot };
      }
    }
  }

  return null;
}

/**
 * Extracts a `(url, coreSnapshotHash)` fingerprint ONLY when a `kulo_browser` result actually
 * carries a browser snapshot payload. Non-snapshot actions (such as `fill`/`type` with
 * `returnSnapshot=false`, `get-url`, `close`, or degraded `observationRequired: true` responses)
 * strictly return `null` so browser stagnation never falsely advances on them.
 */
export function extractBrowserSnapshotFingerprint(
  outputText: string | undefined,
  extraOutputTexts?: readonly string[],
): BrowserSnapshotFingerprint | null {
  if (!outputText || !outputText.trim()) return null;

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(outputText));
  } catch {
    return null;
  }
  if (!parsed || parsed.ok === false) return null;

  const data = asRecord(parsed.data);
  let url = typeof parsed.url === "string" ? parsed.url.trim() : "";
  let snapshotText: string | undefined;

  if (data) {
    if (!url && typeof data.url === "string") url = data.url.trim();
    const extracted = extractSnapshotTextFromData(data);
    if (extracted) {
      if (extracted.url) url = extracted.url;
      snapshotText = extracted.snapshot;
    }
  }

  if (!snapshotText && extraOutputTexts && extraOutputTexts.length > 0) {
    for (const part of extraOutputTexts) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && (trimmed.includes("[ref=e") || trimmed.startsWith("- ") || trimmed.includes("Snapshot:"))) {
        snapshotText = trimmed;
        break;
      }
    }
  }

  if (!snapshotText) return null;

  const normalizedCore = snapshotText
    .replace(/\[ref=e\d+\]/g, "[ref]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16_000);
  if (!normalizedCore) return null;

  const coreSnapshotHash = sha256Short(normalizedCore);
  return {
    url,
    coreSnapshotHash,
    key: `${url}::${coreSnapshotHash}`,
  };
}

/** Advances deterministic Layer-1 doom-loop counters for one completed tool round. */
export function evaluateDoomLoopRound(
  prev: DoomLoopTrackerState,
  outcomes: readonly ObservedToolCallOutcome[],
): DoomLoopEvaluation {
  const next: DoomLoopTrackerState = {
    ...(prev.lastCallFingerprint !== undefined ? { lastCallFingerprint: prev.lastCallFingerprint } : {}),
    identicalCallStreak: prev.identicalCallStreak,
    ...(prev.lastErrorFingerprint !== undefined ? { lastErrorFingerprint: prev.lastErrorFingerprint } : {}),
    identicalErrorStreak: prev.identicalErrorStreak,
    ...(prev.lastBrowserSnapshotKey !== undefined ? { lastBrowserSnapshotKey: prev.lastBrowserSnapshotKey } : {}),
    browserStagnationStreak: prev.browserStagnationStreak,
    dispatchedInRun: prev.dispatchedInRun,
  };

  if (outcomes.length === 0) {
    return { state: next, action: "none" };
  }

  for (const outcome of outcomes) {
    if (outcome.name === "kulo_dispatch" && !outcome.isError) {
      next.dispatchedInRun = true;
    }
  }

  // Ignore rounds where every tool was blocked by run-health itself so ceiling wrap-up is never reclassified.
  const actionable = outcomes.filter((o) => !isRunHealthSelfBlock(o));
  if (actionable.length === 0) {
    return { state: next, action: "none" };
  }

  // 1. Identical tool + canonical args streak
  const roundCallFp = actionable
    .map((o) => fingerprintToolCall(o.name, o.arguments))
    .sort()
    .join("|");
  if (roundCallFp === next.lastCallFingerprint) {
    next.identicalCallStreak += 1;
  } else {
    next.lastCallFingerprint = roundCallFp;
    next.identicalCallStreak = 1;
  }

  // 2. Identical tool error streak (resets whenever any call in the round succeeds)
  if (actionable.every((o) => o.isError)) {
    const roundErrFp = actionable
      .map((o) => fingerprintToolError(o.name, o.errorCode, o.errorText))
      .sort()
      .join("|");
    if (roundErrFp === next.lastErrorFingerprint) {
      next.identicalErrorStreak += 1;
    } else {
      next.lastErrorFingerprint = roundErrFp;
      next.identicalErrorStreak = 1;
    }
  } else {
    next.identicalErrorStreak = 0;
    delete next.lastErrorFingerprint;
  }

  // 3. Browser stagnation streak (advances ONLY on kulo_browser calls that actually returned a snapshot)
  for (const outcome of actionable) {
    if (outcome.name !== "kulo_browser" || outcome.isError) continue;
    const snap = extractBrowserSnapshotFingerprint(outcome.outputText, outcome.extraOutputTexts);
    if (!snap) continue;
    if (snap.key === next.lastBrowserSnapshotKey) {
      next.browserStagnationStreak += 1;
    } else {
      next.lastBrowserSnapshotKey = snap.key;
      next.browserStagnationStreak = 1;
    }
  }

  // Brake checks first
  if (next.identicalCallStreak >= IDENTICAL_CALL_BRAKE_STREAK) {
    const detail = `连续 ${next.identicalCallStreak} 轮重复相同工具调用 (${actionable.map((o) => o.name).join(",")})`;
    return {
      state: next,
      action: "brake",
      warning: { kind: "identical_call", streak: next.identicalCallStreak, detail },
      brakeReason: detail,
    };
  }
  if (next.identicalErrorStreak >= IDENTICAL_ERROR_BRAKE_STREAK) {
    const detail = `连续 ${next.identicalErrorStreak} 轮触发相同工具错误 (${actionable.map((o) => o.name).join(",")})`;
    return {
      state: next,
      action: "brake",
      warning: { kind: "identical_error", streak: next.identicalErrorStreak, detail },
      brakeReason: detail,
    };
  }
  if (next.browserStagnationStreak >= BROWSER_STAGNATION_BRAKE_STREAK) {
    const detail = `连续 ${next.browserStagnationStreak} 次浏览器快照页面无实质变化`;
    return {
      state: next,
      action: "brake",
      warning: { kind: "browser_stagnation", streak: next.browserStagnationStreak, detail },
      brakeReason: detail,
    };
  }

  // Warning checks
  if (next.identicalCallStreak >= IDENTICAL_CALL_WARN_STREAK) {
    return {
      state: next,
      action: "warn",
      warning: {
        kind: "identical_call",
        streak: next.identicalCallStreak,
        detail: `已连续 ${next.identicalCallStreak} 轮重复完全相同的工具调用 (${actionable.map((o) => o.name).join(",")})`,
      },
    };
  }
  if (next.identicalErrorStreak >= IDENTICAL_ERROR_WARN_STREAK) {
    return {
      state: next,
      action: "warn",
      warning: {
        kind: "identical_error",
        streak: next.identicalErrorStreak,
        detail: `已连续 ${next.identicalErrorStreak} 轮出现相同的工具报错 (${actionable.map((o) => o.name).join(",")})`,
      },
    };
  }
  if (next.browserStagnationStreak >= BROWSER_STAGNATION_WARN_STREAK) {
    return {
      state: next,
      action: "warn",
      warning: {
        kind: "browser_stagnation",
        streak: next.browserStagnationStreak,
        detail: `已连续 ${next.browserStagnationStreak} 次浏览器页面快照未发生变化`,
      },
    };
  }

  return { state: next, action: "none" };
}

function safeUrlHostAndPath(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    // Strip userinfo, query parameters, and hash fragments to prevent token leakage.
    const cleanPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.slice(0, 48) : "";
    return `${parsed.host}${cleanPath}`;
  } catch {
    return undefined;
  }
}

function safeFileBasename(rawPath: unknown): string | undefined {
  if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
  const base = path.basename(rawPath.trim());
  return base ? base.slice(0, 64) : undefined;
}

function safeBashVerb(rawCmd: unknown): string {
  if (typeof rawCmd !== "string" || !rawCmd.trim()) return "";
  const tokens = rawCmd.trim().split(/\s+/).filter(Boolean);
  const safeParts: string[] = [];
  for (const token of tokens) {
    if (safeParts.length >= 2) break;
    // Skip env assignments (KEY=VAL), URLs, paths with secrets, or flag values.
    if (token.includes("=") || token.includes("://") || token.startsWith("-")) break;
    if (!/^[a-zA-Z0-9._/@:-]{1,32}$/.test(token)) break;
    safeParts.push(path.basename(token));
  }
  return safeParts.join(" ").slice(0, 48);
}

const GENERIC_ALLOWLIST_KEYS = [
  "action",
  "mode",
  "state",
  "role",
  "target",
  "ref",
  "app",
  "direction",
  "kind",
  "execution_domain",
  "task_kind",
] as const;

/**
 * Strict allowlist argument summarizer for Layer-2 health judge trajectory input.
 * Structurally drops `kulo_browser` `fill`/`type`/`batch[*].text`, `kulo_desktop` `text`,
 * and ALL `kulo_connection_use` (and `kulo_connection_*`) arguments.
 */
export function summarizeToolArgsAllowlist(toolName: string, args: unknown): string {
  // Structurally drop all connection tool arguments (tokens, endpoints, headers, credentials).
  if (toolName === "kulo_connection_use" || toolName.startsWith("kulo_connection_")) {
    return "";
  }

  const record = asRecord(args);
  if (!record) return "";

  if (toolName === "kulo_browser") {
    const parts: string[] = [];
    if (typeof record.action === "string") parts.push(`action=${record.action.slice(0, 24)}`);
    const hostPath = safeUrlHostAndPath(record.url);
    if (hostPath) parts.push(`url=${hostPath}`);
    if (typeof record.ref === "string") parts.push(`ref=${record.ref.slice(0, 24)}`);
    if (typeof record.direction === "string") parts.push(`dir=${record.direction.slice(0, 12)}`);
    if (typeof record.amount === "number" && Number.isFinite(record.amount)) parts.push(`amount=${record.amount}`);
    if (typeof record.mode === "string") parts.push(`mode=${record.mode.slice(0, 16)}`);
    if (typeof record.snapshotMode === "string") parts.push(`snapshotMode=${record.snapshotMode.slice(0, 16)}`);
    if (typeof record.returnSnapshot === "boolean") parts.push(`returnSnapshot=${record.returnSnapshot}`);
    if (Array.isArray(record.steps)) {
      const stepSummaries = record.steps.slice(0, 5).map((rawStep) => {
        const step = asRecord(rawStep);
        if (!step) return "?";
        const a = typeof step.action === "string" ? step.action.slice(0, 16) : "?";
        const r = typeof step.ref === "string" ? `(${step.ref.slice(0, 16)})` : "";
        const d = typeof step.direction === "string" ? `(${step.direction.slice(0, 12)})` : "";
        // Structurally omit step.text even for fill/type/wait.
        return `${a}${r}${d}`;
      });
      parts.push(`steps=[${stepSummaries.join(",")}]`);
    }
    return parts.join(" ");
  }

  if (toolName === "kulo_desktop") {
    const parts: string[] = [];
    if (typeof record.action === "string") parts.push(`action=${record.action.slice(0, 24)}`);
    if (typeof record.app === "string") parts.push(`app=${record.app.slice(0, 32)}`);
    if (typeof record.ref === "string") parts.push(`ref=${record.ref.slice(0, 32)}`);
    if (typeof record.direction === "string") parts.push(`dir=${record.direction.slice(0, 12)}`);
    if (typeof record.amount === "number" && Number.isFinite(record.amount)) parts.push(`amount=${record.amount}`);
    // Structurally omit record.text.
    return parts.join(" ");
  }

  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const parts: string[] = [];
    const base = safeFileBasename(record.path ?? record.file_path ?? record.filePath);
    if (base) parts.push(`file=${base}`);
    if (typeof record.offset === "number" && Number.isFinite(record.offset)) parts.push(`offset=${record.offset}`);
    if (typeof record.limit === "number" && Number.isFinite(record.limit)) parts.push(`limit=${record.limit}`);
    return parts.join(" ");
  }

  if (toolName === "bash") {
    const verb = safeBashVerb(record.command ?? record.cmd);
    return verb ? `cmd=${verb}` : "";
  }

  if (toolName === "web_fetch") {
    const hostPath = safeUrlHostAndPath(record.url);
    return hostPath ? `url=${hostPath}` : "";
  }

  if (toolName === "kulo_dispatch") {
    const parts: string[] = [];
    if (typeof record.role === "string") parts.push(`role=${record.role.slice(0, 24)}`);
    if (typeof record.task_kind === "string") parts.push(`task_kind=${record.task_kind.slice(0, 24)}`);
    if (typeof record.execution_domain === "string") parts.push(`domain=${record.execution_domain.slice(0, 16)}`);
    if (typeof record.inherit_browser_session === "boolean") {
      parts.push(`inherit_browser=${record.inherit_browser_session}`);
    }
    return parts.join(" ");
  }

  if (toolName === "kulo_report") {
    return typeof record.state === "string" ? `state=${record.state.slice(0, 24)}` : "";
  }

  if (toolName === "kulo_computer_handoff") {
    return typeof record.target === "string" ? `target=${record.target.slice(0, 24)}` : "";
  }

  const parts: string[] = [];
  for (const key of GENERIC_ALLOWLIST_KEYS) {
    const val = record[key];
    if (typeof val === "string" && val.trim() && val.length <= 32 && !/\s/.test(val.trim())) {
      parts.push(`${key}=${val.trim()}`);
    } else if (typeof val === "boolean" || (typeof val === "number" && Number.isFinite(val))) {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.join(" ");
}

export function buildJudgeTrajectoryTurn(
  turn: number,
  outcomes: readonly ObservedToolCallOutcome[],
): JudgeTrajectoryTurn {
  return {
    turn,
    tools: outcomes.map((o) => ({
      name: o.name,
      argSummary: summarizeToolArgsAllowlist(o.name, o.arguments),
      ok: !o.isError,
      ...(o.isError && o.errorCode ? { errorCode: o.errorCode } : {}),
      ...(typeof o.durationMs === "number" && Number.isFinite(o.durationMs)
        ? { durationMs: Math.max(0, Math.round(o.durationMs)) }
        : {}),
    })),
  };
}

export function buildJudgeTrajectorySummary(input: {
  role: RunHealthRole;
  turnsUsed: number;
  effectiveTurnsSinceInput: number;
  maxTurns: number;
  userGoal: string;
  recentTurns: readonly JudgeTrajectoryTurn[];
  doomLoop: DoomLoopTrackerState;
}): JudgeTrajectoryInput {
  const cleanGoal = input.userGoal.replace(/\s+/g, " ").trim().slice(0, JUDGE_GOAL_MAX_CHARS);
  return {
    role: input.role,
    turnsUsed: input.turnsUsed,
    effectiveTurnsSinceInput: input.effectiveTurnsSinceInput,
    maxTurns: input.maxTurns,
    userGoal: cleanGoal,
    recentTurns: input.recentTurns.slice(-JUDGE_RECENT_TURNS_WINDOW),
    signals: {
      identicalCallStreak: input.doomLoop.identicalCallStreak,
      identicalErrorStreak: input.doomLoop.identicalErrorStreak,
      browserStagnationStreak: input.doomLoop.browserStagnationStreak,
      dispatchedInRun: input.doomLoop.dispatchedInRun,
    },
  };
}

/** Strict JSON parser & validator for Layer-2 health judge verdicts. Returns `null` on any invalid output. */
export function parseRunHealthJudgeVerdict(raw: string): RunHealthJudgeVerdict | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenced && fenced[1]) {
    candidate = fenced[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const obj = asRecord(parsed);
  if (!obj) return null;

  const verdict = obj.verdict;
  if (verdict !== "healthy" && verdict !== "handoff_or_wrap" && verdict !== "stuck") {
    return null;
  }

  if (typeof obj.reason !== "string" || !obj.reason.trim()) {
    return null;
  }

  let guidance: string | undefined;
  if (obj.guidance !== undefined) {
    if (typeof obj.guidance !== "string") return null;
    const trimmedGuidance = obj.guidance.trim().slice(0, 400);
    if (trimmedGuidance) guidance = trimmedGuidance;
  }

  return {
    verdict,
    reason: obj.reason.trim().slice(0, 300),
    ...(guidance ? { guidance } : {}),
  };
}

export function buildSoftHandoffGuidance(effectiveTurns: number): string {
  return (
    `[KULO_RUN_HEALTH:SOFT_HANDOFF] 本轮已执行 ${effectiveTurns} 步。` +
    "若 2–3 步内即可收尾请尽快直接向用户汇报；若仍有较多步骤（如多页浏览、批量修改或长链路排查），" +
    "请立即整理当前已确认的进展，调用 `kulo_dispatch`（若已打开目标网页可附带 `inherit_browser_session: true`）交由后台 Worker 接力完成。"
  );
}

export function buildDeterministicWarningGuidance(role: RunHealthRole, warning: RunHealthWarning): string {
  const nextStep =
    role === "orchestrator"
      ? "请立即改变排查策略或参数，避免重复无效调用；若任务链路较长请改用 `kulo_dispatch` 交由后台 Worker，或直接向用户说明卡点。"
      : role === "worker"
        ? "请立即改变策略或参数，避免重复无效调用；若确认受阻请尽快单独调用 `kulo_report` 如实汇报进展与卡点。"
        : "请立即改变策略，避免重复无效调用；若信息已足够或受阻请直接用文字总结返回结果。";
  return `[KULO_RUN_HEALTH:WARNING] ${warning.detail}。${nextStep}`;
}

export function buildJudgeGuidance(role: RunHealthRole, verdict: RunHealthJudgeVerdict): string {
  const advice = verdict.guidance ? `建议：${verdict.guidance}` : "";
  const roleHint =
    role === "orchestrator"
      ? "若能在 2–3 步内完成请尽快收尾；否则请整理进展通过 `kulo_dispatch` 转交后台 Worker 或直接向用户汇报。"
      : role === "worker"
        ? "请收敛剩余关键步骤并尽快单独调用 `kulo_report` 汇报阶段成果与卡点。"
        : "请尽快收敛并直接输出简洁结论。";
  return `[KULO_RUN_HEALTH:CHECK] 进度评估提示（${verdict.reason}）。${advice ? `${advice} ` : ""}${roleHint}`;
}

export function buildWrapUpGuidance(input: {
  role: RunHealthRole;
  source: RunHealthWrapUpSource;
  turns: number;
  maxTurns: number;
  reason?: string;
  allowDispatch?: boolean;
}): string {
  const cause =
    input.source === "turn_limit"
      ? `已接近本轮执行步数上限（${input.turns}/${input.maxTurns}）`
      : `检测到连续重复或停滞（${input.reason || "循环无进展"}）`;

  if (input.role === "worker") {
    return (
      `[KULO_RUN_HEALTH:WRAP_UP] ${cause}，必须立即收口。` +
      "本轮**只允许单独调用一次 `kulo_report`**（严禁与其他任何工具并行调用，其他工具已被拦截），" +
      "请在 `kulo_report` 中如实汇报已完成内容、未完成项与卡点。"
    );
  }
  if (input.role === "subagent") {
    return (
      `[KULO_RUN_HEALTH:WRAP_UP] ${cause}，所有工具已暂停。` +
      "请不要再调用工具，直接用纯文字返回当前已收集的结论、证据与未完成项。"
    );
  }
  if (input.allowDispatch) {
    return (
      `[KULO_RUN_HEALTH:WRAP_UP] ${cause}，请立即收口。` +
      "如需交由后台继续执行，本轮仅允许单独调用一次 `kulo_dispatch`（若浏览器会话仍在进行可带 `inherit_browser_session: true`）；" +
      "其他工具均已被拦截。否则请直接用文字向用户清晰汇报当前已完成内容、卡点与下一步建议。"
    );
  }
  return (
    `[KULO_RUN_HEALTH:WRAP_UP] ${cause}，本轮工具调用已停止。` +
    "请不要再调用任何工具，直接用文字向用户清晰说明当前已完成内容、具体卡点与下一步建议。"
  );
}

export function buildBeforeToolBlockMessage(input: {
  role: RunHealthRole;
  source: RunHealthWrapUpSource;
  toolName: string;
  reason?: string;
  allowDispatch?: boolean;
}): string {
  if (input.role === "worker") {
    return (
      `${RUN_HEALTH_BLOCK_MARKER} Wrap-up active: \`${input.toolName}\` is blocked. ` +
      "请立即单独调用 `kulo_report` 汇报当前结果与卡点（禁止并行调用其他工具）。"
    );
  }
  if (input.role === "subagent") {
    return (
      `${RUN_HEALTH_BLOCK_MARKER} Wrap-up active: \`${input.toolName}\` is blocked. ` +
      "请停止调用工具，直接用文字总结当前结果并结束。"
    );
  }
  if (input.allowDispatch) {
    return (
      `${RUN_HEALTH_BLOCK_MARKER} Turn ceiling wrap-up active: \`${input.toolName}\` is blocked. ` +
      "请直接向用户汇报进度，或仅调用一次 `kulo_dispatch` 交由后台 Worker 接力。"
    );
  }
  const suffix = input.reason ? ` (${input.reason})` : "";
  return (
    `${RUN_HEALTH_BLOCK_MARKER} Wrap-up active${suffix}: \`${input.toolName}\` is blocked. ` +
    "请停止调用工具，直接用文字向用户说明当前进展与卡点。"
  );
}
