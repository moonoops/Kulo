import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Button } from "@heroui/react";
import { DEFAULT_IMAGE_TEST_PROMPT, IMAGE_MODEL_PRESETS, type CapabilitiesWorkspaceSnapshot, type MediaJob } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { ImageCapabilitiesPanel, ImageTestModal } from "./image-capabilities-panel";
import { ADD_IMAGE_PROMPT, IMAGE_ROUTING_PROMPT } from "./capability-views";

const buttonPresses = vi.hoisted(() => new Map<string, (() => void) | undefined>());
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const ModalRoot = ({ isOpen, children }: { isOpen?: boolean; children?: ReactNode }) => (isOpen ? <div data-modal-open="true">{children}</div> : null);
  const ModalPart = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const ModalMock = Object.assign(ModalRoot, {
    Backdrop: ModalRoot,
    Container: ModalPart,
    Dialog: ({ children, ...rest }: { children?: ReactNode; "aria-label"?: string }) => <div role="dialog" aria-label={rest["aria-label"]}>{children}</div>,
    Header: ModalPart,
    Heading: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    CloseTrigger: () => null,
    Body: ModalPart,
    Footer: ModalPart,
  });
  return { ...actual, Modal: ModalMock, Button: (props: ComponentProps<typeof Button>) => {
    const name = props["aria-label"] ?? (typeof props.children === "string" ? props.children : undefined);
    if (name) buttonPresses.set(name, props.onPress ? () => props.onPress!({} as Parameters<NonNullable<typeof props.onPress>>[0]) : undefined);
    return <actual.Button {...props} />;
  } };
});

const preset = IMAGE_MODEL_PRESETS.find((model) => model.modelId === "gpt-image-2.6-flare")!;
const workspace: CapabilitiesWorkspaceSnapshot = {
  revision: 1, skills: [], skillRevision: 1, jobs: [], inputs: [],
  capabilities: [{ id: "image-one", name: "产品图", connectionId: "images", kind: "image", modelId: preset.modelId, formats: ["png"], supportsEdit: true, enabled: true, isDefault: true, allowTaskGeneration: false, maxOutputs: 1, revision: 1, status: "unverified", createdAt: 1, updatedAt: 1 }],
  connections: [{ id: "images", name: "图片服务", adapter: "openai-image", hasCredential: true, revision: 1 }],
};

beforeEach(() => { buttonPresses.clear(); vi.restoreAllMocks(); });

describe("left image workspace handoff", () => {
  it("hands the original add action to the right conversation without creating a draft itself", () => {
    const onRequest = vi.fn();
    const updateDraft = vi.spyOn(mocoRest, "updateImageDraft");
    renderToStaticMarkup(<ImageCapabilitiesPanel workspace={workspace} clientId="client-one" connected loading={false} error={null} onRequest={onRequest} onRefresh={vi.fn()} />);
    expect(buttonPresses.get("添加图像模型")).toBeTypeOf("function");
    buttonPresses.get("添加图像模型")!();
    expect(onRequest).toHaveBeenCalledWith(undefined, ADD_IMAGE_PROMPT);
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it("provides one selected manage action that hands the stable target to the right", () => {
    const onRequest = vi.fn();
    const updateDraft = vi.spyOn(mocoRest, "updateImageDraft");
    const html = renderToStaticMarkup(<ImageCapabilitiesPanel workspace={workspace} clientId="client-one" target={{ kind: "capability", id: "image-one" }} connected loading={false} error={null} onRequest={onRequest} onRefresh={vi.fn()} />);
    expect(buttonPresses.has("编辑产品图")).toBe(false);
    expect(html).toMatch(/<button\b(?=[^>]*aria-label="管理产品图")(?=[^>]*aria-pressed="true")/);
    buttonPresses.get("管理产品图")!();
    expect(onRequest.mock.calls).toEqual([[{ kind: "capability", id: "image-one" }]]);
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it("omits redundant verification statuses and surfaces multi-model routing controls on the left", () => {
    const onRequest = vi.fn();
    const multi: CapabilitiesWorkspaceSnapshot = {
      ...workspace,
      capabilities: [
        { ...workspace.capabilities[0]!, allowTaskGeneration: true, status: "unverified", lastGeneratedAt: undefined },
        { ...workspace.capabilities[0]!, id: "image-two", name: "海报图", isDefault: false, allowTaskGeneration: true, status: "ready", lastGeneratedAt: 100 },
      ],
    };
    const html = renderToStaticMarkup(<ImageCapabilitiesPanel workspace={multi} clientId="client-one" connected loading={false} error={null} onRequest={onRequest} onRefresh={vi.fn()} />);
    expect(html).toContain("可用");
    for (const removed of ["待验证", "连接已验证", "生图已验证", "测试连接"]) expect(html).not.toContain(removed);
    expect(html).toContain("调用规则");
    expect(html).toContain("按任务自动选择图像模型");
    expect(buttonPresses.get("修改规则")).toBeTypeOf("function");
    buttonPresses.get("修改规则")!();
    expect(onRequest).toHaveBeenCalledWith(undefined, IMAGE_ROUTING_PROMPT);
  });

  it("renders the image test modal with the cat ice-cream default prompt and live result preview", () => {
    const job: MediaJob = {
      id: "job-1", operationId: "op-1", capabilityId: "image-one", capabilityRevision: 1, connectionId: "images", adapter: "openai-image",
      modelId: preset.modelId, kind: "image", prompt: DEFAULT_IMAGE_TEST_PROMPT, inputAssetIds: [], format: "png", count: 1,
      source: { conversationId: 0, topicId: "root", setupClientId: "client-one" }, status: "completed",
      assets: [{ id: "asset-1", kind: "image", mimeType: "image/png", name: "cat-cone.png", size: 120, url: "/api/uploads/asset-1" }],
      createdAt: 10, updatedAt: 20,
    };
    const html = renderToStaticMarkup(<ImageTestModal
      capability={workspace.capabilities[0]}
      prompt={DEFAULT_IMAGE_TEST_PROMPT}
      onPromptChange={vi.fn()}
      job={job}
      submitting={false}
      disabled={false}
      onSubmit={vi.fn()}
      onClose={vi.fn()}
      onPreviewImage={vi.fn()}
    />);
    expect(html).toContain("试生成 · 产品图");
    expect(html).toContain("画一只正在吃甜筒的猫");
    expect(html).toContain("生成完成");
    expect(html).toContain("cat-cone.png");
    expect(html).toContain("重新生成");
  });
});
