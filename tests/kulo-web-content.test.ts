import { describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { extractReadablePage, fetchWebPage, normalizeWebSourceUrl, readWebResponseText, safeWebRequest, sanitizeSearchSuggestions, searchApiFetch } from "../packages/hub/src/web-content";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

describe("public web page extraction", () => {
  it("extracts article text, meaningful links, code and Unicode without page chrome", () => {
    const raw = '<html><head><title>Search documentation</title></head><body><nav>Account settings login</nav><main><article><h1>联网搜索</h1><p>这是正文。Read the <a href="/api/search">API reference</a> for the complete endpoint details and parameter descriptions.</p><p>We preserve useful article structure and source links while discarding navigation and script content.</p><ul><li>First feature</li><li>Second feature</li></ul><pre>const result = search();\nconsole.log(result);</pre></article></main><footer>Copyright navigation</footer><script>untrusted()</script></body></html>';
    const result = extractReadablePage(raw, "https://docs.example.com/start");
    expect(result.title).toBeTruthy();
    expect(result.content).toContain("联网搜索");
    expect(result.content).toContain("[API reference](https://docs.example.com/api/search)");
    expect(result.content).toContain("- First feature");
    expect(result.content).toContain("```\nconst result = search();");
    expect(result.content).not.toMatch(/Account settings|Copyright navigation|untrusted/);
    expect(result.sources[0]?.url).toBe("https://docs.example.com/start");
  });

  it("keeps markdown and reports bounded output truncation", () => {
    const result = extractReadablePage(`# Markdown title\n\n${"evidence ".repeat(9000)}`, "https://example.com/markdown", "text/markdown");
    expect(result.title).toBe("Markdown title");
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(48_000);
  });

  it("keeps stable IDs for the same canonical source URL", () => {
    const first = extractReadablePage("first", "https://example.com/path#section", "text/plain");
    const second = extractReadablePage("second", "https://example.com/path#section", "text/plain");
    expect(first.sources[0]?.id).toBe(second.sources[0]?.id);
    expect(first.url).toBe("https://example.com/path#section");
  });

  it.each([
    "file:///etc/passwd", "ftp://example.com/a", "http://localhost/a", "http://127.1/a", "http://2130706433/a", "http://10.2.3.4/a",
    "http://172.20.0.1/a", "http://192.168.0.1/a", "http://169.254.169.254/latest", "http://100.100.100.200/a", "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a", "http://[fc00::1]/a", "http://metadata.google.internal/a", "https://user:secret@example.com/a", "https://example.com\\@localhost/a",
  ])("rejects non-public or credential-bearing URL %s", (url) => {
    expect(normalizeWebSourceUrl(url)).toBeUndefined();
    expect(() => extractReadablePage("text", url, "text/plain")).toThrow("公开");
  });

  it("validates every redirect before fetching it and never sends a private target to Tavily", async () => {
    const http = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
    await expect(fetchWebPage({ url: "https://example.com/public", fetch: http, tavily: { baseUrl: "https://api.tavily.com", apiKey: "fixture" } })).rejects.toThrow("公开");
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("follows bounded public redirects and uses the final URL for relative links", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/docs/page" } }))
      .mockResolvedValueOnce(new Response('<html><body><article><h1>Docs</h1><p>Read <a href="./next">next page</a>.</p></article></body></html>', { headers: { "Content-Type": "text/html" } }));
    const result = await fetchWebPage({ url: "https://example.com/start", fetch: http });
    expect(result.url).toBe("https://example.com/docs/page");
    expect(result.content).toContain("https://example.com/docs/next");
    expect(http.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("uses Tavily Extract after a blocked direct page and checks the per-URL result", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response("Blocked", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: "https://example.com/article", raw_content: "# Extracted title\n\nFull extracted article." }], failed_results: [] })));
    const result = await fetchWebPage({ url: "https://example.com/article", fetch: http, tavily: { baseUrl: "https://api.tavily.com", apiKey: "extract-fixture" } });
    expect(result.content).toContain("Full extracted article.");
    expect(http.mock.calls[1]?.[0]).toBe("https://api.tavily.com/extract");
    expect(http.mock.calls[1]?.[1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer extract-fixture" } });
  });

  it("treats HTTP 200 with only failed_results as an extraction failure", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response("Blocked", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [], failed_results: [{ url: "https://example.com/article", error: "Could not fetch" }] })));
    await expect(fetchWebPage({ url: "https://example.com/article", fetch: http, tavily: { baseUrl: "https://api.tavily.com", apiKey: "fixture" } })).rejects.toThrow("未能读取");
  });

  it("does not use an unrelated extraction result as the requested page", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response("Blocked", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: "https://example.com/other", raw_content: "Wrong article" }] })));
    await expect(fetchWebPage({ url: "https://example.com/article", fetch: http, tavily: { baseUrl: "https://api.tavily.com", apiKey: "fixture" } })).rejects.toThrow("未能读取");
  });

  it("does not fall back after cancellation", async () => {
    const abort = new AbortController();
    const http = vi.fn(async () => { abort.abort(); throw abort.signal.reason; });
    await expect(fetchWebPage({ url: "https://example.com/article", fetch: http, signal: abort.signal, tavily: { baseUrl: "https://api.tavily.com", apiKey: "fixture" } })).rejects.toMatchObject({ name: "AbortError" });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("limits streamed and declared body sizes", async () => {
    await expect(readWebResponseText(new Response("too long"), 3)).rejects.toThrow("大小限制");
    await expect(readWebResponseText(new Response("tiny", { headers: { "content-length": "9999999" } }))).rejects.toThrow("大小限制");
  });

  it("rejects binary content instead of passing it to the model", async () => {
    const http = vi.fn(async () => new Response("binary", { headers: { "Content-Type": "application/pdf" } }));
    await expect(fetchWebPage({ url: "https://example.com/file.pdf", fetch: http })).rejects.toThrow("文本网页");
  });

  it("bounds the number of redirects", async () => {
    const http = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/next" } }));
    await expect(safeWebRequest("https://example.com/start", { fetch: http })).rejects.toThrow("重定向次数过多");
    expect(http).toHaveBeenCalledTimes(6);
  });

  it("sanitizes Google search suggestion HTML without executing or embedding a foreign page", () => {
    const html = '<style>.chip{color:red}</style><a href="https://www.google.com/search?q=test" onclick="run()">Google</a><a href="javascript:run()">Bad</a><script>secret()</script><iframe src="https://evil.example.com"></iframe><base href="https://evil.example.com"><form action="https://evil.example.com"><input value="secret"></form><img src="http://127.0.0.1/image" onerror="run()">';
    const sanitized = sanitizeSearchSuggestions(html);
    expect(sanitized).toContain('<style>.chip{color:red}</style>');
    expect(sanitized).toContain('target="_blank"');
    expect(sanitized).toContain('rel="noopener noreferrer"');
    expect(sanitized).not.toMatch(/script|iframe|<base|<form|onclick|onerror|javascript:|127\.0\.0\.1/);
    expect(sanitizeSearchSuggestions("a".repeat(24_001))).toBe("");
  });

  it("removes CSS and SVG image channels that could reach private network targets", () => {
    const html = '<style>@import "https://127.0.0.1/a";</style><style>.a{background:u/**/rl(https://192.168.1.1/pixel)}</style><div style="background:image-set(\'https://10.0.0.1/pixel\' 1x)">Google Search</div><style>.escaped{background:u\\72l(https://internal.example.com/pixel)}</style><svg><image href="https://127.0.0.1/pixel"/></svg><img src="https://google.com/logo" srcset="https://127.0.0.1/pixel 2x"><a href="https://www.google.com/search?q=test">Search</a>';
    const sanitized = sanitizeSearchSuggestions(html);
    expect(sanitized).toContain("Google Search");
    expect(sanitized).toContain("https://www.google.com/search?q=test");
    expect(sanitized).not.toMatch(/@import|background|<svg|<image|srcset|\bsrc=|127\.0\.0\.1|192\.168|10\.0\.0\.1/);
  });

  it("rejects a public hostname resolving to a private address before opening a socket", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    await expect(safeWebRequest("https://rebinding.example.com/page")).rejects.toThrow("受限地址");
  });

  it("does not forward genuinely private DNS targets to a remote extractor", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }] as never);
    const original = globalThis.fetch;
    const http = vi.fn();
    globalThis.fetch = http;
    try {
      await expect(fetchWebPage({ url: "https://rebinding.example.com/page", tavily: { baseUrl: "https://api.tavily.com", apiKey: "fixture" } })).rejects.toThrow("受限地址");
      expect(http).not.toHaveBeenCalled();
    } finally { globalThis.fetch = original; }
  });

  it("can extract a public hostname remotely when local proxy DNS returns Fake-IP", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "198.18.1.2", family: 4 }] as never);
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
    const original = globalThis.fetch;
    const http = vi.fn(async () => new Response(JSON.stringify({ results: [{ url: "https://example.com/page", raw_content: "# Remote page\n\nPublic content" }] })));
    globalThis.fetch = http;
    try {
      const result = await fetchWebPage({ url: "https://example.com/page", tavily: { baseUrl: "https://api.tavily.com", apiKey: "fixture" } });
      expect(result.content).toContain("Public content");
      expect(http.mock.calls[0]?.[0]).toEqual(new URL("https://api.tavily.com/extract"));
    } finally { globalThis.fetch = original; vi.unstubAllEnvs(); }
  });

  it("pins public DNS through a configured HTTP proxy and confines proxy auth to CONNECT", async () => {
    const sockets = new Set<Socket>();
    let connectTarget = "";
    let host = "";
    let proxyAuthAtOrigin: string | undefined;
    const origin = createServer((req, res) => {
      host = req.headers.host ?? "";
      proxyAuthAtOrigin = req.headers["proxy-authorization"] as string | undefined;
      res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Public article");
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originPort = (origin.address() as { port: number }).port;
    const proxy = createServer();
    proxy.on("connect", (req, client, head) => {
      connectTarget = req.url ?? "";
      const upstream = connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      sockets.add(client); sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    vi.stubEnv("HTTP_PROXY", `http://fixture-user:fixture-password@127.0.0.1:${proxyPort}`);
    vi.stubEnv("http_proxy", ""); vi.stubEnv("NO_PROXY", ""); vi.stubEnv("no_proxy", "");
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never);
    try {
      const result = await safeWebRequest("http://rebinding.example.com/article");
      expect(await result.response.text()).toBe("Public article");
      expect(connectTarget).toBe("93.184.216.34:80");
      expect(host).toBe("rebinding.example.com");
      expect(proxyAuthAtOrigin).toBeUndefined();
      const api = await searchApiFetch("http://service.invalid/search", { method: "POST", headers: { Authorization: "Bearer fixture-api-key" }, body: "{}" });
      expect(await api.text()).toBe("Public article");
      expect(connectTarget).toBe("service.invalid:80");
      expect(proxyAuthAtOrigin).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      for (const socket of sockets) socket.destroy();
      origin.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]);
    }
  });
});
