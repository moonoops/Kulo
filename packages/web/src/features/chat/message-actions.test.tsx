import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractValidMessageSelection, MessageActions, messageQuote } from "./message-actions";
import { CodeBlock } from "./code-block";
import { ConnectedMessageContent } from "./connected-message-content";
import { messageReply } from "./reply-reference";
import type { ChatAttachment, ChatDisplayItem } from "@kulo/protocol";

const asset: ChatAttachment = { id: "photo", name: "参考图.png", mimeType: "image/png", size: 64, kind: "image", url: "/api/uploads/photo" };
const voiceState = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../voice/voice-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("../voice/voice-context")>(),
  useVoiceWorkspace: () => voiceState.current,
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); voiceState.current = null; });

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

describe("excerpt and code block quoting (#7)", () => {
  it("renders a quote action button on code blocks when MessageActions supports replies and omits it otherwise", () => {
    const item: ChatDisplayItem = { id: 12, role: "assistant", text: "代码片段" };
    const withReply = renderToStaticMarkup(
      <MessageActions item={item} onReply={() => {}}>
        <CodeBlock code="const x = 1;" language="ts" />
      </MessageActions>,
    );
    expect(withReply).toContain('aria-label="引用此代码块"');

    const withoutReply = renderToStaticMarkup(
      <MessageActions item={item}>
        <CodeBlock code="const x = 1;" language="ts" />
      </MessageActions>,
    );
    expect(withoutReply).not.toContain('aria-label="引用此代码块"');
  });

  it("sets excerpt: true only for snippet quotes and omits excerpt key for whole-message replies", () => {
    const item: ChatDisplayItem = { id: 15, role: "assistant", text: "完整正文" };
    const fullReply = messageReply(item, "完整正文");
    expect(fullReply).toEqual({ messageId: 15, role: "assistant", text: "完整正文" });
    expect("excerpt" in fullReply!).toBe(false);

    const excerptReply = messageReply(item, "正文片段", { excerpt: true });
    expect(excerptReply).toEqual({ messageId: 15, role: "assistant", text: "正文片段", excerpt: true });
  });
});

