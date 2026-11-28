import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { TicketRecord } from "@kulo/protocol";
import { KuloTaskProjection, TaskStatus } from "../../kulo-tasks";

const ticket: TicketRecord = {
  id: "failed-task", commandId: "test-command", title: "识别用户语音消息", goal: "转写语音", scope: "音频文件",
  role: "scout", status: "failed", envId: "local", workspaceDir: "/private/var/folders/very-long-workspace-directory/recordings/task-transcription",
  workerConversationId: 3, runEpoch: 1, createdAt: 1, updatedAt: 2,
  latestReport: { state: "failed", summary: "当前环境没有可用的音频转写工具。", deliverable: "当前环境没有可用的音频转写工具。", at: 2 },
};
const render = (changes: Partial<TicketRecord> = {}, options: Partial<ComponentProps<typeof KuloTaskProjection>> = {}) => renderToStaticMarkup(<KuloTaskProjection detail={{ ticket: { ...ticket, ...changes }, transcript: [], live: { busy: false, activeTools: [], queuedCount: 0 } }}
  roleLabel="临时工" onRetry={async () => {}} onArchiveClose={async () => {}} onStop={() => {}} onDefer={() => {}} onAnswerBlocker={async () => {}} {...options} />);

function button(html: string, label: string) {
  return (html.match(/<button\b[\s\S]*?<\/button>/g) ?? []).find(markup => markup.includes(`aria-label="${label}"`) || markup.includes(`>${label}</button>`)) ?? "";
}

