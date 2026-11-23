import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionRecordView } from "@kulo/protocol";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import { LocalConnectionExecutor } from "../packages/hub/src/connection-execution.js";
import { classifySshExecutionFailure, isLocalNetworkHost } from "../packages/hub/src/connection-ssh-diagnostics.js";

const directories: string[] = [];
const connectionId = "connection-00000000-0000-4000-8000-000000000001";
function card(extra: Partial<ConnectionRecordView> = {}): ConnectionRecordView {
  return { id: connectionId, name: "测试 API", kind: "api-key", url: "https://api.example.test/v1", authType: "bearer", revision: 1,
    status: "saved", hasCredential: true, secretFields: ["apiKey"], createdAt: 1, updatedAt: 1, ...extra };
}
function fixture(fetcher?: typeof fetch) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-exec-")); directories.push(stateDir);
  return { stateDir, executor: new LocalConnectionExecutor({ stateDir, fetch: fetcher }) };
}
afterEach(() => { spawnMock.mockReset(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("trusted connection HTTP execution", () => {
  it("delegates preset applications through their fixed adapter without exposing HTTP or shell execution", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-application-exec-")); directories.push(stateDir);
    const applications = { probe: vi.fn(async () => ({})), execute: vi.fn(async () => ({ kind: "app" as const, output: '{"messages":[]}' })) };
    const fetcher = vi.fn() as unknown as typeof fetch;
    const executor = new LocalConnectionExecutor({ stateDir, applications, fetch: fetcher });
    const application = card({ kind: "app", category: "app", appId: "messages", name: "消息", hasCredential: false, secretFields: [] });
    const operation = { kind: "app" as const, action: "list", params: { limit: 10 } };
    const signal = new AbortController().signal;
    expect(await executor.execute(application, {}, operation, signal)).toMatchObject({ kind: "app" });
    expect(applications.execute).toHaveBeenCalledWith("messages", {}, operation, signal);
    await expect(executor.execute(application, {}, { kind: "http", path: "/" })).rejects.toThrow("应用");
    await expect(executor.execute(card(), {}, operation)).rejects.toThrow("预置应用");
    expect(fetcher).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("injects the credential only at the configured origin and refuses redirects", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const f = fixture(fetcher), connection = card();
    const result = await f.executor.execute(connection, { apiKey: "synthetic-api-key" }, { kind: "http", path: "/v1/builds" });
    expect(result).toEqual({ kind: "http", status: 200, output: "ok" });
    const [url, options] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/v1/builds");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer synthetic-api-key");
    for (const candidate of ["https://attacker.example.test/", "//attacker.example.test/", "/\\attacker.example.test/", "/bad\npath"]) {
      await expect(f.executor.execute(connection, { apiKey: "synthetic-api-key" }, { kind: "http", path: candidate })).rejects.toThrow();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("supports scoped header keys and basic accounts without accepting caller authentication overrides", async () => {
    const fetcher = vi.fn(async () => new Response("ok")) as unknown as typeof fetch, f = fixture(fetcher);
    await f.executor.execute(card({ authType: "header", headerName: "X-API-Key" }), { apiKey: "synthetic-header-key" }, { kind: "http", path: "/" });
    expect(new Headers(vi.mocked(fetcher).mock.calls[0]![1]?.headers).get("X-API-Key")).toBe("synthetic-header-key");
    await f.executor.execute(card({ kind: "account", username: "person", authType: "basic" }), { password: "synthetic-password" }, { kind: "http", path: "/profile" });
    expect(new Headers(vi.mocked(fetcher).mock.calls[1]![1]?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("person:synthetic-password").toString("base64")}`);
    await expect(f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/", headers: { Authorization: "Bearer override" } })).rejects.toThrow();
    await expect(f.executor.execute(card({ authType: "header", headerName: "Host" }), { apiKey: "synthetic-key" }, { kind: "http", path: "/" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds response data, preserves status, and sanitizes transport error messages", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(200_000), { status: 401 })) as unknown as typeof fetch, f = fixture(fetcher);
    const result = await f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/" });
    expect(result.output).toHaveLength(128_000);
    expect(result.status).toBe(401);
    vi.mocked(fetcher).mockRejectedValueOnce(new Error("provider echoed synthetic-key"));
    await expect(f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/" })).rejects.toThrow("连接请求未完成");
  });
  it("sets JSON and text body defaults while preserving an explicit form content type", async () => {
    const fetcher = vi.fn(async () => new Response("ok")) as unknown as typeof fetch, f = fixture(fetcher);
    await f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/issues", method: "POST", body: JSON.stringify({ title: "Example" }) });
    await f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/notes", method: "POST", body: "plain-text note" });
    await f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/forms", method: "POST", body: "name=example&state=ready", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(new Headers(vi.mocked(fetcher).mock.calls[0]![1]?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(vi.mocked(fetcher).mock.calls[1]![1]?.headers).get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(new Headers(vi.mocked(fetcher).mock.calls[2]![1]?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
  });
  it("propagates revocation through the AbortSignal and rejects malformed request bodies", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn(async (_url, options) => { options?.signal?.throwIfAborted(); return new Response("ok"); }) as unknown as typeof fetch;
    const f = fixture(fetcher);
    await expect(f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/" }, controller.signal)).rejects.toThrow();
    await expect(f.executor.execute(card(), { apiKey: "synthetic-key" }, { kind: "http", path: "/", body: "not allowed for GET" })).rejects.toThrow();
  });
  it("does not infer an HTTP authentication adapter for custom credentials", async () => {
    const fetcher = vi.fn(async () => new Response("should not run")) as unknown as typeof fetch, f = fixture(fetcher);
    await expect(f.executor.execute(card({ kind: "custom" }), { tenantCode: "opaque-tenant", proof: "opaque-proof" }, { kind: "http", path: "/" })).rejects.toMatchObject({ code: "connection_adapter_unavailable" });
    await expect(f.executor.execute(card({ kind: "custom" }), { password: "opaque-password" }, { kind: "ssh", command: "exit 0" })).rejects.toMatchObject({ code: "connection_adapter_unavailable" });
    expect(fetcher).not.toHaveBeenCalled(); expect(spawnMock).not.toHaveBeenCalled();
  });
});

function fakeChild(binary: string, _args: string[], options: { stdio: unknown[] }) {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; stdio: Array<PassThrough | null>; kill: ReturnType<typeof vi.fn> };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr];
  if (binary === "ssh-agent") {
    const server = net.createServer();
    server.listen(_args[2]);
    child.kill = vi.fn(() => { server.close(() => child.emit("close", 0)); return true; });
    return child;
  }
  child.kill = vi.fn(() => { setImmediate(() => child.emit("close", 1)); return true; });
  setImmediate(() => {
    child.stdout.end(binary === "ssh-keyscan" ? `server.example.test ssh-ed25519 ${Buffer.from("synthetic-public-host-key").toString("base64")}\n` : binary === "ssh-add" && _args[0] === "-L" ? `ssh-ed25519 ${Buffer.from("synthetic-public-key").toString("base64")}\n` : "done\n");
    child.emit("close", 0);
  });
  return child;
}

describe("trusted connection SSH execution", () => {
  it("requires a stored host key and loads a private key through stdin into an isolated short-lived agent", async () => {
    const f = fixture(), connection = card({ kind: "ssh", host: "server.example.test", port: 2222, username: "kulo", url: undefined });
    spawnMock.mockImplementation(fakeChild);
    await expect(f.executor.execute(connection, { privateKey: "synthetic-private-key" }, { kind: "ssh", command: "true" })).rejects.toMatchObject({ code: "connection_host_untrusted" });
    const scan = await f.executor.scan(connection);
    expect(scan.fingerprint).toContain("ssh-ed25519 SHA256:");
    await f.executor.trust(connection, scan);
    const result = await f.executor.execute(connection, { privateKey: "synthetic-private-key", passphrase: "synthetic-passphrase" }, { kind: "ssh", command: "true" });
    expect(result.exitCode).toBe(0);
    const invocation = spawnMock.mock.calls.find(([binary]) => binary === "ssh")!;
    const args = invocation[1] as string[], options = invocation[2] as { env: Record<string, string>; stdio: unknown[] };
    expect(args).toEqual(expect.arrayContaining(["ForwardAgent=no", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "IdentitiesOnly=yes"]));
    expect(args.some((arg) => /^IdentityAgent=(?:\/private)?\/tmp\/kulo-connection-[^/]+\/agent\.sock$/.test(arg))).toBe(true);
    expect(JSON.stringify({ args, environment: options.env })).not.toContain("synthetic-private-key");
    expect(JSON.stringify({ args, environment: options.env })).not.toContain("synthetic-passphrase");
    expect(spawnMock.mock.calls.filter(([binary]) => binary === "ssh-agent")).toHaveLength(1);
    expect(spawnMock.mock.calls.filter(([binary]) => binary === "ssh-add")).toHaveLength(2);
    for (const filename of fs.readdirSync(path.join(f.stateDir, "connection-runtime"))) {
      const file = path.join(f.stateDir, "connection-runtime", filename);
      expect(fs.statSync(file).isFile()).toBe(true);
      const contents = fs.readFileSync(file, "utf8");
      expect(contents).not.toContain("synthetic-private-key"); expect(contents).not.toContain("synthetic-passphrase");
    }
  });
  it("keeps password injection out of the child environment and disables ambient personal SSH identities", async () => {
    const f = fixture(), connection = card({ kind: "ssh", host: "server.example.test", username: "kulo", url: undefined });
    spawnMock.mockImplementation(fakeChild);
    await f.executor.trust(connection, await f.executor.scan(connection));
    await f.executor.execute(connection, { password: "synthetic-ssh-password" }, { kind: "ssh", command: "true" });
    const invocation = spawnMock.mock.calls.find(([binary]) => binary === "ssh")!;
    expect(JSON.stringify(invocation.slice(1))).not.toContain("synthetic-ssh-password");
    expect(invocation[1]).toEqual(expect.arrayContaining(["PreferredAuthentications=password", "PubkeyAuthentication=no", "KbdInteractiveAuthentication=no", "/dev/null"]));
    expect(invocation[2].env.SSH_AUTH_SOCK).toBeUndefined();
  });
  it("quotes UserKnownHostsFile, escapes percent tokens, pins LogLevel=ERROR and LC_ALL=C, and avoids leaking stdout/stderr on execute()", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-exec-")); directories.push(root);
    const stateDir = path.join(root, "Application Support", "Kulo Dev %h", "hub");
    fs.mkdirSync(stateDir, { recursive: true });
    const executor = new LocalConnectionExecutor({ stateDir, platform: "darwin" });
    const connection = card({ kind: "ssh", host: "10.0.0.10", username: "kulo", url: undefined });
    spawnMock.mockImplementation(fakeChild);
    const scan = await executor.scan(connection);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-T", "5", "-p", "22", "--", "10.0.0.10"]);
    await executor.trust(connection, scan);
    expect(executor.hasTrustedHost(connection, scan.fingerprint)).toBe(true);
    expect(executor.hasTrustedHost(connection, "ssh-ed25519 SHA256:different")).toBe(false);
    const execResult = await executor.execute(connection, { password: "synthetic-ssh-password" }, { kind: "ssh", command: "exit 0" });
    expect(Object.keys(execResult).sort()).toEqual(["exitCode", "kind", "output"]);
    const invocation = spawnMock.mock.calls.find(([binary]) => binary === "ssh")!;
    const expectedPath = path.join(stateDir, "connection-runtime", `${connection.id}.known-hosts`);
    expect(invocation[1]).toEqual(expect.arrayContaining([
      `UserKnownHostsFile="${expectedPath.replaceAll("%", "%%")}"`,
      "LogLevel=ERROR",
    ]));
    expect(invocation[2].env).toMatchObject({ LC_ALL: "C", LANG: "C" });
    executor.clearTrustedHost(connection);
    expect(executor.hasTrustedHost(connection, scan.fingerprint)).toBe(false);
  });
  it("normalizes CRLF OpenSSH private keys before piping to ssh-add and isolates ssh-keyscan stdout from stderr", async () => {
    const f = fixture(), connection = card({ kind: "ssh", host: "server.example.test", username: "kulo", url: undefined });
    const receivedInputs: string[] = [];
    spawnMock.mockImplementation((binary: string, args: string[], options: { stdio: unknown[] }) => {
      const child = fakeChild(binary, args, options);
      if (binary === "ssh-keyscan") {
        child.removeAllListeners("close");
        setImmediate(() => {
          child.stderr.end("# server.example.test:22 SSH-2.0-OpenSSH_10.2\nserver.example.test ssh-rsa BOGUS_STDERR_KEY\n");
          child.stdout.end(`server.example.test ssh-ed25519 ${Buffer.from("synthetic-public-host-key").toString("base64")}\n`);
          child.emit("close", 0);
        });
      }
      if (binary === "ssh-add" && args.includes("-")) {
        let collected = "";
        child.stdin.on("data", (chunk) => { collected += chunk.toString("utf8"); });
        child.stdin.on("end", () => { receivedInputs.push(collected); });
      }
      return child;
    });
    const scan = await f.executor.scan(connection);
    expect(scan.lines).toHaveLength(1);
    expect(scan.lines[0]).toContain("ssh-ed25519");
    await f.executor.trust(connection, scan);
    await f.executor.execute(
      connection,
      { privateKey: "  -----BEGIN OPENSSH PRIVATE KEY-----\r\nZmFrZS1rZXk=\r\n-----END OPENSSH PRIVATE KEY-----\r\n\r\n" },
      { kind: "ssh", command: "true" },
    );
    expect(receivedInputs).toEqual(["-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n"]);
  });
  it("classifies macOS local network scan blocks across LAN host forms regardless of runner OS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-exec-")); directories.push(root);
    const darwinExec = new LocalConnectionExecutor({ stateDir: root, platform: "darwin" });
    const linuxExec = new LocalConnectionExecutor({ stateDir: root, platform: "linux" });
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; stdio: Array<PassThrough | null>; kill: ReturnType<typeof vi.fn> };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdio = [child.stdin, child.stdout, child.stderr];
      child.kill = vi.fn(() => true);
      setImmediate(() => { child.stdout.end(""); child.stderr.end(""); child.emit("close", 1); });
      return child;
    });
    for (const lanHost of ["10.0.0.10", "::ffff:10.0.0.10", "kulostation", "nas.lan", "macmini.local"]) {
      expect(isLocalNetworkHost(lanHost)).toBe(true);
      await expect(darwinExec.scan(card({ kind: "ssh", host: lanHost, username: "kulo", url: undefined }))).rejects.toMatchObject({
        code: "connection_local_network_blocked",
      });
      await expect(linuxExec.scan(card({ kind: "ssh", host: lanHost, username: "kulo", url: undefined }))).rejects.toMatchObject({
        code: "connection_host_scan_failed",
      });
    }
    expect(isLocalNetworkHost("localhost")).toBe(false);
    await expect(darwinExec.scan(card({ kind: "ssh", host: "203.0.113.10", username: "kulo", url: undefined }))).rejects.toMatchObject({
      code: "connection_host_scan_failed",
    });
    await expect(darwinExec.scan(card({ kind: "ssh", host: "-oProxyCommand=evil", username: "kulo", url: undefined }))).rejects.toThrow("SSH 主机地址");
  });
  it("classifies sanitized SSH execution failures from stderr without leaking raw diagnostics", () => {
    expect(classifySshExecutionFailure({ exitCode: 255, stderr: "@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", host: "10.0.0.10", platform: "darwin" })).toMatchObject({
      code: "connection_host_mismatch", hostMismatch: true,
    });
    expect(classifySshExecutionFailure({ exitCode: 255, stderr: "ssh: connect to host 10.0.0.10 port 22: No route to host", host: "10.0.0.10", platform: "darwin" })).toMatchObject({
      code: "connection_local_network_blocked",
    });
    expect(classifySshExecutionFailure({ exitCode: 255, stderr: "ssh: Could not resolve hostname bad.host: nodename nor servname provided", host: "bad.host", platform: "darwin" })).toMatchObject({
      code: "connection_execution_failed", message: expect.stringContaining("无法解析"),
    });
    expect(classifySshExecutionFailure({ exitCode: 255, stderr: "demo@10.0.0.10: Permission denied (publickey).", host: "10.0.0.10", authMethod: "password", platform: "darwin" })).toMatchObject({
      code: "connection_auth_failed", message: expect.stringContaining("未开启 SSH 密码登录"),
    });
    expect(classifySshExecutionFailure({ exitCode: 255, stderr: "demo@10.0.0.10: Permission denied (publickey,password).", host: "10.0.0.10", authMethod: "password", platform: "darwin" })).toMatchObject({
      code: "connection_auth_failed", message: expect.stringContaining("认证未通过"),
    });
    expect(classifySshExecutionFailure({ exitCode: 1, stderr: "Permission denied (publickey)", host: "10.0.0.10", platform: "darwin" })).toMatchObject({
      code: "connection_execution_failed",
    });
    expect(classifySshExecutionFailure({ exitCode: 255, stderr: "Error: remote port forwarding failed for listen port 43120", host: "10.0.0.10", platform: "darwin" })).toMatchObject({
      code: "connection_execution_failed", message: expect.stringContaining("转发端口"),
    });
  });
  it("rejects a symlinked runtime directory before trusting a host", async () => {
    const f = fixture(), connection = card({ kind: "ssh", host: "server.example.test", username: "kulo", url: undefined });
    const target = path.join(f.stateDir, "outside"); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(f.stateDir, "connection-runtime"), "dir");
    spawnMock.mockImplementation(fakeChild);
    const scan = await f.executor.scan(connection);
    await expect(f.executor.trust(connection, scan)).rejects.toMatchObject({ code: "connection_storage_invalid" });
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it("cleans up temporary directory and kills ssh-agent when ssh-add fails inside prepareSshAuthSession", async () => {
    const { prepareSshAuthSession } = await import("../packages/hub/src/connection-ssh-auth.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-connection-auth-fail-"));
    directories.push(root);
    const knownHostsPath = path.join(root, "trusted.known-hosts");
    fs.writeFileSync(knownHostsPath, "192.0.2.50 ssh-ed25519 AAAA\n");
    let createdSocketDir = "";
    let agentKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementation((binary: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; stdio: Array<PassThrough | null>; kill: ReturnType<typeof vi.fn>; exitCode: number | null; killed: boolean };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdio = [child.stdin, child.stdout, child.stderr];
      child.exitCode = null;
      child.killed = false;
      child.kill = vi.fn(() => {
        child.killed = true;
        child.exitCode = 0;
        queueMicrotask(() => child.emit("close", 0));
        return true;
      });
      if (binary === "ssh-agent") {
        const sockArg = args[args.indexOf("-a") + 1] ?? "";
        createdSocketDir = path.dirname(sockArg);
        agentKill = child.kill;
        fs.writeFileSync(sockArg, "");
      } else if (binary === "ssh-add") {
        setImmediate(() => {
          child.stdout.end("");
          child.stderr.end("Error loading key\n");
          child.emit("close", 1);
        });
      }
      return child;
    });
    await expect(
      prepareSshAuthSession({
        host: "192.0.2.50",
        port: 22,
        username: "demo",
        secrets: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n" },
        knownHostsPath,
        forwardingMode: "none",
        timeoutMs: 10_000,
        platform: "darwin",
      }),
    ).rejects.toMatchObject({ code: "connection_key_invalid" });
    expect(createdSocketDir).toContain("kulo-connection-");
    expect(fs.existsSync(createdSocketDir)).toBe(false);
    expect(agentKill).toHaveBeenCalledWith("SIGTERM");
  });
});
