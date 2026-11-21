import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayWorkAreaLike {
  workArea: WindowRect;
}

export interface DesktopWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
}

export interface DesktopWindowLaunchOptions {
  x?: number;
  y?: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  isMaximized: boolean;
  isFullScreen: boolean;
}

export type WindowStateEventName =
  | "resize"
  | "move"
  | "maximize"
  | "unmaximize"
  | "enter-full-screen"
  | "leave-full-screen"
  | "close"
  | "closed";

export interface ManagedWindowForState {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getBounds(): WindowRect;
  getNormalBounds(): WindowRect;
  show(): void;
  maximize(): void;
  setFullScreen(flag: boolean): void;
  on(event: WindowStateEventName, listener: () => void): unknown;
  removeListener(event: WindowStateEventName, listener: () => void): unknown;
}

export const DESKTOP_WINDOW_STATE_FILENAME = "desktop-window-state.json";
export const DEFAULT_WINDOW_WIDTH = 1380;
export const DEFAULT_WINDOW_HEIGHT = 920;
export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 560;

const MAX_WINDOW_STATE_BYTES = 16 * 1024;
const MAX_WINDOW_DIMENSION = 32_768;
const MAX_WINDOW_COORDINATE = 65_536;
const DEFAULT_SAVE_DEBOUNCE_MS = 250;
const MAXIMIZE_RESTORE_GUARD_MS = 500;
const FULLSCREEN_RESTORE_GUARD_MS = 3_000;
const MIN_VISIBLE_OVERLAP_WIDTH = 100;
const MIN_VISIBLE_OVERLAP_HEIGHT = 60;
const MIN_VISIBLE_TITLEBAR_HEIGHT = 48;
const MIN_REACHABLE_TITLEBAR_HEIGHT = 24;

const ALLOWED_STORED_KEYS = new Set([
  "formatVersion",
  "x",
  "y",
  "width",
  "height",
  "isMaximized",
  "isFullScreen",
]);

function cloneState(state: DesktopWindowState): DesktopWindowState {
  return {
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    isMaximized: state.isMaximized,
    isFullScreen: state.isFullScreen,
  };
}

function serializeState(state: DesktopWindowState): string {
  const normalized = normalizeState(state);
  return `${JSON.stringify({
    formatVersion: 1,
    ...(normalized.x !== undefined && normalized.y !== undefined ? { x: normalized.x, y: normalized.y } : {}),
    width: normalized.width,
    height: normalized.height,
    isMaximized: normalized.isMaximized,
    isFullScreen: normalized.isFullScreen,
  }, null, 2)}\n`;
}

function isValidCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_WINDOW_COORDINATE;
}

function isValidDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WINDOW_DIMENSION;
}

function normalizeState(state: DesktopWindowState): DesktopWindowState {
  const width = Math.round(state.width);
  const height = Math.round(state.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
    width > MAX_WINDOW_DIMENSION || height > MAX_WINDOW_DIMENSION) {
    throw new Error("窗口尺寸参数无效。");
  }
  const hasX = state.x !== undefined;
  const hasY = state.y !== undefined;
  if (hasX !== hasY) {
    throw new Error("窗口坐标参数无效。");
  }
  let x: number | undefined;
  let y: number | undefined;
  if (hasX && hasY) {
    const roundedX = Math.round(state.x!);
    const roundedY = Math.round(state.y!);
    if (!Number.isFinite(roundedX) || !Number.isFinite(roundedY) ||
      Math.abs(roundedX) > MAX_WINDOW_COORDINATE || Math.abs(roundedY) > MAX_WINDOW_COORDINATE) {
      throw new Error("窗口坐标参数无效。");
    }
    x = roundedX;
    y = roundedY;
  }
  const isFullScreen = Boolean(state.isFullScreen);
  const isMaximized = isFullScreen ? false : Boolean(state.isMaximized);
  return {
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    width: Math.max(MIN_WINDOW_WIDTH, width),
    height: Math.max(MIN_WINDOW_HEIGHT, height),
    isMaximized,
    isFullScreen,
  };
}

function normalizeWindowRect(rect: WindowRect | undefined): WindowRect | undefined {
  if (!rect || typeof rect !== "object") return undefined;
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) ||
    Math.abs(x) > MAX_WINDOW_COORDINATE || Math.abs(y) > MAX_WINDOW_COORDINATE ||
    width < 1 || height < 1 || width > MAX_WINDOW_DIMENSION || height > MAX_WINDOW_DIMENSION
  ) {
    return undefined;
  }
  return {
    x,
    y,
    width: Math.max(MIN_WINDOW_WIDTH, width),
    height: Math.max(MIN_WINDOW_HEIGHT, height),
  };
}

