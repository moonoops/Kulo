import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
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
import { KuloStateDoc, type KuloHub } from "@kulo/hub";
import {
  isComputerPreviewInputEvent,
  isComputerPreviewUpdate,
  type ComputerPreviewUpdate,
} from "../packages/protocol/src/index.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { ComputerPreviewService } from "../packages/env/src/computer-preview.js";
import {
  ActiveComputerHandoffTracker,
  buildComputerHandoffCard,
  formatComputerHandoffResumePrompt,
} from "../packages/hub/src/computer-handoff.js";
import {
  computerUseSessionId,
  createComputerUseTools,
  type ComputerUseScope,
} from "../packages/hub/src/tools-computer-use.js";
import { ComputerPreviewClient, type PreviewSocket } from "../packages/web/src/features/computer-preview/preview-client.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("Batch 3 #7: computer handoff protocol, native stream input, and lifecycle", () => {
  it("validates deviceWidth/deviceHeight frames and strict preview input events", () => {
    const validFrame = {
      mimeType: "image/jpeg" as const,
      data: Buffer.from("img").toString("base64"),
      capturedAt: Date.now(),
      deviceWidth: 1280,
      deviceHeight: 800,
    };
    expect(isComputerPreviewUpdate({ state: "live", frame: validFrame })).toBe(true);
    expect(isComputerPreviewUpdate({ state: "live", frame: { ...validFrame, deviceWidth: -1 } })).toBe(false);

    expect(isComputerPreviewInputEvent({ type: "input_mouse", eventType: "mousePressed", x: 100, y: 200, button: "left", clickCount: 1, modifiers: 0 })).toBe(true);
    expect(isComputerPreviewInputEvent({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })).toBe(true);
    expect(isComputerPreviewInputEvent({ type: "input_touch", eventType: "touchStart", touchPoints: [{ x: 50, y: 80, id: 1 }] })).toBe(true);
    expect(isComputerPreviewInputEvent({ type: "input_text", text: "123456" })).toBe(true);

    // Reject malformed or dangerous inputs
    expect(isComputerPreviewInputEvent({ type: "input_text", text: "" })).toBe(false);
    expect(isComputerPreviewInputEvent({ type: "input_text", text: "a\x00b" })).toBe(false);
    expect(isComputerPreviewInputEvent({ type: "input_text", text: "x".repeat(600) })).toBe(false);
    expect(isComputerPreviewInputEvent({ type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, extra: 1 })).toBe(false);
    expect(isComputerPreviewInputEvent({ type: "eval", code: "alert(1)" })).toBe(false);
  });

  it("forwards deviceWidth/deviceHeight and native input_mouse/input_text over agent-browser stream WS", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-b3-preview-"));
    cleanups.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));

    const receivedFrames: any[] = [];
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as { port: number }).port;

    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        receivedFrames.push(JSON.parse(raw.toString("utf8")));
      });
      ws.send(JSON.stringify({
        type: "frame",
        seq: 1,
        data: Buffer.from("jpeg-bytes").toString("base64"),
        metadata: { timestamp: Date.now(), deviceWidth: 1440, deviceHeight: 900 },
      }));
    });

    const service = new ComputerPreviewService({
      rootDir,
      runner: vi.fn(async () => ({ success: true, data: { enabled: true, port } })) as never,
      browserInvocation: () => ({ args: ["--session", "s1"], cwd: rootDir, env: {} }),
      desktopTarget: () => undefined,
      desktopEnvironment: () => ({}),
      queueDesktop: () => {},
    });
    cleanups.push(() => service.suspend());

    const updates: ComputerPreviewUpdate[] = [];
    const unsub = service.subscribe({ tool: "browser", sessionId: "s1" }, (u) => updates.push(u));
    cleanups.push(unsub);

    await vi.waitFor(() => expect(updates.some((u) => u.state === "live")).toBe(true));
    const live = updates.find((u) => u.state === "live")!;
    expect(live.frame?.deviceWidth).toBe(1440);
    expect(live.frame?.deviceHeight).toBe(900);

    expect(service.sendInput({ tool: "browser", sessionId: "s1" }, {
      type: "input_mouse",
      eventType: "mousePressed",
      x: 320,
      y: 240,
      button: "left",
      clickCount: 1,
    })).toBe(true);
    expect(service.sendInput({ tool: "browser", sessionId: "s1" }, {
      type: "input_text",
      text: "42",
    })).toBe(true);

    await vi.waitFor(() => expect(receivedFrames.filter((f) => f.type !== "ack").length).toBe(3));
    const inputs = receivedFrames.filter((f) => f.type !== "ack");
    expect(inputs[0]).toMatchObject({ type: "input_mouse", eventType: "mousePressed", x: 320, y: 240 });
    expect(inputs[1]).toEqual({ type: "input_keyboard", eventType: "char", text: "4" });
    expect(inputs[2]).toEqual({ type: "input_keyboard", eventType: "char", text: "2" });
  });

  it("tracks handoff lifecycle, auto-expires cleanly, and emits mandatory re-read resume instructions", async () => {
    const tracker = new ActiveComputerHandoffTracker();
    cleanups.push(() => tracker.closeAll());
    const expired: string[] = [];

    tracker.register({
      requestId: "cfm_1",
      ticketId: "t-1",
      runEpoch: 1,
      envId: "local",
      tool: "browser",
      sessionId: "kulo-sess-1",
      conversationId: 2,
      originConversationId: 1,
      reason: "请完成扫码登录",
      expiresAt: Date.now() + 60_000,
    }, (item) => { expired.push(item.ticketId); });

    expect(tracker.hasActiveHandoff("t-1", "kulo-sess-1")).toBe(true);
    expect(tracker.hasActiveHandoff("t-1", "other-sess")).toBe(false);

    // Clearing immediately revokes active status
    tracker.clear("t-1");
    expect(tracker.hasActiveHandoff("t-1", "kulo-sess-1")).toBe(false);
    expect(expired).toEqual([]);

    const card = buildComputerHandoffCard({
      target: "browser",
      deviceName: "Mac",
      reason: "请完成短信验证",
      url: "https://example.com/login",
    });
    expect(card.logicalIds).toEqual(["confirm", "cancel"]);
    expect(card.input.actions?.map((a) => a.id)).toEqual(["confirm", "cancel"]);

    const donePrompt = formatComputerHandoffResumePrompt({ action: "done", target: "browser", reason: "请完成短信验证" });
    expect(donePrompt).toContain("kulo_browser(action='get-url')");
    expect(donePrompt).toContain("kulo_browser(action='snapshot')");

    const cancelPrompt = formatComputerHandoffResumePrompt({ action: "cancel", target: "browser", reason: "请完成短信验证" });
    expect(cancelPrompt).toContain("跳过");
  });

  it("reuses preservedSessionId across handoff steerTicket while keeping kulo_computer_handoff writable-Worker-only", async () => {
    const execute = vi.fn(async () => ({ tool: "browser" as const, action: "get-url" as const, sessionId: "preserved-1", ok: true, data: { url: "https://example.com" } }));
    const requestHandoff = vi.fn(async () => ({ requestId: "cfm_handoff", cardId: "card_1", expiresAt: Date.now() + 600_000 }));
    let currentScope: ComputerUseScope = {
      ticketId: "ticket-9",
      conversationId: 42,
      runEpoch: 2,
      envId: "local",
      readOnly: false,
      preservedSessionId: "preserved-1",
      assertActive: async () => {},
    };
    const tools = createComputerUseTools({
      scope: async () => currentScope,
      execute,
      requestHandoff,
    });
    const browserTool = tools.find((t) => t.name === "kulo_browser")!;
    const handoffTool = tools.find((t) => t.name === "kulo_computer_handoff")!;
    expect(handoffTool).toBeDefined();

    // Resumed epoch reuses preservedSessionId instead of rotating to computerUseSessionId(runEpoch=2)
    expect(computerUseSessionId(currentScope)).not.toBe("preserved-1");
    await browserTool.execute({ action: "get-url" }, { callId: "c1" } as never, {} as never);
    expect(execute).toHaveBeenCalledWith("local", { tool: "browser", action: "get-url", sessionId: "preserved-1" }, undefined);

    // Writable Worker handoff returns terminate: true (silent park)
    const res = await handoffTool.execute(
      { target: "browser", reason: "请完成双因素认证", url: "https://example.com/2fa" },
      { callId: "c2" } as never,
      {} as never,
    );
    expect(res.control).toEqual({ terminate: true });
    expect(requestHandoff).toHaveBeenCalledWith(
      currentScope,
      { target: "browser", sessionId: "preserved-1", reason: "请完成双因素认证", url: "https://example.com/2fa" },
      expect.anything(),
      expect.anything(),
    );

    // Read-only chat caller must be rejected
    currentScope = { ...currentScope, ticketId: "chat:root:local", readOnly: true };
    const blocked = await handoffTool.execute({ target: "browser", reason: "test" }, { callId: "c3" } as never, {} as never);
    expect(blocked.isError).toBe(true);
  });

  it("only allows ComputerPreviewClient.sendInput when handoff.interactive is active", () => {
    const sent: any[] = [];
    const socket: PreviewSocket = {
      readyState: 1,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (raw) => sent.push(JSON.parse(raw)),
      close: () => {},
    };
    const client = new ComputerPreviewClient({
      connect: () => socket,
      createImageUrl: () => "blob:frame",
      revokeImageUrl: () => {},
    });
    client.start();
    socket.onopen?.();
    sent.length = 0;

    // Session without handoff -> sendInput rejected
    client.receive({
      type: "preview.sessions",
      sessions: [{ id: "s1", ticketId: "t1", tool: "browser", envId: "local", deviceName: "Mac", title: "Login" }],
    });
    expect(client.sendInput("s1", { type: "input_text", text: "1234" })).toBe(false);
    expect(sent).toEqual([]);

    // Session WITH interactive handoff -> sendInput forwarded
    client.receive({
      type: "preview.sessions",
      sessions: [{
        id: "s1",
        ticketId: "t1",
        tool: "browser",
        envId: "local",
        deviceName: "Mac",
        title: "Login",
        handoff: { requestId: "r1", reason: "输入验证码", target: "browser", expiresAt: Date.now() + 60_000, interactive: true },
      }],
    });
    expect(client.sendInput("s1", { type: "input_text", text: "1234" })).toBe(true);
    expect(sent).toEqual([{ type: "preview.input", id: "s1", event: { type: "input_text", text: "1234" } }]);

    // Once handoff finishes -> sendInput immediately revoked
    client.receive({
      type: "preview.sessions",
      sessions: [{ id: "s1", ticketId: "t1", tool: "browser", envId: "local", deviceName: "Mac", title: "Login" }],
    });
    expect(client.sendInput("s1", { type: "input_text", text: "5678" })).toBe(false);
    client.close();
  });

  it("stops computer_handoff directly across chat card, preview resolveComputerHandoff, and legacy ticket.steer cancel without waking Worker or triggering recovery", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-handoff-stop-state-"));
    const localEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-handoff-stop-env-"));
    cleanups.push(() => {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(localEnvRoot, { recursive: true, force: true });
    });

    const faux = fauxProvider({ provider: "handoff-stop-test", models: [{ id: "handoff-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerRuns = 0;
    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const loaded = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "tool_search");
          if (!loaded) {
            workerRuns += 1;
            return fauxAssistantMessage(
              [fauxToolCall("tool_search", { query: "kulo_computer_handoff", limit: 3 })],
              { stopReason: "toolUse" },
            );
          }
          const handedOff = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_computer_handoff");
          if (handedOff) return fauxAssistantMessage([fauxText("Waiting for user handoff")]);
          return fauxAssistantMessage(
            [fauxToolCall("kulo_computer_handoff", { target: "browser", reason: "请完成扫码登录", url: "https://example.com/login" })],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("好的，已停止任务。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "handoff-stop-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "handoff-stop-test", defaultModel: "handoff-model", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close().catch(() => {}));

    // Stub local env capabilities to expose agent-browser and record computer-use close calls.
    const closeCalls: Array<{ envId: string; sessionId: string }> = [];
    const localEnv = hub.envManager.getEnvDescriptor("local");
    if (localEnv && !localEnv.capabilities.includes("agent-browser")) {
      localEnv.capabilities.push("agent-browser");
    }
    vi.spyOn(hub.envManager, "requestComputerUse").mockImplementation(async (envId, req) => {
      if (req.action === "close" && req.sessionId) {
        closeCalls.push({ envId, sessionId: req.sessionId });
      }
      return { tool: req.tool, action: req.action, sessionId: req.sessionId ?? "s", ok: true, data: {} };
    });

    async function dispatchAndWaitForHandoff(cmd: string, expectedRuns: number) {
      const card = await hub.dispatchTicket({
        commandId: cmd,
        title: `浏览器登录 ${expectedRuns}`,
        goal: "打开网页并登录",
        scope: "browser",
        role: "coder",
      });
      let cardId = "";
      await vi.waitFor(async () => {
        const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
        const live = snap?.tickets[card.id];
        expect(live?.status).toBe("waiting");
        expect(live?.waiting?.reason).toBe("user");
        expect(live?.waiting?.options?.find((o) => o.id === "cancel")?.action).toBe("stop");
        expect(live?.waiting?.cardId).toBeTruthy();
        cardId = live!.waiting!.cardId!;
      }, { timeout: 15_000, interval: 40 });
      expect(workerRuns).toBe(expectedRuns);
      return { ticketId: card.id, cardId };
    }

    // Entry 1: Chat card "跳过并停止" (submitUiAction atomic direct-stop)
    const e1 = await dispatchAndWaitForHandoff("handoff-stop-1", 1);
    const uiCard1 = (await hub.uiCards.get(e1.cardId))!;
    const cancelBtn1 = uiCard1.actions.find((a) => a.label === "跳过并停止")!;
    const receipt1 = await hub.submitUiAction({
      cardId: uiCard1.cardId,
      revision: uiCard1.revision,
      actionId: cancelBtn1.id,
      values: {},
      commandId: "handoff-card-cancel-1",
    });
    expect(receipt1.status).toBe("cancelled");
    expect(receipt1.card?.resultSummary).toBe("已停止任务");
    const snap1 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap1?.tickets[e1.ticketId]).toMatchObject({ status: "stopped", stoppedReason: "用户跳过人工接管并停止任务", cleanupPending: false });
    expect(snap1?.tickets[e1.ticketId]?.recovery).toBeUndefined();
    expect(workerRuns).toBe(1);
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);

    // Entry 2: Preview modal resolveComputerHandoff(..., "cancel")
    const closeBefore2 = closeCalls.length;
    const e2 = await dispatchAndWaitForHandoff("handoff-stop-2", 2);
    const res2 = await hub.resolveComputerHandoff(e2.ticketId, "cancel");
    expect(res2).toEqual({ ok: true, status: "cancel" });
    const snap2 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap2?.tickets[e2.ticketId]).toMatchObject({ status: "stopped", stoppedReason: "用户跳过人工接管并停止任务", cleanupPending: false });
    expect(snap2?.tickets[e2.ticketId]?.recovery).toBeUndefined();
    expect((await hub.uiCards.get(e2.cardId))?.status).toBe("cancelled");
    expect(workerRuns).toBe(2);
    expect(closeCalls.length).toBeGreaterThan(closeBefore2);

    // Entry 3: Legacy Task Detail client sending ticket.steer(decisionOptionId="cancel")
    const closeBefore3 = closeCalls.length;
    const e3 = await dispatchAndWaitForHandoff("handoff-stop-3", 3);
    const card3 = await hub.steerTicket({
      ticketId: e3.ticketId,
      commandId: "handoff-legacy-cancel-3",
      text: "跳过并停止",
      decisionOptionId: "cancel",
    });
    expect(card3.status).toBe("stopped");
    expect(card3.stoppedReason).toBe("用户跳过人工接管并停止任务");
    const snap3 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap3?.tickets[e3.ticketId]?.recovery).toBeUndefined();
    expect((await hub.uiCards.get(e3.cardId))?.status).toBe("cancelled");
    expect(workerRuns).toBe(3);
    expect(closeCalls.length).toBeGreaterThan(closeBefore3);
  }, 30_000);
});
