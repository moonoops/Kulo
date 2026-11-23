import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  SystemEntry,
  defineDoc,
  defineEntry,
  hook,
  type ConversationId,
  type Harness,
  type HookRegistration,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { PersonalityDoc } from "./personality.js";
import { KuloProjectsDoc } from "./projects.js";
import { buildRecentWorkSnapshot } from "./recent-work.js";
import { SettingsAssistantDoc, isActiveSettingsConversation, isMainOrchestratorConversation } from "./settings-doc.js";
import { KuloStateDoc, isOrchestratorConversation } from "./state.js";
import { KuloWorkingMemoryDoc, buildWorkingMemorySnapshot } from "./working-memory.js";

export const RECENT_WORK_DISABLED_TEXT =
  "Recent work snapshot injection is disabled; earlier work summaries in this transcript are historical only and do not reflect live ticket status.";

export const CONTEXT_SYNC_PREFIX = "[KULO_RECENT_WORK_UPDATE]";
export const WORKING_MEMORY_CLEARED_TEXT =
  "Working memory ledger is now empty; earlier working memory notes in this transcript were forgotten or cleared and must no longer be relied upon.";

export const RecentWorkUpdateEntry = defineEntry<{ revision: string; content: string }>(
  "kulo.recent_work_update",
);

export function isContextSyncEntry(entry: { kind: string }): boolean {
  return entry.kind === RecentWorkUpdateEntry.kind;
}

export function isContextSyncMessageText(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(CONTEXT_SYNC_PREFIX);
}

interface RecentWorkSyncState {
  lastHeadEntryId?: number;
  /** Legacy alias kept in sync with `lastDeliveredRecentWorkRev` for backward compatibility. */
  lastDeliveredRevision?: string;
  lastDeliveredRecentWorkRev?: string;
  lastDeliveredWorkingMemoryRev?: string;
  lastTaskId?: number;
  lastTargetEntryId?: number;
  lastEntryText?: string;
  lastEntryTimestamp?: number;
}

export const RecentWorkSyncDoc = defineDoc<RecentWorkSyncState & JsonObject>({
  kind: "kulo.recent-work-sync",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}) as RecentWorkSyncState & JsonObject,
  checkpointWhen: () => true,
});

export function unwrapSectionTag(rendered: string, key: string): string {
  const prefix = `<${key}>\n`;
  const suffix = `\n</${key}>`;
  if (rendered.startsWith(prefix) && rendered.endsWith(suffix)) {
    return rendered.slice(prefix.length, rendered.length - suffix.length);
  }
  return rendered;
}

export function hashRecentWorkContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function replayShownSection(messages: readonly Message[], sectionKey: string): string | undefined {
  let shown: string | undefined;
  for (const message of messages) {
    if (message.role !== "system" || !message.sections) continue;
    if (Object.hasOwn(message.sections, sectionKey)) {
      const value = message.sections[sectionKey];
      shown = typeof value === "string" ? value : undefined;
    }
  }
  return shown === undefined ? undefined : unwrapSectionTag(shown, sectionKey);
}

/**
 * Clears cached incremental sync text and delivered working-memory revisions for conversations
 * affected by `kulo_memory_forget` or topic/project deletion so stale copies are never replayed.
 */
