import { useEffect, useRef, useState } from "react";
import { Alert, Button, Label, ListBox, Popover, ProgressBar, Select, Switch } from "@heroui/react";
import type { CompletedTaskDisplayHours, ExecutorSlotsConfig, MocoSettingsView, SlotSummary } from "@moco/protocol";
import { MocoApiError, mocoRest } from "../../moco-api";
import { useI18n } from "../../moco-i18n";
import { MocoIcon } from "../../moco-icon";
import { ExecutorSettingConflict, ExecutorSettingWriter, executorSettingValue, type ExecutorSetting } from "./executor-setting-writer";
import { SettingsList, SettingsNumberField, SettingsSection } from "./settings-layout";
import { useSettingsPending } from "./settings-save-activity";

type NumberSetting = "maxConcurrentWorkers" | "maxSubagentsPerTicket" | "watchdogMinutes" | "autoArchiveDays";
type NumberDraft = { value: number; base: number };
type NumberDrafts = Partial<Record<NumberSetting, NumberDraft>>;
type SaveFailure = { value: ExecutorSlotsConfig[ExecutorSetting]; message: string; conflict: boolean };

const numberRanges: Record<NumberSetting, { min: number; max: number }> = {
  maxConcurrentWorkers: { min: 1, max: 16 },
  maxSubagentsPerTicket: { min: 1, max: 8 },
  watchdogMinutes: { min: 0, max: 60 },
  autoArchiveDays: { min: 1, max: 3650 },
};

function isNumberSetting(key: ExecutorSetting): key is NumberSetting {
  return key in numberRanges;
}

