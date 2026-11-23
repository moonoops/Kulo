import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineEntry, type ConversationId, type Harness, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import {
  UiActionInputSchema, getUiSpecFields, messagePartFallback, validateUiActionValues, validateUiCardInput, validateUiValues,
  type ChatAttachment, type ChatReplyReference, type DiagramMotionMode, type MessagePart, type UiActionDefinition, type UiActionInput, type UiActionReceipt,
  type UiCardInput, type UiCardSnapshot, type UiFieldDefinition, type UiSpec,
} from "@kulo/protocol";

export interface UiCardSource {
  conversationId: number;
  callId: string;
  toolCallId?: string;
  topicId?: string;
  ticketId?: string;
}
export interface UiAssetPublicationInput { path: string; assetId?: string; name?: string; mimeType?: string; caption?: string; ticketId?: string }
export interface UiDiagramPublicationInput {
  title: string;
  svg: string;
  fallbackText: string;
  caption?: string;
  motion?: DiagramMotionMode;
  allowGeometryWarnings?: boolean;
}
export interface ContentPublicationData {
  parts: MessagePart[];
  fallbackText: string;
  createdAt?: number;
  source?: { conversationId: number; callId: string };
}
export const ContentPublicationEntry = defineEntry<ContentPublicationData & JsonObject>("kulo.content_publication");
export const UiActionEntry = defineEntry<JsonObject>("kulo.ui_action");
export const KuloUserEntry = defineEntry<{ kuloContentVersion: 1; text: string; attachments: ChatAttachment[]; replyTo?: ChatReplyReference; agentDispatchIntent?: import("@kulo/protocol").AgentDispatchIntent } & JsonObject>("kulo.user");

