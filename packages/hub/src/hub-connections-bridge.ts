import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import type {
  ConnectionDescribeRequest,
  ConnectionUseOperation,
} from "@kulo/protocol";
import type { KuloConnections } from "./connections.js";
import type { HubRuntimeGates } from "./hub-kernel-ports.js";
import type { KuloProjects } from "./projects.js";
import {
  SettingsAssistantDoc,
  isActiveSettingsConversation,
  type SettingsAssistant,
} from "./settings-assistant.js";
import {
  KuloStateDoc,
  isOrchestratorConversation,
  isTicketUnfinished,
  resolveTicketExecutionScope,
} from "./state.js";
import { injectEventToolsInTx } from "./tool-surface.js";
import type { ConnectionCaller } from "./tools-connections.js";

export interface HubConnectionsBridgeDeps {
  harness: Harness;
  connectionManager: KuloConnections;
  envManager: Pick<EnvManager, "getEnvDescriptor">;
  projects: Pick<KuloProjects, "get">;
  settingsAssistant: Pick<SettingsAssistant, "describeConnection">;
  runtimeGates: Pick<HubRuntimeGates, "isClosed" | "recordTicketOutwardAction">;
  steerTicket: (
    params: { ticketId: string; commandId: string; text: string },
    context: Context,
  ) => Promise<unknown>;
}

export class HubConnectionsBridge {
  readonly #deps: HubConnectionsBridgeDeps;

  constructor(deps: HubConnectionsBridgeDeps) {
    this.#deps = deps;
  }

