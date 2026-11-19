import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_COLOR_TOKENS, DEFAULT_APPEARANCE_CUSTOMIZATION, appearanceContrast,
  appearanceCustomizationVariables, appearanceFontStack, validateAppearanceCustomization,
} from "../packages/protocol/src/appearance";

afterEach(() => vi.unstubAllGlobals());

describe("structured personal appearance", () => {
  it("completes a font-only proposal without changing the current palette", () => {
    const first = validateAppearanceCustomization({ name: "阅读", fonts: { chat: "Noto Sans CJK SC" } });
    const next = validateAppearanceCustomization({ fonts: { code: "JetBrains Mono" } }, first);
    expect(next.name).toBe("阅读");
    expect(next.fonts).toEqual({ ui: "system-ui", chat: "Noto Sans CJK SC", code: "JetBrains Mono" });
    expect(next.palettes).toEqual(DEFAULT_APPEARANCE_CUSTOMIZATION.palettes);
    expect(first.fonts.code).toBe("ui-monospace");
    expect(next.useDefaultColors).toBe(true);
    expect(appearanceCustomizationVariables(next, "light")).not.toHaveProperty("--background");
  });

  it("checks both saved color modes and every editable text/control pairing", () => {
    const valid = validateAppearanceCustomization({});
    expect(appearanceContrast("#000000", "#ffffff")).toBe(21);
    for (const mode of ["light", "dark"] as const) {
      for (const color of ["foreground", "muted", "fieldForeground", "fieldPlaceholder", "defaultForeground", "segmentForeground", "accentForeground", "successForeground", "warningForeground", "dangerForeground", "focus"] as const) {
        const backgrounds = { fieldForeground: "fieldBackground", fieldPlaceholder: "fieldBackground", defaultForeground: "default", segmentForeground: "segment", accentForeground: "accent", successForeground: "success", warningForeground: "warning", dangerForeground: "danger" } as const;
        const background = color in backgrounds ? backgrounds[color as keyof typeof backgrounds] : "surface";
        expect(() => validateAppearanceCustomization({ palettes: { [mode]: { [color]: valid.palettes[mode][background] } } })).toThrow(/对比不足/);
      }
    }
  });

  it.each([
    { palettes: { light: { background: "url(https://example.com)" } } },
    { palettes: { light: { background: "#fff" } } },
    { palettes: { light: { background: "#ffffff;display:none" } } },
    { palettes: { light: { fontSize: "80px" } } },
    { palettes: { custom: {} } },
    { fonts: { ui: 'Arial";color:red' } },
    { fonts: { ui: "url(https://example.com/font)" } },
    { fonts: { ui: "Arial, sans-serif" } },
    { fonts: { ui: "var(--x)" } },
    { fonts: { ui: "" } },
    { fonts: { file: "/tmp/font.ttf" } },
    { css: "body{display:none}" },
    { version: 2 },
  ])("rejects unstructured appearance input: %j", (input) => {
    expect(() => validateAppearanceCustomization(input)).toThrow();
  });

  it("serializes single named fonts with trusted fallbacks and only approved tokens", () => {
    const custom = validateAppearanceCustomization({ fonts: { ui: "苹方 SC" }, useDefaultColors: false });
    const variables = appearanceCustomizationVariables(custom, "dark");
    expect(variables["--moco-ui-font"]).toContain('"苹方 SC", system-ui');
    expect(appearanceFontStack("monospace", "code")).toMatch(/^monospace, ui-monospace/);
    expect(Object.keys(variables).sort()).toEqual([...Object.values(APPEARANCE_COLOR_TOKENS), "--moco-ui-font", "--moco-chat-font", "--moco-code-font"].sort());
    expect(variables["--surface"]).toBe(custom.palettes.dark.surface);
  });
});

