import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { configureDesktopSystemPermissionHandlers, createDesktopSystemPermissions, type DesktopPermissionState } from "../packages/desktop/src/system-permissions.js";

function fixture(initialState: Exclude<DesktopPermissionState, "unsupported"> = "not-determined", platform: NodeJS.Platform = "darwin") {
  let state = initialState;
  const microphoneStatus = vi.fn(() => state);
  const askForMicrophone = vi.fn(async () => { state = "granted"; return true; });
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => {});
  const permissions = createDesktopSystemPermissions({ platform, microphoneStatus, askForMicrophone, openExternal });
  return { microphoneStatus, askForMicrophone, openExternal, permissions, setState: (value: typeof state) => { state = value; } };
}

describe("desktop system permission actions", () => {
  it("checks microphone state silently and reports only this client's microphone", () => {
    const f = fixture("denied");
    expect(f.permissions.status()).toEqual({ platform: "darwin", permissions: [{ kind: "microphone", state: "denied" }] });
    expect(f.microphoneStatus).toHaveBeenCalledOnce();
    expect(f.askForMicrophone).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it("requests an undecided microphone grant and reads back the actual native state", async () => {
    const f = fixture();
    await expect(f.permissions.requestMicrophone()).resolves.toEqual({ platform: "darwin", permissions: [{ kind: "microphone", state: "granted" }] });
    expect(f.askForMicrophone).toHaveBeenCalledOnce();
    expect(f.openExternal).not.toHaveBeenCalled();
    f.setState("denied");
    await expect(f.permissions.requestMicrophone()).resolves.toMatchObject({ permissions: [{ state: "denied" }] });
    expect(f.askForMicrophone).toHaveBeenCalledOnce();
    expect(f.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  });

  it("does not interpret a dismissed or denied prompt as an authorized microphone", async () => {
    const f = fixture();
    f.askForMicrophone.mockImplementation(async () => { f.setState("denied"); return false; });
    await expect(f.permissions.requestMicrophone()).resolves.toMatchObject({ permissions: [{ state: "denied" }] });
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it.each(["granted", "restricted", "unknown"] as const)("does not open a prompt for native %s status", async (state) => {
    const f = fixture(state);
    await expect(f.permissions.requestMicrophone()).resolves.toMatchObject({ permissions: [{ state }] });
    expect(f.askForMicrophone).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("returns unsupported on %s without calling macOS APIs", async (platform) => {
    const f = fixture("granted", platform);
    expect(f.permissions.status()).toEqual({ platform, permissions: [{ kind: "microphone", state: "unsupported" }] });
    await expect(f.permissions.requestMicrophone()).resolves.toMatchObject({ permissions: [{ state: "unsupported" }] });
    await expect(f.permissions.openSettings("microphone")).rejects.toThrow("不支持");
    expect(f.microphoneStatus).not.toHaveBeenCalled();
    expect(f.askForMicrophone).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous requests and releases the pending request after rejection", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.askForMicrophone.mockImplementationOnce(() => new Promise<boolean>((_, fail) => { reject = fail; }));
    const first = f.permissions.requestMicrophone();
    expect(f.permissions.requestMicrophone()).toBe(first);
    expect(f.askForMicrophone).toHaveBeenCalledOnce();
    reject(new Error("Native request unavailable"));
    await expect(first).rejects.toThrow("Native request unavailable");
    await expect(f.permissions.requestMicrophone()).resolves.toMatchObject({ permissions: [{ state: "granted" }] });
    expect(f.askForMicrophone).toHaveBeenCalledTimes(2);
  });

  it("opens only fixed privacy destinations and propagates system settings failures", async () => {
    const f = fixture();
    await f.permissions.openSettings("accessibility");
    await f.permissions.openSettings("screen");
    expect(f.openExternal.mock.calls.map(([url]) => url)).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
    for (const kind of ["camera", "microphone?foo", "__proto__", "https://example.com", undefined, {}, ["microphone"]]) {
      await expect(f.permissions.openSettings(kind)).rejects.toThrow("类型无效");
    }
    expect(f.openExternal).toHaveBeenCalledTimes(2);
    f.openExternal.mockRejectedValueOnce(new Error("Settings could not open"));
    await expect(f.permissions.openSettings("microphone")).rejects.toThrow("Settings could not open");
  });
});

describe("desktop system permission IPC", () => {
  function ipcFixture() {
    const f = fixture();
    const origin = "http://127.0.0.1:7799";
    const mainFrame = { origin };
    const owner = { isDestroyed: vi.fn(() => false), webContents: { mainFrame, isDestroyed: vi.fn(() => false) } };
    const event = { sender: owner.webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const handle = vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); });
    let activeOwner: typeof owner | undefined = owner;
    let activeOrigin: string | undefined = origin;
    configureDesktopSystemPermissionHandlers({ ipc: { handle } as Pick<IpcMain, "handle">, permissions: f.permissions, owner: () => activeOwner, rendererOrigin: () => activeOrigin });
    const invoke = (channel: string, sender = event, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(sender, ...args));
    return { ...f, owner, event, invoke, setOwner: (value: typeof activeOwner) => { activeOwner = value; }, setOrigin: (value: typeof activeOrigin) => { activeOrigin = value; } };
  }

  it("registers separate read, request and fixed-settings actions for the trusted main frame", async () => {
    const f = ipcFixture();
    await expect(f.invoke("moco:system-permissions-status")).resolves.toMatchObject({ permissions: [{ state: "not-determined" }] });
    expect(f.askForMicrophone).not.toHaveBeenCalled();
    await expect(f.invoke("moco:system-permissions-request-microphone")).resolves.toMatchObject({ permissions: [{ state: "granted" }] });
    await f.invoke("moco:system-permissions-open-settings", f.event, "screen");
    expect(f.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });

  it("rejects other windows, same-origin subframes and navigated frames before inspecting native state", async () => {
    const f = ipcFixture();
    const invalid = [
      { sender: {}, senderFrame: f.owner.webContents.mainFrame },
      { sender: f.owner.webContents, senderFrame: { origin: "http://127.0.0.1:7799" } },
      { sender: f.owner.webContents, senderFrame: null },
    ];
    for (const event of invalid) {
      for (const channel of ["moco:system-permissions-status", "moco:system-permissions-request-microphone", "moco:system-permissions-open-settings"]) {
        await expect(f.invoke(channel, event as unknown as IpcMainInvokeEvent, "microphone")).rejects.toThrow("无法从此页面");
      }
    }
    f.owner.webContents.mainFrame.origin = "https://example.com";
    await expect(f.invoke("moco:system-permissions-status")).rejects.toThrow("无法从此页面");
    expect(f.microphoneStatus).not.toHaveBeenCalled();
    expect(f.askForMicrophone).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it("rejects destroyed or missing windows and an unavailable renderer origin", async () => {
    const f = ipcFixture();
    f.owner.webContents.isDestroyed.mockReturnValue(true);
    await expect(f.invoke("moco:system-permissions-status")).rejects.toThrow("无法从此页面");
    f.owner.webContents.isDestroyed.mockReturnValue(false);
    f.owner.isDestroyed.mockReturnValue(true);
    await expect(f.invoke("moco:system-permissions-request-microphone")).rejects.toThrow("无法从此页面");
    f.owner.isDestroyed.mockReturnValue(false);
    f.setOrigin(undefined);
    await expect(f.invoke("moco:system-permissions-status")).rejects.toThrow("无法从此页面");
    f.setOrigin("http://127.0.0.1:7799");
    f.setOwner(undefined);
    await expect(f.invoke("moco:system-permissions-open-settings", f.event, "screen")).rejects.toThrow("无法从此页面");
    expect(f.microphoneStatus).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it("rejects unexpected IPC arguments and cannot open arbitrary native URLs", async () => {
    const f = ipcFixture();
    await expect(f.invoke("moco:system-permissions-status", f.event, {})).rejects.toThrow("参数无效");
    await expect(f.invoke("moco:system-permissions-request-microphone", f.event, "camera")).rejects.toThrow("参数无效");
    await expect(f.invoke("moco:system-permissions-open-settings", f.event)).rejects.toThrow("参数无效");
    await expect(f.invoke("moco:system-permissions-open-settings", f.event, "screen", "extra")).rejects.toThrow("参数无效");
    await expect(f.invoke("moco:system-permissions-open-settings", f.event, "file:///private")).rejects.toThrow("类型无效");
    expect(f.microphoneStatus).not.toHaveBeenCalled();
    expect(f.askForMicrophone).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });
});
