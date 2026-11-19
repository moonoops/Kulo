import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { KuloHub, KuloStateDoc } from "@kulo/hub";
import { SettingsAssistantDoc } from "../packages/hub/src/settings-assistant.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const context = { module: "machines" as const, hasUnsavedChanges: false, appearance: "dark" as const, clientId: "settings-title-client" };

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((filename) => path.basename(String(filename)) === ".env" ? false : exists(filename));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function until(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 8000, interval: 20 });
}

async function fixture(respondTitle: FauxResponseFactory, respondMain: FauxResponseFactory = () => fauxAssistantMessage("可以先检查设备连接和网络状态。")) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-settings-titles-")));
  cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "settings-title-test", models: [{ id: "test" }] });
  provider.setResponses(Array.from({ length: 30 }, () => respondMain));
  const requests: TranscriptContext[] = [];
  const models = createModels();
  models.setProvider(routeSettingsTitleRequests(provider, (ctx, options, state, model) => { requests.push(ctx); return respondTitle(ctx, options, state, model); }));
  const init = { models, providerId: "settings-title-test", config: {
    stateDir, identityDir: path.join(stateDir, "identity"), enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "settings-title-test", defaultModel: "test", thinkingLevel: "off" as const },
  } };
  let hub = await openTestHub(init);
  cleanups.push(() => hub.close());
  const reopen = async () => { await hub.close(); hub = await openTestHub(init); return hub; };
  return { get hub() { return hub; }, init, provider, requests, reopen };
}

async function sendFirst(hub: KuloHub, text = "请帮我排查本机设备连接不上 Hub 的问题") {
  await hub.settingsAssistant.send(text, context, "first-title-turn");
  await until(async () => {
    const snapshot = await hub.settingsAssistant.getSnapshot();
    return !snapshot.live.busy && snapshot.messages.some((message) => message.role === "assistant");
  });
  return (await hub.settingsAssistant.getSnapshot()).topicId!;
}

