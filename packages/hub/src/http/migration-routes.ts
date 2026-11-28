import type { MigrationImportRequest } from "@kulo/protocol";
import { MigrationError } from "../tools-migration.js";
import type { HubHttpRouteContext } from "./context.js";

const SCAN_ALLOWED_KEYS = new Set<string>([]);
const IMPORT_ALLOWED_KEYS = new Set<string>([
  "scanId",
  "commandId",
  "mcpCandidateIds",
  "skillCandidateIds",
  "skillAudiences",
  "stdioPrefillCandidateId",
]);

/**
 * Handles hub-local configuration discovery and credential-free snapshot import:
 * - `POST /api/migration/scan`
 * - `POST /api/migration/import`
 *
 * Strictly restricted to `ctx.authority.isHubLocalDisplay` (rejects paired remote peers,
 * paired mobile principals, SSH principals, proxied requests, and cross-site origins with 403).
 */
export async function handleMigrationRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, authority, readJsonObject, sendJson } = ctx;
  if (pathname !== "/api/migration/scan" && pathname !== "/api/migration/import") {
    return false;
  }

  res.setHeader("cache-control", "no-store");

  if (req.method !== "POST") {
    sendJson(res, 405, {
      error: "配置发现与导入接口仅支持 POST 请求。",
      code: "migration_method_not_allowed",
    });
    return true;
  }

  if (
    req.headers["sec-fetch-site"] === "cross-site" ||
    (req.headers.origin && req.headers.origin !== ctx.requestOrigin(req))
  ) {
    throw new MigrationError(403, "migration_origin_required", "请在 Kulo 中执行本机配置发现与导入。");
  }

  if (
    !authority.isHubLocalDisplay ||
    authority.isMobilePrincipal ||
    authority.isSshPrincipal ||
    !authority.principalId
  ) {
    throw new MigrationError(
      403,
      "migration_local_display_required",
      "本机配置发现与导入仅限 Hub 本机控制台使用，远端设备、手机与 SSH 客户端无权访问。",
    );
  }

  const caller = {
    principalId: authority.principalId,
    isHubLocalDisplay: authority.isHubLocalDisplay,
  };

  if (pathname === "/api/migration/scan") {
    const body = await readJsonObject(req, 16 * 1024);
    if (Object.keys(body).some((key) => !SCAN_ALLOWED_KEYS.has(key))) {
      throw new MigrationError(400, "migration_invalid_request", "扫描请求包含未定义参数。");
    }
    const result = await hub.migration.scan(caller);
    sendJson(res, 200, result);
    return true;
  }

  const body = await readJsonObject(req, 64 * 1024);
  if (Object.keys(body).some((key) => !IMPORT_ALLOWED_KEYS.has(key))) {
    throw new MigrationError(400, "migration_invalid_request", "导入请求包含未定义参数。");
  }
  const result = await hub.migration.importSelected(caller, body as unknown as MigrationImportRequest);
  sendJson(res, 200, result);
  return true;
}
