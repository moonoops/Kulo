import { describe, expect, it, vi } from "vitest";
import { createSettingsSaveActivity } from "./settings-save-activity";

describe("settings save activity", () => {
  it("waits for all independent writers rather than clearing on the first completion", () => {
    const activity = createSettingsSaveActivity();
    const changed = vi.fn();
    const unsubscribe = activity.subscribe(changed);
    const first = Symbol();
    const second = Symbol();
    activity.setPending(first, true);
    activity.setPending(second, true);
    activity.setPending(first, false);
    expect(activity.getSnapshot()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    activity.setPending(second, false);
    expect(activity.getSnapshot()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not duplicate a pending writer on rerender and releases it on cleanup", () => {
    const activity = createSettingsSaveActivity();
    const key = Symbol();
    const changed = vi.fn();
    activity.subscribe(changed);
    activity.setPending(key, true);
    activity.setPending(key, true);
    activity.setPending(key, false);
    activity.setPending(key, false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(activity.getSnapshot()).toBe(false);
    expect(activity.getServerSnapshot()).toBe(false);
  });
});
