import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchVertexPublicModels,
  parseVertexModelLifecycle,
  parseVertexPreviewModels,
  vertexPreviewDocumentUrls,
} from "../packages/hub/src/vertex-public-catalog";
import { fetchLiveProviderModels } from "../packages/hub/src/provider-discovery";
import { vertexLifecycleHtml, vertexPreviewDetailHtml, vertexPreviewOverviewHtml, vertexPublicCatalogDocuments } from "./helpers/vertex-public-catalog";

const now = new Date("2026-11-16T12:00:00Z");
const htmlResponse = (html: string, status = 200) => new Response(html, { status, headers: { "Content-Type": "text/html" } });

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(name, "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Vertex public model directory", () => {
  it("uses lifecycle ID cells and exact retirement dates, excluding navigation, replacements and future releases", () => {
    const html = vertexLifecycleHtml([
      { id: "gemini-4-carbon" },
      { id: "gemini-current", replacement: "gemini-not-published-replacement" },
      { id: "gemini-expired", retired: "November 15, 2026" },
      { id: "gemini-retired-today", retired: "November 16, 2026" },
      { id: "gemini-lower-bound", retired: "November 1, 2026 or later" },
      { id: "gemini-future", released: "November 17, 2026" },
      { id: "gemini-3.8-live" },
      { id: "gemini-3.8-flash-tts" },
      { id: "gemini-embedding-2" },
      { id: "gemini-omni-1.2-flash" },
      { id: "gemini-3.1-flash-image" },
    ], [{ id: "gemini-current" }, { id: "gemini-retired-section" }]);
    const result = parseVertexModelLifecycle(html, now);
    expect(result.models).toEqual([
      { id: "gemini-4-carbon" },
      { id: "gemini-lower-bound" },
      { id: "gemini-3.8-live", purpose: "live" },
      { id: "gemini-3.8-flash-tts", purpose: "tts" },
      { id: "gemini-3.1-flash-image", purpose: "image" },
    ]);
    expect([...result.retiredIds]).toEqual(["gemini-expired", "gemini-retired-today", "gemini-current", "gemini-retired-section"]);
  });

  it.each([
    "<table><tr><td>gemini-missing-body</td></tr></table>",
    '<div class="devsite-article-body"><table></table></div>',
    vertexLifecycleHtml([{ id: "gemini-invalid-date", released: "recently" }]),
    vertexLifecycleHtml([{ id: "gemini-invalid-date", retired: "soon" }]),
    vertexLifecycleHtml([{ id: "gemini-no-longer-current", retired: "November 1, 2026" }]),
  ])("fails explicitly when lifecycle structure cannot yield a complete directory", (html) => {
    expect(() => parseVertexModelLifecycle(html, now)).toThrow(/Google 官方/);
  });

  it("takes preview links only from the preview section on the fixed Google documentation origin", () => {
    const html = vertexPreviewOverviewHtml(["3-1-pro", "3-1-pro#versions", "3-flash"]).replace("</div><h2>Gemma", '<a href="https://elsewhere.example/gemini-enterprise-agent-platform/models/gemini/evil">Ignore</a><a href="https://user:password@docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/credentialed">Ignore</a><a href="javascript:alert(1)">Ignore</a></div><h2>Gemma');
    expect(vertexPreviewDocumentUrls(html).map((url) => url.href)).toEqual([
      "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro?hl=en",
      "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-flash?hl=en",
    ]);
    expect(() => vertexPreviewDocumentUrls(vertexPreviewOverviewHtml([]))).toThrow(/Preview/);
    expect(() => vertexPreviewDocumentUrls(vertexPreviewOverviewHtml(Array.from({ length: 25 }, (_, i) => `future-${i}`)))).toThrow(/上限/);
  });

  it("reads real preview version IDs and limits, removing footnotes without inferring IDs from links or code examples", () => {
    const html = vertexPreviewDetailHtml(["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools*"], { contextWindow: 1_048_576, maxTokens: 65_536 });
    expect(parseVertexPreviewModels(html, now)).toEqual([
      { id: "gemini-3.1-pro-preview", contextWindow: 1_048_576, maxTokens: 65_536 },
      { id: "gemini-3.1-pro-preview-customtools", contextWindow: 1_048_576, maxTokens: 65_536 },
    ]);
    expect(parseVertexPreviewModels(vertexPreviewDetailHtml(["gemini-future-preview"], { released: "November 17, 2026" }), now)).toEqual([]);
    expect(parseVertexPreviewModels(vertexPreviewDetailHtml(["gemini-omni-preview"]), now)).toEqual([]);
    expect(() => parseVertexPreviewModels(html.replace("Model ID", "Unknown field"), now)).toThrow(/Model ID/);
    expect(() => parseVertexPreviewModels(html.replaceAll("January 1, 2026", "recently"), now)).toThrow(/发布日期/);
  });

  it("merges current lifecycle and preview records, respecting explicit retired IDs", async () => {
    const docs = vertexPublicCatalogDocuments(["gemini-4-carbon", "gemini-4-hydrogen"], ["gemini-public-preview", "gemini-expired-preview"]);
    docs.set("/gemini-enterprise-agent-platform/models/model-versions", vertexLifecycleHtml([{ id: "gemini-4-carbon" }, { id: "gemini-4-hydrogen" }], [{ id: "gemini-expired-preview" }]));
    const seen: string[] = [];
    const models = await fetchVertexPublicModels(async (url) => {
      seen.push(url.href);
      const html = docs.get(url.pathname);
      if (!html) throw new Error("Unexpected documentation page");
      return htmlResponse(html);
    }, AbortSignal.timeout(2000));
    expect(models.map((model) => model.id)).toEqual(["gemini-4-carbon", "gemini-4-hydrogen", "gemini-public-preview"]);
    expect(seen).toHaveLength(3);
    expect(seen.every((url) => url.startsWith("https://docs.cloud.google.com/") && url.endsWith("?hl=en"))).toBe(true);
  });

  it("does not return a partial directory when a preview detail page fails", async () => {
    const docs = vertexPublicCatalogDocuments();
    await expect(fetchVertexPublicModels(async (url) => url.pathname.endsWith("fixture-preview")
      ? htmlResponse("Unavailable", 503) : htmlResponse(docs.get(url.pathname)!), AbortSignal.timeout(2000))).rejects.toThrow("HTTP 503");
  });

  it("bounds streamed HTML before parsing it and rejects non-HTML responses", async () => {
    await expect(fetchVertexPublicModels(async () => htmlResponse("x".repeat(4 * 1024 * 1024 + 1)), AbortSignal.timeout(2000))).rejects.toThrow(/大小限制/);
    await expect(fetchVertexPublicModels(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }), AbortSignal.timeout(2000))).rejects.toThrow(/HTML/);
  });

  it("cancels a stalled document body with the caller signal", async () => {
    const cancelled = vi.fn();
    const fetchPage = async () => new Response(new ReadableStream({ start() {}, cancel: cancelled }), { headers: { "Content-Type": "text/html" } });
    await expect(fetchVertexPublicModels(fetchPage, AbortSignal.timeout(40))).rejects.toThrow();
    expect(cancelled).toHaveBeenCalled();
  });

  it("never sends a supplied key or project to public documents and does not reuse a prior successful fetch", async () => {
    let generation = 0;
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({ url, init });
      if (url.pathname.endsWith("model-versions")) generation++;
      const docs = vertexPublicCatalogDocuments([`gemini-new-${generation}`]);
      return htmlResponse(docs.get(url.pathname)!);
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = { baseUrl: "https://aiplatform.googleapis.com/v1/projects/secret-project/locations/global", api: "google-vertex" as const, apiKey: "dummy-should-not-leave", signal: AbortSignal.timeout(2000) };
    expect((await fetchLiveProviderModels(request)).map((model) => model.id)).toContain("gemini-new-1");
    expect((await fetchLiveProviderModels(request)).map((model) => model.id)).toContain("gemini-new-2");
    for (const { url, init } of requests) {
      expect(url.origin).toBe("https://docs.cloud.google.com");
      expect(JSON.stringify(init.headers)).not.toMatch(/dummy-should-not-leave|secret-project|authorization|x-goog/i);
      expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    }
    fetchMock.mockImplementation(async () => htmlResponse("Unavailable", 503));
    await expect(fetchLiveProviderModels(request)).rejects.toThrow("HTTP 503");
  });
});
