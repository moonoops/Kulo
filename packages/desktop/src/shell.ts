import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, systemPreferences, Tray } from "electron";
import { RecoveryManager, readReleaseIdentity } from "@kulo/recovery";
import { buildRuntimeEnvironment } from "./runtime-config.js";
import { startNodeService, type NodeService } from "./child-service.js";
import { DESKTOP_APP_NAME, desktopContentSecurityPolicy, desktopWindowChrome, externalHttpUrl, localHttpOrigin, parseDevelopmentMode, resolveDesktopDataDirectory, shouldAuthorizeDesktopRequest, type DevelopmentMode } from "./desktop-config.js";
import { createDesktopMenuTemplate, createMainWindowCloseController, shouldRevealWindowForCommand, type DesktopAppCommand } from "./desktop-menu.js";
import { configureDesktopPreferenceHandlers, createDesktopPreferencesStore, DESKTOP_PREFERENCES_CHANNELS } from "./desktop-preferences.js";
import { createDesktopTrayController, loadDesktopTrayIcon } from "./desktop-tray.js";
import { createDesktopFileActions, isTrustedFileActionSender, type DesktopFileConnection } from "./file-actions.js";
import { createDesktopNotifications } from "./notifications.js";
import { configureDesktopSystemPermissionHandlers, createDesktopSystemPermissions } from "./system-permissions.js";
import { DesktopStartupReady } from "./startup-ready.js";
import { configureDesktopUiFailureHandler } from "./ui-failure.js";
import { writeDesktopLog } from "./desktop-log.js";

app.setName(DESKTOP_APP_NAME);
const dataDir = resolveDesktopDataDirectory(process.argv, path.join(app.getPath("appData"), DESKTOP_APP_NAME));
fs.mkdirSync(path.join(dataDir, "chromium"), { recursive: true, mode: 0o700 });
app.setPath("userData", dataDir);
app.setPath("sessionData", path.join(dataDir, "chromium"));

let window: BrowserWindow | undefined;
let runtime: NodeService<RuntimeReady> | undefined;
let developmentServer: NodeService<string> | undefined;
let development: DevelopmentMode | undefined;
let controlWatcher: fs.FSWatcher | undefined;
let rendererOrigin: string | undefined;
let contentSecurityPolicy: string | undefined;
let managementToken: string | undefined;
let fileConnection: DesktopFileConnection | undefined;
let quitting = false;
let booting = false;
let startupFailure: Error | undefined;
let transition = Promise.resolve();
let recoveryDialog = false;
let requestId = "";
let recovery: RecoveryManager | undefined;
let launchAttempt: Awaited<ReturnType<RecoveryManager["prepareLaunch"]>> | undefined;
let recoveryRequestedFor: string | undefined;
const uiReady = new DesktopStartupReady();
const closeController = createMainWindowCloseController();
const trayIconPath = fileURLToPath(new URL("../assets/kulo-trayTemplate.png", import.meta.url));
const trayController = createDesktopTrayController({
  appName: DESKTOP_APP_NAME,
  platform: process.platform,
  createTray: () => new Tray(loadDesktopTrayIcon(trayIconPath, (file) => nativeImage.createFromPath(file), process.platform)),
  buildMenu: (template) => Menu.buildFromTemplate(template),
  onFocusWindow: () => focusWindow(),
  onNewTopic: () => dispatchWindowCommand("new-topic"),
  onOpenSettings: () => dispatchWindowCommand("open-settings"),
  onQuit: () => app.quit(),
  onLog: (message) => log(message),
});
const desktopPreferences = createDesktopPreferencesStore({
  dataDir,
  onChange: (next) => {
    trayController.sync(next.backgroundRunning);
    if (!next.backgroundRunning && window && !window.isDestroyed() && !window.isVisible()) {
      focusWindow();
    }
    if (window && !window.isDestroyed() && trustedRenderer(window.webContents.mainFrame?.origin)) {
      window.webContents.send(DESKTOP_PREFERENCES_CHANNELS.changed, next);
    }
  },
  onLog: (message) => log(message),
});

