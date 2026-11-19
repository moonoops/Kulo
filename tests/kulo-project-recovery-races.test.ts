import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { KuloEnvAgent } from "@kulo/env";
import { KuloHub, KuloStateDoc, startKuloHubServer, type KuloHubConfigOverrides } from "@kulo/hub";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const context = BACKGROUND_CONTEXT;
const sandboxAvailable = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const cleanups: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Project recovery condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function isOrchestrator(request: TranscriptContext): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === "kulo_dispatch")) || request.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) &&
    message.toolsAdded.some((tool) => tool.name === "kulo_dispatch"),
  );
}

function userText(request: TranscriptContext): string {
  return request.messages.filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}

const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (summary = "恢复后的任务已完成") => tool("kulo_report", { state: "ready", summary });
type Respond = (request: TranscriptContext) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;

async function fixture(respond: Respond, overrides: KuloHubConfigOverrides = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-recovery-races-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  models.setProvider(faux.provider);
  const workerRequests: string[] = [];
  faux.setResponses(Array.from({ length: 96 }, () => async (request) => {
    if (isOrchestrator(request)) return fauxAssistantMessage([fauxText("收到任务状态。")]);
    workerRequests.push(userText(request));
    return respond(request);
  }));
  const config: KuloHubConfigOverrides = {
    stateDir: path.join(directory, "hub-state"),
    localEnvRoot: path.join(directory, "local-runtime"),
    identityDir: path.join(directory, "private-identity"),
    authToken: HUB_TEST_ADMIN_TOKEN,
    maxConcurrentWorkers: 1,
    watchdogMinutes: 0,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "off" },
    ...overrides,
  };
  const hub = await openTestHub({ config, models });
  cleanups.push(() => hub.close());
  const project = async (name: string, deviceId = "local") => {
    const workspaceDir = path.join(directory, "projects", name);
    fs.mkdirSync(workspaceDir, { recursive: true });
    return hub.projects.create({ commandId: `create:${deviceId}:${name}`, name, deviceId, workspaceDir });
  };
  const ticket = async (id: string) => (await hub.inspectTicketDetail(id)).ticket;
  const waitForTicket = async (id: string, status: string) => {
    try {
      await until(async () => {
        const value = await ticket(id);
        if (value.status === "failed" && status !== "failed") throw new Error(`Task failed: ${JSON.stringify(value.latestReport)}`);
        return value.status === status;
      });
    } catch (error) {
      throw new Error(JSON.stringify({ expected: status, ticket: await ticket(id), workerRequests }, null, 2), { cause: error });
    }
  };
  return { hub, directory, project, ticket, waitForTicket, workerRequests };
}

