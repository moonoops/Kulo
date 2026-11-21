import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Chip, Label, Spinner, Switch, Table, Tabs } from "@heroui/react";
import { redactSensitiveText, type ConnectionApplicationView, type ConnectionCategory, type ConnectionPrepareRequest, type ConnectionRecordView, type ConnectionWorkspaceSnapshot } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloIcon } from "../../kulo-icon";
import { kuloRest, type AssistantWorkspaceView } from "../../kulo-api";
import { ConnectionIcon } from "./connection-icon";
import { AddAppModal } from "./mcp-add-modal";
import { McpOAuthModal } from "./mcp-oauth-modal";
import { HomeAssistantConfigModal } from "./home-assistant-config-modal";
import { SettingsList, SettingsSection } from "./settings-layout";
import type { SettingsAssistantEntryIntent } from "./settings-assistant-actions";
import "./connections-module.css";

export type ConnectionPrepare = (fields?: Omit<ConnectionPrepareRequest, "clientId">) => Promise<void>;

export function connectionStatusLabel(connection: ConnectionRecordView): string {
  switch (connection.status) {
    case "verified": return t("可用", "Available");
    case "incomplete": return t("待补全", "Incomplete");
    case "error": return t("需要处理", "Needs attention");
    case "saved": return t("已保存", "Saved");
  }
}

export function mcpConnectionStatus(connection: ConnectionRecordView): { color: "success" | "warning" | "danger" | "default"; label: string } {
  if (connection.status === "verified") {
    return {
      color: "success",
      label: connection.mcpTools?.length
        ? t(`已连接 · ${connection.mcpTools.length} 项工具`, `Connected · ${connection.mcpTools.length} tools`)
        : t("已连接", "Connected"),
    };
  }
  if (connection.mcpTransport === "http" && connection.mcpAuthMode === "oauth" && !connection.mcpOAuthAuthorized) {
    return connection.status === "error"
      ? { color: "danger", label: t("需要重新授权", "Re-authorization required") }
      : { color: "warning", label: t("待授权", "Sign in required") };
  }
  if (connection.status === "error") {
    return { color: "danger", label: t("需要处理", "Needs attention") };
  }
  return { color: "default", label: t("已保存", "Saved") };
}

export function connectionAddress(connection: ConnectionRecordView): string {
  if (connection.kind === "ssh") return connection.host ? `${connection.host}${connection.port && connection.port !== 22 ? `:${connection.port}` : ""}` : "";
  if (connection.kind === "mcp") {
    if (connection.mcpTransport === "stdio") return connection.mcpCommand ?? "";
    let site = connection.url ?? "";
    if (site) { try { site = new URL(site).host; } catch { /* Preserve incomplete metadata for editing. */ } }
    return site;
  }
  if (connection.kind === "custom" || connection.category === "information") return "";
  let site = connection.url ?? "";
  if (site) { try { site = new URL(site).host; } catch { /* Preserve incomplete metadata for editing. */ } }
  return connection.username || site;
}

export function connectionCategory(connection: ConnectionRecordView): ConnectionCategory {
  return connection.category ?? (connection.kind === "app" || connection.kind === "mcp" ? "app" : "credential");
}

export function applicationStatusLabel(application: ConnectionApplicationView): string {
  switch (application.status) {
    case "connected": return t("已连接", "Connected");
    case "needs_attention": return t("需要处理", "Needs attention");
    case "unavailable": return t("暂不可用", "Unavailable");
    case "disconnected": return t("未连接", "Disconnected");
  }
}

function ConnectionGroup({ title, action, children }: { title: string; action: ReactNode; children: ReactNode }) {
  useI18n();
  return <section className="kulo-connection-group" aria-label={title}>
    <div className="kulo-settings-section-head"><h2 className="kulo-section-title">{title}</h2>{action}</div>
    {children}
  </section>;
}

function shortMutedAppLabel(appId: string): string {
  const trimmed = appId.trim();
  const tail = trimmed.split(".").filter(Boolean).at(-1);
  return tail || trimmed;
}

