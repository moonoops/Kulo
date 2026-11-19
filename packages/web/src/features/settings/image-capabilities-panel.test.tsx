import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Button } from "@heroui/react";
import { IMAGE_MODEL_PRESETS, type CapabilitiesWorkspaceSnapshot } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { ImageCapabilitiesPanel } from "./image-capabilities-panel";
import { ADD_IMAGE_PROMPT } from "./capability-views";

const buttonPresses = vi.hoisted(() => new Map<string, (() => void) | undefined>());
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  return { ...actual, Button: (props: ComponentProps<typeof Button>) => {
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
});
