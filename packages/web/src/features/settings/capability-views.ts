import type { CapabilitiesWorkspaceSnapshot, CapabilityRecord, CapabilityStatus, SettingsAssistantContext } from "@moco/protocol";
import { translate } from "../../moco-i18n";

export const CAPABILITY_VIEWS = [
  { id: "image", label: "图像", englishLabel: "Images" },
  { id: "voice", label: "语音", englishLabel: "Voice" },
  { id: "video", label: "视频", englishLabel: "Video" },
  { id: "search", label: "搜索", englishLabel: "Search" },
  { id: "skills", label: "技能", englishLabel: "Skills" },
  { id: "colab", label: "Colab", englishLabel: "Colab" },
  { id: "other", label: "其他", englishLabel: "Other" },
] as const;

export type CapabilityView = typeof CAPABILITY_VIEWS[number]["id"];

export interface ImageAssistantRequest {
  id: string | number;
  action: "configure" | "discover" | "routing";
  capabilityId?: string;
}

export const ADD_IMAGE_PROMPT = "添加图像模型。先读取当前图像配置和共享草稿；复用已有供应商时先搜索可用图像模型并展示勾选卡片，新增服务时根据模型或接口文档填写同一份共享配置。只补问缺少的信息，凭证使用保密输入。";
export const IMAGE_ROUTING_PROMPT = "查看已配置图像模型及当前调用规则，解释系统如何按任务自动选择，并根据我的要求修改规则。保留明确指定模型的优先级，只补问缺少的偏好。";
export const CONNECT_FLOW_PROMPT = "连接 Google Flow，用已有会员积分生成视频。请先确认要使用的设备，并引导我在该设备的浏览器完成登录。";
export const IMPORT_SKILL_PROMPT = "导入一个 Skill，请先询问我来源。";

export function capabilityStatusLabel(capability: CapabilityRecord): string {
  const CAPABILITY_STATUS: Record<CapabilityStatus, string> = {
    unverified: translate("待验证", "Unverified"), ready: translate("可用", "Ready"), needs_auth: translate("待连接", "Not connected"), offline: translate("设备离线", "Device offline"),
    missing_dependency: translate("缺依赖", "Missing dependency"), disabled: translate("已停用", "Disabled"), error: translate("连接异常", "Connection error"),
  };
  if (!capability.enabled) return translate("已停用", "Disabled");
  if (!capability.allowTaskGeneration && (capability.status === "ready" || capability.status === "unverified")) return translate("待授权", "Awaiting approval");
  if (capability.kind === "image" && capability.status === "unverified") return translate("可用", "Ready");
  return CAPABILITY_STATUS[capability.status];
}

export function capabilityStatusColor(capability: CapabilityRecord): "success" | "danger" | "default" {
  if (!capability.enabled) return "default";
  if (capability.status === "error") return "danger";
  if (!capability.allowTaskGeneration) return "default";
  if (capability.status === "ready" || capability.kind === "image" && capability.status === "unverified") return "success";
  return "default";
}

export function capabilityTargetView(target: SettingsAssistantContext["target"], snapshot: CapabilitiesWorkspaceSnapshot | null): CapabilityView | undefined {
  if (target?.kind === "skill") return "skills";
  if (target?.kind === "extension") return "other";
  if (target?.kind !== "capability") return undefined;
  return snapshot?.capabilities.find((item) => item.id === target.id)?.kind;
}
