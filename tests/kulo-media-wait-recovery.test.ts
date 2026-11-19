import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { KuloHub } from "@kulo/hub";
import type { BrowserRequest, BrowserResult } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => void | Promise<void>> = [];
const mp4 = Buffer.from("000000186674797069736F6D0000020069736F6D6D703432", "hex");
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const isMainBrain = (ctx: TranscriptContext) => ctx.tools?.some((tool) => tool.name === "kulo_dispatch") || ctx.messages.some((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === "kulo_dispatch"));
const hasTool = (ctx: TranscriptContext, name: string) => Boolean(ctx.tools?.some((tool) => tool.name === name) || ctx.messages.some((message) => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === name)));

afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });

async function until(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 12_000, interval: 25 });
}

async function fixture(browser: (request: BrowserRequest) => BrowserResult, respond: (ctx: TranscriptContext, hub: KuloHub) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-media-wait-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "wait-model" }] });
  const models = createModels(); models.setProvider(provider.provider);
  let hub!: KuloHub;
  provider.setResponses(Array.from({ length: 60 }, () => async (ctx: TranscriptContext) => {
    if (isMainBrain(ctx)) return answer("收到进度。");
    if (!hasTool(ctx, "kulo_generate_video")) return call("tool_search", { query: "kulo_generate_video", limit: 3 });
    return respond(ctx, hub);
  }));
  hub = await openTestHub({ models, config: { authToken: HUB_TEST_ADMIN_TOKEN, stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"),
    localEnvRoot: path.join(directory, "runtime"), enableLocalEnv: true, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "wait-model", thinkingLevel: "off", apiKey: "" } } });
  cleanups.push(() => hub.close());
  const envs = hub.envManager.listEnvs();
  vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => envs.map((env) => ({ ...env, capabilities: [...new Set([...env.capabilities, "flow-browser"])] })));
  vi.spyOn(hub.envManager, "requestBrowser").mockImplementation(async (_env, request) => browser(request));
  const capability = await hub.capabilities.configure({ commandId: "flow-test", name: "会员视频", adapter: "flow-browser", modelId: "auto", browserEnvId: "local", profileRef: "wait-test", allowTaskGeneration: true });
  await hub.capabilities.check(capability.id);
  return hub;
}

function result(request: BrowserRequest): BrowserResult {
  const base = { profileRef: request.profileRef, ...("jobId" in request ? { jobId: request.jobId } : {}) };
  if (request.action === "prepare") return { ...base, status: "ready", prepared: true, quote: { credits: 5, outputs: 1 } };
  if (request.action === "download") return { ...base, status: "completed", file: { name: "video.mp4", mimeType: "video/mp4", size: mp4.length } };
  if (request.action === "read") return { ...base, status: "completed", data: mp4.subarray(request.offset, request.offset + request.length).toString("base64"), offset: request.offset };
  return { ...base, status: request.action === "poll" ? "completed" : "ready" };
}

