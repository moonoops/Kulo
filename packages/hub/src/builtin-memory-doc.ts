/**
 * Durable control-plane document and shared pure helpers for Built-in Memory.
 * Kept leaf-scoped so `memory-flush.ts`, `builtin-memory-recall.ts`, and `builtin-memory-service.ts`
 * can share the schema without circular imports.
 */
import {
  UserEntry,
  defineDoc,
  type ConversationId,
  type EntryRecord,
  type JsonObject,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  redactSensitiveText,
  type BuiltinMemoryCategory,
  type BuiltinMemoryDurability,
  type BuiltinMemoryEvidenceLevel,
  type BuiltinMemoryScopeKind,
  type BuiltinMemorySource,
  type MemoryBank,
} from "@kulo/protocol";
import { isSafeMemoryText } from "./hindsight.js";
import { matchesForgottenTerm } from "./memory-forget.js";
import { isLegacyInternalUserEntry, resolveActiveRootConversationId, type KuloDurableState } from "./state.js";
import { isSuspiciousMemoryInstruction, type WorkingMemoryRecord } from "./working-memory.js";
import type { BuiltinMemoryRetainInput } from "./builtin-memory-store.js";
import { KuloUserEntry } from "./ui-cards.js";

function stripInternalUserMetadata(text: string): string {
  return text
    .replace(/(?:\n\n|^)\[KULO_AGENT_ASSIGNMENT\]\n\{[^\n]*\}\nAuthoritative Agent assignment constraint[^\n]*$/, "")
    .replace(/(?:\n\n|^)\[KULO_MESSAGE_SOURCE\]\n\{[^\n]*\}(?=\n\n|$)/, "")
    .trim();
}

export class BuiltinMemoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BuiltinMemoryError";
  }
}

export interface BuiltinMemoryFloorCursor {
  cutoffEntryId: number;
  cutoffCharOffset?: number;
}

export interface BuiltinMemoryDeliveryItem {
  sourceId: string;
  bank: MemoryBank;
  scopeKind: BuiltinMemoryScopeKind;
  projectId?: string;
  topicId?: string;
  conversationId?: number;
  ticketId?: string;
  source: BuiltinMemorySource;
  sourceEntryId?: number;
  evidenceLevel: BuiltinMemoryEvidenceLevel;
  category: BuiltinMemoryCategory;
  status?: "active" | "resolved";
  durability?: BuiltinMemoryDurability;
  supersedesId?: string;
  content: string;
  clearEpoch: number;
  engineEpoch: number;
  createdAt: number;
}

export interface BuiltinMemoryPendingPurge {
  id: string;
  kind: "topic" | "project";
  targetId: string;
  conversationIds?: number[];
  createdAt: number;
}

export interface BuiltinMemoryDocState {
  enabled: boolean;
  userExplicitlyDisabled?: boolean;
  initializedWatermarks?: boolean;
  revision: number;
  clearTargetEpoch: number;
  engineEpoch: number;
  clearedAt: number | null;
  lastClearOp?: { operationId: string; targetEpoch: number; clearedAt: number };
  floorCursors: Record<string, BuiltinMemoryFloorCursor>;
  pendingDeliveries: Record<string, BuiltinMemoryDeliveryItem>;
  pendingPurges: BuiltinMemoryPendingPurge[];
}

export const BuiltinMemoryDoc = defineDoc<BuiltinMemoryDocState & JsonObject>({
  kind: "kulo.builtin-memory",
  version: 1,
  scope: "session",
  initial: () =>
    ({
      enabled: true,
      revision: 1,
      clearTargetEpoch: 0,
      engineEpoch: 1,
      clearedAt: null,
      floorCursors: {},
      pendingDeliveries: {},
      pendingPurges: [],
    }) as unknown as BuiltinMemoryDocState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export function extractRawUserQuery(entry: EntryRecord): string {
  if (KuloUserEntry.is(entry) && typeof entry.data?.text === "string") {
    return entry.data.text.trim();
  }
  const parts: string[] = [];
  for (const msg of entry.model ?? []) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
    }
  }
  const stripped = stripInternalUserMetadata(parts.join("\n"));
  return stripped
    .replace(/^\[(?:回复消息|Replying to)[^\]]*\][\s\S]*?(?:\n\n|$)/i, "")
    .replace(/\[(?:附件|Attachment):[^\]]*\]/gi, "")
    .trim();
}

