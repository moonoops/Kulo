import { describe, expect, it } from "vitest";
import type { ReliableOutboxRecord } from "./reliable-outbox";
import { consumePersistedDraft, consumedOutboxReceipts, outboxSubmissions } from "./outbox-submissions";
import { chatDeliveryLabel, mergeChatSubmissions } from "./chat-submissions";

function queued(changes: Partial<ReliableOutboxRecord> = {}): ReliableOutboxRecord {
  return { id: "one", scope: "hub-a", sequence: 1, createdAt: 100, envelope: { type: "chat.send", topicId: "root", content: "保存的消息", requestId: "one", whenBusy: "steer" }, state: "queued", attempt: 0, nextAttemptAt: 0, ...changes };
}

describe("durable submissions in the conversation", () => {
  it("restores queued message identity, draft and uploaded attachments after a fresh page", () => {
    const attachment = { id: "asset-one", name: "sample.png", mimeType: "image/png", kind: "image" as const, size: 42, url: "/api/uploads/asset-one" };
    const source = queued({ envelope: { type: "chat.send", topicId: "root", requestId: "one", content: "保存的消息", attachments: [attachment] } });
    const first = outboxSubmissions([source])[0]!;
    const restored = outboxSubmissions(JSON.parse(JSON.stringify([source])))[0]!;
    expect(restored).toEqual(first);
    expect(restored.draftAttachments[0]?.attachment).toEqual(attachment);
    expect(restored.draftAttachments[0]?.previewUrl).toBeUndefined();
    expect(restored.outboxScope).toBe("hub-a");
    expect(chatDeliveryLabel(mergeChatSubmissions([], [restored], "root")[0]!)).toBe("待发送");
  });

  it("does not reorder saved submissions when the local clock moves backward", () => {
    const first = queued({ createdAt: 200 });
    const second = queued({ id: "two", sequence: 2, createdAt: 100, envelope: { type: "chat.send", topicId: "root", content: "后发的消息", requestId: "two" } });
    const view = mergeChatSubmissions([], outboxSubmissions([second, first]), "root");
    expect(view.map((item) => item.requestId)).toEqual(["one", "two"]);
  });

  it("keeps missing ACKs retryable and hides a normal acceptance receipt", () => {
    const [uncertain, accepted] = outboxSubmissions([queued({ attempt: 1 }), queued({ id: "accepted", state: "accepted", ack: { submissionId: 42 } })]);
    expect(uncertain?.state).toBe("unconfirmed_disconnect");
    expect(accepted?.submissionId).toBe(42);
    expect(chatDeliveryLabel(mergeChatSubmissions([], [accepted!], "root")[0]!)).toBeUndefined();
  });

  it("consumes only durable accepted receipts, with exact identities for the active topic", () => {
    const records = [queued(), queued({ id: "accepted", state: "accepted", envelope: { type: "chat.send", topicId: "root", content: "相同文本", requestId: "accepted" } }), queued({ id: "offscreen", state: "accepted", envelope: { type: "chat.send", topicId: "other", content: "另一个话题", requestId: "offscreen" } }), queued({ id: "command", state: "accepted", envelope: { type: "ticket.stop", ticketId: "T1", commandId: "command" } })];
    expect(consumedOutboxReceipts(records, [{ id: 7, role: "user", text: "相同文本", requestId: "different" }], "root")).toEqual(["offscreen", "command"]);
    expect(consumedOutboxReceipts(records, [{ id: 7, role: "user", text: "相同文本", requestId: "accepted" }], "root")).toEqual(["accepted", "offscreen", "command"]);
  });

  it("keeps a rejected conflicting payload visible beside the original server message", () => {
    const failed = queued({ state: "failed", errorCode: "request_intent_conflict", error: "同一消息标识不能用于不同内容" });
    const backups = outboxSubmissions([failed]);
    const view = mergeChatSubmissions([{ id: 7, role: "user", text: "服务器原文", requestId: "one" }], backups, "root");
    expect(view).toHaveLength(2);
    expect(view[1]?.clientSubmission?.errorCode).toBe("request_intent_conflict");
    expect(chatDeliveryLabel(view[1]!)).toContain("发送失败");
    expect(consumedOutboxReceipts([failed], view, "root")).toEqual([]);
  });

  it("restores a task composer submission separately from ordinary chat", () => {
    const source = queued({ id: "steer", envelope: { type: "ticket.steer", ticketId: "T1", text: "补充条件", commandId: "steer" }, metadata: { topicId: "root", draftKey: "ticket:T1", rawUserText: "补充条件" } });
    const restored = outboxSubmissions([source])[0]!;
    expect(restored.draftKey).toBe("ticket:T1");
    expect(restored.envelope.type).toBe("ticket.steer");
    expect(mergeChatSubmissions([], [restored], "root")).toEqual([]);
  });
});

describe("clearing the composer after durable commit", () => {
  it("clears only the submitted draft and keeps another conversation", () => {
    expect(consumePersistedDraft({ a: "原消息", b: "另一个话题" }, "a", "原消息")).toEqual({ a: "", b: "另一个话题" });
  });
  it("preserves text typed while the persistence transaction was pending", () => {
    expect(consumePersistedDraft({ a: "原消息\n补充文字" }, "a", "原消息")).toEqual({ a: "\n补充文字" });
    const changed = { a: "重新写的内容" };
    expect(consumePersistedDraft(changed, "a", "原消息")).toBe(changed);
  });
});
