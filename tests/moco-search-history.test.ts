import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { extractDisplayMessages } from "../packages/hub/src/hub.js";
import { loadSearchEvidencePrefix, SearchEvidenceHistory } from "../packages/hub/src/search-history.js";

const source = { id: "source-docs", title: "Docs", url: "https://example.com/docs" };
const entry = (id: number, kind: string, model?: unknown[]) => ({ id, conversationId: 1, kind, model }) as unknown as EntryRecord;
const user = (id: number) => entry(id, "pi.user", [{ role: "user", content: "Private user request", timestamp: 1 }]);
const result = entry(2, "pi.tool-result", [{ role: "toolResult", toolName: "web_search", content: [{ type: "text", text: "Long retrieved page" }], details: { sources: [source], searchSuggestions: "<div>Suggestions</div>" } }]);
const answer = (id: number) => entry(id, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "[Docs](https://example.com/docs)" }], timestamp: 2 }]);

describe("search evidence across transcript windows", () => {
  it("preserves earlier citations across a relay response boundary without retaining the relay summary", () => {
    const relay = { ...entry(3, "moco.worker_relay"), data: { summary: "Private worker summary", sources: [] } } as unknown as EntryRecord;
    const history = new SearchEvidenceHistory();
    history.projectionEntries([user(1), result, relay]);
    const projection = history.projectionEntries([answer(200)]);
    expect(JSON.stringify(projection.slice(0, -1))).not.toContain("Private worker summary");
    expect(history.project([answer(200)], extractDisplayMessages)[0]?.sources).toEqual([source]);
  });

  it("shows provider citations without requiring the model to invent markdown source URLs", () => {
    const native = entry(2, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "Verified information." }],
      stopReason: "stop", mocoSearchSources: [source], mocoSearchSuggestions: ["<div>Native grounding</div>"] }]);
    const history = new SearchEvidenceHistory();
    expect(history.project([user(1), native], extractDisplayMessages).at(-1)).toMatchObject({
      text: "Verified information.", sources: [source], searchSuggestions: ["<div>Native grounding</div>"],
    });
    expect(history.project([answer(200)], extractDisplayMessages)[0]?.sources).toEqual([source]);
    expect(history.project([user(201), answer(202)], extractDisplayMessages).at(-1)?.sources).toBeUndefined();
  });

  it("restores native citation evidence without retaining a prior assistant's private text", async () => {
    const native = entry(2, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "Private earlier answer" }],
      stopReason: "stop", mocoSearchSources: [source] }]);
    const entries = vi.fn().mockResolvedValue({ items: [native, user(1)] });
    const prefix = await loadSearchEvidencePrefix({ entries } as unknown as Pick<Conversation, "entries">, answer(200), BACKGROUND_CONTEXT);
    expect(JSON.stringify(prefix)).not.toContain("Private earlier answer");
    const history = new SearchEvidenceHistory(); history.remember(prefix);
    expect(history.project([answer(200)], extractDisplayMessages)[0]?.sources).toEqual([source]);
  });

  it.each(["error", "aborted", "length"])("does not turn an incomplete %s native response into cited evidence", (stopReason) => {
    const native = entry(2, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "Partial information" }], stopReason, mocoSearchSources: [source] }]);
    expect(extractDisplayMessages([user(1), native]).at(-1)?.sources).toBeUndefined();
  });

  it("keeps sources and grounding suggestions when live history trims the original search event", () => {
    const history = new SearchEvidenceHistory();
    history.project([user(1), result], extractDisplayMessages);
    const filler = Array.from({ length: 180 }, (_, index) => entry(index + 3, "pi.assistant", [{ role: "assistant", content: [], timestamp: 2 }]));
    history.project(filler, extractDisplayMessages);
    expect(history.project([answer(200)], extractDisplayMessages)).toMatchObject([{ id: 200, sources: [source], searchSuggestions: ["<div>Suggestions</div>"] }]);
    expect(history.project([user(201), answer(202)], extractDisplayMessages).at(-1)?.sources).toBeUndefined();
  });

  it("hydrates only the current history page's preceding user turn across multiple raw pages", async () => {
    const entries = vi.fn().mockResolvedValueOnce({ items: [entry(170, "pi.assistant", []), entry(140, "pi.assistant", [])], next: "page-two" })
      .mockResolvedValueOnce({ items: [result, user(1)], next: "older-user-page" });
    const prefix = await loadSearchEvidencePrefix({ entries } as unknown as Pick<Conversation, "entries">, answer(200), BACKGROUND_CONTEXT);
    expect(entries).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(prefix)).not.toContain("Private user request");
    expect(JSON.stringify(prefix)).not.toContain("Long retrieved page");
    const restored = new SearchEvidenceHistory(); restored.remember(prefix);
    expect(restored.project([answer(200)], extractDisplayMessages)[0]?.sources).toEqual([source]);
  });

  it("does not include unrelated previous-turn sources or extra messages in a restored history page", async () => {
    const entries = vi.fn().mockResolvedValue({ items: [user(180), result, user(1)], next: undefined });
    const history = new SearchEvidenceHistory();
    history.remember(await loadSearchEvidencePrefix({ entries } as unknown as Pick<Conversation, "entries">, answer(200), BACKGROUND_CONTEXT));
    expect(history.project([answer(200)], extractDisplayMessages)).toMatchObject([{ id: 200 }]);
    expect(history.project([answer(200)], extractDisplayMessages)[0]?.sources).toBeUndefined();
  });
});
