import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../kulo-i18n";
import { AppearanceModule } from "./appearance-module";
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  desktopPreferencesBridge,
  useDesktopPreferences,
  type DesktopPreferences,
  type DesktopPreferencesBridge,
} from "./desktop-preferences";

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  harnessActive: false,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!hooks.harnessActive) return actual.useState(initial as never);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.cells[index], (value: unknown) => {
        hooks.cells[index] = typeof value === "function" ? (value as (prev: unknown) => unknown)(hooks.cells[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.harnessActive) return actual.useRef(initial as never);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useCallback: (callback: unknown, deps: unknown[]) => {
      if (!hooks.harnessActive) return actual.useCallback(callback as never, deps as never);
      return callback;
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hooks.harnessActive) return actual.useEffect(effect, deps as never);
      hooks.effects.push(effect);
    },
  };
});

function resetHarness() {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  hooks.cells.length = 0;
  hooks.cursor = 0;
  hooks.effects.length = 0;
  hooks.harnessActive = false;
}

function renderPreferencesHook(bridge?: DesktopPreferencesBridge) {
  hooks.harnessActive = true;
  hooks.cursor = 0;
  hooks.effects.length = 0;
  const result = useDesktopPreferences(bridge);
  return result;
}

function flushEffects() {
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") hooks.cleanups.push(cleanup);
  }
}

afterEach(() => {
  resetHarness();
  setLanguage("zh-CN");
  vi.unstubAllGlobals();
});

describe("desktop background running and notification settings UI", () => {
  it("hides desktop-only background settings in regular web browsers while showing notifications", () => {
    expect(desktopPreferencesBridge()).toBeUndefined();
    const html = renderToStaticMarkup(<AppearanceModule />);
    expect(html).not.toContain("桌面客户端");
    expect(html).not.toContain("后台运行");
    expect(html).toContain("通知");
    expect(html).toContain("系统通知");
    expect(html).toContain("提示音");
    expect(html).toContain("任务栏红点");
  });

  it("renders desktop background running and notification controls in both Chinese and English", () => {
    const preferences: DesktopPreferencesBridge = {
      get: vi.fn(async () => ({ backgroundRunning: true, notifications: { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES } })),
      set: vi.fn(async (patch) => ({
        backgroundRunning: patch.backgroundRunning ?? true,
        notifications: { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, ...(patch.notifications ?? {}) },
      })),
      onChange: vi.fn(() => () => {}),
    };
    vi.stubGlobal("window", { kuloDesktop: { preferences, systemPermissions: { status: vi.fn(), requestMicrophone: vi.fn(), openSettings: vi.fn() } } });
    expect(desktopPreferencesBridge()).toBe(preferences);

    const zhHtml = renderToStaticMarkup(<AppearanceModule />);
    expect(zhHtml).toContain("桌面客户端");
    expect(zhHtml).toContain("后台运行");
    expect(zhHtml).toContain("系统通知设置");
    expect(zhHtml).toContain("发送测试通知");

    setLanguage("en");
    const enHtml = renderToStaticMarkup(<AppearanceModule />);
    expect(enHtml).toContain("Desktop app");
    expect(enHtml).toContain("Run in background");
    expect(enHtml).toContain("Notifications");
    expect(enHtml).toContain("System notifications");
    expect(enHtml).toContain("Sound");
    expect(enHtml).toContain("Taskbar badge");
    expect(enHtml).toContain("System settings");
    expect(enHtml).toContain("Send test notification");
  });

  it("loads preferences, toggles background and notifications immediately, retries failures, and syncs external changes", async () => {
    let externalListener: ((prefs: DesktopPreferences) => void) | undefined;
    let stored: DesktopPreferences = {
      backgroundRunning: true,
      notifications: { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES },
    };
    const bridge: DesktopPreferencesBridge = {
      get: vi.fn(async () => ({ backgroundRunning: stored.backgroundRunning, notifications: { ...stored.notifications } })),
      set: vi.fn(async (patch) => {
        stored = {
          backgroundRunning: patch.backgroundRunning ?? stored.backgroundRunning,
          notifications: { ...stored.notifications, ...(patch.notifications ?? {}) },
        };
        return { backgroundRunning: stored.backgroundRunning, notifications: { ...stored.notifications } };
      }),
      onChange: vi.fn((listener) => {
        externalListener = listener;
        return () => { externalListener = undefined; };
      }),
    };

    const initial = renderPreferencesHook(bridge);
    expect(initial.supported).toBe(true);
    expect(initial.loading).toBe(true);
    expect(initial.preferences).toBeNull();
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();

    const loaded = renderPreferencesHook(bridge);
    expect(loaded.loading).toBe(false);
    expect(loaded.preferences).toEqual({
      backgroundRunning: true,
      notifications: { enabled: true, sound: false, badge: true },
    });
    expect(loaded.error).toBeNull();

    // Toggle background running off
    await loaded.setBackgroundRunning(false);
    const turnedOff = renderPreferencesHook(bridge);
    expect(bridge.set).toHaveBeenCalledWith({ backgroundRunning: false });
    expect(turnedOff.preferences).toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: false, badge: true },
    });
    expect(turnedOff.saving).toBe(false);

    // Toggle notifications sound on and badge off
    await turnedOff.setNotifications({ sound: true });
    const soundOn = renderPreferencesHook(bridge);
    expect(bridge.set).toHaveBeenCalledWith({ notifications: { sound: true } });
    expect(soundOn.preferences?.notifications).toEqual({ enabled: true, sound: true, badge: true });

    // Failed write preserves last confirmed state and allows retry
    (bridge.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("磁盘写入失败"));
    await soundOn.setNotifications({ badge: false });
    const errored = renderPreferencesHook(bridge);
    expect(errored.preferences?.notifications).toEqual({ enabled: true, sound: true, badge: true });
    expect(errored.error).toBe("磁盘写入失败");

    await errored.retry();
    const retried = renderPreferencesHook(bridge);
    expect(retried.preferences?.notifications).toEqual({ enabled: true, sound: true, badge: false });
    expect(retried.error).toBeNull();

    // External main-process change syncs immediately
    externalListener?.({
      backgroundRunning: true,
      notifications: { enabled: false, sound: false, badge: true },
    });
    const synced = renderPreferencesHook(bridge);
    expect(synced.preferences).toEqual({
      backgroundRunning: true,
      notifications: { enabled: false, sound: false, badge: true },
    });
  });
});
