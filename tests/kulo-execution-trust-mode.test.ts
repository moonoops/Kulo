import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  TRUSTED_HOST_EXECUTION_CAPABILITY,
  isWorkerEnvReady,
  resolveEffectiveExecutionMode,
  type ComputerUseResult,
  type EnvNodeDescriptor,
  type ExecutionTrustMode,
} from "@kulo/protocol";
import {
  ComputerUseService,
  TrustedLocalExecutionEnv,
  buildSafeMcpDiscoveryEnv,
  buildTrustedHostEnv,
  createTrustedWorkerSession,
  stripBlockedEnv,
} from "@kulo/env";
import {
  scopeComputerUseForTarget,
  scopeHostActionForTarget,
} from "../packages/env/src/bridge-execution-env.js";
import { supervisedCommand } from "../packages/env/src/worker-supervisor.js";
import {
  FileCredentialStore,
  KuloConnections,
  KuloSettingsDoc,
  KuloStateDoc,
  LocalConnectionVault,
  startKuloHubServer,
  type KuloHubConfigOverrides,
} from "@kulo/hub";
import { KuloSearch } from "../packages/hub/src/search.js";
import {
  applyExecutorBlockUpdate,
  createFreshExecutorConfig,
  normalizeExecutorConfig,
  resolveRollbackExecutorConfig,
} from "../packages/hub/src/settings-executor.js";
import { handleSettingsProvidersRoutes } from "../packages/hub/src/http/settings-providers-routes.js";
import { createMcpFetch } from "../packages/hub/src/mcp-fetch.js";
import { McpConnectionPool } from "../packages/hub/src/mcp-connections.js";
import { McpOAuthRefreshLockManager } from "../packages/hub/src/mcp-oauth.js";
import {
  isCloudMetadataHostOrIp,
  isPrivateOrLoopbackHost,
  prepareSafeHttpRedirect,
} from "../packages/hub/src/net-policy.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeKeyStore() {
  let key: Buffer | null = null;
  return {
    getOrCreateKey: async () => {
      key ??= Buffer.alloc(32, 0x42);
      return key;
    },
    readKey: async () => key,
    deleteKey: async () => { key = null; },
  };
}

function fakeDescriptor(overrides: Partial<EnvNodeDescriptor> = {}): EnvNodeDescriptor {
  return {
    id: "remote-1",
    name: "Remote Mac",
    kind: "remote",
    rootDir: "/tmp/remote",
    platform: "darwin",
    arch: "arm64",
    online: true,
    capabilities: ["fs", "bash", "worker-isolation", "worker-isolation-macos", TRUSTED_HOST_EXECUTION_CAPABILITY],
    ...overrides,
  };
}

function makeTestModels() {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "trust-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  return { provider, models };
}

async function openTrustHub(dir: string, overrides: Partial<KuloHubConfigOverrides> = {}) {
  const { provider, models } = makeTestModels();
  const hub = await openTestHub({
    models,
    config: {
      stateDir: path.join(dir, "state"),
      identityDir: path.join(dir, "identity"),
      localEnvRoot: path.join(dir, "env"),
      authToken: HUB_TEST_ADMIN_TOKEN,
      enableLocalEnv: true,
      watchdogMinutes: 0,
      memory: { enabled: false },
      model: { defaultProvider: "openai", defaultModel: "trust-model", thinkingLevel: "off", apiKey: "" },
      ...overrides,
    },
  });
  cleanups.push(() => hub.close());
  return { hub, provider, models };
}

function fakeHttpPair(method: string, pathname: string, body: unknown) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as unknown as http.IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) };
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string | Buffer) { if (chunk) responseBody += chunk.toString(); return res; },
    setHeader() {},
  } as unknown as http.ServerResponse;
  return { req, res, getStatus: () => status, getBody: () => (responseBody ? JSON.parse(responseBody) : undefined) };
}

