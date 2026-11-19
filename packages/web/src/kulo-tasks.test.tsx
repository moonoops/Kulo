import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DispatchCardMeta, TicketCardView } from "@kulo/protocol";
import { TaskDispatchCard, TaskStatus } from "./kulo-tasks";

describe("task dispatch chat cards", () => {
  it("shows the returned external result in the inline card", () => {
    const dispatch: DispatchCardMeta = { actionLabel: "派发任务", ticketId: "T-native", title: "检查修改" };
    const native: TicketCardView = {
      id: dispatch.ticketId, title: dispatch.title, role: "external-codex", roleLabel: "Codex", status: "ready", externalAgentKind: "codex",
      envId: "local", workspaceDir: "/task", createdAt: 1, updatedAt: 2,
      latestReport: { state: "ready", summary: "NATIVE_UNREVIEWED_CLAIM", at: 2 },
    };
    const html = renderToStaticMarkup(<TaskDispatchCard dispatch={dispatch} liveTicket={native} onProject={() => {}} />);
    expect(html).toContain("已返回");
    expect(html).not.toContain("待验收");
    expect(html).not.toContain("已完成");
    expect(html).not.toContain("NATIVE_UNREVIEWED_CLAIM");
    const status = renderToStaticMarkup(<TaskStatus {...native} />);
    expect(status).toContain("已返回");
    expect(status).not.toContain("chip--success");
    expect(renderToStaticMarkup(<TaskStatus status="ready" />)).toContain("已完成");
    const pendingStatus = renderToStaticMarkup(<TaskStatus status="ready" pendingWorkspaceApply />);
    expect(pendingStatus).toContain("待合入");
    expect(pendingStatus).not.toContain("chip--success");
  });
  it("keeps unreviewed Worker conclusions out of the original chat", () => {
    const dispatch: DispatchCardMeta = { actionLabel: "派发任务", ticketId: "T-review", title: "生成网页", userSummary: "制作可交互的网页" };
    const ticket: TicketCardView = {
      id: dispatch.ticketId, title: dispatch.title, role: "coder", roleLabel: "开发者", status: "ready",
      envId: "local", workspaceDir: "/task", createdAt: 1, updatedAt: 2,
      latestReport: { state: "ready", summary: "WORKER_UNREVIEWED_CLAIM", deliverable: "WORKER_UNREVIEWED_BODY", at: 2 },
    };
    const html = renderToStaticMarkup(<TaskDispatchCard dispatch={dispatch} liveTicket={ticket} onProject={() => {}} />);
    expect(html).toContain(dispatch.userSummary);
    expect(html).toContain('aria-label="查看任务：生成网页"');
    expect(html).not.toContain("WORKER_UNREVIEWED");
  });
});
