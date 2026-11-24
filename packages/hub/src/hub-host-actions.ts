import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { validateHostMaintenanceCommands, type EnvManager } from "@kulo/env";
import { classifyShellSafetyFloor, resolveEffectiveExecutionMode } from "@kulo/protocol";
import {
  buildHostActionConfirmCard,
  effectiveConfirmationEffect,
  hostActionFingerprint,
  type KuloActionConfirmations,
  type PendingActionConfirmation,
} from "./action-confirmations.js";
import {
  submitAutomaticChatInput,
  type AutomaticChatInputDraft,
} from "./chat-control.js";
import { chatRoutingData } from "./chat-submissions.js";
import type { KuloConnections } from "./connections.js";
import { reconcileTopicRoutingTarget, resolveHostActionTargetEnv } from "./env-routing-policy.js";
import {
  executeApprovedHostAction,
  type ExecuteApprovedHostActionDeps,
} from "./host-action-execution.js";
import type {
  HubRuntimeGates,
  InlineDispatchWaiters,
  TurnContextReader,
} from "./hub-kernel-ports.js";
import type { KuloProjects } from "./projects.js";
import { formatHostActionRequestMessage, formatHostActionResultMessage } from "./prompts.js";
import { CoordinatorEventEntry, KuloStateDoc, isTicketUnfinished } from "./state.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import type {
  HostActionCaller,
  HostActionDecideOutcome,
  HostActionRunOutcome,
} from "./tools-host-action.js";

export function buildHostActionResultDraft(params: {
  requestId: string;
  refId: string;
  envId: string;
  envName: string;
  body: string;
  instruction: string;
  redact: (text: string) => string;
}): AutomaticChatInputDraft {
  const safeEnvName = params.redact(params.envName);
  const content = params.redact(
    formatHostActionResultMessage({ body: params.redact(params.body), instruction: params.instruction }),
  );
  return {
    type: "input",
    content,
    whenBusy: "followUp",
    requestId: params.requestId,
    entry: {
      kind: CoordinatorEventEntry.kind,
      data: {
        eventKind: "host_action_result",
        requestId: params.refId,
        envId: params.envId,
        envName: safeEnvName,
        createdAt: Date.now(),
      },
    },
  };
}

export interface HubHostActionsDeps {
  harness: Harness;
  envManager: Pick<EnvManager, "getEnvDescriptor" | "getExecutionTrustMode" | "isLocalEnv" | "listEnvs" | "localEnvId" | "pickDefaultEnvId" | "requestHostAction">;
  projects: Pick<KuloProjects, "get">;
  actionConfirmations: KuloActionConfirmations;
  connectionManager: Pick<KuloConnections, "redact">;
  inlineWaiters: Pick<InlineDispatchWaiters, "notify">;
  runtimeGates: Pick<HubRuntimeGates, "resumeIfNotRecovering" | "broadcastTickets" | "recordTicketOutwardAction">;
  turnContext?: TurnContextReader;
  steerTicket: (
    params: { ticketId: string; commandId: string; text: string; originConversationId?: number; internalResume?: boolean },
    context?: Context,
  ) => Promise<unknown>;
}

export class HubHostActions {
  readonly #deps: HubHostActionsDeps;

  constructor(deps: HubHostActionsDeps) {
    this.#deps = deps;
  }

  execDeps(): ExecuteApprovedHostActionDeps {
    return {
      actionConfirmations: this.#deps.actionConfirmations,
      envManager: this.#deps.envManager,
      redact: (text) => this.#deps.connectionManager.redact(text),
      recordOutwardAction: (ticketId, summary, context) =>
        this.#deps.runtimeGates.recordTicketOutwardAction(ticketId, undefined, "host_action", summary, context),
    };
  }

