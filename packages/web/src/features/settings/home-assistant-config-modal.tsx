import { useEffect, useRef, useState } from "react";
import { Alert, AlertDialog, Button, Chip, Input, Label, Modal, Spinner, Switch, TextField, toast } from "@heroui/react";
import { redactSensitiveText, type HomeAssistantMigrationAdvice, type HomeAssistantSnapshot } from "@kulo/protocol";
import { kuloRest, type AssistantWorkspaceView } from "../../kulo-api";
import { translate as t, useI18n } from "../../kulo-i18n";

export function HomeAssistantConfigModal({
  open,
  snapshot,
  connected,
  localHost,
  onUpdated,
  onRequestGuide,
  onClose,
}: {
  open: boolean;
  snapshot: HomeAssistantSnapshot;
  connected: boolean;
  localHost: boolean;
  onUpdated?: (next: AssistantWorkspaceView) => void;
  onRequestGuide?: () => void;
  onClose: () => void;
}) {
  useI18n();
  const [enabled, setEnabled] = useState(snapshot.enabled);
  const [baseUrl, setBaseUrl] = useState(snapshot.baseUrl ?? "http://127.0.0.1:8123");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [confirmDeployOpen, setConfirmDeployOpen] = useState(false);
  const [migration, setMigration] = useState<HomeAssistantMigrationAdvice | null>(snapshot.migration ?? null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setEnabled(snapshot.enabled || true);
    setBaseUrl(snapshot.baseUrl ?? "http://127.0.0.1:8123");
    setToken("");
    setClearToken(false);
    setError(null);
    setConfirmDeployOpen(false);
    setMigration(snapshot.migration ?? null);

    if (localHost && !snapshot.connected) {
      const controller = new AbortController();
      abortRef.current = controller;
      void kuloRest.getHomeAssistantMigration(controller.signal)
        .then((advice) => {
          if (!controller.signal.aborted) setMigration(advice);
        })
        .catch(() => {
          // non-fatal probe
        });
      return () => {
        controller.abort();
      };
    }
    return undefined;
  }, [open, snapshot.baseUrl, snapshot.connected, snapshot.enabled, snapshot.migration, localHost]);

  const busy = saving || deploying;
  const close = () => {
    if (busy) return;
    abortRef.current?.abort();
    onClose();
  };

  const canDeployLocal = Boolean(
    localHost &&
    !snapshot.connected &&
    migration &&
    (migration.dockerAvailable || migration.orbStackAvailable) &&
    !migration.containerRunning &&
    !migration.port8123Reachable,
  );

  const save = async () => {
    if (!connected || busy) return;
    setSaving(true);
    setError(null);
    try {
      const trimmedUrl = baseUrl.trim();
      const trimmedToken = token.trim();
      const next = await kuloRest.configureAssistantHomeAssistant({
        enabled,
        baseUrl: trimmedUrl,
        ...(clearToken ? { clearToken: true } : trimmedToken ? { token: trimmedToken } : {}),
      });
      onUpdated?.(next);
      const nextHa = next.homeAssistant;
      if (enabled && nextHa?.error) {
        setError(redactSensitiveText(nextHa.error));
        requestAnimationFrame(() => urlInputRef.current?.focus());
      } else {
        toast.success(
          nextHa?.connected
            ? t("Home Assistant 已连接", "Home Assistant connected")
            : t("Home Assistant 设置已保存", "Home Assistant settings saved"),
        );
        onClose();
      }
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("保存 Home Assistant 配置失败", "Failed to save Home Assistant settings")));
      requestAnimationFrame(() => urlInputRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  const deployLocal = async () => {
    if (!connected || busy) return;
    setDeploying(true);
    setError(null);
    try {
      const result = await kuloRest.deployLocalHomeAssistant({
        confirmed: true,
        installXiaomiHome: true,
      });
      setMigration(result.advice);
      setConfirmDeployOpen(false);
      if (result.url) setBaseUrl(result.url);
      onUpdated?.({ ...result.snapshot, localHost: result.localHost });
      toast.success(
        result.xiaomiHomeInstalled
          ? t("本机 Home Assistant 已启动并预装小米官方集成", "Local Home Assistant started with Xiaomi Home")
          : t("本机 Home Assistant 已启动（http://127.0.0.1:8123）", "Local Home Assistant started (http://127.0.0.1:8123)"),
      );
    } catch (cause) {
      setConfirmDeployOpen(false);
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("启动本机 Home Assistant 失败", "Failed to start local Home Assistant")));
    } finally {
      setDeploying(false);
    }
  };

  const statusChip: { color: "success" | "warning" | "default"; label: string } = snapshot.connected
    ? {
        color: "success",
        label: snapshot.curatedEntities
          ? t(`已连接 · ${snapshot.curatedEntities} 设备`, `Connected · ${snapshot.curatedEntities}`)
          : t("已连接", "Connected"),
      }
    : snapshot.enabled && snapshot.error
      ? { color: "warning", label: t("需要处理", "Needs attention") }
      : { color: "default", label: t("未连接", "Not connected") };

  const hasSavedToken = snapshot.hasToken && !clearToken;

  return (
    <>
      <Modal isOpen={open} onOpenChange={(next) => { if (!next) close(); }}>
        <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={busy}>
          <Modal.Container placement="center" size="md" scroll="inside">
            <Modal.Dialog aria-label={t("米家 / Home Assistant", "Mi Home / Home Assistant")}>
              <Modal.Header>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Modal.Heading>{t("米家 / Home Assistant", "Mi Home / Home Assistant")}</Modal.Heading>
                  <Chip size="sm" variant="soft" color={statusChip.color}>{statusChip.label}</Chip>
                </div>
                <Modal.CloseTrigger aria-label={t("关闭 Home Assistant 配置", "Close Home Assistant settings")} isDisabled={busy} />
              </Modal.Header>
              <Modal.Body>
                <form
                  id="kulo-ha-config"
                  className="kulo-form-stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <Switch
                    className="w-full"
                    aria-label={t("启用 Home Assistant 连接", "Enable Home Assistant connection")}
                    isSelected={enabled}
                    isDisabled={!connected || busy}
                    onChange={setEnabled}
                  >
                    <Switch.Content className="flex w-full items-center justify-between gap-3">
                      <Label className="text-sm font-normal text-foreground">{t("启用连接", "Enable connection")}</Label>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch.Content>
                  </Switch>

                  <TextField
                    className="kulo-form-field"
                    variant="secondary"
                    fullWidth
                    isReadOnly={busy}
                    value={baseUrl}
                    onChange={(value) => {
                      setBaseUrl(value);
                      setError(null);
                    }}
                  >
                    <Label>{t("局域网地址", "LAN address")}</Label>
                    <Input
                      ref={urlInputRef}
                      type="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="http://127.0.0.1:8123"
                    />
                  </TextField>

                  <div className="kulo-field-action-row">
                    <TextField
                      className="kulo-form-field flex-1"
                      variant="secondary"
                      fullWidth
                      isReadOnly={busy}
                      value={token}
                      onChange={(value) => {
                        setToken(value);
                        if (value.trim()) setClearToken(false);
                        setError(null);
                      }}
                    >
                      <Label>{t("长期访问令牌", "Long-lived access token")}</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder={
                          hasSavedToken
                            ? t("已保存，留空保持不变", "Saved, leave blank to keep")
                            : t("粘贴 Home Assistant 长期访问令牌", "Paste Home Assistant token")
                        }
                      />
                    </TextField>
                    {hasSavedToken && (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={busy}
                        onPress={() => {
                          setClearToken(true);
                          setToken("");
                        }}
                      >
                        {t("清除", "Clear")}
                      </Button>
                    )}
                  </div>

                  {canDeployLocal && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-muted">
                        {t("本机容器", "Local container")}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={!connected || busy}
                        isPending={deploying}
                        onPress={() => setConfirmDeployOpen(true)}
                      >
                        {deploying ? <Spinner size="sm" color="current" /> : t("本机启动 Home Assistant", "Start local Home Assistant")}
                      </Button>
                    </div>
                  )}

                  {error && (
                    <Alert status="danger" role="alert">
                      <Alert.Indicator />
                      <Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content>
                    </Alert>
                  )}
                </form>
              </Modal.Body>
              <Modal.Footer>
                {onRequestGuide && (
                  <Button
                    variant="ghost"
                    className="mr-auto"
                    isDisabled={busy}
                    onPress={() => {
                      close();
                      onRequestGuide();
                    }}
                  >
                    {t("配网引导", "Setup guide")}
                  </Button>
                )}
                <Button variant="tertiary" isDisabled={busy} onPress={close}>
                  {t("取消", "Cancel")}
                </Button>
                <Button
                  type="submit"
                  form="kulo-ha-config"
                  variant="primary"
                  isPending={saving}
                  isDisabled={!connected || busy || (enabled && !baseUrl.trim())}
                >
                  {saving ? t("正在连接", "Connecting") : t("保存", "Save")}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AlertDialog isOpen={confirmDeployOpen} onOpenChange={setConfirmDeployOpen}>
        <AlertDialog.Backdrop isDismissable={!deploying} isKeyboardDismissDisabled={deploying}>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>{t("启动本机 Home Assistant？", "Start local Home Assistant?")}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-sm text-muted">
                  {t(
                    "将在本机 127.0.0.1:8123 启动官方稳定镜像，并自动预装小米官方无损集成（数据保存在 ~/.kulo-homeassistant）。",
                    "Starts the official stable container on 127.0.0.1:8123 with official Xiaomi Home pre-installed (~/.kulo-homeassistant).",
                  )}
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" isDisabled={deploying} onPress={() => setConfirmDeployOpen(false)}>
                  {t("取消", "Cancel")}
                </Button>
                <Button variant="primary" isPending={deploying} onPress={() => void deployLocal()}>
                  {deploying ? t("正在启动", "Starting") : t("确认启动", "Start")}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>
  );
}
