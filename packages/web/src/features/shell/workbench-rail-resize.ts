export const SETTINGS_RAIL_WIDTH_STORAGE_KEY = "kulo:settings-rail-width";
export const SETTINGS_RAIL_MIN_WIDTH = 320;
export const SETTINGS_RAIL_MAX_WIDTH = 912;
export const SETTINGS_MAIN_MIN_WIDTH = 360;
export const WORKBENCH_NAVIGATION_WIDTH = 248;
export const WORKBENCH_PANE_GAP = 10;
export const WORKBENCH_PANE_INSET = 10;
export const SETTINGS_RAIL_DEFAULT_MIN = 340;
export const SETTINGS_RAIL_DEFAULT_MAX = 400;
export const SETTINGS_RAIL_DEFAULT_RATIO = 0.28;
export const RESIZE_KEYBOARD_STEP = 24;
export const RESIZE_KEYBOARD_LARGE_STEP = 64;

export interface RailWidthBounds {
  min: number;
  max: number;
}

export function clampRailWidth(width: number, bounds: RailWidthBounds): number {
  const min = Math.round(bounds.min);
  const max = Math.max(min, Math.round(bounds.max));
  return Math.min(max, Math.max(min, Math.round(width)));
}

export function parseRailWidthPreference(
  raw: unknown,
  min = SETTINGS_RAIL_MIN_WIDTH,
  max = SETTINGS_RAIL_MAX_WIDTH,
): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return clampRailWidth(raw, { min, max });
}

export function readSettingsRailWidth(): number | null {
  try {
    const raw = localStorage.getItem(SETTINGS_RAIL_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    return parseRailWidthPreference(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeSettingsRailWidth(width: number | null): void {
  try {
    if (width === null) {
      localStorage.removeItem(SETTINGS_RAIL_WIDTH_STORAGE_KEY);
    } else {
      const normalized = parseRailWidthPreference(width);
      if (normalized === null) localStorage.removeItem(SETTINGS_RAIL_WIDTH_STORAGE_KEY);
      else localStorage.setItem(SETTINGS_RAIL_WIDTH_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch {
    // The width still applies in this window if storage is unavailable.
  }
}

export function computeRightRailBounds({
  workbenchWidth,
  leftVisible,
  minWidth = SETTINGS_RAIL_MIN_WIDTH,
  maxWidth = SETTINGS_RAIL_MAX_WIDTH,
  minMainWidth = SETTINGS_MAIN_MIN_WIDTH,
}: {
  workbenchWidth: number;
  leftVisible: boolean;
  minWidth?: number;
  maxWidth?: number;
  minMainWidth?: number;
}): RailWidthBounds {
  const min = Math.round(minWidth);
  const cap = Math.max(min, Math.round(maxWidth));
  const leftOccupied = leftVisible ? WORKBENCH_NAVIGATION_WIDTH + WORKBENCH_PANE_GAP : 0;
  const chrome = WORKBENCH_PANE_INSET * 2 + leftOccupied + WORKBENCH_PANE_GAP;
  const available = Math.max(0, workbenchWidth - chrome);
  const maxByViewport = Math.floor(available - minMainWidth);
  return {
    min,
    max: Math.max(min, Math.min(cap, maxByViewport)),
  };
}

export function defaultSettingsRailWidth(
  workbenchWidth: number,
  bounds: RailWidthBounds,
): number {
  const responsive = Math.min(
    SETTINGS_RAIL_DEFAULT_MAX,
    Math.max(SETTINGS_RAIL_DEFAULT_MIN, Math.round(workbenchWidth * SETTINGS_RAIL_DEFAULT_RATIO)),
  );
  return clampRailWidth(responsive, bounds);
}

export function stepRailWidth(
  currentWidth: number,
  key: string,
  shiftKey: boolean,
  bounds: RailWidthBounds,
  rtl = false,
): number | "reset" | null {
  const step = shiftKey ? RESIZE_KEYBOARD_LARGE_STEP : RESIZE_KEYBOARD_STEP;
  const direction = rtl ? -1 : 1;
  switch (key) {
    case "ArrowLeft":
      return clampRailWidth(currentWidth + step * direction, bounds);
    case "ArrowRight":
      return clampRailWidth(currentWidth - step * direction, bounds);
    case "Home":
      return rtl ? bounds.min : bounds.max;
    case "End":
      return rtl ? bounds.max : bounds.min;
    case "Enter":
      return "reset";
    default:
      return null;
  }
}
