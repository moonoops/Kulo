import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Label, ListBox, Modal, Select, TextArea, TextField } from "@heroui/react";
import type { ConnectionKind, ConnectionRecordView, ConnectionSetupInput } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { translate as t, useI18n } from "../../kulo-i18n";
import {
  ConnectionFollowupActions,
  ConnectionFollowupBody,
  useConnectionFollowup,
} from "./connection-followup";
import {
  clearConnectionDraftSecrets,
  connectionSaveRequest,
  createConnectionDraft,
  safeConnectionInputError,
  type ConnectionCredentialDraft,
  type ConnectionDraft,
} from "./connection-setup-inputs";
import { CredentialFormFields, isSshTargetChanged } from "./credential-form-fields";

export type CredentialModalKind = "ssh" | "account" | "api-key" | "custom";

const MODAL_CREDENTIAL_KINDS: readonly CredentialModalKind[] = ["ssh", "account", "api-key", "custom"];

function credentialKindLabel(kind: CredentialModalKind): string {
  switch (kind) {
    case "ssh": return t("SSH 服务器", "SSH server");
    case "account": return t("账号", "Account");
    case "api-key": return "API Key";
    case "custom": return t("自定义凭据", "Custom credentials");
  }
}

function buildSyntheticInput(mode: "create" | "edit", kind: CredentialModalKind, existing?: ConnectionRecordView): ConnectionSetupInput {
  return {
    id: existing ? `credential-modal-edit-${existing.id}` : "credential-modal-create",
    clientId: "credential-modal",
    kind: existing?.kind ?? kind,
    category: "credential",
    ...(existing ? { connectionId: existing.id, expectedRevision: existing.revision } : {}),
    status: "pending",
    createdAt: 0,
  };
}

