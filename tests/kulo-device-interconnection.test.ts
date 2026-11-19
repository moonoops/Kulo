import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import WebSocket from "ws";
import { collectDeviceSystemInfo, DeviceRoleTransitions, KuloEnvAgent, readPeerConfig, savePeerConfig, startDevicePeer } from "@kulo/env";
import { KuloHub, KuloStateDoc, startKuloHubServer } from "@kulo/hub";
import { parseDeviceJoinInput, parseStandaloneDeviceInvitation, type ClientToHubMessage, type DeviceInterconnectionView, type DeviceInvitation, type DevicePeerConfig, type HubToClientMessage } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-device-integration-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function lanOrigin(port: number): string {
  const address = Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
  if (!address) throw new Error("Device integration tests require a local non-loopback IPv4 interface.");
  return `http://${address}:${port}`;
}

async function fixture(options: { stateDir?: string; port?: number; bindHost?: string | false; envTokens?: Record<string, string> } = {}) {
  const stateDir = options.stateDir ?? temporaryDirectory();
  const provider = fauxProvider({ provider: "openai", models: [{ id: "device-test-model" }] });
  provider.setResponses(Array.from({ length: 32 }, () => () => fauxAssistantMessage([fauxText("共享主脑已收到。")])));
  const models = createModels();
  models.setProvider(provider.provider);
  const hub = await openTestHub({
    models,
    providerId: "openai",
    config: {
      stateDir,
      host: "127.0.0.1",
      authToken: HUB_TEST_ADMIN_TOKEN,
      envTokens: options.envTokens ?? {},
      workerEnvIds: [],
      enableLocalEnv: false,
      memory: { enabled: false },
      model: { defaultProvider: "openai", defaultModel: "device-test-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
    },
  });
  let hubClosed = false;
  cleanups.push(async () => { if (!hubClosed) { hubClosed = true; await hub.close(); } });
  const server = await startKuloHubServer(hub, { ...(options.bindHost === false ? {} : { host: options.bindHost ?? "0.0.0.0" }), port: options.port ?? 0 });
  let serverClosed = false;
  cleanups.push(async () => { if (!serverClosed) { serverClosed = true; await server.close(); } });
  const origin = lanOrigin(server.port);
  const request = (pathname: string, method = "GET", body?: unknown, token = HUB_TEST_ADMIN_TOKEN) => fetch(`${server.url}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const enable = async (enabled = true, force = false) => {
    const response = await request("/api/devices", "PATCH", { enabled, force });
    expect(response.status).toBe(200);
    return await response.json() as DeviceInterconnectionView;
  };
  const invite = async (name = "测试笔记本") => {
    const response = await request("/api/devices/invitations", "POST", { name, hubUrl: origin });
    expect(response.status).toBe(201);
    const invitation = await response.json() as DeviceInvitation;
    const token = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)?.[1];
    if (!token) throw new Error("Invitation command does not contain its one-time pairing argument.");
    return { invitation, token };
  };
  const pair = async (name = "测试笔记本") => {
    const invitation = await invite(name);
    const info = { ...collectDeviceSystemInfo(), hostname: "test-laptop", ips: ["10.23.0.8", "fd00::8"] };
    const rootDir = path.join(stateDir, `workspace-${invitation.invitation.deviceId}`);
    const response = await request("/api/devices/pair", "POST", { inviteToken: invitation.token, info, rootDir }, "");
    expect(response.status).toBe(200);
    const config = await response.json() as DevicePeerConfig;
    expect(config.rootDir).toBe(rootDir);
    config.localPort = 0;
    return { ...invitation, config, info };
  };
  return {
    stateDir, hub, server, origin, request, enable, invite, pair,
    async close() {
      if (!serverClosed) { serverClosed = true; await server.close(); }
      if (!hubClosed) { hubClosed = true; await hub.close(); }
    },
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Device state did not settle.");
}

async function client(url: string, token?: string) {
  const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const received: HubToClientMessage[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (raw) => {
    received.push(JSON.parse(raw.toString()) as HubToClientMessage);
    for (const listener of listeners) listener();
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  cleanups.push(() => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    ws.terminate();
  }));
  const waitFor = <T extends HubToClientMessage["type"]>(type: T, matches: (message: Extract<HubToClientMessage, { type: T }>) => boolean = () => true) => new Promise<Extract<HubToClientMessage, { type: T }>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const found = received.find((message): message is Extract<HubToClientMessage, { type: T }> => message.type === type && matches(message as Extract<HubToClientMessage, { type: T }>));
      if (!found) return;
      clearTimeout(timer);
      listeners.delete(check);
      resolve(found);
    };
    timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing client message ${type}.`)); }, 8_000);
    listeners.add(check);
    check();
  });
  return { ws, waitFor, send: (message: ClientToHubMessage) => ws.send(JSON.stringify(message)) };
}

