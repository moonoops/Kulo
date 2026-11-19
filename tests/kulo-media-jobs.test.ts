import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { BrowserRequest, BrowserResult, CapabilityRecord, MediaConnectionView, MediaJobRequest, CustomImageAdapter } from "@kulo/protocol";
import { MediaJobError, KuloMediaJobs, KuloMediaJobsDoc, type MediaCapabilities, type MediaJobsOptions } from "../packages/hub/src/media-jobs.js";
import { KuloUploadStore } from "../packages/hub/src/uploads.js";
import { CapabilityError, KuloCapabilities } from "../packages/hub/src/capabilities.js";
import { FileCredentialStore } from "../packages/hub/src/providers.js";

const context = BACKGROUND_CONTEXT;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z", "base64");
const mp4 = Buffer.from("000000186674797069736F6D0000020069736F6D6D703432", "hex");
const directories: string[] = [];
const resources: Array<{ jobs: KuloMediaJobs; harness: Harness }> = [];
function flowPrepared(req: Extract<BrowserRequest, { action: "prepare" }>): BrowserResult {
  return { status: "ready", prepared: true, submitted: false, profileRef: req.profileRef, jobId: req.jobId,
    quote: { credits: 5, outputs: 1, ...(req.durationSeconds !== undefined ? { durationSeconds: req.durationSeconds } : {}), ...(req.modelId ? { modelId: req.modelId } : {}) } };
}

