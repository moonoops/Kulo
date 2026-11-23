import { createHash } from "node:crypto";
import { EXTERNAL_AGENT_MCP_TOOL_NAMES, isEffectiveExternalReadOnly, redactSensitiveText, type ConnectionUseOperation, type ExternalAgentMcpToolName, type RolePreset, type TicketRecord, type WorkerReportRecord } from "@kulo/protocol";

export const EXTERNAL_AGENT_TOOL_HANDLER_NAMES: readonly ExternalAgentMcpToolName[] = EXTERNAL_AGENT_MCP_TOOL_NAMES;
const EXTERNAL_AGENT_TOOL_HANDLER_SET = new Set<string>(EXTERNAL_AGENT_TOOL_HANDLER_NAMES);
import type { OfficialHindsightToolName } from "./hindsight.js";

export interface ExternalAgentToolScope {
  envId: string;
  runId: string;
  taskId: string;
  runEpoch: number;
}

export function assertExternalAgentScope(
  scope: ExternalAgentToolScope,
  tickets: Readonly<Record<string, TicketRecord>> | undefined,
): TicketRecord {
  const ticket = tickets?.[scope.taskId];
  if (
    !ticket ||
    ticket.envId !== scope.envId ||
    ticket.runEpoch !== scope.runEpoch ||
    ticket.status !== "running" ||
    ticket.waiting ||
    !ticket.externalExecution ||
    ticket.externalExecution.runId !== scope.runId ||
    ticket.externalExecution.binding.envId !== scope.envId
  ) {
    throw new Error("外部任务已结束、暂停或执行资格已改变。");
  }
  return ticket;
}

export interface ExternalAgentToolCall extends ExternalAgentToolScope {
  name: string;
  args: Record<string, unknown>;
}

export interface ExternalAgentReportFile {
  path: string;
  name?: string;
  mimeType?: string;
  caption?: string;
}

export interface ExternalAgentToolCandidate {
  id: string;
  label: string;
  whenToUse: string;
  readOnly: boolean;
  envId?: string;
  available?: boolean;
}

export interface ExternalAgentToolSnapshot {
  ticket: TicketRecord;
  role?: RolePreset;
  maxSubagents: number;
  children: Record<string, { taskId: string; fingerprint: string }>;
}

export interface ExternalAgentCollaborationRequest {
  requestId: string;
  fingerprint: string;
  agentId: string;
  goal: string;
  acceptance?: string;
}

export interface ExternalAgentToolHost {
  read(scope: ExternalAgentToolScope): Promise<ExternalAgentToolSnapshot>;
  agents(scope: ExternalAgentToolScope): Promise<ExternalAgentToolCandidate[]>;
  report(scope: ExternalAgentToolScope, report: WorkerReportRecord, files?: ExternalAgentReportFile[]): Promise<unknown>;
  delegate(scope: ExternalAgentToolScope, request: ExternalAgentCollaborationRequest): Promise<unknown>;
  inspect(scope: ExternalAgentToolScope, childTaskId: string): Promise<unknown>;
  memory?(scope: ExternalAgentToolScope, toolName: OfficialHindsightToolName, args: Record<string, unknown>): Promise<unknown>;
  connectionsList?(scope: ExternalAgentToolScope): Promise<unknown>;
  connectionUse?(scope: ExternalAgentToolScope, input: { connectionId: string; operation: ConnectionUseOperation }): Promise<unknown>;
  redact?: (text: string) => string;
}

export class ExternalAgentToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ExternalAgentToolError"; }
}

function fail(code: string, message: string): never { throw new ExternalAgentToolError(code, message); }
function argumentsObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("invalid_task_tool_arguments", "任务工具参数无效。");
  return value as Record<string, unknown>;
}
function publicText(value: unknown, name: string, limit: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) fail("invalid_task_tool_arguments", `${name}无效。`);
  return value.trim();
}
function identifier(value: unknown, name: string): string {
  const text = publicText(value, name, 120)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) || ["constructor", "prototype", "__proto__"].includes(text)) fail("invalid_task_tool_arguments", `${name}无效。`);
  return text;
}

export function externalAgentCollaborationFingerprint(input: Pick<ExternalAgentCollaborationRequest, "agentId" | "goal" | "acceptance">): string {
  return createHash("sha256").update(JSON.stringify({ agentId: input.agentId, goal: input.goal, acceptance: input.acceptance ?? null })).digest("hex");
}

