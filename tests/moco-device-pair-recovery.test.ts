import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDeviceSystemInfo, EnvManager, installDevicePeer, readPeerConfig } from "@moco/env";
import { DeviceConnectionError, DeviceInterconnectionManager } from "../packages/hub/src/devices.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-pair-recovery-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = new EnvManager({ enableLocal: false });
  cleanups.push(() => env.close());
  const reopen = () => new DeviceInterconnectionManager(dir, env);
  const manager = reopen();
  manager.setEnabled(true);
  return { dir, manager, reopen };
}

function fingerprint(value: string) { return createHash("sha256").update(value).digest("hex"); }

describe("one-time device pairing", () => {
  it("recovers one device after dropped HTTP replies and a Hub restart using the same private attempt", async () => {
    const f = fixture();
    let manager = f.manager;
    let drop = 2;
    const attempts: string[] = [];
    const issuedDevices = new Set<string>();
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString());
      attempts.push(fingerprint(request.attemptKey));
      try {
        const config = manager.pair(request);
        issuedDevices.add(fingerprint(config.clientToken));
        if (drop-- > 0) {
          res.writeHead(200, { "content-type": "application/json", "content-length": "512" });
          res.write('{"version":');
          setImmediate(() => res.destroy());
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(config));
      } catch (error) {
        res.writeHead(error instanceof DeviceConnectionError ? error.status : 500).end(JSON.stringify({ error: "无法配对" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const hubUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { inviteToken } = manager.createInvitation({ hubUrl, allowLoopback: true });
    const configPath = path.join(f.dir, "local", "connection.json");
    const join = () => installDevicePeer({ hubUrl, inviteToken, configPath });
    await expect(join()).rejects.toThrow();
    expect(attempts).toHaveLength(2);
    expect(readPeerConfig(configPath)).toBeNull();
    const pending = `${configPath}.pending`;
    const [name] = fs.readdirSync(pending);
    const attemptFile = path.join(pending, name!);
    const attemptKey = JSON.parse(fs.readFileSync(attemptFile, "utf8")) as string;
    expect(fingerprint(attemptKey) === attempts[0]).toBe(true);
    expect((fs.statSync(attemptFile).mode & 0o077) === 0 || process.platform === "win32").toBe(true);
    const savedHub = fs.readFileSync(path.join(f.dir, "devices.json"), "utf8");
    expect(savedHub.includes(attemptKey) || savedHub.includes(inviteToken)).toBe(false);

    manager = f.reopen();
    await expect(installDevicePeer({ hubUrl, inviteToken, configPath: path.join(f.dir, "other", "connection.json") })).rejects.toThrow();
    expect(attempts[2] !== attempts[0]).toBe(true);
    drop = 1;
    const result = await join();
    expect(attempts.slice(3)).toEqual([attempts[0], attempts[0]]);
    expect(issuedDevices.size).toBe(1);
    expect(readPeerConfig(configPath)?.deviceId).toBe(result.deviceId);
    expect(manager.authenticateClient(result.clientToken)).toBe(result.deviceId);
    expect(fs.existsSync(attemptFile)).toBe(false);
  });

  it("expires recovery and invalidates it on disabling or removing the device, while legacy clients still consume an invitation once", () => {
    const f = fixture();
    const issue = () => ({
      inviteToken: f.manager.createInvitation({ hubUrl: "http://127.0.0.1:7788", allowLoopback: true }).inviteToken,
      attemptKey: randomBytes(32).toString("hex"), info: collectDeviceSystemInfo(),
    });
    const first = issue();
    const legacy = issue();
    expect(() => f.manager.pair({ ...legacy, attemptKey: "invalid" })).toThrow(DeviceConnectionError);
    f.manager.pair({ ...legacy, attemptKey: undefined });
    expect(() => f.manager.pair(legacy)).toThrow(DeviceConnectionError);
    expect(() => f.manager.pair({ ...legacy, attemptKey: undefined })).toThrow(DeviceConnectionError);
    f.manager.pair(first);
    const now = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60_000);
    expect(() => f.manager.pair(first)).toThrow(DeviceConnectionError);
    time.mockRestore();
    const removed = issue();
    const device = f.manager.pair(removed);
    f.manager.remove(device.deviceId);
    expect(() => f.reopen().pair(removed)).toThrow(DeviceConnectionError);
    const disabled = issue();
    f.manager.pair(disabled);
    f.manager.setEnabled(false);
    expect(() => f.manager.pair(disabled)).toThrow(DeviceConnectionError);
    f.manager.setEnabled(true);
    expect(() => f.reopen().pair(disabled)).toThrow(DeviceConnectionError);
  });
});
