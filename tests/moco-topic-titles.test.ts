import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MocoHub } from "../packages/hub/src/hub.js";
import { MocoStateDoc } from "../packages/hub/src/state.js";
import { createTopicTitleJob, parseTopicTitle, retryFailedTopicTitle } from "../packages/hub/src/topic-titles.js";
import type { TopicTitleJob } from "../packages/hub/src/state.js";

const directories: string[] = [];
const hubs: MocoHub[] = [];
const titleRequest = (context: TranscriptContext) => context.messages.some((message) => message.role === "system" && JSON.stringify(message).includes("Generate a concise noun-phrase title for this Moco conversation"));
async function until(check: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for title generation");
}
async function fixture(respond: FauxResponseFactory) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-topic-titles-"));
  directories.push(stateDir);
  const faux = fauxProvider({ provider: "title-test", models: [{ id: "test" }] });
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  const init = { models, providerId: "title-test", config: {
    stateDir, enableLocalEnv: true, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "title-test", defaultModel: "test", thinkingLevel: "off" as const },
  } };
  const hub = await openTestHub(init);
  hubs.push(hub);
  return { hub, init, faux };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("first-turn topic titles", () => {
  it("generates once after a completed reply and persists/broadcasts the title without using Worker slots", async () => {
    let titleCalls = 0;
    let prompt = "";
    const { hub, init } = await fixture((ctx) => {
      if (titleRequest(ctx)) { titleCalls++; prompt = JSON.stringify(ctx.messages); return fauxAssistantMessage('{"title":"本机设备连接排查"}'); }
      return fauxAssistantMessage("可以先检查设备连接状态。");
    });
    const updates: string[] = [];
    const topic = await hub.createTopic();
    hub.subscribe({ onTopics: (topics) => { const title = topics.find((item) => item.id === topic.id)?.title; if (title) updates.push(title); } });
    const first = await hub.sendUserMessage("请帮我排查本机设备连接不上Hub的问题", { topicId: topic.id });
    await first.wait(BACKGROUND_CONTEXT);
    await until(async () => (await hub.listTopics()).find((item) => item.id === topic.id)?.title === "本机设备连接排查");
    expect(updates).toContain("本机设备连接排查");
    expect(prompt).toContain("请帮我排查本机设备连接不上Hub的问题");
    expect(prompt).toContain("可以先检查设备连接状态");
    expect((await hub.harness.snapshot(MocoStateDoc))?.slots.holders).toEqual([]);
    expect((await hub.getTopicView(topic.id)).messages.filter((item) => item.role === "assistant")).toHaveLength(1);
    await hub.sendUserMessage("接下来检查网络", { topicId: topic.id });
    await until(async () => !(await hub.getTopicView(topic.id)).live.busy);
    expect(titleCalls).toBe(1);
    await hub.close();
    const reopened = await openTestHub(init);
    hubs.push(reopened);
    expect((await reopened.listTopics()).find((item) => item.id === topic.id)?.title).toBe("本机设备连接排查");
    expect(titleCalls).toBe(1);
  });

  it.each(["自定义会话名称", "请帮我排查本机设备连接的问题"]) ("preserves a manual rename while the title request is in flight: %s", async (manualTitle) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let titleCalls = 0;
    let titleReturned = false;
    const { hub } = await fixture(async (ctx) => {
      if (titleRequest(ctx)) {
        titleCalls++; await gate; titleReturned = true; return fauxAssistantMessage('{"title":"不能覆盖手动标题"}');
      }
      return fauxAssistantMessage("可以，我们先检查连接。");
    });
    const topic = await hub.createTopic();
    try {
      await hub.sendUserMessage("请帮我排查本机设备连接的问题", { topicId: topic.id });
      await until(() => titleCalls === 1);
      // Renaming to the fallback itself is still an explicit user decision.
      const fallback = (await hub.listTopics()).find((item) => item.id === topic.id)!.title;
      const title = manualTitle.startsWith("请帮我") ? fallback : manualTitle;
      await hub.patchTopic(topic.id, { title });
      release();
      await until(() => titleReturned);
      await until(async () => !(await hub.harness.inspect(BACKGROUND_CONTEXT)).submissions.length);
      await until(async () => (await hub.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status === "cancelled");
      expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe(title);
    } finally { release(); }
  });

  it("does not apply a late title after a conversation is deleted and restored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let generating = false;
    const { hub } = await fixture(async (ctx) => {
      if (titleRequest(ctx)) { generating = true; await gate; return fauxAssistantMessage('{"title":"迟到的标题"}'); }
      return fauxAssistantMessage("先检查设备状态。");
    });
    const topic = await hub.createTopic();
    try {
      await hub.sendUserMessage("排查这台设备的连接问题", { topicId: topic.id });
      await until(() => generating);
      const fallback = (await hub.listTopics()).find((item) => item.id === topic.id)!.title;
      await hub.deleteTopic(topic.id);
      await hub.projects.restoreTopic(topic.id);
      release();
      await until(async () => !(await hub.harness.inspect(BACKGROUND_CONTEXT)).submissions.length);
      expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe(fallback);
      expect((await hub.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status).toBe("cancelled");
    } finally { release(); }
  });

  it("does not retry a failed title after deleting, restoring and restarting its conversation", async () => {
    let titleCalls = 0;
    const { hub, init } = await fixture((ctx) => {
      if (titleRequest(ctx)) {
        titleCalls++;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture title provider unavailable" });
      }
      return fauxAssistantMessage("先检查设备状态。");
    });
    const topic = await hub.createTopic();
    await hub.sendUserMessage("排查这台设备的连接问题", { topicId: topic.id });
    await until(async () => (await hub.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status === "failed");
    const fallback = (await hub.listTopics()).find((item) => item.id === topic.id)!.title;
    await hub.deleteTopic(topic.id);
    expect((await hub.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status).toBe("cancelled");
    await hub.projects.restoreTopic(topic.id);
    await hub.close();
    const reopened = await openTestHub(init);
    hubs.push(reopened);
    expect((await reopened.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status).toBe("cancelled");
    expect((await reopened.listTopics()).find((item) => item.id === topic.id)?.title).toBe(fallback);
    expect(titleCalls).toBe(1);
  });

  it("keeps Hub startup available when a title's source project is temporarily unavailable", async () => {
    const { hub, init } = await fixture(() => fauxAssistantMessage("不应调用模型"));
    const topic = await hub.createTopic();
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.topics![topic.id]!.projectId = "missing-project";
      state.topicTitles = { [topic.id]: { status: "pending", fallbackTitle: topic.title, userText: "排查设备连接", attachmentNames: [] } };
    }, BACKGROUND_CONTEXT);
    await hub.close();
    const reopened = await openTestHub(init);
    hubs.push(reopened);
    expect((await reopened.listTopics()).find((item) => item.id === topic.id)).toBeDefined();
    expect((await reopened.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status).toBe("pending");
  });

  it.each(["不是JSON", '{"title":null}']) ("keeps the immediate fallback when generation cannot produce a title: %s", async (raw) => {
    const { hub } = await fixture((ctx) => fauxAssistantMessage(titleRequest(ctx) ? raw : "我会先检查设备状态。"));
    const topic = await hub.createTopic();
    await hub.sendUserMessage("请帮我排查设备连接问题", { topicId: topic.id });
    await until(async () => (await hub.harness.snapshot(MocoStateDoc))?.topicTitles?.[topic.id]?.status !== "pending");
    expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe("请帮我排查设备连接问题");
  });

  it("recovers a completed title submission after restart without issuing another model request", async () => {
    const { hub, init, faux } = await fixture(() => fauxAssistantMessage('{"title":"恢复设备连接"}'));
    const topic = await hub.createTopic();
    const conversation = await hub.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      model: { provider: "title-test", modelId: "test" }, thinkingLevel: "off", extensions: [], tools: [], maxTurns: 1,
    } }, BACKGROUND_CONTEXT);
    const context = BACKGROUND_CONTEXT;
    const submission = await conversation.submit({ type: "input", requestId: `moco:topic-title:${topic.id}`, content: "生成标题" }, context);
    await submission.wait(context);
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.topics![topic.id]!.title = "临时标题";
      delete state.topics![topic.id]!.draft;
      state.topicTitles = { [topic.id]: { status: "pending", fallbackTitle: "临时标题", userText: "排查设备连接", attachmentNames: [], assistantText: "先检查网络", conversationId: Number(conversation.id) } };
    }, context);
    const calls = faux.state.callCount;
    await hub.close();
    const reopened = await openTestHub(init);
    hubs.push(reopened);
    await until(async () => (await reopened.listTopics()).find((item) => item.id === topic.id)?.title === "恢复设备连接");
    expect(faux.state.callCount).toBe(calls);
  });

  it("skips low-information messages and explicitly named topics", async () => {
    let titleCalls = 0;
    const { hub } = await fixture((ctx) => { if (titleRequest(ctx)) titleCalls++; return fauxAssistantMessage("在呢。"); });
    for (const [name, text] of [[undefined, "222"], [undefined, "你好"], ["手动名称", "帮我排查设备连接"]] as const) {
      const topic = await hub.createTopic(name);
      await hub.sendUserMessage(text, { topicId: topic.id });
      await until(async () => !(await hub.getTopicView(topic.id)).live.busy);
      expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe(name ?? text);
    }
    expect(titleCalls).toBe(0);
  });
});

