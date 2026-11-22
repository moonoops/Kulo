import { useRef, useState } from "react";
import { Alert, Button, Chip, Disclosure, Dropdown, Label, toast } from "@heroui/react";
import {
  EXTERNAL_CLIENT_KIND_LABELS,
  externalClientDisplayName as protocolExternalClientDisplayName,
  isSupportedExternalAgentKind,
  type EnvNodeDescriptor,
  type ExternalClientConnection,
  type KuloSettingsView,
  type RolePreset,
} from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { RoleAvatar } from "../../components/role-avatar";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import { useI18n } from "../../kulo-i18n";
import { externalEffortLabel, externalServiceTierLabel } from "./agent-preset-fields";
import { ExternalAgentConnectModal } from "./external-agent-connect-card";
import { deriveExternalClients, formatExternalClientTarget, roleExternalClientId } from "./external-agents-view";
import { SettingsList, SettingsSection } from "./settings-layout";
import { useSettingsPending } from "./settings-save-activity";

export const EXTERNAL_CLIENT_NAMES = EXTERNAL_CLIENT_KIND_LABELS;
export const externalClientDisplayName = protocolExternalClientDisplayName;

export function ExternalClientsList({
  clients,
  roles,
  envs = [],
  onRefreshClient,
  onVerifyClient,
  onRemoveClient,
  refreshingClientId = null,
  verifyingClientId = null,
  busy = false,
}: {
  clients: ExternalClientConnection[];
  roles: Record<string, RolePreset>;
  envs?: EnvNodeDescriptor[];
  onRefreshClient?: (clientId: string) => void;
  onVerifyClient?: (clientId: string) => void;
  onRemoveClient?: (client: ExternalClientConnection) => void;
  refreshingClientId?: string | null;
  verifyingClientId?: string | null;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const allRoles = Object.values(roles);

  if (clients.length === 0) {
    return (
      <div className="kulo-list-surface px-4 py-3 text-sm text-muted">
        {t("暂无已连接的第三方 Agent。", "No connected third-party agents yet.")}
      </div>
    );
  }

  return (
    <SettingsList label={t("第三方 Agent", "Third-party Agents")}>
      {clients.map((client) => {
        const device = envs.find((env) => env.id === client.envId);
        const boundRoles = allRoles.filter(
          (role) => (role.external || role.externalClientId) && roleExternalClientId(role) === client.id,
        );
        const reserved = client.kind === "dots" || client.kind === "muse";
        const experimental = Boolean(client.experimental || client.kind === "grok-bot");
        const statusLabel = reserved
          ? t("待支持", "Reserved")
          : device?.online === false
            ? t("设备离线", "Device offline")
            : client.verifiedAt
              ? t("已连接", "Connected")
              : t("待验证", "Unverified");
        const title = formatExternalClientTarget(client, envs);
        const meta = [
          client.version ? client.version : "",
          client.models.length > 0 ? t(`${client.models.length} 个模型`, `${client.models.length} models`) : "",
          boundRoles.length > 0
            ? t(`${boundRoles.length} 个智能体使用`, `Used by ${boundRoles.length} agent(s)`)
            : "",
        ].filter(Boolean).join(" · ");
        const expanded = openClientId === client.id;

        return (
          <Disclosure
            key={client.id}
            isExpanded={expanded}
            onExpandedChange={(next) => setOpenClientId(next ? client.id : null)}
            className="flex min-w-0 flex-col"
          >
            <div className="kulo-settings-list-row flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex min-w-[200px] flex-1 items-center gap-3">
                <RoleAvatar roleId={client.kind} label={externalClientDisplayName(client)} size="sm" quiet />
                <Disclosure.Heading className="min-w-0 flex-1">
                  <Disclosure.Trigger className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl py-1 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <strong className="kulo-item-title">{title}</strong>
                        {experimental && (
                          <Chip size="sm" variant="soft" color="warning" className="shrink-0 whitespace-nowrap">
                            {t("实验", "Experimental")}
                          </Chip>
                        )}
                        <Chip
                          size="sm"
                          variant="soft"
                          color={client.verifiedAt && !reserved && !experimental && device?.online !== false ? "success" : undefined}
                          className="shrink-0 whitespace-nowrap"
                        >
                          {statusLabel}
                        </Chip>
                      </span>
                      {meta && <span className="kulo-item-description mt-0.5 block truncate">{meta}</span>}
                    </span>
                    <Disclosure.Indicator className="shrink-0 text-muted" />
                  </Disclosure.Trigger>
                </Disclosure.Heading>
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {onVerifyClient && !client.verifiedAt && !reserved && !experimental && isSupportedExternalAgentKind(client.kind) && (
                  <Button
                    size="sm"
                    variant="primary"
                    isDisabled={busy || device?.online === false}
                    isPending={verifyingClientId === client.id}
                    onPress={() => onVerifyClient(client.id)}
                  >
                    {t("验证连接", "Verify")}
                  </Button>
                )}
                {onRefreshClient && !reserved && !experimental && (
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy || device?.online === false}
                    isPending={refreshingClientId === client.id}
                    onPress={() => onRefreshClient(client.id)}
                  >
                    <KuloIcon name="refresh" size={15} />
                    {t("刷新模型", "Refresh models")}
                  </Button>
                )}
                {(onRemoveClient || (onVerifyClient && client.verifiedAt && !reserved && !experimental)) && (
                  <Dropdown>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={title + t("连接操作", " connection actions")}
                    >
                      <KuloIcon name="more-vert" size={18} />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        aria-label={title + t("连接操作", " connection actions")}
                        onAction={(key) => {
                          if (key === "verify") onVerifyClient?.(client.id);
                          if (key === "disconnect") onRemoveClient?.(client);
                        }}
                      >
                        {onVerifyClient && client.verifiedAt && !reserved && !experimental ? (
                          <Dropdown.Item
                            id="verify"
                            textValue={t("重新验证", "Re-verify")}
                            isDisabled={busy || device?.online === false}
                          >
                            <Label>{t("重新验证", "Re-verify")}</Label>
                          </Dropdown.Item>
                        ) : null}
                        {onRemoveClient ? (
                          <Dropdown.Item
                            id="disconnect"
                            textValue={t("移除连接", "Remove connection")}
                            isDisabled={busy}
                          >
                            <Label>{t("移除连接", "Remove connection")}</Label>
                          </Dropdown.Item>
                        ) : null}
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                )}
              </div>
            </div>

            <Disclosure.Content>
              <Disclosure.Body className="kulo-list-editor flex flex-col gap-3">
                {boundRoles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>{t("绑定智能体：", "Assigned agents:")}</span>
                    {boundRoles.map((role) => (
                      <Chip key={role.id} size="sm" variant="soft">{role.label}</Chip>
                    ))}
                  </div>
                )}
                {client.executable && (
                  <div className="flex flex-col gap-0.5 text-xs">
                    <span className="text-muted">{t("可执行路径", "Executable")}</span>
                    <span className="break-all font-mono text-foreground">{client.executable}</span>
                  </div>
                )}
                {client.kind === "acp" && client.acpArgs && client.acpArgs.length > 0 && (
                  <div className="flex flex-col gap-0.5 text-xs">
                    <span className="text-muted">{t("启动参数", "Arguments")}</span>
                    <span className="break-all font-mono text-foreground">{client.acpArgs.join(" ")}</span>
                  </div>
                )}
                {client.models.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted">{t("可用模型", "Available models")}</span>
                    <div className="flex flex-col gap-1">
                      {client.models.map((model) => {
                        const effortText = model.efforts?.length
                          ? model.efforts.map((effort) => externalEffortLabel(effort, t)).join(" / ")
                          : "";
                        const tierText = model.serviceTiers?.length
                          ? model.serviceTiers.map((tier) => externalServiceTierLabel(tier, t)).join(" / ")
                          : "";
                        const detail = [effortText, tierText].filter(Boolean).join(" · ");
                        return (
                          <div key={model.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                            <span className="font-medium text-foreground">
                              {model.name || model.id}
                              {model.name && model.name !== model.id ? (
                                <span className="ml-1.5 font-normal text-muted">{model.id}</span>
                              ) : null}
                              {model.isDefault ? ` (${t("默认", "Default")})` : ""}
                            </span>
                            {detail && <span className="text-muted">{detail}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-muted">
                    {t("暂无缓存模型", "No cached models")}
                  </span>
                )}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        );
      })}
    </SettingsList>
  );
}

export function ExternalClientsModule({
  settings,
  envs = [],
  onSettingsUpdated,
}: {
  settings: KuloSettingsView;
  envs?: EnvNodeDescriptor[];
  onSettingsUpdated: (next: KuloSettingsView) => void;
}) {
  const { t } = useI18n();
  const roles = settings.blocks.roles.value;
  const rolesRevision = settings.blocks.roles.revision;
  const clients = deriveExternalClients(roles, settings.externalClients);

  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [connectClientId] = useState(() => `external-clients-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`);
  const connectTriggerRef = useRef<HTMLButtonElement>(null);
  const [refreshingClientId, setRefreshingClientId] = useState<string | null>(null);
  const [verifyingClientId, setVerifyingClientId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeClientTarget, setRemoveClientTarget] = useState<ExternalClientConnection | null>(null);
  const [error, setError] = useState<string>();

  const busy = Boolean(refreshingClientId || verifyingClientId || removing);
  useSettingsPending(busy);

  const handleRefreshClient = async (clientId: string) => {
    if (busy) return;
    setRefreshingClientId(clientId);
    setError(undefined);
    try {
      const res = await kuloRest.refreshExternalClient(clientId);
      onSettingsUpdated(res.settings);
      toast.success(t("已刷新客户端模型目录", "Client model catalog refreshed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("刷新客户端模型目录失败", "Failed to refresh client model catalog"));
    } finally {
      setRefreshingClientId(null);
    }
  };

  const handleVerifyClient = async (clientId: string) => {
    if (busy) return;
    setVerifyingClientId(clientId);
    setError(undefined);
    try {
      const res = await kuloRest.verifyExternalClient(clientId, { expectedRevision: rolesRevision });
      onSettingsUpdated(res.settings);
      toast.success(t("第三方 Agent 连接验证通过", "Third-party agent connection verified"));
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) {
        const latest = await kuloRest.getSettings().catch(() => undefined);
        if (latest) onSettingsUpdated(latest);
      }
      setError(err instanceof Error ? err.message : t("验证第三方 Agent 连接失败", "Failed to verify third-party agent connection"));
    } finally {
      setVerifyingClientId(null);
    }
  };

  const confirmRemoveClient = async (client: ExternalClientConnection) => {
    if (busy) return;
    setRemoving(true);
    setError(undefined);
    try {
      const res = await kuloRest.removeExternalClient(client.id, rolesRevision);
      onSettingsUpdated(res.settings);
      setRemoveClientTarget(null);
      toast.success(t("已移除第三方 Agent 连接", "Third-party agent connection removed"));
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) {
        const latest = await kuloRest.getSettings().catch(() => undefined);
        if (latest) onSettingsUpdated(latest);
      }
      setError(err instanceof Error ? err.message : t("移除第三方 Agent 连接失败", "Failed to remove third-party agent connection"));
    } finally {
      setRemoving(false);
    }
  };

  const removeBoundRoles = removeClientTarget
    ? Object.values(roles).filter(
        (role) => (role.external || role.externalClientId) && roleExternalClientId(role) === removeClientTarget.id,
      )
    : [];

  return (
    <div className="kulo-settings-form" aria-busy={busy}>
      <div inert={busy || undefined} className="flex min-w-0 flex-col gap-6">
        <SettingsSection
          title={t("第三方 Agent", "Third-party Agents")}
          action={
            <Button
              ref={connectTriggerRef}
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => setConnectModalOpen(true)}
            >
              <KuloIcon name="add" size={16} />
              {t("连接客户端", "Connect client")}
            </Button>
          }
        >
          {error && (
            <Alert status="danger" className="mb-4 rounded-2xl p-3">
              <Alert.Indicator />
              <Alert.Content className="text-sm">{error}</Alert.Content>
            </Alert>
          )}
          <ExternalClientsList
            clients={clients}
            roles={roles}
            envs={envs}
            onRefreshClient={(clientId) => { void handleRefreshClient(clientId); }}
            onVerifyClient={(clientId) => { void handleVerifyClient(clientId); }}
            onRemoveClient={(client) => setRemoveClientTarget(client)}
            refreshingClientId={refreshingClientId}
            verifyingClientId={verifyingClientId}
            busy={busy}
          />
        </SettingsSection>
      </div>

      <ExternalAgentConnectModal
        open={connectModalOpen}
        clientId={connectClientId}
        connected
        disabled={busy}
        envs={envs}
        onClose={() => {
          setConnectModalOpen(false);
          requestAnimationFrame(() => connectTriggerRef.current?.focus({ preventScroll: true }));
        }}
        onConnected={(result) => onSettingsUpdated(result.settings)}
      />

      <ConfirmDialog
        open={Boolean(removeClientTarget)}
        title={t("移除第三方 Agent 连接？", "Remove third-party agent connection?")}
        description={
          removeClientTarget
            ? removeBoundRoles.length > 0
              ? t(
                  `移除「${formatExternalClientTarget(removeClientTarget, envs)}」后，正在使用该连接的 ${removeBoundRoles.length} 个智能体（${removeBoundRoles.map((r) => r.label).join("、")}）将自动回退为内置引擎；原客户端本身与账号不会被卸载。`,
                  `Removing “${formatExternalClientTarget(removeClientTarget, envs)}” will automatically revert ${removeBoundRoles.length} assigned agent(s) (${removeBoundRoles.map((r) => r.label).join(", ")}) to the built-in engine. The local client and account will not be uninstalled.`,
                )
              : t(
                  `移除「${formatExternalClientTarget(removeClientTarget, envs)}」？原客户端本身与账号不会被卸载。`,
                  `Remove “${formatExternalClientTarget(removeClientTarget, envs)}”? The local client and account will not be uninstalled.`,
                )
            : undefined
        }
        confirmLabel={t("移除连接", "Remove connection")}
        status="danger"
        onCancel={() => setRemoveClientTarget(null)}
        onConfirm={() => {
          if (removeClientTarget) {
            const target = removeClientTarget;
            setRemoveClientTarget(null);
            void confirmRemoveClient(target);
          }
        }}
      />
    </div>
  );
}
