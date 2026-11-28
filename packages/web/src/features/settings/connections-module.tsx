import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Chip, Dropdown, Label, Spinner, Table, Tabs } from "@heroui/react";
import { redactSensitiveText, type ConnectionApplicationView, type ConnectionCategory, type ConnectionPrepareRequest, type ConnectionRecordView, type ConnectionWorkspaceSnapshot, type MigrationStdioPrefill } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloIcon } from "../../kulo-icon";
import { kuloRest, type AssistantWorkspaceView } from "../../kulo-api";
import { AssistantAwarenessSection } from "./assistant-awareness-section";
import { ConnectionIcon } from "./connection-icon";
import { CredentialConfigModal, type CredentialModalKind } from "./credential-config-modal";
import { AddAppModal } from "./mcp-add-modal";
import { McpOAuthModal } from "./mcp-oauth-modal";
import { ComposioConfigModal } from "./composio-config-modal";
import { ComposioAppsModal } from "./composio-apps-modal";
import { HomeAssistantConfigModal } from "./home-assistant-config-modal";
import { MigrationImportModal } from "./migration-import-modal";
import { SshFollowupModal } from "./ssh-followup-modal";
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
  if (connection.mcpDisabled) {
    return { color: "default", label: t("已禁用", "Disabled") };
  }
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

type AppTableRow =
  | { id: string; rowKind: "application"; application: ConnectionApplicationView }
  | { id: string; rowKind: "mcp"; connection: ConnectionRecordView };

