import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { collectDeviceSystemInfo, type EnvManager } from "@kulo/env";
import {
  WARM_STANDBY_CAPABILITY,
  formatDeviceInstallerInstructions,
  type ClusterFailbackOffer,
  type ClusterHubEndpoint,
  type ClusterSyncStatus,
  type ClusterTopology,
  type DeviceInterconnectionView,
  type DeviceInvitation,
  type DevicePeerConfig,
  type DeviceSystemInfo,
  type EnvNodeDescriptor,
  type MobileConnectionMetadata,
  type MobileInvitation,
  type MobilePairingProfile,
  type MobilePublicProfile,
} from "@kulo/protocol";
import {
  isCredentialDeviceSshRecord,
  type DeviceSshRecord,
  type StoredDeviceSshRecord,
} from "./device-ssh.js";
import {
  BASE64URL_KEY_RE,
  DeviceConnectionError,
  NODE_ID_RE,
  addressPriority,
  buildUrlsFromIps,
  deviceName,
  digest,
  equalSecret,
  isDeviceName,
  isLegacyEnvId,
  isValidStoredDeviceSshRecord,
  mobileInput,
  normalizedHubUrl,
  parseDeviceInfo,
  peerConfig,
  secret,
} from "./device-helpers.js";
import type { ChatMessageSource } from "./chat-submissions.js";
import {
  encodeMobileInvitation,
  isStoredMobileIdentity,
  isStoredMobileInvitation,
  MOBILE_INVITATION_TTL_MS,
  MOBILE_PAIRING_RECOVERY_TTL_MS,
  mobileSecretHash,
  parseMobileInvitationInput,
  parseMobileMetadata,
  parseMobilePairingRequest,
  sameMobileHash,
  type StoredMobileInvitation,
} from "./mobile-pairing.js";

export { DeviceConnectionError, normalizedHubUrl, parseDeviceInfo };

export interface StoredDevice {
  id: string;
  name: string;
  kind: "reverse-ws" | "ssh";
  rootDir: string;
  envToken: string;
  clientToken: string;
  pairedAt?: number;
  info?: DeviceSystemInfo;
  lastSeenAt?: number;
  ssh?: StoredDeviceSshRecord;
  error?: string;
  mobile?: { invitationId: string; installationHash: string };
  pairingRecovery?: { proofHash: string; hubUrl: string; expiresAt: number };
  standby?: boolean;
  standbyPriority?: number;
  syncToken?: string;
  standbyPublicKey?: string;
  identityPublicKey?: string;
  listenPort?: number;
  urls?: string[];
}

export interface DeviceState {
  version: 1;
  hubId: string;
  enabled: boolean;
  localName?: string;
  localNodeId?: string;
  legacyLocalNodeId?: string;
  clusterEpoch?: number;
  primaryNodeId?: string;
  preferredPrimaryNodeId?: string;
  identityPublicKey?: string;
  legacyNames?: Record<string, string>;
  devices: StoredDevice[];
  revokedIds?: string[];
  mobileInvitations?: StoredMobileInvitation[];
}

export class DeviceInterconnectionManager {
  readonly #file: string;
  readonly #env: EnvManager;
  readonly #invites = new Map<string, { deviceId: string; tokenHash: string; hubUrl: string; expiresAt: number }>();
  readonly #syncStatuses = new Map<string, ClusterSyncStatus>();
  #onWrite?: () => void;
  #state: DeviceState;

