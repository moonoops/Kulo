import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { Harness } from "@earendil-works/pi-durable";
import { compareTicketCards, type ExternalClientConnection, type RolePreset, type SlotSummary, type TicketBoardDelta, type TicketCardView } from "@kulo/protocol";
import { redactCredentialData } from "./credential-redaction.js";
import { computeSlotSummary, hasPendingWorkspaceApply, KuloStateDoc, toTicketCardView, type KuloDurableState } from "./state.js";
import { aggregateTicketSubagentSummaries } from "./subagent-runner.js";

function sameVoiceAnnouncementFields(a: TicketCardView, b: TicketCardView): boolean {
  return (
    a.status === b.status &&
    a.stoppedReason === b.stoppedReason &&
    a.pendingWorkspaceApply === b.pendingWorkspaceApply &&
    isDeepStrictEqual(a.latestReport, b.latestReport) &&
    isDeepStrictEqual(a.waiting, b.waiting) &&
    isDeepStrictEqual(a.closure, b.closure) &&
    isDeepStrictEqual(a.recovery, b.recovery)
  );
}

/** Derived from committed Durable changes. Full snapshots and deltas share the same revision. */
export class TicketBoardProjection {
  #state?: Readonly<KuloDurableState>;
  #lastProjected?: Readonly<KuloDurableState>;
  #observation?: { detach(): void };
  #failure?: Error;
  #dirty?: Set<string>;
  #roles?: Record<string, RolePreset>;
  #externalClients?: Record<string, ExternalClientConnection>;
  #redactionRevision = -1;
  #revision = 0;
  #slots: SlotSummary = { used: 0, max: 0, queuedCount: 0 };
  readonly #queued = new Set<string>();
  readonly cleanupCandidates = new Set<string>();
  readonly #replacements = new Map<string, Set<string>>();
  readonly #cards = new Map<string, TicketCardView>();
  #ordered?: TicketCardView[];
  #wake?: NodeJS.Immediate;

  async open(harness: Harness, changed: () => void, context: Context): Promise<void> {
    const observation = await harness.observeDoc(KuloStateDoc, {
      advance: (call) => {
        if (call.kind !== "value") return;
        this.#state = call.value;
        if (this.#recordChanges(call.ops) && !this.#wake) {
          // Observers run on the storage commit line. Notify services after publication.
          this.#wake = setImmediate(() => { this.#wake = undefined; changed(); });
        }
      },
      end: (end) => {
        this.#failure = end.kind === "failed" && end.error instanceof Error ? end.error : new Error("Ticket board observation ended");
      },
    }, context);
    if (!observation) throw new Error("Ticket board state is missing");
    this.#observation = observation;
    this.#state ??= observation.value;
  }

