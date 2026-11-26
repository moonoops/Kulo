import { describe, expect, it } from "vitest";
import { AssistantEntry, type ConversationView, type EntryRecord } from "@earendil-works/pi-durable";
import { sanitizeMarkdownTrackingLinks, stripTrackingParamsFromUrl } from "@kulo/protocol";
import { normalizeWebSourceUrl } from "../packages/hub/src/web-content.js";
import { selectCitedSources } from "../packages/hub/src/search-sources.js";
import { extractDisplayMessages, extractLiveState } from "../packages/hub/src/hub-display-projection.js";
import { indexMessageSources, safeSourceUrl, shouldRenderCitationPill } from "../packages/web/src/features/chat/citation-sources.js";

describe("URL tracking parameter hygiene and 4-way citation symmetry", () => {
  it("strips utm_* and ad-click trackers while preserving business query parameters and fragments", () => {
    expect(
      stripTrackingParamsFromUrl(
        "https://example.com/articles/item?id=42&utm_source=openai&utm_medium=referral&fbclid=abc&msockid=xyz&trk=1&spm=a2.b3&page=2#summary",
      ),
    ).toBe("https://example.com/articles/item?id=42&page=2#summary");
    expect(stripTrackingParamsFromUrl("https://example.com/path?utm_source=openai")).toBe("https://example.com/path");
    expect(stripTrackingParamsFromUrl("https://example.com/clean?q=rust+lang")).toBe("https://example.com/clean?q=rust+lang");
  });

  it("preserves balanced parentheses in Wikipedia links and folds adjacent duplicate citations", () => {
    const raw = [
      "The curve shifts right ([en.wikipedia.org](https://en.wikipedia.org/wiki/IS%E2%80%93LM_model_(macroeconomics)?utm_source=openai)).",
      "Confirmed twice ([reuters.com](https://www.reuters.com/world/report?utm_source=openai&utm_content=1)) ([reuters.com](https://www.reuters.com/world/report?utm_source=openai&utm_content=2)).",
    ].join(" ");
    expect(sanitizeMarkdownTrackingLinks(raw)).toBe(
      "The curve shifts right ([en.wikipedia.org](https://en.wikipedia.org/wiki/IS%E2%80%93LM_model_(macroeconomics))). " +
        "Confirmed twice ([reuters.com](https://www.reuters.com/world/report)).",
    );
  });

  it("never alters URLs inside fenced code blocks or inline code spans, and tolerates partial streaming links", () => {
    const withCode = [
      "Inline sample `curl \"https://api.example.com/v1?utm_source=openai\"` and prose ([openai.com](https://openai.com/news?utm_source=openai)).",
      "```bash",
      "curl 'https://example.com/webhook?utm_source=openai&fbclid=keep_in_code'",
      "```",
    ].join("\n");
    const cleaned = sanitizeMarkdownTrackingLinks(withCode);
    expect(cleaned).toContain("`curl \"https://api.example.com/v1?utm_source=openai\"`");
    expect(cleaned).toContain("curl 'https://example.com/webhook?utm_source=openai&fbclid=keep_in_code'");
    expect(cleaned).toContain("([openai.com](https://openai.com/news))");

    const partialStream = "Reading source ([openai.com](https://openai.com/index?utm_source=open";
    expect(sanitizeMarkdownTrackingLinks(partialStream)).toBe(partialStream);
  });

  it("keeps normalizeWebSourceUrl, safeSourceUrl, selectCitedSources, extractDisplayMessages and extractLiveState symmetric", () => {
    const dirtyUrl = "https://www.reuters.com/technology/ai-update/?utm_source=openai&msockid=9988";
    const cleanHubUrl = normalizeWebSourceUrl(dirtyUrl)!;
    const cleanWebUrl = safeSourceUrl(dirtyUrl)!;
    expect(cleanHubUrl).toBe("https://www.reuters.com/technology/ai-update/");
    expect(cleanWebUrl).toBe(cleanHubUrl);

    const rawAssistant = {
      id: 1,
      kind: AssistantEntry.kind,
      data: {},
      model: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: `Latest update ([reuters.com](${dirtyUrl})).` }],
          kuloSearchSources: [{ id: "src-1", title: "AI Update", url: dirtyUrl }],
        },
      ],
    } as unknown as EntryRecord;

    const display = extractDisplayMessages([rawAssistant]);
    expect(display).toHaveLength(1);
    expect(display[0]!.text).toBe(`Latest update ([reuters.com](${cleanHubUrl})).`);
    expect(display[0]!.sources).toEqual([{ id: "src-1", title: "AI Update", url: cleanHubUrl }]);

    const cited = selectCitedSources(display[0]!.text, display[0]!.sources ?? []);
    expect(cited).toHaveLength(1);
    const indexed = indexMessageSources(display[0]!.sources);
    const sourceMap = new Map(indexed.map((s) => [s.url, s]));
    const matched = sourceMap.get(cleanWebUrl);
    expect(matched?.siteLabel).toBe("Reuters");
    expect(shouldRenderCitationPill({ source: matched!, linkText: "reuters.com", citationKind: "trailing" })).toBe(true);

    const liveView = {
      entries: [],
      docs: {
        "pi.live": {
          run: { taskId: 1 },
          generation: {
            attempt: 1,
            message: { content: [{ type: "text", text: `Streaming ([reuters.com](${dirtyUrl}))` }] },
          },
        },
      },
    } as unknown as ConversationView;
    expect(extractLiveState(liveView).streamingText).toBe(`Streaming ([reuters.com](${cleanHubUrl}))`);
  });
});
