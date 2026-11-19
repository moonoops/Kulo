import {
  AgentDoc,
  defineExtension,
  type ConversationId,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  ANDROID_INITIAL_TOOLS,
  ANDROID_TOOL_CATALOG,
  type EnvNodeDescriptor,
  type SettingsAssistantModule,
} from "@moco/protocol";

export type ToolSurfaceAudience =
  | "chat"
  | "settings"
  | "computer-worker"
  | "computer-subagent"
  | "android-worker"
  | "android-subagent";

export type ToolSurfaceTier = "resident" | "event" | "deferred";
export type ToolSurfaceScope = "global" | "window";

export interface ToolSurfaceRuntimeState {
  audience: ToolSurfaceAudience;
  isRootTopic?: boolean;
  memoryEnabled: boolean;
  sharedMemoryEnabled: boolean;
  ttsEnabled: boolean;
  webSearchAvailable: boolean;
  customizationEnabled: boolean;
  deviceInviteAvailable: boolean;
  readOnly?: boolean;
  allowSubagents?: boolean;
  settingsModule?: SettingsAssistantModule;
  settingsActive?: boolean;
  hasStagedDeviceJoin?: boolean;
  androidTargets?: readonly EnvNodeDescriptor[];
}

export interface ToolSurfaceEntry {
  name: string;
  audiences: readonly ToolSurfaceAudience[];
  tier: ToolSurfaceTier;
  /** Optional per-audience tier override (e.g. resident in settings, deferred in chat). */
  tierFor?: (state: ToolSurfaceRuntimeState) => ToolSurfaceTier;
  scope: ToolSurfaceScope;
  /** Extra window-context predicate for `scope: "window"` tools in Settings conversations. */
  windowGuard?: (state: ToolSurfaceRuntimeState) => boolean;
  /** Feature / capability / permission gate. */
  requires?: (state: ToolSurfaceRuntimeState) => boolean;
}

export const ANDROID_HIGH_RISK_PERMISSIONS: Readonly<Record<string, string>> = {
  android_process_memory: "memoryRead",
  android_memory_scan: "memoryRead",
  android_memory_read: "memoryRead",
  android_memory_write: "memoryWrite",
  android_nfc_emulation: "nfcEmulation",
};

function hasAndroidGrant(
  targets: readonly EnvNodeDescriptor[] | undefined,
  grant: string,
  action: string,
): boolean {
  if (!targets || targets.length === 0) return false;
  return targets.some((device) => {
    const android = device.android;
    if (!android?.enabled || !Array.isArray(android.grants) || !android.grants.includes(grant as never)) {
      return false;
    }
    const cap = android.capabilities?.find((entry) => entry.action === action);
    return cap ? cap.available !== false : true;
  });
}

const ALL_ORCHESTRATOR: readonly ToolSurfaceAudience[] = ["chat", "settings"];
const ALL_COMPUTER_WORKERS: readonly ToolSurfaceAudience[] = ["computer-worker", "computer-subagent"];
const ALL_ANDROID_WORKERS: readonly ToolSurfaceAudience[] = ["android-worker", "android-subagent"];
const CHAT_SETTINGS_COMPUTER: readonly ToolSurfaceAudience[] = [
  "chat",
  "settings",
  "computer-worker",
  "computer-subagent",
];

function memoryGate(state: ToolSurfaceRuntimeState): boolean {
  if (state.audience === "computer-worker" || state.audience === "computer-subagent") {
    return state.sharedMemoryEnabled;
  }
  return state.memoryEnabled;
}

