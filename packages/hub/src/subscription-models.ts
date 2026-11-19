import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { isConversationModel, isImageGenerationModel, type CustomModelConfig } from "@kulo/protocol";

function prefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

/** A manually supplied ID still needs one unambiguous native wire protocol. */
export function subscriptionModelTemplate(providerId: string, id: string, models: readonly Model<Api>[]): Model<Api> {
  if (isImageGenerationModel({ id })) throw new Error(`模型「${id}」是图像生成模型，请在工具技能的图像能力中配置。`);
  const exact = models.find((model) => model.id === id);
  if (exact) return exact;
  if (models.length && new Set(models.map((model) => model.api)).size === 1) return models[0]!;
  const family = id.split(/[/-]/, 1)[0];
  const matching = models.filter((model) => model.id.split(/[/-]/, 1)[0] === family);
  const bestLength = Math.max(0, ...matching.map((model) => prefixLength(model.id, id)));
  const best = matching.filter((model) => prefixLength(model.id, id) === bestLength);
  if (best.length && new Set(best.map((model) => model.api)).size === 1) return best[0]!;
  throw new Error(`无法确定订阅 ${providerId} 中模型 ${id} 的协议，请使用该订阅已支持的模型系列。`);
}

export function validateSubscriptionModelTemplates(subscriptions: Record<string, CustomModelConfig[]> | undefined): void {
  if (!subscriptions) return;
  const providers = new Map(builtinProviders().filter((provider) => provider.auth.oauth).map((provider) => [provider.id, provider]));
  for (const [providerId, models] of Object.entries(subscriptions)) {
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`供应商 ${providerId} 不支持订阅模型配置。`);
    for (const model of models.filter(isConversationModel)) subscriptionModelTemplate(providerId, model.id, provider.getModels());
  }
}
