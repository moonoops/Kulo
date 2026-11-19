import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderModelItem } from "@moco/protocol";
import { AddedModelsPane, AvailableModelsPane, buildManualModelConfig } from "./api-model-list";
import { toProviderModelItem } from "./settings-helpers";

const model = toProviderModelItem({ id: "refresh-retained-model" });
function render({ loading = false, hasFetched = true, models = [model], total = models.length, error, officialCatalog = false }: {
  loading?: boolean; hasFetched?: boolean; models?: ProviderModelItem[]; total?: number; error?: string; officialCatalog?: boolean;
} = {}) {
  return renderToStaticMarkup(<AvailableModelsPane compact={false} models={models} total={total}
    selectedKeys={new Set([model.id])} loading={loading} hasFetched={hasFetched} error={error}
    officialCatalog={officialCatalog} search="" onSearch={() => {}} disabled={false} onDiscover={() => {}} onSelectionChange={() => {}} />);
}

describe("available model refresh", () => {
  it("identifies public documentation as an official catalog without claiming account access", () => {
    const html = render({ officialCatalog: true });
    expect(html).toContain('aria-label="官方模型目录"');
    expect(html).toContain('aria-label="官方模型目录列表"');
    expect(html).toContain("刷新目录");
    expect(html).not.toContain("可用模型");
  });

  it("uses a full loading placeholder only before a catalog has been fetched", () => {
    const html = render({ loading: true, hasFetched: false, models: [] });
    expect(html).toContain('aria-label="正在获取模型列表"');
    expect(html).not.toContain('aria-label="可用模型列表"');
    expect(html).not.toContain("尚未获取模型列表");
  });

  it("retains the list, selected model and count while fetching again", () => {
    const html = render({ loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('aria-label="可用模型列表"');
    expect(html).toContain(model.id);
    expect(html).toContain('aria-selected="true"');
    expect(html).toMatch(/>1<\/span>/);
    expect(html).not.toContain('aria-label="正在获取模型列表"');
  });

  it("keeps the last fetched models visible when a refresh fails", () => {
    const html = render({ error: "目录读取失败" });
    expect(html).toContain("目录读取失败");
    expect(html).toContain("moco-model-pane-footer");
    expect(html).toContain('role="alert"');
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf('aria-label="可用模型列表"'));
    expect(html).toContain('aria-label="可用模型列表"');
    expect(html).toContain(model.id);
  });

  it("retains the existing empty or filtered state during a refresh", () => {
    expect(render({ loading: true, models: [] })).toContain("远端未返回可用模型");
    expect(render({ loading: true, models: [], total: 3 })).toContain("没有匹配的模型");
    expect(render({ loading: true, models: [] })).not.toContain('aria-label="正在获取模型列表"');
  });

  it("renders multi-purpose filter tabs, type badges, and type-specific parameter defaults", () => {
    const tts = buildManualModelConfig("gpt-4o-mini-tts", "tts", "openai-completions");
    const live = buildManualModelConfig("gemini-2.5-flash-native-audio-preview", "live", "openai-completions");
    expect(tts).toMatchObject({ purpose: "tts", protocolAdapter: "openai-speech" });
    expect(live).toMatchObject({ purpose: "live", protocolAdapter: "gemini-live" });

    const addedHtml = renderToStaticMarkup(
      <AddedModelsPane
        compact={false}
        models={[ { id: "gpt-5", contextWindow: 256_000 }, tts, live ]}
        total={3}
        availableModels={[]}
        api="openai-completions"
        expandedId={null}
        onExpandedChange={() => {}}
        search=""
        onSearch={() => {}}
        disabled={false}
        manualModelId=""
        onManualModelIdChange={() => {}}
        onAddManual={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        purposeFilter="all"
        onPurposeFilterChange={() => {}}
      />,
    );
    expect(addedHtml).toContain("256K");
    expect(addedHtml).toContain("TTS");
    expect(addedHtml).toContain("Live");
  });
});