export function ConnectionsModule({ clientId, snapshot, loading, error, connected, localEnvId, preparing = false, onPrepare, onRefresh, entryIntent, onIntentHandled, assistant, onAssistantUpdated, onRequestAssistantPrompt }: {
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
  onRequestAssistantPrompt?: (prompt: string) => void;
}) {
  useI18n();
  const [view, setView] = useState<ConnectionCategory>("app");
  const [busy, setBusy] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [stdioPrefill, setStdioPrefill] = useState<MigrationStdioPrefill | null>(null);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [haModalOpen, setHaModalOpen] = useState(false);
  const [oauthTarget, setOauthTarget] = useState<{ connection: ConnectionRecordView; forceReauth: boolean } | null>(null);
  const [composioConfigTarget, setComposioConfigTarget] = useState<{ mode: "create" } | { mode: "edit"; connection: ConnectionRecordView } | null>(null);
  const [composioAppsTarget, setComposioAppsTarget] = useState<ConnectionRecordView | null>(null);
  const [sshFollowupTarget, setSshFollowupTarget] = useState<ConnectionRecordView | null>(null);
  const [credentialModal, setCredentialModal] = useState<
    | { mode: "create"; initialKind: CredentialModalKind }
    | { mode: "edit"; connection: ConnectionRecordView }
    | null
  >(null);
  const [remove, setRemove] = useState<{ id: string; name: string; category: ConnectionCategory; isComposio?: boolean } | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const sshSupported = snapshot?.sshSupported !== false;
  useEffect(() => {
    if (!entryIntent || entryIntent.module !== "connections") return;
    if (entryIntent.tab) setView(entryIntent.tab);
    if (entryIntent.intent === "add-ssh-credential") {
      setView("credential");
      setActionError(null);
      setCredentialModal({ mode: "create", initialKind: sshSupported ? "ssh" : "account" });
      onIntentHandled?.(entryIntent.id);
      return;
    }
    if (entryIntent.intent === "add-connection") {
      setView("credential");
      setActionError(null);
      setCredentialModal({ mode: "create", initialKind: "account" });
      onIntentHandled?.(entryIntent.id);
      return;
    }
    if (entryIntent.tab) onIntentHandled?.(entryIntent.id);
  }, [entryIntent?.id, entryIntent?.module, entryIntent?.intent, entryIntent?.tab, onIntentHandled]);

  const prepare: ConnectionPrepare = async (fields) => {
    setActionError(null);
    try { await onPrepare(fields); }
    catch (cause) { setActionError(redactSensitiveText(cause instanceof Error ? cause.message : t("打开连接表单失败", "Failed to open connection form"))); }
  };
  const captureFocus = () => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const openRemove = (item: { id: string; name: string; category: ConnectionCategory; isComposio?: boolean }) => {
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
                  {connection.kind === "ssh" && connection.hasCredential && Boolean(connection.host && connection.username) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={connection.status === "verified" ? t(`测试${connection.name}`, `Test ${connection.name}`) : t(`连接${connection.name}`, `Connect ${connection.name}`)}
                      isDisabled={disabled || unavailable || Boolean(clientId && snapshot?.inputs.some((input) => input.clientId === clientId && input.status === "pending" && input.connectionId === connection.id))}
                      onPress={() => { setActionError(null); captureFocus(); setSshFollowupTarget(connection); }}
                    >
                      {connection.status === "verified" ? t("测试", "Test") : t("连接", "Connect")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t(`编辑${connection.name}`, `Edit ${connection.name}`)}
                    isDisabled={disabled || Boolean(clientId && snapshot?.inputs.some((input) => input.clientId === clientId && input.status === "pending" && input.connectionId === connection.id))}
                    onPress={() => {
                      if (category === "credential") {
                        setActionError(null);
                        captureFocus();
                        setCredentialModal({ mode: "edit", connection });
                      } else {
                        void prepare({ connectionId: connection.id });
                      }
                    }}
                  >
                    {t("编辑", "Edit")}
                  </Button>
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
        <ConnectionGroup
          title={t("应用", "Apps")}
          action={(
            <div className="flex items-center gap-2">
              {snapshot.localHost && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("从本机工具导入配置", "Import local tool configs")}
                  isDisabled={disabled}
                  onPress={() => {
                    setActionError(null);
                    captureFocus();
                    setMigrationOpen(true);
                  }}
                >
                  {t("从本机导入", "Import local")}
                </Button>
              )}
              <Button size="sm" variant="secondary" aria-label={t("添加应用", "Add app")} isDisabled={disabled} onPress={openAddModal}>
                <KuloIcon name="add" size={16} />{t("添加", "Add")}
              </Button>
            </div>
          )}
        >
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
                    const isComposio = connection.mcpPresetId === "composio";
                    const status = mcpConnectionStatus(connection);
                    const needsOAuth = connection.mcpTransport === "http" && connection.mcpAuthMode === "oauth" && (!connection.mcpOAuthAuthorized || connection.status === "error");
                    const subtitle = isComposio
                      ? (connection.mcpAllowedToolkits?.length ? connection.mcpAllowedToolkits.join(", ") : "composio.dev")
                      : connection.mcpServerName && connection.mcpServerName !== connection.name
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
                          {isComposio && (
                            <Button
                              size="sm"
                              variant="secondary"
                              aria-label={t(`管理${connection.name}应用`, `Manage ${connection.name} apps`)}
                              isDisabled={disabled || unavailable}
                              onPress={() => {
                                setActionError(null);
                                captureFocus();
                                setComposioAppsTarget(connection);
                              }}
                            >
                              {t("管理应用", "Apps")}
                            </Button>
                          )}
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
                            isDisabled={disabled || (connection.mcpTransport === "stdio" && !(snapshot.canManageHub ?? snapshot.localHost))}
                            onPress={() => {
                              if (isComposio) {
                                setActionError(null);
                                captureFocus();
                                setComposioConfigTarget({ mode: "edit", connection });
                              } else {
                                void prepare({ connectionId: connection.id });
                              }
                            }}
                          >
                            {t("编辑", "Edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t(`取消连接${connection.name}`, `Disconnect ${connection.name}`)}
                            isDisabled={!connected || busy !== null}
                            onPress={() => openRemove({ id: connection.id, name: connection.name, category: "app", isComposio })}
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
            onOpenHomeAssistant={() => {
              captureFocus();
              setHaModalOpen(true);
            }}
          />
        )}
        </div>
      </Tabs.Panel>
      <Tabs.Panel id="credential" shouldForceMount className="data-[inert=true]:hidden">
        <ConnectionGroup
          title={t("凭据", "Credentials")}
          action={(
            <Dropdown>
              <Button size="sm" variant="secondary" aria-label={t("添加凭据", "Add credentials")} isPending={preparing} isDisabled={disabled}>
                <KuloIcon name="add" size={16} />
                {t("添加", "Add")}
              </Button>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  aria-label={t("选择凭据类型", "Select credential type")}
                  onAction={(key) => {
                    const kind = String(key);
                    if (kind === "ssh" || kind === "account" || kind === "api-key" || kind === "custom") {
                      setActionError(null);
                      captureFocus();
                      setCredentialModal({ mode: "create", initialKind: kind });
                    }
                  }}
                >
                  {sshSupported && <Dropdown.Item id="ssh" textValue={t("SSH 服务器", "SSH server")}><Label>{t("SSH 服务器", "SSH server")}</Label></Dropdown.Item>}
                  <Dropdown.Item id="account" textValue={t("账号", "Account")}><Label>{t("账号", "Account")}</Label></Dropdown.Item>
                  <Dropdown.Item id="api-key" textValue="API Key"><Label>API Key</Label></Dropdown.Item>
                  <Dropdown.Item id="custom" textValue={t("自定义凭据", "Custom credentials")}><Label>{t("自定义凭据", "Custom credentials")}</Label></Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          )}
        >
          {renderRecords("credential")}
        </ConnectionGroup>
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
        localHost={Boolean(snapshot.canManageHub ?? snapshot.localHost)}
        initialStdioPrefill={stdioPrefill}
        onSelectApplication={(application) => {
          void prepare({ category: "app", appId: application.id, ...(application.connectionId ? { connectionId: application.connectionId } : {}) });
        }}
        onSavedMcp={() => onRefresh()}
        onStartOAuth={(connection) => {
          setOauthTarget({ connection, forceReauth: false });
        }}
        onSelectComposio={() => {
          setComposioConfigTarget({ mode: "create" });
        }}
        onClose={() => {
          setAddOpen(false);
          setStdioPrefill(null);
          restoreFocus();
        }}
      />
    )}
    {migrationOpen && snapshot && (
      <MigrationImportModal
        open={migrationOpen}
        connected={connected}
        localHost={Boolean(snapshot.localHost)}
        initialSection="mcp"
        onImported={() => onRefresh()}
        onPrefillStdio={(prefill) => {
          setMigrationOpen(false);
          setStdioPrefill(prefill);
          setAddOpen(true);
        }}
        onClose={() => {
          setMigrationOpen(false);
          restoreFocus();
        }}
      />
    )}
    {composioConfigTarget && snapshot && (
      <ComposioConfigModal
        open={composioConfigTarget !== null}
        existing={composioConfigTarget.mode === "edit" ? composioConfigTarget.connection : null}
        connected={connected}
        vaultAvailable={snapshot.vault.available}
        onSaved={(saved, isNew) => {
          setComposioConfigTarget(null);
          onRefresh();
          if (isNew) setComposioAppsTarget(saved);
          else restoreFocus();
        }}
        onClose={() => {
          setComposioConfigTarget(null);
          restoreFocus();
        }}
      />
    )}
    {composioAppsTarget && (
      <ComposioAppsModal
        open={composioAppsTarget !== null}
        connection={composioAppsTarget}
        connected={connected}
        onClose={() => {
          setComposioAppsTarget(null);
          onRefresh();
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
        hostedAggregator={Boolean(snapshot?.mcpPresets?.find((preset) => preset.id === oauthTarget.connection.mcpPresetId)?.hostedAggregator)}
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
        localHost={Boolean(assistant.canManageHub ?? assistant.localHost ?? snapshot?.canManageHub ?? snapshot?.localHost)}
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
    {sshFollowupTarget && snapshot && (
      <SshFollowupModal
        open
        connection={sshFollowupTarget}
        connected={connected}
        available={snapshot.vault.available}
        localHost={snapshot.localHost}
        onChanged={onRefresh}
        onClose={() => { setSshFollowupTarget(null); onRefresh(); restoreFocus(); }}
      />
    )}
    {credentialModal && snapshot && (
      <CredentialConfigModal
        open
        mode={credentialModal.mode}
        initialKind={credentialModal.mode === "create" ? credentialModal.initialKind : undefined}
        existing={credentialModal.mode === "edit" ? credentialModal.connection : undefined}
        connected={connected}
        available={snapshot.vault.available}
        localHost={snapshot.localHost}
        sshSupported={sshSupported}
        onSaved={() => onRefresh()}
        onClose={() => { setCredentialModal(null); onRefresh(); restoreFocus(); }}
      />
    )}
    {remove && <ConfirmDialog open title={remove.category === "app" ? t(`取消与「${remove.name}」的连接？`, `Disconnect from “${remove.name}”?`) : t(`移除「${remove.name}」？`, `Remove “${remove.name}”?`)} description={<div className="space-y-2"><p>{remove.category === "information" ? t("将移除本地保存的信息。", "Locally saved information will be removed.") : remove.isComposio ? t("将清除本地授权记录与 API Key，并撤销任务使用权限；已在 Composio 云端授权的第三方应用请先在「管理应用」中断开。", "Local records and API Key will be deleted, and task access will be revoked. Disconnect cloud app authorizations in Manage apps if no longer needed.") : t("将清除本地授权记录和凭据，并撤销任务使用权限。", "Local access records and credentials will be deleted, and task access will be revoked.")}</p>{actionError && <p role="alert" className="text-danger">{actionError}</p>}</div>} confirmLabel={remove.category === "app" ? t("取消连接", "Disconnect") : t("移除", "Remove")} isPending={busy !== null} onConfirm={() => void disconnect()} onCancel={() => { setRemove(null); restoreFocus(); }} />}
  </section>;
}
