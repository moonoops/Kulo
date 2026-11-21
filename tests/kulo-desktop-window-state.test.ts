import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopWindowStateStore,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DESKTOP_WINDOW_STATE_FILENAME,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readDesktopWindowStateFile,
  resolveWindowLaunchOptions,
  writeDesktopWindowStateFile,
  type DisplayWorkAreaLike,
  type ManagedWindowForState,
  type WindowRect,
  type WindowStateEventName,
} from "../packages/desktop/src/window-state.js";

const directories: string[] = [];
function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-desktop-window-state-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of directories.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface FakeWindowOptions {
  bounds: WindowRect;
  normalBounds?: WindowRect;
  workArea?: WindowRect;
  syncMaximize?: boolean;
  syncFullScreen?: boolean;
  echoBoundsInNormalWhenMaximized?: boolean;
}

function createFakeWindow(options: FakeWindowOptions) {
  const listeners = new Map<WindowStateEventName, Set<() => void>>();
  let destroyed = false;
  let visible = false;
  let minimized = false;
  let maximized = false;
  let fullScreen = false;
  let bounds: WindowRect = { ...options.bounds };
  let normalBounds: WindowRect = { ...(options.normalBounds ?? options.bounds) };
  const workArea: WindowRect = options.workArea ?? { x: 0, y: 25, width: 1512, height: 957 };

  const emit = (event: WindowStateEventName) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener();
    }
  };

  const win: ManagedWindowForState & {
    show: ReturnType<typeof vi.fn>;
    maximize: ReturnType<typeof vi.fn>;
    setFullScreen: ReturnType<typeof vi.fn>;
    emit: (event: WindowStateEventName) => void;
    setBoundsState: (next: WindowRect, nextNormal?: WindowRect) => void;
    setVisibleState: (value: boolean) => void;
    setMinimizedState: (value: boolean) => void;
    setMaximizedState: (value: boolean) => void;
    setFullScreenState: (value: boolean) => void;
    destroyState: () => void;
    listenerCount: (event: WindowStateEventName) => number;
  } = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
    getBounds: () => ({ ...bounds }),
    getNormalBounds: () => {
      if ((maximized || fullScreen) && options.echoBoundsInNormalWhenMaximized) {
        return { ...bounds };
      }
      return { ...normalBounds };
    },
    show: vi.fn(() => {
      visible = true;
    }),
    maximize: vi.fn(() => {
      if (options.syncMaximize !== false) {
        maximized = true;
        bounds = { ...workArea };
        emit("resize");
        emit("maximize");
      }
    }),
    setFullScreen: vi.fn((flag: boolean) => {
      if (options.syncFullScreen) {
        fullScreen = flag;
        if (flag) {
          bounds = { x: 0, y: 0, width: 1512, height: 982 };
          emit("enter-full-screen");
        } else {
          bounds = { ...normalBounds };
          emit("leave-full-screen");
        }
      }
    }),
    on: (event, listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    emit,
    setBoundsState: (next, nextNormal) => {
      bounds = { ...next };
      if (nextNormal) {
        normalBounds = { ...nextNormal };
      } else if (!maximized && !fullScreen && !minimized) {
        normalBounds = { ...next };
      }
    },
    setVisibleState: (value) => { visible = value; },
    setMinimizedState: (value) => { minimized = value; },
    setMaximizedState: (value) => { maximized = value; },
    setFullScreenState: (value) => { fullScreen = value; },
    destroyState: () => {
      destroyed = true;
      emit("closed");
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };

  return win;
}

