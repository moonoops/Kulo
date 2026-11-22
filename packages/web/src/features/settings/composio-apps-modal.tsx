import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  Modal,
  Spinner,
  TextField,
} from "@heroui/react";
import {
  redactSensitiveText,
  type ComposioConnectedAccountView,
  type ConnectionRecordView,
} from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { composioApi } from "./composio-api";

const QUICK_TOOLKITS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "gmail", label: "Gmail" },
  { slug: "googlecalendar", label: "Google Calendar" },
  { slug: "googledrive", label: "Google Drive" },
  { slug: "googlesheets", label: "Google Sheets" },
  { slug: "slack", label: "Slack" },
  { slug: "discord", label: "Discord" },
  { slug: "notion", label: "Notion" },
  { slug: "linear", label: "Linear" },
  { slug: "github", label: "GitHub" },
  { slug: "hubspot", label: "HubSpot" },
  { slug: "airtable", label: "Airtable" },
  { slug: "asana", label: "Asana" },
  { slug: "trello", label: "Trello" },
  { slug: "dropbox", label: "Dropbox" },
  { slug: "reddit", label: "Reddit" },
  { slug: "salesforce", label: "Salesforce" },
];

function accountStatusChip(status: string, t: (zh: string, en: string) => string): { color: "success" | "warning" | "danger" | "default"; label: string } {
  const upper = status.toUpperCase();
  if (upper === "ACTIVE") return { color: "success", label: t("已授权", "Active") };
  if (upper === "INITIATED" || upper === "PENDING") return { color: "warning", label: t("待授权", "Pending") };
  if (upper === "EXPIRED" || upper === "FAILED") return { color: "danger", label: t("已失效", "Expired") };
  return { color: "default", label: upper };
}

