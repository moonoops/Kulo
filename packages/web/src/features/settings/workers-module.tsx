import { useI18n } from "../../moco-i18n";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Chip,
  Disclosure,
  Dropdown,
  Label,
  Spinner,
  Switch,
  toast,
} from "@heroui/react";
import {
  defaultRolePresets,
  type EnvNodeDescriptor,
  type ExternalClientConnection,
  type ProjectView,
  type MocoSettingsView,
  type ProviderModelItem,
  type RolePreset,
} from "@moco/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { RoleAvatar } from "../../components/role-avatar";
import { MocoApiError, mocoRest } from "../../moco-api";
import { MocoIcon } from "../../moco-icon";
import {
  buildProviderModelGroups,
  effortLabel,
} from "./settings-helpers";
import { AgentPresetFields } from "./agent-preset-fields";
import { useProviderCatalog } from "./use-provider-catalog";
import { SettingsList, SettingsSaveBar, SettingsSection } from "./settings-layout";
import { EXTERNAL_CLIENT_NAMES, ExternalAgentsList } from "./external-agents-list";
import { externalAgentPresets, internalAgentPresets, roleExternalClientId } from "./external-agents-view";
import { commitRoleMutation, rebaseRoleDrafts, type RoleMutation } from "./worker-role-settings";
import { useSettingsPending } from "./settings-save-activity";

const EMPTY_AGENT: RolePreset = {
  id: "", label: "", whenToUse: "", prompt: "", readOnly: false,
  allowSubagents: false, thinkingLevel: "auto", enabled: true,
};

function localizedRoleLabel(
  id: string,
  label: string,
  defaultLabel: string | undefined,
  t: (zh: string, en: string) => string,
): string {
  if (!defaultLabel || label !== defaultLabel) return label;
  switch (id) {
    case "scout":
      return t("侦察员", "Scout");
    case "architect":
      return t("架构师", "Architect");
    case "coder":
      return t("开发者", "Coder");
    case "checker":
      return t("检验员", "Checker");
    case "designer":
      return t("设计师", "Designer");
    case "writer":
      return t("写作者", "Writer");
    default:
      return label;
  }
}

