import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import {
  describeKuloError,
  externalClientConnectionId,
  isQuotaSupportedExternalAgentKind,
  parseDirectExternalClientRoleId,
  redactSecrets,
  redactSensitiveText,
  resolveEffectiveExecutionMode,
  resolveExternalModelEffortPolicy,
  type ModelGatewayConfig,
  type RolePreset,
  type RoleThinkingEffort,
  type TicketCardView,
  type TicketQuotaPause,
  type TicketQuotaPauseKind,
  type TicketRecord,
  type TicketResumeOverrideRequest,
  type TicketResumeOverrideResponse,
} from "@kulo/protocol";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_CONTEXT_WINDOW, type KuloModelConfig } from "./config.js";
import { redactCredentialData } from "./credential-redaction.js";
import {
  deliveryReceiptKey,
  writeDeliveryReceipt,
  type DeliveryIntent,
  type DeliveryReceipt,
} from "./delivery-receipts.js";
import type { HubDeliveryCoordinator } from "./hub-delivery-coordinator.js";
import type { HubRuntimeGates, LiveSettingsStore } from "./hub-kernel-ports.js";
import { KULO_GATEWAY_PROVIDER_ID, resolveModelThinkingSelection } from "./models.js";
import { assertProjectBinding, KuloProjects, KuloProjectsDoc, ProjectError } from "./projects.js";
import type { createWorkerTicketTask } from "./scheduler.js";
import {
  hasActiveSubagents,
  KuloStateDoc,
  recordProcessedCommand,
  toTicketCardView,
  transitionTicketStatus,
  type KuloDurableState,
} from "./state.js";
import { areTicketDevicesOnline } from "./ticket-dispatch-plan.js";
import { resolveWorkerEffectiveModel, type WorkerModelSelection } from "./ticket-model-arbiter.js";
import type { TicketReconciler } from "./ticket-reconciler.js";
import { isLoopbackBaseUrl, type KuloUsageCaps } from "./usage-caps.js";

export const QUOTA_PAUSE_ERROR_MAX_CHARS = 240;
const RECENT_RESUME_DEDUP_MS = 15_000;

/**
 * Double-redacts free-form text written to `kulo.*` durable documents (§2.2) so
 * `wrapRedactedStorage.commit` never trips `documentLeak() -> SessionFailed`.
 */
