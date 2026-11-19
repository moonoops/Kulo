import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection } from "@earendil-works/pi-env";
import { EnvManager, KuloEnvAgent, ProjectDirectoryRegistry, createWorkerSandbox } from "@kulo/env";
import WebSocket, { WebSocketServer } from "ws";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { cleanupRecordedExecutions, processFingerprint } from "../packages/env/src/worker-supervisor.js";
import { ProjectDirectoryUnavailableError } from "../packages/env/src/project-directories.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-env-")));
  roots.push(root);
  const envRoot = path.join(root, "env");
  const project = path.join(root, "existing project 中文");
  const privateDir = path.join(root, "private");
  for (const directory of [envRoot, project, privateDir]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(project, "source.txt"), "original");
  fs.writeFileSync(path.join(privateDir, "secret.txt"), "private-canary");
  const options = { deviceId: "device", filePath: path.join(envRoot, ".kulo-env", "project-grants.json"), scratchRoot: path.join(envRoot, "scratch"), getProtectedPaths: () => [privateDir] };
  return { root, envRoot, project, privateDir, options };
}

describe("project directory authorization", () => {
  it("persists arbitrary project grants and validates same-revision receipts without reviving revoked grants", () => {
    const f = fixture();
    const registry = new ProjectDirectoryRegistry(f.options);
    const input = { projectId: "project-one", path: f.project, operationId: "create-one", revision: 1 };
    const first = registry.authorize(input);
    expect(first.workspaceDir).toBe(f.project);
    expect(first.scratchRoot).toBe(f.options.scratchRoot);
    expect(registry.authorize({ ...input, operationId: "verify-one" })).toEqual(first);
    const reopened = new ProjectDirectoryRegistry(f.options);
    expect(reopened.authorize(input)).toEqual(first);
    expect(reopened.validate("project-one", f.project, 1)).toEqual(first);
    reopened.revoke("project-one");
    expect(() => reopened.authorize(input)).toThrow("stale");
    expect(() => reopened.authorize({ ...input, operationId: "stale-regrant" })).toThrow("increase");
    expect(reopened.authorize({ ...input, operationId: "restore-one", revision: 2 }).revision).toBe(2);
    expect(() => reopened.validate("project-one", f.project, 1)).toThrow("stale");
  });

  it("rejects protected roots, duplicate aliases, changed directories and legacy access to registered projects", () => {
    const f = fixture();
    const registry = new ProjectDirectoryRegistry(f.options);
    expect(() => registry.authorize({ projectId: "private", operationId: "private", path: f.privateDir })).toThrow("protected");
    expect(() => registry.authorize({ projectId: "root", operationId: "root", path: path.parse(f.root).root })).toThrow("root");
    expect(() => registry.authorize({ projectId: "home", operationId: "home", path: os.homedir() })).toThrow("home");
    const grant = registry.authorize({ projectId: "one", operationId: "one", path: f.project });
    const alias = path.join(f.root, "alias");
    fs.symlinkSync(f.project, alias, "dir");
    expect(() => registry.authorize({ projectId: "two", operationId: "two", path: alias })).toThrow("already");
    expect(() => registry.assertUnregistered(alias)).toThrow("explicit project");
    expect(() => registry.assertUnregistered(f.root)).toThrow("explicit project");
    expect(() => registry.validateScratch(path.join(f.root, "outside-scratch"))).toThrow("scratch");
    fs.renameSync(f.project, path.join(f.root, "moved"));
    fs.mkdirSync(f.project);
    expect(() => registry.validate("one", f.project, grant.revision)).toThrow(ProjectDirectoryUnavailableError);
    expect(() => registry.authorize({ projectId: "one", operationId: "verify-replaced", path: f.project, revision: grant.revision })).toThrow(ProjectDirectoryUnavailableError);
  });

  it("lists directories on the target and creates directories without replacing files", () => {
    const f = fixture();
    const registry = new ProjectDirectoryRegistry(f.options);
    const listing = registry.list(f.root);
    expect(listing.deviceId).toBe("device");
    expect(listing.entries.map((entry) => entry.name)).toContain(path.basename(f.project));
    expect(listing.entries.map((entry) => entry.name)).not.toContain("private");
    const directory = path.join(f.root, "new-project");
    expect(() => registry.authorize({ projectId: "missing", operationId: "missing", path: directory })).toThrow(ProjectDirectoryUnavailableError);
    const grant = registry.authorize({ projectId: "new", operationId: "new", path: directory, create: true });
    expect(fs.statSync(grant.workspaceDir).isDirectory()).toBe(true);
    const file = path.join(f.root, "file");
    fs.writeFileSync(file, "keep");
    expect(() => registry.authorize({ projectId: "file", operationId: "file", path: file, create: true })).toThrow("directory");
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
  });
});

