import type { RefObject } from "react";
import { Button, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import type { ConnectionAuthType, ConnectionRecordView } from "@kulo/protocol";
import { translate as t, useI18n } from "../../kulo-i18n";
import {
  clearConnectionDraftSecrets,
  type ConnectionCredentialDraft,
  type ConnectionDraft,
} from "./connection-setup-inputs";

export function isSshTargetChanged(draft: ConnectionDraft, existing?: ConnectionRecordView): boolean {
  if (draft.kind !== "ssh" || existing?.kind !== "ssh" || !existing.hasCredential) return false;
  const hostChanged = Boolean(existing.host) && draft.host.trim() !== existing.host;
  const userChanged = Boolean(existing.username) && draft.username.trim() !== existing.username;
  const portNum = Number(draft.port);
  const portChanged = Boolean(existing.host) && Number.isInteger(portNum) && portNum !== (existing.port ?? 22);
  return hostChanged || userChanged || portChanged;
}

export function CredentialFormFields({
  draft,
  existing,
  disabled,
  fieldVariant,
  addFieldRef,
  onChange,
  onSetDraft,
  onChangeField,
  onAddField,
  onRemoveField,
}: {
  draft: ConnectionDraft;
  existing?: ConnectionRecordView;
  disabled: boolean;
  fieldVariant: "primary" | "secondary";
  addFieldRef: RefObject<HTMLButtonElement | null>;
  onChange: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void;
  onSetDraft: (updater: (current: ConnectionDraft) => ConnectionDraft) => void;
  onChangeField: (key: string, patch: Partial<ConnectionCredentialDraft>) => void;
  onAddField: () => void;
  onRemoveField: (key: string) => void;
}) {
  useI18n();
  const targetChanged = isSshTargetChanged(draft, existing);
  const secretPlaceholder = targetChanged
    ? t("地址或账号已修改，请重新输入", "Target changed; enter again")
    : existing?.hasCredential
      ? t("已保存，留空保留", "Saved; leave blank to keep")
      : "";
  const isPassword =
    draft.kind === "account" ||
    (draft.kind === "ssh" && draft.sshAuth === "password") ||
    (draft.kind === "api-key" && draft.authType === "basic");

  return (
    <>
      {draft.kind === "custom" ? (
        <>
          {draft.credentialFields.map((field, index) => (
            <div
              key={field.key}
              role="group"
              aria-label={field.label.trim() || t(`字段 ${index + 1}`, `Field ${index + 1}`)}
              className="kulo-form-stack rounded-xl border border-border p-3"
            >
              <div className="kulo-field-action-row">
                <TextField
                  variant={fieldVariant}
                  className="kulo-form-field min-w-0 flex-1"
                  value={field.label}
                  onChange={(value) => onChangeField(field.key, { label: value })}
                  isRequired
                  isDisabled={disabled}
                  fullWidth
                >
                  <Label>{t(`字段 ${index + 1} 名称`, `Field ${index + 1} name`)}</Label>
                  <Input className="kulo-field-action-input" data-credential-field-name={field.key} maxLength={120} autoComplete="off" />
                </TextField>
                <Button
                  size="sm"
                  variant="ghost"
                  className="kulo-field-action-button"
                  aria-label={t(`移除${field.label.trim() || `字段 ${index + 1}`}`, `Remove ${field.label.trim() || `field ${index + 1}`}`)}
                  isDisabled={disabled}
                  onPress={() => onRemoveField(field.key)}
                >
                  {t("移除", "Remove")}
                </Button>
              </div>
              <TextField
                className="kulo-form-field"
                variant={fieldVariant}
                value={field.value}
                onChange={(value) => onChangeField(field.key, { value })}
                isDisabled={disabled}
                fullWidth
              >
                <Label>{field.label.trim() || t(`字段 ${index + 1} 内容`, `Field ${index + 1} content`)}</Label>
                <TextArea
                  rows={3}
                  className="scrollbar font-mono [-webkit-text-security:disc]"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    existing?.secretFields.includes(field.key)
                      ? t("已保存，留空保留", "Saved; leave blank to keep")
                      : draft.category === "information"
                        ? t("填写内容", "Enter content")
                        : t("填写凭据", "Enter credentials")
                  }
                />
              </TextField>
            </div>
          ))}
          <Button
            ref={addFieldRef}
            size="sm"
            variant="secondary"
            isDisabled={disabled || draft.credentialFields.length >= 32}
            onPress={onAddField}
          >
            {t("添加字段", "Add field")}
          </Button>
        </>
      ) : draft.kind === "ssh" ? (
        <>
          <TextField
            className="kulo-form-field"
            variant={fieldVariant}
            value={draft.host}
            onChange={(value) => onChange("host", value)}
            isRequired
            isDisabled={disabled}
            fullWidth
          >
            <Label>{t("服务器地址", "Server address")}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder={t("服务器 IP 或域名", "Server IP or domain")} />
          </TextField>
          <div className="kulo-form-grid kulo-form-grid--port">
            <TextField
              className="kulo-form-field"
              variant={fieldVariant}
              value={draft.username}
              onChange={(value) => onChange("username", value)}
              isRequired
              isDisabled={disabled}
              fullWidth
            >
              <Label>{t("用户名", "Username")}</Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
            <TextField
              className="kulo-form-field"
              variant={fieldVariant}
              value={draft.port}
              onChange={(value) => onChange("port", value)}
              isRequired
              isDisabled={disabled}
              fullWidth
            >
              <Label>{t("端口", "Port")}</Label>
              <Input inputMode="numeric" autoComplete="off" />
            </TextField>
          </div>
          <Select
            className="kulo-form-field"
            variant={fieldVariant}
            value={draft.sshAuth}
            onChange={(value) => {
              if (value) onSetDraft((current) => clearConnectionDraftSecrets({ ...current, sshAuth: String(value) as ConnectionDraft["sshAuth"] }));
            }}
            isDisabled={disabled}
            fullWidth
          >
            <Label>{t("认证方式", "Authentication")}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="password" textValue={t("密码", "Password")}>{t("密码", "Password")}<ListBox.ItemIndicator /></ListBox.Item>
                <ListBox.Item id="private-key" textValue={t("SSH 私钥", "SSH private key")}>{t("SSH 私钥", "SSH private key")}<ListBox.ItemIndicator /></ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
          {draft.sshAuth === "private-key" && (
            <>
              <TextField
                className="kulo-form-field"
                variant={fieldVariant}
                value={draft.privateKey}
                onChange={(value) => onChange("privateKey", value)}
                isRequired={targetChanged || !existing?.hasCredential}
                isDisabled={disabled}
                fullWidth
              >
                <Label>{t("SSH 私钥", "SSH private key")}</Label>
                <TextArea
                  rows={4}
                  className="scrollbar font-mono [-webkit-text-security:disc]"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secretPlaceholder || t("粘贴 SSH 私钥", "Paste SSH private key")}
                />
              </TextField>
              <TextField
                className="kulo-form-field"
                variant={fieldVariant}
                type="password"
                value={draft.passphrase}
                onChange={(value) => onChange("passphrase", value)}
                isDisabled={disabled}
                fullWidth
              >
                <Label>{t("私钥口令", "Key passphrase")}</Label>
                <Input autoComplete="new-password" spellCheck={false} placeholder={targetChanged ? "" : secretPlaceholder} />
              </TextField>
            </>
          )}
        </>
      ) : (
        <>
          <TextField
            className="kulo-form-field"
            variant={fieldVariant}
            value={draft.url}
            onChange={(value) => onChange("url", value)}
            isDisabled={disabled}
            fullWidth
          >
            <Label>{draft.kind === "account" ? t("网站地址", "Website URL") : t("API 地址", "API URL")}</Label>
            <Input type="url" autoComplete="off" spellCheck={false} placeholder="https://" />
          </TextField>
          {draft.kind === "api-key" && (
            <Select
              className="kulo-form-field"
              variant={fieldVariant}
              value={draft.authType}
              onChange={(value) => {
                if (value) onSetDraft((current) => clearConnectionDraftSecrets({ ...current, authType: String(value) as ConnectionAuthType }));
              }}
              isDisabled={disabled}
              fullWidth
            >
              <Label>{t("认证方式", "Authentication")}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="bearer" textValue="Bearer Token">Bearer Token<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item id="header" textValue={t("API Key 请求头", "API key header")}>{t("API Key 请求头", "API key header")}<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item id="basic" textValue="HTTP Basic">HTTP Basic<ListBox.ItemIndicator /></ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          )}
          {draft.kind === "api-key" && draft.authType === "header" && (
            <TextField
              className="kulo-form-field"
              variant={fieldVariant}
              value={draft.headerName}
              onChange={(value) => onChange("headerName", value)}
              isDisabled={disabled}
              fullWidth
            >
              <Label>{t("请求头名称", "Header name")}</Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
          )}
          {isPassword && (
            <TextField
              className="kulo-form-field"
              variant={fieldVariant}
              value={draft.username}
              onChange={(value) => onChange("username", value)}
              isDisabled={disabled}
              fullWidth
            >
              <Label>{t("账号", "Account")}</Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
          )}
          {!isPassword && (
            <TextField
              className="kulo-form-field"
              variant={fieldVariant}
              type="password"
              value={draft.apiKey}
              onChange={(value) => onChange("apiKey", value)}
              isDisabled={disabled}
              fullWidth
            >
              <Label>API Key</Label>
              <Input autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder} />
            </TextField>
          )}
        </>
      )}
      {isPassword && (
        <TextField
          className="kulo-form-field"
          variant={fieldVariant}
          type="password"
          value={draft.password}
          onChange={(value) => onChange("password", value)}
          isRequired={draft.kind === "ssh" && (targetChanged || !existing?.hasCredential)}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("密码", "Password")}</Label>
          <Input autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder} />
        </TextField>
      )}
    </>
  );
}
