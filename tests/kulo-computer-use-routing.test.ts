import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerUseRpcTimeoutMs, type ComputerUseRequest, type ComputerUseResult, type HubToEnvControlMessage } from "@kulo/protocol";
import { EnvManager } from "../packages/env/src/bridge.js";
import { KuloEnvAgent } from "../packages/env/src/agent.js";
import type { ComputerUseService } from "../packages/env/src/computer-use.js";

const directories: string[] = [];
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-computer-routing-"));
  directories.push(root);
  return root;
};
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function result(request: ComputerUseRequest, platform = process.platform, data: unknown = { source: "target-env" }): ComputerUseResult {
  return { tool: request.tool, action: request.action, ...("sessionId" in request ? { sessionId: request.sessionId } : {}), platform, ok: true, data };
}

function service(rootDir: string, handler: (request: ComputerUseRequest, active: () => boolean, signal?: AbortSignal) => Promise<ComputerUseResult> = async (request) => result(request), capabilities = ["agent-browser", "agent-browser-v2", "agent-desktop"]) {
  fs.mkdirSync(rootDir, { recursive: true });
  const value = {
    rootDir,
    capabilities: () => capabilities,
    request: vi.fn(handler),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { ...value, instance: value as unknown as ComputerUseService };
}

async function server(manager: EnvManager) {
  const httpServer = http.createServer();
  const sockets = new WebSocketServer({ server: httpServer });
  sockets.on("connection", (socket) => manager.handleEnvWebSocket(socket));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}`,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => httpServer.close(() => resolve())));
    },
  };
}

async function connect(url: string, envId: string, token: string, platform = "win32", extra: Record<string, unknown> = {}) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const registered = new Promise<void>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === "hub.registered") {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
    socket.once("close", () => reject(new Error("Registration rejected")));
  });
  socket.send(JSON.stringify({ type: "env.register", envId, token, name: envId, rootDir: platform === "win32" ? "C:\\kulo-env" : "/tmp/kulo-env", platform, arch: "x64", capabilities: ["agent-browser", "agent-browser-v2", "agent-desktop"], ...extra }));
  await registered;
  return socket;
}

function nextMessage<T extends HubToEnvControlMessage["type"]>(socket: WebSocket, type: T): Promise<Extract<HubToEnvControlMessage, { type: T }>> {
  return new Promise((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as HubToEnvControlMessage;
      if (message.type === type) {
        socket.off("message", listener);
        resolve(message as Extract<HubToEnvControlMessage, { type: T }>);
      }
    };
    socket.on("message", listener);
  });
}

const open: ComputerUseRequest = { tool: "browser", action: "open", sessionId: "kulo-ticket-one", url: "https://example.com" };

describe("computer use Env routing", () => {
  it("rejects unknown opt-in values before opening a local transport", () => {
    vi.stubEnv("KULO_COMPUTER_USE", "browser,unexpected");
    expect(() => new EnvManager()).toThrow("browser,desktop only");
  });

  it("uses the local private service and protects its storage from project grants", async () => {
    const root = directory();
    const computer = service(path.join(root, "private-computer"));
    const manager = new EnvManager({ localRootDir: path.join(root, "env"), computerUseService: computer.instance });
    await manager.start();
    try {
      expect(manager.getEnvDescriptor("local")?.capabilities).toEqual(expect.arrayContaining(["agent-browser", "agent-desktop"]));
      expect(await manager.requestComputerUse("local", open)).toMatchObject({ ok: true, sessionId: open.sessionId });
      expect(computer.request).toHaveBeenCalledOnce();
      expect(computer.request.mock.calls[0]?.[1]()).toBe(false);
      await expect(manager.authorizeProjectDirectory("local", { projectId: "private-computer", path: computer.rootDir, operationId: "grant-computer" })).rejects.toThrow("protected");
    } finally { await manager.close(); }
    expect(computer.close).toHaveBeenCalledOnce();
  });

  it("runs through an authenticated remote Env without exposing a local execution fallback", async () => {
    const root = directory();
    const computer = service(path.join(root, "private-computer"));
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const host = await server(manager);
    const agent = new KuloEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-token", rootDir: path.join(root, "env"), computerUseService: computer.instance, reconnect: false });
    try {
      await agent.start();
      expect(await manager.requestComputerUse("device", open)).toMatchObject({ ok: true, data: { source: "target-env" } });
      expect(computer.request).toHaveBeenCalledOnce();
      await expect(manager.requestComputerUse("missing-env", open)).rejects.toThrow("offline");
      expect(computer.request).toHaveBeenCalledOnce();
    } finally { await agent.stop(); await manager.close(); await host.close(); }
    expect(computer.suspend).toHaveBeenCalled();
  });

  it("accepts a Windows receipt independently of the Hub platform", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { windows: "windows-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const device = await connect(host.url, "windows", "windows-token");
      const message = nextMessage(device, "hub.computer_request");
      const response = manager.requestComputerUse("windows", open);
      const request = await message;
      device.send(JSON.stringify({ type: "env.computer_result", requestId: request.requestId, result: result(open, "win32", { target: "Windows" }) }));
      expect(await response).toMatchObject({ platform: "win32", data: { target: "Windows" } });
      device.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("rejects an unauthorized peer and refuses unsupported native Android capabilities", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token", phone: "phone-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      await expect(connect(host.url, "device", "wrong-token")).rejects.toThrow("Registration rejected");
      const phone = await connect(host.url, "phone", "phone-token", "android", { executionKind: "native-device", capabilities: ["android-device"] });
      await expect(manager.requestComputerUse("phone", { tool: "desktop", action: "status" })).rejects.toThrow("supported computer-use driver");
      phone.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("does not let caller-supplied capability tags enable native tools", async () => {
    const root = directory();
    const computer = service(path.join(root, "private-computer"), undefined, []);
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const host = await server(manager);
    const agent = new KuloEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-token", rootDir: path.join(root, "env"), computerUseService: computer.instance, capabilities: ["agent-browser", "agent-browser-v2", "agent-desktop"], reconnect: false });
    try {
      await agent.start();
      expect(manager.getEnvDescriptor("device")?.capabilities).not.toContain("agent-browser");
      expect(manager.getEnvDescriptor("device")?.capabilities).not.toContain("agent-browser-v2");
      expect(manager.getEnvDescriptor("device")?.capabilities).not.toContain("agent-desktop");
      await expect(manager.requestComputerUse("device", open)).rejects.toThrow("not enabled");
      expect(computer.request).not.toHaveBeenCalled();
    } finally { await agent.stop(); await manager.close(); await host.close(); }
  });

  it("correlates authenticated device, session, action and platform before accepting a receipt", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { first: "first-token", second: "second-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const first = await connect(host.url, "first", "first-token");
      const second = await connect(host.url, "second", "second-token");
      const incoming = nextMessage(first, "hub.computer_request");
      const response = manager.requestComputerUse("first", open);
      const request = await incoming;
      let settled = false;
      void response.then(() => { settled = true; }, () => { settled = true; });
      second.send(JSON.stringify({ type: "env.computer_result", requestId: request.requestId, result: result(open, "win32") }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(settled).toBe(false);
      first.send(JSON.stringify({ type: "env.computer_result", requestId: request.requestId, result: { ...result(open, "win32"), sessionId: "another-ticket" } }));
      await expect(response).rejects.toThrow("Invalid computer-use response");

      for (const invalid of [{ ...result(open, "win32"), action: "click" }, result(open, "linux"), result(open, "win32", "x".repeat(1024 * 1024))]) {
        const next = nextMessage(first, "hub.computer_request");
        const pending = manager.requestComputerUse("first", open);
        const message = await next;
        first.send(JSON.stringify({ type: "env.computer_result", requestId: message.requestId, result: invalid }));
        await expect(pending).rejects.toThrow("Invalid computer-use response");
      }
      first.close(); second.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("propagates cancellation to the Env before a queued mutation can execute", async () => {
    const root = directory();
    let aborted = false;
    let clicks = 0;
    const computer = service(path.join(root, "private-computer"), async (request, active, signal) => {
      if (request.action === "click") {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) { aborted = true; resolve(); }
          else signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
        });
        if (active()) clicks++;
      }
      return result(request);
    });
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const host = await server(manager);
    const agent = new KuloEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-token", rootDir: path.join(root, "env"), computerUseService: computer.instance, reconnect: false });
    try {
      await agent.start();
      const controller = new AbortController();
      const response = manager.requestComputerUse("device", { tool: "browser", action: "click", sessionId: open.sessionId, ref: "@e1" }, controller.signal);
      const rejection = expect(response).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(computer.request).toHaveBeenCalledOnce());
      controller.abort();
      await rejection;
      await vi.waitFor(() => expect(aborted).toBe(true));
      expect(clicks).toBe(0);
      expect(await manager.requestComputerUse("device", { tool: "browser", action: "status" })).toMatchObject({ ok: true });
    } finally { await agent.stop(); await manager.close(); await host.close(); }
  });

  it("expires unconfirmed operations and sends cancellation instead of retrying", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const device = await connect(host.url, "device", "device-token");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const incoming = nextMessage(device, "hub.computer_request");
      const response = manager.requestComputerUse("device", open);
      const rejection = expect(response).rejects.toThrow("not confirmed in time");
      const request = await incoming;
      const cancelled = nextMessage(device, "hub.computer_cancel");
      await vi.advanceTimersByTimeAsync(45_000);
      await rejection;
      expect(await cancelled).toMatchObject({ requestId: request.requestId });
      vi.useRealTimers();
      device.close();
    } finally { vi.useRealTimers(); await manager.close(); await host.close(); }
  });

  it("rejects pending work when a new authenticated connection replaces the target", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const oldDevice = await connect(host.url, "device", "device-token");
      const incoming = nextMessage(oldDevice, "hub.computer_request");
      const response = manager.requestComputerUse("device", open);
      const rejection = expect(response).rejects.toThrow("reconnected");
      await incoming;
      const replacement = await connect(host.url, "device", "device-token");
      await rejection;
      const next = nextMessage(replacement, "hub.computer_request");
      const followup = manager.requestComputerUse("device", { tool: "browser", action: "status" });
      const request = await next;
      replacement.send(JSON.stringify({ type: "env.computer_result", requestId: request.requestId, result: result(request.request, "win32") }));
      expect(await followup).toMatchObject({ ok: true, action: "status" });
      oldDevice.close(); replacement.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("bounds outstanding native requests while the target is unresponsive", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const device = await connect(host.url, "device", "device-token");
      const requests = Array.from({ length: 32 }, () => manager.requestComputerUse("device", { tool: "browser", action: "status" }).catch(() => undefined));
      await expect(manager.requestComputerUse("device", { tool: "browser", action: "status" })).rejects.toThrow("request limit");
      manager.removeDevice("device");
      await Promise.all(requests);
      device.close();
    } finally { await manager.close(); await host.close(); }
  });

  it.each(["disconnect", "remove", "disable", "credential", "lease", "close"] as const)("fences pending operations on %s without replay", async (reason) => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-token" } });
    if (reason === "lease") manager.setDeviceConnectionLease("device", "lease-one");
    await manager.start();
    const host = await server(manager);
    try {
      const device = await connect(host.url, "device", "device-token", "win32", reason === "lease" ? { connectionLease: "lease-one" } : {});
      const next = nextMessage(device, "hub.computer_request");
      const response = manager.requestComputerUse("device", open);
      const rejection = expect(response).rejects.toThrow(/disconnected|removed|disabled|credential|lease|closed/);
      await next;
      if (reason === "disconnect") device.close();
      else if (reason === "remove") manager.removeDevice("device");
      else if (reason === "disable") manager.setRemoteConnectionsEnabled(false);
      else if (reason === "credential") manager.setDeviceCredential("device", "replacement-token");
      else if (reason === "lease") manager.setDeviceConnectionLease("device", "lease-two");
      else await manager.close();
      await rejection;
      if (reason === "lease") await expect(manager.requestComputerUse("device", open)).rejects.toThrow("lease changed");
      device.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("downgrades browser-v2 requests for legacy remote Envs without agent-browser-v2: strips new fields, emulates auto-snapshot, and rejects batch cleanly", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { legacy: "legacy-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const legacy = await connect(host.url, "legacy", "legacy-token", "linux", { capabilities: ["agent-browser", "agent-desktop"] });
      const received: ComputerUseRequest[] = [];
      let failNextSnapshot = false;
      legacy.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as HubToEnvControlMessage;
        if (msg.type !== "hub.computer_request") return;
        received.push(msg.request);
        if (msg.request.action === "snapshot") {
          if (failNextSnapshot) {
            failNextSnapshot = false;
            legacy.send(JSON.stringify({
              type: "env.computer_result",
              requestId: msg.requestId,
              result: { tool: "browser", action: "snapshot", sessionId: msg.request.sessionId, platform: "linux", ok: false, error: { code: "SNAP_ERR", message: "page navigating" } },
            }));
            return;
          }
          legacy.send(JSON.stringify({
            type: "env.computer_result",
            requestId: msg.requestId,
            result: result(msg.request, "linux", { snapshot: '- button "Login" [ref=e1] secret-val', refs: { e1: { role: "button" } } }),
          }));
          return;
        }
        legacy.send(JSON.stringify({
          type: "env.computer_result",
          requestId: msg.requestId,
          result: result(msg.request, "linux", { url: "https://legacy.example.com" }),
        }));
      });

      // 1. open with returnSnapshot=true & snapshotMode="compact" -> strips fields on wire & emulates follow-up snapshot RPC (stripping data.refs!)
      const opened = await manager.requestComputerUse("legacy", {
        tool: "browser",
        action: "open",
        sessionId: "legacy-s1",
        url: "https://legacy.example.com",
        returnSnapshot: true,
        snapshotMode: "compact",
      });
      expect(opened).toMatchObject({
        ok: true,
        data: {
          url: "https://legacy.example.com",
          snapshot: '- button "Login" [ref=e1] secret-val',
        },
      });
      expect(opened.data as Record<string, unknown>).not.toHaveProperty("refs");
      expect(received[0]).toEqual({ tool: "browser", action: "open", sessionId: "legacy-s1", url: "https://legacy.example.com" });
      expect(received[1]).toEqual({ tool: "browser", action: "snapshot", sessionId: "legacy-s1" });

      // 2. open with returnSnapshot=false -> strips returnSnapshot and sends ONLY 1 RPC
      const countBeforeNoSnap = received.length;
      const openNoSnap = await manager.requestComputerUse("legacy", {
        tool: "browser",
        action: "open",
        sessionId: "legacy-s1",
        url: "https://legacy.example.com",
        returnSnapshot: false,
      });
      expect(openNoSnap.ok).toBe(true);
      expect(received.length).toBe(countBeforeNoSnap + 1);
      expect(received.at(-1)).toEqual({ tool: "browser", action: "open", sessionId: "legacy-s1", url: "https://legacy.example.com" });

      // 3. snapshot with mode="compact" -> strips mode on wire
      const snap = await manager.requestComputerUse("legacy", { tool: "browser", action: "snapshot", sessionId: "legacy-s1", mode: "compact" });
      expect(snap.ok).toBe(true);
      expect(received.at(-1)).toEqual({ tool: "browser", action: "snapshot", sessionId: "legacy-s1" });

      // 4. fill with returnSnapshot=true -> strips returnSnapshot, emulates snapshot, scrubs typed secret
      const filled = await manager.requestComputerUse("legacy", {
        tool: "browser",
        action: "fill",
        sessionId: "legacy-s1",
        ref: "@e1",
        text: "secret-val",
        returnSnapshot: true,
      });
      expect(filled.ok).toBe(true);
      expect(JSON.stringify(filled)).not.toContain("secret-val");
      expect((filled.data as Record<string, unknown>).snapshot as string).toContain("[input omitted]");

      // 5. Follow-up emulated snapshot error degrades gracefully without rejecting primary action
      failNextSnapshot = true;
      const degraded = await manager.requestComputerUse("legacy", { tool: "browser", action: "click", sessionId: "legacy-s1", ref: "@e1" });
      expect(degraded).toMatchObject({
        ok: true,
        data: {
          observationRequired: true,
          snapshotError: "page navigating",
        },
      });

      // 6. batch on legacy remote Env rejected cleanly without sending wire payload
      const countBeforeBatch = received.length;
      const batchRejected = await manager.requestComputerUse("legacy", {
        tool: "browser",
        action: "batch",
        sessionId: "legacy-s1",
        steps: [{ action: "click", ref: "@e1" }],
      });
      expect(batchRejected).toMatchObject({
        ok: false,
        action: "batch",
        platform: "linux",
        error: { code: "CAPABILITY_UNSUPPORTED", message: expect.stringContaining("agent-browser-v2") },
      });
      expect(received.length).toBe(countBeforeBatch);
      legacy.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("uses dynamic computerUseRpcTimeoutMs for multi-step batch requests instead of the fixed 45s timeout", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { v2: "v2-token" } });
    await manager.start();
    const host = await server(manager);
    try {
      const device = await connect(host.url, "v2", "v2-token");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const batchReq: ComputerUseRequest = {
        tool: "browser",
        action: "batch",
        sessionId: "kulo-batch-deadline",
        steps: [
          { action: "fill", ref: "@e1", text: "user" },
          { action: "fill", ref: "@e2", text: "pass" },
          { action: "click", ref: "@e3" },
          { action: "wait", text: "Dashboard", timeoutMs: 15_000 },
        ],
      };
      const expectedTimeout = computerUseRpcTimeoutMs(batchReq);
      expect(expectedTimeout).toBeGreaterThan(45_000);

      const incoming = nextMessage(device, "hub.computer_request");
      const response = manager.requestComputerUse("v2", batchReq);
      let settled = false;
      const rejection = response.then(() => { settled = true; }, (err) => { settled = true; throw err; });
      const reqMsg = await incoming;
      const cancelled = nextMessage(device, "hub.computer_cancel");

      // Still alive past the old 45s wall
      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).toBe(false);

      // Expires exactly when reaching dynamic computerUseRpcTimeoutMs(batchReq)
      const expectation = expect(rejection).rejects.toThrow("not confirmed in time");
      await vi.advanceTimersByTimeAsync(expectedTimeout - 45_000);
      await expectation;
      expect(await cancelled).toMatchObject({ requestId: reqMsg.requestId });
      vi.useRealTimers();
      device.close();
    } finally { vi.useRealTimers(); await manager.close(); await host.close(); }
  });
});
