import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import WebSocket, { WebSocketServer } from "ws";
import { createHubDevProxy } from "../dev-proxy";

describe("voice through the Web development proxy", () => {
  const upstream = http.createServer((request, response) => {
    const sameOrigin = request.headers.origin === `http://${request.headers.host}`;
    response.writeHead(sameOrigin ? 200 : 403, { "content-type": "application/json" });
    response.end(JSON.stringify({ origin: request.headers.origin, host: request.headers.host }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let proxy: http.Server;
  let vite: ViteDevServer;
  let origin: string;
  let upstreamOrigin: string;
  let received: { path?: string; origin?: string; host?: string };

  beforeAll(async () => {
    upstream.on("upgrade", (request, socket, head) => {
      if (request.headers.origin !== `http://${request.headers.host}`) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      received = { path: request.url, origin: request.headers.origin, host: request.headers.host };
      sockets.handleUpgrade(request, socket, head, (client) => {
        clients.add(client);
        client.once("close", () => clients.delete(client));
        client.on("message", (data) => client.send(data));
        client.send(JSON.stringify({ type: "state", state: "listening" }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
    proxy = http.createServer((request, response) => vite.middlewares(request, response, () => response.writeHead(404).end()));
    vite = await createServer({
      configFile: false,
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: { server: proxy }, hmr: false, proxy: { "/api": createHubDevProxy(upstreamOrigin) } },
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.terminate();
    await vite?.close();
    sockets.close();
    if (proxy?.listening) await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  it("upgrades the voice API socket and forwards audio controls with the matching Hub origin", async () => {
    const route = "/api/voice/calls/test-session/socket?clientId=voice-proxy-test";
    const client = new WebSocket(`${origin.replace(/^http/, "ws")}${route}`, { origin });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        client.once("message", (data) => resolve(String(data)));
        client.once("error", reject);
      });
      expect(JSON.parse(first)).toEqual({ type: "state", state: "listening" });
      expect(received).toEqual({ path: route, origin: upstreamOrigin, host: new URL(upstreamOrigin).host });
      const echoed = new Promise<string>((resolve, reject) => {
        client.once("message", (data) => resolve(String(data)));
        client.once("error", reject);
      });
      client.send(JSON.stringify({ type: "mute", muted: true }));
      expect(JSON.parse(await echoed)).toEqual({ type: "mute", muted: true });
    } finally { client.terminate(); }
  });

  it("keeps foreign WebSocket origins untrusted", async () => {
    const client = new WebSocket(`${origin.replace(/^http/, "ws")}/api/voice/calls/test-session/socket`, { origin: "http://foreign.invalid" });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        client.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
        client.once("open", () => reject(new Error("A foreign origin was accepted")));
        client.once("error", reject);
      });
      expect(status).toBe(403);
    } finally { client.on("error", () => undefined); client.terminate(); }
  });

  it("preserves the same origin check for ordinary API requests", async () => {
    const accepted = await fetch(`${origin}/api/voice`, { headers: { origin } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ origin: upstreamOrigin, host: new URL(upstreamOrigin).host });
    const rejected = await fetch(`${origin}/api/voice`, { headers: { origin: "http://foreign.invalid" } });
    expect(rejected.status).toBe(403);
  });
});
