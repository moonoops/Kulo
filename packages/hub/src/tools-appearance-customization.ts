import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { DEFAULT_APPEARANCE_CUSTOMIZATION, validateAppearanceCustomization, type AppearanceCustomization } from "@kulo/protocol";
import { APPEARANCE_CUSTOMIZATION_GUIDE } from "./prompts.js";

export interface AppearanceCustomizationHost {
  read: () => Promise<AppearanceCustomization | null>;
  propose: (customization: AppearanceCustomization, commandId: string) => Promise<unknown>;
}

const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function createAppearanceCustomizationToolsExtension(host: AppearanceCustomizationHost) {
  return defineExtension({
    name: "kulo-appearance-customization",
    sections: [section("kulo_appearance_customization", () => APPEARANCE_CUSTOMIZATION_GUIDE, { tag: false })],
    tools: [
      defineTool({
        name: "kulo_appearance_propose", description: "Validate contrast in both light and dark modes and create a user preview/apply card (`config` JSON with `name`, `palettes`, `useDefaultColors`, `fonts`; read current values first via `kulo_settings_read(section='appearance')`; never executes CSS or auto-applies).",
        parameters: obj({ config: str() }), replay: "safe",
        execute: async ({ config }, api) => {
          if (config.length > 24_000) throw new Error("外观方案内容过长。");
          const current = await host.read();
          const proposed = validateAppearanceCustomization(JSON.parse(config), current ?? DEFAULT_APPEARANCE_CUSTOMIZATION);
          return result(await host.propose(proposed, `appearance-${api.callId}`));
        },
      }),
    ],
  });
}
