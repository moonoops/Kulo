import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { InboxDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import type { TicketRecord, TopicSummary } from "@kulo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { KuloHub } from "../packages/hub/src/hub.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { KuloSettingsDoc, applySettingsBlockUpdate, hydrateSettingsFromConfig, rollbackSettingsToSnapshot, toPublicSettingsView } from "../packages/hub/src/settings.js";
import { openTestHub } from "./helpers/secure-hub.js";

const DAY = 86_400_000;
const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const hubs: KuloHub[] = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function settings() {
  const doc = KuloSettingsDoc.definition.initial();
  hydrateSettingsFromConfig(doc, resolveHubConfig({ enableLocalEnv: false }));
  return doc;
}

async function fixture(stateDir?: string) {
  if (!stateDir) {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-auto-archive-"));
    directories.push(stateDir);
  }
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "archive-test" }] });
  models.setProvider(faux.provider);
  const hub = await openTestHub({ models, config: { stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "archive-test", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" } } });
  hubs.push(hub);
  const topic = (title: string) => hub.createTopic(title);
  const age = async (topics: TopicSummary[], days = 8) => {
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      for (const item of topics) state.topics![item.id]!.updatedAt = Date.now() - days * DAY;
    }, context);
  };
  const configure = async (patch: { autoArchiveEnabled?: boolean; autoArchiveDays?: number }) => {
    const executor = hub.getSettingsView().blocks.executor;
    return hub.updateSettingsBlock("executor", executor.revision, { ...executor.value, ...patch });
  };
  return { hub, faux, stateDir, topic, age, configure };
}

describe("automatic archive settings", () => {
  it("defaults new and legacy settings to enabled after seven days", () => {
    const doc = settings();
    expect(doc.executor).toMatchObject({ autoArchiveEnabled: true, autoArchiveDays: 7 });
    delete doc.executor.autoArchiveEnabled;
    delete doc.executor.autoArchiveDays;
    expect(toPublicSettingsView(doc, "/tmp/identity").blocks.executor.value).toMatchObject({ autoArchiveEnabled: true, autoArchiveDays: 7 });
    hydrateSettingsFromConfig(doc, resolveHubConfig({ enableLocalEnv: false }));
    expect(doc.executor).toMatchObject({ autoArchiveEnabled: true, autoArchiveDays: 7 });
  });

  it("preserves explicit preferences on older clients, enforces CAS and restores history", () => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...doc.executor, autoArchiveEnabled: false, autoArchiveDays: 30 });
    const { autoArchiveEnabled: _enabled, autoArchiveDays: _days, ...legacy } = doc.executor;
    applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...legacy, maxConcurrentWorkers: 4 });
    expect(doc.executor).toMatchObject({ autoArchiveEnabled: false, autoArchiveDays: 30 });
    expect(() => applySettingsBlockUpdate(doc, "executor", 1, { ...doc.executor, autoArchiveDays: 2 })).toThrow("已被其他操作更新");
    rollbackSettingsToSnapshot(doc, doc.snapshots[0]!.revision, doc.globalRevision);
    expect(doc.executor).toMatchObject({ autoArchiveEnabled: true, autoArchiveDays: 7 });
  });

  it.each([0, -1, 1.5, 3651, Infinity, NaN, "7", null, true, {}])("rejects invalid day values without modifying settings: %j", (autoArchiveDays) => {
    const doc = settings();
    const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...doc.executor, autoArchiveDays })).toThrow("自动归档天数");
    expect(doc).toEqual(before);
  });

  it.each([0, "false", null, {}])("rejects non-boolean switches: %j", (autoArchiveEnabled) => {
    const doc = settings();
    const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...doc.executor, autoArchiveEnabled })).toThrow("自动归档开关");
    expect(doc).toEqual(before);
  });
});

