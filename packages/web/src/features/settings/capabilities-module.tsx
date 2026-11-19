import { useI18n } from "../../moco-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Skeleton, Table, Tabs } from "@heroui/react";
import { redactSecrets, type CapabilitiesWorkspaceSnapshot, type EnvNodeDescriptor, type MocoSettingsView, type SettingsAssistantContext } from "@moco/protocol";
import { SearchModule } from "./search-module";
import { VoiceModule } from "./voice-module";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { OtherExtensionsModule } from "./other-extensions-module";
import { SettingsSection } from "./settings-layout";
import { useSettingsNavigation } from "./use-settings-navigation";
import { SkillsModule } from "./skills-module";
import { ImageCapabilitiesPanel } from "./image-capabilities-panel";
import { CAPABILITY_VIEWS, CONNECT_FLOW_PROMPT, capabilityStatusColor, capabilityStatusLabel, capabilityTargetView, type CapabilityView } from "./capability-views";

export { capabilityStatusLabel } from "./capability-views";
export { skillStatusLabel } from "./skills-module";

export type CapabilityTarget = NonNullable<SettingsAssistantContext["target"]>;
export type CapabilityAssistantRequest = (target?: CapabilityTarget, prompt?: string) => void;

function WorkspaceEmptyState({ loaded, connected, error, empty }: { loaded: boolean; connected: boolean; error: string | null; empty: string }) {
  const { t } = useI18n();
  if (loaded) return <div className="moco-table-empty-state">{empty}</div>;
  if (error || !connected) return <div className="moco-table-empty-state">{error ? t("暂时无法读取", "Unable to load") : t("等待连接", "Waiting for connection")}</div>;
  return <div className="moco-table-empty-state w-full gap-4" role="status" aria-label={t("加载中", "Loading")}>
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
  return <Table variant="secondary" className="moco-settings-table moco-capabilities-table">
    <Table.ScrollContainer className="moco-settings-table-scroll">
      <Table.Content aria-label={image ? t("图像模型列表", "Image models") : t("视频连接列表", "Video connections")} selectionMode="none" keyboardNavigationBehavior="tab" className="moco-settings-table-content">
        <Table.Header>
          <Table.Column id="name" isRowHeader className="moco-settings-table-column">{image ? t("模型", "Model") : t("连接", "Connection")}</Table.Column>
          <Table.Column id="details" className="moco-settings-table-column moco-settings-table-meta">{image ? t("格式", "Formats") : t("设备", "Device")}</Table.Column>
          <Table.Column id="status" className="moco-settings-table-column moco-settings-table-meta">{t("状态", "Status")}</Table.Column>
          <Table.Column id="actions" className="moco-settings-table-column moco-settings-table-actions">{t("操作", "Actions")}</Table.Column>
        </Table.Header>
        <Table.Body renderEmptyState={() => <WorkspaceEmptyState loaded={Boolean(snapshot)} connected={connected} error={error} empty={image ? t("尚未添加图像模型", "No image models added") : t("尚未连接 Google Flow", "Google Flow is not connected")} />}>
          {(snapshot?.capabilities ?? []).filter((capability) => capability.kind === kind).map((capability) => {
            const connection = snapshot?.connections.find((item) => item.id === capability.connectionId);
            const flow = connection?.adapter === "flow-browser";
            const device = flow ? envs.find((env) => env.id === connection.browserEnvId)?.name ?? connection.browserEnvId : undefined;
            const selected = target?.kind === "capability" && target.id === capability.id;
            return <Table.Row key={capability.id} id={capability.id} textValue={capability.name}>
              <Table.Cell className="moco-settings-table-cell">
                <div className="flex min-w-0 flex-col items-start gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="moco-item-title break-words">{capability.name}</span>
                    {capability.isDefault && <Chip size="sm" variant="soft" color="accent">{t("默认", "Default")}</Chip>}
                  </div>
                  <span className="moco-item-description break-words">{flow ? t("Google Flow · 会员网页", "Google Flow · subscription website") : capability.modelId}</span>
                  {capability.error && <p className="break-words text-xs text-danger">{redactSecrets(capability.error)}</p>}
                </div>
              </Table.Cell>
              <Table.Cell className="moco-settings-table-cell moco-settings-table-meta">
                {image ? <div className="flex flex-wrap gap-1">{capability.formats.map((format) => <Chip key={format} size="sm" variant="tertiary">{format.toUpperCase()}</Chip>)}</div> : <span className="text-sm">{device ?? "—"}</span>}
              </Table.Cell>
              <Table.Cell className="moco-settings-table-cell moco-settings-table-meta"><Chip size="sm" variant="soft" color={capabilityStatusColor(capability)}>{capabilityStatusLabel(capability)}</Chip></Table.Cell>
              <Table.Cell className="moco-settings-table-cell moco-settings-table-actions">
                <div className="moco-settings-table-action-group"><Button size="sm" variant={selected ? "secondary" : "ghost"} aria-label={t(`管理${capability.name}`, `Manage ${capability.name}`)} aria-pressed={selected} isDisabled={!connected || disabled} onPress={() => onRequest({ kind: "capability", id: capability.id })}>{t("管理", "Manage")}</Button></div>
              </Table.Cell>
            </Table.Row>;
          })}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table>;
}

