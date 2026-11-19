import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { collectDeviceSystemInfo, type EnvManager } from "@kulo/env";
import { filterDeviceIps, formatDeviceInstallerInstructions, isDeviceSystemInfo, type DeviceInterconnectionView, type DeviceInvitation, type DevicePeerConfig, type DeviceSystemInfo, type EnvNodeDescriptor, type MobileConnectionMetadata, type MobileInvitation, type MobilePairingProfile, type MobilePublicProfile } from "@kulo/protocol";
import type { DeviceSshRecord } from "./device-ssh.js";
import type { ChatMessageSource } from "./chat-submissions.js";
import { encodeMobileInvitation, isStoredMobileIdentity, isStoredMobileInvitation, MOBILE_INVITATION_TTL_MS, MOBILE_PAIRING_RECOVERY_TTL_MS, mobileSecretHash, MobilePairingValidationError, parseMobileInvitationInput, parseMobileMetadata, parseMobilePairingRequest, sameMobileHash, type StoredMobileInvitation } from "./mobile-pairing.js";

interface StoredDevice {
  id: string;
  name: string;
  kind: "reverse-ws" | "ssh";
  rootDir: string;
  envToken: string;
  clientToken: string;
  pairedAt?: number;
  info?: DeviceSystemInfo;
  lastSeenAt?: number;
  ssh?: DeviceSshRecord;
  error?: string;
  mobile?: { invitationId: string; installationHash: string };
  pairingRecovery?: { proofHash: string; hubUrl: string; expiresAt: number };
}

interface DeviceState {
  version: 1;
  hubId: string;
  enabled: boolean;
  localName?: string;
  legacyNames?: Record<string, string>;
  devices: StoredDevice[];
  revokedIds?: string[];
  mobileInvitations?: StoredMobileInvitation[];
}

export class DeviceConnectionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "device_connection_error") { super(message); }
}

function secret(): string { return randomBytes(32).toString("base64url"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function peerConfig(device: StoredDevice, hubUrl: string): DevicePeerConfig {
  return { version: 1, deviceId: device.id, name: device.name, hubUrl, envToken: device.envToken, clientToken: device.clientToken, rootDir: device.rootDir };
}

function mobileInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof MobilePairingValidationError) throw new DeviceConnectionError(error.message, error.status, error.code);
    throw error;
  }
}

export function normalizedHubUrl(raw: unknown, allowLoopback = false): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new DeviceConnectionError("请输入有效的主脑地址。");
  let url: URL;
  try { url = new URL(raw); } catch { throw new DeviceConnectionError("请输入完整的主脑地址（http:// 或 https://）。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") {
    throw new DeviceConnectionError("主脑地址必须是没有凭证和路径的 HTTP 或 HTTPS 地址。");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!allowLoopback && (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || ["::1", "0.0.0.0", "::"].includes(host) || /^::ffff:(?:127\.|7f)/.test(host))) {
    throw new DeviceConnectionError("请选择其他设备能够访问的主脑地址。");
  }
  return url.origin;
}

export function parseDeviceInfo(value: unknown): DeviceSystemInfo {
  if (!isDeviceSystemInfo(value)) throw new DeviceConnectionError("设备信息无效。");
  const info = value;
  return { hostname: info.hostname, platform: info.platform, arch: info.arch, release: info.release, cpu: info.cpu, memoryBytes: info.memoryBytes, ips: filterDeviceIps(info.ips) };
}

function isDeviceName(raw: unknown): raw is string {
  return typeof raw === "string" && !!raw.trim() && raw.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(raw);
}

function isLegacyEnvId(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256 && raw === raw.trim() && raw !== "local" && !/[\x00-\x1f\x7f]/.test(raw);
}

function deviceName(raw: unknown, fallback?: string): string {
  if ((raw === undefined || raw === "") && fallback !== undefined) return fallback;
  if (!isDeviceName(raw)) throw new DeviceConnectionError("设备名称须为 1–100 个字符。");
  return raw.trim();
}

