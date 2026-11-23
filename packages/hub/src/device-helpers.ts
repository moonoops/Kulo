import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  filterDeviceIps,
  isDeviceSystemInfo,
  type ClusterTopology,
  type DevicePeerConfig,
  type DeviceSystemInfo,
} from "@kulo/protocol";
import { isCredentialDeviceSshRecord, type StoredDeviceSshRecord } from "./device-ssh.js";
import { MobilePairingValidationError } from "./mobile-pairing.js";

export class DeviceConnectionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "device_connection_error") {
    super(message);
  }
}

export const NODE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;
export const BASE64URL_KEY_RE = /^[A-Za-z0-9_-]{32,256}$/;

export function secret(): string { return randomBytes(32).toString("base64url"); }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function addressPriority(ip: string): number {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
    ? 0
    : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
      ? 1
      : ip.includes(":")
        ? 3
        : 2;
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

export function buildUrlsFromIps(ips: readonly string[], port: number): string[] {
  const urls: string[] = [];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return urls;
  for (const ip of [...filterDeviceIps(ips)].sort((a, b) => addressPriority(a) - addressPriority(b))) {
    try {
      const origin = normalizedHubUrl(`http://${ip.includes(":") ? `[${ip}]` : ip}:${port}`);
      if (!urls.includes(origin)) urls.push(origin);
    } catch {
      // Skip non-shareable addresses
    }
  }
  return urls;
}

export function peerConfig(
  device: { id: string; name: string; envToken: string; clientToken: string; rootDir: string },
  hubUrl: string,
  cluster?: ClusterTopology,
): DevicePeerConfig {
  return {
    version: 1,
    deviceId: device.id,
    name: device.name,
    hubUrl,
    envToken: device.envToken,
    clientToken: device.clientToken,
    rootDir: device.rootDir,
    ...(cluster ? { cluster } : {}),
  };
}

export function mobileInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof MobilePairingValidationError) throw new DeviceConnectionError(error.message, error.status, error.code);
    throw error;
  }
}

export function parseDeviceInfo(value: unknown): DeviceSystemInfo {
  if (!isDeviceSystemInfo(value)) throw new DeviceConnectionError("设备信息无效。");
  const info = value;
  return {
    hostname: info.hostname,
    platform: info.platform,
    arch: info.arch,
    release: info.release,
    cpu: info.cpu,
    memoryBytes: info.memoryBytes,
    ips: filterDeviceIps(info.ips),
    ...(info.model ? { model: info.model } : {}),
  };
}

export function isDeviceName(raw: unknown): raw is string {
  return typeof raw === "string" && !!raw.trim() && raw.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(raw);
}

export function isLegacyEnvId(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256 && raw === raw.trim() && raw !== "local" && !/[\x00-\x1f\x7f]/.test(raw);
}

export function deviceName(raw: unknown, fallback?: string): string {
  if ((raw === undefined || raw === "") && fallback !== undefined) return fallback;
  if (!isDeviceName(raw)) throw new DeviceConnectionError("设备名称须为 1–100 个字符。");
  return raw.trim();
}

/** Validates both credential-bound SSH device records and legacy target-based records on startup load. */
export function isValidStoredDeviceSshRecord(value: unknown): value is StoredDeviceSshRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.deviceId !== "string" || !NODE_ID_RE.test(rec.deviceId)) return false;
  if (typeof rec.remotePort !== "number" || !Number.isInteger(rec.remotePort) || rec.remotePort < 1 || rec.remotePort > 65_535) return false;
  if (typeof rec.remoteNodePath !== "string" || !rec.remoteNodePath || rec.remoteNodePath.length > 4096 || /[\x00-\x1f\x7f]/.test(rec.remoteNodePath)) return false;
  if (rec.remoteShell !== undefined && rec.remoteShell !== "cmd" && rec.remoteShell !== "powershell" && rec.remoteShell !== "git-bash") return false;
  if (isCredentialDeviceSshRecord(value)) {
    if (rec.name !== undefined && !isDeviceName(rec.name)) return false;
    if (rec.rootDir !== undefined && (typeof rec.rootDir !== "string" || rec.rootDir.length > 4096 || /[\x00-\x1f\x7f]/.test(rec.rootDir))) return false;
    return true;
  }
  const target = rec.target;
  return Boolean(target && typeof target === "object" && !Array.isArray(target) && typeof (target as { host?: unknown }).host === "string" && (target as { host: string }).host.length > 0);
}
