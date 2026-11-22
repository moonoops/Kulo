import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type MemoryServiceJob, type MemoryServiceSecretInput, type MemoryServiceSnapshot, type ProviderCatalogItem, type KuloSettingsView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { createMemoryServiceRequest, decideMemoryServiceJob, initialMemoryServiceDraft, MemoryServiceForm, MemoryServiceJobCard, submitMemoryServiceSecret, visibleMemoryDialogueJobs, type MemoryServiceDraft } from "./memory-service-dialogue";
import { acknowledgeMemoryEnabled, createMemoryConnectionRequest, memoryConnectionDirty, memoryConnectionEditor, MemoryConnectionForm, reconcileMemoryConnection, setSavedMemoryEnabled, setSavedMemoryKnowledgeGuidance } from "./memory-service-panel";
import { isMemoryDialogueOperation, requestMemoryAssistantPrefill, takeMemoryAssistantPrefill } from "./memory-service-events";
import { buildMemoryModelsPayload, buildMemoryServicePrefillPrompt, initialMemoryModelsDraft, kuloMemoryConnections } from "./memory-service-models";

const connection = { enabled: false, endpoint: "http://127.0.0.1:8888", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "kulo-core", shared: "kulo-shared" } };
const settings: KuloSettingsView = {
  globalRevision: 1,
  blocks: {
    presentation: { revision: 1, value: { agentName: "Kulo", workbenchName: "工作台" } },
    executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
    roles: { revision: 1, value: defaultRolePresets() },
    model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "off", customProviders: [] } },
    identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
    memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: connection },
  }, history: [],
};
const snapshot: MemoryServiceSnapshot = { revision: 3, deviceName: "主脑 Mac", platform: "darwin", installed: false, running: false, connection, jobs: [], inputs: [] };
const draft: MemoryServiceDraft = {
  operation: "deploy",
  provider: "openai",
  model: "configured-model",
  baseUrl: "https://models.example/v1",
  connectionId: "api-existing",
  embeddingsProvider: "onnx",
  embeddingsConnectionId: "",
  embeddingsModel: "intfloat/multilingual-e5-small",
  embeddingsBaseUrl: "",
  embeddingsDimensions: "384",
  rerankerProvider: "onnx",
  rerankerConnectionId: "",
  rerankerModel: "hindsight-ai/hs-rerank-1",
  rerankerBaseUrl: "",
  deleteData: false,
};
const job: MemoryServiceJob = { id: "job-1", clientId: "tab-a", operation: "deploy", status: "awaiting-confirmation", stage: "等待确认", title: "部署 Hindsight", changes: ["本机保存记忆"], deviceName: "主脑 Mac", createdAt: 1, updatedAt: 1, model: { provider: "openai", model: "configured-model" } };
const input: MemoryServiceSecretInput = { id: "input-1", jobId: job.id, clientId: "tab-a", field: "modelApiKey", label: "理解模型 API Key", status: "pending", expiresAt: Date.now() + 60_000 };
const connectionForm = (nextSettings = settings, nextSnapshot = snapshot, editor = memoryConnectionEditor(nextSettings.blocks.memory), state: Pick<Parameters<typeof MemoryConnectionForm>[0], "pending" | "error" | "enabledError" | "probe" | "connected" | "providers" | "modelsDraft"> = {}) => renderToStaticMarkup(<MemoryConnectionForm settings={nextSettings} snapshot={nextSnapshot} editor={editor} {...state} onEnabledChange={() => {}} onChange={() => {}} onSave={() => {}} onProbe={() => {}} onDiscard={() => {}} onReload={() => {}} />);
afterEach(() => vi.restoreAllMocks());