describe("automatic topic archive", () => {
  it("archives ordinary and project topics, broadcasts changes, and preserves history and all main identities", async () => {
    const f = await fixture();
    const ordinary = await f.topic("普通话题");
    const project = await f.topic("项目话题");
    const master = await f.topic("另一个主会话标记");
    const recent = await f.topic("最近活动");
    const deleted = await f.topic("已删除");
    const now = Date.now();
    await f.age([ordinary, project, master, deleted]);
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.topics![project.id]!.projectId = "project-archive-test";
      state.topics![master.id]!.master = true;
      state.topics![deleted.id]!.deletedAt = now;
      state.topics!.root!.updatedAt = now - 100 * DAY;
      delete state.topics!.root!.master;
      await tx.appendEntry(ordinary.conversationId as ConversationId, { kind: "kulo.user", data: { kuloContentVersion: 1, text: "保留的消息", attachments: [], createdAt: now - 8 * DAY },
        model: [{ role: "user", content: "保留的消息", timestamp: now - 8 * DAY }] });
    }, context);
    const changes: TopicSummary[][] = [];
    const unsubscribe = f.hub.subscribe({ onTopics: (topics) => changes.push(topics) });
    const archived = await f.hub.archiveInactiveTopics();
    unsubscribe();
    expect(archived.map((item) => item.id).sort()).toEqual([ordinary.id, project.id].sort());
    expect(changes).toHaveLength(1);
    expect(changes[0]!.filter((item) => item.archived).map((item) => item.id).sort()).toEqual([ordinary.id, project.id].sort());
    const topics = await f.hub.listTopics();
    for (const id of ["root", master.id, recent.id]) expect(topics.find((item) => item.id === id)?.archived).not.toBe(true);
    expect((await f.hub.getTopicView(ordinary.id)).messages.some((item) => item.text === "保留的消息")).toBe(true);
    await expect(f.hub.patchTopic("root", { archived: true })).rejects.toThrow("主对话不可归档");
    await expect(f.hub.deleteTopic("root")).rejects.toThrow("主对话不可删除");
  });

  it("respects disable/custom threshold and grants restored topics a fresh interval", async () => {
    const f = await fixture();
    await f.configure({ autoArchiveEnabled: false, autoArchiveDays: 10 });
    const topic = await f.topic("等待恢复");
    await f.age([topic]);
    expect(await f.hub.archiveInactiveTopics()).toEqual([]);
    await f.configure({ autoArchiveEnabled: true });
    expect((await f.hub.listTopics()).find((item) => item.id === topic.id)?.archived).not.toBe(true);
    await f.configure({ autoArchiveDays: 3 });
    expect((await f.hub.listTopics()).find((item) => item.id === topic.id)?.archived).toBe(true);
    await f.hub.patchTopic(topic.id, { archived: false });
    expect(await f.hub.archiveInactiveTopics()).toEqual([]);
    expect((await f.hub.listTopics()).find((item) => item.id === topic.id)).toMatchObject({ archived: false, title: "等待恢复" });
  });

  it("keeps all unfinished task topics, queued input, recent automatic messages and recent task work visible", async () => {
    const f = await fixture();
    const statuses = ["queued", "running", "pausing", "waiting", "blocked"] as const;
    const unfinished = await Promise.all(statuses.map((status) => f.topic(status)));
    const queued = await f.topic("排队消息");
    const recentMessage = await f.topic("最近自动消息");
    const recentTask = await f.topic("最近完成的任务");
    const idle = await f.topic("可归档");
    await f.age([...unfinished, queued, recentMessage, recentTask, idle]);
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      for (const [i, topic] of [...unfinished, recentTask].entries()) {
        const status = statuses[i] ?? "ready";
        state.tickets[`T-${i}`] = { id: `T-${i}`, commandId: `T-${i}`, title: topic.title, goal: "test", scope: "test", role: "coder", status,
          envId: "offline", workspaceDir: "/tmp/test", workerConversationId: 5000 + i, runEpoch: 1,
          createdAt: Date.now() - 8 * DAY, updatedAt: status === "ready" ? Date.now() : Date.now() - 8 * DAY,
          originTopicId: topic.id, originConversationId: topic.conversationId } satisfies TicketRecord;
      }
      const inbox = await tx.doc(InboxDoc, queued.conversationId as ConversationId);
      inbox.items.push({ id: 999 as SubmissionId, mode: "followUp", content: "等待处理" });
      await tx.appendEntry(recentMessage.conversationId as ConversationId, { kind: "kulo.user", data: { text: "新消息", createdAt: Date.now() } });
    }, context);
    expect((await f.hub.archiveInactiveTopics()).map((topic) => topic.id)).toEqual([idle.id]);
    // Synthetic pending inputs are not scheduler submissions and must be removed before shutdown.
    await f.hub.harness.commit(async (tx) => { (await tx.doc(InboxDoc, queued.conversationId as ConversationId)).items = []; }, context);
  });

  it("protects a live reply and records completion activity before the next archive check", async () => {
    const f = await fixture();
    const topic = await f.topic("长时间回复");
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    f.faux.setResponses([async () => { started(); await gate; return fauxAssistantMessage("完成"); }]);
    try {
      const submission = await f.hub.sendUserMessage("处理请求", { topicId: topic.id });
      await running;
      await f.age([topic]);
      expect(await f.hub.archiveInactiveTopics()).toEqual([]);
      finish();
      await submission.wait(context);
      await vi.waitFor(async () => expect((await f.hub.listTopics()).find((item) => item.id === topic.id)!.updatedAt).toBeGreaterThan(Date.now() - DAY));
      expect(await f.hub.archiveInactiveTopics()).toEqual([]);
    } finally { finish(); }
  });

  it("runs periodic checks and archives persisted old topics on startup while preserving disabled settings", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const f = await fixture();
    const periodic = await f.topic("定时检查");
    await f.age([periodic]);
    const callback = intervals.mock.calls.findLast((call) => call[1] === 60_000)?.[0];
    expect(typeof callback).toBe("function");
    (callback as () => void)();
    await vi.waitFor(async () => expect((await f.hub.listTopics()).find((topic) => topic.id === periodic.id)?.archived).toBe(true));
    await f.configure({ autoArchiveEnabled: false, autoArchiveDays: 2 });
    const startup = await f.topic("重启检查");
    await f.age([startup]);
    await f.hub.close();
    hubs.splice(hubs.indexOf(f.hub), 1);
    const reopened = await fixture(f.stateDir);
    expect(reopened.hub.getSettingsView().blocks.executor.value).toMatchObject({ autoArchiveEnabled: false, autoArchiveDays: 2 });
    expect((await reopened.hub.listTopics()).find((topic) => topic.id === startup.id)?.archived).not.toBe(true);
    // Persist an enabled policy without a live-settings sweep, then let startup apply it.
    await reopened.hub.harness.commit(async (tx) => { (await tx.doc(KuloSettingsDoc)).executor.autoArchiveEnabled = true; }, context);
    await reopened.hub.close();
    hubs.splice(hubs.indexOf(reopened.hub), 1);
    const enabled = await fixture(f.stateDir);
    expect((await enabled.hub.listTopics()).find((topic) => topic.id === startup.id)?.archived).toBe(true);
    expect((await enabled.hub.listTopics()).find((topic) => topic.id === "root")?.archived).not.toBe(true);
  });
});
