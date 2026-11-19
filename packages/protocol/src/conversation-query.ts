import type { ChatAttachment, ChatDisplayItem } from "./domain.js";

export interface ConversationSearchInput {
  query: string;
  topicId?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationSearchMatch {
  kind: "topic" | "message";
  topicId: string;
  topicTitle: string;
  archived?: boolean;
  projectId?: string;
  messageId?: number;
  role?: "user" | "assistant" | "dispatch";
  createdAt?: number;
  excerpt: string;
}

export interface ConversationSearchPage {
  items: ConversationSearchMatch[];
  nextCursor?: string;
}

export interface ConversationMessageWindow {
  topicId: string;
  messageId: number;
  messages: ChatDisplayItem[];
  beforeEntryId?: number;
  hasMore: boolean;
}

export interface ConversationFile {
  asset: ChatAttachment;
  messageId: number;
  role: "user" | "assistant" | "dispatch";
  createdAt?: number;
}

export interface ConversationFilesPage {
  items: ConversationFile[];
  total: number;
  nextCursor?: string;
}
