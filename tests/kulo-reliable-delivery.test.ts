import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import type { HubToClientMessage } from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { KuloStateDoc, recordProcessedCommand } from "../packages/hub/src/state.js";
import { DeliveryReceiptDoc, clientDeliveryIntent, type ReliableClientMessage } from "../packages/hub/src/delivery-receipts.js";
import { ChatAttachmentGrantsDoc, PendingChatAttachmentsDoc } from "../packages/hub/src/chat-attachment-deliveries.js";
import { KuloUserEntry } from "../packages/hub/src/ui-cards.js";
import * as deliveryReceipts from "../packages/hub/src/delivery-receipts.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const ctx = BACKGROUND_CONTEXT;
const cleanups: Array<() => void | Promise<unknown>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_AUTH_TOKEN", "KULO_ENV_TOKENS", "KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(existingDir?: string, response: FauxResponseFactory = () => fauxAssistantMessage("收到")) {
  const stateDir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "kulo-delivery-"));
  if (!existingDir) cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "delivery-model" }] });
  provider.setResponses(Array.from({ length: 100 }, () => response));
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"),
    authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {}, enableLocalEnv: true, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "openai", defaultModel: "delivery-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
  } });
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await server.close(); await hub.close(); };
  cleanups.push(close);
  return { hub, server, stateDir, close, provider };
}

async function client(f: Awaited<ReturnType<typeof fixture>>, topicId?: string, awaitSnapshot = true) {
  const messages: HubToClientMessage[] = [];
  const url = new URL(f.server.clientWsUrl);
  if (topicId) url.searchParams.set("topic", topicId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
  ws.on("message", raw => messages.push(JSON.parse(String(raw)) as HubToClientMessage));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const close = async () => { if (ws.readyState === WebSocket.CLOSED) return; await new Promise<void>(resolve => { ws.once("close", () => resolve()); ws.terminate(); }); };
  cleanups.push(close);
  async function wait<T extends HubToClientMessage["type"]>(type: T, match: (message: Extract<HubToClientMessage, { type: T }>) => boolean = () => true, after = 0) {
    let message: Extract<HubToClientMessage, { type: T }> | undefined;
    await vi.waitFor(() => {
      message = messages.slice(after).find((item): item is Extract<HubToClientMessage, { type: T }> => item.type === type && match(item as Extract<HubToClientMessage, { type: T }>));
      expect(message).toBeDefined();
    }, { timeout: 6000, interval: 10 });
    return message!;
  }
  if (awaitSnapshot) await wait("hub.snapshot");
  return { ws, messages, wait, close, send: (message: ReliableClientMessage) => ws.send(JSON.stringify(message)) };
}

const chat = (requestId: string, content = "第一条"): Extract<ReliableClientMessage, { type: "chat.send" }> => ({ type: "chat.send", topicId: "root", requestId, content, whenBusy: "steer" });
async function scheduledTicket(f: Awaited<ReturnType<typeof fixture>>, id = "schedule-one", repeatEverySeconds?: number) {
  const ticket = await f.hub.dispatchTicket({ commandId: id, title: id, goal: "等待指令", scope: f.stateDir, role: "coder",
    executeAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), ...(repeatEverySeconds === undefined ? {} : { repeatEverySeconds }) });
  await vi.waitFor(async () => expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.waiting?.reason).toBe("time"));
  return ticket;
}
async function retireCommandCache(f: Awaited<ReturnType<typeof fixture>>) {
  await f.hub.harness.commit(async tx => {
    const state = await tx.doc(KuloStateDoc);
    for (let i = 0; i < 300; i++) recordProcessedCommand(state, `cache-${i}`, "unused", "test");
  }, ctx);
}

