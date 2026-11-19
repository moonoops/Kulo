import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { EnvManager, MocoEnvAgent } from "@moco/env";
import type { EnvToHubControlMessage, HubToEnvControlMessage } from "@moco/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

type Registration = Extract<EnvToHubControlMessage, { type: "env.register" }>;

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-native-device-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new EnvManager({
    enableLocal: false,
    envTokens: { phone: "phone-node-test", desktop: "desktop-node-test" },
    workerEnvIds: ["phone", "desktop"],
  });
  await manager.start();
  cleanups.push(() => manager.close());
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => manager.handleEnvWebSocket(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function openSocket() {
    const socket = new WebSocket(url);
    const received: HubToEnvControlMessage[] = [];
    socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as HubToEnvControlMessage));
    await once(socket, "open");
    cleanups.push(async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
    });
    return { socket, received };
  }
  const registration = (patch: Partial<Registration> = {}): Registration => ({
    type: "env.register", envId: "phone", token: "phone-node-test", name: "Android phone",
    platform: "android", arch: "arm64", rootDir: "", executionKind: "native-device", capabilities: ["android-device"], ...patch,
  });
  async function connect(patch: Partial<Registration> = {}) {
    const node = await openSocket();
    const registered = once(node.socket, "message");
    node.socket.send(JSON.stringify(registration(patch)));
    const [raw] = await registered;
    expect(JSON.parse(raw.toString())).toEqual({ type: "hub.registered", envId: patch.envId ?? "phone" });
    return node;
  }
  return { manager, root, url, openSocket, registration, connect };
}