  async #resolveTargetEnv(
    caller: HostActionCaller,
    requestedEnvId: string | undefined,
    context: Context,
  ): Promise<{ envId: string; envName: string; routedToHubFallback?: boolean }> {
    if (caller.kind === "worker") {
      const descriptor = this.#deps.envManager.getEnvDescriptor(caller.envId);
      if (!descriptor) throw new Error(`找不到执行设备 '${caller.envId}'。`);
      if (!descriptor.online) throw new Error(`目标设备 '${descriptor.name}' (${caller.envId}) 当前离线。`);
      if (descriptor.executionKind === "native-device") {
        throw new Error(`设备 '${descriptor.name}' 是 Android 手机，不支持电脑本机操作。`);
      }
      return { envId: descriptor.id, envName: descriptor.name || descriptor.id };
    }
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const topicId = caller.isSettings ? undefined : state?.conversationToTopic?.[String(caller.conversationId)];
    const topic = topicId ? state?.topics?.[topicId] : undefined;
    const projectDeviceId = topic?.projectId
      ? (await this.#deps.projects.get(topic.projectId, context).catch(() => undefined))?.deviceId
      : undefined;
    let messageTargetDeviceId: string | undefined;
    let sourceDeviceId: string | undefined;
    let currentText: string | undefined;
    let priorUserTurns: Awaited<ReturnType<TurnContextReader["recentPriorUserTurns"]>> | undefined;
    if (!requestedEnvId?.trim() && this.#deps.turnContext) {
      const inputs = await this.#deps.turnContext
        .currentControlInputs(caller.conversationId, context, caller.toolTaskId)
        .catch(() => []);
      const first = chatRoutingData(inputs[0]);
      messageTargetDeviceId = reconcileTopicRoutingTarget(first.targetDeviceId, topic?.targetDeviceId, Boolean(topic));
      sourceDeviceId = first.source?.deviceId;
      currentText = first.text;
      if (!projectDeviceId && !messageTargetDeviceId && !topic?.targetDeviceId) {
        priorUserTurns = await this.#deps.turnContext
          .recentPriorUserTurns(
            caller.conversationId,
            context,
            caller.toolTaskId,
            new Set(inputs.map((entry) => entry.id)),
          )
          .catch(() => []);
      }
    }
    const resolved = resolveHostActionTargetEnv({
      requestedEnvId,
      projectDeviceId,
      messageTargetDeviceId,
      topicTargetDeviceId: topic?.targetDeviceId,
      sourceDeviceId,
      currentText,
      priorUserTurns,
      envs: this.#deps.envManager.listEnvs(),
      getEnvDescriptor: (id) => this.#deps.envManager.getEnvDescriptor(id),
      localEnvId: this.#deps.envManager.localEnvId,
      pickDefaultEnvId: () => this.#deps.envManager.pickDefaultEnvId(),
    });
    if (!resolved.ok) throw new Error(resolved.message);
    return {
      envId: resolved.envId,
      envName: resolved.descriptor.name || resolved.envId,
      ...(resolved.routedToHubFallback ? { routedToHubFallback: true } : {}),
    };
  }

  async inspect(
    caller: HostActionCaller,
    input: {
      envId?: string;
      scope: "summary" | "processes" | "ports";
      filter?: string;
      paths?: string[];
      limit?: number;
    },
    context: Context,
  ) {
    const { envId, envName, routedToHubFallback } = await this.#resolveTargetEnv(caller, input.envId, context);
    const result = await this.#deps.envManager.requestHostAction(
      envId,
      {
        kind: "inspect",
        scope: input.scope,
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.paths?.length ? { paths: input.paths } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      context.abortSignal,
    );
    return { envId, envName, ...(routedToHubFallback ? { routedToHubFallback: true } : {}), result };
  }

  async run(
    caller: HostActionCaller,
    input: {
      envId?: string;
      summary: string;
      commands: string[];
      cwd?: string;
      timeoutMs?: number;
    },
    context: Context,
  ): Promise<HostActionRunOutcome> {
    if (caller.kind === "worker" && caller.readOnly) {
      throw new Error("当前角色为只读模式，不能执行本机变更命令。");
    }
    const { envId, envName, routedToHubFallback } = await this.#resolveTargetEnv(caller, input.envId, context);
    const targetDescriptor = this.#deps.envManager.getEnvDescriptor(envId);
    const workerState = caller.kind === "worker"
      ? await this.#deps.harness.snapshot(KuloStateDoc, context)
      : undefined;
    const frozenWorkerMode = caller.kind === "worker"
      ? workerState?.ticketExecutionModes?.[caller.ticketId]
      : undefined;
    const baseTrustMode =
      caller.kind === "worker" && frozenWorkerMode?.runEpoch === caller.runEpoch
        ? frozenWorkerMode.mode
        : this.#deps.envManager.getExecutionTrustMode();
    const executionMode = resolveEffectiveExecutionMode({
      hubTrustMode: baseTrustMode,
      descriptor: targetDescriptor,
      isLocal: this.#deps.envManager.isLocalEnv(envId),
    });
    validateHostMaintenanceCommands(input.commands, { executionMode });

    // Main Agent holds full personal-assistant authority and executes host actions directly.
    if (caller.kind === "orchestrator") {
      const result = await this.#deps.envManager.requestHostAction(
        envId,
        {
          kind: "run",
          commands: input.commands,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          executionMode,
        },
        context.abortSignal,
      );
      return { status: "executed", envId, envName, ...(routedToHubFallback ? { routedToHubFallback: true } : {}), result };
    }

    if (caller.isSubagent) {
      throw new Error("子智能体不能直接申请本机运维操作；请将待执行的命令清单返回给父级 Worker，由父级 Worker 统一提交给主智能体研判。");
    }

    const originConversationId = caller.originConversationId || Number(ROOT_CONVERSATION_ID);
    const state = workerState;
    const topicId = state?.conversationToTopic?.[String(originConversationId)];
    const topic = topicId ? state?.topics?.[topicId] : undefined;
    if (topic?.deletedAt) throw new Error("所属会话已删除。");

    const fingerprint = hostActionFingerprint({
      envId,
      commands: input.commands,
      cwd: input.cwd,
      ticketId: caller.ticketId,
      runEpoch: caller.runEpoch,
      requestId: caller.callId,
    });
    const existing = await this.#deps.actionConfirmations.lookup(originConversationId, "host_action", fingerprint, context);
    if (existing?.status === "approved" && !existing.executed) {
      const approvedMode = existing.payload.kind === "host_action" && existing.payload.executionMode
        ? existing.payload.executionMode
        : executionMode;
      const result = await this.#deps.envManager.requestHostAction(
        envId,
        {
          kind: "run",
          commands: input.commands,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          executionMode: approvedMode,
        },
        context.abortSignal,
      );
      await this.#deps.actionConfirmations.markExecuted(existing.id, context);
      return { status: "executed", envId, envName, result };
    }

    const redactedSummary = this.#deps.connectionManager.redact(input.summary);
    const confirmation = await this.#deps.actionConfirmations.createPendingOrchestratorRequest({
      conversationId: originConversationId,
      kind: "host_action",
      fingerprint,
      payload: {
        kind: "host_action",
        envId,
        envName,
        summary: redactedSummary,
        commands: [...input.commands],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ticketId: caller.ticketId,
        runEpoch: caller.runEpoch,
        requestId: caller.callId,
        executionMode,
      },
    }, context);

    const now = Date.now();
    await this.#deps.harness.commit(async (tx) => {
      const doc = await tx.doc(KuloStateDoc);
      const ticket = doc.tickets[caller.ticketId];
      if (!ticket || ticket.status !== "running" || ticket.runEpoch !== caller.runEpoch) return;
      ticket.waiting = {
        reason: "coordinator",
        since: now,
        detail: redactedSummary,
        waitToken: `host-action-req:${confirmation.id}`,
        requestId: confirmation.id,
      };
      ticket.updatedAt = now;
    }, context);
    this.#deps.inlineWaiters.notify(caller.ticketId);
    await this.#deps.runtimeGates.broadcastTickets(context);

    return {
      status: "awaiting_orchestrator_decision",
      requestId: confirmation.id,
      envId,
      envName,
      message: "已将本机操作申请提交给主智能体研判，当前任务已挂起等待裁决。",
    };
  }

  async relayRequest(ticketId: string): Promise<void> {
    const state = await this.#deps.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const ticket = state?.tickets[ticketId];
    if (
      !ticket ||
      ticket.status !== "waiting" ||
      ticket.waiting?.reason !== "coordinator" ||
      !ticket.waiting.waitToken?.startsWith("host-action-req:")
    ) {
      return;
    }
    const requestId = ticket.waiting.waitToken.slice("host-action-req:".length);
    const confirmation = await this.#deps.actionConfirmations.getById(requestId, BACKGROUND_CONTEXT);
    if (!confirmation || confirmation.status !== "pending_orchestrator" || confirmation.payload.kind !== "host_action") {
      return;
    }
    const origin = await this.#deps.harness.conversation(
      (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (!origin) return;
    const payload = confirmation.payload;
    const safeEnvName = this.#deps.connectionManager.redact(payload.envName);
    const redactedCommands = payload.commands.map((cmd) => this.#deps.connectionManager.redact(cmd));
    const message = formatHostActionRequestMessage({
      requestId: confirmation.id,
      ticketId: ticket.id,
      title: ticket.title,
      envId: payload.envId,
      envName: safeEnvName,
      cwd: payload.cwd,
      summary: this.#deps.connectionManager.redact(payload.summary),
      commands: redactedCommands,
    });
    await this.#deps.harness.commit(async (tx) => {
      await injectEventToolsInTx(tx, origin.id, ["kulo_host_action_decide"]);
      return submitAutomaticChatInput(tx, origin, {
        type: "input",
        content: this.#deps.connectionManager.redact(message),
        whenBusy: "followUp",
        requestId: `kulo:host-action-request:${confirmation.id}`,
        entry: {
          kind: CoordinatorEventEntry.kind,
          data: {
            eventKind: "host_action_request",
            requestId: confirmation.id,
            ticketId: ticket.id,
            envId: payload.envId,
            envName: safeEnvName,
            createdAt: Date.now(),
          },
        },
      });
    }, BACKGROUND_CONTEXT);
    this.#deps.runtimeGates.resumeIfNotRecovering();
    await this.#deps.runtimeGates.broadcastTickets(BACKGROUND_CONTEXT);
  }

  async decide(
    caller: Extract<HostActionCaller, { kind: "orchestrator" }>,
    input: {
      requestId: string;
      decision: "approve" | "deny" | "ask_user";
      reason?: string;
    },
    context: Context,
  ): Promise<HostActionDecideOutcome> {
    const pending = await this.#deps.actionConfirmations.getById(input.requestId, context);
    if (!pending || pending.payload.kind !== "host_action" || pending.conversationId !== caller.conversationId) {
      throw new Error(`找不到属于当前会话的本机操作申请 '${input.requestId}'。`);
    }
    if (pending.executed || (pending.status !== "pending_orchestrator" && pending.status !== "pending")) {
      return { status: "already_resolved", requestId: pending.id, message: "该本机操作申请已被处理完成。" };
    }
    const payload = pending.payload;

    if (input.decision === "ask_user") {
      const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
      const topicId = state?.conversationToTopic?.[String(caller.conversationId)];
      const redactedSummary = this.#deps.connectionManager.redact(payload.summary);
      const redactedReason = input.reason ? this.#deps.connectionManager.redact(input.reason) : undefined;
      const redactedCommands = payload.commands.map((cmd) => this.#deps.connectionManager.redact(cmd));
      const built = buildHostActionConfirmCard({
        envName: payload.envName,
        summary: redactedSummary,
        commands: redactedCommands,
        cwd: payload.cwd,
        reason: redactedReason,
      });
      const { confirmation } = await this.#deps.actionConfirmations.attachCardToRequest(
        pending.id,
        {
          ...(topicId ? { topicId } : {}),
          ...(payload.ticketId ? { ticketId: payload.ticketId } : {}),
          callId: caller.callId,
          cardInput: built.input,
          logicalIds: built.logicalIds,
        },
        context,
      );
      if (payload.ticketId) {
        const now = Date.now();
        await this.#deps.harness.commit(async (tx) => {
          const doc = await tx.doc(KuloStateDoc);
          const ticket = doc.tickets[payload.ticketId!];
          if (!ticket || !isTicketUnfinished(ticket)) return;
          ticket.waiting = {
            reason: "user",
            since: now,
            detail: redactedReason ? `${redactedSummary}（${redactedReason}）` : redactedSummary,
            waitToken: `host-action:${confirmation.cardId}`,
            cardId: confirmation.cardId,
            requestId: confirmation.id,
            options: [
              { id: "confirm", label: "允许", tone: "primary" },
              { id: "cancel", label: "拒绝", tone: "secondary" },
            ],
          };
          ticket.updatedAt = now;
        }, context);
        await this.#deps.runtimeGates.broadcastTickets(context);
      }
      return {
        status: "awaiting_user_confirmation",
        requestId: confirmation.id,
        cardId: confirmation.cardId!,
        envId: payload.envId,
        envName: payload.envName,
        message: "已向用户弹出本机操作确认卡片（含允许/拒绝/手动输入），对话不阻塞；若用户直接在聊天中回复，你可以再次调用 kulo_host_action_decide 直接执行并自动收口该卡片。",
      };
    }

    const openCardId = pending.cardId;
    if (input.decision === "deny") {
      const resolved = await this.#deps.actionConfirmations.resolveProgrammatically(
        pending.id,
        {
          status: "denied",
          selectedChoiceId: "cancel",
          resultSummary: openCardId ? "已通过对话拒绝" : "主智能体已拒绝",
          markExecuted: true,
        },
        context,
      );
      if (!resolved) {
        return { status: "already_resolved", requestId: pending.id, message: "该本机操作申请已被处理完成。" };
      }
      if (payload.ticketId) {
        const reasonText = input.reason ? this.#deps.connectionManager.redact(input.reason) : "主智能体评估后拒绝了该本机操作。";
        await this.#deps.steerTicket({
          ticketId: payload.ticketId,
          commandId: `host-action:${resolved.id}:denied`,
          text: `主智能体拒绝了在 ${payload.envName} (${payload.envId}) 上执行的本机操作「${payload.summary}」。原因/指引：${reasonText}\n请勿重复同一操作，按指引调整方案或向主智能体汇报。`,
          originConversationId: caller.conversationId,
        }, context);
      }
      return {
        status: "denied",
        requestId: resolved.id,
        ...(payload.ticketId ? { ticketId: payload.ticketId } : {}),
        ...(openCardId ? { settledCardId: openCardId } : {}),
        message: "已拒绝该本机操作并通知 Worker 调整方案。",
      };
    }

    // decision === "approve"
    if (!openCardId) {
      const frozenTrusted = payload.executionMode === "trusted";
      for (const cmd of payload.commands) {
        const floor = classifyShellSafetyFloor(cmd);
        if (floor.verdict === "block") {
          throw new Error(
            `本机操作命令触发毁灭性安全底线（${floor.reason ?? "catastrophic"}），禁止放行。`,
          );
        }
        if (floor.verdict !== "safe" && !frozenTrusted) {
          throw new Error(
            `本机操作命令包含无法静态完整解析的 Shell 语法（${floor.reason ?? "unreadable"}），禁止主智能体静默自动放行；请改用 decision='ask_user' 由用户亲自确认。`,
          );
        }
      }
    }
    const resolved = await this.#deps.actionConfirmations.resolveProgrammatically(
      pending.id,
      {
        status: "approved",
        selectedChoiceId: "confirm",
        resultSummary: openCardId ? "已通过对话允许" : "主智能体已允许",
        markExecuted: false,
      },
      context,
    );
    if (!resolved) {
      return { status: "already_resolved", requestId: pending.id, message: "该本机操作申请已被处理完成。" };
    }
    const exec = await executeApprovedHostAction(this.execDeps(), resolved, { actorLabel: "主智能体", context });
    if (exec.status === "already_dispatched") {
      return { status: "already_resolved", requestId: resolved.id, message: "该本机操作申请已发出或已处理完成，切勿重复执行。" };
    }
    if (exec.status === "failed") throw exec.error;
    if (payload.ticketId) {
      await this.#deps.steerTicket({
        ticketId: payload.ticketId,
        commandId: `host-action:${resolved.id}:approved`,
        text: `${exec.summaryText}\n请基于实际执行结果继续验证并完成当前任务。`,
        originConversationId: caller.conversationId,
      }, context);
    }
    return {
      status: "executed",
      requestId: resolved.id,
      envId: payload.envId,
      envName: payload.envName,
      result: exec.result,
      ...(openCardId ? { settledCardId: openCardId } : {}),
      message: "已批准并执行完成，Worker 已恢复继续推进（如无需向用户汇报，可直接回复 [COORDINATOR_OK]）。",
    };
  }

  async executeResolvedHostAction(
    resolved: PendingActionConfirmation,
    conversationId: number,
  ): Promise<void> {
    if (resolved.payload.kind !== "host_action" || effectiveConfirmationEffect(resolved) !== "none") return;
    const payload = resolved.payload;
    const refId = resolved.cardId ?? resolved.id;
    if (resolved.status !== "approved") {
      await this.#deps.actionConfirmations.markOutcome(resolved.id, "confirmed");
      if (payload.ticketId) {
        const safeEnvName = this.#deps.connectionManager.redact(payload.envName);
        const safeSummary = this.#deps.connectionManager.redact(payload.summary);
        try {
          await this.#deps.steerTicket({
            ticketId: payload.ticketId,
            commandId: `host-action:${refId}:denied`,
            text: `用户拒绝了在 ${safeEnvName} (${payload.envId}) 上执行的本机操作「${safeSummary}」。请勿再次尝试同一操作，直接按现状向主智能体汇报。`,
            internalResume: true,
          });
        } catch (error) {
          console.warn("[KuloConfirmation] Failed to resume worker after host action denial", error instanceof Error ? error.message : String(error));
        }
      }
      return;
    }

    const exec = await executeApprovedHostAction(this.execDeps(), resolved, { actorLabel: "用户" });
    if (exec.status === "already_dispatched") return;
    const summaryText = exec.summaryText;

    if (payload.ticketId) {
      try {
        await this.#deps.steerTicket({
          ticketId: payload.ticketId,
          commandId: `host-action:${refId}:approved`,
          text: `${summaryText}\n请基于实际执行结果继续验证并完成当前任务。`,
          internalResume: true,
        });
      } catch (error) {
        console.warn("[KuloConfirmation] Failed to resume worker after host action execution", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const origin = await this.#deps.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (origin) {
      await this.#deps.harness.commit(
        (tx) =>
          submitAutomaticChatInput(
            tx,
            origin,
            buildHostActionResultDraft({
              requestId: `kulo:host-action-result:${refId}`,
              refId,
              envId: payload.envId,
              envName: payload.envName,
              body: summaryText,
              instruction: "请用当前对话语言向用户简洁反馈实际执行结果，不要暴露内部卡片或工单编号。",
              redact: (text) => this.#deps.connectionManager.redact(text),
            }),
          ),
        BACKGROUND_CONTEXT,
      );
    }
  }
}
