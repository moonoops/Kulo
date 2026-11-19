import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Label, Modal, TextArea, TextField, toast } from "@heroui/react";
import { KuloApiError } from "../../kulo-api";
import { deviceApi } from "./device-api";

export function JoinDeviceModal({
  open,
  onClose,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  onJoined: () => Promise<void> | void;
}) {
  useI18n();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsForce, setNeedsForce] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput("");
    setBusy(false);
    setNeedsForce(false);
    setError(undefined);
  }, [open]);

  useEffect(() => () => {
    requestRef.current?.abort();
  }, []);

  const close = () => {
    if (busy) return;
    requestRef.current?.abort();
    onClose();
  };

  const submit = async (force: boolean) => {
    const trimmed = input.trim();
    if (busy || !trimmed) return;
    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      await deviceApi.join(trimmed, force, undefined, controller.signal);
      if (controller.signal.aborted) return;
      setInput("");
      toast.success(t("已接入主机", "Joined host"));
      await onJoined();
    } catch (err) {
      if (controller.signal.aborted) return;
      if (!force && err instanceof KuloApiError && err.code === "local_tasks_running") {
        setNeedsForce(true);
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t("接入主机失败", "Failed to join host"));
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) close(); }}>
      <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={busy}>
        <Modal.Container placement="center" size="md" scroll="inside">
          <Modal.Dialog aria-label={t("接入现有主机", "Join host")}>
            <Modal.Header className="kulo-add-device-header">
              <Modal.Heading>{t("接入现有主机", "Join host")}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭接入现有主机", "Close join host")} className="kulo-add-device-close" isDisabled={busy} />
            </Modal.Header>
            <Modal.Body>
              <form
                id="kulo-device-join"
                className="kulo-form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(needsForce);
                }}
              >
                <TextField
                  className="kulo-form-field"
                  variant="secondary"
                  fullWidth
                  isRequired
                  isReadOnly={busy}
                  value={input}
                  onChange={(value) => {
                    setInput(value);
                    setNeedsForce(false);
                    setError(undefined);
                  }}
                >
                  <Label>{t("接入命令", "Connection command")}</Label>
                  <TextArea
                    ref={textareaRef}
                    className="scrollbar resize-y"
                    rows={4}
                    autoFocus
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="curl -fsSL 'http://192.168.1.10:7788/connect/install.sh' | sh -s -- ..."
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void submit(needsForce);
                      }
                    }}
                  />
                </TextField>
                {error && (
                  <Alert role="alert" status={needsForce ? "warning" : "danger"}>
                    <Alert.Indicator />
                    <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
                  </Alert>
                )}
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={close}>{t("取消", "Cancel")}</Button>
              <Button
                type="submit"
                form="kulo-device-join"
                variant={needsForce ? "danger" : "primary"}
                isPending={busy}
                isDisabled={!input.trim()}
              >
                {busy ? t("正在接入", "Joining host") : needsForce ? t("停止本地任务并接入", "Stop local tasks and join") : t("接入主机", "Join host")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
