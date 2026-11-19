import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { MocoHub, MocoStateDoc, startMocoHubServer } from "@moco/hub";
import type { ChatAttachment, ChatDisplayItem, MessagePart, TicketCardView, TopicSummary } from "@moco/protocol";
import { ContentPublicationEntry } from "../packages/hub/src/ui-cards.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => void | Promise<void>> = [];
const sandboxAvailable = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const html = "<!DOCTYPE html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>产物</title><body>原任务的文件</body></html>\n";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
type Response = (ctx: TranscriptContext) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
type Manifest = { asset_id: string; name: string; kind: string; mime_type: string; size: number };

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_AUTH_TOKEN", "MOCO_ENV_TOKENS", "MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function offeredNames(ctx: TranscriptContext): Set<string> {
  return new Set([
    ...(ctx.tools ?? []).map((t) => t.name),
    ...ctx.messages.flatMap((m) =>
      m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded)
        ? m.toolsAdded.map((t) => t.name)
        : [],
    ),
  ]);
}

function alreadySearched(ctx: TranscriptContext, query: string): boolean {
  return ctx.messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some(
        (p) => p.type === "toolCall" && p.name === "tool_search" && (p.arguments as { query?: string })?.query === query,
      ),
  );
}

function makeStepRunner(responses: Response[], fallback: () => ReturnType<typeof fauxAssistantMessage>): Response {
  let index = 0;
  let pendingMsg: Awaited<ReturnType<Response>> | null = null;
  return async (ctx: TranscriptContext) => {
    const candidate = responses[index];
    if (!candidate) return fallback();
    const msg = pendingMsg ?? await candidate(ctx);
    const offered = offeredNames(ctx);
    if (offered.has("tool_search") && Array.isArray(msg.content)) {
      const missing = msg.content.find(
        (part): part is Extract<typeof part, { type: "toolCall" }> =>
          part.type === "toolCall" && !offered.has(part.name) && !alreadySearched(ctx, part.name),
      );
      if (missing) {
        pendingMsg = msg;
        return tool("tool_search", { query: missing.name, limit: 5 });
      }
    }
    pendingMsg = null;
    index++;
    return msg;
  };
}

function isRouter(ctx: TranscriptContext): boolean {
  return offeredNames(ctx).has("moco_dispatch");
}