export function WorkersModule({
  settings,
  envs,
  projects,
  onSettingsUpdated,
  onDirtyChange,
}: {
  settings: MocoSettingsView;
  envs?: EnvNodeDescriptor[];
  projects?: Pick<ProjectView, "id" | "name">[];
  onSettingsUpdated: (next: MocoSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const rolesBlock = settings.blocks.roles;
  const modelBlock = settings.blocks.model;

  const [baseRevision, setBaseRevision] = useState(rolesBlock.revision);
  const [baseRoles, setBaseRoles] = useState<Record<string, RolePreset>>(() => rolesBlock.value);
  const [roles, setRoles] = useState<Record<string, RolePreset>>(() => rolesBlock.value);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const { providers, error: catalogError, refresh: refreshProviders } = useProviderCatalog(settings);
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newRole, setNewRole] = useState<RolePreset>(EMPTY_AGENT);
  const [createError, setCreateError] = useState<string>();
  const [deleteRoleTarget, setDeleteRoleTarget] = useState<RolePreset | null>(null);
  const [removeClientTarget, setRemoveClientTarget] = useState<ExternalClientConnection | null>(null);
  const [externalCreatingDirty, setExternalCreatingDirty] = useState(false);
  const [externalResetSignal, setExternalResetSignal] = useState(0);
  const [resetRequested, setResetRequested] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);

  const [busy, setBusy] = useState(false);
  const [refreshingClientId, setRefreshingClientId] = useState<string | null>(null);
  const savingRef = useRef(false);
  const latestRolesBlock = useRef(rolesBlock);
  if (rolesBlock.revision >= latestRolesBlock.current.revision) latestRolesBlock.current = rolesBlock;
  const [activeMutation, setActiveMutation] = useState<RoleMutation | null>(null);
  const [failedToggle, setFailedToggle] = useState<{ id: string; enabled: boolean } | null>(null);
  const toggleRowRefs = useRef(new Map<string, HTMLDivElement>());
  const focusAfterToggle = useRef<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  useSettingsPending(busy);
  const providerError = catalogError ? catalogError instanceof Error ? catalogError.message : t("读取模型目录失败", "Failed to load model catalog") : undefined;

  const defaultPresets = useMemo(() => defaultRolePresets(), []);
  const internalRoles = useMemo(() => internalAgentPresets(roles), [roles]);
  const savedInternalRoles = useMemo(() => internalAgentPresets(baseRoles), [baseRoles]);
  const atDefaults = JSON.stringify(internalRoles) === JSON.stringify(defaultPresets);
  const dirty = JSON.stringify(roles) !== JSON.stringify(baseRoles);
  const creatingDirty =
    creatingOpen && JSON.stringify(newRole) !== JSON.stringify(EMPTY_AGENT);
  const pageDirty = dirty || creatingDirty || externalCreatingDirty;
  const roleEntries = Object.entries(internalRoles);
  const totalRoleCount = roleEntries.length;
  const enabledRoleCount = Object.values(savedInternalRoles).filter((role) => role.enabled !== false).length;

  useEffect(() => {
    if (busy || !focusAfterToggle.current) return;
    const row = toggleRowRefs.current.get(focusAfterToggle.current);
    if (document.activeElement === document.body && row?.isConnected) {
      row.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true });
    }
    focusAfterToggle.current = null;
  }, [busy]);

  useEffect(() => {
    onDirtyChange?.(pageDirty);
    return () => onDirtyChange?.(false);
  }, [pageDirty, onDirtyChange]);

  useEffect(() => {
    if (rolesBlock.revision <= baseRevision) return;
    const incoming = rolesBlock.value;
    if (JSON.stringify(incoming) === JSON.stringify(baseRoles)) {
      setBaseRevision(rolesBlock.revision);
      return;
    }
    if (!dirty) {
      setRoles(incoming);
      setBaseRevision(rolesBlock.revision);
      setBaseRoles(incoming);
      setConflict(false);
    } else {
      setConflict(true);
    }
  }, [rolesBlock.revision, rolesBlock.value, baseRevision, baseRoles, dirty]);

  const providerModelGroups = useMemo(
    () => buildProviderModelGroups(modelBlock.value, providers),
    [modelBlock.value, providers, t],
  );

  const findRoleModelMeta = (
    providerOpt: string | undefined,
    modelOpt: string | undefined,
  ): ProviderModelItem | undefined => {
    const targetProv =
      providerOpt?.trim() || modelBlock.value.defaultProvider || "moco-gateway";
    const targetModel = modelOpt?.trim() || modelBlock.value.defaultModel;
    const grp = providerModelGroups.find((g) => g.providerId === targetProv);
    return grp?.models.find((m) => m.id === targetModel);
  };

  const cancelCreate = () => {
    setCreatingOpen(false);
    setNewRole(EMPTY_AGENT);
    setCreateError(undefined);
  };

  const persistMutation = async (mutation: RoleMutation): Promise<{ ok: boolean; error?: string }> => {
    if (savingRef.current || conflict) return { ok: false };
    const block = latestRolesBlock.current;
    if (block.revision !== baseRevision) {
      const conflictMsg = t("智能体配置已被其他会话修改，本地草稿已保留。", "Agent settings changed in another session. Your draft has been kept.");
      setConflict(true);
      setError(conflictMsg);
      return { ok: false, error: conflictMsg };
    }
    savingRef.current = true;
    setBusy(true);
    setActiveMutation(mutation);
    setFailedToggle(null);
    setError(undefined);
    if (mutation.kind === "enabled") focusAfterToggle.current = mutation.id;
    try {
      const next = await commitRoleMutation(block, mutation, async (revision, value) =>
        (await mocoRest.saveSettingsBlock("roles", revision, value)).settings);
      if (next.blocks.roles.revision >= latestRolesBlock.current.revision) {
        const incoming = next.blocks.roles.value;
        latestRolesBlock.current = next.blocks.roles;
        setRoles((current) => mutation.kind === "restore"
          ? { ...internalAgentPresets(incoming), ...rebaseRoleDrafts(baseRoles, current, externalAgentPresets(incoming)) }
          : rebaseRoleDrafts(baseRoles, current, incoming));
        setBaseRoles(incoming);
        setBaseRevision(next.blocks.roles.revision);
        setConflict(false);
        onSettingsUpdated(next);
      }
      return { ok: true };
    } catch (err) {
      const changed = err instanceof MocoApiError && err.status === 409;
      if (changed) setConflict(true);
      if (mutation.kind === "enabled" && !changed) setFailedToggle({ id: mutation.id, enabled: mutation.enabled });
      const message = changed ? t("智能体配置已被其他会话修改，本地草稿已保留。", "Agent settings changed in another session. Your draft has been kept.")
        : err instanceof Error ? err.message : t("保存智能体配置失败", "Failed to save agent settings");
      if (mutation.kind === "create") {
        if (!mutation.role.external && !mutation.role.externalClientId) setCreateError(message);
        else if (changed) setError(message);
      } else {
        setError(message);
      }
      return { ok: false, error: message };
    } finally {
      savingRef.current = false;
      setBusy(false);
      setActiveMutation(null);
    }
  };

  const handleCreateRole = async () => {
    if (savingRef.current || conflict) return;
    const cleanId = newRole.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(cleanId)) {
      setCreateError(t("标识须以小写字母开头，只能包含字母、数字、下划线或连字符，最多 40 字符。", "Use up to 40 letters, numbers, underscores or hyphens, starting with a lowercase letter."));
      return;
    }
    if (roles[cleanId] || rolesBlock.value[cleanId]) {
      setCreateError(t(`智能体「${cleanId}」已存在`, `Agent “${cleanId}” already exists`));
      return;
    }
    if (!newRole.label.trim() || !newRole.whenToUse.trim() || !newRole.prompt.trim()) {
      setCreateError(t("请填写智能体名称、负责任务和系统提示词。", "Enter the agent name, responsibilities and system prompt."));
      return;
    }
    const created: RolePreset = {
      ...newRole, id: cleanId, label: newRole.label.trim(),
      whenToUse: newRole.whenToUse.trim(), prompt: newRole.prompt.trim(),
    };
    const res = await persistMutation({ kind: "create", role: created });
    if (res.ok) {
      setOpenRole(cleanId);
      cancelCreate();
    }
  };

  const handleRefreshClient = async (clientId: string) => {
    if (savingRef.current || conflict) return;
    savingRef.current = true;
    setBusy(true);
    setRefreshingClientId(clientId);
    setError(undefined);
    try {
      const res = await mocoRest.refreshExternalClient(clientId);
      if (res.settings.blocks.roles.revision >= latestRolesBlock.current.revision) {
        const incoming = res.settings.blocks.roles.value;
        latestRolesBlock.current = res.settings.blocks.roles;
        setRoles((current) => rebaseRoleDrafts(baseRoles, current, incoming));
        setBaseRoles(incoming);
        setBaseRevision(res.settings.blocks.roles.revision);
        setConflict(false);
        onSettingsUpdated(res.settings);
      }
      toast.success(t("已刷新客户端模型目录", "Client model catalog refreshed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("刷新客户端模型目录失败", "Failed to refresh client model catalog"));
    } finally {
      savingRef.current = false;
      setBusy(false);
      setRefreshingClientId(null);
    }
  };

  const handleResetDefaults = async () => {
    const res = await persistMutation({ kind: "restore" });
    if (res.ok) {
      cancelCreate();
      setOpenRole(null);
      setResetRequested(false);
      toast.success(t("已恢复默认智能体配置", "Default agent settings restored"));
    }
  };

  const confirmDeleteRole = async (role: RolePreset) => {
    const isExternal = Boolean(role.external || role.externalClientId);
    if (!isExternal && totalRoleCount <= 1) return;
    const res = await persistMutation({ kind: "delete", id: role.id });
    if (res.ok) {
      if (openRole === role.id) setOpenRole(null);
      setDeleteRoleTarget(null);
    }
  };

  const confirmRemoveClient = async (client: ExternalClientConnection) => {
    if (savingRef.current || conflict) return;
    savingRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const res = await mocoRest.removeExternalClient(client.id, baseRevision);
      if (res.settings.blocks.roles.revision >= latestRolesBlock.current.revision) {
        const incoming = res.settings.blocks.roles.value;
        latestRolesBlock.current = res.settings.blocks.roles;
        setRoles((current) => rebaseRoleDrafts(baseRoles, current, incoming));
        setBaseRoles(incoming);
        setBaseRevision(res.settings.blocks.roles.revision);
        setConflict(false);
        if (openRole && roleExternalClientId(roles[openRole] ?? baseRoles[openRole] ?? { id: "", label: "", whenToUse: "", prompt: "" }) === client.id) {
          setOpenRole(null);
        }
        onSettingsUpdated(res.settings);
      }
      setRemoveClientTarget(null);
      toast.success(t("已移除外部客户端连接", "External client connection removed"));
    } catch (err) {
      if (err instanceof MocoApiError && err.status === 409) {
        const latest = await mocoRest.getSettings().catch(() => undefined);
        if (latest && latest.blocks.roles.revision !== baseRevision) {
          setConflict(true);
        }
      }
      setError(err instanceof Error ? err.message : t("移除外部客户端连接失败", "Failed to remove external client connection"));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const reloadLatest = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    try {
      const latest = await mocoRest.getSettings();
      latestRolesBlock.current = latest.blocks.roles;
      onSettingsUpdated(latest);
      setRoles(latest.blocks.roles.value);
      setBaseRevision(latest.blocks.roles.revision);
      setBaseRoles(latest.blocks.roles.value);
      setConflict(false);
      setError(undefined);
      setFailedToggle(null);
      cancelCreate();
      setExternalResetSignal((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("加载最新智能体配置失败", "Failed to load the latest agent settings"));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const discardAll = () => {
    const latest = latestRolesBlock.current;
    setRoles(latest.value);
    setBaseRevision(latest.revision);
    setBaseRoles(latest.value);
    setConflict(false);
    setError(undefined);
    setFailedToggle(null);
  };

  const saveAll = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || savingRef.current || conflict) return;
    if (enabledRoleCount === 0) {
      setError(t("请至少保留 1 个已启用的智能体。", "Keep at least one agent enabled."));
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setFailedToggle(null);
    setError(undefined);
    try {
      const res = await mocoRest.saveSettingsBlock("roles", baseRevision, roles);
      if (res.settings.blocks.roles.revision >= latestRolesBlock.current.revision) {
        latestRolesBlock.current = res.settings.blocks.roles;
        setBaseRevision(res.settings.blocks.roles.revision);
        setBaseRoles(res.settings.blocks.roles.value);
        setRoles(res.settings.blocks.roles.value);
        onSettingsUpdated(res.settings);
        setConflict(false);
      }
      toast.success(t("智能体配置已保存", "Agent settings saved"));
    } catch (err) {
      if (err instanceof MocoApiError && err.status === 409) {
        setConflict(true);
        setError(t("智能体配置已被其他会话修改，本地草稿已保留。", "Agent settings changed in another session. Your draft has been kept."));
      } else {
        setError(err instanceof Error ? err.message : t("保存智能体配置失败", "Failed to save agent settings"));
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="moco-settings-form" aria-busy={busy}>
      <div inert={busy || undefined}>
      <SettingsSection
        title={t("智能体列表", "Agents")}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={atDefaults || conflict}
              isPending={activeMutation?.kind === "restore"}
              onPress={() => setResetRequested(true)}
            >
              <MocoIcon name="refresh" size={15} />
              
              {t("恢复默认", "Restore defaults")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={creatingOpen}
              onPress={() => setCreatingOpen(true)}
            >
              <MocoIcon name="add" size={16} />
              
              {t("新建智能体", "New agent")}
            </Button>
          </div>
        }
      >
        {creatingOpen && (
          <form aria-label={t("新建智能体", "New agent")} className="mb-2 flex flex-col gap-4 rounded-2xl bg-surface-secondary p-4"
            onSubmit={(event) => { event.preventDefault(); void handleCreateRole(); }}>
            <AgentPresetFields value={newRole} onChange={(next) => { setNewRole(next); setCreateError(undefined); }} groups={providerModelGroups} defaultModel={modelBlock.value} isCreating />
            {createError && <Alert status="danger"><Alert.Indicator /><Alert.Content className="text-sm">{createError}</Alert.Content></Alert>}
            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="sm" variant="tertiary" onPress={cancelCreate}>{t("取消", "Cancel")}</Button>
              <Button type="submit" size="sm" variant="primary" isPending={activeMutation?.kind === "create"} isDisabled={conflict}>{t("添加智能体", "Add agent")}</Button>
            </div>
          </form>
        )}

        {providerError && (
          <Alert status="warning" className="mb-4 rounded-2xl">
            <Alert.Indicator />
            <Alert.Content className="text-sm">{providerError}</Alert.Content>
            <Button size="sm" variant="secondary" onPress={() => void refreshProviders()}>
              
              {t("重试", "Retry")}
            </Button>
          </Alert>
        )}

        <SettingsList label={t("智能体列表", "Agents")}>
          {roleEntries.map(([id, role]) => {
            const expanded = openRole === id;
            const enabled = baseRoles[id]?.enabled !== false;
            const disableSwitchOff = enabled && enabledRoleCount <= 1;
            const roleModelMeta = findRoleModelMeta(role.provider, role.modelId);
            const displayModel = role.modelId?.trim() || t("默认模型", "Default model");
            const displayLabel = localizedRoleLabel(id, role.label, defaultPresets[id]?.label, t);

            return (
              <Disclosure
                key={id}
                isExpanded={expanded}
                onExpandedChange={(next) => setOpenRole(next ? id : null)}
                className="flex min-w-0 flex-col"
              >
                <div className="moco-settings-list-row" ref={(element) => {
                  if (element) toggleRowRefs.current.set(id, element);
                  else toggleRowRefs.current.delete(id);
                }} aria-busy={activeMutation?.kind === "enabled" && activeMutation.id === id || undefined}>
                  <RoleAvatar roleId={id} label={displayLabel} size="sm" quiet />
                  <Disclosure.Heading className="min-w-0 flex-1">
                    <Disclosure.Trigger
                      className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl py-1 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5" title={role.whenToUse}>
                          <strong className="moco-item-title">
                            {displayLabel}
                          </strong>
                          {role.readOnly && (
                            <Chip size="sm" variant="soft">{t("只读", "Read-only")}</Chip>
                          )}
                          {role.allowSubagents && (
                            <Chip size="sm" variant="soft">{t("子智能体", "Subagents")}</Chip>
                          )}
                        </span>
                        <span className="moco-item-description mt-0.5 block truncate">
                          {displayModel} · {effortLabel(role.thinkingLevel, roleModelMeta)}
                        </span>
                      </span>
                      <Disclosure.Indicator className="shrink-0 text-muted" />
                    </Disclosure.Trigger>
                  </Disclosure.Heading>
                  {activeMutation?.kind === "enabled" && activeMutation.id === id && <Spinner size="sm" aria-label={t(`正在保存${displayLabel}启用状态`, `Saving ${displayLabel} status`)} />}
                  <Switch
                    aria-label={t("启用", "Enable ") + displayLabel}
                    isSelected={enabled}
                    isDisabled={busy || conflict || disableSwitchOff}
                    onChange={(next) => { if (next !== enabled) void persistMutation({ kind: "enabled", id, enabled: next }); }}
                  >
                    <Switch.Content>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch.Content>
                  </Switch>
                  <Dropdown>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={displayLabel + t("智能体操作", " agent actions")}
                    >
                      <MocoIcon name="more-vert" size={18} />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        aria-label={displayLabel + t("智能体操作", " agent actions")}
                        onAction={(key) => {
                          if (key === "delete") setDeleteRoleTarget(role);
                        }}
                      >
                        <Dropdown.Item
                          id="delete"
                          textValue={t("删除智能体", "Delete agent")}
                          variant="danger"
                          isDisabled={conflict || totalRoleCount <= 1 || disableSwitchOff}
                        >
                          <Label>{t("删除智能体", "Delete agent")}</Label>
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>

                <Disclosure.Content>
                  <Disclosure.Body className="moco-list-editor">
                    <AgentPresetFields
                      value={role}
                      onChange={(next) => setRoles((previous) => ({ ...previous, [id]: next }))}
                      groups={providerModelGroups}
                      defaultModel={modelBlock.value}
                    />
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            );
          })}
        </SettingsList>
      </SettingsSection>

      <ExternalAgentsList
        agents={Object.values(roles)}
        savedRoles={baseRoles}
        externalClients={settings.externalClients}
        envs={envs}
        projects={projects}
        openRole={openRole}
        onOpenRoleChange={setOpenRole}
        onRoleChange={(roleId, next) => setRoles((previous) => ({ ...previous, [roleId]: next }))}
        onToggleEnabled={(roleId, next) => { void persistMutation({ kind: "enabled", id: roleId, enabled: next }); }}
        onToggleRowRef={(id, node) => {
          if (node) toggleRowRefs.current.set(id, node);
          else toggleRowRefs.current.delete(id);
        }}
        onCreateRole={(created) => persistMutation({ kind: "create", role: created })}
        onCreatingDirtyChange={setExternalCreatingDirty}
        resetSignal={externalResetSignal}
        onDeleteRole={(target) => setDeleteRoleTarget(target)}
        onRefreshClient={(clientId) => { void handleRefreshClient(clientId); }}
        onRemoveClient={(client) => setRemoveClientTarget(client)}
        refreshingClientId={refreshingClientId}
        activeToggleId={activeMutation?.kind === "enabled" ? activeMutation.id : null}
        creatingBusy={activeMutation?.kind === "create"}
        busy={busy}
        conflict={conflict}
      />

      <form className="moco-form-stack" aria-label={t("智能体配置", "Agent settings")} onSubmit={(event) => void saveAll(event)}>
        {conflict && (
          <Alert status="warning" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3">
            <div className="flex items-center gap-2">
              <Alert.Indicator />
              <Alert.Content className="text-sm">
                {error ?? t("智能体配置已更新，当前草稿已保留。", "Agent settings have changed. Your draft has been kept.")}
              </Alert.Content>
            </div>
            <Button size="sm" variant="secondary" onPress={() => { if (pageDirty) setReloadRequested(true); else void reloadLatest(); }}>
              
              {t("加载最新版本", "Load latest version")}
            </Button>
          </Alert>
        )}

        {error && !conflict && (
          <Alert status="danger" className="rounded-2xl p-3">
            <Alert.Indicator />
            <Alert.Content className="text-sm">{error}</Alert.Content>
            {failedToggle && <Button type="button" size="sm" variant="secondary" isDisabled={busy} onPress={() => void persistMutation({ kind: "enabled", ...failedToggle })}>{t("重试", "Retry")}</Button>}
          </Alert>
        )}

        <SettingsSaveBar
          dirty={dirty}
          busy={busy}
          saving={busy && !activeMutation && !refreshingClientId}
          disabled={conflict}
          scopeLabel={t("智能体配置", "Agent settings")}
          stateLabel={t("智能体配置未保存", "Agent settings not saved")}
          saveLabel={t("保存智能体配置", "Save agent settings")}
          onDiscard={discardAll}
        />
      </form>
      </div>

      <ConfirmDialog
        open={Boolean(deleteRoleTarget)}
        title={t("删除智能体？", "Delete agent?")}
        description={
          deleteRoleTarget
            ? t("删除「", "Delete “") + deleteRoleTarget.label + t("」及其未保存的编辑？", "” and discard its unsaved edits?")
            : undefined
        }
        confirmLabel={t("删除智能体", "Delete agent")}
        status="danger"
        onCancel={() => setDeleteRoleTarget(null)}
        onConfirm={() => {
          if (deleteRoleTarget) { const target = deleteRoleTarget; setDeleteRoleTarget(null); void confirmDeleteRole(target); }
        }}
      />
      <ConfirmDialog
        open={Boolean(removeClientTarget)}
        title={t("移除外部客户端连接？", "Remove external client connection?")}
        description={
          removeClientTarget
            ? t("移除「", "Remove “") + `${EXTERNAL_CLIENT_NAMES[removeClientTarget.kind]} · ${envs?.find((e) => e.id === removeClientTarget.envId)?.name ?? removeClientTarget.envId}` + t("」及其关联的外部智能体配置？原客户端本身与账号不会被卸载。", "” and its associated external agents? The local client and account will not be uninstalled.")
            : undefined
        }
        confirmLabel={t("移除连接", "Remove connection")}
        status="danger"
        onCancel={() => setRemoveClientTarget(null)}
        onConfirm={() => {
          if (removeClientTarget) { const target = removeClientTarget; setRemoveClientTarget(null); void confirmRemoveClient(target); }
        }}
      />
      <ConfirmDialog open={resetRequested} title={t("恢复默认智能体配置？", "Restore default agent settings?")}
        description={t("内部智能体将恢复默认，当前内部智能体草稿将被替换。", "Internal agents will return to defaults and their current drafts will be replaced.")}
        confirmLabel={t("恢复默认", "Restore defaults")} status="warning" onCancel={() => setResetRequested(false)}
        onConfirm={() => { setResetRequested(false); void handleResetDefaults(); }} />
      <ConfirmDialog open={reloadRequested} title={t("放弃智能体草稿并加载最新配置？", "Discard agent drafts and load the latest settings?")}
        description={t("当前未保存的智能体编辑和新建草稿将被替换。", "Unsaved agent edits and new-agent drafts will be replaced.")}
        confirmLabel={t("加载最新版本", "Load latest version")} status="warning" onCancel={() => setReloadRequested(false)}
        onConfirm={() => { setReloadRequested(false); void reloadLatest(); }} />
    </div>
  );
}
