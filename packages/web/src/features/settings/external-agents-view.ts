import { externalClientConnectionId, type ExternalClientConnection, type RolePreset } from "@kulo/protocol";

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

export function deriveExternalClients(
  roles: Record<string, RolePreset>,
  savedClients?: Record<string, ExternalClientConnection>,
): ExternalClientConnection[] {
  const map = new Map<string, ExternalClientConnection>();
  for (const [id, client] of Object.entries(savedClients ?? {})) {
    map.set(id, client);
  }
  for (const role of Object.values(roles)) {
    if (!role.external) continue;
    const id = roleExternalClientId(role)!;
    if (map.has(id)) continue;
    map.set(id, {
      id,
      kind: role.external.kind,
      envId: role.external.envId,
      ...(role.external.kind === "acp" && role.label ? { label: role.label } : {}),
      ...(role.external.executable ? { executable: role.external.executable } : {}),
      ...(role.external.kind === "acp" && role.external.acpArgs?.length ? { acpArgs: [...role.external.acpArgs] } : {}),
      ...(role.external.agentRef ? { agentRef: role.external.agentRef } : {}),
      ...(role.external.cdpUrl ? { cdpUrl: role.external.cdpUrl } : {}),
      ...(role.external.experimental !== undefined ? { experimental: role.external.experimental } : {}),
      ...(role.external.version ? { version: role.external.version } : {}),
      ...(role.external.verifiedAt !== undefined ? { verifiedAt: role.external.verifiedAt } : {}),
      ...(role.external.capabilities ? { capabilities: role.external.capabilities } : {}),
      models: [],
      updatedAt: 0,
    });
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
