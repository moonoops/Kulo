import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { BrowserRequest, BrowserResult, CapabilityConfigurationInput, EnvNodeDescriptor } from "@moco/protocol";
import { MocoCapabilities, MocoCapabilitiesDoc, type MocoCapabilitiesOptions } from "../packages/hub/src/capabilities.js";
import { FileCredentialStore, MocoProviderManager } from "../packages/hub/src/providers.js";
import type { MocoModelConfig } from "../packages/hub/src/config.js";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const harnesses: Harness[] = [];
const dummyKey = "synthetic-media-test-key";
const imageInput = (commandId: string, extra: Partial<CapabilityConfigurationInput> = {}): CapabilityConfigurationInput => ({ commandId, name: "图片生成", adapter: "openai-image", modelId: "gpt-image-2.6-flare", ...extra });
function device(): EnvNodeDescriptor {
  return { id: "browser-mac", name: "Mac", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/test-browser", capabilities: ["flow-browser"], connectedAt: 1, lastSeenAt: 1 };
}

async function fixture(options: { directory?: string; now?: () => number; browser?: (envId: string, request: BrowserRequest) => Promise<BrowserResult>; fetch?: typeof fetch; resolveProviderApiKey?: MocoCapabilitiesOptions["resolveProviderApiKey"] } = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-capabilities-"));
  if (!options.directory) directories.push(directory);
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "capability-test", models: [{ id: "test" }] }).provider);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models, registry: createRegistry() }, context);
  harnesses.push(harness);
  await harness.root(context, { agent: { model: { provider: "capability-test", modelId: "test" } } });
  const credentials = new FileCredentialStore(path.join(directory, "credentials.json"));
  const envs = [device()];
  const browser = options.browser ?? vi.fn(async (_env: string, request: BrowserRequest): Promise<BrowserResult> => ({ status: "ready", profileRef: request.profileRef }));
  const http = options.fetch ?? vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({ id: decodeURIComponent(String(url).split("/").at(-1)!) }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  const capabilities = new MocoCapabilities({ harness, credentials, envs: () => envs, browser, fetch: http, now: options.now, resolveProviderApiKey: options.resolveProviderApiKey });
  async function authenticate(id: string, client = "client-a", secret = dummyKey) {
    const input = await capabilities.requestInput(id, "secret", client);
    await capabilities.submitInput(input.id, client, { secret });
    return input;
  }
  return { directory, harness, credentials, envs, browser, http, capabilities, authenticate };
}

