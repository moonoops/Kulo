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

describe("Inline search citations vs. ordinary prose links", () => {
  const sources = [
    { id: "s1", title: "iPhone Duo目前市场价格是多少？", url: "https://cj.sina.com.cn/articles/view/1", snippet: "256GB 15,999 元起。" },
    { id: "s2", title: "iPhone Duo发售两天价格破发专家分析后续走势", url: "https://www.sohu.com/a/2", snippet: "第三方渠道普遍低约 200 元。" },
    { id: "s3", title: "iPhone Duo 首发销量公开：_产品_频道_苹果", url: "https://www.sohu.com/a/3", snippet: "预售期最高溢价数万元。" },
    { id: "s4", title: "苹果回应iPhone Duo渠道破发：官网价格更稳定", url: "https://feng.ifeng.com/c/4" },
  ];

  it("folds parenthesized source citations into compact site pills and strips redundant parens/separators", () => {
    const text = [
      "- **2TB**：26,499 元\n（[iPhone Duo目前市场价格是多少？](https://cj.sina.com.cn/articles/view/1)）",
      "- 第三方电商店铺普遍比官方价低约 200 元左右（[iPhone Duo发售两天价格破发专家分析后续走势](https://www.sohu.com/a/2)、[iPhone Duo 首发销量公开](https://www.sohu.com/a/3)）。",
    ].join("\n");
    const html = renderToStaticMarkup(<KuloMarkdown text={text} sources={sources} />);
    expect(html).toContain("kulo-chat-citation");
    expect(html).toContain(">新浪财经</span>");
    // Same-site distinct articles disambiguate with matching bottom source indices (2 and 3)
    expect(html).toContain(">搜狐</span><span class=\"kulo-chat-citation-index\">2</span>");
    expect(html).toContain(">搜狐</span><span class=\"kulo-chat-citation-index\">3</span>");
    // Redundant wrapping Chinese parentheses and SEO titles must not pollute visible prose text
    expect(html).not.toContain("（<a");
    expect(html).not.toContain(">iPhone Duo目前市场价格是多少？<");
    expect(html).not.toContain("</a>、<a");
    // Accessible labels keep the full title and domain
    expect(html).toContain('aria-label="来源 1：iPhone Duo目前市场价格是多少？（cj.sina.com.cn）"');
  });

  it("handles two consecutive parenthesized citation groups in the same paragraph", () => {
    const text = "预售加价（[iPhone Duo 首发销量公开](https://www.sohu.com/a/3)），随后官网维持原价（[苹果回应iPhone Duo渠道破发：官网价格更稳定](https://feng.ifeng.com/c/4)）。";
    const html = renderToStaticMarkup(<KuloMarkdown text={text} sources={sources} />);
    expect(html.match(/kulo-chat-citation-label/g)).toHaveLength(2);
    expect(html).toContain(">搜狐</span>");
    expect(html).toContain(">凤凰网</span>");
    const visibleText = html.replace(/<[^>]+>/g, "");
    expect(visibleText).toBe("预售加价搜狐3，随后官网维持原价。凤凰网");
    expect(visibleText).not.toContain("（");
    expect(visibleText).not.toContain("）");
  });

  it("preserves ordinary prose links and mixed-prose parentheses without folding them into pills", () => {
    const text = "详情见 [AppleCare 官方售后说明](https://support.apple.com/care)（或参考 [官方政策](https://cj.sina.com.cn/articles/view/1) 后再决定）。";
    const html = renderToStaticMarkup(<KuloMarkdown text={text} sources={sources} />);
    expect(html).not.toContain("kulo-chat-citation-label");
    expect(html.match(/kulo-chat-prose-link/g)).toHaveLength(2);
    expect(html).toContain("AppleCare 官方售后说明");
    expect(html).toContain("（或参考 ");
    expect(html).toContain(" 后再决定）。");
  });

  it("never alters parenthesized citation syntax inside inline code or fenced code blocks", () => {
    const raw = "（[iPhone Duo目前市场价格是多少？](https://cj.sina.com.cn/articles/view/1)）";
    const html = renderToStaticMarkup(<KuloMarkdown text={`\`${raw}\`\n\n\`\`\`markdown\n${raw}\n\`\`\``} sources={sources} />);
    expect(html).not.toContain("kulo-chat-citation");
    expect(html).toContain(`<code class="kulo-chat-inline-code">${raw}</code>`);
    expect(html).toContain(`<code>${raw}</code>`);
  });
});
