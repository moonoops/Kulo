import type { ChatAttachment, ClientToHubMessage } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";
import type { VoiceRecording } from "./voice-recorder";

export interface VoiceDeliveryTarget {
  topicId: string;
  ticketId?: string;
  ticketTitle?: string;
  ticketClosed?: boolean;
}

export interface VoiceUploadOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  presentation: "voice";
  recordedDuration: number;
  idempotencyKey: string;
}

export interface VoiceDeliveryOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  onAccepted?: (destination: { topicId: string; ticketId?: string }) => void;
}

type VoiceMessage = Extract<ClientToHubMessage, { type: "chat.send" | "ticket.steer" }>;

interface RecordingMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  duration: number;
}

interface DeliveryRecord {
  target: Readonly<VoiceDeliveryTarget>;
  source: RecordingMetadata;
  uploadId: string;
  requestId: string;
  commandId: string;
  asset?: ChatAttachment;
  message?: VoiceMessage;
  accepted: boolean;
  pending?: Promise<ChatAttachment>;
  controller?: AbortController;
}

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function cancelled(): DOMException {
  return new DOMException(t("语音发送已取消", "Voice message sending cancelled"), "AbortError");
}

function metadata(recording: VoiceRecording): RecordingMetadata {
  return {
    name: recording.file.name,
    size: recording.file.size,
    type: recording.file.type,
    lastModified: recording.file.lastModified,
    duration: recording.duration,
  };
}

function validateRecording(recording: VoiceRecording): void {
  if (!recording.id?.trim()) throw new Error(t("录音标识无效，请重新录制", "Invalid recording ID. Record again"));
  if (!recording.file.size) throw new Error(t("录音为空，请重新录制", "The recording is empty. Record again"));
  if (!recording.file.type.toLowerCase().startsWith("audio/")) throw new Error(t("录音不是音频文件，请重新录制", "The recording is not an audio file. Record again"));
  if (!Number.isFinite(recording.duration) || recording.duration < 0) throw new Error(t("录音时长无效，请重新录制", "Invalid recording duration. Record again"));
}

function sameRecording(first: RecordingMetadata, next: RecordingMetadata): boolean {
  return first.name === next.name && first.size === next.size && first.type === next.type &&
    first.lastModified === next.lastModified && first.duration === next.duration;
}

function voiceAsset(asset: ChatAttachment): ChatAttachment {
  if (asset?.kind !== "audio" || typeof asset.mimeType !== "string" || !asset.mimeType.toLowerCase().startsWith("audio/") || asset.presentation !== "voice") {
    throw new Error(t("中枢尚未支持语音消息，请重启中枢后重试", "Voice messages are not available. Restart the Hub and try again"));
  }
  return { ...asset };
}

function deliveryMessage(record: DeliveryRecord, asset: ChatAttachment, ticketClosed = record.target.ticketClosed): VoiceMessage {
  const { target, requestId, commandId } = record;
  if (target.ticketId && !ticketClosed) {
    const message: Extract<ClientToHubMessage, { type: "ticket.steer" }> = {
      type: "ticket.steer",
      ticketId: target.ticketId,
      text: "",
      attachments: [asset],
      commandId,
    };
    return message;
  }
  return {
    type: "chat.send",
    topicId: target.topicId,
    content: target.ticketId ? `关于任务「${target.ticketTitle?.trim() || target.ticketId}」：` : "",
    attachments: [asset],
    requestId,
  };
}

/** One recording keeps the same destination and operation IDs until explicitly discarded. */
export function createVoiceDelivery(dependencies: {
  upload: (file: File, name: string | undefined, options: VoiceUploadOptions) => Promise<ChatAttachment>;
  send: (message: ClientToHubMessage) => Promise<unknown>;
  isTicketClosed?: (ticketId: string) => boolean | undefined;
}) {
  const records = new Map<string, DeliveryRecord>();

  function send(recording: VoiceRecording, target: VoiceDeliveryTarget, options: VoiceDeliveryOptions = {}): Promise<ChatAttachment> {
    let record = records.get(recording.id);
    try {
      validateRecording(recording);
      if (record && !sameRecording(record.source, metadata(recording))) throw new Error(t("录音标识已用于其他内容，请重新录制", "This recording ID is already used for other content. Record again"));
      if (record?.accepted && record.asset) return Promise.resolve(record.asset);
      if (options.signal?.aborted) return Promise.reject(cancelled());
      if (record?.pending) return record.pending;
      if (!record) {
        if (!target.topicId.trim()) throw new Error(t("语音所属话题无效，请重新录制", "The voice message topic is invalid. Record again"));
        record = {
          target: Object.freeze({ topicId: target.topicId, ticketId: target.ticketId, ticketTitle: target.ticketTitle, ticketClosed: target.ticketClosed }),
          source: metadata(recording),
          uploadId: newId("voice-upload"),
          requestId: newId("voice-request"),
          commandId: newId("voice-command"),
          accepted: false,
        };
        records.set(recording.id, record);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const entry = record;
    const controller = new AbortController();
    entry.controller = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const assertActive = () => {
      if (controller.signal.aborted || records.get(recording.id) !== entry) throw cancelled();
    };
    const operation = async (): Promise<ChatAttachment> => {
      assertActive();
      if (!entry.asset) {
        const uploaded = await dependencies.upload(recording.file, recording.file.name, {
          signal: controller.signal,
          onProgress: options.onProgress,
          presentation: "voice",
          recordedDuration: recording.duration,
          idempotencyKey: entry.uploadId,
        });
        assertActive();
        entry.asset = voiceAsset(uploaded);
      }
      assertActive();
      if (!entry.message) {
        const closed = entry.target.ticketId ? dependencies.isTicketClosed?.(entry.target.ticketId) : undefined;
        entry.message = deliveryMessage(entry, entry.asset, closed ?? entry.target.ticketClosed);
      }
      try {
        await dependencies.send(entry.message);
      } catch (error) {
        if (entry.message.type !== "ticket.steer" || !error || typeof error !== "object" || !("code" in error) || error.code !== "ticket_stopped") throw error;
        // This explicit rejection proves the steer was not accepted; unknown ACKs keep their envelope.
        entry.message = deliveryMessage(entry, entry.asset, true);
        assertActive();
        await dependencies.send(entry.message);
      }
      // Acknowledgment confirms acceptance even if the UI was cancelled after transmission.
      entry.accepted = true;
      options.onAccepted?.(entry.message.type === "ticket.steer"
        ? { topicId: entry.target.topicId, ticketId: entry.message.ticketId }
        : { topicId: entry.message.topicId ?? entry.target.topicId });
      return entry.asset;
    };
    entry.pending = operation().finally(() => {
      options.signal?.removeEventListener("abort", abort);
      entry.pending = undefined;
      entry.controller = undefined;
    });
    return entry.pending;
  }

  function forget(id: string): void {
    const record = records.get(id);
    records.delete(id);
    record?.controller?.abort();
  }

  function clear(): void {
    for (const record of records.values()) record.controller?.abort();
    records.clear();
  }

  return { send, forget, clear };
}
