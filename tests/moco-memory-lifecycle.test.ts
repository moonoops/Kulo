import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { Harness, MemoryStorage, createRegistry, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HindsightMemoryConfig, TicketRecord } from "@moco/protocol";
import { createWorkerExtension } from "../packages/hub/src/tools-worker.js";
import { createMemoryLifecycleExtension, MemoryContextEntry, MemoryLifecycleDoc } from "../packages/hub/src/memory-lifecycle.js";
import { executeHindsightTool, memoryDocumentId, probeHindsightConnection } from "../packages/hub/src/hindsight.js";
import { MocoStateDoc } from "../packages/hub/src/state.js";

const ROUTER = "memory-router-test-00000000000000001";
const WORKER = "memory-worker-test-00000000000000001";
const READ = "memory-shared-read-test-00000000001";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function service(options: { loseFirstRetainReply?: boolean; scoped?: boolean } = {}) {
  const retained = new Map<string, { content: string; tags: string[]; document_id: string }>();
  const writes: Array<Record<string, unknown>> = [];
  const reads: Array<Record<string, unknown>> = [];
  let completed = false;
  let lost = false;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const url = new URL(req.url!, "http://127.0.0.1");
    const token = req.headers.authorization?.replace("Bearer ", "");
    const role = token === ROUTER ? "router" : token === WORKER ? "worker" : token === READ ? "read" : "anonymous";
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (role === "anonymous") return send(401, {});
    if (url.pathname === "/v1/moco/access") {
      if (options.scoped) return send(404, {});
      return send(200, { policyVersion: 1, role, banks: { private: { id: "private-bank", read: role === "router", write: role === "router" }, shared: { id: "shared-bank", read: true, write: role === "worker" } } });
    }
    if (url.pathname === "/v1/version") return send(200, { version: "1.2.1" });
    const shared = url.pathname.includes("/shared-bank/");
    if (!shared && role !== "router") return send(403, {});
    if (shared && options.scoped && role === "router") return send(403, {});
    if (shared && req.method === "POST" && role !== "worker" && !url.pathname.endsWith("/recall")) return send(403, {});
    if (url.pathname.endsWith("/documents")) return send(200, { items: [] });
    if (url.pathname.endsWith("/memories/recall")) {
      reads.push(body);
      const tags = (body.tags ?? []) as string[];
      return send(200, { results: [...retained.values()].filter((item) => tags.every((tag) => item.tags.includes(tag))).map((item) => ({ id: item.document_id, document_id: item.document_id, text: item.content, tags: item.tags, type: "experience" })) });
    }
    if (url.pathname.endsWith("/memories") && req.method === "POST") {
      writes.push(body);
      const id = String(body.operation_id);
      const item = (body.items as Array<{ content: string; tags: string[]; document_id: string }>)[0]!;
      if (!retained.has(id)) retained.set(id, item);
      if (options.loseFirstRetainReply && !lost) { lost = true; req.socket.destroy(); return; }
      return send(202, { operation_id: id, async: true, success: true, bank_id: "shared-bank", items_count: 1 });
    }
    if (url.pathname.includes("/operations/")) return send(200, { operation_id: url.pathname.split("/").at(-1), status: completed ? "completed" : "processing" });
    return send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const config: HindsightMemoryConfig = { enabled: true, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, endpoints: [], caCertPem: "",
    routerApiKey: ROUTER, workerApiKey: WORKER, routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false,
    banks: { private: "private-bank", shared: "shared-bank" } };
  return { config, writes, reads, retained, complete: () => { completed = true; } };
}

async function runtime(config: HindsightMemoryConfig, storage: Storage = new MemoryStorage()) {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "memory-test" }] });
  const models = createModels(); models.setProvider(provider.provider);
  let harness: Harness;
  const memory = createMemoryLifecycleExtension({ getHarness: () => harness, getMemoryConfig: () => config });
  const worker = createWorkerExtension({ getIdentityDir: () => "/nonexistent-memory-test", getMemoryConfig: () => config });
  const registry = createRegistry(); registry.install(worker); registry.install(memory);
  harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const conversation = async (id: string, projectId = "project-a") => {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "openai", modelId: "memory-test" }, thinkingLevel: "off", extensions: [worker, memory] } }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const state = await tx.doc(MocoStateDoc);
      state.tickets[id] = { id, commandId: id, title: "中文检索验证", goal: "完成验证", scope: "检索与记录", status: "running", role: "checker", readOnly: true,
        envId: "local", workspaceDir: "/test", workerConversationId: Number(conv.id), runEpoch: 1, createdAt: 1, updatedAt: 1, projectId } satisfies TicketRecord;
      state.conversationToTicket[String(conv.id)] = id;
    }, BACKGROUND_CONTEXT);
    return conv;
  };
  return { harness, provider, conversation };
}

