import type { Context } from "@earendil-works/chord/context";
import type { EnvManager } from "@kulo/env";
import type { KuloActionConfirmations, PendingActionConfirmation } from "./action-confirmations.js";

export interface ExecuteApprovedHostActionDeps {
  actionConfirmations: Pick<KuloActionConfirmations, "markDispatched" | "markOutcome">;
  envManager: Pick<EnvManager, "requestHostAction">;
  redact: (text: string) => string;
  recordOutwardAction: (ticketId: string, summary: string, context?: Context) => Promise<void>;
}

export type ExecuteApprovedHostActionResult =
  | { status: "already_dispatched" }
  | {
      status: "executed";
      result: Awaited<ReturnType<EnvManager["requestHostAction"]>>;
      summaryText: string;
    }
  | {
      status: "failed";
      preDispatch: boolean;
      error: unknown;
      errorMessage: string;
      summaryText: string;
    };

/**
 * Unified idempotent executor for approved `host_action` confirmations across
 * Task Detail (`steerTicket`), orchestrator (`#hostActionDecide`), and chat UI cards.
 * Enforces the durable `markDispatched -> execute -> markOutcome` protocol without re-entering ticket locks.
 */
export async function executeApprovedHostAction(
  deps: ExecuteApprovedHostActionDeps,
  resolved: PendingActionConfirmation,
  options: { actorLabel: "用户" | "主智能体"; context?: Context },
): Promise<ExecuteApprovedHostActionResult> {
  if (resolved.payload.kind !== "host_action") {
    return { status: "already_dispatched" };
  }
  const payload = resolved.payload;
  const { context, actorLabel } = options;

  const claimed = await deps.actionConfirmations.markDispatched(resolved.id, context);
  if (!claimed) {
    return { status: "already_dispatched" };
  }
  if (payload.ticketId) {
    await deps.recordOutwardAction(payload.ticketId, `host_action:${payload.summary}`, context);
  }

  try {
    const result = await deps.envManager.requestHostAction(
      payload.envId,
      {
        kind: "run",
        commands: payload.commands,
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
        ...(payload.executionMode ? { executionMode: payload.executionMode } : {}),
      },
      context?.abortSignal,
    );
    await deps.actionConfirmations.markOutcome(resolved.id, "confirmed", undefined, context);
    const safeOut = deps.redact(JSON.stringify(result));
    const safeEnvName = deps.redact(payload.envName);
    const safeSummary = deps.redact(payload.summary);
    return {
      status: "executed",
      result,
      summaryText: `${actorLabel}已批准并在 ${safeEnvName} (${payload.envId}) 上执行完成本机操作「${safeSummary}」。执行结果：\n${safeOut}`,
    };
  } catch (error) {
    const errMsg = deps.redact(error instanceof Error ? error.message : "本机操作执行失败");
    const safeEnvName = deps.redact(payload.envName);
    const safeSummary = deps.redact(payload.summary);
    const errCode = (error as { code?: unknown })?.code;
    const preDispatch = errCode === "env_offline" || errCode === "env_unavailable";
    await deps.actionConfirmations.markOutcome(
      resolved.id,
      preDispatch ? "failed_pre_dispatch" : "unknown",
      errMsg,
      context,
    );
    const summaryText = preDispatch
      ? `${actorLabel}已批准在 ${safeEnvName} (${payload.envId}) 上执行本机操作「${safeSummary}」，但目标设备当时离线未发出：${errMsg}`
      : `${actorLabel}已批准在 ${safeEnvName} (${payload.envId}) 上执行本机操作「${safeSummary}」，命令已发出但回执未决（未自动重放）：${errMsg}。请先通过只读命令核验实际状态，切勿盲目重复执行。`;
    return {
      status: "failed",
      preDispatch,
      error,
      errorMessage: errMsg,
      summaryText,
    };
  }
}
