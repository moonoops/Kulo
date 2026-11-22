import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { EnvManager } from "@kulo/env";
import {
  directExternalClientRoleId,
  externalClientConnectionId,
  isSupportedExternalAgentKind,
  type AgentConfigurationDraft,
  type ExternalAgentVerifyClientResult,
  type ExternalClientConnection,
  type KuloSettingsView,
} from "@kulo/protocol";
import type { KuloConnections } from "./connections.js";
import {
  applySettingsBlockUpdate,
  bindingFromExternalClient,
  KuloSettingsDoc,
  SettingsUpdateError,
  syncExternalClientsInSettings,
  type KuloDurableSettings,
} from "./settings.js";
import { isTicketUnfinished, KuloStateDoc } from "./state.js";

const MAX_VERIFY_CLIENT_RECEIPTS = 128;

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export interface ExternalClientAdminDeps {
  harness: Harness;
  envManager: EnvManager;
  connectionManager: KuloConnections;
  applyLiveSettings: (nextDoc: KuloDurableSettings, context: Context) => Promise<void>;
  getSettingsView: () => KuloSettingsView;
  emitSettings: (view: KuloSettingsView) => void;
}

export class ExternalClientAdminService {
  readonly #deps: ExternalClientAdminDeps;
  readonly #verifyClientReceipts = new Map<string, ExternalAgentVerifyClientResult>();

  constructor(deps: ExternalClientAdminDeps) {
    this.#deps = deps;
  }

  clearReceipts(): void {
    this.#verifyClientReceipts.clear();
  }

