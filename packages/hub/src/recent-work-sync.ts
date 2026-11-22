import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
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
import { KuloProjectsDoc } from "./projects.js";
import { buildRecentWorkSnapshot } from "./recent-work.js";
import { SettingsAssistantDoc, isMainOrchestratorConversation } from "./settings-doc.js";
import { KuloStateDoc } from "./state.js";

export const RECENT_WORK_DISABLED_TEXT =
  "Recent work snapshot injection is disabled; earlier work summaries in this transcript are historical only and do not reflect live ticket status.";

export const RecentWorkUpdateEntry = defineEntry<{ revision: string; content: string }>(
  "kulo.recent_work_update",
);

interface RecentWorkSyncState {
  lastHeadEntryId?: number;
  lastDeliveredRevision?: string;
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

function replayShownRecentWork(messages: readonly Message[]): string | undefined {
  let shown: string | undefined;
  for (const message of messages) {
    if (message.role !== "system" || !message.sections) continue;
    if (Object.hasOwn(message.sections, "kulo_recent_work")) {
      const value = message.sections.kulo_recent_work;
      shown = typeof value === "string" ? value : undefined;
    }
  }
  return shown === undefined ? undefined : unwrapSectionTag(shown, "kulo_recent_work");
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
 * Delivers mid-epoch `kulo_recent_work` changes as append-only `role: "user"` entries
 * (`kulo.recent_work_update`) rather than mutating `pi.system`, preserving provider prompt-cache
 * prefixes on APIs that fold system messages back to token 0 (Google Vertex/Gemini, Anthropic, etc.).
 */
export function createRecentWorkSyncHook(options: RecentWorkSyncOptions): HookRegistration {
  const redact = options.redact ?? ((value: string) => value);
  return hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const shownBaseline = replayShownRecentWork(request.messages);
      if (shownBaseline === undefined) return undefined;
      if (request.messages.length === 0 || request.messages.at(-1)?.role !== "user") return undefined;

      const [state, settingsDoc] = await Promise.all([
        api.snapshot(KuloStateDoc, context),
        api.snapshot(SettingsAssistantDoc, context),
      ]);
      if (!isMainOrchestratorConversation(api.conversationId, state, settingsDoc)) return undefined;

      const harness = options.getHarness();
      const conversation = await harness.conversation(api.conversationId, context);
      if (!conversation) return undefined;

      const [view, projects, personality, existingDoc] = await Promise.all([
        conversation.context(context),
        api.snapshot(KuloProjectsDoc, context),
        options.getPersonalityContext
          ? options.getPersonalityContext()
          : Promise.resolve({ recentWorkEnabled: true }),
        api.snapshot(RecentWorkSyncDoc, api.conversationId, context),
      ]);

      if (!personality.recentWorkEnabled) return undefined;

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
      if (existingDoc?.lastTaskId === taskId && existingDoc.lastEntryText) {
        const alreadyPresent = request.messages.some(
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
        targetMessages.some(
          (message) => typeof message.content === "string" && message.content.startsWith("[KULO_RECENT_WORK_UPDATE]"),
        )
      ) {
        return undefined;
      }

      const snapshot = buildRecentWorkSnapshot({
        state,
        projects,
        settings: settingsDoc,
        conversationId: Number(api.conversationId),
        enabled: true,
      });
      if (!snapshot.enabled) return undefined;

      const redactedLive = redact(snapshot.content);
      const liveRevision = hashRecentWorkContent(redactedLive);
      const baselineRevision = hashRecentWorkContent(redact(shownBaseline));

      const sameEpoch =
        existingDoc?.lastDeliveredRevision !== undefined && existingDoc.lastHeadEntryId === currentHeadId;
      const deliveredRevision = sameEpoch ? existingDoc.lastDeliveredRevision : baselineRevision;

      if (liveRevision === deliveredRevision) {
        if (!sameEpoch) {
          await harness.commit(async (tx) => {
            const doc = await tx.doc(RecentWorkSyncDoc, api.conversationId);
            if (doc.lastHeadEntryId === currentHeadId && doc.lastDeliveredRevision === baselineRevision) return;
            doc.lastHeadEntryId = currentHeadId;
            doc.lastDeliveredRevision = baselineRevision;
          }, context);
        }
        return undefined;
      }

      const updateText = `[KULO_RECENT_WORK_UPDATE]\n${redactedLive}`;
      const committed = await harness.commit(async (tx) => {
        const doc = await tx.doc(RecentWorkSyncDoc, api.conversationId);
        if (doc.lastTaskId === taskId && doc.lastEntryText) {
          return { text: doc.lastEntryText, timestamp: doc.lastEntryTimestamp ?? Date.now() };
        }
        if (doc.lastTargetEntryId === targetEntryId) return undefined;
        const txSameEpoch =
          doc.lastDeliveredRevision !== undefined && doc.lastHeadEntryId === currentHeadId;
        const txDelivered = txSameEpoch ? doc.lastDeliveredRevision : baselineRevision;
        if (txDelivered === liveRevision) {
          if (!txSameEpoch) {
            doc.lastHeadEntryId = currentHeadId;
            doc.lastDeliveredRevision = baselineRevision;
          }
          return undefined;
        }
        const timestamp = Date.now();
        const updateMessage: Message = { role: "user", content: updateText, timestamp };
        await tx.appendEntry(RecentWorkUpdateEntry, api.conversationId, {
          data: { revision: liveRevision, content: redactedLive },
          edits: [
            {
              target: targetEntry.id,
              action: "replace",
              messages: [updateMessage, ...targetMessages],
            },
          ],
        });
        doc.lastHeadEntryId = currentHeadId;
        doc.lastDeliveredRevision = liveRevision;
        doc.lastTaskId = taskId;
        doc.lastTargetEntryId = targetEntryId;
        doc.lastEntryText = updateText;
        doc.lastEntryTimestamp = timestamp;
        return { text: updateText, timestamp };
      }, context);

      if (!committed) return undefined;
      if (request.messages.some((message) => message.role === "user" && message.content === committed.text)) {
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
