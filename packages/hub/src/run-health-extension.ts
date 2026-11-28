import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
  AgentDoc, AssistantEntry, GenerationTask, LiveDoc, ToolResultEntry, ToolTask,
  defineDoc, defineExtension, hook,
  type ConversationId, type EntryId, type EntryRecord, type Harness, type HookApi, type JsonObject, type ModelRef,
} from "@earendil-works/pi-durable";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-doc.js";
import { KuloStateDoc, isOrchestratorConversation, resolveTicketExecutionScope } from "./state.js";
import { sanitizeTicketQuotaText } from "./ticket-quota-pause.js";
import { evaluateRunHealthWithJudge, RUN_HEALTH_JUDGE_TIMEOUT_MS, type RunHealthJudgeInput } from "./run-health-judge.js";
import {
  buildBeforeToolBlockMessage, buildDeterministicWarningGuidance, buildJudgeGuidance,
  buildJudgeTrajectorySummary, buildJudgeTrajectoryTurn, buildSoftHandoffGuidance, buildWrapUpGuidance,
  createEmptyDoomLoopState, evaluateDoomLoopRound, isTerminatingToolRound,
  JUDGE_GOAL_MAX_CHARS, JUDGE_RECENT_TURNS_WINDOW, resolveRoleTurnBudget,
  type DoomLoopTrackerState, type JudgeTrajectoryTurn, type ObservedToolCallOutcome,
  type RunHealthJudgeVerdict, type RunHealthRole, type RunHealthWrapUpSource,
} from "./run-health-policy.js";

export interface RunHealthDocState {
  runFirstEntryId?: number;
  lastInputCount?: number;
  turnsAtLastUserInput?: number;
  softReminded?: boolean;
  dispatchedInRun?: boolean;
  wrapUpDispatched?: boolean;
  judgedTurns?: number[];
  pendingGuidance?: {
    source: "doom_loop" | "judge";
    turn: number;
    text: string;
    deliveredAtTurn?: number;
  };
  forceWrapUp?: {
    source: RunHealthWrapUpSource;
    reason: string;
    setAtTurn: number;
  };
}

/**
 * Lightweight per-conversation latest-only document persisting run-scoped health verdicts
 * and wrap-up state across Hub restarts (keyed and reset by `live.run.first`).
 */
export const RunHealthDoc = defineDoc<RunHealthDocState & JsonObject>({
  kind: "kulo.run-health",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}) as RunHealthDocState & JsonObject,
  checkpointWhen: () => true,
});

export interface RunHealthExtensionOptions {
  getHarness: () => Harness | undefined;
  getModels?: () => Models;
  resolveFallbackModel?: () => ModelRef | undefined;
  redact: (text: string) => string;
  judgeTimeoutMs?: number;
  /** Optional custom judge evaluator (primarily for deterministic testing). */
  evaluateJudge?: (input: RunHealthJudgeInput) => Promise<RunHealthJudgeVerdict | null>;
  /** Optional role resolver override (primarily for standalone Harness unit tests). */
  resolveRole?: (conversationId: ConversationId, context: Context) => Promise<RunHealthRole | undefined> | RunHealthRole | undefined;
  onWarning?: (message: string) => void;
}

export interface RunHealthController {
  readonly extension: ReturnType<typeof defineExtension>;
  close(): void;
  /** Resolves once all currently in-flight background judge tasks have settled. */
  waitForPendingJudges(): Promise<void>;
}

interface RunHealthMemoryCache {
  runFirstEntryId: number;
  lastInputCount: number;
  turnsAtLastUserInput: number;
  lastProcessedAssistantId: number;
  doomLoop: DoomLoopTrackerState;
  trajectoryTurns: JudgeTrajectoryTurn[];
  userGoal: string;
  inFlightJudgeTurns: Set<number>;
  wrapUpDispatchClaimedCallId?: string;
}

const EXCLUDED_USER_ENTRY_KINDS = new Set([
  "pi.compaction",
  "pi.reset",
  "kulo.recent_work_update",
  "kulo.memory_context",
  "kulo.memory_context_revocation",
]);

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n");
}

