import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerPreviewUpdate, ComputerUseResult, HubToEnvControlMessage } from "@kulo/protocol";
import { ComputerUseService } from "../packages/env/src/computer-use.js";
import type { AgentCliRunner } from "../packages/env/src/agent-cli.js";
import { EnvManager } from "../packages/env/src/bridge.js";
import { KuloEnvAgent } from "../packages/env/src/agent.js";

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHn8AAAAASUVORK5CYII=", "base64");
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-preview-")); roots.push(root); return root; }
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function service(runner: AgentCliRunner) {
  const instance = new ComputerUseService({ rootDir: directory(), platform: "darwin", browserEnabled: true, desktopEnabled: true, runner });
  cleanup.push(() => instance.close());
  return instance;
}

async function host(manager?: EnvManager) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  if (manager) sockets.on("connection", (socket) => manager.handleEnvWebSocket(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve()))); });
  return { sockets, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, port: (server.address() as { port: number }).port };
}

async function connect(url: string, envId: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const registered = message(socket, "hub.registered");
  socket.send(JSON.stringify({ type: "env.register", envId, token: `${envId}-token`, name: envId, rootDir: "/tmp/kulo-preview-env", platform: "darwin", arch: "arm64", capabilities: ["agent-browser", "agent-desktop"] }));
  await registered;
  return socket;
}

function message<T extends HubToEnvControlMessage["type"]>(socket: WebSocket, type: T): Promise<Extract<HubToEnvControlMessage, { type: T }>> {
  return new Promise((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as HubToEnvControlMessage;
      if (value.type === type) { socket.off("message", listener); resolve(value as Extract<HubToEnvControlMessage, { type: T }>); }
    };
    socket.on("message", listener);
  });
}

describe("Env browser preview", () => {
  it("waits for the task's browser, streams only images with ack pacing, reconnects and closes without input", async () => {
    const stream = await host();
    const inputs: Array<Record<string, unknown>> = [];
    let connections = 0;
    stream.sockets.on("connection", (socket, req) => {
      connections++;
      expect(req.url).toBe("/?pacing=ack&maxFps=5");
      socket.on("message", (raw) => inputs.push(JSON.parse(raw.toString())));
      socket.send(JSON.stringify({ type: "frame", seq: connections, data: "/9j/2Q==", metadata: { timestamp: Date.now() } }));
    });
    const runner = vi.fn<AgentCliRunner>(async (invocation) => invocation.args.includes("stream")
      ? { success: true, data: { enabled: true, port: stream.port, connected: true, screencasting: true } }
      : { success: true, data: {} });
    const computer = service(runner);
    const updates: ComputerPreviewUpdate[] = [];
    const stop = computer.subscribePreview({ tool: "browser", sessionId: "one" }, (update) => updates.push(update));
    expect(runner).not.toHaveBeenCalled();
    await computer.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    await vi.waitFor(() => expect(updates.at(-1)?.frame?.mimeType).toBe("image/jpeg"));
    const status = runner.mock.calls.find(([call]) => call.args.includes("stream"))![0];
    expect(status.args).toEqual(expect.arrayContaining(["--json", "--session", "one", "stream", "status"]));
    expect(status.env).toMatchObject({ AGENT_BROWSER_STREAM_QUALITY: "40", AGENT_BROWSER_STREAM_MAX_WIDTH: "960" });
    await vi.waitFor(() => expect(inputs).toEqual([{ type: "ack", seq: 1 }]));
    for (const socket of stream.sockets.clients) socket.close();
    await vi.waitFor(() => expect(connections).toBe(2), { timeout: 2500 });
    await computer.request({ tool: "browser", action: "close", sessionId: "one" });
    expect(updates.at(-1)).toEqual({ state: "closed" });
    const callCount = runner.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(runner).toHaveBeenCalledTimes(callCount);
    expect(inputs.every((input) => input.type === "ack")).toBe(true);
    stop();
  });

  it("reports a malformed stream envelope without corrupting tool execution", async () => {
    const runner = vi.fn<AgentCliRunner>(async (call) => call.args.includes("stream") ? { enabled: true, port: 9223 } : { success: true, data: { refs: { e1: {} } } });
    const computer = service(runner);
    await computer.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    const updates: ComputerPreviewUpdate[] = [];
    const stop = computer.subscribePreview({ tool: "browser", sessionId: "one" }, (update) => updates.push(update));
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("unavailable"));
    expect(await computer.request({ tool: "browser", action: "snapshot", sessionId: "one" })).toMatchObject({ ok: true });
    expect(await computer.request({ tool: "browser", action: "click", sessionId: "one", ref: "e1" })).toMatchObject({ ok: true });
    stop();
  });
});

