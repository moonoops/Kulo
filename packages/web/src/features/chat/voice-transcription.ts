import { mocoRest } from "../../moco-api";
import { translate as t } from "../../moco-i18n";
import { voiceApi } from "../voice/voice-api";
import type { VoiceRecording, VoiceTranscribeOptions } from "./voice-recorder";

export async function transcribeVoiceRecording(
  recording: VoiceRecording,
  target: { topicId?: string; clientId: string },
  options: VoiceTranscribeOptions,
): Promise<string> {
  options.signal.throwIfAborted();
  const asset = await mocoRest.uploadFile(recording.file, recording.file.name, {
    signal: options.signal,
    onProgress: options.onProgress,
    idempotencyKey: recording.id,
  });
  options.signal.throwIfAborted();
  const { transcript } = await voiceApi.transcribe({ assetId: asset.id, ...target }, options.signal);
  options.signal.throwIfAborted();
  if (transcript?.status === "failed") throw new Error(transcript.error || t("语音转写失败，请重试", "Voice transcription failed. Try again"));
  const text = transcript?.text.trim();
  if (!text || transcript.status === "processing") throw new Error(t("没有识别到文字，请重新录制", "No speech was recognized. Record again"));
  return text;
}