function AssistantAwarenessSection({
  assistant,
  connected,
  localEnvId,
  onUpdated,
  onRequestAcceleration,
  onOpenHomeAssistant,
}: {
  assistant: AssistantWorkspaceView;
  connected: boolean;
  localEnvId?: string;
  onUpdated?: (next: AssistantWorkspaceView) => void;
  onRequestAcceleration?: () => void;
  onOpenHomeAssistant?: () => void;
}) {
  useI18n();
  const [busyNotif, setBusyNotif] = useState(false);
  const [busySpark, setBusySpark] = useState(false);
  const [busyLark, setBusyLark] = useState(false);
  const [busyModel, setBusyModel] = useState(false);
  const [unmutingApp, setUnmutingApp] = useState<string | null>(null);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [sectionError, setSectionError] = useState<string | null>(null);

  const isLocalSource = (envId: string) => envId === "local" || Boolean(localEnvId && envId === localEnvId);
  const macSources = assistant.sources.filter((source) => source.platform === "darwin");
  const grantedSources = macSources.filter((source) => source.permission === "granted");
  const fdaSources = macSources.filter((source) => source.permission === "full_disk_access_required");
  const localNeedsFda = fdaSources.some((source) => isLocalSource(source.envId));
  const remoteFdaNames = fdaSources.filter((source) => !isLocalSource(source.envId)).map((source) => source.envName || source.envId);
  const errorSource = macSources.find((source) => source.permission === "unsupported_schema" || source.permission === "error");

  const notifStatus: { color: "success" | "warning" | "danger" | "default"; label: string } = !assistant.enabled
    ? { color: "default", label: t("未开启", "Off") }
    : grantedSources.length > 0 && fdaSources.length === 0
      ? {
          color: "success",
          label: grantedSources.length > 1
            ? t(`已连接 · ${grantedSources.length} 台 Mac`, `Connected · ${grantedSources.length} Macs`)
            : t("已连接", "Connected"),
        }
      : grantedSources.length > 0 && fdaSources.length > 0
        ? {
            color: "warning",
            label: t(`已连接 ${grantedSources.length} 台 · ${fdaSources.length} 台待授权`, `${grantedSources.length} connected · ${fdaSources.length} needs access`),
          }
        : fdaSources.length > 0
          ? { color: "warning", label: t("需要完全磁盘访问权限", "Full Disk Access required") }
          : errorSource
            ? { color: "danger", label: t("需要处理", "Needs attention") }
            : macSources.length === 0
              ? { color: "default", label: t("等待 Mac 在线", "Waiting for a Mac") }
              : { color: "default", label: t("已开启", "Enabled") };

  const bg = assistant.backgroundModel;
  const bgJobRunning = bg.job?.status === "queued" || bg.job?.status === "running";
  const bgStatus: { color: "success" | "warning" | "default"; label: string } = bgJobRunning
    ? { color: "default", label: bg.job?.progress || t("正在配置…", "Configuring…") }
    : bg.mode === "local-managed" && bg.running
      ? { color: "success", label: `${bg.engine === "ollama" ? "Ollama" : "oMLX"}${bg.modelId ? ` · ${bg.modelId}` : ""}` }
      : bg.mode === "local-managed" && !bg.running
        ? { color: "warning", label: t("本机模型未运行", "Local model stopped") }
        : bg.mode === "kulo-provider"
          ? { color: "default", label: bg.modelId || t("自定义模型", "Custom model") }
          : { color: "default", label: t("跟随当前模型", "Current model") };

  const toggleNotifications = async (enabled: boolean) => {
    if (!connected || busyNotif) return;
    setBusyNotif(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantNotifications({ enabled });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("更新通知感知状态失败", "Failed to update notification capture")));
    } finally {
      setBusyNotif(false);
    }
  };

  const resetBackgroundModel = async () => {
    if (!connected || busyModel) return;
    setBusyModel(true);
    setSectionError(null);
    try {
      const result = await kuloRest.configureAssistantBackgroundModel({ mode: "auto" });
      onUpdated?.({ ...result.snapshot, localHost: result.localHost ?? assistant.localHost });
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("切换后台模型失败", "Failed to switch background model")));
    } finally {
      setBusyModel(false);
    }
  };

  const unmuteApp = async (appId: string) => {
    if (!connected || unmutingApp) return;
    setUnmutingApp(appId);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantNotifications({ unmuteApp: appId });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("取消屏蔽失败", "Failed to unmute app")));
    } finally {
      setUnmutingApp(null);
    }
  };

  const openFdaSettings = async () => {
    if (!connected || openingSettings) return;
    setOpeningSettings(true);
    setSectionError(null);
    try {
      await kuloRest.openConnectionPermissionSettings("full-disk-access");
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("无法打开系统设置", "Failed to open System Settings")));
    } finally {
      setOpeningSettings(false);
    }
  };

  const toggleSpark = async (enabled: boolean) => {
    if (!connected || busySpark) return;
    setBusySpark(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantSpark({ enabled });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("更新 Spark Mail 状态失败", "Failed to update Spark Mail")));
    } finally {
      setBusySpark(false);
    }
  };

  const toggleLark = async (enabled: boolean) => {
    if (!connected || busyLark) return;
    setBusyLark(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantLark({ enabled });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("更新飞书桥接状态失败", "Failed to update Lark bridge")));
    } finally {
      setBusyLark(false);
    }
  };

  const spark = assistant.spark;
  const sparkStatus: { color: "success" | "warning" | "default"; label: string } | null = spark
    ? !spark.enabled
      ? { color: "default", label: t("未开启", "Off") }
      : spark.available
        ? {
            color: "success",
            label: spark.accountCount
              ? t(`已连接 · ${spark.accountCount} 账号`, `Connected · ${spark.accountCount}`)
              : t("已连接", "Connected"),
          }
        : { color: "warning", label: t("需开启 Spark CLI", "Enable Spark CLI") }
    : null;

  const ha = assistant.homeAssistant;
  const haStatus: { color: "success" | "warning" | "default"; label: string } | null = ha
    ? ha.connected
      ? {
          color: "success",
          label: ha.curatedEntities
            ? t(`已连接 · ${ha.curatedEntities} 设备`, `Connected · ${ha.curatedEntities}`)
            : t("已连接", "Connected"),
        }
      : ha.enabled && ha.error
        ? { color: "warning", label: t("需要处理", "Needs attention") }
        : { color: "default", label: t("未连接", "Not connected") }
    : null;

  const lark = assistant.lark;
  const larkReadyCount = lark ? lark.profiles.filter((p) => p.ready).length : 0;
  const larkStatus: { color: "success" | "warning" | "default"; label: string } | null = lark
    ? !lark.enabled
      ? { color: "default", label: t("未开启", "Off") }
      : !lark.cliAvailable
        ? { color: "warning", label: t("未安装 lark-cli", "lark-cli missing") }
        : larkReadyCount > 0
          ? {
              color: "success",
              label: larkReadyCount > 1
                ? t(`已连接 · ${larkReadyCount} 个组织`, `Connected · ${larkReadyCount} orgs`)
                : t("已连接", "Connected"),
            }
          : { color: "warning", label: t("待登录授权", "Sign in required") }
    : null;

  const showBackgroundRow = assistant.enabled || Boolean(spark?.enabled) || Boolean(ha?.enabled) || Boolean(lark?.enabled) || bg.mode !== "auto";
  const fdaAlertTitle = localNeedsFda && remoteFdaNames.length > 0
    ? t(`本机与「${remoteFdaNames.join("、")}」需在系统设置中开启「完全磁盘访问权限」`, `Enable Full Disk Access on this Mac and ${remoteFdaNames.join(", ")}`)
    : localNeedsFda
      ? t("需要在系统设置中为 Kulo 开启「完全磁盘访问权限」", "Enable Full Disk Access for Kulo in System Settings")
      : t(`请在「${remoteFdaNames.join("、")}」上开启「完全磁盘访问权限」`, `Enable Full Disk Access on ${remoteFdaNames.join(", ")}`);

  return (
    <SettingsSection title={t("实时感知", "Ambient awareness")}>
      <SettingsList label={t("实时感知设置", "Ambient awareness settings")}>
        <Switch
          className="w-full"
          aria-label={t("启用 macOS 通知中心感知", "Enable macOS Notification Center awareness")}
          isSelected={assistant.enabled}
          isDisabled={!connected || busyNotif}
          onChange={(enabled) => void toggleNotifications(enabled)}
        >
          <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Label className="text-sm font-normal text-foreground">{t("macOS 通知中心", "macOS Notification Center")}</Label>
              <Chip size="sm" variant="soft" color={notifStatus.color}>{notifStatus.label}</Chip>
              {busyNotif && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
            </div>
            <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
          </Switch.Content>
        </Switch>
        {spark && sparkStatus && (
          <Switch
            className="w-full"
            aria-label={t("启用 Spark Mail 深度连接", "Enable Spark Mail integration")}
            isSelected={spark.enabled}
            isDisabled={!connected || busySpark}
            onChange={(enabled) => void toggleSpark(enabled)}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Label className="text-sm font-normal text-foreground">Spark Mail</Label>
                <Chip size="sm" variant="soft" color={sparkStatus.color}>{sparkStatus.label}</Chip>
                {busySpark && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        )}
        {ha && haStatus && (
          <div className="kulo-settings-list-row justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-normal text-foreground">{t("米家 / Home Assistant", "Mi Home / Home Assistant")}</span>
              <Chip size="sm" variant="soft" color={haStatus.color}>{haStatus.label}</Chip>
            </div>
            {onOpenHomeAssistant && (
              <Button
                size="sm"
                variant="secondary"
                aria-label={ha.connected ? t("管理米家 / Home Assistant", "Manage Mi Home / Home Assistant") : t("连接米家 / Home Assistant", "Configure Mi Home / Home Assistant")}
                isDisabled={!connected}
                onPress={onOpenHomeAssistant}
              >
                {ha.connected ? t("管理", "Manage") : t("连接", "Connect")}
              </Button>
            )}
          </div>
        )}
        {lark && larkStatus && (
          <Switch
            className="w-full"
            aria-label={t("启用飞书双组织桥接", "Enable Feishu/Lark bridge")}
            isSelected={lark.enabled}
            isDisabled={!connected || busyLark}
            onChange={(enabled) => void toggleLark(enabled)}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Label className="text-sm font-normal text-foreground">{t("飞书 (lark-cli)", "Lark (lark-cli)")}</Label>
                <Chip size="sm" variant="soft" color={larkStatus.color}>{larkStatus.label}</Chip>
                {busyLark && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        )}
        {showBackgroundRow && (
          <div className="kulo-settings-list-row justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-normal text-foreground">{t("后台处理", "Background processing")}</span>
              <Chip size="sm" variant="soft" color={bgStatus.color}>{bgStatus.label}</Chip>
              {(busyModel || bgJobRunning) && <Spinner size="sm" aria-label={t("正在配置", "Configuring")} />}
            </div>
            {bg.mode === "local-managed" ? (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!connected || busyModel || bgJobRunning}
                onPress={() => void resetBackgroundModel()}
              >
                {t("切回默认", "Use default")}
              </Button>
            ) : onRequestAcceleration ? (
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!connected || busyModel || bgJobRunning}
                onPress={onRequestAcceleration}
              >
                {t("本机免费加速", "Free local speed-up")}
              </Button>
            ) : null}
          </div>
        )}
        {assistant.mutedApps.length > 0 && (
          <div className="kulo-settings-list-row justify-between">
            <span className="shrink-0 text-sm font-normal text-foreground">{t("已屏蔽应用", "Muted apps")}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              {assistant.mutedApps.map((appId) => (
                <Button
                  key={appId}
                  size="sm"
                  variant="ghost"
                  aria-label={t(`取消屏蔽 ${appId}`, `Unmute ${appId}`)}
                  isDisabled={!connected || unmutingApp === appId}
                  onPress={() => void unmuteApp(appId)}
                >
                  {shortMutedAppLabel(appId)}
                  <KuloIcon name="close" size={14} />
                </Button>
              ))}
            </div>
          </div>
        )}
      </SettingsList>
      {sectionError && (
        <Alert status="danger" role="alert">
          <Alert.Content><Alert.Description>{sectionError}</Alert.Description></Alert.Content>
        </Alert>
      )}
      {assistant.enabled && fdaSources.length > 0 && (
        <Alert status="warning">
          <Alert.Content><Alert.Title>{fdaAlertTitle}</Alert.Title></Alert.Content>
          {localNeedsFda && assistant.localHost && (
            <Button size="sm" variant="secondary" isDisabled={!connected || openingSettings} isPending={openingSettings} onPress={() => void openFdaSettings()}>
              {t("打开系统设置", "Open System Settings")}
            </Button>
          )}
        </Alert>
      )}
      {assistant.enabled && !fdaSources.length && errorSource && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{redactSensitiveText(errorSource.error || t("无法读取系统通知数据库", "Unable to read the system notification database"))}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {bg.mode === "local-managed" && bg.error && (
        <Alert status="warning">
          <Alert.Content><Alert.Description>{redactSensitiveText(bg.error)}</Alert.Description></Alert.Content>
        </Alert>
      )}
    </SettingsSection>
  );
}

type AppTableRow =
  | { id: string; rowKind: "application"; application: ConnectionApplicationView }
  | { id: string; rowKind: "mcp"; connection: ConnectionRecordView };

export function ConnectionsModule({ clientId, snapshot, loading, error, connected, localEnvId, preparing = false, onPrepare, onRefresh, entryIntent, onIntentHandled, assistant, onAssistantUpdated, onRequestAssistantAcceleration, onRequestAssistantPrompt }: {
  clientId?: string;
  snapshot: ConnectionWorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  localEnvId?: string;
  preparing?: boolean;
  onPrepare: ConnectionPrepare;
  onRefresh: () => void;
  entryIntent?: SettingsAssistantEntryIntent | null;
  onIntentHandled?: (id: string) => void;
  assistant?: AssistantWorkspaceView | null;
  onAssistantUpdated?: (next: AssistantWorkspaceView) => void;
  onRequestAssistantAcceleration?: () => void;
  onRequestAssistantPrompt?: (prompt: string) => void;
}) {
  useI18n();
  const [view, setView] = useState<ConnectionCategory>("app");
  const [busy, setBusy] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [haModalOpen, setHaModalOpen] = useState(false);
  const [oauthTarget, setOauthTarget] = useState<{ connection: ConnectionRecordView; forceReauth: boolean } | null>(null);
  const [remove, setRemove] = useState<{ id: string; name: string; category: ConnectionCategory } | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!entryIntent || entryIntent.module !== "connections" || entryIntent.intent !== "add-connection") return;
    setView("credential");
    onIntentHandled?.(entryIntent.id);
    void onPrepare({ category: "credential", kind: "account" }).catch((cause) => setActionError(redactSensitiveText(cause instanceof Error ? cause.message : t("打开连接表单失败", "Failed to open connection form"))));
  }, [entryIntent?.id, onIntentHandled, onPrepare]);

  const prepare: ConnectionPrepare = async (fields) => {
    setActionError(null);
    try { await onPrepare(fields); }
    catch (cause) { setActionError(redactSensitiveText(cause instanceof Error ? cause.message : t("打开连接表单失败", "Failed to open connection form"))); }
  };
  const captureFocus = () => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const openRemove = (item: { id: string; name: string; category: ConnectionCategory }) => {
    setActionError(null);
    captureFocus();
    setRemove(item);
  };
  const openAddModal = () => {
    setActionError(null);
    captureFocus();
    setAddOpen(true);
  };
  const openOAuthModal = (connection: ConnectionRecordView, forceReauth = false) => {
    setActionError(null);
    captureFocus();
    setOauthTarget({ connection, forceReauth });
  };
  const restoreFocus = (removed = false) => requestAnimationFrame(() => {
    if (!removed && returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    else (rootRef.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([inert]) button:not(:disabled)') ?? rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
  });
  const disconnect = async () => {
    if (!remove || busy || !connected) return;
    setBusy(remove.id); setActionError(null);
    try { await kuloRest.deleteConnection(remove.id); setRemove(null); onRefresh(); restoreFocus(true); }
    catch (cause) { setActionError(redactSensitiveText(cause instanceof Error ? cause.message : remove.category === "app" ? t("取消连接失败", "Failed to disconnect") : t("移除失败", "Failed to remove"))); }
    finally { setBusy(null); }
  };
  const runMcpTest = async (connection: ConnectionRecordView) => {
    if (!connected || busy || testingId) return;
    setTestingId(connection.id);
    setActionError(null);
    try {
      await kuloRest.testConnection(connection.id);
      onRefresh();
    } catch (cause) {
      setActionError(redactSensitiveText(cause instanceof Error ? cause.message : t("连接测试失败", "Connection test failed")));
      onRefresh();
    } finally {
      setTestingId(null);
    }
  };
  const unavailable = Boolean(snapshot && !snapshot.vault.available);
  const disabled = !connected || preparing || busy !== null;
  const applications = snapshot?.applications ?? [];
  const mcpConnections = snapshot?.connections.filter((connection) => connection.kind === "mcp") ?? [];
  const appRows: AppTableRow[] = [
    ...applications.map((application) => ({ id: application.id, rowKind: "application" as const, application })),
    ...mcpConnections.map((connection) => ({ id: `mcp:${connection.id}`, rowKind: "mcp" as const, connection })),
  ];
  const renderRecords = (category: "credential" | "information") => {
    const records = snapshot?.connections.filter((connection) => connectionCategory(connection) === category) ?? [];
    return <Table variant="secondary" className="kulo-settings-table">
      <Table.ScrollContainer className="kulo-settings-table-scroll">
        <Table.Content aria-label={category === "credential" ? t("凭据列表", "Credentials") : t("其他信息列表", "Other information")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
          <Table.Header>
            <Table.Column id="name" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{t("名称", "Name")}</Table.Column>
            <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body items={records} renderEmptyState={() => <div className="kulo-table-empty-state">{category === "credential" ? t("尚未添加凭据", "No credentials added") : t("尚未保存其他信息", "No other information saved")}</div>}>
            {(connection) => <Table.Row id={connection.id} textValue={connection.name}>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                <div className="kulo-connection-name">
                  <ConnectionIcon kind={connection.kind} category={category} />
                  <div className="kulo-connection-copy"><span className="kulo-item-title">{connection.name}</span>{connectionAddress(connection) && <span className="kulo-item-description">{connectionAddress(connection)}</span>}</div>
                </div>
              </Table.Cell>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                <div className="flex flex-col items-start gap-1">
                  <Chip size="sm" variant="soft" color={connection.status === "verified" ? "success" : connection.status === "error" ? "danger" : "default"}>{connectionStatusLabel(connection)}</Chip>
                  {connection.error && <span className="whitespace-normal break-words text-xs text-danger">{redactSensitiveText(connection.error)}</span>}
                </div>
              </Table.Cell>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                <div className="kulo-settings-table-action-group">
                  <Button size="sm" variant="ghost" aria-label={t(`编辑${connection.name}`, `Edit ${connection.name}`)} isDisabled={disabled} onPress={() => void prepare({ connectionId: connection.id })}>{t("编辑", "Edit")}</Button>
                  <Button size="sm" variant="ghost" aria-label={t(`移除${connection.name}`, `Remove ${connection.name}`)} isDisabled={!connected || busy !== null} onPress={() => openRemove({ id: connection.id, name: connection.name, category })}>{t("移除", "Remove")}</Button>
                </div>
              </Table.Cell>
            </Table.Row>}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>;
  };

  return <section ref={rootRef} className="kulo-connections" aria-label={t("授权凭据", "Credentials & access")}>
    {(error || actionError) && <Alert status="danger"><Alert.Content><Alert.Description>{redactSensitiveText(actionError || error || "")}</Alert.Description></Alert.Content><Button size="sm" variant="secondary" isDisabled={!connected || loading} onPress={onRefresh}>{t("重试", "Retry")}</Button></Alert>}
    {unavailable && <Alert status="warning"><Alert.Content><Alert.Title>{t("本地凭据库不可用", "Local credential vault unavailable")}</Alert.Title>{snapshot?.vault.error && <Alert.Description>{redactSensitiveText(snapshot.vault.error)}</Alert.Description>}</Alert.Content><Button size="sm" variant="secondary" isDisabled={!connected || loading} onPress={onRefresh}>{t("重试", "Retry")}</Button></Alert>}
    {!connected && <Alert status="warning"><Alert.Content>{t("与中枢连接已断开", "Disconnected from the hub")}</Alert.Content></Alert>}
    {loading && !snapshot && <div className="flex items-center gap-2 text-sm text-muted" role="status"><Spinner size="sm" />{t("加载中…", "Loading…")}</div>}
    {snapshot && <Tabs selectedKey={view} onSelectionChange={(key) => { if (key === "app" || key === "credential" || key === "information") setView(key); }} className="flex min-w-0 flex-col gap-6">
      <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
        <Tabs.List aria-label={t("授权凭据视图", "Credentials & access views")} className="w-max">
          <Tabs.Tab id="app" className="w-auto shrink-0 whitespace-nowrap">{t("应用", "Apps")}<Tabs.Indicator /></Tabs.Tab>
          <Tabs.Tab id="credential" className="w-auto shrink-0 whitespace-nowrap">{t("凭据", "Credentials")}<Tabs.Indicator /></Tabs.Tab>
          <Tabs.Tab id="information" className="w-auto shrink-0 whitespace-nowrap">{t("其他", "Other")}<Tabs.Indicator /></Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id="app" shouldForceMount className="data-[inert=true]:hidden">
        <div className="flex min-w-0 flex-col gap-6">
        <ConnectionGroup title={t("应用", "Apps")} action={<Button size="sm" variant="secondary" aria-label={t("添加应用", "Add app")} isDisabled={disabled} onPress={openAddModal}><KuloIcon name="add" size={16} />{t("添加", "Add")}</Button>}>
          <Table variant="secondary" className="kulo-settings-table">
            <Table.ScrollContainer className="kulo-settings-table-scroll">
              <Table.Content aria-label={t("应用列表", "Apps")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
                <Table.Header>
                  <Table.Column id="name" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{t("应用", "Apps")}</Table.Column>
                  <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
                  <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
                </Table.Header>
                <Table.Body items={appRows} renderEmptyState={() => <div className="kulo-table-empty-state">{t("暂无可连接应用", "No apps available")}</div>}>
                  {(row) => {
                    if (row.rowKind === "application") {
                      const { application } = row;
                      const isConnected = application.status === "connected";
                      const actionLabel = isConnected ? t("取消连接", "Disconnect") : application.status === "needs_attention" ? t("重新连接", "Reconnect") : t("连接", "Connect");
                      return <Table.Row id={row.id} textValue={application.name}>
                        <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                          <div className="kulo-connection-name">
                            <ConnectionIcon appId={application.id} />
                            <div className="kulo-connection-copy"><span className="kulo-item-title">{application.name}</span><span className="kulo-item-description">{application.description}</span></div>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                          <div className="flex flex-col items-start gap-1">
                            <Chip size="sm" variant="soft" color={isConnected ? "success" : application.status === "needs_attention" ? "danger" : "default"}>{applicationStatusLabel(application)}</Chip>
                            {application.error && <p className="whitespace-normal break-words text-xs text-danger">{redactSensitiveText(application.error)}</p>}
                          </div>
                        </Table.Cell>
                        <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                          <div className="kulo-settings-table-action-group">
                            <Button size="sm" variant="ghost" aria-label={`${actionLabel}${application.name}`} isPending={busy === application.connectionId}
                              isDisabled={disabled || (isConnected ? !application.connectionId : unavailable && application.authentication !== "macos" || application.status === "unavailable")}
                              onPress={() => {
                                if (isConnected) {
                                  if (application.connectionId) openRemove({ id: application.connectionId, name: application.name, category: "app" });
                                } else void prepare({ category: "app", appId: application.id, ...(application.connectionId ? { connectionId: application.connectionId } : {}) });
                              }}>{actionLabel}</Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>;
                    }
                    const { connection } = row;
                    const status = mcpConnectionStatus(connection);
                    const needsOAuth = connection.mcpTransport === "http" && connection.mcpAuthMode === "oauth" && (!connection.mcpOAuthAuthorized || connection.status === "error");
                    const subtitle = connection.mcpServerName && connection.mcpServerName !== connection.name
                      ? connection.mcpServerName
                      : connectionAddress(connection);
                    return <Table.Row id={row.id} textValue={connection.name}>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                        <div className="kulo-connection-name">
                          <ConnectionIcon kind="mcp" mcpPresetId={connection.mcpPresetId} mcpTransport={connection.mcpTransport} />
                          <div className="kulo-connection-copy">
                            <span className="kulo-item-title">{connection.name}</span>
                            {subtitle && <span className="kulo-item-description">{subtitle}</span>}
                          </div>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                        <div className="flex flex-col items-start gap-1">
                          <Chip size="sm" variant="soft" color={status.color}>{status.label}</Chip>
                          {connection.error && <p className="whitespace-normal break-words text-xs text-danger">{redactSensitiveText(connection.error)}</p>}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                        <div className="kulo-settings-table-action-group">
                          {needsOAuth && (
                            <Button
                              size="sm"
                              variant="secondary"
                              aria-label={connection.status === "error" ? t(`重新授权${connection.name}`, `Re-authorize ${connection.name}`) : t(`授权登录${connection.name}`, `Sign in to ${connection.name}`)}
                              isDisabled={disabled || unavailable}
                              onPress={() => openOAuthModal(connection, connection.status === "error")}
                            >
                              {connection.status === "error" ? t("重新授权", "Re-authorize") : t("授权登录", "Sign in")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t(`测试${connection.name}`, `Test ${connection.name}`)}
                            isPending={testingId === connection.id}
                            isDisabled={disabled || unavailable || testingId !== null || (connection.mcpTransport === "http" && connection.mcpAuthMode === "oauth" && !connection.mcpOAuthAuthorized)}
                            onPress={() => void runMcpTest(connection)}
                          >
                            {t("测试", "Test")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t(`编辑${connection.name}`, `Edit ${connection.name}`)}
                            isDisabled={disabled || (connection.mcpTransport === "stdio" && !snapshot.localHost)}
                            onPress={() => void prepare({ connectionId: connection.id })}
                          >
                            {t("编辑", "Edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t(`取消连接${connection.name}`, `Disconnect ${connection.name}`)}
                            isDisabled={!connected || busy !== null}
                            onPress={() => openRemove({ id: connection.id, name: connection.name, category: "app" })}
                          >
                            {t("取消连接", "Disconnect")}
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>;
                  }}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </ConnectionGroup>
        {assistant && (
          <AssistantAwarenessSection
            assistant={assistant}
            connected={connected}
            localEnvId={localEnvId}
            onUpdated={onAssistantUpdated}
            onRequestAcceleration={onRequestAssistantAcceleration}
            onOpenHomeAssistant={() => {
              captureFocus();
              setHaModalOpen(true);
            }}
          />
        )}
        </div>
      </Tabs.Panel>
      <Tabs.Panel id="credential" shouldForceMount className="data-[inert=true]:hidden">
        <ConnectionGroup title={t("凭据", "Credentials")} action={<Button size="sm" variant="secondary" aria-label={t("添加凭据", "Add credentials")} isPending={preparing} isDisabled={disabled} onPress={() => void prepare({ category: "credential", kind: "account" })}><KuloIcon name="add" size={16} />{t("添加", "Add")}</Button>}>{renderRecords("credential")}</ConnectionGroup>
      </Tabs.Panel>
      <Tabs.Panel id="information" shouldForceMount className="data-[inert=true]:hidden">
        <ConnectionGroup title={t("其他", "Other")} action={<Button size="sm" variant="secondary" aria-label={t("记住其他信息", "Save other information")} isDisabled={disabled} onPress={() => void prepare({ category: "information", kind: "custom" })}><KuloIcon name="add" size={16} />{t("添加", "Add")}</Button>}>{renderRecords("information")}</ConnectionGroup>
      </Tabs.Panel>
    </Tabs>}
    {addOpen && snapshot && (
      <AddAppModal
        open={addOpen}
        applications={applications}
        presets={snapshot.mcpPresets ?? []}
        existingConnections={snapshot.connections}
        connected={connected}
        vaultAvailable={snapshot.vault.available}
        localHost={Boolean(snapshot.localHost)}
        onSelectApplication={(application) => {
          void prepare({ category: "app", appId: application.id, ...(application.connectionId ? { connectionId: application.connectionId } : {}) });
        }}
        onSavedMcp={() => onRefresh()}
        onStartOAuth={(connection) => {
          setOauthTarget({ connection, forceReauth: false });
        }}
        onClose={() => {
          setAddOpen(false);
          restoreFocus();
        }}
      />
    )}
    {oauthTarget && (
      <McpOAuthModal
        open={oauthTarget !== null}
        connection={oauthTarget.connection}
        clientId={clientId}
        forceReauth={oauthTarget.forceReauth}
        onCompleted={() => onRefresh()}
        onClose={() => {
          setOauthTarget(null);
          restoreFocus();
        }}
      />
    )}
    {haModalOpen && assistant?.homeAssistant && (
      <HomeAssistantConfigModal
        open={haModalOpen}
        snapshot={assistant.homeAssistant}
        connected={connected}
        localHost={Boolean(assistant.localHost ?? snapshot?.localHost)}
        onUpdated={onAssistantUpdated}
        onRequestGuide={
          onRequestAssistantPrompt
            ? () =>
                onRequestAssistantPrompt(
                  t(
                    "请引导我一步步将米家无损接入 Home Assistant，并说明如何在 Home Assistant 生成长期访问令牌。",
                    "Guide me step-by-step to connect Mi Home to Home Assistant and generate a long-lived access token.",
                  ),
                )
            : undefined
        }
        onClose={() => {
          setHaModalOpen(false);
          restoreFocus();
        }}
      />
    )}
    {remove && <ConfirmDialog open title={remove.category === "app" ? t(`取消与「${remove.name}」的连接？`, `Disconnect from “${remove.name}”?`) : t(`移除「${remove.name}」？`, `Remove “${remove.name}”?`)} description={<div className="space-y-2"><p>{remove.category === "information" ? t("将移除本地保存的信息。", "Locally saved information will be removed.") : t("将清除本地授权记录和凭据，并撤销任务使用权限。", "Local access records and credentials will be deleted, and task access will be revoked.")}</p>{actionError && <p role="alert" className="text-danger">{actionError}</p>}</div>} confirmLabel={remove.category === "app" ? t("取消连接", "Disconnect") : t("移除", "Remove")} isPending={busy !== null} onConfirm={() => void disconnect()} onCancel={() => { setRemove(null); restoreFocus(); }} />}
  </section>;
}
