import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KuloMarkdown } from "./kulo-markdown";
import { MessageContent } from "./features/chat/message-content";

function render(text: string): string {
  return renderToStaticMarkup(<KuloMarkdown text={text} />);
}

describe("CJK Markdown", () => {
  it.each([
    ["一次**“长上下文挤压测试”**：", "一次<strong>“长上下文挤压测试”</strong>："],
    ["右侧的**「管理」**按钮", "右侧的<strong>「管理」</strong>按钮"],
    ["点击**「管理」**和**「停止」**按钮", "点击<strong>「管理」</strong>和<strong>「停止」</strong>按钮"],
    ["执行**（acp-kernel）**扩展", "执行<strong>（acp-kernel）</strong>扩展"],
    ["显示**完成。**然后继续", "显示<strong>完成。</strong>然后继续"],
    ["中文*「斜体」*正文", "中文<em>「斜体」</em>正文"],
    ["中文***「粗斜体」***正文", "中文<em><strong>「粗斜体」</strong></em>正文"],
    ["中文~~「已取消」~~正文", "中文<del>「已取消」</del>正文"],
  ])("renders punctuation-adjacent emphasis in %s", (text, expected) => {
    expect(render(text)).toContain(`<p>${expected}</p>`);
  });

  it("keeps nested links, inline code and GFM tables inside CJK emphasis", () => {
    const html = render('点击**「[管理](https://example.com)」**按钮，检查**「`acp-kernel`」**扩展。\n\n| 操作 | 状态 |\n| --- | --- |\n| 点击**「管理」**按钮 | 中文~~「已取消」~~状态 |');
    expect(html).toMatch(/<strong>「<a [^>]*href="https:\/\/example.com"[^>]*>管理<\/a>」<\/strong>/);
    expect(html).toContain('<strong>「<code class="kulo-chat-inline-code">acp-kernel</code>」</strong>');
    expect(html).toContain('<td>点击<strong>「管理」</strong>按钮</td>');
    expect(html).toContain("<td>中文<del>「已取消」</del>状态</td>");
  });

  it("preserves literal emphasis inside code and escaped text", () => {
    const source = "右侧的**「管理」**按钮";
    const html = render('`' + source + '`\n\n```markdown\n' + source + '\n```\n\n右侧的\\*\\*「管理」\\*\\*按钮');
    expect(html).toContain(`<code class="kulo-chat-inline-code">${source}</code>`);
    expect(html).toContain(`<code>${source}</code>`);
    expect(html).toContain(`<p>${source}</p>`);
    expect(html).not.toContain("<strong>");
  });

  it("retains incomplete streamed text and renders emphasis once closed", () => {
    const source = "右侧的**「管理」**按钮";
    for (const prefix of ["右侧的**", "右侧的**「管理", "右侧的**「管理」", "右侧的**「管理」*"]) {
      expect(render(prefix)).toContain(`<p>${prefix}</p>`);
    }
    expect(render(source)).toContain("<p>右侧的<strong>「管理」</strong>按钮</p>");
  });

  it("preserves soft line breaks and standard English emphasis rules", () => {
    const html = render("第一行\n第二行\n\n**English** and *emphasis* with foo_bar_baz.");
    expect(html).toContain("<p>第一行\n第二行</p>");
    expect(html).toContain("<strong>English</strong> and <em>emphasis</em> with foo_bar_baz.");
  });

  it("renders both legacy and structured assistant messages", () => {
    const text = "右侧的**「管理」**按钮";
    const legacy = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "assistant", text }} />);
    const structured = renderToStaticMarkup(<MessageContent item={{ id: 2, role: "assistant", text: "备用文本", parts: [{ type: "markdown", partId: "body", text }] }} />);
    for (const html of [legacy, structured]) {
      expect(html).toContain("<strong>「管理」</strong>");
      expect(html).not.toContain("备用文本");
    }
  });
});
