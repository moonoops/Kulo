import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as envModule from "@kulo/env";
import type { DeviceSystemInfo, EnvNodeDescriptor } from "@kulo/protocol";
import { DeviceInterconnectionManager } from "../packages/hub/src/devices.js";

const directories: string[] = [];
const resources: Array<() => Promise<void>> = [];
const systemInfo: DeviceSystemInfo = { hostname: "System-Mac.local", platform: "darwin", arch: "arm64", release: "test", cpu: "test", memoryBytes: 8 * 1024 ** 3, ips: ["10.0.0.5"] };

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(options: envModule.EnvManagerOptions = {}) {
  vi.spyOn(envModule, "collectDeviceSystemInfo").mockReturnValue(systemInfo);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-device-names-"));
  directories.push(directory);
  const env = new envModule.EnvManager({ enableLocal: false, localRootDir: directory, projectGrantFile: path.join(directory, "env-private", "project-grants.json"), ...options });
  const manager = new DeviceInterconnectionManager(directory, env);
  const view = (currentDeviceId = "local") => manager.view(7788, "http://127.0.0.1:7788", currentDeviceId);
  const saved = () => JSON.parse(fs.readFileSync(path.join(directory, "devices.json"), "utf8"));
  return { directory, env, manager, view, saved };
}

async function startNodeConnections(env: envModule.EnvManager) {
  resources.push(() => env.close());
  await env.start();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => env.handleEnvWebSocket(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });
  const address = server.address() as { port: number };
  return async (id: string, token: string, name: string) => {
    const node = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(node, "open");
    const registered = once(node, "message");
    node.send(JSON.stringify({ type: "env.register", envId: id, token, name, platform: "darwin", arch: "arm64", rootDir: "/tmp", capabilities: ["fs", "bash"] }));
    await registered;
    return node;
  };
}

function envDescriptor(id: string, name: string, kind: EnvNodeDescriptor["kind"] = "reverse-ws"): EnvNodeDescriptor {
  return { id, name, kind, platform: "darwin", arch: "arm64", online: true, rootDir: "/tmp", capabilities: ["fs"], connectedAt: 1, lastSeenAt: 1 };
}

