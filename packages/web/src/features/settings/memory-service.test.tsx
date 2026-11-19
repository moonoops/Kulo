import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type MemoryServiceJob, type MemoryServiceSecretInput, type MemoryServiceSnapshot, type MocoSettingsView } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { createMemoryServiceRequest, decideMemoryServiceJob, MemoryServiceForm, MemoryServiceJobCard, submitMemoryServiceSecret, type MemoryServiceDraft } from "./memory-service-dialogue";
import { acknowledgeMemoryEnabled, createMemoryConnectionRequest, memoryConnectionDirty, memoryConnectionEditor, MemoryConnectionForm, reconcileMemoryConnection, setSavedMemoryEnabled } from "./memory-service-panel";
import { isMemoryDialogueOperation } from "./memory-service-events";

const connection = { enabled: false, endpoint: "http://127.0.0.1:8888", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "moco-core", shared: "moco-shared" } };
const settings: MocoSettingsView = {
  globalRevision: 1,
  blocks: {
    presentation: { revision: 1, value: { agentName: "Moco", workbenchName: "工作台" } },
    executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
    roles: { revision: 1, value: defaultRolePresets() },
    model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "off", customProviders: [] } },
    identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
    memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: connection },
  }, history: [],
};
const snapshot: MemoryServiceSnapshot = { revision: 3, deviceName: "主脑 Mac", platform: "darwin", installed: false, running: false, connection, jobs: [], inputs: [] };
const draft: MemoryServiceDraft = { operation: "deploy", provider: "openai", model: "configured-model", baseUrl: "https://models.example/v1", connectionId: "api-existing", deleteData: false };
const job: MemoryServiceJob = { id: "job-1", clientId: "tab-a", operation: "deploy", status: "awaiting-confirmation", stage: "等待确认", title: "部署 Hindsight", changes: ["本机保存记忆"], deviceName: "主脑 Mac", createdAt: 1, updatedAt: 1, model: { provider: "openai", model: "configured-model" } };
const input: MemoryServiceSecretInput = { id: "input-1", jobId: job.id, clientId: "tab-a", field: "modelApiKey", label: "模型 API Key", status: "pending", expiresAt: Date.now() + 60_000 };
const connectionForm = (nextSettings = settings, nextSnapshot = snapshot, editor = memoryConnectionEditor(nextSettings.blocks.memory), state: Pick<Parameters<typeof MemoryConnectionForm>[0], "pending" | "error" | "enabledError" | "probe" | "connected"> = {}) => renderToStaticMarkup(<MemoryConnectionForm settings={nextSettings} snapshot={nextSnapshot} editor={editor} {...state} onEnabledChange={() => {}} onChange={() => {}} onSave={() => {}} onProbe={() => {}} onDiscard={() => {}} onReload={() => {}} />);
afterEach(() => vi.restoreAllMocks());

