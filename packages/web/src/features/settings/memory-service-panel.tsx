import { translate as t, useI18n } from "../../kulo-i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Checkbox, Chip, Disclosure, Input, Label, Spinner, Switch, TextField } from "@heroui/react";
import { redactSecrets, type HindsightAccessMode, type HindsightProbeResult, type MemoryConnectionUpdateRequest, type MemoryServiceSnapshot, type ProviderCatalogItem, type KuloSettingsView } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { BuiltinMemorySection } from "./builtin-memory-section";
import { safeSetupInputError } from "./capability-setup-inputs";
import { SettingsList, SettingsSaveBar, SettingsSection } from "./settings-layout";
import { MemoryServerList } from "./memory-server-list";
import { MemoryModelFields } from "./memory-model-fields";
import {
  buildMemoryServicePrefillPrompt,
  formatEmbeddingsModelLabel,
  formatRerankerModelLabel,
  formatUnderstandingModelLabel,
  initialMemoryModelsDraft,
  kuloMemoryConnections,
  memoryModelsEqual,
  type MemoryModelsDraft,
} from "./memory-service-models";
import {
  MEMORY_CONNECTION_FOCUS_EVENT,
  MEMORY_SERVICE_CHANGED_EVENT,
  publishMemoryService,
  requestMemoryAssistantPrefill,
  requestMemoryService,
  takePendingMemoryConnectionFocus,
} from "./memory-service-events";
import { useSettingsPending } from "./settings-save-activity";

type MemoryBlock = KuloSettingsView["blocks"]["memory"];
type MemoryConnectionAction = "probe" | "save" | "reload" | "enabled" | "knowledge";
const newPanelId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export interface MemoryConnectionDraft {
  enabled: boolean;
  endpoint: string;
  endpoints: string[];
  accessMode: HindsightAccessMode;
  privateBank: string;
  sharedBank: string;
  routerApiKey: string;
  workerApiKey: string;
  clearRouterApiKey: boolean;
  clearWorkerApiKey: boolean;
}
export interface MemoryConnectionEditor {
  revision: number;
  base: MemoryConnectionDraft;
  draft: MemoryConnectionDraft;
  conflict: boolean;
}

export function memoryConnectionEditor(block: MemoryBlock): MemoryConnectionEditor {
  const value = block.value;
  const draft: MemoryConnectionDraft = {
    enabled: value.enabled, endpoint: value.endpoint, endpoints: [...value.endpoints], accessMode: value.accessMode ?? "kulo",
    privateBank: value.banks.private, sharedBank: value.banks.shared,
    routerApiKey: "", workerApiKey: "", clearRouterApiKey: false, clearWorkerApiKey: false,
  };
  return { revision: block.revision, base: draft, draft, conflict: false };
}
export function memoryConnectionDirty(editor: MemoryConnectionEditor): boolean {
  return JSON.stringify({ ...editor.draft, enabled: editor.base.enabled }) !== JSON.stringify(editor.base);
}
export function reconcileMemoryConnection(editor: MemoryConnectionEditor, block: MemoryBlock): MemoryConnectionEditor {
  if (block.revision <= editor.revision) return editor;
  return memoryConnectionDirty(editor) ? { ...editor, conflict: true } : memoryConnectionEditor(block);
}
export function acknowledgeMemoryEnabled(editor: MemoryConnectionEditor, block: MemoryBlock, expectedRevision: number): MemoryConnectionEditor {
  // Only our acknowledged flag mutation can advance a dirty draft's revision.
  // An unrelated revision may include secret changes that public fields cannot reveal.
  if (editor.conflict || editor.revision !== expectedRevision || block.revision !== expectedRevision + 1) return reconcileMemoryConnection(editor, block);
  const saved = memoryConnectionEditor(block);
  if (JSON.stringify({ ...saved.base, enabled: editor.base.enabled }) !== JSON.stringify(editor.base)) return reconcileMemoryConnection(editor, block);
  return { ...editor, revision: block.revision, base: { ...editor.base, enabled: block.value.enabled }, draft: { ...editor.draft, enabled: block.value.enabled } };
}
export function setSavedMemoryEnabled(block: MemoryBlock, enabled: boolean): Promise<MemoryServiceSnapshot> {
  // This endpoint reads the saved connection on the server; connection drafts and keys never cross this boundary.
  return kuloRest.setMemoryEnabled({ enabled, expectedRevision: block.revision });
}
export function setSavedMemoryKnowledgeGuidance(block: MemoryBlock, enabled: boolean): Promise<MemoryServiceSnapshot> {
  return kuloRest.setMemoryKnowledgeGuidance({ enabled, expectedRevision: block.revision });
}
export function createMemoryConnectionRequest(draft: MemoryConnectionDraft, expectedRevision: number): MemoryConnectionUpdateRequest {
  return {
    expectedRevision, enabled: draft.enabled,
    connection: { endpoint: draft.endpoint.trim(), endpoints: draft.endpoints.map((value) => value.trim()).filter(Boolean), accessMode: draft.accessMode,
      banks: { private: draft.privateBank.trim(), shared: draft.sharedBank.trim() } },
    ...(draft.routerApiKey.trim() ? { routerApiKey: draft.routerApiKey.trim() } : {}),
    ...(draft.workerApiKey.trim() && draft.accessMode !== "private-only" ? { workerApiKey: draft.workerApiKey.trim() } : {}),
    ...(draft.clearRouterApiKey ? { clearRouterApiKey: true } : {}),
    ...(draft.clearWorkerApiKey ? { clearWorkerApiKey: true } : {}),
  };
}

