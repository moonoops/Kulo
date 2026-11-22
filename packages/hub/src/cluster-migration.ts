import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { KuloCapabilitiesDoc } from "./capabilities.js";
import { KuloProjectsDoc } from "./projects.js";
import { KuloSettingsDoc } from "./settings.js";
import { KuloStateDoc } from "./state.js";

export interface LegacyLocalMigrationResult {
  migrated: boolean;
  legacyLocalNodeId: string;
  projectsUpdated: number;
  ticketsUpdated: number;
  topicsUpdated: number;
  settingsUpdated: boolean;
  capabilitiesUpdated: boolean;
}

function rewriteExternalClientKey(key: string, targetNodeId: string): string {
  const idx = key.lastIndexOf(":");
  if (idx <= 0) return key;
  const suffix = key.slice(idx + 1);
  return suffix === "local" ? `${key.slice(0, idx)}:${targetNodeId}` : key;
}

/**
 * Idempotently rewrites all persisted `"local"` device references across Kulo's 4 core
 * Durable documents into the original primary host's immutable physical `nodeId` (P0-2).
 * Safe to call repeatedly; performs no mutations if already migrated.
 */
export async function migrateLegacyLocalReferences(
  harness: Harness,
  legacyLocalNodeId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<LegacyLocalMigrationResult> {
  const target = legacyLocalNodeId.trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(target) || target === "local") {
    throw new Error("无效的集群主节点标识。");
  }
  const result: LegacyLocalMigrationResult = {
    migrated: false,
    legacyLocalNodeId: target,
    projectsUpdated: 0,
    ticketsUpdated: 0,
    topicsUpdated: 0,
    settingsUpdated: false,
    capabilitiesUpdated: false,
  };

  await harness.commit(async (tx) => {
    // 1. KuloProjectsDoc: projects, commands, bindings, cleanup keys
    const projectsDoc = await tx.doc(KuloProjectsDoc);
    for (const project of Object.values(projectsDoc.projects)) {
      if (project.deviceId === "local") {
        project.deviceId = target;
        result.projectsUpdated += 1;
        result.migrated = true;
      }
    }
    for (const command of Object.values(projectsDoc.commands)) {
      if (command.input?.deviceId === "local") {
        command.input.deviceId = target;
        result.migrated = true;
      }
    }
    for (const binding of Object.values(projectsDoc.bindings)) {
      if (binding.deviceId === "local") {
        binding.deviceId = target;
        result.migrated = true;
      }
    }
    for (const [key, cleanup] of Object.entries(projectsDoc.cleanup)) {
      const nextKey = key.startsWith("local:") ? `${target}:${key.slice("local:".length)}` : key;
      if (cleanup.deviceId === "local" || nextKey !== key) {
        const updated = { ...cleanup, deviceId: cleanup.deviceId === "local" ? target : cleanup.deviceId };
        if (nextKey !== key) delete projectsDoc.cleanup[key];
        projectsDoc.cleanup[nextKey] = updated;
        result.migrated = true;
      }
    }

    // 2. KuloStateDoc: ALL tickets (including finished/scheduled/retryable), topics, chatRequestTargets
    const stateDoc = await tx.doc(KuloStateDoc);
    for (const ticket of Object.values(stateDoc.tickets)) {
      let touched = false;
      if (ticket.envId === "local") {
        ticket.envId = target;
        touched = true;
      }
      if (ticket.senderSource?.deviceId === "local") {
        ticket.senderSource = { ...ticket.senderSource, deviceId: target };
        touched = true;
      }
      if (touched) {
        result.ticketsUpdated += 1;
        result.migrated = true;
      }
    }
    for (const topic of Object.values(stateDoc.topics ?? {})) {
      if (topic.targetDeviceId === "local") {
        topic.targetDeviceId = target;
        result.topicsUpdated += 1;
        result.migrated = true;
      }
    }
    if (stateDoc.chatRequestTargets) {
      for (const [key, deviceId] of Object.entries(stateDoc.chatRequestTargets)) {
        if (deviceId === "local") {
          stateDoc.chatRequestTargets[key] = target;
          result.migrated = true;
        }
      }
    }

    // 3. KuloSettingsDoc: external agent bindings (roles[*].external.envId, roles[*].externalClientId, model.externalAgentClients)
    const settingsDoc = await tx.doc(KuloSettingsDoc);
    const roleEntries: Array<{
      external?: { envId?: string };
      externalClientId?: string;
    }> = Array.isArray(settingsDoc.roles)
      ? (settingsDoc.roles as Array<{ external?: { envId?: string }; externalClientId?: string }>)
      : settingsDoc.roles && typeof settingsDoc.roles === "object"
        ? (Object.values(settingsDoc.roles) as Array<{ external?: { envId?: string }; externalClientId?: string }>)
        : [];
    for (const role of roleEntries) {
      if (!role || typeof role !== "object") continue;
      if (role.external?.envId === "local") {
        role.external = { ...role.external, envId: target };
        result.settingsUpdated = true;
        result.migrated = true;
      }
      if (typeof role.externalClientId === "string") {
        const rewritten = rewriteExternalClientKey(role.externalClientId, target);
        if (rewritten !== role.externalClientId) {
          role.externalClientId = rewritten;
          result.settingsUpdated = true;
          result.migrated = true;
        }
      }
    }
    const rewriteExternalClientsMap = (
      map: Record<string, { envId?: string; id?: string }> | undefined,
    ) => {
      if (!map || typeof map !== "object") return;
      for (const [clientKey, entry] of Object.entries(map)) {
        const nextKey = rewriteExternalClientKey(clientKey, target);
        const nextId = typeof entry?.id === "string" ? rewriteExternalClientKey(entry.id, target) : entry?.id;
        const nextEnvId = entry?.envId === "local" ? target : entry?.envId;
        if (nextKey !== clientKey || nextId !== entry?.id || nextEnvId !== entry?.envId) {
          if (nextKey !== clientKey) delete map[clientKey];
          map[nextKey] = {
            ...entry,
            ...(nextId !== undefined ? { id: nextId } : {}),
            ...(nextEnvId !== undefined ? { envId: nextEnvId } : {}),
          };
          result.settingsUpdated = true;
          result.migrated = true;
        }
      }
    };
    rewriteExternalClientsMap(
      (settingsDoc as { externalClients?: Record<string, { envId?: string; id?: string }> }).externalClients,
    );
    rewriteExternalClientsMap(
      (settingsDoc.model as { externalAgentClients?: Record<string, { envId?: string; id?: string }> } | undefined)?.externalAgentClients,
    );

    // 4. KuloCapabilitiesDoc: connections[*].browserEnvId and inputs[*].envId
    const capabilitiesDoc = await tx.doc(KuloCapabilitiesDoc);
    for (const connection of Object.values(capabilitiesDoc.connections)) {
      if (connection.browserEnvId === "local") {
        connection.browserEnvId = target;
        result.capabilitiesUpdated = true;
        result.migrated = true;
      }
    }
    for (const input of Object.values(capabilitiesDoc.inputs)) {
      if (input.envId === "local") {
        input.envId = target;
        result.capabilitiesUpdated = true;
        result.migrated = true;
      }
    }
  }, context);

  return result;
}
