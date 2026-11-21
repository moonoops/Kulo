import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type Harness } from "@earendil-works/pi-durable";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { MemoryServiceJob, MemoryServicePrepareRequest, MemoryServiceSnapshot, ProviderCatalogItem } from "@kulo/protocol";
import { SettingsAssistantDoc, type SettingsAssistant } from "./settings-assistant.js";
import { isActiveSettingsConversation, isMainOrchestratorApi } from "./settings-doc.js";
import { resolveDeferredAddTools } from "./tool-surface.js";
import { findHostExecutable } from "./host-path.js";
import type { KuloMemoryService } from "./memory-service.js";
import { MEMORY_SETUP_GUIDE } from "./prompts.js";

interface MemorySetupHost {
  harness: Harness;
  memoryService: KuloMemoryService;
  settingsAssistant: SettingsAssistant;
  listProviders(): Promise<ProviderCatalogItem[]>;
  confirmMemoryServiceOperation?(input: {
    conversationId: number;
    callId: string;
    job: MemoryServiceJob;
  }): Promise<{ cardId: string; status: "pending" | "approved" | "denied" }>;
  executeMemoryServiceJob?(input: {
    jobId: string;
    clientId: string;
  }): Promise<MemoryServiceSnapshot>;
}
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

function mainChatMemoryClientId(conversationId: number): string {
  return `main-chat-${Math.max(0, Math.trunc(conversationId))}`;
}

function memoryCommandId(callId: string): string {
  const safe = callId.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 140) || "op";
  return `memory-${safe}`;
}

