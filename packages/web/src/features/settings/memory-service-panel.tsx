import { translate as t, useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Chip, Input, Label, Spinner, Switch, TextField } from "@heroui/react";
import { redactSecrets, type HindsightAccessMode, type HindsightProbeResult, type MemoryConnectionUpdateRequest, type MemoryServiceSnapshot, type MocoSettingsView } from "@moco/protocol";
import { MocoApiError, mocoRest } from "../../moco-api";
import { safeSetupInputError } from "./capability-setup-inputs";
import { SettingsSaveBar, SettingsSection } from "./settings-layout";
import { MemoryServerList } from "./memory-server-list";
import { MEMORY_CONNECTION_FOCUS_EVENT, MEMORY_SERVICE_CHANGED_EVENT, publishMemoryService, requestMemoryService } from "./memory-service-events";
import { useSettingsPending } from "./settings-save-activity";

type MemoryBlock = MocoSettingsView["blocks"]["memory"];
type MemoryConnectionAction = "probe" | "save" | "reload" | "enabled";
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
    enabled: value.enabled, endpoint: value.endpoint, endpoints: [...value.endpoints], accessMode: value.accessMode ?? "moco",
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
  return mocoRest.setMemoryEnabled({ enabled, expectedRevision: block.revision });
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
  return <div className="moco-field-action-row">
    <TextField variant="secondary" type="password" value={value} onChange={onChange} isDisabled={disabled || clear} maxLength={8192} fullWidth className="moco-form-field flex-1">
      <Label className="text-sm font-medium">{label}</Label>
      <Input className="moco-field-action-input" autoComplete="new-password" spellCheck={false} placeholder={clear ? t("保存后清除", "Cleared when saved") : saved ? t("已保存，留空保留", "Saved; leave blank to keep") : t("输入密钥", "Enter API key")} />
    </TextField>
    {(saved || clear) && <Button type="button" size="sm" variant="tertiary" className="moco-field-action-button" isDisabled={disabled} onPress={onClear}>{clear ? t("撤销清除", "Undo clear") : t("清除", "Clear")}</Button>}
  </div>;
}

