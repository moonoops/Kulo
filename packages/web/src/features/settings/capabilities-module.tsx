import { useI18n } from "../../kulo-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Label, ListBox, Modal, Select, Skeleton, Table, Tabs } from "@heroui/react";
import { redactSecrets, type CapabilitiesWorkspaceSnapshot, type EnvNodeDescriptor, type KuloSettingsView, type SettingsAssistantContext } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { SearchModule } from "./search-module";
import { VoiceModule } from "./voice-module";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { OtherExtensionsModule } from "./other-extensions-module";
import { SettingsSection } from "./settings-layout";
import { useSettingsNavigation } from "./use-settings-navigation";
import { ComputerUseModule } from "./computer-use-module";
import { SkillsModule } from "./skills-module";
import { ImageCapabilitiesPanel } from "./image-capabilities-panel";
import { CAPABILITY_VIEWS, capabilityStatusColor, capabilityStatusLabel, capabilityTargetView, type CapabilityView } from "./capability-views";

export { capabilityStatusLabel } from "./capability-views";
export { skillStatusLabel } from "./skills-module";

export type CapabilityTarget = NonNullable<SettingsAssistantContext["target"]>;
export type CapabilityAssistantRequest = (target?: CapabilityTarget, prompt?: string) => void;

function WorkspaceEmptyState({ loaded, connected, error, empty }: { loaded: boolean; connected: boolean; error: string | null; empty: string }) {
  const { t } = useI18n();
  if (loaded) return <div className="kulo-table-empty-state">{empty}</div>;
  if (error || !connected) return <div className="kulo-table-empty-state">{error ? t("暂时无法读取", "Unable to load") : t("等待连接", "Waiting for connection")}</div>;
  return <div className="kulo-table-empty-state w-full gap-4" role="status" aria-label={t("加载中", "Loading")}>
    <span className="sr-only">{t("加载中…", "Loading…")}</span>
    <Skeleton animationType="none" className="h-3 w-32" />
    <Skeleton animationType="none" className="h-3 w-16" />
  </div>;
}

