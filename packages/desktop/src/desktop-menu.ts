import type { MenuItemConstructorOptions } from "electron";

export const DESKTOP_APP_COMMANDS = [
  "new-topic",
  "open-settings",
  "search-conversations",
  "find-in-conversation",
  "toggle-left-panel",
  "toggle-right-panel",
  "open-main-chat",
  "stop-generation",
  "copy-last-reply",
  "save-active",
] as const;

export type DesktopAppCommand = (typeof DESKTOP_APP_COMMANDS)[number];

const COMMAND_SET = new Set<string>(DESKTOP_APP_COMMANDS);

export function isDesktopAppCommand(value: unknown): value is DesktopAppCommand {
  return typeof value === "string" && COMMAND_SET.has(value);
}

const REVEAL_WINDOW_COMMANDS = new Set<DesktopAppCommand>([
  "new-topic",
  "open-settings",
  "search-conversations",
  "find-in-conversation",
  "open-main-chat",
]);

export function shouldRevealWindowForCommand(command: DesktopAppCommand): boolean {
  return REVEAL_WINDOW_COMMANDS.has(command);
}

export interface DesktopReloadTarget {
  webContents?: { reload(): void };
}

export interface DesktopMenuOptions {
  appName: string;
  platform: NodeJS.Platform;
  showUseInstalled: boolean;
  onFocusWindow(): void;
  onOpenDataDir(): void;
  onOpenLog(): void;
  onRestartServices(): void;
  onUseInstalled(): void;
  onCopyRepair(): void;
  onReload(focusedWindow?: DesktopReloadTarget): void;
  onCommand(command: DesktopAppCommand): void;
}

export function createDesktopMenuTemplate(options: DesktopMenuOptions): MenuItemConstructorOptions[] {
  const isMac = options.platform === "darwin";
  return [
    ...(isMac ? [{
      label: options.appName,
      submenu: [
        { role: "about", label: `关于 ${options.appName}` },
        { type: "separator" },
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => options.onCommand("open-settings") },
        { type: "separator" },
        { label: "显示 Kulo", click: options.onFocusWindow },
        { label: "打开数据目录", click: options.onOpenDataDir },
        { label: "打开日志", click: options.onOpenLog },
        { type: "separator" },
        { role: "hide", label: `隐藏 ${options.appName}` },
        { role: "hideOthers", label: "隐藏其他应用" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: `退出 ${options.appName}` },
      ] as MenuItemConstructorOptions[],
    }] : []),
    {
      label: "文件",
      submenu: [
        { label: "新建话题", accelerator: "CmdOrCtrl+N", click: () => options.onCommand("new-topic") },
        { label: "保存更改", accelerator: "CmdOrCtrl+S", click: () => options.onCommand("save-active") },
        ...(!isMac ? [
          { type: "separator" as const },
          { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => options.onCommand("open-settings") },
          { label: "打开数据目录", click: options.onOpenDataDir },
          { label: "打开日志", click: options.onOpenLog },
        ] : []),
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
        ...(!isMac ? [{ role: "quit" as const, label: `退出 ${options.appName}` }] : []),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { role: "selectAll", label: "全选" },
        { type: "separator" },
        { label: "在当前对话中查找", accelerator: "CmdOrCtrl+F", click: () => options.onCommand("find-in-conversation") },
        { label: "搜索全部对话", accelerator: "CmdOrCtrl+K", click: () => options.onCommand("search-conversations") },
      ],
    },
    {
      label: "显示",
      submenu: [
        { label: "切换左侧导航栏", accelerator: "CmdOrCtrl+\\", click: () => options.onCommand("toggle-left-panel") },
        { label: "切换右侧面板", accelerator: "CmdOrCtrl+Shift+\\", click: () => options.onCommand("toggle-right-panel") },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大", accelerator: "CmdOrCtrl+=" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
        { type: "separator" },
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: (_item, focusedWindow) => options.onReload(focusedWindow as DesktopReloadTarget | undefined),
        },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "对话",
      submenu: [
        { label: "回到主对话", accelerator: "CmdOrCtrl+1", click: () => options.onCommand("open-main-chat") },
        { label: "停止生成", accelerator: "CmdOrCtrl+.", click: () => options.onCommand("stop-generation") },
        { label: "复制最新回复", accelerator: "CmdOrCtrl+Shift+C", click: () => options.onCommand("copy-last-reply") },
      ],
    },
    {
      label: "开发",
      submenu: [
        { label: "重启后台服务", click: options.onRestartServices },
        ...(options.showUseInstalled ? [{ label: "使用已安装版本", click: options.onUseInstalled }] : []),
      ],
    },
    {
      role: "windowMenu",
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "front", label: "前置全部窗口" },
      ],
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        { label: "复制修复信息", click: options.onCopyRepair },
      ],
    },
  ];
}

export interface DesktopContextMenuEditFlags {
  canUndo?: boolean;
  canRedo?: boolean;
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canDelete?: boolean;
  canSelectAll?: boolean;
  canEditRichly?: boolean;
}

export interface DesktopContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  editFlags?: DesktopContextMenuEditFlags;
  misspelledWord?: string;
  dictionarySuggestions?: readonly string[];
}

