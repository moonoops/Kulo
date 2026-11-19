import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { KuloHub, KuloStateDoc, type KuloHubConfigOverrides } from "@kulo/hub";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { processFingerprint } from "../packages/env/src/worker-supervisor.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];
const sandboxAvailable = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!sandboxAvailable)("project boot coordination", () => {
  it("resumes a durable Env wait without a live task when the local Env is already online at boot", async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-boot-")));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 24 }, () => (request) => request.tools?.some((tool) => tool.name === "kulo_report")
      ? fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "重启后的任务完成。" })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("任务完成。")])));
    const config: KuloHubConfigOverrides = {
      stateDir: path.join(directory, "hub-state"),
      localEnvRoot: path.join(directory, "env-runtime"),
      identityDir: path.join(directory, "private-identity"),
      authToken: HUB_TEST_ADMIN_TOKEN,
      maxConcurrentWorkers: 1,
      watchdogMinutes: 0,
      memory: { enabled: false } as KuloHubConfigOverrides["memory"],
      model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "off" },
    };
    let hub = await openTestHub({ config, models });
    cleanups.push(async () => { await hub.close(); });
    const workspaceDir = path.join(directory, "project");
    fs.mkdirSync(workspaceDir);
    const project = await hub.projects.create({ commandId: "boot-project", name: "Boot project", deviceId: "local", workspaceDir });
    const topic = await hub.createTopic("重启等待", context, project.id);
    const descriptor = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    const offline = vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => {
      const value = descriptor(id);
      return value && id === "local" ? { ...value, online: false } : value;
    });
    const card = await hub.dispatchTicket({
      commandId: "boot-waiting-task", title: "重启等待任务", goal: "完成持久化的原任务", scope: "项目目录", role: "coder",
      originConversationId: topic.conversationId,
    });
    const waitDeadline = Date.now() + 5_000;
    while (true) {
      const snapshot = await hub.harness.snapshot(KuloStateDoc, context);
      const ticket = snapshot?.tickets[card.id];
      if (ticket?.status === "waiting" && ticket.waiting?.reason === "env" && ticket.activeTaskId === undefined) break;
      if (Date.now() >= waitDeadline) throw new Error(`Task did not enter a durable Env wait: ${JSON.stringify(ticket)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const parked = await hub.harness.snapshot(KuloStateDoc, context);
    expect(parked?.slots.holders).not.toContain(card.id);
    await hub.close();
    offline.mockRestore();

    hub = await openTestHub({ config, models });
    expect(hub.envManager.getEnvDescriptor("local")?.online).toBe(true);
    const recovered = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
    expect(recovered?.runEpoch).toBeGreaterThan(parked!.tickets[card.id]!.runEpoch);
    expect(recovered?.waiting?.reason).not.toBe("env");
    const completionDeadline = Date.now() + 8_000;
    while (true) {
      const snapshot = await hub.harness.snapshot(KuloStateDoc, context);
      const ticket = snapshot?.tickets[card.id];
      if (ticket?.status === "ready") {
        expect(snapshot?.slots.holders).not.toContain(card.id);
        break;
      }
      if (ticket?.status === "failed" || Date.now() >= completionDeadline) {
        throw new Error(`Recovered task failed to finish: ${JSON.stringify(ticket)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it("fences a running collaboration tree and clears its old native process before continuing a new epoch", async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-running-boot-")));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    models.setProvider(faux.provider);
    let restarting = false;
    let childLoopActive = false;
    let childStage = 0;
    let nativePid = 0;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    cleanups.push(() => releaseResume());
    const processAlive = () => {
      if (!nativePid) return false;
      try { process.kill(nativePid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    const resumedRequests: Array<{ child: boolean; text: string; oldProcessAlive: boolean; oldProcessState: string; oldChildLoopActive: boolean }> = [];
    const report = () => fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "核对旧执行后继续完成。" })], { stopReason: "toolUse" });
    faux.setResponses(Array.from({ length: 32 }, () => async (request, options) => {
      const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
      const orchestrator = request.tools?.some((tool) => tool.name === "kulo_dispatch") || system.includes('"name":"kulo_dispatch"');
      if (orchestrator) return fauxAssistantMessage([fauxText("任务已完成。")]);
      const child = system.includes("# Subagent Mandate —");
      const text = request.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      if (restarting) {
        const alive = processAlive();
        resumedRequests.push({ child, text, oldProcessAlive: alive, oldProcessState: alive ? execFileSync("/bin/ps", ["-p", String(nativePid), "-o", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" }) : "", oldChildLoopActive: childLoopActive });
        if (child) return fauxAssistantMessage([fauxText("旧子任务不应独立恢复。")]);
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        await Promise.race([resumeGate, new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        })]);
        return report();
      }
      if (!child) return fauxAssistantMessage([fauxToolCall("kulo_subagent", { tasks: [{ name: "running-writer", role: "coder", goal: "启动受管写进程并等待后续指令" }] })], { stopReason: "toolUse" });
      if (childStage++ === 0) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "/bin/bash -c 'echo $$ > old-writer.pid; while :; do printf x >> old-writer.log; /bin/sleep 0.05; done' </dev/null >/dev/null 2>&1 &" })], { stopReason: "toolUse" });
      }
      childLoopActive = true;
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage([fauxText("旧协作已停止。")]);
      } finally { childLoopActive = false; }
    }));
    const config: KuloHubConfigOverrides = {
      stateDir: path.join(directory, "hub-state"), localEnvRoot: path.join(directory, "env-runtime"), identityDir: path.join(directory, "private-identity"),
      authToken: HUB_TEST_ADMIN_TOKEN, maxConcurrentWorkers: 1, watchdogMinutes: 0,
      memory: { enabled: false } as KuloHubConfigOverrides["memory"],
      model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "off" },
    };
    let hub = await openTestHub({ config, models });
    const closeOldEnvironment = hub.envManager.close.bind(hub.envManager);
    cleanups.push(closeOldEnvironment);
    cleanups.push(async () => { releaseResume(); await hub.close(); });
    const workspaceDir = path.join(directory, "project");
    fs.mkdirSync(workspaceDir);
    const project = await hub.projects.create({ commandId: "running-project", name: "Running project", deviceId: "local", workspaceDir });
    const card = await hub.dispatchTicket({ commandId: "running-before-restart", title: "运行态恢复", goal: "由子 Agent 持续写入并保留执行记录", scope: "项目目录", role: "coder", projectId: project.id });
    const until = async (check: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 6_000;
      while (!await check()) {
        if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify((await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id])}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    let pidFile = "";
    await until(async () => {
      const stagedCwd = (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.workspaceStaging?.stagedCwd;
      if (!stagedCwd) return false;
      pidFile = path.join(stagedCwd, "old-writer.pid");
      return childLoopActive && fs.existsSync(pidFile);
    }, "Child did not start its native process");
    expect(fs.existsSync(path.join(workspaceDir, "old-writer.pid"))).toBe(false);
    nativePid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(nativePid).toBeGreaterThan(0);
    expect(processAlive()).toBe(true);
    const nativeIdentity = processFingerprint(nativePid);
    cleanups.push(() => {
      if (!nativeIdentity || processFingerprint(nativePid) !== nativeIdentity) return;
      try { process.kill(nativePid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    });
    const before = (await hub.harness.snapshot(KuloStateDoc, context))!;
    const ticket = before.tickets[card.id]!;
    expect(ticket.status).toBe("running");
    expect(before.slots.holders).toEqual([card.id]);
    expect(before.slots.writeHolders).toContain(card.id);
    expect(Object.values(before.subagents ?? {}).filter((sub) => sub.ticketId === card.id)).toContainEqual(expect.objectContaining({ state: "running" }));

    // Preserve an actual supervisor so boot, rather than graceful Env shutdown, must clear the old execution.
    const keepOldExecution = vi.spyOn(hub.envManager, "close").mockResolvedValue();
    await hub.close();
    keepOldExecution.mockRestore();
    expect(childLoopActive).toBe(false);
    expect(processAlive()).toBe(true);
    restarting = true;
    hub = await openTestHub({ config, models });
    await until(() => resumedRequests.some((request) => !request.child), "New epoch did not reach the model");
    expect(resumedRequests.every((request) => !request.child && !request.oldProcessAlive && !request.oldChildLoopActive), JSON.stringify(resumedRequests)).toBe(true);
    expect(resumedRequests[0]?.text).toContain("Wait condition satisfied");
    expect(resumedRequests[0]?.text).toContain("workspace file changes");
    expect(resumedRequests[0]?.text).toContain("unconfirmed tool results");
    expect(processAlive()).toBe(false);
    const continuing = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(continuing.tickets[card.id]).toMatchObject({ status: "running", cleanupPending: false });
    expect(continuing.tickets[card.id]!.runEpoch).toBeGreaterThan(ticket.runEpoch);
    expect(continuing.slots.holders).toEqual([card.id]);
    expect(continuing.slots.writeHolders).toContain(card.id);
    expect(Object.values(continuing.subagents ?? {}).filter((sub) => sub.ticketId === card.id).every((sub) => sub.state !== "running")).toBe(true);
    releaseResume();
    await until(async () => (await hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.status === "ready", "Recovered run did not finish");
    const finished = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(finished.slots.holders).not.toContain(card.id);
    expect(finished.tickets[card.id]?.workspaceStaging?.stagedDiff?.hasChanges).toBe(true);
    expect(finished.slots.writeHolders).toContain(card.id);
    await hub.closeTicket({ commandId: "discard-boot-staged", ticketId: card.id, kind: "obsolete", reason: "测试丢弃未合入变更" });
    const afterDiscard = (await hub.harness.snapshot(KuloStateDoc, context))!;
    expect(afterDiscard.slots.writeHolders).not.toContain(card.id);
    expect(fs.existsSync(path.join(workspaceDir, "old-writer.pid"))).toBe(false);
  });
});
