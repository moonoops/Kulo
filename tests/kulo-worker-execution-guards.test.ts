import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openTestHub } from "./helpers/secure-hub.js";
import { KuloStateDoc, WorkerWatchdogEntry } from "../packages/hub/src/state.js";
import { createWorkerExtension, DEFAULT_WORKER_SHELL_TIMEOUT_SECONDS } from "../packages/hub/src/tools-worker.js";

function workerGuard() {
  const state = { tickets: { "T-1": { id: "T-1", status: "running" } }, conversationToTicket: { "8": "T-1" } };
  const extension = createWorkerExtension({ getIdentityDir: () => "/private/kulo/identity", getMemoryConfig: () => ({ enabled: false }) as never });
  const handlers = extension.hooks![0]!.handlers as {
    beforeTool(call: ToolHookCall, api: unknown, context: typeof BACKGROUND_CONTEXT): Promise<{ arguments?: Record<string, unknown>; block?: string } | undefined>;
  };
  const invoke = (args: Record<string, unknown>, conversationId = 8) => handlers.beforeTool({ name: "bash", id: "shell-call", arguments: args } as ToolHookCall,
    { conversationId, snapshot: async () => state }, BACKGROUND_CONTEXT);
  return { invoke, state };
}

describe("Worker execution guards", () => {
  it("bounds shell commands without a timeout while preserving explicit short and long limits", async () => {
    const f = workerGuard();
    expect(await f.invoke({ command: "ping -c 1 127.0.0.1" })).toEqual({ arguments: {
      command: "ping -c 1 127.0.0.1", timeout: DEFAULT_WORKER_SHELL_TIMEOUT_SECONDS,
    } });
    for (const timeout of [0.1, 900]) expect(await f.invoke({ command: "build", timeout })).toBeUndefined();
    expect(await f.invoke({ command: "query" }, ROOT_CONVERSATION_ID)).toBeUndefined();
  });

  it("retains authorization and private path guards before applying a default timeout", async () => {
    const f = workerGuard();
    expect(await f.invoke({ command: "cat /private/kulo/identity/identity-agreement.md" })).toMatchObject({ block: expect.stringContaining("private identity directory") });
    f.state.tickets["T-1"]!.status = "stopped";
    expect(await f.invoke({ command: "ping" })).toMatchObject({ block: expect.stringContaining("active ticket") });
  });

  it("rejects a watchdog's stop attempt but accepts the following explicit user stop", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-watchdog-stop-"));
    const faux = fauxProvider({ provider: "guard-test", models: [{ id: "test" }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 10 }, () => (ctx) => {
      const lastUser = ctx.messages.findLastIndex((entry) => entry.role === "user");
      if (ctx.messages.slice(lastUser + 1).some((entry) => entry.role === "toolResult")) return fauxAssistantMessage("已核对任务状态。");
      return fauxAssistantMessage([fauxToolCall("kulo_stop", { ticket_id: "T-0001", reason: "停止检查" })], { stopReason: "toolUse" });
    }));
    const hub = await openTestHub({ models, providerId: "guard-test", config: { stateDir, watchdogMinutes: 0,
      model: { defaultProvider: "guard-test", defaultModel: "test", thinkingLevel: "off" }, memory: { enabled: false } } });
    try {
      const ticket = await hub.dispatchTicket({ commandId: "scheduled-guard", title: "稍后检查", goal: "只用于停止语义验证", scope: "测试目录", executeAt: new Date(Date.now() + 60_000).toISOString() });
      const automatic = await hub.rootConversation.submit({ type: "input", content: "[KULO_WORKER_WATCHDOG] 请检查任务异常。",
        entry: { kind: WorkerWatchdogEntry.kind, data: { ticketId: ticket.id, title: ticket.title, role: ticket.role,
          reason: "stalled", idleSec: 5, runningSec: 5, runEpoch: 1 } } }, BACKGROUND_CONTEXT);
      await automatic.wait(BACKGROUND_CONTEXT);
      expect((await hub.harness.snapshot(KuloStateDoc))?.tickets[ticket.id]?.status).not.toBe("stopped");
      const page = await hub.rootConversation.entries({}, 30, undefined, BACKGROUND_CONTEXT);
      expect(JSON.stringify(page.items)).toContain("后台巡检和回报不能代替用户停止任务");
      const explicit = await hub.sendUserMessage("停止这个后台任务");
      await explicit.wait(BACKGROUND_CONTEXT);
      expect((await hub.harness.snapshot(KuloStateDoc))?.tickets[ticket.id]?.status).toBe("stopped");
    } finally { await hub.close(); fs.rmSync(stateDir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "darwin")("ends a timed-out native command and reports a blocker without marking a user stop", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-command-timeout-"));
    const faux = fauxProvider({ provider: "timeout-test", models: [{ id: "test" }] });
    const models = createModels(); models.setProvider(faux.provider);
    let timeoutObserved = false;
    faux.setResponses(Array.from({ length: 12 }, () => (ctx) => {
      if (ctx.tools?.some((tool) => tool.name === "kulo_dispatch")) return fauxAssistantMessage("命令超时，需要调整执行时限。");
      const shell = ctx.messages.findLast((message) => message.role === "toolResult" && message.toolName === "bash");
      if (!shell) return fauxAssistantMessage([fauxToolCall("bash", { command: 'node -e "setInterval(() => {}, 1000)"', timeout: 0.05 })], { stopReason: "toolUse" });
      timeoutObserved = JSON.stringify(shell).includes("timed out");
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "blocked", summary: "命令达到执行时限。", question: "是否调整执行时限？" })], { stopReason: "toolUse" });
    }));
    const hub = await openTestHub({ models, providerId: "timeout-test", config: { stateDir, watchdogMinutes: 0,
      model: { defaultProvider: "timeout-test", defaultModel: "test", thinkingLevel: "off" }, memory: { enabled: false } } });
    try {
      const ticket = await hub.dispatchTicket({ commandId: "timeout-command", title: "执行时限验证", goal: "运行受限时长的本地测试命令", scope: "测试目录" });
      const deadline = Date.now() + 10_000;
      while ((await hub.getBoardSnapshot()).tickets.find((entry) => entry.id === ticket.id)?.status !== "waiting") {
        if (Date.now() > deadline) throw new Error("Command did not reach a bounded waiting state");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const current = (await hub.harness.snapshot(KuloStateDoc))?.tickets[ticket.id];
      expect(timeoutObserved).toBe(true);
      expect(current).toMatchObject({ status: "waiting", latestReport: { state: "blocked" } });
      expect(current?.stoppedReason).toBeUndefined();
    } finally { await hub.close(); fs.rmSync(stateDir, { recursive: true, force: true }); }
  });
});