interface RuntimeReady { url: string; token: string }

const fileActions = createDesktopFileActions({
  dataDir,
  connection: () => fileConnection,
  openPath: (file) => shell.openPath(file),
  openExternal: (url) => shell.openExternal(url),
  chooseSavePath: async (name) => {
    if (!window || window.isDestroyed()) throw new Error("窗口已关闭。");
    const result = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath("downloads"), name) });
    return result.canceled ? undefined : result.filePath;
  },
});

const systemPermissions = createDesktopSystemPermissions({
  platform: process.platform,
  microphoneStatus: () => systemPreferences.getMediaAccessStatus("microphone"),
  askForMicrophone: () => systemPreferences.askForMediaAccess("microphone"),
  openExternal: (url) => shell.openExternal(url),
});

const activeNotifications = new Set<Notification>();
const desktopNotifications = createDesktopNotifications({
  isSupported: () => Notification.isSupported(),
  isWindowFocused: () => Boolean(window && !window.isDestroyed() && window.isVisible() && window.isFocused()),
  showNotification: (payload, onClick) => {
    const notification = new Notification({
      title: payload.title,
      ...(payload.body ? { body: payload.body } : {}),
    });
    activeNotifications.add(notification);
    notification.on("click", () => {
      activeNotifications.delete(notification);
      onClick();
    });
    notification.on("close", () => {
      activeNotifications.delete(notification);
    });
    notification.show();
  },
  onFocusWindow: () => focusWindow(),
});

function configureFileActions(): void {
  const authorize = (event: Parameters<typeof isTrustedFileActionSender>[0]) => {
    if (!isTrustedFileActionSender(event, window, rendererOrigin)) throw new Error("无法从此页面打开文件。");
  };
  ipcMain.handle("kulo:open-file", async (event, assetId: unknown, target: unknown) => {
    authorize(event);
    await fileActions.openFile(assetId, target);
  });
  ipcMain.handle("kulo:save-file", async (event, assetId: unknown) => {
    authorize(event);
    return fileActions.saveFile(assetId);
  });
  ipcMain.handle("kulo:ui-ready", (event) => {
    authorize(event);
    uiReady.acknowledge(event.sender.id, event.senderFrame!.origin);
  });
  ipcMain.handle("kulo:notify", (event, payload: unknown) => {
    authorize(event);
    desktopNotifications.notify(payload);
  });
}

function log(message: string): void {
  writeDesktopLog(dataDir, message, managementToken);
}

function writePrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function focusWindow(): void {
  if (!window || window.isDestroyed()) return;
  closeController.handleFocusOrActivate();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  app.focus({ steal: true });
}

function dispatchWindowCommand(command: DesktopAppCommand): void {
  if (quitting || booting || !window || window.isDestroyed()) return;
  if (!window.isVisible()) {
    if (!shouldRevealWindowForCommand(command)) return;
    focusWindow();
  }
  if (!trustedRenderer(window.webContents.mainFrame?.origin)) return;
  window.webContents.send("kulo:app-command", command);
}

async function openExternal(value: string): Promise<void> {
  const target = externalHttpUrl(value, managementToken);
  if (!target) return;
  try { await shell.openExternal(target); }
  catch { dialog.showErrorBox("无法打开链接", "请检查系统默认浏览器。"); }
}

function trustedRenderer(origin: string | undefined): boolean {
  if (!origin || !rendererOrigin) return false;
  try { return new URL(origin).origin === rendererOrigin; }
  catch { return false; }
}

