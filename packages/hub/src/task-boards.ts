import { ROOT_CONVERSATION_ID, ToolResultEntry, type EntryRecord } from "@earendil-works/pi-durable";
import {
  redactSensitiveText,
  type TaskBoardEntry,
  type TaskBoardEntryKind,
  type TaskBoardRecord,
  type TaskBoardSearchMatch,
  type TaskBoardStatus,
  type TicketRecord,
} from "@kulo/protocol";
import { redactCredentialData } from "./credential-redaction.js";
import { ProjectError, type KuloProjectsState } from "./projects.js";
import { isActiveSettingsConversation, type SettingsAssistantState } from "./settings-doc.js";
import {
  hasPendingWorkspaceApply,
  isActiveRootConversation,
  isRecoveryInputBoundary,
  recordProcessedCommand,
  type KuloDurableState,
} from "./state.js";

export const MAX_TASK_BOARDS = 64;
export const MAX_TASK_BOARD_ENTRIES = 16;
export const MAX_TASK_BOARD_TICKETS = 32;
export const MAX_TASK_BOARD_KEYWORDS = 24;
export const MAX_TASK_BOARD_TITLE_CHARS = 60;
export const MAX_TASK_BOARD_GOAL_CHARS = 240;
export const MAX_TASK_BOARD_NOTE_CHARS = 320;
export const MAX_TASK_BOARD_WORKER_CONTEXT_CHARS = 3_000;
export const MAX_TASK_BOARD_READ_CHARS = 6_000;
export const RECENT_WORK_BOARD_MAX_ITEMS = 4;
export const RECENT_WORK_BOARD_BUDGET_CHARS = 400;

const ACTIVE_TICKET_STATES = new Set(["queued", "running", "pausing", "waiting", "blocked"]);
const BOARD_ENTRY_KINDS = new Set<TaskBoardEntryKind>([
  "verified",
  "decision",
  "constraint",
  "handoff",
  "correction",
]);

export interface BoardCallerScope {
  conversationId: number;
  topicId?: string;
  currentTopic?: NonNullable<KuloDurableState["topics"]>[string];
  currentProject?: NonNullable<KuloProjectsState["projects"]>[string];
  missingProject: boolean;
  isActiveSettings: boolean;
  isGlobalChatScope: boolean;
}