function heldResponses(): FauxResponseFactory {
  return async (context, options) => {
    if (context.tools?.some(tool => tool.name === "kulo_dispatch")) await new Promise<void>(resolve => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage(options?.signal?.aborted ? "" : "收到", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
  };
}

function failChatCommit() {
  const write = deliveryReceipts.writeDeliveryReceipt;
  return vi.spyOn(deliveryReceipts, "writeDeliveryReceipt").mockImplementation(async (...args) => {
    await write(...args);
    if (args[1]?.action === "chat.send" && args[3] === "complete") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
}

async function readUpload(f: Awaited<ReturnType<typeof fixture>>, assetId: string) {
  return fetch(new URL(`/api/uploads/${assetId}`, f.server.url), { headers: { Authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } });
}

describe("persistent delivery receipts", () => {
  it.each(["before", "after"] as const)("recovers a killed Hub %s the SQLite commit without exposing an uncommitted chat grant", async boundary => {
    const f = await fixture();
    const attachments = ["first.txt", "second.txt"].map(name => f.hub.uploads.saveUpload({ name, bytes: Buffer.from(name), ownerId: "sender" }));
    const requestId = `crash-at-${boundary}`;
    const secondFile = f.hub.uploads.getUpload(attachments[1]!.id)!.filePath;
    const scope = `conversation:${f.hub.rootConversation.id}`;
    await f.close();
    const paths = Object.fromEntries(["protocol", "env", "recovery"].map(name => [`@kulo/${name}`,
      [fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url))]]));
    fs.writeFileSync(path.join(f.stateDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths } }));
    const child = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./helpers/crash-chat-attachment-commit.ts", import.meta.url)), f.stateDir, boundary, requestId, ...attachments.map(a => a.id)],
    { cwd: f.stateDir, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, encoding: "utf8", timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe("SIGKILL");

    // Hold startup recovery at a real missing file so the pre-commit authorization can be observed over HTTP.
    if (boundary === "before") fs.renameSync(secondFile, `${secondFile}.offline`);
    const restored = await fixture(f.stateDir);
    if (boundary === "before") {
      expect(await restored.hub.hasSubmittedRequest("root", requestId)).toBe(false);
      expect((await readUpload(restored, attachments[0]!.id)).status).toBe(403);
      expect(restored.hub.uploads.canReadUpload(attachments[0]!.id, "agent:test", s => s === scope)).toBe(false);
      fs.renameSync(`${secondFile}.offline`, secondFile);
    } else {
      expect(await restored.hub.hasSubmittedRequest("root", requestId)).toBe(true);
      for (const asset of attachments) expect((await readUpload(restored, asset.id)).status).toBe(200);
    }
    const message = { ...chat(requestId, "crash test"), attachments };
    const first = await restored.hub.deliverClientMessage(message, "sender");
    const replay = await restored.hub.deliverClientMessage(message, "sender");
    expect(replay).toMatchObject({ submissionId: first.submissionId, deduplicated: true });
    for (const asset of attachments) {
      expect(await (await readUpload(restored, asset.id)).text()).toBe(asset.name);
      expect(restored.hub.uploads.canReadUpload(asset.id, "agent:test", s => s === scope)).toBe(true);
    }
    await vi.waitFor(async () => expect((await restored.hub.getTopicView("root")).messages.filter(row => row.requestId === requestId)).toHaveLength(1));
  }, 25_000);

  it.each(["retry", "restart"] as const)("publishes every attachment with the recovered input on %s", async recovery => {
    const f = await fixture();
    const owner = "device-a";
    const assets = ["one.txt", "two.txt"].map(name => f.hub.uploads.saveUpload({ name, bytes: Buffer.from(name), ownerId: owner }));
    const message = { ...chat("interrupted-attachments"), attachments: assets };
    const intent = clientDeliveryIntent(message, owner)!;
    const scope = `conversation:${f.hub.rootConversation.id}`;
    const fault = failChatCommit();
    await expect(f.hub.deliverClientMessage(message, owner)).rejects.toThrow("disk full");
    expect(await f.hub.hasSubmittedRequest("root", intent.id)).toBe(false);
    expect((await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))?.phase).toBe("admitted");
    for (const asset of assets) {
      expect(f.hub.uploads.getUpload(asset.id)?.record.referenceScopes).toEqual([]);
      expect((await readUpload(f, asset.id)).status).toBe(403);
      expect(f.hub.uploads.canReadUpload(asset.id, "agent:test", s => s === scope)).toBe(false);
    }
    await expect(f.hub.deliverClientMessage(message, "another-device")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ ...message, attachments: [assets[0]!] }, owner)).rejects.toMatchObject({ code: "request_intent_conflict" });
    fault.mockRestore();
    let restored = f;
    if (recovery === "restart") {
      await f.close();
      restored = await fixture(f.stateDir);
    } else {
      await restored.hub.deliverClientMessage(message, owner);
    }
    expect(await restored.hub.hasSubmittedRequest("root", intent.id)).toBe(true);
    expect((await restored.hub.harness.snapshot(PendingChatAttachmentsDoc, ctx))?.messages).toEqual({});
    for (const asset of assets) {
      expect(restored.hub.uploads.getUpload(asset.id)?.record.referenceScopes).toEqual([scope]);
      expect(restored.hub.uploads.canReadUpload(asset.id, "agent:test", s => s === scope)).toBe(true);
      expect(await (await readUpload(restored, asset.id)).text()).toBe(asset.name);
    }
    const [first, second] = await Promise.all([restored.hub.deliverClientMessage(message, owner), restored.hub.deliverClientMessage(message, owner)]);
    expect(first).toMatchObject({ deduplicated: true, submissionId: second.submissionId });
    await vi.waitFor(async () => expect((await restored.hub.getTopicView("root")).messages.filter(item => item.role === "user" && item.requestId === intent.id))
      .toEqual([expect.objectContaining({ attachments: assets })]));
  });

  it("preserves existing grants and never makes a rejected transfer readable after its original source is deleted", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("限时共享");
    const source = f.hub.uploads.saveUpload({ name: "source.txt", bytes: Buffer.from("source"), ownerId: "source-owner" });
    const second = f.hub.uploads.saveUpload({ name: "second.txt", bytes: Buffer.from("second"), ownerId: "sender" });
    f.hub.uploads.bindAttachments([source], `conversation:${topic.conversationId}`, "source-owner");
    const existing = f.hub.uploads.saveUpload({ name: "existing.txt", bytes: Buffer.from("already shared"), ownerId: "sender" });
    const rootScope = `conversation:${f.hub.rootConversation.id}`;
    f.hub.uploads.bindAttachments([existing], rootScope, "sender");
    const message = { ...chat("interrupted-source-grant"), attachments: [source, existing, second] };
    const fault = failChatCommit();
    await expect(f.hub.deliverClientMessage(message, "sender")).rejects.toThrow("disk full");
    fault.mockRestore();
    expect(f.hub.uploads.getUpload(source.id)?.record.referenceScopes).not.toContain(rootScope);
    expect(await (await readUpload(f, existing.id)).text()).toBe("already shared");
    await f.hub.deleteTopic(topic.id);
    await expect(f.hub.deliverClientMessage(message, "sender")).rejects.toMatchObject({ code: "attachment_forbidden", status: 403 });
    expect(await f.hub.hasSubmittedRequest("root", message.requestId)).toBe(false);
    expect(f.hub.uploads.getUpload(second.id)?.record.referenceScopes).toEqual([]);
    expect((await readUpload(f, source.id)).status).toBe(403);
    expect(f.hub.uploads.canReadUpload(source.id, "agent:root", scope => scope === rootScope)).toBe(false);
    await expect(f.hub.deliverClientMessage({ ...chat("third-device-transfer"), attachments: [source] }, "third-device"))
      .rejects.toMatchObject({ status: 403 });
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "kulo_inspect_asset", limit: 3 })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("kulo_inspect_asset", { asset_id: source.id }),
        fauxToolCall("kulo_inspect_asset", { asset_id: existing.id })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("已检查"),
    ]);
    await (await f.hub.sendUserMessage("检查可读取的资料")).wait(ctx);
    const checks = (await f.hub.rootConversation.context(ctx)).messages.filter(row => row.role === "toolResult" && row.toolName === "kulo_inspect_asset");
    expect(checks).toHaveLength(2);
    expect(checks).toContainEqual(expect.objectContaining({ isError: true, content: expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("尚未收到这份附件") }),
    ]) }));
    expect(checks).toContainEqual(expect.objectContaining({ isError: false, content: expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("already shared") }),
    ]) }));
    await f.close();
    const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(message, "sender")).rejects.toMatchObject({ code: "attachment_forbidden", status: 403 });
    expect((await restored.hub.harness.snapshot(PendingChatAttachmentsDoc, ctx))?.messages).toEqual({});
    expect(await restored.hub.hasSubmittedRequest("root", message.requestId)).toBe(false);
    expect((await readUpload(restored, source.id)).status).toBe(403);
    expect(await (await readUpload(restored, existing.id)).text()).toBe("already shared");
  });

  it("places two interrupted sends to the same conversation in admission order after restarting", async () => {
    const f = await fixture();
    const assets = ["opening.txt", "conclusion.txt"].map(name => f.hub.uploads.saveUpload({ name, bytes: Buffer.from(name), ownerId: "sender" }));
    const fault = failChatCommit();
    const first = { ...chat("ordered-first"), attachments: assets };
    const second = { ...chat("ordered-second"), attachments: [assets[1]!] };
    await expect(f.hub.deliverClientMessage(first, "sender")).rejects.toThrow("disk full");
    await expect(f.hub.deliverClientMessage(second, "sender")).rejects.toThrow("disk full");
    fault.mockRestore();
    await f.close();
    const restored = await fixture(f.stateDir);
    await vi.waitFor(async () => expect((await restored.hub.getTopicView("root")).messages.filter(row => row.role === "user").map(row => row.requestId))
      .toEqual([first.requestId, second.requestId]));
  });

  it("repairs an older complete receipt for the original sender and topic on replay", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("附件接收方");
    const owner = "initial-sender";
    const asset = f.hub.uploads.saveUpload({ name: "note.txt", bytes: Buffer.from("documentation"), ownerId: owner });
    // A previous client sent the basic descriptor; the enriched transcript alone cannot prove its fingerprint.
    const basic = { id: asset.id, name: asset.name, kind: asset.kind, mimeType: asset.mimeType, size: asset.size, url: asset.url };
    const message = { ...chat("pre-binding-receipt"), topicId: topic.id, attachments: [basic] };
    const intent = clientDeliveryIntent(message, owner)!;
    const original = await f.hub.deliverClientMessage(message, owner);
    await f.hub.harness.commit(async tx => {
      (await tx.doc(DeliveryReceiptDoc, intent.key, {})).continuation = {};
      delete (await tx.doc(ChatAttachmentGrantsDoc)).byAsset[asset.id];
    }, ctx);
    const metadata = path.join(f.hub.uploads.dir, `${asset.id}.meta.json`);
    const record = f.hub.uploads.getUpload(asset.id)!.record;
    await f.close();
    fs.writeFileSync(metadata, JSON.stringify({ ...record, referenceScopes: [] }));
    const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(message, "another-device")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(restored.hub.deliverClientMessage({ ...message, topicId: "root" }, owner)).rejects.toMatchObject({ code: "request_intent_conflict" });
    expect(restored.hub.uploads.getUpload(asset.id)?.record.referenceScopes).toEqual([]);
    await expect(restored.hub.deliverClientMessage(message, owner)).resolves.toMatchObject({ deduplicated: true, submissionId: original.submissionId });
    expect(restored.hub.uploads.getUpload(asset.id)?.record.referenceScopes).toEqual([`conversation:${topic.conversationId}`]);
    expect((await restored.hub.getTopicView(topic.id)).messages.filter(item => item.role === "user")).toHaveLength(1);
  });

  it("repairs an acknowledged attachment on history load only for the proven input and original topic", async () => {
    const f = await fixture();
    const owner = "history-owner";
    const asset = f.hub.uploads.saveUpload({ name: "shared.txt", bytes: Buffer.from("sent"), ownerId: owner });
    const privateAsset = f.hub.uploads.saveUpload({ name: "private.txt", bytes: Buffer.from("private"), ownerId: owner });
    const message = { ...chat("history-only-repair"), attachments: [asset] };
    const intent = clientDeliveryIntent(message, owner)!;
    await f.hub.deliverClientMessage(message, owner);
    const original = await f.hub.harness.commit(tx => tx.submissionByRequest(f.hub.rootConversation.id, intent.id), ctx);
    expect(original?.type === "input" && original.entry).toBeTruthy();
    const metadata = path.join(f.hub.uploads.dir, `${asset.id}.meta.json`);
    const record = f.hub.uploads.getUpload(asset.id)!.record;
    await f.hub.harness.commit(async tx => {
      await tx.appendEntry(KuloUserEntry, f.hub.rootConversation.id, { data: {
        kuloContentVersion: 1, text: message.content, requestId: intent.id, attachments: [privateAsset],
      } });
      (await tx.doc(DeliveryReceiptDoc, intent.key, {})).continuation = {};
      delete (await tx.doc(ChatAttachmentGrantsDoc)).byAsset[asset.id];
    }, ctx);
    fs.writeFileSync(metadata, JSON.stringify({ ...record, referenceScopes: [] }));
    const view = await f.hub.getTopicMessageWindow("root", Number(original?.entry));
    expect(view.messages).toContainEqual(expect.objectContaining({ id: Number(original?.entry), attachments: [asset] }));
    expect(f.hub.uploads.getUpload(asset.id)?.record.referenceScopes).toEqual([`conversation:${f.hub.rootConversation.id}`]);
    expect(f.hub.uploads.getUpload(privateAsset.id)?.record.referenceScopes).toEqual([]);
    expect((await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))?.continuation.attachmentsBound).toBe(true);
  });

  it("allows sharing from a live conversation and rejects private worker or deleted conversation scopes", async () => {
    const f = await fixture();
    const topic = await f.hub.createTopic("临时资料");
    const owner = "source-device";
    const recipient = "another-device";
    const [visible, workerOnly, retired] = ["shared", "worker", "retired"].map(name =>
      f.hub.uploads.saveUpload({ name: `${name}.txt`, bytes: Buffer.from(name), ownerId: owner }));
    f.hub.uploads.bindAttachments([visible!, retired!], `conversation:${topic.conversationId}`, owner);
    f.hub.uploads.bindAttachments([workerOnly!], "ticket:worker", owner);
    await expect(f.hub.deliverClientMessage({ ...chat("forward-visible"), attachments: [visible!] }, recipient)).resolves.toHaveProperty("submissionId");
    await f.hub.deleteTopic(topic.id);
    for (const asset of [workerOnly!, retired!]) {
      await expect(f.hub.deliverClientMessage({ ...chat(`forward-${asset.id}`), attachments: [asset] }, recipient))
        .rejects.toMatchObject({ code: "attachment_forbidden", status: 403 });
      expect(f.hub.uploads.getUpload(asset.id)!.record.referenceScopes).not.toContain(`conversation:${f.hub.rootConversation.id}`);
    }
  });

  it("recovers an ACK-lost chat after disconnect and Hub restart, then accepts the following message in order", async () => {
    const f = await fixture(undefined, heldResponses());
    const c = await client(f);
    const initialIdentity = (await c.wait("hub.snapshot")).deliveryIdentity;
    c.send(chat("lost-ack"));
    await c.close();
    let originalId: number | undefined;
    await vi.waitFor(async () => {
      const intent = clientDeliveryIntent(chat("lost-ack"))!;
      const receipt = await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx);
      originalId = receipt?.ack.submissionId as number | undefined;
      expect(originalId).toBeGreaterThan(0);
    });
    await f.close();
    const restored = await fixture(f.stateDir);
    const reconnected = await client(restored);
    expect((await reconnected.wait("hub.snapshot")).deliveryIdentity).toEqual(initialIdentity);
    reconnected.send(chat("lost-ack"));
    expect(await reconnected.wait("hub.ack", item => item.requestId === "lost-ack")).toMatchObject({ submissionId: originalId, deduplicated: true });
    reconnected.send(chat("second", "第二条"));
    await reconnected.wait("hub.ack", item => item.requestId === "second");
    await vi.waitFor(async () => {
      const view = await restored.hub.getTopicView("root");
      expect(view.messages.filter(item => item.role === "user").map(item => item.requestId)).toEqual(["lost-ack", "second"]);
    });
  });

  it("rejects conflicting text, attachments, destination and action while retaining the original request", async () => {
    const f = await fixture();
    const original = chat("same-id");
    const accepted = await f.hub.deliverClientMessage(original);
    await expect(f.hub.deliverClientMessage({ content: original.content, requestId: original.requestId, topicId: "root", type: "chat.send" }))
      .resolves.toMatchObject({ submissionId: accepted.submissionId, deduplicated: true });
    const persisted = await f.hub.harness.snapshot(DeliveryReceiptDoc, clientDeliveryIntent(original)!.key, ctx);
    expect(JSON.stringify(persisted)).not.toContain(original.content);
    const variants: ReliableClientMessage[] = [
      { ...original, content: "被替换的内容" },
      { ...original, attachments: [{ id: "missing-asset", name: "other.txt", kind: "file", mimeType: "text/plain", size: 2, url: "/api/uploads/missing-asset" }] },
      { ...original, targetDeviceId: "another-device" },
      { type: "chat.retry", topicId: "root", requestId: "same-id" },
    ];
    for (const variant of variants) await expect(f.hub.deliverClientMessage(variant)).rejects.toMatchObject({ code: "request_intent_conflict", status: 409 });
    await expect(f.hub.deliverClientMessage(original)).resolves.toMatchObject({ submissionId: accepted.submissionId, deduplicated: true });
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user")).toHaveLength(1);
  });

  it("coalesces concurrent same-ID submissions but preserves distinct IDs with the same text", async () => {
    const f = await fixture();
    const [first, repeated] = await Promise.all([f.hub.deliverClientMessage(chat("one")), f.hub.deliverClientMessage(chat("one"))]);
    expect(repeated).toMatchObject({ submissionId: first.submissionId, deduplicated: true });
    await f.hub.deliverClientMessage(chat("two"));
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user").map(item => item.requestId)).toEqual(["one", "two"]));
  });

  it("rejects a concurrent conflicting payload without replacing the admitted content", async () => {
    const f = await fixture();
    const [first, conflict] = await Promise.allSettled([
      f.hub.deliverClientMessage(chat("collision", "保留原内容")),
      f.hub.deliverClientMessage(chat("collision", "冲突内容")),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(conflict).toMatchObject({ status: "rejected", reason: { code: "request_intent_conflict" } });
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user").map(item => item.text)).toEqual(["保留原内容"]);
  });

  it("binds a message ID globally to its original principal for chats and task commands", async () => {
    const f = await fixture();
    const original = chat("principal-chat", "原设备发送");
    await f.hub.deliverClientMessage(original, "device-a");
    await expect(f.hub.deliverClientMessage(original, "device-b")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ ...original, content: "另一设备的新内容" }, "device-b")).rejects.toMatchObject({ code: "request_intent_conflict" });
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user").map(item => item.text)).toEqual([original.content]);
    const ticket = await scheduledTicket(f, "principal-task");
    const steer: ReliableClientMessage = { type: "ticket.steer", ticketId: ticket.id, commandId: "principal-command", text: "原设备补充" };
    await f.hub.deliverClientMessage(steer, "device-a");
    await expect(f.hub.deliverClientMessage(steer, "device-b")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ ...steer, text: "另一设备补充" }, "device-b")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ type: "ticket.stop", ticketId: ticket.id, commandId: "principal-command" }, "device-b")).rejects.toMatchObject({ code: "request_intent_conflict" });
    expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.status).toBe("waiting");
  });

  it("checks a pre-receipt chat entry before adopting a legacy retry", async () => {
    const f = await fixture(); const original = chat("legacy-input", "旧版本已收到的原文");
    const accepted = await f.hub.deliverClientMessage(original);
    const intent = clientDeliveryIntent(original)!;
    await f.hub.harness.commit(tx => tx.retireDoc(DeliveryReceiptDoc, intent.key), ctx);
    await expect(f.hub.deliverClientMessage({ ...original, content: "不能被误确认的新内容" }, "another-device")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ ...original, targetDeviceId: "another-target" })).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ ...original, attachments: [{ id: "missing", name: "changed.txt", kind: "file", mimeType: "text/plain", size: 2, url: "/api/uploads/missing" }] })).rejects.toMatchObject({ code: "request_intent_conflict" });
    expect(await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx)).toBeUndefined();
    await expect(f.hub.deliverClientMessage(original)).resolves.toMatchObject({ deduplicated: true, submissionId: accepted.submissionId });
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user")).toHaveLength(1);
  });

  it("verifies queued legacy content and refuses unverifiable task-cache replays", async () => {
    const f = await fixture(undefined, heldResponses());
    await f.hub.deliverClientMessage(chat("busy-first"));
    const queued = chat("legacy-queued", "原排队消息");
    await f.hub.deliverClientMessage(queued);
    const intent = clientDeliveryIntent(queued)!;
    await f.hub.harness.commit(tx => tx.retireDoc(DeliveryReceiptDoc, intent.key), ctx);
    await expect(f.hub.deliverClientMessage({ ...queued, content: "篡改排队内容" }, "another-device")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage(queued)).resolves.toMatchObject({ deduplicated: true });
    const ticket = await scheduledTicket(f, "legacy-task");
    const steer: ReliableClientMessage = { type: "ticket.steer", ticketId: ticket.id, commandId: "legacy-task-command", text: "旧补充" };
    await f.hub.deliverClientMessage(steer);
    const before = (await f.hub.inspectTicketDetail(ticket.id)).ticket;
    await f.hub.harness.commit(tx => tx.retireDoc(DeliveryReceiptDoc, clientDeliveryIntent(steer)!.key), ctx);
    await expect(f.hub.deliverClientMessage({ ...steer, text: "不能被误确认的补充" }, "another-device")).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(f.hub.deliverClientMessage({ type: "ticket.stop", ticketId: ticket.id, commandId: "legacy-task-command" }, "another-device")).rejects.toMatchObject({ code: "request_intent_conflict" });
    expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.resumePrompt).toBe(before.resumePrompt);
    expect((await f.hub.inspectTicketDetail(ticket.id)).ticket.runEpoch).toBe(before.runEpoch);
  });

  it("migrates an earlier principal-scoped receipt before allowing replay", async () => {
    const f = await fixture(); const original = chat("principal-receipt-migration");
    await f.hub.deliverClientMessage(original, "device-a");
    const intent = clientDeliveryIntent(original, "device-a")!;
    const receipt = (await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))!;
    await f.hub.harness.commit(async tx => {
      await tx.retireDoc(DeliveryReceiptDoc, intent.key);
      const old = await tx.doc(DeliveryReceiptDoc, intent.legacyKey, { fingerprint: intent.legacyFingerprint, action: intent.action });
      old.phase = receipt.phase; old.ack = { ...receipt.ack }; old.continuation = { ...receipt.continuation };
    }, ctx);
    await expect(f.hub.deliverClientMessage(original, "device-a")).resolves.toMatchObject({ deduplicated: true, submissionId: receipt.ack.submissionId });
    await expect(f.hub.deliverClientMessage(original, "device-b")).rejects.toMatchObject({ code: "request_intent_conflict" });
  });

  it("rolls back admission when the receipt cannot be written, then safely admits the original retry", async () => {
    const f = await fixture();
    const write = vi.spyOn(deliveryReceipts, "writeDeliveryReceipt").mockRejectedValueOnce(new Error("receipt write interrupted"));
    await expect(f.hub.deliverClientMessage(chat("atomic"))).rejects.toThrow("receipt write interrupted");
    expect(await f.hub.harness.commit(tx => tx.submissionByRequest(f.hub.rootConversation.id, "atomic"), ctx)).toBeUndefined();
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user")).toHaveLength(0);
    write.mockRestore();
    await f.hub.deliverClientMessage(chat("atomic"));
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user")).toHaveLength(1);
  });

  it("returns permanent conflict errors and explicit transient statuses over the actual WebSocket", async () => {
    const f = await fixture(); const c = await client(f);
    c.send(chat("wire-conflict")); await c.wait("hub.ack", item => item.requestId === "wire-conflict");
    c.send(chat("wire-conflict", "冲突文字"));
    expect(await c.wait("hub.error", item => item.requestId === "wire-conflict")).toMatchObject({ code: "request_intent_conflict", status: 409, retryable: false });
    const deliver = vi.spyOn(f.hub, "deliverClientMessage");
    deliver.mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { status: 503 }));
    c.send(chat("transient"));
    expect(await c.wait("hub.error", item => item.requestId === "transient")).toMatchObject({ status: 503, retryable: true });
    deliver.mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }));
    c.send(chat("sqlite-transient"));
    expect(await c.wait("hub.error", item => item.requestId === "sqlite-transient")).toMatchObject({ status: 503, retryable: true });
    deliver.mockRejectedValueOnce(new Error("task business rejection"));
    c.send(chat("business"));
    expect(await c.wait("hub.error", item => item.requestId === "business")).toMatchObject({ status: 400, retryable: false });
    deliver.mockRestore();
    c.send(chat("transient")); await c.wait("hub.ack", item => item.requestId === "transient");
  });

  it("keeps steer and retry receipts after the command cache retires and the task later stops", async () => {
    const f = await fixture();
    const ticket = await scheduledTicket(f);
    const steer: ReliableClientMessage = { type: "ticket.steer", commandId: "steer-once", ticketId: ticket.id, text: "补充一次" };
    const retry: ReliableClientMessage = { type: "ticket.retry", commandId: "retry-once", ticketId: ticket.id };
    await f.hub.deliverClientMessage(steer); await f.hub.deliverClientMessage(retry);
    await f.hub.deliverClientMessage({ type: "ticket.stop", commandId: "stop-later", ticketId: ticket.id });
    await retireCommandCache(f);
    const stopped = (await f.hub.inspectTicketDetail(ticket.id)).ticket;
    expect((await f.hub.harness.snapshot(KuloStateDoc, ctx))?.processedCommands?.["steer-once"]).toBeUndefined();
    await f.close();
    const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(steer)).resolves.toMatchObject({ deduplicated: true, ticketId: ticket.id });
    await expect(restored.hub.deliverClientMessage(retry)).resolves.toMatchObject({ deduplicated: true, ticketId: ticket.id });
    const after = (await restored.hub.inspectTicketDetail(ticket.id)).ticket;
    expect(after.status).toBe("stopped"); expect(after.runEpoch).toBe(stopped.runEpoch); expect(after.resumePrompt).toBeUndefined();
    await expect(restored.hub.deliverClientMessage({ ...steer, text: "内容变更" })).rejects.toMatchObject({ code: "request_intent_conflict" });
    await expect(restored.hub.deliverClientMessage({ type: "ticket.stop", ticketId: ticket.id, commandId: "steer-once" })).rejects.toMatchObject({ code: "request_intent_conflict" });
  });

  it("replays an old stop without incrementing epoch or stopping a newer task state", async () => {
    const f = await fixture();
    const ticket = await scheduledTicket(f);
    const stop: ReliableClientMessage = { type: "ticket.stop", commandId: "old-stop", ticketId: ticket.id, reason: "停止原执行" };
    await f.hub.deliverClientMessage(stop);
    await retireCommandCache(f);
    await f.hub.harness.commit(async tx => {
      const state = await tx.doc(KuloStateDoc); const next = state.tickets[ticket.id]!;
      next.runEpoch += 1; next.status = "ready"; next.latestReport = { state: "ready", summary: "后续执行已完成", at: Date.now() }; delete next.stoppedReason;
    }, ctx);
    const newer = (await f.hub.inspectTicketDetail(ticket.id)).ticket;
    await f.close(); const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(stop)).resolves.toMatchObject({ deduplicated: true });
    const after = (await restored.hub.inspectTicketDetail(ticket.id)).ticket;
    expect(after.runEpoch).toBe(newer.runEpoch); expect(after.status).toBe("ready"); expect(after.stoppedReason).toBeUndefined();
  });

  it("finishes an interrupted stop after restart without applying its state transition twice", async () => {
    const f = await fixture(); const ticket = await scheduledTicket(f);
    const stop: ReliableClientMessage = { type: "ticket.stop", commandId: "interrupted-stop", ticketId: ticket.id };
    vi.spyOn(f.hub.mediaJobs, "list").mockRejectedValueOnce(new Error("simulated disconnect after stop admission"));
    await expect(f.hub.deliverClientMessage(stop)).rejects.toThrow("simulated disconnect");
    const epoch = (await f.hub.inspectTicketDetail(ticket.id)).ticket.runEpoch;
    const intent = clientDeliveryIntent(stop)!;
    expect((await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))?.phase).toBe("admitted");
    await f.close(); const restored = await fixture(f.stateDir);
    await restored.hub.deliverClientMessage(stop);
    expect((await restored.hub.inspectTicketDetail(ticket.id)).ticket.runEpoch).toBe(epoch);
    expect((await restored.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))?.phase).toBe("complete");
  });

  it("keeps close receipts across restart without rewriting the original closure", async () => {
    const f = await fixture(); const ticket = await scheduledTicket(f);
    await f.hub.harness.commit(async tx => { const state = await tx.doc(KuloStateDoc); state.tickets[ticket.id]!.status = "ready"; }, ctx);
    const close: ReliableClientMessage = { type: "ticket.close", ticketId: ticket.id, commandId: "close-once", kind: "obsolete", reason: "已验收" };
    await f.hub.deliverClientMessage(close);
    const closure = (await f.hub.inspectTicketDetail(ticket.id)).ticket.closure;
    await retireCommandCache(f); await f.close(); const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(close)).resolves.toMatchObject({ deduplicated: true });
    expect((await restored.hub.inspectTicketDetail(ticket.id)).ticket.closure).toEqual(closure);
    await expect(restored.hub.deliverClientMessage({ ...close, reason: "篡改原因" })).rejects.toMatchObject({ code: "request_intent_conflict" });
  });

  it("never applies a completed or interrupted old chat stop to a subsequent run", async () => {
    const f = await fixture(undefined, heldResponses());
    await f.hub.deliverClientMessage(chat("first-run"));
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).live.busy).toBe(true));
    const old: ReliableClientMessage = { type: "chat.abort", topicId: "root", requestId: "old-abort" };
    const abort = vi.spyOn(f.hub.harness, "abortTask"); abort.mockRejectedValueOnce(new Error("interrupted abort"));
    await expect(f.hub.deliverClientMessage(old)).rejects.toThrow("interrupted abort");
    await f.hub.deliverClientMessage({ type: "chat.abort", topicId: "root", requestId: "new-abort" });
    await f.hub.deliverClientMessage(chat("new-run", "新的用户输入"));
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).live.busy).toBe(true));
    const run = (await f.hub.harness.snapshot(LiveDoc, f.hub.rootConversation.id, ctx))?.run;
    const calls = abort.mock.calls.length;
    await f.hub.deliverClientMessage(old);
    await f.hub.deliverClientMessage(old);
    expect(abort.mock.calls.length).toBe(calls);
    expect((await f.hub.harness.snapshot(LiveDoc, f.hub.rootConversation.id, ctx))?.run?.taskId).toBe(run?.taskId);
    expect((await f.hub.harness.snapshot(KuloStateDoc, ctx))?.pausedChats?.[String(f.hub.rootConversation.id)]).toBeUndefined();
  });

  it("never replays an old chat retry after the user has stopped its later run", async () => {
    const f = await fixture(undefined, heldResponses());
    await f.hub.deliverClientMessage(chat("original-run"));
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).live.busy).toBe(true));
    await f.hub.deliverClientMessage({ type: "chat.abort", topicId: "root", requestId: "pause-original" });
    const retry: ReliableClientMessage = { type: "chat.retry", topicId: "root", requestId: "old-retry" };
    await f.hub.deliverClientMessage(retry);
    await vi.waitFor(async () => expect((await f.hub.getTopicView("root")).live.busy).toBe(true));
    await f.hub.deliverClientMessage({ type: "chat.abort", topicId: "root", requestId: "stop-retried-run" });
    await retireCommandCache(f); await f.close(); const restored = await fixture(f.stateDir, heldResponses());
    await expect(restored.hub.deliverClientMessage(retry)).resolves.toMatchObject({ deduplicated: true });
    expect((await restored.hub.getTopicView("root")).live.busy).toBe(false);
    expect((await restored.hub.harness.snapshot(KuloStateDoc, ctx))?.pausedChats?.[String(restored.hub.rootConversation.id)]).toBeDefined();
  });

  it("persists scheduled stop and delete commands through ACK loss, cache retirement and Hub restart", async () => {
    const f = await fixture();
    const stopTicket = await scheduledTicket(f, "stop-schedule", 60);
    const deleteTicket = await scheduledTicket(f, "delete-schedule", 60);
    const stop: ReliableClientMessage = { type: "schedule.stop", ticketId: stopTicket.id, commandId: "schedule-stop-once" };
    const remove: ReliableClientMessage = { type: "schedule.delete", ticketId: deleteTicket.id, commandId: "schedule-delete-once" };
    const c = await client(f); c.send(stop);
    await c.wait("hub.ack", message => message.commandId === "schedule-stop-once");
    c.send(remove); await c.close();
    await vi.waitFor(async () => expect((await f.hub.inspectTicketDetail(deleteTicket.id)).ticket.schedule?.deletedAt).toBeGreaterThan(0));
    const beforeStop = (await f.hub.inspectTicketDetail(stopTicket.id)).ticket;
    const beforeDelete = (await f.hub.inspectTicketDetail(deleteTicket.id)).ticket;
    await retireCommandCache(f); await f.close();
    const restored = await fixture(f.stateDir); const reconnected = await client(restored);
    reconnected.send(stop);
    expect(await reconnected.wait("hub.ack", message => message.commandId === "schedule-stop-once")).toMatchObject({ deduplicated: true, ticketId: stopTicket.id });
    reconnected.send(remove);
    expect(await reconnected.wait("hub.ack", message => message.commandId === "schedule-delete-once")).toMatchObject({ deduplicated: true, ticketId: deleteTicket.id });
    expect((await restored.hub.inspectTicketDetail(stopTicket.id)).ticket.runEpoch).toBe(beforeStop.runEpoch);
    expect((await restored.hub.inspectTicketDetail(deleteTicket.id)).ticket).toMatchObject({ status: "stopped", runEpoch: beforeDelete.runEpoch,
      schedule: { deletedAt: beforeDelete.schedule!.deletedAt, nextRunAt: null } });
    expect((await restored.hub.listScheduledTasks()).map(ticket => ticket.id)).toEqual([stopTicket.id]);
    await expect(restored.hub.deliverClientMessage({ ...stop, type: "schedule.delete" })).rejects.toMatchObject({ code: "request_intent_conflict" });
  });

  it("recovers a scheduled deletion interrupted after its atomic stop without losing the deletion intent", async () => {
    const f = await fixture(); const ticket = await scheduledTicket(f, "partial-delete", 60);
    const remove: ReliableClientMessage = { type: "schedule.delete", ticketId: ticket.id, commandId: "partial-schedule-delete" };
    vi.spyOn(f.hub.mediaJobs, "list").mockRejectedValueOnce(new Error("interrupted scheduled cleanup"));
    await expect(f.hub.deliverClientMessage(remove)).rejects.toThrow("interrupted scheduled cleanup");
    const before = (await f.hub.inspectTicketDetail(ticket.id)).ticket;
    expect(before).toMatchObject({ status: "stopped", schedule: { deletedAt: expect.any(Number), nextRunAt: null } });
    const intent = clientDeliveryIntent(remove)!;
    expect((await f.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))?.phase).toBe("admitted");
    await f.close(); const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(remove)).resolves.toMatchObject({ deduplicated: true });
    expect((await restored.hub.inspectTicketDetail(ticket.id)).ticket).toMatchObject({ status: "stopped", runEpoch: before.runEpoch,
      schedule: { deletedAt: before.schedule!.deletedAt, nextRunAt: null } });
    expect(await restored.hub.listScheduledTasks()).toEqual([]);
    expect((await restored.hub.harness.snapshot(DeliveryReceiptDoc, intent.key, ctx))?.phase).toBe("complete");
  });

  it("preserves a finished one-time result when its scheduled delete is retried after restart", async () => {
    const f = await fixture(); const ticket = await scheduledTicket(f, "completed-once");
    const report = { state: "ready" as const, summary: "已完成的结果应保留", at: Date.now() };
    await f.hub.harness.commit(async tx => { const state = await tx.doc(KuloStateDoc); const current = state.tickets[ticket.id]!;
      current.status = "ready"; current.latestReport = report; current.waiting = undefined; current.schedule!.nextRunAt = null;
    }, ctx);
    const beforeEpoch = (await f.hub.inspectTicketDetail(ticket.id)).ticket.runEpoch;
    const remove: ReliableClientMessage = { type: "schedule.delete", ticketId: ticket.id, commandId: "delete-completed" };
    await f.hub.deliverClientMessage(remove); await f.close(); const restored = await fixture(f.stateDir);
    await expect(restored.hub.deliverClientMessage(remove)).resolves.toMatchObject({ deduplicated: true });
    expect((await restored.hub.inspectTicketDetail(ticket.id)).ticket).toMatchObject({ status: "ready", runEpoch: beforeEpoch, latestReport: report,
      schedule: { deletedAt: expect.any(Number), nextRunAt: null } });
  });

  it("reconnects a deleted saved topic through root identity and still delivers another valid topic", async () => {
    const f = await fixture();
    const removed = await f.hub.createTopic("离线期间删除的话题");
    const valid = await f.hub.createTopic("仍存在的话题");
    const original = await client(f, removed.id);
    const identity = (await original.wait("hub.snapshot")).deliveryIdentity;
    await original.close();
    await f.hub.deleteTopic(removed.id);
    const restored = await client(f, removed.id);
    expect(await restored.wait("hub.snapshot")).toMatchObject({ activeTopicId: "root", deliveryIdentity: identity });
    restored.send({ type: "chat.send", topicId: removed.id, content: "已删话题的待发消息", requestId: "removed-target" });
    expect(await restored.wait("hub.error", item => item.requestId === "removed-target")).toMatchObject({ code: "topic_deleted", status: 404, retryable: false });
    restored.send({ type: "chat.send", topicId: valid.id, content: "合法目标的下一条", requestId: "valid-after-removed" });
    expect(await restored.wait("hub.ack", item => item.requestId === "valid-after-removed")).toMatchObject({ topicId: valid.id });
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user")).toHaveLength(0);
    expect((await f.hub.getTopicView(valid.id)).messages.filter(item => item.role === "user").map(item => item.text)).toEqual(["合法目标的下一条"]);
  });

  it("falls back state.sync for deleted topics and rejects sends to a nonexistent topic instead of rerouting them", async () => {
    const f = await fixture(); const removed = await f.hub.createTopic("即将删除");
    const c = await client(f, removed.id);
    await f.hub.deleteTopic(removed.id);
    const mark = c.messages.length;
    c.ws.send(JSON.stringify({ type: "state.sync", requestId: "sync-deleted-topic" }));
    expect(await c.wait("hub.snapshot", () => true, mark)).toMatchObject({ activeTopicId: "root", deliveryIdentity: { principalId: "local", hubId: expect.any(String) } });
    const missing = await client(f, "topic-from-another-hub");
    expect(await missing.wait("hub.snapshot")).toMatchObject({ activeTopicId: "root", deliveryIdentity: { hubId: expect.any(String) } });
    missing.send({ type: "chat.send", topicId: "topic-from-another-hub", content: "不能误投到root", requestId: "missing-topic-message" });
    expect(await missing.wait("hub.error", item => item.requestId === "missing-topic-message")).toMatchObject({ code: "topic_not_found", status: 404, retryable: false });
    expect((await f.hub.getTopicView("root")).messages.filter(item => item.role === "user")).toHaveLength(0);
  });

  it("surfaces unexpected snapshot failures instead of silently switching conversations", async () => {
    const f = await fixture(); const topic = await f.hub.createTopic("存在的话题");
    const snapshot = vi.spyOn(f.hub, "getFullClientSnapshot").mockRejectedValueOnce(new Error("unexpected snapshot failure"));
    const c = await client(f, topic.id, false);
    expect(await c.wait("hub.error")).toMatchObject({ message: "unexpected snapshot failure" });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(c.messages.some(item => item.type === "hub.snapshot")).toBe(false);
    c.ws.send(JSON.stringify({ type: "state.sync", requestId: "recover-snapshot" }));
    expect(await c.wait("hub.snapshot")).toMatchObject({ activeTopicId: topic.id, deliveryIdentity: { hubId: expect.any(String) } });
  });
});