describe("title response boundaries", () => {
  it("admits one restart retry for legacy failures and never retries invalid output", () => {
    const legacy: TopicTitleJob = { status: "failed", fallbackTitle: "设备连接", userText: "设备连接", attachmentNames: [], conversationId: 42 };
    retryFailedTopicTitle(legacy);
    expect(legacy).toMatchObject({ status: "pending", retryCount: 1 });
    expect(legacy.conversationId).toBeUndefined();
    legacy.status = "failed"; legacy.conversationId = 43;
    retryFailedTopicTitle(legacy);
    expect(legacy).toMatchObject({ status: "failed", retryCount: 1, conversationId: 43 });
    const invalid: TopicTitleJob = { ...legacy, retryCount: 0, failure: { code: "invalid_response", message: "Invalid response" } };
    retryFailedTopicTitle(invalid);
    expect(invalid.status).toBe("failed");
  });

  it("accepts bounded JSON and rejects prose, multiline and oversized titles", () => {
    expect(parseTopicTitle('```json\n{"title":"设备连接排查"}\n```')).toBe("设备连接排查");
    for (const raw of ["直接输出标题", '{"title":true}', '{"title":"一行\\n两行"}', JSON.stringify({ title: "长".repeat(49) })]) expect(() => parseTopicTitle(raw)).toThrow();
    expect(createTopicTitleJob("123...", [], "123...")).toBeUndefined();
    expect(createTopicTitleJob("", ["screenshot.png"], "screenshot.png")).toBeDefined();
  });
});
