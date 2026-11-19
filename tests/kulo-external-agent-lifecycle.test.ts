import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ExternalAgentResponse, ExternalAgentRun, TicketRecord } from "@kulo/protocol";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-external-lifecycle-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const models = createModels();
  const provider = fauxProvider({ provider: "openai", models: [{ id: "lifecycle-model" }] });
  const modelCalls = vi.fn(() => fauxAssistantMessage([fauxText("Synthetic response")]));
  provider.setResponses(Array.from({ length: 40 }, () => modelCalls));
  models.setProvider(provider.provider);
  const config = { stateDir: path.join(root, "state"), identityDir: path.join(root, "identity"),
    localEnvRoot: path.join(root, "runtime"), enableLocalEnv: false, watchdogMinutes: 0,
    memory: { enabled: false }, model: { defaultProvider: "openai", defaultModel: "lifecycle-model", thinkingLevel: "off" as const, apiKey: "" } };
  const open = async () => {
    const hub = await openTestHub({ config, models });
    cleanups.push(() => hub.close());
    return hub;
  };
  const hub = await open();
  const add = async (id: string, overrides: Partial<TicketRecord> = {}) => {
    const conversation = await hub.harness.createConversation({ ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: "lifecycle-model" }, tools: [] } }, context);
    const now = Date.now();
    const ticket: TicketRecord = { id, commandId: `dispatch:${id}`, title: id, goal: "Synthetic lifecycle task", scope: "test",
      role: "coder", status: "running", envId: "device-test", workspaceDir: path.join(root, "workspace"),
      workerConversationId: Number(conversation.id), runEpoch: 4, createdAt: now, updatedAt: now,
      startedRunningAt: now, externalExecution: { binding: { kind: "codex", envId: "device-test" },
        runId: `run:${id}:4`, sessionId: `native:${id}` }, ...overrides };
    await hub.harness.commit(async tx => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets[id] = ticket;
      if (ticket.status === "running") state.slots.holders.push(id);
    }, context);
    return ticket;
  };
  const ticket = async (id: string) => (await hub.harness.snapshot(KuloStateDoc, context))!.tickets[id]!;
  return { hub, add, ticket, modelCalls, open };
}

function response(ticket: TicketRecord, state: ExternalAgentRun["state"] = "cancelled", quiescent = true): ExternalAgentResponse {
  return { type: "run", run: { id: ticket.externalExecution!.runId!, taskId: ticket.id, runEpoch: ticket.runEpoch,
    kind: "codex", state, text: "", events: [], permissions: [], nextSequence: 1, quiescent } };
}

describe("external agent ticket lifecycle", () => {
  it.each([false, true])("queues running-task guidance without replacing its native run (waiting=%s)", async waiting => {
    const f = await fixture(); const initial = await f.add("external-steer", waiting ? { waiting: { reason: "user", since: Date.now() } } : {});
    const native = vi.spyOn(f.hub.envManager, "requestExternalAgent");
    await f.hub.steerTicket({ ticketId: initial.id, text: "Also inspect the regression", commandId: "steer:one" });
    const current = await f.ticket(initial.id);
    expect(current.status).toBe("running");
    expect(current.runEpoch).toBe(4);
    expect(current.externalExecution?.runId).toBe(initial.externalExecution?.runId);
    expect(current.externalExecution?.sessionId).toBe(initial.externalExecution?.sessionId);
    expect(current.resumePrompt).toContain("Also inspect the regression");
    expect(current.wakePending).toBe(true);
    expect(f.modelCalls).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("rejects unsupported attachments before accepting a steer", async () => {
    const f = await fixture(); const initial = await f.add("external-attachment");
    await expect(f.hub.steerTicket({ ticketId: initial.id, text: "Inspect this", attachments: [{} as never] }))
      .rejects.toMatchObject({ code: "external_agent_attachments_unsupported" });
    expect((await f.ticket(initial.id)).resumePrompt).toBeUndefined();
  });

  it("cancels and closes only the owned external run, without workspace-wide Pi cleanup", async () => {
    const f = await fixture(); const initial = await f.add("external-stop");
    const native = vi.spyOn(f.hub.envManager, "requestExternalAgent").mockImplementation(async () => response(initial));
    const legacy = vi.spyOn(f.hub.envManager, "releaseWorkerExecutionEnv");
    await f.hub.stopTicket(initial.id, "User stopped the task");
    expect(native.mock.calls.map(([, request]) => request)).toEqual([
      { operation: "cancel", runId: initial.externalExecution!.runId },
      { operation: "close", runId: initial.externalExecution!.runId },
    ]);
    expect(legacy).not.toHaveBeenCalled();
    expect(await f.ticket(initial.id)).toMatchObject({ status: "stopped", runEpoch: 5, cleanupPending: false });
  });

  it.each(["uncertain", "cancelled"] as const)("retains cleanupPending for %s without process quiescence", async state => {
    const f = await fixture(); const initial = await f.add("external-uncertain");
    vi.spyOn(f.hub.envManager, "requestExternalAgent").mockImplementation(async () => response(initial, state, false));
    await f.hub.stopTicket(initial.id, "Stop uncertain task");
    expect(await f.ticket(initial.id)).toMatchObject({ status: "stopped", cleanupPending: true });
  });

  it.each([true, false])("stops owned child tickets and retains their cleanup state (quiescent=%s)", async quiescent => {
    const f = await fixture(); const parent = await f.add("external-parent");
    const child = await f.add("external-child", { parentTicketId: parent.id });
    const calls: string[] = [];
    vi.spyOn(f.hub.envManager, "requestExternalAgent").mockImplementation(async (_env, request) => {
      const target = "runId" in request && request.runId === child.externalExecution!.runId ? child : parent;
      calls.push(`${target.id}:${request.operation}`); return response(target, "cancelled", target === parent || quiescent);
    });
    await f.hub.stopTicket(parent.id, "Stop parent and descendants");
    expect((await f.ticket(child.id)).status).toBe("stopped");
    expect((await f.ticket(parent.id)).cleanupPending).toBe(!quiescent);
    expect(calls).toEqual([`${child.id}:cancel`, `${child.id}:close`, `${parent.id}:cancel`, `${parent.id}:close`]);
  });

  it("retains an Env-owned running attempt across a Hub restart without prompt replay", async () => {
    const f = await fixture(); const initial = await f.add("external-restart");
    await f.hub.close(); const reopened = await f.open();
    const current = (await reopened.harness.snapshot(KuloStateDoc, context))!.tickets[initial.id]!;
    expect(current).toMatchObject({ status: "running", runEpoch: 4, externalExecution: initial.externalExecution });
    expect(current.cleanupPending).not.toBe(true);
    expect(f.modelCalls).not.toHaveBeenCalled();
  });

  it("does not park a live external attempt during an execution-device disconnection", async () => {
    const f = await fixture(); const initial = await f.add("external-offline");
    const requests = vi.spyOn(f.hub.envManager, "requestExternalAgent");
    const changed = new Promise<void>(resolve => {
      const unsubscribe = f.hub.subscribe({ onTickets: () => { unsubscribe(); resolve(); } });
    });
    f.hub.envManager.setDeviceDisplayName("device-test", "Disconnected test device");
    await changed;
    expect(await f.ticket(initial.id)).toMatchObject({ status: "running", runEpoch: 4, externalExecution: initial.externalExecution });
    expect(requests).not.toHaveBeenCalled();
  });
});
