import { useI18n } from "../../kulo-i18n";
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
  BUILTIN_ROLE_TEXTS,
  areInternalRolesAtDefaults,
  isSupportedExternalAgentKind,
  localizeRolePresets,
  type EnvNodeDescriptor,
  type ProjectView,
  type KuloSettingsView,
  type ProviderModelItem,
  type RolePreset,
} from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { RoleAvatar } from "../../components/role-avatar";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import {
  buildProviderModelGroups,
  effortLabel,
  selectedDefaultProvider,
} from "./settings-helpers";
import { AgentPresetFields, externalEffortLabel, externalServiceTierLabel } from "./agent-preset-fields";
import { useProviderCatalog } from "./use-provider-catalog";
import { SettingsList, SettingsSaveBar, SettingsSection } from "./settings-layout";
import {
  deriveExternalClients,
  formatExternalClientTarget,
  roleExternalClientId,
} from "./external-agents-view";
import { commitRoleMutation, rebaseRoleDrafts, type RoleMutation } from "./worker-role-settings";
import { useSettingsPending } from "./settings-save-activity";

const EMPTY_AGENT: RolePreset = {
  id: "", label: "", whenToUse: "", prompt: "", readOnly: false,
  allowSubagents: false, thinkingLevel: "auto", enabled: true,
};

