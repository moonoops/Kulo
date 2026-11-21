import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionApplicationView, ConnectionRecordView, ConnectionSetupInput, ConnectionWorkspaceSnapshot } from "@kulo/protocol";
import {
  ConnectionSetupForm,
  clearConnectionDraftSecrets,
  connectionSaveRequest,
  createConnectionDraft,
  nativePermissionKindForError,
  resolveNativePermissionPrompt,
  safeConnectionInputError,
  visibleConnectionInputs,
} from "./connection-setup-inputs";
import { ConnectionsModule, applicationStatusLabel, connectionAddress, connectionCategory, connectionStatusLabel, mcpConnectionStatus } from "./connections-module";
import { ConnectionIcon } from "./connection-icon";
import { AddAppModal } from "./mcp-add-modal";
import { McpOAuthModal } from "./mcp-oauth-modal";
import { HomeAssistantConfigModal } from "./home-assistant-config-modal";
import { checkConnectionFollowup, connectionFollowupResult } from "./connection-followup";
import { kuloRest } from "../../kulo-api";
import { getSettingsAssistantShortcuts } from "./settings-assistant-actions";
import { clearSettingsAssistantDraftStorage, readSettingsAssistantDraft } from "./use-settings-assistant";

const input: ConnectionSetupInput = { id: "input-1", clientId: "tab-a", kind: "ssh", name: "部署服务器", host: "server.example", username: "deploy", status: "pending", createdAt: 1 };
const connection: ConnectionRecordView = { id: "conn-1", name: "部署服务器", kind: "ssh", host: "server.example", port: 22, username: "deploy", status: "saved", hasCredential: true, secretFields: ["privateKey"], revision: 2, createdAt: 1, updatedAt: 2 };
const snapshot: ConnectionWorkspaceSnapshot = { connections: [connection], inputs: [], requests: [], vault: { available: true } };
const nativeApplication: ConnectionApplicationView = { id: "messages", name: "消息", description: "读取和发送消息", authentication: "macos", instructions: ["在系统设置中授予访问权限。"], status: "disconnected", actions: [{ id: "list", label: "读取消息", readOnly: true }, { id: "send", label: "发送消息", readOnly: false }] };
const tokenApplication: ConnectionApplicationView = { id: "github", name: "GitHub", description: "读取与管理议题", authentication: "token", instructions: ["创建具有所需权限的 Token。"], helpUrl: "https://docs.github.com/authentication", status: "disconnected", actions: [{ id: "issues", label: "读取议题", readOnly: true }] };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("connection authorization setup", () => {
  it("keeps credential forms independent of task suggestions until their agent workflow is connected", () => {
    expect(getSettingsAssistantShortcuts("connections", false, "light")).toEqual([]);
    expect(getSettingsAssistantShortcuts("connections", true, "dark")).toEqual([]);
    const html = renderToStaticMarkup(<ConnectionSetupForm input={input} clientId="tab-a" connected available onChanged={() => {}} />);
    expect(html).toContain("部署服务器");
    expect(html).toContain('autoComplete="new-password"');
  });

  it("prepares edits from public metadata with all secret inputs empty", () => {
    const poisoned = Object.assign({ ...connection }, { password: "stored-password-sentinel", privateKey: "stored-private-key-sentinel" });
    const editing = { ...input, connectionId: connection.id, expectedRevision: 2 };
    const draft = createConnectionDraft(editing, poisoned);
    expect(draft.sshAuth).toBe("private-key");
    for (const field of ["password", "privateKey", "passphrase", "apiKey"] as const) expect(draft[field]).toBe("");
    expect(connectionSaveRequest(draft, editing)).not.toHaveProperty("secrets");
    expect(connectionSaveRequest({ ...draft, instructions: "" }, editing).instructions).toBe("");
    expect(connectionSaveRequest(draft, editing)).toMatchObject({ id: connection.id, expectedRevision: 2, host: "server.example", username: "deploy" });
    const html = renderToStaticMarkup(<ConnectionSetupForm input={editing} existing={poisoned} clientId="tab-a" connected available onChanged={() => {}} />);
    expect(html).not.toContain("stored-password-sentinel");
    expect(html).not.toContain("stored-private-key-sentinel");
    expect(html).toContain("已保存，留空保留");
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("-webkit-text-security:disc");
  });

  it("sends only the chosen authentication fields to the dedicated input endpoint", () => {
    const draft = { ...createConnectionDraft(input), password: "typed-password-sentinel", privateKey: "unused-private-key-sentinel", apiKey: "unused-api-key-sentinel" };
    expect(connectionSaveRequest(draft, input).secrets).toEqual({ password: "typed-password-sentinel" });
    const key = connectionSaveRequest({ ...draft, sshAuth: "private-key", passphrase: "key-passphrase-sentinel" }, input);
    expect(key.secrets).toEqual({ privateKey: "unused-private-key-sentinel", passphrase: "key-passphrase-sentinel" });
    expect(connectionSaveRequest({ ...draft, sshAuth: "private-key", privateKey: "", passphrase: "replacement-passphrase" }, input).secrets).toEqual({ passphrase: "replacement-passphrase" });
    expect(clearConnectionDraftSecrets(draft)).toMatchObject({ password: "", privateKey: "", passphrase: "", apiKey: "" });
  });

  it("keeps private input requests bound to the originating window", () => {
    expect(visibleConnectionInputs([input, { ...input, id: "foreign", clientId: "tab-b" }, { ...input, id: "done", status: "completed" }], "tab-a")).toEqual([input]);
  });

  it("preserves passwords exactly while rejecting secret-bearing connection URLs", () => {
    const draft = { ...createConnectionDraft({ ...input, kind: "account" }), url: "https://site.example", password: "  mixed:password!?  " };
    expect(connectionSaveRequest(draft, input).secrets?.password).toBe("  mixed:password!?  ");
    expect(() => connectionSaveRequest({ ...draft, url: "https://user:password@site.example" }, input)).toThrow("不能包含账号密码");
    expect(() => connectionSaveRequest({ ...draft, url: "http://site.example" }, input)).toThrow("HTTPS");
    expect(() => connectionSaveRequest({ ...draft, kind: "ssh", port: "0" }, input)).toThrow("端口");
    expect(() => connectionSaveRequest({ ...draft, kind: "ssh", host: "" }, input)).toThrow("服务器地址");
  });

  it("does not reflect submitted credentials in private-form errors", () => {
    const draft = { ...createConnectionDraft(input), password: "exact-password-sentinel", privateKey: "exact-private-key-sentinel", apiKey: "exact-api-key-sentinel" };
    const message = safeConnectionInputError(new Error(`Rejected ${draft.password} ${draft.privateKey} ${draft.apiKey}`), draft);
    for (const value of [draft.password, draft.privateKey, draft.apiKey]) expect(message).not.toContain(value);
  });
});

