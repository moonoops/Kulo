import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  AssistantEntry,
  CompactionEntry,
  LiveDoc,
  type ContextView,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  type Harness,
  type LiveState,
} from "@earendil-works/pi-durable";
import type {
  CompactionConfig,
  CompactionDeclineReason,
  LiveContextSource,
  LiveContextState,
  TopicCompactResult,
} from "@kulo/protocol";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_SOFT_BACKGROUND_TRIGGER_TOKENS,
  HARD_CONTEXT_GUARD_CEILING_TOKENS,
  computeContextThresholds,
} from "./config.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import { ProjectError } from "./projects.js";
import { KuloStateDoc } from "./state.js";

const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
const DECLINE_ERROR_MESSAGE = "安全脱敏保护暂缓了本次自动整理，请检查敏感内容或重启后重试。";

export interface EstimatedContextTokens {
  tokens: number;
  source: LiveContextSource;
}

export interface CompactablePrefixAnalysis {
  canCompact: boolean;
  cutIndex?: number;
  droppedTokens: number;
}

function isUsableMeasuredAssistant(message: Message): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    !EXCLUDED_STOP_REASONS.has(message.stopReason) &&
    calculateContextTokens(message.usage) > 0
  );
}

/**
 * Estimates active context tokens from a public `ContextView` using only publicly exported
 * `@earendil-works/pi-ai/utils/estimate` primitives.
 */
export function estimateActiveContextFromContextView(view: ContextView): EstimatedContextTokens {
  let measured: AssistantMessage | undefined;
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
  for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index -= 1) {
    if (view.entries[index]!.id <= after) continue;
    const contributions = view.contributions[index] ?? [];
    for (let j = contributions.length - 1; j >= 0; j -= 1) {
      const candidate = contributions[j]!;
      if (isUsableMeasuredAssistant(candidate)) {
        measured = candidate;
        break;
      }
    }
  }
  if (measured !== undefined) {
    const from = view.messages.lastIndexOf(measured) + 1;
    let tokens = calculateContextTokens(measured.usage);
    for (const message of view.messages.slice(from)) {
      tokens += estimateMessageTokens(message);
    }
    return { tokens, source: "usage" };
  }
  let tokens = 0;
  for (const message of view.messages) {
    tokens += estimateMessageTokens(message);
  }
  return { tokens, source: "estimate" };
}

/**
 * O(1)-ish fast estimator over a watch window (`ConversationView`) when a valid post-head
 * `AssistantEntry.usage` is present in the window (or when the full unedited transcript fits
 * in the window). Returns `undefined` when an async `conversation.context()` read is needed.
 */
export function estimateContextFromWatchView(view: ConversationView): EstimatedContextTokens | undefined {
  const entries = view.entries;
  if (entries.length === 0) {
    return view.before === undefined ? { tokens: 0, source: "estimate" } : undefined;
  }

  let headIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.head !== undefined) {
      headIdx = i;
      break;
    }
  }

  let measuredIdx = -1;
  let measuredMsg: AssistantMessage | undefined;
  for (let i = entries.length - 1; i > headIdx; i -= 1) {
    const entry = entries[i]!;
    if (!AssistantEntry.is(entry)) continue;
    const msgs = entry.model ?? [];
    for (let j = msgs.length - 1; j >= 0; j -= 1) {
      const candidate = msgs[j]!;
      if (isUsableMeasuredAssistant(candidate)) {
        measuredIdx = i;
        measuredMsg = candidate;
        break;
      }
    }
    if (measuredMsg) break;
  }

  if (measuredMsg !== undefined) {
    let tokens = calculateContextTokens(measuredMsg.usage);
    for (let i = measuredIdx + 1; i < entries.length; i += 1) {
      const entry = entries[i]!;
      // An edit in the trailing tail can alter an earlier entry; defer to exact ContextView.
      if (entry.edits && entry.edits.length > 0) return undefined;
      for (const msg of entry.model ?? []) {
        if (msg.role === "assistant" && EXCLUDED_STOP_REASONS.has(msg.stopReason)) continue;
        tokens += estimateMessageTokens(msg);
      }
    }
    return { tokens, source: "usage" };
  }

  // No measured assistant in tail: only estimate directly if the complete transcript is uncompacted
  // and unedited inside this watch window; otherwise fall back to `conversation.context()`.
  if (view.before !== undefined || headIdx !== -1) return undefined;
  let tokens = 0;
  for (const entry of entries) {
    if (entry.edits && entry.edits.length > 0) return undefined;
    for (const msg of entry.model ?? []) {
      if (msg.role === "assistant" && EXCLUDED_STOP_REASONS.has(msg.stopReason)) continue;
      tokens += estimateMessageTokens(msg);
    }
  }
  return { tokens, source: "estimate" };
}

