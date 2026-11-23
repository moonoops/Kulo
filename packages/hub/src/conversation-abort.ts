import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Conversation, type Harness } from "@earendil-works/pi-durable";

/**
 * Session-level system operation tasks anchored on `ROOT_CONVERSATION_ID` (`1`).
 * Even after `conv#1` is archived, restored, moved to a project, or deleted, these
 * system tasks must NEVER be terminated by conversation-scoped aborts.
 */
export const MEMORY_SERVICE_OPERATION_TASK_KIND = "kulo.memory-service-operation";
export const EXTENSION_OPERATION_TASK_KIND = "kulo.extension-operation";

export const PROTECTED_ROOT_SYSTEM_TASK_KINDS: ReadonlySet<string> = new Set([
  MEMORY_SERVICE_OPERATION_TASK_KIND,
  EXTENSION_OPERATION_TASK_KIND,
]);

const ABORT_WAIT_TIMEOUT_MS = 5_000;

/**
 * Aborts foreground and conversation-owned background tasks for `conversation` while
 * preserving protected session-level system tasks anchored on `ROOT_CONVERSATION_ID`.
 */
export async function abortConversationSafely(
  harness: Harness,
  conversation: Conversation,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  if (Number(conversation.id) !== Number(ROOT_CONVERSATION_ID)) {
    await conversation.abort(context, { background: true });
    return;
  }

  // Abort only foreground runs and queued inputs; do not cross the background boundary blindly.
  await conversation.abort(context);

  const inspected = await harness.inspect(context);
  const targets = inspected.tasks.filter(
    (task) =>
      Number(task.record.conversationId) === Number(ROOT_CONVERSATION_ID) &&
      !PROTECTED_ROOT_SYSTEM_TASK_KINDS.has(task.record.kind),
  );
  if (targets.length === 0) return;

  const waitPromises: Promise<unknown>[] = [];
  for (const task of targets) {
    try {
      const outcome = await harness.abortTask(task.record.id, context);
      if (outcome === "marked") {
        const waitCtx = withAbortSignal(AbortSignal.timeout(ABORT_WAIT_TIMEOUT_MS), context);
        waitPromises.push(
          harness.waitForTask(task.record.id, waitCtx).catch((error) => {
            console.warn("[KuloConversationAbort] Timed out or failed waiting for aborted task", task.record.kind, Number(task.record.id), error);
          }),
        );
      }
    } catch (error) {
      console.warn("[KuloConversationAbort] Failed to abort chat task on root anchor", task.record.kind, Number(task.record.id), error);
    }
  }
  if (waitPromises.length > 0) {
    harness.resume();
    await Promise.allSettled(waitPromises);
  }
}
