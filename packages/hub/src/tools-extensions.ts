import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { num, obj, oneOf, str } from "@earendil-works/pi-schema";
import type { SettingsAssistant } from "./settings-assistant.js";
import type { KuloExtensions } from "./extensions.js";
import { EXTENSIONS_SETUP_GUIDE } from "./prompts.js";

interface ExtensionSetupHost { extensions: KuloExtensions; settingsAssistant: Pick<SettingsAssistant, "capabilityContext" | "workspaceAction"> }
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function createExtensionSetupExtension(get: () => ExtensionSetupHost) {
  return defineExtension({
    name: "kulo-extension-setup",
    sections: [section("kulo_extensions_setup", () => EXTENSIONS_SETUP_GUIDE, { tag: false })],
    tools: [
      defineTool({ name: "kulo_extension_manage", description: "Install, enable, stop, or propose removing a verified managed extension after reading its `expected_revision` via `kulo_settings_read(section='extensions')` (stays disabled after install; `remove` creates a confirmation card, others submit background jobs). 关键词：安装启用停用卸载扩展插件 Billion Context", parameters: obj({ id: str(), action: oneOf(["install", "enable", "stop", "remove"]), expected_revision: num() }), deferred: true, replay: "safe", execute: async ({ id, action, expected_revision }, api) => {
        const client = await get().settingsAssistant.capabilityContext();
        const commandId = `extension:${api.callId}`;
        if (action === "remove") return output(await get().settingsAssistant.workspaceAction(commandId, "删除扩展", [id, "保留主对话和历史"],
          () => Promise.resolve(), { kind: "extension-remove", id, expectedRevision: expected_revision, commandId }));
        return output(await get().extensions.request({ id, operation: action, expectedRevision: expected_revision, commandId, clientId: client.clientId }));
      } }),
    ],
  });
}