function configureSession(): void {
  const browserSession = session.fromPartition("persist:kulo-dev");
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    if (contentSecurityPolicy && details.webContentsId === window?.webContents.id && trustedRenderer(details.url) && details.resourceType === "mainFrame") {
      responseHeaders["Content-Security-Policy"] = [contentSecurityPolicy];
      responseHeaders["Referrer-Policy"] = ["no-referrer"];
    }
    callback({ responseHeaders });
  });
  // Keep the private management credential out of renderer URLs, browser history and link referrers.
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (managementToken && shouldAuthorizeDesktopRequest(details, rendererOrigin, window?.webContents.id, window?.webContents.mainFrame)) {
      requestHeaders.Authorization = `Bearer ${managementToken}`;
    }
    callback({ requestHeaders });
  });
  browserSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (contents !== window?.webContents || !trustedRenderer(origin) || !details.isMainFrame) return false;
    if (permission === "media") return details.mediaType === "audio" && systemPreferences.getMediaAccessStatus("microphone") !== "denied";
    return permission === "fullscreen" || permission === "clipboard-sanitized-write";
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (contents !== window?.webContents || !trustedRenderer(details.requestingUrl) || !details.isMainFrame) { callback(false); return; }
    if (permission === "media") {
      const types = "mediaTypes" in details ? details.mediaTypes : undefined;
      if (!types?.length || types.some((type) => type !== "audio")) { callback(false); return; }
      void systemPreferences.askForMediaAccess("microphone").then(callback).catch(() => callback(false));
      return;
    }
    callback(permission === "fullscreen" || permission === "clipboard-sanitized-write");
  });
}

function createWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;
  const created = new BrowserWindow({
    title: DESKTOP_APP_NAME,
    ...desktopWindowChrome(process.platform),
    width: 1380, height: 920, minWidth: 400, minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#ffffff",
    webPreferences: {
      partition: "persist:kulo-dev",
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
    },
  });
  window = created;
  configureDesktopUiFailureHandler({
    contents: created.webContents, rendererOrigin: () => rendererOrigin,
    isBooting: () => booting, isQuitting: () => quitting,
    failStartup: (error) => { startupFailure = error; uiReady.cancel(error); },
    recover, checkFailed: () => log("界面状态检查未完成。"),
  });
  created.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: "deny" }; });
  created.webContents.on("will-navigate", (event, url) => {
    if (!trustedRenderer(url)) { event.preventDefault(); void openExternal(url); }
  });
  created.webContents.on("will-attach-webview", (event) => event.preventDefault());
  created.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeController.clearPendingReload();
  });
  created.webContents.on("will-prevent-unload", (event) => {
    const keepRunningInBackground = desktopPreferences.get().backgroundRunning;
    closeController.handleWillPreventUnload(
      event,
      quitting,
      () => dialog.showMessageBoxSync(created, {
        type: "question",
        buttons: ["重新加载", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: DESKTOP_APP_NAME,
        message: "重新加载将丢失未保存的修改",
        detail: "当前设置存在尚未保存的草稿。是否放弃修改并重新加载界面？",
      }) === 0,
      keepRunningInBackground,
      () => dialog.showMessageBoxSync(created, {
        type: "question",
        buttons: ["放弃并退出", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: DESKTOP_APP_NAME,
        message: "关闭窗口将丢失未保存的修改",
        detail: "当前设置存在尚未保存的草稿。是否放弃修改并退出 Kulo？",
      }) === 0,
    );
  });
  created.on("close", (event) => closeController.handleClose(event, created, quitting, desktopPreferences.get().backgroundRunning));
  created.on("leave-full-screen", () => closeController.handleLeaveFullScreen(created, quitting));
  created.on("closed", () => {
    closeController.clearPendingReload();
    if (window === created) window = undefined;
  });
  created.webContents.on("render-process-gone", (_event, details) => {
    log(`界面进程退出：${details.reason}`);
    if (!quitting) void recover("界面进程已退出，请重新打开窗口。");
  });
  return created;
}

function updateMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createDesktopMenuTemplate({
    appName: DESKTOP_APP_NAME,
    platform: process.platform,
    showUseInstalled: Boolean(app.isPackaged && development),
    onFocusWindow: focusWindow,
    onOpenDataDir: () => { void shell.openPath(dataDir); },
    onOpenLog: () => { void shell.openPath(path.join(dataDir, "desktop.log")); },
    onRestartServices: () => requestStart(development),
    onUseInstalled: () => requestStart(undefined),
    onCopyRepair: () => { void copyRepairInstructions(); },
    onReload: (focusedWindow) => {
      if (window && !window.isDestroyed() && (!focusedWindow || focusedWindow === window)) {
        closeController.requestReload(window);
      } else {
        focusedWindow?.webContents?.reload();
      }
    },
    onCommand: dispatchWindowCommand,
  })));
}

