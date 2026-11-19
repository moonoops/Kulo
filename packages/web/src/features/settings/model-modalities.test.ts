import { describe, expect, it } from "vitest";
import type { ProviderModelItem } from "@moco/protocol";
import { getModelModalities, toProviderModelItem } from "./settings-helpers";

const catalog: ProviderModelItem = {
  id: "five", name: "Five", reasoning: false, vision: true,
  modalities: ["text", "image", "audio", "video", "pdf"],
  contextWindow: 100_000, maxTokens: 10_000, supportedThinkingLevels: ["off"],
};

describe("model input type normalization", () => {
  it("restores discovered defaults for reset without aliasing the catalog array", () => {
    const restored = getModelModalities({}, catalog);
    expect(restored).toEqual(["text", "image", "audio", "video", "pdf"]);
    restored.pop();
    expect(catalog.modalities).toContain("pdf");
  });
  it("resets unknown models to text and keeps vision consistent", () => {
    expect(getModelModalities({})).toEqual(["text"]);
    expect(toProviderModelItem({ id: "unknown" })).toMatchObject({ modalities: ["text"], vision: false });
  });
  it("preserves all five explicit selections over conflicting legacy vision and discovered values", () => {
    expect(toProviderModelItem({ id: "five", modalities: [...catalog.modalities], vision: false }, undefined, { ...catalog, modalities: ["text"] }))
      .toMatchObject({ modalities: ["text", "image", "audio", "video", "pdf"], vision: true });
    expect(toProviderModelItem({ id: "five", modalities: ["audio", "pdf"], vision: true }, undefined, catalog))
      .toMatchObject({ modalities: ["audio", "pdf"], vision: false });
  });
  it("reads old vision-only models and retains explicit empty-array text normalization", () => {
    expect(getModelModalities({ vision: true }, catalog)).toEqual(["text", "image"]);
    expect(getModelModalities({ vision: false }, catalog)).toEqual(["text"]);
    expect(getModelModalities({ modalities: [], vision: true }, catalog)).toEqual(["text"]);
  });
});