describe("custom credential schemas", () => {
  const custom: ConnectionRecordView = { ...connection, id: "custom-1", kind: "custom", name: "分析数据库", typeLabel: "PostgreSQL", instructions: "用于分析服务\n仅查询业务报表", host: undefined, username: undefined,
    credentialFields: [{ key: "connectionString", label: "连接字符串" }, { key: "clientCertificate", label: "客户端证书" }, { key: "recovery", label: "恢复码" }], secretFields: ["connectionString", "clientCertificate"], status: "saved" };
  const editing: ConnectionSetupInput = { id: "custom-input", clientId: "tab-a", connectionId: custom.id, expectedRevision: custom.revision, kind: "custom", status: "pending", createdAt: 1 };

  it("initializes arbitrary metadata from chat-imported schemas without loading stored values", () => {
    const unsafe = Object.assign({ ...custom }, { secrets: { connectionString: "stored-connection-value", clientCertificate: "stored-certificate-value" } });
    const draft = createConnectionDraft(editing, unsafe);
    expect(draft).toMatchObject({ kind: "custom", name: custom.name, typeLabel: "PostgreSQL", instructions: custom.instructions });
    expect(draft.credentialFields).toEqual(custom.credentialFields?.map((field) => ({ ...field, value: "" })));
    const html = renderToStaticMarkup(<ConnectionSetupForm input={editing} existing={unsafe} clientId="tab-a" connected available onChanged={() => {}} />);
    for (const label of ["凭据类型", "用途", "连接字符串", "客户端证书", "恢复码", "添加字段"]) expect(html).toContain(label);
    expect(html).toContain('aria-label="移除连接字符串"');
    expect(html).toContain("字段 1 名称");
    expect(html.match(/placeholder="已保存，留空保留"/g)).toHaveLength(2);
    expect(html).toContain('placeholder="填写凭据"');
    expect(html).not.toContain("stored-connection-value");
    expect(html).not.toContain("stored-certificate-value");
    expect(html).not.toContain("API 地址");
    expect(html).not.toContain("认证方式");
  });

  it("submits multiline opaque values exactly and only values changed in this edit", () => {
    const draft = createConnectionDraft(editing, custom);
    const value = "  first line\nsecond: line\r\n第三行  ";
    draft.credentialFields[1]!.value = value;
    draft.credentialFields[1]!.label = "客户端 PEM 证书";
    draft.typeLabel = "只读数据库";
    draft.instructions = "新的用途\n保留多行";
    expect(connectionSaveRequest(draft, editing)).toEqual({ id: custom.id, expectedRevision: custom.revision, name: custom.name, kind: "custom", category: "credential", typeLabel: "只读数据库", instructions: "新的用途\n保留多行",
      credentialFields: [{ key: "connectionString", label: "连接字符串" }, { key: "clientCertificate", label: "客户端 PEM 证书" }, { key: "recovery", label: "恢复码" }], secrets: { clientCertificate: value } });
    expect(clearConnectionDraftSecrets(draft).credentialFields.every((field) => field.value === "")).toBe(true);
  });

  it("uses an explicit schema to remove fields while blank fields preserve their saved value", () => {
    const draft = createConnectionDraft(editing, custom);
    draft.credentialFields = draft.credentialFields.filter((field) => field.key !== "clientCertificate");
    expect(connectionSaveRequest(draft, editing).credentialFields).toEqual([{ key: "connectionString", label: "连接字符串" }, { key: "recovery", label: "恢复码" }]);
    expect(connectionSaveRequest(draft, editing)).not.toHaveProperty("secrets");
    expect(connectionSaveRequest({ ...draft, credentialFields: [] }, editing).credentialFields).toEqual([]);
    expect(connectionSaveRequest({ ...draft, credentialFields: [{ key: "space", label: "空格值", value: " \n " }] }, editing).secrets).toEqual({ space: " \n " });
  });

  it("validates schema identity, limits, and public field names", () => {
    const draft = createConnectionDraft(editing, custom);
    expect(() => connectionSaveRequest({ ...draft, credentialFields: [{ key: "constructor", label: "字段", value: "" }] }, editing)).toThrow("字段无效");
    expect(() => connectionSaveRequest({ ...draft, credentialFields: [{ key: "toString", label: "字段", value: "" }] }, editing)).toThrow("字段无效");
    expect(() => connectionSaveRequest({ ...draft, credentialFields: [draft.credentialFields[0]!, draft.credentialFields[0]!] }, editing)).toThrow("字段无效");
    expect(() => connectionSaveRequest({ ...draft, credentialFields: [{ key: "field", label: "", value: "" }] }, editing)).toThrow("字段名称");
    expect(() => connectionSaveRequest({ ...draft, credentialFields: Array.from({ length: 33 }, (_, index) => ({ key: `field_${index}`, label: `字段${index}`, value: "" })) }, editing)).toThrow("32");
    expect(() => connectionSaveRequest({ ...draft, credentialFields: [{ key: "field", label: "字段", value: "x".repeat(256 * 1024 + 1) }] }, editing)).toThrow("内容过长");
    expect(() => connectionSaveRequest({ ...draft, typeLabel: "x".repeat(121) }, editing)).toThrow("120");
    expect(() => connectionSaveRequest({ ...draft, instructions: "x".repeat(8001) }, editing)).toThrow("8000");
  });

  it("redacts arbitrary submitted field values from errors", () => {
    const draft = createConnectionDraft(editing, custom);
    const secret = "custom-opaque-credential-123\nfixture-second-line";
    draft.credentialFields[0]!.value = secret;
    const error = safeConnectionInputError(new Error(`Rejected ${secret} or ${encodeURIComponent(secret)}`), draft);
    expect(error).not.toContain(secret);
    expect(error).not.toContain(encodeURIComponent(secret));
  });

  it("keeps dynamic schemas in the private editor and shows only the saved record on the left", () => {
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, connections: [custom] }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html).toContain("分析数据库");
    expect(html).toContain("已保存");
    for (const metadata of ["PostgreSQL", "连接字符串", "客户端证书", "恢复码", "仅查询业务报表"]) expect(html).not.toContain(metadata);
    expect(html).not.toContain("测试连接");
    expect(html).toContain('aria-label="编辑分析数据库"');
  });
});

