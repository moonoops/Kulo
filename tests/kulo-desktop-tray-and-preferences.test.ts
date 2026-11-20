import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMain, IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMainWindowCloseController } from "../packages/desktop/src/desktop-menu.js";
import {
  configureDesktopPreferenceHandlers,
  createDesktopPreferencesStore,
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  DEFAULT_DESKTOP_PREFERENCES,
  DESKTOP_PREFERENCES_CHANNELS,
  DESKTOP_PREFERENCES_FILENAME,
  readDesktopPreferencesFile,
  writeDesktopPreferencesFile,
} from "../packages/desktop/src/desktop-preferences.js";
import {
  createDesktopTrayController,
  createDesktopTrayMenuTemplate,
  loadDesktopTrayIcon,
  type ManagedTray,
} from "../packages/desktop/src/desktop-tray.js";

const directories: string[] = [];
function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-desktop-prefs-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop background running and notification preferences", () => {
  it("defaults to background running, notifications and badge enabled with sound muted, and persists atomic private updates", () => {
    const dir = directory();
    const onChange = vi.fn();
    const store = createDesktopPreferencesStore({ dataDir: dir, onChange });
    expect(store.get()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    expect(store.get()).toEqual({
      backgroundRunning: true,
      notifications: { enabled: true, sound: false, badge: true },
    });

    expect(store.update({ backgroundRunning: false })).toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: false, badge: true },
    });
    expect(onChange).toHaveBeenCalledWith({
      backgroundRunning: false,
      notifications: { enabled: true, sound: false, badge: true },
    });

    expect(store.update({ notifications: { sound: true, badge: false } })).toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: true, badge: false },
    });

    const file = path.join(dir, DESKTOP_PREFERENCES_FILENAME);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDesktopPreferencesFile(file)).toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: true, badge: false },
    });

    const reloaded = createDesktopPreferencesStore({ dataDir: dir });
    expect(reloaded.get()).toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: true, badge: false },
    });
    expect(reloaded.update({ backgroundRunning: true, notifications: { enabled: false } })).toEqual({
      backgroundRunning: true,
      notifications: { enabled: false, sound: true, badge: false },
    });
    expect(readDesktopPreferencesFile(file)).toEqual({
      backgroundRunning: true,
      notifications: { enabled: false, sound: true, badge: false },
    });
  });

  it("migrates legacy desktop-preferences.json containing only backgroundRunning without losing state", () => {
    const dir = directory();
    const file = path.join(dir, DESKTOP_PREFERENCES_FILENAME);
    fs.writeFileSync(file, JSON.stringify({ formatVersion: 1, backgroundRunning: false }), { mode: 0o600 });
    expect(readDesktopPreferencesFile(file)).toEqual({
      backgroundRunning: false,
      notifications: { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES },
    });
  });

  it("rejects invalid preference updates without modifying saved state", () => {
    const dir = directory();
    const onChange = vi.fn();
    const store = createDesktopPreferencesStore({ dataDir: dir, onChange });
    for (const invalid of [
      null,
      undefined,
      [],
      {},
      { backgroundRunning: "true" },
      { backgroundRunning: 1 },
      { unknown: true },
      { backgroundRunning: false, extra: 1 },
      { notifications: null },
      { notifications: {} },
      { notifications: { enabled: "yes" } },
      { notifications: { sound: 1 } },
      { notifications: { badge: true, extra: false } },
    ]) {
      expect(() => store.update(invalid)).toThrow();
    }
    expect(store.get()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    expect(onChange).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, DESKTOP_PREFERENCES_FILENAME))).toBe(false);
  });

  it("falls back safely on corrupt stored preferences and refuses symlinked preference targets", () => {
    const dir = directory();
    const file = path.join(dir, DESKTOP_PREFERENCES_FILENAME);
    fs.writeFileSync(file, "{broken json", { mode: 0o600 });
    const logs: string[] = [];
    const store = createDesktopPreferencesStore({ dataDir: dir, onLog: (msg) => logs.push(msg) });
    expect(store.get()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    expect(logs.length).toBe(1);

    const linkedDir = directory();
    const outside = path.join(directory(), "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ formatVersion: 1, backgroundRunning: false }), { mode: 0o600 });
    const linkFile = path.join(linkedDir, DESKTOP_PREFERENCES_FILENAME);
    fs.symlinkSync(outside, linkFile);
    expect(() => readDesktopPreferencesFile(linkFile)).toThrow();
    expect(() => writeDesktopPreferencesFile(linkFile, { backgroundRunning: true, notifications: { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES } })).toThrow("不可用");
    expect(JSON.parse(fs.readFileSync(outside, "utf8")).backgroundRunning).toBe(false);

    const readOnlyDir = directory();
    fs.chmodSync(readOnlyDir, 0o500);
    try {
      const roStore = createDesktopPreferencesStore({ dataDir: readOnlyDir });
      expect(() => roStore.update({ backgroundRunning: false })).toThrow("无法保存桌面偏好设置");
      expect(roStore.get().backgroundRunning).toBe(true);
    } finally {
      fs.chmodSync(readOnlyDir, 0o700);
    }
  });

  it("authorizes desktop preference IPC strictly for the active trusted main frame", async () => {
    const dir = directory();
    const store = createDesktopPreferencesStore({ dataDir: dir });
    const origin = "http://127.0.0.1:7799";
    const mainFrame = { origin };
    const owner = { isDestroyed: vi.fn(() => false), webContents: { mainFrame, isDestroyed: vi.fn(() => false) } };
    const event = { sender: owner.webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const handle = vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    });
    let activeOwner: typeof owner | undefined = owner;
    let activeOrigin: string | undefined = origin;
    configureDesktopPreferenceHandlers({
      ipc: { handle } as Pick<IpcMain, "handle">,
      preferences: store,
      owner: () => activeOwner,
      rendererOrigin: () => activeOrigin,
    });
    const invoke = (channel: string, sender = event, ...args: unknown[]) =>
      Promise.resolve().then(() => handlers.get(channel)!(sender, ...args));

    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.get)).resolves.toEqual(DEFAULT_DESKTOP_PREFERENCES);
    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.set, event, { backgroundRunning: false, notifications: { sound: true } })).resolves.toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: true, badge: true },
    });
    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.get)).resolves.toEqual({
      backgroundRunning: false,
      notifications: { enabled: true, sound: true, badge: true },
    });

    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.get, event, "extra")).rejects.toThrow("参数无效");
    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.set, event)).rejects.toThrow("参数无效");
    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.set, event, { backgroundRunning: true }, "extra")).rejects.toThrow("参数无效");

    for (const invalidSender of [
      { sender: {}, senderFrame: mainFrame },
      { sender: owner.webContents, senderFrame: { origin } },
      { sender: owner.webContents, senderFrame: null },
    ]) {
      await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.get, invalidSender as unknown as IpcMainInvokeEvent)).rejects.toThrow("无法从此页面");
      await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.set, invalidSender as unknown as IpcMainInvokeEvent, { backgroundRunning: true })).rejects.toThrow("无法从此页面");
    }

    activeOrigin = undefined;
    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.get)).rejects.toThrow("无法从此页面");
    activeOrigin = origin;
    activeOwner = undefined;
    await expect(invoke(DESKTOP_PREFERENCES_CHANNELS.set, event, { backgroundRunning: true })).rejects.toThrow("无法从此页面");
  });
});