function extractUserGoalTextFromEntry(entry: EntryRecord): string | undefined {
  if (EXCLUDED_USER_ENTRY_KINDS.has(entry.kind)) return undefined;
  const first = entry.model?.[0];
  if (!first || first.role !== "user") return undefined;
  const text = extractTextFromContent(first.content).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, JUDGE_GOAL_MAX_CHARS) : undefined;
}

function extractOutcomesForAssistantRound(
  assistantEntry: EntryRecord,
  resultEntries: readonly EntryRecord[],
): ObservedToolCallOutcome[] {
  const assistantMsg = assistantEntry.model?.[0];
  if (!assistantMsg || assistantMsg.role !== "assistant" || !Array.isArray(assistantMsg.content)) return [];
  const calls = assistantMsg.content.filter(
    (part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall",
  );
  if (calls.length === 0) return [];

  const resultByCallId = new Map<string, EntryRecord>();
  for (const entry of resultEntries) {
    const msg = entry.model?.[0];
    if (msg && msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      resultByCallId.set(msg.toolCallId, entry);
    }
  }

  return calls.map((call) => {
    const resEntry = resultByCallId.get(call.id);
    const resMsg = resEntry?.model?.[0];
    const isToolResult = resMsg?.role === "toolResult";
    const textParts =
      isToolResult && Array.isArray(resMsg.content)
        ? resMsg.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
        : [];
    const outputText = textParts[0];
    const extraOutputTexts = textParts.length > 1 ? textParts.slice(1) : undefined;
    const isError = isToolResult ? Boolean(resMsg.isError) : false;
    const diagnostics =
      resEntry?.data && typeof resEntry.data === "object" && !Array.isArray(resEntry.data)
        ? (resEntry.data as { diagnostics?: Array<{ code?: string; message?: string; severity?: string }> }).diagnostics
        : undefined;
    const errorDiag = diagnostics?.find((d) => d.severity === "error") ?? diagnostics?.[0];
    const errorCode = isError ? errorDiag?.code : undefined;
    const errorText = isError
      ? [errorDiag?.message, outputText].filter((s): s is string => Boolean(s && s.trim())).join(" ")
      : undefined;
    const rawDuration =
      resEntry && typeof (resEntry as { durationMs?: unknown }).durationMs === "number"
        ? (resEntry as { durationMs?: number }).durationMs
        : undefined;

    return {
      name: call.name,
      arguments: call.arguments,
      isError,
      ...(errorCode ? { errorCode } : {}),
      ...(errorText ? { errorText } : {}),
      ...(outputText !== undefined ? { outputText } : {}),
      ...(extraOutputTexts ? { extraOutputTexts } : {}),
      ...(rawDuration !== undefined ? { durationMs: rawDuration } : {}),
    };
  });
}

function appendGuidanceToLastMessage(messages: readonly Message[], guidanceText: string): readonly Message[] {
  let targetIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i]?.role;
    if (role === "user" || role === "toolResult") { targetIdx = i; break; }
  }
  if (targetIdx < 0) return messages;

  const target = messages[targetIdx]!;
  let updated: Message;
  if (target.role === "user") {
    updated = typeof target.content === "string"
      ? { ...target, content: target.content ? `${target.content}\n\n${guidanceText}` : guidanceText }
      : { ...target, content: [...target.content, { type: "text", text: `\n\n${guidanceText}` }] };
  } else if (target.role === "toolResult") {
    updated = { ...target, content: [...target.content, { type: "text", text: `\n\n${guidanceText}` }] };
  } else {
    return messages;
  }

  const next = [...messages];
  next[targetIdx] = updated;
  return next;
}

