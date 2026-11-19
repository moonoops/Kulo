import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import http from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRuntimeEnvironment,
  loadDesktopRuntimeOptions,
  prepareDesktopRuntime,
  readDesktopRuntimePort,
  resolveDesktopRuntimePaths,
  saveDesktopRuntimePort,
} from "../packages/desktop/src/runtime-config.js";
import { createRuntimeShutdown } from "../packages/desktop/src/runtime.js";
import { savePeerConfig } from "@moco/env";
import { startMocoHubServer } from "@moco/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const temporary: string[] = [];
const children: ChildProcess[] = [];
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco desktop runtime "));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("desktop runtime isolation", () => {
  it("replaces inherited Moco routing and model credentials while preserving system proxy and home", () => {
    const dataDir = root();
    const source = {
      PATH: "/usr/bin:/bin", HOME: os.homedir(), HTTPS_PROXY: "http://127.0.0.1:7890", NODE_EXTRA_CA_CERTS: "/certificate.pem",
      MOCO_STATE_DIR: "/production", MOCO_IDENTITY_DIR: "/production/identity", MOCO_PEER_CONFIG: "/production/peer.json",
      MOCO_AUTH_TOKEN: "production-management", MOCO_HUB_HOST: "0.0.0.0", MOCO_HUB_PORT: "7788",
      MOCO_ENV_TOKENS: "unrelated", MOCO_HINDSIGHT_ENABLED: "true", OPENAI_API_KEY: "existing-key",
      ANTHROPIC_AUTH_TOKEN: "existing-subscription", GEMINI_API_KEY: "existing-google", HF_TOKEN: "existing-huggingface",
      GOOGLE_APPLICATION_CREDENTIALS: "/production/google.json", GOOGLE_CLOUD_PROJECT: "production",
      AWS_PROFILE: "production", AWS_SECRET_ACCESS_KEY: "existing-aws", RANDOM_SERVICE_API_KEY: "existing-other",
      PI_CODING_AGENT_DIR: "/production/pi", NODE_OPTIONS: "--require /production/init.js", NODE_PATH: "/production/modules",
      ELECTRON_RUN_AS_NODE: "1", NODE_CHANNEL_FD: "3",
    };
    const env = buildRuntimeEnvironment(source, { dataDir, webDir: "/Application Resources/web", viteUrl: "http://127.0.0.1:5174" });
    expect(env).toEqual({
      PATH: source.PATH, HOME: source.HOME, HTTPS_PROXY: source.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: source.NODE_EXTRA_CA_CERTS,
      MOCO_DESKTOP_DATA_DIR: dataDir, MOCO_DESKTOP_WEB_DIR: "/Application Resources/web",
      MOCO_STATE_DIR: path.join(dataDir, "hub"), MOCO_IDENTITY_DIR: path.join(dataDir, "hub", "identity"),
      MOCO_PEER_CONFIG: path.join(dataDir, "peer", "connection.json"), MOCO_HUB_HOST: "127.0.0.1",
      MOCO_DESKTOP_VITE_URL: "http://127.0.0.1:5174",
    });
    expect(source.MOCO_STATE_DIR).toBe("/production");
  });

  it("creates persistent private data and a separate token for each development data root", () => {
    const paths = resolveDesktopRuntimePaths(root());
    const token = prepareDesktopRuntime(paths);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(prepareDesktopRuntime(paths)).toBe(token);
    expect(prepareDesktopRuntime(resolveDesktopRuntimePaths(root()))).not.toBe(token);
    for (const directory of [paths.dataDir, paths.stateDir, paths.identityDir, paths.workspaceDir]) {
      expect(fs.statSync(directory).isDirectory()).toBe(true);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(fs.statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
    expect(path.dirname(paths.tokenPath)).toBe(paths.stateDir);
    expect(fs.readdirSync(paths.dataDir)).not.toContain(".env");
    expect(fs.readdirSync(paths.stateDir).some((name) => name.startsWith(".runtime-token-"))).toBe(false);
  });

  it("rejects redirected data directories and symlinked management credentials", () => {
    const dataDir = root();
    const linked = path.join(root(), "linked");
    fs.symlinkSync(dataDir, linked, "dir");
    expect(() => prepareDesktopRuntime(resolveDesktopRuntimePaths(linked))).toThrow("开发版数据目录不可用");
    const paths = resolveDesktopRuntimePaths(root());
    const outside = path.join(root(), "outside-token");
    fs.writeFileSync(outside, "a".repeat(64), { mode: 0o644 });
    fs.mkdirSync(paths.stateDir);
    fs.symlinkSync(outside, paths.tokenPath);
    expect(() => prepareDesktopRuntime(paths)).toThrow();
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("fails on corrupt credentials without including their contents in an error", () => {
    const paths = resolveDesktopRuntimePaths(root());
    const secret = "invalid-sensitive-content";
    fs.mkdirSync(paths.stateDir);
    fs.writeFileSync(paths.tokenPath, secret);
    let error: unknown;
    try { prepareDesktopRuntime(paths); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });

  it("keeps the first successful service port private and refuses a changed or corrupt origin", () => {
    const paths = resolveDesktopRuntimePaths(root());
    expect(readDesktopRuntimePort(paths)).toBe(0);
    saveDesktopRuntimePort(paths, 48765);
    expect(readDesktopRuntimePort(paths)).toBe(48765);
    expect(fs.statSync(paths.portPath).mode & 0o777).toBe(0o600);
    expect(() => saveDesktopRuntimePort(paths, 48766)).toThrow("端口");
    expect(readDesktopRuntimePort(paths)).toBe(48765);
    for (const value of ["0", "65536", "1.5", "invalid", "1\n2", "-1", ""]) {
      fs.writeFileSync(paths.portPath, value);
      expect(() => readDesktopRuntimePort(paths)).toThrow("端口");
    }
    fs.unlinkSync(paths.portPath);
    const outside = path.join(root(), "outside-port");
    fs.writeFileSync(outside, "48765\n", { mode: 0o644 });
    fs.symlinkSync(outside, paths.portPath);
    expect(() => readDesktopRuntimePort(paths)).toThrow();
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("validates absolute paths and restricts development rendering to loopback", () => {
    expect(() => resolveDesktopRuntimePaths("relative")).toThrow();
    expect(() => resolveDesktopRuntimePaths("/")).toThrow();
    const env = { MOCO_DESKTOP_DATA_DIR: "/Users/example/Library/Application Support/Moco Dev", MOCO_DESKTOP_WEB_DIR: "/Applications/Moco Dev.app/Contents/Resources/web" };
    expect(loadDesktopRuntimeOptions(env)).toEqual({ dataDir: env.MOCO_DESKTOP_DATA_DIR, webDir: env.MOCO_DESKTOP_WEB_DIR });
    for (const viteUrl of ["https://example.com", "http://localhost:5174", "http://127.0.0.1:5174/other", "http://user:secret@127.0.0.1:5174", "http://127.0.0.1:5174/?token=secret"]) {
      expect(() => loadDesktopRuntimeOptions({ ...env, MOCO_DESKTOP_VITE_URL: viteUrl })).toThrow();
    }
  });
});

describe("desktop runtime shutdown", () => {
  it("saves and closes the Hub after a listener close failure and does not close twice", async () => {
    const listenerError = new Error("listener-close-failed");
    const server = { close: vi.fn().mockRejectedValue(listenerError) };
    const hub = { close: vi.fn().mockResolvedValue(undefined) };
    const close = createRuntimeShutdown({ server, hub });
    const first = close();
    expect(close()).toBe(first);
    await expect(first).rejects.toMatchObject({ errors: [listenerError] });
    expect(server.close).toHaveBeenCalledOnce();
    expect(hub.close).toHaveBeenCalledOnce();
    expect(server.close.mock.invocationCallOrder[0]).toBeLessThan(hub.close.mock.invocationCallOrder[0]!);
  });

  it("also cleans up after a partial startup", async () => {
    const hub = { close: vi.fn().mockResolvedValue(undefined) };
    await createRuntimeShutdown({ hub })();
    expect(hub.close).toHaveBeenCalledOnce();
  });
});

interface RuntimeReady { type: "ready"; url: string; token: string }

function startRealRuntime(existingDataDir?: string, fault?: "uncaughtException" | "unhandledRejection"): {
  child: ChildProcess;
  dataDir: string;
  outsideDir: string;
  ready: Promise<RuntimeReady>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
} {
  const dataDir = existingDataDir ?? root();
  const outsideDir = root();
  const inheritedWorkingDirectory = root();
  const webDir = root();
  fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>Moco desktop test</title>");
  fs.writeFileSync(path.join(inheritedWorkingDirectory, ".env"), [
    `MOCO_STATE_DIR=${outsideDir}`,
    `MOCO_IDENTITY_DIR=${path.join(outsideDir, "identity")}`,
    "MOCO_AUTH_TOKEN=inherited-management-token",
    "MOCO_MODEL=inherited-model-must-not-appear",
    "OPENAI_API_KEY=inherited-model-key",
  ].join("\n"));
  const entry = fileURLToPath(new URL("../packages/desktop/src/runtime.ts", import.meta.url));
  const tsconfigPath = path.join(inheritedWorkingDirectory, "runtime-tsconfig.json");
  // Workspace exports otherwise resolve to dist, whose Skill copy may be replaced by a concurrent build.
  fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {
    baseUrl: fileURLToPath(new URL("../", import.meta.url)),
    paths: Object.fromEntries(["hub", "env", "protocol"].map((name) => [
      `@moco/${name}`, [fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url))],
    ])),
  } }));
  const execArgv = ["--import", createRequire(import.meta.url).resolve("tsx")];
  if (fault) {
    const preload = `process.on("message", message => {
      if (message?.type !== "test-runtime-failure") return;
      const error = new Error("intentional backend failure " + message.token);
      ${fault === "uncaughtException" ? "queueMicrotask(() => { throw error; });" : "Promise.reject(error);"}
    });`;
    execArgv.push("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
  }
  const child = fork(entry, [], {
    execPath: process.execPath,
    execArgv,
    cwd: inheritedWorkingDirectory,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: tsconfigPath,
      MOCO_DESKTOP_DATA_DIR: dataDir,
      MOCO_DESKTOP_WEB_DIR: webDir,
      MOCO_STATE_DIR: outsideDir,
      MOCO_AUTH_TOKEN: "inherited-management-token",
      OPENAI_API_KEY: "inherited-model-key",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<RuntimeReady>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop runtime did not become ready.")), 25_000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    child.once("error", fail);
    child.once("exit", () => fail(new Error("Desktop runtime exited before becoming ready.")));
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as { type?: unknown; url?: unknown; token?: unknown };
      if (value.type === "error") fail(new Error("Desktop runtime reported a startup error."));
      if (value.type === "ready" && typeof value.url === "string" && typeof value.token === "string") {
        clearTimeout(timer);
        resolve(value as RuntimeReady);
      }
    });
  });
  return { child, dataDir, outsideDir, ready, exited, output: () => output };
}

