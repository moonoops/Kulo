import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness, ToolResultEntry, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ProjectDirectoryGrant, TicketRecord, TopicSummary } from "@moco/protocol";
import { MocoProjects, MocoProjectsDoc, type ProjectEnvManager } from "../packages/hub/src/projects.js";
import { MocoStateDoc, ensureDefaultRootTopic } from "../packages/hub/src/state.js";
import { createProjectToolsExtension, type ProjectController } from "../packages/hub/src/tools-projects.js";
import { injectEventToolsInTx } from "../packages/hub/src/tool-surface.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const harnesses: Harness[] = [];

class ProjectEnv implements ProjectEnvManager {
  online = true;
  capabilities = ["worker-isolation"];
  grants = new Map<string, ProjectDirectoryGrant>();
  authorizations: Array<{ deviceId: string; projectId: string; path: string; operationId: string; revision?: number }> = [];
  revocations: string[] = [];
  failNextAuthorization = false;
  getEnvDescriptor(id: string) { return id === "unknown" ? undefined : { id, name: `Device ${id}`, online: this.online, capabilities: this.capabilities }; }
  async listProjectDirectories(deviceId: string, directory = os.tmpdir()) {
    return { deviceId, path: directory, parentPath: path.dirname(directory), entries: [] };
  }
  async authorizeProjectDirectory(deviceId: string, input: { projectId: string; path: string; create?: boolean; operationId: string; revision?: number }) {
    if (!this.online) throw new Error("device offline");
    this.authorizations.push({ deviceId, ...input });
    if (input.create) fs.mkdirSync(input.path, { recursive: true });
    const workspaceDir = fs.realpathSync(input.path);
    const stat = fs.statSync(workspaceDir);
    const grant = { projectId: input.projectId, workspaceDir, directoryId: `${deviceId}:${stat.dev}:${stat.ino}`, revision: input.revision ?? 1, scratchRoot: path.join(path.dirname(workspaceDir), "scratch"), platform: process.platform };
    this.grants.set(`${deviceId}:${input.projectId}`, grant);
    if (this.failNextAuthorization) { this.failNextAuthorization = false; throw new Error("transport lost after directory creation"); }
    return grant;
  }
  async revokeProjectDirectory(deviceId: string, projectId: string) {
    this.revocations.push(`${deviceId}:${projectId}`);
    this.grants.delete(`${deviceId}:${projectId}`);
    return { cleanupPending: false };
  }
}

async function fixture(options: { directory?: string; env?: ProjectEnv; stopTicket?: (id: string, reason: string) => Promise<unknown> } = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-project-store-"));
  if (!options.directory) directories.push(directory);
  const env = options.env ?? new ProjectEnv();
  const models = createModels();
  const faux = fauxProvider({ provider: "project-test", models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  let projects!: MocoProjects;
  const controller: ProjectController = {
    listProjects: (ctx, deleted) => projects.list(ctx, deleted),
    listProjectTopics: (projectId, ctx, deleted) => projects.listTopics(projectId, ctx, deleted),
    createProject: (input, ctx) => projects.create(input, ctx),
    patchProject: (id, patch, ctx) => projects.patch(id, patch, ctx),
    deleteProject: (id, input, ctx) => projects.remove(id, input, ctx),
    restoreProject: (id, ctx) => projects.restore(id, ctx),
    moveProjectTopic: (id, project, ctx) => projects.moveTopic(id, project, ctx),
    renameProjectTopic: async (id, title, ctx) => harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      const topic = state.topics![id]!;
      topic.title = title;
      return topic;
    }, ctx),
    restoreProjectTopic: (id, ctx) => projects.restoreTopic(id, ctx),
    searchProjectHistory: (id, query, ctx) => projects.searchHistory(id, query, ctx),
  };
  const tools = createProjectToolsExtension(controller);
  registry.install(tools);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models, registry }, context);
  harnesses.push(harness);
  await harness.root(context, { agent: { model: { provider: "project-test", modelId: "test" } } });
  await harness.commit(async (tx) => { ensureDefaultRootTopic(await tx.doc(MocoStateDoc)); }, context);
  const stopTicket = options.stopTicket ?? vi.fn(async (id: string) => {
    const snapshot = await harness.snapshot(MocoStateDoc, context);
    expect(snapshot?.tickets[id]?.status).toBe("stopped");
    return undefined;
  });
  projects = new MocoProjects({ harness, envManager: env, stopTicket });
  async function project(name: string, deviceId = "local") {
    const workspaceDir = path.join(directory, name);
    fs.mkdirSync(workspaceDir, { recursive: true });
    return projects.create({ commandId: `create-${deviceId}-${name}`, name, deviceId, workspaceDir });
  }
  async function topic(name: string, projectId?: string) {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "project-test", modelId: "test" } } }, context);
    const record: TopicSummary = { id: `topic-${conversation.id}`, conversationId: Number(conversation.id), title: name, projectId: projectId ?? null, createdAt: Date.now(), updatedAt: Date.now() };
    await harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.topics![record.id] = record;
      state.conversationToTopic![String(conversation.id)] = record.id;
    }, context);
    return { record, conversation };
  }
  return { directory, env, faux, harness, projects, project, topic, tools, stopTicket };
}

