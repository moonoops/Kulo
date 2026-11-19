import { describe, expect, it } from "vitest";
import { composerEnterAction, insertComposerNewline } from "./composer-keyboard";

const enter = { key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

describe("composer keyboard actions", () => {
  it.each(["MacIntel", "MacIntel Apple Silicon", "iPad"])("inserts a newline with Option+Enter on %s", (platform) => {
    expect(composerEnterAction({ ...enter, altKey: true }, platform)).toBe("newline");
  });
  it.each(["Win32", "Windows", "Linux x86_64", "Linux"])("inserts a newline with Control+Enter on %s", (platform) => {
    expect(composerEnterAction({ ...enter, ctrlKey: true }, platform)).toBe("newline");
  });
  it.each(["MacIntel", "Win32", "Linux x86_64"])("keeps plain Enter for sending and Shift+Enter for newlines on %s", (platform) => {
    expect(composerEnterAction(enter, platform)).toBe("send");
    expect(composerEnterAction({ ...enter, shiftKey: true }, platform)).toBe("newline");
  });
  it("does not turn unrelated modified Enter keys into sends", () => {
    expect(composerEnterAction({ ...enter, metaKey: true }, "MacIntel")).toBeUndefined();
    expect(composerEnterAction({ ...enter, ctrlKey: true }, "MacIntel")).toBeUndefined();
    expect(composerEnterAction({ ...enter, altKey: true }, "Win32")).toBeUndefined();
    expect(composerEnterAction({ ...enter, key: "a" }, "Linux")).toBeUndefined();
  });
  it("inserts at the caret or replaces a selection without losing the remaining draft", () => {
    expect(insertComposerNewline("第一行第二行", 3, 3)).toEqual({ text: "第一行\n第二行", caret: 4 });
    expect(insertComposerNewline("第一行替换第二行", 3, 5)).toEqual({ text: "第一行\n第二行", caret: 4 });
    expect(insertComposerNewline("", 0, 0)).toEqual({ text: "\n", caret: 1 });
  });
});
