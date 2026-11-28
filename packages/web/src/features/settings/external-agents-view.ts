import {
  deriveConnectedExternalClients,
  externalClientConnectionId,
  externalClientDisplayName,
  type EnvNodeDescriptor,
  type ExternalAgentBinding,
  type ExternalClientConnection,
  type RolePreset,
} from "@kulo/protocol";

export function internalAgentPresets(roles: Record<string, RolePreset>): Record<string, RolePreset> {
  return Object.fromEntries(Object.entries(roles).filter(([, role]) => !role.external && !role.externalClientId));
}

export function externalAgentPresets(roles: Record<string, RolePreset>): Record<string, RolePreset> {
  return Object.fromEntries(Object.entries(roles).filter(([, role]) => role.external || role.externalClientId));
}

export function withExternalAgentPresets(
  internal: Record<string, RolePreset>,
  latest: Record<string, RolePreset>,
): Record<string, RolePreset> {
  return { ...internalAgentPresets(internal), ...externalAgentPresets(latest) };
}

export function roleExternalClientId(role: RolePreset): string | undefined {
  if (role.externalClientId?.trim()) return role.externalClientId.trim();
  if (role.external) return externalClientConnectionId(role.external);
  return undefined;
}

export function externalClientBindingFromConnection(client: ExternalClientConnection): ExternalAgentBinding {
  return {
    kind: client.kind,
    envId: client.envId,
    ...(client.executable ? { executable: client.executable } : {}),
    ...(client.kind === "acp" && client.acpArgs?.length ? { acpArgs: [...client.acpArgs] } : {}),
    ...(client.agentRef ? { agentRef: client.agentRef } : {}),
    ...(client.cdpUrl ? { cdpUrl: client.cdpUrl } : {}),
    ...(client.experimental !== undefined ? { experimental: client.experimental } : {}),
    ...(client.version ? { version: client.version } : {}),
    ...(client.verifiedAt !== undefined ? { verifiedAt: client.verifiedAt } : {}),
    ...(client.capabilities ? { capabilities: { ...client.capabilities } } : {}),
  };
}

export function formatExternalClientTarget(
  client: Pick<ExternalClientConnection, "kind" | "label" | "agentRef" | "envId">,
  envs?: readonly EnvNodeDescriptor[],
): string {
  const device = envs?.find((env) => env.id === client.envId);
  return `${externalClientDisplayName(client)} @ ${device?.name ?? client.envId}`;
}

export function switchRoleEngine(
  role: RolePreset,
  client: ExternalClientConnection | undefined,
): RolePreset {
  if (!client) {
    const next: RolePreset = {
      ...role,
      thinkingLevel: "auto",
    };
    delete next.provider;
    delete next.modelId;
    delete next.escalationModel;
    delete next.serviceTier;
    delete next.externalClientId;
    delete next.external;
    delete next.dispatchPolicy;
    return next;
  }
  const previousClientId = roleExternalClientId(role);
  const next: RolePreset = {
    ...role,
    externalClientId: client.id,
    external: externalClientBindingFromConnection(client),
    thinkingLevel: previousClientId === client.id ? (role.thinkingLevel ?? "auto") : "auto",
  };
  delete next.provider;
  delete next.escalationModel;
  if (previousClientId !== client.id) {
    delete next.modelId;
    delete next.serviceTier;
    delete next.dispatchPolicy;
  }
  return next;
}

export function deriveExternalClients(
  roles: Record<string, RolePreset>,
  savedClients?: Record<string, ExternalClientConnection>,
): ExternalClientConnection[] {
  return deriveConnectedExternalClients(roles, savedClients);
}
