import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { isDeviceSystemInfo, type DeviceInvitation, type DevicePeerConfig, type EnvNodeDescriptor, type HubToClientMessage, type TicketRecord } from "@kulo/protocol";
import { parseMacHardwareModelOutput } from "../packages/env/src/device-info.js";
import {
  KuloStateDoc,
  canSwitchEnvDuringRecovery,
  detectSenderLocalSignals,
  hasExplicitSenderReference,
  hasWorkerIsolation,
  namedDispatchDevices,
  resolveComputerEnvBinding,
  resolveNamedOrContextualEnv,
  startKuloHubServer,
} from "@kulo/hub";
import { composeWorkerInstructions } from "../packages/hub/src/prompts/worker.js";
import { formatWorkerRecoveryMessage } from "../packages/hub/src/prompts/events-and-jobs.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => unknown | Promise<unknown>> = [];
const waitOptions = { timeout: 6_000, interval: 25 };

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("Batch 1b — R3 & R1.5 Pure Routing & Recovery Policy", () => {
  const onlineLocal: EnvNodeDescriptor = {
    id: "local",
    name: "Kulo Hub",
    kind: "local",
    online: true,
    platform: "darwin",
    arch: "arm64",
    rootDir: "/tmp/hub",
    capabilities: ["fs", "bash", "worker-isolation"],
    connectedAt: 1,
    lastSeenAt: 1,
  };

  it("detects bilingual sender-local signals while leaving pure general tasks location-independent", () => {
    expect(detectSenderLocalSignals({ userMessage: "帮我读一下 ~/Downloads/a.pdf" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "看看 /Users/alice/work/foo.ts" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "检查 C:\\Users\\Bob\\report.docx" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "查看 localhost:3000 为什么报错" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "调试 :5173 前端热更新" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "把桌面上的截图发我" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "check my Desktop folder" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "读取剪贴板内容" })).toBe(true);
    expect(detectSenderLocalSignals({ userMessage: "检查我电脑上当前打开的页面" })).toBe(true);
    expect(detectSenderLocalSignals({ goal: "inspect /opt/laptop-root/foo", senderRootDir: "/opt/laptop-root" })).toBe(true);

    expect(detectSenderLocalSignals({ userMessage: "调研 SQLite WAL 模式和 Raft 共识算法的区别，并给出架构方案" })).toBe(false);
    expect(detectSenderLocalSignals({ userMessage: "Summarize the uploaded PDF report and draft a proposal." })).toBe(false);
  });

  it("resolves 3-tier envBinding, enforces local-signal override over target_scope='hub_local', and blocks 3rd-device drift", () => {
    // General task from paired laptop -> routes to Hub local when online & isolated
    const general = resolveComputerEnvBinding({
      sourceEnvId: "laptop-a",
      targetScope: "hub_local",
      userMessage: "帮我做一份多模型对比方案",
      localEnv: onlineLocal,
      pickFallbackEnvId: () => "laptop-a",
    });
    expect(general).toEqual({ envId: "local", envBinding: "hub_local", waitForSource: false });

    // Local signal overrides erroneous target_scope='hub_local'
    const overridden = resolveComputerEnvBinding({
      sourceEnvId: "laptop-a",
      targetScope: "hub_local",
      userMessage: "帮我看看桌面上那个 PDF",
      localEnv: onlineLocal,
      pickFallbackEnvId: () => "local",
    });
    expect(overridden).toEqual({ envId: "laptop-a", envBinding: "sender_local", waitForSource: true });

    // 3rd unnamed edge device C rejected with conflictWithSource
    const thirdDevice = resolveComputerEnvBinding({
      sourceEnvId: "laptop-a",
      proposedEnvId: "edge-c",
      userMessage: "帮我做一份调研",
      localEnv: onlineLocal,
      pickFallbackEnvId: () => "local",
    });
    expect(thirdDevice.conflictWithSource).toBe(true);

    // Offline local falls back ONLY to authenticated sourceEnv
    const fallback = resolveComputerEnvBinding({
      sourceEnvId: "laptop-a",
      targetScope: "hub_local",
      userMessage: "分析上传的附件",
      localEnv: { ...onlineLocal, online: false },
      pickFallbackEnvId: () => "edge-c",
    });
    expect(fallback).toEqual({ envId: "laptop-a", envBinding: "sender_local", waitForSource: true });

    // Explicit proposedEnvId === sourceEnvId must NEVER be silently downgraded to Hub local
    const explicitSenderId = resolveComputerEnvBinding({
      sourceEnvId: "laptop-a",
      proposedEnvId: "laptop-a",
      userMessage: "测试 browser use 和 computer use",
      goal: "Run agent-browser and Calculator check",
      scope: "browser and calculator",
      localEnv: onlineLocal,
      pickFallbackEnvId: () => "local",
    });
    expect(explicitSenderId).toEqual({ envId: "laptop-a", envBinding: "sender_local", waitForSource: true });

    // Explicit sender ID contradicting target_scope='hub_local' surfaces conflict instead of silent reroute
    const conflictingSenderId = resolveComputerEnvBinding({
      sourceEnvId: "laptop-a",
      proposedEnvId: "laptop-a",
      targetScope: "hub_local",
      userMessage: "帮我做一份调研",
      localEnv: onlineLocal,
      pickFallbackEnvId: () => "local",
    });
    expect(conflictingSenderId.conflictWithSource).toBe(true);
  });

  it("enforces R1.5 recovery lock across legacy tickets, manual agents, topic targets, deviceStateTouched, and cleanupPending", () => {
    const baseHubLocal: TicketRecord = {
      id: "T-0001",
      commandId: "cmd-1",
      title: "Research",
      goal: "Research",
      scope: "web",
      role: "scout",
      status: "failed",
      envId: "local",
      envBinding: "hub_local",
      workspaceDir: "/tmp/t1",
      workerConversationId: 2,
      runEpoch: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(canSwitchEnvDuringRecovery(baseHubLocal)).toBe(true);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, envBinding: undefined })).toBe(false);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, envBinding: "sender_local" })).toBe(false);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, projectId: "proj-1" })).toBe(false);
    expect(canSwitchEnvDuringRecovery(baseHubLocal, "laptop-a")).toBe(false);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, agentAssignment: { agentId: "scout", source: "manual" } })).toBe(false);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, agentAssignment: { agentId: "scout", source: "explicit" } })).toBe(false);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, deviceStateTouched: true })).toBe(false);
    expect(canSwitchEnvDuringRecovery({ ...baseHubLocal, cleanupPending: true })).toBe(false);

    expect(formatWorkerRecoveryMessage({ ticketId: "T-1", title: "X", summary: "err", attempt: 1, maxAttempts: 3, deviceLocked: true, envId: "laptop-a" }))
      .toContain("LOCKED to `laptop-a`");
    expect(formatWorkerRecoveryMessage({ ticketId: "T-1", title: "X", summary: "err", attempt: 1, maxAttempts: 3, deviceLocked: false, envId: "local" }))
      .toContain("Stateless `hub_local` task");
  });

  it("injects Cross-Device Guard only when a remote device's task executes on Hub local", () => {
    const remoteOnLocal = composeWorkerInstructions(
      {
        id: "T-0010",
        title: "Research",
        goal: "Summarize",
        scope: "notes",
        envId: "local",
        workspaceDir: "/tmp/hub/table/T-0010",
        senderSource: { deviceId: "laptop-a", name: "MacBook Air" },
      },
      undefined,
    );
    expect(remoteOnLocal).toContain("Cross-Device Guard");
    expect(remoteOnLocal).toContain("MacBook Air");
    expect(remoteOnLocal).toContain("laptop-a");

    const sameDevice = composeWorkerInstructions(
      {
        id: "T-0011",
        title: "Local",
        goal: "Check",
        scope: "notes",
        envId: "laptop-a",
        workspaceDir: "/tmp/laptop/table/T-0011",
        senderSource: { deviceId: "laptop-a", name: "MacBook Air" },
      },
      undefined,
    );
    expect(sameDevice).not.toContain("Cross-Device Guard");

    const explicitHubTarget = composeWorkerInstructions(
      {
        id: "T-0012",
        title: "Check Hub Hindsight",
        goal: "Check Macmini.local",
        scope: "Macmini.local",
        envId: "local",
        envBinding: "message_named",
        workspaceDir: "/tmp/hub/table/T-0012",
        senderSource: { deviceId: "laptop-a", name: "MacBook Pro" },
      },
      undefined,
    );
    expect(explicitHubTarget).not.toContain("Cross-Device Guard");
  });

  it("matches .local hostnames, compact/spaced variants, and natural Chinese/English verbs while preserving negations and avoiding generic 'local'", () => {
    const macMini: EnvNodeDescriptor = {
      ...onlineLocal,
      id: "local",
      name: "Macmini.local",
      info: { hostname: "Macmini.local", platform: "darwin", arch: "arm64", release: "24", cpu: "Apple", memoryBytes: 0, ips: [] },
    };
    const macBook: EnvNodeDescriptor = {
      ...onlineLocal,
      id: "device-mbp",
      kind: "reverse-ws",
      name: "Dev-Laptop.local",
      info: { hostname: "Dev-Laptop.local", platform: "darwin", arch: "arm64", release: "24", cpu: "Apple", memoryBytes: 0, ips: [] },
    };
    const envs = [macMini, macBook];

    expect(namedDispatchDevices("检查一下macmini本机是否安装了hindsight，安装了的话就删了吧~", envs)).toEqual([["local"]]);
    expect(namedDispatchDevices("看看 Mac mini 的配置", envs)).toEqual([["local"]]);
    expect(namedDispatchDevices("把 Mac-mini 上的 hindsight 删掉", envs)).toEqual([["local"]]);
    expect(namedDispatchDevices("修改 Macmini.local 的系统设置", envs)).toEqual([["local"]]);
    expect(namedDispatchDevices("check Macmini's config and uninstall hindsight", envs)).toEqual([["local"]]);
    expect(namedDispatchDevices("在主脑上检查一下安装情况", envs)).toEqual([["local"]]);

    // Negations, hypotheticals, and generic English "local" must NOT match Hub local
    expect(namedDispatchDevices("不要在 macmini 上执行", envs)).toEqual([]);
    expect(namedDispatchDevices("如果 macmini 离线怎么办", envs)).toEqual([]);
    expect(namedDispatchDevices("check local files in ~/Downloads", envs)).toEqual([]);
  });

  it("supports multi-turn contextual carry-over for explicitly named devices while respecting explicit sender pivots", () => {
    const macMini: EnvNodeDescriptor = { ...onlineLocal, id: "local", name: "Macmini.local" };
    const macBook: EnvNodeDescriptor = { ...onlineLocal, id: "device-mbp", kind: "reverse-ws", name: "Dev-Laptop.local" };
    const office: EnvNodeDescriptor = { ...onlineLocal, id: "device-office", kind: "reverse-ws", name: "办公室工作站" };
    const envs = [macMini, macBook, office];

    // Turn 1: explicit current mention
    expect(
      resolveNamedOrContextualEnv({
        currentText: "检查一下macmini本机是否安装了hindsight",
        envs,
        proposedEnvId: "local",
      }),
    ).toEqual({ envId: "local", source: "current" });

    // Turn 1 with omitted env_id still resolves unambiguously to Macmini
    expect(
      resolveNamedOrContextualEnv({
        currentText: "检查一下macmini本机是否安装了hindsight",
        envs,
      }),
    ).toEqual({ envId: "local", source: "current" });

    // Turn 2: follow-up without repeating device name carries over Macmini when model passes env_id="local"
    expect(
      resolveNamedOrContextualEnv({
        currentText: "那就把 ~/.hindsight 也删了吧",
        priorUserTurns: [{ text: "检查一下macmini本机是否安装了hindsight", sourceDeviceId: "device-mbp" }],
        envs,
        proposedEnvId: "local",
      }),
    ).toEqual({ envId: "local", source: "context" });

    // Turn 3: explicit pivot back to sender ("这台电脑") blocks carry-over
    expect(hasExplicitSenderReference("现在帮我检查这台电脑上的日志")).toBe(true);
    expect(
      resolveNamedOrContextualEnv({
        currentText: "现在帮我检查这台电脑上的日志",
        priorUserTurns: [{ text: "检查一下macmini本机是否安装了hindsight", sourceDeviceId: "device-mbp" }],
        envs,
        proposedEnvId: "local",
      }),
    ).toBeUndefined();

    // After a prior turn pivoted back to sender, subsequent follow-up does NOT carry over stale Macmini
    expect(
      resolveNamedOrContextualEnv({
        currentText: "删掉那个日志文件",
        priorUserTurns: [
          { text: "现在帮我检查这台电脑上的日志", sourceDeviceId: "device-mbp" },
          { text: "检查一下macmini本机是否安装了hindsight", sourceDeviceId: "device-mbp" },
        ],
        envs,
        proposedEnvId: "local",
      }),
    ).toBeUndefined();

    // Unmentioned 3rd device is never carried over
    expect(
      resolveNamedOrContextualEnv({
        currentText: "帮我做一份调研",
        priorUserTurns: [{ text: "检查一下macmini本机是否安装了hindsight", sourceDeviceId: "device-mbp" }],
        envs,
        proposedEnvId: "device-office",
      }),
    ).toBeUndefined();

    // Explicit target_scope='sender_device' is never hijacked by a partial device name match in a multi-device prompt
    expect(
      resolveNamedOrContextualEnv({
        currentText: "在 MacMini 和 Macbook 上测试一下浏览器自动化",
        envs,
        targetScope: "sender_device",
      }),
    ).toBeUndefined();
  });

  it("parses macOS hardware models and derives device aliases even when hostname has a typo", () => {
    expect(parseMacHardwareModelOutput({ ioregProduct: '"product-name" = <"MacBook Pro (14-inch, M3 Pro)">' })).toBe("MacBook Pro (14-inch, M3 Pro)");
    expect(parseMacHardwareModelOutput({ systemProfiler: "  Model Name: Mac mini\n  Model Identifier: Mac14,3" })).toBe("Mac mini");
    expect(parseMacHardwareModelOutput({ sysctlHwModel: "MacBookPro18,1\n" })).toBe("MacBookPro18,1");

    expect(isDeviceSystemInfo({
      hostname: "Dev-Laptop.local",
      platform: "darwin",
      arch: "arm64",
      release: "24",
      cpu: "Apple",
      memoryBytes: 1024,
      ips: [],
      model: "MacBook Pro (14-inch, M3 Pro)",
    })).toBe(true);
    expect(isDeviceSystemInfo({
      hostname: "bad",
      platform: "darwin",
      arch: "arm64",
      release: "24",
      cpu: "Apple",
      memoryBytes: 1024,
      ips: [],
      model: "bad\u0000model",
    })).toBe(false);

    const macMini: EnvNodeDescriptor = {
      ...onlineLocal,
      id: "local",
      name: "Macmini.local",
      info: { hostname: "Macmini.local", platform: "darwin", arch: "arm64", release: "24", cpu: "Apple", memoryBytes: 0, ips: [], model: "Macmini9,1" },
    };
    const macBookWithTypoHostname: EnvNodeDescriptor = {
      ...onlineLocal,
      id: "device-mbp",
      kind: "reverse-ws",
      name: "Dev-Laptop.local",
      info: { hostname: "Dev-Laptop.local", platform: "darwin", arch: "arm64", release: "24", cpu: "Apple", memoryBytes: 0, ips: [], model: "MacBook Pro (14-inch, M3 Pro)" },
    };
    expect(namedDispatchDevices("在 MacMini 和 Macbook 上测试一下浏览器自动化", [macMini, macBookWithTypoHostname])).toEqual([["local"], ["device-mbp"]]);
    expect(namedDispatchDevices("在 MacBook Pro 上打开计算器", [macMini, macBookWithTypoHostname])).toEqual([["device-mbp"]]);

    // Explicit device name always takes precedence over another machine's hardware model fallback
    const renamedHostLaptop: EnvNodeDescriptor = {
      ...onlineLocal,
      id: "local",
      name: "客厅主脑",
      info: { hostname: "server.local", platform: "darwin", arch: "arm64", release: "24", cpu: "Apple", memoryBytes: 0, ips: [], model: "MacBook Pro (14-inch, M3 Pro)" },
    };
    const explicitMacBook: EnvNodeDescriptor = {
      ...onlineLocal,
      id: "device-explicit-mb",
      kind: "reverse-ws",
      name: "Macbook",
    };
    expect(namedDispatchDevices("在 Macbook 上打开计算器", [renamedHostLaptop, explicitMacBook])).toEqual([["device-explicit-mb"]]);
  });

  it("checks worker-isolation capability properly", () => {
    expect(hasWorkerIsolation(onlineLocal)).toBe(true);
    expect(hasWorkerIsolation({ ...onlineLocal, capabilities: ["fs", "bash"] })).toBe(false);
    expect(hasWorkerIsolation({ ...onlineLocal, capabilities: ["worker-isolation", "worker-isolation-unavailable"] })).toBe(false);
    expect(hasWorkerIsolation({ ...onlineLocal, executionKind: "native-device", capabilities: ["android-native-v1"] })).toBe(false);
  });
});

