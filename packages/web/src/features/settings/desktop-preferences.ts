import { useCallback, useEffect, useRef, useState } from "react";
import { translate as t } from "../../kulo-i18n";

export interface DesktopPreferences {
  backgroundRunning: boolean;
}

export interface DesktopPreferencesBridge {
  get(): Promise<DesktopPreferences>;
  set(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  onChange?(listener: (preferences: DesktopPreferences) => void): () => void;
}

export function desktopPreferencesBridge(): DesktopPreferencesBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kuloDesktop?.preferences;
}

function normalizePreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { backgroundRunning?: unknown }).backgroundRunning !== "boolean") {
    throw new Error(t("桌面客户端返回了无效的偏好配置。", "Desktop app returned invalid preferences."));
  }
  return { backgroundRunning: (value as DesktopPreferences).backgroundRunning };
}

export interface DesktopPreferencesState {
  supported: boolean;
  loading: boolean;
  saving: boolean;
  preferences: DesktopPreferences | null;
  error: string | null;
  setBackgroundRunning(enabled: boolean): Promise<void>;
  retry(): Promise<void>;
}

export function useDesktopPreferences(bridgeOverride?: DesktopPreferencesBridge): DesktopPreferencesState {
  const bridge = bridgeOverride ?? desktopPreferencesBridge();
  const supported = Boolean(bridge);
  const [loading, setLoading] = useState(supported);
  const [saving, setSaving] = useState(false);
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const failedTarget = useRef<boolean | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!bridge) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = normalizePreferences(await bridge.get());
      if (!mounted.current || requestVersion.current !== version) return;
      failedTarget.current = null;
      setPreferences(loaded);
    } catch (cause) {
      if (!mounted.current || requestVersion.current !== version) return;
      setError(cause instanceof Error && cause.message
        ? cause.message
        : t("无法读取桌面客户端设置，请重试。", "Cannot read desktop app settings. Try again."));
    } finally {
      if (mounted.current && requestVersion.current === version) {
        setLoading(false);
      }
    }
  }, [bridge]);

  useEffect(() => {
    mounted.current = true;
    if (!bridge) {
      setLoading(false);
      setPreferences(null);
      setError(null);
      return () => { mounted.current = false; };
    }
    void load();
    const unsubscribe = bridge.onChange?.((next) => {
      if (!mounted.current) return;
      try {
        const normalized = normalizePreferences(next);
        failedTarget.current = null;
        setPreferences(normalized);
        setError(null);
      } catch {
        // Ignore malformed external updates without breaking the current view.
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [bridge, load]);

  const setBackgroundRunning = useCallback(async (enabled: boolean) => {
    if (!bridge || savingRef.current) return;
    const version = ++requestVersion.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = normalizePreferences(await bridge.set({ backgroundRunning: enabled }));
      if (!mounted.current || requestVersion.current !== version) return;
      failedTarget.current = null;
      setPreferences(updated);
    } catch (cause) {
      if (!mounted.current || requestVersion.current !== version) return;
      failedTarget.current = enabled;
      setError(cause instanceof Error && cause.message
        ? cause.message
        : t("无法保存后台运行设置，请重试。", "Cannot save background running setting. Try again."));
    } finally {
      if (requestVersion.current === version) {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      }
    }
  }, [bridge]);

  const retry = useCallback(async () => {
    if (preferences === null) {
      await load();
      return;
    }
    if (failedTarget.current !== null) {
      await setBackgroundRunning(failedTarget.current);
      return;
    }
    await load();
  }, [preferences, load, setBackgroundRunning]);

  return {
    supported,
    loading,
    saving,
    preferences,
    error,
    setBackgroundRunning,
    retry,
  };
}
