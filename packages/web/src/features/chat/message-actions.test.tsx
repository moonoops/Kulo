import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions, messageQuote } from "./message-actions";
import { ConnectedMessageContent } from "./connected-message-content";
import type { ChatAttachment, ChatDisplayItem } from "@kulo/protocol";

const asset: ChatAttachment = { id: "photo", name: "参考图.png", mimeType: "image/png", size: 64, kind: "image", url: "/api/uploads/photo" };
const voiceState = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../voice/voice-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("../voice/voice-context")>(),
  useVoiceWorkspace: () => voiceState.current,
}));
afterEach(() => { vi.useRealTimers(); voiceState.current = null; });

describe("message footer action sizing", () => {
  function actionButtons(html: string) {
    return (html.match(/<button\b[^>]*>/g) ?? []).filter((button) => /aria-label="(?:复制消息|回复消息|朗读消息|取消朗读|停止朗读)"/.test(button));
  }

  function expectCaptionActions(buttons: string[], count: number) {
    expect(buttons).toHaveLength(count);
    for (const button of buttons) {
      expect(button.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/)).toContain("kulo-message-action");
    }
  }

  it.each(["user", "assistant", "dispatch"] as const)("gives copy and reply %s actions the same explicit footer role", (role) => {
    const item: ChatDisplayItem = { id: 10, role, text: "检查消息页脚", createdAt: 1_794_873_600_000 };
    const html = renderToStaticMarkup(<MessageActions item={item} onReply={() => {}}><p>{item.text}</p></MessageActions>);
    expectCaptionActions(actionButtons(html), 2);
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toMatch(/<svg\b[^>]*width="12"[^>]*height="12"/);
  });

  it.each(["idle", "loading", "playing", "error"] as const)("keeps read-aloud's %s state at the same footer size", (phase) => {
    const item: ChatDisplayItem = { id: 11, role: "assistant", text: "检查朗读操作" };
    voiceState.current = {
      connected: true, snapshot: { tts: { enabled: true } }, call: { active: false },
      speech: phase === "idle" ? null : { key: `assistant:11:${item.text}`, phase },
    };
    const html = renderToStaticMarkup(<MessageActions item={item} onReply={() => {}}><p>{item.text}</p></MessageActions>);
    expectCaptionActions(actionButtons(html), 3);
    expect(html).toContain("kulo-message-action-icon");
  });
});

describe("quoting a rich message", () => {
  it("preserves ordered text and complete source code while keeping repeated image references unique", () => {
    const item: ChatDisplayItem = { id: 4, role: "assistant", text: "legacy duplicate", parts: [
      { partId: "text", type: "markdown", text: "请参考" },
      { partId: "image", type: "image", assetId: asset.id, asset },
      { partId: "code", type: "code", code: "const n = 42;", language: "ts" },
      { partId: "image-again", type: "image", assetId: asset.id, asset },
    ] };
    const quote = messageQuote(item);
    expect(quote.text).toBe("请参考\n\n参考图.png\n\n```ts\nconst n = 42;\n```\n\n参考图.png");
    expect(quote.attachments).toEqual([asset]);
    expect(quote.text).not.toContain("legacy duplicate");
  });

  it("supports the original user attachment format and renders accessible actions without nested buttons", () => {
    const item: ChatDisplayItem = { id: 1, role: "user", text: "分析这张图", attachments: [asset] };
    expect(messageQuote(item).text).toBe("参考图.png\n\n分析这张图");
    const html = renderToStaticMarkup(<MessageActions item={item} onReply={() => {}}><p>分析这张图</p></MessageActions>);
    expect(html).toContain('aria-label="复制消息"');
    expect(html).toContain('aria-label="回复消息"');
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g) ?? []) expect(button.match(/<button\b/g)).toHaveLength(1);
  });
});

describe("message timestamp rendering", () => {
  it.each(["user", "assistant"] as const)("renders one local timestamp for %s messages", (role) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 12));
    const item: ChatDisplayItem = { id: 5, role, text: "有发送时间的消息", createdAt: new Date(2026, 10, 17, 9, 5).getTime() };
    const html = renderToStaticMarkup(<ConnectedMessageContent item={item} />);
    expect(html.match(/<time\b/g)).toHaveLength(1);
    expect(html).toContain(">09:05</time>");
    expect(html).toContain(`data-role="${role}"`);
    expect(html).toContain('title="2026-11-17 09:05:00 UTC');
    expect(html).toContain('aria-label="复制消息"');
  });

  it("keeps attachments and generated cards in one message with one timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 12));
    const item: ChatDisplayItem = { id: 6, role: "assistant", text: "", createdAt: new Date(2026, 10, 16, 9, 5).getTime(), parts: [
      { partId: "text", type: "markdown", text: "参考结果" },
      { partId: "image", type: "image", assetId: asset.id, asset },
      { partId: "card", type: "ui", cardId: "unresolved-card", fallbackText: "交互卡片结果" },
    ] };
    const html = renderToStaticMarkup(<ConnectedMessageContent item={item} />);
    expect(html.match(/<time\b/g)).toHaveLength(1);
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toContain(">11-16 09:05</time>");
    expect(html).toContain("交互卡片结果");
    expect(messageQuote(item).text).not.toContain("09:05");
  });

  it("omits unknown timestamps and leaves system notes without chat timestamps", () => {
    for (const item of [
      { id: 7, role: "assistant" as const, text: "旧消息" },
      { id: 8, role: "user" as const, text: "无效时间", createdAt: Number.NaN },
      { id: 9, role: "system_note" as const, text: "状态", createdAt: Date.now() },
    ]) {
      expect(renderToStaticMarkup(<ConnectedMessageContent item={item} />)).not.toContain("<time");
    }
  });
});
