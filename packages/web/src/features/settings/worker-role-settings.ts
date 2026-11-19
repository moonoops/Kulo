import { defaultRolePresets, type MocoSettingsView, type RolePreset } from "@moco/protocol";
import { translate as t } from "../../moco-i18n";
import { internalAgentPresets, withExternalAgentPresets } from "./external-agents-view";

export type RoleMutation =
  | { kind: "enabled"; id: string; enabled: boolean }
  | { kind: "create"; role: RolePreset }
  | { kind: "delete"; id: string }
  | { kind: "restore" };

export function roleMutationValue(saved: Record<string, RolePreset>, mutation: RoleMutation): Record<string, RolePreset> {
  let next: Record<string, RolePreset>;
  if (mutation.kind === "restore") {
    next = withExternalAgentPresets(defaultRolePresets(), saved);
  } else if (mutation.kind === "create") {
    if (saved[mutation.role.id]) throw new Error(t("智能体标识已存在，请使用其他标识。", "This agent ID already exists. Use another ID."));
    next = { ...saved, [mutation.role.id]: mutation.role };
  } else {
    const role = saved[mutation.id];
    if (!role) throw new Error(t("智能体已变更，请加载最新配置。", "The agent changed. Load the latest settings."));
    if (mutation.kind === "enabled") next = { ...saved, [mutation.id]: { ...role, enabled: mutation.enabled } };
    else { next = { ...saved }; delete next[mutation.id]; }
  }
  const internal = internalAgentPresets(next);
  if (!Object.keys(internal).length || !Object.values(internal).some((role) => role.enabled !== false)) {
    throw new Error(t("至少需保留 1 个启用状态的智能体。", "Keep at least one agent enabled."));
  }
  return next;
}

export async function commitRoleMutation(
  block: MocoSettingsView["blocks"]["roles"],
  mutation: RoleMutation,
  save: (expectedRevision: number, value: Record<string, RolePreset>) => Promise<MocoSettingsView>,
): Promise<MocoSettingsView> {
  return save(block.revision, roleMutationValue(block.value, mutation));
}

/** Rebase manual field edits after a live mutation; enabled always reflects the saved state. */
export function rebaseRoleDrafts(
  previous: Record<string, RolePreset>,
  draft: Record<string, RolePreset>,
  next: Record<string, RolePreset>,
): Record<string, RolePreset> {
  return Object.fromEntries(Object.entries(next).map(([id, saved]) => {
    const before = previous[id];
    const edited = draft[id];
    if (!before || !edited) return [id, saved];
    const keys = new Set([...Object.keys(before), ...Object.keys(edited)] as (keyof RolePreset)[]);
    const changes = Object.fromEntries([...keys]
      .filter((key) => key !== "enabled" && JSON.stringify(before[key]) !== JSON.stringify(edited[key]))
      .map((key) => [key, edited[key]]));
    return [id, { ...saved, ...changes }];
  }));
}
