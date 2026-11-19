import type { ChatDisplayItem, TicketRecord } from "@kulo/protocol";
import type { PendingSubmissionBackup } from "./chat-submissions";
import type { ReliableOutboxRecord } from "./reliable-outbox";

export function outboxSubmissions(records: readonly ReliableOutboxRecord[]): PendingSubmissionBackup[] {
  return records.flatMap((record): PendingSubmissionBackup[] => {
    const message = record.envelope;
    if (message.type !== "chat.send" && message.type !== "ticket.steer") return [];
    const topicId = message.type === "chat.send" ? message.topicId : record.metadata?.topicId ?? "root";
    return [{
      topicId,
      draftKey: record.metadata?.draftKey ?? (message.type === "chat.send" ? `topic:${topicId}` : `ticket:${message.ticketId}`),
      envelope: message.type === "chat.send" ? { ...message, whenBusy: "steer" } : message,
      rawUserText: record.metadata?.rawUserText ?? (message.type === "chat.send" ? message.content : message.text),
      draftAttachments: record.metadata?.draftAttachments ?? (message.attachments ?? []).map((attachment) => ({
        localId: `restored:${record.id}:${attachment.id}`, status: "ready", name: attachment.name,
        mimeType: attachment.mimeType, size: attachment.size, kind: attachment.kind, attachment,
      })),
      state: record.state === "queued" ? record.attempt ? "unconfirmed_disconnect" : "queued" : record.state,
      localMessageId: Number.MIN_SAFE_INTEGER + record.sequence,
      localSequence: record.sequence,
      outboxScope: record.scope,
      createdAt: record.createdAt,
      ...(record.error ? { error: record.error } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.ack?.submissionId ? { submissionId: record.ack.submissionId } : {}),
    }];
  });
}

export function consumedOutboxReceipts(records: readonly ReliableOutboxRecord[], messages: ChatDisplayItem[], topicId: string): string[] {
  const received = new Set(messages.filter((item) => item.role === "user" && item.requestId).map((item) => item.requestId));
  return records.filter((record) => record.state === "accepted" &&
    (record.envelope.type !== "chat.send" || record.envelope.topicId !== topicId || received.has(record.id))).map((record) => record.id);
}

export function consumePersistedDraft(drafts: Record<string, string>, key: string, original: string): Record<string, string> {
  const current = drafts[key] ?? "";
  if (current === original) return { ...drafts, [key]: "" };
  if (original && current.startsWith(original)) return { ...drafts, [key]: current.slice(original.length) };
  return drafts;
}

export function blockerDraftKey(ticket: TicketRecord): string {
  return `answer:${ticket.id}:${ticket.latestReport?.at ?? ticket.waiting?.since ?? ticket.createdAt}`;
}