const CORE_TOOL_ENTRIES: readonly ToolSurfaceEntry[] = [
  // 1. Pi Official Tools (upstream schema/descriptions untouched)
  {
    name: "read",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
  },
  {
    name: "write",
    audiences: ["chat", ...ALL_COMPUTER_WORKERS],
    tier: "resident",
    scope: "global",
  },
  {
    name: "edit",
    audiences: ["chat", ...ALL_COMPUTER_WORKERS],
    tier: "resident",
    scope: "global",
  },
  {
    name: "bash",
    audiences: ["chat", ...ALL_COMPUTER_WORKERS],
    tier: "resident",
    scope: "global",
  },
  {
    name: "tool_search",
    audiences: [...CHAT_SETTINGS_COMPUTER, ...ALL_ANDROID_WORKERS],
    tier: "resident",
    scope: "global",
  },

  // 2. Web Retrieval
  {
    name: "web_fetch",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
  },
  {
    name: "web_search",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
    requires: (s) => s.webSearchAvailable,
  },

  // 3. Orchestrator Dispatch & Ticket Control
  {
    name: "moco_dispatch",
    audiences: ALL_ORCHESTRATOR,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
  },
  {
    name: "moco_status",
    audiences: ALL_ORCHESTRATOR,
    tier: "resident",
    tierFor: (s) =>
      s.audience === "settings"
        ? s.settingsModule === "schedules"
          ? "resident"
          : "deferred"
        : "resident",
    scope: "global",
  },
  {
    name: "moco_steer",
    audiences: ALL_ORCHESTRATOR,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
  },
  {
    name: "moco_stop",
    audiences: ALL_ORCHESTRATOR,
    tier: "resident",
    tierFor: (s) =>
      s.audience === "settings"
        ? s.settingsModule === "schedules"
          ? "resident"
          : "deferred"
        : "resident",
    scope: "global",
  },
  {
    name: "moco_inspect",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_close",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_external_permission",
    audiences: ALL_ORCHESTRATOR,
    tier: "event",
    scope: "global",
  },
  {
    name: "moco_inspect_staged_diff",
    audiences: ALL_ORCHESTRATOR,
    tier: "event",
    scope: "global",
  },
  {
    name: "moco_apply_staged_changes",
    audiences: ALL_ORCHESTRATOR,
    tier: "event",
    scope: "global",
  },
  {
    name: "moco_identity_read",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" && s.settingsModule === "identity" ? "resident" : "deferred",
    scope: "global",
  },
  {
    name: "moco_identity_propose",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" && s.settingsModule === "identity" ? "resident" : "deferred",
    scope: "global",
  },
  {
    name: "moco_relationship_update",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" && s.settingsModule === "identity" ? "resident" : "deferred",
    scope: "global",
  },
  {
    name: "moco_expression",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_device_invite",
    audiences: ["chat"],
    tier: "deferred",
    scope: "global",
    requires: (s) => s.deviceInviteAvailable,
  },

  // 4. Worker Lifecycle & Computer Use
  {
    name: "moco_report",
    audiences: ["computer-worker", "android-worker"],
    tier: "resident",
    scope: "global",
  },
  {
    name: "moco_wait",
    audiences: ["computer-worker", "android-worker"],
    tier: "resident",
    scope: "global",
  },
  {
    name: "moco_subagent",
    audiences: ["computer-worker", "android-worker"],
    tier: "resident",
    scope: "global",
    requires: (s) => Boolean(s.allowSubagents),
  },
  {
    name: "moco_browser",
    audiences: ["chat", ...ALL_COMPUTER_WORKERS],
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_desktop",
    audiences: ALL_COMPUTER_WORKERS,
    tier: "deferred",
    scope: "global",
  },

  // 5. UI Cards & Artifact Publication
  {
    name: "moco_ui_show",
    audiences: ALL_ORCHESTRATOR,
    tier: "resident",
    scope: "global",
  },
  {
    name: "moco_ui_update",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_publish_asset",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "event",
    tierFor: (s) =>
      s.audience === "computer-worker" || s.audience === "computer-subagent" ? "deferred" : "event",
    scope: "global",
  },
  {
    name: "moco_inspect_asset",
    audiences: ALL_ORCHESTRATOR,
    tier: "event",
    scope: "global",
  },

  // 6. Skills
  {
    name: "moco_skill_read",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "resident",
    scope: "global",
  },
  {
    name: "moco_skill_materialize",
    audiences: ALL_COMPUTER_WORKERS,
    tier: "deferred",
    scope: "global",
  },

  // 7. Projects & Conversations
  ...[
    "moco_projects",
    "moco_project_conversations",
    "moco_project_create",
    "moco_project_update",
    "moco_project_delete",
    "moco_project_restore",
    "moco_conversation_rename",
    "moco_conversation_move",
    "moco_conversation_restore",
    "moco_project_history",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ALL_ORCHESTRATOR,
      tier: "deferred",
      scope: "global",
    }),
  ),

  // 8. Persisted History
  {
    name: "moco_history_search",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_history_read",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },

  // 9. Connections
  {
    name: "moco_connections",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" && s.settingsModule === "connections" ? "resident" : "deferred",
    scope: "global",
  },
  {
    name: "moco_connection_use",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_connection_request",
    audiences: ALL_COMPUTER_WORKERS,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_connection_decide",
    audiences: ALL_ORCHESTRATOR,
    tier: "event",
    scope: "global",
  },
  {
    name: "moco_connection_grant",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
  },
  {
    name: "moco_connection_describe",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" && s.settingsModule === "connections" ? "resident" : "deferred",
    scope: "global",
  },

  // 10. Media, Speech & Workspace Export
  ...[
    "moco_media_capabilities",
    "moco_generate_image",
    "moco_generate_video",
    "moco_media_job",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: CHAT_SETTINGS_COMPUTER,
      tier: "deferred",
      scope: "global",
    }),
  ),
  {
    name: "moco_synthesize_speech",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "deferred",
    scope: "global",
    requires: (s) => s.ttsEnabled && !s.readOnly,
  },
  {
    name: "moco_media_export",
    audiences: ALL_COMPUTER_WORKERS,
    tier: "deferred",
    scope: "global",
    requires: (s) => !s.readOnly,
  },

  // 11. Hindsight Official Memory Tools (resident core + deferred advanced suite)
  {
    name: "hindsight_retain",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
    requires: memoryGate,
  },
  {
    name: "hindsight_recall",
    audiences: CHAT_SETTINGS_COMPUTER,
    tier: "resident",
    tierFor: (s) => (s.audience === "settings" ? "deferred" : "resident"),
    scope: "global",
    requires: memoryGate,
  },
  // Legacy / compatibility aliases & advanced Hindsight tools
  ...[
    "hindsight_ingest_document",
    "hindsight_capture_initiative",
    "hindsight_search_knowledge_pages",
    "hindsight_list_knowledge_pages",
    "hindsight_read_knowledge_page",
    "hindsight_reflect",
    "hindsight_list_mental_models",
    "hindsight_get_mental_model",
    "hindsight_get_page_tree",
    "hindsight_search_pages",
    "hindsight_get_page",
    "hindsight_create_page",
    "hindsight_update_page_node",
    "hindsight_get_operation",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: CHAT_SETTINGS_COMPUTER,
      tier: "deferred",
      scope: "global",
      requires: memoryGate,
    }),
  ),
  // Router-only private-bank / mental-model write operations (never exposed to Workers)
  ...[
    "hindsight_create_mental_model",
    "hindsight_refresh_mental_model",
    "hindsight_invalidate_memory",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ALL_ORCHESTRATOR,
      tier: "deferred",
      scope: "global",
      requires: (s) => s.memoryEnabled,
    }),
  ),

  // 12. Managed Desktop Customization & Official Update
  {
    name: "moco_customization",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
    requires: (s) => s.customizationEnabled,
  },
  {
    name: "moco_official_update",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    scope: "global",
    requires: (s) => s.customizationEnabled,
  },

  // 13. Global Settings Tools (discoverable in main chat; preloaded in Settings)
  {
    name: "moco_settings_read",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) => (s.audience === "settings" ? "resident" : "deferred"),
    scope: "global",
  },
  {
    name: "moco_settings_update",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" &&
      (s.settingsModule === "models" ||
        s.settingsModule === "workers" ||
        s.settingsModule === "identity")
        ? "resident"
        : "deferred",
    scope: "global",
  },
  {
    name: "moco_settings_navigate",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) => (s.audience === "settings" ? "resident" : "deferred"),
    scope: "global",
  },
  {
    name: "moco_settings_appearance",
    audiences: ALL_ORCHESTRATOR,
    tier: "deferred",
    tierFor: (s) =>
      s.audience === "settings" && s.settingsModule === "appearance" ? "resident" : "deferred",
    scope: "global",
  },

  // 14. Window-Scoped Settings Tools (`scope: "window"`, strictly forbidden outside `settings`)
  {
    name: "moco_connection_prepare",
    audiences: ["settings"],
    tier: "deferred",
    tierFor: (s) => (s.settingsModule === "connections" ? "resident" : "deferred"),
    scope: "window",
  },
  {
    name: "moco_settings_remove_connection",
    audiences: ["settings"],
    tier: "deferred",
    tierFor: (s) => (s.settingsModule === "models" ? "resident" : "deferred"),
    scope: "window",
  },
  ...[
    "moco_model_metadata_lookup",
    "moco_model_calibrate",
    "moco_model_configuration_read",
    "moco_model_configuration_prepare",
    "moco_model_configuration_discover",
    "moco_model_configuration_update",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ["settings"],
      tier: "resident",
      scope: "window",
      windowGuard: (s) => s.settingsModule === "models",
    }),
  ),
  ...[
    "moco_agent_configuration_read",
    "moco_agent_configuration_prepare",
    "moco_agent_configuration_update",
    "moco_agent_configuration_detect",
    "moco_agent_configuration_probe",
    "moco_agent_configuration_authenticate",
    "moco_agent_configuration_verify",
    "moco_agent_configuration_save",
    "moco_agent_configuration_remove",
    "moco_agent_configuration_cancel",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ["settings"],
      tier: "resident",
      scope: "window",
      windowGuard: (s) => s.settingsModule === "workers" && s.settingsActive === true,
    }),
  ),
  ...[
    "moco_capabilities_read",
    "moco_capability_configure",
    "moco_image_models_discover",
    "moco_image_models_import",
    "moco_image_draft",
    "moco_image_routing",
    "moco_capability_manage",
    "moco_capability_input",
    "moco_skill_manage",
    "moco_extension_manage",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ["settings"],
      tier: name === "moco_capabilities_read" || name === "moco_capability_configure" || name === "moco_image_draft" ? "resident" : "deferred",
      scope: "window",
      windowGuard: (s) => s.settingsModule === "capabilities",
    }),
  ),
  ...[
    "moco_memory_service_read",
    "moco_memory_service_prepare",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ["settings"],
      tier: "resident",
      scope: "window",
      windowGuard: (s) => s.settingsModule === "identity",
    }),
  ),
  {
    name: "moco_appearance_propose",
    audiences: ["settings"],
    tier: "resident",
    scope: "window",
    windowGuard: (s) => s.settingsModule === "appearance",
  },
  ...[
    "moco_devices_manage",
    "moco_devices_ssh_scan",
    "moco_devices_join",
    "moco_devices_leave",
  ].map(
    (name): ToolSurfaceEntry => ({
      name,
      audiences: ["settings"],
      tier: "resident",
      scope: "window",
      windowGuard: (s) => s.settingsModule === "machines" || Boolean(s.hasStagedDeviceJoin),
    }),
  ),
];