export function sanitizeTicketQuotaText(
  raw: string | undefined,
  redact?: (text: string) => string,
  maxLen = QUOTA_PAUSE_ERROR_MAX_CHARS,
): string {
  const apply = (value: string): string => {
    const once = redactSecrets(value);
    const twice = redact ? redact(once) : once;
    const thrice = redactSensitiveText(redactSecrets(twice));
    const verified = redactCredentialData({ text: thrice }, redact ?? ((s) => s)).text;
    return verified;
  };
  const collapsed = apply(raw ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sliced = collapsed.slice(0, maxLen);
  return apply(sliced).slice(0, maxLen);
}

function classifyQuotaKindFromDescriptor(
  reason: string | undefined,
  detail: string | undefined,
  modelId: string | undefined,
  source: "builtin" | "external",
): { kind: TicketQuotaPauseKind; title: string; rawDetail?: string } | undefined {
  const trimmedReason = reason?.trim();
  if (trimmedReason === "usage_cap") {
    return {
      kind: "usage_cap",
      title: "已达到用量上限保护",
      ...(detail ? { rawDetail: detail } : {}),
    };
  }
  if (
    trimmedReason &&
    trimmedReason !== "model_error" &&
    trimmedReason !== "external_error"
  ) {
    return undefined;
  }
  const desc = describeKuloError({
    reason: trimmedReason || "model_error",
    detail,
    modelId,
  });
  if (desc.kind === "quota") {
    return {
      kind: source === "external" ? "external_quota" : "provider_quota",
      title: desc.title,
      ...(desc.rawDetail ? { rawDetail: desc.rawDetail } : {}),
    };
  }
  if (desc.kind === "rate_limit") {
    return {
      kind: "rate_limit_exhausted",
      title: desc.title,
      ...(desc.rawDetail ? { rawDetail: desc.rawDetail } : {}),
    };
  }
  return undefined;
}

export function isQuotaPauseCheckpoint(checkpoint: {
  unansweredReason?: string;
  unansweredDetail?: string;
}): boolean {
  if (!checkpoint.unansweredReason) return false;
  return Boolean(
    classifyQuotaKindFromDescriptor(
      checkpoint.unansweredReason,
      checkpoint.unansweredDetail,
      undefined,
      "builtin",
    ),
  );
}

export function classifyQuotaPauseFromUnanswered(input: {
  ticket: Readonly<TicketRecord>;
  unansweredReason?: string;
  unansweredDetail?: string;
  rolePreset?: Pick<RolePreset, "provider" | "modelId" | "thinkingLevel">;
  defaultModel?: WorkerModelSelection;
  redact?: (text: string) => string;
  now: number;
}): TicketQuotaPause | undefined {
  const { ticket, unansweredReason, unansweredDetail, rolePreset, defaultModel, redact, now } = input;
  if (!unansweredReason) return undefined;
  const effective = defaultModel
    ? resolveWorkerEffectiveModel({ ticket, rolePreset, defaultModel })
    : {
        provider: ticket.providerOverride ?? rolePreset?.provider?.trim() ?? undefined,
        modelId: ticket.modelOverride ?? rolePreset?.modelId?.trim() ?? "",
      };
  const hit = classifyQuotaKindFromDescriptor(
    unansweredReason,
    unansweredDetail,
    effective.modelId || undefined,
    "builtin",
  );
  if (!hit) return undefined;
  const errorMessage =
    sanitizeTicketQuotaText(unansweredDetail || hit.rawDetail || hit.title, redact, QUOTA_PAUSE_ERROR_MAX_CHARS) ||
    hit.title;
  return {
    kind: hit.kind,
    ...(effective.provider ? { provider: effective.provider } : {}),
    ...(effective.modelId ? { modelId: effective.modelId } : {}),
    errorMessage,
    pausedAt: now,
  };
}

export function classifyQuotaPauseFromExternalFailure(input: {
  ticket: Readonly<TicketRecord>;
  error?: string;
  externalClientId?: string;
  redact?: (text: string) => string;
  now: number;
}): TicketQuotaPause | undefined {
  const { ticket, error, externalClientId, redact, now } = input;
  const modelId = ticket.externalExecution?.modelId ?? ticket.modelOverride;
  const hit = classifyQuotaKindFromDescriptor("model_error", error, modelId, "external");
  if (!hit) return undefined;
  const clientId =
    externalClientId?.trim() ||
    parseDirectExternalClientRoleId(ticket.role) ||
    (ticket.externalExecution ? externalClientConnectionId(ticket.externalExecution.binding) : undefined);
  const errorMessage =
    sanitizeTicketQuotaText(error || hit.rawDetail || hit.title, redact, QUOTA_PAUSE_ERROR_MAX_CHARS) ||
    hit.title;
  return {
    kind: hit.kind,
    ...(clientId ? { externalClientId: clientId } : {}),
    ...(modelId ? { modelId } : {}),
    errorMessage,
    pausedAt: now,
  };
}

/**
 * Layer 2 rollback compatibility helper (§2.5 / §4.1):
 * Converts `waiting(reason="quota")` tickets into legacy-operable `waiting(reason="user")`
 * tickets while preserving redacted human-readable detail.
 */
export function downgradeQuotaWaitingToUser(
  state: KuloDurableState,
  redact?: (text: string) => string,
  now = Date.now(),
): { downgradedTicketIds: string[] } {
  const downgradedTicketIds: string[] = [];
  for (const ticket of Object.values(state.tickets ?? {})) {
    if (ticket.waiting?.reason !== "quota") continue;
    const rawDetail = ticket.waiting.detail || ticket.quotaPause?.errorMessage || "模型额度已耗尽，任务已暂停，请确认后继续或停止。";
    const sanitized = sanitizeTicketQuotaText(rawDetail, redact, QUOTA_PAUSE_ERROR_MAX_CHARS);
    const detail = sanitized.startsWith("额度暂停")
      ? sanitized
      : sanitizeTicketQuotaText(`额度暂停：${sanitized}`, redact, QUOTA_PAUSE_ERROR_MAX_CHARS);
    ticket.waiting = {
      ...ticket.waiting,
      reason: "user",
      detail,
    };
    delete ticket.quotaPause;
    ticket.updatedAt = now;
    downgradedTicketIds.push(ticket.id);
  }
  return { downgradedTicketIds };
}

function normalizeModelGatewayConfig(m: ModelGatewayConfig): KuloModelConfig {
  return {
    ...m,
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    compaction: m.compaction ?? { ...DEFAULT_COMPACTION_CONFIG },
    customProviders: m.customProviders ?? [],
  };
}

function buildResumeDeliveryIntent(
  ticketId: string,
  input: Readonly<TicketResumeOverrideRequest>,
  principalId: string,
): DeliveryIntent | undefined {
  const id = input.commandId?.trim();
  if (!id) return undefined;
  const payload = {
    ticketId,
    provider: input.provider?.trim() || undefined,
    modelId: input.modelId?.trim() || undefined,
    thinkingLevel: input.thinkingLevel?.trim() || undefined,
    note: input.note?.trim() || undefined,
  };
  return {
    id,
    key: deliveryReceiptKey(id),
    fingerprint: createHash("sha256").update(JSON.stringify({ principalId, payload })).digest("hex"),
    action: "ticket.resume_override",
    legacyKey: createHash("sha256").update(JSON.stringify([principalId, id])).digest("hex"),
    legacyFingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

export interface TicketQuotaResumePorts {
  redact: (text: string) => string;
  fallbackProviderId: string;
  workerTicketTask: ReturnType<typeof createWorkerTicketTask>;
  reconciler: Pick<TicketReconciler, "releaseTicketExecution" | "isParking" | "queueEnvReconcile">;
  syncWorkerConversation: (ticket: Readonly<TicketRecord>, context: Context) => Promise<void>;
  refreshExternalQuota?: (clientId: string) => void;
}

export interface TicketQuotaResumeDeps {
  harness: Harness;
  models: Models;
  envManager: EnvManager;
  projects: KuloProjects;
  usageCaps: KuloUsageCaps;
  liveSettings: LiveSettingsStore;
  delivery: HubDeliveryCoordinator;
  runtimeGates: HubRuntimeGates;
  ports: TicketQuotaResumePorts;
}

export class TicketQuotaResumeService {
  readonly #deps: TicketQuotaResumeDeps;
  readonly #recentResumes = new Map<string, { key: string; at: number; epoch: number }>();

  constructor(deps: TicketQuotaResumeDeps) {
    this.#deps = deps;
  }

  async #replayReceipt(receipt: Readonly<DeliveryReceipt>, context: Context): Promise<TicketResumeOverrideResponse> {
    const ticketId = String(receipt.ack.ticketId);
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[ticketId];
    if (!ticket) throw new ProjectError(404, "ticket_not_found", "任务不存在。");
    const live = this.#deps.liveSettings.get();
    return {
      ticket: toTicketCardView(ticket, live.roles, live.externalClients),
      resumed: false,
    };
  }

  async resumeWithOverride(
    ticketId: string,
    input: TicketResumeOverrideRequest,
    context: Context = BACKGROUND_CONTEXT,
    principalId = "local",
  ): Promise<TicketResumeOverrideResponse> {
    const intent = buildResumeDeliveryIntent(ticketId, input, principalId);
    return this.#deps.delivery.withDelivery(
      intent,
      context,
      () => this.#deps.delivery.queueTicket(ticketId, () => this.#resumeNow(ticketId, input, context, intent)),
      (receipt) => this.#replayReceipt(receipt, context),
    );
  }

  #resolveTargetModelBaseUrl(provider: string, modelId: string, modelConfig: ModelGatewayConfig): string | undefined {
    const customBaseUrl = modelConfig.customProviders?.find((cp) => cp.id === provider)?.baseUrl;
    if (customBaseUrl) return customBaseUrl;
    if (provider === KULO_GATEWAY_PROVIDER_ID && modelConfig.baseUrl) {
      return modelConfig.baseUrl;
    }
    const registered = this.#deps.models.getModel(provider, modelId);
    if (registered?.baseUrl) return registered.baseUrl;
    if (provider === this.#deps.ports.fallbackProviderId || provider === modelConfig.defaultProvider) {
      return modelConfig.baseUrl;
    }
    return undefined;
  }

  async #resumeNow(
    ticketId: string,
    input: TicketResumeOverrideRequest,
    context: Context,
    intent?: DeliveryIntent,
  ): Promise<TicketResumeOverrideResponse> {
    const { harness, models, envManager, projects, usageCaps, liveSettings, runtimeGates, ports } = this.#deps;
    const liveConfig = liveSettings.get();
    const snapshot = await harness.snapshot(KuloStateDoc, context);
    const ticket = snapshot?.tickets[ticketId];
    if (!ticket) throw new ProjectError(404, "ticket_not_found", "任务不存在。");
    if (ticket.status === "stopped" || ticket.status === "closed") {
      throw new ProjectError(409, "ticket_stopped", "任务已停止或已关闭，不能恢复。");
    }

    const reqProvider = input.provider?.trim() || undefined;
    const reqModelId = input.modelId?.trim() || undefined;
    const reqThinking = input.thinkingLevel?.trim() ? (input.thinkingLevel.trim() as RoleThinkingEffort) : undefined;
    const dedupKey = JSON.stringify([reqProvider ?? "", reqModelId ?? "", reqThinking ?? ""]);

    const isQuotaPaused = ticket.status === "waiting" && ticket.waiting?.reason === "quota";
    const isStuck = Boolean(ticket.runHealthStuck);
    if (!isQuotaPaused && !isStuck) {
      const recent = this.#recentResumes.get(ticketId);
      if (
        recent &&
        Date.now() - recent.at <= RECENT_RESUME_DEDUP_MS &&
        recent.key === dedupKey &&
        (ticket.status === "queued" || ticket.status === "running" || ticket.wakePending)
      ) {
        if (intent) {
          await harness.commit((tx) => writeDeliveryReceipt(tx, intent, { ticketId }), context);
        }
        return {
          ticket: toTicketCardView(ticket, liveConfig.roles, liveConfig.externalClients),
          resumed: false,
        };
      }
      throw new ProjectError(
        409,
        "ticket_not_resumable",
        "当前任务未处于额度暂停或停滞告警状态，不能执行换模型恢复。",
      );
    }

    if (ticket.projectId) {
      const project = await projects.get(ticket.projectId, context);
      if (
        project.grantRevision !== ticket.grantRevision ||
        project.directoryId !== ticket.directoryId ||
        project.deviceId !== ticket.envId ||
        project.workspaceDir !== ticket.workspaceDir
      ) {
        throw new ProjectError(409, "project_binding_changed", "项目位置或授权已变更，请创建新任务。");
      }
      if (ticket.projectRevision !== undefined && project.revision !== ticket.projectRevision) {
        throw new ProjectError(
          409,
          "project_revision_changed",
          `项目基线版本已变更（原版本 ${ticket.projectRevision}，当前版本 ${project.revision}），为避免盲目覆写请先核对差异或创建新任务。`,
          { projectId: project.id },
        );
      }
      if (envManager.getEnvDescriptor(ticket.envId)?.online) {
        await projects.ensureAuthorized(project.id, context);
      }
    }

    const rolePreset = liveConfig.roles[ticket.role];
    let externalClientIdToRefresh: string | undefined;
    let resolvedExternalThinking: { apply: boolean; value?: string } = { apply: false };
    let modelChanged = false;

    if (ticket.externalExecution) {
      const ext = ticket.externalExecution;
      const clientId =
        parseDirectExternalClientRoleId(ticket.role) ??
        rolePreset?.externalClientId?.trim() ??
        externalClientConnectionId(ext.binding);
      if (reqProvider && reqProvider !== clientId && reqProvider !== ext.binding.kind) {
        throw new ProjectError(
          409,
          "cross_engine_resume_denied",
          "同一任务不支持跨引擎切换；请在当前外部客户端内选择模型，或新建替代任务。",
        );
      }
      if (ticket.quotaPause?.kind === "usage_cap" && usageCaps.snapshot().capped) {
        throw new ProjectError(
          403,
          "usage_cap_bypass_denied",
          "当前仍处于用量上限保护期，不能通过切换云端模型绕过预算；请放宽预算上限或等待额度重置。",
        );
      }
      const clientRecord = liveConfig.externalClients?.[clientId];
      const clientModels = clientRecord?.models ?? [];
      const nextExternalModelId = reqModelId ?? ext.modelId ?? ticket.modelOverride;
      if (reqModelId && clientModels.length > 0 && !clientModels.some((m) => m.id === reqModelId)) {
        throw new ProjectError(
          400,
          "invalid_external_model",
          `当前客户端不支持模型「${reqModelId}」。`,
        );
      }
      modelChanged = Boolean(reqModelId && reqModelId !== (ext.modelId ?? ticket.modelOverride));
      const targetModelInfo = nextExternalModelId
        ? clientModels.find((m) => m.id === nextExternalModelId)
        : clientModels.find((m) => m.isDefault);
      const effortPolicy = resolveExternalModelEffortPolicy(targetModelInfo, ext.binding.kind, clientModels);
      if (effortPolicy.capability === "unsupported") {
        resolvedExternalThinking = { apply: true, value: undefined };
      } else if (reqThinking !== undefined) {
        if (reqThinking === "auto") {
          resolvedExternalThinking = { apply: true, value: undefined };
        } else if (effortPolicy.capability !== "supported" || effortPolicy.efforts.includes(reqThinking)) {
          resolvedExternalThinking = { apply: true, value: reqThinking };
        }
      }
      if (isQuotaPaused && isQuotaSupportedExternalAgentKind(ext.binding.kind)) {
        externalClientIdToRefresh = clientId;
      }
    } else {
      if (
        reqProvider &&
        (reqProvider.startsWith("client:") || Object.hasOwn(liveConfig.externalClients ?? {}, reqProvider))
      ) {
        throw new ProjectError(
          409,
          "cross_engine_resume_denied",
          "同一任务不支持跨引擎切换；内置任务只能切换到可用的内置模型。",
        );
      }
      const prevEffective = resolveWorkerEffectiveModel({
        ticket,
        rolePreset,
        defaultModel: {
          provider: liveConfig.model.defaultProvider,
          modelId: liveConfig.model.defaultModel,
          thinkingLevel: liveConfig.model.thinkingLevel,
        },
      });
      const candidateTicket = {
        providerOverride: reqProvider ?? ticket.providerOverride,
        modelOverride: reqModelId ?? ticket.modelOverride,
        thinkingOverride: reqThinking ?? ticket.thinkingOverride,
        modelEscalation: reqProvider || reqModelId ? undefined : ticket.modelEscalation,
        runEpoch: ticket.runEpoch,
      };
      const nextEffective = resolveWorkerEffectiveModel({
        ticket: candidateTicket,
        rolePreset,
        defaultModel: {
          provider: liveConfig.model.defaultProvider,
          modelId: liveConfig.model.defaultModel,
          thinkingLevel: liveConfig.model.thinkingLevel,
        },
      });
      const resolvedProvider = nextEffective.provider?.trim() || ports.fallbackProviderId;
      try {
        resolveModelThinkingSelection(
          models,
          resolvedProvider,
          nextEffective.modelId,
          nextEffective.thinkingLevel,
          normalizeModelGatewayConfig(liveConfig.model),
        );
      } catch (error) {
        throw new ProjectError(
          400,
          "invalid_model",
          error instanceof Error ? error.message : "目标模型配置无效。",
        );
      }
      if (ticket.quotaPause?.kind === "usage_cap" && usageCaps.snapshot().capped) {
        const targetBaseUrl = this.#resolveTargetModelBaseUrl(
          resolvedProvider,
          nextEffective.modelId,
          liveConfig.model,
        );
        if (!isLoopbackBaseUrl(targetBaseUrl)) {
          throw new ProjectError(
            403,
            "usage_cap_bypass_denied",
            "当前仍处于用量上限保护期，严禁通过切换云端模型绕过预算；请放宽预算上限、等待重置，或切换至本机模型。",
          );
        }
      }
      modelChanged =
        (nextEffective.provider ?? ports.fallbackProviderId) !== (prevEffective.provider ?? ports.fallbackProviderId) ||
        nextEffective.modelId !== prevEffective.modelId;
    }

    // If the ticket is still running (P1-3 stuck mid-run), cleanly abort the active run before launching nextEpoch.
    let releaseCleanupPending = Boolean(ticket.cleanupPending);
    if (ticket.status === "running" || ticket.status === "pausing") {
      const conversations = [
        ticket.workerConversationId,
        ...Object.values(snapshot?.subagents ?? {})
          .filter((s) => s.ticketId === ticketId)
          .map((s) => s.conversationId),
      ];
      await Promise.all(
        conversations.map(async (id) => {
          const conv = await harness.conversation(id as ConversationId, context);
          if (conv) await conv.abort(context, { background: true });
        }),
      );
      if (ticket.activeTaskId !== undefined) {
        await harness.abortTask(ticket.activeTaskId as never, context);
      }
      const released = await ports.reconciler.releaseTicketExecution(ticket, { park: true });
      releaseCleanupPending = released.cleanupPending;
    }

    const cleanNote = input.note?.trim()
      ? sanitizeTicketQuotaText(input.note, ports.redact, 1500)
      : undefined;
    const basePrompt = modelChanged
      ? "The user resumed this task with an updated model. Inspect the current workspace state and prior tool results first, then continue without repeating completed side effects."
      : "The user resumed this task after quota pause. Inspect the current workspace state and prior tool results first, then continue without repeating completed side effects.";
    const resumePrompt = [basePrompt, cleanNote].filter(Boolean).join("\n\n");
    const cleanCmdId = input.commandId?.trim();

    const committed = await harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const live = state.tickets[ticketId];
      if (!live) throw new ProjectError(404, "ticket_not_found", "任务不存在。");
      if (live.status === "stopped" || live.status === "closed") {
        throw new ProjectError(409, "ticket_stopped", "任务已停止或已关闭，不能恢复。");
      }
      if (live.projectId) {
        const project = assertProjectBinding(await tx.doc(KuloProjectsDoc), live.projectId);
        if (
          project.grantRevision !== live.grantRevision ||
          project.directoryId !== live.directoryId ||
          project.deviceId !== live.envId ||
          project.workspaceDir !== live.workspaceDir
        ) {
          throw new ProjectError(409, "project_binding_changed", "项目位置或授权已变更，请创建新任务。");
        }
        if (live.projectRevision !== undefined && project.revision !== live.projectRevision) {
          throw new ProjectError(
            409,
            "project_revision_changed",
            "项目基线版本已变更，为避免盲目覆写请先核对差异或创建新任务。",
          );
        }
      }
      const stillEligible =
        (live.status === "waiting" && live.waiting?.reason === "quota") ||
        Boolean(live.runHealthStuck);
      if (!stillEligible) {
        await writeDeliveryReceipt(tx, intent, { ticketId: live.id });
        return {
          card: toTicketCardView(live, liveConfig.roles, liveConfig.externalClients),
          resumed: false,
          created: false,
          updatedTicket: undefined as TicketRecord | undefined,
        };
      }

      if (live.externalExecution) {
        if (reqModelId !== undefined) {
          live.modelOverride = reqModelId;
          live.externalExecution.modelId = reqModelId;
        }
        if (resolvedExternalThinking.apply) {
          if (resolvedExternalThinking.value !== undefined) {
            live.thinkingOverride = resolvedExternalThinking.value;
            live.externalExecution.thinkingLevel = resolvedExternalThinking.value;
          } else {
            delete live.thinkingOverride;
            delete live.externalExecution.thinkingLevel;
          }
        }
      } else {
        if (reqProvider !== undefined) live.providerOverride = reqProvider;
        if (reqModelId !== undefined) live.modelOverride = reqModelId;
        if (reqThinking !== undefined) live.thinkingOverride = reqThinking;
      }

      const now = Date.now();
      const prevEpoch = live.runEpoch;
      const preserveEscalation =
        !live.externalExecution &&
        reqProvider === undefined &&
        reqModelId === undefined &&
        !live.providerOverride &&
        !live.modelOverride &&
        live.modelEscalation?.runEpoch === prevEpoch;
      delete live.quotaPause;
      delete live.runHealthStuck;
      if (!preserveEscalation) delete live.modelEscalation;
      live.recovery = undefined;
      live.autoRecoverySuppressed = undefined;
      live.updatedAt = now;

      recordProcessedCommand(state, cleanCmdId, live.id, "resume_override");
      await writeDeliveryReceipt(tx, intent, { ticketId: live.id });

      const online = areTicketDevicesOnline(live, (id) => envManager.getEnvDescriptor(id));
      const cleanupPending = releaseCleanupPending || Boolean(live.cleanupPending);
      if (!online || cleanupPending || hasActiveSubagents(state, live.id)) {
        live.resumePrompt = resumePrompt;
        live.wakePending = true;
        live.cleanupPending = cleanupPending;
        transitionTicketStatus(live, "waiting", now);
        live.waiting = {
          reason: "env",
          since: now,
          detail: cleanupPending ? "等待确认旧执行已清理" : "等待执行设备上线",
        };
        return {
          card: toTicketCardView(live, liveConfig.roles, liveConfig.externalClients),
          resumed: true,
          created: false,
          updatedTicket: JSON.parse(JSON.stringify(live)) as TicketRecord,
        };
      }

      const nextEpoch = live.runEpoch + 1;
      if (preserveEscalation && live.modelEscalation) {
        live.modelEscalation = { ...live.modelEscalation, runEpoch: nextEpoch };
      }
      if (live.externalExecution) {
        delete live.externalExecution.runId;
        delete live.externalExecution.pendingPermissions;
      }
      const taskId = await tx.createTask(
        ports.workerTicketTask,
        { ticketId: live.id, runEpoch: nextEpoch, promptOverride: resumePrompt },
        {
          ownership: { kind: "conversation" },
          conversationId: (live.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId,
          background: true,
        },
      );
      live.runEpoch = nextEpoch;
      const resolvedMode = resolveEffectiveExecutionMode({
        hubTrustMode: envManager.getExecutionTrustMode(),
        descriptor: envManager.getEnvDescriptor(live.envId),
        isLocal: envManager.isLocalEnv(live.envId),
        requireOsIsolation: Boolean(live.readOnly || live.workspaceStaging?.mode === "staged"),
      });
      state.ticketExecutionModes ??= {};
      state.ticketExecutionModes[live.id] = { runEpoch: nextEpoch, mode: resolvedMode };
      transitionTicketStatus(live, "queued", now);
      live.activeTaskId = Number(taskId);
      live.waiting = undefined;
      if (live.schedule) live.schedule.nextRunAt = null;
      live.resumePrompt = undefined;
      live.resumeAttachmentIds = undefined;
      live.wakePending = undefined;
      live.cleanupPending = false;
      live.latestReport = {
        state: "progress",
        summary: modelChanged ? "已切换模型，正在继续执行。" : "已恢复任务，等待继续执行。",
        at: now,
      };
      return {
        card: toTicketCardView(live, liveConfig.roles, liveConfig.externalClients),
        resumed: true,
        created: true,
        updatedTicket: JSON.parse(JSON.stringify(live)) as TicketRecord,
      };
    }, context);

    if (committed.resumed && committed.updatedTicket) {
      this.#recentResumes.set(ticketId, {
        key: dedupKey,
        at: Date.now(),
        epoch: committed.updatedTicket.runEpoch,
      });
      if (!committed.updatedTicket.externalExecution) {
        await ports.syncWorkerConversation(committed.updatedTicket, context);
      }
      if (externalClientIdToRefresh) {
        ports.refreshExternalQuota?.(externalClientIdToRefresh);
      }
      if (committed.created) {
        runtimeGates.resumeIfNotRecovering();
      } else {
        void ports.reconciler.queueEnvReconcile();
      }
      await runtimeGates.broadcastTickets(context);
    }

    return {
      ticket: committed.card,
      resumed: committed.resumed,
    };
  }
}
