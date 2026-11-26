import { createHash } from "node:crypto";
import type {
  ComputerPreviewSessionView,
  ComputerUseResult,
  EnvNodeDescriptor,
  ExecutionTrustMode,
  InheritedBrowserSession,
  TicketRecord,
} from "@kulo/protocol";
import type { ActiveComputerHandoff } from "./computer-handoff.js";

export const BROWSER_SESSION_TOMBSTONE_TTL_MS = 5 * 60_000;
export const BROWSER_SESSION_TRANSFERRED_ERROR = "浏览器会话已移交后台任务，请勿继续操作旧页面。";

export type BrowserProfileMode = "persistent" | "ephemeral" | "auto_connect";

export type BrowserSessionInheritRejectReason =
  | "not_orchestrator"
  | "unsupported_domain"
  | "external_agent"
  | "scheduled_ticket"
  | "not_trusted_mode"
  | "read_only_worker"
  | "no_active_session"
  | "env_mismatch"
  | "auto_connect_session"
  | "active_handoff"
  | "concurrent_browser_call"
  | "worker_queued"
  | "transfer_commit_race";

export interface TrackedComputerSession {
  ticketId: string;
  envId: string;
  tool: "browser" | "desktop";
  sessionId: string;
  conversationId?: number;
  runEpoch: number;
  app?: string;
}

export interface OrchestratorComputerSession {
  topicId: string;
  conversationId: number;
  envId: string;
  tool: "browser" | "desktop";
  sessionId: string;
  profileMode?: BrowserProfileMode;
  app?: string;
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface OrchestratorBrowserTransferCandidate {
  topicId: string;
  envId: string;
  sessionId: string;
  profileMode?: BrowserProfileMode;
  hasActiveHandoff: boolean;
  hasInFlightCall: boolean;
}

export interface ComputerBrowserTransferPort {
  activeOrchestratorBrowserEnvId(topicId: string): string | undefined;
  inspectOrchestratorBrowserForTransfer(topicId: string, targetEnvId?: string): OrchestratorBrowserTransferCandidate | undefined;
  commitOrchestratorBrowserTransferToTicket(input: {
    topicId: string;
    expectedSessionId: string;
    envId: string;
    ticketId: string;
    workerConversationId?: number;
    runEpoch: number;
  }): boolean;
}

export interface BrowserSessionTransferEligibilityInput {
  requested: boolean;
  isOrchestratorCaller: boolean;
  executionDomain: "computer" | "android";
  isExternalAgent: boolean;
  isScheduled: boolean;
  workerEffectiveMode: ExecutionTrustMode;
  isReadOnly: boolean;
  targetEnvId: string;
  candidate?: OrchestratorBrowserTransferCandidate;
  hasSameTurnBrowserCall: boolean;
  hasImmediateWorkerSlot: boolean;
}

export type BrowserSessionTransferDecision =
  | { eligible: true; candidate: InheritedBrowserSession }
  | { eligible: false; reason: BrowserSessionInheritRejectReason };

/**
 * Evaluates all four security & liveness gates for Orchestrator -> Worker browser session transfer:
 * 1. Caller is Orchestrator, computer domain, built-in Worker, non-scheduled;
 * 2. Frozen worker execution mode is `trusted` and writable (`!isReadOnly`);
 * 3. Active Orchestrator browser session matches `targetEnvId`, is not `auto_connect`,
 *    has no active human handoff, and has no concurrent/same-turn `kulo_browser` call;
 * 4. A Worker concurrency slot is immediately available (no queue / write-lock wait).
 */
export function evaluateBrowserSessionTransferEligibility(
  input: BrowserSessionTransferEligibilityInput,
): BrowserSessionTransferDecision {
  if (!input.isOrchestratorCaller) return { eligible: false, reason: "not_orchestrator" };
  if (input.executionDomain !== "computer") return { eligible: false, reason: "unsupported_domain" };
  if (input.isExternalAgent) return { eligible: false, reason: "external_agent" };
  if (input.isScheduled) return { eligible: false, reason: "scheduled_ticket" };
  if (input.isReadOnly) return { eligible: false, reason: "read_only_worker" };
  if (input.workerEffectiveMode !== "trusted") return { eligible: false, reason: "not_trusted_mode" };
  if (!input.candidate) return { eligible: false, reason: "no_active_session" };
  if (input.candidate.envId !== input.targetEnvId) return { eligible: false, reason: "env_mismatch" };
  if (input.candidate.profileMode === "auto_connect") return { eligible: false, reason: "auto_connect_session" };
  if (input.candidate.hasActiveHandoff) return { eligible: false, reason: "active_handoff" };
  if (input.candidate.hasInFlightCall || input.hasSameTurnBrowserCall) {
    return { eligible: false, reason: "concurrent_browser_call" };
  }
  if (!input.hasImmediateWorkerSlot) return { eligible: false, reason: "worker_queued" };
  return {
    eligible: true,
    candidate: { envId: input.candidate.envId, sessionId: input.candidate.sessionId },
  };
}

export function hasImmediateWorkerSlotForNewTicket(input: {
  paused: boolean;
  maxConcurrentWorkers: number;
  activeHolders: readonly string[];
  queuedRunnableAheadCount: number;
  writeConflictExists: boolean;
  targetDevicesOnline: boolean;
}): boolean {
  return (
    !input.paused &&
    input.targetDevicesOnline &&
    !input.writeConflictExists &&
    input.activeHolders.length + input.queuedRunnableAheadCount < input.maxConcurrentWorkers
  );
}

/**
 * Short-lived in-memory tombstone registry rejecting any racing Orchestrator `kulo_browser` call
 * targeting a session ID already handed off to a Worker.
 */
export class TransferredBrowserSessionTombstones {
  readonly #ttlMs: number;
  readonly #entries = new Map<string, number>();

