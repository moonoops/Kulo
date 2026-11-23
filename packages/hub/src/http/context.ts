import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import type { NativeAppPermissionKind } from "@kulo/protocol";
import type { KuloHub } from "../hub.js";
import type { HubRequestAuthority } from "./authority.js";

export interface HubHttpRouteContext {
  hub: KuloHub;
  req: IncomingMessage;
  res: ServerResponse;
  parsedUrl: URL;
  pathname: string;
  authority: HubRequestAuthority;
  readJsonObject: (req: IncomingMessage, maxBytes?: number) => Promise<Record<string, unknown>>;
  readJsonBody: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void;
  requestOrigin: (req: IncomingMessage) => string;
  currentDevice: (req: IncomingMessage, parsedUrl: URL) => string;
  hasLocalDeviceControl: (req: IncomingMessage, parsedUrl: URL) => boolean;
  hasOwnerHubControl: (req: IncomingMessage, parsedUrl: URL) => boolean;
  isHubSecret: (candidate: string) => boolean;
  openNativePermissionSettings: (kind: NativeAppPermissionKind) => Promise<void>;
  conversationQueryContext: <T>(
    req: IncomingMessage,
    res: ServerResponse,
    run: (context: Context) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Asserts that a browser-originated request is same-origin, preserving each route's
 * exact frontend-contract error code and message.
 */
export function assertHttpSameOrigin(
  ctx: Pick<HubHttpRouteContext, "req" | "requestOrigin">,
  error: { code: string; message: string },
): void {
  const { req, requestOrigin } = ctx;
  if (
    req.headers["sec-fetch-site"] === "cross-site" ||
    (req.headers.origin && req.headers.origin !== requestOrigin(req))
  ) {
    throw Object.assign(new Error(error.message), { status: 403, code: error.code });
  }
}
