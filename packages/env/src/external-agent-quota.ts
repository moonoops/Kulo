import {
  EXTERNAL_AGENT_KINDS,
  redactSensitiveText,
  type ExternalAgentKind,
  type ExternalAgentQuotaCredits,
  type ExternalAgentQuotaProbeResult,
  type ExternalAgentQuotaSeverity,
  type ExternalAgentQuotaStatus,
  type ExternalAgentQuotaWindow,
} from "@kulo/protocol";

const PROBE_ALLOWED_KEYS = new Set([
  "kind",
  "status",
  "source",
  "fetchedAt",
  "planLabel",
  "ordinaryUsageAllowed",
  "windows",
  "credits",
  "error",
]);

const WINDOW_ALLOWED_KEYS = new Set([
  "id",
  "label",
  "usedPercent",
  "windowMinutes",
  "resetsAt",
  "severity",
  "bucketLabel",
]);

const CREDITS_ALLOWED_KEYS = new Set([
  "hasCredits",
  "unlimited",
  "balanceText",
  "usedPercent",
  "isExtraUsage",
]);

const PROBE_STATUSES = new Set<Exclude<ExternalAgentQuotaStatus, "device_offline" | "env_outdated">>([
  "ok",
  "api_key_billing",
  "unauthenticated",
  "unsupported",
  "unavailable",
]);

const QUOTA_SEVERITIES = new Set<ExternalAgentQuotaSeverity>(["normal", "warning", "exhausted"]);

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const BALANCE_TEXT_WHITELIST_RE = /^[$€£¥₩A-Z0-9.,/\s-]{1,48}$/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const LOCAL_USER_PATH_RE = /(?:\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\Users\\)[^\s"'`:;,)\]]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const CODEX_PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  sci: "Science",
  sci_plus: "Science Plus",
};

const CLAUDE_PLAN_LABELS: Readonly<Record<string, string>> = {
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
};

const GROK_PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  supergrok: "SuperGrok",
  super_grok: "SuperGrok",
  supergrok_heavy: "Heavy",
  heavy: "Heavy",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCleanNonEmptyString(value: unknown, maxLen: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen && !CONTROL_CHAR_RE.test(value);
}

function cleanOptionalText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

export function clampQuotaPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function normalizeQuotaTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0) {
        return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
      }
      return undefined;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function normalizeQuotaPlanLabel(kind: ExternalAgentKind, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key || key === "unknown" || key === "none") return undefined;
  if (kind === "codex") return CODEX_PLAN_LABELS[key];
  if (kind === "claude-code") return CLAUDE_PLAN_LABELS[key];
  if (kind === "grok") return GROK_PLAN_LABELS[key];
  return undefined;
}

export function sanitizeQuotaError(raw: unknown, extraRedact?: (value: string) => string): string | undefined {
  if (typeof raw !== "string") return undefined;
  let text = redactSensitiveText(raw);
  if (extraRedact) text = redactSensitiveText(extraRedact(text));
  text = text
    .replace(EMAIL_RE, "[email]")
    .replace(LOCAL_USER_PATH_RE, "[path]")
    .replace(UUID_RE, "[id]")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.slice(0, 200);
}

export function sanitizeQuotaBalanceText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed || !BALANCE_TEXT_WHITELIST_RE.test(trimmed)) return undefined;
  return trimmed;
}

export function formatQuotaCurrencyAmount(minorUnits: number, currency?: string | null): string | undefined {
  if (!Number.isFinite(minorUnits)) return undefined;
  const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency.trim())
    ? currency.trim().toUpperCase()
    : "USD";
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    const major = minorUnits / 10 ** digits;
    const formatted = formatter.format(major).replace(/\u00a0/g, " ");
    const safe = sanitizeQuotaBalanceText(formatted);
    if (safe) return safe;
    return sanitizeQuotaBalanceText(`${code} ${major.toFixed(digits)}`);
  } catch {
    return sanitizeQuotaBalanceText(`$${(minorUnits / 100).toFixed(2)}`);
  }
}

function formatWindowDurationLabel(minutes: number | undefined, fallback: string): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function deriveSeverity(usedPercent: number, forcedExhausted = false, forcedWarning = false): ExternalAgentQuotaSeverity {
  if (forcedExhausted || usedPercent >= 95) return "exhausted";
  if (forcedWarning || usedPercent >= 80) return "warning";
  return "normal";
}