  constructor(ttlMs = BROWSER_SESSION_TOMBSTONE_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  mark(sessionId: string, now = Date.now()): void {
    this.#prune(now);
    this.#entries.set(sessionId, now + this.#ttlMs);
  }

  has(sessionId: string, now = Date.now()): boolean {
    const expiresAt = this.#entries.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.#entries.delete(sessionId);
      return false;
    }
    return true;
  }

  clear(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(key);
    }
  }
}

export function extractBrowserProfileModeFromResult(data: unknown): BrowserProfileMode | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const mode = (data as Record<string, unknown>).profileMode;
  return mode === "persistent" || mode === "ephemeral" || mode === "auto_connect" ? mode : undefined;
}

/** Returns true when an assistant entry contains any `kulo_browser` tool call alongside `kulo_dispatch`. */
export function assistantEntryHasBrowserCall(
  entry: { model?: ReadonlyArray<{ role?: string; content?: unknown }> } | undefined,
): boolean {
  const assistantMsg = entry?.model?.[0];
  if (!assistantMsg || assistantMsg.role !== "assistant" || !Array.isArray(assistantMsg.content)) {
    return false;
  }
  return assistantMsg.content.some(
    (block) =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall" &&
      (block as { name?: unknown }).name === "kulo_browser",
  );
}

export function formatInheritedBrowserSessionNote(
  inherited: Readonly<InheritedBrowserSession> | undefined,
): string | undefined {
  if (!inherited) return undefined;
  return [
    "<inherited_browser_session>",
    `已从主对话继承设备 ${inherited.envId} 上已打开的浏览器会话（保留当前页面与登录状态）。`,
    "请先调用 `kulo_browser(action='get-url')` 或 `kulo_browser(action='snapshot')` 确认当前页面状态后再继续操作，无需重新登录或重新打开已登录的页面。",
    "</inherited_browser_session>",
  ].join("\n");
}

/**
 * Compare-and-swap in-memory transfer from Orchestrator `#orchestratorSessions` into Worker `#computerSessions`.
 * Must be called strictly AFTER `originConv.commit` succeeds and BEFORE `resumeIfNotRecovering()`.
 */
