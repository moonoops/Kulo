import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostKeyChangedError } from "@earendil-works/pi-env";
import {
  DeviceSshConnector,
  deviceTunnelArguments,
  validateDeviceSshRequest,
  type DeviceSshRecord,
} from "../packages/hub/src/device-ssh.js";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  accept: vi.fn(),
  connect: vi.fn(),
  env: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@earendil-works/pi-env", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-env")>();
  return {
    ...actual,
    scanHostKey: mocks.scan,
    acceptHostKey: mocks.accept,
    connectSsh: mocks.connect,
    RemoteExecutionEnv: class { constructor(options: unknown) { return mocks.env(options); } },
  };
});

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));

class FakeSshProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => { queueMicrotask(() => this.emit("close", 0)); return true; });
}

const roots: string[] = [];
const connectors: DeviceSshConnector[] = [];
let processes: FakeSshProcess[];
let remoteEnv: { exec: ReturnType<typeof vi.fn>; joinPath: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let closeConnection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  processes = [];
  mocks.scan.mockResolvedValue({ lines: ["test-alias ssh-ed25519 public-test-key"], fingerprints: ["256 SHA256:test-fingerprint device (ED25519)"] });
  mocks.accept.mockResolvedValue(undefined);
  closeConnection = vi.fn();
  mocks.connect.mockResolvedValue({ connection: { close: closeConnection }, remote: { platform: "darwin", arch: "arm64", home: "/home/peer", warnings: [] } });
  remoteEnv = {
    exec: vi.fn().mockImplementation(async (_command, options) => {
      const first = remoteEnv.exec.mock.calls.length === 1;
      options.onOutput(first ? JSON.stringify({ directory: "/private/tmp/moco-join-test", port: 34123, nodePath: "/home/peer/.local/node runtime/bin/node" }) : "设备已加入\n");
      return { ok: true, value: { exitCode: 0 } };
    }),
    joinPath: vi.fn().mockResolvedValue({ ok: true, value: "/private/tmp/moco-join-test/join.json" }),
    writeFile: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
  mocks.env.mockReturnValue(remoteEnv);
  mocks.spawn.mockImplementation(() => {
    const child = new FakeSshProcess();
    processes.push(child);
    queueMicrotask(() => child.stdout.write("MOCO-TUNNEL-READY\n"));
    return child;
  });
});

