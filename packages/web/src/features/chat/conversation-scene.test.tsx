import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationScene, RecommendedTasks, shouldCenterConversation } from "./conversation-scene";
import { composerPlaceholder } from "../../moco-composer";

describe("conversation initial presentation", () => {
  it("waits for the selected conversation instead of flashing the intro over history", () => {
    expect(shouldCenterConversation({ empty: true, ready: false, sameConversation: false, wasCentered: true })).toBe(false);
    expect(shouldCenterConversation({ empty: true, ready: true, sameConversation: false, wasCentered: false })).toBe(true);
    expect(shouldCenterConversation({ empty: false, ready: true, sameConversation: true, wasCentered: true })).toBe(false);
  });

  it("keeps a draft centered through server topic creation without applying that state to another topic", () => {
    expect(shouldCenterConversation({ empty: true, ready: false, sameConversation: true, wasCentered: true })).toBe(true);
    expect(shouldCenterConversation({ empty: true, ready: false, sameConversation: false, wasCentered: true })).toBe(false);
  });

  it("renders one composer and a concise welcome only for a ready empty conversation", () => {
    const scene = (empty: boolean, ready: boolean) => renderToStaticMarkup(<ConversationScene conversationKey="topic-one" empty={empty} ready={ready} transcript={<div>消息区域</div>}
      composer={<textarea aria-label="对话输入" defaultValue="草稿" />} onChooseRecommendation={() => {}} />);
    const empty = scene(true, true);
    expect(empty).toContain("今天想一起做点什么？");
    expect(empty.match(/<textarea\b/g)).toHaveLength(1);
    expect(empty).not.toContain("推荐任务");
    expect(empty).not.toContain("查看当前在线节点");
    expect(scene(true, false)).not.toContain("今天想一起做点什么？");
    expect(scene(false, true)).not.toContain("今天想一起做点什么？");
  });

  it("keeps the future recommendation surface absent until actual tasks are supplied", () => {
    expect(renderToStaticMarkup(<RecommendedTasks onChoose={() => {}} />)).toBe("");
    const html = renderToStaticMarkup(<RecommendedTasks tasks={[{ id: "one", title: "整理需求", prompt: "把当前需求整理成待办" }]} onChoose={() => {}} />);
    expect(html).toContain("整理需求");
    expect(html).not.toContain("把当前需求整理成待办");
    expect(composerPlaceholder()).toBe("描述你的想法，提出你的问题···");
  });
});