describe("C1: Upgrade, migration, rollback, Owner gate, and failover guard", () => {
  it("defaults fresh installs to explicit trusted, legacy DB without field to sandboxed, preserves omitted field, rejects invalid enum, and takes stricter mode on legacy rollback", async () => {
    const fresh = createFreshExecutorConfig({ maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, watchdogMinutes: 5 });
    expect(fresh.executionTrustMode).toBe("trusted");

    const legacy = normalizeExecutorConfig(
      { maxConcurrentWorkers: 6, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 10 },
      3, 5, 4, 3, "sandboxed",
    );
    expect(legacy.executionTrustMode).toBe("sandboxed");

    // Omitting executionTrustMode on update preserves current value
    const preserved = applyExecutorBlockUpdate(
      fresh,
      { maxConcurrentWorkers: 4, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 },
    );
    expect(preserved.next.executionTrustMode).toBe("trusted");

    // Invalid enum rejected with 400
    expect(() =>
      applyExecutorBlockUpdate(fresh, { ...fresh, executionTrustMode: "root_all" }),
    ).toThrow(/执行权限/);

    // Rollback to legacy snapshot lacking executionTrustMode takes stricter mode (never widens)
    const legacySnapshot = { maxConcurrentWorkers: 2, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 };
    expect(resolveRollbackExecutorConfig(legacySnapshot, { ...fresh, executionTrustMode: "trusted" }).next.executionTrustMode).toBe("sandboxed");
    expect(resolveRollbackExecutorConfig(legacySnapshot, { ...fresh, executionTrustMode: "sandboxed" }).next.executionTrustMode).toBe("sandboxed");

    // Full Hub persistence: simulate legacy DB lacking executionTrustMode, reopen -> hydrates to sandboxed
    const dir = tempDir("kulo-c1-legacy-");
    const first = await openTrustHub(dir);
    expect(first.hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("trusted");
    await first.hub.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      delete (doc.executor as { executionTrustMode?: ExecutionTrustMode }).executionTrustMode;
    }, context);
    await first.hub.close();

    const reopened = await openTrustHub(dir);
    expect(reopened.hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("sandboxed");
  });

  it("forces sandboxed mode on unplanned failover promotion via failover-trust-guard.json", async () => {
    const dir = tempDir("kulo-c1-failover-");
    const first = await openTrustHub(dir);
    expect(first.hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("trusted");
    await first.hub.close();

    const guardPath = path.join(dir, "state", "failover-trust-guard.json");
    fs.writeFileSync(guardPath, JSON.stringify({ forceMode: "sandboxed", createdAt: Date.now() }));

    const promoted = await openTrustHub(dir);
    expect(promoted.hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("sandboxed");
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("rejects non-Owner and SSH principals on executionTrustMode change or widening rollback (403) and rejects invalid enum (400)", async () => {
    const dir = tempDir("kulo-c1-owner-");
    const { hub } = await openTrustHub(dir);
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    // Owner (local Bearer token) can switch trusted -> sandboxed
    const v1 = hub.getSettingsView();
    const downRes = await fetch(`${server.url}/api/settings/executor`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: v1.blocks.executor.revision,
        value: { ...v1.blocks.executor.value, executionTrustMode: "sandboxed" },
      }),
    });
    expect(downRes.status).toBe(200);
    expect(hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("sandboxed");

    // Invalid enum returns 400
    const v2 = hub.getSettingsView();
    const invalidRes = await fetch(`${server.url}/api/settings/executor`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: v2.blocks.executor.revision,
        value: { ...v2.blocks.executor.value, executionTrustMode: "invalid_mode" },
      }),
    });
    expect(invalidRes.status).toBe(400);

    // Non-Owner principal AND SSH principal are both blocked (403) on mode change & sandboxed rollback
    for (const authority of [
      { hasOwnerHubControl: false, isSshPrincipal: false },
      { hasOwnerHubControl: true, isSshPrincipal: true },
    ]) {
      const modeCall = fakeHttpPair("POST", "/api/settings/executor", {
        expectedRevision: v2.blocks.executor.revision,
        value: { ...v2.blocks.executor.value, executionTrustMode: "trusted" },
      });
      await handleSettingsProvidersRoutes({
        hub,
        req: modeCall.req,
        res: modeCall.res,
        pathname: "/api/settings/executor",
        authority: authority as never,
        readJsonBody: async () => ({
          expectedRevision: v2.blocks.executor.revision,
          value: { ...v2.blocks.executor.value, executionTrustMode: "trusted" },
        }),
        sendJson: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); },
      } as never);
      expect(modeCall.getStatus()).toBe(403);

      const trustSnapshotRevision = v2.history[0]!.revision;
      const rollbackCall = fakeHttpPair("POST", "/api/settings/rollback", {
        toRevision: trustSnapshotRevision,
        expectedGlobalRevision: v2.globalRevision,
      });
      await expect(
        handleSettingsProvidersRoutes({
          hub,
          req: rollbackCall.req,
          res: rollbackCall.res,
          pathname: "/api/settings/rollback",
          authority: authority as never,
          readJsonBody: async () => ({
            toRevision: trustSnapshotRevision,
            expectedGlobalRevision: v2.globalRevision,
          }),
          sendJson: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); },
        } as never),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("sandboxed");
  });
});