describe("device display names", () => {
  it("updates local Env descriptors and change notifications without changing physical identity", async () => {
    const onChange = vi.fn();
    const f = fixture({ enableLocal: true, localName: "Physical system name", onChange });
    resources.push(() => f.env.close());
    await f.env.start();
    const physical = f.env.getEnvDescriptor("local")!;
    f.manager.rename("local", "项目中的主脑");
    expect(f.env.getEnvDescriptor("local")).toEqual({ ...physical, name: "项目中的主脑" });
    expect(f.env.listEnvs()[0]?.name).toBe("项目中的主脑");
    expect(onChange.mock.lastCall?.[0][0]?.name).toBe("项目中的主脑");
    onChange.mockClear();
    f.env.setDeviceDisplayName("local", "项目中的主脑");
    expect(onChange).not.toHaveBeenCalled();
    f.env.setDeviceDisplayName("local", undefined);
    expect(f.env.getEnvDescriptor("local")?.name).toBe(physical.name);
    expect(onChange.mock.lastCall?.[0][0]?.name).toBe(physical.name);
    new DeviceInterconnectionManager(f.directory, f.env);
    expect(f.env.getEnvDescriptor("local")?.name).toBe("项目中的主脑");
  });

  it("keeps paired and legacy Env display aliases through reconnect and Hub reload", async () => {
    const legacyId = "legacy.mac.local";
    const legacyToken = "test-device-name-legacy-credential";
    const onChange = vi.fn();
    const f = fixture({ envTokens: { [legacyId]: legacyToken }, onChange });
    f.manager.setEnabled(true);
    const invitation = f.manager.createInvitation({ name: "配对默认名称", hubUrl: "http://10.0.0.5:7788" });
    const config = f.manager.pair({ inviteToken: invitation.inviteToken, info: systemInfo });
    const connect = await startNodeConnections(f.env);
    const node = await connect(config.deviceId, config.envToken, "Raw paired system name");
    await connect(legacyId, legacyToken, "Raw legacy system name");
    expect(f.env.getEnvDescriptor(config.deviceId)?.name).toBe("配对默认名称");
    f.manager.rename(config.deviceId, "配对开发机");
    f.manager.rename(legacyId, "旧开发机");
    expect(f.env.listEnvs().map((env) => env.name)).toEqual(["配对开发机", "旧开发机"]);
    expect(onChange.mock.lastCall?.[0].find((env: EnvNodeDescriptor) => env.id === legacyId)?.name).toBe("旧开发机");
    const closed = once(node, "close");
    node.close();
    await closed;
    await vi.waitFor(() => expect(f.env.getEnvDescriptor(config.deviceId)?.online).toBe(false));
    await connect(config.deviceId, config.envToken, "Changed raw system name");
    expect(f.env.getEnvDescriptor(config.deviceId)?.name).toBe("配对开发机");
    expect(f.env.pickDefaultEnvId()).toBe(config.deviceId);
    const restoredEnv = new envModule.EnvManager({ enableLocal: false, envTokens: { [legacyId]: legacyToken } });
    new DeviceInterconnectionManager(f.directory, restoredEnv);
    const reconnect = await startNodeConnections(restoredEnv);
    await reconnect(config.deviceId, config.envToken, "Raw paired system name");
    await reconnect(legacyId, legacyToken, "Raw legacy system name");
    expect(restoredEnv.getEnvDescriptor(config.deviceId)?.name).toBe("配对开发机");
    expect(restoredEnv.getEnvDescriptor(legacyId)?.name).toBe("旧开发机");
    f.manager.remove(config.deviceId);
    expect(f.env.getEnvDescriptor(config.deviceId)).toBeUndefined();
    onChange.mockClear();
    f.env.setDeviceDisplayName(config.deviceId, undefined);
    expect(onChange).not.toHaveBeenCalled();
    f.env.setDeviceDisplayName(legacyId, undefined);
    expect(f.env.getEnvDescriptor(legacyId)?.name).toBe("Raw legacy system name");
  });

  it("keeps the system default for existing version-one state without a stored override", () => {
    const f = fixture();
    expect(f.view().hubName).toBe(systemInfo.hostname);
    expect(f.view().devices[0]?.name).toBe(systemInfo.hostname);
    expect(f.saved().localName).toBeUndefined();
    const restored = new DeviceInterconnectionManager(f.directory, f.env);
    expect(restored.view(7788, "http://127.0.0.1:7788").hubName).toBe(systemInfo.hostname);
    expect(f.saved().version).toBe(1);
  });

  it("preserves a configured local display name as the default", () => {
    const f = fixture();
    const list = vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor("local", "Local (System-Mac.local)", "local")]);
    expect(f.view().hubName).toBe(systemInfo.hostname);
    list.mockReturnValue([envDescriptor("local", "Studio Mac", "local")]);
    expect(f.view().hubName).toBe("Studio Mac");
  });

  it("persists a trimmed local name for single, connected, joined-client and restarted views", () => {
    const f = fixture();
    const hubId = f.view().hubId;
    f.manager.rename("local", "  工作主脑  ");
    expect(f.view()).toMatchObject({ enabled: false, hubName: "工作主脑", devices: [{ id: "local", name: "工作主脑" }] });
    f.manager.setEnabled(true);
    expect(f.view("device-peer")).toMatchObject({ role: "joined", currentDeviceId: "device-peer", hubName: "工作主脑", devices: [{ id: "local", name: "工作主脑" }] });
    f.manager.setEnabled(false);
    const restored = new DeviceInterconnectionManager(f.directory, f.env);
    expect(restored.view(7788, "http://127.0.0.1:7788")).toMatchObject({ hubId, enabled: false, hubName: "工作主脑", devices: [{ id: "local", name: "工作主脑" }] });
    expect(f.saved().localName).toBe("工作主脑");
    expect(systemInfo.hostname).toBe("System-Mac.local");
  });

  it.each([undefined, null, 42, true, "", "   ", "name\n", "name\u0000", "name\u007f", "a".repeat(101)])("rejects an invalid local rename without changing the saved name (%s)", (name) => {
    const f = fixture();
    f.manager.rename("local", "主脑");
    expect(() => f.manager.rename("local", name)).toThrow("设备名称须为 1–100 个字符。");
    expect(f.view().hubName).toBe("主脑");
    expect(f.saved().localName).toBe("主脑");
  });

  it("retains automatic paired-device names and credentials when renamed", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const invitation = f.manager.createInvitation({ hubUrl: "http://10.0.0.5:7788" });
    const config = f.manager.pair({ inviteToken: invitation.inviteToken, info: { ...systemInfo, hostname: "Remote-Mac.local" } });
    expect(f.view().devices.find((device) => device.id === config.deviceId)?.name).toBe("Remote-Mac.local");
    f.manager.rename(config.deviceId, "  远程开发机  ");
    expect(f.manager.authenticateClient(config.clientToken)).toBe(config.deviceId);
    expect(() => f.manager.rename(config.deviceId, "")).toThrow("设备名称须为 1–100 个字符。");
    const restored = new DeviceInterconnectionManager(f.directory, f.env);
    expect(restored.view(7788, "http://127.0.0.1:7788").devices.find((device) => device.id === config.deviceId)?.name).toBe("远程开发机");
    expect(restored.authenticateClient(config.clientToken)).toBe(config.deviceId);
  });

  it("persists names for known legacy nodes without creating pairing or credential records", () => {
    const f = fixture();
    const credential = vi.spyOn(f.env, "setDeviceCredential");
    vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor("legacy-env", "Default Env")]);
    f.manager.rename("legacy-env", "  旧开发机  ");
    expect(f.view().devices.find((device) => device.id === "legacy-env")?.name).toBe("旧开发机");
    expect(f.saved().devices).toEqual([]);
    expect(credential).not.toHaveBeenCalled();
    const restored = new DeviceInterconnectionManager(f.directory, f.env);
    expect(restored.view(7788, "http://127.0.0.1:7788").devices.find((device) => device.id === "legacy-env")?.name).toBe("旧开发机");
    expect(credential).not.toHaveBeenCalled();
    restored.remove("legacy-env");
    expect(Object.hasOwn(f.saved().legacyNames, "legacy-env")).toBe(false);
  });

  it("rejects unknown IDs and stores valid legacy IDs without inheriting object properties", () => {
    const f = fixture();
    expect(() => f.manager.rename("unknown-env", "Unknown")).toThrow("找不到设备。");
    expect(f.saved().legacyNames).toBeUndefined();
    vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor("__proto__", "Default Env")]);
    f.manager.rename("__proto__", "Prototype Env");
    expect(f.view().devices.find((device) => device.id === "__proto__")?.name).toBe("Prototype Env");
    expect(Object.hasOwn(f.saved().legacyNames, "__proto__")).toBe(true);
    expect(f.saved().devices).toEqual([]);
  });

  it.each(["macbook.local", "ssh:macbook@home", "macbook:22@home.local"])("restores a renamed legacy node whose registered ID contains punctuation (%s)", (id) => {
    const f = fixture();
    vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor(id, "Default Env")]);
    f.manager.rename(id, "我的设备");
    const restored = new DeviceInterconnectionManager(f.directory, f.env);
    expect(restored.view(7788, "http://127.0.0.1:7788").devices.find((device) => device.id === id)?.name).toBe("我的设备");
    expect(f.saved().devices).toEqual([]);
    expect(f.saved().legacyNames[id]).toBe("我的设备");
    restored.remove(id);
    expect(Object.hasOwn(f.saved().legacyNames, id)).toBe(false);
    expect(f.saved().revokedIds).toContain(id);
  });

  it("removes a known dotted legacy node without a name override but rejects unknown punctuation IDs", () => {
    const f = fixture();
    vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor("known.mac.local", "Default Env")]);
    f.manager.remove("known.mac.local");
    expect(f.saved().revokedIds).toContain("known.mac.local");
    expect(() => f.manager.remove("unknown.mac.local")).toThrow("设备标识无效。");
    expect(f.saved().revokedIds).not.toContain("unknown.mac.local");
  });

  it("removes a saved legacy name override after its execution node has disconnected", () => {
    const f = fixture();
    const list = vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor("offline.mac.local", "Default Env")]);
    f.manager.rename("offline.mac.local", "我的设备");
    list.mockReturnValue([]);
    const restored = new DeviceInterconnectionManager(f.directory, f.env);
    restored.remove("offline.mac.local");
    expect(Object.hasOwn(f.saved().legacyNames, "offline.mac.local")).toBe(false);
    expect(f.saved().revokedIds).toContain("offline.mac.local");
  });

  it.each(["", " ", " trailing ", "line\nfeed", "control\u0000", "delete\u007f", "a".repeat(257)])("rejects unsafe legacy override keys before writing state (%s)", (id) => {
    const f = fixture();
    vi.spyOn(f.env, "listEnvs").mockReturnValue([envDescriptor(id, "Default Env")]);
    expect(() => f.manager.rename(id, "我的设备")).toThrow("设备标识无效。");
    expect(f.saved().legacyNames).toBeUndefined();
    expect(() => new DeviceInterconnectionManager(f.directory, f.env)).not.toThrow();
    const file = path.join(f.directory, "devices.json");
    fs.writeFileSync(file, JSON.stringify({ ...f.saved(), legacyNames: { [id]: "我的设备" } }));
    expect(() => new DeviceInterconnectionManager(f.directory, f.env)).toThrow("设备互联配置已损坏");
  });

  it("accepts a 100-character name and rejects corrupted persisted name fields", () => {
    const f = fixture();
    f.manager.rename("local", "a".repeat(100));
    expect(f.view().hubName).toHaveLength(100);
    const file = path.join(f.directory, "devices.json");
    const saved = f.saved();
    fs.writeFileSync(file, JSON.stringify({ ...saved, localName: "\n" }));
    expect(() => new DeviceInterconnectionManager(f.directory, f.env)).toThrow("设备互联配置已损坏");
    fs.writeFileSync(file, JSON.stringify({ ...saved, legacyNames: { invalid: "" } }));
    expect(() => new DeviceInterconnectionManager(f.directory, f.env)).toThrow("设备互联配置已损坏");
  });
});
