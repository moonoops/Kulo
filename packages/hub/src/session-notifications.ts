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

const MAX_NOTIFICATION_DISPLAY_WIDTH = 64;

function truncateDisplayWidth(text: string, maxUnits = MAX_NOTIFICATION_DISPLAY_WIDTH): string {
  let units = 0;
  let result = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const width = code >= 0x1100 && (
      (code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000
    ) ? 2 : 1;
    if (units + width > maxUnits) {
      return `${result.trimEnd()}…`;
    }
    result += ch;
    units += width;
  }
  return result;
}

function sanitizeSummary(raw: string | undefined, redact?: (text: string) => string, maxUnits = MAX_NOTIFICATION_DISPLAY_WIDTH): string | undefined {
  if (!raw) return undefined;
  const source = redact ? redact(raw) : raw;
  const cleaned = source.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return truncateDisplayWidth(cleaned, maxUnits);
}

function stripMarkdownLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|>\s+|(?:[-*•·+]|\d+[.)、])\s+)+/, "")
    .replace(/(\*\*|__|~~|\*)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractConciseReplyText(raw: string, redact?: (text: string) => string): string | undefined {
  const redacted = redact ? redact(raw) : raw;
  const withoutCodeFences = redacted.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "\n");
  const lines = withoutCodeFences
    .split(/\r?\n/)
    .map(stripMarkdownLine)
    .filter((line) => line.length > 0 && !/^[-_=|:：—·\s]+$/.test(line));
  if (!lines.length) return undefined;

  let chosen = "";
  for (const line of lines) {
    const trimmedFiller = line.replace(
      /^(?:(?:好的|好哒|明白|收到|嗯|行|没问题|ok|okay|sure|got it|alright)[，,。！!：:\s]*)+/i,
      "",
    ).trim();
    if (trimmedFiller) {
      chosen = trimmedFiller;
      break;
    }
  }
  if (!chosen) chosen = lines[0]!;

  // Prefer the first self-contained sentence; append the next short clause if the first is too brief.
  const sentences = chosen
    .split(/(?<=[。！？!?])(?:\s+|$)|(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  let headline = sentences[0] ?? chosen;
  if (headline.length < 6 && sentences[1]) {
    headline = `${headline} ${sentences[1]}`.trim();
  }
  headline = headline.replace(/[：:]\s*$/, "").trim();
  if (!headline) return undefined;
  return sanitizeSummary(headline, undefined, MAX_NOTIFICATION_DISPLAY_WIDTH);
}

function extractReplySummary(
  newVisibleItems: readonly ChatDisplayItem[],
  allMessages: readonly ChatDisplayItem[],
  redact?: (text: string) => string,
): string | undefined {
  for (let index = newVisibleItems.length - 1; index >= 0; index -= 1) {
    const item = newVisibleItems[index]!;
    const partTexts = getMessageParts(item)
      .filter((part): part is Extract<typeof part, { type: "markdown" }> => part.type === "markdown")
      .map((part) => part.text)
      .filter((text) => text.trim().length > 0);
    const rawText = item.text.trim() || partTexts.join("\n");
    if (rawText) {
      const summary = extractConciseReplyText(rawText, redact);
      if (summary) return summary;
    }
    if (item.attachments?.length) {
      const firstName = sanitizeSummary(item.attachments[0]!.name, redact, 40);
      if (firstName) {
        return item.attachments.length === 1
          ? `已发送 ${firstName}`
          : `已发送 ${firstName} 等 ${item.attachments.length} 个文件`;
      }
    }
  }
  // Fallback to the latest dispatched ticket title in the conversation if the reply was code-only.
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const entry = allMessages[index]!;
    if (entry.role === "dispatch" && entry.dispatch?.title) {
      const title = sanitizeSummary(entry.dispatch.title, redact, 48);
      if (title) return `已完成：${title}`;
    }
  }
  return undefined;
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
  deferReplyNotification?: boolean;
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
    const cardSummary = sanitizeSummary(latestCard.title, redact, MAX_NOTIFICATION_DISPLAY_WIDTH);
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
    const described = live.runFailure
      ? describeKuloError({ reason: live.runFailure.reason, detail: live.runFailure.detail })
      : undefined;
    const failureSummary = sanitizeSummary(described?.title, redact, MAX_NOTIFICATION_DISPLAY_WIDTH);
    return {
      next,
      event: {
        id: createId(),
        kind: "run_failed",
        topicId,
        ...(cleanTopicTitle ? { topicTitle: cleanTopicTitle } : {}),
        ...(failureSummary ? { summary: failureSummary } : {}),
        createdAt,
      },
    };
  }

  if (newVisibleItems.length > 0 && !isPureDispatchTurn(messages, newVisibleItems)) {
    if (input.deferReplyNotification) {
      return { next: { ...next, lastVisibleAssistantId: previous.lastVisibleAssistantId }, event: null };
    }
    const replySummary = extractReplySummary(newVisibleItems, messages, redact);
    return {
      next,
      event: {
        id: createId(),
        kind: "reply_completed",
        topicId,
        ...(cleanTopicTitle ? { topicTitle: cleanTopicTitle } : {}),
        ...(replySummary ? { summary: replySummary } : {}),
        createdAt,
      },
    };
  }

  return { next, event: null };
}