function sanitizeBucketLabel(raw: unknown): string | undefined {
  const cleaned = cleanOptionalText(raw, 40);
  if (!cleaned) return undefined;
  if (EMAIL_RE.test(cleaned)) {
    EMAIL_RE.lastIndex = 0;
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/\s-]{0,39}$/.test(cleaned)) return undefined;
  return cleaned;
}

export function isValidQuotaProbeResult(value: unknown): value is ExternalAgentQuotaProbeResult {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!PROBE_ALLOWED_KEYS.has(key)) return false;
  }
  if (!EXTERNAL_AGENT_KINDS.includes(value.kind as ExternalAgentKind)) return false;
  if (typeof value.status !== "string" || !PROBE_STATUSES.has(value.status as ExternalAgentQuotaProbeResult["status"])) return false;
  if (value.source !== "live" && value.source !== "passive_run") return false;
  if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0) return false;
  if (value.planLabel !== undefined && !isCleanNonEmptyString(value.planLabel, 48)) return false;
  if (value.ordinaryUsageAllowed !== undefined && typeof value.ordinaryUsageAllowed !== "boolean") return false;
  if (value.error !== undefined && !isCleanNonEmptyString(value.error, 400)) return false;
  if (!Array.isArray(value.windows) || value.windows.length > 16) return false;
  for (const win of value.windows) {
    if (!isPlainObject(win)) return false;
    for (const key of Object.keys(win)) {
      if (!WINDOW_ALLOWED_KEYS.has(key)) return false;
    }
    if (!isCleanNonEmptyString(win.id, 80)) return false;
    if (!isCleanNonEmptyString(win.label, 80)) return false;
    if (typeof win.usedPercent !== "number" || !Number.isFinite(win.usedPercent) || win.usedPercent < 0 || win.usedPercent > 100) return false;
    if (win.windowMinutes !== undefined && (typeof win.windowMinutes !== "number" || !Number.isFinite(win.windowMinutes) || win.windowMinutes <= 0)) return false;
    if (win.resetsAt !== undefined && (typeof win.resetsAt !== "number" || !Number.isFinite(win.resetsAt) || win.resetsAt <= 0)) return false;
    if (win.severity !== undefined && (typeof win.severity !== "string" || !QUOTA_SEVERITIES.has(win.severity as ExternalAgentQuotaSeverity))) return false;
    if (win.bucketLabel !== undefined && !isCleanNonEmptyString(win.bucketLabel, 80)) return false;
  }
  if (value.credits !== undefined) {
    const credits = value.credits;
    if (!isPlainObject(credits)) return false;
    for (const key of Object.keys(credits)) {
      if (!CREDITS_ALLOWED_KEYS.has(key)) return false;
    }
    if (typeof credits.hasCredits !== "boolean") return false;
    if (credits.unlimited !== undefined && typeof credits.unlimited !== "boolean") return false;
    if (credits.balanceText !== undefined && (!isCleanNonEmptyString(credits.balanceText, 48) || !BALANCE_TEXT_WHITELIST_RE.test(credits.balanceText))) return false;
    if (credits.usedPercent !== undefined && (typeof credits.usedPercent !== "number" || !Number.isFinite(credits.usedPercent) || credits.usedPercent < 0 || credits.usedPercent > 100)) return false;
    if (credits.isExtraUsage !== undefined && typeof credits.isExtraUsage !== "boolean") return false;
  }
  return true;
}

export function mergeQuotaProbeResults(
  previous: ExternalAgentQuotaProbeResult | undefined,
  incoming: ExternalAgentQuotaProbeResult,
): ExternalAgentQuotaProbeResult {
  if (!previous || previous.kind !== incoming.kind || previous.status !== "ok" || incoming.status !== "ok") {
    return incoming;
  }
  const mergedWindows = previous.windows.map((win) => ({ ...win }));
  const byId = new Map(mergedWindows.map((win, index) => [win.id, index]));
  for (const win of incoming.windows) {
    const idx = byId.get(win.id);
    if (idx !== undefined) {
      mergedWindows[idx] = { ...mergedWindows[idx], ...win };
    } else if (mergedWindows.length < 16) {
      byId.set(win.id, mergedWindows.length);
      mergedWindows.push({ ...win });
    }
  }
  return {
    ...incoming,
    ...(incoming.planLabel ?? previous.planLabel ? { planLabel: incoming.planLabel ?? previous.planLabel } : {}),
    ...(incoming.ordinaryUsageAllowed !== undefined
      ? { ordinaryUsageAllowed: incoming.ordinaryUsageAllowed }
      : previous.ordinaryUsageAllowed !== undefined
        ? { ordinaryUsageAllowed: previous.ordinaryUsageAllowed }
        : {}),
    ...(incoming.credits ?? previous.credits ? { credits: incoming.credits ?? previous.credits } : {}),
    windows: mergedWindows,
  };
}