describe("memory service approval and private input", () => {
  it("keeps a visible filled surface for every connection field, including empty shared secret fields", () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const emptyEditor = { ...editor, draft: { ...editor.draft, privateBank: "", sharedBank: "" } };
    for (const nextEditor of [editor, emptyEditor]) {
      const html = connectionForm(settings, snapshot, nextEditor);
      const formHtml = html.match(/<form\b[^>]*aria-label="长期记忆连接设置"[\s\S]*?<\/form>/)?.[0] ?? "";
      const fields = formHtml.match(/<input\b[^>]*class="[^"]*\binput\b[^"]*"[^>]*>/g) ?? [];
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
    expect(inputs.length).toBeGreaterThanOrEqual(7);
    for (const field of inputs) {
      if (field.includes('aria-label="启用知识整理指引"')) expect(field).toContain("disabled");
      else expect(field).not.toContain("disabled");
    }
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
    for (const field of offline.match(/<input\b[^>]*>/g) ?? []) expect(field).toContain("disabled");
  });

  it("prepares public configuration without putting credentials in the request", () => {
    const request = createMemoryServiceRequest(draft, "tab-a", 3, "command-1");
    expect(request).toEqual({
      commandId: "command-1",
      clientId: "tab-a",
      expectedRevision: 3,
      operation: "deploy",
      model: { provider: "openai", model: "configured-model", baseUrl: "https://models.example/v1", connectionId: "api-existing" },
      embeddings: { provider: "onnx", model: "intfloat/multilingual-e5-small", dimensions: 384 },
      reranker: { provider: "onnx", model: "hindsight-ai/hs-rerank-1" },
    });
    expect(Object.keys(request)).not.toContain("secret");
    expect(() => createMemoryServiceRequest({ ...draft, baseUrl: "https://user:password@models.example" }, "tab-a", 3)).toThrow("不能包含凭据");

    // Pre-selects ANY configured Kulo model connection (including Vertex AI & OAuth) via provider="kulo".
    const configuredSettings: KuloSettingsView = {
      ...settings,
      blocks: {
        ...settings.blocks,
        model: {
          ...settings.blocks.model,
          value: {
            ...settings.blocks.model.value,
            gatewayDisabled: true,
            defaultProvider: "api-vertex",
            defaultModel: "gemini-3.8-flash",
            customProviders: [{ id: "api-vertex", name: "Google Vertex AI", api: "google-vertex", baseUrl: "https://aiplatform.googleapis.com", vertexProject: "my-proj", vertexLocation: "global", models: [{ id: "gemini-3.8-flash" }] }],
          },
        },
      },
    };
    const autoDraft = initialMemoryServiceDraft("deploy", snapshot, configuredSettings);
    expect(autoDraft).toMatchObject({ connectionId: "api-vertex", provider: "kulo", model: "gemini-3.8-flash", embeddingsProvider: "onnx", rerankerProvider: "onnx" });
    const emptyModelForm = renderToStaticMarkup(
      <MemoryServiceForm draft={{ ...autoDraft, model: "" }} snapshot={snapshot} settings={configuredSettings} busy={false} onChange={() => {}} onCancel={() => {}} onSubmit={() => {}} />,
    );
    const selectValues = [...emptyModelForm.matchAll(/<span\b[^>]*data-slot="select-value"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
    expect(selectValues).toContain("未选择");
    expect(selectValues.join(" ")).not.toContain("gemini-3.8-flash");
  });

  it("allows selecting understanding, embedding, and rerank models including Vertex AI and OAuth directly on the memory page", () => {
    const catalog: ProviderCatalogItem[] = [
      { id: "api-vertex", name: "Google Vertex AI", builtin: false, supportsApiKey: true, supportsOAuth: false, authType: "api_key", authenticated: true, baseUrl: "https://aiplatform.googleapis.com", api: "google-vertex", models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true, vision: true, modalities: ["text"], contextWindow: 1000000, maxTokens: 65536, supportedThinkingLevels: ["off", "low", "medium", "high"] }] },
      { id: "openai-codex", name: "OpenAI Codex", builtin: true, supportsApiKey: false, supportsOAuth: true, authType: "oauth", authenticated: true, models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true, vision: true, modalities: ["text"], contextWindow: 400000, maxTokens: 65536, supportedThinkingLevels: ["off", "low", "medium", "high"] }] },
      { id: "anthropic", name: "Anthropic", builtin: true, supportsApiKey: false, supportsOAuth: true, authType: "oauth", authenticated: false, models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet", reasoning: true, vision: true, modalities: ["text"], contextWindow: 200000, maxTokens: 65536, supportedThinkingLevels: ["off", "low", "medium", "high"] }] },
    ];
    const connections = kuloMemoryConnections(settings, catalog);
    expect(connections.map((c) => c.id)).toEqual(["api-vertex", "openai-codex"]);
    const modelDraft = initialMemoryModelsDraft(undefined, settings, catalog);
    expect(modelDraft).toMatchObject({ provider: "kulo", connectionId: "api-vertex", model: "gemini-3.8-flash", embeddingsProvider: "onnx", rerankerProvider: "onnx" });

    const html = connectionForm(settings, snapshot, undefined, { providers: catalog, modelsDraft: modelDraft });
    expect(html).toContain("理解模型来源");
    expect(html).toContain("理解模型");
    expect(html).toContain("向量模型（Embedding）");
    expect(html).toContain("重排模型（Rerank）");
    expect(html).toContain("Google Vertex AI");
    expect(html).toContain("gemini-3.8-flash");

    const customPayload = buildMemoryModelsPayload({
      ...modelDraft,
      connectionId: "openai-codex",
      model: "gpt-5.4",
      embeddingsProvider: "openai",
      embeddingsModel: "text-embedding-3-large",
      embeddingsBaseUrl: "https://embed.example/v1",
      embeddingsDimensions: "1536",
      rerankerProvider: "siliconflow",
      rerankerModel: "BAAI/bge-reranker-v2-m3",
      rerankerBaseUrl: "https://api.siliconflow.cn/v1",
    });
    expect(customPayload).toEqual({
      model: { provider: "kulo", connectionId: "openai-codex", model: "gpt-5.4" },
      embeddings: { provider: "openai", model: "text-embedding-3-large", baseUrl: "https://embed.example/v1", dimensions: 1536 },
      reranker: { provider: "siliconflow", model: "BAAI/bge-reranker-v2-m3", baseUrl: "https://api.siliconflow.cn/v1" },
    });
  });

  it("renders secure secret inputs for embedding and rerank API keys on the job card", () => {
    const embInput: MemoryServiceSecretInput = { id: "input-emb", jobId: job.id, clientId: "tab-a", field: "embeddingsApiKey", label: "向量模型 API Key", status: "pending", expiresAt: Date.now() + 60_000 };
    const rrInput: MemoryServiceSecretInput = { id: "input-rr", jobId: job.id, clientId: "tab-a", field: "rerankerApiKey", label: "重排模型 API Key", status: "pending", expiresAt: Date.now() + 60_000 };
    const html = renderToStaticMarkup(<MemoryServiceJobCard job={{ ...job, status: "awaiting-input" }} inputs={[embInput, rrInput]} clientId="tab-a" connected onChanged={() => {}} />);
    expect(html).toContain("向量模型 API Key");
    expect(html).toContain("重排模型 API Key");
    expect(html.match(/type="password"/g)).toHaveLength(2);
  });

  it("submits existing connection credentials directly from the left form without preparing a dialogue job", () => {
    const save = vi.spyOn(kuloRest, "saveSettingsBlock");
    const prepare = vi.spyOn(kuloRest, "prepareMemoryService");
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
    expect(request.connection.accessMode).toBe("kulo");
    expect(request).not.toHaveProperty("sharedReadApiKey");
    expect(request).not.toHaveProperty("caCertPem");
    expect(settings.blocks.memory.value.endpoints).toEqual([]);
  });

  it("cannot confirm an unfinished or foreign job", async () => {
    const decide = vi.spyOn(kuloRest, "decideMemoryService").mockResolvedValue(snapshot);
    await expect(decideMemoryServiceJob(job, "tab-b", "confirm")).rejects.toThrow("发起操作的窗口");
    for (const status of ["awaiting-input", "running", "succeeded", "rejected"] as const) await expect(decideMemoryServiceJob({ ...job, status }, "tab-a", "confirm")).rejects.toThrow("已经处理");
    expect(decide).not.toHaveBeenCalled();
    await decideMemoryServiceJob(job, "tab-a", "confirm");
    expect(decide).toHaveBeenCalledExactlyOnceWith(job.id, { clientId: "tab-a", decision: "confirm" });
  });

  it("retries the approved failed job using the same identity instead of preparing another install", async () => {
    const decide = vi.spyOn(kuloRest, "decideMemoryService").mockResolvedValue(snapshot);
    const prepare = vi.spyOn(kuloRest, "prepareMemoryService");
    await decideMemoryServiceJob({ ...job, status: "failed" }, "tab-a", "confirm");
    expect(decide).toHaveBeenCalledExactlyOnceWith(job.id, { clientId: "tab-a", decision: "confirm" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("sends a secret only to its dedicated input endpoint", async () => {
    const submit = vi.spyOn(kuloRest, "submitMemoryServiceInput").mockResolvedValue(snapshot);
    const prepare = vi.spyOn(kuloRest, "prepareMemoryService");
    await expect(submitMemoryServiceSecret(input, "tab-b", "test-private-value")).rejects.toThrow("发起配置的窗口");
    await expect(submitMemoryServiceSecret({ ...input, expiresAt: 0 }, "tab-a", "test-private-value")).rejects.toThrow("失效");
    expect(submit).not.toHaveBeenCalled();
    await submitMemoryServiceSecret(input, "tab-a", "test-private-value");
    expect(submit).toHaveBeenCalledExactlyOnceWith(input.id, { clientId: "tab-a", secret: "test-private-value" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("renders a single explicit deployment confirmation and empty private input", () => {
    const decide = vi.spyOn(kuloRest, "decideMemoryService");
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
    expect(connectionForm()).not.toContain("清理未完成安装");
    const installed = connectionForm(settings, { ...snapshot, installed: true, running: true, phase: "ready", version: "1.2.1", model: job.model });
    expect(installed).toContain("运行中 · 1.2.1");
    expect(installed).toContain("卸载本机服务");
    expect(installed).toContain("配置本机模型");
    expect(installed).not.toContain("在本机配置 Hindsight");
    const failed = connectionForm(settings, { ...snapshot, installed: false, running: false, phase: "failed", version: "1.2.1", model: job.model });
    expect(failed).toContain("部署失败");
    expect(failed).toContain("重新部署");
    expect(failed).toContain("清理未完成安装");
    expect(failed).not.toContain("已停止");
    expect(failed).not.toContain("恢复部署");
    expect(failed).not.toContain("卸载本机服务");
    expect(failed).not.toContain("配置本机模型");
    const installing = connectionForm(settings, { ...snapshot, installed: false, running: false, phase: "installing" });
    expect(installing).toContain("部署中");
    expect(installing).toContain("清理未完成安装");
    expect(installing).not.toContain("重新部署");
    expect(installing).not.toContain("配置本机模型");
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
    const knowledgeOff = empty.match(/<input\b[^>]*aria-label="启用知识整理指引"[^>]*>/)?.[0];
    expect(knowledgeOff).toContain("disabled");
    expect(knowledgeOff).not.toContain("checked");
    const savedKnowledge = { ...settings, blocks: { ...settings.blocks, memory: { ...settings.blocks.memory, value: { ...connection, enabled: true, knowledgeGuidanceEnabled: true } } } };
    const withKnowledge = renderToStaticMarkup(
      <MemoryConnectionForm
        settings={savedKnowledge}
        snapshot={{ ...snapshot, connection: savedKnowledge.blocks.memory.value }}
        editor={memoryConnectionEditor(savedKnowledge.blocks.memory)}
        onChange={() => {}}
        onEnabledChange={() => {}}
        onKnowledgeGuidanceChange={() => {}}
        onSave={() => {}}
        onProbe={() => {}}
        onDiscard={() => {}}
        onReload={() => {}}
      />,
    );
    const knowledgeOn = withKnowledge.match(/<input\b[^>]*aria-label="启用知识整理指引"[^>]*>/)?.[0];
    expect(knowledgeOn).toContain("checked");
    expect(knowledgeOn).not.toContain("disabled");
  });

  it("toggles the independent knowledge guidance switch via its dedicated endpoint", async () => {
    const service = { ...snapshot, revision: 2, connection: { ...connection, enabled: true, knowledgeGuidanceEnabled: true } };
    const toggle = vi.spyOn(kuloRest, "setMemoryKnowledgeGuidance").mockResolvedValue(service);
    const result = await setSavedMemoryKnowledgeGuidance(settings.blocks.memory, true);
    expect(toggle).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedRevision: 1 });
    expect(result.connection.knowledgeGuidanceEnabled).toBe(true);
  });

  it("toggles only the saved connection and rebases without submitting or clearing complex drafts", async () => {
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const editing = { ...editor, draft: { ...editor.draft, endpoint: "https://new-origin.example", endpoints: ["https://backup-draft.example"], privateBank: "new-private", sharedBank: "new-shared", routerApiKey: "unsaved-private-secret", workerApiKey: "unsaved-public-secret", clearRouterApiKey: true, clearWorkerApiKey: true } };
    const service = { ...snapshot, revision: 2, connection: { ...connection, enabled: true } };
    const toggle = vi.spyOn(kuloRest, "setMemoryEnabled").mockResolvedValue(service);
    const save = vi.spyOn(kuloRest, "saveMemoryConnection");
    const probe = vi.spyOn(kuloRest, "probeMemoryConnection");
    const saveBlock = vi.spyOn(kuloRest, "saveSettingsBlock");
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
    const toggle = vi.spyOn(kuloRest, "setMemoryEnabled").mockRejectedValueOnce(new Error("连接未通过检查，未启用长期记忆。")).mockResolvedValueOnce({ ...snapshot, revision: 2, connection: { ...connection, enabled: true } });
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

  it.each(["kulo", "scoped", "private-only"] as const)("keeps internal access policy and certificates out of the %s connection form", (accessMode) => {
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
    expect(form).toContain("理解模型");
    expect(form).toContain("向量模型（Embedding）");
    expect(form).toContain("重排模型（Rerank）");
    for (const field of ["Hindsight 地址", "隐私记忆库名", "共享记忆库名", "公开目录密钥"]) expect(form).not.toContain(field);
  });

  it("builds an editable right-assistant prefill prompt without stacking left-side job cards", () => {
    const catalog: ProviderCatalogItem[] = [
      { id: "api-vertex", name: "Google Vertex AI", builtin: false, supportsApiKey: true, supportsOAuth: false, authType: "api_key", authenticated: true, baseUrl: "https://aiplatform.googleapis.com", api: "google-vertex", models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true, vision: true, modalities: ["text"], contextWindow: 1000000, maxTokens: 65536, supportedThinkingLevels: ["off", "low", "medium", "high"] }] },
    ];
    const connections = kuloMemoryConnections(settings, catalog);
    const modelDraft = {
      ...initialMemoryModelsDraft(undefined, settings, catalog),
      embeddingsProvider: "onnx" as const,
      embeddingsModel: "BAAI/bge-m3",
      embeddingsDimensions: "1024",
      rerankerProvider: "onnx" as const,
      rerankerModel: "BAAI/bge-reranker-v2-m3",
    };

    const deployPrompt = buildMemoryServicePrefillPrompt({
      operation: "deploy",
      deviceName: "Macmini.local",
      draft: modelDraft,
      connections,
    });
    expect(deployPrompt).toContain("Macmini.local");
    expect(deployPrompt).toContain("Google Vertex AI");
    expect(deployPrompt).toContain("provider: kulo, connectionId: api-vertex");
    expect(deployPrompt).toContain("gemini-3.8-flash");
    expect(deployPrompt).toContain("BAAI/bge-m3");
    expect(deployPrompt).toContain("dimensions: 1024");
    expect(deployPrompt).toContain("onnx-community/bge-reranker-v2-m3-ONNX");
    expect(deployPrompt).toContain("待我确认后执行");

    const normalizedSavedDraft = initialMemoryModelsDraft(
      {
        embeddings: { provider: "onnx", model: "BAAI/bge-small-zh-v1.5", dimensions: 512 },
        reranker: { provider: "onnx", model: "BAAI/bge-reranker-v2-m3" },
      },
      settings,
      catalog,
    );
    expect(normalizedSavedDraft.embeddingsModel).toBe("Xenova/bge-small-zh-v1.5");
    expect(normalizedSavedDraft.rerankerModel).toBe("onnx-community/bge-reranker-v2-m3-ONNX");

    const retryPrompt = buildMemoryServicePrefillPrompt({
      operation: "deploy",
      retry: true,
      deviceName: "Macmini.local",
      draft: modelDraft,
      connections,
    });
    expect(retryPrompt).toContain("重新");
    expect(retryPrompt).not.toContain("恢复");

    const configurePrompt = buildMemoryServicePrefillPrompt({
      operation: "configure",
      deviceName: "Macmini.local",
      draft: { ...modelDraft, rerankerProvider: "rrf", rerankerModel: "" },
      connections,
    });
    expect(configurePrompt).toContain("更新");
    expect(configurePrompt).toContain("provider: rrf");

    // Pending prefill queues safely until consumed by the right assistant panel.
    requestMemoryAssistantPrefill(deployPrompt);
    expect(takeMemoryAssistantPrefill()).toBe(deployPrompt);
    expect(takeMemoryAssistantPrefill()).toBeNull();

    // Left MemoryConnectionForm must never render stacked MemoryServiceJobCards even if jobs exist in snapshot.
    const withPendingJobs: MemoryServiceSnapshot = {
      ...snapshot,
      jobs: [
        { ...job, id: "failed-1", status: "failed", error: "本机未检测到 uv" },
        { ...job, id: "confirm-2", status: "awaiting-confirmation" },
      ],
    };
    const leftHtml = connectionForm(settings, withPendingJobs);
    expect(leftHtml).not.toContain("确认部署");
    expect(leftHtml).not.toContain("本机未检测到 uv");
  });

  it("allows dismissing failed job cards and hides cancelled or historical dialogue jobs", async () => {
    const failedJob: MemoryServiceJob = { ...job, id: "failed-job", status: "failed", stage: "未完成", changes: ["主脑 Mac", "理解模型：openai / configured-model"], error: "本机未检测到 uv" };
    const cardHtml = renderToStaticMarkup(<MemoryServiceJobCard job={failedJob} inputs={[]} clientId="tab-a" connected onChanged={() => {}} />);
    expect(cardHtml).toContain("重试");
    expect(cardHtml).toContain("关闭");
    expect(cardHtml.match(/主脑 Mac/g)).toHaveLength(1);

    const decide = vi.spyOn(kuloRest, "decideMemoryService").mockResolvedValue(snapshot);
    await decideMemoryServiceJob(failedJob, "tab-a", "reject");
    expect(decide).toHaveBeenCalledExactlyOnceWith("failed-job", { clientId: "tab-a", decision: "reject" });

    const cancelled: MemoryServiceJob = { ...job, id: "j-rejected", status: "rejected" };
    const oldSuccess: MemoryServiceJob = { ...job, id: "j-old-ok", status: "succeeded" };
    const currentSuccess: MemoryServiceJob = { ...job, id: "j-live-ok", status: "succeeded" };
    const activeConfirm: MemoryServiceJob = { ...job, id: "j-confirm", status: "awaiting-confirmation" };

    expect(visibleMemoryDialogueJobs([cancelled, oldSuccess], "tab-a")).toEqual([]);
    expect(visibleMemoryDialogueJobs([cancelled, oldSuccess, currentSuccess], "tab-a", new Set(["j-live-ok"])).map((j) => j.id)).toEqual(["j-live-ok"]);
    expect(visibleMemoryDialogueJobs([cancelled, currentSuccess, activeConfirm], "tab-a", new Set(["j-live-ok", "j-confirm"])).map((j) => j.id)).toEqual(["j-confirm"]);
  });
});
