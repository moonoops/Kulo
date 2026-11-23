import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment, MessagePart } from "@kulo/protocol";
import { KuloMarkdown, markdownUrlTransform } from "../../kulo-markdown";
import { AssetImage, AssetImageGallery, resolveImageThumbUrl, safeContentUrl } from "./asset-preview";
import { CodeBlock } from "./code-block";
import { MessageContent, groupMessageParts, stableUserParts } from "./message-content";
import { ConnectedMessageContent } from "./connected-message-content";
import { MediaMessage, pauseOtherMedia, registerMedia } from "./media-message";

const image: ChatAttachment = { id: "image", name: "会议草图.png", kind: "image", mimeType: "image/png", size: 1000, url: "/api/uploads/image", width: 800, height: 600 };
const audio: ChatAttachment = { id: "audio", name: "访谈.wav", kind: "audio", mimeType: "audio/wav", size: 24000, url: "/api/uploads/audio", duration: 92 };

describe("chat rich content", () => {
  it("only renders the native invitation action for a connected assistant publication", () => {
    const part: MessagePart = { type: "device-invitation", partId: "invite-card", hubId: "original-id", hubName: "书房" };
    const item = { id: 1, text: "", parts: [part] };
    const assistant = renderToStaticMarkup(<ConnectedMessageContent item={{ ...item, role: "assistant" }} contentOnly />);
    expect(assistant).toContain("复制接入指令");
    expect(assistant).toContain("<button");
    expect(assistant).not.toContain("original-id");
    const user = renderToStaticMarkup(<ConnectedMessageContent item={{ ...item, role: "user" }} contentOnly />);
    expect(user).not.toContain("<button");
    const offline = renderToStaticMarkup(<ConnectedMessageContent item={{ ...item, role: "assistant" }} connected={false} contentOnly />);
    expect(offline).toContain("连接主脑后可复制接入指令");
    expect(offline).not.toContain("<button");
  });

  it("renders GFM tables, ordered lists, checklists and incomplete code fences", () => {
    const html = renderToStaticMarkup(<KuloMarkdown text={'## 检查\n\n1. **重点**\n2. ~~取消~~\n\n- [x] 完成\n\n| 名称 | 状态 |\n| --- | --- |\n| 图片 | 就绪 |\n\n```tsx\nconst view = <span>你好</span>;'} />);
    expect(html).toContain("<h2>检查</h2>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<del>取消</del>");
    expect(html).toContain('aria-label="已完成"');
    expect(html).toContain('class="kulo-chat-table"');
    expect(html).toContain('class="kulo-chat-code"');
    expect(html).toContain("&lt;span&gt;你好&lt;/span&gt;");
  });

  it("never runs raw HTML or executable links and retains useful text", () => {
    const html = renderToStaticMarkup(<KuloMarkdown text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[危险链接](javascript:alert(1))\n\n![坏图](data:image/svg+xml;base64,AAAA)\n\n[官网](https://example.com)'} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="data:');
    expect(html).toContain("危险链接");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("rejects protocol-relative, inline, file and control-character media URLs", () => {
    for (const url of ["//evil.example/image.png", "javascript:alert(1)", "data:image/svg+xml,svg", "file:///etc/passwd", "/\\evil.example/a", "https://example.com/\nfile"]) {
      expect(safeContentUrl(url)).toBeUndefined();
      expect(markdownUrlTransform(url, "src")).toBe("");
    }
    expect(safeContentUrl("blob:https://kulo.example/draft")).toBeUndefined();
    expect(safeContentUrl("blob:https://kulo.example/draft", true)).toBe("blob:https://kulo.example/draft");
    expect(markdownUrlTransform("mailto:hello@example.com", "href")).toBe("mailto:hello@example.com");
    expect(markdownUrlTransform("/api/uploads/image", "src")).toBe("/api/uploads/image");
  });

  it("keeps complete code available when its visual preview is collapsed", () => {
    const source = Array.from({ length: 35 }, (_, index) => `line_${index}`).join("\n");
    const html = renderToStaticMarkup(<CodeBlock code={source} language="text" />);
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain("展开 35 行");
    expect(html).toContain("line_0\nline_1");
    expect(html).toContain("line_34");
  });

  it("groups adjacent images without merging across code or text", () => {
    const parts: MessagePart[] = [
      { partId: "one", type: "image", assetId: "one", asset: image },
      { partId: "two", type: "image", assetId: "two", asset: { ...image, id: "two" } },
      { partId: "text", type: "markdown", text: "图片说明" },
      { partId: "three", type: "image", assetId: "three", asset: { ...image, id: "three" } },
    ];
    expect(groupMessageParts(parts).map((group) => group.parts.map((part) => part.partId))).toEqual([["one", "two"], ["text"], ["three"]]);
    expect(parts).toHaveLength(4);
  });

  it("limits an image gallery to four previews while preserving the remaining count", () => {
    const html = renderToStaticMarkup(<AssetImageGallery assets={Array.from({ length: 6 }, (_, index) => ({ ...image, id: `image-${index}` }))} />);
    expect(html.match(/<img /g)).toHaveLength(4);
    expect(html).toContain('src="/api/uploads/image?variant=thumb"');
    expect(html).toContain("+2");
    expect(html).toContain('width="800"');
    expect(html).toContain('aria-label="预览图片：会议草图.png"');
  });

  it("derives thumbnail URLs only for clean local upload paths while preserving originals elsewhere", () => {
    expect(resolveImageThumbUrl("/api/uploads/att_abc123")).toBe("/api/uploads/att_abc123?variant=thumb");
    expect(resolveImageThumbUrl("/api/uploads/att_abc123?download=1")).toBe("/api/uploads/att_abc123?download=1");
    expect(resolveImageThumbUrl("/api/uploads/att_abc123/preview")).toBe("/api/uploads/att_abc123/preview");
    expect(resolveImageThumbUrl("https://cdn.example.com/photo.png")).toBe("https://cdn.example.com/photo.png");
    expect(resolveImageThumbUrl("blob:https://kulo.example/draft")).toBe("blob:https://kulo.example/draft");
    const externalHtml = renderToStaticMarkup(<AssetImage image={{ src: "https://cdn.example.com/photo.png", name: "外链图.png" }} />);
    expect(externalHtml).toContain('src="https://cdn.example.com/photo.png"');
  });

  it("preserves legacy user bubbles and renders attachments exactly once", () => {
    const html = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "user", text: "**原文**", attachments: [image] }} />);
    expect(html).toContain("kulo-chat-user-text");
    expect(html).toContain("**原文**");
    expect(html).not.toContain("<strong>");
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html.indexOf("<img ")).toBeLessThan(html.indexOf("**原文**"));
  });

  it("keeps user part IDs stable across local negative ID and server positive ID replacement", () => {
    const localParts: MessagePart[] = [
      { partId: "-9007199254740991:asset:image", type: "image", assetId: "image", asset: image },
      { partId: "-9007199254740991:text", type: "markdown", text: "发一张图" },
    ];
    const serverParts: MessagePart[] = [
      { partId: "101:asset:image", type: "image", assetId: "image", asset: image },
      { partId: "101:text", type: "markdown", text: "发一张图" },
    ];
    expect(stableUserParts({ role: "user", requestId: "web:abc" }, localParts).map((p) => p.partId))
      .toEqual(stableUserParts({ role: "user", requestId: "web:abc" }, serverParts).map((p) => p.partId));
    expect(stableUserParts({ role: "assistant", requestId: "web:abc" }, serverParts)).toBe(serverParts);
  });

  it("uses structured parts instead of duplicating legacy fallback text and supports UI fallback", () => {
    const html = renderToStaticMarkup(<MessageContent item={{ id: 2, role: "assistant", text: "旧文本不应重复", parts: [{ partId: "ui", type: "ui", cardId: "card", fallbackText: "当前结果" }] }} />);
    expect(html).toContain("当前结果");
    expect(html).not.toContain("旧文本不应重复");
  });

  it("keeps native media controls before enhancement and never autoplays", () => {
    const audioHtml = renderToStaticMarkup(<MediaMessage asset={audio} />);
    expect(audioHtml).toContain("kulo-chat-audio");
    expect(audioHtml).toContain('<audio src="/api/uploads/audio"');
    expect(audioHtml).toContain('controls=""');
    expect(audioHtml).not.toMatch(/autoPlay|autoplay/);
    const videoHtml = renderToStaticMarkup(<MediaMessage asset={{ ...audio, kind: "video", name: "演示.mp4", mimeType: "video/mp4", captions: [{ url: "/api/uploads/captions", label: "中文", language: "zh" }], transcript: { text: "演示内容" } }} />);
    expect(videoHtml).toContain("kulo-chat-video");
    expect(videoHtml).toContain('kind="captions"');
    expect(videoHtml).toContain('label="中文"');
    expect(videoHtml).toContain("文字稿");
    expect(videoHtml).not.toMatch(/autoPlay|autoplay/);
    const portrait = renderToStaticMarkup(<MediaMessage asset={{ ...audio, kind: "video", width: 900, height: 1600 }} />);
    expect(portrait).toContain("--kulo-media-width:225px");
  });
});

