import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionRecordView } from "@kulo/protocol";
import { renderPeerInstaller } from "@kulo/env";
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
import {
  MANAGED_NODE_TARGETS,
  MANAGED_NODE_VERSION,
  POSIX_PREPARE_COMMAND,
  PREPARE_MARKER,
  buildPosixNodeBootstrapCommand,
  buildWindowsNodeBootstrapCommand,
  extractBootstrapError,
  parseNoNodeMarker,
  resolveManagedNodeTarget,
} from "../packages/hub/src/device-ssh-node.js";
import { createDeviceSshRuntime, toDeviceSshHttpError } from "../packages/hub/src/http/device-ssh-routes.js";
import { handleDevicesAndClusterRoutes } from "../packages/hub/src/http/devices-cluster-routes.js";
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
    const boundFixture = fixture({ findBoundDevice: vi.fn().mockReturnValue({ id: "device-existing", name: "LocalStation" }) });
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
    expect(installCall[2].input).toBe(`${JSON.stringify({ hubUrl: "http://127.0.0.1:34123", inviteToken: "single-use-invite-secret-token", watchStdin: true })}\n`);
    expect(installCall[2].rawInput).toBe(true);
    expect(installCall[2].keepStdinOpen).toBe(true);
    expect(typeof installCall[2].onStdoutLine).toBe("function");
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

    boundDevices = [{ id: "device-1", name: "LocalStation" }];
    expect(runtime.inspectSshCredential(verifiedConn.id)).toMatchObject({ eligible: false, boundDevice: { id: "device-1", name: "LocalStation" } });
    expect(() => guard?.(verifiedConn.id)).toThrow("请先在「设备互联」中移除对应设备");
  });

  it("parses KULO-NO-NODE probes, resolves all 6 targets, blocks musl/unsupported arch, and keeps sh -c free of nested single quotes", () => {
    expect(parseNoNodeMarker("warn\nKULO-NO-NODE:linux|x86_64|glibc\n")).toEqual({ os: "linux", arch: "x64", libc: "glibc" });
    expect(parseNoNodeMarker("KULO-NO-NODE:darwin|arm64|glibc")).toEqual({ os: "darwin", arch: "arm64", libc: "glibc" });
    expect(parseNoNodeMarker("KULO-NO-NODE:mingw64_nt-10.0|x86_64|glibc")).toEqual({ os: "win32", arch: "x64", libc: "glibc" });
    expect(resolveManagedNodeTarget({ os: "linux", arch: "x86_64", libc: "glibc" })).toBe(MANAGED_NODE_TARGETS["linux-x64"]);
    expect(resolveManagedNodeTarget({ os: "linux", arch: "aarch64", libc: "glibc" })).toBe(MANAGED_NODE_TARGETS["linux-arm64"]);
    expect(resolveManagedNodeTarget({ os: "darwin", arch: "arm64", libc: "glibc" })).toBe(MANAGED_NODE_TARGETS["darwin-arm64"]);
    expect(resolveManagedNodeTarget({ os: "darwin", arch: "x86_64", libc: "glibc" })).toBe(MANAGED_NODE_TARGETS["darwin-x64"]);
    expect(resolveManagedNodeTarget({ os: "win32", arch: "x64", libc: "msvc" })).toBe(MANAGED_NODE_TARGETS["win-x64"]);
    expect(resolveManagedNodeTarget({ os: "win32", arch: "arm64", libc: "msvc" })).toBe(MANAGED_NODE_TARGETS["win-arm64"]);
    expect(() => resolveManagedNodeTarget({ os: "linux", arch: "x86_64", libc: "musl" })).toThrow("musl");
    expect(() => resolveManagedNodeTarget({ os: "linux", arch: "riscv64", libc: "glibc" })).toThrow("暂不支持自动安装");
    expect(extractBootstrapError("noise\nKULO-BOOTSTRAP-ERR:自动下载失败\n")).toBe("自动下载失败");

    // Verify zero nested single quotes inside `sh -c '...'` payloads
    for (const cmd of [
      POSIX_PREPARE_COMMAND,
      buildPosixNodeBootstrapCommand(MANAGED_NODE_TARGETS["linux-x64"]),
      buildPosixNodeBootstrapCommand(MANAGED_NODE_TARGETS["darwin-arm64"]),
    ]) {
      expect(cmd.startsWith("sh -c '")).toBe(true);
      expect(cmd.endsWith("'")).toBe(true);
      expect(cmd.slice("sh -c '".length, -1)).not.toContain("'");
    }
    expect(buildWindowsNodeBootstrapCommand(MANAGED_NODE_TARGETS["win-x64"])).toContain("-EncodedCommand ");
    expect(renderPeerInstaller("posix")).toContain("registry.npmmirror.com");
    expect(renderPeerInstaller("posix")).toContain("command -v curl");
    expect(renderPeerInstaller("powershell")).toContain("registry.npmmirror.com");
  });

  it("auto-bootstraps managed Node.js on bare Linux host and surfaces musl / bootstrap errors cleanly", async () => {
    const commands: string[] = [];
    mocks.captureSsh.mockImplementation(async (_bin: string, args: string[]) => {
      const cmd = args.at(-1) ?? "";
      commands.push(cmd);
      if (cmd === POSIX_PREPARE_COMMAND) {
        return { stdout: "", stderr: "KULO-NO-NODE:linux|x86_64|glibc\n", output: "", exitCode: 127 };
      }
      if (cmd.includes(MANAGED_NODE_TARGETS["linux-x64"].sha256)) {
        return {
          stdout: `${PREPARE_MARKER}{"port":42233,"nodePath":"/home/alice/.kulo/node/v${MANAGED_NODE_VERSION}/bin/node","platform":"linux"}\n`,
          stderr: "",
          output: "",
          exitCode: 0,
        };
      }
      return { stdout: "设备已加入\n", stderr: "", output: "设备已加入\n", exitCode: 0 };
    });

    const { connector } = fixture();
    const record = await connector.add({ connectionId: CONNECTION_ID });
    expect(record.remoteNodePath).toBe(`/home/alice/.kulo/node/v${MANAGED_NODE_VERSION}/bin/node`);
    expect(record.remotePort).toBe(42233);
    expect(commands[0]).toBe(POSIX_PREPARE_COMMAND);
    expect(commands[1]).toContain(MANAGED_NODE_TARGETS["linux-x64"].archive);
    expect(commands[1]).toContain("https://nodejs.org/dist");
    expect(commands[1]).toContain("https://npmmirror.com/mirrors/node");

    // Alpine / musl host fails immediately with actionable Chinese error without attempting download
    mocks.captureSsh.mockResolvedValueOnce({ stdout: "", stderr: "KULO-NO-NODE:linux|x86_64|musl\n", output: "", exitCode: 127 });
    await expect(connector.add({ connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "device_ssh_node_unsupported",
      message: expect.stringContaining("musl"),
    });

    // Bootstrap failure extracts KULO-BOOTSTRAP-ERR cleanly
    mocks.captureSsh
      .mockResolvedValueOnce({ stdout: "", stderr: "KULO-NO-NODE:linux|arm64|glibc\n", output: "", exitCode: 127 })
      .mockResolvedValueOnce({ stdout: "", stderr: "KULO-BOOTSTRAP-ERR:自动下载或校验 Node.js 失败\n", output: "", exitCode: 1 });
    await expect(connector.add({ connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "device_ssh_node_bootstrap_failed",
      message: "自动下载或校验 Node.js 失败",
    });
  });

  it("executes real POSIX bootstrap script with SHA-256 mirror fallback, spaces in HOME, and zero leftover temp dirs", async () => {
    const { execFileSync, spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-node-boot-"));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    // 1. Verify POSIX_PREPARE_COMMAND skips an old Node v18 binary and emits KULO-NO-NODE
    const oldBinDir = path.join(tmpRoot, "old-bin");
    fs.mkdirSync(oldBinDir, { recursive: true });
    fs.writeFileSync(path.join(oldBinDir, "node"), "#!/bin/sh\necho v18.19.1\n", { mode: 0o755 });
    const emptyHome = path.join(tmpRoot, "empty home");
    fs.mkdirSync(emptyHome, { recursive: true });
    const probeInner = POSIX_PREPARE_COMMAND.slice("sh -c '".length, -1);
    const probeRes = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = realSpawn("/bin/sh", ["-c", probeInner], {
        env: { PATH: `${oldBinDir}:/usr/bin:/bin`, HOME: emptyHome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    // On machines where /opt/homebrew/bin/node >= 22.19 exists, probe finds homebrew node;
    // either way it MUST NOT pick the fake v18.19.1 binary!
    if (probeRes.code === 127) {
      expect(parseNoNodeMarker(probeRes.stderr)).toMatchObject({ os: expect.any(String), arch: expect.any(String) });
    } else {
      expect(probeRes.code).toBe(0);
      expect(probeRes.stdout).toContain(PREPARE_MARKER);
      expect(probeRes.stdout).not.toContain(oldBinDir);
    }

    // 2. Build a tiny real .tar.gz whose bin/node execs our local Node 22+ binary
    const folder = `node-v${MANAGED_NODE_VERSION}-test-posix`;
    const staging = path.join(tmpRoot, "stage");
    fs.mkdirSync(path.join(staging, folder, "bin"), { recursive: true });
    const shimPath = path.join(staging, folder, "bin", "node");
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    const archiveName = `${folder}.tar.gz`;
    const archivePath = path.join(tmpRoot, archiveName);
    execFileSync("tar", ["-czf", archivePath, "-C", staging, folder]);
    const validBytes = fs.readFileSync(archivePath);
    const validSha256 = crypto.createHash("sha256").update(validBytes).digest("hex");

    const requestedPaths: string[] = [];
    const server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      if (req.url === `/mirror1/v${MANAGED_NODE_VERSION}/${archiveName}`) {
        // Tampered / corrupt payload on mirror 1 — must fail SHA-256 and fall back to mirror 2!
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(Buffer.from("corrupted-archive-bytes"));
        return;
      }
      if (req.url === `/mirror2/v${MANAGED_NODE_VERSION}/${archiveName}`) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(validBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const fakeHome = path.join(tmpRoot, "home with spaces");
    fs.mkdirSync(fakeHome, { recursive: true });
    const bootCmd = buildPosixNodeBootstrapCommand(
      {
        key: "linux-x64",
        version: MANAGED_NODE_VERSION,
        platform: "posix",
        folder,
        archive: archiveName,
        sha256: validSha256,
        binRelPath: "bin/node",
      },
      [`http://127.0.0.1:${port}/mirror1`, `http://127.0.0.1:${port}/mirror2`],
    );

    const innerScript = bootCmd.slice("sh -c '".length, -1);
    const bootRes = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = realSpawn("/bin/sh", ["-c", innerScript], {
        env: { PATH: process.env.PATH, HOME: fakeHome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(bootRes.code, bootRes.stderr).toBe(0);
    const stdout = bootRes.stdout;

    expect(requestedPaths).toEqual([
      `/mirror1/v${MANAGED_NODE_VERSION}/${archiveName}`,
      `/mirror2/v${MANAGED_NODE_VERSION}/${archiveName}`,
    ]);
    const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith(PREPARE_MARKER));
    expect(markerLine).toBeDefined();
    const payload = JSON.parse(markerLine!.slice(PREPARE_MARKER.length)) as { port: number; nodePath: string; platform: string };
    expect(payload.port).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(fakeHome, ".kulo", "node", `v${MANAGED_NODE_VERSION}`, "bin", "node"))).toBe(true);
    expect(fs.lstatSync(path.join(fakeHome, ".kulo", "node", "current")).isSymbolicLink()).toBe(true);
    const remainingEntries = fs.readdirSync(path.join(fakeHome, ".kulo", "node"));
    expect(remainingEntries.some((name) => name.startsWith(".install-"))).toBe(false);
  });

  it("terminates remote child and grandchild processes and removes temp dir when INSTALL_REMOTE watchStdin hits EOF", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/connect/install.sh") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end([
          "#!/bin/sh",
          "sleep 30 &",
          "CHILD_PID=$!",
          'echo "READY:$CHILD_PID:$(dirname "$0")"',
          "wait $CHILD_PID",
          "",
        ].join("\n"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let grandchildPid = 0;
    let joinDir = "";

    const start = Date.now();
    const exitResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = realSpawn(process.execPath, ["-e", INSTALL_REMOTE], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      let triggeredEof = false;
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        const readyLine = stdout.split(/\r?\n/).find((l) => l.startsWith("READY:"));
        if (readyLine && !triggeredEof) {
          triggeredEof = true;
          const [, pidText, dir] = readyLine.split(":");
          grandchildPid = Number(pidText);
          joinDir = dir ?? "";
          // Simulate SSH disconnecting/timing out by closing stdin
          child.stdin.end();
        }
      });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(`${JSON.stringify({ hubUrl: `http://127.0.0.1:${port}`, inviteToken: "eof-cancel-token", watchStdin: true })}\n`);
    });

    expect(Date.now() - start).toBeLessThan(8_000);
    expect(exitResult.code).not.toBe(0);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(joinDir).toContain("kulo-join-");
    expect(fs.existsSync(joinDir)).toBe(false);
    // Give the kernel a brief tick to reap killed grandchild, then verify ESRCH
    await new Promise((r) => setTimeout(r, 150));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it("tracks SSH onboarding stages in real time, supports AbortSignal cancellation, and lets immediate retries await unwinding", async () => {
    const seenStages: string[] = [];
    mocks.captureSsh.mockImplementation(async (_bin: string, args: string[], opts?: { onStdoutLine?: (line: string) => void }) => {
      const cmd = args.at(-1) ?? "";
      if (cmd === POSIX_PREPARE_COMMAND) {
        return { stdout: "", stderr: "KULO-NO-NODE:linux|x86_64|glibc\n", output: "", exitCode: 127 };
      }
      if (cmd.includes(MANAGED_NODE_TARGETS["linux-x64"].sha256)) {
        seenStages.push(connector.listOnboardingProgress()[0]?.stage ?? "none");
        return {
          stdout: `${PREPARE_MARKER}{"port":42234,"nodePath":"/home/demo/.kulo/node/v${MANAGED_NODE_VERSION}/bin/node","platform":"linux"}\n`,
          stderr: "",
          output: "",
          exitCode: 0,
        };
      }
      seenStages.push(connector.listOnboardingProgress()[0]?.stage ?? "none");
      opts?.onStdoutLine?.("KULO-INSTALL-STAGE:installing-deps");
      seenStages.push(connector.listOnboardingProgress()[0]?.stage ?? "none");
      opts?.onStdoutLine?.("KULO-INSTALL-STAGE:pairing");
      seenStages.push(connector.listOnboardingProgress()[0]?.stage ?? "none");
      return { stdout: "设备已加入\n", stderr: "", output: "设备已加入\n", exitCode: 0 };
    });

    const { connector } = fixture();
    await connector.add({ connectionId: CONNECTION_ID });
    expect(seenStages).toEqual(["installing-node", "downloading-peer", "installing-deps", "pairing"]);
    expect(connector.listOnboardingProgress()).toEqual([]);

    // Now test cancelling an in-flight add and immediately retrying while the cancelled run unwinds
    let releaseCancelledInstall!: () => void;
    const cancelGate = new Promise<void>((resolve) => { releaseCancelledInstall = resolve; });
    const onAddFailed = vi.fn();
    const cancelFixture = fixture({ onAddFailed });
    let installAttempt = 0;
    mocks.captureSsh.mockImplementation(async (_bin: string, args: string[]) => {
      const cmd = args.at(-1) ?? "";
      if (cmd === POSIX_PREPARE_COMMAND) {
        return {
          stdout: `${PREPARE_MARKER}{"port":42235,"nodePath":"/usr/bin/node","platform":"linux"}\n`,
          stderr: "",
          output: "",
          exitCode: 0,
        };
      }
      installAttempt++;
      if (installAttempt === 1) {
        await cancelGate;
        throw Object.assign(new Error("连接操作已取消或超时。"), { code: "connection_cancelled", status: 409 });
      }
      return { stdout: "设备已加入\n", stderr: "", output: "设备已加入\n", exitCode: 0 };
    });

    const ac = new AbortController();
    const first = cancelFixture.connector.add({ connectionId: CONNECTION_ID }, { signal: ac.signal });
    // Wait until installAttempt === 1 is reached
    await vi.waitFor(() => expect(installAttempt).toBe(1));
    expect(cancelFixture.connector.listOnboardingProgress()).toHaveLength(1);

    // Cancel hides progress immediately while unwind is still pending
    ac.abort();
    expect(cancelFixture.connector.listOnboardingProgress()).toEqual([]);

    // Start immediate retry while first is still unwinding — must wait instead of throwing 409 device_ssh_adding
    const retry = cancelFixture.connector.add({ connectionId: CONNECTION_ID });
    setTimeout(() => releaseCancelledInstall(), 40);

    await expect(first).rejects.toMatchObject({ code: "device_ssh_cancelled", status: 409 });
    expect(onAddFailed).toHaveBeenCalledWith("device-ssh-1", "设备接入已取消。");
    const retryRecord = await retry;
    expect(retryRecord.remotePort).toBe(42235);
    expect(cancelFixture.connector.listOnboardingProgress()).toEqual([]);
  });

  it("handles real peer-installer registry timeout fallback, silent optionalDep missing fallback, lock/cache skip, and stdin pipe", async () => {
    const { execFileSync, spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-peer-inst-"));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    // Build tiny real npm package tarballs
    const makeTarball = (pkgName: string, version: string, optionalDeps?: Record<string, string>) => {
      const stage = path.join(tmpRoot, "pkg-" + pkgName.replace(/[^a-z0-9]/gi, "_"));
      const pkgDir = path.join(stage, "package");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkgName, version, ...(optionalDeps ? { optionalDependencies: optionalDeps } : {}) }),
      );
      const tgzPath = path.join(tmpRoot, `${pkgName.replace(/[^a-z0-9]/gi, "_")}-${version}.tgz`);
      execFileSync("tar", ["-czf", tgzPath, "-C", stage, "package"]);
      const bytes = fs.readFileSync(tgzPath);
      const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
      return { bytes, integrity };
    };

    const optBinTgz = makeTarball("kulo-mock-bin", "1.0.0");
    const mainPkgTgz = makeTarball("kulo-mock-dep", "1.0.0", { "kulo-mock-bin": "1.0.0" });

    let reg1Mode: "stall-tarball" | "missing-optional" = "stall-tarball";
    const reg1Hits: string[] = [];
    const reg2Hits: string[] = [];
    const stalledResponses = new Set<http.ServerResponse>();

    const makeRegistryServer = (role: "reg1" | "reg2") => {
      const server = http.createServer((req, res) => {
        const hits = role === "reg1" ? reg1Hits : reg2Hits;
        const url = req.url ?? "/";
        hits.push(url);
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        if (url === "/probe.tgz") {
          // Make reg1 win the probe slightly faster so attempt 1 targets reg1
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/gzip" });
            res.end(mainPkgTgz.bytes);
          }, role === "reg1" ? 10 : 120);
          return;
        }
        if (url === "/kulo-mock-dep") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            name: "kulo-mock-dep",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                name: "kulo-mock-dep",
                version: "1.0.0",
                optionalDependencies: { "kulo-mock-bin": "1.0.0" },
                dist: { tarball: `${origin}/kulo-mock-dep/-/kulo-mock-dep-1.0.0.tgz`, integrity: mainPkgTgz.integrity },
              },
            },
          }));
          return;
        }
        if (url === "/kulo-mock-bin") {
          if (role === "reg1" && reg1Mode === "missing-optional") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            name: "kulo-mock-bin",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                name: "kulo-mock-bin",
                version: "1.0.0",
                dist: { tarball: `${origin}/kulo-mock-bin/-/kulo-mock-bin-1.0.0.tgz`, integrity: optBinTgz.integrity },
              },
            },
          }));
          return;
        }
        if (url === "/kulo-mock-dep/-/kulo-mock-dep-1.0.0.tgz") {
          if (role === "reg1" && reg1Mode === "stall-tarball") {
            stalledResponses.add(res);
            res.writeHead(200, { "content-type": "application/gzip", "content-length": String(mainPkgTgz.bytes.byteLength) });
            res.write(mainPkgTgz.bytes.subarray(0, 10));
            return;
          }
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(mainPkgTgz.bytes);
          return;
        }
        if (url === "/kulo-mock-bin/-/kulo-mock-bin-1.0.0.tgz") {
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(optBinTgz.bytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      return server;
    };

    const reg1 = makeRegistryServer("reg1");
    const reg2 = makeRegistryServer("reg2");
    const hubServer = http.createServer((req, res) => {
      if (req.url === "/connect/peer.mjs") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end('console.log("PEER_INSTALL_OK:" + process.argv.slice(2).join(" "));\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await Promise.all([
      new Promise<void>((r) => reg1.listen(0, "127.0.0.1", () => r())),
      new Promise<void>((r) => reg2.listen(0, "127.0.0.1", () => r())),
      new Promise<void>((r) => hubServer.listen(0, "127.0.0.1", () => r())),
    ]);
    cleanups.push(() => {
      for (const r of stalledResponses) r.destroy();
      reg1.close();
      reg2.close();
      hubServer.close();
    });

    const reg1Url = `http://127.0.0.1:${(reg1.address() as { port: number }).port}`;
    const reg2Url = `http://127.0.0.1:${(reg2.address() as { port: number }).port}`;
    const hubUrl = `http://127.0.0.1:${(hubServer.address() as { port: number }).port}`;

    const hostKey = process.platform === "linux"
      ? `linux-${process.arch}-${Boolean((process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime) ? "glibc" : "musl"}`
      : `${process.platform}-${process.arch}`;

    const script = renderPeerInstaller("posix", {
      deps: ["kulo-mock-dep@1.0.0"],
      optionalPlatformDeps: { [hostKey]: ["kulo-mock-bin@1.0.0"] },
      registries: [reg1Url, reg2Url],
      attemptTimeoutsMs: [2_500, 20_000],
      probePath: "probe.tgz",
      probeMinBytes: 64,
      probeTimeoutMs: 2_000,
    });

    const runInstaller = (homeDir: string, extraEnv: Record<string, string> = {}, viaStdin = false) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const scriptFile = path.join(homeDir, "install.sh");
        fs.mkdirSync(homeDir, { recursive: true });
        fs.writeFileSync(scriptFile, script, { mode: 0o700 });
        const args = viaStdin ? ["-s", "--", hubUrl, "test-invite-token"] : [scriptFile, hubUrl, "test-invite-token"];
        const child = realSpawn("/bin/sh", args, {
          env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            HOME: homeDir,
            npm_config_cache: path.join(homeDir, ".npm-cache"),
            ...extraEnv,
          },
          stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
        if (viaStdin) child.stdin!.end(script);
      });

    // 1. Stalled tarball on reg1 -> watchdog kills npm at 2.5s, cleans stale package-lock.json + staging dir, succeeds on reg2
    const home1 = path.join(tmpRoot, "home1");
    const rt1 = path.join(home1, ".kulo", "runtime");
    fs.mkdirSync(path.join(rt1, "node_modules", ".stale-pkg-abc123"), { recursive: true });
    fs.writeFileSync(path.join(rt1, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));

    const res1 = await runInstaller(home1, { KULO_INSTALL_PROGRESS: "1" });
    expect(res1.code, res1.stderr).toBe(0);
    expect(res1.stdout).toContain("KULO-INSTALL-STAGE:downloading-peer");
    expect(res1.stdout).toContain("KULO-INSTALL-STAGE:installing-deps");
    expect(res1.stdout).toContain("KULO-INSTALL-STAGE:pairing");
    expect(res1.stdout).toContain("PEER_INSTALL_OK:install --hub");
    expect(fs.existsSync(path.join(rt1, "package-lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(rt1, "node_modules", ".stale-pkg-abc123"))).toBe(false);
    expect(fs.existsSync(path.join(rt1, ".install.lock"))).toBe(false);
    expect(fs.existsSync(path.join(rt1, ".kulo-deps.json"))).toBe(true);
    expect(reg1Hits.some((u) => u.includes("kulo-mock-dep"))).toBe(true);
    expect(reg2Hits.some((u) => u.includes("kulo-mock-dep"))).toBe(true);

    // 2. Second run via stdin (`curl | sh -s --`) hits `.kulo-deps.json` cache with ZERO registry calls and quiet stdout (no KULO_INSTALL_PROGRESS)
    const reg1Before = reg1Hits.length;
    const reg2Before = reg2Hits.length;
    const res2 = await runInstaller(home1, {}, true);
    expect(res2.code, res2.stderr).toBe(0);
    expect(res2.stdout).not.toContain("KULO-INSTALL-STAGE:");
    expect(res2.stdout).toContain("PEER_INSTALL_OK:install --hub");
    expect(reg1Hits.length).toBe(reg1Before);
    expect(reg2Hits.length).toBe(reg2Before);

    // 3. Silent optionalDependency 404 on reg1 (npm exits 0 without kulo-mock-bin) -> verifyInstalled rejects and falls back to reg2!
    reg1Mode = "missing-optional";
    const reg2Before3 = reg2Hits.length;
    const home2 = path.join(tmpRoot, "home2");
    const res3 = await runInstaller(home2);
    expect(res3.code, res3.stderr).toBe(0);
    expect(reg2Hits.slice(reg2Before3).some((u) => u.includes("kulo-mock-bin"))).toBe(true);
    expect(fs.existsSync(path.join(home2, ".kulo", "runtime", "node_modules", "kulo-mock-bin", "package.json"))).toBe(true);
  }, 30_000);

  it("streams stdout lines and sends stdin EOF before SIGTERM in real captureSshProcess when keepStdinOpen is true", async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    mocks.spawn.mockImplementationOnce(realSpawn as never);
    const actualAuth = await vi.importActual<typeof import("../packages/hub/src/connection-ssh-auth.js")>(
      "../packages/hub/src/connection-ssh-auth.js",
    );
    const lines: string[] = [];
    const ac = new AbortController();
    let eofObserved = false;
    const childScript = [
      "process.stdin.resume();",
      "process.stdin.once('data', () => { process.stdout.write('KULO-INSTALL-STAGE:installing-deps\\n'); });",
      "process.stdin.once('end', () => { process.stdout.write('EOF_CLEAN_EXIT\\n'); process.exit(0); });",
    ].join("");
    const promise = actualAuth.captureSshProcess(process.execPath, ["-e", childScript], {
      timeoutMs: 10_000,
      input: "hello\n",
      rawInput: true,
      keepStdinOpen: true,
      signal: ac.signal,
      onStdoutLine: (line) => {
        lines.push(line);
        if (line === "KULO-INSTALL-STAGE:installing-deps") ac.abort();
        if (line === "EOF_CLEAN_EXIT") eofObserved = true;
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "connection_cancelled", status: 409 });
    expect(lines).toContain("KULO-INSTALL-STAGE:installing-deps");
    expect(eofObserved).toBe(true);
  });

  it("exposes sshOnboarding on GET /api/devices only to owner control and aborts POST /api/devices/ssh on client disconnect", async () => {
    const makeRes = () => {
      const ee = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        headers?: Record<string, string>;
        body?: string;
        destroyed: boolean;
        writableEnded: boolean;
        setTimeout: ReturnType<typeof vi.fn>;
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      ee.destroyed = false;
      ee.writableEnded = false;
      ee.setTimeout = vi.fn();
      ee.writeHead = vi.fn((status: number, headers: Record<string, string>) => { ee.statusCode = status; ee.headers = headers; });
      ee.end = vi.fn((chunk?: string) => { ee.body = chunk; ee.writableEnded = true; });
      return ee;
    };

    const progress = [{ connectionId: CONNECTION_ID, stage: "installing-deps" as const, startedAt: 100, updatedAt: 200 }];
    let capturedSignal: AbortSignal | undefined;
    let rejectAdd!: (err: Error) => void;
    const addPromise = new Promise<never>((_res, rej) => { rejectAdd = rej; });
    const sshDevices = {
      listOnboardingProgress: vi.fn(() => progress),
      add: vi.fn((_body: unknown, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        capturedSignal?.addEventListener("abort", () => {
          rejectAdd(Object.assign(new Error("设备接入已取消。"), { code: "device_ssh_cancelled", status: 409 }));
        });
        return addPromise;
      }),
      remove: vi.fn(),
    };
    const baseView = {
      enabled: true,
      role: "hub" as const,
      hubId: "hub-1",
      hubName: "Hub",
      currentDeviceId: "local",
      hubUrls: [],
      devices: [],
    };
    const sendJson = (res: ReturnType<typeof makeRes>, status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    const commonDeps = {
      devices: { enabled: true, remove: vi.fn(), recordSsh: vi.fn() },
      sshDevices,
      deviceView: () => baseView,
      getActualPort: () => 7788,
      isClusterActive: () => false,
    };

    // Owner GET /api/devices includes sshOnboarding
    const ownerRes = makeRes();
    const ownerHandled = await handleDevicesAndClusterRoutes(
      {
        req: Object.assign(new EventEmitter(), { method: "GET", aborted: false }),
        res: ownerRes,
        parsedUrl: new URL("http://127.0.0.1:7788/api/devices"),
        pathname: "/api/devices",
        authority: { hasOwnerHubControl: true },
        sendJson,
      } as never,
      commonDeps as never,
    );
    expect(ownerHandled).toBe(true);
    expect(JSON.parse(ownerRes.body ?? "{}").sshOnboarding).toEqual(progress);

    // Non-owner GET /api/devices omits sshOnboarding
    const guestRes = makeRes();
    await handleDevicesAndClusterRoutes(
      {
        req: Object.assign(new EventEmitter(), { method: "GET", aborted: false }),
        res: guestRes,
        parsedUrl: new URL("http://127.0.0.1:7788/api/devices"),
        pathname: "/api/devices",
        authority: { hasOwnerHubControl: false },
        sendJson,
      } as never,
      commonDeps as never,
    );
    expect(JSON.parse(guestRes.body ?? "{}").sshOnboarding).toBeUndefined();

    // POST /api/devices/ssh aborts signal when client socket closes before response ends
    const postReq = Object.assign(new EventEmitter(), { method: "POST", aborted: false });
    const postRes = makeRes();
    const routePromise = handleDevicesAndClusterRoutes(
      {
        req: postReq,
        res: postRes,
        parsedUrl: new URL("http://127.0.0.1:7788/api/devices/ssh"),
        pathname: "/api/devices/ssh",
        authority: { hasOwnerHubControl: true },
        readJsonBody: vi.fn().mockResolvedValue({ connectionId: CONNECTION_ID }),
        sendJson,
      } as never,
      commonDeps as never,
    );
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal!.aborted).toBe(false);
    postRes.destroyed = true;
    postRes.emit("close");
    expect(capturedSignal!.aborted).toBe(true);
    expect(await routePromise).toBe(true);
  });
});
