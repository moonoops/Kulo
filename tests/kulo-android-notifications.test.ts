import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { EnvManager } from "@kulo/env";
import { ANDROID_TOOL_CATALOG, isAndroidNotificationClassification, isAndroidNotificationClassificationResult, isAndroidNotificationDecision,
  isProtectedAndroidNotification, type AndroidNotificationClassification, type AndroidNotificationClassificationResult, type AndroidEnvStatus } from "@kulo/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { androidNotificationDecisionId, KuloAndroidNotifications, parseAndroidNotificationDecision } from "../packages/hub/src/android-notifications.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function request(patch: Partial<AndroidNotificationClassification> = {}): AndroidNotificationClassification {
  return { version: 1, requestId: "request-one", bindingId: "binding-one", hubId: "hub-one", deviceId: "phone", ruleRevision: 3,
    notificationId: "a".repeat(64), notificationVersion: "b".repeat(64), ruleText: "保留有用通知，清除明确的广告", defaultRule: true,
    notification: { packageName: "example.messages", appName: "Messages", title: "Delivery", text: "Your parcel arrived", subtext: "", postedAtMs: 1_700_000_000_000,
      channelId: "deliveries", category: "msg", ongoing: false, clearable: true, groupSummary: false }, ...patch };
}
function result(value: AndroidNotificationClassification): AndroidNotificationClassificationResult {
  const { notification: _notification, ruleText: _rule, defaultRule: _default, ...identity } = value;
  return { ...identity, decisionId: androidNotificationDecisionId(value), decision: { action: "retain" } };
}
function classifier(output = '{"action":"retain"}') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-notifications-")); cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const complete = vi.fn().mockImplementation(async () => ({ stopReason: "stop", content: [{ type: "text", text: output }] }));
  const getModel = vi.fn().mockReturnValue({ maxTokens: 4000 });
  const selected = { model: { provider: "provider-one", modelId: "model-one" } };
  const host = { stateDir: dir, models: { getModel, completeSimple: complete } as unknown as Models,
    agent: () => selected, hubId: () => "hub-one", redact: (text: string) => text.replaceAll("private-token", "[redacted]") };
  const service = new KuloAndroidNotifications(host); cleanup.push(() => service.close());
  return { service, complete, getModel, selected, dir, host };
}

