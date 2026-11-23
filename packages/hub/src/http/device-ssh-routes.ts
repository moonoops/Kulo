import type { ConnectionRecordView, DeviceSshAddRequest, InterconnectedDevice } from "@kulo/protocol";
import type { KuloConnections } from "../connections.js";
import { ConnectionVaultError } from "../connection-vault.js";
import { DeviceConnectionError } from "../device-helpers.js";
import { DeviceSshConnector } from "../device-ssh.js";
import type { DeviceInterconnectionManager } from "../devices.js";

export interface DeviceSshRuntime {
  connector: DeviceSshConnector;
  inspectSshCredential: (connectionId: string) => {
    connection?: ConnectionRecordView;
    boundDevice?: { id: string; name: string };
    eligible: boolean;
    reason?: string;
  };
  addSshFromController: (request: DeviceSshAddRequest) => Promise<InterconnectedDevice | undefined>;
}

export function toDeviceSshHttpError(error: unknown): DeviceConnectionError {
  if (error instanceof DeviceConnectionError) return error;
  if (error instanceof ConnectionVaultError) {
    return new DeviceConnectionError(error.message, 503, error.code);
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "device_ssh_error";
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : 400;
  const message = error instanceof Error ? error.message : String(error);
  return new DeviceConnectionError(message, status, code);
}

export function createDeviceSshRuntime(deps: {
  connections: KuloConnections;
  devices: DeviceInterconnectionManager;
  hubPort: () => number;
  ensureEnabled: () => Promise<void>;
}): DeviceSshRuntime {
  const { connections, devices, hubPort, ensureEnabled } = deps;
  const connector = new DeviceSshConnector({
    hubPort,
    credentials: {
      resolveVerified: (connectionId) => connections.resolveSshForDevice(connectionId, { requireVerified: true }),
      resolveForRestore: (connectionId) => connections.resolveSshForDevice(connectionId, { requireVerified: false }),
    },
    findBoundDevice: (connectionId) => devices.findSshDevicesByConnectionId(connectionId)[0],
    createInvitation: async (request) => {
      const result = devices.createInvitation({ ...request, allowLoopback: true });
      return { deviceId: result.invitation.deviceId, inviteToken: result.inviteToken };
    },
    onError: (id, message) => devices.setError(id, message),
    onAddFailed: (id) => devices.remove(id),
    redact: (text) => connections.redact(text),
  });

  connections.setSshInUseGuard((connectionId) => {
    const bound = devices.findSshDevicesByConnectionId(connectionId);
    if (bound.length > 0) {
      const names = bound.map((item) => `「${item.name}」`).join("、");
      throw Object.assign(
        new Error(`此 SSH 凭据正被设备${names}使用，请先在「设备互联」中移除对应设备。`),
        { code: "connection_in_use_by_device", status: 409 },
      );
    }
    if (connector.isAddingConnection(connectionId)) {
      throw Object.assign(
        new Error("此 SSH 凭据正在接入设备，请等待接入完成后再操作。"),
        { code: "connection_in_use_by_device", status: 409 },
      );
    }
  });

  connections.setOnSshChangedHook((event) => connector.handleConnectionChanged(event));

  const inspectSshCredential = (connectionId: string) => {
    const connection = connections.getConnectionRecord(connectionId);
    if (!connection) return { eligible: false, reason: "找不到所选的 SSH 凭据，请先在「授权凭据」中添加并验证。" };
    if (connection.kind !== "ssh") return { connection, eligible: false, reason: "所选凭据不是 SSH 服务器类型。" };
    const boundDevice = devices.findSshDevicesByConnectionId(connectionId)[0];
    if (boundDevice) {
      return { connection, boundDevice, eligible: false, reason: `该 SSH 凭据已关联设备「${boundDevice.name}」，无需重复添加。` };
    }
    if (!connection.hasCredential || !connection.host || !connection.username) {
      return { connection, eligible: false, reason: "该 SSH 凭据信息不完整，请先在「授权凭据」补全并验证。" };
    }
    if (connection.status !== "verified" || !connection.hostFingerprint) {
      return { connection, eligible: false, reason: "该 SSH 凭据尚未验证通过，请先在「授权凭据」完成指纹确认与连接测试。" };
    }
    return { connection, eligible: true };
  };

  const addSshFromController = async (request: DeviceSshAddRequest): Promise<InterconnectedDevice | undefined> => {
    try {
      if (!devices.enabled) await ensureEnabled();
      const record = await connector.add(request);
      devices.recordSsh(record);
      return devices.view(hubPort(), `http://127.0.0.1:${hubPort()}`, devices.localNodeId).devices.find((d) => d.id === record.deviceId);
    } catch (error) {
      throw toDeviceSshHttpError(error);
    }
  };

  return { connector, inspectSshCredential, addSshFromController };
}
