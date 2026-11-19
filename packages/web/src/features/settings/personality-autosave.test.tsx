import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Button, Input, Tabs, TextField } from "@heroui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type MocoSettingsView, type PersonalitySnapshot } from "@moco/protocol";
import { MocoApiError, mocoRest } from "../../moco-api";
import { IdentityModule } from "./identity-module";
import { usePersonalityControls } from "./personality-controls";

// This harness exercises async hook transitions without a browser or real configuration writes.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, pending: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.cells[index], (value: unknown) => {
        hooks.cells[index] = typeof value === "function" ? value(hooks.cells[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
  };
});
vi.mock("../../moco-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../moco-i18n")>();
  return { ...actual, useI18n: () => ({ t: (zh: string) => zh }), translate: (zh: string) => zh };
});
vi.mock("./settings-save-activity", () => ({ useSettingsPending: (pending: boolean) => { hooks.pending = pending; } }));

function renderHook() {
  hooks.cursor = 0;
  return usePersonalityControls();
}

function personality(revision = 1, enabled = true, intervalDays = 1, recentWorkEnabled = true): PersonalitySnapshot {
  return {
    revision, settings: { relationshipUpdate: { enabled, intervalDays }, recentWorkEnabled },
    relationshipStatus: { lastCheckedAt: null, lastUpdatedAt: null, nextRunAt: null, lastResult: "never" },
    identityProposal: null,
  };
}

async function loadPersonality(value = personality()) {
  vi.spyOn(mocoRest, "getPersonality").mockResolvedValue(value);
  await renderHook().refresh();
  return renderHook();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  hooks.pending = false;
  vi.restoreAllMocks();
});

describe("independent personality preferences", () => {
  it("keeps an interval draft out of the recent-work write, then uses the returned shared revision", async () => {
    let controls = await loadPersonality();
    controls.setSchedule({ enabled: true, intervalDays: 8 });
    controls = renderHook();
    const save = vi.spyOn(mocoRest, "savePersonalitySettings")
      .mockResolvedValueOnce(personality(2, true, 1, false))
      .mockResolvedValueOnce(personality(3, true, 8, false));
    await controls.setRecentEnabled(false);
    controls = renderHook();
    expect(save.mock.calls[0][0]).toEqual({ expectedRevision: 1, relationshipUpdate: { enabled: true, intervalDays: 1 }, recentWorkEnabled: false });
    expect(controls.schedule.intervalDays).toBe(8);
    expect(controls.dirty).toBe(true);
    await controls.saveSchedule();
    expect(save.mock.calls[1][0]).toEqual({ expectedRevision: 2, relationshipUpdate: { enabled: true, intervalDays: 8 }, recentWorkEnabled: false });
    expect(renderHook().dirty).toBe(false);
  });

  it("blocks concurrent writes and changes a switch only after its write succeeds", async () => {
    let controls = await loadPersonality();
    const pending = deferred<PersonalitySnapshot>();
    const save = vi.spyOn(mocoRest, "savePersonalitySettings").mockReturnValue(pending.promise);
    const request = controls.setRecentEnabled(false);
    controls = renderHook();
    expect(controls.saving).toBe(true);
    expect(controls.savingField).toBe("recentWorkEnabled");
    expect(controls.snapshot?.settings.recentWorkEnabled).toBe(true);
    expect(await controls.setRelationshipEnabled(false)).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    pending.resolve(personality(2, true, 1, false));
    await request;
    controls = renderHook();
    expect(controls.saving).toBe(false);
    expect(controls.snapshot?.settings.recentWorkEnabled).toBe(false);
  });

  it("preserves a failed switch and interval input until a successful close clears the hidden draft", async () => {
    let controls = await loadPersonality();
    controls.setSchedule({ enabled: true, intervalDays: 9 });
    controls = renderHook();
    const save = vi.spyOn(mocoRest, "savePersonalitySettings")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(personality(2, false, 1));
    expect(await controls.setRelationshipEnabled(false)).toBe(false);
    controls = renderHook();
    expect(controls.snapshot?.settings.relationshipUpdate.enabled).toBe(true);
    expect(controls.schedule.intervalDays).toBe(9);
    expect(controls.dirty).toBe(true);
    expect(controls.error).toBe("Offline");
    await controls.retryRelationship();
    controls = renderHook();
    expect(save.mock.calls[1][0].relationshipUpdate).toEqual({ enabled: false, intervalDays: 1 });
    expect(controls.schedule).toEqual({ enabled: false, intervalDays: 1 });
    expect(controls.dirty).toBe(false);
    expect(controls.error).toBeUndefined();
  });

  it("retains invalid interval input for correction without sending it", async () => {
    let controls = await loadPersonality();
    const save = vi.spyOn(mocoRest, "savePersonalitySettings");
    controls.setSchedule({ enabled: true, intervalDays: NaN });
    controls = renderHook();
    expect(await controls.saveSchedule()).toBe(false);
    controls = renderHook();
    expect(save).not.toHaveBeenCalled();
    expect(controls.schedule.intervalDays).toBeNaN();
    expect(controls.dirty).toBe(true);
    expect(controls.error).toContain("1至365");
  });

  it("refreshes a 409 base and requires explicit retry before replacing the interval", async () => {
    let controls = await loadPersonality();
    controls.setSchedule({ enabled: true, intervalDays: 9 });
    controls = renderHook();
    vi.mocked(mocoRest.getPersonality).mockResolvedValue(personality(4, true, 3, false));
    const save = vi.spyOn(mocoRest, "savePersonalitySettings")
      .mockRejectedValueOnce(new MocoApiError(409, "Changed elsewhere"))
      .mockResolvedValueOnce(personality(5, true, 12, false));
    await controls.saveSchedule();
    controls = renderHook();
    expect(controls.snapshot?.revision).toBe(4);
    expect(controls.schedule.intervalDays).toBe(9);
    expect(controls.conflict).toBe(true);
    expect(await controls.saveSchedule()).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    controls.setSchedule({ enabled: true, intervalDays: 12 });
    controls = renderHook();
    await controls.retryRelationship();
    expect(save.mock.calls[1][0]).toEqual({ expectedRevision: 4, relationshipUpdate: { enabled: true, intervalDays: 12 }, recentWorkEnabled: false });
    expect(renderHook().schedule.intervalDays).toBe(12);
    expect(renderHook().dirty).toBe(false);
  });

  it("restores the saved recent-work state after failure and exposes an explicit retry", async () => {
    let controls = await loadPersonality();
    vi.spyOn(mocoRest, "savePersonalitySettings")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(personality(2, true, 1, false));
    await controls.setRecentEnabled(false);
    controls = renderHook();
    expect(controls.snapshot?.settings.recentWorkEnabled).toBe(true);
    expect(controls.recentError).toBe("Offline");
    await controls.retryRecent();
    controls = renderHook();
    expect(controls.snapshot?.settings.recentWorkEnabled).toBe(false);
    expect(controls.recentError).toBeUndefined();
  });
});

