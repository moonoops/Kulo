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

  it("renders per-card archive buttons without nesting buttons across statuses and hides delete-all when empty", () => {
    const statuses = [
      { ...card, id: "ready-1", title: "已完成任务", status: "ready" as const, completedAt: 1 },
      { ...card, id: "failed-1", title: "失败任务", status: "failed" as const },
      { ...card, id: "stopped-1", title: "停止任务", status: "stopped" as const },
      { ...card, id: "running-1", title: "运行中任务", status: "running" as const },
    ];
    const html = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={statuses}
        onProject={() => {}}
        onRetry={async () => {}}
        onIgnore={async () => {}}
        onArchive={async () => {}}
        onArchiveAll={async () => {}}
      />,
    );
    expect(html).toContain("一键全删");
    expect(html).toContain('aria-label="一键全删所有任务卡片"');
    for (const item of statuses) {
      expect(html).toContain(`aria-label="归档任务：${item.title}"`);
    }
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
      expect(button.match(/<button\b/g)).toHaveLength(1);
    }

    const emptyHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        onProject={() => {}}
        onArchive={async () => {}}
        onArchiveAll={async () => {}}
      />,
    );
    expect(emptyHtml).not.toContain("一键全删");
    expect(emptyHtml).not.toContain("kulo-task-archive-button");
  });

  it("respects canQueueActions on per-card archive and delete-all buttons", () => {
    const enabled = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        connected={false}
        canQueueActions
        onProject={() => {}}
        onArchive={async () => {}}
        onArchiveAll={async () => {}}
      />,
    );
    const disabled = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        connected={false}
        canQueueActions={false}
        onProject={() => {}}
        onArchive={async () => {}}
        onArchiveAll={async () => {}}
      />,
    );
    for (const label of [`归档任务：${card.title}`, "一键全删所有任务卡片"]) {
      const enabledBtn = (enabled.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${label}"`));
      const disabledBtn = (disabled.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${label}"`));
      expect(enabledBtn).toBeDefined();
      expect(enabledBtn).not.toMatch(/\sdisabled(?:=|\s|>)/);
      expect(disabledBtn).toMatch(/\sdisabled(?:=|\s|>)/);
    }
  });

  it("pins assistant items above the worker list with a clean divider and keeps worker listRef isolated", () => {
    const assistantItem = {
      id: "asst-1",
      revision: 1,
      situationId: "sit-1",
      kind: "alert" as const,
      sourceApp: "com.apple.mail",
      sourceLabel: "邮件",
      envName: "MacBook Pro",
      title: "Q4 预算表待确认",
      summary: "老板发来邮件确认定稿时间。",
      primaryActionLabel: "展开讨论",
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
    };

    const combined = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[card]}
        assistantItems={[assistantItem]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
        onArchiveAll={async () => {}}
      />,
    );
    expect(combined).toContain("kulo-assistant-rail-section");
    expect(combined).toContain('data-has-tasks="true"');
    expect(combined).toContain("Q4 预算表待确认");
    expect(combined).toContain("邮件 · MacBook Pro");
    expect(combined).toContain('aria-label="知道了：Q4 预算表待确认"');
    expect(combined).toContain('aria-label="更多操作：Q4 预算表待确认"');
    expect(combined).not.toContain("提醒与建议");
    // Assistant section appears BEFORE .kulo-task-list, never inside it.
    expect(combined.indexOf("kulo-assistant-rail-section")).toBeLessThan(combined.indexOf('class="kulo-task-list"'));
    const listInner = combined.slice(combined.indexOf('class="kulo-task-list"'));
    expect(listInner).not.toContain('data-assistant-item-id="asst-1"');

    // Assistant-only state suppresses empty state and hides Worker "一键全删" toolbar.
    const assistantOnly = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={[assistantItem]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
        onArchiveAll={async () => {}}
      />,
    );
    expect(assistantOnly).toContain("Q4 预算表待确认");
    expect(assistantOnly).not.toContain('data-has-tasks="true"');
    expect(assistantOnly).not.toContain("暂无后台任务");
    expect(assistantOnly).not.toContain("一键全删");

    // L2 decision card displays preview text and single explicit confirmation button.
    const decisionHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={[
          {
            ...assistantItem,
            id: "asst-l2-draft",
            kind: "decision",
            title: "回复客户邮件",
            summary: "已预拟回复草稿",
            primaryActionLabel: undefined,
            pendingAction: {
              actionId: "act-1",
              kind: "spark_create_draft",
              label: "确认存为草稿",
              targetLabel: "client@example.com",
              previewText: "您好，附件是更新后的方案。",
              driverId: "spark-mail",
              operation: "create_draft",
              params: { body: "您好，附件是更新后的方案。" },
            },
          },
        ]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
      />,
    );
    expect(decisionHtml).toContain("kulo-assistant-preview");
    expect(decisionHtml).toContain("您好，附件是更新后的方案。");
    expect(decisionHtml).toContain("确认存为草稿");
  });
});