function isCutCandidate(contributions: readonly (readonly Message[])[], index: number): boolean {
  const first = contributions[index]?.[0];
  if (first?.role === "assistant") return true;
  if (first?.role !== "user") return false;
  let calls = new Set<string>();
  for (let before = index - 1; before >= 0; before -= 1) {
    const list = contributions[before] ?? [];
    let assistant: AssistantMessage | undefined;
    for (let j = list.length - 1; j >= 0; j -= 1) {
      const msg = list[j]!;
      if (msg.role === "assistant") {
        assistant = msg;
        break;
      }
    }
    if (!assistant) continue;
    calls = new Set(assistant.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])));
    break;
  }
  if (calls.size === 0) return true;
  for (let after = index; after < contributions.length; after += 1) {
    const list = contributions[after] ?? [];
    for (let pos = 0; pos < list.length; pos += 1) {
      const msg = list[pos]!;
      if (msg.role === "assistant" && (after > index || pos > 0)) return true;
      if (msg.role === "toolResult" && calls.has(msg.toolCallId)) return false;
    }
  }
  return true;
}

/**
 * Pure public-API check mirroring `pi-durable`'s safe compaction cut selection so callers can
 * verify cut availability and dropped token volume without reaching into internal SDK exports.
 */
export function analyzeCompactablePrefix(
  view: ContextView,
  keepRecentTokens: number,
): CompactablePrefixAnalysis {
  const { contributions } = view;
  const start = view.head === undefined ? 0 : 1;
  const candidates: number[] = [];
  for (let index = start; index < contributions.length; index += 1) {
    if (isCutCandidate(contributions, index)) candidates.push(index);
  }
  let kept = 0;
  let cut: number | undefined;
  for (let index = contributions.length - 1; index >= start; index -= 1) {
    for (const msg of contributions[index] ?? []) {
      kept += estimateMessageTokens(msg);
    }
    if (kept < keepRecentTokens) continue;
    cut = candidates.find((candidate) => candidate >= index) ?? candidates.at(-1);
    break;
  }
  if (cut === undefined) return { canCompact: false, droppedTokens: 0 };
  let droppedTokens = 0;
  let hasContent = false;
  for (let index = start; index < cut; index += 1) {
    const list = contributions[index] ?? [];
    if (list.length > 0) hasContent = true;
    for (const msg of list) droppedTokens += estimateMessageTokens(msg);
  }
  return hasContent ? { canCompact: true, cutIndex: cut, droppedTokens } : { canCompact: false, droppedTokens: 0 };
}

interface ContextCacheEntry {
  cacheKey: string;
  estimate: EstimatedContextTokens;
}

interface DeclineDiagnostic {
  reason: CompactionDeclineReason;
  at: number;
  headIdAtDecline: number;
}

interface EarlyCompactCircuitState {
  tailEntryId: number;
  count: number;
  windowStartedAt: number;
  lastSeenFailureKey?: string;
}

export const EARLY_COMPACT_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
export const EARLY_COMPACT_CIRCUIT_MAX_FAILURES = 2;

interface StoredAgentDocLike {
  model?: { provider?: string; modelId?: string };
  compaction?: CompactionConfig & { modelOverrides?: Record<string, CompactionConfig> };
}

export interface HubContextGuardDeps {
  harness: Harness;
  models: Models;
  settingsStore: LiveSettingsStore;
  runtimeGates: Pick<HubRuntimeGates, "isClosed" | "isHandoverBarrierActive"> & {
    isRecovering?: () => boolean;
  };
  onContextUpdated?: (conversationId: number) => void;
  isArchivingRoot?: () => boolean;
  softTriggerCeiling?: () => number;
  hardCeilingTokens?: () => number;
  now?: () => number;
}

export class HubContextGuard {
  readonly #deps: HubContextGuardDeps;
  readonly #cache = new Map<number, ContextCacheEntry>();
  readonly #inFlightEstimate = new Map<number, { cacheKey: string; promise: Promise<void> }>();
  readonly #declines = new Map<number, DeclineDiagnostic>();
  readonly #pendingCompacts = new Map<number, Promise<TopicCompactResult>>();
  readonly #circuit = new Map<number, EarlyCompactCircuitState>();
  readonly #lastTailIds = new Map<number, number>();
  readonly #lastHeadIds = new Map<number, number>();

