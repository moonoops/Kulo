import { translate as t } from "../../moco-i18n";
import type {
  SettingsAssistantAction,
  SettingsAssistantAppearance,
  SettingsAssistantIntent,
  SettingsAssistantModule,
  ConnectionCategory,
} from "@moco/protocol";
import type { CapabilityView } from "./capability-views";

export type SettingsAssistantShortcut = {
  id: string;
  label: string;
} & (
  | { kind: "navigate"; module: SettingsAssistantModule; intent?: SettingsAssistantIntent }
  | { kind: "ask"; prompt: string }
  | { kind: "appearance"; appearance: SettingsAssistantAppearance }
  | { kind: "info"; info: "connections" | "workers" | "machines" }
  | { kind: "connection"; category: ConnectionCategory }
  | { kind: "image"; action: "discover" | "configure" | "routing" }
  | { kind: "model"; action: "connect" | "calibrate" | "diagnose"; prompt: string }
  | { kind: "agent"; action: "client" | "personal"; introduction: string; prompt: string }
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
    { id: "create-colors", label: t("创建我的配色", "Create my colors"), kind: "ask", prompt: t("帮我创建个人配色。先了解我喜欢的颜色或参考图片，再用外观定制工具生成可预览的明暗配色方案，保留现有字体；由我在卡片中确认应用。", "Help me create a custom color palette. Ask about my preferred colors or reference images first, then generate a previewable light/dark palette via the appearance customization tool while keeping current fonts for me to confirm on the card.") },
    { id: "customize-fonts", label: t("更换应用字体", "Customize app fonts"), kind: "ask", prompt: t("帮我更换应用字体。先询问我希望的字体或阅读偏好，再用外观定制工具生成可预览的界面、正文和代码字体方案，保留现有配色；由我在卡片中确认应用。", "Help me customize the app fonts. Ask about my preferred fonts or reading style first, then generate a previewable UI, body, and code font pairing via the appearance customization tool while keeping current colors for me to confirm on the card.") },
  ];
  if (module === "models") return [
    { id: "connect-provider", label: t("自动接入供应商", "Connect a provider"), kind: "model", action: "connect", prompt: t("帮我自动接入一个模型供应商。先询问服务地址或接入资料，通过模型配置工具准备交互卡片，让我在保密输入中提供凭据、选择需要的模型；不要索要明文密钥。", "Help me connect a model provider. Ask for the endpoint or provider details first, then prepare an interactive model configuration card so I can enter credentials securely and select models without sharing plaintext API keys.") },
    { id: "calibrate-models", label: t("校准模型配置", "Calibrate model settings"), kind: "model", action: "calibrate", prompt: t("帮我校准已有 API 模型配置。先让我选择连接，读取实际模型目录和当前参数，对照可获取的声明提出上下文、输出和能力调整；通过交互卡片确认，并区分声明与实际验证，测试由我选择后触发。", "Help me calibrate an existing API model connection. Let me choose the connection first, inspect its live catalog and current parameters, propose context/output/capability adjustments via an interactive card, and clearly separate declared metadata from user-triggered verification.") },
    { id: "diagnose-models", label: t("排查调用失败", "Diagnose model calls"), kind: "model", action: "diagnose", prompt: t("帮我排查 API 模型调用失败。先了解失败连接和错误信息，检查协议、地址、模型与参数，在模型配置卡片中提出修复并由我触发验证；不要在没有验证结果时声称已修复。", "Help me diagnose failing API model calls. Ask about the connection and error details, check the protocol, base URL, model ID, and parameters, and propose fixes on the model card for me to verify—do not claim fixed before verification succeeds.") },
  ];
  if (module === "workers") return [
    {
      id: "connect-agent-client", label: t("连接 Agent 客户端", "Connect an agent client"), kind: "agent", action: "client",
      introduction: t("我可以帮你把 Codex、Claude Code、Antigravity、DeepSeek Harness 等本地客户端接入 Moco，检查所在设备、安装和登录状态，并配置承接任务、会话、模型和思考深度。Moco 传入任务与资源、接收结果，由主 Agent 统一调度和验收。\n\n沿用本地客户端原有配置；会话、模型和思考深度未指定时使用客户端默认。工具、网络、插件、MCP、权限及内部子 Agent 由客户端自行管理。Hub 协作仅决定是否可请求其他 Moco Agent。\n\n默认仅点名使用，也可以设置默认承接的任务及项目范围。点名的 Agent 不可用时，我会明确说明原因，由你决定后续安排。\n\n请告诉我想连接哪个客户端、它在哪台设备上，以及希望它负责什么任务。不清楚安装路径或模型时，我会先检测。登录请在客户端或安全授权界面完成。", "I can connect local clients such as Codex, Claude Code, Antigravity and DeepSeek Harness to Moco, check their device, installation and sign-in, and configure their responsibilities, sessions, models and reasoning effort. Moco supplies tasks and resources, receives results and leaves review to the main agent.\n\nExisting client settings remain in use. Unspecified sessions, models and reasoning effort use native defaults. The client manages its tools, network, plugins, MCP, permissions and internal agents. Hub collaboration only governs requests for other Moco agents.\n\nAgents are used only when named unless you choose default task types and projects. If a named agent is unavailable, I will explain why and let you decide how to proceed.\n\nTell me which client to connect, which device it runs on and what work it should handle. I can detect the installation path and model options. Complete sign-in in the client or secure authorization interface."),
      prompt: t("帮我连接一个本地 Agent 客户端。请先了解我要连接哪个客户端、所在设备和希望负责的任务，检查可用情况后完成配置；可以检测的信息不用再问我。Moco 只管理任务与资源输入、会话、模型、思考深度及结果，由主 Agent 验收。沿用本地客户端原有配置；会话、模型和思考深度未指定时使用客户端默认。客户端自行管理工具、网络、插件、MCP、权限及内部子 Agent，不要求指定工具。Hub 协作只控制向 Moco Hub 请求其他 Moco Agent，默认关闭。默认仅点名使用；询问是否设置默认承接范围（编码、调试、审查、架构、设计、调研、写作，可限定项目），由我选择后保存。用户点名时按指定 Agent 指派；指定 Agent 不可用时，明确说明原因并由我决定后续安排。", "Help me connect a local Agent client. Ask which client, device, and responsibilities I want, inspect installation and availability automatically, and prepare the configuration while preserving the client's native tools, MCP, permissions, and defaults. Hub collaboration stays off by default; ask whether I want default task-kind/project routing before saving, and never substitute another Agent if a named one is unavailable."),
    },
    {
      id: "connect-personal-agent", label: t("连接 Personal Agent", "Connect a personal agent"), kind: "agent", action: "personal",
      introduction: t("我可以帮你检查 Grok Bot、ChatGPT Dots、Meta Muse 等个人 Agent 的接入方式，优先使用本地客户端。Grok Bot 采用实验接入；Dots 和 Muse 暂时预留入口，我会先说明当前版本支持的收发、结果读取和会话能力。Moco 只传入任务与资源、接收结果，由主 Agent 验收。\n\n沿用本地客户端原有配置；会话、模型和思考深度未指定时使用客户端默认。工具、网络、插件、MCP、权限及内部子 Agent 由客户端自行管理。Hub 协作仅决定是否可请求其他 Moco Agent。\n\n默认仅点名使用；实验和预留接入暂不开放自动承接，稳定支持后可配置默认承接的任务及项目范围。点名的 Agent 不可用时，我会明确说明原因，由你决定后续安排。\n\n请告诉我产品名称、所在设备、希望连接的 Bot 或 Agent，以及希望交给它的任务。需要浏览器或云端连接时，我会先说明，不会自动切换接入方式。登录请在原客户端完成。", "I can check connection options for personal agents such as Grok Bot, ChatGPT Dots and Meta Muse, preferring local clients. Grok Bot uses an experimental integration; Dots and Muse are reserved for future support. I will explain the messaging, results and session capabilities available in the current version. Moco supplies tasks and resources, receives results and leaves review to the main agent.\n\nExisting client settings remain in use. Unspecified sessions, models and reasoning effort use native defaults. The client manages its tools, network, plugins, MCP, permissions and internal agents. Hub collaboration only governs requests for other Moco agents.\n\nExperimental and reserved integrations are used only when named. Automatic assignment is not available yet; default task types and projects can be configured once stable support is available. If a named agent is unavailable, I will explain why and let you decide how to proceed.\n\nTell me the product, device, Bot or agent to connect and the work it should handle. I will explain any browser or cloud connection before using it. Complete sign-in in the original client."),
      prompt: t("帮我连接一个 Personal Agent。请先了解产品、所在设备、已有 Bot 和希望负责的任务，再检查当前支持的收发和会话能力。优先连接本地客户端；如果需要重启应用、开启调试或改用云端，请先说明并由我决定。Moco 只管理任务与资源输入、会话、模型、思考深度及结果，由主 Agent 验收。沿用本地客户端原有配置；会话、模型和思考深度未指定时使用客户端默认。客户端自行管理工具、网络、插件、MCP、权限及内部子 Agent，不要求指定工具。Hub 协作只控制向 Moco Hub 请求其他 Moco Agent，默认关闭。默认仅点名使用；当前实验和预留接入暂不开放自动承接，稳定支持后再配置默认承接的任务及项目范围。用户点名时按指定 Agent 指派；指定 Agent 不可用时，明确说明原因并由我决定后续安排。", "Help me connect a Personal Agent. Ask which product, device, Bot/Agent, and tasks I want, then check current messaging and session support (preferring local clients and asking before any restart, debug flag, or cloud connection). Experimental and reserved integrations remain named-only without automatic assignment."),
    },
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
}
