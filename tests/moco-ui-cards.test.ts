import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, UserEntry, createRegistry, type Conversation, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { UiCardSnapshotSchema, validateUiActionValues, validateUiCardInput, type UiActionInput, type UiCardInput } from "@moco/protocol";
import { ContentPublicationEntry, MocoUiCards, MocoUserEntry, UiActionEntry, UiCardError, UiCardsDoc, type MocoUiCardsOptions } from "../packages/hub/src/ui-cards.js";
import { createContentToolsExtension } from "../packages/hub/src/tools-content.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function form(): UiCardInput {
  return {
    title: "选择处理方式", actions: [{ id: "confirm", label: "提交", kind: "submit" }, { id: "cancel", label: "取消", kind: "cancel" }],
    spec: { root: "card", elements: {
      card: { type: "Card", props: {}, children: ["name", "count", "choice", "submit", "cancel"] },
      name: { type: "TextField", props: { field: "name", label: "名称", required: true, maxLength: 20 } },
      count: { type: "NumberField", props: { field: "count", label: "数量", min: 1, max: 5 } },
      choice: { type: "Choice", props: { field: "choice", label: "方式", options: [{ value: "safe", label: "标准" }, { value: "fast", label: "快速" }] } },
      submit: { type: "Button", props: { actionId: "confirm" } }, cancel: { type: "Button", props: { actionId: "cancel" } },
    }, state: { values: { count: 1, choice: "safe" } } },
  };
}

async function fixture(storage: Storage = new MemoryStorage(), options: Pick<MocoUiCardsOptions, "validateAssetReferences"> = {}) {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "ui-model" }] });
  provider.setResponses(Array.from({ length: 400 }, () => () => fauxAssistantMessage([fauxText("已收到选择。")])));
  const models = createModels(); models.setProvider(provider.provider);
  const registry = createRegistry();
  let cards!: MocoUiCards;
  const extension = createContentToolsExtension({ get: () => cards, scope: (api) => ({ conversationId: Number(api.conversationId), callId: api.callId, topicId: "root" }) });
  registry.install(extension);
  const harness = await Harness.open(storage, { models, registry, identity: { attribution: null } }, BACKGROUND_CONTEXT);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await harness.close(BACKGROUND_CONTEXT); } };
  cleanup.push(close);
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai", modelId: "ui-model" }, extensions: [extension], thinkingLevel: "off" } });
  cards = new MocoUiCards({ harness, ...options });
  const source = (callId: string) => ({ conversationId: Number(conversation.id), callId, topicId: "root" });
  return { cards, harness, conversation, provider, source, close };
}

function command(card: Awaited<ReturnType<MocoUiCards["show"]>>, commandId = "command-1"): UiActionInput {
  return { cardId: card.cardId, revision: card.revision, actionId: card.actions.find((action) => action.kind === "submit")!.id,
    values: { name: "示例", count: 2, choice: "safe" }, commandId };
}

