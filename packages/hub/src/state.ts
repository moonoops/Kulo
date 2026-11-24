import { ROOT_CONVERSATION_ID, UserEntry, defineDoc, defineEntry, type EntryRecord, type InputSubmissionDraft, type JsonObject } from "@earendil-works/pi-durable";
import path from "node:path";
import {
  compareTicketCards,
  externalClientDisplayName,
  isAutonomousCoordinatorPromptText,
  isInternalCoordinatorPromptText,
  parseDirectExternalClientRoleId,
  resolveRolePresetFromPool,
  type ExternalClientConnection,
  type RolePreset,
  type SlotSummary,
  type SubagentRecord,
  type TaskBoardRecord,
  type TicketCardView,
  type TicketRecord,
  type TicketStatus,
  type TicketSubagentSummary,
  type TopicSummary,
  type WorkerReportState,
} from "@kulo/protocol";
import { clampTicketCardReport } from "./report-overflow.js";

export type ProcessedCommandEntry = {
  ticketId: string;
  action: string;
  at: number;
};

export type TopicTitleJob = {
  status: "pending" | "done" | "failed" | "cancelled";
  fallbackTitle: string;
  userText: string;
  attachmentNames: string[];
  assistantText?: string;
  conversationId?: number;
  retryCount?: number;
  failure?: { code: "thinking_configuration" | "provider_error" | "invalid_response" | "generation_error"; message: string };
};

export type KuloDurableState = {
  nextTicketNumber: number;
  tickets: Record<string, TicketRecord>;
  commandIndex: Record<string, string>;
  processedCommands?: Record<string, ProcessedCommandEntry>;
  /** Pi retains request deduplication after the short command cache is retired. */
  chatRequestTargets?: Record<string, string>;
  /** A present key pauses automatic Router wakeups; reports wait here until the user resumes. */
  pausedChats?: Record<string, InputSubmissionDraft[]>;
  conversationToTicket: Record<string, string>;
  subagents?: Record<string, SubagentRecord>;
  conversationToSubagent?: Record<string, string>;
  nextBoardNumber?: number;
  boards?: Record<string, TaskBoardRecord>;
  topics?: Record<string, TopicSummary>;
  conversationToTopic?: Record<string, string>;
  topicTitles?: Record<string, TopicTitleJob>;
  fileDeliveryFailures?: Record<string, { runEpoch: number; errors: Record<string, string> }>;
  /** Frozen negotiated execution trust mode bound to each ticket's runEpoch. */
  ticketExecutionModes?: Record<string, { runEpoch: number; mode: import("@kulo/protocol").ExecutionTrustMode }>;
  workerArtifacts?: Record<string, import("@kulo/protocol").ChatAttachment[]>;
  /** Durable recovery slot for post-commit main conversation archive finalization. */
  pendingMainArchiveFinalize?: import("@kulo/protocol").MainArchiveFinalizeRecord;
  slots: {
    holders: string[];
    writeHolders?: string[];
  };
};

const MAX_PROCESSED_COMMANDS = 256;
export const KULO_STATE_VERSION = 3;

export function recordProcessedCommand(
  state: KuloDurableState,
  commandId: string | undefined,
  ticketId: string,
  action: string,
): void {
  const clean = commandId?.trim();
  if (!clean) return;
  if (!state.processedCommands) {
    state.processedCommands = {};
  }
  state.processedCommands[clean] = { ticketId, action, at: Date.now() };
  const keys = Object.keys(state.processedCommands);
  if (keys.length > MAX_PROCESSED_COMMANDS) {
    keys
      .sort(
        (a, b) =>
          (state.processedCommands![a]?.at ?? 0) -
          (state.processedCommands![b]?.at ?? 0),
      )
      .slice(0, keys.length - MAX_PROCESSED_COMMANDS)
      .forEach((k) => {
        delete state.processedCommands![k];
      });
  }
}

