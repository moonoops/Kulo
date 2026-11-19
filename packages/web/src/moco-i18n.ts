import { useCallback, useSyncExternalStore } from "react";

export type MocoLanguage = "zh-CN" | "en";
export type Translate = (chinese: string, english: string) => string;

export const LANGUAGE_STORAGE_KEY = "moco:language";
export const LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
] as const;

export function parseLanguage(value: unknown): MocoLanguage {
  return value === "en" ? "en" : "zh-CN";
}

let cachedLanguage: MocoLanguage | undefined;
const listeners = new Set<() => void>();

export function getLanguage(): MocoLanguage {
  if (cachedLanguage) return cachedLanguage;
  let stored: string | null = null;
  try {
    stored = typeof localStorage === "undefined" ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Keep the interface usable when the browser blocks preference storage.
  }
  cachedLanguage = parseLanguage(stored);
  return cachedLanguage;
}

function notifyLanguageChanged() {
  listeners.forEach((listener) => listener());
}

export function setLanguage(value: MocoLanguage): void {
  cachedLanguage = parseLanguage(value);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, cachedLanguage);
  } catch {
    // A blocked storage write should not prevent switching the current window.
  }
  notifyLanguageChanged();
}

function onStorage(event: StorageEvent) {
  if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
  cachedLanguage = parseLanguage(event.key === null ? null : event.newValue);
  notifyLanguageChanged();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** For display helpers evaluated at render time; keep stored and user-authored data unchanged. */
export const translate: Translate = (chinese, english) => getLanguage() === "en" ? english : chinese;

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  const t = useCallback<Translate>((chinese, english) => language === "en" ? english : chinese, [language]);
  return { language, locale: language, setLanguage, t };
}
