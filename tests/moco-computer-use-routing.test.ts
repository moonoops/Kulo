import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseRequest, ComputerUseResult, HubToEnvControlMessage } from "@moco/protocol";
import { EnvManager } from "../packages/env/src/bridge.js";
import { MocoEnvAgent } from "../packages/env/src/agent.js";
import type { ComputerUseService } from "../packages/env/src/computer-use.js";

const directories: string[] = [];
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moco-computer-routing-"));
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

function service(rootDir: string, handler: (request: ComputerUseRequest, active: () => boolean, signal?: AbortSignal) => Promise<ComputerUseResult> = async (request) => result(request), capabilities = ["agent-browser", "agent-desktop"]) {
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
  socket.send(JSON.stringify({ type: "env.register", envId, token, name: envId, rootDir: platform === "win32" ? "C:\\moco-env" : "/tmp/moco-env", platform, arch: "x64", capabilities: ["agent-browser", "agent-desktop"], ...extra }));
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

const open: ComputerUseRequest = { tool: "browser", action: "open", sessionId: "moco-ticket-one", url: "https://example.com" };

describe("computer use Env routing", () => {
  it("rejects unknown opt-in values before opening a local transport", () => {
    vi.stubEnv("MOCO_COMPUTER_USE", "browser,unexpected");
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
    const agent = new MocoEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-token", rootDir: path.join(root, "env"), computerUseService: computer.instance, reconnect: false });
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
    const agent = new MocoEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-token", rootDir: path.join(root, "env"), computerUseService: computer.instance, capabilities: ["agent-browser", "agent-desktop"], reconnect: false });
    try {
      await agent.start();
      expect(manager.getEnvDescriptor("device")?.capabilities).not.toContain("agent-browser");
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
    const agent = new MocoEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-token", rootDir: path.join(root, "env"), computerUseService: computer.instance, reconnect: false });
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
});
