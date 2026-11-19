import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Button, Modal, Switch } from "@heroui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchPlanView, SearchSnapshot, SkillRecord, SkillSnapshot } from "@kulo/protocol";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { kuloRest } from "../../kulo-api";
import { SearchModule, SearchPlanFields, searchPlanDraft, searchPlanDraftDirty } from "./search-module";
import { SkillsModule, SkillSettingsFields, skillDraftDirty } from "./skills-module";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, pending: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
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
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
});
vi.mock("./settings-save-activity", () => ({ useSettingsPending: (pending: boolean) => { hooks.pending = pending; } }));
vi.mock("../../kulo-i18n", () => ({ useI18n: () => ({ t: (zh: string) => zh }), translate: (zh: string) => zh }));
vi.mock("react-aria-components", async (importOriginal) => ({ ...await importOriginal<typeof import("react-aria-components")>(), useDragAndDrop: () => ({ dragAndDropHooks: {} }) }));

const plan: SearchPlanView = { id: "first", name: "Search", adapter: "tavily", enabled: true, baseUrl: "https://mcp.tavily.com/mcp", hasCredential: true, revision: 3, status: "ready", createdAt: 1, updatedAt: 1 };
const searchSnapshot: SearchSnapshot = { revision: 3, plans: [plan] };
const skill: SkillRecord = { id: "one", name: "Skill", description: "", source: "local", sourceUrl: "/fixture", version: "one", enabled: true, audiences: ["chat", "worker"], dependencies: [], diagnostics: [], createdAt: 1, updatedAt: 1 };
const skillSnapshot: SkillSnapshot = { revision: 3, skills: [skill] };
type Node = ReactElement<Record<string, any>>;
function find(tree: ReactNode, predicate: (node: Node) => boolean): Node {
  const walk = (value: ReactNode): Node | undefined => {
    if (Array.isArray(value)) { for (const child of value) { const found = walk(child); if (found) return found; } return; }
    if (!isValidElement<Record<string, any>>(value)) return;
    if (predicate(value)) return value;
    return walk(typeof value.props.children === "function" && value.props.items ? [...value.props.items].map(value.props.children) : value.props.children);
  };
  const found = walk(tree);
  if (!found) throw new Error("Control not found");
  return found;
}
const discard = (tree: ReactNode) => find(tree, (node) => node.type === ConfirmDialog && node.props.title === "放弃未保存的修改？");
const backdrop = (tree: ReactNode) => find(tree, (node) => node.type === Modal.Backdrop);
const editorForm = (tree: ReactNode) => find(tree, (node) => node.type === "form");
function renderSearch() { hooks.cursor = 0; return SearchModule({ snapshot: searchSnapshot, connected: true, onRefresh: vi.fn() }); }
function renderSkills() {
  hooks.cursor = 0;
  const workspace = SkillsModule({ snapshot: skillSnapshot, connected: true, onRefresh: vi.fn() });
  return (workspace.type as (props: unknown) => ReactNode)(workspace.props);
}
function edit(tree: ReactNode, name: string) { find(tree, (node) => node.type === Button && node.props["aria-label"] === `编辑${name}`).props.onPress(); }
function submit(tree: ReactNode) { editorForm(tree).props.onSubmit({ preventDefault() {} }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.pending = false; vi.restoreAllMocks(); vi.stubGlobal("requestAnimationFrame", () => 0); });

afterEach(() => vi.unstubAllGlobals());

