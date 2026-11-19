/** Persisted appearance preferences shared by the workbench and its Portals. */
import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import {
  APPEARANCE_COLOR_TOKENS, appearanceCustomizationVariables, validateAppearanceCustomization,
  type AppearanceCustomization,
} from "@moco/protocol";
import "./appearance-customization.css";

export type MocoModePreference = "system" | "light" | "dark";

export interface MocoAppearance {
  mode: MocoModePreference;
  chatFontSize: number;
  customization?: AppearanceCustomization;
}

export const CHAT_FONT_SIZE = { min: 12, max: 20, default: 14 } as const;
export const CHAT_FONT_SIZE_OPTIONS = [
  { value: 13, label: "小" },
  { value: 14, label: "中" },
  { value: 17, label: "大" },
  { value: 20, label: "超大" },
] as const;

const STORAGE_KEY = "moco:appearance";
const DEFAULT_APPEARANCE: MocoAppearance = { mode: "system", chatFontSize: CHAT_FONT_SIZE.default };

function parseChatFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) ||
    value < CHAT_FONT_SIZE.min || value > CHAT_FONT_SIZE.max) return CHAT_FONT_SIZE.default;
  // Map preferences from the former continuous slider to the closest preset.
  return CHAT_FONT_SIZE_OPTIONS.reduce<number>(
    (nearest, option) => Math.abs(option.value - value) < Math.abs(nearest - value) ? option.value : nearest,
    CHAT_FONT_SIZE.default,
  );
}

export function parseAppearance(raw: unknown): MocoAppearance {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return { ...DEFAULT_APPEARANCE, mode: raw };
  }
  const value =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        })()
      : raw;
  const item = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const result: MocoAppearance = {
    mode:
      item.mode === "light" || item.mode === "dark" || item.mode === "system"
        ? item.mode
        : "system",
    chatFontSize: parseChatFontSize(item.chatFontSize),
  };
  if (item.customization !== undefined && item.customization !== null) result.customization = validateAppearanceCustomization(item.customization);
  return result;
}

const systemPrefersDark = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

export const resolveMode = (
  mode: MocoModePreference,
  sysDark: boolean,
): "light" | "dark" => (mode === "system" ? (sysDark ? "dark" : "light") : mode);

let cached: MocoAppearance | undefined;
const listeners = new Set<() => void>();
let appearanceError: string | null = null;
let preview: { owner: symbol; customization: AppearanceCustomization; mode?: "light" | "dark" } | null = null;

const notify = () => listeners.forEach((listener) => listener());
const errorSnapshot = () => appearanceError;
const previewSnapshot = () => preview;

function reportStorageError(cause: unknown): void {
  appearanceError = cause instanceof Error ? cause.message : "无法读取外观偏好。";
}

function readAppearance(): MocoAppearance {
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    cached = raw ? parseAppearance(raw) : DEFAULT_APPEARANCE;
  } catch (cause) {
    reportStorageError(cause);
    cached = DEFAULT_APPEARANCE;
  }
  return cached;
}

function writeAppearance(next: MocoAppearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (cause) {
    appearanceError = "无法保存外观偏好，请检查浏览器存储权限。";
    notify();
    throw new Error(appearanceError, { cause });
  }
  cached = next;
  preview = null;
  appearanceError = null;
  notify();
}

export function getAppearanceCustomization(): AppearanceCustomization | null {
  const customization = readAppearance().customization;
  return customization ? validateAppearanceCustomization(customization) : null;
}

export function setAppearanceCustomization(value: AppearanceCustomization | null): void {
  const next = { ...readAppearance() };
  if (value === null) delete next.customization;
  else next.customization = validateAppearanceCustomization(value);
  writeAppearance(next);
}

/** Saving may precede a lost server receipt; the same saved target is safe to acknowledge again. */
export function saveAppearanceCustomizationProposal(value: AppearanceCustomization, expectedCurrent: AppearanceCustomization | null): void {
  const next = validateAppearanceCustomization(value);
  const current = getAppearanceCustomization();
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("外观已在其他操作中修改，请重新生成方案后应用。");
  setAppearanceCustomization(next);
}

export const resetAppearanceCustomization = () => setAppearanceCustomization(null);

/** An older preview cannot undo a newer card's preview or a committed preference. */
export function previewAppearanceCustomization(value: AppearanceCustomization, mode?: "light" | "dark"): () => void {
  const owner = Symbol("appearance-preview");
  preview = { owner, customization: validateAppearanceCustomization(value), mode };
  notify();
  return () => {
    if (preview?.owner !== owner) return;
    preview = null;
    notify();
  };
}

export function applyAppearanceCustomizationToRoot(value: AppearanceCustomization | null, mode: "light" | "dark", root: HTMLElement): void {
  const variables = value ? appearanceCustomizationVariables(value, mode) : {};
  const owned = [...Object.values(APPEARANCE_COLOR_TOKENS), "--moco-ui-font", "--moco-chat-font", "--moco-code-font", "--font-sans", "--font-mono"];
  for (const property of owned) {
    if (variables[property]) root.style.setProperty(property, variables[property]);
    else root.style.removeProperty(property);
  }
  if (value) {
    root.style.setProperty("--font-sans", variables["--moco-ui-font"]!);
    root.style.setProperty("--font-mono", variables["--moco-code-font"]!);
    root.dataset.customAppearance = "true";
  } else delete root.dataset.customAppearance;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    cached = event.newValue && event.key !== null ? parseAppearance(event.newValue) : DEFAULT_APPEARANCE;
    appearanceError = null;
  } catch (cause) {
    reportStorageError(cause);
    cached = DEFAULT_APPEARANCE;
  }
  preview = null;
  notify();
}

const subscribe = (fn: () => void) => {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
};

function subscribeSystemDark(fn: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", fn);
  return () => mql.removeEventListener("change", fn);
}

export function useMocoAppearance() {
  const appearance = useSyncExternalStore(subscribe, readAppearance, () => DEFAULT_APPEARANCE);
  const currentPreview = useSyncExternalStore(subscribe, previewSnapshot, () => null);
  const error = useSyncExternalStore(subscribe, errorSnapshot, () => null);
  const sysDark = useSyncExternalStore(subscribeSystemDark, systemPrefersDark, () => true);

  const setMode = useCallback(
    (mode: MocoModePreference) => writeAppearance({ ...readAppearance(), mode }),
    [],
  );
  const setChatFontSize = useCallback(
    (chatFontSize: number) => writeAppearance({ ...readAppearance(), chatFontSize: parseChatFontSize(chatFontSize) }),
    [],
  );
  const setCustomization = useCallback(setAppearanceCustomization, []);
  const resetCustomization = useCallback(resetAppearanceCustomization, []);

  const resolved = currentPreview?.mode ?? resolveMode(appearance.mode, sysDark);
  const effectiveCustomization = currentPreview?.customization ?? appearance.customization ?? null;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.classList.toggle("dark", resolved === "dark");
    root.classList.toggle("light", resolved === "light");
  }, [resolved]);

  useLayoutEffect(() => {
    applyAppearanceCustomizationToRoot(effectiveCustomization, resolved, document.documentElement);
  }, [effectiveCustomization, resolved]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--moco-chat-font-size", `${appearance.chatFontSize}px`);
  }, [appearance.chatFontSize]);

  return {
    ...appearance,
    sysDark,
    resolved,
    setMode,
    setChatFontSize,
    customization: appearance.customization ?? null,
    setCustomization,
    resetCustomization,
    isPreviewingCustomization: currentPreview !== null,
    appearanceError: error,
  };
}