describe("Android notification classifier contracts", () => {
  it("accepts only bounded purpose requests and validated decisions", () => {
    expect(isAndroidNotificationClassification(request())).toBe(true);
    expect(isAndroidNotificationClassification({ ...request(), authorization: "grant root" })).toBe(false);
    expect(isAndroidNotificationClassification({ ...request(), notification: { ...request().notification, text: "x".repeat(4001) } })).toBe(false);
    expect(isAndroidNotificationDecision({ action: "clear", advertisement: true })).toBe(true);
    expect(isAndroidNotificationDecision({ action: "collect", important: true })).toBe(false);
    expect(isAndroidNotificationDecision({ action: "retain", enableRoot: true })).toBe(false);
    expect(() => parseAndroidNotificationDecision('{"action":"collect"}', true)).toThrow("invalid_output");
    expect(() => parseAndroidNotificationDecision("invalid json", false)).toThrow("invalid_output");
    expect(parseAndroidNotificationDecision('```json\n{"action":"clear","advertisement":true}\n```', true)).toEqual({ action: "clear", advertisement: true });
    expect(isAndroidNotificationClassificationResult(result(request()), request())).toBe(true);
    expect(isAndroidNotificationClassificationResult({ ...result(request()), bindingId: "retired" }, request())).toBe(false);
  });

  it("retains protected and OTP notifications without calling a model", async () => {
    const f = classifier();
    for (const patch of [{ text: "验证码 123456" }, { ongoing: true }, { clearable: false }, { groupSummary: true }, { category: "alarm" }, { packageName: "com.android.systemui" }]) {
      const value = request({ notification: { ...request().notification, ...patch } });
      expect(isProtectedAndroidNotification(value.notification)).toBe(true);
      expect((await f.service.classify(value, new AbortController().signal)).decision).toEqual({ action: "retain" });
    }
    expect(f.complete).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.dir, "android-notification-decisions.json"))).toBe(false);
  });

  it("uses the current Hub model without tools, redacts source, and persists idempotent decisions", async () => {
    const f = classifier(); const value = request({ notification: { ...request().notification, text: "private-token" } });
    const first = await f.service.classify(value, new AbortController().signal);
    expect(first.decision).toEqual({ action: "retain" });
    expect(f.getModel).toHaveBeenCalledWith("provider-one", "model-one");
    const [, context, options] = f.complete.mock.calls[0]!;
    expect(context.tools).toBeUndefined(); expect(options.cacheRetention).toBe("none"); expect(options.maxTokens).toBe(1500);
    expect(JSON.stringify(context)).not.toContain("private-token"); expect(JSON.stringify(context)).toContain("untrustedNotification");
    const second = await f.service.classify({ ...value, requestId: "retry", bindingId: "new-lease" }, new AbortController().signal);
    expect(second.decisionId).toBe(first.decisionId); expect(second.requestId).toBe("retry"); expect(f.complete).toHaveBeenCalledTimes(1);
    const restored = new KuloAndroidNotifications(f.host); cleanup.push(() => restored.close());
    expect((await restored.classify(value, new AbortController().signal)).decisionId).toBe(first.decisionId); expect(f.complete).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(f.dir, "android-notification-decisions.json"), "utf8")).not.toContain("private-token");
    expect((await f.service.classify({ ...value, ruleText: "different intent" }, new AbortController().signal)).error).toBe("notification_intent_conflict");
    f.selected.model = { provider: "provider-two", modelId: "model-two" };
    await f.service.classify({ ...value, ruleRevision: 4 }, new AbortController().signal);
    expect(f.getModel).toHaveBeenLastCalledWith("provider-two", "model-two");
  });

  it("fails closed for a corrupt decision store and for invalid model output", async () => {
    const f = classifier('{"action":"clear","enabled":true}');
    expect((await f.service.classify(request(), new AbortController().signal)).error).toBe("notification_model_invalid_output");
    expect(fs.existsSync(path.join(f.dir, "android-notification-decisions.json"))).toBe(false);
    fs.writeFileSync(path.join(f.dir, "android-notification-decisions.json"), "broken");
    const broken = new KuloAndroidNotifications(f.host); cleanup.push(() => broken.close());
    expect((await broken.classify(request(), new AbortController().signal)).error).toBe("notification_storage_unavailable");
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests and fences providers that ignore abort", async () => {
    const f = classifier(); let finish!: (value: unknown) => void;
    f.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.service.classify(request(), new AbortController().signal);
    const duplicate = f.service.classify({ ...request(), requestId: "duplicate" }, new AbortController().signal);
    finish({ stopReason: "stop", content: [{ type: "text", text: '{"action":"retain"}' }] });
    expect((await first).decisionId).toBe((await duplicate).decisionId); expect(f.complete).toHaveBeenCalledTimes(1);
    f.complete.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController(); const pending = f.service.classify(request({ ruleRevision: 10 + i }), controller.signal);
      controller.abort(); expect((await pending).error).toBe("notification_cancelled");
    }
    expect((await f.service.classify(request({ ruleRevision: 20 }), new AbortController().signal)).error).toBe("notification_rate_limited");
  });
});

