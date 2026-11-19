import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import WebSocket from "ws";
import { KuloEnvAgent } from "@kulo/env";
import { KuloHub, KuloStateDoc, startKuloHubServer } from "@kulo/hub";
import type { HubToClientMessage, ProjectDirectoryListing, ProjectView, TopicSummary } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const context = BACKGROUND_CONTEXT;
const nodeToken = "project-http-env-test-token";
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Project HTTP state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-project-http-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "project-http-model" }] });
  models.setProvider(faux.provider);
  const hub = await openTestHub({ models, config: {
    stateDir: path.join(directory, "hub-state"), localEnvRoot: path.join(directory, "local-runtime"), identityDir: path.join(directory, "private-identity"),
    host: "127.0.0.1", authToken: HUB_TEST_ADMIN_TOKEN, envTokens: { remote: nodeToken }, workerEnvIds: ["remote"],
    watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "project-http-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
  } });
  cleanups.push(() => hub.close());
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  const request = (pathname: string, method = "GET", body?: unknown, token = HUB_TEST_ADMIN_TOKEN) => fetch(`${server.url}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { directory, hub, server, request };
}

async function client(url: string) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
  const messages: HubToClientMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  cleanups.push(() => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    ws.terminate();
  }));
  const waitFor = async <T extends HubToClientMessage["type"]>(type: T, matches: (message: Extract<HubToClientMessage, { type: T }>) => boolean = () => true, after = 0) => {
    let found: Extract<HubToClientMessage, { type: T }> | undefined;
    await until(() => {
      found = messages.slice(after).find((message): message is Extract<HubToClientMessage, { type: T }> => message.type === type && matches(message as Extract<HubToClientMessage, { type: T }>));
      return Boolean(found);
    });
    return found!;
  };
  await waitFor("hub.snapshot");
  return { waitFor, mark: () => messages.length };
}

describe("project HTTP and client synchronization", () => {
  it("requires a client management identity for project, directory, and project-conversation routes", async () => {
    const f = await fixture();
    const routes: Array<[string, string, unknown?]> = [
      ["/api/projects", "GET"],
      ["/api/projects/directories?deviceId=local", "GET"],
      ["/api/projects", "POST", { commandId: "unauthorized", name: "Unauthorized", deviceId: "local", workspaceDir: f.directory }],
      ["/api/projects/missing", "PATCH", { name: "Unauthorized" }],
      ["/api/projects/missing", "DELETE", {}],
      ["/api/topics", "POST", { title: "Unauthorized", projectId: "missing" }],
    ];
    for (const token of ["", nodeToken]) {
      for (const [route, method, body] of routes) expect((await f.request(route, method, body, token)).status).toBe(401);
    }
    expect((await f.request("/api/projects")).status).toBe(200);
    expect(await f.hub.projects.list()).toHaveLength(0);
  });

  it("creates and updates projects, binds conversations, and synchronizes guarded deletion to both clients", async () => {
    const f = await fixture();
    const clients = await Promise.all([client(f.server.clientWsUrl), client(f.server.clientWsUrl)]);
    const workspaceDir = path.join(f.directory, "projects", "created-directory");
    const input = { commandId: "http-project", name: "HTTP project", deviceId: "local", workspaceDir, createDirectory: true };
    const createdResponse = await f.request("/api/projects", "POST", input);
    expect(createdResponse.status).toBe(201);
    const { project } = await createdResponse.json() as { project: ProjectView };
    expect(project).toMatchObject({ deviceId: "local", workspaceDir });
    expect(fs.statSync(workspaceDir).isDirectory()).toBe(true);
    const duplicate = await f.request("/api/projects", "POST", input);
    expect((await duplicate.json() as { project: ProjectView }).project.id).toBe(project.id);
    await Promise.all(clients.map((connection) => connection.waitFor("hub.projects", (message) => message.projects.some((item) => item.id === project.id))));

    const renamedResponse = await f.request(`/api/projects/${project.id}`, "PATCH", { name: "Renamed project", expectedRevision: project.revision });
    expect(renamedResponse.status).toBe(200);
    const renamed = (await renamedResponse.json() as { project: ProjectView }).project;
    expect(renamed.revision).toBeGreaterThan(project.revision);
    const stale = await f.request(`/api/projects/${project.id}`, "PATCH", { name: "Stale edit", expectedRevision: project.revision });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "project_revision_conflict" });
    await Promise.all(clients.map((connection) => connection.waitFor("hub.projects", (message) => message.projects.some((item) => item.id === project.id && item.name === "Renamed project"))));

    const topicResponse = await f.request("/api/topics", "POST", { title: "Project conversation", projectId: project.id });
    expect(topicResponse.status).toBe(200);
    const topic = await topicResponse.json() as TopicSummary;
    expect(topic.projectId).toBe(project.id);
    await Promise.all(clients.map((connection) => connection.waitFor("hub.topics", (message) => message.topics.some((item) => item.id === topic.id && item.projectId === project.id))));
    expect((await (await f.request("/api/topics")).json() as { items: TopicSummary[] }).items).toContainEqual(expect.objectContaining({ id: topic.id, projectId: project.id }));

    const worker = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "openai", modelId: "project-http-model" } } }, context);
    const preservedFile = path.join(workspaceDir, "keep.txt");
    fs.writeFileSync(preservedFile, "project files survive removal\n");
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-HTTP"] = {
        id: "T-HTTP", commandId: "http-waiting-ticket", title: "Waiting task", goal: "Wait for approval", scope: "project", role: "coder",
        status: "waiting", waiting: { reason: "user", since: Date.now() }, runEpoch: 1,
        projectId: project.id, directoryId: project.directoryId, grantRevision: project.grantRevision, projectRevision: project.revision,
        envId: "local", workspaceDir, scratchDir: path.join(project.scratchRoot!, "T-HTTP"), workerConversationId: Number(worker.id),
        originTopicId: topic.id, originConversationId: topic.conversationId, createdAt: Date.now(), updatedAt: Date.now(),
      };
      state.conversationToTicket[String(worker.id)] = "T-HTTP";
    }, context);
    const rejected = await f.request(`/api/projects/${project.id}`, "DELETE", {});
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "project_tasks_running", ticketIds: ["T-HTTP"] });
    expect((await f.hub.harness.snapshot(KuloStateDoc, context))?.tickets["T-HTTP"]?.status).toBe("waiting");
    const cursors = clients.map((connection) => connection.mark());
    const removed = await f.request(`/api/projects/${project.id}`, "DELETE", { stopTasks: true });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ deleted: project.id, cleanupPending: false });
    const state = await f.hub.harness.snapshot(KuloStateDoc, context);
    expect(state?.tickets["T-HTTP"]?.status).toBe("stopped");
    expect(state?.topics?.[topic.id]?.deletedAt).toEqual(expect.any(Number));
    expect(fs.readFileSync(preservedFile, "utf8")).toBe("project files survive removal\n");
    expect(await (await f.request("/api/projects")).json()).toMatchObject({ projects: [] });
    await Promise.all(clients.flatMap((connection, index) => [
      connection.waitFor("hub.projects", (message) => !message.projects.some((item) => item.id === project.id), cursors[index]),
      connection.waitFor("hub.topics", (message) => !message.topics.some((item) => item.id === topic.id), cursors[index]),
    ]));
  });

  it("browses and authorizes the selected remote Env through the directory HTTP route", async () => {
    const f = await fixture();
    const remoteRoot = path.join(f.directory, "remote-runtime");
    const parent = path.join(f.directory, "remote-projects");
    const workspaceDir = path.join(parent, "existing-project");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "existing.txt"), "existing remote files");
    const remote = new KuloEnvAgent({ hubUrl: f.server.envWsUrl, envId: "remote", rootDir: remoteRoot, authToken: nodeToken, reconnect: false });
    cleanups.push(() => remote.stop());
    await remote.start();
    const directories = await f.request(`/api/projects/directories?deviceId=remote&path=${encodeURIComponent(parent)}`);
    expect(directories.status).toBe(200);
    expect(await directories.json() as ProjectDirectoryListing).toMatchObject({ deviceId: "remote", path: parent, entries: [{ name: "existing-project", path: workspaceDir }] });
    const created = await f.request("/api/projects", "POST", { commandId: "remote-http-project", name: "Remote project", deviceId: "remote", workspaceDir });
    expect(created.status).toBe(201);
    const project = (await created.json() as { project: ProjectView }).project;
    expect(project).toMatchObject({ deviceId: "remote", workspaceDir });
    expect(project.directoryId).toBeTruthy();
    const listing = await (await f.request("/api/projects")).json() as { projects: ProjectView[] };
    expect(listing.projects).toContainEqual(expect.objectContaining({ id: project.id, deviceId: "remote" }));
    expect((await f.request(`/api/projects/${project.id}`, "DELETE", {})).status).toBe(200);
    expect(fs.readFileSync(path.join(workspaceDir, "existing.txt"), "utf8")).toBe("existing remote files");
  });

  it("rejects malformed project and project-conversation request bodies", async () => {
    const f = await fixture();
    for (const body of [null, []]) {
      for (const [route, method] of [["/api/projects", "POST"], ["/api/projects/missing", "PATCH"], ["/api/projects/missing", "DELETE"], ["/api/topics", "POST"]]) {
        expect((await f.request(route, method, body)).status).toBe(400);
      }
    }
    expect((await f.request("/api/projects/directories")).status).toBe(400);
    expect((await f.request("/api/topics", "POST", { projectId: 123 })).status).toBe(400);
  });
});
