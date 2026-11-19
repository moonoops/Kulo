import http from "node:http";
import { once } from "node:events";
import { EnvManager } from "@kulo/env";
import { ANDROID_TOOL_CATALOG, type AndroidRequest, type AndroidResult, type AndroidCancel, type AndroidEnvStatus } from "@kulo/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
  const manager = new EnvManager({ enableLocal: false, envTokens: { phone: "android-env-test", computer: "computer-env-test" } });
  await manager.start();
  cleanup.push(() => manager.close());
  manager.setDeviceConnectionLease("phone", "lease-one");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => manager.handleEnvWebSocket(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const status: AndroidEnvStatus = { version: 1, catalogVersion: 1, enabled: true, paused: false, revision: 1, grants: ["device"],
    capabilities: ANDROID_TOOL_CATALOG.map((tool) => ({ action: tool.action, available: true })) };
  async function connect(lease = "lease-one") {
    const accepted = once(wss, "connection");
    const socket = new WebSocket(url);
    const received: Array<{ type: string; requestId: string; request: AndroidRequest & AndroidCancel; budgetMs?: number }> = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    await once(socket, "open");
    const [serverSocket] = await accepted as [WebSocket];
    const registered = once(socket, "message");
    socket.send(JSON.stringify({ type: "env.register", envId: "phone", token: "android-env-test", name: "Test Android",
      platform: "android", arch: "arm64", executionKind: "native-device", rootDir: "", capabilities: ["android-device"], connectionLease: lease }));
    expect(JSON.parse((await registered)[0].toString())).toEqual({ type: "hub.registered", envId: "phone" });
    socket.send(JSON.stringify({ type: "env.android_status", status }));
    await vi.waitFor(() => expect(manager.getEnvDescriptor("phone")?.android).toEqual(status));
    cleanup.push(() => { socket.terminate(); });
    return { socket, serverSocket, received };
  }
  const request = (patch: Partial<AndroidRequest> = {}): AndroidRequest => ({ version: 1, hubId: "hub-one", deviceId: "phone",
    ticketId: "T-1", conversationId: 9, runEpoch: 3, operationId: "operation-one", action: "system_info", args: {}, deadline: Date.now() + 10_000, ...patch });
  const receipt = (value: AndroidRequest, patch: Partial<AndroidResult> = {}): AndroidResult => ({ version: 1, action: value.action,
    operationId: value.operationId, ticketId: value.ticketId, runEpoch: value.runEpoch, status: "completed", data: { battery: 60 }, ...patch });
  return { manager, connect, request, receipt, status };
}

