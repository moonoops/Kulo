import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MocoSettingsView, ProviderCatalogItem } from "@moco/protocol";
import { ModelSelectionFields } from "./model-selection-fields";
import { buildProviderModelGroups, clampModelEffort, selectedDefaultProvider, toProviderModelItem } from "./settings-helpers";

const model: MocoSettingsView["blocks"]["model"]["value"] = {
  baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-responses", defaultModel: "stale-model", thinkingLevel: "high",
  gatewayModels: [{ id: "gateway-added" }], defaultProvider: "api-demo",
  customProviders: [{ id: "api-demo", name: "Demo", api: "openai-responses", baseUrl: "http://127.0.0.1:9/v1",
    models: [{ id: "added", thinkingLevels: [{ id: "careful", label: "仔细思考", value: "high" }] }, { id: "added" }] }],
};
const catalog: ProviderCatalogItem[] = ["moco-gateway", "api-demo", "openai"].map((id) => ({
  id, name: id, builtin: id !== "api-demo", isGateway: id === "moco-gateway", authenticated: true, authType: "api_key",
  supportsApiKey: true, supportsOAuth: id === "openai",
  api: "openai-responses", models: [toProviderModelItem({ id: "catalog-only" }), toProviderModelItem({ id: "stale-model" })],
}));

