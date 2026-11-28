import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  configure,
  defineEntry,
  type ContextView,
  type ConversationId,
  type Harness,
  type JsonObject,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  ModelGatewayConfig,
  RolePreset,
  RoleThinkingEffort,
  TicketModelEscalation,
  TicketRecord,
} from "@kulo/protocol";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_CONTEXT_WINDOW, type KuloModelConfig } from "./config.js";
import { KULO_GATEWAY_PROVIDER_ID, resolveModelThinkingSelection } from "./models.js";
import type { RunHealthRole } from "./run-health-policy.js";
import { KuloStateDoc, resolveTicketExecutionScope } from "./state.js";
import {
  resolveWorkerEffectiveModel,
  type ResolvedWorkerModel,
  type WorkerModelSelection,
} from "./ticket-model-arbiter.js";
import { sanitizeTicketQuotaText } from "./ticket-quota-pause.js";

export const ESCALATION_REASON_MAX_CHARS = 240;

const EXCLUDED_USAGE_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
const TERMINAL_TICKET_STATUSES = new Set<TicketRecord["status"]>([
  "ready",
  "failed",
  "stopped",
  "closed",
]);

export type ModelEscalationTrigger =
  | {
      layer: "layer1_doom_loop";
      action: "warn" | "brake";
      reason: string;
    }
  | {
      layer: "layer2_judge";
      verdict: "stuck";
      reason: string;
    };

export type ModelEscalationRejectReason =
  | "not_builtin_worker"
  | "ticket_not_active"
  | "no_escalation_model"
  | "user_override_present"
  | "already_escalated"
  | "already_on_target_model"
  | "trigger_not_eligible"
  | "target_model_unavailable"
  | "context_window_insufficient";

export interface RunHealthEscalationRecord {
  runEpoch: number;
  activatedAtTurn: number;
  provider: string;
  modelId: string;
  thinkingLevel?: RoleThinkingEffort;
  reason: string;
}

export interface RunHealthEscalationSkip {
  runEpoch: number;
  turn: number;
  rejectReason: ModelEscalationRejectReason;
  detail: string;
}

export interface RunHealthEscalationSettings {
  roles: Readonly<Record<string, RolePreset>>;
  model: ModelGatewayConfig;
  fallbackProviderId: string;
}

export interface RunHealthEscalationEntryData {
  ticketId: string;
  runEpoch: number;
  turn: number;
  provider: string;
  modelId: string;
  trigger: ModelEscalationTrigger["layer"];
  reason: string;
  text: string;
  at: number;
}

/**
 * Display-only worker timeline entry emitted on one-way auto-escalation.
 * Carries NO `model` field so it never pollutes LLM ContextView or breaks KV prefix cache.
 */
export const RunHealthEscalationEntry = defineEntry<RunHealthEscalationEntryData & JsonObject>(
  "kulo.run-health-escalation",
);

export interface EvaluateOneWayModelEscalationInput {
  role: RunHealthRole;
  ticket: Pick<
    TicketRecord,
    | "status"
    | "runEpoch"
    | "providerOverride"
    | "modelOverride"
    | "thinkingOverride"
    | "modelEscalation"
    | "externalExecution"
  >;
  rolePreset?: Pick<RolePreset, "provider" | "modelId" | "thinkingLevel" | "escalationModel" | "external">;
  defaultModel: WorkerModelSelection;
  docEscalation?: Readonly<RunHealthEscalationRecord>;
  trigger: ModelEscalationTrigger;
  turn: number;
  targetModel?: {
    provider: string;
    modelId: string;
    contextWindow: number;
  };
  estimatedContextTokens: number;
  redact?: (text: string) => string;
}

export type OneWayModelEscalationDecision =
  | {
      escalate: false;
      rejectReason: ModelEscalationRejectReason;
      detail: string;
    }
  | {
      escalate: true;
      escalation: TicketModelEscalation;
      resolvedModel: ResolvedWorkerModel;
      timelineText: string;
    };

export function sanitizeEscalationText(
  raw: string | undefined,
  redact?: (text: string) => string,
  maxLen = ESCALATION_REASON_MAX_CHARS,
): string {
  return sanitizeTicketQuotaText(raw, redact, maxLen);
}

