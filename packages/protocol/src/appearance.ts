export const APPEARANCE_COLOR_TOKENS = {
  background: "--background", foreground: "--foreground", surface: "--surface",
  surfaceSecondary: "--surface-secondary", surfaceTertiary: "--surface-tertiary",
  overlay: "--overlay", muted: "--muted", default: "--default",
  defaultForeground: "--default-foreground", fieldBackground: "--field-background",
  fieldForeground: "--field-foreground", fieldPlaceholder: "--field-placeholder",
  accent: "--accent", accentForeground: "--accent-foreground", focus: "--focus",
  border: "--border", separator: "--separator", segment: "--segment",
  segmentForeground: "--segment-foreground", success: "--success",
  successForeground: "--success-foreground", warning: "--warning",
  warningForeground: "--warning-foreground", danger: "--danger", dangerForeground: "--danger-foreground",
} as const;

export type AppearanceColor = keyof typeof APPEARANCE_COLOR_TOKENS;
export type AppearancePalette = Record<AppearanceColor, string>;
export type AppearanceFontRole = "ui" | "chat" | "code";
export interface AppearanceCustomization {
  version: 1;
  name: string;
  useDefaultColors: boolean;
  palettes: { light: AppearancePalette; dark: AppearancePalette };
  fonts: Record<AppearanceFontRole, string>;
}

export const DEFAULT_APPEARANCE_CUSTOMIZATION: AppearanceCustomization = {
  version: 1, name: "我的外观", useDefaultColors: true,
  palettes: {
    light: {
      background: "#ededed", foreground: "#222222", surface: "#f8f8f8",
      surfaceSecondary: "#ededed", surfaceTertiary: "#e6e6e6", overlay: "#fafafa",
      muted: "#606060", default: "#e8e8e8", defaultForeground: "#222222",
      fieldBackground: "#f8f8f8", fieldForeground: "#222222", fieldPlaceholder: "#606060",
      accent: "#185abc", accentForeground: "#ffffff", focus: "#606060",
      border: "#d6d6d6", separator: "#dedede", segment: "#fafafa", segmentForeground: "#222222",
      success: "#146c2e", successForeground: "#ffffff", warning: "#735c00",
      warningForeground: "#ffffff", danger: "#a61c22", dangerForeground: "#ffffff",
    },
    dark: {
      background: "#121212", foreground: "#efefef", surface: "#1b1b1b",
      surfaceSecondary: "#232323", surfaceTertiary: "#292929", overlay: "#222222",
      muted: "#a8a8a8", default: "#2e2e2e", defaultForeground: "#efefef",
      fieldBackground: "#1b1b1b", fieldForeground: "#efefef", fieldPlaceholder: "#a8a8a8",
      accent: "#9ec1ff", accentForeground: "#121212", focus: "#a8a8a8",
      border: "#343434", separator: "#2d2d2d", segment: "#3d3d3d", segmentForeground: "#efefef",
      success: "#8cdda0", successForeground: "#121212", warning: "#f4d77a",
      warningForeground: "#121212", danger: "#ffb4ab", dangerForeground: "#121212",
    },
  },
  fonts: { ui: "system-ui", chat: "system-ui", code: "ui-monospace" },
};

const GENERIC_FONTS = new Set(["system-ui", "sans-serif", "serif", "monospace", "ui-sans-serif", "ui-serif", "ui-monospace"]);
const FONT_ROLES: AppearanceFontRole[] = ["ui", "chat", "code"];
const COLORS = Object.keys(APPEARANCE_COLOR_TOKENS) as AppearanceColor[];
const SURFACES: AppearanceColor[] = ["background", "surface", "surfaceSecondary", "surfaceTertiary", "overlay", "default", "fieldBackground", "segment"];

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new Error(`${label}包含无效字段。`);
  return value as Record<string, unknown>;
}

export function validateAppearanceFontFamily(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100 || !/^[\p{L}\p{N} _-]+$/u.test(value.trim())) throw new Error("字体必须是单个字体名称，不支持 CSS、URL 或字体列表。");
  return value.trim();
}