describe("connection management tabs", () => {
  it("defaults to applications and keeps inactive categories outside keyboard navigation", () => {
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={snapshot} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html).toContain('aria-label="授权凭据视图"');
    const tabs = [...html.matchAll(/<[^>]+role="tab"[^>]*>([\s\S]*?)<\/[^>]+>/g)];
    expect(tabs.map((tab) => tab[1]?.replace(/<[^>]*>/g, ""))).toEqual(["应用", "凭据", "其他"]);
    expect(tabs[0]?.[0]).toContain('aria-selected="true"');
    for (const tab of tabs.slice(1)) expect(tab[0]).toContain('aria-selected="false"');
    const panels = [...html.matchAll(/<div\b[^>]*data-slot="tabs-panel"[^>]*>/g)].map((panel) => panel[0]);
    expect(panels).toHaveLength(3);
    expect(panels[0]).toContain('role="tabpanel"');
    expect(panels[0]).not.toContain('inert=""');
    expect(panels[0]).not.toContain('data-inert="true"');
    for (const panel of panels.slice(1)) {
      expect(panel).not.toContain('role="tabpanel"');
      expect(panel).toContain('inert=""');
      expect(panel).toContain('data-inert="true"');
      expect(panel).toContain("data-[inert=true]:hidden");
    }
  });

  it("renders saved records and honest incomplete states without stored secrets", () => {
    const withUnexpectedSecret = Object.assign({ ...connection }, { secrets: { privateKey: "card-private-key-sentinel" } });
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, connections: [withUnexpectedSecret, { ...connection, id: "incomplete", name: "刚收到的账号", status: "incomplete", host: undefined }] }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html).toContain("server.example");
    expect(html).not.toContain("deploy@server.example");
    expect(html).toContain("待补全");
    expect(html).not.toContain("测试连接");
    expect(html).not.toContain('aria-label="连接部署服务器"');
    expect(html).toContain('aria-label="移除部署服务器"');
    expect(html).not.toContain("card-private-key-sentinel");
    expect(connectionStatusLabel({ ...connection, kind: "account", status: "saved" })).toBe("已保存");
    expect(html.match(/<table\b/g)).toHaveLength(3);
    for (const title of ["应用", "凭据", "其他"]) expect(html).toContain(`aria-label="${title}"`);
    expect(html.match(/<h2 class="kulo-section-title">/g)).toHaveLength(3);
    const credentialTable = html.match(/<table\b(?=[^>]*aria-label="凭据列表")[^]*?<\/table>/)?.[0];
    expect(credentialTable?.match(/role="rowheader"/g)).toHaveLength(2);
    expect(html.match(/role="columnheader"/g)).toHaveLength(9);
    expect(html).toContain("kulo-settings-table-action-group");
    expect(html).not.toContain("kulo-connection-identity");
    expect(html).toContain('aria-label="编辑部署服务器"');
    expect(html).not.toContain('aria-multiselectable="true"');
  });

  it("shows only the server address and prioritizes website accounts over domains", () => {
    expect(connectionAddress({ ...connection, host: "203.0.113.12" })).toBe("203.0.113.12");
    expect(connectionAddress({ ...connection, host: "203.0.113.12", port: 2222 })).toBe("203.0.113.12:2222");
    expect(connectionAddress({ ...connection, kind: "account", username: "writer@example.test", url: "https://docs.example/path" })).toBe("writer@example.test");
    expect(connectionAddress({ ...connection, kind: "account", username: "", url: "https://docs.example/path" })).toBe("docs.example");
  });

  it("surfaces a locked vault and keeps removal available", () => {
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, vault: { available: false, error: "系统密钥库已锁定" } }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html).toContain("本地凭据库不可用");
    expect(html).toContain("系统密钥库已锁定");
    const remove = html.match(/<button\b(?=[^>]*aria-label="移除部署服务器")[^>]*>/)?.[0];
    expect(remove).toBeDefined();
    expect(remove).not.toContain("disabled");
  });

  it("keeps unconfigured records editable without exposing a test action", () => {
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, connections: [{ ...connection, hasCredential: false }] }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    const edit = html.match(/<button\b(?=[^>]*aria-label="编辑部署服务器")[^>]*>/)?.[0];
    expect(html).not.toContain("测试部署服务器");
    expect(edit).toBeDefined();
    expect(edit).not.toContain("disabled");
    expect(html).not.toContain("凭据已保存");
  });

  it("defaults legacy custom cards to credentials and separates explicitly saved information", () => {
    const custom = { ...connection, id: "custom-workspace", kind: "custom" as const, name: "工作平台", typeLabel: "内容平台账号" };
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, connections: [custom, { ...custom, id: "info", name: "报销规则", category: "information" }] }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(connectionCategory(custom)).toBe("credential");
    expect(html).not.toContain("内容平台账号");
    expect(html).toContain('aria-label="编辑工作平台"');
    expect(html).toContain('aria-label="移除工作平台"');
    expect(html).toContain('aria-label="移除报销规则"');
    expect(html).toMatch(/aria-label="凭据列表"[^]*工作平台[^]*aria-label="其他信息列表"[^]*报销规则/);
  });

  it("distinguishes loading from empty groups and preserves records alongside errors", () => {
    const base = { connected: true, onPrepare: async () => {}, onRefresh: () => {} };
    const loading = renderToStaticMarkup(<ConnectionsModule {...base} snapshot={null} loading error={null} />);
    expect(loading).toContain("加载中");
    expect(loading).not.toContain("尚未添加凭据");
    const empty = renderToStaticMarkup(<ConnectionsModule {...base} snapshot={{ ...snapshot, connections: [] }} loading={false} error={null} />);
    expect(empty).toContain("尚未添加凭据");
    expect(empty).toContain("尚未保存其他信息");
    const failed = renderToStaticMarkup(<ConnectionsModule {...base} snapshot={snapshot} loading={false} error="读取连接失败" />);
    expect(failed).toContain("读取连接失败");
    expect(failed).toContain("部署服务器");
    expect(failed).toContain("重试");
  });
});