export function formatEscalationTimelineText(
  modelId: string,
  redact?: (text: string) => string,
): string {
  const safeModelId = sanitizeEscalationText(modelId, redact, 120) || "强模型";
  return sanitizeEscalationText(`已单向升级至 ${safeModelId} 继续排障`, redact, ESCALATION_REASON_MAX_CHARS);
}

export function buildEscalationGuidance(
  modelId: string,
  redact?: (text: string) => string,
): string {
  const safeModelId = sanitizeEscalationText(modelId, redact, 120) || "强模型";
  return (
    `[KULO_RUN_HEALTH:ESCALATED] 已单向升级至 ${safeModelId} 继续排障。` +
    "请先复盘已有工具输出，避免重复先前的无效操作，采用新的排查思路推进并完成后调用 `kulo_report` 汇报。"
  );
}

export function toRunHealthEscalationRecord(
  escalation: Readonly<TicketModelEscalation>,
  fallbackProvider: string,
): RunHealthEscalationRecord {
  const provider = escalation.escalatedModel.provider?.trim() || fallbackProvider;
  return {
    runEpoch: escalation.runEpoch,
    activatedAtTurn: escalation.activatedAtTurn,
    provider,
    modelId: escalation.escalatedModel.modelId,
    ...(escalation.escalatedModel.thinkingLevel !== undefined
      ? { thinkingLevel: escalation.escalatedModel.thinkingLevel }
      : {}),
    reason: escalation.reason,
  };
}

function isUsableMeasuredAssistant(message: Message): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    !EXCLUDED_USAGE_STOP_REASONS.has(message.stopReason) &&
    calculateContextTokens(message.usage) > 0
  );
}

/**
 * Pure active context token estimator matching `context-guard.ts` without cross-module coupling.
 */
export function estimateActiveContextTokens(view: ContextView | undefined): number {
  if (!view || view.messages.length === 0) return 0;
  let measured: AssistantMessage | undefined;
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
  for (let i = view.entries.length - 1; i >= 0 && measured === undefined; i -= 1) {
    if (view.entries[i]!.id <= after) continue;
    const contributions = view.contributions[i] ?? [];
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
    return tokens;
  }
  let tokens = 0;
  for (const message of view.messages) {
    tokens += estimateMessageTokens(message);
  }
  return tokens;
}

export async function estimateConversationContextTokens(
  harness: Harness,
  conversationId: ConversationId,
  context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
  try {
    const conv = await harness.conversation(conversationId, context);
    if (!conv) return 0;
    const view = await conv.context(context);
    return estimateActiveContextTokens(view);
  } catch {
    return 0;
  }
}

export function resolveTargetEscalationModel(
  models: Models,
  modelConfig: ModelGatewayConfig,
  provider: string,
  modelId: string,
): { provider: string; modelId: string; contextWindow: number } | undefined {
  const cleanProvider = provider.trim();
  const cleanModelId = modelId.trim();
  if (!cleanProvider || !cleanModelId) return undefined;
  const registered = models.getModel(cleanProvider, cleanModelId);
  if (!registered) return undefined;
  const subscriptionModels =
    modelConfig.subscriptionModels && Object.hasOwn(modelConfig.subscriptionModels, cleanProvider)
      ? modelConfig.subscriptionModels[cleanProvider]
      : undefined;
  const custom =
    cleanProvider === KULO_GATEWAY_PROVIDER_ID
      ? modelConfig.gatewayModels?.find((item) => item.id === cleanModelId)
      : subscriptionModels?.find((item) => item.id === cleanModelId) ??
        modelConfig.customProviders
          ?.find((item) => item.id === cleanProvider)
          ?.models.find((item) => item.id === cleanModelId);
  const registeredWindow =
    typeof registered.contextWindow === "number" &&
    Number.isFinite(registered.contextWindow) &&
    registered.contextWindow > 0
      ? registered.contextWindow
      : 0;
  const configuredWindow =
    typeof custom?.contextWindow === "number" &&
    Number.isFinite(custom.contextWindow) &&
    custom.contextWindow > 0
      ? custom.contextWindow
      : 0;
  const contextWindow =
    registeredWindow > 0 && configuredWindow > 0
      ? Math.min(registeredWindow, configuredWindow)
      : registeredWindow || configuredWindow;
  if (!(contextWindow > 0)) return undefined;
  return { provider: cleanProvider, modelId: cleanModelId, contextWindow };
}

