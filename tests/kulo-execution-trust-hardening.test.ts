import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  TRUSTED_HOST_EXECUTION_CAPABILITY,
  type ComputerUseResult,
  type EnvNodeDescriptor,
} from "@kulo/protocol";
import { EnvManager } from "@kulo/env";
import { createBridgeExecutionEnv, type BridgeExecutionContext } from "../packages/env/src/bridge-execution-env.js";
import { isProtectedAcpPath } from "../packages/env/src/external-agent-drivers.js";
import { KuloSettingsDoc, KuloStateDoc } from "@kulo/hub";
import { clearFailoverTrustGuard, hasFailoverTrustGuard } from "../packages/hub/src/hub-kernel-ports.js";
import { isCloudMetadataHostOrIp } from "../packages/hub/src/net-policy.js";
import { isRemoteKuloCorePath } from "../packages/hub/src/orchestrator-coding-guard.js";
import { selectCitedSources } from "../packages/hub/src/search-sources.js";
import { rollbackSettingsToSnapshot } from "../packages/hub/src/settings.js";
import { fetchWebPageViaEnv } from "../packages/hub/src/web-content.js";
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

describe("Hydrogen P0/P1 Hardening Regressions", () => {
  it("P0-1 & P1-3: scoped releaseWorkerExecutionEnv preserves live sibling Workers, untagged sessions, and active host-action receipts in the same workspaceDir", async () => {
    const root = tempDir("kulo-p01-");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const manager = new EnvManager({
      localRootDir: root,
      initialExecutionTrustMode: "trusted",
    });
    await manager.start();
    cleanups.push(() => manager.close());

    // Start two concurrent Workers with distinct executionKeys in the same workspaceDir
    const workerA = manager.createWorkerExecutionEnv("local", workspaceDir, {
      executionMode: "trusted",
      executionKey: "T-0001",
    });
    const workerB = manager.createWorkerExecutionEnv("local", workspaceDir, {
      executionMode: "trusted",
      executionKey: "T-0002",
    });
    expect((await workerA.writeFile("a.txt", "alive-a", context)).ok).toBe(true);
    expect((await workerB.writeFile("b.txt", "alive-b", context)).ok).toBe(true);

    // Plant a synthetic live kulo-host-action-* receipt in the executions directory
    const executionsDir = path.join(root, ".kulo-env", "executions");
    const hostActionDir = path.join(executionsDir, "kulo-host-action-live-test");
    fs.mkdirSync(hostActionDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostActionDir, "owner.json"),
      JSON.stringify({
        ownerPid: process.pid,
        workspaceDir,
        temporaryDir: hostActionDir,
        cleanupModel: "process-group",
      }),
    );

    // Release ONLY Worker B ("T-0002")
    const relB = await manager.releaseWorkerExecutionEnv("local", workspaceDir, {
      executionMode: "trusted",
      executionKey: "T-0002",
    });
    expect(relB.cleanupPending).toBe(false);

    // Worker A MUST remain live & responsive, and host-action receipt MUST remain untouched!
    expect(fs.existsSync(hostActionDir)).toBe(true);
    expect(await workerA.readTextFile("a.txt", context)).toEqual({ ok: true, value: "alive-a" });

    // Hot-switch trusted -> sandboxed -> trusted moves retired Worker A without leaking, and Worker A still finishes cleanly!
    manager.setExecutionTrustMode("sandboxed", 2);
    manager.setExecutionTrustMode("trusted", 3);
    expect(await workerA.readTextFile("a.txt", context)).toEqual({ ok: true, value: "alive-a" });

    // Now release Worker A cleanly (retired set is also drained)
    const relA = await manager.releaseWorkerExecutionEnv("local", workspaceDir, {
      executionMode: "trusted",
      executionKey: "T-0001",
    });
    expect(relA.cleanupPending).toBe(false);
    expect(fs.existsSync(hostActionDir)).toBe(true);
  });

  it("P0-2: createBridgeExecutionEnv honors explicit executionMode:'sandboxed' on local host and forces OS sandbox on legacy WS peers without trusted-host-v1", () => {
    const legacyPeerDesc: EnvNodeDescriptor = {
      id: "legacy-peer",
      name: "Legacy Peer",
      kind: "remote",
      rootDir: "/tmp/legacy",
      platform: "darwin",
      arch: "arm64",
      online: true,
      capabilities: ["fs", "bash", "worker-isolation", "worker-isolation-macos"],
    };
    const getWsPeerConnection = vi.fn(() => null);
    const workerConnections = new Map();
    const ctx: BridgeExecutionContext = {
      closed: false,
      localEnvId: "local",
      localConnection: null,
      localProjects: null,
      localStagedWorkspaces: null,
      bridgePort: 12345,
      bridgeSecret: "secret",
      stdioRelayPath: "/tmp/relay.mjs",
      workerEnvIds: ["legacy-peer"],
      deviceTokens: new Map(),
      revokedProjects: new Set(),
      workerConnections,
      retiredWorkerConnections: new Set(),
      cleanupTasks: new Set(),
      executionTrustMode: "trusted",
      isLocalEnv: (id) => id === "local",
      assertPiEnv: () => {},
      getEnvDescriptor: (id) => (id === "legacy-peer" ? legacyPeerDesc : undefined),
      hasWsPeer: (id) => id === "legacy-peer",
      getWsPeerDescriptor: (id) => (id === "legacy-peer" ? legacyPeerDesc : undefined),
      getWsPeerConnection,
      getSshPeerConnection: () => null,
      getSandboxProtectedPaths: () => ["/tmp/protected"],
      getCoreProtectedPaths: () => ["/tmp/core"],
      getBlockedEnvNames: () => [],
      abortRemoteStreams: () => false,
      requestRemoteCleanup: async () => ({ cleanupPending: false }),
    };

    // Even while Hub is in "trusted" mode, legacy peer MUST use the sandboxed orchestrator-ws stream, NEVER bare getWsPeerConnection!
    createBridgeExecutionEnv(ctx, "legacy-peer", "/tmp/legacy");
    expect(getWsPeerConnection).not.toHaveBeenCalled();
    expect(workerConnections.size).toBe(1);
    const cached = [...workerConnections.values()][0];
    expect(cached.executionMode).toBe("sandboxed");
    expect(cached.isOrchestrator).toBe(true);
    cached.connection.close();
  });

  it("P0-3: steering a ready ticket to runEpoch 2 re-freezes ticketExecutionModes and survives global hot-switch", async () => {
    const dir = tempDir("kulo-p03-");
    const provider = fauxProvider({ provider: "openai", models: [{ id: "epoch-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);

    let releaseEpoch2!: () => void;
    const epoch2Gate = new Promise<void>((r) => { releaseEpoch2 = r; });
    let epoch2Started = false;
    let calls = 0;
    provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "epoch 1 ready" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("ack1")]),
      async () => {
        calls += 1;
        epoch2Started = true;
        await epoch2Gate;
        return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "epoch 2 ready" })], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage([fauxText("ack2")]),
    ]);

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
        model: { defaultProvider: "openai", defaultModel: "epoch-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());

    const projectDir = path.join(dir, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = await hub.projects.create({ commandId: "p-ep", name: "EpochProj", deviceId: "local", workspaceDir: projectDir });
    const card = await hub.dispatchTicket({
      commandId: "t-ep-1",
      title: "Multi-epoch freeze",
      goal: "Run epoch 1 then steer to epoch 2",
      scope: "proj",
      role: "coder",
      projectId: project.id,
    });
    await vi.waitFor(async () => {
      expect((await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 8_000, interval: 20 });

    // Steer to epoch 2 while Hub is still in trusted mode
    await hub.steerTicket({ commandId: "steer-ep-2", ticketId: card.id, text: "Run epoch 2" });
    await vi.waitFor(() => expect(epoch2Started).toBe(true), { timeout: 8_000, interval: 20 });

    // Hot-switch global mode trusted -> sandboxed mid-epoch-2
    const view = hub.getSettingsView();
    await hub.updateSettingsBlock("executor", view.blocks.executor.revision, { ...view.blocks.executor.value, executionTrustMode: "sandboxed" }, context);

    const snap = await hub.harness.snapshot(KuloStateDoc, context);
    expect(snap?.tickets[card.id]?.runEpoch).toBe(2);
    expect(snap?.ticketExecutionModes?.[card.id]).toEqual({ runEpoch: 2, mode: "trusted" });

    releaseEpoch2();
    await vi.waitFor(async () => {
      expect((await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 8_000, interval: 20 });
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("P1-1: windows-job-runner.ps1 avoids CmdletBinding param() so child flags like -e/-c/-v are never stolen", () => {
    const scriptPath = path.resolve(process.cwd(), "packages/env/native/windows-job-runner.ps1");
    const source = fs.readFileSync(scriptPath, "utf8");
    const nonCommentLines = source
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(nonCommentLines).not.toMatch(/^\s*param\s*\(/m);
    expect(nonCommentLines).not.toMatch(/\[Parameter\(/);
    expect(nonCommentLines).not.toMatch(/\[CmdletBinding\(/);
    expect(nonCommentLines).toContain("$args[0]");
  });

  it("P1-2 & P2-5: fetchWebPageViaEnv blocks hex IPv4-mapped IPv6 cloud metadata redirects and expanded AWS IPv6 IMDS", async () => {
    expect(isCloudMetadataHostOrIp("fd00:0ec2:0:0:0:0:0:254")).toBe(true);
    expect(isCloudMetadataHostOrIp("fd00:ec2::254")).toBe(true);
    expect(isCloudMetadataHostOrIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isCloudMetadataHostOrIp("::ffff:6464:64c8")).toBe(true);

    const server = http.createServer((req, res) => {
      if (req.url === "/imds-v6-aws") {
        res.writeHead(302, { location: "http://[::ffff:169.254.169.254]/latest/meta-data/" });
        res.end();
        return;
      }
      if (req.url === "/imds-v6-ali") {
        res.writeHead(302, { location: "http://[::ffff:100.100.100.200]/latest/meta-data/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    const realExec = (cmd: readonly string[]) =>
      new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
        execFile(cmd[0]!, cmd.slice(1) as string[], { timeout: 10_000 }, (err, stdout, stderr) => {
          resolve({ exitCode: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      });

    await expect(
      fetchWebPageViaEnv({ exec: realExec, url: `http://127.0.0.1:${port}/imds-v6-aws` }),
    ).rejects.toThrow(/云元数据/);
    await expect(
      fetchWebPageViaEnv({ exec: realExec, url: `http://127.0.0.1:${port}/imds-v6-ali` }),
    ).rejects.toThrow(/云元数据/);
  });

  it("P1-4: hasFailoverTrustGuard preserves marker across commit failures until clearFailoverTrustGuard is called", () => {
    const dir = tempDir("kulo-p14-");
    const marker = path.join(dir, "failover-trust-guard.json");
    fs.writeFileSync(marker, JSON.stringify({ reason: "failover" }));
    expect(hasFailoverTrustGuard(dir)).toBe(true);
    // Reading does NOT delete the marker prematurely
    expect(fs.existsSync(marker)).toBe(true);
    clearFailoverTrustGuard(dir);
    expect(hasFailoverTrustGuard(dir)).toBe(false);
  });

  it("P1-5: resolving Main Chat browser handoff via Preview Modal HTTP path wakes Main Chat cleanly", async () => {
    const dir = tempDir("kulo-p15-");
    const provider = fauxProvider({ provider: "openai", models: [{ id: "handoff-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);

    let wokeWithHandoffResume = false;
    provider.setResponses(Array.from({ length: 16 }, () => (ctx) => {
      const userTexts = ctx.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join("\n");
      if (userTexts.includes("用户已完成人工接管操作")) {
        wokeWithHandoffResume = true;
        return fauxAssistantMessage([fauxText("已收到接管完成通知并继续操作。")]);
      }
      const offered = new Set([
        ...(ctx.tools ?? []).map((t) => t.name),
        ...ctx.messages.flatMap((m) =>
          m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded)
            ? m.toolsAdded.map((t: { name: string }) => t.name)
            : [],
        ),
      ]);
      if (!offered.has("kulo_browser") || !offered.has("kulo_computer_handoff")) {
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_browser kulo_computer_handoff", limit: 3 })], { stopReason: "toolUse" });
      }
      const results = ctx.messages.filter((m) => m.role === "toolResult");
      if (!results.some((r) => r.toolName === "kulo_browser")) {
        return fauxAssistantMessage([fauxToolCall("kulo_browser", { action: "open", url: "https://example.com/login" })], { stopReason: "toolUse" });
      }
      if (!results.some((r) => r.toolName === "kulo_computer_handoff")) {
        return fauxAssistantMessage([fauxToolCall("kulo_computer_handoff", { target: "browser", reason: "请完成扫码登录", url: "https://example.com/login" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText("请点击预览窗口完成登录。")]);
    }));

    const hub = await openTestHub({
      models,
      orchestratorBrowserIdleMs: 10_000,
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "env"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "handoff-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());

    const origDesc = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((envId) => {
      const d = origDesc(envId);
      return d ? { ...d, capabilities: [...new Set([...d.capabilities, "agent-browser"])] } : d;
    });
    vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (_envId, req) => ({
      tool: req.tool,
      action: req.action,
      ...("sessionId" in req ? { sessionId: req.sessionId } : {}),
      platform: process.platform,
      ok: true,
      data: { title: "Login" },
    }) as ComputerUseResult);

    const sub = await hub.sendUserMessage("帮我打开登录页");
    await sub.wait(context);

    const previews = await hub.listComputerPreviews("root");
    const browserPreview = previews.find((p) => p.tool === "browser" && p.handoff?.interactive);
    expect(browserPreview).toBeDefined();

    // Simulate clicking "已完成，请继续" in the Preview Modal
    const settled = await hub.resolveComputerHandoff(browserPreview!.ticketId, "done", "已扫码", context);
    expect(settled).toEqual({ ok: true, status: "done" });

    await vi.waitFor(() => expect(wokeWithHandoffResume).toBe(true), { timeout: 6_000, interval: 25 });
  });

  it("P1-6, P1-8, P2-1, P2-4: remote core state guard, ACP credentials.json/connection-vault.json protection, symmetric rollback gate, and private-LAN citations", () => {
    // P1-6: remote core state files blocked while normal repo files pass
    expect(isRemoteKuloCorePath("/Users/alice/.kulo/connection.json")).toBe(true);
    expect(isRemoteKuloCorePath("/Users/alice/.kulo-env/project-grants.json")).toBe(true);
    expect(isRemoteKuloCorePath("/Users/alice/kulo/.secure/vault")).toBe(true);
    expect(isRemoteKuloCorePath("/Users/alice/kulo/.kulo-state/kulo.sqlite")).toBe(true);
    expect(isRemoteKuloCorePath("/Users/alice/projects/app/devices.json")).toBe(false);

    // P1-8: isProtectedAcpPath protects credentials.json & connection-vault.json even in trusted mode
    expect(isProtectedAcpPath("/tmp/kulo-state/credentials.json", false, "codex", "trusted")).toBe(true);
    expect(isProtectedAcpPath("/tmp/kulo-state/connection-vault.json", false, "codex", "trusted")).toBe(true);

    // P2-1: rollbackSettingsToSnapshot symmetric non-Owner check
    const baseDoc = {
      globalRevision: 3,
      revisions: { presentation: 2, executor: 2, roles: 1, model: 1, identity: 1, memory: 1 },
      presentation: { agentName: "Renamed", workbenchName: "Table" },
      executor: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5, completedTaskDisplayHours: 3, autoArchiveEnabled: true, autoArchiveDays: 7, executionTrustMode: "sandboxed" as const },
      roles: {},
      model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "m", thinkingLevel: "off", customProviders: [] },
      identity: { directory: "/tmp/id", directoryRevision: 1 },
      memory: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "p", shared: "s" } },
      snapshots: [
        {
          revision: 1,
          block: "executor",
          summary: "changed mode",
          at: 1,
          previousState: {
            presentation: { agentName: "Kulo", workbenchName: "Table" },
            executor: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5, completedTaskDisplayHours: 3, autoArchiveEnabled: true, autoArchiveDays: 7, executionTrustMode: "trusted" as const },
            roles: {},
            model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "m", thinkingLevel: "off", customProviders: [] },
            identityDirectory: "/tmp/id",
            memory: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "p", shared: "s" } },
          },
        },
        {
          revision: 2,
          block: "presentation",
          summary: "renamed",
          at: 2,
          previousState: {
            presentation: { agentName: "Kulo", workbenchName: "Table" },
            executor: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5, completedTaskDisplayHours: 3, autoArchiveEnabled: true, autoArchiveDays: 7, executionTrustMode: "sandboxed" as const },
            roles: {},
            model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "m", thinkingLevel: "off", customProviders: [] },
            identityDirectory: "/tmp/id",
            memory: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "p", shared: "s" } },
          },
        },
      ],
    };
    // Non-owner CANNOT roll back to revision 1 (changes sandboxed -> trusted)
    expect(() =>
      rollbackSettingsToSnapshot(structuredClone(baseDoc) as never, 1, 3, undefined, { allowTrustModeChange: false }),
    ).toThrow(/主人设备控制台/);
    // Non-owner CAN roll back to revision 2 (same sandboxed mode, only reverts presentation)
    const cloned = structuredClone(baseDoc);
    expect(() =>
      rollbackSettingsToSnapshot(cloned as never, 2, 3, undefined, { allowTrustModeChange: false }),
    ).not.toThrow();
    expect(cloned.presentation.agentName).toBe("Kulo");
    expect(cloned.executor.executionTrustMode).toBe("sandboxed");

    // P2-4: selectCitedSources preserves verified private-LAN citations while dropping cloud metadata
    const cited = selectCitedSources(
      "内网状态见 [LAN Dashboard](http://192.168.1.50:8080/status) 与 [IMDS](http://169.254.169.254/latest/meta-data/)。",
      [
        { id: "s1", title: "LAN Dashboard", url: "http://192.168.1.50:8080/status" },
        { id: "s2", title: "IMDS", url: "http://169.254.169.254/latest/meta-data/" },
      ],
    );
    expect(cited.map((s) => s.url)).toEqual(["http://192.168.1.50:8080/status"]);
  });
});
