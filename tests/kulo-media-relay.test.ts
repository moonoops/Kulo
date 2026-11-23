import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { KuloHub, KuloStateDoc, MediaRelayEntry } from "@kulo/hub";
import { escapeUntrustedText, type BrowserRequest, type BrowserResult, type MainSessionNotificationEvent, type SettingsAssistantContext } from "@kulo/protocol";
import { MediaNoticesDoc } from "../packages/hub/src/hub-media-delivery.js";
import { KuloMediaJobsDoc } from "../packages/hub/src/media-jobs.js";
import { enqueuePendingMediaRelay, pruneMediaNotices, type MediaNoticesState } from "../packages/hub/src/media-relay-policy.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";

const cleanups: Array<() => void | Promise<void>> = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
const mp4 = Buffer.from("000000186674797069736F6D0000020069736F6D6D703432", "hex");
const dummyKey = "kulo-media-relay-test-key";
const settingsContext: SettingsAssistantContext = { module: "capabilities", appearance: "light", hasUnsavedChanges: false, clientId: "relay-client" };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const hasTool = (ctx: TranscriptContext, name: string) => Boolean(
  ctx.tools?.some((t) => t.name === name) ||
  ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === name)),
);
const lastUserText = (ctx: TranscriptContext) => {
  const msg = [...ctx.messages].reverse().find((m) => m.role === "user");
  if (!msg || msg.role !== "user") return "";
  return typeof msg.content === "string"
    ? msg.content
    : msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
};

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.restoreAllMocks();
});

async function until(check: () => boolean | Promise<boolean>, timeout = 12_000) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout, interval: 25 });
}

interface ImageRouteBehavior {
  gate?: Promise<void>;
  status?: number;
  errorBody?: string;
}

