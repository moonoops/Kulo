import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesWorkspaceSnapshot, ImageCapabilityDraft, ImageDraftSaveResult, MediaJob, SettingsAssistantContext } from "@moco/protocol";
import { startMocoHubServer } from "../packages/hub/src/server.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";

const cleanup: Array<() => void | Promise<void>> = [];
const nodeToken = "image-setup-node-fixture-only";
const secret = "synthetic-image-setup-http-key";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64");
const context: SettingsAssistantContext = { module: "capabilities", appearance: "light", hasUnsavedChanges: false, clientId: "image-http-client" };
const draftConfig = (baseUrl = "https://image-fixture.example/v1") => ({ name: "HTTP image model", adapter: "openai-image", modelId: "gpt-image-2.6-flare", baseUrl });
const answer = () => fauxAssistantMessage([fauxText("配置已更新。")]);
const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-image-http-test-")));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "image-http-chat" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  let respond: (ctx: TranscriptContext) => ReturnType<typeof answer> = answer;
  const transcripts: TranscriptContext[] = [];
  provider.setResponses(Array.from({ length: 30 }, () => (ctx: TranscriptContext) => { transcripts.push(ctx); return respond(ctx); }));
  const hub = await openTestHub({ models, config: {
    stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    envTokens: { "image-node": nodeToken }, workerEnvIds: ["image-node"], enableLocalEnv: false, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "image-http-chat", thinkingLevel: "off", apiKey: "" },
  } });
  cleanup.push(() => hub.close());
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  async function call<T = Record<string, unknown>>(route: string, method = "GET", body?: unknown, token: string | null = HUB_TEST_ADMIN_TOKEN) {
    const response = await fetch(`${server.url}${route}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, cacheControl: response.headers.get("cache-control") };
  }
  const workspace = () => call<CapabilitiesWorkspaceSnapshot>(`/api/capabilities?clientId=${context.clientId}`);
  return { hub, call, workspace, transcripts, respond: (fn: typeof respond) => { respond = fn; } };
}

async function upstream() {
  const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    const entry = { url: request.url ?? "", authorization: request.headers.authorization, body: undefined as unknown };
    requests.push(entry);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/v1/images/generations") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      entry.body = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } else response.end(JSON.stringify({ id: "gpt-image-2.6-flare" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`, requests };
}

