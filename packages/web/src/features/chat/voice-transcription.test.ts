import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { voiceApi } from "../voice/voice-api";
import { transcribeVoiceRecording } from "./voice-transcription";
import type { VoiceRecording } from "./voice-recorder";

vi.mock("../../moco-api", () => ({ mocoRest: { uploadFile: vi.fn() } }));
vi.mock("../voice/voice-api", () => ({ voiceApi: { transcribe: vi.fn() } }));
const recording: VoiceRecording = { id: "recording-one", file: new File(["audio"], "语音输入.webm", { type: "audio/webm" }), duration: 5 };
const asset: ChatAttachment = { id: "audio-one", name: recording.file.name, kind: "audio", mimeType: "audio/webm", size: 5, url: "/api/uploads/audio-one" };
const target = { topicId: "topic-a", clientId: "client-one" };
const options = () => ({ signal: new AbortController().signal, onProgress: vi.fn() });

beforeEach(() => {
  vi.mocked(mocoRest.uploadFile).mockReset().mockResolvedValue(asset);
  vi.mocked(voiceApi.transcribe).mockReset().mockResolvedValue({ transcript: { text: "转写的内容", status: "ready" } });
});

describe("voice draft transcription", () => {
  it("uploads audio and returns editable text without sending a chat message", async () => {
    const input = options();
    await expect(transcribeVoiceRecording(recording, target, input)).resolves.toBe("转写的内容");
    expect(mocoRest.uploadFile).toHaveBeenCalledWith(recording.file, recording.file.name, {
      signal: input.signal, onProgress: input.onProgress, idempotencyKey: recording.id,
    });
    expect(voiceApi.transcribe).toHaveBeenCalledWith({ assetId: asset.id, ...target }, input.signal);
  });

  it("transcribes before a temporary conversation has a persisted topic", async () => {
    const input = options();
    await expect(transcribeVoiceRecording(recording, { clientId: target.clientId }, input)).resolves.toBe("转写的内容");
    expect(voiceApi.transcribe).toHaveBeenCalledWith({ assetId: asset.id, clientId: target.clientId }, input.signal);
  });

  it("keeps the same upload identity when retrying a failed transcription", async () => {
    vi.mocked(voiceApi.transcribe).mockRejectedValueOnce(new Error("转写暂不可用"));
    await expect(transcribeVoiceRecording(recording, target, options())).rejects.toThrow("转写暂不可用");
    await expect(transcribeVoiceRecording(recording, target, options())).resolves.toBe("转写的内容");
    expect(vi.mocked(mocoRest.uploadFile).mock.calls.map((call) => call[2]?.idempotencyKey)).toEqual([recording.id, recording.id]);
  });

  it("does not start uploading a cancelled recording", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(transcribeVoiceRecording(recording, target, { ...options(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocoRest.uploadFile).not.toHaveBeenCalled();
  });

  it("does not transcribe after cancellation during upload", async () => {
    const controller = new AbortController();
    vi.mocked(mocoRest.uploadFile).mockImplementationOnce(async () => { controller.abort(); return asset; });
    await expect(transcribeVoiceRecording(recording, target, { ...options(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(voiceApi.transcribe).not.toHaveBeenCalled();
  });

  it("does not return text from a transcription cancelled before it finishes", async () => {
    const controller = new AbortController();
    vi.mocked(voiceApi.transcribe).mockImplementationOnce(async () => { controller.abort(); return { transcript: { text: "不应填入草稿", status: "ready" } }; });
    await expect(transcribeVoiceRecording(recording, target, { ...options(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["", "   \n "])("rejects empty recognition %j instead of silently completing", async (text) => {
    vi.mocked(voiceApi.transcribe).mockResolvedValueOnce({ transcript: { text, status: "ready" } });
    await expect(transcribeVoiceRecording(recording, target, options())).rejects.toThrow("没有识别到文字");
  });

  it("surfaces transcription failure without returning partial text", async () => {
    vi.mocked(voiceApi.transcribe).mockResolvedValueOnce({ transcript: { text: "不完整结果", status: "failed", error: "识别模型尚未就绪" } });
    await expect(transcribeVoiceRecording(recording, target, options())).rejects.toThrow("识别模型尚未就绪");
  });
});
