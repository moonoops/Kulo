import { describe, expect, it } from "vitest";
import type { TicketRecord } from "@moco/protocol";
import { toTicketCardView, transitionTicketStatus } from "../packages/hub/src/state.js";

function ticket(extra: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: "T1", commandId: "dispatch:T1", title: "验证语音识别", goal: "验证语音识别", scope: "/work",
    role: "coder", status: "queued", envId: "local", workspaceDir: "/work",
    workerConversationId: 2, runEpoch: 1, createdAt: 100, updatedAt: 100, queuedAt: 100,
    accumulatedRunningMs: 0, ...extra,
  };
}

describe("durable task timing", () => {
  it("accumulates execution segments while excluding queue and parked waits", () => {
    const current = ticket();
    transitionTicketStatus(current, "running", 1_000);
    current.updatedAt = 1_100;
    transitionTicketStatus(current, "pausing", 1_200);
    expect(current.startedRunningAt).toBe(1_000);
    expect(current.accumulatedRunningMs).toBe(0);
    transitionTicketStatus(current, "waiting", 1_400);
    expect(current.accumulatedRunningMs).toBe(400);
    expect(current.startedRunningAt).toBeUndefined();

    transitionTicketStatus(current, "queued", 10_000);
    expect(current.queuedAt).toBe(10_000);
    transitionTicketStatus(current, "running", 12_000);
    transitionTicketStatus(current, "ready", 12_600);
    expect(current.accumulatedRunningMs).toBe(1_000);
    expect(current.completedAt).toBe(12_600);
    expect(current.startedRunningAt).toBeUndefined();
  });

  it("does not restart a segment when the same phase is replayed or progress arrives", () => {
    const current = ticket();
    transitionTicketStatus(current, "running", 1_000);
    current.latestReport = { state: "progress", summary: "开始验证", at: 1_500 };
    current.updatedAt = 1_500;
    transitionTicketStatus(current, "running", 1_600);
    expect(current.startedRunningAt).toBe(1_000);
    transitionTicketStatus(current, "ready", 2_000);
    expect(current.accumulatedRunningMs).toBe(1_000);
  });

  it("does not count cancellation cleanup for a ticket that never started execution", () => {
    const current = ticket();
    transitionTicketStatus(current, "pausing", 1_000);
    expect(current.startedRunningAt).toBeUndefined();
    transitionTicketStatus(current, "waiting", 9_000);
    expect(current.accumulatedRunningMs).toBe(0);
  });

  it("freezes completion age across metadata updates and resets it for a retry", () => {
    const current = ticket();
    transitionTicketStatus(current, "running", 1_000);
    transitionTicketStatus(current, "ready", 2_000);
    current.updatedAt = 8_000;
    transitionTicketStatus(current, "ready", 9_000);
    expect(toTicketCardView(current, {}).completedAt).toBe(2_000);

    transitionTicketStatus(current, "queued", 10_000);
    expect(current.completedAt).toBeUndefined();
    transitionTicketStatus(current, "running", 11_000);
    transitionTicketStatus(current, "failed", 11_500);
    expect(current.completedAt).toBeUndefined();
    expect(current.accumulatedRunningMs).toBe(1_500);
    transitionTicketStatus(current, "queued", 20_000);
    transitionTicketStatus(current, "running", 21_000);
    transitionTicketStatus(current, "ready", 21_200);
    expect(current.completedAt).toBe(21_200);
    expect(current.accumulatedRunningMs).toBe(1_700);
  });

  it("retains successful completion history when closed and stops counting after cancellation", () => {
    const current = ticket();
    transitionTicketStatus(current, "running", 1_000);
    transitionTicketStatus(current, "ready", 1_500);
    transitionTicketStatus(current, "closed", 9_000);
    expect(current.completedAt).toBe(1_500);
    expect(current.accumulatedRunningMs).toBe(500);

    const cancelled = ticket();
    transitionTicketStatus(cancelled, "running", 1_000);
    transitionTicketStatus(cancelled, "stopped", 1_500);
    cancelled.updatedAt = 10_000;
    transitionTicketStatus(cancelled, "stopped", 10_000);
    expect(cancelled.accumulatedRunningMs).toBe(500);
    expect(cancelled.completedAt).toBeUndefined();
  });

  it("projects legacy timestamps without treating later progress updates as completion", () => {
    const legacy = ticket({ status: "ready", accumulatedRunningMs: undefined, queuedAt: undefined,
      updatedAt: 9_000, latestReport: { state: "ready", summary: "验证完成", at: 2_000 } });
    const card = toTicketCardView(legacy, {});
    expect(card.completedAt).toBe(2_000);
    expect(card.accumulatedRunningMs).toBeUndefined();
    expect(legacy.completedAt).toBeUndefined();
    expect(toTicketCardView(ticket({ queuedAt: undefined }), {}).queuedAt).toBe(100);
    expect(toTicketCardView(ticket({ status: "failed", latestReport: legacy.latestReport }), {}).completedAt).toBeUndefined();

    const unknown = ticket({ status: "running", accumulatedRunningMs: undefined });
    transitionTicketStatus(unknown, "waiting", 3_000);
    expect(unknown.accumulatedRunningMs).toBeUndefined();
  });

  it("projects live segments and cleanup attention without losing the completion timestamp", () => {
    const current = ticket();
    transitionTicketStatus(current, "running", 1_000);
    expect(toTicketCardView(current, {})).toMatchObject({ queuedAt: 100, startedRunningAt: 1_000, accumulatedRunningMs: 0 });
    current.cleanupPending = true;
    transitionTicketStatus(current, "ready", 2_000);
    expect(toTicketCardView(current, {})).toMatchObject({ cleanupPending: true, completedAt: 2_000, accumulatedRunningMs: 1_000 });
  });
});
