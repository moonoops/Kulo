import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampRailWidth,
  computeRightRailBounds,
  defaultSettingsRailWidth,
  parseRailWidthPreference,
  readSettingsRailWidth,
  RESIZE_KEYBOARD_LARGE_STEP,
  RESIZE_KEYBOARD_STEP,
  SETTINGS_RAIL_MAX_WIDTH,
  SETTINGS_RAIL_MIN_WIDTH,
  SETTINGS_RAIL_WIDTH_STORAGE_KEY,
  stepRailWidth,
  writeSettingsRailWidth,
} from "./workbench-rail-resize";

afterEach(() => vi.unstubAllGlobals());

describe("settings right rail resize math", () => {
  it("computes bounds that preserve minimum main width while allowing wide panels", () => {
    expect(computeRightRailBounds({ workbenchWidth: 1060, leftVisible: true })).toEqual({ min: 320, max: 412 });
    expect(computeRightRailBounds({ workbenchWidth: 1060, leftVisible: false })).toEqual({ min: 320, max: 670 });
    expect(computeRightRailBounds({ workbenchWidth: 1440, leftVisible: true })).toEqual({ min: 320, max: 792 });
    expect(computeRightRailBounds({ workbenchWidth: 1440, leftVisible: false })).toEqual({ min: 320, max: SETTINGS_RAIL_MAX_WIDTH });
    expect(computeRightRailBounds({ workbenchWidth: 1920, leftVisible: true })).toEqual({ min: 320, max: SETTINGS_RAIL_MAX_WIDTH });
    expect(computeRightRailBounds({ workbenchWidth: 600, leftVisible: true })).toEqual({ min: 320, max: 320 });
  });

  it("matches the responsive default width formula and clamps to bounds", () => {
    expect(defaultSettingsRailWidth(1060, { min: 320, max: 412 })).toBe(340);
    expect(defaultSettingsRailWidth(1280, { min: 320, max: 632 })).toBe(358);
    expect(defaultSettingsRailWidth(1600, { min: 320, max: 912 })).toBe(400);
    expect(defaultSettingsRailWidth(1600, { min: 320, max: 350 })).toBe(350);
  });

  it("validates and clamps persisted width preferences", () => {
    expect(parseRailWidthPreference(560.4)).toBe(560);
    expect(parseRailWidthPreference(120)).toBe(SETTINGS_RAIL_MIN_WIDTH);
    expect(parseRailWidthPreference(2400)).toBe(SETTINGS_RAIL_MAX_WIDTH);
    for (const invalid of [null, undefined, "", "500", 0, -200, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(parseRailWidthPreference(invalid)).toBeNull();
    }
  });

  it("handles keyboard resize steps in LTR and RTL and resets on Enter", () => {
    const bounds = { min: 320, max: 792 };
    expect(stepRailWidth(400, "ArrowLeft", false, bounds)).toBe(400 + RESIZE_KEYBOARD_STEP);
    expect(stepRailWidth(400, "ArrowLeft", true, bounds)).toBe(400 + RESIZE_KEYBOARD_LARGE_STEP);
    expect(stepRailWidth(400, "ArrowRight", false, bounds)).toBe(400 - RESIZE_KEYBOARD_STEP);
    expect(stepRailWidth(400, "ArrowRight", true, bounds)).toBe(400 - RESIZE_KEYBOARD_LARGE_STEP);
    expect(stepRailWidth(400, "Home", false, bounds)).toBe(792);
    expect(stepRailWidth(400, "End", false, bounds)).toBe(320);
    expect(stepRailWidth(400, "Enter", false, bounds)).toBe("reset");
    expect(stepRailWidth(400, "Escape", false, bounds)).toBeNull();

    // RTL flips left/right direction
    expect(stepRailWidth(400, "ArrowLeft", false, bounds, true)).toBe(400 - RESIZE_KEYBOARD_STEP);
    expect(stepRailWidth(400, "ArrowRight", false, bounds, true)).toBe(400 + RESIZE_KEYBOARD_STEP);
    expect(stepRailWidth(400, "Home", false, bounds, true)).toBe(320);
    expect(stepRailWidth(400, "End", false, bounds, true)).toBe(792);
  });

  it("clamps arbitrary widths safely", () => {
    expect(clampRailWidth(500.6, { min: 320, max: 700 })).toBe(501);
    expect(clampRailWidth(100, { min: 320, max: 700 })).toBe(320);
    expect(clampRailWidth(900, { min: 320, max: 700 })).toBe(700);
  });

  it("persists, clears, and tolerates broken localStorage cleanly", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });

    expect(readSettingsRailWidth()).toBeNull();
    writeSettingsRailWidth(640);
    expect(store.get(SETTINGS_RAIL_WIDTH_STORAGE_KEY)).toBe("640");
    expect(readSettingsRailWidth()).toBe(640);

    writeSettingsRailWidth(null);
    expect(store.has(SETTINGS_RAIL_WIDTH_STORAGE_KEY)).toBe(false);
    expect(readSettingsRailWidth()).toBeNull();

    store.set(SETTINGS_RAIL_WIDTH_STORAGE_KEY, "not-json{");
    expect(readSettingsRailWidth()).toBeNull();

    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => { throw new Error("storage blocked"); },
      removeItem: () => { throw new Error("storage blocked"); },
    });
    expect(readSettingsRailWidth()).toBeNull();
    expect(() => writeSettingsRailWidth(500)).not.toThrow();
    expect(() => writeSettingsRailWidth(null)).not.toThrow();
  });
});