/**
 * Pure one-way auto-escalation adjudicator for built-in Workers (v2 §5.3).
 *
 * Guarantees:
 * - Built-in Workers only, with explicit `rolePreset.escalationModel`
 * - Never overrides explicit user `providerOverride` / `modelOverride`
 * - At most once per ticket `runEpoch` (strictly one-way, zero fallback)
 * - Rejects when `targetModel.contextWindow < estimatedContextTokens`
 * - Only fires on Layer 1 `doom_loop` (`warn`/`brake`) or Layer 2 Judge `stuck`
 * - Always resolves via single model arbiter (`resolveWorkerEffectiveModel`)
 */
export function evaluateOneWayModelEscalation(
  input: EvaluateOneWayModelEscalationInput,
): OneWayModelEscalationDecision {
  const {
    role,
    ticket,
    rolePreset,
    defaultModel,
    docEscalation,
    trigger,
    turn,
    targetModel,
    estimatedContextTokens,
    redact,
  } = input;

  if (role !== "worker" || Boolean(ticket.externalExecution) || Boolean(rolePreset?.external)) {
    return {
      escalate: false,
      rejectReason: "not_builtin_worker",
      detail: "仅内置 Worker 支持遇卡自动升档。",
    };
  }

  if (TERMINAL_TICKET_STATUSES.has(ticket.status) || ticket.status === "waiting") {
    return {
      escalate: false,
      rejectReason: "ticket_not_active",
      detail: "任务已非运行态，跳过自动升档。",
    };
  }

  const escProvider = rolePreset?.escalationModel?.provider?.trim() ?? "";
  const escModelId = rolePreset?.escalationModel?.modelId?.trim() ?? "";
  const escThinking = rolePreset?.escalationModel?.thinkingLevel;
  if (!escProvider || !escModelId) {
    return {
      escalate: false,
      rejectReason: "no_escalation_model",
      detail: "角色未配置遇卡升级模型。",
    };
  }

  if (ticket.providerOverride?.trim() || ticket.modelOverride?.trim()) {
    return {
      escalate: false,
      rejectReason: "user_override_present",
      detail: "用户已显式指定模型，优先尊重用户选择，跳过自动升档。",
    };
  }

  if (
    ticket.modelEscalation?.runEpoch === ticket.runEpoch ||
    docEscalation?.runEpoch === ticket.runEpoch
  ) {
    return {
      escalate: false,
      rejectReason: "already_escalated",
      detail: "当前任务已完成过一次单向升档，不再二次升档。",
    };
  }

  const triggerEligible =
    (trigger.layer === "layer1_doom_loop" && (trigger.action === "warn" || trigger.action === "brake")) ||
    (trigger.layer === "layer2_judge" && trigger.verdict === "stuck");
  if (!triggerEligible) {
    return {
      escalate: false,
      rejectReason: "trigger_not_eligible",
      detail: "当前健康信号不满足自动升档条件。",
    };
  }

  const currentEffective = resolveWorkerEffectiveModel({
    ticket,
    rolePreset,
    defaultModel,
  });
  const sameProvider =
    (currentEffective.provider?.trim() ?? defaultModel.provider?.trim() ?? "") === escProvider;
  const sameModel = currentEffective.modelId === escModelId;
  const sameThinking =
    escThinking === undefined ||
    escThinking === "auto" ||
    escThinking === currentEffective.thinkingLevel;
  if (sameProvider && sameModel && sameThinking) {
    return {
      escalate: false,
      rejectReason: "already_on_target_model",
      detail: "当前已在目标升级模型上运行，无需重复升档。",
    };
  }

  if (!targetModel || !targetModel.modelId.trim() || !(targetModel.contextWindow > 0)) {
    return {
      escalate: false,
      rejectReason: "target_model_unavailable",
      detail: sanitizeEscalationText(`目标升级模型 ${escProvider}/${escModelId} 当前不可用，已跳过自动升档。`, redact),
    };
  }

  const estimated =
    Number.isFinite(estimatedContextTokens) && estimatedContextTokens > 0
      ? Math.ceil(estimatedContextTokens)
      : 0;
  if (targetModel.contextWindow < estimated) {
    return {
      escalate: false,
      rejectReason: "context_window_insufficient",
      detail: sanitizeEscalationText(
        `目标模型 ${escModelId} 上下文窗口（${targetModel.contextWindow}）小于当前估算上下文（${estimated}），已拒绝自动升档。`,
        redact,
      ),
    };
  }

  const sanitizedReason =
    sanitizeEscalationText(trigger.reason, redact, ESCALATION_REASON_MAX_CHARS) ||
    (trigger.layer === "layer2_judge" ? "评审判定任务执行停滞" : "检测到连续重复工具调用");

  const escalation: TicketModelEscalation = {
    runEpoch: ticket.runEpoch,
    activatedAtTurn: Math.max(0, Math.floor(turn)),
    escalatedModel: {
      provider: escProvider,
      modelId: escModelId,
      ...(escThinking !== undefined ? { thinkingLevel: escThinking } : {}),
    },
    reason: sanitizedReason,
  };

  const resolvedModel = resolveWorkerEffectiveModel({
    ticket: {
      ...ticket,
      modelEscalation: escalation,
    },
    rolePreset,
    defaultModel,
  });
  if (resolvedModel.source !== "escalation") {
    return {
      escalate: false,
      rejectReason: "user_override_present",
      detail: "模型仲裁优先级高于自动升档，已跳过。",
    };
  }

  return {
    escalate: true,
    escalation,
    resolvedModel,
    timelineText: formatEscalationTimelineText(escModelId, redact),
  };
}

