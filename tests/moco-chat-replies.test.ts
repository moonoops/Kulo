import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ChatReplyReference } from "@moco/protocol";
import { DeliveryReceiptDoc, clientDeliveryIntent, validateReliableClientMessage, type ReliableClientMessage } from "../packages/hub/src/delivery-receipts.js";
import { openTestHub } from "./helpers/secure-hub.js";

const ctx = BACKGROUND_CONTEXT;
const cleanups: Array<() => void | Promise<unknown>> = [];
const replyTo: ChatReplyReference = { messageId: 42, role: "assistant", text: "原消息第一行\n原消息第二行" };
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_AUTH_TOKEN", "MOCO_ENV_TOKENS", "MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(existingDir?: string, response: FauxResponseFactory = () => fauxAssistantMessage("收到")) {
  const stateDir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "moco-replies-"));
  if (!existingDir) cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "reply-model" }] });
  provider.setResponses(Array.from({ length: 30 }, () => response));
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"),
    authToken: "moco-reply-synthetic-admin-token", envTokens: {}, enableLocalEnv: true, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "reply-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
  } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await hub.close(); } };
  cleanups.push(close);
  return { stateDir, hub, close };
}

const chat = (requestId: string): Extract<ReliableClientMessage, { type: "chat.send" }> => ({ type: "chat.send", topicId: "root", requestId, content: "继续说明这里", replyTo });

