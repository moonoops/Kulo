import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ComputerUseRequest, ComputerUseResult, ComputerPreviewUpdate } from "@kulo/protocol";
import { KuloHub, KuloStateDoc } from "@kulo/hub";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => void | Promise<void>> = [];
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

function toolNames(context: TranscriptContext): string[] {
  return [...new Set([...(context.tools?.map((tool) => tool.name) ?? []), ...context.messages.flatMap((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) ? message.toolsAdded.map((tool) => tool.name) : [])])];
}

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY", "KULO_ENV_TOKENS"]) vi.stubEnv(key, "");
  vi.stubEnv("KULO_COMPUTER_USE", "browser");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(operations: Array<{ action: string; url?: string; ref?: string }>, onRequest?: (request: ComputerUseRequest) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-computer-hub-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "computer-hub-model" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  let workerStep = 0;
  const workerTools: string[][] = [];
  provider.setResponses(Array.from({ length: 40 }, () => (context: TranscriptContext) => {
    const tools = toolNames(context);
    if (!tools.includes("kulo_report")) return answer("已收到任务结果。");
    if (!tools.includes("kulo_browser")) {
      return call("tool_search", { query: "browser desktop", limit: 3 });
    }
    workerTools.push(tools);
    const operation = operations[workerStep++];
    if (operation) return call("kulo_browser", operation);
    if (workerStep === operations.length + 1) return call("kulo_report", { state: "ready", summary: "浏览器任务已验证完成。" });
    return answer("任务完成。");
  }));
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN,
    stateDir: path.join(root, "state"), identityDir: path.join(root, "identity"), localEnvRoot: path.join(root, "runtime"),
    enableLocalEnv: true, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "computer-hub-model", thinkingLevel: "off", apiKey: "" },
  } });
  cleanups.push(() => hub.close());
  const openSessions = new Set<string>();
  const native = vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (_envId, request) => {
    await onRequest?.(request);
    const base = { tool: request.tool, action: request.action, ...("sessionId" in request ? { sessionId: request.sessionId } : {}), platform: process.platform };
    if (request.action === "open") openSessions.add(request.sessionId);
    else if (request.action === "close") {
      if (!openSessions.delete(request.sessionId)) return { ...base, ok: false, error: { code: "SESSION_NOT_FOUND", message: "The session was already closed" } } as ComputerUseResult;
    }
    return { ...base, ok: true, data: { source: "fake-native-env" } } as ComputerUseResult;
  });
  const completed = async (ticketId: string) => {
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[ticketId]?.status).toBe("ready");
      expect(state?.tickets[ticketId]?.cleanupPending).not.toBe(true);
      expect(state?.slots.holders).not.toContain(ticketId);
    }, { timeout: 10_000, interval: 20 });
    return (await hub.inspectTicketDetail(ticketId)).ticket;
  };
  const toolResults = async (conversationId: number) => {
    const conversation = await hub.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    return (await conversation!.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult" && message.toolName === "kulo_browser");
  };
  return { hub, native, openSessions, workerTools, completed, toolResults };
}