export function commitOrchestratorBrowserTransfer(params: {
  orchestratorSessions: Map<string, OrchestratorComputerSession>;
  computerSessions: Map<string, TrackedComputerSession>;
  tombstones: TransferredBrowserSessionTombstones;
  hasActiveHandoff: (handoffKey: string, sessionId: string) => boolean;
  inFlightBrowserCalls: ReadonlyMap<string, number>;
  topicId: string;
  expectedSessionId: string;
  envId: string;
  ticketId: string;
  workerConversationId?: number;
  runEpoch: number;
}): boolean {
  const orchKey = `${params.topicId}:browser`;
  const live = params.orchestratorSessions.get(orchKey);
  if (!live || live.sessionId !== params.expectedSessionId || live.envId !== params.envId) {
    return false;
  }
  if (params.hasActiveHandoff(`chat:${params.topicId}:browser:${params.envId}`, live.sessionId)) {
    return false;
  }
  if ((params.inFlightBrowserCalls.get(params.topicId) ?? 0) > 0) {
    return false;
  }
  clearTimeout(live.idleTimer);
  params.orchestratorSessions.delete(orchKey);
  params.computerSessions.set(`${params.ticketId}:browser:${live.sessionId}`, {
    ticketId: params.ticketId,
    envId: params.envId,
    tool: "browser",
    sessionId: live.sessionId,
    ...(params.workerConversationId !== undefined ? { conversationId: params.workerConversationId } : {}),
    runEpoch: params.runEpoch,
  });
  params.tombstones.mark(live.sessionId);
  return true;
}

/**
 * Resolves a Worker's retained computer-use session (with lazy `conversationId` binding for transferred
 * sessions) and falls back to durable `ticket.inheritedBrowserSession` after a cold Hub restart.
 */
export function resolveOrHydrateWorkerComputerSession(params: {
  computerSessions: Map<string, TrackedComputerSession>;
  closedTicketSessions: ReadonlySet<string>;
  ticket: Readonly<TicketRecord> | undefined;
  ticketId: string;
  conversationId: number;
  envId: string;
  runEpoch: number;
  tool: "browser" | "desktop";
  isSubagent: boolean;
}): TrackedComputerSession | undefined {
  let retained = [...params.computerSessions.values()].find(
    (entry) =>
      entry.ticketId === params.ticketId &&
      entry.envId === params.envId &&
      entry.tool === params.tool &&
      (entry.conversationId === params.conversationId ||
        (!params.isSubagent && entry.conversationId === undefined)),
  );
  if (retained) {
    if (!params.isSubagent && retained.conversationId === undefined) {
      retained.conversationId = params.conversationId;
    }
    if (retained.runEpoch !== params.runEpoch) {
      retained.runEpoch = params.runEpoch;
    }
    return retained;
  }
  if (params.tool !== "browser" || params.isSubagent) return undefined;
  const inherited = params.ticket?.inheritedBrowserSession;
  if (!inherited || inherited.envId !== params.envId) return undefined;
  const key = `${params.ticketId}:browser:${inherited.sessionId}`;
  if (params.closedTicketSessions.has(key)) return undefined;
  retained = {
    ticketId: params.ticketId,
    envId: inherited.envId,
    tool: "browser",
    sessionId: inherited.sessionId,
    conversationId: params.conversationId,
    runEpoch: params.runEpoch,
  };
  params.computerSessions.set(key, retained);
  return retained;
}

/**
 * Hydrates in-memory `#computerSessions` from durable `ticket.inheritedBrowserSession` records for active
 * tickets so live preview discovery works seamlessly after a cold Hub restart.
 */
export function hydrateInheritedTicketSessionsForPreview(
  tickets: Readonly<Record<string, TicketRecord>> | undefined,
  computerSessions: Map<string, TrackedComputerSession>,
  closedTicketSessions: ReadonlySet<string>,
): void {
  if (!tickets) return;
  for (const ticket of Object.values(tickets)) {
    const inherited = ticket.inheritedBrowserSession;
    if (!inherited) continue;
    if (ticket.status !== "running" && !(ticket.status === "waiting" && ticket.waiting?.reason === "user")) {
      continue;
    }
    const key = `${ticket.id}:browser:${inherited.sessionId}`;
    if (computerSessions.has(key) || closedTicketSessions.has(key)) continue;
    computerSessions.set(key, {
      ticketId: ticket.id,
      envId: inherited.envId,
      tool: "browser",
      sessionId: inherited.sessionId,
      conversationId: ticket.workerConversationId,
      runEpoch: ticket.runEpoch,
    });
  }
}

