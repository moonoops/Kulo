export type SystemPermissionKind = "microphone" | "accessibility" | "screen";
export type NativeAppPermissionKind = "full-disk-access" | "automation" | "local-network";
export type SystemPermissionSettingsKind = SystemPermissionKind | NativeAppPermissionKind | "notifications";

export function isNativeAppPermissionKind(value: unknown): value is NativeAppPermissionKind {
  return value === "full-disk-access" || value === "automation" || value === "local-network";
}

export type SystemPermissionState = "granted" | "not-determined" | "denied" | "restricted" | "unknown" | "unsupported";

export interface SystemPermissionStatus {
  kind: SystemPermissionKind;
  state: SystemPermissionState;
  detail?: string;
}

export interface DesktopSystemPermissions {
  platform: string;
  permissions: SystemPermissionStatus[];
  guide?: "started" | "already_running" | "not_needed";
}

export function isDesktopSystemPermissions(value: unknown): value is DesktopSystemPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["platform", "permissions", "guide"].includes(key))
    || typeof v.platform !== "string" || !v.platform || v.platform.length > 32
    || v.guide !== undefined && !["started", "already_running", "not_needed"].includes(v.guide as string)
    || !Array.isArray(v.permissions) || v.permissions.length !== 2) return false;
  const kinds = new Set<string>();
  for (const permission of v.permissions) {
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) return false;
    const p = permission as Record<string, unknown>;
    if (Object.keys(p).some((key) => !["kind", "state", "detail"].includes(key))
      || p.kind !== "accessibility" && p.kind !== "screen" || kinds.has(p.kind)
      || !["granted", "not-determined", "denied", "restricted", "unknown", "unsupported"].includes(p.state as string)
      || p.detail !== undefined && (typeof p.detail !== "string" || p.detail.length > 1000)) return false;
    kinds.add(p.kind);
  }
  return true;
}
