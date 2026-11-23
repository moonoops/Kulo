import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as envModule from "@kulo/env";
import type { DeviceSystemInfo, EnvNodeDescriptor } from "@kulo/protocol";
import { DeviceInterconnectionManager, parseDeviceInfo } from "../packages/hub/src/devices.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function info(ips: string[]): DeviceSystemInfo {
  return { hostname: "test-mac", platform: "darwin", arch: "arm64", release: "test", cpu: "test", memoryBytes: 8 * 1024 ** 3, ips };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-network-view-"));
  directories.push(directory);
  const env = new envModule.EnvManager({ enableLocal: false });
  const manager = new DeviceInterconnectionManager(directory, env);
  return { env, manager };
}

describe("filtered device network view", () => {
  it("updates local addresses and join candidates after a network change", () => {
    const collect = vi.spyOn(envModule, "collectDeviceSystemInfo").mockReturnValue(info(["10.0.0.10", "fd00:db8:1::1", "2001:db8:10::1", "100.100.1.10", "fd7a:115c:a1e0::1"]));
    const { manager } = fixture();
    const before = manager.view(7788, "http://127.0.0.1:7788");
    expect(before.devices[0]?.info?.ips).toHaveLength(5);
    expect(before.hubUrls).toEqual(["http://10.0.0.10:7788", "http://100.100.1.10:7788", "http://[fd00:db8:1::1]:7788", "http://[2001:db8:10::1]:7788", "http://[fd7a:115c:a1e0::1]:7788"]);

    collect.mockReturnValue(info(["192.168.2.20", "fd22::20"]));
    const after = manager.view(7788, "http://127.0.0.1:7788");
    expect(after.devices[0]?.info?.ips).toEqual(["192.168.2.20", "fd22::20"]);
    expect(after.hubUrls).toEqual(["http://192.168.2.20:7788", "http://[fd22::20]:7788"]);
  });

  it("does not reintroduce an excluded IP through the request origin", () => {
    vi.spyOn(envModule, "collectDeviceSystemInfo").mockReturnValue(info(["10.0.0.196"]));
    const { manager } = fixture();
    expect(manager.view(7788, "http://198.18.0.1:7788").hubUrls).toEqual(["http://10.0.0.196:7788"]);
    expect(manager.view(7788, "not-a-url").hubUrls).toEqual(["http://10.0.0.196:7788"]);
    expect(manager.view(7788, "https://kulo.example.test").hubUrls).toEqual(["https://kulo.example.test", "http://10.0.0.196:7788"]);
  });

  it("sanitizes legacy peer reports in pairing, live and stored views without repeated saves", () => {
    vi.spyOn(envModule, "collectDeviceSystemInfo").mockReturnValue(info(["10.0.0.196"]));
    const { manager, env } = fixture();
    manager.setEnabled(true);
    const legacy = info(["10.23.0.8", "FE80::1", "198.18.0.1", "fd00::8", "fd00:0:0:0:0:0:0:8", "::1"]);
    expect(parseDeviceInfo(legacy).ips).toEqual(["10.23.0.8", "fd00::8"]);
    const invitation = manager.createInvitation({ hubUrl: "http://10.0.0.196:7788" });
    const config = manager.pair({ inviteToken: invitation.inviteToken, info: legacy });
    const descriptor: EnvNodeDescriptor = { id: config.deviceId, name: config.name, kind: "reverse-ws", online: true, platform: "darwin", arch: "arm64", rootDir: config.rootDir, capabilities: ["fs"], connectedAt: Date.now(), lastSeenAt: Date.now(), info: legacy };
    const list = vi.spyOn(env, "listEnvs").mockReturnValue([descriptor]);
    expect(manager.view(7788, "http://127.0.0.1:7788").devices[1]?.info?.ips).toEqual(["10.23.0.8", "fd00::8"]);
    const save = vi.spyOn(fs, "renameSync");
    manager.view(7788, "http://127.0.0.1:7788");
    expect(save).not.toHaveBeenCalled();
    list.mockReturnValue([]);
    expect(manager.view(7788, "http://127.0.0.1:7788").devices[1]?.info?.ips).toEqual(["10.23.0.8", "fd00::8"]);
  });

  it("filters unpaired legacy execution nodes too", () => {
    vi.spyOn(envModule, "collectDeviceSystemInfo").mockReturnValue(info([]));
    const { manager, env } = fixture();
    vi.spyOn(env, "listEnvs").mockReturnValue([{ id: "legacy-env", name: "legacy", kind: "reverse-ws", online: true, platform: "linux", arch: "x64", rootDir: "/tmp", capabilities: ["fs"], connectedAt: 1, lastSeenAt: 1, info: info(["192.168.1.5", "febf::1", "198.19.0.1"]) }]);
    expect(manager.view(7788, "http://127.0.0.1:7788").devices[1]?.info?.ips).toEqual(["192.168.1.5"]);
  });
});
