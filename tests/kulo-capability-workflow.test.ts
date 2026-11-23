import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { KuloHub, KuloStateDoc, startKuloHubServer } from "@kulo/hub";
import type { SettingsAssistantContext } from "@kulo/protocol";
import { fetchWithHubAuth, HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => void | Promise<void>> = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
const dummyKey = "kulo-workflow-fixture-credential";
const settingsContext: SettingsAssistantContext = { module: "capabilities", appearance: "light", hasUnsavedChanges: false, clientId: "capability-client" };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const hasTool = (ctx: TranscriptContext, name: string) => Boolean(
  ctx.tools?.some((t) => t.name === name) ||
  ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === name)),
);

afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });

async function imageServer(gate?: Promise<void>) {
  let generated = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      generated++;
      expect(req.headers.authorization).toBe(`Bearer ${dummyKey}`);
      for await (const _chunk of req) { /* Consume the bounded test request. */ }
      await gate;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "gpt-image-2.6-flare", data: [{ id: "gpt-image-2.6-flare" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`, generated: () => generated };
}

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-capability-workflow-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "workflow-model", input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  const transcripts: string[] = [];
  let respond: (ctx: TranscriptContext) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>> = () => answer("已收到。");
  provider.setResponses(Array.from({ length: 60 }, () => async (ctx: TranscriptContext) => { transcripts.push(JSON.stringify(ctx)); return respond(ctx); }));
  const hub = await openTestHub({ models, config: { authToken: HUB_TEST_ADMIN_TOKEN, stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"),
    localEnvRoot: path.join(directory, "runtime"), enableLocalEnv: true, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "workflow-model", thinkingLevel: "off", apiKey: "" } } });
  cleanups.push(() => hub.close());
  return { hub, directory, transcripts, respond: (fn: typeof respond) => { respond = fn; } };
}

async function until(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 12_000, interval: 25 });
}

async function configure(hub: KuloHub, baseUrl: string) {
  const capability = await hub.capabilities.configure({ commandId: "image-config", name: "图片", adapter: "openai-image", modelId: "gpt-image-2.6-flare", baseUrl, allowTaskGeneration: true });
  const input = await hub.capabilities.requestInput(capability.id, "secret", settingsContext.clientId);
  await hub.capabilities.submitInput(input.id, settingsContext.clientId, { secret: dummyKey });
  return capability;
}

describe("capability workflow through real Hub", () => {
  it("gives the settings Agent image onboarding questions and public credential-source handles", async () => {
    const f = await fixture();
    const template = (await f.hub.listProviders())[0]!;
    vi.spyOn(f.hub, "listProviders").mockResolvedValue([
      { ...template, id: "api-image-source", name: "已有图片服务", builtin: false, authenticated: true, authType: "api_key", baseUrl: "https://images.example/v1" },
      { ...template, id: "api-subscription-source", builtin: false, authenticated: true, authType: "oauth", baseUrl: "https://subscription.example/v1" },
    ]);
    let phase = 0;
    f.respond(() => ++phase === 1 ? call("kulo_capabilities_read", {}) : answer("想接入哪种生图服务和模型？是否复用已有 API Key，需要 GIF 动图吗？"));
    await f.hub.settingsAssistant.send("添加图像模型", settingsContext, "image-onboarding");
    await until(async () => phase >= 2 && !(await f.hub.settingsAssistant.getSnapshot()).live.busy);
    const transcript = f.transcripts.at(-1)!;
    expect(transcript).toContain("grounded in user-supplied docs");
    expect(transcript).toContain("The Image Settings form and right-hand chat share one server draft");
    expect(transcript).toContain("never guessed from model names");
    expect(transcript).toContain("credentialProviders");
    expect(transcript).toContain("api-image-source");
    const workspace = await f.hub.getCapabilitiesSnapshot(settingsContext.clientId);
    expect(workspace.imageSetup?.providers.find((provider) => provider.id === "api-subscription-source")).toMatchObject({ authType: "oauth", imageSupported: false });
    expect(transcript).toContain("credentialProviderId");
    expect(transcript).toContain("adding a key never auto-enables paid generation");
    expect(transcript).not.toContain("GPT Image 2.6可用GIF");
    expect((await f.hub.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it("configures through the settings Agent, isolates secure input and publishes a real generated attachment", async () => {
    const api = await imageServer();
    const f = await fixture();
    const server = await startKuloHubServer(f.hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());
    let phase = 0;
    f.respond(() => ++phase === 1 ? call("kulo_capabilities_read", {}) : phase === 2 ? call("kulo_capability_configure", {
      config: JSON.stringify({ name: "对话配置图片", adapter: "openai-image", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl, allowTaskGeneration: true }),
    }) : answer("请完成右侧保密输入。"));
    await f.hub.settingsAssistant.send("添加生图能力并允许按需生成", settingsContext, "setup-once");
    await until(async () => !(await f.hub.settingsAssistant.getSnapshot()).live.busy && (await f.hub.capabilities.snapshot()).capabilities.length === 1);
    const workspace = await f.hub.getCapabilitiesSnapshot(settingsContext.clientId);
    expect(workspace.skills.map((skill) => skill.id)).toEqual(["genui-cards", "interactive-html"]);
    expect((await f.hub.skills.catalog("chat", { capabilities: [], mediaKinds: ["image"] })).map((skill) => skill.id)).toContain("image-generation");
    const input = workspace.inputs.find((item) => item.status === "pending")!;
    expect(input).toBeDefined();
    const unauthenticated = await fetch(`${server.url}/api/capabilities`);
    expect(unauthenticated.status).toBe(401);
    const foreign = await fetchWithHubAuth(`${server.url}/api/capabilities/inputs/${input.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "other-client", secret: dummyKey }) });
    expect(foreign.status).toBe(403);
    const saved = await fetchWithHubAuth(`${server.url}/api/capabilities/inputs/${input.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: settingsContext.clientId, secret: dummyKey }) });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(dummyKey);
    expect((await f.hub.getCapabilitiesSnapshot("other-client")).inputs).toEqual([]);
    const capability = workspace.capabilities[0]!;
    await f.hub.capabilities.check(capability.id);
    expect(api.generated()).toBe(0);
    phase = 0;
    f.respond((ctx) => {
      if (phase === 0 && !hasTool(ctx, "kulo_media_capabilities")) return call("tool_search", { query: "kulo_media_capabilities", limit: 3 });
      if (++phase === 1) return call("kulo_media_capabilities", {});
      if (phase === 2) return call("kulo_generate_image", { operation_id: "hero-image-v1", capability_id: capability.id, prompt: "一朵花" });
      if (phase === 3) return answer("图片已提交生成。");
      return answer("[COORDINATOR_OK]");
    });
    await f.hub.sendUserMessage("生成一张花的图片", { requestId: "image-chat" });
    await until(async () => (await f.hub.mediaJobs.list()).some((job) => job.status === "completed" && !!job.deliveredAt));
    const job = (await f.hub.mediaJobs.list())[0]!;
    expect(job.assets[0]?.kind).toBe("image");
    expect(api.generated()).toBe(1);
    const repeated = await f.hub.mediaJobs.create({ operationId: "hero-image-v1", capabilityId: capability.id, kind: "image", prompt: "一朵花", source: job.source });
    expect(repeated.id).toBe(job.id);
    expect(api.generated()).toBe(1);
    await until(async () => phase >= 4 && !(await f.hub.getTopicView("root")).live.busy && (await f.hub.getTopicView("root")).messages.some((item) => item.parts?.some((part) => part.type === "image" && part.assetId === job.assets[0]?.id)));
    expect(JSON.stringify(await f.hub.getCapabilitiesSnapshot(settingsContext.clientId))).not.toContain(dummyKey);
    expect(f.transcripts.join("\n")).not.toContain(dummyKey);
  });

  it("restores a Worker media wait and keeps its exported image private until the main Agent inspects and publishes it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cleanups.push(() => release());
    const api = await imageServer(gate);
    const f = await fixture();
    const capability = await configure(f.hub, api.baseUrl);
    let phase = 0;
    const mainInputs: TranscriptContext[] = [];
    f.respond(async (ctx) => {
      if (hasTool(ctx, "kulo_dispatch")) { mainInputs.push(ctx); return answer("收到进度。"); }
      if (phase === 0 && !hasTool(ctx, "kulo_generate_image")) return call("tool_search", { query: "kulo_generate_image", limit: 3 });
      if (++phase === 1) return call("kulo_generate_image", { operation_id: "worker-reference-v1", capability_id: capability.id, prompt: "一片叶子" });
      if (phase === 2) return call("kulo_wait", { reason: "external", detail: "等待素材生成", job_id: (await f.hub.mediaJobs.list())[0]!.id });
      if (phase === 3) return call("kulo_media_export", { asset_id: (await f.hub.mediaJobs.list())[0]!.assets[0]!.id, path: "reference.png" });
      return call("kulo_report", { state: "ready", summary: "使用已完成的素材继续任务" });
    });
    const ticket = await f.hub.dispatchTicket({ commandId: "worker-media-task", title: "生成素材", goal: "按授权生成素材并等待", scope: "当前任务", role: "developer" });
    await until(async () => (await f.hub.inspectTicketDetail(ticket.id)).ticket.status === "waiting");
    const waiting = (await f.hub.inspectTicketDetail(ticket.id)).ticket;
    const job = (await f.hub.mediaJobs.list())[0]!;
    expect(waiting.runEpoch).toBeGreaterThan(job.source.runEpoch!);
    expect(waiting.waiting?.externalJobIds).toContain(job.id);
    release();
    await until(async () => (await f.hub.inspectTicketDetail(ticket.id)).ticket.status === "ready");
    const completed = (await f.hub.inspectTicketDetail(ticket.id)).ticket;
    const expectedPath = path.join(completed.workspaceDir, "reference.png");
    const finishedJob = await f.hub.mediaJobs.get(job.id);
    const worker = await f.hub.harness.conversation(completed.workerConversationId as ConversationId, BACKGROUND_CONTEXT);
    const toolResults = (await worker!.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult" && message.toolName === "kulo_media_export");
    expect(toolResults).toHaveLength(1);
    const exported = toolResults[0]!;
    expect(exported.isError, JSON.stringify(exported.content)).not.toBe(true);
    const receiptText = exported.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    expect(JSON.parse(receiptText)).toMatchObject({ path: expectedPath, assetId: finishedJob.assets[0]!.id, reused: false });
    expect(fs.readFileSync(expectedPath)).toEqual(png);
    expect(api.generated()).toBe(1);
    expect(phase).toBe(4);
    expect(await f.hub.mediaJobs.list()).toHaveLength(1);
    expect((await f.hub.mediaJobs.get(job.id)).status).toBe("completed");
    const asset = finishedJob.assets[0]!;
    await until(async () => !!(await f.hub.mediaJobs.get(job.id)).deliveredAt && mainInputs.some((ctx) => JSON.stringify(ctx).includes(asset.id)) && !(await f.hub.getTopicView("root")).live.busy);
    const staged = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(staged?.workerArtifacts?.[ticket.id]).toEqual([expect.objectContaining({ id: asset.id, kind: "image" })]);
    const scopes = f.hub.uploads.getUpload(asset.id)!.record.referenceScopes;
    expect(scopes).toContain(`ticket:${ticket.id}`);
    expect(scopes).not.toContain(`conversation:${Number(f.hub.rootConversation.id)}`);
    expect((await f.hub.getTopicView("root")).messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "image")).toHaveLength(0);

    let reviewPhase = 0;
    let inspectedImage: { type: "image"; data: string; mimeType: string } | undefined;
    let imagesBeforePublication = -1;
    let publicationReceipt: unknown;
    f.respond(async (ctx) => {
      if (++reviewPhase === 1) return call("kulo_inspect_asset", { asset_id: asset.id });
      if (reviewPhase === 2) {
        const inspected = ctx.messages.findLast((message) => message.role === "toolResult" && message.toolName === "kulo_inspect_asset");
        if (inspected?.role === "toolResult") inspectedImage = inspected.content.find((part) => part.type === "image");
        imagesBeforePublication = (await f.hub.getTopicView("root")).messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "image").length;
        return call("kulo_publish_asset", { asset_id: asset.id });
      }
      const published = ctx.messages.findLast((message) => message.role === "toolResult" && message.toolName === "kulo_publish_asset");
      if (published?.role === "toolResult") publicationReceipt = JSON.parse(published.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      return answer("已检查并发送图片。");
    });
    await f.hub.sendUserMessage("检查素材，符合要求后发给我", { requestId: "review-worker-image" });
    await until(async () => reviewPhase >= 3 && !(await f.hub.getTopicView("root")).live.busy);
    expect(inspectedImage).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    expect(imagesBeforePublication).toBe(0);
    expect(publicationReceipt).toMatchObject({ id: asset.id, status: "published" });
    const imageParts = (await f.hub.getTopicView("root")).messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "image");
    expect(imageParts).toEqual([expect.objectContaining({ assetId: asset.id })]);
    expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.workerArtifacts?.[ticket.id]).toEqual([]);
    expect(api.generated()).toBe(1);
  });

  it("requires client confirmation before removing a media capability", async () => {
    const api = await imageServer();
    const f = await fixture();
    const capability = await configure(f.hub, api.baseUrl);
    let phase = 0;
    f.respond((ctx) => {
      if (phase === 1 && !hasTool(ctx, "kulo_capability_manage")) return call("tool_search", { query: "kulo_capability_manage", limit: 3 });
      return ++phase === 1 ? call("kulo_capabilities_read", {}) : phase === 2 ? call("kulo_capability_manage", { action: "remove", id: capability.id }) : answer("请确认移除。");
    });
    f.hub.settingsAssistant.updateContext(settingsContext);
    await f.hub.settingsAssistant.send("移除这个生图能力", settingsContext, "remove-media");
    await until(async () => !(await f.hub.settingsAssistant.getSnapshot()).live.busy && (await f.hub.settingsAssistant.getSnapshot()).actions.some((a) => a.status === "pending"));
    const pending = (await f.hub.settingsAssistant.getSnapshot()).actions.find((a) => a.status === "pending")!;
    expect((await f.hub.capabilities.snapshot()).capabilities).toHaveLength(1);
    await expect(f.hub.settingsAssistant.decide(pending.id, "confirm", "foreign-client")).rejects.toThrow("另一台浏览器");
    await f.hub.settingsAssistant.decide(pending.id, "confirm", settingsContext.clientId);
    await f.hub.settingsAssistant.decide(pending.id, "confirm", settingsContext.clientId);
    expect((await f.hub.capabilities.snapshot()).capabilities).toHaveLength(0);
  });
});
