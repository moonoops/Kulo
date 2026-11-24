import {
  LEGACY_MIGRATION_EXECUTION_TRUST_MODE,
  NEW_INSTALL_EXECUTION_TRUST_MODE,
  parseExecutionTrustMode,
  stricterExecutionTrustMode,
  type ExecutionTrustMode,
  type ExecutorSlotsConfig,
} from "@kulo/protocol";

export class SettingsUpdateError extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SettingsUpdateError";
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeExecutorConfig(
  raw: unknown,
  fallbackMax = 3,
  fallbackWatchdog = 5,
  fallbackMaxSubagents = 4,
  fallbackCompletedDisplay: ExecutorSlotsConfig["completedTaskDisplayHours"] = 3,
  fallbackTrustMode: ExecutionTrustMode = LEGACY_MIGRATION_EXECUTION_TRUST_MODE,
): ExecutorSlotsConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const maxConcurrentWorkers = clampInt(
    obj.maxConcurrentWorkers ?? obj.normalSlots ?? fallbackMax,
    fallbackMax,
    1,
    16,
  );
  const maxSubagentsPerTicket = clampInt(
    obj.maxSubagentsPerTicket ?? fallbackMaxSubagents,
    fallbackMaxSubagents,
    1,
    8,
  );
  const watchdogMinutes = clampInt(
    obj.watchdogMinutes ?? fallbackWatchdog,
    fallbackWatchdog,
    0,
    60,
  );
  const completedTaskDisplayHours =
    obj.completedTaskDisplayHours === null ||
    obj.completedTaskDisplayHours === 1 ||
    obj.completedTaskDisplayHours === 3 ||
    obj.completedTaskDisplayHours === 6
      ? obj.completedTaskDisplayHours
      : fallbackCompletedDisplay;
  const autoArchiveEnabled = typeof obj.autoArchiveEnabled === "boolean" ? obj.autoArchiveEnabled : true;
  const autoArchiveDays =
    typeof obj.autoArchiveDays === "number" &&
    Number.isSafeInteger(obj.autoArchiveDays) &&
    obj.autoArchiveDays >= 1 &&
    obj.autoArchiveDays <= 3650
      ? obj.autoArchiveDays
      : 7;
  const executionTrustMode = parseExecutionTrustMode(obj.executionTrustMode) ?? fallbackTrustMode;

  return {
    maxConcurrentWorkers,
    maxSubagentsPerTicket,
    paused: Boolean(obj.paused),
    watchdogMinutes,
    completedTaskDisplayHours,
    autoArchiveEnabled,
    autoArchiveDays,
    executionTrustMode,
  };
}

export function createFreshExecutorConfig(input: {
  maxConcurrentWorkers: number;
  maxSubagentsPerTicket: number;
  watchdogMinutes: number;
  completedTaskDisplayHours?: ExecutorSlotsConfig["completedTaskDisplayHours"];
  executionTrustMode?: ExecutionTrustMode;
}): ExecutorSlotsConfig {
  return {
    maxConcurrentWorkers: input.maxConcurrentWorkers,
    maxSubagentsPerTicket: input.maxSubagentsPerTicket,
    paused: false,
    watchdogMinutes: input.watchdogMinutes,
    completedTaskDisplayHours:
      input.completedTaskDisplayHours === undefined ? 3 : input.completedTaskDisplayHours,
    autoArchiveEnabled: true,
    autoArchiveDays: 7,
    executionTrustMode: input.executionTrustMode ?? NEW_INSTALL_EXECUTION_TRUST_MODE,
  };
}

export function resolveRollbackExecutorConfig(
  snapshotExecutor: unknown,
  currentExecutor: ExecutorSlotsConfig,
): {
  next: ExecutorSlotsConfig;
  trustModeChanged: boolean;
  relaxedTrustMode: boolean;
  tightenedTrustMode: boolean;
} {
  const currentNormalized = normalizeExecutorConfig(currentExecutor);
  const snapObj = (snapshotExecutor && typeof snapshotExecutor === "object"
    ? snapshotExecutor
    : {}) as Record<string, unknown>;
  const explicitSnapshotMode = parseExecutionTrustMode(snapObj.executionTrustMode);
  const resolvedMode =
    explicitSnapshotMode ??
    stricterExecutionTrustMode(currentNormalized.executionTrustMode, LEGACY_MIGRATION_EXECUTION_TRUST_MODE);
  const next = normalizeExecutorConfig(snapshotExecutor, 3, 5, 4, 3, resolvedMode);
  next.executionTrustMode = resolvedMode;
  const prevMode = currentNormalized.executionTrustMode ?? LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
  return {
    next,
    trustModeChanged: prevMode !== resolvedMode,
    relaxedTrustMode: prevMode === "sandboxed" && resolvedMode === "trusted",
    tightenedTrustMode: prevMode === "trusted" && resolvedMode === "sandboxed",
  };
}