function parseCodexCredits(raw: unknown): ExternalAgentQuotaCredits | undefined {
  if (!isPlainObject(raw)) return undefined;
  const hasCredits = Boolean(raw.hasCredits);
  const unlimited = typeof raw.unlimited === "boolean" ? raw.unlimited : undefined;
  let balanceText: string | undefined;
  if (typeof raw.balance === "string" || typeof raw.balance === "number") {
    const rawStr = String(raw.balance).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(rawStr)) {
      const num = Number(rawStr);
      if (Number.isFinite(num)) balanceText = sanitizeQuotaBalanceText(`$${num.toFixed(2)}`);
    } else {
      balanceText = sanitizeQuotaBalanceText(rawStr);
    }
  }
  if (!hasCredits && !unlimited && !balanceText) return undefined;
  return {
    hasCredits,
    ...(unlimited !== undefined ? { unlimited } : {}),
    ...(balanceText ? { balanceText } : {}),
  };
}

export function parseCodexRateLimitsSnapshot(
  payload: unknown,
  options: {
    source: "live" | "passive_run";
    fetchedAt?: number;
    accountPlanType?: unknown;
  },
): ExternalAgentQuotaProbeResult | undefined {
  const fetchedAt = options.fetchedAt ?? Date.now();
  if (!isPlainObject(payload)) return undefined;

  const ordinaryUsageAllowed = typeof payload.ordinaryUsageAllowed === "boolean"
    ? payload.ordinaryUsageAllowed
    : undefined;

  const bucketEntries: Array<{ key: string; snapshot: Record<string, unknown> }> = [];
  if (isPlainObject(payload.rateLimitsByLimitId)) {
    const entries = Object.entries(payload.rateLimitsByLimitId)
      .filter(([, val]) => isPlainObject(val))
      .sort(([a], [b]) => {
        if (a === "codex" && b !== "codex") return -1;
        if (b === "codex" && a !== "codex") return 1;
        return a.localeCompare(b);
      });
    for (const [key, val] of entries) {
      bucketEntries.push({ key, snapshot: val as Record<string, unknown> });
    }
  }
  if (bucketEntries.length === 0) {
    const single = isPlainObject(payload.rateLimits) ? payload.rateLimits : payload;
    if (isPlainObject(single)) {
      const key = typeof single.limitId === "string" && single.limitId.trim() ? single.limitId.trim() : "codex";
      bucketEntries.push({ key, snapshot: single });
    }
  }

  let planLabel = normalizeQuotaPlanLabel("codex", options.accountPlanType);
  let credits: ExternalAgentQuotaCredits | undefined;
  const windows: ExternalAgentQuotaWindow[] = [];
  const multiBucket = bucketEntries.length > 1;

  for (const { key, snapshot } of bucketEntries) {
    if (!planLabel) planLabel = normalizeQuotaPlanLabel("codex", snapshot.planType);
    if (!credits) credits = parseCodexCredits(snapshot.credits);

    const bucketExhausted =
      ordinaryUsageAllowed === false ||
      snapshot.spendControlReached === true ||
      (snapshot.rateLimitReachedType !== undefined && snapshot.rateLimitReachedType !== null);

    const bucketLabel = multiBucket && key !== "codex"
      ? sanitizeBucketLabel(snapshot.limitName ?? snapshot.normalModelSlug ?? key)
      : undefined;

    for (const slot of ["primary", "secondary"] as const) {
      const rawWin = snapshot[slot];
      if (!isPlainObject(rawWin) || typeof rawWin.usedPercent !== "number" || !Number.isFinite(rawWin.usedPercent)) continue;
      if (windows.length >= 16) break;
      const usedPercent = clampQuotaPercent(rawWin.usedPercent);
      const windowMinutes =
        typeof rawWin.windowDurationMins === "number" && Number.isFinite(rawWin.windowDurationMins) && rawWin.windowDurationMins > 0
          ? Math.round(rawWin.windowDurationMins)
          : undefined;
      const resetsAt = normalizeQuotaTimestampMs(rawWin.resetsAt);
      const durationLabel = formatWindowDurationLabel(windowMinutes, slot === "primary" ? "5h" : "7d");
      const label = bucketLabel ? `${bucketLabel} ${durationLabel}`.slice(0, 80) : durationLabel;
      windows.push({
        id: `${key}:${slot}`.slice(0, 80),
        label,
        usedPercent,
        ...(windowMinutes !== undefined ? { windowMinutes } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        severity: deriveSeverity(usedPercent, bucketExhausted),
        ...(bucketLabel ? { bucketLabel } : {}),
      });
    }
  }

  if (windows.length === 0 && !credits && !planLabel && ordinaryUsageAllowed === undefined) {
    return undefined;
  }

  return {
    kind: "codex",
    status: "ok",
    source: options.source,
    fetchedAt,
    ...(planLabel ? { planLabel } : {}),
    ...(ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
    windows,
    ...(credits ? { credits } : {}),
  };
}

export function parseClaudeControlUsageResponse(
  response: unknown,
  fetchedAt = Date.now(),
): ExternalAgentQuotaProbeResult {
  if (!isPlainObject(response)) {
    return {
      kind: "claude-code",
      status: "unavailable",
      source: "live",
      fetchedAt,
      windows: [],
      error: "Claude Code returned an unexpected usage payload",
    };
  }
  const planLabel = normalizeQuotaPlanLabel("claude-code", response.subscription_type);
  const available = response.rate_limits_available === true;
  const limits = isPlainObject(response.rate_limits) ? response.rate_limits : null;

  if (!available || !limits) {
    const isApiBilling = response.subscription_type === null || response.subscription_type === undefined;
    return {
      kind: "claude-code",
      status: isApiBilling ? "api_key_billing" : "unavailable",
      source: "live",
      fetchedAt,
      ...(planLabel ? { planLabel } : {}),
      windows: [],
      ...(!isApiBilling ? { error: "Plan rate limits are currently unavailable" } : {}),
    };
  }

  const windows: ExternalAgentQuotaWindow[] = [];
  const namedBuckets: Array<{ key: string; id: string; label: string; windowMinutes: number }> = [
    { key: "five_hour", id: "five_hour", label: "5h", windowMinutes: 300 },
    { key: "seven_day", id: "seven_day", label: "7d", windowMinutes: 10080 },
    { key: "seven_day_sonnet", id: "seven_day_sonnet", label: "Sonnet 7d", windowMinutes: 10080 },
    { key: "seven_day_opus", id: "seven_day_opus", label: "Opus 7d", windowMinutes: 10080 },
    { key: "seven_day_oauth_apps", id: "seven_day_oauth_apps", label: "OAuth Apps 7d", windowMinutes: 10080 },
  ];

  for (const bucket of namedBuckets) {
    const entry = limits[bucket.key];
    if (!isPlainObject(entry) || typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization)) continue;
    const usedPercent = clampQuotaPercent(entry.utilization);
    const resetsAt = normalizeQuotaTimestampMs(entry.resets_at);
    windows.push({
      id: bucket.id,
      label: bucket.label,
      usedPercent,
      windowMinutes: bucket.windowMinutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      severity: deriveSeverity(usedPercent),
    });
  }

  if (Array.isArray(limits.model_scoped)) {
    for (const rawScoped of limits.model_scoped) {
      if (windows.length >= 16) break;
      if (!isPlainObject(rawScoped) || typeof rawScoped.utilization !== "number" || !Number.isFinite(rawScoped.utilization)) continue;
      const modelName = sanitizeBucketLabel(rawScoped.display_name);
      if (!modelName) continue;
      const id = `model:${modelName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`.slice(0, 80);
      if (windows.some((w) => w.id === id)) continue;
      const usedPercent = clampQuotaPercent(rawScoped.utilization);
      const resetsAt = normalizeQuotaTimestampMs(rawScoped.resets_at);
      windows.push({
        id,
        label: `${modelName} 7d`.slice(0, 80),
        usedPercent,
        windowMinutes: 10080,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        severity: deriveSeverity(usedPercent),
        bucketLabel: modelName,
      });
    }
  }

  let credits: ExternalAgentQuotaCredits | undefined;
  if (isPlainObject(limits.extra_usage) && limits.extra_usage.is_enabled === true) {
    const extra = limits.extra_usage;
    const currency = typeof extra.currency === "string" ? extra.currency : "USD";
    const usedText = typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits)
      ? formatQuotaCurrencyAmount(extra.used_credits, currency)
      : undefined;
    const limitText = typeof extra.monthly_limit === "number" && Number.isFinite(extra.monthly_limit)
      ? formatQuotaCurrencyAmount(extra.monthly_limit, currency)
      : undefined;
    const balanceText = usedText && limitText
      ? sanitizeQuotaBalanceText(`${usedText} / ${limitText}`)
      : usedText;
    const usedPercent = typeof extra.utilization === "number" && Number.isFinite(extra.utilization)
      ? clampQuotaPercent(extra.utilization)
      : undefined;
    credits = {
      hasCredits: true,
      isExtraUsage: true,
      ...(balanceText ? { balanceText } : {}),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
    };
  }

  return {
    kind: "claude-code",
    status: "ok",
    source: "live",
    fetchedAt,
    ...(planLabel ? { planLabel } : {}),
    windows,
    ...(credits ? { credits } : {}),
  };
}

