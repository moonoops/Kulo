import type http from "node:http";
import type { ConnectionSaveRequest } from "@kulo/protocol";
import type { KuloConnections } from "./connections.js";
import {
  COMPOSIO_PRESET_ID,
  createComposioConnectLink,
  createComposioSession,
  disconnectComposioAccount,
  generateComposioUserId,
  isComposioSessionMissingError,
  listComposioAccounts,
  normalizeComposioAllowedToolkits,
} from "./composio-bridge.js";

export interface ComposioRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  connections: KuloConnections;
  assertSameOrigin: () => void;
  readJsonObject: (req: http.IncomingMessage, maxBytes?: number) => Promise<Record<string, unknown>>;
  sendJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
}

export async function handleComposioRoutes(ctx: ComposioRouteContext): Promise<boolean> {
  const { req, res, pathname, connections, assertSameOrigin, readJsonObject, sendJson } = ctx;
  const redact = (text: string) => connections.redact(text);
  const baseFetch = connections.mcpBaseFetch;

  if (pathname === "/api/connections/composio/connect-session" && req.method === "POST") {
    assertSameOrigin();
    const body = await readJsonObject(req, 64 * 1024);
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
    const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
    const suppliedKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
    if (suppliedKey) connections.rememberSecrets([suppliedKey]);

    let existingRecord: Awaited<ReturnType<KuloConnections["getComposioContext"]>>["record"] | undefined;
    let storedKey: string | undefined;
    if (id) {
      const existing = await connections.getComposioContext(id);
      if (expectedRevision !== existing.record.revision) {
        throw Object.assign(new Error("连接已被修改，请刷新后重试。"), { code: "connection_conflict", status: 409 });
      }
      existingRecord = existing.record;
      storedKey = existing.apiKey;
    }

    const effectiveKey = suppliedKey ?? storedKey;
    if (!effectiveKey) {
      throw Object.assign(new Error("请填写 Composio Project API Key（ak_…）。"), { code: "connection_credential_missing", status: 400 });
    }

    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : existingRecord?.name ?? "Composio";
    const allowedToolkits = body.allowedToolkits !== undefined
      ? normalizeComposioAllowedToolkits(body.allowedToolkits)
      : existingRecord?.mcpAllowedToolkits;
    const userId = existingRecord?.mcpComposioUserId ?? generateComposioUserId();

    const session = await createComposioSession(effectiveKey, {
      userId,
      allowedToolkits,
      baseFetch,
      redact,
    });

    const saveReq: ConnectionSaveRequest = {
      ...(id ? { id, expectedRevision } : {}),
      name,
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      mcpPresetId: COMPOSIO_PRESET_ID,
      url: session.mcpUrl,
      mcpAuthMode: "header",
      headerName: "x-api-key",
      mcpComposioUserId: session.userId,
      mcpComposioSessionId: session.sessionId,
      mcpAllowedToolkits: allowedToolkits ?? [],
      ...(suppliedKey ? { secrets: { apiKey: suppliedKey } } : {}),
    };

    const saved = await connections.saveComposioSession(saveReq);
    let latest = saved;
    try {
      const tested = await connections.test(saved.id);
      latest = tested.connection;
    } catch {
      // Keep saved record visible even if initial probe encounters a transient network error.
    }
    sendJson(res, id ? 200 : 201, { connection: latest });
    return true;
  }

  const accountsRoute = /^\/api\/connections\/([^/]+)\/composio\/accounts(?:\/([^/]+))?$/.exec(pathname);
  if (accountsRoute) {
    assertSameOrigin();
    const id = decodeURIComponent(accountsRoute[1]!);
    const accountId = accountsRoute[2] ? decodeURIComponent(accountsRoute[2]) : undefined;
    if (!accountId && req.method === "GET") {
      const { record, apiKey } = await connections.getComposioContext(id);
      const accounts = await listComposioAccounts(apiKey, record.mcpComposioUserId!, { baseFetch, redact });
      sendJson(res, 200, { accounts, allowedToolkits: record.mcpAllowedToolkits ?? [] });
      return true;
    }
    if (accountId && req.method === "DELETE") {
      const { record, apiKey } = await connections.getComposioContext(id);
      await disconnectComposioAccount(apiKey, record.mcpComposioUserId!, accountId, { baseFetch, redact });
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  const linkRoute = /^\/api\/connections\/([^/]+)\/composio\/link$/.exec(pathname);
  if (linkRoute && req.method === "POST") {
    assertSameOrigin();
    const id = decodeURIComponent(linkRoute[1]!);
    const body = await readJsonObject(req, 4 * 1024);
    const toolkit = typeof body.toolkit === "string" ? body.toolkit : "";
    const { record, apiKey, binding } = await connections.getComposioContext(id);
    let sessionId = record.mcpComposioSessionId!;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const redirectUrl = await createComposioConnectLink(apiKey, sessionId, toolkit, {
          allowedToolkits: record.mcpAllowedToolkits,
          baseFetch,
          redact,
        });
        sendJson(res, 200, { redirectUrl });
        return true;
      } catch (error) {
        if (attempt === 0 && isComposioSessionMissingError(error)) {
          const refreshed = await connections.refreshComposioSession(id, binding, undefined, sessionId);
          if (refreshed?.mcpComposioSessionId) {
            sessionId = refreshed.mcpComposioSessionId;
            continue;
          }
        }
        throw error;
      }
    }
    return true;
  }

  return false;
}
