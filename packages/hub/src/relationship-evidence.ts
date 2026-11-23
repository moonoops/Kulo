import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  UserEntry,
  defineDoc,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { isSafeMemoryText } from "./hindsight.js";
import { entryTimestamp, extractDisplayMessages } from "./hub-display-projection.js";
import { KuloStateDoc, WorkerRelayEntry } from "./state.js";
import { KuloUserEntry } from "./ui-cards.js";
import { VoiceTranscriptEntry } from "./voice-transcripts.js";

export const RelationshipReviewsDoc = defineDoc<{ conversationIds: number[] } & JsonObject>({
  kind: "kulo.relationship-reviews",
  version: 1,
  scope: "session",
  initial: () => ({ conversationIds: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export interface RelationshipEvidenceProgress {
  cursor: number;
  entries: Record<string, number>;
  reports: Record<string, string>;
}

export const RelationshipEvidenceDoc = defineDoc<
  (RelationshipEvidenceProgress & {
    pending: RelationshipEvidenceProgress | null;
  }) &
    JsonObject
>({
  kind: "kulo.relationship-evidence",
  version: 1,
  scope: "session",
  initial: () => ({ cursor: 0, entries: {}, reports: {}, pending: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

export async function collectRelationshipInput(
  harness: Harness,
  since: number,
): Promise<{ cursor: number; content: string }> {
  const progress = await harness.commit(async (tx) => {
    const doc = await tx.doc(RelationshipEvidenceDoc);
    if (doc.pending?.cursor === since) {
      doc.cursor = since;
      doc.entries = doc.pending.entries;
      doc.reports = doc.pending.reports;
      doc.pending = null;
    }
    if (doc.cursor !== since) throw new Error("协作关系的来源进度不一致，请重新检查。");
    return { cursor: doc.cursor, entries: { ...doc.entries }, reports: { ...doc.reports } };
  }, BACKGROUND_CONTEXT);

  const state = await harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
  const candidates: Array<{
    at: number;
    text: string;
    conversationId?: string;
    entryId?: number;
    ticketId?: string;
    reportKey?: string;
  }> = [];

  for (const topic of Object.values(state?.topics ?? {}).filter(
    (item) => !item.deletedAt && (!item.archived || item.archivedFromRoot),
  )) {
    const conversation = await harness.conversation(topic.conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) continue;
    const conversationId = String(topic.conversationId);
    let cursor: Cursor | undefined;
    let scanned = 0;
    do {
      const page = await conversation.entries(
        { minEntryId: ((progress.entries[conversationId] ?? 0) + 1) as EntryId, order: "ascending" },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        const relevant =
          UserEntry.is(entry) ||
          KuloUserEntry.is(entry) ||
          AssistantEntry.is(entry) ||
          WorkerRelayEntry.is(entry);
        const evidence = VoiceTranscriptEntry.is(entry)
          ? [{ role: entry.data.role, text: entry.data.text }]
          : relevant
            ? extractDisplayMessages([entry])
            : [];
        const messages = evidence.filter(
          (item) => ["user", "assistant", "relay"].includes(item.role) && item.text.trim() && isSafeMemoryText(item.text),
        );
        const at = entryTimestamp(entry) ?? 0;
        candidates.push({
          at,
          conversationId,
          entryId: Number(entry.id),
          text: messages
            .map(
              (item) =>
                `[${topic.title} / ${item.role}${at ? ` / ${new Date(at).toISOString()}` : ""}]\n${item.text.slice(0, 2500)}`,
            )
            .join("\n\n"),
        });
      }
      scanned += page.items.length;
      cursor = page.next;
    } while (cursor && scanned < 2000);
  }

  for (const ticket of Object.values(state?.tickets ?? {})) {
    const report = ticket.latestReport;
    const topic = ticket.originTopicId ? state?.topics?.[ticket.originTopicId] : undefined;
    if (topic?.deletedAt || (topic?.archived && !topic.archivedFromRoot) || !report) continue;
    const reportKey = createHash("sha256").update(JSON.stringify([report.at, report.state, report.summary])).digest("hex");
    if (progress.reports[ticket.id] === reportKey) continue;
    candidates.push({
      at: report.at,
      ticketId: ticket.id,
      reportKey,
      text: isSafeMemoryText(report.summary)
        ? `[任务 ${ticket.title} / ${report.state}]\n${report.summary.slice(0, 1200)}`
        : "",
    });
  }

  candidates.sort(
    (a, b) =>
      (a.conversationId ?? `~${a.ticketId}`).localeCompare(b.conversationId ?? `~${b.ticketId}`) ||
      (a.entryId ?? 0) - (b.entryId ?? 0),
  );
  const selected: string[] = [];
  let size = 0;
  for (const candidate of candidates) {
    if (size + candidate.text.length > 48_000 && selected.length) break;
    if (candidate.conversationId && candidate.entryId !== undefined) {
      progress.entries[candidate.conversationId] = candidate.entryId;
    }
    if (candidate.ticketId && candidate.reportKey) progress.reports[candidate.ticketId] = candidate.reportKey;
    if (candidate.text) {
      selected.push(candidate.text);
      size += candidate.text.length;
    }
  }
  const nextCursor = Math.max(Date.now(), since + 1);
  await harness.commit(async (tx) => {
    const doc = await tx.doc(RelationshipEvidenceDoc);
    doc.pending = { cursor: nextCursor, entries: progress.entries, reports: progress.reports };
  }, BACKGROUND_CONTEXT);
  return { cursor: nextCursor, content: selected.join("\n\n") };
}