describe("selection quote bar positioning", () => {
  type RectLike = { top: number; bottom: number; left: number; right: number; width: number; height: number };
  interface MockNode {
    nodeType: number;
    isConnected: boolean;
    parentElement: MockNode | null;
    contains(target: unknown): boolean;
    closest(selector: string): MockNode | null;
    getBoundingClientRect(): RectLike;
    __classes: Set<string>;
    __overflow: string;
  }
  function rect(left: number, top: number, width: number, height: number): RectLike {
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function mockNode(options: {
    classes?: string[];
    parent?: MockNode | null;
    clipRect?: RectLike;
    overflow?: string;
    connected?: boolean;
  } = {}): MockNode {
    const classSet = new Set(options.classes ?? []);
    const node: MockNode = {
      nodeType: 1,
      isConnected: options.connected ?? true,
      parentElement: options.parent ?? null,
      contains(target: unknown): boolean {
        let cur: { parentElement?: unknown } | null = target as { parentElement?: unknown } | null;
        while (cur) {
          if (cur === node) return true;
          cur = (cur.parentElement as { parentElement?: unknown } | null) ?? null;
        }
        return false;
      },
      closest(selector: string): MockNode | null {
        const parts = selector.split(",").map((s) => s.trim());
        let cur: MockNode | null = node;
        while (cur) {
          for (const part of parts) {
            if (part.startsWith(".") && cur.__classes.has(part.slice(1))) return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
      getBoundingClientRect: () => options.clipRect ?? rect(0, 0, 0, 0),
      __classes: classSet,
      __overflow: options.overflow ?? "visible",
    };
    return node;
  }

  function stubSelection(options: {
    text: string;
    anchorNode: MockNode;
    focusNode?: MockNode;
    clientRects?: RectLike[];
    boundingRect?: RectLike;
    innerWidth?: number;
    innerHeight?: number;
  }) {
    const focus = options.focusNode ?? options.anchorNode;
    const range = {
      commonAncestorContainer: options.anchorNode,
      startContainer: options.anchorNode,
      endContainer: focus,
      cloneContents: () => ({ querySelector: () => null }),
      getClientRects: () => options.clientRects ?? [],
      getBoundingClientRect: () => options.boundingRect ?? rect(0, 0, 0, 0),
    };
    vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
    vi.stubGlobal("window", {
      innerWidth: options.innerWidth ?? 1280,
      innerHeight: options.innerHeight ?? 800,
      getSelection: () => ({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: options.anchorNode,
        focusNode: focus,
        getRangeAt: () => range,
        toString: () => options.text,
      }),
      getComputedStyle: (el: { __overflow?: string }) => ({
        overflow: el.__overflow ?? "visible",
        overflowX: el.__overflow ?? "visible",
        overflowY: el.__overflow ?? "visible",
      }),
    });
  }

  it("anchors above the top-most visible line's client rects and flips below near the top edge", () => {
    const root = mockNode({ classes: ["kulo-message-with-actions"] });
    const textLayer = mockNode({ classes: ["kulo-pdf-text-layer"], parent: root });

    // Multi-line selection where line 1 is on the left (100..260) and line 2 spans further right (100..520)
    stubSelection({
      text: "DA600 系列产品介绍",
      anchorNode: textLayer,
      clientRects: [rect(100, 200, 160, 20), rect(100, 224, 420, 20)],
      boundingRect: rect(100, 200, 420, 44),
    });
    expect(extractValidMessageSelection(root as unknown as HTMLElement)).toEqual({
      text: "DA600 系列产品介绍",
      left: 180,
      top: 192,
      placement: "above",
    });

    // Near the top edge of viewport (< 48px), flips below the selected text
    stubSelection({
      text: "顶部首行",
      anchorNode: textLayer,
      clientRects: [rect(120, 20, 100, 18)],
      boundingRect: rect(120, 20, 100, 18),
    });
    expect(extractValidMessageSelection(root as unknown as HTMLElement)).toEqual({
      text: "顶部首行",
      left: 170,
      top: 46,
      placement: "below",
    });
  });

  it("clips against scroll ancestors and suppresses off-screen selections", () => {
    const root = mockNode({ classes: ["kulo-message-with-actions"] });
    const scroller = mockNode({
      classes: ["kulo-artifact-live-preview"],
      parent: root,
      overflow: "auto",
      clipRect: rect(40, 140, 500, 400),
    });
    const textLayer = mockNode({ classes: ["kulo-pdf-text-layer"], parent: scroller });

    // Completely scrolled above the preview box
    stubSelection({
      text: "不可见行",
      anchorNode: textLayer,
      clientRects: [rect(80, 90, 200, 20)],
      boundingRect: rect(80, 90, 200, 20),
    });
    expect(extractValidMessageSelection(root as unknown as HTMLElement)).toBeNull();

    // Partially clipped horizontally on the right edge of the scroll container
    stubSelection({
      text: "横向可见部分",
      anchorNode: textLayer,
      clientRects: [rect(440, 220, 200, 20)],
      boundingRect: rect(440, 220, 200, 20),
    });
    expect(extractValidMessageSelection(root as unknown as HTMLElement)).toEqual({
      text: "横向可见部分",
      left: 490,
      top: 212,
      placement: "above",
    });
  });

  it.each([
    "kulo-artifact-header",
    "kulo-artifact-compact-row",
    "kulo-artifact-collapsed",
    "kulo-pdf-toolbar",
    "kulo-pptx-toolbar",
    "kulo-xlsx-bar",
  ])("ignores selections inside file preview chrome .%s", (chromeClass) => {
    const root = mockNode({ classes: ["kulo-message-with-actions"] });
    const chrome = mockNode({ classes: [chromeClass], parent: root });
    stubSelection({
      text: "第 1 页 / 共 16 页",
      anchorNode: chrome,
      clientRects: [rect(100, 100, 120, 20)],
      boundingRect: rect(100, 100, 120, 20),
    });
    expect(extractValidMessageSelection(root as unknown as HTMLElement)).toBeNull();
  });
});