export const KuloStateDoc = defineDoc<KuloDurableState & JsonObject>({
  kind: "kulo.state",
  version: KULO_STATE_VERSION,
  scope: "session",
  initial: () =>
    ({
      nextTicketNumber: 1,
      tickets: {},
      commandIndex: {},
      processedCommands: {},
      conversationToTicket: {},
      subagents: {},
      conversationToSubagent: {},
      topics: {},
      conversationToTopic: {},
      slots: {
        holders: [],
      },
    }) as KuloDurableState & JsonObject,
  migrate: (value, fromVersion) => {
    if (fromVersion !== 1 && fromVersion !== 2) {
      throw new Error(`Unsupported Kulo state migration from version ${fromVersion}`);
    }
    const state = structuredClone(value) as KuloDurableState & JsonObject;
    if (fromVersion === 1) {
      ensureHolders(state);
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.status !== "blocked") continue;
        ticket.waiting ??= {
          reason: "user",
          since: ticket.updatedAt,
          detail: ticket.latestReport?.question ?? ticket.latestReport?.summary ?? "等待用户确认",
        };
        const unconfirmedChildren = Object.values(state.subagents ?? {}).some((child) =>
          child.ticketId === ticket.id && (child.state === "running" || child.state === undefined),
        );
        if (unconfirmedChildren) {
          ticket.status = "pausing";
          // A legacy summary may belong to an earlier run; only explicit child states prove quiescence.
          const holders = ensureHolders(state);
          if (!holders.includes(ticket.id)) holders.push(ticket.id);
        } else {
          ticket.status = "waiting";
          releaseSlot(state, ticket.id);
        }
      }
      ensureWriteHolders(state);
    }
    if (state.topics?.root) {
      state.conversationToTopic ??= {};
      state.conversationToTopic[String(state.topics.root.conversationId)] = "root";
    }
    return state;
  },
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export function resolveActiveRootConversationId(
  state: Readonly<KuloDurableState> | undefined,
): number {
  const root = state?.topics?.root;
  if (root && root.deletedAt === undefined && Number.isSafeInteger(root.conversationId) && root.conversationId > 0) {
    return root.conversationId;
  }
  return Number(ROOT_CONVERSATION_ID);
}

export function isActiveRootConversation(
  conversationId: unknown,
  state: Readonly<KuloDurableState> | undefined,
): boolean {
  const num = Number(conversationId);
  if (!Number.isSafeInteger(num) || num <= 0) return false;
  const root = state?.topics?.root;
  if (!root) return num === Number(ROOT_CONVERSATION_ID);
  return (
    root.deletedAt === undefined &&
    root.conversationId === num &&
    state?.conversationToTopic?.[String(num)] === "root"
  );
}

export function ensureDefaultRootTopic(
  state: KuloDurableState,
  agentName = "Kulo",
): TopicSummary {
  state.topics ??= {};
  state.conversationToTopic ??= {};
  const rootConvNum = Number(ROOT_CONVERSATION_ID);
  let root = state.topics.root;
  if (!root) {
    const now = Date.now();
    root = {
      id: "root",
      conversationId: rootConvNum,
      title: `与 ${agentName} 对话`,
      master: true,
      createdAt: now,
      updatedAt: now,
    };
    state.topics.root = root;
  }
  state.conversationToTopic[String(root.conversationId)] = "root";
  return root;
}

export function isOrchestratorConversation(
  conversationId: unknown,
  state: Readonly<KuloDurableState> | undefined,
): boolean {
  const key = String(conversationId);
  if (state?.conversationToTicket[key]) return false;
  if (state?.conversationToSubagent?.[key]) return false;
  if (state?.conversationToTopic?.[key]) return true;
  if (conversationId === ROOT_CONVERSATION_ID && !state?.topics?.root) return true;
  return false;
}

export interface TicketExecutionScope {
  ticket: TicketRecord;
  subagent?: SubagentRecord;
  isSubagent: boolean;
  role: string;
  readOnly: boolean;
}