describe("memory service approval and private input", () => {
  it("keeps a visible filled surface for every connection field, including empty shared secret fields", () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const emptyEditor = { ...editor, draft: { ...editor.draft, privateBank: "", sharedBank: "" } };
    for (const nextEditor of [editor, emptyEditor]) {
      const html = connectionForm(settings, snapshot, nextEditor);
      const fields = html.match(/<input\b[^>]*class="[^"]*\binput\b[^"]*"[^>]*>/g) ?? [];
      expect(fields).toHaveLength(5);
      for (const field of fields) expect(field).toContain("input--secondary");
      expect(fields.filter((field) => field.includes('type="password"'))).toHaveLength(2);
    }
  });

  it("locks connection editing without dimming the form while a probe keeps its prior feedback", () => {
    const html = connectionForm(settings, snapshot, undefined, { pending: "probe", error: "上次连接失败" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('inert=""');
    expect(html).toContain("上次连接失败");
    expect(html.indexOf('aria-label="测试连接"')).toBeLessThan(html.indexOf("上次连接失败"));
    const inputs = html.match(/<input\b[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(6);
    for (const input of inputs) expect(input).not.toContain("disabled");
    const button = html.match(/<button\b[^>]*aria-label="测试连接"[^>]*>/)?.[0];
    expect(button).toContain('data-pending="true"');
    expect(button).not.toMatch(/\sdisabled=/);
    expect(button).toContain('tabindex="0"');
  });

  it("shows progress for the active action and preserves genuine offline disabling", () => {
    const saving = connectionForm(settings, snapshot, undefined, { pending: "save" });
    expect(saving).not.toContain("正在测试连接");
    expect(saving.match(/<button\b[^>]*aria-label="测试连接"[^>]*>/)?.[0]).toContain("disabled");
    const offline = connectionForm(settings, snapshot, undefined, { connected: false });
    for (const input of offline.match(/<input\b[^>]*>/g) ?? []) expect(input).toContain("disabled");
  });

  it("prepares public configuration without putting credentials in the request", () => {
    const request = createMemoryServiceRequest(draft, "tab-a", 3, "command-1");
    expect(request).toEqual({ commandId: "command-1", clientId: "tab-a", expectedRevision: 3, operation: "deploy", model: { provider: "openai", model: "configured-model", baseUrl: "https://models.example/v1", connectionId: "api-existing" } });
    expect(Object.keys(request)).not.toContain("secret");
    expect(() => createMemoryServiceRequest({ ...draft, baseUrl: "https://user:password@models.example" }, "tab-a", 3)).toThrow("不能包含凭据");
  });

  it("submits existing connection credentials directly from the left form without preparing a dialogue job", () => {
    const save = vi.spyOn(mocoRest, "saveSettingsBlock");
    const prepare = vi.spyOn(mocoRest, "prepareMemoryService");
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const request = createMemoryConnectionRequest({ ...editor.draft, enabled: true, accessMode: "private-only", endpoint: "https://memory.example", endpoints: ["https://backup.example", ""], routerApiKey: "synthetic-private-key", workerApiKey: "unused-worker-key" }, 3);
    expect(request.connection).toEqual({ endpoint: "https://memory.example", endpoints: ["https://backup.example"], accessMode: "private-only", banks: connection.banks });
    expect(request.enabled).toBe(true);
    expect(request.routerApiKey).toBe("synthetic-private-key");
    expect(request.workerApiKey).toBeUndefined();
    expect(request).not.toHaveProperty("commandId");
    expect(prepare).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the two connection credentials and ordered backup addresses in a single save", () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const request = createMemoryConnectionRequest({ ...editor.draft, routerApiKey: "private-key", workerApiKey: "public-directory-key", endpoints: [" https://first.example ", "", "https://second.example"] }, editor.revision);
    expect(request.routerApiKey).toBe("private-key");
    expect(request.workerApiKey).toBe("public-directory-key");
    expect(request.connection.endpoints).toEqual(["https://first.example", "https://second.example"]);
    expect(request.connection.accessMode).toBe("moco");
    expect(request).not.toHaveProperty("sharedReadApiKey");
    expect(request).not.toHaveProperty("caCertPem");
    expect(settings.blocks.memory.value.endpoints).toEqual([]);
  });

  it("cannot confirm an unfinished or foreign job", async () => {
    const decide = vi.spyOn(mocoRest, "decideMemoryService").mockResolvedValue(snapshot);
    await expect(decideMemoryServiceJob(job, "tab-b", "confirm")).rejects.toThrow("发起操作的窗口");
    for (const status of ["awaiting-input", "running", "succeeded", "rejected"] as const) await expect(decideMemoryServiceJob({ ...job, status }, "tab-a", "confirm")).rejects.toThrow("已经处理");
    expect(decide).not.toHaveBeenCalled();
    await decideMemoryServiceJob(job, "tab-a", "confirm");
    expect(decide).toHaveBeenCalledExactlyOnceWith(job.id, { clientId: "tab-a", decision: "confirm" });
  });

  it("retries the approved failed job using the same identity instead of preparing another install", async () => {
    const decide = vi.spyOn(mocoRest, "decideMemoryService").mockResolvedValue(snapshot);
    const prepare = vi.spyOn(mocoRest, "prepareMemoryService");
    await decideMemoryServiceJob({ ...job, status: "failed" }, "tab-a", "confirm");
    expect(decide).toHaveBeenCalledExactlyOnceWith(job.id, { clientId: "tab-a", decision: "confirm" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("sends a secret only to its dedicated input endpoint", async () => {
    const submit = vi.spyOn(mocoRest, "submitMemoryServiceInput").mockResolvedValue(snapshot);
    const prepare = vi.spyOn(mocoRest, "prepareMemoryService");
    await expect(submitMemoryServiceSecret(input, "tab-b", "test-private-value")).rejects.toThrow("发起配置的窗口");
    await expect(submitMemoryServiceSecret({ ...input, expiresAt: 0 }, "tab-a", "test-private-value")).rejects.toThrow("失效");
    expect(submit).not.toHaveBeenCalled();
    await submitMemoryServiceSecret(input, "tab-a", "test-private-value");
    expect(submit).toHaveBeenCalledExactlyOnceWith(input.id, { clientId: "tab-a", secret: "test-private-value" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("renders a single explicit deployment confirmation and empty private input", () => {
    const decide = vi.spyOn(mocoRest, "decideMemoryService");
    const html = renderToStaticMarkup(<MemoryServiceJobCard job={job} inputs={[]} clientId="tab-a" connected onChanged={() => {}} />);
    expect(html).toContain("确认部署");
    expect(html).toContain("主脑 Mac");
    expect(html).toContain("所选模型服务将处理记忆内容");
    expect(html).not.toContain("查看并确认");
    expect(decide).not.toHaveBeenCalled();
    const withSecret = Object.assign({ ...job, status: "awaiting-input" as const }, { apiKey: "persisted-secret-sentinel" });
    const secretHtml = renderToStaticMarkup(<MemoryServiceJobCard job={withSecret} inputs={[input]} clientId="tab-a" connected onChanged={() => {}} />);
    expect(secretHtml).toContain('type="password"');
    expect(secretHtml).toContain('autoComplete="new-password"');
    expect(secretHtml).toContain('value=""');
    expect(secretHtml).not.toContain("persisted-secret-sentinel");
    expect(secretHtml).not.toContain("确认部署");
  });

  it("defaults uninstall to preserving data and exposes it only for managed installs", () => {
    const request = createMemoryServiceRequest({ ...draft, operation: "uninstall" }, "tab-a", 3, "uninstall-1");
    expect(request.deleteData).toBe(false);
    const form = renderToStaticMarkup(<MemoryServiceForm draft={{ ...draft, operation: "uninstall" }} snapshot={snapshot} settings={settings} busy={false} onChange={() => {}} onCancel={() => {}} onSubmit={() => {}} />);
    expect(form).toContain("同时删除记忆数据");
    const checkbox = form.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toContain("checked");
    expect(connectionForm()).not.toContain("卸载本机服务");
    const installed = connectionForm(settings, { ...snapshot, installed: true, running: true, model: job.model });
    expect(installed).toContain("卸载本机服务");
    expect(installed).toContain("配置本机模型");
    expect(installed).not.toContain("在本机配置 Hindsight");
    const failed = connectionForm(settings, { ...snapshot, installed: true, phase: "failed" });
    expect(failed).toContain("恢复部署");
  });

  it("separates the saved runtime switch from the complete manual connection form", () => {
    const empty = connectionForm();
    const emptySwitch = empty.match(/<input\b[^>]*aria-label="启用长期记忆"[^>]*>/)?.[0];
    expect(emptySwitch).toBeDefined();
    expect(emptySwitch).not.toContain("disabled");
    for (const label of ["Hindsight 地址", "添加备用地址", "隐私记忆库名", "共享记忆库名", "密钥", "公开目录密钥", "测试连接", "在本机配置 Hindsight"]) expect(empty).toContain(label);
    expect(empty.match(/type="password"/g)).toHaveLength(2);
    expect(empty).not.toContain("连接已有服务");
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const changedDraft = { ...editor, draft: { ...editor.draft, enabled: true, endpoint: "https://draft.example" } };
    const unsaved = connectionForm(settings, snapshot, changedDraft);
    expect(unsaved.match(/<input\b[^>]*aria-label="启用长期记忆"[^>]*>/)?.[0]).not.toContain("checked");
    expect(unsaved.indexOf('aria-label="启用长期记忆"')).toBeLessThan(unsaved.indexOf('<form'));
    expect(unsaved).toContain("连接配置未保存");
    expect(unsaved).toContain("保存连接配置");
    const savedEnabled = { ...settings, blocks: { ...settings.blocks, memory: { ...settings.blocks.memory, value: { ...connection, enabled: true } } } };
    const enabled = connectionForm(savedEnabled, { ...snapshot, connection: savedEnabled.blocks.memory.value }, changedDraft);
    const enabledSwitch = enabled.match(/<input\b[^>]*aria-label="启用长期记忆"[^>]*>/)?.[0];
    expect(enabledSwitch).toContain("checked");
    expect(enabledSwitch).not.toContain("disabled");
    expect(enabled).toContain("验证并保存");
    expect(enabled).toContain("连接配置未保存");
  });

  it("toggles only the saved connection and rebases without submitting or clearing complex drafts", async () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const editing = { ...editor, draft: { ...editor.draft, endpoint: "https://new-origin.example", endpoints: ["https://backup-draft.example"], privateBank: "new-private", sharedBank: "new-shared", routerApiKey: "unsaved-private-secret", workerApiKey: "unsaved-public-secret", clearRouterApiKey: true, clearWorkerApiKey: true } };
    const service = { ...snapshot, revision: 2, connection: { ...connection, enabled: true } };
    const toggle = vi.spyOn(mocoRest, "setMemoryEnabled").mockResolvedValue(service);
    const save = vi.spyOn(mocoRest, "saveMemoryConnection");
    const probe = vi.spyOn(mocoRest, "probeMemoryConnection");
    const saveBlock = vi.spyOn(mocoRest, "saveSettingsBlock");
    const result = await setSavedMemoryEnabled(settings.blocks.memory, true);
    expect(toggle).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedRevision: 1 });
    expect(save).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(saveBlock).not.toHaveBeenCalled();
    const next = acknowledgeMemoryEnabled(editing, { ...settings.blocks.memory, revision: result.revision, value: result.connection }, 1);
    expect(next.draft).toEqual({ ...editing.draft, enabled: true });
    expect(next.base).toEqual({ ...editing.base, enabled: true });
    expect(next.revision).toBe(2);
    expect(next.conflict).toBe(false);
    expect(memoryConnectionDirty(next)).toBe(true);
    expect(editing.revision).toBe(1);
  });

  it("keeps the saved runtime state and connection draft after an enable failure, then permits an explicit retry", async () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const editing = { ...editor, draft: { ...editor.draft, endpoint: "https://draft.example", routerApiKey: "draft-private-key" } };
    const toggle = vi.spyOn(mocoRest, "setMemoryEnabled").mockRejectedValueOnce(new Error("连接未通过检查，未启用长期记忆。")).mockResolvedValueOnce({ ...snapshot, revision: 2, connection: { ...connection, enabled: true } });
    await expect(setSavedMemoryEnabled(settings.blocks.memory, true)).rejects.toThrow("未启用长期记忆");
    const failed = connectionForm(settings, snapshot, editing, { enabledError: "连接未通过检查，未启用长期记忆。" });
    expect(failed.match(/<input\b[^>]*aria-label="启用长期记忆"[^>]*>/)?.[0]).not.toContain("checked");
    expect(failed).toContain("连接未通过检查，未启用长期记忆。");
    expect(editing.draft.routerApiKey).toBe("draft-private-key");
    expect(memoryConnectionDirty(editing)).toBe(true);
    await expect(setSavedMemoryEnabled(settings.blocks.memory, true)).resolves.toMatchObject({ connection: { enabled: true } });
    expect(toggle).toHaveBeenNthCalledWith(2, { enabled: true, expectedRevision: 1 });
  });

  it("keeps concurrent conflicts and never treats an unacknowledged revision as a harmless switch change", () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const editing = { ...editor, draft: { ...editor.draft, routerApiKey: "draft-private-key" } };
    const enabled = { ...settings.blocks.memory, revision: 2, value: { ...connection, enabled: true } };
    expect(reconcileMemoryConnection(editing, enabled)).toMatchObject({ revision: 1, conflict: true, draft: editing.draft });
    expect(acknowledgeMemoryEnabled({ ...editing, conflict: true }, enabled, 1)).toMatchObject({ revision: 1, conflict: true, draft: editing.draft });
    const changedConnection = { ...enabled, value: { ...enabled.value, endpoint: "https://external.example" } };
    expect(acknowledgeMemoryEnabled(editing, changedConnection, 1)).toMatchObject({ revision: 1, conflict: true, draft: editing.draft });
  });

  it.each(["moco", "scoped", "private-only"] as const)("keeps internal access policy and certificates out of the %s connection form", (accessMode) => {
    const stored = { ...settings, blocks: { ...settings.blocks, memory: { ...settings.blocks.memory, value: { ...connection, accessMode, caCertPem: "legacy-certificate" } } } };
    const editor = memoryConnectionEditor(stored.blocks.memory);
    const html = connectionForm(stored);
    for (const label of ["接入方式", "CA 证书", "高级连接设置", "主脑密钥", "Worker 密钥", "共享库只读密钥", "legacy-certificate"]) expect(html).not.toContain(label);
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain("公开目录密钥");
    expect(html).toContain("隐私记忆库名");
    expect(html).toContain("共享记忆库名");
    expect(createMemoryConnectionRequest(editor.draft, editor.revision).connection.accessMode).toBe(accessMode);
  });

  it("synchronizes deployed connection settings and preserves concurrent manual drafts", () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const deployed = { ...settings.blocks.memory, revision: 2, hasRouterApiKey: true, hasWorkerApiKey: true, value: { ...connection, enabled: true, endpoint: "http://127.0.0.1:18888" } };
    const synchronized = reconcileMemoryConnection(editor, deployed);
    expect(synchronized.draft.endpoint).toBe(deployed.value.endpoint);
    expect(synchronized.draft.enabled).toBe(true);
    expect(synchronized.draft.routerApiKey).toBe("");
    expect(memoryConnectionDirty(synchronized)).toBe(false);
    const editing = { ...editor, draft: { ...editor.draft, endpoint: "https://my-service.example" } };
    const conflict = reconcileMemoryConnection(editing, deployed);
    expect(conflict.draft.endpoint).toBe("https://my-service.example");
    expect(conflict.conflict).toBe(true);
    expect(conflict.revision).toBe(editor.revision);
  });

  it("keeps stored credentials masked and clears them only when explicitly requested", () => {
    const saved = { ...settings, blocks: { ...settings.blocks, memory: { ...settings.blocks.memory, value: { ...settings.blocks.memory.value }, hasRouterApiKey: true, hasWorkerApiKey: true } } };
    Object.assign(saved.blocks.memory.value, { routerApiKey: "stored-router-key", workerApiKey: "stored-worker-key" });
    const editor = memoryConnectionEditor(saved.blocks.memory);
    expect(editor.draft.routerApiKey).toBe("");
    expect(editor.draft.workerApiKey).toBe("");
    expect(connectionForm(saved)).toContain("已保存，留空保留");
    expect(connectionForm(saved)).not.toContain("stored-router-key");
    const blank = createMemoryConnectionRequest(editor.draft, editor.revision);
    expect(blank).not.toHaveProperty("routerApiKey");
    expect(blank).not.toHaveProperty("clearRouterApiKey");
    expect(createMemoryConnectionRequest({ ...editor.draft, clearRouterApiKey: true }, editor.revision).clearRouterApiKey).toBe(true);
  });

  it("uses the right dialogue only for managed lifecycle operations", () => {
    for (const operation of ["deploy", "configure", "uninstall"] as const) expect(isMemoryDialogueOperation(operation)).toBe(true);
    for (const operation of ["connect", "disconnect", "check"] as const) expect(isMemoryDialogueOperation(operation)).toBe(false);
    const form = renderToStaticMarkup(<MemoryServiceForm draft={draft} snapshot={snapshot} settings={settings} busy={false} onChange={() => {}} onCancel={() => {}} onSubmit={() => {}} />);
    expect(form).toContain("记忆模型");
    for (const field of ["Hindsight 地址", "隐私记忆库名", "共享记忆库名", "公开目录密钥"]) expect(form).not.toContain(field);
  });
});
