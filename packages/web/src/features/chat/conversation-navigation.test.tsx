import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationFilesButton, SearchExcerpt } from "./conversation-library";
import { mergeLocatedMessages, searchExcerptParts, visibleMessageId } from "./conversation-navigation";
import { mergeResponseMessages } from "./response-messages";
import type { ChatDisplayItem } from "@kulo/protocol";

describe("conversation navigation", () => {
  it("renders conversation files trigger as an icon-only ghost toolbar control", () => {
    const html = renderToStaticMarkup(<ConversationFilesButton topicId="topic-1" revision="0:0" onNavigate={() => {}} />);
    expect(html).toContain('aria-label="本次文件"');
    expect(html).toContain("button--ghost");
    expect(html).toContain("button--icon-only");
    expect(html).toContain("kulo-window-control");
    expect(html).not.toContain(">本次文件<");
  });
  it("locates a durable publication or legacy dispatch reference inside a coalesced assistant response", () => {
    const source: ChatDisplayItem[] = [
      { id: 1, role: "user", text: "问题" },
      { id: 2, role: "dispatch", text: "后台任务", responseId: 7, dispatch: { actionLabel: "派发任务", ticketId: "T-7", title: "后台任务" } },
      { id: 3, role: "assistant", text: "结论", responseId: 7 },
      { id: 4, role: "assistant", text: "文档", responseId: 7 },
      { id: 5, role: "dispatch", text: "静默推进", responseId: 8, dispatch: { actionLabel: "推进任务", ticketId: "T-8", title: "静默推进" } },
    ];
    const displayed = mergeResponseMessages(source);
    expect(visibleMessageId(source, displayed, 4)).toBe(3);
    expect(visibleMessageId(source, displayed, 2)).toBe(3);
    expect(visibleMessageId(source, displayed, 5)).toBeUndefined();
    expect(visibleMessageId(source, displayed, 1)).toBe(1);
    expect(visibleMessageId(source, displayed, 999)).toBeUndefined();
  });
  it("merges earlier pages in order and retains refreshed current records", () => {
    const old: ChatDisplayItem = { id: 5, role: "assistant", text: "old" };
    expect(mergeLocatedMessages([{ id: 3, role: "user", text: "previous" }, old], [{ ...old, text: "current" }])).toEqual([{ id: 3, role: "user", text: "previous" }, { ...old, text: "current" }]);
  });
  it("highlights literal Chinese and case-insensitive text without interpreting regex or HTML", () => {
    expect(searchExcerptParts("正文灯光，灯光方案", "灯光").filter((part) => part.match)).toHaveLength(2);
    expect(searchExcerptParts("A+B a+b", "a+b").filter((part) => part.match)).toHaveLength(2);
    const html = renderToStaticMarkup(<SearchExcerpt text="<script>Light</script>" query="LIGHT" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain('class="kulo-conversation-search-match">Light</mark>');
    expect(searchExcerptParts("text", "  ")).toEqual([{ text: "text", match: false }]);
  });
});
