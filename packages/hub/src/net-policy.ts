import { isIP } from "node:net";

const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

function stripBrackets(value: string): string {
  return value.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function extractMappedIpv4(ip: string): string | undefined {
  const lower = stripBrackets(ip);
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted && isIP(dotted[1]!) === 4) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
  }
  return undefined;
}

function expandIpv6Hextets(ip: string): number[] | undefined {
  const lower = stripBrackets(ip);
  if (isIP(lower) !== 6) return undefined;
  const parts = lower.split("::");
  if (parts.length > 2) return undefined;
  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const parsePart = (tokens: string[]): number[] | undefined => {
    const out: number[] = [];
    for (const tok of tokens) {
      if (tok.includes(".")) {
        if (isIP(tok) !== 4) return undefined;
        const [a = 0, b = 0, c = 0, d = 0] = tok.split(".").map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else {
        const val = parseInt(tok, 16);
        if (!Number.isFinite(val) || val < 0 || val > 0xffff) return undefined;
        out.push(val);
      }
    }
    return out;
  };
  const l = parsePart(left);
  const r = parsePart(right);
  if (!l || !r) return undefined;
  const missing = 8 - l.length - r.length;
  if (parts.length === 1 && missing !== 0) return undefined;
  if (parts.length === 2 && missing < 1) return undefined;
  return [...l, ...new Array<number>(Math.max(0, missing)).fill(0), ...r];
}

function isAwsIpv6Imds(ip: string): boolean {
  const h = expandIpv6Hextets(ip);
  return Boolean(
    h &&
      h[0] === 0xfd00 &&
      h[1] === 0x0ec2 &&
      h[2] === 0 &&
      h[3] === 0 &&
      h[4] === 0 &&
      h[5] === 0 &&
      h[6] === 0 &&
      h[7] === 0x0254,
  );
}

/**
 * Strictly identifies cloud instance metadata endpoints and unspecified/link-local addresses.
 * Blocked even when private/loopback network access is allowed in trusted mode.
 * Notably blocks Alibaba Cloud metadata (100.100.100.200) inside CGNAT/Tailscale 100.64.0.0/10.
 */
export function isCloudMetadataHostOrIp(hostOrIp: string): boolean {
  const normalized = stripBrackets(hostOrIp);
  if (!normalized) return true;
  if (CLOUD_METADATA_HOSTNAMES.has(normalized)) return true;

  const mappedV4 = extractMappedIpv4(normalized);
  const v4 = isIP(normalized) === 4 ? normalized : mappedV4;
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map(Number);
    if (a === 169 && b === 254) return true; // AWS/GCP/Azure IMDS + IPv4 link-local
    if (a === 100 && b === 100 && c === 100 && d === 200) return true; // Alibaba Cloud metadata
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    return false;
  }

  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
    const h = expandIpv6Hextets(normalized);
    if (h && h.every((x) => x === 0)) return true;
    // IPv6 link-local fe80::/10 and AWS IPv6 IMDS fd00:ec2::254 (canonical or expanded)
    const first = h ? h[0]! : parseInt(normalized.split(":")[0] ?? "0", 16);
    if (Number.isFinite(first) && (first & 0xffc0) === 0xfe80) return true;
    if (isAwsIpv6Imds(normalized)) return true;
    return false;
  }

  return false;
}

/**
 * Identifies any non-public IP address (private, loopback, CGNAT/Tailscale, Fake-IP, link-local,
 * multicast, documentation, non-global IPv6). Used by strict public SSRF checks in sandboxed mode.
 */
export function isRestrictedPublicAddress(address: string): boolean {
  const ip = stripBrackets(address);
  const mappedV4 = extractMappedIpv4(ip);
  const v4 = isIP(ip) === 4 ? ip : mappedV4;
  if (v4) {
    const [a = 0, b = 0, c = 0] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6) {
    // Only global-unicast IPv6 is allowed; mapped, local, transition and documentation ranges are excluded.
    const first = parseInt(ip.split(":")[0] ?? "0", 16);
    return (
      !Number.isFinite(first) ||
      first < 0x2000 ||
      first > 0x3fff ||
      /^2001:(?:0:|db8:)/.test(ip) ||
      /^2002:|^3fff:/.test(ip)
    );
  }
  return false;
}

export function isFakeIpAddress(address: string): boolean {
  const ip = stripBrackets(address);
  const v4 = isIP(ip) === 4 ? ip : extractMappedIpv4(ip);
  return Boolean(v4 && /^198\.(?:18|19)\./.test(v4));
}

/**
 * Identifies loopback, LAN, Tailscale (excluding Alibaba metadata), or local-domain hosts.
 * Used to route local/LAN requests appropriately and permit HTTP on private hosts in trusted mode.
 */
