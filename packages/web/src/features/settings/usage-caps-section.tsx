import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Label, ListBox, Popover, ProgressBar, Select, Spinner, Switch } from "@heroui/react";
import type { UsageCapsConfig, UsageCapsScope, UsageCapsSnapshot } from "@kulo/protocol";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { SettingsList, SettingsNumberField, SettingsSection } from "./settings-layout";

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function primaryProgress(snapshot: UsageCapsSnapshot): { pct: number; label: string } | null {
  const { config, today, week } = snapshot;
  if (!config.enabled) return null;
  const candidates: Array<{ pct: number; label: string }> = [];
  if (config.dailyTokenLimit) {
    candidates.push({
      pct: Math.min(100, Math.round((today.totalTokens / config.dailyTokenLimit) * 100)),
      label: `${formatCompactTokens(today.totalTokens)} / ${formatCompactTokens(config.dailyTokenLimit)}`,
    });
  }
  if (config.dailyCostUsdLimit) {
    candidates.push({
      pct: Math.min(100, Math.round((today.costUsd / config.dailyCostUsdLimit) * 100)),
      label: `$${today.costUsd.toFixed(2)} / $${config.dailyCostUsdLimit.toFixed(2)}`,
    });
  }
  if (config.weeklyTokenLimit) {
    candidates.push({
      pct: Math.min(100, Math.round((week.totalTokens / config.weeklyTokenLimit) * 100)),
      label: `${formatCompactTokens(week.totalTokens)} / ${formatCompactTokens(config.weeklyTokenLimit)}`,
    });
  }
  if (config.weeklyCostUsdLimit) {
    candidates.push({
      pct: Math.min(100, Math.round((week.costUsd / config.weeklyCostUsdLimit) * 100)),
      label: `$${week.costUsd.toFixed(2)} / $${config.weeklyCostUsdLimit.toFixed(2)}`,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.pct - a.pct);
  return candidates[0]!;
}

export function UsageCapsSection() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<UsageCapsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [dailyKTokensDraft, setDailyKTokensDraft] = useState<number>(1000);
  const [weeklyKTokensDraft, setWeeklyKTokensDraft] = useState<number>(0);
  const [dailyCostDraft, setDailyCostDraft] = useState<number>(0);

  const syncDrafts = useCallback((next: UsageCapsSnapshot) => {
    setSnapshot(next);
    setDailyKTokensDraft(next.config.dailyTokenLimit ? Math.round(next.config.dailyTokenLimit / 1000) : 0);
    setWeeklyKTokensDraft(next.config.weeklyTokenLimit ? Math.round(next.config.weeklyTokenLimit / 1000) : 0);
    setDailyCostDraft(next.config.dailyCostUsdLimit ?? 0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await kuloRest.getUsageCaps();
      syncDrafts(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("加载后台额度配置失败", "Failed to load background usage caps"));
    } finally {
      setLoading(false);
    }
  }, [syncDrafts, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (patch: Partial<UsageCapsConfig>) => {
    if (!snapshot) return;
    setSaving(true);
    setError(undefined);
    const nextConfig: UsageCapsConfig = { ...snapshot.config, ...patch };
    if (
      nextConfig.enabled &&
      nextConfig.dailyTokenLimit === null &&
      nextConfig.weeklyTokenLimit === null &&
      nextConfig.dailyCostUsdLimit === null &&
      nextConfig.weeklyCostUsdLimit === null
    ) {
      nextConfig.dailyTokenLimit = 1_000_000;
    }
    try {
      const updated = await kuloRest.saveUsageCaps({
        expectedRevision: snapshot.revision,
        config: nextConfig,
      });
      syncDrafts(updated);
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) {
        await load();
      }
      setError(err instanceof Error ? err.message : t("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const scopeOptions: ReadonlyArray<{ id: UsageCapsScope; label: string }> = [
    { id: "all_background", label: t("全部无人值守后台", "All unattended background") },
    { id: "schedules_only", label: t("仅定时任务", "Scheduled tasks only") },
    { id: "assistant_only", label: t("仅个人助理云端分拣", "Assistant cloud sorting only") },
  ];

  const progress = snapshot ? primaryProgress(snapshot) : null;
  const statusText = snapshot
    ? snapshot.capped
      ? t("已触发后台暂停", "Background paused")
      : progress
        ? progress.label
        : snapshot.today.calls > 0
          ? `${formatCompactTokens(snapshot.today.totalTokens)} Tokens`
          : undefined
    : undefined;

  return (
    <SettingsSection
      title={t("后台用量保护", "Background usage caps")}
      status={loading ? <Spinner size="sm" aria-label={t("加载后台用量保护", "Loading usage caps")} /> : undefined}
      action={
        statusText ? (
          <span className="text-sm tabular-nums text-muted" role="status">
            {statusText}
          </span>
        ) : undefined
      }
    >
      {progress && snapshot && (
        <ProgressBar
          aria-label={t("后台用量进度", "Background usage progress")}
          value={progress.pct}
          size="sm"
          color={snapshot.capped ? "danger" : progress.pct >= 80 ? "warning" : "accent"}
          className="w-full"
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      )}

      {snapshot && (
        <SettingsList label={t("后台用量保护", "Background usage caps")}>
          <Switch
            isSelected={snapshot.config.enabled}
            onChange={(enabled) => void persist({ enabled })}
            isReadOnly={saving}
            className="w-full"
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 items-center gap-2">
                <Label className="text-sm font-normal text-foreground">
                  {t("启用后台额度上限", "Enable background usage caps")}
                </Label>
                <Popover>
                  <Button
                    type="button"
                    slot={null}
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={t("后台用量保护说明", "About background usage caps")}
                  >
                    <KuloIcon name="help" size={14} />
                  </Button>
                  <Popover.Content placement="top" className="max-w-[min(320px,calc(100vw-24px))] motion-reduce:animate-none">
                    <Popover.Dialog aria-label={t("后台用量保护说明", "About background usage caps")} className="text-sm outline-none">
                      {t(
                        "仅限制云端模型的无人值守后台消耗；本机免费模型、前台手动对话与安防告警始终不受影响。设为 0 表示不限制该项。",
                        "Caps unattended cloud model usage only. Local models, foreground chats, and Home Assistant security alerts are never blocked. Set 0 for no limit.",
                      )}
                    </Popover.Dialog>
                  </Popover.Content>
                </Popover>
              </div>
              <Switch.Control className="justify-self-end">
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>

          {snapshot.config.enabled && (
            <>
              <Select
                variant="secondary"
                value={snapshot.config.scope}
                onChange={(value) => {
                  if (value === "all_background" || value === "schedules_only" || value === "assistant_only") {
                    void persist({ scope: value });
                  }
                }}
                isDisabled={saving}
                className="kulo-settings-row kulo-settings-row--choice"
              >
                <Label className="text-sm text-foreground">{t("达上限后暂停范围", "Pause scope")}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover className="motion-reduce:animate-none">
                  <ListBox>
                    {scopeOptions.map((opt) => (
                      <ListBox.Item key={opt.id} id={opt.id} textValue={opt.label}>
                        {opt.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <SettingsNumberField
                label={t("每日云端 Token 上限", "Daily token limit")}
                value={dailyKTokensDraft}
                onChange={setDailyKTokensDraft}
                onCommit={(val) => persist({ dailyTokenLimit: val > 0 ? Math.round(val) * 1000 : null })}
                minValue={0}
                maxValue={1_000_000}
                step={50}
                unit="k"
                isPending={saving}
              />

              <SettingsNumberField
                label={t("每周云端 Token 上限", "Weekly token limit")}
                value={weeklyKTokensDraft}
                onChange={setWeeklyKTokensDraft}
                onCommit={(val) => persist({ weeklyTokenLimit: val > 0 ? Math.round(val) * 1000 : null })}
                minValue={0}
                maxValue={1_000_000}
                step={100}
                unit="k"
                isPending={saving}
              />

              <SettingsNumberField
                label={t("每日费用上限", "Daily cost limit")}
                value={dailyCostDraft}
                onChange={setDailyCostDraft}
                onCommit={(val) => persist({ dailyCostUsdLimit: val > 0 ? val : null })}
                minValue={0}
                maxValue={100_000}
                step={0.5}
                unit="USD"
                isPending={saving}
              />
            </>
          )}
        </SettingsList>
      )}

      {error && (
        <Alert status="danger" className="rounded-2xl p-3">
          <Alert.Indicator />
          <Alert.Content className="text-sm">{error}</Alert.Content>
          <Button size="sm" variant="ghost" onPress={() => void load()}>
            {t("重试", "Retry")}
          </Button>
        </Alert>
      )}
    </SettingsSection>
  );
}