describe("task failure details", () => {
  it("puts a completed result first without a repeated progress summary or full progress bar", () => {
    const html = render({ status: "ready", latestReport: { state: "ready", summary: "页面已保存", deliverable: "已生成 index.html", at: 2 } });
    expect(html).toContain("交付结果");
    expect(html).toContain("已生成 index.html");
    expect(html).not.toContain("最新进展");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("页面已保存");
    expect(html.indexOf("已生成 index.html")).toBeLessThan(html.indexOf("任务信息"));
  });

  it("shows a completed summary once when no separate deliverable was reported", () => {
    const html = render({ status: "ready", latestReport: { state: "ready", summary: "任务处理完成", at: 2 } });
    expect(html.split("任务处理完成")).toHaveLength(2);
    expect(html).toContain("交付结果");
  });

  it("keeps workspace and scratch paths out of the default result, retaining full inspectable reports", () => {
    const scratchDir = "/private/very-long/scratch/task";
    const html = render({ status: "ready", scratchDir, latestReport: { state: "ready", summary: `已在 ${ticket.workspaceDir} 保存页面`, deliverable: `草稿位于 ${scratchDir}/index.html`, at: 2 } });
    const result = html.match(/<article class="kulo-task-result-content">([\s\S]*?)<\/article>/)?.[1];
    expect(result).toContain("工作目录");
    expect(result).not.toContain(ticket.workspaceDir);
    expect(result).not.toContain(scratchDir);
    expect(html).toContain("交付说明");
    expect(html).toContain(`${scratchDir}/index.html`);
    expect(html).toContain(ticket.workspaceDir);
  });

  it("shows the actual cause once, with retry and ignore actions and the full inspectable workspace", () => {
    const html = render();
    expect(html).toContain("失败原因");
    expect(html.split(ticket.latestReport!.summary)).toHaveLength(2);
    expect(html).not.toContain("交付结果");
    expect(html).not.toContain("模型网关");
    expect(html).toContain(`aria-label="重试任务：${ticket.title}"`);
    expect(html).toContain(`aria-label="忽略任务：${ticket.title}"`);
    expect(html).toContain(ticket.workspaceDir);
  });

  it("shows recovery as indeterminate progress and preserves the reason of the last failed attempt", () => {
    const recovery = { state: "recovering" as const, attempts: 1, startedAt: 1, deadlineAt: 600_001 };
    const html = render({ recovery });
    expect(html).toContain("正在尝试其他方案");
    expect(html).toContain('aria-label="正在恢复任务"');
    expect(html).toContain(ticket.latestReport!.summary);
    expect(renderToStaticMarkup(<TaskStatus status="failed" recovery={recovery} />)).toContain("恢复中");
    expect(renderToStaticMarkup(<TaskStatus status="failed" recovery={{ ...recovery, state: "exhausted" }} />)).toContain("需处理");
  });

  it("allows durable task actions offline while keeping detail reads unavailable", () => {
    const html = render({ status: "blocked" }, { connected: false, canQueueActions: true, detailError: "连接中断", onRetryInspect: () => {} });
    for (const label of [`停止任务：${ticket.title}`, `重试任务：${ticket.title}`]) {
      expect(button(html, label)).not.toMatch(/\sdisabled(?:=|\s|>)/);
    }
    expect(button(html, "重试加载")).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(button(html, "确认提交")).toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it.each(["failed", "blocked", "ready"] as const)("blocks %s writes when the outbox is unavailable even with a live connection", status => {
    const html = render({ status }, { connected: true, canQueueActions: false });
    const labels = status === "failed" ? [`重试任务：${ticket.title}`, `忽略任务：${ticket.title}`]
      : status === "blocked" ? [`停止任务：${ticket.title}`, `重试任务：${ticket.title}`] : [`关闭任务：${ticket.title}`];
    for (const label of labels) expect(button(html, label)).toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("restores an unconfirmed answer without allowing another submission or claiming server acceptance", () => {
    const html = render({ status: "blocked" }, { connected: false, canQueueActions: true, pendingAnswer: { text: "保留原端口 8080", commandId: "ans:persisted" } });
    expect(html).toContain("保留原端口 8080</textarea>");
    expect(html.match(/<textarea\b[^>]*>/)?.[0]).toMatch(/\sdisabled(?:=|\s|>)/);
    const pending = (html.match(/<button\b[\s\S]*?<\/button>/g) ?? []).find(markup => markup.includes("提交中…"));
    expect(pending).toMatch(/\sdisabled(?:=|\s|>)|aria-disabled="true"/);
    expect(pending).toContain('data-pending="true"');
    expect(html).not.toContain("已接收回复");
  });

  it("renders structured quick-action buttons alongside optional manual input and prefers localized waiting detail", () => {
    const html = render({
      status: "waiting",
      latestReport: { state: "blocked", summary: "Port conflict", question: "Reuse 8888 or install on a new port?", at: 2 },
      waiting: {
        reason: "user",
        since: 2,
        detail: "8888 端口已运行旧版 Hindsight，如何处理？",
        options: [
          { id: "reuse", label: "复用现有 8888 实例", tone: "primary" },
          { id: "reinstall", label: "换端口全新安装", tone: "secondary" },
        ],
      },
    });
    expect(html).toContain("8888 端口已运行旧版 Hindsight，如何处理？");
    expect(html).not.toContain("Reuse 8888 or install on a new port?");
    expect(html).toContain("复用现有 8888 实例");
    expect(html).toContain("换端口全新安装");
    expect(html).toContain("按说明提交");
  });

  it("shows coordinating status without surfacing the user blocker form when waiting on main Agent judgment", () => {
    const html = render({
      status: "waiting",
      latestReport: { state: "blocked", summary: "Need choice", question: "Internal worker blocker", at: 2 },
      waiting: { reason: "coordinator", since: 2, detail: "Internal worker blocker" },
    });
    expect(html).toContain("主脑研判中");
    expect(html).not.toContain("问题待确认");
    expect(html).not.toContain("<textarea");
  });

  it("disables quick-action stop choices and top controls while an offline ticket.stop is pending", () => {
    const html = render(
      {
        status: "waiting",
        waiting: {
          reason: "user",
          since: 2,
          detail: "是否授予手机截屏权限？",
          options: [
            { id: "grant", label: "已授权，继续", tone: "primary", action: "reply" },
            { id: "stop", label: "暂不授予，结束任务", tone: "secondary", action: "stop" },
          ],
        },
      },
      { pendingStop: true },
    );
    expect(button(html, "已授权，继续")).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(button(html, "暂不授予，结束任务")).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(button(html, `停止任务：${ticket.title}`)).toMatch(/\sdisabled(?:=|\s|>)|aria-disabled="true"/);
  });

  it("renders stopped tasks with localized default reason, custom reason, cleanup-pending label, and no duplicate execution result", () => {
    const defaultStopped = render({
      status: "stopped",
      stoppedReason: "Stopped by user",
      latestReport: { state: "blocked", summary: "缺少权限", deliverable: "缺少权限", at: 2 },
    });
    expect(defaultStopped).toContain("已停止");
    expect(defaultStopped).toContain("已由用户停止");
    expect(defaultStopped).not.toContain("Stopped by user");
    expect(defaultStopped).not.toContain("执行结果");

    const customStopped = render({
      status: "stopped",
      stoppedReason: "暂不授予，结束任务",
      latestReport: { state: "blocked", summary: "设备未授予截屏权限", deliverable: "设备未授予截屏权限", at: 2 },
    });
    expect(customStopped).toContain("已停止");
    expect(customStopped).toContain("暂不授予，结束任务");
    expect(customStopped).not.toContain("最新进展");
    expect(customStopped).not.toContain("执行结果");

    const cleanupStopped = render({
      status: "stopped",
      cleanupPending: true,
      stoppedReason: "用户跳过人工接管并停止任务",
    });
    expect(cleanupStopped).toContain("清理待确认");
    expect(cleanupStopped).toContain("用户跳过人工接管并停止任务");
  });

  it("renders read-only external context usage and session mode, supporting 0 tokens and omitting percentage when window is unknown", () => {
    const withWindow = render({
      status: "running",
      externalExecution: {
        binding: { kind: "antigravity", envId: "local" },
        contextUsage: { usedTokens: 0, contextWindow: 200_000, percent: 0, updatedAt: 10 },
        activeSessionMode: "plan",
      },
    });
    expect(withWindow).toContain("上下文 0 / 200k (0%)");
    expect(withWindow).toContain("模式 plan");

    const unknownWindow = render({
      status: "running",
      externalExecution: {
        binding: { kind: "antigravity", envId: "local" },
        contextUsage: { usedTokens: 42_500, updatedAt: 10 },
      },
    });
    expect(unknownWindow).toContain("上下文 42.5k");
    expect(unknownWindow).not.toContain("%");

    const zeroUnknownWindow = render({
      status: "running",
      externalExecution: {
        binding: { kind: "antigravity", envId: "local" },
        contextUsage: { usedTokens: 0, contextWindow: 0, updatedAt: 10 },
      },
    });
    expect(zeroUnknownWindow).toContain("上下文 0");
    expect(zeroUnknownWindow).not.toContain("%");

    // Unupgraded old Env missing telemetry degrades gracefully
    const legacyEnv = render({
      status: "running",
      externalExecution: {
        binding: { kind: "antigravity", envId: "local" },
      },
    });
    expect(legacyEnv).not.toContain("上下文 ");
    expect(legacyEnv).not.toContain("模式 ");
  });
});
