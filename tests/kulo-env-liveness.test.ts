import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { EnvManager, KuloEnvAgent, startDevicePeer } from "@kulo/env";

const cleanups: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function mkTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface TcpTunnel {
  client: net.Socket;
  upstream: net.Socket;
  blackhole(): void;
  closeUpstreamSilently(): void;
}

/**
 * Loopback TCP proxy that can turn an active WebSocket TCP stream into a true
 * half-open / blackholed socket (no FIN/RST delivered to the client) while
 * continuing to forward subsequent reconnect attempts normally.
 */
async function startControllableTcpProxy(targetPort: number): Promise<{
  port: number;
  tunnels: TcpTunnel[];
}> {
  const tunnels: TcpTunnel[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    let dropped = false;
    const forwardToUpstream = (chunk: Buffer) => {
      if (!dropped && !upstream.destroyed) upstream.write(chunk);
    };
    const forwardToClient = (chunk: Buffer) => {
      if (!dropped && !client.destroyed) client.write(chunk);
    };
    const endUpstream = () => {
      if (!dropped && !upstream.destroyed) upstream.end();
    };
    const endClient = () => {
      if (!dropped && !client.destroyed) client.end();
    };
    client.on("data", forwardToUpstream);
    upstream.on("data", forwardToClient);
    client.on("end", endUpstream);
    upstream.on("end", endClient);
    client.on("error", () => { if (!dropped) upstream.destroy(); });
    upstream.on("error", () => { if (!dropped) client.destroy(); });

    const tunnel: TcpTunnel = {
      client,
      upstream,
      blackhole() {
        dropped = true;
      },
      closeUpstreamSilently() {
        dropped = true;
        upstream.destroy();
      },
    };
    tunnels.push(tunnel);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  cleanups.push(async () => {
    for (const tunnel of tunnels) {
      tunnel.client.destroy();
      tunnel.upstream.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: address.port, tunnels };
}

async function startEnvHub(options: {
  envId?: string;
  token?: string;
  pingIntervalMs?: number;
  maxMissedPings?: number;
  streamResumeGraceMs?: number;
} = {}) {
  const envId = options.envId ?? "laptop-env";
  const token = options.token ?? "secret-liveness-token";
  const envManager = new EnvManager({
    enableLocal: false,
    envTokens: { [envId]: token },
    workerEnvIds: [envId],
    pingIntervalMs: options.pingIntervalMs,
    maxMissedPings: options.maxMissedPings,
    streamResumeGraceMs: options.streamResumeGraceMs ?? 0,
  });
  await envManager.start();
  cleanups.push(() => envManager.close());

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  const wss = new WebSocketServer({ server, path: "/ws/env" });
  const serverSockets: WebSocket[] = [];
  wss.on("connection", (ws) => {
    serverSockets.push(ws);
    envManager.handleEnvWebSocket(ws);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  cleanups.push(async () => {
    for (const s of serverSockets) {
      if (s.readyState !== WebSocket.CLOSED) s.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return { envId, token, envManager, server, wss, serverSockets, port: addr.port };
}

describe("Env WebSocket half-open / sleep-wake liveness recovery", () => {
  it("automatically detects a half-open zombie socket via idle watchdog and reconnects", async () => {
    const hub = await startEnvHub({ pingIntervalMs: 60_000, maxMissedPings: 0, streamResumeGraceMs: 0 });
    const proxy = await startControllableTcpProxy(hub.port);
    const rootDir = mkTempDir("kulo-liveness-idle-");

    const agent = new KuloEnvAgent({
      hubUrl: `ws://127.0.0.1:${proxy.port}/ws/env`,
      envId: hub.envId,
      name: "MacBook Pro",
      rootDir,
      authToken: hub.token,
      streamResumeGraceMs: 0,
      heartbeatIdleMs: 120,
      heartbeatTimeoutMs: 120,
    });
    cleanups.push(() => agent.stop());
    await agent.start();

    expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);
    expect(proxy.tunnels).toHaveLength(1);

    // Simulate OS sleep where Hub closed its end while MacBook never received FIN/RST.
    proxy.tunnels[0]!.closeUpstreamSilently();

    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(false);
    }, { timeout: 2_000, interval: 20 });

    // Without external nudges, the agent's idle watchdog probes, times out, and reconnects.
    await vi.waitFor(() => {
      expect(proxy.tunnels.length).toBeGreaterThanOrEqual(2);
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);
      expect(agent.registered).toBe(true);
    }, { timeout: 5_000, interval: 25 });
  });

  it("recovers immediately when probeConnection() is triggered after wake on a blackholed socket", async () => {
    const hub = await startEnvHub({ pingIntervalMs: 60_000, maxMissedPings: 0, streamResumeGraceMs: 0 });
    const proxy = await startControllableTcpProxy(hub.port);
    const rootDir = mkTempDir("kulo-liveness-probe-");

    const agent = new KuloEnvAgent({
      hubUrl: `ws://127.0.0.1:${proxy.port}/ws/env`,
      envId: hub.envId,
      name: "MacBook Pro",
      rootDir,
      authToken: hub.token,
      streamResumeGraceMs: 0,
      // Long idle interval so recovery must come from explicit probeConnection().
      heartbeatIdleMs: 60_000,
      heartbeatTimeoutMs: 120,
    });
    cleanups.push(() => agent.stop());
    await agent.start();

    expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);
    proxy.tunnels[0]!.closeUpstreamSilently();

    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(false);
    }, { timeout: 2_000, interval: 20 });

    // Confirm the client still thinks the zombie socket is open before probeConnection().
    expect(agent.registered).toBe(true);

    agent.probeConnection();

    await vi.waitFor(() => {
      expect(proxy.tunnels.length).toBeGreaterThanOrEqual(2);
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);
      expect(agent.registered).toBe(true);
    }, { timeout: 5_000, interval: 25 });
  });

  it("keeps a healthy connection intact on probeConnection() and updates Hub lastSeenAt via WS ping", async () => {
    const hub = await startEnvHub({ pingIntervalMs: 60_000, maxMissedPings: 0 });
    const rootDir = mkTempDir("kulo-liveness-healthy-");

    const agent = new KuloEnvAgent({
      hubUrl: `ws://127.0.0.1:${hub.port}/ws/env`,
      envId: hub.envId,
      name: "MacBook Pro",
      rootDir,
      authToken: hub.token,
      heartbeatIdleMs: 60_000,
      heartbeatTimeoutMs: 500,
    });
    cleanups.push(() => agent.stop());
    await agent.start();

    const initialSocket = hub.serverSockets[0]!;
    const beforeSeen = hub.envManager.getEnvDescriptor(hub.envId)!.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 15));

    const pingReceived = once(initialSocket, "ping");
    agent.probeConnection();
    await pingReceived;

    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor(hub.envId)!.lastSeenAt).toBeGreaterThan(beforeSeen);
    }, { timeout: 2_000, interval: 15 });

    // Wait past heartbeatTimeoutMs to confirm pong cleared the timeout and socket stayed open.
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(hub.serverSockets).toHaveLength(1);
    expect(initialSocket.readyState).toBe(WebSocket.OPEN);
    expect(agent.registered).toBe(true);
  });

  it("times out a hung env.register handshake and reconnects cleanly", async () => {
    const rootDir = mkTempDir("kulo-liveness-reg-");
    let attempts = 0;
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: "/ws/env" });
    const sockets: WebSocket[] = [];
    wss.on("connection", (ws) => {
      sockets.push(ws);
      const attempt = ++attempts;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as { type?: string; envId?: string };
        if (msg.type === "env.register" && attempt >= 2) {
          ws.send(JSON.stringify({ type: "hub.registered", envId: msg.envId }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as net.AddressInfo;
    cleanups.push(async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    });

    const agent = new KuloEnvAgent({
      hubUrl: `ws://127.0.0.1:${addr.port}/ws/env`,
      envId: "reg-timeout-env",
      rootDir,
      heartbeatIdleMs: 60_000,
      heartbeatTimeoutMs: 120,
    });
    cleanups.push(() => agent.stop());

    await agent.start();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(agent.registered).toBe(true);
  });

  it("evicts silent half-open peers on the Hub side after consecutive missed pings", async () => {
    const hub = await startEnvHub({
      pingIntervalMs: 60,
      maxMissedPings: 2,
      streamResumeGraceMs: 0,
    });

    const silentClient = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/env`);
    cleanups.push(() => { if (silentClient.readyState !== WebSocket.CLOSED) silentClient.terminate(); });
    await once(silentClient, "open");

    const registered = once(silentClient, "message");
    silentClient.send(JSON.stringify({
      type: "env.register",
      envId: hub.envId,
      name: "Silent Device",
      rootDir: "/tmp",
      platform: process.platform,
      arch: process.arch,
      capabilities: ["fs", "bash"],
      token: hub.token,
    }));
    expect(JSON.parse((await registered)[0].toString("utf8"))).toMatchObject({ type: "hub.registered" });
    expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);

    // Never reply to hub.ping -> Hub terminates the silent connection and marks it offline.
    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(false);
    }, { timeout: 3_000, interval: 20 });
  });

  it("recovers a joined DevicePeerRuntime when probeConnection() is called on a blackholed tunnel", async () => {
    const hub = await startEnvHub({ pingIntervalMs: 60_000, maxMissedPings: 0, streamResumeGraceMs: 0 });
    const proxy = await startControllableTcpProxy(hub.port);
    const rootDir = mkTempDir("kulo-liveness-peer-");

    const peer = await startDevicePeer({
      version: 1,
      deviceId: hub.envId,
      name: "Peer Laptop",
      hubUrl: `http://127.0.0.1:${proxy.port}`,
      clientToken: "peer-client-liveness",
      envToken: hub.token,
      rootDir,
      localPort: 0,
    }, {
      configPath: path.join(rootDir, "connection.json"),
      heartbeatIdleMs: 60_000,
      heartbeatTimeoutMs: 120,
    });
    cleanups.push(() => peer.close());
    await peer.ready;

    expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);
    const envTunnel = proxy.tunnels[0]!;
    envTunnel.closeUpstreamSilently();

    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(false);
    }, { timeout: 2_000, interval: 20 });

    peer.probeConnection();

    await vi.waitFor(() => {
      expect(hub.envManager.getEnvDescriptor(hub.envId)?.online).toBe(true);
    }, { timeout: 5_000, interval: 25 });
  });

  it("accelerates a pending reconnect backoff immediately when probeConnection() is called", async () => {
    // Pick a free port, close it so initial attempts fail and enter multi-second backoff.
    const probeServer = http.createServer();
    await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
    const port = (probeServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const rootDir = mkTempDir("kulo-liveness-backoff-");
    const logs: string[] = [];
    const agent = new KuloEnvAgent({
      hubUrl: `ws://127.0.0.1:${port}/ws/env`,
      envId: "backoff-env",
      rootDir,
      onLog: (msg) => logs.push(msg),
    });
    cleanups.push(() => agent.stop());

    const started = agent.start();
    // Wait until agent hits backoff >= 3200ms (attempt 3+)
    await vi.waitFor(() => {
      expect(logs.some((line) => /Reconnecting in (?:3200|6400|12800|15000)ms/.test(line))).toBe(true);
    }, { timeout: 8_000, interval: 50 });

    // Bring Hub online on that exact port, then immediately trigger wake probe.
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: "/ws/env" });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as { type?: string; envId?: string };
        if (msg.type === "env.register") {
          ws.send(JSON.stringify({ type: "hub.registered", envId: msg.envId }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    cleanups.push(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    });

    const beforeProbe = Date.now();
    agent.probeConnection();
    await started;
    expect(Date.now() - beforeProbe).toBeLessThan(2_000);
    expect(agent.registered).toBe(true);
  }, 15_000);

  it("enforces connection lease fencing on WebSocket ping frames in EnvManager", async () => {
    const hub = await startEnvHub({ pingIntervalMs: 60_000, maxMissedPings: 0 });
    hub.envManager.setDeviceConnectionLease(hub.envId, "lease-1");

    const client = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/env`);
    cleanups.push(() => { if (client.readyState !== WebSocket.CLOSED) client.terminate(); });
    await once(client, "open");
    const registered = once(client, "message");
    client.send(JSON.stringify({
      type: "env.register",
      envId: hub.envId,
      name: "Leased Device",
      rootDir: "/tmp",
      platform: process.platform,
      arch: process.arch,
      capabilities: ["fs", "bash"],
      token: hub.token,
      connectionLease: "lease-1",
    }));
    await registered;
    const seenBefore = hub.envManager.getEnvDescriptor(hub.envId)!.lastSeenAt;

    hub.envManager.setDeviceConnectionLease(hub.envId, "lease-2");
    const closed = once(client, "close");
    client.ping();
    expect((await closed)[0]).toBe(4009);
    expect(hub.envManager.getEnvDescriptor(hub.envId)!.lastSeenAt).toBe(seenBefore);
  });
});
