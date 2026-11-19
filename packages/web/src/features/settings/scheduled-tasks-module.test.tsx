import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TicketCardView } from "@moco/protocol";
import { ScheduledTasksModule } from "./scheduled-tasks-module";
import { SETTINGS_MODULES } from "./settings-helpers";
import { MocoSettingsBoard } from "../../moco-settings";
import type { MocoSettingsView } from "@moco/protocol";

const actions = { canQueue: true, stop: async () => {}, delete: async () => {} };

const executeAt = Date.parse("2026-11-17T09:00:00+08:00");
function task(id: string, patch: Partial<TicketCardView> = {}): TicketCardView {
  return {
    id, title: id, role: "researcher", roleLabel: "研究员", status: "waiting",
    envId: "local", workspaceDir: "/tmp/scheduled-task", createdAt: 1, updatedAt: 1,
    waiting: { reason: "time", since: 1, until: executeAt },
    schedule: { executeAt, nextRunAt: executeAt }, ...patch,
  };
}

describe("scheduled task settings", () => {
  it("keeps completed and stopped schedules visible while excluding ordinary work and deleted schedules", () => {
    const html = renderToStaticMarkup(<ScheduledTasksModule loaded connected actions={actions} tickets={[
      task("待执行的晨报", { schedule: { executeAt, nextRunAt: executeAt, repeatEverySeconds: 86400 } }),
      task("已停止的巡检", { status: "stopped", waiting: undefined, schedule: { executeAt, nextRunAt: null } }),
      task("已完成的提醒", { status: "ready", waiting: undefined, schedule: { executeAt, nextRunAt: null } }),
      task("普通任务", { schedule: undefined }),
      task("已删除的计划", { schedule: { executeAt, nextRunAt: null, deletedAt: 2 } }),
    ]} />);
    expect(html).toContain("待执行的晨报");
    expect(html).toContain("每天");
    expect(html).toContain("已停止的巡检");
    expect(html).toContain("已完成的提醒");
    expect(html).not.toContain("普通任务");
    expect(html).not.toContain("已删除的计划");
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.find((button) => button.includes("停止「待执行的晨报」"))).not.toContain('disabled=""');
    for (const title of ["已停止的巡检", "已完成的提醒"]) {
      expect(buttons.find((button) => button.includes(`停止「${title}」`))).toContain('disabled=""');
      expect(buttons.find((button) => button.includes(`删除「${title}」`))).not.toContain('disabled=""');
    }
    for (const label of ["任务", "执行时间", "状态", "操作"]) expect(html).toContain(label);
    for (const action of ["新建任务", "编辑", "恢复", "立即运行"]) expect(html).not.toContain(action);
    expect(SETTINGS_MODULES.filter((module) => module.id === "schedules").map((module) => module.title)).toEqual(["定时任务"]);
  });

  it("disables actions on disconnect while retaining the last visible task state", () => {
    const html = renderToStaticMarkup(<ScheduledTasksModule loaded connected={false} actions={{ ...actions, canQueue: false }} tickets={[task("待连接的巡检")]} />);
    expect(html).toContain("与中枢连接已断开");
    expect(html).toContain("待连接的巡检");
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('disabled=""');
  });

  it("allows offline stops and deletes through the durable queue while retaining the connection warning", () => {
    const html = renderToStaticMarkup(<ScheduledTasksModule loaded connected={false} actions={actions} tickets={[task("离线巡检")]} />);
    expect(html).toContain("与中枢连接已断开");
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).not.toContain('disabled=""');
  });

  it("does not fall back to HTTP when queued actions have not been supplied", () => {
    const html = renderToStaticMarkup(<ScheduledTasksModule loaded connected tickets={[task("缺少交付通道的巡检")]} />);
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('disabled=""');
  });

  it("disables writes when persistent storage is unavailable despite a live connection", () => {
    const html = renderToStaticMarkup(<ScheduledTasksModule loaded connected actions={{ ...actions, canQueue: false }} tickets={[task("存储未就绪的巡检")]} />);
    expect(html).not.toContain("与中枢连接已断开");
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('disabled=""');
  });

  it("passes the durable task actions through the settings board", () => {
    const html = renderToStaticMarkup(<MocoSettingsBoard module="schedules" settings={{} as MocoSettingsView} envs={[]}
      tickets={[task("设置页的巡检")]} ticketsLoaded connected={false} scheduledTaskActions={actions} onSettingsUpdated={() => {}} />);
    expect(html).toContain("设置页的巡检");
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).not.toContain('disabled=""');
  });

  it("distinguishes an initial load from an empty schedule list", () => {
    const loading = renderToStaticMarkup(<ScheduledTasksModule connected loaded={false} tickets={[]} />);
    expect(loading).toContain("加载中");
    expect(loading).not.toContain("暂无定时任务");
    const empty = renderToStaticMarkup(<ScheduledTasksModule connected loaded tickets={[]} />);
    expect(empty).toContain("暂无定时任务");
    expect(empty).not.toContain("加载中");
  });
});