async function copyRepairInstructions(): Promise<void> {
  let instructions = `Kulo 数据目录：${dataDir}`;
  try { instructions = await (recovery ?? new RecoveryManager(dataDir)).repairInstructions(); }
  catch { instructions += "\n恢复索引无法读取，请使用独立入口检查。"; }
  const launcher = app.isPackaged ? path.join(process.resourcesPath, "runtime/kulo-rescue") : undefined;
  clipboard.writeText(`${instructions}${launcher ? `\n独立救援入口：${launcher}` : ""}`);
}

async function stopServices(releaseLease = true): Promise<void> {
  uiReady.cancel();
  rendererOrigin = undefined;
  const vite = developmentServer;
  const hub = runtime;
  developmentServer = undefined;
  runtime = undefined;
  fileConnection = undefined;
  const results = await Promise.allSettled([vite?.close(), hub?.close()]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (releaseLease && launchAttempt && recovery) {
    await recovery.markStopped(launchAttempt.attemptId);
    launchAttempt = undefined;
  }
}

function watchDevelopmentControl(mode: DevelopmentMode): void {
  const file = path.join(mode.controlDir, "request.json");
  const consume = () => {
    if (quitting || !fs.existsSync(file)) return;
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown; action?: unknown };
      if (typeof value.id !== "string" || value.id === requestId) return;
      requestId = value.id;
      if (value.action === "reload") requestStart(mode);
      else if (value.action === "quit") app.quit();
    } catch (error) { log(`开发控制请求失败：${error instanceof Error ? error.message : "无效请求"}`); }
  };
  controlWatcher = fs.watch(mode.controlDir, (_event, filename) => {
    if (filename === "request.json") consume();
  });
  consume();
}

