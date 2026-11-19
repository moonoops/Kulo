import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transitionSettingsLayout } from "./settings-transition";

const flush = vi.hoisted(() => vi.fn((update: () => void) => update()));
vi.mock("react-dom", () => ({ flushSync: flush }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: { dataset: Record<string, string> };
beforeEach(() => {
  root = { dataset: {} };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: query.includes("min-width") }) });
  flush.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("settings layout transitions", () => {
  it("applies navigation immediately when native view transitions are unavailable", () => {
    const update = vi.fn();
    transitionSettingsLayout("enter", update);
    expect(update).toHaveBeenCalledOnce();
    expect(root.dataset.mocoTransition).toBeUndefined();
  });

  it.each(["system", "attribute", "narrow"])("skips motion for %s while still changing the view", (preference) => {
    const native = vi.fn();
    vi.stubGlobal("document", { documentElement: root, startViewTransition: native });
    vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: query.includes("min-width") ? preference !== "narrow" : preference === "system" }) });
    if (preference === "attribute") root.dataset.reduceMotion = "true";
    const update = vi.fn();
    transitionSettingsLayout("enter", update);
    expect(update).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
  });

  it("commits the destination during capture and releases the transition after finishing", async () => {
    const finished = deferred();
    const native = vi.fn((capture: () => void) => {
      expect(root.dataset.mocoTransition).toBe("enter");
      capture();
      return { ready: Promise.resolve(), finished: finished.promise, skipTransition: vi.fn() };
    });
    vi.stubGlobal("document", { documentElement: root, startViewTransition: native });
    const update = vi.fn();
    transitionSettingsLayout("enter", update);
    expect(update).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(update);
    expect(root.dataset.mocoTransition).toBe("enter");
    finished.resolve();
    await finished.promise;
    expect(root.dataset.mocoTransition).toBeUndefined();
  });

  it("interrupts a previous direction without letting its completion clear the next animation", async () => {
    const first = deferred();
    const second = deferred();
    const skip = vi.fn();
    let captures = 0;
    const native = vi.fn((capture: () => void) => {
      captures++;
      capture();
      return { ready: Promise.resolve(), finished: captures === 1 ? first.promise : second.promise, skipTransition: skip };
    });
    vi.stubGlobal("document", { documentElement: root, startViewTransition: native });
    transitionSettingsLayout("enter", vi.fn());
    transitionSettingsLayout("exit", vi.fn());
    expect(skip).toHaveBeenCalledOnce();
    first.resolve();
    await first.promise;
    expect(root.dataset.mocoTransition).toBe("exit");
    second.resolve();
    await second.promise;
    expect(root.dataset.mocoTransition).toBeUndefined();
  });
});
