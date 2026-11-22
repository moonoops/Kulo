import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessageParts, type ChatAttachment, type ChatDisplayItem, type LiveStreamState } from "@kulo/protocol";
import { mergeChatHistory, splitChatTimeline } from "./chat-submissions";
import { ConnectedMessageContent } from "./connected-message-content";
import { messageQuote } from "./message-actions";
import { messageReply } from "./reply-reference";
import { liveResponseMessageId, mergeResponseMessages } from "./response-messages";

const createdAt = new Date(2026, 10, 17, 2, 24).getTime();
const html: ChatAttachment = { id: "html", name: "index.html", mimeType: "text/html", kind: "file", size: 40960, url: "/api/uploads/html" };
const image: ChatAttachment = { id: "image", name: "preview.png", mimeType: "image/png", kind: "image", size: 128, url: "/api/uploads/image" };
const file = (id = 2): ChatDisplayItem => ({ id, responseId: 1, role: "assistant", text: "现代精美独立 HTML 页面", createdAt, parts: [
  { partId: "html-part", type: "file", assetId: html.id, asset: html, caption: "现代精美独立 HTML 页面" },
] });
const body = (id = 4): ChatDisplayItem => ({ id, responseId: 1, role: "assistant", text: "文件已经发给你了，点击附件即可打开或保存。", createdAt: createdAt + 1200 });
const live = (patch: Partial<LiveStreamState> = {}): LiveStreamState => ({ busy: true, responseId: 1, streamingText: "文件已经发给你了", activeTools: [], queuedCount: 0, ...patch });
afterEach(() => vi.useRealTimers());

describe("assistant response messages", () => {
  it("renders ordered attachments, captions and final text with one timestamp and action set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 12));
    const preview: ChatDisplayItem = { id: 3, responseId: 1, role: "assistant", text: "页面预览", createdAt: createdAt + 500, parts: [
      { partId: "image-part", type: "image", assetId: image.id, asset: image, caption: "页面预览" },
    ] };
    const items = [file(), preview, body()];
    const original = structuredClone(items);
    const merged = mergeResponseMessages(items);
    expect(items).toEqual(original);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 2, createdAt, responseId: 1 });
    expect(getMessageParts(merged[0]!).map((part) => part.partId)).toEqual(["html-part", "image-part", "4:text"]);
    const quote = messageQuote(merged[0]!);
    expect(quote.text).toBe("现代精美独立 HTML 页面\n\n页面预览\n\n文件已经发给你了，点击附件即可打开或保存。");
    expect(quote.attachments).toEqual([html, image]);
    expect(messageReply(merged[0]!, quote.text)).toEqual({ messageId: 2, role: "assistant", text: quote.text });
    const markup = renderToStaticMarkup(<ConnectedMessageContent item={merged[0]!} onReply={() => {}} />);
    expect(markup.match(/<time\b/g)).toHaveLength(1);
    expect(markup.match(/aria-label="复制消息"/g)).toHaveLength(1);
    expect(markup.match(/aria-label="回复消息"/g)).toHaveLength(1);
    expect(markup).toContain(">02:24</time>");
    expect(markup.indexOf("现代精美独立 HTML 页面")).toBeLessThan(markup.indexOf("页面预览"));
    expect(markup.indexOf("页面预览")).toBeLessThan(markup.indexOf("文件已经发给你了"));
  });

  it("retains process details and sources without assigning a hidden tool entry as the message identity", () => {
    const source = { id: "source", url: "https://example.com/page", title: "来源" };
    const tool: ChatDisplayItem = { id: 1, responseId: 1, role: "assistant", text: "", thinking: "检查产物", createdAt: createdAt - 1000,
      toolCalls: [{ id: "call", name: "kulo_publish_asset", argsSummary: "index.html" }], sources: [source], searchSuggestions: ["建议"] };
    const completed = { ...body(), thinking: "检查结束", toolCalls: [{ ...tool.toolCalls![0]!, result: { text: "已送达", isError: false } }], sources: [{ ...source, title: "已更新来源" }], searchSuggestions: ["建议", "更多建议"] };
    const merged = mergeResponseMessages([tool, file(), completed]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 2, createdAt, thinking: "检查产物\n\n检查结束", sources: [{ ...source, title: "已更新来源" }], searchSuggestions: ["建议", "更多建议"] });
    expect(merged[0]!.toolCalls).toEqual(completed.toolCalls);
    expect(tool.toolCalls![0]).not.toHaveProperty("result");
  });

  it.each(["user", "relay", "system_note"] as const)("keeps replies separated across a %s boundary", (role) => {
    const boundary: ChatDisplayItem = { id: 3, role, responseId: 1, text: "独立消息" };
    expect(mergeResponseMessages([file(), boundary, body()])).toEqual([file(), boundary, body()]);
  });

  it("does not merge independent notifications, missing response metadata or different responses", () => {
    const notification: ChatDisplayItem = { id: 3, role: "assistant", text: "定时任务已完成" };
    expect(mergeResponseMessages([file(), notification, body()])).toHaveLength(3);
    expect(mergeResponseMessages([{ ...file(), responseId: undefined }, body()])).toHaveLength(2);
    expect(mergeResponseMessages([file(), { ...body(), responseId: 5 }])).toHaveLength(2);
  });

  it("merges response segments after history pages are joined without losing raw entries", () => {
    const user: ChatDisplayItem = { id: 1, role: "user", text: "发个 HTML 文件给我" };
    const recent = [body()];
    const history = [user, file()];
    const joined = mergeChatHistory(history, recent);
    expect(joined.map((item) => item.id)).toEqual([1, 2, 4]);
    expect(mergeResponseMessages(joined)).toEqual([user, mergeResponseMessages([file(), body()])[0]]);
    expect(recent).toEqual([body()]);
  });

  it("omits inline dispatch cards in main chat while coalescing same-response assistant segments and preserving pending submissions", () => {
    const user: ChatDisplayItem = { id: 1, role: "user", text: "给 Codex 发测试消息" };
    const toolCall: ChatDisplayItem = { id: 2, role: "assistant", responseId: 10, text: "", toolCalls: [{ id: "call-1", name: "kulo_dispatch", argsSummary: "{}" }] };
    const dispatch: ChatDisplayItem = { id: 3, role: "dispatch", responseId: 10, text: "向 Codex 发送测试消息", dispatch: { ticketId: "ticket", title: "向 Codex 发送测试消息", actionLabel: "派发任务" } };
    const acknowledgement: ChatDisplayItem = { id: 4, role: "assistant", responseId: 10, text: "已经发给 Codex 了，正在等回复。", createdAt };
    const pending: ChatDisplayItem = { id: -1, role: "user", text: "下一个问题", delivery: "queued" };
    const timeline = splitChatTimeline([user, toolCall, dispatch, acknowledgement, pending]);
    const merged = mergeResponseMessages(timeline.transcript);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(user);
    expect(merged[1]).toMatchObject({ id: 4, role: "assistant", text: "已经发给 Codex 了，正在等回复。", toolCalls: toolCall.toolCalls });
    expect(merged.some((item) => item.role === "dispatch")).toBe(false);
    expect(timeline.pending).toEqual([pending]);

    // Pre-dispatch and post-dispatch text within one response merge into one cohesive reply without a card boundary.
    const preface: ChatDisplayItem = { id: 5, role: "assistant", responseId: 11, text: "好的，我来安排。", createdAt };
    const secondDispatch: ChatDisplayItem = { id: 6, role: "dispatch", responseId: 11, text: "执行任务", dispatch: { ticketId: "ticket-2", title: "执行任务", actionLabel: "派发任务" } };
    const followUp: ChatDisplayItem = { id: 7, role: "assistant", responseId: 11, text: "已派发到后台处理。", createdAt: createdAt + 500 };
    const nextTurn: ChatDisplayItem = { id: 8, role: "assistant", responseId: 12, text: "任务已完成。", createdAt: createdAt + 5000 };
    const combined = mergeResponseMessages([preface, secondDispatch, followUp, nextTurn]);
    expect(combined).toHaveLength(2);
    expect(combined[0]).toMatchObject({ id: 5, text: "好的，我来安排。\n\n已派发到后台处理。" });
    expect(combined[1]).toEqual(nextTurn);

    // Silent dispatch (e.g. coordinator steer + [COORDINATOR_OK]) produces no stray chat card.
    expect(mergeResponseMessages([user, dispatch])).toEqual([user]);

    // Live streaming attaches cleanly to an earlier visible assistant segment in the same response even after a dispatch.
    const streamingAfterDispatch = mergeResponseMessages([preface, secondDispatch]);
    expect(liveResponseMessageId(streamingAfterDispatch, live({ responseId: 11 }))).toBe(5);
  });

  it("keeps locally repeated part IDs distinct without changing earlier attachment IDs", () => {
    const first = { ...file(), parts: [{ partId: "text", type: "markdown" as const, text: "开始" }] };
    const next = { ...body(), parts: [{ partId: "text", type: "markdown" as const, text: "结束" }] };
    expect(mergeResponseMessages([first, next])[0]!.parts?.map((part) => part.partId)).toEqual(["text", "4:text"]);
    expect(first.parts[0]!.partId).toBe("text");
    expect(next.parts[0]!.partId).toBe("text");
  });
});