describe("C2: Zero env.json on disk, custom Hindsight key stripping, inheritEnv:false, and safe Stdio MCP discovery env", () => {
  it("strips built-in and custom Hindsight env var names in final pass, respects inheritEnv:false, and leaves zero env.json files", async () => {
    const sourceEnv: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "gh-user-token-kept-in-trusted",
      KULO_AUTH_TOKEN: "kulo-secret-token",
      KULO_HINDSIGHT_API_KEY: "kulo-hindsight-default",
      CUSTOM_ROUTER_SECRET: "custom-router-val",
      CUSTOM_WORKER_SECRET: "custom-worker-val",
      CUSTOM_SHARED_SECRET: "custom-shared-val",
    };

    const trusted = buildTrustedHostEnv({
      sourceEnv,
      blockedEnvNames: ["CUSTOM_ROUTER_SECRET", "CUSTOM_WORKER_SECRET", "CUSTOM_SHARED_SECRET"],
      extraEnv: {
        CUSTOM_ROUTER_SECRET: "should-never-survive",
        USER_TOOL_FLAG: "1",
      },
    });
    expect(trusted.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(trusted.GH_TOKEN).toBe("gh-user-token-kept-in-trusted");
    expect(trusted.USER_TOOL_FLAG).toBe("1");
    expect(trusted.KULO_AUTH_TOKEN).toBeUndefined();
    expect(trusted.KULO_HINDSIGHT_API_KEY).toBeUndefined();
    expect(trusted.CUSTOM_ROUTER_SECRET).toBeUndefined();
    expect(trusted.CUSTOM_WORKER_SECRET).toBeUndefined();
    expect(trusted.CUSTOM_SHARED_SECRET).toBeUndefined();

    // stripBlockedEnv is case-insensitive
    const stripped = stripBlockedEnv({ custom_router_secret: "x", KEEP: "y" }, ["CUSTOM_ROUTER_SECRET"]);
    expect(stripped).toEqual({ KEEP: "y" });

    // TrustedLocalExecutionEnv respects inheritEnv: false
    const workDir = tempDir("kulo-c2-inherit-");
    vi.stubEnv("SYNTHETIC_HOST_LEAK_CANARY", "must-not-leak-when-inherit-false");
    const env = new TrustedLocalExecutionEnv({
      id: "trusted-test",
      cwd: workDir,
      blockedEnvNames: () => ["CUSTOM_ROUTER_SECRET"],
    });
    let captured = "";
    const res = await env.exec(
      [process.execPath, "-e", "process.stdout.write(JSON.stringify({ canary: process.env.SYNTHETIC_HOST_LEAK_CANARY ?? null, custom: process.env.EXPLICIT_ONLY ?? null }))"],
      { inheritEnv: false, env: { EXPLICIT_ONLY: "yes" }, onOutput: (chunk) => { captured += chunk; } },
      context,
    );
    expect(res.ok).toBe(true);
    expect(JSON.parse(captured)).toEqual({ canary: null, custom: "yes" });

    // createTrustedWorkerSession writes ZERO env.json files to controlRoot
    const controlRoot = tempDir("kulo-c2-ctrl-");
    const session = createTrustedWorkerSession({
      workspaceDir: workDir,
      controlRoot,
      blockedEnvNames: ["CUSTOM_ROUTER_SECRET"],
    });
    const scanFiles = (root: string): string[] => {
      if (!fs.existsSync(root)) return [];
      const out: string[] = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        out.push(full);
        if (entry.isDirectory()) out.push(...scanFiles(full));
      }
      return out;
    };
    expect(scanFiles(controlRoot).some((f) => f.includes("env.json"))).toBe(false);
    await session.cleanup();
    expect(scanFiles(controlRoot).some((f) => f.includes("env.json"))).toBe(false);
  });

  it("buildSafeMcpDiscoveryEnv exposes host tool discovery vars while excluding unrelated business secrets", () => {
    const mcpEnv = buildSafeMcpDiscoveryEnv({
      sourceEnv: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: "/Users/example",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        GOPATH: "/Users/example/go",
        HTTPS_PROXY: "http://127.0.0.1:7890",
        NPM_TOKEN: "npm_secret_publish_token",
        STRIPE_SECRET_KEY: "sk_live_secret",
        AWS_SECRET_ACCESS_KEY: "aws_secret_value",
        KULO_AUTH_TOKEN: "kulo_internal_token",
      },
      extraEnv: { MCP_CONFIGURED_TOKEN: "explicit-from-vault" },
    });
    expect(mcpEnv.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
    expect(mcpEnv.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(mcpEnv.GOPATH).toBe("/Users/example/go");
    expect(mcpEnv.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(mcpEnv.MCP_CONFIGURED_TOKEN).toBe("explicit-from-vault");
    expect(mcpEnv.NPM_TOKEN).toBeUndefined();
    expect(mcpEnv.STRIPE_SECRET_KEY).toBeUndefined();
    expect(mcpEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(mcpEnv.KULO_AUTH_TOKEN).toBeUndefined();
  });
});

describe("C3: Cross-device trusted-host-v1 negotiation, legacy peer fallback, and non-destructive hot switch", () => {
  it("falls back legacy peers without trusted-host-v1 to sandboxed, strips executionMode on wire, and reports sandboxless trusted-host-v1 peer ready in trusted mode", () => {
    const legacyPeer = fakeDescriptor({
      capabilities: ["fs", "bash", "worker-isolation", "worker-isolation-macos"],
    });
    const modernSandboxlessPeer = fakeDescriptor({
      id: "linux-box",
      platform: "linux",
      capabilities: ["fs", "bash", TRUSTED_HOST_EXECUTION_CAPABILITY],
    });

    expect(resolveEffectiveExecutionMode({ hubTrustMode: "trusted", descriptor: legacyPeer, isLocal: false })).toBe("sandboxed");
    expect(resolveEffectiveExecutionMode({ hubTrustMode: "trusted", descriptor: modernSandboxlessPeer, isLocal: false })).toBe("trusted");
    expect(resolveEffectiveExecutionMode({ hubTrustMode: "sandboxed", descriptor: modernSandboxlessPeer, isLocal: false })).toBe("sandboxed");

    const scopedHostLegacy = scopeHostActionForTarget(
      { action: "read_file", path: "/tmp/a", executionMode: "trusted" } as never,
      "sandboxed",
      legacyPeer.capabilities,
      false,
    );
    expect("executionMode" in scopedHostLegacy).toBe(false);
    const scopedHostModern = scopeHostActionForTarget(
      { action: "read_file", path: "/tmp/a" } as never,
      "trusted",
      modernSandboxlessPeer.capabilities,
      false,
    );
    expect(scopedHostModern.executionMode).toBe("trusted");

    const scopedCuLegacy = scopeComputerUseForTarget(
      { tool: "browser", action: "status", executionMode: "trusted" } as never,
      "sandboxed",
      legacyPeer.capabilities,
      false,
    );
    expect("executionMode" in scopedCuLegacy).toBe(false);

    expect(isWorkerEnvReady(modernSandboxlessPeer, "trusted")).toBe(true);
    expect(isWorkerEnvReady(modernSandboxlessPeer, "sandboxed")).toBe(false);
    expect(isWorkerEnvReady(modernSandboxlessPeer, "trusted", { requireOsIsolation: true })).toBe(false);
  });

  it("hot-switching executionTrustMode retires idle workers non-destructively without killing active runEpoch", async () => {
    const dir = tempDir("kulo-c3-hotswitch-");
    let releaseWorker!: () => void;
    const gate = new Promise<void>((r) => { releaseWorker = r; });
    const { hub, provider } = await openTrustHub(dir);

    let workerStarted = false;
    provider.setResponses([
      async () => {
        workerStarted = true;
        await gate;
        return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "completed under frozen trusted epoch" })], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([fauxText("done")]),
    ]);

    const projectDir = path.join(dir, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = await hub.projects.create({ commandId: "p-hot", name: "HotSwitch", deviceId: "local", workspaceDir: projectDir });
    const card = await hub.dispatchTicket({
      commandId: "t-hot-1",
      title: "Hot switch survival",
      goal: "Survive mode switch without being killed",
      scope: "proj",
      role: "coder",
      projectId: project.id,
    });

    await vi.waitFor(() => expect(workerStarted).toBe(true), { timeout: 8_000, interval: 20 });

    const v1 = hub.getSettingsView();
    await hub.updateSettingsBlock("executor", v1.blocks.executor.revision, { ...v1.blocks.executor.value, executionTrustMode: "sandboxed" }, context);
    expect(hub.getSettingsView().blocks.executor.value.executionTrustMode).toBe("sandboxed");

    const midSnap = await hub.harness.snapshot(KuloStateDoc, context);
    expect(midSnap?.tickets[card.id]?.status).toBe("running");
    expect(midSnap?.ticketExecutionModes?.[card.id]?.mode).toBe("trusted");

    releaseWorker();
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 8_000, interval: 20 });
  });
});

