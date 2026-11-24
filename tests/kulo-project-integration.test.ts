import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { KuloEnvAgent } from "@kulo/env";
import { KuloHub, KuloStateDoc, startKuloHubServer, type KuloHubConfigOverrides } from "@kulo/hub";
import type { ProjectView } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];
const sandboxAvailable = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
type ModelRequest = { orchestrator: boolean; text: string };
const requestsByHub = new WeakMap<KuloHub, ModelRequest[]>();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => Promise<boolean> | boolean, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Project integration condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForTicket(hub: KuloHub, id: string, expected: string): Promise<void> {
  try {
    await until(async () => {
      const detail = await hub.inspectTicketDetail(id);
      if (detail.ticket.status === "failed" && expected !== "failed") {
        throw new Error(`Project ticket failed before ${expected}`);
      }
      return detail.ticket.status === expected;
    });
  } catch (error) {
    const { ticket, live } = await hub.inspectTicketDetail(id);
    throw new Error(JSON.stringify({
      expected,
      status: ticket.status,
      waiting: ticket.waiting,
      latestReport: ticket.latestReport,
      live,
      requests: requestsByHub.get(hub),
    }, null, 2), { cause: error });
  }
}

function isOrchestrator(ctx: TranscriptContext): boolean {
  return Boolean(ctx.tools?.some((tool) => tool.name === "kulo_dispatch")) || ctx.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) &&
    message.toolsAdded.some((tool) => tool.name === "kulo_dispatch"),
  );
}

function userText(ctx: TranscriptContext): string {
  return ctx.messages.filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}

function tool(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

const report = (summary = "任务完成") => tool("kulo_report", { state: "ready", summary });
type Respond = (ctx: TranscriptContext, options: unknown) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;

async function fixture(respond: Respond, overrides: KuloHubConfigOverrides = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-integration-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelRequest[] = [];
  faux.setResponses(Array.from({ length: 96 }, () => async (ctx, options) => {
    const orchestrator = isOrchestrator(ctx);
    requests.push({ orchestrator, text: userText(ctx) });
    return orchestrator ? fauxAssistantMessage([fauxText("收到任务结果。")]) : respond(ctx, options);
  }));
  const config: KuloHubConfigOverrides = {
    stateDir: path.join(directory, "hub-state"),
    localEnvRoot: path.join(directory, "local-runtime"),
    identityDir: path.join(directory, "private-identity"),
    authToken: HUB_TEST_ADMIN_TOKEN,
    maxConcurrentWorkers: 2,
    watchdogMinutes: 0,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "off" },
    ...overrides,
  };
  let hub = await openTestHub({ config, models });
  requestsByHub.set(hub, requests);
  cleanups.push(async () => { await hub.close(); });
  const open = async () => {
    hub = await openTestHub({ config, models });
    requestsByHub.set(hub, requests);
    return hub;
  };
  const close = async () => { await hub.close(); };
  const project = async (name: string, deviceId = "local"): Promise<ProjectView> => {
    const workspaceDir = path.join(directory, "projects", name);
    fs.mkdirSync(workspaceDir, { recursive: true });
    return hub.projects.create({ commandId: `create:${deviceId}:${name}`, name, deviceId, workspaceDir });
  };
  return { directory, config, models, requests, project, open, close, get hub() { return hub; } };
}