export function sanitizeBoardText(
  raw: string | undefined,
  redact: (text: string) => string,
  maxChars: number,
): string {
  const cleaned = redactSensitiveText(redact(raw ?? "")).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function resolveBoardCallerScope(
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  conversationId: number,
): BoardCallerScope {
  const isActiveSettings = isActiveSettingsConversation(conversationId, settings);
  const topicId = state?.conversationToTopic?.[String(conversationId)];
  const topic = topicId ? state?.topics?.[topicId] : undefined;
  const currentTopic = topic?.deletedAt === undefined ? topic : undefined;
  const project = currentTopic?.projectId ? projects?.projects?.[currentTopic.projectId] : undefined;
  const currentProject = project?.deletedAt === undefined ? project : undefined;
  const missingProject = Boolean(currentTopic?.projectId && !currentProject);
  const isGlobalChatScope =
    !isActiveSettings &&
    (isActiveRootConversation(conversationId, state) || Boolean(currentTopic?.master && currentTopic.deletedAt === undefined));
  return {
    conversationId,
    ...(currentTopic ? { topicId: currentTopic.id, currentTopic } : {}),
    ...(currentProject ? { currentProject } : {}),
    missingProject,
    isActiveSettings,
    isGlobalChatScope,
  };
}

export function isTaskBoardUnavailable(
  board: Readonly<TaskBoardRecord>,
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
): boolean {
  if (board.projectId) {
    const project = projects?.projects?.[board.projectId];
    if (!project || project.deletedAt !== undefined) return true;
  } else {
    const originTopic = state?.topics?.[board.originTopicId];
    if (originTopic?.deletedAt !== undefined) return true;
  }
  return false;
}

export function canAccessTaskBoard(
  board: Readonly<TaskBoardRecord>,
  scope: Readonly<BoardCallerScope>,
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
): boolean {
  if (scope.isActiveSettings || scope.missingProject) return false;
  if (isTaskBoardUnavailable(board, state, projects)) return false;
  if (scope.currentProject) {
    return (
      board.projectId === scope.currentProject.id ||
      (!board.projectId && board.originTopicId === scope.currentTopic?.id)
    );
  }
  if (scope.isGlobalChatScope) return true;
  return (
    !board.projectId &&
    (board.originTopicId === scope.currentTopic?.id ||
      board.originConversationId === scope.conversationId)
  );
}

export function canAccessTicketInScope(
  ticket: Readonly<TicketRecord>,
  scope: Readonly<BoardCallerScope>,
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
): boolean {
  if (scope.isActiveSettings || scope.missingProject) return false;
  if (ticket.projectId && projects?.projects?.[ticket.projectId]?.deletedAt !== undefined) return false;
  const originTopic = ticket.originTopicId ? state?.topics?.[ticket.originTopicId] : undefined;
  if (originTopic?.deletedAt !== undefined) return false;
  if (scope.currentProject) {
    return (
      ticket.projectId === scope.currentProject.id ||
      ticket.originTopicId === scope.currentTopic?.id ||
      ticket.originConversationId === scope.conversationId
    );
  }
  if (scope.isGlobalChatScope) return true;
  return (
    (Boolean(scope.currentTopic) && ticket.originTopicId === scope.currentTopic!.id) ||
    (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === scope.conversationId
  );
}

/**
 * Enforces the one-way project lock invariant so a board can never cross-contaminate two projects.
 */
export function assertAndLockBoardProjectInTx(
  board: TaskBoardRecord,
  ticketProjectId: string | undefined,
  ticketOriginConversationId: number,
  state: Readonly<KuloDurableState>,
): void {
  if (board.projectId) {
    if (ticketProjectId !== board.projectId) {
      throw new ProjectError(
        409,
        "board_project_mismatch",
        `交接板 '${board.id}' 已锁定至项目 '${board.projectId}'，不能挂载不同项目或无项目工单。`,
      );
    }
    return;
  }
  if (!ticketProjectId) return;

  for (const tid of board.ticketIds) {
    const prior = state.tickets[tid];
    if (!prior) continue;
    if (prior.projectId && prior.projectId !== ticketProjectId) {
      throw new ProjectError(
        409,
        "board_project_mismatch",
        `交接板 '${board.id}' 已关联其他项目工单，禁止跨项目绑定。`,
      );
    }
    const priorConv = prior.originConversationId ?? Number(ROOT_CONVERSATION_ID);
    if (!prior.projectId && priorConv !== ticketOriginConversationId) {
      throw new ProjectError(
        409,
        "board_project_mismatch",
        `交接板 '${board.id}' 属于其他会话的无项目任务，不能直接升级锁定至当前项目。`,
      );
    }
  }
  board.projectId = ticketProjectId;
}

export function extractBoardKeywords(texts: readonly (string | undefined)[]): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (tok: string) => {
    const clean = tok.toLowerCase().trim();
    if (clean.length < 2 || seen.has(clean)) return;
    seen.add(clean);
    tokens.push(clean);
  };
  for (const raw of texts) {
    if (!raw) continue;
    for (const m of raw.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]{1,31}|[\u4e00-\u9fff]{2,8}/g)) {
      add(m[0]);
      if (tokens.length >= MAX_TASK_BOARD_KEYWORDS) return tokens;
    }
  }
  return tokens;
}

function mergeKeywords(existing: readonly string[], extra: readonly (string | undefined)[]): string[] {
  const merged = [...existing];
  const seen = new Set(merged);
  for (const kw of extractBoardKeywords(extra)) {
    if (seen.has(kw)) continue;
    seen.add(kw);
    merged.push(kw);
    if (merged.length >= MAX_TASK_BOARD_KEYWORDS) break;
  }
  return merged;
}