function normalizeModelGatewayConfig(m: ModelGatewayConfig): KuloModelConfig {
  return {
    ...m,
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    compaction: m.compaction ?? { ...DEFAULT_COMPACTION_CONFIG },
    customProviders: m.customProviders ?? [],
  };
}

export interface ApplyOneWayEscalationTxInput {
  conversationId: ConversationId;
  ticket: TicketRecord;
  decision: Extract<OneWayModelEscalationDecision, { escalate: true }>;
  triggerLayer: ModelEscalationTrigger["layer"];
  models: Models;
  modelConfig: ModelGatewayConfig;
  fallbackProviderId: string;
  now: number;
  redact?: (text: string) => string;
}

/**
 * Atomically persists `TicketRecord.modelEscalation`, updates `AgentDoc` through the single
 * arbiter + thinking resolver, and appends a display-only timeline event in the same commit.
 */
export async function applyOneWayEscalationInTx(
  tx: Tx,
  input: ApplyOneWayEscalationTxInput,
): Promise<{ ok: boolean; errorDetail?: string }> {
  const {
    conversationId,
    ticket,
    decision,
    triggerLayer,
    models,
    modelConfig,
    fallbackProviderId,
    now,
    redact,
  } = input;

  const resolvedProvider = decision.resolvedModel.provider?.trim() || fallbackProviderId;
  let resolvedAgent: ReturnType<typeof resolveModelThinkingSelection>;
  try {
    resolvedAgent = resolveModelThinkingSelection(
      models,
      resolvedProvider,
      decision.resolvedModel.modelId,
      decision.resolvedModel.thinkingLevel,
      normalizeModelGatewayConfig(modelConfig),
    );
  } catch (error) {
    return {
      ok: false,
      errorDetail: sanitizeEscalationText(
        error instanceof Error ? error.message : "目标升级模型解析失败。",
        redact,
      ),
    };
  }

  if (!models.getModel(resolvedAgent.model.provider, resolvedAgent.model.modelId)) {
    return {
      ok: false,
      errorDetail: sanitizeEscalationText(
        `目标升级模型 ${resolvedAgent.model.provider}/${resolvedAgent.model.modelId} 未注册。`,
        redact,
      ),
    };
  }

  ticket.modelEscalation = {
    runEpoch: decision.escalation.runEpoch,
    activatedAtTurn: decision.escalation.activatedAtTurn,
    escalatedModel: { ...decision.escalation.escalatedModel },
    reason: decision.escalation.reason,
  };
  delete ticket.runHealthStuck;
  ticket.updatedAt = now;

  await configure(tx, conversationId, {
    model: resolvedAgent.model,
    ...(decision.resolvedModel.explicitThinking ? { thinkingLevel: resolvedAgent.thinkingLevel } : {}),
  });

  await tx.appendEntry(RunHealthEscalationEntry, conversationId, {
    data: {
      ticketId: ticket.id,
      runEpoch: ticket.runEpoch,
      turn: decision.escalation.activatedAtTurn,
      provider: resolvedProvider,
      modelId: decision.escalation.escalatedModel.modelId,
      trigger: triggerLayer,
      reason: decision.escalation.reason,
      text: decision.timelineText,
      at: now,
    },
  });

  return { ok: true };
}