export function MemoryConnectionForm({ settings, savedMemory = settings.blocks.memory, snapshot, editor, pending, loading = false, connected = true, error, enabledError, probe, onChange, onEnabledChange, onEnabledRetry, onSave, onProbe, onDiscard, onReload, onRetry }: {
  settings: MocoSettingsView; snapshot: MemoryServiceSnapshot | null; editor: MemoryConnectionEditor;
  savedMemory?: MemoryBlock; pending?: MemoryConnectionAction; loading?: boolean; connected?: boolean; error?: string; enabledError?: string; probe?: HindsightProbeResult;
  onChange: (draft: MemoryConnectionDraft) => void; onSave: (event: FormEvent<HTMLFormElement>) => void;
  onEnabledChange: (enabled: boolean) => void; onEnabledRetry?: () => void;
  onProbe: () => void; onDiscard: () => void; onReload: () => void;
  onRetry?: () => void;
}) {
  useI18n();
  const { draft } = editor;
  const enabledControlRef = useRef<HTMLDivElement>(null);
  const restoreEnabledFocus = useRef(false);
  const busy = Boolean(pending);
  const dirty = memoryConnectionDirty(editor);
  const running = snapshot?.jobs.some((job) => job.status === "running") ?? false;
  const disabled = !connected || running;
  const reusable = sameOrigins(draft, savedMemory.value);
  const enabled = snapshot && snapshot.revision >= savedMemory.revision ? snapshot.connection.enabled : savedMemory.value.enabled;
  useEffect(() => {
    if (!pending && restoreEnabledFocus.current) {
      restoreEnabledFocus.current = false;
      if (document.activeElement === document.body) enabledControlRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
    }
  }, [pending]);
  const change = <K extends keyof MemoryConnectionDraft>(key: K, value: MemoryConnectionDraft[K]) => onChange({ ...draft, [key]: value });
  return <div className="moco-settings-form gap-7" aria-busy={busy || undefined}>
    <div inert={busy || undefined}>
      <SettingsSection title={t("长期记忆", "Long-term memory")} status={<Chip size="sm" variant="soft" color={enabled ? "success" : "default"}>{enabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}</Chip>} action={
        <div ref={enabledControlRef} className="flex items-center gap-2">{pending === "enabled" && <Spinner size="sm" aria-label={t("保存启用状态", "Saving enabled state")} />}<Switch aria-label={t("启用长期记忆", "Enable long-term memory")} isSelected={enabled} isDisabled={disabled} onChange={(next) => { restoreEnabledFocus.current = enabledControlRef.current?.contains(document.activeElement) ?? false; onEnabledChange(next); }}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch></div>
      }>{null}</SettingsSection>
    </div>
    {enabledError && <Alert status="danger" role="alert" className="rounded-2xl p-3"><Alert.Content className="flex-1 break-words text-sm">{enabledError}</Alert.Content>{onEnabledRetry && <Button type="button" size="sm" variant="secondary" isDisabled={busy || !connected} onPress={onEnabledRetry}>{t("重试", "Retry")}</Button>}</Alert>}
    <form className="moco-settings-form gap-4" aria-label={t("长期记忆连接设置", "Long-term memory connection settings")} onSubmit={onSave}>
    <div inert={busy || undefined}>
    <SettingsSection title={t("连接配置", "Connection settings")}>
      <div className="moco-form-stack">
        <MemoryServerList addresses={[draft.endpoint, ...draft.endpoints]} disabled={disabled}
          onChange={([endpoint, ...endpoints]) => onChange({ ...draft, endpoint, endpoints })} />
        <div className="moco-form-grid">
          <ConnectionSecret label={t("密钥", "API key")} value={draft.routerApiKey} saved={reusable && savedMemory.hasRouterApiKey} clear={draft.clearRouterApiKey} disabled={disabled} onChange={(value) => change("routerApiKey", value)} onClear={() => onChange({ ...draft, routerApiKey: "", clearRouterApiKey: !draft.clearRouterApiKey })} />
          <ConnectionSecret label={t("公开目录密钥", "Public directory API key")} value={draft.workerApiKey} saved={reusable && savedMemory.hasWorkerApiKey} clear={draft.clearWorkerApiKey} disabled={disabled} onChange={(value) => change("workerApiKey", value)} onClear={() => onChange({ ...draft, workerApiKey: "", clearWorkerApiKey: !draft.clearWorkerApiKey })} />
        </div>
        <div className="moco-form-grid">
          <TextField variant="secondary" className="moco-form-field" value={draft.privateBank} onChange={(value) => change("privateBank", value)} isRequired isDisabled={disabled} fullWidth><Label className="text-sm font-medium">{t("隐私记忆库名", "Private memory bank")}</Label><Input spellCheck={false} /></TextField>
          <TextField variant="secondary" className="moco-form-field" value={draft.sharedBank} onChange={(value) => change("sharedBank", value)} isRequired isDisabled={disabled} fullWidth><Label className="text-sm font-medium">{t("共享记忆库名", "Shared memory bank")}</Label><Input spellCheck={false} /></TextField>
        </div>
      </div>
    </SettingsSection>
    </div>
    {editor.conflict && <Alert status="warning" role="alert" className="rounded-2xl p-3"><Alert.Content className="flex-1 text-sm">{t("连接配置已更新，当前草稿尚未保存。", "Connection settings changed. Your draft has not been saved.")}</Alert.Content><Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={onReload}>{t("加载最新配置", "Load latest settings")}</Button></Alert>}
    <div className="flex min-w-0 flex-col gap-3">
      <div className="moco-settings-actions"><Button type="button" size="sm" variant="ghost" className="relative" aria-label={t("测试连接", "Test connection")} isDisabled={disabled || editor.conflict || busy && pending !== "probe"} isPending={pending === "probe"} onPress={onProbe}><span className={pending === "probe" ? "invisible" : undefined}>{t("测试连接", "Test connection")}</span>{pending === "probe" && <Spinner size="sm" color="current" className="absolute" aria-label={t("正在测试连接", "Testing connection")} />}</Button>{loading && <Spinner size="sm" aria-label={t("读取记忆服务", "Loading memory service")} />}</div>
      {error && <Alert status="danger" role="alert" className="rounded-2xl p-3"><Alert.Content className="flex-1 break-words text-sm">{error}</Alert.Content>{onRetry && <Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={onRetry}>{t("重试", "Retry")}</Button>}</Alert>}
      {!error && probe && <Alert status="success" role="status" className="rounded-2xl p-3"><Alert.Content className="text-sm">{probe.isolationVerified ? t("连接与权限隔离检查通过", "Connection and access isolation verified") : t("主脑私库连接正常", "Private memory bank connected")}</Alert.Content></Alert>}
    </div>
    <SettingsSaveBar dirty={dirty} busy={busy} saving={pending === "save"} disabled={disabled || editor.conflict} onDiscard={onDiscard} stateLabel={t("连接配置未保存", "Connection settings unsaved")} saveLabel={savedMemory.value.enabled ? t("验证并保存", "Verify and save") : t("保存连接配置", "Save connection settings")} />
    </form>
    <div inert={busy || undefined}>
    <SettingsSection title={t("本机服务", "Local service")}>
      {snapshot?.installed && <dl className="mb-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
        <dt className="text-muted">{t("部署设备", "Deployment device")}</dt><dd className="break-words">{snapshot.deviceName}</dd>
        <dt className="text-muted">{t("服务状态", "Service status")}</dt><dd>{snapshot.running ? t("运行中", "Running") : t("已停止", "Stopped")}{snapshot.version ? ` · ${snapshot.version}` : ""}</dd>
        {snapshot.model && <><dt className="text-muted">{t("记忆模型", "Memory model")}</dt><dd className="break-all">{snapshot.model.provider} / {snapshot.model.model}</dd></>}
      </dl>}
      <div className="flex flex-wrap gap-2">
        {(!snapshot?.installed || snapshot.phase === "failed") && <Button type="button" variant="secondary" isDisabled={disabled} onPress={() => requestMemoryService("deploy")}>{snapshot?.phase === "failed" ? t("恢复部署", "Resume deployment") : t("在本机配置 Hindsight", "Set up Hindsight locally")}</Button>}
        {snapshot?.installed && snapshot.phase !== "failed" && <Button type="button" variant="secondary" isDisabled={disabled} onPress={() => requestMemoryService("configure")}>{t("配置本机模型", "Configure local model")}</Button>}
        {snapshot?.installed && <Button type="button" variant="danger" isDisabled={disabled} onPress={() => requestMemoryService("uninstall")}>{t("卸载本机服务", "Uninstall local service")}</Button>}
      </div>
    </SettingsSection>
    </div>
  </div>;
}