function appendTicketIdBounded(list: readonly string[], ticketId: string): string[] {
  const next = list.filter((id) => id !== ticketId);
  next.push(ticketId);
  return next.length > MAX_TASK_BOARD_TICKETS
    ? next.slice(next.length - MAX_TASK_BOARD_TICKETS)
    : next;
}

export function pruneTaskBoardsInTx(state: KuloDurableState): void {
  const boards = state.boards;
  if (!boards) return;
  const all = Object.values(boards);
  if (all.length <= MAX_TASK_BOARDS) return;

  const hasActiveTicket = (b: TaskBoardRecord) =>
    b.ticketIds.some((tid) => {
      const t = state.tickets[tid];
      return Boolean(t && ACTIVE_TICKET_STATES.has(t.status));
    });

  const candidates = all.sort((a, b) => {
    const aActive = hasActiveTicket(a) ? 1 : 0;
    const bActive = hasActiveTicket(b) ? 1 : 0;
    if (aActive !== bActive) return aActive - bActive;
    const aArch = a.status === "archived" ? 0 : 1;
    const bArch = b.status === "archived" ? 0 : 1;
    if (aArch !== bArch) return aArch - bArch;
    return (a.archivedAt ?? a.lastEntryAt) - (b.archivedAt ?? b.lastEntryAt);
  });

  const excess = all.length - MAX_TASK_BOARDS;
  for (let i = 0; i < excess; i += 1) {
    const drop = candidates[i];
    if (drop) delete boards[drop.id];
  }
}

export function createTaskBoardInTx(
  state: KuloDurableState,
  input: {
    title: string;
    goal?: string;
    projectId?: string;
    originTopicId: string;
    originConversationId: number;
    now: number;
  },
  redact: (text: string) => string,
): TaskBoardRecord {
  state.boards ??= {};
  const num = state.nextBoardNumber ?? 1;
  state.nextBoardNumber = num + 1;
  const id = `B-${String(num).padStart(4, "0")}`;
  const title = sanitizeBoardText(input.title, redact, MAX_TASK_BOARD_TITLE_CHARS) || `协作板 ${id}`;
  const goal = sanitizeBoardText(input.goal ?? input.title, redact, MAX_TASK_BOARD_GOAL_CHARS);
  const record: TaskBoardRecord = {
    id,
    title,
    goal,
    status: "active",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    originTopicId: input.originTopicId,
    originConversationId: input.originConversationId,
    keywords: extractBoardKeywords([title, goal]),
    ticketIds: [],
    entries: [],
    nextEntrySeq: 1,
    createdAt: input.now,
    updatedAt: input.now,
    lastEntryAt: input.now,
  };
  state.boards[id] = record;
  pruneTaskBoardsInTx(state);
  return state.boards[id]!;
}