function sameOrigins(draft: MemoryConnectionDraft, saved: MemoryBlock["value"]): boolean {
  const origins = (values: string[]) => [...new Set(values.map((value) => new URL(value.trim()).origin))].sort().join("\n");
  try { return origins([draft.endpoint, ...draft.endpoints.filter((value) => value.trim())]) === origins([saved.endpoint, ...saved.endpoints]); }
  catch { return false; }
}
function ConnectionSecret({ label, value, saved, clear, disabled, onChange, onClear }: {
  label: string; value: string; saved: boolean; clear: boolean; disabled: boolean; onChange: (value: string) => void; onClear: () => void;
}) {
  useI18n();
  return <div className="kulo-field-action-row">
    <TextField variant="secondary" type="password" value={value} onChange={onChange} isDisabled={disabled || clear} maxLength={8192} fullWidth className="kulo-form-field flex-1">
      <Label className="text-sm font-medium">{label}</Label>
      <Input className="kulo-field-action-input" autoComplete="new-password" spellCheck={false} placeholder={clear ? t("保存后清除", "Cleared when saved") : saved ? t("已保存，留空保留", "Saved; leave blank to keep") : t("输入密钥", "Enter API key")} />
    </TextField>
    {(saved || clear) && <Button type="button" size="sm" variant="tertiary" className="kulo-field-action-button" isDisabled={disabled} onPress={onClear}>{clear ? t("撤销清除", "Undo clear") : t("清除", "Clear")}</Button>}
  </div>;
}