export interface DesktopContextMenuOptions {
  hasClipboardContent?: boolean;
  copyLinkUrl?: string;
  onPaste?: () => void;
  onReplaceMisspelling?: (suggestion: string) => void;
  onCopyLink?: (url: string) => void;
}

export function createDesktopContextMenuTemplate(
  params: DesktopContextMenuParams,
  options: DesktopContextMenuOptions = {},
): MenuItemConstructorOptions[] {
  const flags = params.editFlags ?? {};
  if (params.isEditable) {
    const items: MenuItemConstructorOptions[] = [];
    const suggestions = params.misspelledWord && params.dictionarySuggestions?.length && options.onReplaceMisspelling
      ? params.dictionarySuggestions.slice(0, 5)
      : [];
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        items.push({ label: suggestion, click: () => options.onReplaceMisspelling!(suggestion) });
      }
      items.push({ type: "separator" });
    }
    const pasteItem: MenuItemConstructorOptions = flags.canPaste
      ? { role: "paste", label: "粘贴", enabled: true }
      : options.hasClipboardContent && options.onPaste
        ? { label: "粘贴", enabled: true, click: options.onPaste }
        : { role: "paste", label: "粘贴", enabled: false };
    items.push(
      { role: "undo", label: "撤销", enabled: Boolean(flags.canUndo) },
      { role: "redo", label: "重做", enabled: Boolean(flags.canRedo) },
      { type: "separator" },
      { role: "cut", label: "剪切", enabled: Boolean(flags.canCut) },
      { role: "copy", label: "复制", enabled: Boolean(flags.canCopy) },
      pasteItem,
      ...(flags.canEditRichly ? [{ role: "pasteAndMatchStyle" as const, label: "粘贴并匹配样式", enabled: Boolean(flags.canPaste) }] : []),
      { role: "delete", label: "删除", enabled: Boolean(flags.canDelete) },
      { type: "separator" },
      { role: "selectAll", label: "全选", enabled: Boolean(flags.canSelectAll) },
    );
    return items;
  }

  const items: MenuItemConstructorOptions[] = [];
  if (params.selectionText.trim().length > 0) {
    items.push({ role: "copy", label: "复制", enabled: flags.canCopy !== false });
  }
  if (options.copyLinkUrl && options.onCopyLink) {
    const linkUrl = options.copyLinkUrl;
    items.push({ label: "复制链接", click: () => options.onCopyLink!(linkUrl) });
  }
  return items;
}

export interface ManagedDesktopWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  hide(): void;
  webContents: { reload(): void };
}

export interface MainWindowCloseController {
  handleClose(event: { preventDefault(): void }, win: ManagedDesktopWindow, isQuitting: boolean, keepRunningInBackground?: boolean): void;
  handleLeaveFullScreen(win: ManagedDesktopWindow, isQuitting: boolean): void;
  handleFocusOrActivate(): void;
  requestReload(win: ManagedDesktopWindow): void;
  clearPendingReload(): void;
  handleWillPreventUnload(
    event: { preventDefault(): void },
    isQuitting: boolean,
    confirmReload: () => boolean,
    keepRunningInBackground?: boolean,
    confirmClose?: () => boolean,
  ): void;
}

export function createMainWindowCloseController(reloadWindowMs = 2_000): MainWindowCloseController {
  let hideAfterFullScreen = false;
  let pendingReload = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPendingReload = () => {
    pendingReload = false;
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
    }
  };

  return {
    handleClose(event, win, isQuitting, keepRunningInBackground = true) {
      if (isQuitting) return;
      if (!keepRunningInBackground) {
        hideAfterFullScreen = false;
        return;
      }
      event.preventDefault();
      if (win.isDestroyed()) return;
      if (win.isFullScreen()) {
        hideAfterFullScreen = true;
        win.setFullScreen(false);
      } else {
        hideAfterFullScreen = false;
        win.hide();
      }
    },
    handleLeaveFullScreen(win, isQuitting) {
      if (!hideAfterFullScreen) return;
      hideAfterFullScreen = false;
      if (!isQuitting && !win.isDestroyed()) win.hide();
    },
    handleFocusOrActivate() {
      hideAfterFullScreen = false;
    },
    requestReload(win) {
      if (win.isDestroyed()) return;
      clearPendingReload();
      pendingReload = true;
      reloadTimer = setTimeout(clearPendingReload, reloadWindowMs);
      reloadTimer.unref?.();
      win.webContents.reload();
    },
    clearPendingReload,
    handleWillPreventUnload(event, isQuitting, confirmReload, keepRunningInBackground = true, confirmClose = confirmReload) {
      if (isQuitting) {
        clearPendingReload();
        event.preventDefault();
        return;
      }
      if (pendingReload) {
        clearPendingReload();
        if (confirmReload()) event.preventDefault();
        return;
      }
      if (!keepRunningInBackground) {
        if (confirmClose()) event.preventDefault();
        return;
      }
      // Closing the main desktop window only hides it while keeping the renderer and unsaved drafts alive.
      event.preventDefault();
    },
  };
}
