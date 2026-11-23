import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, JsonObject } from "@earendil-works/pi-durable";
import type {
  AssistantItemAction,
  AssistantItemView,
  AssistantPendingAction,
  ChatAttachment,
  MessagePart,
  TopicSummary,
} from "@kulo/protocol";
import {
  AssistantDoc,
  claimPendingActionInDoc,
  dismissAssistantItemInDoc,
  ensureAssistantState,
  finalizePendingActionInDoc,
  selectActiveAssistantItems,
  updatePendingActionFailureInDoc,
} from "./assistant-state.js";
import { ChatAttachmentGrantsDoc } from "./chat-attachment-deliveries.js";
import {
  assertDeliveryIntent,
  DeliveryReceiptDoc,
  writeDeliveryReceipt,
  type DeliveryAck,
  type DeliveryIntent,
} from "./delivery-receipts.js";
import { applyTopicPreview, ensureDefaultRootTopic, KuloStateDoc, listSortedTopics, summarizeTopicPreview } from "./state.js";
import { ContentPublicationEntry, type ContentPublicationData } from "./ui-cards.js";

export interface AssistantItemActionsHost {
  harness: Harness;
  agentName(): string;
  redact(text: string): string;
  createDetachedOrchestratorConversation(context: Context): Promise<{ id: ConversationId }>;
  onItemsChanged(revision: number, items: AssistantItemView[]): void;
  onTopicsChanged(topics: TopicSummary[]): void;
  onTopicContentChanged?(topicId: string): void;
  onMutedAppsChanged?(mutedApps: string[]): void;
  materializeSnapshot?(snapshotRef: string, conversationId: number): Promise<ChatAttachment | undefined>;
  executePendingAction?(
    action: AssistantPendingAction,
  ): Promise<{ ok: boolean; preDispatch?: boolean; error?: string }>;
}

/**
 * Executes a user right-rail card action with durable DeliveryReceiptDoc idempotency.
 * For `promote_to_topic`, atomically creates or reuses the linked proactive topic without cross-DB split-brain.
 * For `confirm_action`, executes the L2 `pendingAction` at most once per `commandId`.
 */