describe("Worker shared work memory", () => {
  it("retains a real report automatically and makes it available to another Worker in the same project", async () => {
    const api = await service();
    const app = await runtime(api.config);
    app.provider.setResponses([fauxAssistantMessage([fauxToolCall("moco_report", { state: "ready", summary: "已验证：中文语义检索需要多语向量模型。", deliverable: "中文查询样本全部通过。" })], { stopReason: "toolUse" })]);
    const a = await app.conversation("A");
    await a.submit({ type: "input", content: "验证检索" }, BACKGROUND_CONTEXT); await a.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(api.writes).toHaveLength(1));
    expect(Object.values((await app.harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT))!.worklogs)[0]?.status).toBe("pending");
    const write = api.writes[0] as { items: Array<{ tags: string[]; metadata: Record<string, string>; observation_scopes: string[][] }> };
    expect(write.items[0]!.tags).toEqual(expect.arrayContaining(["project:project-a", "ticket:A", "role:checker"]));
    expect(write.items[0]!.observation_scopes).toEqual([["project:project-a"]]);
    expect(write.items[0]!.metadata.actor).toBe("worker");
    api.complete();
    await vi.waitFor(async () => expect(Object.values((await app.harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT))!.worklogs)[0]?.status).toBe("completed"), { timeout: 5000 });

    const requests: TranscriptContext[] = [];
    app.provider.setResponses([0, 1].map(() => (ctx: TranscriptContext) => { requests.push(structuredClone(ctx)); return fauxAssistantMessage([fauxText("采用已验证的多语模型。")]); }));
    const b = await app.conversation("B");
    await b.submit({ type: "input", content: "复用项目经验" }, BACKGROUND_CONTEXT); await b.waitForIdle(BACKGROUND_CONTEXT);
    await b.submit({ type: "input", content: "继续说明" }, BACKGROUND_CONTEXT); await b.waitForIdle(BACKGROUND_CONTEXT);
    expect(api.reads).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain("中文语义检索需要多语向量模型");
    expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(requests[0]!.messages);
    expect(JSON.stringify(requests[0]!.messages.filter((message) => message.role === "system"))).not.toContain("中文语义检索需要多语向量模型");
    const entries = await b.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.filter((entry) => entry.kind === MemoryContextEntry.kind)).toHaveLength(1);

    const read = await executeHindsightTool({ config: api.config, caller: { role: "worker", conversationId: "other", ticketId: "C", projectId: "project-b" }, bank: "shared", toolName: "hindsight_recall", args: { query: "中文", scope: "global" } });
    expect(JSON.parse(read.text).results).toEqual([]);
    expect(api.reads.at(-1)?.tags).toEqual(["project:project-b"]);
    expect(api.reads[0]).not.toHaveProperty("include");
  });

  it("replays a lost submission response using the same official operation ID, without a second memory", async () => {
    const api = await service({ loseFirstRetainReply: true });
    api.complete();
    const app = await runtime(api.config);
    app.provider.setResponses([fauxAssistantMessage([fauxToolCall("moco_report", { state: "ready", summary: "经验证的工作结果" })], { stopReason: "toolUse" })]);
    const a = await app.conversation("A");
    await a.submit({ type: "input", content: "验证重放" }, BACKGROUND_CONTEXT); await a.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(api.writes).toHaveLength(2), { timeout: 5000 });
    expect(api.writes[0]!.operation_id).toBe(api.writes[1]!.operation_id);
    expect(api.retained.size).toBe(1);
    await vi.waitFor(async () => expect(Object.values((await app.harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT))!.worklogs)[0]?.status).toBe("completed"), { timeout: 5000 });
  });

  it("does not treat a project tag supplied by the model as authority and isolates same-title producer documents", async () => {
    const api = await service();
    const caller = { role: "worker" as const, conversationId: "worker-a", ticketId: "A", projectId: "project-a", sourceId: "source-a" };
    const denied = await executeHindsightTool({ config: api.config, caller, bank: "shared", toolName: "hindsight_recall", args: { query: "secret", tags: ["project:project-b"] } });
    expect(JSON.parse(denied.text).code).toBe("FORBIDDEN"); expect(api.reads).toHaveLength(0);
    expect(memoryDocumentId(caller, "same title")).not.toBe(memoryDocumentId({ ...caller, ticketId: "B", sourceId: "source-b" }, "same title"));
    expect((await executeHindsightTool({ config: api.config, caller, bank: "private", toolName: "hindsight_recall", args: { query: "private" } })).isError).toBe(true);
    expect((await executeHindsightTool({ config: api.config, caller: { role: "router", conversationId: "root" }, bank: "shared", toolName: "hindsight_ingest_document", args: { title: "private", content: "private" } })).isError).toBe(true);
    expect(api.writes).toHaveLength(0);
  });

  it("resumes the official operation receipt after a Hub restart without re-submitting the report", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-memory-recovery-"));
    cleanup.push(async () => { fs.rmSync(directory, { recursive: true, force: true }); });
    const filename = path.join(directory, "session.sqlite");
    const api = await service();
    const first = await runtime(api.config, await openNodeSqliteStorage(filename));
    first.provider.setResponses([fauxAssistantMessage([fauxToolCall("moco_report", { state: "ready", summary: "重启之前已经验证的结果" })], { stopReason: "toolUse" })]);
    const a = await first.conversation("A");
    await a.submit({ type: "input", content: "完成工作并记录" }, BACKGROUND_CONTEXT); await a.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(async () => expect(Object.values((await first.harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT))!.worklogs)[0]?.status).toBe("pending"));
    await first.harness.close(BACKGROUND_CONTEXT);
    api.complete();
    const second = await runtime(api.config, await openNodeSqliteStorage(filename));
    second.harness.resume();
    await vi.waitFor(async () => expect(Object.values((await second.harness.snapshot(MemoryLifecycleDoc, BACKGROUND_CONTEXT))!.worklogs)[0]?.status).toBe("completed"), { timeout: 5000 });
    expect(api.writes).toHaveLength(1);
    expect(api.retained.size).toBe(1);
  });

  it("surfaces initiative creation failure instead of returning a fabricated page ID", async () => {
    const api = await service();
    const response = await executeHindsightTool({ config: api.config, caller: { role: "worker", conversationId: "A", ticketId: "A", projectId: "project-a" }, bank: "shared",
      toolName: "hindsight_capture_initiative", args: { title: "计划", summary: "经批准的计划" } });
    expect(response.isError).toBe(true);
    expect(response.text).not.toContain('"page_id"');
    expect(api.writes).toHaveLength(0);
  });

  it("supports standard private-only access without granting Workers access, and verifies native scoped keys", async () => {
    const api = await service({ scoped: true });
    const privateOnly = { ...api.config, accessMode: "private-only" as const, workerApiKey: undefined };
    expect(await probeHindsightConnection(privateOnly)).toMatchObject({ healthy: true, privateBankOk: true, sharedBankOk: false });
    const denied = await executeHindsightTool({ config: privateOnly, caller: { role: "worker", conversationId: "worker", ticketId: "A" }, bank: "shared", toolName: "hindsight_recall", args: { query: "private" } });
    expect(JSON.parse(denied.text).code).toBe("FORBIDDEN");
    const scoped = { ...api.config, accessMode: "scoped" as const, sharedReadApiKey: READ };
    expect(await probeHindsightConnection(scoped)).toMatchObject({ healthy: true, isolationVerified: true });
    expect(await probeHindsightConnection({ ...scoped, sharedReadApiKey: WORKER })).toMatchObject({ healthy: false });
  });
});

describe("provider wire prefix with memory", () => {
  it("keeps appended ordinary evidence in place even when the provider folds system updates", () => {
    const model = { id: "cache-probe", name: "cache-probe", api: "openai-completions" as const, provider: "probe", baseUrl: "http://127.0.0.1", reasoning: false,
      input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 };
    const compat = { supportsDeveloperRole: false, supportsMidConvoSystemMessages: false };
    const baseline: TranscriptContext = { messages: [{ role: "system", content: "Stable memory rules", timestamp: 0 }, { role: "user", content: "Question", timestamp: 1 },
      { role: "user", content: "Historical evidence", timestamp: 2 }] };
    const later: TranscriptContext = { messages: [...baseline.messages, fauxAssistantMessage([fauxText("Answer")]), { role: "user", content: "Continue", timestamp: 3 }] };
    const first = convertMessages(model, baseline, compat, {});
    const second = convertMessages(model, later, compat, {});
    expect(second.slice(0, first.length)).toEqual(first);
  });
});