export function ComposioAppsModal({
  open,
  connection,
  connected,
  onClose,
}: {
  open: boolean;
  connection: ConnectionRecordView | null;
  connected: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ComposioConnectedAccountView[]>([]);
  const [allowedToolkits, setAllowedToolkits] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [linkingSlug, setLinkingSlug] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ toolkit: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async (connectionId: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await composioApi.listAccounts(connectionId, signal);
      if (signal?.aborted) return;
      setAccounts(res.accounts);
      setAllowedToolkits(res.allowedToolkits);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("加载已授权应用失败", "Failed to load connected apps")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open || !connection) {
      setAccounts([]);
      setAllowedToolkits([]);
      setSlugInput("");
      setPendingLink(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    void loadAccounts(connection.id, controller.signal);
    return () => controller.abort();
  }, [open, connection?.id, loadAccounts]);

  const visibleQuickToolkits = useMemo(() => {
    const scope = allowedToolkits.length ? allowedToolkits : connection?.mcpAllowedToolkits ?? [];
    if (!scope.length) return QUICK_TOOLKITS;
    const allowSet = new Set(scope);
    return QUICK_TOOLKITS.filter((item) => allowSet.has(item.slug));
  }, [allowedToolkits, connection?.mcpAllowedToolkits]);

  const handleConnect = async (rawToolkit: string) => {
    if (!connection || !connected || linkingSlug || disconnectingId) return;
    const slug = rawToolkit.trim().toLowerCase();
    if (!slug) return;
    setLinkingSlug(slug);
    setError(null);
    try {
      const res = await composioApi.createConnectLink(connection.id, slug);
      setPendingLink({ toolkit: slug, url: res.redirectUrl });
      setSlugInput("");
      try {
        window.open(res.redirectUrl, "_blank", "noopener,noreferrer");
      } catch {
        // Explicit link button remains visible below.
      }
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("获取授权链接失败", "Failed to create authorization link")));
    } finally {
      setLinkingSlug(null);
    }
  };

  const handleDisconnect = async (account: ComposioConnectedAccountView) => {
    if (!connection || !connected || disconnectingId || linkingSlug) return;
    setDisconnectingId(account.id);
    setError(null);
    try {
      await composioApi.disconnectAccount(connection.id, account.id);
      setAccounts((prev) => prev.filter((item) => item.id !== account.id));
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("断开授权失败", "Failed to disconnect app")));
    } finally {
      setDisconnectingId(null);
    }
  };

  const busy = linkingSlug !== null || disconnectingId !== null;
  const heading = t(`管理 ${connection?.name ?? "Composio"} 应用`, `Manage ${connection?.name ?? "Composio"} apps`);

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
              <Modal.Heading className="font-semibold">{heading}</Modal.Heading>
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

              {pendingLink && (
                <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-secondary p-4">
                  <a
                    href={pendingLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-(--kulo-control-height) items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground no-underline transition-opacity hover:opacity-90"
                  >
                    {t(`打开 ${pendingLink.toolkit} 授权页面`, `Open ${pendingLink.toolkit} sign-in`)}
                  </a>
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={loading || !connection}
                    onPress={() => {
                      if (connection) void loadAccounts(connection.id);
                    }}
                  >
                    {t("刷新状态", "Refresh")}
                  </Button>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{t("已授权应用", "Connected apps")}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={loading || busy || !connection || !connected}
                  onPress={() => {
                    if (connection) void loadAccounts(connection.id);
                  }}
                >
                  {t("刷新", "Refresh")}
                </Button>
              </div>

              {loading && accounts.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted" role="status">
                  <Spinner size="sm" />
                  <span>{t("加载中…", "Loading…")}</span>
                </div>
              ) : (
                <div
                  className="kulo-list-surface scrollbar max-h-64 overflow-y-auto"
                  role="group"
                  aria-label={t("已授权应用列表", "Connected Composio apps")}
                >
                  {accounts.length === 0 ? (
                    <div className="kulo-table-empty-state">{t("尚未授权第三方应用", "No apps authorized yet")}</div>
                  ) : (
                    accounts.map((account) => {
                      const chip = accountStatusChip(account.status, t);
                      return (
                        <div key={account.id} className="kulo-settings-list-row justify-between gap-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="kulo-item-title">{account.toolkit}</span>
                            <Chip size="sm" variant="soft" color={chip.color}>{chip.label}</Chip>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t(`断开 ${account.toolkit}`, `Disconnect ${account.toolkit}`)}
                            isPending={disconnectingId === account.id}
                            isDisabled={!connected || busy}
                            onPress={() => void handleDisconnect(account)}
                          >
                            {t("断开", "Disconnect")}
                          </Button>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              <div className="kulo-field-action-row">
                <TextField
                  className="kulo-form-field min-w-0 flex-1"
                  variant="secondary"
                  value={slugInput}
                  onChange={(value) => {
                    setSlugInput(value);
                    setError(null);
                  }}
                  isDisabled={busy || !connected}
                  fullWidth
                >
                  <Label>{t("授权新应用", "Connect another app")}</Label>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="gmail / googlecalendar / hubspot"
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                        event.preventDefault();
                        void handleConnect(slugInput);
                      }
                    }}
                  />
                </TextField>
                <Button
                  size="sm"
                  variant="secondary"
                  className="kulo-field-action-button"
                  isPending={Boolean(slugInput.trim() && linkingSlug === slugInput.trim().toLowerCase())}
                  isDisabled={busy || !connected || !slugInput.trim()}
                  onPress={() => void handleConnect(slugInput)}
                >
                  {t("授权", "Connect")}
                </Button>
              </div>

              {visibleQuickToolkits.length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t("常用应用快捷授权", "Popular apps")}>
                  {visibleQuickToolkits.map((item) => (
                    <Button
                      key={item.slug}
                      size="sm"
                      variant="secondary"
                      isPending={linkingSlug === item.slug}
                      isDisabled={busy || !connected}
                      onPress={() => void handleConnect(item.slug)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
              )}
            </Modal.Body>

            <Modal.Footer className="flex flex-row justify-end gap-2">
              <Button size="sm" variant="tertiary" isDisabled={busy} onPress={onClose}>
                {t("关闭", "Close")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
