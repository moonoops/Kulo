import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  HOST_ACTION_MAX_COMMAND_CHARS,
  HOST_ACTION_MAX_COMMANDS,
  HOST_ACTION_MAX_PATHS,
  HOST_ACTION_MAX_TIMEOUT_MS,
  redactSecrets,
  type HostActionResult,
  type HostInspectScope,
} from "@kulo/protocol";
import { resolveTicketExecutionScope } from "./state.js";
import { isMainOrchestratorApi } from "./settings-doc.js";

export type HostActionCaller =
  | { kind: "orchestrator"; conversationId: number; callId: string }
  | {
      kind: "worker";
      conversationId: number;
      callId: string;
      ticketId: string;
      runEpoch: number;
      envId: string;
      readOnly: boolean;
      isSubagent: boolean;
      originConversationId: number;
    };

export type HostActionRunOutcome =
  | { status: "executed"; envId: string; envName: string; result: HostActionResult }
  | { status: "awaiting_orchestrator_decision"; requestId: string; envId: string; envName: string; message: string }
  | { status: "awaiting_user_confirmation"; cardId: string; envId: string; envName: string; message: string };

export type HostActionDecideOutcome =
  | { status: "executed"; requestId: string; envId: string; envName: string; result: HostActionResult; settledCardId?: string; message: string }
  | { status: "denied"; requestId: string; ticketId?: string; settledCardId?: string; message: string }
  | { status: "awaiting_user_confirmation"; requestId: string; cardId: string; envId: string; envName: string; message: string }
  | { status: "already_resolved"; requestId: string; message: string };

export interface HostActionController {
  inspect(
    caller: HostActionCaller,
    input: {
      envId?: string;
      scope: HostInspectScope;
      filter?: string;
      paths?: string[];
      limit?: number;
    },
    context: Context,
  ): Promise<{ envId: string; envName: string; result: HostActionResult }>;
  run(
    caller: HostActionCaller,
    input: {
      envId?: string;
      summary: string;
      commands: string[];
      cwd?: string;
      timeoutMs?: number;
    },
    context: Context,
  ): Promise<HostActionRunOutcome>;
  decide?(
    caller: Extract<HostActionCaller, { kind: "orchestrator" }>,
    input: {
      requestId: string;
      decision: "approve" | "deny" | "ask_user";
      reason?: string;
    },
    context: Context,
  ): Promise<HostActionDecideOutcome>;
}

async function resolveCaller(
  api: ToolExecutionApi,
  audience: HostActionCaller["kind"],
  context: Context,
): Promise<HostActionCaller> {
  context.abortSignal?.throwIfAborted();
  const main = await isMainOrchestratorApi(api, context);
  context.abortSignal?.throwIfAborted();
  const conversationId = Number(api.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId < 0) {
    throw new Error("本机操作调用来源无效。");
  }
  if (main.allowed) {
    if (audience !== "orchestrator") {
      throw new Error("本机操作调用入口不匹配。");
    }
    if (!main.isSettings) {
      const topicId = main.state?.conversationToTopic?.[String(api.conversationId)] ?? "root";
      if (main.state?.topics?.[topicId]?.deletedAt) {
        throw new Error("当前会话已删除。");
      }
    }
    return { kind: "orchestrator", conversationId, callId: String(api.callId) };
  }
  if (audience !== "worker") {
    throw new Error("本机操作调用入口不匹配。");
  }
  const scope = resolveTicketExecutionScope(main.state, api.conversationId);
  if (!scope || scope.ticket.status !== "running" || (scope.subagent && scope.subagent.state !== "running")) {
    throw new Error("本机操作需要正在运行的任务。");
  }
  if (scope.ticket.executionDomain === "android") {
    throw new Error("Android 任务不支持电脑本机诊断或运维操作。");
  }
  return {
    kind: "worker",
    conversationId,
    callId: String(api.callId),
    ticketId: scope.ticket.id,
    runEpoch: scope.ticket.runEpoch,
    envId: scope.ticket.envId,
    readOnly: scope.readOnly,
    isSubagent: scope.isSubagent,
    originConversationId: scope.ticket.originConversationId ?? 0,
  };
}

