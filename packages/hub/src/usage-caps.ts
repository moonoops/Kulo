import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import { isPrivateLocalModelEndpoint, type UsageBucketTotals, type UsageCapReason, type UsageCapsConfig, type UsageCapsScope, type UsageCapsSnapshot } from "@kulo/protocol";

const FLUSH_ENABLED_MS = 60_000;
const FLUSH_DISABLED_MS = 5 * 60_000;
const MAX_TOKEN_LIMIT = 1_000_000_000;
const MAX_COST_USD_LIMIT = 100_000;

export type UsageCapCategory = "schedule" | "assistant" | "personality";

export class UsageCapsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UsageCapsError";
  }
}

export function defaultUsageCapsConfig(): UsageCapsConfig {
  return {
    enabled: false,
    dailyTokenLimit: 1_000_000,
    weeklyTokenLimit: null,
    dailyCostUsdLimit: null,
    weeklyCostUsdLimit: null,
    scope: "all_background",
  };
}

function emptyBucket(): UsageBucketTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-timezone Monday date (`YYYY-MM-DD`) identifying the active calendar week. */
export function localWeekKey(timestamp: number): string {
  const d = new Date(timestamp);
  const day = d.getDay(); // 0=Sun..6=Sat
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetToMonday);
  return localDayKey(d.getTime());
}

export function nextLocalDayStart(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function nextLocalWeekStart(timestamp: number): number {
  const d = new Date(timestamp);
  const day = d.getDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysUntilNextMonday);
  return d.getTime();
}

