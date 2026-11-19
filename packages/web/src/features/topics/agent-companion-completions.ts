import type { LiveStreamState, TicketCardView, TicketStatus } from "@moco/protocol";
import { agentProfileCompletions } from "./agent-profile-state";
import type { AgentTerminalEntry } from "./agent-terminal-state";

export interface CompanionCompletionSnapshot {
  scope: string;
  connected: boolean;
  live?: LiveStreamState;
  tickets: readonly TicketCardView[];
  entries: readonly AgentTerminalEntry[];
}

export interface CompanionCompletionObservation {
  eventId?: string;
  reset: boolean;
}

const activeStatuses = new Set<TicketStatus>(["queued", "running", "pausing", "waiting", "blocked"]);

function liveSettlement(entries: readonly AgentTerminalEntry[]): AgentTerminalEntry | undefined {
  return entries.findLast((entry) => entry.outcome && !(entry.eventId ?? entry.id).startsWith("ticket:"));
}

function settlementId(entry: AgentTerminalEntry | undefined): string | undefined {
  return entry && (entry.eventId ?? `${entry.id}:${entry.outcome}`);
}

export class CompanionCompletionTracker {
  private scope: string;
  private connected: boolean;
  private busy: boolean;
  private pendingLiveCompletion = false;
  private seen: Set<string>;
  private tickets: Map<string, TicketStatus>;
  private liveSettlementId?: string;

  constructor(snapshot: CompanionCompletionSnapshot) {
    this.scope = snapshot.scope;
    this.connected = snapshot.connected;
    this.busy = snapshot.connected && Boolean(snapshot.live?.busy);
    this.seen = new Set(agentProfileCompletions(snapshot).map((event) => event.eventId));
    this.tickets = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket.status]));
    this.liveSettlementId = settlementId(liveSettlement(snapshot.entries));
  }

  observe(snapshot: CompanionCompletionSnapshot): CompanionCompletionObservation {
    const reset = snapshot.scope !== this.scope || snapshot.connected !== this.connected;
    const completions = agentProfileCompletions(snapshot);
    const seen = new Set(completions.map((event) => event.eventId));
    const tickets = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket.status]));
    const latestLiveSettlement = liveSettlement(snapshot.entries);
    const latestLiveSettlementId = settlementId(latestLiveSettlement);
    let eventId: string | undefined;

    if (reset || !snapshot.connected) {
      this.busy = snapshot.connected && Boolean(snapshot.live?.busy);
      this.pendingLiveCompletion = false;
    } else {
      const busy = snapshot.live?.busy ?? this.busy;
      const newUnsuccessfulSettlement = latestLiveSettlement && latestLiveSettlementId !== this.liveSettlementId && latestLiveSettlement.outcome !== "completed";
      if (snapshot.live?.runFailure || newUnsuccessfulSettlement || busy) this.pendingLiveCompletion = false;
      // The matching journal settlement may follow the live busy-to-idle update.
      else if (this.busy && !busy) this.pendingLiveCompletion = true;

      const newlyReady = snapshot.tickets.filter((ticket) => {
        const previous = this.tickets.get(ticket.id);
        return ticket.status === "ready" && previous !== undefined && activeStatuses.has(previous);
      });
      const eligible = new Set(agentProfileCompletions({ tickets: newlyReady, entries: [] }).map((event) => event.eventId));
      if (this.pendingLiveCompletion) {
        const liveCompletions = completions.filter((event) => !event.eventId.startsWith("ticket:") && !this.seen.has(event.eventId));
        for (const completion of liveCompletions) eligible.add(completion.eventId);
        if (liveCompletions.length) this.pendingLiveCompletion = false;
      }
      eventId = completions.find((completion) => eligible.has(completion.eventId) && !this.seen.has(completion.eventId))?.eventId;
      this.busy = busy;
    }

    this.scope = snapshot.scope;
    this.connected = snapshot.connected;
    this.seen = seen;
    this.tickets = tickets;
    this.liveSettlementId = latestLiveSettlementId;
    return eventId ? { eventId, reset } : { reset };
  }
}
