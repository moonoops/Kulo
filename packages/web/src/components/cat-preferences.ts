import { useSyncExternalStore } from "react";
import { isCatAppearance, type CatAppearance } from "./cat-catalog";

export const CAT_PREFERENCES_STORAGE_KEY = "moco:cat-companion";

export interface CatPreferences {
  appearance: CatAppearance;
  animated: boolean;
}

export interface CatPreferencesSnapshot extends CatPreferences {
  error: "read" | "save" | null;
}

const DEFAULT_PREFERENCES: CatPreferences = { appearance: "auto", animated: true };
const SERVER_SNAPSHOT: CatPreferencesSnapshot = { ...DEFAULT_PREFERENCES, error: null };
const listeners = new Set<() => void>();
let cached: CatPreferencesSnapshot | undefined;

export function parseCatPreferences(raw: unknown): CatPreferences {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) as unknown; }
    catch { return { ...DEFAULT_PREFERENCES }; }
  }
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    appearance: isCatAppearance(item.appearance) ? item.appearance : "auto",
    animated: typeof item.animated === "boolean" ? item.animated : true,
  };
}

export function getCatPreferences(): CatPreferencesSnapshot {
  if (cached) return cached;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CAT_PREFERENCES_STORAGE_KEY);
    cached = { ...parseCatPreferences(raw), error: null };
  } catch {
    cached = { ...DEFAULT_PREFERENCES, error: "read" };
  }
  return cached;
}

const notify = () => listeners.forEach((listener) => listener());

export function saveCatPreferences(patch: Partial<CatPreferences>): boolean {
  const current = getCatPreferences();
  const next: CatPreferences = { appearance: patch.appearance ?? current.appearance, animated: patch.animated ?? current.animated };
  if (!isCatAppearance(next.appearance) || typeof next.animated !== "boolean") throw new TypeError("Invalid cat preference");
  try {
    localStorage.setItem(CAT_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    cached = { ...current, error: "save" };
    notify();
    return false;
  }
  cached = { ...next, error: null };
  notify();
  return true;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== CAT_PREFERENCES_STORAGE_KEY && event.key !== null) return;
  cached = { ...parseCatPreferences(event.key === null ? null : event.newValue), error: null };
  notify();
}

export function subscribeCatPreferences(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useCatPreferences(): CatPreferencesSnapshot {
  return useSyncExternalStore(subscribeCatPreferences, getCatPreferences, () => SERVER_SNAPSHOT);
}