function ticket(id: string, projectId: string, topic: TopicSummary, status: TicketRecord["status"] = "waiting"): TicketRecord {
  return { id, commandId: id, title: id, goal: "test", scope: "test", role: "coder", status, envId: "local", workspaceDir: "/test/project", workerConversationId: 999, runEpoch: 1, createdAt: 1, updatedAt: 1, projectId, originTopicId: topic.id, originConversationId: topic.conversationId };
}

async function writeMessage(conversation: Conversation, kind: string, text: string) {
  const submission = await conversation.submit({ type: "write", entry: { kind, model: [{ role: kind === "pi.user" ? "user" : kind === "pi.system" ? "system" : "assistant", content: kind === "pi.user" ? text : [{ type: "text", text }] }] } }, context);
  await submission.wait(context);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(context);
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("durable project registry", () => {
  it("deduplicates creation across concurrency and restarts, and rejects command reuse with a different meaning", async () => {
    const f = await fixture();
    const input = { commandId: "create-once", name: "项目", deviceId: "local", workspaceDir: path.join(f.directory, "existing") };
    fs.mkdirSync(input.workspaceDir);
    fs.writeFileSync(path.join(input.workspaceDir, "keep.txt"), "original");
    const [first, again] = await Promise.all([f.projects.create(input), f.projects.create(input)]);
    expect(first.id).toBe(again.id);
    expect(f.env.authorizations).toHaveLength(1);
    await f.harness.close(context);
    const reopened = await fixture({ directory: f.directory, env: f.env });
    expect((await reopened.projects.create(input)).id).toBe(first.id);
    expect(f.env.authorizations).toHaveLength(1);
    expect((await reopened.projects.list())[0]).toMatchObject({ id: first.id, scratchRoot: expect.any(String), platform: process.platform });
    await expect(reopened.projects.create({ ...input, name: "other" })).rejects.toMatchObject({ status: 409, code: "project_command_conflict" });
    expect(fs.readFileSync(path.join(input.workspaceDir, "keep.txt"), "utf8")).toBe("original");
  });

  it("resumes the same creation after the Env created a directory but the reply was lost", async () => {
    const f = await fixture();
    const input = { commandId: "lost-reply", name: "new", deviceId: "local", workspaceDir: path.join(f.directory, "new"), createDirectory: true };
    f.env.failNextAuthorization = true;
    await expect(f.projects.create(input)).rejects.toThrow("transport lost");
    fs.writeFileSync(path.join(input.workspaceDir, "keep.txt"), "survives retry");
    await f.harness.close(context);
    const second = await fixture({ directory: f.directory, env: f.env });
    const result = await second.projects.create(input);
    expect(f.env.authorizations[0]!.projectId).toBe(result.id);
    expect(f.env.authorizations[1]!.projectId).toBe(result.id);
    expect(fs.readFileSync(path.join(input.workspaceDir, "keep.txt"), "utf8")).toBe("survives retry");
  });

  it("rejects aliases of one real directory while allowing equal directory names on different devices", async () => {
    const f = await fixture();
    const first = await f.project("source");
    const alias = path.join(f.directory, "alias");
    fs.symlinkSync(first.workspaceDir, alias, "dir");
    await expect(f.projects.create({ commandId: "alias", name: "alias", deviceId: "local", workspaceDir: alias }))
      .rejects.toMatchObject({ code: "project_directory_duplicate", details: { projectId: first.id } });
    expect(f.env.revocations).toHaveLength(1);
    expect(await f.projects.list()).toHaveLength(1);
    await f.projects.create({ commandId: "remote-copy", name: "source", deviceId: "remote", workspaceDir: first.workspaceDir });
    expect(await f.projects.list()).toHaveLength(2);
  });

  it("uses revision checks and blocks moving conversations with unfinished work", async () => {
    const f = await fixture();
    const a = await f.project("a");
    const b = await f.project("b");
    const { record } = await f.topic("conversation");
    expect(await f.projects.moveTopic(record.id, a.id)).toMatchObject({ projectId: a.id });
    expect(await f.projects.patch(a.id, { expectedRevision: 1, notes: "project facts" })).toMatchObject({ revision: 2, notes: "project facts" });
    await expect(f.projects.patch(a.id, { expectedRevision: 1, name: "stale" })).rejects.toMatchObject({ code: "project_revision_conflict" });
    await f.harness.commit(async (tx) => { const state = await tx.doc(MocoStateDoc); state.tickets.WAITING = ticket("WAITING", a.id, record); }, context);
    await expect(f.projects.moveTopic(record.id, b.id)).rejects.toMatchObject({ code: "project_tasks_running" });
    await expect(f.projects.moveTopic("root", a.id)).rejects.toMatchObject({ code: "master_topic_immutable" });
    await expect(f.projects.get("__proto__")).rejects.toMatchObject({ code: "project_not_found" });
    await expect(f.projects.restoreTopic("__proto__")).rejects.toMatchObject({ code: "topic_not_found" });
  });

  it("soft-deletes an offline project, fences all associated work first, and restores only the correct conversations", async () => {
    const f = await fixture();
    const a = await f.project("a");
    const b = await f.project("b");
    const live = await f.topic("live", a.id);
    const earlier = await f.topic("independently deleted", a.id);
    const separate = await f.topic("other", b.id);
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.topics![earlier.record.id]!.deletedAt = 12;
      state.topics![earlier.record.id]!.deletionId = "independent";
      state.tickets.OWN = ticket("OWN", a.id, live.record);
      state.tickets.OUTGOING = ticket("OUTGOING", b.id, live.record, "running");
      state.tickets.OTHER = ticket("OTHER", b.id, separate.record);
    }, context);
    await expect(f.projects.remove(a.id)).rejects.toMatchObject({ code: "project_tasks_running" });
    expect((await f.projects.list()).map((project) => project.id)).toContain(a.id);
    f.env.online = false;
    expect(await f.projects.remove(a.id, { stopTasks: true })).toMatchObject({ deleted: a.id, cleanupPending: true });
    expect(f.stopTicket).toHaveBeenCalledTimes(2);
    expect(f.env.revocations).toHaveLength(0);
    const deleted = await f.harness.snapshot(MocoStateDoc, context);
    expect(deleted?.tickets.OWN?.status).toBe("stopped");
    expect(deleted?.tickets.OUTGOING?.status).toBe("stopped");
    expect(deleted?.tickets.OTHER?.status).toBe("waiting");
    expect(fs.existsSync(a.workspaceDir)).toBe(true);
    expect(await f.projects.restore(a.id)).toMatchObject({ id: a.id, availability: "offline" });
    const restored = await f.harness.snapshot(MocoStateDoc, context);
    expect(restored?.topics?.[live.record.id]?.deletedAt).toBeUndefined();
    expect(restored?.topics?.[earlier.record.id]?.deletedAt).toBe(12);
    expect(restored?.tickets.OWN?.status).toBe("stopped");
    f.env.online = true;
    await expect(f.projects.ensureAuthorized(a.id)).rejects.toMatchObject({ code: "project_cleanup_pending" });
    await f.projects.reconcileDevice("local");
    await f.projects.ensureAuthorized(a.id);
    expect((await f.projects.list()).find((project) => project.id === a.id)?.availability).toBe("ready");
    expect((await f.projects.listTopics(a.id)).map((topic) => topic.id)).toEqual([live.record.id]);
    expect((await f.projects.listTopics(a.id, context, true)).map((topic) => topic.id)).toContain(earlier.record.id);
  });

  it("keeps cancellation intent across a failed abort and retries it after restart", async () => {
    const firstAbort = vi.fn(async () => { throw new Error("abort interrupted"); });
    const f = await fixture({ stopTicket: firstAbort });
    const a = await f.project("a");
    const { record } = await f.topic("live", a.id);
    await f.harness.commit(async (tx) => { const state = await tx.doc(MocoStateDoc); state.tickets.RUN = ticket("RUN", a.id, record, "running"); }, context);
    f.env.online = false;
    await expect(f.projects.remove(a.id, { stopTasks: true })).rejects.toThrow("abort interrupted");
    expect(await f.projects.list()).toHaveLength(0);
    expect((await f.harness.snapshot(MocoProjectsDoc, context))?.cancellations.RUN).toBeDefined();
    await f.harness.close(context);
    const abort = vi.fn(async () => undefined);
    const second = await fixture({ directory: f.directory, env: f.env, stopTicket: abort });
    await second.projects.reconcileDevice("local");
    expect(abort).toHaveBeenCalledWith("RUN", "项目已删除");
    expect((await second.harness.snapshot(MocoProjectsDoc, context))?.cancellations.RUN).toBeUndefined();
  });

  it("replays ordinary conversation cancellation after restart without an online Env or project", async () => {
    const firstAbort = vi.fn(async () => { throw new Error("ordinary abort interrupted"); });
    const f = await fixture({ stopTicket: firstAbort });
    const { record } = await f.topic("ordinary");
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      const stopped = ticket("ORDINARY", "unused", record, "stopped");
      delete stopped.projectId;
      stopped.cleanupPending = true;
      state.tickets[stopped.id] = stopped;
      state.topics![record.id]!.deletedAt = Date.now();
      const projects = await tx.doc(MocoProjectsDoc);
      projects.cancellations[stopped.id] = { reason: "会话已删除", requestedAt: Date.now() };
    }, context);
    f.env.online = false;
    await expect(f.projects.reconcileCancellations()).rejects.toThrow("ordinary abort interrupted");
    await f.harness.close(context);
    const abort = vi.fn(async () => undefined);
    const second = await fixture({ directory: f.directory, env: f.env, stopTicket: abort });
    await second.projects.reconcileCancellations();
    expect(abort).toHaveBeenCalledExactlyOnceWith("ORDINARY", "会话已删除");
    expect((await second.harness.snapshot(MocoProjectsDoc, context))?.cancellations.ORDINARY).toBeUndefined();
    expect((await second.harness.snapshot(MocoStateDoc, context))?.tickets.ORDINARY?.status).toBe("stopped");
    await second.projects.reconcileCancellations();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed rebind unavailable until the original directory is authorized with a fresh revision", async () => {
    const f = await fixture();
    const a = await f.project("a");
    const b = await f.project("b");
    await expect(f.projects.patch(a.id, { workspaceDir: b.workspaceDir, expectedRevision: a.revision })).rejects.toMatchObject({ code: "project_directory_duplicate" });
    const before = await f.projects.get(a.id);
    expect(before.workspaceDir).toBe(a.workspaceDir);
    expect(before.grantRevision).toBeGreaterThan(a.grantRevision);
    expect((await f.projects.list()).find((project) => project.id === a.id)?.availability).toBe("unavailable");
    await f.projects.ensureAuthorized(a.id);
    expect(f.env.grants.get(`local:${a.id}`)?.workspaceDir).toBe(a.workspaceDir);
    expect((await f.projects.list()).find((project) => project.id === a.id)?.availability).toBe("ready");
  });

  it("commits old-device cleanup with a cross-device binding so a crash before revoke can recover", async () => {
    const f = await fixture();
    const project = await f.project("binding-origin");
    const target = path.join(f.directory, "binding-target");
    fs.mkdirSync(target);
    const commit = f.harness.commit.bind(f.harness);
    let interrupted = false;
    let cleanupWasDurable = false;
    const boundary = vi.spyOn(f.harness, "commit").mockImplementation(async (...args) => {
      const state = await f.harness.snapshot(MocoProjectsDoc, context);
      if (!interrupted && state?.projects[project.id]?.deviceId === "remote") {
        interrupted = true;
        cleanupWasDurable = Boolean(state.cleanup[`local:${project.id}`]);
        throw new Error("crash before old-device revoke");
      }
      return commit(...args);
    });
    await expect(f.projects.patch(project.id, { deviceId: "remote", workspaceDir: target, expectedRevision: project.revision }))
      .rejects.toThrow("crash before old-device revoke");
    boundary.mockRestore();
    expect(interrupted).toBe(true);
    expect(cleanupWasDurable).toBe(true);
    expect(f.env.grants.has(`local:${project.id}`)).toBe(true);
    await f.harness.close(context);
    const reopened = await fixture({ directory: f.directory, env: f.env });
    await reopened.projects.reconcileDevice("local");
    expect(f.env.grants.has(`local:${project.id}`)).toBe(false);
    expect(f.env.grants.has(`remote:${project.id}`)).toBe(true);
    expect(await reopened.projects.get(project.id)).toMatchObject({ deviceId: "remote", workspaceDir: fs.realpathSync(target) });
    expect((await reopened.harness.snapshot(MocoProjectsDoc, context))?.cleanup[`local:${project.id}`]).toBeUndefined();
  });

  it("retains candidate-device cleanup when deleting an interrupted cross-device binding while offline", async () => {
    const f = await fixture();
    const project = await f.project("pending-origin");
    const target = path.join(f.directory, "pending-target");
    fs.mkdirSync(target);
    const operationId = `project:bind:${project.id}:2:2`;
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(MocoProjectsDoc);
      state.bindings[project.id] = { operationId, deviceId: "remote", workspaceDir: target, revision: 2, grantRevision: 2 };
    }, context);
    await f.env.authorizeProjectDirectory("remote", { projectId: project.id, path: target, operationId, revision: 2 });
    await f.harness.close(context);
    f.env.online = false;
    const reopened = await fixture({ directory: f.directory, env: f.env });
    expect(await reopened.projects.remove(project.id)).toMatchObject({ cleanupPending: true });
    const deleted = await reopened.harness.snapshot(MocoProjectsDoc, context);
    expect(deleted?.bindings[project.id]).toBeUndefined();
    expect(deleted?.cleanup[`local:${project.id}`]).toBeDefined();
    expect(deleted?.cleanup[`remote:${project.id}`]).toBeDefined();
    f.env.online = true;
    await reopened.projects.reconcileDevice("remote");
    await reopened.projects.reconcileDevice("local");
    expect(f.env.grants.has(`local:${project.id}`)).toBe(false);
    expect(f.env.grants.has(`remote:${project.id}`)).toBe(false);
    expect(fs.existsSync(project.workspaceDir)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("searches only active same-project conversation text, excluding system prompts and deleted histories", async () => {
    const f = await fixture();
    const a = await f.project("a");
    const b = await f.project("b");
    const same = await f.topic("same", a.id);
    const other = await f.topic("other", b.id);
    const deleted = await f.topic("deleted", a.id);
    await writeMessage(same.conversation, "pi.user", "needle shared fact");
    await writeMessage(same.conversation, "pi.system", "needle private system instructions");
    await writeMessage(other.conversation, "pi.user", "needle other project");
    await writeMessage(deleted.conversation, "pi.user", "needle deleted history");
    await f.harness.commit(async (tx) => { const state = await tx.doc(MocoStateDoc); state.topics![deleted.record.id]!.deletedAt = Date.now(); }, context);
    expect(await f.projects.searchHistory(a.id, "needle")).toEqual([
      expect.objectContaining({ topicId: same.record.id, role: "user", excerpt: "needle shared fact" }),
    ]);
  });

  it("searches past the newest 100 entries and 20 topics while keeping the result budget", async () => {
    const f = await fixture();
    const project = await f.project("long-history");
    const oldest = await f.topic("oldest", project.id);
    await writeMessage(oldest.conversation, "pi.user", "early-history-needle original parameter 43127");
    for (let i = 0; i < 125; i++) await writeMessage(oldest.conversation, "pi.user", "later unrelated message " + i);
    const newer: Array<{ id: string }> = [];
    for (let i = 0; i < 21; i++) newer.push((await f.topic("newer " + i, project.id)).record);
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.topics![oldest.record.id]!.updatedAt = 1;
      for (const [index, topic] of newer.entries()) state.topics![topic.id]!.updatedAt = 100 + index;
    }, context);
    expect(await f.projects.searchHistory(project.id, "early-history-needle")).toEqual([
      expect.objectContaining({ topicId: oldest.record.id, role: "user", excerpt: "early-history-needle original parameter 43127" }),
    ]);
    for (let i = 0; i < 25; i++) await writeMessage(oldest.conversation, "pi.user", "bounded-history-match " + i);
    expect(await f.projects.searchHistory(project.id, "bounded-history-match")).toHaveLength(20);
  });

  it("fences a replaced directory and requires explicit rebinding instead of silently adopting new files", async () => {
    const f = await fixture();
    const a = await f.project("a");
    fs.renameSync(a.workspaceDir, `${a.workspaceDir}-original`);
    fs.mkdirSync(a.workspaceDir);
    await expect(f.projects.ensureAuthorized(a.id)).rejects.toMatchObject({ code: "project_directory_changed" });
    expect(f.env.grants.has(`local:${a.id}`)).toBe(false);
    expect((await f.projects.list())[0]).toMatchObject({ availability: "unavailable", error: expect.stringContaining("目录身份") });
    const rebound = await f.projects.patch(a.id, { workspaceDir: a.workspaceDir, expectedRevision: a.revision });
    expect(rebound.directoryId).not.toBe(a.directoryId);
    expect(rebound.availability).toBe("ready");
    expect(fs.existsSync(`${a.workspaceDir}-original`)).toBe(true);
  });

  it("persists unavailable state when the real Env registry rejects a missing directory and permits explicit rebinding", async () => {
    const f = await fixture();
    const registry = new ProjectDirectoryRegistry({ deviceId: "local", filePath: path.join(f.directory, "env-private", "grants.json"), scratchRoot: path.join(f.directory, "env-scratch") });
    vi.spyOn(f.env, "authorizeProjectDirectory").mockImplementation(async (_deviceId, input) => registry.authorize(input));
    const original = await f.project("real-directory");
    fs.renameSync(original.workspaceDir, `${original.workspaceDir}-moved`);
    await expect(f.projects.ensureAuthorized(original.id)).rejects.toMatchObject({ status: 409, code: "project_directory_unavailable" });
    expect((await f.projects.list())[0]).toMatchObject({ availability: "unavailable", error: expect.stringContaining("目录不可用") });
    const rebound = await f.projects.patch(original.id, { workspaceDir: `${original.workspaceDir}-moved`, expectedRevision: original.revision });
    expect(rebound).toMatchObject({ workspaceDir: `${original.workspaceDir}-moved`, availability: "ready" });
  });

  it("records authorization failure without hiding unexpected Env errors", async () => {
    const f = await fixture();
    const project = await f.project("unexpected-authorization");
    const unexpected = new Error("unexpected registry storage failure");
    vi.spyOn(f.env, "authorizeProjectDirectory").mockRejectedValueOnce(unexpected);
    await expect(f.projects.ensureAuthorized(project.id)).rejects.toBe(unexpected);
    expect((await f.projects.list())[0]).toMatchObject({ availability: "unavailable", error: expect.stringContaining(unexpected.message) });
    await f.projects.ensureAuthorized(project.id);
    expect((await f.projects.list())[0]?.availability).toBe("ready");
  });

  it("distinguishes online project registration from unavailable execution isolation", async () => {
    const f = await fixture();
    f.env.capabilities = ["worker-isolation-unavailable"];
    const project = await f.project("registered");
    expect(project).toMatchObject({ availability: "unavailable", error: expect.stringContaining("隔离") });
    expect(await f.projects.get(project.id)).toMatchObject({ name: "registered" });
    f.env.capabilities = ["fs", "bash"];
    expect((await f.projects.list())[0]).toMatchObject({ availability: "unavailable", error: expect.stringContaining("隔离") });
    f.env.online = false;
    expect((await f.projects.list())[0]?.availability).toBe("offline");
  });

  it("refuses project management when tools are accidentally exposed to a Worker", async () => {
    const f = await fixture();
    f.faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("moco_project_create", { command_id: "forbidden", name: "forbidden", device_id: "local", workspace_dir: f.directory })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    const worker = await f.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "project-test", modelId: "test" }, extensions: [f.tools] },
    }, context);
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.conversationToTicket[String(worker.id)] = "worker";
      await injectEventToolsInTx(tx, worker.id, ["moco_project_create"]);
    }, context);
    const submission = await worker.submit({ type: "input", content: "try to create project" }, context);
    await submission.wait(context);
    const entries = await worker.entries({}, 50, undefined, context);
    const error = entries.items.filter((entry) => ToolResultEntry.is(entry));
    expect(JSON.stringify(error)).toContain("只有主脑");
    expect(f.env.authorizations).toHaveLength(0);
    expect(await f.projects.list()).toHaveLength(0);
  });

  it.each(["worker", "subagent", "settings", "deleted"])("refuses conversation rename from a %s conversation", async (kind) => {
    const f = await fixture();
    f.faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("moco_conversation_rename", { title: "不能修改的标题" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ]);
    const conversation = await f.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      model: { provider: "project-test", modelId: "test" }, extensions: [f.tools],
    } }, context);
    const record: TopicSummary = { id: `topic-${conversation.id}`, conversationId: Number(conversation.id), title: "保留标题", createdAt: 1, updatedAt: 1 };
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      if (kind !== "settings") {
        state.topics![record.id] = { ...record, ...(kind === "deleted" ? { deletedAt: 2 } : {}) };
        state.conversationToTopic![String(conversation.id)] = record.id;
      }
      if (kind === "worker") state.conversationToTicket[String(conversation.id)] = "worker";
      if (kind === "subagent") {
        state.conversationToSubagent ??= {};
        state.conversationToSubagent[String(conversation.id)] = "subagent";
      }
      await injectEventToolsInTx(tx, conversation.id, ["moco_conversation_rename"]);
    }, context);
    const submission = await conversation.submit({ type: "input", content: "try to rename" }, context);
    await submission.wait(context);
    const entries = await conversation.entries({}, 50, undefined, context);
    expect(JSON.stringify(entries.items.filter(ToolResultEntry.is))).toContain("只有主脑");
    const state = await f.harness.snapshot(MocoStateDoc, context);
    if (kind !== "settings") expect(state?.topics?.[record.id]?.title).toBe("保留标题");
    expect(state?.topics?.root?.title).toBe("与 Moco 对话");
  });
});
