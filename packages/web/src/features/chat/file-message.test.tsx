import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_ARTIFACT_CSP, htmlArtifactDocument, isHtmlArtifact, type ChatAttachment } from "@moco/protocol";
import { FileMessage } from "./file-message";
import { MessageContent } from "./message-content";

const html: ChatAttachment = { id: "first", name: "可交互报告.html", kind: "file", mimeType: "text/html", size: 1024, url: "/api/uploads/first" };
afterEach(() => vi.unstubAllGlobals());

describe("message artifacts", () => {
  it("offers HTML preview controls while preserving an ordinary file's compact download", () => {
    const markup = renderToStaticMarkup(<FileMessage asset={html} />);
    expect(markup).toContain('data-kind="html"');
    for (const label of ["放大预览：可交互报告.html", "在浏览器打开：可交互报告.html", "文件选项：可交互报告.html"]) expect(markup).toContain(label);
    const document = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "演示.pptx", mimeType: "application/octet-stream" }} />);
    expect(document).toContain("下载文件：演示.pptx");
    expect(document).not.toContain("放大");
    expect(document).not.toContain("在默认应用打开");
  });

  it("shows the default-app action in the desktop renderer", () => {
    vi.stubGlobal("window", { mocoDesktop: { openFile: vi.fn(), saveFile: vi.fn() } });
    const markup = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "照明方案.pptx", mimeType: "application/octet-stream" }} />);
    expect(markup).toContain("在默认应用打开：照明方案.pptx");
    expect(markup).toContain("下载文件：照明方案.pptx");
    const htmlMarkup = renderToStaticMarkup(<FileMessage asset={html} />);
    expect(htmlMarkup).toContain("在默认应用打开：可交互报告.html");
    expect(htmlMarkup).not.toContain("aria-label=\"在浏览器打开：可交互报告.html\"");
  });

  it("renders every supported file inline for both assistant results and uploaded documents", () => {
    const assistant = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "assistant", text: "结果如下", attachments: [html, { ...html, id: "second", name: "另一份.html" }] }} />);
    expect(assistant.match(/class="moco-artifact-inline-stage"/g)).toHaveLength(2);
    expect(assistant).not.toContain('class="moco-artifact-inline-stage" hidden=""');
    expect(assistant).toContain("展开阅读：可交互报告.html");
    const user = renderToStaticMarkup(<MessageContent item={{ id: 2, role: "user", text: "查看页面", attachments: [html] }} />);
    expect(user).not.toContain('class="moco-artifact-inline-stage" hidden=""');
    for (const [name, mimeType, kind] of [["报告.pdf", "application/pdf", "pdf"], ["说明.md", "text/markdown", "markdown"], ["记录.txt", "text/plain", "text"]]) {
      const markup = renderToStaticMarkup(<FileMessage asset={{ ...html, name: name!, mimeType: mimeType! }} />);
      expect(markup).toContain(`data-kind="${kind}"`);
      expect(markup).toContain('data-asset-id="first"');
      expect(markup).toContain(`放大预览：${name}`);
      expect(markup).toContain(`展开阅读：${name}`);
    }
  });

  it("preserves an explicitly collapsed preview and exposes a discoverable expand action", () => {
    const markup = renderToStaticMarkup(<FileMessage asset={html} defaultExpanded={false} />);
    expect(markup).toContain('class="moco-artifact-inline-stage" hidden=""');
    expect(markup).toContain("展开预览：可交互报告.html");
    expect(markup).not.toContain("展开阅读：");
  });

  it("requires an HTML filename and MIME and isolates scripts from host data and network", () => {
    expect(isHtmlArtifact(html)).toBe(true);
    expect(isHtmlArtifact({ ...html, name: "INDEX.HTM", mimeType: "text/html; charset=utf-8" })).toBe(true);
    expect(isHtmlArtifact({ ...html, mimeType: "image/svg+xml" })).toBe(false);
    expect(isHtmlArtifact({ ...html, name: "report.txt" })).toBe(false);
    expect(HTML_ARTIFACT_CSP).toContain("sandbox allow-scripts allow-forms");
    expect(HTML_ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(HTML_ARTIFACT_CSP).toContain("form-action 'none'");
    expect(HTML_ARTIFACT_CSP).not.toMatch(/allow-same-origin|allow-popups|unsafe-eval/);
    const source = '<html><body style="background:peachpuff"><button onclick="this.textContent=42">计算</button></body></html>';
    expect(htmlArtifactDocument(source)).toContain(source);
    expect(htmlArtifactDocument(source)).toContain("scrollbar-width:thin");
  });
});