describe("Env desktop preview", () => {
  it("captures the exact observed window after an operation and keeps screenshots outside tool results", async () => {
    let windowId = "w-123";
    const runner = vi.fn<AgentCliRunner>(async (call) => {
      if (call.args.includes("snapshot")) return { ok: true, data: { window: { id: windowId }, tree: { ref_id: "@s123:e1" } } };
      if (call.args.includes("screenshot")) { fs.writeFileSync(call.args.at(-1)!, png); return { ok: true, data: { path: call.args.at(-1) } }; }
      return { ok: true, data: {} };
    });
    const computer = service(runner);
    const updates: ComputerPreviewUpdate[] = [];
    const stop = computer.subscribePreview({ tool: "desktop", sessionId: "one" }, (update) => updates.push(update));
    expect(runner).not.toHaveBeenCalled();
    const snapshot = await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("live"));
    expect(updates.at(-1)?.frame?.data).toBe(png.toString("base64"));
    const result = await computer.request({ tool: "desktop", action: "set-value", sessionId: "one", app: "TextEdit", ref: "@s123:e1", text: "private input" });
    await vi.waitFor(() => expect(runner.mock.calls.filter(([call]) => call.args.includes("screenshot"))).toHaveLength(2));
    expect(result).toMatchObject({ ok: true, data: { actionAccepted: true } });
    expect(JSON.stringify([snapshot, result])).not.toContain(png.toString("base64"));
    for (const [capture] of runner.mock.calls.filter(([call]) => call.args.includes("screenshot"))) {
      expect(capture.args).toEqual(expect.arrayContaining(["--app", "TextEdit", "--window-id", "w-123"]));
      expect(capture.args).not.toContain("--headed");
    }
    windowId = "w-456";
    await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "OtherApp" });
    expect(updates.at(-1)?.state).toBe("connecting");
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("live"));
    expect(runner.mock.calls.at(-1)![0].args).toEqual(expect.arrayContaining(["OtherApp", "w-456"]));
    stop();
    const count = runner.mock.calls.length;
    await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "OtherApp" });
    expect(runner.mock.calls.length).toBe(count + 1);
  });

  it("refuses ambiguous/windowless previews and reports capture permission errors while preserving the action", async () => {
    let hasWindow = false;
    const runner = vi.fn<AgentCliRunner>(async (call) => call.args.includes("screenshot")
      ? { ok: false, error: { code: "PERM_DENIED" } }
      : { ok: true, data: { ...(hasWindow ? { window: { id: "w-123" } } : {}), tree: { ref_id: "@s123:e1" } } });
    const computer = service(runner);
    const updates: ComputerPreviewUpdate[] = [];
    const stop = computer.subscribePreview({ tool: "desktop", sessionId: "one" }, (update) => updates.push(update));
    await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    expect(updates.at(-1)).toMatchObject({ state: "unavailable", message: "当前应用没有可预览的目标窗口" });
    expect(runner.mock.calls.some(([call]) => call.args.includes("screenshot"))).toBe(false);
    hasWindow = true;
    expect(await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(updates.at(-1)?.message).toContain("录屏权限"));
    expect(await computer.request({ tool: "desktop", action: "click", sessionId: "one", app: "TextEdit", ref: "@s123:e1" })).toMatchObject({ ok: true });
    await computer.suspend();
    expect(updates.at(-1)).toEqual({ state: "closed" });
    stop();
  });

  it("clears the old window preview when observing a different app fails", async () => {
    const runner = vi.fn<AgentCliRunner>(async (call) => {
      if (call.args.includes("snapshot")) return call.args.includes("OtherApp") ? { ok: false, error: { code: "AMBIGUOUS_TARGET" } } : { ok: true, data: { window: { id: "w-a" }, tree: { ref_id: "@s123:e1" } } };
      fs.writeFileSync(call.args.at(-1)!, png);
      return { ok: true, data: {} };
    });
    const computer = service(runner);
    const updates: ComputerPreviewUpdate[] = [];
    const stop = computer.subscribePreview({ tool: "desktop", sessionId: "one" }, (update) => updates.push(update));
    await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("live"));
    expect(await computer.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "OtherApp" })).toMatchObject({ ok: false });
    expect(updates.at(-1)).toEqual({ state: "unavailable", message: "无法确认当前目标窗口" });
    const fresh: ComputerPreviewUpdate[] = [];
    const unsubscribe = computer.subscribePreview({ tool: "desktop", sessionId: "one" }, (update) => fresh.push(update));
    expect(fresh[0]?.frame).toBeUndefined();
    expect(runner.mock.calls.filter(([call]) => call.args.includes("screenshot"))).toHaveLength(1);
    unsubscribe();
    stop();
  });
});