export function createHostActionTool(
  controller: HostActionController,
  audience: HostActionCaller["kind"],
) {
  return defineTool({
    name: "kulo_host_action",
    description:
      audience === "orchestrator"
        ? "Read-only host diagnostics (`action='inspect'`: cross-platform process list without env vars, listening ports, real user home path, and non-sensitive path existence/listing) and credential-isolated host maintenance outside the project workspace (`action='run'`: e.g. package install/uninstall, cleanup, user service control; executes directly with full main-Agent authority, never escalates to sudo/root or exposes credentials). Group related maintenance steps into one `run` call. 关键词：本机诊断 进程列表 监听端口 宿主机排查 本机运维 安装卸载 清理软件"
        : "Read-only host diagnostics (`action='inspect'`: cross-platform process list without env vars, listening ports, real user home path, and non-sensitive path existence/listing—no approval required) and credential-isolated host maintenance outside the project workspace (`action='run'`: e.g. package install/uninstall, cleanup, user service control; submitted to the main Agent for smart approval before execution, never escalates to sudo/root or exposes credentials). Group related maintenance steps into one `run` call. 关键词：本机诊断 进程列表 监听端口 宿主机排查 本机运维 安装卸载 清理软件",
    parameters: obj({
      action: oneOf(["inspect", "run"]),
      env_id: opt(str({ description: "Target device env ID (orchestrator only; Workers are locked to their bound device)." })),
      scope: opt(oneOf(["summary", "processes", "ports"], { description: "For action='inspect': summary (default), processes, or ports." })),
      filter: opt(str({ description: "Optional case-insensitive filter keyword for processes or ports (e.g. 'hindsight' or '3000')." })),
      paths: opt(arr(str(), { description: "Optional host paths (up to 32, supports '~/' for real user home) to check existence/listing while respecting protected credential paths." })),
      limit: opt(num({ description: "Optional max rows for processes/ports (1..200)." })),
      summary: opt(str({ description: "Required for action='run': concise 1-line summary of the host maintenance operation shown to the user." })),
      commands: opt(arr(str(), { description: "Required for action='run': 1..8 sequential shell commands to run inside the credential-isolated host maintenance sandbox." })),
      cwd: opt(str({ description: "Optional working directory for action='run' (supports '~/' for real user home; defaults to real user home)." })),
      timeout_ms: opt(num({ description: "Optional timeout in ms for action='run' (1000..600000, default 120000)." })),
    }),
    deferred: true,
    replay: "unsafe",
    execute: async (args, api, context) => {
      try {
        const caller = await resolveCaller(api, audience, context);
        if (caller.kind === "worker" && args.env_id?.trim() && args.env_id.trim() !== caller.envId) {
          return {
            isError: true,
            output: [{ type: "text" as const, text: `Worker 仅允许在当前绑定设备 '${caller.envId}' 上执行本机操作。` }],
          };
        }

        if (args.action === "inspect") {
          const scope = (args.scope ?? "summary") as HostInspectScope;
          if (args.filter !== undefined && (args.filter.length > 120 || /[\x00-\x1f\x7f]/.test(args.filter))) {
            throw new Error("filter 参数无效（最多 120 字符，不能包含控制字符）。");
          }
          if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) {
            throw new Error("limit 需为 1~200 的整数。");
          }
          if (args.paths !== undefined) {
            if (args.paths.length > HOST_ACTION_MAX_PATHS) {
              throw new Error(`单次最多检查 ${HOST_ACTION_MAX_PATHS} 个路径。`);
            }
            if (args.paths.some((item) => !item.trim() || item.length > 1024 || /[\x00-\x1f\x7f]/.test(item))) {
              throw new Error("paths 包含无效路径。");
            }
          }
          const outcome = await controller.inspect(
            caller,
            {
              ...(args.env_id?.trim() ? { envId: args.env_id.trim() } : {}),
              scope,
              ...(args.filter?.trim() ? { filter: args.filter.trim() } : {}),
              ...(args.paths?.length ? { paths: args.paths.map((item) => item.trim()) } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
            },
            context,
          );
          return {
            output: [{ type: "text" as const, text: JSON.stringify(outcome) }],
            details: outcome as never,
          };
        }

        // action === "run"
        if (caller.kind === "worker" && caller.readOnly) {
          return {
            isError: true,
            output: [{ type: "text" as const, text: "当前角色为只读模式，仅可使用 action='inspect' 诊断，不能执行本机变更命令。" }],
          };
        }
        const summary = args.summary?.trim() ?? "";
        if (!summary || summary.length > 240) {
          throw new Error("执行本机操作需要简短的 summary 说明（1~240 字符）。");
        }
        const commands = (args.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
        if (commands.length < 1 || commands.length > HOST_ACTION_MAX_COMMANDS) {
          throw new Error(`commands 需提供 1~${HOST_ACTION_MAX_COMMANDS} 条有效命令。`);
        }
        if (commands.some((cmd) => cmd.length > HOST_ACTION_MAX_COMMAND_CHARS || cmd.includes("\0"))) {
          throw new Error(`单条命令不能超过 ${HOST_ACTION_MAX_COMMAND_CHARS} 字符且不能包含空字节。`);
        }
        if (args.cwd !== undefined && (!args.cwd.trim() || args.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(args.cwd))) {
          throw new Error("cwd 参数无效。");
        }
        if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1_000 || args.timeout_ms > HOST_ACTION_MAX_TIMEOUT_MS)) {
          throw new Error(`timeout_ms 需为 1000~${HOST_ACTION_MAX_TIMEOUT_MS} 的整数毫秒。`);
        }

        const outcome = await controller.run(
          caller,
          {
            ...(args.env_id?.trim() ? { envId: args.env_id.trim() } : {}),
            summary,
            commands,
            ...(args.cwd?.trim() ? { cwd: args.cwd.trim() } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          },
          context,
        );

        if (outcome.status === "awaiting_user_confirmation" || outcome.status === "awaiting_orchestrator_decision") {
          return {
            output: [{ type: "text" as const, text: JSON.stringify(outcome) }],
            details: outcome as never,
            ...(caller.kind === "worker" ? { control: { terminate: true } } : {}),
          };
        }
        return {
          ...(outcome.result.ok ? {} : { isError: true }),
          output: [{ type: "text" as const, text: JSON.stringify(outcome) }],
          details: outcome as never,
        };
      } catch (error) {
        return {
          isError: true,
          output: [{
            type: "text" as const,
            text: redactSecrets(error instanceof Error ? error.message : "本机操作失败"),
          }],
        };
      }
    },
  });
}

