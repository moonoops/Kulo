import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ComputerUseRequest, ComputerUseResult, EnvNodeDescriptor } from "@kulo/protocol";
import { KuloStateDoc } from "@kulo/hub";
import {
  BROWSER_SESSION_TRANSFERRED_ERROR,
  TransferredBrowserSessionTombstones,
  evaluateBrowserSessionTransferEligibility,
} from "../packages/hub/src/computer-session-transfer.js";
import { canSwitchEnvDuringRecovery, resolveComputerEnvBinding } from "../packages/hub/src/env-routing-policy.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

function toolNames(context: TranscriptContext): string[] {
  return [
    ...new Set([
      ...(context.tools?.map((tool) => tool.name) ?? []),
      ...context.messages.flatMap((message) =>
        message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
          ? message.toolsAdded.map((tool) => tool.name)
          : [],
      ),
    ]),
  ];
}

function parseToolResultJson(message: { content?: unknown } | undefined): Record<string, unknown> {
  if (!message || !Array.isArray(message.content)) return {};
  const textPart = message.content.find(
    (part): part is { type: "text"; text: string } =>
      Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text",
  );
  return textPart ? (JSON.parse(textPart.text) as Record<string, unknown>) : {};
}

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    path.basename(String(file)) === ".env" ? false : exists(file),
  );
  for (const key of [
    "KULO_MODEL",
    "KULO_DEFAULT_PROVIDER",
    "KULO_API_KEY",
    "OPENAI_API_KEY",
    "KULO_HINDSIGHT_API_KEY",
    "KULO_ENV_TOKENS",
    "KULO_BROWSER_AUTO_CONNECT",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("KULO_COMPUTER_USE", "browser");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createBrowserHandoffHub(options: {
  root?: string;
  orchestratorBrowserIdleMs?: number;
  handler: (context: TranscriptContext) => ReturnType<typeof answer>;
  profileMode?: "persistent" | "ephemeral" | "auto_connect";
  onNativeRequest?: (envId: string, request: ComputerUseRequest, signal?: AbortSignal) => Promise<void> | void;
}) {
  const root = options.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-browser-handoff-")));
  if (!options.root) cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "handoff-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses(Array.from({ length: 60 }, () => options.handler));

  const hub = await openTestHub({
    models,
    orchestratorBrowserIdleMs: options.orchestratorBrowserIdleMs ?? 5_000,
    config: {
      authToken: HUB_TEST_ADMIN_TOKEN,
      stateDir: path.join(root, "state"),
      identityDir: path.join(root, "identity"),
      localEnvRoot: path.join(root, "runtime"),
      enableLocalEnv: true,
      memory: { enabled: false },
      watchdogMinutes: 0,
      model: { defaultProvider: "openai", defaultModel: "handoff-model", thinkingLevel: "off", apiKey: "" },
    },
  });
  cleanups.push(() => hub.close());

  const openSessions = new Set<string>();
  const native = vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (envId, request, signal) => {
    await options.onNativeRequest?.(envId, request, signal);
    const base = {
      tool: request.tool,
      action: request.action,
      ...("sessionId" in request ? { sessionId: request.sessionId } : {}),
      platform: process.platform,
    };
    if (request.action === "open") {
      openSessions.add(request.sessionId);
      return {
        ...base,
        ok: true,
        data: {
          url: request.url,
          title: "Admin Console",
          profileMode: options.profileMode ?? "persistent",
          snapshot: '- button "Export" [ref=e1]',
        },
      } as ComputerUseResult;
    }
    if (request.action === "close") {
      openSessions.delete(request.sessionId);
      return { ...base, ok: true, data: { closed: true } } as ComputerUseResult;
    }
    if (request.action === "get-url") {
      return { ...base, ok: true, data: { url: "https://admin.example.com/dashboard" } } as ComputerUseResult;
    }
    return { ...base, ok: true, data: { snapshot: '- button "Export" [ref=e1]' } } as ComputerUseResult;
  });

  return { root, hub, native, openSessions };
}

describe("Orchestrator -> Worker browser session ownership handoff", () => {
  it("transfers session ownership atomically, bumps browserSessionEpoch to prevent collision, protects from idleTimer, and binds preview to Worker", async () => {
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    cleanups.push(releaseWorker);

    let workerSawPrompt = "";
    const f = await createBrowserHandoffHub({
      orchestratorBrowserIdleMs: 120,
      onNativeRequest: async (_envId, request) => {
        if (request.action === "get-url") {
          await workerGate;
        }
      },
      handler: (context) => {
        const tools = toolNames(context);
        const isWorker = tools.includes("kulo_report");
        if (isWorker) {
          const userMsg = context.messages.find((m) => m.role === "user");
          if (userMsg && typeof userMsg.content === "string") workerSawPrompt = userMsg.content;
          else if (userMsg && Array.isArray(userMsg.content)) {
            workerSawPrompt = userMsg.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          if (!tools.includes("kulo_browser")) {
            return call("tool_search", { query: "kulo_browser", limit: 2 });
          }
          const browserCalls = context.messages.filter((m) => m.role === "toolResult" && m.toolName === "kulo_browser").length;
          if (browserCalls === 0) return call("kulo_browser", { action: "get-url" });
          return call("kulo_report", { state: "ready", summary: "已复用主对话浏览器登录态完成数据导出。" });
        }

        const lastUserIdx = context.messages.findLastIndex((m) => m.role === "user");
        const turnResults = context.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
        const lastUser = context.messages[lastUserIdx];
        const userText = JSON.stringify(lastUser?.content ?? "");
        if (!tools.includes("kulo_browser")) {
          return call("tool_search", { query: "kulo_browser", limit: 2 });
        }
        if (userText.includes("新开另一个网页")) {
          if (turnResults.filter((m) => m.toolName === "kulo_browser").length === 0) {
            return call("kulo_browser", { action: "open", url: "https://docs.example.com" });
          }
          return answer("已在主对话新开独立浏览器会话。");
        }
        if (turnResults.filter((m) => m.toolName === "kulo_browser").length === 0) {
          return call("kulo_browser", { action: "open", url: "https://admin.example.com/dashboard" });
        }
        if (turnResults.filter((m) => m.toolName === "kulo_dispatch").length === 0) {
          return call("kulo_dispatch", {
            command_id: "cmd-inherit-ok",
            title: "后台导出报表",
            goal: "在已登录的后台页面中导出本月报表",
            scope: "后台浏览器",
            role: "coder",
            inherit_browser_session: true,
          });
        }
        return answer("已将当前浏览器会话移交后台任务执行。");
      },
    });

    const sub1 = await f.hub.sendUserMessage("打开后台并交给后台任务导出");
    expect((await sub1.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    // Wait until Worker enters `get-url` (proving Worker is actively executing with the transferred session).
    await vi.waitFor(
      () => expect(f.native.mock.calls.some(([, req]) => req.action === "get-url")).toBe(true),
      { timeout: 10_000, interval: 20 },
    );

    const openCall = f.native.mock.calls.find(([, req]) => req.action === "open")!;
    const getUrlCall = f.native.mock.calls.find(([, req]) => req.action === "get-url")!;
    const S1 = (openCall[1] as Extract<ComputerUseRequest, { action: "open" }>).sessionId;
    const workerSessionId = (getUrlCall[1] as Extract<ComputerUseRequest, { action: "get-url" }>).sessionId;
    expect(workerSessionId).toBe(S1);

    // Inspect kulo_dispatch tool result payload
    const orchMessages = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages;
    const dispatchResult = parseToolResultJson(
      orchMessages.find((m) => m.role === "toolResult" && m.toolName === "kulo_dispatch"),
    );
    expect(dispatchResult.browser_session_inherited).toBe(true);
    expect(dispatchResult.browser_session_inherit_reason).toBeUndefined();
    const ticketId = (dispatchResult.ticket as { id: string }).id;

    // Inspect durable state: inheritedBrowserSession, deviceStateTouched, and bumped browserSessionEpoch
    const stateWhileRunning = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticketWhileRunning = stateWhileRunning!.tickets[ticketId]!;
    expect(ticketWhileRunning.inheritedBrowserSession).toEqual({ envId: "local", sessionId: S1 });
    expect(ticketWhileRunning.deviceStateTouched).toBe(true);
    expect(canSwitchEnvDuringRecovery(ticketWhileRunning)).toBe(false);
    expect(stateWhileRunning!.topics?.root?.browserSessionEpoch).toBe(2);

    // Worker initial prompt carries explicit inherited browser note
    expect(workerSawPrompt).toContain("<inherited_browser_session>");
    expect(workerSawPrompt).toContain("get-url");

    // Preview is bound to the Worker card, NOT the old Orchestrator chat session
    const previews = await f.hub.listComputerPreviews("root");
    expect(previews.some((p) => p.ticketId === ticketId && p.tool === "browser")).toBe(true);
    expect(previews.some((p) => p.ticketId.startsWith("chat:root:browser:"))).toBe(false);

    // Wait longer than orchestratorBrowserIdleMs (120ms) — old idleTimer MUST NOT close Worker's S1!
    await new Promise((r) => setTimeout(r, 220));
    expect(f.openSessions.has(S1)).toBe(true);
    expect(f.native.mock.calls.some(([, req]) => req.action === "close" && "sessionId" in req && req.sessionId === S1)).toBe(false);

    // Now Orchestrator opens a NEW browser page while Worker is STILL running -> MUST get S2 !== S1!
    const sub2 = await f.hub.sendUserMessage("新开另一个网页看看文档");
    expect((await sub2.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const openCalls = f.native.mock.calls.filter(([, req]) => req.action === "open");
    expect(openCalls).toHaveLength(2);
    const S2 = (openCalls[1]![1] as Extract<ComputerUseRequest, { action: "open" }>).sessionId;
    expect(S2).not.toBe(S1);

    // Wait for S2's orchestrator idleTimer to close S2 — verify S1 stays open for Worker!
    await vi.waitFor(() => expect(f.openSessions.has(S2)).toBe(false), { timeout: 2_000, interval: 25 });
    expect(f.openSessions.has(S1)).toBe(true);

    // Release Worker -> Worker reports ready -> ticket cleanup closes S1 cleanly
    releaseWorker();
    await vi.waitFor(async () => {
      const snap = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[ticketId]?.status).toBe("ready");
      expect(snap?.tickets[ticketId]?.cleanupPending).not.toBe(true);
    }, { timeout: 10_000, interval: 25 });
    expect(f.openSessions.size).toBe(0);
    expect(
      f.native.mock.calls.some(([, req]) => req.action === "close" && "sessionId" in req && req.sessionId === S1),
    ).toBe(true);
    const finalState = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(finalState?.tickets[ticketId]?.inheritedBrowserSession).toBeUndefined();
  });

  it("degrades cleanly when sandboxed, auto_connect, worker_queued, scheduled, active_handoff, env_mismatch, read_only, or concurrent same-turn kulo_browser", async () => {
    // 1. Sandboxed mode -> not_trusted_mode
    {
      const f = await createBrowserHandoffHub({
        handler: (context) => {
          const tools = toolNames(context);
          if (tools.includes("kulo_report")) return call("kulo_report", { state: "ready", summary: "done" });
          if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
          const results = context.messages.filter((m) => m.role === "toolResult");
          if (!results.some((m) => m.toolName === "kulo_browser")) {
            return call("kulo_browser", { action: "open", url: "https://example.com" });
          }
          if (!results.some((m) => m.toolName === "kulo_dispatch")) {
            return call("kulo_dispatch", {
              command_id: "cmd-sandboxed",
              title: "沙箱任务",
              goal: "测试降级",
              scope: "测试",
              role: "coder",
              inherit_browser_session: true,
            });
          }
          return answer("ok");
        },
      });
      const init = f.hub.getSettingsView();
      await f.hub.updateSettingsBlock(
        "executor",
        init.blocks.executor.revision,
        { ...init.blocks.executor.value, executionTrustMode: "sandboxed" },
        BACKGROUND_CONTEXT,
      );
      const sub = await f.hub.sendUserMessage("打开页面并派单");
      expect((await sub.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const msgs = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages;
      const res = parseToolResultJson(msgs.find((m) => m.role === "toolResult" && m.toolName === "kulo_dispatch"));
      expect(res.browser_session_inherited).toBe(false);
      expect(res.browser_session_inherit_reason).toBe("not_trusted_mode");
    }

    // 2. auto_connect profile -> auto_connect_session
    {
      const f = await createBrowserHandoffHub({
        profileMode: "auto_connect",
        handler: (context) => {
          const tools = toolNames(context);
          if (tools.includes("kulo_report")) return call("kulo_report", { state: "ready", summary: "done" });
          if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
          const results = context.messages.filter((m) => m.role === "toolResult");
          if (!results.some((m) => m.toolName === "kulo_browser")) {
            return call("kulo_browser", { action: "open", url: "https://example.com" });
          }
          if (!results.some((m) => m.toolName === "kulo_dispatch")) {
            return call("kulo_dispatch", {
              command_id: "cmd-autoconnect",
              title: "自动连接会话任务",
              goal: "测试 auto_connect 拒绝过户",
              scope: "测试",
              role: "coder",
              inherit_browser_session: true,
            });
          }
          return answer("ok");
        },
      });
      const sub = await f.hub.sendUserMessage("打开浏览器并派单");
      expect((await sub.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const msgs = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages;
      const res = parseToolResultJson(msgs.find((m) => m.role === "toolResult" && m.toolName === "kulo_dispatch"));
      expect(res.browser_session_inherited).toBe(false);
      expect(res.browser_session_inherit_reason).toBe("auto_connect_session");
    }

    // 3. Worker queued behind maxConcurrentWorkers=1 -> worker_queued
    {
      let releaseBlocker!: () => void;
      const blockerGate = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      cleanups.push(releaseBlocker);
      const f = await createBrowserHandoffHub({
        onNativeRequest: async (_envId, req) => {
          if (req.action === "status") await blockerGate;
        },
        handler: (context) => {
          const tools = toolNames(context);
          if (tools.includes("kulo_report")) {
            if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
            if (!context.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_browser")) {
              return call("kulo_browser", { action: "status" });
            }
            return call("kulo_report", { state: "ready", summary: "done" });
          }
          if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
          const results = context.messages.filter((m) => m.role === "toolResult");
          if (!results.some((m) => m.toolName === "kulo_browser")) {
            return call("kulo_browser", { action: "open", url: "https://example.com" });
          }
          if (!results.some((m) => m.toolName === "kulo_dispatch")) {
            return call("kulo_dispatch", {
              command_id: "cmd-queued",
              title: "排队任务",
              goal: "测试并发槽位已满时降级",
              scope: "测试",
              role: "coder",
              inherit_browser_session: true,
            });
          }
          return answer("ok");
        },
      });
      const init = f.hub.getSettingsView();
      await f.hub.updateSettingsBlock(
        "executor",
        init.blocks.executor.revision,
        { ...init.blocks.executor.value, maxConcurrentWorkers: 1 },
        BACKGROUND_CONTEXT,
      );
      const blocker = await f.hub.dispatchTicket({
        commandId: "cmd-slot-holder",
        title: "占位任务",
        goal: "占用唯一并发槽位",
        scope: "测试",
        role: "coder",
        envId: "local",
      });
      await vi.waitFor(async () => {
        const snap = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        expect(snap?.slots.holders).toContain(blocker.id);
      }, { timeout: 10_000, interval: 20 });

      const sub = await f.hub.sendUserMessage("打开网页并派单");
      expect((await sub.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const msgs = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages;
      const res = parseToolResultJson(msgs.find((m) => m.role === "toolResult" && m.toolName === "kulo_dispatch"));
      expect(res.browser_session_inherited).toBe(false);
      expect(res.browser_session_inherit_reason).toBe("worker_queued");
      releaseBlocker();
    }

    // 4. Scheduled execute_at, active_handoff, and same-turn parallel kulo_browser
    {
      const f = await createBrowserHandoffHub({
        handler: (context) => {
          const tools = toolNames(context);
          if (tools.includes("kulo_report")) return call("kulo_report", { state: "ready", summary: "done" });
          if (!tools.includes("kulo_browser") || !tools.includes("kulo_computer_handoff")) {
            return call("tool_search", { query: "kulo_browser kulo_computer_handoff", limit: 3 });
          }
          const lastUserIdx = context.messages.findLastIndex((m) => m.role === "user");
          const userText = JSON.stringify(context.messages[lastUserIdx]?.content ?? "");
          const turnResults = context.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

          if (userText.includes("并行测试")) {
            if (!turnResults.some((m) => m.toolName === "kulo_browser")) {
              return call("kulo_browser", { action: "open", url: "https://example.com" });
            }
            if (!turnResults.some((m) => m.toolName === "kulo_dispatch")) {
              // Emit kulo_browser + kulo_dispatch in the SAME assistant turn!
              return fauxAssistantMessage(
                [
                  fauxToolCall("kulo_browser", { action: "get-url" }),
                  fauxToolCall("kulo_dispatch", {
                    command_id: "cmd-parallel",
                    title: "并行派单",
                    goal: "验证同回合并发拒绝过户",
                    scope: "测试",
                    role: "coder",
                    inherit_browser_session: true,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            }
            return answer("并行测试完成");
          }
          if (userText.includes("定时测试")) {
            if (!turnResults.some((m) => m.toolName === "kulo_dispatch")) {
              return call("kulo_dispatch", {
                command_id: "cmd-scheduled",
                title: "定时任务",
                goal: "验证定时派单拒绝过户",
                scope: "测试",
                role: "coder",
                execute_at: new Date(Date.now() + 600_000).toISOString(),
                inherit_browser_session: true,
              });
            }
            return answer("定时测试完成");
          }
          if (userText.includes("只读角色测试")) {
            if (!turnResults.some((m) => m.toolName === "kulo_dispatch")) {
              return call("kulo_dispatch", {
                command_id: "cmd-readonly-role",
                title: "只读角色任务",
                goal: "验证只读角色拒绝过户",
                scope: "测试",
                role: "checker",
                inherit_browser_session: true,
              });
            }
            return answer("只读测试完成");
          }
          if (userText.includes("人工接管测试")) {
            if (!turnResults.some((m) => m.toolName === "kulo_computer_handoff")) {
              return call("kulo_computer_handoff", { target: "browser", reason: "请扫码登录" });
            }
            return answer("等待扫码");
          }
          if (userText.includes("接管中派单")) {
            if (!turnResults.some((m) => m.toolName === "kulo_dispatch")) {
              return call("kulo_dispatch", {
                command_id: "cmd-during-handoff",
                title: "接管中派单",
                goal: "验证活跃接管拒绝过户",
                scope: "测试",
                role: "coder",
                inherit_browser_session: true,
              });
            }
            return answer("接管中派单完成");
          }
          return answer("ok");
        },
      });

      const sParallel = await f.hub.sendUserMessage("并行测试");
      expect((await sParallel.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const sSched = await f.hub.sendUserMessage("定时测试");
      expect((await sSched.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const sReadOnly = await f.hub.sendUserMessage("只读角色测试");
      expect((await sReadOnly.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const sHandoff = await f.hub.sendUserMessage("人工接管测试");
      expect((await sHandoff.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const sDuringHandoff = await f.hub.sendUserMessage("接管中派单");
      expect((await sDuringHandoff.wait(BACKGROUND_CONTEXT)).status).toBe("done");

      const dispatchResults = (await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).messages
        .filter((m) => m.role === "toolResult" && m.toolName === "kulo_dispatch")
        .map((m) => parseToolResultJson(m));
      expect(dispatchResults.map((r) => [r.browser_session_inherited, r.browser_session_inherit_reason])).toEqual([
        [false, "concurrent_browser_call"],
        [false, "scheduled_ticket"],
        [false, "read_only_worker"],
        [false, "active_handoff"],
      ]);
    }

    // 5. Pure unit verification for env_mismatch + ungrouped default env routing + tombstone TTL
    const mismatch = evaluateBrowserSessionTransferEligibility({
      requested: true,
      isOrchestratorCaller: true,
      executionDomain: "computer",
      isExternalAgent: false,
      isScheduled: false,
      workerEffectiveMode: "trusted",
      isReadOnly: false,
      targetEnvId: "edge-2",
      candidate: {
        topicId: "root",
        envId: "edge-1",
        sessionId: "kulo-1111",
        profileMode: "persistent",
        hasActiveHandoff: false,
        hasInFlightCall: false,
      },
      hasSameTurnBrowserCall: false,
      hasImmediateWorkerSlot: true,
    });
    expect(mismatch).toEqual({ eligible: false, reason: "env_mismatch" });

    const localEnv: EnvNodeDescriptor = {
      id: "local",
      name: "Hub Local",
      kind: "local",
      online: true,
      platform: "darwin",
      arch: "arm64",
      rootDir: "/tmp/local",
      capabilities: ["trusted-host-v1", "agent-browser"],
      connectedAt: 1,
      lastSeenAt: 1,
    };
    const routed = resolveComputerEnvBinding({
      sourceEnvId: "edge-macbook",
      inheritedBrowserEnvId: "edge-macbook",
      localEnv,
      executionTrustMode: "trusted",
      pickFallbackEnvId: () => "local",
    });
    expect(routed).toEqual({ envId: "edge-macbook", envBinding: "sender_local", waitForSource: true });

    const tombstones = new TransferredBrowserSessionTombstones(1_000);
    tombstones.mark("kulo-old", 100);
    expect(tombstones.has("kulo-old", 500)).toBe(true);
    expect(tombstones.has("kulo-old", 1_200)).toBe(false);
    expect(BROWSER_SESSION_TRANSFERRED_ERROR).toContain("移交后台任务");
  });

  it("survives cold Hub restart: hydrates preservedSessionId from KuloStateDoc, keeps Orchestrator epoch isolated, and closes inherited session on stop without leaking", async () => {
    const sharedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-browser-restart-")));
    cleanups.push(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));

    // Phase 1: Hub #1 opens browser S1, transfers it to Worker T-0001, Worker parks via kulo_computer_handoff
    // (keeping S1 alive in durable KuloStateDoc), then Hub #1 shuts down cleanly.
    const hub1 = await createBrowserHandoffHub({
      root: sharedRoot,
      handler: (context) => {
        const tools = toolNames(context);
        if (tools.includes("kulo_report")) {
          if (!tools.includes("kulo_browser") || !tools.includes("kulo_computer_handoff")) {
            return call("tool_search", { query: "kulo_browser kulo_computer_handoff", limit: 3 });
          }
          if (!context.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_browser")) {
            return call("kulo_browser", { action: "get-url" });
          }
          return call("kulo_computer_handoff", { target: "browser", reason: "请完成二次验证" });
        }
        if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
        const results = context.messages.filter((m) => m.role === "toolResult");
        if (!results.some((m) => m.toolName === "kulo_browser")) {
          return call("kulo_browser", { action: "open", url: "https://portal.example.com" });
        }
        if (!results.some((m) => m.toolName === "kulo_dispatch")) {
          return call("kulo_dispatch", {
            command_id: "cmd-restart-durability",
            title: "跨重启浏览器任务",
            goal: "验证冷重启恢复继承会话",
            scope: "后台浏览器",
            role: "coder",
            inherit_browser_session: true,
          });
        }
        return answer("已派发");
      },
    });

    const sub1 = await hub1.hub.sendUserMessage("打开门户并派单");
    expect((await sub1.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    let ticketId = "";
    await vi.waitFor(async () => {
      const snap = await hub1.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = Object.values(snap?.tickets ?? {})[0];
      expect(t?.status).toBe("waiting");
      expect(t?.waiting?.reason).toBe("user");
      ticketId = t!.id;
    }, { timeout: 10_000, interval: 25 });

    const S1 = (hub1.native.mock.calls.find(([, req]) => req.action === "open")![1] as Extract<ComputerUseRequest, { action: "open" }>).sessionId;
    const state1 = await hub1.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(state1!.tickets[ticketId]?.inheritedBrowserSession).toEqual({ envId: "local", sessionId: S1 });
    expect(state1!.topics?.root?.browserSessionEpoch).toBe(2);
    expect(hub1.openSessions.has(S1)).toBe(true);

    // Close Hub #1 (clears all in-memory maps; S1 remains persisted on ticket.inheritedBrowserSession!)
    await hub1.hub.close();

    // Phase 2: Cold restart Hub #2 on the EXACT same stateDir (fresh empty in-memory #computerSessions!)
    let releaseHub2Worker!: () => void;
    const hub2WorkerGate = new Promise<void>((resolve) => {
      releaseHub2Worker = resolve;
    });
    cleanups.push(releaseHub2Worker);

    const hub2 = await createBrowserHandoffHub({
      root: sharedRoot,
      onNativeRequest: async (_envId, req) => {
        if (req.action === "snapshot") await hub2WorkerGate;
      },
      handler: (context) => {
        const tools = toolNames(context);
        if (tools.includes("kulo_report")) {
          if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
          if (!context.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_browser" && JSON.stringify(m).includes("snapshot"))) {
            return call("kulo_browser", { action: "snapshot" });
          }
          return call("kulo_report", { state: "ready", summary: "重启后继续完成" });
        }
        if (!tools.includes("kulo_browser")) return call("tool_search", { query: "kulo_browser", limit: 2 });
        const lastUserIdx = context.messages.findLastIndex((m) => m.role === "user");
        const turnResults = context.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
        if (!turnResults.some((m) => m.toolName === "kulo_browser")) {
          return call("kulo_browser", { action: "open", url: "https://fresh-after-restart.example.com" });
        }
        return answer("重启后主对话已新开独立页面");
      },
    });

    const state2Initial = await hub2.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket2 = state2Initial!.tickets[ticketId]!;
    expect(ticket2.inheritedBrowserSession).toEqual({ envId: "local", sessionId: S1 });

    // Resume the waiting Worker in Hub #2 -> #resolveExtensionScope hydrates S1 from ticket.inheritedBrowserSession!
    await hub2.hub.steerTicket({ commandId: "steer-after-restart", ticketId, text: "验证已完成，请继续快照检查当前页面" });
    await vi.waitFor(
      () => expect(hub2.native.mock.calls.some(([, req]) => req.action === "snapshot")).toBe(true),
      { timeout: 10_000, interval: 25 },
    );

    // 1. After cold Hub restart, Worker hydrated S1 from ticket.inheritedBrowserSession!
    const snapCall = hub2.native.mock.calls.find(([, req]) => req.action === "snapshot")!;
    expect((snapCall[1] as Extract<ComputerUseRequest, { action: "snapshot" }>).sessionId).toBe(S1);

    // 2. Preview discovery works after cold restart!
    const previews2 = await hub2.hub.listComputerPreviews("root");
    expect(previews2.some((p) => p.ticketId === ticketId && p.tool === "browser")).toBe(true);

    // 3. Orchestrator in Hub #2 still respects persisted browserSessionEpoch === 2 -> gets S2 !== S1!
    const subAfterRestart = await hub2.hub.sendUserMessage("重启后主对话开新网页");
    expect((await subAfterRestart.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const orchOpen = hub2.native.mock.calls.find(([, req]) => req.action === "open")!;
    expect((orchOpen[1] as Extract<ComputerUseRequest, { action: "open" }>).sessionId).not.toBe(S1);

    // 4. Stopping the ticket closes S1 on Env and clears persisted inheritedBrowserSession!
    const stopPromise = hub2.hub.stopTicket(ticketId, "重启后停止任务");
    releaseHub2Worker();
    await stopPromise;

    expect(
      hub2.native.mock.calls.some(([, req]) => req.action === "close" && "sessionId" in req && req.sessionId === S1),
    ).toBe(true);
    const stateAfterStop = await hub2.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(stateAfterStop?.tickets[ticketId]?.inheritedBrowserSession).toBeUndefined();
  });

  it("closes persisted inheritedBrowserSession on stopTicket after cold restart even if Worker never touched kulo_browser again", async () => {
    const sharedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-browser-restart-stop-")));
    cleanups.push(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));

    const hub1 = await createBrowserHandoffHub({
      root: sharedRoot,
      handler: () => answer("unused"),
    });
    const fakeSessionId = "kulo-0123456789abcdef0123456789abcdef";
    const ticket = await hub1.hub.dispatchTicket({
      commandId: "cmd-cold-stop",
      title: "冷重启直接停止",
      goal: "占位测试",
      scope: "测试",
      role: "coder",
      envId: "local",
      executeAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await hub1.hub.harness.commit(async (tx) => {
      const live = (await tx.doc(KuloStateDoc)).tickets[ticket.id]!;
      live.inheritedBrowserSession = { envId: "local", sessionId: fakeSessionId };
    }, BACKGROUND_CONTEXT);
    await hub1.hub.close();

    // Hub #2 opens cold with completely empty #computerSessions and immediately stops the ticket
    const hub2 = await createBrowserHandoffHub({
      root: sharedRoot,
      handler: () => answer("unused"),
    });
    await hub2.hub.stopTicket(ticket.id, "用户取消任务");

    expect(
      hub2.native.mock.calls.some(
        ([envId, req]) => envId === "local" && req.tool === "browser" && req.action === "close" && req.sessionId === fakeSessionId,
      ),
    ).toBe(true);
    const finalState = await hub2.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(finalState?.tickets[ticket.id]?.inheritedBrowserSession).toBeUndefined();
  });
});
