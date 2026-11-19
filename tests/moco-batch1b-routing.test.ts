import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { DeviceInvitation, DevicePeerConfig, EnvNodeDescriptor, HubToClientMessage, TicketRecord } from "@moco/protocol";
import {
  MocoStateDoc,
  canSwitchEnvDuringRecovery,
  detectSenderLocalSignals,
  hasWorkerIsolation,
  resolveComputerEnvBinding,
  startMocoHubServer,
} from "@moco/hub";
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
    name: "Moco Hub",
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
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-batch1b-e2e-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = fauxProvider({ provider: "openai", models: [{ id: "routing-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const actions = new Map<string, { name: string; args: Record<string, unknown> }>();
    const consumed = new Set<string>();

    provider.setResponses(Array.from({ length: 40 }, () => async (request: TranscriptContext) => {
      if (hasTool(request, "moco_dispatch")) {
        const lastUser = request.messages.filter((m) => m.role === "user").at(-1)?.content;
        const input = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
        for (const [marker, call] of actions) {
          if (input.includes(marker) && !consumed.has(marker)) {
            consumed.add(marker);
            return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
          }
        }
      } else if (hasTool(request, "moco_report")) {
        return fauxAssistantMessage([fauxToolCall("moco_report", { state: "ready", summary: "ok" })], { stopReason: "toolUse" });
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

    const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
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
      name: "moco_dispatch",
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
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
      const t = Object.values(snap?.tickets ?? {}).find((x) => x.commandId === "cmd-hub-local-1");
      expect(t?.status).toBe("ready");
      expect(t?.envId).toBe("local");
      expect(t?.envBinding).toBe("hub_local");
      expect(t?.senderSource).toEqual({ deviceId: laptop.deviceId, name: laptop.name });
    }, waitOptions);

    // 2) Laptop mentions "桌面" even if model mistakenly sets target_scope="hub_local" -> forced to laptop ("sender_local")!
    actions.set("[desktop-override]", {
      name: "moco_dispatch",
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
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
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
      android: { version: 1, catalogVersion: 1, enabled: true, paused: false, revision: 1, grants: ["device"], capabilities: [] },
    };
    const origGet = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    const origList = hub.envManager.listEnvs.bind(hub.envManager);
    vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => (id === phone.id ? phone : origGet(id)));
    vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => [...origList(), phone]);

    actions.set("[phone-attachment]", {
      name: "moco_dispatch",
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
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
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
});
