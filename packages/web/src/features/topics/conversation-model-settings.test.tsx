import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Select } from "@heroui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorSlotsConfig, KuloSettingsView } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { ConversationModelSettings } from "./conversation-model-settings";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
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
    useMemo: (factory: () => unknown) => factory(),
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
vi.mock("../../kulo-i18n", () => ({ useI18n: () => ({ t: (zh: string) => zh, language: "zh" }) }));
vi.mock("../settings/use-provider-catalog", () => ({
  useProviderCatalog: () => ({ providers: [], loading: false, error: undefined, refresh: vi.fn() }),
}));
vi.mock("../settings/model-selection-fields", () => ({ ModelSelectionFields: () => null }));

const baseExecutor: ExecutorSlotsConfig = {
  maxConcurrentWorkers: 3,
  maxSubagentsPerTicket: 4,
  paused: false,
  watchdogMinutes: 5,
  completedTaskDisplayHours: 3,
  autoArchiveEnabled: true,
  autoArchiveDays: 7,
  hostActionPermission: "ask",
};

function makeSettings(executor: ExecutorSlotsConfig = baseExecutor, rev = 2): KuloSettingsView {
  return {
    globalRevision: rev,
    blocks: {
      executor: { revision: rev, value: executor },
      model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "medium" } },
    },
  } as unknown as KuloSettingsView;
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

describe("ConversationModelSettings execution permission selector", () => {
  beforeEach(() => {
    hooks.cells = [];
    hooks.cursor = 0;
    hooks.effects = [];
    vi.restoreAllMocks();
  });

  it("renders '需要授权' by default and saves 'always' to the executor settings block", async () => {
    let current = makeSettings();
    const onUpdated = vi.fn((next: KuloSettingsView) => { current = next; });
    const saveSpy = vi.spyOn(kuloRest, "saveSettingsBlock").mockImplementation(async (_block, rev, value) => ({
      settings: makeSettings(value as ExecutorSlotsConfig, rev + 1),
      summary: "saved",
    }));

    const render = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      const tree = ConversationModelSettings({
        settings: current,
        onSettingsUpdated: onUpdated,
        showProcess: true,
        onShowProcessChange: vi.fn(),
      });
      for (const effect of hooks.effects) effect();
      return findElements<ComponentProps<typeof Select>>(tree, Select)[0]!;
    };

    const select = render();
    expect(select.props.value).toBe("ask");
    expect(select.props["aria-label"]).toBe("执行权限");

    select.props.onChange?.("always");
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(saveSpy).toHaveBeenCalledWith("executor", 2, {
      ...baseExecutor,
      hostActionPermission: "always",
    });
    expect(render().props.value).toBe("always");
  });
});