type Operation = { fingerprint: string; result: { kind: "card"; card: UiCardSnapshot } | { kind: "asset"; asset: ChatAttachment } | { kind: "device-invitation" } };
type ActionOutcome = { ok: true; receipt: UiActionReceipt } | { ok: false; error: { code: string; message: string; status: number; card: UiCardSnapshot } };
type StoredReceipt = { fingerprint: string; outcome: ActionOutcome };
export interface UiCardsState {
  namespace?: string;
  cards: Record<string, UiCardSnapshot>;
  operations: Record<string, Operation>;
  receipts: Record<string, StoredReceipt>;
  publicationFailures?: Record<string, string>;
}
export const UiCardsDoc = defineDoc<UiCardsState & JsonObject>({
  kind: "kulo.ui-cards", version: 1, scope: "session",
  initial: () => ({ namespace: randomUUID(), cards: {}, operations: {}, receipts: {} }) as UiCardsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class UiCardError extends Error {
  readonly code: string;
  readonly status: number;
  readonly card?: UiCardSnapshot;
  constructor(code: string, message: string, status = 400, card?: UiCardSnapshot) {
    super(message); this.name = "UiCardError"; this.code = code; this.status = status;
    if (card) this.card = clone(card);
  }
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function sourceKey(source: UiCardSource): string { return `call_${hash([source.conversationId, source.callId])}`; }
function publicationSource(source: UiCardSource): Pick<ContentPublicationData, "source"> {
  return source.toolCallId ? { source: { conversationId: source.conversationId, callId: source.toolCallId } } : {};
}
function checkSource(source: UiCardSource): void {
  if (!Number.isSafeInteger(source.conversationId) || source.conversationId < 0 || typeof source.callId !== "string" || !source.callId || source.callId.length > 240) throw new UiCardError("invalid_ui_source", "卡片来源无效。");
}
function validatedInput(raw: unknown): UiCardInput {
  try { return validateUiCardInput(raw); }
  catch (error) { throw new UiCardError("invalid_ui_spec", error instanceof Error ? error.message : "卡片格式无效。"); }
}
function actionFields(base: UiFieldDefinition[], action: UiActionDefinition): UiFieldDefinition[] {
  return base.map((field) => {
    const declared = action.fields?.find((item) => item.name === field.name);
    if (!declared) return clone(field);
    const options = field.options && declared.options ? field.options.filter((value) => declared.options!.includes(value)) : field.options;
    if (options && !options.length) throw new UiCardError("invalid_ui_spec", "选项约束没有可用值。");
    const min = field.min === undefined ? declared.min : declared.min === undefined ? field.min : Math.max(field.min, declared.min);
    const max = field.max === undefined ? declared.max : declared.max === undefined ? field.max : Math.min(field.max, declared.max);
    if (min !== undefined && max !== undefined && min > max) throw new UiCardError("invalid_ui_spec", "字段范围没有可用值。");
    return { ...field, ...(declared.label ? { label: declared.label } : {}), required: !!(field.required || declared.required),
      ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }),
      ...(field.maxLength === undefined && declared.maxLength === undefined ? {} : { maxLength: Math.min(field.maxLength ?? 32_000, declared.maxLength ?? 32_000) }),
      ...(options ? { options } : {}),
    };
  });
}
function normalize(input: UiCardInput, cardId: string): Pick<UiCardSnapshot, "title" | "spec" | "actions" | "committedState"> {
  const spec = clone(input.spec);
  const fields = getUiSpecFields(spec);
  const aliases = new Map(input.actions.map((action) => [action.id, `uia_${hash([cardId, action.id]).slice(0, 32)}`]));
  const actions = input.actions.map((action) => ({ ...clone(action), id: aliases.get(action.id)!, fields: action.kind === "submit" ? actionFields(fields, action) : [] }));
  for (const element of Object.values(spec.elements)) if (element.type === "Button") element.props.actionId = aliases.get(String(element.props.actionId))!;
  let committedState;
  try { committedState = validateUiValues(fields, spec.state?.values ?? {}, false); }
  catch (error) { throw new UiCardError("invalid_ui_spec", error instanceof Error ? error.message : "初始输入无效。"); }
  return { title: input.title, spec, actions, committedState };
}

export interface UiSubmitOptions {
  /** Runs inside the same durable tx right before conversation.submit, only on non-deduplicated accepted submits. */
  beforeConversationSubmit?: (tx: Tx, ctx: {
    card: UiCardSnapshot;
    action: UiActionDefinition;
    values: import("@kulo/protocol").UiValues;
  }) => Promise<{ resultSummary?: string; systemEffect?: JsonObject } | void>;
}

export interface KuloUiCardsOptions {
  harness: Harness;
  onChange?: (card: UiCardSnapshot) => void | Promise<void>;
  validateAssetReferences?: (spec: UiSpec, source: UiCardSource) => void;
}

export class KuloUiCards {
  readonly #host: KuloUiCardsOptions;
  readonly #imports = new Map<string, { fingerprint: string; promise: Promise<ChatAttachment> }>();
  constructor(host: KuloUiCardsOptions) { this.#host = host; }

  async snapshot(conversationId: number): Promise<UiCardSnapshot[]> {
    const doc = await this.#host.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    return clone(Object.values(doc?.cards ?? {}).filter((card) => card.originConversationId === conversationId));
  }

  async get(cardId: string): Promise<UiCardSnapshot | undefined> {
    const doc = await this.#host.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    return doc?.cards[cardId] ? clone(doc.cards[cardId]) : undefined;
  }

  async showDeviceInvitation(hubId: string, hubName: string, source: UiCardSource): Promise<void> {
    checkSource(source);
    const key = sourceKey(source);
    const fingerprint = hash({ type: "device-invitation", hubId });
    await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const prior = doc.operations[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.result.kind !== "device-invitation") throw new UiCardError("ui_call_conflict", "同一工具调用不能发布不同内容。", 409);
        return;
      }
      const part: MessagePart = { partId: `invite:${key}`, type: "device-invitation", hubId, hubName };
      await tx.appendEntry(ContentPublicationEntry, source.conversationId as ConversationId, {
        data: { parts: [part], fallbackText: messagePartFallback(part), createdAt: Date.now(), ...publicationSource(source) } as ContentPublicationData & JsonObject,
      });
      doc.operations[key] = { fingerprint, result: { kind: "device-invitation" } };
    }, BACKGROUND_CONTEXT);
  }

  async show(raw: UiCardInput, source: UiCardSource): Promise<UiCardSnapshot> {
    checkSource(source);
    const input = validatedInput(raw);
    const key = sourceKey(source);
    const fingerprint = hash({ type: "show", input });
    let changed = false;
    const result = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const existing = doc.operations[key];
      if (existing) return this.#priorCard(existing, fingerprint);
      doc.namespace ??= randomUUID();
      const cardId = `uic_${hash([doc.namespace, source.conversationId, source.callId]).slice(0, 32)}`;
      const values = normalize(input, cardId);
      this.#host.validateAssetReferences?.(values.spec, source);
      const card: UiCardSnapshot = { cardId, schemaVersion: 1, catalogVersion: 1, revision: 1, ...values, status: "ready", originConversationId: source.conversationId,
        ...(source.topicId ? { topicId: source.topicId } : {}), ...(source.ticketId ? { ticketId: source.ticketId } : {}) };
      const fallbackText = input.fallbackText?.trim() || input.title;
      const entry = await tx.appendEntry(ContentPublicationEntry, source.conversationId as ConversationId, {
        data: { parts: [{ partId: `${cardId}:ui`, type: "ui", cardId, fallbackText }], fallbackText, createdAt: Date.now(), ...publicationSource(source) } as ContentPublicationData & JsonObject,
      });
      card.sourceEntryId = Number(entry.id);
      doc.cards[cardId] = clone(card);
      doc.operations[key] = { fingerprint, result: { kind: "card", card: clone(card) } };
      changed = true;
      return card;
    }, BACKGROUND_CONTEXT);
    if (changed) await this.#host.onChange?.(clone(result));
    return clone(result);
  }

  async update(raw: UiCardInput & { cardId: string; revision: number }, source: UiCardSource): Promise<UiCardSnapshot> {
    checkSource(source);
    const { cardId, revision, ...definition } = raw;
    if (typeof cardId !== "string" || !Number.isSafeInteger(revision) || revision < 1) throw new UiCardError("invalid_ui_revision", "卡片版本无效。");
    const input = validatedInput(definition);
    const key = sourceKey(source);
    const fingerprint = hash({ type: "update", cardId, revision, input });
    let changed = false;
    const result = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const existing = doc.operations[key];
      if (existing) return this.#priorCard(existing, fingerprint);
      const current = doc.cards[cardId];
      this.#scope(current, source.conversationId);
      if (current!.revision !== revision || current!.status !== "ready") throw new UiCardError("ui_revision_conflict", "卡片已更新，请查看最新内容。", 409, current);
      const card: UiCardSnapshot = { ...clone(current!), ...normalize(input, cardId), revision: revision + 1 };
      this.#host.validateAssetReferences?.(card.spec, source);
      doc.cards[cardId] = clone(card);
      doc.operations[key] = { fingerprint, result: { kind: "card", card: clone(card) } };
      changed = true;
      return card;
    }, BACKGROUND_CONTEXT);
    if (changed) await this.#host.onChange?.(clone(result));
    return clone(result);
  }

  async submit(raw: UiActionInput, actor: { conversationId: number }, options?: UiSubmitOptions): Promise<UiActionReceipt> {
    const parsed = UiActionInputSchema.safeParse(raw);
    if (!parsed.success) throw new UiCardError("invalid_ui_action", "卡片操作格式无效。");
    const input = parsed.data;
    const conversation = await this.#host.harness.conversation(actor.conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new UiCardError("ui_card_not_found", "卡片所在对话不存在。", 404);
    const fingerprint = hash(input);
    const commandKey = `command_${hash([actor.conversationId, input.commandId])}`;
    let changed = false;
    const outcome = await this.#host.harness.commit<ActionOutcome>(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const current = doc.cards[input.cardId];
      this.#scope(current, actor.conversationId);
      const prior = doc.receipts[commandKey];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new UiCardError("ui_command_conflict", "同一操作编号不能提交不同内容。", 409, current);
        return prior.outcome.ok ? { ok: true, receipt: { ...clone(prior.outcome.receipt), deduplicated: true } } : clone(prior.outcome);
      }
      const reject = (code: string, message: string, status: number): ActionOutcome => {
        const outcome: ActionOutcome = { ok: false, error: { code, message, status, card: clone(current!) } };
        doc.receipts[commandKey] = { fingerprint, outcome: clone(outcome) };
        return outcome;
      };
      if (current!.revision !== input.revision || current!.status !== "ready") return reject("ui_revision_conflict", "卡片已更新，请查看最新内容。", 409);
      const action = current!.actions.find((item) => item.id === input.actionId);
      if (!action) return reject("invalid_ui_action", "卡片操作不存在。", 400);
      const values = validateUiActionValues(action, input.values);
      if (!values.success) return reject("invalid_ui_values", Object.values(values.errors).join("；"), 400);
      const card: UiCardSnapshot = { ...clone(current!), revision: current!.revision + 1,
        status: action.kind === "cancel" ? "cancelled" : "submitted", committedState: action.kind === "cancel" ? clone(current!.committedState) : clone(values.data),
        resultSummary: action.kind === "cancel" ? "已取消" : "已提交给 Agent" };
      const hookResult = await options?.beforeConversationSubmit?.(tx, { card: clone(card), action: clone(action), values: clone(values.data) });
      if (hookResult?.resultSummary) card.resultSummary = hookResult.resultSummary;
      // Keep `type: "kulo.ui.action"` as the first key to preserve chat transcript prefix matching.
      const structured = {
        type: "kulo.ui.action",
        schemaVersion: 1,
        cardId: card.cardId,
        revision: input.revision,
        title: card.title,
        action: { id: action.id, label: action.label, kind: action.kind },
        values: values.data,
        commandId: input.commandId,
        ...(hookResult?.systemEffect ? { systemEffect: hookResult.systemEffect } : {}),
      };
      // Admission must precede appendEntry; Pi makes the input, lock and receipt one durable commit.
      const text = JSON.stringify(structured);
      const submissionId = await conversation.submit(tx, { type: "input", content: text, whenBusy: "followUp",
        entry: { kind: KuloUserEntry.kind, data: { kuloContentVersion: 1, text, attachments: [] } } });
      const receipt: UiActionReceipt = { commandId: input.commandId, cardId: card.cardId, revision: card.revision, status: card.status, card: clone(card) };
      doc.cards[input.cardId] = clone(card);
      doc.receipts[commandKey] = { fingerprint, outcome: { ok: true, receipt: clone(receipt) } };
      await tx.appendEntry(UiActionEntry, actor.conversationId as ConversationId, { data: { ...structured, submissionId: Number(submissionId), receipt: clone(receipt) } as unknown as JsonObject });
      changed = true;
      return { ok: true, receipt };
    }, BACKGROUND_CONTEXT);
    if (!outcome.ok) throw new UiCardError(outcome.error.code, outcome.error.message, outcome.error.status, outcome.error.card);
    if (changed && outcome.receipt.card) await this.#host.onChange?.(clone(outcome.receipt.card));
    return clone(outcome.receipt);
  }

  async settle(
    cardId: string,
    resolution: {
      status: "submitted" | "cancelled";
      resultSummary: string;
      committedState?: import("@kulo/protocol").UiValues;
    },
  ): Promise<UiCardSnapshot | undefined> {
    let changed = false;
    const updated = await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const current = doc.cards[cardId];
      if (!current) return undefined;
      if (current.status !== "ready" && current.status !== "failed") return clone(current);
      const nextCommitted = resolution.committedState
        ? validateUiValues(getUiSpecFields(current.spec), resolution.committedState, false)
        : clone(current.committedState);
      const card: UiCardSnapshot = {
        ...clone(current),
        revision: current.revision + 1,
        status: resolution.status,
        committedState: nextCommitted,
        resultSummary: resolution.resultSummary,
      };
      doc.cards[cardId] = clone(card);
      changed = true;
      return card;
    }, BACKGROUND_CONTEXT);
    if (changed && updated) await this.#host.onChange?.(clone(updated));
    return updated ? clone(updated) : undefined;
  }

  async hasPublishedOperation(source: UiCardSource, visibility: "chat" | "review" = "chat"): Promise<boolean> {
    checkSource(source);
    const key = visibility === "review" ? `review:${sourceKey(source)}` : sourceKey(source);
    const doc = await this.#host.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    return Boolean(doc?.operations[key]);
  }

  async stageAsset(input: UiAssetPublicationInput, source: UiCardSource, importAsset: () => Promise<ChatAttachment>, finalize?: (tx: Tx, asset: ChatAttachment) => Promise<void>): Promise<ChatAttachment> {
    return this.publishAsset(input, source, importAsset, finalize, "review");
  }

  async publishAsset(input: UiAssetPublicationInput, source: UiCardSource, importAsset: () => Promise<ChatAttachment>, finalize?: (tx: Tx, asset: ChatAttachment) => Promise<void>, visibility: "chat" | "review" = "chat"): Promise<ChatAttachment> {
    checkSource(source);
    if (typeof input.path !== "string" || !input.path.trim() || input.path.length > 4096 || input.name && input.name.length > 240 || input.mimeType && input.mimeType.length > 120 || input.caption && input.caption.length > 2000) throw new UiCardError("invalid_asset_publication", "资源参数无效。");
    const key = visibility === "review" ? `review:${sourceKey(source)}` : sourceKey(source);
    const fingerprint = hash({ type: visibility === "review" ? "stage" : "publish", input });
    const doc = await this.#host.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    if (doc?.operations[key]) return this.#priorAsset(doc.operations[key], fingerprint);
    const active = this.#imports.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new UiCardError("ui_call_conflict", "同一工具调用不能发布不同内容。", 409);
      return clone(await active.promise);
    }
    const promise = this.#publishImported(input, source, fingerprint, importAsset, finalize, visibility);
    this.#imports.set(key, { fingerprint, promise });
    try { return clone(await promise); } finally { this.#imports.delete(key); }
  }

  async publishDiagram(
    input: { title: string; svg: string; fallbackText: string; caption?: string; motion: DiagramMotionMode },
    source: UiCardSource,
    importAsset: () => Promise<ChatAttachment>,
    finalize?: (tx: Tx, asset: ChatAttachment) => Promise<void>,
  ): Promise<ChatAttachment> {
    checkSource(source);
    const key = `diagram:${sourceKey(source)}`;
    const fingerprint = hash({ type: "diagram", ...input });
    const doc = await this.#host.harness.snapshot(UiCardsDoc, BACKGROUND_CONTEXT);
    if (doc?.operations[key]) return this.#priorAsset(doc.operations[key], fingerprint);
    const active = this.#imports.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new UiCardError("ui_call_conflict", "同一工具调用不能发布不同内容。", 409);
      return clone(await active.promise);
    }
    const promise = (async () => {
      const asset = await importAsset();
      if (!asset || !asset.id || asset.kind !== "file" || asset.presentation !== "diagram" || !asset.url.startsWith("/api/uploads/")) {
        throw new UiCardError("invalid_published_asset", "图示资源导入无效。");
      }
      return this.#host.harness.commit(async (tx) => {
        const currentDoc = await tx.doc(UiCardsDoc);
        if (currentDoc.operations[key]) return this.#priorAsset(currentDoc.operations[key], fingerprint);
        await finalize?.(tx, asset);
        const topFallback = `${input.title}\n${input.fallbackText}`;
        const parts: MessagePart[] = [{
          partId: `diagram_${hash([source.conversationId, source.callId]).slice(0, 32)}`,
          type: "file",
          assetId: asset.id,
          asset: clone(asset),
          fallbackText: input.fallbackText,
          ...(input.caption ? { caption: input.caption } : {}),
        }];
        await tx.appendEntry(ContentPublicationEntry, source.conversationId as ConversationId, {
          data: { parts, fallbackText: topFallback, createdAt: Date.now(), ...publicationSource(source) } as ContentPublicationData & JsonObject,
        });
        currentDoc.operations[key] = { fingerprint, result: { kind: "asset", asset: clone(asset) } };
        return clone(asset);
      }, BACKGROUND_CONTEXT);
    })();
    this.#imports.set(key, { fingerprint, promise });
    try { return clone(await promise); } finally { this.#imports.delete(key); }
  }

  async publishAssetFailure(source: UiCardSource, message: string, markdown = message): Promise<void> {
    checkSource(source);
    await this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const key = sourceKey(source);
      if (doc.publicationFailures?.[key]) return;
      doc.publicationFailures ??= {};
      doc.publicationFailures[key] = message;
      await tx.appendEntry(ContentPublicationEntry, source.conversationId as ConversationId, {
        data: { parts: [{ partId: `asset-failure:${key}`, type: "markdown", text: markdown }], fallbackText: message, createdAt: Date.now(), ...publicationSource(source) } as ContentPublicationData & JsonObject,
      });
    }, BACKGROUND_CONTEXT);
  }

  async #publishImported(input: UiAssetPublicationInput, source: UiCardSource, fingerprint: string, importAsset: () => Promise<ChatAttachment>, finalize?: (tx: Tx, asset: ChatAttachment) => Promise<void>, visibility: "chat" | "review" = "chat"): Promise<ChatAttachment> {
    const asset = await importAsset();
    if (!asset || !asset.id || !["image", "audio", "video", "file"].includes(asset.kind) || !asset.url.startsWith("/api/uploads/")) throw new UiCardError("invalid_published_asset", "资源导入没有返回受管附件。");
    return this.#host.harness.commit(async (tx) => {
      const doc = await tx.doc(UiCardsDoc);
      const key = visibility === "review" ? `review:${sourceKey(source)}` : sourceKey(source);
      if (doc.operations[key]) return this.#priorAsset(doc.operations[key], fingerprint);
      await finalize?.(tx, asset);
      const fallbackText = input.caption || asset.name;
      const parts: MessagePart[] = [{ partId: `asset_${hash([source.conversationId, source.callId]).slice(0, 32)}`, type: asset.kind, assetId: asset.id, asset: clone(asset), ...(input.caption ? { caption: input.caption } : {}) }];
      if (visibility === "chat") await tx.appendEntry(ContentPublicationEntry, source.conversationId as ConversationId, { data: { parts, fallbackText, createdAt: Date.now(), ...publicationSource(source) } as ContentPublicationData & JsonObject });
      doc.operations[key] = { fingerprint, result: { kind: "asset", asset: clone(asset) } };
      return clone(asset);
    }, BACKGROUND_CONTEXT);
  }

  #scope(card: UiCardSnapshot | undefined, conversationId: number): void {
    if (!card || card.originConversationId !== conversationId) throw new UiCardError("ui_card_not_found", "卡片不存在。", 404);
  }
  #priorCard(operation: Operation, fingerprint: string): UiCardSnapshot {
    if (operation.fingerprint !== fingerprint || operation.result.kind !== "card") throw new UiCardError("ui_call_conflict", "同一工具调用不能提交不同内容。", 409);
    return clone(operation.result.card);
  }
  #priorAsset(operation: Operation, fingerprint: string): ChatAttachment {
    if (operation.fingerprint !== fingerprint || operation.result.kind !== "asset") throw new UiCardError("ui_call_conflict", "同一工具调用不能发布不同内容。", 409);
    return clone(operation.result.asset);
  }
}