describe("manual settings editor drafts", () => {
  it("recognizes edits and reversions without treating audience order as a change", () => {
    expect(searchPlanDraftDirty(undefined)).toBe(false);
    expect(searchPlanDraftDirty(searchPlanDraft())).toBe(false);
    for (const patch of [{ name: "Changed" }, { apiKey: "replacement" }, { enabled: false }, { baseUrl: "https://other.example" }]) {
      expect(searchPlanDraftDirty({ ...searchPlanDraft(plan), ...patch })).toBe(true);
    }
    expect(skillDraftDirty({ ...skill, record: skill, audiences: ["worker", "chat"] })).toBe(false);
    expect(skillDraftDirty({ ...skill, record: skill, audiences: ["worker"] })).toBe(true);
    expect(skillDraftDirty({ ...skill, record: skill, enabled: false })).toBe(true);
  });

  it("protects new search drafts from dismissal and keeps edits after declining discard", () => {
    let tree = renderSearch();
    find(tree, (node) => node.type === Button && node.props.children === "添加搜索方案").props.onPress();
    tree = renderSearch();
    const fields = find(tree, (node) => node.type === SearchPlanFields);
    fields.props.onChange({ ...fields.props.draft, name: "New search" });
    tree = renderSearch();
    backdrop(tree).props.onOpenChange(false);
    tree = renderSearch();
    expect(discard(tree).props.open).toBe(true);
    discard(tree).props.onCancel();
    tree = renderSearch();
    expect(find(tree, (node) => node.type === SearchPlanFields).props.draft.name).toBe("New search");
    backdrop(tree).props.onOpenChange(false);
    discard(renderSearch()).props.onConfirm();
    expect(backdrop(renderSearch()).props.isOpen).toBe(false);
  });

  it("closes unchanged search editors directly and blocks dismissal while saving", async () => {
    let tree = renderSearch(); edit(tree, plan.name);
    backdrop(renderSearch()).props.onOpenChange(false);
    expect(backdrop(renderSearch()).props.isOpen).toBe(false);
    edit(renderSearch(), plan.name);
    tree = renderSearch();
    const fields = find(tree, (node) => node.type === SearchPlanFields);
    fields.props.onChange({ ...fields.props.draft, name: "Changed" });
    const pending = deferred<SearchSnapshot>();
    const save = vi.spyOn(kuloRest, "saveSearchPlan").mockReturnValue(pending.promise);
    tree = renderSearch(); submit(tree);
    backdrop(tree).props.onOpenChange(false);
    expect(backdrop(renderSearch()).props.isOpen).toBe(true);
    expect(discard(renderSearch()).props.open).toBe(false);
    expect(hooks.pending).toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Changed", expectedRevision: 3 }));
    pending.resolve({ ...searchSnapshot, revision: 4 });
    await vi.waitFor(() => expect(backdrop(renderSearch()).props.isOpen).toBe(false));
  });

  it("keeps unsaved search fields out of an independent row toggle", async () => {
    let tree = renderSearch(); edit(tree, plan.name);
    tree = renderSearch();
    const fields = find(tree, (node) => node.type === SearchPlanFields);
    fields.props.onChange({ ...fields.props.draft, name: "Unsaved", apiKey: "unsaved-key" });
    const save = vi.spyOn(kuloRest, "saveSearchPlan").mockResolvedValue({ ...searchSnapshot, revision: 4 });
    tree = renderSearch();
    find(tree, (node) => node.type === Switch && node.props.className === "kulo-search-plan-switch justify-self-center").props.onChange(false);
    expect(save).toHaveBeenCalledWith({ id: plan.id, expectedRevision: plan.revision, name: plan.name, adapter: plan.adapter, baseUrl: plan.baseUrl, enabled: false });
    expect(find(renderSearch(), (node) => node.type === SearchPlanFields).props.draft.name).toBe("Unsaved");
    expect(hooks.pending).toBe(true);
    await vi.waitFor(() => expect(backdrop(renderSearch()).props.isDismissable).toBe(true));
  });

  it("keeps unsaved skill audiences out of an independent row toggle", async () => {
    let tree = renderSkills(); edit(tree, skill.name);
    tree = renderSkills();
    find(tree, (node) => node.type === SkillSettingsFields).props.onChange({ enabled: true, audiences: ["settings"] });
    const save = vi.spyOn(kuloRest, "updateSkill").mockResolvedValue({ ...skillSnapshot, revision: 4 });
    tree = renderSkills();
    find(tree, (node) => node.type === Switch && node.props.size === "sm").props.onChange(false);
    expect(save).toHaveBeenCalledWith(skill.id, { enabled: false, expectedRevision: 3, commandId: expect.any(String) });
    expect(find(renderSkills(), (node) => node.type === SkillSettingsFields).props.value.audiences).toEqual(["settings"]);
    expect(hooks.pending).toBe(true);
    await vi.waitFor(() => expect(backdrop(renderSkills()).props.isDismissable).toBe(true));
  });

  it("preserves skill drafts on failed save, requires discard, and closes after successful submit", async () => {
    let tree = renderSkills(); edit(tree, skill.name);
    tree = renderSkills();
    const fields = find(tree, (node) => node.type === SkillSettingsFields);
    fields.props.onChange({ enabled: false, audiences: ["worker"] });
    const save = vi.spyOn(kuloRest, "updateSkill").mockRejectedValueOnce(new Error("Offline"));
    submit(renderSkills());
    await vi.waitFor(() => expect(backdrop(renderSkills()).props.isDismissable).toBe(true));
    tree = renderSkills();
    expect(find(tree, (node) => node.type === SkillSettingsFields).props.value.audiences).toEqual(["worker"]);
    backdrop(tree).props.onOpenChange(false);
    expect(discard(renderSkills()).props.open).toBe(true);
    discard(renderSkills()).props.onCancel();
    const pending = deferred<SkillSnapshot>(); save.mockReturnValueOnce(pending.promise);
    tree = renderSkills(); submit(tree);
    backdrop(tree).props.onOpenChange(false);
    expect(discard(renderSkills()).props.open).toBe(false);
    expect(backdrop(renderSkills()).props.isOpen).toBe(true);
    expect(hooks.pending).toBe(true);
    pending.resolve({ revision: 4, skills: [{ ...skill, enabled: false, audiences: ["worker"] }] });
    await vi.waitFor(() => expect(backdrop(renderSkills()).props.isOpen).toBe(false));
  });
});
