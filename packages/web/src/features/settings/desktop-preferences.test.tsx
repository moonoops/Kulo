import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../kulo-i18n";
import { AppearanceModule } from "./appearance-module";
import { desktopPreferencesBridge, useDesktopPreferences, type DesktopPreferences, type DesktopPreferencesBridge } from "./desktop-preferences";

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

describe("desktop background running settings UI", () => {
  it("hides desktop-only background settings in regular web browsers", () => {
    expect(desktopPreferencesBridge()).toBeUndefined();
    const html = renderToStaticMarkup(<AppearanceModule />);
    expect(html).not.toContain("桌面客户端");
    expect(html).not.toContain("后台运行");
  });

  it("renders the desktop background running switch in Appearance settings in both Chinese and English", () => {
    const preferences: DesktopPreferencesBridge = {
      get: vi.fn(async () => ({ backgroundRunning: true })),
      set: vi.fn(async (patch) => ({ backgroundRunning: patch.backgroundRunning ?? true })),
      onChange: vi.fn(() => () => {}),
    };
    vi.stubGlobal("window", { kuloDesktop: { preferences } });
    expect(desktopPreferencesBridge()).toBe(preferences);

    const zhHtml = renderToStaticMarkup(<AppearanceModule />);
    expect(zhHtml).toContain("桌面客户端");
    expect(zhHtml).toContain("后台运行");

    setLanguage("en");
    const enHtml = renderToStaticMarkup(<AppearanceModule />);
    expect(enHtml).toContain("Desktop app");
    expect(enHtml).toContain("Run in background");
  });

  it("loads preferences, toggles immediately, surfaces honest errors with retry, and syncs external changes", async () => {
    let externalListener: ((prefs: DesktopPreferences) => void) | undefined;
    let stored = true;
    const bridge: DesktopPreferencesBridge = {
      get: vi.fn(async () => ({ backgroundRunning: stored })),
      set: vi.fn(async (patch) => {
        stored = patch.backgroundRunning ?? stored;
        return { backgroundRunning: stored };
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
    expect(loaded.preferences).toEqual({ backgroundRunning: true });
    expect(loaded.error).toBeNull();

    // Toggle off
    await loaded.setBackgroundRunning(false);
    const turnedOff = renderPreferencesHook(bridge);
    expect(bridge.set).toHaveBeenCalledWith({ backgroundRunning: false });
    expect(turnedOff.preferences).toEqual({ backgroundRunning: false });
    expect(turnedOff.saving).toBe(false);

    // Failed write preserves last confirmed state and allows retry
    (bridge.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("磁盘写入失败"));
    await turnedOff.setBackgroundRunning(true);
    const errored = renderPreferencesHook(bridge);
    expect(errored.preferences).toEqual({ backgroundRunning: false });
    expect(errored.error).toBe("磁盘写入失败");

    await errored.retry();
    const retried = renderPreferencesHook(bridge);
    expect(retried.preferences).toEqual({ backgroundRunning: true });
    expect(retried.error).toBeNull();

    // External main-process change syncs immediately
    externalListener?.({ backgroundRunning: false });
    const synced = renderPreferencesHook(bridge);
    expect(synced.preferences).toEqual({ backgroundRunning: false });
  });
});