export class DeviceInterconnectionManager {
  readonly #file: string;
  readonly #env: EnvManager;
  readonly #invites = new Map<string, { deviceId: string; tokenHash: string; hubUrl: string; expiresAt: number }>();
  #state: DeviceState;

  constructor(stateDir: string, env: EnvManager, legacyEnabled = false) {
    this.#file = path.join(stateDir, "devices.json");
    this.#env = env;
    if (fs.existsSync(this.#file)) {
      const state = JSON.parse(fs.readFileSync(this.#file, "utf8")) as DeviceState;
      if (state.version !== 1 || typeof state.hubId !== "string" || typeof state.enabled !== "boolean" || !Array.isArray(state.devices) ||
          (state.localName !== undefined && !isDeviceName(state.localName)) ||
          (state.legacyNames !== undefined && (!state.legacyNames || typeof state.legacyNames !== "object" || Array.isArray(state.legacyNames) ||
            Object.entries(state.legacyNames).some(([id, name]) => !isLegacyEnvId(id) || !isDeviceName(name)))) ||
          (state.mobileInvitations !== undefined && (!Array.isArray(state.mobileInvitations) || state.mobileInvitations.some((invite) => !isStoredMobileInvitation(invite) || invite.metadata.hubId !== undefined && invite.metadata.hubId !== state.hubId))) ||
          state.devices.some((d) => !/^[a-zA-Z0-9_-]{1,100}$/.test(d.id) || d.id === "local" || typeof d.envToken !== "string" || typeof d.clientToken !== "string" || !d.envToken || !d.clientToken || d.envToken === d.clientToken || d.mobile !== undefined && !isStoredMobileIdentity(d.mobile) ||
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
    for (const [id, name] of Object.entries(this.#state.legacyNames ?? {})) this.#env.setDeviceDisplayName(id, name);
    for (const d of this.#state.devices) if (d.pairedAt) {
      this.#env.setDeviceCredential(d.id, d.envToken);
      this.#env.setDeviceDisplayName(d.id, d.name);
    }
    this.#env.setDeviceDisplayName("local", this.#state.localName);
    for (const id of this.#state.revokedIds ?? []) this.#env.removeDevice(id);
    this.#env.setRemoteConnectionsEnabled(this.enabled);
  }

  get enabled(): boolean { return this.#state.enabled; }
  get hubId(): string { return this.#state.hubId; }
  get sshRecords(): DeviceSshRecord[] { return this.#state.devices.flatMap((d) => d.ssh ? [d.ssh] : []); }

  authenticateClient(token: string | undefined): string | undefined {
    if (!this.enabled || !token || token.length > 8192) return undefined;
    return this.#state.devices.find((d) => d.pairedAt && equalSecret(token, d.clientToken))?.id;
  }

  chatMessageSource(deviceId: string): ChatMessageSource | undefined {
    if (deviceId === "local") return { deviceId, name: this.#state.localName ?? this.#env.getEnvDescriptor(deviceId)?.name ?? "主脑", kind: "computer" };
    const device = this.enabled ? this.#state.devices.find((entry) => entry.id === deviceId && entry.pairedAt) : undefined;
    if (device) return { deviceId, name: device.name, kind: device.mobile ? "android" : "computer" };
  }

  authenticateEnv(token: string | undefined): string | undefined {
    if (!this.enabled || !token || token.length > 8192) return undefined;
    return this.#state.devices.find((device) => device.pairedAt && !this.#state.revokedIds?.includes(device.id) && equalSecret(token, device.envToken))?.id;
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

  view(port: number, origin: string, currentDeviceId = "local"): DeviceInterconnectionView {
    this.#expireInvites();
    this.#expireMobileInvitations();
    const envs = this.#env.listEnvs();
    this.#observe(envs);
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
    const addressPriority = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 1 : ip.includes(":") ? 3 : 2;
    for (const ip of [...localInfo.ips].sort((a, b) => addressPriority(a) - addressPriority(b))) {
      add(`http://${ip.includes(":") ? `[${ip}]` : ip}:${port}`);
    }
    const local = envs.find((e) => e.kind === "local");
    const hubName = this.#state.localName ?? (local?.name && local.name !== `Local (${localInfo.hostname})` ? local.name : localInfo.hostname);
    const remoteEnvs = envs.filter((e) => e.kind !== "local");
    const records = this.#state.devices;
    return {
      enabled: this.enabled, role: currentDeviceId === "local" ? "hub" : "joined",
      hubId: this.#state.hubId, hubName, currentDeviceId, hubUrls: urls,
      devices: [
        { id: "local", name: hubName, kind: "local", status: "online", rootDir: local?.rootDir ?? "", info: localInfo },
        ...records.map((d) => {
          const env = remoteEnvs.find((e) => e.id === d.id);
          const info = env?.info ?? d.info;
          return { id: d.id, name: d.name, kind: d.kind, status: env?.online ? "online" as const : !d.pairedAt ? "pending" as const : "offline" as const,
            rootDir: env?.rootDir ?? d.rootDir, info: info ? parseDeviceInfo(info) : undefined, lastSeenAt: env?.lastSeenAt ?? d.lastSeenAt, ...(d.error ? { error: d.error } : {}) };
        }),
        ...remoteEnvs.filter((e) => !records.some((d) => d.id === e.id)).map((e) => ({ id: e.id, name: this.#state.legacyNames && Object.hasOwn(this.#state.legacyNames, e.id) ? this.#state.legacyNames[e.id]! : e.name, kind: e.kind, status: e.online ? "online" as const : "offline" as const, rootDir: e.rootDir, info: e.info ? parseDeviceInfo(e.info) : undefined, lastSeenAt: e.lastSeenAt })),
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

  pair(input: { inviteToken?: unknown; expectedHubId?: unknown; attemptKey?: unknown; info?: unknown; rootDir?: unknown }): DevicePeerConfig {
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
      if (device?.pairingRecovery && !this.#state.revokedIds?.includes(device.id)) return peerConfig(device, device.pairingRecovery.hubUrl);
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
    // Persist the winning claim and credentials together before consuming the one-time invitation.
    this.#commit({ ...this.#state, devices: this.#state.devices.map((item) => item.id === pending.id ? device : item) });
    this.#invites.delete(id);
    this.#env.setDeviceCredential(device.id, device.envToken);
    this.#env.setDeviceDisplayName(device.id, device.name);
    return peerConfig(device, invite.hubUrl);
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
      // The invitation claim, identity binding, and both credentials commit together.
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
    if (id === "local") {
      this.#state.localName = deviceName(name);
      this.#save();
      this.#env.setDeviceDisplayName(id, this.#state.localName);
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
    if (id === "local") throw new DeviceConnectionError("不能移除主脑设备。");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
      const knownLegacy = isLegacyEnvId(id) && ((this.#state.legacyNames && Object.hasOwn(this.#state.legacyNames, id)) ||
        this.#env.listEnvs().some((env) => env.id === id && env.kind !== "local"));
      if (!knownLegacy) throw new DeviceConnectionError("设备标识无效。");
    }
    this.#state.revokedIds = [...new Set([...(this.#state.revokedIds ?? []), id])];
    this.#state.devices = this.#state.devices.filter((d) => d.id !== id);
    if (this.#state.mobileInvitations) this.#state.mobileInvitations = this.#state.mobileInvitations.filter((invite) => invite.deviceId !== id);
    if (this.#state.legacyNames) delete this.#state.legacyNames[id];
    for (const [key, invite] of this.#invites) if (invite.deviceId === id) this.#invites.delete(key);
    this.#save();
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
      const env = envs.find((e) => e.id === device.id);
      if (!env) continue;
      if (env.info) {
        const info = parseDeviceInfo(env.info);
        if (JSON.stringify(device.info) !== JSON.stringify(info)) { device.info = info; changed = true; }
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
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "设备连接配置写入和临时文件清理失败。"); }
      throw error;
    }
  }
}
