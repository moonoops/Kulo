import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Disclosure,
  Input,
  Label,
  Modal,
  Spinner,
  TextField,
} from "@heroui/react";
import {
  redactSensitiveText,
  type ConnectionRecordView,
  type McpOAuthSessionView,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { useI18n } from "../../kulo-i18n";

export function McpOAuthModal({
  open,
  connection,
  clientId,
  forceReauth = false,
  hostedAggregator = false,
  onCompleted,
  onClose,
}: {
  open: boolean;
  connection: ConnectionRecordView | null;
  clientId?: string;
  forceReauth?: boolean;
  hostedAggregator?: boolean;
  onCompleted: (connection?: ConnectionRecordView) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [session, setSession] = useState<McpOAuthSessionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redirectInput, setRedirectInput] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completedSessionRef = useRef<string | null>(null);
  const startedKeyRef = useRef<string | null>(null);

  const startSession = async (target: ConnectionRecordView, force: boolean) => {
    setStarting(true);
    setError(null);
    setSession(null);
    setRedirectInput("");
    try {
      const res = await kuloRest.startConnectionOAuth(target.id, {
        ...(clientId ? { clientId } : {}),
        ...(force ? { forceReauth: true } : {}),
      });
      setSession(res.session);
      if (res.session.status === "pending" && res.session.authorizationUrl) {
        try {
          window.open(res.session.authorizationUrl, "_blank", "noopener,noreferrer");
        } catch {
          // User can click the explicit authorization link below.
        }
      }
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("无法启动授权流程，请重试。", "Failed to start sign-in. Try again.")));
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!open || !connection) {
      startedKeyRef.current = null;
      setSession(null);
      setError(null);
      setRedirectInput("");
      setStarting(false);
      return;
    }
    const key = `${connection.id}:${forceReauth ? "force" : "normal"}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    completedSessionRef.current = null;
    void startSession(connection, forceReauth);
  }, [open, connection?.id, forceReauth]);

  useEffect(() => {
    if (
      !open ||
      !session ||
      session.status !== "completed" ||
      completedSessionRef.current === session.sessionId
    ) {
      return;
    }
    completedSessionRef.current = session.sessionId;
    onCompleted(session.connection);
  }, [open, session?.sessionId, session?.status, session?.connection, onCompleted]);

  useEffect(() => {
    if (!open || !session || (session.status !== "pending" && session.status !== "authorized")) return;
    const sessionId = session.sessionId;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await kuloRest.getConnectionOAuth(sessionId, clientId);
        if (!cancelled) setSession(res.session);
      } catch {
        // Ignore transient poll errors while waiting for callback.
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, session?.sessionId, session?.status, clientId]);

  const handleClose = async () => {
    if (starting) return;
    if (session && (session.status === "pending" || session.status === "authorized")) {
      try {
        await kuloRest.cancelConnectionOAuth(session.sessionId, clientId);
      } catch {
        // Ignore cancel failure when session already settled.
      }
    }
    onClose();
  };

  const handleManualComplete = async () => {
    if (!session || submitting || !redirectInput.trim()) return;
    const pasted = redirectInput.trim();
    setSubmitting(true);
    setError(null);
    try {
      const res = await kuloRest.completeConnectionOAuth(session.sessionId, {
        ...(clientId ? { clientId } : {}),
        redirectUrl: pasted,
      });
      setSession(res.session);
      setRedirectInput("");
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("回调验证失败，请重试。", "Failed to verify redirect URL. Try again."), [pasted]));
    } finally {
      setSubmitting(false);
    }
  };

  const copyAuthorizationUrl = async () => {
    if (!session?.authorizationUrl) return;
    setError(null);
    try {
      if (!navigator.clipboard) throw new Error(t("当前环境无法复制链接", "Clipboard is unavailable"));
      await navigator.clipboard.writeText(session.authorizationUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } catch (cause) {
      setError(redactSensitiveText(cause instanceof Error ? cause.message : t("复制链接失败", "Failed to copy link")));
    }
  };

  const appName = connection?.name ?? "MCP";
  const inProgress = starting || session?.status === "pending" || session?.status === "authorized";

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !starting) void handleClose();
      }}
    >
      <Modal.Backdrop
        isOpen={open}
        isDismissable={!inProgress}
        onOpenChange={(next) => {
          if (!next && !starting) void handleClose();
        }}
      >
        <Modal.Container placement="center" size="md" scroll="inside">
          <Modal.Dialog
            aria-label={t(`${appName} 授权登录`, `${appName} sign-in`)}
            className="w-full max-w-[520px] rounded-3xl"
          >
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <Modal.Heading className="font-semibold">
                {t(`授权连接 ${appName}`, `Sign in to ${appName}`)}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("关闭", "Close")}
                className="static"
                isDisabled={starting}
                onPress={() => void handleClose()}
              />
            </Modal.Header>

            <Modal.Body className="kulo-form-stack">
              {hostedAggregator && (
                <Alert status="default">
                  <Alert.Content>
                    <Alert.Description>
                      {t("此连接由第三方云端托管应用授权与工具执行。", "App authorizations and tool execution are hosted by this third-party service.")}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {starting && (
                <div className="flex items-center gap-2.5 rounded-2xl bg-surface-secondary p-4 text-sm text-foreground" role="status">
                  <Spinner size="sm" />
                  <span>{t("正在准备授权页面…", "Preparing sign-in…")}</span>
                </div>
              )}

              {session?.status === "pending" && (
                <div className="flex items-center gap-2.5 rounded-2xl bg-surface-secondary p-4 text-sm text-foreground" role="status">
                  <Spinner size="sm" />
                  <span>{t("等待浏览器完成授权…", "Waiting for browser authorization…")}</span>
                </div>
              )}

              {session?.status === "authorized" && (
                <div className="flex items-center gap-2.5 rounded-2xl bg-surface-secondary p-4 text-sm text-foreground" role="status">
                  <Spinner size="sm" />
                  <span>{t("已授权，正在同步可用工具…", "Authorized, discovering tools…")}</span>
                </div>
              )}

              {session?.status === "completed" && (
                <Alert status="success">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>
                      {session.connection?.mcpTools?.length
                        ? t(`已连接 · ${session.connection.mcpTools.length} 项工具`, `Connected · ${session.connection.mcpTools.length} tools`)
                        : t("授权登录成功", "Signed in successfully")}
                    </Alert.Title>
                  </Alert.Content>
                </Alert>
              )}

              {(session?.status === "failed" || session?.status === "cancelled") && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>
                      {redactSensitiveText(
                        session.error ||
                          (session.status === "cancelled"
                            ? t("已取消授权登录", "Sign-in cancelled")
                            : t("授权登录失败", "Sign-in failed")),
                      )}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {error && (
                <Alert status="danger" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {session?.status === "pending" && session.authorizationUrl && (
                <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-secondary p-4">
                  <a
                    href={session.authorizationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-(--kulo-control-height) items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground no-underline transition-opacity hover:opacity-90"
                  >
                    {t("打开授权页面", "Open sign-in page")}
                  </a>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => void copyAuthorizationUrl()}
                  >
                    {copiedLink ? t("已复制", "Copied") : t("复制链接", "Copy link")}
                  </Button>
                </div>
              )}

              {session?.status === "pending" && (
                <Disclosure>
                  <Disclosure.Heading>
                    <Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">
                      {t("手动粘贴回调地址", "Paste redirect URL manually")}
                      <Disclosure.Indicator />
                    </Button>
                  </Disclosure.Heading>
                  <Disclosure.Content>
                    <Disclosure.Body className="kulo-form-stack pt-2">
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={redirectInput}
                        onChange={setRedirectInput}
                        isDisabled={submitting}
                        fullWidth
                      >
                        <Label>{t("回调地址", "Redirect URL")}</Label>
                        <Input
                          type="url"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={session.redirectUrl ? `${session.redirectUrl}?code=...` : "http://127.0.0.1:..."}
                        />
                      </TextField>
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="secondary"
                          isPending={submitting}
                          isDisabled={submitting || !redirectInput.trim()}
                          onPress={() => void handleManualComplete()}
                        >
                          {t("完成授权", "Complete sign-in")}
                        </Button>
                      </div>
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>
              )}
            </Modal.Body>

            <Modal.Footer className="flex flex-row justify-end gap-2">
              {connection && (session?.status === "failed" || session?.status === "cancelled" || (!session && error)) && (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={starting}
                  onPress={() => void startSession(connection, forceReauth)}
                >
                  {t("重试", "Retry")}
                </Button>
              )}
              <Button
                size="sm"
                variant={session?.status === "completed" ? "secondary" : "tertiary"}
                isDisabled={starting}
                onPress={() => void handleClose()}
              >
                {session?.status === "completed" ? t("完成", "Done") : t("关闭", "Close")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
