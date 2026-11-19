import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatDisplayItem } from "@kulo/protocol";
import { ConnectedMessageContent } from "./connected-message-content";
import { DispatchMessageGroup } from "./dispatch-message-group";
import { dispatchGroupActionItem, groupDispatchReplies, matchingLiveDispatchGroupKey, type DispatchReplyGroup } from "./dispatch-groups";
import { messageQuote } from "./message-actions";
import { mergeResponseMessages } from "./response-messages";

const dispatchedAt = new Date(2026, 10, 17, 1, 12).getTime();
const dispatch = (id: number): ChatDisplayItem => ({ id, role: "dispatch", text: `任务 ${id}`, createdAt: dispatchedAt,
  dispatch: { actionLabel: "派发任务", ticketId: `task-${id}`, title: `任务 ${id}`, userSummary: "生成 HTML 页面" } });
const reply = (id: number, text = "已安排开发者执行，完成后通知你。"): ChatDisplayItem => ({ id, role: "assistant", text, createdAt: dispatchedAt + 60_000 });
afterEach(() => vi.useRealTimers());

describe("dispatch reply grouping", () => {
  it("keeps consecutive dispatches ahead of their acknowledgement with one stable group", () => {
    const first = dispatch(2);
    const second = dispatch(3);
    const acknowledgement = reply(4);
    const user: ChatDisplayItem = { id: 1, role: "user", text: "生成页面" };
    expect(groupDispatchReplies([user, first, second, acknowledgement])).toEqual([
      { type: "message", item: user },
      { type: "dispatch-group", key: "dispatch:2", dispatches: [first, second], replies: [acknowledgement] },
    ]);
    expect(groupDispatchReplies([first])[0]).toMatchObject({ key: "dispatch:2", dispatches: [first], replies: [] });
  });

  it.each(["user", "relay", "system_note"] as const)("does not consume a reply across a %s boundary", (role) => {
    const boundary: ChatDisplayItem = { id: 3, role, text: "边界" };
    const next = reply(4);
    expect(groupDispatchReplies([dispatch(2), boundary, next])).toEqual([
      { type: "dispatch-group", key: "dispatch:2", dispatches: [dispatch(2)], replies: [] },
      { type: "message", item: boundary },
      { type: "message", item: next },
    ]);
  });

  it("preserves earlier spoken text and starts a new group for a later dispatch", () => {
    const before = reply(1, "我来安排任务。");
    const entries = groupDispatchReplies([before, dispatch(2), reply(3), dispatch(4), reply(5)]);
    expect(entries.map((entry) => entry.type)).toEqual(["message", "dispatch-group", "dispatch-group"]);
    expect(entries[0]).toEqual({ type: "message", item: before });
    expect(entries[1]).toMatchObject({ dispatches: [dispatch(2)], replies: [reply(3)] });
    expect(entries[2]).toMatchObject({ dispatches: [dispatch(4)], replies: [reply(5)] });
  });

  it("keeps rich acknowledgement content in the group copy and quote payload", () => {
    const acknowledgement = reply(3);
    acknowledgement.parts = [{ partId: "text", type: "markdown", text: "请参考页面" },
      { partId: "code", type: "code", code: "const result = 1;", language: "js" }];
    const group = groupDispatchReplies([dispatch(2), acknowledgement, reply(4, "完成后通知你。")])[0] as DispatchReplyGroup;
    const actionItem = dispatchGroupActionItem(group);
    expect(messageQuote(actionItem).text).toBe("请参考页面\n\n```js\nconst result = 1;\n```\n\n完成后通知你。");
    expect(actionItem.id).toBe(4);
    expect(actionItem.createdAt).toBe(dispatchedAt + 60_000);
  });

  it("uses dispatch metadata when there is no acknowledgement yet and preserves unknown times", () => {
    const group = groupDispatchReplies([dispatch(2), dispatch(3)])[0] as DispatchReplyGroup;
    expect(messageQuote(dispatchGroupActionItem(group)).text).toBe("派发任务\n任务 2\n生成 HTML 页面\n\n派发任务\n任务 3\n生成 HTML 页面");
    expect(dispatchGroupActionItem(group).createdAt).toBe(dispatchedAt);
    delete group.dispatches[0]!.createdAt;
    delete group.dispatches[1]!.createdAt;
    expect(dispatchGroupActionItem(group).createdAt).toBeUndefined();
  });

  it("keeps an independent notification between a dispatched attachment and the remaining reply", () => {
    const asset: ChatAttachment = { id: "file", name: "result.txt", kind: "file", mimeType: "text/plain", size: 10, url: "/api/uploads/file" };
    const publication: ChatDisplayItem = { ...reply(3, "附件说明"), responseId: 10, parts: [{ partId: "file", type: "file", assetId: asset.id, asset, caption: "附件说明" }] };
    const notification = reply(4, "独立任务已完成");
    const continuation = { ...reply(5, "正文结论"), responseId: 10 };
    const entries = groupDispatchReplies(mergeResponseMessages([{ ...dispatch(2), responseId: 10 }, publication, notification, continuation]));
    expect(entries).toEqual([
      { type: "dispatch-group", key: "dispatch:2", dispatches: [{ ...dispatch(2), responseId: 10 }], replies: [publication] },
      { type: "message", item: notification },
      { type: "message", item: continuation },
    ]);
    const html = renderToStaticMarkup(<>{entries.map((entry) => entry.type === "message"
      ? <ConnectedMessageContent key={entry.item.id} item={entry.item} onReply={() => {}} />
      : <DispatchMessageGroup key={entry.key} group={entry} onReply={() => {}} renderMessage={(item) => item.role === "dispatch" ? <article key={item.id}>{item.text}</article>
        : <ConnectedMessageContent key={item.id} item={item} contentOnly />} />)}</>);
    expect(html.match(/<time\b/g)).toHaveLength(3);
    expect(html.match(/aria-label="复制消息"/g)).toHaveLength(3);
    expect(html.match(/aria-label="回复消息"/g)).toHaveLength(3);
    expect(messageQuote(dispatchGroupActionItem(entries[0] as DispatchReplyGroup)).text).toBe("附件说明");
  });

  it("does not consume the next response after a dispatched acknowledgement", () => {
    const acknowledgement = { ...reply(3), responseId: 10 };
    const nextResponse = { ...reply(4, "另一次回复"), responseId: 20 };
    const entries = groupDispatchReplies(mergeResponseMessages([{ ...dispatch(2), responseId: 10 }, acknowledgement, nextResponse]));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "dispatch-group", replies: [acknowledgement] });
    expect(entries[1]).toEqual({ type: "message", item: nextResponse });
    expect(messageQuote(dispatchGroupActionItem(entries[0] as DispatchReplyGroup)).text).not.toContain("另一次回复");
  });

  it("lets a legacy dispatch adopt its first reply's response identity and then enforces it", () => {
    const acknowledgement = { ...reply(3), responseId: 10 };
    const notification = reply(4, "独立通知");
    const entries = groupDispatchReplies([dispatch(2), acknowledgement, notification]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "dispatch-group", replies: [acknowledgement] });
    expect(entries[1]).toEqual({ type: "message", item: notification });
  });

  it("separates dispatches with different or missing response identities", () => {
    for (const nextResponseId of [20, undefined]) {
      const first = { ...dispatch(2), responseId: 10 };
      const second = { ...dispatch(3), responseId: nextResponseId };
      const entries = groupDispatchReplies([first, second]);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ dispatches: [first] });
      expect(entries[1]).toMatchObject({ dispatches: [second] });
    }
  });
});

