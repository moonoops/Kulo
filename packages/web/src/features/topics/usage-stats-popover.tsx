import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Chip,
  Disclosure,
  Popover,
  ProgressBar,
  Separator,
  Spinner,
  Tabs,
} from "@heroui/react";
import {
  deriveConnectedExternalClients,
  type EnvNodeDescriptor,
  type ExternalAgentQuotaSeverity,
  type ExternalAgentQuotaStatus,
  type ExternalAgentQuotaWindow,
  type ExternalClientQuotaItem,
  type ExternalClientQuotasView,
  type KuloSettingsView,
  type UsageStatsView,
} from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function severityRank(severity: ExternalAgentQuotaSeverity | undefined): number {
  if (severity === "exhausted") return 2;
  if (severity === "warning") return 1;
  return 0;
}

function itemPeakSeverity(item: ExternalClientQuotaItem): ExternalAgentQuotaSeverity {
  if (item.ordinaryUsageAllowed === false) return "exhausted";
  let rank = 0;
  for (const win of item.windows) {
    rank = Math.max(rank, severityRank(win.severity));
  }
  return rank === 2 ? "exhausted" : rank === 1 ? "warning" : "normal";
}

function planChipColor(severity: ExternalAgentQuotaSeverity): "default" | "warning" | "danger" {
  if (severity === "exhausted") return "danger";
  if (severity === "warning") return "warning";
  return "default";
}

function barColor(severity: ExternalAgentQuotaSeverity | undefined): "accent" | "warning" | "danger" {
  if (severity === "exhausted") return "danger";
  if (severity === "warning") return "warning";
  return "accent";
}

function statusChipColor(status: ExternalAgentQuotaStatus): "default" | "warning" {
  if (status === "unauthenticated" || status === "env_outdated") return "warning";
  return "default";
}

function statusChipLabel(
  status: ExternalAgentQuotaStatus,
  t: (zh: string, en: string) => string,
): string {
  switch (status) {
    case "api_key_billing":
      return t("API 按量", "API billing");
    case "unauthenticated":
      return t("未登录", "Not signed in");
    case "device_offline":
      return t("设备离线", "Offline");
    case "env_outdated":
      return t("需更新设备", "Update required");
    case "unsupported":
      return t("未提供额度接口", "No quota API");
    default:
      return t("暂不可用", "Unavailable");
  }
}

function formatWindowLabel(
  win: ExternalAgentQuotaWindow,
  t: (zh: string, en: string) => string,
): string {
  if (win.label === "5h") return t("5 小时", "5h");
  if (win.label === "7d") return t("7 天", "7d");
  if (win.label === "Period") return t("周期额度", "Period");
  if (win.label === "Extra") return t("超额用量", "Extra");
  if (win.label.endsWith(" 7d")) {
    const prefix = win.label.slice(0, -3);
    return t(`${prefix} 7 天`, win.label);
  }
  if (win.label.endsWith(" 5h")) {
    const prefix = win.label.slice(0, -3);
    return t(`${prefix} 5 小时`, win.label);
  }
  return win.label;
}

function formatResetLabel(
  resetsAt: number,
  nowMs: number,
  language: string,
  t: (zh: string, en: string) => string,
): string {
  const diffMs = resetsAt - nowMs;
  if (diffMs <= 60_000) return t("即将重置", "Resets soon");
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return t(`${diffMin} 分钟后重置`, `Resets in ${diffMin}m`);
  const diffHours = diffMs / 3_600_000;
  if (diffHours < 24) {
    const clock = new Date(resetsAt).toLocaleTimeString(language, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return t(`${clock} 重置`, `Resets ${clock}`);
  }
  const day = new Date(resetsAt).toLocaleDateString(language, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });
  return t(`${day} 重置`, `Resets ${day}`);
}

function formatSyncTimestamp(
  fetchedAt: number | undefined,
  nowMs: number,
  t: (zh: string, en: string) => string,
): string {
  if (!fetchedAt) return t("未同步", "Not synced");
  const diffSec = Math.max(0, Math.floor((nowMs - fetchedAt) / 1000));
  if (diffSec < 45) return t("刚刚更新", "Updated just now");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t(`${diffMin} 分钟前`, `${diffMin}m ago`);
  const diffHour = Math.floor(diffMin / 60);
  return t(`${diffHour} 小时前`, `${diffHour}h ago`);
}