export function inspectOrchestratorBrowserCandidate(params: {
  orchestratorSessions: ReadonlyMap<string, OrchestratorComputerSession>;
  topicId: string;
  getEnvDescriptor: (envId: string) => Pick<EnvNodeDescriptor, "kind"> | undefined;
  hasActiveHandoff: (handoffKey: string, sessionId: string) => boolean;
  inFlightBrowserCalls: ReadonlyMap<string, number>;
}): OrchestratorBrowserTransferCandidate | undefined {
  const entry = params.orchestratorSessions.get(`${params.topicId}:browser`);
  if (!entry) return undefined;
  const profileMode: BrowserProfileMode | undefined =
    entry.profileMode ??
    (params.getEnvDescriptor(entry.envId)?.kind === "local" && process.env.KULO_BROWSER_AUTO_CONNECT === "1"
      ? "auto_connect"
      : undefined);
  return {
    topicId: params.topicId,
    envId: entry.envId,
    sessionId: entry.sessionId,
    ...(profileMode ? { profileMode } : {}),
    hasActiveHandoff: params.hasActiveHandoff(`chat:${params.topicId}:browser:${entry.envId}`, entry.sessionId),
    hasInFlightCall: (params.inFlightBrowserCalls.get(params.topicId) ?? 0) > 0,
  };
}

export function trackOrchestratorBrowserCallEnd(params: {
  inFlightBrowserCalls: Map<string, number>;
  orchestratorSessions: ReadonlyMap<string, OrchestratorComputerSession>;
  topicId: string;
  sessionId: string;
  action: string;
  result?: ComputerUseResult;
}): void {
  const nextCount = (params.inFlightBrowserCalls.get(params.topicId) ?? 1) - 1;
  if (nextCount <= 0) params.inFlightBrowserCalls.delete(params.topicId);
  else params.inFlightBrowserCalls.set(params.topicId, nextCount);
  if (params.action === "open" && params.result?.ok) {
    const profileMode = extractBrowserProfileModeFromResult(params.result.data);
    const existing = params.orchestratorSessions.get(`${params.topicId}:browser`);
    if (profileMode && existing && existing.sessionId === params.sessionId) {
      existing.profileMode = profileMode;
    }
  }
}

export async function forceCloseTicketComputerSessions(params: {
  ticketId: string;
  computerSessions: Map<string, TrackedComputerSession>;
  closedTicketSessions: Set<string>;
  closeEnvSession: (envId: string, tool: "browser" | "desktop", sessionId: string) => Promise<ComputerUseResult>;
  getPersistedInherited: () => Promise<InheritedBrowserSession | undefined>;
  clearPersistedInherited: (sessionId: string) => Promise<void>;
}): Promise<void> {
  const sessions = [...params.computerSessions].filter(([, s]) => s.ticketId === params.ticketId);
  const closedKeys = new Set<string>();
  for (const [key, session] of sessions) {
    params.computerSessions.delete(key);
    params.closedTicketSessions.add(key);
    closedKeys.add(key);
    await params.closeEnvSession(session.envId, session.tool, session.sessionId).catch(() => {});
    if (session.tool === "browser") await params.clearPersistedInherited(session.sessionId);
  }
  const inherited = await params.getPersistedInherited();
  if (!inherited) return;
  const key = `${params.ticketId}:browser:${inherited.sessionId}`;
  if (closedKeys.has(key) || params.closedTicketSessions.has(key)) return;
  params.closedTicketSessions.add(key);
  await params.closeEnvSession(inherited.envId, "browser", inherited.sessionId).catch(() => {});
  await params.clearPersistedInherited(inherited.sessionId);
}

