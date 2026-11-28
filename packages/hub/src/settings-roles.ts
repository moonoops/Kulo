import { isDeepStrictEqual } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  EXTERNAL_AGENT_KINDS,
  externalClientConnectionId,
  inferModelPurpose,
  isBlockedCustomAcpExecutableName,
  isBundledClaudeSdkExecutable,
  isConversationModel,
  isPersonalExternalAgentKind,
  isValidCustomAcpAgentRef,
  resolveExternalModelEffortPolicy,
  validateCustomAcpArgs,
  type BuiltinThinkingEffort,
  type CustomModelConfig,
  type ExternalAgentBinding,
  type ExternalAgentModelInfo,
  type ExternalClientConnection,
  type ModelGatewayConfig,
  type RoleEscalationModel,
  type RolePreset,
  type RoleThinkingEffort,
} from "@kulo/protocol";
import { AgentRoutingError, assertAgentDefaultScopes, normalizeAgentDispatchPolicy } from "./agent-routing.js";
import { parseThinking } from "./config.js";
import { SettingsUpdateError } from "./settings-executor.js";

export const VALID_THINKING_KEYS: readonly BuiltinThinkingEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface RoleSettingsTarget {
  roles: Record<string, RolePreset>;
  externalClients?: Record<string, ExternalClientConnection>;
  model: ModelGatewayConfig;
  rolesMigratedV2?: boolean;
  rolesMigratedV3?: boolean;
  rolesMigratedV4?: boolean;
  rolesMigratedV5?: boolean;
}

export interface RolesBlockUpdateOptions {
  externalAgents?: boolean;
  clientModels?: Record<string, ExternalAgentModelInfo[]>;
  clientPatches?: Record<string, Partial<ExternalClientConnection>>;
  upsertClients?: Record<string, ExternalClientConnection>;
  removeClientIds?: readonly string[];
  summaryOverride?: string;
  hasModel?: (provider: string, modelId: string) => boolean;
}

const BUILTIN_PROVIDERS_BY_ID = new Map(builtinProviders().map((provider) => [provider.id, provider]));

function cleanJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseRoleThinking(
  raw: unknown,
  fallback: RoleThinkingEffort = "auto",
): RoleThinkingEffort {
  if (raw === "auto") return "auto";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    return parseThinking(trimmed, fallback === "auto" ? "medium" : fallback);
  }
  return fallback;
}

function parseExternalRoleThinking(raw: unknown): RoleThinkingEffort {
  if (raw === undefined || raw === null) return "auto";
  if (typeof raw !== "string") {
    throw new SettingsUpdateError(400, "外部智能体的思考深度标识无效。");
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "auto") return "auto";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(trimmed)) {
    throw new SettingsUpdateError(400, "外部智能体的思考深度标识无效。");
  }
  return trimmed as RoleThinkingEffort;
}

function parseExternalServiceTier(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new SettingsUpdateError(400, "外部智能体服务档位无效。");
  }
  const clean = raw.trim();
  if (!clean || clean === "auto" || clean === "__client_default__") return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(clean)) {
    throw new SettingsUpdateError(400, "外部智能体服务档位无效。");
  }
  return clean;
}

export function configuredModel(
  config: ModelGatewayConfig,
  provider: string | undefined,
  modelId: string,
): CustomModelConfig | undefined {
  const providerId = provider || config.defaultProvider || (!config.gatewayDisabled ? "kulo-gateway" : undefined);
  if (!providerId || (providerId === "kulo-gateway" && config.gatewayDisabled)) return undefined;
  const subscriptionModels =
    config.subscriptionModels && Object.hasOwn(config.subscriptionModels, providerId)
      ? config.subscriptionModels[providerId]
      : undefined;
  return providerId === "kulo-gateway"
    ? config.gatewayModels?.find((model) => model.id === modelId)
    : subscriptionModels?.find((model) => model.id === modelId) ??
        config.customProviders?.find((entry) => entry.id === providerId)?.models.find((model) => model.id === modelId);
}

