import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Disclosure, Input, Label, Link, ListBox, Select, TextArea, TextField } from "@heroui/react";
import {
  isValidMcpEnvKey,
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
  type McpAuthMode,
  type McpTransportKind,
  type NativeAppPermissionKind,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { openNativeAppPermissionSettings } from "../system-permissions/system-permissions";
import { CredentialFormFields, isSshTargetChanged } from "./credential-form-fields";

export const CONNECTION_KIND_LABEL: Record<ConnectionKind, string> = { ssh: "SSH 服务器", account: "账号", "api-key": "API Key", custom: "自定义凭据", app: "预置应用", mcp: "MCP 应用" };
const CREDENTIAL_TEMPLATES = (["account", "ssh", "api-key", "custom"] as const).map((id) => ({ id, label: CONNECTION_KIND_LABEL[id] }));
const connectionKindLabel = (kind: ConnectionKind) => t(CONNECTION_KIND_LABEL[kind], { ssh: "SSH server", account: "Account", "api-key": "API Key", custom: "Custom credentials", app: "Built-in app", mcp: "MCP app" }[kind]);
const RESERVED_CREDENTIAL_KEYS = new Set(["__binding", "__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]);

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

export function mcpAuthModeLabel(mode: McpAuthMode): string {
  switch (mode) {
    case "oauth": return "OAuth 2.1";
    case "bearer": return "Bearer Token";
    case "header": return t("自定义请求头", "Custom header");
    case "none": return t("无认证", "No auth");
  }
}

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
  clientSecret: string;
  typeLabel: string;
  instructions: string;
  credentialFields: ConnectionCredentialDraft[];
  mcpTransport: McpTransportKind;
  mcpPresetId?: string;
  mcpAuthMode: McpAuthMode;
  mcpOAuthClientId: string;
  mcpOAuthScope: string;
  mcpOAuthCallbackPort: string;
  mcpCommand: string;
  mcpArgsText: string;
  mcpCwd: string;
}

export function createConnectionDraft(input: ConnectionSetupInput, existing?: ConnectionRecordView): ConnectionDraft {
  const kind = input.kind ?? existing?.kind ?? "ssh";
  const category = input.category ?? existing?.category ?? (kind === "app" || kind === "mcp" ? "app" : "credential");
  const mcpTransport: McpTransportKind = input.mcpTransport ?? existing?.mcpTransport ?? (input.mcpCommand || existing?.mcpCommand ? "stdio" : "http");
  const schema = input.credentialFields ?? existing?.credentialFields
    ?? (kind === "custom" && existing?.secretFields.length
      ? existing.secretFields.map((key) => ({ key, label: key }))
      : kind === "custom"
        ? [{ key: "credential", label: category === "information" ? t("内容", "Content") : t("凭据", "Credentials") }]
        : kind === "mcp" && mcpTransport === "stdio" && existing?.secretFields.length
          ? existing.secretFields.map((key) => ({ key, label: key }))
          : []);
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
    password: "", privateKey: "", passphrase: "", apiKey: "", clientSecret: "",
    typeLabel: input.typeLabel ?? existing?.typeLabel ?? (kind === "custom" ? category === "information" ? t("其他信息", "Other information") : t("自定义凭据", "Custom credentials") : ""),
    instructions: input.instructions ?? existing?.instructions ?? "",
    credentialFields: schema.map(({ key, label }) => ({ key, label, value: "" })),
    mcpTransport,
    mcpPresetId: input.mcpPresetId ?? existing?.mcpPresetId,
    mcpAuthMode: input.mcpAuthMode ?? existing?.mcpAuthMode ?? "oauth",
    mcpOAuthClientId: input.mcpOAuthClientId ?? existing?.mcpOAuthClientId ?? "",
    mcpOAuthScope: input.mcpOAuthScope ?? existing?.mcpOAuthScope ?? "",
    mcpOAuthCallbackPort: input.mcpOAuthCallbackPort !== undefined
      ? String(input.mcpOAuthCallbackPort)
      : existing?.mcpOAuthCallbackPort !== undefined
        ? String(existing.mcpOAuthCallbackPort)
        : "",
    mcpCommand: input.mcpCommand ?? existing?.mcpCommand ?? "",
    mcpArgsText: (input.mcpArgs ?? existing?.mcpArgs ?? []).join("\n"),
    mcpCwd: input.mcpCwd ?? existing?.mcpCwd ?? "",
  };
}

export function clearConnectionDraftSecrets(draft: ConnectionDraft): ConnectionDraft {
  return { ...draft, password: "", privateKey: "", passphrase: "", apiKey: "", clientSecret: "", credentialFields: draft.credentialFields.map((field) => ({ ...field, value: "" })) };
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
  } else if (draft.kind === "mcp") {
    request.category = "app";
    request.mcpTransport = draft.mcpTransport;
    if (draft.mcpTransport === "http") {
      const rawUrl = draft.url.trim();
      if (!rawUrl) throw new Error(t("请输入 MCP 服务地址。", "Enter the MCP server URL."));
      let parsed: URL;
      try { parsed = new URL(rawUrl); } catch { throw new Error(t("请输入有效的 MCP 服务地址。", "Enter a valid MCP server URL.")); }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(t("MCP 服务地址不能包含账号、密码或查询参数。", "MCP URL cannot include credentials, query parameters, or fragments."));
      }
      if (parsed.protocol === "http:") {
        if (!isLoopbackHostname(parsed.hostname)) throw new Error(t("远程 MCP 服务地址必须使用 HTTPS。", "Remote MCP servers must use HTTPS."));
      } else if (parsed.protocol !== "https:") {
        throw new Error(t("远程 MCP 服务地址必须使用 HTTPS。", "Remote MCP servers must use HTTPS."));
      }
      request.url = parsed.href;
      request.mcpAuthMode = draft.mcpAuthMode;
      if (draft.mcpPresetId) request.mcpPresetId = draft.mcpPresetId;
      if (draft.mcpAuthMode === "header") {
        request.headerName = draft.headerName.trim() || "X-API-Key";
      }
      if (draft.mcpAuthMode === "bearer" || draft.mcpAuthMode === "header") {
        if (draft.apiKey) request.secrets = { apiKey: draft.apiKey };
      } else if (draft.mcpAuthMode === "oauth") {
        const clientId = draft.mcpOAuthClientId.trim();
        const scope = draft.mcpOAuthScope.trim();
        const portRaw = draft.mcpOAuthCallbackPort.trim();
        if (clientId) request.mcpOAuthClientId = clientId;
        if (scope) request.mcpOAuthScope = scope;
        if (portRaw) {
          const port = Number(portRaw);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new Error(t("OAuth 回调端口必须在 1024 到 65535 之间。", "OAuth callback port must be between 1024 and 65535."));
          }
          request.mcpOAuthCallbackPort = port;
        }
        if (clientId && draft.clientSecret) request.secrets = { clientSecret: draft.clientSecret };
      }
    } else {
      const command = draft.mcpCommand.trim();
      if (!command) throw new Error(t("请填写本机 MCP 启动命令。", "Enter the local MCP command."));
      if (command.startsWith("./") || command.startsWith("../") || command.includes("..")) {
        throw new Error(t("启动命令不能使用相对路径。", "Command cannot use relative paths."));
      }
      request.mcpCommand = command;
      const args = draft.mcpArgsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (args.length > 64) throw new Error(t("启动参数最多 64 项。", "At most 64 command arguments are allowed."));
      if (args.length) request.mcpArgs = args;
      const cwd = draft.mcpCwd.trim();
      if (cwd) request.mcpCwd = cwd;
      if (draft.credentialFields.length > 32) throw new Error(t("最多添加 32 个环境变量。", "You can add up to 32 environment variables."));
      const envKeys = new Set<string>();
      const schema: ConnectionCredentialField[] = [];
      const secrets: Record<string, string> = {};
      for (const field of draft.credentialFields) {
        const envKey = field.label.trim().toUpperCase();
        if (!isValidMcpEnvKey(envKey) || envKeys.has(envKey)) {
          throw new Error(t("环境变量名须为大写字母/数字/下划线，且不得重复或覆盖系统变量。", "Environment variable names must use uppercase letters, digits, and underscores without duplicating or overriding system variables."));
        }
        envKeys.add(envKey);
        schema.push({ key: envKey, label: envKey });
        if (field.value !== "") secrets[envKey] = field.value;
      }
      if (schema.length || input.connectionId) request.credentialFields = schema;
      if (Object.keys(secrets).length) request.secrets = secrets;
    }
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
  const values = draft ? [draft.password, draft.privateKey, draft.passphrase, draft.apiKey, draft.clientSecret, ...draft.credentialFields.map((field) => field.value)] : [];
  return redactSensitiveText(error instanceof Error ? error.message : t("保存失败，请重试。", "Failed to save. Try again."), values.filter(Boolean));
}