describe("saved appearance and owned preview", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    vi.resetModules(); storage.clear();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  });

  it("persists customization beside existing mode/size and restores it on reload", async () => {
    storage.set("moco:appearance", JSON.stringify({ mode: "system", chatFontSize: 17 }));
    const first = await import("../packages/web/src/moco-appearance");
    const custom = validateAppearanceCustomization({ name: "自己的外观", fonts: { ui: "Arial" } });
    first.setAppearanceCustomization(custom);
    expect(JSON.parse(storage.get("moco:appearance")!)).toEqual({ mode: "system", chatFontSize: 17, customization: custom });
    vi.resetModules();
    const reloaded = await import("../packages/web/src/moco-appearance");
    expect(reloaded.getAppearanceCustomization()).toEqual(custom);
    reloaded.resetAppearanceCustomization();
    expect(JSON.parse(storage.get("moco:appearance")!)).toEqual({ mode: "system", chatFontSize: 17 });
  });

  it("does not persist a preview and does not discard the committed value during cleanup", async () => {
    const appearance = await import("../packages/web/src/moco-appearance");
    const first = validateAppearanceCustomization({ name: "原方案" });
    const second = validateAppearanceCustomization({ name: "候选方案", fonts: { code: "Menlo" } });
    appearance.setAppearanceCustomization(first);
    const before = storage.get("moco:appearance");
    const closeOld = appearance.previewAppearanceCustomization(second, "dark");
    expect(storage.get("moco:appearance")).toBe(before);
    expect(appearance.getAppearanceCustomization()).toEqual(first);
    appearance.setAppearanceCustomization(second);
    closeOld();
    expect(appearance.getAppearanceCustomization()).toEqual(second);
  });

  it("reports a blocked save without claiming success or replacing the saved preference", async () => {
    const appearance = await import("../packages/web/src/moco-appearance");
    const original = validateAppearanceCustomization({ name: "原方案" });
    appearance.setAppearanceCustomization(original);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw new Error("quota"); } });
    expect(() => appearance.setAppearanceCustomization(validateAppearanceCustomization({ name: "未保存" }))).toThrow("无法保存");
    expect(appearance.getAppearanceCustomization()).toEqual(original);
  });

  it("can acknowledge an already-saved proposal after reload while protecting newer manual changes", async () => {
    const original = validateAppearanceCustomization({ name: "原方案" });
    const proposal = validateAppearanceCustomization({ name: "已保存但回执丢失", fonts: { chat: "Georgia" } });
    const first = await import("../packages/web/src/moco-appearance");
    first.setAppearanceCustomization(original);
    first.saveAppearanceCustomizationProposal(proposal, original);
    vi.resetModules();
    const reloaded = await import("../packages/web/src/moco-appearance");
    const saved = storage.get("moco:appearance");
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw new Error("write must not repeat"); } });
    expect(() => reloaded.saveAppearanceCustomizationProposal(proposal, original)).not.toThrow();
    expect(storage.get("moco:appearance")).toBe(saved);

    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const newer = validateAppearanceCustomization({ name: "后来的手动修改", fonts: { ui: "Arial" } });
    reloaded.setAppearanceCustomization(newer);
    expect(() => reloaded.saveAppearanceCustomizationProposal(proposal, original)).toThrow("外观已在其他操作中修改");
    expect(reloaded.getAppearanceCustomization()).toEqual(newer);
  });

  it("applies the selected mode to the shared root and removes only owned tokens on reset", async () => {
    const appearance = await import("../packages/web/src/moco-appearance");
    const properties = new Map<string, string>([["--moco-chat-font-size", "17px"]]);
    const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) } } as unknown as HTMLElement;
    const custom = validateAppearanceCustomization({ fonts: { chat: "Georgia" }, useDefaultColors: false });
    appearance.applyAppearanceCustomizationToRoot(custom, "dark", root);
    expect(root.dataset.customAppearance).toBe("true");
    expect(properties.get("--surface")).toBe(custom.palettes.dark.surface);
    expect(properties.get("--font-sans")).toContain("system-ui");
    appearance.applyAppearanceCustomizationToRoot(custom, "light", root);
    expect(properties.get("--surface")).toBe(custom.palettes.light.surface);
    appearance.applyAppearanceCustomizationToRoot(null, "light", root);
    expect(root.dataset.customAppearance).toBeUndefined();
    expect([...properties]).toEqual([["--moco-chat-font-size", "17px"]]);
  });
});
