import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAppCommand } from "./desktop-menu.js";
import type { DesktopPreferences } from "./desktop-preferences.js";
import type { DesktopMicrophonePermissions, DesktopPermissionSettingsKind } from "./system-permissions.js";

const APP_COMMANDS: Record<DesktopAppCommand, true> = {
  "new-topic": true,
  "open-settings": true,
  "search-conversations": true,
  "find-in-conversation": true,
  "toggle-left-panel": true,
  "toggle-right-panel": true,
  "open-main-chat": true,
  "stop-generation": true,
  "copy-last-reply": true,
  "save-active": true,
};

async function fileAction<T>(channel: "kulo:open-file" | "kulo:save-file", ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T; }
  catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "文件操作失败，请重试。";
    throw new Error(message);
  }
}

async function permissionAction<T>(channel: "kulo:system-permissions-status" | "kulo:system-permissions-request-microphone" | "kulo:system-permissions-open-settings", ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T; }
  catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "系统权限操作失败，请重试。";
    throw new Error(message);
  }
}

async function preferencesAction<T>(channel: "kulo:desktop-preferences-get" | "kulo:desktop-preferences-set", ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T; }
  catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "桌面偏好操作失败，请重试。";
    throw new Error(message);
  }
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("kuloDesktop", {
    ready: (): Promise<void> => ipcRenderer.invoke("kulo:ui-ready"),
    onCommand: (listener: (command: DesktopAppCommand) => void): (() => void) => {
      if (typeof listener !== "function") return () => {};
      const wrapped = (_event: Electron.IpcRendererEvent, command: unknown) => {
        if (typeof command === "string" && Object.hasOwn(APP_COMMANDS, command)) {
          listener(command as DesktopAppCommand);
        }
      };
      ipcRenderer.on("kulo:app-command", wrapped);
      return () => { ipcRenderer.removeListener("kulo:app-command", wrapped); };
    },
    openFile: (assetId: string, target: "default" | "browser"): Promise<void> => fileAction("kulo:open-file", assetId, target),
    saveFile: (assetId: string): Promise<"saved" | "canceled"> => fileAction("kulo:save-file", assetId),
    notify: (payload: { title: string; body?: string; topicId?: string }): Promise<void> =>
      ipcRenderer.invoke("kulo:notify", payload),
    preferences: {
      get: (): Promise<DesktopPreferences> => preferencesAction("kulo:desktop-preferences-get"),
      set: (patch: Partial<DesktopPreferences>): Promise<DesktopPreferences> => preferencesAction("kulo:desktop-preferences-set", patch),
      onChange: (listener: (preferences: DesktopPreferences) => void): (() => void) => {
        if (typeof listener !== "function") return () => {};
        const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
          if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { backgroundRunning?: unknown }).backgroundRunning === "boolean") {
            listener({ backgroundRunning: (value as DesktopPreferences).backgroundRunning });
          }
        };
        ipcRenderer.on("kulo:desktop-preferences-changed", wrapped);
        return () => { ipcRenderer.removeListener("kulo:desktop-preferences-changed", wrapped); };
      },
    },
    systemPermissions: {
      status: (): Promise<DesktopMicrophonePermissions> => permissionAction("kulo:system-permissions-status"),
      requestMicrophone: (): Promise<DesktopMicrophonePermissions> => permissionAction("kulo:system-permissions-request-microphone"),
      openSettings: (kind: DesktopPermissionSettingsKind): Promise<void> => permissionAction("kulo:system-permissions-open-settings", kind),
    },
  });
}
