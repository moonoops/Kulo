import { useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  TextField,
} from "@heroui/react";
import type { OAuthSessionView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { KuloIcon } from "../../kulo-icon";
import {
  SUBSCRIPTION_PROVIDERS,
  normalizeClientOAuthOptionLabel,
  normalizeClientOAuthProgress,
  normalizeClientOAuthPromptLabel,
} from "./settings-helpers";

export function OAuthSubscriptionModal({
  open,
  initialProviderId,
  session,
  starting,
  externalError,
  onClearError,
  onStart,
  onUpdate,
  onResetSession,
  onCompleted,
  onClose,
}: {
  open: boolean;
  initialProviderId: string;
  session: OAuthSessionView | null;
  starting: boolean;
  externalError?: string;
  onClearError?: () => void;
  onStart: (providerId: string) => Promise<void>;
  onUpdate: (next: OAuthSessionView) => void;
  onResetSession: () => void;
  onCompleted: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(initialProviderId);
  const [promptInput, setPromptInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [modalError, setModalError] = useState<string>();
  const completedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (open && !session) {
      setSelectedId(initialProviderId);
      setModalError(undefined);
    }
  }, [open, initialProviderId, session]);

  useEffect(() => {
    setPromptInput("");
    setModalError(undefined);
  }, [session?.prompt?.id, session?.sessionId]);

  useEffect(() => {
    if (
      !open ||
      session?.status !== "completed" ||
      completedSessionRef.current === session.sessionId
    ) return;
    completedSessionRef.current = session.sessionId;
    onCompleted();
  }, [open, session?.sessionId, session?.status, onCompleted]);

  useEffect(() => {
    if (!open || !session || session.status !== "pending") return;
    const sessionId = session.sessionId;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await kuloRest.getProviderOAuth(sessionId);
        if (!cancelled) onUpdate(res.session);
      } catch {
        // Ignore transient poll errors while waiting
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, session?.sessionId, session?.status, onUpdate]);

  const submitPrompt = async (value: string) => {
    if (submitting || !session) return;
    setSubmitting(true);
    setModalError(undefined);
    try {
      const res = await kuloRest.respondProviderOAuth(
        session.sessionId,
        session.prompt?.id,
        value,
      );
      onUpdate(res.session);
      setPromptInput("");
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("提交认证信息失败", "Failed to submit authentication details"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (starting) return;
    if (session?.status === "pending") {
      try {
        await kuloRest.cancelProviderOAuth(session.sessionId);
      } catch {
        // Ignore cancel failure if already closed
      }
    }
    onClose();
  };

  const copyDeviceCode = async () => {
    if (!session?.deviceCode?.userCode) return;
    setModalError(undefined);
    try {
      if (!navigator.clipboard) throw new Error(t("当前环境无法复制设备码", "Cannot copy the device code in this environment"));
      await navigator.clipboard.writeText(session.deviceCode.userCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("复制设备码失败", "Failed to copy device code"));
    }
  };

  const providerLabel = session
    ? SUBSCRIPTION_PROVIDERS.find((p) => p.id === session.providerId)?.label ??
    session.providerId
    : t("添加订阅接入", "Add subscription");

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !starting) void handleCancel();
      }}
    >
      <Modal.Backdrop
        isOpen={open}
        isDismissable={!starting && session?.status !== "pending"}
        onOpenChange={(next) => {
          if (!next && !starting) void handleCancel();
        }}
      >
        <Modal.Container placement="center" size="md" scroll="inside">
          <Modal.Dialog
            aria-label={session ? t(`${providerLabel} 授权登录`, `${providerLabel} sign-in`) : t("添加订阅接入", "Add subscription")}
            className="w-full max-w-[520px] rounded-3xl"
          >
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <Modal.Heading className="font-semibold">
                {session ? providerLabel : t("添加订阅接入", "Add subscription")}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("关闭", "Close")}
                className="static"
                isDisabled={starting}
                onPress={() => void handleCancel()}
              />
            </Modal.Header>

            <Modal.Body className="kulo-form-stack">
              {!session ? (
                <>
                  <Select className="kulo-form-field"
                    variant="secondary"
                    value={selectedId}
                    isDisabled={starting}
                    onChange={(val) => {
                      if (val) {
                        setSelectedId(String(val));
                        setModalError(undefined);
                        onClearError?.();
                      }
                    }}
                    fullWidth
                  >
                    <Label className="text-sm font-medium text-muted">{t("订阅类型", "Subscription type")}</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {SUBSCRIPTION_PROVIDERS.map((sub) => (
                          <ListBox.Item key={sub.id} id={sub.id} textValue={sub.label}>
                            {sub.label}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>

                  {(modalError || externalError) && (
                    <Alert status="danger" className="rounded-xl p-3">
                      <Alert.Indicator />
                      <Alert.Content className="text-sm">
                        {modalError || externalError}
                      </Alert.Content>
                    </Alert>
                  )}
                </>
              ) : (
                <>
                  {session.status === "pending" &&
                    !(session.prompt?.type === "select" && !session.progressMessage) && (
                      <div className="flex items-center gap-2.5 rounded-2xl bg-surface-secondary p-4 text-sm text-foreground">
                        <Spinner size="sm" />
                        <span>{normalizeClientOAuthProgress(session.progressMessage)}</span>
                      </div>
                    )}

                  {session.status === "completed" && (
                    <Alert status="success" className="rounded-xl p-3">
                      <Alert.Indicator />
                      <Alert.Content className="text-sm font-semibold">
                        
                        {t("授权登录成功", "Signed in successfully")}
                      </Alert.Content>
                    </Alert>
                  )}

                  {(session.status === "failed" || session.status === "cancelled") && (
                    <Alert status="danger" className="rounded-xl p-3">
                      <Alert.Indicator />
                      <Alert.Content className="text-sm">
                        {session.error ||
                          (session.status === "cancelled" ? t("已取消登录", "Sign-in canceled") : t("授权登录失败", "Sign-in failed"))}
                      </Alert.Content>
                    </Alert>
                  )}

                  {session.authUrl && (
                    <div className="flex flex-col gap-2 rounded-2xl bg-surface-secondary p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={session.authUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-(--kulo-control-height) items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground no-underline transition-opacity hover:opacity-90"
                        >
                          
                          {t("打开授权页面", "Open sign-in page")}
                        </a>
                        <code className="min-w-0 flex-1 break-all font-mono text-xs text-muted">
                          {session.authUrl}
                        </code>
                      </div>
                    </div>
                  )}

                  {session.deviceCode && (
                    <div className="flex flex-col gap-2 rounded-2xl bg-surface-secondary p-4">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="text-xs text-muted">{t("设备码", "Device code")}</span>
                        <Chip
                          size="md"
                          variant="soft"
                          color="accent"
                          className="font-mono text-lg font-semibold tracking-wider"
                        >
                          {session.deviceCode.userCode}
                        </Chip>
                        <Button size="sm" variant="ghost" onPress={() => void copyDeviceCode()}>
                          <KuloIcon name={copiedCode ? "check" : "copy"} size={14} />
                          {copiedCode ? t("已复制", "Copied") : t("复制", "Copy")}
                        </Button>
                      </div>
                      {session.deviceCode.verificationUri && (
                        <a
                          href={session.deviceCode.verificationUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all text-xs text-accent underline"
                        >
                          {session.deviceCode.verificationUri}
                        </a>
                      )}
                    </div>
                  )}

                  {session.infoMessages.length > 0 && (
                    <div className="flex flex-col gap-1 rounded-2xl bg-surface-secondary p-4 text-xs text-muted">
                      {session.infoMessages.map((msg, i) => (
                        <div key={`${i}-${msg}`}>{msg}</div>
                      ))}
                    </div>
                  )}

                  {session.prompt && session.status === "pending" && (
                    <div className="flex flex-col gap-2.5 rounded-2xl bg-surface-secondary p-4">
                      <span className="text-sm font-semibold text-foreground">
                        {normalizeClientOAuthPromptLabel(
                          session.prompt.message,
                          session.prompt.type,
                        )}
                      </span>
                      {session.prompt.type === "select" && session.prompt.options ? (
                        <div className="flex flex-col gap-1.5">
                          {session.prompt.options.map((opt) => (
                            <Button
                              key={opt.id}
                              size="sm"
                              variant="secondary"
                              className="justify-start"
                              isDisabled={submitting}
                              onPress={() => void submitPrompt(opt.id)}
                            >
                              {normalizeClientOAuthOptionLabel(opt.id, opt.label)}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <form
                          className="kulo-field-action-row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void submitPrompt(promptInput);
                          }}
                        >
                          <TextField
                            variant="primary"
                            aria-label={normalizeClientOAuthPromptLabel(
                              session.prompt.message,
                              session.prompt.type,
                            )}
                            type={session.prompt.type === "secret" ? "password" : "text"}
                            value={promptInput}
                            onChange={setPromptInput}
                            className="kulo-context-field min-w-0 flex-1"
                            fullWidth
                          >
                            <Input
                              className="kulo-field-action-input"
                              placeholder={session.prompt.placeholder || ""}
                              autoFocus
                            />
                          </TextField>
                          <Button
                            type="submit"
                            size="sm"
                            variant="primary"
                            className="kulo-field-action-button"
                            isPending={submitting}
                            isDisabled={submitting || !promptInput.trim()}
                          >
                            {submitting ? t("提交中…", "Submitting…") : t("提交", "Submit")}
                          </Button>
                        </form>
                      )}
                    </div>
                  )}

                  {(modalError || externalError) && (
                    <Alert status="danger" className="rounded-xl p-3">
                      <Alert.Indicator />
                      <Alert.Content className="text-sm">
                        {modalError || externalError}
                      </Alert.Content>
                    </Alert>
                  )}
                </>
              )}
            </Modal.Body>

            <Modal.Footer className="flex items-center justify-end gap-2">
              {!session ? (
                <>
                  <Button variant="ghost" isDisabled={starting} onPress={onClose}>
                    
                    {t("取消", "Cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    isPending={starting}
                    isDisabled={starting}
                    onPress={() => void onStart(selectedId)}
                  >
                    {starting ? t("连接中…", "Connecting…") : t("开始授权", "Sign in")}
                  </Button>
                </>
              ) : (
                <>
                  {(session.status === "failed" || session.status === "cancelled") && (
                    <Button size="sm" variant="secondary" onPress={onResetSession}>
                      
                      {t("更换类型", "Change type")}
                    </Button>
                  )}
                  <Button variant="ghost" onPress={() => void handleCancel()}>
                    {session.status === "pending" ? t("取消", "Cancel") : t("关闭", "Close")}
                  </Button>
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
