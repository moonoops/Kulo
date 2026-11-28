import type { ChatDisplayItem, LiveStreamState } from "./domain.js";

/** Maximum user follow-up turns permitted in a single Phase 1 side question. */
export const SIDE_QUESTION_MAX_USER_TURNS = 12;

/** Retention window before an inactive side question is retired from active index (24 hours). */
export const SIDE_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

export const SIDE_QUESTION_TITLE_MAX_CHARS = 120;
export const SIDE_QUESTION_QUOTE_MAX_CHARS = 1_200;
export const SIDE_QUESTION_QUESTION_MAX_CHARS = 8_000;

export type SideQuestionStatus = "active" | "closed" | "interrupted" | "expired";

/**
 * Durable index record stored inside `SideQuestionsDoc` (`kulo.side_questions`).
 * Every free-text field MUST be double-redacted before persistence (§2.2) and
 * no field name may match `SECRET_FIELD`.
 */
export interface SideQuestionRecord {
  id: string;
  parentTopicId: string;
  parentConversationId: number;
  conversationId: number;
  /** Inclusive parent entry ID at which this side question forked; absent when parent had no complete entry. */
  forkedAtEntryId?: number;
  title: string;
  quoteSnippet?: string;
  sourceMessageId?: number;
  status: SideQuestionStatus;
  userTurnCount: number;
  maxUserTurns: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  closedAt?: number;
  closedReason?: string;
}

export interface SideQuestionView {
  record: SideQuestionRecord;
  messages: ChatDisplayItem[];
  live: LiveStreamState;
  remainingTurns: number;
  limitReached: boolean;
}

export interface SideQuestionCreateRequest {
  question?: string;
  quoteSnippet?: string;
  sourceMessageId?: number;
  title?: string;
  expectedParentConversationId?: number;
  requestId?: string;
}

export interface SideQuestionMessageRequest {
  question: string;
  requestId?: string;
}

export interface SideQuestionActiveResponse {
  sideQuestion: SideQuestionView | null;
}

export interface SideQuestionCreateResponse {
  sideQuestion: SideQuestionView;
}

export interface SideQuestionMessageResponse {
  sideQuestion: SideQuestionView;
}

export interface SideQuestionCloseResponse {
  closed: boolean;
  id: string;
  status: SideQuestionStatus;
}

const BTW_COMMAND_RE = /^\/btw(?:[ \t\r\n\u3000]+([\s\S]*))?$/i;

/**
 * Detects whether a main-composer submission starts with `/btw ` (or bare `/btw`)
 * so it can be intercepted and routed to the ephemeral side-question drawer.
 */
export function parseBtwCommand(raw: string): { matched: true; question: string } | { matched: false } {
  const trimmedStart = raw.trimStart();
  const match = BTW_COMMAND_RE.exec(trimmedStart);
  if (!match) return { matched: false };
  return { matched: true, question: (match[1] ?? "").trim() };
}

/**
 * Formats a side-question assistant answer into a quoted draft for the main composer.
 * Preserves any existing draft text and NEVER triggers sending.
 */
export function formatSideQuestionInsertDraft(answerText: string, existingDraft?: string): string {
  const clean = answerText.trim();
  if (!clean) return existingDraft ?? "";
  const quoted = clean
    .split(/\r?\n/)
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
  const existing = existingDraft?.trimEnd() ?? "";
  return existing ? `${existing}\n\n${quoted}\n\n` : `${quoted}\n\n`;
}
