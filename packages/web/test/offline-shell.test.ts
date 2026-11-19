import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const origin = "https://kulo.test";
const rootUrl = `${origin}/`;
const markerUrl = `${origin}/.kulo-offline-ready`;
const prefix = "kulo-offline-shell-v1-";
const source = fs.readFileSync(new URL("../public/kulo-offline.js", import.meta.url), "utf8");
const shell = (version: number) => `<!doctype html><html><head><link rel="stylesheet" href="/assets/index-v${version}.css"></head><body><div id="root"></div><script type="module" src="/assets/index-v${version}.js"></script></body></html>`;
const response = (text: string, contentType = "text/html", status = 200) => new Response(text, { status, headers: { "Content-Type": contentType, "Content-Security-Policy": "default-src 'self'" } });
const keyOf = (request: string | Request) => typeof request === "string" ? new URL(request, rootUrl).href : request.url;

class MemoryCache {
  readonly rows = new Map<string, Response>();
  constructor(private readonly host: MemoryCaches) {}
  async match(request: string | Request) { return this.rows.get(keyOf(request))?.clone(); }
  async put(request: string | Request, value: Response) {
    const key = keyOf(request);
    if (this.host.rejectPut?.(key)) throw new Error("Cache storage is full");
    this.rows.set(key, value.clone());
  }
}
class MemoryCaches {
  readonly rows = new Map<string, MemoryCache>();
  rejectPut?: (key: string) => boolean;
  async keys() { return [...this.rows.keys()]; }
  async open(name: string) {
    const existing = this.rows.get(name);
    if (existing) return existing;
    const cache = new MemoryCache(this); this.rows.set(name, cache); return cache;
  }
  async match(request: string | Request, options?: { cacheName?: string }) {
    if (options?.cacheName) return this.rows.get(options.cacheName)?.match(request);
    for (const cache of this.rows.values()) { const value = await cache.match(request); if (value) return value; }
    return undefined;
  }
  async delete(name: string) { return this.rows.delete(name); }
}

type WorkerEvent = { request?: { url: string; method: string; mode: string }; respondWith?: (value: Promise<Response>) => void; waitUntil?: (value: Promise<unknown>) => void };
function worker(caches = new MemoryCaches()) {
  let version = 1;
  let offline = false;
  const routes = new Map<string, () => Response | Promise<Response>>();
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const warnings = vi.fn();
  const fetch = vi.fn(async (request: Request) => {
    if (offline) throw new TypeError("Network is offline");
    const route = routes.get(request.url);
    if (route) return route();
    if (request.url === rootUrl) return response(shell(version));
    if (new URL(request.url).pathname.startsWith("/assets/")) return response("public build", request.url.endsWith(".css") ? "text/css" : "text/javascript");
    throw new Error("Unexpected intercepted URL");
  });
  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});
  vm.runInNewContext(source, {
    self: { location: { origin }, addEventListener: (type: string, listener: (event: WorkerEvent) => void) => listeners.set(type, listener), skipWaiting, clients: { claim } },
    caches, fetch, Request, Response, Headers, URL, AbortController, Uint8Array, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout,
    console: { warn: warnings },
  });
  const lifecycle = async (type: string) => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (value) => pending.push(value) });
    await Promise.all(pending);
  };
  const request = (path: string, options: { mode?: string; method?: string } = {}) => {
    let result: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: { url: new URL(path, rootUrl).href, method: options.method ?? "GET", mode: options.mode ?? "navigate" }, respondWith: (value) => { result = value; } });
    return result;
  };
  return { caches, fetch, routes, warnings, skipWaiting, claim, lifecycle, request, setVersion: (value: number) => { version = value; }, setOffline: (value: boolean) => { offline = value; } };
}

async function completedNames(caches: MemoryCaches) {
  const names: string[] = [];
  for (const name of await caches.keys()) if (name.startsWith(prefix) && await caches.match(markerUrl, { cacheName: name })) names.push(name);
  return names;
}

