import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceModule } from "./features/settings/appearance-module";
import { SETTINGS_MODULES, settingsModuleTitle } from "./features/settings/settings-helpers";
import { getLanguage, LANGUAGE_STORAGE_KEY, parseLanguage, setLanguage, translate } from "./kulo-i18n";

afterEach(() => {
  setLanguage("zh-CN");
  vi.unstubAllGlobals();
});

describe("interface language preferences", () => {
  it.each([undefined, null, "zh-CN", "fr", {}, 1])("defaults unsupported preferences to Chinese: %s", (value) => {
    expect(parseLanguage(value)).toBe("zh-CN");
  });

  it("switches language immediately and persists the choice without modifying appearance", () => {
    const storage = new Map([["kulo:appearance", '{"mode":"light","chatFontSize":17}']]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(storage.get(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(storage.get("kulo:appearance")).toBe('{"mode":"light","chatFontSize":17}');
    expect(translate("保存", "Save")).toBe("Save");
    const english = renderToStaticMarkup(<AppearanceModule />);
    for (const label of ["Theme", "Language", "Chat font size", "Medium · 14 px"]) expect(english).toContain(label);
    setLanguage("zh-CN");
    expect(translate("保存", "Save")).toBe("保存");
    expect(renderToStaticMarkup(<AppearanceModule />)).toContain("对话字号");
  });

  it("keeps language switching available when browser storage is blocked", () => {
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("Storage blocked"); } });
    expect(() => setLanguage("en")).not.toThrow();
    expect(getLanguage()).toBe("en");
    expect(translate("外观", "Appearance")).toBe("Appearance");
  });
});

describe("settings navigation", () => {
  it("follows the requested order and names in both languages", () => {
    expect(SETTINGS_MODULES.map((module) => module.title)).toEqual(["通用", "模型", "智能体", "工具技能", "记忆", "授权凭据", "系统权限", "设备互联", "定时任务", "已归档会话"]);
    expect(SETTINGS_MODULES.map((module) => settingsModuleTitle(module.id, "en"))).toEqual(["General", "Models", "Agents", "Tools & skills", "Memory", "Credentials", "System permissions", "Devices", "Scheduled tasks", "Archived conversations"]);
    expect(SETTINGS_MODULES.map((module) => settingsModuleTitle(module.id, "zh-CN"))).toEqual(SETTINGS_MODULES.map((module) => module.title));
  });
});
