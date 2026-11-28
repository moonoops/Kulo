import {
  compareTicketCards,
  externalClientDisplayName,
  parseDirectExternalClientRoleId,
  resolveRolePresetFromPool,
  type ExternalClientConnection,
  type RolePreset,
  type TicketCardView,
  type TicketRecord,
  type TicketSubagentSummary,
} from "@kulo/protocol";
import { clampTicketCardReport } from "./report-overflow.js";

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
    ...(ticket.supersedes?.length ? { supersedes: [...ticket.supersedes] } : {}),
    ...(ticket.originTopicId ? { originTopicId: ticket.originTopicId } : {}),
    ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
    ...(ticket.waiting ? { waiting: { ...ticket.waiting } } : {}),
    ...(ticket.cleanupPending ? { cleanupPending: true } : {}),
    ...(ticket.schedule ? { schedule: { ...ticket.schedule } } : {}),
  };
}

export function listSortedTicketCards(
  state: Readonly<{ tickets: Record<string, TicketRecord> }>,
  roles: Record<string, RolePreset>,
): TicketCardView[] {
  return Object.values(state.tickets)
    .map((t) => toTicketCardView(t, roles))
    .sort(compareTicketCards);
}
