import { translate as t, useI18n } from "../../moco-i18n";
import { useEffect, useRef, useState } from "react";
import { Button, Card, Disclosure, Input, Label, Link, ListBox, Select, TextArea, TextField } from "@heroui/react";
import {
  redactSensitiveText,
  type ConnectionAuthType,
  type ConnectionApplicationId,
  type ConnectionApplicationView,
  type ConnectionCategory,
  type ConnectionKind,
  type ConnectionCredentialField,
  type ConnectionRecordView,
  type ConnectionSaveRequest,
  type ConnectionSetupInput,
} from "@moco/protocol";
import { mocoRest } from "../../moco-api";

export const CONNECTION_KIND_LABEL: Record<ConnectionKind, string> = { ssh: "SSH 服务器", account: "账号", "api-key": "API Key", custom: "自定义凭据", app: "预置应用" };
const CREDENTIAL_TEMPLATES = (["account", "ssh", "api-key", "custom"] as const).map((id) => ({ id, label: CONNECTION_KIND_LABEL[id] }));
const connectionKindLabel = (kind: ConnectionKind) => t(CONNECTION_KIND_LABEL[kind], { ssh: "SSH server", account: "Account", "api-key": "API Key", custom: "Custom credentials", app: "Built-in app" }[kind]);
const RESERVED_CREDENTIAL_KEYS = new Set(["__binding", "__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]);

export interface ConnectionCredentialDraft extends ConnectionCredentialField {
  value: string;
}

export interface ConnectionDraft {
  kind: ConnectionKind;
  category: ConnectionCategory;
  appId?: ConnectionApplicationId;
  name: string;
  host: string;
  port: string;
  username: string;
  url: string;
  authType: ConnectionAuthType;
  headerName: string;
  sshAuth: "password" | "private-key";
  password: string;
  privateKey: string;
  passphrase: string;
  apiKey: string;
  typeLabel: string;
  instructions: string;
  credentialFields: ConnectionCredentialDraft[];
}

export function createConnectionDraft(input: ConnectionSetupInput, existing?: ConnectionRecordView): ConnectionDraft {
  const kind = input.kind ?? existing?.kind ?? "ssh";
  const category = input.category ?? existing?.category ?? (kind === "app" ? "app" : "credential");
  const schema = input.credentialFields ?? existing?.credentialFields
    ?? (kind === "custom" && existing?.secretFields.length ? existing.secretFields.map((key) => ({ key, label: key })) : kind === "custom" ? [{ key: "credential", label: category === "information" ? t("内容", "Content") : t("凭据", "Credentials") }] : []);
  return {
    kind, category, appId: input.appId ?? existing?.appId,
    name: input.name ?? existing?.name ?? "",
    host: input.host ?? existing?.host ?? "",
    port: String(input.port ?? existing?.port ?? 22),
    username: input.username ?? existing?.username ?? "",
    url: input.url ?? existing?.url ?? "",
    authType: input.authType ?? existing?.authType ?? "bearer",
    headerName: input.headerName ?? existing?.headerName ?? "X-API-Key",
    sshAuth: existing?.secretFields.includes("privateKey") ? "private-key" : "password",
    password: "", privateKey: "", passphrase: "", apiKey: "",
    typeLabel: input.typeLabel ?? existing?.typeLabel ?? (kind === "custom" ? category === "information" ? t("其他信息", "Other information") : t("自定义凭据", "Custom credentials") : ""),
    instructions: input.instructions ?? existing?.instructions ?? "",
    credentialFields: schema.map(({ key, label }) => ({ key, label, value: "" })),
  };
}

export function clearConnectionDraftSecrets(draft: ConnectionDraft): ConnectionDraft {
  return { ...draft, password: "", privateKey: "", passphrase: "", apiKey: "", credentialFields: draft.credentialFields.map((field) => ({ ...field, value: "" })) };
}

export function connectionSaveRequest(draft: ConnectionDraft, input: ConnectionSetupInput): ConnectionSaveRequest {
  if (!draft.name.trim()) throw new Error(t("请输入连接名称。", "Enter a connection name."));
  const request: ConnectionSaveRequest = {
    name: draft.name.trim(), kind: draft.kind, category: draft.category,
    ...(input.connectionId ? { id: input.connectionId, expectedRevision: input.expectedRevision } : {}),
  };
  if (draft.typeLabel.trim()) request.typeLabel = draft.typeLabel.trim();
  if (draft.kind === "custom" || input.connectionId || draft.instructions || input.instructions !== undefined) request.instructions = draft.instructions.trim();
  if (draft.typeLabel.trim().length > 120) throw new Error(t("凭据类型最多 120 字。", "Credential type must be at most 120 characters."));
  if (draft.instructions.trim().length > 8000) throw new Error(t("用途最多 8000 字。", "Purpose must be at most 8,000 characters."));
  if (draft.kind === "app") {
    if (!draft.appId) throw new Error(t("请选择预置应用。", "Select a built-in app."));
    request.category = "app";
    request.appId = draft.appId;
    if (draft.apiKey) request.secrets = { apiKey: draft.apiKey };
  } else if (draft.kind === "custom") {
    if (!draft.typeLabel.trim()) throw new Error(t("请输入凭据类型。", "Enter a credential type."));
    if (draft.credentialFields.length > 32) throw new Error(t("最多添加 32 个凭据字段。", "You can add up to 32 credential fields."));
    const keys = new Set<string>();
    request.credentialFields = draft.credentialFields.map(({ key, label }) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || RESERVED_CREDENTIAL_KEYS.has(key) || keys.has(key)) throw new Error(t("凭据字段无效，请重新添加。", "Invalid credential field. Add it again."));
      if (!label.trim() || label.trim().length > 120) throw new Error(t("请输入 1 到 120 字的字段名称。", "Enter a field name between 1 and 120 characters."));
      keys.add(key);
      return { key, label: label.trim() };
    });
    const changed = draft.credentialFields.filter((field) => field.value !== "");
    if (changed.some((field) => new TextEncoder().encode(field.value).byteLength > 256 * 1024 || field.value.includes("\0"))) throw new Error(t("凭据内容过长或包含无效字符。", "Credential content is too long or contains invalid characters."));
    if (changed.length) request.secrets = Object.fromEntries(changed.map(({ key, value }) => [key, value]));
    if (request.secrets && new TextEncoder().encode(JSON.stringify(request.secrets)).byteLength > 768 * 1024) throw new Error(t("凭据内容总大小不能超过 768 KiB。", "Total credential content cannot exceed 768 KiB."));
  } else if (draft.kind === "ssh") {
    if (!draft.host.trim()) throw new Error(t("请输入服务器地址。", "Enter a server address."));
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("端口必须在 1 到 65535 之间。", "Port must be between 1 and 65535."));
    request.host = draft.host.trim();
    request.port = port;
    request.username = draft.username.trim();
    if (draft.sshAuth === "private-key") {
      if (draft.privateKey.trim() || draft.passphrase) request.secrets = { ...(draft.privateKey.trim() ? { privateKey: draft.privateKey } : {}), ...(draft.passphrase ? { passphrase: draft.passphrase } : {}) };
    } else if (draft.password) request.secrets = { password: draft.password };
  } else {
    request.url = draft.url.trim();
    if (request.url) {
      let parsed: URL;
      try { parsed = new URL(request.url); } catch { throw new Error(t("请输入有效的网站或 API 地址。", "Enter a valid website or API URL.")); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(t("地址应为 HTTPS，且不能包含账号密码。", "Use an HTTPS URL without a username or password."));
    }
    if (draft.kind === "account" || draft.authType === "basic") {
      request.username = draft.username.trim();
      request.authType = "basic";
      if (draft.password) request.secrets = { password: draft.password };
    } else {
      request.authType = draft.authType;
      if (draft.authType === "header") request.headerName = draft.headerName.trim();
      if (draft.apiKey) request.secrets = { apiKey: draft.apiKey };
    }
  }
  return request;
}