  constructor(deps: HubContextGuardDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  recordCompactionDeclined(conversationId: number, reason: CompactionDeclineReason): void {
    const currentHead = this.#lastKnownHeadId(conversationId);
    const tailId = this.#lastTailIds.get(conversationId) ?? 0;
    this.#declines.set(conversationId, {
      reason,
      at: this.#now(),
      headIdAtDecline: currentHead,
    });
    this.#recordCircuitFailure(conversationId, tailId);
    this.#deps.onContextUpdated?.(conversationId);
  }

  isEarlyCompactionCircuitOpen(conversationId: number, tailEntryId: number, now = this.#now()): boolean {
    const entry = this.#circuit.get(conversationId);
    if (!entry) return false;
    if (entry.tailEntryId !== tailEntryId) return false;
    if (now - entry.windowStartedAt >= EARLY_COMPACT_CIRCUIT_WINDOW_MS) return false;
    return entry.count >= EARLY_COMPACT_CIRCUIT_MAX_FAILURES;
  }

  #recordCircuitFailure(conversationId: number, tailEntryId: number, failureKey?: string): void {
    const now = this.#now();
    const prev = this.#circuit.get(conversationId);
    if (
      prev &&
      prev.tailEntryId === tailEntryId &&
      now - prev.windowStartedAt < EARLY_COMPACT_CIRCUIT_WINDOW_MS
    ) {
      if (failureKey && prev.lastSeenFailureKey === failureKey) return;
      prev.count += 1;
      if (failureKey) prev.lastSeenFailureKey = failureKey;
      return;
    }
    this.#circuit.set(conversationId, {
      tailEntryId,
      count: 1,
      windowStartedAt: now,
      ...(failureKey ? { lastSeenFailureKey: failureKey } : {}),
    });
  }

  invalidateConversation(conversationId: number): void {
    this.#cache.delete(conversationId);
  }

  invalidateAll(): void {
    this.#cache.clear();
  }

  projectLiveContext(
    view: ConversationView,
    conversationId: number,
    conversation?: Conversation,
  ): LiveContextState {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const agentDoc = view.docs["pi.agent"] as StoredAgentDocLike | undefined;
    const { modelKey, contextWindow, compaction } = this.#resolveEffectiveModelAndCompaction(agentDoc);
    const softCeiling = this.#deps.softTriggerCeiling?.() ?? DEFAULT_SOFT_BACKGROUND_TRIGGER_TOKENS;
    const thresholds = computeContextThresholds(compaction, contextWindow, softCeiling);

    const latestCompactionId = this.#latestCompactionEntryId(view.entries);
    const prevHeadId = this.#lastHeadIds.get(conversationId) ?? 0;
    if (latestCompactionId > prevHeadId) {
      this.#lastHeadIds.set(conversationId, latestCompactionId);
      this.#circuit.delete(conversationId);
    }
    const existingDecline = this.#declines.get(conversationId);
    if (existingDecline && latestCompactionId > existingDecline.headIdAtDecline) {
      this.#declines.delete(conversationId);
    }

    const tailId = view.entries.length > 0 ? Number(view.entries.at(-1)!.id) : 0;
    this.#lastTailIds.set(conversationId, tailId);
    if (live?.compactionFailure?.error) {
      this.#recordCircuitFailure(conversationId, tailId, `${tailId}|${live.compactionFailure.error}`);
    }

    const cacheKey = `${conversationId}|${modelKey}|${latestCompactionId}|${tailId}|${view.before !== undefined ? 1 : 0}`;
    let estimate = this.#cache.get(conversationId)?.cacheKey === cacheKey
      ? this.#cache.get(conversationId)!.estimate
      : undefined;

    if (!estimate) {
      const fast = estimateContextFromWatchView(view);
      if (fast) {
        estimate = fast;
        this.#cache.set(conversationId, { cacheKey, estimate });
      } else if (conversation && !this.#deps.runtimeGates.isClosed()) {
        this.#scheduleAsyncEstimate(conversationId, conversation, cacheKey);
      }
    }

    const activeDecline = this.#declines.get(conversationId);
    const compactionError =
      live?.compactionFailure?.error ??
      (activeDecline ? DECLINE_ERROR_MESSAGE : undefined);

    return {
      ...(estimate ? { tokens: estimate.tokens, source: estimate.source } : {}),
      window: thresholds.window,
      softLimit: thresholds.softLimit,
      warnLimit: thresholds.warnLimit,
      ...(live?.compactions && live.compactions.length > 0 ? { compacting: true } : {}),
      ...(compactionError ? { compactionError } : {}),
    };
  }

  /**
   * 200k early async compaction guard (never blocks foreground message submission).
   * Fires when a chat topic transitions from busy -> idle above the hard ceiling and is
   * not already compacting or circuit-broken (>= 2 failures/declines on the same tail in 10 min).
   */
  async maybeTriggerEarlyCompaction(
    topicId: string,
    conversationId: number,
    liveContext: LiveContextState | undefined,
    watchValue: ConversationView,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TopicCompactResult | undefined> {
    if (
      this.#deps.runtimeGates.isClosed() ||
      this.#deps.runtimeGates.isHandoverBarrierActive() ||
      this.#deps.runtimeGates.isRecovering?.()
    ) {
      return undefined;
    }
    if (!this.#deps.settingsStore.getCompactionConfig().enabled) return undefined;
    const ceiling = this.#deps.hardCeilingTokens?.() ?? HARD_CONTEXT_GUARD_CEILING_TOKENS;
    if (liveContext?.tokens === undefined || liveContext.tokens < ceiling) return undefined;

    const live = watchValue.docs["pi.live"] as LiveState | undefined;
    if (live?.run !== undefined || (live?.compactions && live.compactions.length > 0)) return undefined;
    if (this.#pendingCompacts.has(conversationId)) return undefined;

    const tailId = watchValue.entries.length > 0 ? Number(watchValue.entries.at(-1)!.id) : 0;
    if (this.isEarlyCompactionCircuitOpen(conversationId, tailId)) return undefined;

    try {
      const result = await this.compactTopic(topicId, context);
      if (!result.compacted) {
        this.#recordCircuitFailure(conversationId, tailId);
      }
      return result;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: number }).status
        : undefined;
      if (status !== 409 && status !== 503 && status !== 404) {
        this.#recordCircuitFailure(conversationId, tailId);
      }
      return undefined;
    }
  }

  /** Atomic per-conversation compaction helper shared by manual, early-guard, and idle compaction. */
  isCompacting(conversationId: number): boolean {
    return this.#pendingCompacts.has(conversationId);
  }

  async compactConversationAtomic(
    conversationId: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<TopicCompactResult> {
    if (this.#deps.runtimeGates.isClosed()) {
      throw new ProjectError(503, "hub_closed", "服务正在关闭，暂无法整理上下文。");
    }
    if (this.#deps.runtimeGates.isHandoverBarrierActive()) {
      throw new ProjectError(503, "cluster_handover_in_progress", "正在进行主备交接，请稍后再试。");
    }
    const inflight = this.#pendingCompacts.get(conversationId);
    if (inflight) return inflight;

    const run = this.#compactConversation(conversationId as ConversationId, context).finally(() => {
      if (this.#pendingCompacts.get(conversationId) === run) {
        this.#pendingCompacts.delete(conversationId);
      }
    });
    this.#pendingCompacts.set(conversationId, run);
    return run;
  }

  async compactTopic(topicId: string, context: Context = BACKGROUND_CONTEXT): Promise<TopicCompactResult> {
    if (this.#deps.runtimeGates.isClosed()) {
      throw new ProjectError(503, "hub_closed", "服务正在关闭，暂无法整理上下文。");
    }
    if (this.#deps.runtimeGates.isHandoverBarrierActive()) {
      throw new ProjectError(503, "cluster_handover_in_progress", "正在进行主备交接，请稍后再试。");
    }
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const topic = state?.topics && Object.hasOwn(state.topics, topicId) ? state.topics[topicId] : undefined;
    if (topic?.deletedAt) throw new ProjectError(404, "topic_deleted", "会话已删除。");
    if (!topic) throw new ProjectError(404, "topic_not_found", "会话不存在。");
    if (topic.archived) throw new ProjectError(409, "topic_archived", "会话已归档，请还原后再整理上下文。");
    if (topicId === "root" && this.#deps.isArchivingRoot?.()) {
      throw new ProjectError(409, "main_archive_in_progress", "主对话正在归档中，请稍候。");
    }

    return this.compactConversationAtomic(topic.conversationId, context);
  }

  async #compactConversation(conversationId: ConversationId, context: Context): Promise<TopicCompactResult> {
    const conversation = await this.#deps.harness.conversation(conversationId, context);
    if (!conversation) throw new ProjectError(404, "conversation_missing", "会话引用的对话记录不存在。");

    const live = await this.#deps.harness.snapshot(LiveDoc, conversationId, context);
    if (live?.run !== undefined) {
      throw new ProjectError(409, "topic_busy", "当前会话正在生成回复，请等待本轮结束后再整理。");
    }
    if (live?.compactions && live.compactions.length > 0) {
      throw new ProjectError(409, "compaction_in_progress", "上下文正在整理中，请稍候。");
    }

    const [agent, ctxView] = await Promise.all([
      conversation.agent(context),
      conversation.context(context),
    ]);
    const { contextWindow, compaction } = this.#resolveEffectiveModelAndCompaction({
      model: agent.model,
      compaction: agent.compaction as StoredAgentDocLike["compaction"],
    });
    const softCeiling = this.#deps.softTriggerCeiling?.() ?? DEFAULT_SOFT_BACKGROUND_TRIGGER_TOKENS;
    const thresholds = computeContextThresholds(compaction, contextWindow, softCeiling);
    const cut = analyzeCompactablePrefix(ctxView, thresholds.keepRecentTokens);
    if (!cut.canCompact) {
      return { compacted: false, reason: "nothing_to_compact" };
    }

    this.#declines.delete(Number(conversationId));
    const taskId = await conversation.compact(undefined, context);
    this.#cache.delete(Number(conversationId));
    return { compacted: true, taskId: Number(taskId) };
  }

  #resolveEffectiveModelAndCompaction(agentDoc?: StoredAgentDocLike): {
    modelKey: string;
    contextWindow: number;
    compaction: CompactionConfig;
  } {
    const liveModel = this.#deps.settingsStore.getModel();
    const provider = agentDoc?.model?.provider || liveModel.defaultProvider || "";
    const modelId = agentDoc?.model?.modelId || liveModel.defaultModel || "";
    const modelKey = `${provider}/${modelId}`;
    const registered = provider && modelId ? this.#deps.models.getModel(provider, modelId) : undefined;
    const contextWindow =
      registered?.contextWindow && registered.contextWindow > 0
        ? registered.contextWindow
        : liveModel.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const baseCompaction = this.#deps.settingsStore.getCompactionConfig();
    const convOverride = agentDoc?.compaction?.modelOverrides?.[modelKey] ?? agentDoc?.compaction;
    const compaction: CompactionConfig = convOverride
      ? {
          enabled: convOverride.enabled ?? baseCompaction.enabled,
          reserveTokens: convOverride.reserveTokens ?? baseCompaction.reserveTokens,
          keepRecentTokens: convOverride.keepRecentTokens ?? baseCompaction.keepRecentTokens,
          backgroundTokens: convOverride.backgroundTokens ?? baseCompaction.backgroundTokens,
        }
      : baseCompaction;
    return { modelKey, contextWindow, compaction };
  }

  #latestCompactionEntryId(entries: readonly EntryRecord[]): number {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (CompactionEntry.is(entry) || entry.head !== undefined) return Number(entry.id);
    }
    return 0;
  }

  #lastKnownHeadId(conversationId: number): number {
    const cachedKey = this.#cache.get(conversationId)?.cacheKey;
    if (!cachedKey) return 0;
    const parts = cachedKey.split("|");
    const parsed = Number(parts[2]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  #scheduleAsyncEstimate(conversationId: number, conversation: Conversation, cacheKey: string): void {
    const current = this.#inFlightEstimate.get(conversationId);
    if (current?.cacheKey === cacheKey) return;
    let run!: Promise<void>;
    run = (async () => {
      try {
        const ctxView = await conversation.context(BACKGROUND_CONTEXT);
        if (this.#deps.runtimeGates.isClosed()) return;
        const estimate = estimateActiveContextFromContextView(ctxView);
        this.#cache.set(conversationId, { cacheKey, estimate });
        this.#deps.onContextUpdated?.(conversationId);
      } catch {
        // Leave `tokens` omitted so UI falls back to "unknown" without crashing watch updates.
      } finally {
        if (this.#inFlightEstimate.get(conversationId)?.promise === run) {
          this.#inFlightEstimate.delete(conversationId);
        }
      }
    })();
    this.#inFlightEstimate.set(conversationId, { cacheKey, promise: run });
  }
}