export function WorkersModule({
  settings,
  envs = [],
  onSettingsUpdated,
  onDirtyChange,
}: {
  settings: KuloSettingsView;
  envs?: EnvNodeDescriptor[];
  projects?: Pick<ProjectView, "id" | "name">[];
  onSettingsUpdated: (next: KuloSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, language: activeLanguage } = useI18n();
  const language = activeLanguage === "en" ? "en" : "zh-CN";
  const rolesBlock = settings.blocks.roles;
  const modelBlock = settings.blocks.model;

  const [baseRevision, setBaseRevision] = useState(rolesBlock.revision);
  const [baseRoles, setBaseRoles] = useState<Record<string, RolePreset>>(() => rolesBlock.value);
  const [roles, setRoles] = useState<Record<string, RolePreset>>(() => localizeRolePresets(rolesBlock.value, language));
  const [openRole, setOpenRole] = useState<string | null>(null);
  const { providers, error: catalogError, refresh: refreshProviders } = useProviderCatalog(settings);
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newRole, setNewRole] = useState<RolePreset>(EMPTY_AGENT);
  const [createError, setCreateError] = useState<string>();
  const [deleteRoleTarget, setDeleteRoleTarget] = useState<RolePreset | null>(null);
  const [resetRequested, setResetRequested] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);

  const [busy, setBusy] = useState(false);
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

  const localizedBaseRoles = useMemo(() => localizeRolePresets(baseRoles, language), [baseRoles, language]);
  const externalClients = useMemo(
    () => deriveExternalClients(roles, settings.externalClients),
    [roles, settings.externalClients],
  );
  const externalClientsById = useMemo(
    () => new Map(externalClients.map((client) => [client.id, client])),
    [externalClients],
  );
  const defaultScopeRoles = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(roles).filter(
          ([id, role]) => Object.hasOwn(BUILTIN_ROLE_TEXTS, id) || (!role.external && !role.externalClientId),
        ),
      ),
    [roles],
  );
  const atDefaults = useMemo(() => areInternalRolesAtDefaults(defaultScopeRoles), [defaultScopeRoles]);
  const dirty = JSON.stringify(roles) !== JSON.stringify(localizedBaseRoles);
  const creatingDirty =
    creatingOpen && JSON.stringify(newRole) !== JSON.stringify(EMPTY_AGENT);
  const pageDirty = dirty || creatingDirty;
  const roleEntries = Object.entries(roles);
  const totalRoleCount = roleEntries.length;
  const enabledRoleCount = Object.values(baseRoles).filter((role) => role.enabled !== false).length;

  useEffect(() => {
    setRoles((current) => localizeRolePresets(current, language));
  }, [language]);

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
      setRoles(localizeRolePresets(incoming, language));
      setBaseRevision(rolesBlock.revision);
      setBaseRoles(incoming);
      setConflict(false);
    } else {
      setConflict(true);
    }
  }, [rolesBlock.revision, rolesBlock.value, baseRevision, baseRoles, dirty, language]);

  const providerModelGroups = useMemo(
    () => buildProviderModelGroups(modelBlock.value, providers),
    [modelBlock.value, providers, t],
  );

  const findRoleModelMeta = (
    providerOpt: string | undefined,
    modelOpt: string | undefined,
  ): ProviderModelItem | undefined => {
    const targetProv =
      providerOpt?.trim() || selectedDefaultProvider(modelBlock.value);
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
        (await kuloRest.saveSettingsBlock("roles", revision, value)).settings);
      if (next.blocks.roles.revision >= latestRolesBlock.current.revision) {
        const incoming = next.blocks.roles.value;
        const localizedIncoming = localizeRolePresets(incoming, language);
        latestRolesBlock.current = next.blocks.roles;
        setRoles((current) => mutation.kind === "restore"
          ? localizedIncoming
          : rebaseRoleDrafts(localizedBaseRoles, current, localizedIncoming));
        setBaseRoles(incoming);
        setBaseRevision(next.blocks.roles.revision);
        setConflict(false);
        onSettingsUpdated(next);
      }
      return { ok: true };
    } catch (err) {
      const changed = err instanceof KuloApiError && err.status === 409;
      if (changed) setConflict(true);
      if (mutation.kind === "enabled" && !changed) setFailedToggle({ id: mutation.id, enabled: mutation.enabled });
      const message = changed ? t("智能体配置已被其他会话修改，本地草稿已保留。", "Agent settings changed in another session. Your draft has been kept.")
        : err instanceof Error ? err.message : t("保存智能体配置失败", "Failed to save agent settings");
      if (mutation.kind === "create") {
        setCreateError(message);
        if (changed) setError(message);
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
      ...newRole,
      id: cleanId,
      label: newRole.label.trim(),
      whenToUse: newRole.whenToUse.trim(),
      prompt: newRole.prompt.trim(),
      ...(newRole.modelId?.trim() ? { modelId: newRole.modelId.trim() } : { modelId: undefined }),
      ...(newRole.serviceTier?.trim() ? { serviceTier: newRole.serviceTier.trim() } : { serviceTier: undefined }),
    };
    const res = await persistMutation({ kind: "create", role: created });
    if (res.ok) {
      setOpenRole(cleanId);
      cancelCreate();
    }
  };

  const handleResetDefaults = async () => {
    const res = await persistMutation({ kind: "restore", language });
    if (res.ok) {
      cancelCreate();
      setOpenRole(null);
      setResetRequested(false);
      toast.success(t("已恢复默认智能体配置", "Default agent settings restored"));
    }
  };

  const confirmDeleteRole = async (role: RolePreset) => {
    if (totalRoleCount <= 1) return;
    const res = await persistMutation({ kind: "delete", id: role.id });
    if (res.ok) {
      if (openRole === role.id) setOpenRole(null);
      setDeleteRoleTarget(null);
    }
  };

  const reloadLatest = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    try {
      const latest = await kuloRest.getSettings();
      latestRolesBlock.current = latest.blocks.roles;
      onSettingsUpdated(latest);
      setRoles(localizeRolePresets(latest.blocks.roles.value, language));
      setBaseRevision(latest.blocks.roles.revision);
      setBaseRoles(latest.blocks.roles.value);
      setConflict(false);
      setError(undefined);
      setFailedToggle(null);
      cancelCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("加载最新智能体配置失败", "Failed to load the latest agent settings"));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const discardAll = () => {
    const latest = latestRolesBlock.current;
    setRoles(localizeRolePresets(latest.value, language));
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
      const res = await kuloRest.saveSettingsBlock("roles", baseRevision, roles);
      if (res.settings.blocks.roles.revision >= latestRolesBlock.current.revision) {
        latestRolesBlock.current = res.settings.blocks.roles;
        setBaseRevision(res.settings.blocks.roles.revision);
        setBaseRoles(res.settings.blocks.roles.value);
        setRoles(localizeRolePresets(res.settings.blocks.roles.value, language));
        onSettingsUpdated(res.settings);
        setConflict(false);
      }
      toast.success(t("智能体配置已保存", "Agent settings saved"));
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) {
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
    <div className="kulo-settings-form" aria-busy={busy}>
      <div inert={busy || undefined} className="flex min-w-0 flex-col gap-6">
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
                <KuloIcon name="refresh" size={15} />
                {t("恢复默认", "Restore defaults")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={creatingOpen}
                onPress={() => setCreatingOpen(true)}
              >
                <KuloIcon name="add" size={16} />
                {t("新建智能体", "New agent")}
              </Button>
            </div>
          }
        >
          {creatingOpen && (
            <form
              aria-label={t("新建智能体", "New agent")}
              className="mb-2 flex flex-col gap-4 rounded-2xl bg-surface-secondary p-4"
              onSubmit={(event) => { event.preventDefault(); void handleCreateRole(); }}
            >
              <AgentPresetFields
                value={newRole}
                onChange={(next) => { setNewRole(next); setCreateError(undefined); }}
                groups={providerModelGroups}
                defaultModel={modelBlock.value}
                externalClients={externalClients}
                envs={envs}
                isCreating
              />
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
              const savedRole = baseRoles[id] ?? role;
              const enabled = savedRole.enabled !== false;
              const disableSwitchOff = enabled && enabledRoleCount <= 1;
              const clientId = roleExternalClientId(role);
              const client = clientId ? externalClientsById.get(clientId) : undefined;
              const isExternal = Boolean(client || role.external || role.externalClientId);
              const device = isExternal ? envs.find((env) => env.id === (client?.envId ?? role.external?.envId)) : undefined;
              const externalKind = client?.kind ?? role.external?.kind;
              const reserved = externalKind === "dots" || externalKind === "muse";
              const experimental = Boolean(client?.experimental || role.external?.experimental || externalKind === "grok-bot");
              const externalVerified = Boolean(client?.verifiedAt ?? role.external?.verifiedAt);
              const canEnableExternal = Boolean(externalVerified && externalKind && isSupportedExternalAgentKind(externalKind) && !reserved && !experimental);

              const roleModelMeta = isExternal ? undefined : findRoleModelMeta(role.provider, role.modelId);
              const displayModel = isExternal
                ? role.modelId?.trim() || t("客户端默认", "Client default")
                : role.modelId?.trim() || t("默认模型", "Default model");
              const displayEffort = isExternal
                ? externalEffortLabel(role.thinkingLevel ?? "auto", t)
                : effortLabel(role.thinkingLevel, roleModelMeta);
              const matchedExternalModel = isExternal
                ? (client?.models.find((m) => m.id === role.modelId?.trim()) ?? (!role.modelId?.trim() ? client?.models.find((m) => m.isDefault) : undefined))
                : undefined;
              const matchedTier = isExternal && role.serviceTier?.trim()
                ? (matchedExternalModel?.serviceTiers?.find((tier) => tier.id === role.serviceTier?.trim()) ?? role.serviceTier.trim())
                : undefined;
              const engineTarget = isExternal
                ? client
                  ? formatExternalClientTarget(client, envs)
                  : role.external
                    ? formatExternalClientTarget(role.external, envs)
                    : undefined
                : undefined;
              const subtitle = [
                engineTarget,
                displayModel,
                displayEffort,
                matchedTier ? externalServiceTierLabel(matchedTier, t) : "",
              ].filter(Boolean).join(" · ");
              const displayLabel = role.label;

              return (
                <Disclosure
                  key={id}
                  isExpanded={expanded}
                  onExpandedChange={(next) => setOpenRole(next ? id : null)}
                  className="flex min-w-0 flex-col"
                >
                  <div className="kulo-settings-list-row" ref={(element) => {
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
                            <strong className="kulo-item-title">
                              {displayLabel}
                            </strong>
                            {role.readOnly && (
                              <Chip size="sm" variant="soft">{t("只读", "Read-only")}</Chip>
                            )}
                            {role.allowSubagents && (
                              <Chip size="sm" variant="soft">{t("子智能体", "Subagents")}</Chip>
                            )}
                            {isExternal && reserved && (
                              <Chip size="sm" variant="soft">{t("待支持", "Reserved")}</Chip>
                            )}
                            {isExternal && experimental && (
                              <Chip size="sm" variant="soft" color="warning">{t("实验", "Experimental")}</Chip>
                            )}
                            {isExternal && !reserved && !experimental && !externalVerified && (
                              <Chip size="sm" variant="soft">{t("待验证", "Unverified")}</Chip>
                            )}
                            {isExternal && device?.online === false && (
                              <Chip size="sm" variant="soft">{t("设备离线", "Device offline")}</Chip>
                            )}
                            {!enabled && (
                              <Chip size="sm" variant="soft">{t("已停用", "Disabled")}</Chip>
                            )}
                          </span>
                          <span className="kulo-item-description mt-0.5 block truncate">
                            {subtitle}
                          </span>
                        </span>
                        <Disclosure.Indicator className="shrink-0 text-muted" />
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    {activeMutation?.kind === "enabled" && activeMutation.id === id && <Spinner size="sm" aria-label={t(`正在保存${displayLabel}启用状态`, `Saving ${displayLabel} status`)} />}
                    <Switch
                      aria-label={t("启用", "Enable ") + displayLabel}
                      isSelected={enabled}
                      isDisabled={busy || conflict || disableSwitchOff || (!enabled && isExternal && !canEnableExternal)}
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
                        <KuloIcon name="more-vert" size={18} />
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
                            isDisabled={conflict || totalRoleCount <= 1 || disableSwitchOff}
                          >
                            <Label>{t("删除智能体", "Delete agent")}</Label>
                          </Dropdown.Item>
                        </Dropdown.Menu>
                      </Dropdown.Popover>
                    </Dropdown>
                  </div>

                  <Disclosure.Content>
                    <Disclosure.Body className="kulo-list-editor">
                      <AgentPresetFields
                        value={role}
                        onChange={(next) => setRoles((previous) => ({ ...previous, [id]: next }))}
                        groups={providerModelGroups}
                        defaultModel={modelBlock.value}
                        externalClients={externalClients}
                        envs={envs}
                      />
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>
              );
            })}
          </SettingsList>
        </SettingsSection>

        <form className="kulo-form-stack" aria-label={t("智能体配置", "Agent settings")} onSubmit={(event) => void saveAll(event)}>
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
            saving={busy && !activeMutation}
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
      <ConfirmDialog open={resetRequested} title={t("恢复默认智能体配置？", "Restore default agent settings?")}
        description={t("内置智能体将恢复默认配置与内置引擎，当前草稿将被替换。", "Built-in agents will return to default settings and the built-in engine, and current drafts will be replaced.")}
        confirmLabel={t("恢复默认", "Restore defaults")} status="warning" onCancel={() => setResetRequested(false)}
        onConfirm={() => { setResetRequested(false); void handleResetDefaults(); }} />
      <ConfirmDialog open={reloadRequested} title={t("放弃智能体草稿并加载最新配置？", "Discard agent drafts and load the latest settings?")}
        description={t("当前未保存的智能体编辑和新建草稿将被替换。", "Unsaved agent edits and new-agent drafts will be replaced.")}
        confirmLabel={t("加载最新版本", "Load latest version")} status="warning" onCancel={() => setReloadRequested(false)}
        onConfirm={() => { setReloadRequested(false); void reloadLatest(); }} />
    </div>
  );
}
