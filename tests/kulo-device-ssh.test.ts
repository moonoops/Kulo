import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionRecordView } from "@kulo/protocol";
import { ConnectionVaultError } from "../packages/hub/src/connection-vault.js";
import {
  DeviceSshConnector,
  INSTALL_REMOTE,
  buildRemoteNodeEvalCommand,
  isCredentialDeviceSshRecord,
  remoteNodeCommand,
  validateDeviceSshAddRequest,
  type DeviceSshRecord,
  type LegacyDeviceSshRecord,
} from "../packages/hub/src/device-ssh.js";
import { createDeviceSshRuntime, toDeviceSshHttpError } from "../packages/hub/src/http/device-ssh-routes.js";
import type { KuloConnections, ResolvedDeviceSshCredential } from "../packages/hub/src/connections.js";
import type { DeviceInterconnectionManager } from "../packages/hub/src/devices.js";

const mocks = vi.hoisted(() => ({
  prepareAuth: vi.fn(),
  captureSsh: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../packages/hub/src/connection-ssh-auth.js", async (original) => {
  const actual = await original<typeof import("../packages/hub/src/connection-ssh-auth.js")>();
  return {
    ...actual,
    prepareSshAuthSession: mocks.prepareAuth,
    captureSshProcess: mocks.captureSsh,
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

const CONNECTION_ID = "connection-11111111-2222-3333-4444-555555555555";
const connectors: DeviceSshConnector[] = [];
const cleanups: Array<() => void> = [];
let processes: FakeSshProcess[];
let authCleanups: Array<ReturnType<typeof vi.fn>>;

function makeConnection(overrides: Partial<ConnectionRecordView> = {}): ConnectionRecordView {
  return {
    id: CONNECTION_ID,
    name: "Workstation",
    kind: "ssh",
    category: "credential",
    host: "192.0.2.50",
    port: 22,
    username: "demo",
    status: "verified",
    hasCredential: true,
    secretFields: ["password"],
    hostFingerprint: "ssh-ed25519 SHA256:test-fingerprint",
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeResolved(overrides: Partial<ResolvedDeviceSshCredential> = {}): ResolvedDeviceSshCredential {
  return {
    connection: makeConnection(),
    secrets: { password: "synthetic-station-password" },
    knownHostsPath: "/tmp/connection-runtime/test.known-hosts",
    revision: 1,
    ...overrides,
  };
}

function fixture(options: {
  resolveVerified?: ReturnType<typeof vi.fn>;
  resolveForRestore?: ReturnType<typeof vi.fn>;
  findBoundDevice?: ReturnType<typeof vi.fn>;
  onAddFailed?: (deviceId: string, message: string) => void;
  platform?: NodeJS.Platform;
} = {}) {
  const resolveVerified = options.resolveVerified ?? vi.fn().mockResolvedValue(makeResolved());
  const resolveForRestore = options.resolveForRestore ?? vi.fn().mockResolvedValue(makeResolved());
  const findBoundDevice = options.findBoundDevice ?? vi.fn().mockReturnValue(undefined);
  const createInvitation = vi.fn().mockResolvedValue({ deviceId: "device-ssh-1", inviteToken: "single-use-invite-secret-token" });
  const onError = vi.fn();
  const connector = new DeviceSshConnector({
    hubPort: 7788,
    credentials: { resolveVerified, resolveForRestore },
    findBoundDevice,
    createInvitation,
    onError,
    onAddFailed: options.onAddFailed,
    platform: options.platform ?? "darwin",
  });
  connectors.push(connector);
  return { connector, resolveVerified, resolveForRestore, findBoundDevice, createInvitation, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
  processes = [];
  authCleanups = [];
  mocks.prepareAuth.mockImplementation(async (opts: { host: string; forwardingMode: string; reverseForward?: { remotePort: number; hubPort: number } }) => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    authCleanups.push(cleanup);
    const args = [
      "-F", "/dev/null",
      ...(opts.forwardingMode === "reverse-tunnel"
        ? ["-o", "ClearAllForwardings=no", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${opts.reverseForward!.remotePort}:127.0.0.1:${opts.reverseForward!.hubPort}`]
        : ["-o", "ClearAllForwardings=yes"]),
      "--", opts.host,
    ];
    return { environment: { SSH_ASKPASS_REQUIRE: "force" }, args, cleanup };
  });
  mocks.captureSsh.mockImplementation(async (_bin: string, args: string[]) => {
    const remoteCmd = args.at(-1) ?? "";
    if (remoteCmd.includes("KULO-NO-NODE")) {
      return {
        stdout: 'KULO-PREPARE-JSON:{"port":34123,"nodePath":"/opt/homebrew/bin/node","platform":"darwin"}\n',
        stderr: "",
        output: "",
        exitCode: 0,
      };
    }
    return { stdout: "设备已加入\n", stderr: "", output: "设备已加入\n", exitCode: 0 };
  });
  mocks.spawn.mockImplementation(() => {
    const child = new FakeSshProcess();
    processes.push(child);
    queueMicrotask(() => child.stdout.write("KULO-TUNNEL-READY\n"));
    return child;
  });
});

afterEach(() => {
  for (const connector of connectors.splice(0)) connector.close();
  for (const fn of cleanups.splice(0)) fn();
  vi.useRealTimers();
});

describe("SSH credential-bound device onboarding", () => {
  it.each([
    { connectionId: "" },
    { connectionId: "not-a-connection-id" },
    { connectionId: CONNECTION_ID, name: "bad\nname" },
    { connectionId: CONNECTION_ID, rootDir: "~/workspace\nother" },
  ])("rejects invalid SSH add request before touching credentials: %j", async (invalid) => {
    const { connector, resolveVerified } = fixture();
    await expect(connector.add(invalid as never)).rejects.toThrow();
    expect(resolveVerified).not.toHaveBeenCalled();
  });

  it("rejects duplicate binding and releases in-flight mutex on failure", async () => {
    const boundFixture = fixture({ findBoundDevice: vi.fn().mockReturnValue({ id: "device-existing", name: "KuloStation" }) });
    await expect(boundFixture.connector.add({ connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "device_ssh_credential_bound",
      status: 409,
    });

    let rejectResolve!: (err: Error) => void;
    const pending = new Promise<ResolvedDeviceSshCredential>((_res, rej) => { rejectResolve = rej; });
    const raceFixture = fixture({ resolveVerified: vi.fn().mockReturnValueOnce(pending) });
    const first = raceFixture.connector.add({ connectionId: CONNECTION_ID });
    expect(raceFixture.connector.isAddingConnection(CONNECTION_ID)).toBe(true);
    await expect(raceFixture.connector.add({ connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "device_ssh_adding",
      status: 409,
    });
    rejectResolve(Object.assign(new Error("未验证"), { code: "connection_ssh_unverified", status: 409 }));
    await expect(first).rejects.toMatchObject({ code: "connection_ssh_unverified" });
    expect(raceFixture.connector.isAddingConnection(CONNECTION_ID)).toBe(false);
  });

  it("pairs over verified SSH credential, destroys tunnel auth immediately on ready, and never places inviteToken in SSH args", async () => {
    const { connector, createInvitation } = fixture();
    const record = await connector.add({ connectionId: CONNECTION_ID, rootDir: "~/Kulo" });

    expect(record).toEqual({
      deviceId: "device-ssh-1",
      connectionId: CONNECTION_ID,
      remotePort: 34123,
      remoteNodePath: "/opt/homebrew/bin/node",
      rootDir: "~/Kulo",
    });
    expect(createInvitation).toHaveBeenCalledWith({
      name: "Workstation",
      rootDir: "~/Kulo",
      hubUrl: "http://127.0.0.1:34123",
      kind: "ssh",
    });
    // Tunnel auth cleanup runs immediately upon KULO-TUNNEL-READY while the tunnel stays open
    expect(authCleanups.every((fn) => fn.mock.calls.length === 1)).toBe(true);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.kill).not.toHaveBeenCalled();

    // Verify inviteToken was piped only via stdin JSON line, never in SSH command argv
    const installCall = mocks.captureSsh.mock.calls.at(-1)!;
    expect(JSON.stringify(installCall[1])).not.toContain("single-use-invite-secret-token");
    expect(installCall[2].input).toBe(`${JSON.stringify({ hubUrl: "http://127.0.0.1:34123", inviteToken: "single-use-invite-secret-token" })}\n`);
    expect(installCall[2].rawInput).toBe(true);
  });

  it("detects Windows DefaultShell even when Git Bash sh.exe succeeds on POSIX probe", async () => {
    mocks.captureSsh.mockImplementation(async (_bin: string, args: string[]) => {
      const cmd = args.at(-1) ?? "";
      if (cmd.includes("KULO-NO-NODE")) {
        return {
          stdout: 'KULO-PREPARE-JSON:{"port":41234,"nodePath":"C:\\\\Program Files\\\\nodejs\\\\node.exe","platform":"win32"}\n',
          stderr: "",
          output: "",
          exitCode: 0,
        };
      }
      if (cmd === "echo %OS% $PSVersionTable.PSVersion") {
        return { stdout: "%OS% 7.4.1\n", stderr: "", output: "", exitCode: 0 };
      }
      return { stdout: "ok\n", stderr: "", output: "ok\n", exitCode: 0 };
    });

    const { connector } = fixture();
    const record = await connector.add({ connectionId: CONNECTION_ID });
    expect(record.remoteShell).toBe("powershell");
    expect(record.remoteNodePath).toBe("C:\\Program Files\\nodejs\\node.exe");
    const tunnelCmd = mocks.spawn.mock.calls[0]![1].at(-1) as string;
    expect(tunnelCmd).toContain("& 'C:\\Program Files\\nodejs\\node.exe' -e ");
  });

  it("validates remoteNodeCommand and enforces zero special chars in buildRemoteNodeEvalCommand", () => {
    expect(remoteNodeCommand("/opt/homebrew/bin/node")).toBe("'/opt/homebrew/bin/node'");
    expect(remoteNodeCommand("C:\\Program Files\\nodejs\\node.exe", "cmd")).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(remoteNodeCommand("C:\\Program Files\\nodejs\\node.exe", "powershell")).toBe("& 'C:\\Program Files\\nodejs\\node.exe'");
    expect(remoteNodeCommand("C:\\Program Files\\nodejs\\node.exe", "git-bash")).toBe("'C:\\Program Files\\nodejs\\node.exe'");
    expect(() => buildRemoteNodeEvalCommand("/usr/bin/node", "console.log('ok')")).not.toThrow();
    expect(() => buildRemoteNodeEvalCommand("/usr/bin/node", 'console.log("bad")')).toThrow("不受支持的字符");
    expect(() => buildRemoteNodeEvalCommand("/usr/bin/node", "console.log( $HOME )")).toThrow("不受支持的字符");
    expect(validateDeviceSshAddRequest({ connectionId: ` ${CONNECTION_ID} ` })).toEqual({ connectionId: CONNECTION_ID });
  });

  it("completes INSTALL_REMOTE over single-line stdin without waiting for EOF and keeps inviteToken out of installer argv", async () => {
    let seenArgv = "";
    let seenEnvInvite = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/connect/install.sh") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end('#!/bin/sh\necho "ARGV:$*"\necho "ENV:$KULO_PEER_INVITE"\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // Spawn real Node directly without closing stdin (simulating Windows sshd omitting EOF)
      const child = realSpawn(process.execPath, ["-e", INSTALL_REMOTE], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      // Deliberately write a single line WITHOUT calling child.stdin.end()!
      child.stdin.write(`${JSON.stringify({ hubUrl: `http://127.0.0.1:${port}`, inviteToken: "env-only-invite-token-xyz" })}\n`);
    });

    expect(output.code).toBe(0);
    seenArgv = output.stdout.split("\n").find((line) => line.startsWith("ARGV:")) ?? "";
    seenEnvInvite = output.stdout.split("\n").find((line) => line.startsWith("ENV:")) ?? "";
    expect(seenArgv).not.toContain("env-only-invite-token-xyz");
    expect(seenEnvInvite).toBe("ENV:env-only-invite-token-xyz");
  });

  it("prevents orphan tunnel spawn when cancelled mid-auth and handles legacy records, vault lock, and credential lifecycle events", async () => {
    // 1. Mid-auth cancel prevents orphan spawn
    let releaseAuth!: () => void;
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
    const orphanCleanup = vi.fn().mockResolvedValue(undefined);
    mocks.prepareAuth.mockImplementationOnce(async () => {
      await authGate;
      return { environment: {}, args: ["--", "192.0.2.50"], cleanup: orphanCleanup };
    });
    const f1 = fixture();
    const stored: DeviceSshRecord = {
      deviceId: "device-restore-1",
      connectionId: CONNECTION_ID,
      remotePort: 44123,
      remoteNodePath: "/usr/bin/node",
    };
    const restoring = f1.connector.restore([stored]);
    await new Promise((r) => setTimeout(r, 10));
    f1.connector.cancelPending();
    releaseAuth();
    await restoring;
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(orphanCleanup).toHaveBeenCalledTimes(1);

    // 2. Legacy record emits clean migration notice without spawning SSH
    const f2 = fixture();
    const legacy: LegacyDeviceSshRecord = {
      deviceId: "device-legacy-1",
      target: { host: "192.0.2.50", port: 22, user: "demo" },
      remotePort: 44124,
      remoteNodePath: "/usr/bin/node",
    };
    expect(isCredentialDeviceSshRecord(legacy)).toBe(false);
    await f2.connector.restore([legacy]);
    expect(f2.onError).toHaveBeenCalledWith("device-legacy-1", expect.stringContaining("旧版连接方式"));
    expect(mocks.spawn).not.toHaveBeenCalled();

    // 3. Vault lock maps cleanly to 503 and schedules reconnect
    const vaultErr = new ConnectionVaultError("connection_vault_locked");
    expect(toDeviceSshHttpError(vaultErr)).toMatchObject({ status: 503, code: "connection_vault_locked" });

    // 4. Identity change stops active tunnel and pauses reconnect until verified event arrives
    const f3 = fixture();
    await f3.connector.restore([stored]);
    expect(processes).toHaveLength(1);
    f3.connector.handleConnectionChanged({ type: "identity-changed", connectionId: CONNECTION_ID });
    expect(processes[0]!.kill).toHaveBeenCalled();
    expect(f3.onError).toHaveBeenCalledWith("device-restore-1", expect.stringContaining("重新验证"));

    vi.useFakeTimers();
    f3.connector.handleConnectionChanged({ type: "verified", connectionId: CONNECTION_ID });
    await vi.advanceTimersByTimeAsync(10);
    expect(processes.length).toBeGreaterThanOrEqual(2);
  });

  it("wires in-use guard and credential eligibility inspection via createDeviceSshRuntime", () => {
    let guard: ((connectionId: string) => void) | undefined;
    let boundDevices: Array<{ id: string; name: string }> = [];
    const verifiedConn = makeConnection();
    const unverifiedConn = makeConnection({ id: "connection-22222222-2222-3333-4444-555555555555", status: "saved", hostFingerprint: undefined });
    const records = new Map<string, ConnectionRecordView>([
      [verifiedConn.id, verifiedConn],
      [unverifiedConn.id, unverifiedConn],
    ]);
    const connections = {
      resolveSshForDevice: vi.fn(),
      setSshInUseGuard: vi.fn((fn: (id: string) => void) => { guard = fn; }),
      setOnSshChangedHook: vi.fn(),
      getConnectionRecord: vi.fn((id: string) => records.get(id)),
      redact: vi.fn((text: string) => text),
    } as unknown as KuloConnections;
    const devices = {
      enabled: true,
      localNodeId: "local",
      findSshDevicesByConnectionId: vi.fn((id: string) => (id === verifiedConn.id ? boundDevices : [])),
      createInvitation: vi.fn(),
      setError: vi.fn(),
      remove: vi.fn(),
      recordSsh: vi.fn(),
      view: vi.fn(),
    } as unknown as DeviceInterconnectionManager;

    const runtime = createDeviceSshRuntime({
      connections,
      devices,
      hubPort: () => 7788,
      ensureEnabled: async () => {},
    });
    connectors.push(runtime.connector);

    expect(runtime.inspectSshCredential(verifiedConn.id)).toMatchObject({ eligible: true });
    expect(runtime.inspectSshCredential(unverifiedConn.id)).toMatchObject({ eligible: false });
    expect(runtime.inspectSshCredential("connection-missing")).toMatchObject({ eligible: false });
    expect(() => guard?.(verifiedConn.id)).not.toThrow();

    boundDevices = [{ id: "device-1", name: "KuloStation" }];
    expect(runtime.inspectSshCredential(verifiedConn.id)).toMatchObject({ eligible: false, boundDevice: { id: "device-1", name: "KuloStation" } });
    expect(() => guard?.(verifiedConn.id)).toThrow("请先在「设备互联」中移除对应设备");
  });
});
