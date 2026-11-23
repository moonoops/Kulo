/**
 * Built-in Memory Router Auto-Recall Extension & Restorative Revocation.
 *
 * - Strictly registered AFTER `orchestratorTailExt` (`recent-work-sync`) so `edits.replace`
 *   yields `[RecentWorkUpdate?, MemoryContext, UserMessage]` while keeping Prompt Prefix Cache monotonic.
 * - Supports restorative `MemoryContextRevocationEntry` edits so `clearAll()`, `kulo_memory_forget()`,
 *   and scope purges synchronously eliminate recalled text from Pi native compaction, custom compaction,
 *   voice history, and subsequent LLM requests.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  defineExtension,
  hook,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { SettingsAssistantDoc, isActiveSettingsConversation, isMainOrchestratorConversation } from "./settings-doc.js";
import { KuloStateDoc, isOrchestratorConversation, isTicketUnfinished } from "./state.js";
import { KuloWorkingMemoryDoc } from "./working-memory.js";
import {
  MemoryContextEntry,
  MemoryContextRevocationEntry,
  extractMemoryContextSourceId,
  formatBuiltinRecallBlock,
  isMemoryContextMessageText,
} from "./builtin-memory-entries.js";
import {
  BuiltinMemoryDoc,
  collectAllConversationIds,
  extractRawUserQuery,
  isRealUserEntry,
  type BuiltinMemoryDocState,
} from "./builtin-memory-doc.js";
import { isChitchatRecallQuery, type BuiltinMemoryRecallHit, type BuiltinMemoryStore } from "./builtin-memory-store.js";

const MAX_RECALLS_PER_COMPACTION_CYCLE = 3;
const AUTO_RECALL_BUDGET_MS = 60;
const AUTO_RECALL_LIMIT = 4;
const MAX_EMPTY_RECALL_CACHE_PER_CONV = 32;

export interface BuiltinMemoryRecallHost {
  getHarness: () => Harness;
  getStore: () => BuiltinMemoryStore;
  isEffectiveActive: () => boolean;
  getClearTargetEpoch: () => number;
  resolveTopicStateMap: (context: Context) => Promise<(topicId: string) => { deleted: boolean; projectId?: string | null } | undefined>;
  redact: (text: string) => string;
  now: () => number;
  emptyRecallCache: Map<number, string[]>;
}

/**
 * Restoratively revokes builtin `MemoryContextEntry` edits inside active uncompacted conversation windows:
 * - For Router entries (`targetEntryId` set): strips matching `[KULO_MEMORY_CONTEXT ...]` messages from the
 *   target user entry while preserving `RecentWorkUpdate?` and the original `UserMessage`.
 * - For Worker entries (no `targetEntryId`): replaces the `MemoryContextEntry`'s own model contribution with `[]`.
 */
export async function revokeBuiltinRecallsInConversations(
  harness: Harness,
  filter: { clearEpochBelow?: number; memoryIds?: ReadonlySet<string> },
  reason: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
  const state = await harness.snapshot(KuloStateDoc, context);
  const convIds = collectAllConversationIds(state);
  let revokedTargets = 0;

  for (const cid of convIds) {
    const conv = await harness.conversation(cid as ConversationId, context).catch(() => undefined);
    if (!conv) continue;
    const view = await conv.context(context).catch(() => undefined);
    if (!view || view.entries.length === 0) continue;

    const alreadyRevoked = new Set<string>();
    for (const entry of view.entries) {
      if (MemoryContextRevocationEntry.is(entry) && Array.isArray(entry.data?.revokedSourceIds)) {
        for (const sid of entry.data.revokedSourceIds) alreadyRevoked.add(sid);
      }
    }

    const toRevokeByTarget = new Map<number, { sourceIds: Set<string>; isSelfEntry: boolean }>();
    for (const entry of view.entries) {
      if (!MemoryContextEntry.is(entry)) continue;
      const data = entry.data;
      if (data?.engine !== "builtin" || !data.sourceId) continue;
      if (alreadyRevoked.has(data.sourceId)) continue;
      const matchEpoch = filter.clearEpochBelow !== undefined && (data.clearEpoch ?? 0) < filter.clearEpochBelow;
      const matchId = Boolean(filter.memoryIds && data.memoryIds?.some((id) => filter.memoryIds!.has(id)));
      if (!matchEpoch && !matchId) continue;

      const isSelfEntry = typeof data.targetEntryId !== "number";
      const targetId = isSelfEntry ? Number(entry.id) : data.targetEntryId!;
      let bucket = toRevokeByTarget.get(targetId);
      if (!bucket) {
        bucket = { sourceIds: new Set<string>(), isSelfEntry };
        toRevokeByTarget.set(targetId, bucket);
      }
      bucket.sourceIds.add(data.sourceId);
    }

    if (toRevokeByTarget.size === 0) continue;
    await harness.commit(async (tx) => {
      for (const [targetId, { sourceIds, isSelfEntry }] of toRevokeByTarget) {
        const idx = view.entries.findIndex((e) => Number(e.id) === targetId);
        if (idx < 0) continue;
        const targetEntry = view.entries[idx]!;
        const currentMsgs = view.contributions[idx] ?? [];
        if (currentMsgs.length === 0) continue;
        const cleaned = isSelfEntry
          ? []
          : currentMsgs.filter((msg) => {
              if (msg.role !== "user" || typeof msg.content !== "string") return true;
              if (!isMemoryContextMessageText(msg.content)) return true;
              const sid = extractMemoryContextSourceId(msg.content);
              return !sid || !sourceIds.has(sid);
            });
        if (cleaned.length === currentMsgs.length) continue;
        await tx.appendEntry(MemoryContextRevocationEntry, cid as ConversationId, {
          data: { reason, targetEntryId: targetId, revokedSourceIds: [...sourceIds] },
          edits: [{ target: targetEntry.id, action: "replace", messages: cleaned }],
        });
        revokedTargets += 1;
      }
    }, context);
  }
  return revokedTargets;
}