describe("image setup management HTTP", () => {
  it("requires management authorization for drafts, discoveries, imports, rules and generation tests", async () => {
    const f = await fixture();
    const routes: Array<[string, string, unknown]> = [
      ["/api/capabilities", "GET", undefined],
      ["/api/capabilities/image/draft", "POST", { clientId: context.clientId, config: draftConfig() }],
      ["/api/capabilities/image/draft", "DELETE", { clientId: context.clientId }],
      ["/api/capabilities/image/draft/save", "POST", { clientId: context.clientId, expectedRevision: 1, commandId: "save" }],
      [`/api/capabilities/image/discover?clientId=${context.clientId}`, "GET", undefined],
      ["/api/capabilities/image/discover", "POST", { clientId: context.clientId }],
      ["/api/capabilities/image/import", "POST", { clientId: context.clientId }],
      ["/api/capabilities/image/routing", "PUT", { settings: {}, expectedRevision: 0, commandId: "routing" }],
      ["/api/capabilities/image/cap-example/test", "POST", { clientId: context.clientId, commandId: "test" }],
    ];
    const before = await f.hub.capabilities.snapshot();
    for (const token of [null, nodeToken]) for (const [route, method, body] of routes) expect((await f.call(route, method, body, token)).status, `${method} ${route}`).toBe(401);
    expect(await f.hub.capabilities.snapshot()).toEqual(before);
    expect((await f.workspace()).body.imageSetup!.draft).toBeUndefined();
  });

  it("round trips a client draft and save receipt without generating an image or exposing another window's input", async () => {
    const api = await upstream();
    const f = await fixture();
    const created = await f.call<ImageCapabilityDraft>("/api/capabilities/image/draft", "POST", { clientId: context.clientId, expectedRevision: 0, config: draftConfig(api.baseUrl) });
    expect(created.status).toBe(200);
    expect(created.cacheControl).toBe("no-store");
    expect((await f.workspace()).body.imageSetup!.draft).toEqual(created.body);
    const saveRequest = { clientId: context.clientId, expectedRevision: created.body.revision, commandId: "save-once" };
    const saved = await f.call<ImageDraftSaveResult>("/api/capabilities/image/draft/save", "POST", saveRequest);
    expect(saved.status).toBe(200);
    expect(saved.body.capability.allowTaskGeneration).toBe(true);
    expect(saved.body.input).toMatchObject({ clientId: context.clientId, kind: "secret" });
    expect((await f.call<ImageDraftSaveResult>("/api/capabilities/image/draft/save", "POST", saveRequest)).body).toEqual(saved.body);
    const current = (await f.workspace()).body;
    expect(current.capabilities).toHaveLength(1);
    expect(current.inputs).toHaveLength(1);
    expect(current.imageSetup!.draft).toBeUndefined();
    const other = await f.call<CapabilitiesWorkspaceSnapshot>("/api/capabilities?clientId=other-window");
    expect(other.body.inputs).toEqual([]);
    expect(other.body.imageSetup!.draft).toBeUndefined();
    expect(api.requests).toEqual([]);
    expect(JSON.stringify(saved.body)).not.toContain(secret);
  });

  it("validates unknown fields, client identity, revision types, protected data and duplicate candidate selections", async () => {
    const f = await fixture();
    const invalidDrafts = [
      { config: draftConfig() }, { clientId: "constructor", config: draftConfig() },
      { clientId: context.clientId, config: draftConfig(), unexpected: true },
      { clientId: context.clientId, config: { ...draftConfig(), apiKey: secret } },
      { clientId: context.clientId, config: { ...draftConfig(), defaults: { custom: JSON.parse('{"__proto__":{"polluted":true}}') } } },
      { clientId: context.clientId, config: draftConfig(), expectedRevision: -1 },
    ];
    for (const body of invalidDrafts) expect((await f.call("/api/capabilities/image/draft", "POST", body)).status).toBe(400);
    const draft = await f.call<ImageCapabilityDraft>("/api/capabilities/image/draft", "POST", { clientId: context.clientId, config: draftConfig() });
    expect((await f.call("/api/capabilities/image/draft", "POST", { clientId: context.clientId, expectedRevision: 0, config: draftConfig() })).status).toBe(409);
    for (const expectedRevision of [undefined, "1", -1]) expect((await f.call("/api/capabilities/image/draft/save", "POST", { clientId: context.clientId, expectedRevision, commandId: "save-invalid" })).status).toBe(400);
    expect((await f.call("/api/capabilities/image/import", "POST", { clientId: context.clientId, discoveryId: "discovery", commandId: "import-invalid", candidateIds: ["candidate", "candidate"] })).status).toBe(400);
    expect((await f.workspace()).body.imageSetup!.draft).toEqual(draft.body);
    expect((await f.hub.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it("uses the same draft for an HTTP form and the right-side settings tool", async () => {
    const f = await fixture();
    const initial = await f.call<ImageCapabilityDraft>("/api/capabilities/image/draft", "POST", { clientId: context.clientId, config: draftConfig() });
    let phase = 0;
    f.respond(() => ++phase === 1 ? tool("moco_capabilities_read", {}) : phase === 2 ? tool("moco_image_draft", { action: "update", config: JSON.stringify({ ...initial.body.config, name: "Updated by Moco" }) }) : answer());
    await f.hub.settingsAssistant.send("把当前表单的图像名称修改为 Updated by Moco", context, "update-shared-image-draft");
    await vi.waitFor(async () => { expect(phase).toBeGreaterThanOrEqual(3); expect((await f.hub.settingsAssistant.getSnapshot()).live.busy).toBe(false); }, { timeout: 10_000, interval: 25 });
    const workspace = (await f.workspace()).body;
    expect(workspace.imageSetup!.draft).toMatchObject({ revision: initial.body.revision + 1, config: { name: "Updated by Moco" } });
    const transcript = JSON.stringify(f.transcripts);
    for (const name of ["moco_image_draft", "moco_image_models_discover", "moco_image_models_import", "moco_image_routing", "web_fetch"]) expect(transcript).toContain(name);
    const saved = await f.call<ImageDraftSaveResult>("/api/capabilities/image/draft/save", "POST", { clientId: context.clientId, expectedRevision: workspace.imageSetup!.draft!.revision, commandId: "save-assistant-draft" });
    expect(saved.status).toBe(200);
    expect(saved.body.capability.name).toBe("Updated by Moco");
    expect((await f.hub.capabilities.snapshot()).capabilities).toHaveLength(1);
  });

  it("rejects private documentation URLs before issuing a network request", async () => {
    const f = await fixture();
    let phase = 0;
    f.respond(() => ++phase === 1 ? tool("web_fetch", { url: "http://127.0.0.1:9/private-docs" }) : answer());
    await f.hub.settingsAssistant.send("读取这个图片服务的接口说明", context, "reject-private-image-docs");
    await vi.waitFor(async () => { expect(phase).toBeGreaterThanOrEqual(2); expect((await f.hub.settingsAssistant.getSnapshot()).live.busy).toBe(false); }, { timeout: 10_000, interval: 25 });
    const result = f.transcripts.flatMap((entry) => entry.messages).find((message) => message.role === "toolResult" && message.toolName === "web_fetch");
    expect(result).toMatchObject({ role: "toolResult", isError: true });
    expect(JSON.stringify(result)).toMatch(/公开|受限|私有|内网|本地|公网|public|private/i);
    expect((await f.hub.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it("runs an explicit setup test without granting automatic use, duplicating a job or publishing to main chat", async () => {
    const api = await upstream();
    const f = await fixture();
    const cap = await f.hub.capabilities.configure({ ...draftConfig(api.baseUrl), adapter: "openai-image", commandId: "test-image-config", allowTaskGeneration: false });
    const input = await f.hub.capabilities.requestInput(cap.id, "secret", context.clientId);
    await f.hub.capabilities.submitInput(input.id, context.clientId, { secret });
    const before = (await f.hub.getTopicView("root")).messages;
    const checked = await f.call(`/api/capabilities/image/${cap.id}/check`, "POST", {});
    expect(checked.status).toBe(200);
    expect(api.requests.filter((request) => request.body)).toEqual([]);
    const request = { clientId: context.clientId, commandId: "generate-test-once", prompt: "A red circle" };
    const created = await f.call<MediaJob>(`/api/capabilities/image/${cap.id}/test`, "POST", request);
    expect(created.status).toBe(200);
    expect(created.body.source.setupClientId).toBe(context.clientId);
    const replay = await f.call<MediaJob>(`/api/capabilities/image/${cap.id}/test`, "POST", request);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(created.body.id);
    await vi.waitFor(async () => expect((await f.hub.mediaJobs.list()).find((job) => job.id === created.body.id)).toMatchObject({ status: "completed", deliveredAt: expect.any(Number), assets: [expect.objectContaining({ kind: "image" })] }), { timeout: 10_000, interval: 25 });
    expect(api.requests.filter((entry) => entry.body)).toEqual([expect.objectContaining({ authorization: `Bearer ${secret}`, body: expect.objectContaining({ prompt: "A red circle", n: 1 }) })]);
    expect((await f.hub.capabilities.snapshot()).capabilities.find((item) => item.id === cap.id)!.allowTaskGeneration).toBe(false);
    expect((await f.hub.getTopicView("root")).messages).toEqual(before);
    const source = await f.hub.mediaSource(Number(f.hub.rootConversation.id));
    await expect(f.hub.mediaJobs.create({ operationId: "ordinary-chat-still-denied", capabilityId: cap.id, kind: "image", prompt: "Another circle", source })).rejects.toMatchObject({ code: "media_task_generation_not_allowed" });

    const defaultTest = await f.call<MediaJob>(`/api/capabilities/image/${cap.id}/test`, "POST", { clientId: context.clientId, commandId: "generate-test-default-prompt" });
    expect(defaultTest.status).toBe(200);
    expect(defaultTest.body.prompt).toBe("画一只正在吃甜筒的猫");
    await vi.waitFor(async () => expect((await f.hub.mediaJobs.list()).find((job) => job.id === defaultTest.body.id)).toMatchObject({ status: "completed", prompt: "画一只正在吃甜筒的猫" }), { timeout: 10_000, interval: 25 });
    expect(api.requests.filter((entry) => entry.body).at(-1)).toEqual(expect.objectContaining({ authorization: `Bearer ${secret}`, body: expect.objectContaining({ prompt: "画一只正在吃甜筒的猫", n: 1 }) }));
  });
});