export function attachDispatchedTicketToBoardInTx(
  state: KuloDurableState,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  params: {
    ticketId: string;
    ticketTitle: string;
    ticketGoal: string;
    ticketProjectId?: string;
    originConversationId: number;
    originTopicId: string;
    requestedBoardId?: string;
    requestedBoardTitle?: string;
    reviewTicket?: TicketRecord;
    now: number;
  },
  redact: (text: string) => string,
): string | undefined {
  const scope = resolveBoardCallerScope(state, projects, settings, params.originConversationId);
  const cleanBoardId = params.requestedBoardId?.trim() || params.reviewTicket?.boardId?.trim();
  const cleanBoardTitle = params.requestedBoardTitle?.trim();

  if (cleanBoardId) {
    const board = state.boards?.[cleanBoardId];
    if (!board || !canAccessTaskBoard(board, scope, state, projects)) {
      throw new ProjectError(404, "board_not_found", `任务交接板 '${cleanBoardId}' 不存在或当前会话无权访问。`);
    }
    assertAndLockBoardProjectInTx(board, params.ticketProjectId, params.originConversationId, state);
    if (board.status === "archived") {
      board.status = "active";
      delete board.archivedAt;
      board.lastEntryAt = params.now;
    }
    board.ticketIds = appendTicketIdBounded(board.ticketIds, params.ticketId);
    board.keywords = mergeKeywords(board.keywords, [params.ticketTitle, params.ticketGoal]);
    board.updatedAt = params.now;
    return board.id;
  }

  if (cleanBoardTitle || params.reviewTicket) {
    const title = cleanBoardTitle || params.reviewTicket!.title;
    const goal = params.reviewTicket ? params.reviewTicket.goal : params.ticketGoal;
    const projectId = params.ticketProjectId ?? params.reviewTicket?.projectId;
    const board = createTaskBoardInTx(
      state,
      {
        title,
        goal,
        ...(projectId ? { projectId } : {}),
        originTopicId: params.originTopicId,
        originConversationId: params.originConversationId,
        now: params.now,
      },
      redact,
    );
    if (params.reviewTicket) {
      board.ticketIds = appendTicketIdBounded(board.ticketIds, params.reviewTicket.id);
      params.reviewTicket.boardId = board.id;
      board.keywords = mergeKeywords(board.keywords, [params.reviewTicket.title]);
    }
    board.ticketIds = appendTicketIdBounded(board.ticketIds, params.ticketId);
    board.keywords = mergeKeywords(board.keywords, [params.ticketTitle, params.ticketGoal]);
    return board.id;
  }

  return undefined;
}

function collectTicketEvidence(ticket: Readonly<TicketRecord>): {
  mergedPaths?: string[];
  stagedPaths?: string[];
  artifactRefs?: string[];
} {
  const staged = ticket.externalExecution?.stagedDiff ?? ticket.workspaceStaging?.stagedDiff;
  const allPaths = staged
    ? [...new Set([...staged.added, ...staged.modified, ...staged.deleted])].slice(0, 12)
    : [];
  const applied = Boolean(
    ticket.externalExecution?.stagedAppliedAt ?? ticket.workspaceStaging?.appliedAt,
  );
  const refs: string[] = [];
  for (const att of ticket.latestReport?.attachments ?? []) {
    if (refs.length < 4) refs.push(`${att.id} (${att.name})`);
  }
  if (ticket.latestReport?.overflowAsset && refs.length < 4) {
    refs.push(`${ticket.latestReport.overflowAsset.id} (${ticket.latestReport.overflowAsset.name})`);
  }
  return {
    ...(allPaths.length > 0 ? (applied ? { mergedPaths: allPaths } : { stagedPaths: allPaths }) : {}),
    ...(refs.length > 0 ? { artifactRefs: refs } : {}),
  };
}

export interface TaskBoardWriteParams {
  commandId: string;
  conversationId: number;
  boardId?: string;
  boardTitle?: string;
  goal?: string;
  ticketId?: string;
  kind?: TaskBoardEntryKind;
  note?: string;
  supersedesSeq?: number;
  status?: TaskBoardStatus;
  now: number;
}