function CredentialSshFollowupStage({
  connection,
  connected,
  available,
  localHost,
  onChanged,
  onBusyChange,
  onClose,
}: {
  connection: ConnectionRecordView;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  useI18n();
  const { state, openingSettings, permissionNotice, statusRef, check, openLocalNetworkSettings } = useConnectionFollowup({
    connection,
    connected,
    available,
    localHost,
    onChanged,
  });
  const busy = state.phase === "checking" || openingSettings;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  return (
    <>
      <Modal.Header className="flex flex-row items-center justify-between gap-2">
        <Modal.Heading className="font-semibold">{connection.name}</Modal.Heading>
        <Modal.CloseTrigger aria-label={t("关闭", "Close")} className="static" isDisabled={busy} onPress={onClose} />
      </Modal.Header>
      <Modal.Body className="kulo-form-stack">
        <ConnectionFollowupBody state={state} permissionNotice={permissionNotice} statusRef={statusRef} />
      </Modal.Body>
      <Modal.Footer className="flex-wrap justify-end gap-2">
        <ConnectionFollowupActions
          state={state}
          connected={connected}
          available={available}
          localHost={localHost}
          openingSettings={openingSettings}
          onClose={onClose}
          onCheck={(options) => void check(options)}
          onOpenLocalNetwork={() => void openLocalNetworkSettings()}
        />
      </Modal.Footer>
    </>
  );
}

export function CredentialConfigModal({
  open,
  mode,
  initialKind = "ssh",
  existing,
  connected,
  available,
  localHost,
  onSaved,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  initialKind?: CredentialModalKind;
  existing?: ConnectionRecordView;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  onSaved: (saved: ConnectionRecordView) => void;
  onClose: () => void;
}) {
  useI18n();
  const effectiveKind: CredentialModalKind =
    existing && (existing.kind === "ssh" || existing.kind === "account" || existing.kind === "api-key" || existing.kind === "custom")
      ? existing.kind
      : initialKind;
  const syntheticInput = buildSyntheticInput(mode, effectiveKind, existing);
  const [draft, setDraft] = useState<ConnectionDraft>(() => createConnectionDraft(syntheticInput, existing));
  const [busy, setBusy] = useState(false);
  const [followupBusy, setFollowupBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lock Stage 2 target in local state so background snapshot polling cannot retrigger testConnection on revision bump.
  const [followupTarget, setFollowupTarget] = useState<ConnectionRecordView | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const addFieldRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const nextInput = buildSyntheticInput(mode, effectiveKind, existing);
    setDraft(createConnectionDraft(nextInput, existing));
    setBusy(false);
    setError(null);
    setFollowupTarget(null);
  }, [open, mode, effectiveKind, existing?.id, existing?.revision]);

  useEffect(() => {
    if (!connected || !available) setDraft(clearConnectionDraftSecrets);
  }, [connected, available]);

  const disabled = !connected || !available || busy;
  const change = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const focusField = (key?: string) => requestAnimationFrame(() => {
    const field = key ? formRef.current?.querySelector<HTMLInputElement>(`[data-credential-field-name="${key}"]`) : addFieldRef.current;
    field?.focus();
  });
  const changeField = (key: string, patch: Partial<ConnectionCredentialDraft>) => {
    setError(null);
    setDraft((current) => ({ ...current, credentialFields: current.credentialFields.map((item) => item.key === key ? { ...item, ...patch } : item) }));
  };
  const addField = () => {
    const key = `field_${globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
    setDraft((current) => current.credentialFields.length >= 32 ? current : { ...current, credentialFields: [...current.credentialFields, { key, label: "", value: "" }] });
    focusField(key);
  };
  const removeField = (key: string) => {
    const index = draft.credentialFields.findIndex((item) => item.key === key);
    const next = draft.credentialFields[index + 1]?.key ?? draft.credentialFields[index - 1]?.key;
    setDraft((current) => ({ ...current, credentialFields: current.credentialFields.filter((item) => item.key !== key) }));
    focusField(next);
  };

  const submit = async () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const payload = connectionSaveRequest(draft, syntheticInput);
      if (isSshTargetChanged(draft, existing)) {
        const hasNewSecret = Boolean(payload.secrets?.password || payload.secrets?.privateKey);
        if (!hasNewSecret) {
          throw new Error(t("修改 SSH 服务器地址、端口或用户名时，请重新输入密码或私钥。", "Re-enter the password or private key when changing the SSH host, port, or username."));
        }
      }
      const res = await kuloRest.saveConnection(payload);
      if (!mountedRef.current) return;
      const saved = res.connection;
      setDraft(clearConnectionDraftSecrets);
      onSaved(saved);
      if (saved.kind === "ssh" && saved.hasCredential && Boolean(saved.host && saved.username) && saved.status !== "verified") {
        setFollowupTarget(saved);
      } else {
        onClose();
      }
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(safeConnectionInputError(cause, draft));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const title = mode === "edit"
    ? t(`编辑${existing?.name ? `「${existing.name}」` : "凭据"}`, existing?.name ? `Edit “${existing.name}”` : "Edit credentials")
    : draft.kind === "ssh"
      ? t("添加 SSH 凭据", "Add SSH credentials")
      : t("添加凭据", "Add credentials");

  const modalBusy = busy || followupBusy;

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next && !modalBusy) onClose(); }}>
      <Modal.Backdrop isOpen={open} isDismissable={!modalBusy} isKeyboardDismissDisabled={modalBusy} onOpenChange={(next) => { if (!next && !modalBusy) onClose(); }}>
        <Modal.Container placement="center" size="lg" scroll="inside">
          <Modal.Dialog aria-label={followupTarget ? t(`连接 ${followupTarget.name}`, `Connect ${followupTarget.name}`) : title} className="w-full max-w-[560px] rounded-3xl">
            {followupTarget ? (
              <CredentialSshFollowupStage
                key={`${followupTarget.id}:${followupTarget.revision}`}
                connection={followupTarget}
                connected={connected}
                available={available}
                localHost={localHost}
                onChanged={() => onSaved(followupTarget)}
                onBusyChange={setFollowupBusy}
                onClose={onClose}
              />
            ) : (
              <>
                <Modal.Header className="flex flex-row items-center justify-between gap-2">
                  <Modal.Heading className="font-semibold">{title}</Modal.Heading>
                  <Modal.CloseTrigger aria-label={t("关闭", "Close")} className="static" isDisabled={busy} onPress={onClose} />
                </Modal.Header>
                <Modal.Body>
                  <form
                    ref={formRef}
                    id="kulo-credential-config-form"
                    className="kulo-form-stack"
                    autoComplete="off"
                    onSubmit={(event) => { event.preventDefault(); void submit(); }}
                  >
                    {!available && (
                      <Alert status="warning">
                        <Alert.Indicator />
                        <Alert.Content><Alert.Title>{t("本地凭据库不可用", "Local credential vault unavailable")}</Alert.Title></Alert.Content>
                      </Alert>
                    )}
                    {error && (
                      <Alert status="danger" role="alert">
                        <Alert.Indicator />
                        <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
                      </Alert>
                    )}
                    {mode === "create" && (
                      <Select
                        className="kulo-form-field"
                        variant="secondary"
                        value={draft.kind}
                        onChange={(value) => {
                          if (!value) return;
                          const nextKind = String(value) as ConnectionKind;
                          setError(null);
                          setDraft((current) => clearConnectionDraftSecrets({
                            ...current,
                            kind: nextKind,
                            typeLabel: nextKind === "custom" && !current.typeLabel ? t("自定义凭据", "Custom credentials") : current.typeLabel,
                            credentialFields: nextKind === "custom" && !current.credentialFields.length
                              ? [{ key: "credential", label: t("凭据", "Credentials"), value: "" }]
                              : current.credentialFields,
                          }));
                        }}
                        isDisabled={disabled}
                        fullWidth
                      >
                        <Label>{t("凭据类型", "Credential type")}</Label>
                        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            {MODAL_CREDENTIAL_KINDS.map((kind) => (
                              <ListBox.Item key={kind} id={kind} textValue={credentialKindLabel(kind)}>
                                {credentialKindLabel(kind)}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
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
                      isDisabled={disabled}
                      fullWidth
                    >
                      <Label>{t("名称", "Name")}</Label>
                      <Input autoFocus maxLength={120} autoComplete="off" placeholder={draft.kind === "ssh" ? t("例如：开发服务器", "e.g. Dev server") : ""} />
                    </TextField>
                    {draft.kind === "custom" && (
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        value={draft.typeLabel}
                        onChange={(value) => change("typeLabel", value)}
                        isRequired
                        isDisabled={disabled}
                        fullWidth
                      >
                        <Label>{t("分类说明", "Type label")}</Label>
                        <Input maxLength={120} autoComplete="off" />
                      </TextField>
                    )}
                    <CredentialFormFields
                      draft={draft}
                      existing={existing}
                      disabled={disabled}
                      fieldVariant="secondary"
                      addFieldRef={addFieldRef}
                      onChange={change}
                      onSetDraft={setDraft}
                      onChangeField={changeField}
                      onAddField={addField}
                      onRemoveField={removeField}
                    />
                    <TextField
                      className="kulo-form-field"
                      variant="secondary"
                      value={draft.instructions}
                      onChange={(value) => change("instructions", value)}
                      isDisabled={disabled}
                      fullWidth
                    >
                      <Label>{t("用途", "Purpose")}</Label>
                      <TextArea rows={2} className="scrollbar" maxLength={8000} autoComplete="off" />
                    </TextField>
                  </form>
                </Modal.Body>
                <Modal.Footer className="flex-wrap justify-end gap-2">
                  <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t("取消", "Cancel")}</Button>
                  <Button type="submit" form="kulo-credential-config-form" variant="primary" isPending={busy} isDisabled={disabled}>
                    {draft.kind === "ssh" ? t("保存并连接", "Save and connect") : t("保存凭据", "Save credentials")}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
