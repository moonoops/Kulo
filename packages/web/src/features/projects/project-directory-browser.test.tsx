import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDirectoryListing, ProjectView } from "@kulo/protocol";
import { ProjectDirectoryBrowser, useCreateProjectDialog, type UseCreateProjectDialogOptions } from "./create-project-dialog";
import type { ProjectDevice } from "./project-model";

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  effects: [] as Array<{ index: number; deps: unknown[] | undefined; effect: () => void | (() => void) }>,
  effectRecords: [] as Array<{ deps: unknown[] | undefined; cleanup?: () => void }>,
  harnessActive: false,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!hooks.harnessActive) return actual.useState(initial as never);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.cells[index], (value: unknown) => {
        hooks.cells[index] = typeof value === "function" ? (value as (prev: unknown) => unknown)(hooks.cells[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.harnessActive) return actual.useRef(initial as never);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useCallback: (callback: unknown, deps: unknown[]) => {
      if (!hooks.harnessActive) return actual.useCallback(callback as never, deps as never);
      return callback;
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hooks.harnessActive) return actual.useEffect(effect, deps as never);
      const index = hooks.cursor++;
      hooks.effects.push({ index, deps, effect });
    },
    useSyncExternalStore: (subscribe: () => () => void, getSnapshot: () => unknown, getServerSnapshot?: () => unknown) => {
      if (!hooks.harnessActive) return actual.useSyncExternalStore(subscribe as never, getSnapshot as never, getServerSnapshot as never);
      return getSnapshot();
    },
  };
});

function sameDeps(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!prev || !next || prev.length !== next.length) return false;
  return prev.every((item, idx) => Object.is(item, next[idx]));
}

function flushEffects() {
  for (const item of hooks.effects.splice(0)) {
    const record = hooks.effectRecords[item.index];
    if (record && sameDeps(record.deps, item.deps)) continue;
    record?.cleanup?.();
    const cleanup = item.effect();
    hooks.effectRecords[item.index] = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  }
}

function unmountHarness() {
  for (const record of hooks.effectRecords.splice(0)) record?.cleanup?.();
  hooks.cells.length = 0;
  hooks.cursor = 0;
  hooks.effects.length = 0;
  hooks.harnessActive = false;
}

function renderHook(options: UseCreateProjectDialogOptions) {
  hooks.harnessActive = true;
  hooks.cursor = 0;
  hooks.effects.length = 0;
  const result = useCreateProjectDialog(options);
  flushEffects();
  return result;
}

