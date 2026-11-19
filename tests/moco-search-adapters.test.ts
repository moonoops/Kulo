import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchPlanView } from "../packages/protocol/src/search";
import { fetchSearchPageAdapter, runSearchAdapter } from "../packages/hub/src/search-adapters";
import * as mcp from "../packages/hub/src/search-mcp";
import type { SearchMcpResult, SearchMcpSession } from "../packages/hub/src/search-mcp";
import { startSearchMcpFixture } from "../packages/hub/test/search-mcp-fixture";

function plan(adapter: SearchPlanView["adapter"], overrides: Partial<SearchPlanView> = {}): SearchPlanView {
  return { id: "search-1", name: "Search", adapter, enabled: true, hasCredential: false, revision: 1, status: "unverified", createdAt: 1, updatedAt: 1, ...overrides };
}
function tool(name: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, inputSchema: { type: "object" as const, properties, required, additionalProperties: false } };
}
const exaSearch = tool("web_search_exa", { query: { type: "string" }, objective: { type: "string" }, numResults: { type: "number" } }, ["query", "objective"]);
const exaFetch = tool("web_fetch_exa", { urls: { type: "array", items: { type: "string" } }, maxCharacters: { type: "number" } }, ["urls"]);
const localFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "127.0.0.1") throw new Error("Tests must not call a remote service");
  return fetch(request);
};
const fixtures: Awaited<ReturnType<typeof startSearchMcpFixture>>[] = [];
async function fixture(options: Parameters<typeof startSearchMcpFixture>[0]) { const server = await startSearchMcpFixture(options); fixtures.push(server); return server; }
function mockSession(tools: SearchMcpSession["tools"], call: SearchMcpSession["call"]) {
  const session = { tools, call: vi.fn(call) };
  vi.spyOn(mcp, "withSearchMcp").mockImplementation(async (_options, run) => run(session));
  return session;
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(fixtures.splice(0).map((server) => server.close())); });