export function MemoryServicePanel({ settings, connected = true, onSettingsUpdated, onDirtyChange, onBusyChange }: {
  settings: MocoSettingsView; connected?: boolean; onSettingsUpdated: (settings: MocoSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
}) {
  useI18n();
  const [snapshot, setSnapshot] = useState<MemoryServiceSnapshot | null>(null);
  const [savedMemory, setSavedMemory] = useState(settings.blocks.memory);
  const savedMemoryRef = useRef(savedMemory);
  const [editor, setEditor] = useState(() => memoryConnectionEditor(settings.blocks.memory));
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<MemoryConnectionAction>();
  const pendingRef = useRef(false);
  const busy = Boolean(pending);
  useSettingsPending(pending === "save" || pending === "enabled");
  const [error, setError] = useState<string>();
  const [enabledError, setEnabledError] = useState<string>();
  const [enabledRetry, setEnabledRetry] = useState<{ enabled: boolean; revision: number } | "sync">();
  const [loadError, setLoadError] = useState<string>();
  const [probe, setProbe] = useState<HindsightProbeResult>();
  const [refresh, setRefresh] = useState(0);
  const formRef = useRef<HTMLDivElement>(null);
  const dirty = memoryConnectionDirty(editor);
  const rememberMemory = (block: MemoryBlock) => {
    if (block.revision < savedMemoryRef.current.revision) return;
    savedMemoryRef.current = block;
    setSavedMemory(block);
  };
  useEffect(() => { rememberMemory(settings.blocks.memory); setEditor((current) => reconcileMemoryConnection(current, settings.blocks.memory)); setProbe(undefined); }, [settings.blocks.memory.revision]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    setLoading(true);
    void mocoRest.getMemoryService().then((next) => { if (alive) { setSnapshot((current) => current && current.revision > next.revision ? current : next); setLoadError(undefined); } }, (cause) => { if (alive) setLoadError(redactSecrets(cause instanceof Error ? cause.message : t("读取服务失败", "Failed to load service"))); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [connected, settings.blocks.memory.revision, refresh]);
  useEffect(() => {
    const changed = (event: Event) => { const next = (event as CustomEvent<MemoryServiceSnapshot>).detail; setSnapshot((current) => current && current.revision > next.revision ? current : next); setLoadError(undefined); };
    const focus = () => { requestAnimationFrame(() => { formRef.current?.scrollIntoView({ block: "start" }); formRef.current?.querySelector<HTMLInputElement>('input[type="url"]')?.focus(); }); };
    window.addEventListener(MEMORY_SERVICE_CHANGED_EVENT, changed);
    window.addEventListener(MEMORY_CONNECTION_FOCUS_EVENT, focus);
    return () => { window.removeEventListener(MEMORY_SERVICE_CHANGED_EVENT, changed); window.removeEventListener(MEMORY_CONNECTION_FOCUS_EVENT, focus); };
  }, []);
  const reset = (next?: MocoSettingsView) => { if (next) { rememberMemory(next.blocks.memory); setEnabledError(undefined); setEnabledRetry(undefined); } setEditor(memoryConnectionEditor(next?.blocks.memory ?? savedMemoryRef.current)); setError(undefined); setProbe(undefined); };
  const syncEnabled = async () => {
    const latest = await mocoRest.getSettings();
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
      setEnabledRetry(committed || cause instanceof MocoApiError && cause.code === "memory_revision_conflict" ? "sync" : { enabled, revision: saved.revision });
    } finally { pendingRef.current = false; setPending(undefined); }
  };
  const retryEnabled = async () => {
    if (!enabledRetry) return;
    if (enabledRetry !== "sync" && enabledRetry.revision === savedMemoryRef.current.revision) { await toggleEnabled(enabledRetry.enabled); return; }
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
    try { const latest = await mocoRest.getSettings(); reset(latest); onSettingsUpdated(latest); setRefresh((value) => value + 1); }
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
      const result = probeOnly ? await mocoRest.probeMemoryConnection(request) : await mocoRest.saveMemoryConnection(request);
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
  return <div ref={formRef}><MemoryConnectionForm settings={settings} savedMemory={savedMemory} snapshot={snapshot} editor={editor} pending={pending} loading={loading} connected={connected} error={error ?? loadError} enabledError={enabledError} probe={probe}
    onEnabledChange={(enabled) => void toggleEnabled(enabled)} onEnabledRetry={enabledRetry ? () => void retryEnabled() : undefined}
    onChange={(draft) => { setEditor((current) => ({ ...current, draft })); setError(undefined); setProbe(undefined); }}
    onSave={(event) => { event.preventDefault(); void submit(false); }} onProbe={() => void submit(true)} onDiscard={() => reset()}
    onReload={() => void reload()} onRetry={!error && loadError ? () => setRefresh((value) => value + 1) : undefined} /></div>;
}