function normalizeDocForRun(
  raw: Readonly<RunHealthDocState> | undefined,
  runFirstEntryId: number,
  inputCount: number,
  turns: number,
): { state: RunHealthDocState; changed: boolean; steered: boolean; resetRun: boolean } {
  if (!raw || raw.runFirstEntryId !== runFirstEntryId) {
    return {
      state: {
        runFirstEntryId, lastInputCount: inputCount, turnsAtLastUserInput: 0,
        softReminded: false, dispatchedInRun: false, wrapUpDispatched: false, judgedTurns: [],
      },
      changed: true, steered: false, resetRun: true,
    };
  }
  const prevInputs = raw.lastInputCount ?? inputCount;
  if (inputCount > prevInputs) {
    // Mid-run user steer: reset doom-loop/stuck state and shift turn budget baseline.
    return {
      state: {
        runFirstEntryId, lastInputCount: inputCount, turnsAtLastUserInput: turns,
        softReminded: false, dispatchedInRun: Boolean(raw.dispatchedInRun),
        wrapUpDispatched: Boolean(raw.wrapUpDispatched), judgedTurns: [...(raw.judgedTurns ?? [])],
      },
      changed: true, steered: true, resetRun: false,
    };
  }
  return {
    state: {
      runFirstEntryId, lastInputCount: prevInputs, turnsAtLastUserInput: raw.turnsAtLastUserInput ?? 0,
      softReminded: Boolean(raw.softReminded), dispatchedInRun: Boolean(raw.dispatchedInRun),
      wrapUpDispatched: Boolean(raw.wrapUpDispatched), judgedTurns: [...(raw.judgedTurns ?? [])],
      ...(raw.pendingGuidance ? { pendingGuidance: { ...raw.pendingGuidance } } : {}),
      ...(raw.forceWrapUp ? { forceWrapUp: { ...raw.forceWrapUp } } : {}),
    },
    changed: false, steered: false, resetRun: false,
  };
}

function assignDocState(target: RunHealthDocState, next: RunHealthDocState): void {
  target.runFirstEntryId = next.runFirstEntryId;
  target.lastInputCount = next.lastInputCount;
  target.turnsAtLastUserInput = next.turnsAtLastUserInput;
  target.softReminded = next.softReminded;
  target.dispatchedInRun = next.dispatchedInRun;
  target.wrapUpDispatched = next.wrapUpDispatched;
  target.judgedTurns = next.judgedTurns ? [...next.judgedTurns] : [];
  if (next.pendingGuidance) target.pendingGuidance = { ...next.pendingGuidance };
  else delete target.pendingGuidance;
  if (next.forceWrapUp) target.forceWrapUp = { ...next.forceWrapUp };
  else delete target.forceWrapUp;
}

async function resolveConversationRole(
  options: RunHealthExtensionOptions,
  api: HookApi,
  context: Context,
): Promise<RunHealthRole | undefined> {
  if (options.resolveRole) return options.resolveRole(api.conversationId, context);
  const [state, settingsDoc] = await Promise.all([
    api.snapshot(KuloStateDoc, context),
    api.snapshot(SettingsAssistantDoc, context),
  ]);
  if (isActiveSettingsConversation(api.conversationId, settingsDoc)) return undefined;
  const scope = resolveTicketExecutionScope(state, api.conversationId);
  if (scope) return scope.isSubagent ? "subagent" : "worker";
  return isOrchestratorConversation(api.conversationId, state) ? "orchestrator" : undefined;
}

async function loadRunEntriesAscending(api: HookApi, minEntryId: number, context: Context): Promise<EntryRecord[]> {
  const items: EntryRecord[] = [];
  let cursor = undefined;
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    const page = await api.entries({ order: "ascending", minEntryId: minEntryId as EntryId }, 150, cursor, context);
    items.push(...page.items);
    if (!page.next || items.length >= 600) break;
    cursor = page.next;
  }
  return items;
}

