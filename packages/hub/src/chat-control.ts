import type { ConversationHandle, InputSubmissionDraft, JsonObject, SubmissionId, Tx } from "@earendil-works/pi-durable";
import {
  CoordinatorEventEntry,
  KuloStateDoc,
  MediaRelayEntry,
  WorkerRecoveryEntry,
  WorkerRelayEntry,
  WorkerWatchdogEntry,
  type CoordinatorEventKind,
} from "./state.js";

export type AutomaticChatEntryKind =
  | typeof WorkerRelayEntry.kind
  | typeof WorkerWatchdogEntry.kind
  | typeof WorkerRecoveryEntry.kind
  | typeof MediaRelayEntry.kind
  | typeof CoordinatorEventEntry.kind;

const ALLOWED_AUTOMATIC_ENTRY_KINDS = new Set<string>([
  WorkerRelayEntry.kind,
  WorkerWatchdogEntry.kind,
  WorkerRecoveryEntry.kind,
  MediaRelayEntry.kind,
  CoordinatorEventEntry.kind,
]);

export type AutomaticChatInputDraft = Omit<InputSubmissionDraft, "entry"> & {
  entry: NonNullable<InputSubmissionDraft["entry"]> & { kind: AutomaticChatEntryKind };
};

function inferFallbackCoordinatorEventKind(content: InputSubmissionDraft["content"]): CoordinatorEventKind {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
            .join("\n")
        : "";
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[KULO_CONNECTION_REQUEST]")) return "connection_request";
  if (trimmed.startsWith("[KULO_HOST_ACTION_RESULT]")) return "host_action_result";
  if (trimmed.startsWith("[KULO_USER_TASK_INSTRUCTION]")) return "user_task_instruction";
  return "host_action_request";
}

/** Normalize pre-upgrade deferred drafts persisted in `pausedChats` without an explicit internal entry kind. */
export function normalizePausedAutomaticDraft(draft: InputSubmissionDraft): InputSubmissionDraft {
  if (draft.entry?.kind && ALLOWED_AUTOMATIC_ENTRY_KINDS.has(draft.entry.kind)) {
    return draft;
  }
  return {
    ...draft,
    entry: {
      kind: CoordinatorEventEntry.kind,
      data: {
        eventKind: inferFallbackCoordinatorEventKind(draft.content),
        createdAt: Date.now(),
      } as unknown as JsonObject,
    },
  };
}

/** A stopped chat keeps background results durable without restarting its user-input inbox. */
export async function submitAutomaticChatInput(
  tx: Tx,
  conversation: ConversationHandle,
  draft: AutomaticChatInputDraft,
): Promise<SubmissionId | undefined> {
  const entryKind = draft.entry?.kind;
  if (!entryKind || !ALLOWED_AUTOMATIC_ENTRY_KINDS.has(entryKind)) {
    throw new Error(
      `submitAutomaticChatInput requires an internal coordinator entry kind; received '${String(entryKind ?? "none")}'.`,
    );
  }
  const state = await tx.doc(KuloStateDoc);
  const topicId = state.conversationToTopic?.[String(conversation.id)];
  const topic = topicId ? state.topics?.[topicId] : undefined;
  if (topic && (topic.deletedAt !== undefined || topic.archived)) {
    return undefined;
  }
  const deferred = state.pausedChats?.[String(conversation.id)];
  if (!deferred) {
    return conversation.submit(tx, draft);
  }
  // This is a live health check, not a result; the next watchdog tick checks fresh state after resume.
  if (entryKind === WorkerWatchdogEntry.kind) return undefined;
  if (draft.requestId && (deferred.some((item) => item.requestId === draft.requestId) || await tx.submissionByRequest(conversation.id, draft.requestId))) return undefined;
  deferred.push(JSON.parse(JSON.stringify(draft)) as InputSubmissionDraft);
  return undefined;
}
