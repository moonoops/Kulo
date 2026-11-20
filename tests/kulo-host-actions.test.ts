import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { validateUiCardInput } from "@kulo/protocol";
import {
  EnvManager,
  HostActionService,
  KuloEnvAgent,
  buildHostMaintenanceSandboxProfile,
  defaultProtectedPaths,
  validateHostMaintenanceCommands,
} from "@kulo/env";
import { KuloStateDoc, type KuloHub } from "@kulo/hub";
import { WebSocketServer } from "ws";
import { buildHostActionConfirmCard } from "../packages/hub/src/action-confirmations.js";
import { openTestHub } from "./helpers/secure-hub.js";

const dirs: string[] = [];
const hubs: KuloHub[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kulo-host-action-${prefix}-`)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0).reverse()) await hub.close().catch(() => {});
  for (const dir of dirs.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Worker sandbox refinements & HostActionService", () => {
  it("narrows ~/.config protection to credential subdirectories while keeping ordinary ~/.config entries readable", () => {
    const fakeHome = "/tmp/kulo-fake-home-check";
    const protectedList = defaultProtectedPaths(fakeHome);
    expect(protectedList).not.toContain(path.join(fakeHome, ".config"));
    expect(protectedList).toContain(path.join(fakeHome, ".config", "gh"));
    expect(protectedList).toContain(path.join(fakeHome, ".config", "gcloud"));
    expect(protectedList).toContain(path.join(fakeHome, ".config", "anthropic"));
    expect(protectedList).toContain(path.join(fakeHome, ".ssh"));
    expect(protectedList).toContain(path.join(fakeHome, ".aws"));
  });

  it("blocks sudo/root escalation and catastrophic shell commands in host maintenance validation", () => {
    expect(() => validateHostMaintenanceCommands(["brew uninstall hindsight"])).not.toThrow();
    expect(() => validateHostMaintenanceCommands(["sudo brew uninstall hindsight"])).toThrow(/sudo/);
    expect(() => validateHostMaintenanceCommands(["echo hi && doas rm -rf /tmp/x"])).toThrow(/sudo/);
    expect(() => validateHostMaintenanceCommands(["osascript -e 'do shell script \"id\" with administrator privileges'"])).toThrow(/sudo/);
    expect(() => validateHostMaintenanceCommands(["rm -rf /"])).toThrow(/高危/);
    expect(() => validateHostMaintenanceCommands(["mkfs.ext4 /dev/sda1"])).toThrow(/高危/);
  });

  it.skipIf(process.platform !== "darwin")("exposes KULO_HOST_HOME in the worker sandbox while keeping HOME ephemeral", async () => {
    const stateDir = tempDir("host-home-state");
    const rootDir = path.join(stateDir, "workspace");
    const workspaceDir = path.join(rootDir, "table", "T-0001");
    fs.mkdirSync(rootDir, { recursive: true });
    const manager = new EnvManager({ localRootDir: rootDir, getProtectedPaths: () => [stateDir] });
    await manager.start();
    try {
      const env = manager.createWorkerExecutionEnv("local", workspaceDir);
      let output = "";
      const res = await env.exec(
        ["/bin/bash", "-c", 'printf "HOME=%s\\nHOST=%s\\n" "$HOME" "$KULO_HOST_HOME"'],
        { onOutput: (chunk) => { output += chunk; } },
        BACKGROUND_CONTEXT,
      );
      expect(res.ok && res.value.exitCode === 0, output).toBe(true);
      expect(output).toContain(`HOST=${os.homedir()}`);
      expect(output).not.toContain(`HOME=${os.homedir()}\n`);
    } finally {
      await manager.close();
    }
  });

  it.skipIf(process.platform !== "darwin")("runs read-only host diagnostics without exposing env secrets and denies protected paths", async () => {
    const root = tempDir("inspect");
    const secretDir = path.join(root, "secret-vault");
    const publicDir = path.join(root, "public-app");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "token.txt"), "secret-canary");
    fs.writeFileSync(path.join(publicDir, "marker.txt"), "public-ok");

    const service = new HostActionService({
      controlRoot: path.join(root, "control"),
      getProtectedPaths: () => [secretDir],
    });
    const result = await service.execute({
      kind: "inspect",
      scope: "summary",
      filter: String(process.pid),
      paths: [publicDir, secretDir, path.join(root, "missing-dir"), "~/.ssh"],
      limit: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.homeDir).toBe(os.homedir());
    expect(result.processes?.some((p) => p.pid === process.pid)).toBe(true);
    expect(result.paths).toEqual([
      expect.objectContaining({ path: publicDir, status: "directory", entries: ["marker.txt"] }),
      { path: secretDir, status: "denied" },
      { path: path.join(root, "missing-dir"), status: "missing" },
      { path: "~/.ssh", status: "denied" },
    ]);
  });

  it.skipIf(process.platform !== "darwin")("runs host maintenance in a credential-isolated Seatbelt sandbox: writes ordinary host paths while denying secrets, renames, env vars, and sudo", async () => {
    vi.stubEnv("KULO_AUTH_TOKEN", "hub-token-must-not-leak");
    vi.stubEnv("KULO_HINDSIGHT_ROUTER_API_KEY", "router-secret-must-not-leak");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/kulo-test-ssh-agent.sock");

    const root = tempDir("maint");
    const targetDir = path.join(root, "hindsight-install");
    const secretDir = path.join(root, "kulo-private-state");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "old.txt"), "to-delete");
    fs.writeFileSync(path.join(secretDir, "credentials.json"), "top-secret-sentinel");

    const service = new HostActionService({
      controlRoot: path.join(root, "control"),
      getProtectedPaths: () => [secretDir],
    });

    // 1. Ordinary host write/cleanup outside any project workspace succeeds
    const okRun = await service.execute({
      kind: "run",
      cwd: root,
      commands: [
        `rm -rf ${JSON.stringify(targetDir)}`,
        `echo "cleaned" > ${JSON.stringify(path.join(root, "receipt.txt"))}`,
        "/usr/bin/env",
      ],
    });
    expect(okRun.ok, JSON.stringify(okRun)).toBe(true);
    expect(okRun.exitCode).toBe(0);
    expect(okRun.steps).toHaveLength(3);
    expect(fs.existsSync(targetDir)).toBe(false);
    expect(fs.readFileSync(path.join(root, "receipt.txt"), "utf8").trim()).toBe("cleaned");
    expect(okRun.stdout).not.toMatch(/hub-token-must-not-leak|router-secret-must-not-leak|SSH_AUTH_SOCK/);
    expect(okRun.stdout).toContain(`HOME=${os.homedir()}`);

    // 2. Reading protected secret path is denied at OS Seatbelt layer
    const secretRead = await service.execute({
      kind: "run",
      cwd: root,
      commands: [`cat ${JSON.stringify(path.join(secretDir, "credentials.json"))}`],
    });
    expect(secretRead.ok).toBe(false);
    expect(secretRead.stdout).not.toContain("top-secret-sentinel");

    // 3. Writing or renaming protected path/ancestor is denied
    const secretWrite = await service.execute({
      kind: "run",
      cwd: root,
      commands: [`echo pwn > ${JSON.stringify(path.join(secretDir, "pwn.txt"))}`],
    });
    expect(secretWrite.ok).toBe(false);
    expect(fs.existsSync(path.join(secretDir, "pwn.txt"))).toBe(false);

    const profile = buildHostMaintenanceSandboxProfile({ protectedPaths: [secretDir] });
    const renameSecret = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/mv", secretDir, path.join(root, "moved-secret")], { encoding: "utf8" });
    expect(renameSecret.status).not.toBe(0);
    expect(fs.existsSync(secretDir)).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")("relays host actions over WebSocket to a remote KuloEnvAgent", async () => {
    const root = tempDir("remote-ws");
    const envRoot = path.join(root, "env");
    fs.mkdirSync(envRoot, { recursive: true });
    const manager = new EnvManager({
      enableLocal: false,
      envTokens: { "mac-mini": "mac-mini-node-token" },
      workerEnvIds: ["mac-mini"],
    });
    await manager.start();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => manager.handleEnvWebSocket(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    const agent = new KuloEnvAgent({ hubUrl: url, envId: "mac-mini", rootDir: envRoot, authToken: "mac-mini-node-token", reconnect: false });
    try {
      await agent.start();
      expect(manager.getEnvDescriptor("mac-mini")?.capabilities).toContain("host-actions");
      const inspectRes = await manager.requestHostAction("mac-mini", {
        kind: "inspect",
        scope: "processes",
        filter: "node",
        limit: 10,
      });
      expect(inspectRes.ok).toBe(true);
      expect(inspectRes.processes?.length).toBeGreaterThan(0);
    } finally {
      await agent.stop();
      await manager.close();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    }
  });
});

describe("Host action confirmation flow & hostActionPermission setting", () => {
  it("builds a GenUI-valid host action confirmation card", () => {
    const built = buildHostActionConfirmCard({
      envName: "Macmini.local",
      summary: "卸载并清理 hindsight",
      commands: ["brew uninstall hindsight", "rm -rf ~/.hindsight"],
      cwd: "/Users/demo",
    });
    expect(() => validateUiCardInput(built.input)).not.toThrow();
    expect(built.logicalIds).toEqual(["confirm", "cancel"]);
  });

  it.skipIf(process.platform !== "darwin")("persists hostActionPermission ('ask' | 'always'), blocks LLM elevation, gates 'ask' behind confirmation card, and runs immediately under 'always'", async () => {
    const stateDir = tempDir("hub-state");
    const localEnvRoot = tempDir("hub-env");
    const outsideDir = tempDir("outside-target");
    const markerAsk = path.join(outsideDir, "approved-by-card.txt");
    const markerAlways = path.join(outsideDir, "auto-allowed.txt");

    const faux = fauxProvider({ provider: "host-action-test", models: [{ id: "host-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let scenario: "worker-ask" | "worker-always" | "scout-readonly" = "worker-ask";
    let readOnlyToolError = "";

    faux.setResponses(
      Array.from({ length: 30 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const alreadyReported = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_report");
          if (alreadyReported) return fauxAssistantMessage([fauxText("Done")]);

          const hasHostAction = Boolean(ctx.tools?.some((t) => t.name === "kulo_host_action")) ||
            ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_host_action"));
          if (!hasHostAction) {
            return fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_host_action", limit: 3 })], { stopReason: "toolUse" });
          }

          const hostRunResults = ctx.messages.filter((m) => m.role === "toolResult" && m.toolName === "kulo_host_action");
          const resumedAfterApproval = ctx.messages.some(
            (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("用户已批准"),
          );
          if (resumedAfterApproval) {
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "Host maintenance completed after approval." })],
              { stopReason: "toolUse" },
            );
          }
          if (scenario === "scout-readonly") {
            if (hostRunResults.length === 0) {
              return fauxAssistantMessage(
                [fauxToolCall("kulo_host_action", { action: "run", summary: "试图写入", commands: ["echo nope"] })],
                { stopReason: "toolUse" },
              );
            }
            readOnlyToolError = hostRunResults[0]!.content.map((c) => ("text" in c ? c.text : "")).join("");
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "failed", summary: readOnlyToolError })],
              { stopReason: "toolUse" },
            );
          }
          if (hostRunResults.length === 0) {
            const targetFile = scenario === "worker-always" ? markerAlways : markerAsk;
            return fauxAssistantMessage(
              [
                fauxToolCall("kulo_host_action", {
                  action: "run",
                  summary: "写入外部测试标记",
                  commands: [`echo ok > ${JSON.stringify(targetFile)}`],
                  cwd: outsideDir,
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_report", { state: "ready", summary: "Host maintenance executed immediately." })],
            { stopReason: "toolUse" },
          );
        }

        const lastUser = ctx.messages[ctx.messages.findLastIndex((m) => m.role === "user")];
        const lastText = typeof lastUser?.content === "string" ? lastUser.content : "";
        if (lastText.includes("[KULO_WORKER_RELAY]") || lastText.includes("kulo.ui.action")) {
          return fauxAssistantMessage([fauxText("已收到更新。")]);
        }
        return fauxAssistantMessage([fauxText("好的。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "host-action-test",
      config: {
        stateDir,
        localEnvRoot,
        model: {
          defaultProvider: "host-action-test",
          defaultModel: "host-model",
          thinkingLevel: "off",
        },
      },
    });
    hubs.push(hub);

    // 1. Default setting is 'ask', invalid values rejected, SettingsAssistant cannot elevate
    const initialExec = hub.getSettingsView().blocks.executor;
    expect(initialExec.value.hostActionPermission).toBe("ask");
    await expect(
      hub.updateSettingsBlock("executor", initialExec.revision, { ...initialExec.value, hostActionPermission: "root" }),
    ).rejects.toThrow("执行权限");
    await expect(
      hub.settingsAssistant.update("executor", '{"hostActionPermission":"always"}', "自动提权", "elevate-deny"),
    ).rejects.toThrow("专用操作");
    expect(hub.getSettingsView().blocks.executor.value.hostActionPermission).toBe("ask");

    // 2. Under 'ask': writable Worker triggers confirmation card & parks cleanly; clicking Allow executes and resumes Worker
    scenario = "worker-ask";
    const t1 = await hub.dispatchTicket({
      commandId: "host-ask-1",
      title: "清理外部目录",
      goal: "在工作区外创建标记文件",
      scope: outsideDir,
      role: "coder",
      envId: "local",
    });

    let confirmCardId = "";
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const ticket = state?.tickets[t1.id];
      expect(ticket?.status).toBe("waiting");
      expect(ticket?.waiting?.reason).toBe("user");
      expect(ticket?.waiting?.waitToken).toMatch(/^host-action:/);
      confirmCardId = ticket!.waiting!.waitToken!.slice("host-action:".length);
    }, { timeout: 15_000 });

    expect(fs.existsSync(markerAsk)).toBe(false);
    const card = await hub.uiCards.get(confirmCardId);
    expect(card?.title).toContain("执行本机操作");
    const allowAction = card!.actions.find((a) => a.label === "允许执行");
    expect(allowAction).toBeTruthy();

    await hub.submitUiAction({
      cardId: card!.cardId,
      revision: card!.revision,
      actionId: allowAction!.id,
      values: {},
      commandId: "approve-host-ask-1",
    });

    await vi.waitFor(async () => {
      expect(fs.existsSync(markerAsk)).toBe(true);
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[t1.id]?.status).toBe("ready");
    }, { timeout: 15_000 });

    // 3. Switch executor setting to 'always'
    const beforeAlways = hub.getSettingsView().blocks.executor;
    const updated = await hub.updateSettingsBlock("executor", beforeAlways.revision, {
      ...beforeAlways.value,
      hostActionPermission: "always",
    });
    expect(updated.settings.blocks.executor.value.hostActionPermission).toBe("always");

    // 4. Under 'always': writable Worker executes directly WITHOUT creating a new confirmation card
    scenario = "worker-always";
    const cardsBefore = (await hub.uiCards.snapshot(Number(hub.rootConversation.id))).length;
    const t2 = await hub.dispatchTicket({
      commandId: "host-always-1",
      title: "免确认运维",
      goal: "在工作区外创建自动标记",
      scope: outsideDir,
      role: "coder",
      envId: "local",
    });
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[t2.id]?.status).toBe("ready");
    }, { timeout: 15_000 });
    expect(fs.existsSync(markerAlways)).toBe(true);
    expect((await hub.uiCards.snapshot(Number(hub.rootConversation.id))).length).toBe(cardsBefore);

    // 5. Even under 'always': readOnly role (scout) is STILL rejected from host maintenance 'run'
    scenario = "scout-readonly";
    const t3 = await hub.dispatchTicket({
      commandId: "host-scout-ro-1",
      title: "只读侦察测试",
      goal: "尝试只读角色执行 run",
      scope: outsideDir,
      role: "scout",
      envId: "local",
    });
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[t3.id]?.status).toBe("failed");
    }, { timeout: 15_000 });
    expect(readOnlyToolError).toContain("只读");
  }, 30_000);

  it.skipIf(process.platform !== "darwin")("resumes Worker cleanly on card denial without executing the command", async () => {
    const stateDir = tempDir("hub-deny-state");
    const localEnvRoot = tempDir("hub-deny-env");
    const outsideDir = tempDir("outside-deny");
    const markerDenied = path.join(outsideDir, "must-not-exist.txt");

    const faux = fauxProvider({ provider: "host-deny-test", models: [{ id: "host-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerSawDenial = false;
    faux.setResponses(
      Array.from({ length: 16 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const hasHostAction = Boolean(ctx.tools?.some((t) => t.name === "kulo_host_action")) ||
            ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_host_action"));
          if (!hasHostAction) {
            return fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_host_action", limit: 3 })], { stopReason: "toolUse" });
          }
          const sawDenial = ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("用户取消了"));
          if (sawDenial) {
            workerSawDenial = true;
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "User cancelled host maintenance." })],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_host_action", {
                action: "run",
                summary: "清理测试文件",
                commands: [`echo bad > ${JSON.stringify(markerDenied)}`],
                cwd: outsideDir,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("已了解。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "host-deny-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "host-deny-test", defaultModel: "host-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const ticket = await hub.dispatchTicket({
      commandId: "host-deny-1",
      title: "取消测试",
      goal: "测试用户拒绝本机操作",
      scope: outsideDir,
      role: "coder",
      envId: "local",
    });

    let cardId = "";
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = state?.tickets[ticket.id];
      expect(t?.status).toBe("waiting");
      expect(t?.waiting?.waitToken).toMatch(/^host-action:/);
      cardId = t!.waiting!.waitToken!.slice("host-action:".length);
    }, { timeout: 15_000 });

    const card = await hub.uiCards.get(cardId);
    const cancelAction = card!.actions.find((a) => a.label === "取消");
    expect(cancelAction).toBeTruthy();

    await hub.submitUiAction({
      cardId: card!.cardId,
      revision: card!.revision,
      actionId: cancelAction!.id,
      values: {},
      commandId: "deny-host-1",
    });

    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[ticket.id]?.status).toBe("ready");
    }, { timeout: 15_000 });
    expect(workerSawDenial).toBe(true);
    expect(fs.existsSync(markerDenied)).toBe(false);
  }, 20_000);
});