function isValidWorkArea(rect: WindowRect | undefined): rect is WindowRect {
  return Boolean(
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0,
  );
}

function rectsEqual(a: WindowRect, b: WindowRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function clampSize(size: number, minSize: number, available: number): number {
  const maxAllowed = Math.max(minSize, Math.floor(available));
  return clamp(Math.round(size), minSize, maxAllowed);
}

function rectIntersection(a: WindowRect, b: WindowRect): { width: number; height: number; area: number } {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return { width, height, area: width * height };
}

function isTitlebarReachable(rect: WindowRect, displays: readonly DisplayWorkAreaLike[]): boolean {
  const titlebarHeight = Math.min(MIN_VISIBLE_TITLEBAR_HEIGHT, rect.height);
  const titlebar: WindowRect = { x: rect.x, y: rect.y, width: rect.width, height: titlebarHeight };
  const minWidth = Math.min(MIN_VISIBLE_OVERLAP_WIDTH, rect.width);
  const minHeight = Math.min(MIN_REACHABLE_TITLEBAR_HEIGHT, titlebarHeight);
  return displays.some(({ workArea }) => {
    if (rect.y < workArea.y) return false;
    const overlap = rectIntersection(titlebar, workArea);
    return overlap.width >= minWidth && overlap.height >= minHeight;
  });
}

export function readDesktopWindowStateFile(file: string): DesktopWindowState | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > MAX_WINDOW_STATE_BYTES ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("窗口状态文件无效。");
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("窗口状态格式无效。");
    }
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_STORED_KEYS.has(key)) throw new Error("窗口状态格式无效。");
    }
    if (record.formatVersion !== 1) {
      throw new Error("窗口状态版本无效。");
    }
    if (!isValidDimension(record.width) || !isValidDimension(record.height)) {
      throw new Error("窗口尺寸内容无效。");
    }
    const hasX = record.x !== undefined;
    const hasY = record.y !== undefined;
    if (hasX !== hasY) {
      throw new Error("窗口坐标内容无效。");
    }
    if (hasX && (!isValidCoordinate(record.x) || !isValidCoordinate(record.y))) {
      throw new Error("窗口坐标内容无效。");
    }
    if (typeof record.isMaximized !== "boolean" || typeof record.isFullScreen !== "boolean") {
      throw new Error("窗口模式内容无效。");
    }
    return normalizeState({
      ...(hasX ? { x: record.x as number, y: record.y as number } : {}),
      width: record.width,
      height: record.height,
      isMaximized: record.isMaximized,
      isFullScreen: record.isFullScreen,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeDesktopWindowStateFile(file: string, state: DesktopWindowState): void {
  const existing = (() => {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  })();
  if (
    existing &&
    (!existing.isFile() ||
      existing.isSymbolicLink() ||
      (typeof process.getuid === "function" && existing.uid !== process.getuid()))
  ) {
    throw new Error("窗口状态保存位置不可用。");
  }
  const content = serializeState(state);
  const temporary = path.join(path.dirname(file), `.desktop-window-state-${randomBytes(12).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, content, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch {
    throw new Error("无法保存窗口状态，请检查数据目录权限。");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function resolveWindowLaunchOptions(
  saved: DesktopWindowState | undefined,
  displays: readonly DisplayWorkAreaLike[],
  primaryDisplay?: DisplayWorkAreaLike,
): DesktopWindowLaunchOptions {
  const validDisplays = displays.filter((display) => isValidWorkArea(display.workArea));
  const fallbackDisplay = primaryDisplay && isValidWorkArea(primaryDisplay.workArea)
    ? primaryDisplay
    : validDisplays[0];

  if (!saved) {
    const width = fallbackDisplay
      ? clampSize(DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH, fallbackDisplay.workArea.width)
      : DEFAULT_WINDOW_WIDTH;
    const height = fallbackDisplay
      ? clampSize(DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT, fallbackDisplay.workArea.height)
      : DEFAULT_WINDOW_HEIGHT;
    return {
      width,
      height,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
    };
  }

  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(saved.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(saved.height));
  const isFullScreen = Boolean(saved.isFullScreen);
  const isMaximized = !isFullScreen && Boolean(saved.isMaximized);

  if (!fallbackDisplay) {
    return {
      ...(saved.x !== undefined && saved.y !== undefined ? { x: Math.round(saved.x), y: Math.round(saved.y) } : {}),
      width,
      height,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized,
      isFullScreen,
    };
  }

  if (saved.x === undefined || saved.y === undefined) {
    return {
      width: clampSize(width, MIN_WINDOW_WIDTH, fallbackDisplay.workArea.width),
      height: clampSize(height, MIN_WINDOW_HEIGHT, fallbackDisplay.workArea.height),
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized,
      isFullScreen,
    };
  }

  const rect: WindowRect = { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
  const minVisibleWidth = Math.min(MIN_VISIBLE_OVERLAP_WIDTH, width);
  const minVisibleHeight = Math.min(MIN_VISIBLE_OVERLAP_HEIGHT, height);

  let bestDisplay: DisplayWorkAreaLike | undefined;
  let bestOverlap = { width: 0, height: 0, area: 0 };
  let overlappingCount = 0;

  for (const display of validDisplays) {
    const overlap = rectIntersection(rect, display.workArea);
    if (overlap.area > 0) overlappingCount += 1;
    if (overlap.area > bestOverlap.area) {
      bestOverlap = overlap;
      bestDisplay = display;
    }
  }

  if (!bestDisplay || bestOverlap.width < minVisibleWidth || bestOverlap.height < minVisibleHeight) {
    const wa = fallbackDisplay.workArea;
    const clampedWidth = clampSize(width, MIN_WINDOW_WIDTH, wa.width);
    const clampedHeight = clampSize(height, MIN_WINDOW_HEIGHT, wa.height);
    const centeredX = Math.round(wa.x + Math.max(0, (wa.width - clampedWidth) / 2));
    const centeredY = Math.round(wa.y + Math.max(0, (wa.height - clampedHeight) / 2));
    return {
      x: centeredX,
      y: centeredY,
      width: clampedWidth,
      height: clampedHeight,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      isMaximized,
      isFullScreen,
    };
  }

  const wa = bestDisplay.workArea;
  const clampedWidth = overlappingCount === 1 ? clampSize(width, MIN_WINDOW_WIDTH, wa.width) : width;
  const clampedHeight = overlappingCount === 1 ? clampSize(height, MIN_WINDOW_HEIGHT, wa.height) : height;
  const wasShrunk = clampedWidth < width || clampedHeight < height;

  let nextX = rect.x;
  let nextY = rect.y;

  if (wasShrunk) {
    nextX = clamp(rect.x, Math.round(wa.x), Math.round(Math.max(wa.x, wa.x + wa.width - clampedWidth)));
    nextY = clamp(rect.y, Math.round(wa.y), Math.round(Math.max(wa.y, wa.y + wa.height - clampedHeight)));
  } else if (!isTitlebarReachable({ x: nextX, y: nextY, width: clampedWidth, height: clampedHeight }, validDisplays)) {
    const maxY = Math.max(wa.y, wa.y + wa.height - Math.min(MIN_VISIBLE_TITLEBAR_HEIGHT, clampedHeight));
    nextY = clamp(rect.y, Math.round(wa.y), Math.round(maxY));
  }

  return {
    x: nextX,
    y: nextY,
    width: clampedWidth,
    height: clampedHeight,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    isMaximized,
    isFullScreen,
  };
}

export interface DesktopWindowStateStoreOptions {
  dataDir: string;
  debounceMs?: number;
  maximizeRestoreGuardMs?: number;
  fullscreenRestoreGuardMs?: number;
  onLog?(message: string): void;
}

export interface DesktopWindowStateStore {
  get(): DesktopWindowState | undefined;
  resolveLaunchOptions(displays: readonly DisplayWorkAreaLike[], primaryDisplay?: DisplayWorkAreaLike): DesktopWindowLaunchOptions;
  attach(win: ManagedWindowForState, launch: DesktopWindowLaunchOptions): () => void;
  reveal(win: ManagedWindowForState): void;
  flush(): void;
  detach(): void;
}

type DisplayModeEvent = "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen";
type RestoringMode = "none" | "maximize" | "fullscreen";

export function createDesktopWindowStateStore(options: DesktopWindowStateStoreOptions): DesktopWindowStateStore {
  const file = path.join(options.dataDir, DESKTOP_WINDOW_STATE_FILENAME);
  const debounceMs = options.debounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  const maximizeRestoreGuardMs = options.maximizeRestoreGuardMs ?? MAXIMIZE_RESTORE_GUARD_MS;
  const fullscreenRestoreGuardMs = options.fullscreenRestoreGuardMs ?? FULLSCREEN_RESTORE_GUARD_MS;

  let current: DesktopWindowState | undefined;
  let lastWrittenKey: string | undefined;

  try {
    const loaded = readDesktopWindowStateFile(file);
    if (loaded) {
      current = loaded;
      lastWrittenKey = serializeState(loaded);
    }
  } catch (error) {
    options.onLog?.(`读取窗口状态失败，已恢复默认窗口尺寸：${error instanceof Error ? error.message : "未知错误"}`);
    current = undefined;
    lastWrittenKey = undefined;
  }

  let attachedWindow: ManagedWindowForState | undefined;
  let cleanupListeners: (() => void) | undefined;
  let hasRevealed = false;
  let pendingRestore = { isMaximized: false, isFullScreen: false };
  let restoringMode: RestoringMode = "none";
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let normalBounds: WindowRect | undefined;
  let fallbackSize = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };

  function clearSaveTimer(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
  }

  function clearRestoreGuard(): void {
    restoringMode = "none";
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = undefined;
    }
  }

  function beginRestoreGuard(mode: Exclude<RestoringMode, "none">, timeoutMs: number): void {
    clearRestoreGuard();
    restoringMode = mode;
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined;
      if (restoringMode === mode) {
        restoringMode = "none";
      }
    }, timeoutMs);
    restoreTimer.unref?.();
  }

  function persistCurrent(): void {
    if (!current) return;
    let serialized: string;
    try {
      serialized = serializeState(current);
    } catch (error) {
      options.onLog?.(`窗口状态无效，已跳过保存：${error instanceof Error ? error.message : "未知错误"}`);
      return;
    }
    if (serialized === lastWrittenKey) return;
    try {
      writeDesktopWindowStateFile(file, current);
      lastWrittenKey = serialized;
    } catch (error) {
      options.onLog?.(`保存窗口状态失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  function captureFromWindow(
    win: ManagedWindowForState,
    captureOptions: { modeHint?: DisplayModeEvent; persist: boolean },
  ): void {
    if (!hasRevealed || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;

    const { modeHint, persist } = captureOptions;
    const isFullScreen = modeHint === "enter-full-screen"
      ? true
      : modeHint === "leave-full-screen"
        ? false
        : win.isFullScreen();
    const isMaximized = isFullScreen
      ? false
      : modeHint === "maximize"
        ? true
        : modeHint === "unmaximize"
          ? false
          : win.isMaximized();

    const bounds = normalizeWindowRect(win.getBounds());
    const reportedNormal = normalizeWindowRect(win.getNormalBounds());

    if (!isFullScreen && !isMaximized) {
      const nextNormal = reportedNormal ?? bounds;
      if (nextNormal) {
        normalBounds = nextNormal;
      }
    } else if (reportedNormal && (!bounds || !rectsEqual(reportedNormal, bounds))) {
      normalBounds = reportedNormal;
    }

    current = {
      ...(normalBounds ? { x: normalBounds.x, y: normalBounds.y } : {}),
      width: Math.max(MIN_WINDOW_WIDTH, normalBounds?.width ?? fallbackSize.width),
      height: Math.max(MIN_WINDOW_HEIGHT, normalBounds?.height ?? fallbackSize.height),
      isMaximized,
      isFullScreen,
    };

    if (persist) {
      persistCurrent();
    }
  }

  function scheduleCapture(win: ManagedWindowForState): void {
    if (win !== attachedWindow || !hasRevealed || restoringMode !== "none") return;
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (win === attachedWindow && restoringMode === "none") {
        captureFromWindow(win, { persist: true });
      }
    }, debounceMs);
    saveTimer.unref?.();
  }

  function handleDisplayModeEvent(win: ManagedWindowForState, event: DisplayModeEvent): void {
    if (win !== attachedWindow || !hasRevealed) return;
    if (restoringMode === "fullscreen") {
      if (event !== "enter-full-screen" && event !== "leave-full-screen") return;
      clearRestoreGuard();
    } else if (restoringMode === "maximize") {
      clearRestoreGuard();
    }
    clearSaveTimer();
    captureFromWindow(win, { modeHint: event, persist: true });
  }

  function detach(): void {
    clearSaveTimer();
    clearRestoreGuard();
    const cleanup = cleanupListeners;
    cleanupListeners = undefined;
    attachedWindow = undefined;
    hasRevealed = false;
    pendingRestore = { isMaximized: false, isFullScreen: false };
    cleanup?.();
  }

  function flush(): void {
    clearSaveTimer();
    if (attachedWindow && !attachedWindow.isDestroyed() && hasRevealed && restoringMode === "none") {
      if (attachedWindow.isVisible() && !attachedWindow.isMinimized()) {
        captureFromWindow(attachedWindow, { persist: false });
      }
    }
    persistCurrent();
  }

  return {
    get(): DesktopWindowState | undefined {
      return current ? cloneState(current) : undefined;
    },
    resolveLaunchOptions(displays, primaryDisplay): DesktopWindowLaunchOptions {
      return resolveWindowLaunchOptions(current, displays, primaryDisplay);
    },
    attach(win: ManagedWindowForState, launch: DesktopWindowLaunchOptions): () => void {
      detach();
      attachedWindow = win;
      hasRevealed = false;
      pendingRestore = {
        isMaximized: !launch.isFullScreen && launch.isMaximized,
        isFullScreen: launch.isFullScreen,
      };
      fallbackSize = {
        width: Math.max(MIN_WINDOW_WIDTH, Math.round(launch.width)),
        height: Math.max(MIN_WINDOW_HEIGHT, Math.round(launch.height)),
      };
      normalBounds = launch.x !== undefined && launch.y !== undefined
        ? {
            x: Math.round(launch.x),
            y: Math.round(launch.y),
            width: fallbackSize.width,
            height: fallbackSize.height,
          }
        : undefined;

      const onBoundsChange = () => scheduleCapture(win);
      const onMaximize = () => handleDisplayModeEvent(win, "maximize");
      const onUnmaximize = () => handleDisplayModeEvent(win, "unmaximize");
      const onEnterFullScreen = () => handleDisplayModeEvent(win, "enter-full-screen");
      const onLeaveFullScreen = () => handleDisplayModeEvent(win, "leave-full-screen");
      const onClose = () => {
        if (win === attachedWindow) flush();
      };
      const onClosed = () => {
        if (win === attachedWindow) detach();
      };

      const bindings: Array<readonly [WindowStateEventName, () => void]> = [
        ["resize", onBoundsChange],
        ["move", onBoundsChange],
        ["maximize", onMaximize],
        ["unmaximize", onUnmaximize],
        ["enter-full-screen", onEnterFullScreen],
        ["leave-full-screen", onLeaveFullScreen],
        ["close", onClose],
        ["closed", onClosed],
      ];
      for (const [event, listener] of bindings) {
        win.on(event, listener);
      }

      cleanupListeners = () => {
        if (win.isDestroyed()) return;
        for (const [event, listener] of bindings) {
          win.removeListener(event, listener);
        }
      };

      return () => {
        if (win === attachedWindow) detach();
      };
    },
    reveal(win: ManagedWindowForState): void {
      if (win.isDestroyed()) return;
      if (win !== attachedWindow || hasRevealed) {
        win.show();
        return;
      }
      hasRevealed = true;
      const { isFullScreen, isMaximized } = pendingRestore;
      pendingRestore = { isMaximized: false, isFullScreen: false };

      if (isFullScreen) {
        beginRestoreGuard("fullscreen", fullscreenRestoreGuardMs);
        win.show();
        win.setFullScreen(true);
        if (restoringMode === "fullscreen" && !win.isDestroyed() && win.isFullScreen()) {
          clearRestoreGuard();
          captureFromWindow(win, { modeHint: "enter-full-screen", persist: true });
        }
        return;
      }

      if (isMaximized) {
        beginRestoreGuard("maximize", maximizeRestoreGuardMs);
        win.show();
        win.maximize();
        if (restoringMode === "maximize" && !win.isDestroyed() && win.isMaximized()) {
          clearRestoreGuard();
          captureFromWindow(win, { modeHint: "maximize", persist: true });
        }
        return;
      }

      win.show();
      captureFromWindow(win, { persist: false });
    },
    flush,
    detach,
  };
}