describe("official remote MCP search adapters", () => {
  it("uses Exa's discovered schema and filters, deduplicates, and bounds grounded sources", async () => {
    const server = await fixture({ tools: [exaSearch], onCall: () => ({ content: [{ type: "text", text: "[Prose](https://misleading.example.net/)" }], structuredContent: { results: [
      { title: "Docs", url: "https://docs.example.com/search#api", highlights: ["Fresh passage"], publishedDate: "2026-11-16" },
      { title: "Private", url: "http://127.0.0.1/admin" }, { title: "Other", url: "https://other.example.net/a" },
      { title: "Duplicate", url: "https://docs.example.com/search#api" }, { title: "Docs two", url: "https://docs.example.com/two" },
    ] } }) });
    const result = await runSearchAdapter({ plan: plan("exa", { baseUrl: server.url }), input: { query: "docs", maxResults: 1, includeDomains: ["example.com"], excludeDomains: ["ads.example.com"], timeRange: "week" }, fetch: localFetch });
    expect(server.calls).toEqual([{ name: "web_search_exa", args: { query: "docs", numResults: 1, objective: "Find reliable sources answering this query. Only use example.com. Exclude ads.example.com. Use sources from the past week." } }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ title: "Docs", url: "https://docs.example.com/search#api", content: "Fresh passage", publishedAt: "2026-11-16", id: expect.stringMatching(/^source-[a-f0-9]{16}$/) });
    expect(server.activeSessions).toBe(0);
  });

  it("uses provider-specific auth and independent account sessions", async () => {
    const server = await fixture({ tools: [exaSearch, tool("tavily_search", { query: {}, max_results: { minimum: 5 }, include_raw_content: { type: "boolean" }, time_range: {}, include_domains: {}, exclude_domains: {}, search_depth: {} }, ["query"])], onCall: () => ({ content: [], structuredContent: { results: [] } }) });
    const observed: Array<{ bearer: string | null; key: string | null }> = [];
    const recording: typeof fetch = (input, init) => { const request = new Request(input, init); observed.push({ bearer: request.headers.get("authorization"), key: request.headers.get("x-api-key") }); return localFetch(request); };
    await runSearchAdapter({ plan: plan("exa", { baseUrl: server.url }), apiKey: "exa-account-a", input: { query: "a" }, fetch: recording });
    expect(observed.every((entry) => entry.key === "exa-account-a" && entry.bearer === null)).toBe(true);
    observed.length = 0;
    await runSearchAdapter({ plan: plan("tavily", { baseUrl: server.url }), apiKey: "tavily-account-b", input: { query: "b", maxResults: 2, timeRange: "month", includeDomains: ["example.com"] }, fetch: recording });
    expect(observed.every((entry) => entry.bearer === "Bearer tavily-account-b" && entry.key === null)).toBe(true);
    expect(server.calls[1]).toMatchObject({ name: "tavily_search", args: { query: "b", max_results: 5, include_raw_content: false, time_range: "month", include_domains: ["example.com"] } });
    expect(server.connections).toBe(2); expect(server.activeSessions).toBe(0);
  });

  it.each(["exa", "tavily"] as const)("accepts official %s labeled results", async (adapter) => {
    const server = await fixture({ tools: [tool(adapter === "exa" ? "web_search_exa" : "tavily_search", { query: {}, objective: {} }, ["query"])], onCall: () => ({ content: [{ type: "text", text: `${adapter === "tavily" ? "Request ID: req_12345678\nDetailed Results:\n\n" : ""}Title: Official docs\nURL: https://example.com/docs\nContent: Search excerpt\nRaw Content: Full page\n\nTitle: Two\nURL: https://example.com/two\nContent: Other passage` }] }) });
    const result = await runSearchAdapter({ plan: plan(adapter, { baseUrl: server.url }), apiKey: adapter === "tavily" ? "fixture" : undefined, input: { query: "docs" }, fetch: localFetch });
    expect(result.sources.map((source) => source.url)).toEqual(["https://example.com/docs", "https://example.com/two"]);
    expect(result.sources[0]).toMatchObject({ snippet: "Search excerpt", content: "Full page" });
  });

  it("does not turn a prose markdown link into a search result", async () => {
    const server = await fixture({ tools: [exaSearch], onCall: () => ({ content: [{ type: "text", text: "Try [this page](https://example.com/) for details." }] }) });
    await expect(runSearchAdapter({ plan: plan("exa", { baseUrl: server.url }), input: { query: "docs" }, fetch: localFetch })).rejects.toMatchObject({ failure: { kind: "upstream" } });
    expect(server.activeSessions).toBe(0);
  });

  it.each([
    { results: [], expected: "empty" },
    { results: [{ url: "http://169.254.169.254/latest", title: "Metadata" }], expected: "ungrounded" },
    { results: [{ url: "https://example.com/a" }], truncated: true, expected: "upstream" },
    { results: [{ url: "https://example.com/a", text: "x".repeat(200_001) }], expected: "upstream" },
  ])("distinguishes empty, unsafe and incomplete results ($expected)", async ({ expected, ...data }) => {
    const server = await fixture({ tools: [exaSearch], onCall: () => ({ content: [], structuredContent: data }) });
    const result = runSearchAdapter({ plan: plan("exa", { baseUrl: server.url }), input: { query: "q" }, fetch: localFetch });
    if (expected === "empty") expect((await result).sources).toEqual([]);
    else await expect(result).rejects.toMatchObject({ failure: { kind: expected } });
    expect(server.activeSessions).toBe(0);
  });

  it("reports missing official tools without calling unrelated tools", async () => {
    const server = await fixture({ tools: [tool("random_search", { query: {} })], onCall: () => ({ content: [] }) });
    await expect(runSearchAdapter({ plan: plan("exa", { baseUrl: server.url }), input: { query: "q" }, fetch: localFetch })).rejects.toMatchObject({ failure: { kind: "unsupported_tool" } });
    expect(server.calls).toHaveLength(0);
  });
});