function formatCreditsCaption(
  item: ExternalClientQuotaItem,
  t: (zh: string, en: string) => string,
): string | undefined {
  const credits = item.credits;
  if (!credits) return undefined;
  if (credits.unlimited) return t("无限 Credits", "Unlimited credits");
  if (credits.isExtraUsage) {
    const parts = [
      credits.balanceText,
      credits.usedPercent !== undefined ? `${credits.usedPercent}%` : undefined,
    ].filter(Boolean);
    return parts.length > 0
      ? t(`超额用量 · ${parts.join(" · ")}`, `Extra usage · ${parts.join(" · ")}`)
      : t("已启用超额用量", "Extra usage enabled");
  }
  if (credits.balanceText) return `Credits ${credits.balanceText}`;
  return undefined;
}

export function ExternalQuotasPanel({
  quotaView,
  clockOffsetMs,
  loading,
  refreshing,
  error,
  showDeviceName,
  onRefresh,
}: {
  quotaView: ExternalClientQuotasView | null;
  clockOffsetMs: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  showDeviceName: boolean;
  onRefresh: () => void;
}) {
  const { t, language } = useI18n();
  const primaryQuotaItems = useMemo(
    () => (quotaView?.items ?? []).filter((item) => item.status !== "unsupported"),
    [quotaView],
  );
  const unsupportedQuotaItems = useMemo(
    () => (quotaView?.items ?? []).filter((item) => item.status === "unsupported"),
    [quotaView],
  );
  const latestFetchedAt = useMemo(() => {
    let maxAt: number | undefined;
    for (const item of primaryQuotaItems) {
      if (item.fetchedAt && (!maxAt || item.fetchedAt > maxAt)) maxAt = item.fetchedAt;
    }
    return maxAt;
  }, [primaryQuotaItems]);
  const calibratedNow = Date.now() - clockOffsetMs;

  return (
    <div className="flex flex-col gap-2.5" aria-busy={refreshing || undefined}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {refreshing
            ? t("正在刷新…", "Refreshing…")
            : formatSyncTimestamp(latestFetchedAt, calibratedNow, t)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          isPending={refreshing}
          aria-label={t("刷新外部额度", "Refresh external quotas")}
          onPress={onRefresh}
        >
          {refreshing ? <Spinner size="sm" color="current" /> : <KuloIcon name="refresh" size={16} />}
        </Button>
      </div>

      {loading && !quotaView ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Spinner size="sm" />
          <span>{t("正在获取额度…", "Loading quotas…")}</span>
        </div>
      ) : error && !quotaView ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft/30 p-3 text-xs">
          <span className="text-danger">{error}</span>
          <Button size="sm" variant="secondary" onPress={onRefresh}>
            {t("重试", "Retry")}
          </Button>
        </div>
      ) : quotaView ? (
        <div className="flex flex-col gap-2">
          {error && (
            <span role="alert" className="text-xs text-danger">
              {error}
            </span>
          )}

          {primaryQuotaItems.length > 0 && (
            <div className="scrollbar flex max-h-[min(24rem,52vh)] flex-col divide-y divide-separator overflow-y-auto">
              {primaryQuotaItems.map((item) => {
                if (item.status !== "ok") {
                  return (
                    <div
                      key={item.clientId}
                      className="flex items-center justify-between gap-2 py-2 first:pt-0.5 last:pb-0.5"
                    >
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
                        {showDeviceName && (
                          <span className="truncate text-xs text-muted">{item.envName}</span>
                        )}
                      </div>
                      <Chip size="sm" variant="soft" color={statusChipColor(item.status)}>
                        <Chip.Label title={item.error}>
                          {statusChipLabel(item.status, t)}
                        </Chip.Label>
                      </Chip>
                    </div>
                  );
                }

                const peak = itemPeakSeverity(item);
                const creditsCaption = formatCreditsCaption(item, t);
                return (
                  <div
                    key={item.clientId}
                    className="flex flex-col gap-2 py-2.5 first:pt-0.5 last:pb-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
                        {showDeviceName && (
                          <span className="truncate text-xs text-muted">{item.envName}</span>
                        )}
                      </div>
                      {item.planLabel && (
                        <Chip size="sm" variant="soft" color={planChipColor(peak)}>
                          <Chip.Label>{item.planLabel}</Chip.Label>
                        </Chip>
                      )}
                    </div>

                    {item.windows.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {item.windows.map((win) => {
                          const winLabel = formatWindowLabel(win, t);
                          const resetLabel = win.resetsAt
                            ? formatResetLabel(win.resetsAt, calibratedNow, language, t)
                            : undefined;
                          return (
                            <div key={win.id} className="flex flex-col gap-1">
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="truncate text-muted">{winLabel}</span>
                                <span className="shrink-0 tabular-nums text-foreground">
                                  <span>{win.usedPercent}%</span>
                                  {resetLabel && <span className="text-muted"> · {resetLabel}</span>}
                                </span>
                              </div>
                              <ProgressBar
                                aria-label={t(`${item.label} ${winLabel} 已用额度`, `${item.label} ${winLabel} quota used`)}
                                value={win.usedPercent}
                                size="sm"
                                color={barColor(win.severity)}
                                className="w-full"
                              >
                                <ProgressBar.Track>
                                  <ProgressBar.Fill />
                                </ProgressBar.Track>
                              </ProgressBar>
                            </div>
                          );
                        })}
                      </div>
                    ) : item.planLabel === "Team" ? (
                      <span className="text-xs text-muted">
                        {t("由团队统一管理配额", "Managed by team")}
                      </span>
                    ) : null}

                    {creditsCaption && (
                      <span className="text-xs text-muted">{creditsCaption}</span>
                    )}
                    {item.refreshError && (
                      <span className="text-xs text-danger">{item.refreshError}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {unsupportedQuotaItems.length > 0 && (
            <>
              {primaryQuotaItems.length > 0 && <Separator />}
              <Disclosure>
                <Disclosure.Heading>
                  <Disclosure.Trigger className="flex w-full cursor-pointer items-center justify-between gap-2 py-1 text-left">
                    <span className="text-xs font-medium text-foreground">
                      {t(
                        `其他已连接 (${unsupportedQuotaItems.length})`,
                        `Other connected (${unsupportedQuotaItems.length})`,
                      )}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted">
                      <span>{t("未提供额度接口", "No quota API")}</span>
                      <Disclosure.Indicator />
                    </span>
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="flex flex-col gap-1.5 pt-1">
                    {unsupportedQuotaItems.map((item) => (
                      <div
                        key={item.clientId}
                        className="flex items-center justify-between gap-2 text-xs text-muted"
                      >
                        <span className="truncate text-foreground">{item.label}</span>
                        {showDeviceName && <span className="shrink-0">{item.envName}</span>}
                      </div>
                    ))}
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function UsageStatsPopover({
  settings,
  envs,
  messagesCount,
}: {
  settings: KuloSettingsView | null;
  envs: EnvNodeDescriptor[];
  messagesCount: number;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"usage" | "quota">("usage");
  const [usageRange, setUsageRange] = useState<"today" | "7" | "30">("today");
  const [usageData, setUsageData] = useState<UsageStatsView | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [quotaView, setQuotaView] = useState<ExternalClientQuotasView | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLElement>(null);
  const manualRefreshAbortRef = useRef<AbortController | null>(null);

  const connectedClients = useMemo(
    () => deriveConnectedExternalClients(settings?.blocks.roles.value, settings?.externalClients),
    [settings],
  );
  const hasExternalClients = connectedClients.length > 0;

  useEffect(() => {
    if (!hasExternalClients && activeTab !== "usage") {
      setActiveTab("usage");
    }
  }, [hasExternalClients, activeTab]);

  const loadUsage = useCallback((range: "today" | "7" | "30") => {
    setUsageLoading(true);
    setUsageError(null);
    kuloRest
      .getUsage(range)
      .then((res) => {
        setUsageData(res);
      })
      .catch((err) => {
        setUsageError(err instanceof Error ? err.message : t("加载统计失败", "Failed to load usage"));
      })
      .finally(() => {
        setUsageLoading(false);
      });
  }, [t]);

  useEffect(() => {
    if (!open || activeTab !== "usage") return;
    loadUsage(usageRange);
  }, [open, activeTab, usageRange, messagesCount, loadUsage]);

  useEffect(() => {
    if (!open || !hasExternalClients || activeTab !== "quota") {
      manualRefreshAbortRef.current?.abort();
      manualRefreshAbortRef.current = null;
      return;
    }
    const controller = new AbortController();
    let active = true;
    setQuotaError(null);
    if (!quotaView) setQuotaLoading(true);

    void (async () => {
      try {
        const snapshot = await kuloRest.getExternalClientQuotas({ signal: controller.signal });
        if (!active || controller.signal.aborted) return;
        setQuotaView(snapshot);
        setClockOffsetMs(Date.now() - snapshot.serverTime);
        setQuotaLoading(false);

        if (snapshot.items.some((item) => item.canRefresh && item.stale)) {
          setQuotaRefreshing(true);
          try {
            const refreshed = await kuloRest.refreshExternalClientQuotas(
              { force: false },
              { signal: controller.signal },
            );
            if (!active || controller.signal.aborted) return;
            setQuotaView(refreshed);
            setClockOffsetMs(Date.now() - refreshed.serverTime);
          } catch (refreshErr) {
            if (!active || controller.signal.aborted || isAbortError(refreshErr)) return;
            setQuotaError(
              refreshErr instanceof Error
                ? refreshErr.message
                : t("刷新外部额度失败", "Failed to refresh external quotas"),
            );
          } finally {
            if (active) setQuotaRefreshing(false);
          }
        }
      } catch (err) {
        if (!active || controller.signal.aborted || isAbortError(err)) return;
        setQuotaError(err instanceof Error ? err.message : t("加载外部额度失败", "Failed to load external quotas"));
        setQuotaLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
      setQuotaRefreshing(false);
    };
    // Intentionally excludes quotaView so SWR only runs on open/tab-switch/client-list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasExternalClients, activeTab, connectedClients.length]);

  const handleManualRefresh = () => {
    if (quotaRefreshing) return;
    manualRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    manualRefreshAbortRef.current = controller;
    setQuotaRefreshing(true);
    setQuotaError(null);
    void kuloRest
      .refreshExternalClientQuotas({ force: true }, { signal: controller.signal })
      .then((refreshed) => {
        if (controller.signal.aborted) return;
        setQuotaView(refreshed);
        setClockOffsetMs(Date.now() - refreshed.serverTime);
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setQuotaError(err instanceof Error ? err.message : t("刷新外部额度失败", "Failed to refresh external quotas"));
      })
      .finally(() => {
        if (manualRefreshAbortRef.current === controller) {
          manualRefreshAbortRef.current = null;
        }
        setQuotaRefreshing(false);
        if (open && document.activeElement === document.body) {
          dialogRef.current?.focus({ preventScroll: true });
        }
      });
  };

  const showDeviceName = useMemo(() => {
    const nonMobileCount = envs.filter((env) => env.executionKind !== "native-device").length;
    if (nonMobileCount > 1) return true;
    const kinds = new Set<string>();
    for (const item of quotaView?.items ?? connectedClients) {
      if (kinds.has(item.kind)) return true;
      kinds.add(item.kind);
    }
    return false;
  }, [envs, quotaView, connectedClients]);

  const renderUsageSection = () => (
    <div className="flex flex-col gap-3">
      <Tabs
        selectedKey={usageRange}
        onSelectionChange={(k) => setUsageRange(k as "today" | "7" | "30")}
        className="w-full"
      >
        <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
          <Tabs.List aria-label={t("统计时间范围", "Usage period")} className="w-max">
            <Tabs.Tab id="today" className="w-auto shrink-0 whitespace-nowrap">
              {t("今天", "Today")}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="7" className="w-auto shrink-0 whitespace-nowrap">
              {t("7 天", "7 days")}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="30" className="w-auto shrink-0 whitespace-nowrap">
              {t("30 天", "30 days")}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {usageLoading && !usageData ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Spinner size="sm" />
          <span>{t("正在加载统计…", "Loading usage…")}</span>
        </div>
      ) : usageError ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft/30 p-3 text-xs">
          <span className="text-danger">{usageError}</span>
          <Button size="sm" variant="secondary" onPress={() => loadUsage(usageRange)}>
            {t("重试", "Retry")}
          </Button>
        </div>
      ) : usageData ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-1.5">
            <strong className="text-2xl font-semibold text-foreground">
              {usageData.totalTokens.toLocaleString(language, {
                notation: "compact",
                maximumFractionDigits: 1,
              })}
            </strong>
            <span className="text-xs text-muted">tokens</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted">
            <span>{t(`${usageData.turns} 轮`, `${usageData.turns} turns`)}</span>
            {usageData.cacheHitRate !== undefined && (
              <span>
                {t(
                  `缓存命中 ${(usageData.cacheHitRate * 100).toFixed(1)}%`,
                  `Cache hit ${(usageData.cacheHitRate * 100).toFixed(1)}%`,
                )}
              </span>
            )}
          </div>
          {usageData.models.length > 0 && (
            <>
              <Separator />
              <div className="scrollbar flex max-h-44 flex-col gap-2.5 overflow-y-auto">
                {usageData.models.map((m) => {
                  const pct =
                    usageData.totalTokens > 0
                      ? Math.round((m.totalTokens / usageData.totalTokens) * 100)
                      : 0;
                  return (
                    <div key={`${m.provider ?? ""}/${m.model}`} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span
                          className="truncate font-mono text-foreground"
                          title={[m.provider, m.model].filter(Boolean).join(" / ")}
                        >
                          {m.model}
                        </span>
                        <span className="shrink-0 text-muted">
                          {m.totalTokens.toLocaleString(language, {
                            notation: "compact",
                            maximumFractionDigits: 1,
                          })}
                        </span>
                      </div>
                      <ProgressBar
                        aria-label={t(`${m.model} 用量占比`, `${m.model} usage share`)}
                        value={Math.max(4, pct)}
                        size="sm"
                        className="w-full"
                      >
                        <ProgressBar.Track>
                          <ProgressBar.Fill />
                        </ProgressBar.Track>
                      </ProgressBar>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );

  const renderQuotaSection = () => (
    <ExternalQuotasPanel
      quotaView={quotaView}
      clockOffsetMs={clockOffsetMs}
      loading={quotaLoading}
      refreshing={quotaRefreshing}
      error={quotaError}
      showDeviceName={showDeviceName}
      onRefresh={handleManualRefresh}
    />
  );

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button isIconOnly variant="ghost" aria-label={t("使用统计", "Usage")}>
        <KuloIcon name="chart" size={18} />
      </Button>
      <Popover.Content
        placement="top start"
        className="w-[360px] max-w-[calc(100vw-24px)] motion-reduce:animate-none"
      >
        <Popover.Dialog
          ref={dialogRef}
          aria-label={t("使用统计", "Usage")}
          className="flex flex-col gap-3 outline-none"
        >
          {hasExternalClients ? (
            <Tabs
              selectedKey={activeTab}
              onSelectionChange={(k) => setActiveTab(k as "usage" | "quota")}
              className="w-full"
            >
              <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
                <Tabs.List aria-label={t("统计视图", "Usage view")} className="w-max">
                  <Tabs.Tab id="usage" className="w-auto shrink-0 whitespace-nowrap">
                    {t("用量", "Usage")}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="quota" className="w-auto shrink-0 whitespace-nowrap">
                    {t("外部额度", "External quotas")}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
              <Tabs.Panel id="usage" className="mt-3 w-full p-0">
                {renderUsageSection()}
              </Tabs.Panel>
              <Tabs.Panel id="quota" className="mt-3 w-full p-0">
                {renderQuotaSection()}
              </Tabs.Panel>
            </Tabs>
          ) : (
            <>
              <Popover.Heading className="text-sm font-semibold text-foreground">
                {t("使用统计", "Usage")}
              </Popover.Heading>
              {renderUsageSection()}
            </>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
