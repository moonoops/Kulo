import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildPeer } from "../packages/env/scripts/build-peer.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  collectDeviceSystemInfo,
  installDevicePeer,
  localPeerProxyToken,
  readPeerConfig,
  savePeerConfig,
  startDevicePeer,
} from "@moco/env";
import { decodeStreamChunk, encodeStreamChunk, type DevicePeerConfig } from "@moco/protocol";
import { findRunningDevicePeer } from "../packages/cli/src/device-launch";
import { DevicePeerInUseError } from "@moco/env";

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => { vi.stubEnv("MOCO_PEER_CONFIG", path.join(temporary(), "connection.json")); });
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-peer-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function peerConfig(hubUrl: string, deviceId = "peer-one"): DevicePeerConfig {
  return {
    version: 1,
    deviceId,
    name: "My laptop",
    hubUrl,
    clientToken: `client-only-${deviceId}`,
    envToken: `env-only-${deviceId}`,
    rootDir: temporary(),
    localPort: 0,
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}`;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No client update")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString("utf8")));
    });
    socket.once("error", reject);
  });
}

async function client(url: string, authToken?: string): Promise<WebSocket> {
  const socket = new WebSocket(url.replace("http:", "ws:") + "/ws/client", authToken ? { headers: { authorization: `Bearer ${authToken}` } } : undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function fakeHub(options: { clientHttpStatus?: number } = {}) {
  const clientSockets = new Set<WebSocket>();
  const envSockets = new Set<WebSocket>();
  const registrations: Record<string, unknown>[] = [];
  const requests: Array<{ authorization: string | undefined; cookie: string | undefined; url: string }> = [];
  const conversations: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, url: request.url! });
    response.writeHead(options.clientHttpStatus ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [], conversations }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (request.url === "/ws/env") {
        envSockets.add(ws);
        ws.on("close", () => envSockets.delete(ws));
        ws.on("message", (raw) => {
          const data = JSON.parse(raw.toString("utf8"));
          registrations.push(data);
          ws.send(JSON.stringify({ type: "hub.registered", envId: data.envId }));
        });
      } else {
        if (!request.headers.authorization?.startsWith("Bearer client-only-")) {
          ws.close(4001);
          return;
        }
        clientSockets.add(ws);
        ws.on("close", () => clientSockets.delete(ws));
        ws.on("message", (raw) => {
          conversations.push(raw.toString("utf8"));
          for (const client of clientSockets) client.send(JSON.stringify({ conversations }));
        });
      }
    });
  });
  const url = await listen(server);
  cleanup.push(() => {
    for (const socket of [...clientSockets, ...envSockets]) socket.terminate();
    wss.close();
  });
  return { url, registrations, requests, envSockets };
}

describe("joined device configuration", () => {
  it("persists only in owner-readable files and resumes the same main brain", () => {
    const directory = temporary();
    const file = path.join(directory, "private", "connection.json");
    const config = peerConfig("http://127.0.0.1:7788");
    savePeerConfig(config, file);
    expect(readPeerConfig(file)).toEqual(config);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      fs.chmodSync(file, 0o644);
      expect(() => readPeerConfig(file)).toThrow("0600");
    }
  });

  it("refuses configuration symlinks rather than overwriting their targets", () => {
    const directory = temporary();
    const target = path.join(directory, "target");
    fs.writeFileSync(target, "unchanged");
    const file = path.join(directory, "connection.json");
    fs.symlinkSync(target, file);
    expect(() => savePeerConfig(peerConfig("http://127.0.0.1:7788"), file)).toThrow("符号链接");
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
  });

  it("reports actual machine addresses and system metadata", () => {
    const info = collectDeviceSystemInfo();
    expect(info.hostname).toBe(os.hostname());
    expect(info.platform).toBe(process.platform);
    expect(info.memoryBytes).toBeGreaterThan(0);
    expect(info.ips.some((ip) => ip.startsWith("127.") || ip === "::1")).toBe(false);
    expect(new Set(info.ips).size).toBe(info.ips.length);
  });

  it("pairs once, expands the remote home directory, and rejects a changed credential destination", async () => {
    const directory = temporary();
    const file = path.join(directory, "connection.json");
    let returnedUrl = "";
    let pairingRequest: Record<string, unknown> | undefined;
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      pairingRequest = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        version: 1, deviceId: "paired", name: "Paired laptop", hubUrl: returnedUrl,
        envToken: "paired-env-only", clientToken: "paired-client-only", rootDir: "~/Moco",
      }));
    });
    const url = await listen(server);
    returnedUrl = url;
    const config = await installDevicePeer({ hubUrl: url, inviteToken: "single-use-invitation", configPath: file });
    expect(config.hubUrl).toBe(url);
    expect(config.rootDir).toBe(path.join(os.homedir(), "Moco"));
    expect(pairingRequest?.inviteToken).toBe("single-use-invitation");
    expect(pairingRequest?.info).toMatchObject({ hostname: os.hostname() });
    fs.rmSync(file);
    returnedUrl = "https://different-host.invalid";
    await expect(installDevicePeer({ hubUrl: url, inviteToken: "second-invitation", configPath: file })).rejects.toThrow("不同的服务地址");
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("joined device local access", () => {
  it("releases the requested listener when the execution workspace cannot start", async () => {
    const reserved = http.createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
    const address = reserved.address();
    if (!address || typeof address === "string") throw new Error("Missing reserved port");
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const bad = path.join(temporary(), "file");
    fs.writeFileSync(bad, "not a workspace");
    await expect(startDevicePeer({ ...peerConfig("http://127.0.0.1:9"), rootDir: bad }, { port: address.port })).rejects.toThrow();
    const replacement = http.createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(address.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });
  it("owns one Env registration and finds its actual port across concurrent opens", async () => {
    const hub = await fakeHub();
    const config = peerConfig(hub.url);
    savePeerConfig(config);
    const token = "peer-test-local-auth";
    const launching = startDevicePeer(config, { port: 0, authToken: token });
    await expect(startDevicePeer(config, { port: 0, authToken: token })).rejects.toBeInstanceOf(DevicePeerInUseError);
    const finding = findRunningDevicePeer(config, 0, token);
    const peer = await launching;
    cleanup.push(() => peer.close());
    await peer.ready;
    expect(await finding).toEqual({ url: peer.url, authToken: token });
    expect(await findRunningDevicePeer(config, 1, token)).toEqual({ url: peer.url, authToken: token });
    await expect(findRunningDevicePeer(config, 0, "different-local-auth")).rejects.toThrow("管理密钥");
    await expect(findRunningDevicePeer(config, 0)).rejects.toThrow("管理密钥");
    expect(hub.registrations).toHaveLength(1);
    await peer.close();
    const next = await startDevicePeer(config, { port: 0 });
    cleanup.push(() => next.close());
    await next.ready;
    expect(await findRunningDevicePeer(config, 0, token)).toEqual({ url: next.url, authToken: next.authToken, omitLocalToken: true });
    expect(await findRunningDevicePeer(config, 0)).toEqual({ url: next.url, authToken: next.authToken });
  });

  it("uses separate client and Env credentials, enforces local proxy auth by default, and keeps execution connected after closing a browser", async () => {
    const hub = await fakeHub();
    const config = peerConfig(hub.url);
    const peer = await startDevicePeer(config);
    cleanup.push(() => peer.close());
    await peer.ready;
    expect(hub.registrations[0]).toMatchObject({ envId: config.deviceId, token: config.envToken, info: { hostname: os.hostname() } });
    // Unauthenticated local requests must be rejected rather than silently borrowing clientToken.
    expect((await fetch(`${peer.url}/api/topics`)).status).toBe(401);
    expect((await fetch(`${peer.url}/api/topics?token=wrong`, { headers: { authorization: "Bearer incoming-untrusted" } })).status).toBe(401);
    const response = await fetch(`${peer.url}/api/topics?token=ignored`, {
      headers: { authorization: `Bearer ${peer.authToken}`, cookie: "untrusted=1" },
    });
    expect(response.status).toBe(200);
    expect(hub.requests.at(-1)).toEqual({ authorization: `Bearer ${config.clientToken}`, cookie: undefined, url: "/api/topics" });
    const status = await fetch(`${peer.url}/_moco/peer-status`, {
      headers: { authorization: `Bearer ${peer.authToken}` },
    }).then((result) => result.text());
    expect(status).not.toContain(config.envToken);
    expect(status).not.toContain(config.clientToken);
    const browser = await client(peer.url, peer.authToken);
    const closed = new Promise<void>((resolve) => browser.once("close", () => resolve()));
    browser.close();
    await closed;
    expect(hub.envSockets.size).toBe(1);
  });

  it("shares one conversation stream across device interfaces and reconnects to the saved Hub", async () => {
    const hub = await fakeHub();
    const configA = peerConfig(hub.url, "peer-a");
    const configB = peerConfig(hub.url, "peer-b");
    const peerA = await startDevicePeer(configA);
    const peerB = await startDevicePeer(configB);
    cleanup.push(() => peerA.close(), () => peerB.close());
    await Promise.all([peerA.ready, peerB.ready]);
    const browserA = await client(peerA.url, peerA.authToken);
    const browserB = await client(peerB.url, peerB.authToken);
    const receivedA = nextMessage(browserA);
    const receivedB = nextMessage(browserB);
    browserA.send("same conversation");
    expect(await receivedA).toEqual({ conversations: ["same conversation"] });
    expect(await receivedB).toEqual({ conversations: ["same conversation"] });
    await peerA.close();
    const file = path.join(temporary(), "connection.json");
    savePeerConfig(configA, file);
    const resumed = await startDevicePeer(readPeerConfig(file)!);
    cleanup.push(() => resumed.close());
    await resumed.ready;
    const response = await fetch(`${resumed.url}/api/topics`, {
      headers: { authorization: `Bearer ${resumed.authToken}` },
    }).then((result) => result.json());
    expect(response).toEqual({ items: [], conversations: ["same conversation"] });
    expect(hub.registrations.filter((entry) => entry.envId === "peer-a")).toHaveLength(2);
  });

  it("rejects browser cross-origin requests and hostile Host headers", async () => {
    const hub = await fakeHub();
    const peer = await startDevicePeer(peerConfig(hub.url));
    cleanup.push(() => peer.close());
    await peer.ready;
    const initialRequests = hub.requests.length;
    const origin = await fetch(`${peer.url}/api/topics`, { method: "POST", headers: { origin: "https://untrusted.invalid" } });
    expect(origin.status).toBe(403);
    const rebinding = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(`${peer.url}/api/topics`, { headers: { host: "untrusted.invalid" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
    });
    expect(rebinding).toBe(403);
    expect(hub.requests).toHaveLength(initialRequests);
  });

  it("rejects raw authority-confusing paths before attaching credentials to HTTP or WebSocket requests", async () => {
    const hub = await fakeHub();
    const leakedCredentials: Array<string | undefined> = [];
    const attacker = http.createServer((request, response) => {
      leakedCredentials.push(request.headers.authorization);
      response.writeHead(200).end("untrusted destination");
    });
    attacker.on("upgrade", (request, socket) => {
      leakedCredentials.push(request.headers.authorization);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
    const attackerUrl = await listen(attacker);
    const peer = await startDevicePeer(peerConfig(hub.url));
    cleanup.push(() => peer.close());
    await peer.ready;
    const initialRequests = hub.requests.length;
    const target = new URL(attackerUrl).host;
    for (const upgrade of [false, true]) {
      for (const ambiguousPath of [`/\\${target}/ws/client`, `//${target}/ws/client`, `/\\\\${target}/ws/client`]) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const request = http.request(peer.url, {
            path: ambiguousPath,
            headers: upgrade ? {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
            } : undefined,
          }, (response) => {
            response.resume();
            resolve(response.statusCode);
          });
          request.on("error", reject);
          request.end();
        });
        expect(status).toBe(403);
      }
    }
    expect(leakedCredentials).toEqual([]);
    expect(hub.requests).toHaveLength(initialRequests);
  });

  it("does not report a successful join when execution works but shared UI authentication fails", async () => {
    const hub = await fakeHub({ clientHttpStatus: 401 });
    const peer = await startDevicePeer(peerConfig(hub.url));
    cleanup.push(() => peer.close());
    await expect(peer.ready).rejects.toThrow("HTTP 401");
    expect(hub.registrations).toHaveLength(1);
    const status = await fetch(`${peer.url}/_moco/peer-status`, {
      headers: { authorization: `Bearer ${peer.authToken}` },
    }).then((result) => result.json());
    expect(status).toMatchObject({ ready: false, error: "执行端已连接，但主脑拒绝了界面访问（HTTP 401）。" });
  });

  it("clears an initial UI failure when the same saved main brain recovers", async () => {
    const availability = { clientHttpStatus: 503 };
    const hub = await fakeHub(availability);
    const peer = await startDevicePeer(peerConfig(hub.url));
    cleanup.push(() => peer.close());
    await expect(peer.ready).rejects.toThrow("HTTP 503");
    const failed = await fetch(`${peer.url}/_moco/peer-status`, {
      headers: { authorization: `Bearer ${peer.authToken}` },
    }).then((result) => result.json());
    expect(failed.ready).toBe(false);
    availability.clientHttpStatus = 200;
    await vi.waitFor(async () => {
      const recovered = await fetch(`${peer.url}/_moco/peer-status`, {
        headers: { authorization: `Bearer ${peer.authToken}` },
      }).then((result) => result.json());
      expect(recovered.ready).toBe(true);
      expect(recovered.error).toBeUndefined();
    }, { timeout: 3_000, interval: 50 });
    expect(hub.registrations).toHaveLength(1);
  });

  it("installs the standalone bundle outside the workspace and reuses its saved main brain", async () => {
    const directory = temporary();
    const runtimeDirectory = path.join(directory, ".moco/runtime");
    fs.mkdirSync(path.join(runtimeDirectory, "node_modules/@earendil-works"), { recursive: true });
    await buildPeer({ outfile: path.join(runtimeDirectory, "peer.mjs") });
    // Only the downloaded bundle is installed; execution must not depend on adjacent native resources.
    fs.rmSync(path.join(runtimeDirectory, "macos-worker-cleanup"), { force: true });
    for (const name of ["ws", "@earendil-works/pi-env"]) {
      fs.symlinkSync(fs.realpathSync(path.resolve("node_modules", name)), path.join(runtimeDirectory, "node_modules", name), "junction");
    }
    const addressProbe = http.createServer();
    await new Promise<void>((resolve) => addressProbe.listen(0, "127.0.0.1", resolve));
    const address = addressProbe.address();
    if (!address || typeof address === "string") throw new Error("Missing probe address");
    await new Promise<void>((resolve, reject) => addressProbe.close((error) => error ? reject(error) : resolve()));
    const localPort = address.port;
    const config = { ...peerConfig("http://127.0.0.1", "installed-peer"), rootDir: "~/Moco", localPort };
    let uiStatus = 200;
    let replacementPid: number | undefined;
    let rejectReplacement = false;
    let replacementUiDown = false;
    let oldPeerWasAliveAtRedemption = false;
    const server = http.createServer((request, response) => {
      if (request.url === "/api/devices/pair" && replacementPid) {
        process.kill(replacementPid, 0);
        oldPeerWasAliveAtRedemption = true;
        if (rejectReplacement) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "配对凭证已失效。" }));
          return;
        }
        config.deviceId = "replacement-peer";
        uiStatus = replacementUiDown ? 503 : 200;
      }
      response.writeHead(request.url === "/api/topics" ? uiStatus : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/topics" ? { items: [] } : config));
    });
    // The pairing server and the shared Hub must have the same credential destination.
    const pairUrl = await listen(server);
    config.hubUrl = pairUrl;
    const installWss = new WebSocketServer({ noServer: true });
    let executionSocket: WebSocket | undefined;
    let executionBytes = Buffer.alloc(0);
    let executionError: string | undefined;
    server.on("upgrade", (request, socket, head) => {
      installWss.handleUpgrade(request, socket, head, (ws) => {
        executionSocket = ws;
        ws.on("message", (raw, binary) => {
          if (binary) {
            const frame = decodeStreamChunk(raw as Buffer);
            if (frame.streamId === 77) executionBytes = Buffer.concat([executionBytes, frame.payload]);
            return;
          }
          const data = JSON.parse(raw.toString("utf8"));
          if (data.type === "env.register") ws.send(JSON.stringify({ type: "hub.registered", envId: data.envId }));
          if (data.type === "env.stream_closed" && data.streamId === 77) executionError = data.error || `Worker exited (${data.code})`;
        });
      });
    });
    cleanup.push(() => { for (const client of installWss.clients) client.terminate(); installWss.close(); });
    const configPath = path.join(directory, ".moco/connection.json");
    const entry = path.join(runtimeDirectory, "peer.mjs");
    const installEnvironment = { ...process.env, HOME: directory, MOCO_PEER_CONFIG: configPath };
    const runInstaller = async () => {
      const install = spawn(process.execPath, [entry, "install", "--hub", pairUrl, "--invite", "installation-invitation", "--config", configPath], {
        cwd: directory,
        env: installEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostics = "";
      install.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => {
        install.once("exit", resolve);
        install.once("error", reject);
      });
      return { code, diagnostics };
    };
    const { code, diagnostics } = await runInstaller();
    const saved = readPeerConfig(configPath);
    expect(code, diagnostics).toBe(0);
    expect(saved).toMatchObject({ deviceId: "installed-peer", hubUrl: pairUrl, rootDir: path.join(directory, "Moco") });
    expect(saved!.rootDir.startsWith(path.dirname(configPath) + path.sep)).toBe(false);
    const peerHeaders = (peerCfg: DevicePeerConfig) => ({ authorization: `Bearer ${localPeerProxyToken(peerCfg)}` });
    const status = await fetch(`http://127.0.0.1:${localPort}/_moco/peer-status`, { headers: peerHeaders(saved!) }).then((result) => result.json()) as { pid: number; ready: boolean };
    let activePid = status.pid;
    const stopActivePeer = async () => {
      const pidFile = path.join(directory, ".moco/peer.pid");
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : activePid;
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && fs.existsSync(path.join(directory, ".moco/peer.pid"))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    cleanup.push(stopActivePeer);
    expect(status.ready).toBe(true);
    const launcher = process.platform === "win32" ? ".moco/bin/moco.cmd" : ".local/bin/moco";
    expect(fs.existsSync(path.join(directory, launcher))).toBe(true);

    if (process.platform === "darwin") {
      const workspace = path.join(saved!.rootDir, "table", "first-task");
      const outputFile = path.join(workspace, "completed.txt");
      const daemonToken = "00112233445566778899aabbccddeeff";
      executionSocket!.send(JSON.stringify({ type: "hub.open_stream", streamId: 77, daemonToken, workspaceDir: workspace }));
      await vi.waitFor(() => {
        if (executionError) throw new Error(executionError);
        expect(executionBytes.toString("utf8")).toContain(`PI-ENV ${daemonToken}\n`);
      }, { timeout: 5_000, interval: 30 });
      const requestFrame = (id: number, data: Record<string, unknown>, payload = Buffer.alloc(0)) => {
        const json = Buffer.from(JSON.stringify(data));
        const frame = Buffer.alloc(13 + json.length + payload.length);
        frame.writeUInt32BE(frame.length - 4, 0);
        frame[4] = 1;
        frame.writeUInt32BE(id, 5);
        frame.writeUInt32BE(json.length, 9);
        json.copy(frame, 13);
        payload.copy(frame, 13 + json.length);
        executionSocket!.send(encodeStreamChunk(77, frame));
      };
      requestFrame(1, { op: "hello", protocol: 1 });
      requestFrame(2, { op: "write", path: outputFile, parents: true }, Buffer.from("completed on the joined device"));
      await vi.waitFor(() => {
        if (executionError) throw new Error(executionError);
        expect(fs.readFileSync(outputFile, "utf8")).toBe("completed on the joined device");
      }, { timeout: 5_000, interval: 30 });
      const protectedConfig = fs.readFileSync(configPath, "utf8");
      requestFrame(3, { op: "write", path: configPath, parents: true }, Buffer.from("overwritten"));
      await vi.waitFor(() => {
        let offset = executionBytes.indexOf(0x0a) + 1;
        let denied = false;
        while (offset + 13 <= executionBytes.length) {
          const length = executionBytes.readUInt32BE(offset);
          if (offset + 4 + length > executionBytes.length) break;
          const type = executionBytes[offset + 4];
          const id = executionBytes.readUInt32BE(offset + 5);
          if (type === 3 && id === 3) denied = true;
          offset += 4 + length;
        }
        expect(denied).toBe(true);
      }, { timeout: 5_000, interval: 30 });
      expect(fs.readFileSync(configPath, "utf8")).toBe(protectedConfig);
      executionSocket!.send(JSON.stringify({ type: "hub.close_stream", streamId: 77 }));
    }

    await stopActivePeer();
    uiStatus = 503;
    const failedPeer = spawn(process.execPath, [entry, "start", "--config", configPath], {
      cwd: directory, env: installEnvironment, stdio: "ignore",
    });
    if (!failedPeer.pid) throw new Error("Peer did not start");
    activePid = failedPeer.pid;
    await vi.waitFor(async () => {
      const failedStatus = await fetch(`http://127.0.0.1:${localPort}/_moco/peer-status`, { headers: peerHeaders(readPeerConfig(configPath)!) }).then((result) => result.json());
      expect(failedStatus.error).toContain("HTTP 503");
    }, { timeout: 3_000, interval: 30 });
    replacementPid = failedPeer.pid;
    rejectReplacement = true;
    const rejected = await runInstaller();
    expect(rejected.code).toBe(1);
    expect(rejected.diagnostics).toContain("请在目标主机重新复制邀请");
    expect(oldPeerWasAliveAtRedemption).toBe(true);
    process.kill(activePid, 0);
    expect(readPeerConfig(configPath)?.deviceId).toBe("installed-peer");
    rejectReplacement = false;
    replacementUiDown = true;
    const unready = await runInstaller();
    expect(unready.code, unready.diagnostics).toBe(1);
    expect(readPeerConfig(configPath)?.deviceId).toBe("installed-peer");
    const restored = await fetch(`http://127.0.0.1:${localPort}/_moco/peer-status`, { headers: peerHeaders(readPeerConfig(configPath)!) }).then((result) => result.json());
    expect(restored.deviceId).toBe("installed-peer");
    activePid = restored.pid;
    replacementPid = restored.pid;
    replacementUiDown = false;
    uiStatus = 200;
    const replaced = await runInstaller();
    expect(replaced.code, replaced.diagnostics).toBe(0);
    const replacement = await fetch(`http://127.0.0.1:${localPort}/_moco/peer-status`, { headers: peerHeaders(readPeerConfig(configPath)!) }).then((result) => result.json());
    activePid = replacement.pid;
    expect(replacement).toMatchObject({ deviceId: "replacement-peer", ready: true });
    expect(readPeerConfig(configPath)?.deviceId).toBe("replacement-peer");
  });
});
