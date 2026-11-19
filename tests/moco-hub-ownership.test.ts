import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { MocoStateDoc, startMocoHubServer } from "@moco/hub";
import { claimMocoRuntime, discoverMocoRuntime, savePeerConfig, startDevicePeer } from "@moco/env";
import { findRunningHub, HubStateInUseError, HubStateOwner } from "../packages/hub/src/state-owner";
import { SettingsAssistant } from "../packages/hub/src/settings-assistant";
import { openTestHub } from "./helpers/secure-hub";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth";

const close: Array<() => unknown> = [];
let directory: string;

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((filename) => path.basename(String(filename)) !== ".env" && exists(filename));
  for (const key of ["MOCO_ENV_TOKENS", "MOCO_MODEL", "MOCO_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(key, "");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-owner-test-"));
  close.push(() => fs.rmSync(directory, { force: true, recursive: true }));
});
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function openHub(port = 0) {
  const models = createModels();
  const provider = fauxProvider({ provider: "openai", models: [{ id: "ownership-test" }] });
  models.setProvider(provider.provider);
  return openTestHub({ models, config: {
    stateDir: directory, identityDir: path.join(directory, "identity"), authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {},
    port, enableLocalEnv: true, localEnvRoot: path.join(directory, "workspace"), workerEnvIds: [], memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "ownership-test", thinkingLevel: "off" }, watchdogMinutes: 0,
  } });
}

function cliOpenInvocation(args: string[]) {
  // Run the CLI against the same source as Vitest even when dist belongs to an older build.
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const packages = new URL("../packages/", import.meta.url).href;
  const script = `
    import { registerHooks } from "node:module";
    const root = ${JSON.stringify(packages)};
    registerHooks({ resolve(id, context, next) {
      return next(id.startsWith("@moco/") ? new URL(id.slice(6) + "/src/index.ts", root).href : id, context);
    } });
    process.argv = [process.execPath, "moco", "open", ...${JSON.stringify(args)}];
    await import(new URL("cli/src/bin.ts", root));
  `;
  return { args: ["--import", loader, "--input-type=module", "-e", script], cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, MOCO_STATE_DIR: directory, MOCO_PEER_CONFIG: path.join(directory, "peer", "connection.json"), MOCO_AUTH_TOKEN: HUB_TEST_ADMIN_TOKEN } };
}

function runCliOpen(input: string[]) {
  const { args, cwd, env } = cliOpenInvocation(input);
  return promisify(execFile)(process.execPath, args, { cwd, env, timeout: 15000 });
}

