import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Disclosure,
  Input,
  Label,
  Link,
  ListBox,
  Modal,
  SearchField,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import {
  redactSensitiveText,
  type ConnectionApplicationView,
  type ConnectionRecordView,
  type ConnectionSetupInput,
  type McpAuthMode,
  type McpPresetDefinition,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { ConnectionIcon } from "./connection-icon";
import {
  clearConnectionDraftSecrets,
  connectionSaveRequest,
  createConnectionDraft,
  mcpAuthModeLabel,
  safeConnectionInputError,
  type ConnectionDraft,
} from "./connection-setup-inputs";

const BLANK_MCP_INPUT: ConnectionSetupInput = {
  id: "add-mcp-modal",
  clientId: "add-mcp-modal",
  kind: "mcp",
  category: "app",
  mcpTransport: "http",
  mcpAuthMode: "oauth",
  status: "pending",
  createdAt: 0,
};

function createPresetDraft(preset: McpPresetDefinition): ConnectionDraft {
  return createConnectionDraft({
    ...BLANK_MCP_INPUT,
    name: preset.name,
    mcpPresetId: preset.id,
    mcpTransport: preset.transport,
    url: preset.url,
    mcpAuthMode: preset.authMode,
    ...(preset.headerName ? { headerName: preset.headerName } : {}),
  });
}

export function AddAppModal({
  open,
  applications,
  presets,
  existingConnections,
  connected,
  vaultAvailable,
  localHost,
  onSelectApplication,
  onSavedMcp,
  onStartOAuth,
  onClose,
}: {
  open: boolean;
  applications: ConnectionApplicationView[];
  presets: McpPresetDefinition[];
  existingConnections: ConnectionRecordView[];
  connected: boolean;
  vaultAvailable: boolean;
  localHost: boolean;
  onSelectApplication: (application: ConnectionApplicationView) => void;
  onSavedMcp: (connection: ConnectionRecordView) => void;
  onStartOAuth: (connection: ConnectionRecordView) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"catalog" | "preset" | "custom">("catalog");
  const [query, setQuery] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<McpPresetDefinition | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft>(() => createConnectionDraft(BLANK_MCP_INPUT));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("catalog");
    setQuery("");
    setSelectedPreset(null);
    setDraft(createConnectionDraft(BLANK_MCP_INPUT));
    setBusyId(null);
    setSubmitting(false);
    setError(null);
  }, [open]);

  const catalogApps = useMemo(() => {
    const base = presets.length > 0
      ? applications.filter((app) => app.authentication === "macos")
      : applications;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((app) =>
      app.name.toLowerCase().includes(q)
      || app.description.toLowerCase().includes(q)
      || app.id.toLowerCase().includes(q),
    );
  }, [applications, presets.length, query]);

  const filteredPresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((preset) =>
      preset.name.toLowerCase().includes(q)
      || preset.description.toLowerCase().includes(q)
      || preset.id.toLowerCase().includes(q)
      || preset.category.toLowerCase().includes(q),
    );
  }, [presets, query]);

  const connectedPresetIds = useMemo(
    () => new Set(existingConnections.filter((c) => c.kind === "mcp" && c.mcpPresetId).map((c) => c.mcpPresetId!)),
    [existingConnections],
  );

  const change = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const addEnvField = () => {
    const key = `env_${globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
    setDraft((current) =>
      current.credentialFields.length >= 32
        ? current
        : { ...current, credentialFields: [...current.credentialFields, { key, label: "", value: "" }] },
    );
  };

  const updateEnvField = (key: string, patch: { label?: string; value?: string }) => {
    setDraft((current) => ({
      ...current,
      credentialFields: current.credentialFields.map((field) => (field.key === key ? { ...field, ...patch } : field)),
    }));
    setError(null);
  };

  const removeEnvField = (key: string) => {
    setDraft((current) => ({
      ...current,
      credentialFields: current.credentialFields.filter((field) => field.key !== key),
    }));
  };

  const handleQuickPreset = async (preset: McpPresetDefinition) => {
    if (!connected || !vaultAvailable || busyId || submitting) return;
    if (preset.authMode === "oauth" && !preset.requiresClientId) {
      setBusyId(preset.id);
      setError(null);
      try {
        const res = await kuloRest.saveConnection({
          name: preset.name,
          kind: "mcp",
          category: "app",
          mcpTransport: "http",
          mcpPresetId: preset.id,
          url: preset.url,
          mcpAuthMode: "oauth",
        });
        onSavedMcp(res.connection);
        onClose();
        onStartOAuth(res.connection);
      } catch (cause) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("添加应用失败，请重试。", "Failed to add app. Try again.")));
      } finally {
        setBusyId(null);
      }
      return;
    }

    if (preset.authMode === "none") {
      setBusyId(preset.id);
      setError(null);
      try {
        const res = await kuloRest.saveConnection({
          name: preset.name,
          kind: "mcp",
          category: "app",
          mcpTransport: "http",
          mcpPresetId: preset.id,
          url: preset.url,
          mcpAuthMode: "none",
        });
        let latest = res.connection;
        try {
          const tested = await kuloRest.testConnection(res.connection.id);
          latest = tested.connection;
        } catch {
          // Keep saved record visible even if initial probe fails.
        }
        onSavedMcp(latest);
        onClose();
      } catch (cause) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("添加应用失败，请重试。", "Failed to add app. Try again.")));
      } finally {
        setBusyId(null);
      }
      return;
    }

    setSelectedPreset(preset);
    setDraft(createPresetDraft(preset));
    setError(null);
    setMode("preset");
  };

  const openCustom = () => {
    setSelectedPreset(null);
    setDraft(createConnectionDraft(BLANK_MCP_INPUT));
    setError(null);
    setMode("custom");
  };

  const handleSubmitForm = async () => {
    if (!connected || !vaultAvailable || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "preset" && selectedPreset?.requiresClientId && draft.mcpAuthMode === "oauth" && !draft.mcpOAuthClientId.trim()) {
        throw new Error(t("此服务使用 OAuth 时需要填写 Client ID。", "Client ID is required for OAuth sign-in with this service."));
      }
      const payload = connectionSaveRequest(draft, BLANK_MCP_INPUT);
      const res = await kuloRest.saveConnection(payload);
      setDraft(clearConnectionDraftSecrets);
      if (res.connection.mcpTransport === "http" && res.connection.mcpAuthMode === "oauth") {
        onSavedMcp(res.connection);
        onClose();
        onStartOAuth(res.connection);
        return;
      }
      let latest = res.connection;
      try {
        const tested = await kuloRest.testConnection(res.connection.id);
        latest = tested.connection;
      } catch {
        // Keep saved record visible so user can inspect error or retry test.
      }
      onSavedMcp(latest);
      onClose();
    } catch (cause) {
      setError(safeConnectionInputError(cause, draft));
    } finally {
      setSubmitting(false);
    }
  };

  const authModes: readonly McpAuthMode[] =
    mode === "preset" && selectedPreset
      ? selectedPreset.supportedAuthModes
      : (["oauth", "bearer", "header", "none"] as const);
  const busy = busyId !== null || submitting;
  const heading =
    mode === "catalog"
      ? t("添加应用", "Add app")
      : mode === "preset" && selectedPreset
        ? t(`连接 ${selectedPreset.name}`, `Connect ${selectedPreset.name}`)
        : t("添加自定义 MCP", "Add custom MCP");

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Backdrop
        isOpen={open}
        isDismissable={!busy}
        onOpenChange={(next) => {
          if (!next && !busy) onClose();
        }}
      >
        <Modal.Container placement="center" size="md" scroll="inside">
          <Modal.Dialog
            aria-label={heading}
            className="w-full max-w-[560px] rounded-3xl"
          >
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {mode !== "catalog" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={t("返回应用列表", "Back to app catalog")}
                    isDisabled={busy}
                    onPress={() => {
                      setDraft(clearConnectionDraftSecrets);
                      setError(null);
                      setMode("catalog");
                    }}
                  >
                    <KuloIcon name="arrow-left" size={16} />
                  </Button>
                )}
                <Modal.Heading className="font-semibold">{heading}</Modal.Heading>
              </div>
              <Modal.CloseTrigger
                aria-label={t("关闭", "Close")}
                className="static"
                isDisabled={busy}
                onPress={onClose}
              />
            </Modal.Header>

            <Modal.Body className="kulo-form-stack">
              {error && (
                <Alert status="danger" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {mode === "catalog" ? (
                <>
                  <SearchField
                    className="kulo-context-field"
                    variant="secondary"
                    aria-label={t("搜索应用或 MCP", "Search apps or MCP")}
                    value={query}
                    onChange={setQuery}
                    isDisabled={busy}
                    fullWidth
                  >
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input autoFocus placeholder={t("搜索应用…", "Search apps…")} />
                      <SearchField.ClearButton aria-label={t("清空搜索", "Clear search")} />
                    </SearchField.Group>
                  </SearchField>

                  <div
                    className="kulo-list-surface scrollbar max-h-96 overflow-y-auto"
                    role="group"
                    aria-label={t("可连接应用目录", "Available apps")}
                  >
                    {catalogApps.map((app) => {
                      const alreadyConnected = app.status === "connected";
                      const itemDisabled = busy || !connected || app.status === "unavailable" || (!vaultAvailable && app.authentication !== "macos");
                      return (
                        <div key={`app:${app.id}`} className="kulo-settings-list-row justify-between gap-3">
                          <div className="kulo-connection-name min-w-0 flex-1">
                            <ConnectionIcon appId={app.id} />
                            <div className="kulo-connection-copy">
                              <span className="kulo-item-title">{app.name}</span>
                              <span className="kulo-item-description">{app.description}</span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant={alreadyConnected ? "ghost" : "secondary"}
                            isDisabled={itemDisabled || alreadyConnected}
                            aria-label={alreadyConnected ? t(`${app.name}已连接`, `${app.name} connected`) : t(`连接${app.name}`, `Connect ${app.name}`)}
                            onPress={() => {
                              onClose();
                              onSelectApplication(app);
                            }}
                          >
                            {alreadyConnected ? t("已连接", "Connected") : t("连接", "Connect")}
                          </Button>
                        </div>
                      );
                    })}

                    {filteredPresets.map((preset) => {
                      const alreadyAdded = connectedPresetIds.has(preset.id);
                      const isOAuth = preset.authMode === "oauth" && !preset.requiresClientId;
                      return (
                        <div key={`preset:${preset.id}`} className="kulo-settings-list-row justify-between gap-3">
                          <div className="kulo-connection-name min-w-0 flex-1">
                            <ConnectionIcon kind="mcp" mcpPresetId={preset.id} mcpTransport="http" />
                            <div className="kulo-connection-copy">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="kulo-item-title">{preset.name}</span>
                                <Chip size="sm" variant="soft">
                                  {isOAuth ? "OAuth" : preset.authMode === "none" ? t("免鉴权", "Public") : "Token"}
                                </Chip>
                              </div>
                              <span className="kulo-item-description">{preset.description}</span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            isPending={busyId === preset.id}
                            isDisabled={busy || !connected || !vaultAvailable}
                            aria-label={alreadyAdded ? t(`再次添加${preset.name}`, `Add another ${preset.name}`) : t(`连接${preset.name}`, `Connect ${preset.name}`)}
                            onPress={() => void handleQuickPreset(preset)}
                          >
                            {alreadyAdded ? t("再添加", "Add") : isOAuth ? t("登录连接", "Sign in") : t("连接", "Connect")}
                          </Button>
                        </div>
                      );
                    })}

                    {catalogApps.length === 0 && filteredPresets.length === 0 && (
                      <div className="kulo-table-empty-state">{t("未找到匹配应用", "No matching apps")}</div>
                    )}
                  </div>
                </>
              ) : (
                <form
                  id="kulo-add-mcp-form"
                  autoComplete="off"
                  className="kulo-form-stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSubmitForm();
                  }}
                >
                  {mode === "preset" && selectedPreset?.helpUrl && (
                    <Link className="self-start text-xs" href={selectedPreset.helpUrl} target="_blank" rel="noopener noreferrer">
                      {t("官方指南", "Official guide")}
                      <Link.Icon />
                    </Link>
                  )}

                  {mode === "custom" && (
                    <Select
                      className="kulo-form-field"
                      variant="secondary"
                      value={draft.mcpTransport}
                      isDisabled={busy}
                      onChange={(value) => {
                        if (value === "http" || value === "stdio") {
                          setDraft((current) => clearConnectionDraftSecrets({
                            ...current,
                            mcpTransport: value,
                            credentialFields: value === "stdio" ? current.credentialFields : [],
                          }));
                          setError(null);
                        }
                      }}
                      fullWidth
                    >
                      <Label>{t("接入方式", "Transport")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item id="http" textValue={t("远程服务 (HTTP)", "Remote server (HTTP)")}>
                            {t("远程服务 (HTTP)", "Remote server (HTTP)")}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                          {localHost && (
                            <ListBox.Item id="stdio" textValue={t("本机命令 (Stdio)", "Local command (Stdio)")}>
                              {t("本机命令 (Stdio)", "Local command (Stdio)")}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          )}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  )}

                  <TextField
                    className="kulo-form-field"
                    variant="secondary"
                    value={draft.name}
                    onChange={(value) => change("name", value)}
                    isRequired
                    isDisabled={busy}
                    fullWidth
                  >
                    <Label>{t("连接名称", "Connection name")}</Label>
                    <Input autoFocus maxLength={120} autoComplete="off" />
                  </TextField>

                  {draft.mcpTransport === "http" ? (
                    <>
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={draft.url}
                        onChange={(value) => change("url", value)}
                        isRequired
                        isDisabled={busy}
                        isReadOnly={mode === "preset" && Boolean(selectedPreset)}
                        fullWidth
                      >
                        <Label>{t("服务地址", "Server URL")}</Label>
                        <Input type="url" autoComplete="off" spellCheck={false} placeholder="https://mcp.example.com/mcp" />
                      </TextField>

                      {authModes.length > 1 && (
                        <Select
                          className="kulo-form-field"
                          variant="secondary"
                          value={draft.mcpAuthMode}
                          isDisabled={busy}
                          onChange={(value) => {
                            if (value === "oauth" || value === "bearer" || value === "header" || value === "none") {
                              setDraft((current) => clearConnectionDraftSecrets({ ...current, mcpAuthMode: value }));
                              setError(null);
                            }
                          }}
                          fullWidth
                        >
                          <Label>{t("认证方式", "Authentication")}</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              {authModes.map((item) => (
                                <ListBox.Item key={item} id={item} textValue={mcpAuthModeLabel(item)}>
                                  {mcpAuthModeLabel(item)}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      )}

                      {draft.mcpAuthMode === "header" && (
                        <TextField
                          className="kulo-form-field"
                          variant="secondary"
                          value={draft.headerName}
                          onChange={(value) => change("headerName", value)}
                          isDisabled={busy}
                          fullWidth
                        >
                          <Label>{t("请求头名称", "Header name")}</Label>
                          <Input autoComplete="off" spellCheck={false} />
                        </TextField>
                      )}

                      {(draft.mcpAuthMode === "bearer" || draft.mcpAuthMode === "header") && (
                        <TextField
                          className="kulo-form-field"
                          variant="secondary"
                          type="password"
                          value={draft.apiKey}
                          onChange={(value) => change("apiKey", value)}
                          isDisabled={busy}
                          fullWidth
                        >
                          <Label>Token</Label>
                          <Input autoComplete="new-password" spellCheck={false} placeholder={t("粘贴 Token", "Paste token")} />
                        </TextField>
                      )}

                      {draft.mcpAuthMode === "oauth" && (
                        mode === "preset" && selectedPreset?.requiresClientId ? (
                          <>
                            <TextField
                              className="kulo-form-field"
                              variant="secondary"
                              value={draft.mcpOAuthClientId}
                              onChange={(value) => change("mcpOAuthClientId", value)}
                              isRequired
                              isDisabled={busy}
                              fullWidth
                            >
                              <Label>Client ID</Label>
                              <Input autoComplete="off" spellCheck={false} />
                            </TextField>
                            <TextField
                              className="kulo-form-field"
                              variant="secondary"
                              type="password"
                              value={draft.clientSecret}
                              onChange={(value) => change("clientSecret", value)}
                              isDisabled={busy}
                              fullWidth
                            >
                              <Label>Client Secret</Label>
                              <Input autoComplete="new-password" spellCheck={false} />
                            </TextField>
                          </>
                        ) : (
                          <Disclosure>
                            <Disclosure.Heading>
                              <Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">
                                {t("高级 OAuth 选项", "Advanced OAuth options")}
                                <Disclosure.Indicator />
                              </Button>
                            </Disclosure.Heading>
                            <Disclosure.Content>
                              <Disclosure.Body className="kulo-form-stack pt-2">
                                <TextField
                                  className="kulo-form-field"
                                  variant="secondary"
                                  value={draft.mcpOAuthClientId}
                                  onChange={(value) => change("mcpOAuthClientId", value)}
                                  isDisabled={busy}
                                  fullWidth
                                >
                                  <Label>Client ID</Label>
                                  <Input autoComplete="off" spellCheck={false} />
                                </TextField>
                                {Boolean(draft.mcpOAuthClientId.trim()) && (
                                  <TextField
                                    className="kulo-form-field"
                                    variant="secondary"
                                    type="password"
                                    value={draft.clientSecret}
                                    onChange={(value) => change("clientSecret", value)}
                                    isDisabled={busy}
                                    fullWidth
                                  >
                                    <Label>Client Secret</Label>
                                    <Input autoComplete="new-password" spellCheck={false} />
                                  </TextField>
                                )}
                                <TextField
                                  className="kulo-form-field"
                                  variant="secondary"
                                  value={draft.mcpOAuthScope}
                                  onChange={(value) => change("mcpOAuthScope", value)}
                                  isDisabled={busy}
                                  fullWidth
                                >
                                  <Label>Scope</Label>
                                  <Input autoComplete="off" spellCheck={false} />
                                </TextField>
                                <TextField
                                  className="kulo-form-field"
                                  variant="secondary"
                                  value={draft.mcpOAuthCallbackPort}
                                  onChange={(value) => change("mcpOAuthCallbackPort", value)}
                                  isDisabled={busy}
                                  fullWidth
                                >
                                  <Label>{t("回调端口", "Callback port")}</Label>
                                  <Input inputMode="numeric" autoComplete="off" placeholder={t("默认自动分配", "Auto")} />
                                </TextField>
                              </Disclosure.Body>
                            </Disclosure.Content>
                          </Disclosure>
                        )
                      )}
                    </>
                  ) : (
                    <>
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={draft.mcpCommand}
                        onChange={(value) => change("mcpCommand", value)}
                        isRequired
                        isDisabled={busy}
                        fullWidth
                      >
                        <Label>{t("启动命令", "Command")}</Label>
                        <Input autoComplete="off" spellCheck={false} placeholder="npx" />
                      </TextField>
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={draft.mcpArgsText}
                        onChange={(value) => change("mcpArgsText", value)}
                        isDisabled={busy}
                        fullWidth
                      >
                        <Label>{t("启动参数（每行一项）", "Arguments (one per line)")}</Label>
                        <TextArea rows={3} className="scrollbar font-mono" autoComplete="off" spellCheck={false} placeholder={"-y\n@modelcontextprotocol/server-filesystem"} />
                      </TextField>
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={draft.mcpCwd}
                        onChange={(value) => change("mcpCwd", value)}
                        isDisabled={busy}
                        fullWidth
                      >
                        <Label>{t("工作目录", "Working directory")}</Label>
                        <Input autoComplete="off" spellCheck={false} placeholder={t("可选绝对路径", "Optional absolute path")} />
                      </TextField>
                      {draft.credentialFields.map((field, index) => (
                        <div key={field.key} role="group" aria-label={field.label.trim() || t(`环境变量 ${index + 1}`, `Env var ${index + 1}`)} className="kulo-form-stack rounded-xl border border-border p-3">
                          <div className="kulo-field-action-row">
                            <TextField
                              className="kulo-form-field min-w-0 flex-1"
                              variant="secondary"
                              value={field.label}
                              onChange={(value) => updateEnvField(field.key, { label: value })}
                              isRequired
                              isDisabled={busy}
                              fullWidth
                            >
                              <Label>{t(`环境变量 ${index + 1}`, `Env var ${index + 1}`)}</Label>
                              <Input className="kulo-field-action-input font-mono" maxLength={64} autoComplete="off" spellCheck={false} placeholder="API_TOKEN" />
                            </TextField>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="kulo-field-action-button"
                              aria-label={t(`移除${field.label.trim() || `环境变量 ${index + 1}`}`, `Remove ${field.label.trim() || `env var ${index + 1}`}`)}
                              isDisabled={busy}
                              onPress={() => removeEnvField(field.key)}
                            >
                              {t("移除", "Remove")}
                            </Button>
                          </div>
                          <TextField
                            className="kulo-form-field"
                            variant="secondary"
                            type="password"
                            value={field.value}
                            onChange={(value) => updateEnvField(field.key, { value })}
                            isDisabled={busy}
                            fullWidth
                          >
                            <Label>{t("变量值", "Value")}</Label>
                            <Input autoComplete="new-password" spellCheck={false} />
                          </TextField>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={busy || draft.credentialFields.length >= 32}
                        onPress={addEnvField}
                      >
                        {t("添加环境变量", "Add env var")}
                      </Button>
                    </>
                  )}
                </form>
              )}
            </Modal.Body>

            <Modal.Footer className="flex flex-row items-center justify-between gap-2">
              {mode === "catalog" ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy || !connected || !vaultAvailable}
                    onPress={openCustom}
                  >
                    <KuloIcon name="add" size={16} />
                    {t("自定义 MCP", "Custom MCP")}
                  </Button>
                  <Button size="sm" variant="tertiary" isDisabled={busy} onPress={onClose}>
                    {t("关闭", "Close")}
                  </Button>
                </>
              ) : (
                <>
                  <div />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="tertiary" isDisabled={busy} onPress={onClose}>
                      {t("取消", "Cancel")}
                    </Button>
                    <Button
                      size="sm"
                      type="submit"
                      form="kulo-add-mcp-form"
                      variant="secondary"
                      isPending={submitting}
                      isDisabled={busy || !connected || !vaultAvailable}
                    >
                      {draft.mcpTransport === "http" && draft.mcpAuthMode === "oauth"
                        ? t("保存并授权", "Save & sign in")
                        : t("保存并连接", "Save & connect")}
                    </Button>
                  </div>
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