describe.skipIf(!sandboxAvailable)("Hub project integration with native temporary Envs", () => {
  it("creates project conversations and binds both project and explicit ordinary-topic work to the authorized directory", async () => {
    const stages = new Map<string, number>();
    const f = await fixture((ctx) => {
      const ordinary = userText(ctx).includes("ORDINARY-WRITE");
      const key = ordinary ? "ordinary" : "project";
      const stage = stages.get(key) ?? 0;
      stages.set(key, stage + 1);
      return stage === 0 ? tool("write", { path: `${key}.txt`, content: `${key} result\n` }) : report();
    });
    const project = await f.project("project-owned-files");
    expect(project.workspaceDir.startsWith(f.config.localEnvRoot!)).toBe(false);
    const topic = await f.hub.createTopic("项目会话", context, project.id);
    const card = await f.hub.dispatchTicket({
      commandId: "project-conversation-work", title: "PROJECT-WRITE", goal: "PROJECT-WRITE", scope: "项目目录", role: "coder",
      originConversationId: topic.conversationId, workspaceMode: "staged",
    });
    expect(card).toMatchObject({ projectId: project.id, envId: "local", workspaceDir: project.workspaceDir });
    await waitForTicket(f.hub, card.id, "ready");
    expect(fs.existsSync(path.join(project.workspaceDir, "project.txt"))).toBe(false);
    await f.hub.applyStagedChanges({ commandId: "apply-project-write", ticketId: card.id });
    expect(fs.readFileSync(path.join(project.workspaceDir, "project.txt"), "utf8")).toBe("project result\n");

    const ordinary = await f.hub.createTopic("普通话题", context);
    const explicit = await f.hub.dispatchTicket({
      commandId: "ordinary-explicit-project-work", title: "ORDINARY-WRITE", goal: "ORDINARY-WRITE", scope: "项目目录", role: "coder",
      originConversationId: ordinary.conversationId, projectId: project.id, workspaceMode: "staged",
    });
    await waitForTicket(f.hub, explicit.id, "ready");
    expect(fs.existsSync(path.join(project.workspaceDir, "ordinary.txt"))).toBe(false);
    await f.hub.applyStagedChanges({ commandId: "apply-ordinary-write", ticketId: explicit.id });
    expect(fs.readFileSync(path.join(project.workspaceDir, "ordinary.txt"), "utf8")).toBe("ordinary result\n");
    expect((await f.hub.listTopics()).find((item) => item.id === ordinary.id)?.projectId ?? null).toBeNull();
    expect((await f.hub.listTopics()).find((item) => item.id === topic.id)?.projectId).toBe(project.id);
    const detail = await f.hub.inspectTicketDetail(card.id);
    expect(detail.ticket).toMatchObject({ projectId: project.id, directoryId: project.directoryId, grantRevision: project.grantRevision });
    expect(detail.ticket.scratchDir?.startsWith(project.workspaceDir)).toBe(false);
    await expect(f.hub.dispatchTicket({
      commandId: "conflicting-device", title: "conflict", goal: "conflict", scope: "project", projectId: project.id, envId: "other-device",
    })).rejects.toMatchObject({ code: "project_binding_conflict" });
    await expect(f.hub.dispatchTicket({
      commandId: "conflicting-directory", title: "conflict", goal: "conflict", scope: "project", projectId: project.id, workspaceDir: f.directory,
    })).rejects.toMatchObject({ code: "project_binding_conflict" });
  });

  it("keeps an offline project ticket across Hub restart, tolerates metadata edits, and resumes on the same device", async () => {
    let stage = 0;
    const f = await fixture(() => stage++ === 0
      ? tool("write", { path: "resumed.txt", content: "same remote project\n" }) : report(), {
      enableLocalEnv: false, envTokens: { remote: "test-remote-project-node" }, workerEnvIds: ["remote"],
    });
    const remoteRoot = path.join(f.directory, "remote-runtime");
    let server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    let remote = new KuloEnvAgent({ hubUrl: server.envWsUrl, envId: "remote", rootDir: remoteRoot, authToken: "test-remote-project-node", reconnect: false });
    cleanups.push(async () => { await server.close(); });
    cleanups.push(async () => { await remote.stop(); });
    await remote.start();
    const project = await f.project("remote-project", "remote");
    const topic = await f.hub.createTopic("远端项目会话", context, project.id);
    await remote.stop();
    await until(() => !f.hub.envManager.getEnvDescriptor("remote")?.online);
    const card = await f.hub.dispatchTicket({
      commandId: "offline-project-task", title: "离线设备任务", goal: "恢复后写入文件", scope: "项目目录", role: "coder", originConversationId: topic.conversationId, workspaceMode: "staged",
    });
    await waitForTicket(f.hub, card.id, "waiting");
    const waiting = await f.hub.inspectTicketDetail(card.id);
    expect(waiting.ticket.waiting?.reason).toBe("env");
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    expect(f.requests.filter((request) => !request.orchestrator)).toHaveLength(0);
    const renamed = await f.hub.projects.patch(project.id, { name: "重命名的项目", notes: "新说明", expectedRevision: project.revision });
    expect(renamed.grantRevision).toBe(project.grantRevision);
    await server.close();
    await f.close();
    await f.open();
    expect((await f.hub.projects.get(project.id)).name).toBe("重命名的项目");
    expect((await f.hub.inspectTicketDetail(card.id)).ticket.status).toBe("waiting");
    server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    remote = new KuloEnvAgent({ hubUrl: server.envWsUrl, envId: "remote", rootDir: remoteRoot, authToken: "test-remote-project-node", reconnect: false });
    await remote.start();
    await waitForTicket(f.hub, card.id, "ready");
    const resumed = await f.hub.inspectTicketDetail(card.id);
    expect(resumed.ticket).toMatchObject({ projectId: project.id, envId: "remote", workspaceDir: project.workspaceDir, directoryId: project.directoryId, grantRevision: project.grantRevision });
    expect(resumed.ticket.runEpoch).toBeGreaterThanOrEqual(waiting.ticket.runEpoch);
    expect(fs.existsSync(path.join(project.workspaceDir, "resumed.txt"))).toBe(false);
    await f.hub.applyStagedChanges({ commandId: "apply-remote-resumed-write", ticketId: card.id });
    expect(fs.readFileSync(path.join(project.workspaceDir, "resumed.txt"), "utf8")).toBe("same remote project\n");
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("runs kulo_wait as a durable timed pause and resumes the same conversation after restart", async () => {
    let stage = 0;
    let deadline = 0;
    let resumedAt = 0;
    const f = await fixture(() => {
      if (stage++ === 0) {
        deadline = Date.now() + 900;
        return tool("kulo_wait", { reason: "time", detail: "等待定时条件", until: new Date(deadline).toISOString() });
      }
      resumedAt = Date.now();
      return report("定时任务已继续");
    });
    const project = await f.project("timed-project");
    const topic = await f.hub.createTopic("定时会话", context, project.id);
    const card = await f.hub.dispatchTicket({ commandId: "timed-wait", title: "定时恢复", goal: "等待后继续", scope: "项目目录", originConversationId: topic.conversationId });
    await waitForTicket(f.hub, card.id, "waiting");
    const before = await f.hub.inspectTicketDetail(card.id);
    expect(before.ticket.waiting?.reason).toBe("time");
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    await f.close();
    await f.open();
    await waitForTicket(f.hub, card.id, "ready");
    const after = await f.hub.inspectTicketDetail(card.id);
    expect(after.ticket.workerConversationId).toBe(before.ticket.workerConversationId);
    expect(after.ticket.runEpoch).toBeGreaterThan(before.ticket.runEpoch);
    expect(resumedAt).toBeGreaterThanOrEqual(deadline);
    expect(stage).toBe(2);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("resumes a due timed wait once an Env change confirms previously pending process cleanup", async () => {
    let workerTurns = 0;
    let deadline = 0;
    let cleanupBlocked = true;
    let cleanupAttempts = 0;
    const f = await fixture(() => {
      if (workerTurns++ === 0) {
        deadline = Date.now() + 350;
        return tool("kulo_wait", { reason: "time", detail: "等待清理后继续", until: new Date(deadline).toISOString() });
      }
      return report("清理已确认并继续");
    }, { envTokens: { observer: "test-cleanup-observer-node" } });
    const project = await f.project("timed-cleanup-project");
    const release = f.hub.envManager.releaseWorkerExecutionEnv.bind(f.hub.envManager);
    const cleanup = vi.spyOn(f.hub.envManager, "releaseWorkerExecutionEnv").mockImplementation(async (...args) => {
      const result = await release(...args);
      if (args[0] === "local" && (args[1] === project.workspaceDir || args[1].includes(`${path.sep}staged${path.sep}`))) {
        cleanupAttempts++;
        return { cleanupPending: cleanupBlocked || result.cleanupPending };
      }
      return result;
    });
    cleanups.push(() => cleanup.mockRestore());
    const card = await f.hub.dispatchTicket({ commandId: "timed-cleanup", title: "等待清理", goal: "定时恢复并核对清理", scope: "project", projectId: project.id });
    await waitForTicket(f.hub, card.id, "waiting");
    const parked = (await f.hub.inspectTicketDetail(card.id)).ticket;
    expect(parked).toMatchObject({ cleanupPending: true, waiting: { reason: "time", until: deadline } });
    expect(parked.activeTaskId).toBeDefined();
    await until(async () => (await f.hub.harness.commit((tx) => tx.task(parked.activeTaskId as never), context))?.state.status === "terminal");
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect((await f.hub.inspectTicketDetail(card.id)).ticket).toMatchObject({ status: "waiting", cleanupPending: true, waiting: { reason: "time" } });
    expect(workerTurns).toBe(1);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    expect((await f.hub.harness.snapshot(KuloStateDoc, context))?.slots.writeHolders).toContain(card.id);
    const attemptsBeforeConfirmation = cleanupAttempts;

    cleanupBlocked = false;
    const server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    const observer = new KuloEnvAgent({ hubUrl: server.envWsUrl, envId: "observer", rootDir: path.join(f.directory, "observer-env"), authToken: "test-cleanup-observer-node", reconnect: false });
    cleanups.push(() => observer.stop());
    await observer.start();
    await waitForTicket(f.hub, card.id, "ready");
    const resumed = (await f.hub.inspectTicketDetail(card.id)).ticket;
    expect(cleanupAttempts).toBeGreaterThan(attemptsBeforeConfirmation);
    expect(resumed.runEpoch).toBe(parked.runEpoch + 1);
    expect(resumed.cleanupPending).toBe(false);
    expect(resumed.waiting).toBeUndefined();
    expect(workerTurns).toBe(2);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
    expect((await f.hub.harness.snapshot(KuloStateDoc, context))?.slots.writeHolders).not.toContain(card.id);
  });

  it("retains the parent's single Worker slot while its separately counted subagent is active", async () => {
    let finishChild!: () => void;
    let childStarted = false;
    let nextStarted = false;
    let parentStage = 0;
    const childGate = new Promise<void>((resolve) => { finishChild = resolve; });
    const f = await fixture(async (ctx, options) => {
      if (JSON.stringify(ctx.messages.filter((message) => message.role === "system")).includes("# Subagent Mandate —")) {
        childStarted = true;
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        await Promise.race([childGate, new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        })]);
        return fauxAssistantMessage([fauxText("子任务完成")]);
      }
      if (userText(ctx).includes("PARENT-GOAL")) {
        return parentStage++ === 0 ? tool("kulo_subagent", { tasks: [{ name: "held-scout", role: "scout", goal: "SUBAGENT-GOAL" }] }) : report();
      }
      nextStarted = true;
      return report();
    }, { maxConcurrentWorkers: 1, maxSubagentsPerTicket: 2 });
    cleanups.push(() => finishChild());
    const project = await f.project("parent-project");
    const parent = await f.hub.dispatchTicket({ commandId: "parent", title: "父任务", goal: "PARENT-GOAL", scope: "project", role: "architect", projectId: project.id });
    await until(() => childStarted);
    const next = await f.hub.dispatchTicket({ commandId: "next", title: "后续任务", goal: "NEXT-GOAL", scope: "project", role: "coder", projectId: project.id });
    const live = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(live.tickets[parent.id]?.status).toBe("running");
    expect(Object.values(live.subagents ?? {}).find((subagent) => subagent.ticketId === parent.id)?.state).toBe("running");
    expect(live.slots.holders).toEqual([parent.id]);
    expect((await f.hub.getBoardSnapshot()).slots).toMatchObject({ used: 1, max: 1 });
    expect(nextStarted).toBe(false);
    expect((await f.hub.inspectTicketDetail(next.id)).ticket.status).toBe("queued");
    finishChild();
    await waitForTicket(f.hub, next.id, "ready");
    expect((await f.hub.inspectTicketDetail(parent.id)).ticket.status).toBe("ready");
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("serializes writable teammates while read-only teammates run together within one parent Worker slot", async () => {
    const names = ["write-one", "write-two", "read-one", "read-two"] as const;
    const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
    for (const name of names) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      gates.set(name, { promise, release });
    }
    const started = new Set<string>();
    const active = new Set<string>();
    let maxWriters = 0;
    let maxReaders = 0;
    let parentStage = 0;
    const f = await fixture(async (ctx, options) => {
      const isChild = JSON.stringify(ctx.messages.filter((message) => message.role === "system")).includes("# Subagent Mandate —");
      if (!isChild) {
        return parentStage++ === 0 ? tool("kulo_subagent", {
          tasks: names.map((name) => ({ name, goal: `GOAL:${name}`, role: name.startsWith("write") ? "coder" : "scout", scope: `src/${name}/**` })),
        }) : report("协作完成");
      }
      const name = names.find((candidate) => userText(ctx).includes(`GOAL:${candidate}`));
      if (!name) throw new Error("Unexpected teammate prompt");
      started.add(name);
      active.add(name);
      maxWriters = Math.max(maxWriters, [...active].filter((item) => item.startsWith("write")).length);
      maxReaders = Math.max(maxReaders, [...active].filter((item) => item.startsWith("read")).length);
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      try {
        await Promise.race([gates.get(name)!.promise, new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        })]);
        return fauxAssistantMessage([fauxText(`${name} 完成`)]);
      } finally { active.delete(name); }
    }, { maxConcurrentWorkers: 1, maxSubagentsPerTicket: 4 });
    cleanups.push(() => { for (const gate of gates.values()) gate.release(); });
    const project = await f.project("teammate-serialization");
    const parent = await f.hub.dispatchTicket({ commandId: "batch-serialization", title: "协作并发", goal: "BATCH-PARENT", scope: "project", role: "architect", projectId: project.id });
    await until(() => ["write-one", "read-one", "read-two"].every((name) => started.has(name)));
    expect(started.has("write-two")).toBe(false);
    const state = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    const children = Object.values(state.subagents ?? {}).filter((child) => child.ticketId === parent.id);
    expect(children.find((child) => child.name === "write-two")?.state).toBe("queued");
    expect(children.filter((child) => child.state === "running")).toHaveLength(3);
    expect(state.slots.holders).toEqual([parent.id]);
    expect(state.slots.writeHolders).toEqual([parent.id]);
    expect(maxReaders).toBe(2);
    expect((await f.hub.getBoardSnapshot()).slots).toMatchObject({ used: 1, max: 1 });

    gates.get("write-one")!.release();
    await until(() => started.has("write-two"));
    expect(active.has("write-one")).toBe(false);
    expect(active.has("read-one") && active.has("read-two")).toBe(true);
    expect(maxWriters).toBe(1);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(1);
    for (const gate of gates.values()) gate.release();
    await waitForTicket(f.hub, parent.id, "ready");
    expect(started.size).toBe(4);
    expect(maxWriters).toBe(1);
    expect((await f.hub.getBoardSnapshot()).slots.used).toBe(0);
  });

  it("soft-deletes and restores metadata while keeping files and stopped work from restarting", async () => {
    let workerRequests = 0;
    const f = await fixture(() => {
      workerRequests++;
      return tool("kulo_wait", { reason: "user", detail: "需要用户确认后再继续" });
    });
    const project = await f.project("delete-restore-project");
    const keep = path.join(project.workspaceDir, "keep.txt");
    fs.writeFileSync(keep, "existing work");
    const topic = await f.hub.createTopic("待确认会话", context, project.id);
    const card = await f.hub.dispatchTicket({ commandId: "delete-waiting", title: "待确认任务", goal: "等待用户", scope: "project", originConversationId: topic.conversationId });
    await waitForTicket(f.hub, card.id, "waiting");
    await expect(f.hub.projects.remove(project.id)).rejects.toMatchObject({ code: "project_tasks_running" });
    await f.hub.projects.remove(project.id, { stopTasks: true });
    expect(await f.hub.projects.list()).toHaveLength(0);
    expect((await f.hub.listTopics()).some((item) => item.id === topic.id)).toBe(false);
    expect((await f.hub.inspectTicketDetail(card.id)).ticket.status).toBe("stopped");
    expect(fs.readFileSync(keep, "utf8")).toBe("existing work");
    const restored = await f.hub.projects.restore(project.id);
    expect(restored.id).toBe(project.id);
    expect((await f.hub.listTopics()).find((item) => item.id === topic.id)?.projectId).toBe(project.id);
    await f.close();
    await f.open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await f.hub.inspectTicketDetail(card.id)).ticket.status).toBe("stopped");
    expect(workerRequests).toBe(1);
    await expect(f.hub.steerTicket({ commandId: "late-confirmation", ticketId: card.id, text: "继续" })).rejects.toThrow(/stopped|closed/i);
    expect(fs.readFileSync(keep, "utf8")).toBe("existing work");
  });
});