describe("durable generative UI cards", () => {
  it("publishes one native invitation action across tool replay and keeps it bound to its original Hub", async () => {
    const f = await fixture();
    const source = f.source("invite-laptop");
    await f.cards.showDeviceInvitation("hub-a", "书房", source);
    await f.cards.showDeviceInvitation("hub-a", "更名后的主脑", source);
    await expect(f.cards.showDeviceInvitation("hub-b", "另一台", source)).rejects.toMatchObject({ code: "ui_call_conflict" });
    await expect(f.cards.show(form(), source)).rejects.toMatchObject({ code: "ui_call_conflict" });
    const entries = await f.conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const publications = entries.items.filter(ContentPublicationEntry.is);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.data.parts).toEqual([{ type: "device-invitation", partId: expect.any(String), hubId: "hub-a", hubName: "书房" }]);
  });

  it("validates new asset references atomically while replaying already published cards after asset removal", async () => {
    const permitted = new Set<string>();
    const validateAssetReferences = vi.fn<NonNullable<MocoUiCardsOptions["validateAssetReferences"]>>((spec) => {
      for (const element of Object.values(spec.elements)) if (element.type === "Media" && !permitted.has(String(element.props.assetId))) throw new UiCardError("ui_asset_reference_denied", "资源不可用。", 403);
    });
    const f = await fixture(new MemoryStorage(), { validateAssetReferences });
    const input = form();
    input.spec.elements.media = { type: "Media", props: { assetId: "asset-private-draft" } };
    input.spec.elements.card!.children!.push("media");
    await expect(f.cards.show(input, f.source("show-asset"))).rejects.toMatchObject({ status: 403 });
    expect(await f.cards.snapshot(Number(f.conversation.id))).toEqual([]);
    expect((await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(ContentPublicationEntry.is)).toHaveLength(0);
    permitted.add("asset-private-draft");
    const card = await f.cards.show(input, f.source("show-asset"));
    expect(validateAssetReferences).toHaveBeenLastCalledWith(card.spec, f.source("show-asset"));
    const update = { ...input, title: "资源更新", cardId: card.cardId, revision: card.revision };
    const updated = await f.cards.update(update, f.source("update-asset"));
    permitted.clear();
    const callsBeforeReplay = validateAssetReferences.mock.calls.length;
    expect(await f.cards.show(input, f.source("show-asset"))).toEqual(card);
    expect(await f.cards.update(update, f.source("update-asset"))).toEqual(updated);
    expect(validateAssetReferences).toHaveBeenCalledTimes(callsBeforeReplay);
    await expect(f.cards.update({ ...input, cardId: card.cardId, revision: updated.revision }, f.source("new-update-with-private-asset"))).rejects.toMatchObject({ status: 403 });
    expect(await f.cards.get(card.cardId)).toEqual(updated);
    expect((await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(ContentPublicationEntry.is)).toHaveLength(1);
  });

  it("isolates identical model call IDs across independent Hubs and rejects an old tab's command", async () => {
    const first = await fixture();
    const second = await fixture();
    expect(first.conversation.id).toBe(second.conversation.id);
    const oldCard = await first.cards.show(form(), first.source("call_0"));
    const newCard = await second.cards.show(form(), second.source("call_0"));
    expect(oldCard.cardId).not.toBe(newCard.cardId);
    expect(oldCard.actions.map((action) => action.id)).not.toEqual(newCard.actions.map((action) => action.id));
    await expect(second.cards.submit(command(oldCard), second.source("old-tab"))).rejects.toMatchObject({ code: "ui_card_not_found", status: 404 });
    expect(await second.cards.get(newCard.cardId)).toEqual(newCard);
    expect(await second.cards.show(form(), second.source("call_0"))).toEqual(newCard);
  });

  it("adds a namespace lazily to a legacy document without changing existing cards or call receipts", async () => {
    const f = await fixture();
    const oldCard = await f.cards.show(form(), f.source("legacy-call"));
    await f.harness.commit(async (tx) => { delete (await tx.doc(UiCardsDoc)).namespace; }, BACKGROUND_CONTEXT);
    expect(await f.cards.get(oldCard.cardId)).toEqual(oldCard);
    expect(await f.cards.show(form(), f.source("legacy-call"))).toEqual(oldCard);
    expect((await f.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT))!.namespace).toBeUndefined();
    const newCard = await f.cards.show(form(), f.source("new-call"));
    expect((await f.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT))!.namespace).toEqual(expect.any(String));
    expect(await f.cards.get(oldCard.cardId)).toEqual(oldCard);
    expect(await f.cards.show(form(), f.source("legacy-call"))).toEqual(oldCard);
    expect(await f.cards.show(form(), f.source("new-call"))).toEqual(newCard);
  });

  it("issues action IDs and appends one ordered publication for an idempotent tool call", async () => {
    const f = await fixture();
    const card = await f.cards.show(form(), f.source("show-1"));
    expect(card.actions[0]!.id).toMatch(/^uia_/);
    expect(card.spec.elements.submit!.props.actionId).toBe(card.actions[0]!.id);
    expect(UiCardSnapshotSchema.safeParse(card).success).toBe(true);
    expect(await f.cards.show(form(), f.source("show-1"))).toEqual(card);
    await expect(f.cards.show({ ...form(), title: "不同内容" }, f.source("show-1"))).rejects.toMatchObject({ code: "ui_call_conflict" });
    const entries = await f.conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const publications = entries.items.filter(ContentPublicationEntry.is);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.data.parts[0]).toMatchObject({ type: "ui", cardId: card.cardId, fallbackText: card.title });
    expect(await f.cards.snapshot(Number(f.conversation.id))).toEqual([card]);
  });

  it("updates a ready card with CAS without appending a second publication", async () => {
    const f = await fixture();
    const first = await f.cards.show(form(), f.source("show"));
    const update = { ...form(), title: "新方案", cardId: first.cardId, revision: first.revision };
    const second = await f.cards.update(update, f.source("update"));
    expect(second).toMatchObject({ revision: 2, title: "新方案", sourceEntryId: first.sourceEntryId });
    expect(await f.cards.update(update, f.source("update"))).toEqual(second);
    await expect(f.cards.update(update, f.source("stale-update"))).rejects.toMatchObject({ status: 409, card: second });
    const entries = await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.filter(ContentPublicationEntry.is)).toHaveLength(1);
  });

  it("atomically accepts only one device, and rejects changed or newly identified resubmissions", async () => {
    const f = await fixture();
    const card = await f.cards.show(form(), f.source("show"));
    const input = command(card);
    const outcomes = await Promise.allSettled([f.cards.submit(input, f.source("device-a")), f.cards.submit({ ...input, commandId: "command-2" }, f.source("device-b"))]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const receipt = await f.cards.submit(input, f.source("retry"));
    expect(receipt).toMatchObject({ status: "submitted", revision: 2, deduplicated: true, card: { committedState: input.values } });
    await expect(f.cards.submit({ ...input, values: { ...input.values, name: "changed" } }, f.source("retry"))).rejects.toMatchObject({ code: "ui_command_conflict" });
    await expect(f.cards.submit({ ...input, revision: 2, commandId: "new-command" }, f.source("retry"))).rejects.toMatchObject({ status: 409 });
    await f.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const entries = await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.filter(UiActionEntry.is)).toHaveLength(1);
    expect(entries.items.filter((entry) => UserEntry.is(entry) || MocoUserEntry.is(entry))).toHaveLength(1);
    const serialized = JSON.stringify((await f.conversation.context(BACKGROUND_CONTEXT)).messages);
    expect(serialized).toContain("moco.ui.action");
    expect(serialized).toContain("示例");
    const doc = await f.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    expect(Object.keys(doc!.receipts)).toHaveLength(3);
  });

  it("shares server and client field validation and cancels without requiring a completed form", async () => {
    const f = await fixture();
    const card = await f.cards.show(form(), f.source("show"));
    const action = card.actions.find((item) => item.kind === "submit")!;
    expect(validateUiActionValues(action, { name: "", count: 9, choice: "shell" })).toMatchObject({ success: false, errors: { name: expect.any(String), count: expect.any(String), choice: expect.any(String) } });
    await expect(f.cards.submit({ ...command(card), values: { name: "", count: 9 } }, f.source("bad"))).rejects.toMatchObject({ code: "invalid_ui_values" });
    expect((await f.cards.get(card.cardId))!.status).toBe("ready");
    const receipt = await f.cards.submit({ ...command(card, "cancel-command"), actionId: card.actions.find((item) => item.kind === "cancel")!.id, values: {} }, f.source("cancel"));
    expect(receipt.status).toBe("cancelled");
    expect(receipt.card!.committedState).toEqual({ count: 1, choice: "safe" });
  });

  it("stores structured UI input as trusted user text even when a field contains an attachment marker", async () => {
    const f = await fixture();
    const input = form(); input.spec.elements.name!.props.maxLength = 200;
    const card = await f.cards.show(input, f.source("show-marker-field"));
    const marker = '<!--moco-attachments:[{"id":"private-draft"}]-->';
    const action = { ...command(card, "marker-field-command"), values: { name: marker, count: 2, choice: "safe" } };
    await f.cards.submit(action, f.source("submit-marker"));
    await f.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const entry = (await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.find((item) => item.kind === MocoUserEntry.kind)!;
    const data = entry.data as { mocoContentVersion: number; text: string; attachments: unknown[] };
    expect(data.mocoContentVersion).toBe(1);
    expect(data.attachments).toEqual([]);
    expect(JSON.parse(data.text)).toMatchObject({ type: "moco.ui.action", values: action.values });
  });

  it("refuses cross-conversation cards and returns the newest snapshot after stale drafts", async () => {
    const f = await fixture();
    const first = await f.cards.show(form(), f.source("show"));
    const other = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    await expect(f.cards.submit(command(first), { conversationId: Number(other.id) })).rejects.toMatchObject({ status: 404 });
    const latest = await f.cards.update({ ...form(), title: "最新内容", cardId: first.cardId, revision: 1 }, f.source("update"));
    await expect(f.cards.submit(command(first), f.source("stale"))).rejects.toMatchObject({ code: "ui_revision_conflict", card: latest });
  });

  it("restores original receipts and card locks after a real SQLite reopen", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-ui-cards-"));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const db = path.join(directory, "state.sqlite");
    const first = await fixture(await openNodeSqliteStorage(db));
    const card = await first.cards.show(form(), first.source("show"));
    const namespace = (await first.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT))!.namespace;
    expect(namespace).toEqual(expect.any(String));
    const input = command(card);
    const receipt = await first.cards.submit(input, first.source("device"));
    await first.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await first.close();
    const restored = await fixture(await openNodeSqliteStorage(db));
    expect((await restored.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT))!.namespace).toBe(namespace);
    expect(await restored.cards.get(card.cardId)).toEqual(receipt.card);
    expect(await restored.cards.show(form(), restored.source("show"))).toEqual(card);
    expect(await restored.cards.submit(input, restored.source("retry"))).toEqual({ ...receipt, deduplicated: true });
    await expect(restored.cards.submit({ ...input, revision: receipt.revision, commandId: "after-restart" }, restored.source("new"))).rejects.toMatchObject({ status: 409 });
  });

  it("retains accepted and rejected command results beyond the old 256-command window", async () => {
    const f = await fixture();
    const card = await f.cards.show(form(), f.source("show"));
    const input = command(card);
    const receipt = await f.cards.submit(input, f.source("device"));
    for (let i = 0; i < 270; i++) await expect(f.cards.submit({ ...input, commandId: `later-${i}` }, f.source("device"))).rejects.toMatchObject({ status: 409 });
    expect(Object.keys((await f.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT))!.receipts)).toHaveLength(271);
    expect(await f.cards.submit(input, f.source("retry-old"))).toEqual({ ...receipt, deduplicated: true });
    await expect(f.cards.submit({ ...input, commandId: "later-0", values: { ...input.values, name: "changed" } }, f.source("retry-rejected"))).rejects.toMatchObject({ code: "ui_command_conflict" });
  });

  it("rolls back the card, receipt and admitted input together if the transaction fails", async () => {
    const f = await fixture();
    const card = await f.cards.show(form(), f.source("show"));
    const handle = Object.create(f.conversation) as Conversation;
    handle.submit = (async (...args: Parameters<Conversation["submit"]>) => {
      await f.conversation.submit(...args);
      throw new Error("injected failure after admission");
    }) as Conversation["submit"];
    const lookup = vi.spyOn(f.harness, "conversation").mockResolvedValueOnce(handle);
    await expect(f.cards.submit(command(card), f.source("device"))).rejects.toThrow("injected failure");
    lookup.mockRestore();
    expect(await f.cards.get(card.cardId)).toEqual(card);
    expect(Object.keys((await f.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT))!.receipts)).toHaveLength(0);
    expect((await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(UiActionEntry.is)).toHaveLength(0);
    expect(JSON.stringify((await f.conversation.context(BACKGROUND_CONTEXT)).messages)).not.toContain("moco.ui.action");
  });

  it("runs show through the actual Pi tool registry", async () => {
    const f = await fixture();
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("moco_ui_show", form())], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("请选择。")]),
    ]);
    await f.conversation.submit({ type: "input", content: "显示选择卡" }, BACKGROUND_CONTEXT);
    await f.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const cards = await f.cards.snapshot(Number(f.conversation.id));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe(form().title);
  });

  it("imports an asset once, preserves call order and durable publication identity", async () => {
    const f = await fixture();
    const importer = vi.fn(async () => ({ id: "managed-1", name: "clip.mp4", mimeType: "video/mp4", size: 4, kind: "video" as const, url: "/api/uploads/managed-1" }));
    const input = { path: "./output/clip.mp4", caption: "结果" };
    const [first, second] = await Promise.all([f.cards.publishAsset(input, f.source("publish"), importer), f.cards.publishAsset(input, f.source("publish"), importer)]);
    expect(first).toEqual(second); expect(importer).toHaveBeenCalledTimes(1);
    await f.cards.show(form(), f.source("show-after"));
    await f.cards.publishAsset(input, f.source("publish"), importer);
    expect(importer).toHaveBeenCalledTimes(1);
    await expect(f.cards.publishAsset({ path: "changed.mp4" }, f.source("publish"), importer)).rejects.toMatchObject({ code: "ui_call_conflict" });
    const publications = (await f.conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(ContentPublicationEntry.is);
    expect(publications.map((entry) => entry.data.parts[0]!.type)).toEqual(["video", "ui"]);
  });
});