export function applyExecutorBlockUpdate(
  currentExecutor: ExecutorSlotsConfig,
  val: Record<string, unknown>,
): {
  next: ExecutorSlotsConfig;
  summary: string;
  trustModeChanged: boolean;
  relaxedTrustMode: boolean;
  tightenedTrustMode: boolean;
} {
  const prevExecutor = normalizeExecutorConfig(currentExecutor);
  const rawWorkers = val.maxConcurrentWorkers ?? val.normalSlots;
  const maxConcurrentWorkers = Number(rawWorkers);
  const maxSubagentsPerTicket =
    val.maxSubagentsPerTicket !== undefined
      ? Number(val.maxSubagentsPerTicket)
      : prevExecutor.maxSubagentsPerTicket;
  const watchdogMinutes =
    val.watchdogMinutes !== undefined
      ? Number(val.watchdogMinutes)
      : prevExecutor.watchdogMinutes;
  const completedTaskDisplayHours =
    val.completedTaskDisplayHours === undefined
      ? prevExecutor.completedTaskDisplayHours === undefined
        ? 3
        : prevExecutor.completedTaskDisplayHours
      : val.completedTaskDisplayHours;
  if (
    completedTaskDisplayHours !== null &&
    completedTaskDisplayHours !== 1 &&
    completedTaskDisplayHours !== 3 &&
    completedTaskDisplayHours !== 6
  ) {
    throw new SettingsUpdateError(400, "已完成任务显示时长需为 1、3、6 小时或一直显示。");
  }
  const autoArchiveEnabled =
    val.autoArchiveEnabled === undefined ? prevExecutor.autoArchiveEnabled! : val.autoArchiveEnabled;
  const autoArchiveDays =
    val.autoArchiveDays === undefined ? prevExecutor.autoArchiveDays! : val.autoArchiveDays;
  if (typeof autoArchiveEnabled !== "boolean") {
    throw new SettingsUpdateError(400, "自动归档开关需为开启或关闭。");
  }
  if (
    typeof autoArchiveDays !== "number" ||
    !Number.isSafeInteger(autoArchiveDays) ||
    autoArchiveDays < 1 ||
    autoArchiveDays > 3650
  ) {
    throw new SettingsUpdateError(400, "自动归档天数需为 1~3650 的整数。");
  }
  const paused = Boolean(val.paused);
  if (
    !Number.isInteger(maxConcurrentWorkers) ||
    maxConcurrentWorkers < 1 ||
    maxConcurrentWorkers > 16 ||
    !Number.isInteger(maxSubagentsPerTicket) ||
    maxSubagentsPerTicket < 1 ||
    maxSubagentsPerTicket > 8 ||
    !Number.isInteger(watchdogMinutes) ||
    watchdogMinutes < 0 ||
    watchdogMinutes > 60
  ) {
    throw new SettingsUpdateError(
      400,
      "并发 Worker 上限需为 1~16 的整数，单任务子智能体上限需为 1~8 的整数，巡检超时需为 0~60 的整数分钟。",
    );
  }

  let executionTrustMode: ExecutionTrustMode =
    prevExecutor.executionTrustMode ?? LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
  if (Object.hasOwn(val, "executionTrustMode") && val.executionTrustMode !== undefined) {
    const parsed = parseExecutionTrustMode(val.executionTrustMode);
    if (!parsed) {
      throw new SettingsUpdateError(400, "执行权限模式无效，仅支持本机信任或隔离沙箱。");
    }
    executionTrustMode = parsed;
  }

  const prevMode = prevExecutor.executionTrustMode ?? LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
  const next: ExecutorSlotsConfig = {
    maxConcurrentWorkers,
    maxSubagentsPerTicket,
    paused,
    watchdogMinutes,
    completedTaskDisplayHours,
    autoArchiveEnabled,
    autoArchiveDays,
    executionTrustMode,
  };

  const modeLabel = executionTrustMode === "trusted" ? "本机信任" : "隔离沙箱";
  const summary = `执行权限${modeLabel} · 并发上限 ${maxConcurrentWorkers} · 子智能体 ${maxSubagentsPerTicket} · 巡检${watchdogMinutes > 0 ? ` ${watchdogMinutes} 分钟` : "关闭"} · 已完成任务${completedTaskDisplayHours === null ? "一直显示" : `显示 ${completedTaskDisplayHours} 小时`} · 自动归档${autoArchiveEnabled ? ` ${autoArchiveDays} 天` : "关闭"}${paused ? "（已暂停新派单）" : ""}`;

  return {
    next,
    summary,
    trustModeChanged: prevMode !== executionTrustMode,
    relaxedTrustMode: prevMode === "sandboxed" && executionTrustMode === "trusted",
    tightenedTrustMode: prevMode === "trusted" && executionTrustMode === "sandboxed",
  };
}
