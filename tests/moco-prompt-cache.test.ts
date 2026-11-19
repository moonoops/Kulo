import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { TicketRecord } from "@moco/protocol";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { createOrchestratorSections } from "../packages/hub/src/prompts.js";
import { MocoStateDoc, ensureDefaultRootTopic } from "../packages/hub/src/state.js";

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
      getPersonalityContext: async () => ({ identityAgreement: "身份：Moco；诚实、简洁。", relationship, recentWorkEnabled: true }),
    }) });
    const registry = createRegistry(); registry.install(extension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    close.push(() => harness.close(BACKGROUND_CONTEXT));
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: {
      model: { provider: "openai", modelId: "cache-model" }, extensions: [extension], thinkingLevel: "off",
    } });
    await harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
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
      const state = await tx.doc(MocoStateDoc);
      state.topics!.root!.updatedAt = 999;
      state.topics!.root!.title = "111";
      state.tickets.t1!.updatedAt = 999;
      state.tickets.t1!.latestReport = { state: "progress", summary: "当前工具步的进度", at: 999 };
    }, BACKGROUND_CONTEXT);
    await send("第二轮");
    relationship = "用户平时偏好简短交流，方案评审需要具体例子。";
    await send("第三轮");
    await harness.commit(async (tx) => {
      const task = (await tx.doc(MocoStateDoc)).tickets.t1!;
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
    expect(Object.keys(systemSections(requests[2]!)[1]!)).toEqual(["moco_relationship"]);
    expect(systemSections(requests[3]!)).toHaveLength(3);
    expect(Object.keys(systemSections(requests[3]!)[2]!)).toEqual(["moco_recent_work"]);
    const rendered = JSON.stringify(requests[0]);
    expect(rendered).toContain("moco_identity");
    expect(rendered).toContain("moco_relationship");
    expect(rendered).toContain("moco_recent_work");
    expect(rendered).not.toContain("当前话题");
  });

  it("keeps factory identity available without initialized files and guards private sections from Workers", async () => {
    const sections = createOrchestratorSections({
      getIdentityDir: () => "/nonexistent-personality-test", getRoles: () => ({}), getEnvs: () => [],
      getMemoryConfig: () => resolveHubConfig({}).memory,
    });
    const identity = sections.find((candidate) => candidate.key === "moco_identity")!;
    const state = { conversationToTicket: { "99": "t1" }, conversationToSubagent: {}, conversationToTopic: {} };
    type RenderInput = Parameters<typeof identity.render>[0];
    const input = (conversationId: number) => ({
      conversationId, read: { snapshot: async () => state },
    }) as unknown as RenderInput;
    expect(await identity.render(input(78), BACKGROUND_CONTEXT)).toBeUndefined();
    for (const key of ["moco_identity", "moco_relationship", "moco_recent_work"]) {
      expect(await sections.find((candidate) => candidate.key === key)!.render(input(99), BACKGROUND_CONTEXT)).toBeUndefined();
    }
    const { ROOT_CONVERSATION_ID } = await import("@earendil-works/pi-durable");
    expect(await identity.render(input(Number(ROOT_CONVERSATION_ID)), BACKGROUND_CONTEXT)).toContain("persistent personal assistant");
  });

  it("injects only identity-agreement.md and relationship.md while ignoring unrelated files in the directory", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-prompt-identity-"));
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
      const identity = await sections.find((item) => item.key === "moco_identity")!.render(input, BACKGROUND_CONTEXT);
      const relationship = await sections.find((item) => item.key === "moco_relationship")!.render(input, BACKGROUND_CONTEXT);
      expect(identity).toContain("用户认可的身份约定正文");
      expect(relationship).toContain("用户的称呼偏好");
      expect(`${identity}\n${relationship}`).not.toContain("SECRET_EXTRA");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