describe("computer preview authenticated routing", () => {
  it("routes subscriptions to the actual remote Env and cleans them on unsubscribe and disconnect", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const transport = await host(manager);
    let emit: ((update: ComputerPreviewUpdate) => void) | undefined;
    const stopNative = vi.fn();
    const rootDir = directory();
    const native = { rootDir, capabilities: () => ["agent-browser"], request: async () => ({} as ComputerUseResult), suspend: async () => {}, subscribePreview: vi.fn((_target, listener) => { emit = listener; return stopNative; }) } as unknown as ComputerUseService;
    const agent = new KuloEnvAgent({ rootDir, envId: "device", authToken: "device-token", hubUrl: transport.url, computerUseService: native, reconnect: false });
    await agent.start();
    const updates: ComputerPreviewUpdate[] = [];
    const stop = manager.subscribeComputerPreview("device", { tool: "browser", sessionId: "one" }, (update) => updates.push(update));
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    emit!({ state: "live", frame: { mimeType: "image/jpeg", data: "/9j/2Q==", capturedAt: Date.now() } });
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("live"));
    stop();
    await vi.waitFor(() => expect(stopNative).toHaveBeenCalledOnce());
    manager.subscribeComputerPreview("device", { tool: "browser", sessionId: "two" }, (update) => updates.push(update));
    await vi.waitFor(() => expect(native.subscribePreview).toHaveBeenCalledTimes(2));
    await agent.stop();
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("closed"));
    expect(stopNative).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it("flushes the latest one-shot desktop frame when Env socket congestion clears", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const transport = await host(manager);
    let emit: ((update: ComputerPreviewUpdate) => void) | undefined;
    const rootDir = directory();
    const native = { rootDir, capabilities: () => ["agent-desktop"], request: async () => ({} as ComputerUseResult), suspend: async () => {}, subscribePreview: (_target: unknown, listener: (update: ComputerPreviewUpdate) => void) => { emit = listener; return () => {}; } } as unknown as ComputerUseService;
    const agent = new KuloEnvAgent({ rootDir, envId: "device", authToken: "device-token", hubUrl: transport.url, computerUseService: native, reconnect: false });
    await agent.start();
    const updates: ComputerPreviewUpdate[] = [];
    const stop = manager.subscribeComputerPreview("device", { tool: "desktop", sessionId: "one" }, (update) => updates.push(update));
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    let congested = true;
    const buffer = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockImplementation(() => congested ? 8 * 1024 * 1024 : 0);
    try {
      emit!({ state: "live", frame: { mimeType: "image/png", data: png.toString("base64"), capturedAt: 1 } });
      emit!({ state: "live", frame: { mimeType: "image/png", data: png.toString("base64"), capturedAt: 2 } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(updates).toHaveLength(0);
      congested = false;
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      expect(updates[0]?.frame?.capturedAt).toBe(2);
      stop();
      await agent.stop();
      await manager.close();
    } finally { buffer.mockRestore(); }
  });

  it("rejects frames from another Env and stops old subscriptions on route lease changes", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token", other: "other-token" } });
    await manager.start();
    const transport = await host(manager);
    const device = await connect(transport.url, "device");
    const other = await connect(transport.url, "other");
    const subscribed = message(device, "hub.computer_preview_subscribe");
    const updates: ComputerPreviewUpdate[] = [];
    manager.subscribeComputerPreview("device", { tool: "browser", sessionId: "one" }, (update) => updates.push(update));
    const { subscriptionId } = await subscribed;
    const frame: ComputerPreviewUpdate = { state: "live", frame: { mimeType: "image/jpeg", data: "/9j/2Q==", capturedAt: Date.now() } };
    other.send(JSON.stringify({ type: "env.computer_preview", subscriptionId, update: frame }));
    device.send(JSON.stringify({ type: "env.computer_preview", subscriptionId: "0".repeat(32), update: frame }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(updates).toHaveLength(0);
    device.send(JSON.stringify({ type: "env.computer_preview", subscriptionId, update: frame }));
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    manager.setDeviceConnectionLease("device", "new-route-lease");
    expect(updates.at(-1)?.state).toBe("closed");
    device.send(JSON.stringify({ type: "env.computer_preview", subscriptionId, update: frame }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(updates).toHaveLength(2);
    await manager.close();
  });

  it("terminates a replaced Env subscription and binds a fresh subscription to its new socket", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const transport = await host(manager);
    const oldDevice = await connect(transport.url, "device");
    const oldSubscribed = message(oldDevice, "hub.computer_preview_subscribe");
    const updates: ComputerPreviewUpdate[] = [];
    const oldStop = manager.subscribeComputerPreview("device", { tool: "browser", sessionId: "one" }, (update) => updates.push(update));
    const old = await oldSubscribed;
    const device = await connect(transport.url, "device");
    expect(updates.at(-1)?.state).toBe("closed");
    const newSubscribed = message(device, "hub.computer_preview_subscribe");
    const newStop = manager.subscribeComputerPreview("device", { tool: "browser", sessionId: "one" }, (update) => updates.push(update));
    const current = await newSubscribed;
    oldStop();
    const frame: ComputerPreviewUpdate = { state: "live", frame: { mimeType: "image/jpeg", data: "/9j/2Q==", capturedAt: Date.now() } };
    device.send(JSON.stringify({ type: "env.computer_preview", subscriptionId: old.subscriptionId, update: frame }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(updates).toHaveLength(1);
    device.send(JSON.stringify({ type: "env.computer_preview", subscriptionId: current.subscriptionId, update: frame }));
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe("live"));
    newStop();
    await manager.close();
  });
});
