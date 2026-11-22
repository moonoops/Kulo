import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { KuloStateDoc, type KuloHub } from "@kulo/hub";
import {
  ActionConfirmationsDoc,
  buildTicketDecisionCard,
  ticketDecisionFingerprint,
} from "../packages/hub/src/action-confirmations.js";
import {
  clientDeliveryIntent,
  DeliveryReceiptDoc,
  deliveryReceiptKey,
} from "../packages/hub/src/delivery-receipts.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { UiCardsDoc } from "../packages/hub/src/ui-cards.js";
import { openTestHub } from "./helpers/secure-hub.js";

const dirs: string[] = [];
const hubs: KuloHub[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-control-inv-${prefix}-`));
  dirs.push(dir);
  return dir;
}

async function createTestHub(prefix: string): Promise<KuloHub> {
  const dir = tempDir(prefix);
  const provider = fauxProvider();
  provider.setResponses([() => fauxAssistantMessage([fauxText("ok")])]);
  const hub = await openTestHub({
    config: {
      stateDir: path.join(dir, "state"),
      rootDir: path.join(dir, "work"),
      authToken: "test-token",
      providerId: provider.id,
      modelId: provider.models[0]!.id,
      inlineDispatchWaitMs: 0,
    },
    models: createModels([provider]),
  });
  hubs.push(hub);
  return hub;
}

const FUTURE_ISO = () => new Date(Date.now() + 3_600_000).toISOString();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0).reverse()) await hub.close().catch(() => {});
  for (const dir of dirs.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Ticket control invariants (v3 plan §4)", () => {
  it("recovers idempotently when stop fails in the post-commit tail window after receipt completion", async () => {
    const hub = await createTestHub("tail");
    const created = await hub.dispatchTicket(
      {
        commandId: "cmd-dispatch-tail-1",
        title: "Tail recovery ticket",
        goal: "Test stop tail recovery",
        scope: "Work dir",
        executeAt: FUTURE_ISO(),
      },
      BACKGROUND_CONTEXT,
    );

    // Attach a pending decision confirmation card to the ticket while it is waiting.
    const built = buildTicketDecisionCard({
      title: "Tail decision",
      question: "Proceed or stop?",
      options: [
        { id: "go", label: "Proceed", tone: "primary" },
        { id: "halt", label: "Stop", tone: "secondary", action: "stop" },
      ],
    });
    const ensured = await hub.actionConfirmations.ensurePendingCard({
      conversationId: Number(hub.rootConversation.id),
      topicId: "root",
      kind: "ticket_decision",
      fingerprint: ticketDecisionFingerprint({
        ticketId: created.id,
        runEpoch: created.runEpoch,
        question: "Proceed or stop?",
        options: [
          { id: "go", label: "Proceed" },
          { id: "halt", label: "Stop" },
        ],
      }),
      payload: {
        kind: "ticket_decision",
        ticketId: created.id,
        runEpoch: created.runEpoch,
        question: "Proceed or stop?",
        options: [
          { id: "go", label: "Proceed", tone: "primary" },
          { id: "halt", label: "Stop", tone: "secondary", action: "stop" },
        ],
      },
      cardInput: built.input,
      logicalIds: built.logicalIds,
    });
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[created.id]!;
      t.schedule = undefined;
      t.status = "waiting";
      t.waiting = {
        reason: "user",
        since: Date.now(),
        detail: "Proceed or stop?",
        cardId: ensured.card.cardId,
        requestId: ensured.confirmation.id,
      };
    }, BACKGROUND_CONTEXT);

    // Inject a one-shot failure on the post-commit card settlement steps.
    const origSettlePending = hub.actionConfirmations.settlePendingForTicket.bind(hub.actionConfirmations);
    let injectedFail = true;
    vi.spyOn(hub.actionConfirmations, "settlePendingForTicket").mockImplementation(async (...args) => {
      if (injectedFail) {
        injectedFail = false;
        throw new Error("Simulated transient tail failure after final stop commit");
      }
      return origSettlePending(...args);
    });
    const origUiSettle = hub.uiCards.settle.bind(hub.uiCards);
    let injectedUiFail = true;
    vi.spyOn(hub.uiCards, "settle").mockImplementation(async (...args) => {
      if (injectedUiFail) {
        injectedUiFail = false;
        throw new Error("Simulated transient UI card settle failure");
      }
      return origUiSettle(...args);
    });

    const intent = clientDeliveryIntent({
      type: "ticket.stop",
      ticketId: created.id,
      commandId: "cmd-stop-tail-1",
      reason: "User stopped during tail test",
    });

    // Attempt 1: final tx commits receipt + releases slot, then tail settlement fails.
    await expect(
      hub.stopTicket(created.id, "User stopped during tail test", BACKGROUND_CONTEXT, "cmd-stop-tail-1", undefined, intent),
    ).rejects.toThrow(/Simulated transient/);

    const afterAttempt1 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const projectsAfter1 = await hub.harness.snapshot(KuloProjectsDoc, BACKGROUND_CONTEXT);
    const receiptAfter1 = await hub.harness.snapshot(DeliveryReceiptDoc, intent!.key, BACKGROUND_CONTEXT);
    const confirmAfter1 = await hub.harness.snapshot(ActionConfirmationsDoc, BACKGROUND_CONTEXT);
    const uiAfter1 = await hub.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);

    expect(afterAttempt1?.tickets[created.id]?.status).toBe("stopped");
    expect(afterAttempt1?.slots.holders).not.toContain(created.id);
    expect(projectsAfter1?.cancellations?.[created.id]).toBeUndefined();
    expect(receiptAfter1?.phase).toBe("complete");
    expect(confirmAfter1?.byId?.[ensured.confirmation.id]?.status).toBe("pending");
    expect(uiAfter1?.cards?.[ensured.card.cardId]?.status).toBe("ready");
    const epochAfterAttempt1 = afterAttempt1!.tickets[created.id]!.runEpoch;

    // Attempt 2: replay with the exact same intent recovers tail card settlement idempotently without bumping epoch.
    const replayed = await hub.stopTicket(
      created.id,
      "User stopped during tail test",
      BACKGROUND_CONTEXT,
      "cmd-stop-tail-1",
      undefined,
      intent,
    );
    expect(replayed.status).toBe("stopped");

    const afterAttempt2 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(afterAttempt2?.tickets[created.id]?.runEpoch).toBe(epochAfterAttempt1);

    const confirmAfter2 = await hub.harness.snapshot(ActionConfirmationsDoc, BACKGROUND_CONTEXT);
    const uiAfter2 = await hub.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    expect(confirmAfter2?.byId?.[ensured.confirmation.id]?.status).toBe("denied");
    expect(uiAfter2?.cards?.[ensured.card.cardId]?.status).toBe("cancelled");
  });

  it("stops parent/child tickets concurrently and guards self-referencing parentTicketId without deadlock", async () => {
    const hub = await createTestHub("parent-child");
    const parent = await hub.dispatchTicket(
      { commandId: "cmd-p-1", title: "Parent ticket", goal: "Parent", scope: "Parent scope", executeAt: FUTURE_ISO() },
      BACKGROUND_CONTEXT,
    );
    const child = await hub.dispatchTicket(
      { commandId: "cmd-c-1", title: "Child ticket", goal: "Child", scope: "Child scope", executeAt: FUTURE_ISO() },
      BACKGROUND_CONTEXT,
    );
    const selfRef = await hub.dispatchTicket(
      { commandId: "cmd-self-1", title: "Self-ref ticket", goal: "Self-ref", scope: "Self-ref scope", executeAt: FUTURE_ISO() },
      BACKGROUND_CONTEXT,
    );

    // Wire parent -> child and corrupted self-reference selfRef -> selfRef.
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[child.id]!.parentTicketId = parent.id;
      state.tickets[selfRef.id]!.parentTicketId = selfRef.id;
      state.tickets[parent.id]!.schedule = undefined;
      state.tickets[child.id]!.schedule = undefined;
      state.tickets[selfRef.id]!.schedule = undefined;
    }, BACKGROUND_CONTEXT);

    const [stoppedParent, stoppedChild, stoppedSelf] = await Promise.all([
      hub.stopTicket(parent.id, "stop parent", BACKGROUND_CONTEXT, "cmd-stop-parent"),
      hub.stopTicket(child.id, "stop child", BACKGROUND_CONTEXT, "cmd-stop-child"),
      hub.stopTicket(selfRef.id, "stop self", BACKGROUND_CONTEXT, "cmd-stop-self"),
    ]);

    expect(stoppedParent.status).toBe("stopped");
    expect(stoppedChild.status).toBe("stopped");
    expect(stoppedSelf.status).toBe("stopped");
    expect(stoppedParent.cleanupPending).toBeFalsy();
    expect(stoppedChild.cleanupPending).toBeFalsy();
    expect(stoppedSelf.cleanupPending).toBeFalsy();
  });

  it("triggers queueEnvReconcile fire-and-forget from steer inside ticket queue without deadlocking", async () => {
    const hub = await createTestHub("reconcile-order");
    const ticket = await hub.dispatchTicket(
      { commandId: "cmd-rec-1", title: "Reconcile ticket", goal: "Reconcile", scope: "Reconcile scope", executeAt: FUTURE_ISO() },
      BACKGROUND_CONTEXT,
    );

    // Gate env cleanup so queueEnvReconcile runs deterministically after steerTicket returns,
    // proving steer inside queueTicket(id) never awaits queueEnvReconcile (which re-enters steerTicket).
    const origRelease = hub.envManager.releaseWorkerExecutionEnv.bind(hub.envManager);
    let releaseEnteredResolve!: () => void;
    const releaseEntered = new Promise<void>((r) => { releaseEnteredResolve = r; });
    let allowReleaseResolve!: () => void;
    const allowRelease = new Promise<void>((r) => { allowReleaseResolve = r; });
    vi.spyOn(hub.envManager, "releaseWorkerExecutionEnv").mockImplementation(async (...args) => {
      releaseEnteredResolve();
      await allowRelease;
      return origRelease(...args);
    });

    // Put ticket in a settled state with cleanupPending=true and online env so steer parks in waiting
    // and fires queueEnvReconcile() which then cleans up and wakes the ticket via steerTicket().
    const initialSnap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const activeTaskId = initialSnap?.tickets[ticket.id]?.activeTaskId;
    if (activeTaskId !== undefined) await hub.harness.abortTask(activeTaskId as never, BACKGROUND_CONTEXT);
    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const t = state.tickets[ticket.id]!;
      t.schedule = undefined;
      t.status = "ready";
      t.cleanupPending = true;
      t.waiting = undefined;
      t.wakePending = undefined;
      t.activeTaskId = undefined;
      state.slots.holders = state.slots.holders.filter((id) => id !== ticket.id);
    }, BACKGROUND_CONTEXT);

    const beforeSteer = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(beforeSteer?.tickets[ticket.id]?.status).toBe("ready");
    expect(beforeSteer?.tickets[ticket.id]?.cleanupPending).toBe(true);

    const steered = await hub.steerTicket(
      {
        ticketId: ticket.id,
        commandId: "cmd-steer-reconcile-1",
        text: "Continue once old execution cleanup finishes",
      },
      BACKGROUND_CONTEXT,
    );
    expect(steered.status).toBe("waiting");
    expect(steered.cleanupPending).toBe(true);

    // Wait for background queueEnvReconcile to enter releaseWorkerExecutionEnv, then let it finish.
    await releaseEntered;
    allowReleaseResolve();

    // Background reconcile must clear cleanupPending and wake the ticket cleanly with zero deadlock.
    await vi.waitFor(async () => {
      const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const live = state?.tickets[ticket.id];
      expect(live?.cleanupPending).toBe(false);
      expect(live?.status).not.toBe("waiting");
    }, { timeout: 5000, interval: 25 });
  });
});
