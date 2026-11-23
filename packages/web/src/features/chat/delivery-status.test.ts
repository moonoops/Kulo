import { describe, expect, it } from "vitest";
import {
  nextTransientDeliveryRevealMs,
  TRANSIENT_DELIVERY_DELAY_MS,
  visibleChatDeliveryLabel,
  visibleTaskSubmissionStatus,
} from "./delivery-status";
import type { ChatViewItem, PendingSubmissionBackup } from "./chat-submissions";

function userItem(
  state: NonNullable<ChatViewItem["clientSubmission"]>["state"],
  createdAt: number,
  extra?: Partial<ChatViewItem>,
): ChatViewItem {
  return {
    id: -1,
    role: "user",
    text: "你好",
    requestId: "req-1",
    createdAt,
    clientSubmission: { key: "req-1", state },
    ...extra,
  };
}

function taskSubmission(
  state: PendingSubmissionBackup["state"],
  createdAt: number,
): PendingSubmissionBackup {
  return {
    topicId: "root",
    draftKey: "ticket:T-1",
    envelope: { type: "ticket.steer", ticketId: "T-1", text: "继续", commandId: "cmd-1" },
    rawUserText: "继续",
    draftAttachments: [],
    state,
    localMessageId: -1,
    createdAt,
  };
}

describe("transient delivery status suppression", () => {
  it("suppresses connected queued and sending labels until the delay threshold elapses", () => {
    const start = 10_000;
    const sending = userItem("sending", start);
    const queued = userItem("queued", start);

    expect(visibleChatDeliveryLabel(sending, true, start)).toBeUndefined();
    expect(visibleChatDeliveryLabel(sending, true, start + TRANSIENT_DELIVERY_DELAY_MS - 1)).toBeUndefined();
    expect(visibleChatDeliveryLabel(sending, true, start + TRANSIENT_DELIVERY_DELAY_MS)).toBe("发送中");

    expect(visibleChatDeliveryLabel(queued, true, start + 500)).toBeUndefined();
    expect(visibleChatDeliveryLabel(queued, true, start + TRANSIENT_DELIVERY_DELAY_MS)).toBe("待发送");
  });

  it("shows offline, unconfirmed, failed, and paused states immediately without delay", () => {
    const start = 10_000;
    expect(visibleChatDeliveryLabel(userItem("queued", start), false, start)).toBe("待发送");
    expect(visibleChatDeliveryLabel(userItem("sending", start), false, start)).toBe("发送中");
    expect(visibleChatDeliveryLabel(userItem("unconfirmed_disconnect", start), true, start)).toBe("待确认");
    expect(visibleChatDeliveryLabel(userItem("failed", start, { clientSubmission: { key: "req-1", state: "failed", error: "网络异常" } }), true, start)).toBe("发送失败：网络异常");
    expect(visibleChatDeliveryLabel({ id: -2, role: "user", text: "排队", delivery: "paused", createdAt: start }, true, start)).toBe("待继续");
  });

  it("applies the same transient threshold to task projection submissions", () => {
    const start = 20_000;
    expect(visibleTaskSubmissionStatus(taskSubmission("sending", start), true, start + 300)).toBeUndefined();
    expect(visibleTaskSubmissionStatus(taskSubmission("sending", start), true, start + TRANSIENT_DELIVERY_DELAY_MS)).toBe("发送中");
    expect(visibleTaskSubmissionStatus(taskSubmission("queued", start), false, start)).toBe("待发送");
    expect(visibleTaskSubmissionStatus(taskSubmission("unconfirmed_disconnect", start), true, start)).toBe("待确认");
  });

  it("computes the earliest reveal timeout only for pending connected transient items", () => {
    const now = 5_000;
    expect(nextTransientDeliveryRevealMs([], true, now)).toBeUndefined();
    expect(nextTransientDeliveryRevealMs([{ state: "queued", createdAt: now }], false, now)).toBeUndefined();
    expect(nextTransientDeliveryRevealMs([{ state: "failed", createdAt: now }], true, now)).toBeUndefined();
    expect(nextTransientDeliveryRevealMs([{ state: "sending", createdAt: now - TRANSIENT_DELIVERY_DELAY_MS }], true, now)).toBeUndefined();
    expect(
      nextTransientDeliveryRevealMs(
        [
          { state: "sending", createdAt: now - 400 },
          { state: "queued", createdAt: now - 1200 },
        ],
        true,
        now,
      ),
    ).toBe(TRANSIENT_DELIVERY_DELAY_MS - 1200);
  });
});