describe("Batch 1b — Live Hub E2E Routing, Cross-Device Guard, Phone Attachments & Isolation Precheck", () => {
  function hasTool(request: TranscriptContext, name: string): boolean {
    return Boolean(request.tools?.some((tool) => tool.name === name)) ||
      request.messages.some((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === name));
  }

  it("routes laptop general tasks to Hub local, forces laptop desktop tasks back to laptop, routes phone attachment tasks to Hub local, and rejects unisolated remote devices", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-batch1b-e2e-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = fauxProvider({ provider: "openai", models: [{ id: "routing-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const actions = new Map<string, { name: string; args: Record<string, unknown> }>();
    const consumed = new Set<string>();

    provider.setResponses(Array.from({ length: 40 }, () => async (request: TranscriptContext) => {
      if (hasTool(request, "kulo_dispatch")) {
        const lastUser = request.messages.filter((m) => m.role === "user").at(-1)?.content;
        const input = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
        for (const [marker, call] of actions) {
          if (input.includes(marker) && !consumed.has(marker)) {
            consumed.add(marker);
            return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
          }
        }
      } else if (hasTool(request, "kulo_report")) {
        return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "ok" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("done");
    }));

    const hub = await openTestHub({
      models,
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "local"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        envTokens: {},
        enableLocalEnv: true,
        maxConcurrentWorkers: 3,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "routing-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
      },
    });
    cleanups.push(() => hub.close());

    vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
    vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockResolvedValue({ cleanupPending: false });

    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    const apiReq = (pathname: string, method: string, body: unknown, auth = true) =>
      fetch(`${server.url}${pathname}`, {
        method,
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
    expect((await apiReq("/api/devices", "PATCH", { enabled: true })).status).toBe(200);

    async function pair(name: string): Promise<DevicePeerConfig> {
      const invite = await apiReq("/api/devices/invitations", "POST", { name, hubUrl: "https://hub.test" });
      const invitation = (await invite.json()) as DeviceInvitation;
      const token = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)![1]!;
      const rootDir = path.join(dir, invitation.deviceId);
      fs.mkdirSync(rootDir, { recursive: true });
      const paired = await apiReq(
        "/api/devices/pair",
        "POST",
        {
          inviteToken: token,
          rootDir,
          info: { hostname: name, platform: process.platform, arch: process.arch, release: "test", cpu: "test", memoryBytes: 0, ips: [] },
        },
        false,
      );
      return (await paired.json()) as DevicePeerConfig;
    }

    async function connectEnv(device: DevicePeerConfig, capabilities: string[]) {
      const ws = new WebSocket(server.envWsUrl);
      cleanups.push(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); });
      await once(ws, "open");
      const reg = once(ws, "message");
      ws.send(JSON.stringify({
        type: "env.register",
        envId: device.deviceId,
        token: device.envToken,
        name: device.name,
        platform: process.platform,
        arch: process.arch,
        rootDir: device.rootDir,
        capabilities,
      }));
      await reg;
      return ws;
    }

    async function connectChat(device: DevicePeerConfig) {
      const ws = new WebSocket(server.clientWsUrl, { headers: { authorization: `Bearer ${device.clientToken}` } });
      cleanups.push(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); });
      const msgs: HubToClientMessage[] = [];
      ws.on("message", (raw) => msgs.push(JSON.parse(String(raw)) as HubToClientMessage));
      await once(ws, "open");
      await vi.waitFor(() => expect(msgs.some((m) => m.type === "hub.snapshot")).toBe(true), waitOptions);
      return async (requestId: string, content: string) => {
        const start = msgs.length;
        ws.send(JSON.stringify({ type: "chat.send", topicId: "root", requestId, content }));
        await vi.waitFor(() => expect(msgs.slice(start).some((m) => m.type === "hub.ack" && m.requestId === requestId)).toBe(true), waitOptions);
      };
    }

    const laptop = await pair("随身轻薄本");
    const noSandbox = await pair("无沙箱旧电脑");
    await connectEnv(laptop, ["fs", "worker-isolation"]);
    await connectEnv(noSandbox, ["fs", "bash"]);
    const sendFromLaptop = await connectChat(laptop);

    // 1) Laptop sends location-independent research -> runs on Hub "local" with envBinding="hub_local"
    actions.set("[general-research]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-hub-local-1",
        title: "调研架构方案",
        goal: "对比 SQLite WAL 与 Raft 一致性权衡",
        scope: "公开文档与技术资料",
        role: "scout",
        target_scope: "hub_local",
      },
    });
    await sendFromLaptop("req-gen-1", "[general-research] 帮我对比一下 SQLite WAL 与 Raft 的优缺点。");
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const t = Object.values(snap?.tickets ?? {}).find((x) => x.commandId === "cmd-hub-local-1");
      expect(t?.status).toBe("ready");
      expect(t?.envId).toBe("local");
      expect(t?.envBinding).toBe("hub_local");
      expect(t?.senderSource).toEqual({ deviceId: laptop.deviceId, name: laptop.name });
    }, waitOptions);

    // 2) Laptop mentions "桌面" even if model mistakenly sets target_scope="hub_local" -> forced to laptop ("sender_local")!
    actions.set("[desktop-override]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-sender-override-1",
        title: "检查桌面文件",
        goal: "检查桌面上的报销单",
        scope: "桌面文件",
        role: "scout",
        target_scope: "hub_local",
      },
    });
    await sendFromLaptop("req-desk-1", "[desktop-override] 帮我看看桌面上的报销单。");
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const t = Object.values(snap?.tickets ?? {}).find((x) => x.commandId === "cmd-sender-override-1");
      expect(t?.status).toBe("ready");
      expect(t?.envId).toBe(laptop.deviceId);
      expect(t?.envBinding).toBe("sender_local");
    }, waitOptions);

    // 3) Phone sends uploaded attachment without explicit execution_domain -> computer domain on Hub "local" (NOT android!)
    const uploaded = hub.uploads.saveUpload({
      name: "q3-report.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("# Q3 Report\nRevenue grew 20%.\n", "utf8"),
    });
    hub.uploads.bindAttachments([uploaded], "conversation:1");
    const phone: EnvNodeDescriptor = {
      id: "phone-1",
      name: "Android 手机",
      kind: "reverse-ws",
      online: true,
      platform: "android",
      arch: "arm64",
      rootDir: "",
      executionKind: "native-device",
      capabilities: ["android-native-v1"],
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      android: { version: 1, catalogVersion: 3, enabled: true, paused: false, revision: 1, grants: ["device"], capabilities: [] },
    };
    const origGet = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    const origList = hub.envManager.listEnvs.bind(hub.envManager);
    vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => (id === phone.id ? phone : origGet(id)));
    vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => [...origList(), phone]);

    actions.set("[phone-attachment]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-phone-att-1",
        title: "分析季度报告",
        goal: "总结上传的 Q3 报告核心数据",
        scope: "上传附件分析",
        role: "scout",
        attachment_ids: [uploaded.id],
      },
    });
    await hub.sendUserMessage("[phone-attachment] 帮我总结这份报告的核心结论。", {
      principalId: phone.id,
      requestId: "req-phone-att-1",
      source: { deviceId: phone.id, name: phone.name, kind: "android" },
    });
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const t = Object.values(snap?.tickets ?? {}).find((x) => x.commandId === "cmd-phone-att-1");
      expect(t?.status).toBe("ready");
      expect(t?.executionDomain).toBe("computer");
      expect(t?.envId).toBe("local");
      expect(t?.envBinding).toBe("hub_local");
    }, waitOptions);

    // 4) Pre-dispatch worker-isolation check rejects online computer without worker-isolation
    await expect(
      hub.dispatchTicket({
        commandId: "cmd-no-sandbox-1",
        title: "无沙箱测试",
        goal: "测试预检",
        scope: "temp",
        role: "coder",
        envId: noSandbox.deviceId,
      }),
    ).rejects.toMatchObject({ code: "worker_isolation_unavailable" });
  });

  it("allows an offline paired MacBook to target online Macmini.local by short name, carries over on follow-up turns, and blocks explicit sender pivots", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-cross-device-macmini-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = fauxProvider({ provider: "openai", models: [{ id: "cross-device-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const actions = new Map<string, { name: string; args: Record<string, unknown> }>();
    const consumed = new Set<string>();
    const dispatchErrors: string[] = [];

    provider.setResponses(Array.from({ length: 40 }, () => async (request: TranscriptContext) => {
      if (hasTool(request, "kulo_dispatch")) {
        const lastTool = request.messages.at(-1);
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_dispatch" && lastTool.isError) {
          dispatchErrors.push(JSON.stringify(lastTool.content));
          return fauxAssistantMessage("派单被拦截。");
        }
        const lastUser = request.messages.filter((m) => m.role === "user").at(-1)?.content;
        const input = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
        for (const [marker, call] of actions) {
          if (input.includes(marker) && !consumed.has(marker)) {
            consumed.add(marker);
            return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
          }
        }
      } else if (hasTool(request, "kulo_report")) {
        return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "Macmini 检查完成。" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("已完成。");
    }));

    const hub = await openTestHub({
      models,
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "local"),
        localEnvName: "Macmini.local",
        authToken: HUB_TEST_ADMIN_TOKEN,
        envTokens: {},
        enableLocalEnv: true,
        maxConcurrentWorkers: 3,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "cross-device-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
      },
    });
    cleanups.push(() => hub.close());

    vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
    vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockResolvedValue({ cleanupPending: false });

    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    const apiReq = (pathname: string, method: string, body: unknown, auth = true) =>
      fetch(`${server.url}${pathname}`, {
        method,
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
    expect((await apiReq("/api/devices", "PATCH", { enabled: true })).status).toBe(200);

    // Pair MacBook and leave its Env OFFLINE while its chat client stays connected
    const invite = await apiReq("/api/devices/invitations", "POST", { name: "Dev-Laptop.local", hubUrl: "https://hub.test" });
    const invitation = (await invite.json()) as DeviceInvitation;
    const token = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)![1]!;
    const macbookRoot = path.join(dir, invitation.deviceId);
    fs.mkdirSync(macbookRoot, { recursive: true });
    const paired = await apiReq(
      "/api/devices/pair",
      "POST",
      {
        inviteToken: token,
        rootDir: macbookRoot,
        info: { hostname: "Dev-Laptop.local", platform: "darwin", arch: "arm64", release: "test", cpu: "test", memoryBytes: 0, ips: [] },
      },
      false,
    );
    const macbook = (await paired.json()) as DevicePeerConfig;

    const chatWs = new WebSocket(server.clientWsUrl, { headers: { authorization: `Bearer ${macbook.clientToken}` } });
    cleanups.push(() => { if (chatWs.readyState !== WebSocket.CLOSED) chatWs.terminate(); });
    const msgs: HubToClientMessage[] = [];
    chatWs.on("message", (raw) => msgs.push(JSON.parse(String(raw)) as HubToClientMessage));
    await once(chatWs, "open");
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "hub.snapshot")).toBe(true), waitOptions);

    const sendFromMacBook = async (requestId: string, content: string) => {
      const start = msgs.length;
      chatWs.send(JSON.stringify({ type: "chat.send", topicId: "root", requestId, content }));
      await vi.waitFor(() => expect(msgs.slice(start).some((m) => m.type === "hub.ack" && m.requestId === requestId)).toBe(true), waitOptions);
    };
    const waitIdle = async () => {
      await vi.waitFor(async () => expect((await hub.getTopicView("root")).live.busy).toBe(false), waitOptions);
    };

    // Turn 1: exact user phrasing from screenshot + goal with ~/ paths -> executes immediately on Macmini.local ("local")!
    actions.set("[macmini-check]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-macmini-check",
        title: "检查 hindsight 安装状态",
        goal: "Inspect Macmini.local for hindsight in ~/Applications, ~/.hindsight, ~/Library, ~/.config",
        scope: "Read-only inspection on Macmini.local",
        role: "scout",
        env_id: "local",
      },
    });
    await sendFromMacBook("req-macmini-1", "[macmini-check] 检查一下macmini本机是否安装了hindsight，安装了的话就删了吧~");
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const t = Object.values(snap?.tickets ?? {}).find((x) => x.commandId === "cmd-macmini-check");
      expect(t?.status).toBe("ready");
      expect(t?.envId).toBe("local");
      expect(t?.envBinding).toBe("message_named");
    }, waitOptions);
    await waitIdle();

    // Turn 2: follow-up without repeating "macmini" carries over context to "local"!
    actions.set("[macmini-followup]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-macmini-followup",
        title: "清理残留目录",
        goal: "Inspect ~/.hindsight directory size on Macmini.local",
        scope: "Macmini.local ~/.hindsight",
        role: "scout",
        env_id: "local",
      },
    });
    await sendFromMacBook("req-macmini-2", "[macmini-followup] 顺便查一下 ~/.hindsight 占了多大空间");
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const t = Object.values(snap?.tickets ?? {}).find((x) => x.commandId === "cmd-macmini-followup");
      expect(t?.status).toBe("ready");
      expect(t?.envId).toBe("local");
      expect(t?.envBinding).toBe("message_named");
    }, waitOptions);
    await waitIdle();

    // Turn 3: explicit pivot back to sender ("这台电脑") rejects wrong env_id="local"
    actions.set("[sender-pivot]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-sender-pivot-wrong",
        title: "检查发信电脑日志",
        goal: "检查这台电脑上的日志",
        scope: "日志目录",
        role: "scout",
        env_id: "local",
      },
    });
    await sendFromMacBook("req-sender-3", "[sender-pivot] 好了，现在检查一下这台电脑上的日志");
    await waitIdle();
    const snapAfterPivot = await hub.harness.snapshot(KuloStateDoc, context);
    expect(Object.values(snapAfterPivot?.tickets ?? {}).find((x) => x.commandId === "cmd-sender-pivot-wrong")).toBeUndefined();
    expect(dispatchErrors.some((e) => e.includes("默认在"))).toBe(true);

    // Turn 4: guard against silent wrong-device parking when env_id is omitted but goal targets Macmini.local
    actions.set("[goal-mismatch]", {
      name: "kulo_dispatch",
      args: {
        command_id: "cmd-goal-mismatch",
        title: "检查服务端路径",
        goal: "Inspect Macmini.local ~/Library for leftovers",
        scope: "Read-only check on Macmini.local",
        role: "scout",
      },
    });
    await sendFromMacBook("req-mismatch-4", "[goal-mismatch] 查一下是否还有残留");
    await waitIdle();
    const snapAfterMismatch = await hub.harness.snapshot(KuloStateDoc, context);
    expect(Object.values(snapAfterMismatch?.tickets ?? {}).find((x) => x.commandId === "cmd-goal-mismatch")).toBeUndefined();
    expect(dispatchErrors.some((e) => e.includes("未传入目标 env_id"))).toBe(true);
  });

  it("never silently reroutes MacBook explicit env_id or sender_device dispatches to MacMini in multi-device turns or under locked topic targets", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-multi-device-macbook-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = fauxProvider({ provider: "openai", models: [{ id: "multi-device-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const actions = new Map<string, Array<{ name: string; args: Record<string, unknown> }>>();
    const consumed = new Set<string>();
    const dispatchErrors: string[] = [];

    provider.setResponses(Array.from({ length: 40 }, () => async (request: TranscriptContext) => {
      if (hasTool(request, "kulo_dispatch")) {
        const lastTool = request.messages.at(-1);
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_dispatch" && lastTool.isError) {
          dispatchErrors.push(JSON.stringify(lastTool.content));
          return fauxAssistantMessage("派单冲突已拦截。");
        }
        const lastUser = request.messages.filter((m) => m.role === "user").at(-1)?.content;
        const input = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
        for (const [marker, calls] of actions) {
          if (input.includes(marker) && !consumed.has(marker)) {
            consumed.add(marker);
            return fauxAssistantMessage(calls.map((call) => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" });
          }
        }
      } else if (hasTool(request, "kulo_report")) {
        return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "ok" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("已完成。");
    }));

    const hub = await openTestHub({
      models,
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "local"),
        localEnvName: "Macmini.local",
        authToken: HUB_TEST_ADMIN_TOKEN,
        envTokens: {},
        enableLocalEnv: true,
        maxConcurrentWorkers: 4,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "multi-device-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
      },
    });
    cleanups.push(() => hub.close());

    vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockImplementation((_id, cwd) => new NodeExecutionEnv({ cwd }));
    vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockResolvedValue({ cleanupPending: false });

    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    const apiReq = (pathname: string, method: string, body: unknown, auth = true) =>
      fetch(`${server.url}${pathname}`, {
        method,
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
    expect((await apiReq("/api/devices", "PATCH", { enabled: true })).status).toBe(200);

    // Pair MacBook with the real typo hostname and NO hardware model (worst-case legacy peer)
    const invite = await apiReq("/api/devices/invitations", "POST", { name: "Dev-Laptop.local", hubUrl: "https://hub.test" });
    const invitation = (await invite.json()) as DeviceInvitation;
    const token = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)![1]!;
    const macbookRoot = path.join(dir, invitation.deviceId);
    fs.mkdirSync(macbookRoot, { recursive: true });
    const paired = await apiReq(
      "/api/devices/pair",
      "POST",
      {
        inviteToken: token,
        rootDir: macbookRoot,
        info: { hostname: "Dev-Laptop.local", platform: process.platform, arch: process.arch, release: "test", cpu: "test", memoryBytes: 0, ips: [] },
      },
      false,
    );
    const macbook = (await paired.json()) as DevicePeerConfig;

    const envWs = new WebSocket(server.envWsUrl);
    cleanups.push(() => { if (envWs.readyState !== WebSocket.CLOSED) envWs.terminate(); });
    await once(envWs, "open");
    const reg = once(envWs, "message");
    envWs.send(JSON.stringify({
      type: "env.register",
      envId: macbook.deviceId,
      token: macbook.envToken,
      name: macbook.name,
      platform: process.platform,
      arch: process.arch,
      rootDir: macbook.rootDir,
      capabilities: ["fs", "worker-isolation"],
    }));
    await reg;

    const chatWs = new WebSocket(server.clientWsUrl, { headers: { authorization: `Bearer ${macbook.clientToken}` } });
    cleanups.push(() => { if (chatWs.readyState !== WebSocket.CLOSED) chatWs.terminate(); });
    const msgs: HubToClientMessage[] = [];
    chatWs.on("message", (raw) => msgs.push(JSON.parse(String(raw)) as HubToClientMessage));
    await once(chatWs, "open");
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "hub.snapshot")).toBe(true), waitOptions);

    const sendFromMacBook = async (requestId: string, content: string, extra: Record<string, unknown> = {}) => {
      const start = msgs.length;
      chatWs.send(JSON.stringify({ type: "chat.send", topicId: "root", requestId, content, ...extra }));
      await vi.waitFor(() => expect(msgs.slice(start).some((m) => m.type === "hub.ack" && m.requestId === requestId)).toBe(true), waitOptions);
    };
    const waitIdle = async () => {
      await vi.waitFor(async () => expect((await hub.getTopicView("root")).live.busy).toBe(false), waitOptions);
    };

    // Turn 1: User asks for BOTH MacMini and Macbook (without local-colloquial keywords).
    // Even without hardware model metadata, explicit env_id=macbook AND target_scope='sender_device' both land on MacBook!
    actions.set("[both-devices]", [
      {
        name: "kulo_dispatch",
        args: {
          command_id: "cmd-macmini-both",
          title: "测试 MacMini 浏览器",
          goal: "Run browser check on MacMini",
          scope: "browser automation",
          role: "scout",
          env_id: "local",
        },
      },
      {
        name: "kulo_dispatch",
        args: {
          command_id: "cmd-macbook-explicit-id",
          title: "测试 Macbook 浏览器",
          goal: "Run browser check on Macbook",
          scope: "browser automation",
          role: "scout",
          env_id: macbook.deviceId,
        },
      },
      {
        name: "kulo_dispatch",
        args: {
          command_id: "cmd-macbook-sender-scope",
          title: "复测 Macbook 浏览器",
          goal: "Run browser check on sender Macbook",
          scope: "browser automation",
          role: "scout",
          target_scope: "sender_device",
        },
      },
    ]);
    await sendFromMacBook("req-both-1", "[both-devices] 在 MacMini 和 Macbook 上测试 browser use 和 computer use");
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, context);
      const tickets = Object.values(snap?.tickets ?? {});
      expect(tickets.find((t) => t.commandId === "cmd-macmini-both")).toMatchObject({ status: "ready", envId: "local" });
      expect(tickets.find((t) => t.commandId === "cmd-macbook-explicit-id")).toMatchObject({ status: "ready", envId: macbook.deviceId, envBinding: "sender_local" });
      expect(tickets.find((t) => t.commandId === "cmd-macbook-sender-scope")).toMatchObject({ status: "ready", envId: macbook.deviceId, envBinding: "sender_local" });
    }, waitOptions);
    await waitIdle();

    // Turn 2: When topic is locked to MacMini ('local'), explicit env_id=macbook fails loudly instead of silently landing on MacMini
    actions.set("[locked-conflict]", [
      {
        name: "kulo_dispatch",
        args: {
          command_id: "cmd-locked-mismatch",
          title: "越权派发测试",
          goal: "Run browser check on Macbook",
          scope: "browser automation",
          role: "scout",
          env_id: macbook.deviceId,
        },
      },
    ]);
    await sendFromMacBook("req-locked-2", "[locked-conflict] 跑一下浏览器检查", { targetDeviceId: "local" });
    await waitIdle();
    const snapLocked = await hub.harness.snapshot(KuloStateDoc, context);
    expect(Object.values(snapLocked?.tickets ?? {}).find((t) => t.commandId === "cmd-locked-mismatch")).toBeUndefined();
    expect(dispatchErrors.some((e) => e.includes("当前会话已锁定执行设备"))).toBe(true);
  });
});