export function writeTaskBoardInTx(
  state: KuloDurableState,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  params: TaskBoardWriteParams,
  redact: (text: string) => string,
): { board: TaskBoardRecord; deduplicated: boolean } {
  const cleanCmd = params.commandId.trim();
  if (!cleanCmd) throw new ProjectError(400, "invalid_command_id", "写入交接板需要有效的 command_id。");

  const scope = resolveBoardCallerScope(state, projects, settings, params.conversationId);
  if (scope.isActiveSettings) {
    throw new ProjectError(403, "board_forbidden", "设置助手会话不能操作任务交接板。");
  }

  const priorCmd = state.processedCommands?.[cleanCmd];
  if (priorCmd && priorCmd.action === "board.write") {
    const existing = state.boards?.[priorCmd.ticketId];
    if (existing && canAccessTaskBoard(existing, scope, state, projects)) {
      return { board: JSON.parse(JSON.stringify(existing)) as TaskBoardRecord, deduplicated: true };
    }
  }

  let linkedTicket: TicketRecord | undefined;
  if (params.ticketId?.trim()) {
    linkedTicket = state.tickets[params.ticketId.trim()];
    if (!linkedTicket || !canAccessTicketInScope(linkedTicket, scope, state, projects)) {
      throw new ProjectError(404, "ticket_not_found", `任务 '${params.ticketId}' 不存在或无权引用。`);
    }
  }

  const targetBoardId = params.boardId?.trim() || linkedTicket?.boardId?.trim();
  let board: TaskBoardRecord | undefined;
  if (targetBoardId) {
    board = state.boards?.[targetBoardId];
    if (!board || !canAccessTaskBoard(board, scope, state, projects)) {
      throw new ProjectError(404, "board_not_found", `任务交接板 '${targetBoardId}' 不存在或当前会话无权访问。`);
    }
  } else {
    const title = params.boardTitle?.trim() || linkedTicket?.title;
    if (!title) {
      throw new ProjectError(400, "board_title_required", "新建交接板须提供 board_title 或 ticket_id。");
    }
    const originTopicId = scope.topicId ?? linkedTicket?.originTopicId ?? "root";
    const projectId = linkedTicket?.projectId ?? scope.currentProject?.id;
    board = createTaskBoardInTx(
      state,
      {
        title,
        goal: params.goal?.trim() || linkedTicket?.goal || title,
        ...(projectId ? { projectId } : {}),
        originTopicId,
        originConversationId: params.conversationId,
        now: params.now,
      },
      redact,
    );
  }

  if (linkedTicket) {
    assertAndLockBoardProjectInTx(board, linkedTicket.projectId, params.conversationId, state);
    board.ticketIds = appendTicketIdBounded(board.ticketIds, linkedTicket.id);
    linkedTicket.boardId = board.id;
    board.keywords = mergeKeywords(board.keywords, [linkedTicket.title]);
  }

  if (params.boardTitle?.trim()) {
    board.title = sanitizeBoardText(params.boardTitle, redact, MAX_TASK_BOARD_TITLE_CHARS) || board.title;
  }
  if (params.goal?.trim()) {
    board.goal = sanitizeBoardText(params.goal, redact, MAX_TASK_BOARD_GOAL_CHARS) || board.goal;
  }

  let substantive = false;
  if (params.note?.trim()) {
    const kind: TaskBoardEntryKind =
      params.kind && BOARD_ENTRY_KINDS.has(params.kind) ? params.kind : "verified";
    const note = sanitizeBoardText(params.note, redact, MAX_TASK_BOARD_NOTE_CHARS);
    if (note) {
      const seq = board.nextEntrySeq++;
      const nextEntries = board.entries.map((e) =>
        params.supersedesSeq !== undefined && e.seq === params.supersedesSeq && e.supersededBySeq === undefined
          ? { ...e, supersededBySeq: seq }
          : e,
      );
      const evidence = linkedTicket ? collectTicketEvidence(linkedTicket) : {};
      nextEntries.push({
        seq,
        kind,
        note,
        ...(linkedTicket ? { ticketId: linkedTicket.id, role: linkedTicket.role } : {}),
        ...evidence,
        at: params.now,
      });
      board.entries =
        nextEntries.length > MAX_TASK_BOARD_ENTRIES
          ? nextEntries.slice(nextEntries.length - MAX_TASK_BOARD_ENTRIES)
          : nextEntries;
      board.keywords = mergeKeywords(board.keywords, [board.title, board.goal, note]);
      substantive = true;
    }
  }

  if (params.status === "archived" && board.status !== "archived") {
    board.status = "archived";
    board.archivedAt = params.now;
    substantive = true;
  } else if (params.status === "active" && board.status !== "active") {
    board.status = "active";
    delete board.archivedAt;
    substantive = true;
  }

  board.updatedAt = params.now;
  if (substantive) board.lastEntryAt = params.now;
  recordProcessedCommand(state, cleanCmd, board.id, "board.write");
  return { board: JSON.parse(JSON.stringify(board)) as TaskBoardRecord, deduplicated: false };
}