export function isRealUserEntry(entry: EntryRecord): boolean {
  if (KuloUserEntry.is(entry)) return true;
  if (entry.kind === "kulo.voice.delegation") return true;
  if (UserEntry.is(entry) && !isLegacyInternalUserEntry(entry)) return true;
  return false;
}

export function collectAllConversationIds(state: Readonly<KuloDurableState> | undefined): number[] {
  const ids = new Set<number>([resolveActiveRootConversationId(state)]);
  for (const topic of Object.values(state?.topics ?? {})) {
    if (Number.isSafeInteger(topic.conversationId) && topic.conversationId > 0) {
      ids.add(topic.conversationId);
    }
  }
  for (const ticket of Object.values(state?.tickets ?? {})) {
    if (Number.isSafeInteger(ticket.workerConversationId) && ticket.workerConversationId > 0) {
      ids.add(ticket.workerConversationId);
    }
  }
  return [...ids];
}

export async function advanceFloorCursorsInTx(
  tx: Tx,
  doc: BuiltinMemoryDocState,
  conversationIds: readonly number[],
): Promise<void> {
  for (const cid of conversationIds) {
    if (!Number.isSafeInteger(cid) || cid <= 0) continue;
    const latest = await tx.latestEntryId(cid as ConversationId);
    const latestNum = latest !== undefined ? Number(latest) : 0;
    const key = String(cid);
    const prev = doc.floorCursors[key]?.cutoffEntryId ?? 0;
    if (latestNum > prev || !doc.floorCursors[key]) {
      doc.floorCursors[key] = { cutoffEntryId: Math.max(prev, latestNum) };
    }
  }
}

export function prunePendingDeliveriesForScope(
  doc: BuiltinMemoryDocState,
  scope: { kind: "topic" | "project"; targetId: string; conversationIds?: readonly number[] },
): void {
  const convSet = new Set(scope.conversationIds ?? []);
  for (const [key, item] of Object.entries(doc.pendingDeliveries ?? {})) {
    const matchesTarget =
      (scope.kind === "topic" && item.topicId === scope.targetId) ||
      (scope.kind === "project" && item.projectId === scope.targetId) ||
      (item.conversationId !== undefined && convSet.has(item.conversationId));
    if (matchesTarget) delete doc.pendingDeliveries[key];
  }
}

export function pruneForgottenPendingDeliveries(doc: BuiltinMemoryDocState, term: string): number {
  let removed = 0;
  for (const [key, item] of Object.entries(doc.pendingDeliveries ?? {})) {
    if (item.bank === "private" && matchesForgottenTerm(item.content, term)) {
      delete doc.pendingDeliveries[key];
      removed += 1;
    }
  }
  return removed;
}