describe("offline application shell", () => {
  it("installs a complete public shell before activation and retains its CSP", async () => {
    const w = worker();
    await w.lifecycle("install");
    await w.lifecycle("activate");
    expect(w.skipWaiting).toHaveBeenCalledOnce();
    expect(w.claim).toHaveBeenCalledOnce();
    const names = await completedNames(w.caches);
    expect(names).toHaveLength(1);
    const cached = await w.caches.match(rootUrl, { cacheName: names[0] });
    expect(await cached!.text()).toBe(shell(1));
    expect(cached!.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect([...w.caches.rows.get(names[0]!)!.rows.keys()].sort()).toEqual([markerUrl, rootUrl, `${origin}/assets/index-v1.css`, `${origin}/assets/index-v1.js`].sort());
    for (const [request] of w.fetch.mock.calls) {
      expect(request.credentials).toBe("omit");
      expect(new URL(request.url).search).toBe("");
      expect(request.headers.has("Authorization")).toBe(false);
    }
  });

  it("refreshes a token-bearing root URL from the canonical shell without caching the token", async () => {
    const w = worker();
    await w.lifecycle("install");
    w.fetch.mockClear();
    const online = await w.request("/?token=synthetic-test-value&topic=root")!;
    expect(await online.text()).toBe(shell(1));
    expect(w.fetch.mock.calls[0]![0].url).toBe(rootUrl);
    w.setOffline(true);
    const offline = await w.request("/index.html?token=synthetic-test-value")!;
    expect(await offline.text()).toBe(shell(1));
    expect([...w.caches.rows.values()].flatMap((cache) => [...cache.rows.keys()]).every((key) => !new URL(key).search)).toBe(true);
  });

  it.each([
    "/api/voice", "/api/uploads/attachment-one", "/api/oauth/callback?code=test-code", "/ws/client", "/private/report.html",
    "/assets/private.js?token=test-value", "https://other.test/assets/index.js",
  ])("does not intercept private, authenticated or foreign request %s", (path) => {
    const w = worker();
    expect(w.request(path, { mode: path.includes(".js") ? "cors" : "navigate" })).toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.request(path, { method: "POST" })).toBeUndefined();
  });

  it("keeps a previous complete shell when a new entry cannot be cached", async () => {
    const w = worker();
    await w.lifecycle("install");
    w.setVersion(2);
    w.routes.set(`${origin}/assets/index-v2.js`, () => response("not found", "text/html", 404));
    const online = await w.request("/")!;
    expect(await online.text()).toBe(shell(1));
    expect(await completedNames(w.caches)).toHaveLength(1);
    expect(w.warnings).toHaveBeenCalled();
    w.setOffline(true);
    expect(await (await w.request("/")!).text()).toBe(shell(1));
    expect(await (await w.request("/assets/index-v1.js", { mode: "cors" })!).text()).toBe("public build");
  });

  it("does not replace a complete shell with a partial version before its entry finishes", async () => {
    const w = worker();
    await w.lifecycle("install");
    w.setVersion(2);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    w.routes.set(`${origin}/assets/index-v2.js`, async () => { entered(); await gate; return response("new public code", "text/javascript"); });
    const updating = w.request("/")!;
    await waiting;
    w.setOffline(true);
    expect(await (await w.request("/")!).text()).toBe(shell(1));
    w.setOffline(false); release();
    expect(await (await updating).text()).toBe(shell(2));
    w.setOffline(true);
    expect(await (await w.request("/")!).text()).toBe(shell(2));
  });

  it("keeps only two completed versions and leaves other cache namespaces alone", async () => {
    const w = worker();
    await w.caches.open("unrelated-app-cache");
    await w.lifecycle("install");
    w.setVersion(2); await w.request("/");
    w.setVersion(3); await w.request("/");
    expect(await completedNames(w.caches)).toHaveLength(2);
    expect(w.caches.rows.has("unrelated-app-cache")).toBe(true);
    w.setOffline(true);
    expect(await (await w.request("/")!).text()).toBe(shell(3));
  });

  it("does not cache an authorization page or hide its successful network response", async () => {
    const w = worker();
    await w.lifecycle("install");
    w.routes.set(rootUrl, () => response("<html><form>Authentication required</form></html>"));
    expect(await (await w.request("/")!).text()).toContain("Authentication required");
    w.setOffline(true);
    expect(await (await w.request("/")!).text()).toBe(shell(1));
  });

  it("does not hide a current authorization rejection behind the old shell", async () => {
    const w = worker();
    await w.lifecycle("install");
    w.routes.set(rootUrl, () => response("Access denied", "text/plain", 401));
    const rejected = await w.request("/")!;
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).toBe("Access denied");
  });

  it("preserves a usable network page and reports cache write failure on a first visit", async () => {
    const w = worker(); w.caches.rejectPut = () => true;
    expect(await (await w.request("/")!).text()).toBe(shell(1));
    expect(await completedNames(w.caches)).toHaveLength(0);
    expect(w.warnings).toHaveBeenCalled();
  });

  it("does not activate an incomplete first installation", async () => {
    const w = worker();
    w.routes.set(`${origin}/assets/index-v1.css`, () => response("missing", "text/plain", 404));
    await expect(w.lifecycle("install")).rejects.toThrow("entry asset");
    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(await completedNames(w.caches)).toHaveLength(0);
  });
});
