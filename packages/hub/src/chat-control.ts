import type { ConversationHandle, InputSubmissionDraft, Tx } from "@earendil-works/pi-durable";
import { MocoStateDoc, WorkerWatchdogEntry } from "./state.js";

/** A stopped chat keeps background results durable without restarting its user-input inbox. */
export async function submitAutomaticChatInput(tx: Tx, conversation: ConversationHandle, draft: InputSubmissionDraft): Promise<undefined> {
  const state = await tx.doc(MocoStateDoc);
  const deferred = state.pausedChats?.[String(conversation.id)];
  if (!deferred) {
    await conversation.submit(tx, draft);
    return;
  }
  // This is a live health check, not a result; the next watchdog tick checks fresh state after resume.
  if (draft.entry?.kind === WorkerWatchdogEntry.kind) return;
  if (draft.requestId && (deferred.some((item) => item.requestId === draft.requestId) || await tx.submissionByRequest(conversation.id, draft.requestId))) return;
  deferred.push(JSON.parse(JSON.stringify(draft)) as InputSubmissionDraft);
}
