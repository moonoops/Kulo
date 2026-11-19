import { describe, expect, it } from "vitest";
import {
  isComposingKeyboardEvent,
  isMacShortcutPlatform,
  resolveKeyboardShortcut,
  type ShortcutKeyLike,
} from "./shortcuts";

const base: ShortcutKeyLike = {
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

describe("keyboard shortcut resolution", () => {
  it("resolves browser-safe shortcuts on macOS and non-macOS platforms", () => {
    expect(isMacShortcutPlatform("MacIntel")).toBe(true);
    expect(isMacShortcutPlatform("Win32")).toBe(false);

    expect(resolveKeyboardShortcut({ ...base, key: "k", metaKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("search-conversations");
    expect(resolveKeyboardShortcut({ ...base, key: "f", metaKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("find-in-conversation");
    expect(resolveKeyboardShortcut({ ...base, key: "\\", code: "Backslash", metaKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("toggle-left-panel");
    expect(resolveKeyboardShortcut({ ...base, key: "|", code: "Backslash", metaKey: true, shiftKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("toggle-right-panel");
    expect(resolveKeyboardShortcut({ ...base, key: ".", code: "Period", metaKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("stop-generation");
    expect(resolveKeyboardShortcut({ ...base, key: "C", metaKey: true, shiftKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("copy-last-reply");
    expect(resolveKeyboardShortcut({ ...base, key: "s", metaKey: true }, { platform: "MacIntel", desktopManaged: false })).toBe("save-active");

    // Windows / Linux use Ctrl instead of Meta.
    expect(resolveKeyboardShortcut({ ...base, key: "k", ctrlKey: true }, { platform: "Win32", desktopManaged: false })).toBe("search-conversations");
    expect(resolveKeyboardShortcut({ ...base, key: "k", metaKey: true }, { platform: "Win32", desktopManaged: false })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "k", ctrlKey: true }, { platform: "MacIntel", desktopManaged: false })).toBeUndefined();
  });

  it("never hijacks browser-reserved shortcuts when running outside Electron", () => {
    for (const key of ["w", "n", ",", "1", "r", "t"]) {
      expect(resolveKeyboardShortcut({ ...base, key, metaKey: true }, { platform: "MacIntel", desktopManaged: false })).toBeUndefined();
    }
  });

  it("defers menu-owned shortcuts to Electron main menu when desktopManaged is true while keeping Escape active", () => {
    expect(resolveKeyboardShortcut({ ...base, key: "k", metaKey: true }, { platform: "MacIntel", desktopManaged: true })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "f", metaKey: true }, { platform: "MacIntel", desktopManaged: true })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "\\", code: "Backslash", metaKey: true }, { platform: "MacIntel", desktopManaged: true })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "s", metaKey: true }, { platform: "MacIntel", desktopManaged: true })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "Escape" }, { platform: "MacIntel", desktopManaged: true })).toBe("escape-layer");
    expect(resolveKeyboardShortcut({ ...base, key: "Escape" }, { platform: "Win32", desktopManaged: false })).toBe("escape-layer");
  });

  it("ignores already-handled events and IME composition keystrokes", () => {
    expect(isComposingKeyboardEvent({ isComposing: true })).toBe(true);
    expect(isComposingKeyboardEvent({ keyCode: 229 })).toBe(true);
    expect(isComposingKeyboardEvent({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(resolveKeyboardShortcut({ ...base, key: "Escape", isComposing: true }, { platform: "MacIntel", desktopManaged: false })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "Escape", keyCode: 229 }, { platform: "MacIntel", desktopManaged: false })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "Escape", defaultPrevented: true }, { platform: "MacIntel", desktopManaged: false })).toBeUndefined();
    expect(resolveKeyboardShortcut({ ...base, key: "k", metaKey: true, defaultPrevented: true }, { platform: "MacIntel", desktopManaged: false })).toBeUndefined();
  });
});