  #recordChanges(ops: readonly Op[]): boolean {
    let changed = false;
    for (const op of ops) {
      if (op[0] === "r" || !op[1].length || (op[1][0] === "tickets" && op[1].length === 1)) {
        this.#dirty = undefined;
        return true;
      }
      const [field, id] = op[1];
      if (field === "tickets" && typeof id === "string") { this.#dirty?.add(id); changed = true; }
      if (field === "subagents") {
        if (typeof id === "string") {
          const parentId = this.#state?.subagents?.[id]?.ticketId ?? this.#lastProjected?.subagents?.[id]?.ticketId;
          if (parentId) { this.#dirty?.add(parentId); changed = true; }
          else { this.#dirty = undefined; return true; }
        } else {
          this.#dirty = undefined;
          return true;
        }
      }
      if (field === "slots") changed = true;
    }
    return changed;
  }

  replacementsOf(id: string) {
    return Array.from(this.#replacements.get(id) ?? [], child => this.#lastProjected!.tickets[child]!);
  }

  refresh(roles: Record<string, RolePreset>, maxWorkers: number, currentRedactionRevision: () => number, redact: (text: string) => string, externalClients?: Record<string, ExternalClientConnection>) {
    if (this.#failure) throw this.#failure;
    const state = this.#state;
    if (!state) throw new Error("Ticket board is not ready");
    const allIds = () => new Set([...this.#cards.keys(), ...Object.keys(state.tickets)]);
    let redactionRevision = currentRedactionRevision();
    let ids = this.#dirty && roles === this.#roles && externalClients === this.#externalClients && this.#redactionRevision === redactionRevision ? this.#dirty : allIds();
    const upsert: TicketCardView[] = [];
    const removed: string[] = [];
    const voiceChanges = new Set<string>();
    const subagentSummaries = ids.size > 0 ? aggregateTicketSubagentSummaries(state) : new Map();
    for (;;) {
      for (const id of ids) {
        const ticket = Object.hasOwn(state.tickets, id) ? state.tickets[id] : undefined;
        if (
          !ticket ||
          ticket.deliveryClaim === "inline_waiting" ||
          (ticket.deliveryClaim === "claimed_inline" && !hasPendingWorkspaceApply(ticket))
        ) {
          if (this.#cards.has(id)) removed.push(id);
          continue;
        }
        const card = redactCredentialData(
          toTicketCardView(ticket, roles, externalClients, subagentSummaries.get(id)),
          redact,
        );
        if (!isDeepStrictEqual(this.#cards.get(id), card)) upsert.push(card);
      }
      const now = currentRedactionRevision();
      if (now === redactionRevision) break;
      // Reading one card can identify a credential also used in a different card.
      redactionRevision = now;
      ids = allIds();
      upsert.length = 0;
      removed.length = 0;
    }
    // Publish the derived indexes only after every changed card has been projected successfully.
    for (const id of ids) {
      const ticket = Object.hasOwn(state.tickets, id) ? state.tickets[id] : undefined;
      if (ticket?.status === "queued") this.#queued.add(id); else this.#queued.delete(id);
      if (ticket?.cleanupPending) this.cleanupCandidates.add(id); else this.cleanupCandidates.delete(id);
      const oldParents = this.#lastProjected?.tickets[id]?.supersedes ?? [];
      const parents = ticket?.supersedes ?? [];
      for (const parent of oldParents) {
        voiceChanges.add(parent);
        if (parents.includes(parent)) continue;
        const children = this.#replacements.get(parent);
        children?.delete(id);
        if (!children?.size) this.#replacements.delete(parent);
      }
      for (const parent of parents) {
        voiceChanges.add(parent);
        let children = this.#replacements.get(parent);
        if (!children) this.#replacements.set(parent, children = new Set());
        children.add(id);
      }
    }
    for (const id of removed) this.#cards.delete(id);
    for (const card of upsert) {
      const prev = this.#cards.get(card.id);
      this.#cards.set(card.id, card);
      if (!prev || !sameVoiceAnnouncementFields(prev, card)) voiceChanges.add(card.id);
    }
    // A replacement can wake a silent failure anywhere in its own chain.
    for (const id of voiceChanges) for (const parent of state.tickets[id]?.supersedes ?? []) voiceChanges.add(parent);
    this.#lastProjected = state;
    this.#dirty = new Set();
    this.#roles = roles;
    this.#externalClients = externalClients;
    this.#redactionRevision = redactionRevision;
    const slots = computeSlotSummary(state, maxWorkers, this.#queued.size);
    let delta: TicketBoardDelta | undefined;
    if (upsert.length || removed.length || !isDeepStrictEqual(this.#slots, slots)) {
      if (upsert.length || removed.length) this.#ordered = undefined;
      const previousRevision = this.#revision++;
      this.#slots = slots;
      delta = { previousRevision, ticketRevision: this.#revision, upsert, removed, slots };
    }
    return { state, delta, voiceChanges };
  }

  snapshot() {
    this.#ordered ??= [...this.#cards.values()].sort(compareTicketCards);
    // Existing Hub consumers own the snapshot they receive, including nested report data.
    return structuredClone({ tickets: this.#ordered, slots: this.#slots, ticketRevision: this.#revision });
  }

  close(): void {
    this.#observation?.detach();
    if (this.#wake) clearImmediate(this.#wake);
  }
}
