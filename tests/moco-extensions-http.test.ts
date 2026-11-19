import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CapabilitiesWorkspaceSnapshot, ExtensionOperation, ExtensionWorkspaceSnapshot, SettingsAssistantContext } from "@moco/protocol";
import { startMocoHubServer } from "../packages/hub/src/server.js";
import { ContextCompactionDoc } from "../packages/hub/src/context-compaction.js";
import { MocoStateDoc } from "../packages/hub/src/state.js";
import {
  BILLION_CONTEXT_KERNEL_VERSION, inspectBillionContextPackage, installBillionContextPackage, removeBillionContextPackage,
} from "../packages/hub/src/extension-packages.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const envToken = "node-extensions-http-test-only";
const context: SettingsAssistantContext = { module: "capabilities", appearance: "light", hasUnsavedChanges: false, clientId: "extensions-assistant-client" };
const cleanup: Array<() => void | Promise<void>> = [];
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-extensions-http-")));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const npm = path.join(stateDir, "npm.cjs");
  // Supply the published kernel offline; the helper still uses Chord's real build, evaluation and activation.
  fs.writeFileSync(npm, `const fs=require('node:fs'),path=require('node:path');
if(!process.argv.includes('--ignore-scripts'))process.exit(17);
const dir=path.join(process.cwd(),'node_modules/acp-kernel');
fs.mkdirSync(path.dirname(dir),{recursive:true});
fs.cpSync(${JSON.stringify(fs.realpathSync(path.resolve("node_modules/acp-kernel")))},dir,{recursive:true});
fs.writeFileSync('package-lock.json',JSON.stringify({packages:{'node_modules/acp-kernel':{integrity:'sha512-zKqi1mW+oTcpSY79lKkQXdz9AXFrmRj7JL6Mfpuo6JXM0WqRebXHBkQUZz9VGGi1SsOOjK0D9NghZ1/mIakdAA=='}}}));
`);
  const provider = fauxProvider({ provider: "openai", models: [{ id: "extensions-http" }] });
  const models = createModels(); models.setProvider(routeSettingsTitleRequests(provider));
  let respond: FauxResponseFactory = () => answer("已记录。");
  provider.setResponses(Array.from({ length: 30 }, () => (transcript) => respond(transcript)));
  const install = vi.fn((signal: AbortSignal) => installBillionContextPackage({ stateDir, signal, npmCommand: [process.execPath, npm] }));
  const hub = await openTestHub({ models, extensionPackages: {
    inspect: () => inspectBillionContextPackage(stateDir), install, remove: () => removeBillionContextPackage(stateDir),
  }, config: {
    stateDir, identityDir: path.join(stateDir, "identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    envTokens: { node: envToken }, workerEnvIds: ["node"], enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "extensions-http", thinkingLevel: "off", apiKey: "" },
  } });
  cleanup.push(() => hub.close());
  const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  async function call<T = ExtensionWorkspaceSnapshot>(route: string, body?: unknown, token: string | null = HUB_TEST_ADMIN_TOKEN) {
    const response = await fetch(`${server.url}${route}`, {
      method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() as T };
  }
  async function settle(commandId: string) {
    let state!: ExtensionWorkspaceSnapshot;
    await vi.waitFor(async () => {
      state = await hub.extensions.snapshot();
      expect(state.jobs.find((job) => job.id === commandId)?.status).toBe("completed");
    }, { timeout: 10_000, interval: 20 });
    return state;
  }
  async function operation(operation: ExtensionOperation, commandId: string) {
    const item = (await hub.extensions.snapshot()).items[0]!;
    const response = await call("/api/extensions/billion-context/operations", { operation, commandId, expectedRevision: item.revision });
    expect(response.status).toBe(200);
    return settle(commandId);
  }
  const compaction = (id: ConversationId = hub.rootConversation.id) => hub.harness.snapshot(ContextCompactionDoc, id, BACKGROUND_CONTEXT);
  return { hub, stateDir, install, call, settle, operation, compaction, respond: (fn: FauxResponseFactory) => { respond = fn; } };
}

describe("managed extensions through real Hub and HTTP", () => {
  it("publishes the default-off catalog and requires management authentication for reads and operations", async () => {
    const f = await fixture();
    for (const token of [null, envToken]) {
      expect((await f.call("/api/extensions", undefined, token)).status).toBe(401);
      expect((await f.call("/api/extensions/billion-context/operations", { operation: "install", expectedRevision: 1, commandId: "unauthorized" }, token)).status).toBe(401);
    }
    const catalog = await f.call("/api/extensions");
    expect(catalog.status).toBe(200);
    expect(catalog.value.items).toEqual([expect.objectContaining({ id: "billion-context", name: "Billion Context 上下文压缩", enabled: false, status: "not_installed", availableVersion: BILLION_CONTEXT_KERNEL_VERSION })]);
    expect(catalog.value.jobs).toEqual([]);
    const workspace = await f.call<CapabilitiesWorkspaceSnapshot>("/api/capabilities?clientId=browser-a");
    expect(workspace.status).toBe(200); expect(workspace.value.extensions).toEqual(catalog.value);
    expect((await f.compaction())?.enabled ?? false).toBe(false);
    const item = catalog.value.items[0]!;
    expect((await f.call("/api/extensions/billion-context/operations", { operation: "enable", expectedRevision: item.revision, commandId: "not-installed" })).status).toBe(409);
    expect((await f.call("/api/extensions/billion-context/operations", { operation: "install", expectedRevision: item.revision, commandId: "extra-field", shell: "untrusted" })).status).toBe(400);
    expect(f.install).not.toHaveBeenCalled(); expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
  });

  it("installs from the settings assistant, enables existing and new topics, and preserves history after stop and removal", async () => {
    const f = await fixture();
    const prior = await f.hub.sendUserMessage("长期保留：测试项目代号 cobalt-47。", { requestId: "retained-history" });
    await prior.wait(BACKGROUND_CONTEXT);
    const rootId = Number(f.hub.rootConversation.id);
    const original = await f.hub.history.search(rootId, { query: "cobalt-47" });
    expect(original.matches).toHaveLength(1);
    const entryId = original.matches[0]!.entryId;
    const originalText = await f.hub.history.read(rootId, { entryId });

    let phase = 0;
    f.respond(() => ++phase === 1 ? fauxAssistantMessage([fauxToolCall("moco_settings_read", { section: "extensions" })], { stopReason: "toolUse" })
      : phase === 2 ? fauxAssistantMessage([fauxToolCall("moco_extension_manage", { id: "billion-context", action: "install", expected_revision: 1 })], { stopReason: "toolUse" })
        : answer("已提交安装，安装完成后保持关闭。"));
    await f.hub.settingsAssistant.send("安装 Billion Context 上下文压缩，先保持关闭。", context, "assistant-install");
    await vi.waitFor(async () => {
      const snapshot = await f.hub.settingsAssistant.getSnapshot();
      expect(snapshot.live.busy).toBe(false);
      expect((await f.hub.extensions.snapshot()).jobs).toHaveLength(1);
    }, { timeout: 10_000, interval: 20 });
    const job = (await f.hub.extensions.snapshot()).jobs[0]!;
    const installed = await f.settle(job.id);
    const actual = await inspectBillionContextPackage(f.stateDir);
    expect(actual?.version).toBe(BILLION_CONTEXT_KERNEL_VERSION);
    expect(installed.items[0]).toMatchObject({ enabled: false, status: "stopped", installedVersion: actual!.version, adapterVersion: actual!.adapterVersion });
    expect(job.clientId).toBe(context.clientId); expect(f.install).toHaveBeenCalledOnce();
    expect((await f.hub.settingsAssistant.getSnapshot()).actions).toEqual([]);
    expect((await f.compaction())?.enabled ?? false).toBe(false);

    const enabled = await f.operation("enable", "http-enable");
    expect(enabled.items[0]).toMatchObject({ enabled: true, status: "running" });
    expect(await f.compaction()).toMatchObject({ enabled: true, kernelVersion: actual!.version });
    const topic = await f.hub.createTopic("启用后的新对话");
    expect(await f.compaction(topic.conversationId as ConversationId)).toMatchObject({ enabled: true, kernelVersion: actual!.version });
    const stale = await f.call("/api/extensions/billion-context/operations", { operation: "stop", commandId: "stale-stop", expectedRevision: installed.items[0]!.revision });
    expect(stale.status).toBe(409);

    const stopped = await f.operation("stop", "http-stop");
    expect(stopped.items[0]).toMatchObject({ enabled: false, status: "stopped", installedVersion: actual!.version });
    expect(await f.compaction()).toMatchObject({ enabled: false });
    expect(await f.compaction(topic.conversationId as ConversationId)).toMatchObject({ enabled: false });
    expect(await f.hub.history.read(rootId, { entryId })).toEqual(originalText);
    const removed = await f.operation("remove", "http-remove");
    expect(removed.items[0]).toMatchObject({ enabled: false, status: "not_installed" });
    expect(removed.items[0]?.installedVersion).toBeUndefined();
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
    expect(await f.hub.history.read(rootId, { entryId })).toEqual(originalText);
    expect((await f.hub.history.search(rootId, { query: "cobalt-47" })).matches).toEqual(original.matches);
    expect((await f.hub.getTopicView("root")).messages.some((message) => JSON.stringify(message).includes("cobalt-47"))).toBe(true);
  });

  it("aligns restored cached and uncached topics and stops compression for tombstoned topics", async () => {
    const f = await fixture();
    f.respond(() => { throw new Error("Topic lifecycle operations must not request the model"); });
    const cached = await f.hub.createTopic("保留缓存的已删除对话");
    const uncached = await f.hub.createTopic("重新加载的已删除对话");
    await f.hub.deleteTopic(uncached.id);
    await f.hub.harness.commit(async (tx) => {
      (await tx.doc(MocoStateDoc)).topics![cached.id]!.deletedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    const topics = [cached, uncached];
    await f.operation("install", "restore-install");
    await f.operation("enable", "restore-enable");
    for (const topic of topics) expect((await f.compaction(topic.conversationId as ConversationId))?.enabled ?? false).toBe(false);

    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      for (const topic of topics) {
        delete state.topics![topic.id]!.deletedAt;
        delete state.topics![topic.id]!.deletionId;
      }
    }, BACKGROUND_CONTEXT);
    await f.hub.getTopicView(cached.id);
    await f.hub.getTopicHistory(uncached.id, 1);
    for (const topic of topics) expect(await f.compaction(topic.conversationId as ConversationId)).toMatchObject({ enabled: true, kernelVersion: BILLION_CONTEXT_KERNEL_VERSION });

    await f.hub.harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      for (const topic of topics) state.topics![topic.id]!.deletedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    await f.operation("stop", "tombstone-stop");
    for (const topic of topics) expect(await f.compaction(topic.conversationId as ConversationId)).toMatchObject({ enabled: false });
  });

  it.each([false, true])("waits for an in-flight restored-topic alignment before stopping and unloading the package (caller cancelled: %s)", async (cancelled) => {
    const f = await fixture();
    const topic = await f.hub.createTopic("与停止并发恢复的对话");
    await f.hub.harness.commit(async (tx) => {
      (await tx.doc(MocoStateDoc)).topics![topic.id]!.deletedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    await f.operation("install", "align-race-install");
    await f.operation("enable", "align-race-enable");
    await f.hub.harness.commit(async (tx) => { delete (await tx.doc(MocoStateDoc)).topics![topic.id]!.deletedAt; }, BACKGROUND_CONTEXT);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    const snapshot = f.hub.harness.snapshot.bind(f.hub.harness);
    const boundary = vi.spyOn(f.hub.harness, "snapshot").mockImplementation(async (...args) => {
      if (!blocked && args[0] === ContextCompactionDoc && args[1] === topic.conversationId) {
        blocked = true;
        await held;
        if (cancelled) throw new DOMException("Restored-topic caller cancelled", "AbortError");
      }
      return snapshot(...args);
    });
    const restoring = f.hub.getTopicView(topic.id).then(() => ({ error: null }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(blocked).toBe(true), { timeout: 2000, interval: 10 });
      const revision = (await f.hub.extensions.snapshot()).items[0]!.revision;
      const submitted = await f.call("/api/extensions/billion-context/operations", { operation: "stop", commandId: "align-race-stop", expectedRevision: revision });
      expect(submitted.status).toBe(200);
      await vi.waitFor(async () => expect((await f.hub.extensions.snapshot()).jobs.find((job) => job.id === "align-race-stop")).toMatchObject({ status: "running" }), { timeout: 2000, interval: 10 });
      // Give the scheduler time to finish an unfenced stop while the alignment remains deliberately held.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await f.hub.extensions.snapshot()).jobs.find((job) => job.id === "align-race-stop")).toMatchObject({ status: "running" });
    } finally {
      release();
      try { await restoring; }
      finally { boundary.mockRestore(); }
    }
    const outcome = await restoring;
    if (cancelled) expect(outcome.error).toMatchObject({ name: "AbortError" });
    else expect(outcome.error).toBeNull();
    await f.settle("align-race-stop");
    expect(await f.compaction(topic.conversationId as ConversationId)).toMatchObject({ enabled: false });
    await f.operation("remove", "align-race-remove");
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
  });
});
