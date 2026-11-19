import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { CUSTOM_PROVIDER_APIS, type CustomProviderConfig } from "@moco/protocol";
import type { MocoModelConfiguration } from "./model-configuration.js";
import { MODEL_CONFIGURATION_GUIDE } from "./prompts.js";

export interface ModelConfigurationToolsOptions {
  service: Pick<MocoModelConfiguration, "workspace" | "prepare" | "discover" | "updateDraft">;
  context: () => Promise<{ clientId: string }>;
}
export function createModelConfigurationToolsExtension(options: ModelConfigurationToolsOptions) {
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  return defineExtension({
    name: "moco-model-configuration",
    sections: [section("moco_model_configuration", () => MODEL_CONFIGURATION_GUIDE, { tag: false })],
    tools: [
      defineTool({ name: "moco_model_configuration_read", description: "Read the current window's public model draft and editable API connections (never returns secrets).", parameters: obj({}), replay: "safe", execute: async () => result(await options.service.workspace((await options.context()).clientId)) }),
      defineTool({ name: "moco_model_configuration_prepare", description: "Prepare a provider configuration card for the current window using public name/base_url/api/preset (or provider_id to edit an existing custom connection); secrets are entered on the card.", parameters: obj({ provider_id: opt(str()), name: opt(str()), api: opt(oneOf(CUSTOM_PROVIDER_APIS)), base_url: opt(str()), preset: opt(str()) }), execute: async (args) => result(await options.service.prepare({ clientId: (await options.context()).clientId, providerId: args.provider_id, name: args.name, api: args.api, baseUrl: args.base_url, preset: args.preset })) }),
      defineTool({ name: "moco_model_configuration_discover", description: "Discover live model catalog entries for the current draft (read latest expected_revision first; performs no generation or paid probes).", parameters: obj({ expected_revision: num() }), replay: "safe", execute: async (args) => result(await options.service.discover((await options.context()).clientId, args.expected_revision)) }),
      defineTool({ name: "moco_model_configuration_update", description: "Update the public model draft for user review (provider_json holds id/name/api/baseUrl/models with no secrets; selected_model_ids selects models to add; optional default_model_id; does not auto-save).", parameters: obj({ expected_revision: num(), provider_json: str(), selected_model_ids: arr(str()), default_model_id: opt(str()) }), execute: async (args) => {
        let provider: CustomProviderConfig;
        try { provider = JSON.parse(args.provider_json) as CustomProviderConfig; }
        catch { throw new Error("供应商草稿必须为有效 JSON 对象。"); }
        return result(await options.service.updateDraft({ clientId: (await options.context()).clientId, expectedRevision: args.expected_revision, provider, selectedModelIds: args.selected_model_ids, defaultModelId: args.default_model_id }));
      } }),
    ],
  });
}
