export type BuiltinMemoryScopeKind = "global" | "project" | "topic";

export type BuiltinMemorySource = "flush" | "tool" | "worklog" | "external_report";

export type BuiltinMemoryEvidenceLevel =
  | "user_decision"
  | "assistant_proposal"
  | "external_reference"
  | "ticket_outcome";

export type BuiltinMemoryCategory = "commitment" | "decision" | "fact" | "worklog";

export type BuiltinMemoryStatus = "active" | "resolved" | "superseded";

export type BuiltinMemoryDurability = "permanent" | "temporary";

export type ActiveMemoryMode = "none" | "builtin" | "hindsight";

export type ExternalMemoryMode = "hindsight" | "builtin";

export interface BuiltinMemoryStateView {
  enabled: boolean;
  revision: number;
  clearTargetEpoch: number;
  appliedClearEpoch: number;
  engineEpoch: number;
  clearedAt: number | null;
  supersededByHindsight: boolean;
  /** True when the local SQLite database is currently blocked awaiting clear completion or startup scrub. */
  blocked?: boolean;
  /** When warm-standby cluster sync is active, indicates whether the standby has confirmed this clear epoch. */
  replicaClearConfirmed?: boolean;
}

export interface BuiltinMemoryEnabledRequest {
  enabled: boolean;
  expectedRevision: number;
}

export interface BuiltinMemoryClearRequest {
  confirm: true;
  expectedEpoch: number;
  operationId: string;
}

export interface BuiltinMemoryClusterMeta {
  clearTargetEpoch: number;
  appliedClearEpoch: number;
  lastAppliedSeq: number;
}