describe("desktop tray lifecycle, template icon and red-dot badge", () => {
  function fakeTray() {
    let destroyed = false;
    const clickListeners: Array<() => void> = [];
    const tray: ManagedTray & {
      emitClick(): void;
      setToolTip: ReturnType<typeof vi.fn>;
      setContextMenu: ReturnType<typeof vi.fn>;
      setImage: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    } = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      setImage: vi.fn(),
      on: vi.fn((_event: "click", listener: () => void) => { clickListeners.push(listener); }),
      destroy: vi.fn(() => { destroyed = true; }),
      isDestroyed: () => destroyed,
      emitClick: () => { for (const listener of clickListeners) listener(); },
    };
    return tray;
  }

  it("builds standard tray menu items and invokes actions cleanly", () => {
    const onFocusWindow = vi.fn();
    const onNewTopic = vi.fn();
    const onOpenSettings = vi.fn();
    const onQuit = vi.fn();
    const template = createDesktopTrayMenuTemplate({
      appName: "Kulo Dev",
      onFocusWindow,
      onNewTopic,
      onOpenSettings,
      onQuit,
    });
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "显示 Kulo",
      "新建话题",
      "设置…",
      "separator",
      "退出 Kulo Dev",
    ]);
    for (const item of template) {
      item.click?.(item as never, undefined, {} as never);
    }
    expect(onFocusWindow).toHaveBeenCalledOnce();
    expect(onNewTopic).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it("creates, updates, toggles badge/theme, and disposes the tray cleanly across platforms", () => {
    const created: ReturnType<typeof fakeTray>[] = [];
    const onFocusWindow = vi.fn();
    let dark = false;
    const resolveIcon = vi.fn((badgeActive: boolean) => (badgeActive ? (dark ? "badge-dark" : "badge-light") : "template"));
    const controller = createDesktopTrayController({
      appName: "Kulo Dev",
      platform: "darwin",
      createTray: () => {
        const tray = fakeTray();
        created.push(tray);
        return tray;
      },
      resolveIcon,
      buildMenu: (template: MenuItemConstructorOptions[]) => ({ template }),
      onFocusWindow,
      onNewTopic: vi.fn(),
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
    });

    expect(controller.isActive()).toBe(false);
    controller.sync(true);
    expect(controller.isActive()).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.setToolTip).toHaveBeenCalledWith("Kulo Dev");
    expect(created[0]!.setImage).toHaveBeenCalledWith("template");
    expect(created[0]!.setContextMenu).toHaveBeenCalledTimes(1);
    expect(created[0]!.on).not.toHaveBeenCalled();

    // Activate red dot badge and respond to theme change
    controller.setBadge(true);
    expect(created[0]!.setImage).toHaveBeenLastCalledWith("badge-light");
    expect(created[0]!.setToolTip).toHaveBeenLastCalledWith("Kulo Dev · 有新回复");

    dark = true;
    controller.refreshTheme();
    expect(created[0]!.setImage).toHaveBeenLastCalledWith("badge-dark");

    // Clear badge back to monochrome template
    controller.setBadge(false);
    expect(created[0]!.setImage).toHaveBeenLastCalledWith("template");
    expect(created[0]!.setToolTip).toHaveBeenLastCalledWith("Kulo Dev");

    // Repeat sync refreshes menu without creating a duplicate tray icon.
    controller.sync(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.setContextMenu).toHaveBeenCalledTimes(2);

    // Turning off background running removes the tray icon immediately.
    controller.sync(false);
    expect(controller.isActive()).toBe(false);
    expect(created[0]!.destroy).toHaveBeenCalledOnce();

    // Turning back on restores a fresh tray icon.
    controller.sync(true);
    expect(controller.isActive()).toBe(true);
    expect(created).toHaveLength(2);

    // Disposing destroys the tray and ignores further sync calls.
    controller.dispose();
    expect(controller.isActive()).toBe(false);
    expect(created[1]!.destroy).toHaveBeenCalledOnce();
    controller.sync(true);
    expect(controller.isActive()).toBe(false);
    expect(created).toHaveLength(2);

    // Non-macOS binds click to focus the main window.
    const winTray = fakeTray();
    const winController = createDesktopTrayController({
      appName: "Kulo Dev",
      platform: "win32",
      createTray: () => winTray,
      buildMenu: (template) => ({ template }),
      onFocusWindow,
      onNewTopic: vi.fn(),
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
    });
    winController.sync(true);
    winTray.emitClick();
    expect(onFocusWindow).toHaveBeenCalledOnce();
    winController.dispose();
  });

  it("marks macOS template icons appropriately and preserves color for non-template red-dot badge icons", () => {
    const macImage = { isEmpty: () => false, setTemplateImage: vi.fn() };
    expect(loadDesktopTrayIcon("/tmp/kulo-trayTemplate.png", () => macImage, "darwin")).toBe(macImage);
    expect(macImage.setTemplateImage).toHaveBeenCalledWith(true);

    const badgeImage = { isEmpty: () => false, setTemplateImage: vi.fn() };
    expect(loadDesktopTrayIcon("/tmp/kulo-tray-badge-light.png", () => badgeImage, "darwin", { template: false })).toBe(badgeImage);
    expect(badgeImage.setTemplateImage).toHaveBeenCalledWith(false);

    const winImage = { isEmpty: () => false, setTemplateImage: vi.fn() };
    expect(loadDesktopTrayIcon("/tmp/kulo-trayTemplate.png", () => winImage, "win32")).toBe(winImage);
    expect(winImage.setTemplateImage).not.toHaveBeenCalled();

    const emptyImage = { isEmpty: () => true, setTemplateImage: vi.fn() };
    expect(() => loadDesktopTrayIcon("/tmp/missing.png", () => emptyImage, "darwin")).toThrow("无法加载任务栏常驻图标");
  });

  it("ships crisp 1x and 2x macOS template and red-dot badge PNG assets for the sunglasses cat tray icon", () => {
    const assetsDir = fileURLToPath(new URL("../packages/desktop/assets/", import.meta.url));
    for (const [filename, expectedSize] of [
      ["kulo-trayTemplate.png", 22],
      ["kulo-trayTemplate@2x.png", 44],
      ["kulo-tray-badge-light.png", 22],
      ["kulo-tray-badge-light@2x.png", 44],
      ["kulo-tray-badge-dark.png", 22],
      ["kulo-tray-badge-dark@2x.png", 44],
    ] as const) {
      const bytes = fs.readFileSync(path.join(assetsDir, filename));
      // PNG signature + IHDR width & height bytes
      expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(bytes.readUInt32BE(16)).toBe(expectedSize);
      expect(bytes.readUInt32BE(20)).toBe(expectedSize);
    }
  });
});