afterEach(() => {
  unmountHarness();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const listing: ProjectDirectoryListing = {
  deviceId: "remote", path: "/projects", parentPath: "/",
  entries: [
    { name: ".git", path: "/projects/.git" },
    { name: "Kulo", path: "/projects/Kulo" },
    { name: ".Trash", path: "/projects/.Trash" },
    { name: "release.v2", path: "/projects/release.v2" },
  ],
};

const sampleDevices: ProjectDevice[] = [
  { id: "macbook", name: "MacBook", online: true, rootDir: "/Users/demo" },
  { id: "macmini", name: "Mac mini", online: true, rootDir: "/Users/mini" },
];

describe("project directory browsing", () => {
  it("hides dot directories from local or remote listings while preserving visible folders", () => {
    const html = renderToStaticMarkup(<ProjectDirectoryBrowser listing={listing} browsing={false} creating={false} onBrowse={() => {}} />);
    expect(html).not.toContain(".git");
    expect(html).not.toContain(".Trash");
    expect(html).toContain('aria-label="Kulo"');
    expect(html).toContain('aria-label="release.v2"');
    expect(html).toContain('aria-label="上一级目录"');
  });

  it("shows an empty state when only hidden directories exist", () => {
    const html = renderToStaticMarkup(<ProjectDirectoryBrowser listing={{ ...listing, entries: listing.entries.filter((entry) => entry.name.startsWith(".")) }}
      browsing={false} creating={false} onBrowse={() => {}} />);
    expect(html).toContain("没有可见子目录");
    expect(html).not.toContain(".git");
    expect(html).not.toContain(".Trash");
  });

  it("uses native Finder picker for current local device, auto-fills/updates name safely, and preserves manual edits", async () => {
    const pickDirectory = vi.fn<NonNullable<UseCreateProjectDialogOptions["desktop"]>["pickDirectory"] & {}>()
      .mockResolvedValueOnce("/Users/demo/Documents/FirstRepo")
      .mockResolvedValueOnce("/Users/demo/Documents/SecondRepo")
      .mockResolvedValueOnce("/Users/demo/Documents/ThirdRepo")
      .mockResolvedValueOnce(null);
    const listDirectories = vi.fn();
    const onNativePickFinished = vi.fn();

    const opts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: "macbook",
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      listDirectories,
      createProject: vi.fn(),
      onNativePickFinished,
    };

    let state = renderHook(opts);
    expect(state.canPickNativeDirectory).toBe(true);
    const initialCommandId = state.commandId;

    // 1. First pick auto-fills project name and refreshes commandId.
    await state.browse();
    state = renderHook(opts);
    expect(pickDirectory).toHaveBeenNthCalledWith(1, undefined);
    expect(listDirectories).not.toHaveBeenCalled();
    expect(state.directory).toBe("/Users/demo/Documents/FirstRepo");
    expect(state.name).toBe("FirstRepo");
    expect(state.commandId).not.toBe(initialCommandId);
    expect(state.listing).toBeUndefined();
    expect(onNativePickFinished).toHaveBeenCalledTimes(1);

    // 2. Immediate second pick updates auto-filled project name and passes previous path as defaultPath.
    await state.browse(state.directory);
    state = renderHook(opts);
    expect(pickDirectory).toHaveBeenNthCalledWith(2, { defaultPath: "/Users/demo/Documents/FirstRepo" });
    expect(state.directory).toBe("/Users/demo/Documents/SecondRepo");
    expect(state.name).toBe("SecondRepo");

    // 3. Manual name edit is never overwritten on subsequent picks.
    state.setNameValue("Custom Project");
    state = renderHook(opts);
    await state.browse(state.directory);
    state = renderHook(opts);
    expect(state.directory).toBe("/Users/demo/Documents/ThirdRepo");
    expect(state.name).toBe("Custom Project");

    // 4. Cancellation leaves directory, name, and error untouched.
    await state.browse(state.directory);
    state = renderHook(opts);
    expect(state.directory).toBe("/Users/demo/Documents/ThirdRepo");
    expect(state.name).toBe("Custom Project");
    expect(state.error).toBeUndefined();
  });

  it("does not overwrite project name when picking a parent directory in new-directory mode", async () => {
    const pickDirectory = vi.fn(async () => "/Users/demo/Workspace");
    const opts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: "macbook",
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      listDirectories: vi.fn(),
      createProject: vi.fn(),
    };

    let state = renderHook(opts);
    state.setModeValue("new");
    state = renderHook(opts);
    await state.browse();
    state = renderHook(opts);
    expect(state.directory).toBe("/Users/demo/Workspace");
    expect(state.name).toBe("");
  });

  it("keeps existing remote listing browser for remote devices and pure web browsers", async () => {
    const pickDirectory = vi.fn(async () => "/Users/demo/ShouldNotRun");
    const listDirectories = vi.fn(async () => listing);

    // Desktop targeting remote device
    const remoteOpts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: "macbook",
      initialDeviceId: "macmini",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      listDirectories,
      createProject: vi.fn(),
    };

    let state = renderHook(remoteOpts);
    expect(state.canPickNativeDirectory).toBe(false);
    await state.browse();
    state = renderHook(remoteOpts);
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(listDirectories).toHaveBeenCalledWith("macmini", undefined, expect.any(AbortSignal));
    expect(state.listing).toEqual(listing);
    expect(state.directory).toBe("/projects");

    // Switching back to local clears remote listing and switches to native picker
    state.selectDevice("macbook");
    state = renderHook(remoteOpts);
    expect(state.listing).toBeUndefined();
    expect(state.directory).toBe("");
    expect(state.canPickNativeDirectory).toBe(true);

    unmountHarness();

    // Pure browser (no desktop bridge) targeting local device falls back to listDirectories
    const webList = vi.fn(async () => ({ ...listing, deviceId: "macbook" }));
    const webOpts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: "macbook",
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: undefined,
      listDirectories: webList,
      createProject: vi.fn(),
    };
    state = renderHook(webOpts);
    expect(state.canPickNativeDirectory).toBe(false);
    await state.browse();
    state = renderHook(webOpts);
    expect(webList).toHaveBeenCalledWith("macbook", undefined, expect.any(AbortSignal));
    expect(state.listing?.deviceId).toBe("macbook");
  });

  it("resolves currentDeviceId lazily on cold start and fails closed to remote listing when identity fails", async () => {
    const pickDirectory = vi.fn(async () => "/Users/demo/ColdStartRepo");
    const listDirectories = vi.fn(async () => listing);
    const resolveCurrentDeviceId = vi.fn(async () => "macbook");

    const coldOpts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: undefined,
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      resolveCurrentDeviceId,
      listDirectories,
      createProject: vi.fn(),
    };

    let state = renderHook(coldOpts);
    expect(state.canPickNativeDirectory).toBe(false);
    await state.browse();
    state = renderHook(coldOpts);
    expect(resolveCurrentDeviceId).toHaveBeenCalledTimes(1);
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(listDirectories).not.toHaveBeenCalled();
    expect(state.directory).toBe("/Users/demo/ColdStartRepo");
    expect(state.name).toBe("ColdStartRepo");
    expect(state.canPickNativeDirectory).toBe(true);

    unmountHarness();

    // Failing device identity check fails closed to remote directory listing (never opens local Finder blindly).
    const failPick = vi.fn();
    const failList = vi.fn(async () => ({ ...listing, deviceId: "macbook" }));
    const failOpts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: undefined,
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: { pickDirectory: failPick },
      resolveCurrentDeviceId: vi.fn(async () => { throw new Error("network down"); }),
      listDirectories: failList,
      createProject: vi.fn(),
    };

    state = renderHook(failOpts);
    await state.browse();
    state = renderHook(failOpts);
    expect(failPick).not.toHaveBeenCalled();
    expect(failList).toHaveBeenCalledTimes(1);
    expect(state.directory).toBe("/projects");
  });

  it("locks modal interactions while native picker is open, blocks re-entry, and discards results after unmount", async () => {
    let finishPick!: (value: string | null) => void;
    const pickDirectory = vi.fn(() => new Promise<string | null>((resolve) => { finishPick = resolve; }));
    const onNativePickFinished = vi.fn();
    const createProject = vi.fn(async () => ({ project: {} as ProjectView }));

    const opts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: "macbook",
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      listDirectories: vi.fn(),
      createProject,
      onNativePickFinished,
    };

    let state = renderHook(opts);
    const inFlight = state.browse();
    state = renderHook(opts);
    expect(state.pickingNative).toBe(true);
    expect(state.browsing).toBe(true);
    expect(state.locked).toBe(true);

    // Re-entrant browse, device change, and create are all ignored while native Finder is open.
    await state.browse();
    state.selectDevice("macmini");
    await state.create();
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(createProject).not.toHaveBeenCalled();
    state = renderHook(opts);
    expect(state.deviceId).toBe("macbook");

    // Unmounting before Finder resolves discards the result cleanly.
    unmountHarness();
    finishPick("/Users/demo/StaleRepo");
    await inFlight;
    expect(onNativePickFinished).not.toHaveBeenCalled();
  });

  it("clears cached currentDeviceId on prop transition to undefined so role-switch disconnects re-verify device identity", async () => {
    const pickDirectory = vi.fn(async () => "/Users/demo/ShouldNotRun");
    const listDirectories = vi.fn(async () => ({ ...listing, deviceId: "local" }));
    const resolveCurrentDeviceId = vi.fn(async () => "macbook");

    const devicesWithHub: ProjectDevice[] = [
      { id: "local", name: "Hub", online: true, rootDir: "/hub" },
      { id: "macbook", name: "MacBook", online: true, rootDir: "/Users/demo" },
    ];

    // Step 1: Previously in Hub mode where local machine was "local".
    let state = renderHook({
      devices: devicesWithHub,
      currentDeviceId: "local",
      initialDeviceId: "local",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      resolveCurrentDeviceId,
      listDirectories,
      createProject: vi.fn(),
    });
    expect(state.canPickNativeDirectory).toBe(true);

    // Step 2: Role switched to Peer; parent clears currentDeviceId while reconnecting.
    state = renderHook({
      devices: devicesWithHub,
      currentDeviceId: undefined,
      initialDeviceId: "local",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      resolveCurrentDeviceId,
      listDirectories,
      createProject: vi.fn(),
    });
    expect(state.canPickNativeDirectory).toBe(false);

    // Clicking browse on "local" (now the remote Hub) re-resolves identity -> "macbook" != "local" -> remote listing!
    await state.browse();
    state = renderHook({
      devices: devicesWithHub,
      currentDeviceId: undefined,
      initialDeviceId: "local",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      resolveCurrentDeviceId,
      listDirectories,
      createProject: vi.fn(),
    });
    expect(resolveCurrentDeviceId).toHaveBeenCalledTimes(1);
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(listDirectories).toHaveBeenCalledWith("local", undefined, expect.any(AbortSignal));
  });

  it("surfaces native picker errors cleanly and clears busy state", async () => {
    const pickDirectory = vi.fn(async () => { throw new Error("窗口已关闭。"); });
    const opts: UseCreateProjectDialogOptions = {
      devices: sampleDevices,
      currentDeviceId: "macbook",
      initialDeviceId: "macbook",
      onCreated: vi.fn(),
      desktop: { pickDirectory },
      listDirectories: vi.fn(),
      createProject: vi.fn(),
    };

    let state = renderHook(opts);
    await state.browse();
    state = renderHook(opts);
    expect(state.error).toBe("窗口已关闭。");
    expect(state.browsing).toBe(false);
    expect(state.pickingNative).toBe(false);
    expect(state.locked).toBe(false);
  });
});
