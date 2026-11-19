import { createHash } from "node:crypto";
import { defineDocFamily, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import type { ChatReplyReference, ClientToHubMessage } from "@kulo/protocol";

export type ReliableClientMessage = Extract<ClientToHubMessage, {
  type: "chat.send" | "chat.abort" | "chat.retry" | "ticket.steer" | "ticket.retry" | "ticket.stop" | "ticket.close" | "schedule.stop" | "schedule.delete";
}>;

export interface DeliveryAck {
  topicId?: string;
  ticketId?: string;
  submissionId?: number;
  delivery?: "queued" | "accepted";
}

export interface DeliveryIntent {
  id: string;
  key: string;
  fingerprint: string;
  action: ReliableClientMessage["type"];
  topicId?: string;
  legacyKey: string;
  legacyFingerprint: string;
  replayed?: boolean;
}

export type DeliveryReceiptIdentity = Pick<DeliveryIntent, "key" | "fingerprint" | "action">;

export type DeliveryReceipt = JsonObject & {
  fingerprint: string;
  action: string;
  phase: "empty" | "admitted" | "complete";
  ack: JsonObject;
  continuation: JsonObject;
};

// A separate document per request keeps durable deduplication independent of the bounded UI command cache.
export const DeliveryReceiptDoc = defineDocFamily<DeliveryReceipt, JsonObject>({
  kind: "kulo.delivery.receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ fingerprint: String(seed.fingerprint), action: String(seed.action), phase: "empty", ack: {}, continuation: {} }),
  checkpointWhen: () => true,
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function clientDeliveryIntent(message: ReliableClientMessage, principalId = "local"): DeliveryIntent | undefined {
  const rawId = "commandId" in message ? message.commandId : "requestId" in message ? message.requestId : undefined;
  if (rawId !== undefined && typeof rawId !== "string") throw Object.assign(new Error("消息标识无效。"), { code: "invalid_message", status: 400 });
  const id = rawId?.trim();
  if (!id) return undefined;
  if (id.length > 256 || /[\u0000-\u001f]/.test(id)) throw Object.assign(new Error("消息标识无效。"), { code: "invalid_message", status: 400 });
  const { requestId: _requestId, commandId: _commandId, ...payload } = message as unknown as Record<string, unknown>;
  if (message.type === "chat.send") {
    payload.topicId = message.topicId || "root";
    payload.whenBusy = message.whenBusy ?? "steer";
    payload.attachments = message.attachments ?? [];
  }
  if (message.type === "chat.abort" || message.type === "chat.retry") payload.topicId = message.topicId || "root";
  if (message.type === "ticket.steer") payload.attachments = message.attachments ?? [];
  return {
    id,
    key: deliveryReceiptKey(id),
    fingerprint: createHash("sha256").update(canonical({ principalId, payload })).digest("hex"),
    action: message.type,
    ...(message.type === "chat.send" || message.type === "chat.abort" || message.type === "chat.retry" ? { topicId: message.topicId || "root" } : {}),
    legacyKey: createHash("sha256").update(JSON.stringify([principalId, id])).digest("hex"),
    legacyFingerprint: createHash("sha256").update(canonical(payload)).digest("hex"),
  };
}

export function deliveryReceiptKey(id: string): string {
  return createHash("sha256").update(JSON.stringify(["kulo.delivery", 2, id])).digest("hex");
}

export function sameDeliveryValue(first: unknown, second: unknown): boolean {
  if (first === undefined || second === undefined) return first === second;
  return canonical(first) === canonical(second);
}

export function legacyDeliveryConflict(): never {
  throw Object.assign(new Error("旧请求与本次内容不一致或缺少可核验信息，请核对记录后重新操作。"), { code: "request_intent_conflict", status: 409 });
}

export function assertValidReplyReference(value: unknown): asserts value is ChatReplyReference | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("回复引用无效。"), { code: "invalid_message", status: 400 });
  }
  const reply = value as Record<string, unknown>;
  if (!Number.isSafeInteger(reply.messageId) || typeof reply.role !== "string" || !["user", "assistant", "dispatch"].includes(reply.role) ||
      typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 8000) {
    throw Object.assign(new Error("回复引用无效。"), { code: "invalid_message", status: 400 });
  }
}

export function validateReliableClientMessage(message: ReliableClientMessage): void {
  const invalid = () => { throw Object.assign(new Error("消息内容或操作参数无效。"), { code: "invalid_message", status: 400 }); };
  const identifier = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
  if ("topicId" in message && message.topicId !== undefined && !identifier(message.topicId)) invalid();
  if ("ticketId" in message && !identifier(message.ticketId)) invalid();
  if ("attachments" in message && message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > 16)) invalid();
  if (message.type === "chat.send" || message.type === "ticket.steer") assertValidReplyReference(message.replyTo);
  switch (message.type) {
    case "chat.send":
      if (typeof message.content !== "string" || message.whenBusy !== undefined && !["steer", "followUp"].includes(message.whenBusy)) invalid();
      break;
    case "ticket.steer":
      if (typeof message.text !== "string") invalid();
      break;
    case "ticket.stop":
      if (message.reason !== undefined && typeof message.reason !== "string") invalid();
      break;
    case "ticket.close":
      if (!["obsolete", "superseded"].includes(message.kind) || typeof message.reason !== "string" ||
        message.replacementTicketId !== undefined && !identifier(message.replacementTicketId)) invalid();
      break;
  }
}

export function assertDeliveryIntent(receipt: Readonly<DeliveryReceipt> | undefined, intent: DeliveryReceiptIdentity): void {
  if (receipt && (receipt.fingerprint !== intent.fingerprint || receipt.action !== intent.action)) {
    throw Object.assign(new Error("同一消息标识不能用于不同的发送身份、内容、附件、目标或操作。"), { code: "request_intent_conflict", status: 409 });
  }
}

export async function writeDeliveryReceipt(tx: Tx, intent: DeliveryReceiptIdentity | undefined, ack: DeliveryAck,
  phase: "admitted" | "complete" = "complete", continuation: JsonObject = {}): Promise<void> {
  if (!intent) return;
  const receipt = await tx.doc(DeliveryReceiptDoc, intent.key, { fingerprint: intent.fingerprint, action: intent.action });
  assertDeliveryIntent(receipt, intent);
  receipt.phase = phase;
  receipt.ack = { ...ack } as JsonObject;
  receipt.continuation = continuation;
}
