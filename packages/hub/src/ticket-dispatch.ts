import { configure, type AgentChange, type Tx } from "@earendil-works/pi-durable";
import type { TicketRecord } from "@moco/protocol";
import type { createWorkerTicketTask } from "./scheduler.js";
import type { MocoDurableState } from "./state.js";
import type { MocoUploadStore } from "./uploads.js";

export type TicketDispatchDraft = Omit<TicketRecord, "workerConversationId" | "activeTaskId">;

/** The Worker, its configuration and the task that can run it become visible in the same commit. */
export async function createDispatchedTicket(
  tx: Tx,
  state: MocoDurableState,
  draft: TicketDispatchDraft,
  task: ReturnType<typeof createWorkerTicketTask>,
  agent?: AgentChange,
): Promise<TicketRecord> {
  const worker = await tx.createConversation({ ownership: { kind: "ownerless" } });
  if (agent) await configure(tx, worker.id, agent);
  const taskId = await tx.createTask(task, {
    ticketId: draft.id, runEpoch: draft.runEpoch, promptOverride: null,
    ...(draft.inputAttachmentIds?.length ? { attachmentIds: draft.inputAttachmentIds } : {}),
  }, { ownership: { kind: "conversation" }, background: true });
  const ticket = { ...draft, workerConversationId: Number(worker.id), activeTaskId: Number(taskId) };
  state.tickets[ticket.id] = ticket;
  state.commandIndex[ticket.commandId] = ticket.id;
  state.conversationToTicket[String(worker.id)] = ticket.id;
  return ticket;
}

export function bindDispatchedAttachments(uploads: MocoUploadStore, ticket: Readonly<TicketRecord>): void {
  // A replay can supply different attachment IDs. Only the original, authorized inputs are committed on the ticket.
  if (!ticket.inputAttachmentIds?.length) return;
  uploads.bindAttachments(ticket.inputAttachmentIds, `conversation:${ticket.workerConversationId}`);
  uploads.bindAttachments(ticket.inputAttachmentIds, `ticket:${ticket.id}`);
}
