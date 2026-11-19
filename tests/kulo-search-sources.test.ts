import { describe, expect, it } from "vitest";
import type { WebSource } from "@kulo/protocol";
import { sanitizeSearchSources, selectCitedSources } from "../packages/hub/src/search-sources.js";

const source = (url: string, id = "source-1"): WebSource => ({ id, title: "官方资料", url, snippet: "检索摘要" });

describe("search source citations", () => {
  it("normalizes and deduplicates sources without retaining arbitrary provider fields", () => {
    const clean = sanitizeSearchSources([
      { ...source("https://EXAMPLE.com"), apiKey: "should-not-be-copied", title: " 官方\n资料 " },
      source("https://example.com/", "duplicate"),
      { ...source("https://docs.example.com/page", "source-2"), content: "x".repeat(30_000), fetchedAt: 1 },
    ]);
    expect(clean).toHaveLength(2);
    expect(clean[0]).toEqual({ id: "source-1", title: "官方 资料", url: "https://example.com/", snippet: "检索摘要" });
    expect(clean[1]?.content).toHaveLength(24_000);
    expect(clean[1]?.fetchedAt).toBe(1);
    expect(JSON.stringify(clean)).not.toContain("should-not-be-copied");
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "//example.com", "https://user:secret@example.com/", "http://localhost/a", "http://127.0.0.1/", "http://169.254.169.254/", "https://example.com/\npath", "https://example.com/\\path"])("rejects unsafe source %s", (url) => {
    expect(sanitizeSearchSources([source(url)])).toEqual([]);
  });

  it("bounds input and rejects invalid source identities", () => {
    expect(sanitizeSearchSources(null)).toEqual([]);
    expect(sanitizeSearchSources([null, [], { url: "https://example.com/" }, source("https://example.com/", "bad:id")])).toEqual([]);
    const clean = sanitizeSearchSources(Array.from({ length: 200 }, (_, index) => source(`https://example.com/${index}`, `source-${index}`)));
    expect(clean).toHaveLength(40);
  });

  it("selects cited exact URLs while leaving searched but unused sources out", () => {
    const sources = [source("https://example.com/guide", "a"), source("https://example.com/guide?lang=zh", "b"), source("https://other.example.com/", "c")];
    expect(selectCitedSources("根据[官方文档](https://example.com/guide)作答。", sources).map((item) => item.id)).toEqual(["a"]);
    expect(selectCitedSources("https://example.com/guide.evil 只是未引用的地址。", sources)).toEqual([]);
    expect(selectCitedSources("[猜测来源](https://invented.example.com/)", sources)).toEqual([]);
  });

  it("handles nested URL parentheses, escaped parentheses, titles, query entities and reference links", () => {
    const sources = [source("https://example.com/Guide_(topic)", "a"), source("https://example.com/?a=1&b=2", "b"), source("https://example.com/reference", "c"), source("https://example.com/autolink", "d")];
    const text = '[指南](https://example.com/Guide_(topic) "标题")\n\n[查询](<https://example.com/?a=1&amp;b=2>)\n\n[参考][ref]\n\n[ref]: https://example.com/reference\n\n<https://example.com/autolink>';
    expect(selectCitedSources(text, sources).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(selectCitedSources("[指南](https://example.com/Guide_\\(topic\\))", sources).map((item) => item.id)).toEqual(["a"]);
    expect(selectCitedSources("[ref]\n\n[ref]: https://example.com/reference", sources).map((item) => item.id)).toEqual(["c"]);
  });

  it("does not count code samples, image URLs, unused definitions or source marker text as citations", () => {
    const sources = [source("https://example.com/a")];
    for (const text of [
      "`[样例](https://example.com/a)`",
      "```md\n[样例](https://example.com/a)\n```",
      "~~~md\n[样例](https://example.com/a)\n~~~",
      "    [样例](https://example.com/a)",
      "![图片](https://example.com/a)",
      "![图片](<https://example.com/a>)",
      "[unused]: https://example.com/a",
      "[source:source-1]",
      "\\[样例](https://example.com/a)",
    ]) expect(selectCitedSources(text, sources)).toEqual([]);
  });
});
