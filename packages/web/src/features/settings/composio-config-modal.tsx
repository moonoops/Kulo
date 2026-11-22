import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Disclosure,
  Input,
  Label,
  Link,
  Modal,
  TextField,
} from "@heroui/react";
import { redactSensitiveText, type ConnectionRecordView } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import { composioApi } from "./composio-api";

export function ComposioConfigModal({
  open,
  existing,
  connected,
  vaultAvailable,
  onSaved,
  onClose,
}: {
  open: boolean;
  existing?: ConnectionRecordView | null;
  connected: boolean;
  vaultAvailable: boolean;
  onSaved: (connection: ConnectionRecordView, isNew: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("Composio");
  const [apiKey, setApiKey] = useState("");
  const [toolkitsText, setToolkitsText] = useState("");
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = Boolean(existing);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? "Composio");
    setApiKey("");
    setToolkitsText((existing?.mcpAllowedToolkits ?? []).join(", "));
    setScopeExpanded(Boolean(existing?.mcpAllowedToolkits?.length));
    setSubmitting(false);
    setError(null);
  }, [open, existing?.id, existing?.revision]);

  const handleSubmit = async () => {
    if (!connected || !vaultAvailable || submitting) return;
    const trimmedName = name.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedName) {
      setError(t("请填写连接名称。", "Enter a connection name."));
      return;
    }
    if (!isEdit && !trimmedKey) {
      setError(t("请填写 Composio Project API Key（ak_…）。", "Enter your Composio Project API Key (ak_…)."));
      return;
    }
    const allowedToolkits = toolkitsText
      .split(/[\s,，]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    setSubmitting(true);
    setError(null);
    try {
      const res = await composioApi.connectSession({
        ...(existing ? { id: existing.id, expectedRevision: existing.revision } : {}),
        name: trimmedName,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        allowedToolkits,
      });
      setApiKey("");
      onSaved(res.connection, !isEdit);
    } catch (cause) {
      setError(
        redactSensitiveText(
          cause instanceof Error ? cause.message : t("保存 Composio 连接失败，请重试。", "Failed to save Composio connection."),
          trimmedKey ? [trimmedKey] : [],
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const heading = isEdit
    ? t(`编辑 ${existing?.name ?? "Composio"}`, `Edit ${existing?.name ?? "Composio"}`)
    : t("连接 Composio", "Connect Composio");

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <Modal.Backdrop
        isOpen={open}
        isDismissable={!submitting}
        onOpenChange={(next) => {
          if (!next && !submitting) onClose();
        }}
      >
        <Modal.Container placement="center" size="md" scroll="inside">
          <Modal.Dialog
            aria-label={heading}
            className="w-full max-w-[520px] rounded-3xl"
          >
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <Modal.Heading className="font-semibold">{heading}</Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("关闭", "Close")}
                className="static"
                isDisabled={submitting}
                onPress={onClose}
              />
            </Modal.Header>

            <Modal.Body className="kulo-form-stack">
              <Alert status="default">
                <Alert.Content>
                  <Alert.Description>
                    {t("由 Composio 云端托管第三方应用授权与工具执行。", "Third-party app authorizations and tool execution are hosted by Composio.")}
                  </Alert.Description>
                </Alert.Content>
              </Alert>

              {error && (
                <Alert status="danger" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              <form
                id="kulo-composio-config-form"
                autoComplete="off"
                className="kulo-form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSubmit();
                }}
              >
                <Link
                  className="self-start text-xs"
                  href="https://dashboard.composio.dev/~/project/settings/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("获取 Composio Project API Key (ak_…)", "Get Composio Project API Key (ak_…)")}
                  <Link.Icon />
                </Link>

                <TextField
                  className="kulo-form-field"
                  variant="secondary"
                  value={name}
                  onChange={(value) => {
                    setName(value);
                    setError(null);
                  }}
                  isRequired
                  isDisabled={submitting}
                  fullWidth
                >
                  <Label>{t("连接名称", "Connection name")}</Label>
                  <Input maxLength={120} autoComplete="off" />
                </TextField>

                <TextField
                  className="kulo-form-field"
                  variant="secondary"
                  type="password"
                  value={apiKey}
                  onChange={(value) => {
                    setApiKey(value);
                    setError(null);
                  }}
                  isRequired={!isEdit}
                  isDisabled={submitting}
                  fullWidth
                >
                  <Label>Project API Key</Label>
                  <Input
                    autoFocus={!isEdit}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={isEdit ? t("已保存，留空保留", "Saved, leave blank to keep") : "ak_..."}
                  />
                </TextField>

                <Disclosure isExpanded={scopeExpanded} onExpandedChange={setScopeExpanded}>
                  <Disclosure.Heading>
                    <Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">
                      {t("限制应用范围（可选）", "Limit allowed apps (optional)")}
                      <Disclosure.Indicator />
                    </Button>
                  </Disclosure.Heading>
                  <Disclosure.Content>
                    <Disclosure.Body className="kulo-form-stack pt-2">
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={toolkitsText}
                        onChange={(value) => {
                          setToolkitsText(value);
                          setError(null);
                        }}
                        isDisabled={submitting}
                        fullWidth
                      >
                        <Label>{t("允许的应用标识（逗号分隔，留空不限）", "Allowed toolkit slugs (comma-separated)")}</Label>
                        <Input
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="gmail, googlecalendar, googledrive"
                        />
                      </TextField>
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>
              </form>
            </Modal.Body>

            <Modal.Footer className="flex flex-row justify-end gap-2">
              <Button size="sm" variant="tertiary" isDisabled={submitting} onPress={onClose}>
                {t("取消", "Cancel")}
              </Button>
              <Button
                size="sm"
                type="submit"
                form="kulo-composio-config-form"
                variant="secondary"
                isPending={submitting}
                isDisabled={submitting || !connected || !vaultAvailable}
              >
                {t("保存并连接", "Save & connect")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
