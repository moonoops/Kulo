import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CustomModelConfig, ProviderModelItem } from "@moco/protocol";
import { ModelNativeToolsFields, modelConfigFromCatalog, nativeSearchAvailable } from "./api-model-list";
import { toProviderModelItem } from "./settings-helpers";

const model: CustomModelConfig = { id: "search-capable", modalities: ["text", "image"], nativeTools: { webSearch: true } };
const catalog: ProviderModelItem = { id: model.id, name: "Search capable", api: "openai-responses", modalities: ["text", "image"], reasoning: true, vision: true, contextWindow: 100_000, maxTokens: 8_000, supportedThinkingLevels: ["low", "high"], nativeTools: { webSearch: true } };

function fields(api: string, value = model, disabled = false) {
  return renderToStaticMarkup(<ModelNativeToolsFields model={value} api={api} disabled={disabled} onUpdate={() => {}} />);
}
function control(html: string) { return html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0] ?? ""; }

describe("per-model native tools", () => {
  it("offers native search only for APIs with a native tool adapter", () => {
    for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses", "anthropic-messages"]) expect(nativeSearchAvailable(api)).toBe(true);
    for (const api of [undefined, "openai-completions", "google-generative-ai", "google-vertex", "bedrock-converse-stream", "unknown"]) expect(nativeSearchAvailable(api)).toBe(false);
  });
  it("renders a separate native tools group without adding a search input modality or verified claim", () => {
    const html = fields("openai-responses");
    expect(html).toContain("原生工具");
    expect(html).toContain("联网搜索");
    expect(control(html)).toContain('checked=""');
    expect(control(html)).not.toContain("disabled");
    expect(html).not.toContain("已验证");
    expect(model.modalities).toEqual(["text", "image"]);
  });
  it("keeps an unsupported saved true value visible and allows turning it off", () => {
    const html = fields("openai-completions");
    expect(control(html)).toContain('checked=""');
    expect(control(html)).not.toContain("disabled");
    expect(html).toContain("当前接口暂不支持原生联网搜索。");
    expect(control(fields("openai-completions", { ...model, nativeTools: { webSearch: false } }))).toContain("disabled");
    expect(control(fields("openai-responses", model, true))).toContain("disabled");
  });
  it.each(["google-generative-ai", "google-vertex"])("disables %s native search without preventing an existing setting from being turned off", (api) => {
    const current = fields(api);
    expect(current).toContain("当前接口不支持联网搜索与智能体工具同时使用。");
    expect(control(current)).toContain('checked=""');
    expect(control(current)).not.toContain("disabled");
    const inactive = fields(api, { ...model, nativeTools: { webSearch: false } });
    expect(control(inactive)).toContain("disabled");
    expect(control(inactive)).not.toContain('checked=""');
    expect(model.modalities).toEqual(["text", "image"]);
  });
  it("copies native tools when adding a discovered model and keeps each draft independent", () => {
    const draft = modelConfigFromCatalog(catalog, "openai-responses");
    expect(draft.nativeTools).toEqual({ webSearch: true });
    expect(draft.nativeTools).not.toBe(catalog.nativeTools);
    draft.nativeTools!.webSearch = false;
    expect(catalog.nativeTools).toEqual({ webSearch: true });
  });
  it("preserves explicit disabled tools over catalog settings when assembling model choices", () => {
    expect(toProviderModelItem({ ...model, nativeTools: { webSearch: false } }, undefined, catalog).nativeTools).toEqual({ webSearch: false });
    expect(toProviderModelItem({ id: model.id }, undefined, catalog).nativeTools).toEqual({ webSearch: true });
  });
  it("disables native search on third-party APIs while allowing OpenRouter official preset", () => {
    expect(nativeSearchAvailable("openai-responses", { officialSource: false })).toBe(false);
    expect(nativeSearchAvailable("openai-completions", { officialSource: true, presetId: "openrouter" })).toBe(true);
    const thirdPartyHtml = renderToStaticMarkup(
      <ModelNativeToolsFields model={{ id: "gpt-5", nativeTools: { webSearch: false } }} api="openai-responses" officialSource={false} disabled={false} onUpdate={() => {}} />,
    );
    expect(control(thirdPartyHtml)).toContain("disabled");
    expect(thirdPartyHtml).toContain("第三方接口默认使用 Moco 搜索工具");
    expect(modelConfigFromCatalog(catalog, "openai-responses", { officialSource: false }).nativeTools).toBeUndefined();
  });
});
