import { describe, expect, it } from "vitest";
import { cleanGoogleImageModelId, getImageModelPreset, getImageModelProfile, isOfficialVertexBaseUrl, normalizeImageGenerationParameters, resolveVertexImageBaseUrl, validateCustomImageAdapter, type CustomImageAdapter } from "@kulo/protocol";

describe("image provider contracts", () => {
  it("uses model-specific Gemini resolution, grounding, and thinking controls", () => {
    const banana = getImageModelProfile("gemini-image", "gemini-nano-banana-2.1")!;
    expect(banana.thinkingLevels).toEqual(["minimal", "medium", "high"]);
    expect(banana.maxReferences).toBe(14);
    expect(getImageModelProfile("gemini-image", "gemini-3-pro-image")?.thinkingLevels).toEqual([]);
    const lite = getImageModelPreset("gemini-image", "gemini-3.1-flash-lite-image")!;
    expect(lite.defaults.size).toBe("1024px");
    expect(() => normalizeImageGenerationParameters({ size: "4K" }, lite.profile, lite.adapter)).toThrow();
    expect(() => normalizeImageGenerationParameters({ grounding: true }, lite.profile, lite.adapter)).toThrow();
    expect(getImageModelProfile("gemini-image", "gemini-2.5-flash-image")?.sizes).toEqual([]);

    const vertexBanana = getImageModelPreset("vertex-image", "publishers/google/models/gemini-nano-banana-2.1")!;
    expect(vertexBanana).toMatchObject({ adapter: "vertex-image", baseUrl: "https://aiplatform.googleapis.com/v1", modelId: "gemini-nano-banana-2.1" });
    const vertexPreview = getImageModelPreset("vertex-image", "gemini-3.1-flash-image-preview")!;
    expect(vertexPreview).toMatchObject({ adapter: "vertex-image", modelId: "gemini-3.1-flash-image-preview" });
    expect(vertexPreview.profile.sizes).toEqual(["0.5K", "1K", "2K", "4K"]);
    expect(vertexPreview.profile.maxReferences).toBe(14);
    expect(getImageModelPreset("gemini-image", "gemini-3-pro-image-preview-2026-06-01")?.profile.supportsEdit).toBe(true);
    expect(() => normalizeImageGenerationParameters({ count: 2 }, vertexBanana.profile, "vertex-image")).toThrow();

    expect(isOfficialVertexBaseUrl("https://aiplatform.us.rep.googleapis.com")).toBe(true);
    expect(isOfficialVertexBaseUrl("https://aiplatform.eu.rep.googleapis.com/v1")).toBe(true);
    expect(isOfficialVertexBaseUrl("https://aiplatform.googleapis.com.evil.example")).toBe(false);
    expect(resolveVertexImageBaseUrl("https://aiplatform.googleapis.com", { vertexProject: "demo-proj", vertexLocation: "global" }))
      .toBe("https://aiplatform.googleapis.com/v1/projects/demo-proj/locations/global");
    expect(resolveVertexImageBaseUrl("https://aiplatform.googleapis.com/v1beta")).toBe("https://aiplatform.googleapis.com/v1");
    expect(resolveVertexImageBaseUrl("https://aiplatform.googleapis.com/v1beta1")).toBe("https://aiplatform.googleapis.com/v1beta1");
    expect(cleanGoogleImageModelId("publishers/google/models/gemini-nano-banana-2.1")).toBe("gemini-nano-banana-2.1");
  });
  it("keeps newer arbitrary sizing out of legacy GPT Image models", () => {
    const older = getImageModelProfile("openai-image", "gpt-image-1.5")!;
    const newer = getImageModelProfile("openai-image", "gpt-image-2.6-flare")!;
    expect(() => normalizeImageGenerationParameters({ size: "1536x864" }, older, "openai-image")).toThrow();
    expect(normalizeImageGenerationParameters({ size: "1536x864" }, newer, "openai-image").size).toBe("1536x864");
    expect(() => normalizeImageGenerationParameters({ size: "00x00" }, newer, "openai-image")).toThrow();
    expect(getImageModelProfile("openai-image", "gpt-image-future")).toBeUndefined();
  });
  it("enforces GIF, SVG, transparent background, and compression combinations", () => {
    const profile = getImageModelProfile("openai-image", "gpt-image-2.6-flare")!;
    expect(() => normalizeImageGenerationParameters({ format: "gif", outputCompression: 80 }, profile, "openai-image")).toThrow();
    expect(() => normalizeImageGenerationParameters({ format: "svg", count: 2 }, profile, "openai-image")).toThrow();
    expect(() => normalizeImageGenerationParameters({ format: "jpeg", background: "transparent" }, profile, "openai-image")).toThrow();
    expect(normalizeImageGenerationParameters({ format: "gif", frameCount: 9, frameDurationMs: 200 }, profile, "openai-image")).toMatchObject({ frameCount: 9, frameDurationMs: 200 });
  });
  it("keeps custom templates declarative and fences credentials and return paths", () => {
    const adapter: CustomImageAdapter = { auth: { type: "bearer" }, generate: { path: "generate", body: { prompt: "{{prompt}}" } }, response: { imagesPath: "data", base64Path: "encoded" } };
    expect(validateCustomImageAdapter(adapter)).toEqual(adapter);
    for (const path of ["https://evil.example", "//evil.example", "../generate", "%2e%2e/generate", "generate?api_key=secret"]) expect(() => validateCustomImageAdapter({ ...adapter, generate: { ...adapter.generate, path } })).toThrow();
    expect(() => validateCustomImageAdapter({ ...adapter, generate: { ...adapter.generate, body: { prompt: "{{process.env.SECRET}}" } } })).toThrow();
    expect(() => validateCustomImageAdapter({ ...adapter, response: { imagesPath: "__proto__.data", base64Path: "encoded" } })).toThrow();
    expect(validateCustomImageAdapter({ ...adapter, referenceTemplate: { type: "image_url", image_url: { url: "{{reference.dataUrl}}" } } }).referenceTemplate).toBeDefined();
    expect(() => validateCustomImageAdapter({ ...adapter, referenceTemplate: "{{parameters.custom.private}}" })).toThrow();
    expect(() => validateCustomImageAdapter({ ...adapter, referenceTemplate: "{{reference.__proto__}}" })).toThrow();
    expect(() => validateCustomImageAdapter({ ...adapter, referenceTemplate: JSON.parse('{"__proto__":"unsafe"}') })).toThrow();
  });
});
