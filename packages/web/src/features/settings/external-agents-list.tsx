import { useEffect, useState } from "react";
import { Alert, Button, Chip, Disclosure, Dropdown, Label, Spinner, Switch } from "@heroui/react";
import type { EnvNodeDescriptor, ExternalAgentKind, ExternalClientConnection, ProjectView, RolePreset } from "@kulo/protocol";
import { RoleAvatar } from "../../components/role-avatar";
import { KuloIcon } from "../../kulo-icon";
import { useI18n } from "../../kulo-i18n";
import { AgentPresetFields, externalEffortLabel } from "./agent-preset-fields";
import { deriveExternalClients, roleExternalClientId } from "./external-agents-view";
import { SettingsList, SettingsSection } from "./settings-layout";

export const EXTERNAL_CLIENT_NAMES: Record<ExternalAgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  dsh: "DeepSeek Harness",
  "grok-bot": "Grok Bot",
  dots: "ChatGPT Dots",
  muse: "Meta Muse",
};

function createDraftForClient(client: ExternalClientConnection): RolePreset {
  return {
    id: "",
    label: "",
    whenToUse: "",
    prompt: "",
    enabled: Boolean(client.verifiedAt && !["grok-bot", "dots", "muse"].includes(client.kind)),
    readOnly: false,
    allowSubagents: false,
    thinkingLevel: "auto",
    externalClientId: client.id,
    external: {
      kind: client.kind,
      envId: client.envId,
      ...(client.executable ? { executable: client.executable } : {}),
      ...(client.agentRef ? { agentRef: client.agentRef } : {}),
      ...(client.cdpUrl ? { cdpUrl: client.cdpUrl } : {}),
      ...(client.experimental !== undefined ? { experimental: client.experimental } : {}),
      ...(client.version ? { version: client.version } : {}),
      ...(client.verifiedAt !== undefined ? { verifiedAt: client.verifiedAt } : {}),
      ...(client.capabilities ? { capabilities: client.capabilities } : {}),
    },
  };
}

