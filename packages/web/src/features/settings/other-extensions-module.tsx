import { useI18n, translate, type KuloLanguage } from "../../kulo-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Input, Label, Modal, Spinner, Switch, Table, TextField } from "@heroui/react";
import { redactSecrets, type ExtensionRecord, type ExtensionStatus, type ExtensionWorkspaceSnapshot, type SettingsAssistantContext } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { ConfirmDialog } from "../../components/confirm-dialog";

const TRANSITIONAL = new Set<ExtensionStatus>(["installing", "starting", "stopping", "removing"]);
type Target = NonNullable<SettingsAssistantContext["target"]>;
type PageOperation = "install" | "enable" | "stop" | "remove";

const BUILTIN_EXTENSION_NAMES: Readonly<Record<string, Readonly<Record<KuloLanguage, string>>>> = {
  "billion-context": {
    "zh-CN": "Billion Context 上下文压缩",
    en: "Billion Context Compaction",
  },
};

const BUILTIN_EXTENSION_STAGES: Readonly<Record<string, Readonly<Record<KuloLanguage, string>>>> = {
  "等待执行": { "zh-CN": "等待执行", en: "Waiting to run" },
  "安装并验证上下文压缩内核": { "zh-CN": "安装并验证上下文压缩内核", en: "Installing and verifying compaction kernel" },
  "接入主会话压缩": { "zh-CN": "接入主会话压缩", en: "Connecting compaction to main chat" },
  "保存上下文并停止扩展": { "zh-CN": "保存上下文并停止扩展", en: "Saving context and stopping extension" },
  "删除受管程序并保留会话历史": { "zh-CN": "删除受管程序并保留会话历史", en: "Removing managed package while preserving history" },
  "已完成": { "zh-CN": "已完成", en: "Completed" },
  "未完成": { "zh-CN": "未完成", en: "Failed" },
  "已取消": { "zh-CN": "已取消", en: "Cancelled" },
};

export function extensionDisplayName(
  extension: Pick<ExtensionRecord, "id" | "name">,
  language?: KuloLanguage,
): string {
  const builtin = BUILTIN_EXTENSION_NAMES[extension.id];
  if (builtin && (extension.name === builtin["zh-CN"] || extension.name === builtin.en)) {
    return language ? builtin[language] : translate(builtin["zh-CN"], builtin.en);
  }
  return extension.name;
}