function settings(revision = 1, agentName = "Moco", workbenchName = "Saved workspace"): MocoSettingsView {
  return {
    globalRevision: revision,
    blocks: {
      presentation: { revision, value: { agentName, workbenchName } },
      executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
      roles: { revision: 1, value: defaultRolePresets() },
      model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "test", thinkingLevel: "off", customProviders: [] } },
      identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
      memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "private", shared: "shared" } } },
    },
    history: [],
  };
}

function findElement<P>(tree: ReactNode, type: unknown, predicate: (props: P) => boolean = () => true): ReactElement<P> {
  const visit = (value: ReactNode): ReactElement<P> | undefined => {
    for (const node of Array.isArray(value) ? value : [value]) {
      if (!isValidElement<{ children?: ReactNode }>(node)) continue;
      if (node.type === type && predicate(node.props as P)) return node as ReactElement<P>;
      const child = visit(node.props.children);
      if (child) return child;
    }
  };
  const result = visit(tree);
  if (result) return result;
  throw new Error("Expected control is missing");
}

function renderIdentity(value = settings(), onSettingsUpdated = vi.fn()) {
  hooks.cursor = 0;
  const tree = IdentityModule({ settings: value, onSettingsUpdated });
  return {
    field: findElement<ComponentProps<typeof TextField>>(tree, TextField),
    input: findElement<ComponentProps<typeof Input>>(tree, Input),
    tabs: findElement<ComponentProps<typeof Tabs.ListContainer> & { inert?: boolean }>(tree, Tabs.ListContainer),
    retry: () => findElement<ComponentProps<typeof Button>>(tree, Button, (props) => props.children === "重试"),
  };
}

describe("display-name preference", () => {
  it("saves on blur and Enter, blocks duplicate commits, and keeps other tabs available", async () => {
    let updated = settings();
    const onUpdated = vi.fn((next: MocoSettingsView) => { updated = next; });
    let page = renderIdentity(updated, onUpdated);
    const pending = deferred<{ settings: MocoSettingsView; summary: string }>();
    const save = vi.spyOn(mocoRest, "saveSettingsBlock").mockReturnValue(pending.promise);
    page.field.props.onChange?.("Moco New");
    page = renderIdentity(updated, onUpdated);
    expect(save).not.toHaveBeenCalled();
    page.input.props.onBlur?.({} as never);
    page = renderIdentity(updated, onUpdated);
    expect(hooks.pending).toBe(true);
    expect(page.field.props.isReadOnly).toBe(true);
    expect(page.tabs.props.inert).toBeUndefined();
    const preventDefault = vi.fn();
    page.input.props.onKeyDown?.({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault } as never);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("presentation", 1, { agentName: "Moco New", workbenchName: "Saved workspace" });
    pending.resolve({ settings: settings(2, "Moco New"), summary: "saved" });
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    page = renderIdentity(updated, onUpdated);
    expect(hooks.pending).toBe(false);
    expect(page.field.props.value).toBe("Moco New");
    page.input.props.onBlur?.({} as never);
    expect(save).toHaveBeenCalledOnce();
  });

  it("ignores IME Enter, preserves a failed name, and retries only that preference", async () => {
    let updated = settings();
    const onUpdated = vi.fn((next: MocoSettingsView) => { updated = next; });
    let page = renderIdentity(updated, onUpdated);
    const save = vi.spyOn(mocoRest, "saveSettingsBlock")
      .mockRejectedValueOnce(new MocoApiError(409, "Changed elsewhere"))
      .mockResolvedValueOnce({ settings: settings(5, "新名称", "Latest workspace"), summary: "saved" });
    page.field.props.onChange?.("新名称");
    page = renderIdentity(updated, onUpdated);
    page.input.props.onKeyDown?.({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault: vi.fn() } as never);
    expect(save).not.toHaveBeenCalled();
    page.input.props.onBlur?.({} as never);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    page = renderIdentity(updated, onUpdated);
    expect(page.field.props.value).toBe("新名称");
    vi.spyOn(mocoRest, "getSettings").mockResolvedValue(settings(4, "Other name", "Latest workspace"));
    page.retry().props.onPress?.({} as never);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]).toEqual(["presentation", 4, { agentName: "新名称", workbenchName: "Latest workspace" }]);
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2));
    expect(renderIdentity(updated, onUpdated).field.props.value).toBe("新名称");
  });
});