export interface TryEscalateWorkerTxInput {
  conversationId: ConversationId;
  ticket: TicketRecord;
  docEscalation?: Readonly<RunHealthEscalationRecord>;
  trigger: ModelEscalationTrigger;
  turn: number;
  settings: RunHealthEscalationSettings;
  models: Models;
  estimatedContextTokens: number;
  now: number;
  redact?: (text: string) => string;
}

export type TryEscalateWorkerTxResult =
  | {
      escalated: true;
      docEscalation: RunHealthEscalationRecord;
      guidanceText: string;
    }
  | {
      escalated: false;
      rejectReason: ModelEscalationRejectReason;
      skipRecord?: RunHealthEscalationSkip;
      warning?: string;
    };

/**
 * Unified transactional escalation path shared by Layer 1 (`afterTools`) and Layer 2 (`judgeTask`).
 */
export async function tryEscalateWorkerInTx(
  tx: Tx,
  input: TryEscalateWorkerTxInput,
): Promise<TryEscalateWorkerTxResult> {
  const { conversationId, ticket, docEscalation, trigger, turn, settings, models, estimatedContextTokens, now, redact } =
    input;
  const rolePreset = settings.roles[ticket.role];
  const defaultModel: WorkerModelSelection = {
    provider: settings.model.defaultProvider,
    modelId: settings.model.defaultModel,
    thinkingLevel: settings.model.thinkingLevel,
  };
  const escTarget = rolePreset?.escalationModel;
  const targetModel = escTarget
    ? resolveTargetEscalationModel(models, settings.model, escTarget.provider, escTarget.modelId)
    : undefined;
  const decision = evaluateOneWayModelEscalation({
    role: "worker",
    ticket,
    rolePreset,
    defaultModel,
    docEscalation,
    trigger,
    turn,
    targetModel,
    estimatedContextTokens,
    redact,
  });

  if (!decision.escalate) {
    if (
      decision.rejectReason === "context_window_insufficient" ||
      decision.rejectReason === "target_model_unavailable"
    ) {
      const safeDetail = sanitizeEscalationText(decision.detail, redact);
      return {
        escalated: false,
        rejectReason: decision.rejectReason,
        skipRecord: {
          runEpoch: ticket.runEpoch,
          turn: Math.max(0, Math.floor(turn)),
          rejectReason: decision.rejectReason,
          detail: safeDetail,
        },
        warning: safeDetail,
      };
    }
    return { escalated: false, rejectReason: decision.rejectReason };
  }

  const applied = await applyOneWayEscalationInTx(tx, {
    conversationId,
    ticket,
    decision,
    triggerLayer: trigger.layer,
    models,
    modelConfig: settings.model,
    fallbackProviderId: settings.fallbackProviderId,
    now,
    redact,
  });
  if (!applied.ok) {
    const safeDetail = sanitizeEscalationText(applied.errorDetail || "目标升级模型不可用", redact);
    return {
      escalated: false,
      rejectReason: "target_model_unavailable",
      skipRecord: {
        runEpoch: ticket.runEpoch,
        turn: Math.max(0, Math.floor(turn)),
        rejectReason: "target_model_unavailable",
        detail: safeDetail,
      },
      warning: safeDetail,
    };
  }

  return {
    escalated: true,
    docEscalation: toRunHealthEscalationRecord(decision.escalation, settings.fallbackProviderId),
    guidanceText: buildEscalationGuidance(decision.escalation.escalatedModel.modelId, redact),
  };
}

export interface WorkerRunHealthDocMutable {
  escalation?: RunHealthEscalationRecord;
  lastEscalationSkip?: RunHealthEscalationSkip;
  forceWrapUp?: unknown;
  pendingGuidance?: {
    source: "doom_loop" | "judge" | "escalation";
    turn: number;
    text: string;
    deliveredAtTurn?: number;
  };
}