export async function executeAssistantItemAction(
  host: AssistantItemActionsHost,
  input: {
    itemId: string;
    expectedRevision: number;
    action: AssistantItemAction;
    intent?: DeliveryIntent;
    context?: Context;
  },
): Promise<{ ack: DeliveryAck & { itemId?: string }; deduplicated?: boolean }> {
  const context = input.context ?? BACKGROUND_CONTEXT;
  if (input.intent) {
    const prior = await host.harness.snapshot(DeliveryReceiptDoc, input.intent.key, context);
    if (prior && prior.phase === "complete") {
      assertDeliveryIntent(prior, input.intent);
      return { ack: prior.ack as DeliveryAck & { itemId?: string }, deduplicated: true };
    }
    if (prior && prior.phase === "admitted" && input.action === "confirm_action") {
      assertDeliveryIntent(prior, input.intent);
      throw Object.assign(
        new Error("该确认动作正在执行或结果未决，请先核对目标应用，避免重复操作。"),
        { code: "action_in_flight_or_unknown", status: 409 },
      );
    }
  }

  if (input.action === "confirm_action") {
    if (!host.executePendingAction) {
      throw Object.assign(new Error("当前中枢未注册待确认动作执行器。"), { code: "assistant_action_unavailable", status: 501 });
    }
    const claimed = await host.harness.commit(async (tx) => {
      if (input.intent) {
        const existingReceipt = await tx.doc(DeliveryReceiptDoc, input.intent.key, {
          fingerprint: input.intent.fingerprint,
          action: input.intent.action,
        });
        assertDeliveryIntent(existingReceipt, input.intent);
        if (existingReceipt.phase === "complete") {
          return { deduplicated: true as const, ack: existingReceipt.ack as DeliveryAck & { itemId?: string } };
        }
        if (existingReceipt.phase === "admitted") {
          throw Object.assign(
            new Error("该确认动作正在执行或结果未决，请先核对目标应用，避免重复操作。"),
            { code: "action_in_flight_or_unknown", status: 409 },
          );
        }
      }
      const doc = await tx.doc(AssistantDoc);
      const now = Date.now();
      const pendingAction = claimPendingActionInDoc(doc, input.itemId, input.expectedRevision, now);
      await writeDeliveryReceipt(tx, input.intent, { itemId: input.itemId, delivery: "accepted" }, "admitted");
      return {
        deduplicated: false as const,
        pendingAction,
        itemsChanged: { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, now) },
      };
    }, context);

    if (claimed.deduplicated) return { ack: claimed.ack, deduplicated: true };
    host.onItemsChanged(claimed.itemsChanged.revision, claimed.itemsChanged.items);

    let execResult: { ok: boolean; preDispatch?: boolean; error?: string };
    try {
      execResult = await host.executePendingAction(claimed.pendingAction);
    } catch (error) {
      execResult = {
        ok: false,
        preDispatch: false,
        error: error instanceof Error ? error.message : "执行确认动作异常",
      };
    }

    if (!execResult.ok) {
      const safeError = host.redact(execResult.error || "执行确认动作失败，请核对目标应用。").slice(0, 300);
      if (execResult.preDispatch === true) {
        const rolledBack = await host.harness.commit(async (tx) => {
          const doc = await tx.doc(AssistantDoc);
          const now = Date.now();
          updatePendingActionFailureInDoc(doc, input.itemId, "none", safeError, now);
          await writeDeliveryReceipt(tx, input.intent, {}, "empty");
          return { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, now) };
        }, context);
        host.onItemsChanged(rolledBack.revision, rolledBack.items);
        throw Object.assign(new Error(safeError), { code: "assistant_action_failed", status: 502 });
      }

      const unknownUpdated = await host.harness.commit(async (tx) => {
        const doc = await tx.doc(AssistantDoc);
        const now = Date.now();
        updatePendingActionFailureInDoc(doc, input.itemId, "unknown", safeError, now);
        await writeDeliveryReceipt(tx, input.intent, { itemId: input.itemId, delivery: "accepted" }, "complete", { outcome: "unknown" });
        return { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, now) };
      }, context);
      host.onItemsChanged(unknownUpdated.revision, unknownUpdated.items);
      throw Object.assign(
        new Error(`操作已发出但未确认结果：${safeError}。请先在目标应用核对后再收起，切勿盲目重试。`),
        { code: "assistant_action_unknown", status: 502 },
      );
    }

    const finalized = await host.harness.commit(async (tx) => {
      const doc = await tx.doc(AssistantDoc);
      const now = Date.now();
      finalizePendingActionInDoc(doc, input.itemId, now);
      const ack: DeliveryAck & { itemId?: string } = { itemId: input.itemId, delivery: "accepted" };
      await writeDeliveryReceipt(tx, input.intent, ack, "complete");
      return {
        ack,
        itemsChanged: { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, now) },
      };
    }, context);

    host.onItemsChanged(finalized.itemsChanged.revision, finalized.itemsChanged.items);
    return { ack: finalized.ack };
  }

  let preCreatedConv: { id: ConversationId } | undefined;
  let promotedSnapshotAsset: ChatAttachment | undefined;
  if (input.action === "promote_to_topic") {
    const [snap, stateSnap] = await Promise.all([
      host.harness.snapshot(AssistantDoc, context),
      host.harness.snapshot(KuloStateDoc, context),
    ]);
    const item = snap?.items?.find((candidate) => candidate.id === input.itemId);
    const sit = item ? snap?.situations?.[item.situationId] : undefined;
    const linked = item?.linkedTopicId ?? sit?.linkedTopicId;
    const linkedTopic = linked ? stateSnap?.topics?.[linked] : undefined;
    if (item && (!linkedTopic || linkedTopic.deletedAt)) {
      preCreatedConv = await host.createDetachedOrchestratorConversation(context);
      if (sit?.snapshotRef) {
        promotedSnapshotAsset = await host.materializeSnapshot?.(sit.snapshotRef, preCreatedConv.id as number).catch(() => undefined);
      }
    }
  }

  const outcome = await host.harness.commit(async (tx) => {
    if (input.intent) {
      const existingReceipt = await tx.doc(DeliveryReceiptDoc, input.intent.key, {
        fingerprint: input.intent.fingerprint,
        action: input.intent.action,
      });
      assertDeliveryIntent(existingReceipt, input.intent);
      if (existingReceipt.phase === "complete") {
        return {
          ack: existingReceipt.ack as DeliveryAck & { itemId?: string },
          deduplicated: true,
        };
      }
    }

    const doc = await tx.doc(AssistantDoc);
    const state = await tx.doc(KuloStateDoc);
    ensureAssistantState(doc);
    ensureDefaultRootTopic(state, host.agentName());
    const now = Date.now();

    if (input.action === "acknowledge" || input.action === "mute_app") {
      const dismissed = dismissAssistantItemInDoc(doc, input.itemId, input.expectedRevision, {
        muteApp: input.action === "mute_app",
        now,
      });
      if ("conflict" in dismissed) {
        throw Object.assign(new Error("提醒卡片已更新，请刷新后重试。"), { code: "assistant_item_conflict", status: 409 });
      }
      const ack: DeliveryAck & { itemId?: string } = { itemId: input.itemId, delivery: "accepted" };
      await writeDeliveryReceipt(tx, input.intent, ack, "complete");
      return {
        ack,
        itemsChanged: { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, now) },
        mutedApps: "mutedApp" in dismissed && dismissed.mutedApp ? [...doc.mutedApps] : undefined,
      };
    }

    const idx = doc.items.findIndex((item) => item.id === input.itemId);
    if (idx < 0) {
      throw Object.assign(new Error("提醒事项已不存在或已处理。"), { code: "assistant_item_not_found", status: 404 });
    }
    const item = doc.items[idx]!;
    if (item.revision !== input.expectedRevision) {
      throw Object.assign(new Error("提醒卡片已更新，请刷新后重试。"), { code: "assistant_item_conflict", status: 409 });
    }

    const sit = doc.situations[item.situationId];
    let topicId = item.linkedTopicId ?? sit?.linkedTopicId;
    let topicsChanged: TopicSummary[] | undefined;

    if (!topicId || !state.topics?.[topicId] || state.topics[topicId]!.deletedAt) {
      if (!preCreatedConv) {
        throw Object.assign(new Error("未能初始化议题会话，请重试。"), { code: "topic_init_required", status: 409 });
      }
      topicId = `topic-${preCreatedConv.id as number}`;
      const convId = preCreatedConv.id as number;
      const record: TopicSummary = {
        id: topicId,
        conversationId: convId,
        title: item.title,
        origin: "proactive",
        situationId: item.situationId,
        proactiveSeq: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.topics![topicId] = record;
      state.conversationToTopic![String(convId)] = topicId;
      const intro = `**${item.title}**（来源：${item.sourceLabel}${item.envName ? ` · ${item.envName}` : ""}）\n\n${item.summary}`;
      const parts: MessagePart[] = [{ partId: `promote:${item.id}:${now}`, type: "markdown", text: intro }];
      if (promotedSnapshotAsset) {
        const grants = await tx.doc(ChatAttachmentGrantsDoc);
        const scope = `conversation:${convId}`;
        const scopes = grants.byAsset[promotedSnapshotAsset.id] ?? [];
        if (!scopes.includes(scope)) grants.byAsset[promotedSnapshotAsset.id] = [...scopes, scope];
        parts.push({
          partId: `promote-img:${item.id}:${now}`,
          type: "image",
          assetId: promotedSnapshotAsset.id,
          asset: JSON.parse(JSON.stringify(promotedSnapshotAsset)) as ChatAttachment,
        });
      }
      await tx.appendEntry(ContentPublicationEntry, convId as ConversationId, {
        data: {
          parts,
          fallbackText: intro,
          createdAt: now,
        } as unknown as ContentPublicationData & JsonObject,
      });
      applyTopicPreview(record, summarizeTopicPreview([{ role: "assistant", text: intro, createdAt: now }]), now);
      topicsChanged = listSortedTopics(state);
    }

    if (sit) {
      sit.linkedTopicId = topicId;
      sit.updatedAt = now;
    }
    doc.items.splice(idx, 1);
    doc.assistantRevision += 1;

    const ack: DeliveryAck & { itemId?: string } = { itemId: item.id, topicId, delivery: "accepted" };
    await writeDeliveryReceipt(tx, input.intent, ack, "complete");
    return {
      ack,
      promotedTopicId: topicId,
      itemsChanged: { revision: doc.assistantRevision, items: selectActiveAssistantItems(doc.items, now) },
      topicsChanged,
    };
  }, context);

  if (outcome.topicsChanged) host.onTopicsChanged(outcome.topicsChanged);
  if (outcome.promotedTopicId) host.onTopicContentChanged?.(outcome.promotedTopicId);
  if (outcome.itemsChanged) host.onItemsChanged(outcome.itemsChanged.revision, outcome.itemsChanged.items);
  if (outcome.mutedApps) host.onMutedAppsChanged?.(outcome.mutedApps);
  return { ack: outcome.ack, ...(outcome.deduplicated ? { deduplicated: true } : {}) };
}
