import type { SearchPlanView, WebPageResult, WebSearchInput, WebSource } from "@kulo/protocol";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeWebSourceUrl, validatePublicWebUrl, webSourceId } from "./web-content.js";
import { classifySearchMcpError, duckProxyForTarget, searchAdapterFailure, withSearchMcp, type SearchMcpOptions, type SearchMcpResult, type SearchMcpSession } from "./search-mcp.js";

export { SearchAdapterError } from "./search-mcp.js";
export interface SearchAdapterResult { answer?: string; sources: WebSource[] }
export interface SearchAdapterOptions extends SearchMcpOptions { plan: SearchPlanView; input: WebSearchInput }
type ObjectValue = Record<string, unknown>;
const MAX_RESULT_CHARS = 200_000;
const MAX_PAGE_CHARS = 48_000;
function object(value: unknown): ObjectValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown, max = 12_000): string | undefined { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined; }
function contents(result: SearchMcpResult): string[] {
  const values = result.content.filter((part) => part.type === "text").map((part) => part.text);
  if (values.reduce((sum, value) => sum + value.length, 0) > MAX_RESULT_CHARS || object(result.structuredContent)?.truncated === true) throw searchAdapterFailure("upstream");
  return values;
}
function structured(result: SearchMcpResult): ObjectValue | undefined {
  contents(result);
  if (result.structuredContent && JSON.stringify(result.structuredContent).length > MAX_RESULT_CHARS) throw searchAdapterFailure("upstream");
  if (result.structuredContent) return object(result.structuredContent);
  const values = contents(result);
  if (values.length === 1) { try { return object(JSON.parse(values[0]!)); } catch { /* Some official tools format their result as labeled text. */ } }
  return undefined;
}
function source(raw: unknown): WebSource | undefined {
  const item = object(raw); if (!item || item.error) return undefined;
  const url = normalizeWebSourceUrl(item.url ?? item.uri); if (!url) return undefined;
  const content = text(item.raw_content ?? item.text ?? item.content ?? array(item.highlights).join("\n"));
  const snippet = text(item.snippet ?? item.description ?? item.content ?? array(item.highlights).join("\n"), 2000);
  const publishedAt = text(item.published_date ?? item.publishedDate, 100);
  return { id: webSourceId(url), url, title: text(item.title, 500) ?? new URL(url).hostname,
    ...(snippet ? { snippet } : {}), ...(content ? { content } : {}), ...(publishedAt ? { publishedAt } : {}), fetchedAt: Date.now() };
}
function matches(url: string, domain: string): boolean { const host = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); const target = domain.toLowerCase().replace(/^\*\./, ""); return host === target || host.endsWith(`.${target}`); }
function sources(values: unknown[], input: WebSearchInput): WebSource[] {
  const result = new Map<string, WebSource>();
  let valid = 0;
  for (const value of values) {
    const item = source(value);
    if (!item) continue;
    valid++;
    if (input.includeDomains?.length && !input.includeDomains.some((domain) => matches(item.url, domain)) || input.excludeDomains?.some((domain) => matches(item.url, domain))) continue;
    if (!result.has(item.url)) result.set(item.url, item);
  }
  const bounded = [...result.values()].slice(0, Math.max(1, Math.min(input.maxResults ?? 5, 10)));
  if (values.length && !valid) throw searchAdapterFailure("ungrounded");
  return bounded;
}
function tool(session: SearchMcpSession, names: string[]): Tool {
  const found = names.map((name) => session.tools.find((candidate) => candidate.name === name)).find(Boolean);
  if (!found) throw searchAdapterFailure("unsupported_tool");
  return found;
}
function argsFor(target: Tool, values: ObjectValue): ObjectValue {
  const properties = object(target.inputSchema.properties) ?? {};
  const args = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== undefined && (Object.hasOwn(properties, key) || target.inputSchema.additionalProperties !== false)));
  if (array(target.inputSchema.required).some((key) => typeof key === "string" && !Object.hasOwn(args, key))) throw searchAdapterFailure("unsupported_tool");
  return args;
}

