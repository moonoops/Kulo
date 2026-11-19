import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNodeService, type NodeService } from "../packages/desktop/src/child-service.js";
import { desktopContentSecurityPolicy, desktopWindowChrome, externalHttpUrl, localHttpOrigin, parseDevelopmentMode, shouldAuthorizeDesktopRequest } from "../packages/desktop/src/desktop-config.js";
import { createDesktopMenuTemplate, createMainWindowCloseController, DESKTOP_APP_COMMANDS, isDesktopAppCommand, shouldRevealWindowForCommand, type DesktopAppCommand } from "../packages/desktop/src/desktop-menu.js";

const directories: string[] = [];
const services: NodeService<unknown>[] = [];
function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo desktop shell "));
  directories.push(root);
  return root;
}
function fixture(source: string, overrides: { startupTimeoutMs?: number } = {}): NodeService<string> {
  const root = directory();
  const entry = path.join(root, "service.mjs");
  fs.writeFileSync(entry, source);
  const service = startNodeService<string>({
    nodePath: process.execPath, entry, cwd: root, env: {},
    validateReady: (message) => message && typeof message === "object" && (message as { type?: unknown }).type === "ready" ? "ready" : undefined,
    shutdownTimeoutMs: 1_000,
    ...overrides,
  });
  services.push(service);
  return service;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("desktop child process lifecycle", () => {
  it("waits for a real Node process and saves before an idempotent shutdown completes", async () => {
    const marker = path.join(directory(), "saved");
    const service = fixture(`import fs from 'node:fs'; process.send({type:'ready'}); process.on('message', m => { if(m.type==='shutdown') setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'saved'); process.exit(0); }, 30); });`);
    await expect(service.ready).resolves.toBe("ready");
    const closing = service.close();
    expect(service.close()).toBe(closing);
    await closing;
    expect(fs.readFileSync(marker, "utf8")).toBe("saved");
    expect(service.child.exitCode).toBe(0);
  });

  it("surfaces startup errors and closes the failed process", async () => {
    const service = fixture("process.send({type:'error',message:'Port unavailable'}); process.on('message',()=>process.exit(0));");
    await expect(service.ready).rejects.toThrow("Port unavailable");
    await service.close();
    expect(service.child.exitCode).toBe(0);
  });

  it("cancels startup without leaving the readiness timeout or process running", async () => {
    const service = fixture("process.on('message',()=>process.exit(0));");
    const rejected = expect(service.ready).rejects.toThrow("启动已取消");
    await service.close();
    await rejected;
    expect(service.child.exitCode).toBe(0);
  });

  it("terminates a process that never becomes ready", async () => {
    const service = fixture("process.on('message',()=>{});", { startupTimeoutMs: 80 });
    await expect(service.ready).rejects.toThrow("启动超时");
    await service.close();
    expect(service.child.exitCode !== null || service.child.signalCode !== null).toBe(true);
  });
});

describe("desktop navigation and development inputs", () => {
  it("integrates macOS native controls into the renderer title strip without changing other platforms", () => {
    expect(desktopWindowChrome("darwin")).toEqual({ titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } });
    expect(desktopWindowChrome("win32")).toEqual({});
    expect(desktopWindowChrome("linux")).toEqual({});
  });
  it("allows the packaged theme bootstrap by hash and keeps arbitrary inline scripts disabled", () => {
    const policy = desktopContentSecurityPolicy('<script>alert(1)</script><script src="/assets/app.js"></script>', "http://127.0.0.1:7799", false);
    expect(policy).toContain("'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
    expect(policy.split(";").map((directive) => directive.trim()).find((directive) => directive.startsWith("script-src "))).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:7799");
  });
  it("adds management authentication only to the active window's own HTTP and websocket API requests", () => {
    const origin = "http://127.0.0.1:7799";
    const frame = { origin };
    expect(shouldAuthorizeDesktopRequest({ url: `${origin}/api/settings`, webContentsId: 7, frame }, origin, 7, frame)).toBe(true);
    expect(shouldAuthorizeDesktopRequest({ url: "ws://127.0.0.1:7799/ws/client", webContentsId: 7, frame }, origin, 7, frame)).toBe(true);
    for (const request of [
      { url: `${origin}/api/settings`, webContentsId: 8 }, { url: `${origin}/api/settings` },
      { url: "http://127.0.0.1:7788/api/settings", webContentsId: 7 },
      { url: "https://example.com/api/settings", webContentsId: 7 }, { url: `${origin}/assets/script.js`, webContentsId: 7 },
    ]) expect(shouldAuthorizeDesktopRequest({ ...request, frame }, origin, 7, frame)).toBe(false);
    expect(shouldAuthorizeDesktopRequest({ url: `${origin}/api/settings`, webContentsId: 7, frame: { origin: "null" } }, origin, 7, frame)).toBe(false);
    expect(shouldAuthorizeDesktopRequest({ url: `${origin}/api/settings`, webContentsId: 7, frame }, origin, 7, undefined)).toBe(false);
  });
  it("accepts only authenticated UI destinations supplied as clean loopback origins", () => {
    expect(localHttpOrigin("http://127.0.0.1:7799")).toBe("http://127.0.0.1:7799");
    for (const value of ["https://example.com", "http://localhost:7799", "http://127.0.0.1:7799/path", "http://127.0.0.1:7799/?token=private", "http://user:password@127.0.0.1:7799", undefined]) expect(localHttpOrigin(value)).toBeUndefined();
  });

  it("opens web links without forwarding the private desktop management token", () => {
    const token = "private-management-value";
    expect(externalHttpUrl(`https://example.com/?q=ok&token=${token}&x=${token}`, token)).toBe("https://example.com/?q=ok");
    expect(externalHttpUrl(`https://example.com/${token}`, token)).toBeUndefined();
    for (const value of ["file:///etc/passwd", "javascript:alert(1)", "kulo://action", "https://user:password@example.com"]) expect(externalHttpUrl(value, token)).toBeUndefined();
  });

  it("validates the source project and private control directory, including paths containing spaces", () => {
    const root = directory();
    const control = directory();
    fs.chmodSync(control, 0o700);
    fs.mkdirSync(path.join(root, "packages/desktop/dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/desktop/scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "kulo-monorepo" }));
    fs.writeFileSync(path.join(root, "packages/desktop/dist/runtime.js"), "");
    fs.writeFileSync(path.join(root, "packages/desktop/scripts/dev-server.mjs"), "");
    const args = [`--kulo-dev-root=${root}`, `--kulo-dev-control=${control}`];
    expect(parseDevelopmentMode(args)).toEqual({ root: fs.realpathSync(root), controlDir: fs.realpathSync(control) });
    expect(parseDevelopmentMode([])).toBeUndefined();
    expect(() => parseDevelopmentMode([`--kulo-dev-root=${root}`])).toThrow();
    fs.chmodSync(control, 0o755);
    expect(() => parseDevelopmentMode(args)).toThrow("私有目录");
  });
});

describe("desktop menu shortcuts and window close lifecycle", () => {
  it("registers standard macOS window, editing, navigation, and conversation shortcuts without gaps", () => {
    const commands: DesktopAppCommand[] = [];
    const reload = vi.fn();
    const template = createDesktopMenuTemplate({
      appName: "Kulo Dev",
      platform: "darwin",
      showUseInstalled: false,
      onFocusWindow: vi.fn(),
      onOpenDataDir: vi.fn(),
      onOpenLog: vi.fn(),
      onRestartServices: vi.fn(),
      onUseInstalled: vi.fn(),
      onCopyRepair: vi.fn(),
      onReload: reload,
      onCommand: (command) => commands.push(command),
    });

    const items = template.flatMap((section) => Array.isArray(section.submenu) ? section.submenu : []);
    expect(items.some((item) => item.role === "close" && item.label === "关闭窗口")).toBe(true);
    expect(items.some((item) => item.role === "pasteAndMatchStyle" && item.label === "粘贴并匹配样式")).toBe(true);
    expect(items.some((item) => item.role === "zoomIn" && item.accelerator === "CmdOrCtrl+=")).toBe(true);
    expect(items.some((item) => item.role === "minimize" && item.label === "最小化")).toBe(true);

    const byAccelerator = new Map(items.filter((item) => item.accelerator).map((item) => [item.accelerator!, item]));
    for (const [accelerator, expected] of [
      ["CmdOrCtrl+,", "open-settings"],
      ["CmdOrCtrl+N", "new-topic"],
      ["CmdOrCtrl+S", "save-active"],
      ["CmdOrCtrl+F", "find-in-conversation"],
      ["CmdOrCtrl+K", "search-conversations"],
      ["CmdOrCtrl+\\", "toggle-left-panel"],
      ["CmdOrCtrl+Shift+\\", "toggle-right-panel"],
      ["CmdOrCtrl+1", "open-main-chat"],
      ["CmdOrCtrl+.", "stop-generation"],
      ["CmdOrCtrl+Shift+C", "copy-last-reply"],
    ] as const) {
      const item = byAccelerator.get(accelerator);
      expect(item, `Missing menu accelerator ${accelerator}`).toBeDefined();
      item!.click?.(item as never, undefined, {} as never);
      expect(commands.at(-1)).toBe(expected);
    }

    const reloadItem = byAccelerator.get("CmdOrCtrl+R");
    expect(reloadItem).toBeDefined();
    reloadItem!.click?.(reloadItem as never, { webContents: { reload: vi.fn() } } as never, {} as never);
    expect(reload).toHaveBeenCalledTimes(1);

    for (const command of DESKTOP_APP_COMMANDS) expect(isDesktopAppCommand(command)).toBe(true);
    expect(isDesktopAppCommand("arbitrary-ipc")).toBe(false);
    expect(shouldRevealWindowForCommand("new-topic")).toBe(true);
    expect(shouldRevealWindowForCommand("open-settings")).toBe(true);
    expect(shouldRevealWindowForCommand("save-active")).toBe(false);
  });

  it("hides the main window on close, exits fullscreen before hiding, and cancels hide if re-focused", () => {
    const controller = createMainWindowCloseController();
    let fullScreen = false;
    const win = {
      isDestroyed: () => false,
      isFullScreen: () => fullScreen,
      setFullScreen: vi.fn((flag: boolean) => { fullScreen = flag; }),
      hide: vi.fn(),
      webContents: { reload: vi.fn() },
    };

    const normalClose = { preventDefault: vi.fn() };
    controller.handleClose(normalClose, win, false);
    expect(normalClose.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.hide).toHaveBeenCalledTimes(1);

    fullScreen = true;
    const fsClose = { preventDefault: vi.fn() };
    controller.handleClose(fsClose, win, false);
    expect(fsClose.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.setFullScreen).toHaveBeenCalledWith(false);
    expect(win.hide).toHaveBeenCalledTimes(1);
    controller.handleLeaveFullScreen(win, false);
    expect(win.hide).toHaveBeenCalledTimes(2);

    fullScreen = true;
    controller.handleClose({ preventDefault: vi.fn() }, win, false);
    controller.handleFocusOrActivate();
    controller.handleLeaveFullScreen(win, false);
    expect(win.hide).toHaveBeenCalledTimes(2);

    const quitClose = { preventDefault: vi.fn() };
    controller.handleClose(quitClose, win, true);
    expect(quitClose.preventDefault).not.toHaveBeenCalled();
  });

  it("allows hiding with unsaved drafts while prompting before reload", () => {
    const controller = createMainWindowCloseController();
    const win = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      setFullScreen: vi.fn(),
      hide: vi.fn(),
      webContents: { reload: vi.fn() },
    };

    // Window hide does not destroy renderer drafts, so beforeunload is bypassed cleanly.
    const hideUnload = { preventDefault: vi.fn() };
    const confirm = vi.fn(() => false);
    controller.handleWillPreventUnload(hideUnload, false, confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(hideUnload.preventDefault).toHaveBeenCalledTimes(1);

    // Explicit Cmd+R reload prompts when dirty and respects user cancellation.
    controller.requestReload(win);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    const canceledReload = { preventDefault: vi.fn() };
    controller.handleWillPreventUnload(canceledReload, false, () => false);
    expect(canceledReload.preventDefault).not.toHaveBeenCalled();

    // Confirming reload permits unloading.
    controller.requestReload(win);
    const confirmedReload = { preventDefault: vi.fn() };
    controller.handleWillPreventUnload(confirmedReload, false, () => true);
    expect(confirmedReload.preventDefault).toHaveBeenCalledTimes(1);
  });
});
