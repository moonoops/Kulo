export const AGENT_TASK_KINDS = ["coding", "debugging", "review", "architecture", "design", "research", "writing"] as const;
export type AgentTaskKind = typeof AGENT_TASK_KINDS[number];

/** Empty defaultFor means that this Agent is used only when the user names it. */
export interface AgentDispatchPolicy {
  defaultFor: AgentTaskKind[];
  /** Omit to cover all projects on the Agent's bound device and unbound tasks. */
  projectIds?: string[];
}

export interface AgentRoutingTarget {
  name: string;
  agentId?: string;
  kind?: import("./external-agents.js").ExternalAgentKind;
  envId?: string;
}

/** Captured from the actual user input; tool-generated task text cannot replace it. */
export interface AgentDispatchIntent {
  version: 1;
  targets: AgentRoutingTarget[];
}

export interface AgentAssignment {
  agentId: string;
  source: "explicit" | "default" | "orchestrator" | "manual";
  taskKind?: AgentTaskKind;
  requestedName?: string;
  sourceEntryId?: number;
}