export function searchTaskBoards(
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  conversationId: number,
  query: string,
  includeArchived = true,
  redact: (text: string) => string = (t) => t,
): TaskBoardSearchMatch[] {
  const scope = resolveBoardCallerScope(state, projects, settings, conversationId);
  if (scope.isActiveSettings || scope.missingProject) return [];

  const cleanQuery = query.trim().toLowerCase();
  const queryTerms = extractBoardKeywords([query]);
  const scored: Array<{ board: TaskBoardRecord; score: number }> = [];

  for (const board of Object.values(state?.boards ?? {})) {
    if (!canAccessTaskBoard(board, scope, state, projects)) continue;
    if (!includeArchived && board.status === "archived") continue;

    let score = 0;
    const titleLower = board.title.toLowerCase();
    const goalLower = board.goal.toLowerCase();
    const idLower = board.id.toLowerCase();

    if (!cleanQuery) {
      score = board.status === "active" ? 10 : 5;
    } else {
      if (idLower === cleanQuery) score += 100;
      if (titleLower.includes(cleanQuery)) score += 40;
      if (goalLower.includes(cleanQuery)) score += 25;
      for (const term of queryTerms) {
        if (titleLower.includes(term)) score += 12;
        if (goalLower.includes(term)) score += 8;
        if (board.keywords.some((k) => k.includes(term) || term.includes(k))) score += 6;
      }
      for (const tid of board.ticketIds) {
        const tk = state?.tickets?.[tid];
        if (!tk) continue;
        if (tid.toLowerCase() === cleanQuery) score += 50;
        const tLower = tk.title.toLowerCase();
        if (tLower.includes(cleanQuery)) score += 18;
        else if (queryTerms.some((term) => tLower.includes(term))) score += 5;
      }
      for (const entry of board.entries) {
        if (entry.supersededBySeq !== undefined) continue;
        const nLower = entry.note.toLowerCase();
        if (nLower.includes(cleanQuery)) score += 15;
        else if (queryTerms.some((term) => nLower.includes(term))) score += 4;
      }
    }

    if (score > 0) {
      if (board.status === "active") score += 3;
      if (board.originConversationId === conversationId) score += 2;
      scored.push({ board, score });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.board.lastEntryAt - a.board.lastEntryAt ||
      a.board.id.localeCompare(b.board.id),
  );

  return scored.slice(0, 5).map(({ board }) => {
    const latestActive = [...board.entries].reverse().find((e) => e.supersededBySeq === undefined);
    const match: TaskBoardSearchMatch = {
      id: board.id,
      title: board.title,
      goal: board.goal,
      status: board.status,
      ...(board.projectId ? { projectId: board.projectId } : {}),
      ticketCount: board.ticketIds.length,
      ...(latestActive ? { latestNote: latestActive.note.slice(0, 120) } : {}),
      lastEntryAt: board.lastEntryAt,
    };
    return redactCredentialData(match, redact);
  });
}

export function readTaskBoard(
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  conversationId: number,
  boardId: string,
  redact: (text: string) => string,
): Record<string, unknown> {
  const scope = resolveBoardCallerScope(state, projects, settings, conversationId);
  const board = state?.boards?.[boardId.trim()];
  if (!board || !canAccessTaskBoard(board, scope, state, projects)) {
    throw new ProjectError(404, "board_not_found", `任务交接板 '${boardId}' 不存在或当前会话无权访问。`);
  }
  const linkedTickets = board.ticketIds
    .map((tid) => state?.tickets?.[tid])
    .filter((t): t is TicketRecord => Boolean(t))
    .slice(-12)
    .map((t) => ({
      id: t.id,
      title: t.title,
      role: t.role,
      status: t.status,
      ...(hasPendingWorkspaceApply(t) ? { pendingWorkspaceApply: true } : {}),
      ...(t.reviewTicketId ? { reviewTicketId: t.reviewTicketId } : {}),
    }));
  const payload = redactCredentialData(
    {
      id: board.id,
      title: board.title,
      goal: board.goal,
      status: board.status,
      ...(board.projectId ? { projectId: board.projectId } : {}),
      entries: board.entries.map((e) => ({ ...e })),
      tickets: linkedTickets,
      lastEntryAt: board.lastEntryAt,
    },
    redact,
  );
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_TASK_BOARD_READ_CHARS) return payload;
  return {
    ...payload,
    entries: payload.entries.slice(-8),
    truncated: true,
  };
}