export function enqueueFlushRecordsIntoDoc(
  doc: BuiltinMemoryDocState,
  input: {
    conversationId: number;
    records: readonly WorkingMemoryRecord[];
    forgottenTerms: readonly { term: string }[];
    redact: (text: string) => string;
    now: number;
    maxPending: number;
    advanceIdleFloorEntryId?: number;
    advanceIdleFloorCharOffset?: number;
  },
): number {
  const convKey = String(input.conversationId);
  const floorCutoff = doc.floorCursors?.[convKey]?.cutoffEntryId ?? 0;
  let added = 0;
  doc.pendingDeliveries ??= {};
  for (const rec of input.records) {
    if (rec.status !== "active" && rec.status !== "resolved") continue;
    if (rec.provenance.entryId !== undefined && rec.provenance.entryId <= floorCutoff) continue;
    const safe = input.redact(redactSensitiveText(rec.summary)).replace(/\s+/g, " ").trim();
    if (!safe || !isSafeMemoryText(safe) || isSuspiciousMemoryInstruction(safe) || input.forgottenTerms.some((t) => matchesForgottenTerm(safe, t.term))) continue;
    const scopeKind: BuiltinMemoryScopeKind = rec.bucketId === "global"
      ? "global"
      : rec.bucketId.startsWith("project:") && rec.provenance.projectId
        ? "project"
        : rec.provenance.topicId
          ? "topic"
          : "global";
    const item: BuiltinMemoryDeliveryItem = {
      sourceId: `flush:${rec.id}:${rec.fingerprint}`,
      bank: "private",
      scopeKind,
      ...(rec.provenance.projectId ? { projectId: rec.provenance.projectId } : {}),
      ...(rec.provenance.topicId ? { topicId: rec.provenance.topicId } : {}),
      conversationId: rec.provenance.conversationId,
      source: "flush",
      ...(rec.provenance.entryId !== undefined ? { sourceEntryId: rec.provenance.entryId } : {}),
      evidenceLevel: rec.evidenceLevel,
      category: rec.category === "event" ? "fact" : rec.category,
      ...(rec.status === "resolved" ? { status: "resolved" as const } : {}),
      ...(rec.supersedesId ? { supersedesId: rec.supersedesId } : {}),
      durability: rec.category === "commitment" || rec.category === "decision" || scopeKind === "global" ? "permanent" : "temporary",
      content: safe,
      clearEpoch: doc.clearTargetEpoch,
      engineEpoch: doc.engineEpoch,
      createdAt: rec.updatedAt || input.now,
    };
    doc.pendingDeliveries[item.sourceId] = item;
    added += 1;
  }
  if (input.advanceIdleFloorEntryId !== undefined) {
    const prev = doc.floorCursors[convKey];
    const prevId = prev?.cutoffEntryId ?? 0;
    const prevOff = prev?.cutoffCharOffset ?? 0;
    const nextId = input.advanceIdleFloorEntryId;
    const nextOff = input.advanceIdleFloorCharOffset ?? 0;
    const prevScoreOff = prevOff > 0 ? prevOff : Number.POSITIVE_INFINITY;
    const nextScoreOff = nextOff > 0 ? nextOff : Number.POSITIVE_INFINITY;
    if (nextId > prevId || (nextId === prevId && nextScoreOff > prevScoreOff)) {
      doc.floorCursors[convKey] = { cutoffEntryId: nextId, ...(nextOff > 0 ? { cutoffCharOffset: nextOff } : {}) };
    }
  }
  const keys = Object.keys(doc.pendingDeliveries);
  if (keys.length > input.maxPending) {
    keys.slice(0, keys.length - input.maxPending).forEach((k) => delete doc.pendingDeliveries[k]);
  }
  return added;
}

export function buildDeliveryRetainPayload(
  item: BuiltinMemoryDeliveryItem,
  liveTopicId?: string,
  expectedAppliedClearEpoch?: number,
): BuiltinMemoryRetainInput {
  return {
    callerRole: item.bank === "private" ? "router" : "worker",
    bank: item.bank,
    scopeKind: item.scopeKind,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(liveTopicId ? { topicId: liveTopicId } : {}),
    ...(item.conversationId !== undefined ? { conversationId: item.conversationId } : {}),
    ...(item.ticketId ? { ticketId: item.ticketId } : {}),
    source: item.source,
    sourceId: item.sourceId,
    ...(item.sourceEntryId !== undefined ? { sourceEntryId: item.sourceEntryId } : {}),
    evidenceLevel: item.evidenceLevel,
    category: item.category,
    ...(item.status ? { status: item.status } : {}),
    ...(item.supersedesId ? { supersedesId: item.supersedesId } : {}),
    ...(item.durability ? { durability: item.durability } : {}),
    content: item.content,
    ...(expectedAppliedClearEpoch !== undefined ? { expectedAppliedClearEpoch } : {}),
    now: item.createdAt,
  };
}