function wsUrl(origin: string): string {
  const url = new URL("/ws/client", origin);
  url.protocol = "ws:";
  return url.toString();
}

async function rejectedLegacyRegistration(url: string, id: string, token: string, rootDir: string): Promise<number> {
  const ws = new WebSocket(url);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Revoked execution identity was not rejected.")); }, 3_000);
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
    ws.once("open", () => ws.send(JSON.stringify({ type: "env.register", envId: id, name: "旧执行设备", platform: process.platform, arch: process.arch, rootDir, capabilities: ["fs", "bash"], token, info: collectDeviceSystemInfo() })));
    ws.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function seedTask(hub: KuloHub, deviceId: string) {
  await hub.harness.commit(async (transaction) => {
    const state = await transaction.doc(KuloStateDoc);
    state.tickets["T-SHARED"] = {
      id: "T-SHARED", commandId: "seed-shared-task", title: "共享任务", goal: "验证两端查看与控制同一任务", scope: "测试",
      role: "coder", status: "blocked", envId: deviceId, workspaceDir: "/test/workspace", workerConversationId: Number(hub.rootConversation.id), runEpoch: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
  }, BACKGROUND_CONTEXT);
}

describe("device interconnection onboarding", () => {
  it("issues fresh chat invitations only on a local copy action for the owning Hub", async () => {
    const f = await fixture({ bindHost: false });
    const route = "/api/devices/chat-invitations";
    const view = await (await f.request("/api/devices")).json() as DeviceInterconnectionView;
    const copy = { hubId: view.hubId, enable: true };
    expect((await f.request(route, "POST", copy, "")).status).toBe(401);
    expect((await f.request(route, "POST", { ...copy, hubId: "another-hub" })).status).toBe(409);
    expect((await f.request(route, "POST", { ...copy, enable: false })).status).toBe(409);
    const proxied = await fetch(`${f.server.url}${route}`, { method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
      body: JSON.stringify(copy) });
    expect(proxied.status).toBe(403);
    const before = await (await f.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(before.enabled).toBe(false);
    expect(before.devices).toHaveLength(1);

    const first = await f.request(route, "POST", copy);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const { instruction, expiresAt } = await first.json() as { instruction: string; expiresAt: number };
    const parsed = parseStandaloneDeviceInvitation(instruction);
    expect(parsed?.hubId).toBe(view.hubId);
    expect(parsed?.hubName).toBe(view.hubName);
    expect(view.hubUrls.includes(parsed?.hubUrl ?? "")).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    await waitUntil(() => f.server.host === "0.0.0.0");
    const second = await f.request(route, "POST", { ...copy, enable: false });
    expect(second.status).toBe(201);
    const fresh = parseStandaloneDeviceInvitation((await second.json() as { instruction: string }).instruction);
    expect(Boolean(fresh && parsed && fresh.inviteToken !== parsed.inviteToken)).toBe(true);
    const payload = { inviteToken: parsed?.inviteToken, expectedHubId: parsed?.hubId, info: collectDeviceSystemInfo() };
    const wrongHost = await f.request("/api/devices/pair", "POST", { ...payload, expectedHubId: "another-hub" }, "");
    expect(wrongHost.status).toBe(401);
    expect(await wrongHost.json()).toMatchObject({ code: "device_invitation_invalid" });
    const paired = await f.request("/api/devices/pair", "POST", payload, "");
    expect(paired.status).toBe(200);
    const { clientToken } = await paired.json() as DevicePeerConfig;
    expect((await f.request(route, "POST", copy, clientToken)).status).toBe(403);
    const used = await f.request("/api/devices/pair", "POST", payload, "");
    expect(used.status).toBe(401);
    expect(await used.json()).toMatchObject({ code: "device_invitation_invalid" });
  });

  it("renames the main brain through the device API and restores that name for every client", async () => {
    const first = await fixture();
    const initial = await (await first.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(initial.hubName).toBe(initial.devices[0]?.info?.hostname);
    const renamed = await first.request("/api/devices/local", "PATCH", { name: "  工作主脑  " });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ enabled: false, hubName: "工作主脑", devices: [{ id: "local", name: "工作主脑" }] });
    expect((await first.request("/api/devices/local", "PATCH", { name: "" })).status).toBe(400);
    await first.enable();
    const paired = await first.pair();
    const joined = await (await first.request("/api/devices", "GET", undefined, paired.config.clientToken)).json() as DeviceInterconnectionView;
    expect(joined).toMatchObject({ role: "joined", hubName: "工作主脑" });
    expect(joined.devices.find((device) => device.id === "local")?.name).toBe("工作主脑");
    const fromPeer = await first.request("/api/devices/local", "PATCH", { name: "共享主脑" }, paired.config.clientToken);
    expect(fromPeer.status).toBe(200);
    expect(await fromPeer.json()).toMatchObject({ role: "joined", hubName: "共享主脑" });
    expect(await (await first.request("/api/devices")).json()).toMatchObject({ hubName: "共享主脑" });
    await first.close();
    const restored = await fixture({ stateDir: first.stateDir });
    const view = await (await restored.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(view.hubName).toBe("共享主脑");
    expect(view.hubId).toBe(initial.hubId);
    expect(view.devices.find((device) => device.id === paired.config.deviceId)?.name).toBe(paired.config.name);
  });

  it("starts in single-device mode and protects setup until the owner enables it", async () => {
    const f = await fixture();
    const initial = await (await f.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(initial.enabled).toBe(false);
    expect(initial.role).toBe("hub");
    expect(initial.devices.map((device) => device.id)).toEqual(["local"]);
    expect((await f.request("/api/devices", "GET", undefined, "")).status).toBe(401);
    expect((await f.request("/api/devices/invitations", "POST", { hubUrl: f.origin })).status).toBe(409);
    expect((await fetch(`${f.server.url}/connect/install.sh`)).status).toBe(403);
    expect((await f.request("/api/devices/pair", "POST", { inviteToken: "not-an-invitation" }, "")).status).toBe(403);
    const enabled = await f.enable();
    expect(enabled.enabled).toBe(true);
    expect(enabled.hubUrls).toContain(f.origin);
    for (const script of ["install.sh", "install.ps1", "peer.mjs"]) {
      const response = await fetch(`${f.server.url}/connect/${script}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.text()).length).toBeGreaterThan(100);
    }
  });

  it("accepts a one-time invitation, preserves multiple IPs, and exposes no saved credentials in the device list", async () => {
    const f = await fixture();
    await f.enable();
    const { config, token, info } = await f.pair();
    expect(config.clientToken === config.envToken).toBe(false);
    expect(config.clientToken === HUB_TEST_ADMIN_TOKEN).toBe(false);
    const response = await f.request("/api/devices");
    const text = await response.text();
    for (const credential of [config.clientToken, config.envToken, HUB_TEST_ADMIN_TOKEN, token]) expect(text.includes(credential)).toBe(false);
    const view = JSON.parse(text) as DeviceInterconnectionView;
    expect(view.devices.find((device) => device.id === config.deviceId)?.info?.ips).toEqual(info.ips);
    expect((await f.request("/api/devices/pair", "POST", { inviteToken: token, info }, "")).status).toBe(401);
    expect((await f.request("/api/topics", "GET", undefined, config.envToken)).status).toBe(401);
    expect((await f.request("/api/topics", "GET", undefined, config.clientToken)).status).toBe(200);
    const peerView = await (await f.request("/api/devices", "GET", undefined, config.clientToken)).json() as DeviceInterconnectionView;
    expect(peerView.role).toBe("joined");
    expect(peerView.currentDeviceId).toBe(config.deviceId);
    expect((await f.request("/api/devices", "PATCH", { enabled: false }, config.clientToken)).status).toBe(403);
    const queryCredential = `${f.server.url}/api/devices?token=${encodeURIComponent(config.clientToken)}`;
    const queryView = await (await fetch(queryCredential, { headers: { authorization: "Bearer invalid-test-header" } })).json() as DeviceInterconnectionView;
    expect(queryView.role).toBe("joined");
    expect(queryView.currentDeviceId).toBe(config.deviceId);
    expect((await fetch(queryCredential, { method: "PATCH", headers: { authorization: "Bearer invalid-test-header", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);
    if (process.platform !== "win32") expect(fs.statSync(path.join(f.stateDir, "devices.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed, cancelled, and expired pairing without consuming a valid invitation on invalid metadata", async () => {
    const f = await fixture();
    await f.enable();
    expect((await f.request("/api/devices", "PATCH", { enabled: "yes" })).status).toBe(400);
    for (const hubUrl of ["http://127.0.0.1:7788", "http://localhost:7788", "ftp://example.com", "https://user:password@example.com", `${f.origin}/other`]) {
      expect((await f.request("/api/devices/invitations", "POST", { hubUrl })).status).toBe(400);
    }
    expect((await f.request("/api/devices/pair", "POST", [], "")).status).toBe(400);
    const valid = await f.invite();
    expect((await f.request("/api/devices/pair", "POST", { inviteToken: valid.token, info: { ips: "not-an-array" } }, "")).status).toBe(400);
    const paired = await f.request("/api/devices/pair", "POST", { inviteToken: valid.token, info: collectDeviceSystemInfo() }, "");
    expect(paired.status).toBe(200);
    await paired.arrayBuffer();
    const cancelled = await f.invite();
    expect((await f.request(`/api/devices/invitations/${cancelled.invitation.id}`, "DELETE")).status).toBe(200);
    expect((await f.request("/api/devices/pair", "POST", { inviteToken: cancelled.token, info: collectDeviceSystemInfo() }, "")).status).toBe(401);
    const expired = await f.invite();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      expect((await f.request("/api/devices/pair", "POST", { inviteToken: expired.token, info: collectDeviceSystemInfo() }, "")).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
    const view = await (await f.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(view.devices.some((device) => device.id === cancelled.invitation.deviceId || device.id === expired.invitation.deviceId)).toBe(false);
  });
});

describe("shared Hub through a real joined-device runtime", () => {
  it("shows the same conversation, model answer and task updates in Hub and peer clients", async () => {
    const f = await fixture();
    await f.enable();
    const { config } = await f.pair();
    vi.stubEnv("KULO_PEER_CONFIG", path.join(f.stateDir, "peer-config", "connection.json"));
    const peer = await startDevicePeer(config, { port: 0 });
    cleanups.push(() => peer.close());
    await peer.ready;
    const execution = f.hub.envManager.createExecutionEnv(config.deviceId, config.rootDir);
    const filename = path.join(config.rootDir, "through-pi-env.txt");
    expect((await execution.writeFile(filename, "written through the official Pi Env daemon", BACKGROUND_CONTEXT)).ok).toBe(true);
    const result = await execution.readTextFile(filename, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("written through the official Pi Env daemon");
    expect(fs.readFileSync(filename, "utf8")).toBe("written through the official Pi Env daemon");
    await seedTask(f.hub, config.deviceId);
    const main = await client(f.server.clientWsUrl, HUB_TEST_ADMIN_TOKEN);
    const joined = await client(wsUrl(peer.url), peer.authToken);
    const [mainSnapshot, joinedSnapshot] = await Promise.all([main.waitFor("hub.snapshot"), joined.waitFor("hub.snapshot")]);
    expect(joinedSnapshot.topics).toEqual(mainSnapshot.topics);
    expect(joinedSnapshot.tickets).toEqual(mainSnapshot.tickets);
    expect(joinedSnapshot.envs.some((env) => env.id === config.deviceId && env.online)).toBe(true);
    const createdResponse = await fetch(`${peer.url}/api/topics`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${peer.authToken}` }, body: JSON.stringify({ title: "在接入设备新建" }) });
    expect(createdResponse.status).toBe(200);
    const topic = await createdResponse.json() as { id: string };
    await Promise.all([main.waitFor("hub.topics", (message) => message.topics.some((item) => item.id === topic.id)), joined.waitFor("hub.topics", (message) => message.topics.some((item) => item.id === topic.id))]);
    for (const connection of [main, joined]) connection.send({ type: "topic.select", topicId: topic.id, requestId: `select-${connection === main ? "main" : "joined"}` });
    await Promise.all([main.waitFor("hub.messages", (message) => message.topicId === topic.id), joined.waitFor("hub.messages", (message) => message.topicId === topic.id)]);
    joined.send({ type: "chat.send", topicId: topic.id, content: "从另一台设备发送", requestId: "shared-peer-input" });
    const hasAnswer = (message: Extract<HubToClientMessage, { type: "hub.messages" }>) => message.topicId === topic.id && message.messages.some((item) => item.role === "assistant" && item.text === "共享主脑已收到。");
    const [mainAnswer, peerAnswer] = await Promise.all([main.waitFor("hub.messages", hasAnswer), joined.waitFor("hub.messages", hasAnswer)]);
    expect(peerAnswer.messages).toEqual(mainAnswer.messages);
    expect(peerAnswer.messages.some((item) => item.role === "user" && item.text === "从另一台设备发送")).toBe(true);
    joined.send({ type: "ticket.stop", ticketId: "T-SHARED", reason: "从接入设备停止", commandId: "stop-from-peer" });
    const stopped = (message: Extract<HubToClientMessage, { type: "hub.tickets" }>) => message.tickets.some((ticket) => ticket.id === "T-SHARED" && ticket.status === "stopped");
    const [mainTasks, peerTasks] = await Promise.all([main.waitFor("hub.tickets", stopped), joined.waitFor("hub.tickets", stopped)]);
    expect(peerTasks.tickets).toEqual(mainTasks.tickets);
    const topicsThroughPeer = await (await fetch(`${peer.url}/api/topics`, { headers: { authorization: `Bearer ${peer.authToken}` } })).json() as { items: Array<{ id: string }> };
    expect(topicsThroughPeer.items.some((item) => item.id === topic.id)).toBe(true);
  });

  it("revokes both a device's live UI and execution credentials when removed", async () => {
    const f = await fixture();
    await f.enable();
    const { config, info } = await f.pair();
    vi.stubEnv("KULO_PEER_CONFIG", path.join(f.stateDir, "peer-config", "connection.json"));
    const peer = await startDevicePeer(config, { port: 0 });
    cleanups.push(() => peer.close());
    await peer.ready;
    const joined = await client(wsUrl(peer.url), peer.authToken);
    await joined.waitFor("hub.snapshot");
    const closed = new Promise<void>((resolve) => joined.ws.once("close", () => resolve()));
    expect((await f.request(`/api/devices/${config.deviceId}`, "DELETE")).status).toBe(200);
    await closed;
    await waitUntil(() => !f.hub.envManager.listEnvs().some((env) => env.id === config.deviceId));
    expect((await f.request("/api/topics", "GET", undefined, config.clientToken)).status).toBe(401);
    expect((await fetch(`${peer.url}/api/topics`, { headers: { authorization: `Bearer ${peer.authToken}` } })).status).toBe(401);
    const node = new WebSocket(f.server.envWsUrl);
    const rejected = new Promise<number>((resolve, reject) => {
      node.once("error", reject);
      node.once("open", () => node.send(JSON.stringify({ type: "env.register", envId: config.deviceId, name: config.name, platform: info.platform, arch: info.arch, rootDir: config.rootDir, capabilities: ["fs", "bash"], token: config.envToken, info })));
      node.once("close", (code) => resolve(code));
    });
    expect(await rejected).toBe(4001);
    expect((await f.request(`/api/devices/local`, "DELETE")).status).toBe(400);
  });

  it("restores the same saved pairing after Hub restart and preserves it across disabling and reenabling", async () => {
    const first = await fixture();
    await first.enable();
    const { config } = await first.pair();
    const configFile = path.join(first.stateDir, "peer-config", "connection.json");
    vi.stubEnv("KULO_PEER_CONFIG", configFile);
    savePeerConfig(config);
    expect(fs.existsSync(configFile)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    const original = await (await first.request("/api/devices")).json() as DeviceInterconnectionView;
    const topic = await first.hub.createTopic("主脑重启后保留");
    const port = first.server.port;
    await first.close();
    const restored = await fixture({ stateDir: first.stateDir, port });
    const saved = readPeerConfig();
    if (!saved) throw new Error("Missing saved device configuration.");
    const peer = await startDevicePeer(saved, { port: 0 });
    cleanups.push(() => peer.close());
    await peer.ready;
    const joined = await client(wsUrl(peer.url), peer.authToken);
    const snapshot = await joined.waitFor("hub.snapshot");
    expect(snapshot.topics.some((item) => item.id === topic.id)).toBe(true);
    const view = await (await restored.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(view.hubId).toBe(original.hubId);
    expect(view.devices.some((device) => device.id === config.deviceId && device.status === "online")).toBe(true);
    const disconnected = new Promise<void>((resolve) => joined.ws.once("close", () => resolve()));
    await restored.enable(false);
    await disconnected;
    expect((await restored.request("/api/topics", "GET", undefined, saved.clientToken)).status).toBe(401);
    const disabled = await (await restored.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(disabled.devices.some((device) => device.id === config.deviceId)).toBe(true);
    await restored.enable(true);
    expect((await restored.request("/api/topics", "GET", undefined, saved.clientToken)).status).toBe(200);
    await waitUntil(() => restored.hub.envManager.listEnvs().some((env) => env.id === config.deviceId && env.online));
  });
});

describe("interconnection lifecycle regressions", () => {
  it("keeps a removed legacy execution identity revoked after Hub restart even when its old environment configuration remains", async () => {
    const legacyId = "legacy-test-node";
    const legacyToken = "legacy-test-execution-credential";
    const envTokens = { [legacyId]: legacyToken };
    const first = await fixture({ envTokens });
    const rootDir = path.join(first.stateDir, "legacy-workspace");
    vi.stubEnv("KULO_PEER_CONFIG", path.join(first.stateDir, "peer-config", "connection.json"));
    const node = new KuloEnvAgent({ hubUrl: first.server.envWsUrl, envId: legacyId, name: "旧执行设备", rootDir, authToken: legacyToken, reconnect: false });
    cleanups.push(() => node.stop());
    await node.start();
    expect(first.hub.envManager.listEnvs().some((env) => env.id === legacyId && env.online)).toBe(true);
    expect((await first.request(`/api/devices/${legacyId}`, "DELETE")).status).toBe(200);
    await waitUntil(() => !first.hub.envManager.listEnvs().some((env) => env.id === legacyId));
    expect(await rejectedLegacyRegistration(first.server.envWsUrl, legacyId, legacyToken, rootDir)).toBe(4001);
    const registry = JSON.parse(fs.readFileSync(path.join(first.stateDir, "devices.json"), "utf8")) as { revokedIds?: string[] };
    expect(registry.revokedIds).toContain(legacyId);
    const port = first.server.port;
    await node.stop();
    await first.close();
    const restored = await fixture({ stateDir: first.stateDir, port, envTokens });
    const view = await (await restored.request("/api/devices")).json() as DeviceInterconnectionView;
    expect(view.enabled).toBe(true);
    expect(restored.hub.config.envTokens[legacyId] === legacyToken).toBe(true);
    expect(await rejectedLegacyRegistration(restored.server.envWsUrl, legacyId, legacyToken, rootDir)).toBe(4001);
    expect(restored.hub.envManager.listEnvs().some((env) => env.id === legacyId)).toBe(false);
  });

  it("rebinds the real listener between loopback and the network without changing its port or paired records", async () => {
    const f = await fixture({ bindHost: false });
    const port = f.server.port;
    expect(f.server.host).toBe("127.0.0.1");
    const openPreview = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/computer-preview?topicId=root`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      cleanups.push(() => new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.terminate();
      }));
      return ws;
    };
    let current = await client(f.server.clientWsUrl, HUB_TEST_ADMIN_TOKEN);
    let preview = await openPreview();
    await current.waitFor("hub.snapshot");
    let deviceId: string | undefined;
    for (let cycle = 0; cycle < 2; cycle++) {
      const oldClosed = new Promise<void>((resolve) => current.ws.once("close", () => resolve()));
      const previewClosed = new Promise<void>((resolve) => preview.once("close", () => resolve()));
      await f.enable(true);
      await waitUntil(() => f.server.host === "0.0.0.0");
      await Promise.all([oldClosed, previewClosed]);
      expect(f.server.port).toBe(port);
      expect((await f.request("/api/topics")).status).toBe(200);
      const onNetwork = await client(f.server.clientWsUrl, HUB_TEST_ADMIN_TOKEN);
      const networkPreview = await openPreview();
      await onNetwork.waitFor("hub.snapshot");
      if (!deviceId) deviceId = (await f.pair()).config.deviceId;
      const networkView = await (await f.request("/api/devices")).json() as DeviceInterconnectionView;
      expect(networkView.enabled).toBe(true);
      expect(networkView.devices.some((device) => device.id === deviceId)).toBe(true);
      const networkClosed = new Promise<void>((resolve) => onNetwork.ws.once("close", () => resolve()));
      const networkPreviewClosed = new Promise<void>((resolve) => networkPreview.once("close", () => resolve()));
      await f.enable(false);
      await waitUntil(() => f.server.host === "127.0.0.1");
      await Promise.all([networkClosed, networkPreviewClosed]);
      expect(f.server.port).toBe(port);
      const singleView = await (await f.request("/api/devices")).json() as DeviceInterconnectionView;
      expect(singleView.enabled).toBe(false);
      expect(singleView.devices.some((device) => device.id === deviceId)).toBe(true);
      current = await client(f.server.clientWsUrl, HUB_TEST_ADMIN_TOKEN);
      preview = await openPreview();
      await current.waitFor("hub.snapshot");
    }
    const finalClosed = new Promise<void>((resolve) => current.ws.once("close", () => resolve()));
    const finalPreviewClosed = new Promise<void>((resolve) => preview.once("close", () => resolve()));
    current.ws.terminate();
    preview.terminate();
    await Promise.all([finalClosed, finalPreviewClosed]);
    await f.close();
  });

  it("parses Posix, PowerShell, and combined agentInstructions join commands and pairs directly via POST /api/devices/join", async () => {
    const host = await fixture();
    await host.enable();
    const { invitation, token } = await host.invite("桌面客户端");

    expect(parseDeviceJoinInput(invitation.command)).toEqual({ hubUrl: host.origin, inviteToken: token });
    expect(parseDeviceJoinInput(invitation.windowsCommand)).toEqual({ hubUrl: host.origin, inviteToken: token });
    expect(parseDeviceJoinInput(invitation.agentInstructions)).toEqual({ hubUrl: host.origin, inviteToken: token });
    expect(parseDeviceJoinInput(`${host.origin} ${token}`)).toEqual({ hubUrl: host.origin, inviteToken: token });

    // Self-join must be rejected.
    const selfJoin = await startKuloHubServer(host.hub, { host: "127.0.0.1", port: 0, onJoinPeer: () => {} });
    cleanups.push(() => selfJoin.close());
    const selfResp = await fetch(`${selfJoin.url}/api/devices/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input: `${selfJoin.url} ${token}` }),
    });
    expect(selfResp.status).toBe(400);

    // Client Hub guards running local tasks unless force=true, then pairs and triggers onJoinPeer.
    const clientStateDir = temporaryDirectory();
    const peerConfigPath = path.join(clientStateDir, "peer", "connection.json");
    const peerRootDir = path.join(clientStateDir, "peer-workspace");
    let joinedConfig: DevicePeerConfig | undefined;
    const provider = fauxProvider({ provider: "openai", models: [{ id: "device-test-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const clientHub = await openTestHub({
      models,
      providerId: "openai",
      config: {
        stateDir: clientStateDir,
        host: "127.0.0.1",
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "device-test-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
      },
    });
    cleanups.push(() => clientHub.close());
    await seedTask(clientHub, "local");
    const clientServer = await startKuloHubServer(clientHub, {
      host: "127.0.0.1",
      port: 0,
      peerConfigPath,
      peerRootDir,
      onJoinPeer: (config) => { joinedConfig = config; },
    });
    cleanups.push(() => clientServer.close());

    const blockedJoin = await fetch(`${clientServer.url}/api/devices/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input: invitation.agentInstructions }),
    });
    expect(blockedJoin.status).toBe(409);
    expect(await blockedJoin.json()).toMatchObject({ code: "local_tasks_running", error: expect.stringContaining("共享任务") });

    const invalidJoin = await fetch(`${clientServer.url}/api/devices/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input: `${host.origin} ${"unused-test-invite".repeat(2)}`, force: true }),
    });
    expect(invalidJoin.status).toBe(202);
    const rejected = await invalidJoin.json() as { id: string };
    await waitUntil(async () => {
      const result = await fetch(`${clientServer.url}/api/devices/role-transition?id=${rejected.id}`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      return (await result.json() as { status: string }).status === "failed";
    });
    expect((await clientHub.getBoardSnapshot()).tickets.find((ticket) => ticket.id === "T-SHARED")?.status).toBe("blocked");

    const forcedJoin = await fetch(`${clientServer.url}/api/devices/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input: invitation.agentInstructions, force: true }),
    });
    expect(forcedJoin.status).toBe(202);
    const receipt = await forcedJoin.json() as { id: string; status: string };
    expect(receipt).toMatchObject({ targetRole: "joined", status: "switching" });
    await waitUntil(() => Boolean(joinedConfig));
    const status = await fetch(`${clientServer.url}/api/devices/role-transition?id=${receipt.id}`, {
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
    });
    expect(await status.json()).toMatchObject({ id: receipt.id, status: "ready" });
    expect((await clientHub.getBoardSnapshot()).tickets.find((ticket) => ticket.id === "T-SHARED")?.status).toBe("stopped");
    expect(readPeerConfig(peerConfigPath)).toMatchObject({
      hubUrl: host.origin,
      deviceId: invitation.deviceId,
      rootDir: peerRootDir,
    });
  });

  it("serves local Web UI and offline joined status with leave recovery when the remote Host is unreachable", async () => {
    const peerDir = temporaryDirectory();
    const webDir = temporaryDirectory();
    const configPath = path.join(peerDir, "connection.json");
    const localToken = "local-peer-desktop-token";
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>Offline Peer Shell</title>");

    const offlineConfig: DevicePeerConfig = {
      version: 1,
      hubUrl: "http://127.0.0.1:9",
      deviceId: "dev-offline-peer",
      name: "离线测试机",
      envToken: "offline-env-token",
      clientToken: "offline-client-token",
      rootDir: path.join(peerDir, "workspace"),
    };
    savePeerConfig(offlineConfig, configPath);

    let left = false;
    const peer = await startDevicePeer(offlineConfig, {
      port: 0,
      configPath,
      authToken: localToken,
      webDistDir: webDir,
      allowLeave: true,
      onLeave: () => { left = true; },
    });
    cleanups.push(() => peer.close());

    const htmlRes = await fetch(peer.url);
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain("Offline Peer Shell");

    const unauthDevices = await fetch(`${peer.url}/api/devices`);
    expect(unauthDevices.status).toBe(401);

    const devicesRes = await fetch(`${peer.url}/api/devices`, {
      headers: { authorization: `Bearer ${localToken}` },
    });
    expect(devicesRes.status).toBe(200);
    const view = await devicesRes.json() as DeviceInterconnectionView;
    expect(view).toMatchObject({
      role: "joined",
      canSwitchRole: true,
      currentDeviceId: "dev-offline-peer",
    });
    expect(view.hubError).toBeTruthy();

    const leaveRes = await fetch(`${peer.url}/api/devices/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}` },
    });
    expect(leaveRes.status).toBe(202);
    await waitUntil(() => left);
    expect(readPeerConfig(configPath)).toBeNull();
  });

  it("keeps the old role usable and reuses a consumed invitation when a switch fails before readiness", async () => {
    const host = await fixture();
    await host.enable();
    const { invitation } = await host.invite();
    const input = parseDeviceJoinInput(invitation.agentInstructions);
    const directory = temporaryDirectory();
    const configPath = path.join(directory, "peer", "connection.json");
    let failHub = false;
    const startHub = vi.fn(async () => { if (failHub) throw new Error("cannot start"); });
    let peerConnected!: () => void;
    let peerFailed!: () => void;
    const startPeer = vi.fn(async () => ({ ready: new Promise<void>((resolve, reject) => {
      peerConnected = resolve;
      peerFailed = () => reject(new Error("offline"));
    }) }));
    const roles = new DeviceRoleTransitions({ configPath, rootDir: directory, startPeer, startHub });
    const join = roles.join(input, async () => {}, "confirmed-action");
    const joining = join.start();
    await vi.waitFor(() => expect(startPeer).toHaveBeenCalledOnce());
    expect(roles.lookup(join.receipt.id)?.status).toBe("switching");
    expect(readPeerConfig(configPath)).toBeNull();
    expect(fs.statSync(`${configPath}.pending`).mode & 0o777).toBe(0o700);
    const [staged] = fs.readdirSync(`${configPath}.pending`);
    expect(fs.statSync(path.join(`${configPath}.pending`, staged!)).mode & 0o777).toBe(0o600);
    expect(() => roles.leave({} as DevicePeerConfig)).toThrow("正在切换");
    peerFailed();
    await joining;
    expect(join.receipt).toMatchObject({ status: "failed", error: expect.stringContaining("已恢复本机独立运行") });
    expect(startHub).toHaveBeenCalledOnce();
    expect(readPeerConfig(configPath)).toBeNull();
    // The restored Hub no longer holds the original assistant invitation in memory.
    const reopened = new DeviceRoleTransitions({ configPath, rootDir: directory, startPeer, startHub });
    const retry = reopened.resumeJoin("confirmed-action", input.hubUrl, async () => {})!;
    const retrying = retry.start();
    await vi.waitFor(() => expect(startPeer).toHaveBeenCalledTimes(2));
    peerConnected();
    await retrying;
    expect(retry.receipt.status).toBe("ready");
    const config = readPeerConfig(configPath)!;
    expect(config.deviceId).toBe(invitation.deviceId);
    expect(fs.readdirSync(`${configPath}.pending`)).toEqual([]);

    failHub = true;
    const leave = reopened.leave(config);
    const leaving = leave.start();
    await vi.waitFor(() => expect(startPeer).toHaveBeenCalledTimes(3));
    expect(leave.receipt.status).toBe("switching");
    expect(readPeerConfig(configPath)?.deviceId).toBe(invitation.deviceId);
    peerConnected();
    await leaving;
    expect(leave.receipt).toMatchObject({ status: "failed", error: expect.stringContaining("已恢复原设备连接") });
    expect(reopened.lookup(retry.receipt.id)?.status).toBe("ready");
    failHub = false;
    const leaveRetry = reopened.leave(config);
    await leaveRetry.start();
    expect(leaveRetry.receipt.status).toBe("ready");
    expect(readPeerConfig(configPath)).toBeNull();
  });

  it("keeps simultaneous invitations separate and rejects an obsolete profile write", async () => {
    const host = await fixture();
    await host.enable();
    const first = (await host.invite("Device A")).invitation;
    const second = (await host.invite("Device B")).invitation;
    const configPath = path.join(temporaryDirectory(), "peer", "connection.json");
    const switches = [first, second].map((invitation) => {
      let finish!: () => void;
      const startPeer = vi.fn(async () => ({ ready: new Promise<void>((resolve) => { finish = resolve; }) }));
      const restore = vi.fn(async () => {});
      const roles = new DeviceRoleTransitions({ configPath, startPeer, startHub: restore });
      const change = roles.join(parseDeviceJoinInput(invitation.agentInstructions), async () => {});
      return { change, done: change.start(), startPeer, restore, finish: () => finish() };
    });
    await vi.waitFor(() => switches.forEach((op) => expect(op.startPeer).toHaveBeenCalledOnce()));
    switches[0]!.finish();
    await switches[0]!.done;
    expect(switches[0]!.change.receipt.status).toBe("ready");
    switches[1]!.finish();
    await switches[1]!.done;
    expect(switches[1]!.change.receipt.status).toBe("failed");
    expect(switches[1]!.restore).toHaveBeenCalledOnce();
    expect(readPeerConfig(configPath)?.deviceId).toBe(first.deviceId);
  });
});
