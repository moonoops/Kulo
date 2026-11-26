import {
  HISTORICAL_DEFAULT_ROLE_TEXTS,
  defaultRolePresets,
  type RolePreset,
} from "@kulo/protocol";

export interface RoleMigrationTarget {
  roles?: Record<string, RolePreset>;
  rolesMigratedV2?: boolean;
  rolesMigratedV3?: boolean;
  rolesMigratedV4?: boolean;
  rolesMigratedV5?: boolean;
  snapshots?: Array<{ previousState?: { roles?: Record<string, RolePreset> } }>;
}

const LEGACY_DEFAULT_ROLE_IDS = new Set([
  "architect",
  "engineer",
  "writer",
  "scout",
  "coder",
  "checker",
  "designer",
  "reviewer",
  "explorer",
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Upgrade unmodified historical factory role texts to current defaults while preserving user edits and flags. */
export function upgradeRoleTexts(id: string, target: RolePreset, existing: RolePreset): RolePreset {
  const historical = HISTORICAL_DEFAULT_ROLE_TEXTS[id];
  const isHistoricalLabel = Boolean(historical?.labels.includes(existing.label));
  const isHistoricalWhen = Boolean(historical?.whenToUse.includes(existing.whenToUse));
  const isHistoricalPrompt = Boolean(historical?.prompts.includes(existing.prompt));
  return {
    ...existing,
    id,
    label: isHistoricalLabel || !existing.label?.trim() ? target.label : existing.label,
    whenToUse: isHistoricalWhen || !existing.whenToUse?.trim() ? target.whenToUse : existing.whenToUse,
    prompt: isHistoricalPrompt || !existing.prompt?.trim() ? target.prompt : existing.prompt,
  };
}

/** Migrate persisted role presets from V1-V4 schemas/texts to the current defaults on settings hydration. */
export function migrateSettingsRolesOnHydrate(doc: RoleMigrationTarget): void {
  if (!doc.rolesMigratedV3) {
    const freshDefaults = defaultRolePresets();
    const prevRoles = doc.roles ?? {};
    const migrated: Record<string, RolePreset> = {};
    const carryOverrides = (id: string, target: RolePreset, legacy: RolePreset | undefined): RolePreset => {
      if (!legacy) return { ...target };
      const merged: RolePreset = {
        ...target,
        ...(legacy.provider ? { provider: legacy.provider } : {}),
        ...(legacy.modelId ? { modelId: legacy.modelId } : {}),
        ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
        ...(legacy.readOnly !== undefined ? { readOnly: legacy.readOnly } : {}),
        ...(legacy.allowSubagents !== undefined ? { allowSubagents: legacy.allowSubagents } : {}),
        ...(legacy.thinkingLevel !== undefined ? { thinkingLevel: legacy.thinkingLevel } : {}),
        ...(legacy.dispatchPolicy ? { dispatchPolicy: cloneJson(legacy.dispatchPolicy) } : {}),
      };
      return upgradeRoleTexts(id, target, {
        ...merged,
        label: legacy.label,
        whenToUse: legacy.whenToUse,
        prompt: legacy.prompt,
      });
    };
    for (const [id, preset] of Object.entries(freshDefaults)) {
      const legacyMatch =
        id === "coder"
          ? prevRoles.coder ?? prevRoles.engineer
          : id === "checker"
            ? prevRoles.checker ?? prevRoles.reviewer
            : id === "scout"
              ? prevRoles.scout ?? prevRoles.explorer
              : prevRoles[id];
      migrated[id] = carryOverrides(id, preset, legacyMatch);
    }
    for (const [id, custom] of Object.entries(prevRoles)) {
      if (!LEGACY_DEFAULT_ROLE_IDS.has(id)) {
        migrated[id] = cloneJson(custom);
      }
    }
    doc.roles = migrated;
    doc.rolesMigratedV2 = true;
    doc.rolesMigratedV3 = true;
    doc.rolesMigratedV4 = true;
    doc.rolesMigratedV5 = true;
    return;
  }

  if (!doc.rolesMigratedV4 || !doc.rolesMigratedV5) {
    const freshDefaults = defaultRolePresets();
    const upgradePool = (pool: Record<string, RolePreset> | undefined) => {
      if (!pool) return;
      for (const [id, preset] of Object.entries(freshDefaults)) {
        const existing = pool[id];
        if (!existing || existing.external) continue;
        pool[id] = upgradeRoleTexts(id, preset, existing);
      }
    };
    upgradePool(doc.roles);
    for (const snap of doc.snapshots ?? []) {
      upgradePool(snap.previousState?.roles);
    }
    doc.rolesMigratedV4 = true;
    doc.rolesMigratedV5 = true;
  }
}
