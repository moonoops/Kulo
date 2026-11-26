import {
  ANDROID_TOOL_CATALOG,
  type EnvNodeDescriptor,
  type ExecutionTrustMode,
  type SettingsAssistantModule,
} from "@kulo/protocol";

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
  builtinMemoryEnabled?: boolean;
  builtinSharedMemoryEnabled?: boolean;
  ttsEnabled: boolean;
  webSearchAvailable: boolean;
  customizationEnabled: boolean;
  deviceInviteAvailable: boolean;
  computerUseBrowserEnabled?: boolean;
  computerUseDesktopEnabled?: boolean;
  executionTrustMode?: ExecutionTrustMode;
  readOnly?: boolean;
  allowSubagents?: boolean;
  settingsModule?: SettingsAssistantModule;
  settingsActive?: boolean;
  hasStagedDeviceJoin?: boolean;
  assistantActive?: boolean;
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

export function hasAndroidGrant(
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

export const ALL_ORCHESTRATOR: readonly ToolSurfaceAudience[] = ["chat", "settings"];
export const ALL_COMPUTER_WORKERS: readonly ToolSurfaceAudience[] = ["computer-worker", "computer-subagent"];
export const ALL_ANDROID_WORKERS: readonly ToolSurfaceAudience[] = ["android-worker", "android-subagent"];
export const CHAT_SETTINGS_COMPUTER: readonly ToolSurfaceAudience[] = [
  "chat",
  "settings",
  "computer-worker",
  "computer-subagent",
];

export function memoryGate(state: ToolSurfaceRuntimeState): boolean {
  if (state.audience === "computer-worker" || state.audience === "computer-subagent") {
    return state.sharedMemoryEnabled;
  }
  return state.memoryEnabled;
}

export const builtinMemoryGate = (s: ToolSurfaceRuntimeState): boolean =>
  s.audience === "computer-worker" || s.audience === "computer-subagent"
    ? Boolean(s.builtinSharedMemoryEnabled)
    : Boolean(s.builtinMemoryEnabled);

export const SETTINGS_DEFERRED_KEYWORDS: Readonly<Record<string, string>> = {
  web_fetch: "抓取网页 读取链接 URL",
  web_search: "联网搜索 网页查询",
  kulo_dispatch: "派单 后台工单 执行任务",
  kulo_status: "查看工单状态 当前时间 定时队列",
  kulo_steer: "催办工单 补充指令 回复问题",
  kulo_stop: "停止工单 终止任务",
  hindsight_retain: "保存记忆 写入长期记忆",
  hindsight_recall: "回忆 检索长期记忆",
  kulo_memory_retain: "保存记忆 写入内置长期记忆",
  kulo_memory_recall: "回忆 检索内置长期记忆",
  kulo_history_search: "搜索聊天记录 查找历史对话 以前说过的话 回忆原文",
  kulo_host_action: "本机诊断 进程列表 监听端口 宿主机排查 路径检查",
};

export function isEntryAllowedOnSurface(
  entry: ToolSurfaceEntry,
  state: ToolSurfaceRuntimeState,
): boolean {
  if (!entry.audiences.includes(state.audience)) return false;
  if (entry.scope === "window") {
    if (state.audience !== "settings") return false;
    if (entry.windowGuard && !entry.windowGuard(state)) return false;
  }
  if (entry.requires && !entry.requires(state)) return false;
  return true;
}

export function resolveEntryTier(
  entry: ToolSurfaceEntry,
  state: ToolSurfaceRuntimeState,
): ToolSurfaceTier {
  return entry.tierFor ? entry.tierFor(state) : entry.tier;
}

export function androidCatalogSizeCheck(): number {
  return ANDROID_TOOL_CATALOG.length;
}
