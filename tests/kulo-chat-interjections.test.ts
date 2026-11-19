import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { KuloHub, startKuloHubServer } from "@kulo/hub";
import type { ClientToHubMessage, HubToClientMessage } from "@kulo/protocol";
import WebSocket from "ws";
import { queuedChatEntries } from "../packages/hub/src/chat-submissions.js";
import { submitAutomaticChatInput } from "../packages/hub/src/chat-control.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_AUTH_TOKEN", "KULO_ENV_TOKENS", "KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function waitForRelease(promise: Promise<void>, signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => { signal?.removeEventListener("abort", done); resolve(); };
    signal?.addEventListener("abort", done, { once: true });
    void promise.then(done);
  });
}
function orchestrator(context: TranscriptContext): boolean {
  return Boolean(context.tools?.some((tool) => tool.name === "kulo_dispatch") || context.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === "kulo_dispatch")));
}
async function fixture(response: FauxResponseFactory, existingDir?: string, localEnv = false) {
  const stateDir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "kulo-interjections-"));
  if (!existingDir) cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "interjection-model", input: ["text", "image"] }] });
  provider.setResponses(Array.from({ length: 50 }, () => response));
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir, identityDir: path.join(stateDir, "identity"), enableLocalEnv: localEnv,
    workerEnvIds: [], watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "interjection-model", thinkingLevel: "off", apiKey: "", baseUrl: "http://127.0.0.1:9/v1" },
  } });
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); await hub.close(); } };
  cleanup.push(close);
  return { hub, server, stateDir, close };
}
async function client(f: Awaited<ReturnType<typeof fixture>>) {
  const received: HubToClientMessage[] = [];
  const ws = new WebSocket(f.server.clientWsUrl, { headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
  ws.on("message", (raw) => received.push(JSON.parse(raw.toString()) as HubToClientMessage));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const close = () => new Promise<void>((resolve) => { if (ws.readyState === WebSocket.CLOSED) return resolve(); ws.once("close", resolve); ws.close(); });
  cleanup.push(close);
  async function wait<T extends HubToClientMessage["type"]>(type: T, predicate: (message: Extract<HubToClientMessage, { type: T }>) => boolean = () => true) {
    let found: Extract<HubToClientMessage, { type: T }> | undefined;
    await vi.waitFor(() => { found = received.find((message): message is Extract<HubToClientMessage, { type: T }> => message.type === type && predicate(message as Extract<HubToClientMessage, { type: T }>)); expect(found).toBeDefined(); }, { timeout: 6000, interval: 15 });
    return found!;
  }
  await wait("hub.snapshot");
  return { received, wait, close, send: (message: ClientToHubMessage) => ws.send(JSON.stringify(message)) };
}
async function settled(hub: KuloHub, test: (view: Awaited<ReturnType<KuloHub["getTopicView"]>>) => void) {
  await vi.waitFor(async () => { const view = await hub.getTopicView("root"); expect(view.live.busy).toBe(false); test(view); }, { timeout: 7000, interval: 20 });
}

describe("durable chat interjections", () => {
  it("shows every busy receipt across clients, deduplicates retries, then places it once without polluting search history", async () => {
    const first = gate(); const entered = gate(); let calls = 0;
    const f = await fixture(async (context, options) => {
      if (!orchestrator(context)) return fauxAssistantMessage("标题");
      calls += 1;
      if (calls === 1) { entered.release(); await waitForRelease(first.promise, options?.signal); }
      return fauxAssistantMessage(options?.signal?.aborted ? "" : `answer-${calls}`, { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
    });
    await f.hub.sendUserMessage("first", { requestId: "first" }); await entered.promise;
    const c = await client(f);
    c.send({ type: "chat.send", topicId: "root", content: "second", requestId: "second" });
    c.send({ type: "chat.send", topicId: "root", content: "third", requestId: "third" });
    const secondAck = await c.wait("hub.ack", (message) => message.requestId === "second");
    const thirdAck = await c.wait("hub.ack", (message) => message.requestId === "third");
    expect(secondAck).toMatchObject({ delivery: "queued", submissionId: expect.any(Number) });
    expect(thirdAck.submissionId).toBeGreaterThan(secondAck.submissionId!);
    const queued = (await f.hub.getTopicView("root")).messages;
    expect(queued.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["first", "second", "third"]);
    expect(new Set(queued.map((message) => message.id)).size).toBe(queued.length);
    const receipt = queued.find((message) => message.requestId === "second")!;
    expect(receipt).toMatchObject({ id: -secondAck.submissionId!, submissionId: secondAck.submissionId, delivery: "queued" });
    await c.close();
    const reconnected = await client(f);
    const snapshot = await reconnected.wait("hub.snapshot");
    expect(snapshot.messages.filter((message) => message.delivery === "queued").map((message) => message.requestId)).toEqual(["second", "third"]);
    expect(snapshot.historyBefore === undefined || snapshot.historyBefore > 0).toBe(true);
    reconnected.send({ type: "chat.send", topicId: "root", content: "second", requestId: "second" });
    const duplicate = await reconnected.wait("hub.ack", (message) => message.requestId === "second");
    expect(duplicate).toMatchObject({ deduplicated: true, submissionId: secondAck.submissionId, delivery: "queued" });
    first.release();
    await settled(f.hub, (view) => {
      const users = view.messages.filter((message) => message.role === "user");
      expect(users.map((message) => message.requestId)).toEqual(["first", "second", "third"]);
      expect(users.every((message) => message.id > 0 && message.delivery === undefined)).toBe(true);
      expect(users.find((message) => message.requestId === "second")?.createdAt).toBe(receipt.createdAt);
      expect(view.messages.findIndex((message) => message.text === "answer-1")).toBeLessThan(view.messages.findIndex((message) => message.requestId === "second"));
      expect(new Set(view.messages.map((message) => message.id)).size).toBe(view.messages.length);
    });
    expect(calls).toBeGreaterThan(1);
  });

  it("reads a steer at the next native tool boundary", async () => {
    const first = gate(); const entered = gate(); const contexts: TranscriptContext[] = [];
    const f = await fixture(async (context, options) => {
      if (!orchestrator(context)) return fauxAssistantMessage("标题");
      contexts.push(context);
      if (contexts.length === 1) {
        entered.release(); await waitForRelease(first.promise, options?.signal);
        return fauxAssistantMessage([fauxToolCall("kulo_expression", { face: "thinking", cue: "处理中" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("done");
    });
    await f.hub.sendUserMessage("start", { requestId: "start" }); await entered.promise;
    await f.hub.sendUserMessage("include-this-now", { requestId: "steer" }); first.release();
    await settled(f.hub, (view) => expect(view.messages.some((message) => message.text === "done")).toBe(true));
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(contexts[1]?.messages)).toContain("include-this-now");
  });

  it("serializes stop after in-flight admission, keeps paused receipts durable, and continues without resending", async () => {
    const first = gate(); const entered = gate(); let calls = 0;
    const f = await fixture(async (context, options) => {
      if (!orchestrator(context)) return fauxAssistantMessage("标题");
      calls += 1; entered.release(); await waitForRelease(first.promise, options?.signal);
      return fauxAssistantMessage("", { stopReason: "aborted" });
    });
    await f.hub.sendUserMessage("start", { requestId: "start" }); await entered.promise;
    const preparing = gate(); const admit = gate();
    const process = f.hub.connectionManager.processText.bind(f.hub.connectionManager);
    vi.spyOn(f.hub.connectionManager, "processText").mockImplementation(async (text, options) => {
      if (text === "keep-this") { preparing.release(); await admit.promise; }
      return process(text, options);
    });
    const c = await client(f);
    const dedup = gate(); const checking = gate();
    vi.spyOn(f.hub, "hasSubmittedRequest").mockImplementationOnce(async () => { checking.release(); await dedup.promise; return false; });
    c.send({ type: "chat.send", topicId: "root", content: "keep-this", requestId: "kept" });
    await Promise.all([preparing.promise, checking.promise]);
    c.send({ type: "chat.abort", topicId: "root", requestId: "stop-kept" });
    admit.release(); await c.wait("hub.ack", (message) => message.requestId === "stop-kept");
    dedup.release();
    const ack = await c.wait("hub.ack", (message) => message.requestId === "kept");
    const queued = await f.hub.harness.submission(ack.submissionId! as never, BACKGROUND_CONTEXT);
    const record = await queued!.status(BACKGROUND_CONTEXT);
    expect(record.status).toBe("queued");
    await settled(f.hub, (view) => expect(view.messages.find((message) => message.requestId === "kept")).toMatchObject({ delivery: "paused", submissionId: Number(record.id) }));
    expect(calls).toBe(1);
    const automatic = ["result", "blocked", "permission", "recovery"].map((name) => ({ type: "input" as const,
      content: `deferred-${name}`, requestId: `automatic-${name}`, whenBusy: "followUp" as const,
    }));
    for (const draft of [...automatic, automatic[0]!]) await f.hub.harness.commit((tx) => submitAutomaticChatInput(tx, f.hub.rootConversation, draft), BACKGROUND_CONTEXT);
    expect((await f.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.pausedChats?.[String(f.hub.rootConversation.id)]).toHaveLength(4);
    await f.hub.sendUserMessage("keep-this", { requestId: "kept" });
    expect(calls).toBe(1);
    expect((await f.hub.getTopicView("root")).messages.find((message) => message.requestId === "kept")?.delivery).toBe("paused");
    await f.close();
    const contexts: TranscriptContext[] = [];
    const restored = await fixture((context) => { contexts.push(context); return fauxAssistantMessage("resumed"); }, f.stateDir);
    const paused = (await restored.hub.getTopicView("root")).messages.find((message) => message.requestId === "kept");
    expect(paused).toMatchObject({ delivery: "paused", submissionId: Number(record.id) });
    expect(await restored.hub.retryTurn("root", "resume-kept")).toEqual({ retried: true });
    await settled(restored.hub, (view) => {
      const kept = view.messages.filter((message) => message.requestId === "kept");
      expect(kept).toHaveLength(1); expect(kept[0]!.delivery).toBeUndefined();
      expect(kept[0]!.createdAt).toBe(paused?.createdAt);
      expect(view.messages.some((message) => message.text === "resumed")).toBe(true);
    });
    await vi.waitFor(() => expect(JSON.stringify(contexts.at(-1)?.messages)).toContain("deferred-recovery"), { timeout: 5000, interval: 15 });
    await settled(restored.hub, () => {});
    expect((await restored.hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))?.pausedChats?.[String(restored.hub.rootConversation.id)]).toBeUndefined();
    for (const draft of automatic) {
      const stored = await restored.hub.harness.commit((tx) => tx.submissionByRequest(restored.hub.rootConversation.id, draft.requestId), BACKGROUND_CONTEXT);
      expect(stored).toBeDefined();
    }
    const modelCalls = contexts.length;
    expect(await restored.hub.retryTurn("root", "resume-kept")).toEqual({ retried: true });
    expect(contexts).toHaveLength(modelCalls);
  });

  it("projects only user display receipts, never model-only or internal inbox content", () => {
    const view = { conversation: { id: 1 }, docs: { "pi.live": {}, "pi.inbox": { items: [
      { id: 1, mode: "steer", content: "private-model-prompt", entry: { kind: "kulo.user", data: { kuloContentVersion: 1, text: "visible", attachments: [], requestId: "one", createdAt: 123 } } },
      { id: 2, mode: "steer", content: "internal" },
      { id: 3, mode: "steer", content: "voice-private", entry: { kind: "kulo.voice.delegation", data: {} } },
      { id: 4, mode: "write", entry: { kind: "kulo.user", data: { kuloContentVersion: 1, text: "write", attachments: [] } } },
    ] } } } as unknown as ConversationView;
    const projected = queuedChatEntries(view);
    expect(projected.entries).toHaveLength(1);
    expect(projected.deliveries.get(-1)).toEqual({ delivery: "paused", submissionId: 1 });
    expect(JSON.stringify(projected.entries)).not.toContain("private");
  });

  it("applies attachment scope checks and credential redaction to queued receipts", async () => {
    const first = gate(); const entered = gate(); let calls = 0;
    const f = await fixture(async (context, options) => {
      if (!orchestrator(context)) return fauxAssistantMessage("标题");
      if (++calls === 1) { entered.release(); await waitForRelease(first.promise, options?.signal); }
      return fauxAssistantMessage("done");
    });
    await f.hub.sendUserMessage("start", { requestId: "asset-start" }); await entered.promise;
    const hidden = "synthetic-queued-secret-93851";
    f.hub.connectionManager.rememberSecrets([hidden]);
    const own = f.hub.uploads.saveUpload({ name: "own.txt", mimeType: "text/plain", bytes: Buffer.from("own file"), ownerId: "local" });
    const other = f.hub.uploads.saveUpload({ name: "other.txt", mimeType: "text/plain", bytes: Buffer.from("private file"), ownerId: "another-client" });
    await expect(f.hub.sendUserMessage("forbidden", { requestId: "forbidden", attachments: [other], principalId: "local" })).rejects.toMatchObject({ code: "attachment_forbidden" });
    await f.hub.sendUserMessage(`safe ${hidden}`, { requestId: "asset-owned", attachments: [own], principalId: "local" });
    await f.hub.rootConversation.submit({ type: "input", content: "model-only", whenBusy: "steer", requestId: "asset-forged", entry: {
      kind: "kulo.user", data: { kuloContentVersion: 1, text: "forged-safe", attachments: [other], requestId: "asset-forged", createdAt: Date.now() } as never,
    } }, BACKGROUND_CONTEXT);
    await vi.waitFor(async () => {
      const view = await f.hub.getTopicView("root");
      const owned = view.messages.find((message) => message.requestId === "asset-owned")!;
      expect(owned?.attachments).toEqual([expect.objectContaining({ id: own.id })]);
      const forged = view.messages.find((message) => message.requestId === "asset-forged")!;
      expect(forged?.delivery).toBe("queued");
      expect(forged?.attachments).toEqual([]);
      expect(forged?.parts).toContainEqual(expect.objectContaining({ type: "markdown", text: "附件不可用" }));
      expect(JSON.stringify(view.messages)).not.toContain(hidden);
      expect(view.messages.some((message) => message.requestId === "forbidden")).toBe(false);
    }, { timeout: 5000, interval: 15 });
    first.release(); await settled(f.hub, () => {});
  });

  it("stops the foreground while its background Worker continues to completion", async () => {
    const foreground = gate(); const worker = gate();
    let routerCalls = 0; let workerAborted = false; let workerStarted = false; const contexts: TranscriptContext[] = [];
    const f = await fixture(async (context, options) => {
      if (orchestrator(context)) {
        routerCalls += 1;
        contexts.push(context);
        if (routerCalls === 1) return fauxAssistantMessage([fauxToolCall("kulo_dispatch", {
          command_id: "background-while-stop", title: "后台任务", goal: "等待后提交结果", scope: "工单目录", role: "engineer",
        })], { stopReason: "toolUse" });
        if (routerCalls === 2) await waitForRelease(foreground.promise, options?.signal);
        return fauxAssistantMessage(options?.signal?.aborted ? "" : "后台已完成", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
      }
      const toolNames = JSON.stringify([context.tools ?? [], ...context.messages.filter((message) => message.role === "system")]);
      if (!toolNames.includes("kulo_report")) return fauxAssistantMessage("标题");
      if (context.messages.some((message) => message.role === "toolResult" && message.toolName === "kulo_report")) return fauxAssistantMessage("worker done");
      workerStarted = true; await waitForRelease(worker.promise, options?.signal);
      workerAborted = Boolean(options?.signal?.aborted);
      return fauxAssistantMessage([fauxToolCall("kulo_report", { state: "ready", summary: "后台完成" })], { stopReason: "toolUse" });
    }, undefined, true);
    await f.hub.sendUserMessage("run-background", { requestId: "background-start" });
    await vi.waitFor(async () => expect({ workerStarted, routerCalls, tickets: (await f.hub.getBoardSnapshot()).tickets }).toMatchObject({ workerStarted: true, routerCalls: 2 }), { timeout: 8000, interval: 30 });
    await f.hub.sendUserMessage("keep-this-supplement", { requestId: "background-kept" });
    await f.hub.abortForegroundTurn("root");
    const board = await f.hub.getBoardSnapshot();
    expect(board.tickets[0]?.status).toBe("running");
    expect(workerAborted).toBe(false);
    worker.release();
    await vi.waitFor(async () => expect((await f.hub.getBoardSnapshot()).tickets[0]?.status).toBe("ready"), { timeout: 7000, interval: 20 });
    expect(workerAborted).toBe(false);
    await settled(f.hub, (view) => expect(view.messages.find((message) => message.requestId === "background-kept")?.delivery).toBe("paused"));
    expect(routerCalls).toBe(2);
    await f.hub.sendUserMessage("change-direction-now", { requestId: "background-resume" });
    await settled(f.hub, (view) => expect(view.messages.find((message) => message.requestId === "background-kept")?.delivery).toBeUndefined());
    expect(JSON.stringify(contexts[2]?.messages)).toContain("change-direction-now");
    expect(contexts.some((context) => JSON.stringify(context.messages).includes("[KULO_WORKER_RELAY]"))).toBe(true);
  });
});
