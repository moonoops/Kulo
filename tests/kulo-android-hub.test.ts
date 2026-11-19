import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ANDROID_TOOL_CATALOG, type AndroidEnvStatus, type AndroidResult, type EnvNodeDescriptor, type TicketRecord } from "@kulo/protocol";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";
import { KuloStateDoc, ticketsShareWriteScope, toTicketCardView } from "../packages/hub/src/state.js";

const cleanup: Array<() => Promise<void> | void> = [];
const names = (context: TranscriptContext) => [...new Set([
  ...(context.tools?.map(tool => tool.name) ?? []),
  ...context.messages.flatMap(message => message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
    ? message.toolsAdded.map(tool => tool.name) : []),
])];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(file => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY", "KULO_ENV_TOKENS"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(options: { textOnly?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-android-hub-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "android-model", input: options.textOnly ? ["text"] : ["text", "image"] }] });
  const models = createModels(); models.setProvider(provider.provider);
  const initial: string[][] = [];
  provider.setResponses(Array.from({ length: 150 }, () => (context: TranscriptContext) => {
    const tools = names(context);
    if (!tools.includes("kulo_report")) return fauxAssistantMessage([fauxText("已收到。")]);
    const results = context.messages.filter(message => message.role === "toolResult");
    if (!results.length) initial.push(tools);
    const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    if (results.some(result => result.toolName === "android_open_app")) return call("kulo_report", { state: "ready", summary: "手机任务已经过新观察验证。" });
    if (tools.includes("android_open_app")) return call("android_open_app", { packageName: "io.kulo.fixture" });
    if (results.some(result => result.toolName === "android_system_info")) return call("tool_search", { query: "android_open_app", limit: 1 });
    return call("android_system_info", { sections: ["battery"] });
  }));
  const config = {
    authToken: HUB_TEST_ADMIN_TOKEN,
    stateDir: path.join(root, "state"), identityDir: path.join(root, "identity"), localEnvRoot: path.join(root, "workspace"),
    enableLocalEnv: false, envTokens: {}, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "android-model", thinkingLevel: "off" as const, apiKey: "" },
  };
  const hub = await openTestHub({ models, config });
  cleanup.push(() => hub.close());
  hub.setAndroidHubIdentity("test-android-hub");
  const status: AndroidEnvStatus = { version: 1, catalogVersion: 1, enabled: true, paused: false, revision: 1,
    grants: ["device", "observe", "control", "apps"], capabilities: ANDROID_TOOL_CATALOG.map(tool => ({ action: tool.action, available: true })) };
  const phones = ["phone-a", "phone-b"].map((id): EnvNodeDescriptor => ({
    id, name: id, kind: "reverse-ws", online: true, platform: "android", arch: "arm64", rootDir: "",
    executionKind: "native-device", capabilities: ["android-device", "android-native-v1"], android: structuredClone(status),
    connectedAt: Date.now(), lastSeenAt: Date.now(),
  }));
  vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation(id => phones.find(phone => phone.id === id));
  vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => structuredClone(phones));
  const filesystem = vi.spyOn(hub.envManager, "createWorkerExecutionEnv").mockImplementation(() => { throw new Error("Android must not acquire a computer filesystem"); });
  const releaseFilesystem = vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockImplementation(async () => { throw new Error("Android must not release a computer filesystem"); });
  const native = vi.spyOn(hub.envManager, "requestAndroid").mockImplementation(async (_id, request): Promise<AndroidResult> => ({
    version: 1, operationId: request.operationId, action: request.action, ticketId: request.ticketId, runEpoch: request.runEpoch,
    status: "completed", data: { verified: true },
  }));
  let quiescent = true;
  const cancel = vi.spyOn(hub.envManager, "cancelAndroid").mockImplementation(async (_id, request) => ({
    version: 1, controlId: request.controlId, ticketId: request.ticketId, runEpoch: request.runEpoch, quiescent,
  }));
  async function complete(id: string, clean = true) {
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[id]?.status).toBe("ready");
      if (clean) expect(state?.tickets[id]?.cleanupPending).not.toBe(true);
    }, { timeout: 15_000, interval: 20 });
    return (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!.tickets[id]!;
  }
  return { hub, config, models, provider, phones, native, cancel, filesystem, releaseFilesystem, initial, complete,
    quiet: (value: boolean) => { quiescent = value; }, dispatch: (id: string, extra = {}) => hub.dispatchTicket({
      commandId: id, title: "检查手机", goal: "读取电量并打开测试应用", scope: "仅测试手机", role: "coder",
      envId: "phone-a", executionDomain: "android", ...extra,
    }) };
}

