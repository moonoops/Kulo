import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type Harness } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { MemoryServicePrepareRequest, ProviderCatalogItem } from "@moco/protocol";
import { SettingsAssistantDoc, type SettingsAssistant } from "./settings-assistant.js";
import type { MocoMemoryService } from "./memory-service.js";
import { MEMORY_SETUP_GUIDE } from "./prompts.js";

interface MemorySetupHost {
  harness: Harness;
  memoryService: MocoMemoryService;
  settingsAssistant: SettingsAssistant;
  listProviders(): Promise<ProviderCatalogItem[]>;
}
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function createMemorySetupExtension(get: () => MemorySetupHost) {
  return defineExtension({
    name: "moco-memory-setup",
    sections: [section("moco_memory_setup", () => MEMORY_SETUP_GUIDE, { tag: false })],
    tools: [
      defineTool({
        name: "moco_memory_service_read", description: "Read local Hindsight installation, connection, job, and secret-input status plus reusable API model connections (never returns secrets).",
        parameters: obj({}), replay: "safe", outputLimits: { maxBytes: 24_000, maxLines: 200 },
        execute: async () => {
          const client = await get().settingsAssistant.memoryContext();
          const snapshot = await get().memoryService.snapshot(client.clientId);
          const providers = await get().listProviders();
          await get().harness.commit(async (tx) => { (await tx.doc(SettingsAssistantDoc)).observedRevisions.memory = snapshot.revision; }, BACKGROUND_CONTEXT);
          return output({ ...snapshot, apiConnections: providers.filter((provider) => provider.authType === "api_key").map((provider) => ({
            id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
            models: provider.models.slice(0, 40).map((model) => ({ id: model.id, name: model.name, api: model.api })),
          })) });
        },
      }),
      defineTool({
        name: "moco_memory_service_prepare", description: "Prepare a right-hand confirmation card for local Hindsight `deploy`, memory-model `configure`, or `uninstall` (`config` JSON allows `model` or `deleteData` only, no secrets; existing server connections use the left-hand Long-Term Memory form; `uninstall` keeps data by default).",
        parameters: obj({ operation: oneOf(["deploy", "configure", "uninstall"]), config: opt(str()) }), replay: "safe",
        execute: async ({ operation, config }, api) => {
          const client = await get().settingsAssistant.memoryContext();
          if (config && config.length > 8000) throw new Error("配置内容过长。");
          const value = config ? JSON.parse(config) as Record<string, unknown> : {};
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["model", "deleteData"].includes(key))) throw new Error("配置字段无效；连接信息请在左侧表单填写，模型凭据请使用保密输入。");
          const state = await get().harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
          const revision = state?.observedRevisions.memory;
          if (revision === undefined) throw new Error("请先读取记忆服务状态。");
          return output(await get().memoryService.prepare({ ...value, operation, commandId: `memory-${api.callId}`, clientId: client.clientId, expectedRevision: revision } as MemoryServicePrepareRequest));
        },
      }),
    ],
  });
}
