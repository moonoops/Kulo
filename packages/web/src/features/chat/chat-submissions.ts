import type { ChatAttachment, ChatDisplayItem, ChatReplyReference } from "@kulo/protocol";
import { translate as t } from "../../kulo-i18n";
import type { DraftAttachment } from "../../kulo-composer";

export type SubmissionState = "queued" | "sending" | "accepted" | "unconfirmed_disconnect" | "failed";

export interface SubmissionBackupInput {
  topicId: string;
  draftKey: string;
  envelope:
    | { type: "chat.send"; topicId: string; content: string; attachments?: ChatAttachment[]; replyTo?: ChatReplyReference; requestId: string; whenBusy: "steer"; targetDeviceId?: string }
    | { type: "ticket.steer"; ticketId: string; text: string; attachments?: ChatAttachment[]; replyTo?: ChatReplyReference; decisionOptionId?: string; commandId: string };
  rawUserText: string;
  draftAttachments: DraftAttachment[];
  state: SubmissionState;
}

export interface PendingSubmissionBackup extends SubmissionBackupInput {
  localMessageId: number;
  createdAt: number;
  localSequence?: number;
  outboxScope?: string;
  error?: string;
  errorCode?: string;
  submissionId?: number;
}

export interface ChatViewItem extends ChatDisplayItem {
  clientSubmission?: { key: string; state: SubmissionState; error?: string; errorCode?: string };
}

let localMessageId = Number.MIN_SAFE_INTEGER;

export function submissionKey(submission: Pick<SubmissionBackupInput, "envelope">): string {
  return submission.envelope.type === "chat.send" ? submission.envelope.requestId : submission.envelope.commandId;
}

export function trackSubmission(input: SubmissionBackupInput | PendingSubmissionBackup, createdAt = Date.now()): PendingSubmissionBackup {
  return "localMessageId" in input
    ? { ...input, state: "sending", error: undefined }
    : { ...input, createdAt, localMessageId: localMessageId++ };
}

export function upsertSubmission(current: PendingSubmissionBackup[], next: PendingSubmissionBackup): PendingSubmissionBackup[] {
  const key = submissionKey(next);
  const index = current.findIndex((item) => submissionKey(item) === key);
  if (index < 0) return [...current, next];
  return current.map((item, position) => position === index ? { ...next, createdAt: item.createdAt, localMessageId: item.localMessageId } : item);
}

export function updateSubmission(current: PendingSubmissionBackup[], key: string, patch: Partial<PendingSubmissionBackup>): PendingSubmissionBackup[] {
  return current.some((item) => submissionKey(item) === key)
    ? current.map((item) => submissionKey(item) === key ? { ...item, ...patch } : item)
    : current;
}

export function removeSubmission(current: PendingSubmissionBackup[], key: string): PendingSubmissionBackup[] {
  return current.filter((item) => submissionKey(item) !== key);
}

export function acknowledgeSubmission(current: PendingSubmissionBackup[], key: string, activeTopicId: string, submissionId?: number): PendingSubmissionBackup[] {
  const submission = current.find((item) => submissionKey(item) === key);
  if (!submission) return current;
  if (submission.envelope.type !== "chat.send" || submission.topicId !== activeTopicId) return removeSubmission(current, key);
  return updateSubmission(current, key, { state: "accepted", submissionId, error: undefined });
}

function receivedSubmissions(messages: ChatDisplayItem[]) {
  const requestIds = new Set<string>();
  const submissionIds = new Set<number>();
  for (const item of messages) {
    if (item.role !== "user") continue;
    if (item.requestId) requestIds.add(item.requestId);
    if (validSubmissionId(item.submissionId)) submissionIds.add(item.submissionId);
  }
  return (item: PendingSubmissionBackup) => item.state !== "failed" && (requestIds.has(submissionKey(item)) ||
    validSubmissionId(item.submissionId) && submissionIds.has(item.submissionId));
}

function validSubmissionId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function reconcileSubmissions(current: PendingSubmissionBackup[], messages: ChatDisplayItem[], topicId: string): PendingSubmissionBackup[] {
  const received = receivedSubmissions(messages);
  const next = current.filter((item) => {
    if (item.envelope.type !== "chat.send") return true;
    // Confirmed offscreen messages belong to durable topic history, beyond the recent-message window too.
    if (item.topicId !== topicId) return item.state !== "accepted";
    return !received(item);
  });
  return next.length === current.length ? current : next;
}

export function mergeChatSubmissions(messages: ChatDisplayItem[], submissions: PendingSubmissionBackup[], topicId: string): ChatViewItem[] {
  const received = receivedSubmissions(messages);
  const pending = submissions.filter((item) => item.topicId === topicId && item.envelope.type === "chat.send" && !received(item))
    .sort((first, second) => first.localSequence !== undefined && second.localSequence !== undefined
      ? first.localSequence - second.localSequence : first.createdAt - second.createdAt);
  const merged: ChatViewItem[] = [...messages];
  let previousLocalIndex = -1;
  for (const item of pending) {
    const message: ChatViewItem = {
      id: item.localMessageId,
      requestId: submissionKey(item),
      ...(validSubmissionId(item.submissionId) ? { submissionId: item.submissionId } : {}),
      role: "user",
      text: item.rawUserText,
      createdAt: item.createdAt,
      ...(item.envelope.attachments?.length ? { attachments: item.envelope.attachments } : {}),
      ...(item.envelope.replyTo ? { replyTo: item.envelope.replyTo } : {}),
      clientSubmission: { key: submissionKey(item), state: item.state, ...(item.error ? { error: item.error } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}) },
    };
    // Preserve server order while keeping an older local send ahead of known later messages.
    const nextIndex = merged.findIndex((entry, index) => index > previousLocalIndex && !entry.clientSubmission && entry.createdAt !== undefined && entry.createdAt > item.createdAt);
    previousLocalIndex = nextIndex < 0 ? merged.length : nextIndex;
    merged.splice(previousLocalIndex, 0, message);
  }
  return merged;
}

export function splitChatTimeline(messages: ChatViewItem[]): { transcript: ChatViewItem[]; pending: ChatViewItem[] } {
  let pendingStart = messages.length;
  while (pendingStart > 0) {
    const item = messages[pendingStart - 1]!;
    if (item.role !== "user" || !item.delivery && !item.clientSubmission) break;
    pendingStart--;
  }
  return { transcript: messages.slice(0, pendingStart), pending: messages.slice(pendingStart) };
}

export function chatDeliveryLabel(item: ChatViewItem): string | undefined {
  const submission = item.clientSubmission;
  if (submission?.state === "queued") return t("待发送", "Waiting to send");
  if (submission?.state === "sending") return t("发送中", "Sending");
  if (submission?.state === "unconfirmed_disconnect") return t("待确认", "Awaiting confirmation");
  if (submission?.state === "failed") return t(`发送失败${submission.error ? `：${submission.error}` : ""}`, `Sending failed${submission.error ? `: ${submission.error}` : ""}`);
  if (item.delivery === "paused") return t("待继续", "Waiting to continue");
  if (item.delivery === "queued") return t("待处理", "Pending");
  return undefined;
}

/** History pages contain transcript entries; queued negative IDs must stay in the recent tail. */
export function mergeChatHistory(history: ChatDisplayItem[], recent: ChatDisplayItem[]): ChatDisplayItem[] {
  const messages = new Map<number, ChatDisplayItem>();
  for (const item of [...history, ...recent]) messages.set(item.id, item);
  return [...messages.values()];
}
