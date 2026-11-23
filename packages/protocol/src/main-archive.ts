import type { TopicSummary } from "./domain.js";

export type MainArchiveFlushStatus =
  | "scheduled"
  | "merged_pending"
  | "already_up_to_date"
  | "skipped";

export interface MainArchiveFinalizeSteps {
  reconfiguredOld: boolean;
  watchedNew: boolean;
  rehomedWorkingMemory: boolean;
  dispatchedFlush: boolean;
  reboundBuiltinMemory: boolean;
}

export interface MainArchiveFinalizeRecord {
  oldConvId: number;
  newConvId: number;
  archivedTopicId: string;
  tailEntryId: number;
  createdAt: number;
  steps: MainArchiveFinalizeSteps;
}

export interface ArchiveMainConversationInput {
  /** Required CAS token matching the root conversationId visible to the user when confirming. */
  expectedConversationId: number;
}

export type ArchiveMainConversationResult =
  | {
      archived: true;
      archivedTopic: TopicSummary;
      rootConversationId: number;
      memoryFlush: MainArchiveFlushStatus;
      longTermMemoryActive: boolean;
      /** True when the atomic switch committed but a background finalize step is pending recovery. */
      finalizePending?: boolean;
    }
  | {
      archived: false;
      reason: "empty_conversation";
      rootConversationId: number;
    };
