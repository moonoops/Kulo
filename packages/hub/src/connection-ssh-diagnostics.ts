import { createHash } from "node:crypto";
import net from "node:net";
import type { ConnectionTestErrorCode } from "@kulo/protocol";

export const SSH_HOST_KEY_ALGORITHMS = "ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)";
export const SSH_KEYSCAN_LINE = new RegExp(`^[^\\s#]+\\s+(${SSH_HOST_KEY_ALGORITHMS})\\s+([A-Za-z0-9+/=]+)\\s*$`);
const LOCAL_NETWORK_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal", ".localdomain"] as const;

export interface SshFailureClassification {
  code: ConnectionTestErrorCode;
  message: string;
  hostMismatch?: boolean;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31) || (a === 169 && b === 254);
}

/** Detects private LAN IPs (including IPv4-mapped IPv6), mDNS/LAN suffixes, and single-label LAN hostnames. */
export function isLocalNetworkHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!trimmed || trimmed === "localhost") return false;
  if (LOCAL_NETWORK_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))) return true;
  if (net.isIPv4(trimmed)) return isPrivateIpv4(trimmed);
  if (net.isIPv6(trimmed)) {
    const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(trimmed);
    if (mappedV4) return isPrivateIpv4(mappedV4[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(trimmed);
    if (mappedHex) {
      const hi = Number.parseInt(mappedHex[1]!, 16), lo = Number.parseInt(mappedHex[2]!, 16);
      return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(trimmed);
  }
  return !trimmed.includes(".") && /^[a-z0-9][a-z0-9_-]*$/.test(trimmed);
}

/** OpenSSH `ssh-add -` rejects CRLF private keys with `invalid format`; normalize to LF with trailing newline. */
export function normalizeSshPrivateKey(raw: string): string {
  return `${raw.replace(/\r\n?/g, "\n").trim()}\n`;
}

export function formatSshHostFingerprints(keys: ReadonlyArray<{ algorithm: string; data: string }>): string {
  const unique = [...new Map(keys.map((key) => [`${key.algorithm} ${key.data}`, key])).values()];
  return unique
    .map((key) => `${key.algorithm} SHA256:${createHash("sha256").update(Buffer.from(key.data, "base64")).digest("base64").replace(/=+$/, "")}`)
    .sort()
    .join("\n");
}

/** Parses a known-hosts file, validates every line targets `expectedAlias`, and computes its sorted SHA-256 fingerprint set. */
export function computeSshKnownHostsFingerprint(content: string, expectedAlias: string): string | undefined {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return undefined;
  const keys: Array<{ algorithm: string; data: string }> = [];
  const prefix = `${expectedAlias} `;
  for (const line of lines) {
    if (!line.startsWith(prefix)) return undefined;
    const match = SSH_KEYSCAN_LINE.exec(line);
    if (!match) return undefined;
    keys.push({ algorithm: match[1]!, data: match[2]! });
  }
  return formatSshHostFingerprints(keys);
}

function errorCodeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function classifySshScanFailure(input: {
  error?: unknown;
  host?: string;
  platform?: NodeJS.Platform;
}): SshFailureClassification {
  const code = errorCodeOf(input.error);
  const platform = input.platform ?? process.platform;
  if (code === "connection_program_unavailable") {
    return { code: "connection_program_unavailable", message: "本机未能启动连接程序，请检查 SSH 依赖。" };
  }
  if (code === "connection_cancelled") {
    return { code: "connection_cancelled", message: "连接操作已取消或超时。" };
  }
  if (code === "connection_local_network_blocked" || (platform === "darwin" && input.host && isLocalNetworkHost(input.host))) {
    return {
      code: "connection_local_network_blocked",
      message: "未能读取服务器指纹，请检查地址、端口、网络及 macOS 本地网络权限。",
    };
  }
  return { code: "connection_host_scan_failed", message: "未能读取服务器指纹，请检查地址、端口和网络。" };
}

export function classifySshExecutionFailure(input: {
  error?: unknown;
  exitCode?: number;
  stderr?: string;
  output?: string;
  host?: string;
  authMethod?: "password" | "private-key";
  platform?: NodeJS.Platform;
}): SshFailureClassification {
  const code = errorCodeOf(input.error);
  const platform = input.platform ?? process.platform;
  if (code === "connection_key_invalid") {
    return { code: "connection_key_invalid", message: "SSH 私钥或私钥口令无效。" };
  }
  if (code === "connection_program_unavailable") {
    return { code: "connection_program_unavailable", message: "本机未能启动连接程序，请检查 SSH 依赖。" };
  }
  if (code === "connection_cancelled") {
    return { code: "connection_cancelled", message: "连接操作已取消或超时。" };
  }
  if (code === "connection_local_network_blocked") {
    return { code: "connection_local_network_blocked", message: "无法访问局域网主机，请检查 macOS「本地网络」权限或网络连接。" };
  }
  if (code === "connection_host_mismatch") {
    return { code: "connection_host_mismatch", message: "服务器指纹已变更或校验未通过，请重新核对服务器指纹。", hostMismatch: true };
  }
  if (input.exitCode !== undefined && input.exitCode !== 255) {
    return { code: "connection_execution_failed", message: "连接测试未通过，请检查地址、网络和凭据。" };
  }
  const diag = input.stderr ?? input.output ?? "";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Offending .* key in/i.test(diag)) {
    return { code: "connection_host_mismatch", message: "服务器指纹已变更或校验未通过，请重新核对服务器指纹。", hostMismatch: true };
  }
  if (/No route to host|Operation not permitted/i.test(diag) && platform === "darwin" && input.host && isLocalNetworkHost(input.host)) {
    return { code: "connection_local_network_blocked", message: "无法访问局域网主机，请检查 macOS「本地网络」权限或网络连接。" };
  }
  if (/Could not resolve hostname|nodename nor servname provided|Temporary failure in name resolution|Name or service not known/i.test(diag)) {
    return { code: "connection_execution_failed", message: "无法解析 SSH 主机名，请检查服务器地址和网络。" };
  }
  if (/Connection refused/i.test(diag)) {
    return { code: "connection_execution_failed", message: "目标主机拒绝连接，请检查 SSH 服务与端口。" };
  }
  if (/Connection timed out|Operation timed out/i.test(diag)) {
    return { code: "connection_cancelled", message: "SSH 连接超时，请检查地址、端口和网络。" };
  }
  const denied = /Permission denied(?:\s*\(([^)]+)\))?|Authentication failed/i.exec(diag);
  if (denied) {
    const methods = denied[1]?.toLowerCase().split(",").map((m) => m.trim());
    if (input.authMethod === "password" && methods && methods.length > 0 && !methods.includes("password")) {
      return { code: "connection_auth_failed", message: "目标服务器未开启 SSH 密码登录，请改用 SSH 私钥或开启密码认证。" };
    }
    return { code: "connection_auth_failed", message: "SSH 认证未通过，请检查用户名、密码或私钥。" };
  }
  return { code: "connection_execution_failed", message: "连接测试未通过，请检查地址、网络和凭据。" };
}