export function safeConnectionInputError(error: unknown, draft?: ConnectionDraft): string {
  const values = draft ? [draft.password, draft.privateKey, draft.passphrase, draft.apiKey, ...draft.credentialFields.map((field) => field.value)] : [];
  return redactSensitiveText(error instanceof Error ? error.message : t("保存失败，请重试。", "Failed to save. Try again."), values.filter(Boolean));
}

export function visibleConnectionInputs(inputs: ConnectionSetupInput[], clientId: string): ConnectionSetupInput[] {
  return inputs.filter((input) => input.status === "pending" && input.clientId === clientId);
}

export function ConnectionSetupForm({ input, existing, application, clientId, connected, available, onChanged, onCompleted, onCancelled }: {
  input: ConnectionSetupInput;
  existing?: ConnectionRecordView;
  application?: ConnectionApplicationView;
  clientId: string;
  connected: boolean;
  available: boolean;
  onChanged: () => void;
  onCompleted?: (connection: ConnectionRecordView) => void;
  onCancelled?: () => void;
}) {
  useI18n();
  const [draft, setDraft] = useState(() => createConnectionDraft(input, existing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nativeHeadingRef = useRef<HTMLHeadingElement>(null);
  const addFieldRef = useRef<HTMLButtonElement>(null);
  const isApp = draft.kind === "app";
  const nativeApp = isApp && application?.authentication === "macos";
  const maySave = available || nativeApp;
  const disabled = !connected || !maySave || busy || finished || isApp && !application;
  const change = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const changeField = (key: string, updates: Partial<Pick<ConnectionCredentialDraft, "label" | "value">>) => setDraft((current) => ({ ...current, credentialFields: current.credentialFields.map((field) => field.key === key ? { ...field, ...updates } : field) }));
  const focusField = (key?: string) => requestAnimationFrame(() => {
    const field = [...(formRef.current?.querySelectorAll<HTMLInputElement>("[data-credential-field-name]") ?? [])].find((element) => element.dataset.credentialFieldName === key);
    (field ?? addFieldRef.current)?.focus();
  });
  const addField = () => {
    const key = `field_${globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
    setDraft((current) => current.credentialFields.length >= 32 ? current : { ...current, credentialFields: [...current.credentialFields, { key, label: "", value: "" }] });
    focusField(key);
  };
  const removeField = (key: string) => {
    const index = draft.credentialFields.findIndex((field) => field.key === key);
    const next = draft.credentialFields[index + 1]?.key ?? draft.credentialFields[index - 1]?.key;
    setDraft((current) => ({ ...current, credentialFields: current.credentialFields.filter((field) => field.key !== key) }));
    focusField(next);
  };
  useEffect(() => { if (!connected || !available) setDraft(clearConnectionDraftSecrets); }, [connected, available]);
  useEffect(() => {
    if (!nativeApp) return;
    const frame = requestAnimationFrame(() => nativeHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [nativeApp, input.id]);

  const submit = async (cancel = false) => {
    if (busy || !connected || finished) return;
    if (input.clientId !== clientId || input.status !== "pending") { setError(t("请在发起配置的窗口继续。", "Continue in the window where you started setup.")); return; }
    setBusy(true); setError(null);
    try {
      if (cancel) { await mocoRest.cancelConnectionInput(input.id, clientId); onCancelled?.(); }
      else {
        if (!maySave) throw new Error(t("本地凭据库暂不可用。", "The local credential vault is unavailable."));
        const saved = await mocoRest.submitConnectionInput(input.id, { ...connectionSaveRequest(draft, input), clientId });
        onCompleted?.(saved.connection);
      }
      setFinished(true);
      onChanged();
    } catch (cause) { setError(safeConnectionInputError(cause, draft)); }
    finally { setDraft(clearConnectionDraftSecrets); setBusy(false); }
  };

  if (finished) return null;
  const secretPlaceholder = existing?.hasCredential ? t("已保存，留空保留", "Saved; leave blank to keep") : "";
  const isPassword = draft.kind === "account" || draft.kind === "ssh" && draft.sshAuth === "password" || draft.kind === "api-key" && draft.authType === "basic";
  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={input.connectionId ? t("编辑连接授权", "Edit credentials & access") : t("添加连接授权", "Add credentials & access")}>
    <Card.Header><Card.Title ref={nativeHeadingRef} tabIndex={nativeApp ? -1 : undefined} className="rounded-sm text-sm outline-offset-4">{isApp ? t(`连接${application?.name ?? draft.name}`, `Connect ${application?.name ?? draft.name}`) : draft.category === "information" ? input.connectionId ? t("编辑信息", "Edit information") : t("记住其他信息", "Save other information") : input.connectionId ? t("编辑登录凭据", "Edit login credentials") : t("添加登录凭据", "Add login credentials")}</Card.Title></Card.Header>
    <form ref={formRef} autoComplete="off" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Card.Content className="moco-form-stack">
        {isApp ? <>
          {application?.instructions.length ? <ol className="list-decimal space-y-2 pl-4 text-xs text-muted">{application.instructions.map((instruction, index) => <li key={index}>{instruction}</li>)}</ol> : !application && <p role="alert" className="text-xs text-danger">{t("应用信息不可用，请重新打开。", "App information is unavailable. Open it again.")}</p>}
          {application?.helpUrl && <Link className="self-start text-xs" href={application.helpUrl} target="_blank" rel="noopener noreferrer">{t("官方指南", "Official guide")}<Link.Icon /></Link>}
          {application?.authentication === "token" && <TextField className="moco-form-field" variant="primary" type="password" value={draft.apiKey} onChange={(value) => change("apiKey", value)} isDisabled={disabled} fullWidth><Label>Token</Label><Input autoFocus autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder || t("粘贴 Token", "Paste token")} /></TextField>}
        </> : <>
        <TextField className="moco-form-field" variant="primary" value={draft.name} onChange={(value) => change("name", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("连接名称", "Connection name")}</Label><Input autoFocus maxLength={120} autoComplete="off" /></TextField>
        {!input.connectionId && draft.category !== "information" && <Disclosure><Disclosure.Heading><Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">{connectionKindLabel(draft.kind)}<Disclosure.Indicator /></Button></Disclosure.Heading><Disclosure.Content><Disclosure.Body className="pt-2">
          <Select className="moco-form-field" variant="primary" value={draft.kind} onChange={(value) => { if (value) setDraft((current) => clearConnectionDraftSecrets({ ...current, kind: String(value) as ConnectionKind,
            typeLabel: value === "custom" && !current.typeLabel ? t("自定义凭据", "Custom credentials") : current.typeLabel,
            credentialFields: value === "custom" && !current.credentialFields.length ? [{ key: "credential", label: t("凭据", "Credentials"), value: "" }] : current.credentialFields,
          })); }} isDisabled={disabled} fullWidth><Label>{t("登录方式", "Sign-in method")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox>{CREDENTIAL_TEMPLATES.map(({ id }) => <ListBox.Item key={id} id={id} textValue={connectionKindLabel(id)}>{connectionKindLabel(id)}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover></Select>
        </Disclosure.Body></Disclosure.Content></Disclosure>}
        {draft.kind === "custom" && <>
          {input.connectionId && <Select className="moco-form-field" variant="primary" value={draft.category} onChange={(value) => { if (value === "credential" || value === "information") change("category", value); }} isDisabled={disabled} fullWidth><Label>{t("保存到", "Save to")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="credential" textValue={t("登录凭据", "Login credentials")}>{t("登录凭据", "Login credentials")}<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="information" textValue={t("其他信息", "Other information")}>{t("其他信息", "Other information")}<ListBox.ItemIndicator /></ListBox.Item></ListBox></Select.Popover></Select>}
          {draft.category !== "information" && <TextField className="moco-form-field" variant="primary" value={draft.typeLabel} onChange={(value) => change("typeLabel", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("凭据类型", "Credential type")}</Label><Input maxLength={120} autoComplete="off" /></TextField>}
        </>}
        <TextField className="moco-form-field" variant="primary" value={draft.instructions} onChange={(value) => change("instructions", value)} isDisabled={disabled} fullWidth><Label>{t("用途", "Purpose")}</Label><TextArea rows={2} className="scrollbar" maxLength={8000} autoComplete="off" /></TextField>
        {draft.kind === "custom" ? <>
          {draft.credentialFields.map((field, index) => <div key={field.key} role="group" aria-label={field.label.trim() || t(`字段 ${index + 1}`, `Field ${index + 1}`)} className="moco-form-stack rounded-xl border border-border p-3">
            <div className="moco-field-action-row">
              <TextField variant="primary" className="moco-form-field min-w-0 flex-1" value={field.label} onChange={(value) => changeField(field.key, { label: value })} isRequired isDisabled={disabled} fullWidth><Label>{t(`字段 ${index + 1} 名称`, `Field ${index + 1} name`)}</Label><Input className="moco-field-action-input" data-credential-field-name={field.key} maxLength={120} autoComplete="off" /></TextField>
              <Button size="sm" variant="ghost" className="moco-field-action-button" aria-label={t(`移除${field.label.trim() || `字段 ${index + 1}`}`, `Remove ${field.label.trim() || `field ${index + 1}`}`)} isDisabled={disabled} onPress={() => removeField(field.key)}>{t("移除", "Remove")}</Button>
            </div>
            <TextField className="moco-form-field" variant="primary" value={field.value} onChange={(value) => changeField(field.key, { value })} isDisabled={disabled} fullWidth>
              <Label>{field.label.trim() || t(`字段 ${index + 1} 内容`, `Field ${index + 1} content`)}</Label>
              <TextArea rows={3} className="scrollbar font-mono [-webkit-text-security:disc]" autoComplete="off" spellCheck={false} placeholder={existing?.secretFields.includes(field.key) ? t("已保存，留空保留", "Saved; leave blank to keep") : draft.category === "information" ? t("填写内容", "Enter content") : t("填写凭据", "Enter credentials")} />
            </TextField>
          </div>)}
          <Button ref={addFieldRef} size="sm" variant="secondary" isDisabled={disabled || draft.credentialFields.length >= 32} onPress={addField}>{t("添加字段", "Add field")}</Button>
        </> : draft.kind === "ssh" ? <>
          <TextField className="moco-form-field" variant="primary" value={draft.host} onChange={(value) => change("host", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("服务器地址", "Server address")}</Label><Input autoComplete="off" spellCheck={false} placeholder={t("服务器 IP 或域名", "Server IP or domain")} /></TextField>
          <div className="moco-form-grid moco-form-grid--port">
            <TextField className="moco-form-field" variant="primary" value={draft.username} onChange={(value) => change("username", value)} isDisabled={disabled} fullWidth><Label>{t("用户名", "Username")}</Label><Input autoComplete="off" spellCheck={false} /></TextField>
            <TextField className="moco-form-field" variant="primary" value={draft.port} onChange={(value) => change("port", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("端口", "Port")}</Label><Input inputMode="numeric" autoComplete="off" /></TextField>
          </div>
          <Select className="moco-form-field" variant="primary" value={draft.sshAuth} onChange={(value) => { if (value) setDraft((current) => clearConnectionDraftSecrets({ ...current, sshAuth: String(value) as ConnectionDraft["sshAuth"] })); }} isDisabled={disabled} fullWidth>
            <Label>{t("认证方式", "Authentication")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox><ListBox.Item id="password" textValue={t("密码", "Password")}>{t("密码", "Password")}<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="private-key" textValue={t("SSH 私钥", "SSH private key")}>{t("SSH 私钥", "SSH private key")}<ListBox.ItemIndicator /></ListBox.Item></ListBox></Select.Popover>
          </Select>
          {draft.sshAuth === "private-key" && <>
            <TextField className="moco-form-field" variant="primary" value={draft.privateKey} onChange={(value) => change("privateKey", value)} isDisabled={disabled} fullWidth><Label>{t("SSH 私钥", "SSH private key")}</Label><TextArea rows={4} className="scrollbar font-mono [-webkit-text-security:disc]" autoComplete="off" spellCheck={false} placeholder={secretPlaceholder || t("粘贴 SSH 私钥", "Paste SSH private key")} /></TextField>
            <TextField className="moco-form-field" variant="primary" type="password" value={draft.passphrase} onChange={(value) => change("passphrase", value)} isDisabled={disabled} fullWidth><Label>{t("私钥口令", "Key passphrase")}</Label><Input autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder} /></TextField>
          </>}
        </> : <>
          <TextField className="moco-form-field" variant="primary" value={draft.url} onChange={(value) => change("url", value)} isDisabled={disabled} fullWidth><Label>{draft.kind === "account" ? t("网站地址", "Website URL") : t("API 地址", "API URL")}</Label><Input type="url" autoComplete="off" spellCheck={false} placeholder="https://" /></TextField>
          {draft.kind === "api-key" && <Select className="moco-form-field" variant="primary" value={draft.authType} onChange={(value) => { if (value) setDraft((current) => clearConnectionDraftSecrets({ ...current, authType: String(value) as ConnectionAuthType })); }} isDisabled={disabled} fullWidth>
            <Label>{t("认证方式", "Authentication")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox><ListBox.Item id="bearer" textValue="Bearer Token">Bearer Token<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="header" textValue={t("API Key 请求头", "API key header")}>{t("API Key 请求头", "API key header")}<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="basic" textValue="HTTP Basic">HTTP Basic<ListBox.ItemIndicator /></ListBox.Item></ListBox></Select.Popover>
          </Select>}
          {draft.kind === "api-key" && draft.authType === "header" && <TextField className="moco-form-field" variant="primary" value={draft.headerName} onChange={(value) => change("headerName", value)} isDisabled={disabled} fullWidth><Label>{t("请求头名称", "Header name")}</Label><Input autoComplete="off" spellCheck={false} /></TextField>}
          {isPassword && <TextField className="moco-form-field" variant="primary" value={draft.username} onChange={(value) => change("username", value)} isDisabled={disabled} fullWidth><Label>{t("账号", "Account")}</Label><Input autoComplete="off" spellCheck={false} /></TextField>}
          {!isPassword && <TextField className="moco-form-field" variant="primary" type="password" value={draft.apiKey} onChange={(value) => change("apiKey", value)} isDisabled={disabled} fullWidth><Label>API Key</Label><Input autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder} /></TextField>}
        </>}
        {isPassword && <TextField className="moco-form-field" variant="primary" type="password" value={draft.password} onChange={(value) => change("password", value)} isDisabled={disabled} fullWidth><Label>{t("密码", "Password")}</Label><Input autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder} /></TextField>}
        </>}
        {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      </Card.Content>
      <Card.Footer className="mt-3 justify-end gap-2">
        <Button size="sm" variant="tertiary" isDisabled={!connected || busy} onPress={() => void submit(true)}>{t("取消", "Cancel")}</Button>
        <Button size="sm" type="submit" variant="secondary" isPending={busy} isDisabled={disabled}>{nativeApp ? t("授权并连接", "Authorize and connect") : isApp ? t("连接应用", "Connect app") : draft.category === "information" ? t("保存信息", "Save information") : draft.kind === "ssh" ? t("保存并连接", "Save and connect") : t("保存凭据", "Save credentials")}</Button>
      </Card.Footer>
    </form>
  </Card>;
}

export function ConnectionSetupInputs({ inputs, connections, applications, clientId, ...props }: {
  inputs: ConnectionSetupInput[];
  connections: ConnectionRecordView[];
  applications?: ConnectionApplicationView[];
  clientId: string;
  connected: boolean;
  available: boolean;
  onChanged: () => void;
  onCompleted?: (connection: ConnectionRecordView) => void;
  onCancelled?: () => void;
}) {
  useI18n();
  return <>{visibleConnectionInputs(inputs, clientId).map((input) => <ConnectionSetupForm key={`${input.id}:${input.expectedRevision ?? 0}`} input={input} existing={connections.find((connection) => connection.id === input.connectionId)} application={applications?.find((application) => application.id === input.appId)} clientId={clientId} {...props} />)}</>;
}