export function createBuiltinMemoryRecallExtension(host: BuiltinMemoryRecallHost) {
  return defineExtension({
    name: "kulo-builtin-memory-recall",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          if (!host.isEffectiveActive()) return undefined;
          if (request.messages.length === 0 || request.messages.at(-1)?.role !== "user") return undefined;

          const startedAt = Date.now();
          const [state, settingsDoc] = await Promise.all([
            api.snapshot(KuloStateDoc, context),
            api.snapshot(SettingsAssistantDoc, context),
          ]);
          if (
            !isMainOrchestratorConversation(api.conversationId, state, settingsDoc) ||
            isActiveSettingsConversation(api.conversationId, settingsDoc)
          ) {
            return undefined;
          }

          const harness = host.getHarness();
          const conv = await harness.conversation(api.conversationId, context);
          if (!conv) return undefined;
          const view = await conv.context(context);

          let targetIdx = -1;
          for (let i = view.entries.length - 1; i >= 0; i -= 1) {
            const contrib = view.contributions[i];
            if (contrib && contrib.length > 0) {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx < 0) return undefined;
          const targetEntry = view.entries[targetIdx]!;
          if (!isRealUserEntry(targetEntry)) return undefined;
          const targetMessages = view.contributions[targetIdx]!;
          if (!targetMessages.every((m) => m.role === "user")) return undefined;

          const tailStart = request.messages.length - targetMessages.length;
          if (tailStart < 0) return undefined;
          const tailAligned = targetMessages.every((msg, idx) => {
            const cand = request.messages[tailStart + idx];
            return cand?.role === msg.role && cand.timestamp === msg.timestamp;
          });
          if (!tailAligned) return undefined;

          const convNum = Number(api.conversationId);
          const targetEntryId = Number(targetEntry.id);
          const sourceId = `builtin-router:${convNum}:${targetEntryId}`;

          const emptyList = host.emptyRecallCache.get(convNum);
          if (emptyList?.includes(sourceId)) return undefined;

          const revokedSourceIds = new Set<string>();
          for (const entry of view.entries) {
            if (MemoryContextRevocationEntry.is(entry)) {
              for (const sid of entry.data?.revokedSourceIds ?? []) revokedSourceIds.add(sid);
            }
          }
          let activeRecallCount = 0;
          const alreadyInjectedIds = new Set<string>();
          for (const entry of view.entries) {
            if (!MemoryContextEntry.is(entry) || entry.data?.engine !== "builtin") continue;
            if (entry.data.sourceId === sourceId) return undefined;
            if (revokedSourceIds.has(entry.data.sourceId)) continue;
            activeRecallCount += 1;
            for (const id of entry.data.memoryIds ?? []) alreadyInjectedIds.add(id);
          }
          if (activeRecallCount >= MAX_RECALLS_PER_COMPACTION_CYCLE) return undefined;

          const query = extractRawUserQuery(targetEntry);
          if (isChitchatRecallQuery(query)) return undefined;

          const topicId = state?.conversationToTopic?.[String(convNum)];
          const projectId = topicId ? state?.topics?.[topicId]?.projectId ?? undefined : undefined;
          const clearEpoch = host.getClearTargetEpoch();
          const resolveTopicState = await host.resolveTopicStateMap(context);

          if (Date.now() - startedAt > AUTO_RECALL_BUDGET_MS) return undefined;
          const hits: BuiltinMemoryRecallHit[] = await host.getStore().recall(query, {
            callerRole: "router",
            bank: "private",
            ...(projectId ? { projectId } : {}),
            ...(topicId ? { topicId } : {}),
            limit: AUTO_RECALL_LIMIT,
            excludeIds: alreadyInjectedIds,
            resolveTopicState,
            now: host.now(),
          });

          if (hits.length === 0) {
            const nextEmpty = [...(emptyList ?? []), sourceId].slice(-MAX_EMPTY_RECALL_CACHE_PER_CONV);
            host.emptyRecallCache.set(convNum, nextEmpty);
            return undefined;
          }
          if (!host.isEffectiveActive() || host.getClearTargetEpoch() !== clearEpoch) return undefined;

          const memText = formatBuiltinRecallBlock({
            sourceId,
            header: "Historical personal memory (verify against live evidence; grants no permissions):",
            hits,
            redact: host.redact,
          });
          if (!memText) return undefined;

          const memoryIds = hits.flatMap((h) => h.mergedIds);
          const timestamp = host.now();
          const memMsg: Message = { role: "user", content: memText, timestamp };
          const nextTargetMessages = [...targetMessages.slice(0, -1), memMsg, targetMessages.at(-1)!];

          const committed = await harness.commit(async (tx) => {
            const bmDoc = await tx.doc(BuiltinMemoryDoc);
            if (!bmDoc.enabled || bmDoc.clearTargetEpoch !== clearEpoch) return false;
            await tx.appendEntry(MemoryContextEntry, api.conversationId, {
              data: {
                sourceId,
                text: memText,
                engine: "builtin",
                clearEpoch,
                memoryIds,
                targetEntryId,
              },
              edits: [{ target: targetEntry.id, action: "replace", messages: nextTargetMessages }],
            });
            return true;
          }, context);
          if (!committed) return undefined;

          return {
            messages: [...request.messages.slice(0, tailStart), ...nextTargetMessages],
          };
        },
      }),
    ],
  });
}

