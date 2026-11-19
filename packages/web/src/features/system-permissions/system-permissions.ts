import { isDesktopSystemPermissions, type DesktopSystemPermissions, type SystemPermissionKind, type SystemPermissionStatus } from "@moco/protocol";
import { apiRequest } from "../../moco-api";
import { translate as t } from "../../moco-i18n";

export interface SystemPermissionEntry {
  id: string;
  kind: SystemPermissionKind;
  envId?: string;
}

export interface DesktopSystemPermissionBridge {
  status(): Promise<{ platform: string; permissions: SystemPermissionStatus[] }>;
  requestMicrophone(): Promise<{ platform: string; permissions: SystemPermissionStatus[] }>;
  openSettings(kind: SystemPermissionKind): Promise<void>;
}

let observedMicrophoneAccess: boolean | undefined;

export function noteMicrophoneAccess(allowed: boolean): void {
  observedMicrophoneAccess = allowed;
}

export function desktopSystemPermissionBridge(): DesktopSystemPermissionBridge | undefined {
  return typeof window === "undefined" ? undefined : window.mocoDesktop?.systemPermissions;
}

export function requestSystemPermissionHelp(detail: Omit<SystemPermissionEntry, "id">): void {
  window.dispatchEvent(new CustomEvent("moco:system-permission-help", { detail }));
}

function microphoneFromSnapshot(snapshot: { permissions: SystemPermissionStatus[] }): SystemPermissionStatus {
  const permission = snapshot.permissions.find((item) => item.kind === "microphone");
  if (!permission) throw new Error(t("未能读取麦克风权限状态", "Could not read microphone permission status"));
  return permission;
}

export async function readMicrophonePermission(): Promise<SystemPermissionStatus> {
  const desktop = desktopSystemPermissionBridge();
  if (desktop) return microphoneFromSnapshot(await desktop.status());
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof window !== "undefined" && !window.isSecureContext) {
    return { kind: "microphone", state: "unsupported", detail: t("请使用 HTTPS 或本机地址访问", "Use HTTPS or a localhost address") };
  }
  const observed = (): SystemPermissionStatus => ({ kind: "microphone", state: observedMicrophoneAccess === true ? "granted" : "unknown" });
  if (!navigator.permissions?.query) return observed();
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return { kind: "microphone", state: status.state === "prompt" ? "not-determined" : status.state === "granted" && observedMicrophoneAccess === false ? "unknown" : status.state };
  } catch (cause) {
    // Browsers that do not implement the microphone descriptor can still request it through getUserMedia.
    if (cause instanceof TypeError || cause instanceof DOMException && cause.name === "NotSupportedError") return observed();
    throw cause;
  }
}

export async function authorizeMicrophone(): Promise<SystemPermissionStatus> {
  const desktop = desktopSystemPermissionBridge();
  if (desktop) return microphoneFromSnapshot(await desktop.requestMicrophone());
  const current = await readMicrophonePermission();
  if (current.state === "unsupported") throw new Error(current.detail);
  if (current.state === "denied" || current.state === "restricted") throw new Error(t("请在浏览器的网站设置中允许麦克风访问", "Allow microphone access in your browser's site settings"));
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    noteMicrophoneAccess(true);
    return { kind: "microphone", state: "granted" };
  } catch (cause) {
    noteMicrophoneAccess(false);
    throw cause;
  } finally { if (stream) for (const track of stream.getTracks()) track.stop(); }
}

export async function readDesktopPermissions(envId: string, signal?: AbortSignal): Promise<DesktopSystemPermissions> {
  const snapshot: unknown = await apiRequest(`/api/envs/${encodeURIComponent(envId)}/system-permissions`, { signal });
  if (!isDesktopSystemPermissions(snapshot)) throw new Error(t("设备返回了无效的权限状态，请更新设备端后重试", "The device returned invalid permission status. Update the device and retry"));
  return snapshot;
}

export async function guideDesktopPermissions(envId: string, kind: "accessibility" | "screen", signal?: AbortSignal): Promise<DesktopSystemPermissions> {
  const snapshot: unknown = await apiRequest(`/api/envs/${encodeURIComponent(envId)}/system-permissions/guide`, { method: "POST", body: { kind }, signal });
  if (!isDesktopSystemPermissions(snapshot)) throw new Error(t("设备返回了无效的权限状态，请更新设备端后重试", "The device returned invalid permission status. Update the device and retry"));
  return snapshot;
}