export function resolveTicketExecutionScope(
  state: Readonly<KuloDurableState> | undefined,
  conversationId: unknown,
): TicketExecutionScope | undefined {
  if (!state) return undefined;
  const key = String(conversationId);
  const directTicketId = state.conversationToTicket[key];
  if (directTicketId) {
    const ticket = state.tickets[directTicketId];
    if (!ticket) return undefined;
    return {
      ticket,
      isSubagent: false,
      role: ticket.role,
      readOnly: Boolean(ticket.readOnly),
    };
  }
  const subagentId = state.conversationToSubagent?.[key];
  if (subagentId) {
    const subagent = state.subagents?.[subagentId];
    if (!subagent) return undefined;
    const ticket = state.tickets[subagent.ticketId];
    if (!ticket) return undefined;
    return {
      ticket,
      subagent,
      isSubagent: true,
      role: subagent.role,
      readOnly: Boolean(ticket.readOnly || subagent.readOnly),
    };
  }
  return undefined;
}

export type WorkerRelayEntryData = {
  ticketId: string;
  title: string;
  role: string;
  state: WorkerReportState;
  summary: string;
  deliverable: string | null;
  pendingAssets?: string[];
  question: string | null;
  sources?: import("@kulo/protocol").WebSource[];
  searchSuggestions?: string[];
};

export const WorkerRelayEntry = defineEntry<WorkerRelayEntryData>("kulo.worker_relay");

export type WorkerWatchdogEntryData = {
  ticketId: string;
  title: string;
  role: string;
  reason: "stalled" | "long_running";
  idleSec: number;
  runningSec: number;
  runEpoch: number;
};

export const WorkerWatchdogEntry = defineEntry<WorkerWatchdogEntryData>("kulo.worker_watchdog");

export type WorkerRecoveryEntryData = {
  ticketId: string;
  rootTicketId: string;
  startedAt: number;
  attempt: number;
  runEpoch: number;
};
export const WorkerRecoveryEntry = defineEntry<WorkerRecoveryEntryData>("kulo.worker_recovery");

export type MediaRelayJobSummary = {
  jobId: string;
  operationId: string;
  capabilityId: string;
  capabilityName?: string;
  modelId: string;
  kind: "image" | "video";
  status: "completed" | "failed" | "needs_user" | "needs_reconciliation";
  assetIds: string[];
  error?: string;
};

export type MediaRelayEntryData = {
  batchKey: string;
  jobs: MediaRelayJobSummary[];
  createdAt: number;
};

export const MediaRelayEntry = defineEntry<MediaRelayEntryData>("kulo.media_relay");

export type CoordinatorEventKind =
  | "host_action_request"
  | "host_action_result"
  | "connection_request"
  | "user_task_instruction";

export type CoordinatorEventEntryData = {
  eventKind: CoordinatorEventKind;
  requestId?: string;
  ticketId?: string;
  connectionId?: string;
  envId?: string;
  envName?: string;
  /** Clean user-authored text when `eventKind === "user_task_instruction"` (never includes internal envelope tags). */
  manualText?: string;
  createdAt: number;
};

export const CoordinatorEventEntry = defineEntry<CoordinatorEventEntryData>("kulo.coordinator_event");

export function isRecoveryInputBoundary(entry: EntryRecord): boolean {
  return WorkerRecoveryEntry.is(entry) || WorkerRelayEntry.is(entry) || WorkerWatchdogEntry.is(entry) ||
    MediaRelayEntry.is(entry) || CoordinatorEventEntry.is(entry) ||
    UserEntry.is(entry) || entry.kind === "kulo.user" || entry.kind === "kulo.voice.delegation";
}

export function isInternalCoordinatorInputEntry(entry: EntryRecord): boolean {
  return (
    WorkerRelayEntry.is(entry) ||
    WorkerRecoveryEntry.is(entry) ||
    WorkerWatchdogEntry.is(entry) ||
    MediaRelayEntry.is(entry) ||
    CoordinatorEventEntry.is(entry)
  );
}

/** True for autonomous system/background wakeups (excluding explicit user Task Detail instructions). */
export function isAutomaticSystemInputEntry(entry: EntryRecord): boolean {
  if (CoordinatorEventEntry.is(entry)) {
    return entry.data.eventKind !== "user_task_instruction";
  }
  return (
    WorkerRelayEntry.is(entry) ||
    WorkerRecoveryEntry.is(entry) ||
    WorkerWatchdogEntry.is(entry) ||
    MediaRelayEntry.is(entry)
  );
}

