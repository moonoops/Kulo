import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { isCursorAhead } from "./memory-flush-extract.js";
import {
  bucketIdForScope,
  commitWorkingMemory,
  upsertWorkingMemoryRecord,
  type WorkingMemoryRecord,
} from "./working-memory.js";

/**
 * Re-homes working-memory provenance and topic-scoped records belonging to an archived
 * root conversation (`oldConvId`) to its new `archivedTopicId` inside an independent
 * `KuloWorkingMemoryDoc` transaction.
 *
 * - Traverses ALL buckets (`topic:root`, `global`, `project:*`) to rebind `provenance.topicId`
 *   when `provenance.conversationId === oldConvId && provenance.topicId === "root"`.
 * - Moves ONLY `topic:root` records of `oldConvId` into `topic:${archivedTopicId}` (project
 *   and global bucket records stay in their respective buckets).
 * - If `archivedDeleted` is true, strips stale `topic:root` records for `oldConvId` without
 *   recreating any cursor for the deleted archive.
 * - NEVER sets `needsBaselineRefresh = true` on `newConvId` (Turn 1 freezes cleanly, and later
 *   archive-flush batches arrive append-only via `RecentWorkSyncHook`).
 */
export async function rehomeRootWorkingMemoryOnArchive(input: {
  harness: Harness;
  redact: (text: string) => string;
  oldConvId: number;
  newConvId: number;
  archivedTopicId: string;
  tailEntryId: number;
  archivedDeleted: boolean;
  context?: Context;
}): Promise<{ movedRecords: number; reboundRecords: number }> {
  const { harness, redact, oldConvId, archivedTopicId, tailEntryId, archivedDeleted, context = BACKGROUND_CONTEXT } = input;
  const targetTopicBucket = bucketIdForScope({ kind: "topic", topicId: archivedTopicId });
  const oldConvKey = String(oldConvId);

  const { result } = await commitWorkingMemory(
    harness,
    redact,
    (doc) => {
      let movedRecords = 0;
      let reboundRecords = 0;

      // 1. Move oldConvId records out of `topic:root` (or drop them if the archive was already deleted).
      const rootBucket = doc.buckets["topic:root"];
      if (Array.isArray(rootBucket) && rootBucket.length > 0) {
        const remaining: WorkingMemoryRecord[] = [];
        const toMove: WorkingMemoryRecord[] = [];
        for (const record of rootBucket) {
          if (record.provenance.conversationId === oldConvId) {
            if (!archivedDeleted) {
              toMove.push({
                ...record,
                bucketId: targetTopicBucket,
                provenance: { ...record.provenance, topicId: archivedTopicId },
              });
              movedRecords += 1;
            }
          } else {
            remaining.push(record);
          }
        }
        if (remaining.length === 0) delete doc.buckets["topic:root"];
        else doc.buckets["topic:root"] = remaining;
        for (const moved of toMove) {
          upsertWorkingMemoryRecord(doc, moved);
        }
      }

      // 2. Rebind provenance.topicId across ALL remaining buckets (including `global` and `project:*`).
      for (const [bucketKey, records] of Object.entries(doc.buckets)) {
        if (!Array.isArray(records) || bucketKey === "topic:root") continue;
        for (const record of records) {
          if (record.provenance.conversationId === oldConvId && record.provenance.topicId === "root") {
            record.provenance.topicId = archivedTopicId;
            reboundRecords += 1;
          }
        }
      }

      // 3. Record durable pending archive flush target for `oldConvId` unless archive is deleted.
      if (!archivedDeleted && tailEntryId > 0) {
        const cur = doc.cursors[oldConvKey] ?? { lastFlushedEntryId: 0 };
        if (isCursorAhead(tailEntryId, 0, cur.lastFlushedEntryId, cur.lastFlushedCharOffset ?? 0)) {
          cur.pendingTargetMaxEntryId = Math.max(cur.pendingTargetMaxEntryId ?? 0, tailEntryId);
          cur.pendingTrigger = "archive";
          doc.cursors[oldConvKey] = cur;
        }
      } else if (archivedDeleted) {
        delete doc.cursors[oldConvKey];
      }

      return { movedRecords, reboundRecords };
    },
    context,
  );
  return result;
}
