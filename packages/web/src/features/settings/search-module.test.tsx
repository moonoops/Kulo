import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SearchPlanView, SearchSnapshot } from "@kulo/protocol";
import { SearchModule, SearchPlanFields, acceptSearchSnapshot, reorderedSearchIds, searchPlanDraft, searchPlanInput, type SearchPlanDraft } from "./search-module";

const plan: SearchPlanView = { id: "first", name: "Tavily 工作", adapter: "tavily", enabled: true, baseUrl: "https://mcp.tavily.com/mcp", hasCredential: true, revision: 3, status: "ready", createdAt: 1, updatedAt: 1 };
const draft: SearchPlanDraft = { original: plan, name: plan.name, adapter: "tavily", baseUrl: plan.baseUrl!, apiKey: "", enabled: true };
const fields = (value: SearchPlanDraft) => renderToStaticMarkup(<SearchPlanFields draft={value} onChange={() => {}} />);

function passwordInput(html: string): string {
  return html.match(/<input\b(?=[^>]*type="password")[^>]*>/)?.[0] ?? "";
}

describe("search plan ordering", () => {
  it("moves plans to either side of a target and preserves their relative priority", () => {
    expect(reorderedSearchIds(["a", "b", "c", "d"], new Set(["c", "d"]), "a", "before")).toEqual(["c", "d", "a", "b"]);
    expect(reorderedSearchIds(["a", "b", "c", "d"], new Set(["a"]), "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(reorderedSearchIds(["a", "b", "c"], new Set(["c", "a"]), "b", "after")).toEqual(["b", "a", "c"]);
  });
  it("ignores self-drops and stale or external drag identifiers", () => {
    const ids = ["a", "b", "c"];
    expect(reorderedSearchIds(ids, new Set(["a"]), "a", "after")).toBe(ids);
    expect(reorderedSearchIds(ids, new Set(["external"]), "b", "before")).toBe(ids);
    expect(reorderedSearchIds(ids, new Set(["a"]), "removed", "before")).toBe(ids);
  });
});

describe("search health snapshots", () => {
  it("ignores an older health response with an identical configuration revision", () => {
    const ready: SearchSnapshot = { revision: 4, healthRevision: 7, plans: [plan] };
    const stale: SearchSnapshot = { revision: 4, healthRevision: 6, plans: [{ ...plan, status: "error", error: "旧请求失败" }] };
    expect(acceptSearchSnapshot(ready, stale)).toBe(ready);
    expect(acceptSearchSnapshot(stale, ready)).toBe(ready);
  });
  it("takes newer configuration and rejects an old list even with later health information", () => {
    const previous: SearchSnapshot = { revision: 4, healthRevision: 7, plans: [plan] };
    const removed: SearchSnapshot = { revision: 5, healthRevision: 7, plans: [] };
    expect(acceptSearchSnapshot(previous, removed)).toBe(removed);
    expect(acceptSearchSnapshot(removed, { ...previous, healthRevision: 8 })).toBe(removed);
  });
});

describe("third-party search settings", () => {
  it("keeps the search columns and add action available for an empty loaded list", () => {
    const html = renderToStaticMarkup(<SearchModule snapshot={{ revision: 1, plans: [] }} connected onRefresh={() => {}} />);
    expect(html).toContain("kulo-search-plan-head");
    expect(html).toContain("搜索调用优先级");
    expect(html).toContain("尚未添加搜索方案");
    expect(html).toContain("添加搜索方案");
    expect(html).not.toContain("加载搜索配置");
    const waiting = renderToStaticMarkup(<SearchModule connected onRefresh={() => {}} />);
    expect(waiting).toContain("加载搜索配置");
    expect(waiting).not.toContain("尚未添加搜索方案");
  });

  it("does not offer model selection in any third-party service form", () => {
    for (const adapter of ["exa", "tavily", "brave", "duckduckgo"] as const) {
      const html = fields({ ...draft, adapter });
      expect(html).not.toContain("模型原生搜索");
      expect(html).not.toContain("搜索模型");
      expect(html).not.toContain("模型服务");
    }
  });
  it("offers Exa without a required key and DuckDuckGo without a key field", () => {
    const exa = fields({ ...draft, original: undefined, adapter: "exa", baseUrl: "https://mcp.exa.ai/mcp" });
    expect(exa).toContain("MCP 地址");
    expect(exa).toContain("免费搜索可留空");
    expect(passwordInput(exa)).not.toContain("required");
    const duck = fields({ ...draft, original: undefined, adapter: "duckduckgo" });
    expect(duck).not.toContain("API Key");
    expect(duck).not.toContain('type="url"');
  });
  it("keeps omitted keys out of update payloads and trims new credentials", () => {
    expect(searchPlanInput(draft)).not.toHaveProperty("apiKey");
    expect(searchPlanInput({ ...draft, apiKey: "  new-api-key  " })).toHaveProperty("apiKey", "new-api-key");
    const html = fields(draft);
    expect(html).toContain('type="password"');
    expect(html).toContain("已保存，留空保留");
    expect(passwordInput(html)).not.toContain("required");
  });
  it("requires account credentials for Tavily and Brave and a new key after changing origin", () => {
    expect(passwordInput(fields({ ...draft, original: undefined }))).toContain("required");
    expect(passwordInput(fields({ ...draft, original: undefined, adapter: "brave" }))).toContain("required");
    const changed = fields({ ...draft, baseUrl: "https://other.example/mcp" });
    expect(changed).not.toContain("已保存，留空保留");
    expect(passwordInput(changed)).toContain("required");
  });
  it("restores the fixed Brave endpoint when editing an old custom API plan and requires a replacement key", () => {
    const legacy: SearchPlanView = { ...plan, adapter: "brave", baseUrl: "https://legacy.example/v1", hasCredential: false, status: "needs_auth" };
    const repaired = searchPlanDraft(legacy);
    expect(repaired.baseUrl).toBe("https://api.search.brave.com");
    const html = fields(repaired);
    expect(html).not.toContain("legacy.example");
    expect(html).not.toContain("已保存，留空保留");
    expect(passwordInput(html)).toContain("required");
    expect(searchPlanInput({ ...repaired, apiKey: " replacement-key " })).toMatchObject({ id: plan.id, expectedRevision: plan.revision, adapter: "brave", baseUrl: "https://api.search.brave.com", apiKey: "replacement-key" });
  });
  it("requires a new Tavily key after the API-to-MCP origin migration", () => {
    const migrated = searchPlanDraft({ ...plan, baseUrl: "https://mcp.tavily.com/mcp", hasCredential: false, status: "needs_auth" });
    const html = fields(migrated);
    expect(html).toContain("https://mcp.tavily.com/mcp");
    expect(html).not.toContain("已保存，留空保留");
    expect(passwordInput(html)).toContain("required");
    expect(searchPlanInput(migrated)).not.toHaveProperty("apiKey");
  });
  it("uses preset transport identities for Brave and DuckDuckGo and does not send obsolete model fields", () => {
    expect(searchPlanInput({ ...draft, adapter: "brave", baseUrl: "https://other.example", apiKey: " brv-new " })).toEqual({ id: plan.id, expectedRevision: plan.revision, name: plan.name, adapter: "brave", enabled: true, baseUrl: "https://api.search.brave.com", apiKey: "brv-new" });
    const duck = searchPlanInput({ ...draft, adapter: "duckduckgo", baseUrl: "https://other.example", apiKey: "unrelated-value" });
    expect(duck).toMatchObject({ adapter: "duckduckgo", baseUrl: "https://duckduckgo.com" });
    expect(duck).not.toHaveProperty("apiKey");
    expect(duck).not.toHaveProperty("providerId");
    expect(duck).not.toHaveProperty("modelId");
  });
  it("renders priorities and drag controls for duplicate backend types", () => {
    const html = renderToStaticMarkup(<SearchModule snapshot={{ revision: 5, plans: [plan, { ...plan, id: "second", name: "Tavily 备用" }] }} connected onRefresh={() => {}} />);
    expect(html).toContain("搜索调用优先级");
    expect(html).toContain("调整Tavily 工作的优先级");
    expect(html).toContain("调整Tavily 备用的优先级");
    expect(html).toContain("优先级 1");
    expect(html).toContain("优先级 2");
    const switches = html.match(/<input\b(?=[^>]*role="switch")[^>]*>/g) ?? [];
    expect(switches).toHaveLength(2);
    for (const name of ["Tavily 工作", "Tavily 备用"]) {
      expect(html).toContain(`aria-label="重新测试${name}"`);
      expect(html).toContain(`aria-label="编辑${name}"`);
      expect(html).toContain(`启用${name}`);
    }
    for (const control of switches) expect(control).toContain('checked=""');
  });
  it("separates the drag handle, numeric priority, plan name, service and row actions", () => {
    const custom = { ...plan, name: "日常搜索", adapter: "exa" as const, hasCredential: false, status: "unverified" as const };
    const html = renderToStaticMarkup(<SearchModule snapshot={{ revision: 5, plans: [custom] }} connected onRefresh={() => {}} />);
    const header = html.match(/class="kulo-search-plan-head[^\"]*"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    const headings = [...header.matchAll(/<span\b[^>]*>(.*?)<\/span>/g)].map((match) => match[1]);
    expect(headings).toEqual(["", "优先级", "方案名称", "搜索服务", "状态", "启用", "操作"]);
    expect(header).toContain('class="text-center">优先级');
    expect(html).toMatch(/aria-label="调整日常搜索的优先级"[\s\S]*?aria-label="优先级 1">1<\/span>/);
    const name = html.match(/class="kulo-search-plan-name[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    expect(name).toContain("日常搜索");
    expect(name).not.toContain("Exa");
    const service = html.match(/class="kulo-search-plan-service[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    expect(service).toContain("Exa");
    expect(service).toContain("免费");
    const actions = html.match(/class="kulo-search-plan-actions[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    expect([...actions.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual(["测试日常搜索", "编辑日常搜索", "删除日常搜索"]);
    expect(header).toContain('class="text-center">启用');
    expect(header).toContain('class="text-center">操作');
    expect(html).toContain("kulo-search-plan-actions flex w-full items-center justify-center");
  });
  it("shows status as information and keeps initial tests and retests in the actions column", () => {
    for (const status of ["unverified", "ready"] as const) {
      const html = renderToStaticMarkup(<SearchModule snapshot={{ revision: 5, plans: [{ ...plan, status }] }} connected onRefresh={() => {}} />);
      const statusCell = html.match(/class="kulo-search-plan-status"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
      expect(statusCell).not.toContain("<button");
      expect(statusCell).toContain("chip");
      expect(statusCell).toContain(status === "ready" ? "可用" : "未测试");
      const actions = html.match(/class="kulo-search-plan-actions[^>]*>(.*?)<\/div>/)?.[1] ?? "";
      expect(actions).toContain(`aria-label="${status === "ready" ? "重新测试" : "测试"}${plan.name}"`);
      expect(actions).toContain(">测试</span>");
      expect(actions).not.toContain(">可用<");
      expect(html).not.toContain("待验证");
      expect(html).not.toContain("测试通过");
    }
  });
  it("shows a failure once in its own row with a retest action", () => {
    const failed: SearchPlanView = { ...plan, status: "error", error: "请检查搜索服务的网络连接。", failure: { kind: "network", message: "请检查搜索服务的网络连接。", retryable: true } };
    const html = renderToStaticMarkup(<SearchModule snapshot={{ revision: 5, healthRevision: 1, plans: [failed] }} connected onRefresh={() => {}} />);
    expect(html.split("请检查搜索服务的网络连接。")).toHaveLength(2);
    expect(html).toContain('aria-label="重新测试Tavily 工作"');
    expect(html).toContain("连接失败");
    expect(html).not.toContain("搜索配置未完成");
  });
});