describe("Hub state ownership", () => {
  it("fences even an aliased data directory across processes and allows takeover after a killed owner", async () => {
    const root = path.join(directory, "state");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(root);
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const source = new URL("../packages/env/src/local-instance.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { LocalInstanceOwner } from ${JSON.stringify(source)};
      const owner = LocalInstanceOwner.acquire({ directory: process.argv[1], name: "hub" }, "busy");
      process.send("ready");
      process.on("message", () => owner.close());
    `, root], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "exit");
    close.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    await expect(Promise.race([once(child, "message"), exited.then(() => { throw new Error("Owner exited before acquiring the directory"); })])).resolves.toMatchObject({ 0: "ready" });
    expect(() => HubStateOwner.acquire(alias)).toThrow(HubStateInUseError);
    const other = HubStateOwner.acquire(path.join(directory, "other"));
    other.close();
    child.kill("SIGKILL");
    await exited;
    const next = HubStateOwner.acquire(alias);
    next.close();
  });

  it("rejects a second Hub before migration or recovery and publishes the existing authenticated console", async () => {
    const hub = await openHub();
    close.push(() => hub.close());
    const opening = findRunningHub(directory, HUB_TEST_ADMIN_TOKEN);
    const server = await startMocoHubServer(hub, { host: "localhost", port: 0 });
    close.push(() => server.close());
    const ticket = await hub.dispatchTicket({ commandId: "state-owner-fence", title: "Later", goal: "wait", scope: directory, role: "coder",
      executeAt: new Date(Date.now() + 86_400_000).toISOString() });
    const epoch = (await hub.harness.snapshot(MocoStateDoc, BACKGROUND_CONTEXT))!.tickets[ticket.id]!.runEpoch;
    const marker = path.join(directory, "state-version.json");
    const validMarker = fs.readFileSync(marker);
    fs.writeFileSync(marker, "invalid-if-opened");
    try {
      await expect(openHub(server.port + 1)).rejects.toBeInstanceOf(HubStateInUseError);
      expect((await hub.harness.snapshot(MocoStateDoc, BACKGROUND_CONTEXT))!.tickets[ticket.id]!.runEpoch).toBe(epoch);
    } finally { fs.writeFileSync(marker, validMarker); }
    const url = await opening;
    expect(url?.origin).toBe(server.localUrl);
    expect(url?.searchParams.get("token")).toBe(HUB_TEST_ADMIN_TOKEN);
    await expect(findRunningHub(directory, "another-test-token")).rejects.toThrow("管理密钥");
    await expect(findRunningHub(directory)).rejects.toThrow("管理密钥");
    expect(fs.readFileSync(path.join(directory, "hub-endpoint.json"), "utf8")).not.toContain(HUB_TEST_ADMIN_TOKEN);

    const { stdout } = await runCliOpen(["--standalone", "--no-open"]);
    expect(stdout).toContain("Moco 已在运行");
    expect(stdout).toContain(server.localUrl);
    expect(stdout).not.toContain(HUB_TEST_ADMIN_TOKEN);
  });

  it("keeps the profile claimed across a Hub-to-peer listener gap and reopens the offline peer", async () => {
    const owner = claimMocoRuntime(directory);
    close.push(() => owner.close());
    const hub = await openHub();
    close.push(() => hub.close());
    const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0, runtimeOwner: owner });
    expect((await discoverMocoRuntime(directory, HUB_TEST_ADMIN_TOKEN))?.status.role).toBe("hub");
    await server.close();
    await hub.close();
    expect(() => claimMocoRuntime(directory)).toThrow("已在运行");
    const finding = discoverMocoRuntime(directory, HUB_TEST_ADMIN_TOKEN);
    // At this point the pairing has not yet been activated and the Hub's own data lock is free.
    const cli = runCliOpen(["--standalone", "--no-open"]);
    const configPath = path.join(directory, "peer", "connection.json");
    const config = { version: 1 as const, deviceId: "test-peer", name: "Test", hubUrl: "http://127.0.0.1:9",
      envToken: "test-remote-env", clientToken: "test-remote-client", rootDir: path.join(directory, "workspace"), localPort: 0 };
    const peer = await startDevicePeer(config, { configPath, port: 0, authToken: HUB_TEST_ADMIN_TOKEN, runtimeOwner: owner });
    close.push(() => peer.close());
    const target = await finding;
    expect(target?.status).toMatchObject({ role: "joined", ready: false });
    expect(target?.url.origin).toBe(peer.url);
    const { stdout } = await cli;
    expect(stdout).toContain(peer.url);
    expect(stdout).not.toContain(HUB_TEST_ADMIN_TOKEN);
    savePeerConfig(config, configPath);
    const reopened = await runCliOpen(["--no-open", "--port", "0"]);
    expect(reopened.stdout).toContain(peer.url);
  });

  it("does not give a stale listener any browser credential and can retry startup after the owner exits", async () => {
    const owner = HubStateOwner.acquire(directory);
    close.push(() => owner.close());
    const requests: string[] = [];
    const unrelated = http.createServer((req, res) => { requests.push(JSON.stringify([req.url, req.headers])); res.end("ok"); });
    unrelated.listen(0, "127.0.0.1");
    await once(unrelated, "listening");
    close.push(() => new Promise<void>((resolve) => unrelated.close(() => resolve())));
    const address = unrelated.address();
    if (!address || typeof address === "string") throw new Error("Expected a listening port");
    const unpublish = owner.publish(address);
    await expect(findRunningHub(directory, HUB_TEST_ADMIN_TOKEN, 30)).rejects.toThrow("暂未就绪");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.join("")).not.toContain(HUB_TEST_ADMIN_TOKEN);
    unpublish();
    const waiting = findRunningHub(directory, HUB_TEST_ADMIN_TOKEN, 2000);
    owner.close();
    expect(await waiting).toBeUndefined();
  });

  it("concurrent paired CLI opens on random ports converge on one surviving process", async () => {
    const config = { version: 1 as const, deviceId: "concurrent-open", name: "Test", hubUrl: "http://127.0.0.1:9",
      envToken: "test-remote-env", clientToken: "test-remote-client", rootDir: path.join(directory, "workspace"), localPort: 0 };
    savePeerConfig(config, path.join(directory, "peer", "connection.json"));
    const { args, cwd, env } = cliOpenInvocation(["--no-open", "--port", "0"]);
    const attempts = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      const exited = once(child, "exit");
      close.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const fallback = setTimeout(() => child.kill("SIGKILL"), 2000);
        try { await exited; } finally { clearTimeout(fallback); }
      });
      return { child, output: () => output };
    });
    await vi.waitFor(() => expect(attempts.filter(({ child }) => child.exitCode === 0)).toHaveLength(1), { timeout: 12000 });
    const running = await discoverMocoRuntime(directory, HUB_TEST_ADMIN_TOKEN);
    expect(running?.status).toMatchObject({ role: "joined", pid: attempts.find(({ child }) => child.exitCode === null)?.child.pid });
    for (const attempt of attempts) {
      expect(attempt.output()).toContain(running!.url.origin);
      expect(attempt.output()).not.toContain(HUB_TEST_ADMIN_TOKEN);
    }
  }, 18000);

  it("allows a corrected startup immediately after a failed migration", async () => {
    const marker = path.join(directory, "state-version.json");
    fs.writeFileSync(marker, JSON.stringify({ version: 999, preparedAt: 1 }));
    await expect(openHub()).rejects.toThrow("newer version");
    fs.unlinkSync(marker);
    const recovered = await openHub();
    await Promise.all([recovered.close(withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)), recovered.close()]);
    const reopened = await openHub();
    await reopened.close();
  });

  it("shuts down a partially initialized Hub before releasing ownership for a retry", async () => {
    vi.spyOn(SettingsAssistant.prototype, "start").mockRejectedValueOnce(new Error("test readiness failure"));
    await expect(openHub()).rejects.toThrow("test readiness failure");
    const recovered = await openHub();
    await recovered.close();
  });
});
