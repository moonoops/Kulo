import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevicePeerConfig } from "@moco/protocol";
import {
  findRunningDevicePeer,
  resolveChatConnection,
  runJoinedDeviceCommand,
  type DeviceLaunchDependencies,
} from "../packages/cli/src/device-launch.js";

const config: DevicePeerConfig = {
  version: 1,
  deviceId: "joined-laptop",
  name: "Laptop",
  hubUrl: "https://main.example",
  envToken: "test-execution-only",
  clientToken: "test-device-client",
  rootDir: "/tmp/moco-workspace",
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function dependencies(): DeviceLaunchDependencies {
  return {
    readConfig: vi.fn(() => ({ ...config })),
    stage: vi.fn(async () => ({ ...config })),
    activate: vi.fn(),
    findRunning: vi.fn(async () => null),
    confirmRunning: vi.fn(async () => {}),
    start: vi.fn(async () => ({ url: "http://127.0.0.1:7788", close: vi.fn(async () => {}) })),
    runTui: vi.fn(async () => {}),
    openBrowser: vi.fn(async () => {}),
    registerShutdown: vi.fn(() => vi.fn()),
    log: vi.fn(),
  };
}

describe("joined device CLI", () => {
  it("routes the normal launch to the saved Hub before any local Hub is opened", async () => {
    const deps = dependencies();
    const openHub = vi.fn();
    if (!await runJoinedDeviceCommand("dev", ["--no-tui"], true, deps)) openHub();
    expect(openHub).not.toHaveBeenCalled();
    expect(deps.start).toHaveBeenCalledWith(config, undefined);
    expect(deps.readConfig).toHaveBeenCalledOnce();
    expect(deps.runTui).not.toHaveBeenCalled();
  });

  it("keeps an unreachable paired Hub from falling back to an independent local conversation store", async () => {
    const deps = dependencies();
    vi.mocked(deps.start).mockRejectedValue(new Error("主脑不可达"));
    const openHub = vi.fn();
    const launch = async () => {
      if (!await runJoinedDeviceCommand("dev", [], false, deps)) openHub();
    };
    await expect(launch()).rejects.toThrow("主脑不可达");
    expect(openHub).not.toHaveBeenCalled();
  });

  it.each([["hub", []], ["dev", ["--standalone"]]] as const)(
    "permits an explicit independent %s without loading the saved connection",
    async (command, args) => {
      const deps = dependencies();
      vi.mocked(deps.readConfig).mockImplementation(() => { throw new Error("bad saved connection"); });
      expect(await runJoinedDeviceCommand(command, args, false, deps)).toBe(false);
      expect(deps.readConfig).not.toHaveBeenCalled();
    },
  );

  it("keeps an unpaired installation available for normal single-device launch", async () => {
    const deps = dependencies();
    vi.mocked(deps.readConfig).mockReturnValue(null);
    expect(await runJoinedDeviceCommand("dev", [], false, deps)).toBe(false);
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("uses the local proxy for TUI and closes only the runtime this command owns", async () => {
    const deps = dependencies();
    const close = vi.fn(async () => {});
    vi.mocked(deps.start).mockResolvedValue({ url: "http://127.0.0.1:17792", close });
    await runJoinedDeviceCommand("dev", [], true, deps);
    const options = vi.mocked(deps.runTui).mock.calls[0]![0];
    expect(options.wsUrl).toBe("ws://127.0.0.1:17792/ws/client");
    expect(options.authToken).toBeUndefined();
    await options.onExit?.();
    await options.onExit?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reuses the matching device client instead of opening another execution connection", async () => {
    const deps = dependencies();
    vi.mocked(deps.findRunning).mockResolvedValue({ url: "http://127.0.0.1:7788" });
    await runJoinedDeviceCommand("open", [], false, deps);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:7788");
    expect(deps.registerShutdown).not.toHaveBeenCalled();
  });

  it("pairs before launching and passes the requested workspace to the installer", async () => {
    const deps = dependencies();
    vi.mocked(deps.readConfig).mockReturnValue(null);
    await runJoinedDeviceCommand("join", ["--hub", config.hubUrl, "--invite", "one-use-test", "--root", "~/Projects", "--no-open"], false, deps);
    expect(deps.stage).toHaveBeenCalledWith({ hubUrl: config.hubUrl, inviteToken: "one-use-test", rootDir: "~/Projects" });
    expect(deps.activate).toHaveBeenCalledWith(config);
    expect(deps.start).toHaveBeenCalledWith(config, undefined);
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(vi.mocked(deps.log).mock.calls.flat().join("\n")).not.toContain("one-use-test");
  });

  it("refuses to consume a new invitation while the old paired runtime is still running", async () => {
    const deps = dependencies();
    vi.mocked(deps.findRunning).mockResolvedValue({ url: "http://127.0.0.1:7788" });
    await expect(runJoinedDeviceCommand("join", ["--hub", config.hubUrl, "--invite", "another-invite"], false, deps))
      .rejects.toThrow("请先退出客户端");
    expect(deps.stage).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("opens an existing offline client but does not activate a staged join through it", async () => {
    const deps = dependencies();
    vi.mocked(deps.readConfig).mockReturnValue(null);
    vi.mocked(deps.findRunning).mockResolvedValue({ url: "http://127.0.0.1:7788" });
    vi.mocked(deps.confirmRunning).mockRejectedValue(new Error("offline"));
    await expect(runJoinedDeviceCommand("join", ["--hub", config.hubUrl, "--invite", "staged-invite"], false, deps)).rejects.toThrow("offline");
    expect(deps.activate).not.toHaveBeenCalled();
    vi.mocked(deps.readConfig).mockReturnValue(config);
    expect(await runJoinedDeviceCommand("open", [], false, deps)).toBe(true);
    expect(deps.openBrowser).toHaveBeenCalledOnce();
    expect(deps.confirmRunning).toHaveBeenCalledTimes(1);
  });

  it("reports a paired TUI connection failure without exposing device credentials or starting a new Hub", async () => {
    const deps = dependencies();
    vi.mocked(deps.runTui).mockRejectedValue(new Error(`transport failed: ${config.clientToken}`));
    await expect(runJoinedDeviceCommand("dev", [], true, deps)).rejects.toThrow("[已隐藏]");
    expect(vi.mocked(deps.start).mock.results).toHaveLength(1);
  });
});

describe("chat credential routing", () => {
  it("uses the paired Hub's client identity instead of local administrator or execution credentials", () => {
    const target = resolveChatConnection([], { MOCO_AUTH_TOKEN: "local-admin-test" }, () => config);
    expect(target.wsUrl).toBe("wss://main.example/ws/client");
    expect(target.authToken).toBe(config.clientToken);
    expect(target.wsUrl).not.toContain(config.clientToken);
  });

  it("never forwards the saved device identity to a different explicit endpoint", () => {
    const read = vi.fn(() => config);
    const target = resolveChatConnection(["--url", "wss://other.example/ws/client"], {}, read);
    expect(target.authToken).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves deliberate command-line authentication overrides", () => {
    const target = resolveChatConnection(["--token=chosen-client"], {}, () => config);
    expect(target.authToken).toBe("chosen-client");
  });
});

describe("running peer identity", () => {
  it("keeps CLI pairing retryable across a busy port, then rejoins through the running Hub", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-cli-join-"));
    cleanup.push(async () => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, "peer", "connection.json");
    const localToken = "test-cli-admin-credential";
    let hubUrl = "";
    let pairs = 0;
    let topics: http.ServerResponse | undefined;
    const remote = http.createServer((req, res) => {
      if (req.url === "/api/devices/pair") {
        pairs++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...config, hubUrl, rootDir: path.join(directory, "workspace") }));
      } else if (req.url === "/api/topics") topics = res;
      else res.writeHead(404).end();
    });
    const ws = new WebSocketServer({ server: remote });
    ws.on("connection", (socket) => socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "env.register") socket.send(JSON.stringify({ type: "hub.registered", envId: msg.envId }));
    }));
    const occupied = http.createServer((_req, res) => res.writeHead(404).end());
    const listen = async (server: http.Server) => {
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      return address.port;
    };
    hubUrl = `http://127.0.0.1:${await listen(remote)}`;
    const port = await listen(occupied);
    const closeServer = async (server: http.Server) => {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    cleanup.push(async () => {
      for (const socket of ws.clients) socket.terminate();
      ws.close();
      await closeServer(occupied); await closeServer(remote);
    });
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const packages = new URL("../packages/", import.meta.url).href;
    const script = `
      import { registerHooks } from "node:module";
      const root = ${JSON.stringify(packages)};
      registerHooks({ resolve(id, context, next) {
        return next(id.startsWith("@moco/") ? new URL(id.slice(6) + "/src/index.ts", root).href : id, context);
      } });
      process.argv.splice(1, 0, "moco");
      await import(new URL("cli/src/bin.ts", root));
    `;
    function join(invite: string) {
      const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", script,
        "join", "--hub", hubUrl, "--invite", invite, "--port", String(port), "--no-open"], {
        cwd: directory, env: { ...process.env, MOCO_PEER_CONFIG: configPath, MOCO_STATE_DIR: path.join(directory, "state"), MOCO_AUTH_TOKEN: localToken },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      cleanup.push(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      });
      return { exited, output: () => output };
    }

    const invite = "test-one-use-command-line-invitation";
    const blocked = join(invite);
    expect((await blocked.exited)[0]).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(pairs, blocked.output()).toBe(1);
    await closeServer(occupied);
    const owner = join(invite);
    await vi.waitFor(() => expect(topics, owner.output()).toBeDefined(), { timeout: 10_000 });
    expect(fs.existsSync(configPath)).toBe(false);
    topics!.writeHead(200).end(JSON.stringify({ items: [] }));
    topics = undefined;
    await vi.waitFor(() => expect(fs.existsSync(configPath)).toBe(true));
    expect(pairs).toBe(1);

    const origin = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${localToken}` };
    const leaving = await fetch(`${origin}/api/devices/leave`, { method: "POST", headers });
    expect(leaving.status).toBe(202);
    const { id } = await leaving.json();
    await vi.waitFor(async () => {
      const res = await fetch(`${origin}/api/devices/role-transition?id=${id}`, { headers });
      expect(await res.json()).toMatchObject({ status: "ready" });
    }, { timeout: 10_000 });
    expect(fs.existsSync(configPath)).toBe(false);
    const second = join("test-separate-command-line-invitation");
    await vi.waitFor(() => expect(topics, second.output()).toBeDefined(), { timeout: 10_000 });
    expect(fs.existsSync(configPath)).toBe(false);
    topics!.writeHead(200).end(JSON.stringify({ items: [] }));
    expect((await second.exited)[0], second.output()).toBe(0);
    expect(pairs).toBe(2);
    expect(second.output()).not.toContain(localToken);
    expect(fs.existsSync(configPath)).toBe(true);
  }, 45_000);

  it("recognizes an older listener without opening an unverified origin", async () => {
    let status: { deviceId: string; hubUrl: string; error?: string } = { deviceId: config.deviceId, hubUrl: config.hubUrl };
    const server = http.createServer((req, res) => {
      expect(req.url).toBe("/_moco/peer-status");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(status));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    await expect(findRunningDevicePeer(config, address.port)).rejects.toThrow("旧版设备客户端");
    status = { ...status, hubUrl: "https://other.example" };
    expect(await findRunningDevicePeer(config, address.port)).toBeNull();
    status = { deviceId: "different-device", hubUrl: config.hubUrl };
    expect(await findRunningDevicePeer(config, address.port)).toBeNull();
    status = { deviceId: config.deviceId, hubUrl: config.hubUrl, error: "界面登录已失效" };
    await expect(findRunningDevicePeer(config, address.port)).rejects.toThrow("旧版设备客户端");
  });
});
