import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import type { ActionEffectState, ExecutionTrustMode, TicketWaitOption, UiCardInput, UiCardSnapshot, UiValues } from "@kulo/protocol";
import { hashConfirmationValue as hashValue } from "./action-confirmation-cards.js";
import { UiCardsDoc, type KuloUiCards } from "./ui-cards.js";

export {
  buildCustomizationConfirmCard,
  buildExternalPermissionCard,
  buildHostActionConfirmCard,
  buildMemoryServiceConfirmCard,
  buildStagedApplyConfirmCard,
  buildTicketDecisionCard,
  customizationValidateFingerprint,
  externalPermissionFingerprint,
  hostActionFingerprint,
  memoryServiceOperationFingerprint,
  stagedApplyFingerprint,
  ticketDecisionFingerprint,
} from "./action-confirmation-cards.js";

export type ActionConfirmationKind =
  | "customization_validate"
  | "external_permission"
  | "staged_apply"
  | "memory_service_operation"
  | "host_action"
  | "ticket_decision"
  | "computer_handoff";

export type ActionConfirmationPayload =
  | {
      kind: "customization_validate";
      sessionId: string;
      revision: number;
      summary: string;
      changedFiles: string[];
    }
  | {
      kind: "external_permission";
      ticketId: string;
      runEpoch: number;
      permissionId: string;
      title: string;
      choices: Array<{ id: string; label: string }>;
    }
  | {
      kind: "staged_apply";
      ticketId: string;
      runEpoch: number;
      commandId: string;
      paths?: string[];
      allowConflicts: boolean;
      sensitivePaths: string[];
      conflictFiles: string[];
    }
  | {
      kind: "memory_service_operation";
      jobId: string;
      clientId: string;
      operation: "deploy" | "configure" | "uninstall";
      deviceName: string;
      title: string;
      changes: string[];
    }
  | {
      kind: "host_action";
      envId: string;
      envName: string;
      summary: string;
      commands: string[];
      cwd?: string;
      timeoutMs?: number;
      ticketId?: string;
      runEpoch?: number;
      requestId?: string;
      executionMode?: ExecutionTrustMode;
    }
  | {
      kind: "ticket_decision";
      ticketId: string;
      runEpoch: number;
      question: string;
      options: TicketWaitOption[];
    }
  | {
      kind: "computer_handoff";
      ticketId: string;
      runEpoch: number;
      envId: string;
      target: "browser" | "desktop";
      sessionId: string;
      reason: string;
      url?: string;
      app?: string;
      expiresAt: number;
    };

export interface PendingActionConfirmation {
  id: string;
  cardId?: string;
  conversationId: number;
  kind: ActionConfirmationKind;
  fingerprint: string;
  status: "pending_orchestrator" | "pending" | "approved" | "denied";
  actionMap: Record<string, string>;
  createdAt: number;
  resolvedAt?: number;
  selectedChoiceId?: string;
  manualInstruction?: string;
  executed?: boolean;
  effect?: ActionEffectState;
  dispatchedAt?: number;
  lastError?: string;
  payload: ActionConfirmationPayload;
}

export function effectiveConfirmationEffect(record: Readonly<PendingActionConfirmation>): ActionEffectState {
  if (record.effect) return record.effect;
  return record.executed ? "confirmed" : "none";
}

export interface ActionConfirmationsState {
  byCardId: Record<string, PendingActionConfirmation>;
  byScopeFingerprint: Record<string, string>;
  byId?: Record<string, PendingActionConfirmation>;
}

