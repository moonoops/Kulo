import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Credential, type CredentialStore } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { KuloMemoryService, MemoryServiceDoc, createMemoryServiceExtension, type LocalMemoryExecutor } from "../packages/hub/src/memory-service.js";
import { HindsightServiceError } from "../packages/hub/src/hindsight-service.js";
import { KuloSettingsDoc, SettingsUpdateError, applySettingsBlockUpdate, hydrateSettingsFromConfig, toPublicSettingsView, type KuloDurableSettings } from "../packages/hub/src/settings.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import type { HindsightMemoryConfig, HindsightProbeResult, MemoryConnectionUpdateRequest, MemoryServicePrepareRequest } from "@kulo/protocol";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.unstubAllEnvs(); });
const ROUTER = "router-memory-" + "r".repeat(40), WORKER = "worker-memory-" + "w".repeat(40), MODEL = "model-test-" + "m".repeat(40);
const context = BACKGROUND_CONTEXT;
const goodProbe: HindsightProbeResult = { healthy: true, isolationVerified: true, endpoints: [], checkedAt: 1 };

async function fixture(options: { unhealthy?: boolean; hold?: Promise<void>; resolveKey?: boolean; failFirstDeploy?: boolean; memory?: Partial<HindsightMemoryConfig>; validateMemory?: (value: HindsightMemoryConfig) => void; beforeApplied?: (value: KuloDurableSettings) => Promise<void> } = {}) {
  const models = createModels(), registry = createRegistry(), values = new Map<string, Credential>();
  const credentials: CredentialStore = {
    read: async (id) => values.get(id), delete: async (id) => { values.delete(id); },
    modify: async (id, update) => { const value = await update(values.get(id)); if (value === undefined) values.delete(id); else values.set(id, value); },
  };
  let service!: KuloMemoryService;
  const extension = createMemoryServiceExtension(() => service);
  registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  stops.push(() => harness.close(context));
  const root = await harness.root(context);
  let settings = await harness.commit(async (tx) => {
    const doc = await tx.doc(KuloSettingsDoc);
    hydrateSettingsFromConfig(doc, resolveHubConfig({ memory: { enabled: false, ...options.memory } }));
    return JSON.parse(JSON.stringify(doc)) as KuloDurableSettings;
  }, context);
  let installed = false;
  let deployAttempts = 0;
  const local: LocalMemoryExecutor = {
    inspect: async () => ({ installed, running: installed, platform: "darwin", deviceName: "主脑测试机", ...(installed ? { endpoint: "http://127.0.0.1:18888", model: { provider: "openai" as const, model: "test-extractor" } } : {}) }),
    deploy: vi.fn(async (input) => {
      await input.onProgress?.("安装测试服务");
      await options.hold;
      expect(input.apiKey).toBe(MODEL);
      if (options.failFirstDeploy && deployAttempts++ === 0) throw new Error("transient installer failure");
      installed = true;
      return { endpoint: "http://127.0.0.1:18888", routerApiKey: ROUTER, workerApiKey: WORKER, banks: { private: "kulo-core", shared: "kulo-shared" } };
    }),
    configure: vi.fn(async () => ({ endpoint: "http://127.0.0.1:18888", routerApiKey: ROUTER, workerApiKey: WORKER, banks: { private: "kulo-core", shared: "kulo-shared" } })),
    uninstall: vi.fn(async () => { installed = false; return { installed: false, running: false, platform: "darwin", deviceName: "主脑测试机" }; }),
  };
  const probe = vi.fn(async (_candidate: HindsightMemoryConfig) => ({ ...goodProbe, healthy: !options.unhealthy }));
  service = new KuloMemoryService({ harness, operationTask: extension.operationTask, local, credentials,
    settings: () => toPublicSettingsView(settings, "/identity"), memory: () => settings.memory,
    applied: async (next) => { if (options.beforeApplied) await options.beforeApplied(next); settings = next; }, resolveModelCredential: async () => options.resolveKey ? MODEL : undefined,
    probe, validateMemory: options.validateMemory });
  const request = (commandId = "deploy-test"): MemoryServicePrepareRequest => ({ commandId, clientId: "browser-a", expectedRevision: settings.revisions.memory,
    operation: "deploy", model: { provider: "openai", model: "test-extractor", ...(options.resolveKey ? { connectionId: "api-test" } : {}) } });
  const settle = async () => {
    const doc = await harness.snapshot(MemoryServiceDoc, context);
    // A job commits its result before applying live settings and cleaning credentials.
    await Promise.all(Object.values(doc?.jobs ?? {}).flatMap((job) => job.taskId === undefined ? [] : [harness.waitForTask(job.taskId as TaskId, context)]));
    const settled = await harness.snapshot(MemoryServiceDoc, context);
    expect(Object.values(settled?.jobs ?? {}).some((job) => job.view.status === "running")).toBe(false);
  };
  return { service, harness, root, local, values, request, settle, probe, settings: () => settings, setSettings: (next: KuloDurableSettings) => { settings = next; } };
}