async function rebuildMemoryCacheFromEntries(
  api: HookApi,
  runFirstEntryId: number,
  inputCount: number,
  turnsAtLastUserInput: number,
  context: Context,
  excludeAssistantId?: number,
): Promise<RunHealthMemoryCache> {
  const entries = await loadRunEntriesAscending(api, runFirstEntryId, context);
  let userGoal = "";
  let lastUserEntryIdx = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (excludeAssistantId !== undefined && Number(entry.id) >= excludeAssistantId) break;
    const text = extractUserGoalTextFromEntry(entry);
    if (text) { userGoal = text; lastUserEntryIdx = i; }
  }

  let doomLoop = createEmptyDoomLoopState();
  const trajectoryTurns: JudgeTrajectoryTurn[] = [];
  let lastProcessedAssistantId = 0;
  let roundCounter = 0;

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (excludeAssistantId !== undefined && Number(entry.id) >= excludeAssistantId) break;
    const assistantMsg = entry.kind === AssistantEntry.kind ? entry.model?.[0] : undefined;
    const hasToolCalls =
      assistantMsg?.role === "assistant" &&
      Array.isArray(assistantMsg.content) &&
      assistantMsg.content.some((part) => part.type === "toolCall");
    if (!hasToolCalls) { i += 1; continue; }

    const resultEntries: EntryRecord[] = [];
    let j = i + 1;
    while (j < entries.length && entries[j]!.kind === ToolResultEntry.kind) {
      resultEntries.push(entries[j]!);
      j += 1;
    }

    roundCounter += 1;
    const outcomes = extractOutcomesForAssistantRound(entry, resultEntries);
    if (outcomes.length > 0) {
      trajectoryTurns.push(buildJudgeTrajectoryTurn(roundCounter, outcomes));
      if (i > lastUserEntryIdx) {
        doomLoop = evaluateDoomLoopRound(doomLoop, outcomes).state;
      } else if (outcomes.some((o) => o.name === "kulo_dispatch" && !o.isError)) {
        doomLoop.dispatchedInRun = true;
      }
    }
    lastProcessedAssistantId = Number(entry.id);
    i = j;
  }

  return {
    runFirstEntryId, lastInputCount: inputCount, turnsAtLastUserInput, lastProcessedAssistantId,
    doomLoop, trajectoryTurns: trajectoryTurns.slice(-JUDGE_RECENT_TURNS_WINDOW),
    userGoal, inFlightJudgeTurns: new Set<number>(),
  };
}

