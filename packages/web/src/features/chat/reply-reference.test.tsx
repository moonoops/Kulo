import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatDisplayItem, ChatReplyReference } from "@kulo/protocol";
import { KuloComposer } from "../../kulo-composer";
import { MessageContent } from "./message-content";
import { messageQuote } from "./message-actions";
import { consumeReplyDraft, messageReply, replyPreview, restoreReplyDraft } from "./reply-reference";
import { outboxSubmissions } from "./outbox-submissions";
import { mergeChatSubmissions } from "./chat-submissions";
import type { ReliableOutboxRecord } from "./reliable-outbox";

const reply: ChatReplyReference = { messageId: 12, role: "assistant", text: "先确认上下文压缩扩展的运行状态。" };

describe("reply references", () => {
  it("snapshots rich content without copying source attachments or an earlier reply", () => {
    const item: ChatDisplayItem = { id: 21, role: "user", text: "继续分析", replyTo: reply,
      attachments: [{ id: "image", name: "扩展状态.png", kind: "image", mimeType: "image/png", size: 42, url: "/api/uploads/image" }] };
    expect(messageReply(item, messageQuote(item).text)).toEqual({ messageId: 21, role: "user", text: "扩展状态.png\n\n继续分析" });
    expect(messageReply({ ...item, role: "system_note" }, "状态")).toBeUndefined();
    expect(messageReply(item, "  ")).toBeUndefined();
    expect(messageReply(item, "长".repeat(9000))?.text).toHaveLength(8000);
  });

  it("renders a short reference separately from the editable response and sent body", () => {
    const longReply = { ...reply, text: "原消息正文\n".repeat(100) };
    const html = renderToStaticMarkup(<KuloComposer draftText="只填写我的回复" onDraftTextChange={vi.fn()} attachments={[]}
      onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()} connected placeholder="输入消息"
      replyTo={longReply} onCancelReply={vi.fn()} />);
    expect(html).toContain('aria-label="回复引用"');
    expect(html).toContain('aria-label="取消回复"');
    expect(html).toContain("只填写我的回复</textarea>");
    expect(html).not.toContain(longReply.text);
    expect(replyPreview(longReply)).toHaveLength(181);
    const sent = renderToStaticMarkup(<MessageContent item={{ id: 22, role: "user", text: "只填写我的回复", replyTo: longReply }} />);
    expect(sent).toContain('data-source-message-id="12"');
    expect(sent.indexOf('aria-label="回复引用"')).toBeLessThan(sent.indexOf("只填写我的回复"));
    expect(sent).not.toContain(longReply.text);
  });

  it("clears only the submitted reply, preserving another topic and a newly selected reply", () => {
    const other = { ...reply, messageId: 13 };
    expect(consumeReplyDraft({ "topic:root": reply, "topic:other": other }, "topic:root", reply)).toEqual({ "topic:other": other });
    const changed = { "topic:root": other };
    expect(consumeReplyDraft(changed, "topic:root", reply)).toBe(changed);
    expect(consumeReplyDraft(changed, "topic:root", undefined)).toBe(changed);
  });

  it("restores a failed reply in its own draft without overwriting a new reply", () => {
    expect(restoreReplyDraft({}, "ticket:one", reply)).toEqual({ "ticket:one": reply });
    const current = { "topic:root": { ...reply, messageId: 13 } };
    expect(restoreReplyDraft(current, "topic:root", reply)).toBe(current);
    expect(restoreReplyDraft(current, "topic:root", undefined)).toBe(current);
  });

  it("preserves queued reply metadata after reload and into the local conversation", () => {
    const record: ReliableOutboxRecord = { id: "reply-send", scope: "hub", sequence: 1, createdAt: 100,
      envelope: { type: "chat.send", topicId: "root", requestId: "reply-send", content: "只填写我的回复", replyTo: reply },
      state: "queued", attempt: 0, nextAttemptAt: 0 };
    const restored = outboxSubmissions(JSON.parse(JSON.stringify([record])));
    const view = mergeChatSubmissions([], restored, "root");
    expect(view[0]).toMatchObject({ text: "只填写我的回复", replyTo: reply });
    expect(view[0]?.attachments).toBeUndefined();
    expect(mergeChatSubmissions([], restored, "other")).toEqual([]);
  });
});
