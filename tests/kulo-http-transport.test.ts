import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "../packages/hub/node_modules/undici/index.js";
import { proxyFetch, retainEnvironmentProxy } from "../packages/hub/src/http-transport.js";

const servers: http.Server[] = [];
const releases: Array<() => Promise<void>> = [];
async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}
function environment(proxy: string, noProxy = ""): void {
  for (const name of ["http_proxy", "https_proxy", "all_proxy", "ALL_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  vi.stubEnv("HTTP_PROXY", proxy); vi.stubEnv("HTTPS_PROXY", proxy); vi.stubEnv("NO_PROXY", noProxy);
}
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  vi.unstubAllEnvs();
});

describe("streaming provider and MCP transport", () => {
  it("keeps Node's built-in fetch compatible with Undici dispatchers for JSON POSTs", async () => {
    let body = "";
    const origin = await listen(http.createServer(async (req, res) => {
      for await (const chunk of req) body += chunk.toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }));
    environment("", "");
    releases.push(retainEnvironmentProxy());
    const response = await proxyFetch(`${origin}/probe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"test":"vertex"}' });
    expect(await response.json()).toEqual({ ok: true });
    expect(body).toBe('{"test":"vertex"}');
  });

  it("routes a streaming request through the configured proxy and returns before the body finishes", async () => {
    let finish!: () => void;
    const origin = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      finish = () => res.end("data: last\n\n");
    }));
    let proxyRequests = 0;
    const proxyServer = http.createServer((req, res) => {
      proxyRequests++;
      const forwarded = http.request(req.url!, { method: req.method, headers: req.headers }, (upstream) => {
        res.writeHead(upstream.statusCode!, upstream.headers);
        upstream.pipe(res);
      });
      forwarded.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(forwarded);
    });
    proxyServer.on("connect", (req, socket, head) => {
      proxyRequests++;
      const target = new URL(`http://${req.url}`);
      const upstream = net.connect(Number(target.port), target.hostname, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    environment(await listen(proxyServer));
    releases.push(retainEnvironmentProxy());
    const response = await proxyFetch(`${origin}/events`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    expect(proxyRequests).toBe(1);
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("last");
    await reader.cancel();

    const nativeResponse = await fetch(`${origin}/native-sdk`, { method: "POST", body: "{}", signal: AbortSignal.timeout(2_000) });
    const nativeReader = nativeResponse.body!.getReader();
    expect(new TextDecoder().decode((await nativeReader.read()).value)).toContain("first");
    expect(proxyRequests).toBe(2);
    finish();
    expect(new TextDecoder().decode((await nativeReader.read()).value)).toContain("last");
    await nativeReader.cancel();
  });

  it("honors NO_PROXY and refuses credential-bearing redirects", async () => {
    let destinationCalled = false;
    const destination = await listen(http.createServer((_req, res) => { destinationCalled = true; res.end("unexpected"); }));
    const origin = await listen(http.createServer((_req, res) => { res.writeHead(302, { location: destination }); res.end(); }));
    environment("http://127.0.0.1:1", "127.0.0.1");
    releases.push(retainEnvironmentProxy());
    await expect(proxyFetch(origin, { headers: { Authorization: "Bearer fixture-only" } })).rejects.toThrow();
    expect(destinationCalled).toBe(false);
  });

  it.each([301, 302, 303, 307, 308].flatMap((status) => [false, true].map((configuredProxy) => ({ status, configuredProxy }))))("blocks native SDK redirects carrying a Google key: %j", async ({ status, configuredProxy }) => {
    let destinationCalled = false;
    const destination = await listen(http.createServer((_req, res) => { destinationCalled = true; res.end("ok"); }));
    const origin = await listen(http.createServer((_req, res) => { res.writeHead(status, { location: destination }); res.end(); }));
    environment(configuredProxy ? "http://127.0.0.1:1" : "", "127.0.0.1");
    releases.push(retainEnvironmentProxy());
    await expect(fetch(new Request(origin, { method: "POST", body: "{}", headers: { "x-goog-api-key": "synthetic-google-key" } }))).rejects.toThrow();
    expect(destinationCalled).toBe(false);
    // Authentication flows without a Google API key retain their normal redirect behavior.
    expect(await (await fetch(origin)).text()).toBe("ok");
    expect(destinationCalled).toBe(true);
  });

  it("retains an existing dispatcher policy without destroying its owner on release", async () => {
    environment("");
    const origin = await listen(http.createServer((_req, res) => { res.end("ok"); }));
    const previous = getGlobalDispatcher();
    let requests = 0;
    const existing = new Agent().compose((dispatch) => (options, handler) => { requests++; return dispatch(options, handler); });
    setGlobalDispatcher(existing);
    const release = retainEnvironmentProxy();
    try {
      expect(await (await fetch(origin)).text()).toBe("ok");
      await release();
      expect(getGlobalDispatcher()).toBe(existing);
      expect(await (await fetch(origin)).text()).toBe("ok");
      expect(requests).toBe(2);
    } finally { await release(); setGlobalDispatcher(previous); await existing.destroy(); }
  });

  it("restores the SDK default dispatcher only after the final Hub releases its lease", async () => {
    environment("http://127.0.0.1:1");
    const previous = getGlobalDispatcher();
    const first = retainEnvironmentProxy();
    const active = getGlobalDispatcher();
    const second = retainEnvironmentProxy();
    expect(active).not.toBe(previous);
    await first(); expect(getGlobalDispatcher()).toBe(active);
    await second(); expect(getGlobalDispatcher()).toBe(previous);
  });
});
