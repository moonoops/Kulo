import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { SystemPermissionKind, SystemPermissionSettingsKind, SystemPermissionState } from "@kulo/protocol";
import { isTrustedFileActionSender } from "./file-actions.js";

export type DesktopPermissionKind = SystemPermissionKind;
export type DesktopPermissionSettingsKind = SystemPermissionSettingsKind;
export type DesktopPermissionState = SystemPermissionState;

export interface DesktopMicrophonePermissions {
  platform: string;
  permissions: { kind: "microphone"; state: DesktopPermissionState }[];
}

export interface DesktopSystemPermissionsOptions {
  platform: NodeJS.Platform;
  microphoneStatus(): Exclude<DesktopPermissionState, "unsupported">;
  askForMicrophone(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
}

const settingsUrls: Record<DesktopPermissionSettingsKind, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  "local-network": "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
};

export function createDesktopSystemPermissions(options: DesktopSystemPermissionsOptions) {
  let requesting: Promise<DesktopMicrophonePermissions> | undefined;

  function status(): DesktopMicrophonePermissions {
    return { platform: options.platform, permissions: [{ kind: "microphone", state: options.platform === "darwin" ? options.microphoneStatus() : "unsupported" }] };
  }

  async function openSettings(value: unknown): Promise<void> {
    if (typeof value !== "string" || !Object.hasOwn(settingsUrls, value)) throw new Error("系统权限类型无效。");
    if (options.platform !== "darwin") throw new Error("此系统不支持打开 macOS 权限设置。");
    await options.openExternal(settingsUrls[value as DesktopPermissionSettingsKind]);
  }

  async function request(): Promise<DesktopMicrophonePermissions> {
    const current = status();
    const state = current.permissions[0]!.state;
    if (state === "denied") await openSettings("microphone");
    else if (state === "not-determined") await options.askForMicrophone();
    // Re-read native status; opening Settings or returning from a prompt does not prove a grant.
    return status();
  }

  function requestMicrophone(): Promise<DesktopMicrophonePermissions> {
    if (!requesting) {
      const pending = request();
      requesting = pending;
      const clear = () => { if (requesting === pending) requesting = undefined; };
      void pending.then(clear, clear);
    }
    return requesting;
  }

  return { status, requestMicrophone, openSettings };
}

export function configureDesktopSystemPermissionHandlers(options: {
  ipc: Pick<IpcMain, "handle">;
  permissions: ReturnType<typeof createDesktopSystemPermissions>;
  owner(): Parameters<typeof isTrustedFileActionSender>[1];
  rendererOrigin(): string | undefined;
}): void {
  function authorize(event: IpcMainInvokeEvent): void {
    if (!isTrustedFileActionSender(event, options.owner(), options.rendererOrigin())) throw new Error("无法从此页面管理系统权限。");
  }
  options.ipc.handle("kulo:system-permissions-status", (event, ...args: unknown[]) => {
    authorize(event);
    if (args.length) throw new Error("系统权限参数无效。");
    return options.permissions.status();
  });
  options.ipc.handle("kulo:system-permissions-request-microphone", (event, ...args: unknown[]) => {
    authorize(event);
    if (args.length) throw new Error("系统权限参数无效。");
    return options.permissions.requestMicrophone();
  });
  options.ipc.handle("kulo:system-permissions-open-settings", (event, ...args: unknown[]) => {
    authorize(event);
    if (args.length !== 1) throw new Error("系统权限参数无效。");
    return options.permissions.openSettings(args[0]);
  });
}
