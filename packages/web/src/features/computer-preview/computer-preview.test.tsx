import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TicketCardView } from "@kulo/protocol";
import { KuloTaskRail } from "../tasks/task-rail";
import {
  ComputerPreviewModal,
  TaskCardComputerPreview,
  type ComputerPreviewActions,
} from "./computer-preview";
import { EMPTY_PREVIEW_STATE, type ComputerPreviewState } from "./preview-client";

const desktopSession = {
  id: "desktop-1",
  ticketId: "ticket-1",
  tool: "desktop" as const,
  envId: "local",
  deviceName: "Mac",
  title: "更新文档",
  app: "TextEdit",
};

const browserSession = {
  id: "browser-2",
  ticketId: "ticket-2",
  tool: "browser" as const,
  envId: "remote",
  deviceName: "Macmini",
  title: "搜索 B 站视频",
};

const state: ComputerPreviewState = {
  ...EMPTY_PREVIEW_STATE,
  connection: "connected",
  selectedId: "desktop-1",
  activeTicketId: "ticket-1",
  selectedByTicket: { "ticket-1": "desktop-1" },
  sessions: [desktopSession],
  displays: { "desktop-1": { state: "live", imageUrl: "blob:preview", capturedAt: 1 } },
};

const client: ComputerPreviewActions = {
  setCollapsed: vi.fn(),
  setExpanded: vi.fn(),
  expandTicket: vi.fn(),
  collapseTicket: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
  select: vi.fn(),
  stopTask: vi.fn(),
  retry: vi.fn(),
  frameFailed: vi.fn(),
};

const renderCardPreview = (value: ComputerPreviewState, sessions = value.sessions) =>
  renderToStaticMarkup(
    <TaskCardComputerPreview
      ticketId="ticket-1"
      ticketTitle="更新文档"
      sessions={sessions}
      state={value}
      client={client}
      connected
      onStop={async () => {}}
    />,
  );

const ticket = (id: string, title: string): TicketCardView => ({
  id,
  title,
  role: "developer",
  roleLabel: "开发智能体",
  status: "running",
  envId: "local",
  workspaceDir: "/project",
  createdAt: 1,
  updatedAt: 1,
  startedRunningAt: Date.now(),
  accumulatedRunningMs: 0,
});

describe("embedded task card operation preview", () => {
  it("renders a non-modal embedded preview without repeating the task title or announcing frames", () => {
    const html = renderCardPreview(state);
    expect(html).toContain('aria-label="设备操作预览：更新文档"');
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).toContain('aria-label="放大操作预览：更新文档"');
    expect(html).toContain('aria-label="收起操作预览：更新文档"');
    expect(html).toContain('alt="应用窗口截图"');
    expect(html).toContain("TextEdit · Mac");
    expect(html).not.toContain(">更新文档<");
    expect(html).not.toMatch(/role="dialog"|aria-modal|autofocus|aria-live/);
  });

  it("keeps stop available while collapsed and offers an accessible expand control", () => {
    const html = renderCardPreview({ ...state, collapsed: true });
    expect(html).toContain('aria-label="展开操作预览：更新文档"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).not.toContain('aria-label="放大操作预览：更新文档"');
    expect(html).toMatch(/<div[^>]*hidden=""/);
  });

  it("surfaces stop failures and a retry even while collapsed", () => {
    const html = renderCardPreview({
      ...state,
      collapsed: true,
      stops: { "ticket-1": { pending: false, error: "停止请求未确认" } },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("停止请求未确认");
    expect(html).toContain("重试停止");
  });

  it("offers a device-specific permission recovery action only for desktop previews", () => {
    const desktop = renderCardPreview({
      ...state,
      displays: { "desktop-1": { state: "unavailable", permissionRequired: "screen", message: "需要录屏权限才能预览窗口" } },
    });
    expect(desktop).toContain('aria-label="检查Mac的系统权限"');
    expect(desktop).toContain("检查权限");

    const browser = renderCardPreview(
      {
        ...state,
        sessions: [{ ...desktopSession, tool: "browser", app: undefined }],
        displays: { "desktop-1": { state: "unavailable" } },
      },
      [{ ...desktopSession, tool: "browser", app: undefined }],
    );
    expect(browser).not.toContain("检查权限");
  });

  it("embeds previews into their matching Worker cards in KuloTaskRail with mutual exclusion and no nested buttons", () => {
    const multiState: ComputerPreviewState = {
      ...EMPTY_PREVIEW_STATE,
      connection: "connected",
      selectedId: "browser-2",
      activeTicketId: "ticket-2",
      selectedByTicket: { "ticket-1": "desktop-1", "ticket-2": "browser-2" },
      sessions: [desktopSession, browserSession],
      displays: {
        "desktop-1": { state: "live", imageUrl: "blob:preview-1", capturedAt: 1 },
        "browser-2": { state: "live", imageUrl: "blob:preview-2", capturedAt: 2 },
      },
    };
    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[ticket("ticket-2", "搜索 B 站视频"), ticket("ticket-1", "更新文档")]}
        onProject={() => {}}
        onArchive={async () => {}}
        computerPreview={{ state: multiState, client, onStop: async () => {} }}
      />,
    );
    expect(html).toContain('aria-label="设备操作预览：搜索 B 站视频"');
    expect(html).toContain('aria-label="设备操作预览：更新文档"');
    expect(html).toContain('aria-label="收起操作预览：搜索 B 站视频"');
    expect(html).toContain('aria-label="展开操作预览：更新文档"');
    expect(html).toContain("Macmini · 实时画面");
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
      expect(button.match(/<button\b/g)).toHaveLength(1);
    }
  });

  it("falls back to an orphan preview card in KuloTaskRail when the ticket row has not synced yet", () => {
    const html = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        onProject={() => {}}
        computerPreview={{ state, client, onStop: async () => {} }}
      />,
    );
    expect(html).toContain("kulo-task-preview-orphans");
    expect(html).toContain("更新文档");
    expect(html).toContain('aria-label="停止任务：更新文档"');
    expect(html).not.toContain("暂无后台任务");
  });

  it("renders ComputerPreviewModal when closed without stray dialog content", () => {
    const closed = renderToStaticMarkup(
      <ComputerPreviewModal state={state} client={client} connected onStop={async () => {}} />,
    );
    expect(closed).not.toContain("关闭放大预览");
  });
});