function tool(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function assetParts(messages: ChatDisplayItem[]): Array<Extract<MessagePart, { assetId: string }>> {
  return messages.flatMap((message) => message.parts ?? []).filter((part): part is Extract<MessagePart, { assetId: string }> => "assetId" in part);
}

function lastTool(ctx: TranscriptContext, name: string) {
  const result = ctx.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
  if (!result || result.role !== "toolResult") throw new Error(`Missing ${name} result in model context`);
  return result;
}

function toolData(ctx: TranscriptContext, name: string): Record<string, any> {
  const result = lastTool(ctx, name);
  expect(result.isError).not.toBe(true);
  return JSON.parse(textContent(result.content));
}

function reviewManifest(ctx: TranscriptContext): Manifest[] {
  const relay = ctx.messages.filter((message) => message.role === "user" && textContent(message.content).includes("[MOCO_WORKER_RELAY]")).at(-1);
  expect(relay).toBeDefined();
  const text = textContent(relay!.content);
  expect(text).toContain("pending review");
  expect(text).toContain("NOT yet published to the user");
  const manifest = text.split("\n").find((line) => line.trim().startsWith('[{"asset_id"'));
  expect(manifest).toBeDefined();
  return JSON.parse(manifest!);
}

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-artifact-delivery-")));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, "hub");
  const workspace = path.join(directory, "workspace");
  const provider = fauxProvider({ provider: "openai", models: [{ id: "artifact-model", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(provider.provider);
  const mainRequests: TranscriptContext[] = [];
  let router: Response = () => fauxAssistantMessage([fauxText("已收到待审结果，暂不交付。")]);
  let worker: Response = () => tool("moco_report", { state: "ready", summary: "产物已生成。" });
  provider.setResponses(Array.from({ length: 128 }, () => (ctx) => {
    if (!isRouter(ctx)) return worker(ctx);
    mainRequests.push(ctx);
    return router(ctx);
  }));
  const config = {
    stateDir, localEnvRoot: workspace, identityDir: path.join(directory, "identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    enableLocalEnv: true, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "artifact-model", thinkingLevel: "off" as const, apiKey: "" },
  };
  let hub = await openTestHub({ models, config });
  let server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
    await hub.close();
  };
  cleanup.push(close);
  const reopen = async () => {
    await close();
    hub = await openTestHub({ models, config });
    server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
    closed = false;
  };
  const steps = (responses: Response[]) => {
    worker = makeStepRunner(responses, () => fauxAssistantMessage([fauxText("执行结束。")]));
  };
  const routerSteps = (responses: Response[]) => {
    router = makeStepRunner(responses, () => fauxAssistantMessage([fauxText("暂不交付。")]));
  };
  const dispatch = (topic: Pick<TopicSummary, "conversationId">, commandId = "generate-html", projectId?: string): Promise<TicketCardView> => hub.dispatchTicket({
    commandId, title: "生成独立 HTML", goal: "生成产物，交主 Agent 审核后再决定交付", scope: "只操作任务工作目录", role: "coder", originConversationId: topic.conversationId,
    ...(projectId ? { projectId } : {}),
  });
  const read = (asset: ChatAttachment) => fetch(`${server.url}${asset.url}`, { headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
  return { directory, workspace, mainRequests, steps, routerSteps, dispatch, read, reopen, get hub() { return hub; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function ready(f: Fixture, ticketId: string): Promise<void> {
  await vi.waitFor(async () => {
    const detail = await f.hub.inspectTicketDetail(ticketId);
    expect(detail.ticket.status, JSON.stringify(detail.ticket.latestReport)).toBe("ready");
  }, { timeout: 12_000, interval: 25 });
}

async function view(f: Fixture, topicId: string, check: (messages: ChatDisplayItem[]) => void) {
  let result!: Awaited<ReturnType<MocoHub["getTopicView"]>>;
  await vi.waitFor(async () => {
    result = await f.hub.getTopicView(topicId);
    expect(result.live.busy).toBe(false);
    check(result.messages);
  }, { timeout: 12_000, interval: 25 });
  return result;
}

async function held(f: Fixture, topicId: string) {
  return view(f, topicId, (messages) => {
    expect(messages.some((message) => message.role === "assistant" && message.text.includes("已收到待审结果"))).toBe(true);
    expect(assetParts(messages)).toHaveLength(0);
  });
}

async function staged(f: Fixture, ticketId: string): Promise<ChatAttachment[]> {
  return (await f.hub.inspectTicketDetail(ticketId)).ticket.latestReport?.attachments ?? [];
}

async function expectPrivate(f: Fixture, topicId: string, asset: ChatAttachment): Promise<void> {
  expect(assetParts((await f.hub.getTopicView(topicId)).messages)).toHaveLength(0);
  const response = await f.read(asset);
  expect(response.status).toBe(403);
  await response.arrayBuffer();
}

async function failedInternally(f: Fixture, ticketId: string, topicId: string) {
  await vi.waitFor(async () => {
    const detail = await f.hub.inspectTicketDetail(ticketId);
    expect(detail.ticket.latestReport?.state).toBe("failed");
    expect(detail.ticket.status).not.toBe("ready");
    const messages = (await f.hub.getTopicView(topicId)).messages;
    expect(assetParts(messages)).toHaveLength(0);
    expect(messages.some((message) => message.text.includes("产物提交审核失败"))).toBe(false);
  }, { timeout: 12_000, interval: 25 });
}

function inspectAndPublish(f: Fixture, topicId: string, expected: string | Buffer) {
  let assetId = "";
  f.routerSteps([
    async (ctx) => {
      const manifest = reviewManifest(ctx);
      expect(manifest).toHaveLength(1);
      assetId = manifest[0]!.asset_id;
      expect(assetParts((await f.hub.getTopicView(topicId)).messages)).toHaveLength(0);
      return tool("moco_inspect_asset", { asset_id: assetId });
    },
    async (ctx) => {
      const result = lastTool(ctx, "moco_inspect_asset");
      expect(result.isError).not.toBe(true);
      if (typeof expected === "string") {
        const inspection = toolData(ctx, "moco_inspect_asset");
        expect(inspection).toMatchObject({ inspection: "text", contentProvided: true, text: expected });
      } else {
        expect(result.content).toEqual(expect.arrayContaining([{ type: "image", mimeType: "image/png", data: expected.toString("base64") }]));
      }
      expect(assetParts((await f.hub.getTopicView(topicId)).messages)).toHaveLength(0);
      return tool("moco_publish_asset", { asset_id: assetId });
    },
    (ctx) => {
      expect(toolData(ctx, "moco_publish_asset")).toMatchObject({ id: assetId, status: "published" });
      return fauxAssistantMessage([fauxText("已检查产物并发送。")]);
    },
  ]);
}

describe.skipIf(!sandboxAvailable)("Worker artifacts stay private until main-Agent review", () => {
  it("stages actual HTML before Worker shutdown and preserves a private pending review after restart", async () => {
    const f = await fixture();
    const sibling = path.join(f.workspace, "registered-project");
    fs.mkdirSync(sibling, { recursive: true });
    await f.hub.projects.create({ commandId: "register-sibling", name: "相邻项目", deviceId: "local", workspaceDir: sibling });
    const topic = await f.hub.createTopic("待审 HTML");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "页面已生成，待主 Agent 审核。", files: [{ path: "index.html", name: "独立页面.html", mime_type: "text/html" }] }),
    ]);
    const original = f.hub.uploads.saveUploadStream.bind(f.hub.uploads);
    const importStates: string[] = [];
    vi.spyOn(f.hub.uploads, "saveUploadStream").mockImplementation(async (input) => {
      importStates.push((await f.hub.getBoardSnapshot()).tickets[0]!.status);
      return original(input);
    });
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    await held(f, topic.id);
    const [asset] = await staged(f, ticket.id);
    expect(asset).toMatchObject({ kind: "file", name: "独立页面.html", size: Buffer.byteLength(html) });
    expect(importStates).toEqual(["running"]);
    expect(f.hub.uploads.readUploadBytes(f.hub.uploads.getUpload(asset!.id)!)).toEqual(Buffer.from(html));
    expect(reviewManifest(f.mainRequests.at(-1)!)).toEqual([expect.objectContaining({ asset_id: asset!.id, name: "独立页面.html", kind: "file" })]);
    expect((await f.hub.harness.snapshot(MocoStateDoc, context))?.workerArtifacts?.[ticket.id]?.map((entry) => entry.id)).toEqual([asset!.id]);
    await expectPrivate(f, topic.id, asset!);
    expect(assetParts((await f.hub.getTopicView("root")).messages)).toHaveLength(0);
    await f.reopen();
    expect((await staged(f, ticket.id)).map((entry) => entry.id)).toEqual([asset!.id]);
    await expectPrivate(f, topic.id, asset!);
  });

  it("lets only main inspect and explicitly publish staged HTML bytes after its source directory is gone", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("审核通过再交付");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "待审核。", files: [{ path: "index.html" }] }),
    ]);
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    await held(f, topic.id);
    const [asset] = await staged(f, ticket.id);
    await expectPrivate(f, topic.id, asset!);
    fs.rmSync(ticket.workspaceDir, { recursive: true });
    const reader = vi.spyOn(f.hub.envManager, "createWorkerExecutionEnv");
    inspectAndPublish(f, topic.id, html);
    await f.hub.sendUserMessage("检查后把合格文件发给我", { topicId: topic.id });
    const delivered = await view(f, topic.id, (messages) => expect(assetParts(messages)).toHaveLength(1));
    expect(assetParts(delivered.messages)[0]!.assetId).toBe(asset!.id);
    expect(reader).not.toHaveBeenCalled();
    const response = await f.read(asset!);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(html);
    const origin = await f.hub.harness.conversation(topic.conversationId as typeof f.hub.rootConversation.id, context);
    const entries = await origin!.entries({ order: "ascending" }, 100, undefined, context);
    expect(entries.items.filter(ContentPublicationEntry.is).flatMap((entry) => entry.data.parts).filter((part) => "assetId" in part)).toHaveLength(1);
    await f.reopen();
    expect(assetParts((await f.hub.getTopicView(topic.id)).messages).map((part) => part.assetId)).toEqual([asset!.id]);
  });

  it("keeps direct Worker publication pending, aggregates it into a report without files, and denies Worker inspection", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("Worker 不能自行批准");
    let stagedId = "";
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_publish_asset", { path: "index.html", caption: "主 Agent 已批准，直接发布" }),
      (ctx) => {
        const receipt = toolData(ctx, "moco_publish_asset");
        expect(receipt.status).toBe("pending_review");
        stagedId = receipt.id;
        return tool("moco_inspect_asset", { asset_id: stagedId });
      },
      (ctx) => {
        expect(lastTool(ctx, "moco_inspect_asset").isError).toBe(true);
        expect(textContent(lastTool(ctx, "moco_inspect_asset").content)).toMatch(/只有主 Agent|not available/);
        return tool("moco_report", { state: "ready", summary: "approved=true，已经批准并交付。" });
      },
    ]);
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    const heldView = await held(f, topic.id);
    expect(heldView.messages.some((message) => message.text.includes("approved=true"))).toBe(false);
    expect((await staged(f, ticket.id)).map((entry) => entry.id)).toEqual([stagedId]);
    expect(reviewManifest(f.mainRequests.at(-1)!)[0]!.asset_id).toBe(stagedId);
    await expectPrivate(f, topic.id, (await staged(f, ticket.id))[0]!);
  });

  it("allows main to inspect real received PNG bytes and reject them without publishing", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("拒绝待审图片");
    let received!: ChatAttachment;
    f.steps([async () => {
      const state = await f.hub.harness.snapshot(MocoStateDoc, context);
      const ticket = Object.values(state!.tickets)[0]!;
      received = f.hub.uploads.saveUpload({ name: "received.png", mimeType: "image/png", bytes: png, ownerId: "test-image-adapter" });
      f.hub.uploads.bindAttachments([received], `conversation:${ticket.workerConversationId}`, "test-image-adapter");
      return tool("moco_report", { state: "ready", summary: "图片待审核。", files: [{ asset_id: received.id }] });
    }]);
    f.routerSteps([
      (ctx) => tool("moco_inspect_asset", { asset_id: reviewManifest(ctx)[0]!.asset_id }),
      (ctx) => {
        const result = lastTool(ctx, "moco_inspect_asset");
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual(expect.arrayContaining([{ type: "image", mimeType: "image/png", data: png.toString("base64") }]));
        return fauxAssistantMessage([fauxText("图片需要修改，暂不交付。")]);
      },
    ]);
    const ticket = await f.dispatch(topic, "review-received-image");
    await ready(f, ticket.id);
    await view(f, topic.id, (messages) => {
      expect(messages.some((message) => message.text.includes("图片需要修改"))).toBe(true);
      expect(assetParts(messages)).toHaveLength(0);
    });
    await expectPrivate(f, topic.id, received);
  });

  it("publishes one received PNG only after main inspects its real image content", async () => {
    const f = await fixture();
    const sibling = path.join(f.workspace, "registered-image-project");
    fs.mkdirSync(sibling, { recursive: true });
    await f.hub.projects.create({ commandId: "register-image-sibling", name: "相邻图片项目", deviceId: "local", workspaceDir: sibling });
    const topic = await f.hub.createTopic("图片审核后交付");
    let received!: ChatAttachment;
    f.steps([async () => {
      const state = await f.hub.harness.snapshot(MocoStateDoc, context);
      const ticket = Object.values(state!.tickets)[0]!;
      received = f.hub.uploads.saveUpload({ name: "received.png", mimeType: "image/png", bytes: png, ownerId: "test-image-adapter" });
      f.hub.uploads.bindAttachments([received], `ticket:${ticket.id}`, "test-image-adapter");
      return tool("moco_report", { state: "ready", summary: "图片待审核。", files: [{ asset_id: received.id }] });
    }]);
    const ticket = await f.dispatch(topic, "approve-received-image");
    await ready(f, ticket.id);
    await held(f, topic.id);
    await expectPrivate(f, topic.id, received);
    const reader = vi.spyOn(f.hub.envManager, "createWorkerExecutionEnv");
    const importer = vi.spyOn(f.hub.uploads, "saveUploadStream");
    inspectAndPublish(f, topic.id, png);
    await f.hub.sendUserMessage("审核图片，合格后发给我", { topicId: topic.id });
    const delivered = await view(f, topic.id, (messages) => expect(assetParts(messages)).toHaveLength(1));
    expect(assetParts(delivered.messages)[0]).toMatchObject({ type: "image", assetId: received.id });
    expect(reader).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
    const response = await f.read(received);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("reviews cached project output after its source project grant changes, without reopening the directory", async () => {
    const f = await fixture();
    const originalDirectory = path.join(f.directory, "projects", "original");
    fs.mkdirSync(originalDirectory, { recursive: true });
    const project = await f.hub.projects.create({ commandId: "create-project", name: "授权项目", deviceId: "local", workspaceDir: originalDirectory });
    const topic = await f.hub.createTopic("普通话题中的项目产物");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "待审核。", files: [{ path: "index.html" }] }),
    ]);
    const ticket = await f.dispatch(topic, "project-artifact", project.id);
    await ready(f, ticket.id);
    await held(f, topic.id);
    const [asset] = await staged(f, ticket.id);
    const replacement = path.join(f.directory, "projects", "replacement");
    fs.mkdirSync(replacement, { recursive: true });
    await expect(f.hub.projects.patch(project.id, { workspaceDir: replacement, expectedRevision: project.revision })).rejects.toMatchObject({ code: "project_tasks_running" });
    await f.hub.applyStagedChanges({ commandId: "apply-cached-project-artifact", ticketId: ticket.id });
    await f.hub.projects.patch(project.id, { workspaceDir: replacement, expectedRevision: project.revision });
    const reader = vi.spyOn(f.hub.envManager, "createWorkerExecutionEnv");
    inspectAndPublish(f, topic.id, html);
    await f.hub.sendUserMessage("审核缓存产物并交付", { topicId: topic.id });
    const delivered = await view(f, topic.id, (messages) => expect(assetParts(messages)).toHaveLength(1));
    expect(assetParts(delivered.messages)[0]!.assetId).toBe(asset!.id);
    expect(reader).not.toHaveBeenCalled();
    expect((await f.hub.listTopics()).find((entry) => entry.id === topic.id)?.projectId).toBeUndefined();
    expect(await (await f.read(asset!)).text()).toBe(html);
  });

  it("privately stages project scratch output and lets main review and publish cached bytes", async () => {
    const f = await fixture();
    const projectDirectory = path.join(f.directory, "projects", "scratch-output");
    fs.mkdirSync(projectDirectory, { recursive: true });
    const project = await f.hub.projects.create({ commandId: "scratch-project", name: "草稿箱项目", deviceId: "local", workspaceDir: projectDirectory });
    const topic = await f.hub.createTopic("草稿箱产物审核");
    let scratchPath = "";
    f.steps([
      async () => {
        const state = await f.hub.harness.snapshot(MocoStateDoc, context);
        const ticket = Object.values(state!.tickets)[0]!;
        scratchPath = path.join(ticket.scratchDir!, "scratch-report.html");
        return tool("write", { path: scratchPath, content: html });
      },
      () => tool("moco_report", { state: "ready", summary: "草稿箱产物待审。", files: [{ path: scratchPath }] }),
    ]);
    const ticket = await f.dispatch(topic, "scratch-artifact", project.id);
    await ready(f, ticket.id);
    await held(f, topic.id);
    expect(scratchPath.startsWith(project.workspaceDir)).toBe(false);
    await expectPrivate(f, topic.id, (await staged(f, ticket.id))[0]!);
    inspectAndPublish(f, topic.id, html);
    await f.hub.sendUserMessage("审核草稿箱产物后交付", { topicId: topic.id });
    await view(f, topic.id, (messages) => expect(assetParts(messages)).toHaveLength(1));
  });

  it("merges an earlier staged image with a later report file into one private review manifest", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("混合产物统一待审");
    let image!: ChatAttachment;
    f.steps([
      async () => {
        const state = await f.hub.harness.snapshot(MocoStateDoc, context);
        const ticket = Object.values(state!.tickets)[0]!;
        image = f.hub.uploads.saveUpload({ name: "earlier-image.png", mimeType: "image/png", bytes: png, ownerId: "test-image-adapter" });
        f.hub.uploads.bindAttachments([image], `conversation:${ticket.workerConversationId}`, "test-image-adapter");
        return tool("moco_publish_asset", { asset_id: image.id });
      },
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "图片和页面均待审核。", files: [{ path: "index.html" }] }),
    ]);
    const ticket = await f.dispatch(topic, "mixed-review-manifest");
    await ready(f, ticket.id);
    await held(f, topic.id);
    const pending = await staged(f, ticket.id);
    expect(pending).toHaveLength(2);
    expect(pending.map((asset) => asset.name).sort()).toEqual(["earlier-image.png", "index.html"]);
    expect(reviewManifest(f.mainRequests.at(-1)!).map((entry) => entry.asset_id).sort()).toEqual(pending.map((asset) => asset.id).sort());
    for (const asset of pending) await expectPrivate(f, topic.id, asset);
  });

  it("includes direct staging in the review relay when a Worker naturally finishes without a report", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("漏报的产物仍需审核");
    let assetId = "";
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_publish_asset", { path: "index.html" }),
      (ctx) => {
        const receipt = toolData(ctx, "moco_publish_asset");
        expect(receipt.status).toBe("pending_review");
        assetId = receipt.id;
        return fauxAssistantMessage([fauxText("产物已暂存，等待主 Agent 审核。")]);
      },
    ]);
    const ticket = await f.dispatch(topic, "natural-finish-review");
    await ready(f, ticket.id);
    await held(f, topic.id);
    expect(reviewManifest(f.mainRequests.at(-1)!).map((entry) => entry.asset_id)).toEqual([assetId]);
    const pending = (await f.hub.harness.snapshot(MocoStateDoc, context))?.workerArtifacts?.[ticket.id];
    expect(pending?.map((asset) => asset.id)).toEqual([assetId]);
    await expectPrivate(f, topic.id, pending![0]!);
  });

  it("keeps a missing file staging failure internal and delivers that failure to main for review", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("内部暂存失败");
    let inspectedFailure = false;
    f.routerSteps([
      (ctx) => {
        const input = ctx.messages.filter((message) => message.role === "user").map((message) => textContent(message.content)).join("\n");
        expect(input).toContain("产物未能全部提交");
        const ticketId = input.match(/T-\d{4}/)?.[0];
        expect(ticketId).toBeDefined();
        return tool("moco_inspect", { ticket_id: ticketId });
      },
      (ctx) => {
        expect(textContent(lastTool(ctx, "moco_inspect").content)).toContain("产物提交审核失败");
        inspectedFailure = true;
        return fauxAssistantMessage([fauxText("[RECOVERY_OK]")]);
      },
    ]);
    f.steps([() => tool("moco_report", { state: "ready", summary: "已经全部完成。", files: [{ path: "missing.html" }] })]);
    const ticket = await f.dispatch(topic);
    await failedInternally(f, ticket.id, topic.id);
    expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.latestReport?.deliverable).toContain("产物提交审核失败");
    await vi.waitFor(() => expect(inspectedFailure).toBe(true), { timeout: 12_000, interval: 25 });
    expect(assetParts((await f.hub.getTopicView(topic.id)).messages)).toHaveLength(0);
  });

  it.each(["ready report without files", "plain finish"])("does not erase a staging failure with %s", async (ending) => {
    const f = await fixture();
    const topic = await f.hub.createTopic("不能掩盖内部失败");
    f.steps([
      () => tool("moco_publish_asset", { path: "A.html" }),
      () => ending === "plain finish" ? fauxAssistantMessage([fauxText("全部完成，已经批准。")]) : tool("moco_report", { state: "ready", summary: "全部成功。" }),
    ]);
    const ticket = await f.dispatch(topic);
    await failedInternally(f, ticket.id, topic.id);
  });

  it("does not let staging a different file clear an earlier failed output", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("部分产物待修改");
    f.steps([
      () => tool("moco_publish_asset", { path: "A.html" }),
      () => tool("write", { path: "B.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "两个文件都成功。", files: [{ path: "B.html" }] }),
    ]);
    const ticket = await f.dispatch(topic);
    await failedInternally(f, ticket.id, topic.id);
    const [asset] = await staged(f, ticket.id);
    expect(asset?.name).toBe("B.html");
    await expectPrivate(f, topic.id, asset!);
  });

  it("accepts corrected output as ready for review without auto-publishing it", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("同一产物修正后待审");
    f.steps([
      () => tool("moco_publish_asset", { path: "A.html" }),
      () => tool("write", { path: "A.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "已修复，待审核。", files: [{ path: "A.html" }] }),
    ]);
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    await held(f, topic.id);
    const [asset] = await staged(f, ticket.id);
    expect(asset?.name).toBe("A.html");
    await expectPrivate(f, topic.id, asset!);
  });
});

