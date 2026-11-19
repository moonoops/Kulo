import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type CapabilitiesWorkspaceSnapshot, type MediaJob, type MocoSettingsView } from "@moco/protocol";
import { EMPTY_SETTINGS_ASSISTANT, mocoRest } from "../../moco-api";
import { SettingsAssistantPanel } from "./settings-assistant-panel";
import type { ImageAssistantRequest } from "./capability-views";
import type { SettingsAssistantControls } from "./use-settings-assistant";
import type { ImageConfigurationCardProps } from "./image-provider-picker";

const cards = vi.hoisted(() => new Map<string, ImageConfigurationCardProps>());
const press = vi.hoisted(() => new Map<string, () => unknown>());
const imageEffects = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: Parameters<typeof actual.useEffect>[0], deps: Parameters<typeof actual.useEffect>[1]) => {
    if (effect.name === "consumeImageRequest") imageEffects.push(effect);
    return actual.useEffect(effect, deps);
  } };
});
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  return { ...actual, Button: (props: ComponentProps<typeof actual.Button>) => {
    if (typeof props.children === "string" && props.onPress) press.set(props.children, props.onPress as () => unknown);
    return createElement(actual.Button, props);
  } };
});
vi.mock("./image-provider-picker", () => ({
  ImageProviderPicker: (props: ImageConfigurationCardProps) => {
    cards.set("discovery", props);
    return <div data-image-discovery={props.workspace.imageSetup?.discovery?.id}>共享模型勾选卡片</div>;
  },
}));
vi.mock("./image-capability-editor", () => ({
  createImageDraftConfig: () => ({ name: "GPT Image", adapter: "openai-image", modelId: "gpt-image-2.6-flare" }),
  imageConfigFromCapability: (_workspace: CapabilitiesWorkspaceSnapshot, capability: { id: string; name: string; modelId: string }) => ({ id: capability.id, name: capability.name, adapter: "openai-image", modelId: capability.modelId }),
  ImageCapabilityEditor: (props: ImageConfigurationCardProps) => {
    cards.set("draft", props);
    return <div data-image-draft={props.workspace.imageSetup?.draft?.id}>共享图像配置表单</div>;
  },
}));
vi.mock("./image-routing-editor", () => ({ ImageRoutingEditor: () => <div>共享调用规则</div> }));

const settings: MocoSettingsView = {
  globalRevision: 1,
  blocks: {
    presentation: { revision: 1, value: { agentName: "Moco", workbenchName: "工作台" } },
    executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
    roles: { revision: 1, value: defaultRolePresets() },
    model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "off", customProviders: [] } },
    identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
    memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "private", shared: "shared" } } },
  },
  history: [],
};
const workspace: CapabilitiesWorkspaceSnapshot = {
  revision: 1, skillRevision: 1, capabilities: [], connections: [], skills: [], jobs: [], inputs: [],
  imageSetup: { providers: [], discovery: { id: "discovery-1", clientId: "tab-a", status: "ready", candidates: [], errors: [], createdAt: 10 } },
};
function controls(): SettingsAssistantControls {
  return {
    draft: "保留对话草稿", setDraft: vi.fn(), clientId: "tab-a", appearance: "dark",
    attachments: [], enqueueFiles: vi.fn(), removeAttachment: vi.fn(), retryAttachment: vi.fn(), cancelAttachment: vi.fn(), restoreInput: vi.fn(),
    sending: false, switchingConversation: false, pendingActionId: null, unconfirmedSend: false, localAppearance: null,
    send: vi.fn(async () => {}), retrySend: vi.fn(async () => {}), subscribe: vi.fn(async () => {}),
    abort: vi.fn(async () => {}), createConversation: vi.fn(async () => true), selectConversation: vi.fn(async () => true), deleteConversation: vi.fn(async () => true), decide: vi.fn(async () => true),
    navigate: vi.fn(async () => {}), changeAppearance: vi.fn(), undoLocalAppearance: vi.fn(),
  };
}
const render = (value = workspace, controller = controls(), capabilityView: "image" | "video" = "image", onChanged = vi.fn(), options: { connected?: boolean; busy?: boolean; active?: boolean; workspaceLoaded?: boolean; imageRequest?: ImageAssistantRequest; onImageRequestHandled?: (id: ImageAssistantRequest["id"]) => void } = {}) => renderToStaticMarkup(<SettingsAssistantPanel
  module="capabilities" agentName="Moco" settings={settings} envs={[]}
  snapshot={{ ...EMPTY_SETTINGS_ASSISTANT, live: { ...EMPTY_SETTINGS_ASSISTANT.live, busy: options.busy ?? false }, messages: options.active ? [{ id: 1, role: "user" as const, text: "保留此前的配置请求" }] : [] }}
  loaded connected={options.connected ?? true} error={null} controls={controller} capabilitiesWorkspace={options.workspaceLoaded === false ? null : value} capabilityView={capabilityView} onCapabilityInputsChanged={onChanged}
  imageRequest={options.imageRequest} onImageRequestHandled={options.onImageRequestHandled}
/>);

beforeEach(() => { cards.clear(); press.clear(); imageEffects.length = 0; vi.restoreAllMocks(); });

