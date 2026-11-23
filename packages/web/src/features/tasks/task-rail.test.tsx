import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ASSISTANT_FYI_TTL_MS, type AssistantItemView, type TicketCardView } from "@kulo/protocol";
import { partitionAssistantItems, visibleAssistantItems } from "./assistant-rail-model";
import { KuloTaskRail } from "./task-rail";
import {
  archiveTicketsBatch,
  buildClearAllDescription,
  TaskRailClearAllAction,
} from "./task-rail-clear-all";

const card: TicketCardView = {
  id: "task-1", title: "主模型派发的任务标题", userSummary: "主模型给出的派单摘要", role: "developer", roleLabel: "开发智能体",
  status: "running", envId: "private-device-id", workspaceDir: "/project", originTopicId: "other-chat",
  createdAt: 1, updatedAt: 1, startedRunningAt: Date.now(), accumulatedRunningMs: 0,
  latestReport: { state: "progress", summary: "当前正在验证转写流程", at: 1 },
};

describe("background task rail", () => {
  it("shows completed external agent tasks with unified done tone when no merge is pending", () => {
    const html = renderToStaticMarkup(<KuloTaskRail completedTaskDisplayHours={null}
      tickets={[{ ...card, status: "ready", externalAgentKind: "claude-code", completedAt: 1 }]} onProject={() => {}} />);
    expect(html).toContain("已完成");
    expect(html).not.toContain("待验收");
    expect(html).not.toContain("已返回");
    expect(html).toContain('data-tone="done"');
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

  it("renders per-card archive buttons without an inline top toolbar and moves delete-all to the header action", () => {
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
      />,
    );
    expect(html).not.toContain("kulo-task-rail-toolbar");
    expect(html).not.toContain("一键全删");
    for (const item of statuses) {
      expect(html).toContain(`aria-label="归档任务：${item.title}"`);
    }
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
      expect(button.match(/<button\b/g)).toHaveLength(1);
    }

    const headerActionHtml = renderToStaticMarkup(
      <TaskRailClearAllAction
        completedTaskDisplayHours={null}
        tickets={statuses}
        onArchiveAll={async () => {}}
      />,
    );
    expect(headerActionHtml).toContain('aria-label="一键全删所有任务卡片"');
    expect(headerActionHtml).toContain("kulo-window-control");
    expect(headerActionHtml).toContain("button--icon-only");
    expect(headerActionHtml).toContain("button--ghost");
    expect(headerActionHtml).not.toContain(">一键全删<");

    const emptyHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        onProject={() => {}}
        onArchive={async () => {}}
      />,
    );
    expect(emptyHtml).not.toContain("kulo-task-archive-button");

    const emptyHeaderAction = renderToStaticMarkup(
      <TaskRailClearAllAction
        tickets={[]}
        onArchiveAll={async () => {}}
      />,
    );
    expect(emptyHeaderAction).toBe("");

    const expiredHeaderAction = renderToStaticMarkup(
      <TaskRailClearAllAction
        completedTaskDisplayHours={1}
        tickets={[{ ...card, id: "old-done", status: "ready", completedAt: 1 }]}
        onArchiveAll={async () => {}}
      />,
    );
    expect(expiredHeaderAction).toBe("");
  });

  it("respects canQueueActions and clearingAll on per-card archive and header delete-all buttons", () => {
    const enabledRail = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        connected={false}
        canQueueActions
        onProject={() => {}}
        onArchive={async () => {}}
      />,
    );
    const disabledRail = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        connected={false}
        canQueueActions={false}
        onProject={() => {}}
        onArchive={async () => {}}
      />,
    );
    const busyRail = renderToStaticMarkup(
      <KuloTaskRail
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        connected
        canQueueActions
        clearingAll
        clearAllError="部分任务删除失败，请重试。"
        onProject={() => {}}
        onArchive={async () => {}}
      />,
    );
    const enabledHeader = renderToStaticMarkup(
      <TaskRailClearAllAction
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        canQueueActions
        onArchiveAll={async () => {}}
      />,
    );
    const disabledHeader = renderToStaticMarkup(
      <TaskRailClearAllAction
        completedTaskDisplayHours={null}
        tickets={[{ ...card, status: "ready", completedAt: 1 }]}
        canQueueActions={false}
        onArchiveAll={async () => {}}
      />,
    );
    const archiveLabel = `归档任务：${card.title}`;
    const enabledArchiveBtn = (enabledRail.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${archiveLabel}"`));
    const disabledArchiveBtn = (disabledRail.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${archiveLabel}"`));
    const busyArchiveBtn = (busyRail.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${archiveLabel}"`));
    expect(enabledArchiveBtn).toBeDefined();
    expect(enabledArchiveBtn).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(disabledArchiveBtn).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(busyArchiveBtn).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(busyRail).toContain('class="kulo-task-rail-error" role="alert">部分任务删除失败，请重试。</p>');

    const clearLabel = "一键全删所有任务卡片";
    const enabledClearBtn = (enabledHeader.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${clearLabel}"`));
    const disabledClearBtn = (disabledHeader.match(/<button\b[^>]*>/g) ?? []).find(markup => markup.includes(`aria-label="${clearLabel}"`));
    expect(enabledClearBtn).toBeDefined();
    expect(enabledClearBtn).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(disabledClearBtn).toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("formats clear-all confirmation summary and batches archive calls with error propagation", async () => {
    const t = (zh: string) => zh;
    const summary = buildClearAllDescription(
      [
        { ...card, id: "run-1", status: "running" },
        { ...card, id: "merge-1", status: "ready", pendingWorkspaceApply: true },
        { ...card, id: "done-1", status: "ready" },
      ],
      t,
    );
    expect(summary).toContain("全部 3 张任务卡片");
    expect(summary).toContain("1 项进行中任务将被停止");
    expect(summary).toContain("1 项未合入改动将被丢弃");

    const seen: string[] = [];
    await archiveTicketsBatch(["a", "b", "a"], async (id) => { seen.push(id); }, "fallback");
    expect(seen).toEqual(["a", "b"]);

    await expect(
      archiveTicketsBatch(
        ["ok", "bad"],
        async (id) => { if (id === "bad") throw new Error("network down"); },
        "fallback",
      ),
    ).rejects.toThrow("network down");
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

    // Assistant-only state suppresses empty state and hides Worker "一键全删" header action.
    const assistantOnly = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={[assistantItem]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
      />,
    );
    expect(assistantOnly).toContain("Q4 预算表待确认");
    expect(assistantOnly).not.toContain('data-has-tasks="true"');
    expect(assistantOnly).not.toContain("暂无后台任务");
    expect(assistantOnly).not.toContain("一键全删");
    expect(
      renderToStaticMarkup(<TaskRailClearAllAction tickets={[]} onArchiveAll={async () => {}} />),
    ).toBe("");

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

    // Dispatched L2 card disables confirmation button and displays in-flight label.
    const dispatchedHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={[
          {
            ...assistantItem,
            id: "asst-l2-dispatched",
            kind: "decision",
            title: "发送飞书回复",
            summary: "执行中测试",
            primaryActionLabel: undefined,
            pendingAction: {
              actionId: "act-disp",
              kind: "lark_send_reply",
              label: "确认发送",
              targetLabel: "群聊",
              previewText: "会议改期通知",
              driverId: "lark-cli",
              operation: "send_reply",
              params: { chatId: "oc_1", text: "会议改期通知" },
              executionState: "dispatched",
              dispatchedAt: Date.now(),
            },
          },
        ]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
      />,
    );
    expect(dispatchedHtml).toContain("执行中…");
    expect(dispatchedHtml).not.toContain(">确认发送<");

    // Unknown L2 card renders verification notice and read-only dismiss button (never re-offering confirm).
    const unknownHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={[
          {
            ...assistantItem,
            id: "asst-l2-unknown",
            kind: "decision",
            title: "发送飞书回复",
            summary: "超时未决",
            primaryActionLabel: undefined,
            pendingAction: {
              actionId: "act-unk",
              kind: "lark_send_reply",
              label: "确认发送",
              targetLabel: "群聊",
              previewText: "会议改期通知",
              driverId: "lark-cli",
              operation: "send_reply",
              params: { chatId: "oc_1", text: "会议改期通知" },
              executionState: "unknown",
              lastError: "连接超时，请核对飞书群聊是否已发出",
            },
          },
        ]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
      />,
    );
    expect(unknownHtml).toContain("连接超时，请核对飞书群聊是否已发出");
    expect(unknownHtml).toContain("已核对，收起");
    expect(unknownHtml).not.toContain(">确认发送<");
  });

  it("sorts assistant items by 4-tier priority, folds overflow past 3, never folds decisions, filters expired items, and shows dismiss-all only for >= 2 passive reminders", () => {
    const now = Date.now();
    const makeItem = (
      id: string,
      overrides: Partial<AssistantItemView> = {},
    ): AssistantItemView => ({
      id,
      revision: 1,
      situationId: id,
      kind: "fyi",
      sourceApp: "com.electron.lark",
      sourceLabel: "飞书",
      envName: "MacBook",
      title: `提醒 ${id}`,
      summary: `摘要 ${id}`,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      ...overrides,
    });

    const items: AssistantItemView[] = [
      makeItem("fyi-1", { updatedAt: now - 10_000 }),
      makeItem("fyi-2", { updatedAt: now - 20_000 }),
      makeItem("fyi-3", { updatedAt: now - 30_000 }),
      makeItem("fyi-4", { updatedAt: now - 40_000 }),
      makeItem("fyi-expired", { updatedAt: now - ASSISTANT_FYI_TTL_MS - 60_000 }),
      makeItem("alert-1", { kind: "alert", updatedAt: now - 50_000 }),
      makeItem("ha-alert", { kind: "alert", sourceApp: "home-assistant", sourceLabel: "智能家居", updatedAt: now - 60_000 }),
      makeItem("dec-1", {
        kind: "decision",
        updatedAt: now - 70_000,
        pendingAction: {
          actionId: "a-1",
          kind: "spark_create_draft",
          label: "确认存为草稿",
          targetLabel: "a@example.com",
          previewText: "草稿正文",
          driverId: "spark-mail",
          operation: "create_draft",
          params: { body: "草稿正文" },
        },
      }),
    ];

    // Expired item is filtered unless protected (hovered / focused / menu open).
    const active = visibleAssistantItems(items, now);
    expect(active.map((i) => i.id)).toEqual(["dec-1", "ha-alert", "alert-1", "fyi-1", "fyi-2", "fyi-3", "fyi-4"]);
    const withProtected = visibleAssistantItems(items, now, new Set(["fyi-expired"]));
    expect(withProtected.some((i) => i.id === "fyi-expired")).toBe(true);

    // Optimistic dismissal hides items immediately until revision advances.
    const optimistic = visibleAssistantItems(items, now, new Set(), new Map([["fyi-1", 1]]));
    expect(optimistic.some((i) => i.id === "fyi-1")).toBe(false);

    // Default fold shows top 3, collapses remaining 4, and dismissibleItems excludes decision cards & busy items.
    const collapsed = partitionAssistantItems(active, false, new Set(["fyi-2"]));
    expect(collapsed.displayed.map((i) => i.id)).toEqual(["dec-1", "ha-alert", "alert-1"]);
    expect(collapsed.hiddenCount).toBe(4);
    expect(collapsed.dismissibleItems.map((i) => i.id)).toEqual(["ha-alert", "alert-1", "fyi-1", "fyi-3", "fyi-4"]);

    // Never hides L2 decision cards even when there are more than 3 decisions.
    const fourDecisions = [1, 2, 3, 4].map((n) => makeItem(`dec-${n}`, { kind: "decision", updatedAt: now - n * 1_000 }));
    const decisionFold = partitionAssistantItems([...fourDecisions, makeItem("fyi-extra")], false);
    expect(decisionFold.displayed.map((i) => i.id)).toEqual(["dec-1", "dec-2", "dec-3", "dec-4"]);
    expect(decisionFold.hiddenCount).toBe(1);

    // Rendered rail folds excess into "还有 4 条提醒" and shows "全部知道了" without Worker "一键全删".
    const railHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={items}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
      />,
    );
    expect(railHtml).toContain("提醒 dec-1");
    expect(railHtml).toContain("提醒 ha-alert");
    expect(railHtml).toContain("提醒 alert-1");
    expect(railHtml).not.toContain("提醒 fyi-1");
    expect(railHtml).not.toContain("提醒 fyi-expired");
    expect(railHtml).toContain("还有 4 条提醒");
    expect(railHtml).toContain("全部知道了");
    expect(railHtml).not.toContain("一键全删");

    // When all assistant items have expired client-side and there are no tasks, empty state renders cleanly.
    const allExpiredHtml = renderToStaticMarkup(
      <KuloTaskRail
        tickets={[]}
        assistantItems={[makeItem("only-expired", { updatedAt: now - ASSISTANT_FYI_TTL_MS - 60_000 })]}
        onAssistantItemAction={async () => {}}
        onProject={() => {}}
      />,
    );
    expect(allExpiredHtml).not.toContain("kulo-assistant-rail-section");
    expect(allExpiredHtml).toContain("暂无后台任务");
  });
});
