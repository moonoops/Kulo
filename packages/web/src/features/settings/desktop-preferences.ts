import { useCallback, useEffect, useRef, useState } from "react";
import { translate as t } from "../../kulo-i18n";

export interface DesktopNotificationPreferences {
  enabled: boolean;
  sound: boolean;
  badge: boolean;
}

export interface DesktopPreferences {
  backgroundRunning: boolean;
  notifications: DesktopNotificationPreferences;
}

export interface DesktopPreferencesPatch {
  backgroundRunning?: boolean;
  notifications?: Partial<DesktopNotificationPreferences>;
}

export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES: Readonly<DesktopNotificationPreferences> = Object.freeze({
  enabled: true,
  sound: false,
  badge: true,
});

export interface DesktopPreferencesBridge {
  get(): Promise<DesktopPreferences | { backgroundRunning: boolean; notifications?: Partial<DesktopNotificationPreferences> }>;
  set(patch: DesktopPreferencesPatch): Promise<DesktopPreferences | { backgroundRunning: boolean; notifications?: Partial<DesktopNotificationPreferences> }>;
  onChange?(listener: (preferences: DesktopPreferences | { backgroundRunning: boolean; notifications?: Partial<DesktopNotificationPreferences> }) => void): () => void;
}

export function desktopPreferencesBridge(): DesktopPreferencesBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kuloDesktop?.preferences;
}

export function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("桌面客户端返回了无效的偏好配置。", "Desktop app returned invalid preferences."));
  }
  const record = value as Record<string, unknown>;
  if (typeof record.backgroundRunning !== "boolean") {
    throw new Error(t("桌面客户端返回了无效的偏好配置。", "Desktop app returned invalid preferences."));
  }
  let notifications: DesktopNotificationPreferences = { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES };
  if (record.notifications !== undefined) {
    if (!record.notifications || typeof record.notifications !== "object" || Array.isArray(record.notifications)) {
      throw new Error(t("桌面客户端返回了无效的偏好配置。", "Desktop app returned invalid preferences."));
    }
    const rawNotif = record.notifications as Record<string, unknown>;
    for (const key of ["enabled", "sound", "badge"] as const) {
      if (rawNotif[key] === undefined) continue;
      if (typeof rawNotif[key] !== "boolean") {
        throw new Error(t("桌面客户端返回了无效的偏好配置。", "Desktop app returned invalid preferences."));
      }
      notifications = { ...notifications, [key]: rawNotif[key] };
    }
  }
  return { backgroundRunning: record.backgroundRunning, notifications };
}

const localSubscribers = new Map<DesktopPreferencesBridge, Set<(prefs: DesktopPreferences) => void>>();

function broadcastLocalPreferences(bridge: DesktopPreferencesBridge, next: DesktopPreferences): void {
  const listeners = localSubscribers.get(bridge);
  if (!listeners) return;
  for (const listener of listeners) listener(next);
}

function subscribeLocalPreferences(bridge: DesktopPreferencesBridge, listener: (prefs: DesktopPreferences) => void): () => void {
  let listeners = localSubscribers.get(bridge);
  if (!listeners) {
    listeners = new Set();
    localSubscribers.set(bridge, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = localSubscribers.get(bridge);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) localSubscribers.delete(bridge);
  };
}

export interface DesktopPreferencesState {
  supported: boolean;
  loading: boolean;
  saving: boolean;
  preferences: DesktopPreferences | null;
  error: string | null;
  setBackgroundRunning(enabled: boolean): Promise<void>;
  setNotifications(patch: Partial<DesktopNotificationPreferences>): Promise<void>;
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
  const failedPatch = useRef<DesktopPreferencesPatch | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!bridge) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = normalizeDesktopPreferences(await bridge.get());
      if (!mounted.current || requestVersion.current !== version) return;
      failedPatch.current = null;
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
    const applyUpdate = (next: unknown) => {
      if (!mounted.current) return;
      try {
        const normalized = normalizeDesktopPreferences(next);
        failedPatch.current = null;
        setPreferences(normalized);
        setError(null);
      } catch {
        // Ignore malformed external updates without breaking the current view.
      }
    };
    const unsubscribeExternal = bridge.onChange?.(applyUpdate);
    const unsubscribeLocal = subscribeLocalPreferences(bridge, applyUpdate);
    return () => {
      mounted.current = false;
      unsubscribeExternal?.();
      unsubscribeLocal();
    };
  }, [bridge, load]);

  const applyPatch = useCallback(async (patch: DesktopPreferencesPatch, fallbackError: string) => {
    if (!bridge || savingRef.current) return;
    const version = ++requestVersion.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = normalizeDesktopPreferences(await bridge.set(patch));
      if (!mounted.current || requestVersion.current !== version) return;
      failedPatch.current = null;
      setPreferences(updated);
      broadcastLocalPreferences(bridge, updated);
    } catch (cause) {
      if (!mounted.current || requestVersion.current !== version) return;
      failedPatch.current = patch;
      setError(cause instanceof Error && cause.message ? cause.message : fallbackError);
    } finally {
      if (requestVersion.current === version) {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      }
    }
  }, [bridge]);

  const setBackgroundRunning = useCallback(async (enabled: boolean) => {
    await applyPatch(
      { backgroundRunning: enabled },
      t("无法保存后台运行设置，请重试。", "Cannot save background running setting. Try again."),
    );
  }, [applyPatch]);

  const setNotifications = useCallback(async (patch: Partial<DesktopNotificationPreferences>) => {
    await applyPatch(
      { notifications: patch },
      t("无法保存通知设置，请重试。", "Cannot save notification settings. Try again."),
    );
  }, [applyPatch]);

  const retry = useCallback(async () => {
    if (preferences === null) {
      await load();
      return;
    }
    if (failedPatch.current !== null) {
      await applyPatch(
        failedPatch.current,
        t("无法保存桌面客户端设置，请重试。", "Cannot save desktop app settings. Try again."),
      );
      return;
    }
    await load();
  }, [preferences, load, applyPatch]);

  return {
    supported,
    loading,
    saving,
    preferences,
    error,
    setBackgroundRunning,
    setNotifications,
    retry,
  };
}