afterEach(() => {
  for (const connector of connectors.splice(0)) connector.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

const request = { host: "workstation", user: "alice", port: 22, hubUrl: "http://192.168.1.2:7788", name: "工作电脑", rootDir: "~/Moco" };

function fixture(callbacks: { onAddFailed?: (deviceId: string, message: string) => void } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-device-ssh-"));
  roots.push(stateDir);
  const createInvitation = vi.fn().mockResolvedValue({ deviceId: "ssh-device-1", inviteToken: "single-use-invite-test-value" });
  const onError = vi.fn();
  const connector = new DeviceSshConnector({ stateDir, hubPort: 7788, createInvitation, onError, ...callbacks });
  connectors.push(connector);
  return { connector, createInvitation, onError, stateDir };
}

describe("SSH device onboarding", () => {
  it.each([
    { host: "-oProxyCommand=bad" },
    { host: "host;echo bad" },
    { host: "user@host" },
    { user: "alice;echo bad" },
    { port: 0 },
    { port: 65536 },
    { rootDir: "~/workspace\nother" },
    { hubUrl: "http://name:password@host" },
    { hubUrl: "file:///tmp/something" },
  ])("rejects invalid connection fields before running SSH: %j", async (invalid) => {
    const { connector } = fixture();
    await expect(connector.scan({ ...request, ...invalid })).rejects.toThrow();
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("supports IPv6 and existing SSH aliases without interpreting a shell", () => {
    expect(validateDeviceSshRequest({ ...request, host: "[2001:db8::1]" }).host).toBe("2001:db8::1");
    expect(validateDeviceSshRequest({ ...request, host: "my-work_mac" }).host).toBe("my-work_mac");
  });

  it("shows the fingerprint before trusting, then installs the peer over the verified reverse route", async () => {
    const { connector, createInvitation, stateDir } = fixture();
    const scan = await connector.scan(request);
    expect(scan.fingerprints).toEqual(["256 SHA256:test-fingerprint device (ED25519)"]);
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();

    const result = await connector.add(scan.scanId);
    expect(result.deviceId).toBe("ssh-device-1");
    expect(result.remotePort).toBe(34123);
    expect(result.remoteNodePath).toBe("/home/peer/.local/node runtime/bin/node");
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ loginShell: true }));
    expect(result.target.knownHostsFile).toBe(path.join(stateDir, "device-ssh-known-hosts"));
    expect(mocks.accept.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]!);
    expect(createInvitation).toHaveBeenCalledWith({ name: "工作电脑", rootDir: "~/Moco", hubUrl: "http://127.0.0.1:34123", kind: "ssh" });
    const write = remoteEnv.writeFile.mock.calls[0]!;
    expect(write[0]).toBe("/private/tmp/moco-join-test/join.json");
    expect(JSON.parse(write[1])).toEqual({ hubUrl: "http://127.0.0.1:34123", inviteToken: "single-use-invite-test-value" });
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain("single-use-invite-test-value");
    expect(JSON.stringify(remoteEnv.exec.mock.calls.map((args) => args[0]))).not.toContain("single-use-invite-test-value");
    expect(remoteEnv.exec.mock.calls[1]![0][0]).toBe(result.remoteNodePath);
    expect(mocks.spawn.mock.calls[0]![1].at(-1)).toMatch(/^'\/home\/peer\/\.local\/node runtime\/bin\/node' -e /);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(processes[0]!.kill).not.toHaveBeenCalled();
    await expect(connector.add(scan.scanId)).rejects.toThrow("已过期或已使用");
  });

  it("expires fingerprint confirmations and refuses changed trusted host keys", async () => {
    vi.useFakeTimers();
    const { connector } = fixture();
    const expired = await connector.scan(request);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await expect(connector.add(expired.scanId)).rejects.toThrow("已过期");
    expect(mocks.accept).not.toHaveBeenCalled();
    const changed = await connector.scan(request);
    mocks.accept.mockRejectedValueOnce(new HostKeyChangedError("trusted key changed"));
    await expect(connector.add(changed.scanId)).rejects.toThrow("trusted key changed");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("cleans up a failed bootstrap and redacts its single-use credential from diagnostics", async () => {
    const { connector, onError } = fixture();
    remoteEnv.exec.mockImplementation(async (_argv, options) => {
      if (remoteEnv.exec.mock.calls.length === 1) {
        options.onOutput(JSON.stringify({ directory: "/private/tmp/moco-join-test", port: 34123, nodePath: "/home/peer/.local/bin/node" }));
        return { ok: true, value: { exitCode: 0 } };
      }
      options.onOutput("failed single-use-invite-test-value");
      return { ok: true, value: { exitCode: 1 } };
    });
    const scan = await connector.scan(request);
    await expect(connector.add(scan.scanId)).rejects.toThrow("failed [配对凭证]");
    expect(JSON.stringify(onError.mock.calls)).not.toContain("single-use-invite-test-value");
    expect(onError).toHaveBeenCalledWith("ssh-device-1", "failed [配对凭证]");
    expect(processes[0]!.kill).toHaveBeenCalledOnce();
    expect(remoteEnv.remove).toHaveBeenCalledWith("/private/tmp/moco-join-test", { recursive: true, force: true }, expect.anything());
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  it("fails before installing or copying credentials when reverse forwarding is refused", async () => {
    const { connector, onError } = fixture();
    mocks.spawn.mockImplementation(() => {
      const child = new FakeSshProcess();
      processes.push(child);
      queueMicrotask(() => {
        child.stderr.write("Error: remote port forwarding failed");
        child.emit("close", 255);
      });
      return child;
    });
    const scan = await connector.scan(request);
    await expect(connector.add(scan.scanId)).rejects.toThrow("remote port forwarding failed");
    expect(remoteEnv.exec).toHaveBeenCalledOnce();
    expect(remoteEnv.writeFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("ssh-device-1", "Error: remote port forwarding failed");
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  it("enables the reverse loopback route while keeping strict host keys and agent forwarding disabled", () => {
    const args = deviceTunnelArguments({ host: "workstation", knownHostsFile: "/private/known-hosts", hostKeyAlias: "moco-peer" }, 34123, 7788, "/home/peer/.local/bin/node");
    expect(args).toContain("127.0.0.1:34123:127.0.0.1:7788");
    expect(args).toContain("ClearAllForwardings=no");
    expect(args).not.toContain("ClearAllForwardings=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.indexOf("-R")).toBeLessThan(args.indexOf("--"));
    expect(() => deviceTunnelArguments({ host: "host", knownHostsFile: "/private/known-hosts", hostKeyAlias: "alias" }, 0, 7788, "/home/peer/.local/bin/node")).toThrow("端口无效");
  });

  it("executes the exact discovered POSIX Node path when it contains spaces, quotes and shell punctuation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-ssh-node-path-"));
    roots.push(directory);
    const executable = path.join(directory, "node's runtime; safe");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$1\" \"$2\"\n", { mode: 0o700 });
    const command = deviceTunnelArguments({ host: "workstation", knownHostsFile: "/private/known-hosts", hostKeyAlias: "moco-peer" }, 34123, 7788, executable).at(-1)!;
    const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(output).toBe("-e\nconsole.log('MOCO-TUNNEL-READY');process.stdin.resume()\n");
  });

  it("quotes absolute Windows Node paths for both supported SSH default shells", () => {
    const target = { host: "windows", knownHostsFile: "/private/known-hosts", hostKeyAlias: "moco-peer" };
    const nodePath = "C:\\Users\\O'Brien\\Node Runtime\\node.exe";
    expect(deviceTunnelArguments(target, 34123, 7788, nodePath, "powershell").at(-1)).toMatch(/^& 'C:\\Users\\O''Brien\\Node Runtime\\node\.exe' -e /);
    expect(deviceTunnelArguments(target, 34123, 7788, nodePath, "cmd").at(-1)).toMatch(/^"C:\\Users\\O'Brien\\Node Runtime\\node\.exe" -e /);
    expect(() => deviceTunnelArguments(target, 34123, 7788, "node.exe", "cmd")).toThrow("路径无效");
    expect(() => deviceTunnelArguments(target, 34123, 7788, "C:\\%UNTRUSTED%\\node.exe", "cmd")).toThrow("路径无效");
    expect(() => deviceTunnelArguments(target, 34123, 7788, "/not/windows/node", "powershell")).toThrow("路径无效");
  });

  it("does not start a restored tunnel with a missing or relative Node executable", async () => {
    const { connector, onError } = fixture();
    const stored: DeviceSshRecord = {
      deviceId: "ssh-device-1", remotePort: 34123, remoteNodePath: "node; echo unsafe", request,
      target: { host: "workstation", knownHostsFile: "/private/known-hosts", hostKeyAlias: "moco-peer" },
    };
    await connector.restore([stored]);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("ssh-device-1", expect.stringContaining("路径无效"));
  });

  it("restores trusted routes, retries a lost tunnel, and stops retrying when the device is removed", async () => {
    vi.useFakeTimers();
    const { connector, onError } = fixture();
    const stored: DeviceSshRecord = {
      deviceId: "ssh-device-1", remotePort: 34123, remoteNodePath: "/home/peer/.local/bin/node", request,
      target: { host: "untrusted-stored-host", knownHostsFile: "/other/file", hostKeyAlias: "wrong", ssh: "bad-executable" },
    };
    await connector.restore([stored]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0]![0]).toBe("ssh");
    expect(mocks.spawn.mock.calls[0]![1]).toContain("workstation");
    expect(JSON.stringify(mocks.spawn.mock.calls[0])).not.toContain("untrusted-stored-host");
    processes[0]!.emit("close", 255);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith("ssh-device-1", expect.stringContaining("SSH 连接已断开"));
    connector.remove("ssh-device-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(processes[1]!.kill).toHaveBeenCalledOnce();
  });

  it("does not bootstrap or create an invitation when the remote Node runtime is missing", async () => {
    const { connector, createInvitation } = fixture();
    remoteEnv.exec.mockResolvedValue({ ok: true, value: { exitCode: 127 } });
    const scan = await connector.scan(request);
    await expect(connector.add(scan.scanId)).rejects.toThrow("Node.js 22.19");
    expect(createInvitation).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  it("invalidates an in-progress fingerprint scan when interconnection is disabled", async () => {
    const { connector } = fixture();
    let finish!: (value: { lines: string[]; fingerprints: string[] }) => void;
    mocks.scan.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const scanning = connector.scan(request);
    connector.cancelPending();
    finish({ lines: ["test-alias ssh-ed25519 public-test-key"], fingerprints: ["SHA256:test"] });
    await expect(scanning).rejects.toThrow("已取消");
    const next = await connector.scan(request);
    expect(next.fingerprints).toEqual(["256 SHA256:test-fingerprint device (ED25519)"]);
  });

  it("cancels remote bootstrap before creating credentials when interconnection is disabled", async () => {
    const { connector, createInvitation } = fixture();
    let finish!: () => void;
    remoteEnv.exec.mockImplementationOnce(async (_argv, options) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      options.onOutput(JSON.stringify({ directory: "/private/tmp/moco-join-test", port: 34123, nodePath: "/home/peer/.local/bin/node" }));
      return { ok: true, value: { exitCode: 0 } };
    });
    const scan = await connector.scan(request);
    const adding = connector.add(scan.scanId);
    await vi.waitFor(() => expect(remoteEnv.exec).toHaveBeenCalledOnce());
    connector.cancelPending();
    finish();
    await expect(adding).rejects.toThrow("已取消");
    expect(createInvitation).not.toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("revokes an incomplete addition separately from reconnect diagnostics", async () => {
    const onAddFailed = vi.fn();
    const { connector, onError } = fixture({ onAddFailed });
    remoteEnv.writeFile.mockResolvedValue({ ok: false, error: { message: "write denied" } });
    const scan = await connector.scan(request);
    await expect(connector.add(scan.scanId)).rejects.toThrow("write denied");
    expect(onAddFailed).toHaveBeenCalledWith("ssh-device-1", expect.stringContaining("write denied"));
    expect(onError).not.toHaveBeenCalled();
    expect(processes[0]!.kill).toHaveBeenCalledOnce();
  });
});