describe.skipIf(!sandboxAvailable)("project recovery races with a real Hub", () => {
  it("consumes a user reply submitted while pause cleanup is gated exactly once", async () => {
    let workerTurns = 0;
    const f = await fixture(() => workerTurns++ === 0
      ? tool("kulo_wait", { reason: "user", detail: "是否继续恢复竞态任务？" })
      : report());
    const project = await f.project("reply-during-pause");
    const cleanupGate = gate();
    cleanups.push(cleanupGate.release);
    const release = f.hub.envManager.releaseWorkerExecutionEnv.bind(f.hub.envManager);
    let gateCleanup = true;
    vi.spyOn(f.hub.envManager, "releaseWorkerExecutionEnv").mockImplementation(async (...args) => {
      const result = await release(...args);
      if (gateCleanup && args[0] === "local" && args[1] === project.workspaceDir) await cleanupGate.promise;
      return result;
    });
    const card = await f.hub.dispatchTicket({
      commandId: "reply-during-pause", title: "暂停中回复", goal: "等待用户确认后继续一次", scope: "project", projectId: project.id,
    });
    await f.waitForTicket(card.id, "pausing");
    const paused = await f.ticket(card.id);
    expect(paused.waiting?.reason).toBe("user");
    await f.hub.steerTicket({ commandId: "pause-reply-once", ticketId: card.id, text: "resume-confirmation-needle：同意继续" });
    gateCleanup = false;
    cleanupGate.release();

    await f.waitForTicket(card.id, "ready");
    await f.hub.rootConversation.waitForIdle(context);
    const final = await f.ticket(card.id);
    expect(final.waiting).toBeUndefined();
    expect(final.resumePrompt).toBeUndefined();
    expect(workerTurns).toBe(2);
    expect(f.workerRequests.filter((request) => request.includes("resume-confirmation-needle"))).toHaveLength(1);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("resumes project B when project A's directory disappeared while their Env was offline", async () => {
    const f = await fixture(() => report(), {
      enableLocalEnv: false,
      envTokens: { remote: "test-project-recovery-node" },
      workerEnvIds: ["remote"],
    });
    const server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    const remote = new KuloEnvAgent({
      hubUrl: server.envWsUrl, envId: "remote", rootDir: path.join(f.directory, "remote-runtime"),
      authToken: "test-project-recovery-node", reconnect: false,
    });
    cleanups.push(() => remote.stop());
    await remote.start();
    const projectA = await f.project("unavailable-A", "remote");
    const projectB = await f.project("available-B", "remote");
    await remote.stop();
    await until(() => !f.hub.envManager.getEnvDescriptor("remote")?.online);
    const a = await f.hub.dispatchTicket({ commandId: "offline-A", title: "offline-A", goal: "恢复项目 A", scope: "project", projectId: projectA.id });
    const b = await f.hub.dispatchTicket({ commandId: "offline-B", title: "offline-B", goal: "恢复项目 B", scope: "project", projectId: projectB.id });
    await f.waitForTicket(a.id, "waiting");
    await f.waitForTicket(b.id, "waiting");
    expect(f.workerRequests).toHaveLength(0);
    fs.renameSync(projectA.workspaceDir, `${projectA.workspaceDir}-moved`);

    await remote.start();
    await f.waitForTicket(b.id, "ready");
    expect((await f.ticket(a.id)).status).toBe("waiting");
    expect((await f.hub.projects.list()).find((value) => value.id === projectA.id)?.availability).toBe("unavailable");
    expect(f.workerRequests).toHaveLength(1);
    expect((await f.ticket(b.id)).workspaceDir).toBe(projectB.workspaceDir);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("releases a parked Worker's slot but retains its write reservation when Env cleanup throws", async () => {
    const f = await fixture((request) => userText(request).includes("cleanup-throw-wait") && !userText(request).includes("cleanup-retry-needle")
      ? tool("kulo_wait", { reason: "user", detail: "等待用户确认清理失败后的下一步" })
      : report());
    const project = await f.project("cleanup-throw");
    const otherProject = await f.project("cleanup-independent");
    const release = f.hub.envManager.releaseWorkerExecutionEnv.bind(f.hub.envManager);
    let cleanupAttempts = 0;
    const cleanupSpy = vi.spyOn(f.hub.envManager, "releaseWorkerExecutionEnv").mockImplementation(async (...args) => {
      if (args[0] === "local" && (args[1] === project.workspaceDir || args[1].includes(`${path.sep}staged${path.sep}`))) {
        cleanupAttempts++;
        throw new Error("simulated cleanup transport failure");
      }
      return release(...args);
    });
    const card = await f.hub.dispatchTicket({
      commandId: "cleanup-throw-wait", title: "cleanup-throw-wait", goal: "等待用户确认", scope: "project", projectId: project.id,
    });
    await f.waitForTicket(card.id, "waiting");
    const worker = await f.hub.harness.conversation((await f.ticket(card.id)).workerConversationId as ConversationId, context);
    expect(worker).toBeDefined();
    await worker!.waitForIdle(context);
    const parked = await f.hub.harness.snapshot(KuloStateDoc, context);
    expect(cleanupAttempts).toBeGreaterThan(0);
    expect(parked?.tickets[card.id]).toMatchObject({ status: "waiting", cleanupPending: true, waiting: { reason: "user" } });
    expect(parked?.slots.holders).not.toContain(card.id);
    expect(parked?.slots.writeHolders).toContain(card.id);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);

    const sameProject = await f.hub.dispatchTicket({ commandId: "cleanup-same-project", title: "同项目后续写任务", goal: "等待旧写进程清理", scope: "project", projectId: project.id });
    const independent = await f.hub.dispatchTicket({ commandId: "cleanup-other-project", title: "其他项目可继续", goal: "完成独立项目任务", scope: "project", projectId: otherProject.id });
    await f.waitForTicket(independent.id, "ready");
    expect((await f.ticket(sameProject.id)).status).toBe("queued");
    expect((await f.hub.harness.snapshot(KuloStateDoc, context))?.slots.writeHolders).toContain(card.id);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);

    cleanupSpy.mockImplementation(release);
    await f.hub.steerTicket({ commandId: "cleanup-explicit-retry", ticketId: card.id, text: "cleanup-retry-needle：重试清理并继续" });
    await f.waitForTicket(sameProject.id, "ready");
    await f.waitForTicket(card.id, "ready");
    expect((await f.ticket(card.id)).cleanupPending).toBe(false);
    expect(f.workerRequests.filter((request) => request.includes("cleanup-retry-needle"))).toHaveLength(1);
    expect((await f.hub.harness.snapshot(KuloStateDoc, context))?.slots.writeHolders).not.toContain(card.id);
  });

  it("retries cleanup for a completed ticket and unlocks its next writer without an Env event", async () => {
    const f = await fixture(() => report());
    const project = await f.project("terminal-cleanup-retry");
    const release = f.hub.envManager.releaseWorkerExecutionEnv.bind(f.hub.envManager);
    let cleanupStillPending = true;
    let cleanupAttempts = 0;
    vi.spyOn(f.hub.envManager, "releaseWorkerExecutionEnv").mockImplementation(async (...args) => {
      const result = await release(...args);
      if (args[0] === "local" && (args[1] === project.workspaceDir || args[1].includes(`${path.sep}staged${path.sep}`))) {
        cleanupAttempts++;
        return { cleanupPending: cleanupStillPending || result.cleanupPending };
      }
      return result;
    });
    const first = await f.hub.dispatchTicket({
      commandId: "terminal-cleanup-first", title: "清理尚未完成的已完成任务", goal: "先完成模型工作", scope: "project", projectId: project.id,
    });
    await f.waitForTicket(first.id, "ready");
    const pending = await f.hub.harness.snapshot(KuloStateDoc, context);
    expect(pending?.tickets[first.id]).toMatchObject({ status: "ready", cleanupPending: true });
    expect(pending?.slots.holders).not.toContain(first.id);
    expect(pending?.slots.writeHolders).toContain(first.id);
    expect(f.workerRequests).toHaveLength(1);

    const next = await f.hub.dispatchTicket({
      commandId: "terminal-cleanup-next", title: "同目录下一项写任务", goal: "等待旧进程清理后执行", scope: "project", projectId: project.id,
    });
    expect((await f.ticket(next.id)).status).toBe("queued");
    const attemptsBeforeConfirmation = cleanupAttempts;
    // Only the simulated process state changes: no device event, restart, steer, or project edit wakes reconciliation.
    cleanupStillPending = false;

    await f.waitForTicket(next.id, "ready");
    const settled = await f.hub.harness.snapshot(KuloStateDoc, context);
    expect(cleanupAttempts).toBeGreaterThan(attemptsBeforeConfirmation);
    expect(settled?.tickets[first.id]).toMatchObject({ status: "ready", cleanupPending: false });
    expect(settled?.slots.writeHolders).not.toContain(first.id);
    expect(f.workerRequests).toHaveLength(2);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });
});