describe("media wait recovery through the Hub", () => {
  it("keeps an unrelated user decision waiting when a media job finishes", async () => {
    let phase = 0;
    const hub = await fixture(result, () => ++phase === 1
      ? call("kulo_generate_video", { operation_id: "video-with-separate-review", prompt: "一片树叶" })
      : call("kulo_wait", { reason: "user", detail: "等待用户确认下一步剪辑方向" }));
    const ticket = await hub.dispatchTicket({ commandId: "separate-user-wait", title: "等待剪辑方向", goal: "生成素材后等待用户决定", scope: "当前任务", role: "developer" });
    await until(async () => (await hub.inspectTicketDetail(ticket.id)).ticket.status === "waiting");
    const job = (await hub.mediaJobs.list())[0]!;
    await hub.mediaJobs.drain();
    await hub.mediaJobs.resume(job.id);
    await hub.mediaJobs.drain();
    const current = (await hub.inspectTicketDetail(ticket.id)).ticket;
    expect((await hub.mediaJobs.get(job.id)).status).toBe("completed");
    expect(current.status).toBe("waiting");
    expect(current.waiting?.reason).toBe("user");
    expect(current.waiting?.externalJobIds).toBeUndefined();
    expect(phase).toBe(2);
  });

  it("wakes the original media user-wait after login without a second submission", async () => {
    let phase = 0;
    let needsLogin = true;
    let submissions = 0;
    const hub = await fixture((request) => {
      if (request.action === "submit") { submissions++; return { ...result(request), status: "running", submitted: true }; }
      if (request.action === "poll" && needsLogin) return { ...result(request), status: "needs_login", message: "请重新登录。" };
      return result(request);
    }, async (ctx, current) => {
      if (++phase === 1) return call("kulo_generate_video", { operation_id: "video-with-login", prompt: "一片树叶" });
      if (phase === 2) return call("kulo_wait", { reason: "external", detail: "等待视频", job_id: (await current.mediaJobs.list())[0]!.id });
      expect(JSON.stringify(ctx)).toContain((await current.mediaJobs.list())[0]!.assets[0]!.id);
      return call("kulo_report", { state: "ready", summary: "继续使用原视频" });
    });
    const ticket = await hub.dispatchTicket({ commandId: "video-login-task", title: "会员视频", goal: "生成并等待", scope: "当前任务", role: "developer" });
    await until(async () => (await hub.inspectTicketDetail(ticket.id)).ticket.status === "waiting");
    await hub.mediaJobs.drain();
    const job = (await hub.mediaJobs.list())[0]!;
    await hub.mediaJobs.resume(job.id);
    await until(async () => (await hub.inspectTicketDetail(ticket.id)).ticket.waiting?.reason === "user");
    expect((await hub.inspectTicketDetail(ticket.id)).ticket.waiting?.externalJobIds).toContain(job.id);
    await hub.mediaJobs.drain();
    needsLogin = false;
    await hub.mediaJobs.resume(job.id);
    await until(async () => (await hub.inspectTicketDetail(ticket.id)).ticket.status === "ready");
    expect(submissions).toBe(1);
    expect(phase).toBe(3);
    expect((await hub.mediaJobs.get(job.id)).deliveredAt).toBeDefined();
  });

  it("lets a resumed Worker continue its original unsubmitted job under the new execution epoch", async () => {
    let phase = 0;
    let loggedIn = false;
    let submissions = 0;
    let accepted = 0;
    const hub = await fixture((request) => {
      if (request.action === "submit") {
        submissions++;
        if (!loggedIn) return { ...result(request), status: "needs_login", submitted: false };
        accepted++;
        return { ...result(request), status: "completed", submitted: true };
      }
      return result(request);
    }, async (_ctx, current) => {
      if (++phase === 1) return call("kulo_generate_video", { operation_id: "video-before-login", prompt: "一朵花" });
      if (phase === 2 || phase === 4) return call("kulo_wait", { reason: "external", detail: "等待原视频", job_id: (await current.mediaJobs.list())[0]!.id });
      if (phase === 3) return call("kulo_media_job", { action: "resume", job_id: (await current.mediaJobs.list())[0]!.id });
      return call("kulo_report", { state: "ready", summary: "原作业已完成" });
    });
    const ticket = await hub.dispatchTicket({ commandId: "video-manual-resume", title: "继续视频", goal: "登录后继续原作业", scope: "当前任务", role: "developer" });
    await until(async () => (await hub.inspectTicketDetail(ticket.id)).ticket.waiting?.reason === "user");
    await hub.mediaJobs.drain();
    const job = (await hub.mediaJobs.list())[0]!;
    expect(job.status).toBe("needs_user");
    loggedIn = true;
    await hub.steerTicket({ ticketId: ticket.id, commandId: "login-completed", text: "已经登录，继续原作业" });
    await until(async () => (await hub.inspectTicketDetail(ticket.id)).ticket.status === "ready");
    expect((await hub.mediaJobs.list())).toHaveLength(1);
    expect((await hub.mediaJobs.get(job.id)).status).toBe("completed");
    expect(submissions).toBe(2);
    expect(accepted).toBe(1);
    expect(phase).toBe(5);
  });
});