describe("preset application setup", () => {
  const appInput: ConnectionSetupInput = { id: "app-input", clientId: "tab-a", kind: "app", category: "app", appId: "messages", name: "消息", status: "pending", createdAt: 1 };

  it("submits native authorization without requesting a password or depending on the credential vault", () => {
    const draft = createConnectionDraft(appInput);
    expect(connectionSaveRequest(draft, appInput)).toEqual({ name: "消息", kind: "app", category: "app", appId: "messages" });
    const html = renderToStaticMarkup(<ConnectionSetupForm input={appInput} application={nativeApplication} clientId="tab-a" connected available={false} onChanged={() => {}} />);
    expect(html).toContain("在系统设置中授予访问权限");
    expect(html).toContain("授权并连接");
    expect(html).toMatch(/<h3[^>]*tabindex="-1"[^>]*>连接消息<\/h3>/i);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html.match(/<button\b(?=[^>]*type="submit")[^>]*>/)?.[0]).not.toContain("disabled");
  });

  it("maps missing macOS connector permissions into guided System Settings prompts instead of red error text", async () => {
    const fullDiskError = Object.assign(new Error("无法读取信息数据库。"), { code: "connection_messages_full_disk_access_required" });
    const automationError = Object.assign(new Error("需要自动化权限。"), { code: "connection_app_automation_required" });
    expect(nativePermissionKindForError(fullDiskError)).toBe("full-disk-access");
    expect(nativePermissionKindForError(automationError)).toBe("automation");
    expect(nativePermissionKindForError(new Error("普通失败"))).toBeNull();

    const openSettings = vi.fn().mockResolvedValueOnce("opened").mockResolvedValueOnce("remote").mockRejectedValueOnce(new Error("open failed"));
    const openedPrompt = await resolveNativePermissionPrompt(fullDiskError, { appName: "信息", localHost: true, openSettings });
    expect(openedPrompt).toMatchObject({ kind: "full-disk-access", opened: true, remote: false });
    expect(openedPrompt?.message).toContain("已打开系统设置");
    expect(openSettings).toHaveBeenCalledWith("full-disk-access", { localHost: true });

    const remotePrompt = await resolveNativePermissionPrompt(automationError, { appName: "邮件", localHost: false, openSettings });
    expect(remotePrompt).toMatchObject({ kind: "automation", opened: false, remote: true });
    expect(remotePrompt?.message).toContain("主脑的 Mac");

    const manualPrompt = await resolveNativePermissionPrompt(fullDiskError, { appName: "信息", localHost: true, openSettings });
    expect(manualPrompt).toMatchObject({ kind: "full-disk-access", opened: false, remote: false });

    const localHtml = renderToStaticMarkup(
      <ConnectionSetupForm input={appInput} application={nativeApplication} clientId="tab-a" connected available localHost initialPermissionPrompt={openedPrompt} onChanged={() => {}} />,
    );
    expect(localHtml).toContain("需要完全磁盘访问权限");
    expect(localHtml).toContain("打开系统设置");
    expect(localHtml).toContain("重新检查");
    expect(localHtml).not.toContain("text-danger");

    const remoteHtml = renderToStaticMarkup(
      <ConnectionSetupForm input={appInput} application={nativeApplication} clientId="tab-a" connected available localHost={false} initialPermissionPrompt={remotePrompt} onChanged={() => {}} />,
    );
    expect(remoteHtml).toContain("需要自动化权限");
    expect(remoteHtml).not.toContain("打开系统设置");
    expect(remoteHtml).toContain("重新检查");
    expect(remoteHtml).not.toContain("text-danger");
  });

  it("shows token guidance and submits only a replacement token to the private endpoint", () => {
    const tokenInput = { ...appInput, name: "GitHub", appId: "github" as const, connectionId: "github-1", expectedRevision: 1 };
    const existing: ConnectionRecordView = { ...connection, id: "github-1", name: "GitHub", kind: "app", category: "app", appId: "github", secretFields: ["apiKey"] };
    const poisoned = Object.assign({ ...existing }, { secrets: { apiKey: "stored-token-sentinel" } });
    const draft = createConnectionDraft(tokenInput, poisoned);
    expect(connectionSaveRequest(draft, tokenInput)).not.toHaveProperty("secrets");
    expect(connectionSaveRequest({ ...draft, apiKey: "replacement-token-sentinel", password: "unused-password" }, tokenInput).secrets).toEqual({ apiKey: "replacement-token-sentinel" });
    const html = renderToStaticMarkup(<ConnectionSetupForm input={tokenInput} existing={poisoned} application={tokenApplication} clientId="tab-a" connected available onChanged={() => {}} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('href="https://docs.github.com/authentication"');
    expect(html).toContain("已保存，留空保留");
    expect(html).not.toContain("stored-token-sentinel");
    expect(html).not.toContain("网站地址");
  });

  it("keeps app status and cancellation beside the local brand icon without duplicating records in credential groups", () => {
    const appRecord: ConnectionRecordView = { ...connection, id: "github-1", kind: "app", category: "app", appId: "github", name: "GitHub" };
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, connections: [appRecord], applications: [nativeApplication, { ...tokenApplication, status: "connected", connectionId: appRecord.id }] }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html).toContain("kulo-connection-icon--messages");
    expect(html).toContain("kulo-connection-icon--github");
    expect(html).toContain('aria-label="连接消息"');
    expect(html).toContain('aria-label="取消连接GitHub"');
    expect(html).not.toContain('aria-label="连接GitHub"');
    expect(html).not.toContain('aria-label="编辑GitHub"');
    expect(html).toContain("已连接");
    expect(html).toContain("尚未添加凭据");
    expect(applicationStatusLabel({ ...tokenApplication, status: "needs_attention" })).toBe("需要处理");
  });

  it.each([
    { status: "disconnected", connectionId: undefined, action: "连接" },
    { status: "disconnected", connectionId: "github-1", action: "连接" },
    { status: "connected", connectionId: "github-1", action: "取消连接" },
    { status: "needs_attention", connectionId: "github-1", action: "重新连接" },
    { status: "unavailable", connectionId: "github-1", action: "连接" },
  ] as const)("shows one preset action for $status with connection $connectionId", ({ status, connectionId, action }) => {
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, applications: [{ ...tokenApplication, status, connectionId }] }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html.match(/aria-label="(?:连接|重新连接|取消连接)GitHub"/g)).toEqual([`aria-label="${action}GitHub"`]);
    expect(html).not.toContain('aria-label="取消GitHub授权"');
    if (status === "unavailable") expect(html.match(/<button\b(?=[^>]*aria-label="连接GitHub")[^>]*>/)?.[0]).toContain("disabled");
  });

  it("leaves native authorization available while token connections are blocked by a locked vault", () => {
    const html = renderToStaticMarkup(<ConnectionsModule snapshot={{ ...snapshot, applications: [nativeApplication, tokenApplication], vault: { available: false } }} loading={false} error={null} connected onPrepare={async () => {}} onRefresh={() => {}} />);
    expect(html.match(/<button\b(?=[^>]*aria-label="连接消息")[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html.match(/<button\b(?=[^>]*aria-label="连接GitHub")[^>]*>/)?.[0]).toContain("disabled");
  });

  it("keeps manually remembered information and every content value in the private form", () => {
    const infoInput = { ...input, kind: "custom" as const, category: "information" as const, name: "报销规则" };
    const draft = createConnectionDraft(infoInput);
    draft.credentialFields[0]!.value = "合成信息第一行\n第二行";
    expect(connectionSaveRequest(draft, infoInput)).toMatchObject({ kind: "custom", category: "information", typeLabel: "其他信息", credentialFields: [{ key: "credential", label: "内容" }], secrets: { credential: "合成信息第一行\n第二行" } });
    const html = renderToStaticMarkup(<ConnectionSetupForm input={infoInput} clientId="tab-a" connected available onChanged={() => {}} />);
    expect(html).toContain("保存信息");
    expect(html).toContain("填写内容");
    expect(html).not.toContain("凭据类型");
    expect(html).not.toContain("登录方式");
    expect(html).not.toContain("合成信息第一行");
  });
});