describe("desktop window launch geometry resolution", () => {
  const macbookDisplay: DisplayWorkAreaLike = { workArea: { x: 0, y: 25, width: 1512, height: 957 } };
  const smallDisplay: DisplayWorkAreaLike = { workArea: { x: 0, y: 25, width: 1280, height: 775 } };
  const externalRight: DisplayWorkAreaLike = { workArea: { x: 1512, y: 25, width: 2560, height: 1415 } };
  const externalLeft: DisplayWorkAreaLike = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const externalAbove: DisplayWorkAreaLike = { workArea: { x: 0, y: -1080, width: 1920, height: 1080 } };

  it("uses centered defaults on first launch and clamps defaults when the primary display is smaller", () => {
    expect(resolveWindowLaunchOptions(undefined, [macbookDisplay], macbookDisplay)).toEqual({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
    });

    expect(resolveWindowLaunchOptions(undefined, [smallDisplay], smallDisplay)).toEqual({
      width: 1280,
      height: 775,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
    });
  });

  it("preserves exact coordinates on multi-monitor setups including negative coordinates", () => {
    const saved = { x: -1800, y: 90, width: 1440, height: 900, isMaximized: false, isFullScreen: false };
    expect(resolveWindowLaunchOptions(saved, [externalLeft, macbookDisplay], macbookDisplay)).toEqual({
      x: -1800,
      y: 90,
      width: 1440,
      height: 900,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
    });
  });

  it("relocates windows from disconnected monitors onto the primary display while preserving maximized/fullscreen mode", () => {
    const saved = { x: 1800, y: 120, width: 1800, height: 1100, isMaximized: true, isFullScreen: false };
    expect(resolveWindowLaunchOptions(saved, [macbookDisplay], macbookDisplay)).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 957,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: true,
      isFullScreen: false,
    });

    const savedNormal = { x: 2000, y: 100, width: 1000, height: 700, isMaximized: false, isFullScreen: true };
    expect(resolveWindowLaunchOptions(savedNormal, [macbookDisplay], macbookDisplay)).toEqual({
      x: 256,
      y: 154,
      width: 1000,
      height: 700,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: false,
      isFullScreen: true,
    });
  });

  it("clamps oversized windows on a shrunk display and keeps the titlebar below the menu bar", () => {
    const oversized = { x: 300, y: 100, width: 1800, height: 1100, isMaximized: false, isFullScreen: false };
    expect(resolveWindowLaunchOptions(oversized, [macbookDisplay], macbookDisplay)).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 957,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
    });

    const aboveMenuBar = { x: 100, y: -30, width: 1000, height: 700, isMaximized: false, isFullScreen: false };
    expect(resolveWindowLaunchOptions(aboveMenuBar, [macbookDisplay], macbookDisplay)).toMatchObject({
      x: 100,
      y: 25,
      width: 1000,
      height: 700,
    });

    // If a monitor is stacked above and holds the titlebar, preserve spanning vertical coordinates.
    const spanningStacked = { x: 100, y: -200, width: 1000, height: 700, isMaximized: false, isFullScreen: false };
    expect(resolveWindowLaunchOptions(spanningStacked, [externalAbove, macbookDisplay], macbookDisplay)).toMatchObject({
      x: 100,
      y: -200,
      width: 1000,
      height: 700,
    });

    // On a connected right monitor, keep exact bounds without moving back to primary.
    const onRight = { x: 1600, y: 80, width: 1600, height: 1000, isMaximized: false, isFullScreen: false };
    expect(resolveWindowLaunchOptions(onRight, [macbookDisplay, externalRight], macbookDisplay)).toMatchObject({
      x: 1600,
      y: 80,
      width: 1600,
      height: 1000,
    });
  });
});

