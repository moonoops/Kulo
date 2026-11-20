import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Button, Select, Switch } from "@heroui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorSlotsConfig, KuloSettingsView } from "@kulo/protocol";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { ConcurrencyModule } from "./concurrency-module";
import { SettingsNumberField } from "./settings-layout";

// Exercise the component's event handlers and async state without a browser or real settings writes.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, pending: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = typeof value === "function" ? value(hooks.cells[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[] = []) => {
      const index = hooks.cursor++;
      const previous = hooks.cells[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || dependencies.some((value, key) => !Object.is(value, previous.dependencies[key]))) {
        hooks.effects.push(() => {
          previous?.cleanup?.();
          hooks.cells[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
});
vi.mock("../../kulo-i18n", () => ({ useI18n: () => ({ t: (zh: string) => zh }) }));
vi.mock("./settings-save-activity", () => ({ useSettingsPending: (pending: boolean) => { hooks.pending = pending; } }));

const initialValue: ExecutorSlotsConfig = {
  maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5,
  completedTaskDisplayHours: 3, autoArchiveEnabled: true, autoArchiveDays: 7,
};
function settings(revision = 1, value = initialValue): KuloSettingsView {
  return { globalRevision: revision, blocks: { executor: { revision, value } } } as KuloSettingsView;
}
function findElements<P>(tree: ReactNode, type: unknown): ReactElement<P>[] {
  const results: ReactElement<P>[] = [];
  function visit(value: ReactNode) {
    for (const node of Array.isArray(value) ? value : [value]) {
      if (Array.isArray(node)) { visit(node); continue; }
      if (!isValidElement<{ children?: ReactNode }>(node)) continue;
      if (node.type === type) results.push(node as ReactElement<P>);
      visit(node.props.children);
    }
  }
  visit(tree);
  return results;
}
function page() {
  let current = settings();
  const onUpdated = vi.fn((next: KuloSettingsView) => { current = next; });
  const onDirty = vi.fn();
  function render() {
    hooks.cursor = 0;
    hooks.effects = [];
    const tree = ConcurrencyModule({ settings: current, onSettingsUpdated: onUpdated, onDirtyChange: onDirty });
    for (const effect of hooks.effects) effect();
    return {
      numbers: findElements<ComponentProps<typeof SettingsNumberField>>(tree, SettingsNumberField),
      switches: findElements<ComponentProps<typeof Switch>>(tree, Switch),
      select: findElements<ComponentProps<typeof Select>>(tree, Select)[0]!,
      selectCount: findElements<ComponentProps<typeof Select>>(tree, Select).length,
      button: (label: string) => {
        const result = findElements<ComponentProps<typeof Button>>(tree, Button).find((button) => button.props.children === label);
        if (!result) throw new Error(`Missing button: ${label}`);
        return result;
      },
    };
  }
  return { render, onUpdated, onDirty, current: () => current };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function mockSaves() {
  return vi.spyOn(kuloRest, "saveSettingsBlock").mockImplementation(async (_key, revision, value) => ({
    settings: settings(revision + 1, value as ExecutorSlotsConfig), summary: "saved",
  }));
}

beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.pending = false;
  vi.restoreAllMocks();
});

describe("runtime preferences autosave", () => {
  it("keeps numeric input local until completion and leaves other drafts out of every write", async () => {
    const save = mockSaves();
    const view = page();
    let controls = view.render();
    controls.numbers[0]!.props.onChange(6);
    controls.numbers[2]!.props.onChange(12);
    controls = view.render();
    expect(save).not.toHaveBeenCalled();
    expect(view.onDirty).toHaveBeenLastCalledWith(true);

    controls.switches[0]!.props.onChange?.(false);
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]).toEqual(["executor", 1, { ...initialValue, paused: true }]);
    controls = view.render();
    expect(controls.numbers[0]!.props.value).toBe(6);
    expect(controls.numbers[2]!.props.value).toBe(12);
    await controls.numbers[0]!.props.onCommit(6);
    expect(save.mock.calls[1]).toEqual(["executor", 2, { ...initialValue, paused: true, maxConcurrentWorkers: 6 }]);
    controls = view.render();
    expect(view.onDirty).toHaveBeenLastCalledWith(true);
    await controls.numbers[2]!.props.onCommit(12);
    expect(save.mock.calls[2]).toEqual(["executor", 3, { ...initialValue, paused: true, maxConcurrentWorkers: 6, watchdogMinutes: 12 }]);
    view.render();
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
  });

  it("immediately saves a discrete choice and preserves its pending display", async () => {
    const request = deferred<Awaited<ReturnType<typeof kuloRest.saveSettingsBlock>>>();
    const save = vi.spyOn(kuloRest, "saveSettingsBlock").mockReturnValue(request.promise);
    const view = page();
    view.render().select.props.onChange?.("6");
    const controls = view.render();
    expect(hooks.pending).toBe(true);
    expect(controls.select.props.value).toBe("6");
    expect(controls.select.props.isDisabled).toBe(true);
    expect(controls.switches[0]!.props.isDisabled).toBe(false);
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("executor", 1, { ...initialValue, completedTaskDisplayHours: 6 }));
    request.resolve({ settings: settings(2, { ...initialValue, completedTaskDisplayHours: 6 }), summary: "saved" });
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledOnce());
    expect(view.render().select.props.value).toBe("6");
    expect(hooks.pending).toBe(false);
  });

  it("queues rapid independent switches with the latest saved revision", async () => {
    const first = deferred<Awaited<ReturnType<typeof kuloRest.saveSettingsBlock>>>();
    const save = vi.spyOn(kuloRest, "saveSettingsBlock")
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (_key, revision, value) => ({ settings: settings(revision + 1, value as ExecutorSlotsConfig), summary: "saved" }));
    const view = page();
    const controls = view.render();
    controls.switches[0]!.props.onChange?.(false);
    controls.switches[1]!.props.onChange?.(false);
    const pendingControls = view.render();
    expect(pendingControls.numbers[0]!.props.isPending).toBe(false);
    expect(pendingControls.switches.every((control) => control.props.isReadOnly)).toBe(true);
    expect(pendingControls.switches.every((control) => !control.props.isDisabled)).toBe(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    first.resolve({ settings: settings(2, { ...initialValue, paused: true }), summary: "saved" });
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]).toEqual(["executor", 2, { ...initialValue, paused: true, autoArchiveEnabled: false }]);
    expect(view.render().numbers).toHaveLength(3);
    expect(hooks.pending).toBe(false);
  });

  it("retains a failed number, blocks duplicate completion events, and offers a retry", async () => {
    const save = vi.spyOn(kuloRest, "saveSettingsBlock")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockImplementation(async (_key, revision, value) => ({ settings: settings(revision + 1, value as ExecutorSlotsConfig), summary: "saved" }));
    const view = page();
    view.render().numbers[0]!.props.onChange(6);
    let controls = view.render();
    await Promise.all([controls.numbers[0]!.props.onCommit(6), controls.numbers[0]!.props.onCommit(6)]);
    expect(save).toHaveBeenCalledOnce();
    controls = view.render();
    expect(controls.numbers[0]!.props.value).toBe(6);
    expect(controls.numbers[0]!.props.isPending).toBe(false);
    expect(view.onDirty).toHaveBeenLastCalledWith(true);
    await controls.numbers[0]!.props.onCommit(6); // Blurring the failed input must not retry before the button press.
    controls = view.render();
    expect(save).toHaveBeenCalledOnce();
    controls.button("重试").props.onPress?.({} as never);
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledOnce());
    expect(view.render().numbers[0]!.props.value).toBe(6);
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
  });

  it("rolls back a failed switch and cancels its interval draft only after a successful close", async () => {
    const save = vi.spyOn(kuloRest, "saveSettingsBlock")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockImplementation(async (_key, revision, value) => ({ settings: settings(revision + 1, value as ExecutorSlotsConfig), summary: "saved" }));
    const view = page();
    view.render().numbers[3]!.props.onChange(9);
    let controls = view.render();
    controls.switches[1]!.props.onChange?.(false);
    expect(view.render().switches[1]!.props.isSelected).toBe(false);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await Promise.resolve();
    controls = view.render();
    expect(controls.switches[1]!.props.isSelected).toBe(true);
    expect(controls.numbers[3]!.props.value).toBe(9);
    expect(view.onDirty).toHaveBeenLastCalledWith(true);
    controls.button("重试").props.onPress?.({} as never);
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledOnce());
    expect(save.mock.calls[1]).toEqual(["executor", 1, { ...initialValue, autoArchiveEnabled: false }]);
    expect(view.render().numbers).toHaveLength(3);
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
  });

  it("requires loading and explicit retry after a 409, preserving numeric drafts", async () => {
    const save = vi.spyOn(kuloRest, "saveSettingsBlock")
      .mockRejectedValueOnce(new KuloApiError(409, "Changed elsewhere"))
      .mockImplementation(async (_key, revision, value) => ({ settings: settings(revision + 1, value as ExecutorSlotsConfig), summary: "saved" }));
    const get = vi.spyOn(kuloRest, "getSettings").mockResolvedValue(settings(4, { ...initialValue, maxConcurrentWorkers: 8, autoArchiveDays: 30 }));
    const view = page();
    let controls = view.render();
    controls.numbers[0]!.props.onChange(6);
    controls.numbers[2]!.props.onChange(9);
    controls = view.render();
    await controls.numbers[0]!.props.onCommit(6);
    controls = view.render();
    expect(controls.switches[0]!.props.isDisabled).toBe(true);
    controls.button("加载最新版本").props.onPress?.({} as never);
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledOnce());
    controls = view.render();
    expect(get).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(controls.numbers[0]!.props.value).toBe(6);
    expect(controls.numbers[2]!.props.value).toBe(9);
    controls.button("重试").props.onPress?.({} as never);
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]).toEqual(["executor", 4, { ...initialValue, maxConcurrentWorkers: 6, autoArchiveDays: 30 }]);
    controls = view.render();
    await controls.numbers[2]!.props.onCommit(9);
    expect(save.mock.calls[2]).toEqual(["executor", 5, { ...initialValue, maxConcurrentWorkers: 6, autoArchiveDays: 30, watchdogMinutes: 9 }]);
  });

  it("loads the latest settings on the first press when a conflicted Enter save is followed by blur", async () => {
    const save = vi.spyOn(kuloRest, "saveSettingsBlock").mockRejectedValue(new KuloApiError(409, "Changed elsewhere"));
    const get = vi.spyOn(kuloRest, "getSettings").mockResolvedValue(settings(4, { ...initialValue, maxConcurrentWorkers: 8 }));
    const view = page();
    view.render().numbers[0]!.props.onChange(6);
    let controls = view.render();
    await controls.numbers[0]!.props.onCommit(6); // Enter leaves focus in the number input.
    controls = view.render();
    const blur = controls.numbers[0]!.props.onCommit(6); // Moving to the reload button blurs it first.
    controls = view.render();
    controls.button("加载最新版本").props.onPress?.({} as never);
    expect(get).toHaveBeenCalledOnce();
    await blur;
    await vi.waitFor(() => expect(view.onUpdated).toHaveBeenCalledOnce());
    controls = view.render();
    expect(save).toHaveBeenCalledOnce();
    expect(controls.numbers[0]!.props.value).toBe(6);
    expect(controls.numbers[0]!.props.isPending).toBe(false);
    expect(view.onDirty).toHaveBeenLastCalledWith(true);
  });

  it("keeps invalid numeric drafts for correction without sending them", async () => {
    const save = mockSaves();
    const view = page();
    view.render().numbers[0]!.props.onChange(NaN);
    let controls = view.render();
    await controls.numbers[0]!.props.onCommit(NaN);
    expect(controls.numbers[0]!.props.value).toBeNaN();
    expect(controls.numbers[0]!.props.isInvalid).toBe(true);
    expect(view.onDirty).toHaveBeenLastCalledWith(true);
    expect(save).not.toHaveBeenCalled();
    controls.numbers[0]!.props.onChange(0);
    controls = view.render();
    await controls.numbers[0]!.props.onCommit(0);
    expect(save).not.toHaveBeenCalled();
    controls.numbers[0]!.props.onChange(3);
    view.render();
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
  });

  it("omits the deprecated hostActionPermission selector from ConcurrencyModule", () => {
    const view = page();
    expect(view.render().selectCount).toBe(1);
  });
});