export function bareUserEntryText(entry: EntryRecord): string {
  if (!UserEntry.is(entry)) return "";
  const msg = entry.model?.[0];
  if (!msg || msg.role !== "user") return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .flatMap((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n");
  }
  return "";
}

/** Matches historical bare `pi.user` entries written before internal coordinator inputs carried `CoordinatorEventEntry`. */
export function isLegacyInternalUserEntry(entry: EntryRecord): boolean {
  return UserEntry.is(entry) && isInternalCoordinatorPromptText(bareUserEntryText(entry));
}

/** Matches historical autonomous bare `pi.user` entries (excluding `[KULO_USER_TASK_INSTRUCTION]`). */
export function isLegacyAutonomousUserEntry(entry: EntryRecord): boolean {
  return UserEntry.is(entry) && isAutonomousCoordinatorPromptText(bareUserEntryText(entry));
}

function ensureHolders(state: KuloDurableState): string[] {
  const rawSlots = state.slots as {
    holders?: string[];
    normalHolders?: string[];
    urgentHolders?: string[];
  };
  if (!Array.isArray(rawSlots.holders)) {
    const merged = [
      ...(Array.isArray(rawSlots.normalHolders) ? rawSlots.normalHolders : []),
      ...(Array.isArray(rawSlots.urgentHolders) ? rawSlots.urgentHolders : []),
    ];
    state.slots = { ...state.slots, holders: Array.from(new Set(merged)) };
  }
  return state.slots.holders;
}

export function isTicketUnfinished(ticket: Pick<TicketRecord, "status">): boolean {
  return ["queued", "running", "pausing", "waiting", "blocked"].includes(ticket.status);
}

export function getActiveStagedCwd(
  ticket: Pick<TicketRecord, "workspaceStaging" | "externalExecution">,
): string | undefined {
  if (
    ticket.workspaceStaging?.mode === "staged" &&
    !ticket.workspaceStaging.appliedAt &&
    !ticket.workspaceStaging.discardedAt &&
    ticket.workspaceStaging.stagedCwd
  ) {
    return ticket.workspaceStaging.stagedCwd;
  }
  if (
    ticket.externalExecution?.workspaceMode === "staged" &&
    !ticket.externalExecution.stagedAppliedAt &&
    ticket.externalExecution.stagedCwd
  ) {
    return ticket.externalExecution.stagedCwd;
  }
  return undefined;
}

export function getEffectiveWorkspaceDir(
  ticket: Pick<TicketRecord, "workspaceDir" | "workspaceStaging" | "externalExecution">,
): string {
  return getActiveStagedCwd(ticket) ?? ticket.workspaceDir;
}

export function hasPendingWorkspaceApply(
  ticket: Pick<TicketRecord, "status" | "workspaceStaging" | "externalExecution">,
): boolean {
  if (ticket.status === "stopped" || ticket.status === "closed") return false;
  const builtInPending = Boolean(
    ticket.workspaceStaging?.mode === "staged" &&
      !ticket.workspaceStaging.appliedAt &&
      !ticket.workspaceStaging.discardedAt &&
      ticket.workspaceStaging.stagedDiff?.hasChanges,
  );
  const externalPending = Boolean(
    ticket.externalExecution?.workspaceMode === "staged" &&
      !ticket.externalExecution.stagedAppliedAt &&
      ticket.externalExecution.stagedDiff?.hasChanges,
  );
  return builtInPending || externalPending;
}

/** Keep execution time independent of progress updates and time spent queued or parked. */
export function transitionTicketStatus(ticket: TicketRecord, status: TicketStatus, at: number): void {
  const previous = ticket.status;
  const wasExecuting = previous === "running" || previous === "pausing";
  const executing = status === "running" || status === "pausing";
  if (wasExecuting && !executing) {
    const startedAt = ticket.startedRunningAt;
    if (startedAt !== undefined || ticket.accumulatedRunningMs !== undefined) {
      ticket.accumulatedRunningMs = (ticket.accumulatedRunningMs ?? 0) +
        (startedAt === undefined ? 0 : Math.max(0, at - startedAt));
    }
    ticket.startedRunningAt = undefined;
  } else if (status === "running" && (!wasExecuting || ticket.startedRunningAt === undefined)) {
    ticket.accumulatedRunningMs ??= 0;
    ticket.startedRunningAt = at;
  }
  if (status === "queued" && previous !== "queued") ticket.queuedAt = at;
  if (status === "ready" && previous !== "ready") ticket.completedAt = at;
  else if (status !== "ready" && status !== "closed") ticket.completedAt = undefined;
  ticket.status = status;
  if (status !== previous) ticket.updatedAt = at;
}

export function hasActiveSubagents(state: Readonly<KuloDurableState>, ticketId: string): boolean {
  return Object.values(state.subagents ?? {}).some((subagent) =>
    subagent.ticketId === ticketId && (
      subagent.state === "running" ||
      // Older records without a result have not established that their execution stopped.
      (subagent.state === undefined && subagent.lastSummary === undefined)
    ),
  );
}

function normalizedWorkspace(value: string): { value: string; windows: boolean } {
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
  const implementation = windows ? path.win32 : path.posix;
  const normalized = implementation.normalize(value).replace(/[\\/]+$/, "") || implementation.parse(value).root;
  return { value: windows ? normalized.toLowerCase() : normalized, windows };
}

export function ticketsShareWriteScope(a: Readonly<TicketRecord>, b: Readonly<TicketRecord>): boolean {
  const aPhones = a.androidDeviceIds ?? (a.executionDomain === "android" ? [a.envId] : []);
  const bPhones = b.androidDeviceIds ?? (b.executionDomain === "android" ? [b.envId] : []);
  if (aPhones.some((id) => bPhones.includes(id))) return true;
  if (a.executionDomain === "android" || b.executionDomain === "android") return false;
  if (a.envId !== b.envId) return false;
  if (a.directoryId && b.directoryId && a.directoryId === b.directoryId) return true;
  const left = normalizedWorkspace(a.workspaceDir);
  const right = normalizedWorkspace(b.workspaceDir);
  if (left.windows !== right.windows) return false;
  const implementation = left.windows ? path.win32 : path.posix;
  const contains = (parent: string, child: string) => {
    const relative = implementation.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${implementation.sep}`) && relative !== ".." && !implementation.isAbsolute(relative));
  };
  return contains(left.value, right.value) || contains(right.value, left.value);
}

function isTicketWriteExempt(ticket: Readonly<TicketRecord>): boolean {
  return Boolean(
    ticket.readOnly ||
      (ticket.externalExecution && ticket.projectId && ticket.externalExecution.workspaceMode === "read_only"),
  );
}

/** True whenever a ticket holds an active or pending-cleanup/merge write lock over its workspace scope. */
export function isTicketHoldingWriteLock(ticket: Readonly<TicketRecord>): boolean {
  if (isTicketWriteExempt(ticket)) return false;
  return Boolean(
    ticket.status === "running" ||
    ticket.status === "pausing" ||
    ticket.cleanupPending ||
    hasPendingWorkspaceApply(ticket),
  );
}

function ensureWriteHolders(state: KuloDurableState): string[] {
  const holders = ensureHolders(state);
  state.slots.writeHolders ??= [];
  for (const id of holders) {
    if (state.tickets[id] && !isTicketWriteExempt(state.tickets[id]!) && !state.slots.writeHolders.includes(id)) {
      state.slots.writeHolders.push(id);
    }
  }
  for (const ticket of Object.values(state.tickets)) {
    if (
      (ticket.cleanupPending || hasPendingWorkspaceApply(ticket)) &&
      !isTicketWriteExempt(ticket) &&
      !state.slots.writeHolders.includes(ticket.id)
    ) {
      state.slots.writeHolders.push(ticket.id);
    }
  }
  state.slots.writeHolders = state.slots.writeHolders.filter((id) => Boolean(state.tickets[id]));
  return state.slots.writeHolders;
}

function canClaimWrite(state: KuloDurableState, ticket: Readonly<TicketRecord>): boolean {
  if (isTicketWriteExempt(ticket)) return true;
  return !ensureWriteHolders(state).some((id) =>
    id !== ticket.id && ticketsShareWriteScope(ticket, state.tickets[id]!),
  );
}

function isQueueCandidate(ticket: Readonly<TicketRecord>): boolean {
  return ticket.status === "queued" && !ticket.cleanupPending &&
    (!ticket.waiting || ticket.waiting.reason === "project");
}

function compareQueueOrder(a: Readonly<TicketRecord>, b: Readonly<TicketRecord>): number {
  return (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
    a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function tryClaimSlot(
  state: KuloDurableState,
  ticketId: string,
  maxConcurrentWorkers: number,
  options: { isRunnable?: (ticket: Readonly<TicketRecord>) => boolean } = {},
): boolean {
  const holders = ensureHolders(state);
  ensureWriteHolders(state);
  if (holders.includes(ticketId)) {
    return true;
  }
  if (holders.length >= maxConcurrentWorkers) {
    return false;
  }

  const self = state.tickets[ticketId];
  if (self) {
    if (!isQueueCandidate(self) || options.isRunnable?.(self) === false || !canClaimWrite(state, self)) {
      return false;
    }
    let olderQueued = 0;
    for (const t of Object.values(state.tickets)) {
      if (
        t.id !== ticketId &&
        isQueueCandidate(t) &&
        !holders.includes(t.id) &&
        compareQueueOrder(t, self) < 0 &&
        options.isRunnable?.(t) !== false &&
        canClaimWrite(state, t)
      ) {
        if (!isTicketWriteExempt(t) && !isTicketWriteExempt(self) && ticketsShareWriteScope(t, self)) return false;
        olderQueued++;
      }
    }
    if (holders.length + olderQueued >= maxConcurrentWorkers) {
      return false;
    }
  }

  holders.push(ticketId);
  if (self && !isTicketWriteExempt(self)) {
    const writeHolders = ensureWriteHolders(state);
    if (!writeHolders.includes(ticketId)) writeHolders.push(ticketId);
  }
  return true;
}

export function releaseProjectWrite(
  state: KuloDurableState,
  ticketId: string,
  options: { force?: boolean } = {},
): boolean {
  const ticket = state.tickets[ticketId];
  if (!options.force && (ticket?.cleanupPending || (ticket && hasPendingWorkspaceApply(ticket)))) return false;
  const holders = ensureWriteHolders(state);
  state.slots.writeHolders = holders.filter((id) => id !== ticketId);
  return true;
}

export function releaseSlot(
  state: KuloDurableState,
  ticketId: string,
  options: { force?: boolean; releaseWrite?: boolean } = {},
): boolean {
  if (!options.force && hasActiveSubagents(state, ticketId)) return false;
  ensureWriteHolders(state);
  const holders = ensureHolders(state);
  state.slots.holders = holders.filter((id) => id !== ticketId);
  if (options.releaseWrite !== false) releaseProjectWrite(state, ticketId);
  return true;
}

export function computeSlotSummary(
  state: Readonly<KuloDurableState>,
  maxConcurrentWorkers: number,
  queuedCount = Object.values(state.tickets).reduce((count, ticket) => count + Number(ticket.status === "queued"), 0),
): SlotSummary {
  const rawSlots = state.slots as {
    holders?: string[];
    normalHolders?: string[];
    urgentHolders?: string[];
  };
  const used = Array.isArray(rawSlots.holders)
    ? rawSlots.holders.length
    : Array.from(
        new Set([
          ...(Array.isArray(rawSlots.normalHolders) ? rawSlots.normalHolders : []),
          ...(Array.isArray(rawSlots.urgentHolders) ? rawSlots.urgentHolders : []),
        ]),
      ).length;

  return {
    used,
    max: maxConcurrentWorkers,
    queuedCount,
  };
}

export function toTicketCardView(
  ticket: Readonly<TicketRecord>,
  roles: Record<string, RolePreset>,
  externalClients?: Record<string, ExternalClientConnection>,
  subagentSummary?: TicketSubagentSummary,
): TicketCardView {
  const directClientId = parseDirectExternalClientRoleId(ticket.role);
  const directClient = directClientId ? externalClients?.[directClientId] : undefined;
  const directLabel = directClient
    ? externalClientDisplayName(directClient)
    : directClientId && ticket.externalExecution
      ? externalClientDisplayName({
          kind: ticket.externalExecution.binding.kind,
          agentRef: ticket.externalExecution.binding.agentRef,
        })
      : undefined;
  const roleLabel =
    roles[ticket.role]?.label ??
    directLabel ??
    resolveRolePresetFromPool(roles, ticket.role).preset?.label ??
    ticket.role;
  return {
    id: ticket.id,
    ...(ticket.externalExecution ? { externalAgentKind: ticket.externalExecution.binding.kind } : {}),
    ...(hasPendingWorkspaceApply(ticket) ? { pendingWorkspaceApply: true } : {}),
    ...(subagentSummary && subagentSummary.total > 0 ? { subagentSummary } : {}),
    ...(ticket.boardId ? { boardId: ticket.boardId } : {}),
    ...(ticket.reviewTicketId ? { reviewTicketId: ticket.reviewTicketId } : {}),
    title: ticket.title,
    ...(ticket.userSummary ? { userSummary: ticket.userSummary } : {}),
    role: ticket.role,
    roleLabel,
    status: ticket.status,
    envId: ticket.envId,
    ...(ticket.executionDomain ? { executionDomain: ticket.executionDomain } : {}),
    ...(ticket.androidDeviceIds?.length ? { androidDeviceIds: [...ticket.androidDeviceIds] } : {}),
    workspaceDir: ticket.workspaceDir,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...(ticket.startedRunningAt !== undefined ? { startedRunningAt: ticket.startedRunningAt } : {}),
    ...(ticket.accumulatedRunningMs !== undefined ? { accumulatedRunningMs: ticket.accumulatedRunningMs } : {}),
    ...(ticket.queuedAt !== undefined
      ? { queuedAt: ticket.queuedAt }
      : ticket.status === "queued" ? { queuedAt: ticket.createdAt } : {}),
    ...(ticket.completedAt !== undefined
      ? { completedAt: ticket.completedAt }
      : ticket.status === "ready" && ticket.latestReport?.state === "ready"
        ? { completedAt: ticket.latestReport.at }
        : {}),
    ...(ticket.latestReport ? { latestReport: clampTicketCardReport(ticket.latestReport) } : {}),
    ...(ticket.stoppedReason ? { stoppedReason: ticket.stoppedReason } : {}),
    ...(ticket.closure ? { closure: { ...ticket.closure } } : {}),
    ...(ticket.recovery ? { recovery: { ...ticket.recovery } } : {}),
    ...(ticket.originTopicId ? { originTopicId: ticket.originTopicId } : {}),
    ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
    ...(ticket.waiting ? { waiting: { ...ticket.waiting } } : {}),
    ...(ticket.cleanupPending ? { cleanupPending: true } : {}),
    ...(ticket.schedule ? { schedule: { ...ticket.schedule } } : {}),
  };
}

export function listSortedTicketCards(
  state: Readonly<KuloDurableState>,
  roles: Record<string, RolePreset>,
): TicketCardView[] {
  return Object.values(state.tickets)
    .map((t) => toTicketCardView(t, roles))
    .sort(compareTicketCards);
}

export function listSortedTopics(state: Readonly<KuloDurableState>): TopicSummary[] {
  const map = state.topics ?? {};
  return Object.values(map)
    .filter((topic) => topic.deletedAt === undefined)
    .map((t) => ({ ...t }))
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
    });
}

export function summarizeTopicPreview(
  messages: ReadonlyArray<{ role?: string; text?: string; createdAt?: number }>,
  maxLength = 140,
): { preview: string; at?: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || (item.role !== "assistant" && item.role !== "user")) continue;
    const cleaned = (item.text ?? "")
      .replace(/```[\s\S]*?```/g, " [code] ")
      .replace(/[#>*_`~]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    const preview = cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…` : cleaned;
    return {
      preview,
      ...(typeof item.createdAt === "number" && item.createdAt > 0 ? { at: item.createdAt } : {}),
    };
  }
  return undefined;
}

export function applyTopicPreview(
  topic: TopicSummary,
  latestPreview: { preview: string; at?: number } | undefined,
  fallbackAt: number,
): boolean {
  if (!latestPreview) return false;
  const previewAt = latestPreview.at ?? fallbackAt;
  if (topic.lastMessagePreview === latestPreview.preview && (topic.lastMessageAt ?? 0) >= previewAt) return false;
  topic.lastMessagePreview = latestPreview.preview;
  topic.lastMessageAt = Math.max(topic.lastMessageAt ?? 0, previewAt);
  return true;
}

function clearTicketStagedPointers(ticket: TicketRecord, now: number): void {
  if (ticket.workspaceStaging && !ticket.workspaceStaging.appliedAt) {
    ticket.workspaceStaging.discardedAt = now;
    delete ticket.workspaceStaging.stagedCwd;
    delete ticket.workspaceStaging.stagedDiff;
  }
  if (ticket.externalExecution && !ticket.externalExecution.stagedAppliedAt) {
    delete ticket.externalExecution.stagedCwd;
    delete ticket.externalExecution.stagedDiff;
  }
}

function cloneTicketRecord(ticket: TicketRecord): TicketRecord {
  return JSON.parse(JSON.stringify(ticket)) as TicketRecord;
}

export function discardPendingTopicStagedTickets(
  state: KuloDurableState,
  topicId: string,
  now: number,
): TicketRecord[] {
  const stagedToDiscard: TicketRecord[] = [];
  for (const ticket of Object.values(state.tickets)) {
    if ((ticket.originTopicId ?? "root") !== topicId) continue;
    if (!hasPendingWorkspaceApply(ticket)) continue;
    stagedToDiscard.push(cloneTicketRecord(ticket));
    clearTicketStagedPointers(ticket, now);
    releaseProjectWrite(state, ticket.id, { force: true });
    ticket.updatedAt = now;
  }
  return stagedToDiscard;
}

export function matchesTopicTicket(ticket: TicketRecord, topicId: string, conversationId?: number): boolean {
  return ticket.originTopicId === topicId || (conversationId !== undefined && ticket.originConversationId === conversationId);
}

export function findBlockingTopicTickets(
  state: Readonly<KuloDurableState>,
  topicId: string,
  conversationId?: number,
): TicketRecord[] {
  return Object.values(state.tickets).filter(
    (ticket) => matchesTopicTicket(ticket, topicId, conversationId) && (isTicketUnfinished(ticket) || hasPendingWorkspaceApply(ticket)),
  );
}

export function closeSettledTicketsForDeletedTopic(
  state: KuloDurableState,
  topicId: string,
  now: number,
  conversationId?: number,
): { closedCount: number; stagedToDiscard: TicketRecord[] } {
  let closedCount = 0;
  const stagedToDiscard: TicketRecord[] = [];
  for (const ticket of Object.values(state.tickets)) {
    if (!matchesTopicTicket(ticket, topicId, conversationId)) continue;
    if (
      ticket.status === "closed" ||
      isTicketUnfinished(ticket) ||
      ticket.cleanupPending ||
      hasPendingWorkspaceApply(ticket)
    ) {
      continue;
    }
    if (getActiveStagedCwd(ticket)) {
      stagedToDiscard.push(cloneTicketRecord(ticket));
      clearTicketStagedPointers(ticket, now);
    }
    transitionTicketStatus(ticket, "closed", now);
    ticket.waiting = undefined;
    ticket.activeTaskId = undefined;
    ticket.resumePrompt = undefined;
    ticket.resumeAttachmentIds = undefined;
    ticket.wakePending = undefined;
    if (ticket.schedule) ticket.schedule.nextRunAt = null;
    releaseProjectWrite(state, ticket.id);
    const prior = ticket.recovery;
    ticket.recovery = undefined;
    if (prior && (prior.rootTicketId ?? ticket.id) === ticket.id) {
      for (const related of Object.values(state.tickets)) {
        if (related.recovery?.rootTicketId === ticket.id && related.recovery.startedAt === prior.startedAt) {
          related.recovery = undefined;
          related.autoRecoverySuppressed = true;
        }
      }
    }
    ticket.closure = {
      kind: "obsolete",
      reason: "会话已删除",
      at: now,
    };
    ticket.updatedAt = now;
    closedCount += 1;
  }
  return { closedCount, stagedToDiscard };
}