describe("MCP page reading", () => {
  it("reads Exa full content through its official urls tool", async () => {
    const server = await fixture({ tools: [exaFetch], onCall: () => ({ content: [], structuredContent: { results: [{ title: "Full page", url: "https://example.com/page", text: "A full article with evidence." }] } }) });
    const result = await fetchSearchPageAdapter({ plan: plan("exa", { baseUrl: server.url }), fetch: localFetch }, "https://example.com/page");
    expect(server.calls).toEqual([{ name: "web_fetch_exa", args: { urls: ["https://example.com/page"], maxCharacters: 48001 } }]);
    expect(result).toMatchObject({ title: "Full page", content: "A full article with evidence.", truncated: false, sources: [{ url: "https://example.com/page" }] });
  });

  it("accepts Tavily extract's official optional-title text format", async () => {
    const server = await fixture({ tools: [tool("tavily_extract", { urls: {}, format: {}, extract_depth: {}, include_images: {} }, ["urls"])], onCall: () => ({ content: [{ type: "text", text: "Detailed Results:\n\nURL: https://example.com/page\nRaw Content: # Article\n\nComplete article content." }] }) });
    const result = await fetchSearchPageAdapter({ plan: plan("tavily", { baseUrl: server.url }), apiKey: "fixture", fetch: localFetch }, "https://example.com/page");
    expect(result).toMatchObject({ title: "Article", content: "# Article\n\nComplete article content." });
    expect(server.calls[0]?.args).toMatchObject({ format: "markdown", extract_depth: "advanced", include_images: false });
  });

  it("accepts official Exa formatted page content", async () => {
    const server = await fixture({ tools: [exaFetch], onCall: () => ({ content: [{ type: "text", text: "# Page title\nURL: https://example.com/page\nPublished: 2026-11-16\nAuthor: Writer\n\nFull content." }] }) });
    expect(await fetchSearchPageAdapter({ plan: plan("exa", { baseUrl: server.url }), fetch: localFetch }, "https://example.com/page")).toMatchObject({ title: "Page title", content: "Full content." });
  });

  it("rejects private input before connecting, mismatched pages, and partial extraction", async () => {
    const server = await fixture({ tools: [exaFetch], onCall: () => ({ content: [], structuredContent: { results: [{ url: "https://other.example.com/", text: "Other content" }], failed_results: [{ url: "https://example.com/page", error: "timeout" }] } }) });
    const options = { plan: plan("exa", { baseUrl: server.url }), fetch: localFetch };
    await expect(fetchSearchPageAdapter(options, "http://127.0.0.1/admin")).rejects.toThrow("公开");
    expect(server.connections).toBe(0);
    await expect(fetchSearchPageAdapter(options, "https://example.com/page")).rejects.toMatchObject({ failure: { kind: "upstream" } });
  });
});

