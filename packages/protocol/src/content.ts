import type { ChatAttachment, ChatDisplayItem } from "./domain.js";
import type { UiCardSnapshot } from "./genui.js";

export interface MediaTranscriptSegment {
  start: number;
  end?: number;
  text: string;
}

export interface MediaTranscript {
  text: string;
  segments?: MediaTranscriptSegment[];
  status?: "ready" | "processing" | "failed";
  error?: string;
}

export interface MediaCaptionTrack {
  url: string;
  label: string;
  language: string;
  assetId?: string;
}

export type MessagePart =
  | { partId: string; type: "markdown"; text: string }
  | { partId: string; type: "code"; code: string; language?: string; fileName?: string }
  | { partId: string; type: "device-invitation"; hubId: string; hubName: string }
  | {
      partId: string;
      type: "image" | "audio" | "video" | "file";
      assetId: string;
      asset?: ChatAttachment;
      caption?: string;
      fallbackText?: string;
    }
  | { partId: string; type: "ui"; cardId: string; fallbackText: string; card?: UiCardSnapshot };

export function attachmentMessagePart(attachment: ChatAttachment, messageId: string | number): MessagePart {
  return {
    partId: `${messageId}:asset:${attachment.id}`,
    type: attachment.kind,
    assetId: attachment.id,
    asset: attachment,
  };
}

/** Project older transcripts without changing their persisted Pi messages. */
export function getMessageParts(item: Pick<ChatDisplayItem, "id" | "role" | "text" | "attachments" | "parts">): MessagePart[] {
  if (item.parts) return item.parts;
  const text: MessagePart[] = item.text ? [{ partId: `${item.id}:text`, type: "markdown", text: item.text }] : [];
  const assets = (item.attachments ?? []).map((asset) => attachmentMessagePart(asset, item.id));
  return item.role === "user" ? [...assets, ...text] : [...text, ...assets];
}

export function messagePartFallback(part: MessagePart): string {
  switch (part.type) {
    case "markdown": return part.text;
    case "code": return `\`\`\`${part.language ?? ""}\n${part.code}\n\`\`\``;
    case "ui": return part.fallbackText;
    case "device-invitation": return `邀请设备加入 ${part.hubName}`;
    default: return part.fallbackText || part.caption || part.asset?.name || `[${part.type}]`;
  }
}