function reusableModelConfig(baseUrl: string): MocoModelConfig {
  return {
    baseUrl, apiMode: "openai-completions", defaultModel: "configured-text-model", thinkingLevel: "off", contextWindow: 256_000,
    compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 24_000, backgroundTokens: 32_768 }, gatewayDisabled: true,
    customProviders: [{ id: "api-image-source", name: "已有模型连接", api: "openai-completions", baseUrl, models: [{ id: "configured-text-model" }] }],
  };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(context);
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("media capability registry", () => {
  it("requires an explicit profile for a new model and validates its declared defaults", async () => {
    const f = await fixture();
    await expect(f.capabilities.configure(imageInput("unknown-no-guess", { modelId: "future-image-model" }))).rejects.toMatchObject({ code: "image_profile_required" });
    const cap = await f.capabilities.configure(imageInput("unknown-declared", { modelId: "future-image-model", imageProfile: {
      formats: ["webp"], supportsEdit: false, maxReferences: 0, parameters: [{ key: "steps", label: "步数", type: "number", minimum: 1, maximum: 30, default: 12 }],
    }, defaults: { format: "webp", custom: { steps: 20 } } }));
    expect(cap).toMatchObject({ modelId: "future-image-model", formats: ["webp"], supportsEdit: false, defaults: { custom: { steps: 20 } } });
    await expect(f.capabilities.configure(imageInput("invalid-new-default", { modelId: "future-image-model", imageProfile: cap.imageProfile, defaults: { format: "webp", custom: { steps: 90 } } }))).rejects.toMatchObject({ code: "invalid_image_configuration" });
    await expect(f.capabilities.configure(imageInput("unapproved-extra-option", { defaults: { custom: { api_key: "synthetic-private-key" } } }))).rejects.toMatchObject({ code: "invalid_image_configuration" });
    expect(JSON.stringify(await f.capabilities.snapshot())).not.toContain("synthetic-private-key");
  });

  it("hydrates a saved known image model without changing its connection or permission", async () => {
    const f = await fixture();
    const cap = await f.capabilities.configure(imageInput("legacy-profile"));
    await f.authenticate(cap.id);
    await f.harness.commit(async (tx) => {
      const record = (await tx.doc(MocoCapabilitiesDoc)).capabilities[cap.id]!;
      delete record.imageProfile; delete record.defaults;
      record.formats = ["png"];
    }, context);
    await f.capabilities.initialize();
    const restored = (await f.capabilities.snapshot()).capabilities[0]!;
    expect(restored).toMatchObject({ connectionId: cap.connectionId, allowTaskGeneration: true, defaults: { format: "png", quality: "auto" } });
    expect(restored.formats).toContain("gif");
    expect(await f.capabilities.apiKey(restored.connectionId)).toBe(dummyKey);
  });

  it("stores image defaults separately and rejects incompatible format options before saving", async () => {
    const f = await fixture();
    const saved = await f.capabilities.configure(imageInput("native-defaults", { defaults: { format: "png", quality: "high", background: "transparent", complexity: "high" } }));
    expect(saved.defaults).toMatchObject({ quality: "high", background: "transparent", complexity: "high" });
    for (const defaults of [{ format: "jpeg" as const, background: "transparent" as const }, { format: "png" as const, outputCompression: 80 }, { format: "gif" as const, frameCount: 20 }]) {
      await expect(f.capabilities.configure(imageInput(`invalid-${JSON.stringify(defaults)}`, { defaults }))).rejects.toMatchObject({ status: 400 });
    }
    await expect(f.capabilities.configure(imageInput("older-custom-size", { modelId: "gpt-image-1.5", defaults: { size: "1536x864" } }))).rejects.toMatchObject({ code: "invalid_image_configuration" });
    await expect(f.capabilities.configure(imageInput("lite-resolution", { adapter: "gemini-image", modelId: "gemini-3.1-flash-lite-image", defaults: { size: "4K" } }))).rejects.toMatchObject({ code: "invalid_image_configuration" });
  });

  it("routes by supported task parameters and preferences while preserving an explicit selection", async () => {
    const f = await fixture();
    const detailed = await f.capabilities.configure(imageInput("route-detail", { modelId: "gpt-image-2.6-sunburst", allowTaskGeneration: true }));
    const fast = await f.capabilities.configure(imageInput("route-fast", { modelId: "gpt-image-2.6-flare", allowTaskGeneration: true }));
    const google = await f.capabilities.configure(imageInput("route-google", { adapter: "gemini-image", modelId: "gemini-nano-banana-2.1", allowTaskGeneration: true }));
    await f.authenticate(detailed.id); await f.authenticate(google.id);
    expect((await f.capabilities.resolve(undefined, "image", undefined, { preference: "speed" })).capability.id).toBe(fast.id);
    expect((await f.capabilities.resolve(undefined, "image", undefined, { parameters: { size: "4K" } })).capability.id).toBe(google.id);
    expect((await f.capabilities.resolve(undefined, "image", undefined, { preference: "quality", parameters: { background: "transparent" } })).capability.id).toBe(detailed.id);
    const before = await f.capabilities.routingSettings();
    const command = { commandId: "poster-rule", expectedRevision: before.revision, settings: { ...before.settings, rules: [{ id: "poster", name: "海报", capabilityId: google.id, enabled: true, keywords: ["海报"] }] } };
    const saved = await f.capabilities.configureRouting(command);
    expect((await f.capabilities.resolve(undefined, "image", undefined, { prompt: "做一张海报" })).capability.id).toBe(google.id);
    expect((await f.capabilities.resolve(detailed.id, "image", undefined, { prompt: "做一张海报" })).capability.id).toBe(detailed.id);
    expect((await f.capabilities.configureRouting(command)).settings).toEqual(saved.settings);
    await expect(f.capabilities.configureRouting({ ...command, commandId: "stale-rule" })).rejects.toMatchObject({ code: "capability_revision_conflict" });
  });

  it("uses required custom defaults during automatic routing and preserves them for partial overrides", async () => {
    const f = await fixture();
    const cap = await f.capabilities.configure(imageInput("route-required-default", { modelId: "new-compatible-model", allowTaskGeneration: true,
      imageProfile: { formats: ["png"], supportsEdit: false, maxReferences: 0, parameters: [
        { key: "steps", label: "步数", type: "number", required: true, minimum: 1, maximum: 30 },
        { key: "seed", label: "种子", type: "number" },
      ] }, defaults: { format: "png", custom: { steps: 18, seed: 1 } } }));
    await f.authenticate(cap.id);
    expect((await f.capabilities.resolve(undefined, "image", undefined, { parameters: { custom: { seed: 7 } } })).capability.id).toBe(cap.id);
    expect((await f.capabilities.resolve(undefined, "image", undefined, {})).capability.id).toBe(cap.id);
  });

  it("accepts a credential-free custom interface and refuses cross-origin paths and embedded secrets", async () => {
    const f = await fixture();
    const input: CapabilityConfigurationInput = { commandId: "custom-local", name: "自定义图片", adapter: "custom-image", baseUrl: "https://custom.example/api", modelId: "new-model", imageProfile: { formats: ["png"], supportsEdit: false, maxReferences: 0 },
      customAdapter: { auth: { type: "none" }, generate: { path: "generate", body: { model: "{{model}}", prompt: "{{prompt}}" } }, response: { imagesPath: "images", base64Path: "data" } } };
    const cap = await f.capabilities.configure(input);
    expect(await f.capabilities.connection(cap.connectionId)).toMatchObject({ hasCredential: true });
    expect(await f.capabilities.apiKey(cap.connectionId)).toBe("");
    expect((await f.capabilities.check(cap.id)).status).toBe("unverified");
    expect(f.http).not.toHaveBeenCalled();
    await expect(f.capabilities.configure({ ...input, commandId: "custom-cross-origin", customAdapter: { ...input.customAdapter!, generate: { path: "https://foreign.example/generate", body: {} } } })).rejects.toMatchObject({ code: "invalid_image_configuration" });
    await expect(f.capabilities.configure({ ...input, commandId: "custom-secret-body", customAdapter: { ...input.customAdapter!, generate: { path: "generate", body: { api_key: "synthetic-private-key" } } } })).rejects.toMatchObject({ code: "invalid_image_configuration" });
  });
  it("reuses a model connection by reference and isolates an explicitly new key from sibling connections", async () => {
    let manager!: MocoProviderManager;
    const f = await fixture({ resolveProviderApiKey: (id, baseUrl) => manager.resolveProbeApiKey(id, baseUrl) });
    manager = new MocoProviderManager({ stateDir: f.directory, credentials: f.credentials });
    manager.syncProviders(reusableModelConfig("https://images.example/v1"), {});
    await f.credentials.modify("api-image-source", async () => ({ type: "api_key", key: dummyKey, env: { MOCO_API_KEY_ORIGIN: "https://images.example" } }));
    const referenced = await f.capabilities.configure(imageInput("reuse-model-key", { baseUrl: "https://images.example/v1", credentialProviderId: "api-image-source" }));
    expect(await f.capabilities.apiKey(referenced.connectionId)).toBe(dummyKey);
    expect(await f.capabilities.connection(referenced.connectionId)).toMatchObject({ credentialProviderId: "api-image-source", hasCredential: true });
    expect(await f.credentials.list()).toEqual([{ providerId: "api-image-source", type: "api_key" }]);
    await expect(f.capabilities.requestInput(referenced.id, "secret", "client-a"))
      .rejects.toMatchObject({ status: 409, code: "capability_credential_source_conflict" });
    expect(await f.capabilities.listInputs("client-a")).toEqual([]);

    const sibling = await f.capabilities.configure(imageInput("own-sibling", { baseUrl: "https://images.example/v1" }));
    await f.authenticate(sibling.id, "client-a", "synthetic-sibling-key");
    expect(sibling.connectionId).not.toBe(referenced.connectionId);
    const before = (await f.capabilities.snapshot()).capabilities.find((item) => item.id === referenced.id)!;
    const independent = await f.capabilities.configure(imageInput("choose-new-key", { id: referenced.id, expectedRevision: before.revision,
      baseUrl: "https://images.example/v1", credentialProviderId: null }));
    expect(independent.connectionId).not.toBe(sibling.connectionId);
    expect(independent.status).toBe("needs_auth");
    await f.authenticate(independent.id, "client-a", "synthetic-new-image-key");
    expect(await f.capabilities.apiKey(independent.connectionId)).toBe("synthetic-new-image-key");
    expect(await f.capabilities.apiKey(sibling.connectionId)).toBe("synthetic-sibling-key");
    expect((await f.credentials.read("api-image-source"))?.type).toBe("api_key");
    const latest = (await f.capabilities.snapshot()).capabilities.find((item) => item.id === independent.id)!;
    const renamed = await f.capabilities.configure(imageInput("rename-own-key", { id: latest.id, expectedRevision: latest.revision,
      name: "已改名", baseUrl: "https://images.example/v1" }));
    expect(renamed.connectionId).toBe(independent.connectionId);
    expect(await f.capabilities.apiKey(renamed.connectionId)).toBe("synthetic-new-image-key");
    const stored = JSON.stringify(await f.harness.snapshot(MocoCapabilitiesDoc, context));
    expect(stored).not.toContain(dummyKey);
    expect(stored).not.toContain("synthetic-new-image-key");
    expect(f.http).not.toHaveBeenCalled();
  });

  it("rejects provider origin drift and OAuth credentials without falling back to a media key", async () => {
    let manager!: MocoProviderManager;
    const f = await fixture({ resolveProviderApiKey: (id, baseUrl) => manager.resolveProbeApiKey(id, baseUrl) });
    manager = new MocoProviderManager({ stateDir: f.directory, credentials: f.credentials });
    const original = reusableModelConfig("https://one.example/v1");
    manager.syncProviders(original, {});
    await f.credentials.modify("api-image-source", async () => ({ type: "api_key", key: dummyKey, env: { MOCO_API_KEY_ORIGIN: "https://one.example" } }));
    const referenced = await f.capabilities.configure(imageInput("reference-for-drift", { baseUrl: original.baseUrl, credentialProviderId: "api-image-source" }));
    const own = await f.capabilities.configure(imageInput("own-for-no-fallback", { baseUrl: original.baseUrl }));
    await f.authenticate(own.id);
    manager.syncProviders(reusableModelConfig("https://two.example/v1"), {});
    expect(await f.capabilities.connection(referenced.connectionId)).toMatchObject({ hasCredential: false });
    await expect(f.capabilities.apiKey(referenced.connectionId)).rejects.toMatchObject({ code: "media_credential_missing" });
    expect(await f.capabilities.apiKey(own.connectionId)).toBe(dummyKey);
    await expect(f.capabilities.configure(imageInput("old-target-drift", { baseUrl: original.baseUrl, credentialProviderId: "api-image-source" })))
      .rejects.toMatchObject({ code: "capability_provider_credential_unavailable" });
    await expect(f.capabilities.configure(imageInput("saved-origin-drift", { baseUrl: "https://two.example/v1", credentialProviderId: "api-image-source" })))
      .rejects.toMatchObject({ code: "capability_provider_credential_unavailable" });
    manager.syncProviders(original, {});
    await f.credentials.modify("api-image-source", async () => ({ type: "oauth", access: "synthetic-subscription-access", refresh: "synthetic-subscription-refresh", expires: Date.now() + 60_000 }));
    await expect(f.capabilities.apiKey(referenced.connectionId)).rejects.toMatchObject({ code: "media_credential_missing" });
    await expect(f.capabilities.configure(imageInput("oauth-not-a-key", { baseUrl: original.baseUrl, credentialProviderId: "api-image-source" })))
      .rejects.toMatchObject({ code: "capability_provider_credential_unavailable" });
    const latest = (await f.capabilities.snapshot()).capabilities.find((item) => item.id === referenced.id)!;
    await f.capabilities.remove(latest.id, latest.revision, "remove-reference");
    expect((await f.credentials.read("api-image-source"))?.type).toBe("oauth");
    expect(f.http).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent configuration and persists independent media records across a restart", async () => {
    const f = await fixture();
    const input = imageInput("create-once");
    const [first, repeated] = await Promise.all([f.capabilities.configure(input), f.capabilities.configure(input)]);
    expect(repeated.id).toBe(first.id);
    expect((await f.capabilities.snapshot()).capabilities).toHaveLength(1);
    await f.authenticate(first.id);
    const before = await f.capabilities.snapshot();
    await f.harness.close(context);
    const reopened = await fixture({ directory: f.directory });
    const after = await reopened.capabilities.snapshot();
    expect(after).toEqual(before);
    expect(await reopened.capabilities.apiKey(first.connectionId)).toBe(dummyKey);
    expect((await reopened.capabilities.configure(input)).id).toBe(first.id);
    expect((await reopened.capabilities.snapshot()).capabilities).toHaveLength(1);
    await expect(reopened.capabilities.configure({ ...input, name: "不同请求" })).rejects.toMatchObject({ status: 409, code: "capability_command_conflict" });
  });

  it("shares one compatible connection across image models and maintains a single enabled default", async () => {
    const f = await fixture();
    const first = await f.capabilities.configure(imageInput("first"));
    const second = await f.capabilities.configure(imageInput("second", { name: "另一图片模型", modelId: "gpt-image-2.6-sunburst", isDefault: true }));
    expect(second.connectionId).toBe(first.connectionId);
    expect((await f.capabilities.snapshot()).connections).toHaveLength(1);
    expect((await f.capabilities.snapshot()).capabilities.filter((cap) => cap.isDefault).map((cap) => cap.id)).toEqual([second.id]);
    await f.authenticate(first.id);
    expect((await f.capabilities.resolve(undefined, "image", "gif")).capability.id).toBe(second.id);
    const current = (await f.capabilities.snapshot()).capabilities.find((cap) => cap.id === second.id)!;
    const disabled = await f.capabilities.setEnabled(second.id, false, current.revision, "disable-second");
    expect(disabled.status).toBe("disabled");
    expect((await f.capabilities.resolve(undefined, "image")).capability.id).toBe(first.id);
    expect(await f.capabilities.setEnabled(second.id, false, current.revision, "disable-second")).toMatchObject({ id: second.id, status: "disabled" });
    await expect(f.capabilities.resolve(second.id, "image")).rejects.toMatchObject({ code: "media_capability_disabled" });
  });

  it("only advertises formats provided by the selected adapter and known model family", async () => {
    const f = await fixture();
    const old = await f.capabilities.configure(imageInput("old", { modelId: "gpt-image-1.5" }));
    const newer = await f.capabilities.configure(imageInput("newer", { modelId: "gpt-image-2.6-sunburst" }));
    const google = await f.capabilities.configure(imageInput("google", { adapter: "gemini-image", modelId: "gemini-nano-banana-2.1" }));
    expect(old.formats).not.toContain("gif");
    expect(newer.formats).toEqual(expect.arrayContaining(["gif", "svg"]));
    expect(google.formats).toEqual(["jpeg", "png"]);
    expect(google.supportsEdit).toBe(true);
    await expect(f.capabilities.configure(imageInput("not-a-gif-alias", { modelId: "gpt-image-2.6" }))).rejects.toMatchObject({ code: "image_profile_required" });
    await expect(f.capabilities.configure(imageInput("legacy-dalle", { modelId: "dall-e-3" }))).rejects.toMatchObject({ code: "unsupported_media_model" });
    await expect(f.capabilities.resolve(google.id, "image", "gif")).rejects.toMatchObject({ code: "unsupported_media_format" });
    await expect(f.capabilities.configure({ ...imageInput("invented-format"), formats: ["gif"] } as CapabilityConfigurationInput)).rejects.toThrow("不支持的字段");
    await expect(f.capabilities.configure({ ...imageInput("prompt-key"), apiKey: dummyKey } as CapabilityConfigurationInput)).rejects.toThrow("保密输入");
    expect(JSON.stringify(await f.harness.snapshot(MocoCapabilitiesDoc, context))).not.toContain(dummyKey);
  });

  it("uses revision checks for updates and never reuses a key after changing the origin", async () => {
    const f = await fixture();
    const first = await f.capabilities.configure(imageInput("origin-first", { baseUrl: "https://one.example/v1" }));
    const sibling = await f.capabilities.configure(imageInput("origin-sibling", { baseUrl: "https://one.example/v1", modelId: "gpt-image-1.5" }));
    await f.authenticate(first.id);
    const oldInput = await f.capabilities.requestInput(first.id, "secret", "client-a");
    const current = (await f.capabilities.snapshot()).capabilities.find((cap) => cap.id === first.id)!;
    await expect(f.capabilities.configure(imageInput("stale", { id: first.id, expectedRevision: first.revision, baseUrl: "https://two.example/v1" }))).rejects.toMatchObject({ status: 409 });
    const changed = await f.capabilities.configure(imageInput("origin-change", { id: first.id, expectedRevision: current.revision, baseUrl: "https://two.example/v1" }));
    expect(changed.connectionId).not.toBe(first.connectionId);
    expect(changed.status).toBe("needs_auth");
    await expect(f.capabilities.apiKey(changed.connectionId)).rejects.toMatchObject({ code: "media_credential_missing" });
    expect(await f.capabilities.apiKey(sibling.connectionId)).toBe(dummyKey);
    await expect(f.capabilities.submitInput(oldInput.id, "client-a", { secret: "synthetic-stale-secret" })).rejects.toMatchObject({ status: 409 });
    expect(JSON.stringify(await f.harness.snapshot(MocoCapabilitiesDoc, context))).not.toContain("synthetic-stale-secret");
    expect((await f.capabilities.configure(imageInput("origin-first", { baseUrl: "https://one.example/v1" }))).connectionId).toBe(changed.connectionId);
  });

  it.each(["file:///tmp/test", "https://user:password@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "not-a-url"])("rejects credential-bearing or invalid service URL %s", async (baseUrl) => {
    const f = await fixture();
    await expect(f.capabilities.configure(imageInput("invalid-url", { baseUrl }))).rejects.toMatchObject({ status: 400 });
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
  });

  it("isolates expiring secret requests by client and never persists the entered key in a Durable record", async () => {
    let now = 1000;
    const f = await fixture({ now: () => now });
    const cap = await f.capabilities.configure(imageInput("private"));
    const request = await f.capabilities.requestInput(cap.id, "secret", "client-a");
    expect((await f.capabilities.requestInput(cap.id, "secret", "client-a")).id).toBe(request.id);
    expect(await f.capabilities.listInputs()).toEqual([]);
    expect(await f.capabilities.listInputs("client-b")).toEqual([]);
    await expect(f.capabilities.submitInput(request.id, "client-b", { secret: dummyKey })).rejects.toMatchObject({ status: 403 });
    await f.capabilities.submitInput(request.id, "client-a", { secret: dummyKey });
    await f.capabilities.submitInput(request.id, "client-a", { secret: "synthetic-replayed-value" });
    expect(await f.capabilities.apiKey(cap.connectionId)).toBe(dummyKey);
    expect((await f.capabilities.listInputs("client-a"))[0]).toMatchObject({ id: request.id, status: "completed" });
    expect(JSON.stringify(await f.harness.snapshot(MocoCapabilitiesDoc, context))).not.toContain(dummyKey);
    expect(JSON.stringify(await f.capabilities.snapshot())).not.toContain(dummyKey);
    const expired = await f.capabilities.requestInput(cap.id, "secret", "client-a");
    now = expired.expiresAt + 1;
    expect((await f.capabilities.listInputs("client-a")).find((input) => input.id === expired.id)?.status).toBe("expired");
    await expect(f.capabilities.submitInput(expired.id, "client-a", { secret: "synthetic-expired-value" })).rejects.toMatchObject({ code: "capability_input_expired" });
    expect(await f.capabilities.apiKey(cap.connectionId)).toBe(dummyKey);
  });

  it("keeps shared credentials until the last capability is removed and retries pending cleanup", async () => {
    const f = await fixture();
    const first = await f.capabilities.configure(imageInput("remove-first"));
    const second = await f.capabilities.configure(imageInput("remove-second", { modelId: "gpt-image-1.5" }));
    await f.authenticate(first.id);
    const snapshot = await f.capabilities.snapshot();
    const firstNow = snapshot.capabilities.find((cap) => cap.id === first.id)!;
    await f.capabilities.remove(first.id, firstNow.revision, "remove-one");
    expect(await f.capabilities.apiKey(second.connectionId)).toBe(dummyKey);
    const secondNow = (await f.capabilities.snapshot()).capabilities[0]!;
    const originalDelete = f.credentials.delete.bind(f.credentials);
    vi.spyOn(f.credentials, "delete").mockRejectedValueOnce(new Error("synthetic private store failure")).mockImplementation(originalDelete);
    await expect(f.capabilities.remove(second.id, secondNow.revision, "remove-last")).rejects.toMatchObject({ code: "capability_cleanup_pending" });
    expect((await f.capabilities.snapshot()).capabilities).toEqual([]);
    expect(Object.keys((await f.harness.snapshot(MocoCapabilitiesDoc, context))!.cleanup)).toHaveLength(1);
    await expect(f.capabilities.remove(second.id, secondNow.revision, "remove-last")).resolves.toMatchObject({ capabilities: [], connections: [] });
    expect(await f.credentials.list()).toEqual([]);
    expect((await f.harness.snapshot(MocoCapabilitiesDoc, context))!.cleanup).toEqual({});
  });

  it("checks model metadata with a bound key without creating a paid generation", async () => {
    const f = await fixture();
    const cap = await f.capabilities.configure(imageInput("metadata"));
    await f.authenticate(cap.id);
    expect((await f.capabilities.check(cap.id)).status).toBe("ready");
    expect(f.http).toHaveBeenCalledWith("https://api.openai.com/v1/models/gpt-image-2.6-flare", expect.objectContaining({ method: "GET", headers: { Authorization: `Bearer ${dummyKey}` }, redirect: "error" }));
    const google = await f.capabilities.configure(imageInput("metadata-google", { adapter: "gemini-image", modelId: "gemini-nano-banana-2.1" }));
    await f.authenticate(google.id);
    vi.mocked(f.http).mockResolvedValueOnce(new Response(JSON.stringify({ name: "models/gemini-nano-banana-2.1" })));
    expect((await f.capabilities.check(google.id)).status).toBe("ready");
    expect(f.http).toHaveBeenLastCalledWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1", expect.objectContaining({ method: "GET", headers: { "x-goog-api-key": dummyKey }, redirect: "error" }));
  });

  it("does not expose server errors and preserves unverified mode when metadata is unsupported", async () => {
    const f = await fixture();
    const cap = await f.capabilities.configure(imageInput("metadata-failed"));
    await f.authenticate(cap.id);
    vi.mocked(f.http).mockResolvedValueOnce(new Response("not supported", { status: 404 }));
    expect((await f.capabilities.check(cap.id)).status).toBe("unverified");
    expect((await f.capabilities.resolve(cap.id, "image")).capability.id).toBe(cap.id);
    vi.mocked(f.http).mockRejectedValueOnce(new Error(`upstream printed ${dummyKey}`));
    const failed = await f.capabilities.check(cap.id);
    expect(failed.status).toBe("error");
    expect(JSON.stringify(failed)).not.toContain(dummyKey);
    expect(JSON.stringify(await f.harness.snapshot(MocoCapabilitiesDoc, context))).not.toContain(dummyKey);
    await expect(f.capabilities.resolve(cap.id, "image")).rejects.toMatchObject({ code: "media_capability_error" });
    vi.mocked(f.http).mockResolvedValueOnce(new Response("denied", { status: 401 }));
    expect((await f.capabilities.check(cap.id)).status).toBe("needs_auth");
  });

  it("rejects stored credentials whose recorded origin differs even when the connection ID exists", async () => {
    const f = await fixture();
    const cap = await f.capabilities.configure(imageInput("bound-origin"));
    await f.authenticate(cap.id);
    await expect(f.capabilities.apiKey(cap.connectionId, "https://different.example")).rejects.toMatchObject({ code: "media_connection_changed" });
    expect(await f.capabilities.apiKey(cap.connectionId, "https://api.openai.com")).toBe(dummyKey);
    const state = await f.harness.snapshot(MocoCapabilitiesDoc, context);
    const reference = state!.connections[cap.connectionId]!.credentialRef!;
    await f.credentials.modify(reference, async () => ({ type: "api_key", key: dummyKey, env: { MOCO_API_KEY_ORIGIN: "https://different.example" } }));
    await expect(f.capabilities.apiKey(cap.connectionId)).rejects.toMatchObject({ code: "media_credential_missing" });
    expect((await f.capabilities.snapshot()).capabilities[0]?.status).toBe("needs_auth");
    expect((await f.capabilities.check(cap.id)).status).toBe("needs_auth");
    expect(f.http).not.toHaveBeenCalled();
  });

  it("uses browser sessions for Flow, requires real login state, and permits disabling an offline capability", async () => {
    let loggedIn = false;
    let now = 1000;
    const browser = vi.fn(async (_env: string, request: BrowserRequest): Promise<BrowserResult> => ({ status: request.action === "open" || !loggedIn ? "needs_login" : "ready", profileRef: request.profileRef }));
    const f = await fixture({ browser, now: () => now });
    const cap = await f.capabilities.configure(imageInput("flow", { adapter: "flow-browser", modelId: "default", browserEnvId: "browser-mac" }));
    expect(cap).toMatchObject({ kind: "video", formats: ["mp4"], status: "unverified" });
    await expect(f.capabilities.apiKey(cap.connectionId)).rejects.toMatchObject({ code: "browser_has_no_api_key" });
    await expect(f.capabilities.requestInput(cap.id, "secret", "client-a")).rejects.toMatchObject({ status: 400 });
    const input = await f.capabilities.requestInput(cap.id, "browser", "client-a");
    const profileRef = (await f.capabilities.connection(cap.connectionId)).profileRef;
    expect(browser).toHaveBeenCalledWith("browser-mac", { action: "open", profileRef });
    await f.capabilities.check(cap.id);
    expect(browser).toHaveBeenLastCalledWith("browser-mac", { action: "check", profileRef });
    const beforeForeign = browser.mock.calls.length;
    await expect(f.capabilities.submitInput(input.id, "client-b", {})).rejects.toMatchObject({ code: "capability_input_forbidden" });
    expect(browser).toHaveBeenCalledTimes(beforeForeign);
    await expect(f.capabilities.submitInput(input.id, "client-a", {})).rejects.toMatchObject({ code: "browser_login_pending" });
    expect(browser).toHaveBeenLastCalledWith("browser-mac", { action: "check", profileRef, takeover: true });
    loggedIn = true;
    await f.capabilities.submitInput(input.id, "client-a", {});
    expect(browser).toHaveBeenLastCalledWith("browser-mac", { action: "check", profileRef, takeover: true });
    expect((await f.capabilities.resolve(cap.id, "video")).capability.status).toBe("ready");
    const expired = await f.capabilities.requestInput(cap.id, "browser", "client-a");
    now = expired.expiresAt + 1;
    const beforeExpired = browser.mock.calls.length;
    await expect(f.capabilities.submitInput(expired.id, "client-a", {})).rejects.toMatchObject({ code: "capability_input_expired" });
    expect(browser).toHaveBeenCalledTimes(beforeExpired);
    expect(f.http).not.toHaveBeenCalled();
    f.envs[0]!.online = false;
    expect((await f.capabilities.snapshot()).capabilities[0]?.status).toBe("offline");
    await expect(f.capabilities.resolve(cap.id, "video")).rejects.toMatchObject({ code: "media_capability_offline" });
    const current = (await f.capabilities.snapshot()).capabilities[0]!;
    expect((await f.capabilities.setEnabled(cap.id, false, current.revision, "disable-offline-flow")).status).toBe("disabled");
  });

  it.each(["needs_auth", "offline"] as const)("rechecks an automatically selected Flow connection after cached %s recovers", async (cachedStatus) => {
    let loggedIn = cachedStatus === "offline";
    const browser = vi.fn(async (_env: string, request: BrowserRequest): Promise<BrowserResult> => ({ status: loggedIn ? "ready" : "needs_login", profileRef: request.profileRef }));
    const f = await fixture({ browser });
    const cap = await f.capabilities.configure(imageInput(`flow-recover-${cachedStatus}`, { adapter: "flow-browser", modelId: "default", browserEnvId: "browser-mac", allowTaskGeneration: true }));
    if (cachedStatus === "offline") f.envs[0]!.online = false;
    expect((await f.capabilities.check(cap.id)).status).toBe(cachedStatus);
    loggedIn = true; f.envs[0]!.online = true;
    const selected = await f.capabilities.resolve(undefined, "video", "mp4", { prompt: "生成一段视频" });
    expect(selected.capability).toMatchObject({ id: cap.id, status: "ready" });
    expect(browser).toHaveBeenLastCalledWith("browser-mac", { action: "check", profileRef: selected.connection.profileRef });
    expect(f.http).not.toHaveBeenCalled();
  });

  it("does not create a Flow connection on a missing, offline or incapable browser device", async () => {
    const f = await fixture();
    const input = imageInput("flow-missing", { adapter: "flow-browser", modelId: "default", browserEnvId: "missing" });
    await expect(f.capabilities.configure(input)).rejects.toMatchObject({ code: "browser_device_offline" });
    f.envs[0]!.capabilities = [];
    await expect(f.capabilities.configure({ ...input, commandId: "flow-incapable", browserEnvId: "browser-mac" })).rejects.toMatchObject({ code: "browser_dependency_missing" });
    f.envs[0]!.capabilities = ["flow-browser"];
    f.envs[0]!.online = false;
    await expect(f.capabilities.configure({ ...input, commandId: "flow-offline", browserEnvId: "browser-mac" })).rejects.toMatchObject({ code: "browser_device_offline" });
    expect((await f.capabilities.snapshot()).connections).toEqual([]);
    expect(f.browser).not.toHaveBeenCalled();
  });

  it("does not allow an unverified Flow page to submit generation and accepts browser model labels", async () => {
    const browser = vi.fn(async (_env: string, request: BrowserRequest): Promise<BrowserResult> => ({ status: "needs_review", profileRef: request.profileRef }));
    const f = await fixture({ browser });
    const cap = await f.capabilities.configure(imageInput("flow-review", { adapter: "flow-browser", modelId: "Veo 3.1 - Quality", browserEnvId: "browser-mac" }));
    await expect(f.capabilities.resolve(cap.id, "video")).rejects.toMatchObject({ code: "media_capability_unverified" });
    expect(browser.mock.calls.every(([, request]) => request.action === "check")).toBe(true);
    expect((await f.capabilities.snapshot()).capabilities[0]?.status).toBe("unverified");
  });
});
