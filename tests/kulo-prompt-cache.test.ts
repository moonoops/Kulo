import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { collapseSystemMessages, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { CompactionEntry, Harness, MemoryStorage, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { TicketRecord } from "@kulo/protocol";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { extractDisplayMessages } from "../packages/hub/src/hub.js";
import { createOrchestratorSections } from "../packages/hub/src/prompts.js";
import { createRecentWorkSyncHook, isSystemBaselinePending, RecentWorkUpdateEntry } from "../packages/hub/src/recent-work-sync.js";
import { KuloStateDoc, ensureDefaultRootTopic } from "../packages/hub/src/state.js";
import { voiceHistory } from "../packages/hub/src/voice-context.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of close.splice(0)) await stop(); });

describe("personality prompt context", () => {
  it("keeps the full previous transcript prefix and only appends changed relationship or work sections", async () => {
    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "openai", models: [{ id: "cache-model" }] });
    provider.setResponses(Array.from({ length: 5 }, () => (context: TranscriptContext) => {
      requests.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
      return fauxAssistantMessage([fauxText("已收到。")]);
    }));
    const models = createModels(); models.setProvider(provider.provider);
    let relationship = "用户偏好简短交流。";
    const extension = defineExtension({ name: "test-personality-prompt", sections: createOrchestratorSections({
      getIdentityDir: () => "/nonexistent-personality-test",
      getRoles: () => ({}), getEnvs: () => [], getMemoryConfig: () => resolveHubConfig({}).memory,
      getPersonalityContext: async () => ({ identityAgreement: "身份：Kulo；诚实、简洁。", relationship, recentWorkEnabled: true }),
    }) });
    const registry = createRegistry(); registry.install(extension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    close.push(() => harness.close(BACKGROUND_CONTEXT));
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: {
      model: { provider: "openai", modelId: "cache-model" }, extensions: [extension], thinkingLevel: "off",
    } });
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(state);
      state.tickets.t1 = {
        id: "t1", commandId: "t1", title: "实施方案", goal: "完成变更", scope: "当前项目", status: "running", role: "coder",
        envId: "local", workspaceDir: "/project", workerConversationId: 200, runEpoch: 1, createdAt: 1, updatedAt: 1,
      } satisfies TicketRecord;
    }, BACKGROUND_CONTEXT);
    const send = async (content: string) => {
      await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
    };
    await send("第一轮");
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.topics!.root!.updatedAt = 999;
      state.topics!.root!.title = "111";
      state.tickets.t1!.updatedAt = 999;
      state.tickets.t1!.latestReport = { state: "progress", summary: "当前工具步的进度", at: 999 };
    }, BACKGROUND_CONTEXT);
    await send("第二轮");
    relationship = "用户平时偏好简短交流，方案评审需要具体例子。";
    await send("第三轮");
    await harness.commit(async (tx) => {
      const task = (await tx.doc(KuloStateDoc)).tickets.t1!;
      task.status = "waiting";
      task.waiting = { reason: "user", since: 1000, detail: "等待确认具体范围" };
    }, BACKGROUND_CONTEXT);
    await send("第四轮");

    expect(requests).toHaveLength(4);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]!.messages;
      expect(requests[index]!.messages.slice(0, previous.length)).toEqual(previous);
    }
    const systemSections = (request: TranscriptContext) => request.messages
      .filter((message) => message.role === "system").map((message) => message.sections ?? {});
    expect(systemSections(requests[0]!)).toHaveLength(1);
    expect(systemSections(requests[1]!)).toHaveLength(1);
    expect(systemSections(requests[2]!)).toHaveLength(2);
    expect(Object.keys(systemSections(requests[2]!)[1]!)).toEqual(["kulo_relationship"]);
    expect(systemSections(requests[3]!)).toHaveLength(3);
    expect(Object.keys(systemSections(requests[3]!)[2]!)).toEqual(["kulo_recent_work"]);
    const rendered = JSON.stringify(requests[0]);
    expect(rendered).toContain("kulo_identity");
    expect(rendered).toContain("kulo_relationship");
    expect(rendered).toContain("kulo_recent_work");
    expect(rendered).not.toContain("当前话题");
  });

  it("keeps factory identity available without initialized files and guards private sections from Workers", async () => {
    const sections = createOrchestratorSections({
      getIdentityDir: () => "/nonexistent-personality-test", getRoles: () => ({}), getEnvs: () => [],
      getMemoryConfig: () => resolveHubConfig({}).memory,
    });
    const identity = sections.find((candidate) => candidate.key === "kulo_identity")!;
    const state = { conversationToTicket: { "99": "t1" }, conversationToSubagent: {}, conversationToTopic: {} };
    type RenderInput = Parameters<typeof identity.render>[0];
    const input = (conversationId: number) => ({
      conversationId, read: { snapshot: async () => state },
    }) as unknown as RenderInput;
    expect(await identity.render(input(78), BACKGROUND_CONTEXT)).toBeUndefined();
    for (const key of ["kulo_identity", "kulo_relationship", "kulo_recent_work"]) {
      expect(await sections.find((candidate) => candidate.key === key)!.render(input(99), BACKGROUND_CONTEXT)).toBeUndefined();
    }
    const { ROOT_CONVERSATION_ID } = await import("@earendil-works/pi-durable");
    expect(await identity.render(input(Number(ROOT_CONVERSATION_ID)), BACKGROUND_CONTEXT)).toContain("persistent personal assistant");
  });

  it("injects only identity-agreement.md and relationship.md while ignoring unrelated files in the directory", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-prompt-identity-"));
    try {
      fs.writeFileSync(path.join(directory, "identity-agreement.md"), "用户认可的身份约定正文");
      fs.writeFileSync(path.join(directory, "relationship.md"), "用户的称呼偏好");
      fs.writeFileSync(path.join(directory, "extra.md"), "无关文档 SECRET_EXTRA");
      const sections = createOrchestratorSections({
        getIdentityDir: () => directory, getRoles: () => ({}), getEnvs: () => [],
        getMemoryConfig: () => resolveHubConfig({}).memory,
      });
      const { ROOT_CONVERSATION_ID } = await import("@earendil-works/pi-durable");
      const input = { conversationId: ROOT_CONVERSATION_ID,
        read: { snapshot: async () => undefined },
      } as unknown as Parameters<(typeof sections)[number]["render"]>[0];
      const identity = await sections.find((item) => item.key === "kulo_identity")!.render(input, BACKGROUND_CONTEXT);
      const relationship = await sections.find((item) => item.key === "kulo_relationship")!.render(input, BACKGROUND_CONTEXT);
      expect(identity).toContain("用户认可的身份约定正文");
      expect(relationship).toContain("用户的称呼偏好");
      expect(`${identity}\n${relationship}`).not.toContain("SECRET_EXTRA");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps wire-level systemInstruction and prefix byte-identical on mid-epoch recent-work updates and refreshes baseline after compaction", async () => {
    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "openai", models: [{ id: "cache-model" }] });
    provider.setResponses(Array.from({ length: 6 }, () => (context: TranscriptContext) => {
      requests.push(JSON.parse(JSON.stringify(context)) as TranscriptContext);
      return fauxAssistantMessage([fauxText("已收到。")]);
    }));
    const models = createModels();
    models.setProvider(provider.provider);

    let harness!: Harness;
    const redact = (value: string) => value.replace(/SECRET_TOKEN/g, "[REDACTED]");
    const extension = defineExtension({
      name: "test-frozen-recent-work",
      sections: createOrchestratorSections({
        getIdentityDir: () => "/nonexistent-personality-test",
        getRoles: () => ({}),
        getEnvs: () => [],
        getMemoryConfig: () => resolveHubConfig({}).memory,
        getPersonalityContext: async () => ({
          identityAgreement: "身份：Kulo；诚实、简洁。",
          relationship: "用户偏好简短交流。",
          recentWorkEnabled: true,
        }),
        freezeRecentWorkBaseline: true,
        isSystemBaselinePending: (cid, ctx) => isSystemBaselinePending(harness, cid, ctx),
      }),
      hooks: [
        createRecentWorkSyncHook({
          getHarness: () => harness,
          getPersonalityContext: async () => ({ recentWorkEnabled: true }),
          redact,
        }),
      ],
    });
    const registry = createRegistry();
    registry.install(extension);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    close.push(() => harness.close(BACKGROUND_CONTEXT));

    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: "openai", modelId: "cache-model" },
        extensions: [extension],
        thinkingLevel: "off",
      },
    });
    await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      ensureDefaultRootTopic(state);
      state.tickets.t1 = {
        id: "t1", commandId: "t1", title: "实施方案", goal: "完成变更", scope: "当前项目", status: "running", role: "coder",
        envId: "local", workspaceDir: "/project", workerConversationId: 200, runEpoch: 1, createdAt: 1, updatedAt: 1,
      } satisfies TicketRecord;
    }, BACKGROUND_CONTEXT);

    const send = async (content: string) => {
      await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
    };

    await send("第一轮");
    // Transition ticket state mid-epoch (previously triggered a pi.system rewrite that busted Gemini/Vertex cache).
    await harness.commit(async (tx) => {
      const task = (await tx.doc(KuloStateDoc)).tickets.t1!;
      task.status = "ready";
      task.latestReport = { state: "ready", summary: "交付包含 SECRET_TOKEN 的结果", at: 2000 };
    }, BACKGROUND_CONTEXT);
    await send("第二轮");
    // Subsequent turn with no further ticket change must not append another update.
    await send("第三轮");

    expect(requests).toHaveLength(3);

    // Wire-level check for providers without mid-conversation system messages (Google Vertex/Gemini, Anthropic, etc.):
    // systemInstruction (index 0 after collapseSystemMessages) MUST stay 100% byte-identical across all 3 turns!
    const wire = requests.map((req) => collapseSystemMessages(req));
    const sys0 = getInitialSystemMessage(wire[0]!.messages);
    const sys1 = getInitialSystemMessage(wire[1]!.messages);
    const sys2 = getInitialSystemMessage(wire[2]!.messages);
    expect(sys1).toEqual(sys0);
    expect(sys2).toEqual(sys0);
    expect(wire[1]!.messages.slice(0, wire[0]!.messages.length)).toEqual(wire[0]!.messages);
    expect(wire[2]!.messages.slice(0, wire[1]!.messages.length)).toEqual(wire[1]!.messages);

    // Verify turn 2 delivered the redacted append-only update and turn 3 did not duplicate it.
    const updateMsgs1 = wire[1]!.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[KULO_RECENT_WORK_UPDATE]"),
    );
    const updateMsgs2 = wire[2]!.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[KULO_RECENT_WORK_UPDATE]"),
    );
    expect(updateMsgs1).toHaveLength(1);
    expect(updateMsgs2).toHaveLength(1);
    expect(String(updateMsgs1[0]!.content)).toContain("[REDACTED]");
    expect(String(updateMsgs1[0]!.content)).not.toContain("SECRET_TOKEN");

    // Display messages and voice history must hide internal kulo.recent_work_update entries.
    const view = await conversation.context(BACKGROUND_CONTEXT);
    expect(view.entries.filter(RecentWorkUpdateEntry.is)).toHaveLength(1);
    const display = extractDisplayMessages(view.entries);
    expect(JSON.stringify(display)).not.toContain("KULO_RECENT_WORK_UPDATE");
    const voice = voiceHistory(view, redact);
    expect(JSON.stringify(voice)).not.toContain("KULO_RECENT_WORK_UPDATE");

    // Simulate a compaction head marker (even when kept entries retain an older SystemEntry):
    // next turn must refresh the pi.system baseline to the latest snapshot instead of freezing stale pre-compaction state.
    const firstKept = view.entries[0]!.id;
    await harness.commit(async (tx) => {
      await tx.appendEntry(CompactionEntry, conversation.id, {
        head: firstKept,
        model: [{ role: "user", content: "<summary>earlier context</summary>", timestamp: Date.now() }],
      });
    }, BACKGROUND_CONTEXT);
    await send("压缩后第一轮");
    const afterCompactionSys = getInitialSystemMessage(collapseSystemMessages(requests[3]!).messages);
    expect(afterCompactionSys?.sections?.kulo_recent_work).toContain("ready_for_review");
    expect(afterCompactionSys?.sections?.kulo_recent_work).toContain("交付包含");
  });
});