describe("live response attachment", () => {
  it("keeps streaming text in the attachment's message container until the one completed footer is ready", () => {
    const published = mergeResponseMessages([file()]);
    const target = liveResponseMessageId(published, live());
    expect(target).toBe(2);
    const streaming = renderToStaticMarkup(<ConnectedMessageContent item={published[0]!} onReply={() => {}}
      trailingContent={<p>{live().streamingText}</p>} />);
    expect(streaming.match(/class="kulo-message-with-actions"/g)).toHaveLength(1);
    expect(streaming.match(/文件已经发给你了/g)).toHaveLength(1);
    expect(streaming).not.toContain("kulo-message-footer");
    const completed = mergeResponseMessages([file(), body()]);
    expect(completed[0]!.id).toBe(target);
    expect(getMessageParts(completed[0]!)[0]!.partId).toBe(getMessageParts(published[0]!)[0]!.partId);
    expect(liveResponseMessageId(completed, live({ busy: false, streamingText: undefined }))).toBeUndefined();
    const finished = renderToStaticMarkup(<ConnectedMessageContent item={completed[0]!} onReply={() => {}} />);
    expect(finished.match(/文件已经发给你了/g)).toHaveLength(1);
    expect(finished.match(/<time\b/g)).toHaveLength(1);
    expect(finished.match(/aria-label="复制消息"/g)).toHaveLength(1);
  });

  it("leaves unmatched, independent and process-only live replies in their own stream", () => {
    expect(liveResponseMessageId([file()], live({ responseId: 5 }))).toBeUndefined();
    expect(liveResponseMessageId([file()], live({ responseId: undefined }))).toBeUndefined();
    expect(liveResponseMessageId([{ ...file(), responseId: undefined }], live())).toBeUndefined();
    expect(liveResponseMessageId([{ id: 1, role: "assistant", responseId: 1, text: "", thinking: "检查" }], live())).toBeUndefined();
    expect(liveResponseMessageId([file(), { id: 3, role: "user", text: "补充" }], live())).toBeUndefined();
  });
});