  async refreshModels(
    clientId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView; client: ExternalClientConnection }> {
    const { harness, envManager, connectionManager, applyLiveSettings, getSettingsView, emitSettings } = this.#deps;
    const cleanId = typeof clientId === "string" ? clientId.trim() : "";
    if (!cleanId || cleanId.length > 200) throw new SettingsUpdateError(400, "外部客户端标识无效。");
    const snapshot = await harness.snapshot(KuloSettingsDoc, context);
    const existing = snapshot?.externalClients?.[cleanId];
    if (!existing) throw new SettingsUpdateError(400, "外部客户端尚未连接。");
    const env = envManager.getEnvDescriptor(existing.envId);
    if (!env?.online) throw new SettingsUpdateError(409, "客户端绑定的设备当前离线，请连接设备后刷新。");
    const response = await envManager.requestExternalAgent(existing.envId, {
      operation: "probe",
      binding: bindingFromExternalClient(existing),
    });
    if (response.type !== "detection" || response.detection.kind !== existing.kind) {
      throw new SettingsUpdateError(409, "设备返回的客户端协议检测结果无效。");
    }
    if (!response.detection.installed || response.detection.error) {
      throw new SettingsUpdateError(409, connectionManager.redact(response.detection.error || "未能读取客户端原生模型列表。"));
    }
    const now = Date.now();
    const { nextDoc, updated } = await harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc);
      const current = doc.externalClients?.[cleanId];
      if (!current) throw new SettingsUpdateError(400, "外部客户端已移除。");
      if (
        current.kind !== existing.kind ||
        current.envId !== existing.envId ||
        current.executable !== existing.executable ||
        JSON.stringify(current.acpArgs ?? []) !== JSON.stringify(existing.acpArgs ?? []) ||
        current.agentRef !== existing.agentRef ||
        current.cdpUrl !== existing.cdpUrl
      ) {
        throw new SettingsUpdateError(409, "外部客户端配置在刷新期间已变动，请重试。");
      }
      const patch: Partial<ExternalClientConnection> = {
        ...(response.detection.version ? { version: response.detection.version } : {}),
        capabilities: cloneJson(response.detection.capabilities),
        models: cloneJson(response.detection.models),
        updatedAt: now,
      };
      const refreshed: ExternalClientConnection = { ...current, ...patch };
      const nextRoles = cloneJson(doc.roles);
      for (const role of Object.values(nextRoles)) {
        if (!role.external) continue;
        const roleClientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
        if (roleClientId === cleanId) {
          role.externalClientId = cleanId;
          role.external = bindingFromExternalClient(refreshed);
        }
      }
      applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, nextRoles, {
        externalAgents: true,
        clientModels: { [cleanId]: cloneJson(response.detection.models) },
        clientPatches: { [cleanId]: patch },
        summaryOverride: `刷新外部客户端模型列表（${refreshed.kind}）`,
      });
      return {
        nextDoc: cloneJson(doc) as KuloDurableSettings,
        updated: cloneJson(doc.externalClients?.[cleanId] ?? refreshed),
      };
    }, context);
    await applyLiveSettings(nextDoc, context);
    const view = getSettingsView();
    emitSettings(view);
    return { settings: view, client: updated };
  }

  async verifyClient(
    clientId: string,
    options: { commandId?: string; expectedRevision?: number } = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ExternalAgentVerifyClientResult> {
    const { harness, envManager, connectionManager, applyLiveSettings, getSettingsView, emitSettings } = this.#deps;
    const cleanId = typeof clientId === "string" ? clientId.trim() : "";
    if (!cleanId || cleanId.length > 200) throw new SettingsUpdateError(400, "外部客户端标识无效。");
    const commandId = typeof options.commandId === "string" && options.commandId.trim()
      ? options.commandId.trim().slice(0, 180)
      : `verify-client-${randomUUID()}`;
    const receiptKey = `${cleanId}:${commandId}`;
    const cached = this.#verifyClientReceipts.get(receiptKey);
    if (cached) return cloneJson(cached);

    const snapshot = await harness.snapshot(KuloSettingsDoc, context);
    const existing = snapshot?.externalClients?.[cleanId];
    if (!existing) throw new SettingsUpdateError(400, "外部客户端尚未连接。");
    if (!isSupportedExternalAgentKind(existing.kind)) {
      throw new SettingsUpdateError(409, "当前客户端类型尚不支持稳定收发通信验证。");
    }
    if (options.expectedRevision !== undefined && snapshot && snapshot.revisions.roles !== options.expectedRevision) {
      throw new SettingsUpdateError(409, "智能体配置已变动，请刷新后重试验证。");
    }
    const env = envManager.getEnvDescriptor(existing.envId);
    if (!env?.online) throw new SettingsUpdateError(409, "客户端绑定的设备当前离线，请连接设备后验证。");

    const binding = bindingFromExternalClient(existing);
    const probeResponse = await envManager.requestExternalAgent(existing.envId, {
      operation: "probe",
      binding,
    });
    if (probeResponse.type !== "detection" || probeResponse.detection.kind !== existing.kind) {
      throw new SettingsUpdateError(409, "设备返回的客户端协议检测结果无效。");
    }
    const detection = cloneJson(probeResponse.detection);
    if (!detection.installed || detection.error) {
      throw new SettingsUpdateError(409, connectionManager.redact(detection.error || "客户端协议检测未通过。"));
    }
    if (detection.authenticated === false) {
      throw new SettingsUpdateError(409, "本地客户端尚未完成登录，请先在原客户端登录后再验证连接。");
    }

    const nonce = `KULO_AGENT_VERIFY_${createHash("sha256").update(`verify-client:${cleanId}:${commandId}`).digest("hex").slice(0, 24)}`;
    const tempDraft: AgentConfigurationDraft = {
      id: `agent-client-verify-${createHash("sha256").update(cleanId).digest("hex").slice(0, 16)}`,
      revision: Math.max(1, snapshot?.revisions.roles ?? 1),
      clientId: "external-client-verify",
      settingsRevision: snapshot?.revisions.roles ?? 1,
      binding: {
        ...binding,
        ...(detection.version ? { version: detection.version } : {}),
        capabilities: detection.capabilities,
      },
      label: existing.label ?? existing.kind,
      whenToUse: "Verification roundtrip",
      prompt: "Verification roundtrip",
      readOnly: false,
      allowSubagents: false,
      detection,
      updatedAt: Date.now(),
    };
    const evidence = await this.verifyRoundtrip(tempDraft, nonce);
    const verifiedAt = Date.now();
    const { nextDoc, enabledRoleIds } = await harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc);
      const current = doc.externalClients?.[cleanId];
      if (!current) throw new SettingsUpdateError(400, "外部客户端已移除。");
      if (
        current.kind !== existing.kind ||
        current.envId !== existing.envId ||
        current.executable !== existing.executable ||
        JSON.stringify(current.acpArgs ?? []) !== JSON.stringify(existing.acpArgs ?? []) ||
        current.agentRef !== existing.agentRef ||
        current.cdpUrl !== existing.cdpUrl
      ) {
        throw new SettingsUpdateError(409, "外部客户端配置在验证期间已变动，请重试。");
      }
      const wasVerified = Boolean(current.verifiedAt);
      const version = evidence.version ?? detection.version ?? current.version;
      const patch: Partial<ExternalClientConnection> = {
        ...(version ? { version } : {}),
        verifiedAt,
        capabilities: cloneJson(detection.capabilities),
        models: cloneJson(detection.models),
        updatedAt: verifiedAt,
      };
      const verifiedClient: ExternalClientConnection = { ...current, ...patch };
      const nextRoles = cloneJson(doc.roles);
      const enabledIds: string[] = [];
      for (const role of Object.values(nextRoles)) {
        if (!role.external) continue;
        const roleClientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
        if (roleClientId === cleanId) {
          role.externalClientId = cleanId;
          role.external = bindingFromExternalClient(verifiedClient);
          if (!wasVerified && role.enabled === false) {
            role.enabled = true;
            enabledIds.push(role.id);
          }
        }
      }
      applySettingsBlockUpdate(
        doc,
        "roles",
        options.expectedRevision ?? doc.revisions.roles,
        nextRoles,
        {
          externalAgents: true,
          clientModels: { [cleanId]: cloneJson(detection.models) },
          clientPatches: { [cleanId]: patch },
          summaryOverride: `完成外部客户端连接验证（${verifiedClient.kind}）`,
        },
      );
      return { nextDoc: cloneJson(doc) as KuloDurableSettings, enabledRoleIds: enabledIds };
    }, context);
    await applyLiveSettings(nextDoc, context);
    const view = getSettingsView();
    emitSettings(view);
    const result: ExternalAgentVerifyClientResult = {
      clientId: cleanId,
      verifiedAt,
      verificationLevel: "roundtrip",
      ...(evidence.version ?? detection.version ? { version: evidence.version ?? detection.version } : {}),
      modelsCount: detection.models.length,
      enabledRoleIds,
      settings: view,
    };
    this.#verifyClientReceipts.set(receiptKey, cloneJson(result));
    while (this.#verifyClientReceipts.size > MAX_VERIFY_CLIENT_RECEIPTS) {
      const firstKey = this.#verifyClientReceipts.keys().next().value;
      if (firstKey === undefined) break;
      this.#verifyClientReceipts.delete(firstKey);
    }
    return result;
  }

  async removeClient(
    clientId: string,
    expectedRevision?: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<{ settings: KuloSettingsView }> {
    const { harness, applyLiveSettings, getSettingsView, emitSettings } = this.#deps;
    const cleanId = typeof clientId === "string" ? clientId.trim() : "";
    if (!cleanId || cleanId.length > 200) throw new SettingsUpdateError(400, "外部客户端标识无效。");
    const nextDoc = await harness.commit(async (tx) => {
      const doc = await tx.doc(KuloSettingsDoc);
      syncExternalClientsInSettings(doc);
      const boundRoleIds = Object.entries(doc.roles)
        .filter(([, role]) => role.external && (role.externalClientId?.trim() || externalClientConnectionId(role.external)) === cleanId)
        .map(([id]) => id);
      if (!doc.externalClients?.[cleanId] && boundRoleIds.length === 0) {
        throw new SettingsUpdateError(400, "外部客户端尚未连接。");
      }
      const directRoleId = directExternalClientRoleId(cleanId);
      const tasks = await tx.doc(KuloStateDoc);
      const hasActiveTask = Object.values(tasks.tickets).some((ticket) => {
        if (!isTicketUnfinished(ticket)) return false;
        if (boundRoleIds.includes(ticket.role) || ticket.role === directRoleId) return true;
        if (ticket.externalExecution && externalClientConnectionId(ticket.externalExecution.binding) === cleanId) return true;
        return false;
      });
      if (hasActiveTask) {
        throw new SettingsUpdateError(409, "请先停止或完成该客户端下智能体的未结束任务。");
      }
      const nextRoles = cloneJson(doc.roles);
      for (const id of boundRoleIds) {
        const role = nextRoles[id];
        if (!role) continue;
        delete role.external;
        delete role.externalClientId;
        delete role.dispatchPolicy;
        delete role.modelId;
        delete role.provider;
        delete role.serviceTier;
        role.thinkingLevel = "auto";
      }
      applySettingsBlockUpdate(doc, "roles", expectedRevision ?? doc.revisions.roles, nextRoles, {
        externalAgents: true,
        removeClientIds: [cleanId],
        summaryOverride: `移除外部客户端连接（${cleanId}）`,
      });
      return cloneJson(doc) as KuloDurableSettings;
    }, context);
    await applyLiveSettings(nextDoc, context);
    const view = getSettingsView();
    emitSettings(view);
    return { settings: view };
  }

  async verifyRoundtrip(draft: AgentConfigurationDraft, nonce: string): Promise<{ sessionId?: string; version?: string }> {
    const { envManager, connectionManager } = this.#deps;
    const env = envManager.getEnvDescriptor(draft.binding.envId);
    if (!env?.online || !env.rootDir) throw new Error("连接测试需要在线的电脑执行设备。");
    const pathApi = env.platform === "win32" ? path.win32 : path.posix;
    const id = `agent-setup-${createHash("sha256").update(`${draft.id}:${draft.revision}:${nonce}`).digest("hex").slice(0, 24)}`;
    const requestId = `${id}:verify`;
    let response = await envManager.requestExternalAgent(env.id, {
      operation: "run",
      binding: draft.binding,
      taskId: id,
      runEpoch: draft.revision,
      requestId,
      prompt: `Authorized external client connectivity check. Reply with the exact verification token below only—do not call tools or read/modify any files:\n${nonce}`,
      cwd: pathApi.join(env.rootDir, "table", id),
      ...(draft.modelId ? { modelId: draft.modelId } : {}),
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      readOnly: false,
      allowSubagents: false,
      timeoutMs: 60_000,
    });
    if (response.type !== "run") throw new Error("客户端没有返回测试执行标识。");
    const deadline = Date.now() + 60_000;
    const matchesNonce = (rawText: string): boolean => {
      let cleaned = rawText.trim();
      const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/.exec(cleaned);
      if (fenced) cleaned = fenced[1]!.trim();
      cleaned = cleaned.replace(/^(?:\*\*|__|`|["'「『“‘])+/, "").replace(/(?:\*\*|__|`|["'」』”’.,!。！])+$/, "").trim();
      return cleaned === nonce;
    };
    try {
      while (["starting", "running", "waiting"].includes(response.run.state) && Date.now() < deadline) {
        if (response.run.permissions.length) throw new Error("通信测试请求了额外工具授权，未自动批准。");
        await new Promise((resolve) => setTimeout(resolve, 200));
        response = await envManager.requestExternalAgent(env.id, { operation: "inspect", runId: requestId });
        if (response.type !== "run") throw new Error("测试执行状态无效。");
      }
      if (response.run.state !== "completed" || !matchesNonce(response.run.text)) {
        throw new Error(connectionManager.redact(response.run.error || "客户端尚未确认正确的测试回复，请核对原会话。"));
      }
      return { sessionId: response.run.sessionId, version: draft.detection?.version };
    } finally {
      try {
        await envManager.requestExternalAgent(env.id, { operation: "close", runId: requestId, discardStaged: true });
      } catch {
        /* ignore cleanup error on close */
      }
    }
  }
}
