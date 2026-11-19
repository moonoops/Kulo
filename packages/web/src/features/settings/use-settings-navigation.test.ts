import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsSaveActivity } from "./settings-save-activity";
import { useSettingsNavigation } from "./use-settings-navigation";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [hooks.cells[index], (next: unknown) => { hooks.cells[index] = next; }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
    return hooks.cells[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(() => { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); }); },
}));

function render(dirty = false, active = true) {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  hooks.cursor = 0;
  const result = useSettingsNavigation(dirty, active);
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
const first = Symbol("first writer");
const second = Symbol("second writer");
beforeEach(() => {
  hooks.cells = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = [];
  settingsSaveActivity.setPending(first, false);
  settingsSaveActivity.setPending(second, false);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  settingsSaveActivity.setPending(first, false);
  settingsSaveActivity.setPending(second, false);
  vi.useRealTimers();
});

describe("settings navigation during writes", () => {
  it("waits for a blur save and reevaluates cleared dirty state before navigating", () => {
    settingsSaveActivity.setPending(first, true);
    const action = vi.fn();
    render(true).navigate(action);
    render(true);
    vi.runAllTimers();
    expect(action).not.toHaveBeenCalled();
    settingsSaveActivity.setPending(first, false);
    render(false);
    vi.runAllTimers();
    expect(action).toHaveBeenCalledOnce();
    expect(render(false).needsConfirmation).toBe(false);
  });

  it("keeps failed edits behind confirmation and supports continuing or discarding", () => {
    const action = vi.fn(); const cancelled = vi.fn();
    settingsSaveActivity.setPending(first, true);
    render(true).navigate(action, cancelled);
    render(true);
    settingsSaveActivity.setPending(first, false);
    render(true);
    vi.runAllTimers();
    const guard = render(true);
    expect(guard.needsConfirmation).toBe(true);
    guard.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    render(true).navigate(action);
    render(true);
    vi.runAllTimers();
    render(true).discard();
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not leave while another independent writer is still pending", () => {
    const action = vi.fn();
    settingsSaveActivity.setPending(first, true);
    settingsSaveActivity.setPending(second, true);
    render().navigate(action);
    render();
    settingsSaveActivity.setPending(first, false);
    render(); vi.runAllTimers();
    expect(action).not.toHaveBeenCalled();
    settingsSaveActivity.setPending(second, false);
    render(); vi.runAllTimers();
    expect(action).toHaveBeenCalledOnce();
  });

  it("cancels superseded requests both while waiting and while confirming", () => {
    const cancelled = vi.fn(); const nextCancelled = vi.fn(); const action = vi.fn();
    render(true).navigate(vi.fn(), cancelled);
    render(true).navigate(vi.fn(), nextCancelled);
    expect(cancelled).toHaveBeenCalledOnce();
    render(true); vi.runAllTimers();
    render(true).navigate(action);
    expect(nextCancelled).toHaveBeenCalledOnce();
    render(false); vi.runAllTimers();
    expect(action).toHaveBeenCalledOnce();
  });
});
