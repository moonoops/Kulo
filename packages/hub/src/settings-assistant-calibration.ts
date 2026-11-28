import type { CustomModelConfig, ModelCalibrationProviderUpdate } from "@kulo/protocol";

const ALLOWED_MODEL_CALIBRATION_PATCH_FIELDS = new Set([
  "name",
  "purpose",
  "protocolAdapter",
  "voices",
  "imageProfile",
  "imageDefaults",
  "customImageAdapter",
  "outputModalities",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "thinkingEnabled",
  "vision",
  "modalities",
  "thinkingLevelMap",
  "thinkingLevels",
  "nativeTools",
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseModelCalibrationUpdates(
  rawUpdates: string,
  redact: (text: string) => string,
): ModelCalibrationProviderUpdate[] {
  if (typeof rawUpdates !== "string" || rawUpdates.length > 64_000) {
    throw new Error("模型校准参数无效或过长。");
  }
  if (redact(rawUpdates) !== rawUpdates) {
    throw new Error("模型校准参数包含受保护内容，已拒绝写入；密钥请通过专用保密输入提供。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUpdates);
  } catch {
    throw new Error("模型校准参数必须为有效的 JSON 数组。");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new Error("请提供至少 1 个（最多 32 个）需要校准的连接。");
  }

  const updates: ModelCalibrationProviderUpdate[] = [];
  const seenProviders = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("每个连接的校准项必须为对象。");
    }
    const rec = entry as Record<string, unknown>;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    if (!providerId || seenProviders.has(providerId)) {
      throw new Error("连接标识无效或存在重复连接。");
    }
    seenProviders.add(providerId);
    if (!Array.isArray(rec.models) || rec.models.length === 0 || rec.models.length > 128) {
      throw new Error(`连接「${providerId}」缺少有效的模型更新列表。`);
    }
    const seenModels = new Set<string>();
    const models: ModelCalibrationProviderUpdate["models"] = [];
    for (const m of rec.models) {
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        throw new Error("每个模型的校准项必须为对象。");
      }
      const mRec = m as Record<string, unknown>;
      const id = typeof mRec.id === "string" ? mRec.id.trim() : "";
      if (!id || seenModels.has(id)) {
        throw new Error(`连接「${providerId}」中存在无效或重复的模型 ID。`);
      }
      seenModels.add(id);
      const patch = mRec.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
        throw new Error(`模型「${id}」缺少有效的参数修改项。`);
      }
      const invalidKeys = Object.keys(patch).filter((key) => !ALLOWED_MODEL_CALIBRATION_PATCH_FIELDS.has(key));
      if (invalidKeys.length > 0) {
        throw new Error(
          `模型校准仅允许修改已有模型的公开参数，不允许修改字段：${invalidKeys.join("、")}。连接地址、协议与密钥请使用模型配置卡片。`,
        );
      }
      models.push({ id, patch: cloneJson(patch as ModelCalibrationProviderUpdate["models"][number]["patch"]) });
    }
    updates.push({ providerId, models });
  }
  return updates;
}

function formatModelTokenCount(n: number | undefined): string {
  return n === undefined ? "默认" : n >= 1000 ? `${Math.round(n / 1000).toLocaleString("en-US")}K` : String(n);
}

function describeModelThinking(m: CustomModelConfig): string {
  if (m.reasoning === false || m.thinkingEnabled === false) return "关闭";
  if (m.thinkingLevels?.length) return m.thinkingLevels.map((level) => level.value).join("/");
  if (m.thinkingLevelMap) {
    const active = Object.entries(m.thinkingLevelMap)
      .filter(([, value]) => typeof value === "string")
      .map(([key]) => key);
    if (active.length) return active.join("/");
  }
  return m.reasoning ? "开启" : "默认";
}

export function describeModelCalibrationDiff(
  providerName: string,
  beforeModel: CustomModelConfig,
  afterModel: CustomModelConfig,
): string | null {
  const parts: string[] = [];
  if (beforeModel.contextWindow !== afterModel.contextWindow) {
    parts.push(`上下文 ${formatModelTokenCount(beforeModel.contextWindow)} → ${formatModelTokenCount(afterModel.contextWindow)}`);
  }
  if (beforeModel.maxTokens !== afterModel.maxTokens) {
    parts.push(`最大输出 ${formatModelTokenCount(beforeModel.maxTokens)} → ${formatModelTokenCount(afterModel.maxTokens)}`);
  }
  const beforeMods = (beforeModel.modalities ?? (beforeModel.vision ? ["text", "image"] : ["text"])).join("/");
  const afterMods = (afterModel.modalities ?? (afterModel.vision ? ["text", "image"] : ["text"])).join("/");
  if (beforeMods !== afterMods) {
    parts.push(`模态 ${beforeMods} → ${afterMods}`);
  }
  const beforeThink = describeModelThinking(beforeModel);
  const afterThink = describeModelThinking(afterModel);
  if (beforeThink !== afterThink) {
    parts.push(`思考档位 ${beforeThink} → ${afterThink}`);
  }
  const beforeSearch = beforeModel.nativeTools?.webSearch === true;
  const afterSearch = afterModel.nativeTools?.webSearch === true;
  if (beforeSearch !== afterSearch) {
    parts.push(`原生搜索 ${beforeSearch ? "开启" : "关闭"} → ${afterSearch ? "开启" : "关闭"}`);
  }
  if (beforeModel.purpose !== afterModel.purpose) {
    parts.push(`类型 ${beforeModel.purpose ?? "chat"} → ${afterModel.purpose ?? "chat"}`);
  }
  if (beforeModel.name !== afterModel.name && afterModel.name) {
    parts.push(`名称 ${beforeModel.name ?? beforeModel.id} → ${afterModel.name}`);
  }
  if (parts.length === 0) {
    if (JSON.stringify(beforeModel) === JSON.stringify(afterModel)) return null;
    parts.push("已更新模型参数");
  }
  return `${providerName} · ${afterModel.id}：${parts.join("；")}`;
}