  constructor(stateDir: string, env: EnvManager, legacyEnabled = false) {
    this.#file = path.join(stateDir, "devices.json");
    this.#env = env;
    if (fs.existsSync(this.#file)) {
      const state = JSON.parse(fs.readFileSync(this.#file, "utf8")) as DeviceState;
      if (state.version !== 1 || typeof state.hubId !== "string" || typeof state.enabled !== "boolean" || !Array.isArray(state.devices) ||
          (state.localName !== undefined && !isDeviceName(state.localName)) ||
          (state.localNodeId !== undefined && (typeof state.localNodeId !== "string" || !NODE_ID_RE.test(state.localNodeId) || state.localNodeId === "local")) ||
          (state.legacyLocalNodeId !== undefined && (typeof state.legacyLocalNodeId !== "string" || !NODE_ID_RE.test(state.legacyLocalNodeId) || state.legacyLocalNodeId === "local")) ||
          (state.primaryNodeId !== undefined && (typeof state.primaryNodeId !== "string" || !NODE_ID_RE.test(state.primaryNodeId) || state.primaryNodeId === "local")) ||
          (state.preferredPrimaryNodeId !== undefined && (typeof state.preferredPrimaryNodeId !== "string" || !NODE_ID_RE.test(state.preferredPrimaryNodeId) || state.preferredPrimaryNodeId === "local")) ||
          (state.clusterEpoch !== undefined && (!Number.isSafeInteger(state.clusterEpoch) || state.clusterEpoch < 1)) ||
          (state.identityPublicKey !== undefined && (typeof state.identityPublicKey !== "string" || !BASE64URL_KEY_RE.test(state.identityPublicKey))) ||
          (state.legacyNames !== undefined && (!state.legacyNames || typeof state.legacyNames !== "object" || Array.isArray(state.legacyNames) ||
            Object.entries(state.legacyNames).some(([id, name]) => !isLegacyEnvId(id) || !isDeviceName(name)))) ||
          (state.mobileInvitations !== undefined && (!Array.isArray(state.mobileInvitations) || state.mobileInvitations.some((invite) => !isStoredMobileInvitation(invite) || invite.metadata.hubId !== undefined && invite.metadata.hubId !== state.hubId))) ||
          state.devices.some((d) => !NODE_ID_RE.test(d.id) || d.id === "local" || typeof d.envToken !== "string" || typeof d.clientToken !== "string" || !d.envToken || !d.clientToken || d.envToken === d.clientToken || d.mobile !== undefined && !isStoredMobileIdentity(d.mobile) ||
            (d.standby !== undefined && typeof d.standby !== "boolean") ||
            (d.syncToken !== undefined && (typeof d.syncToken !== "string" || !d.syncToken || /\s/.test(d.syncToken))) ||
            (d.standbyPublicKey !== undefined && (typeof d.standbyPublicKey !== "string" || !BASE64URL_KEY_RE.test(d.standbyPublicKey))) ||
            (d.identityPublicKey !== undefined && (typeof d.identityPublicKey !== "string" || !BASE64URL_KEY_RE.test(d.identityPublicKey))) ||
            (d.listenPort !== undefined && (!Number.isInteger(d.listenPort) || d.listenPort < 1 || d.listenPort > 65535)) ||
            (d.ssh !== undefined && !isValidStoredDeviceSshRecord(d.ssh)) ||
            d.pairingRecovery !== undefined && (!d.pairingRecovery || !/^[a-f0-9]{64}$/.test(d.pairingRecovery.proofHash) || typeof d.pairingRecovery.hubUrl !== "string" || !Number.isSafeInteger(d.pairingRecovery.expiresAt)))) {
        throw new Error("设备互联配置已损坏，请检查 devices.json。");
      }
      const now = Date.now();
      this.#state = { ...state, devices: state.devices.filter((d) => d.pairedAt),
        ...(state.mobileInvitations ? { mobileInvitations: state.mobileInvitations.filter((invite) => now < (invite.binding?.recoveryExpiresAt ?? invite.expiresAt)) } : {}) };
      for (const device of this.#state.devices) if (device.pairingRecovery && (!state.enabled || now >= device.pairingRecovery.expiresAt)) delete device.pairingRecovery;
      this.#save();
    } else {
      this.#state = { version: 1, hubId: randomUUID(), enabled: legacyEnabled, devices: [] };
      this.#save();
    }
    if (this.#state.localNodeId) {
      this.#env.setLocalEnvId(this.#state.localNodeId);
    }
    for (const [id, name] of Object.entries(this.#state.legacyNames ?? {})) this.#env.setDeviceDisplayName(id, name);
    for (const d of this.#state.devices) if (d.pairedAt) {
      if (d.id !== this.#state.localNodeId) {
        this.#env.setDeviceCredential(d.id, d.envToken);
      }
      this.#env.setDeviceDisplayName(d.id, d.name);
    }
    const localId = this.localNodeId;
    const selfRecord = this.#state.localNodeId ? this.#state.devices.find((d) => d.id === this.#state.localNodeId) : undefined;
    this.#env.setDeviceDisplayName(localId, this.#state.localName ?? selfRecord?.name);
    for (const id of this.#state.revokedIds ?? []) {
      if (id !== this.#state.localNodeId) this.#env.removeDevice(id);
    }
    this.#env.setRemoteConnectionsEnabled(this.enabled);
  }

  setOnWrite(hook: (() => void) | undefined): void {
    this.#onWrite = hook;
  }

  get enabled(): boolean { return this.#state.enabled; }
  get hubId(): string { return this.#state.hubId; }
  get localNodeId(): string { return this.#state.localNodeId ?? "local"; }
  get legacyLocalNodeId(): string | undefined { return this.#state.legacyLocalNodeId; }
  get clusterEpoch(): number { return this.#state.clusterEpoch ?? 1; }
  get primaryNodeId(): string { return this.#state.primaryNodeId ?? this.localNodeId; }
  get preferredPrimaryNodeId(): string { return this.#state.preferredPrimaryNodeId ?? this.primaryNodeId; }
  get identityPublicKey(): string | undefined { return this.#state.identityPublicKey; }
  get sshRecords(): StoredDeviceSshRecord[] { return this.#state.devices.flatMap((d) => d.ssh ? [d.ssh] : []); }

  findSshDevicesByConnectionId(connectionId: string): Array<{ id: string; name: string }> {
    return this.#state.devices
      .filter((d) => !this.isRevoked(d.id) && d.ssh && isCredentialDeviceSshRecord(d.ssh) && d.ssh.connectionId === connectionId)
      .map((d) => ({ id: d.id, name: d.name }));
  }

  hasMobileClients(): boolean {
    const now = Date.now();
    return this.#state.devices.some((d) => Boolean(d.pairedAt && d.mobile) && !this.isRevoked(d.id))
      || Boolean(this.#state.mobileInvitations?.some((invite) => now < (invite.binding?.recoveryExpiresAt ?? invite.expiresAt)));
  }

  isLocalPrincipal(id: string): boolean { return id === "local" || id === this.localNodeId; }
  isRevoked(id: string): boolean { return Boolean(this.#state.revokedIds?.includes(id)); }
  #activeRemoteDevice(id: string): StoredDevice | undefined {
    if (!id || this.isLocalPrincipal(id) || this.isRevoked(id)) return undefined;
    return this.#state.devices.find((d) => d.id === id && Boolean(d.pairedAt));
  }
  isActivePairedPrincipal(id: string): boolean { return Boolean(this.enabled && this.#activeRemoteDevice(id)); }
  isMobilePrincipal(id: string): boolean { return Boolean(this.#activeRemoteDevice(id)?.mobile); }
  isSshPrincipal(id: string): boolean { return this.#activeRemoteDevice(id)?.kind === "ssh"; }

  hasRemoteStandbys(): boolean {
    return this.#state.devices.some((d) => d.pairedAt && d.standby && d.id !== this.#state.localNodeId && !this.isRevoked(d.id));
  }
  listRemoteStandbys(): StoredDevice[] {
    return this.#state.devices.filter((d) => d.pairedAt && d.standby && d.id !== this.#state.localNodeId && !this.isRevoked(d.id)).sort((a, b) => (a.standbyPriority ?? 999) - (b.standbyPriority ?? 999));
  }
  getStandbyRecord(deviceId: string): StoredDevice | undefined {
    const device = this.#activeRemoteDevice(deviceId);
    return device?.standby ? device : undefined;
  }
  getSelfDeviceRecord(): StoredDevice | undefined {
    return this.#state.localNodeId ? this.#state.devices.find((d) => d.id === this.#state.localNodeId && d.pairedAt) : undefined;
  }
  resolveClientSecret(nodeId: string): string | undefined { return this.enabled ? this.#activeRemoteDevice(nodeId)?.clientToken : undefined; }
  resolveSyncSecret(nodeId: string): string | undefined {
    if (!this.enabled) return undefined;
    const device = this.#activeRemoteDevice(nodeId);
    return device?.standby ? device.syncToken : undefined;
  }

  authenticateClient(token: string | undefined): string | undefined {
    if (!this.enabled || !token || token.length > 8192) return undefined;
    return this.#state.devices.find((d) => d.pairedAt && d.id !== this.#state.localNodeId && !this.isRevoked(d.id) && equalSecret(token, d.clientToken))?.id;
  }

  chatMessageSource(deviceId: string): ChatMessageSource | undefined {
    if (this.isLocalPrincipal(deviceId)) {
      const id = this.localNodeId;
      return { deviceId: id, name: this.#state.localName ?? this.#env.getEnvDescriptor(id)?.name ?? "主脑", kind: "computer" };
    }
    const device = this.enabled ? this.#state.devices.find((entry) => entry.id === deviceId && entry.pairedAt) : undefined;
    if (device) return { deviceId, name: device.name, kind: device.mobile ? "android" : "computer" };
  }

  authenticateEnv(token: string | undefined): string | undefined {
    if (!this.enabled || !token || token.length > 8192) return undefined;
    return this.#state.devices.find((device) => device.pairedAt && device.id !== this.#state.localNodeId && !this.isRevoked(device.id) && equalSecret(token, device.envToken))?.id;
  }

  updateStandbySyncStatus(deviceId: string, status: ClusterSyncStatus): void {
    this.#syncStatuses.set(deviceId, { ...status });
  }

  getStandbySyncStatus(deviceId: string): ClusterSyncStatus | undefined {
    const status = this.#syncStatuses.get(deviceId);
    return status ? { ...status } : undefined;
  }

  /**
   * Ensure the current primary host has a stable physical `nodeId` and symmetrical
   * Standby credentials/keys in `devices.json` (P0-4), so if it ever goes offline and
   * later recovers as a Standby, it can immediately reverse-sync without manual re-pairing.
   */
  ensureClusterBootstrap(input: {
    nodeId: string;
    standbyPublicKey: string;
    identityPublicKey: string;
    listenPort?: number;
  }): { legacyLocalNodeId: string; selfRecord: StoredDevice; newlyBootstrapped: boolean } {
    if (!NODE_ID_RE.test(input.nodeId) || input.nodeId === "local") {
      throw new DeviceConnectionError("节点标识无效。");
    }
    if (!BASE64URL_KEY_RE.test(input.standbyPublicKey) || !BASE64URL_KEY_RE.test(input.identityPublicKey)) {
      throw new DeviceConnectionError("集群节点密钥格式无效。");
    }
    const newlyBootstrapped = !this.#state.localNodeId;
    const localInfo = collectDeviceSystemInfo();
    const localEnv = this.#env.listEnvs().find((e) => e.kind === "local");
    const displayName = this.#state.localName ?? (localEnv?.name && localEnv.name !== `Local (${localInfo.hostname})` ? localEnv.name : localInfo.hostname);

    this.#state.localNodeId = input.nodeId;
    this.#state.legacyLocalNodeId ??= input.nodeId;
    this.#state.primaryNodeId = input.nodeId;
    this.#state.preferredPrimaryNodeId ??= input.nodeId;
    this.#state.clusterEpoch ??= 1;
    this.#state.identityPublicKey = input.identityPublicKey;
    this.#state.localName = displayName;

    let selfRecord = this.#state.devices.find((d) => d.id === input.nodeId);
    if (!selfRecord) {
      selfRecord = {
        id: input.nodeId,
        name: displayName,
        kind: "reverse-ws",
        rootDir: localEnv?.rootDir ?? "",
        envToken: secret(),
        clientToken: secret(),
        pairedAt: Date.now(),
        info: parseDeviceInfo(localInfo),
        standby: true,
        standbyPriority: 0,
        syncToken: secret(),
        standbyPublicKey: input.standbyPublicKey,
        identityPublicKey: input.identityPublicKey,
        ...(input.listenPort ? { listenPort: input.listenPort } : {}),
      };
      this.#state.devices.push(selfRecord);
    } else {
      selfRecord.name = displayName;
      selfRecord.pairedAt ??= Date.now();
      selfRecord.info = parseDeviceInfo(localInfo);
      selfRecord.standby = true;
      selfRecord.syncToken ??= secret();
      selfRecord.standbyPublicKey = input.standbyPublicKey;
      selfRecord.identityPublicKey = input.identityPublicKey;
      if (input.listenPort) selfRecord.listenPort = input.listenPort;
    }

    this.#save();
    this.#env.setLocalEnvId(input.nodeId);
    this.#env.setDeviceDisplayName(input.nodeId, displayName);
    return { legacyLocalNodeId: this.#state.legacyLocalNodeId, selfRecord, newlyBootstrapped };
  }

  /**
   * Grant or revoke warm-standby status for an existing paired computer device.
   * Must only be invoked after `hasLocalDeviceControl` verification on the Active Hub.
   */
  setDeviceStandby(
    deviceId: string,
    enabled: boolean,
    bootstrap: {
      nodeId: string;
      standbyPublicKey: string;
      identityPublicKey: string;
      listenPort: number;
      origin: string;
    },
  ): { device: StoredDevice; topology: ClusterTopology; legacyLocalNodeId?: string; syncToken?: string } {
    if (!this.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
    if (this.isLocalPrincipal(deviceId)) {
      throw new DeviceConnectionError("当前主设备已是主机，无需设为备用主机。", 400);
    }
    const device = this.#state.devices.find((d) => d.id === deviceId && d.pairedAt && !this.isRevoked(d.id));
    if (!device) throw new DeviceConnectionError("找不到已配对的设备。", 404);
    if (device.mobile) throw new DeviceConnectionError("手机设备不能设为备用主机。", 400);
    if (device.kind === "ssh") throw new DeviceConnectionError("SSH 接入设备不支持设为备用主机。", 400);

    let legacyLocalNodeId: string | undefined;
    if (enabled) {
      const env = this.#env.getEnvDescriptor(deviceId);
      if (!env?.online) {
        throw new DeviceConnectionError("请先让该设备保持在线，再设为备用主机。", 409, "device_offline");
      }
      if (!env.capabilities.includes(WARM_STANDBY_CAPABILITY)) {
        throw new DeviceConnectionError("该设备运行的是轻量客户端或旧版 Kulo，不支持设为备用主机。", 409, "standby_unsupported");
      }
      const pubKey = env.standbyPublicKey ?? device.standbyPublicKey;
      if (!pubKey || !BASE64URL_KEY_RE.test(pubKey)) {
        throw new DeviceConnectionError("该设备尚未准备好同步密钥，请重启该设备的 Kulo 后重试。", 409, "standby_key_missing");
      }
      const boot = this.ensureClusterBootstrap({
        nodeId: bootstrap.nodeId,
        standbyPublicKey: bootstrap.standbyPublicKey,
        identityPublicKey: bootstrap.identityPublicKey,
        listenPort: bootstrap.listenPort,
      });
      legacyLocalNodeId = boot.legacyLocalNodeId;
      const existingPriorities = this.#state.devices
        .filter((d) => d.id !== deviceId && d.id !== this.#state.localNodeId && d.standby)
        .map((d) => d.standbyPriority ?? 1);
      device.standby = true;
      device.standbyPriority = device.standbyPriority && device.standbyPriority > 0
        ? device.standbyPriority
        : (existingPriorities.length ? Math.max(...existingPriorities) + 1 : 1);
      device.syncToken = device.syncToken ?? secret();
      device.standbyPublicKey = pubKey;
      if (env.identityPublicKey) device.identityPublicKey = env.identityPublicKey;
      if (env.listenPort) device.listenPort = env.listenPort;
      if (env.info) device.info = parseDeviceInfo(env.info);
      if (device.listenPort && device.info?.ips.length) {
        device.urls = buildUrlsFromIps(device.info.ips, device.listenPort);
      }
      this.#syncStatuses.set(deviceId, { state: "pending" });
    } else {
      device.standby = false;
      delete device.standbyPriority;
      delete device.syncToken;
      delete device.standbyPublicKey;
      this.#syncStatuses.delete(deviceId);
    }

    this.#save();
    const topology = this.buildClusterTopology(bootstrap.listenPort, bootstrap.origin);
    this.#env.broadcastClusterTopology(topology);
    if (!enabled) {
      this.#env.sendStandbyWipe(deviceId, "standby_revoked_by_user");
    }
    return { device, topology, legacyLocalNodeId, ...(device.syncToken ? { syncToken: device.syncToken } : {}) };
  }

  localHubUrls(port: number, origin: string): string[] {
    const localInfo = collectDeviceSystemInfo();
    const urls: string[] = [];
    const add = (raw: string, isRequestOrigin = false) => {
      try {
        const url = normalizedHubUrl(raw);
        const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
        if (isRequestOrigin && isIP(host) && !localInfo.ips.includes(host)) return;
        if (!urls.includes(url)) urls.push(url);
      } catch (error) {
        if (!(error instanceof DeviceConnectionError)) throw error;
      }
    };
    add(origin, true);
    for (const ip of [...localInfo.ips].sort((a, b) => addressPriority(a) - addressPriority(b))) {
      add(`http://${ip.includes(":") ? `[${ip}]` : ip}:${port}`);
    }
    return urls;
  }

  buildClusterTopology(port: number, origin: string): ClusterTopology {
    const envs = this.#env.listEnvs();
    this.#observe(envs);
    const localInfo = collectDeviceSystemInfo();
    const local = envs.find((e) => e.kind === "local");
    const hubName = this.#state.localName ?? (local?.name && local.name !== `Local (${localInfo.hostname})` ? local.name : localInfo.hostname);
    const primaryUrls = this.localHubUrls(port, origin);
    const primaryNodeId = this.primaryNodeId;
    const hubs: ClusterHubEndpoint[] = [
      {
        nodeId: primaryNodeId,
        name: hubName,
        role: "primary",
        priority: 0,
        urls: primaryUrls,
        ...(this.#state.identityPublicKey ? { identityPublicKey: this.#state.identityPublicKey } : {}),
        ...(this.getSelfDeviceRecord()?.standbyPublicKey ? { standbyPublicKey: this.getSelfDeviceRecord()!.standbyPublicKey } : {}),
        online: true,
      },
    ];
    let priorityIndex = 1;
    for (const standby of this.listRemoteStandbys()) {
      const env = envs.find((e) => e.id === standby.id);
      const ips = env?.info?.ips ?? standby.info?.ips ?? [];
      const listenPort = env?.listenPort ?? standby.listenPort;
      const urls = listenPort ? buildUrlsFromIps(ips, listenPort) : (standby.urls ?? []);
      const syncStatus = this.#syncStatuses.get(standby.id);
      hubs.push({
        nodeId: standby.id,
        name: standby.name,
        role: "standby",
        priority: priorityIndex++,
        urls,
        ...(standby.standbyPublicKey ? { standbyPublicKey: standby.standbyPublicKey } : {}),
        ...(standby.identityPublicKey ? { identityPublicKey: standby.identityPublicKey } : {}),
        online: Boolean(env?.online),
        ...(syncStatus ? {
          syncState: syncStatus.state,
          ...(syncStatus.syncedAt !== undefined ? { lastSyncedAt: syncStatus.syncedAt } : {}),
          ...(syncStatus.syncedGeneration !== undefined ? { syncedGeneration: syncStatus.syncedGeneration } : {}),
          ...(syncStatus.error ? { syncError: syncStatus.error } : {}),
        } : {}),
      });
    }
    return {
      version: 1,
      hubId: this.#state.hubId,
      epoch: this.clusterEpoch,
      primaryNodeId,
      preferredPrimaryNodeId: this.preferredPrimaryNodeId,
      updatedAt: Date.now(),
      hubs,
    };
  }

  getFailbackOffer(): ClusterFailbackOffer | undefined {
    const preferred = this.preferredPrimaryNodeId;
    if (!this.#state.localNodeId || preferred === this.primaryNodeId) return undefined;
    const record = this.#state.devices.find((d) => d.id === preferred && d.pairedAt && d.standby && !this.isRevoked(d.id));
    if (!record) return undefined;
    const env = this.#env.getEnvDescriptor(preferred);
    if (!env?.online) return undefined;
    const sync = this.#syncStatuses.get(preferred);
    const ready = sync?.state === "synced";
    if (!ready) return undefined;
    return {
      preferredPrimaryNodeId: preferred,
      preferredPrimaryName: record.name,
      syncedAt: sync.syncedAt,
      ready: true,
    };
  }

  setEnabled(enabled: boolean): void {
    this.#state.enabled = enabled;
    if (!enabled) {
      this.#state.devices = this.#state.devices.filter((d) => d.pairedAt);
      for (const device of this.#state.devices) delete device.pairingRecovery;
    }
    if (!enabled && this.#state.mobileInvitations) this.#state.mobileInvitations = this.#state.mobileInvitations.filter((invite) => invite.binding);
    this.#save();
    this.#env.setRemoteConnectionsEnabled(enabled);
    if (!enabled) this.#invites.clear();
  }

  view(port: number, origin: string, currentDeviceId = this.localNodeId): DeviceInterconnectionView {
    this.#expireInvites();
    this.#expireMobileInvitations();
    const envs = this.#env.listEnvs();
    this.#observe(envs);
    const localInfo = collectDeviceSystemInfo();
    const urls = this.localHubUrls(port, origin);
    const local = envs.find((e) => e.kind === "local");
    const hubName = this.#state.localName ?? (local?.name && local.name !== `Local (${localInfo.hostname})` ? local.name : localInfo.hostname);
    const remoteEnvs = envs.filter((e) => e.kind !== "local");
    const localId = this.localNodeId;
    const records = this.#state.devices.filter((d) => d.id !== this.#state.localNodeId);
    const isCurrentHub = this.isLocalPrincipal(currentDeviceId);
    const failbackOffer = this.getFailbackOffer();
    return {
      enabled: this.enabled,
      role: isCurrentHub ? "hub" : "joined",
      hubId: this.#state.hubId,
      hubName,
      currentDeviceId: isCurrentHub ? localId : currentDeviceId,
      primaryNodeId: this.primaryNodeId,
      preferredPrimaryNodeId: this.preferredPrimaryNodeId,
      clusterEpoch: this.clusterEpoch,
      sshSupported: process.platform !== "win32",
      hubUrls: urls,
      ...(failbackOffer ? { failbackOffer } : {}),
      devices: [
        {
          id: localId,
          name: hubName,
          kind: "local",
          status: "online",
          rootDir: local?.rootDir ?? "",
          info: localInfo,
          clusterRole: "primary",
          isPreferredPrimary: localId === this.preferredPrimaryNodeId,
          warmStandbyCapable: true,
        },
        ...records.map((d) => {
          const env = remoteEnvs.find((e) => e.id === d.id);
          const info = env?.info ?? d.info;
          const isStandby = Boolean(d.standby);
          const syncStatus = isStandby ? this.#syncStatuses.get(d.id) : undefined;
          const warmStandbyCapable = Boolean(
            !d.mobile && d.kind !== "ssh" && (env?.capabilities.includes(WARM_STANDBY_CAPABILITY) || d.standbyPublicKey),
          );
          return {
            id: d.id,
            name: d.name,
            kind: d.kind,
            status: env?.online ? "online" as const : !d.pairedAt ? "pending" as const : "offline" as const,
            rootDir: env?.rootDir ?? d.rootDir,
            info: info ? parseDeviceInfo(info) : undefined,
            lastSeenAt: env?.lastSeenAt ?? d.lastSeenAt,
            ...(d.error ? { error: d.error } : {}),
            ...(d.ssh && isCredentialDeviceSshRecord(d.ssh) ? { sshConnectionId: d.ssh.connectionId } : {}),
            clusterRole: isStandby ? "standby" as const : "peer" as const,
            isPreferredPrimary: d.id === this.preferredPrimaryNodeId,
            warmStandbyCapable,
            ...(syncStatus ? { syncStatus } : isStandby ? { syncStatus: { state: "pending" as const } } : {}),
          };
        }),
        ...remoteEnvs.filter((e) => !records.some((d) => d.id === e.id) && e.id !== this.#state.localNodeId).map((e) => ({
          id: e.id,
          name: this.#state.legacyNames && Object.hasOwn(this.#state.legacyNames, e.id) ? this.#state.legacyNames[e.id]! : e.name,
          kind: e.kind,
          status: e.online ? "online" as const : "offline" as const,
          rootDir: e.rootDir,
          info: e.info ? parseDeviceInfo(e.info) : undefined,
          lastSeenAt: e.lastSeenAt,
          clusterRole: "peer" as const,
          warmStandbyCapable: e.capabilities.includes(WARM_STANDBY_CAPABILITY),
        })),
      ],
    };
  }

  createInvitation(input: { name?: unknown; rootDir?: unknown; hubUrl: unknown; kind?: "ssh"; allowLoopback?: boolean }): { invitation: DeviceInvitation; inviteToken: string } {
    if (!this.enabled) throw new DeviceConnectionError("请先开启设备互联。", 409);
    this.#expireInvites();
    this.#expireMobileInvitations();
    if (this.#invites.size + (this.#state.mobileInvitations?.filter((invite) => !invite.binding).length ?? 0) >= 20) throw new DeviceConnectionError("待接入设备过多，请先取消未使用的接入。", 429);
    const hubUrl = normalizedHubUrl(input.hubUrl, input.allowLoopback);
    const id = randomUUID(), deviceId = `device-${randomBytes(8).toString("hex")}`, token = secret();
    const expiresAt = Date.now() + 10 * 60_000;
    const name = deviceName(input.name, "新设备");
    const rootDir = input.rootDir === undefined || input.rootDir === "" ? "~/Kulo" : input.rootDir;
    if (typeof rootDir !== "string" || rootDir.length > 4096 || /[\x00-\x1f]/.test(rootDir)) throw new DeviceConnectionError("工作目录无效。");
    this.#state.devices.push({ id: deviceId, name, kind: input.kind ?? "reverse-ws", rootDir, envToken: secret(), clientToken: secret() });
    this.#invites.set(id, { deviceId, tokenHash: digest(token), hubUrl, expiresAt });
    this.#save();
    const instructions = formatDeviceInstallerInstructions({ hubUrl, inviteToken: token });
    return { invitation: { id, deviceId, expiresAt, ...instructions }, inviteToken: token };
  }

  pair(input: { inviteToken?: unknown; expectedHubId?: unknown; attemptKey?: unknown; info?: unknown; rootDir?: unknown }, cluster?: ClusterTopology): DevicePeerConfig {
    if (!this.enabled) throw new DeviceConnectionError("设备互联已关闭。", 403);
    this.#expireInvites();
    if (typeof input.inviteToken !== "string" || input.inviteToken.length > 200 || input.expectedHubId !== undefined && input.expectedHubId !== this.hubId) {
      throw new DeviceConnectionError("该邀请无效，请在目标主机重新复制。", 401, "device_invitation_invalid");
    }
    const attemptKey = input.attemptKey;
    if (attemptKey !== undefined && (typeof attemptKey !== "string" || !/^[a-f0-9]{64}$/.test(attemptKey))) throw new DeviceConnectionError("设备配对请求无效。");
    const proofHash = attemptKey && digest(JSON.stringify([input.inviteToken, attemptKey]));
    const tokenHash = digest(input.inviteToken);
    const entry = [...this.#invites.entries()].find(([, invitation]) => equalSecret(tokenHash, invitation.tokenHash));
    if (!entry) {
      const device = proofHash ? this.#state.devices.find((item) => item.pairedAt && item.pairingRecovery &&
        Date.now() < item.pairingRecovery.expiresAt && equalSecret(proofHash, item.pairingRecovery.proofHash)) : undefined;
      if (device?.pairingRecovery && !this.#state.revokedIds?.includes(device.id)) return peerConfig(device, device.pairingRecovery.hubUrl, cluster);
      throw new DeviceConnectionError("配对凭证无效、已使用或已过期，请重新添加设备。", 401, "device_invitation_invalid");
    }
    const [id, invite] = entry;
    const info = parseDeviceInfo(input.info);
    if (input.rootDir !== undefined && (typeof input.rootDir !== "string" || !input.rootDir.trim() || input.rootDir.length > 4096 || /[\x00-\x1f]/.test(input.rootDir))) throw new DeviceConnectionError("设备工作目录无效。");
    const pending = this.#state.devices.find((d) => d.id === invite.deviceId)!;
    const pairedAt = Date.now();
    const device: StoredDevice = { ...pending, info, pairedAt,
      name: pending.name === "新设备" ? deviceName(info.hostname, pending.id) : pending.name,
      ...(typeof input.rootDir === "string" ? { rootDir: input.rootDir } : {}),
      ...(proofHash ? { pairingRecovery: { proofHash, hubUrl: invite.hubUrl, expiresAt: pairedAt + MOBILE_PAIRING_RECOVERY_TTL_MS } } : {}),
    };
    this.#commit({ ...this.#state, devices: this.#state.devices.map((item) => item.id === pending.id ? device : item) });
    this.#invites.delete(id);
    this.#env.setDeviceCredential(device.id, device.envToken);
    this.#env.setDeviceDisplayName(device.id, device.name);
    return peerConfig(device, invite.hubUrl, cluster);
  }

  createMobileInvitation(input: { name?: unknown; candidates: unknown; spkiSHA256: unknown; hubName: unknown; hubId?: unknown }): MobileInvitation {
    this.#requireMobileEnabled();
    const { name, metadata } = mobileInput(() => parseMobileInvitationInput(input));
    this.#checkMobileHub(metadata);
    this.#expireInvites();
    this.#expireMobileInvitations();
    const invites = this.#state.mobileInvitations ?? [];
    if (this.#invites.size + invites.filter((invite) => !invite.binding).length >= 20) {
      throw new DeviceConnectionError("待接入设备过多，请先取消未使用的接入。", 429, "mobile_invitation_limit");
    }
    const id = randomUUID(), deviceId = `device-${randomBytes(8).toString("hex")}`, token = secret();
    const expiresAt = Date.now() + MOBILE_INVITATION_TTL_MS;
    const qrValue = mobileInput(() => encodeMobileInvitation({
      kind: "kulo.mobile.invite", version: 1, hubId: this.hubId, hubName: metadata.hubName,
      invitationId: id, invitationToken: token, deviceId, expiresAt,
      spkiSHA256: metadata.spkiSHA256, candidates: metadata.candidates,
    }));
    this.#commit({ ...this.#state, mobileInvitations: [...invites, {
      id, deviceId, name, tokenHash: mobileSecretHash("invitation", token), metadata, expiresAt,
    }] });
    return { id, deviceId, expiresAt, qrValue };
  }

  pairMobile(input: unknown, expectedSpkiSHA256?: string): MobilePairingProfile {
    this.#requireMobileEnabled();
    const request = mobileInput(() => parseMobilePairingRequest(input));
    const invites = this.#state.mobileInvitations ?? [];
    const invite = invites.find((entry) => entry.id === request.invitationId);
    if (!invite || !sameMobileHash(mobileSecretHash("invitation", request.invitationToken), invite.tokenHash)) {
      throw new DeviceConnectionError("手机配对凭证无效或已过期。", 401, "mobile_invitation_invalid");
    }
    if (expectedSpkiSHA256 !== undefined && invite.metadata.spkiSHA256 !== expectedSpkiSHA256) {
      throw new DeviceConnectionError("主脑身份已变化，请刷新二维码后重新配对。", 409, "mobile_identity_changed");
    }
    if (this.#state.revokedIds?.includes(invite.deviceId)) {
      throw new DeviceConnectionError("手机设备已被移除。", 403, "mobile_device_revoked");
    }
    const now = Date.now();
    const installationHash = mobileSecretHash("installation", request.installationId);
    const attemptHash = mobileSecretHash("attempt", request.attemptId);
    let device: StoredDevice;
    if (invite.binding) {
      if (now >= invite.binding.recoveryExpiresAt) {
        throw new DeviceConnectionError("手机配对恢复期限已过，请重新添加设备。", 401, "mobile_recovery_expired");
      }
      if (!sameMobileHash(installationHash, invite.binding.installationHash) || !sameMobileHash(attemptHash, invite.binding.attemptHash)) {
        throw new DeviceConnectionError("此邀请已用于另一项手机配对。", 409, "mobile_pairing_conflict");
      }
      const stored = this.#state.devices.find((entry) => entry.id === invite.deviceId && entry.pairedAt && entry.mobile?.invitationId === invite.id && sameMobileHash(entry.mobile.installationHash, installationHash));
      if (!stored) throw new DeviceConnectionError("手机配对记录已失效，请重新添加设备。", 403, "mobile_device_revoked");
      device = stored;
    } else {
      if (now >= invite.expiresAt) throw new DeviceConnectionError("手机邀请已过期，请刷新二维码。", 401, "mobile_invitation_expired");
      if (this.#state.devices.some((entry) => entry.id === invite.deviceId)) {
        throw new DeviceConnectionError("手机配对记录发生冲突。", 409, "mobile_pairing_conflict");
      }
      device = {
        id: invite.deviceId, name: invite.name === "新手机" ? request.deviceName : invite.name,
        kind: "reverse-ws", rootDir: "", envToken: secret(), clientToken: secret(), pairedAt: now,
        info: request.info, mobile: { invitationId: invite.id, installationHash },
      };
      const completed: StoredMobileInvitation = { ...invite, binding: {
        installationHash, attemptHash, pairedAt: now, recoveryExpiresAt: now + MOBILE_PAIRING_RECOVERY_TTL_MS,
      } };
      this.#commit({ ...this.#state, devices: [...this.#state.devices, device],
        mobileInvitations: invites.map((entry) => entry.id === invite.id ? completed : entry) });
    }
    this.#env.setDeviceCredential(device.id, device.envToken);
    this.#env.setDeviceDisplayName(device.id, device.name);
    return { ...this.#mobilePublicProfile(device, invite.metadata), clientToken: device.clientToken, envToken: device.envToken };
  }

  cancelMobileInvitation(id: string): void {
    const invites = this.#state.mobileInvitations;
    if (!invites?.some((invite) => invite.id === id && !invite.binding)) return;
    this.#commit({ ...this.#state, mobileInvitations: invites.filter((invite) => invite.id !== id || invite.binding) });
  }

  mobileProfile(deviceId: string, connectionMetadata: MobileConnectionMetadata): MobilePublicProfile {
    this.#requireMobileEnabled();
    const metadata = mobileInput(() => parseMobileMetadata(connectionMetadata));
    this.#checkMobileHub(metadata);
    const device = this.#state.devices.find((entry) => entry.id === deviceId && entry.pairedAt && entry.mobile && !this.#state.revokedIds?.includes(entry.id));
    if (!device) throw new DeviceConnectionError("找不到已配对的手机设备。", 404, "mobile_device_not_found");
    return this.#mobilePublicProfile(device, metadata);
  }

  cancelInvitation(id: string): void {
    const invite = this.#invites.get(id);
    if (!invite) return;
    this.#invites.delete(id);
    this.#state.devices = this.#state.devices.filter((d) => d.id !== invite.deviceId || d.pairedAt);
    this.#save();
  }

  rename(id: string, name: unknown): void {
    if (this.isLocalPrincipal(id)) {
      const nextName = deviceName(name);
      this.#state.localName = nextName;
      const selfRecord = this.getSelfDeviceRecord();
      if (selfRecord) selfRecord.name = nextName;
      this.#save();
      this.#env.setDeviceDisplayName(this.localNodeId, nextName);
      return;
    }
    const device = this.#state.devices.find((d) => d.id === id);
    if (device) device.name = deviceName(name);
    else {
      if (!isLegacyEnvId(id)) throw new DeviceConnectionError("设备标识无效。");
      if (!this.#env.listEnvs().some((env) => env.id === id && env.kind !== "local")) throw new DeviceConnectionError("找不到设备。", 404);
      this.#state.legacyNames = { ...this.#state.legacyNames, [id]: deviceName(name) };
    }
    this.#save();
    this.#env.setDeviceDisplayName(id, device ? device.name : this.#state.legacyNames![id]);
  }

  remove(id: string): void {
    if (this.isLocalPrincipal(id)) throw new DeviceConnectionError("不能移除主脑设备。");
    if (!NODE_ID_RE.test(id)) {
      const knownLegacy = isLegacyEnvId(id) && ((this.#state.legacyNames && Object.hasOwn(this.#state.legacyNames, id)) ||
        this.#env.listEnvs().some((env) => env.id === id && env.kind !== "local"));
      if (!knownLegacy) throw new DeviceConnectionError("设备标识无效。");
    }
    const wasStandby = Boolean(this.#state.devices.find((d) => d.id === id)?.standby);
    this.#state.revokedIds = [...new Set([...(this.#state.revokedIds ?? []), id])];
    this.#state.devices = this.#state.devices.filter((d) => d.id !== id);
    this.#syncStatuses.delete(id);
    if (this.#state.mobileInvitations) this.#state.mobileInvitations = this.#state.mobileInvitations.filter((invite) => invite.deviceId !== id);
    if (this.#state.legacyNames) delete this.#state.legacyNames[id];
    for (const [key, invite] of this.#invites) if (invite.deviceId === id) this.#invites.delete(key);
    this.#save();
    if (wasStandby) this.#env.sendStandbyWipe(id, "device_removed");
    this.#env.removeDevice(id);
  }

  recordSsh(record: DeviceSshRecord): void {
    const device = this.#state.devices.find((d) => d.id === record.deviceId);
    if (!device) throw new DeviceConnectionError("SSH 设备配对记录不存在。", 404);
    device.ssh = record;
    this.#save();
  }

  setError(id: string, message: string): void {
    const device = this.#state.devices.find((d) => d.id === id);
    if (device) { device.error = message; this.#save(); }
  }

  #observe(envs: EnvNodeDescriptor[]): void {
    let changed = false;
    for (const device of this.#state.devices) {
      if (device.id === this.#state.localNodeId) continue;
      const env = envs.find((e) => e.id === device.id);
      if (!env) continue;
      if (env.info) {
        const info = parseDeviceInfo(env.info);
        if (JSON.stringify(device.info) !== JSON.stringify(info)) { device.info = info; changed = true; }
      }
      if (env.listenPort !== undefined && device.listenPort !== env.listenPort) {
        device.listenPort = env.listenPort;
        changed = true;
      }
      if (env.standbyPublicKey && device.standbyPublicKey !== env.standbyPublicKey && !device.standby) {
        device.standbyPublicKey = env.standbyPublicKey;
        changed = true;
      }
      if (env.identityPublicKey && device.identityPublicKey !== env.identityPublicKey && !device.standby) {
        device.identityPublicKey = env.identityPublicKey;
        changed = true;
      }
      if (device.listenPort && device.info?.ips.length) {
        const nextUrls = buildUrlsFromIps(device.info.ips, device.listenPort);
        if (JSON.stringify(device.urls ?? []) !== JSON.stringify(nextUrls)) {
          device.urls = nextUrls;
          changed = true;
        }
      }
      if (device.rootDir !== env.rootDir) { device.rootDir = env.rootDir; changed = true; }
      if (env.online && device.error) { delete device.error; changed = true; }
      device.lastSeenAt = env.lastSeenAt;
    }
    if (changed) this.#save();
  }

  #expireInvites(): void {
    for (const [id, invite] of this.#invites) if (Date.now() >= invite.expiresAt) this.cancelInvitation(id);
  }

  #requireMobileEnabled(): void {
    if (!this.enabled) throw new DeviceConnectionError("设备互联已关闭。", 403, "mobile_interconnection_disabled");
  }

  #checkMobileHub(metadata: MobileConnectionMetadata): void {
    if (metadata.hubId !== undefined && metadata.hubId !== this.hubId) {
      throw new DeviceConnectionError("手机连接信息不属于当前主脑。", 400, "mobile_identity_mismatch");
    }
  }

  #mobilePublicProfile(device: StoredDevice, metadata: MobileConnectionMetadata): MobilePublicProfile {
    return {
      version: 1, hubId: this.hubId, hubName: metadata.hubName, spkiSHA256: metadata.spkiSHA256,
      deviceId: device.id, name: device.name, candidates: metadata.candidates.map((candidate) => ({ ...candidate })), pairedAt: device.pairedAt!,
    };
  }

  #expireMobileInvitations(): void {
    const invites = this.#state.mobileInvitations;
    if (!invites) return;
    const now = Date.now();
    const retained = invites.filter((invite) => now < (invite.binding?.recoveryExpiresAt ?? invite.expiresAt));
    if (retained.length !== invites.length) this.#commit({ ...this.#state, mobileInvitations: retained });
  }

  #commit(state: DeviceState): void {
    this.#save(state);
    this.#state = state;
  }

  #save(state = this.#state): void {
    const temporary = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.#file);
      this.#onWrite?.();
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "设备连接配置写入和临时文件清理失败。"); }
      throw error;
    }
  }
}
