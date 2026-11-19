import type { SlotSummary, TicketCardView } from "./domain.js";

export interface TicketBoardDelta {
  previousRevision: number;
  ticketRevision: number;
  upsert: TicketCardView[];
  removed: string[];
  slots: SlotSummary;
}

export function compareTicketCards(a: TicketCardView, b: TicketCardView): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Merge by snapshot order, retaining references and relative order for unchanged cards. */
export function applyTicketBoardDelta(current: TicketCardView[], delta: TicketBoardDelta): TicketCardView[] {
  if (!delta.upsert.length && !delta.removed.length) return current;
  const replaced = new Set([...delta.removed, ...delta.upsert.map(ticket => ticket.id)]);
  const updated = [...delta.upsert].sort(compareTicketCards);
  const result: TicketCardView[] = [];
  let next = 0;
  for (const card of current) {
    if (replaced.has(card.id)) continue;
    while (next < updated.length && compareTicketCards(updated[next]!, card) < 0) result.push(updated[next++]!);
    result.push(card);
  }
  while (next < updated.length) result.push(updated[next++]!);
  return result;
}