const ANDROID_TOOL_ENTRIES: readonly ToolSurfaceEntry[] = ANDROID_TOOL_CATALOG.map((definition) => {
  const highRiskGrant = ANDROID_HIGH_RISK_PERMISSIONS[definition.name];
  const isInitial = (ANDROID_INITIAL_TOOLS as readonly string[]).includes(definition.name);
  return {
    name: definition.name,
    audiences: [...ALL_ANDROID_WORKERS, ...ALL_COMPUTER_WORKERS],
    tier: isInitial ? "resident" : "deferred",
    tierFor: (s) =>
      (s.audience === "android-worker" || s.audience === "android-subagent") && isInitial
        ? "resident"
        : "deferred",
    scope: "global",
    requires: (s) => {
      if (
        (s.audience === "computer-worker" || s.audience === "computer-subagent") &&
        (!s.androidTargets || s.androidTargets.length === 0)
      ) {
        return false;
      }
      if (highRiskGrant) {
        return hasAndroidGrant(s.androidTargets, highRiskGrant, definition.action);
      }
      return true;
    },
  };
});

export const TOOL_SURFACE_ENTRIES: readonly ToolSurfaceEntry[] = [
  ...CORE_TOOL_ENTRIES,
  ...ANDROID_TOOL_ENTRIES,
];

