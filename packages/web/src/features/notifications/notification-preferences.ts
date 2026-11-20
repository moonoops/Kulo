import { useCallback, useEffect, useState } from "react";
import { translate as t } from "../../kulo-i18n";
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  useDesktopPreferences,
  type DesktopNotificationPreferences,
  type DesktopPreferencesBridge,
  type DesktopPreferencesState,
} from "../settings/desktop-preferences";

export type NotificationPreferences = DesktopNotificationPreferences;
export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES;
export const NOTIFICATION_PREFERENCES_STORAGE_KEY = "kulo:notification-preferences";

export type BrowserNotificationPermission = "granted" | "denied" | "default" | "unsupported";

const browserListeners = new Set<() => void>();

function notifyBrowserListeners(): void {
  for (const listener of browserListeners) listener();
}

export function browserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === "undefined") return "unsupported";
  const perm = Notification.permission;
  if (perm === "granted" || perm === "denied" || perm === "default") return perm;
  return "unsupported";
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted" || result === "denied" || result === "default" ? result : "unsupported";
  } catch {
    return browserNotificationPermission();
  }
}

export function parseNotificationPreferences(raw: string | null): NotificationPreferences {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
    const record = parsed as Record<string, unknown>;
    return {
      enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
      sound: typeof record.sound === "boolean" ? record.sound : DEFAULT_NOTIFICATION_PREFERENCES.sound,
      badge: typeof record.badge === "boolean" ? record.badge : DEFAULT_NOTIFICATION_PREFERENCES.badge,
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function readBrowserNotificationPreferences(): { preferences: NotificationPreferences; error: string | null } {
  if (typeof localStorage === "undefined") {
    return { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES }, error: null };
  }
  try {
    return {
      preferences: parseNotificationPreferences(localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY)),
      error: null,
    };
  } catch {
    return {
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
      error: t("无法读取通知设置，请检查浏览器存储权限。", "Cannot read notification settings. Check browser storage permissions."),
    };
  }
}

export function saveBrowserNotificationPreferences(patch: Partial<NotificationPreferences>): { preferences: NotificationPreferences; error: string | null } {
  const current = readBrowserNotificationPreferences().preferences;
  const next: NotificationPreferences = {
    enabled: patch.enabled ?? current.enabled,
    sound: patch.sound ?? current.sound,
    badge: patch.badge ?? current.badge,
  };
  if (typeof localStorage === "undefined") {
    notifyBrowserListeners();
    return { preferences: next, error: null };
  }
  try {
    localStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
    notifyBrowserListeners();
    return { preferences: next, error: null };
  } catch {
    return {
      preferences: current,
      error: t("无法保存通知设置，请检查浏览器存储权限。", "Cannot save notification settings. Check browser storage permissions."),
    };
  }
}

export interface NotificationPreferencesState {
  isDesktop: boolean;
  loading: boolean;
  saving: boolean;
  preferences: NotificationPreferences;
  ready: boolean;
  error: string | null;
  browserPermission: BrowserNotificationPermission;
  setEnabled(enabled: boolean): Promise<void>;
  setSound(sound: boolean): Promise<void>;
  setBadge(badge: boolean): Promise<void>;
  retry(): Promise<void>;
}

export function useNotificationPreferences(
  options?: DesktopPreferencesBridge | { bridge?: DesktopPreferencesBridge; desktop?: DesktopPreferencesState },
): NotificationPreferencesState {
  const bridgeOverride = options && "get" in options ? options : options?.bridge;
  const externalDesktop = options && !("get" in options) ? options.desktop : undefined;
  const ownedDesktop = useDesktopPreferences(externalDesktop ? undefined : bridgeOverride);
  const desktop = externalDesktop ?? ownedDesktop;
  const [browserState, setBrowserState] = useState<{ preferences: NotificationPreferences; error: string | null }>(() =>
    desktop.supported ? { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES }, error: null } : readBrowserNotificationPreferences(),
  );
  const [browserPermission, setBrowserPermission] = useState<BrowserNotificationPermission>(() =>
    desktop.supported ? "granted" : browserNotificationPermission(),
  );

  useEffect(() => {
    if (desktop.supported) return;
    const sync = () => {
      setBrowserState(readBrowserNotificationPreferences());
      setBrowserPermission(browserNotificationPermission());
    };
    browserListeners.add(sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === NOTIFICATION_PREFERENCES_STORAGE_KEY) sync();
    };
    const onFocus = () => setBrowserPermission(browserNotificationPermission());
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      browserListeners.delete(sync);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [desktop.supported]);

  const updateBrowser = useCallback((patch: Partial<NotificationPreferences>) => {
    setBrowserState(saveBrowserNotificationPreferences(patch));
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (desktop.supported) {
      await desktop.setNotifications({ enabled });
      return;
    }
    updateBrowser({ enabled });
    if (enabled && browserNotificationPermission() === "default") {
      const nextPerm = await requestBrowserNotificationPermission();
      setBrowserPermission(nextPerm);
    } else {
      setBrowserPermission(browserNotificationPermission());
    }
  }, [desktop, updateBrowser]);

  const setSound = useCallback(async (sound: boolean) => {
    if (desktop.supported) {
      await desktop.setNotifications({ sound });
      return;
    }
    updateBrowser({ sound });
  }, [desktop, updateBrowser]);

  const setBadge = useCallback(async (badge: boolean) => {
    if (desktop.supported) {
      await desktop.setNotifications({ badge });
      return;
    }
    updateBrowser({ badge });
  }, [desktop, updateBrowser]);

  const retry = useCallback(async () => {
    if (desktop.supported) {
      await desktop.retry();
      return;
    }
    setBrowserState(readBrowserNotificationPreferences());
  }, [desktop]);

  return {
    isDesktop: desktop.supported,
    loading: desktop.supported ? desktop.loading : false,
    saving: desktop.supported ? desktop.saving : false,
    preferences: desktop.supported
      ? (desktop.preferences?.notifications ?? { ...DEFAULT_NOTIFICATION_PREFERENCES })
      : browserState.preferences,
    ready: desktop.supported ? desktop.preferences !== null : true,
    error: desktop.supported ? desktop.error : browserState.error,
    browserPermission: desktop.supported ? "granted" : browserPermission,
    setEnabled,
    setSound,
    setBadge,
    retry,
  };
}