describe("native Android Env boundary", () => {
  it("keeps Android online and exchanges heartbeats without advertising or accepting Pi execution", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture();
    const { socket, received } = await f.connect();
    expect(f.manager.listEnvs()).toEqual([expect.objectContaining({
      id: "phone", online: true, executionKind: "native-device", capabilities: ["android-device"],
    })]);
    const ping = once(socket, "message");
    vi.advanceTimersByTime(15_000);
    expect(JSON.parse((await ping)[0].toString())).toMatchObject({ type: "hub.ping" });
    const previousSeen = f.manager.getEnvDescriptor("phone")!.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.send(JSON.stringify({ type: "env.pong", ts: -1 }));
    await vi.waitFor(() => expect(f.manager.getEnvDescriptor("phone")!.lastSeenAt).toBeGreaterThan(previousSeen));

    expect(() => f.manager.pickDefaultEnvId()).toThrow("No execution environment");
    expect(() => f.manager.pickDefaultWorkerEnvId()).toThrow("No isolated Worker Env");
    expect(() => f.manager.createExecutionEnv("phone", "/phone")).toThrow("does not support Pi Env");
    expect(() => f.manager.createWorkerExecutionEnv("phone", "/phone")).toThrow("does not support Pi Env");
    await expect(f.manager.listProjectDirectories("phone")).rejects.toThrow("does not support Pi Env");
    await expect(f.manager.authorizeProjectDirectory("phone", {
      projectId: "project-phone", path: "/phone", operationId: "grant-phone",
    })).rejects.toThrow("does not support Pi Env");
    await expect(f.manager.revokeProjectDirectory("phone", "project-phone")).rejects.toThrow("does not support Pi Env");
    await expect(f.manager.releaseWorkerExecutionEnv("phone", "/phone")).rejects.toThrow("does not support Pi Env");
    await expect(f.manager.requestBrowser("phone", { action: "check", profileRef: "profile-one" })).rejects.toThrow("does not support Pi Env");
    expect(received.map((message) => message.type)).toEqual(["hub.registered", "hub.ping"]);
  });

  it("preserves empty native capabilities rather than granting the legacy fs/bash defaults", async () => {
    const f = await fixture();
    await f.connect({ capabilities: [] });
    expect(f.manager.getEnvDescriptor("phone")?.capabilities).toEqual([]);
    expect(() => f.manager.pickDefaultEnvId()).toThrow("No execution environment");
  });

  it.each(["fs", "bash", "worker-isolation", "flow-browser", "ssh", "unexpected-capability"])(
    "rejects a native device declaring unsupported capability %s",
    async (capability) => {
      const f = await fixture();
      const { socket } = await f.openSocket();
      const closed = once(socket, "close");
      socket.send(JSON.stringify(f.registration({ capabilities: ["android-device", capability] })));
      expect((await closed)[0]).toBe(4002);
      expect(f.manager.getEnvDescriptor("phone")).toBeUndefined();
    },
  );

  it("rejects an unknown execution kind instead of treating it as a desktop node", async () => {
    const f = await fixture();
    const { socket } = await f.openSocket();
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ ...f.registration(), executionKind: "unknown" }));
    expect((await closed)[0]).toBe(4002);
    expect(f.manager.listEnvs()).toEqual([]);
  });

  it("retains desktop registration defaults and real Pi Env file operations with Android online", async () => {
    const f = await fixture();
    await f.connect();
    const legacy = await f.connect({ envId: "desktop", token: "desktop-node-test", platform: process.platform,
      name: "Legacy desktop", rootDir: f.root, executionKind: undefined, capabilities: [] });
    expect(f.manager.getEnvDescriptor("desktop")).toMatchObject({ executionKind: "pi-env", capabilities: ["fs", "bash"] });
    expect(f.manager.pickDefaultEnvId()).toBe("desktop");
    const legacyClosed = once(legacy.socket, "close");
    legacy.socket.close();
    await legacyClosed;

    const agent = new MocoEnvAgent({ hubUrl: f.url, envId: "desktop", authToken: "desktop-node-test",
      rootDir: f.root, reconnect: false });
    cleanups.push(() => agent.stop());
    await agent.start();
    expect(f.manager.getEnvDescriptor("desktop")).toMatchObject({ online: true, executionKind: "pi-env" });
    expect(f.manager.pickDefaultEnvId()).toBe("desktop");
    const env = f.manager.createExecutionEnv("desktop", f.root);
    expect(await env.writeFile("desktop.txt", "desktop-pi-env", BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
    expect(await env.readTextFile("desktop.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "desktop-pi-env" });
    expect((await f.manager.listProjectDirectories("desktop", f.root)).deviceId).toBe("desktop");
  });

  it("keeps the replacement connection online after the old Android socket closes", async () => {
    const f = await fixture();
    const first = await f.connect();
    const firstClosed = once(first.socket, "close");
    const replacement = await f.connect({ name: "Android over Tailscale" });
    expect((await firstClosed)[0]).toBe(4000);
    expect(f.manager.getEnvDescriptor("phone")).toMatchObject({ online: true, name: "Android over Tailscale" });
    replacement.socket.send(JSON.stringify({ type: "env.pong", ts: Date.now() }));
    await vi.waitFor(() => expect(f.manager.getEnvDescriptor("phone")?.online).toBe(true));
    const closed = once(replacement.socket, "close");
    replacement.socket.close();
    await closed;
    await vi.waitFor(() => expect(f.manager.getEnvDescriptor("phone")?.online).toBe(false));
    expect(() => f.manager.pickDefaultEnvId()).toThrow("No execution environment");
  });

  it.each(["old-route-lease", undefined])("rejects an unbound late LAN registration with lease %s after Tailscale takes over", async (oldLease) => {
    const f = await fixture();
    f.manager.setDeviceConnectionLease("phone", "old-route-lease");
    const delayed = await f.openSocket();
    f.manager.setDeviceConnectionLease("phone", "new-route-lease");
    await f.connect({ name: "Phone over Tailscale", connectionLease: "new-route-lease" });
    const rejected = once(delayed.socket, "close");
    delayed.socket.send(JSON.stringify(f.registration({ name: "Stale LAN phone", connectionLease: oldLease })));
    expect((await rejected)[0]).toBe(4009);
    expect(delayed.received).toEqual([]);
    expect(f.manager.getEnvDescriptor("phone")).toMatchObject({ online: true, name: "Phone over Tailscale" });
  });

  it("fences an already registered generation immediately when a new lease is issued", async () => {
    const f = await fixture();
    f.manager.setDeviceConnectionLease("phone", "old-route-lease");
    const old = await f.connect({ connectionLease: "old-route-lease" });
    const lastSeenAt = f.manager.getEnvDescriptor("phone")!.lastSeenAt;
    f.manager.setDeviceConnectionLease("phone", "new-route-lease");
    const rejected = once(old.socket, "close");
    old.socket.send(JSON.stringify({ type: "env.pong", ts: Date.now() + 100_000 }));
    expect((await rejected)[0]).toBe(4009);
    expect(f.manager.getEnvDescriptor("phone")?.lastSeenAt).toBe(lastSeenAt);
    await f.connect({ name: "New generation", connectionLease: "new-route-lease" });
    expect(f.manager.getEnvDescriptor("phone")).toMatchObject({ online: true, name: "New generation" });
  });
});