/** Parse only the documented Title/URL records, never arbitrary links embedded in prose. */
function labeledResults(value: string, adapter: "exa" | "tavily"): ObjectValue[] {
  if (adapter === "tavily" && !value.includes("Detailed Results:")) return [];
  const body = adapter === "tavily" ? value.slice(value.indexOf("Detailed Results:") + "Detailed Results:".length) : value;
  return body.split(/\n(?=Title: )|\n\n(?=URL: )/).flatMap((block) => {
    const header = /^\s*(?:Title: ([^\n]+)\n)?(?:ID: [^\n]*\n)?URL: (https?:\/\/[^\s]+)\n?/.exec(block);
    if (!header || adapter === "exa" && !header[1]) return [];
    const rest = block.slice(header[0].length).replace(/\n\n---\s*$/, "");
    const published = /^Published: ([^\n]+)/m.exec(rest)?.[1];
    const snippet = /^(?:Content:|Highlights:|Text:)\s*([\s\S]*)/m.exec(rest)?.[1];
    return [{ title: header[1], url: header[2], ...(published && published !== "N/A" ? { publishedDate: published } : {}), ...(snippet ? { content: snippet.replace(/\nRaw Content:[\s\S]*$/, "") } : {}), raw_content: /^Raw Content:\s*([\s\S]*)/m.exec(rest)?.[1] }];
  });
}
function exaResults(result: SearchMcpResult): unknown[] {
  const data = structured(result); if (data && Array.isArray(data.results)) return data.results;
  const values = contents(result).flatMap((value) => labeledResults(value, "exa"));
  if (!values.length && !contents(result).some((value) => /no (?:search )?results(?: found)?/i.test(value))) throw searchAdapterFailure("upstream");
  return values;
}
function tavilyResults(result: SearchMcpResult): unknown[] {
  const data = structured(result); if (data && Array.isArray(data.results)) return data.results;
  const values = contents(result).flatMap((value) => labeledResults(value, "tavily"));
  if (!values.length && !contents(result).some((value) => value.includes("Detailed Results:") && !value.split("Detailed Results:")[1]?.trim() || /no (?:search )?results/i.test(value))) throw searchAdapterFailure("upstream");
  return values;
}
function braveResults(result: SearchMcpResult): unknown[] {
  const data = structured(result); const grounding = object(data?.grounding);
  if (grounding && Array.isArray(grounding.generic)) {
    const metadata = object(data?.sources);
    return [...grounding.generic, ...array(grounding.map), ...(object(grounding.poi) ? [grounding.poi] : [])].map((value) => {
      const entry = object(value) ?? {}; const details = typeof entry.url === "string" ? object(metadata?.[entry.url]) : undefined;
      return { ...entry, content: array(entry.snippets).filter((item) => typeof item === "string").join("\n\n"), published_date: array(details?.age)[1] };
    });
  }
  if (Array.isArray(data?.results)) return data.results;
  const blocks = contents(result); if (!blocks.length) return [];
  const entries = blocks.flatMap((value) => { try { const parsed: unknown = JSON.parse(value); return object(parsed) ? [parsed] : []; } catch { return []; } });
  if (!entries.length) throw searchAdapterFailure("upstream");
  return entries;
}
async function duckResults(session: SearchMcpSession, result: SearchMcpResult): Promise<unknown[]> {
  const data = structured(result);
  if (data && Array.isArray(data.queries)) return data.queries.flatMap((query) => array(object(query)?.results));
  if (data && Array.isArray(data.results)) return data.results;
  const raw = contents(result).join("\n");
  if (!/^\*\*Provider:\*\* duckduckgo\b/m.test(raw)) throw searchAdapterFailure("upstream");
  const error = /^Error: (.+)/m.exec(raw)?.[1]; if (error) throw classifySearchMcpError(error);
  if (/No results found\./.test(raw)) return [];
  const id = /Full search results are stored as responseId "([A-Za-z0-9_-]+)"/.exec(raw)?.[1];
  if (id && session.tools.some((candidate) => candidate.name === "get_search_content")) {
    const full = await session.call("get_search_content", { responseId: id, queryIndex: 0, offset: 0, limit: 100_000 });
    const value = contents(full).join("\n");
    if (/^Error retrieving query /m.test(value)) throw classifySearchMcpError(value);
    if (/Showing chars \d+-\d+ of \d+/.test(value)) throw searchAdapterFailure("upstream");
    if (!/^## Results for: /m.test(value) || !/^\*\*Provider:\*\* duckduckgo\b/m.test(value)) throw searchAdapterFailure("upstream");
    return value.split(/\n(?=### )/).flatMap((block) => {
      const item = /^### ([^\n]+)\n(https?:\/\/[^\s]+)(?:\n\n([\s\S]*))?$/.exec(block.trim());
      return item ? [{ title: item[1], url: item[2], content: item[3] }] : [];
    });
  }
  if (/truncat|Showing chars/i.test(raw)) throw searchAdapterFailure("upstream");
  const values: ObjectValue[] = [];
  for (const item of raw.matchAll(/^\d+\. ([^\n]+)\n {3}(https?:\/\/[^\s]+)\s*$/gm)) values.push({ title: item[1], url: item[2] });
  if (!values.length) throw searchAdapterFailure("upstream");
  return values;
}
function constraints(input: WebSearchInput): string {
  return [input.includeDomains?.length ? `Only use ${input.includeDomains.join(", ")}.` : "", input.excludeDomains?.length ? `Exclude ${input.excludeDomains.join(", ")}.` : "", input.timeRange ? `Use sources from the past ${input.timeRange}.` : ""].filter(Boolean).join(" ");
}
export async function runSearchAdapter(options: SearchAdapterOptions): Promise<SearchAdapterResult> {
  return withSearchMcp(options, async (session) => {
    let values: unknown[];
    if (options.plan.adapter === "exa") {
      const target = tool(session, ["web_search_exa"]);
      values = exaResults(await session.call(target.name, argsFor(target, { query: options.input.query, objective: `Find reliable sources answering this query. ${constraints(options.input)}`.trim(), numResults: options.input.maxResults ?? 5 })));
    } else if (options.plan.adapter === "tavily") {
      const target = tool(session, ["tavily_search", "tavily-search"]); const minimum = Number(object(object(target.inputSchema.properties)?.max_results)?.minimum) || 1;
      values = tavilyResults(await session.call(target.name, argsFor(target, { query: options.input.query, max_results: Math.max(minimum, options.input.maxResults ?? 5), search_depth: "basic", include_raw_content: false, include_domains: options.input.includeDomains, exclude_domains: options.input.excludeDomains, time_range: options.input.timeRange })));
    } else if (options.plan.adapter === "brave") {
      const target = tool(session, ["brave_llm_context", "brave_web_search"]);
      const query = [options.input.query, options.input.includeDomains?.length ? `(${options.input.includeDomains.map((domain) => `site:${domain}`).join(" OR ")})` : "", ...(options.input.excludeDomains ?? []).map((domain) => `-site:${domain}`)].filter(Boolean).join(" ");
      const range = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
      values = braveResults(await session.call(target.name, argsFor(target, { query, count: options.input.maxResults ?? 5, maximum_number_of_urls: options.input.maxResults ?? 5, maximum_number_of_tokens: 8192, enable_source_metadata: true, extra_snippets: true, ...(options.input.timeRange ? { freshness: range[options.input.timeRange] } : {}) })));
    } else {
      const target = tool(session, ["web_search"]);
      values = await duckResults(session, await session.call(target.name, argsFor(target, { query: options.input.query, numResults: options.input.maxResults ?? 5, provider: "duckduckgo", includeContent: false,
        domainFilter: [...(options.input.includeDomains ?? []), ...(options.input.excludeDomains ?? []).map((domain) => `-${domain}`)], recencyFilter: options.input.timeRange, proxy: duckProxyForTarget("https://html.duckduckgo.com/html/") })));
    }
    return { sources: sources(values, options.input) };
  });
}
function pageFromRecord(value: unknown, requested: string): WebPageResult | undefined {
  const item = object(value); if (!item || item.error || item.truncated === true) return undefined;
  const url = normalizeWebSourceUrl(item.url); if (url !== requested) return undefined;
  const content = text(item.raw_content ?? item.text ?? item.content, MAX_PAGE_CHARS + 1); if (!content) return undefined;
  const title = text(item.title, 500) ?? /^#\s+([^\n]+)/m.exec(content)?.[1] ?? new URL(url).hostname;
  return { url, title, content: content.slice(0, MAX_PAGE_CHARS), truncated: content.length > MAX_PAGE_CHARS,
    sources: [{ id: webSourceId(url), url, title, snippet: content.slice(0, 600), fetchedAt: Date.now() }] };
}
export async function fetchSearchPageAdapter(options: SearchMcpOptions, value: string): Promise<WebPageResult | undefined> {
  const url = validatePublicWebUrl(value).toString(); if (options.plan.adapter === "brave") return undefined;
  return withSearchMcp(options, async (session) => {
    const target = options.plan.adapter === "exa" ? tool(session, ["web_fetch_exa"]) : options.plan.adapter === "tavily" ? tool(session, ["tavily_extract", "tavily-extract"]) : tool(session, ["fetch_content"]);
    const result = await session.call(target.name, argsFor(target, options.plan.adapter === "exa" ? { urls: [url], maxCharacters: MAX_PAGE_CHARS + 1 } : options.plan.adapter === "tavily" ? { urls: [url], format: "markdown", extract_depth: "advanced", include_images: false } : { url, mode: "readable", proxy: duckProxyForTarget(url) }));
    const data = structured(result);
    if (data) {
      for (const entry of [...array(data.results), ...array(data.urls)]) { const page = pageFromRecord(entry, url); if (page) return page; }
      throw searchAdapterFailure("upstream");
    }
    const raw = contents(result).join("\n");
    if (options.plan.adapter === "tavily") {
      for (const entry of labeledResults(raw, "tavily")) { const page = pageFromRecord(entry, url); if (page) return page; }
    } else if (options.plan.adapter === "exa") {
      const match = /^# ([^\n]+)\nURL: (https?:\/\/[^\s]+)\n(?:(?:Published|Author): [^\n]*\n)*\n([\s\S]+)$/.exec(raw.trim());
      if (match) { const page = pageFromRecord({ title: match[1], url: match[2], text: match[3] }, url); if (page) return page; }
    } else {
      if (/Showing \d+ of \d+ chars|truncated at the output limit/i.test(raw)) throw searchAdapterFailure("upstream");
      const body = raw.replace(/\n---\nFull content is stored as responseId[\s\S]*$/, "").trim();
      if (body && !/^Error:|^## Fetched URLs/i.test(body)) { const page = pageFromRecord({ url, text: body }, url); if (page) return page; }
    }
    throw searchAdapterFailure("upstream");
  });
}