describe("desktop window state persistence and lifecycle", () => {
  const display: DisplayWorkAreaLike = { workArea: { x: 0, y: 25, width: 1512, height: 957 } };

  it("remembers maximized state and pre-maximized bounds across quit and reopen without re-maximizing on subsequent focus", () => {
    const dir = directory();
    const store = createDesktopWindowStateStore({ dataDir: dir });
    const firstLaunch = store.resolveLaunchOptions([display], display);
    expect(firstLaunch.isMaximized).toBe(false);

    const win1 = createFakeWindow({
      bounds: { x: 66, y: 40, width: 1380, height: 920 },
      workArea: display.workArea,
      echoBoundsInNormalWhenMaximized: true,
    });
    store.attach(win1, firstLaunch);
    store.reveal(win1);
    expect(win1.show).toHaveBeenCalledTimes(1);
    expect(win1.maximize).not.toHaveBeenCalled();

    // User maximizes the window and quits via Cmd+Q (before-quit flushes and detaches).
    win1.setMaximizedState(true);
    win1.setBoundsState(display.workArea);
    win1.emit("maximize");
    store.flush();
    store.detach();

    const file = path.join(dir, DESKTOP_WINDOW_STATE_FILENAME);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 66,
      y: 40,
      width: 1380,
      height: 920,
      isMaximized: true,
      isFullScreen: false,
    });

    // Reopen in a fresh session: restores normal bounds and calls maximize() on first reveal.
    const reopenedStore = createDesktopWindowStateStore({ dataDir: dir });
    const secondLaunch = reopenedStore.resolveLaunchOptions([display], display);
    expect(secondLaunch).toEqual({
      x: 66,
      y: 40,
      width: 1380,
      height: 920,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: true,
      isFullScreen: false,
    });

    const win2 = createFakeWindow({
      bounds: { x: secondLaunch.x!, y: secondLaunch.y!, width: secondLaunch.width, height: secondLaunch.height },
      workArea: display.workArea,
      echoBoundsInNormalWhenMaximized: true,
    });
    reopenedStore.attach(win2, secondLaunch);
    reopenedStore.reveal(win2);
    expect(win2.show).toHaveBeenCalledTimes(1);
    expect(win2.maximize).toHaveBeenCalledTimes(1);
    expect(reopenedStore.get()).toEqual({
      x: 66,
      y: 40,
      width: 1380,
      height: 920,
      isMaximized: true,
      isFullScreen: false,
    });

    // User unmaximizes, then clicks Dock icon (reveal called again) -> must NOT re-maximize.
    win2.setMaximizedState(false);
    win2.setBoundsState({ x: 120, y: 80, width: 1100, height: 760 });
    win2.emit("unmaximize");
    reopenedStore.reveal(win2);
    expect(win2.maximize).toHaveBeenCalledTimes(1);
    expect(win2.show).toHaveBeenCalledTimes(2);
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 120,
      y: 80,
      width: 1100,
      height: 760,
      isMaximized: false,
      isFullScreen: false,
    });
    reopenedStore.detach();
  });

  it("remembers native full-screen mode and guards async macOS fullscreen transitions against clobbering", () => {
    vi.useFakeTimers();
    const dir = directory();
    const store = createDesktopWindowStateStore({ dataDir: dir });
    const launch = store.resolveLaunchOptions([display], display);
    const win1 = createFakeWindow({
      bounds: { x: 100, y: 60, width: 1200, height: 820 },
      syncFullScreen: false,
    });
    store.attach(win1, launch);
    store.reveal(win1);

    win1.setFullScreenState(true);
    win1.setBoundsState({ x: 0, y: 0, width: 1512, height: 982 }, { x: 100, y: 60, width: 1200, height: 820 });
    win1.emit("enter-full-screen");
    store.flush();
    store.detach();

    const file = path.join(dir, DESKTOP_WINDOW_STATE_FILENAME);
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 100,
      y: 60,
      width: 1200,
      height: 820,
      isMaximized: false,
      isFullScreen: true,
    });

    // Reopen with async fullscreen transition (isFullScreen stays false until enter-full-screen fires).
    const reopenedStore = createDesktopWindowStateStore({ dataDir: dir });
    const secondLaunch = reopenedStore.resolveLaunchOptions([display], display);
    const win2 = createFakeWindow({
      bounds: { x: secondLaunch.x!, y: secondLaunch.y!, width: secondLaunch.width, height: secondLaunch.height },
      syncFullScreen: false,
    });
    reopenedStore.attach(win2, secondLaunch);
    reopenedStore.reveal(win2);
    expect(win2.show).toHaveBeenCalledTimes(1);
    expect(win2.setFullScreen).toHaveBeenCalledWith(true);

    // Mid-animation resize/move and stray unmaximize must not overwrite isFullScreen or normal bounds.
    win2.setBoundsState({ x: 0, y: 0, width: 1512, height: 982 });
    win2.emit("resize");
    win2.emit("move");
    win2.emit("unmaximize");
    vi.advanceTimersByTime(400);
    reopenedStore.flush();
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 100,
      y: 60,
      width: 1200,
      height: 820,
      isMaximized: false,
      isFullScreen: true,
    });

    // Animation finishes -> enter-full-screen clears guard; later leaving fullscreen persists isFullScreen: false.
    win2.setFullScreenState(true);
    win2.emit("enter-full-screen");
    win2.setFullScreenState(false);
    win2.setBoundsState({ x: 100, y: 60, width: 1200, height: 820 });
    win2.emit("leave-full-screen");
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 100,
      y: 60,
      width: 1200,
      height: 820,
      isMaximized: false,
      isFullScreen: false,
    });
    reopenedStore.detach();
  });

  it("debounces normal resize/move updates, captures full workArea fills, and flushes synchronously on quit", () => {
    vi.useFakeTimers();
    const dir = directory();
    const file = path.join(dir, DESKTOP_WINDOW_STATE_FILENAME);
    const store = createDesktopWindowStateStore({ dataDir: dir, debounceMs: 250 });
    const launch = store.resolveLaunchOptions([display], display);
    const win = createFakeWindow({ bounds: { x: 66, y: 40, width: 1380, height: 920 } });
    store.attach(win, launch);
    store.reveal(win);

    // Rapid resize events coalesce and persist after debounce.
    win.setBoundsState({ x: 20, y: 25, width: 1400, height: 900 });
    win.emit("resize");
    vi.advanceTimersByTime(100);
    expect(fs.existsSync(file)).toBe(false);

    win.setBoundsState(display.workArea);
    win.emit("move");
    win.emit("resize");
    vi.advanceTimersByTime(250);
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 957,
      isMaximized: false,
      isFullScreen: false,
    });

    // Immediate quit right after resizing flushes without waiting for the debounce timer.
    win.setBoundsState({ x: 200, y: 120, width: 980, height: 700 });
    win.emit("resize");
    store.flush();
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 200,
      y: 120,
      width: 980,
      height: 700,
      isMaximized: false,
      isFullScreen: false,
    });
    store.detach();
  });

  it("preserves last visible state when hidden to tray, minimized, or quitting before first reveal", () => {
    const dir = directory();
    const file = path.join(dir, DESKTOP_WINDOW_STATE_FILENAME);
    const store = createDesktopWindowStateStore({ dataDir: dir });
    const launch = store.resolveLaunchOptions([display], display);
    const win = createFakeWindow({ bounds: { x: 80, y: 50, width: 1300, height: 860 } });
    store.attach(win, launch);
    store.reveal(win);

    // Maximize, then simulate Cmd+W hide-to-tray followed by tray quit where hidden window reports non-maximized.
    win.setMaximizedState(true);
    win.setBoundsState(display.workArea, { x: 80, y: 50, width: 1300, height: 860 });
    win.emit("maximize");
    win.emit("close");
    win.setVisibleState(false);
    win.setMaximizedState(false);
    win.setBoundsState({ x: 0, y: 0, width: 400, height: 560 });
    store.flush();
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 80,
      y: 50,
      width: 1300,
      height: 860,
      isMaximized: true,
      isFullScreen: false,
    });

    // Restore visible and minimize -> minimized bounds (-32000) must not clobber saved state.
    win.setVisibleState(true);
    win.setMinimizedState(true);
    win.setBoundsState({ x: -32000, y: -32000, width: 160, height: 28 });
    store.flush();
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 80,
      y: 50,
      width: 1300,
      height: 860,
      isMaximized: true,
      isFullScreen: false,
    });
    store.detach();

    // Fresh launch that quits BEFORE reveal() must keep the existing saved maximized state intact.
    const abortedStore = createDesktopWindowStateStore({ dataDir: dir });
    const nextLaunch = abortedStore.resolveLaunchOptions([display], display);
    const hiddenWin = createFakeWindow({ bounds: { x: 80, y: 50, width: 1300, height: 860 } });
    abortedStore.attach(hiddenWin, nextLaunch);
    hiddenWin.emit("resize");
    abortedStore.flush();
    abortedStore.detach();
    expect(readDesktopWindowStateFile(file)).toEqual({
      x: 80,
      y: 50,
      width: 1300,
      height: 860,
      isMaximized: true,
      isFullScreen: false,
    });
    expect(hiddenWin.listenerCount("resize")).toBe(0);
    expect(hiddenWin.listenerCount("close")).toBe(0);
  });

  it("handles corrupt files safely, refuses symlinks, and logs write errors without throwing", () => {
    const dir = directory();
    const file = path.join(dir, DESKTOP_WINDOW_STATE_FILENAME);
    for (const invalid of [
      "{broken",
      "[]",
      JSON.stringify({ formatVersion: 2, width: 1200, height: 800, isMaximized: false, isFullScreen: false }),
      JSON.stringify({ formatVersion: 1, x: 100, width: 1200, height: 800, isMaximized: false, isFullScreen: false }),
      JSON.stringify({ formatVersion: 1, width: 0, height: 800, isMaximized: false, isFullScreen: false }),
      JSON.stringify({ formatVersion: 1, width: 1200, height: 800, isMaximized: "yes", isFullScreen: false }),
      JSON.stringify({ formatVersion: 1, width: 1200, height: 800, isMaximized: false, isFullScreen: false, extra: 1 }),
    ]) {
      fs.writeFileSync(file, invalid, { mode: 0o600 });
      expect(() => readDesktopWindowStateFile(file)).toThrow();
    }

    const logs: string[] = [];
    const fallbackStore = createDesktopWindowStateStore({ dataDir: dir, onLog: (msg) => logs.push(msg) });
    expect(fallbackStore.get()).toBeUndefined();
    expect(logs).toHaveLength(1);

    const linkedDir = directory();
    const outside = path.join(directory(), "outside-window-state.json");
    const validState = { formatVersion: 1, x: 50, y: 50, width: 1000, height: 700, isMaximized: false, isFullScreen: false };
    fs.writeFileSync(outside, JSON.stringify(validState), { mode: 0o600 });
    const linkFile = path.join(linkedDir, DESKTOP_WINDOW_STATE_FILENAME);
    fs.symlinkSync(outside, linkFile);
    expect(() => readDesktopWindowStateFile(linkFile)).toThrow();
    expect(() => writeDesktopWindowStateFile(linkFile, {
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
      isMaximized: true,
      isFullScreen: false,
    })).toThrow("不可用");
    expect(JSON.parse(fs.readFileSync(outside, "utf8"))).toEqual(validState);

    const readOnlyDir = directory();
    fs.chmodSync(readOnlyDir, 0o500);
    try {
      const writeLogs: string[] = [];
      const roStore = createDesktopWindowStateStore({ dataDir: readOnlyDir, onLog: (msg) => writeLogs.push(msg) });
      const win = createFakeWindow({ bounds: { x: 100, y: 60, width: 1200, height: 800 } });
      roStore.attach(win, roStore.resolveLaunchOptions([display], display));
      roStore.reveal(win);
      expect(() => roStore.flush()).not.toThrow();
      expect(writeLogs.some((line) => line.includes("保存窗口状态失败"))).toBe(true);
      roStore.detach();
    } finally {
      fs.chmodSync(readOnlyDir, 0o700);
    }
  });
});
