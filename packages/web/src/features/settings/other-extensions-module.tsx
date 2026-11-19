import { useI18n, translate } from "../../moco-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Label, Spinner, Switch, Table } from "@heroui/react";
import { redactSecrets, type ExtensionRecord, type ExtensionStatus, type ExtensionWorkspaceSnapshot, type SettingsAssistantContext } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { ConfirmDialog } from "../../components/confirm-dialog";

const TRANSITIONAL = new Set<ExtensionStatus>(["installing", "starting", "stopping", "removing"]);
type Target = NonNullable<SettingsAssistantContext["target"]>;
type PageOperation = "enable" | "stop" | "remove";

export function extensionVersionLabel(extension: ExtensionRecord): string {
  const prefix = extension.packageName ? `${extension.packageName} ` : "";
  return extension.installedVersion
    ? `${prefix}${extension.installedVersion}`
    : extension.availableVersion ? translate(`可安装 ${prefix}${extension.availableVersion}`, `Available: ${prefix}${extension.availableVersion}`) : translate("未安装", "Not installed");
}

export function OtherExtensionsModule({ snapshot: incoming, connected, disabled = false, target, onRequest, onRefresh }: {
  snapshot?: ExtensionWorkspaceSnapshot;
  connected: boolean;
  disabled?: boolean;
  target?: Target;
  onRequest: (target?: Target, prompt?: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const STATUS_LABELS: Record<ExtensionStatus, string> = {
    not_installed: t("未安装", "Not installed"), installing: t("安装中", "Installing"), stopped: t("已停止", "Stopped"), starting: t("启动中", "Starting"),
    running: t("运行中", "Running"), stopping: t("停止中", "Stopping"), removing: t("删除中", "Deleting"), error: t("异常", "Error"),
  };
  const [snapshot, setSnapshot] = useState(incoming);
  const [loading, setLoading] = useState(!incoming);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [remove, setRemove] = useState<ExtensionRecord>();
  const mounted = useRef(true);
  const manageButtons = useRef(new Map<string, HTMLButtonElement>());
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const acceptSnapshot = useCallback((next: ExtensionWorkspaceSnapshot) => {
    setSnapshot((previous) => !previous || next.revision >= previous.revision ? next : previous);
  }, []);
  const refresh = useCallback(async (clearError = true) => {
    if (!connected) return;
    setLoading(true);
    if (clearError) setError(undefined);
    try {
      const next = await mocoRest.getExtensions();
      if (mounted.current) acceptSnapshot(next);
    } catch (cause) {
      if (mounted.current) setError(redactSecrets(cause instanceof Error ? cause.message : translate("读取扩展失败", "Failed to load extensions")));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [acceptSnapshot, connected]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (incoming) { acceptSnapshot(incoming); setLoading(false); } }, [incoming, acceptSnapshot]);
  useEffect(() => { if (!incoming && connected) void refresh(); }, [incoming, connected, refresh]);

  const cancelRemove = () => {
    const id = remove?.id;
    setRemove(undefined);
    if (id) requestAnimationFrame(() => removeButtons.current.get(id)?.focus());
  };

  const operate = async (extension: ExtensionRecord, operation: PageOperation) => {
    if (!connected || disabled || busy || TRANSITIONAL.has(extension.status)) return;
    setBusy(`${operation}:${extension.id}`);
    setError(undefined);
    try {
      const next = await mocoRest.manageExtension(extension.id, {
        operation, expectedRevision: extension.revision,
        commandId: `extension-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      });
      if (mounted.current) {
        acceptSnapshot(next);
        if (operation === "remove") {
          setRemove(undefined);
          requestAnimationFrame(() => manageButtons.current.get(extension.id)?.focus());
        }
        onRefresh();
      }
    } catch (cause) {
      if (mounted.current) {
        setError(redactSecrets(cause instanceof Error ? cause.message : t("扩展操作未完成", "Extension action failed")));
        setRemove(undefined);
        void refresh(false);
        onRefresh();
      }
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };

  return <section className="flex min-w-0 flex-col gap-4" aria-label={t("其他扩展", "Other extensions")}>
    <div className="moco-settings-section-head">
      <h2 className="moco-section-title">{t("其他扩展", "Other extensions")}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" isDisabled={!connected || disabled || Boolean(busy)} onPress={() => onRequest(undefined, "评估一个项目是否能接入 Moco，请先让我提供项目链接。")}>{t("添加扩展", "Add extension")}</Button>
      </div>
    </div>
    {error && <Alert status="danger" role="alert">
      <Alert.Content><Alert.Title>{t("操作未完成", "Action failed")}</Alert.Title><Alert.Description>{error}</Alert.Description></Alert.Content>
      <Button size="sm" variant="secondary" isDisabled={!connected || loading || Boolean(busy)} onPress={() => void refresh()}>{t("刷新", "Refresh")}</Button>
    </Alert>}
    {loading && !snapshot && <div className="flex items-center gap-2 text-sm text-muted" role="status"><Spinner size="sm" />{t("加载扩展…", "Loading extensions…")}</div>}
    {snapshot && <Table variant="secondary" className="moco-settings-table moco-capabilities-table">
      <Table.ScrollContainer className="moco-settings-table-scroll">
        <Table.Content aria-label={t("其他扩展列表", "Other extensions")} selectionMode="none" keyboardNavigationBehavior="tab" className="moco-settings-table-content">
          <Table.Header>
            <Table.Column id="name" isRowHeader className="moco-settings-table-column">{t("名称", "Name")}</Table.Column>
            <Table.Column id="version" className="moco-settings-table-column moco-settings-table-meta">{t("版本", "Version")}</Table.Column>
            <Table.Column id="status" className="moco-settings-table-column moco-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="enabled" className="moco-settings-table-column moco-settings-table-toggle">{t("启用", "Enable")}</Table.Column>
            <Table.Column id="actions" className="moco-settings-table-column moco-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body renderEmptyState={() => <div className="moco-table-empty-state">{t("尚无扩展", "No extensions")}</div>}>
            {snapshot.items.map((extension) => {
              const installed = Boolean(extension.installedVersion);
              const transitioning = TRANSITIONAL.has(extension.status);
              const blocked = !connected || disabled || Boolean(busy) || transitioning;
              const job = [...snapshot.jobs].reverse().find((item) => item.extensionId === extension.id && (item.status === "queued" || item.status === "running"));
              const selected = target?.kind === "extension" && target.id === extension.id;
              return <Table.Row key={extension.id} id={extension.id} textValue={extension.name}>
                <Table.Cell className="moco-settings-table-cell">
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <span className="moco-item-title break-words">{extension.name}</span>
                    {extension.error && <span className="break-words text-xs text-danger">{redactSecrets(extension.error)}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-meta"><span className="text-sm">{extensionVersionLabel(extension)}</span></Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-meta">
                  <div className="flex flex-col items-start gap-1.5">
                    <Chip size="sm" variant="soft" color={extension.status === "running" ? "success" : extension.status === "error" ? "danger" : "default"}>
                      {STATUS_LABELS[extension.status]}
                    </Chip>
                    {job && <span className="flex items-center gap-1.5 text-xs text-muted" role="status"><Spinner size="sm" aria-label={`${extension.name}${STATUS_LABELS[extension.status]}`} />{redactSecrets(job.stage)}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-toggle">
                  <div className="moco-settings-table-toggle-group">
                    <Switch size="sm" isSelected={extension.enabled} isDisabled={blocked || !installed} onChange={(enabled) => void operate(extension, enabled ? "enable" : "stop")}>
                      <Switch.Content><Label className="sr-only">{t("启用", "Enable")}{extension.name}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
                    </Switch>
                  </div>
                </Table.Cell>
                <Table.Cell className="moco-settings-table-cell moco-settings-table-actions">
                  <div className="moco-settings-table-action-group">
                    {!installed && <Button size="sm" variant="ghost" aria-label={t(`安装${extension.name}`, `Install ${extension.name}`)} isDisabled={blocked} onPress={() => onRequest({ kind: "extension", id: extension.id }, `安装${extension.name}，安装完成后保持关闭。`)}>{t("安装", "Install")}</Button>}
                    <Button ref={(node) => { if (node) manageButtons.current.set(extension.id, node); else manageButtons.current.delete(extension.id); }} size="sm" variant="ghost" aria-label={t(`管理${extension.name}`, `Manage ${extension.name}`)} aria-pressed={selected} isDisabled={!connected || disabled} onPress={() => onRequest({ kind: "extension", id: extension.id })}>{t("管理", "Manage")}</Button>
                    {extension.enabled && <Button size="sm" variant="ghost" aria-label={t(`停止${extension.name}`, `Stop ${extension.name}`)} isDisabled={blocked} isPending={busy === `stop:${extension.id}`} onPress={() => void operate(extension, "stop")}>{t("停止", "Stop")}</Button>}
                    {(installed || extension.status === "error") && <Button ref={(node) => { if (node) removeButtons.current.set(extension.id, node); else removeButtons.current.delete(extension.id); }} size="sm" variant="ghost" aria-label={t(`删除${extension.name}`, `Delete ${extension.name}`)} isDisabled={blocked} onPress={() => setRemove(extension)}>{t("删除", "Delete")}</Button>}
                  </div>
                </Table.Cell>
              </Table.Row>;
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>}
    <ConfirmDialog open={Boolean(remove)} title={t(`删除${remove?.name ?? t("扩展", "Extension")}？`, `Delete ${remove?.name ?? t("扩展", "Extension")}?`)} description={t("保留主对话和历史记录。", "The main conversation and history will be kept.")} confirmLabel={t("删除", "Delete")} isPending={Boolean(busy)} onCancel={cancelRemove} onConfirm={() => { if (remove) void operate(remove, "remove"); }} />
  </section>;
}