export interface WorkerHealthCommitAction {
  expectedRunEpoch?: number;
  requireRunningTicket?: boolean;
  stuck?: { kind: "doom_loop" | "judge_stuck"; reason: string };
  escalation?: {
    trigger: ModelEscalationTrigger;
    turn: number;
    estimatedContextTokens: number;
    models: Models;
  };
}

/**
 * Verifies active worker ticket scope (and `runEpoch` for async Layer 2 commits),
 * attempts one-way auto-escalation first, and falls back to `runHealthStuck` when not escalated.
 */
export async function applyWorkerHealthActionInTx(
  tx: Tx,
  input: {
    conversationId: ConversationId;
    doc: WorkerRunHealthDocMutable;
    action: WorkerHealthCommitAction;
    getSettings?: () => RunHealthEscalationSettings;
    redact: (text: string) => string;
    applyDocUpdate: () => boolean;
  },
): Promise<{ applied: boolean; escalated: boolean; skipWarning?: string }> {
  const { conversationId, doc, action, getSettings, redact, applyDocUpdate } = input;
  const kuloState = await tx.doc(KuloStateDoc);
  const scope = resolveTicketExecutionScope(kuloState, conversationId);
  if (action.requireRunningTicket) {
    if (
      !scope ||
      scope.isSubagent ||
      scope.ticket.status !== "running" ||
      (action.expectedRunEpoch !== undefined && scope.ticket.runEpoch !== action.expectedRunEpoch)
    ) {
      return { applied: false, escalated: false };
    }
  }

  if (!applyDocUpdate()) return { applied: false, escalated: false };

  const now = Date.now();
  let escalated = false;
  let skipWarning: string | undefined;
  if (action.escalation && scope && !scope.isSubagent && getSettings) {
    const escResult = await tryEscalateWorkerInTx(tx, {
      conversationId,
      ticket: scope.ticket,
      docEscalation: doc.escalation,
      trigger: action.escalation.trigger,
      turn: action.escalation.turn,
      settings: getSettings(),
      models: action.escalation.models,
      estimatedContextTokens: action.escalation.estimatedContextTokens,
      now,
      redact,
    });
    if (escResult.escalated) {
      doc.escalation = escResult.docEscalation;
      delete doc.forceWrapUp;
      delete doc.lastEscalationSkip;
      doc.pendingGuidance = {
        source: "escalation",
        turn: action.escalation.turn,
        text: escResult.guidanceText,
      };
      escalated = true;
    } else {
      if (escResult.skipRecord) doc.lastEscalationSkip = escResult.skipRecord;
      if (escResult.warning) skipWarning = escResult.warning;
    }
  }

  if (
    !escalated &&
    action.stuck &&
    scope &&
    !scope.isSubagent &&
    scope.ticket.status !== "stopped" &&
    scope.ticket.status !== "closed"
  ) {
    scope.ticket.runHealthStuck = {
      kind: action.stuck.kind,
      reason: sanitizeEscalationText(action.stuck.reason, redact) || "检测到任务执行停滞",
      at: now,
    };
    scope.ticket.updatedAt = now;
  }
  return { applied: true, escalated, ...(skipWarning ? { skipWarning } : {}) };
}

/**
 * Terminal cleanup invoked from `hub.ts` `onTicketSettled` (zero intrusion into `scheduler.ts`).
 * Strictly preserves active escalation while a ticket is paused/waiting (e.g. `waiting(reason="quota")`).
 */
export async function clearSettledTicketEscalationInTx(
  tx: Tx,
  ticketId: string,
): Promise<{ cleared: boolean; workerConversationId?: number }> {
  const state = await tx.doc(KuloStateDoc);
  const ticket = state.tickets?.[ticketId];
  if (!ticket) return { cleared: false };
  if (!TERMINAL_TICKET_STATUSES.has(ticket.status)) {
    return { cleared: false };
  }
  const workerConversationId = ticket.workerConversationId;
  let cleared = false;
  if (ticket.modelEscalation) {
    delete ticket.modelEscalation;
    cleared = true;
  }
  if (ticket.runHealthStuck) {
    delete ticket.runHealthStuck;
    cleared = true;
  }
  return { cleared, workerConversationId };
}