export async function invalidateRecentWorkSyncCaches(
  harness: Harness,
  conversationIds: readonly number[],
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  const uniqueIds = [...new Set(conversationIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (const convId of uniqueIds) {
    try {
      const conv = await harness.conversation(convId as ConversationId, context);
      if (!conv) continue;
      await harness.commit(async (tx) => {
        const doc = await tx.doc(RecentWorkSyncDoc, conv.id);
        let changed = false;
        if (doc.lastEntryText !== undefined) {
          delete doc.lastEntryText;
          delete doc.lastEntryTimestamp;
          changed = true;
        }
        if (doc.lastDeliveredWorkingMemoryRev !== undefined) {
          delete doc.lastDeliveredWorkingMemoryRev;
          changed = true;
        }
        if (!changed) return;
      }, context);
    } catch {
      // Best-effort invalidation: missing or deleted conversations do not block forget/delete.
    }
  }
}

/**
 * Mirrors pi-durable's `planSystemEntries` head-reset condition: true when a compaction/reset head
 * marker exists with no subsequent `pi.system` entry, so sections should emit a fresh baseline.
 */
export async function isSystemBaselinePending(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<boolean> {
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) return false;
  const view = await conversation.context(context);
  return view.head !== undefined && !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > view.head!.id);
}

export interface RecentWorkSyncOptions {
  getHarness: () => Harness;
  getPersonalityContext?: () => Promise<{ recentWorkEnabled: boolean }>;
  redact?: (value: string) => string;
}

/**
 * Delivers mid-epoch `kulo_recent_work` and `kulo_working_memory` changes as a single
 * append-only `role: "user"` entry (`kulo.recent_work_update`) rather than mutating `pi.system`,
 * preserving provider prompt-cache prefixes while keeping working memory decoupled from `recentWorkEnabled`.
 */
export function createRecentWorkSyncHook(options: RecentWorkSyncOptions): HookRegistration {
  const redact = options.redact ?? ((value: string) => value);
  return hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      if (request.messages.length === 0 || request.messages.at(-1)?.role !== "user") return undefined;

      const [state, settingsDoc] = await Promise.all([
        api.snapshot(KuloStateDoc, context),
        api.snapshot(SettingsAssistantDoc, context),
      ]);
      if (!isMainOrchestratorConversation(api.conversationId, state, settingsDoc)) return undefined;

      const harness = options.getHarness();
      const conversation = await harness.conversation(api.conversationId, context);
      if (!conversation) return undefined;

      const [view, projects, personality, existingDoc, workingMemoryDoc, personalityDoc] = await Promise.all([
        conversation.context(context),
        api.snapshot(KuloProjectsDoc, context),
        options.getPersonalityContext
          ? options.getPersonalityContext()
          : Promise.resolve({ recentWorkEnabled: true }),
        api.snapshot(RecentWorkSyncDoc, api.conversationId, context),
        api.snapshot(KuloWorkingMemoryDoc, context),
        api.snapshot(PersonalityDoc, context),
      ]);

      const convNum = Number(api.conversationId);
      const isChatTopic =
        isOrchestratorConversation(api.conversationId, state) &&
        !isActiveSettingsConversation(api.conversationId, settingsDoc);

      const shownRecentWork = replayShownSection(request.messages, "kulo_recent_work");
      const shownWorkingMemory = replayShownSection(request.messages, "kulo_working_memory");

      const trackRecentWork = Boolean(personality.recentWorkEnabled && shownRecentWork !== undefined);
      const trackWorkingMemory = isChatTopic;
      if (!trackRecentWork && !trackWorkingMemory) return undefined;

      // Locate the newest contributing user entry so updates are placed immediately BEFORE the
      // incoming user/relay/watchdog prompt rather than after it or mid-tool-loop.
      let targetIdx = -1;
      for (let i = view.entries.length - 1; i >= 0; i -= 1) {
        const contributed = view.contributions[i];
        if (contributed && contributed.length > 0) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx < 0) return undefined;
      const targetEntry = view.entries[targetIdx]!;
      const targetMessages = view.contributions[targetIdx]!;
      if (!targetMessages.every((message) => message.role === "user")) return undefined;

      const tailStart = request.messages.length - targetMessages.length;
      if (tailStart < 0) return undefined;
      const tailMatches = targetMessages.every((message, index) => {
        const candidate = request.messages[tailStart + index];
        return candidate?.role === message.role && candidate.timestamp === message.timestamp;
      });
      if (!tailMatches) return undefined;

      const currentHeadId = view.head ? Number(view.head.id) : 0;
      const taskId = Number(api.taskId);
      const targetEntryId = Number(targetEntry.id);

      // Idempotent retry reuse for the same GenerationTask (e.g. after 429 backoff).
      // Restrict duplicate detection strictly to the active target entry slice so a state reverting
      // to an earlier snapshot text (A -> B -> C -> B) is never suppressed by an older turn's copy.
      if (existingDoc?.lastTaskId === taskId && existingDoc.lastEntryText) {
        const alreadyPresent = request.messages.slice(tailStart).some(
          (message) => message.role === "user" && message.content === existingDoc.lastEntryText,
        );
        if (alreadyPresent) return undefined;
        return {
          messages: [
            ...request.messages.slice(0, tailStart),
            {
              role: "user" as const,
              content: existingDoc.lastEntryText,
              timestamp: existingDoc.lastEntryTimestamp ?? Date.now(),
            },
            ...request.messages.slice(tailStart),
          ],
        };
      }

      // Never edit the same user entry twice (e.g. across a manual retry after a failed run).
      if (
        existingDoc?.lastTargetEntryId === targetEntryId ||
        targetMessages.some((message) => isContextSyncMessageText(message.content))
      ) {
        return undefined;
      }

      const sameEpoch = existingDoc?.lastHeadEntryId === currentHeadId;

      // 1. Recent Work delta (only when recentWorkEnabled && baseline shown)
      let recentWorkDelta: string | undefined;
      let nextRecentWorkRev: string | undefined;
      let baselineRecentWorkRev: string | undefined;
      if (trackRecentWork && shownRecentWork !== undefined) {
        const snapshot = buildRecentWorkSnapshot({
          state,
          projects,
          settings: settingsDoc,
          conversationId: convNum,
          enabled: true,
        });
        if (snapshot.enabled) {
          const redactedLive = redact(snapshot.content);
          const liveRev = hashRecentWorkContent(redactedLive);
          baselineRecentWorkRev = hashRecentWorkContent(redact(shownRecentWork));
          const priorRev = existingDoc?.lastDeliveredRecentWorkRev ?? existingDoc?.lastDeliveredRevision;
          const deliveredRev = sameEpoch && priorRev !== undefined ? priorRev : baselineRecentWorkRev;
          nextRecentWorkRev = liveRev;
          if (liveRev !== deliveredRev) {
            recentWorkDelta = redactedLive;
          }
        }
      }

      // 2. Working Memory delta (chat topics only, fully decoupled from recentWorkEnabled)
      let workingMemoryDelta: string | undefined;
      let nextWorkingMemoryRev: string | undefined;
      let baselineWorkingMemoryRev: string | undefined;
      if (trackWorkingMemory) {
        const wmSnapshot = buildWorkingMemorySnapshot({
          doc: workingMemoryDoc,
          state,
          projects,
          settings: settingsDoc,
          conversationId: convNum,
          recentWorkEnabled: personality.recentWorkEnabled,
          forgottenTerms: personalityDoc?.forgottenTerms,
        });
        const redactedWm = wmSnapshot.content ? redact(wmSnapshot.content) : "";
        const liveWmRev = hashRecentWorkContent(redactedWm);
        const baselineWmText = shownWorkingMemory ? redact(shownWorkingMemory) : "";
        baselineWorkingMemoryRev = hashRecentWorkContent(baselineWmText);
        const priorWmRev = existingDoc?.lastDeliveredWorkingMemoryRev;
        const deliveredWmRev = sameEpoch && priorWmRev !== undefined ? priorWmRev : baselineWorkingMemoryRev;
        nextWorkingMemoryRev = liveWmRev;
        if (liveWmRev !== deliveredWmRev) {
          workingMemoryDelta = redactedWm || WORKING_MEMORY_CLEARED_TEXT;
        }
      }

      if (!recentWorkDelta && !workingMemoryDelta) {
        const needsEpochSeed =
          !sameEpoch &&
          (baselineRecentWorkRev !== undefined || baselineWorkingMemoryRev !== undefined);
        if (needsEpochSeed) {
          await harness.commit(async (tx) => {
            const doc = await tx.doc(RecentWorkSyncDoc, api.conversationId);
            if (doc.lastHeadEntryId === currentHeadId) return;
            doc.lastHeadEntryId = currentHeadId;
            if (baselineRecentWorkRev !== undefined) {
              doc.lastDeliveredRecentWorkRev = baselineRecentWorkRev;
              doc.lastDeliveredRevision = baselineRecentWorkRev;
            }
            if (baselineWorkingMemoryRev !== undefined) {
              doc.lastDeliveredWorkingMemoryRev = baselineWorkingMemoryRev;
            }
          }, context);
        }
        return undefined;
      }

      const combinedBody = [recentWorkDelta, workingMemoryDelta].filter(Boolean).join("\n\n");
      const updateText = `${CONTEXT_SYNC_PREFIX}\n${combinedBody}`;
      const combinedRevision = hashRecentWorkContent(`${nextRecentWorkRev ?? ""}|${nextWorkingMemoryRev ?? ""}`);

      const committed = await harness.commit(async (tx) => {
        const doc = await tx.doc(RecentWorkSyncDoc, api.conversationId);
        if (doc.lastTaskId === taskId && doc.lastEntryText) {
          return { text: doc.lastEntryText, timestamp: doc.lastEntryTimestamp ?? Date.now() };
        }
        if (doc.lastTargetEntryId === targetEntryId) return undefined;
        const txSameEpoch = doc.lastHeadEntryId === currentHeadId;
        const txPriorRw = doc.lastDeliveredRecentWorkRev ?? doc.lastDeliveredRevision;
        const txRwSame = !recentWorkDelta || (txSameEpoch && txPriorRw === nextRecentWorkRev);
        const txWmSame = !workingMemoryDelta || (txSameEpoch && doc.lastDeliveredWorkingMemoryRev === nextWorkingMemoryRev);
        if (txRwSame && txWmSame) return undefined;

        const timestamp = Date.now();
        const updateMessage: Message = { role: "user", content: updateText, timestamp };
        await tx.appendEntry(RecentWorkUpdateEntry, api.conversationId, {
          data: { revision: combinedRevision, content: combinedBody },
          edits: [
            {
              target: targetEntry.id,
              action: "replace",
              messages: [updateMessage, ...targetMessages],
            },
          ],
        });
        doc.lastHeadEntryId = currentHeadId;
        if (nextRecentWorkRev !== undefined) {
          doc.lastDeliveredRecentWorkRev = nextRecentWorkRev;
          doc.lastDeliveredRevision = nextRecentWorkRev;
        }
        if (nextWorkingMemoryRev !== undefined) {
          doc.lastDeliveredWorkingMemoryRev = nextWorkingMemoryRev;
        }
        doc.lastTaskId = taskId;
        doc.lastTargetEntryId = targetEntryId;
        doc.lastEntryText = updateText;
        doc.lastEntryTimestamp = timestamp;
        return { text: updateText, timestamp };
      }, context);

      if (!committed) return undefined;
      if (request.messages.slice(tailStart).some((message) => message.role === "user" && message.content === committed.text)) {
        return undefined;
      }
      return {
        messages: [
          ...request.messages.slice(0, tailStart),
          { role: "user" as const, content: committed.text, timestamp: committed.timestamp },
          ...request.messages.slice(tailStart),
        ],
      };
    },
  });
}
