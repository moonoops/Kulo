import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_MODEL_PRESETS, type CapabilitiesWorkspaceSnapshot, type ImageModelDiscovery } from "@kulo/protocol";
import { ImageCapabilityEditor, ImageCapabilityFields, SharedImageCapabilityEditor, applyImageModelPreset, createImageDraftConfig, imageConfigFromCapability, mergeImageGenerationParameters, reloadImageDraftConfiguration } from "./image-capability-editor";
import { ImageProviderPicker, prepareImageCandidateDraft, selectableImageCandidateIds } from "./image-provider-picker";
import { ImageRoutingEditor, moveImageRoutingRule } from "./image-routing-editor";
import { ImageCapabilitiesPanel } from "./image-capabilities-panel";
import { kuloRest } from "../../kulo-api";

afterEach(() => vi.restoreAllMocks());

const workspace: CapabilitiesWorkspaceSnapshot = {
  revision: 1, capabilities: [], connections: [], skills: [], skillRevision: 1, jobs: [], inputs: [],
  imageSetup: { providers: [
    { id: "google-api", name: "Google API", api: "google-generative-ai", baseUrl: "https://images.example.test/v1beta", authType: "api_key", authenticated: true, imageSupported: true },
    { id: "subscription", name: "ChatGPT", authType: "oauth", authenticated: true, imageSupported: false, reason: "此授权暂不支持生图" },
  ] },
};
const preset = IMAGE_MODEL_PRESETS.find((item) => item.modelId === "gpt-image-2.6-flare")!;
const draft = { name: preset.name, adapter: preset.adapter, baseUrl: preset.baseUrl, modelId: preset.modelId, imageProfile: preset.profile, defaults: preset.defaults };
const discovery: ImageModelDiscovery = { id: "discovery-a", clientId: "client-a", status: "partial", createdAt: 1, errors: [{ providerId: "offline", providerName: "离线服务", error: "无法连接" }], candidates: [
  { id: "candidate-a", providerId: "provider-a", providerName: "我的供应商", baseUrl: "https://example.test/v1", adapter: "openai-image", modelId: preset.modelId, name: preset.name, alreadyAdded: false, imageProfile: preset.profile, evidence: "catalog" },
  { id: "candidate-added", providerId: "provider-a", providerName: "我的供应商", baseUrl: "https://example.test/v1", adapter: "openai-image", modelId: "gpt-image-2.5-flare", name: "已添加模型", alreadyAdded: true, evidence: "catalog" },
] };

