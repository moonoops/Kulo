import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { KuloHub, KuloStateDoc, type KuloHubConfigOverrides } from "@kulo/hub";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<unknown> | unknown> = [];
type ToolResult = Extract<TranscriptContext["messages"][number], { role: "toolResult" }>;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = (text = "已完成项目资料操作。") => fauxAssistantMessage([fauxText(text)]);
const resultText = (result: ToolResult) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-offline-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
  models.setProvider(faux.provider);
  const requests: TranscriptContext[] = [];
  let responses: ReturnType<typeof answer>[] = [];
  faux.setResponses(Array.from({ length: 64 }, () => (request) => {
    requests.push(request);
    return responses.shift() ?? answer();
  }));
  const config: KuloHubConfigOverrides = {
    stateDir: path.join(directory, "hub-state"), localEnvRoot: path.join(directory, "hub-default"),
    identityDir: path.join(directory, "private-identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    maxConcurrentWorkers: 1, watchdogMinutes: 0,
    memory: { enabled: false } as KuloHubConfigOverrides["memory"],
    model: { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "off" },
  };
  let hub = await openTestHub({ config, models });
  cleanups.push(async () => { await hub.close(); });
  const send = async (topicId: string, text: string, next: ReturnType<typeof answer>[] = [answer()]) => {
    responses = [...next];
    const submission = await hub.sendUserMessage(text, { topicId });
    expect((await submission.wait(context)).status).toBe("done");
    expect(responses).toHaveLength(0);
  };
  const results = async (conversationId: number) => {
    const conversation = await hub.harness.conversation(conversationId as ConversationId, context);
    if (!conversation) throw new Error("Expected the project conversation to remain available");
    return (await conversation.context(context)).messages.filter((message): message is ToolResult => message.role === "toolResult");
  };
  return {
    directory, config, requests, send, results, get hub() { return hub; },
    close: () => hub.close(),
    reopen: async () => { hub = await openTestHub({ config, models }); return hub; },
  };
}