async function transport() {
  const manager = new EnvManager({ enableLocal: false, envTokens: { phone: "notification-env-test" } }); await manager.start();
  cleanup.push(() => manager.close()); manager.setDeviceConnectionLease("phone", "connection-lease");
  const server = http.createServer(); const wss = new WebSocketServer({ server }); wss.on("connection", socket => manager.handleEnvWebSocket(socket));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); });
  const status: AndroidEnvStatus = { version: 1, catalogVersion: 2, enabled: true, paused: false, revision: 1, grants: ["notifications"],
    capabilities: ANDROID_TOOL_CATALOG.map(tool => ({ action: tool.action, available: true })) };
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`); const received: Array<Record<string, any>> = [];
  socket.on("message", bytes => received.push(JSON.parse(bytes.toString()))); await once(socket, "open");
  socket.send(JSON.stringify({ type: "env.register", envId: "phone", token: "notification-env-test", name: "Phone", platform: "android", arch: "arm64", rootDir: "", executionKind: "native-device", capabilities: ["android-device"], connectionLease: "connection-lease" }));
  await vi.waitFor(() => expect(received[0]?.type).toBe("hub.registered"));
  socket.send(JSON.stringify({ type: "env.android_status", status })); await vi.waitFor(() => expect(manager.getEnvDescriptor("phone")?.android?.revision).toBe(1));
  return { manager, socket, received, status };
}

describe("Android notification purpose transport", () => {
  it("delivers only correlated classification results to the authenticated device", async () => {
    const f = await transport(); const classify = vi.fn(async value => result(value)); f.manager.setAndroidNotificationClassifier(classify);
    f.socket.send(JSON.stringify({ type: "env.notification_classify", request: request() }));
    await vi.waitFor(() => expect(f.received.some(item => item.type === "hub.notification_decision")).toBe(true));
    expect(f.received.find(item => item.type === "hub.notification_decision")?.result).toEqual(result(request())); expect(classify).toHaveBeenCalledTimes(1);
    expect(f.received.map(item => item.type)).not.toContain("hub.android_request");
  });

  it("aborts pending work on permission revocation and ignores retired lease results", async () => {
    const f = await transport(); let signal!: AbortSignal; let finish!: (value: AndroidNotificationClassificationResult) => void;
    f.manager.setAndroidNotificationClassifier((_request, current) => { signal = current; return new Promise(resolve => { finish = resolve; }); });
    f.socket.send(JSON.stringify({ type: "env.notification_classify", request: request() })); await vi.waitFor(() => expect(signal).toBeDefined());
    f.socket.send(JSON.stringify({ type: "env.android_status", status: { ...f.status, revision: 2, grants: [] } })); await vi.waitFor(() => expect(signal.aborted).toBe(true));
    finish(result(request())); await new Promise(resolve => setTimeout(resolve, 10)); expect(f.received.some(item => item.type === "hub.notification_decision")).toBe(false);
    f.socket.send(JSON.stringify({ type: "env.notification_classify", request: request({ requestId: "unauthorized" }) }));
    await vi.waitFor(() => expect(f.received.some(item => item.result?.error === "notification_permission_required")).toBe(true));
  });

  it("binds cancel to the same request and WS binding and suppresses cancelled replies", async () => {
    const f = await transport(); let signal!: AbortSignal;
    f.manager.setAndroidNotificationClassifier((_request, current) => { signal = current; return new Promise(() => {}); });
    f.socket.send(JSON.stringify({ type: "env.notification_classify", request: request() })); await vi.waitFor(() => expect(signal).toBeDefined());
    f.socket.send(JSON.stringify({ type: "env.notification_cancel", requestId: "request-one", bindingId: "wrong" })); await new Promise(resolve => setTimeout(resolve, 10)); expect(signal.aborted).toBe(false);
    f.socket.send(JSON.stringify({ type: "env.notification_cancel", requestId: "request-one", bindingId: "binding-one" })); await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("closes malformed requests before reaching the provider", async () => {
    const f = await transport(); const classify = vi.fn(); f.manager.setAndroidNotificationClassifier(classify);
    const closed = once(f.socket, "close"); f.socket.send(JSON.stringify({ type: "env.notification_classify", request: request({ deviceId: "other-phone" }) }));
    expect((await closed)[0]).toBe(4002); expect(classify).not.toHaveBeenCalled();
  });

  it("aborts classification immediately when the current route lease is retired", async () => {
    const f = await transport(); let signal!: AbortSignal;
    f.manager.setAndroidNotificationClassifier((_request, current) => { signal = current; return new Promise(() => {}); });
    f.socket.send(JSON.stringify({ type: "env.notification_classify", request: request() })); await vi.waitFor(() => expect(signal).toBeDefined());
    f.manager.setDeviceConnectionLease("phone", "new-route-lease"); expect(signal.aborted).toBe(true);
  });
});
