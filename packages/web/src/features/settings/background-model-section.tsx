import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, ComboBox, Input, Label, ListBox, Popover, Select, Spinner } from "@heroui/react";
import { redactSensitiveText, type AssistantBackgroundModelStatus } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { backgroundModelApi, type BackgroundModelView } from "./background-model-api";
import type { ProviderModelGroup } from "./settings-helpers";
import { SettingsList, SettingsSection } from "./settings-layout";

const AUTO_KEY = "__auto__";
const LOCAL_MANAGED_KEY = "__local_managed__";

export function BackgroundModelSection({
  groups,
  connected = true,
  loadingProviders = false,
  assistantBusy = false,
  modelRevision,
  providersSignature,
  refreshToken = 0,
  initialView,
  onStatusChange,
}: {
  groups: ProviderModelGroup[];
  connected?: boolean;
  loadingProviders?: boolean;
  assistantBusy?: boolean;
  modelRevision: number;
  providersSignature: string;
  refreshToken?: number;
  initialView?: BackgroundModelView | null;
  onStatusChange?: (status: AssistantBackgroundModelStatus | null) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<BackgroundModelView | null>(initialView ?? null);
  const [loading, setLoading] = useState(!initialView);
  const [saving, setSaving] = useState(false);
  const [restartingLocal, setRestartingLocal] = useState(false);
  const [draftProviderId, setDraftProviderId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reqSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const prevBusyRef = useRef(assistantBusy);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const applyView = useCallback((next: BackgroundModelView) => {
    setView(next);
    setLoadError(null);
    onStatusChangeRef.current?.(next.backgroundModel);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!connected) return;
    const seq = ++reqSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!quiet) setLoading(true);
    try {
      const next = await backgroundModelApi.get({ signal: controller.signal });
      if (seq !== reqSeqRef.current || controller.signal.aborted) return;
      applyView(next);
    } catch (cause) {
      if (seq === reqSeqRef.current && !controller.signal.aborted) {
        setLoadError(redactSensitiveText(cause instanceof Error ? cause.message : t("加载后台处理模型失败", "Failed to load background processing model")));
      }
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [applyView, connected, t]);

  useEffect(() => {
    if (initialView) {
      onStatusChangeRef.current?.(initialView.backgroundModel);
      return;
    }
    if (!connected) {
      ++reqSeqRef.current;
      abortRef.current?.abort();
      setLoading(false);
      return;
    }
    void refresh(Boolean(view));
    return () => {
      ++reqSeqRef.current;
      abortRef.current?.abort();
    };
  }, [connected, initialView, modelRevision, providersSignature, refresh, refreshToken]);

  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = assistantBusy;
    if (wasBusy && !assistantBusy && connected && !initialView) {
      void refresh(true);
    }
  }, [assistantBusy, connected, initialView, refresh]);

  const bg = view?.backgroundModel;
  const bgJobRunning = bg?.job?.status === "queued" || bg?.job?.status === "running";
  const shouldPoll = !initialView && connected && (assistantBusy || bgJobRunning || restartingLocal);

  useEffect(() => {
    if (initialView || !connected) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = shouldPoll
      ? setInterval(() => {
          if (document.visibilityState === "visible") void refresh(true);
        }, 2_000)
      : null;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [connected, initialView, refresh, shouldPoll]);

  useEffect(() => {
    if (draftProviderId !== null && !groups.some((group) => group.providerId === draftProviderId)) {
      setDraftProviderId(null);
    }
  }, [draftProviderId, groups]);

  const isLocalManaged = bg?.mode === "local-managed" || bgJobRunning;
  const effectiveProviderId = draftProviderId !== null
    ? draftProviderId
    : bg?.mode === "kulo-provider"
      ? (bg.providerId ?? "")
      : "";
  const selectedGroup = effectiveProviderId
    ? groups.find((group) => group.providerId === effectiveProviderId)
    : undefined;
  const models = selectedGroup?.models ?? [];
  const activeModelId = draftProviderId !== null
    ? ""
    : bg?.mode === "kulo-provider"
      ? (bg.modelId ?? "")
      : "";
  const matchedModel = models.find((item) => item.id === activeModelId);

  const engineLabel = bg?.engine === "ollama" ? "Ollama" : "oMLX";
  const managedHostLabel = view?.localHost === false
    ? t(`主机托管（${engineLabel}）`, `Host managed (${engineLabel})`)
    : t(`本机托管（${engineLabel}）`, `Local managed (${engineLabel})`);

  const selectValue: string | null = draftProviderId !== null
    ? (selectedGroup ? draftProviderId : null)
    : isLocalManaged
      ? LOCAL_MANAGED_KEY
      : bg?.mode === "kulo-provider"
        ? (selectedGroup ? effectiveProviderId : null)
        : AUTO_KEY;

  const unavailableProviderLabel = effectiveProviderId === "kulo-gateway"
    ? t("兼容网关（不可用）", "Compatible gateway (unavailable)")
    : t(`${effectiveProviderId}（不可用）`, `${effectiveProviderId} (unavailable)`);

  const managedChip: { color: "success" | "warning" | "default"; label: string } = bgJobRunning || restartingLocal
    ? { color: "default", label: bg?.job?.progress || t("正在启动…", "Starting…") }
    : bg?.running
      ? { color: "success", label: t("运行中", "Running") }
      : { color: "warning", label: t("未运行", "Stopped") };

  const persistConfig = async (payload: Parameters<typeof backgroundModelApi.configure>[0]) => {
    if (!connected || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      const next = await backgroundModelApi.configure(payload);
      setDraftProviderId(null);
      applyView(next);
    } catch (cause) {
      setActionError(redactSensitiveText(cause instanceof Error ? cause.message : t("保存后台处理模型失败", "Failed to save background processing model")));
    } finally {
      setSaving(false);
    }
  };

  const resetToAuto = async () => {
    setDraftProviderId(null);
    setRestartingLocal(false);
    await persistConfig({ mode: "auto" });
  };

  const restartLocalManaged = async () => {
    if (!connected || saving || restartingLocal || !bg?.engine || !bg.modelId) return;
    setRestartingLocal(true);
    setActionError(null);
    try {
      const next = await backgroundModelApi.configure({
        mode: "local-managed",
        engine: bg.engine,
        modelId: bg.modelId,
        confirmed: true,
      });
      applyView(next);
    } catch (cause) {
      setActionError(redactSensitiveText(cause instanceof Error ? cause.message : t("启动托管模型失败", "Failed to start managed model")));
      void refresh(true);
    } finally {
      setRestartingLocal(false);
    }
  };

  const handleProviderChange = (key: string) => {
    if (key === LOCAL_MANAGED_KEY) return;
    if (key === AUTO_KEY) {
      void resetToAuto();
      return;
    }
    const group = groups.find((item) => item.providerId === key);
    if (!group) return;
    const firstModel = group.models[0];
    if (!firstModel) {
      setActionError(null);
      setDraftProviderId(group.providerId);
      return;
    }
    void persistConfig({ mode: "kulo-provider", providerId: group.providerId, modelId: firstModel.id });
  };

  const handleModelChange = (nextModelId: string) => {
    if (!selectedGroup || !models.some((item) => item.id === nextModelId)) return;
    if (bg?.mode === "kulo-provider" && bg.providerId === selectedGroup.providerId && bg.modelId === nextModelId && draftProviderId === null) {
      return;
    }
    void persistConfig({ mode: "kulo-provider", providerId: selectedGroup.providerId, modelId: nextModelId });
  };

  const showModelCombo = !isLocalManaged && (draftProviderId !== null || bg?.mode === "kulo-provider");
  const showBusySpinner = (loading && !view) || saving || bgJobRunning || restartingLocal;

  return (
    <SettingsSection
      title={t("后台处理模型", "Background processing model")}
      status={
        <>
          <Popover>
            <Button
              type="button"
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={t("后台处理模型说明", "About background processing model")}
            >
              <KuloIcon name="help" size={14} />
            </Button>
            <Popover.Content placement="top" className="max-w-[min(320px,calc(100vw-24px))] motion-reduce:animate-none">
              <Popover.Dialog aria-label={t("后台处理模型说明", "About background processing model")} className="text-sm outline-none">
                {t(
                  "用于静默处理实时通知、消息分拣与工作记忆整理，仅在需要判断或执行任务时唤起主智能体。未单独指定时跟随默认模型。",
                  "Silently handles live notifications, message triage, and working-memory extraction, waking the main agent only when judgment or action is needed. Follows the default model unless specified.",
                )}
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
          {showBusySpinner && <Spinner size="sm" aria-label={t("正在同步后台处理模型", "Syncing background processing model")} />}
        </>
      }
    >
      <SettingsList label={t("后台处理模型", "Background processing model")}>
        <Select
          aria-label={t("后台处理供应商", "Background processing provider")}
          placeholder={loading && !view ? t("加载中…", "Loading…") : t("跟随默认模型", "Follow default model")}
          value={selectValue}
          variant="secondary"
          fullWidth
          className="kulo-settings-row"
          isDisabled={!connected || !view || loadingProviders || saving || bgJobRunning || restartingLocal}
          onChange={(key) => {
            if (key !== null) handleProviderChange(String(key));
          }}
        >
          <Label className="text-sm font-normal text-foreground">{t("供应商", "Provider")}</Label>
          <Select.Trigger>
            <Select.Value className="truncate">
              {selectValue === null && effectiveProviderId ? unavailableProviderLabel : undefined}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="motion-reduce:animate-none">
            <ListBox>
              <ListBox.Item id={AUTO_KEY} textValue={t("跟随默认模型", "Follow default model")}>
                {t("跟随默认模型", "Follow default model")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {isLocalManaged && (
                <ListBox.Item id={LOCAL_MANAGED_KEY} textValue={managedHostLabel}>
                  {managedHostLabel}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )}
              {groups.map((item) => (
                <ListBox.Item key={item.providerId} id={item.providerId} textValue={item.label}>
                  {item.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        {isLocalManaged && (
          <div className="kulo-settings-list-row justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-normal text-foreground">{t("模型", "Model")}</span>
              {bg?.modelId && <span className="min-w-0 break-all text-sm text-muted">{bg.modelId}</span>}
              <Chip size="sm" variant="soft" color={managedChip.color}>{managedChip.label}</Chip>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!bgJobRunning && !restartingLocal && !bg?.running && bg?.engine && bg?.modelId && (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!connected || saving}
                  onPress={() => void restartLocalManaged()}
                >
                  {t("重新启动", "Restart")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!connected || saving}
                onPress={() => void resetToAuto()}
              >
                {bgJobRunning || restartingLocal
                  ? t("取消并切回默认", "Cancel & use default")
                  : t("切回默认", "Use default")}
              </Button>
            </div>
          </div>
        )}

        {showModelCombo && (
          <ComboBox
            key={effectiveProviderId}
            aria-label={t("后台处理模型", "Background processing model")}
            selectedKey={matchedModel?.id ?? null}
            variant="secondary"
            fullWidth
            menuTrigger="focus"
            className="kulo-settings-row"
            isDisabled={!connected || saving || !selectedGroup || models.length === 0}
            onSelectionChange={(key) => {
              if (key !== null) handleModelChange(String(key));
            }}
          >
            <Label className="text-sm font-normal text-foreground">{t("模型", "Model")}</Label>
            <ComboBox.InputGroup>
              <Input
                title={activeModelId || undefined}
                placeholder={
                  activeModelId && !matchedModel
                    ? t(`${activeModelId}（未添加）`, `${activeModelId} (not added)`)
                    : selectedGroup && models.length === 0
                      ? t("暂无已添加模型", "No models added")
                      : t("未选择", "Not selected")
                }
              />
              <ComboBox.Trigger aria-label={t("展开后台处理模型列表", "Open background processing model list")} />
            </ComboBox.InputGroup>
            <ComboBox.Popover className="motion-reduce:animate-none">
              <ListBox renderEmptyState={() => <span className="p-3 text-sm text-muted">{t("无匹配模型", "No matching models")}</span>}>
                {models.map((item) => (
                  <ListBox.Item key={item.id} id={item.id} textValue={item.id}>
                    <span className="min-w-0 whitespace-normal break-all">{item.id}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
          </ComboBox>
        )}
      </SettingsList>

      {(actionError || loadError) && (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Description className="break-words">{actionError || loadError}</Alert.Description>
          </Alert.Content>
          {!actionError && !view && (
            <Button className="shrink-0" size="sm" variant="ghost" isDisabled={!connected || loading} onPress={() => void refresh()}>
              {t("重试", "Retry")}
            </Button>
          )}
        </Alert>
      )}

      {bg?.error && !bgJobRunning && !restartingLocal && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Description className="break-words">{redactSensitiveText(bg.error)}</Alert.Description>
          </Alert.Content>
          {bg.mode !== "auto" && (
            <Button className="shrink-0" size="sm" variant="secondary" isDisabled={!connected || saving} onPress={() => void resetToAuto()}>
              {t("切回默认", "Use default")}
            </Button>
          )}
        </Alert>
      )}
    </SettingsSection>
  );
}
