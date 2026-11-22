import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WebSource } from "@kulo/protocol";
import { MessageContent } from "./message-content";
import { MessageSources, safeSourceUrl, searchSuggestionsDocument } from "./message-sources";

const source: WebSource = { id: "source-1", title: "官方文档", url: "https://docs.example.com/guide" };

describe("chat search sources", () => {
  it("renders a collapsed single-row source bar with site summary and numbered pills after structured content", () => {
    const html = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "assistant", text: "不重复的旧文本", parts: [{ partId: "text", type: "markdown", text: "参考[文档](https://docs.example.com/guide)。" }], sources: [source, { ...source, id: "duplicate" }] }} />);
    expect(html).toContain('aria-label="引用来源"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("kulo-message-sources-trigger");
    expect(html).toContain("来源 · 1");
    expect(html).toContain("kulo-message-source-index");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("docs.example.com");
    expect(html.match(/kulo-message-source-title/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="引用来源"')).toBeGreaterThan(html.indexOf("kulo-chat-markdown"));
    expect(html).not.toContain("不重复的旧文本");
  });

  it("summarizes deduplicated site labels in the single-row header while keeping all distinct articles numbered", () => {
    const html = renderToStaticMarkup(<MessageSources sources={[
      { id: "1", title: "定价", url: "https://cj.sina.com.cn/1" },
      { id: "2", title: "走势一", url: "https://www.sohu.com/a/1" },
      { id: "3", title: "走势二", url: "https://www.sohu.com/a/2" },
      { id: "4", title: "回应", url: "https://feng.ifeng.com/c/1" },
    ]} />);
    expect(html).toContain("来源 · 4");
    expect(html).toContain("新浪财经 · 搜狐 · 凤凰网");
    expect(html.match(/kulo-message-source-index/g)).toHaveLength(4);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "//evil.example.com/", "https://user:secret@example.com", "http://localhost/", "http://127.1/", "http://[::1]/", "http://169.254.169.254/", "https://example.com/\npath"])("blocks unsafe citation URL %s", (url) => {
    expect(safeSourceUrl(url)).toBeUndefined();
    expect(renderToStaticMarkup(<MessageSources sources={[{ ...source, url }]} />)).toBe("");
  });

  it("keeps source titles as text and omits source UI from user messages", () => {
    const html = renderToStaticMarkup(<MessageSources sources={[{ ...source, title: '<img src=x onerror="alert(1)">' }]} />);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(renderToStaticMarkup(<MessageContent item={{ id: 2, role: "user", text: "原文", sources: [source] }} />)).not.toContain("引用来源");
  });

  it("isolates Google search suggestions in bounded sandboxed documents", () => {
    const content = '<style>.suggestion{color:#333}</style><a class="suggestion" href="https://google.com/search?q=kulo">Kulo</a>';
    const html = renderToStaticMarkup(<MessageContent item={{ id: 3, role: "assistant", text: "搜索回答", sources: [source], searchSuggestions: [content, content] }} />);
    expect(html.match(/<iframe /g)).toHaveLength(1);
    expect(html).toContain('sandbox="allow-popups"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("default-src &#x27;none&#x27;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('<a class="suggestion"');
    expect(searchSuggestionsDocument("x".repeat(30_000)).length).toBeLessThan(25_000);
    expect(renderToStaticMarkup(<MessageSources sources={[]} searchSuggestions={[content]} />)).toBe("");
  });

  it("blocks remote image requests from suggestion markup and CSS", () => {
    const document = searchSuggestionsDocument('<img src="https://169.254.169.254/latest/meta-data"><style>body{background-image:url(https://private.example.com/image)}</style>');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(document)?.[1];
    expect(csp).toContain("img-src data:;");
    expect(csp).not.toMatch(/img-src[^;]*https?:/);
    expect(csp).toContain("default-src 'none';");
    expect(csp).toContain("connect-src 'none';");
  });
});