function MediaCapabilitiesTable({ kind, snapshot, connected, disabled, error, envs, target, onRequest }: {
  kind: "image" | "video";
  snapshot: CapabilitiesWorkspaceSnapshot | null;
  connected: boolean;
  disabled: boolean;
  error: string | null;
  envs: EnvNodeDescriptor[];
  target?: CapabilityTarget;
  onRequest: CapabilityAssistantRequest;
}) {
  const { t } = useI18n();
  const image = kind === "image";
  return <Table variant="secondary" className="kulo-settings-table kulo-capabilities-table">
    <Table.ScrollContainer className="kulo-settings-table-scroll">
      <Table.Content aria-label={image ? t("图像模型列表", "Image models") : t("视频连接列表", "Video connections")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
        <Table.Header>
          <Table.Column id="name" isRowHeader className="kulo-settings-table-column kulo-settings-table-primary">{image ? t("模型", "Model") : t("连接", "Connection")}</Table.Column>
          <Table.Column id="details" className="kulo-settings-table-column kulo-settings-table-detail">{image ? t("格式", "Formats") : t("设备", "Device")}</Table.Column>
          <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-status">{t("状态", "Status")}</Table.Column>
          <Table.Column id="actions" className="kulo-settings-table-column kulo-settings-table-actions">{t("操作", "Actions")}</Table.Column>
        </Table.Header>
        <Table.Body renderEmptyState={() => <WorkspaceEmptyState loaded={Boolean(snapshot)} connected={connected} error={error} empty={image ? t("尚未添加图像模型", "No image models added") : t("尚未连接 Google Flow", "Google Flow is not connected")} />}>
          {(snapshot?.capabilities ?? []).filter((capability) => capability.kind === kind).map((capability) => {
            const connection = snapshot?.connections.find((item) => item.id === capability.connectionId);
            const flow = connection?.adapter === "flow-browser";
            const device = flow ? envs.find((env) => env.id === connection.browserEnvId)?.name ?? connection.browserEnvId : undefined;
            const selected = target?.kind === "capability" && target.id === capability.id;
            return <Table.Row key={capability.id} id={capability.id} textValue={capability.name}>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                <div className="kulo-settings-table-stack">
                  <span className="kulo-item-title">{capability.name}</span>
                  <span className="kulo-item-description">{flow ? t("Google Flow · 会员网页", "Google Flow · subscription website") : capability.modelId}</span>
                  {capability.error && <p className="break-words text-xs text-danger">{redactSecrets(capability.error)}</p>}
                </div>
              </Table.Cell>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-detail">
                {image ? <span className="kulo-item-description">{capability.formats.map((format) => format.toUpperCase()).join(" · ") || "—"}</span> : <span className="break-words text-sm">{device ?? "—"}</span>}
              </Table.Cell>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-status">
                <div className="kulo-settings-table-stack">
                  <Chip size="sm" variant="soft" className="shrink-0 whitespace-nowrap" color={capabilityStatusColor(capability)}>{capabilityStatusLabel(capability)}</Chip>
                  {capability.isDefault && <span className="kulo-item-description kulo-settings-table-status-note">{t("默认", "Default")}</span>}
                </div>
              </Table.Cell>
              <Table.Cell className="kulo-settings-table-cell kulo-settings-table-actions">
                <div className="kulo-settings-table-action-group"><Button size="sm" variant={selected ? "secondary" : "ghost"} aria-label={t(`管理${capability.name}`, `Manage ${capability.name}`)} aria-pressed={selected} isDisabled={!connected || disabled} onPress={() => onRequest({ kind: "capability", id: capability.id })}>{t("管理", "Manage")}</Button></div>
              </Table.Cell>
            </Table.Row>;
          })}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table>;
}

export function CapabilitiesModule({ snapshot, settings, loading, error, connected, clientId = "", requestsDisabled = false, localHost = false, envs, target, view: selectedView, onViewChange, voiceSettingsRequested = false, onRequest, onRefresh, onDirtyChange, onOpenModels }: {
  snapshot: CapabilitiesWorkspaceSnapshot | null;
  settings?: KuloSettingsView | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  clientId?: string;
  requestsDisabled?: boolean;
  localHost?: boolean;
  envs: EnvNodeDescriptor[];
  target?: CapabilityTarget;
  view?: CapabilityView;
  onViewChange?: (view: CapabilityView) => void;
  voiceSettingsRequested?: boolean;
  onRequest: CapabilityAssistantRequest;
  onRefresh: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenModels?: () => void;
}) {
  const { t } = useI18n();
  const [localView, setLocalView] = useState<CapabilityView>(() => voiceSettingsRequested ? "voice" : capabilityTargetView(target, snapshot) ?? "image");
  const view = selectedView ?? localView;
  const [voiceDirty, setVoiceDirty] = useState(false);
  const [searchDirty, setSearchDirty] = useState(false);
  const [skillsDirty, setSkillsDirty] = useState(false);
  const [flowPickerOpen, setFlowPickerOpen] = useState(false);
  const [selectedFlowEnvId, setSelectedFlowEnvId] = useState("");
  const [flowBusy, setFlowBusy] = useState(false);
  const [flowError, setFlowError] = useState<string>();
  const flowButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = voiceDirty || searchDirty || skillsDirty;
  const viewNavigation = useSettingsNavigation(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const selectView = useCallback((next: CapabilityView) => { setLocalView(next); onViewChange?.(next); }, [onViewChange]);
  const targetView = capabilityTargetView(target, snapshot);
  const currentView = useRef(view);
  currentView.current = view;
  useEffect(() => { if (voiceSettingsRequested && !selectedView) selectView("voice"); }, [voiceSettingsRequested, selectedView, selectView]);
  useEffect(() => {
    // Only target changes request navigation; tab changes must not replay the old target.
    if (!targetView || targetView === currentView.current) return;
    viewNavigation.navigate(() => selectView(targetView));
  }, [target?.kind, target?.id, targetView, selectView]);
  const flowDevices = envs.filter((env) => env.online && env.executionKind !== "native-device" && env.capabilities.includes("flow-browser"));
  const flowCommandId = () => `flow-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const connectFlow = async (envId: string) => {
    if (!connected || flowBusy || !clientId) return;
    setFlowBusy(true);
    setFlowError(undefined);
    try {
      const result = await kuloRest.connectGoogleFlow({ clientId, envId, commandId: flowCommandId() });
      if (!mounted.current) return;
      setFlowPickerOpen(false);
      onRefresh();
      onRequest({ kind: "capability", id: result.capability.id });
    } catch (cause) {
      if (mounted.current) {
        setFlowError(redactSecrets(cause instanceof Error ? cause.message : t("连接 Google Flow 失败，请重试。", "Failed to connect Google Flow. Please retry.")));
      }
    } finally {
      if (mounted.current) setFlowBusy(false);
    }
  };
  const startFlowConnect = () => {
    if (!connected || flowBusy || !clientId) return;
    setFlowError(undefined);
    if (flowDevices.length === 0) {
      setFlowError(t("暂无支持 Google Flow 的在线电脑设备。", "No online computer supports Google Flow."));
      return;
    }
    if (flowDevices.length === 1) {
      void connectFlow(flowDevices[0]!.id);
      return;
    }
    setSelectedFlowEnvId(flowDevices[0]!.id);
    setFlowPickerOpen(true);
  };
  const closeFlowPicker = () => {
    if (flowBusy) return;
    setFlowPickerOpen(false);
    requestAnimationFrame(() => flowButton.current?.focus());
  };
  return <section className="@container flex min-w-0 flex-col gap-6" aria-label={t("工具技能", "Tools and skills")}>
    <Tabs selectedKey={view} onSelectionChange={(key) => {
      const next = CAPABILITY_VIEWS.find((item) => item.id === key)?.id;
      if (!next) return;
      if (next !== view) viewNavigation.navigate(() => selectView(next));
    }} className="flex min-w-0 flex-col gap-6">
      <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
        <Tabs.List aria-label={t("工具技能视图", "Tools and skills views")} className="w-max">
          {CAPABILITY_VIEWS.map(({ id, label, englishLabel }) => <Tabs.Tab key={id} id={id} className="w-auto shrink-0 whitespace-nowrap">{t(label, englishLabel)}<Tabs.Indicator /></Tabs.Tab>)}
        </Tabs.List>
      </Tabs.ListContainer>
      {error && <Alert status="danger"><Alert.Content><Alert.Title>{snapshot ? t("刷新失败", "Refresh failed") : t("加载失败", "Failed to load")}</Alert.Title><Alert.Description>{redactSecrets(error)}</Alert.Description></Alert.Content><Button size="sm" variant="secondary" isDisabled={!connected || loading} onPress={onRefresh}>{t("重试", "Retry")}</Button></Alert>}
      {!connected && <Alert status="warning"><Alert.Content>{t("与中枢连接已断开", "Disconnected from hub")}</Alert.Content></Alert>}
      <Tabs.Panel id="image">
        <ImageCapabilitiesPanel workspace={snapshot} {...{ clientId, connected, loading, error, target, onRequest, onRefresh }} disabled={requestsDisabled} onOpenModels={onOpenModels} />
      </Tabs.Panel>
      <Tabs.Panel id="voice"><VoiceModule connected={connected} settings={settings} disabled={requestsDisabled} onDirtyChange={setVoiceDirty} onOpenModels={onOpenModels} /></Tabs.Panel>
      <Tabs.Panel id="video">
        <SettingsSection title={t("视频连接", "Video connections")} action={<Button ref={flowButton} variant="secondary" size="sm" isPending={flowBusy && !flowPickerOpen} isDisabled={!connected || flowBusy || !clientId} onPress={startFlowConnect}>{t("连接 Google Flow", "Connect Google Flow")}</Button>}>
          {flowError && !flowPickerOpen && <Alert status="danger" role="alert"><Alert.Content>{flowError}</Alert.Content></Alert>}
          <MediaCapabilitiesTable kind="video" snapshot={snapshot} connected={connected} disabled={requestsDisabled} error={error} envs={envs} target={target} onRequest={onRequest} />
        </SettingsSection>
      </Tabs.Panel>
      <Tabs.Panel id="search"><SearchModule snapshot={snapshot?.search} connected={connected} disabled={requestsDisabled} onRefresh={onRefresh} onDirtyChange={setSearchDirty} /></Tabs.Panel>
      <Tabs.Panel id="computer"><ComputerUseModule state={snapshot ? { revision: snapshot.revision, computerUse: snapshot.computerUse ?? { browserEnabled: true, desktopEnabled: true } } : null} envs={envs} connected={connected} disabled={requestsDisabled} onRefresh={onRefresh} /></Tabs.Panel>
      <Tabs.Panel id="skills"><SkillsModule snapshot={snapshot ? { revision: snapshot.skillRevision, skills: snapshot.skills } : null} connected={connected} disabled={requestsDisabled} localHost={localHost} onRequest={onRequest} onRefresh={onRefresh} onDirtyChange={setSkillsDirty} /></Tabs.Panel>
      <Tabs.Panel id="colab"><SettingsSection title="Colab CLI"><div className="kulo-table-empty-state rounded-2xl bg-surface-secondary">{t("暂未开放", "Not available yet")}</div></SettingsSection></Tabs.Panel>
      <Tabs.Panel id="other"><OtherExtensionsModule snapshot={snapshot?.extensions} connected={connected} disabled={requestsDisabled} target={target} onRequest={onRequest} onRefresh={onRefresh} /></Tabs.Panel>
    </Tabs>
    <Modal isOpen={flowPickerOpen} onOpenChange={(open) => { if (!open) closeFlowPicker(); }}>
      <Modal.Backdrop isOpen={flowPickerOpen} isDismissable={!flowBusy} isKeyboardDismissDisabled={flowBusy} onOpenChange={(open) => { if (!open) closeFlowPicker(); }}>
        <Modal.Container size="sm" placement="center" scroll="inside">
          <Modal.Dialog aria-label={t("连接 Google Flow", "Connect Google Flow")}>
            <form className="contents" onSubmit={(event) => { event.preventDefault(); if (selectedFlowEnvId) void connectFlow(selectedFlowEnvId); }}>
              <Modal.Header>
                <Modal.Heading>{t("连接 Google Flow", "Connect Google Flow")}</Modal.Heading>
                <Modal.CloseTrigger aria-label={t("关闭", "Close")} isDisabled={flowBusy} />
              </Modal.Header>
              <Modal.Body className="flex min-w-0 flex-col gap-4">
                <Select className="kulo-form-field" variant="secondary" fullWidth value={selectedFlowEnvId || null} onChange={(key) => setSelectedFlowEnvId(String(key ?? ""))} isDisabled={flowBusy}>
                  <Label>{t("选择设备", "Choose device")}</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {flowDevices.map((env) => <ListBox.Item key={env.id} id={env.id} textValue={env.name}>{env.name}</ListBox.Item>)}
                    </ListBox>
                  </Select.Popover>
                </Select>
                {flowError && <Alert status="danger" role="alert"><Alert.Content>{flowError}</Alert.Content></Alert>}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" isDisabled={flowBusy} onPress={closeFlowPicker}>{t("取消", "Cancel")}</Button>
                <Button type="submit" variant="primary" isPending={flowBusy} isDisabled={!connected || flowBusy || !selectedFlowEnvId}>{t("连接", "Connect")}</Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
    <ConfirmDialog open={viewNavigation.needsConfirmation} title={t("放弃未保存的修改？", "Discard unsaved changes?")} confirmLabel={t("放弃修改", "Discard changes")} cancelLabel={t("继续编辑", "Keep editing")} status="warning" onCancel={viewNavigation.cancel} onConfirm={() => { setVoiceDirty(false); setSearchDirty(false); setSkillsDirty(false); viewNavigation.discard(); }} />
  </section>;
}
