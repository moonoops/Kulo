import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesWorkspaceSnapshot, CapabilityRecord, EnvNodeDescriptor, SetupInputRequest, SkillRecord } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { CapabilitiesModule, capabilityStatusLabel, skillStatusLabel } from "./capabilities-module";
import { CapabilitySetupInputs, safeSetupInputError, submitSetupInput, visibleSetupInputs } from "./capability-setup-inputs";
import { capabilityTargetView, type CapabilityView } from "./capability-views";

const capability: CapabilityRecord = {
  id: "image-a", name: "产品图片", connectionId: "connection-a", kind: "image", modelId: "gpt-image-2.6-flare",
  formats: ["png", "gif"], supportsEdit: true, enabled: true, isDefault: true, allowTaskGeneration: true,
  maxOutputs: 2, revision: 1, status: "unverified", createdAt: 1, updatedAt: 1,
};
const skill: SkillRecord = {
  id: "builtin:image-generation", name: "image-generation", description: "图片生成与编辑", source: "builtin",
  version: "v1", enabled: true, audiences: ["chat", "worker"], dependencies: [], diagnostics: [], createdAt: 1, updatedAt: 1,
};
const snapshot: CapabilitiesWorkspaceSnapshot = {
  revision: 1, capabilities: [capability],
  connections: [{ id: "connection-a", name: "图片服务", adapter: "openai-image", baseUrl: "https://example.test/v1", origin: "https://example.test", hasCredential: true, revision: 1 }],
  skills: [skill], skillRevision: 1, jobs: [], inputs: [],
};
const secretRequest: SetupInputRequest = {
  id: "input-one", kind: "secret", label: "保存图片服务密钥", clientId: "tab-a", capabilityId: capability.id,
  expectedRevision: 1, status: "pending", createdAt: 1, expiresAt: Date.now() + 60_000,
};
const device: EnvNodeDescriptor = {
  id: "mac-one", name: "书房 Mac", kind: "reverse-ws", platform: "darwin", arch: "arm64", online: true,
  rootDir: "/workspace", capabilities: ["flow-browser"], connectedAt: 1, lastSeenAt: 1,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderWorkspace(next = snapshot, target?: { kind: "capability" | "skill"; id: string }, view?: CapabilityView) {
  return renderToStaticMarkup(<CapabilitiesModule snapshot={next} connected loading={false} error={null} envs={[device]} target={target} view={view} onRequest={vi.fn()} onRefresh={vi.fn()} />);
}

describe("capability workspace", () => {
  it("shows saved capability state without a second configuration form", () => {
    const html = renderWorkspace();
    expect(html).toContain("产品图片");
    expect(html).toContain("可用");
    expect(html).not.toContain("待验证");
    expect(html).toContain("GIF");
    expect(html).toContain("默认");
    expect(html).toContain('aria-label="管理产品图片"');
    expect(html).not.toMatch(/<(input|select|form)\b/);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("API Key");
    expect(html).toMatch(/<table\b(?=[^>]*role="grid")(?=[^>]*aria-label="图像模型列表")/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(5);
    expect(html).toContain("服务连接");
    expect(html).not.toContain('aria-label="编辑产品图片"');
    expect(html).toContain('role="rowheader"');
    expect(html).not.toContain('aria-multiselectable="true"');
  });

  it("keeps stable selected-target identity and separates capability state from the skill", () => {
    const html = renderWorkspace({ ...snapshot, capabilities: [{ ...capability, enabled: false, status: "ready" }] }, { kind: "capability", id: capability.id });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("已停用");
    expect(capabilityStatusLabel(capability)).toBe("可用");
    expect(capabilityStatusLabel({ ...capability, kind: "video", formats: ["mp4"] })).toBe("待验证");
    expect(skillStatusLabel(skill)).toBe("已启用");
    expect(skillStatusLabel({ ...skill, enabled: false })).toBe("已停用");
    expect(skillStatusLabel({ ...skill, diagnostics: ["缺少依赖"] })).toBe("需处理");
  });

  it("renders a selected skill without asking the user to configure the image model again", () => {
    const html = renderWorkspace(snapshot, { kind: "skill", id: skill.id });
    expect(html).toContain('aria-label="编辑image-generation"');
    expect(html).toContain('aria-label="删除image-generation"');
    expect(html).toContain("图片生成与编辑");
    expect(html).toContain("内置");
    expect(html).toContain("导入技能");
    expect(html).not.toContain("输入密钥");
    expect(html).toMatch(/<table\b(?=[^>]*role="grid")(?=[^>]*aria-label="技能列表")/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(5);
    expect(html).toContain('role="rowheader"');
    expect(html).not.toContain('aria-multiselectable="true"');
  });

  it("requires generation authorization while preserving actionable connection problems", () => {
    const pending = { ...capability, allowTaskGeneration: false };
    expect(renderWorkspace({ ...snapshot, capabilities: [pending] })).toContain("待授权");
    expect(capabilityStatusLabel({ ...pending, status: "ready" })).toBe("待授权");
    expect(capabilityStatusLabel({ ...pending, status: "needs_auth" })).toBe("待连接");
    expect(capabilityStatusLabel({ ...pending, status: "offline" })).toBe("设备离线");
    expect(capabilityStatusLabel({ ...pending, status: "error" })).toBe("连接异常");
    expect(capabilityStatusLabel({ ...pending, enabled: false })).toBe("已停用");
  });

  it("identifies Flow as membership usage on the browser device", () => {
    const html = renderWorkspace({ ...snapshot,
      capabilities: [{ ...capability, name: "Flow 视频", kind: "video", formats: ["mp4"], modelId: "veo", status: "needs_auth" }],
      connections: [{ id: "connection-a", name: "Flow", adapter: "flow-browser", browserEnvId: device.id, profileRef: "flow-one", hasCredential: false, revision: 1 }],
    }, undefined, "video");
    expect(html).toContain("Google Flow · 会员网页");
    expect(html).toContain("书房 Mac");
    expect(html).toContain('aria-label="视频连接列表"');
    expect(html).toContain("待连接");
    expect(html).not.toContain("API Key");
  });

  it("distinguishes an unloaded snapshot, empty data, and a recoverable error", () => {
    const waiting = renderToStaticMarkup(<CapabilitiesModule snapshot={null} connected loading error={null} envs={[]} onRequest={vi.fn()} onRefresh={vi.fn()} />);
    expect(waiting).toContain("加载中");
    expect(waiting).not.toContain("尚未添加图像模型");
    expect(waiting).not.toContain('data-slot="spinner"');
    expect(renderWorkspace({ ...snapshot, capabilities: [] })).toContain("尚未添加图像模型");
    const failed = renderToStaticMarkup(<CapabilitiesModule snapshot={snapshot} connected loading={false} error="连接暂时失败" envs={[]} onRequest={vi.fn()} onRefresh={vi.fn()} />);
    expect(failed).toContain("连接暂时失败");
    expect(failed).toContain("重试");
    expect(failed).toContain("产品图片");
  });

  it("orders the seven tabs and keeps Colab as a placeholder", () => {
    const html = renderWorkspace(snapshot, undefined, "colab");
    const positions = ["图像", "语音", "视频", "搜索", "技能", "Colab", "其他"].map((label) => html.indexOf(`>${label}<`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("Colab CLI");
    expect(html).toContain("暂未开放");
    expect(html).not.toContain("添加图像模型");
    expect(html).not.toContain("连接 Google Flow");
  });

  it("separates image and video records and routes a selected video to its panel", () => {
    const video: CapabilityRecord = { ...capability, id: "video-a", name: "Flow 视频", kind: "video", formats: ["mp4"] };
    const mixed = { ...snapshot, capabilities: [capability, video] };
    const imageHtml = renderWorkspace(mixed);
    expect(imageHtml).toContain("产品图片");
    expect(imageHtml).not.toContain("Flow 视频");
    const videoHtml = renderWorkspace(mixed, { kind: "capability", id: video.id });
    expect(videoHtml).toContain("Flow 视频");
    expect(videoHtml).not.toContain("产品图片");
    expect(videoHtml).toContain('aria-pressed="true"');
    expect(capabilityTargetView({ kind: "capability", id: video.id }, mixed)).toBe("video");
    expect(capabilityTargetView({ kind: "capability", id: video.id }, null)).toBeUndefined();
  });

  it("keeps cached records visible while refreshing and when disconnected", () => {
    const refreshing = renderToStaticMarkup(<CapabilitiesModule snapshot={snapshot} connected loading error={null} envs={[]} onRequest={vi.fn()} onRefresh={vi.fn()} />);
    expect(refreshing).toContain("产品图片");
    expect(refreshing).not.toContain("加载中");
    const offline = renderToStaticMarkup(<CapabilitiesModule snapshot={snapshot} connected={false} loading={false} error={null} envs={[]} onRequest={vi.fn()} onRefresh={vi.fn()} />);
    expect(offline).toContain("产品图片");
    expect(offline).toMatch(/<button\b(?=[^>]*aria-label="管理产品图片")(?=[^>]*disabled)/);
  });
});

describe("dedicated capability inputs", () => {
  it("only exposes pending inputs belonging to this client and selected capability", () => {
    const another = { ...secretRequest, id: "input-two", clientId: "tab-b" };
    const completed = { ...secretRequest, id: "input-three", status: "completed" as const };
    expect(visibleSetupInputs([secretRequest, another, completed], "tab-a")).toEqual([secretRequest]);
    expect(visibleSetupInputs([secretRequest], "tab-a", { kind: "capability", id: "other" })).toEqual([]);
    expect(visibleSetupInputs([secretRequest], "tab-a", { kind: "skill", id: skill.id })).toEqual([]);
    const html = renderToStaticMarkup(<CapabilitySetupInputs inputs={[secretRequest, another]} clientId="tab-a" connected envs={[]} onChanged={vi.fn()} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("保存密钥");
    expect(html).not.toContain("textarea");
  });

  it("submits a secret solely through the credential endpoint without touching draft storage", async () => {
    const store = vi.fn();
    vi.stubGlobal("localStorage", { setItem: store });
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetcher);
    await submitSetupInput(secretRequest, "tab-a", "sample-credential");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/capabilities/inputs/input-one");
    expect(JSON.parse(String(request.body))).toEqual({ clientId: "tab-a", secret: "sample-credential" });
    expect(store).not.toHaveBeenCalled();
    expect(url).not.toContain("sample-credential");
  });

  it("rejects stale or foreign inputs before any submission", async () => {
    const submit = vi.spyOn(kuloRest, "submitCapabilityInput").mockResolvedValue(undefined);
    await expect(submitSetupInput(secretRequest, "tab-b", "sample-credential")).rejects.toThrow("发起配置的窗口");
    await expect(submitSetupInput({ ...secretRequest, expiresAt: 0 }, "tab-a", "sample-credential")).rejects.toThrow("过期");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps browser handoff and cancellation separate from secret submission", async () => {
    const complete = vi.spyOn(kuloRest, "completeCapabilityBrowserInput").mockResolvedValue(undefined);
    const submit = vi.spyOn(kuloRest, "submitCapabilityInput").mockResolvedValue(undefined);
    const browser = { ...secretRequest, kind: "browser" as const, envId: device.id, label: "登录 Flow" };
    await submitSetupInput(browser, "tab-a", "");
    expect(complete).toHaveBeenCalledWith(browser.id, "tab-a");
    expect(submit).not.toHaveBeenCalled();
    await submitSetupInput(secretRequest, "tab-a", "sample-credential", true);
    expect(submit).toHaveBeenCalledWith(secretRequest.id, { clientId: "tab-a", cancel: true });
    const html = renderToStaticMarkup(<CapabilitySetupInputs inputs={[browser]} clientId="tab-a" connected envs={[device]} onChanged={vi.fn()} />);
    expect(html).toContain("书房 Mac");
    expect(html).toContain("已连接");
    expect(html).not.toContain('type="password"');
  });

  it("never echoes the submitted value even if a remote error includes it", () => {
    expect(safeSetupInputError(new Error("Rejected sample-credential"), "sample-credential")).toBe("Rejected [已隐藏]");
    expect(safeSetupInputError(new Error("Rejected sample-credential"), " sample-credential ")).toBe("Rejected [已隐藏]");
  });
});
