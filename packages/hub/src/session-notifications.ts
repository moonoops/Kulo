import { randomUUID } from "node:crypto";
import {
  describeKuloError,
  getMessageParts,
  type ChatDisplayItem,
  type LiveStreamState,
  type MainSessionNotificationEvent,
  type UiCardSnapshot,
} from "@kulo/protocol";

export interface TopicNotificationBaseline {
  lastVisibleAssistantId: number;
  lastFailureKey: string | null;
  pendingCardIds: Set<string>;
}

function sanitizeSummary(raw: string | undefined, redact?: (text: string) => string, maxLength = 160): string | undefined {
  if (!raw) return undefined;
  const source = redact ? redact(raw) : raw;
  const cleaned = source.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

export function isUserFacingAssistantMessage(item: ChatDisplayItem): boolean {
  if (item.role !== "assistant") return false;
  if (item.text.trim().length > 0) return true;
  if (item.attachments?.length) return true;
  return getMessageParts(item).some((part) => {
    if (part.type === "markdown") return part.text.trim().length > 0;
    if (part.type === "code") return part.code.trim().length > 0;
    return true;
  });
}

function collectPendingUiCards(messages: readonly ChatDisplayItem[]): UiCardSnapshot[] {
  const pending: UiCardSnapshot[] = [];
  for (const item of messages) {
    if (item.role !== "assistant") continue;
    for (const part of getMessageParts(item)) {
      if (part.type === "ui" && part.card?.status === "ready" && part.card.actions.length > 0) {
        pending.push(part.card);
      }
    }
  }
  return pending;
}

function resolveFailureKey(live: LiveStreamState): string | null {
  if (!live.runFailure) return null;
  const described = describeKuloError({
    reason: live.runFailure.reason,
    detail: live.runFailure.detail,
  });
  if (described.isUserAbort) return null;
  return `${live.runFailure.taskId ?? "none"}:${live.runFailure.reason}:${(live.runFailure.detail ?? "").slice(0, 120)}`;
}

function isPureDispatchTurn(messages: readonly ChatDisplayItem[], newVisibleItems: readonly ChatDisplayItem[]): boolean {
  if (!newVisibleItems.length) return false;
  const dispatchResponseIds = new Set<number>();
  for (const item of messages) {
    if (item.role === "dispatch" && item.responseId !== undefined) {
      dispatchResponseIds.add(item.responseId);
    }
  }
  if (!dispatchResponseIds.size) return false;
  return newVisibleItems.every((item) => item.responseId !== undefined && dispatchResponseIds.has(item.responseId));
}

export function createTopicNotificationBaseline(
  messages: readonly ChatDisplayItem[],
  live: LiveStreamState,
): TopicNotificationBaseline {
  let lastVisibleAssistantId = 0;
  for (const item of messages) {
    if (isUserFacingAssistantMessage(item) && item.id > lastVisibleAssistantId) {
      lastVisibleAssistantId = item.id;
    }
  }
  return {
    lastVisibleAssistantId,
    lastFailureKey: resolveFailureKey(live),
    pendingCardIds: new Set(collectPendingUiCards(messages).map((card) => card.cardId)),
  };
}

export function detectMainSessionNotification(input: {
  topicId: string;
  topicTitle?: string;
  previous: TopicNotificationBaseline;
  messages: readonly ChatDisplayItem[];
  live: LiveStreamState;
  now?: number;
  createId?: () => string;
  redact?: (text: string) => string;
}): { next: TopicNotificationBaseline; event: MainSessionNotificationEvent | null } {
  const { topicId, topicTitle, previous, messages, live, redact } = input;
  if (live.busy) {
    return { next: previous, event: null };
  }

  const visibleItems = messages.filter(isUserFacingAssistantMessage);
  let maxVisibleAssistantId = previous.lastVisibleAssistantId;
  const newVisibleItems: ChatDisplayItem[] = [];
  for (const item of visibleItems) {
    if (item.id > previous.lastVisibleAssistantId) {
      newVisibleItems.push(item);
      if (item.id > maxVisibleAssistantId) maxVisibleAssistantId = item.id;
    }
  }

  const pendingCards = collectPendingUiCards(messages);
  const newPendingCards = pendingCards.filter((card) => !previous.pendingCardIds.has(card.cardId));
  const nextPendingCardIds = new Set(pendingCards.map((card) => card.cardId));
  const nextFailureKey = resolveFailureKey(live);
  const hasNewFailure = nextFailureKey !== null && nextFailureKey !== previous.lastFailureKey;

  const next: TopicNotificationBaseline = {
    lastVisibleAssistantId: maxVisibleAssistantId,
    lastFailureKey: nextFailureKey,
    pendingCardIds: nextPendingCardIds,
  };

  const cleanTopicTitle = sanitizeSummary(topicTitle, redact, 120);
  const createdAt = input.now ?? Date.now();
  const createId = input.createId ?? (() => randomUUID());

  if (newPendingCards.length > 0) {
    const latestCard = newPendingCards[newPendingCards.length - 1]!;
    const cardSummary = sanitizeSummary(latestCard.title, redact, 160);
    return {
      next,
      event: {
        id: createId(),
        kind: "attention_required",
        topicId,
        ...(cleanTopicTitle ? { topicTitle: cleanTopicTitle } : {}),
        ...(cardSummary ? { summary: cardSummary } : {}),
        createdAt,
      },
    };
  }

  if (hasNewFailure) {
    return {
      next,
      event: {
        id: createId(),
        kind: "run_failed",
        topicId,
        ...(cleanTopicTitle ? { topicTitle: cleanTopicTitle } : {}),
        createdAt,
      },
    };
  }

  if (newVisibleItems.length > 0 && !isPureDispatchTurn(messages, newVisibleItems)) {
    return {
      next,
      event: {
        id: createId(),
        kind: "reply_completed",
        topicId,
        ...(cleanTopicTitle ? { topicTitle: cleanTopicTitle } : {}),
        createdAt,
      },
    };
  }

  return { next, event: null };
}
