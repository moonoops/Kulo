import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAT_REACTION_MS, CAT_SUCCESS_MS, catAppearanceForState, catMotion, createCatAnimationLoop, type CatState,
} from "./cat-motion";
import { CAT_APPEARANCES } from "./cat-catalog";

afterEach(() => vi.useRealTimers());

describe("cat appearance and motion", () => {
  it("keeps all 24 chosen wardrobes while automatic looks follow actual activity", () => {
    for (const appearance of CAT_APPEARANCES) {
      for (const state of ["idle", "thinking", "working", "listening", "speaking", "waiting", "success", "error", "offline"] as const) {
        expect(catAppearanceForState(appearance.id, state)).toBe(appearance.id);
      }
    }
    expect(catAppearanceForState("auto", "working")).toBe("programmer");
    expect(catAppearanceForState("auto", "listening")).toBe("headphones");
    expect(catAppearanceForState("auto", "listening", true)).toBe("closeup");
    expect(catAppearanceForState("auto", "offline")).toBe("sunglasses");
  });

  it("celebrates once and returns to a neutral pose even if success remains selected", () => {
    expect(catMotion("success", 300).frame).toBe(3);
    expect(catMotion("success", CAT_SUCCESS_MS).frame).toBe(0);
    expect(catMotion("success", CAT_SUCCESS_MS + 1000).frame).toBe(0);
  });

  it("does not let reactions override execution, attention, failure or disconnect", () => {
    expect(catMotion("idle", 400, { reactionElapsed: 100 }).frame).toBe(3);
    for (const state of ["thinking", "working", "speaking", "waiting", "success", "error", "offline"] as const) {
      expect(catMotion(state, 400, { reactionElapsed: 100 })).toEqual(catMotion(state, 400));
    }
    expect(catMotion("idle", 400, { reactionElapsed: CAT_REACTION_MS })).toEqual(catMotion("idle", 400));
  });

  it("asks for attention once while idle blinks wait seconds rather than polling", () => {
    expect(catMotion("waiting", 300).frame).toBe(2);
    expect(catMotion("waiting", 1000).frame).toBe(0);
    expect(catMotion("waiting", 4000).frame).toBe(0);
    expect(catMotion("idle", 0)).toEqual({ frame: 0, nextIn: 5200 });
    expect(catMotion("idle", 5200)).toEqual({ frame: 1, nextIn: 110 });
    expect(catMotion("idle", 5310)).toEqual({ frame: 0, nextIn: 190 });
    expect(catMotion("error", 1000)).toEqual({ frame: 0, nextIn: null });
    expect(catMotion("offline", 0)).toEqual({ frame: 0, nextIn: null });
  });

  it("uses the distinct sleeping frames and keeps reduced-motion states entirely still", () => {
    expect(catMotion("idle", 2200, { sleeping: true }).frame).toBe(1);
    expect(catMotion("idle", 4400, { sleeping: true }).frame).toBe(2);
    const states: CatState[] = ["idle", "working", "thinking", "listening", "speaking", "waiting", "error", "offline"];
    for (const state of states) {
      expect(catMotion(state, 0, { reduced: true })).toEqual(catMotion(state, 10000, { reduced: true, reactionElapsed: 20 }));
      expect(catMotion(state, 0, { reduced: true }).nextIn).toBeNull();
    }
  });
});

describe("cat animation lifecycle", () => {
  it("holds no timers while hidden or offscreen, resumes once and cleans up", () => {
    vi.useFakeTimers();
    const render = vi.fn(() => ({ frame: 0 as const, nextIn: 5200 }));
    const loop = createCatAnimationLoop(render);
    expect(vi.getTimerCount()).toBe(0);
    loop.setActive(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(render).toHaveBeenCalledTimes(1);
    loop.setActive(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(render).toHaveBeenCalledTimes(1);
    loop.setActive(true);
    expect(render).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    loop.dispose();
    expect(vi.getTimerCount()).toBe(0);
    loop.wake(); loop.setActive(true);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("finishes one-shot animations without leaving a polling timer", () => {
    vi.useFakeTimers();
    let elapsed = 0;
    const render = vi.fn(() => catMotion("error", elapsed));
    const loop = createCatAnimationLoop(render);
    loop.setActive(true);
    elapsed = 700;
    vi.advanceTimersByTime(700);
    expect(render).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    loop.dispose();
  });
});