export const TOOL_SURFACE_BY_NAME: ReadonlyMap<string, ToolSurfaceEntry> = (() => {
  const map = new Map<string, ToolSurfaceEntry>();
  for (const entry of TOOL_SURFACE_ENTRIES) {
    if (map.has(entry.name)) {
      throw new Error(`Duplicate tool surface metadata entry: '${entry.name}'`);
    }
    map.set(entry.name, entry);
  }
  return map;
})();

export function assertUniqueExtensionTools(
  extensions: readonly { name: string; tools?: readonly ToolRegistration[] }[],
): void {
  const owners = new Map<string, string>();
  for (const ext of extensions) {
    for (const tool of ext.tools ?? []) {
      const prior = owners.get(tool.name);
      if (prior && prior !== ext.name) {
        throw new Error(
          `Duplicate tool registration '${tool.name}' across extensions '${prior}' and '${ext.name}'.`,
        );
      }
      owners.set(tool.name, ext.name);
    }
  }
}

export function isToolSurfaceAllowed(name: string, state: ToolSurfaceRuntimeState): boolean {
  const entry = TOOL_SURFACE_BY_NAME.get(name);
  if (!entry) {
    throw new Error(`Unregistered tool '${name}' is missing from TOOL_SURFACE_BY_NAME.`);
  }
  if (!entry.audiences.includes(state.audience)) return false;
  if (entry.scope === "window") {
    if (state.audience !== "settings") return false;
    if (entry.windowGuard && !entry.windowGuard(state)) return false;
  }
  if (entry.requires && !entry.requires(state)) return false;
  return true;
}