export function isPrivateOrLoopbackHost(hostOrIp: string): boolean {
  const host = stripBrackets(hostOrIp);
  if (!host || isCloudMetadataHostOrIp(host)) return false;
  if (host === "localhost" || /\.(?:localhost|local|internal|lan|home|ts\.net)$/.test(host)) {
    return true;
  }
  if (!host.includes(".") && !isIP(host)) return true; // single-label intranet hostname

  const mappedV4 = extractMappedIpv4(host);
  const v4 = isIP(host) === 4 ? host : mappedV4;
  if (v4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (isIP(host) === 6) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    const first = parseInt(host.split(":")[0] ?? "0", 16);
    if (Number.isFinite(first) && (first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  }

  return false;
}

export function isLoopbackHost(hostOrIp: string): boolean {
  const host = stripBrackets(hostOrIp);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = isIP(host) === 4 ? host : extractMappedIpv4(host);
  if (v4) return v4.startsWith("127.");
  if (isIP(host) === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

export const SAFE_HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_SAFE_HTTP_REDIRECTS = 3;

const CROSS_ORIGIN_STRIPPED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

export function isReplayableHttpBody(body: RequestInit["body"]): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  return false;
}

export interface PreparedHttpRedirect {
  url: URL;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
}

/**
 * Strict RFC 9110 redirect evaluator for API & MCP HTTP clients:
 * - Same-origin 303 (or 301/302 on POST) downgrades method to GET and drops body + content headers.
 * - Same-origin 307/308 (and non-POST 301/302) preserves method only when body is non-streaming/replayable.
 * - Cross-origin 3xx is ONLY permitted for bodyless GET/HEAD and strips Authorization, Cookie,
 *   Proxy-Authorization, and any configured custom auth header; cross-origin requests with a body
 *   or mutating method (including 307/308 and OAuth/DCR POST) always abort.
 */
export function prepareSafeHttpRedirect(input: {
  status: number;
  location: string | null;
  currentUrl: URL;
  initialOrigin: string;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
  authHeaderName?: string;
}): PreparedHttpRedirect {
  if (!input.location) {
    throw Object.assign(new Error("HTTP 重定向缺少目标地址。"), { code: "connection_redirect_invalid", status: 502 });
  }
  let nextUrl: URL;
  try {
    nextUrl = new URL(input.location, input.currentUrl);
  } catch {
    throw Object.assign(new Error("HTTP 重定向目标地址无效。"), { code: "connection_redirect_invalid", status: 502 });
  }
  if (nextUrl.username || nextUrl.password) {
    throw Object.assign(new Error("HTTP 重定向目标不能包含内嵌凭据。"), { code: "connection_redirect_blocked", status: 400 });
  }
  if (isCloudMetadataHostOrIp(nextUrl.hostname)) {
    throw Object.assign(new Error("已阻止重定向到受保护的云元数据地址。"), { code: "connection_redirect_blocked", status: 403 });
  }

  const currentMethod = input.method.toUpperCase();
  const sameOrigin = nextUrl.origin === input.currentUrl.origin;
  const nextHeaders = new Headers(input.headers);

  if (!sameOrigin) {
    const hasBody = input.body !== undefined && input.body !== null;
    if ((currentMethod !== "GET" && currentMethod !== "HEAD") || hasBody) {
      throw Object.assign(
        new Error("禁止将携带正文或写方法的 HTTP 请求跨站重定向。"),
        { code: "connection_cross_origin_redirect_blocked", status: 403 },
      );
    }
    const customAuth = input.authHeaderName?.trim().toLowerCase();
    for (const key of [...nextHeaders.keys()]) {
      const lower = key.toLowerCase();
      if (CROSS_ORIGIN_STRIPPED_HEADERS.has(lower) || (customAuth && lower === customAuth)) {
        nextHeaders.delete(key);
      }
    }
    return { url: nextUrl, method: currentMethod, headers: nextHeaders, body: undefined };
  }

  let nextMethod = currentMethod;
  let nextBody = input.body;
  if (input.status === 303 || ((input.status === 301 || input.status === 302) && currentMethod === "POST")) {
    nextMethod = "GET";
    nextBody = undefined;
    nextHeaders.delete("content-type");
    nextHeaders.delete("content-length");
  } else if (nextBody !== undefined && nextBody !== null && !isReplayableHttpBody(nextBody)) {
    throw Object.assign(
      new Error("不支持对流式请求体执行重定向重放。"),
      { code: "connection_redirect_non_replayable_body", status: 400 },
    );
  }

  if (nextUrl.origin !== input.initialOrigin) {
    const customAuth = input.authHeaderName?.trim().toLowerCase();
    for (const key of [...nextHeaders.keys()]) {
      const lower = key.toLowerCase();
      if (CROSS_ORIGIN_STRIPPED_HEADERS.has(lower) || (customAuth && lower === customAuth)) {
        nextHeaders.delete(key);
      }
    }
  }

  return { url: nextUrl, method: nextMethod, headers: nextHeaders, body: nextBody };
}