async function startServices(mode: DevelopmentMode | undefined): Promise<void> {
  booting = true;
  startupFailure = undefined;
  if (development?.controlDir !== mode?.controlDir) {
    controlWatcher?.close();
    controlWatcher = undefined;
    if (mode) watchDevelopmentControl(mode);
  }
  development = mode;
  await stopServices();
  if (quitting) return;
  const appDir = app.getAppPath();
  const nodePath = app.isPackaged ? path.join(process.resourcesPath, "runtime/node") : process.env.KULO_DESKTOP_NODE_PATH;
  if (!nodePath || !path.isAbsolute(nodePath)) throw new Error("未找到 Kulo 自带的 Node 运行环境。");
  fs.accessSync(nodePath, fs.constants.X_OK);
  if (app.isPackaged && !mode && !recovery) {
    const manifest = readReleaseIdentity(appDir);
    recovery = new RecoveryManager(dataDir, {
      shellVersion: app.getVersion(), nodeMajor: manifest.nodeMajor, protocolVersion: 1, dataVersion: 2,
    });
    await recovery.initializeBaseline(appDir, manifest);
  }
  launchAttempt = app.isPackaged && !mode && recovery ? await recovery.prepareLaunch() : undefined;
  const selectedRoot = launchAttempt?.root ?? appDir;
  const webDir = mode ? path.join(mode.root, "packages/web/dist") : path.join(selectedRoot, launchAttempt?.manifest.webDir ?? "web/dist");
  const entry = mode ? path.join(mode.root, "packages/desktop/dist/runtime.js") : path.join(selectedRoot, launchAttempt?.manifest.runtimeEntry ?? "dist/runtime.js");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const env = buildRuntimeEnvironment(process.env, {
    dataDir, webDir,
    ...(!mode ? { appRoot: selectedRoot, trustedRoot: appDir, shellVersion: app.getVersion() } : {}),
  });
  const service = startNodeService<RuntimeReady>({
    nodePath, entry, cwd: dataDir, env,
    validateReady: (message) => {
      if (!message || typeof message !== "object") return;
      const value = message as { type?: unknown; url?: unknown; token?: unknown };
      const url = localHttpOrigin(value.url);
      if (value.type === "ready" && url && typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token)) return { url, token: value.token };
    },
    onOutput: (text) => log(text.trimEnd()),
    onExit: (code, signal) => {
      log(`Hub 进程退出：${code ?? signal}`);
      if (!quitting && !booting && runtime === service) void recover("后台服务已退出。");
    },
  });
  runtime = service;
  if (launchAttempt && recovery && service.child.pid) await recovery.trackProcess(launchAttempt.attemptId, service.child.pid);
  const ready = await service.ready;
  if (quitting) return;
  managementToken = ready.token;
  fileConnection = ready;
  let uiOrigin = ready.url;
  if (mode) {
    const server = startNodeService<string>({
      nodePath, entry: path.join(mode.root, "packages/desktop/scripts/dev-server.mjs"), cwd: dataDir,
      env: { ...env, KULO_DESKTOP_DEV_ROOT: mode.root, KULO_DESKTOP_HUB_URL: ready.url },
      validateReady: (message) => {
        if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "ready") return;
        return localHttpOrigin((message as { url?: unknown }).url);
      },
      onOutput: (text) => log(text.trimEnd()),
      onExit: () => { if (!quitting && !booting && developmentServer === server) void recover("开发服务器已退出。"); },
    });
    developmentServer = server;
    uiOrigin = await server.ready;
    if (quitting) return;
  }
  rendererOrigin = uiOrigin;
  contentSecurityPolicy = desktopContentSecurityPolicy(fs.readFileSync(path.join(webDir, "index.html"), "utf8"), uiOrigin, Boolean(mode));
  const created = createWindow();
  created.webContents.setBackgroundThrottling(!mode);
  const rendererReady = uiReady.wait(created.webContents.id, uiOrigin);
  try { await Promise.all([created.loadURL(uiOrigin), rendererReady]); }
  catch (error) { uiReady.cancel(error instanceof Error ? error : new Error("界面启动失败。")); throw error; }
  if (quitting) return;
  if (startupFailure) throw startupFailure;
  if (service.child.exitCode !== null || service.child.signalCode !== null) throw new Error("后台服务在界面就绪前退出。");
  if (launchAttempt && recovery) await recovery.markReady(launchAttempt.attemptId);
  if (startupFailure) throw startupFailure;
  created.setTitle(mode ? "Kulo Dev · 开发模式" : DESKTOP_APP_NAME);
  focusWindow();
  updateMenu();
  const status = { pid: process.pid, mode: mode ? "development" : "installed", hubOrigin: ready.url, rendererOrigin: uiOrigin,
    ...(launchAttempt ? { compositionId: launchAttempt.releaseId } : {}) };
  writePrivateJson(path.join(dataDir, "desktop-status.json"), status);
  if (mode) writePrivateJson(path.join(mode.controlDir, "ready.json"), status);
  booting = false;
  log(`Kulo Dev 已启动（${status.mode}）。`);
}

async function recover(message: string): Promise<void> {
  if (recoveryDialog || quitting) return;
  if (recovery && launchAttempt && !development) {
    if (recoveryRequestedFor === launchAttempt.attemptId) return;
    recoveryRequestedFor = launchAttempt.attemptId;
    requestStart(undefined, { attemptId: launchAttempt.attemptId, error: new Error(message) });
    return;
  }
  await showRecoveryDialog();
}

