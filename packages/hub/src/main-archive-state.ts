import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { MainArchiveFinalizeRecord, MainArchiveFinalizeSteps, TicketRecord } from "@kulo/protocol";
import { hasPendingWorkspaceApply, isTicketUnfinished, type KuloDurableState } from "./state.js";

export type { MainArchiveFinalizeRecord, MainArchiveFinalizeSteps };

/**
 * Strict archive barrier for the active main conversation: covers unfinished runs,
 * staged workspace applies, pending cleanup, pending final relays, active failure
 * recovery, repeating/pending schedules, and legacy tickets lacking `originTopicId`.
 */
export function findBlockingMainArchiveTickets(
  state: Readonly<KuloDurableState>,
  oldConvId: number,
): TicketRecord[] {
  return Object.values(state.tickets).filter((ticket) => {
    const originTopicId = ticket.originTopicId ?? "root";
    const originConvId = ticket.originConversationId;
    const belongsToOldRoot =
      originTopicId === "root" &&
      (originConvId === undefined ? oldConvId === Number(ROOT_CONVERSATION_ID) : originConvId === oldConvId);
    if (!belongsToOldRoot && originConvId !== oldConvId) return false;
    return (
      isTicketUnfinished(ticket) ||
      hasPendingWorkspaceApply(ticket) ||
      Boolean(ticket.cleanupPending) ||
      Boolean(ticket.finalRelayPending) ||
      ticket.recovery?.state === "recovering" ||
      Boolean(
        ticket.schedule &&
        ticket.schedule.deletedAt === undefined &&
        (ticket.schedule.nextRunAt != null || (ticket.schedule.repeatEverySeconds && ticket.status === "ready")),
      )
    );
  });
}

export function allocateArchivedRootTopicId(
  state: Readonly<KuloDurableState>,
  oldConvId: number,
  now: number,
): string {
  const base = `topic-archive-${oldConvId}`;
  if (!state.topics?.[base]) return base;
  let candidate = `${base}-${now}`;
  let seq = 2;
  while (state.topics?.[candidate]) {
    candidate = `${base}-${now}-${seq++}`;
  }
  return candidate;
}

export function formatArchivedRootTitle(now: number, existingTitles: ReadonlySet<string>): string {
  const d = new Date(now);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const base = `主对话归档 · ${yyyy}-${mm}-${dd}`;
  if (!existingTitles.has(base)) return base;
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const withTime = `${base} ${hh}:${min}`;
  if (!existingTitles.has(withTime)) return withTime;
  let seq = 2;
  while (existingTitles.has(`${withTime} (${seq})`)) seq += 1;
  return `${withTime} (${seq})`;
}
