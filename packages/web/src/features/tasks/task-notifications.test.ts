import { describe, expect, it } from "vitest";
import type { TicketCardView } from "@kulo/protocol";
import { collectTicketNotifications } from "./task-notifications";

function ticket(id: string, status: TicketCardView["status"], title = `Task ${id}`): TicketCardView {
  return {
    id,
    title,
    role: "coder",
    roleLabel: "Coder",
    envId: "local",
    status,
    createdAt: 1,
    updatedAt: 2,
    originTopicId: "root",
  } as TicketCardView;
}

describe("collectTicketNotifications", () => {
  it("stays silent on initial hydration and notifies only active -> ready/blocked/failed transitions", () => {
    const empty = new Map<string, TicketCardView["status"]>();
    expect(collectTicketNotifications(empty, [ticket("T-1", "ready"), ticket("T-2", "failed")])).toEqual([]);

    const prev = new Map<string, TicketCardView["status"]>([
      ["T-1", "running"],
      ["T-2", "waiting"],
      ["T-3", "queued"],
      ["T-4", "ready"],
      ["T-5", "running"],
    ]);
    const events = collectTicketNotifications(prev, [
      ticket("T-1", "ready", "修复单元测试"),
      ticket("T-2", "blocked", "需要确认敏感改动"),
      ticket("T-3", "failed", "构建依赖失败"),
      ticket("T-4", "ready", "已经完成的历史任务"),
      ticket("T-5", "stopped", "用户手动停止"),
    ]);

    expect(events).toEqual([
      { ticketId: "T-1", title: "任务已完成", body: "修复单元测试", topicId: "root" },
      { ticketId: "T-2", title: "任务需要确认", body: "需要确认敏感改动", topicId: "root" },
      { ticketId: "T-3", title: "任务执行失败", body: "构建依赖失败", topicId: "root" },
    ]);
  });
});
