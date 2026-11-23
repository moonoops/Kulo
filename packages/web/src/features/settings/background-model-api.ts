import type {
  AmbientLocalEngine,
  AssistantBackgroundModelAdvice,
  AssistantBackgroundModelStatus,
} from "@kulo/protocol";
import { apiRequest } from "../../kulo-api";

export interface BackgroundModelView {
  backgroundModel: AssistantBackgroundModelStatus;
  advice?: AssistantBackgroundModelAdvice;
  localHost?: boolean;
  canManageHub?: boolean;
}

export const backgroundModelApi = {
  get: (options?: { includeAdvice?: boolean; signal?: AbortSignal }) =>
    apiRequest<BackgroundModelView>(
      `/api/assistant/background-model${options?.includeAdvice ? "?includeAdvice=1" : ""}`,
      { signal: options?.signal },
    ),
  configure: (body: {
    mode: "auto" | "local-managed" | "kulo-provider";
    engine?: AmbientLocalEngine;
    modelId?: string;
    providerId?: string;
    confirmed?: boolean;
  }) =>
    apiRequest<
      BackgroundModelView & {
        requiresConfirmation?: boolean;
        proposal?: Record<string, unknown>;
      }
    >("/api/assistant/background-model", { method: "POST", body }),
};
