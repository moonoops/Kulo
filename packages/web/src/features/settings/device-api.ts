import { translate as t } from "../../moco-i18n";
import type {
  DeviceInterconnectionView,
  DeviceInvitation,
  DeviceRoleTransition,
  DeviceSshRequest,
  DeviceSshScan,
  InterconnectedDevice,
  MobileInvitation,
} from "@moco/protocol";
import { apiRequest, MocoApiError } from "../../moco-api";

const base = "/api/devices";

export async function waitForDeviceRole(id: string, targetRole: DeviceRoleTransition["targetRole"], signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120_000;
  let found = false;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const attempt = AbortSignal.timeout(4_000);
    let state: DeviceRoleTransition | undefined;
    try {
      state = await apiRequest<DeviceRoleTransition>(`${base}/role-transition?id=${encodeURIComponent(id)}`, {
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, attempt]) : attempt,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MocoApiError && (error.status === 401 || error.status === 403)) throw error;
      if (error instanceof MocoApiError && error.status === 404 && (found || deadline - Date.now() < 115_000)) {
        throw new MocoApiError(404, t("未找到这次切换记录，可以重试。", "The switch receipt was not found. Try again."), "role_transition_unconfirmed");
      }
    }
    if (state?.id === id && state.targetRole === targetRole) {
      found = true;
      if (state.status === "ready") return;
      if (state.status === "failed") throw new MocoApiError(409, state.error ?? t("切换失败，请重试。", "Switch failed. Please retry."), state.code);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new MocoApiError(504, t("尚未确认切换结果，可以重试。", "The switch has not been confirmed. Try again."), "role_transition_unconfirmed");
}

export function newDeviceTransitionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function submitRoleChange(operation: "join" | "leave", body: object, signal?: AbortSignal, id = newDeviceTransitionId()): Promise<void> {
  const target = operation === "join" ? "joined" : "hub";
  let acknowledgedId = id;
  try {
    const receipt = await apiRequest<DeviceRoleTransition>(`${base}/${operation}`, {
      method: "POST", body, transitionId: id, signal, redirect: "error",
    });
    if (receipt?.id) acknowledgedId = receipt.id;
    if (receipt?.id === id && receipt.targetRole === target && receipt.status === "ready") return;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof TypeError)) throw error;
    // The local listener may have switched before the browser received its acknowledgement.
  }
  await waitForDeviceRole(acknowledgedId, target, signal);
}

export interface MobileHostConnection {
  hubId: string;
  spkiSHA256: string;
  candidates: Array<{ route: "lan" | "tailscale"; origin: string }>;
  tailscale: {
    mode: "system" | "embedded" | "unavailable";
    state: string;
    loginAvailable: boolean;
  };
}

export const mobileDeviceApi = {
  connection: (signal?: AbortSignal) => apiRequest<MobileHostConnection>("/api/mobile/connection", { signal }),
  invite: () => apiRequest<MobileInvitation>("/api/mobile/invitations", { method: "POST", body: {} }),
  cancelInvite: (id: string) => apiRequest<void>(`/api/mobile/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  login: (signal?: AbortSignal) => apiRequest<{ authURL: string }>("/api/mobile/connection/login", { method: "POST", signal }),
};

export const deviceApi = {
  get: (signal?: AbortSignal) => apiRequest<DeviceInterconnectionView>(base, { signal, redirect: "error" }),
  setEnabled: (enabled: boolean, force = false) =>
    apiRequest<DeviceInterconnectionView>(base, { method: "PATCH", body: { enabled, force } }),
  invite: (hubUrl: string, name?: string, signal?: AbortSignal) =>
    apiRequest<DeviceInvitation>(`${base}/invitations`, { method: "POST", body: { hubUrl, name }, signal }),
  cancelInvite: (id: string) =>
    apiRequest<void>(`${base}/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  scanSsh: (request: DeviceSshRequest, signal?: AbortSignal) =>
    apiRequest<DeviceSshScan>(`${base}/ssh/scan`, { method: "POST", body: request, signal }),
  addSsh: (scanId: string, signal?: AbortSignal) =>
    apiRequest<InterconnectedDevice>(`${base}/ssh`, { method: "POST", body: { scanId }, signal }),
  rename: (id: string, name: string) =>
    apiRequest<DeviceInterconnectionView>(`${base}/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  remove: (id: string, force = false) =>
    apiRequest<void>(`${base}/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" }),
  join: (input: string, force = false, token?: string, signal?: AbortSignal, transitionId?: string) =>
    submitRoleChange("join", { input, force, ...(token ? { token } : {}) }, signal, transitionId),
  leave: (signal?: AbortSignal) =>
    submitRoleChange("leave", {}, signal),
};

export function buildDeviceSshRequest(fields: {
  host: string;
  port: string;
  user: string;
  name: string;
  rootDir: string;
}, hubOrigin: string): DeviceSshRequest {
  const port = Number(fields.port);
  if (!fields.host.trim()) throw new Error(t("请输入 SSH 主机或配置别名。", "Enter an SSH host or config alias."));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("SSH 端口须为 1–65535。", "SSH port must be between 1 and 65535."));
  const hub = new URL(hubOrigin);
  if (hub.protocol !== "http:" && hub.protocol !== "https:") throw new Error(t("当前界面不是有效的 HTTP 地址。", "The current interface does not have a valid HTTP URL."));
  return {
    host: fields.host.trim(),
    port,
    user: fields.user.trim() || undefined,
    name: fields.name.trim() || undefined,
    rootDir: fields.rootDir.trim() || undefined,
    hubUrl: hub.origin,
  };
}

export function isShareableHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash && url.port !== "0" &&
      (url.pathname === "/" || url.pathname === "") &&
      host !== "localhost" && !host.endsWith(".localhost") &&
      host !== "0.0.0.0" && host !== "::" && host !== "::1" &&
      !/^127\./.test(host) && !/^::ffff:(?:127\.|7f)/.test(host)
    );
  } catch {
    return false;
  }
}