export function extensionJobStageLabel(
  stage: string,
  language?: KuloLanguage,
): string {
  const localized = BUILTIN_EXTENSION_STAGES[stage];
  if (!localized) return redactSecrets(stage);
  return language ? localized[language] : translate(localized["zh-CN"], localized.en);
}

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
  const { t, language } = useI18n();
  const STATUS_LABELS: Record<ExtensionStatus, string> = {
    not_installed: t("未安装", "Not installed"), installing: t("安装中", "Installing"), stopped: t("已停止", "Stopped"), starting: t("启动中", "Starting"),
    running: t("运行中", "Running"), stopping: t("停止中", "Stopping"), removing: t("删除中", "Deleting"), error: t("异常", "Error"),
  };
  const [snapshot, setSnapshot] = useState(incoming);
  const [loading, setLoading] = useState(!incoming);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [remove, setRemove] = useState<ExtensionRecord>();
  const [addOpen, setAddOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const mounted = useRef(true);
  const addButton = useRef<HTMLButtonElement>(null);
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
      const next = await kuloRest.getExtensions();
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
      const next = await kuloRest.manageExtension(extension.id, {
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

  const closeAdd = () => {
    setAddOpen(false);
    setProjectUrl("");
    requestAnimationFrame(() => addButton.current?.focus());
  };

  const submitAdd = () => {
    const url = projectUrl.trim();
    if (!url || !connected || disabled || Boolean(busy)) return;
    setAddOpen(false);
    setProjectUrl("");
    onRequest(undefined, t(`评估这个项目能否接入 Kulo：${url}`, `Evaluate whether this project can be integrated into Kulo: ${url}`));
  };

  return <section className="flex min-w-0 flex-col gap-4" aria-label={t("其他扩展", "Other extensions")}>
    <div className="kulo-settings-section-head">
      <h2 className="kulo-section-title">{t("其他扩展", "Other extensions")}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={addButton} size="sm" variant="secondary" isDisabled={!connected || disabled || Boolean(busy)} onPress={() => setAddOpen(true)}>{t("添加扩展", "Add extension")}</Button>
      </div>
    </div>
    {error && <Alert status="danger" role="alert">
      <Alert.Content><Alert.Title>{t("操作未完成", "Action failed")}</Alert.Title><Alert.Description>{error}</Alert.Description></Alert.Content>
      <Button size="sm" variant="secondary" isDisabled={!connected || loading || Boolean(busy)} onPress={() => void refresh()}>{t("刷新", "Refresh")}</Button>
    </Alert>}
    {loading && !snapshot && <div className="flex items-center gap-2 text-sm text-muted" role="status"><Spinner size="sm" />{t("加载扩展…", "Loading extensions…")}</div>}
    {snapshot && <Table variant="secondary" className="kulo-settings-table kulo-capabilities-table">
      <Table.ScrollContainer className="kulo-settings-table-scroll">
        <Table.Content aria-label={t("其他扩展列表", "Other extensions")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content kulo-settings-table-content--wide">
          <Table.Header>
            <Table.Column id="name" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{t("名称", "Name")}</Table.Column>
            <Table.Column id="version" className="kulo-settings-table-column kulo-settings-table-meta">{t("版本", "Version")}</Table.Column>
            <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
            <Table.Column id="enabled" className="kulo-settings-table-column kulo-settings-table-toggle">{t("启用", "Enable")}</Table.Column>
            <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
          </Table.Header>
          <Table.Body renderEmptyState={() => <div className="kulo-table-empty-state">{t("尚无扩展", "No extensions")}</div>}>
            {snapshot.items.map((extension) => {
              const displayName = extensionDisplayName(extension, language);
              const installed = Boolean(extension.installedVersion);
              const transitioning = TRANSITIONAL.has(extension.status);
              const blocked = !connected || disabled || Boolean(busy) || transitioning;
              const job = [...snapshot.jobs].reverse().find((item) => item.extensionId === extension.id && (item.status === "queued" || item.status === "running"));
              const selected = target?.kind === "extension" && target.id === extension.id;
              return <Table.Row key={extension.id} id={extension.id} textValue={displayName}>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                  <div className="kulo-settings-table-stack">
                    <span className="kulo-item-title">{displayName}</span>
                    {extension.error && <span className="break-words text-xs text-danger">{redactSecrets(extension.error)}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta"><span className="text-sm">{extensionVersionLabel(extension)}</span></Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                  <div className="kulo-settings-table-stack">
                    <Chip size="sm" variant="soft" color={extension.status === "running" ? "success" : extension.status === "error" ? "danger" : "default"}>
                      {STATUS_LABELS[extension.status]}
                    </Chip>
                    {job && <span className="flex items-center gap-1.5 whitespace-normal break-words text-xs text-muted" role="status"><Spinner size="sm" aria-label={t(`${displayName}${STATUS_LABELS[extension.status]}`, `${displayName}: ${STATUS_LABELS[extension.status]}`)} />{extensionJobStageLabel(job.stage, language)}</span>}
                  </div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-toggle">
                  <div className="kulo-settings-table-toggle-group">
                    <Switch size="sm" isSelected={extension.enabled} isDisabled={blocked || !installed} onChange={(enabled) => void operate(extension, enabled ? "enable" : "stop")}>
                      <Switch.Content><Label className="sr-only">{t(`启用${displayName}`, `Enable ${displayName}`)}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
                    </Switch>
                  </div>
                </Table.Cell>
                <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                  <div className="kulo-settings-table-action-group">
                    {!installed && <Button size="sm" variant="ghost" aria-label={t(`安装${displayName}`, `Install ${displayName}`)} isDisabled={blocked} isPending={busy === `install:${extension.id}`} onPress={() => void operate(extension, "install")}>{t("安装", "Install")}</Button>}
                    <Button ref={(node) => { if (node) manageButtons.current.set(extension.id, node); else manageButtons.current.delete(extension.id); }} size="sm" variant="ghost" aria-label={t(`管理${displayName}`, `Manage ${displayName}`)} aria-pressed={selected} isDisabled={!connected || disabled} onPress={() => onRequest({ kind: "extension", id: extension.id })}>{t("管理", "Manage")}</Button>
                    {extension.enabled && <Button size="sm" variant="ghost" aria-label={t(`停止${displayName}`, `Stop ${displayName}`)} isDisabled={blocked} isPending={busy === `stop:${extension.id}`} onPress={() => void operate(extension, "stop")}>{t("停止", "Stop")}</Button>}
                    {(installed || extension.status === "error") && <Button ref={(node) => { if (node) removeButtons.current.set(extension.id, node); else removeButtons.current.delete(extension.id); }} size="sm" variant="ghost" aria-label={t(`删除${displayName}`, `Delete ${displayName}`)} isDisabled={blocked} onPress={() => setRemove(extension)}>{t("删除", "Delete")}</Button>}
                  </div>
                </Table.Cell>
              </Table.Row>;
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>}
    <Modal isOpen={addOpen} onOpenChange={(open) => { if (!open) closeAdd(); }}>
      <Modal.Backdrop isOpen={addOpen} onOpenChange={(open) => { if (!open) closeAdd(); }}>
        <Modal.Container size="sm" placement="center" scroll="inside">
          <Modal.Dialog aria-label={t("添加扩展", "Add extension")}>
            <form className="contents" onSubmit={(event) => { event.preventDefault(); submitAdd(); }}>
              <Modal.Header>
                <Modal.Heading>{t("添加扩展", "Add extension")}</Modal.Heading>
                <Modal.CloseTrigger aria-label={t("关闭", "Close")} />
              </Modal.Header>
              <Modal.Body className="flex min-w-0 flex-col gap-4">
                <TextField className="kulo-form-field" variant="secondary" fullWidth isRequired value={projectUrl} onChange={setProjectUrl} isDisabled={!connected || disabled}>
                  <Label>{t("项目链接", "Project URL")}</Label>
                  <Input type="url" autoFocus spellCheck={false} placeholder="https://github.com/..." />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" onPress={closeAdd}>{t("取消", "Cancel")}</Button>
                <Button type="submit" variant="primary" isDisabled={!connected || disabled || !projectUrl.trim()}>{t("评估接入", "Evaluate")}</Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
    <ConfirmDialog open={Boolean(remove)} title={t(`删除${remove ? extensionDisplayName(remove, language) : "扩展"}？`, `Delete ${remove ? extensionDisplayName(remove, language) : "Extension"}?`)} description={t("保留主对话和历史记录。", "The main conversation and history will be kept.")} confirmLabel={t("删除", "Delete")} isPending={Boolean(busy)} onCancel={cancelRemove} onConfirm={() => { if (remove) void operate(remove, "remove"); }} />
  </section>;
}