describe("image request consumption across settings layouts", () => {
  it("acknowledges before preparing and does not replay after the panel remounts", async () => {
    let pending: ImageAssistantRequest | undefined = { id: 12, action: "configure" };
    const calls: string[] = [];
    const update = vi.spyOn(mocoRest, "updateImageDraft").mockImplementation(async ({ clientId, config }) => {
      calls.push("prepare");
      return { id: "draft-from-left", clientId, config, revision: 1, updatedAt: 20 };
    });
    const onHandled = vi.fn((id: ImageAssistantRequest["id"]) => {
      calls.push("handled");
      if (pending?.id === id) pending = undefined;
    });
    const onChanged = vi.fn();
    render({ ...workspace, imageSetup: { providers: [] } }, controls(), "image", onChanged, { imageRequest: pending, onImageRequestHandled: onHandled });
    const consume = imageEffects.pop()!;
    consume(); consume();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(calls).toEqual(["handled", "prepare"]);
    expect(onHandled).toHaveBeenCalledWith(12);
    render({ ...workspace, imageSetup: { providers: [] } }, controls(), "image", vi.fn(), { imageRequest: pending, onImageRequestHandled: onHandled });
    imageEffects.pop()!();
    expect(update).toHaveBeenCalledOnce();
    expect(onHandled).toHaveBeenCalledOnce();
  });

  it("preserves a pending request while disconnected, busy or awaiting the workspace", async () => {
    const request: ImageAssistantRequest = { id: 13, action: "discover" };
    const onHandled = vi.fn(); const onChanged = vi.fn();
    const search = vi.spyOn(mocoRest, "discoverImageModels").mockResolvedValue(workspace.imageSetup!.discovery!);
    for (const state of [{ connected: false }, { busy: true }, { workspaceLoaded: false }]) {
      render(workspace, controls(), "image", onChanged, { ...state, imageRequest: request, onImageRequestHandled: onHandled });
      imageEffects.pop()!();
      expect(onHandled).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    }
    render(workspace, controls(), "image", onChanged, { imageRequest: request, onImageRequestHandled: onHandled });
    const consume = imageEffects.pop()!;
    consume(); consume();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onHandled).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
  });
});