export function CapabilitiesModule({ snapshot, settings, loading, error, connected, clientId = "", requestsDisabled = false, envs, target, view: selectedView, onViewChange, voiceSettingsRequested = false, onRequest, onRefresh, onDirtyChange, onOpenModels }: {
  snapshot: CapabilitiesWorkspaceSnapshot | null;
  settings?: MocoSettingsView | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  clientId?: string;
  requestsDisabled?: boolean;
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
  const actionDisabled = !connected || requestsDisabled;
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
        <SettingsSection title={t("视频连接", "Video connections")} action={<Button variant="secondary" size="sm" isDisabled={actionDisabled} onPress={() => onRequest(undefined, CONNECT_FLOW_PROMPT)}>{t("连接 Google Flow", "Connect Google Flow")}</Button>}>
          <MediaCapabilitiesTable kind="video" snapshot={snapshot} connected={connected} disabled={requestsDisabled} error={error} envs={envs} target={target} onRequest={onRequest} />
        </SettingsSection>
      </Tabs.Panel>
      <Tabs.Panel id="search"><SearchModule snapshot={snapshot?.search} connected={connected} disabled={requestsDisabled} onRefresh={onRefresh} onDirtyChange={setSearchDirty} /></Tabs.Panel>
      <Tabs.Panel id="skills"><SkillsModule snapshot={snapshot ? { revision: snapshot.skillRevision, skills: snapshot.skills } : null} connected={connected} disabled={requestsDisabled} onRequest={onRequest} onRefresh={onRefresh} onDirtyChange={setSkillsDirty} /></Tabs.Panel>
      <Tabs.Panel id="colab"><SettingsSection title="Colab CLI"><div className="moco-table-empty-state rounded-2xl bg-surface-secondary">{t("暂未开放", "Not available yet")}</div></SettingsSection></Tabs.Panel>
      <Tabs.Panel id="other"><OtherExtensionsModule snapshot={snapshot?.extensions} connected={connected} disabled={requestsDisabled} target={target} onRequest={onRequest} onRefresh={onRefresh} /></Tabs.Panel>
    </Tabs>
    <ConfirmDialog open={viewNavigation.needsConfirmation} title={t("放弃未保存的修改？", "Discard unsaved changes?")} confirmLabel={t("放弃修改", "Discard changes")} cancelLabel={t("继续编辑", "Keep editing")} status="warning" onCancel={viewNavigation.cancel} onConfirm={() => { setVoiceDirty(false); setSearchDirty(false); setSkillsDirty(false); viewNavigation.discard(); }} />
  </section>;
}