export const ActionConfirmationsDoc = defineDoc<ActionConfirmationsState & JsonObject>({
  kind: "kulo.action-confirmations",
  version: 1,
  scope: "session",
  initial: () => ({ byCardId: {}, byScopeFingerprint: {}, byId: {} }) as ActionConfirmationsState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

function scopeKey(conversationId: number, kind: ActionConfirmationKind, fingerprint: string): string {
  return `${conversationId}:${kind}:${fingerprint}`;
}

function findRecord(doc: ActionConfirmationsState | undefined, idOrCardId: string): PendingActionConfirmation | undefined {
  if (!doc) return undefined;
  return (
    doc.byId?.[idOrCardId] ??
    doc.byCardId?.[idOrCardId] ??
    Object.values(doc.byCardId ?? {}).find((item) => item.id === idOrCardId)
  );
}

function writeRecord(doc: ActionConfirmationsState, record: PendingActionConfirmation): void {
  doc.byId ??= {};
  doc.byId[record.id] = record;
  if (record.cardId) {
    doc.byCardId[record.cardId] = record;
  }
}

function confirmationPayloadTicketId(payload: ActionConfirmationPayload): string | undefined {
  switch (payload.kind) {
    case "external_permission":
    case "staged_apply":
    case "ticket_decision":
    case "computer_handoff":
    case "host_action":
      return payload.ticketId;
    default:
      return undefined;
  }
}

/**
 * Atomically marks a card-bound confirmation as denied + executed inside an existing durable tx
 * (used by `submitUiAction` direct-stop path before `conversation.submit`, without calling `uiCards.settle`).
 */
export async function resolveCardConfirmationDeniedInTx(
  tx: Tx,
  cardId: string,
  actionId: string,
): Promise<PendingActionConfirmation | undefined> {
  const doc = await tx.doc(ActionConfirmationsDoc);
  const record = doc.byCardId[cardId];
  if (!record || record.status !== "pending") return undefined;
  const logical = record.actionMap[actionId];
  if (!logical) return undefined;
  const now = Date.now();
  record.status = "denied";
  record.selectedChoiceId = logical;
  record.resolvedAt = now;
  record.executed = true;
  record.effect = "confirmed";
  writeRecord(doc, record as PendingActionConfirmation & JsonObject);
  return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
}

export class KuloActionConfirmations {
  readonly #harness: Harness;
  readonly #uiCards: KuloUiCards;

  constructor(options: { harness: Harness; uiCards: KuloUiCards }) {
    this.#harness = options.harness;
    this.#uiCards = options.uiCards;
  }

  async lookup(
    conversationId: number,
    kind: ActionConfirmationKind,
    fingerprint: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const ref = doc?.byScopeFingerprint?.[scopeKey(conversationId, kind, fingerprint)];
    const record = ref ? findRecord(doc, ref) : undefined;
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async getById(idOrCardId: string, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const record = findRecord(doc, idOrCardId);
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async getByCardId(cardId: string, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation | undefined> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    const record = doc?.byCardId?.[cardId];
    return record ? JSON.parse(JSON.stringify(record)) as PendingActionConfirmation : undefined;
  }

  async listPendingForConversation(
    conversationId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation[]> {
    const doc = await this.#harness.snapshot(ActionConfirmationsDoc, context);
    if (!doc) return [];
    const byId = new Map<string, PendingActionConfirmation>();
    for (const record of Object.values(doc.byCardId ?? {})) {
      if (record.conversationId === conversationId && (record.status === "pending_orchestrator" || record.status === "pending")) {
        byId.set(record.id, record);
      }
    }
    for (const record of Object.values(doc.byId ?? {})) {
      if (record.conversationId === conversationId && (record.status === "pending_orchestrator" || record.status === "pending")) {
        byId.set(record.id, record);
      }
    }
    return [...byId.values()].map((record) => JSON.parse(JSON.stringify(record)) as PendingActionConfirmation);
  }

  async createPendingOrchestratorRequest(params: {
    conversationId: number;
    kind: ActionConfirmationKind;
    fingerprint: string;
    payload: ActionConfirmationPayload;
  }, context: Context = BACKGROUND_CONTEXT): Promise<PendingActionConfirmation> {
    const existing = await this.lookup(params.conversationId, params.kind, params.fingerprint, context);
    if (existing && (existing.status === "pending_orchestrator" || existing.status === "pending")) {
      return existing;
    }
    const confirmationId = `cfm_${hashValue([params.conversationId, params.kind, params.fingerprint, existing ? existing.resolvedAt ?? Date.now() : 0]).slice(0, 24)}`;
    const record: PendingActionConfirmation = {
      id: confirmationId,
      conversationId: params.conversationId,
      kind: params.kind,
      fingerprint: params.fingerprint,
      status: "pending_orchestrator",
      actionMap: {},
      createdAt: Date.now(),
      payload: JSON.parse(JSON.stringify(params.payload)) as ActionConfirmationPayload,
    };
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      doc.byScopeFingerprint[scopeKey(params.conversationId, params.kind, params.fingerprint)] = record.id;
    }, context);
    return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
  }

  async attachCardToRequest(
    idOrCardId: string,
    params: {
      topicId?: string;
      ticketId?: string;
      callId: string;
      cardInput: UiCardInput;
      logicalIds: readonly string[];
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ confirmation: PendingActionConfirmation; card: UiCardSnapshot | undefined }> {
    const existing = await this.getById(idOrCardId, context);
    if (!existing) {
      throw new Error("未找到对应的待处理请求。");
    }
    if (existing.status === "pending" && existing.cardId) {
      return { confirmation: existing, card: await this.#uiCards.get(existing.cardId) };
    }
    if (existing.status !== "pending_orchestrator") {
      throw new Error("该权限请求已经处理完成。");
    }
    const card = await this.#uiCards.show(params.cardInput, {
      conversationId: existing.conversationId,
      callId: `confirm:${existing.id}:${params.callId}`,
      toolCallId: params.callId,
      ...(params.topicId ? { topicId: params.topicId } : {}),
      ...(params.ticketId ? { ticketId: params.ticketId } : {}),
    });
    const actionMap: Record<string, string> = {};
    card.actions.forEach((action, index) => {
      const logical = params.logicalIds[index];
      if (logical !== undefined) actionMap[action.id] = logical;
    });
    const updated = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const live = findRecord(doc, existing.id);
      if (!live || live.status !== "pending_orchestrator") return undefined;
      live.cardId = card.cardId;
      live.actionMap = actionMap;
      live.status = "pending";
      live.manualInstruction = undefined;
      writeRecord(doc, live as PendingActionConfirmation & JsonObject);
      doc.byScopeFingerprint[scopeKey(live.conversationId, live.kind, live.fingerprint)] = live.id;
      return JSON.parse(JSON.stringify(live)) as PendingActionConfirmation;
    }, context);
    if (!updated) {
      await this.#uiCards.settle(card.cardId, { status: "cancelled", resultSummary: "请求已被其他操作处理" });
      const latest = await this.getById(existing.id, context);
      return { confirmation: latest ?? existing, card: await this.#uiCards.get(card.cardId) };
    }
    return { confirmation: updated, card };
  }

  async ensurePendingCard(params: {
    conversationId: number;
    topicId?: string;
    ticketId?: string;
    callId: string;
    kind: ActionConfirmationKind;
    fingerprint: string;
    cardInput: UiCardInput;
    logicalIds: readonly string[];
    payload: ActionConfirmationPayload;
  }, context: Context = BACKGROUND_CONTEXT): Promise<{ confirmation: PendingActionConfirmation; card: UiCardSnapshot | undefined }> {
    const existing = await this.lookup(params.conversationId, params.kind, params.fingerprint, context);
    if (existing && existing.status === "pending" && existing.cardId) {
      return { confirmation: existing, card: await this.#uiCards.get(existing.cardId) };
    }
    if (existing && existing.status === "pending_orchestrator") {
      return this.attachCardToRequest(
        existing.id,
        {
          topicId: params.topicId,
          ticketId: params.ticketId,
          callId: params.callId,
          cardInput: params.cardInput,
          logicalIds: params.logicalIds,
        },
        context,
      );
    }
    const confirmationId = `cfm_${hashValue([params.conversationId, params.kind, params.fingerprint, existing ? existing.resolvedAt ?? Date.now() : 0]).slice(0, 24)}`;
    const card = await this.#uiCards.show(params.cardInput, {
      conversationId: params.conversationId,
      callId: `confirm:${confirmationId}`,
      toolCallId: params.callId,
      ...(params.topicId ? { topicId: params.topicId } : {}),
      ...(params.ticketId ? { ticketId: params.ticketId } : {}),
    });
    const actionMap: Record<string, string> = {};
    card.actions.forEach((action, index) => {
      const logical = params.logicalIds[index];
      if (logical !== undefined) actionMap[action.id] = logical;
    });
    const record: PendingActionConfirmation = {
      id: confirmationId,
      cardId: card.cardId,
      conversationId: params.conversationId,
      kind: params.kind,
      fingerprint: params.fingerprint,
      status: "pending",
      actionMap,
      createdAt: Date.now(),
      payload: JSON.parse(JSON.stringify(params.payload)) as ActionConfirmationPayload,
    };
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      doc.byScopeFingerprint[scopeKey(params.conversationId, params.kind, params.fingerprint)] = record.id;
    }, context);
    return { confirmation: record, card };
  }

  async resolveFromUiSubmit(
    cardId: string,
    actionId: string,
    values?: UiValues,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = doc.byCardId[cardId];
      if (!record || record.status !== "pending") return undefined;
      const logical = record.actionMap[actionId];
      if (!logical) return undefined;
      const now = Date.now();
      if (logical === "manual") {
        const instruction = typeof values?.instruction === "string" ? values.instruction.trim() : "";
        const historicalCardRecord: PendingActionConfirmation = {
          ...(JSON.parse(JSON.stringify(record)) as PendingActionConfirmation),
          status: "approved",
          resolvedAt: now,
          selectedChoiceId: "manual",
          manualInstruction: instruction,
          executed: true,
        };
        const liveOrchestratorRecord: PendingActionConfirmation = {
          ...(JSON.parse(JSON.stringify(record)) as PendingActionConfirmation),
          actionMap: {},
          status: "pending_orchestrator",
          selectedChoiceId: "manual",
          manualInstruction: instruction,
          executed: false,
        };
        delete liveOrchestratorRecord.cardId;
        delete liveOrchestratorRecord.resolvedAt;
        doc.byCardId[cardId] = historicalCardRecord as PendingActionConfirmation & JsonObject;
        doc.byId ??= {};
        doc.byId[record.id] = liveOrchestratorRecord as PendingActionConfirmation & JsonObject;
        return JSON.parse(JSON.stringify(liveOrchestratorRecord)) as PendingActionConfirmation;
      }
      record.resolvedAt = now;
      record.selectedChoiceId = logical;
      if (record.kind === "external_permission") {
        record.status = "approved";
      } else if (record.kind === "ticket_decision") {
        const chosen = record.payload.kind === "ticket_decision"
          ? record.payload.options.find((opt) => opt.id === logical)
          : undefined;
        record.status = chosen?.action === "stop" ? "denied" : "approved";
      } else {
        record.status = logical === "confirm" ? "approved" : "denied";
      }
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
    }, context);
  }

  async resolveProgrammatically(
    idOrCardId: string,
    resolution: {
      status: "approved" | "denied";
      selectedChoiceId?: string;
      resultSummary: string;
      markExecuted?: boolean;
    },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation | undefined> {
    let openCardId: string | undefined;
    const resolved = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = findRecord(doc, idOrCardId);
      if (!record || record.executed || (record.status !== "pending_orchestrator" && record.status !== "pending")) {
        return undefined;
      }
      openCardId = record.cardId;
      record.status = resolution.status;
      record.resolvedAt = Date.now();
      if (resolution.selectedChoiceId !== undefined) {
        record.selectedChoiceId = resolution.selectedChoiceId;
      }
      record.executed = resolution.markExecuted ?? true;
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      return JSON.parse(JSON.stringify(record)) as PendingActionConfirmation;
    }, context);
    if (resolved && openCardId) {
      await this.#uiCards.settle(openCardId, {
        status: resolution.status === "approved" ? "submitted" : "cancelled",
        resultSummary: resolution.resultSummary,
      });
    }
    return resolved;
  }

  async markDispatched(idOrCardId: string, context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = findRecord(doc, idOrCardId);
      if (!record) return false;
      const current = effectiveConfirmationEffect(record);
      if (current === "dispatched" || current === "confirmed" || current === "unknown") {
        return false;
      }
      record.effect = "dispatched";
      record.dispatchedAt = Date.now();
      delete record.lastError;
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      return true;
    }, context);
  }

  async markOutcome(
    idOrCardId: string,
    effect: Exclude<ActionEffectState, "none" | "dispatched">,
    lastError?: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const record = findRecord(doc, idOrCardId);
      if (!record) return;
      record.effect = effect;
      if (effect === "confirmed" || effect === "unknown") {
        record.executed = true;
      }
      if (lastError) {
        record.lastError = lastError.slice(0, 400);
      } else {
        delete record.lastError;
      }
      writeRecord(doc, record as PendingActionConfirmation & JsonObject);
    }, context);
  }

  /**
   * Startup / failover recovery: transitions any confirmation left in `dispatched` from a crashed
   * process into `unknown` (never auto-replaying side effects) and returns those records so the Hub
   * can wake any waiting Worker tickets or notify conversations to verify actual state.
   */
  async reconcileDispatchedOnStartup(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<PendingActionConfirmation[]> {
    return this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const seen = new Set<string>();
      const recovered: PendingActionConfirmation[] = [];
      const visit = (record: PendingActionConfirmation | undefined) => {
        if (!record || seen.has(record.id)) return;
        seen.add(record.id);
        if (record.effect !== "dispatched") return;
        record.effect = "unknown";
        record.executed = true;
        record.lastError = "服务重启或切换期间操作状态未决，未自动重放，请先只读核验实际结果。";
        writeRecord(doc, record as PendingActionConfirmation & JsonObject);
        recovered.push(JSON.parse(JSON.stringify(record)) as PendingActionConfirmation);
      };
      for (const record of Object.values(doc.byId ?? {})) visit(record);
      for (const record of Object.values(doc.byCardId ?? {})) visit(record);
      return recovered;
    }, context);
  }

  async settlePendingForTicket(
    ticketId: string,
    resultSummary: string,
    options: { excludeKinds?: readonly ActionConfirmationKind[] } = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<number> {
    const excluded = new Set(options.excludeKinds ?? []);
    const openCardIds = new Set<string>();
    const settledIds = new Set<string>();
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(ActionConfirmationsDoc);
      const uiDoc = await tx.doc(UiCardsDoc);
      const now = Date.now();
      const visit = (record: PendingActionConfirmation | undefined) => {
        if (!record) return;
        if (confirmationPayloadTicketId(record.payload) !== ticketId) return;
        if (excluded.has(record.kind)) return;
        if (record.status === "denied" && record.executed && record.cardId) {
          const card = uiDoc.cards?.[record.cardId];
          if (card && (card.status === "ready" || card.status === "failed")) {
            openCardIds.add(record.cardId);
          }
          return;
        }
        if (record.status !== "pending" && record.status !== "pending_orchestrator") return;
        if (record.executed || effectiveConfirmationEffect(record) !== "none") return;
        record.status = "denied";
        record.resolvedAt = now;
        record.executed = true;
        record.effect = "confirmed";
        if (record.cardId) openCardIds.add(record.cardId);
        settledIds.add(record.id);
        writeRecord(doc, record as PendingActionConfirmation & JsonObject);
      };
      for (const record of Object.values(doc.byId ?? {})) visit(record);
      for (const record of Object.values(doc.byCardId ?? {})) visit(record);
    }, context);
    for (const cardId of openCardIds) {
      await this.#uiCards.settle(cardId, { status: "cancelled", resultSummary });
    }
    return settledIds.size;
  }

  async markExecuted(idOrCardId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.markOutcome(idOrCardId, "confirmed", undefined, context);
  }
}