describe("media playback coordination", () => {
  it("pauses every registered player before microphone capture", () => {
    const first = { paused: false, pause: vi.fn() } as unknown as HTMLMediaElement;
    const second = { paused: false, pause: vi.fn() } as unknown as HTMLMediaElement;
    const releaseFirst = registerMedia(first);
    const releaseSecond = registerMedia(second);
    try {
      pauseOtherMedia();
      expect(first.pause).toHaveBeenCalledOnce();
      expect(second.pause).toHaveBeenCalledOnce();
    } finally { releaseFirst(); releaseSecond(); }
  });

  it("pauses other players when one starts, then pauses and releases an unmounted player", () => {
    const first = { paused: false, pause: vi.fn() } as unknown as HTMLMediaElement;
    const second = { paused: false, pause: vi.fn() } as unknown as HTMLMediaElement;
    const releaseFirst = registerMedia(first);
    const releaseSecond = registerMedia(second);
    pauseOtherMedia(first);
    expect(first.pause).not.toHaveBeenCalled();
    expect(second.pause).toHaveBeenCalledOnce();
    releaseFirst();
    expect(first.pause).toHaveBeenCalledOnce();
    pauseOtherMedia(second);
    expect(first.pause).toHaveBeenCalledOnce();
    releaseSecond();
  });
});
