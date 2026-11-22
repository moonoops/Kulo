export interface SubagentRecord {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
  ticketId: string;
  parentConversationId: number;
  conversationId: number;
  readOnly: boolean;
  runs: number;
  createdAt: number;
  updatedAt: number;
  lastSummary?: string;
  narrowedScope?: string;
  state?: "queued" | "running" | "waiting" | "ready" | "failed" | "stopped";
  invocationId?: string;
}

export interface OverflowReportAsset {
  id: string;
  name: string;
  size: number;
  totalChars: number;
}

export interface SubagentCardView {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
  readOnly: boolean;
  runs: number;
  state: NonNullable<SubagentRecord["state"]>;
  lastSummary?: string;
  updatedAt: number;
}

export interface TicketSubagentSummary {
  /** Only counts `state === "running"` while parent ticket is `running` or `pausing`. */
  running: number;
  total: number;
  /** Deterministic change counter/timestamp hash so `queued -> running` and summary updates emit deltas. */
  revision: number;
}

export type TaskBoardStatus = "active" | "archived";

export type TaskBoardEntryKind =
  | "verified"
  | "decision"
  | "constraint"
  | "handoff"
  | "correction";

export interface TaskBoardEntry {
  seq: number;
  kind: TaskBoardEntryKind;
  /** Coordinator-verified concise statement (<= 320 chars, redacted). */
  note: string;
  ticketId?: string;
  role?: string;
  /** Live project paths only when the referenced ticket's staged changes are already applied. */
  mergedPaths?: string[];
  /** Unmerged staged paths when the referenced ticket still awaits apply/review. */
  stagedPaths?: string[];
  artifactRefs?: string[];
  supersededBySeq?: number;
  at: number;
}

export interface TaskBoardRecord {
  id: string;
  title: string;
  goal: string;
  status: TaskBoardStatus;
  /** One-way project lock: once set, only tickets in the same project may attach. */
  projectId?: string;
  originTopicId: string;
  originConversationId: number;
  keywords: string[];
  ticketIds: string[];
  entries: TaskBoardEntry[];
  nextEntrySeq: number;
  createdAt: number;
  updatedAt: number;
  /** Updated only on substantive entry/status changes for cache-stable recent-work sorting. */
  lastEntryAt: number;
  archivedAt?: number;
}

export interface TaskBoardSearchMatch {
  id: string;
  title: string;
  goal: string;
  status: TaskBoardStatus;
  projectId?: string;
  ticketCount: number;
  latestNote?: string;
  lastEntryAt: number;
}
