export type UsageCapsScope = "all_background" | "schedules_only" | "assistant_only";

export type UsageCapReason =
  | "daily_tokens"
  | "weekly_tokens"
  | "daily_cost"
  | "weekly_cost";

export interface UsageCapsConfig {
  enabled: boolean;
  /** Daily cloud token budget across background/hub calls (`null` = unlimited). */
  dailyTokenLimit: number | null;
  /** Weekly cloud token budget (`null` = unlimited). */
  weeklyTokenLimit: number | null;
  /** Daily cloud spend ceiling in USD (`null` = unlimited). */
  dailyCostUsdLimit: number | null;
  /** Weekly cloud spend ceiling in USD (`null` = unlimited). */
  weeklyCostUsdLimit: number | null;
  /** Which unattended background workloads pause when a cap is reached. */
  scope: UsageCapsScope;
}

export interface UsageBucketTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface UsageCapsSnapshot {
  revision: number;
  config: UsageCapsConfig;
  todayKey: string;
  weekKey: string;
  today: UsageBucketTotals;
  week: UsageBucketTotals;
  capped: boolean;
  capReason?: UsageCapReason;
  resetAt: number | null;
  updatedAt: number;
}

export interface UsageCapsUpdateInput {
  expectedRevision: number;
  config: UsageCapsConfig;
}
