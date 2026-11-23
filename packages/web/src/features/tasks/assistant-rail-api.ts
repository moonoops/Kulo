import type { AssistantItemView } from "@kulo/protocol";
import { apiRequest } from "../../kulo-api";

export interface DismissAssistantItemsResult {
  dismissedIds: string[];
  skippedIds: string[];
  assistantRevision: number;
  items: AssistantItemView[];
}

export function dismissAssistantItems(
  items: readonly AssistantItemView[],
): Promise<DismissAssistantItemsResult> {
  return apiRequest<DismissAssistantItemsResult>("/api/assistant/items/dismiss", {
    method: "POST",
    body: {
      items: items.map((item) => ({
        id: item.id,
        expectedRevision: item.revision,
        expectedUpdatedAt: item.updatedAt,
      })),
    },
  });
}