describe("dispatch live response boundaries", () => {
  it.each([
    [10, 10, true],
    [10, 20, false],
    [10, undefined, false],
    [undefined, 20, false],
    [undefined, undefined, true],
  ] as const)("matches dispatch response %s with live response %s only when their identities agree", (responseId, liveResponseId, matches) => {
    const group = groupDispatchReplies([{ ...dispatch(2), responseId }])[0]!;
    const key = matchingLiveDispatchGroupKey(group, { busy: true, responseId: liveResponseId });
    expect(key).toBe(matches ? "dispatch:2" : undefined);
    expect(matchingLiveDispatchGroupKey(group, { busy: false, responseId: liveResponseId })).toBeUndefined();
  });

  it("does not attach a new hidden input's live reply to an older legacy dispatch", () => {
    const group = groupDispatchReplies([dispatch(2), { ...reply(3), responseId: 10 }])[0]!;
    expect(matchingLiveDispatchGroupKey(group, { busy: true, responseId: 10 })).toBe("dispatch:2");
    expect(matchingLiveDispatchGroupKey(group, { busy: true, responseId: 20 })).toBeUndefined();
    expect(matchingLiveDispatchGroupKey(group, { busy: true })).toBeUndefined();
    expect(matchingLiveDispatchGroupKey({ type: "message", item: reply(4) }, { busy: true, responseId: 20 })).toBeUndefined();
  });
});

describe("dispatch group footer", () => {
  it.each([false, true])("renders cards then acknowledgement then one shared footer (acknowledgement=%s)", (withReply) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 12));
    const items = [dispatch(2), dispatch(3), ...(withReply ? [reply(4)] : [])];
    const group = groupDispatchReplies(items)[0] as DispatchReplyGroup;
    const html = renderToStaticMarkup(<DispatchMessageGroup group={group} onReply={() => {}}
      renderMessage={(item) => item.role === "dispatch" ? <article key={item.id}>{item.text}</article>
        : <ConnectedMessageContent key={item.id} item={item} contentOnly />} />);
    expect(html.match(/<time\b/g)).toHaveLength(1);
    expect(html.match(/aria-label="复制消息"/g)).toHaveLength(1);
    expect(html.match(/aria-label="回复消息"/g)).toHaveLength(1);
    expect(html.indexOf("任务 2")).toBeLessThan(html.indexOf("任务 3"));
    expect(html.indexOf("任务 3")).toBeLessThan(html.indexOf("kulo-message-footer"));
    if (withReply) {
      expect(html.indexOf("任务 3")).toBeLessThan(html.indexOf("已安排开发者执行"));
      expect(html.indexOf("已安排开发者执行")).toBeLessThan(html.indexOf("kulo-message-footer"));
      expect(html).toContain(">01:13</time>");
    } else expect(html).toContain(">01:12</time>");
  });

  it("lets a content-only rich message omit its own actions and timestamp", () => {
    const html = renderToStaticMarkup(<ConnectedMessageContent item={reply(3)} onReply={() => {}} contentOnly />);
    expect(html).toContain("已安排开发者执行");
    expect(html).not.toContain("kulo-message-footer");
    expect(html).not.toContain("<time");
    expect(html).not.toContain('aria-label="复制消息"');
  });

  it("keeps an in-progress acknowledgement below the cards without a premature footer", () => {
    const group = groupDispatchReplies([dispatch(2)])[0] as DispatchReplyGroup;
    const html = renderToStaticMarkup(<DispatchMessageGroup group={group} onReply={() => {}}
      renderMessage={(item) => <article key={item.id}>{item.text}</article>}
      trailingContent={<p>正在流式确认</p>} />);
    expect(html.indexOf("任务 2")).toBeLessThan(html.indexOf("正在流式确认"));
    expect(html).not.toContain("kulo-message-footer");
    expect(html).not.toContain("<time");
  });
});