describe("image configuration in the settings conversation", () => {
  it("keeps the image configuration entries in the right conversation even before chatting", () => {
    const html = render();
    expect(html).toContain('data-image-discovery="discovery-1"');
    expect(html).toContain('aria-label="图像配置"');
    for (const label of ["从已有供应商添加", "添加图像模型", "调用规则"]) expect(html).toContain(label);
    expect(render(workspace, { ...controls(), clientId: "tab-b" })).not.toContain("共享模型勾选卡片");
    expect(render(workspace, controls(), "video")).not.toContain("共享模型勾选卡片");
  });

  it("offers all three entries without a prior discovery, draft or configured conversation model", () => {
    const html = render({ ...workspace, imageSetup: { providers: [] } });
    for (const label of ["从已有供应商添加", "添加图像模型", "调用规则"]) {
      expect(html).toContain(`>${label}</button>`);
      expect(press.has(label)).toBe(true);
    }
    expect(html).not.toContain("共享模型勾选卡片");
    expect(html).not.toContain("共享图像配置表单");
  });

  it("opens discovery from the right entry without sending a model request or consuming the draft", async () => {
    const search = vi.spyOn(mocoRest, "discoverImageModels").mockResolvedValue(workspace.imageSetup!.discovery!);
    const onChanged = vi.fn(); const controller = controls();
    render({ ...workspace, imageSetup: { providers: [] } }, controller, "image", onChanged);
    press.get("从已有供应商添加")!();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(search).toHaveBeenCalledWith("tab-a");
    expect(controller.send).not.toHaveBeenCalled();
    expect(controller.setDraft).not.toHaveBeenCalled();
  });

  it("opens the shared editor from the right entry using the configuration service", async () => {
    const update = vi.spyOn(mocoRest, "updateImageDraft").mockResolvedValue({
      id: "draft-new", clientId: "tab-a", revision: 1, config: { name: "GPT Image", adapter: "openai-image", modelId: "gpt-image-2.6-flare" }, updatedAt: 20,
    });
    const onChanged = vi.fn(); const controller = controls();
    render({ ...workspace, imageSetup: { providers: [] } }, controller, "image", onChanged);
    press.get("添加图像模型")!();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith({ clientId: "tab-a", config: { name: "GPT Image", adapter: "openai-image", modelId: "gpt-image-2.6-flare" } });
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("does not begin provider discovery during disconnected or unfinished operations", () => {
    const search = vi.spyOn(mocoRest, "discoverImageModels");
    for (const state of [
      { connected: false }, { busy: true },
      { controller: { ...controls(), sending: true } },
      { controller: { ...controls(), switchingConversation: true } },
      { controller: { ...controls(), unconfirmedSend: true } },
    ]) {
      render({ ...workspace, imageSetup: { providers: [] } }, "controller" in state ? state.controller : controls(), "image", vi.fn(), state);
      press.get("从已有供应商添加")!();
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("shows a shared draft produced after discovery and preserves its identity", () => {
    const next = { ...workspace, imageSetup: { ...workspace.imageSetup!, draft: {
      id: "draft-1", clientId: "tab-a", revision: 4, config: { name: "Banana", adapter: "gemini-image" as const, modelId: "gemini-nano-banana-2.1" }, updatedAt: 20,
    } } };
    const html = render(next);
    expect(html).toContain('data-image-draft="draft-1"');
    expect(html).not.toContain("共享模型勾选卡片");
    expect(render(next, { ...controls(), clientId: "tab-b" })).not.toContain("共享图像配置表单");
  });

  it("shows a newer discovery instead of silently overwriting it with an older draft", () => {
    const next = { ...workspace, imageSetup: { ...workspace.imageSetup!, draft: {
      id: "older-draft", clientId: "tab-a", revision: 4, config: { name: "Banana", adapter: "gemini-image" as const, modelId: "gemini-nano-banana-2.1" }, updatedAt: 5,
    } } };
    const original = structuredClone(next);
    const html = render(next);
    expect(html).toContain('data-image-discovery="discovery-1"');
    expect(html).not.toContain("共享图像配置表单");
    expect(next).toEqual(original);
  });

  it("preserves a shared draft and conversation input without resubmitting it", () => {
    const next = { ...workspace, imageSetup: { providers: [], draft: {
      id: "draft-1", clientId: "tab-a", revision: 4, config: { name: "Banana", adapter: "gemini-image" as const, modelId: "gemini-nano-banana-2.1" }, updatedAt: 20,
    } } };
    const update = vi.spyOn(mocoRest, "updateImageDraft"); const onChanged = vi.fn(); const controller = controls();
    const html = render(next, controller, "image", onChanged);
    expect(html).toContain('data-image-draft="draft-1"');
    expect(html).toContain("保留对话草稿</textarea>");
    expect(cards.get("draft")?.workspace.imageSetup?.draft).toBe(next.imageSetup.draft);
    expect(update).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    expect(controller.setDraft).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not let another client's newer draft replace this client's discovery", () => {
    const next = { ...workspace, imageSetup: { ...workspace.imageSetup!, draft: {
      id: "foreign-draft", clientId: "tab-b", revision: 4, config: { name: "其他窗口", adapter: "gemini-image" as const, modelId: "gemini-nano-banana-2.1" }, updatedAt: 100,
    } } };
    expect(render(next)).toContain('data-image-discovery="discovery-1"');
    expect(render(next)).not.toContain("共享图像配置表单");
  });

  it("passes unavailable-operation states into an already opened shared card", () => {
    for (const state of [
      { connected: false }, { busy: true },
      { controller: { ...controls(), sending: true } },
      { controller: { ...controls(), switchingConversation: true } },
      { controller: { ...controls(), unconfirmedSend: true } },
    ]) {
      render(workspace, "controller" in state ? state.controller : controls(), "image", vi.fn(), state);
      expect(cards.get("discovery")?.disabled).toBe(true);
      expect(cards.get("discovery")?.clientId).toBe("tab-a");
    }
  });

  it("keeps a shared card inside the active conversation log while preserving previous messages", () => {
    const html = render(workspace, controls(), "image", vi.fn(), { active: true });
    expect(html).toContain("保留此前的配置请求");
    expect(html).not.toContain("moco-settings-assistant-intro");
    const card = html.indexOf('data-image-discovery="discovery-1"');
    expect(card).toBeGreaterThan(html.indexOf('role="log"'));
    expect(card).toBeLessThan(html.indexOf('class="moco-settings-assistant-footer'));
    expect(html).toContain('aria-label="图像配置"');
  });

  it("shows only this window's latest test image inside the right conversation", () => {
    const job = (id: string, setupClientId: string | undefined, createdAt: number): MediaJob => ({
      id, operationId: id, capabilityId: "image-capability", capabilityRevision: 1, connectionId: "image-connection", adapter: "openai-image",
      modelId: "gpt-image-2.6-flare", kind: "image", prompt: "test", inputAssetIds: [], format: "png", count: 1,
      source: { conversationId: 1, topicId: "settings-topic", setupClientId }, status: "completed", assets: [{ id: `${id}-asset`, kind: "image", mimeType: "image/png", name: `${id}.png`, size: 100, url: `/api/uploads/${id}-asset` }],
      createdAt, updatedAt: createdAt,
    });
    const next = { ...workspace, jobs: [job("my-older-test", "tab-a", 10), job("my-current-test", "tab-a", 20), job("other-window-test", "tab-b", 30), job("ordinary-chat-image", undefined, 40)] };
    const html = render(next);
    expect(html).toContain('aria-label="图像测试结果"');
    expect(html).toContain("my-current-test.png");
    for (const hidden of ["my-older-test.png", "other-window-test.png", "ordinary-chat-image.png"]) expect(html).not.toContain(hidden);
    expect(html.indexOf('aria-label="图像测试结果"')).toBeGreaterThan(html.indexOf('role="log"'));
    expect(render(next, controls(), "video")).not.toContain('aria-label="图像测试结果"');
  });
});
