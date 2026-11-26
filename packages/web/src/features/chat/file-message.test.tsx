import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_ARTIFACT_CSP, htmlArtifactDocument, isHtmlArtifact, type ChatAttachment } from "@kulo/protocol";
import { UserAttachmentList } from "../../kulo-composer";
import { FileMessage } from "./file-message";
import { MAX_OFFICE_PREVIEW_BYTES } from "./file-preview-model";
import { MessageContent } from "./message-content";

const html: ChatAttachment = { id: "first", name: "可交互报告.html", kind: "file", mimeType: "text/html", size: 1024, url: "/api/uploads/first" };
afterEach(() => vi.unstubAllGlobals());

describe("message artifacts", () => {
  it("offers HTML preview controls while preserving an ordinary binary file's compact download", () => {
    const markup = renderToStaticMarkup(<FileMessage asset={html} />);
    expect(markup).toContain("card--secondary");
    expect(markup).toContain('data-kind="html"');
    for (const label of ["放大预览：可交互报告.html", "在浏览器打开：可交互报告.html", "文件选项：可交互报告.html"]) expect(markup).toContain(label);
    const archive = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "资料包.zip", mimeType: "application/zip" }} />);
    expect(archive).toContain("下载文件：资料包.zip");
    expect(archive).not.toContain("放大");
    expect(archive).not.toContain("在默认应用打开");
    const legacy = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "旧方案.doc", mimeType: "application/octet-stream" }} />);
    expect(legacy).toContain("下载文件：旧方案.doc");
    expect(legacy).not.toContain("放大");
  });

  it("shows the default-app action in the desktop renderer", () => {
    vi.stubGlobal("window", { kuloDesktop: { openFile: vi.fn(), saveFile: vi.fn() } });
    const archiveMarkup = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "照明方案.zip", mimeType: "application/zip" }} />);
    expect(archiveMarkup).toContain("在默认应用打开：照明方案.zip");
    expect(archiveMarkup).toContain("下载文件：照明方案.zip");
    const pptxMarkup = renderToStaticMarkup(<FileMessage asset={{ ...html, name: "照明方案.pptx", mimeType: "application/octet-stream" }} />);
    expect(pptxMarkup).toContain('data-kind="pptx"');
    expect(pptxMarkup).toContain("在默认应用打开：照明方案.pptx");
    expect(pptxMarkup).toContain("放大预览：照明方案.pptx");
    const htmlMarkup = renderToStaticMarkup(<FileMessage asset={html} />);
    expect(htmlMarkup).toContain("在默认应用打开：可交互报告.html");
    expect(htmlMarkup).not.toContain("aria-label=\"在浏览器打开：可交互报告.html\"");
  });

  it("renders assistant files inline by default while showing user-sent files as compact thumbnails", () => {
    const assistant = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "assistant", text: "结果如下", attachments: [html, { ...html, id: "second", name: "另一份.html" }] }} />);
    expect(assistant.match(/class="kulo-artifact-inline-stage"/g)).toHaveLength(2);
    expect(assistant).not.toContain('class="kulo-artifact-inline-stage" hidden=""');
    expect(assistant).not.toContain('data-compact="true"');
    expect(assistant).toContain("展开阅读：可交互报告.html");

    const supportedFiles: Array<[string, string, string]> = [
      ["可交互报告.html", "text/html", "html"],
      ["报告.pdf", "application/pdf", "pdf"],
      ["说明.md", "text/markdown", "markdown"],
      ["记录.txt", "text/plain", "text"],
      ["报表.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
      ["汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
      ["纪要.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ];

    for (const [name, mimeType, kind] of supportedFiles) {
      const asset: ChatAttachment = { ...html, id: `asset-${kind}`, name, mimeType };

      const assistantMarkup = renderToStaticMarkup(
        <MessageContent item={{ id: 10, role: "assistant", text: "已生成文件", attachments: [asset] }} />,
      );
      expect(assistantMarkup).toContain(`data-kind="${kind}"`);
      expect(assistantMarkup).not.toContain('data-compact="true"');
      expect(assistantMarkup).not.toContain('class="kulo-artifact-inline-stage" hidden=""');
      expect(assistantMarkup).toContain(`放大预览：${name}`);
      expect(assistantMarkup).toContain(`展开阅读：${name}`);

      const userMarkup = renderToStaticMarkup(
        <MessageContent item={{ id: 20, role: "user", text: "请看这个文件", attachments: [asset] }} />,
      );
      expect(userMarkup).toContain(`data-kind="${kind}"`);
      expect(userMarkup).toContain('data-compact="true"');
      expect(userMarkup).toContain('class="kulo-artifact-inline-stage" hidden=""');
      expect(userMarkup).toContain(`预览文件：${name}`);
      expect(userMarkup).toContain(`文件选项：${name}`);
      expect(userMarkup).not.toContain(`展开阅读：${name}`);
      for (const button of userMarkup.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
        expect(button.match(/<button\b/g)).toHaveLength(1);
      }
    }

    const userZip = renderToStaticMarkup(
      <MessageContent item={{ id: 21, role: "user", text: "资料包", attachments: [{ ...html, id: "zip1", name: "资料包.zip", mimeType: "application/zip" }] }} />,
    );
    expect(userZip).toContain('data-compact="true"');
    expect(userZip).toContain("下载文件：资料包.zip");
    expect(userZip).not.toContain("预览文件：资料包.zip");
    expect(userZip).not.toContain("此文件暂不支持内嵌预览");

    const legacyUserList = renderToStaticMarkup(
      <UserAttachmentList attachments={[{ ...html, id: "pdf1", name: "手册.pdf", mimeType: "application/pdf" }]} />,
    );
    expect(legacyUserList).toContain('data-compact="true"');
    expect(legacyUserList).toContain('class="kulo-artifact-inline-stage" hidden=""');
    expect(legacyUserList).toContain("预览文件：手册.pdf");
  });

  it("degrades oversized Office files above 15 MiB into compact non-previewable cards without Expand controls", () => {
    vi.stubGlobal("window", { kuloDesktop: { openFile: vi.fn(), saveFile: vi.fn() } });
    const huge = renderToStaticMarkup(
      <FileMessage asset={{ ...html, name: "超大图集.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: MAX_OFFICE_PREVIEW_BYTES + 1024 }} />,
    );
    expect(huge).toContain("文件超过 15 MB");
    expect(huge).toContain("在默认应用打开：超大图集.pptx");
    expect(huge).toContain("下载文件：超大图集.pptx");
    expect(huge).not.toContain("放大预览：超大图集.pptx");
    expect(huge).not.toContain("kulo-artifact-inline-stage");
  });

  it("preserves an explicitly collapsed preview and exposes a discoverable expand action", () => {
    const markup = renderToStaticMarkup(<FileMessage asset={html} defaultExpanded={false} />);
    expect(markup).toContain('class="kulo-artifact-inline-stage" hidden=""');
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