describe("configured model selection", () => {
  it("excludes image generation outputs from every API and subscription group while preserving vision chat", () => {
    const configured: MocoSettingsView["blocks"]["model"]["value"] = {
      ...model,
      gatewayModels: [{ id: "gpt-image-2.6-flare" }, { id: "gateway-vision", modalities: ["text", "image"] }],
      customProviders: [{ ...model.customProviders![0]!, models: [{ id: "added" }, { id: "custom-render", purpose: "image" as const }] }],
    };
    const subscription = { ...catalog[2]!, id: "openai-codex", authType: "oauth" as const, modelCatalogSource: "remote" as const,
      models: [toProviderModelItem({ id: "gpt-image-2.5-sunburst" }), toProviderModelItem({ id: "metadata-render", outputModalities: ["image"] }), toProviderModelItem({ id: "subscription-vision", modalities: ["text", "image"] })] };
    const groups = buildProviderModelGroups(configured, [...catalog, subscription]);
    expect(groups.map((group) => [group.providerId, group.models.map((item) => item.id)])).toEqual([
      ["moco-gateway", ["gateway-vision"]], ["api-demo", ["added"]], ["openai-codex", ["subscription-vision"]],
    ]);
    expect(groups[0]!.models[0]!.vision).toBe(true);
  });
  it("only exposes explicitly added API models, excluding the catalog, old default and duplicate IDs", () => {
    const groups = buildProviderModelGroups(model, catalog);
    expect(groups.map((group) => [group.providerId, group.models.map((item) => item.id)])).toEqual([
      ["moco-gateway", ["gateway-added"]], ["api-demo", ["added"]],
    ]);
    expect(groups[1]?.models[0]?.thinkingLevels?.[0]?.label).toBe("仔细思考");
    expect(clampModelEffort("high", groups[1]!.models[0]!)).toBe("careful");
  });

  it("keeps configured connections with empty model lists without filling them from catalogs", () => {
    const empty = { ...model, gatewayDisabled: true, customProviders: [{ ...model.customProviders![0]!, models: [] }] };
    expect(buildProviderModelGroups(empty, catalog)).toEqual([{ providerId: "api-demo", label: "Demo", models: [] }]);
    expect(buildProviderModelGroups({ ...empty, customProviders: [], defaultModel: "", defaultProvider: "" }, catalog)).toEqual([]);
  });

  it("uses catalog metadata only for explicitly added models and lets saved overrides win", () => {
    const existing = toProviderModelItem({ id: "added" });
    const groups = buildProviderModelGroups(model, [{ ...catalog[1]!, models: [
      { ...existing, supportedThinkingLevels: ["off", "minimal", "high", "xhigh"] },
    ] }]);
    expect(groups[1]?.models[0]?.supportedThinkingLevels).toEqual(["careful"]);
    const legacy = { ...model, customProviders: [{ ...model.customProviders![0]!, models: [{ id: "added" }] }] };
    expect(buildProviderModelGroups(legacy, [{ ...catalog[1]!, models: [
      { ...existing, supportedThinkingLevels: ["off", "minimal", "high", "xhigh"] },
    ] }])[1]?.models[0]?.supportedThinkingLevels).toEqual(["off", "minimal", "high", "xhigh"]);
    expect(buildProviderModelGroups(legacy, [{ ...catalog[1]!, models: [
      { ...existing, reasoning: false, supportedThinkingLevels: ["off"] },
    ] }])[1]?.models[0]?.reasoning).toBe(false);
  });

  it("exposes connected OAuth subscription models and excludes unconnected subscriptions", () => {
    const subscription = { ...catalog[2]!, id: "openai-codex", authType: "oauth" as const };
    const groups = buildProviderModelGroups({ ...model, gatewayDisabled: true, customProviders: [] }, [subscription]);
    expect(groups[0]?.providerId).toBe("openai-codex");
    expect(groups[0]?.models).toEqual(subscription.models);
    expect(buildProviderModelGroups({ ...model, gatewayDisabled: true, customProviders: [] }, [{ ...subscription, authenticated: false }])).toEqual([]);
  });

  it("does not offer a subscription's preset directory as remotely discovered models", () => {
    const subscription = { ...catalog[2]!, id: "openai-codex", authType: "oauth" as const, modelCatalogSource: "preset" as const };
    const withoutApis = { ...model, gatewayDisabled: true, customProviders: [] };
    expect(buildProviderModelGroups(withoutApis, [subscription])).toEqual([]);
    expect(buildProviderModelGroups(withoutApis, [{ ...subscription, modelCatalogSource: "remote" }])[0]?.models).toEqual(subscription.models);
    expect(buildProviderModelGroups(withoutApis, [{ ...subscription, modelCatalogSource: "configured" }])[0]?.models).toEqual(subscription.models);
  });

  it("keeps explicitly added subscription models without mixing in its preset catalog", () => {
    const subscription = { ...catalog[2]!, id: "openai-codex", authType: "oauth" as const, modelCatalogSource: "preset" as const };
    const configured = { ...model, gatewayDisabled: true, customProviders: [], subscriptionModels: { "openai-codex": [{ id: "manually-added" }] } };
    expect(buildProviderModelGroups(configured, [subscription])[0]?.models.map((item) => item.id)).toEqual(["manually-added"]);
    expect(buildProviderModelGroups(configured, [{ ...subscription, modelCatalogSource: "remote" }])[0]?.models.map((item) => item.id)).toEqual(["manually-added", ...subscription.models.map((item) => item.id)]);
    expect(buildProviderModelGroups(configured, [{ ...subscription, authenticated: false }])).toEqual([]);
    expect(buildProviderModelGroups(configured, [{ ...subscription, configuredModels: [] }])).toEqual([]);
  });

  it("starts with no provider selection while preserving explicitly selected legacy gateways", () => {
    expect(selectedDefaultProvider({ ...model, defaultProvider: undefined, defaultModel: "" })).toBe("");
    expect(selectedDefaultProvider({ ...model, defaultProvider: "", defaultModel: "" })).toBe("");
    expect(selectedDefaultProvider({ ...model, defaultProvider: undefined, gatewayDisabled: true })).toBe("");
    expect(selectedDefaultProvider({ ...model, defaultProvider: undefined })).toBe("moco-gateway");
  });

  it.each(["form", "settings", "compact"] as const)("preserves labelled, unselected controls in the %s layout", (layout) => {
    const html = renderToStaticMarkup(<ModelSelectionFields groups={[]} providerId="" modelId="" thinkingLevel="medium"
      onProviderChange={() => {}} onModelChange={() => {}} onThinkingChange={() => {}} defaults layout={layout} />);
    expect(html).toContain('aria-label="默认供应商"');
    expect(html).toContain('aria-label="默认模型"');
    expect(html).toContain('aria-label="默认思考强度"');
    expect(html).toContain("未选择");
    expect(html).not.toContain('role="radio');
    expect(html).not.toContain("gpt-4o");
    expect(html).not.toContain("中等");
  });

  it("preserves full connection and model names when compact controls have limited width", () => {
    const providerName = "Long provider connection with a regional endpoint";
    const modelId = "model-with-a-long-configured-id-and-version-2026-11-17";
    const html = renderToStaticMarkup(<ModelSelectionFields groups={[{ providerId: "api-long", label: providerName,
      models: [toProviderModelItem({ id: modelId, reasoning: true })] }]} providerId="api-long" modelId={modelId}
      thinkingLevel="high" layout="compact" onProviderChange={() => {}} onModelChange={() => {}} onThinkingChange={() => {}} />);
    expect(html).toContain(providerName);
    expect(html).toContain(`title="${modelId}"`);
    expect(html).toContain(`value="${modelId}"`);
    expect(html).toContain('aria-label="模型"');
  });

  it("shows an existing unlisted model without adding it as a selectable option", () => {
    const html = renderToStaticMarkup(<ModelSelectionFields groups={[]} providerId="moco-gateway" modelId="legacy-model" thinkingLevel="high"
      onProviderChange={() => {}} onModelChange={() => {}} onThinkingChange={() => {}} />);
    expect(html).toContain("兼容网关");
    expect(html).toContain("legacy-model（未添加）");
    expect(html).not.toContain('data-key="legacy-model"');
  });
});