/**
 * Returns true when `baseUrl` points to a self-hosted local/LAN endpoint
 * (loopback or private RFC1918/Tailscale Ollama / LM Studio / oMLX / vLLM),
 * which is exempt from cloud usage caps.
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  if (isPrivateLocalModelEndpoint(baseUrl)) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "0.0.0.0";
  } catch {
    return false;
  }
}

export interface UsageLedgerState {
  revision: number;
  config: UsageCapsConfig;
  todayKey: string;
  weekKey: string;
  today: UsageBucketTotals;
  week: UsageBucketTotals;
  updatedAt: number;
}

export const UsageLedgerDoc = defineDoc<UsageLedgerState & JsonObject>({
  kind: "kulo.usage-ledger",
  version: 1,
  scope: "session",
  initial: () => {
    const now = Date.now();
    return {
      revision: 1,
      config: defaultUsageCapsConfig(),
      todayKey: localDayKey(now),
      weekKey: localWeekKey(now),
      today: emptyBucket(),
      week: emptyBucket(),
      updatedAt: now,
    } as UsageLedgerState & JsonObject;
  },
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 24,
});

function validateOptionalLimit(raw: unknown, max: number, integer: boolean, label: string): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > max) {
    throw new UsageCapsError(400, "invalid_usage_caps", `${label}必须是 1 至 ${max} 之间的有效数字或留空。`);
  }
  if (integer && !Number.isInteger(raw)) {
    throw new UsageCapsError(400, "invalid_usage_caps", `${label}必须为整数。`);
  }
  return integer ? Math.round(raw) : Math.round(raw * 1000) / 1000;
}

export function validateUsageCapsConfig(raw: unknown): UsageCapsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageCapsError(400, "invalid_usage_caps", "用量保护配置无效。");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") {
    throw new UsageCapsError(400, "invalid_usage_caps", "请指定是否启用后台用量上限。");
  }
  const scope = (obj.scope ?? "all_background") as UsageCapsScope;
  if (!["all_background", "schedules_only", "assistant_only"].includes(scope)) {
    throw new UsageCapsError(400, "invalid_usage_caps", "暂停范围无效。");
  }
  const config: UsageCapsConfig = {
    enabled: obj.enabled,
    dailyTokenLimit: validateOptionalLimit(obj.dailyTokenLimit, MAX_TOKEN_LIMIT, true, "每日 Token 上限"),
    weeklyTokenLimit: validateOptionalLimit(obj.weeklyTokenLimit, MAX_TOKEN_LIMIT, true, "每周 Token 上限"),
    dailyCostUsdLimit: validateOptionalLimit(obj.dailyCostUsdLimit, MAX_COST_USD_LIMIT, false, "每日费用上限"),
    weeklyCostUsdLimit: validateOptionalLimit(obj.weeklyCostUsdLimit, MAX_COST_USD_LIMIT, false, "每周费用上限"),
    scope,
  };
  if (
    config.enabled &&
    config.dailyTokenLimit === null &&
    config.weeklyTokenLimit === null &&
    config.dailyCostUsdLimit === null &&
    config.weeklyCostUsdLimit === null
  ) {
    throw new UsageCapsError(400, "invalid_usage_caps", "启用上限保护时，请至少设置一项每日或每周额度。");
  }
  return config;
}

function evaluateCap(
  config: UsageCapsConfig,
  today: UsageBucketTotals,
  week: UsageBucketTotals,
  now: number,
): { capped: boolean; capReason?: UsageCapReason; resetAt: number | null } {
  if (!config.enabled) return { capped: false, resetAt: null };
  if (config.dailyTokenLimit !== null && today.totalTokens >= config.dailyTokenLimit) {
    return { capped: true, capReason: "daily_tokens", resetAt: nextLocalDayStart(now) };
  }
  if (config.dailyCostUsdLimit !== null && today.costUsd >= config.dailyCostUsdLimit) {
    return { capped: true, capReason: "daily_cost", resetAt: nextLocalDayStart(now) };
  }
  if (config.weeklyTokenLimit !== null && week.totalTokens >= config.weeklyTokenLimit) {
    return { capped: true, capReason: "weekly_tokens", resetAt: nextLocalWeekStart(now) };
  }
  if (config.weeklyCostUsdLimit !== null && week.costUsd >= config.weeklyCostUsdLimit) {
    return { capped: true, capReason: "weekly_cost", resetAt: nextLocalWeekStart(now) };
  }
  return { capped: false, resetAt: null };
}

function maxUsageRatio(config: UsageCapsConfig, today: UsageBucketTotals, week: UsageBucketTotals): number {
  if (!config.enabled) return 0;
  let ratio = 0;
  if (config.dailyTokenLimit) ratio = Math.max(ratio, today.totalTokens / config.dailyTokenLimit);
  if (config.dailyCostUsdLimit) ratio = Math.max(ratio, today.costUsd / config.dailyCostUsdLimit);
  if (config.weeklyTokenLimit) ratio = Math.max(ratio, week.totalTokens / config.weeklyTokenLimit);
  if (config.weeklyCostUsdLimit) ratio = Math.max(ratio, week.costUsd / config.weeklyCostUsdLimit);
  return ratio;
}

function scopeApplies(scope: UsageCapsScope, category: UsageCapCategory): boolean {
  if (scope === "all_background") return true;
  if (scope === "schedules_only") return category === "schedule";
  if (scope === "assistant_only") return category === "assistant";
  return false;
}

export interface KuloUsageCapsOptions {
  harness: Harness;
  now?: () => number;
  onChanged?: () => void | Promise<void>;
}

export class KuloUsageCaps {
  readonly #options: KuloUsageCapsOptions;
  #state: UsageLedgerState;
  #dirty = false;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #flushChain: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: KuloUsageCapsOptions) {
    this.#options = options;
    const now = this.#now();
    this.#state = {
      revision: 1,
      config: defaultUsageCapsConfig(),
      todayKey: localDayKey(now),
      weekKey: localWeekKey(now),
      today: emptyBucket(),
      week: emptyBucket(),
      updatedAt: now,
    };
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #rolloverIfNeeded(now: number): void {
    const dayKey = localDayKey(now);
    const weekKey = localWeekKey(now);
    if (this.#state.todayKey !== dayKey) {
      this.#state.todayKey = dayKey;
      this.#state.today = emptyBucket();
      this.#dirty = true;
    }
    if (this.#state.weekKey !== weekKey) {
      this.#state.weekKey = weekKey;
      this.#state.week = emptyBucket();
      this.#dirty = true;
    }
  }

  async start(): Promise<void> {
    const stored = await this.#options.harness.snapshot(UsageLedgerDoc, BACKGROUND_CONTEXT);
    if (stored) {
      this.#state = {
        revision: Number.isInteger(stored.revision) && stored.revision >= 1 ? stored.revision : 1,
        config: { ...defaultUsageCapsConfig(), ...(stored.config ?? {}) },
        todayKey: stored.todayKey || localDayKey(this.#now()),
        weekKey: stored.weekKey || localWeekKey(this.#now()),
        today: { ...emptyBucket(), ...(stored.today ?? {}) },
        week: { ...emptyBucket(), ...(stored.week ?? {}) },
        updatedAt: stored.updatedAt || this.#now(),
      };
      this.#rolloverIfNeeded(this.#now());
    }
  }

  snapshot(): UsageCapsSnapshot {
    const now = this.#now();
    this.#rolloverIfNeeded(now);
    const status = evaluateCap(this.#state.config, this.#state.today, this.#state.week, now);
    return {
      revision: this.#state.revision,
      config: { ...this.#state.config },
      todayKey: this.#state.todayKey,
      weekKey: this.#state.weekKey,
      today: { ...this.#state.today },
      week: { ...this.#state.week },
      capped: status.capped,
      ...(status.capReason ? { capReason: status.capReason } : {}),
      resetAt: status.resetAt,
      updatedAt: this.#state.updatedAt,
    };
  }

  isCappedFor(category: UsageCapCategory): { capped: boolean; capReason?: UsageCapReason; resetAt: number | null } {
    const now = this.#now();
    this.#rolloverIfNeeded(now);
    if (!this.#state.config.enabled || !scopeApplies(this.#state.config.scope, category)) {
      return { capped: false, resetAt: null };
    }
    return evaluateCap(this.#state.config, this.#state.today, this.#state.week, now);
  }

  recordUsage(
    model: { baseUrl?: string; provider?: string; id?: string } | undefined,
    usage:
      | {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
          cost?: { total?: number };
        }
      | undefined,
  ): void {
    if (!usage) return;
    if (model && isLoopbackBaseUrl(model.baseUrl)) return;

    const input = Number.isFinite(usage.input) ? Math.max(0, Math.round(usage.input!)) : 0;
    const output = Number.isFinite(usage.output) ? Math.max(0, Math.round(usage.output!)) : 0;
    const cacheRead = Number.isFinite(usage.cacheRead) ? Math.max(0, Math.round(usage.cacheRead!)) : 0;
    const cacheWrite = Number.isFinite(usage.cacheWrite) ? Math.max(0, Math.round(usage.cacheWrite!)) : 0;
    const total = Number.isFinite(usage.totalTokens) && usage.totalTokens! > 0
      ? Math.round(usage.totalTokens!)
      : input + output + cacheRead + cacheWrite;
    const cost = Number.isFinite(usage.cost?.total) && usage.cost!.total! > 0 ? usage.cost!.total! : 0;
    if (total === 0 && cost === 0) return;

    const now = this.#now();
    this.#rolloverIfNeeded(now);
    const prevRatio = maxUsageRatio(this.#state.config, this.#state.today, this.#state.week);

    for (const bucket of [this.#state.today, this.#state.week]) {
      bucket.inputTokens += input;
      bucket.outputTokens += output;
      bucket.totalTokens += total;
      bucket.costUsd = Math.round((bucket.costUsd + cost) * 1_000_000) / 1_000_000;
      bucket.calls += 1;
    }
    this.#state.updatedAt = now;
    this.#dirty = true;

    const nextRatio = maxUsageRatio(this.#state.config, this.#state.today, this.#state.week);
    const crossedThreshold = (prevRatio < 0.8 && nextRatio >= 0.8) || (prevRatio < 1 && nextRatio >= 1);
    if (crossedThreshold) {
      void this.flush();
    } else {
      this.#scheduleFlush();
    }
  }

  async updateConfig(expectedRevision: number, rawConfig: unknown): Promise<UsageCapsSnapshot> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new UsageCapsError(400, "invalid_usage_caps", "配置版本无效。");
    }
    const nextConfig = validateUsageCapsConfig(rawConfig);
    return this.#enqueue(async () => {
      if (this.#state.revision !== expectedRevision) {
        throw new UsageCapsError(409, "usage_caps_conflict", "用量保护配置已在别处更新，请刷新后重试。");
      }
      const now = this.#now();
      this.#rolloverIfNeeded(now);
      this.#state.config = nextConfig;
      this.#state.revision += 1;
      this.#state.updatedAt = now;
      this.#dirty = true;
      await this.#persistNow();
      await this.#options.onChanged?.();
      return this.snapshot();
    });
  }

  #scheduleFlush(): void {
    if (this.#closed || this.#flushTimer) return;
    const delayMs = this.#state.config.enabled ? FLUSH_ENABLED_MS : FLUSH_DISABLED_MS;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush();
    }, delayMs);
    this.#flushTimer.unref();
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#flushChain.then(fn, fn);
    this.#flushChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #persistNow(): Promise<void> {
    if (!this.#dirty) return;
    const snap: UsageLedgerState = {
      revision: this.#state.revision,
      config: { ...this.#state.config },
      todayKey: this.#state.todayKey,
      weekKey: this.#state.weekKey,
      today: { ...this.#state.today },
      week: { ...this.#state.week },
      updatedAt: this.#state.updatedAt,
    };
    this.#dirty = false;
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(UsageLedgerDoc);
      doc.revision = snap.revision;
      doc.config = snap.config;
      doc.todayKey = snap.todayKey;
      doc.weekKey = snap.weekKey;
      doc.today = snap.today;
      doc.week = snap.week;
      doc.updatedAt = snap.updatedAt;
    }, BACKGROUND_CONTEXT);
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (!this.#dirty) return;
    await this.#enqueue(() => this.#persistNow());
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.flush().catch(() => {});
  }
}

/**
 * Wraps the innermost `Models` instance (BEFORE `withNativeToolsModels`) so every
 * cloud LLM invocation — GenerationTask, Anthropic native search continuations,
 * AmbientModelService, ContextCompaction, MemoryLlmBridge, AndroidNotifications,
 * topic titles, and relationship reviews — is metered accurately once.
 */
