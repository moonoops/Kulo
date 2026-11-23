import type { CustomProviderApi } from "./domain.js";

export const KEYLESS_LOCAL_MODEL_APIS: ReadonlySet<CustomProviderApi> = new Set<CustomProviderApi>([
  "openai-completions",
  "openai-responses",
]);

const BLOCKED_LOCAL_HOSTNAMES = new Set([
  "metadata",
  "instance-data",
  "wpad",
  "isatap",
  "kubernetes",
]);

const SINGLE_LABEL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SINGLE_LEVEL_LOCAL_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:local|lan|home\.arpa)$/;

function stripBracketsAndTrailingDot(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  const unwrapped = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  return unwrapped.replace(/\.+$/, "");
}

function parseIpv4(host: string): [number, number, number, number] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/**
 * Normalizes IPv4-mapped IPv6 literals in both dotted (`::ffff:127.0.0.1`) and
 * WHATWG URL hex-pair (`::ffff:7f00:1`) forms back to IPv4 dotted notation.
 */
export function unwrapIpv4MappedIpv6(raw: string): string {
  const bare = stripBracketsAndTrailingDot(raw);
  const dotted = /^(?:0{0,4}:){0,5}:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(bare);
  if (dotted && parseIpv4(dotted[1]!)) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return bare;
}

function isIpv6Literal(host: string): boolean {
  return host.includes(":") && /^[0-9a-f:]+$/i.test(host);
}

/**
 * Positive allowlist for literal private/loopback IP addresses eligible for
 * keyless self-hosted model endpoints. Explicitly rejects cloud metadata IPs
 * (169.254.0.0/16, 100.100.100.200, fe80::/10), unspecified (0.0.0.0/8, ::),
 * multicast/broadcast (>=224.0.0.0, ff00::/8), and all public IPs.
 */
export function isAllowedPrivateModelIp(rawIp: string): boolean {
  const bare = unwrapIpv4MappedIpv6(rawIp);
  const v4 = parseIpv4(bare);
  if (v4) {
    const [a, b, c, d] = v4;
    if (a === 127) return true;                                               // 127.0.0.0/8 loopback
    if (a === 10) return true;                                                // 10.0.0.0/8 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;                         // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;                                  // 192.168.0.0/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) {
      return !(a === 100 && b === 100 && c === 100 && d === 200);             // 100.64.0.0/10 Tailscale/CGNAT minus Alibaba IMDS
    }
    return false;
  }
  if (isIpv6Literal(bare)) {
    // Expand zero compression safely only to verify ::1 or fc00::/7 ULA.
    if (bare === "::1" || /^(?:0{1,4}:){7}0{0,3}1$/.test(bare)) return true;
    const first = bare.split(":")[0] ?? "";
    if (!first) return false;
    const word = parseInt(first, 16);
    if (!Number.isNaN(word) && (word & 0xfe00) === 0xfc00) return true;       // fc00::/7 ULA
    return false;
  }
  return false;
}

export function isIpLiteralHost(rawHost: string): boolean {
  const bare = unwrapIpv4MappedIpv6(rawHost);
  return parseIpv4(bare) !== undefined || isIpv6Literal(bare);
}

/**
 * Positive allowlist for self-hosted local/LAN model endpoints.
 * Rejects `.internal`, multi-level `.local` (e.g. `*.svc.cluster.local`),
 * reserved cloud/cluster names (`metadata`, `instance-data`, `wpad`, `isatap`, `kubernetes`),
 * cloud metadata IPs, multicast/unspecified IPs, and all public internet hosts.
 */
export function isPrivateLocalModelEndpoint(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;

  const host = stripBracketsAndTrailingDot(parsed.hostname);
  if (!host) return false;

  if (isIpLiteralHost(host)) {
    return isAllowedPrivateModelIp(host);
  }

  const labels = host.split(".");
  if (labels.some((label) => BLOCKED_LOCAL_HOSTNAMES.has(label))) return false;
  if (host === "localhost" || (host.endsWith(".localhost") && labels.every((l) => SINGLE_LABEL_HOST.test(l)))) {
    return true;
  }
  if (SINGLE_LEVEL_LOCAL_SUFFIX.test(host)) return true;
  if (SINGLE_LABEL_HOST.test(host)) return true;
  return false;
}

export function supportsKeylessLocalModel(baseUrl: string, api: CustomProviderApi): boolean {
  return KEYLESS_LOCAL_MODEL_APIS.has(api) && isPrivateLocalModelEndpoint(baseUrl);
}
