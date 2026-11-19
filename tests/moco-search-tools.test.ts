import { describe, expect, it, vi } from "vitest";
import type { EntryRecord, ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SearchFailure, WebSource } from "@moco/protocol";
import { extractDisplayMessages } from "../packages/hub/src/hub.js";
import { createWebSearchTool } from "../packages/hub/src/tools-search.js";
import { SearchError, type MocoSearch } from "../packages/hub/src/search.js";

const source: WebSource = { id: "source-docs", title: "Official docs", url: "https://example.com/docs", snippet: "Documented behavior." };
const entry = (id: number, kind: string, model?: unknown[], data?: unknown) => ({ id, conversationId: 1, kind, model, data }) as unknown as EntryRecord;
const user = (id = 1) => entry(id, "pi.user", [{ role: "user", content: "查询资料", timestamp: 1 }]);
const result = (id = 2, extra: Record<string, unknown> = {}) => entry(id, "pi.tool-result", [{ role: "toolResult", toolName: "web_search", isError: false,
  content: [{ type: "text", text: "Sources" }], details: { sources: [source], ...extra } }]);
const answer = (text: string, id = 3) => entry(id, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text }], timestamp: 2 }]);

describe("search tool and durable source projection", () => {
  it("passes filters to the independent search service and persists source details for citations", async () => {
    const searchResult = { query: "current docs", planId: "search-one", planName: "Tavily one", sources: [source], attempts: [] };
    const search = vi.fn(async () => searchResult);
    const tool = createWebSearchTool(() => ({ search }) as unknown as MocoSearch);
    const response = await tool.execute({ query: "current docs", max_results: 3, include_domains: ["example.com"], time_range: "week" }, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(search).toHaveBeenCalledWith({ query: "current docs", maxResults: 3, includeDomains: ["example.com"], excludeDomains: undefined, timeRange: "week" }, undefined);
    expect(response.details).toMatchObject({ sources: [source] });
    expect(response.output?.[0]).toMatchObject({ text: expect.stringContaining("Cite supporting sources") });
  });

  it("returns structured provider failures to the model without confusing upstream authentication with Hub authentication", async () => {
    const failure: SearchFailure = { kind: "auth", message: "搜索服务认证失败，请检查此方案的 API Key。", upstreamStatus: 401, upstreamCode: "invalid_api_key", requestId: "req-search-test", retryable: false };
    const attempts = [{ planId: "account-one", name: "Tavily one", error: failure.message, failure }];
    const search = vi.fn(async () => { throw new SearchError(502, "search_all_failed", failure.message, failure, attempts); });
    const tool = createWebSearchTool(() => ({ search }) as unknown as MocoSearch);
    const response = await tool.execute({ query: "current docs" }, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(response.isError).toBe(true);
    expect(response.details).toMatchObject({ failure, attempts });
    expect(response.output?.[0]).toMatchObject({ text: expect.stringContaining(failure.message) });
    expect(JSON.stringify(response)).not.toContain("apiKey");
  });

  it("retains only actually cited search evidence after reconstructing durable history", () => {
    const entries = [user(), result(), answer("According to [the documentation](https://example.com/docs).")];
    expect(extractDisplayMessages(JSON.parse(JSON.stringify(entries))).at(-1)?.sources).toEqual([source]);
    expect(extractDisplayMessages([user(), result(), answer("No source was used.")]).at(-1)?.sources).toBeUndefined();
  });

  it("attaches evidence to structured published answers and keeps grounding suggestions isolated metadata", () => {
    const html = "<div>Search suggestions</div>";
    const publication = entry(3, "moco.content_publication", undefined, { parts: [{ type: "markdown", partId: "body", text: "[Docs](https://example.com/docs)" }], fallbackText: "Published answer" });
    expect(extractDisplayMessages([user(), result(2, { searchSuggestions: html }), publication]).at(-1)).toMatchObject({ sources: [source], searchSuggestions: [html] });
  });

  it("does not borrow sources from an earlier user turn or failed tool result", () => {
    expect(extractDisplayMessages([user(), result(), user(4), answer("[Docs](https://example.com/docs)", 5)]).at(-1)?.sources).toBeUndefined();
    const failed = result(); (failed.model![0] as unknown as { isError: boolean }).isError = true;
    expect(extractDisplayMessages([user(), failed, answer("[Docs](https://example.com/docs)")]).at(-1)?.sources).toBeUndefined();
  });

  it("carries evidence from background Worker reports into the main assistant answer", () => {
    const relay = entry(2, "moco.worker_relay", undefined, { ticketId: "ticket", title: "Research", role: "researcher", state: "ready", summary: "Found docs", deliverable: "[Docs](https://example.com/docs)", question: null, sources: [source] });
    expect(extractDisplayMessages([user(), relay, answer("[Docs](https://example.com/docs)")]).at(-1)?.sources).toEqual([source]);
  });
});
