import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { MocoHub } from "../packages/hub/src/hub.js";
import { MocoStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function sections(request: TranscriptContext): Record<string, string> {
  return Object.assign({}, ...request.messages.flatMap((message) => message.role === "system" ? [message.sections ?? {}] : []));
}
function offeredTools(request: TranscriptContext): string[] {
  return [...new Set([
    ...(request.tools ?? []).map((tool) => tool.name),
    ...request.messages.flatMap((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
      ? message.toolsAdded.map((tool) => tool.name) : []),
  ])];
}
async function fixture(workerReports = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-response-formats-"));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const requests: TranscriptContext[] = [];
  const provider = fauxProvider({ provider: "response-formats-test", models: [{ id: "test" }] });
  provider.setResponses(Array.from({ length: 30 }, () => (request: TranscriptContext) => {
    requests.push(JSON.parse(JSON.stringify(request)) as TranscriptContext);
    if (workerReports && !sections(request).moco_orchestrator) {
      return fauxAssistantMessage([fauxToolCall("moco_report", { state: "ready", summary: "已整理当前请求。" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage([fauxText("这里直接用文字回答。")]);
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  const hub = await openTestHub({ models, providerId: "response-formats-test", config: {
    stateDir, identityDir: path.join(stateDir, "identity"), enableLocalEnv: true, watchdogMinutes: 0,
    memory: { enabled: false },
    model: { defaultProvider: "response-formats-test", defaultModel: "test", thinkingLevel: "off" },
  } });
  cleanup.push(() => hub.close());
  return { hub, requests };
}
async function send(hub: MocoHub, topicId: string) {
  const submitted = await hub.sendUserMessage("简单解释一下这个概念", { topicId });
  await submitted.wait(BACKGROUND_CONTEXT);
}
function expectFormatPolicy(request: TranscriptContext) {
  const prompt = sections(request);
  expect(prompt.moco_orchestrator).toMatch(/Respect any user-requested format/);
  expect(prompt.moco_orchestrator).toMatch(/plain text for simple answers and Markdown tables for quick comparisons/);
  expect(prompt.moco_orchestrator).toMatch(/moco_ui_show.*genui-cards/);
  expect(prompt.moco_orchestrator).toMatch(/moco_generate_image.*moco_generate_video.*real asset/);
  expect(prompt.moco_orchestrator).toMatch(/moco_media_capabilities/);
  expect(prompt.moco_content).toBeUndefined();
  expect(prompt.moco_skills).toContain("genui-cards");
  expect(offeredTools(request)).toEqual(expect.arrayContaining([
    "moco_ui_show", "tool_search", "moco_skill_read",
  ]));
}

describe("response formats in actual model requests", () => {
  it.each(["root", "topic"])("keeps format guidance and tools available in %s across live reconfiguration", async (target) => {
    const { hub, requests } = await fixture();
    const topic = target === "root" ? { id: "root", conversationId: Number(hub.rootConversation.id) }
      : await hub.createTopic("回答形式回归");
    await send(hub, topic.id);
    const initial = requests.filter((request) => sections(request).moco_orchestrator).at(-1)!;
    expectFormatPolicy(initial);
    const conv = (await hub.harness.conversation(topic.conversationId as ConversationId, BACKGROUND_CONTEXT))!;
    expect((await conv.agent(BACKGROUND_CONTEXT)).deferred.map((t) => t.name)).toEqual(expect.arrayContaining([
      "moco_ui_update", "moco_media_capabilities", "moco_generate_image", "moco_generate_video",
    ]));
    const settings = hub.getSettingsView();
    await hub.updateSettingsBlock("presentation", settings.blocks.presentation.revision,
      { ...settings.blocks.presentation.value, agentName: "小墨" });
    await send(hub, topic.id);
    const reconfigured = requests.filter((request) => sections(request).moco_orchestrator).at(-1)!;
    expectFormatPolicy(reconfigured);
    expect((await conv.agent(BACKGROUND_CONTEXT)).deferred.map((t) => t.name)).toEqual(expect.arrayContaining([
      "moco_ui_update", "moco_media_capabilities", "moco_generate_image", "moco_generate_video",
    ]));
    expect(sections(reconfigured).moco_orchestrator).toContain("You are 小墨");
    expect(await hub.uiCards.snapshot(topic.conversationId)).toEqual([]);
    expect(await hub.mediaJobs.list()).toEqual([]);
  });

  it("keeps Worker media tools available while pruning Orchestrator-only UI card and asset inspection tools", async () => {
    const { hub, requests } = await fixture(true);
    const ticket = await hub.dispatchTicket({ commandId: "format-worker", title: "整理说明", goal: "整理一句简短说明",
      scope: "仅汇报文字，不调用媒体生成或写文件" });
    await vi.waitFor(() => expect(requests.some((request) => offeredTools(request).includes("moco_report"))).toBe(true));
    const worker = requests.find((request) => offeredTools(request).includes("moco_report"))!;
    const prompt = sections(worker);
    expect(prompt.moco_orchestrator).toBeUndefined();
    expect(prompt.moco_content).toBeUndefined();
    expect(prompt.moco_worker_mandate).toContain("Your output goes to the coordinating assistant for review");
    const state = (await hub.harness.snapshot(MocoStateDoc, BACKGROUND_CONTEXT))!;
    const workerConv = (await hub.harness.conversation(state.tickets[ticket.id]!.workerConversationId as ConversationId, BACKGROUND_CONTEXT))!;
    const workerAgent = await workerConv.agent(BACKGROUND_CONTEXT);
    expect(workerAgent.deferred.map((t) => t.name)).toContain("moco_generate_image");
    for (const forbidden of ["moco_ui_show", "moco_ui_update", "moco_inspect_asset"]) {
      expect(offeredTools(worker)).not.toContain(forbidden);
      expect(workerAgent.callable.map((t) => t.name)).not.toContain(forbidden);
    }
    await vi.waitFor(async () => {
      const view = await hub.getBoardSnapshot(BACKGROUND_CONTEXT);
      expect(view.tickets.find((item) => item.id === ticket.id)?.status).toBe("ready");
    });
    expect(await hub.mediaJobs.list()).toEqual([]);
  });
});
