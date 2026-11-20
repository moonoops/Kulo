import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Chip, Dropdown, Label, Spinner, Table, Tabs } from "@heroui/react";
import { redactSensitiveText, type ConnectionApplicationView, type ConnectionCategory, type ConnectionPrepareRequest, type ConnectionRecordView, type ConnectionWorkspaceSnapshot } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { KuloIcon } from "../../kulo-icon";
import { kuloRest } from "../../kulo-api";
import { ConnectionIcon } from "./connection-icon";
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

export function connectionAddress(connection: ConnectionRecordView): string {
  if (connection.kind === "ssh") return connection.host ? `${connection.host}${connection.port && connection.port !== 22 ? `:${connection.port}` : ""}` : "";
  if (connection.kind === "custom" || connection.category === "information") return "";
  let site = connection.url ?? "";
  if (site) { try { site = new URL(site).host; } catch { /* Preserve incomplete metadata for editing. */ } }
  return connection.username || site;
}

export function connectionCategory(connection: ConnectionRecordView): ConnectionCategory {
  return connection.category ?? (connection.kind === "app" ? "app" : "credential");
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

export function ConnectionsModule({ snapshot, loading, error, connected, preparing = false, onPrepare, onRefresh, entryIntent, onIntentHandled }: {
  snapshot: ConnectionWorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  preparing?: boolean;
  onPrepare: ConnectionPrepare;
  onRefresh: () => void;
  entryIntent?: SettingsAssistantEntryIntent | null;
  onIntentHandled?: (id: string) => void;
}) {
  useI18n();
  const [view, setView] = useState<ConnectionCategory>("app");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  const openRemove = (item: { id: string; name: string; category: ConnectionCategory }) => {
    setActionError(null);
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRemove(item);
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
  const unavailable = Boolean(snapshot && !snapshot.vault.available);
  const disabled = !connected || preparing || busy !== null;
  const applications = snapshot?.applications ?? [];
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
        <ConnectionGroup title={t("应用", "Apps")} action={<Dropdown><Button size="sm" variant="secondary" aria-label={t("添加应用", "Add app")} isDisabled={disabled || !applications.length}><KuloIcon name="add" size={16} />{t("添加", "Add")}</Button><Dropdown.Popover placement="bottom end"><Dropdown.Menu aria-label={t("选择应用", "Choose an app")} onAction={(key) => { const application = applications.find((item) => item.id === key); if (application) void prepare({ category: "app", appId: application.id, ...(application.connectionId ? { connectionId: application.connectionId } : {}) }); }}>{applications.map((application) => <Dropdown.Item key={application.id} id={application.id} textValue={application.name} isDisabled={application.status === "unavailable"}><Label>{application.name}</Label></Dropdown.Item>)}</Dropdown.Menu></Dropdown.Popover></Dropdown>}>
          <Table variant="secondary" className="kulo-settings-table">
            <Table.ScrollContainer className="kulo-settings-table-scroll">
              <Table.Content aria-label={t("应用列表", "Apps")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
                <Table.Header>
                  <Table.Column id="name" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{t("应用", "Apps")}</Table.Column>
                  <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
                  <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
                </Table.Header>
                <Table.Body items={applications} renderEmptyState={() => <div className="kulo-table-empty-state">{t("暂无可连接应用", "No apps available")}</div>}>
                  {(application) => {
                    const isConnected = application.status === "connected";
                    const actionLabel = isConnected ? t("取消连接", "Disconnect") : application.status === "needs_attention" ? t("重新连接", "Reconnect") : t("连接", "Connect");
                    return <Table.Row id={application.id} textValue={application.name}>
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
                  }}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </ConnectionGroup>
      </Tabs.Panel>
      <Tabs.Panel id="credential" shouldForceMount className="data-[inert=true]:hidden">
        <ConnectionGroup title={t("凭据", "Credentials")} action={<Button size="sm" variant="secondary" aria-label={t("添加凭据", "Add credentials")} isPending={preparing} isDisabled={disabled} onPress={() => void prepare({ category: "credential", kind: "account" })}><KuloIcon name="add" size={16} />{t("添加", "Add")}</Button>}>{renderRecords("credential")}</ConnectionGroup>
      </Tabs.Panel>
      <Tabs.Panel id="information" shouldForceMount className="data-[inert=true]:hidden">
        <ConnectionGroup title={t("其他", "Other")} action={<Button size="sm" variant="secondary" aria-label={t("记住其他信息", "Save other information")} isDisabled={disabled} onPress={() => void prepare({ category: "information", kind: "custom" })}><KuloIcon name="add" size={16} />{t("添加", "Add")}</Button>}>{renderRecords("information")}</ConnectionGroup>
      </Tabs.Panel>
    </Tabs>}
    {remove && <ConfirmDialog open title={remove.category === "app" ? t(`取消与「${remove.name}」的连接？`, `Disconnect from “${remove.name}”?`) : t(`移除「${remove.name}」？`, `Remove “${remove.name}”?`)} description={<div className="space-y-2"><p>{remove.category === "information" ? t("将移除本地保存的信息。", "Locally saved information will be removed.") : t("将清除本地授权记录和凭据，并撤销任务使用权限。", "Local access records and credentials will be deleted, and task access will be revoked.")}</p>{actionError && <p role="alert" className="text-danger">{actionError}</p>}</div>} confirmLabel={remove.category === "app" ? t("取消连接", "Disconnect") : t("移除", "Remove")} isPending={busy !== null} onConfirm={() => void disconnect()} onCancel={() => { setRemove(null); restoreFocus(); }} />}
  </section>;
}
