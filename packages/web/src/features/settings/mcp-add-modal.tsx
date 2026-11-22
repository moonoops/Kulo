import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Modal,
  SearchField,
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
  safeConnectionInputError,
  type ConnectionDraft,
} from "./connection-setup-inputs";
import { McpCustomForm } from "./mcp-custom-form";

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
    ...(preset.defaultOAuthScope ? { mcpOAuthScope: preset.defaultOAuthScope } : {}),
  });
}

/** Three-tier search ranking: direct official name/id > direct official keywords/desc > cloud aggregators. */
export function filterAndRankMcpPresets(
  presets: readonly McpPresetDefinition[],
  rawQuery: string,
): McpPresetDefinition[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [...presets];
  const scored: Array<{ preset: McpPresetDefinition; rank: number; index: number }> = [];
  for (let index = 0; index < presets.length; index++) {
    const preset = presets[index]!;
    const nameHit = preset.name.toLowerCase().includes(q) || preset.id.toLowerCase().includes(q);
    const metaHit =
      preset.description.toLowerCase().includes(q)
      || preset.category.toLowerCase().includes(q)
      || Boolean(preset.keywords?.some((kw) => kw.toLowerCase().includes(q)));
    if (!nameHit && !metaHit) continue;
    const rank = preset.hostedAggregator
      ? (nameHit ? 2 : 3)
      : (nameHit ? 0 : 1);
    scored.push({ preset, rank, index });
  }
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.map((entry) => entry.preset);
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
  onSelectComposio,
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
  onSelectComposio?: () => void;
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

  const filteredPresets = useMemo(
    () => filterAndRankMcpPresets(presets, query),
    [presets, query],
  );

  const connectedPresetIds = useMemo(
    () => new Set(existingConnections.filter((c) => c.kind === "mcp" && c.mcpPresetId).map((c) => c.mcpPresetId!)),
    [existingConnections],
  );

  const change = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const handleQuickPreset = async (preset: McpPresetDefinition) => {
    if (!connected || !vaultAvailable || busyId || submitting) return;
    if (preset.bootstrapMode === "composio" && onSelectComposio) {
      onClose();
      onSelectComposio();
      return;
    }
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
          ...(preset.defaultOAuthScope ? { mcpOAuthScope: preset.defaultOAuthScope } : {}),
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
                                  {preset.bootstrapMode === "composio"
                                    ? "API Key"
                                    : isOAuth
                                      ? "OAuth"
                                      : preset.authMode === "none"
                                        ? t("免鉴权", "Public")
                                        : "Token"}
                                </Chip>
                                {preset.hostedAggregator && (
                                  <Chip size="sm" variant="soft">
                                    {t("云端聚合", "Cloud hub")}
                                  </Chip>
                                )}
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
                <McpCustomForm
                  mode={mode}
                  selectedPreset={selectedPreset}
                  draft={draft}
                  authModes={authModes}
                  busy={busy}
                  localHost={localHost}
                  onChange={change}
                  onUpdateDraft={setDraft}
                  onClearError={() => setError(null)}
                  onSubmit={() => void handleSubmitForm()}
                />
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
