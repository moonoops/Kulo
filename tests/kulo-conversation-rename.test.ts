import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ToolResultEntry, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-conversation-rename-"));
  cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "conversation-rename", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const init = { models, config: {
    stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "conversation-rename", defaultModel: "test", thinkingLevel: "off" as const },
  } };
  const hub = await openTestHub(init);
  cleanups.push(() => hub.close());
  return { hub, faux, init };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("current conversation rename tool", () => {
  it.each(["root", "topic"])("renames the current %s conversation, broadcasts and persists it", async (kind) => {
    const { hub, faux, init } = await fixture();
    const other = await hub.createTopic("其他会话");
    const topic = kind === "root" ? (await hub.listTopics()).find((item) => item.id === "root")! : await hub.createTopic("原会话");
    const updates: string[] = [];
    hub.subscribe({ onTopics: (topics) => {
      const title = topics.find((item) => item.id === topic.id)?.title;
      if (title) updates.push(title);
    } });
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_conversation_rename", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_conversation_rename", { title: "  局域网设备统计  " })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("已修改会话标题。"),
    ]);
    const submission = await hub.sendUserMessage("把当前会话改名为局域网设备统计", { topicId: topic.id });
    await submission.wait(BACKGROUND_CONTEXT);
    expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe("局域网设备统计");
    expect((await hub.listTopics()).find((item) => item.id === other.id)?.title).toBe("其他会话");
    expect(updates).toContain("局域网设备统计");
    await hub.close();
    const reopened = await openTestHub(init);
    cleanups.push(() => reopened.close());
    expect((await reopened.listTopics()).find((item) => item.id === topic.id)?.title).toBe("局域网设备统计");
  });

  it.each(["pending", "failed"] as const)("cancels a %s automatic title even when renamed to the existing fallback", async (status) => {
    const { hub, faux } = await fixture();
    const topic = await hub.createTopic("局域网设备统计");
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.topicTitles ??= {};
      state.topicTitles[topic.id] = { status, fallbackTitle: topic.title, userText: "统计设备", attachmentNames: [] };
    }, BACKGROUND_CONTEXT);
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_conversation_rename", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_conversation_rename", { title: topic.title })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("已保留这个标题。"),
    ]);
    const submission = await hub.sendUserMessage("保留当前会话标题", { topicId: topic.id });
    await submission.wait(BACKGROUND_CONTEXT);
    expect((await hub.harness.snapshot(KuloStateDoc))?.topicTitles?.[topic.id]?.status).toBe("cancelled");
    expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe(topic.title);
  });

  it("rejects an empty title without changing the current conversation", async () => {
    const { hub, faux } = await fixture();
    const topic = await hub.createTopic("保留标题");
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_conversation_rename", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_conversation_rename", { title: "   " })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("请提供标题。"),
    ]);
    const submission = await hub.sendUserMessage("改名", { topicId: topic.id });
    await submission.wait(BACKGROUND_CONTEXT);
    expect((await hub.listTopics()).find((item) => item.id === topic.id)?.title).toBe(topic.title);
    const conversation = await hub.harness.conversation(topic.conversationId as ConversationId, BACKGROUND_CONTEXT);
    const entries = await conversation!.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries.items.filter(ToolResultEntry.is))).toContain("会话名称无效");
  });

  it("does not let an extra target argument rename another conversation", async () => {
    const { hub, faux } = await fixture();
    const current = await hub.createTopic("当前会话");
    const other = await hub.createTopic("其他会话");
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_conversation_rename", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_conversation_rename", { title: "新标题", topic_id: other.id })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ]);
    const submission = await hub.sendUserMessage("重命名", { topicId: current.id });
    await submission.wait(BACKGROUND_CONTEXT);
    expect((await hub.listTopics()).find((item) => item.id === other.id)?.title).toBe(other.title);
  });
});
