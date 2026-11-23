import { translate as t } from "../../kulo-i18n";
import type {
  SettingsAssistantAction,
  SettingsAssistantAppearance,
  SettingsAssistantIntent,
  SettingsAssistantModule,
  ConnectionCategory,
} from "@kulo/protocol";
import type { CapabilityView } from "./capability-views";

export type SettingsAssistantShortcut = {
  id: string;
  label: string;
} & (
  | { kind: "navigate"; module: SettingsAssistantModule; intent?: SettingsAssistantIntent }
  | { kind: "ask"; prompt: string }
  | { kind: "prefill"; draft: string }
  | { kind: "appearance"; appearance: SettingsAssistantAppearance }
  | { kind: "info"; info: "connections" | "workers" | "machines" }
  | { kind: "connection"; category: ConnectionCategory }
  | { kind: "image"; action: "discover" | "configure" | "routing" }
  | { kind: "model"; action: "connect" | "calibrate" | "diagnose"; prompt?: string }
  | { kind: "agent"; action: "client" | "personal" }
);

export function getSettingsAssistantShortcuts(
  module: SettingsAssistantModule,
  hasModel: boolean,
  appearance: SettingsAssistantAppearance,
  capabilityView: CapabilityView = "image",
): SettingsAssistantShortcut[] {
  void hasModel; void appearance;
  if (module === "capabilities" && capabilityView === "image") return [
    { id: "discover-image", label: t("从已有供应商添加", "Add from existing providers"), kind: "image", action: "discover" },
    { id: "add-image", label: t("添加图像模型", "Add image model"), kind: "image", action: "configure" },
    { id: "image-routing", label: t("调用规则", "Selection rules"), kind: "image", action: "routing" },
  ];
  if (module === "appearance") return [
    { id: "create-colors", label: t("创建我的配色", "Create my colors"), kind: "prefill", draft: t("帮我创建个人配色，偏好：", "Create a color palette for me, style: ") },
    { id: "customize-fonts", label: t("更换应用字体", "Customize app fonts"), kind: "prefill", draft: t("帮我更换应用字体，偏好：", "Customize app fonts for me, style: ") },
  ];
  if (module === "models") return [
    { id: "connect-provider", label: t("自动接入供应商", "Connect a provider"), kind: "model", action: "connect" },
    { id: "calibrate-models", label: t("校准模型配置", "Calibrate model settings"), kind: "model", action: "calibrate", prompt: t("校准已有模型配置", "Calibrate my configured models") },
    { id: "diagnose-models", label: t("排查调用失败", "Diagnose model calls"), kind: "model", action: "diagnose" },
    {
      id: "recommend-local-model",
      label: t("推荐本机模型", "Recommend local model"),
      kind: "ask",
      prompt: t(
        "请分析后台处理所在主机的硬件配置，为后台处理模型推荐合适的托管本机方案（如 oMLX / Ollama）与模型，说明将部署在哪台设备并待我确认后再执行部署。",
        "Analyze the host running Kulo Hub and recommend a managed local background model setup (such as oMLX or Ollama). State which host it will be installed on and wait for my confirmation before installing.",
      ),
    },
  ];
  if (module === "workers") return [
    { id: "connect-agent-client", label: t("连接 Agent 客户端", "Connect an agent client"), kind: "agent", action: "client" },
    { id: "connect-personal-agent", label: t("连接 Personal Agent", "Connect a personal agent"), kind: "agent", action: "personal" },
  ];
  return [];
}

export function settingsAssistantGreeting(): string {
  return t("想要构建什么样的能力？", "What capabilities would you like to build?");
}

export function canExecuteSettingsClientAction(action: SettingsAssistantAction, clientId: string): boolean {
  return !action.historical && action.status === "pending" && !action.requiresConfirmation &&
    action.clientId === clientId && (action.kind === "appearance" || action.kind === "navigate");
}

export function resolveSettingsAppearanceUndo(
  action: SettingsAssistantAction,
  current: SettingsAssistantAppearance,
  clientId: string,
): SettingsAssistantAppearance {
  if (action.clientId !== clientId) throw new Error(t("请在执行此修改的窗口撤销。", "Undo this change in the window where it was applied."));
  if (!action.previousAppearance) throw new Error(t("缺少修改前的外观模式。", "Previous appearance mode missing."));
  if (current !== action.appearance && current !== action.previousAppearance) {
    throw new Error(t("外观已再次修改，请在外观页面选择需要的模式。", "Appearance changed again. Choose the mode on the Appearance page."));
  }
  return action.previousAppearance;
}

export interface SettingsAssistantEntryIntent {
  id: string;
  module: SettingsAssistantModule;
  intent?: SettingsAssistantIntent;
  tab?: "app" | "credential" | "information";
}
