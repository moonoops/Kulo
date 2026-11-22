export type LiveContextSource = "usage" | "estimate";

export type CompactionDeclineReason = "unredacted_in_memory_secret";

export interface LiveContextState {
  /** Estimated active context tokens; omitted when not reliably measurable yet. */
  tokens?: number;
  source?: LiveContextSource;
  /** Active model context window size in tokens. */
  window: number;
  /** Soft background compaction trigger ceiling for the active model/session. */
  softLimit: number;
  /** Proactive warning threshold strictly below the blocking compaction threshold. */
  warnLimit: number;
  compacting?: boolean;
  /** Secret-free compaction failure or redaction-decline diagnostic text/code. */
  compactionError?: string;
}

export type TopicCompactResult =
  | { compacted: true; taskId: number }
  | { compacted: false; reason: "nothing_to_compact" };
