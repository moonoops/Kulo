import { parseStandaloneDeviceInvitation, redactDeviceInvitationText, SENSITIVE_TEXT_REDACTION, type ChatReplyReference } from "@kulo/protocol";
import type { ReliableEnvelope, ReliableOutboxMetadata, ReliableOutboxRecord } from "./reliable-outbox";

export const legacyInvitationCode = "device_invitation_requires_paste";

export function redactChatInvitation(content: string, reply?: ChatReplyReference, rawUserText?: string, error?: string) {
  const tokens = new Set<string>();
  const collect = (value: string | undefined) => value === undefined ? undefined
    : redactDeviceInvitationText(value, (found) => { for (const token of found) tokens.add(token); });
  const safeContent = collect(content)!;
  const safeReply = collect(reply?.text);
  const safeRaw = collect(rawUserText);
  const safeError = collect(error);
  // A reply or a legacy backup can echo a bare credential found in another field of this message.
  const remembered = [...tokens].sort((a, b) => b.length - a.length);
  const patterns: RegExp[] = [];
  // The invitation parser only returns base64url tokens. Batch replacements in a large quoted transcript.
  for (let offset = 0; offset < remembered.length; offset += 256) patterns.push(new RegExp(remembered.slice(offset, offset + 256).join("|"), "g"));
  const hideEchoes = (value: string | undefined) => {
    if (value !== undefined) for (const pattern of patterns) value = value.replace(pattern, SENSITIVE_TEXT_REDACTION);
    return value;
  };
  const replyText = hideEchoes(safeReply);
  return {
    content: hideEchoes(safeContent)!,
    replyTo: reply && replyText !== undefined && reply.text !== replyText ? { ...reply, text: replyText } : reply,
    rawUserText: hideEchoes(safeRaw),
    error: hideEchoes(safeError),
  };
}

export function redactOutboxInvitation(envelope: ReliableEnvelope, metadata?: ReliableOutboxMetadata, error?: string) {
  if (envelope.type !== "chat.send" && envelope.type !== "ticket.steer") return { envelope, metadata, error };
  const content = envelope.type === "chat.send" ? envelope.content : envelope.text;
  const safe = redactChatInvitation(content, envelope.replyTo, metadata?.rawUserText, error);
  let nextEnvelope = envelope;
  if (safe.content !== content || safe.replyTo !== envelope.replyTo) {
    nextEnvelope = envelope.type === "chat.send" ? { ...envelope, content: safe.content, replyTo: safe.replyTo } : { ...envelope, text: safe.content, replyTo: safe.replyTo };
  }
  return { envelope: nextEnvelope, metadata: metadata && safe.rawUserText !== metadata.rawUserText ? { ...metadata, rawUserText: safe.rawUserText } : metadata, error: safe.error };
}

export function migrateOutboxInvitation(record: ReliableOutboxRecord): ReliableOutboxRecord {
  const { envelope, metadata, error } = redactOutboxInvitation(record.envelope, record.metadata, record.error);
  if (record.envelope === envelope && record.metadata === metadata && record.error === error) return record;
  if (record.state !== "accepted" && record.envelope.type === "chat.send" && !record.envelope.replyTo &&
    !record.envelope.attachments?.length && parseStandaloneDeviceInvitation(record.envelope.content)) {
    return { ...record, envelope, metadata, state: "failed", nextAttemptAt: 0, errorCode: legacyInvitationCode, error: "请在主 Kulo 重新复制并发送接入邀请。" };
  }
  return { ...record, envelope, metadata, error };
}