describe("SSH connection followup", () => {
  it("requires an explicit fingerprint decision before starting the trusted authentication check", async () => {
    const fingerprint = "SHA256:synthetic-host-fingerprint";
    const test = vi.spyOn(kuloRest, "testConnection").mockResolvedValueOnce({ connection, requiresTrust: true, fingerprint }).mockResolvedValueOnce({ connection: { ...connection, status: "verified" } });
    const trust = vi.spyOn(kuloRest, "trustConnection").mockResolvedValue({ connection });
    expect(await checkConnectionFollowup(connection.id)).toEqual({ phase: "trust", fingerprint });
    expect(trust).not.toHaveBeenCalled();
    expect(await checkConnectionFollowup(connection.id, fingerprint)).toEqual({ phase: "ready" });
    expect(trust).toHaveBeenCalledWith(connection.id, fingerprint);
    expect(trust.mock.invocationCallOrder[0]).toBeLessThan(test.mock.invocationCallOrder[1]!);
  });

  it("keeps failed or incomplete authentication recoverable and does not treat saving as verification", async () => {
    expect(connectionFollowupResult({ connection })).toMatchObject({ phase: "error" });
    expect(connectionFollowupResult({ connection: { ...connection, status: "verified" }, requiresTrust: true })).toMatchObject({ phase: "error" });
    expect(connectionFollowupResult({ connection: { ...connection, status: "error", error: "密码=failed-password-sentinel" } })).toEqual({ phase: "error", error: "密码=[已隐藏]" });
    const test = vi.spyOn(kuloRest, "testConnection");
    vi.spyOn(kuloRest, "trustConnection").mockRejectedValue(new Error("服务器指纹已变更"));
    await expect(checkConnectionFollowup(connection.id, "SHA256:old")).rejects.toThrow("指纹已变更");
    expect(test).not.toHaveBeenCalled();
  });
});