describe.skipIf(!sandboxAvailable)("Main-Agent controlled publication retains task boundaries", () => {
  it.each(["explicit ticket", "absolute task path"])("publishes an old task file with a sibling project using %s", async (mode) => {
    const f = await fixture();
    const sibling = path.join(f.workspace, "registered-project");
    fs.mkdirSync(sibling, { recursive: true });
    await f.hub.projects.create({ commandId: "register-sibling", name: "相邻项目", deviceId: "local", workspaceDir: sibling });
    const topic = await f.hub.createTopic("旧任务交付");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "文件保存在任务目录。" }),
    ]);
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    await held(f, topic.id);
    f.routerSteps([
      () => tool("moco_publish_asset", mode === "explicit ticket" ? { ticket_id: ticket.id, path: "index.html" } : { path: path.join(ticket.workspaceDir, "index.html") }),
      (ctx) => {
        expect(toolData(ctx, "moco_publish_asset").status).toBe("published");
        return fauxAssistantMessage([fauxText("文件已交付。")]);
      },
    ]);
    await f.hub.sendUserMessage("交付原任务文件", { topicId: topic.id });
    const delivered = await view(f, topic.id, (messages) => expect(assetParts(messages)).toHaveLength(1));
    expect(await (await f.read(assetParts(delivered.messages)[0]!.asset!)).text()).toBe(html);
  });

  it("privately imports an old task by ticket and path for main inspection before publication", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("审核旧任务文件");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "旧文件可取回。" }),
    ]);
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    await held(f, topic.id);
    let inspected!: ChatAttachment;
    f.routerSteps([
      () => tool("moco_inspect_asset", { ticket_id: ticket.id, path: "index.html" }),
      async (ctx) => {
        const data = toolData(ctx, "moco_inspect_asset");
        expect(data).toMatchObject({ inspection: "text", contentProvided: true, text: html });
        inspected = data.asset;
        await expectPrivate(f, topic.id, inspected);
        return tool("moco_publish_asset", { asset_id: inspected.id });
      },
      () => fauxAssistantMessage([fauxText("已审核并交付。")]),
    ]);
    await f.hub.sendUserMessage("检查旧文件后交付", { topicId: topic.id });
    const delivered = await view(f, topic.id, (messages) => expect(assetParts(messages)).toHaveLength(1));
    expect(assetParts(delivered.messages)[0]!.assetId).toBe(inspected.id);
  });

  it("rejects stale project-directory access with a truthful user-visible send failure", async () => {
    const f = await fixture();
    const original = path.join(f.directory, "projects", "original");
    fs.mkdirSync(original, { recursive: true });
    const project = await f.hub.projects.create({ commandId: "old-project", name: "原项目", deviceId: "local", workspaceDir: original });
    const topic = await f.hub.createTopic("旧授权不可读取");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "旧文件完成。" }),
    ]);
    const ticket = await f.dispatch(topic, "old-grant-file", project.id);
    await ready(f, ticket.id);
    await held(f, topic.id);
    const replacement = path.join(f.directory, "projects", "replacement");
    fs.mkdirSync(replacement, { recursive: true });
    await f.hub.applyStagedChanges({ commandId: "apply-stale-grant-artifact", ticketId: ticket.id });
    await f.hub.projects.patch(project.id, { workspaceDir: replacement, expectedRevision: project.revision });
    f.routerSteps([
      () => tool("moco_publish_asset", { ticket_id: ticket.id, path: "index.html" }),
      () => fauxAssistantMessage([fauxText("页面已经完成。")]),
    ]);
    await f.hub.sendUserMessage("发送旧文件", { topicId: topic.id });
    await view(f, topic.id, (messages) => {
      expect(messages.some((message) => message.text.includes("文件发送失败") && message.text.includes("授权已变化"))).toBe(true);
      expect(assetParts(messages)).toHaveLength(0);
    });
  });

  it.each(["ticket id", "relative path"])("denies another topic's task file addressed by %s", async (mode) => {
    const f = await fixture();
    const owner = await f.hub.createTopic("文件所属聊天");
    const other = await f.hub.createTopic("另一个聊天");
    f.steps([
      () => tool("write", { path: "private.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "文件已保存。" }),
    ]);
    const ticket = await f.dispatch(owner);
    await ready(f, ticket.id);
    await held(f, owner.id);
    f.routerSteps([
      () => tool("moco_publish_asset", mode === "ticket id" ? { ticket_id: ticket.id, path: "private.html" } : { path: path.relative(f.workspace, path.join(ticket.workspaceDir, "private.html")) }),
      () => fauxAssistantMessage([fauxText("文件完成了。")]),
    ]);
    await f.hub.sendUserMessage("发送文件", { topicId: other.id });
    await view(f, other.id, (messages) => {
      expect(messages.some((message) => message.text.includes("文件发送失败"))).toBe(true);
      expect(assetParts(messages)).toHaveLength(0);
    });
    expect(assetParts((await f.hub.getTopicView(owner.id)).messages)).toHaveLength(0);
  });

  it("keeps imported bytes private if their destination is deleted before main publication commits", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("发送中删除的聊天");
    f.steps([
      () => tool("write", { path: "index.html", content: html }),
      () => tool("moco_report", { state: "ready", summary: "文件已保存。" }),
    ]);
    const ticket = await f.dispatch(topic);
    await ready(f, ticket.id);
    await held(f, topic.id);
    const original = f.hub.uploads.saveUploadStream.bind(f.hub.uploads);
    let imported: ChatAttachment | undefined;
    let deletion: Promise<unknown> | undefined;
    vi.spyOn(f.hub.uploads, "saveUploadStream").mockImplementationOnce(async (input) => {
      imported = await original(input);
      deletion = f.hub.deleteTopic(topic.id);
      await vi.waitFor(async () => expect((await f.hub.harness.snapshot(MocoStateDoc, context))?.topics?.[topic.id]?.deletedAt).toBeGreaterThan(0), { timeout: 5000, interval: 10 });
      return imported;
    });
    f.routerSteps([() => tool("moco_publish_asset", { ticket_id: ticket.id, path: "index.html" })]);
    const submission = await f.hub.sendUserMessage("发送这个文件", { topicId: topic.id });
    await submission.wait(context);
    await deletion;
    expect(imported).toBeDefined();
    expect(f.hub.uploads.getUpload(imported!.id)!.record.referenceScopes).toEqual([]);
    const response = await f.read(imported!);
    expect(response.status).toBe(403);
    await response.arrayBuffer();
    expect(assetParts((await f.hub.getTopicView("root")).messages)).toHaveLength(0);
  });

  it("denies main access to an image belonging only to another topic", async () => {
    const f = await fixture();
    const owner = await f.hub.createTopic("私有图片所属聊天");
    const other = await f.hub.createTopic("另一个聊天");
    const image = f.hub.uploads.saveUpload({ name: "private.png", mimeType: "image/png", bytes: png, ownerId: "private-image-adapter" });
    f.hub.uploads.bindAttachments([image], `conversation:${owner.conversationId}`, "private-image-adapter");
    f.routerSteps([
      () => tool("moco_publish_asset", { asset_id: image.id }),
      () => fauxAssistantMessage([fauxText("图片完成了。")]),
    ]);
    await f.hub.sendUserMessage("发送这张图", { topicId: other.id });
    await view(f, other.id, (messages) => {
      expect(messages.some((message) => message.text.includes("文件发送失败"))).toBe(true);
      expect(assetParts(messages)).toHaveLength(0);
    });
    expect(f.hub.uploads.getUpload(image.id)!.record.referenceScopes).toEqual([`conversation:${owner.conversationId}`]);
  });

  it("shows a deterministic main publication failure for an unknown asset even if its model claims success", async () => {
    const f = await fixture();
    const reader = vi.spyOn(f.hub.envManager, "createWorkerExecutionEnv");
    f.routerSteps([
      () => tool("moco_publish_asset", { asset_id: "att_missing_image_123456" }),
      () => fauxAssistantMessage([fauxText("图片已发送。")]),
    ]);
    await f.hub.sendUserMessage("发送这张图");
    await view(f, "root", (messages) => {
      expect(messages.some((message) => message.text.includes("文件发送失败"))).toBe(true);
      expect(assetParts(messages)).toHaveLength(0);
    });
    expect(reader).not.toHaveBeenCalled();
    const results = (await f.hub.rootConversation.context(context)).messages.filter((message) => message.role === "toolResult" && message.toolName === "moco_publish_asset");
    expect(results.at(-1)).toMatchObject({ isError: true });
  });
});
