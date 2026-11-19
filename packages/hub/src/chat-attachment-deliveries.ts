import { createHash } from "node:crypto";
import { defineDoc, type EntryRecord, type Harness, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { AgentDispatchIntent, ChatAttachment, ChatReplyReference } from "@moco/protocol";
import { clientDeliveryIntent, DeliveryReceiptDoc, deliveryReceiptKey, writeDeliveryReceipt, type DeliveryReceiptIdentity } from "./delivery-receipts.js";
import { ProjectError } from "./projects.js";
import { isActiveSettingsConversation, SettingsAssistantDoc, type SettingsAssistantState } from "./settings-doc.js";
import { MocoStateDoc, type MocoDurableState } from "./state.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import { MocoUserEntry } from "./ui-cards.js";
import { UploadError, type MocoUploadStore } from "./uploads.js";
import type { ChatMessageSource } from "./chat-submissions.js";

export interface ChatDeliveryDraft {
  topicId: string;
  conversationId: number;
  targetDeviceId: string;
  content: string;
  attachmentIds: string[];
  sourceScopes?: Record<string, string[]>;
  principalId: string;
  source?: ChatMessageSource;
  requestId?: string;
  receivedAt: number;
  whenBusy: "steer" | "followUp";
  replyTo?: ChatReplyReference;
  agentDispatchIntent?: AgentDispatchIntent;
  voiceDelegation?: boolean;
  receipt?: DeliveryReceiptIdentity;
}

// Only admitted attachment messages live here. Binary content remains in the upload store.
export const PendingChatAttachmentsDoc = defineDoc<{ messages: Record<string, ChatDeliveryDraft> } & JsonObject>({
  kind: "moco.pending-chat-attachments",
  version: 1,
  scope: "session",
  initial: () => ({ messages: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export const ChatAttachmentGrantsDoc = defineDoc<{ byAsset: Record<string, string[]> } & JsonObject>({
  kind: "moco.chat-attachment-grants",
  version: 1,
  scope: "session",
  initial: () => ({ byAsset: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export async function observeChatAttachmentGrants(harness: Harness, uploads: MocoUploadStore, context: Context): Promise<void> {
  await harness.commit(async tx => { await tx.doc(ChatAttachmentGrantsDoc); }, context);
  let advanced = false;
  const observation = await harness.observeDoc(ChatAttachmentGrantsDoc, {
    advance(call) {
      if (call.kind !== "value") return;
      advanced = true;
      uploads.setCommittedChatScopes(call.value.byAsset);
    },
    end() { advanced = true; uploads.setCommittedChatScopes({}); },
  }, context);
  if (!observation) throw new Error("Chat attachment grants are unavailable");
  if (!advanced) uploads.setCommittedChatScopes(observation.value.byAsset);
}

export function assertChatDestination(state: Readonly<MocoDurableState>, draft: Pick<ChatDeliveryDraft, "topicId" | "conversationId">): void {
  const topic = state.topics?.[draft.topicId];
  if (!topic || topic.deletedAt !== undefined || topic.conversationId !== draft.conversationId) {
    throw new ProjectError(404, "topic_deleted", "会话已删除。");
  }
}

export function chatRequestTargetKey(conversationId: number, requestKey: string): string {
  return createHash("sha256").update(`${conversationId}:${requestKey}`).digest("hex");
}

function chatUploadScope(state?: Readonly<MocoDurableState>, settings?: Readonly<SettingsAssistantState>): (scope: string) => boolean {
  return scope => {
    const match = /^conversation:(\d+)$/.exec(scope);
    if (!match) return false;
    const id = Number(match[1]);
    return Object.values(state?.topics ?? {}).some(topic => topic.deletedAt === undefined && topic.conversationId === id)
      || isActiveSettingsConversation(id, settings);
  };
}

export async function snapshotChatUploadScope(harness: Harness, context: Context) {
  const [state, settings] = await Promise.all([harness.snapshot(MocoStateDoc, context), harness.snapshot(SettingsAssistantDoc, context)]);
  return chatUploadScope(state, settings);
}

export async function bindChatAttachments(tx: Tx, uploads: MocoUploadStore, destination: Pick<ChatDeliveryDraft, "topicId" | "conversationId">,
  attachments: Array<string | Pick<ChatAttachment, "id">>, principalId: string, sourceScopes?: ChatDeliveryDraft["sourceScopes"]): Promise<void> {
  const state = await tx.doc(MocoStateDoc);
  assertChatDestination(state, destination);
  const canRead = chatUploadScope(state, await tx.doc(SettingsAssistantDoc));
  // The sender must still be able to read a forwarded file from a source authorized at admission.
  for (const [id, original] of Object.entries(sourceScopes ?? {})) {
    if (!uploads.canReadUpload(id, principalId, scope => original.includes(scope) && canRead(scope))) {
      throw new ProjectError(403, "attachment_forbidden", "无权引用此附件。");
    }
  }
  const eligible = uploads.attachmentsForBinding(attachments, principalId, canRead);
  const scope = `conversation:${destination.conversationId}`;
  const grants = await tx.doc(ChatAttachmentGrantsDoc);
  for (const { record } of eligible) {
    if (record.referenceScopes?.includes(scope)) continue;
    const scopes = grants.byAsset[record.id] ?? [];
    if (!scopes.includes(scope)) grants.byAsset[record.id] = [...scopes, scope];
  }
  if (eligible.length > 0) {
    await injectEventToolsInTx(tx, destination.conversationId, ["moco_inspect_asset", "moco_publish_asset"]);
  }
}

export async function stageChatAttachments(harness: Harness, uploads: MocoUploadStore, key: string, draft: ChatDeliveryDraft, context: Context): Promise<ChatDeliveryDraft> {
  return harness.commit(async tx => {
    const state = await tx.doc(MocoStateDoc);
    assertChatDestination(state, draft);
    if ((state.topics?.[draft.topicId]?.targetDeviceId ?? "") !== draft.targetDeviceId) throw new ProjectError(409, "target_device_busy", "目标设备已变更，请重试发送。");
    const canRead = chatUploadScope(state, await tx.doc(SettingsAssistantDoc));
    const sourceScopes: Record<string, string[]> = {};
    for (const id of draft.attachmentIds) {
      const record = uploads.getUpload(id)?.record;
      if (!record) throw new UploadError("附件不存在", 404);
      if (record.ownerId === undefined || record.ownerId === draft.principalId) continue;
      const sources = record.referenceScopes?.filter(canRead);
      if (!sources?.length) throw new ProjectError(403, "attachment_forbidden", "无权引用此附件。");
      sourceScopes[id] = sources;
    }
    const admitted = { ...draft, sourceScopes };
    const pending = await tx.doc(PendingChatAttachmentsDoc);
    pending.messages[key] = JSON.parse(JSON.stringify(admitted)) as ChatDeliveryDraft;
    await writeDeliveryReceipt(tx, draft.receipt, { topicId: draft.topicId }, "admitted");
    return admitted;
  }, context);
}

export async function removePendingChatAttachments(tx: Tx, key: string): Promise<void> {
  const pending = await tx.doc(PendingChatAttachmentsDoc);
  delete pending.messages[key];
}

function originalChatSender(message: { topicId: string; requestId: string; content: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference },
  owners: ReadonlySet<string>, targetDeviceId: string | undefined, fingerprint: string): string | undefined {
  for (const owner of owners) {
    for (const target of new Set([undefined, targetDeviceId])) {
      for (const whenBusy of ["steer", "followUp"] as const) {
        const intent = clientDeliveryIntent({ type: "chat.send", ...message, targetDeviceId: target, whenBusy }, owner);
        if (intent?.fingerprint === fingerprint) return owner;
      }
    }
  }
}

// Older receipts contain only the fingerprint. Recover a private grant only when the
// original submission, visible topic and exact sender/payload can all be verified.
export async function repairHistoricalChatAttachments(harness: Harness, uploads: MocoUploadStore, entries: readonly EntryRecord[],
  conversationId: number, context: Context): Promise<void> {
  const scope = `conversation:${conversationId}`;
  for (const entry of entries) {
    if (!MocoUserEntry.is(entry) || Number(entry.conversationId) !== conversationId || entry.data?.mocoContentVersion !== 1) continue;
    const { attachments, requestId, text, replyTo } = entry.data;
    if (typeof requestId !== "string" || !requestId || requestId.length > 256 || /[\u0000-\u001f]/.test(requestId) ||
        typeof text !== "string" || !Array.isArray(attachments) || !attachments.length || attachments.length > 16 ||
        attachments.some(asset => !asset || typeof asset.id !== "string")) continue;
    const records = attachments.map(asset => uploads.getUpload(asset.id)?.record);
    if (records.some(record => !record) || !records.some(record => record?.ownerId && !record.referenceScopes?.includes(scope))) continue;
    const key = deliveryReceiptKey(requestId);
    const receipt = await harness.snapshot(DeliveryReceiptDoc, key, context);
    if (receipt?.action !== "chat.send" || receipt.phase !== "complete" || receipt.continuation.attachmentsBound ||
        typeof receipt.ack.topicId !== "string") continue;
    const topicId = receipt.ack.topicId;
    await harness.commit(async tx => {
      const state = await tx.doc(MocoStateDoc);
      const topic = state.topics?.[topicId];
      if (!topic || topic.deletedAt !== undefined || topic.conversationId !== conversationId) return;
      const native = await tx.submissionByRequest(entry.conversationId, requestId);
      if (!native || native.type !== "input" || native.id !== receipt.ack.submissionId) return;
      // Unplaced entries supplied by queuedChatEntries use the negative native submission ID.
      if ((native.entry ?? (native.status === "queued" ? -Number(native.id) : undefined)) !== entry.id) return;
      const targetKey = chatRequestTargetKey(conversationId, `req:${topicId}:${requestId}`);
      const owners = new Set(["local", ...records.flatMap(record => record?.ownerId ? [record.ownerId] : [])]);
      const owner = originalChatSender({ topicId, requestId, content: text, attachments, replyTo }, owners, state.chatRequestTargets?.[targetKey], receipt.fingerprint);
      if (!owner) return;
      const canRead = chatUploadScope(state, await tx.doc(SettingsAssistantDoc));
      if (attachments.some(asset => !uploads.canReadUpload(asset.id, owner, canRead))) return;
      await bindChatAttachments(tx, uploads, { topicId, conversationId }, attachments, owner);
      const current = await tx.doc(DeliveryReceiptDoc, key, {});
      current.continuation.attachmentsBound = true;
    }, context);
  }
}