describe("C4: childStdin:'null' EOF cleanup and symlink protection on core stateDir", () => {
  it("terminates child process promptly on parent stdin EOF even when childStdin is 'null'", async () => {
    const controlDir = tempDir("kulo-c4-sup-");
    const pidFile = path.join(controlDir, "child.pid");
    const childCode = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 60000);`;

    const cmd = supervisedCommand([process.execPath, "-e", childCode], controlDir, undefined, {
      childStdin: "null",
      envPolicy: { mode: "trusted", blockedEnvNames: [] },
    });
    const sup = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(() => { try { sup.kill("SIGKILL"); } catch {} });

    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 5_000, interval: 20 });
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(childPid).toBeGreaterThan(0);

    const exitPromise = new Promise<number | null>((resolve) => sup.once("exit", (code) => resolve(code)));
    sup.stdin.end();
    await exitPromise;

    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(childPid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5_000, interval: 25 });
  });

  it("blocks trusted Worker file tool from reading core stateDir files via symlink inside workspace", async () => {
    const dir = tempDir("kulo-c4-symlink-");
    const { hub, provider } = await openTrustHub(dir);
    const projectDir = path.join(dir, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const coreTarget = path.join(dir, "state", "credentials.json");
    fs.writeFileSync(coreTarget, JSON.stringify({ synthetic: "CORE-VAULT-SECRET" }));
    const linkPath = path.join(projectDir, "sneaky-link.json");
    fs.symlinkSync(coreTarget, linkPath);

    let readResultText = "";
    let step = 0;
    provider.setResponses(Array.from({ length: 12 }, () => (ctx) => {
      const toolResults = ctx.messages.filter((m) => m.role === "toolResult");
      if (toolResults.length > 0 && !readResultText) {
        readResultText = JSON.stringify(toolResults[0]);
      }
      if (step++ === 0) {
        return fauxAssistantMessage([fauxToolCall("read", { path: linkPath })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "checked" })], { stopReason: "toolUse" });
    }));

    const project = await hub.projects.create({ commandId: "p-sym", name: "SymlinkCheck", deviceId: "local", workspaceDir: projectDir });
    const card = await hub.dispatchTicket({
      commandId: "t-sym-1",
      title: "Symlink guard check",
      goal: "Attempt reading symlink to credentials.json",
      scope: "proj",
      role: "coder",
      projectId: project.id,
    });
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 10_000, interval: 25 });

    expect(readResultText).toContain("Blocked access");
    expect(readResultText).not.toContain("CORE-VAULT-SECRET");
  });
});

describe("C5: Private web_fetch & Exa/Tavily bypass, connection read-decoupling, Stdio MCP generation race, and strict RFC 9110 redirects", () => {
  it("never routes private/loopback URLs to cloud Exa/Tavily adapters and blocks cloud metadata IPs", async () => {
    expect(isCloudMetadataHostOrIp("169.254.169.254")).toBe(true);
    expect(isCloudMetadataHostOrIp("100.100.100.200")).toBe(true);
    expect(isCloudMetadataHostOrIp("metadata.google.internal")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.50")).toBe(true);
    expect(isPrivateOrLoopbackHost("example.com")).toBe(false);

    const localServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Local Intranet</title></head><body><p>Private LAN payload</p></body></html>");
    });
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => localServer.close(() => resolve())));
    const port = (localServer.address() as { port: number }).port;

    const cloudSpy = vi.fn(async () => new Response("should never be called", { status: 500 }));
    const searchDir = tempDir("kulo-c5-search-");
    const { hub } = await openTrustHub(searchDir);
    const search = new KuloSearch({
      harness: hub.harness,
      stateDir: path.join(searchDir, "state"),
      credentials: new FileCredentialStore(path.join(searchDir, "state", "credentials.json")),
      fetch: cloudSpy,
    });
    cleanups.push(() => search.close());
    await search.configure({ name: "Cloud Exa", adapter: "exa", apiKey: "synthetic-exa-key" });

    const page = await search.fetch(`http://127.0.0.1:${port}/status`, undefined, { allowPrivateNetwork: true });
    expect(page.content).toContain("Private LAN payload");
    expect(cloudSpy).not.toHaveBeenCalled();

    await expect(search.fetch("http://100.100.100.200/latest/meta-data/", undefined, { allowPrivateNetwork: true }))
      .rejects.toThrow(/云元数据/);
  });

  it("keeps private http:// connections readable after switching from trusted to sandboxed and restarting, while blocking execution", async () => {
    const dir = tempDir("kulo-c5-conn-");
    const keyStore = makeFakeKeyStore();
    let mode: ExecutionTrustMode = "trusted";

    const conn1 = new KuloConnections({
      stateDir: dir,
      vault: new LocalConnectionVault({ stateDir: dir, keyStore }),
      getExecutionTrustMode: () => mode,
    });
    await conn1.initialize();
    const saved = await conn1.save({
      kind: "api-key",
      name: "LAN Service",
      url: "http://192.168.1.50:8080",
      authType: "bearer",
      secrets: { apiKey: "lan-secret-token" },
    });
    expect(saved.url).toBe("http://192.168.1.50:8080/");

    // Switch back to sandboxed & reopen fresh instance from disk -> reading/listing MUST succeed
    mode = "sandboxed";
    const conn2 = new KuloConnections({
      stateDir: dir,
      vault: new LocalConnectionVault({ stateDir: dir, keyStore }),
      getExecutionTrustMode: () => mode,
    });
    await conn2.initialize();
    const listed = (await conn2.snapshot()).connections;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.url).toBe("http://192.168.1.50:8080/");

    // Executing in sandboxed mode MUST be blocked
    conn2.grant("T-0001", 1, [saved.id]);
    await expect(
      conn2.use("T-0001", 1, saved.id, { kind: "http", path: "/health", method: "GET" }),
    ).rejects.toThrow(/HTTPS|内网|私网|受限|不可访问|阻止|隔离/);
  });

  it("rejects in-flight stdio MCP connection with 409 connection_conflict when invalidated mid-connect", async () => {
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((r) => { releaseConnect = r; });
    const fakeClose = vi.fn(async () => {});

    const dir = tempDir("kulo-c5-mcppool-");
    const pool = new McpConnectionPool({
      vault: new LocalConnectionVault({ stateDir: dir, keyStore: makeFakeKeyStore() }),
      locks: new McpOAuthRefreshLockManager(dir),
      getBinding: () => "stdio:echo",
      redact: (s) => s,
      onSecrets: () => {},
      onAuthorizedChange: () => {},
      onDiscoveryUpdated: () => {},
      transportFactory: async () => {
        await connectGate;
        let handler: ((msg: unknown) => void) | undefined;
        return {
          onMessage: (cb: (msg: unknown) => void) => { handler = cb; return () => { handler = undefined; }; },
          onClose: () => () => {},
          onError: () => () => {},
          start: async () => {},
          send: async (msg: { id?: number; method?: string }) => {
            if (msg.method === "initialize" && msg.id !== undefined) {
              queueMicrotask(() => handler?.({
                jsonrpc: "2.0",
                id: msg.id,
                result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "1.0" } },
              }));
            }
          },
          close: fakeClose,
        } as never;
      },
    });
    cleanups.push(() => pool.close());

    const record = {
      id: "mcp-stdio-race",
      name: "Race MCP",
      kind: "mcp" as const,
      mcpTransport: "stdio" as const,
      mcpCommand: "echo",
      mcpArgs: ["hi"],
      revision: 1,
      status: "ready" as const,
      createdAt: 1,
      updatedAt: 1,
    };

    const inFlight = pool.execute(record as never, {}, "stdio:echo", { kind: "mcp", action: "list_tools", refresh: true });
    await pool.invalidateStdioConnections();
    releaseConnect();

    await expect(inFlight).rejects.toMatchObject({ status: 409, code: "connection_conflict" });
    await vi.waitFor(() => expect(fakeClose).toHaveBeenCalled());
  });

  it("enforces strict RFC 9110 cross-origin redirects: aborts mutating/body 307/308 so target receives zero bytes, strips auth on GET 302, blocks cloud metadata redirect", async () => {
    expect(() =>
      prepareSafeHttpRedirect({
        status: 307,
        location: "https://other.example/hook",
        currentUrl: new URL("https://api.example/v1/items"),
        initialOrigin: "https://api.example",
        method: "POST",
        headers: new Headers({ authorization: "Bearer secret" }),
        body: '{"data":1}',
      }),
    ).toThrow(/跨站重定向/);

    const getRedirect = prepareSafeHttpRedirect({
      status: 302,
      location: "https://cdn.example/file",
      currentUrl: new URL("https://api.example/download"),
      initialOrigin: "https://api.example",
      method: "GET",
      headers: new Headers({
        authorization: "Bearer secret",
        cookie: "sid=1",
        "x-api-key": "custom-secret",
        accept: "application/json",
      }),
      authHeaderName: "X-Api-Key",
    });
    expect(getRedirect.headers.get("authorization")).toBeNull();
    expect(getRedirect.headers.get("cookie")).toBeNull();
    expect(getRedirect.headers.get("x-api-key")).toBeNull();
    expect(getRedirect.headers.get("accept")).toBe("application/json");

    let secondHits = 0;
    const secondServer = http.createServer((_req, res) => {
      secondHits++;
      res.writeHead(200);
      res.end("second");
    });
    await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => secondServer.close(() => resolve())));
    const secondPort = (secondServer.address() as { port: number }).port;

    const firstServer = http.createServer((req, res) => {
      if (req.url === "/cross-307") {
        res.writeHead(307, { location: `http://127.0.0.1:${secondPort}/sink` });
        res.end();
        return;
      }
      if (req.url === "/meta-302") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => firstServer.close(() => resolve())));
    const firstPort = (firstServer.address() as { port: number }).port;

    const mcpFetch = createMcpFetch({
      allowPrivateNetwork: true,
      allowPrivateHttp: true,
      allowSafeRedirects: true,
    });

    await expect(
      mcpFetch(`http://127.0.0.1:${firstPort}/cross-307`, {
        method: "POST",
        body: '{"secret":"payload"}',
        headers: { "content-type": "application/json" },
      }),
    ).rejects.toThrow(/跨站重定向/);
    expect(secondHits).toBe(0);

    await expect(mcpFetch(`http://127.0.0.1:${firstPort}/meta-302`, { method: "GET" })).rejects.toThrow(/元数据/);
  });
});

