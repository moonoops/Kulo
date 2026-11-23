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
import { buildHostActionConfirmCard, type PendingActionConfirmation } from "../packages/hub/src/action-confirmations.js";
import { resolveHostActionTargetEnv } from "../packages/hub/src/env-routing-policy.js";
import { executeApprovedHostAction } from "../packages/hub/src/host-action-execution.js";
import type { EnvNodeDescriptor } from "@kulo/protocol";
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

  it("keeps supervised host maintenance commands alive past immediate stdin EOF (regression)", async () => {
    const root = tempDir("long-running-cmd");
    const service = new HostActionService({
      controlRoot: path.join(root, "control"),
      getProtectedPaths: () => [],
    });
    const res = await service.execute({
      kind: "run",
      cwd: root,
      commands: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('survived-300ms'), 300)"`],
      timeoutMs: 15_000,
    });
    expect(res.ok).toBe(true);
    expect(res.steps?.[0]?.exitCode).toBe(0);
    expect(res.stdout).toContain("survived-300ms");
  }, 20_000);

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

describe("Host action Main-Agent authority, smart judgment, escalation cards & chat settlement", () => {
  it("builds a GenUI-valid host action confirmation card with Allow, Reject, and Manual Input", () => {
    const built = buildHostActionConfirmCard({
      envName: "Macmini.local",
      summary: "卸载并清理 hindsight",
      commands: ["brew uninstall hindsight", "rm -rf ~/.hindsight"],
      cwd: "/Users/demo",
      reason: "涉及删除本地数据目录",
    });
    expect(() => validateUiCardInput(built.input)).not.toThrow();
    expect(built.logicalIds).toEqual(["confirm", "cancel", "manual"]);
  });

  it.skipIf(process.platform !== "darwin")("lets Main Agent run host actions directly, lets Main Agent silently approve Worker requests, and still blocks read-only roles", async () => {
    const stateDir = tempDir("hub-state");
    const localEnvRoot = tempDir("hub-env");
    const outsideDir = tempDir("outside-target");
    const markerMain = path.join(outsideDir, "main-direct.txt");
    const markerWorker = path.join(outsideDir, "worker-smart-approved.txt");

    const faux = fauxProvider({ provider: "host-action-test", models: [{ id: "host-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let scenario: "worker-approve" | "scout-readonly" = "worker-approve";
    let readOnlyToolError = "";
    let orchestratorSawRequest = false;

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
            (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("主智能体已批准"),
          );
          if (resumedAfterApproval) {
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "Host maintenance completed after smart approval." })],
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
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_host_action", {
                action: "run",
                summary: "写入外部测试标记",
                commands: [`echo ok > ${JSON.stringify(markerWorker)}`],
                cwd: outsideDir,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastUser = ctx.messages[lastUserIdx];
        const lastText = typeof lastUser?.content === "string" ? lastUser.content : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (lastText.includes("[KULO_HOST_ACTION_REQUEST]")) {
          orchestratorSawRequest = true;
          if (turnResults.some((m) => m.toolName === "kulo_host_action_decide")) {
            return fauxAssistantMessage([fauxText("[COORDINATOR_OK]")]);
          }
          const reqMatch = /Request ID:\s*(\S+)/.exec(lastText);
          return fauxAssistantMessage(
            [fauxToolCall("kulo_host_action_decide", { request_id: reqMatch![1]!, decision: "approve" })],
            { stopReason: "toolUse" },
          );
        }
        if (lastText.includes("主脑直接本机运维")) {
          if (turnResults.some((m) => m.toolName === "kulo_host_action")) {
            return fauxAssistantMessage([fauxText("主脑已直接完成本机操作。")]);
          }
          const hasHostAction = Boolean(ctx.tools?.some((t) => t.name === "kulo_host_action")) ||
            ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_host_action"));
          if (!hasHostAction) {
            return fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_host_action", limit: 3 })], { stopReason: "toolUse" });
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_host_action", {
                action: "run",
                summary: "主脑直接创建测试文件",
                commands: [`echo main > ${JSON.stringify(markerMain)}`],
                cwd: outsideDir,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("已收到更新。")]);
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

    // 1. Main Agent calls kulo_host_action(run) directly without any confirmation card
    const subMain = await hub.sendUserMessage("主脑直接本机运维");
    await subMain.wait(BACKGROUND_CONTEXT);
    expect(fs.existsSync(markerMain)).toBe(true);
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    // 2. Writable Worker submits host_action -> Main Agent smart-approves silently -> executes & resumes Worker with 0 cards!
    scenario = "worker-approve";
    const t1 = await hub.dispatchTicket({
      commandId: "host-smart-1",
      title: "外部目录运维",
      goal: "在工作区外创建标记文件",
      scope: outsideDir,
      role: "coder",
      envId: "local",
    });

    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[t1.id]?.status).toBe("ready");
    }, { timeout: 15_000 });
    expect(orchestratorSawRequest).toBe(true);
    expect(fs.existsSync(markerWorker)).toBe(true);
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);
    const rootView = await hub.getTopicView("root");
    expect(rootView.messages.some((m) => m.text.includes("[KULO_HOST_ACTION_REQUEST]") || m.text.includes("[COORDINATOR_OK]"))).toBe(false);
    const rootEntries = await hub.rootConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(rootEntries.items.some((e) => e.kind === "kulo.coordinator_event")).toBe(true);
    const rootTopic = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.topics?.root;
    expect(rootTopic?.lastMessagePreview ?? "").not.toContain("[KULO_HOST_ACTION_REQUEST]");

    // 3. Read-only role (scout) is STILL rejected from host maintenance 'run'
    scenario = "scout-readonly";
    const t2 = await hub.dispatchTicket({
      commandId: "host-scout-ro-1",
      title: "只读侦察测试",
      goal: "尝试只读角色执行 run",
      scope: outsideDir,
      role: "scout",
      envId: "local",
    });
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[t2.id]?.status).toBe("failed");
    }, { timeout: 15_000 });
    expect(readOnlyToolError).toContain("只读");
  }, 30_000);

  it.skipIf(process.platform !== "darwin")("escalates risky Worker host action to card and settles the card automatically when user replies in chat instead of clicking", async () => {
    const stateDir = tempDir("hub-chat-settle-state");
    const localEnvRoot = tempDir("hub-chat-settle-env");
    const outsideDir = tempDir("outside-chat-settle");
    const markerSettled = path.join(outsideDir, "settled-by-chat.txt");

    const faux = fauxProvider({ provider: "host-settle-test", models: [{ id: "host-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let capturedRequestId = "";
    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
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
          const resumed = ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("已批准"));
          if (resumed) {
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "Completed after chat settlement." })],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_host_action", {
                action: "run",
                summary: "高风险清理操作",
                commands: [`echo chat-ok > ${JSON.stringify(markerSettled)}`],
                cwd: outsideDir,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastText = typeof ctx.messages[lastUserIdx]?.content === "string" ? ctx.messages[lastUserIdx]!.content as string : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (lastText.includes("[KULO_HOST_ACTION_REQUEST]")) {
          const reqMatch = /Request ID:\s*(\S+)/.exec(lastText);
          capturedRequestId = reqMatch![1]!;
          if (turnResults.some((m) => m.toolName === "kulo_host_action_decide")) {
            return fauxAssistantMessage([fauxText("这项操作有一定风险，请在卡片确认或直接回复我。")]);
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_host_action_decide", { request_id: capturedRequestId, decision: "ask_user", reason: "涉及外部目录写入" })],
            { stopReason: "toolUse" },
          );
        }
        if (lastText.includes("允许执行吧")) {
          if (turnResults.some((m) => m.toolName === "kulo_host_action_decide")) {
            return fauxAssistantMessage([fauxText("好的，已替你执行并恢复任务。")]);
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_host_action_decide", { request_id: capturedRequestId, decision: "approve" })],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("任务已完成。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "host-settle-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "host-settle-test", defaultModel: "host-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const ticket = await hub.dispatchTicket({
      commandId: "host-escalate-1",
      title: "风险清理任务",
      goal: "测试升级弹卡与对话收口",
      scope: outsideDir,
      role: "coder",
      envId: "local",
    });

    let cardId = "";
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = state?.tickets[ticket.id];
      expect(t?.status).toBe("waiting");
      expect(t?.waiting?.reason).toBe("user");
      expect(t?.waiting?.cardId).toBeTruthy();
      expect(t?.waiting?.options?.map((o) => o.label)).toEqual(["允许", "拒绝"]);
      cardId = t!.waiting!.cardId!;
    }, { timeout: 15_000 });

    expect(fs.existsSync(markerSettled)).toBe(false);
    const openCard = await hub.uiCards.get(cardId);
    expect(openCard?.status).toBe("ready");

    // User replies in natural language chat WITHOUT clicking the card!
    const sub = await hub.sendUserMessage("允许执行吧");
    await sub.wait(BACKGROUND_CONTEXT);

    await vi.waitFor(async () => {
      expect(fs.existsSync(markerSettled)).toBe(true);
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[ticket.id]?.status).toBe("ready");
    }, { timeout: 15_000 });

    // The open card was automatically settled and locked so it cannot be double-clicked!
    const settledCard = await hub.uiCards.get(cardId);
    expect(settledCard?.status).toBe("submitted");
    expect(settledCard?.resultSummary).toBe("已通过对话允许");
  }, 30_000);

  it.skipIf(process.platform !== "darwin")("resumes Worker cleanly on escalated card denial without executing the command", async () => {
    const stateDir = tempDir("hub-deny-state");
    const localEnvRoot = tempDir("hub-deny-env");
    const outsideDir = tempDir("outside-deny");
    const markerDenied = path.join(outsideDir, "must-not-exist.txt");

    const faux = fauxProvider({ provider: "host-deny-test", models: [{ id: "host-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerSawDenial = false;
    faux.setResponses(
      Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const hasHostAction = Boolean(ctx.tools?.some((t) => t.name === "kulo_host_action")) ||
            ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_host_action"));
          if (!hasHostAction) {
            return fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_host_action", limit: 3 })], { stopReason: "toolUse" });
          }
          const sawDenial = ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("用户拒绝了"));
          if (sawDenial) {
            workerSawDenial = true;
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "User rejected host maintenance." })],
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
        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastText = typeof ctx.messages[lastUserIdx]?.content === "string" ? ctx.messages[lastUserIdx]!.content as string : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
        if (lastText.includes("[KULO_HOST_ACTION_REQUEST]") && !turnResults.some((m) => m.toolName === "kulo_host_action_decide")) {
          const reqMatch = /Request ID:\s*(\S+)/.exec(lastText);
          return fauxAssistantMessage(
            [fauxToolCall("kulo_host_action_decide", { request_id: reqMatch![1]!, decision: "ask_user", reason: "请确认是否清理" })],
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
      expect(t?.waiting?.reason).toBe("user");
      expect(t?.waiting?.cardId).toBeTruthy();
      cardId = t!.waiting!.cardId!;
    }, { timeout: 15_000 });

    const card = await hub.uiCards.get(cardId);
    const cancelAction = card!.actions.find((a) => a.label === "拒绝");
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
  }, 25_000);

  it("enforces durable markDispatched -> markOutcome and abortSignal forwarding in executeApprovedHostAction", async () => {
    const baseRecord: PendingActionConfirmation = {
      id: "confirm-ha-1",
      fingerprint: "fp-1",
      status: "approved",
      effect: "none",
      actionMap: {},
      createdAt: 1,
      updatedAt: 1,
      payload: {
        kind: "host_action",
        ticketId: "T-0099",
        envId: "local",
        envName: "Local Mac",
        summary: "重启服务",
        commands: ["echo ok"],
      },
    };
    const events: string[] = [];
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;

    // 1. Success path: markDispatched -> outward action -> requestHostAction(signal) -> markOutcome(confirmed)
    const okRes = await executeApprovedHostAction(
      {
        actionConfirmations: {
          markDispatched: async (id) => { events.push(`dispatched:${id}`); return true; },
          markOutcome: async (id, outcome) => { events.push(`outcome:${id}:${outcome}`); return true; },
        },
        envManager: {
          requestHostAction: async (_envId, _req, signal) => {
            seenSignal = signal;
            events.push("exec");
            return { ok: true, kind: "run", steps: [] } as never;
          },
        },
        redact: (s) => s,
        recordOutwardAction: async (ticketId, summary) => { events.push(`outward:${ticketId}:${summary}`); },
      },
      baseRecord,
      { actorLabel: "用户", context: { ...BACKGROUND_CONTEXT, abortSignal: controller.signal } },
    );
    expect(okRes.status).toBe("executed");
    expect(seenSignal).toBe(controller.signal);
    expect(events).toEqual([
      "dispatched:confirm-ha-1",
      "outward:T-0099:host_action:重启服务",
      "exec",
      "outcome:confirm-ha-1:confirmed",
    ]);

    // 2. Duplicate dispatch guard refuses re-execution when markDispatched returns false
    const dupExec = vi.fn();
    const dupRes = await executeApprovedHostAction(
      {
        actionConfirmations: {
          markDispatched: async () => false,
          markOutcome: async () => true,
        },
        envManager: { requestHostAction: dupExec },
        redact: (s) => s,
        recordOutwardAction: async () => {},
      },
      baseRecord,
      { actorLabel: "用户" },
    );
    expect(dupRes.status).toBe("already_dispatched");
    expect(dupExec).not.toHaveBeenCalled();

    // 3. Transport failure after dispatch marks outcome as "unknown" (never auto-replayed)
    const outcomes: string[] = [];
    const failRes = await executeApprovedHostAction(
      {
        actionConfirmations: {
          markDispatched: async () => true,
          markOutcome: async (_id, outcome) => { outcomes.push(outcome); return true; },
        },
        envManager: { requestHostAction: async () => { throw new Error("socket reset"); } },
        redact: (s) => s,
        recordOutwardAction: async () => {},
      },
      baseRecord,
      { actorLabel: "用户" },
    );
    expect(failRes.status).toBe("failed");
    expect(outcomes).toEqual(["unknown"]);
  });

  it("enforces six-tier host-action routing: explicit, project lock, multi-turn context, sender computer, offline sender guard, and phone proactive Hub fallback", () => {
    const hubEnv: EnvNodeDescriptor = {
      id: "local", name: "MacMini", kind: "local", online: true,
      platform: "darwin", arch: "arm64", rootDir: "/hub", capabilities: ["fs", "bash", "host-actions"], connectedAt: 1, lastSeenAt: 1,
    };
    const macbookOnline: EnvNodeDescriptor = {
      id: "macbook", name: "MacBook", kind: "reverse-ws", online: true,
      platform: "darwin", arch: "arm64", rootDir: "/mb", capabilities: ["fs", "bash", "host-actions"], connectedAt: 1, lastSeenAt: 1,
    };
    const macbookOffline: EnvNodeDescriptor = { ...macbookOnline, online: false };
    const phoneEnv: EnvNodeDescriptor = {
      id: "pixel", name: "K90Ultra", kind: "reverse-ws", online: true,
      platform: "android", arch: "arm64", rootDir: "", executionKind: "native-device", capabilities: ["android-native-v1"], connectedAt: 1, lastSeenAt: 1,
    };
    const resolve = (envs: EnvNodeDescriptor[], overrides: Partial<Parameters<typeof resolveHostActionTargetEnv>[0]>) =>
      resolveHostActionTargetEnv({
        envs,
        getEnvDescriptor: (id) => envs.find((e) => e.id === id),
        localEnvId: "local",
        pickDefaultEnvId: () => "local",
        ...overrides,
      });

    // Tier 1: explicit env_id wins over sender
    expect(resolve([hubEnv, macbookOnline], {
      requestedEnvId: "local",
      sourceDeviceId: "macbook",
      currentText: "检查主机上的服务",
    })).toMatchObject({ ok: true, envId: "local" });

    // Tier 2: project lock enforces project device and rejects conflicting named computer
    expect(resolve([hubEnv, macbookOnline], {
      projectDeviceId: "macbook",
      sourceDeviceId: "local",
      currentText: "检查进程",
    })).toMatchObject({ ok: true, envId: "macbook" });
    expect(resolve([hubEnv, macbookOnline], {
      projectDeviceId: "macbook",
      sourceDeviceId: "local",
      currentText: "检查 MacMini 上的进程",
    })).toMatchObject({ ok: false });

    // Tier 4: multi-turn contextual continuation keeps MacBook when phone follows up without renaming
    expect(resolve([hubEnv, macbookOnline, phoneEnv], {
      sourceDeviceId: "pixel",
      currentText: "再看下内存占用",
      priorUserTurns: [{ text: "帮我查一下 MacBook 上的 Node 进程", sourceDeviceId: "pixel" }],
    })).toMatchObject({ ok: true, envId: "macbook" });

    // Tier 4 offline guard: prior named MacBook offline MUST NOT silently drift to Hub
    expect(resolve([hubEnv, macbookOffline, phoneEnv], {
      sourceDeviceId: "pixel",
      currentText: "再看下内存占用",
      priorUserTurns: [{ text: "帮我查一下 MacBook 上的 Node 进程", sourceDeviceId: "pixel" }],
    })).toMatchObject({ ok: false, message: expect.stringContaining("当前离线") });

    // Tier 5: online sender computer routes to itself; offline sender computer returns error (never silently drifts to Hub)
    expect(resolve([hubEnv, macbookOnline], {
      sourceDeviceId: "macbook",
      currentText: "查一下本机端口占用",
    })).toMatchObject({ ok: true, envId: "macbook" });
    expect(resolve([hubEnv, macbookOffline], {
      sourceDeviceId: "macbook",
      currentText: "查一下本机端口占用",
    })).toMatchObject({ ok: false, message: expect.stringContaining("执行通道离线") });

    // Tier 6: phone sender with no prior computer context proactively falls back to Hub with routedToHubFallback=true
    expect(resolve([hubEnv, macbookOnline, phoneEnv], {
      sourceDeviceId: "pixel",
      currentText: "查一下后台服务运行状态",
    })).toMatchObject({ ok: true, envId: "local", routedToHubFallback: true });
  });
});