export function buildTicketComputerSessionCleanupTasks(params: {
  ticketId: string;
  options: { park?: boolean; inheritedBrowserSession?: InheritedBrowserSession };
  computerSessions: Map<string, TrackedComputerSession>;
  closedTicketSessions: Set<string>;
  hasActiveHandoff: (ticketId: string, sessionId: string) => boolean;
  clearHandoff: (ticketId: string) => void;
  closeEnvSession: (envId: string, tool: "browser" | "desktop", sessionId: string) => Promise<ComputerUseResult>;
  getPersistedInherited?: () => Promise<InheritedBrowserSession | undefined>;
  clearPersistedInherited: (sessionId: string) => Promise<void>;
}): Array<Promise<void>> {
  const { ticketId, options } = params;
  if (!options.park) params.clearHandoff(ticketId);
  const sessions = [...params.computerSessions].filter(
    ([, session]) =>
      session.ticketId === ticketId &&
      !(options.park && params.hasActiveHandoff(ticketId, session.sessionId)),
  );
  const matchedKeys = new Set(sessions.map(([key]) => key));
  const closeInherited = async (inherited: InheritedBrowserSession) => {
    const key = `${ticketId}:browser:${inherited.sessionId}`;
    if (matchedKeys.has(key) || params.closedTicketSessions.has(key)) return;
    if (options.park && params.hasActiveHandoff(ticketId, inherited.sessionId)) return;
    const result = await params.closeEnvSession(inherited.envId, "browser", inherited.sessionId);
    if (!result.ok) throw new Error("任务的电脑操作会话尚未关闭。");
    params.computerSessions.delete(key);
    params.closedTicketSessions.add(key);
    await params.clearPersistedInherited(inherited.sessionId);
  };
  const tasks = sessions.map(async ([key, session]) => {
    const result = await params.closeEnvSession(session.envId, session.tool, session.sessionId);
    if (!result.ok) throw new Error("任务的电脑操作会话尚未关闭。");
    params.computerSessions.delete(key);
    params.closedTicketSessions.add(key);
    if (session.tool === "browser") await params.clearPersistedInherited(session.sessionId);
  });
  if (options.inheritedBrowserSession) {
    tasks.push(closeInherited(options.inheritedBrowserSession));
  } else if (!("inheritedBrowserSession" in options) && params.getPersistedInherited) {
    const readInherited = params.getPersistedInherited;
    tasks.push(
      (async () => {
        const inherited = await readInherited();
        if (inherited) await closeInherited(inherited);
      })(),
    );
  }
  return tasks;
}

export function formatPreviewHandoff(
  activeHandoff: Readonly<ActiveComputerHandoff> | undefined,
  active: boolean,
  tool: "browser" | "desktop",
): ComputerPreviewSessionView["handoff"] | undefined {
  if (!active || !activeHandoff) return undefined;
  return {
    requestId: activeHandoff.requestId,
    ...(activeHandoff.cardId ? { cardId: activeHandoff.cardId } : {}),
    reason: activeHandoff.reason,
    target: activeHandoff.tool,
    expiresAt: activeHandoff.expiresAt,
    ...(activeHandoff.url ? { url: activeHandoff.url } : {}),
    ...(activeHandoff.app ? { app: activeHandoff.app } : {}),
    interactive: tool === "browser",
  };
}

export function findComputerPreviewTarget(
  id: string,
  computerSessions: ReadonlyMap<string, TrackedComputerSession>,
  orchestratorSessions: ReadonlyMap<string, OrchestratorComputerSession>,
): { handoffKey: string; envId: string; tool: "browser" | "desktop"; sessionId: string } | undefined {
  for (const [key, session] of computerSessions) {
    if (createHash("sha256").update(key).digest("hex") === id) {
      return { handoffKey: session.ticketId, envId: session.envId, tool: session.tool, sessionId: session.sessionId };
    }
  }
  for (const entry of orchestratorSessions.values()) {
    const previewKey = `chat:${entry.topicId}:${entry.tool}:${entry.sessionId}`;
    if (createHash("sha256").update(previewKey).digest("hex") === id) {
      return {
        handoffKey: `chat:${entry.topicId}:${entry.tool}:${entry.envId}`,
        envId: entry.envId,
        tool: entry.tool,
        sessionId: entry.sessionId,
      };
    }
  }
  return undefined;
}
