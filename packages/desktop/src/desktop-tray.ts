import type { MenuItemConstructorOptions } from "electron";

export interface DesktopTrayMenuOptions {
  appName: string;
  onFocusWindow(): void;
  onNewTopic(): void;
  onOpenSettings(): void;
  onQuit(): void;
}

export function createDesktopTrayMenuTemplate(options: DesktopTrayMenuOptions): MenuItemConstructorOptions[] {
  return [
    { label: "显示 Kulo", click: options.onFocusWindow },
    { label: "新建话题", click: options.onNewTopic },
    { label: "设置…", click: options.onOpenSettings },
    { type: "separator" },
    { label: `退出 ${options.appName}`, click: options.onQuit },
  ];
}

export interface ManagedTray {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click", listener: () => void): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface TrayNativeImageLike {
  isEmpty(): boolean;
  setTemplateImage(option: boolean): void;
}

export function loadDesktopTrayIcon<T extends TrayNativeImageLike>(
  iconPath: string,
  createFromPath: (file: string) => T,
  platform: NodeJS.Platform,
): T {
  const image = createFromPath(iconPath);
  if (image.isEmpty()) {
    throw new Error(`无法加载任务栏常驻图标：${iconPath}`);
  }
  if (platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image;
}

export interface DesktopTrayControllerOptions {
  appName: string;
  platform: NodeJS.Platform;
  createTray(): ManagedTray;
  buildMenu(template: MenuItemConstructorOptions[]): unknown;
  onFocusWindow(): void;
  onNewTopic(): void;
  onOpenSettings(): void;
  onQuit(): void;
  onLog?(message: string): void;
}

export interface DesktopTrayController {
  sync(enabled: boolean): void;
  isActive(): boolean;
  dispose(): void;
}

export function createDesktopTrayController(options: DesktopTrayControllerOptions): DesktopTrayController {
  let tray: ManagedTray | undefined;
  let disposed = false;

  const destroyTray = () => {
    const current = tray;
    tray = undefined;
    if (current && !current.isDestroyed()) {
      current.destroy();
    }
  };

  const applyMenu = (target: ManagedTray) => {
    const menu = options.buildMenu(createDesktopTrayMenuTemplate({
      appName: options.appName,
      onFocusWindow: options.onFocusWindow,
      onNewTopic: options.onNewTopic,
      onOpenSettings: options.onOpenSettings,
      onQuit: options.onQuit,
    }));
    target.setContextMenu(menu);
  };

  return {
    sync(enabled: boolean): void {
      if (disposed) return;
      if (!enabled) {
        destroyTray();
        return;
      }
      if (tray && !tray.isDestroyed()) {
        applyMenu(tray);
        return;
      }
      try {
        const created = options.createTray();
        created.setToolTip(options.appName);
        applyMenu(created);
        if (options.platform !== "darwin") {
          created.on("click", options.onFocusWindow);
        }
        tray = created;
      } catch (error) {
        options.onLog?.(`创建任务栏常驻图标失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    },
    isActive(): boolean {
      return Boolean(tray && !tray.isDestroyed());
    },
    dispose(): void {
      disposed = true;
      destroyTray();
    },
  };
}