function configuration(adapter: MediaConnectionView["adapter"] = "openai-image") {
  const capability: CapabilityRecord = {
    id: "cap-image", name: "图片", connectionId: "media-connection", kind: adapter === "flow-browser" ? "video" : "image",
    modelId: adapter === "openai-image" ? "gpt-image-2.6-flare" : adapter === "gemini-image" ? "gemini-nano-banana-2.1" : "flow-default",
    formats: adapter === "flow-browser" ? ["mp4"] : adapter === "gemini-image" ? ["jpeg"] : ["png", "gif"],
    supportsEdit: true, enabled: true, isDefault: true, allowTaskGeneration: true, maxOutputs: adapter === "openai-image" ? 4 : 1,
    revision: 1, status: "unverified", createdAt: 1, updatedAt: 1,
  };
  const connection: MediaConnectionView = {
    id: "media-connection", name: "图片连接", adapter,
    ...(adapter === "flow-browser" ? { browserEnvId: "browser-mac", profileRef: "profile-test" }
      : { baseUrl: adapter === "openai-image" ? "https://images.example/v1" : "https://generativelanguage.googleapis.com/v1beta", origin: adapter === "openai-image" ? "https://images.example" : "https://generativelanguage.googleapis.com" }),
    hasCredential: adapter !== "flow-browser", revision: 1,
  };
  const capabilities: MediaCapabilities = {
    async resolve(id, kind, format) {
      if (id && id !== capability.id || kind !== capability.kind || !capability.enabled || format && !capability.formats.includes(format)) throw new Error("capability unavailable");
      return { capability: structuredClone(capability), connection: structuredClone(connection) };
    },
    async connection(id) { if (id !== connection.id) throw new Error("missing connection"); return structuredClone(connection); },
    async apiKey(id) { if (id !== connection.id || connection.origin !== (adapter === "openai-image" ? "https://images.example" : "https://generativelanguage.googleapis.com")) throw new Error("credential origin mismatch"); return "synthetic-provider-key"; },
  };
  return { capability, connection, capabilities };
}
function request(input: Partial<MediaJobRequest> = {}): MediaJobRequest {
  return { operationId: "hero-v1", kind: "image", prompt: "A clean product photo", source: { conversationId: 1, topicId: "root" }, ...input };
}
async function fixture(options: Partial<MediaJobsOptions> & { directory?: string; adapter?: MediaConnectionView["adapter"] } = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "kulo-media-jobs-"));
  if (!options.directory) directories.push(directory);
  const models = createModels();
  const faux = fauxProvider({ provider: "media-test", models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models, registry: createRegistry() }, context);
  await harness.root(context, { agent: { model: { provider: "media-test", modelId: "test" } } });
  const config = configuration(options.adapter);
  const uploads = options.uploads ?? new KuloUploadStore(path.join(directory, "uploads"));
  const fetcher = options.fetcher ?? vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const browser = options.browser ?? vi.fn(async (_env: string, value: BrowserRequest): Promise<BrowserResult> => value.action === "prepare" ? flowPrepared(value) : ({ status: "running", profileRef: value.profileRef, ...("jobId" in value ? { jobId: value.jobId } : {}) }));
  const jobs = new KuloMediaJobs({ harness, uploads, capabilities: options.capabilities ?? config.capabilities, browser, fetcher, pollIntervalMs: 60_000,
    ...(options.onCompleted ? { onCompleted: options.onCompleted } : {}), ...(options.validateInput ? { validateInput: options.validateInput } : {}),
    ...(options.onSettled ? { onSettled: options.onSettled } : {}), ...(options.validateSource ? { validateSource: options.validateSource } : {}),
  });
  resources.push({ jobs, harness });
  return { ...config, directory, harness, uploads, jobs, fetcher, browser };
}
afterEach(async () => {
  for (const value of resources.splice(0).reverse()) { await value.jobs.close(); await value.harness.close(context); }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("durable media jobs", () => {
  it("applies native per-job parameters without rewriting model defaults", async () => {
    const f = await fixture();
    f.capability.formats.push("jpeg");
    f.capability.defaults = { format: "png", size: "auto", quality: "medium", background: "auto" };
    await f.jobs.start();
    const job = await f.jobs.create(request({ parameters: { quality: "high", background: "transparent", complexity: "high", size: "1536x864" } }));
    await f.jobs.drain();
    const [, options] = (f.fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ quality: "high", background: "transparent", complexity: "high", size: "1536x864", n: 1 });
    expect((await f.jobs.get(job.id)).parameters).toMatchObject({ quality: "high", background: "transparent" });
    expect(f.capability.defaults).toEqual({ format: "png", size: "auto", quality: "medium", background: "auto" });
    await expect(f.jobs.create(request({ operationId: "invalid-transparent", parameters: { format: "jpeg", background: "transparent" } }))).rejects.toMatchObject({ code: "invalid_image_parameters" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("merges a one-time custom field override with required saved defaults", async () => {
    const f = await fixture();
    f.capability.modelId = "new-compatible-model";
    f.capability.imageProfile = { formats: ["png"], supportsEdit: false, maxReferences: 0, parameters: [
      { key: "steps", label: "步数", type: "number", required: true, minimum: 1, maximum: 30 }, { key: "seed", label: "种子", type: "number" },
    ] };
    f.capability.defaults = { format: "png", custom: { steps: 18, seed: 1 } };
    await f.jobs.start();
    const job = await f.jobs.create(request({ parameters: { custom: { seed: 7 } } })); await f.jobs.drain();
    const [, options] = (f.fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ steps: 18, seed: 7 });
    expect((await f.jobs.get(job.id)).parameters?.custom).toEqual({ steps: 18, seed: 7 });
    expect(f.capability.defaults.custom).toEqual({ steps: 18, seed: 1 });
  });

  it("sends Gemini PNG, native image size, supported thinking level, and grounding independently", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "interaction-png", status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }] })));
    const f = await fixture({ adapter: "gemini-image", fetcher: fetcher as typeof fetch });
    f.capability.formats = ["jpeg", "png"];
    await f.jobs.start();
    const job = await f.jobs.create(request({ parameters: { format: "png", size: "2K", thinkingLevel: "medium", grounding: true } }));
    await f.jobs.drain();
    const [, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ response_format: { mime_type: "image/png", image_size: "2K" }, generation_config: { thinking_level: "medium" }, tools: [{ type: "google_search" }] });
    expect((await f.jobs.get(job.id)).status).toBe("completed");
  });

  it("runs an explicitly declared custom synchronous interface without exposing credentials", async () => {
    const config = configuration();
    config.connection.adapter = "custom-image";
    config.connection.customAdapter = { auth: { type: "api-key", header: "X-Image-Key" }, generate: { path: "render", body: { model: "{{model}}", prompt: "{{prompt}}", steps: "{{parameters.custom.steps}}", optional: "{{parameters.custom.optional}}" } }, response: { imagesPath: "images", base64Path: "encoded" } };
    config.capability.modelId = "new-model";
    config.capability.imageProfile = { formats: ["png"], supportsEdit: false, maxReferences: 0, parameters: [{ key: "steps", label: "步数", type: "number", minimum: 1, maximum: 40 }] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ images: [{ encoded: png.toString("base64") }] })));
    const f = await fixture({ capabilities: config.capabilities, fetcher: fetcher as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request({ parameters: { custom: { steps: 12 } } }));
    await f.jobs.drain();
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/render");
    expect(options.headers).toMatchObject({ "X-Image-Key": "synthetic-provider-key" });
    expect(JSON.parse(String(options.body))).toEqual({ model: "new-model", prompt: "A clean product photo", steps: 12 });
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(JSON.stringify(await f.harness.snapshot(KuloMediaJobsDoc, context))).not.toContain("synthetic-provider-key");
  });

  it("maps only validated image references into a custom image-url request", async () => {
    const config = configuration();
    const customRequest = { path: "images/generations", body: { model: "{{model}}", prompt: "{{prompt}}", input_references: "{{references}}" } };
    config.connection.adapter = "custom-image";
    config.connection.customAdapter = { auth: { type: "bearer" }, generate: customRequest, edit: customRequest,
      referenceTemplate: { type: "image_url", image_url: { url: "{{reference.dataUrl}}" } }, response: { imagesPath: "images", base64Path: "encoded" } };
    config.capability.modelId = "new-reference-model";
    config.capability.imageProfile = { formats: ["png"], supportsEdit: true, maxReferences: 1 };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ images: [{ encoded: png.toString("base64") }] })));
    const f = await fixture({ capabilities: config.capabilities, fetcher: fetcher as typeof fetch });
    const invalid = f.uploads.saveUpload({ bytes: Buffer.from('{"secret":"synthetic-reference-data"}'), name: "reference.png", mimeType: "image/png", ownerId: "client-reference" });
    f.uploads.bindAttachments([invalid], "conversation:1", "client-reference");
    await expect(f.jobs.create(request({ operationId: "non-image-reference", inputAssetIds: [invalid.id] }))).rejects.toMatchObject({ code: "media_reference_type" });
    expect(fetcher).not.toHaveBeenCalled();
    const reference = f.uploads.saveUpload({ bytes: png, name: "reference.png", mimeType: "image/png", ownerId: "client-reference" });
    f.uploads.bindAttachments([reference], "conversation:1", "client-reference");
    await f.jobs.start();
    const job = await f.jobs.create(request({ inputAssetIds: [reference.id], intent: "edit" })); await f.jobs.drain();
    const [, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "new-reference-model", input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] });
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(String(options.body)).not.toContain("synthetic-reference-data");
  });

  it("persists a custom async task and resumes its original GET query after restart", async () => {
    const config = configuration();
    const adapter: CustomImageAdapter = { auth: { type: "bearer" }, generate: { path: "tasks", body: { prompt: "{{prompt}}" } }, response: { imagesPath: "result.images", urlPath: "url" },
      poll: { path: "tasks/{{jobId}}", idPath: "id", statusPath: "status", completeValues: ["completed"], failedValues: ["failed"], intervalMs: 60_000 }, outputOrigins: ["https://cdn.example"] };
    config.connection.adapter = "custom-image"; config.connection.customAdapter = adapter;
    config.capability.modelId = "new-async-model"; config.capability.supportsEdit = false;
    config.capability.imageProfile = { formats: ["png"], supportsEdit: false, maxReferences: 0 };
    const initialFetch = vi.fn(async () => new Response(JSON.stringify({ id: "task-1", status: "pending" }), { status: 202 }));
    const f = await fixture({ capabilities: config.capabilities, fetcher: initialFetch as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request());
    await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "running", remoteId: "task-1" });
    await f.jobs.close(); await f.harness.close(context);
    const requests: Array<[string, RequestInit | undefined]> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      requests.push([String(url), options]);
      return String(url).startsWith("https://cdn.example") ? new Response(png) : new Response(JSON.stringify({ id: "task-1", status: "completed", result: { images: [{ url: "https://cdn.example/result.png" }] } }));
    });
    const reopened = await fixture({ directory: f.directory, capabilities: config.capabilities, fetcher: fetcher as typeof fetch });
    await reopened.jobs.start(); await reopened.jobs.drain();
    expect(await reopened.jobs.get(job.id)).toMatchObject({ status: "completed", remoteId: "task-1" });
    expect(initialFetch).toHaveBeenCalledTimes(1);
    expect(requests[0]?.[0]).toBe("https://images.example/v1/tasks/task-1");
    expect(requests[0]?.[1]?.method).toBe("GET");
    expect(new Headers(requests[1]?.[1]?.headers).has("Authorization")).toBe(false);
    expect(requests.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("allows an explicit settings test without granting future task generation", async () => {
    const config = configuration(); config.capability.allowTaskGeneration = false;
    const validateSource = vi.fn(async (source) => { if (source.setupClientId !== "setup-window") throw new MediaJobError(403, "media_setup_scope_invalid", "设置窗口无效。"); });
    const f = await fixture({ capabilities: config.capabilities, validateSource });
    await f.jobs.start();
    const job = await f.jobs.create(request({ source: { conversationId: 1, topicId: "root", setupClientId: "setup-window" } }));
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(config.capability.allowTaskGeneration).toBe(false);
    expect(validateSource).toHaveBeenCalledTimes(2);
  });

  it("keeps an accepted response-stream interruption uncertain and never resubmits it", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic response interruption")); } })));
    const f = await fixture({ fetcher: fetcher as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request()); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_reconciliation");
    await expect(f.jobs.resume(job.id)).rejects.toMatchObject({ code: "media_submission_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("creates once across concurrent calls, persists real assets and rejects a changed request under the same intent", async () => {
    const f = await fixture();
    await f.jobs.start();
    const [first, duplicate] = await Promise.all([f.jobs.create(request()), f.jobs.create(request())]);
    expect(first.id).toBe(duplicate.id);
    await f.jobs.drain();
    const done = await f.jobs.get(first.id);
    expect(done.status).toBe("completed");
    expect(done.assets).toHaveLength(1);
    const stored = f.uploads.getUpload(done.assets[0]!.id)!;
    expect(f.uploads.readUploadBytes(stored)).toEqual(png);
    expect(stored.record.referenceScopes).toContain("conversation:1");
    expect(fs.existsSync(path.join(f.uploads.dir, ".media-jobs", done.id))).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await expect(f.jobs.create(request({ prompt: "a changed photo" }))).rejects.toMatchObject({ code: "media_operation_conflict" });
    expect(JSON.stringify(await f.harness.snapshot(KuloMediaJobsDoc, context))).not.toContain("synthetic-provider-key");
    expect(JSON.stringify(done)).not.toContain("fingerprint");
    expect(done).not.toHaveProperty("connection");
  });

  it("reuses the same persisted intent after restart without a second API request", async () => {
    const f = await fixture();
    await f.jobs.start();
    const first = await f.jobs.create(request());
    await f.jobs.drain();
    await f.jobs.close(); await f.harness.close(context);
    const reopened = await fixture({ directory: f.directory });
    await reopened.jobs.start();
    expect((await reopened.jobs.create(request())).id).toBe(first.id);
    await reopened.jobs.drain();
    expect(reopened.fetcher).not.toHaveBeenCalled();
  });

  it("uses the current Gemini Interactions REST contract and reads model output steps", async () => {
    // Primary REST schema: https://aistudio.google.com/api-reference/interactions-api
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "interaction-image-1", object: "interaction", status: "completed", steps: [
      { type: "thought", content: [{ type: "image", mime_type: "image/png", data: "ignored" }] },
      { type: "model_output", content: [{ type: "text", text: "ready" }, { type: "image", mime_type: "image/jpeg", data: jpeg.toString("base64") }] },
    ] }), { status: 200 }));
    const f = await fixture({ adapter: "gemini-image", fetcher: fetcher as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request({ aspectRatio: "16:9", quality: "2K" }));
    await f.jobs.drain();
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(options.headers).toMatchObject({ "x-goog-api-key": "synthetic-provider-key", "Api-Revision": "2026-05-20" });
    expect(options.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(options.body))).toEqual({
      model: "gemini-nano-banana-2.1", input: [{ type: "text", text: "A clean product photo" }], background: false,
      response_format: { type: "image", mime_type: "image/jpeg", delivery: "inline", aspect_ratio: "16:9", image_size: "2K" },
    });
    const done = await f.jobs.get(job.id);
    expect(done.status).toBe("completed");
    expect(f.uploads.readUploadBytes(f.uploads.getUpload(done.assets[0]!.id)!)).toEqual(jpeg);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends authorized Gemini image references as native Interactions input blocks", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "interaction-edit-1", status: "completed", steps: [
      { type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: jpeg.toString("base64") }] },
    ] }), { status: 200 }));
    const f = await fixture({ adapter: "gemini-image", fetcher: fetcher as typeof fetch });
    const ref = f.uploads.saveUpload({ bytes: png, name: "reference.png", mimeType: "image/png", ownerId: "client-1" });
    f.uploads.bindAttachments([ref], "conversation:1", "client-1");
    await f.jobs.start();
    const job = await f.jobs.create(request({ inputAssetIds: [ref.id] }));
    await f.jobs.drain();
    const [, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(options.body)).input).toEqual([
      { type: "text", text: "A clean product photo" },
      { type: "image", mime_type: "image/png", data: png.toString("base64") },
    ]);
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["legacy generateContent response", { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] }],
    ["SDK convenience property without REST steps", { id: "interaction-1", status: "completed", output_image: { mime_type: "image/png", data: png.toString("base64") } }],
    ["incomplete interaction", { id: "interaction-1", status: "in_progress", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: jpeg.toString("base64") }] }] }],
    ["unrequested output MIME", { id: "interaction-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }] }],
    ["URI instead of requested inline data", { id: "interaction-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", uri: "https://foreign.example/image.jpeg" }] }] }],
  ])("does not retry a different paid protocol after a Gemini %s", async (_name, response) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const f = await fixture({ adapter: "gemini-image", fetcher: fetcher as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request());
    await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "needs_reconciliation", assets: [] });
    await expect(f.jobs.resume(job.id)).rejects.toMatchObject({ code: "media_submission_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["gpt-image-2.5-sunburst", "xhigh"], ["gpt-image-2.6-flare-2026-11-01", "max"],
  ])("allows expanded quality on %s", async (modelId, quality) => {
    const f = await fixture();
    f.capability.modelId = modelId;
    await f.jobs.start();
    const job = await f.jobs.create(request({ quality, aspectRatio: "16:9" }));
    await f.jobs.drain();
    const [, options] = (f.fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ model: modelId, quality, size: "1536x864" });
    expect((await f.jobs.get(job.id)).status).toBe("completed");
  });

  it.each(["gpt-image-1", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.6"])("rejects expanded quality on %s before submitting", async (modelId) => {
    const f = await fixture();
    f.capability.modelId = modelId;
    await expect(f.jobs.create(request({ quality: "max" }))).rejects.toMatchObject({ code: "invalid_quality" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("sends scoped reference images as multipart edits and rejects foreign references", async () => {
    const f = await fixture();
    const ref = f.uploads.saveUpload({ bytes: png, name: "reference.png", mimeType: "image/png", ownerId: "user-owner" });
    f.uploads.bindAttachments([ref], "conversation:1", "user-owner");
    const foreign = f.uploads.saveUpload({ bytes: png, name: "private.png", mimeType: "image/png", ownerId: "other-owner" });
    await expect(f.jobs.create(request({ inputAssetIds: [foreign.id] }))).rejects.toMatchObject({ code: "media_reference_forbidden" });
    await f.jobs.start();
    const job = await f.jobs.create(request({ inputAssetIds: [ref.id] }));
    await f.jobs.drain();
    const [url, options] = (f.fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/images/edits");
    expect(options.body).toBeInstanceOf(FormData);
    expect((options.body as FormData).getAll("image[]")).toHaveLength(1);
    expect((await f.jobs.get(job.id)).status).toBe("completed");
  });

  it("uses authoritative server scope validation for origin and parent Agent references", async () => {
    let originId = "";
    let parentId = "";
    const validateInput = vi.fn(async (assetId: string, source) => {
      if (source.ticketId !== "ticket-owned" || ![originId, parentId].includes(assetId)) throw new MediaJobError(403, "media_reference_forbidden", "资源不属于当前工单。");
    });
    const f = await fixture({ validateInput });
    const origin = f.uploads.saveUpload({ bytes: png, name: "origin.png", mimeType: "image/png", ownerId: "client-original" });
    f.uploads.bindAttachments([origin], "conversation:9", "client-original");
    originId = origin.id;
    const parent = f.uploads.saveUpload({ bytes: png, name: "parent.png", mimeType: "image/png", ownerId: "agent:11" });
    f.uploads.bindAttachments([parent], "conversation:11", "agent:11");
    parentId = parent.id;
    const foreign = f.uploads.saveUpload({ bytes: png, name: "foreign.png", mimeType: "image/png", ownerId: "another-client" });
    f.uploads.bindAttachments([foreign], "conversation:99", "another-client");
    const source = { conversationId: 12, topicId: "topic-owned", ticketId: "ticket-owned" };
    await expect(f.jobs.create(request({ source, inputAssetIds: [foreign.id] }))).rejects.toMatchObject({ code: "media_reference_forbidden" });
    await f.jobs.start();
    const job = await f.jobs.create(request({ source, inputAssetIds: [origin.id, parent.id] }));
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(validateInput).toHaveBeenCalledWith(origin.id, expect.objectContaining({ conversationId: 12 }));
    expect(validateInput).toHaveBeenCalledWith(parent.id, expect.objectContaining({ conversationId: 12 }));
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks unapproved main and Worker generation, and allows the same intent after authorization", async () => {
    const f = await fixture();
    f.capability.allowTaskGeneration = false;
    await expect(f.jobs.create(request())).rejects.toMatchObject({ status: 403, code: "media_task_generation_not_allowed", message: "尚未允许此能力按需生成，请通过右侧对话授权后继续。" });
    await expect(f.jobs.create(request({ source: { conversationId: 3, topicId: "root", ticketId: "task-1" } }))).rejects.toMatchObject({ code: "media_task_generation_not_allowed" });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.capability.allowTaskGeneration = true;
    await f.jobs.start();
    const job = await f.jobs.create(request());
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks unsupported formats before any request", async () => {
    const f = await fixture();
    await expect(f.jobs.create(request({ format: "mp4" }))).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    const gemini = await fixture({ adapter: "gemini-image" });
    await expect(gemini.jobs.create(request({ format: "gif" }))).rejects.toThrow();
    expect(gemini.fetcher).not.toHaveBeenCalled();
  });

  it.each([{ aspectRatio: "16:9" }, { quality: "high" }])("rejects unsupported video parameters before preparing or spending (%j)", async (parameters) => {
    const f = await fixture({ adapter: "flow-browser" });
    await f.jobs.start();
    await expect(f.jobs.create(request({ kind: "video", ...parameters }))).rejects.toMatchObject({
      status: 400, code: "media_video_parameters_unsupported", message: "当前 Flow 视频生成仅支持网页默认画幅和质量，尚未提交。",
    });
    await f.jobs.drain();
    expect(await f.jobs.list()).toEqual([]);
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rechecks the shared generation permission before spending a queued main request", async () => {
    const f = await fixture();
    const job = await f.jobs.create(request());
    f.capability.allowTaskGeneration = false;
    await f.jobs.start(); await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "needs_user", error: "尚未允许此能力按需生成，请通过右侧对话授权后继续。" });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.capability.allowTaskGeneration = true;
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not report a PNG result as a successful requested GIF", async () => {
    const f = await fixture();
    await f.jobs.start(); const job = await f.jobs.create(request({ format: "gif" })); await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "needs_user", assets: [], error: "生成结果文件类型与请求不一致。" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not resend an ambiguous API submission after failure or process restart", async () => {
    const fetcher = vi.fn(async () => { throw new Error("connection reset with no response"); });
    const f = await fixture({ fetcher: fetcher as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request());
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_reconciliation");
    await expect(f.jobs.resume(job.id)).rejects.toMatchObject({ code: "media_submission_unknown" });
    await f.jobs.close(); await f.harness.close(context);
    const reopened = await fixture({ directory: f.directory });
    await reopened.jobs.start();
    expect((await reopened.jobs.create(request())).status).toBe("needs_reconciliation");
    expect(reopened.fetcher).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fences a recorded submitting phase on startup instead of replaying the HTTP side effect", async () => {
    const f = await fixture();
    const job = await f.jobs.create(request());
    await f.harness.commit(async (tx) => { const state = await tx.doc(KuloMediaJobsDoc); state.jobs[job.id]!.status = "submitting"; state.jobs[job.id]!.submitted = true; }, context);
    await f.jobs.start();
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_reconciliation");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("retries a saved result download without repeating the paid request or forwarding authorization", async () => {
    let downloads = 0;
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === "POST") return new Response(JSON.stringify({ data: [{ url: "https://images.example/results/one.png" }] }), { status: 200 });
      downloads++;
      expect(options?.headers).toBeUndefined();
      return downloads === 1 ? new Response("busy", { status: 503 }) : new Response(png, { status: 200 });
    });
    const f = await fixture({ fetcher: fetcher as typeof fetch });
    await f.jobs.start();
    const job = await f.jobs.create(request());
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_user");
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("completed");
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(downloads).toBe(2);
  });

  it("rejects cross-origin result URLs and secret-bearing error bodies", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ url: "https://unapproved.example/private" }] }), { status: 200 }));
    const f = await fixture({ fetcher: fetcher as typeof fetch });
    await f.jobs.start(); const job = await f.jobs.create(request()); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_reconciliation");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const g = await fixture({ fetcher: vi.fn(async () => new Response("synthetic-provider-key", { status: 401 })) as typeof fetch });
    await g.jobs.start(); const bad = await g.jobs.create(request()); await g.jobs.drain();
    expect(JSON.stringify(await g.jobs.get(bad.id))).not.toContain("synthetic-provider-key");
  });

  it("uploads Flow references to the browser Env and imports the MP4 without any API fallback", async () => {
    let polls = 0;
    const calls: Array<{ env: string; request: BrowserRequest }> = [];
    const browser = vi.fn(async (env: string, req: BrowserRequest): Promise<BrowserResult> => {
      calls.push({ env, request: req });
      const base = { profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
      if (req.action === "upload") return { ...base, status: "ready" };
      if (req.action === "prepare") return flowPrepared(req);
      if (req.action === "submit") return { ...base, status: "running", remoteId: "flow-remote-1" };
      if (req.action === "poll") { polls++; return { ...base, status: "completed", remoteId: "flow-remote-1" }; }
      if (req.action === "download") return { ...base, status: "completed", file: { name: "scene.mp4", mimeType: "video/mp4", size: mp4.length } };
      if (req.action === "read") return { ...base, status: "completed", offset: req.offset, data: mp4.subarray(req.offset, req.offset + req.length).toString("base64") };
      throw new Error("unexpected browser request");
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    const ref = f.uploads.saveUpload({ bytes: png, name: "scene.png", mimeType: "image/png", ownerId: "agent:1" });
    await f.jobs.start();
    const job = await f.jobs.create(request({ kind: "video", inputAssetIds: [ref.id], durationSeconds: 8 }));
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    f.capability.allowTaskGeneration = false;
    await f.jobs.resume(job.id); await f.jobs.drain();
    const done = await f.jobs.get(job.id);
    expect(done.status).toBe("completed");
    expect(done.assets[0]?.kind).toBe("video");
    expect(calls.every((call) => call.env === "browser-mac")).toBe(true);
    expect(calls.find((call) => call.request.action === "prepare")?.request).toMatchObject({ referenceIds: [ref.id], durationSeconds: 8 });
    expect(calls.map((call) => call.request.action)).toEqual(["upload", "prepare", "submit", "poll", "download", "read"]);
    expect(calls.find((call) => call.request.action === "submit")?.request).toMatchObject({ referenceIds: [ref.id] });
    expect(calls.find((call) => call.request.action === "upload")?.request).toMatchObject({ data: png.toString("base64"), offset: 0, final: true });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(polls).toBe(1);
  });

  it("reconciles a Flow submission through poll without clicking generate again", async () => {
    let submitted = 0;
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") return flowPrepared(req);
      if (req.action === "submit") { submitted++; throw new Error("lost submit response"); }
      return { status: "running", profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_reconciliation");
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    expect(submitted).toBe(1);
  });

  it.each(["permission", "capability"])("does not approve a prepared Flow card after %s is revoked while preparation waits", async (change) => {
    let release!: () => void;
    let entered!: () => void;
    let preparations = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") {
        if (++preparations === 1) { entered(); await blocked; }
        return flowPrepared(req);
      }
      return { status: "running", submitted: true, profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await started;
    if (change === "permission") f.capability.allowTaskGeneration = false;
    else f.capability.enabled = false;
    release(); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_user");
    expect((await f.harness.snapshot(KuloMediaJobsDoc, context))?.jobs[job.id]?.submitted).not.toBe(true);
    expect(browser.mock.calls.filter((call) => call[1].action === "submit")).toHaveLength(0);
    f.capability.enabled = true; f.capability.allowTaskGeneration = true;
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect(browser.mock.calls.filter((call) => call[1].action === "prepare")).toHaveLength(2);
    expect(browser.mock.calls.filter((call) => call[1].action === "submit")).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("never approves a Flow card when the job is stopped during non-paid preparation", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") { entered(); await blocked; return flowPrepared(req); }
      if (req.action === "stop") return { status: "stopped", submitted: false, profileRef: req.profileRef, jobId: req.jobId };
      throw new Error("stopped job must not approve or track a remote generation");
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await started;
    await f.jobs.stop(job.id);
    release(); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("stopped");
    expect((await f.harness.snapshot(KuloMediaJobsDoc, context))?.jobs[job.id]?.submitted).not.toBe(true);
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare", "stop"]);
    await expect(f.jobs.resume(job.id)).rejects.toMatchObject({ code: "media_job_terminal" });
  });

  it("revalidates the source after Flow preparation before approving the card", async () => {
    let revoked = false;
    const validateSource = vi.fn(async () => {
      if (revoked) throw new MediaJobError(409, "media_source_revoked", "原工单已停止。");
    });
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") { revoked = true; return flowPrepared(req); }
      throw new Error("revoked source must not approve");
    });
    const f = await fixture({ adapter: "flow-browser", browser, validateSource });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("stopped");
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare"]);
    expect((await f.harness.snapshot(KuloMediaJobsDoc, context))?.jobs[job.id]?.submitted).not.toBe(true);
  });

  it.each([
    ["login required", { status: "needs_login" }],
    ["review required", { status: "needs_review" }],
    ["missing prepared flag", { prepared: undefined }],
    ["missing native quote", { quote: undefined }],
    ["multiple outputs", { quote: { credits: 5, outputs: 2, durationSeconds: 8 } }],
    ["negative credits", { quote: { credits: -5, outputs: 1, durationSeconds: 8 } }],
    ["non-finite credits", { quote: { credits: Number.NaN, outputs: 1, durationSeconds: 8 } }],
    ["missing requested duration", { quote: { credits: 5, outputs: 1 } }],
    ["different duration", { quote: { credits: 5, outputs: 1, durationSeconds: 4 } }],
    ["foreign profile", { profileRef: "foreign-profile" }],
    ["foreign job", { jobId: "foreign-job" }],
  ] satisfies Array<[string, Partial<BrowserResult>]>)("keeps a Flow %s preparation unsubmitted and recoverable", async (_name, override) => {
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") return { ...flowPrepared(req), ...override };
      throw new Error("invalid preparation must not approve");
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video", durationSeconds: 8 })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_user");
    expect((await f.harness.snapshot(KuloMediaJobsDoc, context))?.jobs[job.id]?.submitted).not.toBe(true);
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare"]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "Veo 3.1 Fast"])("does not approve an explicit Flow model without a matching native label (%s)", async (modelId) => {
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") return { ...flowPrepared(req), quote: { credits: 5, outputs: 1, ...(modelId ? { modelId } : {}) } };
      throw new Error("unverified model must not approve");
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    f.capability.modelId = "veo-3.1-lite";
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "needs_user", error: "Flow 原生确认卡无法核对请求的模型，未批准生成。" });
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare"]);
  });

  it("normalizes native model labels before approving the same Flow card", async () => {
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") return { ...flowPrepared(req), quote: { credits: 5, outputs: 1, modelId: "Veo 3.1 Lite" } };
      return { status: "running", submitted: true, profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    f.capability.modelId = "veo-3.1-lite";
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare", "submit"]);
  });

  it("retries failed preparation using the original job and never repeats an accepted approval", async () => {
    let preparations = 0;
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") {
        if (++preparations === 1) throw new Error("browser temporarily disconnected");
        return flowPrepared(req);
      }
      return { status: "running", submitted: true, profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_user");
    expect((await f.harness.snapshot(KuloMediaJobsDoc, context))?.jobs[job.id]?.submitted).not.toBe(true);
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare", "prepare", "submit", "poll"]);
    expect(browser.mock.calls.every((call) => "jobId" in call[1] && call[1].jobId === job.id)).toBe(true);
  });

  it("only reconciles if preparation unexpectedly reports an already submitted Flow job", async () => {
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") return { ...flowPrepared(req), status: "running", submitted: true };
      return { status: "running", submitted: true, profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_reconciliation");
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect(browser.mock.calls.map((call) => call[1].action)).toEqual(["prepare", "poll"]);
  });

  it("pauses an accepted Flow job while its connection is removed, then only polls and collects after the same binding is restored", async () => {
    const calls: BrowserRequest[] = [];
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      calls.push(req);
      const base = { profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
      if (req.action === "prepare") return flowPrepared(req);
      if (req.action === "submit") return { ...base, status: "running", submitted: true, remoteId: "original-flow-result" };
      if (req.action === "poll") return { ...base, status: "completed", submitted: true, remoteId: "original-flow-result" };
      if (req.action === "download") return { ...base, status: "completed", file: { name: "original.mp4", mimeType: "video/mp4", size: mp4.length } };
      if (req.action === "read") return { ...base, status: "completed", offset: req.offset, data: mp4.subarray(req.offset, req.offset + req.length).toString("base64") };
      throw new Error("unexpected browser request");
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    const originalConnection = f.capabilities.connection;
    f.capabilities.connection = async () => { throw new CapabilityError(404, "connection_not_found", "连接已移除。"); };
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "needs_user", remoteId: "original-flow-result" });
    const recovery = await f.jobs.recoveryConnection(job.id);
    expect(recovery).toEqual(f.connection);
    expect(recovery).not.toHaveProperty("apiKey");
    recovery.profileRef = "different-profile";
    expect((await f.jobs.recoveryConnection(job.id)).profileRef).toBe("profile-test");
    expect(calls.filter((call) => call.action === "submit")).toHaveLength(1);
    f.capabilities.connection = originalConnection;
    f.capability.allowTaskGeneration = false;
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "completed", remoteId: "original-flow-result", assets: [expect.objectContaining({ kind: "video" })] });
    expect(calls.filter((call) => call.action === "submit")).toHaveLength(1);
    expect(calls.filter((call) => call.action === "poll")).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rebuilds the exact Flow connection through the real capability registry before resuming an accepted job", async () => {
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      const base = { profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
      if (req.action === "check" || req.action === "open") return { ...base, status: "ready" };
      if (req.action === "prepare") return flowPrepared(req);
      if (req.action === "submit") return { ...base, status: "running", submitted: true, remoteId: "original-flow-result" };
      if (req.action === "poll") return { ...base, status: "completed", submitted: true, remoteId: "original-flow-result" };
      if (req.action === "download") return { ...base, status: "completed", file: { name: "original.mp4", mimeType: "video/mp4", size: mp4.length } };
      if (req.action === "read") return { ...base, status: "completed", offset: req.offset, data: mp4.subarray(req.offset, req.offset + req.length).toString("base64") };
      throw new Error("unexpected browser request");
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    const registry = new KuloCapabilities({
      harness: f.harness, credentials: new FileCredentialStore(path.join(f.directory, "credentials.json")), browser,
      envs: () => [{ id: "browser-mac", name: "Mac", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/test-browser", capabilities: ["flow-browser"], connectedAt: 1, lastSeenAt: 1 }],
    });
    const cap = await registry.configure({ commandId: "flow-create", name: "会员视频", adapter: "flow-browser", modelId: "Flow 网页默认", browserEnvId: "browser-mac", allowTaskGeneration: true });
    const jobs = new KuloMediaJobs({ harness: f.harness, uploads: f.uploads, capabilities: registry, browser, pollIntervalMs: 60_000 });
    resources.push({ harness: f.harness, jobs });
    await jobs.start();
    const job = await jobs.create(request({ kind: "video", capabilityId: cap.id }));
    await jobs.drain();
    await registry.remove(cap.id, cap.revision, "flow-remove");
    await jobs.resume(job.id); await jobs.drain();
    expect((await jobs.get(job.id)).status).toBe("needs_user");
    const candidate = await jobs.recoveryConnection(job.id);
    const restored = await registry.configure({ commandId: "flow-restore", name: "恢复会员视频", adapter: candidate.adapter, modelId: cap.modelId, browserEnvId: candidate.browserEnvId, profileRef: candidate.profileRef, allowTaskGeneration: false });
    expect(restored.id).not.toBe(cap.id);
    expect(restored.connectionId).toBe(cap.connectionId);
    await jobs.resume(job.id); await jobs.drain();
    expect((await jobs.get(job.id)).status).toBe("completed");
    expect(browser.mock.calls.filter((call) => call[1].action === "submit")).toHaveLength(1);
  });

  it("does not deliver a late completion after stop", async () => {
    let finish!: (response: Response) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = vi.fn(async () => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    const onCompleted = vi.fn(async () => {});
    const f = await fixture({ fetcher: fetcher as typeof fetch, onCompleted });
    await f.jobs.start(); const job = await f.jobs.create(request()); await began;
    await f.jobs.stop(job.id);
    finish(new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 }));
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("stopped");
    expect(onCompleted).not.toHaveBeenCalled();
    await expect(f.jobs.resume(job.id)).rejects.toMatchObject({ code: "media_job_terminal" });
  });

  it("rechecks revoked source authorization before a queued job can spend", async () => {
    let revoked = false;
    const validateSource = vi.fn(async (_source, job) => {
      if (revoked && job) throw new MediaJobError(409, "media_source_revoked", "原工单已停止。");
    });
    const onSettled = vi.fn(async () => {});
    const f = await fixture({ validateSource, onSettled });
    const job = await f.jobs.create(request());
    revoked = true;
    await f.jobs.start(); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("stopped");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(validateSource).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 1 }), expect.objectContaining({ id: job.id }));
  });

  it("retries a persisted settled notification after restart without repeating generation", async () => {
    const onSettled = vi.fn(async () => { throw new Error("relay interrupted"); });
    const f = await fixture({ fetcher: vi.fn(async () => { throw new Error("lost response"); }) as typeof fetch, onSettled });
    await f.jobs.start(); const job = await f.jobs.create(request()); await f.jobs.drain();
    expect(onSettled).toHaveBeenCalledTimes(1);
    await f.jobs.close(); await f.harness.close(context);
    const delivered = vi.fn(async () => {});
    const g = await fixture({ directory: f.directory, onSettled: delivered });
    await g.jobs.start(); await g.jobs.drain();
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, status: "needs_reconciliation" }));
    expect(g.fetcher).not.toHaveBeenCalled();
    await g.jobs.close(); await g.harness.close(context);
    const later = vi.fn(async () => {});
    const h = await fixture({ directory: f.directory, onSettled: later });
    await h.jobs.start(); await h.jobs.drain();
    expect(later).not.toHaveBeenCalled();
  });

  it("allows same-intent Flow retry only when the Env confirms nothing was submitted", async () => {
    let submissions = 0;
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      if (req.action === "prepare") return flowPrepared(req);
      if (req.action === "submit") {
        submissions++;
        return { status: submissions === 1 ? "needs_review" : "running", submitted: submissions !== 1, profileRef: req.profileRef, jobId: req.jobId } as BrowserResult;
      }
      return { status: "running", profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
    });
    const f = await fixture({ adapter: "flow-browser", browser });
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video" })); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_user");
    await f.jobs.resume(job.id); await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("running");
    expect(submissions).toBe(2);
    expect(new Set(browser.mock.calls.filter((call) => call[1].action === "submit").map((call) => (call[1] as Extract<BrowserRequest, {action:"submit"}>).jobId))).toEqual(new Set([job.id]));
  });

  it("rebinds only a resumed Worker's live epoch while preserving the original intent, conversation and references", async () => {
    let liveEpoch = 1;
    let submissions = 0;
    let paidSubmissions = 0;
    const validateSource = vi.fn(async (source) => {
      if (source.ticketId !== "owned-ticket" || source.runEpoch !== liveEpoch) throw new MediaJobError(409, "media_source_revoked", "当前执行资格已失效。");
    });
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      const base = { profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
      if (req.action === "prepare") return flowPrepared(req);
      if (req.action === "submit") {
        submissions++;
        if (submissions === 1) return { ...base, status: "needs_review", submitted: false };
        paidSubmissions++;
        return { ...base, status: "running", submitted: true, remoteId: req.jobId };
      }
      return { ...base, status: req.action === "upload" ? "ready" : "running" };
    });
    const f = await fixture({ adapter: "flow-browser", browser, validateSource });
    const ref = f.uploads.saveUpload({ bytes: png, name: "original-worker.png", mimeType: "image/png", ownerId: "agent:7" });
    const originalSource = { conversationId: 7, topicId: "owned-topic", ticketId: "owned-ticket", projectId: "owned-project", envId: "project-device", runEpoch: 1 };
    await f.jobs.start();
    const job = await f.jobs.create(request({ kind: "video", source: originalSource, inputAssetIds: [ref.id] }));
    await f.jobs.drain();
    expect((await f.jobs.get(job.id)).status).toBe("needs_user");
    liveEpoch = 3;
    const currentSource = { ...originalSource, conversationId: 99, runEpoch: liveEpoch };
    await f.jobs.resume(job.id, currentSource); await f.jobs.drain();
    const resumed = await f.jobs.get(job.id);
    expect(resumed).toMatchObject({ id: job.id, operationId: "hero-v1", status: "running", source: { ...originalSource, runEpoch: 3 }, inputAssetIds: [ref.id] });
    expect(validateSource).toHaveBeenCalledWith(currentSource);
    expect((await f.harness.snapshot(KuloMediaJobsDoc, context))?.jobs[job.id]?.originalRunEpoch).toBe(1);
    expect((await f.jobs.create(request({ kind: "video", source: currentSource, inputAssetIds: [ref.id] }))).id).toBe(job.id);
    await f.jobs.resume(job.id, currentSource); await f.jobs.drain();
    expect(submissions).toBe(2);
    expect(paidSubmissions).toBe(1);
  });

  it("rejects foreign or stopped Worker resume scopes and never lets a main-brain scope rebind an unsubmitted Worker job", async () => {
    let stopped = false;
    const validateSource = vi.fn(async (source) => {
      if (stopped && source.ticketId) throw new MediaJobError(409, "media_source_revoked", "原工单已停止。");
    });
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => ({
      status: "needs_review", submitted: false, profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}),
    }));
    const f = await fixture({ adapter: "flow-browser", browser, validateSource });
    const source = { conversationId: 7, topicId: "owned-topic", ticketId: "owned-ticket", envId: "project-device", runEpoch: 1 };
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video", source })); await f.jobs.drain();
    const current = { ...source, conversationId: 9, runEpoch: 3 };
    await expect(f.jobs.resume(job.id, { ...current, ticketId: "foreign-ticket" })).rejects.toMatchObject({ code: "media_job_forbidden" });
    await expect(f.jobs.resume(job.id, { ...current, topicId: "foreign-topic" })).rejects.toMatchObject({ code: "media_job_forbidden" });
    await expect(f.jobs.resume(job.id, { ...current, envId: "foreign-device" })).rejects.toMatchObject({ code: "media_resume_scope_mismatch" });
    await expect(f.jobs.resume(job.id, { conversationId: 1, topicId: source.topicId })).rejects.toMatchObject({ code: "media_worker_resume_required" });
    stopped = true;
    await expect(f.jobs.resume(job.id, current)).rejects.toMatchObject({ code: "media_source_revoked" });
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "needs_user", source });
    expect(browser.mock.calls.filter((call) => call[1].action === "submit")).toHaveLength(0);
    await f.jobs.stop(job.id);
    stopped = false;
    await expect(f.jobs.resume(job.id, current)).rejects.toMatchObject({ code: "media_job_terminal" });
  });

  it("does not move a job's live scope backwards when another resume already advanced it", async () => {
    const validateSource = vi.fn(async () => {});
    const f = await fixture({ adapter: "flow-browser", validateSource });
    const source = { conversationId: 7, topicId: "owned-topic", ticketId: "owned-ticket", envId: "project-device", runEpoch: 1 };
    const job = await f.jobs.create(request({ kind: "video", source }));
    await f.jobs.resume(job.id, { ...source, runEpoch: 4 });
    await expect(f.jobs.resume(job.id, { ...source, runEpoch: 3 })).rejects.toMatchObject({ code: "media_resume_scope_changed" });
    expect((await f.jobs.get(job.id)).source.runEpoch).toBe(4);
    expect(f.browser).not.toHaveBeenCalled();
  });

  it("uses the rebound epoch when a Worker explicitly resumes during unpaid reference preparation", async () => {
    let liveEpoch = 1;
    let releaseUpload!: () => void;
    let enteredUpload!: () => void;
    const uploading = new Promise<void>((resolve) => { enteredUpload = resolve; });
    const blockedUpload = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const validateSource = vi.fn(async (source) => {
      if (source.runEpoch !== liveEpoch) throw new MediaJobError(409, "media_source_revoked", "当前执行资格已失效。");
    });
    const browser = vi.fn(async (_env: string, req: BrowserRequest): Promise<BrowserResult> => {
      const base = { profileRef: req.profileRef, ...("jobId" in req ? { jobId: req.jobId } : {}) };
      if (req.action === "upload") { enteredUpload(); await blockedUpload; return { ...base, status: "ready" }; }
      if (req.action === "prepare") return flowPrepared(req);
      return { ...base, status: "running", submitted: true };
    });
    const f = await fixture({ adapter: "flow-browser", browser, validateSource });
    const ref = f.uploads.saveUpload({ bytes: png, name: "original-worker.png", mimeType: "image/png", ownerId: "agent:7" });
    const source = { conversationId: 7, topicId: "owned-topic", ticketId: "owned-ticket", envId: "project-device", runEpoch: 1 };
    await f.jobs.start(); const job = await f.jobs.create(request({ kind: "video", source, inputAssetIds: [ref.id] })); await uploading;
    liveEpoch = 3;
    await f.jobs.resume(job.id, { ...source, conversationId: 99, runEpoch: 3 });
    releaseUpload(); await f.jobs.drain();
    expect(await f.jobs.get(job.id)).toMatchObject({ status: "running", source: { ...source, runEpoch: 3 } });
    expect(browser.mock.calls.filter((call) => call[1].action === "submit")).toHaveLength(1);
  });
});