/** The caller identity is supplied by authenticated Env transport, never by MCP tool arguments. */
export function createExternalAgentToolHandler(host: ExternalAgentToolHost): (call: ExternalAgentToolCall) => Promise<unknown> {
  const redact = (value: string) => redactSensitiveText(host.redact?.(value) ?? value);
  const read = async (scope: ExternalAgentToolScope): Promise<ExternalAgentToolSnapshot> => {
    if (!scope.envId || !scope.runId || !scope.taskId || !Number.isSafeInteger(scope.runEpoch) || scope.runEpoch < 1) fail("external_task_scope_invalid", "外部任务身份无效。");
    const snapshot = await host.read(scope);
    const { ticket } = snapshot;
    if (ticket.id !== scope.taskId || ticket.envId !== scope.envId || ticket.runEpoch !== scope.runEpoch ||
        ticket.status !== "running" || ticket.waiting || !ticket.externalExecution ||
        ticket.externalExecution.runId !== scope.runId || ticket.externalExecution.binding.envId !== scope.envId) {
      fail("external_task_scope_expired", "外部任务已结束、暂停或执行资格已改变。");
    }
    return snapshot;
  };
  const requireProjectMemory = (snapshot: ExternalAgentToolSnapshot) => {
    if (!host.memory) fail("external_memory_unavailable", "共享记忆服务未启用。");
    if (!snapshot.ticket.projectId) fail("external_memory_project_required", "非项目独立任务不访问共享项目记忆库。");
    return host.memory;
  };
  const collaboration = (snapshot: ExternalAgentToolSnapshot) => {
    if (!snapshot.role?.allowSubagents || snapshot.role.enabled === false) fail("external_collaboration_disabled", "该智能体未开启 Hub 协作，请向主 Agent 报告协作需求。");
  };
  const candidates = async (scope: ExternalAgentToolScope, snapshot: ExternalAgentToolSnapshot) => {
    const parentReadOnly = isEffectiveExternalReadOnly(snapshot.ticket);
    return (await host.agents(scope)).filter((agent) => agent.available !== false && (!agent.envId || agent.envId === snapshot.ticket.envId) && (!parentReadOnly || agent.readOnly));
  };
  const cleanResult = (value: unknown): unknown => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > 128 * 1024) fail("external_task_result_too_large", "任务结果过大，请读取更小的结果摘要。");
    return JSON.parse(redact(serialized));
  };
  return async (call) => {
    const scope: ExternalAgentToolScope = { envId: call.envId, runId: call.runId, taskId: call.taskId, runEpoch: call.runEpoch };
    const snapshot = await read(scope);
    if (!EXTERNAL_AGENT_TOOL_HANDLER_SET.has(call.name)) return fail("external_task_tool_unknown", "不支持此任务工具。");
    const toolName = call.name as ExternalAgentMcpToolName;
    switch (toolName) {
      case "kulo_task_context": {
        argumentsObject(call.args, []);
        const ticket = snapshot.ticket;
        return cleanResult({ taskId: ticket.id, title: ticket.title, goal: ticket.goal, scope: ticket.scope, acceptance: ticket.acceptance,
          ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
          workspaceDir: ticket.externalExecution?.stagedCwd ?? ticket.workspaceDir,
          ...(ticket.externalExecution?.workspaceMode ? { workspaceMode: ticket.externalExecution.workspaceMode } : {}),
          ...(ticket.externalExecution?.stagedCwd ? { stagedCwd: ticket.externalExecution.stagedCwd } : {}),
          ...(ticket.scratchDir ? { scratchNotesDir: `${ticket.scratchDir}/notes` } : {}),
          readOnly: isEffectiveExternalReadOnly(ticket), role: snapshot.role?.label,
          allowSubagents: Boolean(snapshot.role?.allowSubagents && snapshot.role.enabled !== false),
          hasConnections: Boolean(ticket.connectionIds?.length),
          children: Object.values(snapshot.children).map((child) => child.taskId) });
      }
      case "kulo_task_report": {
        const args = argumentsObject(call.args, ["state", "summary", "deliverable", "question", "files"]);
        if (!["progress", "blocked", "ready", "failed"].includes(String(args.state))) fail("invalid_task_report_state", "任务汇报状态无效。");
        let files: ExternalAgentReportFile[] | undefined;
        if (args.files !== undefined) {
          if (!Array.isArray(args.files) || args.files.length > 16) fail("invalid_task_tool_arguments", "提交审核的文件列表无效。");
          files = args.files.map((raw) => {
            const item = argumentsObject(raw, ["path", "name", "mime_type", "caption"]);
            return {
              path: publicText(item.path, "文件路径", 4096)!,
              ...(item.name === undefined ? {} : { name: publicText(item.name, "文件名称", 180)! }),
              ...(item.mime_type === undefined ? {} : { mimeType: publicText(item.mime_type, "文件类型", 120)! }),
              ...(item.caption === undefined ? {} : { caption: publicText(item.caption, "文件说明", 500)! }),
            };
          });
        }
        const report: WorkerReportRecord = { state: args.state as WorkerReportRecord["state"], summary: redact(publicText(args.summary, "汇报", 4000)!),
          ...(args.deliverable === undefined ? {} : { deliverable: redact(publicText(args.deliverable, "交付内容", 60000)!) }),
          ...(args.question === undefined ? {} : { question: redact(publicText(args.question, "问题", 2000)!) }), at: Date.now() };
        await read(scope);
        return cleanResult(await host.report(scope, report, files));
      }
      case "kulo_memory_recall": {
        const memory = requireProjectMemory(snapshot);
        const args = argumentsObject(call.args, ["query", "budget", "max_tokens"]);
        const query = publicText(args.query, "检索词", 3000)!;
        const budget = args.budget === undefined ? undefined : String(args.budget);
        if (budget !== undefined && !["low", "mid", "high"].includes(budget)) fail("invalid_task_tool_arguments", "检索预算无效。");
        const maxTokens = args.max_tokens;
        if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 100 || maxTokens > 4000)) {
          fail("invalid_task_tool_arguments", "检索长度上限无效。");
        }
        await read(scope);
        return cleanResult(await memory(scope, "hindsight_recall", {
          query,
          scope: "project",
          ...(budget ? { budget } : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        }));
      }
      case "kulo_memory_search_pages": {
        const memory = requireProjectMemory(snapshot);
        const args = argumentsObject(call.args, ["query"]);
        const query = publicText(args.query, "搜索词", 2000)!;
        await read(scope);
        return cleanResult(await memory(scope, "hindsight_search_pages", { query }));
      }
      case "kulo_memory_read_page": {
        const memory = requireProjectMemory(snapshot);
        const args = argumentsObject(call.args, ["page_id"]);
        const pageId = publicText(args.page_id, "知识页面编号", 240)!;
        await read(scope);
        return cleanResult(await memory(scope, "hindsight_get_page", { page_id: pageId }));
      }
      case "kulo_memory_ingest": {
        const memory = requireProjectMemory(snapshot);
        const args = argumentsObject(call.args, ["title", "content"]);
        const title = publicText(args.title, "记忆标题", 240)!;
        const content = publicText(args.content, "记忆正文", 24000)!;
        if (redact(title) !== title || redact(content) !== content) fail("external_memory_secret", "共享记忆禁止写入凭据或密钥明文。");
        await read(scope);
        return cleanResult(await memory(scope, "hindsight_retain", { title, content }));
      }
      case "kulo_memory_reflect": {
        const memory = requireProjectMemory(snapshot);
        const args = argumentsObject(call.args, ["query", "budget"]);
        const query = publicText(args.query, "推理问题", 2000)!;
        const budget = args.budget === undefined ? undefined : String(args.budget);
        if (budget !== undefined && !["low", "mid", "high"].includes(budget)) fail("invalid_task_tool_arguments", "推理预算无效。");
        await read(scope);
        return cleanResult(await memory(scope, "hindsight_reflect", { query, ...(budget ? { budget } : {}) }));
      }
      case "kulo_connections": {
        argumentsObject(call.args, []);
        if (!host.connectionsList || !snapshot.ticket.connectionIds?.length) fail("external_connection_denied", "当前任务未获授权使用任何受管连接。");
        await read(scope);
        return cleanResult(await host.connectionsList(scope));
      }
      case "kulo_connection_use": {
        if (!host.connectionUse || !snapshot.ticket.connectionIds?.length) fail("external_connection_denied", "当前任务未获授权使用任何受管连接。");
        const args = argumentsObject(call.args, ["connection_id", "operation", "command", "timeout_ms", "path", "method", "body", "content_type", "action", "params_json"]);
        const connectionId = identifier(args.connection_id, "连接标识");
        if (!snapshot.ticket.connectionIds.includes(connectionId)) fail("external_connection_denied", "该连接未授权给当前任务。");
        const effectiveReadOnly = isEffectiveExternalReadOnly(snapshot.ticket);
        const opKind = String(args.operation);
        let operation: ConnectionUseOperation;
        if (opKind === "ssh") {
          const command = publicText(args.command, "SSH 命令", 32000)!;
          if (args.timeout_ms !== undefined && (typeof args.timeout_ms !== "number" || !Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 120000)) {
            fail("invalid_task_tool_arguments", "SSH 超时无效。");
          }
          if (effectiveReadOnly) fail("external_connection_readonly", "只读审查任务不能通过 SSH 执行命令。");
          operation = { kind: "ssh", command, ...(args.timeout_ms !== undefined ? { timeoutMs: Number(args.timeout_ms) } : {}) };
        } else if (opKind === "http") {
          const reqPath = publicText(args.path, "HTTP 路径", 4096)!;
          if (!reqPath.startsWith("/") || reqPath.startsWith("//") || /[\x00-\x20\x7f\\]/.test(reqPath)) fail("invalid_task_tool_arguments", "HTTP 路径必须是站点内相对路径。");
          const method = (args.method === undefined ? "GET" : String(args.method)) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
          if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) fail("invalid_task_tool_arguments", "HTTP 方法无效。");
          if (effectiveReadOnly && method !== "GET" && method !== "HEAD") fail("external_connection_readonly", "只读审查任务不能修改远程资源。");
          if ((method === "GET" || method === "HEAD") && args.body !== undefined) fail("invalid_task_tool_arguments", "GET/HEAD 请求不能携带请求体。");
          const body = args.body === undefined ? undefined : typeof args.body === "string" && args.body.length <= 64000 ? args.body : fail("invalid_task_tool_arguments", "HTTP 请求体无效。");
          const contentType = publicText(args.content_type, "Content-Type", 256, true);
          operation = { kind: "http", path: reqPath, method, ...(body !== undefined ? { body } : {}), ...(contentType ? { headers: { "Content-Type": contentType } } : {}) };
        } else if (opKind === "app") {
          const action = publicText(args.action, "应用操作", 64)!;
          if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(action)) fail("invalid_task_tool_arguments", "应用操作标识无效。");
          let paramsObj: Record<string, unknown> | undefined;
          if (args.params_json !== undefined) {
            const raw = publicText(args.params_json, "应用参数", 65536)!;
            let parsed: unknown;
            try { parsed = JSON.parse(raw); } catch { fail("invalid_task_tool_arguments", "应用参数必须是合法 JSON 对象。"); }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_task_tool_arguments", "应用参数必须是 JSON 对象。");
            paramsObj = parsed as Record<string, unknown>;
          }
          operation = { kind: "app", action, ...(paramsObj ? { params: paramsObj } : {}) };
        } else if (opKind === "mcp") {
          const action = publicText(args.action, "MCP 操作", 32)!;
          if (action !== "list_tools" && action !== "call_tool") fail("invalid_task_tool_arguments", "MCP 操作仅支持 list_tools 或 call_tool。");
          let paramsObj: Record<string, unknown> = {};
          if (args.params_json !== undefined) {
            const raw = publicText(args.params_json, "MCP 参数", 65536)!;
            let parsed: unknown;
            try { parsed = JSON.parse(raw); } catch { fail("invalid_task_tool_arguments", "MCP 参数必须是合法 JSON 对象。"); }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_task_tool_arguments", "MCP 参数必须是 JSON 对象。");
            const pending: unknown[] = [parsed];
            while (pending.length) {
              const node = pending.pop();
              if (!node || typeof node !== "object") continue;
              for (const [k, v] of Object.entries(node)) {
                if (k === "__proto__" || k === "prototype" || k === "constructor") fail("invalid_task_tool_arguments", "MCP 参数包含不允许的字段。");
                pending.push(v);
              }
            }
            paramsObj = parsed as Record<string, unknown>;
          }
          if (action === "list_tools") {
            if (Object.keys(paramsObj).some((k) => !["query", "refresh", "limit"].includes(k))) fail("invalid_task_tool_arguments", "list_tools 仅支持 query、refresh、limit。");
            if (paramsObj.query !== undefined && (typeof paramsObj.query !== "string" || paramsObj.query.length > 256)) fail("invalid_task_tool_arguments", "query 无效。");
            if (paramsObj.refresh !== undefined && typeof paramsObj.refresh !== "boolean") fail("invalid_task_tool_arguments", "refresh 无效。");
            if (paramsObj.limit !== undefined && (typeof paramsObj.limit !== "number" || !Number.isSafeInteger(paramsObj.limit) || paramsObj.limit < 1 || paramsObj.limit > 30)) fail("invalid_task_tool_arguments", "limit 无效。");
            operation = {
              kind: "mcp",
              action: "list_tools",
              ...(paramsObj.query !== undefined ? { query: paramsObj.query } : {}),
              ...(paramsObj.refresh !== undefined ? { refresh: paramsObj.refresh } : {}),
              ...(paramsObj.limit !== undefined ? { limit: paramsObj.limit } : {}),
            };
          } else {
            if (Object.keys(paramsObj).some((k) => k !== "tool" && k !== "arguments")) fail("invalid_task_tool_arguments", "call_tool 仅支持 tool 与 arguments。");
            if (typeof paramsObj.tool !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._:/-]{0,127}$/.test(paramsObj.tool)) fail("invalid_task_tool_arguments", "MCP 工具名无效。");
            if (paramsObj.arguments !== undefined && (!paramsObj.arguments || typeof paramsObj.arguments !== "object" || Array.isArray(paramsObj.arguments))) fail("invalid_task_tool_arguments", "MCP 工具 arguments 必须是 JSON 对象。");
            operation = {
              kind: "mcp",
              action: "call_tool",
              tool: paramsObj.tool,
              ...(paramsObj.arguments !== undefined ? { arguments: paramsObj.arguments as Record<string, unknown> } : {}),
            };
          }
        } else if (opKind === "information") {
          if (args.action !== "read") fail("invalid_task_tool_arguments", "普通资料仅支持 action=read。");
          operation = { kind: "information", action: "read" };
        } else {
          fail("invalid_task_tool_arguments", "不支持的连接操作类型。");
        }
        await read(scope);
        return cleanResult(await host.connectionUse(scope, { connectionId, operation }));
      }
      case "kulo_agents": {
        argumentsObject(call.args, []);
        collaboration(snapshot);
        const agents = await candidates(scope, snapshot);
        await read(scope);
        return cleanResult({ agents: agents.map(({ id, label, whenToUse, readOnly }) => ({ id, label, whenToUse, readOnly })) });
      }
      case "kulo_request_collaboration": {
        collaboration(snapshot);
        const args = argumentsObject(call.args, ["request_id", "agent_id", "goal", "acceptance"]);
        const request: ExternalAgentCollaborationRequest = { requestId: identifier(args.request_id, "请求编号"), agentId: identifier(args.agent_id, "智能体编号"), goal: publicText(args.goal, "任务目标", 16000)!,
          ...(args.acceptance === undefined ? {} : { acceptance: publicText(args.acceptance, "验收要求", 4000)! }), fingerprint: "" };
        if (redact(request.goal) !== request.goal || request.acceptance && redact(request.acceptance) !== request.acceptance) fail("external_collaboration_secret", "协作任务不能携带凭据明文，请使用任务已授权的连接引用。");
        request.fingerprint = externalAgentCollaborationFingerprint(request);
        const prior = Object.hasOwn(snapshot.children, request.requestId) ? snapshot.children[request.requestId] : undefined;
        if (prior) {
          if (prior.fingerprint !== request.fingerprint) fail("external_collaboration_request_conflict", "该协作请求编号已用于另一份任务。");
          await read(scope);
          return cleanResult(await host.inspect(scope, prior.taskId));
        }
        if (!Number.isSafeInteger(snapshot.maxSubagents) || Object.keys(snapshot.children).length >= snapshot.maxSubagents) fail("external_collaboration_limit", "当前任务已达到子智能体上限。");
        const eligible = await candidates(scope, snapshot);
        if (!eligible.some((agent) => agent.id === request.agentId)) fail("external_collaboration_target_denied", "目标智能体不可用或超出当前任务的设备、项目或只读范围。");
        const latest = await read(scope);
        collaboration(latest);
        if (Object.keys(latest.children).length >= latest.maxSubagents && !Object.hasOwn(latest.children, request.requestId)) fail("external_collaboration_limit", "当前任务已达到子智能体上限。");
        return cleanResult(await host.delegate(scope, request));
      }
      case "kulo_child_task": {
        collaboration(snapshot);
        const args = argumentsObject(call.args, ["task_id"]);
        const childId = identifier(args.task_id, "子任务编号");
        if (!Object.values(snapshot.children).some((child) => child.taskId === childId)) fail("external_child_task_forbidden", "只能读取本任务创建的子任务。");
        await read(scope);
        return cleanResult(await host.inspect(scope, childId));
      }
      default: return fail("external_task_tool_unknown", "不支持此任务工具。");
    }
  };
}