describe("closed UI catalog", () => {
  it("rejects executors, inline events, arbitrary URLs, prototype paths and unknown components", () => {
    for (const change of [
      (input: UiCardInput) => { input.spec.elements.submit!.props.url = "https://example.com"; },
      (input: UiCardInput) => { Object.assign(input.spec.elements.submit!, { on: { press: { action: "shell" } } }); },
      (input: UiCardInput) => { input.spec.elements.name!.props.field = "constructor"; },
      (input: UiCardInput) => { input.spec.elements.name!.props.field = "user/name"; },
      (input: UiCardInput) => { input.spec.elements.name!.type = "iframe" as never; },
      (input: UiCardInput) => { Object.assign(input.actions[0]!, { tool: "bash" }); },
    ]) { const input = form(); change(input); expect(() => validateUiCardInput(input)).toThrow(); }
  });

  it("rejects cycles, unreachable nodes, deep trees and excessive tables", () => {
    const cycle = form(); cycle.spec.elements.card!.children!.push("card");
    expect(() => validateUiCardInput(cycle)).toThrow();
    const disconnected = form(); disconnected.spec.elements.orphan = { type: "Text", props: { text: "hidden" } };
    expect(() => validateUiCardInput(disconnected)).toThrow();
    const table = form(); table.spec.elements.name = { type: "Table", props: { columns: [{ key: "value", label: "值" }], rows: Array.from({ length: 101 }, () => ({ value: "x" })) } };
    expect(() => validateUiCardInput(table)).toThrow();
    const deep = form();
    for (let i = 0; i < 9; i++) deep.spec.elements[`deep${i}`] = { type: "Stack", props: {}, children: [i === 8 ? "card" : `deep${i + 1}`] };
    deep.spec.root = "deep0";
    expect(() => validateUiCardInput(deep)).toThrow();
  });
});
