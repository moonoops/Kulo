import type { ConversationHandle, InputSubmissionDraft, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { KuloStateDoc, WorkerWatchdogEntry } from "./state.js";

/** A stopped chat keeps background results durable without restarting its user-input inbox. */
export async function submitAutomaticChatInput(tx: Tx, conversation: ConversationHandle, draft: InputSubmissionDraft): Promise<SubmissionId | undefined> {
  const state = await tx.doc(KuloStateDoc);
  const deferred = state.pausedChats?.[String(conversation.id)];
  if (!deferred) {
    return conversation.submit(tx, draft);
  }
  // This is a live health check, not a result; the next watchdog tick checks fresh state after resume.
  if (draft.entry?.kind === WorkerWatchdogEntry.kind) return undefined;
  if (draft.requestId && (deferred.some((item) => item.requestId === draft.requestId) || await tx.submissionByRequest(conversation.id, draft.requestId))) return undefined;
  deferred.push(JSON.parse(JSON.stringify(draft)) as InputSubmissionDraft);
  return undefined;
}