export function formatTaskBoardWorkerContext(
  board: Readonly<TaskBoardRecord> | undefined,
  redact: (text: string) => string = (t) => t,
): string | undefined {
  if (!board) return undefined;
  const activeEntries = board.entries.filter((e) => e.supersededBySeq === undefined);
  const headerLines = [
    `## Verified Task Board Context (${board.id}: ${sanitizeBoardText(board.title, redact, MAX_TASK_BOARD_TITLE_CHARS)})`,
    `Mission Goal: ${sanitizeBoardText(board.goal, redact, MAX_TASK_BOARD_GOAL_CHARS)}`,
    "Verified by coordinator as background context; always re-verify live workspace files and command outputs before editing or concluding.",
  ];
  if (activeEntries.length === 0) {
    return headerLines.join("\n");
  }

  // Prioritize constraints/decisions + newest entries within hard budget.
  const selected: TaskBoardEntry[] = [];
  let used = headerLines.join("\n").length + 40;
  const ordered = [
    ...activeEntries.filter((e) => e.kind === "constraint" || e.kind === "decision"),
    ...activeEntries.filter((e) => e.kind !== "constraint" && e.kind !== "decision"),
  ].reverse();
  const chosenSeqs = new Set<number>();

  for (const entry of ordered) {
    const line = formatEntryLine(entry, redact);
    if (used + line.length + 1 > MAX_TASK_BOARD_WORKER_CONTEXT_CHARS) continue;
    chosenSeqs.add(entry.seq);
    used += line.length + 1;
  }

  for (const entry of activeEntries) {
    if (chosenSeqs.has(entry.seq)) selected.push(entry);
  }
  const omitted = activeEntries.length - selected.length;
  const lines = [
    ...headerLines,
    ...(omitted > 0 ? [`(${omitted} older verified board entries omitted)`] : []),
    ...selected.map((e) => formatEntryLine(e, redact)),
  ];
  const text = lines.join("\n");
  return text.length > MAX_TASK_BOARD_WORKER_CONTEXT_CHARS
    ? `${text.slice(0, MAX_TASK_BOARD_WORKER_CONTEXT_CHARS - 1)}…`
    : text;
}

function formatEntryLine(entry: Readonly<TaskBoardEntry>, redact: (text: string) => string): string {
  const tag = `[#${entry.seq} ${entry.kind}${entry.ticketId ? ` · ${entry.ticketId}` : ""}]`;
  const parts = [`- ${tag} ${sanitizeBoardText(entry.note, redact, MAX_TASK_BOARD_NOTE_CHARS)}`];
  if (entry.mergedPaths?.length) {
    parts.push(`(merged: ${entry.mergedPaths.slice(0, 6).join(", ")})`);
  } else if (entry.stagedPaths?.length) {
    parts.push(`(unmerged staged: ${entry.stagedPaths.slice(0, 6).join(", ")})`);
  }
  if (entry.artifactRefs?.length) {
    parts.push(`[artifacts: ${entry.artifactRefs.slice(0, 3).join(", ")}]`);
  }
  return parts.join(" ");
}