describe("isolated Worker device readiness", () => {
  it("keeps an authenticated legacy device online while refusing Worker execution without an isolation capability", async () => {
    const f = fixture();
    const manager = new EnvManager({ enableLocal: false, workerEnvIds: ["legacy"], envTokens: { legacy: "test-legacy-node" } });
    await manager.start();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => manager.handleEnvWebSocket(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const node = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      await once(node, "open");
      const registered = once(node, "message");
      node.send(JSON.stringify({ type: "env.register", envId: "legacy", name: "Legacy test device", token: "test-legacy-node", rootDir: f.envRoot, platform: process.platform, arch: process.arch, capabilities: ["fs", "bash"] }));
      await registered;
      expect(manager.getEnvDescriptor("legacy")?.online).toBe(true);
      expect(() => manager.pickDefaultWorkerEnvId()).toThrow("No isolated Worker Env");
      expect(() => manager.createWorkerExecutionEnv("legacy", f.project)).toThrow("isolation backend");
    } finally {
      if (node.readyState !== WebSocket.CLOSED) { const closed = once(node, "close"); node.close(); await closed; }
      await manager.close();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    }
  });
});

describe.skipIf(process.platform !== "darwin")("project execution on the real macOS daemon", () => {
  it("starts a supervised daemon without depending on transpiler runtime helpers", async () => {
    const f = fixture();
    const sandbox = createWorkerSandbox({ workspaceDir: f.project });
    const diagnostics: string[] = [];
    const connection = new Connection({ command: sandbox.command, onLog: (line) => diagnostics.push(line) });
    try {
      await expect(connection.info()).resolves.toMatchObject({ os: "macos" });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : "Daemon failed"}; ${diagnostics.join("\n")}`);
    } finally {
      connection.close();
      expect(await sandbox.cleanup()).toBe(false);
    }
  });

  it("enforces read-only project files while allowing scratch and scoped cleanup", async () => {
    const f = fixture();
    const manager = new EnvManager({ localRootDir: f.envRoot, getProtectedPaths: () => [f.privateDir] });
    await manager.start();
    try {
      const grant = await manager.authorizeProjectDirectory("local", { projectId: "one", operationId: "one", path: f.project });
      const firstScratch = path.join(grant.scratchRoot!, "first");
      const secondScratch = path.join(grant.scratchRoot!, "second");
      const envAlias = path.join(f.root, "env-alias");
      fs.symlinkSync(f.envRoot, envAlias, "dir");
      const first = manager.createWorkerExecutionEnv("local", f.project, { projectId: "one", grantRevision: grant.revision, readOnly: true, scratchDir: path.join(envAlias, "scratch", "first") });
      const second = manager.createWorkerExecutionEnv("local", f.project, { projectId: "one", grantRevision: grant.revision, readOnly: true, scratchDir: secondScratch });
      expect(await first.readTextFile("source.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "original" });
      expect((await first.writeFile("source.txt", "forbidden", BACKGROUND_CONTEXT)).ok).toBe(false);
      const shellWrite = await first.exec(["/bin/sh", "-c", "printf forbidden > source.txt"], {}, BACKGROUND_CONTEXT);
      expect(shellWrite.ok && shellWrite.value.exitCode !== 0).toBe(true);
      expect((await first.writeFile(path.join(firstScratch, "notes.txt"), "allowed", BACKGROUND_CONTEXT)).ok).toBe(true);
      expect(await second.readTextFile("source.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "original" });
      expect(await cleanupRecordedExecutions(path.join(envAlias, ".kulo-env", "executions"), { workspaceDir: f.project, scratchDir: firstScratch })).toBe(false);
      expect(await manager.releaseWorkerExecutionEnv("local", f.project, { scratchDir: firstScratch })).toEqual({ cleanupPending: false });
      expect(await second.readTextFile("source.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "original" });
      expect(() => manager.createWorkerExecutionEnv("local", f.project)).toThrow("explicit project");
      const nestedProject = path.join(f.envRoot, "registered-project");
      await manager.authorizeProjectDirectory("local", { projectId: "nested", operationId: "nested", path: nestedProject, create: true });
      expect(() => manager.createWorkerExecutionEnv("local", path.join(f.envRoot, "legacy"), { scratchDir: nestedProject })).toThrow("explicit project");
      expect(await manager.revokeProjectDirectory("local", "one")).toEqual({ cleanupPending: false });
      expect(() => manager.createWorkerExecutionEnv("local", f.project, { projectId: "one", grantRevision: 1 })).toThrow("revoked");
      expect(fs.readFileSync(path.join(f.project, "source.txt"), "utf8")).toBe("original");
    } finally { await manager.close(); }
  });

  it("authorizes and revokes an outside-root project through the authenticated device control channel", async () => {
    const f = fixture();
    const manager = new EnvManager({ enableLocal: false, workerEnvIds: ["remote"], envTokens: { remote: "test-project-node" } });
    await manager.start();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => manager.handleEnvWebSocket(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agent = new KuloEnvAgent({ hubUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, envId: "remote", rootDir: f.envRoot, authToken: "test-project-node", reconnect: false, protectedPaths: [f.privateDir] });
    try {
      await agent.start();
      expect((await manager.listProjectDirectories("remote", f.root)).deviceId).toBe("remote");
      await expect(manager.authorizeProjectDirectory("remote", { projectId: "missing", operationId: "missing", path: path.join(f.root, "missing") })).rejects.toMatchObject({ code: "project_directory_unavailable" });
      const grant = await manager.authorizeProjectDirectory("remote", { projectId: "remote-project", operationId: "remote-project", path: f.project });
      const env = manager.createWorkerExecutionEnv("remote", grant.workspaceDir, { projectId: grant.projectId, grantRevision: grant.revision, scratchDir: path.join(grant.scratchRoot!, "one") });
      expect((await env.writeFile("remote.txt", "remote", BACKGROUND_CONTEXT)).ok).toBe(true);
      expect((await env.readTextFile(path.join(f.privateDir, "secret.txt"), BACKGROUND_CONTEXT)).ok).toBe(false);
      expect(await manager.revokeProjectDirectory("remote", grant.projectId)).toEqual({ cleanupPending: false });
      expect(() => manager.createWorkerExecutionEnv("remote", grant.workspaceDir, { projectId: grant.projectId, grantRevision: grant.revision })).toThrow("revoked");
    } finally {
      await agent.stop(); await manager.close();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    }
  });

  it("cleans double-forked setsid writers after supervisor death without killing another read-only task in the same project", async () => {
    const f = fixture();
    const source = path.join(f.project, "detached-writer.c"), executable = path.join(f.project, "detached-writer");
    fs.writeFileSync(source, `#include <unistd.h>
#include <stdio.h>
#include <fcntl.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int null = open("/dev/null", O_RDWR); if (null < 0) return 3;
  dup2(null, 0); dup2(null, 1); dup2(null, 2); if (null > 2) close(null);
  pid_t child = fork(); if (child < 0) return 4; if (child > 0) return 0;
  if (setsid() < 0) _exit(5);
  child = fork(); if (child < 0) _exit(6); if (child > 0) _exit(0);
  char file[8192]; snprintf(file, sizeof(file), "%s/writer.pid", argv[1]);
  FILE *pid = fopen(file, "w"); if (!pid) _exit(7); fprintf(pid, "%d", getpid()); fclose(pid);
  snprintf(file, sizeof(file), "%s/heartbeat", argv[1]);
  for (;;) { int fd = open(file, O_CREAT | O_WRONLY | O_APPEND, 0600); if (fd < 0) _exit(8); write(fd, "x", 1); close(fd); usleep(10000); }
}`);
    execFileSync("/usr/bin/clang", ["-O2", source, "-o", executable]);
    const manager = new EnvManager({ localRootDir: f.envRoot });
    await manager.start();
    const writers: Array<{ pid: number; identity?: string }> = [];
    try {
      const grant = await manager.authorizeProjectDirectory("local", { projectId: "fork-project", operationId: "fork-project", path: f.project });
      const firstScratch = path.join(grant.scratchRoot!, "fork-one"), secondScratch = path.join(grant.scratchRoot!, "fork-two");
      const first = manager.createWorkerExecutionEnv("local", f.project, { projectId: grant.projectId, grantRevision: grant.revision, readOnly: true, scratchDir: firstScratch });
      const second = manager.createWorkerExecutionEnv("local", f.project, { projectId: grant.projectId, grantRevision: grant.revision, readOnly: true, scratchDir: secondScratch });
      for (const [env, scratch] of [[first, firstScratch], [second, secondScratch]] as const) {
        const result = await env.exec([executable, scratch], {}, BACKGROUND_CONTEXT);
        expect(result.ok && result.value.exitCode === 0).toBe(true);
        let writer: { pid: number; identity?: string } | undefined;
        await vi.waitFor(() => {
          // fopen creates the file before stdio flushes the PID; existence is not readiness.
          const value = fs.readFileSync(path.join(scratch, "writer.pid"), "utf8").trim();
          expect(value).toMatch(/^[1-9]\d*$/);
          const pid = Number(value);
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          const identity = processFingerprint(pid);
          expect(identity).toBeDefined();
          expect(execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim()).toBe("1");
          writer = { pid, identity };
        });
        writers.push(writer!);
      }
      const nested = await first.exec(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/bin/echo", "must-not-reinitialize"], {}, BACKGROUND_CONTEXT);
      expect(nested.ok && nested.value.exitCode !== 0).toBe(true);
      const controls = path.join(f.envRoot, ".kulo-env", "executions");
      const control = fs.readdirSync(controls).map((entry) => path.join(controls, entry)).find((entry) => JSON.parse(fs.readFileSync(path.join(entry, "owner.json"), "utf8")).scratchDir === firstScratch)!;
      const receipt = JSON.parse(fs.readFileSync(path.join(control, "execution.json"), "utf8"));
      expect(processFingerprint(receipt.supervisorPid)).toBe(receipt.supervisorIdentity);
      process.kill(receipt.supervisorPid, "SIGKILL");
      const released = await manager.releaseWorkerExecutionEnv("local", f.project, { scratchDir: firstScratch });
      const diagnostics = released.cleanupPending && fs.existsSync(control) ? Object.fromEntries(["execution.json", "cleanup-error.json"].filter((name) => fs.existsSync(path.join(control, name))).map((name) => [name, JSON.parse(fs.readFileSync(path.join(control, name), "utf8"))])) : undefined;
      expect(released, JSON.stringify(diagnostics)).toEqual({ cleanupPending: false });
      await vi.waitFor(() => expect(processFingerprint(writers[0]!.pid)).toBeUndefined());
      expect(processFingerprint(writers[1]!.pid)).toBe(writers[1]!.identity);
      const before = fs.statSync(path.join(secondScratch, "heartbeat")).size;
      await vi.waitFor(() => expect(fs.statSync(path.join(secondScratch, "heartbeat")).size).toBeGreaterThan(before));
      expect(await manager.releaseWorkerExecutionEnv("local", f.project, { scratchDir: secondScratch })).toEqual({ cleanupPending: false });
      await vi.waitFor(() => expect(processFingerprint(writers[1]!.pid)).toBeUndefined());
    } finally {
      await manager.close();
      for (const writer of writers) if (writer.identity && processFingerprint(writer.pid) === writer.identity) {
        try { process.kill(writer.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  });

  it("prevents moving private controller data outside its protected path while permitting ordinary project renames", async () => {
    const f = fixture();
    const ancestor = path.join(f.project, "managed"), privateDirectory = path.join(ancestor, "private");
    fs.mkdirSync(privateDirectory, { recursive: true });
    const secret = path.join(privateDirectory, "controller.json");
    fs.writeFileSync(secret, "private-controller-canary");
    fs.mkdirSync(path.join(f.project, "ordinary"));
    const manager = new EnvManager({ localRootDir: f.envRoot, getProtectedPaths: () => [privateDirectory] });
    await manager.start();
    try {
      const grant = await manager.authorizeProjectDirectory("local", { projectId: "anchored", operationId: "anchored", path: f.project });
      const env = manager.createWorkerExecutionEnv("local", f.project, { projectId: grant.projectId, grantRevision: grant.revision, scratchDir: path.join(grant.scratchRoot!, "anchored") });
      const ordinary = await env.exec(["/bin/mv", "ordinary", "renamed"], {}, BACKGROUND_CONTEXT);
      expect(ordinary.ok && ordinary.value.exitCode === 0).toBe(true);
      const movePrivate = await env.exec(["/bin/mv", "managed", "moved-private"], {}, BACKGROUND_CONTEXT);
      expect(movePrivate.ok && movePrivate.value.exitCode !== 0).toBe(true);
      expect((await env.readTextFile(secret, BACKGROUND_CONTEXT)).ok).toBe(false);
      expect(fs.readFileSync(secret, "utf8")).toBe("private-controller-canary");
    } finally { await manager.close(); }
  });
});
