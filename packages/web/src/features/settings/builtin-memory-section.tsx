import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Label, Spinner, Switch } from "@heroui/react";
import { redactSecrets, type BuiltinMemoryStateView } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloApiError } from "../../kulo-api";
import { translate as t, useI18n } from "../../kulo-i18n";
import { BUILTIN_MEMORY_CHANGED_EVENT, builtinMemoryApi, publishBuiltinMemoryState } from "./builtin-memory-api";
import { SettingsList, SettingsSection } from "./settings-layout";
import { useSettingsPending } from "./settings-save-activity";

const DEFAULT_BUILTIN_MEMORY_STATE: BuiltinMemoryStateView = {
  enabled: true,
  revision: 1,
  clearTargetEpoch: 0,
  appliedClearEpoch: 0,
  engineEpoch: 1,
  clearedAt: null,
  supersededByHindsight: false,
};

function newOperationId(): string {
  return `bm-clear-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function BuiltinMemorySection({
  connected = true,
  hindsightEnabled = false,
  initialState,
  onBusyChange,
}: {
  connected?: boolean;
  hindsightEnabled?: boolean;
  initialState?: BuiltinMemoryStateView;
  onBusyChange?: (busy: boolean) => void;
}) {
  useI18n();
  const [state, setState] = useState<BuiltinMemoryStateView>(
    () => initialState ?? { ...DEFAULT_BUILTIN_MEMORY_STATE, supersededByHindsight: hindsightEnabled },
  );
  const [loadStatus, setLoadStatus] = useState<"ready" | "loading" | "error" | "forbidden">(
    () => (initialState ? "ready" : "loading"),
  );
  const [pending, setPending] = useState<"enabled" | "clear" | null>(null);
  const [error, setError] = useState<string>();
  const [clearedNotice, setClearedNotice] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const clearOpIdRef = useRef<string | null>(null);
  const switchRef = useRef<HTMLElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<"switch" | "clear" | null>(null);
  const busy = pending !== null;
  useSettingsPending(busy);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const refreshState = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await builtinMemoryApi.getState(signal);
      setState(next);
      setLoadStatus("ready");
      setError(undefined);
    } catch (cause) {
      if (signal?.aborted) return;
      setLoadStatus(cause instanceof KuloApiError && cause.status === 403 ? "forbidden" : "error");
      setError(redactSecrets(cause instanceof Error ? cause.message : t("读取内置记忆状态失败", "Failed to load built-in memory state")));
    }
  }, []);

  useEffect(() => {
    if (!connected || initialState) return;
    const controller = new AbortController();
    void refreshState(controller.signal);
    return () => controller.abort();
  }, [connected, hindsightEnabled, initialState, refreshState]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<BuiltinMemoryStateView>).detail;
      if (next && typeof next.revision === "number") {
        setState((cur) => (next.revision >= cur.revision || next.supersededByHindsight !== cur.supersededByHindsight ? next : cur));
        setLoadStatus("ready");
      }
    };
    window.addEventListener(BUILTIN_MEMORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(BUILTIN_MEMORY_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    if (!busy && restoreFocusRef.current) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (document.activeElement === document.body) {
        if (target === "switch") switchRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
        else clearButtonRef.current?.focus();
      }
    }
  }, [busy]);

  const controlsReady = loadStatus === "ready";
  const superseded = controlsReady ? state.supersededByHindsight : hindsightEnabled;
  const effectiveEnabled = controlsReady && state.enabled && !superseded && !state.blocked;

  const handleToggle = async (nextEnabled: boolean) => {
    if (busy || !connected || !controlsReady || superseded) return;
    restoreFocusRef.current = switchRef.current?.contains(document.activeElement) ? "switch" : null;
    setPending("enabled");
    setError(undefined);
    setClearedNotice(false);
    try {
      const updated = await builtinMemoryApi.setEnabled({
        enabled: nextEnabled,
        expectedRevision: state.revision,
      });
      setState(updated);
      publishBuiltinMemoryState(updated);
    } catch (cause) {
      if (cause instanceof KuloApiError && cause.status === 409) {
        await refreshState();
      }
      setError(redactSecrets(cause instanceof Error ? cause.message : t("更新内置记忆开关失败", "Failed to update built-in memory setting")));
    } finally {
      setPending(null);
    }
  };

  const openClearConfirm = () => {
    if (busy || !connected || !controlsReady) return;
    clearOpIdRef.current = newOperationId();
    setError(undefined);
    setClearedNotice(false);
    setConfirmOpen(true);
  };

  const handleClearConfirm = async () => {
    if (busy || !connected || !controlsReady) return;
    restoreFocusRef.current = "clear";
    setPending("clear");
    setError(undefined);
    const operationId = clearOpIdRef.current ?? newOperationId();
    clearOpIdRef.current = operationId;
    try {
      const updated = await builtinMemoryApi.clear({
        confirm: true,
        expectedEpoch: state.clearTargetEpoch,
        operationId,
      });
      setState(updated);
      publishBuiltinMemoryState(updated);
      clearOpIdRef.current = null;
      setConfirmOpen(false);
      setClearedNotice(true);
    } catch (cause) {
      if (cause instanceof KuloApiError && cause.status === 409) {
        await refreshState();
        clearOpIdRef.current = null;
        setConfirmOpen(false);
      }
      setError(redactSecrets(cause instanceof Error ? cause.message : t("清空内置记忆失败", "Failed to clear built-in memory")));
    } finally {
      setPending(null);
    }
  };

  const statusChip = superseded
    ? <Chip size="sm" variant="soft">{t("由 Hindsight 接管", "Managed by Hindsight")}</Chip>
    : loadStatus === "loading"
      ? undefined
      : loadStatus === "forbidden" || loadStatus === "error" || state.blocked
        ? <Chip size="sm" variant="soft" color="warning">{t("暂不可用", "Unavailable")}</Chip>
        : <Chip size="sm" variant="soft" color={effectiveEnabled ? "success" : "default"}>{effectiveEnabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}</Chip>;

  return (
    <div className="kulo-settings-form gap-4" aria-busy={busy || undefined}>
      <SettingsSection title={t("内置记忆", "Built-in memory")} status={statusChip}>
        <SettingsList label={t("内置记忆选项", "Built-in memory options")}>
          <Switch
            ref={switchRef as never}
            className="w-full"
            aria-label={t("启用内置记忆", "Enable built-in memory")}
            isSelected={controlsReady && state.enabled}
            isDisabled={!connected || !controlsReady || busy || superseded}
            onChange={(next) => void handleToggle(next)}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 items-center gap-2">
                <Label className="text-sm font-normal text-foreground">{t("启用内置记忆", "Enable built-in memory")}</Label>
                {pending === "enabled" && <Spinner size="sm" aria-label={t("保存内置记忆状态", "Saving built-in memory state")} />}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          <div className="kulo-settings-row kulo-settings-row--toggle">
            <span className="kulo-field-label text-sm font-normal text-foreground">{t("本地长期记忆", "Local long-term memory")}</span>
            <Button
              ref={clearButtonRef}
              type="button"
              size="sm"
              variant="secondary"
              className="justify-self-end"
              isDisabled={!connected || !controlsReady || busy}
              isPending={pending === "clear"}
              onPress={openClearConfirm}
            >
              {t("清空内置记忆", "Clear built-in memory")}
            </Button>
          </div>
        </SettingsList>
      </SettingsSection>

      {!confirmOpen && error && (
        <Alert status="danger" role="alert" className="rounded-2xl p-3">
          <Alert.Content className="flex-1 break-words text-sm">{error}</Alert.Content>
        </Alert>
      )}
      {!error && clearedNotice && (
        <Alert status="success" role="status" className="rounded-2xl p-3">
          <Alert.Content className="text-sm">{t("内置记忆已清空", "Built-in memory cleared")}</Alert.Content>
        </Alert>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t("清空内置记忆？", "Clear built-in memory?")}
        description={(
          <div className="flex flex-col gap-3">
            <p className="m-0">
              {t(
                "将永久清空个人及项目共享的内置长期记忆。聊天记录、近期工作、身份约定、协作关系及外部 Hindsight 服务会保留。",
                "Permanently clears personal and shared project built-in long-term memory. Chat history, recent work, identity agreement, working relationship, and external Hindsight services will be kept.",
              )}
            </p>
            {error && (
              <Alert status="danger" role="alert" className="rounded-2xl p-3">
                <Alert.Content className="flex-1 break-words text-sm">{error}</Alert.Content>
              </Alert>
            )}
          </div>
        )}
        confirmLabel={t("清空内置记忆", "Clear built-in memory")}
        status="danger"
        isPending={pending === "clear"}
        onCancel={() => {
          if (pending !== "clear") {
            clearOpIdRef.current = null;
            setError(undefined);
            setConfirmOpen(false);
          }
        }}
        onConfirm={() => void handleClearConfirm()}
      />
    </div>
  );
}
