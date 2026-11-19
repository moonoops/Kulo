import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { DeviceRoleTransitions, readPeerConfig, savePeerConfig, startDevicePeer, type DevicePeerRuntime } from "@kulo/env";
import { formatDeviceChatInvitation, type DevicePeerConfig, type DeviceRoleTransition } from "@kulo/protocol";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function remote(rootDir: string) {
  const hubId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const settings = { acceptsInvite: true, servesTopics: true, holdPair: undefined as Promise<void> | undefined };
  let pairCalls = 0;
  let expectedHubId: unknown;
  let origin = "";
  const config: DevicePeerConfig = {
    version: 1, deviceId: randomUUID(), name: "同一个设备名", hubUrl: "", rootDir, localPort: 0,
    clientToken: randomBytes(32).toString("hex"), envToken: randomBytes(32).toString("hex"),
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/devices/pair" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      pairCalls++;
      const input = JSON.parse(body);
      expectedHubId = input.expectedHubId;
      await settings.holdPair;
      if (!settings.acceptsInvite || input.inviteToken !== token) { res.writeHead(401).end("{}"); return; }
      res.end(JSON.stringify(config));
      return;
    }
    if (req.headers.authorization !== `Bearer ${config.clientToken}`) { res.writeHead(401).end("{}"); return; }
    if (req.url === "/api/devices") {
      res.end(JSON.stringify({ enabled: true, role: "joined", hubId, currentDeviceId: config.deviceId, hubName: "同名主机", hubUrls: [origin], devices: [] }));
    } else if (req.url === "/api/topics") {
      res.writeHead(settings.servesTopics ? 200 : 503).end(JSON.stringify({ items: [] }));
    } else { res.writeHead(404).end("{}"); }
  });
  const wss = new WebSocketServer({ server, path: "/ws/env" });
  let env: WebSocket | undefined;
  wss.on("connection", (socket) => socket.on("message", (raw, binary) => {
    if (binary) return;
    const message = JSON.parse(raw.toString());
    if (message.type === "env.register" && message.envId === config.deviceId && message.token === config.envToken) {
      env = socket;
      socket.send(JSON.stringify({ type: "hub.registered", envId: config.deviceId }));
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  config.hubUrl = origin;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return {
    config, settings, close, pairCalls: () => pairCalls, expectedHubId: () => expectedHubId,
    invitation: (id = hubId) => formatDeviceChatInvitation({ hubId: id, hubName: "同名主机", hubUrl: origin, inviteToken: token }),
    async startLocalWork() {
      const socket = env!;
      const opened = new Promise<void>((resolve, reject) => {
        const receive = (raw: Buffer, binary: boolean) => {
          if (binary) return;
          const message = JSON.parse(raw.toString());
          if (message.streamId !== 17) return;
          socket.off("message", receive);
          if (message.type === "env.stream_ready") resolve();
          else reject(new Error("Could not open fixture execution stream"));
        };
        socket.on("message", receive);
      });
      socket.send(JSON.stringify({ type: "hub.open_stream", streamId: 17, daemonToken: randomUUID() }));
      await opened;
    },
  };
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-reassociate-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldHost = await remote(path.join(root, "workspace"));
  const target = await remote(oldHost.config.rootDir);
  const file = path.join(root, "connection.json");
  savePeerConfig(oldHost.config, file);
  const authToken = randomBytes(32).toString("hex");
  const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
  let current: DevicePeerRuntime | undefined;
  let port = 0;
  const startPeer = async (config: DevicePeerConfig) => {
    await current?.close();
    current = await startDevicePeer(config, { roleTransitions: roles, port, configPath: file, authToken });
    port = current.port;
    return current;
  };
  const roles = new DeviceRoleTransitions({ configPath: file, startPeer, startHub: () => { throw new Error("Must restore the previous peer"); } });
  cleanup.push(async () => { await roles.settled(); await current?.close(); });
  const peer = await startPeer(oldHost.config);
  await peer.ready;
  const post = (input: string, id: string, force = false, extraHeaders = {}) => fetch(new URL("/api/devices/join", peer.url), {
    method: "POST", headers: { ...headers, "x-kulo-transition-id": id, ...extraHeaders }, body: JSON.stringify({ input, force }),
  });
  const result = async (id: string) => {
    let state: DeviceRoleTransition;
    await vi.waitFor(async () => {
      const response = await fetch(new URL(`/api/devices/role-transition?id=${id}`, peer.url), { headers });
      state = await response.json() as DeviceRoleTransition;
      expect(state.id).toBe(id);
      expect(state.status).not.toBe("switching");
    }, { timeout: 8_000, interval: 30 });
    return state!;
  };
  const submit = async (input: string, id: string, force = false) => {
    const response = await post(input, id, force);
    expect(response.status).toBe(202);
    expect((await response.json()).id).toBe(id);
    return result(id);
  };
  return { oldHost, target, file, submit, post, result, peer, headers };
}

it("recognizes the authenticated current Hub, switches only this device after confirmation, and deduplicates receipts", async () => {
  const { oldHost, target, file, submit, post } = await fixture();
  await oldHost.startLocalWork();
  expect(await submit(oldHost.invitation(), "same")).toMatchObject({ status: "ready" });
  expect(oldHost.pairCalls()).toBe(0);
  expect(await submit(target.invitation(), "busy")).toMatchObject({ status: "failed", code: "local_tasks_running" });
  expect(target.pairCalls()).toBe(0);
  expect((await post(target.invitation(), "denied", true, { "x-forwarded-for": "192.0.2.1" })).status).toBe(403);
  target.config.rootDir = path.join(oldHost.config.rootDir, "unselected");
  expect(await submit(target.invitation(), "confirmed", true)).toMatchObject({ status: "ready" });
  expect(readPeerConfig(file)).toMatchObject({ deviceId: target.config.deviceId, rootDir: oldHost.config.rootDir });
  expect(await submit(target.invitation(), "confirmed", true)).toMatchObject({ status: "ready" });
  expect((await post(oldHost.invitation(), "confirmed")).status).toBe(409);
  expect(target.pairCalls()).toBe(1);
}, 20_000);

it("retains the previous Peer on invalid invitations, identity mismatch or a failed readiness check, and can retry", async () => {
  const { oldHost, target, file, headers, peer, submit } = await fixture();
  target.settings.acceptsInvite = false;
  expect(await submit(target.invitation(), "expired")).toMatchObject({ status: "failed", code: "device_invitation_invalid" });
  target.settings.acceptsInvite = true;
  expect(await submit(target.invitation("wrong-hub"), "mismatch")).toMatchObject({ status: "failed", code: "device_invitation_invalid" });
  expect(target.expectedHubId()).toBe("wrong-hub"); // This fixture emulates an old issuer that ignores expectedHubId.
  expect(readPeerConfig(file)?.deviceId).toBe(oldHost.config.deviceId);
  target.settings.servesTopics = false;
  expect(await submit(target.invitation(), "unready")).toMatchObject({ status: "failed", code: "device_host_unreachable" });
  expect(readPeerConfig(file)?.deviceId).toBe(oldHost.config.deviceId);
  expect(await (await fetch(new URL("/api/devices", peer.url), { headers })).json()).toMatchObject({ hubId: expect.any(String), currentDeviceId: oldHost.config.deviceId, role: "joined" });
  const paired = target.pairCalls();
  target.settings.servesTopics = true;
  expect(await submit(target.invitation(), "retry")).toMatchObject({ status: "ready" });
  expect(target.pairCalls()).toBe(paired);
}, 20_000);

it("serializes competing switches while a repeated submission observes the original operation", async () => {
  const { oldHost, target, post, result, file } = await fixture();
  let allowPair!: () => void;
  target.settings.holdPair = new Promise((resolve) => { allowPair = resolve; });
  try {
    const input = target.invitation();
    expect((await post(input, "first")).status).toBe(202);
    await vi.waitFor(() => expect(target.pairCalls()).toBe(1));
    expect(await (await post(input, "first")).json()).toMatchObject({ id: "first", status: "switching" });
    const competing = await post(oldHost.invitation(), "other");
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({ code: "role_switch_busy" });
    expect(readPeerConfig(file)?.deviceId).toBe(oldHost.config.deviceId);
  } finally { allowPair(); }
  expect(await result("first")).toMatchObject({ status: "ready" });
  expect(target.pairCalls()).toBe(1);
}, 20_000);

it("reports a previously connected Hub as offline and allows switching away from it", async () => {
  const { oldHost, target, submit, file, peer, headers } = await fixture();
  await oldHost.close();
  expect(await submit(oldHost.invitation(), "old-offline")).toMatchObject({ status: "failed", code: "device_host_unreachable" });
  expect(await (await fetch(new URL("/api/devices", peer.url), { headers })).json()).toMatchObject({ currentDeviceKnown: true, canSwitchRole: true, hubError: expect.any(String) });
  expect(await submit(target.invitation(), "different")).toMatchObject({ status: "ready" });
  expect(readPeerConfig(file)?.deviceId).toBe(target.config.deviceId);
}, 20_000);
