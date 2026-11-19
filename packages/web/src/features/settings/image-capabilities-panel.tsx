import { useRef, useState } from "react";
import { Alert, Button, Chip, Dropdown, Label, Modal, Skeleton, Spinner, Table, TextArea, TextField } from "@heroui/react";
import { DEFAULT_IMAGE_TEST_PROMPT, redactSensitiveText, type CapabilitiesWorkspaceSnapshot, type CapabilityRecord, type MediaJob, type SettingsAssistantContext } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { useI18n } from "../../moco-i18n";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { AttachmentLightbox, type PreviewableImage } from "../../moco-composer";
import { MediaMessage } from "../chat/media-message";
import { imageActionError, imageCommandId } from "./image-provider-picker";
import { ADD_IMAGE_PROMPT, IMAGE_ROUTING_PROMPT, capabilityStatusColor, capabilityStatusLabel } from "./capability-views";
import { SettingsList, SettingsSection } from "./settings-layout";

const ACTIVE_TEST_STATUSES = new Set<MediaJob["status"]>(["queued", "submitting", "running", "collecting"]);

export function ImageTestModal({
  capability,
  prompt,
  onPromptChange,
  job,
  error,
  submitting,
  disabled,
  onSubmit,
  onClose,
  onPreviewImage,
}: {
  capability?: CapabilityRecord;
  prompt: string;
  onPromptChange: (value: string) => void;
  job?: MediaJob;
  error?: string;
  submitting: boolean;
  disabled: boolean;
  onSubmit: () => void;
  onClose: () => void;
  onPreviewImage: (image: PreviewableImage) => void;
}) {
  const { t } = useI18n();
  const running = Boolean(job && ACTIVE_TEST_STATUSES.has(job.status));
  const statusText = (status: MediaJob["status"]) =>
    status === "completed" ? t("生成完成", "Generation completed")
      : status === "failed" ? t("生成失败", "Generation failed")
        : status === "needs_reconciliation" ? t("提交结果待核实", "Submission requires verification")
          : status === "needs_user" ? t("需要处理", "Needs attention")
            : status === "stopped" ? t("已停止", "Stopped")
              : status === "collecting" ? t("正在保存图片", "Saving images")
                : t("生成中", "Generating");
  return <Modal isOpen={Boolean(capability)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Backdrop isOpen={Boolean(capability)} isDismissable={!submitting} isKeyboardDismissDisabled={submitting} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Container size="md" placement="center" scroll="inside">
        <Modal.Dialog aria-label={capability ? t(`试生成 · ${capability.name}`, `Test · ${capability.name}`) : t("试生成", "Test generation")}>
          {capability && <form className="contents" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
            <Modal.Header>
              <Modal.Heading>{t(`试生成 · ${capability.name}`, `Test · ${capability.name}`)}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭", "Close")} isDisabled={submitting} />
            </Modal.Header>
            <Modal.Body className="moco-form-stack">
              <TextField className="moco-form-field" variant="secondary" fullWidth value={prompt} onChange={onPromptChange} isDisabled={submitting || running}>
                <Label>{t("提示词", "Prompt")}</Label>
                <TextArea className="scrollbar min-h-24" rows={3} />
              </TextField>
              {error && <Alert status="danger" role="alert"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>}
              {job && <div className="flex min-w-0 flex-col gap-3" aria-label={t("图像测试结果", "Image test result")}>
                <div className="flex items-center gap-2 text-sm" role="status">
                  {running && <Spinner size="sm" aria-label={t("生成中", "Generating")} />}
                  <span>{statusText(job.status)}</span>
                </div>
                {job.error && <p className="break-words text-xs text-danger" role="alert">{redactSensitiveText(job.error)}</p>}
                {job.assets.map((asset) => <MediaMessage key={asset.id} asset={asset} onPreviewImage={onPreviewImage} />)}
              </div>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>{t("关闭", "Close")}</Button>
              <Button type="submit" variant="primary" isPending={submitting || running} isDisabled={disabled || submitting || running || !capability.enabled}>{job ? t("重新生成", "Generate again") : t("开始生成", "Generate")}</Button>
            </Modal.Footer>
          </form>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal>;
}

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
  const [removeTarget, setRemoveTarget] = useState<CapabilityRecord>();
  const [testTarget, setTestTarget] = useState<CapabilityRecord>();
  const [testPrompt, setTestPrompt] = useState(DEFAULT_IMAGE_TEST_PROMPT);
  const [testJobId, setTestJobId] = useState<string>();
  const [testJobSnapshot, setTestJobSnapshot] = useState<MediaJob>();
  const [testError, setTestError] = useState<string>();
  const [previewImage, setPreviewImage] = useState<PreviewableImage | null>(null);
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
  const confirmRemove = async () => {
    if (!removeTarget) return;
    const chosen = removeTarget;
    await execute(`remove:${chosen.id}`, async () => {
      await mocoRest.deleteImageCapability(chosen.id, chosen.revision, imageCommandId("remove"));
      setRemoveTarget(undefined);
      requestAnimationFrame(() => (manageButtons.current.get(chosen.id) ?? addButton.current)?.focus());
    });
  };
  const records = workspace?.capabilities.filter((capability) => capability.kind === "image") ?? [];
  const enabledRecords = records.filter((capability) => capability.enabled);
  const activeTestCapability = testTarget ? records.find((item) => item.id === testTarget.id) ?? testTarget : undefined;
  const activeTestJob = (testJobId ? workspace?.jobs.find((job) => job.id === testJobId) : undefined) ?? testJobSnapshot;
  const testSubmitting = Boolean(activeTestCapability && busy === `test:${activeTestCapability.id}`);
  const openTest = (capability: CapabilityRecord) => {
    setTestTarget(capability);
    setTestPrompt(t(DEFAULT_IMAGE_TEST_PROMPT, "A cat eating an ice cream cone"));
    setTestJobId(undefined);
    setTestJobSnapshot(undefined);
    setTestError(undefined);
  };
  const closeTest = () => {
    if (testSubmitting) return;
    const id = testTarget?.id;
    setTestTarget(undefined);
    setTestJobId(undefined);
    setTestJobSnapshot(undefined);
    setTestError(undefined);
    requestAnimationFrame(() => (id ? manageButtons.current.get(id) ?? addButton.current : addButton.current)?.focus());
  };
  const submitTest = async () => {
    if (!activeTestCapability || blocked || actionLock.current) return;
    actionLock.current = true;
    setBusy(`test:${activeTestCapability.id}`);
    setTestError(undefined);
    try {
      const trimmed = testPrompt.trim();
      const job = await mocoRest.testImageCapability(activeTestCapability.id, {
        clientId,
        commandId: imageCommandId("test"),
        ...(trimmed ? { prompt: trimmed } : {}),
      });
      setTestJobId(job.id);
      setTestJobSnapshot(job);
      onRefresh();
    } catch (cause) {
      setTestError(imageActionError(cause));
    } finally {
      actionLock.current = false;
      setBusy(undefined);
    }
  };
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
              <Table.Cell className="moco-settings-table-cell whitespace-nowrap"><Chip size="sm" variant="soft" className="shrink-0 whitespace-nowrap" color={capabilityStatusColor(capability)}>{capabilityStatusLabel(capability)}</Chip></Table.Cell>
              <Table.Cell className="moco-settings-table-cell moco-settings-table-actions"><div className="moco-settings-table-action-group"><Button ref={(node) => { if (node) manageButtons.current.set(capability.id, node); else manageButtons.current.delete(capability.id); }} variant={selected ? "secondary" : "ghost"} size="sm" aria-label={t(`管理${capability.name}`, `Manage ${capability.name}`)} aria-pressed={selected} isDisabled={blocked} onPress={() => onRequest({ kind: "capability", id: capability.id })}>{t("管理", "Manage")}</Button><Dropdown><Button variant="ghost" size="sm" aria-label={t(`${capability.name}的更多操作`, `More actions for ${capability.name}`)} isDisabled={blocked}>{t("更多", "More")}</Button><Dropdown.Popover><Dropdown.Menu aria-label={t(`${capability.name}的操作`, `Actions for ${capability.name}`)} onAction={(key) => {
                if (key === "test") openTest(capability);
                if (key === "approve") void execute(`approve:${capability.id}`, () => mocoRest.patchImageCapability(capability.id, { allowTaskGeneration: !capability.allowTaskGeneration, expectedRevision: capability.revision, commandId: imageCommandId("approve") }));
                if (key === "default") void execute(`default:${capability.id}`, () => mocoRest.patchImageCapability(capability.id, { isDefault: true, expectedRevision: capability.revision, commandId: imageCommandId("default") }));
                if (key === "toggle") void execute(`toggle:${capability.id}`, () => mocoRest.patchImageCapability(capability.id, { enabled: !capability.enabled, expectedRevision: capability.revision, commandId: imageCommandId("toggle") }));
                if (key === "remove") setRemoveTarget(capability);
              }}><Dropdown.Item id="test" isDisabled={!capability.enabled} textValue={t("试生成", "Test generation")}>{t("试生成", "Test generation")}</Dropdown.Item><Dropdown.Item id="approve" isDisabled={!capability.enabled} textValue={capability.allowTaskGeneration ? t("取消自动生图", "Revoke task generation") : t("允许任务生图", "Allow task generation")}>{capability.allowTaskGeneration ? t("取消自动生图", "Revoke task generation") : t("允许任务生图", "Allow task generation")}</Dropdown.Item><Dropdown.Item id="default" isDisabled={capability.isDefault || !capability.enabled} textValue={t("设为默认", "Set as default")}>{t("设为默认", "Set as default")}</Dropdown.Item><Dropdown.Item id="toggle" textValue={capability.enabled ? t("停用", "Disable") : t("启用", "Enable")}>{capability.enabled ? t("停用", "Disable") : t("启用", "Enable")}</Dropdown.Item><Dropdown.Item id="remove" variant="danger" textValue={t("移除", "Remove")}>{t("移除", "Remove")}</Dropdown.Item></Dropdown.Menu></Dropdown.Popover></Dropdown></div></Table.Cell>
            </Table.Row>;
          })}
        </Table.Body>
      </Table.Content></Table.ScrollContainer></Table>
    </SettingsSection>
    {enabledRecords.length > 1 && <SettingsSection title={t("调用规则", "Selection rules")}>
      <SettingsList label={t("图像模型调用规则", "Image model routing")}>
        <div className="moco-settings-list-row flex-wrap justify-between">
          <span className="moco-item-title">{workspace?.imageRouting?.mode === "default" ? t("优先使用默认图像模型", "Prefer the default image model") : t("按任务自动选择图像模型", "Choose an image model for each task")}</span>
          <Button size="sm" variant="secondary" isDisabled={blocked} onPress={() => onRequest(undefined, IMAGE_ROUTING_PROMPT)}>{t("修改规则", "Edit rules")}</Button>
        </div>
      </SettingsList>
    </SettingsSection>}
    <ImageTestModal
      capability={activeTestCapability}
      prompt={testPrompt}
      onPromptChange={setTestPrompt}
      job={activeTestJob}
      error={testError}
      submitting={testSubmitting}
      disabled={!connected || disabled}
      onSubmit={() => void submitTest()}
      onClose={closeTest}
      onPreviewImage={setPreviewImage}
    />
    <AttachmentLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
    <ConfirmDialog open={Boolean(removeTarget)} title={t("移除图像模型？", "Remove image model?")} description={removeTarget?.name} confirmLabel={t("移除", "Remove")} status="danger" isPending={Boolean(busy)} onCancel={() => setRemoveTarget(undefined)} onConfirm={() => void confirmRemove()} />
  </div>;
}