describe("settings session first-exchange titles", () => {
  it("generates a concise title once from the first exchange without blocking replies or reordering history", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mainCalls = 0;
    const f = await fixture(async () => { await gate; return fauxAssistantMessage('{"title":"本机设备连接排查"}'); }, () => fauxAssistantMessage(++mainCalls === 1 ? "先检查设备连接和本机网络。" : "第二轮请检查端口。"));
    try {
      const first = await sendFirst(f.hub);
      await until(() => f.requests.length === 1);
      const reply = await f.hub.settingsAssistant.getSnapshot();
      expect(reply.live.busy).toBe(false);
      expect(reply.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      await f.hub.settingsAssistant.newConversation(first, "another-settings-session");
      const second = (await f.hub.settingsAssistant.getSnapshot()).topicId!;
      await f.hub.settingsAssistant.selectConversation(first, second);
      await f.hub.settingsAssistant.send("第二轮补充：不要把这句话写进首轮标题", context, "second-title-turn");
      await until(async () => !(await f.hub.settingsAssistant.getSnapshot()).live.busy);
      const before = (await f.hub.settingsAssistant.getSnapshot()).conversations.map(({ topicId, updatedAt }) => ({ topicId, updatedAt }));
      const prompt = JSON.stringify(f.requests[0]!.messages);
      expect(prompt).toContain("请帮我排查本机设备连接不上 Hub 的问题");
      expect(prompt).toContain("先检查设备连接和本机网络");
      expect(prompt).not.toContain("第二轮补充");
      release();
      await until(async () => (await f.hub.settingsAssistant.getSnapshot()).conversations.find((item) => item.topicId === first)?.title === "本机设备连接排查");
      const after = await f.hub.settingsAssistant.getSnapshot();
      expect(after.conversations.map(({ topicId, updatedAt }) => ({ topicId, updatedAt }))).toEqual(before);
      expect(after.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
      expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.slots.holders).toEqual([]);
      expect((await f.hub.listTopics()).map((item) => item.id)).toEqual(["root"]);
      const job = (await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))!.titleJobs![first.slice(9)]!;
      expect(job.status).toBe("done");
      expect(await f.hub.settingsAssistant.conversationIds()).toContain(job.conversationId);
      expect(after.conversations.some((item) => item.topicId === `settings-${job.conversationId}`)).toBe(false);
      await f.reopen();
      expect((await f.hub.settingsAssistant.getSnapshot()).conversations.find((item) => item.topicId === first)?.title).toBe("本机设备连接排查");
      expect(f.requests).toHaveLength(1);
    } finally { release(); }
  });

  it.each(['{"title":null}', "不是 JSON"])("keeps a safe short fallback after title output %s and never regenerates it", async (raw) => {
    const f = await fixture(() => fauxAssistantMessage(raw));
    const id = await sendFirst(f.hub);
    await until(async () => (await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.titleJobs?.[id.slice(9)]?.status !== "pending");
    const fallback = (await f.hub.settingsAssistant.getSnapshot()).conversations[0]!.title;
    expect(Array.from(fallback).length).toBeLessThanOrEqual(24);
    await f.hub.settingsAssistant.send("继续检查设备状态", context, "after-failed-title");
    await until(async () => !(await f.hub.settingsAssistant.getSnapshot()).live.busy);
    expect((await f.hub.settingsAssistant.getSnapshot()).conversations[0]!.title).toBe(fallback);
    await f.reopen();
    expect(f.requests).toHaveLength(1);
  });

  it("redacts first-turn inputs and generated titles with the owning credential redactor", async () => {
    const secret = "settings-title-dummy-secret-45218";
    const f = await fixture(() => fauxAssistantMessage(JSON.stringify({ title: `连接 ${secret}` })));
    const id = await sendFirst(f.hub, `请保存账号：demo，密码：${secret}，网站 https://example.test/login`);
    await until(async () => (await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.titleJobs?.[id.slice(9)]?.status === "done");
    expect(JSON.stringify(f.requests)).not.toContain(secret);
    expect(JSON.stringify(await f.hub.settingsAssistant.getSnapshot())).not.toContain(secret);
    const state = await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(state!.conversations![id.slice(9)]!.view.title).toContain("[已隐藏]");
  });

  it.each([false, true])("fences a late title after deleting a session (active=%s)", async (active) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(async () => { await gate; return fauxAssistantMessage('{"title":"不能复活的迟到标题"}'); });
    try {
      const id = await sendFirst(f.hub);
      await until(() => f.requests.length === 1);
      if (!active) await f.hub.settingsAssistant.newConversation(id, "new-before-delete");
      const selected = (await f.hub.settingsAssistant.getSnapshot()).topicId;
      await f.hub.settingsAssistant.deleteConversation(id, selected, "delete-pending-title");
      const expected = active ? null : selected;
      expect(await f.hub.settingsAssistant.getSnapshot()).toMatchObject({ topicId: expected, messages: [] });
      release();
      await until(async () => !(await f.hub.harness.inspect(BACKGROUND_CONTEXT)).submissions.length);
      expect((await f.hub.settingsAssistant.getSnapshot()).conversations.some((item) => item.topicId === id)).toBe(false);
      expect((await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.titleJobs?.[id.slice(9)]?.status).toBe("cancelled");
      await f.reopen();
      expect((await f.hub.settingsAssistant.getSnapshot()).conversations.some((item) => item.topicId === id)).toBe(false);
      expect(f.requests).toHaveLength(1);
    } finally { release(); }
  });

  it("recovers an admitted completed title submission without another model request", async () => {
    const f = await fixture(() => fauxAssistantMessage('{"title":"恢复设备连接标题"}'));
    const source = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "settings-title-test", modelId: "test" }, extensions: [], tools: [], maxTurns: 1 } }, BACKGROUND_CONTEXT);
    const first = await source.submit({ type: "input", content: "排查连接问题" }, BACKGROUND_CONTEXT);
    await first.wait(BACKGROUND_CONTEXT);
    const titleConversation = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "settings-title-test", modelId: "test" }, extensions: [], tools: [], maxTurns: 1, instructions: "This is a Settings Assistant session title" } }, BACKGROUND_CONTEXT);
    const submission = await titleConversation.submit({ type: "input", requestId: `kulo:settings-title:${Number(source.id)}`, content: "恢复标题任务" }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    const id = Number(source.id);
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      state.conversationId = id;
      state.conversations = { [String(id)]: { view: { topicId: `settings-${id}`, title: "临时标题", createdAt: 1, updatedAt: 1 }, actions: [], turnContext: null, observedRevisions: {} } };
      state.titleJobs = { [String(id)]: { status: "pending", fallbackTitle: "临时标题", userText: "排查连接问题", attachmentNames: [], assistantText: "先检查设备网络", conversationId: Number(titleConversation.id) } };
    }, BACKGROUND_CONTEXT);
    const calls = f.provider.state.callCount;
    await f.reopen();
    await until(async () => (await f.hub.settingsAssistant.getSnapshot()).conversations.find((item) => item.topicId === `settings-${id}`)?.title === "恢复设备连接标题");
    expect(f.requests).toHaveLength(1);
    expect(f.provider.state.callCount).toBe(calls);
  });

  it("resumes an inactive pending first-exchange title after restart without selecting the session", async () => {
    const f = await fixture(() => fauxAssistantMessage('{"title":"历史设备连接排查"}'));
    await f.hub.settingsAssistant.newConversation(null, "active-empty-session");
    const active = (await f.hub.settingsAssistant.getSnapshot()).topicId!;
    const source = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "settings-title-test", modelId: "test" }, extensions: [], tools: [], maxTurns: 1 } }, BACKGROUND_CONTEXT);
    const first = await source.submit({ type: "input", content: "排查历史设备连接问题" }, BACKGROUND_CONTEXT);
    await first.wait(BACKGROUND_CONTEXT);
    const id = Number(source.id);
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      state.archivedConversationIds.push(id);
      state.conversations![String(id)] = { view: { topicId: `settings-${id}`, title: "历史首行摘录", createdAt: 1, updatedAt: 1 }, actions: [], turnContext: null, observedRevisions: {} };
      state.titleJobs = { [String(id)]: { status: "pending", fallbackTitle: "历史首行摘录", userText: "排查历史设备连接问题", attachmentNames: [] } };
    }, BACKGROUND_CONTEXT);
    expect(f.requests).toHaveLength(0);
    await f.reopen();
    await until(async () => (await f.hub.settingsAssistant.getSnapshot()).conversations.find((item) => item.topicId === `settings-${id}`)?.title === "历史设备连接排查");
    expect((await f.hub.settingsAssistant.getSnapshot()).topicId).toBe(active);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]!.messages)).toContain("可以先检查设备连接和网络状态");
    expect((await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.conversations?.[String(id)]?.view.updatedAt).toBe(1);
  });

  it.each(['{"title":"旧会话设备连接排查"}', '{"title":null}'])("upgrades an old excerpt only on selection and publishes its generated title or short fallback: %s", async (raw) => {
    const f = await fixture(() => fauxAssistantMessage(raw));
    await f.hub.settingsAssistant.newConversation(null, "current-with-legacy-history");
    const active = (await f.hub.settingsAssistant.getSnapshot()).topicId!;
    const source = await f.hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "settings-title-test", modelId: "test" }, extensions: [], tools: [], maxTurns: 1 } }, BACKGROUND_CONTEXT);
    const submitted = await source.submit({ type: "input", content: "请排查这台设备的连接问题，并解释哪些机器当前可用" }, BACKGROUND_CONTEXT);
    await submitted.wait(BACKGROUND_CONTEXT);
    const id = Number(source.id);
    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(SettingsAssistantDoc);
      state.archivedConversationIds.push(id);
      state.conversations![String(id)] = { view: { topicId: `settings-${id}`, title: "请排查这台设备的连接问题，并解释哪些机器当前可用", createdAt: 1, updatedAt: 1 }, actions: [], turnContext: null, observedRevisions: {} };
    }, BACKGROUND_CONTEXT);
    await f.reopen();
    await f.hub.settingsAssistant.getSnapshot();
    expect(f.requests).toHaveLength(0);
    const published: string[] = [];
    cleanups.push(f.hub.subscribe({ onSettingsAssistant: (snapshot) => {
      const title = snapshot.conversations.find((item) => item.topicId === `settings-${id}`)?.title;
      if (title) published.push(title);
    } }));
    await f.hub.settingsAssistant.selectConversation(`settings-${id}`, active);
    await until(async () => (await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.titleJobs?.[String(id)]?.status === "done");
    const title = (await f.hub.settingsAssistant.getSnapshot()).conversations.find((item) => item.topicId === `settings-${id}`)!.title;
    if (raw.includes("null")) expect(Array.from(title).length).toBeLessThanOrEqual(24);
    else expect(title).toBe("旧会话设备连接排查");
    expect(published).toContain(title);
    expect(f.requests).toHaveLength(1);
    expect((await f.hub.harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.conversations?.[String(id)]?.view.updatedAt).toBe(1);
  });
});
