import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { SETTINGS_ASSISTANT_INTENTS, SETTINGS_ASSISTANT_MODULES } from "@kulo/protocol";
import { resolveDeferredAddTools } from "./tool-surface.js";
import type { SettingsAssistant } from "./settings-assistant.js";

export function createGlobalSettingsToolsExtension(get: () => SettingsAssistant) {
  const result = (value: unknown, addTools?: string[]) => ({
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(addTools?.length ? { control: { addTools } } : {}),
  });
  return defineExtension({
    name: "kulo-global-settings",
    tools: [
      defineTool({
        name: "kulo_settings_read",
        description: "Read current or specified settings section (`current`, `models`, `workers`, `identity`, `machines`, `appearance`, `capabilities`, `extensions`, `connections`, `permissions`, `schedules`, `archives`) without secrets. 关键词：读取设置 查看配置 模型并发设备外观权限定时归档扩展",
        parameters: obj({ section: opt(oneOf(["current", ...SETTINGS_ASSISTANT_MODULES, "extensions"] as const)) }),
        deferred: true,
        replay: "safe",
        execute: async (args, api, context) => {
          const value = await get().read(args.section, Number(api.conversationId));
          const section = args.section ?? "current";
          const followUps: string[] = [];
          if (["current", "models", "workers", "identity"].includes(section)) followUps.push("kulo_settings_update");
          if (["current", "models"].includes(section)) followUps.push("kulo_local_model_register");
          if (["current", "identity"].includes(section)) followUps.push("kulo_memory_service_read");
          if (section === "connections") followUps.push("kulo_connections", "kulo_connection_use");
          if (section === "appearance") followUps.push("kulo_settings_appearance");
          if (section === "extensions") followUps.push("kulo_extension_manage");
          if (section === "capabilities") followUps.push("kulo_capability_manage", "kulo_skill_manage");
          const addTools = followUps.length
            ? await resolveDeferredAddTools(api, context, followUps)
            : [];
          return result(value, addTools);
        },
      }),
      defineTool({
        name: "kulo_settings_update",
        description: "Apply allowlisted settings changes immediately (`block` in `model`/`executor`/`presentation`/`roles`; `changes` JSON object using `roleId.field` for `roles`; read settings first; excludes credentials, URLs, and Identity files—use `kulo_memory_service_read` / `kulo_memory_service_prepare` for Hindsight setup and memory enable/disable toggles). 关键词：修改设置 调整并发子智能体上限 切换默认模型 改名 角色配置 自动归档",
        parameters: obj({ block: oneOf(["model", "executor", "presentation", "roles"]), changes: str(), title: str() }),
        deferred: true,
        execute: async (args, api) => result(await get().update(args.block, args.changes, args.title, api.callId, Number(api.conversationId))),
      }),
      defineTool({
        name: "kulo_local_model_register",
        description: "Register or update a keyless self-hosted local/LAN OpenAI-compatible chat model provider (`openai-completions` or `openai-responses` on loopback or private LAN/Tailscale hosts only, e.g. `http://192.168.1.50:8000/v1`, Ollama, vLLM, llama-server, oMLX). Live-discovers chat models from `/models` (or verifies explicit `model_ids` via probe) and saves directly without API keys. Never use for public cloud APIs or endpoints requiring secrets (use `kulo_settings_navigate(module='models', intent='add-api')` instead). 关键词：注册本地模型 接入局域网模型 免密OpenAI兼容接口 Ollama vLLM llama-server oMLX 自建推理服务",
        parameters: obj({
          name: str({ description: "Display name for the local/LAN provider (e.g. 'Local GPU Server')." }),
          base_url: str({ description: "Private local/LAN HTTP(S) OpenAI-compatible base URL (e.g. 'http://192.168.1.50:8000/v1')." }),
          api: opt(oneOf(["openai-completions", "openai-responses"])),
          provider_id: opt(str({ description: "Optional existing custom provider ID (`api-...`) to update." })),
          model_ids: opt(arr(str({ description: "Optional explicit chat model IDs when `/models` does not list them or to select specific IDs." }))),
          set_default_model_id: opt(str({ description: "Optional chat model ID to also set as the default conversation model." })),
          verify_model_id: opt(str({ description: "Optional chat model ID to live-probe with a short text call." })),
        }),
        deferred: true,
        execute: async (args, api, context) => result(await get().registerLocalModel({
          name: args.name,
          baseUrl: args.base_url,
          api: args.api,
          providerId: args.provider_id,
          modelIds: args.model_ids,
          setDefaultModelId: args.set_default_model_id,
          verifyModelId: args.verify_model_id,
          commandId: api.callId,
        }, Number(api.conversationId), context.abortSignal)),
      }),
      defineTool({
        name: "kulo_settings_appearance",
        description: "Switch display mode (`system`/`light`/`dark`) on the connected browser immediately. 关键词：切换外观 深色模式 浅色模式 夜间主题 暗黑明暗跟随系统",
        parameters: obj({ mode: oneOf(["system", "light", "dark"]) }),
        deferred: true,
        execute: async (args, api) => result(await get().clientAction("appearance", { appearance: args.mode }, api.callId, Number(api.conversationId))),
      }),
      defineTool({
        name: "kulo_settings_navigate",
        description: "Navigate to a target settings page or open its add-connection, subscription sign-in, Identity editor, device join, or memory setup flow (secrets are entered only in dedicated UI forms). 关键词：打开设置页面 跳转配置 添加API密钥 登录订阅 配置记忆 接入设备",
        parameters: obj({ module: oneOf(SETTINGS_ASSISTANT_MODULES), intent: opt(oneOf(SETTINGS_ASSISTANT_INTENTS)) }),
        deferred: true,
        execute: async (args, api) => result(await get().clientAction("navigate", { module: args.module, intent: args.intent }, api.callId, Number(api.conversationId))),
      }),
    ],
  });
}