export function createMemorySetupExtension(get: () => MemorySetupHost) {
  return defineExtension({
    name: "kulo-memory-setup",
    sections: [
      section("kulo_memory_setup", async (input, context) => {
        const settings = await input.read.snapshot(SettingsAssistantDoc, context);
        return isActiveSettingsConversation(input.conversationId, settings) ? MEMORY_SETUP_GUIDE : undefined;
      }, { tag: false }),
    ],
    tools: [
      defineTool({
        name: "kulo_memory_service_read",
        description: "Read Hub host local Hindsight installation, running status, understanding/embedding/reranker models, connection, job, and secret-input status plus all ready Kulo model connections (API Key, Vertex AI, and logged-in OAuth subscriptions; never returns secrets). 关键词：Hindsight 长期记忆服务 安装状态 卸载 部署 检查本机记忆服务 向量模型 重排模型 理解模型",
        parameters: obj({}),
        deferred: true,
        replay: "safe",
        outputLimits: { maxBytes: 24_000, maxLines: 200 },
        execute: async (_args, api, context) => {
          const { allowed, isSettings } = await isMainOrchestratorApi(api, context);
          if (!allowed) {
            return { isError: true, output: [{ type: "text" as const, text: "仅主会话或设置助手可读取本机记忆服务状态。" }] };
          }
          const clientId = isSettings
            ? (await get().settingsAssistant.memoryContext()).clientId
            : mainChatMemoryClientId(Number(api.conversationId));
          const snapshot = await get().memoryService.snapshot(clientId);
          const providers = await get().listProviders();
          await get().harness.commit(async (tx) => { (await tx.doc(SettingsAssistantDoc)).observedRevisions.memory = snapshot.revision; }, BACKGROUND_CONTEXT);
          const addTools = isSettings ? [] : await resolveDeferredAddTools(api, context, ["kulo_memory_service_prepare"]);
          const kuloConnections = providers
            .filter((provider) => provider.authenticated && provider.models.length > 0)
            .map((provider) => ({
              id: provider.id,
              name: provider.name,
              authType: provider.authType,
              baseUrl: provider.baseUrl,
              memoryModelProvider: "kulo" as const,
              models: provider.models.slice(0, 40).map((model) => ({ id: model.id, name: model.name, api: model.api })),
            }));
          return {
            ...output({
              ...snapshot,
              localEnvironment: {
                uvAvailable: Boolean(findHostExecutable("uv")),
              },
              kuloConnections,
              apiConnections: kuloConnections.filter((provider) => provider.authType === "api_key"),
            }),
            ...(addTools.length ? { control: { addTools } } : {}),
          };
        },
      }),
      defineTool({
        name: "kulo_memory_service_prepare",
        description: "Manage Hub host local Hindsight: `deploy`, model `configure`, `uninstall`, or toggle long-term memory `enable` / `disable` (with connection health check on `enable`; read status first via `kulo_memory_service_read`). In main chat, executes directly with main-Agent authority by default; set `ask_user=true` for a user confirmation card. `config` JSON allows `model`, `embeddings`, `reranker`, or `deleteData` only (never secrets). For ANY ready Kulo connection (including Google Vertex AI, OpenAI/Anthropic/Gemini/proxies, or logged-in OAuth), pass `model: {\"provider\":\"kulo\",\"connectionId\":\"<id>\",\"model\":\"<modelId>\"}`. Standalone direct providers use `openai|anthropic|gemini|groq|ollama`. Optional `embeddings` (`onnx|openai|google|cohere|tei`) and `reranker` (`onnx|rrf|cohere|siliconflow|alibaba|zeroentropy|tei`) default to local ONNX. 关键词：卸载 Hindsight 删除记忆服务 部署记忆服务 配置 Hindsight 开启长期记忆 关闭长期记忆 打开记忆开关 配置向量模型 配置重排模型",
        parameters: obj({
          operation: oneOf(["deploy", "configure", "uninstall", "enable", "disable"]),
          config: opt(str()),
          ask_user: opt(bool({ description: "Main chat only: set true to show a confirmation card before executing deploy/configure/uninstall." })),
        }),
        deferred: true,
        replay: "safe",
        execute: async ({ operation, config, ask_user }, api, context) => {
          const { allowed, isSettings } = await isMainOrchestratorApi(api, context);
          if (!allowed) {
            return { isError: true, output: [{ type: "text" as const, text: "仅主会话或设置助手可管理本机记忆服务。" }] };
          }
          const clientId = isSettings
            ? (await get().settingsAssistant.memoryContext()).clientId
            : mainChatMemoryClientId(Number(api.conversationId));
          const state = await get().harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
          const revision = state?.observedRevisions.memory;
          if (revision === undefined) throw new Error("请先读取记忆服务状态。");
          if (operation === "enable" || operation === "disable") {
            const snapshot = await get().memoryService.setEnabled(operation === "enable", revision);
            await get().harness.commit(async (tx) => {
              (await tx.doc(SettingsAssistantDoc)).observedRevisions.memory = snapshot.revision;
            }, BACKGROUND_CONTEXT);
            return output({ status: operation === "enable" ? "enabled" : "disabled", snapshot });
          }
          if (config && config.length > 8000) throw new Error("配置内容过长。");
          const value = config ? JSON.parse(config) as Record<string, unknown> : {};
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["model", "embeddings", "reranker", "deleteData"].includes(key))) throw new Error("配置字段无效；仅支持 model、embeddings、reranker 或 deleteData，连接信息请在左侧表单填写，凭据请使用保密输入。");
          const commandId = memoryCommandId(api.callId);
          const snapshot = await get().memoryService.prepare({ ...value, operation, commandId, clientId, expectedRevision: revision } as MemoryServicePrepareRequest);
          if (isSettings) return output(snapshot);
          const job = snapshot.jobs.find((item) => item.id === commandId);
          if (job?.status === "awaiting-input") {
            return output({
              status: "requires_secret_input",
              job,
              snapshot,
              note: "该操作需要输入新的 API 密钥；请勿在对话中要求用户发送密钥，可调用 kulo_settings_navigate(module='identity') 引导用户在设置页安全填写。",
            });
          }
          if (job?.status === "awaiting-confirmation") {
            if (ask_user === true && get().confirmMemoryServiceOperation) {
              const confirmation = await get().confirmMemoryServiceOperation!({
                conversationId: Number(api.conversationId),
                callId: api.callId,
                job,
              });
              return output({
                status: "awaiting_user_confirmation",
                cardId: confirmation.cardId,
                job,
                snapshot,
              });
            }
            if (get().executeMemoryServiceJob) {
              const executed = await get().executeMemoryServiceJob!({ jobId: job.id, clientId });
              await get().harness.commit(async (tx) => {
                (await tx.doc(SettingsAssistantDoc)).observedRevisions.memory = executed.revision;
              }, BACKGROUND_CONTEXT);
              const updatedJob = executed.jobs.find((item) => item.id === job.id) ?? job;
              return output({
                status: updatedJob.status,
                job: updatedJob,
                snapshot: executed,
              });
            }
          }
          return output(snapshot);
        },
      }),
    ],
  });
}