export function withUsageMeterModels(
  baseModels: Models,
  getMeter: () => Pick<KuloUsageCaps, "recordUsage"> | undefined,
): Models {
  return new Proxy(baseModels, {
    get(target, prop, receiver) {
      if (prop === "complete" || prop === "completeSimple") {
        const fn = Reflect.get(target, prop, target) as (...args: unknown[]) => Promise<AssistantMessage>;
        if (typeof fn !== "function") return fn;
        return async (...args: unknown[]) => {
          const msg = await fn.apply(target, args);
          try {
            const model = args[0] as Model<any> | undefined;
            getMeter()?.recordUsage(model, msg?.usage);
          } catch {
            // Metering must never break model completion.
          }
          return msg;
        };
      }
      if (prop === "stream" || prop === "streamSimple") {
        const fn = Reflect.get(target, prop, target) as (...args: unknown[]) => { result(): Promise<AssistantMessage> };
        if (typeof fn !== "function") return fn;
        return (...args: unknown[]) => {
          const stream = fn.apply(target, args);
          const model = args[0] as Model<any> | undefined;
          if (stream && typeof stream.result === "function") {
            void stream.result().then(
              (msg) => {
                try {
                  getMeter()?.recordUsage(model, msg?.usage);
                } catch {
                  // Ignore metering failures
                }
              },
              () => {},
            );
          }
          return stream;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Computes the next safe due timestamp when deferring a scheduled ticket past a usage cap reset. */
export function computeCapDeferredDueAt(
  ticket: { schedule?: { repeatEverySeconds?: number; anchorAt?: number; nextRunAt?: number | null } },
  resetAt: number,
  now: number,
): number {
  const minTarget = Math.max(resetAt, now + 60_000);
  const repeatMs = ticket.schedule?.repeatEverySeconds ? ticket.schedule.repeatEverySeconds * 1000 : 0;
  const anchor = ticket.schedule?.anchorAt;
  if (repeatMs > 0 && anchor !== undefined && Number.isFinite(anchor)) {
    const elapsed = Math.max(0, minTarget - anchor);
    const steps = Math.ceil(elapsed / repeatMs);
    return anchor + Math.max(1, steps) * repeatMs;
  }
  return minTarget;
}
