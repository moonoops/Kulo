import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesModule } from "./capabilities-module";
import { SkillsModule } from "./skills-module";
import { ConfirmDialog } from "../../components/confirm-dialog";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const navigation = vi.hoisted(() => ({ dirty: false, confirmation: false, navigate: vi.fn(), cancel: vi.fn(), discard: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.cells[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || deps.some((value, position) => !Object.is(value, previous.deps[position]))) hooks.cells[index] = { value: factory(), deps };
    return (hooks.cells[index] as { value: unknown }).value;
  };
  return { ...actual,
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.cells[index], (next: unknown) => { hooks.cells[index] = typeof next === "function" ? next(hooks.cells[index]) : next; }];
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void, deps: readonly unknown[]) => memo(() => { hooks.effects.push(effect); }, deps),
  };
});
vi.mock("../../moco-i18n", () => ({ useI18n: () => ({ t: (zh: string) => zh }), translate: (zh: string) => zh }));
vi.mock("./use-settings-navigation", () => ({ useSettingsNavigation: (dirty: boolean) => { navigation.dirty = dirty; return { ...navigation, needsConfirmation: navigation.confirmation }; } }));

type Props = ComponentProps<typeof CapabilitiesModule>;
type Node = ReactElement<Record<string, any>>;
function find(tree: ReactNode, type: unknown): Node {
  const walk = (value: ReactNode): Node | undefined => {
    if (Array.isArray(value)) { for (const child of value) { const found = walk(child); if (found) return found; } return; }
    if (!isValidElement<Record<string, any>>(value)) return;
    return value.type === type ? value : walk(value.props.children);
  };
  const found = walk(tree);
  if (!found) throw new Error("Control not found");
  return found;
}
const changed = vi.fn();
const viewChanged = vi.fn();
const base: Props = { snapshot: null, loading: false, error: null, connected: true, envs: [], view: "skills", onRequest: vi.fn(), onRefresh: vi.fn(), onDirtyChange: changed, onViewChange: viewChanged };
function render(patch: Partial<Props> = {}) {
  hooks.cursor = 0;
  const tree = CapabilitiesModule({ ...base, ...patch });
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
beforeEach(() => {
  hooks.cells = []; hooks.cursor = 0; hooks.effects = [];
  vi.clearAllMocks(); navigation.dirty = false; navigation.confirmation = false;
  navigation.navigate.mockImplementation(() => { navigation.confirmation = navigation.dirty; });
});

describe("capability target navigation", () => {
  it("keeps a same-view target request out of the discard guard and preserves dirty state", () => {
    find(render(), SkillsModule).props.onDirtyChange(true);
    render();
    expect(changed).toHaveBeenLastCalledWith(true);
    const target = { kind: "skill" as const, id: "another-skill" };
    const tree = render({ target });
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(find(tree, ConfirmDialog).props.open).toBe(false);
    expect(navigation.dirty).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(true);
  });

  it("guards a different-view target without applying the view change early", () => {
    find(render(), SkillsModule).props.onDirtyChange(true);
    render();
    const target = { kind: "extension" as const, id: "extension-one" };
    render({ target });
    expect(navigation.navigate).toHaveBeenCalledOnce();
    expect(viewChanged).not.toHaveBeenCalled();
    expect(find(render({ target }), ConfirmDialog).props.open).toBe(true);
    navigation.navigate.mock.calls[0][0]();
    expect(viewChanged).toHaveBeenCalledWith("other");
  });

  it("does not replay an unchanged target after the user changes tabs", () => {
    const target = { kind: "skill" as const, id: "one" };
    render({ target });
    expect(navigation.navigate).not.toHaveBeenCalled();
    render({ target, view: "voice" });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
