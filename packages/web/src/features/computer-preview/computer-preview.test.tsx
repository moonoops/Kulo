import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComputerPreviewPanel } from "./computer-preview";
import { EMPTY_PREVIEW_STATE, type ComputerPreviewState } from "./preview-client";

const state: ComputerPreviewState = {
  ...EMPTY_PREVIEW_STATE, connection: "connected", selectedId: "desktop-1",
  sessions: [{ id: "desktop-1", ticketId: "ticket-1", tool: "desktop", envId: "local", deviceName: "Mac", title: "更新文档", app: "TextEdit" }],
  displays: { "desktop-1": { state: "live", imageUrl: "blob:preview", capturedAt: 1 } },
};
const client = { setCollapsed: vi.fn(), setExpanded: vi.fn(), select: vi.fn(), stopTask: vi.fn(), retry: vi.fn(), frameFailed: vi.fn() };
const render = (value: ComputerPreviewState) => renderToStaticMarkup(<ComputerPreviewPanel state={value} client={client} connected onStop={async () => {}} />);

describe("operation preview accessibility", () => {
  it("uses a non-modal preview with persistent, named controls and no frame announcements", () => {
    const html = render(state);
    expect(html).toContain('aria-label="设备操作预览"');
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).toContain('aria-label="放大操作预览"');
    expect(html).toContain('aria-label="收起操作预览"');
    expect(html).toContain('alt="应用窗口截图"');
    expect(html).not.toMatch(/role="dialog"|aria-modal|autofocus|aria-live/);
  });

  it("keeps task stop available while collapsed and offers an accessible expand control", () => {
    const html = render({ ...state, collapsed: true });
    expect(html).toContain('aria-label="展开操作预览"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).toMatch(/<div[^>]*hidden=""/);
  });

  it("surfaces stop failures and a retry without covering the conversation", () => {
    const html = render({ ...state, stops: { "ticket-1": { pending: false, error: "停止请求未确认" } } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("停止请求未确认");
    expect(html).toContain("重试停止");
  });

  it("offers a device-specific permission recovery action when a desktop preview is denied", () => {
    const html = render({ ...state, displays: { "desktop-1": { state: "unavailable", permissionRequired: "screen", message: "需要录屏权限才能预览窗口" } } });
    expect(html).toContain('aria-label="检查Mac的系统权限"');
    expect(html).toContain("检查权限");
    const browser = render({ ...state, sessions: [{ ...state.sessions[0]!, tool: "browser" }], displays: { "desktop-1": { state: "unavailable" } } });
    expect(browser).not.toContain("检查权限");
  });
});
