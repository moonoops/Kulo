import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { validateAppearanceCustomization } from "@kulo/protocol";
import { AppearanceCustomizationCard, detectAppearanceFont } from "./appearance-customization-card";

describe("appearance review card", () => {
  it("previews the complete fixed proposal without treating it as an applied preference", () => {
    const html = renderToStaticMarkup(<AppearanceCustomizationCard proposal={validateAppearanceCustomization({ name: "阅读外观", fonts: { chat: "Georgia" } })} expectedCurrent={null} onApply={vi.fn()} onCancel={vi.fn()} />);
    for (const label of ["阅读外观", "浅色", "深色", "中文阅读", "English text", "代码字体", "全局预览", "应用", "Georgia", "尚未确认可用性"]) expect(html).toContain(label);
    expect(html).not.toContain("已应用");
    expect(html).not.toContain("<input");
  });

  it("keeps historical proposals readable without replaying apply actions", () => {
    const html = renderToStaticMarkup(<AppearanceCustomizationCard proposal={validateAppearanceCustomization({})} historical onApply={vi.fn()} />);
    expect(html).toContain("历史方案");
    expect(html).not.toContain("全局预览");
    expect(html).not.toContain(">应用<");
  });

  it("does not mistake FontFaceSet fallback success for an installed family", () => {
    const context = { font: "", measureText: () => ({ width: 100 }) };
    const doc = { fonts: { check: () => true }, createElement: () => ({ getContext: () => context }) } as unknown as Document;
    expect(detectAppearanceFont("Missing Font", doc)).toBe("fallback");
    expect(detectAppearanceFont("system-ui", doc)).toBe("built-in");
  });

  it("detects usable font metrics and reports missing browser support honestly", () => {
    const context = { font: "", measureText: () => ({ width: context.font.includes("Georgia") ? 120 : 100 }) };
    const doc = { fonts: { check: () => true }, createElement: () => ({ getContext: () => context }) } as unknown as Document;
    expect(detectAppearanceFont("Georgia", doc)).toBe("available");
    expect(detectAppearanceFont("Georgia", {} as Document)).toBe("unknown");
  });
});
