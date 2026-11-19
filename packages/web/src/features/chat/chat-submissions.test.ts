import { describe, expect, it } from "vitest";
import type { ChatDisplayItem } from "@kulo/protocol";
import { acknowledgeSubmission, chatDeliveryLabel, mergeChatHistory, mergeChatSubmissions, reconcileSubmissions, removeSubmission, splitChatTimeline, submissionKey, trackSubmission, updateSubmission, upsertSubmission, type SubmissionBackupInput } from "./chat-submissions";

function input(requestId: string, topicId = "topic-a"): SubmissionBackupInput {
  return { topicId, draftKey: `topic:${topicId}`, envelope: { type: "chat.send", topicId, content: "补充条件", requestId, whenBusy: "steer" }, rawUserText: "补充条件", draftAttachments: [], state: "sending" };
}

describe("chat submissions", () => {
  it("shows several rapid submissions immediately and keeps each identity through ACK and retry", () => {
    const first = trackSubmission(input("one"), 100);
    const second = trackSubmission(input("two"), 100);
    expect(first.localMessageId).not.toBe(second.localMessageId);
    const sending = upsertSubmission(upsertSubmission([], first), second);
    const acknowledged = updateSubmission(sending, "one", { state: "accepted", submissionId: 42 });
    const unknown = updateSubmission(acknowledged, "two", { state: "unconfirmed_disconnect" });
    expect(mergeChatSubmissions([], unknown, "topic-a").map((item) => [item.requestId, item.clientSubmission?.state]))
      .toEqual([["one", "accepted"], ["two", "unconfirmed_disconnect"]]);
    const retry = trackSubmission({ ...second, state: "unconfirmed_disconnect" }, 500);
    const retried = upsertSubmission(unknown, retry);
    expect(retried).toHaveLength(2);
    expect(retried[1]?.createdAt).toBe(100);
    expect(retried[1]?.localMessageId).toBe(second.localMessageId);
    expect(submissionKey(retried[1]!)).toBe("two");
  });

  it("uses a durable queued receipt before ACK, and later the transcript entry, without a duplicate bubble", () => {
    const pending = trackSubmission(input("one"), 100);
    const queued: ChatDisplayItem = { id: -42, role: "user", text: pending.rawUserText, requestId: "one", submissionId: 42, delivery: "queued", createdAt: 102 };
    expect(mergeChatSubmissions([queued], [pending], "topic-a")).toEqual([queued]);
    expect(reconcileSubmissions([pending], [queued], "topic-a")).toEqual([]);
    const placed: ChatDisplayItem = { ...queued, id: 99, delivery: undefined };
    expect(mergeChatSubmissions([placed], [pending], "topic-a")).toEqual([placed]);
    expect(splitChatTimeline([placed])).toEqual({ transcript: [placed], pending: [] });
  });

  it("does not deduplicate distinct messages that contain the same text", () => {
    const pending = trackSubmission(input("new"));
    const existing: ChatDisplayItem = { id: 7, role: "user", text: pending.rawUserText, requestId: "old" };
    expect(mergeChatSubmissions([existing], [pending], "topic-a")).toHaveLength(2);
  });

  it("merges ACK-before-echo by request ID and does not present an acceptance receipt", () => {
    const pending = trackSubmission(input("one"), 100);
    const accepted = acknowledgeSubmission([pending], "one", "topic-a", 42);
    const waiting = mergeChatSubmissions([], accepted, "topic-a");
    expect(waiting).toHaveLength(1);
    expect(chatDeliveryLabel(waiting[0]!)).toBeUndefined();
    const echo: ChatDisplayItem = { id: 99, role: "user", text: "补充条件", requestId: "one", createdAt: 102 };
    expect(mergeChatSubmissions([echo], accepted, "topic-a")).toEqual([echo]);
    expect(reconcileSubmissions(accepted, [echo], "topic-a")).toEqual([]);
  });

  it("does not recreate a local bubble when ACK arrives after its echo", () => {
    const pending = trackSubmission(input("one"), 100);
    const echo: ChatDisplayItem = { id: 99, role: "user", text: "补充条件", requestId: "one" };
    const reconciled = reconcileSubmissions([pending], [echo], "topic-a");
    expect(acknowledgeSubmission(reconciled, "one", "topic-a", 42)).toBe(reconciled);
    expect(mergeChatSubmissions([echo], reconciled, "topic-a")).toEqual([echo]);
  });

  it("matches a receipt by a valid submission ID when the echo has no request ID", () => {
    const pending = trackSubmission(input("one"), 100);
    const accepted = acknowledgeSubmission([pending], "one", "topic-a", 42);
    const echo: ChatDisplayItem = { id: 99, role: "user", text: "补充条件", submissionId: 42 };
    expect(mergeChatSubmissions([echo], accepted, "topic-a")).toEqual([echo]);
    expect(reconcileSubmissions(accepted, [echo], "topic-a")).toEqual([]);
    expect(mergeChatSubmissions([echo], [pending], "topic-a")).toHaveLength(2);
  });

  it.each([0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("does not treat invalid submission ID %s as message identity", (submissionId) => {
    const pending = { ...trackSubmission(input("one"), 100), submissionId };
    const echo: ChatDisplayItem = { id: 99, role: "user", text: pending.rawUserText, submissionId };
    expect(mergeChatSubmissions([echo], [pending], "topic-a")).toHaveLength(2);
    expect(reconcileSubmissions([pending], [echo], "topic-a")).toEqual([pending]);
  });

  it("keeps an older unconfirmed text before a later voice message through timeline splitting", () => {
    const pending = { ...trackSubmission({ ...input("text"), rawUserText: "阿萨德" }, 100), state: "unconfirmed_disconnect" as const };
    const assistant: ChatDisplayItem = { id: 7, role: "assistant", text: "在呢", createdAt: 110 };
    const voice: ChatDisplayItem = { id: 8, role: "user", text: "", createdAt: 200,
      attachments: [{ id: "voice", name: "语音消息.webm", kind: "audio", mimeType: "audio/webm", size: 42, url: "/api/uploads/voice", presentation: "voice" }] };
    const merged = mergeChatSubmissions([assistant, voice], [pending], "topic-a");
    expect(merged.map((item) => item.id)).toEqual([pending.localMessageId, 7, 8]);
    expect(splitChatTimeline(merged)).toEqual({ transcript: merged, pending: [] });
  });

  it("keeps failed sends in place before later messages and preserves server order", () => {
    const failed = { ...trackSubmission(input("failed"), 100), state: "failed" as const, error: "网络中断" };
    const server: ChatDisplayItem[] = [
      { id: 20, role: "assistant", text: "先显示的正式记录", createdAt: 300 },
      { id: 21, role: "user", text: "后显示的正式记录", createdAt: 200 },
    ];
    const merged = mergeChatSubmissions(server, [failed], "topic-a");
    expect(merged.map((item) => item.id)).toEqual([failed.localMessageId, 20, 21]);
    expect(splitChatTimeline(merged).transcript).toEqual(merged);
    expect(chatDeliveryLabel(merged[0]!)).toBe("发送失败：网络中断");
  });

  it("uses stable send times without moving same-time messages or sorting negative IDs", () => {
    const late = trackSubmission(input("late"), 300);
    const first = trackSubmission(input("first"), 200);
    const second = trackSubmission(input("second"), 200);
    const server: ChatDisplayItem[] = [
      { id: 7, role: "user", text: "同一时间的正式消息", createdAt: 200 },
      { id: 8, role: "assistant", text: "稍后的答复", createdAt: 250 },
    ];
    const merged = mergeChatSubmissions(server, [late, first, second], "topic-a");
    expect(merged.map((item) => item.id)).toEqual([7, first.localMessageId, second.localMessageId, 8, late.localMessageId]);
    expect(splitChatTimeline(merged).pending.map((item) => item.requestId)).toEqual(["late"]);
  });

  it("retains server placement for entries with no timestamp and separates only the pending tail", () => {
    const pending = trackSubmission(input("waiting"), 100);
    const server: ChatDisplayItem[] = [
      { id: -10, role: "user", text: "较早补充", delivery: "queued" },
      { id: 8, role: "assistant", text: "稍后记录" },
      { id: -11, role: "user", text: "待继续", delivery: "paused" },
    ];
    const merged = mergeChatSubmissions(server, [pending], "topic-a");
    const timeline = splitChatTimeline(merged);
    expect(timeline.transcript).toEqual(server.slice(0, 2));
    expect(timeline.pending.map((item) => item.id)).toEqual([-11, pending.localMessageId]);
    expect(chatDeliveryLabel(server[0]!)).toBe("待处理");
    expect(chatDeliveryLabel(server[2]!)).toBe("待继续");
    expect(chatDeliveryLabel(timeline.pending[1]!)).toBe("发送中");
  });

  it("retires acknowledged offscreen backups instead of replaying old messages outside the recent transcript window", () => {
    const accepted = { ...trackSubmission(input("accepted")), state: "accepted" as const };
    const unknown = { ...trackSubmission(input("unknown")), state: "unconfirmed_disconnect" as const };
    const waiting = trackSubmission(input("still-sending"));
    expect(reconcileSubmissions([accepted, unknown, waiting], [], "topic-a")).toHaveLength(3);
    expect(reconcileSubmissions([accepted, unknown, waiting], [], "topic-b")).toEqual([unknown, waiting]);
  });

  it("keeps ACK-before-echo visible until the user switches away, then trusts durable topic history", () => {
    const pending = trackSubmission(input("one"));
    const accepted = acknowledgeSubmission([pending], "one", "topic-a", 42);
    expect(mergeChatSubmissions([], accepted, "topic-a")).toHaveLength(1);
    const switched = reconcileSubmissions(accepted, [], "topic-b");
    expect(switched).toEqual([]);
    expect(mergeChatSubmissions([], switched, "topic-a")).toEqual([]);
  });

  it("uses the latest topic when ACK arrives after a switch without dropping other uncertain sends", () => {
    const first = trackSubmission(input("one"));
    const second = { ...trackSubmission(input("two")), state: "unconfirmed_disconnect" as const };
    const switched = reconcileSubmissions([first, second], [], "topic-b");
    expect(switched).toEqual([first, second]);
    expect(acknowledgeSubmission(switched, "one", "topic-b", 42)).toEqual([second]);
  });

  it("keeps unknown or rejected messages and their attachments independent from another topic", () => {
    const attached = input("photo");
    attached.envelope.attachments = [{ id: "asset", name: "photo.png", mimeType: "image/png", size: 12, kind: "image", url: "/api/uploads/asset" }];
    const first = trackSubmission(attached, 100);
    const second = trackSubmission(input("other", "topic-b"), 101);
    const failed = updateSubmission([first, second], "photo", { state: "failed", error: "附件不可用" });
    const view = mergeChatSubmissions([], failed, "topic-a");
    expect(view).toHaveLength(1);
    expect(view[0]?.attachments).toEqual(attached.envelope.attachments);
    expect(view[0]?.clientSubmission).toEqual({ key: "photo", state: "failed", error: "附件不可用" });
    expect(reconcileSubmissions(failed, [{ id: 9, role: "user", text: "other", requestId: "photo" }], "topic-b")).toBe(failed);
    expect(removeSubmission(failed, "photo")).toEqual([second]);
  });

  it("renders the current live response before queued, paused and optimistic supplements", () => {
    const assistant: ChatDisplayItem = { id: 4, role: "assistant", text: "正在处理" };
    const queued: ChatDisplayItem = { id: -8, role: "user", text: "补充一", requestId: "one", delivery: "queued" };
    const paused: ChatDisplayItem = { id: -9, role: "user", text: "补充二", requestId: "two", delivery: "paused" };
    const optimistic = trackSubmission(input("three"));
    const timeline = splitChatTimeline(mergeChatSubmissions([assistant, queued, paused], [optimistic], "topic-a"));
    expect(timeline.transcript).toEqual([assistant]);
    expect(timeline.pending.map((item) => item.requestId)).toEqual(["one", "two", "three"]);
  });

  it("does not sort queued negative IDs before transcript history or use them as cursors", () => {
    const history: ChatDisplayItem[] = [{ id: 1, role: "user", text: "过去" }, { id: 2, role: "assistant", text: "答复" }];
    const recent: ChatDisplayItem[] = [{ id: 2, role: "assistant", text: "更新" }, { id: 4, role: "user", text: "现在" }, { id: -8, role: "user", text: "补充", delivery: "queued" }];
    expect(mergeChatHistory(history, recent).map((item) => item.id)).toEqual([1, 2, 4, -8]);
    expect(mergeChatHistory(history, recent)[1]?.text).toBe("更新");
  });
});