export function formatRecentWorkTaskBoardsSection(
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  conversationId: number,
  maxChars = RECENT_WORK_BOARD_BUDGET_CHARS,
): string | undefined {
  const scope = resolveBoardCallerScope(state, projects, settings, conversationId);
  if (scope.isActiveSettings || scope.missingProject) return undefined;

  const eligible = Object.values(state?.boards ?? {}).filter((board) => {
    if (board.status !== "active") return false;
    if (!canAccessTaskBoard(board, scope, state, projects)) return false;
    const originTopic = state?.topics?.[board.originTopicId];
    if (originTopic?.archived && originTopic.id !== scope.currentTopic?.id) {
      const hasRunning = board.ticketIds.some((tid) => {
        const t = state?.tickets?.[tid];
        return Boolean(t && ACTIVE_TICKET_STATES.has(t.status));
      });
      if (!hasRunning) return false;
    }
    return true;
  });
  if (eligible.length === 0) return undefined;

  const rank = (b: TaskBoardRecord) =>
    b.originConversationId === conversationId ||
    (scope.currentTopic && b.originTopicId === scope.currentTopic.id)
      ? 0
      : 1;
  eligible.sort(
    (a, b) => rank(a) - rank(b) || b.lastEntryAt - a.lastEntryAt || a.id.localeCompare(b.id),
  );

  const lines = ["### Active Task Boards"];
  let used = lines[0]!.length;
  for (const board of eligible.slice(0, RECENT_WORK_BOARD_MAX_ITEMS)) {
    const latest = [...board.entries].reverse().find((e) => e.supersededBySeq === undefined);
    const title = board.title.replace(/\s+/g, " ").trim().slice(0, 36);
    const latestNote = latest ? latest.note.replace(/\s+/g, " ").trim().slice(0, 48) : undefined;
    const rawLine = `* ${board.id} · ${title} · ${board.ticketIds.length}t${latestNote ? ` · ${latestNote}` : ""}`;
    const line = rawLine.length > 96 ? `${rawLine.slice(0, 95)}…` : rawLine;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

export function resolveReplyTaskAnchor(
  entries: readonly EntryRecord[],
  replyMessageId: number | undefined,
  state: Readonly<KuloDurableState> | undefined,
  projects: Readonly<KuloProjectsState> | undefined,
  settings: Readonly<SettingsAssistantState> | undefined,
  conversationId: number,
): string | undefined {
  if (replyMessageId === undefined || !Number.isFinite(replyMessageId)) return undefined;
  const targetIdx = entries.findIndex((entry) => Number(entry.id) === replyMessageId);
  if (targetIdx < 0) return undefined;

  let matchedTicketId: string | undefined;
  for (let i = targetIdx; i >= Math.max(0, targetIdx - 6); i -= 1) {
    const entry = entries[i]!;
    if (i < targetIdx && isRecoveryInputBoundary(entry)) break;
    if (ToolResultEntry.is(entry)) {
      const msg = entry.model?.[0];
      if (msg && msg.role === "toolResult" && msg.toolName === "kulo_dispatch") {
        const textBlock = msg.content.find((c): c is { type: "text"; text: string } => c.type === "text");
        if (textBlock) {
          try {
            const parsed = JSON.parse(textBlock.text) as { ticket?: { id?: unknown } };
            if (typeof parsed?.ticket?.id === "string" && parsed.ticket.id.trim()) {
              matchedTicketId = parsed.ticket.id.trim();
              break;
            }
          } catch {
            // ignore non-JSON tool result
          }
        }
      }
    }
  }
  if (!matchedTicketId) return undefined;
  const ticket = state?.tickets?.[matchedTicketId];
  if (!ticket) return undefined;

  const scope = resolveBoardCallerScope(state, projects, settings, conversationId);
  if (!canAccessTicketInScope(ticket, scope, state, projects)) return undefined;
  const board = ticket.boardId ? state?.boards?.[ticket.boardId] : undefined;
  if (board && canAccessTaskBoard(board, scope, state, projects)) {
    return `[Linked Task: ${ticket.id} | Board: ${board.id} "${board.title}"]`;
  }
  return `[Linked Task: ${ticket.id}]`;
}