export function createRunHealthController(options: RunHealthExtensionOptions): RunHealthController {
  const shutdownController = new AbortController();
  const caches = new Map<number, RunHealthMemoryCache>();
  const pendingJudges = new Set<Promise<void>>();
  const judgeFn = options.evaluateJudge ?? evaluateRunHealthWithJudge;

  const commitDocUpdate = async (
    conversationId: ConversationId,
    updater: (txDoc: RunHealthDocState, liveRun: { first?: EntryId; inputs: unknown[]; turns: number } | undefined) => boolean,
    context: Context = BACKGROUND_CONTEXT,
    workerStuck?: { kind: "doom_loop" | "judge_stuck"; reason: string },
  ): Promise<void> => {
    const harness = options.getHarness();
    if (!harness || shutdownController.signal.aborted) return;
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversationId);
      const doc = await tx.doc(RunHealthDoc, conversationId);
      const applied = updater(doc as RunHealthDocState, live.run);
      if (applied && workerStuck) {
        const kuloState = await tx.doc(KuloStateDoc);
        const scope = resolveTicketExecutionScope(kuloState, conversationId);
        if (scope && !scope.isSubagent && scope.ticket.status !== "stopped" && scope.ticket.status !== "closed") {
          const now = Date.now();
          scope.ticket.runHealthStuck = {
            kind: workerStuck.kind,
            reason: sanitizeTicketQuotaText(workerStuck.reason, options.redact) || "检测到任务执行停滞",
            at: now,
          };
          scope.ticket.updatedAt = now;
        }
      }
    }, context);
  };

  const resetCacheForSteer = (cache: RunHealthMemoryCache, inputCount: number, turns: number) => {
    cache.lastInputCount = inputCount;
    cache.turnsAtLastUserInput = turns;
    cache.doomLoop = { ...createEmptyDoomLoopState(), dispatchedInRun: cache.doomLoop.dispatchedInRun };
    cache.inFlightJudgeTurns.clear();
  };

  const setCache = (convNum: number, cache: RunHealthMemoryCache) => {
    if (caches.size >= 256 && !caches.has(convNum)) {
      const oldestKey = caches.keys().next().value;
      if (oldestKey !== undefined) caches.delete(oldestKey);
    }
    caches.set(convNum, cache);
  };

  const extension = defineExtension({
    name: "kulo-run-health",
    hooks: [
      hook(GenerationTask, {
        afterTools: async (assistant, results, api, context) => {
          if (shutdownController.signal.aborted || context.abortSignal?.aborted) return;
          const role = await resolveConversationRole(options, api, context);
          if (!role) return;

          const [live, agentDoc, storedDoc] = await Promise.all([
            api.snapshot(LiveDoc, api.conversationId, context),
            api.snapshot(AgentDoc, api.conversationId, context),
            api.snapshot(RunHealthDoc, api.conversationId, context),
          ]);
          const run = live?.run;
          if (!run) return;

          const convNum = Number(api.conversationId);
          const runFirstEntryId = Number(run.first ?? assistant);
          const turns = run.turns;
          const inputCount = run.inputs.length;
          const budget = resolveRoleTurnBudget(role, agentDoc?.maxTurns);

          const normalized = normalizeDocForRun(storedDoc, runFirstEntryId, inputCount, turns);
          const nextDoc = normalized.state;
          let docDirty = normalized.changed;

          let cache = caches.get(convNum);
          if (normalized.resetRun || !cache || cache.runFirstEntryId !== runFirstEntryId) {
            cache = await rebuildMemoryCacheFromEntries(
              api, runFirstEntryId, inputCount, nextDoc.turnsAtLastUserInput ?? 0, context, Number(assistant),
            );
            setCache(convNum, cache);
          } else if (normalized.steered || inputCount > cache.lastInputCount) {
            resetCacheForSteer(cache, inputCount, nextDoc.turnsAtLastUserInput ?? turns);
            const recentPage = await api.entries({ order: "descending", minEntryId: runFirstEntryId as EntryId }, 12, undefined, context);
            for (const entry of recentPage.items) {
              const goal = extractUserGoalTextFromEntry(entry);
              if (goal) { cache.userGoal = goal; break; }
            }
          }

          const [assistantEntry, ...resultEntries] = await Promise.all([
            api.entry(assistant, context),
            ...results.map((id) => api.entry(id, context)),
          ]);
          const validResults = resultEntries.filter((e): e is EntryRecord => e !== undefined);
          const outcomes = assistantEntry ? extractOutcomesForAssistantRound(assistantEntry, validResults) : [];
          const toolNames = outcomes.map((o) => o.name);

          let evalAction: "none" | "warn" | "brake" = "none";
          let evalWarning: ReturnType<typeof evaluateDoomLoopRound>["warning"];
          let evalBrakeReason: string | undefined;

          if (outcomes.length > 0 && Number(assistant) > cache.lastProcessedAssistantId) {
            const evaluation = evaluateDoomLoopRound(cache.doomLoop, outcomes);
            cache.doomLoop = evaluation.state;
            cache.lastProcessedAssistantId = Number(assistant);
            cache.trajectoryTurns.push(buildJudgeTrajectoryTurn(turns, outcomes));
            if (cache.trajectoryTurns.length > JUDGE_RECENT_TURNS_WINDOW) {
              cache.trajectoryTurns.splice(0, cache.trajectoryTurns.length - JUDGE_RECENT_TURNS_WINDOW);
            }
            evalAction = evaluation.action;
            evalWarning = evaluation.warning;
            evalBrakeReason = evaluation.brakeReason;
          }

          if (cache.doomLoop.dispatchedInRun && !nextDoc.dispatchedInRun) {
            nextDoc.dispatchedInRun = true;
            docDirty = true;
          }
          if (
            role === "orchestrator" &&
            (Boolean(nextDoc.forceWrapUp) || turns >= budget.wrapUpTurn) &&
            outcomes.some((o) => o.name === "kulo_dispatch") &&
            !nextDoc.wrapUpDispatched
          ) {
            nextDoc.wrapUpDispatched = true;
            docDirty = true;
          }

          let workerStuckUpdate: { kind: "doom_loop" | "judge_stuck"; reason: string } | undefined;
          if (evalAction === "brake" && evalBrakeReason) {
            if (!nextDoc.forceWrapUp || nextDoc.forceWrapUp.source === "turn_limit") {
              nextDoc.forceWrapUp = { source: "doom_loop", reason: evalBrakeReason, setAtTurn: turns };
              delete nextDoc.pendingGuidance;
              docDirty = true;
            }
            if (role === "worker") {
              workerStuckUpdate = { kind: "doom_loop", reason: evalBrakeReason };
            }
          } else if (evalAction === "warn" && evalWarning && !nextDoc.forceWrapUp) {
            nextDoc.pendingGuidance = {
              source: "doom_loop", turn: turns, text: buildDeterministicWarningGuidance(role, evalWarning),
            };
            docDirty = true;
            if (role === "worker") {
              workerStuckUpdate = { kind: "doom_loop", reason: evalWarning.detail };
            }
          } else if (
            nextDoc.pendingGuidance &&
            (nextDoc.pendingGuidance.source === "doom_loop" ||
              (nextDoc.pendingGuidance.deliveredAtTurn !== undefined && turns > nextDoc.pendingGuidance.deliveredAtTurn))
          ) {
            delete nextDoc.pendingGuidance;
            docDirty = true;
          }

          if (docDirty || workerStuckUpdate) {
            await commitDocUpdate(
              api.conversationId,
              (txDoc, liveRun) => {
                if (!liveRun || Number(liveRun.first ?? assistant) !== runFirstEntryId) return false;
                assignDocState(txDoc, nextDoc);
                return true;
              },
              context,
              workerStuckUpdate,
            ).catch(() => {});
          }

          // Layer 2: Fire-and-forget asynchronous health judge (NEVER awaited in afterTools).
          const effectiveTurns = Math.max(0, turns - (nextDoc.turnsAtLastUserInput ?? 0));
          const alreadyJudged = (nextDoc.judgedTurns ?? []).includes(turns) || cache.inFlightJudgeTurns.has(turns);
          const shouldLaunchJudge =
            Boolean(budget.healthCheckInterval) &&
            effectiveTurns > 0 &&
            effectiveTurns % budget.healthCheckInterval! === 0 &&
            !isTerminatingToolRound(toolNames) &&
            turns < budget.wrapUpTurn &&
            !nextDoc.forceWrapUp &&
            !alreadyJudged &&
            !shutdownController.signal.aborted;
          if (!shouldLaunchJudge) return;

          const modelRef = agentDoc?.model ?? options.resolveFallbackModel?.();
          if (!modelRef) return;

          const models = options.getModels?.() ?? api.models;
          const trajectory = buildJudgeTrajectorySummary({
            role, turnsUsed: turns, effectiveTurnsSinceInput: effectiveTurns, maxTurns: budget.maxTurns,
            userGoal: cache.userGoal, recentTurns: cache.trajectoryTurns, doomLoop: cache.doomLoop,
          });

          cache.inFlightJudgeTurns.add(turns);
          const convId = api.conversationId;
          const expectedInputs = inputCount;
          const judgedTurn = turns;

          const judgeTask = (async () => {
            try {
              const verdict = await judgeFn({
                models, modelRef, trajectory, redact: options.redact, signal: shutdownController.signal,
                timeoutMs: options.judgeTimeoutMs ?? RUN_HEALTH_JUDGE_TIMEOUT_MS,
                ...(options.onWarning ? { onWarning: options.onWarning } : {}),
              });
              if (shutdownController.signal.aborted) return;

              await commitDocUpdate(
                convId,
                (txDoc, liveRun) => {
                  if (!liveRun || Number(liveRun.first ?? assistant) !== runFirstEntryId) return false;
                  if (liveRun.inputs.length > expectedInputs || txDoc.runFirstEntryId !== runFirstEntryId) return false;
                  const judged = new Set(txDoc.judgedTurns ?? []);
                  judged.add(judgedTurn);
                  txDoc.judgedTurns = [...judged].sort((a, b) => a - b);
                  if (!verdict || verdict.verdict === "healthy") return true;
                  if (verdict.verdict === "stuck") {
                    txDoc.forceWrapUp = { source: "judge_stuck", reason: verdict.reason, setAtTurn: judgedTurn };
                    delete txDoc.pendingGuidance;
                  } else if (verdict.verdict === "handoff_or_wrap" && !txDoc.forceWrapUp) {
                    txDoc.pendingGuidance = { source: "judge", turn: judgedTurn, text: buildJudgeGuidance(role, verdict) };
                  }
                  return true;
                },
                BACKGROUND_CONTEXT,
                role === "worker" && verdict?.verdict === "stuck"
                  ? { kind: "judge_stuck", reason: verdict.reason }
                  : undefined,
              );
            } catch {
              // Strict fail-open: never surface errors from detached judge persistence.
            } finally {
              const currentCache = caches.get(convNum);
              if (currentCache && currentCache.runFirstEntryId === runFirstEntryId) {
                currentCache.inFlightJudgeTurns.delete(judgedTurn);
              }
            }
          })();

          pendingJudges.add(judgeTask);
          void judgeTask.finally(() => { pendingJudges.delete(judgeTask); });
        },

        beforeRequest: async (request, api, context) => {
          if (shutdownController.signal.aborted || request.messages.length === 0) return undefined;
          const role = await resolveConversationRole(options, api, context);
          if (!role) return undefined;

          const [live, agentDoc, storedDoc] = await Promise.all([
            api.snapshot(LiveDoc, api.conversationId, context),
            api.snapshot(AgentDoc, api.conversationId, context),
            api.snapshot(RunHealthDoc, api.conversationId, context),
          ]);
          const run = live?.run;
          if (!run) return undefined;

          const convNum = Number(api.conversationId);
          const runFirstEntryId = Number(run.first ?? 0);
          const turns = run.turns;
          const inputCount = run.inputs.length;
          const budget = resolveRoleTurnBudget(role, agentDoc?.maxTurns);

          const normalized = normalizeDocForRun(storedDoc, runFirstEntryId, inputCount, turns);
          const state = normalized.state;
          let docDirty = normalized.changed;

          const cache = caches.get(convNum);
          if (cache && cache.runFirstEntryId === runFirstEntryId && normalized.steered) {
            resetCacheForSteer(cache, inputCount, state.turnsAtLastUserInput ?? turns);
          } else if (cache && normalized.resetRun) {
            caches.delete(convNum);
          }

          const effectiveTurns = Math.max(0, turns - (state.turnsAtLastUserInput ?? 0));
          const isForceWrapUp = Boolean(state.forceWrapUp) || turns >= budget.wrapUpTurn;
          let guidance: string | undefined;

          if (isForceWrapUp) {
            const source: RunHealthWrapUpSource = state.forceWrapUp?.source ?? "turn_limit";
            const allowDispatch = role === "orchestrator" && source === "turn_limit" && !state.wrapUpDispatched;
            guidance = buildWrapUpGuidance({
              role, source, turns, maxTurns: budget.maxTurns, allowDispatch,
              ...(state.forceWrapUp?.reason ? { reason: state.forceWrapUp.reason } : {}),
            });
          } else if (state.pendingGuidance?.text) {
            guidance = state.pendingGuidance.text;
            if (state.pendingGuidance.deliveredAtTurn === undefined) {
              state.pendingGuidance.deliveredAtTurn = turns;
              docDirty = true;
            }
          } else if (
            role === "orchestrator" &&
            budget.softHandoffTurn !== undefined &&
            effectiveTurns >= budget.softHandoffTurn &&
            !state.softReminded &&
            !state.dispatchedInRun
          ) {
            guidance = buildSoftHandoffGuidance(effectiveTurns);
            state.softReminded = true;
            docDirty = true;
          }

          if (docDirty && runFirstEntryId > 0) {
            await commitDocUpdate(
              api.conversationId,
              (txDoc, liveRun) => {
                if (!liveRun || Number(liveRun.first ?? 0) !== runFirstEntryId) return false;
                assignDocState(txDoc, state);
                return true;
              },
              context,
            ).catch(() => {});
          }

          if (!guidance) return undefined;
          const nextMessages = appendGuidanceToLastMessage(request.messages, guidance);
          return nextMessages === request.messages ? undefined : { messages: nextMessages };
        },
      }),

      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          // Always allow nested internal tool calls (`executeTool()`).
          if ("parent" in call && call.parent !== undefined) return undefined;
          const role = await resolveConversationRole(options, api, context);
          if (!role) return undefined;

          const [live, agentDoc, storedDoc] = await Promise.all([
            api.snapshot(LiveDoc, api.conversationId, context),
            api.snapshot(AgentDoc, api.conversationId, context),
            api.snapshot(RunHealthDoc, api.conversationId, context),
          ]);
          const run = live?.run;
          if (!run) return undefined;

          const convNum = Number(api.conversationId);
          const runFirstEntryId = Number(run.first ?? 0);
          const turns = run.turns;
          const inputCount = run.inputs.length;
          const budget = resolveRoleTurnBudget(role, agentDoc?.maxTurns);
          const state = normalizeDocForRun(storedDoc, runFirstEntryId, inputCount, turns).state;

          if (!state.forceWrapUp && turns < budget.wrapUpTurn) return undefined;
          const source: RunHealthWrapUpSource = state.forceWrapUp?.source ?? "turn_limit";

          if (role === "worker") {
            if (call.name === "kulo_report") return undefined;
            return {
              block: buildBeforeToolBlockMessage({
                role, source, toolName: call.name,
                ...(state.forceWrapUp?.reason ? { reason: state.forceWrapUp.reason } : {}),
              }),
            };
          }

          if (role === "subagent") {
            return {
              block: buildBeforeToolBlockMessage({
                role, source, toolName: call.name,
                ...(state.forceWrapUp?.reason ? { reason: state.forceWrapUp.reason } : {}),
              }),
            };
          }

          // Orchestrator wrap-up: allow strictly ONE `kulo_dispatch` on turn ceiling (never on stuck/doom_loop).
          const canDispatchOnce = source === "turn_limit" && !state.wrapUpDispatched;
          if (call.name === "kulo_dispatch" && canDispatchOnce) {
            let cache = caches.get(convNum);
            if (!cache || cache.runFirstEntryId !== runFirstEntryId) {
              cache = {
                runFirstEntryId, lastInputCount: inputCount, turnsAtLastUserInput: state.turnsAtLastUserInput ?? 0,
                lastProcessedAssistantId: 0, doomLoop: createEmptyDoomLoopState(), trajectoryTurns: [],
                userGoal: "", inFlightJudgeTurns: new Set<number>(),
              };
              setCache(convNum, cache);
            }
            if (cache.wrapUpDispatchClaimedCallId === undefined || cache.wrapUpDispatchClaimedCallId === call.id) {
              cache.wrapUpDispatchClaimedCallId = call.id;
              return undefined;
            }
          }

          return {
            block: buildBeforeToolBlockMessage({
              role, source, toolName: call.name,
              ...(state.forceWrapUp?.reason ? { reason: state.forceWrapUp.reason } : {}),
              allowDispatch: canDispatchOnce && call.name !== "kulo_dispatch",
            }),
          };
        },
      }),
    ],
  });

  return {
    extension,
    close() {
      if (!shutdownController.signal.aborted) shutdownController.abort();
      caches.clear();
    },
    async waitForPendingJudges() {
      while (pendingJudges.size > 0) await Promise.allSettled([...pendingJudges]);
    },
  };
}
