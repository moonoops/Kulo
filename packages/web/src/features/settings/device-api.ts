import { translate as t } from "../../kulo-i18n";
import type {
  ClusterLocalStatusView,
  DeviceInterconnectionView,
  DeviceInvitation,
  DeviceRoleTransition,
  DeviceSshAddRequest,
  InterconnectedDevice,
  MobileInvitation,
} from "@kulo/protocol";
import { apiRequest, KuloApiError } from "../../kulo-api";

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
      if (error instanceof KuloApiError && (error.status === 401 || error.status === 403)) throw error;
      if (error instanceof KuloApiError && error.status === 404 && (found || deadline - Date.now() < 115_000)) {
        throw new KuloApiError(404, t("未找到这次切换记录，可以重试。", "The switch receipt was not found. Try again."), "role_transition_unconfirmed");
      }
    }
    if (state?.id === id && state.targetRole === targetRole) {
      found = true;
      if (state.status === "ready") return;
      if (state.status === "failed") throw new KuloApiError(409, state.error ?? t("切换失败，请重试。", "Switch failed. Please retry."), state.code);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new KuloApiError(504, t("尚未确认切换结果，可以重试。", "The switch has not been confirmed. Try again."), "role_transition_unconfirmed");
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

export interface PromoteResponse {
  id?: string;
  targetRole?: DeviceRoleTransition["targetRole"];
  status?: DeviceRoleTransition["status"];
  delegated?: boolean;
  targetNodeId?: string;
  newPrimaryUrl?: string;
}

export interface HandoverResponse {
  ok: boolean;
  targetNodeId: string;
  newPrimaryUrl: string;
  epoch: number;
  receipt?: DeviceRoleTransition;
}

export const deviceApi = {
  get: (signal?: AbortSignal) => apiRequest<DeviceInterconnectionView>(base, { signal, redirect: "error" }),
  clusterStatus: (signal?: AbortSignal) =>
    apiRequest<ClusterLocalStatusView>(`${base}/cluster-status`, { signal, redirect: "error" }),
  dismissConflictNotice: () =>
    apiRequest<{ ok: true }>(`${base}/cluster-conflict-notice`, { method: "DELETE" }),
  setEnabled: (enabled: boolean, force = false) =>
    apiRequest<DeviceInterconnectionView>(base, { method: "PATCH", body: { enabled, force } }),
  setStandby: (id: string, enabled: boolean) =>
    apiRequest<DeviceInterconnectionView>(`${base}/${encodeURIComponent(id)}/standby`, { method: "POST", body: { enabled } }),
  promote: async (targetNodeId?: string, signal?: AbortSignal, id = newDeviceTransitionId()): Promise<PromoteResponse> => {
    let acknowledgedId = id;
    try {
      const res = await apiRequest<PromoteResponse>(`${base}/promote`, {
        method: "POST",
        body: targetNodeId ? { targetNodeId } : {},
        transitionId: id,
        signal,
        redirect: "error",
      });
      if (res?.delegated || res?.status === "ready") return res;
      if (res?.id) acknowledgedId = res.id;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
    }
    await waitForDeviceRole(acknowledgedId, "hub", signal);
    return { id: acknowledgedId, targetRole: "hub", status: "ready" };
  },
  handover: async (targetNodeId?: string, force = false, signal?: AbortSignal): Promise<HandoverResponse> => {
    let receiptId: string | undefined;
    try {
      const res = await apiRequest<HandoverResponse>("/api/cluster/handover", {
        method: "POST",
        body: { ...(targetNodeId ? { targetNodeId } : {}), force },
        signal,
        redirect: "error",
      });
      receiptId = res?.receipt?.id;
      if (receiptId) {
        await waitForDeviceRole(receiptId, "joined", signal).catch(() => undefined);
      }
      return res;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof TypeError) {
        // Primary switched roles mid-response; give local peer a brief moment to settle.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { ok: true, targetNodeId: targetNodeId ?? "", newPrimaryUrl: "", epoch: 0 };
      }
      throw error;
    }
  },
  invite: (hubUrl: string, name?: string, signal?: AbortSignal) =>
    apiRequest<DeviceInvitation>(`${base}/invitations`, { method: "POST", body: { hubUrl, name }, signal }),
  cancelInvite: (id: string) =>
    apiRequest<void>(`${base}/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addSsh: (request: DeviceSshAddRequest, signal?: AbortSignal) =>
    apiRequest<InterconnectedDevice>(`${base}/ssh`, { method: "POST", body: request, signal }),
  rename: (id: string, name: string) =>
    apiRequest<DeviceInterconnectionView>(`${base}/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  remove: (id: string, force = false) =>
    apiRequest<void>(`${base}/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" }),
  join: (input: string, force = false, token?: string, signal?: AbortSignal, transitionId?: string) =>
    submitRoleChange("join", { input, force, ...(token ? { token } : {}) }, signal, transitionId),
  leave: (signal?: AbortSignal) =>
    submitRoleChange("leave", {}, signal),
};

export function buildDeviceSshAddRequest(fields: {
  connectionId: string;
  name: string;
  rootDir: string;
}): DeviceSshAddRequest {
  const connectionId = fields.connectionId.trim();
  if (!/^connection-[a-f0-9-]{16,64}$/.test(connectionId)) {
    throw new Error(t("请选择已验证的 SSH 凭据。", "Select a verified SSH credential."));
  }
  return {
    connectionId,
    ...(fields.name.trim() ? { name: fields.name.trim() } : {}),
    ...(fields.rootDir.trim() ? { rootDir: fields.rootDir.trim() } : {}),
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
