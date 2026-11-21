import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_DEFAULT_DARK_VARS,
  messagePartFallback,
  wrapInlineDiagramDocument,
  type ChatAttachment,
  type MessagePart,
} from "@kulo/protocol";
import { MessageContent } from "./message-content";
import { materializeStandaloneDiagramSvg, resolveCssColorToSrgb } from "./inline-diagram-export";

const diagramAsset: ChatAttachment = {
  id: "att_pub_diagram123",
  name: "订单状态流转图.html",
  kind: "file",
  mimeType: "text/html",
  size: 2048,
  url: "/api/uploads/att_pub_diagram123",
  presentation: "diagram",
  diagramMotion: "none",
  width: 640,
  height: 260,
};

describe("InlineDiagram rendering and local export", () => {
  it("renders a frameless diagram figure without file card chrome, HTML extension, or engineer toolbar", () => {
    const part: MessagePart = {
      partId: "diagram_1",
      type: "file",
      assetId: diagramAsset.id,
      asset: diagramAsset,
      fallbackText: "订单创建 -> 支付确认",
      caption: "订单核心状态机",
    };
    const markup = renderToStaticMarkup(
      <MessageContent item={{ id: 10, role: "assistant", text: "如图所示", parts: [part] }} />,
    );
    expect(markup).toContain('data-presentation="diagram"');
    expect(markup).toContain('aria-label="放大查看：订单状态流转图"');
    expect(markup).toContain("订单核心状态机");
    // Must not look like a file attachment card
    expect(markup).not.toContain("订单状态流转图.html");
    expect(markup).not.toContain("2.0 KB");
    expect(markup).not.toContain("默认应用打开");
    expect(markup).not.toContain("查看源码");
    expect(markup).not.toContain("展开阅读");
    // Message copy / quote / fallback uses semantic fallbackText, not .html filename
    expect(messagePartFallback(part)).toBe("订单创建 -> 支付确认");
  });

  it("materializes standalone SVG with resolved sRGB vars, non-zero viewBox background, and explicit scaled dimensions", () => {
    const svg = `<svg viewBox="-20 -10 640 260" role="img"><title id="t">架构</title><desc id="d">说明</desc><rect x="0" y="0" width="120" height="56" fill="var(--d-paper-2)" stroke="var(--d-accent)"/></svg>`;
    const doc = wrapInlineDiagramDocument({ title: "架构", svg });
    const out = materializeStandaloneDiagramSvg(doc, DIAGRAM_DEFAULT_DARK_VARS, { pixelScale: 2 });
    expect(out.width).toBe(1280);
    expect(out.height).toBe(520);
    expect(out.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out.svg).toContain('width="1280" height="520"');
    expect(out.svg).toContain('<rect x="-20" y="-10" width="640" height="260" fill="#18181b"/>');
    expect(out.svg).toContain('fill="#27272a"');
    expect(out.svg).toContain('stroke="#60a5fa"');
    expect(out.svg).not.toContain("var(--d-");
    expect(resolveCssColorToSrgb("#18181b", "#000000")).toBe("#18181b");
    expect(resolveCssColorToSrgb("rgba(24, 24, 27, 0.14)", "#000000")).toBe("rgba(24, 24, 27, 0.14)");
  });
});