export function appearanceFontStack(family: string, role: AppearanceFontRole): string {
  const clean = validateAppearanceFontFamily(family);
  const name = GENERIC_FONTS.has(clean) ? clean : JSON.stringify(clean);
  return role === "code" ? `${name}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` : `${name}, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif`;
}

export function appearanceContrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error("对比检查需要六位十六进制颜色。");
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
  };
  const firstLuminance = luminance(first), secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + .05) / (Math.min(firstLuminance, secondLuminance) + .05);
}

export function validateAppearancePalette(palette: AppearancePalette, mode: "light" | "dark"): void {
  const check = (foreground: AppearanceColor, background: AppearanceColor, minimum: number) => {
    if (appearanceContrast(palette[foreground], palette[background]) < minimum) throw new Error(`${mode === "light" ? "浅色" : "深色"}方案的 ${foreground} 与 ${background} 对比不足（至少 ${minimum}:1）。`);
  };
  for (const surface of SURFACES) {
    check("foreground", surface, 4.5);
    check("muted", surface, 4.5);
    check("focus", surface, 3);
  }
  for (const surface of ["background", "surface", "surfaceSecondary", "overlay"] as const) check("accent", surface, 4.5);
  check("fieldForeground", "fieldBackground", 4.5);
  check("fieldPlaceholder", "fieldBackground", 4.5);
  check("fieldForeground", "default", 4.5);
  check("fieldPlaceholder", "default", 4.5);
  check("defaultForeground", "default", 4.5);
  check("segmentForeground", "segment", 4.5);
  for (const [foreground, background] of [["accentForeground", "accent"], ["successForeground", "success"], ["warningForeground", "warning"], ["dangerForeground", "danger"]] as const) check(foreground, background, 4.5);
}

/** Only named semantic colors and single font names can cross the assistant boundary. */
export function validateAppearanceCustomization(input: unknown, base: AppearanceCustomization = DEFAULT_APPEARANCE_CUSTOMIZATION): AppearanceCustomization {
  const value = object(input, ["version", "name", "useDefaultColors", "palettes", "fonts"], "外观方案");
  if (value.version !== undefined && value.version !== 1) throw new Error("外观方案版本无效。");
  const name = value.name === undefined ? base.name : value.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("方案名称无效。");
  if (value.useDefaultColors !== undefined && typeof value.useDefaultColors !== "boolean") throw new Error("默认配色标识无效。");
  const palettes = value.palettes === undefined ? {} : object(value.palettes, ["light", "dark"], "配色");
  const useDefaultColors = value.useDefaultColors as boolean | undefined ?? (value.palettes === undefined ? base.useDefaultColors : false);
  const result = { version: 1 as const, name: name.trim(), useDefaultColors, palettes: {} as AppearanceCustomization["palettes"], fonts: { ...base.fonts } };
  for (const mode of ["light", "dark"] as const) {
    const changes = palettes[mode] === undefined ? {} : object(palettes[mode], COLORS, "配色");
    const palette = { ...base.palettes[mode] };
    for (const key of COLORS) {
      if (changes[key] === undefined) continue;
      if (typeof changes[key] !== "string" || !/^#[\da-f]{6}$/i.test(changes[key])) throw new Error(`配色 ${key} 必须是六位十六进制颜色。`);
      palette[key] = changes[key].toLowerCase();
    }
    validateAppearancePalette(palette, mode);
    result.palettes[mode] = palette;
  }
  const fonts = value.fonts === undefined ? {} : object(value.fonts, FONT_ROLES, "字体");
  for (const role of FONT_ROLES) if (fonts[role] !== undefined) result.fonts[role] = validateAppearanceFontFamily(fonts[role]);
  return result;
}

export function appearanceCustomizationVariables(customization: AppearanceCustomization, mode: "light" | "dark"): Record<string, string> {
  const variables: Record<string, string> = {};
  if (!customization.useDefaultColors) for (const key of COLORS) variables[APPEARANCE_COLOR_TOKENS[key]] = customization.palettes[mode][key];
  for (const role of FONT_ROLES) variables[`--moco-${role}-font`] = appearanceFontStack(customization.fonts[role], role);
  return variables;
}