describe("chat reply references", () => {
  it.each([
    null, [], {}, { ...replyTo, messageId: 1.5 }, { ...replyTo, messageId: Number.MAX_SAFE_INTEGER + 1 },
    { ...replyTo, role: "system_note" }, { ...replyTo, role: ["assistant"] }, { ...replyTo, text: "  " }, { ...replyTo, text: "x".repeat(8001) },
  ])("rejects malformed references at reliable and direct chat boundaries: %j", async (invalid) => {
    expect(() => validateReliableClientMessage({ ...chat("invalid"), replyTo: invalid } as unknown as ReliableClientMessage)).toThrow();
  });

  it("keeps display text separate while providing the quote to the model and preserving it after restart", async () => {
    const modelInputs: string[] = [];
    const f = await fixture(undefined, (context) => { modelInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage("收到"); });
    await f.hub.deliverClientMessage(chat("reply-once"));
    await vi.waitFor(async () => {
      const view = await f.hub.getTopicView("root");
      expect(view.live.busy).toBe(false);
      expect(view.messages.find((item) => item.role === "user")).toMatchObject({ text: "继续说明这里", replyTo });
      expect(modelInputs.join("\n")).toContain("原消息第一行");
    });
    expect(modelInputs.join("\n")).toContain("回复消息：assistant #42");
    await f.close();
    const restored = await fixture(f.stateDir);
    expect((await restored.hub.getTopicView("root")).messages.find((item) => item.role === "user")).toMatchObject({ text: "继续说明这里", replyTo });
    await expect(restored.hub.deliverClientMessage(chat("reply-once"))).resolves.toMatchObject({ deduplicated: true });
    await expect(restored.hub.deliverClientMessage({ ...chat("reply-once"), replyTo: { ...replyTo, messageId: 43 } })).rejects.toMatchObject({ code: "request_intent_conflict" });
  });

  it("preserves queued reply metadata and checks it during legacy deduplication", async () => {
    const f = await fixture(undefined, async (_context, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    });
    await f.hub.deliverClientMessage({ type: "chat.send", content: "先处理这条", requestId: "held-first" });
    const queued = { ...chat("queued-reply"), replyTo: { ...replyTo, messageId: -123 } };
    await f.hub.deliverClientMessage(queued);
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).messages.find((item) => item.requestId === "queued-reply")).toMatchObject({ text: queued.content, replyTo: queued.replyTo, delivery: "queued" }));
    await f.hub.harness.commit((tx) => tx.retireDoc(DeliveryReceiptDoc, clientDeliveryIntent(queued)!.key), ctx);
    await expect(f.hub.deliverClientMessage({ ...queued, replyTo: { ...queued.replyTo, text: "另一个引用" } })).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage(queued)).resolves.toMatchObject({ deduplicated: true });
  });

  it("validates direct chat and worker callers before admitting input", async () => {
    const f = await fixture();
    const invalid = { ...replyTo, text: "" };
    await expect(f.hub.sendUserMessage("new", { replyTo: invalid })).rejects.toMatchObject({ code: "invalid_message" });
    await expect(f.hub.steerTicket({ ticketId: "missing", commandId: "invalid-steer", text: "new", replyTo: invalid })).rejects.toMatchObject({ code: "invalid_message" });
    expect((await f.hub.getTopicView("root")).messages.filter((item) => item.role === "user")).toHaveLength(0);
  });

  it("persists parked worker replies in the transcript and supplies their context on resume", async () => {
    const f = await fixture();
    const ticket = await f.hub.dispatchTicket({ commandId: "future-task", title: "稍后处理", goal: "等待补充", scope: f.stateDir,
      role: "coder", executeAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    await vi.waitFor(async () => expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.waiting?.reason).toBe("time"));
    const steer: Extract<ReliableClientMessage, { type: "ticket.steer" }> = { type: "ticket.steer", commandId: "parked-reply", ticketId: ticket.id, text: "按这部分推进", replyTo };
    await f.hub.deliverClientMessage(steer);
    const detail = await f.hub.inspectTicketDetail(ticket.id);
    expect(detail.transcript.find((item) => item.replyTo)).toMatchObject({ text: "【主控补充引导】\n按这部分推进", replyTo });
    expect(detail.ticket.resumePrompt).toContain("原消息第一行");
    expect(detail.ticket.resumePrompt).toContain("按这部分推进");
    await expect(f.hub.deliverClientMessage(steer)).resolves.toMatchObject({ deduplicated: true });
    expect((await f.hub.inspectTicketDetail(ticket.id)).transcript.filter((item) => item.replyTo)).toHaveLength(1);
    await f.close();
    const restored = await fixture(f.stateDir);
    const persisted = await restored.hub.inspectTicketDetail(ticket.id);
    expect(persisted.transcript.find((item) => item.replyTo)?.replyTo).toEqual(replyTo);
    expect(persisted.ticket.resumePrompt).toContain("原消息第二行");
  });

  it("retains reply references for running worker steers without displaying the quote in their body", async () => {
    let release: (() => void) | undefined;
    const modelInputs: string[] = [];
    const f = await fixture(undefined, async (context, options) => {
      modelInputs.push(JSON.stringify(context.messages));
      if (modelInputs.length === 1) await new Promise<void>((resolve) => {
        release = resolve;
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("已收到补充");
    });
    const ticket = await f.hub.dispatchTicket({ commandId: "running-task", title: "正在处理", goal: "执行要求", scope: f.stateDir, role: "coder" });
    await vi.waitFor(() => expect(release).toBeDefined());
    await f.hub.deliverClientMessage({ type: "ticket.steer", commandId: "running-reply", ticketId: ticket.id, text: "按原文修改", replyTo });
    release!();
    await vi.waitFor(async () => {
      const detail = await f.hub.inspectTicketDetail(ticket.id);
      expect(detail.transcript.find((item) => item.replyTo)).toMatchObject({ text: "【主控补充引导】\n按原文修改", replyTo });
      expect(modelInputs.join("\n")).toContain("原消息第一行");
    });
  });

  it("redacts reply snapshots before they enter model input and durable display data", async () => {
    const modelInputs: string[] = [];
    const f = await fixture(undefined, (context) => { modelInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage("收到"); });
    const synthetic = "synthetic-reply-credential";
    const redact = f.hub.connectionManager.redact.bind(f.hub.connectionManager);
    vi.spyOn(f.hub.connectionManager, "redact").mockImplementation((text) => redact(text).replaceAll(synthetic, "[已隐藏]"));
    await f.hub.deliverClientMessage({ ...chat("protected-reply"), replyTo: { ...replyTo, text: `原消息 ${synthetic}` } });
    await vi.waitFor(() => expect(modelInputs.length).toBeGreaterThan(0));
    expect(modelInputs.join("\n")).not.toContain(synthetic);
    const view = await f.hub.getTopicView("root");
    expect(view.messages.find((item) => item.replyTo)?.replyTo?.text).toBe("原消息 [已隐藏]");
  });
});
