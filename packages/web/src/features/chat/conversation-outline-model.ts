import { translate as tr } from "../../kulo-i18n";
import { getMessageParts, type ChatDisplayItem } from "@kulo/protocol";

export interface ConversationTurn {
  id: number;
  label: string;
  preview: string;
}

export const TURN_SCROLL_PADDING = 24;

export function isConversationTurn(item: ChatDisplayItem): boolean {
  return item.role === "user" &&
    !item.text.startsWith("[KULO_WORKER_RELAY]") &&
    !item.text.startsWith("[KULO_WORKER_WATCHDOG]");
}

function plainText(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function messagePreview(item: ChatDisplayItem): string {
  const parts = getMessageParts(item);
  const text = parts.flatMap((part) => {
    if (part.type === "markdown") return [part.text];
    if (part.type === "code") return [part.code];
    if (part.type === "ui") return [part.fallbackText];
    if (part.type === "device-invitation") return [tr(`邀请设备加入 ${part.hubName}`, `Invite a device to ${part.hubName}`)];
    return part.caption ? [part.caption] : [];
  }).join("\n");
  if (text.trim()) return plainText(text);
  return parts.flatMap((part) => {
    switch (part.type) {
      case "image": return [part.asset?.name || tr("图片", "Image")];
      case "audio": return [part.asset?.name || tr("语音", "Voice")];
      case "video": return [part.asset?.name || tr("视频", "Video")];
      case "file": return [part.asset?.name || tr("文件", "File")];
      default: return [];
    }
  }).join(" · ");
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

export function buildConversationTurns(messages: ChatDisplayItem[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const item of messages) {
    if (isConversationTurn(item)) {
      turns.push({ id: item.id, label: truncate(messagePreview(item), 64) || tr("消息", "Message"), preview: "" });
    } else if (item.role === "assistant") {
      const turn = turns.at(-1);
      if (turn && !turn.preview) turn.preview = truncate(messagePreview(item), 180);
    }
  }
  return turns;
}

export function conversationTurnId(topicId: string, messageId: number): string {
  return `kulo-chat-turn-${encodeURIComponent(topicId)}-${messageId}`;
}

export function activeConversationTurn(
  anchors: Array<{ id: number; top: number }>,
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
): number | undefined {
  if (!anchors.length) return undefined;
  if (scrollHeight - scrollTop - viewportHeight <= 2) return anchors.at(-1)!.id;
  const readingLine = scrollTop + TURN_SCROLL_PADDING + 1;
  let active = anchors[0]!.id;
  for (const anchor of anchors) {
    if (anchor.top > readingLine) break;
    active = anchor.id;
  }
  return active;
}