describe("C6: ComputerUseService persistent profile, concurrent ephemeral downgrade, crash recovery meta, and autoConnect non-destructive close", () => {
  it("assigns persistent profile to first trusted session, downgrades concurrent second session to ephemeral, persists recovery meta, and preserves autoConnect tabs on close", async () => {
    const rootDir = tempDir("kulo-c6-cu-");
    const calls: Array<{ args: string[]; input?: string }> = [];
    const runner = vi.fn(async (req: { args: string[]; input?: string }) => {
      calls.push({ args: [...req.args], input: req.input });
      return { success: true, data: { title: "OK", url: "https://example.com" } };
    });

    const service = new ComputerUseService({
      rootDir,
      platform: "darwin",
      browserEnabled: true,
      resolveBrowserExecutable: () => ({}),
      checkMacosChromeBackgroundTasks: async () => "allowed",
      runner: runner as never,
      getExecutionTrustMode: () => "trusted",
    });

    // Session 1 gets persistent profile
    const open1 = await service.request({ tool: "browser", action: "open", sessionId: "s1", url: "https://example.com", executionMode: "trusted" });
    expect(open1.ok).toBe(true);
    expect((open1 as Extract<ComputerUseResult, { ok: true }>).data).toMatchObject({ profileMode: "persistent" });
    const s1Call = calls.at(-1)!;
    expect(s1Call.args).toContain("--profile");

    // Session 2 concurrently downgrades to ephemeral (no --profile)
    const open2 = await service.request({ tool: "browser", action: "open", sessionId: "s2", url: "https://example.com", executionMode: "trusted" });
    expect(open2.ok).toBe(true);
    expect((open2 as Extract<ComputerUseResult, { ok: true }>).data).toMatchObject({ profileMode: "ephemeral" });
    const s2Call = calls.at(-1)!;
    expect(s2Call.args).not.toContain("--profile");

    // Recovery log persists meta for s1's profileDir
    const logPath = path.join(rootDir, "browser-sessions.json");
    const persisted = JSON.parse(fs.readFileSync(logPath, "utf8")) as { sessions: string[]; meta?: Record<string, { profileDir?: string; autoConnect?: boolean }> };
    expect(persisted.sessions).toContain("s1");
    expect(persisted.meta?.s1?.profileDir).toBeTruthy();

    // Closing s1 releases persistent profile lock so s3 reclaims persistent!
    await service.request({ tool: "browser", action: "close", sessionId: "s1", executionMode: "trusted" });
    const open3 = await service.request({ tool: "browser", action: "open", sessionId: "s3", url: "https://example.com", executionMode: "trusted" });
    expect((open3 as Extract<ComputerUseResult, { ok: true }>).data).toMatchObject({ profileMode: "persistent" });

    // Simulate crash recovery: leave s3 in browser-sessions.json plus an autoConnect entry, instantiate new service
    const crashLog = JSON.parse(fs.readFileSync(logPath, "utf8")) as { sessions: string[]; meta?: Record<string, { profileDir?: string; autoConnect?: boolean }> };
    crashLog.sessions.push("s-auto");
    crashLog.meta = { ...(crashLog.meta ?? {}), "s-auto": { autoConnect: true } };
    fs.writeFileSync(logPath, JSON.stringify(crashLog));

    const recoveryCalls: string[][] = [];
    const recoveredService = new ComputerUseService({
      rootDir,
      platform: "darwin",
      browserEnabled: true,
      resolveBrowserExecutable: () => ({}),
      checkMacosChromeBackgroundTasks: async () => "allowed",
      runner: (async (req: { args: string[] }) => {
        recoveryCalls.push([...req.args]);
        return { success: true, data: {} };
      }) as never,
      getExecutionTrustMode: () => "trusted",
    });
    await recoveredService.request({ tool: "browser", action: "status", executionMode: "trusted" });
    // Orphaned s3 was closed with its persisted --profile, while s-auto (autoConnect) was NOT destructively closed!
    const s3Close = recoveryCalls.find((a) => a.includes("s3") && a.includes("close"));
    expect(s3Close).toBeDefined();
    expect(s3Close).toContain("--profile");
    const autoClose = recoveryCalls.find((a) => a.includes("s-auto") && a.includes("close"));
    expect(autoClose).toBeUndefined();
  });
});
