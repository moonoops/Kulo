import { redactDeviceInvitationText, type ChatDisplayItem, type ChatReplyReference } from "@kulo/protocol";

export type ReplyDrafts = Partial<Record<string, ChatReplyReference>>;

export function messageReply(
  item: ChatDisplayItem,
  text: string,
  options?: { excerpt?: boolean },
): ChatReplyReference | undefined {
  if (item.role !== "user" && item.role !== "assistant" && item.role !== "dispatch") return undefined;
  const snapshot = text.trim().slice(0, 8000);
  if (!snapshot) return undefined;
  return {
    messageId: item.id,
    role: item.role,
    text: snapshot,
    ...(options?.excerpt ? { excerpt: true } : {}),
  };
}

export function replyPreview(reply: ChatReplyReference): string {
  const text = redactDeviceInvitationText(reply.text).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

export function consumeReplyDraft(drafts: ReplyDrafts, key: string, sent: ChatReplyReference | undefined): ReplyDrafts {
  // A new reply chosen while the send is being saved belongs to the next message.
  if (!sent || drafts[key] !== sent) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}

export function restoreReplyDraft(drafts: ReplyDrafts, key: string, reply: ChatReplyReference | undefined): ReplyDrafts {
  return reply && !drafts[key] ? { ...drafts, [key]: reply } : drafts;
}