describe("settings draft privacy", () => {
  it("removes persistent drafts while leaving the live input unchanged", () => {
    let stored: string | null = "legacy text";
    vi.stubGlobal("localStorage", { getItem: () => stored, removeItem: () => { stored = null; }, setItem: vi.fn() });
    const raw = "请记住，账号 deploy，密码=fixture-password-123，API_KEY=sk-fixture-12345678901234567890";
    clearSettingsAssistantDraftStorage();
    expect(raw).toContain("fixture-password-123");
    expect(stored).toBeNull();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("cleans an existing plaintext draft before restoring it", () => {
    let stored: string | null = "密码：legacy-password-123，请保存";
    vi.stubGlobal("localStorage", { getItem: () => stored, removeItem: () => { stored = null; } });
    expect(readSettingsAssistantDraft()).not.toContain("legacy-password-123");
    expect(stored).toBeNull();
  });
});

describe("ambient awareness controls inside connections", () => {
  it("renders notification switch, local acceleration entry, FDA guidance, and muted apps when assistant snapshot is supplied", () => {
    const assistant = {
      revision: 2,
      enabled: true,
      sources: [
        {
          driverId: "macos-notifications" as const,
          envId: "local",
          envName: "Mac Studio",
          platform: "darwin",
          enabled: true,
          permission: "full_disk_access_required" as const,
          mutedApps: ["com.example.ads"],
        },
      ],
      mutedApps: ["com.example.ads"],
      backgroundModel: {
        mode: "auto" as const,
        running: false,
        revision: 1,
      },
      digestCount24h: 4,
      localHost: true,
    };

    const localHtml = renderToStaticMarkup(
      <ConnectionsModule
        snapshot={snapshot}
        loading={false}
        error={null}
        connected
        onPrepare={async () => {}}
        onRefresh={() => {}}
        assistant={assistant}
        onRequestAssistantAcceleration={() => {}}
      />,
    );
    expect(localHtml).toContain("实时感知");
    expect(localHtml).toContain("macOS 通知中心");
    expect(localHtml).toContain("需要完全磁盘访问权限");
    expect(localHtml).toContain("打开系统设置");
    expect(localHtml).toContain("本机免费加速");
    expect(localHtml).toContain("跟随当前模型");
    expect(localHtml).toContain("已屏蔽应用");
    expect(localHtml).toContain('aria-label="取消屏蔽 com.example.ads"');

    // Remote-only FDA hides local "打开系统设置" button and names the remote Mac.
    const remoteHtml = renderToStaticMarkup(
      <ConnectionsModule
        snapshot={snapshot}
        loading={false}
        error={null}
        connected
        onPrepare={async () => {}}
        onRefresh={() => {}}
        assistant={{
          ...assistant,
          localHost: false,
          sources: [{ ...assistant.sources[0]!, envId: "macbook-1", envName: "MacBook Pro" }],
        }}
      />,
    );
    expect(remoteHtml).toContain("MacBook Pro");
    expect(remoteHtml).not.toContain("打开系统设置");

    // Full Phase 2-4 ecosystem rows (Spark Mail, Home Assistant, Lark dual-org) render cleanly inside the single grouped list.
    const fullEcosystemHtml = renderToStaticMarkup(
      <ConnectionsModule
        snapshot={snapshot}
        loading={false}
        error={null}
        connected
        onPrepare={async () => {}}
        onRefresh={() => {}}
        assistant={{
          ...assistant,
          spark: { enabled: true, available: true, accountCount: 2, accessTier: "triage" },
          homeAssistant: { enabled: true, connected: true, hasToken: true, curatedEntities: 18, filteredNoiseCount: 140 },
          lark: {
            enabled: true,
            cliAvailable: true,
            profiles: [
              { name: "personal", ready: true, organizationKind: "personal" },
              { name: "enterprise", ready: true, organizationKind: "enterprise" },
            ],
            selectedProfiles: ["personal", "enterprise"],
          },
        }}
        onRequestAssistantAcceleration={() => {}}
        onRequestAssistantPrompt={() => {}}
      />,
    );
    expect(fullEcosystemHtml).toContain("Spark Mail");
    expect(fullEcosystemHtml).toContain("已连接 · 2 账号");
    expect(fullEcosystemHtml).toContain("米家 / Home Assistant");
    expect(fullEcosystemHtml).toContain("已连接 · 18 设备");
    expect(fullEcosystemHtml).toContain("飞书 (lark-cli)");
    expect(fullEcosystemHtml).toContain("已连接 · 2 个组织");
    expect(fullEcosystemHtml).toContain('aria-label="管理米家 / Home Assistant"');

    // Minimal HomeAssistantConfigModal mounts cleanly without throwing (Portal renders in browser DOM).
    expect(() =>
      renderToStaticMarkup(
        <HomeAssistantConfigModal
          open
          connected
          localHost
          snapshot={{
            enabled: false,
            connected: false,
            hasToken: true,
            baseUrl: "http://127.0.0.1:8123",
            migration: {
              dockerAvailable: true,
              orbStackAvailable: true,
              containerRunning: false,
              port8123Reachable: false,
              configDir: "/Users/test/.kulo-homeassistant",
              steps: [],
            },
          }}
          onRequestGuide={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});

describe("MCP app connections UI", () => {
  const mcpLinear: ConnectionRecordView = {
    id: "mcp-linear",
    name: "Linear",
    kind: "mcp",
    category: "app",
    mcpTransport: "http",
    mcpPresetId: "linear",
    url: "https://mcp.linear.app/mcp",
    mcpAuthMode: "oauth",
    mcpOAuthAuthorized: true,
    mcpServerName: "Linear MCP",
    mcpTools: [
      { name: "list_issues", readOnly: true },
      { name: "create_issue", readOnly: false },
    ],
    status: "verified",
    hasCredential: true,
    secretFields: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
  };

  const mcpPendingOAuth: ConnectionRecordView = {
    ...mcpLinear,
    id: "mcp-notion",
    name: "Notion",
    mcpPresetId: "notion",
    url: "https://mcp.notion.com/mcp",
    mcpServerName: undefined,
    mcpTools: undefined,
    mcpOAuthAuthorized: false,
    status: "saved",
    hasCredential: false,
  };

  it("renders MCP connections inside the single Apps table without leaking into Credentials", () => {
    expect(connectionCategory({ ...mcpLinear, category: undefined })).toBe("app");
    expect(connectionAddress(mcpLinear)).toBe("mcp.linear.app");
    expect(mcpConnectionStatus(mcpLinear)).toEqual({ color: "success", label: "已连接 · 2 项工具" });
    expect(mcpConnectionStatus(mcpPendingOAuth)).toEqual({ color: "warning", label: "待授权" });

    const html = renderToStaticMarkup(
      <ConnectionsModule
        snapshot={{
          ...snapshot,
          connections: [mcpLinear, mcpPendingOAuth],
          applications: [nativeApplication],
          localHost: true,
        }}
        loading={false}
        error={null}
        connected
        onPrepare={async () => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html.match(/<table\b/g)).toHaveLength(3);
    expect(html.match(/<h2 class="kulo-section-title">/g)).toHaveLength(3);
    expect(html.match(/role="columnheader"/g)).toHaveLength(9);
    expect(html).toContain("已连接 · 2 项工具");
    expect(html).toContain("待授权");
    expect(html).toContain('aria-label="授权登录Notion"');
    expect(html).toContain('aria-label="测试Linear"');
    expect(html).toContain('aria-label="编辑Linear"');
    expect(html).toContain('aria-label="取消连接Linear"');
    expect(html).toContain("尚未添加凭据");
  });

  it("validates, clears, and redacts HTTP and Stdio MCP drafts in ConnectionSetupForm", () => {
    const httpInput: ConnectionSetupInput = {
      id: "mcp-input-http",
      clientId: "tab-a",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      mcpAuthMode: "oauth",
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      status: "pending",
      createdAt: 1,
    };
    const draft = createConnectionDraft(httpInput);
    const req = connectionSaveRequest({ ...draft, mcpOAuthClientId: "cid-1", clientSecret: "secret-oauth-999" }, httpInput);
    expect(req).toMatchObject({
      name: "Linear",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://mcp.linear.app/mcp",
      mcpAuthMode: "oauth",
      mcpOAuthClientId: "cid-1",
      secrets: { clientSecret: "secret-oauth-999" },
    });
    expect(() => connectionSaveRequest({ ...draft, url: "http://mcp.linear.app/mcp" }, httpInput)).toThrow("HTTPS");
    expect(clearConnectionDraftSecrets({ ...draft, clientSecret: "secret-oauth-999" }).clientSecret).toBe("");
    expect(safeConnectionInputError(new Error("failed secret-oauth-999"), { ...draft, clientSecret: "secret-oauth-999" })).not.toContain("secret-oauth-999");

    const stdioInput: ConnectionSetupInput = {
      id: "mcp-input-stdio",
      clientId: "tab-a",
      kind: "mcp",
      category: "app",
      mcpTransport: "stdio",
      name: "Local FS",
      mcpCommand: "npx",
      mcpArgs: ["-y", "@modelcontextprotocol/server-filesystem"],
      status: "pending",
      createdAt: 1,
    };
    const stdioDraft = createConnectionDraft(stdioInput);
    stdioDraft.credentialFields = [{ key: "env_1", label: "CUSTOM_TOKEN", value: "tok-stdio-123" }];
    const stdioReq = connectionSaveRequest(stdioDraft, stdioInput);
    expect(stdioReq).toMatchObject({
      kind: "mcp",
      mcpTransport: "stdio",
      mcpCommand: "npx",
      mcpArgs: ["-y", "@modelcontextprotocol/server-filesystem"],
      credentialFields: [{ key: "CUSTOM_TOKEN", label: "CUSTOM_TOKEN" }],
      secrets: { CUSTOM_TOKEN: "tok-stdio-123" },
    });
    expect(() =>
      connectionSaveRequest({ ...stdioDraft, credentialFields: [{ key: "env_1", label: "NODE_OPTIONS", value: "bad" }] }, stdioInput),
    ).toThrow("环境变量名");

    const formHtml = renderToStaticMarkup(
      <ConnectionSetupForm input={httpInput} clientId="tab-a" connected available localHost onChanged={() => {}} />,
    );
    expect(formHtml).toContain("连接 MCP 应用");
    expect(formHtml).toContain("服务地址");
  });

  it("renders AddAppModal and McpOAuthModal cleanly without throwing", () => {
    expect(() =>
      renderToStaticMarkup(
        <AddAppModal
          open
          applications={[nativeApplication]}
          presets={[
            {
              id: "linear",
              name: "Linear",
              description: "议题、项目与迭代管理",
              transport: "http",
              url: "https://mcp.linear.app/mcp",
              authMode: "oauth",
              supportedAuthModes: ["oauth", "bearer"],
              category: "engineering",
            },
          ]}
          existingConnections={[]}
          connected
          vaultAvailable
          localHost
          onSelectApplication={() => {}}
          onSavedMcp={() => {}}
          onStartOAuth={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();

    expect(() =>
      renderToStaticMarkup(
        <McpOAuthModal
          open
          connection={mcpPendingOAuth}
          clientId="tab-a"
          onCompleted={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("renders official brand SVGs for every curated MCP preset and the official MCP mark for custom HTTP servers", () => {
    const presets: Array<[string, string]> = [
      ["linear", "linear"],
      ["notion", "notion"],
      ["atlassian", "atlassian"],
      ["sentry", "sentry"],
      ["supabase", "supabase"],
      ["vercel", "vercel"],
      ["cloudflare", "cloudflare"],
      ["stripe", "stripe"],
      ["context7", "context7"],
      ["github-mcp", "github"],
      ["figma-mcp", "figma"],
      ["slack", "slack"],
    ];
    for (const [presetId, brandClass] of presets) {
      const html = renderToStaticMarkup(<ConnectionIcon kind="mcp" mcpPresetId={presetId} mcpTransport="http" />);
      expect(html).toContain(`kulo-connection-icon--${brandClass}`);
      expect(html).toContain("<svg");
      expect(html).not.toContain("mc-icon");
    }
    const customHttpHtml = renderToStaticMarkup(<ConnectionIcon kind="mcp" mcpTransport="http" />);
    expect(customHttpHtml).toContain("<svg");
    expect(customHttpHtml).not.toContain("mc-icon");
  });
});
