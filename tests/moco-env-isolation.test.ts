import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildWorkerSandboxProfile, EnvManager, MocoEnvAgent } from "@moco/env";
import { localDaemon } from "@earendil-works/pi-env";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const taskRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of taskRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-env-isolation-")));
  taskRoots.push(stateDir);
  const rootDir = path.join(stateDir, "workspace");
  const workspaceDir = path.join(rootDir, "table", "T-0001");
  const scratchDir = path.join(rootDir, "scratch", "T-0001");
  fs.mkdirSync(rootDir);
  const secretPath = path.join(stateDir, "router-secret.txt");
  fs.writeFileSync(secretPath, "private-memory-sentinel");
  return { stateDir, rootDir, workspaceDir, scratchDir, secretPath };
}

describe("Worker Env isolation", () => {
  it.skipIf(process.platform !== "darwin")("loads Node dynamic libraries without exposing private files to the runtime", async () => {
    const f = fixture();
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", f.workspaceDir, { scratchDir: f.scratchDir });
      const outsidePath = path.join(f.rootDir, "outside-write.txt");
      let output = "";
      const runtime = await env.exec(["node", "-e", `
        const fs = require('node:fs');
        const os = require('node:os');
        if (!os.hostname() || typeof os.networkInterfaces() !== 'object') process.exit(3);
        fs.writeFileSync('runtime.txt', 'node-runtime-loaded');
        for (const privatePath of [process.argv[1]]) {
          try { fs.readFileSync(privatePath); process.exit(2); }
          catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
        }
        try { fs.writeFileSync(process.argv[2], 'forbidden'); process.exit(4); }
        catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
        process.stdout.write(fs.readFileSync('runtime.txt', 'utf8'));
      `, f.secretPath, outsidePath], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(runtime.ok && runtime.value.exitCode === 0, JSON.stringify({ runtime, output })).toBe(true);
      expect(output).toBe("node-runtime-loaded");
      expect(fs.readFileSync(path.join(f.workspaceDir, "runtime.txt"), "utf8")).toBe("node-runtime-loaded");
      expect(fs.existsSync(outsidePath)).toBe(false);
      expect(fs.readFileSync(f.secretPath, "utf8")).toBe("private-memory-sentinel");
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("uses the real daemon sandbox for files, shell, symlinks, and inherited credentials", async () => {
    const f = fixture();
    vi.stubEnv("MOCO_HINDSIGHT_ROUTER_API_KEY", "router-canary-must-not-inherit");
    vi.stubEnv("MOCO_AUTH_TOKEN", "hub-canary-must-not-inherit");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/moco-private-agent-socket");
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", f.workspaceDir, { scratchDir: f.scratchDir });
      expect((await env.writeFile("shared.txt", "shared-memory", BACKGROUND_CONTEXT)).ok).toBe(true);
      expect(await env.readTextFile("shared.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "shared-memory" });

      const privateRead = await env.readTextFile(f.secretPath, BACKGROUND_CONTEXT);
      expect(privateRead.ok).toBe(false);
      if (!privateRead.ok) expect(privateRead.error.code).toBe("permission_denied");
      const dataVolumeAlias = `/System/Volumes/Data${f.secretPath}`;
      if (fs.existsSync(dataVolumeAlias)) expect((await env.readTextFile(dataVolumeAlias, BACKGROUND_CONTEXT)).ok).toBe(false);
      fs.symlinkSync(f.secretPath, path.join(f.workspaceDir, "private-link"));
      expect((await env.readTextFile("private-link", BACKGROUND_CONTEXT)).ok).toBe(false);

      let output = "";
      const directRead = await env.exec(["/bin/cat", f.secretPath], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(directRead.ok && directRead.value.exitCode !== 0).toBe(true);
      expect(output).not.toContain("private-memory-sentinel");

      output = "";
      const environment = await env.exec(["/usr/bin/env"], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(environment.ok && environment.value.exitCode === 0).toBe(true);
      expect(output).not.toMatch(/router-canary|hub-canary|SSH_AUTH_SOCK|MOCO_HINDSIGHT|MOCO_AUTH_TOKEN/);

      output = "";
      const processRead = await env.exec(["/bin/ps", "-p", String(process.pid)], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(processRead.ok ? processRead.value.exitCode : 1).not.toBe(0);
      expect(output).not.toContain("router-canary");
      expect((await env.writeFile(path.join(f.scratchDir, "notes.txt"), "scratch", BACKGROUND_CONTEXT)).ok).toBe(true);
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("accepts macOS /var aliases for task preparation without exposing sibling private files", async () => {
    const f = fixture();
    const aliasWorkspace = f.workspaceDir.replace(/^\/private\/var\//, "/var/");
    const aliasScratch = f.scratchDir.replace(/^\/private\/var\//, "/var/");
    const manager = new EnvManager({ localRootDir: f.rootDir.replace(/^\/private\/var\//, "/var/"), getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", aliasWorkspace, { scratchDir: aliasScratch });
      const mkdir = await env.createDir(aliasWorkspace, { recursive: true }, BACKGROUND_CONTEXT);
      expect(mkdir.ok, JSON.stringify(mkdir)).toBe(true);
      expect((await env.createDir(aliasScratch, { recursive: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
      expect((await env.writeFile(path.join(aliasWorkspace, "shared.txt"), "shared", BACKGROUND_CONTEXT)).ok).toBe(true);
      expect((await env.readTextFile(f.secretPath.replace(/^\/private\/var\//, "/var/"), BACKGROUND_CONTEXT)).ok).toBe(false);
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("keeps explicit private paths denied even when a task workspace contains them", async () => {
    const f = fixture();
    fs.mkdirSync(f.workspaceDir, { recursive: true });
    const nestedPrivate = path.join(f.workspaceDir, "credentials.json");
    const privateIdentity = path.join(f.rootDir, "private-identity");
    fs.writeFileSync(nestedPrivate, "nested-private-sentinel");
    fs.mkdirSync(privateIdentity);
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir, nestedPrivate, privateIdentity] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", f.workspaceDir);
      expect((await env.writeFile("normal.txt", "allowed", BACKGROUND_CONTEXT)).ok).toBe(true);
      expect((await env.readTextFile(nestedPrivate, BACKGROUND_CONTEXT)).ok).toBe(false);
      expect((await env.writeFile(nestedPrivate, "overwrite", BACKGROUND_CONTEXT)).ok).toBe(false);
      expect(() => manager.createWorkerExecutionEnv("local", path.join(privateIdentity, "subdir"))).toThrow("protected Hub data");
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("appends runtime protection and revokes already-running daemon access", async () => {
    const f = fixture();
    const runtimeDir = path.join(f.workspaceDir, "installed-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimeFile = path.join(runtimeDir, "main.js");
    fs.writeFileSync(runtimeFile, "runtime-file-canary");
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const originalEnv = manager.createWorkerExecutionEnv("local", f.workspaceDir);
      expect((await originalEnv.readTextFile(runtimeFile, BACKGROUND_CONTEXT)).ok).toBe(true);
      manager.protectPaths([runtimeDir, path.dirname(localDaemon())]);
      expect((await originalEnv.readTextFile(runtimeFile, BACKGROUND_CONTEXT)).ok).toBe(false);
      const updatedEnv = manager.createWorkerExecutionEnv("local", f.workspaceDir);
      expect((await updatedEnv.readTextFile(runtimeFile, BACKGROUND_CONTEXT)).ok).toBe(false);
      expect((await updatedEnv.writeFile(runtimeFile, "overwrite", BACKGROUND_CONTEXT)).ok).toBe(false);
      expect((await updatedEnv.readTextFile(f.secretPath, BACKGROUND_CONTEXT)).ok).toBe(false);
      expect((await updatedEnv.writeFile("shared.txt", "still-allowed", BACKGROUND_CONTEXT)).ok).toBe(true);
      manager.protectPaths([]);
      manager.protectPaths([runtimeDir]);
      expect(await updatedEnv.readTextFile("shared.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "still-allowed" });
      expect((await updatedEnv.readTextFile(runtimeFile, BACKGROUND_CONTEXT)).ok).toBe(false);
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("cannot rename protected runtime ancestors out of a writable task directory", () => {
    const f = fixture();
    const runtimeDir = path.join(f.workspaceDir, "installed-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const executable = path.join(runtimeDir, "native-tool");
    fs.writeFileSync(executable, "runtime-canary");
    const profile = buildWorkerSandboxProfile({ writablePaths: [f.workspaceDir], executable, protectedPaths: [runtimeDir], workspaceRoot: f.rootDir });
    const movedDir = path.join(f.workspaceDir, "moved-runtime");
    const move = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/mv", runtimeDir, movedDir], { encoding: "utf8" });
    expect(move.status).not.toBe(0);
    expect(fs.readFileSync(executable, "utf8")).toBe("runtime-canary");
    expect(fs.existsSync(movedDir)).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("blocks direct sysctl reads of a same-user host process environment", async () => {
    const f = fixture();
    fs.mkdirSync(f.workspaceDir, { recursive: true });
    const source = path.join(f.workspaceDir, "sysctl-canary.c");
    const executable = path.join(f.workspaceDir, "sysctl-canary");
    fs.writeFileSync(source, `
#include <sys/types.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 1) { sleep(30); return 0; }
  int mib[3] = { CTL_KERN, argc > 2 ? KERN_PROCARGS : KERN_PROCARGS2, atoi(argv[1]) };
  size_t length = 65536;
  char *buffer = calloc(1, length);
  const char *needle = "MOCO_ENV_ARG_CANARY_7";
  int result = sysctl(mib, 3, buffer, &length, NULL, 0);
  int visible = 0;
  if (result == 0) for (size_t i = 0; i + strlen(needle) <= length; i++) {
    if (memcmp(buffer + i, needle, strlen(needle)) == 0) visible = 1;
  }
  printf("result=%d errno=%d canary_visible=%d\\n", result, errno, visible);
  free(buffer);
  return 0;
}
`);
    const compile = spawnSync("/usr/bin/clang", [source, "-o", executable], { encoding: "utf8" });
    expect(compile.status, compile.stderr).toBe(0);
    // A locally compiled victim is deliberately used: SIP can hide the environment of system binaries even outside a sandbox.
    const victim = spawn(executable, [], { env: { PATH: "/usr/bin:/bin", MOCO_TEST_CANARY: "MOCO_ENV_ARG_CANARY_7" }, stdio: "ignore" });
    await once(victim, "spawn");
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const control = spawnSync(executable, [String(victim.pid)], { encoding: "utf8" });
      expect(control.status).toBe(0);
      expect(control.stdout).toContain("canary_visible=1");
      const env = manager.createWorkerExecutionEnv("local", f.workspaceDir);
      for (const args of [[String(victim.pid)], [String(victim.pid), "legacy"]]) {
        let output = "";
        const probe = await env.exec([executable, ...args], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
        expect(probe.ok && probe.value.exitCode === 0).toBe(true);
        expect(output).toContain("result=-1");
        expect(output).toContain("canary_visible=0");
      }
    } finally {
      victim.kill("SIGTERM");
      await once(victim, "exit");
      await manager.close();
    }
  });

  it("rejects unknown, unapproved, and out-of-root execution instead of falling back", async () => {
    const f = fixture();
    expect(() => new EnvManager({ envTokens: { one: "reused-node-token", two: "reused-node-token" } })).toThrow("unique node credential");
    const identities = new EnvManager({ envTokens: { one: "static-node-token" } });
    identities.setDeviceCredential("two", "paired-node-token");
    expect(identities.isNodeCredential("static-node-token")).toBe(true);
    expect(identities.isNodeCredential("paired-node-token")).toBe(true);
    expect(identities.isNodeCredential("unrecognized-token")).toBe(false);
    expect(() => identities.setDeviceCredential("three", "static-node-token")).toThrow("Invalid device credential");
    expect(() => identities.setDeviceCredential("three", "paired-node-token")).toThrow("Invalid device credential");
    const manager = new EnvManager({ localRootDir: f.rootDir });
    await manager.start();
    try {
      expect(() => manager.createWorkerExecutionEnv("unknown", f.workspaceDir)).toThrow("not been approved");
      if (process.platform === "darwin") {
        expect(() => manager.createWorkerExecutionEnv("local", f.stateDir)).toThrow("outside");
        expect(() => manager.createWorkerExecutionEnv("local", os.homedir())).toThrow("outside");
      } else {
        expect(() => manager.createWorkerExecutionEnv("local", f.workspaceDir)).toThrow("OS isolation");
      }
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("allows LAN diagnostics and local dev servers while blocking launchd SSH agent sockets and cross-sandbox signals", async () => {
    const f = fixture();
    fs.mkdirSync(f.workspaceDir, { recursive: true });
    const shortSockDir = fs.realpathSync(fs.mkdtempSync("/private/tmp/moco-sock-"));
    taskRoots.push(shortSockDir);
    const socketPath = path.join(shortSockDir, "dev.sock");
    const tcp = http.createServer((_req, response) => response.end("local-dev-service"));
    const unix = http.createServer((_req, response) => response.end("workspace-unix-service"));
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
    const fakeLaunchdDir = fs.realpathSync(fs.mkdtempSync("/private/tmp/com.apple.launchd.moco-test-"));
    taskRoots.push(fakeLaunchdDir);
    const launchdListener = path.join(fakeLaunchdDir, "Listeners");
    const sshAgentMock = http.createServer((_req, response) => response.end("private-ssh-agent-canary"));
    await new Promise<void>((resolve) => sshAgentMock.listen(launchdListener, resolve));
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", f.workspaceDir);
      for (const [cmd, args] of [
        ["/sbin/ifconfig", ["-aL"]],
        ["/usr/sbin/arp", ["-a", "-n"]],
        ["/sbin/ping", ["-c", "1", "-W", "500", "127.0.0.1"]],
        ["/usr/sbin/netstat", ["-anv", "-p", "tcp"]],
      ] as const) {
        let diagOut = "";
        const diag = await env.exec([cmd, ...args], { timeout: 5, onOutput: (chunk) => { diagOut += chunk; } }, BACKGROUND_CONTEXT);
        expect(diag.ok && diag.value.exitCode === 0, JSON.stringify({ cmd, diag, diagOut: diagOut.slice(0, 200) })).toBe(true);
      }

      let output = "";
      const tcpRequest = await env.exec(["/usr/bin/curl", "--silent", "--noproxy", "*", "--show-error", "--max-time", "3", `http://127.0.0.1:${(tcp.address() as { port: number }).port}`], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(tcpRequest.ok && tcpRequest.value.exitCode === 0, JSON.stringify({ result: tcpRequest, output })).toBe(true);
      expect(output).toBe("local-dev-service");

      output = "";
      const unixRequest = await env.exec(["/usr/bin/curl", "--silent", "--max-time", "3", "--unix-socket", socketPath, "http://localhost/"], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(unixRequest.ok && unixRequest.value.exitCode === 0, JSON.stringify({ result: unixRequest, output })).toBe(true);
      expect(output).toBe("workspace-unix-service");

      output = "";
      const sshAgentAttempt = await env.exec(["/usr/bin/curl", "--silent", "--max-time", "2", "--unix-socket", launchdListener, "http://localhost/"], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(sshAgentAttempt.ok ? sshAgentAttempt.value.exitCode : 1).not.toBe(0);
      expect(output).not.toContain("private-ssh-agent-canary");

      const hostSignal = await env.exec(["/bin/kill", "-0", String(process.pid)], {}, BACKGROUND_CONTEXT);
      expect(hostSignal.ok ? hostSignal.value.exitCode : 1).not.toBe(0);
    } finally {
      await manager.close();
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => unix.close(() => resolve())),
        new Promise<void>((resolve) => sshAgentMock.close(() => resolve())),
      ]);
    }
  });

  it.skipIf(process.platform !== "darwin")("provides a usable development PORT and allows multi-service ephemeral local ports", async () => {
    const f = fixture();
    fs.mkdirSync(f.workspaceDir, { recursive: true });
    const source = path.join(f.workspaceDir, "development-port.c");
    const executable = path.join(f.workspaceDir, "development-port");
    fs.writeFileSync(source, `
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
int main(int argc, char **argv) {
  int port = atoi(argc > 1 ? argv[1] : getenv("PORT"));
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(port) };
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  if (bind(fd, (void *)&address, sizeof(address)) != 0) { printf("BIND_DENIED:%d\\n", errno); return 1; }
  if (argc > 1) { puts("BIND_ALLOWED"); close(fd); return 0; }
  if (listen(fd, 2) != 0) return 2;
  printf("DEV_READY:%d\\n", port); fflush(stdout);
  const char *reply = "HTTP/1.1 200 OK\\r\\nContent-Length: 18\\r\\nConnection: close\\r\\n\\r\\ndevelopment-canary";
  for (int i = 0; i < 2; i++) {
    int client = accept(fd, NULL, NULL); if (client < 0) return 3;
    char request[4096]; read(client, request, sizeof(request)); write(client, reply, strlen(reply)); close(client);
  }
  close(fd); return 0;
}
`);
    const compile = spawnSync("/usr/bin/clang", [source, "-o", executable], { encoding: "utf8" });
    expect(compile.status, compile.stderr).toBe(0);
    const manager = new EnvManager({ localRootDir: f.rootDir, getProtectedPaths: () => [f.stateDir] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", f.workspaceDir);
      let extraOut = "";
      const extraBind = await env.exec([executable, "0"], { onOutput: (chunk) => { extraOut += chunk; } }, BACKGROUND_CONTEXT);
      expect(extraBind.ok && extraBind.value.exitCode === 0, extraOut).toBe(true);
      expect(extraOut).toContain("BIND_ALLOWED");

      let developmentPort = 0;
      let ready!: () => void;
      const listening = new Promise<void>((resolve) => { ready = resolve; });
      const server = env.exec([executable], { timeout: 5, onOutput: (chunk) => {
        const match = /DEV_READY:(\d+)/.exec(chunk);
        if (match) { developmentPort = Number(match[1]); ready(); }
      } }, BACKGROUND_CONTEXT);
      await Promise.race([listening, server.then((result) => { throw new Error(`Development server stopped before listening: ${JSON.stringify(result)}`); })]);
      expect(await (await fetch(`http://127.0.0.1:${developmentPort}/`)).text()).toBe("development-canary");
      let output = "";
      const inspect = await env.exec(["/usr/bin/curl", "--silent", "--noproxy", "*", "--max-time", "2", `http://127.0.0.1:${developmentPort}/`], { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
      expect(inspect.ok && inspect.value.exitCode === 0).toBe(true);
      expect(output).toBe("development-canary");
      const finished = await server;
      expect(finished.ok && finished.value.exitCode === 0).toBe(true);
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("binds remote credentials to one node and applies the same file sandbox over WebSocket", async () => {
    const f = fixture();
    const manager = new EnvManager({
      enableLocal: false,
      authToken: "management-canary",
      envTokens: { "isolated-mac": "env-node-canary" },
      workerEnvIds: ["isolated-mac"],
      getProtectedPaths: () => [f.stateDir],
    });
    await manager.start();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => manager.handleEnvWebSocket(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    const agent = new MocoEnvAgent({ hubUrl: url, envId: "isolated-mac", rootDir: f.rootDir, authToken: "env-node-canary", reconnect: false });
    try {
      const rejected = async (envId: string, token: string) => {
        const socket = new WebSocket(url);
        socket.on("open", () => socket.send(JSON.stringify({ type: "env.register", envId, token, rootDir: f.rootDir, name: envId, platform: "darwin", arch: "arm64", capabilities: ["fs", "bash", "isolated"] })));
        return new Promise<number>((resolve, reject) => {
          socket.on("close", (code) => resolve(code));
          socket.on("error", reject);
        });
      };
      expect(await rejected("isolated-mac", "management-canary")).toBe(4001);
      expect(await rejected("different-node", "env-node-canary")).toBe(4001);
      await agent.start();
      expect(manager.pickDefaultWorkerEnvId()).toBe("isolated-mac");
      const env = manager.createWorkerExecutionEnv("isolated-mac", f.workspaceDir, { scratchDir: f.scratchDir });
      expect((await env.writeFile("shared.txt", "remote-shared", BACKGROUND_CONTEXT)).ok).toBe(true);
      expect((await env.readTextFile(f.secretPath, BACKGROUND_CONTEXT)).ok).toBe(false);
      fs.symlinkSync(f.secretPath, path.join(f.workspaceDir, "private-link"));
      expect((await env.readTextFile("private-link", BACKGROUND_CONTEXT)).ok).toBe(false);
      await agent.stop();
      await vi.waitFor(() => expect(manager.getEnvDescriptor("isolated-mac")?.online).toBe(false));
      expect(() => manager.createWorkerExecutionEnv("isolated-mac", f.workspaceDir)).toThrow("offline");
    } finally {
      await agent.stop();
      await manager.close();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    }
  });
});