describe("image configuration UI", () => {
  it("reuses a provider without adding its image model to the conversation catalog", () => {
    const next = createImageDraftConfig(workspace);
    expect(next).toMatchObject({ adapter: "gemini-image", baseUrl: "https://images.example.test/v1beta", credentialProviderId: "google-api", modelId: "gemini-nano-banana-2.1", maxOutputs: 1 });
    expect(next.defaults).toMatchObject({ count: 1, size: "1K" });
    expect(next.allowTaskGeneration).toBe(true);
    expect(JSON.stringify(next)).not.toContain("apiKey");
    expect(workspace.capabilities).toEqual([]);

    const proxyWorkspace: CapabilitiesWorkspaceSnapshot = {
      ...workspace,
      imageSetup: {
        providers: [
          { id: "api-proxy", name: "My Proxy", api: "openai-completions", baseUrl: "https://proxy.example/v1", authType: "api_key", authenticated: true, imageSupported: true },
        ],
      },
    };
    const proxyDraft = createImageDraftConfig(proxyWorkspace);
    expect(proxyDraft).toMatchObject({ adapter: "openai-image", baseUrl: "https://proxy.example/v1", credentialProviderId: "api-proxy", modelId: "", name: "", allowTaskGeneration: true });
  });

  it("switches preset metadata together while retaining an explicitly reused endpoint", () => {
    const original = { ...draft, name: "产品图", baseUrl: "https://proxy.test/v1", customAdapter: { auth: { type: "none" as const }, generate: { path: "generate", body: {} }, response: { imagesPath: "data", urlPath: "url" } } };
    const next = applyImageModelPreset(original, "gemini-nano-banana-2.1", true);
    expect(next).toMatchObject({ name: "产品图", adapter: "gemini-image", baseUrl: "https://proxy.test/v1", modelId: "gemini-nano-banana-2.1" });
    expect(next.customAdapter).toBeUndefined();
    expect(next.defaults?.quality).toBeUndefined();
    expect(next.defaults?.size).toBe("1K");
    const unknown = applyImageModelPreset(next, "vendor-new-image-model", true);
    expect(unknown.imageProfile).toBeUndefined();
    expect(unknown.defaults).toEqual({});
  });

  it("keeps generation dimensions separate from rendering quality and gates format-specific controls", () => {
    const html = renderToStaticMarkup(<ImageCapabilityFields config={{ ...draft, defaults: { format: "gif", frameCount: 9, frameDurationMs: 200 } }} providers={workspace.imageSetup!.providers} apiKey="" onChange={vi.fn()} onApiKeyChange={vi.fn()} />);
    expect(html).toContain("图片尺寸");
    expect(html).toContain("渲染质量");
    expect(html).toContain("新增 API 连接");
    expect(html).toContain("订阅授权");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    const gemini = IMAGE_MODEL_PRESETS.find((item) => item.modelId === "gemini-2.5-flash-image")!;
    const legacy = renderToStaticMarkup(<ImageCapabilityFields config={{ name: gemini.name, adapter: gemini.adapter, baseUrl: gemini.baseUrl, modelId: gemini.modelId, imageProfile: gemini.profile, defaults: gemini.defaults }} providers={[]} apiKey="" onChange={vi.fn()} onApiKeyChange={vi.fn()} />);
    expect(legacy).not.toContain("图片尺寸");
    expect(legacy).not.toContain("渲染质量");
  });

  it("cleans format-specific parameters after transparency changes the output format", () => {
    expect(mergeImageGenerationParameters({ format: "gif", frameCount: 9, frameDurationMs: 200 }, { background: "transparent" })).toEqual({ format: "png", background: "transparent" });
    expect(mergeImageGenerationParameters({ format: "svg", svgModel: "svg-author", svgReasoning: "high", count: 1 }, { background: "transparent" })).toEqual({ format: "png", background: "transparent", count: 1 });
    expect(mergeImageGenerationParameters({ format: "jpeg", outputCompression: 80 }, { background: "transparent" })).toEqual({ format: "png", background: "transparent" });
  });

  it("lets an explicit output format replace an incompatible transparent background", () => {
    expect(mergeImageGenerationParameters({ format: "png", background: "transparent" }, { format: "gif" })).toEqual({ format: "gif", background: "auto" });
    expect(mergeImageGenerationParameters({ format: "png", background: "transparent", count: 4 }, { format: "svg" })).toEqual({ format: "svg", background: "auto", count: 1 });
    expect(mergeImageGenerationParameters({ format: "png", background: "transparent" }, { format: "webp" })).toEqual({ format: "webp", background: "transparent" });
  });

  it("preserves the existing image connection and revision when editing", () => {
    const capability = { id: "image-one", name: "图片", connectionId: "media-one", kind: "image" as const, modelId: preset.modelId, formats: preset.profile.formats, supportsEdit: true, enabled: true, isDefault: true, allowTaskGeneration: true, maxOutputs: 1, revision: 7, status: "ready" as const, createdAt: 1, updatedAt: 1, imageProfile: preset.profile, defaults: preset.defaults };
    const next = imageConfigFromCapability({ ...workspace, capabilities: [capability], connections: [{ id: "media-one", name: "共享服务", adapter: "openai-image", baseUrl: "https://example.test/v1", credentialProviderId: "api-key-provider", hasCredential: true, revision: 2 }] }, capability);
    expect(next).toMatchObject({ id: "image-one", expectedRevision: 7, credentialProviderId: "api-key-provider", baseUrl: "https://example.test/v1" });
    expect(next.defaults).toEqual(preset.defaults);
    const changed = { id: "stale-draft", clientId: "client-a", revision: 2, updatedAt: 2, config: { ...next, expectedRevision: 1, name: "过期草稿" } };
    const current = { ...workspace, capabilities: [capability], connections: [{ id: "media-one", name: "共享服务", adapter: "openai-image" as const, baseUrl: "https://example.test/v1", credentialProviderId: "api-key-provider", hasCredential: true, revision: 2 }] };
    expect(reloadImageDraftConfiguration(current, changed)).toMatchObject({ id: "image-one", name: "图片", expectedRevision: 7 });
    expect(reloadImageDraftConfiguration(current, { ...changed, config: { ...changed.config, expectedRevision: 7 } }).name).toBe("过期草稿");
  });

  it("does not render another window’s shared draft or discovered models", () => {
    const foreign = { ...workspace, imageSetup: { ...workspace.imageSetup!, draft: { id: "draft-one", clientId: "client-b", revision: 1, config: { ...draft, name: "其他窗口草稿" }, updatedAt: 1 }, discovery } };
    const props = { workspace: foreign, clientId: "client-c", connected: true, onChanged: vi.fn() };
    expect(renderToStaticMarkup(<ImageCapabilityEditor {...props} />)).toBe("");
    const picker = renderToStaticMarkup(<ImageProviderPicker {...props} />);
    expect(picker).not.toContain("我的供应商");
    expect(picker).not.toContain("已添加模型");
  });

  it("closes both clean editor instances when one saves or cancels the shared draft", () => {
    const initial = { id: "shared-draft", clientId: "client-a", revision: 1, config: draft, updatedAt: 1 };
    const liveWorkspace = { ...workspace, imageSetup: { ...workspace.imageSetup!, draft: initial } };
    const props = { clientId: "client-a", connected: true, onChanged: vi.fn(), initial };
    expect(renderToStaticMarkup(<><SharedImageCapabilityEditor {...props} workspace={liveWorkspace} /><SharedImageCapabilityEditor {...props} workspace={liveWorkspace} /></>).match(/保存模型/g)).toHaveLength(2);
    const clearedWorkspace = { ...workspace, revision: 2 };
    expect(renderToStaticMarkup(<><SharedImageCapabilityEditor {...props} workspace={clearedWorkspace} /><SharedImageCapabilityEditor {...props} workspace={clearedWorkspace} /></>)).toBe("");
  });

  it("only imports selected candidates that remain available in the discovery snapshot", () => {
    expect(selectableImageCandidateIds(discovery, ["candidate-a", "candidate-added", "candidate-a", "stale-candidate"])).toEqual(["candidate-a"]);
    const html = renderToStaticMarkup(<ImageProviderPicker workspace={{ ...workspace, imageSetup: { ...workspace.imageSetup!, discovery } }} clientId="client-a" connected onChanged={vi.fn()} />);
    expect(html).toContain("我的供应商");
    expect(html).toContain("已添加");
    expect(html).toContain("离线服务");
    expect(html).toContain("无法连接");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('aria-multiselectable="true"');
  });

  it("requires configuring unconfirmed image endpoints and opens the same protected draft", async () => {
    const candidate = { ...discovery.candidates[0]!, id: "needs-configuration", adapter: "custom-image" as const, name: "待确认的图片模型", needsConfiguration: true, configurationReason: "请确认图片接口协议", defaults: { format: "png" as const, count: 1 }, customAdapter: { auth: { type: "bearer" as const }, generate: { path: "images", body: { prompt: "{{prompt}}" } }, response: { imagesPath: "data", base64Path: "image" } } };
    const candidates = { ...discovery, candidates: [...discovery.candidates, candidate] };
    expect(selectableImageCandidateIds(candidates, [candidate.id, "candidate-a"])).toEqual(["candidate-a"]);
    const next = { ...workspace, imageSetup: { ...workspace.imageSetup!, discovery: candidates } };
    const html = renderToStaticMarkup(<ImageProviderPicker workspace={next} clientId="client-a" connected onChanged={vi.fn()} />);
    expect(html).toContain("需配置接口");
    expect(html).not.toContain("chip--tertiary");
    expect(html).toContain('aria-label="配置待确认的图片模型"');
    const draftResponse = { id: "configured-candidate-draft", clientId: "client-a", revision: 1, config: draft, updatedAt: 2 };
    const update = vi.spyOn(kuloRest, "updateImageDraft").mockResolvedValue(draftResponse);
    await expect(prepareImageCandidateDraft(next, "client-a", candidate)).resolves.toBe(draftResponse);
    expect(update).toHaveBeenCalledWith({ clientId: "client-a", config: expect.objectContaining({ adapter: "custom-image", modelId: candidate.modelId, credentialProviderId: candidate.providerId, baseUrl: candidate.baseUrl, defaults: candidate.defaults, customAdapter: candidate.customAdapter, allowTaskGeneration: true }) });
    await expect(prepareImageCandidateDraft({ ...next, imageSetup: { ...next.imageSetup, draft: draftResponse } }, "client-a", candidate)).rejects.toThrow("保存或取消当前图像草稿");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("preserves rule order and exposes automatic model selection preferences", () => {
    const rules = ["one", "two", "three"].map((id) => ({ id, name: id, capabilityId: "model", enabled: true }));
    expect(moveImageRoutingRule(rules, "two", -1).map((rule) => rule.id)).toEqual(["two", "one", "three"]);
    expect(moveImageRoutingRule(rules, "three", 1)).toBe(rules);
    const html = renderToStaticMarkup(<ImageRoutingEditor workspace={{ ...workspace, imageRouting: { mode: "auto", preference: "balanced", instructions: "", rules: [{ id: "r1", name: "矢量图", capabilityId: "image-one", enabled: false }] } }} clientId="client-a" connected onChanged={vi.fn()} />);
    expect(html).toContain("由 Kulo 自动判断");
    expect(html).toContain("选择偏好");
    expect(html).toContain("添加规则");
    expect(html).toContain("kulo-settings-table-actions");
    expect(html).toContain("kulo-settings-table-action-group");
  });

  it("keeps the left workspace limited to the model table and its original add action", () => {
    const jobs = [{ id: "test-job", operationId: "test-operation", capabilityId: "image-one", capabilityRevision: 1, connectionId: "service-one", adapter: "openai-image" as const, modelId: preset.modelId, kind: "image" as const, prompt: "A leaf", inputAssetIds: [], format: "png" as const, count: 1, source: { conversationId: 0, topicId: "setup", setupClientId: "client-a" }, status: "completed" as const, assets: [], createdAt: 10, updatedAt: 10 }];
    const current = { ...workspace, jobs, imageSetup: { ...workspace.imageSetup!, discovery, draft: { id: "draft-one", clientId: "client-a", revision: 1, config: draft, updatedAt: 1 } } };
    const html = renderToStaticMarkup(<ImageCapabilitiesPanel workspace={current} clientId="client-a" connected loading={false} error={null} onRequest={vi.fn()} onRefresh={vi.fn()} />);
    expect(html).toContain("添加图像模型");
    expect(html).toContain('aria-label="图像模型列表"');
    for (const text of ["让 Kulo 配置", "从已有供应商添加", "调用规则", "继续配置草稿", "草稿已同步", "选择图像模型", "图像测试结果", "生成完成"]) expect(html).not.toContain(text);
    expect(html).not.toMatch(/<(input|textarea|form)\b/);
  });
});