export function isValidThinkingSelection(model: CustomModelConfig | undefined, selection: string): boolean {
  return model?.thinkingLevels?.length
    ? model.thinkingLevels.some((option) => option.id === selection)
    : VALID_THINKING_KEYS.includes(selection as BuiltinThinkingEffort);
}

export function assertConversationModelSelection(
  config: ModelGatewayConfig,
  provider: string | undefined,
  modelId: string,
): void {
  if (!modelId) return;
  const candidate = configuredModel(config, provider, modelId) ?? { id: modelId };
  const purpose = inferModelPurpose(candidate);
  if (purpose === "image") {
    throw new SettingsUpdateError(400, `模型「${modelId}」用于图像生成，请在工具技能的图像能力中配置。`);
  }
  if (purpose !== "chat") {
    throw new SettingsUpdateError(400, `模型「${modelId}」是语音或实时通话模型，不能设为默认对话或智能体模型。`);
  }
}

function parseRoleEscalationModel(raw: unknown, roleId: string): RoleEscalationModel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SettingsUpdateError(400, `角色 "${roleId}" 的遇卡升级模型配置无效。`);
  }
  const rec = raw as Record<string, unknown>;
  if (Object.keys(rec).some((key) => key !== "provider" && key !== "modelId" && key !== "thinkingLevel")) {
    throw new SettingsUpdateError(400, `角色 "${roleId}" 的遇卡升级模型包含无效字段。`);
  }
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  const modelId = typeof rec.modelId === "string" ? rec.modelId.trim() : "";
  if (!provider && !modelId) return undefined;
  if (!provider || !modelId) {
    throw new SettingsUpdateError(400, `角色 "${roleId}" 的遇卡升级模型必须同时指定服务商和模型 ID。`);
  }
  if (
    provider.length > 120 ||
    /[\x00-\x1f]/.test(provider) ||
    modelId.length > 200 ||
    /[\x00-\x1f]/.test(modelId)
  ) {
    throw new SettingsUpdateError(400, `角色 "${roleId}" 的遇卡升级模型标识格式无效。`);
  }
  const rawThinking = rec.thinkingLevel;
  const thinkingLevel =
    rawThinking !== undefined && rawThinking !== null && String(rawThinking).trim() !== ""
      ? parseRoleThinking(rawThinking, "auto")
      : undefined;
  return {
    provider,
    modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

export function assertValidEscalationModel(
  config: ModelGatewayConfig,
  escalationModel: RoleEscalationModel,
  roleId: string,
  hasModel?: (provider: string, modelId: string) => boolean,
): void {
  const provider = escalationModel.provider.trim();
  const modelId = escalationModel.modelId.trim();
  assertConversationModelSelection(config, provider, modelId);
  if (hasModel?.(provider, modelId)) return;

  if (provider === "kulo-gateway") {
    if (config.gatewayDisabled) {
      throw new SettingsUpdateError(400, `默认网关已停用，角色 "${roleId}" 不能使用「${provider}/${modelId}」作为遇卡升级模型。`);
    }
    const matchesGateway = Boolean(config.gatewayModels?.some((m) => m.id === modelId));
    const matchesDefault =
      (!config.defaultProvider?.trim() || config.defaultProvider.trim() === "kulo-gateway") &&
      config.defaultModel.trim() === modelId;
    if (!matchesGateway && !matchesDefault) {
      throw new SettingsUpdateError(400, `角色 "${roleId}" 的遇卡升级模型「${provider}/${modelId}」不存在。`);
    }
    return;
  }

  const customProvider = config.customProviders?.find((entry) => entry.id === provider);
  if (customProvider) {
    if (!customProvider.models.some((m) => m.id === modelId)) {
      throw new SettingsUpdateError(400, `服务商「${provider}」中不存在遇卡升级模型「${modelId}」。`);
    }
    return;
  }

  const builtin = BUILTIN_PROVIDERS_BY_ID.get(provider);
  const subscriptionModels =
    config.subscriptionModels && Object.hasOwn(config.subscriptionModels, provider)
      ? config.subscriptionModels[provider]
      : undefined;
  if (subscriptionModels) {
    const existsInSub = subscriptionModels.some((m) => m.id === modelId);
    const existsInBuiltin = Boolean(builtin?.getModels().some((m) => m.id === modelId));
    if (!existsInSub && !existsInBuiltin) {
      throw new SettingsUpdateError(400, `订阅服务商「${provider}」中不存在遇卡升级模型「${modelId}」。`);
    }
    return;
  }

  if (builtin) {
    const existsInBuiltin = Boolean(builtin.getModels().some((m) => m.id === modelId));
    const matchesDefault = config.defaultProvider?.trim() === provider && config.defaultModel.trim() === modelId;
    if (!existsInBuiltin && !matchesDefault) {
      throw new SettingsUpdateError(400, `服务商「${provider}」中不存在遇卡升级模型「${modelId}」。`);
    }
    return;
  }

  throw new SettingsUpdateError(400, `角色 "${roleId}" 的遇卡升级模型指向了不存在的服务商「${provider}」。`);
}

function isRemovedModelReference(
  explicitProvider: string | undefined,
  modelId: string | undefined,
  prevModel: ModelGatewayConfig,
  nextModel: ModelGatewayConfig,
  prevCustomById: ReadonlyMap<string, NonNullable<ModelGatewayConfig["customProviders"]>[number]>,
  nextCustomById: ReadonlyMap<string, NonNullable<ModelGatewayConfig["customProviders"]>[number]>,
  prevGatewayModels: ReadonlySet<string>,
  nextGatewayChatModels: ReadonlySet<string>,
): boolean {
  if (!explicitProvider && !modelId) return false;
  if (explicitProvider === "kulo-gateway") {
    if (nextModel.gatewayDisabled) return true;
    return Boolean(modelId && prevGatewayModels.has(modelId) && !nextGatewayChatModels.has(modelId));
  }
  if (explicitProvider && prevCustomById.has(explicitProvider)) {
    const prevCustom = prevCustomById.get(explicitProvider)!;
    const nextCustom = nextCustomById.get(explicitProvider);
    if (!nextCustom) return true;
    return Boolean(
      modelId &&
        prevCustom.models.some((m) => m.id === modelId) &&
        !nextCustom.models.some((m) => m.id === modelId && isConversationModel(m)),
    );
  }
  if (
    explicitProvider &&
    modelId &&
    prevModel.subscriptionModels &&
    Object.hasOwn(prevModel.subscriptionModels, explicitProvider) &&
    prevModel.subscriptionModels[explicitProvider]!.some((m) => m.id === modelId)
  ) {
    const nextSub =
      nextModel.subscriptionModels && Object.hasOwn(nextModel.subscriptionModels, explicitProvider)
        ? nextModel.subscriptionModels[explicitProvider]
        : undefined;
    return Boolean(nextSub && !nextSub.some((m) => m.id === modelId && isConversationModel(m)));
  }
  if (!explicitProvider && modelId) {
    const prevImplicitProvider =
      prevModel.defaultProvider?.trim() || (!prevModel.gatewayDisabled ? "kulo-gateway" : "");
    return prevImplicitProvider === "kulo-gateway" && Boolean(nextModel.gatewayDisabled);
  }
  return false;
}

export function cleanupRemovedRoleModels(
  roles: Record<string, RolePreset>,
  prevModel: ModelGatewayConfig,
  nextModel: ModelGatewayConfig,
): boolean {
  let changed = false;
  const prevCustomById = new Map((prevModel.customProviders ?? []).map((p) => [p.id, p]));
  const nextCustomById = new Map((nextModel.customProviders ?? []).map((p) => [p.id, p]));
  const prevGatewayModels = new Set((prevModel.gatewayModels ?? []).map((m) => m.id));
  const nextGatewayChatModels = new Set(
    (nextModel.gatewayModels ?? []).filter((m) => isConversationModel(m)).map((m) => m.id),
  );

  for (const role of Object.values(roles)) {
    if (role.external) continue;
    if (
      isRemovedModelReference(
        role.provider?.trim(),
        role.modelId?.trim(),
        prevModel,
        nextModel,
        prevCustomById,
        nextCustomById,
        prevGatewayModels,
        nextGatewayChatModels,
      )
    ) {
      delete role.provider;
      delete role.modelId;
      role.thinkingLevel = "auto";
      changed = true;
    }
    if (
      role.escalationModel &&
      isRemovedModelReference(
        role.escalationModel.provider?.trim(),
        role.escalationModel.modelId?.trim(),
        prevModel,
        nextModel,
        prevCustomById,
        nextCustomById,
        prevGatewayModels,
        nextGatewayChatModels,
      )
    ) {
      delete role.escalationModel;
      changed = true;
    }
  }
  return changed;
}

export function normalizeRoleThinkingSelections(
  roles: Record<string, RolePreset>,
  config: ModelGatewayConfig,
): boolean {
  let changed = false;
  for (const role of Object.values(roles)) {
    if (role.external) continue;
    if (role.thinkingLevel && role.thinkingLevel !== "auto") {
      const model = configuredModel(config, role.provider, role.modelId || config.defaultModel);
      const next =
        model?.reasoning === false || model?.thinkingEnabled === false
          ? "off"
          : isValidThinkingSelection(model, role.thinkingLevel)
            ? role.thinkingLevel
            : "auto";
      if (role.thinkingLevel !== next) {
        role.thinkingLevel = next;
        changed = true;
      }
    }
    if (role.escalationModel?.thinkingLevel && role.escalationModel.thinkingLevel !== "auto") {
      const escModel = configuredModel(config, role.escalationModel.provider, role.escalationModel.modelId);
      const nextEsc =
        escModel?.reasoning === false || escModel?.thinkingEnabled === false
          ? "off"
          : isValidThinkingSelection(escModel, role.escalationModel.thinkingLevel)
            ? role.escalationModel.thinkingLevel
            : "auto";
      if (role.escalationModel.thinkingLevel !== nextEsc) {
        role.escalationModel.thinkingLevel = nextEsc;
        changed = true;
      }
    }
  }
  return changed;
}

export function normalizeExternalRoleThinkingSelections(
  roles: Record<string, RolePreset>,
  externalClients?: Record<string, ExternalClientConnection>,
): boolean {
  let changed = false;
  for (const role of Object.values(roles)) {
    if (!role.external) continue;
    if (!role.thinkingLevel || role.thinkingLevel === "auto") continue;
    const clientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
    const client = externalClients?.[clientId];
    const models = client?.models ?? [];
    const modelId = role.modelId?.trim() || "";
    const matchedModel = modelId
      ? models.find((item) => item.id === modelId)
      : models.find((item) => item.isDefault);
    const policy = resolveExternalModelEffortPolicy(matchedModel, role.external.kind, models);
    if (
      policy.capability === "unsupported" ||
      (policy.capability === "supported" && !policy.efforts.includes(role.thinkingLevel))
    ) {
      role.thinkingLevel = "auto";
      changed = true;
    }
  }
  return changed;
}

export function bindingFromExternalClient(client: ExternalClientConnection): ExternalAgentBinding {
  const executable =
    client.executable && !(client.kind === "claude-code" && isBundledClaudeSdkExecutable(client.executable))
      ? client.executable
      : undefined;
  return {
    kind: client.kind,
    envId: client.envId,
    ...(executable ? { executable } : {}),
    ...(client.kind === "acp" && client.acpArgs?.length ? { acpArgs: [...client.acpArgs] } : {}),
    ...(client.agentRef ? { agentRef: client.agentRef } : {}),
    ...(client.cdpUrl ? { cdpUrl: client.cdpUrl } : {}),
    ...(client.experimental !== undefined ? { experimental: client.experimental } : {}),
    ...(client.version ? { version: client.version } : {}),
    ...(client.verifiedAt !== undefined ? { verifiedAt: client.verifiedAt } : {}),
    ...(client.capabilities ? { capabilities: cleanJson(client.capabilities) } : {}),
  };
}

export function syncExternalClientsInSettings(
  doc: Pick<RoleSettingsTarget, "roles" | "externalClients">,
  clientModels?: Record<string, ExternalAgentModelInfo[]>,
  removeClientIds?: readonly string[],
  clientPatches?: Record<string, Partial<ExternalClientConnection>>,
  upsertClients?: Record<string, ExternalClientConnection>,
): void {
  const existing = doc.externalClients ? cleanJson(doc.externalClients) : {};
  for (const clientId of removeClientIds ?? []) {
    delete existing[clientId];
  }
  if (upsertClients) {
    for (const [clientId, client] of Object.entries(upsertClients)) {
      const nextClient = cleanJson(client);
      if (nextClient.kind === "claude-code" && isBundledClaudeSdkExecutable(nextClient.executable)) {
        delete nextClient.executable;
      }
      existing[clientId] = { ...nextClient, id: clientId };
    }
  }
  for (const client of Object.values(existing)) {
    if (client.kind === "claude-code" && isBundledClaudeSdkExecutable(client.executable)) {
      delete client.executable;
    }
  }
  if (clientPatches) {
    for (const [clientId, patch] of Object.entries(clientPatches)) {
      const prior = existing[clientId];
      if (!prior) continue;
      const merged: ExternalClientConnection = {
        ...prior,
        ...cleanJson(patch),
        id: prior.id,
        kind: prior.kind,
        envId: prior.envId,
      };
      if (merged.kind === "claude-code" && isBundledClaudeSdkExecutable(merged.executable)) {
        delete merged.executable;
      }
      existing[clientId] = merged;
    }
  }
  for (const role of Object.values(doc.roles)) {
    if (!role.external) continue;
    if (role.external.kind === "claude-code" && isBundledClaudeSdkExecutable(role.external.executable)) {
      delete role.external.executable;
    }
    const clientId = role.externalClientId?.trim() || externalClientConnectionId(role.external);
    const prior = existing[clientId];
    const suppliedModels = clientModels?.[clientId];
    const patched = clientPatches?.[clientId];
    const clientLabel = prior?.label ?? (role.external.kind === "acp" ? role.label : undefined);
    existing[clientId] = {
      id: clientId,
      kind: role.external.kind,
      envId: role.external.envId,
      ...(clientLabel ? { label: clientLabel } : {}),
      ...(role.external.executable ? { executable: role.external.executable } : {}),
      ...(role.external.kind === "acp" && role.external.acpArgs?.length ? { acpArgs: [...role.external.acpArgs] } : {}),
      ...(role.external.agentRef ? { agentRef: role.external.agentRef } : {}),
      ...(role.external.cdpUrl ? { cdpUrl: role.external.cdpUrl } : {}),
      ...(role.external.experimental !== undefined ? { experimental: role.external.experimental } : {}),
      ...(role.external.version ? { version: role.external.version } : {}),
      ...(role.external.verifiedAt !== undefined ? { verifiedAt: role.external.verifiedAt } : {}),
      ...(role.external.capabilities ? { capabilities: cleanJson(role.external.capabilities) } : {}),
      models: suppliedModels ? cleanJson(suppliedModels) : prior?.models ?? [],
      updatedAt: patched?.updatedAt ?? (suppliedModels ? Date.now() : prior?.updatedAt ?? Date.now()),
    };
  }
  if (Object.keys(existing).length > 0) doc.externalClients = existing;
  else delete doc.externalClients;
}

export function applyRolesBlockUpdate(
  doc: RoleSettingsTarget,
  val: Record<string, unknown>,
  options: RolesBlockUpdateOptions = {},
): string {
  if (!options.externalAgents) {
    for (const [id, current] of Object.entries(doc.roles)) {
      if (!current.external) continue;
      const clientId = current.externalClientId?.trim() || externalClientConnectionId(current.external);
      const connected = doc.externalClients?.[clientId];
      const nextEntry = val[id] as Record<string, unknown> | undefined;
      if (!connected) {
        if (!isDeepStrictEqual(current, nextEntry)) {
          throw new SettingsUpdateError(400, "外部智能体请通过智能体页面右侧对话修改。");
        }
        continue;
      }
      if (!nextEntry) continue;
      const nextIsExternal = Boolean(nextEntry.external || nextEntry.externalClientId);
      if (nextIsExternal && !isDeepStrictEqual(current.dispatchPolicy, nextEntry.dispatchPolicy)) {
        throw new SettingsUpdateError(400, "外部智能体请通过智能体页面右侧对话修改。");
      }
    }
  }
  const nextRoles: Record<string, RolePreset> = {};
  const updatedClientBindings = new Map<string, ExternalAgentBinding>();
  for (const [roleId, entry] of Object.entries(val)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(roleId) || !entry || typeof entry !== "object") {
      throw new SettingsUpdateError(400, `角色 ID "${roleId}" 格式非法（需小写字母开头，40 字符内）。`);
    }
    const r = entry as Record<string, unknown>;
    const existingRole = doc.roles[roleId];
    const hasExplicitClientId = typeof r.externalClientId === "string" && Boolean(r.externalClientId.trim());
    const explicitClientId = hasExplicitClientId
      ? (r.externalClientId as string).trim()
      : r.external
        ? existingRole?.externalClientId?.trim()
        : undefined;
    let externalClientId = explicitClientId;
    let external = r.external as RolePreset["external"];
    if (!options.externalAgents && externalClientId) {
      const connected = doc.externalClients?.[externalClientId];
      if (!connected) throw new SettingsUpdateError(400, "请通过右侧对话连接外部智能体。");
      external = bindingFromExternalClient(connected);
    }
    if (external) {
      if (
        typeof external !== "object" ||
        Array.isArray(external) ||
        !(EXTERNAL_AGENT_KINDS as readonly unknown[]).includes(external.kind) ||
        typeof external.envId !== "string" ||
        !external.envId.trim() ||
        external.envId.length > 200 ||
        Object.keys(external).some(
          (key) =>
            ![
              "kind",
              "envId",
              "executable",
              "acpArgs",
              "agentRef",
              "cdpUrl",
              "experimental",
              "version",
              "verifiedAt",
              "capabilities",
            ].includes(key),
        )
      ) {
        throw new SettingsUpdateError(400, "外部智能体连接配置无效。");
      }
      if (external.kind === "claude-code" && isBundledClaudeSdkExecutable(external.executable)) {
        external = { ...external };
        delete external.executable;
      }
      if (
        external.executable !== undefined &&
        (typeof external.executable !== "string" ||
          !external.executable ||
          !/^(?:\/|[A-Za-z]:[\\/])/.test(external.executable) ||
          /[\x00-\x1f]/.test(external.executable))
      ) {
        throw new SettingsUpdateError(400, "客户端路径必须是绝对路径。");
      }
      if (external.acpArgs !== undefined) {
        if (external.kind !== "acp") throw new SettingsUpdateError(400, "仅自定义 ACP 客户端支持启动参数。");
        const validatedArgs = validateCustomAcpArgs(external.acpArgs);
        if (!validatedArgs.ok) throw new SettingsUpdateError(400, validatedArgs.error);
        external = { ...external, ...(validatedArgs.value.length ? { acpArgs: validatedArgs.value } : {}) };
        if (!validatedArgs.value.length) delete external.acpArgs;
      }
      if (external.kind === "acp") {
        if (!external.executable) throw new SettingsUpdateError(400, "自定义 ACP 客户端必须指定绝对可执行文件路径。");
        if (isBlockedCustomAcpExecutableName(external.executable)) {
          throw new SettingsUpdateError(400, "自定义 ACP 客户端路径不能是通用 Shell、脚本解释器或包拉取执行器。");
        }
        if (!isValidCustomAcpAgentRef(external.agentRef)) {
          throw new SettingsUpdateError(400, "自定义 ACP 客户端标识格式无效。");
        }
      }
      if (
        (external.experimental !== undefined && typeof external.experimental !== "boolean") ||
        (external.agentRef !== undefined &&
          (typeof external.agentRef !== "string" ||
            !external.agentRef.trim() ||
            external.agentRef.length > 200 ||
            /[\x00-\x1f]/.test(external.agentRef))) ||
        (external.version !== undefined &&
          (typeof external.version !== "string" ||
            external.version.length > 200 ||
            /[\x00-\x1f]/.test(external.version))) ||
        (external.verifiedAt !== undefined &&
          (typeof external.verifiedAt !== "number" || !Number.isFinite(external.verifiedAt) || external.verifiedAt <= 0))
      ) {
        throw new SettingsUpdateError(400, "外部智能体连接信息无效。");
      }
      const derivedClientId = externalClientId || externalClientConnectionId(external);
      const connected = doc.externalClients?.[derivedClientId];
      if (!options.externalAgents && !existingRole?.external && !connected) {
        throw new SettingsUpdateError(400, "请通过右侧对话连接外部智能体。");
      }
      if (!options.externalAgents && connected) {
        external = bindingFromExternalClient(connected);
      }
      externalClientId = derivedClientId;
      if (external.cdpUrl !== undefined) {
        let url: URL;
        try {
          url = new URL(external.cdpUrl);
        } catch {
          throw new SettingsUpdateError(400, "实验调试地址无效。");
        }
        if (
          external.kind !== "grok-bot" ||
          typeof external.cdpUrl !== "string" ||
          url.protocol !== "http:" ||
          !["127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        ) {
          throw new SettingsUpdateError(400, "实验调试地址必须是当前设备的回环地址。");
        }
      }
      if (external.capabilities !== undefined) {
        const capabilities = external.capabilities;
        if (
          !capabilities ||
          typeof capabilities !== "object" ||
          Array.isArray(capabilities) ||
          Object.keys(capabilities).some(
            (key) => !["resume", "cancel", "models", "permissions", "collaboration", "terminalEvidence"].includes(key),
          ) ||
          ["resume", "cancel", "models", "permissions", "collaboration"].some(
            (key) => typeof capabilities[key as keyof typeof capabilities] !== "boolean",
          ) ||
          !["native", "observed", "none"].includes(capabilities.terminalEvidence)
        ) {
          throw new SettingsUpdateError(400, "外部智能体能力声明无效。");
        }
      }
      if (r.enabled !== false && (!Number.isFinite(external.verifiedAt) || isPersonalExternalAgentKind(external.kind))) {
        throw new SettingsUpdateError(400, "此连接尚未完成稳定任务通信验证，不能启用自动派发。");
      }
      if (options.externalAgents && (!existingRole?.external || !isDeepStrictEqual(existingRole.external, external))) {
        updatedClientBindings.set(externalClientId, cleanJson(external));
      }
    }
    let dispatchPolicy: RolePreset["dispatchPolicy"];
    if (r.dispatchPolicy !== undefined) {
      if (!external) throw new SettingsUpdateError(400, "默认承接设置仅适用于外部智能体。");
      try {
        dispatchPolicy = normalizeAgentDispatchPolicy(r.dispatchPolicy);
      } catch (error) {
        if (error instanceof AgentRoutingError) throw new SettingsUpdateError(error.status, error.message);
        throw error;
      }
    }
    const label = String(r.label ?? "").trim();
    const whenToUse = String(r.whenToUse ?? "").trim();
    const prompt = String(r.prompt ?? "").trim();
    if (!label || !whenToUse || !prompt) {
      throw new SettingsUpdateError(400, `角色 "${roleId}" 缺少名称、适用场景或系统提示词。`);
    }
    const provider = typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : undefined;
    const serviceTier = external ? parseExternalServiceTier(r.serviceTier) : undefined;
    const escalationModel = external ? undefined : parseRoleEscalationModel(r.escalationModel, roleId);
    nextRoles[roleId] = {
      id: roleId,
      label,
      whenToUse,
      prompt,
      enabled: r.enabled !== false,
      readOnly: Boolean(r.readOnly),
      allowSubagents: Boolean(r.allowSubagents),
      ...(provider && !external ? { provider } : {}),
      ...(explicitClientId ? { externalClientId: explicitClientId } : {}),
      ...(external ? { external: cleanJson(external) } : {}),
      ...(dispatchPolicy ? { dispatchPolicy } : {}),
      ...(typeof r.modelId === "string" && r.modelId.trim() ? { modelId: r.modelId.trim() } : {}),
      ...(escalationModel ? { escalationModel } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      thinkingLevel: external ? parseExternalRoleThinking(r.thinkingLevel) : parseRoleThinking(r.thinkingLevel, "auto"),
    };
  }
  if (options.externalAgents && updatedClientBindings.size > 0) {
    for (const role of Object.values(nextRoles)) {
      if (!role.external) continue;
      const cid = role.externalClientId ?? externalClientConnectionId(role.external);
      const updated = updatedClientBindings.get(cid);
      if (updated) {
        role.external = cleanJson(updated);
        if (!Number.isFinite(updated.verifiedAt) || isPersonalExternalAgentKind(updated.kind)) {
          role.enabled = false;
        }
      }
    }
  }
  try {
    assertAgentDefaultScopes(nextRoles);
  } catch (error) {
    if (error instanceof AgentRoutingError) throw new SettingsUpdateError(error.status, error.message);
    throw error;
  }
  const roleValues = Object.values(nextRoles);
  if (roleValues.length === 0) {
    throw new SettingsUpdateError(400, "至少需要保留一个 Worker 角色预设。");
  }
  if (!roleValues.some((r) => r.enabled !== false)) {
    throw new SettingsUpdateError(400, "至少需要保留一个启用状态的 Worker 角色。");
  }
  for (const role of roleValues) {
    if (!role.external) {
      assertConversationModelSelection(doc.model, role.provider, role.modelId || doc.model.defaultModel);
      if (role.escalationModel) {
        assertValidEscalationModel(doc.model, role.escalationModel, role.id, options.hasModel);
      }
    }
  }
  doc.roles = nextRoles;
  if (
    options.externalAgents ||
    doc.externalClients ||
    options.removeClientIds?.length ||
    options.clientPatches ||
    options.upsertClients
  ) {
    syncExternalClientsInSettings(
      doc,
      options.clientModels,
      options.removeClientIds,
      options.clientPatches,
      options.upsertClients,
    );
  }
  normalizeRoleThinkingSelections(doc.roles, doc.model);
  normalizeExternalRoleThinkingSelections(doc.roles, doc.externalClients);
  doc.rolesMigratedV2 = true;
  doc.rolesMigratedV3 = true;
  doc.rolesMigratedV4 = true;
  doc.rolesMigratedV5 = true;
  return options.summaryOverride ?? `更新 Worker 角色与模型预设（共 ${roleValues.length} 个角色）`;
}
