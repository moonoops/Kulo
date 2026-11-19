import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ComputerPreviewSessionView, ComputerPreviewUpdate } from "@moco/protocol";
import { startMocoHubServer } from "@moco/hub";
import { attachComputerPreviewSocket, type ComputerPreviewSource } from "../packages/hub/src/computer-preview-socket.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send(value: string) { this.sent.push(JSON.parse(value) as Record<string, unknown>); }
  close = vi.fn((..._args: unknown[]) => { this.readyState = 3; this.emit("close"); });
  input(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
  ws() { return this as unknown as WebSocket; }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const session = (id = "preview-one"): ComputerPreviewSessionView => ({ id, ticketId: "task-one", tool: "browser", envId: "device-one", deviceName: "Mac", title: "浏览器" });
const frame = (data = "AQID"): ComputerPreviewUpdate => ({ state: "live", frame: { mimeType: "image/jpeg", data, capturedAt: 1000 } });
function fixture(input: Partial<ComputerPreviewSource> = {}, options: Parameters<typeof attachComputerPreviewSocket>[3] = {}) {
  vi.useFakeTimers();
  let update!: (value: ComputerPreviewUpdate) => void;
  const dispose = vi.fn();
  const source: ComputerPreviewSource = {
    listComputerPreviews: vi.fn(async () => [session()]),
    subscribeComputerPreview: vi.fn(async (_id, _topicId, callback) => { update = callback; return dispose; }),
    ...input,
  };
  const socket = new Socket();
  resources.push(attachComputerPreviewSocket(socket.ws(), source, "topic-one", options));
  return { socket, source, dispose, update: (value: ComputerPreviewUpdate) => update(value) };
}

describe("computer preview transport", () => {
  it("discovers only the selected topic, forwards frames outside chat and disposes on close", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.listComputerPreviews).toHaveBeenCalledWith("topic-one");
    expect(f.source.subscribeComputerPreview).toHaveBeenCalledWith("preview-one", "topic-one", expect.any(Function));
    expect(f.socket.sent[0]).toEqual({ type: "preview.sessions", sessions: [session()] });
    f.update(frame());
    expect(f.socket.sent.at(-1)).toEqual({ type: "preview.update", id: "preview-one", update: frame() });
    f.socket.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.source.listComputerPreviews).toHaveBeenCalledOnce();
  });

  it("disposes a pending subscription when collapsed and ignores its late frames", async () => {
    const pending = deferred<() => void>();
    let lateUpdate!: (value: ComputerPreviewUpdate) => void;
    const subscribeComputerPreview = vi.fn((_id, _topicId, callback) => { lateUpdate = callback; return pending.promise; });
    const f = fixture({ subscribeComputerPreview });
    await vi.advanceTimersByTimeAsync(0);
    f.socket.input({ type: "preview.visibility", visible: false });
    const staleDispose = vi.fn();
    pending.resolve(staleDispose);
    lateUpdate(frame());
    await vi.advanceTimersByTimeAsync(500);
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(f.socket.sent).toHaveLength(1);
    expect(f.source.listComputerPreviews).toHaveBeenCalledTimes(2);
    f.socket.input({ type: "preview.visibility", visible: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeComputerPreview).toHaveBeenCalledTimes(2);
  });

  it("releases a subscription which finishes after the session disappears", async () => {
    const pending = deferred<() => void>();
    const list = vi.fn().mockResolvedValueOnce([session()]).mockResolvedValue([]);
    const f = fixture({ listComputerPreviews: list, subscribeComputerPreview: vi.fn(() => pending.promise) });
    await vi.advanceTimersByTimeAsync(500);
    const dispose = vi.fn();
    pending.resolve(dispose);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.socket.sent.at(-1)).toEqual({ type: "preview.sessions", sessions: [] });
  });

  it("reopens a synchronously closed source after a quick reconnect and disposes its pending result", async () => {
    const pending = deferred<() => void>();
    const staleDispose = vi.fn();
    const freshDispose = vi.fn();
    let staleUpdate!: (value: ComputerPreviewUpdate) => void;
    const subscribe = vi.fn((_id, _topicId, callback: (value: ComputerPreviewUpdate) => void) => {
      if (subscribe.mock.calls.length === 1) {
        staleUpdate = callback;
        callback({ state: "closed" });
        return pending.promise;
      }
      return Promise.resolve(freshDispose);
    });
    const f = fixture({ subscribeComputerPreview: subscribe });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.sent.at(-1)).toMatchObject({ update: { state: "closed" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribe).toHaveBeenCalledTimes(2);
    pending.resolve(staleDispose);
    staleUpdate(frame());
    await vi.advanceTimersByTimeAsync(0);
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(f.socket.sent.filter((message) => (message.update as ComputerPreviewUpdate | undefined)?.frame)).toHaveLength(0);
    f.socket.close();
    expect(freshDispose).toHaveBeenCalledOnce();
  });

  it("discards a buffered screenshot and late frames as soon as the source closes", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    f.socket.bufferedAmount = 600_000;
    f.update(frame());
    f.update({ state: "closed" });
    f.update(frame("BAUG"));
    f.socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.socket.sent).toEqual([
      { type: "preview.sessions", sessions: [session()] },
      { type: "preview.update", id: "preview-one", update: { state: "closed" } },
    ]);
  });

  it("keeps only the latest frame for a slow consumer, including a single desktop screenshot", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    f.socket.bufferedAmount = 600_000;
    f.update(frame("AQID"));
    f.update(frame("BAUG"));
    expect(f.socket.sent).toHaveLength(1);
    f.socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.socket.sent).toHaveLength(2);
    expect(f.socket.sent[1]).toMatchObject({ update: frame("BAUG") });
  });

  it("clears pending frames on errors and reports a failed discovery without retaining subscriptions", async () => {
    const list = vi.fn().mockResolvedValueOnce([session()]).mockRejectedValue(new Error("private source detail"));
    const f = fixture({ listComputerPreviews: list });
    await vi.advanceTimersByTimeAsync(0);
    f.socket.bufferedAmount = 600_000;
    f.update(frame());
    await vi.advanceTimersByTimeAsync(500);
    f.socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.socket.sent).toContainEqual({ type: "preview.error", message: "暂时无法获取操作画面。" });
    expect(JSON.stringify(f.socket.sent)).not.toContain("private source detail");
    expect(f.socket.sent.filter((message) => message.type === "preview.update")).toHaveLength(0);
  });

  it("disposes even when a client disconnects before discovery or subscription completes", async () => {
    const listing = deferred<ComputerPreviewSessionView[]>();
    const f = fixture({ listComputerPreviews: vi.fn(() => listing.promise) });
    f.socket.close();
    listing.resolve([session()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.subscribeComputerPreview).not.toHaveBeenCalled();

    const subscribing = deferred<() => void>();
    const g = fixture({ subscribeComputerPreview: vi.fn(() => subscribing.promise) });
    await vi.advanceTimersByTimeAsync(0);
    g.socket.close();
    const dispose = vi.fn();
    subscribing.resolve(dispose);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stops forwarding immediately when the authenticated device is revoked", async () => {
    let active = true;
    const f = fixture({}, { isPrincipalActive: () => active });
    await vi.advanceTimersByTimeAsync(0);
    active = false;
    f.update(frame());
    expect(f.socket.close).toHaveBeenCalledWith(4001, "Preview authorization revoked");
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.socket.sent).toHaveLength(1);
  });

  it.each([
    { type: "input_mouse", x: 10, y: 10 },
    { type: "preview.visibility", visible: true, sessionId: "unrelated" },
    { type: "ticket.stop", ticketId: "unrelated" },
    { type: "preview.visibility", visible: "false" },
  ])("accepts no controls beyond visibility (%j)", async (command) => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    f.socket.input(command);
    expect(f.socket.close).toHaveBeenCalledWith(1008, "Invalid preview command");
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("retries a failed subscription without leaking its source error", async () => {
    const subscribe = vi.fn().mockRejectedValueOnce(new Error("private native detail")).mockResolvedValue(vi.fn());
    const f = fixture({ subscribeComputerPreview: subscribe });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.sent.at(-1)).toMatchObject({ update: { state: "unavailable" } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(subscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.socket.sent)).not.toContain("private native detail");
  });
});

