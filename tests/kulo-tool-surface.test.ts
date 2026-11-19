import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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
import { defineExtension, defineTool, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { ANDROID_TOOL_CATALOG, type AndroidEnvStatus, type EnvNodeDescriptor } from "@kulo/protocol";
import {
  ANDROID_HIGH_RISK_PERMISSIONS,
  TOOL_SURFACE_BY_NAME,
  TOOL_SURFACE_ENTRIES,
  assertUniqueExtensionTools,
  resolveSurfaceTools,
  type ToolSurfaceRuntimeState,
} from "../packages/hub/src/tool-surface.js";
import { createWebFetchTool } from "../packages/hub/src/tools-worker.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-doc.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function baseSurfaceState(
  audience: ToolSurfaceRuntimeState["audience"],
  overrides: Partial<ToolSurfaceRuntimeState> = {},
): ToolSurfaceRuntimeState {
  return {
    audience,
    memoryEnabled: false,
    sharedMemoryEnabled: false,
    ttsEnabled: false,
    webSearchAvailable: true,
    customizationEnabled: false,
    deviceInviteAvailable: false,
    ...overrides,
  };
}

describe("Kulo declarative tool surface & Step 1–2 invariants", () => {
  it("maintains unique registry entries, covers all 68 Android tools, and catches extension name collisions", () => {
    const names = TOOL_SURFACE_ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const android of ANDROID_TOOL_CATALOG) {
      expect(TOOL_SURFACE_BY_NAME.has(android.name)).toBe(true);
    }

    const extA = defineExtension({
      name: "ext-a",
      tools: [defineTool({ name: "dup_tool", description: "a", parameters: obj({}), execute: async () => ({ output: [] }) })],
    });
    const extB = defineExtension({
      name: "ext-b",
      tools: [defineTool({ name: "dup_tool", description: "b", parameters: obj({}), execute: async () => ({ output: [] }) })],
    });
    expect(() => assertUniqueExtensionTools([extA, extB])).toThrow(/Duplicate tool registration 'dup_tool'/);
  });

  it("never leaks window-scoped tools outside settings and enforces read-only & high-risk Android gates", () => {
    const mockTools = TOOL_SURFACE_ENTRIES.map((entry) =>
      defineTool({ name: entry.name, description: entry.name, parameters: obj({}), execute: async () => ({ output: [] }) }),
    );
    const windowToolNames = TOOL_SURFACE_ENTRIES.filter((entry) => entry.scope === "window").map((entry) => entry.name);
    expect(windowToolNames.length).toBeGreaterThan(15);

    for (const audience of ["chat", "computer-worker", "computer-subagent", "android-worker", "android-subagent"] as const) {
      const resolved = resolveSurfaceTools(
        mockTools,
        baseSurfaceState(audience, {
          memoryEnabled: true,
          sharedMemoryEnabled: true,
          ttsEnabled: true,
          customizationEnabled: true,
          deviceInviteAvailable: true,
          allowSubagents: true,
        }),
      ).map((tool) => tool.name);

      for (const winTool of windowToolNames) {
        expect(resolved).not.toContain(winTool);
      }
    }

    // Settings never exposes kulo_device_invite
    const settingsTools = resolveSurfaceTools(
      mockTools,
      baseSurfaceState("settings", { deviceInviteAvailable: true, settingsModule: "machines" }),
    ).map((tool) => tool.name);
    expect(settingsTools).not.toContain("kulo_device_invite");
    expect(settingsTools).toContain("kulo_devices_manage");

    // Read-only computer worker hides kulo_media_export and kulo_synthesize_speech
    const readOnlyWorker = resolveSurfaceTools(
      mockTools,
      baseSurfaceState("computer-worker", { readOnly: true, ttsEnabled: true }),
    ).map((tool) => tool.name);
    expect(readOnlyWorker).not.toContain("kulo_media_export");
    expect(readOnlyWorker).not.toContain("kulo_synthesize_speech");
    expect(readOnlyWorker).not.toContain("kulo_ui_show");
    expect(readOnlyWorker).not.toContain("kulo_inspect_asset");

    // Computer subagent hides parent-only lifecycle tools
    const subagentTools = resolveSurfaceTools(
      mockTools,
      baseSurfaceState("computer-subagent", { readOnly: false, allowSubagents: true }),
    ).map((tool) => tool.name);
    expect(subagentTools).not.toContain("kulo_report");
    expect(subagentTools).not.toContain("kulo_wait");
    expect(subagentTools).not.toContain("kulo_subagent");
    expect(subagentTools).toContain("kulo_media_export");

    // High-risk Android tools require explicit phone grants; readOnly hides mutating Android tools
    const ungrantedStatus: AndroidEnvStatus = {
      version: 1,
      catalogVersion: 2,
      enabled: true,
      paused: false,
      revision: 1,
      grants: ["device", "observe", "control", "apps"],
      capabilities: ANDROID_TOOL_CATALOG.map((item) => ({ action: item.action, available: true })),
    };
    const phoneUngranted: EnvNodeDescriptor = {
      id: "phone-1",
      name: "Phone 1",
      kind: "reverse-ws",
      online: true,
      platform: "android",
      arch: "arm64",
      rootDir: "",
      executionKind: "native-device",
      android: ungrantedStatus,
      capabilities: ["android-device", "android-native-v1"],
      connectedAt: 1,
      lastSeenAt: 1,
    };

    const androidUngranted = resolveSurfaceTools(
      mockTools,
      baseSurfaceState("android-worker", { androidTargets: [phoneUngranted] }),
    ).map((tool) => tool.name);
    for (const highRisk of Object.keys(ANDROID_HIGH_RISK_PERMISSIONS)) {
      expect(androidUngranted).not.toContain(highRisk);
    }

    const phoneGranted: EnvNodeDescriptor = {
      ...phoneUngranted,
      android: {
        ...ungrantedStatus,
        grants: [...ungrantedStatus.grants, "memoryRead", "memoryWrite", "nfcEmulation"],
      },
    };
    const androidGranted = resolveSurfaceTools(
      mockTools,
      baseSurfaceState("android-worker", { androidTargets: [phoneGranted] }),
    ).map((tool) => tool.name);
    for (const highRisk of Object.keys(ANDROID_HIGH_RISK_PERMISSIONS)) {
      expect(androidGranted).toContain(highRisk);
    }
  });

  it("enforces running ticket scope on Worker web_fetch without /usr/bin/curl and rejects private IPs", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Test Doc</title></head><body><main>Hello unified fetch</main></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const fetchPage = vi.fn(async (url: string) => ({
      url,
      title: "Public Spec",
      content: "Verified public spec body",
      truncated: false,
      sources: [{ id: "s1", title: "Public Spec", url }],
    }));
    const tool = createWebFetchTool(() => ({ fetch: fetchPage }) as never);

    // 1. Orphan / stopped Worker conversation must be rejected (fixes truthy object routing bug!)
    const stoppedState = {
      tickets: {
        "T-0001": {
          id: "T-0001",
          status: "stopped",
          workerConversationId: 42,
          runEpoch: 1,
        },
      },
      conversationToTicket: { "42": "T-0001" },
      conversationToTopic: {},
      topics: {},
    };
    const stoppedApi = {
      conversationId: 42,
      snapshot: async (doc: { kind: string }) =>
        doc.kind === KuloStateDoc.kind ? stoppedState : doc.kind === SettingsAssistantDoc.kind ? { conversationId: null } : undefined,
    } as unknown as ToolExecutionApi;

    const denied = await tool.execute({ url: "https://93.184.216.34/spec" }, stoppedApi, BACKGROUND_CONTEXT);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.output)).toMatch(/active running Worker/i);
    expect(fetchPage).not.toHaveBeenCalled();

    // 2. Running Worker succeeds via Hub's cross-platform SSRF-guarded fetch without api.env (/usr/bin/curl)
    const runningState = {
      ...stoppedState,
      tickets: {
        "T-0001": {
          ...stoppedState.tickets["T-0001"],
          status: "running",
        },
      },
    };
    const runningApi = {
      conversationId: 42,
      env: undefined,
      snapshot: async (doc: { kind: string }) =>
        doc.kind === KuloStateDoc.kind ? runningState : doc.kind === SettingsAssistantDoc.kind ? { conversationId: null } : undefined,
    } as unknown as ToolExecutionApi;

    const ok = await tool.execute({ url: "https://93.184.216.34/spec" }, runningApi, BACKGROUND_CONTEXT);
    expect(ok.isError).toBeUndefined();
    expect(JSON.stringify(ok.output)).toContain("Verified public spec body");
    expect(fetchPage).toHaveBeenCalledOnce();

    // 3. Private / loopback URL is rejected before fetchPage
    const privateRejected = await tool.execute({ url: "http://127.0.0.1:8080/internal" }, runningApi, BACKGROUND_CONTEXT);
    expect(privateRejected.isError).toBe(true);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("synchronizes live settings across Main Chat, active Settings Assistant, and waiting Workers/Subagents, and supports global settings in Main Chat", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-tool-surface-hub-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const seenMainTools: string[][] = [];
    const seenSettingsTools: string[][] = [];
    const seenWorkerTools: string[][] = [];
    const provider = fauxProvider({ provider: "surface-test", models: [{ id: "surface-model" }] });
    const models = createModels();
    models.setProvider(routeSettingsTitleRequests(provider));

    let mainPhase = 0;
    let workerRuns = 0;
    provider.setResponses(
      Array.from({ length: 40 }, () => (ctx: TranscriptContext) => {
        const offered = [...new Set([
          ...(ctx.tools?.map((t) => t.name) ?? []),
          ...ctx.messages.flatMap((m) => (m.role === "system" && Array.isArray(m.toolsAdded) ? m.toolsAdded.map((t) => t.name) : [])),
        ])];
        if (offered.includes("kulo_report")) {
          seenWorkerTools.push(offered);
          workerRuns++;
          if (workerRuns === 1) {
            return fauxAssistantMessage(
              [fauxToolCall("kulo_wait", { reason: "user", detail: "等待记忆开关切换后继续" })],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_report", { state: "ready", summary: "已获取最新工具集并完成" })],
            { stopReason: "toolUse" },
          );
        }
        if (offered.includes("kulo_connection_prepare")) {
          seenSettingsTools.push(offered);
          const hasSkillResult = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_skill_read");
          if (!hasSkillResult) {
            return fauxAssistantMessage([fauxToolCall("kulo_skill_read", { id: "genui-cards" })], { stopReason: "toolUse" });
          }
          return fauxAssistantMessage([fauxText("已读取卡片规范。")]);
        }

        seenMainTools.push(offered);
        mainPhase++;
        if (mainPhase === 1) {
          return fauxAssistantMessage([fauxToolCall("tool_search", { query: "读取设置 修改设置", limit: 3 })], { stopReason: "toolUse" });
        }
        if (mainPhase === 2) {
          return fauxAssistantMessage([fauxToolCall("kulo_settings_read", { section: "workers" })], { stopReason: "toolUse" });
        }
        if (mainPhase === 3) {
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_settings_update", {
                block: "executor",
                changes: JSON.stringify({ maxSubagentsPerTicket: 5 }),
                title: "调高子智能体上限",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("主聊天已直接完成全局设置更新。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "surface-test",
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: {
          enabled: false,
          endpoint: "http://127.0.0.1:19999",
          accessMode: "kulo",
          routerApiKey: "r".repeat(36),
          workerApiKey: "w".repeat(36),
        },
        model: { defaultProvider: "surface-test", defaultModel: "surface-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());

    // 1. Main Chat reads and updates global settings directly without a Settings window
    const mainSub = await hub.sendUserMessage("把每个工单的子智能体上限改成 5");
    await mainSub.wait(BACKGROUND_CONTEXT);
    expect(hub.getSettingsView().blocks.executor.value.maxSubagentsPerTicket).toBe(5);
    expect(seenMainTools[0]).not.toContain("hindsight_recall");
    expect(seenMainTools[0]).not.toContain("kulo_settings_read");
    expect(seenMainTools[0]).not.toContain("kulo_settings_update");

    // 2. Settings Assistant hides kulo_device_invite and can read genui-cards Skill via kulo_skill_read
    const settingsCtx = {
      module: "connections" as const,
      hasUnsavedChanges: false,
      appearance: "light" as const,
      clientId: "test-window",
    };
    hub.settingsAssistant.updateContext(settingsCtx);
    await hub.settingsAssistant.send("查看卡片技能说明", settingsCtx, "settings-skill-check");
    await vi.waitFor(async () => {
      const snap = await hub.settingsAssistant.getSnapshot();
      expect(snap.live.busy).toBe(false);
      expect(snap.messages.some((m) => m.role === "assistant" && m.text.includes("已读取卡片规范"))).toBe(true);
    });
    expect(seenSettingsTools[0]).not.toContain("kulo_device_invite");

    // 3. Dispatch a Worker that suspends via kulo_wait; memory tools are initially absent
    const dispatched = await hub.dispatchTicket({
      commandId: "live-sync-worker",
      title: "检查热同步",
      goal: "挂起等待配置变更后恢复",
      scope: "仅检查工具可见性",
      role: "coder",
    });
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[dispatched.id]?.status).toBe("waiting");
    });
    expect(seenWorkerTools[0]).not.toContain("hindsight_recall");

    // 4. Enable memory in live settings -> Main Chat, active Settings conversation, AND waiting Worker immediately sync!
    const view = hub.getSettingsView();
    await hub.updateSettingsBlock("memory", view.blocks.memory.revision, {
      ...view.blocks.memory.value,
      enabled: true,
    });

    const stateAfter = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const workerConvId = stateAfter!.tickets[dispatched.id]!.workerConversationId as ConversationId;
    const workerConv = (await hub.harness.conversation(workerConvId, BACKGROUND_CONTEXT))!;
    const workerAgentAfter = await workerConv.agent(BACKGROUND_CONTEXT);
    expect(workerAgentAfter.tools.map((t) => t.name).concat(workerAgentAfter.deferred.map((t) => t.name))).toContain("hindsight_recall");

    const settingsDoc = await hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    const settingsConv = (await hub.harness.conversation(settingsDoc!.conversationId as ConversationId, BACKGROUND_CONTEXT))!;
    const settingsAgentAfter = await settingsConv.agent(BACKGROUND_CONTEXT);
    expect(settingsAgentAfter.tools.map((t) => t.name).concat(settingsAgentAfter.deferred.map((t) => t.name))).toContain("hindsight_recall");

    // Resume waiting worker and verify it completes with synced tools
    await hub.steerTicket({
      commandId: "resume-live-sync-worker",
      ticketId: dispatched.id,
      text: "记忆已开启，请完成汇报。",
    });
    await vi.waitFor(async () => {
      const cur = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(cur?.tickets[dispatched.id]?.status).toBe("ready");
    });
  });
});