describe("project conversations when their execution location is unavailable", () => {
  it.each(["offline", "directory-unavailable"] as const)("keeps Hub project tools usable for %s projects without falling back to Hub files", async (unavailable) => {
    const f = await fixture();
    const workspaceDir = path.join(f.directory, "project");
    fs.mkdirSync(workspaceDir);
    const fileName = "project-boundary.txt";
    const hubCanary = "HUB_DEFAULT_DIRECTORY_MUST_NOT_BE_READ";
    fs.writeFileSync(path.join(f.config.localEnvRoot!, fileName), hubCanary);
    fs.writeFileSync(path.join(workspaceDir, fileName), "Project-owned content");
    const project = await f.hub.projects.create({ commandId: "create-project", name: "Unavailable project", deviceId: "local", workspaceDir });
    const history = await f.hub.createTopic("项目旧会话", context, project.id);
    const topic = await f.hub.createTopic("项目管理会话", context, project.id);
    const other = await f.hub.createTopic("普通话题", context);
    await f.send(history.id, "offline-history-needle 同项目历史保留。", [answer("同项目的已确认方案。")]);
    await f.send(other.id, "offline-history-needle unrelated ordinary history");

    if (unavailable === "offline") {
      const descriptor = f.hub.envManager.getEnvDescriptor.bind(f.hub.envManager);
      vi.spyOn(f.hub.envManager, "getEnvDescriptor").mockImplementation((id) => {
        const value = descriptor(id);
        return value && id === "local" ? { ...value, online: false } : value;
      });
    } else {
      fs.renameSync(workspaceDir, `${workspaceDir}-moved`);
      await expect(f.hub.projects.ensureAuthorized(project.id)).rejects.toMatchObject({ code: "project_directory_unavailable" });
    }
    const defaultEnv = vi.spyOn(f.hub.envManager, "createExecutionEnv");
    const projectEnv = vi.spyOn(f.hub.envManager, "createWorkerExecutionEnv");
    const authorize = vi.spyOn(f.hub.envManager, "authorizeProjectDirectory");
    const notes = `允许 ${unavailable} 时继续讨论和整理项目说明。`;
    await f.send(topic.id, "查看项目和会话、检索同项目历史，并更新项目说明。", [
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "kulo_projects", limit: 3 }),
        fauxToolCall("tool_search", { query: "kulo_project_conversations", limit: 3 }),
        fauxToolCall("tool_search", { query: "kulo_project_history", limit: 3 }),
        fauxToolCall("tool_search", { query: "kulo_project_update", limit: 3 }),
      ], { stopReason: "toolUse" }),
      tool("kulo_projects", {}),
      tool("kulo_project_conversations", { project_id: project.id }),
      tool("kulo_project_history", { project_id: project.id, query: "offline-history-needle" }),
      tool("kulo_project_update", { project_id: project.id, expected_revision: project.revision, notes }),
      answer(),
    ]);
    const results = (await f.results(topic.conversationId)).filter((result) => result.toolName !== "tool_search");
    expect(results.map((result) => result.toolName)).toEqual(["kulo_projects", "kulo_project_conversations", "kulo_project_history", "kulo_project_update"]);
    for (const result of results) expect(result.isError, resultText(result)).not.toBe(true);
    const listed = JSON.parse(resultText(results[0]!));
    expect(listed).toEqual([expect.objectContaining({ id: project.id, availability: unavailable === "offline" ? "offline" : "unavailable" })]);
    const conversations = JSON.parse(resultText(results[1]!));
    expect(conversations.map((item: { id: string }) => item.id).sort()).toEqual([history.id, topic.id].sort());
    const matches = JSON.parse(resultText(results[2]!));
    expect(matches).toEqual([expect.objectContaining({ topicId: history.id, role: "user", excerpt: "offline-history-needle 同项目历史保留。" })]);
    expect((await f.hub.projects.get(project.id)).notes).toBe(notes);
    expect(authorize).not.toHaveBeenCalled();
    expect(defaultEnv).not.toHaveBeenCalled();
    expect(projectEnv).not.toHaveBeenCalled();

    await f.send(topic.id, "读取项目中的 project-boundary.txt。", [tool("read", { path: fileName }), answer("项目执行位置当前不可用。")]);
    const read = (await f.results(topic.conversationId)).find((result) => result.toolName === "read");
    expect(read).toMatchObject({ isError: true });
    expect(resultText(read!)).toContain(unavailable === "offline" ? "项目设备离线" : "项目目录不可用");
    expect(JSON.stringify(await f.results(topic.conversationId))).not.toContain(hubCanary);
    expect(defaultEnv).not.toHaveBeenCalled();
    expect(projectEnv).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.config.localEnvRoot!, fileName), "utf8")).toBe(hubCanary);
    expect(authorize).toHaveBeenCalledTimes(unavailable === "offline" ? 0 : 1);
    expect((await f.hub.getBoardSnapshot()).tickets).toHaveLength(0);
  });

  it("replays a conversation deletion's committed cancellation after an interrupted stop and Hub restart", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("等待设备的普通会话", context);
    const descriptor = f.hub.envManager.getEnvDescriptor.bind(f.hub.envManager);
    const offline = vi.spyOn(f.hub.envManager, "getEnvDescriptor").mockImplementation((id) => {
      const value = descriptor(id);
      return value && id === "local" ? { ...value, online: false } : value;
    });
    const card = await f.hub.dispatchTicket({ commandId: "ordinary-wait", title: "等待设备", goal: "上线后继续", scope: "独立工单", envId: "local", originConversationId: topic.conversationId });
    const deadline = Date.now() + 5_000;
    while (true) {
      const ticket = (await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      if (ticket?.status === "waiting" && ticket.waiting?.reason === "env" && ticket.activeTaskId === undefined) break;
      if (Date.now() > deadline) throw new Error(`Task did not persist its Env wait: ${JSON.stringify(ticket)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(f.hub.deleteTopic(topic.id)).rejects.toMatchObject({ code: "topic_tasks_running" });
    const interrupted = vi.spyOn(f.hub, "stopTicket").mockRejectedValue(new Error("injected stop interruption"));
    await expect(f.hub.deleteTopic(topic.id, context, { stopTasks: true })).rejects.toThrow("injected stop interruption");
    const stopped = await f.hub.harness.snapshot(KuloStateDoc, context);
    expect(stopped?.topics?.[topic.id]?.deletedAt).toEqual(expect.any(Number));
    expect(stopped?.tickets[card.id]).toMatchObject({ status: "stopped", cleanupPending: true });
    expect((await f.hub.harness.snapshot(KuloProjectsDoc, context))?.cancellations[card.id]).toMatchObject({ reason: "会话已删除" });
    expect(await f.hub.listTopics()).not.toContainEqual(expect.objectContaining({ id: topic.id }));
    await f.close();
    interrupted.mockRestore();
    offline.mockRestore();
    await f.reopen();
    const recovered = await f.hub.harness.snapshot(KuloStateDoc, context);
    expect(recovered?.topics?.[topic.id]?.deletedAt).toBe(stopped?.topics?.[topic.id]?.deletedAt);
    expect(recovered?.tickets[card.id]).toMatchObject({ status: "stopped", cleanupPending: false });
    expect(recovered?.tickets[card.id]?.runEpoch).toBe(stopped!.tickets[card.id]!.runEpoch);
    expect(recovered?.slots.holders).not.toContain(card.id);
    expect((await f.hub.harness.snapshot(KuloProjectsDoc, context))?.cancellations[card.id]).toBeUndefined();
    await expect(f.hub.steerTicket({ commandId: "late-reply", ticketId: card.id, text: "继续" })).rejects.toThrow(/stopped|closed/i);
    expect(f.requests).toHaveLength(0);
  });

  it("replays a direct stop after its durable commit but before the collaboration tree was aborted", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("直接停止的普通会话", context);
    const descriptor = f.hub.envManager.getEnvDescriptor.bind(f.hub.envManager);
    const offline = vi.spyOn(f.hub.envManager, "getEnvDescriptor").mockImplementation((id) => {
      const value = descriptor(id);
      return value && id === "local" ? { ...value, online: false } : value;
    });
    const card = await f.hub.dispatchTicket({ commandId: "direct-stop-work", title: "直接停止", goal: "等待后续指令", scope: "独立工单", envId: "local", originConversationId: topic.conversationId });
    const deadline = Date.now() + 5_000;
    while (true) {
      const ticket = (await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id];
      if (ticket?.status === "waiting" && ticket.activeTaskId === undefined) break;
      if (Date.now() > deadline) throw new Error(`Task did not persist its wait: ${JSON.stringify(ticket)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const child = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "openai", modelId: "gpt-4o" } } }, context);
    const childId = `${card.id}:S-01`;
    const before = await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const ticket = state.tickets[card.id]!;
      ticket.status = "running";
      ticket.waiting = undefined;
      state.slots.holders = [card.id];
      state.slots.writeHolders = [card.id];
      state.subagents ??= {};
      state.subagents[childId] = {
        id: childId, ticketId: card.id, name: "still-running-child", role: "coder", roleLabel: "子开发者",
        parentConversationId: ticket.workerConversationId, conversationId: Number(child.id), readOnly: false, runs: 1,
        createdAt: Date.now(), updatedAt: Date.now(), state: "running",
      };
      state.conversationToSubagent ??= {};
      state.conversationToSubagent[String(child.id)] = childId;
      return { workerConversationId: ticket.workerConversationId, runEpoch: ticket.runEpoch };
    }, context);
    const conversation = f.hub.harness.conversation.bind(f.hub.harness);
    const interrupted = vi.spyOn(f.hub.harness, "conversation").mockImplementation(async (...args) => {
      const found = await conversation(...args);
      if (found && Number(args[0]) === before.workerConversationId) {
        vi.spyOn(found, "abort").mockRejectedValueOnce(new Error("injected direct-stop abort interruption"));
      }
      return found;
    });
    await expect(f.hub.stopTicket(card.id, "用户直接停止", context, "direct-stop-command")).rejects.toThrow("injected direct-stop abort interruption");
    interrupted.mockRestore();
    const stopped = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(stopped.tickets[card.id]).toMatchObject({ status: "stopped", cleanupPending: true, stoppedReason: "用户直接停止", runEpoch: before.runEpoch + 1 });
    expect(stopped.subagents?.[childId]?.state).toBe("running");
    expect(stopped.slots.holders).toContain(card.id);
    expect(stopped.slots.writeHolders).toContain(card.id);
    expect(stopped.topics?.[topic.id]?.deletedAt).toBeUndefined();
    expect((await f.hub.harness.snapshot(KuloProjectsDoc, context))?.cancellations[card.id]).toMatchObject({ reason: "用户直接停止" });

    await f.close();
    offline.mockRestore();
    await f.reopen();
    const recovered = (await f.hub.harness.snapshot(KuloStateDoc, context))!;
    expect(recovered.tickets[card.id]).toMatchObject({ status: "stopped", cleanupPending: false, stoppedReason: "用户直接停止" });
    expect(recovered.tickets[card.id]!.runEpoch).toBe(stopped.tickets[card.id]!.runEpoch);
    expect(recovered.subagents?.[childId]?.state).toBe("stopped");
    expect(recovered.slots.holders).not.toContain(card.id);
    expect(recovered.slots.writeHolders).not.toContain(card.id);
    expect((await f.hub.harness.snapshot(KuloProjectsDoc, context))?.cancellations[card.id]).toBeUndefined();
    await expect(f.hub.stopTicket(card.id, "用户直接停止", context, "direct-stop-command")).resolves.toMatchObject({ status: "stopped" });
    expect((await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets[card.id]?.runEpoch).toBe(stopped.tickets[card.id]!.runEpoch);
    await expect(f.hub.steerTicket({ commandId: "late-direct-stop-wake", ticketId: card.id, text: "继续旧任务" })).rejects.toThrow(/stopped|closed/i);
    expect(f.requests).toHaveLength(0);
  });
});