async function previewServer(source: Partial<ComputerPreviewSource> = {}) {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_AUTH_TOKEN", "MOCO_ENV_TOKENS", "MOCO_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(key, "");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-preview-server-"));
  resources.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "preview-test-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { stateDir: directory, enableLocalEnv: false, authToken: HUB_TEST_ADMIN_TOKEN, envTokens: { node: "preview-env-only-token" }, workerEnvIds: ["node"], memory: { enabled: false }, watchdogMinutes: 0 } });
  resources.push(() => hub.close());
  const list = source.listComputerPreviews ?? vi.fn(async () => []);
  Object.assign(hub, { listComputerPreviews: list, subscribeComputerPreview: source.subscribeComputerPreview ?? vi.fn(async () => vi.fn()) });
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  resources.push(() => server.close());
  return { server, list, url: `${server.clientWsUrl.replace(/\/ws\/client$/, "/ws/computer-preview")}?topicId=topic-one` };
}

function upgradeStatus(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    ws.once("open", () => { ws.close(); resolve(101); });
    ws.once("error", reject);
  });
}

describe("computer preview WebSocket upgrade", () => {
  it("resumes a real preview socket when the Env reconnects before discovery sees it offline", async () => {
    const callbacks: Array<(value: ComputerPreviewUpdate) => void> = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const list = vi.fn(async () => [session()]);
    const subscribe = vi.fn(async (_id, _topicId, callback: (value: ComputerPreviewUpdate) => void) => {
      callbacks.push(callback);
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    });
    const f = await previewServer({ listComputerPreviews: list, subscribeComputerPreview: subscribe });
    const socket = new WebSocket(f.url, { headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
    resources.push(() => socket.terminate());
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString("utf8")) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    callbacks[0]!({ state: "closed" });
    callbacks[0]!(frame("AQID"));
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2), { timeout: 2000 });
    callbacks[1]!(frame("BAUG"));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "preview.update", id: "preview-one", update: frame("BAUG") }));
    expect(messages).not.toContainEqual({ type: "preview.update", id: "preview-one", update: frame("AQID") });
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(messages.filter((message) => message.type === "preview.sessions")).toHaveLength(1);
  });

  it("rejects anonymous, Env credentials and cross-origin browser requests; accepts same-origin management identity", async () => {
    const f = await previewServer();
    expect(await upgradeStatus(f.url)).toBe(401);
    expect(await upgradeStatus(f.url, { Authorization: "Bearer preview-env-only-token" })).toBe(401);
    expect(await upgradeStatus(f.url, { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, Origin: "https://unrelated.example" })).toBe(401);
    expect(await upgradeStatus(f.url, { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, Origin: f.server.url.replace(/^http:/, "https:") })).toBe(401);
    expect(await upgradeStatus(f.url, { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, Origin: f.server.url })).toBe(101);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledWith("topic-one"));
  });

  it("bounds preview connections per principal and closes them during server shutdown", async () => {
    const f = await previewServer();
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 4; index++) {
      const socket = new WebSocket(f.url, { headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    }
    expect(await upgradeStatus(f.url, { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` })).toBe(429);
    const closed = sockets.map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())));
    await f.server.close();
    await Promise.all(closed);
    resources.pop();
  });
});