export function MemoryConnectionForm({
  settings,
  savedMemory = settings.blocks.memory,
  snapshot,
  providers,
  editor,
  modelsDraft,
  modelsError,
  modelsBusy = false,
  activeStage,
  pending,
  loading = false,
  connected = true,
  error,
  enabledError,
  probe,
  headingLevel = 2,
  onChange,
  onModelsChange,
  onLocalDeploy,
  onLocalConfigure,
  onLocalUninstall,
  onEnabledChange,
  onEnabledRetry,
  onKnowledgeGuidanceChange,
  onSave,
  onProbe,
  onDiscard,
  onReload,
  onRetry,
}: {
  settings: KuloSettingsView;
  snapshot: MemoryServiceSnapshot | null;
  providers?: ProviderCatalogItem[];
  editor: MemoryConnectionEditor;
  modelsDraft?: MemoryModelsDraft;
  modelsError?: string;
  modelsBusy?: boolean;
  activeStage?: string;
  savedMemory?: MemoryBlock;
  pending?: MemoryConnectionAction;
  loading?: boolean;
  connected?: boolean;
  error?: string;
  enabledError?: string;
  probe?: HindsightProbeResult;
  headingLevel?: 2 | 3;
  onChange: (draft: MemoryConnectionDraft) => void;
  onModelsChange?: (draft: MemoryModelsDraft) => void;
  onLocalDeploy?: () => void;
  onLocalConfigure?: () => void;
  onLocalUninstall?: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onEnabledChange: (enabled: boolean) => void;
  onEnabledRetry?: () => void;
  onKnowledgeGuidanceChange?: (enabled: boolean) => void;
  onProbe: () => void;
  onDiscard: () => void;
  onReload: () => void;
  onRetry?: () => void;
}) {
  useI18n();
  const { draft } = editor;
  const enabledControlRef = useRef<HTMLDivElement>(null);
  const knowledgeControlRef = useRef<HTMLElement>(null);
  const restoreEnabledFocus = useRef(false);
  const restoreKnowledgeFocus = useRef(false);
  const busy = Boolean(pending);
  const dirty = memoryConnectionDirty(editor);
  const running = snapshot?.jobs.some((job) => job.status === "running") ?? false;
  const disabled = !connected || running;
  const reusable = sameOrigins(draft, savedMemory.value);
  const activeConnection = snapshot && snapshot.revision >= savedMemory.revision ? snapshot.connection : savedMemory.value;
  const enabled = activeConnection.enabled;
  const knowledgeGuidanceEnabled = Boolean(activeConnection.knowledgeGuidanceEnabled);
  const kuloConnections = useMemo(() => kuloMemoryConnections(settings, providers), [settings, providers]);
  const effectiveModelsDraft = useMemo(
    () => modelsDraft ?? initialMemoryModelsDraft(snapshot ?? undefined, settings, providers),
    [modelsDraft, snapshot, settings, providers],
  );
  const localPhase = snapshot?.phase;
  const isFailedInstall = localPhase === "failed";
  const isInProgressInstall = localPhase === "installing" || localPhase === "verifying";
  const hasManagedInstall = Boolean(snapshot?.installed) || isFailedInstall || isInProgressInstall;
  const isReadyInstall = Boolean(snapshot?.installed) && !isFailedInstall && !isInProgressInstall;
  const showLocalService = snapshot?.platform !== "win32" || hasManagedInstall;
  const localStatusLabel = isFailedInstall
    ? t("部署失败", "Deployment failed")
    : localPhase === "installing"
      ? t("部署中", "Deploying")
      : localPhase === "verifying"
        ? t("验证中", "Verifying")
        : snapshot?.running
          ? t("运行中", "Running")
          : t("已停止", "Stopped");
  useEffect(() => {
    if (!pending && restoreEnabledFocus.current) {
      restoreEnabledFocus.current = false;
      if (document.activeElement === document.body) enabledControlRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
    }
    if (!pending && restoreKnowledgeFocus.current) {
      restoreKnowledgeFocus.current = false;
      if (document.activeElement === document.body) knowledgeControlRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
    }
  }, [pending]);
  const change = <K extends keyof MemoryConnectionDraft>(key: K, value: MemoryConnectionDraft[K]) => onChange({ ...draft, [key]: value });
  return <div className="kulo-settings-form gap-7" aria-busy={busy || undefined}>
    <div inert={busy || undefined}>
      <SettingsSection headingLevel={headingLevel} title={t("长期记忆", "Long-term memory")} status={<Chip size="sm" variant="soft" color={enabled ? "success" : "default"}>{enabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}</Chip>} action={
        <div ref={enabledControlRef} className="flex items-center gap-2">{pending === "enabled" && <Spinner size="sm" aria-label={t("保存启用状态", "Saving enabled state")} />}<Switch aria-label={t("启用长期记忆", "Enable long-term memory")} isSelected={enabled} isDisabled={disabled} onChange={(next) => { restoreEnabledFocus.current = enabledControlRef.current?.contains(document.activeElement) ?? false; onEnabledChange(next); }}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch></div>
      }>
        <SettingsList label={t("长期记忆选项", "Long-term memory options")}>
          <Switch
            ref={knowledgeControlRef as never}
            className="w-full"
            aria-label={t("启用知识整理指引", "Enable knowledge organization guide")}
            isSelected={enabled && knowledgeGuidanceEnabled}
            isDisabled={disabled || !enabled || !onKnowledgeGuidanceChange}
            onChange={(next) => {
              restoreKnowledgeFocus.current = knowledgeControlRef.current?.contains(document.activeElement) ?? false;
              onKnowledgeGuidanceChange?.(next);
            }}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 items-center gap-2">
                <Label className="text-sm font-normal text-foreground">{t("知识整理指引", "Knowledge organization guide")}</Label>
                {pending === "knowledge" && <Spinner size="sm" aria-label={t("保存知识整理指引", "Saving knowledge guide state")} />}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </SettingsList>
      </SettingsSection>
    </div>
    {enabledError && <Alert status="danger" role="alert" className="rounded-2xl p-3"><Alert.Content className="flex-1 break-words text-sm">{enabledError}</Alert.Content>{onEnabledRetry && <Button type="button" size="sm" variant="secondary" isDisabled={busy || !connected} onPress={onEnabledRetry}>{t("重试", "Retry")}</Button>}</Alert>}
    <form className="kulo-settings-form gap-4" aria-label={t("长期记忆连接设置", "Long-term memory connection settings")} onSubmit={onSave}>
    <div inert={busy || undefined}>
    <SettingsSection headingLevel={headingLevel} title={t("连接配置", "Connection settings")}>
      <div className="kulo-form-stack">
        <MemoryServerList addresses={[draft.endpoint, ...draft.endpoints]} disabled={disabled}
          onChange={([endpoint, ...endpoints]) => onChange({ ...draft, endpoint, endpoints })} />
        <div className="kulo-form-grid">
          <ConnectionSecret label={t("密钥", "API key")} value={draft.routerApiKey} saved={reusable && savedMemory.hasRouterApiKey} clear={draft.clearRouterApiKey} disabled={disabled} onChange={(value) => change("routerApiKey", value)} onClear={() => onChange({ ...draft, routerApiKey: "", clearRouterApiKey: !draft.clearRouterApiKey })} />
          <ConnectionSecret label={t("公开目录密钥", "Public directory API key")} value={draft.workerApiKey} saved={reusable && savedMemory.hasWorkerApiKey} clear={draft.clearWorkerApiKey} disabled={disabled} onChange={(value) => change("workerApiKey", value)} onClear={() => onChange({ ...draft, workerApiKey: "", clearWorkerApiKey: !draft.clearWorkerApiKey })} />
        </div>
        <div className="kulo-form-grid">
          <TextField variant="secondary" className="kulo-form-field" value={draft.privateBank} onChange={(value) => change("privateBank", value)} isRequired isDisabled={disabled} fullWidth><Label className="text-sm font-medium">{t("隐私记忆库名", "Private memory bank")}</Label><Input spellCheck={false} /></TextField>
          <TextField variant="secondary" className="kulo-form-field" value={draft.sharedBank} onChange={(value) => change("sharedBank", value)} isRequired isDisabled={disabled} fullWidth><Label className="text-sm font-medium">{t("共享记忆库名", "Shared memory bank")}</Label><Input spellCheck={false} /></TextField>
        </div>
      </div>
    </SettingsSection>
    </div>
    {editor.conflict && <Alert status="warning" role="alert" className="rounded-2xl p-3"><Alert.Content className="flex-1 text-sm">{t("连接配置已更新，当前草稿尚未保存。", "Connection settings changed. Your draft has not been saved.")}</Alert.Content><Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={onReload}>{t("加载最新配置", "Load latest settings")}</Button></Alert>}
    <div className="flex min-w-0 flex-col gap-3">
      <div className="kulo-settings-actions"><Button type="button" size="sm" variant="ghost" className="relative" aria-label={t("测试连接", "Test connection")} isDisabled={disabled || editor.conflict || busy && pending !== "probe"} isPending={pending === "probe"} onPress={onProbe}><span className={pending === "probe" ? "invisible" : undefined}>{t("测试连接", "Test connection")}</span>{pending === "probe" && <Spinner size="sm" color="current" className="absolute" aria-label={t("正在测试连接", "Testing connection")} />}</Button>{loading && <Spinner size="sm" aria-label={t("读取记忆服务", "Loading memory service")} />}</div>
      {error && <Alert status="danger" role="alert" className="rounded-2xl p-3"><Alert.Content className="flex-1 break-words text-sm">{error}</Alert.Content>{onRetry && <Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={onRetry}>{t("重试", "Retry")}</Button>}</Alert>}
      {!error && probe && <Alert status="success" role="status" className="rounded-2xl p-3"><Alert.Content className="text-sm">{probe.isolationVerified ? t("连接与权限隔离检查通过", "Connection and access isolation verified") : t("主脑私库连接正常", "Private memory bank connected")}</Alert.Content></Alert>}
    </div>
    <SettingsSaveBar dirty={dirty} busy={busy} saving={pending === "save"} disabled={disabled || editor.conflict} onDiscard={onDiscard} stateLabel={t("连接配置未保存", "Connection settings unsaved")} saveLabel={savedMemory.value.enabled ? t("验证并保存", "Verify and save") : t("保存连接配置", "Save connection settings")} />
    </form>
    {showLocalService && <div inert={busy || undefined}>
    <SettingsSection headingLevel={headingLevel} title={t("本机服务", "Local service")}>
      {hasManagedInstall && snapshot && <dl className="mb-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
        <dt className="text-muted">{t("部署设备", "Deployment device")}</dt><dd className="break-words">{snapshot.deviceName}</dd>
        <dt className="text-muted">{t("服务状态", "Service status")}</dt><dd className={isFailedInstall ? "text-danger" : undefined}>{localStatusLabel}{isReadyInstall && snapshot.version ? ` · ${snapshot.version}` : ""}</dd>
        {isReadyInstall && snapshot.model && <><dt className="text-muted">{t("理解模型", "Understanding model")}</dt><dd className="break-all">{formatUnderstandingModelLabel(snapshot.model, kuloConnections)}</dd></>}
        {isReadyInstall && snapshot.embeddings && <><dt className="text-muted">{t("向量模型", "Embedding model")}</dt><dd className="break-all">{formatEmbeddingsModelLabel(snapshot.embeddings)}</dd></>}
        {isReadyInstall && snapshot.reranker && <><dt className="text-muted">{t("重排模型", "Rerank model")}</dt><dd className="break-all">{formatRerankerModelLabel(snapshot.reranker)}</dd></>}
      </dl>}
      <MemoryModelFields
        draft={effectiveModelsDraft}
        connections={kuloConnections}
        disabled={disabled || modelsBusy}
        layout="settings"
        onChange={(next) => onModelsChange?.(next)}
      />
      {modelsError && <Alert status="danger" role="alert" className="mt-4 rounded-2xl p-3"><Alert.Content className="flex-1 break-words text-sm">{modelsError}</Alert.Content></Alert>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(!hasManagedInstall || isFailedInstall) && <Button type="button" variant="secondary" isDisabled={disabled || modelsBusy} onPress={() => onLocalDeploy ? onLocalDeploy() : requestMemoryService("deploy")}>{isFailedInstall ? t("重新部署", "Retry deployment") : t("在本机配置 Hindsight", "Set up Hindsight locally")}</Button>}
        {isReadyInstall && <Button type="button" variant="secondary" isDisabled={disabled || modelsBusy} onPress={() => onLocalConfigure ? onLocalConfigure() : requestMemoryService("configure")}>{t("配置本机模型", "Configure local model")}</Button>}
        {hasManagedInstall && <Button type="button" variant="danger" isPending={modelsBusy} isDisabled={disabled || modelsBusy} onPress={() => onLocalUninstall ? onLocalUninstall() : requestMemoryService("uninstall")}>{isReadyInstall ? t("卸载本机服务", "Uninstall local service") : t("清理未完成安装", "Clean up incomplete install")}</Button>}
        {activeStage && <div className="flex items-center gap-2 text-xs text-muted" role="status"><Spinner size="sm" aria-label={t("记忆服务处理中", "Memory service is processing")} /><span>{activeStage}</span></div>}
      </div>
    </SettingsSection>
    </div>}
  </div>;
}

