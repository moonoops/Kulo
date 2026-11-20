import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TicketCardView } from "@kulo/protocol";
import { KuloTaskRail } from "./task-rail";

const card: TicketCardView = {
  id: "task-1", title: "主模型派发的任务标题", userSummary: "主模型给出的派单摘要", role: "developer", roleLabel: "开发智能体",
  status: "running", envId: "private-device-id", workspaceDir: "/project", originTopicId: "other-chat",
  createdAt: 1, updatedAt: 1, startedRunningAt: Date.now(), accumulatedRunningMs: 0,
  latestReport: { state: "progress", summary: "当前正在验证转写流程", at: 1 },
};

describe("background task rail", () => {
  it("shows returned native results with a neutral status icon", () => {
    const html = renderToStaticMarkup(<KuloTaskRail completedTaskDisplayHours={null}
      tickets={[{ ...card, status: "ready", externalAgentKind: "claude-code", completedAt: 1 }]} onProject={() => {}} />);
    expect(html).toContain("已返回");
    expect(html).not.toContain("待验收");
    expect(html).toContain('data-tone="wait"');
    expect(html).not.toContain("已完成");
    expect(html).not.toContain('data-tone="done"');
  });

  it("keeps pending-merge staged tasks visible with attention tone and discard-close unlock control", () => {
    const html = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={1}
        tickets={[{ ...card, id: "staged-1", status: "ready", pendingWorkspaceApply: true, completedAt: 1 }]}
        onProject={() => {}}
        onIgnore={async () => {}}
      />,
    );
    expect(html).toContain("待合入");
    expect(html).toContain('data-tone="ask"');
    expect(html).toContain('data-attention="true"');
    expect(html).toContain("丢弃并关闭");
    expect(html).toContain(`aria-label="丢弃并关闭任务：${card.title}"`);
  });
  it("renders global tasks in two compact rows with title, status and concise duration without summary, role or device metadata", () => {
    const html = renderToStaticMarkup(<KuloTaskRail tickets={[card]} onProject={() => {}} />);
    expect(html).not.toContain("kulo-task-rail-heading");
    expect(html).not.toContain("后台任务");
    expect(html).toContain(card.title);
    expect(html).toContain("运行中");
    expect(html).toContain("不到 1 分钟");
    for (const value of [card.roleLabel, card.userSummary!, card.latestReport!.summary, "已运行 ", "用时 ", "当前会话", "全部任务", "提醒与建议", "Kulo's table", "private-device-id", "other-chat"]) {
      expect(html).not.toContain(value);
    }
    expect(html.split('class="kulo-task-title"')).toHaveLength(2);
    expect(html.split('class="kulo-task-card-foot"')).toHaveLength(2);
    for (const removed of ["kulo-task-card-top", "kulo-task-summary", "kulo-task-agent"]) expect(html).not.toContain(removed);
    expect(html).toContain('data-tone="run"');
    expect(html).not.toContain("kulo-task-enter");
  });

  it("omits duration text on the rail card when elapsed time is unrecorded", () => {
    const html = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={[{ ...card, id: "unrecorded", status: "ready", startedRunningAt: undefined, accumulatedRunningMs: undefined, completedAt: 1 }]}
        onProject={() => {}}
      />,
    );
    expect(html).toContain("已完成");
    expect(html).not.toContain("kulo-task-time");
    expect(html).not.toContain("用时未记录");
  });

  it("shows soft distinct completion state and keeps error attention visible without duplicate cards", () => {
    const html = renderToStaticMarkup(<KuloTaskRail completedTaskDisplayHours={null}
      tickets={[{ ...card, id: "done", status: "ready", completedAt: 1 }, { ...card, id: "failed", status: "failed" }]} onProject={() => {}} />);
    expect(html).toContain('data-tone="done"');
    expect(html).toContain('data-tone="fail"');
    expect(html.match(/<button\b[^>]*class="[^"]*\bkulo-task-card-button\b/g)).toHaveLength(2);
  });

  it("offers independent retry and ignore controls while recovery stays out of attention state", () => {
    const html = renderToStaticMarkup(<KuloTaskRail tickets={[{ ...card, status: "failed", recovery: {
      state: "recovering", attempts: 1, startedAt: 1, deadlineAt: 600_001,
    } }]} onProject={() => {}} onRetry={async () => {}} onIgnore={async () => {}} />);
    expect(html).toContain("恢复中");
    expect(html).not.toContain("data-attention");
    expect(html).toContain(`aria-label="重试任务：${card.title}"`);
    expect(html).toContain(`aria-label="忽略任务：${card.title}"`);
    expect(html).toContain('data-state="recovering"');
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) expect(button.match(/<button\b/g)).toHaveLength(1);
  });

  it("allows offline queued actions when durable storage is ready", () => {
    const html = renderToStaticMarkup(<KuloTaskRail tickets={[{ ...card, status: "failed" }]} connected={false} canQueueActions
      onProject={() => {}} onRetry={async () => {}} onIgnore={async () => {}} />);
    for (const label of [`重试任务：${card.title}`, `忽略任务：${card.title}`]) {
      const button = (html.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${label}"`));
      expect(button).toBeDefined();
      expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
    }
  });

  it("keeps actions disabled offline until durable storage is available", () => {
    const html = renderToStaticMarkup(<KuloTaskRail tickets={[{ ...card, status: "failed" }]} connected={false}
      onProject={() => {}} onRetry={async () => {}} onIgnore={async () => {}} />);
    for (const label of [`重试任务：${card.title}`, `忽略任务：${card.title}`]) {
      const button = (html.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${label}"`));
      expect(button).toMatch(/\sdisabled(?:=|\s|>)/);
    }
  });
});
