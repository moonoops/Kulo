import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAppCommand } from "./desktop-menu.js";
import type { DesktopMicrophonePermissions, DesktopPermissionKind } from "./system-permissions.js";

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

async function fileAction<T>(channel: "moco:open-file" | "moco:save-file", ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T; }
  catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "文件操作失败，请重试。";
    throw new Error(message);
  }
}

async function permissionAction<T>(channel: "moco:system-permissions-status" | "moco:system-permissions-request-microphone" | "moco:system-permissions-open-settings", ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T; }
  catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "系统权限操作失败，请重试。";
    throw new Error(message);
  }
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("mocoDesktop", {
    ready: (): Promise<void> => ipcRenderer.invoke("moco:ui-ready"),
    onCommand: (listener: (command: DesktopAppCommand) => void): (() => void) => {
      if (typeof listener !== "function") return () => {};
      const wrapped = (_event: Electron.IpcRendererEvent, command: unknown) => {
        if (typeof command === "string" && Object.hasOwn(APP_COMMANDS, command)) {
          listener(command as DesktopAppCommand);
        }
      };
      ipcRenderer.on("moco:app-command", wrapped);
      return () => { ipcRenderer.removeListener("moco:app-command", wrapped); };
    },
    openFile: (assetId: string, target: "default" | "browser"): Promise<void> => fileAction("moco:open-file", assetId, target),
    saveFile: (assetId: string): Promise<"saved" | "canceled"> => fileAction("moco:save-file", assetId),
    systemPermissions: {
      status: (): Promise<DesktopMicrophonePermissions> => permissionAction("moco:system-permissions-status"),
      requestMicrophone: (): Promise<DesktopMicrophonePermissions> => permissionAction("moco:system-permissions-request-microphone"),
      openSettings: (kind: DesktopPermissionKind): Promise<void> => permissionAction("moco:system-permissions-open-settings", kind),
    },
  });
}