async function createMultiModelImageServer(routes: Record<string, ImageRouteBehavior>) {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
      const model = body.model ?? "default";
      calls.push(model);
      const behavior = routes[model] ?? {};
      if (behavior.gate) await behavior.gate;
      if (behavior.status && behavior.status >= 400) {
        res.statusCode = behavior.status;
        res.setHeader("content-type", "application/json");
        res.end(behavior.errorBody ?? JSON.stringify({ error: { message: `model ${model} rejected` } }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: Object.keys(routes).map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

async function createRelayFixture(options: {
  directory?: string;
  onRequest?: (ctx: TranscriptContext) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>;
  modelErrorOnRelay?: boolean;
} = {}) {
  const directory = options.directory ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-media-relay-")));
  if (!options.directory) cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "relay-model", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(routeSettingsTitleRequests(provider));
  const relayPrompts: string[] = [];
  const notifications: MainSessionNotificationEvent[] = [];
  let handler = options.onRequest ?? (() => answer("已收到。"));
  provider.setResponses(Array.from({ length: 80 }, () => async (ctx: TranscriptContext) => {
    const userText = lastUserText(ctx);
    if (userText.startsWith("[KULO_MEDIA_RELAY]")) {
      relayPrompts.push(userText);
      if (options.modelErrorOnRelay) {
        return fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "401 invalid_api_key" });
      }
    }
    return handler(ctx);
  }));
  const hub = await openTestHub({
    models,
    config: {
      authToken: HUB_TEST_ADMIN_TOKEN,
      stateDir: path.join(directory, "state"),
      identityDir: path.join(directory, "identity"),
      localEnvRoot: path.join(directory, "runtime"),
      enableLocalEnv: true,
      memory: { enabled: false },
      watchdogMinutes: 0,
      model: { defaultProvider: "openai", defaultModel: "relay-model", thinkingLevel: "off", apiKey: "" },
    },
  });
  cleanups.push(() => hub.close());
  hub.subscribe({ onNotification: (event) => notifications.push(event) });
  return {
    hub,
    directory,
    relayPrompts,
    notifications,
    setHandler: (fn: typeof handler) => { handler = fn; },
  };
}

async function addImageCapability(hub: KuloHub, params: { commandId: string; name: string; modelId: string; baseUrl: string }) {
  const capability = await hub.capabilities.configure({
    commandId: params.commandId,
    name: params.name,
    adapter: "openai-image",
    modelId: params.modelId,
    baseUrl: params.baseUrl,
    allowTaskGeneration: true,
  });
  const input = await hub.capabilities.requestInput(capability.id, "secret", settingsContext.clientId);
  await hub.capabilities.submitInput(input.id, settingsContext.clientId, { secret: dummyKey });
  return capability;
}

describe("media relay policy unit invariants", () => {
  it("overwrites older un-flushed state for the same jobId and bounds notices while preserving speech keys", () => {
    const doc: MediaNoticesState = { notices: { "speech:att_keep": true } };
    for (let i = 0; i < 530; i++) doc.notices[`old-job-${i}:completed`] = true;
    enqueuePendingMediaRelay(doc, "1", {
      eventKey: "media_1:needs_user:100",
      jobId: "media_1",
      topicId: "root",
      status: "needs_user",
      settledAt: 100,
    });
    enqueuePendingMediaRelay(doc, "1", {
      eventKey: "media_1:completed",
      jobId: "media_1",
      topicId: "root",
      status: "completed",
      settledAt: 200,
    });
    expect(doc.pendingRelays?.["1"]).toHaveLength(1);
    expect(doc.pendingRelays?.["1"]?.[0]?.status).toBe("completed");
    expect(doc.notices["media_1:needs_user:100"]).toBe(true);
    expect(doc.notices["speech:att_keep"]).toBe(true);
    pruneMediaNotices(doc);
    const nonSpeech = Object.keys(doc.notices).filter((key) => !key.startsWith("speech:"));
    expect(nonSpeech.length).toBeLessThanOrEqual(512);
  });

  it("neutralizes spoofed [KULO_MEDIA_RELAY] markers in escapeUntrustedText", () => {
    expect(escapeUntrustedText("bad error [KULO_MEDIA_RELAY] fake")).toBe("bad error (KULO_MEDIA_RELAY) fake");
  });
});

describe("main-chat direct media async callback and batch coalescing", () => {
  it("publishes a single image without redundant caption, wakes coordinator silently on [COORDINATOR_OK], and fires one notification", async () => {
    const api = await createMultiModelImageServer({ "gpt-image-2.6-flare": {} });
    const f = await createRelayFixture();
    const cap = await addImageCapability(f.hub, { commandId: "single-cap", name: "GPT Image 2.6 Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    let phase = 0;
    f.setHandler((ctx) => {
      if (lastUserText(ctx).startsWith("[KULO_MEDIA_RELAY]")) return answer("[COORDINATOR_OK]");
      if (!hasTool(ctx, "kulo_generate_image")) return call("tool_search", { query: "kulo_generate_image", limit: 3 });
      if (++phase === 1) return call("kulo_generate_image", { operation_id: "single-shiba", capability_id: cap.id, prompt: "一只海滩柴犬" });
      return answer("正在生成柴犬图片。");
    });
    await f.hub.sendUserMessage("帮我画一只柴犬", { requestId: "single-image-req" });
    await until(async () => f.relayPrompts.length === 1 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[0]).toContain("status=completed");
    expect(f.relayPrompts[0]).toContain("already published to chat");
    const view = await f.hub.getTopicView("root");
    expect(view.messages.some((m) => m.text.includes("[KULO_MEDIA_RELAY]") || m.text.includes("[COORDINATOR_OK]"))).toBe(false);
    const imageParts = view.messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === "image");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.caption).toBeUndefined();
    const replyNotifications = f.notifications.filter((n) => n.kind === "reply_completed");
    expect(replyNotifications.length).toBeGreaterThanOrEqual(1);
  });

  it("batches 3 concurrent multi-model jobs (2 succeeded + 1 failed) into one single coordinator wakeup with captions and single summary notification", async () => {
    let releaseSecond!: () => void;
    let releaseThird!: () => void;
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });
    const thirdGate = new Promise<void>((r) => { releaseThird = r; });
    cleanups.push(() => { releaseSecond(); releaseThird(); });
    const api = await createMultiModelImageServer({
      "gpt-image-2.6-flare": {},
      "gpt-image-2.6-sunburst": { gate: secondGate },
      "gpt-image-1.5": { gate: thirdGate, status: 400, errorBody: JSON.stringify({ error: { message: "bad parameter on third model" } }) },
    });
    const f = await createRelayFixture();
    const flare = await addImageCapability(f.hub, { commandId: "cap-flare", name: "GPT Image 2.6 Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    const sunburst = await addImageCapability(f.hub, { commandId: "cap-sunburst", name: "GPT Image 2.6 Sunburst", modelId: "gpt-image-2.6-sunburst", baseUrl: api.baseUrl });
    const third = await addImageCapability(f.hub, { commandId: "cap-third", name: "GPT Image 1.5 Third", modelId: "gpt-image-1.5", baseUrl: api.baseUrl });

    let phase = 0;
    f.setHandler((ctx) => {
      if (lastUserText(ctx).startsWith("[KULO_MEDIA_RELAY]")) {
        return answer("测试结果汇总：Flare 与 Sunburst 成功，Third 失败。");
      }
      if (!hasTool(ctx, "kulo_generate_image")) return call("tool_search", { query: "kulo_generate_image", limit: 3 });
      if (++phase === 1) {
        return fauxAssistantMessage([
          fauxToolCall("kulo_generate_image", { operation_id: "batch-1", capability_id: flare.id, prompt: "海滩柴犬" }),
          fauxToolCall("kulo_generate_image", { operation_id: "batch-2", capability_id: sunburst.id, prompt: "海滩柴犬" }),
          fauxToolCall("kulo_generate_image", { operation_id: "batch-3", capability_id: third.id, prompt: "海滩柴犬" }),
        ], { stopReason: "toolUse" });
      }
      return answer("三个生图测试都在后台跑着，出结果了我马上告诉你。");
    });

    await f.hub.sendUserMessage("测试三个生图接口", { requestId: "batch-3-models" });
    await until(async () => {
      const jobs = await f.hub.mediaJobs.list();
      return jobs.length === 3 && jobs.some((j) => j.capabilityId === flare.id && j.status === "completed" && !!j.deliveredAt);
    });
    // Flare finished, but Sunburst and Third are still running -> coordinator must NOT wake yet.
    expect(f.relayPrompts).toHaveLength(0);
    const notifBeforeRelease = f.notifications.filter((n) => n.kind === "reply_completed").length;

    releaseSecond();
    await until(async () => (await f.hub.mediaJobs.list()).some((j) => j.capabilityId === sunburst.id && j.status === "completed" && !!j.deliveredAt));
    expect(f.relayPrompts).toHaveLength(0);

    releaseThird();
    await until(async () => f.relayPrompts.length === 1 && !(await f.hub.getTopicView("root")).live.busy);
    // Exactly ONE consolidated callback containing all 3 jobs and their job_ids.
    expect(f.relayPrompts).toHaveLength(1);
    const allJobs = await f.hub.mediaJobs.list();
    for (const j of allJobs) expect(f.relayPrompts[0]).toContain(`job_id=${j.id}`);
    expect(f.relayPrompts[0]).toContain("GPT Image 2.6 Flare");
    expect(f.relayPrompts[0]).toContain("GPT Image 2.6 Sunburst");
    expect(f.relayPrompts[0]).toContain("GPT Image 1.5 Third");
    expect(f.relayPrompts[0]).toContain("status=failed");

    const view = await f.hub.getTopicView("root");
    // No raw "媒体作业失败：" system bubble; coordinator summarized cleanly.
    expect(view.messages.some((m) => m.text.startsWith("媒体作业失败："))).toBe(false);
    expect(view.messages.some((m) => m.role === "assistant" && m.text.includes("测试结果汇总"))).toBe(true);
    const imageParts = view.messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === "image");
    expect(imageParts).toHaveLength(2);
    expect(imageParts.map((p) => p.caption).sort()).toEqual(["GPT Image 2.6 Flare", "GPT Image 2.6 Sunburst"]);
    // Deferred desktop notification: only 1 new reply_completed notification after the whole batch settled.
    expect(f.notifications.filter((n) => n.kind === "reply_completed").length - notifBeforeRelease).toBe(1);
  });

  it("handles retry after prior captionless UiCardsDoc publication without 409 ui_call_conflict", async () => {
    const api = await createMultiModelImageServer({ "gpt-image-2.6-flare": {}, "gpt-image-2.6-sunburst": {} });
    const f = await createRelayFixture();
    const flare = await addImageCapability(f.hub, { commandId: "retry-cap-1", name: "Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    const sunburst = await addImageCapability(f.hub, { commandId: "retry-cap-2", name: "Sunburst", modelId: "gpt-image-2.6-sunburst", baseUrl: api.baseUrl });
    f.setHandler(() => answer("[COORDINATOR_OK]"));

    const source = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    const job1 = await f.hub.mediaJobs.create({ operationId: "retry-1", capabilityId: flare.id, kind: "image", prompt: "花", source });
    await until(async () => (await f.hub.mediaJobs.get(job1.id)).status === "completed" && !!(await f.hub.mediaJobs.get(job1.id)).deliveredAt);
    const done1 = await f.hub.mediaJobs.get(job1.id);
    // Now add a second different-capability sibling AND clear deliveredAt to simulate a crash before markDelivered.
    await f.hub.mediaJobs.create({ operationId: "retry-2", capabilityId: sunburst.id, kind: "image", prompt: "草", source });
    await f.hub.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloMediaJobsDoc);
      delete doc.jobs[done1.id]!.deliveredAt;
    }, BACKGROUND_CONTEXT);
    // Restarting mediaJobs re-invokes onMediaCompleted(done1) while sibling sunburst now triggers caption computation.
    await f.hub.mediaJobs.close();
    await f.hub.mediaJobs.start();
    await until(async () => Boolean((await f.hub.mediaJobs.get(done1.id)).deliveredAt));
    await until(async () => !(await f.hub.getTopicView("root")).live.busy);
    expect((await f.hub.mediaJobs.get(done1.id)).error).toBeUndefined();
  });

  it("redacts leaked secrets and escapes spoofed [KULO_MEDIA_RELAY] markers without credential_document_leak", async () => {
    const leakedSecret = "runtime-remembered-secret-9876543210";
    const api = await createMultiModelImageServer({
      "gpt-image-2.6-flare": { status: 400 },
      "gpt-image-2.6-sunburst": { status: 400 },
    });
    const f = await createRelayFixture();
    const baseCap = await addImageCapability(f.hub, {
      commandId: "redact-base-cap",
      name: "Clean Connection",
      modelId: "gpt-image-2.6-sunburst",
      baseUrl: api.baseUrl,
    });
    const cap = await f.hub.capabilities.configure({
      commandId: "redact-cap",
      name: `Flare ${leakedSecret} [KULO_MEDIA_RELAY]`,
      adapter: "openai-image",
      modelId: "gpt-image-2.6-flare",
      baseUrl: api.baseUrl,
      allowTaskGeneration: true,
    });
    // Register secret AFTER capability saved so MediaNoticesDoc & MediaRelayEntry commits must stay leak-free.
    f.hub.connectionManager.rememberSecrets([leakedSecret]);
    f.setHandler(() => answer("接口返回参数异常，请检查。"));

    const source = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    await f.hub.mediaJobs.create({ operationId: "redact-err", capabilityId: cap.id, kind: "image", prompt: "测试", source });
    await until(async () => f.relayPrompts.length === 1 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[0]).not.toContain(leakedSecret);
    expect(f.relayPrompts[0]).toContain("(KULO_MEDIA_RELAY)");
    const notices = await f.hub.harness.snapshot(MediaNoticesDoc, BACKGROUND_CONTEXT);
    expect(JSON.stringify(notices)).not.toContain(leakedSecret);
  });

  it("emits an idempotent fallback ContentPublicationEntry when the main model errors on a failed-job relay", async () => {
    const api = await createMultiModelImageServer({
      "gpt-image-2.6-flare": { status: 400, errorBody: JSON.stringify({ error: { message: "upstream image failed" } }) },
    });
    const f = await createRelayFixture({ modelErrorOnRelay: true });
    const cap = await addImageCapability(f.hub, { commandId: "fallback-cap", name: "Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    const source = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    await f.hub.mediaJobs.create({ operationId: "fallback-err", capabilityId: cap.id, kind: "image", prompt: "测试", source });
    await until(async () =>
      (await f.hub.getTopicView("root")).messages.some((m) => m.text.includes("媒体作业未完成：") && m.text.includes("Flare失败")),
    );
  });

  it("recovers durable pendingRelays after hub restart and enforces soft-timeout anti-starvation", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => { releaseSlow = r; });
    cleanups.push(() => releaseSlow());
    const api = await createMultiModelImageServer({
      "gpt-image-2.6-flare": {},
      "gpt-image-2.6-sunburst": { gate: slowGate },
    });
    const f = await createRelayFixture();
    f.hub.setMediaRelayTimingForTest({ batchCoalesceMaxMs: 120, busyRecheckMs: 40 });
    const flare = await addImageCapability(f.hub, { commandId: "soft-cap-1", name: "Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    const sunburst = await addImageCapability(f.hub, { commandId: "soft-cap-2", name: "Sunburst", modelId: "gpt-image-2.6-sunburst", baseUrl: api.baseUrl });
    f.setHandler(() => answer("已收到阶段结果。"));

    const source = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    await f.hub.mediaJobs.create({ operationId: "soft-1", capabilityId: flare.id, kind: "image", prompt: "图1", source });
    await f.hub.mediaJobs.create({ operationId: "soft-2", capabilityId: sunburst.id, kind: "image", prompt: "图2", source });

    // Soft-timeout (120ms) should flush Flare first with Sunburst listed under "Still running".
    await until(async () => f.relayPrompts.length === 1 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[0]).toContain("Flare");
    expect(f.relayPrompts[0]).toContain("Still running in background");
    expect(f.relayPrompts[0]).toContain("Sunburst");

    releaseSlow();
    await until(async () => f.relayPrompts.length === 2 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[1]).toContain("Sunburst");
    expect(f.relayPrompts[1]).toContain("status=completed");
  });

  it("keeps SettingsAssistant isolated, honors pausedChats, releases waiting siblings on stop, and blocks kulo_stop during media relay", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });
    cleanups.push(() => releaseSecond());
    const api = await createMultiModelImageServer({
      "gpt-image-2.6-flare": {},
      "gpt-image-2.6-sunburst": { gate: secondGate },
    });
    const f = await createRelayFixture();
    const flare = await addImageCapability(f.hub, { commandId: "iso-cap-1", name: "Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    const sunburst = await addImageCapability(f.hub, { commandId: "iso-cap-2", name: "Sunburst", modelId: "gpt-image-2.6-sunburst", baseUrl: api.baseUrl });

    // 1. Settings Assistant direct generation must NOT trigger MediaRelayEntry.
    f.setHandler(() => answer("设置助手收到。"));
    await f.hub.settingsAssistant.send("确认配置", settingsContext, "settings-init");
    await until(async () => !(await f.hub.settingsAssistant.getSnapshot()).live.busy);
    const settingsConvId = (await f.hub.settingsAssistant.getSnapshot()).topicId!;
    const settingsNum = Number(settingsConvId.replace("settings-", ""));
    const settingsSource = await f.hub.mediaSource(settingsNum);
    const settingsJob = await f.hub.mediaJobs.create({ operationId: "settings-img", capabilityId: flare.id, kind: "image", prompt: "测试图", source: settingsSource });
    await until(async () => Boolean((await f.hub.mediaJobs.get(settingsJob.id)).deliveredAt));
    expect(f.relayPrompts).toHaveLength(0);

    // 2. Stopping Job 2 while Job 1 is waiting in pendingRelays immediately releases Job 1 without echo for Job 2.
    const rootSource = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    const job1 = await f.hub.mediaJobs.create({ operationId: "stop-rel-1", capabilityId: flare.id, kind: "image", prompt: "图A", source: rootSource });
    const job2 = await f.hub.mediaJobs.create({ operationId: "stop-rel-2", capabilityId: sunburst.id, kind: "image", prompt: "图B", source: rootSource });
    await until(async () => Boolean((await f.hub.mediaJobs.get(job1.id)).deliveredAt));
    expect(f.relayPrompts).toHaveLength(0);
    await f.hub.mediaJobs.stop(job2.id);
    await until(async () => f.relayPrompts.length === 1 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[0]).toContain(`job_id=${job1.id}`);
    expect(f.relayPrompts[0]).not.toContain(`job_id=${job2.id}`);

    // 3. pausedChats defers MediaRelayEntry until user resumes, while image still publishes.
    await f.hub.abortForegroundTurn("root");
    const pausedJob = await f.hub.mediaJobs.create({ operationId: "paused-img", capabilityId: flare.id, kind: "image", prompt: "暂停中生图", source: rootSource });
    await until(async () => Boolean((await f.hub.mediaJobs.get(pausedJob.id)).deliveredAt));
    await until(async () => {
      const state = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      return Boolean(state?.pausedChats?.[String(f.hub.rootConversation.id)]?.some((d) => d.entry?.kind === MediaRelayEntry.kind));
    });
    expect(f.relayPrompts).toHaveLength(1);
    await f.hub.sendUserMessage("继续", { requestId: "resume-after-pause" });
    await until(async () => f.relayPrompts.length === 2 && !(await f.hub.getTopicView("root")).live.busy);

    // 4. kulo_stop during a MediaRelayEntry turn is rejected with automatic_stop_denied.
    const ticket = await f.hub.dispatchTicket({ commandId: "guard-ticket", title: "无关任务", goal: "等待", scope: "当前任务", role: "developer", executeAt: "2099-01-01T00:00:00Z" });
    let stopErrorText = "";
    let relayAttempt = 0;
    f.setHandler((ctx) => {
      if (lastUserText(ctx).startsWith("[KULO_MEDIA_RELAY]") && ++relayAttempt === 1) {
        return call("kulo_stop", { ticket_id: ticket.id, reason: "trying unauthorized stop" });
      }
      const toolErr = ctx.messages.findLast((m) => m.role === "toolResult" && m.toolName === "kulo_stop");
      if (toolErr && toolErr.role === "toolResult") {
        stopErrorText = toolErr.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      }
      return answer("已完成。");
    });
    await f.hub.mediaJobs.create({ operationId: "stop-guard-img", capabilityId: flare.id, kind: "image", prompt: "图C", source: rootSource });
    await until(async () => stopErrorText.length > 0 && !(await f.hub.getTopicView("root")).live.busy);
    expect(stopErrorText).toContain("后台巡检和回报不能代替用户停止任务");
  });

  it("wakes coordinator twice across a Flow needs_user -> resume -> completed lifecycle", async () => {
    const f = await createRelayFixture();
    let needsLogin = true;
    const envs = f.hub.envManager.listEnvs();
    vi.spyOn(f.hub.envManager, "listEnvs").mockImplementation(() =>
      envs.map((env) => ({ ...env, capabilities: [...new Set([...env.capabilities, "flow-browser"])] })),
    );
    vi.spyOn(f.hub.envManager, "requestBrowser").mockImplementation(async (_env, req: BrowserRequest): Promise<BrowserResult> => {
      const base = { profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
      if (req.action === "prepare") return { ...base, status: "ready", prepared: true, quote: { credits: 5, outputs: 1 } };
      if (req.action === "submit") {
        if (needsLogin) return { ...base, status: "needs_login", submitted: false };
        return { ...base, status: "completed", submitted: true };
      }
      if (req.action === "download") return { ...base, status: "completed", file: { name: "clip.mp4", mimeType: "video/mp4", size: mp4.length } };
      if (req.action === "read") return { ...base, status: "completed", data: mp4.subarray(req.offset, req.offset + req.length).toString("base64"), offset: req.offset };
      return { ...base, status: req.action === "poll" ? "completed" : "ready" };
    });
    const flowCap = await f.hub.capabilities.configure({
      commandId: "flow-relay-cap",
      name: "Flow Video",
      adapter: "flow-browser",
      modelId: "auto",
      browserEnvId: "local",
      profileRef: "flow-relay-profile",
      allowTaskGeneration: true,
    });
    await f.hub.capabilities.check(flowCap.id);
    f.setHandler(() => answer("已同步视频状态。"));

    const source = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    const job = await f.hub.mediaJobs.create({ operationId: "flow-dual-wake", capabilityId: flowCap.id, kind: "video", prompt: "微风吹过树叶", source });
    await until(async () => f.relayPrompts.length === 1 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[0]).toContain(`job_id=${job.id}`);
    expect(f.relayPrompts[0]).toContain("status=needs_user");

    needsLogin = false;
    await f.hub.mediaJobs.resume(job.id, source);
    await until(async () => f.relayPrompts.length === 2 && !(await f.hub.getTopicView("root")).live.busy);
    expect(f.relayPrompts[1]).toContain(`job_id=${job.id}`);
    expect(f.relayPrompts[1]).toContain("status=completed");
  });

  it("reconciles persisted pendingRelays on hub restart without duplicating assets or losing callbacks", async () => {
    const api = await createMultiModelImageServer({ "gpt-image-2.6-flare": {} });
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-media-relay-restart-")));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));

    const f1 = await createRelayFixture({ directory });
    const cap = await addImageCapability(f1.hub, { commandId: "restart-cap", name: "Flare", modelId: "gpt-image-2.6-flare", baseUrl: api.baseUrl });
    const source = await f1.hub.mediaSource(Number(f1.hub.rootConversation.id));
    // Pause chat, complete job (deliveredAt set), then simulate crash by manually moving pendingRelays back while unpausing before reopen.
    await f1.hub.abortForegroundTurn("root");
    const job = await f1.hub.mediaJobs.create({ operationId: "restart-img", capabilityId: cap.id, kind: "image", prompt: "重启恢复", source });
    await until(async () => Boolean((await f1.hub.mediaJobs.get(job.id)).deliveredAt));
    // Re-stage pendingRelays and remove the flushed notice/pausedChat entry to simulate crash right after markDelivered and before flush.
    await f1.hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      delete state.pausedChats?.[String(f1.hub.rootConversation.id)];
      const notices = await tx.doc(MediaNoticesDoc);
      delete notices.notices[`${job.id}:completed`];
      notices.pendingRelays = {
        [String(f1.hub.rootConversation.id)]: [{
          eventKey: `${job.id}:completed`,
          jobId: job.id,
          topicId: "root",
          status: "completed",
          settledAt: Date.now(),
        }],
      };
    }, BACKGROUND_CONTEXT);
    await f1.hub.close();
    // Remove f1.hub.close from cleanups (already closed)
    cleanups.pop();

    const f2 = await createRelayFixture({ directory, onRequest: () => answer("重启后已自动补发结果。") });
    await until(async () => f2.relayPrompts.length === 1 && !(await f2.hub.getTopicView("root")).live.busy);
    expect(f2.relayPrompts[0]).toContain(`job_id=${job.id}`);
    const imageParts = (await f2.hub.getTopicView("root")).messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === "image");
    expect(imageParts).toHaveLength(1);
  });
});
