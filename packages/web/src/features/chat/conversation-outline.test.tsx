import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatDisplayItem } from "@kulo/protocol";
import { activeConversationTurn, buildConversationTurns, conversationTurnId } from "./conversation-outline-model";
import { ConversationOutline } from "./conversation-outline";

describe("conversation turn outline", () => {
  it("indexes visible user turns, skipping internal traffic and empty assistant output", () => {
    const messages: ChatDisplayItem[] = [
      { id: 1, role: "assistant", text: "开场消息" },
      { id: 2, role: "user", text: "# 设计优化方案\n保持简洁" },
      { id: 3, role: "user", text: "[KULO_WORKER_RELAY] internal" },
      { id: 4, role: "relay", text: "internal" },
      { id: 5, role: "assistant", text: "", thinking: "内部思考" },
      { id: 6, role: "assistant", text: "建议使用 **分段导航**，支持[点击跳转](https://example.com)。" },
      { id: 7, role: "system_note", text: "已保存" },
      { id: 8, role: "user", text: "接下来添加动画" },
      { id: 9, role: "user", text: "[KULO_WORKER_WATCHDOG] internal" },
    ];
    expect(buildConversationTurns(messages)).toEqual([
      { id: 2, label: "设计优化方案 保持简洁", preview: "建议使用 分段导航，支持点击跳转。" },
      { id: 8, label: "接下来添加动画", preview: "" },
    ]);
  });

  it("includes attachment-only turns and uses structured content instead of legacy fallback text", () => {
    const messages: ChatDisplayItem[] = [
      { id: 10, role: "user", text: "", attachments: [{ id: "image", name: "参考图.png", kind: "image", mimeType: "image/png", size: 1, url: "/api/uploads/image" }] },
      { id: 11, role: "assistant", text: "旧版回退文本", parts: [{ partId: "answer", type: "markdown", text: "已经分析这张图" }] },
      { id: 12, role: "user", text: "", parts: [{ partId: "voice", type: "audio", assetId: "voice" }] },
    ];
    expect(buildConversationTurns(messages)).toEqual([
      { id: 10, label: "参考图.png", preview: "已经分析这张图" },
      { id: 12, label: "语音", preview: "" },
    ]);
  });

  it("retains message anchors when history is prepended and bounds large previews", () => {
    const latest: ChatDisplayItem[] = [
      { id: 100, role: "user", text: "问题".repeat(100) },
      { id: 101, role: "assistant", text: "回复".repeat(300) },
    ];
    const original = buildConversationTurns(latest)[0]!;
    const prepended = buildConversationTurns([{ id: 1, role: "user", text: "更早的消息" }, ...latest]);
    expect(prepended[1]).toEqual(original);
    expect(original.label).toHaveLength(65);
    expect(original.preview).toHaveLength(181);
    expect(conversationTurnId("topic/a", original.id)).toBe(conversationTurnId("topic/a", prepended[1]!.id));
    expect(conversationTurnId("topic/a", original.id)).not.toBe(conversationTurnId("topic/b", original.id));
  });

  it("tracks the reading position and selects the last short turn at the bottom", () => {
    const anchors = [{ id: 2, top: 20 }, { id: 8, top: 500 }, { id: 12, top: 1300 }];
    expect(activeConversationTurn(anchors, 0, 600, 1500)).toBe(2);
    expect(activeConversationTurn(anchors, 450, 600, 1500)).toBe(2);
    expect(activeConversationTurn(anchors, 476, 600, 1500)).toBe(8);
    expect(activeConversationTurn(anchors, 898.5, 600, 1500)).toBe(12);
    expect(activeConversationTurn([], 0, 600, 600)).toBeUndefined();
  });

  it("starts hidden with scoped targets and no Tab stop, and omits empty or single-turn outlines", () => {
    const turns = buildConversationTurns([
      { id: 2, role: "user", text: "第一问" },
      { id: 8, role: "user", text: "第二问" },
    ]);
    const render = (items = turns) => renderToStaticMarkup(<ConversationOutline turns={items} topicId="topic/a" scrollRef={createRef()} onNavigate={() => {}} />);
    const html = render();
    expect(html).toContain('aria-label="对话分段"');
    expect(html).toContain('aria-label="第 1 段：第一问"');
    expect(html).toContain('aria-controls="kulo-chat-turn-topic%2Fa-2"');
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).not.toContain('tabindex="0"');
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(render([])).toBe("");
    expect(render(turns.slice(0, 1))).toBe("");
  });
});