describe("Hub-hosted Android Workers", () => {
  it("discovers a deferred phone tool through Pi and never allocates a computer filesystem", async () => {
    const f = await fixture();
    const card = await f.dispatch("android-first");
    const ticket = await f.complete(card.id);
    expect(card).toMatchObject({ executionDomain: "android", androidDeviceIds: ["phone-a"], workspaceDir: "" });
    expect(ticket.scratchDir).toBeUndefined();
    expect(f.filesystem).not.toHaveBeenCalled(); expect(f.releaseFilesystem).not.toHaveBeenCalled();
    expect(f.initial[0]).toEqual(expect.arrayContaining(["android_capabilities", "android_system_info", "android_observe", "tool_search", "kulo_report"]));
    expect(f.initial[0]).not.toEqual(expect.arrayContaining(["android_open_app"]));
    for (const forbidden of ["bash", "read", "write", "edit", "kulo_browser", "kulo_desktop", "kulo_publish_asset"]) expect(f.initial[0]).not.toContain(forbidden);
    expect(f.native.mock.calls.map(([device, request]) => [device, request.action])).toEqual([["phone-a", "system_info"], ["phone-a", "open_app"]]);
    expect(f.cancel.mock.calls[0]?.[0]).toBe("phone-a");
    const conversation = await f.hub.harness.conversation(ticket.workerConversationId as ConversationId, BACKGROUND_CONTEXT);
    expect((await conversation!.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain("android_open_app");
    const settings = f.hub.getSettingsView();
    await f.hub.updateSettingsBlock("presentation", settings.blocks.presentation.revision,
      { ...settings.blocks.presentation.value, workbenchName: "Android verification" });
    expect((await conversation!.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain("android_open_app");
    await f.hub.retryTicket(ticket.id);
    await f.complete(ticket.id);
    expect((await conversation!.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain("android_open_app");
    await f.complete((await f.dispatch("android-second")).id);
    expect(f.initial[1]).not.toContain("android_open_app");
    await f.hub.close();
    const restored = await openTestHub({ models: f.models, config: f.config });
    cleanup.push(() => restored.close());
    restored.setAndroidHubIdentity("test-android-hub");
    const branch = await restored.harness.conversation(ticket.workerConversationId as ConversationId, BACKGROUND_CONTEXT);
    expect((await branch!.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain("android_open_app");
  });

  it("keeps message target intent immutable and rejects a different phone at dispatch", async () => {
    const f = await fixture();
    await (await f.hub.sendUserMessage("检查手机", { requestId: "target-message", targetDeviceId: "phone-a" })).wait(BACKGROUND_CONTEXT);
    await expect(f.hub.sendUserMessage("检查手机", { requestId: "target-message", targetDeviceId: "phone-b" })).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.dispatch("wrong-phone", { envId: "phone-b" })).rejects.toMatchObject({ code: "target_device_conflict" });
    await expect(f.dispatch("expanded-phones", { androidDeviceIds: ["phone-a", "phone-b"] })).rejects.toMatchObject({ code: "target_device_conflict" });
    await (await f.hub.sendUserMessage("改看另一台", { requestId: "target-next", targetDeviceId: "phone-b" })).wait(BACKGROUND_CONTEXT);
    await expect(f.hub.sendUserMessage("旧消息重试", { requestId: "target-message" })).rejects.toMatchObject({ code: "request_intent_conflict" });
    await (await f.hub.sendUserMessage("检查手机", { requestId: "target-message", targetDeviceId: "phone-a" })).wait(BACKGROUND_CONTEXT);
    const state = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(state?.topics?.root?.targetDeviceId).toBe("phone-b");
    expect(Object.values(state?.tickets ?? {})).toHaveLength(0);
  });

  it("retains cleanupPending until the phone confirms native quiescence", async () => {
    const f = await fixture(); f.quiet(false);
    const ticket = await f.complete((await f.dispatch("android-uncertain-stop")).id, false);
    const card = await f.hub.stopTicket(ticket.id, "本机接管");
    expect(card).toMatchObject({ status: "stopped", cleanupPending: true });
    expect(f.releaseFilesystem).not.toHaveBeenCalled();
    f.quiet(true);
    await vi.waitFor(async () => expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[ticket.id]?.cleanupPending).toBe(false), { timeout: 10_000 });
  });

  it("parks and resumes a continuous phone resource without recreating it, while user stop still requires full quiescence", async () => {
    const f = await fixture();
    let resumed = false;
    let stopped = false;
    f.cancel.mockImplementation(async (_device, request) => ({ version: 1, controlId: request.controlId,
      ticketId: request.ticketId, runEpoch: request.runEpoch, quiescent: stopped,
      ...(!stopped ? { epochQuiescent: true, resourcesRetained: true } : {}) }));
    f.native.mockImplementation(async (_device, request) => ({ version: 1, operationId: request.operationId,
      action: request.action, ticketId: request.ticketId, runEpoch: request.runEpoch, status: "completed", data: { captureId: "capture-one", state: "recording" } }));
    f.provider.setResponses(Array.from({ length: 120 }, () => (context: TranscriptContext) => {
      const tools = names(context);
      const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      if (!tools.includes("kulo_report")) return fauxAssistantMessage([fauxText("采集保持运行。")]);
      const results = context.messages.filter(message => message.role === "toolResult");
      const action = resumed ? "audio_status" : "audio_start";
      if (results.some(result => result.toolName === `android_${action}`)) return call("kulo_wait", { reason: "user", detail: "录音继续，等待下一条用户指令。" });
      if (tools.includes(`android_${action}`)) return call(`android_${action}`, resumed ? { captureId: "capture-one" } : { source: "microphone" });
      return call("tool_search", { query: `android_${action}`, limit: 1 });
    }));
    const card = await f.dispatch("continuous-recording");
    await vi.waitFor(async () => {
      const state = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(state?.tickets[card.id]).toMatchObject({ status: "waiting", cleanupPending: false });
      expect(state?.slots.holders).not.toContain(card.id);
    }, { timeout: 12_000 });
    expect(f.native.mock.calls.map(([, request]) => request.action)).toEqual(["audio_start"]);
    expect(f.cancel.mock.calls.every(([, request]) => request.reason === "task_epoch_parked")).toBe(true);
    resumed = true;
    await f.hub.steerTicket({ ticketId: card.id, commandId: "continuous-status", text: "查询录音状态，仍保持采集。" });
    await vi.waitFor(async () => {
      expect(f.native.mock.calls.map(([, request]) => request.action)).toEqual(["audio_start", "audio_status"]);
      expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[card.id]).toMatchObject({ status: "waiting", cleanupPending: false });
    }, { timeout: 12_000 });
    expect(f.native.mock.calls[1]![1].runEpoch).toBeGreaterThan(f.native.mock.calls[0]![1].runEpoch);
    expect(await f.hub.stopTicket(card.id, "用户结束录音")).toMatchObject({ status: "stopped", cleanupPending: true });
    expect(f.cancel.mock.calls.some(([, request]) => request.reason === "task_epoch_retired")).toBe(true);
    stopped = true;
    await vi.waitFor(async () => expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.tickets[card.id]?.cleanupPending).toBe(false), { timeout: 10_000 });
    expect(f.native.mock.calls.filter(([, request]) => request.action === "audio_start")).toHaveLength(1);
  });

  it.each(["authorized", "unbound", "external-url"])("validates audio input scope and canonicalizes trusted attachment metadata (%s)", async (mode) => {
    const f = await fixture();
    const bytes = Buffer.alloc(46); bytes.write("RIFF"); bytes.writeUInt32LE(38, 4); bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(2, 40);
    const attachment = f.hub.uploads.saveUpload({ name: "proof.wav", mimeType: "audio/wav", bytes, ownerId: "phone-a" });
    const before = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    if (mode !== "unbound") f.hub.uploads.bindAttachments([attachment.id], `conversation:${before!.topics!.root!.conversationId}`, "phone-a");
    f.provider.setResponses(Array.from({ length: 100 }, () => (context: TranscriptContext) => {
      const tools = names(context);
      const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      if (!tools.includes("kulo_report")) return fauxAssistantMessage([fauxText("已收到。")]);
      if (context.messages.some(message => message.role === "toolResult" && message.toolName === "android_audio_transcribe")) return call("kulo_report", { state: "ready", summary: "已核对音频引用边界。" });
      if (tools.includes("android_audio_transcribe")) return call("android_audio_transcribe", { audioRef: { resourceId: attachment.id,
        uri: mode === "external-url" ? "https://example.invalid/private.wav" : attachment.url, name: "spoofed.wav", bytes: 1, sha256: "0".repeat(64) } });
      return call("tool_search", { query: "android_audio_transcribe", limit: 1 });
    }));
    await f.complete((await f.dispatch(`audio-input-${mode}`)).id);
    if (mode === "authorized") {
      expect(f.native).toHaveBeenCalledOnce();
      expect(f.native.mock.calls[0]![1].args.audioRef).toEqual({ id: attachment.id, resourceId: attachment.id,
        uri: attachment.url, url: attachment.url, name: "proof.wav", mimeType: "audio/wav", bytes: bytes.length,
        size: bytes.length, kind: "audio", sha256: f.hub.uploads.getUpload(attachment.id)!.record.sha256 });
    } else expect(f.native).not.toHaveBeenCalled();
  });

  it("binds non-image native artifacts for text-only models without injecting image content", async () => {
    const f = await fixture({ textOnly: true });
    const attachment = f.hub.uploads.saveUpload({ name: "proof.json", mimeType: "application/json", ownerId: "phone-a", bytes: Buffer.from('{"proof":true}') });
    f.native.mockImplementation(async (_id, request) => ({ version: 1, operationId: request.operationId, action: request.action,
      ticketId: request.ticketId, runEpoch: request.runEpoch, status: "completed", data: { attachments: [attachment] } }));
    let images = 0;
    f.provider.setResponses(Array.from({ length: 80 }, () => (context: TranscriptContext) => {
      const tools = names(context); const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      if (!tools.includes("kulo_report")) return fauxAssistantMessage([fauxText("已收到。")]);
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "android_compute_artifact");
      if (result?.role === "toolResult") { images = result.content.filter(part => part.type === "image").length; return call("kulo_report", { state: "ready", summary: "计算产物已绑定。" }); }
      return tools.includes("android_compute_artifact") ? call("android_compute_artifact", { jobId: "job-one", name: "proof.json" })
        : call("tool_search", { query: "android_compute_artifact", limit: 1 });
    }));
    const ticket = await f.complete((await f.dispatch("native-artifact-text-model")).id);
    expect(images).toBe(0);
    expect(f.hub.uploads.getUpload(attachment.id)!.record.referenceScopes).toContain(`ticket:${ticket.id}`);
  });

  it("keeps child discovery isolated and enforces inherited read-only phone scope", async () => {
    const f = await fixture();
    const childInitial: string[][] = [];
    f.provider.setResponses(Array.from({ length: 80 }, () => (context: TranscriptContext) => {
      const tools = names(context);
      const results = context.messages.filter(message => message.role === "toolResult");
      const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      if (tools.includes("kulo_report")) return results.some(result => result.toolName === "kulo_subagent")
        ? call("kulo_report", { state: "ready", summary: "已验证只读子任务边界。" })
        : call("kulo_subagent", { tasks: [{ name: "phone-observer", role: "scout", goal: "只读检查手机", scope: "仅当前手机" }] });
      if (!tools.includes("android_system_info")) return fauxAssistantMessage([fauxText("已收到。")]);
      if (!results.length) childInitial.push(tools);
      if (results.some(result => result.toolName === "android_open_app")) return fauxAssistantMessage([fauxText("只读边界已拒绝改变手机状态。")]);
      if (tools.includes("android_open_app")) return call("android_open_app", { packageName: "io.kulo.fixture" });
      return call("tool_search", { query: "android_open_app", limit: 1 });
    }));
    const ticket = await f.complete((await f.dispatch("android-child")).id);
    expect(childInitial[0]).toContain("tool_search");
    for (const name of ["android_open_app", "kulo_report", "kulo_subagent", "bash", "read", "write"]) expect(childInitial[0]).not.toContain(name);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.filesystem).not.toHaveBeenCalled();
    const state = await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const child = Object.values(state?.subagents ?? {}).find(sub => sub.ticketId === ticket.id)!;
    expect(child.readOnly).toBe(true);
    const parent = await f.hub.harness.conversation(ticket.workerConversationId as ConversationId, BACKGROUND_CONTEXT);
    expect((await parent!.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).not.toContain("android_open_app");
    const conversation = await f.hub.harness.conversation(child.conversationId as ConversationId, BACKGROUND_CONTEXT);
    const transcript = await conversation!.context(BACKGROUND_CONTEXT);
    expect(transcript.messages.find(message => message.role === "toolResult" && message.toolName === "android_open_app")).toMatchObject({ isError: true });
  });

  it.each(["phone-a", "phone-b"])("accepts screenshot assets only from the actual responding phone (%s)", async ownerId => {
    const f = await fixture();
    const attachment = f.hub.uploads.saveUpload({ name: "phone.png", mimeType: "image/png", ownerId,
      bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==", "base64") });
    let receivedImage = false;
    let allowReview = false;
    let mainReviewedImage = false;
    f.native.mockImplementation(async (_id, request) => ({ version: 1, operationId: request.operationId,
      action: request.action, ticketId: request.ticketId, runEpoch: request.runEpoch, status: "completed", data: { attachment } }));
    f.provider.setResponses(Array.from({ length: 80 }, () => (context: TranscriptContext) => {
      const tools = names(context);
      const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      if (!tools.includes("kulo_report")) {
        if (!allowReview || ownerId !== "phone-a") return fauxAssistantMessage([fauxText("待主 Agent 审核。")]);
        const latest = context.messages.filter(message => message.role === "toolResult").at(-1);
        if (latest?.role === "toolResult" && latest.toolName === "kulo_inspect_asset") {
          mainReviewedImage = latest.content.some(part => part.type === "image" && part.mimeType === "image/png"
            && part.data === f.hub.uploads.readUploadBytes(f.hub.uploads.getUpload(attachment.id)!).toString("base64"));
          return call("kulo_publish_asset", { asset_id: attachment.id });
        }
        if (latest?.role === "toolResult" && latest.toolName === "kulo_publish_asset") return fauxAssistantMessage([fauxText("已审核并发送截图。")]);
        return call("kulo_inspect_asset", { asset_id: attachment.id });
      }
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "android_screenshot");
      if (result?.role === "toolResult") {
        receivedImage = result.content.some(part => part.type === "image");
        return call("kulo_report", { state: "ready", summary: "截图资源归属已核对。", ...(ownerId === "phone-a" ? { files: [{ asset_id: attachment.id }] } : {}) });
      }
      if (tools.includes("android_screenshot")) return call("android_screenshot", { device_id: "phone-a" });
      return call("tool_search", { query: "android_screenshot", limit: 1 });
    }));
    const ticket = await f.complete((await f.dispatch("android-asset-" + ownerId, { androidDeviceIds: ["phone-a", "phone-b"] })).id);
    expect(receivedImage).toBe(ownerId === "phone-a");
    const stored = f.hub.uploads.getUpload(attachment.id)!;
    if (ownerId === "phone-a") expect(stored.record.referenceScopes).toContain(`conversation:${ticket.workerConversationId}`);
    else expect(stored.record.referenceScopes).not.toContain(`conversation:${ticket.workerConversationId}`);
    expect(f.native.mock.calls[0]?.[0]).toBe("phone-a");
    expect((await f.hub.getTopicView("root")).messages.flatMap(message => message.parts ?? []).filter(part => part.type === "image")).toHaveLength(0);
    if (ownerId === "phone-a") {
      expect(stored.record.referenceScopes).not.toContain(`conversation:${Number(f.hub.rootConversation.id)}`);
      expect(ticket.latestReport?.attachments).toEqual([expect.objectContaining({ id: attachment.id })]);
      allowReview = true;
      await (await f.hub.sendUserMessage("审核截图，通过后发给我。", { requestId: "approve-android-screenshot" })).wait(BACKGROUND_CONTEXT);
      expect(mainReviewedImage).toBe(true);
    }
    const delivered = (await f.hub.getTopicView("root")).messages.flatMap(message => message.parts ?? []).filter(part => part.type === "image");
    expect(delivered).toHaveLength(ownerId === "phone-a" ? 1 : 0);
    if (ownerId === "phone-a") expect(delivered[0]).toMatchObject({ assetId: attachment.id, asset: { kind: "image", mimeType: "image/png" } });
    expect(f.filesystem).not.toHaveBeenCalled();
  });

  it("serializes overlapping phone targets without treating empty workspaces as computer roots", () => {
    const base = { id: "T-a", commandId: "a", title: "a", goal: "a", scope: "phone", role: "coder", status: "queued",
      envId: "phone-a", executionDomain: "android", androidDeviceIds: ["phone-a"], workspaceDir: "", workerConversationId: 2, runEpoch: 1, createdAt: 1, updatedAt: 1 } as TicketRecord;
    const other = { ...base, id: "T-b", envId: "phone-b", androidDeviceIds: ["phone-b"] };
    const mixed = { ...base, id: "T-c", executionDomain: "computer" as const, envId: "desktop", workspaceDir: "/test" };
    expect(ticketsShareWriteScope(base, other)).toBe(false);
    expect(ticketsShareWriteScope(base, mixed)).toBe(true);
    expect(toTicketCardView(base, {})).toMatchObject({ executionDomain: "android", androidDeviceIds: ["phone-a"] });
  });
});