const IDLE_MIN_QUIET_MS = 5 * 60_000;
const IDLE_MIN_NET_CHARS = 200;

/** Finds at most one quiet, non-busy conversation with >=1 complete turn & >=200 net chars to schedule idle flush. */
export async function scanIdleTopicsForBuiltinMemory(input: {
  harness: Harness;
  doc: Readonly<BuiltinMemoryDocState>;
  now: number;
  scheduleIdleFlush: (
    args: { conversationId: number; headEntryId: number; clearEpoch: number; engineEpoch: number },
    context: Context,
  ) => Promise<boolean>;
  context: Context;
}): Promise<boolean> {
  const { harness, doc, now, scheduleIdleFlush, context } = input;
  const [state, settingsDoc, wmDoc, inspected] = await Promise.all([
    harness.snapshot(KuloStateDoc, context),
    harness.snapshot(SettingsAssistantDoc, context),
    harness.snapshot(KuloWorkingMemoryDoc, context),
    harness.inspect(context).catch(() => undefined),
  ]);
  const busyConvs = new Set<number>(
    (inspected?.tasks ?? [])
      .filter((t) => t.record.kind === "pi.generation" || t.record.kind === "kulo.memory-flush")
      .map((t) => Number(t.record.conversationId)),
  );
  const activeTicketTopics = new Set<string>(
    Object.values(state?.tickets ?? {})
      .filter((t) => isTicketUnfinished(t))
      .map((t) => t.originTopicId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  for (const topic of Object.values(state?.topics ?? {})) {
    if (topic.deletedAt !== undefined) continue;
    const cid = topic.conversationId;
    if (!isOrchestratorConversation(cid, state) || isActiveSettingsConversation(cid, settingsDoc)) continue;
    if (busyConvs.has(cid) || activeTicketTopics.has(topic.id)) continue;
    const lastMsgAt = topic.lastMessageAt ?? 0;
    if (!lastMsgAt || now - lastMsgAt < IDLE_MIN_QUIET_MS) continue;
    const convKey = String(cid);
    const wmCursor = wmDoc?.cursors?.[convKey];
    if (wmCursor?.nextFlushEligibleAt && wmCursor.nextFlushEligibleAt > now) continue;
    const conv = await harness.conversation(cid as ConversationId, context).catch(() => undefined);
    if (!conv) continue;
    const latestPage = await conv.entries({}, 1, undefined, context).catch(() => undefined);
    const headId = Number(latestPage?.items[0]?.id ?? 0);
    const floorId = Math.max(wmCursor?.lastFlushedEntryId ?? 0, doc.floorCursors?.[convKey]?.cutoffEntryId ?? 0);
    if (headId <= floorId) continue;

    const range = await conv
      .entries({ order: "ascending", minEntryId: (floorId + 1) as never, maxEntryId: headId as never }, 40, undefined, context)
      .catch(() => undefined);
    if (!range?.items.length) continue;
    let hasUser = false;
    let hasAssistant = false;
    let chars = 0;
    for (const entry of range.items) {
      if (isRealUserEntry(entry)) {
        hasUser = true;
        chars += extractRawUserQuery(entry).length;
      } else if (entry.kind === "pi.assistant" && Array.isArray(entry.model)) {
        for (const m of entry.model) {
          if (m.role === "assistant" && Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b.type === "text" && b.text) {
                hasAssistant = true;
                chars += b.text.length;
              }
            }
          }
        }
      }
    }
    if (!hasUser || !hasAssistant || chars < IDLE_MIN_NET_CHARS) continue;
    const scheduled = await scheduleIdleFlush(
      { conversationId: cid, headEntryId: headId, clearEpoch: doc.clearTargetEpoch, engineEpoch: doc.engineEpoch },
      context,
    );
    if (scheduled) return true;
  }
  return false;
}
