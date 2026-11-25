import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { CapabilitySnapshot } from "@kulo/protocol";
import { DEFAULT_CONTEXT_WINDOW } from "./config.js";
import type { LiveSettingsStore } from "./hub-kernel-ports.js";
import { isPrivateLocalModelEndpoint } from "./local-model-endpoint.js";

export interface ResolvedConversationModelContext {
  contextWindow: number;
  isUncalibratedLocal: boolean;
}

export const EMPTY_MEDIA_CAPABILITIES: CapabilitySnapshot = {
  revision: 1,
  connections: [],
  capabilities: [],
  imageRouting: { mode: "auto", preference: "balanced", rules: [], instructions: "" },
};

/**
 * Lazily resolves the active model's effective context window for a conversation without
 * breaking prompt caches or hardcoding global defaults across multi-model topics.
 */
export function createConversationContextWindowResolver(deps: {
  getHarness: () => Harness | undefined;
  models: Models;
  settingsStore: LiveSettingsStore;
}): (conversationId: ConversationId, context: Context) => Promise<ResolvedConversationModelContext> {
  return async (conversationId, context) => {
    const liveModel = deps.settingsStore.getModel();
    let provider = liveModel.defaultProvider || "";
    let modelId = liveModel.defaultModel || "";
    const harness = deps.getHarness();
    if (harness) {
      try {
        const conv = await harness.conversation(conversationId, context);
        if (conv) {
          const agent = await conv.agent(context);
          if (agent.model?.provider) provider = agent.model.provider;
          if (agent.model?.modelId) modelId = agent.model.modelId;
        }
      } catch {
        // Fall back cleanly to live settings model if conversation metadata is unavailable.
      }
    }
    const registered = provider && modelId ? deps.models.getModel(provider, modelId) : undefined;
    const contextWindow =
      registered?.contextWindow && registered.contextWindow > 0
        ? registered.contextWindow
        : liveModel.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const isLocalEndpoint = Boolean(registered?.baseUrl && isPrivateLocalModelEndpoint(registered.baseUrl));
    let hasExplicitCustomWindow = false;
    if (isLocalEndpoint && provider && modelId) {
      const customProvider = liveModel.customProviders?.find((item) => item.id === provider);
      const customModel = customProvider?.models?.find((item) => item.id === modelId);
      hasExplicitCustomWindow =
        typeof customModel?.contextWindow === "number" &&
        Number.isFinite(customModel.contextWindow) &&
        customModel.contextWindow > 0;
    }
    return {
      contextWindow,
      isUncalibratedLocal: isLocalEndpoint && !hasExplicitCustomWindow,
    };
  };
}