export function createHostActionDecideTool(controller: HostActionController) {
  return defineTool({
    name: "kulo_host_action_decide",
    description:
      "Decide on a Worker's pending `kulo_host_action(run)` request (main Agent only). Audit the raw `commands`, `cwd`, and `envId` against the user's real intent: call `decision='approve'` to run immediately and resume the Worker (and settle any open card), `decision='deny'` with `reason` to reject/redirect the Worker, or `decision='ask_user'` to present an interactive confirmation card (Allow / Reject / Manual input) when risky or out of scope. 关键词：审批本机操作 批准拒绝Worker命令 本机运维裁决",
    parameters: obj({
      request_id: str({ description: "Pending host action request ID (or card ID) from [KULO_HOST_ACTION_REQUEST]." }),
      decision: oneOf(["approve", "deny", "ask_user"]),
      reason: opt(str({ description: "Optional denial/redirection guidance for the Worker, or concise risk note shown on the card when decision='ask_user'." })),
    }),
    deferred: true,
    replay: "unsafe",
    execute: async (args, api, context) => {
      try {
        const caller = await resolveCaller(api, "orchestrator", context);
        if (caller.kind !== "orchestrator" || !controller.decide) {
          return {
            isError: true,
            output: [{ type: "text" as const, text: "仅主智能体可以裁决本机操作申请。" }],
          };
        }
        const requestId = args.request_id.trim();
        if (!requestId) {
          throw new Error("缺少 request_id。");
        }
        const outcome = await controller.decide(
          caller,
          {
            requestId,
            decision: args.decision,
            ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
          },
          context,
        );
        return {
          output: [{ type: "text" as const, text: JSON.stringify(outcome) }],
          details: outcome as never,
        };
      } catch (error) {
        return {
          isError: true,
          output: [{
            type: "text" as const,
            text: redactSecrets(error instanceof Error ? error.message : "裁决本机操作申请失败"),
          }],
        };
      }
    },
  });
}