export function resolveToolTier(name: string, state: ToolSurfaceRuntimeState): ToolSurfaceTier {
  const entry = TOOL_SURFACE_BY_NAME.get(name);
  if (!entry) {
    throw new Error(`Unregistered tool '${name}' is missing from TOOL_SURFACE_BY_NAME.`);
  }
  return entry.tierFor ? entry.tierFor(state) : entry.tier;
}

export function resolveSurfaceTools(
  availableTools: readonly ToolRegistration[],
  state: ToolSurfaceRuntimeState,
): ToolRegistration[] {
  const seen = new Set<string>();
  const result: ToolRegistration[] = [];
  for (const tool of availableTools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    if (isToolSurfaceAllowed(tool.name, state)) {
      result.push(tool);
    }
  }
  return result;
}

const SETTINGS_DEFERRED_KEYWORDS: Readonly<Record<string, string>> = {
  web_fetch: "抓取网页 读取链接 URL",
  web_search: "联网搜索 网页查询",
  moco_dispatch: "派单 后台工单 执行任务",
  moco_status: "查看工单状态 当前时间 定时队列",
  moco_steer: "催办工单 补充指令 回复问题",
  moco_stop: "停止工单 终止任务",
  hindsight_retain: "保存记忆 写入长期记忆",
  hindsight_recall: "回忆 检索长期记忆",
};

/**
 * Extension selected only by Settings Assistant conversations to defer chat-resident tools
 * (`read` schema/description stays 100% upstream-identical) and promote global settings entry tools.
 */
export function createSettingsTierExtension() {
  return defineExtension({
    name: "moco-settings-tier",
    wraps: [
      { tool: "read", wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, deferred: true }) },
      ...Object.entries(SETTINGS_DEFERRED_KEYWORDS).map(([name, kw]) => ({
        tool: name,
        wrap: (tool: ToolRegistration): ToolRegistration => ({
          ...tool,
          deferred: true,
          description: tool.description.includes(kw) ? tool.description : `${tool.description} (${kw})`,
        }),
      })),
      ...["moco_settings_read", "moco_settings_navigate"].map((name) => ({
        tool: name,
        wrap: (tool: ToolRegistration): ToolRegistration => {
          const { deferred: _deferred, ...resident } = tool;
          return resident;
        },
      })),
    ],
  });
}

/**
 * Extension selected on mixed Computer + Android Workers/Subagents so the 3 initial Android tools
 * remain deferred on Computer Workers while staying resident on pure Android Workers.
 */
export function createComputerMixedAndroidTierExtension() {
  return defineExtension({
    name: "moco-computer-mixed-android-tier",
    wraps: ANDROID_INITIAL_TOOLS.map((name) => ({
      tool: name,
      wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, deferred: true }),
    })),
  });
}

/**
 * Returns deferred tool names that should be preloaded into `modelTools.add` for the active Settings page.
 */
