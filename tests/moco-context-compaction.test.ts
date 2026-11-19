import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as kernel from "acp-kernel";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  Harness, MemoryStorage, UserEntry, createRegistry, type Conversation, type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  ContextBlocksEntry, ContextCompactionDoc, createContextCompactionController, validateBillionKernel,
} from "../packages/hub/src/context-compaction.js";

const context = BACKGROUND_CONTEXT;
const close: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const callback of close.splice(0).reverse()) await callback(); });

function wireText(request: TranscriptContext): string { return JSON.stringify(request.messages); }
function summaryResponse(request: TranscriptContext) {
  const source = wireText(request);
  const summary = source.includes("ORIGINAL=137") ? "保留最初决定 ORIGINAL=137，当前继续工作，历史条件仍然有效。" : "保留用户目标和约束，工作仍在继续，原始记录可以通过来源读取。";
  const message = fauxAssistantMessage([fauxText(summary)]);
  message.usage = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return message;
}

async function app(options: { storage?: Storage; maxSourceChars?: number; reserveTokens?: number;
  automatic?: boolean;
  retry?: boolean;
  isActive?: () => boolean;
  respond?: (request: TranscriptContext, signal?: AbortSignal) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>> } = {}) {
  let harness: Harness;
  const requests: TranscriptContext[] = [];
  const provider = fauxProvider({ provider: "context-test", models: [{ id: "model", contextWindow: 2048, maxTokens: 512 }] });
  const models = createModels(); models.setProvider(provider.provider);
  const completedUsage: number[] = [];
  const meteredModels = new Proxy(models, { get(target, property) {
    if (property === "completeSimple") return async (...args: Parameters<typeof models.completeSimple>) => {
      const message = await target.completeSimple(...args); completedUsage.push(message.usage.input); return message;
    };
    const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  provider.setResponses(Array.from({ length: 200 }, () => async (request, options) => {
    requests.push(structuredClone(request));
    return options?.signal?.aborted ? fauxAssistantMessage("", { stopReason: "aborted" })
      : await (optionsRespond?.(request, options?.signal) ?? summaryResponse(request));
  }));
  const optionsRespond = options.respond;
  const controller = createContextCompactionController({ getHarness: () => harness,
    getKernel: async () => ({ version: "0.0.101", kernel: validateBillionKernel(kernel) }),
    getReserveTokens: () => options.reserveTokens ?? 512,
    isActive: options.isActive,
    maxSourceChars: options.maxSourceChars ?? 512,
  });
  const registry = createRegistry(); registry.install(controller.extension);
  harness = await Harness.open(options.storage ?? new MemoryStorage(), { models: meteredModels, registry,
    settings: { retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: options.automatic ?? false, keepRecentTokens: 128, reserveTokens: options.reserveTokens ?? 512, backgroundTokens: 0 } },
  }, context);
  close.push(() => harness.close(context));
  const conversation = await harness.root(context, { agent: { model: { provider: "context-test", modelId: "model" }, thinkingLevel: "off", extensions: [controller.extension] } });
  return { harness, controller, conversation, requests, provider, completedUsage };
}

async function seed(conversation: Conversation, count = 8, chars = 220) {
  await conversation.commit(async (tx) => {
    for (let index = 0; index < count; index++) await tx.appendEntry(UserEntry, conversation.id, {
      model: [{ role: "user", content: `${index === 0 ? "ORIGINAL=137 " : ""}历史段 ${index} ${"记录".repeat(chars / 2)}`, timestamp: index }],
    });
  }, context);
}
async function compact(application: Awaited<ReturnType<typeof app>>) {
  const taskId = await application.conversation.compact(undefined, context);
  const done = await application.harness.waitForTask(taskId, context);
  expect(done.state.outcome.status).toBe("completed");
  if (done.state.outcome.status !== "completed") throw new Error("compaction failed");
  if (done.state.outcome.result.submissionId !== undefined) {
    const placed = await (await application.harness.submission(done.state.outcome.result.submissionId, context))!.wait(context);
    expect(placed.status).toBe("done");
  }
  await application.controller.reconcile(application.conversation.id, context);
  return taskId;
}
const isBillionSummary = (request: TranscriptContext) => wireText(request).includes("You summarize historical conversation records");

describe("Billion Context through the official Durable compaction task", () => {
  it("leaves the native summarizer in charge by default", async () => {
    const application = await app();
    await seed(application.conversation);
    await compact(application);
    expect(application.requests).toHaveLength(1);
    expect(isBillionSummary(application.requests[0]!)).toBe(false);
    expect((await application.conversation.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === ContextBlocksEntry.kind)).toHaveLength(0);
  });

  it("honors a host-wide stop fence before per-conversation preferences are updated", async () => {
    let active = true;
    const application = await app({ isActive: () => active });
    await seed(application.conversation);
    await application.controller.setEnabled(application.conversation.id, true);
    active = false;
    await compact(application);
    expect(application.requests.every((request) => !isBillionSummary(request))).toBe(true);
  });

  it("forms real kernel T1/T2 blocks, commits one native-readable head, and accounts for summary calls", async () => {
    const application = await app();
    await seed(application.conversation);
    const original = await application.conversation.entries({}, 100, undefined, context);
    await application.controller.setEnabled(application.conversation.id, true, context);
    await compact(application);
    expect(application.requests.length).toBeGreaterThan(2);
    expect(application.requests.every(isBillionSummary)).toBe(true);
    const entries = await application.conversation.entries({}, 100, undefined, context);
    const archive = entries.items.find((entry) => entry.kind === ContextBlocksEntry.kind)!;
    expect(archive).toBeDefined();
    const data = archive.data as { blocks: kernel.CompressionBlock[]; sourceChunks: Array<{ entryIds: number[] }> };
    expect(data.blocks.some((block) => block.tier === 1)).toBe(true);
    expect(data.blocks.some((block) => block.tier === 2 && block.active)).toBe(true);
    const active = await application.conversation.context(context);
    expect(JSON.stringify(active.messages)).toContain("ORIGINAL=137");
    expect(active.head?.id).toBe((await application.controller.snapshot(application.conversation.id))?.active?.checkpointEntryId);
    for (const entry of original.items) expect(entries.items.some((candidate) => candidate.id === entry.id)).toBe(true);
    const usage = await application.harness.usage(context);
    expect(usage.models["context-test/model"]?.input).toBe(application.completedUsage.reduce((sum, value) => sum + value, 0));
  });

  it("stops safely and continues the same conversation with native compression", async () => {
    const application = await app();
    await seed(application.conversation);
    await application.controller.setEnabled(application.conversation.id, true);
    await compact(application);
    const id = application.conversation.id;
    const count = application.requests.length;
    await application.controller.setEnabled(id, false);
    await seed(application.conversation, 3);
    await compact(application);
    expect(application.requests.slice(count).some(isBillionSummary)).toBe(false);
    expect(wireText(application.requests[count]!)).toContain("ORIGINAL=137");
    await (await application.conversation.submit({ type: "input", content: "继续这个主对话" }, context)).wait(context);
    expect(application.conversation.id).toBe(id);
    expect((await application.controller.snapshot(id))?.enabled).toBe(false);
  });

  it("summarizes Durable's edited contributions without reviving an omitted original payload", async () => {
    const application = await app();
    await seed(application.conversation);
    const first = (await application.conversation.entries({ order: "ascending" }, 100, undefined, context)).items[0]!;
    await application.conversation.commit(async (tx) => {
      await tx.appendEntry(application.conversation.id, { kind: "test.edit", edits: [{ target: first.id, action: "replace",
        messages: [{ role: "user", content: "CORRECTED=208 " + "已更正的历史记录。".repeat(25), timestamp: 1 }] }] });
    }, context);
    await application.controller.setEnabled(application.conversation.id, true);
    await compact(application);
    expect(application.requests.some((request) => wireText(request).includes("CORRECTED=208"))).toBe(true);
    expect(application.requests.every((request) => !wireText(request).includes("ORIGINAL=137"))).toBe(true);
    expect((await application.controller.snapshot(application.conversation.id))?.active).not.toBeNull();
  });

  it("reports provider failure and falls back through the bounded native prefix without fabricating a BC checkpoint", async () => {
    const application = await app({ respond: (request) => isBillionSummary(request)
      ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary provider unavailable" }) : summaryResponse(request) });
    await seed(application.conversation);
    await application.controller.setEnabled(application.conversation.id, true);
    await compact(application);
    const state = await application.controller.snapshot(application.conversation.id);
    expect(state?.lastError).toContain("summary provider unavailable");
    expect(Object.values(state?.jobs ?? {})[0]?.status).toBe("failed");
    expect(state?.active).toBeNull();
    expect(application.requests.filter(isBillionSummary)).toHaveLength(1);
    expect(application.requests.filter((request) => !isBillionSummary(request))).toHaveLength(1);
  });

  it("keeps large-source reduction requests bounded under a small model window", async () => {
    const application = await app({ maxSourceChars: 256, reserveTokens: 256 });
    await seed(application.conversation, 40, 300);
    await application.controller.setEnabled(application.conversation.id, true);
    await compact(application);
    expect(application.requests.length).toBeGreaterThan(20);
    for (const request of application.requests) expect(wireText(request).length).toBeLessThan(1400);
    expect((await application.controller.snapshot(application.conversation.id))?.active?.blockCount).toBeGreaterThan(20);
  });

  it("durably retries a transient summary failure and records every completed attempt once", async () => {
    let failed = false;
    const application = await app({ retry: true, respond: (request) => {
      if (isBillionSummary(request) && !failed) { failed = true; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }); }
      return summaryResponse(request);
    } });
    await seed(application.conversation, 4);
    await application.controller.setEnabled(application.conversation.id, true);
    await compact(application);
    expect(application.requests.every(isBillionSummary)).toBe(true);
    expect(application.completedUsage.length).toBe(application.requests.length);
    expect((await application.harness.usage(context)).models["context-test/model"]?.input).toBe(application.completedUsage.reduce((sum, value) => sum + value, 0));
    expect((await application.controller.snapshot(application.conversation.id))?.active).not.toBeNull();
  });

  it("persists checkpoints across a SQLite reopen without repeating completed summary calls", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-context-reopen-"));
    close.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "moco.sqlite");
    const first = await app({ storage: await openNodeSqliteStorage(filename) });
    await seed(first.conversation);
    await first.controller.setEnabled(first.conversation.id, true);
    await compact(first);
    const state = await first.controller.snapshot(first.conversation.id);
    await first.harness.close(context);
    const second = await app({ storage: await openNodeSqliteStorage(filename) });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect((await second.controller.snapshot(second.conversation.id))?.active).toEqual(state?.active);
    expect(second.requests).toHaveLength(0);
    expect((await second.harness.snapshot(ContextCompactionDoc, second.conversation.id, context))?.enabled).toBe(true);
    await second.controller.setEnabled(second.conversation.id, false);
    await (await second.conversation.submit({ type: "input", content: "重启后继续" }, context)).wait(context);
    expect(wireText(second.requests[0]!)).toContain("ORIGINAL=137");
  });

  it("uses the same official threshold and overflow paths without two independent summarizers", async () => {
    const threshold = await app({ automatic: true, maxSourceChars: 512, reserveTokens: 512 });
    await seed(threshold.conversation, 40, 300);
    await threshold.controller.setEnabled(threshold.conversation.id, true);
    await (await threshold.conversation.submit({ type: "input", content: "压缩后继续" }, context)).wait(context);
    const thresholdEntries = await threshold.conversation.entries({}, 200, undefined, context);
    expect(thresholdEntries.items.filter((entry) => entry.kind === "pi.compaction").map((entry) => entry.data)).toContainEqual({ reason: "threshold" });
    expect(threshold.requests.filter((request) => wireText(request).includes("You are a context summarization assistant"))).toHaveLength(0);

    let overflowed = false;
    const overflow = await app({ automatic: true, maxSourceChars: 1024, respond: (request) => {
      if (!isBillionSummary(request) && !overflowed) { overflowed = true; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }); }
      return summaryResponse(request);
    } });
    await seed(overflow.conversation);
    await overflow.controller.setEnabled(overflow.conversation.id, true);
    const answer = await (await overflow.conversation.submit({ type: "input", content: "溢出后继续" }, context)).wait(context);
    expect(answer.status).toBe("done");
    const entries = await overflow.conversation.entries({}, 200, undefined, context);
    expect(entries.items.filter((entry) => entry.kind === "pi.compaction").map((entry) => entry.data)).toContainEqual({ reason: "overflow" });
    expect(overflow.requests.filter((request) => wireText(request).includes("You are a context summarization assistant"))).toHaveLength(0);
  });

  it("drains an in-flight compaction before stop resolves", async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const application = await app({ maxSourceChars: 4096, respond: async (request) => {
      if (isBillionSummary(request)) { entered(); await gate; }
      return summaryResponse(request);
    } });
    await seed(application.conversation, 4);
    await application.controller.setEnabled(application.conversation.id, true);
    const task = await application.conversation.compact(undefined, context);
    await started;
    let stopped = false;
    const stop = application.controller.setEnabled(application.conversation.id, false).then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release(); await stop;
    expect((await application.harness.waitForTask(task, context)).state.outcome.status).toBe("completed");
    expect(application.requests.every(isBillionSummary)).toBe(true);
    expect(JSON.stringify((await application.conversation.context(context)).messages)).toContain("ORIGINAL=137");
  });

  it("reselects a changed background prefix after restart and reuses completed leaf summaries", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-context-interrupted-"));
    close.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "moco.sqlite");
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const first = await app({ storage: await openNodeSqliteStorage(filename), respond: async (request, signal) => {
      if (isBillionSummary(request) && ++calls === 2) {
        entered();
        return new Promise((resolve) => {
          const finish = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
          if (signal?.aborted) finish(); else signal?.addEventListener("abort", finish, { once: true });
        });
      }
      return summaryResponse(request);
    } });
    await seed(first.conversation);
    await first.controller.setEnabled(first.conversation.id, true);
    const task = await first.conversation.compact(undefined, context);
    await waiting;
    await seed(first.conversation, 3, 180);
    await first.harness.close(context);
    const second = await app({ storage: await openNodeSqliteStorage(filename) });
    const done = await second.harness.waitForTask(task, context);
    expect(done.state.outcome.status).toBe("completed");
    if (done.state.outcome.status !== "completed") throw new Error("resumed compaction failed");
    if (done.state.outcome.result.submissionId !== undefined) await (await second.harness.submission(done.state.outcome.result.submissionId, context))!.wait(context);
    await second.controller.reconcile(second.conversation.id);
    expect((await second.controller.snapshot(second.conversation.id))?.active?.epoch).toBeGreaterThan(1);
    // The first block was committed before shutdown, so it is not sent to the model again.
    expect(second.requests.filter((request) => isBillionSummary(request) && wireText(request).includes("entry-2.message-0.part-0"))).toHaveLength(0);
    expect(JSON.stringify((await second.conversation.context(context)).messages)).toContain("ORIGINAL=137");
  });
});
