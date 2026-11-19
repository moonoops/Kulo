import { createHash, timingSafeEqual } from "node:crypto";
import {
  filterDeviceIps,
  isDeviceSystemInfo,
  type MobileConnectionCandidate,
  type MobileConnectionMetadata,
  type MobileInvitationData,
  type MobilePairingRequest,
} from "@moco/protocol";

export const MOBILE_INVITATION_TTL_MS = 10 * 60_000;
export const MOBILE_PAIRING_RECOVERY_TTL_MS = 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^device-[0-9a-f]{16}$/;

export interface StoredMobileInvitation {
  id: string;
  deviceId: string;
  tokenHash: string;
  name: string;
  expiresAt: number;
  metadata: MobileConnectionMetadata;
  binding?: {
    installationHash: string;
    attemptHash: string;
    pairedAt: number;
    recoveryExpiresAt: number;
  };
}

export class MobilePairingValidationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "mobile_invalid_request") {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MobilePairingValidationError("手机连接请求格式无效。");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new MobilePairingValidationError(`${label}无效。`);
  }
  return value.trim();
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new MobilePairingValidationError(`${label}须为随机 UUID。`);
  return value.toLowerCase();
}

export function mobileSecretHash(kind: "invitation" | "installation" | "attempt", value: string): string {
  return createHash("sha256").update(`moco.mobile.${kind}\0`).update(value).digest("hex");
}

export function sameMobileHash(actual: string, expected: string): boolean {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseMobileMetadata(value: unknown): MobileConnectionMetadata {
  const input = object(value);
  const hubName = text(input.hubName, 256, "主脑名称");
  if (typeof input.spkiSHA256 !== "string" || !SHA256.test(input.spkiSHA256)) {
    throw new MobilePairingValidationError("主脑身份指纹须为小写 SHA-256。", 400, "mobile_invalid_metadata");
  }
  if (!Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 32) {
    throw new MobilePairingValidationError("请提供有效的主脑连接入口。", 400, "mobile_invalid_metadata");
  }
  const candidates: MobileConnectionCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of input.candidates) {
    const candidate = object(raw);
    if (candidate.route !== "lan" && candidate.route !== "tailscale") {
      throw new MobilePairingValidationError("主脑连接类型无效。", 400, "mobile_invalid_metadata");
    }
    let url: URL;
    try { url = new URL(text(candidate.origin, 2048, "主脑地址")); }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof MobilePairingValidationError)) throw error;
      throw new MobilePairingValidationError("主脑地址无效。", 400, "mobile_invalid_metadata");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") {
      throw new MobilePairingValidationError("手机连接入口必须是没有凭证和路径的 HTTPS 地址。", 400, "mobile_invalid_metadata");
    }
    const key = `${candidate.route}\0${url.origin}`;
    if (!seen.has(key)) { seen.add(key); candidates.push({ route: candidate.route, origin: url.origin }); }
  }
  return {
    ...(input.hubId !== undefined ? { hubId: text(input.hubId, 256, "主脑标识") } : {}),
    hubName, spkiSHA256: input.spkiSHA256, candidates,
  };
}

export function parseMobileInvitationInput(value: unknown): { name: string; metadata: MobileConnectionMetadata } {
  const input = object(value);
  return { name: input.name === undefined ? "新手机" : text(input.name, 100, "设备名称"), metadata: parseMobileMetadata(input) };
}

export function parseMobilePairingRequest(value: unknown): MobilePairingRequest {
  const input = object(value);
  if (typeof input.invitationToken !== "string" || !TOKEN.test(input.invitationToken)) {
    throw new MobilePairingValidationError("手机配对凭证无效。", 401, "mobile_invitation_invalid");
  }
  if (!isDeviceSystemInfo(input.info)) throw new MobilePairingValidationError("手机设备信息无效。");
  return {
    invitationId: uuid(input.invitationId, "邀请标识"), invitationToken: input.invitationToken,
    attemptId: uuid(input.attemptId, "配对尝试标识"), installationId: uuid(input.installationId, "安装身份"),
    deviceName: text(input.deviceName, 100, "设备名称"),
    info: {
      hostname: input.info.hostname, platform: input.info.platform, arch: input.info.arch,
      release: input.info.release, cpu: input.info.cpu, memoryBytes: input.info.memoryBytes,
      ips: filterDeviceIps(input.info.ips),
    },
  };
}

export function encodeMobileInvitation(value: MobileInvitationData): string {
  const qrValue = `moco://pair?data=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  if (Buffer.byteLength(qrValue) > 2300) {
    throw new MobilePairingValidationError("连接入口过多，无法生成可扫描的手机邀请。", 400, "mobile_invitation_too_large");
  }
  return qrValue;
}

export function isStoredMobileInvitation(value: unknown): value is StoredMobileInvitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as StoredMobileInvitation;
  if (typeof row.id !== "string" || !UUID.test(row.id) || row.id !== row.id.toLowerCase() ||
      typeof row.deviceId !== "string" || !DEVICE_ID.test(row.deviceId) ||
      typeof row.tokenHash !== "string" || !SHA256.test(row.tokenHash) ||
      !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0) return false;
  try {
    text(row.name, 100, "设备名称");
    parseMobileMetadata(row.metadata);
  } catch (error) {
    if (error instanceof MobilePairingValidationError) return false;
    throw error;
  }
  const binding = row.binding;
  return binding === undefined || !!binding && typeof binding === "object" && !Array.isArray(binding) &&
    SHA256.test(binding.installationHash) && SHA256.test(binding.attemptHash) &&
    Number.isSafeInteger(binding.pairedAt) && binding.pairedAt >= 0 &&
    Number.isSafeInteger(binding.recoveryExpiresAt) && binding.recoveryExpiresAt > binding.pairedAt;
}

export function isStoredMobileIdentity(value: unknown): value is { invitationId: string; installationHash: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as { invitationId: string; installationHash: string };
  return typeof row.invitationId === "string" && UUID.test(row.invitationId) &&
    row.invitationId === row.invitationId.toLowerCase() && typeof row.installationHash === "string" && SHA256.test(row.installationHash);
}