describe("desktop runtime with a real Node backend", () => {
  it("restores the same Hub after a slow peer fails and retries the consumed invitation on the same port", async () => {
    const running = startRealRuntime();
    const ready = await running.ready;
    const configPath = resolveDesktopRuntimePaths(running.dataDir).peerConfigPath;
    const headers = { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" };
    let target = "";
    let pairCalls = 0;
    let topics: http.ServerResponse | undefined;
    const remote = http.createServer((req, res) => {
      if (req.url === "/api/devices/pair") {
        res.writeHead(++pairCalls === 1 ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: 1, name: "Temporary peer", deviceId: "readiness-peer", hubUrl: target,
          clientToken: "test-client-application", envToken: "test-execution-node", rootDir: running.dataDir }));
      } else if (req.url === "/api/topics" && req.headers.authorization === "Bearer test-client-application") {
        topics = res;
      } else res.writeHead(404).end();
    });
    const registrations = new WebSocketServer({ server: remote });
    registrations.on("connection", (ws) => ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "env.register") ws.send(JSON.stringify({ type: "hub.registered", envId: msg.envId }));
    }));
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream address");
    target = `http://127.0.0.1:${address.port}`;
    const join = async () => {
      const response = await fetch(`${ready.url}/api/devices/join`, {
        method: "POST", headers, body: JSON.stringify({ input: target, token: "single-use-test-readiness-invite" }),
      });
      expect(response.status).toBe(202);
      return (await response.json()).id as string;
    };
    const state = async (id: string) => (await fetch(`${ready.url}/api/devices/role-transition?id=${id}`, { headers })).json();
    try {
      const first = await join();
      await vi.waitFor(() => expect(topics).toBeDefined(), { timeout: 8000 });
      expect(await state(first)).toMatchObject({ status: "switching" });
      expect(fs.existsSync(configPath)).toBe(false);
      topics!.writeHead(503).end();
      topics = undefined;
      await vi.waitFor(async () => expect(await state(first)).toMatchObject({ status: "failed", error: expect.stringContaining("已恢复本机独立运行") }), { timeout: 8000 });
      expect(await (await fetch(`${ready.url}/api/devices`, { headers })).json()).toMatchObject({ role: "hub", currentDeviceId: "local" });
      const retry = await join();
      await vi.waitFor(() => expect(topics).toBeDefined(), { timeout: 8000 });
      expect(await state(retry)).toMatchObject({ status: "switching" });
      topics!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: [] }));
      await vi.waitFor(async () => expect(await state(retry)).toMatchObject({ status: "ready" }), { timeout: 8000 });
      expect(fs.existsSync(configPath)).toBe(true);
      expect(pairCalls).toBe(1);
    } finally {
      running.child.send({ type: "shutdown" });
      await running.exited;
      for (const ws of registrations.clients) ws.terminate();
      registrations.close();
      remote.closeAllConnections();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
  }, 40_000);

  it.each(["shutdown", "disconnect"] as const)("starts without model credentials and closes after IPC %s", async (action) => {
    const running = startRealRuntime();
    const ready = await running.ready;
    const origin = new URL(ready.url);
    expect(origin.protocol).toBe("http:");
    expect(origin.hostname).toBe("127.0.0.1");
    expect(Number(origin.port)).toBeGreaterThan(0);
    expect(/^[a-f0-9]{64}$/.test(ready.token)).toBe(true);
    expect(ready.token === "inherited-management-token").toBe(false);
    const paths = resolveDesktopRuntimePaths(running.dataDir);
    expect(fs.readFileSync(paths.tokenPath, "utf8") === ready.token).toBe(true);
    expect(fs.statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(paths.stateDir, "moco.sqlite"))).toBe(true);
    expect(fs.statSync(paths.identityDir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(running.outsideDir)).toEqual([]);
    const page = await fetch(ready.url);
    expect(await page.text()).toContain("Moco desktop test");
    const settingsResponse = await fetch(`${ready.url}/api/settings`, { headers: { Authorization: `Bearer ${ready.token}` } });
    expect(settingsResponse.ok).toBe(true);
    const settings = await settingsResponse.json() as {
      blocks: { model: { value: { defaultModel: string } } };
    };
    expect(settings.blocks.model.value.defaultModel).toBe("");
    const identityResponse = await fetch(`${ready.url}/api/identity/files`, { headers: { Authorization: `Bearer ${ready.token}` } });
    const identity = await identityResponse.json() as { directory: string };
    expect(identity.directory).toBe(paths.identityDir);
    const devicesResponse = await fetch(`${ready.url}/api/devices`, { headers: { Authorization: `Bearer ${ready.token}` } });
    expect(devicesResponse.ok).toBe(true);
    const devices = await devicesResponse.json() as { hubName: string; currentDeviceId: string; currentDeviceKnown?: boolean; devices: Array<{ id: string; name: string }> };
    expect(devices).toMatchObject({ hubName: os.hostname(), currentDeviceId: "local", currentDeviceKnown: true });
    expect(devices.devices[0]).toMatchObject({ id: "local", name: os.hostname() });
    const permissionsResponse = await fetch(`${ready.url}/api/envs/local/system-permissions`, { headers: { Authorization: `Bearer ${ready.token}` } });
    expect(permissionsResponse.status).not.toBe(409);
    if (action === "shutdown") running.child.send({ type: "shutdown" });
    else running.child.disconnect();
    const exited = await running.exited;
    expect(exited).toEqual({ code: 0, signal: null });
    expect(running.output().includes(ready.token)).toBe(false);
    expect(running.output().includes("inherited-model-key")).toBe(false);
    await expect(fetch(`${ready.url}/api/health`)).rejects.toThrow();
  }, 30_000);

  it("reuses the same loopback origin and token after a clean restart", async () => {
    const first = startRealRuntime();
    const ready = await first.ready;
    first.child.send({ type: "shutdown" });
    expect(await first.exited).toEqual({ code: 0, signal: null });
    const second = startRealRuntime(first.dataDir);
    const restarted = await second.ready;
    expect(restarted.url).toBe(ready.url);
    expect(restarted.token === ready.token).toBe(true);
    expect(readDesktopRuntimePort(resolveDesktopRuntimePaths(first.dataDir))).toBe(Number(new URL(ready.url).port));
    second.child.send({ type: "shutdown" });
    expect(await second.exited).toEqual({ code: 0, signal: null });
  }, 30_000);

  it("exposes the LAN join installer when device interconnection is enabled and restores loopback-only mode when disabled", async () => {
    const lanIp = Object.values(os.networkInterfaces()).flat()
      .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
    if (!lanIp) return;
    const waitUntil = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Desktop runtime listener transition did not settle.");
    };
    const first = startRealRuntime();
    const ready = await first.ready;
    const port = new URL(ready.url).port;
    const lanInstallerUrl = `http://${lanIp}:${port}/connect/install.sh`;
    await expect(fetch(lanInstallerUrl)).rejects.toThrow();

    const enableResponse = await fetch(`${ready.url}/api/devices`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enableResponse.status).toBe(200);
    await waitUntil(async () => {
      try {
        const res = await fetch(lanInstallerUrl);
        return res.status === 200 && (await res.text()).startsWith("#!/bin/sh");
      } catch {
        return false;
      }
    });

    first.child.send({ type: "shutdown" });
    expect(await first.exited).toEqual({ code: 0, signal: null });

    const restarted = startRealRuntime(first.dataDir);
    const restartedReady = await restarted.ready;
    expect(restartedReady.url).toBe(ready.url);
    const afterRestart = await fetch(lanInstallerUrl);
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.text()).toContain("/connect/peer.mjs");

    const disableResponse = await fetch(`${restartedReady.url}/api/devices`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${restartedReady.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableResponse.status).toBe(200);
    await waitUntil(async () => {
      try {
        await fetch(lanInstallerUrl);
        return false;
      } catch {
        // Both endpoints can briefly refuse connections while the listener changes addresses.
        const local = await fetch(`${restartedReady.url}/api/devices`, {
          headers: { Authorization: `Bearer ${restartedReady.token}` },
        }).catch(() => undefined);
        return local?.ok === true && (await local.json()).enabled === false;
      }
    });
    const localDevices = await fetch(`${restartedReady.url}/api/devices`, {
      headers: { Authorization: `Bearer ${restartedReady.token}` },
    });
    expect(localDevices.status).toBe(200);
    expect(await localDevices.json()).toMatchObject({ enabled: false });

    restarted.child.send({ type: "shutdown" });
    expect(await restarted.exited).toEqual({ code: 0, signal: null });
  }, 30_000);

  it("fails clearly when the saved origin is occupied and preserves its port", async () => {
    const dataDir = root();
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback test listener.");
      const paths = resolveDesktopRuntimePaths(dataDir);
      saveDesktopRuntimePort(paths, address.port);
      const running = startRealRuntime(dataDir);
      const reported = new Promise<string>((resolve) => running.child.on("message", (message: unknown) => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "error") {
          resolve(String((message as { message?: unknown }).message));
        }
      }));
      await expect(running.ready).rejects.toThrow("startup error");
      expect(await reported).toContain("EADDRINUSE");
      expect(await running.exited).toEqual({ code: 1, signal: null });
      expect(readDesktopRuntimePort(paths)).toBe(address.port);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 30_000);

  it.each(["uncaughtException", "unhandledRejection"] as const)("reports and cleans up after %s without leaking the token", async (fault) => {
    const running = startRealRuntime(undefined, fault);
    const ready = await running.ready;
    const reported = new Promise<string>((resolve) => running.child.on("message", (message: unknown) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "error") {
        resolve(String((message as { message?: unknown }).message));
      }
    }));
    running.child.send({ type: "test-runtime-failure", token: ready.token });
    const message = await reported;
    expect(message).toContain("intentional backend failure");
    expect(message.includes(ready.token)).toBe(false);
    expect(await running.exited).toEqual({ code: 1, signal: null });
    expect(running.output().includes(ready.token)).toBe(false);
    await expect(fetch(`${ready.url}/api/health`)).rejects.toThrow();
  }, 30_000);

  it("starts exclusively in Peer mode without launching local MocoHub when peer/connection.json exists, and hot-switches to local Hub on leave", async () => {
    const dataDir = root();
    const paths = resolveDesktopRuntimePaths(dataDir);
    prepareDesktopRuntime(paths);
    savePeerConfig({
      version: 1,
      hubUrl: "http://127.0.0.1:9",
      deviceId: "dev-desktop-peer",
      name: "DesktopPeer",
      envToken: "desktop-peer-env-secret",
      clientToken: "desktop-peer-client-secret",
      rootDir: paths.workspaceDir,
    }, paths.peerConfigPath);

    const running = startRealRuntime(dataDir);
    const ready = await running.ready;

    // Must NOT open or create local moco.sqlite while in Peer mode!
    expect(fs.existsSync(path.join(paths.stateDir, "moco.sqlite"))).toBe(false);

    // Static Web UI must load locally even though remote Hub (127.0.0.1:9) is offline.
    const page = await fetch(ready.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Moco desktop test");

    const peerDevicesRes = await fetch(`${ready.url}/api/devices`, {
      headers: { Authorization: `Bearer ${ready.token}` },
    });
    expect(peerDevicesRes.status).toBe(200);
    const peerDevices = await peerDevicesRes.json() as { role: string; canSwitchRole?: boolean; hubError?: string };
    expect(peerDevices).toMatchObject({ role: "joined", canSwitchRole: true });
    expect(peerDevices.hubError).toBeTruthy();

    // Leave Peer mode -> hot-switches to local Hub on the exact same port & token!
    const leaveRes = await fetch(`${ready.url}/api/devices/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ready.token}` },
    });
    expect(leaveRes.status).toBe(202);
    const leaveReceipt = await leaveRes.json() as { id: string };
    expect(leaveReceipt).toMatchObject({ targetRole: "hub", status: "switching" });

    await vi.waitFor(async () => {
      const res = await fetch(`${ready.url}/api/devices`, {
        headers: { Authorization: `Bearer ${ready.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { role?: string; currentDeviceId?: string };
      expect(body.role).toBe("hub");
      expect(body.currentDeviceId).toBe("local");
      const state = await fetch(`${ready.url}/api/devices/role-transition?id=${leaveReceipt.id}`, { headers: { Authorization: `Bearer ${ready.token}` } });
      expect(await state.json()).toMatchObject({ id: leaveReceipt.id, status: "ready" });
    }, { timeout: 10_000, interval: 50 });

    expect(fs.existsSync(paths.peerConfigPath)).toBe(false);
    expect(fs.existsSync(path.join(paths.stateDir, "moco.sqlite"))).toBe(true);

    running.child.send({ type: "shutdown" });
    expect(await running.exited).toEqual({ code: 0, signal: null });
    expect(running.output()).not.toContain("desktop-peer-env-secret");
    expect(running.output()).not.toContain("desktop-peer-client-secret");
  }, 30_000);

  it("joins a live remote Host via POST /api/devices/join and hot-switches from local Hub to Peer on the same port", async () => {
    const lanIp = Object.values(os.networkInterfaces()).flat()
      .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
    if (!lanIp) return;

    const hostStateDir = root();
    const hostHub = await openTestHub({
      config: {
        stateDir: hostStateDir,
        host: "0.0.0.0",
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        memory: { enabled: false },
      },
    });
    const hostServer = await startMocoHubServer(hostHub, { host: "0.0.0.0", port: 0 });
    try {
      const hostLanOrigin = `http://${lanIp}:${hostServer.port}`;
      const enableRes = await fetch(`${hostServer.url}/api/devices`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enableRes.status).toBe(200);

      const inviteRes = await fetch(`${hostServer.url}/api/devices/invitations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "桌面副机", hubUrl: hostLanOrigin }),
      });
      expect(inviteRes.status).toBe(201);
      const invitation = await inviteRes.json() as { deviceId: string; agentInstructions: string };

      const running = startRealRuntime();
      const ready = await running.ready;

      const joinRes = await fetch(`${ready.url}/api/devices/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: invitation.agentInstructions }),
      });
      expect(joinRes.status).toBe(202);
      const joinReceipt = await joinRes.json() as { id: string };
      expect(joinReceipt).toMatchObject({ targetRole: "joined", status: "switching" });

      await vi.waitFor(async () => {
        expect(hostHub.envManager.listEnvs().some((env) => env.id === invitation.deviceId && env.online)).toBe(true);
        const res = await fetch(`${ready.url}/api/devices`, {
          headers: { Authorization: `Bearer ${ready.token}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { role?: string; currentDeviceId?: string; canSwitchRole?: boolean };
        expect(body).toMatchObject({ role: "joined", currentDeviceId: invitation.deviceId, canSwitchRole: true });
        const state = await fetch(`${ready.url}/api/devices/role-transition?id=${joinReceipt.id}`, { headers: { Authorization: `Bearer ${ready.token}` } });
        expect(await state.json()).toMatchObject({ id: joinReceipt.id, status: "ready" });
      }, { timeout: 12_000, interval: 50 });

      running.child.send({ type: "shutdown" });
      expect(await running.exited).toEqual({ code: 0, signal: null });
    } finally {
      await hostServer.close();
      await hostHub.close();
    }
  }, 35_000);
});