async function showRecoveryDialog(): Promise<void> {
  if (recoveryDialog || quitting) return;
  recoveryDialog = true;
  const result = await dialog.showMessageBox({ type: "error", title: DESKTOP_APP_NAME, message: "Kulo 暂时无法启动。",
    buttons: ["重试修复", "复制修复信息", "退出"], defaultId: 0, cancelId: 2 });
  recoveryDialog = false;
  if (result.response === 0) requestStart(development);
  else if (result.response === 1) { await copyRepairInstructions(); app.quit(); }
  else app.quit();
}

async function recordFailedAttempt(error: unknown): Promise<boolean> {
  const failedAttempt = launchAttempt;
  await stopServices(false);
  if (!failedAttempt || !recovery) return false;
  const fallback = await recovery.markFailed(failedAttempt.attemptId, error);
  launchAttempt = undefined;
  return fallback !== null;
}

function requestStart(mode: DevelopmentMode | undefined, failure?: { attemptId: string; error: Error }): void {
  transition = transition.then(async () => {
    if (quitting) return;
    try {
      if (failure && launchAttempt?.attemptId !== failure.attemptId) return;
      if (failure && !await recordFailedAttempt(failure.error)) throw failure.error;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await startServices(mode); return; }
        catch (error) {
          booting = false;
          if (mode || !await recordFailedAttempt(error) || attempt === 2) throw error;
        }
      }
    }
    catch (error) {
      booting = false;
      await stopServices().catch((cause: unknown) => log(cause instanceof Error ? cause.message : "后台关闭失败。"));
      const message = error instanceof Error ? error.message : "Kulo 启动失败。";
      log(message);
      if (!quitting) await showRecoveryDialog();
    } finally {
      if (failure && recoveryRequestedFor === failure.attemptId) recoveryRequestedFor = undefined;
    }
  });
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else if (process.argv.includes("--kulo-quit")) {
  app.quit();
} else {
  writePrivateJson(path.join(dataDir, "desktop-status.json"), { pid: process.pid, mode: "starting" });
  app.on("second-instance", (_event, args) => {
    if (args.includes("--kulo-quit")) { app.quit(); return; }
    try {
      const mode = parseDevelopmentMode(args);
      if (mode) requestStart(mode);
      else focusWindow();
    } catch (error) { dialog.showErrorBox("无法进入开发模式", error instanceof Error ? error.message : "无效开发配置。"); }
  });
  app.on("activate", () => focusWindow());
  app.on("window-all-closed", () => {
    if (quitting || booting || recoveryDialog) return;
    if (!desktopPreferences.get().backgroundRunning) app.quit();
  });
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    trayController.dispose();
    controlWatcher?.close();
    controlWatcher = undefined;
    void Promise.all([stopServices(), fileActions.close()]).then(() => {
      fs.rmSync(path.join(dataDir, "desktop-status.json"), { force: true });
      app.exit(0);
    }).catch((error: unknown) => { log(error instanceof Error ? error.message : "后台关闭失败。"); app.exit(1); });
  });
  process.once("SIGINT", () => app.quit());
  process.once("SIGTERM", () => app.quit());
  void app.whenReady().then(() => {
    configureSession();
    configureFileActions();
    configureDesktopPreferenceHandlers({ ipc: ipcMain, preferences: desktopPreferences, owner: () => window, rendererOrigin: () => rendererOrigin });
    configureDesktopSystemPermissionHandlers({ ipc: ipcMain, permissions: systemPermissions, owner: () => window, rendererOrigin: () => rendererOrigin });
    trayController.sync(desktopPreferences.get().backgroundRunning);
    powerMonitor.on("resume", () => {
      if (quitting || !runtime?.child.connected) return;
      runtime.child.send({ type: "system-resume" }, () => {});
    });
    app.setAboutPanelOptions({ applicationName: DESKTOP_APP_NAME, applicationVersion: app.getVersion(), copyright: "Kulo" });
    updateMenu();
    requestStart(parseDevelopmentMode(process.argv));
  }).catch((error: unknown) => {
    log(error instanceof Error ? error.message : "无法初始化桌面客户端。");
    void showRecoveryDialog();
  });
}
