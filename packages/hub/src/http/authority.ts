import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * Forwarding headers that indicate a request traversed an HTTP reverse proxy.
 * Any presence forces both `isHubLocalDisplay` and `hasOwnerHubControl` to false.
 */
export const UNTRUSTED_PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
] as const;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface HubAuthorityDevices {
  readonly enabled: boolean;
  readonly localNodeId: string;
  authenticateClient(token: string | undefined): string | undefined;
  isLocalPrincipal(id: string): boolean;
  isActivePairedPrincipal(id: string): boolean;
  isMobilePrincipal(id: string): boolean;
  isSshPrincipal(id: string): boolean;
}

export interface HubRequestAuthority {
  /** Authenticated principal ID (Hub `localNodeId` or active paired peer device ID). */
  readonly principalId: string | undefined;
  /** Whether authentication came from `Authorization: Bearer` vs URL `?token=`. */
  readonly authSource: "bearer" | "query" | undefined;
  /** Direct loopback connection with no reverse-proxy headers and no cross-site signal. */
  readonly isDirectLoopback: boolean;
  /** Request passed browser same-origin / non-cross-site verification. */
  readonly isSameOrigin: boolean;
  /** Physical local Hub display/process loopback (Hub admin token on direct loopback). */
  readonly isHubLocalDisplay: boolean;
  /** Active paired Peer authenticated over a clean non-proxied, same-origin channel. */
  readonly isTrustedPairedPeer: boolean;
  /** Unified owner Hub command authority (Hub loopback OR trusted active paired peer; mutations are Bearer-only). */
  readonly hasOwnerHubControl: boolean;
  /** Authenticated principal is a paired mobile device. */
  readonly isMobilePrincipal: boolean;
  /** Authenticated principal is a headless SSH-managed device. */
  readonly isSshPrincipal: boolean;
  /** Warm-standby cluster topology management (excludes headless SSH principals). */
  readonly canManageStandby: boolean;
}

export function hasProxyForwardingHeaders(req: IncomingMessage): boolean {
  return UNTRUSTED_PROXY_HEADERS.some((header) => req.headers[header] !== undefined);
}

export function isLoopbackSocketAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isDirectLocalHttpRequest(req: IncomingMessage): boolean {
  return (
    !hasProxyForwardingHeaders(req) &&
    req.headers["sec-fetch-site"] !== "cross-site" &&
    isLoopbackSocketAddress(req.socket.remoteAddress)
  );
}

export function isSameOriginHttpRequest(
  req: IncomingMessage,
  requestOrigin: (req: IncomingMessage) => string,
): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (req.headers.origin && req.headers.origin !== requestOrigin(req)) return false;
  return true;
}

function matchHubAdminToken(token: string | undefined, expectedToken: string): boolean {
  if (!token || token.length > 8192) return false;
  const supplied = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function authenticateHttpPrincipal(
  req: IncomingMessage,
  parsedUrl: URL,
  hubAdminToken: string,
  devices: Pick<HubAuthorityDevices, "localNodeId" | "authenticateClient">,
): { principalId: string | undefined; authSource: "bearer" | "query" | undefined } {
  const headerToken = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const queryToken = parsedUrl.searchParams.get("token") ?? undefined;
  if (matchHubAdminToken(headerToken, hubAdminToken)) {
    return { principalId: devices.localNodeId, authSource: "bearer" };
  }
  if (matchHubAdminToken(queryToken, hubAdminToken)) {
    return { principalId: devices.localNodeId, authSource: "query" };
  }
  const bearerPeer = devices.authenticateClient(headerToken);
  if (bearerPeer) return { principalId: bearerPeer, authSource: "bearer" };
  const queryPeer = devices.authenticateClient(queryToken);
  if (queryPeer) return { principalId: queryPeer, authSource: "query" };
  return { principalId: undefined, authSource: undefined };
}

export function resolveHubRequestAuthority(input: {
  req: IncomingMessage;
  parsedUrl: URL;
  hubAdminToken: string;
  devices: HubAuthorityDevices;
  requestOrigin: (req: IncomingMessage) => string;
}): HubRequestAuthority {
  const { req, parsedUrl, hubAdminToken, devices, requestOrigin } = input;
  const { principalId, authSource } = authenticateHttpPrincipal(req, parsedUrl, hubAdminToken, devices);
  const proxied = hasProxyForwardingHeaders(req);
  const isSameOrigin = isSameOriginHttpRequest(req, requestOrigin);
  const isDirectLoopback = !proxied && isSameOrigin && isLoopbackSocketAddress(req.socket.remoteAddress);
  const isMutation = MUTATION_METHODS.has((req.method ?? "GET").toUpperCase());
  const credentialOkForControl = authSource === "bearer" || (!isMutation && authSource === "query");
  const isLocal = principalId !== undefined && devices.isLocalPrincipal(principalId);
  const isActivePaired =
    principalId !== undefined && !isLocal && devices.enabled && devices.isActivePairedPrincipal(principalId);
  const isHubLocalDisplay = isDirectLoopback && isLocal && credentialOkForControl;
  const isTrustedHubOwner = !proxied && isSameOrigin && isLocal && credentialOkForControl;
  const isTrustedPairedPeer = !proxied && isSameOrigin && isActivePaired && credentialOkForControl;
  const hasOwnerHubControl = isTrustedHubOwner || isTrustedPairedPeer;
  const isMobilePrincipal = principalId !== undefined && !isLocal && devices.isMobilePrincipal(principalId);
  const isSshPrincipal = principalId !== undefined && !isLocal && devices.isSshPrincipal(principalId);
  const canManageStandby = hasOwnerHubControl && !isSshPrincipal;
  return {
    principalId,
    authSource,
    isDirectLoopback,
    isSameOrigin,
    isHubLocalDisplay,
    isTrustedPairedPeer,
    hasOwnerHubControl,
    isMobilePrincipal,
    isSshPrincipal,
    canManageStandby,
  };
}