function validNumber(key: NumberSetting, value: number): boolean {
  const { min, max } = numberRanges[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

export function ConcurrencyModule({
  settings,
  slots,
  onSettingsUpdated,
  onDirtyChange,
}: {
  settings: MocoSettingsView;
  slots?: SlotSummary;
  onSettingsUpdated: (next: MocoSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [writer] = useState(() => new ExecutorSettingWriter(settings, (revision, value) => mocoRest.saveSettingsBlock("executor", revision, value)));
  writer.accept(settings);
  const exec = writer.snapshot.blocks.executor;
  const [drafts, setDrafts] = useState<NumberDrafts>({});
  const draftsRef = useRef(drafts);
  const [pending, setPending] = useState<Partial<Record<ExecutorSetting, boolean>>>({});
  const pendingRef = useRef(pending);
  const [targets, setTargets] = useState<Partial<ExecutorSlotsConfig>>({});
  const [failures, setFailures] = useState<Partial<Record<ExecutorSetting, SaveFailure>>>({});
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const displayTrigger = useRef<HTMLButtonElement>(null);
  const displayPopover = useRef<HTMLDivElement>(null);
  const restoreDisplayFocus = useRef(false);
  const busy = reloading || Object.values(pending).some(Boolean);
  useSettingsPending(busy);

  const labels: Record<ExecutorSetting, string> = {
    paused: t("接收新任务", "Accept new tasks"),
    maxConcurrentWorkers: t("并发智能体上限", "Concurrent agent limit"),
    maxSubagentsPerTicket: t("并发子智能体上限", "Concurrent subagent limit"),
    watchdogMinutes: t("超时检查", "Inactivity check"),
    completedTaskDisplayHours: t("已完成任务显示时长", "Show completed tasks for"),
    autoArchiveEnabled: t("自动归档", "Auto-archive"),
    autoArchiveDays: t("未活动超过", "Inactive for more than"),
  };
  const completedDisplayOptions: ReadonlyArray<{ value: string; hours: CompletedTaskDisplayHours; label: string }> = [
    { value: "1", hours: 1, label: t("1 小时", "1 hour") },
    { value: "3", hours: 3, label: t("3 小时", "3 hours") },
    { value: "6", hours: 6, label: t("6 小时", "6 hours") },
    { value: "always", hours: null, label: t("一直显示", "Always show") },
  ];
  const autoArchiveEnabled = executorSettingValue(exec.value, "autoArchiveEnabled") !== false;
  const completedTaskDisplayHours = targets.completedTaskDisplayHours === undefined
    ? executorSettingValue(exec.value, "completedTaskDisplayHours")
    : targets.completedTaskDisplayHours;
  const dirty = (Object.entries(drafts) as [NumberSetting, NumberDraft][]).some(([key, draft]) => !Object.is(draft.value, executorSettingValue(exec.value, key)));

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (pending.completedTaskDisplayHours || !restoreDisplayFocus.current) return;
    restoreDisplayFocus.current = false;
    if (typeof document !== "undefined" && document.activeElement === document.body && !displayTrigger.current?.disabled) {
      displayTrigger.current?.focus({ preventScroll: true });
    }
  }, [pending.completedTaskDisplayHours]);

  function replaceDrafts(next: NumberDrafts) {
    draftsRef.current = next;
    setDrafts(next);
  }

  function clearFailure(key: ExecutorSetting) {
    setFailures((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function discardNumber(key: NumberSetting) {
    const next = { ...draftsRef.current };
    delete next[key];
    replaceDrafts(next);
    clearFailure(key);
  }

  // A disabled policy has no editable interval; cancel it only after the saved switch is off.
  useEffect(() => {
    if (!autoArchiveEnabled) discardNumber("autoArchiveDays");
  }, [autoArchiveEnabled]);

  function changeNumber(key: NumberSetting, value: number) {
    const next = { ...draftsRef.current };
    const saved = executorSettingValue(writer.snapshot.blocks.executor.value, key) as number;
    if (Object.is(value, saved)) delete next[key];
    else next[key] = { value, base: next[key]?.base ?? saved };
    replaceDrafts(next);
    clearFailure(key);
  }

  async function saveSetting<K extends ExecutorSetting>(key: K, value: ExecutorSlotsConfig[K], expected?: ExecutorSlotsConfig[K]) {
    if (pendingRef.current[key]) return;
    pendingRef.current = { ...pendingRef.current, [key]: true };
    setPending(pendingRef.current);
    if (!isNumberSetting(key)) setTargets((current) => ({ ...current, [key]: value }));
    clearFailure(key);
    try {
      const latest = await writer.commit(key, value, expected);
      if (isNumberSetting(key)) {
        const next = { ...draftsRef.current };
        if (Object.is(next[key]?.value, value)) delete next[key];
        else if (next[key]) next[key] = { ...next[key], base: executorSettingValue(latest.blocks.executor.value, key) as number };
        replaceDrafts(next);
      }
      if (key === "autoArchiveEnabled" && value === false) discardNumber("autoArchiveDays");
      onSettingsUpdated(latest);
    } catch (error) {
      const conflict = error instanceof ExecutorSettingConflict || error instanceof MocoApiError && error.status === 409;
      setFailures((current) => ({
        ...current,
        [key]: {
          value,
          conflict,
          message: conflict
            ? t("配置已被其他会话修改，本地输入已保留。", "Settings changed in another session. Your input has been kept.")
            : error instanceof Error ? error.message : t("保存失败", "Failed to save"),
        },
      }));
    } finally {
      pendingRef.current = { ...pendingRef.current, [key]: false };
      setPending(pendingRef.current);
      setTargets((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function commitNumber(key: NumberSetting, value: number, retry = false) {
    // Blur can run before a recovery button's press; it must not restart a failed save.
    if (
      writer.blocked ||
      (!retry && failures[key]) ||
      !validNumber(key, value) ||
      (key === "autoArchiveDays" && !autoArchiveEnabled)
    ) return;
    const draft = draftsRef.current[key];
    if (!draft) return;
    return saveSetting(key, value, draft.base);
  }

  async function reloadLatest() {
    if (busy) return;
    setReloading(true);
    setReloadError(undefined);
    try {
      writer.reload(await mocoRest.getSettings());
      const latest = writer.snapshot;
      const next = { ...draftsRef.current };
      for (const key of Object.keys(next) as NumberSetting[]) {
        if (key === "autoArchiveDays" && executorSettingValue(latest.blocks.executor.value, "autoArchiveEnabled") === false) delete next[key];
        else if (next[key]) next[key] = { ...next[key], base: executorSettingValue(latest.blocks.executor.value, key) as number };
      }
      replaceDrafts(next);
      setFailures((current) => {
        const nextFailures = { ...current };
        for (const key of Object.keys(nextFailures) as ExecutorSetting[]) {
          const failure = nextFailures[key];
          if (key === "autoArchiveDays" && executorSettingValue(latest.blocks.executor.value, "autoArchiveEnabled") === false) delete nextFailures[key];
          else if (failure) nextFailures[key] = {
            ...failure,
            conflict: false,
            message: t("已加载最新配置，请确认后重试。", "Latest settings loaded. Review your value before retrying."),
          };
        }
        return nextFailures;
      });
      onSettingsUpdated(latest);
    } catch (error) {
      setReloadError(error instanceof Error ? error.message : t("同步最新设置失败", "Failed to sync the latest settings"));
    } finally {
      setReloading(false);
    }
  }

  function numberProps(key: NumberSetting) {
    const value = drafts[key]?.value ?? executorSettingValue(exec.value, key) as number;
    const { min, max } = numberRanges[key];
    const invalid = Boolean(drafts[key]) && !validNumber(key, value);
    return {
      label: labels[key],
      value,
      onChange: (next: number) => changeNumber(key, next),
      onCommit: (next: number) => commitNumber(key, next),
      minValue: min,
      maxValue: max,
      step: 1,
      isPending: Boolean(pending[key]),
      isInvalid: invalid,
      errorMessage: invalid ? t(`请输入 ${min} 至 ${max} 的整数`, `Enter a whole number from ${min} to ${max}`) : undefined,
    };
  }

  const savingLabel = <span role="status" className="text-xs text-muted">{t("保存中…", "Saving…")}</span>;
  const used = slots?.used ?? 0;
  const max = slots?.max ?? exec.value.maxConcurrentWorkers;
  const queued = slots?.queuedCount ?? 0;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;

  return (
    <div className="moco-settings-form" aria-busy={busy}>
      <SettingsSection
        title={t("运行状态", "Runtime status")}
        action={
          <span className="text-sm tabular-nums text-muted" role="status">
            {slots ? used + " / " + max + t(" 运行中", " Running") : t("等待运行状态", "Waiting for runtime status")}
            {queued > 0 ? " · " + queued + t(" 排队", " Queued") : ""}
          </span>
        }
      >
        {slots && (
          <ProgressBar aria-label={t("智能体并发占用", "Active agents")} value={pct} size="sm" className="w-full">
            <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
          </ProgressBar>
        )}
      </SettingsSection>

      <SettingsSection title={t("运行策略", "Runtime policy")}>
        <SettingsList label={t("运行策略", "Runtime policy")}>
          <Switch
            isSelected={!(targets.paused ?? exec.value.paused)}
            onChange={(active) => void saveSetting("paused", !active)}
            isReadOnly={Boolean(pending.paused)}
            isDisabled={writer.blocked}
            className="w-full"
          >
            <Switch.Content className="moco-settings-row moco-settings-row--toggle">
              <div className="flex min-w-0 items-center gap-2">
                <Label className="text-sm font-normal text-foreground">{labels.paused}</Label>
                {pending.paused && savingLabel}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>

          <SettingsNumberField {...numberProps("maxConcurrentWorkers")} unit={t("个", "")} />
          <SettingsNumberField {...numberProps("maxSubagentsPerTicket")} unit={t("个", "")} />
          <SettingsNumberField
            {...numberProps("watchdogMinutes")}
            unit={t("分钟", "minutes")}
            labelAction={
              <Popover>
                <Button type="button" slot={null} isIconOnly size="sm" variant="ghost" aria-label={t("超时检查说明", "About inactivity checks")}>
                  <MocoIcon name="help" size={14} />
                </Button>
                <Popover.Content placement="top" className="max-w-[min(300px,calc(100vw-24px))] motion-reduce:animate-none">
                  <Popover.Dialog aria-label={t("超时检查说明", "About inactivity checks")} className="text-sm outline-none">
                    {t("智能体持续一段时间没有新进展时，主智能体会主动检查任务状态。0 表示关闭。", "The main agent checks task status after a period without progress. Set to 0 to disable.")}
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
            }
          />
          <Select
            variant="secondary"
            value={completedTaskDisplayHours === null ? "always" : String(completedTaskDisplayHours)}
            onChange={(value) => {
              const option = completedDisplayOptions.find((entry) => entry.value === value);
              if (option) {
                const focused = typeof document === "undefined" ? null : document.activeElement;
                restoreDisplayFocus.current = Boolean(focused && (focused === displayTrigger.current || displayPopover.current?.contains(focused)));
                void saveSetting("completedTaskDisplayHours", option.hours);
              }
            }}
            isDisabled={Boolean(pending.completedTaskDisplayHours) || writer.blocked}
            className="moco-settings-row moco-settings-row--choice"
          >
            <Label className="text-sm text-foreground">
              {labels.completedTaskDisplayHours}
              {pending.completedTaskDisplayHours && savingLabel}
            </Label>
            <Select.Trigger ref={displayTrigger}><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover ref={displayPopover} className="motion-reduce:animate-none">
              <ListBox>
                {completedDisplayOptions.map((option) => (
                  <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                    {option.label}<ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Switch
            isSelected={targets.autoArchiveEnabled ?? autoArchiveEnabled}
            onChange={(enabled) => void saveSetting("autoArchiveEnabled", enabled)}
            isReadOnly={Boolean(pending.autoArchiveEnabled)}
            isDisabled={writer.blocked}
            className="w-full"
          >
            <Switch.Content className="moco-settings-row moco-settings-row--toggle">
              <div className="flex min-w-0 items-center gap-2">
                <Label className="text-sm font-normal text-foreground">{labels.autoArchiveEnabled}</Label>
                {pending.autoArchiveEnabled && savingLabel}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          {autoArchiveEnabled && <SettingsNumberField {...numberProps("autoArchiveDays")} unit={t("天", "days")} isDisabled={Boolean(pending.autoArchiveEnabled)} />}
        </SettingsList>
      </SettingsSection>

      {writer.blocked && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="text-sm">{reloadError ?? t("运行配置已更新，请加载最新版本后重试。", "Runtime settings changed. Load the latest version before retrying.")}</Alert.Content>
          <Button size="sm" variant="secondary" isPending={reloading} isDisabled={busy && !reloading} onPress={() => void reloadLatest()}>
            {t("加载最新版本", "Load latest version")}
          </Button>
        </Alert>
      )}
      {(Object.entries(failures) as [ExecutorSetting, SaveFailure][]).map(([key, failure]) => (
        <Alert key={key} status={failure.conflict ? "warning" : "danger"}>
          <Alert.Indicator />
          <Alert.Content className="text-sm">{labels[key]} · {failure.message}</Alert.Content>
          <div className="flex items-center gap-2">
            {!writer.blocked && <Button size="sm" variant="secondary" isDisabled={Boolean(pending[key])} onPress={() => {
              if (isNumberSetting(key)) void commitNumber(key, draftsRef.current[key]?.value ?? failure.value as number, true);
              else void saveSetting<ExecutorSetting>(key, failure.value);
            }}>{t("重试", "Retry")}</Button>}
            {isNumberSetting(key) && <Button size="sm" variant="tertiary" isDisabled={Boolean(pending[key])} onPress={() => discardNumber(key)}>{t("放弃", "Discard")}</Button>}
          </div>
        </Alert>
      ))}
    </div>
  );
}