describe("main window close lifecycle with background running disabled", () => {
  it("allows closing the window and prompts on unsaved drafts when background running is disabled", () => {
    const controller = createMainWindowCloseController();
    const win = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      setFullScreen: vi.fn(),
      hide: vi.fn(),
      webContents: { reload: vi.fn() },
    };

    // Background running disabled: close does not prevent default or hide the window.
    const closeEvent = { preventDefault: vi.fn() };
    controller.handleClose(closeEvent, win, false, false);
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();

    // Unsaved draft confirmation on close respects user cancel and confirm.
    const confirmReload = vi.fn(() => false);
    const confirmCloseCancel = vi.fn(() => false);
    const canceledUnload = { preventDefault: vi.fn() };
    controller.handleWillPreventUnload(canceledUnload, false, confirmReload, false, confirmCloseCancel);
    expect(confirmReload).not.toHaveBeenCalled();
    expect(confirmCloseCancel).toHaveBeenCalledOnce();
    expect(canceledUnload.preventDefault).not.toHaveBeenCalled();

    const confirmCloseAccept = vi.fn(() => true);
    const acceptedUnload = { preventDefault: vi.fn() };
    controller.handleWillPreventUnload(acceptedUnload, false, confirmReload, false, confirmCloseAccept);
    expect(confirmCloseAccept).toHaveBeenCalledOnce();
    expect(acceptedUnload.preventDefault).toHaveBeenCalledOnce();
  });
});