describe("native Android Env transport", () => {
  it("publishes only the native catalogue and returns an identity-checked result over the real socket", async () => {
    const f = await fixture(); const node = await f.connect();
    expect(f.manager.getEnvDescriptor("phone")?.capabilities).toEqual(["android-device", "android-native-v1", ...ANDROID_TOOL_CATALOG.map((tool) => `android:${tool.action}`)]);
    expect(() => f.manager.createExecutionEnv("phone", "")).toThrow("does not support Pi Env");
    const req = f.request();
    const pending = f.manager.requestAndroid("phone", req);
    await vi.waitFor(() => expect(node.received.some((msg) => msg.type === "hub.android_request")).toBe(true));
    const sent = node.received.find((msg) => msg.type === "hub.android_request")!;
    expect(sent.request).toEqual(req);
    expect(sent.budgetMs).toBeGreaterThan(0);
    expect(sent.budgetMs).toBeLessThanOrEqual(10_000);
    node.socket.send(JSON.stringify({ type: "env.android_result", requestId: sent.requestId, result: f.receipt(req) }));
    expect(await pending).toEqual(f.receipt(req));
    expect(node.received.map((msg) => msg.type)).not.toContain("hub.open_stream");
  });

  it("sends remaining Hub budget without changing or renewing the original operation deadline", async () => {
    const f = await fixture(); const node = await f.connect();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const req = f.request({ deadline: now + 120_000 });
    const first = f.manager.requestAndroid("phone", req);
    await vi.waitFor(() => expect(node.received.filter((msg) => msg.type === "hub.android_request")).toHaveLength(1));
    const sent = node.received.find((msg) => msg.type === "hub.android_request")!;
    expect(sent.budgetMs).toBe(120_000);
    node.socket.send(JSON.stringify({ type: "env.android_result", requestId: sent.requestId, result: f.receipt(req) }));
    await first;
    clock.mockReturnValue(now + 20_000);
    const second = f.manager.requestAndroid("phone", req);
    await vi.waitFor(() => expect(node.received.filter((msg) => msg.type === "hub.android_request")).toHaveLength(2));
    const next = node.received.filter((msg) => msg.type === "hub.android_request")[1]!;
    expect(next.budgetMs).toBe(100_000);
    expect(next.request).toEqual(req);
    expect(req.deadline).toBe(now + 120_000);
    node.socket.send(JSON.stringify({ type: "env.android_result", requestId: next.requestId, result: f.receipt(req) }));
    await second;
    clock.mockReturnValue(now + 120_001);
    await expect(f.manager.requestAndroid("phone", req)).rejects.toThrow("expired");
    await expect(f.manager.requestAndroid("phone", f.request({ deadline: Date.now() + 120_001 }))).rejects.toThrow("invalid");
    expect(node.received.filter((msg) => msg.type === "hub.android_request")).toHaveLength(2);
  });

  it("rejects another target and malformed result identities without silently completing work", async () => {
    const f = await fixture(); const node = await f.connect();
    await expect(f.manager.requestAndroid("phone", f.request({ deviceId: "other" }))).rejects.toThrow("Invalid Android");
    const req = f.request();
    const pending = f.manager.requestAndroid("phone", req);
    const failure = expect(pending).rejects.toThrow("Invalid Android operation response");
    await vi.waitFor(() => expect(node.received.some((msg) => msg.type === "hub.android_request")).toBe(true));
    const sent = node.received.find((msg) => msg.type === "hub.android_request")!;
    node.socket.send(JSON.stringify({ type: "env.android_result", requestId: sent.requestId, result: f.receipt(req, { runEpoch: 2 }) }));
    await failure;
    expect(node.received.filter((msg) => msg.type === "hub.android_request")).toHaveLength(1);
  });

  it("fences pending and late results across a replacement socket", async () => {
    const f = await fixture(); const first = await f.connect();
    const req = f.request(); const pending = f.manager.requestAndroid("phone", req);
    const failure = expect(pending).rejects.toThrow("reconnected");
    await vi.waitFor(() => expect(first.received.some((msg) => msg.type === "hub.android_request")).toBe(true));
    const old = first.received.find((msg) => msg.type === "hub.android_request")!;
    const second = await f.connect();
    await failure;
    const next = f.request({ operationId: "operation-two" });
    const active = f.manager.requestAndroid("phone", next);
    await vi.waitFor(() => expect(second.received.some((msg) => msg.type === "hub.android_request")).toBe(true));
    const current = second.received.find((msg) => msg.type === "hub.android_request")!;
    first.serverSocket.emit("message", Buffer.from(JSON.stringify({ type: "env.android_result", requestId: current.requestId, result: f.receipt(next) })), false);
    second.socket.send(JSON.stringify({ type: "env.android_result", requestId: old.requestId, result: f.receipt(req) }));
    second.socket.send(JSON.stringify({ type: "env.android_result", requestId: current.requestId, result: f.receipt(next, { data: { current: true } }) }));
    expect(await active).toMatchObject({ data: { current: true } });
  });

  it("rejects both pending work and new requests when the connection lease changes", async () => {
    const f = await fixture(); const node = await f.connect();
    const pending = f.manager.requestAndroid("phone", f.request());
    const failure = expect(pending).rejects.toThrow("lease changed");
    f.manager.setDeviceConnectionLease("phone", "lease-two");
    await failure;
    await expect(f.manager.requestAndroid("phone", f.request())).rejects.toThrow("lease changed");
    const closed = once(node.socket, "close");
    node.socket.send(JSON.stringify({ type: "env.android_status", status: { ...f.status, revision: 2 } }));
    expect((await closed)[0]).toBe(4009);
  });

  it("reports actual quiescence separately from acknowledgement and validates stop scope", async () => {
    const f = await fixture(); const node = await f.connect();
    const request: AndroidCancel = { version: 1, controlId: "control-one", ticketId: "T-1", runEpoch: 3, reason: "Stop" };
    const stopping = f.manager.cancelAndroid("phone", request);
    await vi.waitFor(() => expect(node.received.some((msg) => msg.type === "hub.android_cancel")).toBe(true));
    const sent = node.received.find((msg) => msg.type === "hub.android_cancel")!;
    node.socket.send(JSON.stringify({ type: "env.android_control_result", requestId: sent.requestId, result: {
      version: 1, controlId: request.controlId, ticketId: request.ticketId, runEpoch: 3, quiescent: false } }));
    expect(await stopping).toMatchObject({ quiescent: false });
    const next = f.manager.cancelAndroid("phone", { ...request, controlId: "control-two" });
    const failed = expect(next).rejects.toThrow("Invalid Android stop response");
    await vi.waitFor(() => expect(node.received.filter((msg) => msg.type === "hub.android_cancel")).toHaveLength(2));
    const second = node.received.filter((msg) => msg.type === "hub.android_cancel")[1]!;
    node.socket.send(JSON.stringify({ type: "env.android_control_result", requestId: second.requestId, result: {
      version: 1, controlId: "control-two", ticketId: "T-other", runEpoch: 3, quiescent: true } }));
    await failed;
  });

  it("preserves parked epoch acknowledgement and public resource state over the real Env socket", async () => {
    const f = await fixture();
    f.status.catalogVersion = 2;
    f.status.resources = [{ ticketId: "T-1", kind: "audio_capture", id: "capture-one", state: "recording" }];
    const node = await f.connect();
    expect(f.manager.getEnvDescriptor("phone")?.android?.resources).toEqual(f.status.resources);
    const request: AndroidCancel = { version: 1, controlId: "park-one", ticketId: "T-1", runEpoch: 3, reason: "task_epoch_parked" };
    const parking = f.manager.cancelAndroid("phone", request);
    await vi.waitFor(() => expect(node.received.some(message => message.type === "hub.android_cancel")).toBe(true));
    const sent = node.received.find(message => message.type === "hub.android_cancel")!;
    const retained = { version: 1, controlId: request.controlId, ticketId: request.ticketId, runEpoch: 3,
      quiescent: false, epochQuiescent: true, resourcesRetained: true };
    node.socket.send(JSON.stringify({ type: "env.android_control_result", requestId: sent.requestId, result: retained }));
    expect(await parking).toEqual(retained);
  });

  it("sends cancellation after abort, never replays the action, and accepts the independent stop receipt", async () => {
    const f = await fixture(); const node = await f.connect();
    const controller = new AbortController();
    const pending = f.manager.requestAndroid("phone", f.request(), controller.signal);
    const failed = expect(pending).rejects.toThrow("cancelled");
    controller.abort(); await failed;
    await vi.waitFor(() => expect(node.received.some((msg) => msg.type === "hub.android_cancel")).toBe(true));
    const cancel = node.received.find((msg) => msg.type === "hub.android_cancel")!;
    node.socket.send(JSON.stringify({ type: "env.android_control_result", requestId: cancel.requestId,
      result: { version: 1, controlId: cancel.request.controlId, ticketId: "T-1", runEpoch: 3, quiescent: true } }));
    expect(node.received.filter((msg) => msg.type === "hub.android_request")).toHaveLength(1);
  });

  it("does not retry an expired action and bounds the stop identity for maximum-length operation IDs", async () => {
    const f = await fixture(); const node = await f.connect();
    const req = f.request({ operationId: "o".repeat(128), deadline: Date.now() + 1000 });
    const failed = expect(f.manager.requestAndroid("phone", req)).rejects.toThrow("not confirmed before its deadline");
    await failed;
    await vi.waitFor(() => expect(node.received.some((msg) => msg.type === "hub.android_cancel")).toBe(true));
    const cancel = node.received.find((msg) => msg.type === "hub.android_cancel")!;
    expect(cancel.request.controlId.length).toBeLessThanOrEqual(128);
    node.socket.send(JSON.stringify({ type: "env.android_control_result", requestId: cancel.requestId,
      result: { version: 1, controlId: cancel.request.controlId, ticketId: "T-1", runEpoch: 3, quiescent: true } }));
    await expect(f.manager.requestAndroid("phone", req)).rejects.toThrow("expired");
    expect(node.received.filter((msg) => msg.type === "hub.android_request")).toHaveLength(1);
  });

  it("refuses oversized native frames and fails operations when a device is removed", async () => {
    const f = await fixture(); const node = await f.connect();
    const pending = f.manager.requestAndroid("phone", f.request());
    const failed = expect(pending).rejects.toThrow("disconnected");
    const closed = once(node.socket, "close");
    node.socket.send(JSON.stringify({ type: "env.android_result", requestId: "unknown", data: "x".repeat(1024 * 1024 + 4096) }));
    expect((await closed)[0]).toBe(4002);
    await failed;
    const second = await f.connect();
    const active = f.manager.requestAndroid("phone", f.request());
    const removed = expect(active).rejects.toThrow("removed");
    f.manager.removeDevice("phone"); await removed;
    expect(f.manager.getEnvDescriptor("phone")).toBeUndefined();
    second.socket.terminate();
  });
});
