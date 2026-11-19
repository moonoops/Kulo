import { useRef, useState } from "react";
import { Alert, Button, Chip, Dropdown, Skeleton, Table } from "@heroui/react";
import { type CapabilitiesWorkspaceSnapshot, type CapabilityRecord, type SettingsAssistantContext } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { useI18n } from "../../moco-i18n";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { imageActionError, imageCommandId } from "./image-provider-picker";
import { ADD_IMAGE_PROMPT } from "./capability-views";
import { SettingsSection } from "./settings-layout";

export function ImageCapabilitiesPanel({ workspace, clientId, connected, disabled = false, loading, error, target, onRequest, onRefresh, onOpenModels }: {
  workspace: CapabilitiesWorkspaceSnapshot | null;
  clientId: string;
  connected: boolean;
  disabled?: boolean;
  loading: boolean;
  error: string | null;
  target?: SettingsAssistantContext["target"];
  onRequest: (target?: NonNullable<SettingsAssistantContext["target"]>, prompt?: string) => void;
  onRefresh: () => void;
  onOpenModels?: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [confirm, setConfirm] = useState<{ kind: "test" | "remove"; capability: CapabilityRecord }>();
  const actionLock = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const manageButtons = useRef(new Map<string, HTMLButtonElement>());
  const blocked = !connected || disabled || Boolean(busy);
  const accept = () => { setActionError(undefined); onRefresh(); };
  const execute = async (operation: string, action: () => Promise<unknown>) => {
    if (blocked || actionLock.current) return;
    actionLock.current = true; setBusy(operation); setActionError(undefined);
    try { await action(); accept(); }
    catch (cause) { setActionError(imageActionError(cause)); }
    finally { actionLock.current = false; setBusy(undefined); }
  };
  const confirmOperation = async () => {
    if (!confirm) return;
    const chosen = confirm;
    await execute(`${chosen.kind}:${chosen.capability.id}`, async () => {
      if (chosen.kind === "remove") await mocoRest.deleteImageCapability(chosen.capability.id, chosen.capability.revision, imageCommandId("remove"));
      else await mocoRest.testImageCapability(chosen.capability.id, { clientId, commandId: imageCommandId("test") });
      setConfirm(undefined); requestAnimationFrame(() => (manageButtons.current.get(chosen.capability.id) ?? addButton.current)?.focus());
    });
  };
  const records = workspace?.capabilities.filter((capability) => capability.kind === "image") ?? [];
  const statusLabel = (capability: CapabilityRecord) => !capability.enabled ? t("已停用", "Disabled") : capability.status === "needs_auth" ? t("待连接", "Not connected") : capability.status === "error" ? t("连接异常", "Connection error") : !capability.allowTaskGeneration ? t("待授权", "Awaiting approval") : capability.lastGeneratedAt ? t("生图已验证", "Generation verified") : capability.status === "ready" ? t("连接已验证", "Connection verified") : t("待验证", "Unverified");
  return <div className="flex min-w-0 flex-col gap-6">
    <SettingsSection title={t("图像模型", "Image models")} action={<div className="flex items-center gap-2">{onOpenModels && <Button variant="ghost" size="sm" isDisabled={blocked} onPress={onOpenModels}>{t("模型设置", "Model settings")}</Button>}<Button ref={addButton} variant="secondary" size="sm" isDisabled={blocked} onPress={() => onRequest(undefined, ADD_IMAGE_PROMPT)}>{t("添加图像模型", "Add image model")}</Button></div>}>
      {actionError && <Alert status="danger"><Alert.Content><Alert.Description>{actionError}</Alert.Description></Alert.Content></Alert>}
      <Table variant="secondary" className="moco-settings-table moco-capabilities-table"><Table.ScrollContainer className="moco-settings-table-scroll"><Table.Content aria-label={t("图像模型列表", "Image models")} selectionMode="none" keyboardNavigationBehavior="tab" className="moco-settings-table-content">
        <Table.Header><Table.Column id="model" isRowHeader className="moco-settings-table-column">{t("模型", "Model")}</Table.Column><Table.Column id="connection" className="moco-settings-table-column">{t("服务连接", "Connection")}</Table.Column><Table.Column id="capabilities" className="moco-settings-table-column">{t("能力", "Capabilities")}</Table.Column><Table.Column id="status" className="moco-settings-table-column whitespace-nowrap">{t("状态", "Status")}</Table.Column><Table.Column id="actions" className="moco-settings-table-column moco-settings-table-actions">{t("操作", "Actions")}</Table.Column></Table.Header>
        <Table.Body renderEmptyState={() => <div className="moco-table-empty-state">{workspace ? t("尚未添加图像模型", "No image models added") : error || !connected ? t("暂时无法读取", "Unable to load") : loading ? <span role="status" aria-label={t("加载中", "Loading")} className="flex gap-4"><Skeleton animationType="none" className="h-3 w-32" /><Skeleton animationType="none" className="h-3 w-16" /></span> : t("等待连接", "Waiting for connection")}</div>}>
          {records.map((capability) => {
            const connection = workspace?.connections.find((item) => item.id === capability.connectionId);
            const selected = target?.kind === "capability" && target.id === capability.id;
            return <Table.Row key={capability.id} id={capability.id} textValue={capability.name}><Table.Cell className="moco-settings-table-cell"><div className="flex min-w-0 flex-col items-start gap-1"><div className="flex flex-wrap items-center gap-2"><span className="moco-item-title break-words">{capability.name}</span>{capability.isDefault && <Chip size="sm" variant="soft" color="accent">{t("默认", "Default")}</Chip>}</div><span className="moco-item-description break-words">{capability.modelId}</span>{capability.error && <p role="status" className="break-words text-xs text-danger">{imageActionError(new Error(capability.error))}</p>}</div></Table.Cell>
              <Table.Cell className="moco-settings-table-cell"><span className="text-sm">{workspace?.imageSetup?.providers.find((provider) => provider.id === connection?.credentialProviderId)?.name ?? connection?.name ?? "—"}</span></Table.Cell>
              <Table.Cell className="moco-settings-table-cell"><div className="flex flex-wrap gap-1"><Chip size="sm" variant="tertiary">{t("生图", "Generate")}</Chip>{capability.supportsEdit && <Chip size="sm" variant="tertiary">{t("编辑", "Edit")}</Chip>}{capability.formats.map((format) => <Chip key={format} size="sm" variant="tertiary">{format.toUpperCase()}</Chip>)}</div></Table.Cell>
              <Table.Cell className="moco-settings-table-cell whitespace-nowrap"><Chip size="sm" variant="soft" className="shrink-0 whitespace-nowrap" color={capability.status === "error" ? "danger" : "default"}>{statusLabel(capability)}</Chip></Table.Cell>
              <Table.Cell className="moco-settings-table-cell moco-settings-table-actions"><div className="moco-settings-table-action-group"><Button ref={(node) => { if (node) manageButtons.current.set(capability.id, node); else manageButtons.current.delete(capability.id); }} variant={selected ? "secondary" : "ghost"} size="sm" aria-label={t(`管理${capability.name}`, `Manage ${capability.name}`)} aria-pressed={selected} isDisabled={blocked} onPress={() => onRequest({ kind: "capability", id: capability.id })}>{t("管理", "Manage")}</Button><Dropdown><Button variant="ghost" size="sm" aria-label={t(`${capability.name}的更多操作`, `More actions for ${capability.name}`)} isDisabled={blocked}>{t("更多", "More")}</Button><Dropdown.Popover><Dropdown.Menu aria-label={t(`${capability.name}的操作`, `Actions for ${capability.name}`)} onAction={(key) => {
                if (key === "check") void execute(`check:${capability.id}`, () => mocoRest.checkImageCapability(capability.id));
                if (key === "test") setConfirm({ kind: "test", capability });
                if (key === "approve") void execute(`approve:${capability.id}`, () => mocoRest.patchImageCapability(capability.id, { allowTaskGeneration: !capability.allowTaskGeneration, expectedRevision: capability.revision, commandId: imageCommandId("approve") }));
                if (key === "default") void execute(`default:${capability.id}`, () => mocoRest.patchImageCapability(capability.id, { isDefault: true, expectedRevision: capability.revision, commandId: imageCommandId("default") }));
                if (key === "toggle") void execute(`toggle:${capability.id}`, () => mocoRest.patchImageCapability(capability.id, { enabled: !capability.enabled, expectedRevision: capability.revision, commandId: imageCommandId("toggle") }));
                if (key === "remove") setConfirm({ kind: "remove", capability });
              }}><Dropdown.Item id="check" textValue={t("测试连接", "Check connection")}>{t("测试连接", "Check connection")}</Dropdown.Item><Dropdown.Item id="test" isDisabled={!capability.enabled} textValue={t("试生成", "Test generation")}>{t("试生成", "Test generation")}</Dropdown.Item><Dropdown.Item id="approve" isDisabled={!capability.enabled} textValue={capability.allowTaskGeneration ? t("取消自动生图", "Revoke task generation") : t("允许任务生图", "Allow task generation")}>{capability.allowTaskGeneration ? t("取消自动生图", "Revoke task generation") : t("允许任务生图", "Allow task generation")}</Dropdown.Item><Dropdown.Item id="default" isDisabled={capability.isDefault || !capability.enabled} textValue={t("设为默认", "Set as default")}>{t("设为默认", "Set as default")}</Dropdown.Item><Dropdown.Item id="toggle" textValue={capability.enabled ? t("停用", "Disable") : t("启用", "Enable")}>{capability.enabled ? t("停用", "Disable") : t("启用", "Enable")}</Dropdown.Item><Dropdown.Item id="remove" variant="danger" textValue={t("移除", "Remove")}>{t("移除", "Remove")}</Dropdown.Item></Dropdown.Menu></Dropdown.Popover></Dropdown></div></Table.Cell>
            </Table.Row>;
          })}
        </Table.Body>
      </Table.Content></Table.ScrollContainer></Table>
    </SettingsSection>
    <ConfirmDialog open={Boolean(confirm)} title={confirm?.kind === "test" ? t("试生成图片？", "Generate a test image?") : t("移除图像模型？", "Remove image model?")} description={confirm?.kind === "test" ? t(`使用「${confirm.capability.name}」的服务生成一次，将消耗该服务的用量。`, `Generate once with “${confirm.capability.name}”. This uses the service’s allowance.`) : confirm?.capability.name} confirmLabel={confirm?.kind === "test" ? t("开始生成", "Generate") : t("移除", "Remove")} status={confirm?.kind === "test" ? "warning" : "danger"} isPending={Boolean(busy)} onCancel={() => setConfirm(undefined)} onConfirm={() => void confirmOperation()} />
  </div>;
}