function connectionRequest(revision: number, patch: Partial<MemoryConnectionUpdateRequest> = {}): MemoryConnectionUpdateRequest {
  return { expectedRevision: revision, enabled: true, connection: { endpoint: "https://memory.example.test", accessMode: "private-only", banks: { private: "private", shared: "shared" } }, routerApiKey: ROUTER, ...patch };
}

describe("direct memory connection form", () => {
  it("verifies and saves an enabled connection without a job or confirmation card", async () => {
    const f = await fixture();
    const revision = f.settings().revisions.memory;
    const result = await f.service.updateConnection(connectionRequest(revision));
    expect(result.settings.blocks.memory).toMatchObject({ revision: revision + 1, hasRouterApiKey: true, hasWorkerApiKey: false, hasSharedReadApiKey: false, value: { enabled: true, accessMode: "private-only", endpoint: "https://memory.example.test" } });
    expect(result.probe?.healthy).toBe(true); expect(result.service.jobs).toEqual([]); expect(result.service.inputs).toEqual([]);
    expect(f.probe).toHaveBeenCalledOnce(); expect(f.local.deploy).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain(ROUTER);
    expect(Object.keys((await f.harness.snapshot(MemoryServiceDoc, context))?.jobs ?? {})).toEqual([]);
  });

  it("probes an enabled candidate while preserving the saved document and revision", async () => {
    const f = await fixture();
    const before = JSON.stringify(await f.harness.snapshot(KuloSettingsDoc, context));
    const result = await f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { enabled: false }), true);
    expect(f.probe.mock.calls[0]![0]).toMatchObject({ enabled: true, routerApiKey: ROUTER });
    expect(result.probe?.healthy).toBe(true); expect(result.settings.blocks.memory.value.enabled).toBe(false);
    expect(JSON.stringify(await f.harness.snapshot(KuloSettingsDoc, context))).toBe(before);
    expect(JSON.stringify(result)).not.toContain(ROUTER);
  });

  it("keeps the old connection on a failed probe and hides transport error contents", async () => {
    const f = await fixture({ unhealthy: true });
    const before = JSON.stringify(await f.harness.snapshot(KuloSettingsDoc, context));
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory))).rejects.toMatchObject({ status: 409, code: "memory_probe_failed" });
    expect(JSON.stringify(await f.harness.snapshot(KuloSettingsDoc, context))).toBe(before);
    f.probe.mockRejectedValueOnce(new Error(`provider error with ${ROUTER}`));
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory), true)).rejects.toMatchObject({ status: 409, message: "连接检查未完成，原设置已保留。" });
    expect(JSON.stringify(await f.harness.snapshot(KuloSettingsDoc, context))).toBe(before);
  });

  it("does not pass saved or environment credentials to a new origin", async () => {
    vi.stubEnv("KULO_CONNECTION_TEST_ROUTER", ROUTER);
    const f = await fixture({ memory: { enabled: true, accessMode: "private-only", endpoint: "https://old.example.test", routerApiKey: ROUTER, routerApiKeyEnv: "KULO_CONNECTION_TEST_ROUTER" } });
    const before = JSON.stringify(f.settings().memory);
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { routerApiKey: "" }))).rejects.toMatchObject({ status: 400 });
    expect(f.probe).not.toHaveBeenCalled(); expect(JSON.stringify(f.settings().memory)).toBe(before);
    await f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { enabled: false, routerApiKey: "" }));
    expect(f.settings().memory.routerApiKey).toBeUndefined(); expect(f.settings().memory.routerApiKeyDisabled).toBe(true);
  });

  it("retains same-origin blank credentials, CA, fallback settings and omitted alternate addresses", async () => {
    const readKey = "shared-read-" + "s".repeat(40);
    const f = await fixture({ memory: { enabled: true, accessMode: "scoped", endpoint: "https://memory.example.test/old", endpoints: ["https://memory.example.test/backup"], routerApiKey: ROUTER, workerApiKey: WORKER, sharedReadApiKey: readKey, caCertPem: "stored-ca", authFile: "/private/test-memory-auth", routerApiKeyEnv: "TEST_ROUTER_ORIGIN", workerApiKeyEnv: "TEST_WORKER_ORIGIN", sharedReadApiKeyEnv: "TEST_SHARED_ORIGIN", autoAttachTopLevelRouters: false } });
    const result = await f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { connection: { endpoint: "https://memory.example.test/new", accessMode: "scoped", banks: { private: "private", shared: "shared" } }, routerApiKey: "", workerApiKey: "", sharedReadApiKey: "" }));
    expect(f.probe.mock.calls[0]![0]).toMatchObject({ routerApiKey: ROUTER, workerApiKey: WORKER, sharedReadApiKey: readKey, caCertPem: "stored-ca", endpoints: ["https://memory.example.test/backup"], authFile: "/private/test-memory-auth", routerApiKeyEnv: "TEST_ROUTER_ORIGIN", sharedReadApiKeyEnv: "TEST_SHARED_ORIGIN", autoAttachTopLevelRouters: false });
    expect(result.settings.blocks.memory.hasSharedReadApiKey).toBe(true);
    for (const key of [ROUTER, WORKER, readKey]) expect(JSON.stringify(result)).not.toContain(key);
  });

  it("saves disabled configuration without contacting a service or requiring credentials", async () => {
    const f = await fixture({ unhealthy: true });
    const result = await f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { enabled: false, routerApiKey: "", connection: { endpoint: "", accessMode: "kulo", banks: { private: "private", shared: "shared" } } }));
    expect(result.settings.blocks.memory.value).toMatchObject({ enabled: false, endpoint: "http://127.0.0.1:8888" });
    expect(result.probe).toBeUndefined(); expect(f.probe).not.toHaveBeenCalled();
  });

  it("normalizes primary and alternate HTTP addresses before probing or saving", async () => {
    const f = await fixture();
    const result = await f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { connection: { endpoint: " HTTPS://MEMORY.EXAMPLE.TEST:443/api/ ", endpoints: ["https://MEMORY.EXAMPLE.TEST:443/backup/"], accessMode: "private-only", banks: { private: "private", shared: "shared" } } }));
    expect(f.probe.mock.calls[0]![0]).toMatchObject({ endpoint: "https://memory.example.test/api", endpoints: ["https://memory.example.test/backup"] });
    expect(result.settings.blocks.memory.value).toMatchObject({ endpoint: "https://memory.example.test/api", endpoints: ["https://memory.example.test/backup"] });
  });

  it("asks only for the primary credential in private-only mode", async () => {
    const f = await fixture();
    const connection = { endpoint: f.settings().memory.endpoint, accessMode: "private-only" as const, banks: { private: "private", shared: "shared" } };
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { routerApiKey: "", connection }))).rejects.toMatchObject({ status: 400, message: "启用长期记忆前，请填写密钥。" });
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { routerApiKey: "" }))).rejects.toMatchObject({ status: 400, message: "服务地址已变更，请重新填写密钥。" });
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { routerApiKey: "", connection: { ...connection, accessMode: "kulo" } }))).rejects.toMatchObject({ status: 400, message: "启用长期记忆前，请填写密钥和公开目录密钥。" });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it.each(["kulo", "private-only"] as const)("clears credentials not used by %s mode", async (accessMode) => {
    const f = await fixture({ memory: { enabled: false, accessMode: "scoped", endpoint: "https://memory.example.test", routerApiKey: ROUTER, workerApiKey: WORKER, sharedReadApiKey: "read-key-" + "s".repeat(40) } });
    const result = await f.service.updateConnection(connectionRequest(f.settings().revisions.memory, { enabled: false, connection: { endpoint: "https://memory.example.test", accessMode, banks: { private: "private", shared: "shared" } } }));
    expect(f.settings().memory.sharedReadApiKey).toBeUndefined(); expect(f.settings().memory.sharedReadApiKeyDisabled).toBe(true);
    expect(result.settings.blocks.memory.hasWorkerApiKey).toBe(accessMode === "kulo");
    expect(result.settings.blocks.memory.hasSharedReadApiKey).toBe(false);
  });

  it("rejects stale revisions and validates credential separation before probing", async () => {
    const f = await fixture({ validateMemory: () => { throw new SettingsUpdateError(400, "记忆身份不能复用管理身份。"); } });
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory + 1))).rejects.toMatchObject({ status: 409 });
    await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory))).rejects.toMatchObject({ status: 400, message: "记忆身份不能复用管理身份。" });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("checks revision again at commit if settings change while the candidate is probed", async () => {
    const f = await fixture();
    let release!: () => void;
    f.probe.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return goodProbe; });
    const pending = f.service.updateConnection(connectionRequest(f.settings().revisions.memory));
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledOnce());
    const saved = await f.harness.commit(async (tx) => {
      const value = await tx.doc(KuloSettingsDoc);
      applySettingsBlockUpdate(value, "memory", value.revisions.memory, { ...value.memory, banks: { private: "new-private", shared: "new-shared" }, enabled: false });
      return JSON.parse(JSON.stringify(value)) as KuloDurableSettings;
    }, context);
    f.setSettings(saved); release();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(f.settings().memory.banks.private).toBe("new-private"); expect(f.settings().memory.enabled).toBe(false);
  });

  it("rejects edits while an approved service operation is running", async () => {
    let release!: () => void;
    const f = await fixture({ hold: new Promise<void>((resolve) => { release = resolve; }), resolveKey: true });
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm");
    try {
      await vi.waitFor(() => expect(f.local.deploy).toHaveBeenCalledOnce());
      await expect(f.service.updateConnection(connectionRequest(f.settings().revisions.memory))).rejects.toMatchObject({ status: 409, code: "memory_service_busy" });
    } finally { release(); }
    await f.settle();
  });

  it.each([
    { enabled: "true" }, { expectedRevision: "1" }, { routerApiKey: null }, { clearWorkerApiKey: "true" }, { caCertPem: 123 }, { secret: ROUTER },
    { connection: { endpoint: "https://memory.example.test", accessMode: "private-only", banks: { private: "private", shared: "shared", token: ROUTER } } },
    { connection: { endpoint: "https://memory.example.test", accessMode: "private-only", banks: { private: "private", shared: "shared" }, endpoints: [false] } },
  ])("rejects invalid direct form fields without echoing inputs", async (patch) => {
    const f = await fixture();
    let failure: unknown;
    try { await f.service.updateConnection({ ...connectionRequest(f.settings().revisions.memory), ...patch } as never); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 400 }); expect(String(failure)).not.toContain(ROUTER); expect(f.probe).not.toHaveBeenCalled();
  });
});