export interface NativePermissionPrompt {
  kind: NativeAppPermissionKind;
  opened: boolean;
  remote: boolean;
  message: string;
}

export function nativePermissionKindForError(error: unknown): NativeAppPermissionKind | null {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "connection_messages_full_disk_access_required") return "full-disk-access";
  if (code === "connection_app_automation_required") return "automation";
  return null;
}

export function nativePermissionPromptMessage(
  kind: NativeAppPermissionKind,
  state: "opened" | "remote" | "manual",
  appName: string,
  fallback?: string,
): string {
  if (kind === "full-disk-access") {
    if (state === "opened") return t("已打开系统设置的「完全磁盘访问权限」。开启后重启 Kulo，再点击重新检查。", "Opened Full Disk Access in System Settings. Allow the app running Kulo, restart Kulo, then check again.");
    if (state === "remote") return t("请在运行 Kulo 主脑的 Mac 上打开「系统设置 → 隐私与安全性 → 完全磁盘访问权限」，开启并重启后重新检查。", "On the Mac running the Kulo hub, open System Settings → Privacy & Security → Full Disk Access, allow Kulo, restart it, then check again.");
    return fallback || t("请在系统设置的「完全磁盘访问权限」中允许运行 Kulo 的应用，重启 Kulo 后重新检查。", "Allow the app running Kulo in System Settings → Full Disk Access, restart Kulo, then check again.");
  }
  if (kind === "local-network") {
    if (state === "opened") return t("已打开系统设置的「本地网络」。允许 Kulo 后重试连接。", "Opened Local Network in System Settings. Allow Kulo, then retry.");
    if (state === "remote") return t("请在运行 Kulo 主脑的 Mac 上打开「系统设置 → 隐私与安全性 → 本地网络」，允许 Kulo 后重试连接。", "On the Mac running the Kulo hub, open System Settings → Privacy & Security → Local Network, allow Kulo, then retry.");
    return fallback || t("请在系统设置的「本地网络」中允许运行 Kulo 的应用，然后重试连接。", "Allow Kulo in System Settings → Local Network, then retry.");
  }
  if (state === "opened") return t(`已打开系统设置的「自动化」。允许 Kulo 控制${appName}后点击重新检查。`, `Opened Automation in System Settings. Allow Kulo to control ${appName}, then check again.`);
  if (state === "remote") return t(`请在运行 Kulo 主脑的 Mac 上打开「系统设置 → 隐私与安全性 → 自动化」，允许 Kulo 控制${appName}后重新检查。`, `On the Mac running the Kulo hub, open System Settings → Privacy & Security → Automation, allow Kulo to control ${appName}, then check again.`);
  return fallback || t(`请在系统设置的「自动化」中允许 Kulo 控制${appName}，然后重新检查。`, `Allow Kulo to control ${appName} in System Settings → Automation, then check again.`);
}