describe("computer use through real Hub Workers", () => {
  it("scopes live previews to the current topic and retires subscriptions when the task stops", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture([{ action: "open", url: "https://example.com" }, { action: "snapshot" }], async (request) => {
      if (request.action === "snapshot") await held;
    });
    cleanups.push(release);
    let emit!: (update: ComputerPreviewUpdate) => void;
    const unsubscribe = vi.fn();
    const nativePreview = vi.spyOn(f.hub.envManager, "subscribeComputerPreview").mockImplementation((_envId, _target, listener) => {
      emit = listener;
      return unsubscribe;
    });
    const ticket = await f.hub.dispatchTicket({ commandId: "browser-preview", title: "查看页面", goal: "观察指定网页", scope: "任务浏览器", role: "coder", envId: "local" });
    await vi.waitFor(() => expect(f.native.mock.calls.some(([, request]) => request.action === "snapshot")).toBe(true));
    const views = await f.hub.listComputerPreviews("root");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ ticketId: ticket.id, tool: "browser", envId: "local", title: "查看页面" });
    expect(await f.hub.listComputerPreviews("*")).toEqual(views);
    expect(await f.hub.listComputerPreviews("another-topic")).toEqual([]);
    await expect(f.hub.subscribeComputerPreview(views[0]!.id, "another-topic", () => {})).rejects.toThrow("已失效");
    expect(nativePreview).not.toHaveBeenCalled();
    const updates: ComputerPreviewUpdate[] = [];
    const dispose = await f.hub.subscribeComputerPreview(views[0]!.id, "*", (update) => updates.push(update));
    const frame: ComputerPreviewUpdate = { state: "live", frame: { mimeType: "image/png", data: "iVBORw==", capturedAt: Date.now() } };
    emit(frame);
    await vi.waitFor(() => expect(updates).toEqual([frame]));
    const stopping = f.hub.stopTicket(ticket.id, "手动停止");
    release();
    await stopping;
    expect(await f.hub.listComputerPreviews("root")).toEqual([]);
    expect(await f.hub.listComputerPreviews("*")).toEqual([]);
    emit(frame);
    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ state: "closed" }));
    expect(unsubscribe).toHaveBeenCalledOnce();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(JSON.stringify(await f.toolResults((await f.hub.inspectTicketDetail(ticket.id)).ticket.workerConversationId))).not.toContain("iVBORw==");
  });

  it("discovers previews across non-deleted topics with global scope '*' and drops them when their topic is deleted", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture([{ action: "open", url: "https://example.com" }, { action: "snapshot" }], async (request) => {
      if (request.action === "snapshot") await held;
    });
    cleanups.push(release);
    const topic = await f.hub.createTopic("次话题");
    const ticket = await f.hub.dispatchTicket({ commandId: "browser-preview-global", title: "次话题网页巡检", goal: "观察指定网页", scope: "任务浏览器", role: "coder", envId: "local", originConversationId: topic.conversationId });
    await vi.waitFor(() => expect(f.native.mock.calls.some(([, request]) => request.action === "snapshot")).toBe(true));
    expect(await f.hub.listComputerPreviews("root")).toEqual([]);
    const topicViews = await f.hub.listComputerPreviews(topic.id);
    const globalViews = await f.hub.listComputerPreviews("*");
    expect(topicViews).toHaveLength(1);
    expect(globalViews).toEqual(topicViews);
    expect(globalViews[0]).toMatchObject({ ticketId: ticket.id, title: "次话题网页巡检" });
    const deleting = f.hub.deleteTopic(topic.id, BACKGROUND_CONTEXT, { stopTasks: true });
    release();
    await deleting;
    expect(await f.hub.listComputerPreviews("*")).toEqual([]);
  });

  it("does not close an explicitly closed session again during ticket release", async () => {
    const f = await fixture([{ action: "open", url: "https://example.com" }, { action: "close" }]);
    const dispatched = await f.hub.dispatchTicket({ commandId: "browser-explicit-close", title: "检查页面并关闭", goal: "检查指定页面，然后结束浏览器会话", scope: "当前任务浏览器", role: "coder", envId: "local" });
    const ticket = await f.completed(dispatched.id);
    expect(f.workerTools[0]).toEqual(expect.arrayContaining(["kulo_browser", "kulo_desktop"]));
    const requests = f.native.mock.calls.map(([envId, request]) => ({ envId, request }));
    expect(requests).toHaveLength(2);
    expect(requests.map(({ request }) => request.action)).toEqual(["open", "close"]);
    expect(requests.every(({ envId }) => envId === ticket.envId)).toBe(true);
    const first = requests[0]!.request as Extract<ComputerUseRequest, { action: "open" }>;
    expect(first.sessionId).toMatch(/^kulo-[a-f0-9]{32}$/);
    expect(requests[1]!.request).toMatchObject({ tool: "browser", sessionId: first.sessionId });
    expect(f.openSessions.size).toBe(0);
    const results = await f.toolResults(ticket.workerConversationId!);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.role === "toolResult" && !result.isError)).toBe(true);
  });

  it("releases an unclosed browser session on the same Env when the Worker reports ready", async () => {
    const f = await fixture([{ action: "open", url: "https://example.com" }]);
    const dispatched = await f.hub.dispatchTicket({ commandId: "browser-auto-close", title: "读取页面", goal: "读取指定网页并交付结果", scope: "当前任务浏览器", role: "coder", envId: "local" });
    const ticket = await f.completed(dispatched.id);
    expect(f.native).toHaveBeenCalledTimes(2);
    const [open, close] = f.native.mock.calls;
    expect(open![0]).toBe(ticket.envId);
    expect(close![0]).toBe(ticket.envId);
    expect(close![1]).toMatchObject({ tool: "browser", action: "close", sessionId: (open![1] as Extract<ComputerUseRequest, { action: "open" }>).sessionId });
    expect(f.openSessions.size).toBe(0);
    expect(await f.toolResults(ticket.workerConversationId!)).toHaveLength(1);
  });

  it("rejects a read-only Worker's mutation before dispatching a native operation", async () => {
    const f = await fixture([{ action: "click", ref: "@e1" }]);
    const dispatched = await f.hub.dispatchTicket({ commandId: "browser-readonly", title: "只读审查", goal: "只读审查当前界面", scope: "只读", role: "checker", envId: "local" });
    const ticket = await f.completed(dispatched.id);
    expect(ticket.readOnly).toBe(true);
    expect(f.native).not.toHaveBeenCalled();
    const results = await f.toolResults(ticket.workerConversationId!);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toContain("只读");
  });

  it("exposes deferred read-only kulo_browser on Main Chat bound to verified target Env, blocks mutations & kulo_desktop, and auto-closes on idle or topic delete", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-chat-browser-")));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const provider = fauxProvider({ provider: "openai", models: [{ id: "computer-hub-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);

    const observedChatTools: string[][] = [];
    provider.setResponses(Array.from({ length: 30 }, () => (context: TranscriptContext) => {
      const tools = toolNames(context);
      observedChatTools.push(tools);
      const lastUserIdx = context.messages.findLastIndex((m) => m.role === "user");
      const turnResults = context.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
      if (!tools.includes("kulo_browser")) {
        return call("tool_search", { query: "浏览器 打开网页 desktop", limit: 3 });
      }
      if (turnResults.filter((m) => m.toolName === "kulo_browser").length === 0) {
        return call("kulo_browser", { action: "open", url: "https://example.com/docs" });
      }
      if (turnResults.filter((m) => m.toolName === "kulo_browser").length === 1) {
        return call("kulo_browser", { action: "snapshot" });
      }
      if (turnResults.filter((m) => m.toolName === "kulo_browser").length === 2) {
        return call("kulo_browser", { action: "click", ref: "@e1" });
      }
      return answer("主脑已完成只读网页快照观察，并拒绝了点击操作。");
    }));

    const hub = await openTestHub({
      models,
      orchestratorBrowserIdleMs: 140,
      config: {
        authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir: path.join(root, "state"),
        identityDir: path.join(root, "identity"),
        localEnvRoot: path.join(root, "runtime"),
        enableLocalEnv: true,
        memory: { enabled: false },
        watchdogMinutes: 0,
        model: { defaultProvider: "openai", defaultModel: "computer-hub-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());
    const initSettings = hub.getSettingsView();
    await hub.updateSettingsBlock(
      "executor",
      initSettings.blocks.executor.revision,
      { ...initSettings.blocks.executor.value, executionTrustMode: "sandboxed" },
      BACKGROUND_CONTEXT,
    );

    const openSessions = new Set<string>();
    const native = vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (_envId, request) => {
      const base = { tool: request.tool, action: request.action, ...("sessionId" in request ? { sessionId: request.sessionId } : {}), platform: process.platform };
      if (request.action === "open") openSessions.add(request.sessionId);
      if (request.action === "close") openSessions.delete(request.sessionId);
      return { ...base, ok: true, data: { title: "Docs" } } as ComputerUseResult;
    });

    const sub = await hub.sendUserMessage("帮我打开网页只读看一眼结构");
    expect((await sub.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    // 1. kulo_browser was initially deferred, unlocked via tool_search; kulo_desktop never leaked to Main Chat!
    expect(observedChatTools[0]).not.toContain("kulo_browser");
    expect(observedChatTools.some((t) => t.includes("kulo_browser"))).toBe(true);
    expect(observedChatTools.every((t) => !t.includes("kulo_desktop"))).toBe(true);

    // 2. open + snapshot executed against "local"; click was blocked BEFORE native execution!
    expect(native.mock.calls.map(([envId, req]) => `${envId}:${req.action}`)).toEqual(["local:open", "local:snapshot"]);
    const browserResults = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).messages.filter(
      (m) => m.role === "toolResult" && m.toolName === "kulo_browser",
    );
    expect(browserResults).toHaveLength(3);
    expect(browserResults[0]?.isError).not.toBe(true);
    expect(browserResults[1]?.isError).not.toBe(true);
    expect(browserResults[2]?.isError).toBe(true);
    expect(JSON.stringify(browserResults[2])).toContain("只读");

    // 3. Session auto-closes after orchestratorBrowserIdleMs (140ms) so browser slots are never leaked!
    expect(openSessions.size).toBe(1);
    await vi.waitFor(() => expect(openSessions.size).toBe(0), { timeout: 2_000, interval: 25 });
    expect(native.mock.calls.at(-1)?.[1]).toMatchObject({ tool: "browser", action: "close" });
  });

  it("unlocks interactive kulo_browser and kulo_desktop on Main Chat in trusted mode without killing sessions on Worker start", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-chat-trusted-cu-")));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const provider = fauxProvider({ provider: "openai", models: [{ id: "computer-hub-model" }] });
    const models = createModels();
    models.setProvider(provider.provider);

    const observedChatTools: string[][] = [];
    provider.setResponses(Array.from({ length: 30 }, () => (context: TranscriptContext) => {
      const tools = toolNames(context);
      observedChatTools.push(tools);
      const lastUserIdx = context.messages.findLastIndex((m) => m.role === "user");
      const turnResults = context.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
      if (!tools.includes("kulo_browser") || !tools.includes("kulo_desktop") || !tools.includes("kulo_computer_handoff")) {
        return call("tool_search", { query: "kulo_browser kulo_desktop kulo_computer_handoff", limit: 3 });
      }
      const browserCalls = turnResults.filter((m) => m.toolName === "kulo_browser").length;
      const desktopCalls = turnResults.filter((m) => m.toolName === "kulo_desktop").length;
      const handoffCalls = turnResults.filter((m) => m.toolName === "kulo_computer_handoff").length;
      if (browserCalls === 0) return call("kulo_browser", { action: "open", url: "https://example.com/app" });
      if (browserCalls === 1) return call("kulo_browser", { action: "click", ref: "@e1" });
      if (desktopCalls === 0) return call("kulo_desktop", { action: "snapshot", app: "Safari" });
      if (handoffCalls === 0) return call("kulo_computer_handoff", { target: "desktop", reason: "尝试桌面接管" });
      if (handoffCalls === 1) return call("kulo_computer_handoff", { target: "browser", reason: "请扫码登录", url: "https://example.com/app" });
      return answer("已在主对话中完成浏览器点击、桌面快照观察，并发起浏览器登录接管。");
    }));

    const hub = await openTestHub({
      models,
      orchestratorBrowserIdleMs: 5_000,
      config: {
        authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir: path.join(root, "state"),
        identityDir: path.join(root, "identity"),
        localEnvRoot: path.join(root, "runtime"),
        enableLocalEnv: true,
        memory: { enabled: false },
        watchdogMinutes: 0,
        model: { defaultProvider: "openai", defaultModel: "computer-hub-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());

    const origDesc = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((envId) => {
      const desc = origDesc(envId);
      if (!desc) return desc;
      const caps = new Set(desc.capabilities);
      caps.add("agent-browser");
      caps.add("agent-desktop");
      return { ...desc, capabilities: [...caps] };
    });

    const native = vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (_envId, request) => ({
      tool: request.tool,
      action: request.action,
      ...("sessionId" in request ? { sessionId: request.sessionId } : {}),
      platform: process.platform,
      ok: true,
      data: request.tool === "desktop" ? { app: "Safari", snapshot: "Docs window" } : { title: "App" },
    }) as ComputerUseResult);

    const sub = await hub.sendUserMessage("打开网页点一下按钮并查看桌面窗口");
    expect((await sub.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    expect(observedChatTools.some((t) => t.includes("kulo_browser"))).toBe(true);
    expect(observedChatTools.some((t) => t.includes("kulo_desktop"))).toBe(true);
    expect(native.mock.calls.map(([envId, req]) => `${envId}:${req.tool}:${req.action}`)).toEqual([
      "local:browser:open",
      "local:browser:click",
      "local:desktop:snapshot",
    ]);
    const handoffResults = (await hub.rootConversation.context(BACKGROUND_CONTEXT)).messages.filter(
      (m) => m.role === "toolResult" && m.toolName === "kulo_computer_handoff",
    );
    expect(handoffResults).toHaveLength(2);
    expect(handoffResults[0]?.isError).toBe(true);
    expect(handoffResults[1]?.isError).not.toBe(true);

    const previews = await hub.listComputerPreviews("root");
    expect(previews.some((p) => p.tool === "browser" && p.handoff?.interactive === true)).toBe(true);
    expect(previews.some((p) => p.tool === "desktop" && p.handoff === undefined)).toBe(true);
  });
});
