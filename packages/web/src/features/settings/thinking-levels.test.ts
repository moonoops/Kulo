import { describe, expect, it } from "vitest";
import { defaultModelThinkingLevels, getModelThinkingLevels, modelEffortOptions, toProviderModelItem, buildProviderModelGroups } from "./settings-helpers";
import type { MocoSettingsView } from "@moco/protocol";

describe("configurable model thinking levels", () => {
  it("starts with five ordered defaults and preserves saved custom labels and wire values", () => {
    const defaults = defaultModelThinkingLevels("openai-responses");
    expect(defaults.map((level) => level.id)).toEqual(["off", "low", "medium", "high", "xhigh"]);
    const saved = [...defaults, { id: "custom-deep", label: "深入推理", value: "max" }, { id: "custom-fast", label: "快速回答", value: "minimal" }];
    expect(getModelThinkingLevels({ thinkingLevels: saved }, "openai-responses")).toEqual(saved);
    const item = toProviderModelItem({ id: "model", reasoning: true, thinkingLevels: saved });
    expect(modelEffortOptions(item)).toContainEqual({ value: "custom-deep", label: "深入推理" });
    expect(modelEffortOptions(item)).toHaveLength(7);
    expect(modelEffortOptions({ ...item, reasoning: false })).toEqual([{ value: "off", label: "关闭" }]);
    expect(modelEffortOptions({ ...item, thinkingEnabled: false })).toEqual([{ value: "off", label: "关闭" }]);
  });

  it("migrates legacy mappings without losing custom wire values and explicitly handles native Google defaults", () => {
    expect(getModelThinkingLevels({ thinkingLevelMap: { low: "minimal", high: "max", medium: null } }, "openai-responses")).toEqual([
      { id: "off", label: "off", value: "off" },
      { id: "low", label: "low", value: "minimal" },
      { id: "high", label: "high", value: "max" },
    ]);
    expect(defaultModelThinkingLevels("google-generative-ai").at(-1)).toEqual({ id: "xhigh", label: "xhigh", value: "high" });
    expect(getModelThinkingLevels({ thinkingLevelMap: { off: null, high: "high" } }, "google-generative-ai")).toEqual([{ id: "high", label: "high", value: "high" }]);
    expect(getModelThinkingLevels({ thinkingLevelMap: { off: null } }, "google-generative-ai").map((level) => level.id)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("keeps custom levels available to Worker model groups before the remote catalog loads", () => {
    const thinkingLevels = [{ id: "careful", label: "仔细思考", value: "high" }];
    const model = { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-responses", defaultProvider: "api-demo", defaultModel: "model", thinkingLevel: "careful", gatewayDisabled: true,
      customProviders: [{ id: "api-demo", name: "Demo", api: "openai-responses", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "model", thinkingLevels }] }] } satisfies MocoSettingsView["blocks"]["model"]["value"];
    const item = buildProviderModelGroups(model, [])[0]!.models[0]!;
    expect(item.thinkingLevels).toEqual(thinkingLevels);
    expect(item.supportedThinkingLevels).toEqual(["careful"]);
  });
});
