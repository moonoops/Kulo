import { translate as t, useI18n } from "../../moco-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Label, Spinner, Switch, TextArea } from "@heroui/react";
import type { PersonalitySnapshot, RecentWorkSnapshot, RelationshipUpdateSettings } from "@moco/protocol";
import { MocoApiError, mocoRest } from "../../moco-api";
import { SettingsList, SettingsNumberField, SettingsSection } from "./settings-layout";

function initialSchedule(): RelationshipUpdateSettings {
  return { enabled: false, intervalDays: 1 };
}

type PersonalityChange = { field: "enabled"; value: boolean } | { field: "intervalDays"; value: number } | { field: "recentWorkEnabled"; value: boolean };

export function usePersonalityControls(topicId?: string, recentActive = false, recentUpdateKey?: string) {
  useI18n();
  const [snapshot, setSnapshot] = useState<PersonalitySnapshot | null>(null);
  const [schedule, setSchedule] = useState<RelationshipUpdateSettings>(initialSchedule);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingField, setSavingField] = useState<PersonalityChange["field"] | null>(null);
  const savingRef = useRef(false);
  const failedRelationshipChange = useRef<PersonalityChange | null>(null);
  const [failedRecentEnabled, setFailedRecentEnabled] = useState<boolean | null>(null);
  const [recentSaveError, setRecentSaveError] = useState<string>();
  const recentScope = useRef<{ topicId?: string; enabled?: boolean }>({ topicId });
  if (recentScope.current.topicId !== topicId) recentScope.current = { ...recentScope.current, topicId };
  const [recentResult, setRecentResult] = useState<{ scope: typeof recentScope.current; snapshot: RecentWorkSnapshot } | null>(null);
  const recent = recentResult?.scope === recentScope.current ? recentResult.snapshot : null;
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string>();
  const alive = useRef(true);
  const recentInFlight = useRef<Promise<void> | null>(null);
  const recentRequest = useRef<{ controller: AbortController; scope: typeof recentScope.current } | null>(null);
  const recentActiveRef = useRef(recentActive);
  recentActiveRef.current = recentActive;
  const recentUpdateRef = useRef({ key: recentUpdateKey });
  if (recentUpdateRef.current.key !== recentUpdateKey) recentUpdateRef.current = { key: recentUpdateKey };
  const snapshotRef = useRef(snapshot);
  const scheduleRef = useRef(schedule);
  snapshotRef.current = snapshot;
  scheduleRef.current = schedule;
  const dirty = Boolean(snapshot?.settings.relationshipUpdate.enabled && schedule.intervalDays !== snapshot.settings.relationshipUpdate.intervalDays);

  const acceptSnapshot = useCallback((next: PersonalitySnapshot, force = false) => {
    const current = snapshotRef.current;
    if (current && next.revision < current.revision) return;
    if (recentScope.current.enabled !== next.settings.recentWorkEnabled) {
      recentScope.current = { ...recentScope.current, enabled: next.settings.recentWorkEnabled };
    }
    const hasDraft = current && scheduleRef.current.intervalDays !== current.settings.relationshipUpdate.intervalDays;
    if (force || !hasDraft) {
      scheduleRef.current = next.settings.relationshipUpdate;
      setSchedule(next.settings.relationshipUpdate);
      setConflict(false);
    } else {
      const draft = { ...scheduleRef.current, enabled: next.settings.relationshipUpdate.enabled };
      scheduleRef.current = draft;
      setSchedule(draft);
      if (current.revision !== next.revision && current.settings.relationshipUpdate.intervalDays !== next.settings.relationshipUpdate.intervalDays) {
        setConflict(true);
        failedRelationshipChange.current = { field: "intervalDays", value: draft.intervalDays };
        setError(t("更新间隔已在其他会话修改，当前输入已保留。", "The interval changed in another window. Your input is preserved."));
      }
    }
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async (force = false) => {
    try {
      const next = await mocoRest.getPersonality();
      if (!alive.current) return;
      acceptSnapshot(next, force);
      if (force || !failedRelationshipChange.current) setError(undefined);
      if (force) failedRelationshipChange.current = null;
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : t("读取个性设置失败", "Failed to load personality settings"));
    } finally { if (alive.current) setLoading(false); }
  }, [acceptSnapshot]);

  const loadRecent = useCallback((force = false): Promise<void> => {
    const scope = recentScope.current;
    if (!alive.current || !recentActiveRef.current || !scope.enabled || document.visibilityState !== "visible") return Promise.resolve();
    if (recentInFlight.current) return recentInFlight.current;
    const update = recentUpdateRef.current;
    const controller = new AbortController();
    recentRequest.current = { controller, scope };
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, 8_000);
    setRecentLoading(true);
    setRecentError(undefined);
    const request = (async () => {
      try {
        const next = await (force ? mocoRest.refreshRecentWork(scope.topicId, controller.signal) : mocoRest.getRecentWork(scope.topicId, controller.signal));
        if (timedOut) throw new Error(t("读取近期工作超时，请重试。", "Loading recent work timed out. Try again."));
        if (!controller.signal.aborted && alive.current && recentScope.current === scope && recentUpdateRef.current === update) setRecentResult({ scope, snapshot: next });
      } catch (err) {
        const cancelled = !timedOut && controller.signal.aborted && err instanceof Error && err.name === "AbortError";
        if (!cancelled && alive.current && recentScope.current === scope && recentUpdateRef.current === update) setRecentError(timedOut ? t("读取近期工作超时，请重试。", "Loading recent work timed out. Try again.") : err instanceof Error ? err.message : t("读取近期工作失败", "Failed to load recent work"));
      } finally {
        window.clearTimeout(timeout);
        recentInFlight.current = null;
        recentRequest.current = null;
        if (alive.current) {
          setRecentLoading(false);
          // StrictMode can remount effects before their cancelled request has settled.
          if ((!timedOut && controller.signal.aborted) || recentScope.current !== scope || recentUpdateRef.current !== update) void loadRecent();
        }
      }
    })();
    recentInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") { recentRequest.current?.controller.abort(); return; }
      void refresh();
      void loadRecent();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { alive.current = false; recentRequest.current?.controller.abort(); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [refresh, loadRecent]);

  useEffect(() => {
    if (recentActive && snapshotRef.current && document.visibilityState === "visible") void refresh();
  }, [recentActive, refresh]);

  useEffect(() => {
    const request = recentRequest.current;
    if (!recentActive || !snapshot?.settings.recentWorkEnabled || request?.scope !== recentScope.current) request?.controller.abort();
    setRecentError(undefined);
    setRecentLoading(Boolean(recentActive && snapshot?.settings.recentWorkEnabled && recentInFlight.current));
    void loadRecent();
  }, [topicId, recentActive, snapshot?.settings.recentWorkEnabled, loadRecent]);

  useEffect(() => { void loadRecent(); }, [recentUpdateKey, loadRecent]);

  const commitChange = async (change: PersonalityChange, retry = false): Promise<boolean> => {
    const current = snapshotRef.current;
    if (!current || savingRef.current || change.field === "intervalDays" && conflict && !retry) return false;
    if (change.field === "intervalDays" && (!Number.isInteger(change.value) || change.value < 1 || change.value > 365)) {
      failedRelationshipChange.current = change;
      setError(t("更新间隔须为1至365天的整数。", "The interval must be a whole number from 1 to 365 days."));
      return false;
    }
    const settings = current.settings;
    const previous = change.field === "recentWorkEnabled" ? settings.recentWorkEnabled : settings.relationshipUpdate[change.field];
    if (previous === change.value) {
      if (change.field === "recentWorkEnabled") {
        setFailedRecentEnabled(null);
        setRecentSaveError(undefined);
      } else {
        if (change.field === "intervalDays" || !change.value) acceptSnapshot(current, true);
        failedRelationshipChange.current = null;
        setError(undefined);
        setConflict(false);
      }
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    setSavingField(change.field);
    if (change.field === "recentWorkEnabled") setRecentSaveError(undefined);
    else setError(undefined);
    try {
      // Only the committed snapshot supplies sibling fields; another control's input is never submitted here.
      const next = await mocoRest.savePersonalitySettings({ expectedRevision: current.revision, ...settings,
        ...(change.field === "recentWorkEnabled" ? { recentWorkEnabled: change.value }
          : { relationshipUpdate: { ...settings.relationshipUpdate, [change.field]: change.value } }),
      });
      acceptSnapshot(next, change.field === "intervalDays" || change.field === "enabled" && !change.value);
      if (change.field === "recentWorkEnabled") {
        setFailedRecentEnabled(null);
        setRecentSaveError(undefined);
        void loadRecent();
      } else {
        failedRelationshipChange.current = null;
        setError(undefined);
        setConflict(false);
      }
      return true;
    } catch (err) {
      if (err instanceof MocoApiError && err.status === 409) await refresh();
      const message = err instanceof Error ? err.message : t("保存失败", "Failed to save");
      if (change.field === "recentWorkEnabled") {
        setFailedRecentEnabled(change.value);
        setRecentSaveError(message);
      } else {
        failedRelationshipChange.current = change;
        setConflict(err instanceof MocoApiError && err.status === 409);
        setError(message);
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      setSavingField(null);
    }
  };

  const dismissProposal = async () => {
    if (!snapshot?.identityProposal) return;
    await mocoRest.dismissIdentityProposal(snapshot.identityProposal.id);
    await refresh();
  };

  return {
    snapshot, schedule, setSchedule: (next: RelationshipUpdateSettings) => { scheduleRef.current = next; setSchedule(next); },
    loading, error, conflict, saving, savingField, dirty, recent, recentLoading, recentError: recentSaveError ?? recentError,
    refresh,
    loadRecent: async (force = false) => {
      if (!alive.current || !recentActiveRef.current || document.visibilityState !== "visible") return;
      if (force) await refresh();
      await loadRecent(force);
    },
    saveSchedule: (intervalDays = scheduleRef.current.intervalDays) => commitChange({ field: "intervalDays", value: intervalDays }),
    setRelationshipEnabled: (enabled: boolean) => commitChange({ field: "enabled", value: enabled }),
    setRecentEnabled: (enabled: boolean) => commitChange({ field: "recentWorkEnabled", value: enabled }),
    retryRelationship: () => {
      const failed = failedRelationshipChange.current;
      return failed ? commitChange(failed.field === "intervalDays" ? { ...failed, value: scheduleRef.current.intervalDays } : failed, true) : refresh();
    },
    retryRecent: () => failedRecentEnabled !== null ? commitChange({ field: "recentWorkEnabled", value: failedRecentEnabled }, true) : loadRecent(true),
    dismissProposal,
    discard: () => {
      if (conflict) { void refresh(true); return; }
      if (snapshot) { scheduleRef.current = snapshot.settings.relationshipUpdate; setSchedule(snapshot.settings.relationshipUpdate); setConflict(false); setError(undefined); failedRelationshipChange.current = null; }
    },
    reload: () => refresh(true),
  };
}

export type PersonalityControls = ReturnType<typeof usePersonalityControls>;

export function RelationshipUpdateControls({ controls }: { controls: PersonalityControls }) {
  useI18n();
  const { snapshot, schedule, setSchedule, loading, saving, conflict, error } = controls;
  const status = snapshot?.relationshipStatus;
  return (
    <div className="moco-form-stack">
      <SettingsList label={t("自动更新设置", "Auto-update settings")}>
        <Switch className="w-full" aria-label={t("自动更新协作关系", "Automatically update collaboration")} isSelected={snapshot?.settings.relationshipUpdate.enabled ?? false} isDisabled={loading || !snapshot} isReadOnly={saving} onChange={(enabled) => void controls.setRelationshipEnabled(enabled)}>
          <Switch.Content className="moco-settings-row moco-settings-row--toggle">
            <Label className="moco-field-label">{t("自动更新", "Auto-update")}{controls.savingField === "enabled" && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}</Label>
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch.Content>
        </Switch>
        {snapshot?.settings.relationshipUpdate.enabled && <SettingsNumberField
          label={t("更新间隔", "Update interval")} unit={t("天", "days")}
          value={schedule.intervalDays} minValue={1} maxValue={365} step={1}
          isDisabled={loading} isPending={saving}
          onChange={(intervalDays) => setSchedule({ ...schedule, intervalDays })}
          onCommit={(intervalDays) => controls.saveSchedule(intervalDays)}
        />}
      </SettingsList>
      {error && <Alert status={conflict ? "warning" : "danger"} className="flex flex-wrap items-center gap-3 rounded-xl p-3"><Alert.Indicator /><Alert.Content className="flex-1 text-sm">{error}</Alert.Content>
        <Button size="sm" variant="secondary" isDisabled={saving} onPress={() => void (snapshot ? controls.retryRelationship() : controls.refresh())}>{t("重试", "Retry")}</Button>
        {conflict && <Button size="sm" variant="tertiary" isDisabled={saving} onPress={() => void controls.reload()}>{t("使用最新值", "Use latest")}</Button>}
      </Alert>}
      {status?.lastError && <Alert status="danger" className="rounded-xl p-3"><Alert.Indicator /><Alert.Content className="text-sm">{status.lastError}</Alert.Content></Alert>}
    </div>
  );
}

export function RecentWorkPanel({ controls }: { controls: PersonalityControls }) {
  useI18n();
  const { snapshot, recent, recentLoading, recentError, loading, saving } = controls;
  return (
    <div className="moco-settings-form gap-4">
      <SettingsSection title={t("近期工作", "Recent work")} status={controls.savingField === "recentWorkEnabled" ? <Spinner size="sm" aria-label={t("正在保存", "Saving")} /> : undefined} action={
        <Switch aria-label={t("启用近期工作", "Enable recent work")} isSelected={snapshot?.settings.recentWorkEnabled ?? true} isDisabled={loading || !snapshot} isReadOnly={saving} onChange={(enabled) => void controls.setRecentEnabled(enabled)}>
          <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
        </Switch>
      }>
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4">
          {recentLoading && !recent ? <div className="flex min-h-48 items-center justify-center"><Spinner size="sm" aria-label={t("正在读取近期工作", "Loading recent work")} /></div> : <TextArea aria-label={t("近期工作摘要", "Recent work summary")} readOnly value={recent?.content ?? ""} placeholder={t("暂无近期工作", "No recent work")} rows={14} variant="secondary" fullWidth className="scrollbar min-h-72 resize-y text-sm " />}
          <div className="flex justify-end"><Button variant="secondary" isPending={recentLoading} isDisabled={saving || !snapshot || !snapshot.settings.recentWorkEnabled} onPress={() => void controls.loadRecent(true)}>{t("立即刷新", "Refresh now")}</Button></div>
        </div>
      </SettingsSection>
      {recentError && <Alert status="danger" className="rounded-xl p-3"><Alert.Indicator /><Alert.Content className="flex-1 text-sm">{recentError}</Alert.Content><Button variant="secondary" size="sm" isDisabled={saving} onPress={() => void controls.retryRecent()}>{t("重试", "Retry")}</Button></Alert>}
      {!snapshot && controls.error && <Alert status="danger" className="rounded-xl p-3"><Alert.Indicator /><Alert.Content className="flex-1 text-sm">{controls.error}</Alert.Content><Button variant="secondary" size="sm" onPress={() => void controls.refresh()}>{t("重试", "Retry")}</Button></Alert>}
    </div>
  );
}