describe("Hindsight setup confirmation and credential custody", () => {
  it("ignores a stale cancellation after confirmation without removing running job credentials", async () => {
    let release!: () => void;
    const f = await fixture({ hold: new Promise<void>((resolve) => { release = resolve; }) });
    const prepared = await f.service.prepare(f.request());
    await f.service.submitInput(prepared.inputs[0]!.id, "browser-a", { secret: MODEL });
    try {
      await f.service.decide("deploy-test", "browser-a", "confirm");
      await vi.waitFor(() => expect(f.local.deploy).toHaveBeenCalledOnce());
      const rejected = await f.service.decide("deploy-test", "browser-a", "reject");
      expect(rejected.jobs[0]!.status).toBe("running");
      expect(f.values.size).toBe(1);
    } finally { release(); }
    await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs[0]!.status).toBe("succeeded");
    expect(f.values.size).toBe(0);
  });

  it("shows safe executor diagnostics while hiding raw process or provider failures", async () => {
    const f = await fixture({ resolveKey: true });
    vi.mocked(f.local.deploy).mockRejectedValueOnce(new HindsightServiceError("本机托管部署目前支持 macOS 和 Linux 用户级服务。"));
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs[0]!.error).toBe("本机托管部署目前支持 macOS 和 Linux 用户级服务。");
    vi.mocked(f.local.deploy).mockRejectedValueOnce(new Error(`raw stderr ${MODEL}`));
    await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    const view = await f.service.snapshot("browser-a");
    expect(view.jobs[0]!.error).toBe("服务操作未完成，请检查本机服务后重试。");
    expect(JSON.stringify(view)).not.toContain(MODEL);
  });

  it("retries an approved failed installation using the original durable command identity", async () => {
    const f = await fixture({ failFirstDeploy: true, resolveKey: true });
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs[0]!.status).toBe("failed");
    await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs[0]!.status).toBe("succeeded");
    expect(f.local.deploy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.local.deploy).mock.calls.map(([request]) => request.commandId)).toEqual(["deploy-test", "deploy-test"]);
  });

  it("removes already supplied credentials when another input in the same job is cancelled", async () => {
    const f = await fixture();
    const snapshot = await f.service.prepare({ commandId: "connect-three", clientId: "browser-a", expectedRevision: f.settings().revisions.memory,
      operation: "connect", connection: { endpoint: "https://memory.example.test", accessMode: "scoped", banks: { private: "private", shared: "shared" } } });
    expect(snapshot.inputs).toHaveLength(3);
    await f.service.submitInput(snapshot.inputs[0]!.id, "browser-a", { secret: ROUTER });
    expect(f.values.size).toBe(1);
    await f.service.submitInput(snapshot.inputs[1]!.id, "browser-a", { cancel: true });
    expect(f.values.size).toBe(0);
    expect((await f.service.snapshot("browser-a")).jobs[0]!.status).toBe("rejected");
  });
  it("collects secrets outside Durable and deploys once only after the user confirms", async () => {
    const f = await fixture();
    let snapshot = await f.service.prepare(f.request());
    expect(snapshot.jobs[0]!.status).toBe("awaiting-input");
    expect(f.local.deploy).not.toHaveBeenCalled();
    await expect(f.service.decide("deploy-test", "browser-a", "confirm")).rejects.toThrow("完成配置输入");
    const input = snapshot.inputs[0]!;
    await expect(f.service.submitInput(input.id, "browser-b", { secret: MODEL })).rejects.toThrow("保密输入");
    snapshot = await f.service.submitInput(input.id, "browser-a", { secret: MODEL });
    expect(snapshot.jobs[0]!.status).toBe("awaiting-confirmation");
    expect(JSON.stringify(await f.harness.snapshot(MemoryServiceDoc, context))).not.toContain(MODEL);
    expect(JSON.stringify(snapshot)).not.toContain(MODEL);
    await expect(f.service.decide("deploy-test", "browser-b", "confirm")).rejects.toThrow("发起操作");
    await f.service.decide("deploy-test", "browser-a", "confirm");
    await f.settle();
    snapshot = await f.service.snapshot("browser-a");
    expect(snapshot.jobs[0]!.status).toBe("succeeded");
    expect(f.settings().memory.enabled).toBe(true);
    expect(f.local.deploy).toHaveBeenCalledTimes(1);
    await f.service.decide("deploy-test", "browser-a", "confirm");
    await f.settle();
    expect(f.local.deploy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toContain(ROUTER);
    expect(JSON.stringify(snapshot)).not.toContain(WORKER);
    expect(f.values.size).toBe(0);
    const publicView = await f.service.snapshot();
    expect(publicView.jobs).toEqual([]); expect(publicView.inputs).toEqual([]);
  });

  it("preserves active settings when validation fails", async () => {
    const f = await fixture({ unhealthy: true, resolveKey: true });
    const before = JSON.stringify(f.settings().memory);
    await f.service.prepare(f.request());
    await f.service.decide("deploy-test", "browser-a", "confirm");
    await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs[0]!.status).toBe("failed");
    expect(JSON.stringify(f.settings().memory)).toBe(before);
  });

  it("rejects stale approval and never starts the installer", async () => {
    const f = await fixture({ resolveKey: true });
    await f.service.prepare(f.request());
    await f.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      applySettingsBlockUpdate(doc, "memory", doc.revisions.memory, { ...doc.memory, enabled: false });
      f.setSettings(JSON.parse(JSON.stringify(doc)) as KuloDurableSettings);
    }, context);
    await expect(f.service.decide("deploy-test", "browser-a", "confirm")).rejects.toThrow("已更新");
    expect(f.local.deploy).not.toHaveBeenCalled();
  });

  it("rejects secret-shaped config fields and command identity reuse", async () => {
    const f = await fixture({ resolveKey: true });
    await expect(f.service.prepare({ ...f.request(), model: { provider: "openai", model: "test", apiKey: MODEL } } as never)).rejects.toThrow("保密输入");
    await f.service.prepare(f.request());
    await expect(f.service.prepare({ ...f.request(), deleteData: true })).rejects.toThrow("操作标识");
    expect(f.local.deploy).not.toHaveBeenCalled();
  });

  it("disconnects without allowing old environment or inline credentials to revive", async () => {
    const f = await fixture({ resolveKey: true });
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    await f.service.prepare({ commandId: "disconnect-test", clientId: "browser-a", operation: "disconnect", expectedRevision: f.settings().revisions.memory });
    await f.service.decide("disconnect-test", "browser-a", "confirm"); await f.settle();
    expect(f.settings().memory.enabled).toBe(false);
    expect(f.settings().memory.routerApiKey).toBeUndefined();
    expect(f.settings().memory.workerApiKey).toBeUndefined();
    expect(f.settings().memory.routerApiKeyDisabled).toBe(true);
  });

  it("uninstall preserves data by default, pauses integration, and clears its credentials", async () => {
    const f = await fixture({ resolveKey: true });
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    await f.service.prepare({ commandId: "uninstall-test", clientId: "browser-a", operation: "uninstall", expectedRevision: f.settings().revisions.memory });
    expect(f.local.uninstall).not.toHaveBeenCalled();
    await f.service.decide("uninstall-test", "browser-a", "confirm"); await f.settle();
    expect(f.local.uninstall).toHaveBeenCalledWith(expect.objectContaining({ commandId: "uninstall-test", deleteData: undefined }));
    expect(f.settings().memory.enabled).toBe(false); expect(f.settings().memory.routerApiKey).toBeUndefined();
    expect((await f.service.snapshot("browser-a")).jobs.at(-1)?.status).toBe("succeeded");
  });

  it.each([false, true])("recovers a deleted native manifest without clearing a later connection (%s)", async (replaceConnection) => {
    const f = await fixture({ resolveKey: true });
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    let removed = false;
    vi.spyOn(f.local, "inspect").mockImplementation(async () => ({ installed: !removed, running: !removed, platform: "darwin", deviceName: "主脑测试机", endpoint: removed ? "http://127.0.0.1:8888" : "http://127.0.0.1:18888" }));
    vi.mocked(f.local.uninstall).mockImplementation(async () => {
      if (!removed) { removed = true; throw new Error("interrupted after removing the manifest"); }
      return { installed: false, running: false, platform: "darwin", deviceName: "主脑测试机", endpoint: "http://127.0.0.1:8888" };
    });
    await f.service.prepare({ commandId: "delete-native", clientId: "browser-a", operation: "uninstall", deleteData: true, expectedRevision: f.settings().revisions.memory });
    await f.service.decide("delete-native", "browser-a", "confirm"); await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs.at(-1)?.status).toBe("failed");
    expect(f.settings().memory.enabled).toBe(false);
    expect(f.settings().memory.routerApiKey).toBe(ROUTER);
    if (replaceConnection) {
      await f.service.updateConnection(connectionRequest(f.settings().revisions.memory));
      await expect(f.service.decide("delete-native", "browser-a", "confirm")).rejects.toMatchObject({ code: "memory_revision_conflict" });
      expect(f.settings().memory.endpoint).toBe("https://memory.example.test");
      expect(f.settings().memory.enabled).toBe(true);
      expect(f.settings().memory.routerApiKey).toBe(ROUTER);
      expect(f.local.uninstall).toHaveBeenCalledOnce();
    } else {
      await f.service.decide("delete-native", "browser-a", "confirm"); await f.settle();
      expect((await f.service.snapshot("browser-a")).jobs.at(-1)?.status).toBe("succeeded");
      expect(f.settings().memory.routerApiKey).toBeUndefined();
      expect(f.settings().memory.workerApiKey).toBeUndefined();
      expect(f.settings().memory.routerApiKeyDisabled).toBe(true);
      expect(f.settings().memory.workerApiKeyDisabled).toBe(true);
      expect(f.local.uninstall).toHaveBeenCalledTimes(2);
    }
  });

  it("waits for the uninstall task to apply cleared credentials after the durable success commit", async () => {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    let applying = false;
    let applied = false;
    const f = await fixture({ resolveKey: true, beforeApplied: async (next) => {
      if (!next.memory.routerApiKeyDisabled || !next.memory.workerApiKeyDisabled) return;
      applying = true;
      await applyGate;
      applied = true;
    } });
    await f.service.prepare(f.request()); await f.service.decide("deploy-test", "browser-a", "confirm"); await f.settle();
    let removed = false;
    vi.spyOn(f.local, "inspect").mockImplementation(async () => ({ installed: !removed, running: !removed, platform: "darwin", deviceName: "主脑测试机", endpoint: removed ? "http://127.0.0.1:8888" : "http://127.0.0.1:18888" }));
    vi.mocked(f.local.uninstall).mockImplementation(async () => {
      if (!removed) { removed = true; throw new Error("interrupted after removing the manifest"); }
      return { installed: false, running: false, platform: "darwin", deviceName: "主脑测试机" };
    });
    await f.service.prepare({ commandId: "delete-native", clientId: "browser-a", operation: "uninstall", expectedRevision: f.settings().revisions.memory });
    await f.service.decide("delete-native", "browser-a", "confirm"); await f.settle();
    await f.service.decide("delete-native", "browser-a", "confirm");
    try {
      await vi.waitFor(() => expect(applying).toBe(true));
      const doc = await f.harness.snapshot(MemoryServiceDoc, context);
      expect(doc?.jobs["delete-native"]?.view.status).toBe("succeeded");
      const saved = await f.harness.snapshot(KuloSettingsDoc, context);
      expect(saved?.memory.routerApiKey).toBeUndefined();
      expect(saved?.memory.workerApiKey).toBeUndefined();
      expect(Boolean(f.settings().memory.routerApiKey)).toBe(true);
      let joinStarted!: () => void;
      const joining = new Promise<void>((resolve) => { joinStarted = resolve; });
      const waitForTask = f.harness.waitForTask.bind(f.harness);
      vi.spyOn(f.harness, "waitForTask").mockImplementation((taskId, context) => { joinStarted(); return waitForTask(taskId, context); });
      const settling = f.settle();
      expect(await Promise.race([settling.then(() => "finished"), joining.then(() => "joining-task")])).toBe("joining-task");
      releaseApply(); await settling;
      expect(applied).toBe(true);
      expect(f.settings().memory.routerApiKey).toBeUndefined();
      expect(f.settings().memory.workerApiKey).toBeUndefined();
    } finally {
      releaseApply();
      const taskId = (await f.harness.snapshot(MemoryServiceDoc, context))?.jobs["delete-native"]?.taskId;
      if (taskId !== undefined) await f.harness.waitForTask(taskId as TaskId, context);
    }
  });

  it("supports provider='kulo' without secret prompts, collects embedding/rerank API keys securely, and reports clear provider validation errors", async () => {
    const f = await fixture({ resolveKey: false });
    vi.mocked(f.local.deploy).mockImplementationOnce(async (input) => {
      expect(input.model).toEqual({ provider: "kulo", connectionId: "api-vertex", model: "gemini-3.8-flash" });
      expect(input.apiKey).toBeUndefined();
      expect(input.embeddings).toEqual({ provider: "openai", model: "text-embedding-3-small" });
      expect(input.reranker).toEqual({ provider: "siliconflow", model: "BAAI/bge-reranker-v2-m3" });
      expect(input.embeddingsApiKey).toBe("emb-key-123456");
      expect(input.rerankerApiKey).toBe("rr-key-123456");
      return { endpoint: "http://127.0.0.1:18888", routerApiKey: ROUTER, workerApiKey: WORKER, banks: { private: "kulo-core", shared: "kulo-shared" } };
    });

    // Clear provider error (never misleadingly says "密钥请使用保密输入" for an unsupported provider name).
    await expect(f.service.prepare({
      commandId: "bad-provider",
      clientId: "browser-a",
      expectedRevision: f.settings().revisions.memory,
      operation: "deploy",
      model: { provider: "google-vertex" as never, model: "gemini-3.8-flash" },
    })).rejects.toMatchObject({ status: 400, code: "invalid_memory_model", message: expect.stringContaining("不支持的理解模型供应商") });

    // Deploy with Kulo bridge model (no modelApiKey needed!) + remote embedding & rerank (secure inputs requested).
    const prepared = await f.service.prepare({
      commandId: "deploy-kulo-full",
      clientId: "browser-a",
      expectedRevision: f.settings().revisions.memory,
      operation: "deploy",
      model: { provider: "kulo", connectionId: "api-vertex", model: "gemini-3.8-flash" },
      embeddings: { provider: "openai", model: "text-embedding-3-small" },
      reranker: { provider: "siliconflow", model: "BAAI/bge-reranker-v2-m3" },
    });
    const job = prepared.jobs.find((item) => item.id === "deploy-kulo-full")!;
    expect(job.status).toBe("awaiting-input");
    const pendingInputs = prepared.inputs.filter((item) => item.jobId === job.id);
    expect(pendingInputs.map((item) => item.field).sort()).toEqual(["embeddingsApiKey", "rerankerApiKey"]);

    await f.service.submitInput(pendingInputs.find((item) => item.field === "embeddingsApiKey")!.id, "browser-a", { secret: "emb-key-123456" });
    const ready = await f.service.submitInput(pendingInputs.find((item) => item.field === "rerankerApiKey")!.id, "browser-a", { secret: "rr-key-123456" });
    expect(ready.jobs.find((item) => item.id === job.id)?.status).toBe("awaiting-confirmation");
    await f.service.decide(job.id, "browser-a", "confirm");
    await f.settle();
    expect(f.local.deploy).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
  });

  it("supersedes earlier unconfirmed or failed jobs for the same client without affecting other clients", async () => {
    const f = await fixture({ resolveKey: false });
    const first = await f.service.prepare({ ...f.request("deploy-1"), clientId: "browser-a" });
    expect(first.jobs.find((j) => j.id === "deploy-1")?.status).toBe("awaiting-input");
    await f.service.submitInput(first.inputs[0]!.id, "browser-a", { secret: MODEL });
    expect(f.values.size).toBe(1);

    // Another window prepares its own job; it must remain untouched.
    await f.service.prepare({ ...f.request("deploy-other"), clientId: "browser-b" });

    // Preparing a new job in browser-a supersedes deploy-1, cancels its pending inputs, and scrubs its temp credential.
    const second = await f.service.prepare({
      commandId: "deploy-2",
      clientId: "browser-a",
      expectedRevision: f.settings().revisions.memory,
      operation: "deploy",
      model: { provider: "ollama", model: "llama3.2" },
    });
    expect(second.jobs.find((j) => j.id === "deploy-1")?.status).toBe("rejected");
    expect(second.jobs.find((j) => j.id === "deploy-2")?.status).toBe("awaiting-confirmation");
    expect(f.values.size).toBe(0);
    expect((await f.service.snapshot("browser-b")).jobs.find((j) => j.id === "deploy-other")?.status).toBe("awaiting-input");

    // Failed job can be explicitly dismissed (rejected) OR superseded by a fresh prepare.
    vi.mocked(f.local.deploy).mockRejectedValueOnce(new HindsightServiceError("本机未检测到 uv"));
    await f.service.decide("deploy-2", "browser-a", "confirm");
    await f.settle();
    expect((await f.service.snapshot("browser-a")).jobs.find((j) => j.id === "deploy-2")?.status).toBe("failed");

    const third = await f.service.prepare({
      commandId: "deploy-3",
      clientId: "browser-a",
      expectedRevision: f.settings().revisions.memory,
      operation: "deploy",
      model: { provider: "ollama", model: "qwen2.5" },
    });
    expect(third.jobs.find((j) => j.id === "deploy-2")?.status).toBe("rejected");
    expect(third.jobs.find((j) => j.id === "deploy-3")?.status).toBe("awaiting-confirmation");

    vi.mocked(f.local.deploy).mockRejectedValueOnce(new HindsightServiceError("本机未检测到 uv"));
    await f.service.decide("deploy-3", "browser-a", "confirm");
    await f.settle();
    const dismissed = await f.service.decide("deploy-3", "browser-a", "reject");
    expect(dismissed.jobs.find((j) => j.id === "deploy-3")?.status).toBe("rejected");
    expect(dismissed.jobs.find((j) => j.id === "deploy-3")?.error).toBeUndefined();
  });

  it("normalizes bare BGE ONNX model aliases in prepared jobs without rewriting remote provider models", async () => {
    const f = await fixture();
    const prepared = await f.service.prepare({
      commandId: "deploy-onnx-alias",
      clientId: "browser-a",
      expectedRevision: f.settings().revisions.memory,
      operation: "deploy",
      model: { provider: "ollama", model: "llama3.2" },
      embeddings: { provider: "onnx", model: "BAAI/bge-small-zh-v1.5", dimensions: 512 },
      reranker: { provider: "onnx", model: "BAAI/bge-reranker-v2-m3" },
    });
    const job = prepared.jobs.find((item) => item.id === "deploy-onnx-alias")!;
    expect(job.embeddings).toEqual({ provider: "onnx", model: "Xenova/bge-small-zh-v1.5", dimensions: 512 });
    expect(job.reranker).toEqual({ provider: "onnx", model: "onnx-community/bge-reranker-v2-m3-ONNX" });
    expect(job.changes.join("\n")).toContain("onnx-community/bge-reranker-v2-m3-ONNX");
    expect(job.changes.join("\n")).toContain("Xenova/bge-small-zh-v1.5");
  });
});
