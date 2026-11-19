import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { collectDeviceSystemInfo } from "@kulo/env";
import type { DeviceInvitation, DevicePeerConfig, VoiceCallSession } from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { VoiceTranscriptEntry } from "../packages/hub/src/voice-transcripts.js";
import type { VoiceLiveOpenInput } from "../packages/hub/src/voice-live-adapters.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
const admin = "voice-hub-synthetic-management-token";
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const name of ["KULO_API_KEY", "OPENAI_API_KEY", "KULO_AUTH_TOKEN", "KULO_ENV_TOKENS"]) vi.stubEnv(name, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function wave(): Buffer {
  const bytes = Buffer.alloc(3244);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function fixture(options: { localEnv?: boolean } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-voice-hub-"));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const answer = vi.fn((_ctx: TranscriptContext): ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>> => fauxAssistantMessage([fauxText("任务已在当前会话处理。") ]));
  const provider = fauxProvider({ provider: "voice-hub", models: [{ id: "voice-test" }] });
  provider.setResponses(Array.from({ length: 20 }, () => answer));
  const models = createModels(); models.setProvider(provider.provider);
  const asr = { status: () => ({ status: "ready" as const }), prepare: vi.fn(async () => {}),
    transcribe: vi.fn(async () => "请搜索资料并整理报表。"), close: vi.fn() };
  let upstream: VoiceLiveOpenInput | undefined;
  let resolveClosed!: () => void;
  const connection = { inputSampleRate: 16000, outputSampleRate: 24000, closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
    sendAudio: vi.fn(), setMuted: vi.fn(), sendContext: vi.fn(), sendNotification: vi.fn(), sendTaskResult: vi.fn(), close: vi.fn(() => resolveClosed()) };
  const openLive = vi.fn(async (input: VoiceLiveOpenInput) => { upstream = input; return connection; });
  const hub = await openTestHub({ models, voiceAsr: asr, voiceOpenLive: openLive, config: {
    stateDir, identityDir: path.join(stateDir, "identity"), authToken: admin, envTokens: {}, enableLocalEnv: options.localEnv ?? false, localEnvRoot: path.join(stateDir, "runtime"),
    watchdogMinutes: 0, memory: { enabled: false }, model: { defaultProvider: "voice-hub", defaultModel: "voice-test", apiKey: "", thinkingLevel: "off" },
  } });
  cleanup.push(() => hub.close());
  const server = await startKuloHubServer(hub, { port: 0, host: "127.0.0.1" });
  cleanup.push(() => server.close());
  const request = (route: string, method = "GET", body?: unknown, token = admin) => fetch(`${server.url}${route}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const enableCall = async () => hub.voice.configure({ expectedRevision: (await hub.voice.snapshot()).revision,
    call: { enabled: true, provider: "gemini", modelId: "gemini-3.8-live", voice: "Kore", apiKey: "synthetic-official-voice-key" } });
  const connect = async (token = admin) => {
    const response = await request("/api/voice/calls", "POST", { topicId: "root", clientId: "voice-browser", commandId: "create-call" }, token);
    expect(response.status).toBe(201);
    const descriptor = await response.json() as VoiceCallSession;
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}${descriptor.wsPath}?token=${token}`, { origin: server.url });
    cleanup.push(() => { ws.terminate(); });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await vi.waitFor(() => expect(upstream).toBeDefined());
    return { ws, descriptor };
  };
  return { hub, server, asr, answer, openLive, connection, request, enableCall, connect, get upstream() { return upstream!; } };
}

describe("voice integration with the existing Hub", () => {
  it("transcribes audio for text-model input while keeping the original voice bubble and reusing its transcript", async () => {
    const f = await fixture();
    const asset = f.hub.uploads.saveUpload({ bytes: wave(), name: "语音.wav", mimeType: "audio/wav", ownerId: "local", presentation: "voice" });
    await f.hub.sendUserMessage("", { topicId: "root", attachments: [asset], requestId: "audio-one", principalId: "local" });
    await vi.waitFor(() => expect(f.answer).toHaveBeenCalled(), { timeout: 10_000 });
    const display = (await f.hub.getTopicView("root")).messages.find((message) => message.role === "user")!;
    expect(display.text).toBe("");
    expect(display.attachments?.[0]).toMatchObject({ id: asset.id, presentation: "voice", transcript: { text: "请搜索资料并整理报表。", status: "ready" } });
    expect(JSON.stringify(f.answer.mock.calls)).toContain("请搜索资料并整理报表。");
    const manual = await f.request("/api/voice/transcribe", "POST", { assetId: asset.id, topicId: "root" });
    expect(manual.status).toBe(200);
    expect(f.asr.transcribe).toHaveBeenCalledOnce();
    await expect(f.hub.transcribeVoiceAsset(asset.id, { topicId: "missing-topic", principalId: "local" })).rejects.toMatchObject({ status: 404 });
  });

  it("retains original audio and rejects unreadable speech when local recognition is disabled", async () => {
    const f = await fixture();
    await f.hub.voice.configure({ expectedRevision: 0, asr: { enabled: false } });
    const asset = f.hub.uploads.saveUpload({ bytes: wave(), mimeType: "audio/wav", name: "语音.wav", ownerId: "local", presentation: "voice" });
    await expect(f.hub.sendUserMessage("", { attachments: [asset], principalId: "local" })).rejects.toMatchObject({ code: "voice_asr_disabled" });
    expect(f.asr.transcribe).not.toHaveBeenCalled();
    expect(f.hub.uploads.getUpload(asset.id)).toBeTruthy();
  });

  it("authorizes transcript access before returning a previously cached result", async () => {
    const f = await fixture();
    const asset = f.hub.uploads.saveUpload({ bytes: wave(), name: "private.wav", mimeType: "audio/wav", ownerId: "owner-one" });
    await f.hub.transcribeVoiceAsset(asset.id, { principalId: "owner-one" });
    await expect(f.hub.transcribeVoiceAsset(asset.id, { principalId: "other-owner" })).rejects.toMatchObject({ status: 403 });
  });

  it("stages Worker speech without a report file and keeps it out of the originating chat until main-Agent review and publication", async () => {
    const f = await fixture({ localEnv: true });
    await f.hub.voice.configure({ expectedRevision: 0, tts: { enabled: true, provider: "minimax-cn", modelId: "speech-2.8-turbo", voice: "male-qn-qingse", speed: "normal", apiKey: "synthetic-worker-speech-key" } });
    const synthesize = vi.spyOn(f.hub.voice, "synthesize").mockResolvedValue({ bytes: wave(), mimeType: "audio/wav" });
    const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    let workerPhase = 0;
    let speechReceipt: unknown;
    const mainInputs: TranscriptContext[] = [];
    f.answer.mockImplementation((ctx) => {
      const offered = new Set([
        ...(ctx.tools ?? []).map((entry) => entry.name),
        ...ctx.messages.flatMap((message) =>
          message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded)
            ? message.toolsAdded.map((entry) => entry.name)
            : [],
        ),
      ]);
      const router = offered.has("kulo_dispatch");
      if (router) { mainInputs.push(ctx); return fauxAssistantMessage([fauxText("语音待审核。")]); }
      if (!offered.has("kulo_synthesize_speech")) return tool("tool_search", { query: "kulo_synthesize_speech", limit: 3 });
      if (++workerPhase === 1) return tool("kulo_synthesize_speech", { text: "请核对这段语音。" });
      const generated = ctx.messages.findLast((message) => message.role === "toolResult" && message.toolName === "kulo_synthesize_speech");
      if (generated?.role === "toolResult") speechReceipt = JSON.parse(generated.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      return tool("kulo_report", { state: "ready", summary: "语音已暂存，交主 Agent 审核。" });
    });
    const ticket = await f.hub.dispatchTicket({ commandId: "worker-speech-review", title: "合成语音", goal: "合成语音并交主 Agent 审核", scope: "当前任务", role: "developer" });
    await vi.waitFor(async () => expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.status).toBe("ready"), { timeout: 12_000 });
    const staged = (await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!.workerArtifacts?.[ticket.id];
    expect(staged).toHaveLength(1);
    const asset = staged![0]!;
    expect(speechReceipt).toMatchObject({ status: "pending_review", assetId: asset.id, reused: false });
    expect(asset).toMatchObject({ kind: "audio", presentation: "voice", mimeType: "audio/wav" });
    expect(synthesize).toHaveBeenCalledOnce();
    const stored = f.hub.uploads.getUpload(asset.id)!;
    expect(f.hub.uploads.readUploadBytes(stored)).toEqual(wave());
    expect(stored.record.referenceScopes).toContain(`ticket:${ticket.id}`);
    expect(stored.record.referenceScopes).not.toContain(`conversation:${Number(f.hub.rootConversation.id)}`);
    await vi.waitFor(async () => {
      expect(mainInputs.some((ctx) => JSON.stringify(ctx).includes(asset.id))).toBe(true);
      expect((await f.hub.getTopicView("root")).live.busy).toBe(false);
    }, { timeout: 10_000 });
    expect((await f.hub.getTopicView("root")).messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "audio")).toHaveLength(0);

    let reviewPhase = 0;
    let inspectionReceipt: unknown;
    let publicationReceipt: unknown;
    let audioBeforePublication = -1;
    f.answer.mockImplementation(async (ctx) => {
      if (++reviewPhase === 1) return tool("kulo_inspect_asset", { asset_id: asset.id });
      if (reviewPhase === 2) {
        const inspected = ctx.messages.findLast((message) => message.role === "toolResult" && message.toolName === "kulo_inspect_asset");
        if (inspected?.role === "toolResult") inspectionReceipt = JSON.parse(inspected.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
        audioBeforePublication = (await f.hub.getTopicView("root")).messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "audio").length;
        return tool("kulo_publish_asset", { asset_id: asset.id });
      }
      const published = ctx.messages.findLast((message) => message.role === "toolResult" && message.toolName === "kulo_publish_asset");
      if (published?.role === "toolResult") publicationReceipt = JSON.parse(published.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      return fauxAssistantMessage([fauxText("已核对语音产物并发送。")]);
    });
    await f.hub.sendUserMessage("核对待审核语音后发给我", { requestId: "main-review-speech" });
    await vi.waitFor(async () => {
      expect(reviewPhase).toBeGreaterThanOrEqual(3);
      expect((await f.hub.getTopicView("root")).live.busy).toBe(false);
    }, { timeout: 10_000 });
    expect(inspectionReceipt).toMatchObject({ asset: { id: asset.id, kind: "audio" }, inspection: "metadata", contentProvided: false });
    expect(inspectionReceipt).toMatchObject({ note: expect.stringContaining("未解码") });
    expect(audioBeforePublication).toBe(0);
    expect(publicationReceipt).toMatchObject({ id: asset.id, status: "published" });
    const audioParts = (await f.hub.getTopicView("root")).messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "audio");
    expect(audioParts).toEqual([expect.objectContaining({ assetId: asset.id })]);
    expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.workerArtifacts?.[ticket.id]).toEqual([]);
    const response = await f.request(asset.url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wave());
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it("keeps speech hidden in the chat while retaining context for the existing Router", async () => {
    const f = await fixture(); await f.enableCall();
    const { descriptor } = await f.connect();
    f.upstream.onEvent({ type: "transcript", role: "user", id: "utterance-one", text: "查一下产品资料，写成报表。", final: true });
    await vi.waitFor(async () => expect((await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.some((entry) =>
      VoiceTranscriptEntry.is(entry) && entry.data.callId === descriptor.id)).toBe(true), { timeout: 10_000 });
    expect((await f.hub.getTopicView("root")).messages.some((message) => message.voiceCallId === descriptor.id)).toBe(false);
    expect(f.answer).not.toHaveBeenCalled();
    await f.upstream.onDelegate({ id: "delegation-one", text: "查一下产品资料，写成报表。" });
    await vi.waitFor(() => expect(f.answer).toHaveBeenCalled(), { timeout: 10_000 });
    await vi.waitFor(() => expect(f.connection.sendNotification).toHaveBeenCalledWith(expect.stringContaining("任务已在当前会话处理。"), true), { timeout: 10_000 });
    const view = await f.hub.getTopicView("root");
    expect(view.messages.filter((message) => message.role === "user")).toHaveLength(0);
    expect(JSON.stringify(f.answer.mock.calls)).toContain("kulo_dispatch");
    expect(JSON.stringify(f.answer.mock.calls)).toContain("查一下产品资料，写成报表。");
    await f.hub.voiceCalls.end(descriptor.id, "local");
    expect(f.connection.close).toHaveBeenCalledOnce();
  });

  it("starts Live with Kulo's approved identity, user relationship and hidden prior speech", async () => {
    const f = await fixture();
    const identity = await f.hub.personality.readIdentity();
    await f.hub.identityFiles.save({ file: "identity-agreement.md", expected: identity.version, content: "你是 Kulo，用户的耐心同伴。风格：直接、自然。", summary: "用户确认身份", dualSignConfirmed: true });
    const relationship = await f.hub.identityFiles.read("relationship.md");
    await f.hub.updateRelationship({ expected: relationship.version, content: "称呼用户小林。用户正在设计一个灯光项目。", summary: "用户提供背景" });
    await f.hub.personality.proposeIdentity("尚未确认的人设不应进入通话", "待审阅的人设建议");
    await f.hub.rootConversation.submit({ type: "write", entry: { kind: VoiceTranscriptEntry.kind,
      data: { callId: "previous-call", role: "user", text: "我们刚才在讨论客厅的灯光。", createdAt: Date.now() },
      model: [{ role: "user", content: "[KULO_VOICE_CONTEXT: 用户在通话中说]\n我们刚才在讨论客厅的灯光。", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    await f.enableCall(); await f.connect();
    expect(f.upstream.instructions).toContain("用户的耐心同伴");
    expect(f.upstream.instructions).toContain("称呼用户小林");
    expect(f.upstream.instructions).not.toContain("尚未确认的人设");
    expect(f.upstream.history).toContainEqual({ role: "user", text: "我们刚才在讨论客厅的灯光。" });
    expect((await f.hub.getTopicView("root")).messages.some((message) => message.text.includes("客厅的灯光"))).toBe(false);
    expect(f.answer).not.toHaveBeenCalled();
  });

  it("does not announce an old Router failure when a new call passively stores speech", async () => {
    const f = await fixture();
    f.answer.mockImplementationOnce(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture model unavailable" }));
    await f.hub.sendUserMessage("连接验证", { topicId: "root", requestId: "old-router-error" });
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).live.runFailure).toBeDefined(), { timeout: 10_000 });
    await f.enableCall(); const { descriptor } = await f.connect();
    f.upstream.onEvent({ type: "transcript", role: "user", id: "new-call-utterance", text: "你好，我们继续聊。", final: true });
    await vi.waitFor(async () => expect((await f.hub.rootConversation.context(BACKGROUND_CONTEXT)).entries.some((entry) =>
      VoiceTranscriptEntry.is(entry) && entry.data.callId === descriptor.id)).toBe(true), { timeout: 10_000 });
    expect(f.connection.sendNotification).not.toHaveBeenCalled();
  });

  it("protects voice routes, does not expose credentials, and rejects management tokens as provider keys", async () => {
    const f = await fixture();
    expect((await f.request("/api/voice", "GET", undefined, "")).status).toBe(401);
    const input = { expectedRevision: 0, call: { enabled: true, provider: "vertex", modelId: "gemini-3.8-live", voice: "Kore", apiKey: admin } };
    expect((await f.request("/api/voice", "PUT", input)).status).toBe(400);
    await f.enableCall();
    const snapshot = await f.request("/api/voice");
    expect(await snapshot.text()).not.toContain("synthetic-official-voice-key");
    const pending = await f.request("/api/voice/calls", "POST", { topicId: "root", clientId: "browser", commandId: "not-attached" });
    const descriptor = await pending.json() as VoiceCallSession;
    expect(f.openLive).not.toHaveBeenCalled();
    expect((await f.request(`/api/voice/calls/${descriptor.id}`, "DELETE")).status).toBe(200);
  });

  it.each(["remove", "disable"])("closes a paired device's upstream voice connection on %s", async (action) => {
    const f = await fixture();
    expect((await f.request("/api/devices", "PATCH", { enabled: true })).status).toBe(200);
    const invitationResponse = await f.request("/api/devices/invitations", "POST", { name: "语音测试设备", hubUrl: f.server.url.replace("127.0.0.1", "10.23.0.7") });
    expect(invitationResponse.status, (await invitationResponse.clone().json() as { error?: string }).error).toBe(201);
    const invitation = await invitationResponse.json() as DeviceInvitation;
    const inviteToken = /'([A-Za-z0-9_-]+)'$/.exec(invitation.command)?.[1];
    expect(inviteToken).toBeTruthy();
    const paired = await (await f.request("/api/devices/pair", "POST", { inviteToken, info: collectDeviceSystemInfo() }, "")).json() as DevicePeerConfig;
    await f.enableCall(); await f.connect(paired.clientToken);
    const response = action === "remove" ? await f.request(`/api/devices/${paired.deviceId}`, "DELETE") : await f.request("/api/devices", "PATCH", { enabled: false });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(f.connection.close).toHaveBeenCalledOnce());
  });
});