describe("official stdio provider normalization", () => {
  it("uses Brave's query schema and grounded metadata", async () => {
    const session = mockSession([tool("brave_llm_context", { query: {}, count: {}, maximum_number_of_urls: {}, maximum_number_of_tokens: {}, enable_source_metadata: {}, freshness: {} }, ["query"])], async () => ({ content: [], structuredContent: { grounding: { generic: [{ url: "https://example.com/brave", title: "Brave", snippets: ["First chunk", "Second chunk"] }] }, sources: { "https://example.com/brave": { age: ["Monday", "2026-11-16"] } } } }));
    const result = await runSearchAdapter({ plan: plan("brave"), apiKey: "fixture", input: { query: "docs", maxResults: 3, includeDomains: ["example.com"], excludeDomains: ["ads.example.com"], timeRange: "day" } });
    expect(session.call).toHaveBeenCalledWith("brave_llm_context", { query: "docs (site:example.com) -site:ads.example.com", count: 3, maximum_number_of_urls: 3, maximum_number_of_tokens: 8192, enable_source_metadata: true, freshness: "pd" });
    expect(result.sources[0]).toMatchObject({ content: "First chunk\n\nSecond chunk", publishedAt: "2026-11-16" });
    expect(await fetchSearchPageAdapter({ plan: plan("brave") }, "https://example.com/page")).toBeUndefined();
  });

  it("reads Brave web search's separate JSON blocks", async () => {
    mockSession([tool("brave_web_search", { query: {}, count: {}, extra_snippets: {} }, ["query"])], async () => ({ content: [{ type: "text", text: JSON.stringify({ url: "https://example.com/a", title: "Web result", description: "Useful excerpt" }) }] }));
    expect((await runSearchAdapter({ plan: plan("brave"), apiKey: "fixture", input: { query: "q" } })).sources[0]).toMatchObject({ title: "Web result", snippet: "Useful excerpt" });
  });

  it("pins DuckDuckGo and reads its official stored search content", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1234"); vi.stubEnv("https_proxy", ""); vi.stubEnv("NO_PROXY", ""); vi.stubEnv("no_proxy", "");
    const search = tool("web_search", { query: {}, numResults: {}, provider: {}, includeContent: {}, domainFilter: {}, recencyFilter: {}, proxy: {} });
    const session = mockSession([search, tool("get_search_content", { responseId: {}, queryIndex: {}, offset: {}, limit: {} })], async (name): Promise<SearchMcpResult> => ({ content: [{ type: "text", text: name === "web_search" ? '**Provider:** duckduckgo\n\n1. Docs\n   https://example.com/docs\n\n---\nFull search results are stored as responseId "stored-1". Use get_search_content.' : '## Results for: "query"\n\n**Provider:** duckduckgo\n\n### Docs\nhttps://example.com/docs\n\nOfficial snippet\n\n' }] }));
    const result = await runSearchAdapter({ plan: plan("duckduckgo"), input: { query: "docs", timeRange: "week", excludeDomains: ["ads.example.com"] } });
    expect(session.call.mock.calls[0]).toEqual(["web_search", { query: "docs", numResults: 5, provider: "duckduckgo", includeContent: false, domainFilter: ["-ads.example.com"], recencyFilter: "week", proxy: "http://127.0.0.1:1234/" }]);
    expect(session.call.mock.calls[1]).toEqual(["get_search_content", { responseId: "stored-1", queryIndex: 0, offset: 0, limit: 100000 }]);
    expect(result.sources[0]).toMatchObject({ title: "Docs", content: "Official snippet" });
  });

  it("rejects a different Duck provider and incomplete stored content", async () => {
    const tools = [tool("web_search", { provider: {}, query: {} }), tool("get_search_content", {})];
    let response = "**Provider:** auto\n\n1. Docs\n   https://example.com/docs";
    mockSession(tools, async () => ({ content: [{ type: "text", text: response }] }));
    const options = { plan: plan("duckduckgo"), input: { query: "docs" } };
    await expect(runSearchAdapter(options)).rejects.toMatchObject({ failure: { kind: "upstream" } });
    response = '**Provider:** duckduckgo\n\n---\nFull search results are stored as responseId "stored-1".\nShowing chars 0-100 of 200.';
    await expect(runSearchAdapter(options)).rejects.toMatchObject({ failure: { kind: "upstream" } });
  });

  it("reads Duck HTTP-only pages without retaining retrieval hints", async () => {
    const session = mockSession([tool("fetch_content", { url: {}, mode: {}, proxy: {} })], async () => ({ content: [{ type: "text", text: '# Article\n\nFull article.\n---\nFull content is stored as responseId "stored-1". Use get_search_content.' }] }));
    const result = await fetchSearchPageAdapter({ plan: plan("duckduckgo") }, "https://example.com/page");
    expect(session.call.mock.calls[0]?.[1]).toMatchObject({ url: "https://example.com/page", mode: "readable" });
    expect(result).toMatchObject({ title: "Article", content: "# Article\n\nFull article." });
  });
});