export function resolveSettingsPreloadedTools(state: ToolSurfaceRuntimeState): string[] {
  if (state.audience !== "settings") return [];
  const alwaysResident = new Set(["moco_settings_read", "moco_settings_navigate"]);
  const preloaded: string[] = [];
  for (const entry of TOOL_SURFACE_ENTRIES) {
    if (alwaysResident.has(entry.name)) continue;
    if (!isToolSurfaceAllowed(entry.name, state)) continue;
    if (resolveToolTier(entry.name, state) === "resident" && entry.tier !== "resident") {
      preloaded.push(entry.name);
    }
    if (
      state.settingsModule === "schedules" &&
      (entry.name === "moco_status" || entry.name === "moco_stop")
    ) {
      if (!preloaded.includes(entry.name)) preloaded.push(entry.name);
    }
    if (
      (state.settingsModule === "capabilities" || state.settingsModule === "models") &&
      entry.name === "web_fetch"
    ) {
      if (!preloaded.includes(entry.name)) preloaded.push(entry.name);
    }
  }
  return preloaded;
}

/**
 * Filter candidate follow-up tool names against `agent.deferred` so `control.addTools` never widens `state.tools`.
 */
export function filterDeferredLoadableTools(
  deferredTools: readonly Pick<ToolRegistration, "name">[],
  candidates: readonly string[],
): string[] {
  const allowed = new Set(deferredTools.map((t) => t.name));
  return candidates.filter((name) => allowed.has(name));
}

export async function resolveDeferredAddTools<Ctx>(
  api: { agent?: (context: Ctx) => Promise<{ deferred: readonly Pick<ToolRegistration, "name">[] }> } | undefined,
  context: Ctx,
  candidates: readonly string[],
): Promise<string[]> {
  if (!api || typeof api.agent !== "function") return [];
  const agent = await api.agent(context);
  return filterDeferredLoadableTools(agent.deferred, candidates);
}

/**
 * Deterministic event-driven tool injection inside a durable commit transaction.
 * Preserves existing `modelTools.add` order without duplicates so Prompt Cache prefixes stay stable.
 */
export async function injectEventToolsInTx(
  tx: Tx,
  conversationId: ConversationId | number,
  names: readonly string[],
): Promise<void> {
  if (!names.length) return;
  const agent = await tx.doc(AgentDoc, conversationId as ConversationId);
  const modelTools = agent.modelTools;
  if (Array.isArray(modelTools)) {
    const next = [...modelTools];
    let changed = false;
    for (const name of names) {
      if (!next.includes(name)) {
        next.push(name);
        changed = true;
      }
    }
    if (changed) agent.modelTools = next;
    return;
  }
  const remove = (modelTools?.remove ?? []).filter((name) => !names.includes(name));
  const add = [...(modelTools?.add ?? [])];
  let changed = remove.length !== (modelTools?.remove?.length ?? 0);
  for (const name of names) {
    if (!add.includes(name)) {
      add.push(name);
      changed = true;
    }
  }
  if (changed) {
    agent.modelTools = { ...(remove.length === 0 ? {} : { remove }), add };
  }
}

/**
 * Prunes idle deferred/event tools from `AgentDoc.modelTools.add` when Compaction establishes a fresh checkpoint baseline,
 * retaining any tool used in the kept recent tail or backed by an active pending event / settings preload.
 */
export async function pruneIdleDeferredToolsInTx(
  tx: Tx,
  conversationId: ConversationId | number,
  retainedNames: ReadonlySet<string>,
): Promise<string[]> {
  const agent = await tx.doc(AgentDoc, conversationId as ConversationId);
  const modelTools = agent.modelTools;
  if (!modelTools || Array.isArray(modelTools) || !modelTools.add?.length) {
    return [];
  }
  const pruned: string[] = [];
  const nextAdd = modelTools.add.filter((name) => {
    if (retainedNames.has(name)) return true;
    pruned.push(name);
    return false;
  });
  if (pruned.length > 0) {
    if (nextAdd.length === 0 && (!modelTools.remove || modelTools.remove.length === 0)) {
      delete agent.modelTools;
    } else {
      agent.modelTools = {
        ...(modelTools.remove?.length ? { remove: [...modelTools.remove] } : {}),
        ...(nextAdd.length ? { add: nextAdd } : {}),
      };
    }
  }
  return pruned;
}