export function MemoryServicePanel({ settings, connected = true, onSettingsUpdated, onDirtyChange, onBusyChange }: {
  settings: KuloSettingsView; connected?: boolean; onSettingsUpdated: (settings: KuloSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
}) {
  useI18n();
  const panelClientId = useRef(newPanelId("memory-panel")).current;
  const [snapshot, setSnapshot] = useState<MemoryServiceSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderCatalogItem[]>();
  const [savedMemory, setSavedMemory] = useState(settings.blocks.memory);
  const savedMemoryRef = useRef(savedMemory);
  const [editor, setEditor] = useState(() => memoryConnectionEditor(settings.blocks.memory));
  const [modelsBase, setModelsBase] = useState<MemoryModelsDraft>(() => initialMemoryModelsDraft(undefined, settings));
  const [modelsDraft, setModelsDraft] = useState<MemoryModelsDraft>(() => initialMemoryModelsDraft(undefined, settings));
  const modelsDirtyRef = useRef(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallDeleteData, setUninstallDeleteData] = useState(false);
  const [activeUninstallJobId, setActiveUninstallJobId] = useState<string | null>(null);
  const activeUninstallJobIdRef = useRef<string | null>(null);
  activeUninstallJobIdRef.current = activeUninstallJobId;
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<MemoryConnectionAction>();
  const [builtinBusy, setBuiltinBusy] = useState(false);
  const [hindsightExpanded, setHindsightExpanded] = useState(() => Boolean(settings.blocks.memory.value.enabled));
  const pendingRef = useRef(false);
  const busy = Boolean(pending) || modelsBusy || builtinBusy;
  useSettingsPending(pending === "save" || pending === "enabled" || pending === "knowledge" || modelsBusy);
  const [error, setError] = useState<string>();
  const [enabledError, setEnabledError] = useState<string>();
  const [enabledRetry, setEnabledRetry] = useState<{ kind: "enabled" | "knowledge"; enabled: boolean; revision: number } | "sync">();
  const [loadError, setLoadError] = useState<string>();
  const [probe, setProbe] = useState<HindsightProbeResult>();
  const [refresh, setRefresh] = useState(0);
  const formRef = useRef<HTMLDivElement>(null);
  const lastSucceededJobRef = useRef<string | undefined>(undefined);
  const lastSyncedRevisionRef = useRef(settings.blocks.memory.revision);
  const dirty = memoryConnectionDirty(editor);
  const modelsDirty = !memoryModelsEqual(modelsDraft, modelsBase);
  modelsDirtyRef.current = modelsDirty;

  const rememberMemory = useCallback((block: MemoryBlock) => {
    if (block.revision < savedMemoryRef.current.revision) return;
    savedMemoryRef.current = block;
    setSavedMemory(block);
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const onSettingsUpdatedRef = useRef(onSettingsUpdated);
  onSettingsUpdatedRef.current = onSettingsUpdated;

  const syncModelsFrom = useCallback((nextSnapshot: MemoryServiceSnapshot | null, nextProviders?: ProviderCatalogItem[]) => {
    const computed = initialMemoryModelsDraft(nextSnapshot ?? undefined, settingsRef.current, nextProviders ?? providersRef.current);
    setModelsBase(computed);
    if (!modelsDirtyRef.current) setModelsDraft(computed);
  }, []);

  useEffect(() => { rememberMemory(settings.blocks.memory); setEditor((current) => reconcileMemoryConnection(current, settings.blocks.memory)); setProbe(undefined); }, [settings.blocks.memory.revision, rememberMemory]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);

  const applyPanelSnapshot = useCallback((next: MemoryServiceSnapshot, nextProviders?: ProviderCatalogItem[]) => {
    setSnapshot((current) => current && current.revision > next.revision ? current : next);
    setLoadError(undefined);
    syncModelsFrom(next, nextProviders);
    const uninstallId = activeUninstallJobIdRef.current;
    if (uninstallId) {
      const uninstallJob = next.jobs.find((job) => job.id === uninstallId);
      if (!uninstallJob || uninstallJob.status === "succeeded" || uninstallJob.status === "rejected") {
        activeUninstallJobIdRef.current = null;
        setActiveUninstallJobId(null);
      } else if (uninstallJob.status === "failed") {
        activeUninstallJobIdRef.current = null;
        setActiveUninstallJobId(null);
        setModelsError(redactSecrets(uninstallJob.error ?? t("卸载未完成，请重试。", "Uninstall did not finish. Try again.")));
      }
    }
    const succeeded = next.jobs.findLast((job) => job.status === "succeeded");
    const hasNewSucceeded = Boolean(succeeded && succeeded.id !== lastSucceededJobRef.current);
    const hasNewRevision = next.revision > Math.max(savedMemoryRef.current.revision, lastSyncedRevisionRef.current);
    if (hasNewSucceeded || hasNewRevision) {
      if (succeeded) lastSucceededJobRef.current = succeeded.id;
      lastSyncedRevisionRef.current = Math.max(lastSyncedRevisionRef.current, next.revision);
      void kuloRest.getSettings().then((latest) => {
        rememberMemory(latest.blocks.memory);
        setEditor((current) => reconcileMemoryConnection(current, latest.blocks.memory));
        onSettingsUpdatedRef.current(latest);
      }).catch(() => {});
    }
  }, [rememberMemory, syncModelsFrom]);

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    setLoading(true);
    void Promise.all([
      kuloRest.getMemoryService(panelClientId),
      kuloRest.listProviders().then((res) => res.providers).catch(() => undefined),
    ]).then(([next, catalog]) => {
      if (!alive) return;
      if (catalog) {
        providersRef.current = catalog;
        setProviders(catalog);
      }
      applyPanelSnapshot(next, catalog);
    }, (cause) => {
      if (alive) setLoadError(redactSecrets(cause instanceof Error ? cause.message : t("读取服务失败", "Failed to load service")));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [connected, settings.blocks.memory.revision, settings.blocks.model.revision, refresh, panelClientId, applyPanelSnapshot]);

  const activeUninstallJob = activeUninstallJobId
    ? snapshot?.jobs.find((job) => job.id === activeUninstallJobId && job.status === "running")
    : undefined;
  const hasPanelPendingWork = Boolean(activeUninstallJob) || (snapshot?.jobs.some((job) => job.clientId === panelClientId && job.status === "running") ?? false);
  useEffect(() => {
    if (!connected || !hasPanelPendingWork) return;
    let alive = true;
    const timer = setInterval(() => {
      void kuloRest.getMemoryService(panelClientId).then((next) => {
        if (alive) applyPanelSnapshot(next);
      }).catch(() => {});
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [connected, hasPanelPendingWork, panelClientId, applyPanelSnapshot]);

  useEffect(() => {
    if (savedMemory.value.enabled || snapshot?.installed || snapshot?.phase === "failed" || snapshot?.phase === "installing" || snapshot?.phase === "verifying") {
      setHindsightExpanded(true);
    }
  }, [savedMemory.value.enabled, snapshot?.installed, snapshot?.phase]);

  useEffect(() => {
    const changed = (event: Event) => {
      const next = (event as CustomEvent<MemoryServiceSnapshot>).detail;
      applyPanelSnapshot(next);
    };
    const focus = () => {
      takePendingMemoryConnectionFocus();
      setHindsightExpanded(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const urlInput = formRef.current?.querySelector<HTMLInputElement>('input[type="url"]');
          (urlInput ?? formRef.current)?.scrollIntoView({ block: "center" });
          urlInput?.focus();
        });
      });
    };
    if (takePendingMemoryConnectionFocus()) focus();
    window.addEventListener(MEMORY_SERVICE_CHANGED_EVENT, changed);
    window.addEventListener(MEMORY_CONNECTION_FOCUS_EVENT, focus);
    return () => { window.removeEventListener(MEMORY_SERVICE_CHANGED_EVENT, changed); window.removeEventListener(MEMORY_CONNECTION_FOCUS_EVENT, focus); };
  }, [applyPanelSnapshot]);

  const reset = (next?: KuloSettingsView) => { if (next) { rememberMemory(next.blocks.memory); setEnabledError(undefined); setEnabledRetry(undefined); } setEditor(memoryConnectionEditor(next?.blocks.memory ?? savedMemoryRef.current)); setError(undefined); setProbe(undefined); };
  const syncEnabled = async () => {
    const latest = await kuloRest.getSettings();
    rememberMemory(latest.blocks.memory);
    setEditor((current) => reconcileMemoryConnection(current, latest.blocks.memory));
    onSettingsUpdated(latest);
    setEnabledError(undefined);
    setEnabledRetry(undefined);
    setRefresh((value) => value + 1);
  };
  const toggleEnabled = async (enabled: boolean) => {
    if (pendingRef.current || !connected || snapshot?.jobs.some((job) => job.status === "running")) return;
    pendingRef.current = true;
    setPending("enabled");
    const saved = savedMemoryRef.current;
    let committed = false;
    try {
      const service = await setSavedMemoryEnabled(saved, enabled);
      committed = true;
      const next = { ...saved, revision: service.revision, value: service.connection };
      rememberMemory(next);
      setEditor((current) => acknowledgeMemoryEnabled(current, next, saved.revision));
      setSnapshot(service);
      setLoadError(undefined);
      publishMemoryService(service);
      await syncEnabled();
    } catch (cause) {
      const message = redactSecrets(cause instanceof Error ? cause.message : t("更新启用状态失败", "Failed to update enabled state"));
      setEnabledError(committed ? t(`启用状态已更新，读取最新配置失败：${message}`, `Enabled state updated; failed to load settings: ${message}`) : message);
      setEnabledRetry(committed || cause instanceof KuloApiError && cause.code === "memory_revision_conflict" ? "sync" : { kind: "enabled", enabled, revision: saved.revision });
    } finally { pendingRef.current = false; setPending(undefined); }
  };
  const toggleKnowledgeGuidance = async (enabled: boolean) => {
    if (pendingRef.current || !connected || snapshot?.jobs.some((job) => job.status === "running")) return;
    pendingRef.current = true;
    setPending("knowledge");
    const saved = savedMemoryRef.current;
    let committed = false;
    try {
      const service = await setSavedMemoryKnowledgeGuidance(saved, enabled);
      committed = true;
      const next = { ...saved, revision: service.revision, value: service.connection };
      rememberMemory(next);
      setEditor((current) => acknowledgeMemoryEnabled(current, next, saved.revision));
      setSnapshot(service);
      setLoadError(undefined);
      publishMemoryService(service);
      await syncEnabled();
    } catch (cause) {
      const message = redactSecrets(cause instanceof Error ? cause.message : t("更新知识整理指引失败", "Failed to update knowledge guide setting"));
      setEnabledError(committed ? t(`设置已更新，读取最新配置失败：${message}`, `Setting updated; failed to load settings: ${message}`) : message);
      setEnabledRetry(committed || cause instanceof KuloApiError && cause.code === "memory_revision_conflict" ? "sync" : { kind: "knowledge", enabled, revision: saved.revision });
    } finally { pendingRef.current = false; setPending(undefined); }
  };
  const retryEnabled = async () => {
    if (!enabledRetry) return;
    if (enabledRetry !== "sync" && enabledRetry.revision === savedMemoryRef.current.revision) {
      if (enabledRetry.kind === "knowledge") await toggleKnowledgeGuidance(enabledRetry.enabled);
      else await toggleEnabled(enabledRetry.enabled);
      return;
    }
    if (pendingRef.current || !connected) return;
    pendingRef.current = true;
    setPending("enabled");
    try { await syncEnabled(); }
    catch (cause) { setEnabledError(redactSecrets(cause instanceof Error ? cause.message : t("读取配置失败", "Failed to load settings"))); }
    finally { pendingRef.current = false; setPending(undefined); }
  };
  const reload = async () => {
    if (pendingRef.current || !connected) return;
    pendingRef.current = true;
    setPending("reload");
    try { const latest = await kuloRest.getSettings(); reset(latest); onSettingsUpdated(latest); setRefresh((value) => value + 1); }
    catch (cause) { setError(redactSecrets(cause instanceof Error ? cause.message : t("读取配置失败", "Failed to load settings"))); }
    finally { pendingRef.current = false; setPending(undefined); }
  };
  const submit = async (probeOnly: boolean) => {
    if (pendingRef.current || !connected || editor.conflict) return;
    pendingRef.current = true;
    setPending(probeOnly ? "probe" : "save");
    const draft = { ...editor.draft, enabled: savedMemoryRef.current.value.enabled };
    try {
      const request = createMemoryConnectionRequest(draft, editor.revision);
      const result = probeOnly ? await kuloRest.probeMemoryConnection(request) : await kuloRest.saveMemoryConnection(request);
      setSnapshot(result.service);
      setLoadError(undefined);
      setError(undefined);
      if (!probeOnly) { reset(result.settings); onSettingsUpdated(result.settings); publishMemoryService(result.service); }
      setProbe(result.probe);
    } catch (cause) {
      let message = safeSetupInputError(cause, draft.routerApiKey);
      if (draft.workerApiKey) message = message.split(draft.workerApiKey).join(t("[已隐藏]", "[redacted]"));
      setError(message);
      setProbe(undefined);
    } finally { pendingRef.current = false; setPending(undefined); }
  };
  const prefillLocalOperation = (operation: "deploy" | "configure") => {
    if (modelsBusy || !connected) return;
    setModelsError(undefined);
    try {
      const prompt = buildMemoryServicePrefillPrompt({
        operation,
        retry: operation === "deploy" && snapshot?.phase === "failed",
        deviceName: snapshot?.deviceName,
        draft: modelsDraft,
        connections: kuloMemoryConnections(settings, providers),
      });
      requestMemoryAssistantPrefill(prompt);
    } catch (cause) {
      setModelsError(redactSecrets(cause instanceof Error ? cause.message : t("请检查本机模型配置。", "Check the local model settings.")));
    }
  };
  const uninstallLocalService = async (deleteData: boolean) => {
    if (modelsBusy || !connected) return;
    setModelsBusy(true);
    setModelsError(undefined);
    try {
      const current = snapshot ?? await kuloRest.getMemoryService(panelClientId);
      const commandId = newPanelId("memory");
      const next = await kuloRest.prepareMemoryService({
        commandId,
        clientId: panelClientId,
        expectedRevision: current.revision,
        operation: "uninstall",
        deleteData,
      });
      setUninstallOpen(false);
      setUninstallDeleteData(false);
      const created = next.jobs.find((job) => job.id === commandId);
      if (created && created.status === "awaiting-confirmation") {
        activeUninstallJobIdRef.current = created.id;
        setActiveUninstallJobId(created.id);
        const decided = await kuloRest.decideMemoryService(created.id, { clientId: panelClientId, decision: "confirm" });
        applyPanelSnapshot(decided);
        publishMemoryService(decided);
        return;
      }
      applyPanelSnapshot(next);
      publishMemoryService(next);
    } catch (cause) {
      setModelsError(redactSecrets(cause instanceof Error ? cause.message : t("准备操作失败", "Failed to prepare operation")));
    } finally {
      setModelsBusy(false);
    }
  };

  const isIncompleteInstall = snapshot?.phase === "failed" || snapshot?.phase === "installing" || snapshot?.phase === "verifying";

  return <div ref={formRef} className="kulo-settings-form gap-7">
    <BuiltinMemorySection
      connected={connected}
      hindsightEnabled={savedMemory.value.enabled}
      onBusyChange={setBuiltinBusy}
    />
    <Disclosure isExpanded={hindsightExpanded} onExpandedChange={setHindsightExpanded} className="min-w-0">
      <Disclosure.Heading level={2}>
        <Disclosure.Trigger className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-xl py-2 text-left">
          <span className="kulo-section-title">{t("Hindsight 记忆服务（高级）", "Hindsight memory service (Advanced)")}</span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="pt-4">
          <MemoryConnectionForm
            headingLevel={3}
            settings={settings}
            savedMemory={savedMemory}
            snapshot={snapshot}
            providers={providers}
            editor={editor}
            modelsDraft={modelsDraft}
            modelsError={modelsError}
            modelsBusy={modelsBusy}
            activeStage={activeUninstallJob?.stage}
            pending={pending}
            loading={loading}
            connected={connected}
            error={error ?? loadError}
            enabledError={enabledError}
            probe={probe}
            onEnabledChange={(enabled) => void toggleEnabled(enabled)}
            onEnabledRetry={enabledRetry ? () => void retryEnabled() : undefined}
            onKnowledgeGuidanceChange={(enabled) => void toggleKnowledgeGuidance(enabled)}
            onChange={(draft) => { setEditor((current) => ({ ...current, draft })); setError(undefined); setProbe(undefined); }}
            onModelsChange={(next) => { setModelsDraft(next); setModelsError(undefined); }}
            onLocalDeploy={() => prefillLocalOperation("deploy")}
            onLocalConfigure={() => prefillLocalOperation("configure")}
            onLocalUninstall={() => { setUninstallDeleteData(false); setUninstallOpen(true); }}
            onSave={(event) => { event.preventDefault(); void submit(false); }}
            onProbe={() => void submit(true)}
            onDiscard={() => reset()}
            onReload={() => void reload()}
            onRetry={!error && loadError ? () => setRefresh((value) => value + 1) : undefined}
          />
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
    <ConfirmDialog
      open={uninstallOpen}
      title={isIncompleteInstall ? t("清理未完成的本机 Hindsight 安装？", "Clean up incomplete local Hindsight install?") : t("卸载本机 Hindsight？", "Uninstall local Hindsight?")}
      description={
        <div className="space-y-3">
          {snapshot?.deviceName && <p>{snapshot.deviceName}</p>}
          <Checkbox isSelected={uninstallDeleteData} onChange={setUninstallDeleteData} isDisabled={modelsBusy}>
            <Checkbox.Content>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              {t("同时删除记忆数据", "Also delete memory data")}
            </Checkbox.Content>
          </Checkbox>
        </div>
      }
      confirmLabel={isIncompleteInstall
        ? (uninstallDeleteData ? t("清理并删除数据", "Clean up and delete data") : t("清理并保留数据", "Clean up and keep data"))
        : (uninstallDeleteData ? t("卸载并删除数据", "Uninstall and delete data") : t("卸载并保留数据", "Uninstall and keep data"))}
      isPending={modelsBusy}
      onCancel={() => { if (!modelsBusy) setUninstallOpen(false); }}
      onConfirm={() => void uninstallLocalService(uninstallDeleteData)}
    />
  </div>;
}