const CLAUDE_RATE_LIMIT_TYPE_META: Readonly<Record<string, { label: string; windowMinutes?: number }>> = {
  five_hour: { label: "5h", windowMinutes: 300 },
  seven_day: { label: "7d", windowMinutes: 10080 },
  seven_day_sonnet: { label: "Sonnet 7d", windowMinutes: 10080 },
  seven_day_opus: { label: "Opus 7d", windowMinutes: 10080 },
  seven_day_overage_included: { label: "7d", windowMinutes: 10080 },
  overage: { label: "Extra" },
};

/**
 * Passive SDKRateLimitInfo parser.
 * Verified against Claude CLI 2.1.326: `utilization` in `rate_limit_event` is ALWAYS a 0-1+ ratio
 * (legitimately > 1 when in overage/deprioritized usage, e.g. 1.08 = 108%), and `resetsAt` is Unix seconds.
 */
export function parseClaudeRateLimitEvent(
  info: unknown,
  fetchedAt = Date.now(),
): ExternalAgentQuotaProbeResult | undefined {
  if (!isPlainObject(info)) return undefined;
  const windows: ExternalAgentQuotaWindow[] = [];

  const pushWindow = (
    rawType: unknown,
    rawUtil: unknown,
    rawReset: unknown,
    rawStatus: unknown,
  ) => {
    if (windows.length >= 16) return;
    if (typeof rawType !== "string" || !rawType.trim()) return;
    const id = rawType.trim().slice(0, 80);
    const meta = CLAUDE_RATE_LIMIT_TYPE_META[id];
    if (!meta) return;
    if (typeof rawUtil !== "number" || !Number.isFinite(rawUtil) || rawUtil < 0) return;
    const usedPercent = clampQuotaPercent(rawUtil * 100);
    const resetsAt = normalizeQuotaTimestampMs(rawReset);
    const severity = deriveSeverity(
      usedPercent,
      rawStatus === "rejected",
      rawStatus === "allowed_warning",
    );
    if (!windows.some((w) => w.id === id)) {
      windows.push({
        id,
        label: meta.label,
        usedPercent,
        ...(meta.windowMinutes !== undefined ? { windowMinutes: meta.windowMinutes } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        severity,
      });
    }
  };

  if (isPlainObject(info.unifiedWindows)) {
    for (const [key, entry] of Object.entries(info.unifiedWindows)) {
      if (!isPlainObject(entry)) continue;
      pushWindow(key, entry.utilization, entry.resetsAt ?? entry.resets_at, entry.status ?? info.status);
    }
  }
  if (windows.length === 0) {
    pushWindow(info.rateLimitType, info.utilization, info.resetsAt, info.status);
  }

  let credits: ExternalAgentQuotaCredits | undefined;
  if (info.isUsingOverage === true || info.overageInUse === true || info.overageEnabled === true) {
    credits = { hasCredits: true, isExtraUsage: true };
  }

  if (windows.length === 0 && !credits) return undefined;

  return {
    kind: "claude-code",
    status: "ok",
    source: "passive_run",
    fetchedAt,
    ...(info.status === "rejected" ? { ordinaryUsageAllowed: false } : info.status === "allowed" || info.status === "allowed_warning" ? { ordinaryUsageAllowed: true } : {}),
    windows,
    ...(credits ? { credits } : {}),
  };
}

export function isGrokTeamManagedOutput(text: string): boolean {
  return /usage limits are managed by your team/i.test(text);
}

export function isGrokNotSignedInText(text: string): boolean {
  return /\bnot signed in\b|not authenticated|not logged in|authentication required/i.test(text);
}

export function isGrokShellRouteUnavailableText(text: string): boolean {
  return /can't show your plan's usage|can't report usage|background service|leader\.sock|daemon/i.test(text);
}

export function parseGrokBillingPayload(
  payload: unknown,
  fetchedAt = Date.now(),
): ExternalAgentQuotaProbeResult | undefined {
  if (!isPlainObject(payload)) return undefined;
  const config = isPlainObject(payload.config) ? payload.config : payload;
  const planLabel = normalizeQuotaPlanLabel(
    "grok",
    payload.subscriptionTier ?? payload.subscription_tier ?? config.subscriptionTier ?? config.subscription_tier ?? payload.plan ?? payload.tier,
  );

  const windows: ExternalAgentQuotaWindow[] = [];

  const pushPercentWindow = (id: string, label: string, rawPct: unknown, rawReset: unknown, windowMinutes?: number) => {
    if (windows.length >= 16) return;
    if (typeof rawPct !== "number" || !Number.isFinite(rawPct)) return;
    const usedPercent = clampQuotaPercent(rawPct);
    const resetsAt = normalizeQuotaTimestampMs(rawReset);
    windows.push({
      id,
      label,
      usedPercent,
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      severity: deriveSeverity(usedPercent),
    });
  };

  const currentPeriod = isPlainObject(config.currentPeriod)
    ? config.currentPeriod
    : isPlainObject(payload.currentPeriod)
      ? payload.currentPeriod
      : undefined;
  const periodEnd = currentPeriod?.end ?? currentPeriod?.endsAt ?? config.resetsAt ?? payload.resetsAt ?? payload.resetAt;

  const creditPct = config.creditUsagePercent ?? payload.creditUsagePercent ?? payload.usagePercent ?? payload.usedPercent;
  if (typeof creditPct === "number" && Number.isFinite(creditPct)) {
    pushPercentWindow("period", "Period", creditPct, periodEnd);
  }

  const rawWindows = Array.isArray(payload.windows)
    ? payload.windows
    : Array.isArray(config.windows)
      ? config.windows
      : [];
  for (const [idx, item] of rawWindows.entries()) {
    if (!isPlainObject(item)) continue;
    const pct = item.usedPercent ?? item.utilization ?? item.usagePercent ?? item.percent;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    const mins = typeof item.windowMinutes === "number" && Number.isFinite(item.windowMinutes) && item.windowMinutes > 0
      ? Math.round(item.windowMinutes)
      : undefined;
    const label = sanitizeBucketLabel(item.label) ?? formatWindowDurationLabel(mins, `W${idx + 1}`);
    pushPercentWindow(`w:${idx}`, label, pct, item.resetsAt ?? item.resets_at ?? periodEnd, mins);
  }

  let credits: ExternalAgentQuotaCredits | undefined;
  const prepaid = config.prepaidBalance ?? payload.prepaidBalance;
  const onDemandUsed = config.onDemandUsed ?? payload.onDemandUsed;
  const monthlyLimit = config.monthlyLimit ?? payload.monthlyLimit;
  if (typeof prepaid === "number" && Number.isFinite(prepaid)) {
    const balanceText = formatQuotaCurrencyAmount(prepaid * 100, "USD");
    if (balanceText) credits = { hasCredits: prepaid > 0, balanceText };
  } else if (typeof onDemandUsed === "number" && Number.isFinite(onDemandUsed)) {
    const usedText = formatQuotaCurrencyAmount(onDemandUsed * 100, "USD");
    const limitText = typeof monthlyLimit === "number" && Number.isFinite(monthlyLimit) && monthlyLimit > 0
      ? formatQuotaCurrencyAmount(monthlyLimit * 100, "USD")
      : undefined;
    const balanceText = usedText && limitText
      ? sanitizeQuotaBalanceText(`${usedText} / ${limitText}`)
      : usedText;
    if (balanceText) {
      credits = {
        hasCredits: true,
        isExtraUsage: true,
        balanceText,
        ...(typeof monthlyLimit === "number" && monthlyLimit > 0 ? { usedPercent: clampQuotaPercent((onDemandUsed / monthlyLimit) * 100) } : {}),
      };
    }
  }

  if (windows.length === 0 && !credits && !planLabel) return undefined;
  return {
    kind: "grok",
    status: "ok",
    source: "live",
    fetchedAt,
    ...(planLabel ? { planLabel } : {}),
    windows,
    ...(credits ? { credits } : {}),
  };
}