export function ExternalAgentsList({
  agents,
  savedRoles,
  externalClients,
  envs = [],
  openRole = null,
  onOpenRoleChange,
  onRoleChange,
  onToggleEnabled,
  onToggleRowRef,
  onCreateRole,
  onCreatingDirtyChange,
  resetSignal = 0,
  onDeleteRole,
  onRefreshClient,
  onRemoveClient,
  refreshingClientId = null,
  activeToggleId = null,
  creatingBusy = false,
  busy = false,
  conflict = false,
}: {
  agents: RolePreset[];
  savedRoles?: Record<string, RolePreset>;
  externalClients?: Record<string, ExternalClientConnection>;
  envs?: EnvNodeDescriptor[];
  projects?: Pick<ProjectView, "id" | "name">[];
  openRole?: string | null;
  onOpenRoleChange?: (roleId: string | null) => void;
  onRoleChange?: (roleId: string, next: RolePreset) => void;
  onToggleEnabled?: (roleId: string, enabled: boolean) => void;
  onToggleRowRef?: (roleId: string, element: HTMLDivElement | null) => void;
  onCreateRole?: (role: RolePreset) => Promise<{ ok: boolean; error?: string } | boolean>;
  onCreatingDirtyChange?: (dirty: boolean) => void;
  resetSignal?: number;
  onDeleteRole?: (role: RolePreset) => void;
  onRefreshClient?: (clientId: string) => void;
  onRemoveClient?: (client: ExternalClientConnection) => void;
  refreshingClientId?: string | null;
  activeToggleId?: string | null;
  creatingBusy?: boolean;
  busy?: boolean;
  conflict?: boolean;
}) {
  const { t } = useI18n();
  const roleRecord = Object.fromEntries(agents.map((role) => [role.id, role]));
  const clients = deriveExternalClients(roleRecord, externalClients);
  const [creatingClientId, setCreatingClientId] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<RolePreset | null>(null);
  const [createError, setCreateError] = useState<string>();
  const [localOpen, setLocalOpen] = useState<string | null>(null);

  const creatingClient = creatingClientId ? clients.find((item) => item.id === creatingClientId) : undefined;
  const isDraftDirty = Boolean(
    creatingClient &&
      newRole &&
      JSON.stringify(newRole) !== JSON.stringify(createDraftForClient(creatingClient)),
  );

  useEffect(() => {
    onCreatingDirtyChange?.(isDraftDirty);
    return () => onCreatingDirtyChange?.(false);
  }, [isDraftDirty, onCreatingDirtyChange]);

  useEffect(() => {
    if (!resetSignal) return;
    setCreatingClientId(null);
    setNewRole(null);
    setCreateError(undefined);
  }, [resetSignal]);

  if (clients.length === 0) return null;

  const activeOpenRole = onOpenRoleChange ? openRole : localOpen;
  const setExpandedRole = onOpenRoleChange ?? setLocalOpen;

  const startCreating = (client: ExternalClientConnection) => {
    setCreatingClientId(client.id);
    setNewRole(createDraftForClient(client));
    setCreateError(undefined);
  };

  const cancelCreating = () => {
    setCreatingClientId(null);
    setNewRole(null);
    setCreateError(undefined);
  };

  const submitCreate = async (client: ExternalClientConnection) => {
    if (!newRole || !onCreateRole || busy || conflict) return;
    const cleanId = newRole.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(cleanId)) {
      setCreateError(t("标识须以小写字母开头，只能包含字母、数字、下划线或连字符，最多 40 字符。", "Use up to 40 letters, numbers, underscores or hyphens, starting with a lowercase letter."));
      return;
    }
    if (roleRecord[cleanId] || savedRoles?.[cleanId]) {
      setCreateError(t(`智能体「${cleanId}」已存在`, `Agent “${cleanId}” already exists`));
      return;
    }
    if (!newRole.label.trim() || !newRole.whenToUse.trim() || !newRole.prompt.trim()) {
      setCreateError(t("请填写智能体名称、委派时机和系统提示词。", "Enter the agent name, delegation timing and system prompt."));
      return;
    }
    const created: RolePreset = {
      ...createDraftForClient(client),
      id: cleanId,
      label: newRole.label.trim(),
      whenToUse: newRole.whenToUse.trim(),
      prompt: newRole.prompt.trim(),
      ...(newRole.modelId?.trim() ? { modelId: newRole.modelId.trim() } : {}),
      thinkingLevel: newRole.thinkingLevel ?? "auto",
    };
    try {
      const outcome = await onCreateRole(created);
      const ok = typeof outcome === "boolean" ? outcome : outcome.ok;
      if (ok) {
        setExpandedRole(cleanId);
        cancelCreating();
      } else if (typeof outcome === "object" && outcome.error) {
        setCreateError(outcome.error);
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("添加智能体失败", "Failed to add agent"));
    }
  };

  return <>
    {clients.map((client) => {
      const device = envs.find((env) => env.id === client.envId);
      const clientRoles = agents.filter((agent) => (agent.external || agent.externalClientId) && roleExternalClientId(agent) === client.id);
      const reserved = client.kind === "dots" || client.kind === "muse";
      const experimental = Boolean(client.experimental || client.kind === "grok-bot");
      const canEnable = Boolean(client.verifiedAt && !reserved && !experimental);
      const statusLabel = reserved
        ? t("待支持", "Reserved")
        : device?.online === false
          ? t("设备离线", "Device offline")
          : client.verifiedAt
            ? t("连接已验证", "Connection verified")
            : t("待验证", "Unverified");
      const sectionTitle = `${EXTERNAL_CLIENT_NAMES[client.kind]} · ${device?.name ?? client.envId}`;
      const isCreatingHere = creatingClientId === client.id && newRole !== null;

      return (
        <SettingsSection
          key={client.id}
          title={sectionTitle}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {experimental && <Chip size="sm" variant="soft" color="warning">{t("实验", "Experimental")}</Chip>}
              <Chip size="sm" variant="soft">{statusLabel}</Chip>
              {onRefreshClient && !reserved && !experimental && (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy || conflict || device?.online === false}
                  isPending={refreshingClientId === client.id}
                  onPress={() => onRefreshClient(client.id)}
                >
                  <KuloIcon name="refresh" size={15} />
                  {t("刷新模型", "Refresh models")}
                </Button>
              )}
              {onCreateRole && !reserved && (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || conflict || isCreatingHere}
                  onPress={() => startCreating(client)}
                >
                  <KuloIcon name="add" size={16} />
                  {t("新建智能体", "New agent")}
                </Button>
              )}
              {onRemoveClient && (
                <Dropdown>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={sectionTitle + t("连接操作", " connection actions")}
                  >
                    <KuloIcon name="more-vert" size={18} />
                  </Button>
                  <Dropdown.Popover placement="bottom end">
                    <Dropdown.Menu
                      aria-label={sectionTitle + t("连接操作", " connection actions")}
                      onAction={(key) => {
                        if (key === "disconnect") onRemoveClient(client);
                      }}
                    >
                      <Dropdown.Item
                        id="disconnect"
                        textValue={t("移除连接", "Remove connection")}
                        variant="danger"
                        isDisabled={conflict || busy}
                      >
                        <Label>{t("移除连接", "Remove connection")}</Label>
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              )}
            </div>
          }
        >
          {isCreatingHere && newRole && (
            <form
              aria-label={`${sectionTitle} ${t("新建智能体", "New agent")}`}
              className="mb-2 flex flex-col gap-4 rounded-2xl bg-surface-secondary p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate(client);
              }}
            >
              <AgentPresetFields
                value={newRole}
                externalClient={client}
                isCreating
                isDisabled={busy}
                onChange={(next) => {
                  setNewRole(next);
                  setCreateError(undefined);
                }}
              />
              {createError && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content className="text-sm">{createError}</Alert.Content>
                </Alert>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button type="button" size="sm" variant="tertiary" onPress={cancelCreating}>
                  {t("取消", "Cancel")}
                </Button>
                <Button type="submit" size="sm" variant="primary" isPending={creatingBusy} isDisabled={conflict}>
                  {t("添加智能体", "Add agent")}
                </Button>
              </div>
            </form>
          )}

          {clientRoles.length > 0 ? (
            <SettingsList label={sectionTitle}>
              {clientRoles.map((role) => {
                const expanded = activeOpenRole === role.id;
                const savedEnabled = (savedRoles?.[role.id] ?? role).enabled !== false;
                const displayModel = role.modelId?.trim() || t("客户端默认", "Client default");
                const displayEffort = externalEffortLabel(role.thinkingLevel ?? "auto", t);

                return (
                  <Disclosure
                    key={role.id}
                    isExpanded={expanded}
                    onExpandedChange={(next) => setExpandedRole(next ? role.id : null)}
                    className="flex min-w-0 flex-col"
                  >
                    <div
                      ref={(node) => onToggleRowRef?.(role.id, node)}
                      className="kulo-settings-list-row"
                      aria-busy={activeToggleId === role.id || undefined}
                    >
                      <RoleAvatar roleId={role.id} label={role.label} size="sm" quiet />
                      <Disclosure.Heading className="min-w-0 flex-1">
                        <Disclosure.Trigger className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl py-1 text-left">
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5" title={role.whenToUse}>
                              <strong className="kulo-item-title">{role.label}</strong>
                              {!savedEnabled && <Chip size="sm" variant="soft">{t("已停用", "Disabled")}</Chip>}
                            </span>
                            <span className="kulo-item-description mt-0.5 block truncate">
                              {displayModel} · {displayEffort}
                            </span>
                          </span>
                          <Disclosure.Indicator className="shrink-0 text-muted" />
                        </Disclosure.Trigger>
                      </Disclosure.Heading>
                      {activeToggleId === role.id && (
                        <Spinner size="sm" aria-label={t(`正在保存${role.label}启用状态`, `Saving ${role.label} status`)} />
                      )}
                      <Switch
                        aria-label={t("启用", "Enable") + role.label}
                        isSelected={savedEnabled}
                        isDisabled={busy || conflict || (!savedEnabled && !canEnable) || !onToggleEnabled}
                        onChange={(next) => {
                          if (next !== savedEnabled) onToggleEnabled?.(role.id, next);
                        }}
                      >
                        <Switch.Content>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                        </Switch.Content>
                      </Switch>
                      {onDeleteRole && (
                        <Dropdown>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={role.label + t("智能体操作", "Agent actions")}
                          >
                            <KuloIcon name="more-vert" size={18} />
                          </Button>
                          <Dropdown.Popover placement="bottom end">
                            <Dropdown.Menu
                              aria-label={role.label + t("智能体操作", "Agent actions")}
                              onAction={(key) => {
                                if (key === "delete") onDeleteRole(role);
                              }}
                            >
                              <Dropdown.Item
                                id="delete"
                                textValue={t("删除智能体", "Delete agent")}
                                variant="danger"
                                isDisabled={conflict || busy}
                              >
                                <Label>{t("删除智能体", "Delete agent")}</Label>
                              </Dropdown.Item>
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown>
                      )}
                    </div>

                    <Disclosure.Content>
                      <Disclosure.Body className="kulo-list-editor">
                        <AgentPresetFields
                          value={role}
                          externalClient={client}
                          isDisabled={busy || !onRoleChange}
                          onChange={(next) => onRoleChange?.(role.id, next)}
                        />
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                );
              })}
            </SettingsList>
          ) : (
            <div className="kulo-list-surface px-4 py-3 text-sm text-muted">
              {t("暂无智能体，可点击右上角新建智能体。", "No agents yet. Select New agent above to add one.")}
            </div>
          )}
        </SettingsSection>
      );
    })}
  </>;
}
