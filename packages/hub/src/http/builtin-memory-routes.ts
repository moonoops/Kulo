/**
 * HTTP routes for Built-in Memory (`GET /api/builtin-memory`, `POST /api/builtin-memory/enabled`,
 * `POST /api/builtin-memory/clear`).
 *
 * Security boundaries:
 * - Auth (401) and handover barrier (503) are enforced centrally in `server.ts` for all `/api/*`.
 * - Every response sets `cache-control: no-store`.
 * - Mutations require browser same-origin (`assertHttpSameOrigin`) and owner Hub control
 *   (`authority.hasOwnerHubControl && !authority.isSshPrincipal` -> 403).
 */
import { BuiltinMemoryError } from "../builtin-memory-doc.js";
import { assertHttpSameOrigin, type HubHttpRouteContext } from "./context.js";

function sendRouteError(ctx: HubHttpRouteContext, error: unknown): boolean {
  if (error instanceof BuiltinMemoryError) {
    ctx.sendJson(ctx.res, error.status, { error: error.message, code: error.code });
    return true;
  }
  if (error && typeof error === "object" && "status" in error && "code" in error) {
    const status = Number((error as { status: unknown }).status);
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : "请求被拒绝。";
    if (status >= 400 && status < 600) {
      ctx.sendJson(ctx.res, status, { error: message, code });
      return true;
    }
  }
  return false;
}

function assertBuiltinMemoryOwnerAuthority(ctx: HubHttpRouteContext): void {
  if (!ctx.authority.hasOwnerHubControl || ctx.authority.isSshPrincipal) {
    throw new BuiltinMemoryError(403, "builtin_memory_owner_required", "需要主脑管理权限才能访问内置记忆设置。");
  }
}

function assertBuiltinMemoryMutationAuthority(ctx: HubHttpRouteContext): void {
  assertHttpSameOrigin(ctx, {
    code: "builtin_memory_origin_required",
    message: "请在 Kulo 中修改内置记忆设置。",
  });
  assertBuiltinMemoryOwnerAuthority(ctx);
}

export async function handleBuiltinMemoryRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, readJsonObject, sendJson } = ctx;
  if (
    pathname !== "/api/builtin-memory" &&
    pathname !== "/api/builtin-memory/enabled" &&
    pathname !== "/api/builtin-memory/clear"
  ) {
    return false;
  }

  res.setHeader("cache-control", "no-store");

  try {
    if (req.method === "GET" && pathname === "/api/builtin-memory") {
      assertBuiltinMemoryOwnerAuthority(ctx);
      const state = await hub.memoryRuntime.builtinMemory.getStateView();
      sendJson(res, 200, state);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/builtin-memory/enabled") {
      assertBuiltinMemoryMutationAuthority(ctx);
      const body = await readJsonObject(req, 4096);
      if (Object.keys(body).some((k) => k !== "enabled" && k !== "expectedRevision")) {
        throw new BuiltinMemoryError(400, "invalid_builtin_memory_request", "内置记忆参数无效。");
      }
      if (typeof body.enabled !== "boolean" || typeof body.expectedRevision !== "number") {
        throw new BuiltinMemoryError(400, "invalid_builtin_memory_request", "内置记忆参数类型无效。");
      }
      const view = await hub.memoryRuntime.builtinMemory.setEnabled(body.enabled, body.expectedRevision);
      sendJson(res, 200, view);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/builtin-memory/clear") {
      assertBuiltinMemoryMutationAuthority(ctx);
      const body = await readJsonObject(req, 4096);
      if (Object.keys(body).some((k) => k !== "confirm" && k !== "expectedEpoch" && k !== "operationId")) {
        throw new BuiltinMemoryError(400, "invalid_builtin_memory_clear", "清空内置记忆参数无效。");
      }
      if (body.confirm !== true || typeof body.expectedEpoch !== "number" || typeof body.operationId !== "string") {
        throw new BuiltinMemoryError(400, "invalid_builtin_memory_clear", "清空内置记忆参数类型无效。");
      }
      const view = await hub.memoryRuntime.builtinMemory.clearAll({
        confirm: true,
        expectedEpoch: body.expectedEpoch,
        operationId: body.operationId,
      });
      sendJson(res, 200, view);
      return true;
    }

    sendJson(res, 405, { error: "Method not allowed", code: "method_not_allowed" });
    return true;
  } catch (error) {
    if (sendRouteError(ctx, error)) return true;
    throw error;
  }
}