  async assertCaller(caller: ConnectionCaller, context: Context) {
    if (this.#deps.runtimeGates.isClosed()) {
      throw new Error("Kulo 正在关闭，连接授权已停止。");
    }
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    if (caller.kind === "orchestrator") {
      if (isOrchestratorConversation(caller.conversationId as ConversationId, state)) {
        const topicId = state?.conversationToTopic?.[String(caller.conversationId)];
        if (topicId && state?.topics?.[topicId]?.deletedAt) throw new Error("会话已删除。");
        return { state, scope: undefined, isSettings: false };
      }
      const settings = await this.#deps.harness.snapshot(SettingsAssistantDoc, context);
      if (isActiveSettingsConversation(caller.conversationId, settings)) {
        return { state, scope: undefined, isSettings: true };
      }
      throw new Error("只有主模型可以管理连接权限。");
    }
    const scope = resolveTicketExecutionScope(state, caller.conversationId as ConversationId);
    if (
      !scope ||
      scope.ticket.id !== caller.ticketId ||
      scope.ticket.runEpoch !== caller.runEpoch ||
      scope.ticket.status !== "running" ||
      (scope.subagent && scope.subagent.state !== "running")
    ) {
      throw new Error("任务的连接使用资格已失效。");
    }
    if (!this.#deps.envManager.getEnvDescriptor(scope.ticket.envId)?.online) {
      throw new Error("任务执行设备已离线。");
    }
    if (
      scope.ticket.projectId &&
      (await this.#deps.projects.get(scope.ticket.projectId, context)).grantRevision !== scope.ticket.grantRevision
    ) {
      throw new Error("项目授权已变化。");
    }
    return { state, scope, isSettings: false };
  }

  async list(caller: ConnectionCaller, context: Context) {
    const { state, scope } = await this.assertCaller(caller, context);
    const snapshot = await this.#deps.connectionManager.snapshot();
    const connections = snapshot.connections.map((entry) => {
      if (entry.kind !== "mcp") return entry;
      const { mcpTools, ...rest } = entry;
      const tools = mcpTools ?? [];
      return {
        ...rest,
        toolCount: tools.length,
        sampleTools: tools.slice(0, 12).map((t) => ({ name: t.name, readOnly: t.readOnly })),
      };
    });
    return {
      connections,
      applications: snapshot.applications,
      grantedConnectionIds: scope?.ticket.connectionIds ?? [],
      requests: snapshot.requests.filter((request) =>
        caller.kind === "worker"
          ? request.ticketId === caller.ticketId
          : (state?.tickets[request.ticketId]?.originConversationId ?? Number(ROOT_CONVERSATION_ID)) === caller.conversationId,
      ),
      vault: snapshot.vault,
    };
  }

  async describe(caller: ConnectionCaller, input: ConnectionDescribeRequest, context: Context) {
    const verified = await this.assertCaller(caller, context);
    if (caller.kind !== "orchestrator") throw new Error("只有主模型可以整理连接卡片。");
    context.abortSignal?.throwIfAborted();
    if (verified.isSettings) return this.#deps.settingsAssistant.describeConnection(input);
    return this.#deps.connectionManager.describe(input);
  }

  async removeConnection(id: string): Promise<void> {
    const pending = (await this.#deps.connectionManager.snapshot()).requests.filter(
      (request) => request.connectionId === id && request.status === "pending",
    );
    await this.#deps.connectionManager.remove(id);
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.connectionIds?.includes(id)) {
          ticket.connectionIds = ticket.connectionIds.filter((value) => value !== id);
          if (ticket.connectionRevisions) delete ticket.connectionRevisions[id];
        }
      }
    }, BACKGROUND_CONTEXT);
    for (const request of pending) {
      await this.resumeConnectionDecision(request.id, false, BACKGROUND_CONTEXT);
    }
  }

  async use(caller: ConnectionCaller, input: { connectionId: string; operation: ConnectionUseOperation }, context: Context) {
    const { scope } = await this.assertCaller(caller, context);
    context.abortSignal?.throwIfAborted();
    if (caller.kind === "orchestrator") {
      const identity = `conversation:${caller.conversationId}`;
      await this.#deps.connectionManager.grant(identity, 0, [input.connectionId]);
      return this.#deps.connectionManager.use(identity, 0, input.connectionId, input.operation, { signal: context.abortSignal });
    }
    if (!scope!.ticket.connectionIds?.includes(input.connectionId)) {
      throw new Error("尚未获得这个连接的使用权限，请向主模型申请。");
    }
    const connection = (await this.#deps.connectionManager.snapshot()).connections.find((entry) => entry.id === input.connectionId);
    if (!connection || scope!.ticket.connectionRevisions?.[input.connectionId] !== connection.revision) {
      throw new Error("连接已修改，请重新向主模型申请授权。");
    }
    await this.assertCaller(caller, context);
    if (!this.#deps.connectionManager.hasGrant(caller.ticketId, caller.runEpoch, input.connectionId)) {
      await this.#deps.connectionManager.grant(caller.ticketId, caller.runEpoch, [input.connectionId], scope!.ticket.connectionRevisions);
    }
    const result = await this.#deps.connectionManager.use(caller.ticketId, caller.runEpoch, input.connectionId, input.operation, {
      readOnly: scope!.readOnly,
      signal: context.abortSignal,
      assertActive: async () => { await this.assertCaller(caller, context); },
      onOutwardAction: (label) => this.#deps.runtimeGates.recordTicketOutwardAction(caller.ticketId, caller.runEpoch, "connection", label),
    });
    await this.assertCaller(caller, context);
    return result;
  }

  async request(caller: ConnectionCaller, input: { connectionId: string; reason: string; requestId: string }, context: Context) {
    if (caller.kind !== "worker" || caller.isSubagent) throw new Error("连接权限申请只能由顶层 Worker 发起。");
    const { scope } = await this.assertCaller(caller, context);
    const connection = (await this.#deps.connectionManager.snapshot()).connections.find((entry) => entry.id === input.connectionId);
    if (
      connection &&
      scope!.ticket.connectionIds?.includes(input.connectionId) &&
      scope!.ticket.connectionRevisions?.[input.connectionId] === connection.revision
    ) {
      return { status: "approved", connectionId: input.connectionId };
    }
    const request = await this.#deps.connectionManager.requestAccess({
      ticketId: caller.ticketId,
      conversationId: caller.conversationId,
      runEpoch: caller.runEpoch,
      connectionId: input.connectionId,
      reason: this.#deps.connectionManager.redact(input.reason),
      requestId: `${caller.ticketId}:${caller.runEpoch}:${input.requestId}`,
    });
    if (request.status !== "pending") return request;
    await this.#deps.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      const ticket = state.tickets[caller.ticketId];
      if (!ticket || ticket.runEpoch !== caller.runEpoch || ticket.status !== "running") throw new Error("任务已停止。");
      if (ticket.waiting && ticket.waiting.waitToken !== request.id) throw new Error("任务已有待处理事项。");
      ticket.waiting = { reason: "connection", since: Date.now(), detail: "等待主模型分配连接权限", waitToken: request.id };
      ticket.latestReport = { state: "progress", summary: "正在向主模型申请连接权限。", at: Date.now() };
      ticket.updatedAt = Date.now();
    }, context);
    return request;
  }

  async resumeConnectionDecision(requestId: string, approved: boolean, context: Context) {
    const request = await this.#deps.connectionManager.getRequest(requestId);
    if (!request) throw new Error("连接权限申请不存在。");
    const state = await this.#deps.harness.snapshot(KuloStateDoc, context);
    const ticket = state?.tickets[request.ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || ticket.waiting?.reason !== "connection" || ticket.waiting.waitToken !== request.id) {
      return;
    }
    await this.#deps.harness.commit(async (tx) => {
      const current = (await tx.doc(KuloStateDoc)).tickets[request.ticketId];
      if (current && isTicketUnfinished(current) && current.waiting?.waitToken === request.id) {
        if (approved) {
          current.connectionIds = [...new Set([...(current.connectionIds ?? []), request.connectionId])];
          const connection = (await this.#deps.connectionManager.snapshot()).connections.find((item) => item.id === request.connectionId);
          if (!connection) throw new Error("连接已取消。");
          current.connectionRevisions = { ...(current.connectionRevisions ?? {}), [request.connectionId]: connection.revision };
        }
        if (current.workerConversationId) {
          await injectEventToolsInTx(tx, current.workerConversationId, ["kulo_connections", "kulo_connection_use"]);
        }
      }
    }, context);
    return this.#deps.steerTicket({
      ticketId: ticket.id,
      commandId: `connection-decision:${request.id}:${approved ? "approved" : "rejected"}`,
      text: approved
        ? `Connection access approved for ${request.connectionId}. Continue via kulo_connection_use; credentials remain handled by the execution layer.`
        : `Connection access denied for ${request.connectionId}. Continue within existing permissions or report what cannot be completed.`,
    }, context);
  }

  async decide(caller: ConnectionCaller, input: { requestId: string; decision: "approve" | "reject" }, context: Context) {
    if (caller.kind !== "orchestrator") throw new Error("只有主模型可以处理权限申请。");
    const { state } = await this.assertCaller(caller, context);
    const request = await this.#deps.connectionManager.getRequest(input.requestId);
    const ticket = request ? state?.tickets[request.ticketId] : undefined;
    if (!request || !ticket || (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== caller.conversationId || !isTicketUnfinished(ticket)) {
      throw new Error("这个权限申请不属于当前会话或任务已结束。");
    }
    if (ticket.waiting?.waitToken !== request.id || ticket.waiting.reason !== "connection") {
      if (request.status !== "pending") return request;
      throw new Error("权限申请已失效。");
    }
    const result = await this.#deps.connectionManager.decide(request.id, input.decision === "approve");
    await this.resumeConnectionDecision(request.id, result.status === "approved", context);
    return result;
  }

  async grant(caller: ConnectionCaller, input: { ticketId: string; connectionIds: string[] }, context: Context) {
    if (caller.kind !== "orchestrator") throw new Error("只有主模型可以分配权限。");
    const { state } = await this.assertCaller(caller, context);
    const ticket = state?.tickets[input.ticketId];
    if (!ticket || !isTicketUnfinished(ticket) || (ticket.originConversationId ?? Number(ROOT_CONVERSATION_ID)) !== caller.conversationId) {
      throw new Error("任务不属于当前会话或已经结束。");
    }
    await this.#deps.connectionManager.grant(ticket.id, ticket.runEpoch, input.connectionIds);
    const revisions = Object.fromEntries(
      (await this.#deps.connectionManager.snapshot()).connections
        .filter((item) => input.connectionIds.includes(item.id))
        .map((item) => [item.id, item.revision]),
    );
    await this.#deps.harness.commit(async (tx) => {
      const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id];
      if (!current || !isTicketUnfinished(current)) throw new Error("任务已结束。");
      current.connectionIds = [...new Set([...(current.connectionIds ?? []), ...input.connectionIds])];
      current.connectionRevisions = { ...(current.connectionRevisions ?? {}), ...revisions };
    }, context);
    const request = ticket.waiting?.reason === "connection" && ticket.waiting.waitToken
      ? await this.#deps.connectionManager.getRequest(ticket.waiting.waitToken)
      : undefined;
    if (request?.status === "pending" && input.connectionIds.includes(request.connectionId)) {
      return this.decide(caller, { requestId: request.id, decision: "approve" }, context);
    }
    return { ticketId: ticket.id, connectionIds: [...new Set([...(ticket.connectionIds ?? []), ...input.connectionIds])] };
  }
}
