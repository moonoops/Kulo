import type { KuloDurableState, KuloHub } from "@kulo/hub";

export function traceTicketTransitions(hub: KuloHub, ticketId: string) {
  const events: unknown[] = [];
  let workerConversationId: number | undefined;
  const observation = hub.harness.observeCommits({
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type === "document" && change.kind === "change" && change.record.kind === "kulo.state") {
          const state = change.value as unknown as KuloDurableState;
          const ticket = state.tickets[ticketId];
          if (!ticket) continue;
          workerConversationId = ticket.workerConversationId;
          events.push({ seq: publication.seq, type: "ticket", status: ticket.status, epoch: ticket.runEpoch,
            wait: ticket.waiting?.reason, taskId: ticket.activeTaskId, cleanupPending: ticket.cleanupPending,
            wakePending: ticket.wakePending, report: ticket.latestReport?.state, held: state.slots.holders.includes(ticketId) });
        } else if (change.type === "task") {
          const task = change.value;
          const input = task.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input : undefined;
          if (task.conversationId !== workerConversationId && input?.ticketId !== ticketId) continue;
          const checkpoint = task.state.checkpoint;
          events.push({ seq: publication.seq, type: "task", id: task.id, kind: task.kind, conversationId: task.conversationId,
            status: task.state.status, aborted: task.abortRequested, epoch: input?.runEpoch,
            phase: checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) ? checkpoint.phase : undefined,
            outcome: task.state.outcome?.status });
        } else if (change.type === "submission" && change.value.conversationId === workerConversationId) {
          const submission = change.value;
          events.push({ seq: publication.seq, type: "submission", id: submission.id, requestId: submission.requestId,
            status: submission.status, reason: submission.reason });
        }
      }
      if (events.length > 160) events.splice(0, events.length - 160);
    },
    end() {},
  });
  return { events, stop: () => observation.detach() };
}