export async function resolveNativePermissionPrompt(
  error: unknown,
  options: {
    appName: string;
    localHost?: boolean;
    openSettings?: (kind: NativeAppPermissionKind, options?: { localHost?: boolean }) => Promise<"opened" | "remote">;
  },
): Promise<NativePermissionPrompt | null> {
  const kind = nativePermissionKindForError(error);
  if (!kind) return null;
  const fallback = safeConnectionInputError(error);
  try {
    const outcome = await (options.openSettings ?? openNativeAppPermissionSettings)(kind, { localHost: options.localHost });
    return { kind, opened: outcome === "opened", remote: outcome === "remote", message: nativePermissionPromptMessage(kind, outcome, options.appName, fallback) };
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? cause.message : undefined;
    return { kind, opened: false, remote: false, message: nativePermissionPromptMessage(kind, "manual", options.appName, fallback || detail) };
  }
}

export function visibleConnectionInputs(inputs: ConnectionSetupInput[], clientId: string): ConnectionSetupInput[] {
  return inputs.filter((input) => input.status === "pending" && input.clientId === clientId);
}

export function ConnectionSetupForm({ input, existing, application, clientId, connected, available, localHost, canManageHub, initialPermissionPrompt = null, onChanged, onCompleted, onCancelled }: {
  input: ConnectionSetupInput;
  existing?: ConnectionRecordView;
  application?: ConnectionApplicationView;
  clientId: string;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  canManageHub?: boolean;
  initialPermissionPrompt?: NativePermissionPrompt | null;
  onChanged: () => void;
  onCompleted?: (connection: ConnectionRecordView) => void;
  onCancelled?: () => void;
}) {
  useI18n();
  const [draft, setDraft] = useState(() => createConnectionDraft(input, existing));
  const [busy, setBusy] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [permissionPrompt, setPermissionPrompt] = useState<NativePermissionPrompt | null>(initialPermissionPrompt);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const mountedRef = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  const nativeHeadingRef = useRef<HTMLHeadingElement>(null);
  const addFieldRef = useRef<HTMLButtonElement>(null);
  const isApp = draft.kind === "app";
  const nativeApp = isApp && application?.authentication === "macos";
  const appName = application?.name ?? draft.name;
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
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { if (!connected || !available) setDraft(clearConnectionDraftSecrets); }, [connected, available]);
  useEffect(() => {
    if (!nativeApp) return;
    const frame = requestAnimationFrame(() => nativeHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [nativeApp, input.id]);

  const openPermissionSettings = async (kind: NativeAppPermissionKind) => {
    if (openingSettings || busy || finished) return;
    setOpeningSettings(true);
    setError(null);
    try {
      const outcome = await openNativeAppPermissionSettings(kind, { localHost });
      if (!mountedRef.current) return;
      setPermissionPrompt({ kind, opened: outcome === "opened", remote: outcome === "remote", message: nativePermissionPromptMessage(kind, outcome, appName) });
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(safeConnectionInputError(cause));
    } finally {
      if (mountedRef.current) setOpeningSettings(false);
    }
  };

  const submit = async (cancel = false) => {
    if (busy || !connected || finished) return;
    if (input.clientId !== clientId || input.status !== "pending") { setError(t("请在发起配置的窗口继续。", "Continue in the window where you started setup.")); return; }
    setBusy(true); setError(null);
    if (cancel) setPermissionPrompt(null);
    try {
      if (cancel) { await kuloRest.cancelConnectionInput(input.id, clientId); onCancelled?.(); }
      else {
        if (!maySave) throw new Error(t("本地凭据库暂不可用。", "The local credential vault is unavailable."));
        const payload = connectionSaveRequest(draft, input);
        if (isSshTargetChanged(draft, existing) && !payload.secrets?.password && !payload.secrets?.privateKey) {
          throw new Error(t("修改 SSH 服务器地址、端口或用户名时，请重新输入密码或私钥。", "Re-enter the password or private key when changing the SSH host, port, or username."));
        }
        const saved = await kuloRest.submitConnectionInput(input.id, { ...payload, clientId });
        onCompleted?.(saved.connection);
      }
      if (!mountedRef.current) return;
      setPermissionPrompt(null);
      setFinished(true);
      onChanged();
    } catch (cause) {
      if (!mountedRef.current) return;
      if (!cancel && nativeApp) {
        const prompt = await resolveNativePermissionPrompt(cause, { appName, localHost });
        if (!mountedRef.current) return;
        if (prompt) { setPermissionPrompt(prompt); return; }
      }
      setPermissionPrompt(null);
      setError(safeConnectionInputError(cause, draft));
    }
    finally {
      if (mountedRef.current) { setDraft(clearConnectionDraftSecrets); setBusy(false); }
    }
  };

  if (finished) return null;
  const isMcp = draft.kind === "mcp";
  const secretPlaceholder = existing?.hasCredential ? t("已保存，留空保留", "Saved; leave blank to keep") : "";
  return <Card variant="secondary" className="min-w-0 gap-3 rounded-2xl p-3" aria-label={input.connectionId ? t("编辑连接授权", "Edit credentials & access") : t("添加连接授权", "Add credentials & access")}>
    <Card.Header><Card.Title ref={nativeHeadingRef} tabIndex={nativeApp ? -1 : undefined} className="rounded-sm text-sm outline-offset-4">{isApp ? t(`连接${application?.name ?? draft.name}`, `Connect ${application?.name ?? draft.name}`) : isMcp ? (input.connectionId ? t("编辑 MCP 应用", "Edit MCP app") : t("连接 MCP 应用", "Connect MCP app")) : draft.category === "information" ? input.connectionId ? t("编辑信息", "Edit information") : t("记住其他信息", "Save other information") : input.connectionId ? t("编辑登录凭据", "Edit login credentials") : t("添加登录凭据", "Add login credentials")}</Card.Title></Card.Header>
    <form ref={formRef} autoComplete="off" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Card.Content className="kulo-form-stack">
        {isApp ? <>
          {application?.instructions.length ? <ol className="list-decimal space-y-2 pl-4 text-xs text-muted">{application.instructions.map((instruction, index) => <li key={index}>{instruction}</li>)}</ol> : !application && <p role="alert" className="text-xs text-danger">{t("应用信息不可用，请重新打开。", "App information is unavailable. Open it again.")}</p>}
          {application?.helpUrl && <Link className="self-start text-xs" href={application.helpUrl} target="_blank" rel="noopener noreferrer">{t("官方指南", "Official guide")}<Link.Icon /></Link>}
          {application?.authentication === "token" && <TextField className="kulo-form-field" variant="primary" type="password" value={draft.apiKey} onChange={(value) => change("apiKey", value)} isDisabled={disabled} fullWidth><Label>Token</Label><Input autoFocus autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder || t("粘贴 Token", "Paste token")} /></TextField>}
        </> : <>
        <TextField className="kulo-form-field" variant="primary" value={draft.name} onChange={(value) => change("name", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("连接名称", "Connection name")}</Label><Input autoFocus maxLength={120} autoComplete="off" /></TextField>
        {!input.connectionId && draft.category !== "information" && !isMcp && <Disclosure><Disclosure.Heading><Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">{connectionKindLabel(draft.kind)}<Disclosure.Indicator /></Button></Disclosure.Heading><Disclosure.Content><Disclosure.Body className="pt-2">
          <Select className="kulo-form-field" variant="primary" value={draft.kind} onChange={(value) => { if (value) setDraft((current) => clearConnectionDraftSecrets({ ...current, kind: String(value) as ConnectionKind,
            typeLabel: value === "custom" && !current.typeLabel ? t("自定义凭据", "Custom credentials") : current.typeLabel,
            credentialFields: value === "custom" && !current.credentialFields.length ? [{ key: "credential", label: t("凭据", "Credentials"), value: "" }] : current.credentialFields,
          })); }} isDisabled={disabled} fullWidth><Label>{t("登录方式", "Sign-in method")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox>{CREDENTIAL_TEMPLATES.map(({ id }) => <ListBox.Item key={id} id={id} textValue={connectionKindLabel(id)}>{connectionKindLabel(id)}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover></Select>
        </Disclosure.Body></Disclosure.Content></Disclosure>}
        {draft.kind === "custom" && <>
          {input.connectionId && <Select className="kulo-form-field" variant="primary" value={draft.category} onChange={(value) => { if (value === "credential" || value === "information") change("category", value); }} isDisabled={disabled} fullWidth><Label>{t("保存到", "Save to")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="credential" textValue={t("登录凭据", "Login credentials")}>{t("登录凭据", "Login credentials")}<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="information" textValue={t("其他信息", "Other information")}>{t("其他信息", "Other information")}<ListBox.ItemIndicator /></ListBox.Item></ListBox></Select.Popover></Select>}
          {draft.category !== "information" && <TextField className="kulo-form-field" variant="primary" value={draft.typeLabel} onChange={(value) => change("typeLabel", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("凭据类型", "Credential type")}</Label><Input maxLength={120} autoComplete="off" /></TextField>}
        </>}
        {!isMcp && <TextField className="kulo-form-field" variant="primary" value={draft.instructions} onChange={(value) => change("instructions", value)} isDisabled={disabled} fullWidth><Label>{t("用途", "Purpose")}</Label><TextArea rows={2} className="scrollbar" maxLength={8000} autoComplete="off" /></TextField>}
        {isMcp ? <>
          {!input.connectionId && Boolean(canManageHub ?? localHost) && <Select className="kulo-form-field" variant="primary" value={draft.mcpTransport} onChange={(value) => { if (value === "http" || value === "stdio") setDraft((current) => clearConnectionDraftSecrets({ ...current, mcpTransport: value, credentialFields: value === "stdio" ? current.credentialFields : [] })); }} isDisabled={disabled} fullWidth>
            <Label>{t("接入方式", "Transport")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox><ListBox.Item id="http" textValue={t("远程服务 (HTTP)", "Remote server (HTTP)")}>{t("远程服务 (HTTP)", "Remote server (HTTP)")}<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="stdio" textValue={t("本机命令 (Stdio)", "Local command (Stdio)")}>{t("本机命令 (Stdio)", "Local command (Stdio)")}<ListBox.ItemIndicator /></ListBox.Item></ListBox></Select.Popover>
          </Select>}
          {draft.mcpTransport === "http" ? <>
            <TextField className="kulo-form-field" variant="primary" value={draft.url} onChange={(value) => change("url", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("服务地址", "Server URL")}</Label><Input type="url" autoComplete="off" spellCheck={false} placeholder="https://" /></TextField>
            <Select className="kulo-form-field" variant="primary" value={draft.mcpAuthMode} onChange={(value) => { if (value === "oauth" || value === "bearer" || value === "header" || value === "none") setDraft((current) => clearConnectionDraftSecrets({ ...current, mcpAuthMode: value })); }} isDisabled={disabled} fullWidth>
              <Label>{t("认证方式", "Authentication")}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover><ListBox>{(["oauth", "bearer", "header", "none"] as const).map((mode) => <ListBox.Item key={mode} id={mode} textValue={mcpAuthModeLabel(mode)}>{mcpAuthModeLabel(mode)}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
            </Select>
            {draft.mcpAuthMode === "header" && <TextField className="kulo-form-field" variant="primary" value={draft.headerName} onChange={(value) => change("headerName", value)} isDisabled={disabled} fullWidth><Label>{t("请求头名称", "Header name")}</Label><Input autoComplete="off" spellCheck={false} /></TextField>}
            {(draft.mcpAuthMode === "bearer" || draft.mcpAuthMode === "header") && <TextField className="kulo-form-field" variant="primary" type="password" value={draft.apiKey} onChange={(value) => change("apiKey", value)} isDisabled={disabled} fullWidth><Label>Token</Label><Input autoComplete="new-password" spellCheck={false} placeholder={secretPlaceholder || t("粘贴 Token", "Paste token")} /></TextField>}
            {draft.mcpAuthMode === "oauth" && <Disclosure defaultExpanded={Boolean(draft.mcpOAuthClientId || draft.mcpOAuthScope || draft.mcpOAuthCallbackPort)}>
              <Disclosure.Heading><Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">{t("高级 OAuth 选项", "Advanced OAuth options")}<Disclosure.Indicator /></Button></Disclosure.Heading>
              <Disclosure.Content><Disclosure.Body className="kulo-form-stack pt-2">
                <TextField className="kulo-form-field" variant="primary" value={draft.mcpOAuthClientId} onChange={(value) => change("mcpOAuthClientId", value)} isDisabled={disabled} fullWidth><Label>Client ID</Label><Input autoComplete="off" spellCheck={false} /></TextField>
                {Boolean(draft.mcpOAuthClientId.trim()) && <TextField className="kulo-form-field" variant="primary" type="password" value={draft.clientSecret} onChange={(value) => change("clientSecret", value)} isDisabled={disabled} fullWidth><Label>Client Secret</Label><Input autoComplete="new-password" spellCheck={false} placeholder={existing?.secretFields.includes("clientSecret") ? t("已保存，留空保留", "Saved; leave blank to keep") : ""} /></TextField>}
                <TextField className="kulo-form-field" variant="primary" value={draft.mcpOAuthScope} onChange={(value) => change("mcpOAuthScope", value)} isDisabled={disabled} fullWidth><Label>Scope</Label><Input autoComplete="off" spellCheck={false} /></TextField>
                <TextField className="kulo-form-field" variant="primary" value={draft.mcpOAuthCallbackPort} onChange={(value) => change("mcpOAuthCallbackPort", value)} isDisabled={disabled} fullWidth><Label>{t("回调端口", "Callback port")}</Label><Input inputMode="numeric" autoComplete="off" placeholder={t("默认自动分配", "Auto")} /></TextField>
              </Disclosure.Body></Disclosure.Content>
            </Disclosure>}
          </> : <>
            <TextField className="kulo-form-field" variant="primary" value={draft.mcpCommand} onChange={(value) => change("mcpCommand", value)} isRequired isDisabled={disabled} fullWidth><Label>{t("启动命令", "Command")}</Label><Input autoComplete="off" spellCheck={false} placeholder="npx" /></TextField>
            <TextField className="kulo-form-field" variant="primary" value={draft.mcpArgsText} onChange={(value) => change("mcpArgsText", value)} isDisabled={disabled} fullWidth><Label>{t("启动参数（每行一项）", "Arguments (one per line)")}</Label><TextArea rows={3} className="scrollbar font-mono" autoComplete="off" spellCheck={false} /></TextField>
            <TextField className="kulo-form-field" variant="primary" value={draft.mcpCwd} onChange={(value) => change("mcpCwd", value)} isDisabled={disabled} fullWidth><Label>{t("工作目录", "Working directory")}</Label><Input autoComplete="off" spellCheck={false} placeholder={t("可选绝对路径", "Optional absolute path")} /></TextField>
            {draft.credentialFields.map((field, index) => <div key={field.key} role="group" aria-label={field.label.trim() || t(`环境变量 ${index + 1}`, `Env var ${index + 1}`)} className="kulo-form-stack rounded-xl border border-border p-3">
              <div className="kulo-field-action-row">
                <TextField variant="primary" className="kulo-form-field min-w-0 flex-1" value={field.label} onChange={(value) => changeField(field.key, { label: value })} isRequired isDisabled={disabled} fullWidth><Label>{t(`环境变量 ${index + 1}`, `Env var ${index + 1}`)}</Label><Input className="kulo-field-action-input font-mono" data-credential-field-name={field.key} maxLength={64} autoComplete="off" spellCheck={false} placeholder="API_TOKEN" /></TextField>
                <Button size="sm" variant="ghost" className="kulo-field-action-button" aria-label={t(`移除${field.label.trim() || `环境变量 ${index + 1}`}`, `Remove ${field.label.trim() || `env var ${index + 1}`}`)} isDisabled={disabled} onPress={() => removeField(field.key)}>{t("移除", "Remove")}</Button>
              </div>
              <TextField className="kulo-form-field" variant="primary" type="password" value={field.value} onChange={(value) => changeField(field.key, { value })} isDisabled={disabled} fullWidth>
                <Label>{t("变量值", "Value")}</Label>
                <Input autoComplete="new-password" spellCheck={false} placeholder={existing?.secretFields.includes(field.label.trim().toUpperCase()) ? t("已保存，留空保留", "Saved; leave blank to keep") : ""} />
              </TextField>
            </div>)}
            <Button ref={addFieldRef} size="sm" variant="secondary" isDisabled={disabled || draft.credentialFields.length >= 32} onPress={addField}>{t("添加环境变量", "Add env var")}</Button>
          </>}
        </> : (
          <CredentialFormFields
            draft={draft}
            existing={existing}
            disabled={disabled}
            fieldVariant="primary"
            addFieldRef={addFieldRef}
            onChange={change}
            onSetDraft={setDraft}
            onChangeField={changeField}
            onAddField={addField}
            onRemoveField={removeField}
          />
        )}
        </>}
        {permissionPrompt && <Alert status="warning" role="status">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{permissionPrompt.kind === "full-disk-access" ? t("需要完全磁盘访问权限", "Full Disk Access required") : permissionPrompt.kind === "local-network" ? t("需要本地网络权限", "Local Network permission required") : t("需要自动化权限", "Automation permission required")}</Alert.Title>
            <Alert.Description className="break-words">{permissionPrompt.message}</Alert.Description>
          </Alert.Content>
        </Alert>}
        {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      </Card.Content>
      <Card.Footer className="mt-3 flex-wrap justify-end gap-2">
        <Button size="sm" variant="tertiary" isDisabled={!connected || busy || openingSettings} onPress={() => void submit(true)}>{t("取消", "Cancel")}</Button>
        {permissionPrompt && !permissionPrompt.remote && <Button size="sm" variant="secondary" isPending={openingSettings} isDisabled={!connected || busy || finished || openingSettings} onPress={() => void openPermissionSettings(permissionPrompt.kind)}>{t("打开系统设置", "Open System Settings")}</Button>}
        <Button size="sm" type="submit" variant="secondary" isPending={busy} isDisabled={disabled || openingSettings}>{nativeApp ? (permissionPrompt ? t("重新检查", "Check again") : t("授权并连接", "Authorize and connect")) : isApp ? t("连接应用", "Connect app") : isMcp ? (input.connectionId ? t("保存修改", "Save changes") : t("保存连接", "Save connection")) : draft.category === "information" ? t("保存信息", "Save information") : draft.kind === "ssh" ? t("保存并连接", "Save and connect") : t("保存凭据", "Save credentials")}</Button>
      </Card.Footer>
    </form>
  </Card>;
}

export function ConnectionSetupInputs({ inputs, connections, applications, clientId, localHost, canManageHub, ...props }: {
  inputs: ConnectionSetupInput[];
  connections: ConnectionRecordView[];
  applications?: ConnectionApplicationView[];
  clientId: string;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  canManageHub?: boolean;
  onChanged: () => void;
  onCompleted?: (connection: ConnectionRecordView) => void;
  onCancelled?: () => void;
}) {
  useI18n();
  return <>{visibleConnectionInputs(inputs, clientId).map((input) => <ConnectionSetupForm key={`${input.id}:${input.expectedRevision ?? 0}`} input={input} existing={connections.find((connection) => connection.id === input.connectionId)} application={applications?.find((application) => application.id === input.appId)} clientId={clientId} localHost={localHost} canManageHub={canManageHub} {...props} />)}</>;
}
