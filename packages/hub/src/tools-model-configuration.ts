import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { CUSTOM_PROVIDER_APIS, type CustomProviderApi, type CustomProviderConfig } from "@moco/protocol";
import type { MocoModelConfiguration } from "./model-configuration.js";
import { MODEL_CONFIGURATION_GUIDE } from "./prompts.js";

export interface ModelConfigurationToolsOptions {
  service: Pick<MocoModelConfiguration, "workspace" | "prepare" | "discover" | "updateDraft">;
  lookupMetadata?: (input: {
    providerId?: string;
    preset?: string;
    api?: CustomProviderApi;
    modelIds?: string[];
    forceRefresh?: boolean;
  }) => Promise<unknown>;
  calibrate?: (rawUpdates: string, title: string | undefined, commandId: string) => Promise<unknown>;
  context: () => Promise<{ clientId: string }>;
}
export function createModelConfigurationToolsExtension(options: ModelConfigurationToolsOptions) {
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  return defineExtension({
    name: "moco-model-configuration",
    sections: [section("moco_model_configuration", () => MODEL_CONFIGURATION_GUIDE, { tag: false })],
    tools: [
      defineTool({
        name: "moco_model_metadata_lookup",
        description: "Look up authoritative model metadata (context window, max output, modalities, legal thinking levels, native search eligibility) from the online-refreshable public registry (`models.dev` + LiteLLM + `pi-ai`). Omit `provider_id` and `model_ids` to inspect all configured connections at once; set `force_refresh: true` to force an online refresh.",
        parameters: obj({
          provider_id: opt(str()),
          preset: opt(str()),
          api: opt(oneOf(CUSTOM_PROVIDER_APIS)),
          model_ids: opt(arr(str())),
          force_refresh: opt(bool()),
        }),
        replay: "safe",
        execute: async (args) => {
          if (!options.lookupMetadata) throw new Error("模型元数据目录当前不可用。");
          return result(await options.lookupMetadata({
            providerId: args.provider_id,
            preset: args.preset,
            api: args.api,
            modelIds: args.model_ids,
            forceRefresh: args.force_refresh,
          }));
        },
      }),
      defineTool({
        name: "moco_model_calibrate",
        description: "Atomically calibrate public parameters (contextWindow, maxTokens, modalities, vision, reasoning, thinkingEnabled, thinkingLevels, thinkingLevelMap, nativeTools, name, purpose) across one or multiple existing connections in a single call, creating an undoable receipt card. Never modifies baseUrl, api, credentials, or adds/removes connections or models. `updates_json` is a JSON array of `{ providerId, models: [{ id, patch }] }`.",
        parameters: obj({
          updates_json: str(),
          title: opt(str()),
        }),
        execute: async (args, api) => {
          if (!options.calibrate) throw new Error("批量模型校准当前不可用。");
          return result(await options.calibrate(args.updates_json, args.title, api.callId));
        },
      }),
      defineTool({
        name: "moco_model_configuration_read",
        description: "Read the current window's public model drafts and editable API connections (never returns secrets).",
        parameters: obj({}),
        replay: "safe",
        execute: async () => result(await options.service.workspace((await options.context()).clientId)),
      }),
      defineTool({
        name: "moco_model_configuration_prepare",
        description: "Prepare a provider configuration card for the current window using public name/base_url/api/preset (or provider_id to edit an existing custom connection; multiple drafts for distinct connections are allowed); secrets are entered on the card.",
        parameters: obj({ provider_id: opt(str()), name: opt(str()), api: opt(oneOf(CUSTOM_PROVIDER_APIS)), base_url: opt(str()), preset: opt(str()) }),
        execute: async (args) => result(await options.service.prepare({ clientId: (await options.context()).clientId, providerId: args.provider_id, name: args.name, api: args.api, baseUrl: args.base_url, preset: args.preset })),
      }),
      defineTool({
        name: "moco_model_configuration_discover",
        description: "Discover live model catalog entries for a draft (read latest expected_revision first; pass `draft_id` when multiple drafts exist; performs no generation or paid probes).",
        parameters: obj({ expected_revision: num(), draft_id: opt(str()) }),
        replay: "safe",
        execute: async (args) => result(await options.service.discover((await options.context()).clientId, args.expected_revision, args.draft_id)),
      }),
      defineTool({
        name: "moco_model_configuration_update",
        description: "Update a public model draft for user review (provider_json holds id/name/api/baseUrl/models with no secrets; selected_model_ids selects models to add; optional draft_id and default_model_id; does not auto-save).",
        parameters: obj({ expected_revision: num(), draft_id: opt(str()), provider_json: str(), selected_model_ids: arr(str()), default_model_id: opt(str()) }),
        execute: async (args) => {
          let provider: CustomProviderConfig;
          try { provider = JSON.parse(args.provider_json) as CustomProviderConfig; }
          catch { throw new Error("供应商草稿必须为有效 JSON 对象。"); }
          return result(await options.service.updateDraft({ clientId: (await options.context()).clientId, draftId: args.draft_id, expectedRevision: args.expected_revision, provider, selectedModelIds: args.selected_model_ids, defaultModelId: args.default_model_id }));
        },
      }),
    ],
  });
}
